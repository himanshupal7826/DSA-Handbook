# 52 · Memory Allocation

> **In one line:** Go's allocator is a per-P, lock-free-on-the-fast-path, tiered system (mcache → mcentral → mheap) that carves the heap into size-class spans and routes tiny, small, and large objects through different paths to minimize contention and fragmentation.

---

## 1. Overview

When you write `x := &T{}` or `s := make([]byte, 64)` and the value escapes to the heap, the Go runtime must find memory for it. It does *not* call `malloc` per object. Instead, Go ships a custom allocator modeled on Google's TCMalloc (thread-caching malloc), adapted for goroutines, `P`s (logical processors), and a precise garbage collector.

The design has three goals: **speed** (most allocations should touch no lock), **low fragmentation** (group same-size objects together), and **GC cooperation** (the allocator and collector share metadata about which words are pointers).

The allocator is tiered:

- **mcache** — a per-P cache. The fast path. No lock needed because each `P` owns its cache.
- **mcentral** — a per-size-class central list shared across all `P`s. Mutex-protected. Refills mcaches.
- **mheap** — the global heap. Manages *spans* (runs of pages), satisfies large allocations, and requests memory from the OS.

Objects are bucketed by **size class** (~68 classes from 8 bytes up to 32 KiB). Anything larger goes straight to the mheap. The smallest objects (< 16 bytes, no pointers) go through a special **tiny allocator** that sub-divides a single 16-byte block.

Keywords you'll see throughout: **allocator**, **mcache**, **size class**, **mheap**, **span**.

## 2. Why It Exists

A naive `malloc`/`free` per object would be catastrophic for Go because:

1. **Concurrency.** Go programs run thousands of goroutines across many OS threads. A single global heap lock would serialize allocation and destroy scalability. Per-P caches make the common case lock-free.
2. **GC needs structure.** A precise, concurrent garbage collector must know, for every live object, where its pointers are. Grouping objects of the same size class into spans lets the runtime store one bitmap per span instead of a header per object. This makes heap scanning cache-friendly and predictable.
3. **Fragmentation control.** General-purpose allocators suffer external fragmentation from variable-size requests. By rounding every allocation up to a fixed size class, Go bounds internal fragmentation (≤ ~12.5% worst case in the small range) and eliminates external fragmentation within a span.
4. **No header overhead.** Because size is implied by the span, individual objects carry no allocation header — important when you allocate billions of small objects.

In short: the allocator exists to make `new`/`make` cheap under massive concurrency *and* to give the GC the metadata it needs cheaply.

## 3. Internal Working

### Size classes and spans

A **span** (`runtime.mspan`) is a contiguous run of 8 KiB pages dedicated to a single size class. If the size class is 64 bytes and the span is one page (8 KiB), the span holds 128 objects. The span tracks free slots with an `allocBits` bitmap and a `freeindex` cursor.

There are roughly 68 size classes. The mapping from request size to class is precomputed in `runtime.class_to_size` and `runtime.size_to_class*` lookup tables, so sizing is a couple of array reads, not a loop.

### The three tiers

```text
  goroutine (running on P)
        │  mallocgc(size, type, needzero)
        ▼
 ┌───────────────┐   fast path, NO LOCK
 │    mcache      │  per-P; array of mspan* indexed by (sizeclass, scan/noscan)
 │  alloc[numSpanClasses]
 └──────┬─────────┘
        │ span empty? refill
        ▼
 ┌───────────────┐   per-size-class, MUTEX
 │   mcentral     │  partial+full span lists (now backed by spanSet)
 └──────┬─────────┘
        │ no spans? grow
        ▼
 ┌───────────────┐   global, LOCK (heap)
 │    mheap       │  page allocator (radix tree), free spans, OS mmap
 └──────┬─────────┘
        │ out of pages?
        ▼
   OS: mmap / VirtualAlloc  (arenas, 64 MiB on 64-bit)
```

### The allocation decision tree (`mallocgc`)

```text
size == 0                  → return zerobase (shared sentinel)
size <= 16 && noscan       → TINY allocator (sub-allocate from 16B block)
size <= 32768 (32 KiB)     → SMALL: pick size class → mcache span
size  > 32768              → LARGE: allocate span directly from mheap
```

**Tiny path.** The mcache holds a `tiny` pointer and `tinyoffset`. Objects that are small (≤ 16 B) and contain no pointers (`noscan`) are packed into a single 16-byte block, aligned to their size. A `bool`, a small `struct{}` with two ints, the backing for `[]byte("ok")` — many land here, several sharing one 16-byte slot. This dramatically cuts allocation count for string/byte churn.

**Small path.** Compute span class = `sizeclass<<1 | noscanBit`. Index into `mcache.alloc[spanClass]`. Pop the next free slot using `nextFreeFast` (just bit-twiddling on `allocCache`). If the span is full, call `refill` → grab a span from the mcentral; if the mcentral is empty, `grow` from the mheap.

**Large path.** No caching. `mheap.alloc` finds enough contiguous pages via the page allocator (a radix-tree bitmap, `mheap.pages`), possibly mmap-ing a new 64 MiB arena.

### Scan vs noscan

Every size class is duplicated into **scan** (contains pointers) and **noscan** (pure data) variants. The GC only scans spans that may contain pointers. A `[]byte` lives in a noscan span and is never traversed for pointers — a major win for binary-heavy workloads.

### Zeroing

Newly mapped memory from the OS is already zero. Reused spans may be dirty, so `mallocgc` zeroes the slot unless the caller passes `needzero == false` (used internally when the code is about to overwrite everything, e.g. `growslice`).

## 4. Syntax

There is no allocator API you call directly — it's invoked implicitly. The "syntax" is the set of operations the compiler lowers into allocator calls.

```go
p := new(T)                 // → runtime.newobject → mallocgc
s := make([]int, 0, 1024)   // → runtime.makeslice → mallocgc
m := make(map[string]int)   // → runtime.makemap (buckets via mallocgc)
c := make(chan int, 8)      // → runtime.makechan → mallocgc
x := &Big{}                 // heap if it escapes; stack if not
b := []byte("hello")        // may use tiny allocator
```

Whether something is allocated at all depends on **escape analysis** (`go build -gcflags='-m'`). If a value does not escape, it lives on the goroutine stack and the allocator is never touched.

## 5. Common Interview Questions

**Q1. Walk me through what happens when I allocate a 50-byte struct that escapes.**
*Answer:* 50 rounds up to the 64-byte size class. The runtime computes the span class (with the scan bit set if the struct has pointers), indexes `mcache.alloc[spanClass]`, and pops a free slot via `nextFreeFast`. No lock. If that span is full, the mcache refills from the mcentral for size class 64 (under a mutex), which may grow from the mheap.
*Follow-up: why round up instead of allocating exactly 50?* Fixed size classes eliminate external fragmentation and let the GC store one bitmap per span instead of per-object headers.

**Q2. What is the tiny allocator and when does it kick in?**
*Answer:* For objects ≤ 16 bytes with **no pointers**. The mcache sub-allocates them out of a single 16-byte block via `tinyoffset`, packing multiple objects together. It targets small strings/byte slices and tiny structs.
*Follow-up: why must the object be pointer-free?* Mixed pointer/non-pointer packing inside one block would break the per-span pointer bitmap that the GC relies on.

**Q3. Why is the fast path lock-free?**
*Answer:* The mcache is owned by a single `P`, and a goroutine holds its `P` while running. Only one goroutine touches a given mcache at a time, so no synchronization is needed until a refill reaches the shared mcentral.
*Follow-up: what happens on a `GOMAXPROCS` change?* mcaches are reassigned/released with `P`s; freed spans flush back to their mcentral.

**Q4. Small vs large objects — where's the boundary and why does it matter?**
*Answer:* 32 KiB. ≤ 32 KiB is "small" and cached per-P. > 32 KiB ("large") is allocated directly from the mheap with no caching, so each large allocation takes the heap lock.
*Follow-up: implication for a buffer pool?* Buffers > 32 KiB hit the global lock every time, so pooling (`sync.Pool`) pays off most for large buffers.

**Q5. How does the allocator help the garbage collector?**
*Answer:* Same-size objects share a span with a single pointer bitmap; noscan spans are skipped entirely; spans give the sweeper a natural unit of work and let it reclaim free slots without moving objects.
*Follow-up: is Go's GC compacting?* No — it's a non-moving, concurrent mark-sweep. The size-class/span design is what keeps fragmentation acceptable without compaction.

**Q6. What's a span class vs a size class?**
*Answer:* A size class is the rounded size bucket (e.g. 64 B). A span class encodes both the size class *and* the scan/noscan bit: `spanClass = sizeclass<<1 | noscanBit`. The mcache is indexed by span class.
*Follow-up: how many span classes?* `2 × numSizeClasses` (~134).

**Q7. Where does memory come from when the heap grows?**
*Answer:* The mheap requests memory from the OS in large **arenas** (64 MiB on 64-bit Linux) via `mmap`, then carves spans out of those pages using a radix-tree page allocator.
*Follow-up: does Go return memory to the OS?* Yes, lazily — the scavenger marks unused pages with `madvise(MADV_FREE/DONTNEED)`, controlled partly by `GODEBUG=madvdontneed` and `GOMEMLIMIT`/`debug.FreeOSMemory`.

## 6. Production Use Cases

- **High-throughput RPC servers (gRPC at Google, Uber, etc.).** Per-request decoding allocates millions of small messages; the per-P mcache and tiny allocator keep this lock-free, while `sync.Pool` recycles larger framing buffers.
- **JSON/Protobuf-heavy APIs.** `encoding/json` and protobuf unmarshalling are allocation factories. Teams profile size-class distribution (`runtime.MemStats.BySize`) to decide where pooling helps.
- **Database drivers and caches (e.g. groupcache, BigCache, Ristretto).** BigCache deliberately stores entries in large `[]byte` shards to keep millions of items *off* the GC'd heap as individual objects — directly exploiting how the allocator + GC scale with object count.
- **Networking / proxies (Cloudflare, fasthttp).** `fasthttp` famously avoids per-request allocation precisely because the allocator path, while fast, is not free at millions of req/s.
- **Stream processors / log pipelines.** Reusing `[]byte` buffers via `sync.Pool` to dodge repeated large-span allocations through the mheap lock.

## 7. Common Mistakes

> [!WARNING]
> Most "allocator problems" are really *escape-analysis* problems. The fix is usually to stop heap-allocating, not to tune the allocator.

- **Assuming `make([]T, n)` is on the stack.** If it escapes (returned, stored in an interface, captured by a closure that escapes), it's a heap allocation — possibly a large one.
- **Boxing into `interface{}` / `any`.** Putting an `int` into an `any` forces a heap allocation (except small cached integers). Hot loops that log via `...any` allocate constantly.
- **Misusing `sync.Pool` for small objects.** Pool overhead can exceed the cost of just allocating an 8–64 B object from the mcache. Pool large/expensive things.
- **Pre-allocating wrong.** `make([]T, 0, cap)` only helps if you actually fill it; over-allocating wastes whole spans.
- **Storing pointers in otherwise-pure data.** A single pointer field flips a struct from noscan to scan, adding GC scan cost to every instance.

## 8. Performance Considerations

| Path | Cost (rough) | Lock | Notes |
|------|-------------|------|-------|
| Tiny (≤16 B, noscan) | ~ a few ns | none | packs into shared 16 B block |
| Small (≤32 KiB) fast | ~ a few–tens ns | none | mcache hit |
| Small, refill | + mutex | mcentral | amortized over many allocs |
| Large (>32 KiB) | hundreds ns+ | mheap | direct page alloc, may mmap |

Key levers:

- **Object count, not just bytes, drives GC.** A million 16 B objects cost more GC scan work than a few large buffers of the same total size. Consolidate.
- **`GOGC`** trades heap headroom for GC frequency (default 100 = let heap double before collecting).
- **`GOMEMLIMIT`** (Go 1.19+) sets a soft total memory ceiling; the GC runs harder as you approach it — invaluable in containers.
- **`GOMAXPROCS`** sets the number of `P`s and therefore the number of mcaches; raising it costs cache memory.

> [!TIP]
> Profile before tuning. `go test -bench . -benchmem` reports `allocs/op` and `B/op` — driving `allocs/op` toward zero on hot paths usually beats any runtime knob.

## 9. Best Practices

- **Reduce allocations first** (escape analysis, reuse, value receivers) before touching `GOGC`/`GOMEMLIMIT`.
- **Pre-size slices and maps** with realistic capacities to avoid repeated `growslice`/rehash allocations.
- **Use `sync.Pool` for large, reusable buffers** (≥ a few KiB) on hot paths; benchmark to confirm it wins.
- **Keep pointer-free structs pointer-free** so they stay in noscan spans (e.g. store offsets/indices instead of pointers in big arrays).
- **Set `GOMEMLIMIT` in containers** to a value below the cgroup limit to avoid OOM kills.
- **Batch large allocations** rather than many medium ones to reduce mheap-lock traffic.

## 10. Code Examples

Primary: measuring where allocations go and confirming escape decisions.

```go
package main

import (
	"fmt"
	"runtime"
)

type Point struct{ X, Y int } // pointer-free → noscan span

func main() {
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)

	// 1e6 small, pointer-free structs: small/tiny path, noscan spans.
	pts := make([]*Point, 1_000_000)
	for i := range pts {
		pts[i] = &Point{X: i, Y: -i}
	}

	runtime.ReadMemStats(&after)
	fmt.Printf("heap objects added: %d\n", after.HeapObjects-before.HeapObjects)
	fmt.Printf("bytes allocated:    %d\n", after.TotalAlloc-before.TotalAlloc)

	// Per-size-class breakdown:
	for i, b := range after.BySize {
		if d := b.Mallocs - before.BySize[i].Mallocs; d > 0 {
			fmt.Printf("size class %5d B: %d mallocs\n", b.Size, d)
		}
	}
	runtime.KeepAlive(pts)
}
```

Alternative: avoiding the allocator entirely by pooling large buffers.

```go
package main

import (
	"sync"
)

// 64 KiB buffers are LARGE objects (>32 KiB): every fresh make() would
// take the mheap lock. Pooling routes reuse through the per-P pool cache.
var bufPool = sync.Pool{
	New: func() any {
		b := make([]byte, 64*1024)
		return &b // pointer-typed value avoids per-Get interface allocation
	},
}

func handle(payload []byte) int {
	bp := bufPool.Get().(*[]byte)
	buf := *bp
	defer bufPool.Put(bp)

	n := copy(buf, payload)
	// ... process buf[:n] ...
	return n
}
```

Run escape analysis to see allocator decisions: `go build -gcflags='-m -l' ./...`. Lines like `&Point{...} escapes to heap` tell you exactly what hits `mallocgc`.

## 11. Advanced Concepts

- **spanSet and lock-free central lists.** Modern Go (1.14+) replaced the mcentral's mutex-guarded linked lists with `spanSet`, a lock-free-ish stack of span blocks, cutting refill contention on many-core machines.
- **The page allocator.** `mheap.pages` is a radix tree of summary bitmaps (`pallocBits`) enabling fast first-fit search for runs of free pages across the whole address space — replacing the old treap.
- **Arenas and address-space reservation.** On 64-bit, Go reserves a huge contiguous virtual range and maps 64 MiB arenas on demand. Each arena has a `heapArena` metadata block (pointer bitmaps, span lookup) so the GC can map any address back to its span in O(1).
- **`arena` experiment (`GOEXPERIMENT=arenas`).** A region-based manual allocator for request-scoped data that's freed all at once, bypassing GC — used in some Google services to cut GC pressure. Still experimental/unsupported as a public API.
- **noscan optimization depth.** The compiler computes a GC pointer bitmap per type; `mallocgc` uses it to choose the scan/noscan span class. Reducing pointers in hot types is one of the highest-leverage allocator optimizations.
- **`mallocgc` and GC assist.** Allocation isn't purely "take a slot": if the GC is running and you're allocating fast, the allocator makes the goroutine do **assist** work (mark debt) to keep the collector from falling behind.

## 12. Debugging Tips

```text
go test -bench=. -benchmem        # B/op and allocs/op per benchmark
go build -gcflags='-m -l'         # escape analysis (-l disables inlining noise)
go tool pprof -alloc_objects ...  # WHERE objects are allocated (count)
go tool pprof -alloc_space  ...   # WHERE bytes are allocated
GODEBUG=allocfreetrace=1          # trace every alloc/free (very verbose)
GODEBUG=gctrace=1                 # per-GC heap size, pause, goal
GODEBUG=scavtrace=1               # scavenger returning memory to OS
runtime.ReadMemStats / BySize     # live size-class distribution
```

> [!NOTE]
> `-alloc_objects` vs `-alloc_space`: a function topping the *objects* profile but not the *space* profile is your tiny/small-allocation hotspot — exactly what stresses the mcache and the GC's object count. Attack object count there.

War story pattern: a service shows high GC CPU but moderate heap bytes. Cause is almost always **too many small objects** (high `HeapObjects`). The `BySize` table reveals the offending size class; the alloc-objects profile names the call site.

## 13. Senior Engineer Notes

As a senior engineer your value is *code- and design-level judgement*:

- **Read profiles, not vibes.** Require `-benchmem` numbers in PRs that claim performance wins. "Feels faster" is not a metric; `allocs/op: 7 → 0` is.
- **Review for escape hazards.** In code review, flag returning pointers to locals, stuffing values into `any`, and unnecessary `*T` receivers that force heap escapes. Teach *why* (escape analysis), not just *what*.
- **Right-size data structures.** Push for offset/index-based designs in large collections to keep spans noscan. Coach teammates that a single pointer field has GC cost multiplied across every instance.
- **Don't reach for `sync.Pool` reflexively.** Mentor the team that pooling tiny objects often loses; demand a benchmark proving the pool beats the mcache.
- **Know when to stop.** Once a hot path is at zero allocs/op, further micro-tuning of `GOGC` is usually noise. Redirect effort to bigger wins.

## 14. Staff Engineer Notes

At staff level the concerns are *architectural and organizational*:

- **Set memory contracts across services.** Standardize `GOMEMLIMIT` (below the cgroup limit) and `GOGC` as part of the platform's deployment templates so individual teams don't rediscover OOM-kill pain. This is a fleet-wide reliability lever.
- **Design for object-count scaling, not just byte budgets.** When architecting caches/ingestion pipelines, favor designs (sharded `[]byte` arenas, columnar buffers, off-heap stores) that keep `HeapObjects` flat as load grows — the allocator and GC scale with *count*. This is the BigCache/Ristretto insight applied at design time.
- **Build-vs-buy on allocation avoidance.** Decide org-wide whether to invest in code generation (e.g. allocation-free protobuf codecs, `easyjson`) versus accepting standard-library allocation cost. Quantify the GC-CPU savings against maintenance burden before mandating it.
- **Evaluate experimental features deliberately.** `GOEXPERIMENT=arenas` or off-heap stores can slash GC cost for request-scoped data, but they trade memory safety/portability and tie you to runtime internals. That's a cross-team bet to make with eyes open, with a fallback plan.
- **Capacity planning is allocator-aware.** Mcaches scale with `GOMAXPROCS`; arenas reserve large virtual ranges. When sizing containers and choosing CPU/memory ratios, account for runtime overhead, not just app working set.

## 15. Revision Summary

- Go's allocator is TCMalloc-style: **mcache** (per-P, no lock) → **mcentral** (per-size-class, mutex/spanSet) → **mheap** (global, pages, OS arenas).
- Objects bucket into ~68 **size classes**; each duplicated into **scan/noscan** span classes (`sizeclass<<1 | noscanBit`).
- A **span** is a run of 8 KiB pages for one size class, with a per-span pointer bitmap (cheap GC scanning, no per-object header).
- **Tiny allocator:** objects ≤ 16 B and pointer-free are packed into a shared 16 B block in the mcache.
- Decision tree: `0 → zerobase`; `≤16 B noscan → tiny`; `≤32 KiB → small (mcache)`; `>32 KiB → large (mheap, locked)`.
- Whether you allocate at all is decided by **escape analysis** — fix allocation problems there first.
- **GC scales with object count**, not just bytes; keep structs pointer-free; pool large buffers, not tiny ones.
- Knobs: `GOGC`, `GOMEMLIMIT`, `GOMAXPROCS`. Tools: `-benchmem`, `-gcflags=-m`, pprof `-alloc_objects/-alloc_space`, `GODEBUG=gctrace/scavtrace`.

**References:** Go runtime: `malloc.go` (`runtime/malloc.go`, `mcache.go`, `mcentral.go`, `mheap.go`, `sizeclasses.go`); Go GC guide; TCMalloc design notes.

---

*Go Engineering Handbook — topic 52.*
