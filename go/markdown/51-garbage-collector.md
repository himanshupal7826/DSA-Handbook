# 51 · Garbage Collector

> **In one line:** Go's garbage collector is a concurrent, non-generational, non-compacting tri-color mark-sweep collector whose CPU/memory trade-off you steer with `GOGC` and `GOMEMLIMIT`.

---

## 1. Overview

Go ships with an automatic **garbage collector (GC)** so you allocate with `new`, `make`, and composite literals and never call `free`. The collector reclaims heap memory that is no longer reachable from your program's roots (goroutine stacks, globals, registers).

The defining property is that Go's GC is **concurrent**: most of its work runs *while your application keeps executing*. It is also **non-moving** (objects never change address, which keeps cgo and `unsafe.Pointer` sane) and **non-generational** (no separate young/old heaps). The algorithm is **tri-color mark sweep** with a write barrier, and a pacer that decides *when* to run so you hit a CPU-vs-memory target.

You rarely touch GC code directly. Instead you tune two knobs — `GOGC` (the classic heap-growth ratio) and `GOMEMLIMIT` (a soft memory ceiling added in Go 1.19) — and you write allocation-light code. This chapter covers what the runtime actually does, how to read GC telemetry, and the judgement calls senior and staff engineers make around the **garbage collector**.

## 2. Why It Exists

Manual memory management (`malloc`/`free`, C++ RAII) is fast but a perennial source of use-after-free, double-free, and leak bugs — historically the majority of critical CVEs in systems software. Go's designers chose automatic GC to make concurrent server code *safe by default*: you can share pointers across goroutines without an ownership protocol, and the runtime guarantees memory stays valid as long as it's reachable.

The harder design goal was **low latency**. Early Go (pre-1.5) used a stop-the-world (STW) mark-sweep that paused the entire program for tens of milliseconds — unacceptable for request-serving systems. From Go 1.5 onward the team rebuilt the GC to be concurrent, driving worst-case STW pauses below **1 ms** (often sub-100µs today) regardless of heap size. The explicit, published goal: GC pauses should not be a reason to choose another language for a latency-sensitive server. That trade — spend a bit of throughput and some extra RAM to keep tail latency tiny — is the philosophy behind every GC decision in Go.

## 3. Internal Working

**Tri-color abstraction.** Every heap object is conceptually one of three colors:

- **White** — not yet proven reachable (candidate for collection).
- **Grey** — proven reachable, but its pointers haven't been scanned yet.
- **Black** — reachable and fully scanned.

Marking starts by greying the roots, then repeatedly takes a grey object, blackens it, and greys every white object it points to. When no grey objects remain, all remaining white objects are unreachable garbage. The **tri-color invariant** the GC must preserve: *no black object points to a white object* (without that white object also being reachable via some grey object). If that invariant breaks while the mutator (your code) runs concurrently, a live object could be swept.

**Write barrier.** Because the mutator runs *during* marking, it can move a pointer from a not-yet-scanned location into an already-black object, hiding a white object. Go inserts a **hybrid write barrier** (Yuasa-style deletion + Dijkstra-style insertion, since Go 1.8) on pointer writes during the mark phase. It shades the relevant objects grey so nothing reachable is lost. The barrier is *off* outside the mark phase, so steady-state pointer writes are free.

**GC phases and the pacer.**

```text
   heap grows ──────────────► trigger reached
   ┌──────────────────────────────────────────────────────────┐
   │  Mutator running, write barrier OFF                        │
   └──────────────────────────────────────────────────────────┘
        │ STW (~<1ms): enable write barrier, scan stacks/globals
        ▼
   ┌──────────────────────────────────────────────────────────┐
   │  CONCURRENT MARK  (barrier ON)                            │
   │  dedicated GC workers + mutator-assist credit             │
   │  grey set drained from per-P work queues                  │
   └──────────────────────────────────────────────────────────┘
        │ STW (~<1ms): mark termination, disable barrier
        ▼
   ┌──────────────────────────────────────────────────────────┐
   │  CONCURRENT SWEEP  (lazy, on allocation)                 │
   │  white spans returned to free lists / reused             │
   └──────────────────────────────────────────────────────────┘
```

**Memory layout.** Go's allocator is a tcmalloc descendant. The heap is carved into 8 KB **pages** grouped into **mcentral**-managed **spans**, each span holding objects of one **size class** (~67 classes up to 32 KB; larger objects get their own spans). Each P (logical processor) has an **mcache** of spans for lock-free small-object allocation. Pointer/scalar layout per type is recorded so the GC scans only words that can hold pointers. Sweeping is *lazy*: spans are swept on demand as you allocate from them, spreading the cost.

**The trigger / pacer.** The pacer's job is to start GC early enough that marking finishes *before* the heap grows past the target. With `GOGC=100`, the target heap is `live_heap × (1 + GOGC/100)` = 2× the live set after the previous cycle. The pacer continuously estimates mark progress vs. allocation rate; if the mutator out-allocates the markers, it imposes **mutator assist** — the allocating goroutine is forced to do proportional marking work, applying back-pressure so the heap can't outrun the collector.

## 4. Syntax

There is no GC "syntax" — it's automatic. What you *do* control:

```go
import "runtime/debug"

// Heap-growth knob: target heap = live * (1 + GOGC/100).
// Default 100. Lower => more frequent GC, less RAM, more CPU.
debug.SetGCPercent(50)
old := debug.SetGCPercent(-1) // -1 disables GC entirely

// Soft memory ceiling (Go 1.19+), in bytes. Default math.MaxInt64 (off).
debug.SetMemoryLimit(4 << 30) // 4 GiB

// Force a blocking GC now (rarely needed in prod).
runtime.GC()

// Return freed memory to the OS more aggressively.
debug.FreeOSMemory()
```

Environment-variable equivalents (read once at startup):

```text
GOGC=100            # same as SetGCPercent(100); "off" disables GC
GOMEMLIMIT=4GiB     # soft limit; accepts B, KiB, MiB, GiB, etc.
GODEBUG=gctrace=1   # one line of GC stats per cycle on stderr
```

## 5. Common Interview Questions

**Q1. What algorithm does Go's GC use?**
Concurrent, non-generational, non-compacting **tri-color mark sweep** with a hybrid write barrier and a heap-ratio pacer.
*Follow-up: Why non-generational?* The generational hypothesis (most objects die young) holds, but Go's escape analysis already keeps many short-lived objects on the stack, and a moving generational GC fights Go's non-moving requirement (cgo, interior pointers). The team measured that a non-generational concurrent collector met latency goals without the complexity.

**Q2. What does `GOGC=100` mean exactly?**
Trigger the next GC when the heap has grown to live-set × 2 (100% growth). `GOGC=200` lets it grow 3× (less CPU, more RAM); `GOGC=50` triggers at 1.5× (more CPU, less RAM).
*Follow-up: What if your live set is tiny but allocation rate huge?* You can GC pathologically often (a 4 MB live set means GC every 4 MB allocated). Raise `GOGC` or establish a memory floor with `GOMEMLIMIT`/a ballast.

**Q3. Why was `GOMEMLIMIT` added, and how does it interact with `GOGC`?**
`GOGC` alone can't bound peak memory — a growing live set scales the target unboundedly, OOM-killing containers. `GOMEMLIMIT` is a *soft* ceiling: as the heap approaches it, the pacer triggers GC more aggressively (overriding `GOGC`) to stay under it.
*Follow-up: Why "soft"?* If the live set genuinely exceeds the limit, Go will exceed it rather than enter a GC death-spiral; it prioritizes progress over the limit. To avoid thrashing, keep `GOGC` enabled too.

**Q4. What is the write barrier and why is it needed?**
A small snippet the compiler injects on pointer writes during the mark phase. Because the mutator runs concurrently with marking, it can hide a white object behind a black one; the barrier shades objects grey to preserve the tri-color invariant.
*Follow-up: Does it cost in steady state?* No — it's enabled only during the mark phase, so non-GC time pays nothing.

**Q5. What is mutator assist?**
When a goroutine allocates faster than GC can mark, the runtime debits it "assist credit," forcing it to perform marking work proportional to its allocation before continuing. It's the back-pressure that keeps the heap from outrunning the collector.
*Follow-up: How does it show up in production?* As latency spikes on allocation-heavy goroutines during GC. The fix is to allocate less, not to fight the pacer.

**Q6. How do you reduce GC pressure in a hot path?**
Reduce allocations: reuse buffers via `sync.Pool`, preallocate slices/maps with capacity, pass values to avoid escapes, avoid `interface{}` boxing, and let escape analysis keep objects on the stack.
*Follow-up: How do you prove an allocation escaped?* `go build -gcflags='-m'` prints escape-analysis decisions; `pprof` `alloc_space`/`inuse_space` profiles show where bytes come from.

**Q7. Are stacks scanned stop-the-world?**
Stacks are scanned mostly concurrently; each goroutine's stack is scanned at a safe point. There are two brief STW phases (mark start and mark termination), each typically well under 1 ms.

## 6. Production Use Cases

- **Latency-sensitive request servers** (gRPC/HTTP APIs, ad-serving, trading-adjacent systems): the sub-millisecond STW design is the reason teams pick Go over JVM G1/older collectors for tight p99 SLAs.
- **Twitch** famously published how a high-throughput chat service spent ~30% CPU in GC because of a small live set + huge allocation rate; they used a large **memory ballast** (a giant unused byte slice) to raise the effective GC trigger before `GOMEMLIMIT` existed.
- **Kubernetes / etcd / Prometheus / CockroachDB / TiDB** — large-heap, long-running control-plane and storage systems that set `GOMEMLIMIT` to play nicely with cgroup memory limits and avoid OOM-kills.
- **Discord** documented GC tail-latency pain in Go (LRU cache churn) that drove a rewrite of one hot service to Rust — a concrete example of when Go's GC trade-off stops paying off.
- **Containerized microservices**: the modern idiom is `GOMEMLIMIT` set to ~90% of the container memory limit so the GC keeps the pod under its cgroup cap instead of getting OOM-killed.

## 7. Common Mistakes

- **Calling `runtime.GC()` in hot paths.** It forces a full, partly-blocking cycle; almost never the right tool in production.
- **Disabling GC (`GOGC=off`) "for performance"** without a hard memory bound — a slow OOM landmine.
- **Setting `GOMEMLIMIT` to 100% of the container limit.** Off-heap memory (goroutine stacks, mmap'd files, cgo) lives outside the Go heap; leave headroom (~5–15%).
- **Using `sync.Pool` for objects of wildly varying size** (e.g., buffers), causing the pool to retain the largest size and waste memory — cap or bucket by size.
- **Assuming `sync.Pool` is a cache.** It's cleared (at least partially) every GC cycle; it's a recycling pool, not a TTL cache.
- **Storing pointers in pooled objects and forgetting to nil them**, pinning otherwise-dead graphs alive.
- **Tuning `GOGC` blindly** instead of measuring with `gctrace`/pprof first.

## 8. Performance Considerations

GC cost is fundamentally a function of **how much you allocate** and **how big your live set is**, not how much memory exists. Two practical models:

| Knob | Lower value | Higher value |
|------|-------------|--------------|
| `GOGC` | More frequent GC → less RAM, more CPU | Less frequent GC → more RAM, less CPU, lower latency |
| `GOMEMLIMIT` | Caps peak RAM; risks GC thrash near limit | Looser cap; risks OOM-kill |

Key numbers to internalize: default `GOGC=100` roughly doubles your live-set RAM; the GC targets keeping itself to ~**25% of GOMAXPROCS** during a cycle (one dedicated background worker plus assists). STW pauses are sub-millisecond; the *throughput* tax (extra CPU + write barrier during mark) is the real cost, typically single-digit-to-~25% of CPU depending on allocation rate.

The biggest lever is almost always **allocation reduction**, not knob-twiddling. Eliminating allocations in a hot loop both lowers GC frequency *and* shrinks pause work. Use escape analysis (`-gcflags=-m`) and `pprof` to find the offenders.

> [!TIP]
> For containers, the single highest-leverage setting in 2024+ is `GOMEMLIMIT` near (not at) your cgroup limit, *plus* matching `GOMAXPROCS` to your CPU quota (the `automaxprocs` library or Go 1.25's cgroup-aware default).

## 9. Best Practices

- **Set `GOMEMLIMIT`** on every containerized service, ~90% of the memory limit, and keep `GOGC` enabled (don't set it to `off`).
- **Match `GOMAXPROCS` to your CPU quota** — over-provisioning P's makes GC assists and stack scans more expensive.
- **Reduce allocations first**: preallocate with `make([]T, 0, n)`, reuse buffers, prefer value receivers for small structs, avoid unnecessary `interface{}`.
- **Use `sync.Pool` for short-lived, frequently-allocated, same-shaped objects** (e.g., `bytes.Buffer`, encode/decode scratch).
- **Measure with `GODEBUG=gctrace=1`** in staging before tuning; never tune from intuition.
- **Treat GC tuning as configuration, not code** — `GOGC`/`GOMEMLIMIT` env vars are easier to roll back than `debug.SetGCPercent` calls.
- **Leave headroom for off-heap memory** when sizing the limit.

## 10. Code Examples

Primary: cutting allocations with `sync.Pool` in a hot encode path (the most common real GC win).

```go
package main

import (
	"bytes"
	"sync"
)

var bufPool = sync.Pool{
	New: func() any { return new(bytes.Buffer) },
}

// Encode reuses a pooled buffer instead of allocating per call.
func Encode(write func([]byte) error, parts ...string) error {
	buf := bufPool.Get().(*bytes.Buffer)
	defer func() {
		buf.Reset()      // clear contents but keep capacity
		bufPool.Put(buf) // hand it back for reuse
	}()

	for _, p := range parts {
		buf.WriteString(p)
	}
	return write(buf.Bytes())
}
```

Alternative: programmatic GC tuning at startup (use env vars in prod, but this is handy in libraries/tests).

```go
package main

import (
	"runtime/debug"
)

func init() {
	// Soft cap the heap at 3 GiB and keep GOGC at a sane 100.
	// Prefer GOMEMLIMIT/GOGC env vars in production deployments.
	debug.SetMemoryLimit(3 << 30)
	debug.SetGCPercent(100)
}
```

To *see* the GC working, run any program with tracing. Each line shows wall-clock pauses, heap sizes, and CPU split:

```text
$ GODEBUG=gctrace=1 ./server
gc 12 @4.821s 1%: 0.018+1.9+0.024 ms clock, 0.14+0.21/1.7/0+0.19 ms cpu, 52->53->27 MB, 54 MB goal, 8 P
#        ^cycle  ^%CPU  ^STW+mark+STW (clock)                       ^heap before->peak->after  ^goal
```

The `52->53->27 MB` triple is *heap-at-trigger → peak → live-after-sweep*; `54 MB goal` is the pacer's target. Watch the live-after value: that's your true working set, and `goal ≈ live × (1+GOGC/100)`.

## 11. Advanced Concepts

- **Hybrid write barrier (Go 1.8+):** combines Yuasa deletion + Dijkstra insertion barriers so stacks need not be re-scanned during mark termination, shrinking the final STW dramatically. This is why Go's STW is near-constant regardless of stack depth.
- **Mark assist accounting:** each P holds *assist credit*; allocation debits it, background marking credits it. Negative credit forces synchronous marking — the precise mechanism behind GC-correlated latency.
- **Sweep-on-allocation:** there is no separate sweep STW; spans are swept lazily as reused, so sweep cost is amortized into allocation.
- **Scavenging:** a background scavenger returns unused pages to the OS (madvise). `GOMEMLIMIT` makes scavenging more aggressive near the limit; `debug.FreeOSMemory()` forces it.
- **Pointer-free allocations bypass scanning:** a `[]byte` or `[]int` has no pointers, so the GC marks it in O(1) without scanning contents. Designing data as "pointer-free arenas" (struct-of-arrays, indices instead of pointers) can slash mark time on large heaps — the idea behind manual *arena* allocation.
- **`runtime/metrics`:** the modern, low-overhead, stable replacement for poking `runtime.MemStats`; exposes `/gc/heap/goal:bytes`, `/gc/pauses:seconds` histograms, assist times, etc.

> [!NOTE]
> Go's GC is *non-moving*, so it never compacts the heap — fragmentation is managed by size-class spans, not relocation. This is what makes `unsafe.Pointer` arithmetic and cgo pointer passing tractable.

## 12. Debugging Tips

- **First look:** `GODEBUG=gctrace=1` — read CPU %, pause times, and the heap triple. High `%` with a small live set = allocation-rate problem.
- **Where bytes come from:** `go tool pprof` on `alloc_space` (total allocated) and `inuse_space` (currently live) heap profiles; `alloc_objects` finds many-small-objects churn.
- **Why something escaped:** `go build -gcflags='-m -m'` prints escape analysis; look for `escapes to heap` / `moved to heap`.
- **Pause histograms:** `runtime/metrics` `/gc/pauses:seconds` or `/sched/latencies` for scheduler-induced delay vs. real GC pauses.
- **Execution trace:** `runtime/trace` + `go tool trace` visualizes GC phases against goroutine activity — the definitive way to attribute a latency spike to GC vs. scheduling vs. syscalls.
- **Forcing reproduction:** lower `GOGC` (e.g., `GOGC=20`) in a load test to *amplify* GC and surface allocation hotspots faster.

> [!WARNING]
> Don't profile GC behavior under `GOGC=off` or with `runtime.GC()` sprinkled in — you'll measure an artifact, not production behavior.

## 13. Senior Engineer Notes

As a senior engineer, your GC judgement is mostly about **code and review**, not exotic tuning. In reviews, flag the patterns that quietly create GC pressure: appending in a loop without preallocating capacity, returning pointers to locals that force heap escapes, boxing primitives into `interface{}` (e.g., logging hot paths with `...any`), and per-request allocation of buffers that could be pooled. Insist on a benchmark with `-benchmem` for any "performance" PR — `allocs/op` is the number that actually moves GC cost.

When someone proposes `sync.Pool`, check that the objects are *uniformly shaped and short-lived*; misused pools cause memory bloat and subtle bugs (forgetting to reset, retaining references). Mentor juniors to read `gctrace` and a heap profile before changing any knob — "we set `GOGC=400` and it got faster" is a smell that the real issue is allocation rate. Own the deployment config: ensure every service you're responsible for sets `GOMEMLIMIT` and a correct `GOMAXPROCS`, and write that down so it survives team turnover.

## 14. Staff Engineer Notes

At staff level the questions are **architectural and organizational**. Decide platform-wide defaults: a standard base image / framework that sets `GOMEMLIMIT` from the cgroup limit and `GOMAXPROCS` from the CPU quota automatically, so individual teams don't each re-learn the OOM-kill lesson. This is a cross-team leverage move — one library (`automaxprocs` + a memlimit helper) eliminates a whole class of incidents.

Frame GC as a **build-vs-buy / language-choice** boundary. For the 99% of services where p99 latency targets are tens of milliseconds, Go's GC is a non-issue and a productivity win. For the rare service where GC tail latency genuinely dominates (multi-GB caches with high churn, microsecond-scale paths), recognize when the answer is *not* tuning but *architecture*: off-heap/arena storage, pointer-free data layouts, sharding to keep live sets small, or — as Discord concluded for one service — a different language. Quantify it: a 25% GC CPU tax on a fleet of thousands of cores is a real dollar figure that can justify an arena rewrite or a Rust sidecar. Finally, set the org's observability contract: GC pause and assist metrics in the standard dashboard so capacity planning and SLO reviews include GC behavior by default rather than as a post-incident discovery.

## 15. Revision Summary

- Go GC = **concurrent, non-generational, non-moving, tri-color mark sweep** with a **hybrid write barrier** and a heap-ratio **pacer**.
- Colors: white (unproven) → grey (reachable, unscanned) → black (scanned); invariant: no black→white pointer; write barrier preserves it during concurrent mark.
- Phases: brief STW mark-start → concurrent mark (+ mutator assist) → brief STW mark-termination → lazy concurrent sweep. STW pauses are typically **sub-millisecond**.
- **`GOGC`** sets target heap = live × (1 + GOGC/100); default 100 ≈ 2× live. Lower = less RAM/more CPU.
- **`GOMEMLIMIT`** = soft memory ceiling (Go 1.19+); use it on containers (~90% of limit) and keep `GOGC` on to avoid thrash.
- The dominant cost is **allocation rate**, not heap size — reduce allocations (preallocate, `sync.Pool`, avoid escapes/boxing) before tuning knobs.
- Debug with `GODEBUG=gctrace=1`, pprof `alloc_space`/`inuse_space`, `-gcflags=-m`, `go tool trace`, and `runtime/metrics`.
- Match `GOMAXPROCS` to CPU quota; leave headroom for off-heap memory.

**References:** The Go GC Guide (`go.dev/doc/gc-guide`); `runtime` and `runtime/debug` package docs; Go 1.5/1.8/1.19 release notes; `GODEBUG=gctrace` documentation.

---

*Go Engineering Handbook — topic 51.*
