# 55 · Benchmarking

> **In one line:** Go's `testing.B` framework auto-calibrates iteration counts (`b.N`) so you can measure ns/op and allocs/op reliably — but only if you avoid the micro-bench traps the compiler sets for you.

---

## 1. Overview

Benchmarking in Go is a first-class part of the standard `testing` package. Any function shaped `func BenchmarkXxx(b *testing.B)` in a `_test.go` file becomes a measurable workload that `go test -bench` runs many times, reporting **nanoseconds per operation** and, with `-benchmem`, **bytes/op** and **allocs/op**.

The core idea is *self-calibration*. You don't tell Go how many times to run your code; you write a loop `for range b.N` (or the older `for i := 0; i < b.N; i++`), and the framework keeps increasing `b.N` until the run lasts long enough (default ~1 second) to produce a statistically stable number. The result is a per-operation cost you can track over time, compare across implementations, and feed into `benchstat` for statistical significance testing.

Benchmarking sits in the **Memory & Performance** category because in Go, *allocations* are usually the lever that matters more than raw CPU cycles: each allocation pressures the garbage collector, and `allocs/op` is frequently the single most actionable number a benchmark gives you.

> [!NOTE]
> A benchmark answers "how expensive is this code *in isolation*". It does **not** answer "is this the bottleneck of my service" — that's what profiling (`pprof`) and production tracing are for. Benchmark *after* profiling has pointed you at a hot path.

---

## 2. Why It Exists

Before `testing.B`, measuring Go code meant hand-rolling `time.Now()` deltas around a hard-coded loop — and getting it wrong. Three problems recur:

1. **Timer warm-up / cold caches.** The first iteration pays for code-cache misses, lazy initialization, and CPU frequency scaling. A fixed loop count bakes that noise into the average.
2. **Too few iterations.** A function that takes 50 ns measured once is dominated by clock resolution and scheduler jitter.
3. **No statistical rigor.** Two numbers (`new: 42ns`, `old: 45ns`) tell you nothing without variance.

`testing.B` exists to make correct measurement the *default path*. It auto-scales iterations, separates setup time from measured time (`ResetTimer`/`StopTimer`/`StartTimer`), and emits machine-parseable output that tooling (`benchstat`) turns into confidence intervals and p-values. It turns "I think this is faster" into "this is 18% faster ±2%, p=0.001".

---

## 3. Internal Working

A `testing.B` is a struct embedding `common` (shared with `testing.T`) plus benchmark-specific fields. The crucial ones:

```text
type B struct {
    common                 // mu, output, failed, name, ...
    N            int       // iteration count for THIS run (the b.N you loop on)
    benchTime    durationOrCount  // -benchtime: e.g. 1s or 1000x
    timerOn      bool      // is the wall-clock timer currently accumulating?
    start        time.Time // when StartTimer was last called
    duration     time.Duration    // accumulated measured time
    startAllocs  uint64    // mallocs snapshot at timer start
    startBytes   uint64    // heap bytes snapshot at timer start
    netAllocs    uint64    // accumulated allocs across the run
    netBytes     uint64    // accumulated bytes
    result       BenchmarkResult
}
```

The runner does an **adaptive doubling** search for `b.N`:

```text
 run with N=1
      |
      v
 measure duration d
      |
 d >= benchtime (~1s)? --yes--> done, compute ns/op = d/N
      |
      no
      v
 predict next N:  N_next = N * (benchtime / d)   (rounded up,
 capped at 100x growth, rounded to a "nice" number 1/2/5x10^k)
      |
      +--> re-run from scratch with N_next, timer reset
```

Each candidate `N` is a **fresh run** of `benchFunc` — the benchmark body is re-invoked with a clean timer, not resumed. That is why your setup code inside the function (but before the loop) runs on *every* attempt and why `b.ResetTimer()` after expensive setup is essential.

Memory accounting is exact, not sampled. `StartTimer` reads runtime malloc counters (`mallocs`, `total alloc bytes`) via a `runtime.MemStats` snapshot; `StopTimer` subtracts them. `allocs/op = netAllocs / N`. Because it counts the runtime's malloc events directly, a benchmark reporting `0 allocs/op` means the code path genuinely did not heap-allocate during the measured window (stack allocations and pooled reuse are invisible to it — which is exactly what you want).

`b.RunParallel` spins up `GOMAXPROCS` goroutines, each pulling iterations from a shared atomic counter via a `*PB` (parallel benchmark) handle, so you measure throughput under contention rather than single-threaded latency.

> [!WARNING]
> Because the framework re-runs the function for each `N`, never put per-iteration cleanup *outside* the loop assuming it runs once. And never rely on `b.N` having a particular value — it changes between runs and machines.

---

## 4. Syntax

```go
func BenchmarkFib(b *testing.B) {
    for b.Loop() { // Go 1.24+: cleaner than for i := 0; i < b.N; i++
        fib(20)
    }
}
```

Pre-1.24 idiom (still everywhere in the wild):

```go
func BenchmarkFib(b *testing.B) {
    for i := 0; i < b.N; i++ {
        fib(20)
    }
}
```

Key invocations:

| Command | Effect |
|---|---|
| `go test -bench=.` | Run all benchmarks |
| `go test -bench=Fib -benchmem` | Run matching, include alloc stats |
| `go test -bench=. -benchtime=5s` | Run each ~5 s for stability |
| `go test -bench=. -benchtime=10000x` | Run exactly 10 000 iterations |
| `go test -bench=. -count=10` | Repeat 10x (feed to benchstat) |
| `go test -bench=. -cpu=1,4,8` | Vary GOMAXPROCS |

The control surface inside the body:

- `b.ResetTimer()` — zero the clock and mem counters (after setup).
- `b.StopTimer()` / `b.StartTimer()` — exclude per-iteration setup.
- `b.ReportAllocs()` — force alloc reporting for this benchmark.
- `b.ReportMetric(v, "items/s")` — custom units.
- `b.SetBytes(n)` — enables an MB/s throughput column.
- `b.Run("case", fn)` — sub-benchmarks (table-driven).

---

## 5. Common Interview Questions

**Q1. What is `b.N` and who sets it?**
The iteration count for the current run. *You* loop over it; the *framework* sets it, ramping it up adaptively until the run lasts >= `-benchtime` (default 1s). *Follow-up: can you assume `b.N >= 1`?* Yes, the first run is always `N=1`, but you must never hard-code or branch on its value.

**Q2. Why call `b.ResetTimer()`?**
To exclude one-time setup (building a 1M-element map, opening a file) from the measured window. Without it, that cost is amortized across `b.N` and pollutes ns/op — worse, it's re-paid on every `N` candidate. *Follow-up: difference from `StopTimer`?* `ResetTimer` zeroes accumulated time once; `StopTimer`/`StartTimer` pause/resume around *per-iteration* setup inside the loop.

**Q3. My benchmark reports 0.25 ns/op. Real?**
Almost certainly the compiler **dead-code-eliminated** the work because the result is unused. Assign to a package-level `var sink` or pass to `runtime.KeepAlive`. *Follow-up: how does `b.Loop()` help?* Go 1.24's `b.Loop()` keeps loop-carried values alive and runs the body once per logical iteration without the optimizer hoisting it, defeating much of this DCE automatically.

**Q4. What does `allocs/op` tell you that `ns/op` doesn't?**
GC pressure. A function can be fast per-call yet allocate heavily, causing pauses and CPU burn under load. `allocs/op` is often the most actionable target — driving it to 0 (via `sync.Pool`, preallocation, or stack escape fixes) usually beats micro-optimizing arithmetic. *Follow-up: enable it?* `-benchmem` flag or `b.ReportAllocs()`.

**Q5. Why is `benchstat` needed instead of eyeballing two numbers?**
A single run has variance from scheduling, turbo boost, and GC timing. `benchstat` consumes `-count=N` samples from old and new, computes the median and a confidence interval, and reports a p-value — telling you whether a delta is *signal or noise*. *Follow-up: what test?* It uses a Mann–Whitney U test; treat changes that are statistically significant with a meaningful delta as real, and ignore ones it flags as noise.

**Q6. How do you benchmark concurrent code?**
`b.RunParallel(func(pb *testing.PB){ for pb.Next() { ... } })`, optionally with `b.SetParallelism`. It distributes iterations across `GOMAXPROCS` goroutines so you measure contention (lock/cache-line/atomic costs), not single-thread latency. *Follow-up: gotcha?* Per-goroutine state must be set up inside the closure, not shared, or you measure false contention.

**Q7. Why might a benchmark be faster than production?**
Warm caches, no real I/O, fixed input that hits a branch predictor / inlining sweet spot, and zero GC competition from other goroutines. Micro-benchmarks measure best-case isolation. *Follow-up: mitigate?* Use realistic input sizes, `-benchtime` long enough for GC to run, and validate against pprof from production.

**Q8. What is `testing.AllocsPerRun` and when do you use it?**
A helper that runs `fn` a fixed number of times and returns the average allocations — used *inside a regular `Test`* to assert an allocation budget (e.g. `if testing.AllocsPerRun(100, f) != 0 { t.Fatal(...) }`). *Follow-up: why not a benchmark?* Because you want a hard pass/fail gate in `go test`, not a number a human eyeballs.

---

## 6. Production Use Cases

- **Serialization libraries.** `encoding/json` vs `jsoniter` vs `easyjson` vs `protobuf` are all chosen via published benchmarks of ns/op and allocs/op. Uber's `zap` logger famously won adoption by benchmarking near-zero-allocation structured logging against `logrus`.
- **Regression gates in CI.** Cockroach Labs, Dgraph, and the Go team itself run benchmark suites with `benchstat` comparing PR-branch vs main, failing or flagging PRs that regress hot paths beyond a threshold (e.g. via `benchstat` + scripts, or tools like `benchdiff`).
- **Hot-path tuning in databases.** TiDB / CockroachDB benchmark encoding, comparator, and batch-iterator functions to keep per-row overhead in nanoseconds.
- **Standard library development.** Every `strings`, `bytes`, `sort`, and `slices` optimization in the Go tree ships with a benchmark and a `benchstat` diff in the commit message. The `sort` to pattern-defeating quicksort migration was justified entirely by benchmarks.
- **Allocation budgets.** Teams set hard `allocs/op` ceilings on request-handling middleware (auth, routing) and assert them, sometimes via `testing.AllocsPerRun`, so a careless `fmt.Sprintf` doesn't slip a heap alloc into every request.

---

## 7. Common Mistakes

> [!WARNING]
> These account for the vast majority of "my benchmark is wrong" reports.

1. **Dead-code elimination.** Computing a value and discarding it lets the optimizer delete the whole call. *Fix:* store to a package-level `var sink T`.
2. **Constant folding.** `BenchmarkAdd` over `2 + 3` is computed at compile time — you measure nothing. *Fix:* use non-constant inputs sourced from a var.
3. **Forgetting `ResetTimer` after setup.** Inflates ns/op and re-runs setup per `N` candidate.
4. **Allocating in the timed loop unintentionally.** A `[]byte` conversion or interface boxing adds allocs you didn't mean to measure. Run with `-benchmem` to catch it.
5. **Comparing single runs.** No `-count`, no `benchstat`, conclusions drawn from noise. CPU turbo and a background GC can swing one run by 20%.
6. **Shared mutable state across iterations.** Iteration 2 sees state mutated by iteration 1 (e.g. a now-sorted slice), so you benchmark the cheap case. Re-init inside `StopTimer`/`StartTimer`.

---

## 8. Performance Considerations

The benchmark *itself* has overhead, and you must reason about it:

- **Loop overhead** (counter increment, bounds check) is a few ns; for sub-nanosecond bodies it dominates. `b.Loop()` minimizes this.
- **Timer/mem snapshot cost** is paid once per `N` candidate, not per iteration — negligible unless you abuse `StopTimer`/`StartTimer` *inside* a tight loop, which adds ~tens of ns per call. Don't stop/start the timer millions of times.
- **`-benchtime`** trades stability for wall-clock. 1s is fine for stable ns/op; bump to 5s when variance is high or when GC behavior matters (a 1s run might not trigger a GC cycle).
- **CPU scaling & thermal throttling** on laptops are the #1 source of variance. Pin frequency or run on a quiet, dedicated CI box. Disable turbo for repeatable absolute numbers.
- **`SetBytes`** gives MB/s, which normalizes across input sizes and is the right metric for codecs and I/O paths.
- **GOMAXPROCS** matters for parallel benchmarks — always report `-cpu` settings; "300 ns/op" means nothing without knowing core count and contention.

---

## 9. Best Practices

- Use `b.Loop()` (Go 1.24+) — it handles keep-alive and one-time-per-run semantics correctly.
- Always run with `-benchmem`; treat `allocs/op` as a primary metric, not an afterthought.
- Use **sub-benchmarks** (`b.Run`) for table-driven size sweeps: `Small/Medium/Large` reveal complexity, not just a point estimate.
- Capture results to a file and diff with `benchstat`: `go test -bench=. -count=10 > new.txt; benchstat old.txt new.txt`.
- Defeat DCE with a package-level sink; defeat constant folding with runtime-sourced inputs.
- Keep setup outside the timed region (`ResetTimer`) and per-iteration setup excluded (`StopTimer`/`StartTimer`).
- Commit benchmarks alongside the code; gate regressions in CI with a threshold.
- Name and document the *machine* benchmarks ran on — absolute numbers are not portable.

---

## 10. Code Examples

Primary idiomatic example: a table-driven, sub-benchmarked comparison with a proper sink and alloc reporting.

```go
package strjoin

import (
	"strconv"
	"strings"
	"testing"
)

var sink string // defeats dead-code elimination

func joinPlus(parts []string) string {
	var s string
	for _, p := range parts {
		s += p
	}
	return s
}

func joinBuilder(parts []string) string {
	var b strings.Builder
	for _, p := range parts {
		b.WriteString(p)
	}
	return b.String()
}

func BenchmarkJoin(b *testing.B) {
	for _, n := range []int{8, 64, 512} {
		parts := make([]string, n)
		for i := range parts {
			parts[i] = "chunk"
		}
		tag := strconv.Itoa(n)

		b.Run("plus/"+tag, func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				sink = joinPlus(parts)
			}
		})
		b.Run("builder/"+tag, func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				sink = joinBuilder(parts)
			}
		})
	}
}
```

Alternative: a parallel throughput benchmark with `RunParallel`, plus the classic pre-1.24 loop and manual `KeepAlive`.

```go
var sinkInt int

func BenchmarkCacheGetParallel(b *testing.B) {
	c := NewCache()
	c.Set("k", 42)
	b.ResetTimer() // exclude the Set/setup above

	b.RunParallel(func(pb *testing.PB) {
		var local int
		for pb.Next() {
			local, _ = c.Get("k")
		}
		runtime.KeepAlive(local) // ensure the read isn't elided
	})
}

// Pre-Go-1.24 form, for reference:
func BenchmarkCacheGet(b *testing.B) {
	c := NewCache()
	c.Set("k", 42)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		sinkInt, _ = c.Get("k")
	}
}
```

A sample `benchstat` workflow and its output:

```text
$ go test -bench=Join -count=10 -benchmem > new.txt
$ benchstat old.txt new.txt
name              old time/op    new time/op    delta
Join/builder/512   1.42µs ± 2%    0.91µs ± 1%   -35.9%  (p=0.000 n=10)
name              old allocs/op  new allocs/op  delta
Join/builder/512     9.00 ± 0%      1.00 ± 0%   -88.9%  (p=0.000 n=10)
```

---

## 11. Advanced Concepts

- **`testing.AllocsPerRun(runs, fn)`** returns the average allocations for a function *outside* the benchmark loop — perfect for asserting an allocation budget in a regular `Test`: `if got := testing.AllocsPerRun(100, f); got != 0 { t.Fatalf("want 0 allocs, got %v", got) }`.
- **`b.ReportMetric`** lets you emit domain metrics — e.g. `b.ReportMetric(float64(rows)/seconds, "rows/s")` — which `benchstat` tracks and compares like any built-in metric. Setting the value to 0 for `ns/op` even *suppresses* the default column.
- **Inlining & escape analysis interplay.** `go test -bench=. -gcflags='-m'` shows what escaped to the heap. A benchmark showing unexpected allocs is often an escape-analysis failure (e.g. a value captured by an interface or closure). The benchmark is your *signal*; `-gcflags=-m` is the *diagnosis*.
- **`-benchtime=Nx`** for determinism. When you need exactly-equal iteration counts (e.g. comparing CPU-profile samples), pin with `100000x` instead of a duration.
- **Memory/CPU profiles from benchmarks.** `-memprofile mem.out -cpuprofile cpu.out` produces pprof files *from the benchmark*, closing the loop between "this is slow" and "here's the line".
- **PGO feedback.** Profiles collected from benchmarks (or production) can drive Profile-Guided Optimization (`-pgo`), letting the 1.21+ compiler inline hot calls — and you re-benchmark to confirm the win.

---

## 12. Debugging Tips

> [!TIP]
> When a benchmark looks impossibly fast (< 1 ns/op) or impossibly stable, suspect DCE or constant folding *first*.

- **Verify work happens:** temporarily `b.Log(sink)` or check that `-cpuprofile` shows samples in your function. No samples = optimized away.
- **Find phantom allocs:** `-benchmem`, then `-memprofile mem.out`, then `go tool pprof -alloc_objects mem.out` and `list YourFunc`.
- **Confirm escapes:** `go test -gcflags='-m' -bench=X 2>&1 | grep escapes`.
- **Diagnose variance:** run `-count=10` and look at the `± %` from benchstat. >5% means a noisy machine — close browsers, disable turbo, or move to CI.
- **Isolate setup leakage:** if ns/op shrinks as `-benchtime` grows, setup cost is leaking into the loop — you forgot `ResetTimer`.
- **Disassemble:** `go test -gcflags='-S'` to confirm the loop body wasn't hoisted out.

---

## 13. Senior Engineer Notes

A senior engineer treats a benchmark as **evidence in a PR**, not a vanity metric. In review, demand: a package-level sink (or `b.Loop()`), `-benchmem` numbers, and a `benchstat` diff over `-count>=10` — a lone "before/after" pair is a red flag you should push back on. Know the smell of a fake speedup: a 40% ns/op win with unchanged `allocs/op` on an allocation-heavy path is suspicious; conversely, dropping `allocs/op` from 9 to 1 is almost always a real, durable win because it reduces GC work that doesn't fully show up in a single-threaded ns/op.

Mentoring-wise, teach juniors that **allocations are the currency of Go performance** and that micro-benchmarks lie by omission (warm caches, no GC competition). Guide them to profile *first* — optimizing a function that's 0.3% of CPU is wasted effort no matter how green the benchmark turns. When approving optimizations, weigh the readability cost: a `sync.Pool` that shaves 50 ns but introduces a use-after-return footgun is rarely worth it outside a proven hot path. Your judgment call is *"is this complexity buying real, contended-path performance, and is it covered by a benchmark that will catch the regression when someone touches it next year?"*

---

## 14. Staff Engineer Notes

At staff level, benchmarking is an **organizational discipline**, not a per-function activity. The questions are about systems and incentives: does the org have a *continuous benchmarking* harness (golden machine, stable methodology, `benchstat`-based gates) so performance is defended automatically rather than rediscovered after an incident? Who owns it? Drift in CI hardware silently invalidates absolute thresholds, so staff engineers push for *relative* (branch-vs-main) gating and a dedicated, isolated runner — turbo disabled, pinned CPUs — because flaky perf gates erode trust faster than they catch regressions.

The cross-team trade-off is **signal vs. cost**: long `-benchtime`, high `-count`, and parallel sweeps give statistical power but inflate CI minutes across hundreds of PRs. Staff engineers set the policy — maybe full sweeps nightly, fast smoke benches per-PR. On build-vs-buy: standard `testing.B` + `benchstat` is almost always the right answer over commercial APM for *code-level* regression detection; reserve buying (Datadog, Pyroscope continuous profiling) for *production* hot-path discovery, then feed those profiles back into PGO and targeted benchmarks. Finally, staff engineers connect benchmarks to **SLOs**: a 35% allocs/op reduction in request middleware is only worth org attention if it moves p99 latency or unit cost (cores per million requests) — translate nanoseconds into dollars and tail latency before asking teams to prioritize the work.

---

## 15. Revision Summary

- `func BenchmarkXxx(b *testing.B)`; loop with `b.Loop()` (1.24+) or `for i := 0; i < b.N; i++`.
- **You loop over `b.N`; the framework sets it**, doubling adaptively until ~`-benchtime` (default 1s). Each candidate `N` re-runs the function from scratch.
- `-benchmem` → `bytes/op` + `allocs/op`; **allocs/op is usually the most actionable metric** (GC pressure).
- `b.ResetTimer()` excludes setup; `StopTimer`/`StartTimer` exclude per-iteration setup; `b.SetBytes` enables MB/s.
- **Traps:** dead-code elimination (use a package `sink`), constant folding (use runtime inputs), missing `ResetTimer`, single-run conclusions.
- `b.RunParallel` measures contention across `GOMAXPROCS`; report `-cpu`.
- **`benchstat`** over `-count>=10` gives medians, ± variance, and p-values — required to call a delta real.
- `testing.AllocsPerRun` asserts allocation budgets in plain tests; `-memprofile`/`-cpuprofile` bridge benchmarks to pprof; profiles feed PGO.
- Absolute numbers aren't portable — pin the machine; prefer relative (branch-vs-main) CI gates.

**References:** Go `testing` package docs (`pkg.go.dev/testing` — `B`, `B.Loop`, `B.ResetTimer`, `B.RunParallel`, `AllocsPerRun`); `golang.org/x/perf/cmd/benchstat`; Go blog & wiki on benchmarking and Profile-Guided Optimization.

---
*Go Engineering Handbook — topic 55.*
