# 17 · Pointers

> **In one line:** A pointer holds the memory address of a value, letting you read and mutate that value indirectly using `&` to take an address and `*` to dereference — with `nil` as the zero value and no pointer arithmetic allowed.

---

## 1. Overview

A **pointer** is a value whose contents are the *address* of another value in memory. Instead of copying data around, you pass a small fixed-size handle (8 bytes on 64-bit platforms) that points at the original. The two operators that define the whole feature are `&` (address-of) and `*` (dereference). The zero value of any pointer is `nil`.

Go deliberately keeps pointers *boring and safe*. There is no pointer arithmetic (`p++` on a pointer is a compile error), no casting an `int` into a `*T` without `unsafe`, and the garbage collector guarantees a pointer never dangles — as long as a pointer to an object is reachable, that object stays alive. This gives you the sharing-and-mutation power of C pointers without the segfaults and use-after-free bugs.

In production Go, pointers show up everywhere: receiver types that mutate state, optional fields in API structs (`*string` to distinguish "absent" from "empty"), avoiding large struct copies, and building linked data structures (trees, lists, graphs).

> [!NOTE]
> Reference: *A Tour of Go — "Pointers"* (`tour.golang.org/moretypes/1`).

## 2. Why It Exists

Three concrete problems pointers solve:

1. **Mutation across function boundaries.** Go is strictly *pass-by-value*. When you pass a struct to a function, the callee gets a copy. To let a function modify the caller's value, you pass a pointer to it.

2. **Avoiding expensive copies.** Passing a 4 KB struct by value copies 4 KB on every call. Passing `*BigStruct` copies 8 bytes. For hot paths this matters.

3. **Expressing "no value" / optionality.** A `*int` can be `nil`, meaning "not set". A plain `int` is always `0`, which is ambiguous — is `0` a real value or a default? Pointers (or `sql.NullInt64`) disambiguate.

```go
func double(n int)   { n *= 2 } // mutates a copy; caller unaffected
func doublep(n *int) { *n *= 2 } // mutates caller's value

x := 5
double(x)   // x still 5
doublep(&x) // x now 10
```

Without pointers you'd need to return new values everywhere and reassign — workable for small data, painful for graphs, trees, and shared mutable state.

## 3. Internal Working

A pointer is just an unsigned integer-sized machine word holding a virtual memory address. On `amd64`/`arm64` it is 8 bytes; on 32-bit targets, 4 bytes. The compiler tracks the *pointed-to type* statically so it knows how many bytes to read on a dereference and how the GC should scan it.

```text
  Stack frame (or heap)             Heap (or stack)
 ┌──────────────────────┐         ┌──────────────────┐
 │ p  *User             │         │ User{            │  addr 0xc0000140a0
 │   value: 0xc0000140a0 ───────► │   ID:   42       │
 └──────────────────────┘         │   Name:"Ada"     │
        8 bytes                    └──────────────────┘
                                     sizeof(User) bytes
```

Key runtime facts:

- **Escape analysis decides stack vs heap.** The compiler analyzes whether a pointed-to value *escapes* its function. If `&x` is returned or stored somewhere outliving the frame, `x` is allocated on the heap; otherwise it stays on the stack even though you took its address. Run `go build -gcflags='-m'` to see decisions like `moved to heap: x`.

- **The GC is precise and pointer-aware.** Each type has a *bitmap* telling the collector which words contain pointers. During the mark phase the GC follows live pointers; nothing is freed while reachable. This is why Go has no dangling pointers.

- **`nil` is the address `0`.** Dereferencing it triggers a hardware fault that the runtime turns into a recoverable `panic: runtime error: invalid memory address or nil pointer dereference` (signal `SIGSEGV`).

- **No arithmetic.** The spec forbids `+`/`-` on pointers and forbids `int↔pointer` conversions outside `unsafe.Pointer`. This keeps the type system sound and the GC able to interpret memory.

- **Stack growth moves pointers.** Goroutine stacks grow by copying to a bigger region; the runtime *rewrites* all pointers into the stack so they stay valid. Another reason raw arithmetic is banned — addresses are not stable across stack copies.

## 4. Syntax

```go
var p *int // declare: p is *int, currently nil

x := 10
p = &x          // & : address-of, p now points at x
fmt.Println(*p) // * : dereference → 10
*p = 20         // write through the pointer; x is now 20

// new() allocates a zeroed T and returns *T
q := new(int) // q -> 0
*q = 7

// Pointer to a struct; Go auto-dereferences field access
type Point struct{ X, Y int }
pt := &Point{X: 1, Y: 2}
fmt.Println(pt.X) // sugar for (*pt).X
pt.Y = 9          // sugar for (*pt).Y = 9

if p == nil { /* ... */ } // nil check

pp := &p          // **int (pointer to pointer)
fmt.Println(**pp)
```

> [!WARNING]
> `*` is overloaded: in a *type* (`*int`) it means "pointer to"; in an *expression* (`*p`) it means "dereference". Same glyph, opposite directions.

## 5. Common Interview Questions

**Q1. What is the difference between passing by value and passing a pointer in Go?**
By value copies the entire value; mutations don't reach the caller. A pointer copies only the address, so the callee can mutate the original.
*Follow-up: Is a slice passed by value or by reference?* By value — but the value is a 3-word header (`ptr,len,cap`) pointing at a shared backing array, so element writes are visible to the caller while `append` may not be.

**Q2. What is the zero value of a pointer, and what happens if you dereference it?**
`nil`. Dereferencing panics with `invalid memory address or nil pointer dereference`.
*Follow-up: Can you call a method on a nil pointer?* Yes, if the method has a pointer receiver and never dereferences the receiver (e.g. a `String()` that checks `if t == nil`). This is a common idiom in tree code.

**Q3. Does Go have pointer arithmetic?**
No. You cannot do `p++` or `p + 1`. The only escape hatch is the `unsafe` package, which is discouraged outside low-level libraries.
*Follow-up: How do C libraries doing arithmetic interop?* Via `unsafe.Pointer` and `unsafe.Add` (Go 1.17+), typically in cgo wrappers or serialization libs.

**Q4. When should a method use a pointer receiver vs a value receiver?**
Pointer receiver when the method mutates the receiver, when the struct is large (avoid copies), or to keep the method set consistent. Value receiver for small immutable types.
*Follow-up: Can you mix both on one type?* You can, but it's discouraged — `go vet` warns, and the method-set rules around interfaces become confusing.

**Q5. Explain escape analysis.**
The compiler decides at compile time whether a value can live on the stack or must move to the heap because a pointer to it outlives the function. Stack allocation is free to reclaim; heap allocation costs GC work.
*Follow-up: Does taking `&x` always heap-allocate?* No — if the pointer doesn't escape, `x` stays on the stack.

**Q6. What does `new(T)` return vs `&T{}`?**
Both return `*T` pointing at a zeroed `T`. `&T{...}` lets you set fields inline; `new(T)` is just zeroed. They're equivalent for the empty case.
*Follow-up: Which is idiomatic?* `&T{}` for structs; `new` is mostly used for basic types or when you have no literal.

**Q7. Why might two `*int` pointers compare equal?**
If they hold the same address. Pointer equality (`==`) compares addresses, not pointed-to values.
*Follow-up: Do all `nil` pointers compare equal?* Yes, regardless of type — but a `nil *T` stored in an interface is *not* equal to a `nil` interface (the classic typed-nil bug).

## 6. Production Use Cases

- **Mutating receivers in stdlib & infra.** `bytes.Buffer`, `strings.Builder`, `sync.Mutex` all use pointer receivers because methods mutate internal state. Copying a `sync.Mutex` by value is a famous bug class (`go vet` flags it).
- **Optional JSON/protobuf fields.** Kubernetes API types use `*bool`, `*int32`, `*string` pervasively (see `k8s.io/api/core/v1`) to distinguish "field omitted" from "field set to zero". Protobuf-generated Go (`google.golang.org/protobuf`) uses pointers for `optional` scalars.
- **Database null handling.** `database/sql` scans nullable columns into `*string`/`sql.NullString`; ORMs like GORM use pointer fields for nullable + "don't update on zero".
- **Linked data structures.** `container/list`, `container/heap`, and every B-tree/LSM implementation (BadgerDB, bbolt) lean on pointers for nodes and children.
- **Avoiding copies in hot paths.** High-throughput services (e.g. CockroachDB, the Prometheus TSDB) pass large structs and request contexts by pointer to keep allocations and copy costs down.
- **The `*http.Request` chain** — the request is always `*http.Request` so middleware can attach context values and the body reader is shared.

## 7. Common Mistakes

> [!WARNING]
> **Capturing a loop variable's address.** Before Go 1.22, `for _, v := range xs { ps = append(ps, &v) }` made every pointer point at the *same* reused `v`. Go 1.22 fixed loop-variable scoping so each iteration gets a fresh variable — but you still hit this with manual index reuse or older toolchains.

- **Typed nil in interfaces.** Returning a `nil *MyError` as an `error` makes `err != nil` true even though the underlying pointer is nil. Return a literal `nil` error instead.
- **Nil map/slice via pointer confusion.** A `nil` map can be *read* but panics on write; a `nil` pointer to a struct panics on field access. Different failure modes.
- **Copying a struct containing a `sync.Mutex` or `sync.WaitGroup`.** Use a pointer to the struct, never copy it.
- **Returning a pointer to a loop-local large array** thinking it avoids a copy — escape analysis may heap-allocate it anyway.
- **Over-using pointers for small values.** `*int` for a simple counter just adds indirection, a nil hazard, and GC pressure.

## 8. Performance Considerations

| Aspect | Value | Pointer |
|---|---|---|
| Copy cost | `O(sizeof(T))` | 8 bytes |
| Indirection on access | none | one load |
| GC scan cost | only if T has pointers | adds a pointer to scan |
| Allocation | often stack | may escape to heap |
| Cache locality | excellent (inline) | worse (chase pointer) |

Rules of thumb:

- For structs larger than ~3–4 machine words (≈ 32 bytes), pointer passing usually wins. Below that, value passing is often *faster* because it avoids heap escapes and keeps data cache-resident.
- **Pointers create GC work.** Every pointer field is a node the collector must follow. A slice of `*T` is harder on the GC than a slice of `T`. Data-oriented designs (struct-of-arrays, slices of values) reduce GC pressure dramatically — a known optimization in Go game engines and databases.
- Benchmark with `go test -bench . -benchmem` and inspect escapes with `-gcflags=-m`. Don't guess.

> [!TIP]
> "Pointers avoid copies" is only half the story — they trade copy cost for indirection, possible heap allocation, and GC scanning. Measure.

## 9. Best Practices

- Use a **pointer receiver** if any method mutates the receiver or the struct is large; be consistent across the whole method set.
- Prefer returning `*T` from constructors (`func NewServer() *Server`) so callers share one instance.
- Use `*T` fields for **genuinely optional** scalars in API types; otherwise prefer plain values + a `bool` "set" flag or zero-value semantics.
- Always guard before dereferencing data from external sources: `if p != nil`.
- Don't return pointers to internal mutable state you want to protect — return copies or expose getters.
- Avoid `**T` (pointer-to-pointer) unless you genuinely need to rebind the caller's pointer; it's a readability smell.
- Reach for `unsafe` only in performance-critical, well-reviewed library code, and isolate it.

## 10. Code Examples

Primary idiomatic example — a linked list and a nil-safe method:

```go
package main

import "fmt"

type Node struct {
	Val  int
	Next *Node
}

// Sum is nil-safe: calling on a nil *Node returns 0.
func (n *Node) Sum() int {
	if n == nil {
		return 0
	}
	return n.Val + n.Next.Sum()
}

func push(head *Node, v int) *Node {
	return &Node{Val: v, Next: head} // returns new head pointer
}

func main() {
	var head *Node // nil — empty list
	head = push(head, 3)
	head = push(head, 2)
	head = push(head, 1)
	fmt.Println(head.Sum())         // 6
	fmt.Println((*Node)(nil).Sum()) // 0, no panic
}
```

Alternative — mutating through a pointer receiver vs returning a value:

```go
package main

import "fmt"

type Counter struct{ n int }

// Pointer receiver mutates in place.
func (c *Counter) Inc() { c.n++ }

// Functional style: return a new value, no shared state.
func incVal(c Counter) Counter { c.n++; return c }

func main() {
	c := Counter{}
	c.Inc()       // c.n == 1 (mutated)
	c.Inc()       // c.n == 2
	c = incVal(c) // c.n == 3 (reassigned copy)
	fmt.Println(c.n)
}
```

Demonstrating the typed-nil trap that bites everyone once:

```go
package main

import "fmt"

type MyErr struct{ msg string }

func (e *MyErr) Error() string { return e.msg }

// BUG: returns a typed nil that is != nil as an interface.
func doBad() error {
	var e *MyErr // nil
	return e     // wrapped in a non-nil interface!
}

func main() {
	if err := doBad(); err != nil {
		fmt.Println("surprise: err != nil even though *MyErr is nil")
	}
}
```

## 11. Advanced Concepts

- **`unsafe.Pointer` and the `unsafe.Add`/`unsafe.Slice` helpers (Go 1.17+)** are the only sanctioned way to do address arithmetic. They power zero-copy conversions (`[]byte`↔`string`), struct field-offset tricks, and cgo interop. Misuse breaks GC assumptions and corrupts memory.
- **Escape analysis nuances:** interface boxing forces escapes (`fmt.Println(x)` causes `x` to escape because `any` is a pointer-carrying box). Closures that capture `&x` escape. Slices grown beyond a compile-time-known size escape.
- **Pointer bitmaps & GC metadata:** the GC uses per-type pointer metadata to scan only pointer-containing words. Types with no pointers (`noscan`) live in dedicated spans and are skipped during marking — pure-value types are GC-cheap.
- **Weak pointers** arrived via the `weak` package (Go 1.24) — references that don't keep an object alive, useful for caches.
- **Atomic pointers:** `sync/atomic.Pointer[T]` (Go 1.19+) gives type-safe lock-free pointer swaps for hot read-mostly state (e.g. hot-reloading config).
- **`uintptr` is not a pointer.** It's a plain integer; the GC does not track it. Holding a `uintptr` does *not* keep an object alive — a notorious source of crashes.

## 12. Debugging Tips

- **Nil deref panic** prints a stack trace pointing at the exact line. Read the top frame of the `goroutine` trace; it's almost always a missing `nil` check before `.Field` or `*p`.
- Inspect escape decisions: `go build -gcflags='-m -m' ./...` shows `escapes to heap` / `does not escape`.
- Use `go vet` to catch lock-by-value copies (`copylocks`) and obvious nil issues.
- In Delve (`dlv`): `print p` shows the address, `print *p` dereferences, `print &x` takes an address. `p` on a nil pointer shows `*T nil`.
- For typed-nil interface bugs, print with `%#v` or use `reflect.ValueOf(err).IsNil()` to confirm.
- Race conditions on shared pointers: run with `-race`. Concurrent pointer writes without sync are undefined behavior.

> [!TIP]
> When a nil panic only happens in production, look for *optional* fields deserialized from JSON/proto that are `nil` when omitted — the classic 3am cause.

## 13. Senior Engineer Notes

As a senior reviewing code, you enforce *consistency and intent* with pointers:

- **Receiver discipline:** flag types that mix value and pointer receivers; require a one-line rationale when a method uses a pointer receiver purely for size. Push back on `*int` parameters where a return value reads cleaner.
- **API ergonomics:** challenge `*bool` fields — are they truly optional, or is someone modeling tri-state laziness? Often a small enum or explicit `OptionalBool` type communicates intent better.
- **Nil contracts:** every exported function that takes or returns a pointer should document its nil behavior. "Can this be nil?" should never be a guessing game in review.
- **Mentoring:** teach juniors the typed-nil-in-interface trap and the loop-variable-address trap with a runnable snippet — these two cause a disproportionate share of bugs.
- **Code judgement:** prefer slices-of-values over slices-of-pointers unless identity/mutation demands pointers; explain the GC and cache-locality reasoning, not just "it's faster".

## 14. Staff Engineer Notes

At staff level, pointer choices become *architecture and org policy*:

- **Data-oriented design at scale:** for systems pushing millions of objects (TSDBs, stream processors), mandate value-based, columnar layouts to slash GC pause times. This is a cross-cutting performance lever, not a local tweak — quantify GC CPU% before/after.
- **API schema strategy:** decide org-wide how optionality is modeled across services — protobuf `optional`, wrapper types, or field masks. Inconsistent `*T` usage across team boundaries produces brittle serialization contracts and breaks backward compatibility. This is a build-vs-adopt-standard decision (e.g. adopt protobuf field-presence rules).
- **`unsafe` governance:** set a policy that `unsafe`/`uintptr` lives only in a small, audited, fuzz-tested set of packages with a designated owner. One bad `uintptr`-as-pointer in shared infra can corrupt memory fleet-wide.
- **Lifetime & ownership models:** define who owns a pointer's lifecycle across module boundaries (pooling via `sync.Pool`, weak refs for caches). Memory-leak postmortems usually trace to unclear ownership, not a single bug.
- **Build-vs-buy:** for lock-free shared state, evaluate `atomic.Pointer[T]` vs a battle-tested cache (Ristretto, freelru) rather than hand-rolling pointer juggling the org will maintain forever.

## 15. Revision Summary

- A pointer stores an **address**; `&` takes one, `*` dereferences. Zero value is `nil`.
- Go is **pass-by-value**; pointers enable mutation across functions and avoid large copies.
- **No pointer arithmetic** and no `int↔pointer` casts (except via `unsafe`); the GC keeps pointers from dangling.
- **Escape analysis** decides stack vs heap; taking an address doesn't always heap-allocate.
- Use **pointer receivers** for mutation/large structs; be consistent. Document nil contracts.
- Watch the **typed-nil-in-interface** and pre-1.22 **loop-variable-address** traps.
- Pointers trade copy cost for **indirection + GC scanning**; benchmark before assuming "faster".
- `uintptr` is *not* a tracked pointer; `unsafe.Pointer` is the only sanctioned arithmetic path.

**References:** A Tour of Go ("Pointers", `tour.golang.org/moretypes/1`); Go spec (Address operators, Pointer types); `go doc unsafe`; `go doc sync/atomic.Pointer`.

---

*Go Engineering Handbook — topic 17.*
