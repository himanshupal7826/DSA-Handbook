# 50 · Heap vs Stack

> **In one line:** Go gives each goroutine a tiny growable stack and lets the compiler's escape analysis decide what lives there versus on the garbage-collected heap.

---

## 1. Overview

Every value your Go program creates lives in one of two places: the **stack** or the **heap**. The stack is fast, cheap, and automatically reclaimed when a function returns. The heap is flexible, shared, and managed by the garbage collector (GC) — which costs CPU cycles and adds pause pressure.

What makes Go distinctive is that *you do not choose*. Unlike C/C++ (`malloc`/`new` vs locals) or Java (almost everything on the heap), Go's compiler performs **escape analysis** at compile time to decide, per allocation, whether a value can safely live on the stack. If it can, you pay essentially nothing. If it "escapes," it goes to the heap and becomes the GC's problem.

Each goroutine gets its own stack — initially a mere **8 KB** — and that stack can **grow and shrink** on demand. This is the secret that lets Go run millions of goroutines on a single machine without pre-reserving megabytes per thread.

Understanding heap vs stack is the difference between code that allocates 0 times per request and code that allocates 40 times and stalls under load. It is the single highest-leverage performance lens in Go.

## 2. Why It Exists

The design exists to reconcile two goals that are normally in tension:

1. **Cheap concurrency.** A traditional OS thread reserves a fixed, large stack (often 1–8 MB). Spawning a million of them would need terabytes of address space. Go wanted goroutines to be nearly free, so each starts with a *small* stack and grows only if needed.

2. **Safety without manual memory management.** C lets you allocate on the stack for speed but punishes you with dangling pointers and use-after-free. Go wants the speed of stack allocation but the safety of GC. Escape analysis delivers both: the compiler proves when a value's lifetime is bounded by its function, allocates it on the stack, and falls back to the heap (safe but slower) when it cannot prove that.

> [!NOTE]
> The contract is: **you never get a dangling pointer in safe Go.** If a local's address outlives its frame, the compiler *forces* it to the heap. Correctness always wins; performance is the optimization layered on top.

The heap exists because some lifetimes genuinely outlive a single function call — returned pointers, values stored in long-lived structures, data shared across goroutines. The stack exists because most values *don't*, and reclaiming them by simply moving a pointer is orders of magnitude cheaper than tracing garbage.

## 3. Internal Working

**Stack layout.** A goroutine's stack is a contiguous region of memory. The runtime tracks it via the `g` (goroutine) struct, which holds `stack.lo` and `stack.hi` (the bounds) and `stackguard0` (the growth trip-wire). On entry, most functions execute a **stack bounds check** the compiler inserts: if the stack pointer would dip below `stackguard0`, the function calls `runtime.morestack`.

```text
 goroutine.stack
 hi ─► +------------------+  high addresses
       |  caller frame    |
       +------------------+
       |  args / return   |
       +------------------+
       |  current frame   |  <- SP (stack pointer)
       |   locals...      |
       +------------------+
       |   (free space)   |
 lo ─► +------------------+  <- stackguard0 near here
            |
            v  grows downward; when SP nears guard => morestack
```

**Growable (copying) stacks.** When `morestack` fires, the runtime allocates a *new, larger* stack (typically doubling, e.g. 8 KB → 16 KB), then **copies** the entire old stack into it and rewrites every pointer that referenced the old stack (it knows the layout from pointer maps and stack maps emitted by the compiler). Because Go stacks are *movable*, you can never make a stable C-style address assumption across a growth — the runtime fixes everything up. Stacks can also *shrink* during GC if they're mostly unused.

This is why Go uses **contiguous, copying stacks** today. Pre-Go 1.3 it used *segmented* "stack splitting," which caused the infamous "hot split" problem: a function on a segment boundary called in a loop would repeatedly allocate/free a segment, tanking performance. Copying stacks eliminated that.

**Escape analysis.** During compilation, the SSA backend builds a graph of how pointers flow. A value escapes when the compiler cannot prove its address stays within the frame. Classic escape triggers:

- Returning a pointer to a local.
- Storing a pointer into a heap object or a global.
- Sending a pointer over a channel or capturing it in a goroutine closure.
- Assigning to an `interface{}` whose value the compiler can't track (interface conversion often boxes).
- Allocation of unknown/dynamic size (e.g. `make([]T, n)` with large/non-constant `n`).

The output is `runtime.newobject`/`runtime.makeslice` calls for heap allocations; stack allocations are just SP arithmetic with zero runtime cost.

## 4. Syntax

There is no keyword for "stack" or "heap" — placement is implicit. The relevant *tooling* syntax is the compiler flag:

```go
// Reveal allocation decisions. -m once for basics, -m -m for reasoning.
//   go build -gcflags='-m' ./...
//   go build -gcflags='-m -m' ./...

func stackAlloc() int {
	x := 42 // stays on stack: address never leaves
	return x
}

func heapAlloc() *int {
	x := 42   // "moved to heap: x"
	return &x // address escapes the frame
}
```

```go
// Disable inlining to read escape output more clearly:
//   go build -gcflags='-m -l' ./...
//
// Force a value to heap for a benchmark baseline (rarely needed):
var sink *int

func keepOnHeap() {
	x := 7
	sink = &x // escapes via package-level var
}
```

## 5. Common Interview Questions

**Q1. What decides if a Go variable is on the stack or heap?**
The compiler's escape analysis, at compile time — not `new` vs `&`, and not the GC at runtime. If the compiler can prove the value's lifetime is bounded by the function, it's stack-allocated; otherwise heap.
*Follow-up: Does `new(T)` always heap-allocate?* No. `new(T)` returns `*T`, but if that pointer doesn't escape, the backing memory is on the stack. `new` is just an allocation expression, not a heap command.

**Q2. How big is a goroutine's stack, and what happens when it's exceeded?**
It starts at 8 KB. When a function's bounds check detects it's about to overflow, `runtime.morestack` allocates a larger stack (doubling), copies the old one over, fixes up pointers, and resumes. The ceiling is governed by `runtime/debug.SetMaxStack` (1 GB on 64-bit by default).
*Follow-up: Why copy instead of segment?* Segmented stacks caused hot-split thrashing at segment boundaries; contiguous copying gives predictable performance.

**Q3. Why does returning `&localStruct{}` not crash?**
Because escape analysis detects the address escapes and allocates the struct on the heap, so it survives the return. The GC frees it later. In C this would be a dangling pointer; in Go correctness forces heap placement.
*Follow-up: Is that slower than returning by value?* It's an allocation plus GC pressure. For small structs, returning by value (a copy) is often faster and allocation-free.

**Q4. Why do interface conversions often allocate?**
Converting a concrete value to an `interface{}` may require boxing the value on the heap if the compiler can't keep it on the stack — the interface holds a pointer to the data. Some small/word-sized values are optimized, but e.g. `fmt.Println(x)` boxes `x`.
*Follow-up: How do you avoid it in hot paths?* Avoid `interface{}`/`any` parameters; use generics or concrete types so no boxing occurs.

**Q5. Does a pointer always mean heap allocation?**
No. A pointer to a local that never escapes stays on the stack. Conversely, large non-pointer values can also be heap-allocated if they escape or are too big for the stack.
*Follow-up: What about slices?* A slice header (ptr/len/cap) can be on the stack while its backing array is on the heap, or both on the stack if the size is small and constant and it doesn't escape.

**Q6. How do you find heap allocations in production code?**
`go build -gcflags='-m'` for compile-time decisions; `go test -bench -benchmem` for allocs/op; `pprof` heap and alloc profiles for runtime hotspots.
*Follow-up: What's the difference between `inuse_space` and `alloc_space` in pprof?* `inuse_space` is live memory now; `alloc_space` is cumulative allocation (great for finding churn even if it's GC'd quickly).

**Q7. Why can taking the address of a loop variable be a footgun *and* an allocation?**
Pre-Go 1.22 the loop variable was shared across iterations, so storing `&v` captured the same address. Beyond the bug, capturing it in a closure/goroutine forces it to escape to the heap each iteration.
*Follow-up: What changed in 1.22?* Loop variables are now per-iteration, fixing the aliasing bug — but escape still applies if the address leaves the frame.

## 6. Production Use Cases

- **High-throughput HTTP/RPC servers (gRPC-Go, `net/http` handlers).** The hot path of request decoding is tuned to keep buffers and parsed structs off the heap. Allocations per request directly drive GC frequency and tail latency.
- **`sync.Pool` for transient buffers.** Standard library `encoding/json`, `fmt`, and many HTTP frameworks pool `[]byte` buffers so escaping allocations are recycled instead of re-allocated, cutting GC churn (used heavily in Caddy, the Go `bufio` ecosystem, and Prometheus).
- **Database drivers and serializers (protobuf, sqlx, pgx).** `pgx` is explicitly designed to minimize allocations per query by reusing scan buffers; benchmarks tout near-zero allocs/op for hot queries.
- **Log libraries (Uber's Zap, zerolog).** Zap's "no-allocation" design encodes log fields without boxing into `interface{}`, the canonical example of avoiding escape-driven allocations for throughput.
- **Game servers and trading systems.** Latency-sensitive systems pre-allocate and reuse objects to avoid GC pauses entirely on the critical path.

## 7. Common Mistakes

> [!WARNING]
> Optimizing allocations *before* profiling. Most code is not allocation-bound. Profile first; the compiler is smarter than your intuition.

- **Assuming `&` = heap and value = stack.** Wrong mental model. Escape analysis, not syntax, decides.
- **Returning pointers to small structs reflexively.** Returning a `*Point` forces a heap allocation; returning `Point` by value is often free and faster.
- **Passing values as `any`/`interface{}` in hot loops** — silent boxing on every call.
- **`append` in a loop without pre-sized capacity**, causing repeated heap reallocation and copies.
- **Capturing locals in goroutine closures** unnecessarily, forcing them to escape.
- **Huge local arrays** (e.g. `var buf [1 << 20]byte`) that blow the stack budget, get heap-allocated anyway, or force expensive stack growth.

## 8. Performance Considerations

The numbers that matter:

| Operation | Approx cost | Notes |
|---|---|---|
| Stack allocation | ~0–1 ns | Pointer bump on SP; freed for free on return |
| Heap allocation (small) | ~20–80 ns | `mallocgc`, plus deferred GC scan/sweep cost |
| Stack growth (`morestack`) | µs-scale once | Copy plus pointer fixup; amortized away after warmup |
| GC pressure | indirect | More heap allocs => more frequent GC => more CPU and tail latency |

Key levers:

- **`allocs/op` from `-benchmem` is the headline metric.** Driving a hot path to 0 allocs/op removes it from the GC equation entirely.
- **`GOGC`** (default 100) trades memory for CPU: higher = less frequent GC, more RAM. **`GOMEMLIMIT`** (Go 1.19+) sets a soft memory ceiling to prevent OOM while keeping GOGC behavior.
- Stack growth is a one-time warmup cost per goroutine; for short-lived goroutines that grow deep it can matter — but rarely dominates.

> [!TIP]
> A function returning a small struct *by value* frequently beats one returning a pointer, because it stays allocation-free. Benchmark both with `-benchmem`.

## 9. Best Practices

- **Profile before optimizing.** Use `-gcflags=-m`, `-benchmem`, and `pprof` to target real hotspots.
- **Return small structs by value; return large ones by pointer** (the copy cost crosses over around a few cache lines — benchmark for your types).
- **Pre-size slices and maps** with `make([]T, 0, n)` / `make(map[K]V, n)` when the size is known.
- **Reach for `sync.Pool`** only for genuinely hot, short-lived, GC-churning objects — and always reset pooled objects before reuse.
- **Prefer generics over `interface{}`** in performance-sensitive code to avoid boxing.
- **Keep large buffers as fields or pooled**, not as huge function locals.
- **Don't fight the compiler.** Most "manual stack tricks" lose to letting escape analysis work and writing clear code.

## 10. Code Examples

A primary example showing escape analysis decisions in action, paired with a benchmark to prove the cost difference:

```go
package alloc

// Stays on the stack: the struct's address never leaves the frame.
type Point struct{ X, Y int }

func sumByValue(p Point) int { return p.X + p.Y }

func makeOnStack() int {
	p := Point{1, 2} // -gcflags=-m: does NOT escape
	return sumByValue(p)
}

// Escapes: the pointer is returned, so the struct must outlive the frame.
func makeOnHeap() *Point {
	p := Point{3, 4} // -gcflags=-m: "moved to heap: p"
	return &p
}
```

The benchmark below quantifies the gap — run with `go test -bench . -benchmem`:

```go
package alloc

import "testing"

func BenchmarkStack(b *testing.B) {
	var s int
	for i := 0; i < b.N; i++ {
		s += makeOnStack() // 0 allocs/op
	}
	_ = s
}

func BenchmarkHeap(b *testing.B) {
	var p *Point
	for i := 0; i < b.N; i++ {
		p = makeOnHeap() // 1 alloc/op
	}
	_ = p
}
```

Avoiding allocation churn with `sync.Pool` for a transient buffer on a hot path:

```go
package buf

import (
	"bytes"
	"sync"
)

var bufPool = sync.Pool{
	New: func() any { return new(bytes.Buffer) },
}

// Render reuses pooled buffers instead of allocating per call.
func Render(parts ...string) string {
	b := bufPool.Get().(*bytes.Buffer)
	b.Reset() // critical: pooled objects carry old state
	defer bufPool.Put(b)

	for _, p := range parts {
		b.WriteString(p)
	}
	return b.String() // String() copies out; the buffer is safely reused
}
```

## 11. Advanced Concepts

- **Stack maps and pointer maps.** The compiler emits per-PC metadata describing which stack slots hold pointers. This powers both precise GC (which roots to scan) and stack copying (which words to fix up during growth). It's why Go can move stacks safely.

- **Bounded vs unbounded escape.** Escape analysis is *conservative*: when in doubt, it heap-allocates. Some constructs defeat it entirely — passing a pointer to a function the compiler can't see through (non-inlined, via interface) makes it assume escape. Inlining therefore *enables* more escape analysis: inlined callees expose their pointer flow (use `-l` to disable inlining and observe the difference).

- **`//go:noescape`.** Assembly/cgo functions can be annotated so the compiler trusts they don't retain pointer arguments, keeping callers' data on the stack. Misusing it is memory-unsafe.

- **Slice/map internals.** A `map` always heap-allocates its buckets. A slice's backing array follows escape rules. A small array `[4]int` local stays on the stack; `make([]int, n)` with large/dynamic `n` goes to the heap.

- **`runtime/debug.SetMaxStack` and `SetGCPercent`.** Tune the stack ceiling (default 1 GB/64-bit) and GC aggressiveness programmatically. Combined with `GOMEMLIMIT`, these are the knobs for memory-pressure tuning.

- **Goroutine stack accounting.** `runtime.ReadMemStats` exposes `StackInuse`/`StackSys` — useful when millions of goroutines push stack memory into the gigabytes.

## 12. Debugging Tips

- **See decisions:** `go build -gcflags='-m'` (add a second `-m` for the reasoning chain, `-l` to suppress inlining noise).
- **Count allocations:** `go test -bench=. -benchmem` → read `B/op` and `allocs/op`.
- **Find allocation hotspots at runtime:** import `net/http/pprof`, then `go tool pprof -alloc_space http://localhost:6060/debug/pprof/heap`. Use `alloc_space` (cumulative) to catch churn, `inuse_space` for leaks.
- **Flame graphs:** `go tool pprof -http=:8080 profile.out` for a visual of allocation call stacks.
- **Detect leaks/growth over time:** diff two heap profiles with `pprof -base`.
- **Trace GC / stack behavior:** `GODEBUG=gctrace=1` prints every GC cycle; `GODEBUG=allocfreetrace=1` (debug builds) traces individual allocs (very verbose).

> [!TIP]
> When `-gcflags=-m` says "escapes to heap" but you expected stack, look for an interface conversion, a non-inlined call taking your pointer, or capture in a closure — those three cause ~80% of surprise escapes.

## 13. Senior Engineer Notes

A senior engineer treats allocation as a *measured* property, not a vibe. In code review, the senior questions are: "Does this `interface{}` parameter box on the hot path? Could this return-by-pointer be return-by-value? Is this `append` pre-sized?" — but only *after* confirming the path is actually hot.

The judgement is knowing when **not** to optimize. Pooling, manual reuse, and value semantics add complexity and bug surface (a forgotten `Reset()` on a pooled buffer is a classic data-corruption incident). Senior engineers reserve these for benchmarked hotspots and document *why* with a benchmark in the PR. They mentor juniors away from the "`&` means heap" myth and toward `-gcflags=-m` as a learning tool.

They also know the readability/performance trade: a clear value-returning API that allocates once per request is usually *correct* — premature zero-alloc gymnastics that obscure intent is a net negative. The senior owns that line.

## 14. Staff Engineer Notes

At staff level the lens widens to systems and org economics. The questions become: *Is GC pressure the actual bottleneck, or is it I/O, locking, or serialization?* Staff engineers set the **service-wide latency budget** and decide whether allocation work is worth funding versus, say, switching serialization formats or adding caching.

They make **build-vs-buy** calls: adopt zero-alloc libraries (Zap over a homegrown logger, pgx over `database/sql` wrappers) rather than hand-rolling pooling in every service. They standardize **`GOMEMLIMIT` + `GOGC` policy** across the fleet so teams aren't independently rediscovering OOM-vs-CPU trade-offs, and they tie those settings to container memory limits in the platform layer.

Cross-team, staff engineers establish **performance guardrails**: `benchstat`-gated CI that flags allocs/op regressions, shared profiling dashboards, and a culture where "we reduced allocs/op from 40 to 3" is a reviewed, attributed win. They weigh the org cost: chasing the last 5% of allocations on a cold path is engineer time better spent elsewhere — and they say so explicitly, redirecting effort to where heap pressure genuinely threatens SLOs.

## 15. Revision Summary

- **Stack vs heap placement is decided by the compiler's escape analysis at compile time**, not by `new`/`&` syntax.
- Each goroutine starts with an **8 KB growable, copying stack**; `morestack` doubles and copies it, fixing pointers via stack maps.
- Stack allocation ≈ free (SP bump, auto-reclaimed); heap allocation costs ~tens of ns plus GC pressure.
- A value **escapes** when it's returned by pointer, stored in a heap object/global, sent on a channel, captured by a goroutine, or boxed into an interface.
- **Return small structs by value; pre-size slices/maps; avoid `interface{}` boxing; pool only hot transient objects.**
- Tools: `-gcflags=-m` (decisions), `-benchmem` (allocs/op), `pprof` (`alloc_space`/`inuse_space`), `GODEBUG=gctrace=1`.
- Tune with **`GOGC`** and **`GOMEMLIMIT`**; profile before optimizing — most code isn't allocation-bound.

**References:** Go runtime (`runtime` package, `morestack`/`mallocgc`); Go compiler escape analysis (`-gcflags=-m`); "Contiguous stacks" design (Go 1.3+); the `go.dev` GC guide; Uber Zap and `pgx` as zero-allocation exemplars.

---

*Go Engineering Handbook — topic 50.*
