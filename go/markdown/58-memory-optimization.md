# 58 · Memory Optimization

> **In one line:** Shrink the bytes your program touches by ordering struct fields for alignment, eliminating padding, and keeping the working set small enough to live in cache.

---

## 1. Overview

Memory optimization in Go is the discipline of making your program touch *fewer bytes* and *fewer cache lines* to do the same work. It operates at two scales. At the micro scale you control **struct layout**: how the compiler arranges fields, the **padding** it inserts for **alignment**, and the total size of each value. At the macro scale you control the **working set**: the live, frequently-accessed bytes that must fit in CPU cache (L1 ~32 KB, L2 ~256 KB–1 MB, L3 a few MB per core) to avoid the ~100 ns penalty of a main-memory fetch.

These two scales compound. A struct that is 25% smaller fits 25% more elements per cache line, which means fewer cache misses when you iterate a slice of millions of them. The same change reduces heap pressure, which reduces GC scan time and allocation rate. Memory optimization is therefore one of the highest-leverage performance activities in Go: it is often a pure win with no algorithmic change.

This chapter focuses on the techniques a Go engineer applies *after* picking the right algorithm: field ordering, padding elimination, choosing value vs pointer representations, pooling, and measuring the result with `unsafe.Sizeof`, `pprof`, and benchmarks.

## 2. Why It Exists

Modern CPUs are starved for data, not instructions. A single L1 hit is ~1 ns; a main-memory miss is ~100 ns. That is a 100x cliff. If your hot loop walks a slice of fat structs scattered across memory, you spend most of your time *waiting* for RAM while the ALU sits idle.

Go's compiler also imposes **alignment rules** driven by the hardware: an `int64` or `float64` must sit on an 8-byte boundary, an `int32` on a 4-byte boundary, and so on. To satisfy these constraints the compiler inserts **padding** bytes between fields. Naive field ordering can bloat a struct by 50% or more purely from padding you never asked for. Memory optimization exists to recover those bytes and to keep the working set inside cache, turning latency-bound code into throughput-bound code.

> [!NOTE]
> Go's GC is a non-moving, concurrent mark-sweep collector. It must *scan* every live pointer. Fewer and smaller allocations mean less for the GC to scan, so memory layout directly affects GC pause and CPU cost — not just raw RAM usage.

## 3. Internal Working

The Go compiler lays out struct fields **in source order** (unlike C++/Rust, Go never reorders fields for you). For each field it ensures the field's offset is a multiple of the field's alignment. The struct's overall alignment is the max of its fields' alignments, and the struct's total size is rounded up to a multiple of that alignment so arrays of the struct stay aligned.

Consider a poorly ordered struct on a 64-bit platform:

```text
type Bad struct {        offset  size  note
    a bool   //  1 byte    0      1
    // 7 bytes PADDING      1      7   <- to align b to 8
    b int64  //  8 bytes    8      8
    c bool   //  1 byte    16      1
    // 7 bytes PADDING     17      7   <- tail pad to mult of 8
}                         total = 24 bytes

Reordered (largest-first):
type Good struct {
    b int64  //  8 bytes    0      8
    a bool   //  1 byte     8      1
    c bool   //  1 byte     9      1
    // 6 bytes PADDING      10     6   <- tail pad only
}                         total = 16 bytes  (33% smaller)
```

The rule of thumb: **order fields from largest alignment to smallest** (pointers/int64/float64 → int32 → int16 → bool/byte). This packs small fields together and collapses interior padding into a single tail pad.

At runtime, the allocator (`mallocgc`) rounds every allocation up to one of ~70 **size classes** (8, 16, 24, 32, 48, ...). So a 17-byte struct actually consumes a 24-byte slot. Shrinking a struct from 24 → 16 bytes can therefore drop it into a smaller size class and save real memory. The GC tracks pointers via per-type **pointer bitmaps**; a struct with no pointers is marked `noscan` and the GC skips it entirely during marking — a major reason to prefer value fields over pointer fields when feasible.

## 4. Syntax

There is no special keyword for memory optimization — it is field arrangement plus measurement APIs.

```go
import (
	"fmt"
	"unsafe"
)

type Event struct {
	Timestamp int64   // 8, align 8
	UserID    int64   // 8, align 8
	Score     float32 // 4, align 4
	Kind      uint16  // 2, align 2
	Flags     uint8   // 1
	Active    bool    // 1
} // packed: 24 bytes, no interior padding

func main() {
	fmt.Println(unsafe.Sizeof(Event{}))         // 24
	fmt.Println(unsafe.Alignof(Event{}))        // 8
	fmt.Println(unsafe.Offsetof(Event{}.Score)) // 16
}
```

`unsafe.Sizeof`, `unsafe.Alignof`, and `unsafe.Offsetof` are compile-time constants — they cost nothing at runtime and are the canonical way to inspect layout.

## 5. Common Interview Questions

**Q1. Why does Go insert padding into structs?**
To satisfy hardware alignment: a CPU loads an 8-byte value most efficiently (sometimes only correctly) when it sits on an 8-byte boundary. The compiler pads earlier fields so later ones land on aligned offsets.
*Follow-up: Does Go reorder fields to minimize padding?* No. Go preserves source order; you must reorder manually. (Linters like `fieldalignment` flag this.)

**Q2. How do you minimize struct size?**
Order fields from largest to smallest alignment, group same-size fields, and put `bool`/`byte` fields together at the end. Verify with `unsafe.Sizeof`.
*Follow-up: When is the savings irrelevant?* When you only ever hold a handful of instances — padding on a singleton config struct is noise. It matters at scale (slices/maps of millions).

**Q3. What is a "working set" and why does it matter?**
The set of memory a program actively touches over a time window. If it fits in cache, accesses are ~1–10 ns; if it spills to RAM, ~100 ns. Shrinking structs keeps more useful data resident.
*Follow-up: How would you measure it?* `perf stat` for cache-miss rate, or benchmark throughput as you vary data size and watch the cliff where it exceeds L2/L3.

**Q4. Value field vs pointer field — memory impact?**
A pointer field is 8 bytes plus a separate heap allocation it points to, and it makes the struct `scan`-able by GC. An embedded value avoids the indirection and extra allocation and can keep the struct `noscan`.
*Follow-up: When prefer a pointer anyway?* For large optional fields, shared/mutable state, or to break a recursive type.

**Q5. What is false sharing and how do you fix it?**
When two goroutines write different variables that share a 64-byte cache line, the cores ping-pong the line, killing throughput. Fix by padding hot per-goroutine fields to 64 bytes so they sit on separate lines.
*Follow-up: Show the padding.* Add `_ [64]byte` (or `cpu.CacheLinePad`) between contended fields.

**Q6. How does struct layout interact with the GC?**
A struct with zero pointer fields is marked `noscan`; the GC never scans it. Adding even one pointer flips it to `scan`, increasing mark cost. Replacing `*T`/`string`/`[]T`/`map`/`interface` fields with pointer-free equivalents (indices, fixed arrays) can make whole arenas `noscan`.
*Follow-up: Is `[16]byte` pointer-free?* Yes — fixed arrays of non-pointer types are scan-free; that's why some code stores IDs as `[16]byte` instead of `string`.

**Q7. Why might shrinking a struct by 1 byte not save any memory?**
Allocations snap to size classes. 17 and 24 bytes both land in the 24-byte class. You only save when the change crosses a class boundary.

## 6. Production Use Cases

- **Time-series / observability (Prometheus, VictoriaMetrics, M3DB):** samples are stored as tight structs (timestamp + value). Packing them and using columnar `[]float64` / `[]int64` layouts keeps millions of points cache-resident during scrape and query.
- **Trading / low-latency systems:** order-book entries are field-ordered and often padded to whole cache lines; per-core counters are cache-line padded to avoid false sharing.
- **Game servers & ECS engines:** Entity-Component-System designs store components in contiguous, pointer-free arrays (Structure-of-Arrays) so iteration is a linear cache-friendly sweep.
- **Kubernetes / etcd:** hot-path object caches keep frequently-read metadata in compact forms; large optional fields are kept behind pointers so the common object stays small.
- **Databases (CockroachDB, TiDB):** row encoders pack fixed-width columns and use `sync.Pool` for per-request buffers to cut allocation churn.
- **High-throughput networking (Cloudflare, fasthttp):** connection state structs are minimized and pooled to keep per-connection memory tiny across millions of connections.

## 7. Common Mistakes

> [!WARNING]
> Optimizing layout *before* profiling. Most structs are not hot. Reordering a config struct read once at startup wastes review time and can hurt readability. Profile first.

- **Trusting source-order readability over size on hot types** — and never measuring with `unsafe.Sizeof`.
- **Adding pointer fields casually**, flipping a `noscan` struct to `scan` and inflating GC cost across a huge slice.
- **Using `string` for fixed-width IDs** (UUIDs) — each `string` is a 16-byte header *plus* a heap-backed body and a GC pointer; `[16]byte` is pointer-free and inline.
- **Ignoring size classes** — shrinking 40→36 bytes when both round to 48 buys nothing.
- **Over-padding for false sharing where there is no contention**, wasting memory and cache.
- **Embedding large arrays by value in maps/slices that get copied frequently**, turning a layout win into a copy cost.

## 8. Performance Considerations

The dominant cost on hot paths is **cache misses**, not instruction count. A 64-byte cache line holds 8 `int64`s. If your struct is 48 bytes, you get one struct per ~line; if it's 16 bytes, you get four. Iterating a `[]T` of small structs is therefore dramatically faster.

Trade-offs to weigh:

| Technique | Saves | Costs |
|---|---|---|
| Field reordering | padding, size class | none (rare readability hit) |
| Value over pointer | indirection, GC scan, alloc | larger inline value, copy cost |
| `[N]byte` over `string` | heap alloc, GC pointer | fixed max length, conversion |
| Struct-of-Arrays | cache locality on partial scans | clumsy API, harder updates |
| `sync.Pool` | alloc/GC churn | complexity, must reset objects |
| Cache-line padding | false-sharing stalls | wasted bytes |

> [!TIP]
> Measure with `go test -bench . -benchmem`. Watch `allocs/op` and `B/op`, then confirm wall-time wins. A smaller struct that doesn't change the benchmark is not worth the churn.

## 9. Best Practices

- **Profile before you optimize.** Use `pprof` heap and CPU profiles to find the actually-hot, actually-large types.
- **Order fields largest-alignment-first** on hot structs; enable the `fieldalignment` analyzer (via `go vet -vettool` or `gopls`) in CI for hot packages.
- **Keep hot structs `noscan`** by preferring indices, fixed arrays, and value fields over pointers/strings/slices where practical.
- **Use `sync.Pool`** for short-lived, frequently-allocated buffers on hot paths — reset before reuse.
- **Prefer Struct-of-Arrays** when loops touch only a subset of fields over millions of elements.
- **Document why** a struct is laid out unusually (a comment saving future readers from "fixing" your ordering).
- **Re-measure after Go upgrades** — allocator size classes and escape analysis evolve.

## 10. Code Examples

Primary: reorder a struct and measure the win, with a `fieldalignment`-clean version as the alternative tab.

```go
package layout

import "unsafe"

// Bad: 24 bytes (interior + tail padding)
type Bad struct {
	A bool  // 1 + 7 pad
	B int64 // 8
	C bool  // 1 + 7 pad
}

func BadSize() uintptr { return unsafe.Sizeof(Bad{}) } // 24
```

```go
package layout

import "unsafe"

// Good: 16 bytes (largest-first, bools grouped)
type Good struct {
	B int64 // 8
	A bool  // 1
	C bool  // 1 + 6 tail pad
}

func GoodSize() uintptr { return unsafe.Sizeof(Good{}) } // 16
```

Below is a separate, standalone example: cache-line padding to defeat false sharing in per-core counters.

```go
package counters

import "sync/atomic"

const cacheLine = 64

// Each counter sits alone on its own cache line.
type paddedCounter struct {
	n atomic.Uint64
	_ [cacheLine - 8]byte // pad to 64 bytes
}

type Sharded struct {
	cells [16]paddedCounter
}

func (s *Sharded) Inc(shard int) { s.cells[shard&15].n.Add(1) }

func (s *Sharded) Sum() uint64 {
	var total uint64
	for i := range s.cells {
		total += s.cells[i].n.Load()
	}
	return total
}
```

And a `noscan` optimization: storing fixed-width IDs without heap pointers.

```go
package ids

// Heavy: string header (16B) + heap body + GC pointer -> struct is scanned.
type RecordSlow struct {
	ID    string
	Score int64
}

// Lean: [16]byte is inline and pointer-free -> whole []RecordFast is noscan.
type RecordFast struct {
	ID    [16]byte
	Score int64
}
```

## 11. Advanced Concepts

**Structure-of-Arrays (SoA) vs Array-of-Structures (AoS).** AoS `[]struct{X,Y,Z}` interleaves fields; a loop reading only `X` still pulls `Y` and `Z` into cache. SoA stores `Xs []float64; Ys []float64; Zs []float64` so a scan over one field is perfectly dense. This is the foundation of columnar databases and ECS game engines and can be a 3–10x speedup on partial-field scans.

**Empty struct `struct{}`.** Zero bytes. `map[K]struct{}` is the idiomatic set; the value occupies no memory. The runtime hands out a shared `zerobase` pointer for zero-size allocations.

**Field alignment of nested structs and arrays.** A struct's alignment propagates: embedding `struct{ x int64 }` forces 8-byte alignment on the outer struct too. Arrays inherit element alignment and size, so `[3]Bad` is `3 * 24` bytes — padding multiplies.

**Escape analysis interplay.** Shrinking a struct can let it stay on the stack (the compiler is more willing to stack-allocate small values), eliminating the heap allocation and GC tracking entirely. Check with `go build -gcflags=-m`.

**`golang.org/x/sys/cpu.CacheLinePad`** is the portable, maintained way to get a cache-line-sized pad rather than hardcoding 64.

## 12. Debugging Tips

- **Inspect layout:** `unsafe.Sizeof/Alignof/Offsetof` print exact bytes; they're compile-time constants.
- **Find padding automatically:** `fieldalignment ./...` (from `golang.org/x/tools/go/analysis/passes/fieldalignment`) reports structs that could shrink and can auto-fix with `-fix`.
- **Heap profiling:** `go test -memprofile mem.out`, then `go tool pprof -alloc_space mem.out` and `top`/`list` to find the fattest allocations.
- **Allocation count:** `go test -bench . -benchmem` shows `B/op` and `allocs/op`.
- **Cache misses:** on Linux, `perf stat -e cache-misses,cache-references ./bench` quantifies locality wins.
- **Escape decisions:** `go build -gcflags='-m -m'` shows what escapes to the heap and why.
- **GC scan cost:** `GODEBUG=gctrace=1` reveals mark-phase duration; dropping pointers from hot types shrinks it.

## 13. Senior Engineer Notes

A senior engineer's job here is *judgement and restraint*. The first instinct in review should be "is this struct actually hot?" — and the answer comes from a profile, not intuition. Reordering fields on a type instantiated millions of times in a tight loop is a clean win you should request in review; reordering a startup-config struct is bikeshedding that hurts readability.

When mentoring, teach the mental model (alignment → padding → size class → cache line → GC scan) rather than the trick, so juniors can reason about *new* structs instead of memorizing "biggest first." Encourage `unsafe.Sizeof` in tests as a regression guard: a test asserting `Sizeof(Event{}) == 24` catches the day someone appends a `string` field and silently doubles the type's footprint and flips it to `scan`.

In code review, watch for the silent killers: a new `string`/`[]byte`/`*T` field on a hot type (GC scan regression), an `interface{}`/`any` field that boxes and allocates, and large value fields embedded in frequently-copied structs. Insist on benchmarks with `-benchmem` for any change claimed to be a memory optimization — "it should be faster" is not evidence.

## 14. Staff Engineer Notes

At staff level the questions become architectural and organizational. Should the data even live in Go's heap? For truly enormous working sets, the right answer may be an off-heap arena, a memory-mapped file, or pushing the data into a columnar store — a **build-vs-buy** decision that trades engineering complexity against using VictoriaMetrics/ClickHouse instead of hand-rolling SoA. Staff engineers frame these trade-offs with capacity math: bytes-per-record × records × headroom vs. instance memory and GC CPU budget.

Cross-team, the layout of a *shared* type (a protobuf-generated struct, a domain entity used by ten services) is a contract. Optimizing it touches everyone, so the staff move is to isolate hot internal representations behind an API boundary: keep the ergonomic public type and convert to a packed internal one only on the hot path, so other teams are unaffected.

Org-level, staff engineers set guardrails: a `fieldalignment` and `-benchmem` gate in CI for designated hot packages; a documented policy that hot types stay `noscan`; and dashboards tracking GC CPU and allocation rate so layout regressions show up as trend lines, not surprises in an incident. They also know when *not* to invest — most services are I/O-bound, and pouring staff time into struct packing for a service whose bottleneck is a database round-trip is a misallocation they should redirect.

## 15. Revision Summary

- **Two scales:** micro = struct layout/padding/alignment; macro = working set fitting in cache.
- **Alignment:** fields align to their size (int64→8, int32→4); Go inserts padding and never reorders for you.
- **Rule:** order fields **largest alignment first**, group bools/bytes at the end → minimal padding.
- **Size classes:** allocations round up (~70 classes); savings only count when you cross a boundary.
- **GC:** pointer-free structs are `noscan` and skipped during marking; prefer `[N]byte`/indices over `string`/`*T`/slices on hot types.
- **Cache:** 64-byte lines; smaller structs = more per line = fewer misses; pad to 64B to kill false sharing.
- **SoA vs AoS:** columnar layout wins big on partial-field scans.
- **Tools:** `unsafe.Sizeof/Alignof/Offsetof`, `fieldalignment`, `pprof`, `-benchmem`, `gcflags=-m`, `perf`, `GODEBUG=gctrace=1`.
- **Discipline:** profile first; optimize only hot, large, numerous types.

**References:** Go performance ([go.dev/doc/diagnostics](https://go.dev/doc/diagnostics)), `golang.org/x/tools` fieldalignment analyzer, `golang.org/x/sys/cpu` CacheLinePad, Go runtime size-class and GC source (`runtime/sizeclasses.go`, `runtime/mbitmap.go`).

---
*Go Engineering Handbook — topic 58.*
