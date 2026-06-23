# 19 · Slices

> **In one line:** A slice is a tiny three-word header (pointer, length, capacity) over a shared backing array — cheap to pass, powerful to compose, and a source of subtle aliasing bugs if you forget it shares memory.

---

## 1. Overview

Slices are the workhorse collection type in Go. Where arrays have a fixed, compile-time size baked into their type (`[4]int` and `[5]int` are *different* types), slices are dynamically-sized, flexible *views* into a contiguous backing array. Ninety-five percent of the "list of things" you write in production Go is a slice, not an array.

The mental model that unlocks everything: **a slice is not the data — it is a small descriptor that points at the data.** It carries three fields: a pointer to the first element, a `len` (how many elements you can index), and a `cap` (how many elements exist before the backing array runs out). Copying a slice copies the header, not the elements, which is why slices are cheap to pass around but also why two slices can silently share — and stomp on — the same memory.

Master this header, `len` vs `cap`, how `append` grows the backing array, and the aliasing rules, and you will avoid the most common category of intermediate Go bugs.

## 2. Why It Exists

Fixed-size arrays are nearly useless as a general-purpose API surface. A function that takes `[10]byte` can only ever be called with exactly ten bytes; pass eleven and it won't compile. Worse, arrays are value types — passing `[1000000]int` to a function copies a million ints onto the stack.

Go's designers wanted three things at once:

1. **Dynamic sizing** without forcing every list onto the heap with pointer-chasing (like a linked list).
2. **Cheap pass-by-reference semantics** so functions can read and mutate large datasets without copies.
3. **Bounds safety** — no raw pointer arithmetic, every access checked.

Slices deliver all three by decoupling the *view* (the header) from the *storage* (the backing array). You get C-array cache locality and contiguous memory, with a safe, resizable, copy-cheap handle on top. The cost of that elegance is that the sharing is invisible at the call site — hence section 7.

## 3. Internal Working

A slice header is defined in the runtime (`runtime/slice.go`) and surfaced via `reflect.SliceHeader`:

```go
type slice struct {
    array unsafe.Pointer // pointer to backing array element 0 (of the slice's window)
    len   int            // number of accessible elements
    cap   int            // elements from `array` to end of backing storage
}
```

On a 64-bit machine that is **24 bytes** (three machine words). That is what gets copied when you assign a slice or pass it to a function — never the elements.

```text
  s := make([]int, 3, 6)

  Slice header (24 bytes, on stack)        Backing array (on heap, 6 ints)
  +-----------+                            +----+----+----+----+----+----+
  | array ----+--------------------------> | 0  | 0  | 0  |  ? |  ? |  ? |
  | len = 3   |                            +----+----+----+----+----+----+
  | cap = 6   |                              ^--- len=3 ---^
  +-----------+                              ^------- cap=6 ----------^
```

**Reslicing** (`s[1:3]`) creates a *new header* pointing into the *same* backing array — `array` is advanced, `len`/`cap` adjusted. No allocation, no copy.

**Append growth.** When `append` would exceed `cap`, the runtime allocates a *new, larger* backing array, copies the old elements over, and returns a header pointing at the new array. The old backing array is untouched (and may still be referenced by other slices). The growth policy (`growslice` in `runtime/slice.go`) is roughly:

- If the required capacity is more than double the current cap, use the required capacity.
- Otherwise, for small slices (under ~256 elements) **double** the capacity.
- For larger slices, grow by ~1.25x (a smoothed 25%) to avoid wasting memory on huge slices.

The exact thresholds changed in Go 1.18 (the old rule was "double under 1024, then 1.25x"); the runtime now ramps the factor smoothly. The result is **amortized O(1)** appends: n appends do total O(n) copying.

> [!NOTE]
> After a growth reallocation, the new slice no longer aliases the old backing array. Before a growth (when `cap` was sufficient), `append` writes *in place* and the result *does* alias. This split behavior is the root of most append bugs.

## 4. Syntax

```go
// Literals and construction
var s []int                 // nil slice: len 0, cap 0, nil pointer
s = []int{1, 2, 3}          // literal, len 3 cap 3
s = make([]int, 5)          // len 5, cap 5, zero-valued
s = make([]int, 0, 16)      // len 0, cap 16 (preallocate)

// Reslicing  s[low:high:max]
a := []int{0, 1, 2, 3, 4}
b := a[1:3]                  // len 2, cap 4  (1,2)
c := a[1:3:3]               // full-slice expr: len 2, cap 2  (caps it!)

// Append & copy
s = append(s, 4, 5)         // variadic
s = append(s, other...)     // spread another slice
n := copy(dst, src)         // copies min(len(dst), len(src)), returns n

// Iteration
for i, v := range s { _ = i; _ = v }
```

> [!TIP]
> `make([]T, len, cap)` with a known capacity is the single highest-leverage micro-optimization in Go — it eliminates repeated reallocations during `append`.

## 5. Common Interview Questions

**Q1. What are the three fields of a slice header?**
Pointer to the backing array, `len`, and `cap`. *Follow-up: how big is it on amd64?* 24 bytes (three 8-byte words).

**Q2. What's the difference between `len` and `cap`?**
`len` is how many elements you can index/range over; `cap` is how many exist from the slice's start pointer to the end of the backing array. `append` can grow `len` up to `cap` without reallocating.

**Q3. Does passing a slice to a function copy the data?**
No — it copies the 24-byte header. The callee can mutate existing elements (visible to caller). But if the callee `append`s and triggers a reallocation, the caller's slice header is unchanged (still points at the old array). *Follow-up: how does the caller see appended elements?* Return the slice and reassign: `s = grow(s)`.

**Q4. Why does this print `[1 99 3]`?**

```go
a := []int{1, 2, 3}
b := a[:1]
b = append(b, 99) // b has cap 3, writes in place
fmt.Println(a)    // [1 99 3]
```

Because `b` shared `a`'s backing array and had spare capacity, so `append` overwrote `a[1]` in place. *Follow-up: how to prevent it?* Use a full-slice expression `a[:1:1]` to force `append` to reallocate.

**Q5. What happens to a slice you `append` to in a loop without preallocating?**
It triggers multiple reallocations (geometric growth), each copying all elements — still amortized O(n) total, but with garbage and copy overhead. Preallocate with `make([]T, 0, n)`.

**Q6. Is a `nil` slice the same as an empty slice?**
Semantically nearly identical: `len`, `cap`, `append`, and `range` all work on `nil`. They differ in `s == nil` and in JSON marshaling (`nil` → `null`, empty → `[]`). *Follow-up: which should an API return?* Prefer `nil` internally; normalize to non-nil at JSON boundaries if the consumer expects `[]`.

**Q7. How do you remove element at index `i` from a slice (order doesn't matter / order matters)?**
Order-agnostic: `s[i] = s[len(s)-1]; s = s[:len(s)-1]`. Order-preserving: `s = append(s[:i], s[i+1:]...)` or `slices.Delete(s, i, i+1)` (Go 1.21+).

**Q8. Why can a slice of a large array cause a memory leak?**
The slice header keeps the *entire* backing array alive via its pointer, even if `len` is 1. The GC can't collect the big array. *Follow-up: fix?* Copy the needed portion into a fresh slice: `out := append([]T(nil), s...)`.

## 6. Production Use Cases

- **Buffer pools** — `bytes.Buffer`, `bufio`, and `sync.Pool`-managed `[]byte` slices back nearly every network and file I/O path in Go. The `net/http` server reuses byte slices for header parsing.
- **Protobuf / gRPC** — `protobuf-go` decodes repeated fields into preallocated slices; the codec uses `cap`-aware appends to minimize allocations on the hot decode path.
- **Database drivers** — `database/sql` scans rows into `[]interface{}` slices; `pgx` (PostgreSQL) reuses row-value slices across `Rows.Next()` iterations.
- **Kubernetes** — the API machinery passes around `[]runtime.Object` and label/selector slices everywhere; aliasing bugs in shared informer caches have caused real production incidents.
- **Log/metrics pipelines** (e.g. Prometheus, Loki) batch samples into preallocated slices, flush, then reslice to `s[:0]` to reuse the backing array — a zero-allocation steady state.

## 7. Common Mistakes

> [!WARNING]
> The append-aliasing trap (Q4) is the #1 slice bug. Any time you slice then append, ask: *does the sub-slice have spare capacity into memory someone else owns?*

- **Capturing the loop variable's address into a slice** — pre-Go-1.22 this aliased one variable; fixed in 1.22 where each iteration gets a fresh variable. Still appears in older codebases.
- **Assuming `append` returns a new slice** — it may mutate in place. Never ignore append's return value, and never keep using the *old* slice after appending to it if aliasing matters.
- **Sharing a slice across goroutines without synchronization** — the backing array is shared mutable state; concurrent writes are data races even if indices differ when growth reallocates.
- **`s2 := s1` thinking it's a deep copy** — it copies the header only. Use `copy` or `slices.Clone`.
- **Leaking large backing arrays** (Q8) by holding a tiny sub-slice of a huge buffer.
- **`range` over a slice and modifying its length** — appending inside a `range` iterates over a snapshot of the original `len`; subtle off-by-behaviors.

## 8. Performance Considerations

| Concern | Impact | Mitigation |
|---|---|---|
| Repeated `append` without prealloc | N reallocations + copies, GC churn | `make([]T, 0, n)` when size is known/estimable |
| Passing huge arrays by value | Full copy each call | Use a slice (24-byte header) |
| Slicing a giant buffer, holding it | Whole array pinned in memory | `slices.Clone` the needed window |
| `[]interface{}` of small values | Boxing → heap allocs per element | Use concrete typed slices |
| Reslicing to `s[:0]` then refilling | Zero allocation, reuses array | Idiomatic for buffer reuse |

Benchmark reality: appending 1M ints with no prealloc does ~20 reallocations and copies roughly 2M elements total; with `make([]int, 0, 1e6)` it's one allocation and zero copies — typically 3-5x faster and far less GC pressure. Always `go test -bench . -benchmem` and watch `allocs/op`.

Bounds-check elimination matters on hot loops: the compiler can sometimes prove indices are in range. Hoisting `n := len(s)` and indexing `s[i]` with `i < n` helps; tools like `go build -gcflags=-d=ssa/check_bce/debug=1` show what's eliminated.

## 9. Best Practices

- **Preallocate when you know the size.** `make([]T, 0, n)`.
- **Always reassign append's result:** `s = append(s, x)`.
- **Use the full three-index slice `a[lo:hi:hi]`** when handing a sub-slice to code that may append, to prevent it clobbering your tail.
- **Reach for the `slices` package** (Go 1.21+): `slices.Clone`, `slices.Delete`, `slices.Insert`, `slices.Contains`, `slices.SortFunc`. They're correct and clear.
- **Return `nil` for "no results"**, not an empty literal, unless a JSON `[]` is required.
- **Reuse buffers with `s = s[:0]`** in hot loops instead of reallocating.
- **Document ownership** in APIs: does the callee retain or copy the slice? This prevents aliasing surprises across package boundaries.

## 10. Code Examples

Primary: safe sub-slicing and append that never aliases the source.

```go
package main

import (
	"fmt"
	"slices"
)

// extractWindow returns an independent copy so callers can append freely.
func extractWindow(src []int, lo, hi int) []int {
	return slices.Clone(src[lo:hi]) // detaches from src's backing array
}

func main() {
	data := []int{10, 20, 30, 40, 50}
	w := extractWindow(data, 1, 3) // [20 30], own backing array
	w = append(w, 999)             // cannot corrupt `data`
	fmt.Println(data, w)           // [10 20 30 40 50] [20 30 999]
}
```

```go
package main

import "fmt"

// Alternative: full-slice expression caps capacity so append must reallocate.
func extractWindow(src []int, lo, hi int) []int {
	return src[lo:hi:hi] // cap == len; next append copies out
}

func main() {
	data := []int{10, 20, 30, 40, 50}
	w := extractWindow(data, 1, 3)
	w = append(w, 999) // cap was 2 -> reallocates, data untouched
	fmt.Println(data, w)
}
```

Buffer reuse pattern (zero-allocation steady state) — used in batching pipelines:

```go
buf := make([]Event, 0, 1024)
for {
	buf = buf[:0] // reset length, keep capacity & backing array
	for i := 0; i < batchSize; i++ {
		buf = append(buf, readEvent())
	}
	flush(buf) // flush must COPY if it retains buf beyond this iteration
}
```

## 11. Advanced Concepts

**`copy` semantics with overlap.** `copy` handles overlapping source/dest correctly (like `memmove`), which makes in-place shifts safe: `copy(s[i:], s[i+1:])` deletes element `i` in order-preserving fashion.

**Three-index slices and capacity control.** `a[low:high:max]` sets `cap = max - low`. This is the *only* way to shrink a slice's capacity without copying, and the key defensive tool against append-aliasing across API boundaries.

**Growth and `unsafe`.** `unsafe.Slice(ptr, len)` (Go 1.17+) builds a slice from a raw pointer — used in cgo and zero-copy parsing. `unsafe.SliceData` extracts the backing pointer. Powerful, unsafe, and excluded from the GC's normal reasoning if misused.

**Slices of slices vs. true 2D.** `[][]int` is a slice of independent slice headers (jagged, pointer-chasing). For dense matrices, allocate one flat `[]float64` of `rows*cols` and index `m[r*cols+c]` — far better cache behavior.

**`append` and shared-array race conditions.** Two goroutines appending to copies of the same slice with spare capacity can both write the same backing-array slot — a classic data race that `go test -race` catches.

> [!NOTE]
> Since Go 1.21, the `slices` and `maps` packages plus generics make most manual slice surgery obsolete. Prefer them; reserve manual reslicing for hot paths and zero-copy tricks.

## 12. Debugging Tips

- **`go run -race` / `go test -race`** — catches concurrent backing-array writes, the most insidious slice bug.
- **Print the header:** `fmt.Printf("len=%d cap=%d ptr=%p\n", len(s), cap(s), s)`. A changing `ptr` across an `append` tells you a reallocation (and thus de-aliasing) happened.
- **Suspect a leak?** Use `runtime/pprof` heap profiles; a small slice pinning a huge backing array shows up as unexpectedly retained memory. Fix with `slices.Clone`.
- **Unexpected mutation of a "different" slice** → you have aliasing. Diff the `%p` of the two slices' first elements.
- **`-gcflags=-m`** shows escape analysis (did your slice escape to the heap?).
- For benchmark surprises, `-benchmem` and watch `allocs/op` — a non-zero count in a "reuse" loop means your `s[:0]` reset isn't actually reusing.

## 13. Senior Engineer Notes

A senior engineer treats slice ownership as part of the API contract. In code review, the reflexes are: *Does this function append to a slice it received? Then it must either document that it may mutate the caller's tail, or defensively `slices.Clone`/use a three-index slice.* You flag any `s2 := s1` that the author clearly believes is a copy.

You mentor juniors past the "append returns a new slice" misconception by walking them through the `%p` of the backing pointer before and after a growth. You establish team conventions: preallocate with capacity hints, always reassign append's result, return `nil` not `[]T{}`, and reach for the `slices` package over hand-rolled loops. On hot paths you make deliberate, measured choices — buffer reuse with `s[:0]`, `sync.Pool` for large transient slices — and you require benchmarks (`-benchmem`) to justify them rather than guessing. You know when *not* to optimize: a slice in a request handler that runs 100 times a second doesn't need a pool.

## 14. Staff Engineer Notes

At staff level the slice concerns become architectural and organizational. You define the conventions that prevent aliasing incidents across an entire codebase — for shared caches (think Kubernetes informers or an in-memory config store), you mandate that anything handed out to callers is a deep copy or an immutable view, because a single aliasing bug in shared state can corrupt every consumer and is nearly impossible to reproduce. You weigh build-vs-buy: do we adopt the standard `slices` package and generics wholesale, or maintain bespoke utilities? (Adopt the standard library — reduced surface area and battle-tested correctness almost always win.)

Cross-team, you set the API ownership rules: every package that returns a slice documents whether the caller may retain or must copy it; every package that *accepts* one states whether it retains. You make org-level trade-offs on memory pooling — pervasive `sync.Pool` usage buys throughput but adds cognitive load and use-after-return bugs; you decide where that complexity is warranted (gateway, serialization layer) and where it's premature. You think about the memory-leak class (giant backing arrays pinned by tiny views) as a systemic risk in long-lived services and bake `slices.Clone` at trust boundaries into the architecture, not into a code-review checklist that will eventually be forgotten.

## 15. Revision Summary

- A slice = **header (ptr, len, cap)** over a shared **backing array**; header is 24 bytes on amd64.
- Copying/passing a slice copies the **header only**, not the elements.
- `len` = indexable count; `cap` = elements to end of backing array.
- `append` grows in place if `cap` allows (aliases!); otherwise **reallocates + copies** (de-aliases). Growth ~2x small, ~1.25x large; amortized O(1).
- **Aliasing bug:** slice + append with spare cap can stomp another slice's data. Defend with `a[lo:hi:hi]` (full-slice) or `slices.Clone`.
- **Always** `s = append(s, ...)`; **preallocate** `make([]T, 0, n)` when size known.
- A tiny sub-slice **pins the whole backing array** → leak; copy out to release.
- `nil` slice ≈ empty for `append`/`range`/`len`; differs for `== nil` and JSON (`null` vs `[]`).
- Use the **`slices` package** (1.21+): `Clone`, `Delete`, `Insert`, `Contains`.
- Reuse buffers with `s = s[:0]`; catch concurrency bugs with `-race`.

**References:** Go blog — "Go Slices: usage and internals" and "Arrays, slices (and strings): The mechanics of 'append'"; `runtime/slice.go` (`growslice`); Go standard library `slices` package docs.

---

*Go Engineering Handbook — topic 19.*
