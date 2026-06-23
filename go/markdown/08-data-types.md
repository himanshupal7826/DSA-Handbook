# 8 · Data Types

> **In one line:** Go's type system is a small, explicit set of numeric, string, boolean, and composite types whose memory layout you can reason about exactly — which is the whole point.

---

## 1. Overview

Go is statically and strongly typed: every variable has a type known at compile time, and there are no implicit conversions between types (not even `int` to `int64`). The type set is deliberately small and orthogonal, grouped into:

- **Numeric types** — sized integers (`int8`…`int64`, `uint8`…`uint64`), the platform-word `int`/`uint`, `uintptr`, floats (`float32`, `float64`), and complex (`complex64`, `complex128`).
- **String** — an immutable sequence of bytes, UTF-8 by convention.
- **Boolean** — `bool` with values `true`/`false`.
- **Composite types** — arrays, slices, maps, structs, channels, pointers, functions, and interfaces.

The recurring theme: Go wants you to know the *size and cost* of what you declare. A `struct` has a predictable layout; a `slice` is three machine words; a string is two. This predictability is what makes Go suitable for systems work while staying simple. (See *A Tour of Go* → "Basic types".)

## 2. Why It Exists

Most languages either hide memory (Python, JavaScript — everything is a boxed object) or expose it dangerously (C — `int` size varies, no bounds). Go threads the needle:

- **Explicit sizes** mean wire formats, file headers, and hardware registers map cleanly to types. `uint32` is always 4 bytes, on every platform.
- **No implicit conversion** kills an entire class of bugs (signed/unsigned mismatch, silent truncation, float/int confusion) at compile time instead of in production.
- **Value semantics by default** (everything is copied unless you take a pointer) makes data flow auditable and concurrency-safe: passing a value to a goroutine doesn't share mutable state by accident.
- **Composite types with known layout** let the compiler stack-allocate, inline, and avoid the GC where possible.

The trade-off is verbosity — you write explicit conversions — but the payoff is that the cost of every line is visible.

## 3. Internal Working

Each type has a fixed size and an alignment requirement the compiler uses to lay out memory. The runtime carries type metadata (`runtime._type`) used by reflection, the GC, and interface dispatch.

**Numeric types** are machine-native. `int`/`uint`/`uintptr` are 64-bit on amd64/arm64 and 32-bit on 32-bit targets. Integers use two's complement; overflow wraps silently (it is defined behavior, unlike C). Floats are IEEE-754.

**Strings** are a 2-word header: a `*byte` data pointer and an `int` length. The bytes are immutable, so multiple strings can share backing storage (e.g. a substring slices into the same array). There is no capacity and no NUL terminator.

**Slices** are a 3-word header — pointer, length, capacity — pointing into a backing array.

```text
string header (16 bytes on 64-bit)
+-----------+--------+
|  *data    |  len   |
+-----------+--------+
     |
     v
   [ 'h''e''l''l''o' ]   (immutable UTF-8 bytes)

slice header (24 bytes on 64-bit)
+--------+-------+-------+
| *array |  len  |  cap  |
+--------+-------+-------+

struct{ a bool; b int64; c bool }  -> 24 bytes (padding!)
offset:  0      8              16
+------+--------+--------+------+--------+
| bool | pad x7 |  int64 | bool | pad x7 |
+------+--------+--------+------+--------+
```

**Structs** are laid out field-by-field with padding inserted so each field meets its alignment (an `int64` must sit on an 8-byte boundary). The struct's own alignment is the max of its fields'. Field *order* therefore changes the total size — reordering the struct above to `{a, c bool; b int64}` shrinks it from 24 to 16 bytes.

**`rune` and `byte`** are aliases: `byte` = `uint8`, `rune` = `int32`. A `rune` holds one Unicode code point; a `byte` holds one octet of UTF-8.

## 4. Syntax

```go
// Numeric — explicit sizes
var i8 int8 = -128
var u32 uint32 = 4_294_967_295 // underscores allowed in literals
var f float64 = 3.14
var bignum = 1 << 40 // untyped constant, fits in int

// Conversions are always explicit
var n int = 42
var f2 float64 = float64(n)
var b byte = byte(n)

// String, byte, rune
s := "héllo"
fmt.Println(len(s))                    // 6 — bytes, not runes (é is 2 bytes)
fmt.Println(utf8.RuneCountInString(s)) // 5 — code points
r := []rune(s)                         // decode to runes
bs := []byte(s)                        // raw bytes

// Composite
arr := [3]int{1, 2, 3}        // fixed-size array (value)
sl := []int{1, 2, 3}          // slice (reference-ish header)
m := map[string]int{"a": 1}   // map
type Point struct{ X, Y int } // struct
p := &Point{X: 1, Y: 2}       // pointer to struct
```

> [!NOTE]
> Untyped constants (`const x = 5`) have arbitrary precision until assigned, so `const big = 1 << 62` is fine even though it would overflow `int32`.

## 5. Common Interview Questions

**Q1. What is the size and zero value of each basic type?**
`bool` 1 byte / `false`; `int`/`uint` 8 bytes (on 64-bit) / `0`; `float64` 8 / `0.0`; `string` 16 (header) / `""`; pointers/slices/maps/channels / `nil`. *Follow-up: what's the zero value of a struct?* — each field set to its own zero value, recursively; no constructor runs.

**Q2. Difference between `rune` and `byte`?**
`byte` = `uint8` (one octet), `rune` = `int32` (one Unicode code point). Ranging over a string yields `rune`s and byte indices; indexing a string (`s[i]`) yields a `byte`. *Follow-up: what does `len("世界")` return?* — 6, because each character is 3 UTF-8 bytes.

**Q3. Why doesn't Go allow `int + int64` without conversion?**
To prevent silent width/sign bugs; `int` may be 32 or 64 bits, so the result type would be ambiguous and non-portable. *Follow-up: is `int` ever guaranteed 64 bits?* — No. Use `int64` when you need a guarantee.

**Q4. Is a string mutable? How do you "change" one?**
Immutable. You build a new string: convert to `[]byte` or `[]rune`, mutate, convert back. *Follow-up: cost?* — the conversion copies (allocates), unless the compiler proves it's safe to avoid (e.g. `string(b)` used only as a map key).

**Q5. What happens on integer overflow?**
It wraps (two's complement), no panic. `var x uint8 = 255; x++` gives `0`. *Follow-up: float overflow?* — produces `+Inf`/`-Inf`, and `0.0/0.0` is `NaN`, where `NaN != NaN`.

**Q6. How does struct field ordering affect memory?**
Padding for alignment means poorly ordered fields waste bytes. Group fields large-to-small to minimize padding. *Follow-up: tool to check?* — `unsafe.Sizeof`, or `fieldalignment` from `go vet`/`golang.org/x/tools`.

**Q7. What is the difference between an array and a slice?**
An array `[N]T` has its length in its type and is a value (copied on assignment); a slice `[]T` is a header pointing at a backing array and is cheap to pass. *Follow-up: can you compare them?* — arrays of comparable elements are comparable with `==`; slices are not (only to `nil`).

**Q8. Why can `float64` not represent `0.1` exactly?**
IEEE-754 binary fractions can't represent most decimal fractions finitely, so `0.1 + 0.2 != 0.3`. *Follow-up: how to handle money?* — use integer minor units (cents) or a decimal library like `shopspring/decimal`.

## 6. Production Use Cases

- **Wire protocols & binary parsing** — Kubernetes, etcd, and gRPC use fixed-width types (`uint32`, `int64`) with `encoding/binary` to read/write headers deterministically across platforms.
- **Money** — Stripe-style systems store amounts as `int64` minor units (cents) rather than floats to avoid rounding drift.
- **Text processing** — search and CDN systems (Cloudflare's Go services) lean on the string/`[]byte`/`rune` distinction to avoid UTF-8 corruption when slicing user content.
- **High-throughput structs** — databases like CockroachDB and Dgraph hand-pack structs (field ordering, fixed-size arrays) to cut per-row memory and improve cache locality.
- **IDs and bitsets** — `uint64` for Snowflake-style IDs (Twitter/Discord), and integer bit flags for compact permission sets.

## 7. Common Mistakes

> [!WARNING]
> Indexing a string returns a **byte**, not a character. `"héllo"[1]` is `0xc3`, the first byte of `é`, not `'é'`.

- **Truncating on conversion**: `int32(someInt64)` silently drops high bits. Range-check before narrowing.
- **Comparing floats with `==`**: use an epsilon tolerance, or avoid floats for exact values.
- **Assuming `len(s)` is character count**: it's byte count.
- **Mutating a string via `[]byte` and expecting the original to change**: the conversion copies.
- **Forgetting `int` width**: serializing `int` to disk/wire breaks across 32/64-bit boundaries — use a sized type.
- **Uninitialized maps**: a `nil` map reads fine but panics on write. A `nil` slice, by contrast, appends fine.

## 8. Performance Considerations

- **Struct padding** can balloon memory in large slices. Reorder fields large→small; a `[]struct{}` of a million 24-byte structs becomes 16 bytes/each after reordering — saving 8 MB.
- **Value vs pointer copies**: passing a big struct by value copies every byte. Pass `*T` for large structs in hot paths, but small structs (≤ 2-3 words) are often *faster* by value (no indirection, no heap escape).
- **`string`↔`[]byte` conversions allocate.** In hot loops, the compiler optimizes some cases (`[]byte(s)` as a map key, `string(b)` in comparisons), but assume a copy otherwise. Use `bytes.Buffer`/`strings.Builder` to avoid repeated conversions.
- **Integer math beats float** for counters and indices, and avoids `NaN`/precision surprises.
- **`float32` halves memory** vs `float64` for large numeric arrays (ML embeddings, signal data), at the cost of precision.

## 9. Best Practices

- Use `int` for loop counters, indices, and general integers; reach for sized types only for wire formats, bit-packing, or guaranteed ranges.
- Prefer `[]byte` when you build/mutate text; `string` when you store/pass immutable text.
- Order struct fields **largest to smallest** (or run `fieldalignment`).
- Never use floats for money, currency, or anything requiring exact decimal equality.
- Always range strings with `for i, r := range s` when you mean characters.
- Make zero values useful — design structs so the zero value is a valid, usable state (no constructor required).

## 10. Code Examples

Primary: iterating bytes vs runes correctly.

```go
package main

import (
	"fmt"
	"unicode/utf8"
)

func main() {
	s := "Gø日"

	// byte view
	fmt.Println("bytes:", len(s)) // 6 (1 + 2 + 3)

	// rune view — range decodes UTF-8
	for i, r := range s {
		fmt.Printf("byte=%d rune=%c (U+%04X)\n", i, r, r)
	}
	fmt.Println("runes:", utf8.RuneCountInString(s)) // 3
}
```

```go
package main

import (
	"fmt"
	"unsafe"
)

// Alternative: struct layout & alignment cost.

type Bad struct {
	a bool  // 1 byte + 7 padding
	b int64 // 8
	c bool  // 1 byte + 7 padding
} // 24 bytes

type Good struct {
	b int64 // 8
	a bool  // 1
	c bool  // 1 + 6 padding
} // 16 bytes

func main() {
	fmt.Println(unsafe.Sizeof(Bad{}))  // 24
	fmt.Println(unsafe.Sizeof(Good{})) // 16
}
```

Reordering fields cut the struct by a third — meaningful across millions of rows.

## 11. Advanced Concepts

- **Type definitions vs aliases**: `type Celsius float64` creates a *new distinct type* (no implicit mix with `float64`); `type byte = uint8` (with `=`) is an *alias* — identical type. Named types let you attach methods and prevent unit-mixing bugs.
- **Type parameters (generics, Go 1.18+)**: constraints like `constraints.Integer` or `~int` (the tilde meaning "any type whose underlying type is int") let you write numeric code generic over all int widths.
- **`unsafe.Pointer` and layout**: lets you reinterpret bytes (e.g. zero-copy `[]byte`↔`string`), but bypasses the type system and the GC's guarantees — reserve for serialization hot paths and document heavily.
- **Complex numbers**: `complex128` with `real()`/`imag()` — niche, used in FFT/signal code.
- **`NaN` and ordering**: `NaN` breaks total ordering, so it poisons sorts and map keys; `math.IsNaN` is the only reliable check.

## 12. Debugging Tips

- `unsafe.Sizeof`, `unsafe.Alignof`, `unsafe.Offsetof` reveal exact layout when memory is mysterious.
- `go vet` with `fieldalignment` flags padding waste: `go run golang.org/x/tools/go/analysis/passes/fieldalignment/cmd/fieldalignment ./...`.
- `fmt.Printf("%T", x)` prints the dynamic type — invaluable when interfaces hide the concrete type.
- For float surprises, print with `%.17g` to see full precision; for byte/rune confusion, print `%q` and `%x`.
- `go tool compile -m` shows escape analysis — whether a value stays on the stack or heaps.

## 13. Senior Engineer Notes

A senior engineer treats the type signature as the primary design surface. In code review, you flag `int` where a wire format demands `uint32`, floats holding money, and structs whose field order leaks bytes. You push back on `interface{}`/`any` parameters that throw away the static guarantees the type system gives you.

You mentor by explaining *why* value semantics matter: a junior who passes a 200-byte struct by value into a million-iteration loop has written a correctness-safe but slow program; you teach them to read escape analysis and benchmark rather than guess. You also know when *not* to optimize — a 16-byte struct passed by value is fine, and pointer-chasing for "performance" often hurts cache locality. The judgement is matching the type's cost to the call frequency, backed by `pprof`, not folklore.

## 14. Staff Engineer Notes

At staff level the concern shifts from individual types to **type contracts across system boundaries**. Choosing `int64` vs `string` for an ID propagates into your protobuf schemas, database columns, JSON APIs, and every downstream consumer — a change is a multi-team migration. You standardize these decisions org-wide (e.g. "all monetary values are `int64` minor units in a `Money` type with a currency tag") and encode them in shared libraries so teams can't drift.

You weigh build-vs-buy on numeric correctness: adopt `shopspring/decimal` for finance versus rolling fixed-point, knowing the audit and onboarding cost of each. You think about cross-language boundaries — Go's `int` portability, UTF-8 string assumptions when interoperating with Java (UTF-16) or systems with different endianness — and you set the platform conventions (`encoding/binary` byte order, time as `int64` epoch micros) that prevent subtle data-corruption incidents at the seams between services. The output isn't code; it's the type discipline the whole org inherits.

## 15. Revision Summary

- Go is statically/strongly typed with **no implicit conversions**; every type has a fixed, knowable size.
- Numeric: sized ints/uints, platform `int`/`uint`, `float32/64`, `complex`. Overflow wraps; floats are IEEE-754.
- **`byte` = `uint8`, `rune` = `int32`.** `len(s)` is bytes; range over a string yields runes.
- Strings are immutable 2-word headers; slices are 3-word headers; structs are padded to alignment (order matters).
- Zero values are well-defined and should be designed to be useful.
- Never use floats for money; use `int64` minor units or a decimal library.
- Reorder struct fields large→small to cut padding; verify with `unsafe.Sizeof` / `fieldalignment`.

**References:** A Tour of Go ("Basic types", "Type conversions"); Go spec (Types); `go vet` fieldalignment pass.

---

*Go Engineering Handbook — topic 8.*
