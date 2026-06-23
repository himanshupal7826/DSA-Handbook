# 21 · Structs

> **In one line:** A struct is Go's value-typed aggregate of named fields, laid out contiguously in memory, that drives composition (via embedding), serialization (via tags), and cache-friendly performance (via alignment).

---

## 1. Overview

A **struct** is a composite type that groups zero or more named fields into a single value. Unlike a class in OOP languages, a Go struct carries *no methods inside its body*, *no inheritance*, and *no constructors* — it is pure data. Behavior is attached separately through methods on the type, and code reuse is achieved through **embedding** rather than subclassing.

Structs are the workhorse of Go programs. Almost every meaningful domain concept — an HTTP request, a database row, a config object, a graph node — is a struct. Because structs are **value types**, copying a struct copies all its fields; passing one to a function passes a copy unless you take a pointer. Understanding their memory layout, alignment, and copy semantics separates a beginner who "uses structs" from an engineer who reasons about allocations, cache behavior, and API design.

This chapter covers the full surface: composite literals, embedding, struct tags, and memory **alignment** — the four pillars you must master for both production code and interviews.

## 2. Why It Exists

Before structs, languages forced you to either pass long parameter lists or use untyped maps/dictionaries. Both are error-prone: positional arguments swap silently, and maps lose compile-time type safety. Structs give you:

- **Cohesion** — related data travels together as one unit with a name.
- **Value semantics** — predictable copy behavior, no hidden aliasing, easy to make immutable-by-convention.
- **Zero-cost abstraction** — a struct of three `int`s is just 24 contiguous bytes; there is no object header, vtable, or boxing like in Java.
- **Composition over inheritance** — Go's designers deliberately rejected class hierarchies (see *Effective Go*). Embedding lets you build complex types from simple ones without the fragile-base-class problem.

Structs exist because Go's philosophy is *explicit, flat, and cheap*. They are the bridge between raw memory and typed, named domain models.

## 3. Internal Working

A struct's fields are stored **contiguously in memory in declaration order**. The Go compiler does **not** reorder fields (unlike Rust). The total size and field offsets are determined by **alignment rules**: each field must start at an offset that is a multiple of its alignment requirement (usually equal to its size for primitives, capped at the platform word size). The compiler inserts **padding** bytes to satisfy this, and the struct's own size is rounded up to a multiple of its largest field alignment so that arrays of the struct stay aligned.

Consider this struct on a 64-bit platform:

```text
type Bad struct {
    a bool    // 1 byte,  offset 0
    b int64   // 8 bytes, needs 8-align -> offset 8
    c bool    // 1 byte,  offset 16
}

Memory layout (24 bytes total):
offset:  0    1                8                16   17           24
        +----+----------------+----------------+----+------------+
        | a  |  padding (7B)  |       b        | c  | pad (7B)   |
        +----+----------------+----------------+----+------------+

Reordered as {b int64; a bool; c bool} -> 16 bytes:
offset:  0                8    9    10                          16
        +----------------+----+----+----------------------------+
        |       b        | a  | c  |       padding (6B)         |
        +----------------+----+----+----------------------------+
```

The runtime treats a struct value as an opaque blob of bytes. A pointer to a struct (`*T`) is a single machine word pointing at the first field; field access is a compile-time-computed offset add (`base + offset`), not a hash lookup. This is why field access is O(1) and essentially free.

An **empty struct** `struct{}` has size **0** and all instances share the special `runtime.zerobase` address — perfect for sets (`map[string]struct{}`) and signal channels (`chan struct{}`) with no memory cost. Embedded fields are stored inline (for value embedding) exactly as if you had written the fields by hand; the compiler synthesizes *promoted* field and method access.

## 4. Syntax

```go
// Declaration
type User struct {
    ID        int64
    Name      string
    Email     string `json:"email"`        // field tag
    createdAt time.Time                     // unexported (lowercase)
}

// Composite literals
u1 := User{ID: 1, Name: "Ada"}             // keyed (preferred)
u2 := User{1, "Ada", "ada@x.io", time.Now()} // positional (fragile)
u3 := &User{Name: "Grace"}                 // pointer to struct
var u4 User                                // zero value: all fields zeroed

// Anonymous struct (one-off)
pt := struct{ X, Y int }{X: 3, Y: 4}

// Embedding (composition)
type Admin struct {
    User                                    // embedded; fields promoted
    Level int
}
a := Admin{User: User{Name: "root"}, Level: 9}
fmt.Println(a.Name) // promoted from User
```

> [!TIP]
> Always use **keyed** composite literals (`User{ID: 1}`). Positional literals break silently when a field is added or reordered, and `go vet` flags them for tagged structs.

## 5. Common Interview Questions

**Q1. Are structs passed by value or by reference in Go?**
By value. Passing a struct copies every field. For large structs or when you need mutation visible to the caller, pass `*T`. *Follow-up: when is value passing actually faster?* For small structs (≤ a couple words) the copy avoids pointer indirection and a potential heap escape, so value passing can be faster and keeps data on the stack.

**Q2. What is the zero value of a struct?**
A struct with every field set to its own zero value (0, "", nil, false). No constructor runs. *Follow-up: how do you make the zero value useful?* Design so the zero value is immediately usable — `sync.Mutex{}`, `bytes.Buffer{}`, and `strings.Builder{}` all work with zero value, no init needed. This is idiomatic Go.

**Q3. How does embedding differ from inheritance?**
Embedding is composition: the outer type *has-a* inner type whose fields/methods are *promoted*, but there is no subtype relationship and no virtual dispatch. The outer type can override a promoted method by declaring its own. *Follow-up: what happens on a name collision between two embedded types?* The promoted name becomes ambiguous; you must qualify it explicitly (`a.User.Name`). It is a compile error only if you access it unqualified.

**Q4. Can you compare two structs with `==`?**
Yes, if all fields are comparable (no slices, maps, or functions). Comparison is field-by-field. *Follow-up: how do you compare structs containing slices?* Use `reflect.DeepEqual`, or in tests `google/go-cmp`'s `cmp.Equal`.

**Q5. What is the size of `struct{}`?**
Zero bytes. *Follow-up: why use it?* As a map value to build a set, or as a channel element for pure signaling — no allocation per element.

**Q6. Why might two structs with the same fields have different sizes?**
Field ordering changes padding. Reordering from largest-to-smallest minimizes padding. *Follow-up: how do you measure it?* `unsafe.Sizeof(x)` for total size, `unsafe.Offsetof(x.field)` for offsets, or the `fieldalignment` analyzer.

**Q7. What do struct tags do at runtime?**
Nothing on their own — they are raw strings stored in the type metadata, read via reflection by libraries like `encoding/json`. *Follow-up: are tags type-checked?* No; a typo like `json:"naem"` compiles fine. Use linters (`structtag`/`go vet`) to catch malformed tags.

## 6. Production Use Cases

- **API / wire serialization**: every JSON or Protobuf payload maps to a tagged struct. `encoding/json`, `github.com/json-iterator/go`, and Protobuf-generated Go code all rely on struct tags.
- **Database ORM/mapping**: `database/sql` row scanning, GORM, and `jmoiron/sqlx` use `db:"..."` tags to map columns to fields.
- **Configuration**: Kubernetes objects (`PodSpec`, `Deployment`) are giant tagged structs decoded from YAML; `spf13/viper` and `kelseyhightower/envconfig` bind env/config into structs.
- **HTTP frameworks**: `net/http`'s `http.Request`, gin's `Context`, and request-binding (`c.ShouldBindJSON(&req)`) all center on structs.
- **High-performance data**: Cloudflare and game/networking engines hand-pack structs to minimize cache misses; alignment-aware layout cuts per-object size by 20–40% in hot paths.
- **Sets and signaling**: `map[T]struct{}` is the canonical Go set across the standard library and Kubernetes internals; `chan struct{}` for cancellation/done signals.

## 7. Common Mistakes

> [!WARNING]
> **Range copies structs.** `for _, v := range users { v.Name = "x" }` mutates a *copy*. Use `for i := range users { users[i].Name = "x" }` or a slice of pointers.

- **Storing huge structs by value in slices/maps** then copying them on every access — silently expensive.
- **Putting a `sync.Mutex` in a struct that gets copied** — copies the lock, breaking mutual exclusion. `go vet` catches this; embed the mutex and pass the struct by pointer.
- **Positional composite literals** that break when fields change.
- **Exporting fields that should be invariants** — public mutable fields let callers violate your type's constraints.
- **Comparing structs with uncomparable fields** — runtime panic if done via interface, compile error directly.
- **Forgetting field tags are case-sensitive and library-specific** — `json` vs `yaml` vs `db` tags are independent.

## 8. Performance Considerations

- **Copy cost**: copying scales with struct size. A 200-byte struct copied in a tight loop over 10M iterations is real CPU. Profile with `pprof`; switch to pointers when copies dominate.
- **Alignment & cache lines**: a CPU cache line is 64 bytes. Packing related hot fields together and shrinking the struct improves cache utilization. Reordering fields can drop a struct from 40→32 bytes, fitting more per cache line.
- **Escape analysis**: returning `&T{}` may force heap allocation. Value returns and small structs often stay on the stack. Check with `go build -gcflags='-m'`.
- **False sharing**: in concurrent code, two goroutines writing different fields on the *same cache line* thrash each other. Pad hot per-CPU fields to 64 bytes (`runtime` does exactly this internally).
- **Empty struct**: `struct{}` adds zero memory — prefer it over `bool` for sets.

| Concern | Value struct | Pointer to struct |
|---|---|---|
| Copy on pass | Full copy | One word |
| Mutation visible to caller | No | Yes |
| Heap allocation risk | Lower (stack) | Higher (may escape) |
| Best for | Small, immutable | Large, shared, mutable |

## 9. Best Practices

- **Make the zero value useful** — avoid mandatory `Init()` calls where possible.
- **Use keyed composite literals** always.
- **Keep fields unexported** unless callers genuinely need them; expose behavior via methods.
- **Order fields largest-to-smallest** for hot, high-cardinality structs to cut padding (let `fieldalignment` guide you — don't micro-optimize cold structs at the cost of readability).
- **Prefer pointer receivers** consistently if any method needs one (don't mix value/pointer receivers on the same type).
- **Embed for composition**, but don't over-embed — deep promotion chains hurt readability.
- **Tag for every wire format you support**, and validate with `go vet`.
- Use the **functional-options pattern** for structs with many optional fields rather than telescoping constructors.

## 10. Code Examples

Primary idiomatic example — domain struct with tags, embedding, methods, and a constructor:

```go
package user

import (
	"errors"
	"time"
)

type Audit struct {
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type User struct {
	Audit              // embedded: CreatedAt/UpdatedAt promoted
	ID    int64        `json:"id"`
	Name  string       `json:"name"`
	Email string       `json:"email,omitempty"`
}

// Constructor: zero value isn't enough here (we set timestamps).
func NewUser(name, email string) (*User, error) {
	if name == "" {
		return nil, errors.New("name required")
	}
	now := time.Now()
	return &User{
		Audit: Audit{CreatedAt: now, UpdatedAt: now},
		Name:  name,
		Email: email,
	}, nil
}

// Pointer receiver: mutates in place, no copy.
func (u *User) Rename(name string) {
	u.Name = name
	u.UpdatedAt = time.Now() // promoted field
}
```

Alternative — the functional-options pattern for many optional fields:

```go
package server

import "time"

type Server struct {
	addr    string
	timeout time.Duration
	tls     bool
}

type Option func(*Server)

func WithTimeout(d time.Duration) Option { return func(s *Server) { s.timeout = d } }
func WithTLS() Option                    { return func(s *Server) { s.tls = true } }

func New(addr string, opts ...Option) *Server {
	s := &Server{addr: addr, timeout: 30 * time.Second} // sensible defaults
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// Usage: New(":8080", WithTLS(), WithTimeout(5*time.Second))
```

A set built with the empty struct (standalone, distinct example):

```go
seen := make(map[string]struct{})
seen["a"] = struct{}{}
if _, ok := seen["a"]; ok {
	// present — zero memory per entry
}
```

## 11. Advanced Concepts

- **Method promotion & interface satisfaction**: if embedded `T` has method `M()` satisfying interface `I`, then the outer struct also satisfies `I`. This is how `io.ReadWriter` composition works.
- **Embedding interfaces in structs**: `type LoggingReader struct { io.Reader }` lets you wrap and selectively override methods (the decorator pattern) — used heavily in middleware.
- **Anonymous structs** for table-driven tests and one-off JSON shapes: `[]struct{ in, want int }{...}`.
- **Struct tags with multiple keys**: `` `json:"id" db:"user_id" validate:"required"` `` — each library parses its own key.
- **`unsafe` and layout introspection**: `unsafe.Sizeof`, `unsafe.Offsetof`, `unsafe.Alignof` reveal the true layout. C interop (`cgo`) requires matching C struct alignment.
- **Comparable structs as map keys**: a struct of comparable fields can be a map key — great for composite keys (`map[Coord]Cell`).
- **False-sharing padding**: `_ [64]byte` padding fields isolate hot counters onto separate cache lines in high-contention concurrent structs.

> [!NOTE]
> The Go memory model does not guarantee field-level atomicity. Concurrent writes to different fields of the same struct still need synchronization if they may race.

## 12. Debugging Tips

- **Inspect layout**: run the `fieldalignment` analyzer:
  `go run golang.org/x/tools/go/analysis/passes/fieldalignment/cmd/fieldalignment@latest ./...` — it reports padding waste and can auto-fix with `-fix`.
- **Check sizes/offsets** at runtime with `unsafe.Sizeof(x)` and `unsafe.Offsetof(x.f)`.
- **Find lock copies**: `go vet ./...` flags copying values that contain a `sync.Mutex` ("copylocks").
- **Spot escapes/allocs**: `go build -gcflags='-m -m'` shows what escapes to the heap.
- **Catch tag typos**: `go vet`'s `structtag` check validates tag syntax; use `go-cmp` in tests for readable struct diffs.
- **Unexpected zero fields after JSON decode** usually mean a tag mismatch or an unexported field — exported fields only are (un)marshaled.

## 13. Senior Engineer Notes

A senior engineer treats struct design as **API design**. Decide value-vs-pointer receivers *once per type* and stay consistent; mixing them causes subtle method-set bugs around interface satisfaction. In code review, push back on exported mutable fields that break invariants, on positional literals, and on `sync.Mutex` embedded in copyable structs.

Mentor juniors on the "useful zero value" principle — it is the single biggest lever for clean Go APIs. Teach that `range` copies, and that a slice of large structs vs a slice of pointers is a deliberate trade-off (pointer slices add GC pressure and indirection; value slices give cache locality but expensive copies). Reach for `go-cmp` over `reflect.DeepEqual` in tests, and gate `fieldalignment`/`go vet` in CI rather than hand-tuning. Know *when not to optimize layout*: readability beats saving 8 bytes on a config struct instantiated once.

## 14. Staff Engineer Notes

At staff level the questions are organizational and architectural. **Wire-format stability**: struct tags define your public contract; a renamed field or changed tag is a breaking API/DB-schema change that ripples across teams — version your schemas (Protobuf field numbers, additive-only changes) rather than relying on ad-hoc JSON tags. Drive a **shared types/contracts package** or schema registry so dozens of services agree on struct shapes instead of each redefining `User`.

On **build-vs-buy**: standardize serialization (stdlib `encoding/json` for simplicity vs `protobuf`/`json-iterator` for throughput) as an org decision with measured trade-offs, not per-team preference. For **performance at scale**, mandate `fieldalignment` and false-sharing reviews only on identified hot paths (per-request, per-packet objects) — Cloudflare-scale systems treat struct layout as a real cost center, but most services should not. Finally, set the cultural norm that data (structs) and behavior (methods/interfaces) stay decoupled, keeping the codebase composable as it grows past a million lines and many teams.

## 15. Revision Summary

- Struct = value-typed, contiguous, named fields; no inheritance, no methods in the body.
- **Value semantics**: passing/ranging copies; use `*T` for mutation or large structs.
- **Zero value should be useful** (`sync.Mutex`, `bytes.Buffer`).
- **Embedding** = composition with field/method promotion; resolve name clashes by qualifying.
- **Tags** are reflection-only strings driving JSON/DB/validation; not type-checked — lint them.
- **Alignment**: fields contiguous in declaration order, padded to alignment; order largest→smallest to shrink size. 64-byte cache line; pad to avoid false sharing.
- `struct{}` is 0 bytes — use for sets and signal channels.
- Compare with `==` only if all fields comparable; else `go-cmp`/`reflect.DeepEqual`.
- Tools: `fieldalignment`, `unsafe.Sizeof/Offsetof`, `go vet` (copylocks, structtag), `-gcflags=-m`.
- Prefer keyed literals, consistent receivers, functional options for many optionals.

**References:** *Effective Go* (Composite literals, Embedding); Go spec (Struct types, Size and alignment guarantees); `golang.org/x/tools` fieldalignment analyzer; `encoding/json` and `google/go-cmp` package docs.

---

*Go Engineering Handbook — topic 21.*
