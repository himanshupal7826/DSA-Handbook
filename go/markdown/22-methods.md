# 22 · Methods

> **In one line:** A method is a function bound to a named type via a receiver, and Go's rules for pointer vs value receivers, method sets, and method values determine what you can call, when copies happen, and which interfaces a type satisfies.

---

## 1. Overview

A **method** in Go is an ordinary function that carries a special extra parameter called the **receiver**. The receiver attaches the function to a *named type*, so instead of writing `Area(r Rectangle)` you write `(r Rectangle) Area()` and call it as `r.Area()`.

That small syntactic move unlocks Go's entire polymorphism story. Methods are what types use to *satisfy interfaces*, and the set of methods a type carries — its **method set** — is the precise rule the compiler uses to decide whether a value can be assigned to an interface.

There are two flavours of receiver:

- A **value receiver** `(t T)` operates on a *copy* of the value.
- A **pointer receiver** `(t *T)` operates on the *original* through a pointer, so mutations stick.

Go also lets you treat methods as first-class values: a **method value** (`r.Area`) binds the receiver now and produces a callable; a **method expression** (`Rectangle.Area`) leaves the receiver as an explicit first argument. Master these four ideas — receiver kind, method set, method value, method expression — and you understand 90% of how Go programs are structured.

---

## 2. Why It Exists

Go deliberately has **no classes, no inheritance, and no `this`**. The designers wanted behaviour without the object-oriented baggage. Methods give you the "data + behaviour" pairing of OOP while keeping the type system flat and explicit.

Three concrete motivations:

1. **Interface satisfaction is structural.** A type implements an interface simply by *having the right methods* — no `implements` keyword. Methods are the unit of that contract. Without methods, interfaces couldn't exist.
2. **Methods can hang off any named type**, not just structs. You can give methods to `type Celsius float64` or `type IntSlice []int`. This lets you add domain behaviour to primitive-backed types — something Java/C# cannot do.
3. **Receivers make the "subject" explicit.** Instead of an implicit `this`, the receiver is a named, typed parameter you control. You decide whether it's a copy or a pointer, which makes mutation semantics visible at the definition.

This is the Go philosophy from *Effective Go*: composition over inheritance, explicitness over magic. Methods + interfaces + embedding replace the entire class hierarchy machinery of traditional OOP.

---

## 3. Internal Working

A method is, at the machine level, **just a function with a rewritten name and a prepended parameter**. The compiler lowers `(r Rectangle) Area() float64` into something morally equivalent to a package-level function `Rectangle.Area(r Rectangle) float64`. The call `r.Area()` becomes `Rectangle.Area(r)`. There is *no per-object vtable pointer* stored in a struct — methods are resolved statically at compile time for concrete types.

Dispatch only becomes dynamic when a value is placed in an **interface**. An interface value is a two-word structure:

```text
 interface value (iface)
 ┌──────────────┬──────────────┐
 │   *itab      │   data ptr   │
 └──────┬───────┴──────────────┘
        │
        v
 ┌──────────────────────────────┐
 │ itab                         │
 │  - interface type info       │
 │  - concrete type info (_type)│
 │  - fun[0..n]  <- method ptrs │  <- method table for THIS
 └──────────────────────────────┘     (type, interface) pairing
```

The `itab` (interface table) holds an array `fun` of code pointers — one per interface method, filled in with the concrete type's method implementations. Calling `iface.Method()` is an indirect jump through `fun[k]`. The `itab` is computed once per (concrete type, interface) pair and cached, so the cost is one pointer load plus an indirect call.

**Method sets and the addressability rule.** This is the part that trips everyone up.

- The method set of type `T` contains all methods declared with receiver `T` (value receivers).
- The method set of type `*T` contains methods with receiver `T` **and** `*T`.

So `*T` has *more* methods than `T`. Why? Because Go can always dereference a pointer to get the value (`*p` is a `T`), but it cannot always take the address of a value to get a pointer. A pointer receiver method needs an addressable operand.

```text
 value receiver   (t T)  --> in method set of T  AND *T
 pointer receiver (t *T)  --> in method set of *T only
```

When you call `p.Method()` where `Method` has a value receiver, the compiler inserts `(*p)` automatically. When you call `v.Method()` where `Method` has a pointer receiver and `v` is **addressable** (a variable, a slice element, an addressable struct field), the compiler inserts `(&v)`. If `v` is *not* addressable (a map element, a return value, a literal), that auto-`&v` is illegal and you get a compile error.

A **method value** `f := r.Area` allocates a small closure that captures `r` (a copy for value receivers, the pointer for pointer receivers) and stores the function pointer. A **method expression** `f := Rectangle.Area` produces an unbound `func(Rectangle) float64` with no allocation of receiver state.

---

## 4. Syntax

```go
type Rectangle struct{ W, H float64 }

// Value receiver: operates on a copy.
func (r Rectangle) Area() float64 { return r.W * r.H }

// Pointer receiver: mutates the original.
func (r *Rectangle) Scale(f float64) {
	r.W *= f
	r.H *= f
}

// Methods on a non-struct named type.
type Celsius float64

func (c Celsius) Fahrenheit() Celsius { return c*9/5 + 32 }

func main() {
	r := Rectangle{3, 4}
	_ = r.Area() // 12
	r.Scale(2)   // r is addressable -> auto (&r).Scale(2)

	p := &r
	_ = p.Area() // auto (*p).Area()

	f := r.Area        // method value: receiver bound now
	_ = f()            //
	g := Rectangle.Area // method expression: receiver is an arg
	_ = g(r)           //
	h := (*Rectangle).Scale
	h(&r, 2)
}
```

> [!NOTE]
> You can only declare methods on types defined in the **same package**. You cannot add a method to `int`, `time.Time`, or any imported type directly — wrap it in a new named type first (`type MyInt int`).

---

## 5. Common Interview Questions

**Q1. What is the difference between a value receiver and a pointer receiver?**
A value receiver gets a copy of the value, so mutations don't propagate and large structs are copied on every call. A pointer receiver shares the original, allowing mutation and avoiding the copy. Use a pointer receiver when you must mutate or the struct is large.
*Follow-up: Can a value receiver method ever mutate something the caller sees?* Yes — if the struct contains a reference type (slice, map, pointer), the value copy still shares the underlying backing array/map, so element writes are visible.

**Q2. Why does `*T` have a larger method set than `T`?**
Because pointer-receiver methods require an addressable receiver. A `*T` can always be dereferenced to a `T`, but a `T` value isn't always addressable. So Go only guarantees pointer methods exist for pointers.
*Follow-up: When does this bite you?* On interface assignment: if `T` has pointer methods needed by the interface, only `*T` satisfies it, so `var i I = T{}` fails but `var i I = &T{}` works.

**Q3. If a method has a pointer receiver, can I still call it on a value?**
Only if the value is *addressable*. `v.Scale(2)` works when `v` is a local variable (compiler takes `&v`). It fails on map elements, function return values, and literals because those aren't addressable.
*Follow-up: Why are map elements not addressable?* Maps can rehash and move entries, so the runtime forbids taking a stable address into a map.

**Q4. What's the difference between a method value and a method expression?**
A method value (`r.Area`) binds the receiver at creation and yields `func() float64`. A method expression (`Rectangle.Area`) leaves the receiver as the first parameter, yielding `func(Rectangle) float64`.
*Follow-up: When is a method value useful?* As a callback — passing `buf.Write` where a function is expected, or `t.handler` to an event loop, capturing the receiver automatically.

**Q5. Should a type mix value and pointer receivers?**
No, as a rule. Pick one per type. Mixing makes the method set confusing and means only `*T` carries the full set, surprising interface assignments and copies. *Effective Go* recommends consistency.
*Follow-up: Why is mixing actively dangerous?* Copying a value of a type with pointer methods (e.g. a `sync.Mutex` field) can copy a lock or break invariants; `go vet` flags lock copies.

**Q6. Does calling a method allocate?**
A direct method call does not. A method *value* (`r.Area`) may heap-allocate a closure to store the bound receiver. Storing a concrete value into an interface may allocate to box it.
*Follow-up: How do you avoid the method-value allocation in a hot loop?* Call the method directly inside the loop instead of creating a bound closure, or hoist the closure outside the loop.

**Q7. Can two types share method implementations?**
Yes, via **embedding**. If `type Server struct{ Logger }`, then `Server` promotes `Logger`'s methods. It's composition, not inheritance — the promoted method still runs on the embedded `Logger`, not on `Server`.
*Follow-up: What happens on a name clash?* The outer type's method shadows the promoted one; ambiguous promotions from two embeds at the same depth are an error only when actually selected.

---

## 6. Production Use Cases

- **The standard library is built on methods.** `bytes.Buffer.Write`, `time.Time.Add`, `http.ResponseWriter`'s methods, and `sync.Mutex.Lock` are all methods that implement interfaces (`io.Writer`, `http.Handler` via `ServeHTTP`).
- **`http.Handler` and `http.HandlerFunc`.** A web service defines `func (s *Server) ServeHTTP(w, r)` so `*Server` satisfies `http.Handler`. Frameworks like **gin**, **chi**, and **echo** wire handlers this way. Note the *pointer* receiver: handlers usually hold shared state (DB pools, config).
- **`Stringer` and error types.** Production types implement `func (e *MyError) Error() string` (pointer receiver, since errors often carry wrapped causes). Logging libraries (`zap`, `logrus`) lean on `fmt.Stringer`.
- **Sort and search.** Before generics, `sort.Interface` required `Len`, `Less`, `Swap` methods — Kubernetes, Docker, and Terraform codebases are full of these.
- **State machines and domain objects.** gRPC service implementations (`*server` with generated method signatures), Kafka consumer handlers, and ORM models (GORM) all use pointer-receiver methods to mutate and persist entity state.
- **Functional options.** `func (o *Options) apply(...)` patterns used by the AWS SDK and gRPC dial options rely on methods over an options struct.

---

## 7. Common Mistakes

> [!WARNING]
> **Mutating through a value receiver and wondering why nothing changed.** `func (r Rectangle) Scale(f float64) { r.W *= f }` modifies a copy. The caller's `r` is untouched. Use a pointer receiver.

- **Putting a value type with pointer methods into an interface and copying it.** Copies a `sync.Mutex` or breaks identity. `go vet` catches lock copies.
- **Calling a pointer-receiver method on a non-addressable value**: `mymap["k"].Scale(2)` won't compile. Read into a variable, mutate, write back.
- **Range-loop receiver copies.** `for _, x := range items { x.Mutate() }` mutates a copy of each element when `x` is a value. Use `for i := range items { items[i].Mutate() }`.
- **Mixing receiver kinds** so `T` and `*T` have inconsistent method sets, causing surprising "does not implement interface" errors.
- **Assuming value receivers are always "safe to share."** If the struct embeds a slice/map, the copy aliases the backing store.

---

## 8. Performance Considerations

| Scenario | Cost |
|---|---|
| Direct method call (concrete type) | Same as a normal function call; often inlined |
| Method via interface | One `itab` load + indirect call; not inlinable across the boundary |
| Value receiver on large struct | Full struct copy per call (expensive for big structs) |
| Pointer receiver | One pointer copy (8 bytes), no struct copy |
| Method value (`r.Area`) | Possible heap allocation for the bound closure |
| Boxing concrete value into interface | Possible heap allocation to store the value |

Rules of thumb:

- For structs larger than ~3 machine words (~24 bytes) that are called frequently, a **pointer receiver avoids copy cost**. For tiny structs (`time.Time` is value-receiver-heavy and cheap), value receivers can be faster and more cache-friendly because they avoid a pointer indirection and reduce escape-analysis pressure.
- **Interface calls defeat inlining.** In hot loops, prefer concrete types or generics so the compiler can inline.
- Watch **escape analysis**: returning `&r` or taking `&r` in a method value often forces the receiver to the heap. Use `go build -gcflags='-m'` to see escapes.

> [!TIP]
> Don't reflexively reach for pointer receivers "for speed." For small immutable types, value receivers keep data on the stack and avoid GC pressure. Benchmark before deciding.

---

## 9. Best Practices

- **Pick one receiver kind per type.** If any method needs a pointer receiver, make them all pointer receivers (*Effective Go*).
- **Use a pointer receiver when:** the method mutates, the struct is large, or the type contains a `sync.Mutex`/other non-copyable field.
- **Use a value receiver when:** the type is small, immutable-by-convention, or a map/slice/primitive-backed type where copies are cheap and semantically clean.
- **Name the receiver short and consistent** — `r`, `s`, `c` — never `this` or `self`. Use the same letter across all methods of the type.
- **Make `Error()` and `String()` match your receiver convention** so the type satisfies `error`/`Stringer` from the right method set.
- **Prefer composition (embedding)** over trying to fake inheritance.
- **Document mutation** in the method doc comment when a pointer receiver changes state.

---

## 10. Code Examples

Primary idiomatic example: a counter showing receiver semantics, method values, and method expressions.

```go
package main

import "fmt"

type Counter struct{ n int }

func (c *Counter) Inc()      { c.n++ }      // pointer: mutates
func (c Counter) Value() int { return c.n } // value: read-only

func main() {
	c := Counter{}
	c.Inc() // (&c).Inc() — c is addressable
	c.Inc()
	fmt.Println(c.Value()) // 2

	// Method value: receiver bound now (pointer captured).
	inc := c.Inc
	inc()
	fmt.Println(c.Value()) // 3

	// Method expression: receiver is explicit.
	val := Counter.Value
	fmt.Println(val(c)) // 3
}
```

The same shape using an interface to show dynamic dispatch and the method-set rule:

```go
package main

import "fmt"

type Incrementer interface{ Inc() }

type Counter struct{ n int }

func (c *Counter) Inc() { c.n++ }

func main() {
	c := Counter{}

	// var i Incrementer = c  // COMPILE ERROR: Counter (value) has no Inc;
	//                        // Inc is in the method set of *Counter only.
	var i Incrementer = &c // OK
	i.Inc()
	i.Inc()
	fmt.Println(c.n) // 2 — mutation visible via shared pointer
}
```

A method on a non-struct named type plus embedding for method promotion:

```go
package main

import "fmt"

type Temperature float64

func (t Temperature) Hot() bool { return t > 30 }

type Logger struct{ prefix string }

func (l Logger) Log(msg string) { fmt.Println(l.prefix, msg) }

// Sensor embeds Logger and Temperature and promotes their methods.
type Sensor struct {
	Logger
	Temperature
}

func main() {
	s := Sensor{Logger{"[sensor]"}, 35}
	s.Log("starting")            // promoted from Logger
	fmt.Println("hot?", s.Hot()) // promoted from Temperature
}
```

---

## 11. Advanced Concepts

**Auto-address-of and the addressability boundary.** The compiler's willingness to insert `&v` for pointer-receiver calls only applies to addressable expressions. Function results, map index expressions, and constants are not addressable. This is *the* root cause of "cannot call pointer method on map element."

**Method sets and embedding interplay.** If you embed `*Logger` (pointer) vs `Logger` (value), the promoted method set differs. Embedding `*Logger` promotes both value- and pointer-receiver methods of `Logger` into `Sensor`; embedding `Logger` by value promotes only value-receiver methods into `Sensor`'s value method set.

**Methods on generic types.** Since Go 1.18 you can define methods on generic types, but the methods themselves cannot introduce *new* type parameters:

```go
type Stack[T any] struct{ items []T }

func (s *Stack[T]) Push(v T) { s.items = append(s.items, v) }

func (s *Stack[T]) Pop() (T, bool) {
	var zero T
	if len(s.items) == 0 {
		return zero, false
	}
	last := s.items[len(s.items)-1]
	s.items = s.items[:len(s.items)-1]
	return last, true
}
```

**Bound method values as goroutine entry points.** `go obj.Run()` is a common pattern — it captures `obj` and schedules `Run`. Be aware this keeps `obj` alive for the goroutine's lifetime and, for pointer receivers, shares mutable state across goroutines (needs synchronization).

**Method values vs closures.** A method value carries exactly the receiver; a manually written closure (`func() { obj.Run() }`) is equivalent but more explicit. The compiler may heap-allocate either if it escapes.

---

## 12. Debugging Tips

- **"X does not implement I (Inc method has pointer receiver)."** The classic. You assigned a *value* to an interface that needs pointer-receiver methods. Take the address: `&x`.
- **"cannot call pointer method on m[k]" / "cannot take the address of m[k]."** The receiver isn't addressable. Copy to a local, mutate, store back.
- **Mutation silently lost.** Suspect a value receiver or a `range`-variable copy. Switch to pointer receiver / index the slice directly.
- **`go vet`** catches copying locks (`copylocks`) and many composite mistakes. Run it in CI.
- **`go build -gcflags='-m'`** shows escape analysis: whether your receiver or method value escaped to the heap.
- **`go tool pprof`** — if interface-heavy code is slow, look for itab lookups and indirect-call hotspots.

> [!TIP]
> When an interface assignment mysteriously fails, ask: "Is the method's receiver a pointer, and am I handing over a value?" That single question resolves most method-set bugs.

---

## 13. Senior Engineer Notes

As a senior engineer, methods are where you enforce *design judgement in code review*:

- **Reject mixed receiver kinds** unless there's a documented reason. It's the most common subtle bug source in PRs — flag it every time.
- **Default to pointer receivers for types with any mutating method or a mutex**, and value receivers for small value-semantics types (money, coordinates, enums). Make this a team convention so reviews are mechanical.
- **Watch for accidental large-struct copies** in value-receiver methods on hot paths; suggest pointer receivers backed by a benchmark, not a hunch.
- **Mentor on the method-set rule** by example: show a junior the `var i I = T{}` failure and the `&T{}` fix, then explain *why* (addressability). Understanding beats memorization.
- **Guard the interface boundary.** When a type implements an interface, decide deliberately whether callers should hold `T` or `*T`, and keep that consistent across constructors (`New() *Server`).
- **Beware method values capturing receivers** in long-lived callbacks/goroutines — they can pin memory and share mutable state. Require synchronization review.

---

## 14. Staff Engineer Notes

At staff level the concern shifts from a single type to **API surface and org-wide consistency**:

- **Receiver conventions are API contracts.** Whether your library returns `*Client` or `Client` decides whether downstream teams can copy values, store them in maps, or share them across goroutines. This is hard to change later — treat it as a public-API decision with a deprecation cost.
- **Method set ⇒ interface satisfaction ⇒ dependency direction.** When defining the interfaces that decouple services/modules, the receiver kind your concrete types use determines who can implement them and how they're injected. Get this wrong and you create accidental coupling or force pointer-only usage org-wide.
- **Build-vs-buy and generics.** Before Go 1.18, method-based abstractions (`sort.Interface`) were the only generic mechanism; now you choose methods+interfaces vs type parameters. Staff guidance: use interfaces for behavioural polymorphism and runtime substitution (plugins, mocks); use generics for container/algorithm reuse where you want monomorphization and inlining. Don't let teams reinvent both.
- **Performance at the platform layer.** Interface dispatch is cheap per call but compounds in framework hot paths (middleware chains, serializers). For platform libraries used millions of times/sec, prefer concrete types or generics and document the rationale so product teams don't "optimize" by adding interfaces.
- **Establish lint/vet gates** (copylocks, custom receiver-consistency linters) so the convention scales across hundreds of engineers without manual review of every PR.
- **Stability:** changing a method from value to pointer receiver (or vice versa) is a *breaking change* to a type's method set and interface satisfaction. Track it under your semver discipline.

---

## 15. Revision Summary

- A **method** = function with a **receiver**; binds behaviour to a named type. No classes, no `this`.
- **Value receiver `(t T)`** → operates on a copy; in method set of both `T` and `*T`.
- **Pointer receiver `(t *T)`** → mutates the original; in method set of `*T` **only**.
- `*T`'s method set ⊇ `T`'s method set, because pointer methods need an **addressable** receiver.
- Interface satisfaction is decided by the **method set** — a frequent source of "does not implement" errors; fix with `&x`.
- **Method value** `r.Area` binds the receiver (may allocate); **method expression** `T.Area` takes the receiver as an explicit arg.
- Pointer-method calls auto-insert `&v` only for addressable `v` (not map elements, results, literals).
- Pick **one receiver kind per type**; use pointers for mutation, large structs, or types with mutexes.
- Interface dispatch = one itab load + indirect call; defeats inlining. Direct calls are cheap.
- Watch copies: value receivers + range vars + interface boxing all create copies.

**References:** Effective Go (Methods, Pointers vs. Values, Embedding); Go Language Specification (Method sets, Method values, Method expressions); `go vet` copylocks analyzer.

---

*Go Engineering Handbook — topic 22.*
