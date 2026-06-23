# 57 · CPU Optimization

> **In one line:** Making Go code faster on the CPU by shrinking hot paths, helping the compiler inline and eliminate bounds checks, and laying out data for cache locality.

---

## 1. Overview

CPU optimization in Go is the discipline of reducing the number of instructions executed and the number of cycles those instructions stall on, for the small fraction of code that dominates runtime — the **hot path**. The modern bottleneck is rarely raw arithmetic; it is *memory latency* (a last-level-cache miss costs 100-300 cycles, while an add costs <1) and *missed compiler optimizations* (a bounds check or a non-inlined call inside a tight loop).

The four levers this chapter focuses on:

- **Hot paths** — find the 3% of code that runs 97% of the time and optimize only that.
- **Inlining** — let the compiler paste small functions into callers, removing call overhead and unlocking further optimizations.
- **Bounds-check elimination (BCE)** — convince the compiler it can drop `index < len` checks it would otherwise emit on every slice access.
- **Cache locality** — arrange data so the CPU prefetcher and caches work *for* you, not against you.

The golden rule: **measure first**. Every technique here can be a net negative if applied to cold code or guessed at without a profile.

## 2. Why It Exists

Go deliberately trades some peak performance for safety, simplicity, and fast compilation. Bounds checks make out-of-range access a panic instead of a security bug. Garbage collection removes use-after-free. The escape analyzer decides heap vs stack for you. These guarantees cost cycles.

CPU optimization exists because, in a small set of contexts, those default costs matter enormously:

- **Per-request fan-out**: a service handling 200k req/s where 5 ns/request is 1 full core.
- **Data planes**: proxies, serializers, databases, video pipelines where the loop body runs billions of times.
- **Tail latency**: a cache miss in the p99.9 path is what wakes engineers at 3 a.m.

Go gives you tools to *recover* peak performance selectively without giving up safety globally: the compiler will prove a bounds check is unnecessary and remove it, and it will inline so aggressively that idiomatic small-function code costs nothing. The work is in writing code the compiler can reason about.

## 3. Internal Working

### Inlining

The Go compiler (`cmd/compile`) inlines based on a **cost budget**. Each function body is walked and assigned a cost (roughly one unit per node); the inliner's hairyness budget is **80** by default, with extra mid-stack inlining heuristics. A function is *non-inlinable* if it exceeds budget or contains a disqualifier: closures that capture were historically blockers (now partially inlinable), `recover`, `select`, labeled loops, and certain `for range` constructs. `go:noinline` forces it off; there is no stable "always inline" pragma.

Inlining matters less for the saved `CALL` instruction (~few cycles) and more because it **enables downstream passes** — once a function is inlined, constant propagation, dead-code elimination, escape analysis, and BCE all see across the old call boundary.

### Bounds-Check Elimination

For every `a[i]`, the compiler must emit, conceptually:

```text
if uint(i) >= uint(len(a)) { panicIndex() }
```

The SSA backend runs a **prove pass** that builds a graph of known facts (relations like `i < len(a)`, `i >= 0`) and removes checks it can prove redundant. Classic enabling patterns: hoisting `_ = a[n-1]` before a loop, iterating with `for i := range a`, and slicing `b := a[:n]` so later `b[i]` is provably in range.

### Cache Locality & Memory Layout

A struct in Go is laid out in declaration order with alignment padding. Cache lines are 64 bytes. Access patterns that stride sequentially through memory hit the **hardware prefetcher**; random pointer-chasing (linked lists, maps, slices of pointers) defeats it.

```text
Memory hierarchy (typical x86-64, cycles ≈ latency):
 ┌────────────┐  ~4c     ┌──────┐ ~12c   ┌──────┐ ~40c   ┌──────────────┐ ~100-300c
 │ Registers  │ ───────▶ │ L1   │ ─────▶ │ L2   │ ─────▶ │ L3 / DRAM    │
 │ (instant)  │  32KB    │ data │  256KB │      │  ~MBs  │ (the cliff)  │
 └────────────┘          └──────┘        └──────┘        └──────────────┘

Slice-of-structs (good)            Slice-of-pointers (cache-hostile)
 [s0][s1][s2][s3] contiguous        [*]→s7  [*]→s2  [*]→s9  (scattered heap)
 prefetcher streams ahead           every deref may miss L1/L2
```

`[]Point` packs `Point` values back-to-back; `[]*Point` stores 8-byte pointers to objects scattered across the heap. The former is often 3-10x faster to iterate.

## 4. Syntax

There is no dedicated syntax for CPU optimization — it is patterns plus compiler directives and tooling flags.

```go
//go:noinline  — prevent inlining (benchmarking / forcing a stack frame)
func f() {}

//go:nosplit   — omit the stack-growth preamble (runtime-only, dangerous)

// See inlining decisions and BCE:
//   go build -gcflags='-m -m' ./...        // inlining + escape analysis
//   go build -gcflags='-d=ssa/check_bce/debug=1' ./...  // bounds checks left in
//   go test -bench=. -benchmem -cpuprofile=cpu.out
//   go tool pprof -http=:0 cpu.out
```

## 5. Common Interview Questions

**Q1. What is a hot path and how do you find it?**
The code executing most often / consuming most CPU. Find it with a CPU profile (`pprof`), not intuition — `go tool pprof`, look at the flat and cumulative columns, and the flame graph. *Follow-up: why not just optimize the function with the most lines?* Because line count is unrelated to cycles consumed; a 3-line loop body run 10⁹ times dwarfs a 300-line setup function.

**Q2. When does the Go compiler inline a function, and why does it matter beyond the saved call?**
When the function's cost is under the inliner budget (~80) and it has no disqualifiers. It matters because inlining exposes the callee's body to constant propagation, escape analysis, and BCE in the caller's context. *Follow-up: how do you check?* `go build -gcflags=-m` prints "can inline f" / "inlining call to f".

**Q3. Explain bounds-check elimination and give a pattern that triggers it.**
The compiler's prove pass removes `index < len` checks it can prove safe. Pattern: `for i := range a { use(a[i]) }`, or hoist `_ = a[len(a)-1]` so subsequent in-loop accesses are provably in range. *Follow-up: does range over the slice itself eliminate the check?* `for _, v := range a` has no index access so no check; `a[i]` inside a counted loop needs the prove pass.

**Q4. Why is `[]Point` usually faster to iterate than `[]*Point`?**
Cache locality. `[]Point` is contiguous so the prefetcher streams it; `[]*Point` forces a pointer dereference per element to scattered heap memory, causing cache misses. *Follow-up: when is `[]*Point` justified?* When elements are large and shared/mutated through multiple references, or when stable identity across reslicing/append is required.

**Q5. What is false sharing and how do you fix it?**
Two cores writing to different variables that land on the same 64-byte cache line cause the line to ping-pong between caches, serializing them. Fix by padding hot per-core state to a full cache line. *Follow-up: how do you detect it?* `perf c2c` on Linux, or a benchmark that scales poorly with GOMAXPROCS despite no shared state.

**Q6. Does `//go:inline` exist?**
No. There is `//go:noinline` to disable it; you cannot force inlining via pragma. You influence it by keeping functions small and simple. *Follow-up: how do you "force" inlining then?* Manually inline the body, or split a function so the hot part is small enough to qualify.

**Q7. Why can interface method calls hurt CPU performance?**
They are indirect (dynamic dispatch through the itab), so they are not inlined and may mispredict in the branch predictor; they also often cause the receiver to escape to the heap. *Follow-up: fix?* Use concrete types on the hot path, or generics to monomorphize.

## 6. Production Use Cases

- **CockroachDB / TiDB**: SQL execution engines use columnar/batched, contiguous-memory processing precisely for cache locality; key encoders are hand-tuned for BCE.
- **Cloudflare's proxies**: hot parsing loops in HTTP/2 and TLS paths avoid allocations and pointer-chasing; they publicly document `pprof`-driven loop tuning.
- **Prometheus / VictoriaMetrics**: time-series compression and ingestion loops are bounds-check-tuned and operate on contiguous `[]float64`/`[]int64` blocks.
- **etcd / Kubernetes apiserver**: protobuf marshal/unmarshal is a measured hot path; the generated code and `gogo/protobuf` variants exist to cut CPU.
- **Game/finance/video**: order-matching engines and codecs use struct-of-arrays (SoA) layout and avoid interfaces in the inner loop.

## 7. Common Mistakes

> [!WARNING]
> Optimizing without a profile. The most common and most expensive mistake — you spend a day shaving a function that is 0.2% of CPU.

- Adding `//go:noinline` and forgetting it, killing performance silently.
- Microbenchmarking with results the compiler proves dead (always consume into a package-level sink).
- Believing `[]*T` is "cheaper" because the elements are big — you trade copy cost for miss cost; measure.
- Manually unrolling loops the compiler already handles, hurting readability for no gain.
- Premature `sync.Pool` everywhere, adding contention and complexity to cold paths.
- Assuming bounds checks are free to remove by hand — only the prove pass actually removes them; obfuscating index math can *prevent* BCE.

## 8. Performance Considerations

| Technique | Typical win | Risk | When |
|---|---|---|---|
| Inlining small fns | 2-30% on call-heavy loops | readability if over-split | hot path with many tiny calls |
| BCE | 5-20% on index loops | brittle to refactor | tight numeric loops |
| Value slices (SoA/`[]T`) | 2-10x on iteration | larger copies on append | sequential scans |
| Cache-line padding | removes contention cliffs | wasted memory | per-core counters |
| Concrete vs interface | removes dispatch + escapes | less flexible API | inner loops only |

Rules of thumb: a cache miss ≈ 100+ cycles, a branch mispredict ≈ 15-20, an inlined call ≈ 0, a non-inlined call ≈ 2-5 plus lost optimizations. Always pair with `-benchmem`: CPU and allocation are coupled because GC steals CPU.

## 9. Best Practices

- **Profile, change one thing, re-profile.** Use `benchstat` over ≥10 runs to confirm a real delta, not noise.
- Keep hot functions small so they inline; push cold setup into separate functions.
- Prefer `for i := range a` and value slices for sequential work.
- Verify BCE with `-d=ssa/check_bce/debug=1` after refactors.
- Use generics instead of `interface{}` on hot paths to avoid boxing and dispatch.
- Reduce allocations first — fewer allocs means less GC CPU and better locality.
- Leave a comment explaining *why* an unidiomatic optimization exists, with the benchmark number.

> [!TIP]
> The fastest code is code that doesn't run. Algorithmic improvement (O(n) → O(log n)) beats every micro-optimization in this chapter.

## 10. Code Examples

Primary: a hot loop tuned for BCE and inlining. The two blocks below are switchable tabs — naive vs optimized.

```go
// naive: bounds check on every dst[i] and src[i]
func scaleNaive(dst, src []float64, k float64) {
	for i := 0; i < len(dst); i++ {
		dst[i] = src[i] * k // two bounds checks per iter
	}
}
```

```go
// optimized: reslice src to len(dst) so the prove pass drops checks
func scaleFast(dst, src []float64, k float64) {
	src = src[:len(dst)] // single check here; loop is now clean
	for i := range dst {
		dst[i] = src[i] * k // both indices provably in range
	}
}
```

Cache locality: struct-of-arrays (SoA) vs array-of-structs (AoS) for a particle update where only positions are touched.

```go
// AoS: loads the whole 48-byte struct to touch 16 bytes -> wasted bandwidth
type Particle struct {
	X, Y      float64 // hot
	VX, VY    float64
	Mass, Pad float64 // cold, but still pulled into cache
}

func stepAoS(ps []Particle, dt float64) {
	for i := range ps {
		ps[i].X += ps[i].VX * dt
		ps[i].Y += ps[i].VY * dt
	}
}

// SoA: each slice is contiguous and only hot fields are streamed
type Particles struct {
	X, Y, VX, VY []float64
}

func stepSoA(p Particles, dt float64) {
	x, y, vx, vy := p.X, p.Y, p.VX, p.VY // hoist; helps BCE + register alloc
	_ = x[len(vx)-1]                     // hint prove pass
	for i := range vx {
		x[i] += vx[i] * dt
		y[i] += vy[i] * dt
	}
}
```

Cache-line padding to kill false sharing on per-core counters.

```go
const cacheLine = 64

type paddedCounter struct {
	n uint64
	_ [cacheLine - 8]byte // pad so each counter owns its own line
}

type Counters struct {
	c [256]paddedCounter
}

func (cs *Counters) Inc(cpu int) { cs.c[cpu&255].n++ }
```

## 11. Advanced Concepts

- **PGO (Profile-Guided Optimization)**: since Go 1.21, drop a `default.pgo` profile next to `main` and `go build` raises the inlining budget for hot functions and devirtualizes interface calls it observes are monomorphic. Real-world wins of 2-14% are reported with zero code change.
- **Devirtualization**: PGO and the compiler can turn an interface call into a concrete call (plus inline it) when one implementation dominates.
- **Loop unrolling & vectorization**: Go does *not* auto-vectorize to SIMD; for that you drop to assembly (`.s` files) or use libraries like `gonum`'s asm kernels. Manual unrolling can help branch prediction but rarely beats the prefetcher for memory-bound loops.
- **Memory alignment / field ordering**: reorder struct fields large-to-small to minimize padding; check with `unsafe.Sizeof` and `fieldalignment` (golangci-lint).
- **`sync.Pool` and per-P caching**: amortizes allocation and improves locality of reused buffers, but adds GC-time clearing cost.

## 12. Debugging Tips

```text
Workflow:
  1. go test -bench=Hot -benchmem -cpuprofile=cpu.out -count=10
  2. go tool pprof -http=:0 cpu.out        # flame graph: find the hot frame
  3. go build -gcflags='-m -m' ./pkg       # did it inline? did it escape?
  4. go build -gcflags='-d=ssa/check_bce/debug=1' ./pkg  # bounds checks left
  5. benchstat old.txt new.txt             # is the delta real?
  6. (linux) perf stat -e cache-misses,...  ./bin   # confirm a locality theory
```

> [!NOTE]
> `pprof` is sampled (~100 Hz by default); for very short loops, increase iterations or use `runtime/pprof` with a longer run so samples land in the loop. Use `go tool pprof -list=FuncName` to see per-line cycle attribution.

Watch for `escapes to heap` in `-m` output on the hot path — an unexpected escape (e.g. from an interface conversion) often explains a regression.

## 13. Senior Engineer Notes

A senior engineer's job here is *judgment and discipline*, not cleverness.

- **Gate every optimization behind a benchmark in CI.** If you can't show a `benchstat` delta, the change doesn't merge. This protects the codebase from "optimizations" that are noise or regressions.
- **Keep the optimized version readable.** Prefer the BCE-via-`range` idiom over manual pointer arithmetic; add a comment with the measured win so the next person doesn't "clean it up."
- **In code review**, push back on speculative `//go:noinline`, hand-rolled unrolling, and `[]*T` "for performance" without numbers. Ask "what's the profile say?"
- **Mentor** juniors to read `-gcflags=-m` and a flame graph before touching code. Teach that algorithmic wins and allocation reduction come *before* BCE/inlining tweaks.
- Own the few genuinely hot files and treat changes to them like changes to a public API — benchmark-guarded.

## 14. Staff Engineer Notes

A staff engineer operates at the level of *where optimization effort should and shouldn't go across the org*.

- **Build-vs-buy**: before hand-tuning a serializer, evaluate `vtprotobuf`, `gogofaster`, or columnar engines. Adopting PGO org-wide (a CI step that captures production profiles and feeds `default.pgo`) often beats months of per-team micro-tuning and requires no code change.
- **Set the bar**: establish org guidance that CPU work is profile-driven and benchmark-gated; provide a shared `benchstat`/continuous-profiling platform (e.g. Parca, Pyroscope, Google-style always-on profiling) so teams optimize from real production data, not local guesses.
- **Architectural leverage**: the biggest CPU wins are usually structural — batching, removing N+1 RPCs, columnar data layout, moving work off the request path — not BCE. Steer teams toward those before micro-optimization.
- **Cross-team trade-offs**: a cache-friendly data layout may complicate an API used by ten teams; weigh the global maintenance cost against the CPU saving (which is dollars: cores × fleet size). Quantify it — "this saves 40 cores across the fleet, ~\$X/yr" makes the decision objective.
- Decide when "fast enough" is the right call and protect engineering time from premature optimization at scale.

## 15. Revision Summary

- **Hot path**: the small code fraction dominating CPU; find it with `pprof`, optimize only it.
- **Inlining**: compiler pastes small (<~80 cost) functions into callers; unlocks BCE/escape/const-prop. No force-inline pragma; `//go:noinline` disables.
- **BCE**: prove pass removes `i < len` checks; trigger via `for i := range`, reslicing, and hoisted `_ = a[len-1]`. Verify with `-d=ssa/check_bce/debug=1`.
- **Cache locality**: cache line = 64B; contiguous `[]T` and SoA beat `[]*T`/AoS; pad per-core state to avoid false sharing.
- **Numbers**: cache miss ~100-300c, mispredict ~15-20c, inlined call ~0.
- **PGO** (Go 1.21+): production profile raises inline budget + devirtualizes; 2-14% free.
- **Process**: profile → change one thing → `benchstat` over ≥10 runs → re-profile.

**References:** Go performance; `cmd/compile` inliner & SSA prove pass; `go tool pprof`; Go 1.21 PGO docs.

---

*Go Engineering Handbook — topic 57.*
