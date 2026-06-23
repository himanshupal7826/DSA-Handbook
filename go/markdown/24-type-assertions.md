# 24 · Type Assertions

> **In one line:** A type assertion extracts the concrete dynamic value stored inside an interface, and the comma-ok form lets you do it without ever panicking.

---

## 1. Overview

A **type assertion** is the operation `x.(T)` where `x` is an interface value and `T` is a type. It answers a single question: *"Is the concrete value currently held by this interface actually a `T`, and if so, give it to me?"*

Go interfaces are dynamically typed boxes. An `io.Reader` might, at runtime, hold a `*os.File`, a `*bytes.Buffer`, or a `*gzip.Reader`. The static type system has forgotten which one — it only knows it satisfies `Reader`. A type assertion is how you recover that lost concrete type (or test for a *narrower* interface).

There are two forms, and the distinction is the heart of this chapter:

- **Single-value form**: `v := x.(T)` — panics if the assertion fails.
- **Comma-ok form**: `v, ok := x.(T)` — never panics; `ok` reports success.

> [!NOTE]
> A type assertion is **not** a type conversion. Conversions (`int(x)`, `[]byte(s)`) operate on statically known types and are checked at compile time. Assertions operate on the *dynamic* type inside an interface and are checked at *runtime*.

## 2. Why It Exists

Interfaces deliberately erase concrete type information to enable polymorphism. But real systems repeatedly need to *un-erase* it:

1. **Optional capability detection.** A value satisfies `io.Reader`, but does it *also* satisfy `io.WriterTo` or `io.Closer`? Standard library hot paths (`io.Copy`) ask exactly this to pick a faster path.
2. **Decoding `any`.** `encoding/json`, `database/sql`, and config loaders deliver values as `any` (`interface{}`). You must assert to do anything useful.
3. **Error inspection.** Before `errors.As`, error handling was a wall of type assertions on `error`. Under the hood `errors.As` *is* a type assertion in a loop.
4. **Generics escape hatch.** Even with Go generics, some APIs still receive `any` and must dispatch on dynamic type (e.g. a serializer's `switch`).

Without assertions, interfaces would be a one-way street: you could put a `*os.File` in, but never get the file-specific behaviour back out. The comma-ok form exists specifically so this recovery can be **safe** — you can probe a type and gracefully fall back rather than crash.

## 3. Internal Working

To understand assertions you must understand how an interface is laid out. A non-empty interface value is a **two-word pair** `(itab, data)`; an empty interface (`any`) is `(type, data)`.

```text
 interface value (16 bytes on 64-bit)
 ┌────────────────────────┬───────────────────────┐
 │   itab*  (or _type*)    │   data*  (pointer)    │
 └───────────┬────────────┴───────────┬───────────┘
             │                         │
             ▼                         ▼
   ┌──────────────────┐      ┌──────────────────────┐
   │ itab             │      │  heap value, e.g.     │
   │  ._type ───────────────▶│  *os.File struct      │
   │  .inter (Reader) │      └──────────────────────┘
   │  .hash (type id) │
   │  .fun[0..n] mtbl │   ← method dispatch table
   └──────────────────┘
```

- `_type` is the runtime descriptor for the **concrete** type (`*os.File`). It carries a `hash`, size, kind, and GC metadata.
- `itab` (interface table) is a cached pairing of *(interface type, concrete type)* plus the resolved method pointers. It is computed once and memoized in a global hash table (`runtime.itabTable`).

When you write `v, ok := x.(*os.File)`:

1. The compiler emits a call to a runtime helper (`runtime.assertE2T2` / `assertI2T2` family, varies by version) or, for interface-target asserts, `runtime.assertI2I2`.
2. The runtime compares the stored `_type` (or `itab._type`) against the target type's descriptor — effectively a **pointer comparison** of `_type` descriptors (with hash-based fast paths for interface targets).
3. On match: `data` is loaded into `v`, `ok = true`. On mismatch: `v` gets the **zero value** of `T`, `ok = false`.

For the **single-value** form (`v := x.(T)`), the same comparison runs, but on mismatch the runtime calls `panic` with a `*runtime.TypeAssertionError` instead of returning `false`.

> [!NOTE]
> Asserting to a **concrete** type is a near-constant-time `_type` pointer compare. Asserting to an **interface** type (`x.(io.Closer)`) may need to *build or look up an itab* to verify the concrete type implements the interface — pricier, but the itab is cached after first use.

A nil interface (`var x error = nil`) has a nil first word. Any assertion on it fails: comma-ok returns `(zero, false)`; single-value panics.

## 4. Syntax

```go
var i any = "hello"

// Comma-ok form — safe, idiomatic, never panics.
s, ok := i.(string) // s == "hello", ok == true
n, ok := i.(int)    // n == 0,        ok == false

// Single-value form — panics on mismatch.
s := i.(string) // ok
n := i.(int)    // panic: interface conversion: interface {} is string, not int

// Asserting to an interface type (capability check).
if c, ok := r.(io.Closer); ok {
	defer c.Close()
}

// Type switch — multi-way assertion (see §11).
switch v := i.(type) {
case string:
	_ = v // v is string here
case int:
	_ = v // v is int here
default:
	_ = v // v has the original interface type
}
```

The asserted-to type `T` must either be a concrete type that *could* be stored in `x`, or an interface type. If the compiler can prove `x`'s static type can never be `T`, it rejects the program at compile time ("impossible type assertion"). **Only interface values can be asserted** — you cannot assert on an `int` or a `struct`.

## 5. Common Interview Questions

**Q1. What is the difference between `v := x.(T)` and `v, ok := x.(T)`?**
The single-value form panics with a `*runtime.TypeAssertionError` if the dynamic type isn't `T`. The comma-ok form returns the zero value of `T` and `ok == false` instead of panicking. *Follow-up: when is panicking acceptable?* When the type is a guaranteed invariant you control (e.g. you just put a `*Foo` into a `sync.Map` and read it back) — a failed assert there is a programmer bug, so failing loud is correct.

**Q2. Is a type assertion the same as a type conversion?**
No. Conversion (`float64(i)`) is compile-time, works on concrete types, may change representation. Assertion (`i.(float64)`) is runtime, works only on interface values, and never changes the bits — it just unwraps them. *Follow-up: which is faster?* Conversions are usually free or a single CPU instruction; assertions involve a runtime type check.

**Q3. What happens if you assert on a nil interface?**
Comma-ok yields `(zero, false)`; single-value panics. *Follow-up: distinguish a nil interface from an interface holding a nil pointer.* `var e error = (*MyErr)(nil)` is **non-nil** (itab set, data nil). `e.(*MyErr)` succeeds and returns a nil `*MyErr` — a classic source of the "typed nil" bug.

**Q4. How does `errors.As` relate to type assertions?**
`errors.As` walks the wrapped-error chain (via `Unwrap`) and at each level performs the assignability check equivalent to a type assertion, setting the target if it matches. It generalises a manual `if e, ok := err.(*MyErr); ok` loop across wrapping. *Follow-up: why prefer `errors.As` over a bare assertion?* A bare assertion fails on wrapped errors (`fmt.Errorf("...: %w", err)`).

**Q5. Can you assert an interface to another interface?**
Yes: `x.(io.Closer)` checks whether the dynamic type implements `io.Closer`. *Follow-up: cost difference vs concrete assert?* Interface-target asserts may require itab construction/lookup; concrete asserts are a direct type-descriptor compare.

**Q6. In a type switch, what is the type of `v` in the `default` case?**
It keeps the original (interface) type of the switch expression — it is *not* narrowed. *Follow-up: what if two case types share a clause (`case A, B:`)?* `v` also keeps the original interface type in that combined clause.

**Q7. Will `x.(T)` compile if `T` cannot possibly be the dynamic type?**
If `T` is a concrete type that doesn't implement the static interface of `x`, it's a compile error ("impossible type assertion"). If `T` is an interface, it almost always compiles (a future concrete type could implement it). *Follow-up:* `var r io.Reader; r.(io.Writer)` compiles; `r.(int)` does not.

**Q8. Why does the comma-ok form exist at all if type switches exist?**
For a single targeted probe (one capability check) comma-ok is clearer and cheaper than a switch; type switches shine for multi-way dispatch. They compile to similar runtime checks.

## 6. Production Use Cases

- **`io.Copy` fast paths (Go stdlib).** It asserts `src.(io.WriterTo)` and `dst.(io.ReaderFrom)`; if present, it delegates to a zero-copy path (e.g. `sendfile(2)` for `*net.TCPConn` / `*os.File`). This single assertion can turn an O(n) buffer-shuffling copy into a kernel-level transfer.
- **`fmt` package.** Before formatting, `fmt` asserts each operand against `fmt.Stringer`, `error`, and `fmt.Formatter` to decide rendering.
- **`net/http`.** `http.ResponseWriter` is asserted to `http.Flusher`, `http.Hijacker`, and `http.Pusher` to expose optional capabilities (SSE flushing, WebSocket hijacking). gRPC-Gateway and most streaming handlers rely on this.
- **`database/sql`.** `Rows.Scan` receives `...any` and type-switches on `*int`, `*string`, `*time.Time`, `sql.Scanner`, etc. ORMs like GORM and sqlx are built on these assertions.
- **Kubernetes / `client-go`.** Informers deliver objects as `any` from the work queue; controllers assert to `*corev1.Pod`, `*appsv1.Deployment`, etc. The `runtime.Object` to concrete-kind path is assertion-heavy.
- **Encoding libraries.** `encoding/json` produces `map[string]any` / `[]any`; decoders assert to navigate. Protobuf's `Any` and `oneof` handling, and Kafka/Avro consumers, do the same.

## 7. Common Mistakes

> [!WARNING]
> The number one production crash from assertions is using the **single-value form on untrusted/dynamic input**, e.g. `cfg["port"].(int)` on a JSON-decoded map — JSON numbers decode to `float64`, so this panics in prod and works in your test.

- **Forgetting `ok` on dynamic data.** Always use comma-ok unless the type is your own invariant.
- **Typed-nil confusion.** `i.(*T)` succeeding with a nil pointer, then dereferencing it. Check the pointer, not just `ok`.
- **JSON number trap.** `v.(int)` on a decoded `any` — it's `float64`. Use `v.(float64)` or decode into a typed struct / `json.Number`.
- **Asserting then re-asserting.** Repeated `m["k"].(string)` in hot loops; assert once into a typed local.
- **Using assertions where a type switch is clearer**, producing an `if/else if` ladder that re-checks `ok` each time.
- **Bare assertion on wrapped errors** instead of `errors.As`.

## 8. Performance Considerations

A type assertion is cheap but not free. Rough mental model (modern amd64):

| Operation | Relative cost | Notes |
|---|---|---|
| Concrete-type assert (comma-ok) | ~1–3 ns | type-descriptor pointer compare |
| Interface-target assert (cached itab) | ~2–5 ns | hash lookup + compare |
| Interface-target assert (first time) | higher | itab construction, then cached forever |
| Single-value assert that **panics** | very expensive | panic/recover unwinds the stack |

Key insights:

- **Panics are the real cost.** A successful assert is nanoseconds; a *failing* single-value assert that triggers panic/recover can cost microseconds and disrupts inlining and the scheduler. Never use panic/recover as flow control around assertions.
- **The comma-ok and single-value successful paths are nearly identical** in cost — the difference is only on failure.
- **Boxing dominates.** Putting a value *into* an `any` may allocate (small integers/pointers are special-cased; larger structs heap-allocate). The assertion to get it back out does **not** allocate. Profile the boxing, not the unboxing.
- **Type switches** compile to a sequence of itab/type comparisons (or a hash jump for many cases); a long switch is roughly linear in matched-before cases — order hot cases first.

> [!TIP]
> If a hot path does the same assertion millions of times, hoist it: assert once to a concrete type and operate on that, rather than re-probing an `any` each iteration.

## 9. Best Practices

1. **Default to comma-ok.** Reserve single-value asserts for invariants you personally guarantee.
2. **Prefer `errors.As` / `errors.Is`** over manual error assertions — they handle wrapping.
3. **Use a type switch for multi-way dispatch**, comma-ok for a single probe.
4. **Name the capability interface narrowly.** Assert to the smallest interface you need (`io.Closer`, not `*os.File`) — it keeps code decoupled and testable.
5. **Document panics.** If a function uses a single-value assert, its doc comment should state the precondition.
6. **Guard typed-nil** after asserting to a pointer type.
7. **Avoid `any` at API boundaries** when generics or concrete types will do — every `any` forces a downstream assertion.

## 10. Code Examples

**Primary — safe capability detection (the `io.Copy` pattern).** This is the idiomatic production use: probe for a richer interface and fall back gracefully.

```go
package main

import (
	"fmt"
	"io"
	"os"
	"strings"
)

// drain copies r into dst. If r knows how to write itself out fast
// (io.WriterTo), use that path; otherwise fall back. Pure comma-ok,
// never panics.
func drain(r io.Reader, dst io.Writer) (int64, error) {
	if wt, ok := r.(io.WriterTo); ok {
		return wt.WriteTo(dst) // zero-copy / sendfile path when available
	}
	return io.Copy(dst, r)
}

func main() {
	// *strings.Reader implements io.WriterTo -> fast path.
	n, _ := drain(strings.NewReader("zariya"), os.Stdout)
	fmt.Printf("\nwrote %d bytes\n", n)
}
```

The alternative below shows the **same idea as a type switch** plus safe decoding of `any` and error inspection — useful when you have several possible concrete types.

```go
package main

import (
	"errors"
	"fmt"
)

type NotFound struct{ Key string }

func (e *NotFound) Error() string { return "not found: " + e.Key }

// describe decodes a JSON-style any value safely.
func describe(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case bool:
		return fmt.Sprintf("bool(%t)", x)
	case float64: // JSON numbers decode to float64 — the classic trap.
		return fmt.Sprintf("number(%g)", x)
	case string:
		return fmt.Sprintf("string(%q)", x)
	case []any:
		return fmt.Sprintf("array(len=%d)", len(x))
	case map[string]any:
		return fmt.Sprintf("object(keys=%d)", len(x))
	default:
		return fmt.Sprintf("unknown(%T)", x)
	}
}

func main() {
	fmt.Println(describe(42.0))
	fmt.Println(describe("hello"))

	// errors.As performs an assertion across the wrap chain.
	var nf *NotFound
	err := fmt.Errorf("layer: %w", &NotFound{Key: "user:7"})
	if errors.As(err, &nf) {
		fmt.Println("missing key:", nf.Key)
	}
}
```

> [!TIP]
> The two blocks above render as switchable tabs: the first is the "single probe" idiom, the second the "multi-way + error" idiom.

## 11. Advanced Concepts

**Type switches are sugar over assertions.** `switch v := x.(type)` performs one dynamic-type read and dispatches. Within each `case T:` clause `v` has type `T`; in a combined `case A, B:` clause and in `default`, `v` retains `x`'s original interface type. The compiler may turn a long switch into a binary search / hash on the type hash rather than a linear scan.

**Asserting to an interface builds itabs.** `x.(io.Closer)` asks the runtime: does `typeof(x)` implement `Closer`? The answer is an itab (or "fails"). The runtime memoizes both outcomes in `runtime.itabTable`, so the first such assert for a given (concrete, interface) pair is the expensive one.

**`reflect` is the reflective cousin.** When `T` isn't known at compile time, you can't write `x.(T)`. `reflect.TypeOf(x)` and `reflect.ValueOf(x)` do at runtime what assertions do statically — far slower, used by generic serializers and DI frameworks.

**Generics vs assertions.** Type parameters let you avoid `any` and thus avoid asserting at all when the type set is known at compile time. But generics can't dispatch on *runtime* type — if a function genuinely receives heterogeneous values, you still need a type switch. The modern rule: generics for static polymorphism, assertions/switches for dynamic.

**Typed nil, formally.** An interface is nil only when *both* words are nil. `var p *T = nil; var i any = p` gives `i` a non-nil itab and nil data, so `i == nil` is `false` and `i.(*T)` returns a nil pointer with `ok == true`. This is the single most reported Go gotcha and it lives at the intersection of interfaces and assertions.

## 12. Debugging Tips

- **Read the panic message.** `interface conversion: interface {} is float64, not int` tells you the *actual* dynamic type — fix the assert to match.
- **Print `%T`.** `fmt.Printf("%T\n", v)` reveals the concrete dynamic type before you assert. Indispensable for decoded JSON.
- **For typed-nil bugs**, print both the type and value: `fmt.Printf("%T %v\n", err, err == nil)`. If you see `*MyErr` but `err == nil` is false despite a "nil" value, you've hit typed nil.
- **`go vet`** flags impossible assertions and some misuse; run it in CI.
- **Wrap risky single-value asserts** behind a small comma-ok helper during debugging so failures log context instead of crashing.
- **Delve**: set a breakpoint and inspect the interface — Delve shows the dynamic type, confirming what the assertion will see.

## 13. Senior Engineer Notes

As a senior engineer your judgement is mostly *at the keyword `ok`*. In code review, treat every single-value assertion as a question: "Is this an invariant we own, or untrusted data?" The former is fine and even preferable (fail fast on a corrupted internal contract); the latter is a latent production panic.

Push back on `any`-typed function signatures in PRs — each one exports an assertion obligation to every caller. Often the right fix is a small interface or a generic, not a comma-ok at every call site.

Mentor juniors specifically on (a) the typed-nil trap, (b) the JSON `float64` trap, and (c) `errors.As` vs bare assertion. These three account for the bulk of assertion-related incidents I've seen. Encourage capability-probe patterns (`io.Closer`, `Flusher`) — they're the "correct" use and teach the comma-ok idiom in a meaningful context. Insist on `%T` logging in error paths that handle dynamic values.

## 14. Staff Engineer Notes

At staff level the concern shifts from *individual asserts* to *how much dynamic typing your architecture is forced into*. Heavy reliance on `any` + assertions is usually a smell that a boundary lost its type information too early: an event bus that ships `any` payloads, a config system that returns `map[string]any`, a plugin interface that's `func(any) any`. Each is a deliberate trade — flexibility now, runtime risk and lost compile-time guarantees later.

Frame build-vs-buy and design decisions around this:

- **Schemas at boundaries.** Prefer typed codecs (protobuf, Avro, code-gen) over hand-rolled `map[string]any` decoding. The assertion count is a proxy for schema debt.
- **Generics where the type set is closed.** Migrating an `any`-based internal API to generics removes whole classes of assertion panics and is often a high-leverage refactor.
- **Capability interfaces as extension points.** The stdlib's `io.WriterTo`/`http.Flusher` model — optional behaviour discovered via assertion — is an excellent cross-team contract: it lets implementations add fast paths without breaking the base interface. Standardise it.
- **Observability.** If your system asserts on dynamic payloads, instrument the `!ok` and `default:` branches with metrics; a rising "unknown type" counter is an early warning of an upstream schema change before it becomes an outage.

The org-level principle: assertions are how you *recover* lost type information; the staff goal is to *not lose it in the first place* unless the flexibility genuinely pays for itself.

## 15. Revision Summary

- A **type assertion** `x.(T)` extracts the concrete dynamic value from an interface; only interface values can be asserted.
- **Comma-ok** `v, ok := x.(T)` never panics (returns zero + false on miss); **single-value** `v := x.(T)` panics with `*runtime.TypeAssertionError`.
- Assertion ≠ conversion: assertion is runtime + interface-only; conversion is compile-time.
- Internally an interface is `(itab/_type, data)`; a concrete assert is a type-descriptor compare, an interface assert may build/cache an itab.
- Successful asserts are ~1–5 ns and don't allocate; *panics* are the expensive failure mode — never use them as flow control.
- Classic traps: typed nil, JSON numbers as `float64`, bare assertion on wrapped errors (use `errors.As`).
- Use comma-ok for single probes, **type switch** for multi-way dispatch; in `default`/combined cases the bound variable keeps the interface type.
- Production patterns: `io.Copy` capability probes, `http.Flusher`/`Hijacker`, `database/sql` scanning, `client-go` controllers.
- Senior: review single-value asserts as invariant-vs-untrusted; staff: minimise `any` at boundaries via schemas and generics.

**References:** The Go Programming Language Specification — "Type assertions" and "Type switches"; `runtime` source (`iface.go`, `TypeAssertionError`); stdlib `io`, `net/http`, `database/sql`, `errors` packages.

---

*Go Engineering Handbook — topic 24.*
