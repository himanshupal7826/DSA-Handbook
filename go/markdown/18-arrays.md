# 18 · Arrays

> **In one line:** A Go array is a fixed-size, value-typed sequence whose length is part of its type, copied wholesale on assignment and passing.

---

## 1. Overview

An array in Go is a numbered sequence of elements of a single type with a **fixed length that is part of the type itself**. `[3]int` and `[4]int` are distinct, incompatible types. This single design decision — length-in-the-type — drives almost everything surprising about Go arrays: they are value types, they copy element-by-element on assignment, and they cannot be resized.

Most working Go code reaches for **slices**, not arrays. But arrays are the foundation slices are built on: every slice points at a backing array. Understanding arrays is therefore non-negotiable for understanding slices, escape analysis, and the performance characteristics of hot-path code. Arrays also have a quiet renaissance in modern Go: fixed-size keys, cryptographic digests (`[32]byte`), SIMD-friendly layouts, and stack-allocated buffers all lean on them.

> [!NOTE]
> If you only remember one thing: an array's length is part of its type, and assigning or passing an array **copies all of its elements**.

## 2. Why It Exists

Arrays exist because the machine has them. A contiguous block of `N` elements is the most primitive aggregate data structure a CPU and allocator can represent, and Go exposes it directly so you can:

- **Get predictable, contiguous memory** with zero indirection — great for cache locality.
- **Allocate on the stack** when the size is known at compile time, avoiding the heap and the garbage collector entirely.
- **Encode size into the type system** so the compiler can prove bounds and lay out structs precisely (e.g. `[16]byte` for an IPv6 address, `[32]byte` for a SHA-256 digest).
- **Build slices** — the slice header (`ptr`, `len`, `cap`) is meaningless without a backing array to point at.

Go's designers deliberately made the *value-copy* behavior the default to keep the model simple and aliasing-free: an array is just a value, like an `int` or a `struct`. Slices were then layered on top to provide the flexible, reference-like, growable abstraction that most code wants. Arrays are the honest, low-level primitive; slices are the ergonomic everyday tool.

## 3. Internal Working

An array is laid out as **a contiguous run of its elements with no header**. There is no length word stored alongside the data at runtime — the length lives in the *type*, which the compiler knows statically. `len(a)` for an array is resolved at compile time to a constant; it is not a runtime field lookup.

```text
var a [4]int32   // 4 elements × 4 bytes = 16 contiguous bytes

 address →  0x...00   0x...04   0x...08   0x...0c
          +---------+---------+---------+---------+
          | a[0]    | a[1]    | a[2]    | a[3]    |
          +---------+---------+---------+---------+
            int32     int32     int32     int32

Total size = len × sizeof(elem) = 4 × 4 = 16 bytes. No pointer, no header.
```

Contrast this with a slice, which is a 3-word header pointing *into* such an array:

```text
slice header (24 bytes on 64-bit)        backing array (separate allocation)
+----------+----------+----------+        +-----+-----+-----+-----+
| ptr  ----|--------->|          |  --->  | e0  | e1  | e2  | e3  |
+----------+----------+----------+        +-----+-----+-----+-----+
| len = 4  | cap = 4  |
+----------+----------+
```

Key runtime consequences:

- **Copy semantics.** `b := a` emits a `memmove`/element copy of the whole array. Passing `a` to a function copies it onto the callee's stack frame. The compiler may use `runtime.memmove` for large arrays or unroll small copies inline.
- **Stack vs heap.** Because the size is known, the compiler's *escape analysis* can place an array on the stack if it does not escape. A `[1024]byte` scratch buffer that stays local never touches the heap or GC.
- **Comparability.** Arrays of comparable element types are themselves comparable with `==`; the compiler generates a field-wise comparison. This makes arrays usable as **map keys**, unlike slices.
- **Bounds checks.** Indexing is bounds-checked at runtime, but for constant indices into fixed arrays the compiler often *eliminates* the check entirely.

## 4. Syntax

```go
var a [5]int                      // zero-valued: [0 0 0 0 0]
b := [3]string{"x", "y", "z"}     // composite literal
c := [...]int{10, 20, 30}         // ... lets the compiler count → [3]int
d := [5]int{1: 10, 3: 30}         // indexed: [0 10 0 30 0]
e := [...]int{9: 1}               // sparse: length 10, last element = 1

var grid [3][4]byte               // 2D array: 3 rows × 4 cols, contiguous

n := len(a)                       // 5, a compile-time constant
v := b[1]                         // "y"
b[1] = "Y"                        // in-place mutation

for i, val := range c {           // range over arrays works as expected
    _ = i
    _ = val
}
```

> [!TIP]
> `[...]T{...}` is the idiomatic way to declare a fixed array literal without hand-counting elements. The `...` is counted by the compiler, not a variadic.

## 5. Common Interview Questions

**Q1. What is the difference between an array and a slice in Go?**
An array has a fixed length that is part of its type and is a value type (copied on assignment/passing). A slice is a 3-word header (`ptr`, `len`, `cap`) referencing a backing array; it is reference-like, resizable via `append`, and cheap to pass.
*Follow-up: Is `[3]int` assignable to `[4]int`?* No — different types entirely; it is a compile error.

**Q2. What happens when you pass an array to a function?**
The entire array is copied into the callee's frame. Mutations inside the function do not affect the caller's array. To mutate in place, pass a pointer (`*[N]T`) or, more idiomatically, a slice.
*Follow-up: How would you avoid the copy cost for a large array?* Pass `*[N]T` (or a slice of it) so only a pointer/header is copied.

**Q3. Can arrays be used as map keys? Can slices?**
Arrays of comparable elements can be map keys (and compared with `==`). Slices cannot — they are not comparable and will not compile as a key.
*Follow-up: Why?* Slice equality is ambiguous (identity vs deep), and slices are mutable references, which would break the hash-key invariant.

**Q4. What does `len()` cost for an array?**
Nothing at runtime for the common case — it is a compile-time constant derived from the type. For slices, `len` reads a field from the header.
*Follow-up: Does `len(p)` where `p` is `*[N]T` work?* Yes, `len` and indexing transparently dereference an array pointer.

**Q5. How is `[...]int{5: 1}` interpreted?**
Indexed literal: it creates a length-6 array (`[6]int`) with index 5 set to 1, the rest zero.
*Follow-up: What is the array's length here?* 6 — the length is `highest index + 1`.

**Q6. Are two arrays comparable with `==`?**
Yes, if the element type is comparable; comparison is element-wise. `[3]int{1,2,3} == [3]int{1,2,3}` is `true`.
*Follow-up: What about `[3][]int`?* Not comparable — the element type `[]int` is not comparable, so the array isn't either.

**Q7. When does an array live on the stack vs the heap?**
Escape analysis decides. If the array does not escape the function (no pointer to it stored beyond its lifetime, not returned by reference), it stays on the stack — no GC pressure.
*Follow-up: How do you verify?* `go build -gcflags='-m'` prints escape-analysis decisions.

**Q8. Why does `b := a; b[0] = 9` not change `a`?**
Because `b := a` copies the whole array by value. `b` is an independent copy; mutating it never touches `a`.

## 6. Production Use Cases

- **Cryptographic digests and keys.** `crypto/sha256.Sum256` returns `[32]byte`; `crypto/md5` returns `[16]byte`. Returning a fixed array avoids a heap allocation per hash and lets the digest be used directly as a comparable value or map key. The Go standard library uses this pattern pervasively.
- **Network addresses.** `net/netip.Addr` (the modern replacement for `net.IP`) stores the address in fixed-size fields rather than a heap-allocated `[]byte`, making `netip.Addr` a small, comparable, allocation-free value — a direct win for high-throughput proxies and load balancers (used in Tailscale's stack, which authored `netip`).
- **Fixed-size lookup tables.** Compile-time constant tables — CRC polynomials, base64 encode tables (`[64]byte`), gamma-correction LUTs — are arrays so they live in read-only program data with zero init cost.
- **Stack scratch buffers.** `var buf [64]byte; n := strconv.AppendInt(buf[:0], x, 10)` formats integers with no heap allocation, a standard hot-path trick in logging libraries (zap, zerolog) and `fmt` internals.
- **Map keys for composite identities.** A `[2]int{userID, tenantID}` or `[16]byte` UUID array used directly as a `map` key avoids string concatenation and its allocations.
- **SIMD / cache-friendly numeric kernels.** Game engines and signal-processing code use fixed arrays (`[4]float32` vectors, `[16]float32` matrices) for predictable, contiguous, vectorizable layouts.

## 7. Common Mistakes

> [!WARNING]
> The number-one bug: expecting array mutations inside a function to be visible to the caller. They are not — the array was copied.

- **Assuming pass-by-reference.** `func f(a [1000]int)` copies 8 KB on every call. Use `[]int` or `*[1000]int`.
- **Confusing `[N]T` with `[]T`.** `[...]int{1,2,3}` is an array; `[]int{1,2,3}` is a slice. Mixing them up in function signatures yields type errors.
- **Trying to resize.** `append(arr, x)` does not compile for an array; `append` operates on slices. You must slice the array first (`arr[:]`).
- **Accidental large copies in `range`.** `for _, big := range arrOfBigStructs` copies each element. Use `for i := range arr` and index, or use a slice.
- **Off-by-one in indexed literals.** `[...]int{10: 5}` has length 11, not 1 — easy to overlook.
- **Comparing incomparable arrays.** `[3][]byte` won't compile under `==`; reach for `bytes.Equal` per element or `reflect.DeepEqual`.

## 8. Performance Considerations

Arrays are a performance tool *and* a performance trap, depending on size and how you pass them.

| Operation | Array `[N]T` | Slice `[]T` |
|---|---|---|
| Assignment / pass to func | Copies all N elements | Copies 24-byte header only |
| `len` | Compile-time constant | Runtime field read |
| Heap allocation | Often avoidable (stack) | Backing array usually heaps if it escapes |
| As map key | Allowed (comparable) | Not allowed |
| Resize | Impossible | `append` (amortized O(1)) |

Guidance with numbers:
- A `[8]byte` or `[16]byte` copy is essentially free (one or two register/`MOV` ops) — pass by value freely.
- A `[4096]byte` copy is a 4 KB `memmove` on every pass — measurably expensive in a hot loop; pass `*[4096]byte`.
- Stack-allocating a scratch array (`var buf [256]byte`) avoids a heap allocation and a future GC scan — in allocation-heavy code this can cut allocations to zero and shave double-digit percentages off latency.
- Returning `[32]byte` from a hash function is faster than returning `[]byte`, because the latter forces a heap allocation while the former returns in registers/stack.

> [!TIP]
> Rule of thumb: pass arrays by value only when `sizeof <= ~64 bytes`. Above that, pass a pointer or slice. Always confirm with `-gcflags=-m` and a benchmark.

## 9. Best Practices

- **Default to slices.** Use arrays only when fixed size is genuinely part of the contract (digests, keys, addresses, scratch buffers).
- **Use `[N]byte` for fixed-width identifiers** (UUIDs, hashes) to get comparability, map-key support, and zero allocations.
- **Pass large arrays by pointer** (`*[N]T`) or convert to a slice (`a[:]`) to avoid copies.
- **Prefer `[...]T{}`** for literals so adding/removing elements doesn't require updating a hand-typed length.
- **Exploit stack allocation** for short-lived buffers; slice them with `buf[:0]` for `append`-based formatting.
- **Use named constants for the length** (`const N = 16; var a [N]T`) so the size has a single source of truth.
- **Leverage array comparability** instead of writing manual element-by-element equality.

## 10. Code Examples

Primary idiomatic example — value semantics, comparability, and the pointer escape hatch:

```go
package main

import "fmt"

// modifyCopy receives a COPY; caller is unaffected.
func modifyCopy(a [3]int) {
	a[0] = 99
}

// modifyInPlace receives a pointer; caller's array is mutated.
func modifyInPlace(a *[3]int) {
	a[0] = 99 // implicit (*a)[0]
}

func main() {
	orig := [...]int{1, 2, 3} // [3]int

	modifyCopy(orig)
	fmt.Println(orig) // [1 2 3] — unchanged

	modifyInPlace(&orig)
	fmt.Println(orig) // [99 2 3] — mutated

	// Arrays are comparable and usable as map keys.
	seen := map[[2]int]bool{}
	seen[[2]int{1, 2}] = true
	fmt.Println(seen[[2]int{1, 2}]) // true

	x := [3]int{1, 2, 3}
	y := [3]int{1, 2, 3}
	fmt.Println(x == y) // true — element-wise comparison
}
```

Alternative — zero-allocation scratch buffer feeding a slice, the standard hot-path pattern:

```go
package main

import (
	"fmt"
	"strconv"
)

// formatID writes an integer into a stack array, no heap allocation.
func formatID(id int) string {
	var buf [20]byte // fits any int64, lives on the stack
	b := strconv.AppendInt(buf[:0], int64(id), 10)
	return string(b)
}

func main() {
	fmt.Println(formatID(42))      // "42"
	fmt.Println(formatID(-987654)) // "-987654"

	// A fixed array as a backing store you then slice.
	var grid [3][3]int
	for i := range grid {
		for j := range grid[i] {
			grid[i][j] = i*3 + j
		}
	}
	fmt.Println(grid) // [[0 1 2] [3 4 5] [6 7 8]]
}
```

## 11. Advanced Concepts

- **Array-to-slice in O(1).** `a[:]` produces a slice whose `ptr` points at `a[0]`, `len == cap == len(a)`. No copy. But beware: if `a` is a local stack array and the slice escapes (e.g. returned), escape analysis forces `a` onto the heap.
- **Slice-to-array conversions (Go 1.20+).** `arr := [4]byte(s)` converts a slice to an array value (copying), and `p := (*[4]byte)(s)` converts to an array pointer (no copy, aliasing the slice's backing store). Both panic if `len(s) < 4`. This is invaluable for parsing fixed-width binary headers: `magic := [4]byte(data[:4])`.
- **Multidimensional arrays are truly contiguous.** `[3][4]int` is 12 ints in one block, unlike `[][]int` (a slice of independently allocated slices). This gives better locality but rigid shape.
- **Arrays in structs control layout and size.** Embedding `[16]byte` inline keeps the struct allocation-free and pointer-free, which the GC can skip scanning entirely (no pointers to trace) — a real win for large collections of such structs.
- **Generic arrays.** With generics you can write `func Sum[T Number](a []T)`, but Go does **not** allow the array length to be a type parameter. Length parametricity is a known limitation; you typically take a slice `[]T` in generic code instead.
- **Comparability propagation.** An array is comparable iff its element type is. This recursively determines whether structs containing arrays are comparable and map-key-eligible.

## 12. Debugging Tips

- **Escape analysis:** `go build -gcflags='-m -m' ./...` shows lines like `moved to heap: buf` — exactly why your "stack" array allocated.
- **Bounds-check elimination:** `go build -gcflags='-d=ssa/check_bce/debug=1'` reports remaining bounds checks; constant indices into fixed arrays should show none.
- **Unexpected non-mutation:** if a function "isn't changing my array," you almost certainly passed it by value. Check the signature for `[N]T` vs `*[N]T` vs `[]T`.
- **Confirm copies in benchmarks:** wrap the call in `testing.B` and watch `allocs/op` and `ns/op`; a surprising jump usually means a large array is being copied.
- **`reflect` for dynamic length:** `reflect.TypeOf(a).Len()` gives an array type's length when debugging generic/reflective code.
- **Disassembly:** `go tool objdump -s funcName binary` reveals whether a copy became a `memmove` call versus inlined `MOV`s.

## 13. Senior Engineer Notes

A senior engineer's value here is *judgement at the call site and in review*. In code review, flag every function taking `[N]T` by value where `N * sizeof(T)` exceeds ~64 bytes — it is almost always an unintended copy, and the fix (`*[N]T` or `[]T`) is one keystroke. Conversely, push back on slices used where a fixed array would be safer and cheaper: a 16-byte UUID stored as `[]byte` loses comparability, costs an allocation, and invites aliasing bugs.

Teach juniors the mental model "array = value, slice = view." Most array confusion dissolves once that sticks. When mentoring, demonstrate the escape-analysis flags live; seeing `moved to heap` for a buffer they thought was free is a formative moment.

Design-wise, choose `[N]byte` deliberately for domain identifiers and digests to get free comparability and map-key eligibility — this simplifies whole layers of code that would otherwise need custom equality and string-keyed maps. And know the failure mode: returning `a[:]` from a function silently heap-promotes the array, erasing the stack-allocation benefit you were chasing. Catch that in review.

## 14. Staff Engineer Notes

At staff level the array-vs-slice decision becomes an *architectural and organizational* one. When defining a wire format, RPC schema, or an inter-service data contract, fixed-size fields (`[32]byte` digests, `[16]byte` IDs) make encoders allocation-free and self-describing, and they propagate across team boundaries — a `netip.Addr`-style value type spreads zero-allocation discipline through every service that adopts it. The Tailscale `netip` package is the canonical build-it-yourself case study: they replaced `net.IP` (`[]byte`-backed, allocating, non-comparable) with a fixed-layout, comparable, allocation-free value type, and that decision rippled into measurable cluster-wide CPU and GC savings.

Build-vs-buy: for hashes, IDs, and addresses, prefer standard-library/community value types (`netip.Addr`, `[N]byte` digests, `google/uuid` which exposes `[16]byte`) over rolling bespoke representations — the comparability and zero-alloc properties are already correct, and consistency across the org matters more than micro-optimizing one service.

The org-level trade-off is rigidity versus performance. Fixed arrays bake size into the type and therefore into every API boundary; widening a `[16]byte` to `[32]byte` later is a breaking change across all consumers. So reserve fixed arrays for sizes that are *physically* fixed (a SHA-256 is always 32 bytes) and use slices where the size is a policy that might evolve. Finally, set this as a measurable platform standard: hot-path allocation budgets enforced in CI via `allocs/op` benchmarks, with fixed arrays as the sanctioned tool for hitting zero-allocation targets in shared libraries.

## 15. Revision Summary

- An array's **length is part of its type**; `[3]int` ≠ `[4]int`.
- Arrays are **value types**: assignment and function passing **copy all elements**.
- Mutate a caller's array via `*[N]T` (or use a slice); plain `[N]T` params won't propagate changes.
- `len` on an array is a **compile-time constant**; arrays have **no runtime header**, just contiguous elements.
- Arrays of comparable elements are **comparable** and valid **map keys**; slices are neither.
- Use `[...]T{}` to let the compiler count; indexed literals set length to `maxIndex + 1`.
- Slices are built on arrays; `a[:]` is an O(1) view (may force heap escape if it escapes).
- Go 1.20+: convert slice→array (`[4]byte(s)`, copy) or slice→array-pointer (`(*[4]byte)(s)`, no copy).
- Pass by value only for small arrays (~≤64 bytes); pointer/slice for large ones.
- Real-world fits: digests (`[32]byte`), addresses (`netip.Addr`), UUID/composite map keys, stack scratch buffers.

**References:** Go blog — "Go Slices: usage and internals" / "Arrays"; Go spec (Array types, Comparison operators, Conversions); `crypto/sha256`, `net/netip` source; `go build -gcflags=-m` escape analysis.

---
*Go Engineering Handbook — topic 18.*
