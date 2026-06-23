# 23 · Interfaces

> **In one line:** A Go interface is a two-word fat pointer that pairs a concrete type's method table with its data, satisfied implicitly by any type that has the right methods.

---

## 1. Overview

An interface in Go is a *contract expressed as a set of method signatures*. Any concrete type that implements those methods **automatically** satisfies the interface — there is no `implements` keyword, no explicit declaration, no inheritance tree. This is **implicit satisfaction**, and it is the single most important design decision in Go's type system.

At runtime an interface value is not magic: it is a small, fixed-size struct of two machine words — a pointer to type/method information and a pointer to the actual data. This is the `iface`/`eface` pair. Understanding that layout is what separates someone who *uses* interfaces from someone who can reason about nil-interface bugs, allocation costs, and dynamic dispatch.

The mental model: an interface answers *"what can this value do?"* rather than *"what is this value?"* — a form of compile-time-checked **duck typing**. If it has `Read([]byte) (int, error)`, it is an `io.Reader`, regardless of where or by whom it was defined.

```go
type Reader interface {
    Read(p []byte) (n int, err error)
}
```

---

## 2. Why It Exists

Interfaces exist to **decouple behavior from implementation**, enabling polymorphism without inheritance. Go's designers deliberately rejected the Java/C++ model where a class must declare upfront which interfaces it satisfies. That declaration creates tight coupling: the implementer must know about the interface in advance.

Go inverts this. Interfaces are satisfied implicitly, so:

- A type defined in package `A` can satisfy an interface defined later in package `B`, even though `A` has never heard of `B`. The standard library's `io.Reader` is satisfied by thousands of types whose authors never imported `io`.
- You can define **small interfaces at the point of consumption**, capturing exactly the behavior you need. This is the "accept interfaces, return structs" guideline (Section 9).
- Testing becomes trivial — any fake with the right methods is a drop-in substitute. No mocking framework or DI container required.

The philosophical root: *"The bigger the interface, the weaker the abstraction."* (Rob Pike). Go pushes you toward one- and two-method interfaces (`io.Reader`, `io.Writer`, `fmt.Stringer`, `sort.Interface`) that compose into rich behavior.

---

## 3. Internal Working

An interface value occupies **two words** (16 bytes on a 64-bit platform). Go has two runtime representations:

- **`eface`** — for the empty interface `any` (`interface{}`). It holds a `*_type` (type descriptor) and a `data` pointer.
- **`iface`** — for interfaces with methods. It holds a `*itab` (interface table) and a `data` pointer.

```text
  eface (any / interface{})            iface (interface with methods)
  +-------------------+                 +-------------------+
  | _type *_type      | --> type info  | tab   *itab       | --> itab
  +-------------------+                 +-------------------+
  | data  unsafe.Ptr  | --> value      | data  unsafe.Ptr  | --> value
  +-------------------+                 +-------------------+

  itab layout:
  +----------------------------------+
  | inter  *interfacetype  (the I)   |
  | _type  *_type          (concrete)|
  | hash   uint32          (for type switch)
  | fun[0] uintptr  -> method ptr    |  <-- the method table
  | fun[1] uintptr  -> method ptr    |
  |  ...                             |
  +----------------------------------+
```

The `itab` is the heart of dynamic dispatch. The `fun` array is a **virtual method table (vtable)**: each slot holds the address of a concrete method implementing the interface's i-th method. A call like `r.Read(buf)` compiles to: load `tab.fun[0]`, then call it with `data` as the receiver. That's two memory loads and an indirect call — cheap, but not free, and *not inlinable*.

**`itab` construction & caching.** The pairing of a concrete type with an interface type is computed lazily the first time it's needed and cached in a global hash table (`runtime.itabTable`). So the cost of "boxing" a `*os.File` into an `io.Reader` the first time involves a lookup/build; afterwards it is reused. For statically-known conversions the compiler can emit the `itab` at link time.

**The data pointer.** If the concrete value fits in a word and the compiler can prove it, older Go versions stored small values directly. Modern Go (since 1.4) **always stores a pointer** in `data`. This means storing a non-pointer value (e.g. an `int` or a large struct) into an interface frequently **allocates on the heap** so there is something to point at. This is the root of "interface boxing" allocation costs (Section 8).

**Nil semantics.** An interface is `nil` *only when both words are nil*. If you store a nil `*T` pointer into an interface, the `tab`/`_type` word is non-nil (it knows the type is `*T`), so the interface is **not nil** — the infamous nil-interface trap (Section 7).

---

## 4. Syntax

```go
// Declaring an interface
type Stringer interface {
    String() string
}

// Implicit satisfaction — no "implements" keyword.
type Point struct{ X, Y int }

func (p Point) String() string {
    return fmt.Sprintf("(%d,%d)", p.X, p.Y)
}

// Point now satisfies Stringer automatically.
var s Stringer = Point{1, 2}

// Empty interface holds any value (Go 1.18+: prefer the `any` alias).
var x any = 42

// Type assertion: extract the concrete type.
p, ok := s.(Point)        // comma-ok form, never panics
fmt.Println(p, ok)        // (1,2) true

// Type switch: branch on dynamic type.
switch v := x.(type) {
case int:
    fmt.Println("int", v)
case string:
    fmt.Println("string", v)
default:
    fmt.Printf("unknown %T\n", v)
}

// Interface embedding (composition).
type ReadWriter interface {
    io.Reader
    io.Writer
}
```

---

## 5. Common Interview Questions

**Q1. When is an interface value nil?**
*Only when both the type word and the data word are nil.* A typed nil pointer stored in an interface is non-nil.
*Follow-up: why does `func f() error { var e *MyErr; return e }` return a non-nil error?* Because returning `e` boxes a `*MyErr` type into the `error` interface; the type word is set, so `err != nil` is true even though the pointer inside is nil.

**Q2. How does Go decide whether a type satisfies an interface?**
At compile time the compiler checks the method set; at runtime, conversions build an `itab` matching the concrete type's methods to the interface's. There's no registration.
*Follow-up: does a `*T` have the same method set as `T`?* No. The method set of `*T` includes methods with both value *and* pointer receivers; `T`'s method set includes only value-receiver methods. So pointer-receiver methods make only `*T` satisfy the interface.

**Q3. What's the difference between `iface` and `eface`?**
`eface` (empty interface) carries `*_type` + data; `iface` (method interface) carries `*itab` + data. The `itab` adds the method table needed for dispatch.
*Follow-up: which is cheaper to construct?* `eface` — it only needs the type descriptor, no `itab` lookup/build.

**Q4. What's the cost of a method call through an interface vs a direct call?**
The interface call is an indirect call via the vtable (`tab.fun[i]`) and **cannot be inlined**, defeating inlining-driven optimizations. Direct/concrete calls can be inlined.
*Follow-up: how would you measure it?* Benchmark both with `testing.B`, run `go test -bench`, and check `-gcflags=-m` for inlining decisions and escape analysis.

**Q5. Why "accept interfaces, return structs"?**
Accepting an interface lets callers pass any implementation (flexibility, testability). Returning a concrete struct gives callers the full API and avoids leaking an over-narrow abstraction.
*Follow-up: when is returning an interface justified?* When you must hide implementation (e.g. `error`, `io.Reader` from `gzip.NewReader`) or return one of several concrete types.

**Q6. What does an empty interface (`any`) cost?**
Storing a non-pointer into `any` usually heap-allocates (boxing). You also lose static typing and need assertions/reflection to recover the value.
*Follow-up: how did generics (1.18) change this?* Generics let you write polymorphic code with **no boxing** and full type safety, replacing many `interface{}` uses.

**Q7. Can you call a method on a nil interface?**
No — it panics with `nil pointer dereference` / `invalid memory address` because there's no `itab` to dispatch through. But you *can* call a method on a non-nil interface wrapping a nil pointer, if the method handles a nil receiver.
*Follow-up: give a safe nil-receiver example.* A linked-list `Len()` that returns 0 when the receiver is nil.

**Q8. How does a type switch work internally?**
It compares the `itab.hash` / `_type` against each case's type; the comma-ok extraction reuses the same machinery as a type assertion.
*Follow-up: is a type switch O(n) in cases?* Effectively yes for small n (linear checks), though the compiler may use a hash jump for many cases.

---

## 6. Production Use Cases

- **`io.Reader` / `io.Writer` everywhere.** The entire Go I/O ecosystem — `net/http` bodies, `os.File`, `bytes.Buffer`, `gzip`, `bufio`, `crypto/cipher` streams — composes through these two interfaces. HTTP handlers write to an `http.ResponseWriter` interface.
- **`database/sql`.** The `driver.Driver`/`driver.Conn` interfaces let one stdlib package drive Postgres (`pgx`/`lib/pq`), MySQL (`go-sql-driver`), SQLite, etc., with zero coupling.
- **Kubernetes.** Heavily interface-driven: `runtime.Object`, `client.Client`, and the `Reconciler` interface in controller-runtime. Cloud-provider plugins satisfy `cloudprovider.Interface`.
- **gRPC & middleware.** `grpc.UnaryServerInterceptor`, and HTTP middleware as `func(http.Handler) http.Handler`, both lean on the `http.Handler` interface for composability (chi, gorilla, gin).
- **Plugin / strategy patterns at scale.** Hashicorp tools (Terraform providers, Vault secret engines) define interfaces that third parties implement out-of-tree.
- **Observability.** OpenTelemetry's `trace.Tracer`, `metric.Meter`, and the `slog.Handler` interface (Go 1.21) let you swap backends without touching call sites.
- **`sort.Interface`** — the canonical three-method interface (`Len`, `Less`, `Swap`) enabling generic sorting before generics existed.

---

## 7. Common Mistakes

> [!WARNING]
> **The nil-interface trap.** Returning a typed nil pointer as an `error` produces a non-nil interface. Always return a literal `nil` for the no-error case, and never declare `var err *MyError` and return it directly.

```go
// BUG: caller sees err != nil even on success
func do() error {
    var e *MyError // typed nil
    if somethingFailed {
        e = &MyError{...}
    }
    return e // boxes *MyError -> error is non-nil even when e == nil
}
```

- **Pointer vs value receiver confusion.** Defining a method on `*T` and then trying `var i Iface = T{}` fails to compile because `T`'s method set lacks pointer-receiver methods.
- **Over-large interfaces.** A 12-method interface forces every fake to implement all 12 and signals a leaky abstraction. Split it.
- **Returning interfaces from constructors needlessly.** `func New() MyInterface` hides the concrete type and prevents callers from using extra methods; prefer returning the struct.
- **`interface{}`/`any` as a lazy generic.** Pre-1.18 this was unavoidable; today it usually means you should use a type parameter.
- **Assuming method dispatch is free** in hot loops (see Section 8).
- **Comparing interfaces holding uncomparable types** (slices, maps, funcs) — `==` panics at runtime.

---

## 8. Performance Considerations

| Concern | Cost | Mitigation |
|---|---|---|
| Boxing a non-pointer into an interface | Heap allocation + GC pressure | Store pointers, or use generics |
| Dynamic dispatch | Indirect call, **no inlining** | Keep hot paths concrete; use generics for monomorphization |
| `itab` first-use | One-time lookup/build | Negligible after caching |
| Type assertion / switch | A few comparisons | Cheap; comma-ok avoids panic cost |
| Interface in tight loop | Pointer chasing + cache misses | Hoist out of loop; batch |

A direct method call is ~1ns and inlinable; an interface call is a couple of nanoseconds and a hard inlining barrier. In a loop running millions of times, that barrier — by blocking constant propagation and bounds-check elimination across the call — often matters more than the raw indirection.

> [!TIP]
> Run `go build -gcflags='-m'` to see escape analysis. Lines like `x escapes to heap` next to an interface conversion confirm boxing allocations. Confirm with `go test -bench . -benchmem` and watch `allocs/op`.

Generics (1.18+) generate specialized code (via GC-shape stenciling) and avoid boxing, so prefer `[T any]` over `interface{}` for performance-sensitive containers.

---

## 9. Best Practices

- **Accept interfaces, return structs.** Take the narrowest interface a function actually needs; hand back concrete types.
- **Define interfaces in the consumer package, not the producer.** The package that *uses* `Storer` should declare it, sized to its needs.
- **Keep interfaces small.** One or two methods is ideal. Compose via embedding.
- **Name single-method interfaces with the `-er` suffix** (`Reader`, `Closer`, `Stringer`).
- **Use `any` (not `interface{}`)** in modern code — it's the same type, clearer intent.
- **Verify satisfaction at compile time** with `var _ Iface = (*T)(nil)` to catch breakage early.
- **Prefer generics over `any`** when you need type-safe polymorphism without dispatch.
- **Document nil-receiver behavior** if a method tolerates a nil receiver.

```go
// Compile-time satisfaction assertion (zero runtime cost).
var _ io.ReadWriteCloser = (*MyConn)(nil)
```

---

## 10. Code Examples

A small, consumer-defined interface makes code testable and decoupled. Here a notifier depends only on the behavior it needs.

```go
package billing

import "context"

// Defined where it's consumed, sized to exactly one method.
type Charger interface {
    Charge(ctx context.Context, cents int64) error
}

type Service struct{ c Charger }

func New(c Charger) *Service { return &Service{c: c} } // accept interface

func (s *Service) BillMonthly(ctx context.Context) error {
    return s.c.Charge(ctx, 999)
}
```

In tests you substitute a fake with no framework — implicit satisfaction does all the work.

```go
package billing

import (
    "context"
    "testing"
)

type fakeCharger struct{ got int64 }

func (f *fakeCharger) Charge(_ context.Context, cents int64) error {
    f.got = cents
    return nil
}

func TestBillMonthly(t *testing.T) {
    f := &fakeCharger{}
    if err := New(f).BillMonthly(context.Background()); err != nil {
        t.Fatal(err)
    }
    if f.got != 999 {
        t.Fatalf("charged %d, want 999", f.got)
    }
}
```

Type switches let one function handle several dynamic types — the classic `eface` consumer pattern used by encoders like `encoding/json`.

```go
func describe(v any) string {
    switch x := v.(type) {
    case nil:
        return "nil"
    case int, int64:
        return fmt.Sprintf("integer %v", x)
    case string:
        return "string " + strconv.Quote(x)
    case fmt.Stringer: // interface case: matches anything with String()
        return "stringer " + x.String()
    default:
        return fmt.Sprintf("%T", x)
    }
}
```

---

## 11. Advanced Concepts

- **Type sets & generic constraints (Go 1.18+).** Interfaces gained a second role: as **constraints** they can list permitted underlying types via union elements (`~int | ~string`). The `~` means "any type whose underlying type is this." So an interface is now either a *method set* (runtime, dynamic) or a *type set* (compile-time, for generics).

```go
type Ordered interface {
    ~int | ~int64 | ~float64 | ~string
}

func Max[T Ordered](a, b T) T {
    if a > b {
        return a
    }
    return b
}
```

- **Interface upgrades / optional interfaces.** Idiomatic Go probes for *extra* capabilities at runtime: `net/http` checks `if f, ok := w.(http.Flusher); ok { f.Flush() }`. `io.Copy` checks for `WriterTo`/`ReaderFrom` to take a fast path. This is feature detection via type assertion.

- **`itab` and reflection.** `reflect.Type`/`reflect.Value` are built on the same `_type`/`itab` descriptors. `reflect.TypeOf(x)` reads the `eface`'s `_type` word.

- **Method values & method expressions.** `p.String` (bound) vs `Point.String` (unbound) — the latter takes the receiver as an explicit first arg, useful for higher-order code.

- **Empty struct + interface for sets/signals.** `map[string]struct{}` and `chan struct{}` interplay with interface-based registries.

---

## 12. Debugging Tips

- **Diagnose nil-interface bugs** by printing `fmt.Printf("%T %v\n", err, err)`. If you see `*pkg.MyError <nil>` instead of `<nil> <nil>`, you've boxed a typed nil.
- **Inspect dynamic type** at runtime with `%T`, or `reflect.TypeOf(v)`.
- **In Delve:** `print iface` shows both the type and data words; `whatis` reveals the static interface type. Setting a breakpoint and examining the `tab` confirms which concrete method will dispatch.
- **Confirm allocations** from boxing with `go test -bench . -benchmem` and `go build -gcflags='-m'`.
- **Compile-time assertions** (`var _ I = (*T)(nil)`) turn "forgot a method" runtime surprises into build errors.
- **`go vet`** catches some interface mistakes (e.g. impossible type assertions).
- When `==` on interfaces panics, the dynamic type is uncomparable (slice/map/func) — log `%T` to find the culprit.

---

## 13. Senior Engineer Notes

A senior engineer treats interfaces as a **code-review and design discipline**, not a feature:

- **Reject premature interfaces.** "One implementation, one interface" is a smell. Introduce the interface when the *second* implementation (often a test fake) actually appears, and define it in the consumer.
- **Police receiver consistency.** Mixed value/pointer receivers on a type are a recurring bug source; in review, flag any type that mixes them and confirm intended method sets.
- **Watch for nil-interface footguns** in any function returning `error` from a typed pointer — it's one of the top three Go bugs juniors ship.
- **Keep interfaces narrow in PRs.** If a new method is added to a widely-implemented interface, that's a fan-out change touching every implementer and fake — push back or stage it.
- **Mentor on "accept interfaces, return structs"** with concrete diffs, not slogans. Show how returning a struct future-proofs the API.
- **Prefer generics for typed containers/algorithms**; reserve interfaces for genuine runtime polymorphism and capability detection.

---

## 14. Staff Engineer Notes

A staff engineer reasons about interfaces at the **architecture and org boundary** level:

- **Interfaces as API contracts across teams.** A published interface is a versioning commitment: adding a method is a breaking change for every external implementer. Design extension points (optional interfaces, context-carried capabilities) so you can evolve without coordinated multi-team releases. Hashicorp's plugin SDKs and Kubernetes' `CloudProvider` are case studies in how hard this is to get right.
- **Build-vs-buy via interfaces.** Defining a thin internal interface (`BlobStore`, `MessageBus`) over a vendor SDK is the cheapest insurance against lock-in — it localizes the migration surface when you swap S3 for GCS or Kafka for Pulsar. Quantify: the interface costs a day; an un-abstracted migration can cost quarters.
- **Dispatch cost at fleet scale.** In a service handling millions of RPS, an interface in the per-request hot path that blocks inlining can show up as measurable CPU; the org-level trade-off is *abstraction flexibility vs. compute spend*. Decide deliberately and benchmark.
- **Standardize the seams.** Drive org-wide adoption of stdlib interfaces (`slog.Handler`, `io.Reader`, OTel) so components compose across teams without bespoke glue. The win is ecosystem leverage, not local elegance.
- **Govern the empty-interface blast radius.** `any` at API boundaries erases type safety org-wide; steer platform APIs toward generics or concrete DTOs and reserve `any` for true serialization edges.

---

## 15. Revision Summary

- An interface is **two words**: type/itab pointer + data pointer (`eface` for `any`, `iface` for method interfaces).
- **Implicit satisfaction** — no `implements`; having the methods *is* satisfying the interface (compile-time-checked duck typing).
- `itab.fun[]` is a **vtable**; calls dispatch indirectly and **cannot inline**; itabs are cached after first use.
- An interface is **nil only when both words are nil** — a typed nil pointer makes it non-nil (the classic error bug).
- **Method sets:** `*T` includes pointer- and value-receiver methods; `T` includes only value-receiver methods.
- Storing non-pointers into interfaces **boxes (heap-allocates)**; prefer pointers or **generics**.
- Idioms: **accept interfaces, return structs**; keep interfaces small; define them in the consumer; use `var _ I = (*T)(nil)`.
- Since 1.18 interfaces also define **type sets** (`~int | ...`) as generic constraints.
- Runtime patterns: **type switch**, **optional/upgrade interfaces** (`http.Flusher`, `io.WriterTo`).

**References:** Effective Go: Interfaces; Go spec (Interface types, Method sets); `runtime/iface.go`; Rob Pike, "Go Proverbs."

---
*Go Engineering Handbook — topic 23.*
