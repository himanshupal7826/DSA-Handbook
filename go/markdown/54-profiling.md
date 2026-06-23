# 54 · Profiling

> **In one line:** Profiling captures where your Go program spends CPU, allocates memory, and stalls on synchronization so you can fix the *real* bottleneck instead of the one you guessed.

---

## 1. Overview

Profiling is the discipline of measuring a running program to find out where its resources actually go. Go ships with a first-class profiler called **pprof**, baked into the runtime and standard library (`runtime/pprof`, `net/http/pprof`, `runtime/trace`). Unlike a debugger, a profiler answers aggregate questions: *which functions burn CPU?*, *which call sites allocate the most heap?*, *where do goroutines block on channels or mutexes?*

Go supports four standard profile types:

| Profile | Question it answers | Mechanism |
|---|---|---|
| **CPU profile** | Where is CPU time spent? | Sampling via OS timer signal (~100 Hz) |
| **Heap profile** | What allocates memory and what stays live? | Sampling every ~512 KB allocated |
| **Block profile** | Where do goroutines block (chan, mutex, select)? | Event timing, rate-sampled |
| **Mutex profile** | Where is lock contention? | Sampled on contended unlock |

The golden rule of profiling: **measure, don't guess.** Engineers are notoriously bad at predicting bottlenecks. A profile turns intuition into evidence.

---

## 2. Why It Exists

Performance problems in production rarely live where you think. A service that "feels slow" might spend 60% of its CPU in JSON marshaling, garbage collection, or a regex compiled inside a hot loop. Without measurement you optimize the wrong thing, ship a more complex codebase, and the latency graph doesn't move.

Profiling exists to answer three recurring engineering needs:

1. **Cost attribution** — In cloud environments, CPU and memory are line items. A 30% CPU reduction can mean shutting down a third of your fleet. Profiles tell you *where* that 30% lives.
2. **Latency debugging** — p99 spikes are often contention (mutex/block profile) or GC pressure (heap profile), not raw compute.
3. **Capacity planning** — Knowing the allocation rate and live-heap size lets you size instances and tune `GOGC`/`GOMEMLIMIT`.

Go made profiling a *built-in* rather than a third-party afterthought because Google's internal systems already relied on pprof for C++; bringing it to Go meant the same `go tool pprof` workflow worked across languages. The Go blog's "Profiling Go Programs" article (still foundational) showed a real program going from 8s to under 1s by following the profile.

---

## 3. Internal Working

Each profile type uses a different runtime mechanism. Understanding them prevents misreading the output.

**CPU profiling** is *sampling-based*. When you call `pprof.StartCPUProfile`, the runtime arms an OS timer (`setitimer`/`timer_create`) to deliver `SIGPROF` at ~100 Hz to each OS thread. The signal handler (`sigprof` in `runtime/proc.go`) walks the current goroutine's stack and records the PC chain into a lock-free per-thread buffer (`cpuprof`). A dedicated goroutine drains these buffers and writes protobuf-encoded samples. Because it samples, a function appearing in 30% of samples is consuming ~30% of CPU — it never observes *every* call, which is exactly why overhead stays low (single-digit %).

**Heap profiling** hooks the allocator. `mallocgc` keeps a counter; on average every `MemProfileRate` bytes allocated (default 512 KB), it records a *sampled* allocation by walking the stack and storing the call site in a hash table (`memRecord`) keyed by stack trace. The runtime tracks both `alloc` (cumulative) and `inuse` (live, decremented when the GC frees the object). That is why a heap profile distinguishes `inuse_space` (current live bytes — leaks) from `alloc_space` (total churn — GC pressure).

**Block and mutex profiles** are *event-based with rate sampling* and are **off by default**. `runtime.SetBlockProfileRate(n)` records a blocking event with probability proportional to the time blocked (1 in `n` nanoseconds). `runtime.SetMutexProfileFraction(n)` records 1 in every `n` contended mutex unlocks. Both store stack-keyed records.

```text
   Program threads (M)                     Runtime collectors
 ┌──────────────────┐   SIGPROF (100Hz)   ┌────────────────────┐
 │ goroutine on CPU │ ──────────────────► │ cpuprof lock-free  │
 └──────────────────┘   stack walk        │ per-P buffers      │
                                          └─────────┬──────────┘
 ┌──────────────────┐  every ~512KB                │ drain
 │ mallocgc()       │ ──────────────────► ┌─────────▼──────────┐
 └──────────────────┘  sampled alloc      │ memRecord hashmap  │
                                          │ keyed by stacktrace│
 ┌──────────────────┐  contended unlock   └─────────┬──────────┘
 │ lock2()/chanrecv │ ──────────────────►           │
 └──────────────────┘  rate-sampled        protobuf encode
                                                     ▼
                                          pprof profile (.pb.gz)
```

All four ultimately serialize to the same **pprof protobuf format** (`profile.proto`): a set of *samples*, each a stack of *locations* with one or more numeric *values*, plus a string table. `go tool pprof` reads this format regardless of source, which is why one tool visualizes CPU, heap, and even non-Go profiles.

---

## 4. Syntax

Three entry points, depending on whether you profile a binary, a test, or a live server.

**Programmatic (`runtime/pprof`):**

```go
import (
	"os"
	"runtime"
	"runtime/pprof"
)

// CPU profile around a workload.
f, _ := os.Create("cpu.pprof")
pprof.StartCPUProfile(f)
defer pprof.StopCPUProfile()

// Heap snapshot at a point in time.
hf, _ := os.Create("heap.pprof")
runtime.GC() // get up-to-date live numbers
pprof.WriteHeapProfile(hf)
hf.Close()

// Enable block + mutex collection (off by default).
runtime.SetBlockProfileRate(1)     // record every blocking event (expensive)
runtime.SetMutexProfileFraction(1) // record every contended unlock
```

**HTTP endpoint (`net/http/pprof`):** importing the package registers handlers on `DefaultServeMux`.

```go
import _ "net/http/pprof"

go func() { http.ListenAndServe("localhost:6060", nil) }()
// then: go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30
```

**Go test integration** (no code changes):

```text
go test -cpuprofile cpu.pprof -memprofile mem.pprof -bench .
go tool pprof cpu.pprof                # interactive CLI
go tool pprof -http=:8080 cpu.pprof    # flame graph in browser
```

---

## 5. Common Interview Questions

**Q1. Is Go's CPU profiler sampling or instrumented? Why does it matter?**
Sampling — it interrupts at ~100 Hz via `SIGPROF` and records the stack. Overhead stays low (single-digit %) and roughly constant regardless of function count, but short-lived functions called rarely may not appear. *Follow-up: how would you profile something faster than 100 Hz?* You largely can't (signal delivery and runtime limits cap it near a few hundred Hz); instead use `runtime/trace` or benchmark the hot path in isolation.

**Q2. Difference between `inuse_space` and `alloc_space` in a heap profile?**
`inuse_space` is currently-live bytes (find leaks / steady-state footprint); `alloc_space` is cumulative bytes ever allocated (find GC pressure / churn). A function with huge `alloc_space` but tiny `inuse_space` allocates a lot of short-lived garbage. *Follow-up: which chases a memory leak?* `inuse_space`, compared across two snapshots minutes apart.

**Q3. Why are block and mutex profiles disabled by default?**
They add per-event overhead on hot synchronization paths. At rate 1, every blocking operation pays a stack walk, which can dominate a lock-heavy program. You enable them temporarily with a sampling rate. *Follow-up: what rate is safe in production?* `SetMutexProfileFraction(100)` (1% of contention events) keeps overhead negligible while still revealing hot locks.

**Q4. A function shows high CPU but you "know" it's trivial. What's happening?**
Check *flat* vs *cum* columns — high cum / low flat means children are the cost. Also watch for `runtime.mallocgc`, `runtime.gcBgMarkWorker`, or `runtime.memmove`, which point to allocation/GC rather than your logic. *Follow-up: define flat vs cum.* Flat is time *in* the function itself; cum includes callees.

**Q5. How do you profile a production service without restarting it?**
Import `net/http/pprof`, bind it to a localhost or auth-protected port, and pull profiles on demand (`/debug/pprof/profile?seconds=30`). For always-on, use continuous profiling (Pyroscope, Google Cloud Profiler, Datadog). *Follow-up: security risk?* The endpoints expose stack traces and let anyone trigger a 30s CPU profile (DoS-ish); never expose them on a public mux.

**Q6. What does the `seconds` parameter on the CPU endpoint do, and a good default?**
It sets the collection window; the handler blocks for that duration then returns the profile. 30s is reasonable — enough samples across requests, short enough to react. *Follow-up: too short?* Under ~5s you get too few samples and noisy, misleading results.

**Q7. How do you compare two profiles to see if an optimization worked?**
`go tool pprof -base=before.pprof after.pprof` shows the delta; negative values mean improvement. *Follow-up: pitfall?* Both must be collected under equivalent load, or the diff is meaningless.

**Q8. The CPU profile shows nothing for a latency-bound handler. Why?**
Go's CPU profiler only samples *on-CPU* time; a goroutine blocked on I/O or a lock is invisible. Use `fgprof` (on+off-CPU), the block profile, or `runtime/trace`. *Follow-up: which for GC pauses?* The execution tracer.

---

## 6. Production Use Cases

- **Cloudflare** has publicly documented using Go pprof and continuous profiling on edge proxy paths, finding hot spots in regex and TLS handling.
- **Datadog** ships a continuous Go profiler in its APM agent; teams correlate CPU/heap profiles with traces to attribute latency to specific code.
- **Grafana Pyroscope** (open source) and **Google Cloud Profiler** scrape `/debug/pprof` continuously, storing low-overhead profiles so you can diff "now vs last week" and answer "what got slow after the deploy?"
- **Kubernetes / etcd** maintainers routinely attach heap profiles to issues to diagnose memory growth; their debug paths expose pprof.
- **Allocation-rate firefighting:** wire a `/debug/pprof` admin port behind an internal load balancer, then during an incident pull a 30s CPU profile and a heap profile and diff against a baseline stored in object storage.

The recurring production pattern: **always-on low-rate continuous profiling** plus **on-demand high-resolution capture** during incidents.

---

## 7. Common Mistakes

> [!WARNING]
> Exposing `net/http/pprof` on a public-facing mux. Because importing it mutates `http.DefaultServeMux`, a service that also serves user traffic on that mux leaks profiling endpoints to the internet. Always use a separate, internal-only `http.Server`.

- **Reading a heap profile without `runtime.GC()` first.** Live (`inuse`) numbers reflect the last GC; force one for accuracy.
- **Forgetting to `StopCPUProfile`.** The deferred stop must run, or the file is truncated/empty.
- **Profiling a debug build or under a debugger.** Numbers are skewed; profile optimized builds under realistic load.
- **Leaving block/mutex rate at 1 in production** — measurable overhead on hot locks.
- **Trusting a 2-second CPU profile** — too few samples; results are noise.
- **Confusing flat and cum** and "optimizing" a function whose cost is entirely in its callees.
- **Profiling on a laptop and extrapolating to prod** — different CPU, cache, NUMA, and load patterns yield different bottlenecks.

---

## 8. Performance Considerations

CPU profiling overhead is typically **1-5%** because it's sampling; you can run it in production for 30s windows safely. Heap profiling overhead is tied to `MemProfileRate` — the default 512 KB sampling is cheap; setting it to 1 (sample every allocation) is accurate but can noticeably slow allocation-heavy code, so reserve it for targeted debugging.

Block and mutex profiles are the expensive ones. At rate 1 they walk the stack on *every* contended event; for a lock taken millions of times per second this is catastrophic. Use `SetMutexProfileFraction(100)` (1%) as a sane production setting and `SetBlockProfileRate(10000)` (sample blocks averaging >10µs) to bound overhead.

The execution **tracer** (`runtime/trace`) is heavier than pprof but answers different questions (scheduler latency, GC pauses, goroutine timelines). Don't reach for it when a CPU profile suffices.

> [!TIP]
> Continuous profilers keep overhead under ~1% by using *low* sample rates and short rotating windows. That's the right default posture for fleet-wide always-on profiling.

---

## 9. Best Practices

- **Profile under representative load.** A profile from an idle service is useless.
- **Diff, don't stare.** Use `-base` to compare before/after; absolute profiles are hard to judge.
- **Isolate the hot path in a benchmark** when possible — `go test -bench -cpuprofile` gives reproducible, low-noise profiles.
- **Run pprof on a separate internal port**, firewalled or auth-gated.
- **Capture multiple profile types together** during incidents: CPU + heap (`inuse` and `alloc`) + goroutine. The combination tells a coherent story.
- **Store baselines.** Keep a known-good profile in object storage so you can diff after every release.
- **Use flame graphs** (`-http=:8080`) for fast visual triage; use `top`/`list` in the CLI for precision.
- **Annotate with labels** (`pprof.Do`) to split CPU by tenant, endpoint, or request type.

---

## 10. Code Examples

Primary: a complete program that exposes pprof over an internal port and uses profiler labels to attribute CPU to logical work.

```go
package main

import (
	"context"
	"log"
	"net/http"
	_ "net/http/pprof"
	"runtime/pprof"
)

func main() {
	// Internal-only profiling server. Never share the user-facing mux.
	go func() {
		log.Println(http.ListenAndServe("localhost:6060", nil))
	}()

	for i := 0; ; i++ {
		// Labels show up in the CPU profile, splitting cost by tenant.
		tenant := "tenantA"
		if i%2 == 0 {
			tenant = "tenantB"
		}
		ctx := context.Background()
		pprof.Do(ctx, pprof.Labels("tenant", tenant), func(context.Context) {
			expensiveWork()
		})
	}
}

func expensiveWork() {
	sum := 0
	for i := 0; i < 1_000_000; i++ {
		sum += i % 7
	}
	_ = sum
}
```

Alternative: writing CPU and heap profiles directly to files around a one-shot batch job, no HTTP server needed.

```go
package main

import (
	"os"
	"runtime"
	"runtime/pprof"
)

func main() {
	cpu, _ := os.Create("cpu.pprof")
	if err := pprof.StartCPUProfile(cpu); err != nil {
		panic(err)
	}
	runBatch()
	pprof.StopCPUProfile() // must run before exit
	cpu.Close()

	// Heap snapshot reflecting live objects after a forced GC.
	mem, _ := os.Create("heap.pprof")
	runtime.GC()
	if err := pprof.WriteHeapProfile(mem); err != nil {
		panic(err)
	}
	mem.Close()
}

func runBatch() { /* ... real work ... */ }
```

Inspect either with the interactive tool. Useful commands once inside `go tool pprof cpu.pprof`:

```text
top10                 # top 10 functions by flat time
top -cum              # sort by cumulative (callees included)
list expensiveWork    # annotated source with per-line cost
web                   # SVG call graph (needs graphviz)
peek mallocgc         # callers/callees of a function
```

---

## 11. Advanced Concepts

**Profiler labels** (`pprof.Labels`, `pprof.Do`) attach key/value tags to CPU samples, letting you slice a single profile by request type, tenant, or endpoint — invaluable in multiplexed services. Labels attach to CPU and goroutine profiles, not heap.

**Delta profiling for heap** — `go tool pprof -base` on two heap snapshots is the canonical leak hunt: capture, wait, capture, diff `inuse_space`.

**Symbolization and PGO** — profiles store PCs; the tool symbolizes them against the binary. Since Go 1.21, **Profile-Guided Optimization** consumes a CPU profile (`default.pgo`) to drive inlining and devirtualization decisions, often yielding 2-7% throughput improvements. This makes profiling not just diagnostic but a build input.

**fgprof** (felixge/fgprof) addresses a blind spot: Go's CPU profiler only samples *on-CPU* time, so a goroutine blocked on I/O is invisible. fgprof samples *all* goroutines (on- and off-CPU) to show wall-clock hot spots, complementing the standard CPU profile.

**The tracer** (`runtime/trace`) gives nanosecond-resolution scheduler, GC, and syscall events — use it when "why is my p99 latency high?" isn't explained by CPU or contention profiles (e.g., GC pauses or scheduler starvation).

---

## 12. Debugging Tips

- **Empty CPU profile?** You forgot `StopCPUProfile`, the program exited before it ran, or there was no on-CPU work (try fgprof).
- **`list` shows no source** — the binary lacks the source or was stripped; pass the binary path: `go tool pprof ./mybinary cpu.pprof`.
- **`web`/`svg` fails** — install graphviz, or use the browser flame graph `-http=:8080`, which doesn't need it.
- **Goroutine leak suspected** — pull `/debug/pprof/goroutine?debug=2` for full stacks of every goroutine; a steadily climbing count is the smoking gun.
- **Heap numbers look stale** — force `runtime.GC()` before `WriteHeapProfile`.
- **Mutex profile empty** — you didn't call `SetMutexProfileFraction(n)` with `n > 0`.
- **Live capture in prod:** `curl -o cpu.pprof "http://localhost:6060/debug/pprof/profile?seconds=30"` then analyze locally.

> [!NOTE]
> `/debug/pprof/` in a browser lists every available profile and its current sample count — a fast sanity check that collection is enabled.

---

## 13. Senior Engineer Notes

A senior engineer treats profiling as a *default reflex*, not a last resort. Before approving a performance PR, ask for the *before/after profile diff* — "it's faster on my machine" is not evidence. In code review, watch for the patterns profiles repeatedly expose: allocations in hot loops (slice/map growth without pre-sizing, `fmt.Sprintf` on hot paths, interface boxing), and mutexes held across I/O.

Mentor juniors on **flat vs cum** and on the difference between `inuse` and `alloc` — these two confusions cause the most wasted optimization effort. Teach them to isolate a suspected hot path into a `go test -bench` so the profile is reproducible and the optimization is measurable.

Judgment call: don't micro-optimize functions that show <1-2% in the profile; complexity cost outweighs the gain. Optimize the top of the profile or don't bother. And remember the cheapest optimization is often *fewer allocations* (reducing GC work), which a heap profile reveals faster than staring at CPU.

---

## 14. Staff Engineer Notes

At the org level, the question shifts from "how do I profile this service" to "how does every team get profiling for free." Standardize a **continuous profiling** platform (Pyroscope, Cloud Profiler, Datadog) in the service template so every new service ships with low-overhead always-on profiles and a stored baseline. This is the build-vs-buy decision: self-hosting Pyroscope is cheap and keeps data in-house; managed profilers reduce ops burden but add cost and a vendor dependency — decide based on fleet size and data-residency constraints.

Drive **PGO into the build pipeline**: collect representative production CPU profiles, feed them as `default.pgo`, and you get a few percent fleet-wide throughput essentially for free — at thousands of instances that's real money. Establish governance for which profiles count as "representative" and how often they refresh.

Cross-team, enforce the **security posture**: pprof endpoints must never reach the public mux; codify this in a linter or service-mesh policy. Finally, frame profiling in **cost terms** to leadership — a profile-driven 25% CPU reduction is a concrete cloud-bill line item, which is how performance work earns prioritization against feature work.

---

## 15. Revision Summary

- Go has four standard profiles: **CPU** (sampling, ~100 Hz via SIGPROF), **heap** (sampled per ~512 KB alloc), **block**, **mutex** (event-based, off by default, rate-sampled).
- Heap profile: **`inuse_space`** = live bytes (leaks); **`alloc_space`** = cumulative churn (GC pressure). Force `runtime.GC()` before snapshotting.
- Profile flat = time *in* function; cum = including callees. Optimize the *top* of the profile only.
- Enable contention profiles with `SetBlockProfileRate` / `SetMutexProfileFraction`; use sampling rates in prod (e.g. fraction 100).
- Access via `runtime/pprof` (files), `net/http/pprof` (live, internal-only port), or `go test -cpuprofile/-memprofile`.
- Analyze with `go tool pprof` (`top`, `list`, `web`, `-base` for diffs, `-http=:8080` for flame graphs).
- CPU profiler only sees on-CPU time; use **fgprof**, block profile, or the tracer for I/O/latency stalls.
- Advanced: profiler **labels** for per-tenant slicing, **PGO** (Go 1.21+) consumes a CPU profile to guide inlining.
- Security: never expose pprof on the public mux. Cost: profile-driven CPU cuts map directly to cloud spend.

**References:** Go blog — "Profiling Go Programs"; `runtime/pprof`, `net/http/pprof`, `runtime/trace` package docs; Go 1.21 Profile-Guided Optimization docs; `felixge/fgprof`; Grafana Pyroscope / Google Cloud Profiler.

---
*Go Engineering Handbook — topic 54.*
