# 59 · Allocation Reduction

> **In one line:** Cut heap pressure with `sync.Pool`, preallocation, reusable byte buffers, and zero-allocation APIs so the garbage collector runs less and tail latency stays flat.

---

## 1. Overview

Allocation reduction is the discipline of producing fewer, cheaper heap objects on the hot path. In Go, every `make`, `append` growth, interface boxing, and escaping local can become a heap allocation, and every heap allocation eventually costs you a slice of GC CPU and a contribution to the mark phase's work. The four classic tools are `sync.Pool` (recycle objects across goroutines), **preallocation** (size slices and maps once instead of growing them), **byte buffers** (reuse backing arrays for serialization and I/O), and **zero-alloc APIs** (signatures that let callers supply the buffer).

The goal is rarely "zero allocations everywhere" — it is *fewer allocations where it matters*: per-request work in a server handling 100k RPS, per-row work in an ETL pipeline, per-frame work in a game loop. Reducing allocations there flattens p99 latency, shrinks RSS, and lets you scale further on the same hardware. This chapter shows how the runtime turns your code into allocations, and how to systematically remove them without sacrificing readability.

> [!NOTE]
> Allocation reduction is a *measured* optimization. Always start with `go test -bench -benchmem` and `pprof`. Reducing `allocs/op` is the lever; lower GC CPU and tighter tail latency are the payoff.

## 2. Why It Exists

Go's GC is a concurrent, tri-color, non-moving mark-and-sweep collector. It is excellent, but not free: it consumes CPU proportional to the amount of *live* and *newly allocated* memory, and it triggers based on the heap growth ratio (`GOGC`, default 100 — collect when the heap doubles). Two services with identical logic but a 10x difference in allocations will have wildly different GC overhead.

Three concrete pains drive allocation reduction:

1. **GC CPU tax.** A high allocation rate forces frequent GC cycles. Each cycle steals CPU from your handlers (assist credit) and can push p99 up by milliseconds.
2. **Latency jitter.** GC assists and write-barrier work happen *on your goroutines*. Bursty allocation produces bursty latency.
3. **Memory footprint.** Short-lived garbage still occupies RAM until swept. High churn means higher peak RSS and bigger cloud bills.

The mechanisms exist because the alternatives — manual `malloc`/`free`, arenas everywhere — are error-prone. `sync.Pool` gives you *cooperative* reuse that the GC is aware of and can reclaim under pressure, so you get most of an object pool's benefit without leaks or use-after-free in the common case.

## 3. Internal Working

### How an allocation happens

When code allocates, the compiler first asks: *does this escape?* Escape analysis (`go build -gcflags=-m`) decides whether a value can live on the stack (free, reclaimed on return) or must go to the heap. If it escapes, the runtime calls `mallocgc`.

`mallocgc` routes by size class. Go maintains a per-P (per-logical-processor) cache called the **mcache**, holding free lists for ~68 size classes (8B, 16B, 32B, … up to 32KB). Small objects are served lock-free from the mcache. When a size class runs dry, the mcache refills from the **mcentral** (a shared, mutex-protected list per size class), which in turn carves spans from the **mheap**. Objects larger than 32KB are "large" and allocated directly from the mheap as dedicated spans.

```text
        allocation request
               │
       escape analysis  ──── stays on stack ──► free, no GC cost
               │ (escapes)
            mallocgc
               │
      ┌────────┴─────────┐
   size ≤ 32KB        size > 32KB
      │                   │
   mcache (per-P)     mheap (large span)
   lock-free freelist
      │ empty?
   mcentral (per size class, locked)
      │ empty?
   mheap → OS (mmap)
```

### How sync.Pool works

`sync.Pool` is built to dodge the mcentral lock entirely. Internally each Pool has a per-P structure (`poolLocal`) so that `Get`/`Put` on the same P are uncontended. Each `poolLocal` holds:

- a **private** slot (a single object, accessible only by the current P, no atomics), and
- a **shared** lock-free deque that *other* P's can steal from (work-stealing, like the scheduler).

```text
sync.Pool
 ├─ poolLocal[P0]: { private: *obj, shared: [deque] }
 ├─ poolLocal[P1]: { private: *obj, shared: [deque] }
 └─ ...
 victim cache (previous GC cycle's contents)
```

The killer detail is GC integration. At the start of each GC, `poolCleanup` runs: the current contents move to a **victim cache**, and last cycle's victim cache is dropped. So objects survive *one* GC if reused, and are reclaimed if idle across two cycles. This is why `sync.Pool` does not leak under load drop — and why it is a *cache*, not a guaranteed-retention pool.

### Why preallocation and buffer reuse work

`make([]T, 0, n)` reserves capacity once. Without it, `append` doubles the backing array repeatedly (1→2→4→…), each doubling being a fresh allocation plus a copy. Preallocating turns *log n* allocations into *one*. Buffer reuse (`buf = buf[:0]`) keeps the backing array and resets the length, so subsequent appends hit existing capacity — zero allocations after warmup.

## 4. Syntax

```go
// Preallocate slice capacity (length 0, cap n)
out := make([]Item, 0, len(in))
for _, x := range in {
    out = append(out, transform(x)) // no growth reallocations
}

// Preallocate map with size hint
m := make(map[string]int, expectedKeys)

// Reset a buffer instead of allocating a new one
buf = buf[:0]          // keep backing array, length 0
buf = append(buf, data...)

// sync.Pool of *bytes.Buffer
var bufPool = sync.Pool{
    New: func() any { return new(bytes.Buffer) },
}
b := bufPool.Get().(*bytes.Buffer)
b.Reset()              // always reset borrowed objects
defer func() { bufPool.Put(b) }()

// Zero-alloc API: caller supplies the destination buffer
func AppendID(dst []byte, id uint64) []byte {
    return strconv.AppendUint(dst, id, 10)
}
```

## 5. Common Interview Questions

**Q1. When does a value escape to the heap?**
When the compiler cannot prove its lifetime is bounded by the function: returning a pointer to a local, storing it in an interface that escapes, capturing it in a goroutine closure, or putting it in a slice/map that outlives the frame. Verify with `go build -gcflags=-m`.
*Follow-up: Does returning a struct by value escape?* No — value returns are copied to the caller's frame; only pointers/refs that outlive the frame escape.

**Q2. Is `sync.Pool` a fixed-size object pool?**
No. It is an unbounded, GC-aware *cache*. You cannot cap it, and entries are dropped on GC (after a one-cycle victim grace). Use it for transient reuse, not for limiting concurrency or pooling scarce resources (use a buffered channel or a real connection pool for that).
*Follow-up: What happens to pooled objects under memory pressure?* They are cleared during GC, so the pool naturally shrinks — it won't pin memory.

**Q3. Why must you `Reset` an object after `Get`?**
`Get` may return a previously used object with stale data, or a fresh `New` one. Failing to reset leaks data across requests (a security/corruption bug) and risks unbounded growth if the object holds a large backing array.
*Follow-up: Should you cap buffer size before Put?* Yes — drop or shrink buffers larger than a threshold so the pool doesn't retain giant arrays.

**Q4. How does preallocating a map help?**
A size hint pre-sizes the bucket array, avoiding incremental rehashing as the map grows. It reduces allocations and CPU spent migrating buckets.
*Follow-up: Does the hint guarantee no further growth?* No, it's a hint; exceeding it still triggers growth, but you've avoided the early rehashes.

**Q5. What's a "zero-allocation API" and give an example?**
An API that lets the caller provide the output buffer, so the function appends rather than allocates. `strconv.AppendInt(dst, n, 10)` and `time.Time.AppendFormat` are stdlib examples; `fmt.Fprintf` to a reused buffer beats `fmt.Sprintf`.
*Follow-up: Why is `[]byte`-based often faster than `string`?* Converting `[]byte`→`string` can allocate; appending to `[]byte` and converting once at the end avoids per-step copies.

**Q6. Can `sync.Pool` hurt performance?**
Yes. For tiny objects, the Get/Put overhead plus interface boxing can exceed the cost of just allocating. Pools shine for large or expensive-to-construct objects with high churn. Always benchmark.
*Follow-up: What's the boxing cost?* `Get` returns `any`; the type assertion and storing a pointer in an interface add overhead — store pointers, not large values, to minimize it.

**Q7. How do you measure allocation reduction?**
`go test -bench=. -benchmem` reports `B/op` and `allocs/op`. `pprof` heap profiles (`-alloc_space`, `-alloc_objects`) and `GODEBUG=gctrace=1` show GC frequency. Compare before/after with `benchstat`.
*Follow-up: Which matters more, B/op or allocs/op?* Often `allocs/op`, because GC cost correlates with object count and scanning, not just bytes.

## 6. Production Use Cases

- **HTTP/RPC servers.** `net/http`, gRPC-Go, and `fasthttp` reuse request/response buffers via pools. `fasthttp` famously hits near-zero allocations per request by reusing `RequestCtx` objects, beating `net/http` throughput several-fold.
- **JSON / serialization libraries.** `encoding/json`'s encoder uses a `sync.Pool` of `encodeState` buffers. `json-iterator`, `easyjson`, and `sonic` lean heavily on buffer reuse and codegen to cut allocations.
- **Logging.** `zap` and `zerolog` are designed around zero-allocation logging: they encode directly into pooled byte buffers and avoid `interface{}` boxing on the hot path. `zap`'s `Buffer` pool is core to its speed.
- **Databases / proxies.** CockroachDB, TiDB, and Vitess preallocate row buffers and pool key/value scratch space in scan loops. Network proxies (Envoy-style data planes written in Go) reuse packet buffers.
- **Protobuf.** `google.golang.org/protobuf` and `gogo/protobuf` support `Reset()`-and-reuse of messages and `Marshal(dst []byte)` append-style APIs.
- **Hot data pipelines.** Kafka consumers and stream processors (e.g., Sarama-based) preallocate batch slices sized to expected fetch counts.

## 7. Common Mistakes

> [!WARNING]
> The single most common bug: **`Put`-ing an object that's still referenced elsewhere.** Two goroutines then mutate the same buffer — a data race and silent corruption.

- **Not resetting before reuse** — stale bytes leak across requests; with buffers, length is wrong.
- **Pooling tiny objects** — overhead exceeds savings; benchmark shows a regression.
- **Retaining giant buffers in the pool** — one 10MB request bloats the pool forever; cap before `Put`.
- **`make([]T, n)` when you meant cap** — `make([]T, n)` creates `n` zero elements; appending then *adds* past them. Use `make([]T, 0, n)`.
- **Keeping a reference to pooled memory** after `Put` — use-after-free semantics.
- **Assuming `sync.Pool` bounds memory or concurrency** — it does neither.
- **Optimizing without escape analysis** — "fixing" allocations that the compiler already stack-allocates wastes effort.

## 8. Performance Considerations

The numbers that matter: a small heap allocation costs roughly tens of nanoseconds, but the *amortized* GC cost per allocation can dominate at scale. Eliminating one allocation per request at 100k RPS removes 100k allocations/sec of GC pressure.

| Technique | Typical win | Best when | Watch out for |
|---|---|---|---|
| Stack allocation (escape avoidance) | Allocation → 0 | Small, non-escaping locals | Inlining/escape can regress silently |
| Preallocation (`make 0,n`) | log n → 1 alloc | Known/estimable size | Over-allocating wastes RAM |
| Buffer reuse (`buf[:0]`) | n → 0 after warmup | Repeated serialize/format | Aliasing if buffer escapes |
| `sync.Pool` | High churn → reuse | Large/expensive objects | Boxing cost; GC clears it |
| Zero-alloc append API | Caller controls allocs | Hot serialization paths | Slightly clunkier signatures |

Tune `GOGC` (or `GOMEMLIMIT` in Go 1.19+) alongside allocation work: raising `GOGC` trades RAM for fewer GC cycles, but is no substitute for reducing churn. `GOMEMLIMIT` sets a soft heap ceiling, useful in containers to avoid OOM kills while keeping `GOGC` aggressive.

> [!TIP]
> Profile with `GODEBUG=gctrace=1`. If GC CPU is under ~5% of total, allocation reduction may not be your bottleneck — look at I/O or locking first.

## 9. Best Practices

- **Measure first.** `-benchmem`, `pprof -alloc_objects`, `benchstat`. Optimize the proven hot path only.
- **Prefer escape avoidance over pooling.** A stack allocation beats any pool. Read `-gcflags=-m` output.
- **Preallocate when size is known or estimable** — slices and maps both take hints.
- **Always `Reset` borrowed objects; cap large ones before `Put`.**
- **Pool large/expensive objects, not 16-byte structs.**
- **Use append-style stdlib APIs** (`strconv.Append*`, `time.AppendFormat`, `*Buffer.Bytes`) on hot paths.
- **Keep pooled types as pointers** to minimize interface boxing.
- **Document lifetime ownership** clearly when an API hands out pooled memory — make it obvious where `Put` happens.

## 10. Code Examples

Primary: a request-scoped buffer pool with safe reset and size capping — the production pattern.

```go
package render

import (
	"bytes"
	"sync"
)

const maxPooledBuf = 64 << 10 // 64KB cap to avoid retaining giants

var bufPool = sync.Pool{
	New: func() any { return new(bytes.Buffer) },
}

// Render writes formatted output using a pooled buffer and returns a copy.
func Render(items []Item) []byte {
	b := bufPool.Get().(*bytes.Buffer)
	b.Reset()
	defer func() {
		if b.Cap() <= maxPooledBuf { // don't pool oversized buffers
			bufPool.Put(b)
		}
	}()

	for _, it := range items {
		b.WriteString(it.Name)
		b.WriteByte('\n')
	}
	// Copy out: the buffer's backing array goes back to the pool.
	out := make([]byte, b.Len())
	copy(out, b.Bytes())
	return out
}

type Item struct{ Name string }
```

```go
package render

import "strconv"

type Row struct {
	ID   uint64
	Name string
}

// AppendRow appends an encoded row to dst and returns the extended slice.
// Callers reuse dst across calls (dst = dst[:0]) for zero steady-state allocs.
func AppendRow(dst []byte, r Row) []byte {
	dst = strconv.AppendUint(dst, r.ID, 10)
	dst = append(dst, ',')
	dst = append(dst, r.Name...)
	return append(dst, '\n')
}

// Usage: buf reused across the loop, one allocation total.
func Encode(rows []Row) []byte {
	buf := make([]byte, 0, 256)
	for _, r := range rows {
		buf = AppendRow(buf, r)
	}
	return buf
}
```

A focused preallocation example for the slice-growth pitfall:

```go
func Squares(in []int) []int {
	out := make([]int, 0, len(in)) // one allocation, not log(n)
	for _, x := range in {
		out = append(out, x*x)
	}
	return out
}
```

## 11. Advanced Concepts

**Escape analysis tuning.** Small changes flip escape decisions. Returning `*T` escapes; returning `T` may not. Passing a value to `interface{}`/`any` usually escapes it (boxing). Reading `-gcflags='-m -m'` shows the reasoning chain. The `//go:noinline` pragma affects inlining, which in turn affects escape outcomes.

**Off-heap and arenas.** Go's experimental `arena` package (GOEXPERIMENT=arenas, never stabilized) allocates objects in a region freed all at once — useful for request-scoped graphs but error-prone (use-after-free). Most teams avoid it; pools are the safe default.

**Struct-of-arrays (SoA).** Replacing `[]Point{X,Y,Z}` with three `[]float64` slices improves cache locality and can reduce per-element allocation when fields are appended independently. Common in numeric and game code.

**`strings.Builder` vs `bytes.Buffer`.** `strings.Builder` avoids the final `[]byte`→`string` copy by using `unsafe` internally; prefer it when the result is a string. It also supports `Grow(n)` for preallocation.

**False sharing & per-P design.** `sync.Pool`'s per-P sharding mirrors the scheduler's work-stealing precisely to avoid cross-core contention and false sharing — a pattern worth emulating in your own concurrent caches.

**`GOMEMLIMIT` interplay.** Under a memory limit, the GC becomes more aggressive as you approach the ceiling, which can *increase* CPU. Reducing allocations gives the runtime more headroom to honor the limit cheaply.

## 12. Debugging Tips

```text
# See escape analysis decisions
go build -gcflags='-m -m' ./...

# Benchmark with allocation stats
go test -bench=. -benchmem -memprofile=mem.out

# Inspect allocations by call site
go tool pprof -alloc_objects mem.out
(pprof) top
(pprof) list FuncName

# Watch GC behavior at runtime
GODEBUG=gctrace=1 ./server   # prints per-cycle heap + CPU

# Detect Put-after-still-referenced races
go test -race ./...
```

- Use `benchstat old.txt new.txt` to confirm a real, statistically significant change rather than noise.
- In heap profiles, `-alloc_objects` finds *frequent* allocators; `-alloc_space` finds *large* ones. Chase both.
- If `gctrace` shows GC firing many times per second under steady load, allocation churn is your problem.
- `runtime.ReadMemStats` (`Mallocs`, `NumGC`) lets you assert allocation budgets in tests.

## 13. Senior Engineer Notes

As a senior engineer, your job is *judgment and review discipline*. Resist the urge to pool everything: most allocations are cheap and stack-bound, and a misused `sync.Pool` introduces aliasing bugs that are far costlier than the GC time you saved. In code review, the questions you ask are: "Is this on a proven hot path? Where's the benchmark? Who owns the lifetime of this pooled buffer? Is it reset and size-capped?"

Mentor toward a workflow, not a trick: profile → confirm GC is the bottleneck → reduce allocations at the top call sites → re-measure with `benchstat`. Teach juniors to read `-gcflags=-m` so they stop guessing about escapes. Establish a team norm that any `sync.Pool` PR ships with a benchmark proving the win and a comment documenting reset/ownership. Keep the abstraction readable — a 5% latency gain that makes the code unmaintainable is usually a bad trade for a non-core service. Reserve aggressive zero-alloc style for the genuinely hot 5% of code.

## 14. Staff Engineer Notes

At staff level, allocation strategy is an *architectural and org-level* concern. The framing shifts from "this function" to "what is our platform's allocation budget per request, and how do we keep it across dozens of teams?" Decide org-wide defaults: standardize on a fast logger (`zap`/`zerolog`) and a serialization codec (`sonic`/`easyjson`) so individual teams inherit zero-alloc behavior without re-litigating it. Set `GOMEMLIMIT` and `GOGC` policy per service tier and bake it into your platform's deployment templates.

Build-vs-buy calls land here: is it worth maintaining hand-rolled zero-alloc parsers, or do you adopt a battle-tested library and accept its allocation profile? Usually buy/adopt — engineering time spent shaving allocations rarely beats the leverage of caching, batching, or removing the work entirely. Quantify the trade: a 10% GC CPU reduction across a 5000-core fleet is real money and capacity; a 10% reduction on a low-traffic admin service is noise. Drive cross-team observability so allocation regressions show up in CI (benchmark gates) and dashboards (GC CPU %, RSS), not in a 3am page. Finally, weigh the maintainability tax: zero-alloc code is harder to evolve, so concentrate it behind stable library boundaries owned by a platform team, keeping product code simple.

## 15. Revision Summary

- **Goal:** fewer heap allocations on the hot path → less GC CPU, flatter p99, lower RSS.
- **Escape analysis** decides stack vs heap; check with `go build -gcflags=-m`. Stack beats every pool.
- **Preallocate:** `make([]T, 0, n)` and `make(map, n)` turn log-n growth into one allocation.
- **Reuse buffers:** `buf = buf[:0]` keeps the backing array; zero allocs after warmup.
- **`sync.Pool`:** per-P sharded, GC-aware *cache* (victim cache survives one cycle). Not a bounded pool, not for concurrency limiting. Always `Reset`; cap large objects before `Put`; store pointers.
- **Zero-alloc APIs:** caller supplies `dst` — `strconv.Append*`, `time.AppendFormat`, `strings.Builder`.
- **Measure:** `-benchmem` (`B/op`, `allocs/op`), `pprof -alloc_objects`, `GODEBUG=gctrace=1`, `benchstat`.
- **Pitfalls:** Put-while-referenced (race), no reset (stale data), pooling tiny objects, retaining giants.
- **Tuning:** `GOGC` trades RAM for fewer cycles; `GOMEMLIMIT` sets a soft ceiling for containers.

**References:** [sync.Pool docs](https://pkg.go.dev/sync#Pool); Go runtime `mallocgc`/mcache/mcentral/mheap; `go build -gcflags=-m`; `GODEBUG=gctrace=1`; `benchstat`; zap/zerolog/fasthttp/encoding-json source.

---
*Go Engineering Handbook — topic 59.*
