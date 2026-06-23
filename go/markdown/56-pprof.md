# 56 · pprof

> **In one line:** `pprof` is Go's built-in sampling profiler and tracing toolchain for diagnosing CPU, memory, contention, and latency problems — in tests, in benchmarks, and live in production.

---

## 1. Overview

`pprof` is the umbrella name for two things in the Go ecosystem: the **runtime profiling machinery** (`runtime/pprof`, `runtime/trace`) that *produces* profile data, and the **analysis tool** (`go tool pprof`) that *consumes* it and renders flame graphs, call graphs, top lists, and annotated source. The `net/http/pprof` package glues the two together by exposing live profiles over HTTP so you can profile a running process without restarting it.

A profile is a statistical *sample* of program behavior: where CPU time goes, what is holding heap memory, which goroutines are blocked, where lock contention happens. Because it is sampled (not instrumented per-call), the overhead is low enough to leave enabled — or quickly toggle — in production.

The mental model: **profiles answer "where is the cost concentrated?"** A *trace* (via `runtime/trace`) answers a different question — "what happened, in time order, across goroutines, GC, and the scheduler?" Senior engineers reach for profiles for hotspots and traces for latency/tail/scheduling mysteries.

## 2. Why It Exists

Before profilers, performance work was guesswork: developers read code, "knew" what was slow, optimized the wrong thing, and shipped. The famous Knuth line — *premature optimization is the root of all evil* — has a less-quoted companion: you must **measure** first. `pprof` exists to make measurement cheap, repeatable, and visual.

Go shipped `pprof` (a descendant of Google's internal C++ profiler) from very early on because Go targets servers, where the questions are always: *Why is p99 latency spiking? Why is the heap growing? Why is CPU pinned at 100%?* Answering these in a long-running service demands **live, low-overhead, always-available** introspection — hence `net/http/pprof`, which makes any HTTP server self-diagnosable.

It also exists to standardize the **profile.proto** format, so the same `go tool pprof` UI works across CPU, heap, mutex, block, and goroutine profiles, and even consumes non-Go profiles.

## 3. Internal Working

There are two distinct mechanisms: **sampling profilers** and **counter/event profiles**.

**CPU profiling** is signal-based. When you start it, the runtime asks the OS to deliver `SIGPROF` at ~100 Hz (every 10 ms) via `setitimer`/`timer_create`. The signal handler runs on whatever thread (M) is executing, walks the current goroutine's stack, and records the program counters into a lock-free per-thread buffer. A background goroutine drains these buffers into the profile. Because it is signal-driven, it captures *on-CPU* time only — a goroutine blocked on I/O contributes nothing.

**Heap profiling** is allocation-sampled. The runtime samples roughly one allocation per `MemProfileRate` bytes (default 512 KiB). On each sampled allocation it records the call stack plus bytes/objects allocated and (when freed) released. This gives both `inuse_space` (live heap) and `alloc_space` (cumulative) views.

**Block** and **mutex** profiles are event-counted: when a goroutine blocks on a channel/lock or contends on a mutex, the runtime records the stack and the nanoseconds waited, sampled per `SetBlockProfileRate` / `SetMutexProfileFraction`.

**Goroutine** profile is a full stack dump of every goroutine — a snapshot, not a sample.

```text
        ┌─────────────────────────────────────────────┐
        │              Go runtime                      │
        │                                              │
 SIGPROF│   ┌──────────┐   walk stack   ┌───────────┐  │
 ~100Hz─┼──▶│ M (OS    │───────────────▶│ per-P     │  │
        │   │ thread)  │   record PCs    │ profBuf   │  │
        │   └──────────┘                 └─────┬─────┘  │
        │   alloc ─────▶ sample every 512KiB   │        │
        │                                      ▼        │
        │                              ┌───────────────┐│
        │                              │ profile.proto ││
        │                              └───────┬───────┘│
        └──────────────────────────────────────┼───────┘
                                                ▼
                            net/http/pprof  →  go tool pprof
                            (HTTP endpoint)     (flame graph / top / list)
```

The on-disk/on-wire format is **gzip-compressed `profile.proto`** (a protobuf). It stores a sample table: each sample is a stack (list of locations) plus values (e.g. `[cpu_nanoseconds]` or `[inuse_objects, inuse_space]`). Symbolization maps PCs to function/file/line either inline (binary has symbols) or via the original binary passed to `go tool pprof`.

`runtime/trace` is different: it is a high-resolution **event log**, not a sampler. It records goroutine create/start/block, GC phases, syscalls, and scheduler latency with nanosecond timestamps, viewable in the `go tool trace` web UI.

## 4. Syntax

Enable the HTTP endpoints (the import has a side-effect: it registers handlers on `http.DefaultServeMux`):

```go
import _ "net/http/pprof" // registers /debug/pprof/* on DefaultServeMux

func main() {
	go func() {
		// Dedicated, non-public port. Never expose to the internet.
		log.Println(http.ListenAndServe("localhost:6060", nil))
	}()
	// ... your real server ...
}
```

Programmatic profiling (for short-lived programs, tests, batch jobs):

```go
f, _ := os.Create("cpu.prof")
pprof.StartCPUProfile(f) // from runtime/pprof
defer pprof.StopCPUProfile()

// heap snapshot
hf, _ := os.Create("heap.prof")
runtime.GC()
pprof.WriteHeapProfile(hf)
hf.Close()
```

Common analysis commands:

```text
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30  # 30s CPU
go tool pprof http://localhost:6060/debug/pprof/heap                # heap
go tool pprof -http=:8080 cpu.prof                                  # web UI + flame graph
go test -cpuprofile cpu.prof -memprofile mem.prof -bench .
go tool trace trace.out
```

## 5. Common Interview Questions

**Q1. How does Go's CPU profiler work, and what does it miss?**
It uses `SIGPROF` at ~100 Hz; on each signal it walks the running goroutine's stack and records PCs. It only measures **on-CPU** time, so time spent blocked on I/O, channels, or locks is invisible — use block/mutex profiles or a trace for those.
*Follow-up: Why might profiled CPU be lower than wall-clock time?* Because the program spent time off-CPU (waiting), which CPU profiles don't count.

**Q2. Difference between `inuse_space` and `alloc_space`?**
`inuse_space` is memory currently live on the heap (good for finding leaks / steady-state footprint). `alloc_space` is cumulative bytes ever allocated (good for finding allocation churn driving GC pressure even if it's freed quickly).
*Follow-up: Which finds a goroutine/closure leak holding a big slice?* `inuse_space`.

**Q3. How do you safely expose pprof in production?**
Bind it to `localhost` or a separate admin port behind auth; never on the public listener. Use a separate `http.ServeMux` instead of `DefaultServeMux` to avoid leaking endpoints. Access via SSH tunnel or service mesh.
*Follow-up: Why is the blank import dangerous on the main mux?* It registers `/debug/pprof/*` on whatever `DefaultServeMux` your main server uses — instant unauthenticated exposure.

**Q4. CPU profile vs. execution trace — when each?**
Profile = "where is time spent" (hotspots, sampled). Trace = "what happened when" (scheduler latency, GC pauses, goroutine blocking, time-ordered). Use a trace for tail-latency and concurrency mysteries.
*Follow-up: You see p99 spikes but flat CPU profile — next step?* Capture a trace; likely GC pauses, scheduler starvation, or lock contention.

**Q5. What is a flame graph and how do you read it?**
Stacked horizontal bars where width = proportion of samples (cost) and the y-axis = call stack depth. Wide boxes are where time/memory concentrates. Look for wide leaf frames, not tall stacks.
*Follow-up: What's a "differential" / inverted flame graph?* Inverted (icicle) groups by leaf to find a hot function called from many places; differential compares two profiles.

**Q6. How do you profile memory allocations vs. live memory?**
`alloc_objects`/`alloc_space` for churn; `inuse_objects`/`inuse_space` for what's resident. Set `runtime.MemProfileRate` lower for more fidelity (more overhead).
*Follow-up: Heap profile shows nothing but RSS is huge — why?* Could be off-heap (cgo, mmap), fragmentation, or GC not returning memory to OS (madvise behavior / `GOGC`/`GOMEMLIMIT`).

**Q7. How do block and mutex profiles differ?**
Block profile records *any* blocking (channels, select, mutex, cond) and duration; mutex profile records *contention* specifically on `sync.Mutex`/`RWMutex`. Both are off by default and must be enabled with a rate.
*Follow-up: Why off by default?* Non-trivial overhead per event; you opt in when investigating.

## 6. Production Use Cases

- **Continuous profiling**: Google's internal "Google-Wide Profiling" pioneered always-on, low-overhead fleet profiling; the open-source descendants are **Grafana Pyroscope**, **Polar Signals / Parca**, **Datadog Continuous Profiler**, and **Pixie**. They periodically scrape `/debug/pprof/profile` and store profiles for time-travel analysis.
- **Live incident diagnosis**: Cloudflare, Uber, and Dropbox have public write-ups of using `net/http/pprof` to find CPU regressions and goroutine leaks in production Go services during incidents.
- **Memory leak hunting**: comparing two heap profiles (`go tool pprof -base old.prof new.prof`) to find what grew between two snapshots — standard practice for catching slow leaks in long-running daemons.
- **Benchmark-driven optimization**: every serious Go library (e.g. `encoding/json` alternatives like `sonic`, gRPC-Go) uses `go test -bench -cpuprofile` to guide hand-tuned hotpaths.
- **CI regression gates**: storing baseline profiles and flagging allocation/CPU regressions in pull requests.

## 7. Common Mistakes

- **Blank-importing `net/http/pprof` into the public server**, exposing `/debug/pprof/*` to the internet (a known data-exfiltration and DoS vector — the `profile` endpoint blocks 30s and burns CPU).
- **Profiling a debug build or a process under a debugger**, getting misleading inlining/optimization data.
- **Forgetting `runtime.GC()` before a heap snapshot**, so freed-but-not-collected memory pollutes `inuse` numbers.
- **Reading a CPU profile and concluding the program is "fast" when it's I/O-bound** — the profile only saw on-CPU time.
- **Profiling for too short a window** (1–2 s) and trusting noisy samples; CPU profiles need enough samples (tens of seconds) to be statistically meaningful.
- **Symbolizing against the wrong binary**, producing nonsense function names. Always pair the profile with the exact binary that produced it.

## 8. Performance Considerations

CPU profiling overhead is typically **1–5%** — the cost of a stack walk every 10 ms per running thread. Heap profiling at the default 512 KiB sample rate is nearly free; lowering `MemProfileRate` to 1 ("profile every allocation") can add significant overhead and is rarely needed.

Block and mutex profiling have **per-event** cost, so a hot lock can make them measurably expensive — enable them at a fraction (e.g. `SetMutexProfileFraction(100)` samples 1/100 contention events) and only while investigating.

`runtime/trace` is the heaviest: it logs every scheduler event, so it can add 10–30% overhead and produce large files. Capture short windows (1–5 s) under load.

> [!NOTE]
> Sampling rate is a fidelity/overhead trade-off. 100 Hz CPU sampling can *miss* very short, frequent functions. For sub-millisecond hotpaths, increase samples by profiling longer rather than cranking the rate (the rate is capped on most platforms anyway).

## 9. Best Practices

- Expose pprof on a **separate admin mux and port**, bound to localhost or behind auth.
- Profile **under realistic load**, ideally in staging that mirrors production, or carefully in production during an incident.
- Always profile a **release/optimized build** (`go build`, not `-gcflags="all=-N -l"`).
- Use **labels** (`pprof.Do` / `pprof.SetGoroutineLabels`) to tag profiles by request type, tenant, or endpoint so flame graphs can be filtered.
- Compare profiles with `-base` / `-diff_base` instead of eyeballing absolute numbers.
- Store baseline profiles in CI and diff on each change.
- Prefer the **web UI** (`-http=:8080`) for flame graphs; use `top`, `list <func>`, and `peek` in the terminal for surgical drill-down.

## 10. Code Examples

A production-grade setup with a dedicated admin server and profiling labels:

```go
package main

import (
	"context"
	"log"
	"net/http"
	"net/http/pprof"
	"runtime"
	"time"
)

func main() {
	// Capture block & mutex contention (off by default).
	runtime.SetBlockProfileRate(10_000)   // sample 1 block / 10µs of blocking
	runtime.SetMutexProfileFraction(100)  // sample 1/100 contention events

	// Dedicated admin mux — NOT the public DefaultServeMux.
	admin := http.NewServeMux()
	admin.HandleFunc("/debug/pprof/", pprof.Index)
	admin.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	admin.HandleFunc("/debug/pprof/profile", pprof.Profile)
	admin.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	admin.HandleFunc("/debug/pprof/trace", pprof.Trace)

	go func() {
		log.Println(http.ListenAndServe("localhost:6060", admin))
	}()

	// Real work, tagged so profiles can be sliced by endpoint.
	for {
		serveRequest(context.Background(), "checkout")
		time.Sleep(time.Millisecond)
	}
}

func serveRequest(ctx context.Context, route string) {
	pprof.Do(ctx, pprof.Labels("route", route), func(ctx context.Context) {
		heavyWork()
	})
}

func heavyWork() {
	s := 0
	for i := 0; i < 1_000_000; i++ {
		s += i % 7
	}
	_ = s
}
```

The same diagnosis flow without long-running HTTP — capturing a profile programmatically for a batch job or a test:

```go
package main

import (
	"os"
	"runtime"
	"runtime/pprof"
)

func main() {
	cpu, _ := os.Create("cpu.prof")
	_ = pprof.StartCPUProfile(cpu)
	heavyWork()
	pprof.StopCPUProfile()
	cpu.Close()

	heap, _ := os.Create("heap.prof")
	runtime.GC() // get up-to-date live-heap stats
	_ = pprof.WriteHeapProfile(heap)
	heap.Close()
	// Analyze: go tool pprof -http=:8080 cpu.prof
}

func heavyWork() { /* ... */ }
```

> [!TIP]
> `go tool pprof -http=:8080 http://localhost:6060/debug/pprof/profile?seconds=30` opens the interactive flame graph directly from a live process — no file juggling.

## 11. Advanced Concepts

**Profiling labels** (`pprof.Labels`, `pprof.Do`) attach key/value tags to CPU and goroutine samples. In a flame graph you can then filter to `route=checkout`, turning a fleet-wide profile into a per-endpoint view — invaluable in multi-tenant services.

**Differential profiling**: `go tool pprof -base before.prof after.prof` shows the *delta*, so a refactor's effect (or a regression) is isolated from baseline noise. For heap leaks, diffing two `inuse_space` snapshots over time pinpoints the growing allocation site.

**`GOMEMLIMIT` and the GC interplay**: heap profiles must be read alongside `GOGC`/`GOMEMLIMIT`. High `alloc_space` with stable `inuse_space` means churn-driven GC CPU — the fix is fewer allocations (object pooling, pre-sizing slices), visible in the profile as wide `mallocgc` frames.

**Trace-driven analysis**: `runtime/trace` plus `go tool trace` reveals scheduler latency, GC assist time, and goroutine blocking timelines that no profile shows. The trace's "Scheduler latency profile" and per-goroutine analysis explain tail latency.

**`fgprof`** (a third-party package) merges on-CPU and off-CPU time into one flame graph, addressing the CPU profiler's blind spot for I/O-bound code. **`pprof` weblist** shows assembly-level cost per source line for micro-optimization.

## 12. Debugging Tips

- **Goroutine leak?** Hit `/debug/pprof/goroutine?debug=2` for full stacks, or `?debug=1` for grouped counts; a steadily climbing count of identical stacks is the smoking gun.
- **CPU pinned at 100%?** Capture a 30 s CPU profile, open the flame graph, find the widest leaf frame. If `runtime.mallocgc`/`runtime.scanobject` dominate, you have an allocation/GC problem, not your code.
- **High p99, flat CPU?** Capture a 3–5 s trace under load; look at scheduler latency and GC pauses.
- **Lock contention?** Enable mutex profiling, then `go tool pprof /debug/pprof/mutex` and `top` — the function holding the lock surfaces.
- Use `list <regexp>` in the pprof prompt to see line-level cost inside a suspect function.
- Mismatched symbols → pass the binary explicitly: `go tool pprof ./mybinary cpu.prof`.

> [!WARNING]
> The `/debug/pprof/profile` endpoint **blocks for the full duration** (default 30 s) and consumes CPU while sampling. Don't scrape it aggressively in production; stagger it across instances.

## 13. Senior Engineer Notes

A senior engineer treats profiling as a **disciplined loop**, not a panic move: hypothesis → measure under realistic load → read the flame graph → change one thing → re-measure with `-base`. In code review, push back on "optimizations" unaccompanied by a before/after profile — most hand-tuning is noise or pessimization.

Know the **on-CPU blind spot** cold: when a teammate says "the profile says we're fast," ask whether the workload is I/O-bound and whether they looked at a trace. Mentor juniors to read flame graphs by *width-at-leaf*, not by scary-looking deep stacks.

Bake profiling into the team's tooling: a standard admin mux helper, `make profile` targets that capture CPU+heap+trace, and benchmark-with-profile in CI. Insist that the pprof endpoint is *never* on the public mux — this is a recurring security finding and a one-line review catch (`grep _ "net/http/pprof"`).

## 14. Staff Engineer Notes

At staff level the question shifts from "profile this service" to "**how does the org get observability into performance across hundreds of services?**" That is a build-vs-buy decision: stand up **continuous profiling** (Pyroscope/Parca self-hosted vs. Datadog/Grafana Cloud), define retention and cost budgets, and standardize the admin-port + label conventions so a single dashboard works fleet-wide.

Staff engineers weigh the **overhead vs. coverage** trade-off at org scale: always-on CPU profiling at 1–2% across the fleet is usually worth it; always-on mutex/trace is not. They drive policy on `GOMEMLIMIT`, container memory limits, and GC tuning, using aggregate heap profiles to justify capacity decisions — turning "we're OOMing" into "this allocation site costs N GB across the fleet."

Cross-team, the staff role is to make profiling a **shared language**: incident runbooks that say exactly which endpoint to hit, a profile artifact attached to every perf regression ticket, and a security guardrail (admin mux, mTLS, network policy) enforced in the platform's base service template rather than per team. The leverage is not in reading one flame graph faster — it's in making every team's flame graphs accessible, comparable, and safe by default.

## 15. Revision Summary

- **Two halves**: producers (`runtime/pprof`, `runtime/trace`, `net/http/pprof`) and the consumer (`go tool pprof`, `go tool trace`).
- **CPU profile** = `SIGPROF` ~100 Hz stack sampling; **on-CPU only**.
- **Heap profile** = allocation-sampled (every ~512 KiB); `inuse_*` = live, `alloc_*` = cumulative churn.
- **Block/mutex** profiles are off by default; enable via `SetBlockProfileRate` / `SetMutexProfileFraction`.
- **Trace** = time-ordered event log for scheduler/GC/latency, not a sampler.
- **Flame graph**: width = cost; read wide leaf frames.
- Expose on a **separate admin mux + localhost/auth**; never blank-import into the public server.
- Use **labels** to slice profiles, **`-base`** to diff, **`runtime.GC()`** before heap snapshots.
- Continuous profiling tools: **Pyroscope, Parca, Datadog**.

**References:** Go `pprof` docs (pkg.go.dev/net/http/pprof, pkg.go.dev/runtime/pprof, pkg.go.dev/runtime/trace); `go tool pprof` README; Brendan Gregg, *Flame Graphs*; Google-Wide Profiling paper.

---

*Go Engineering Handbook — topic 56.*
