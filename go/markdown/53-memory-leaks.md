# 53 · Memory Leaks

> **In one line:** A Go memory leak is live, reachable memory the GC can never reclaim — usually leaked goroutines holding references, slices retaining backing arrays, or maps that grow but never shrink.

---

## 1. Overview

Go has a garbage collector, so engineers often assume memory leaks are impossible. They are not. The GC only reclaims memory that is *unreachable*. A **memory leak** in Go is memory that stays *reachable* — and therefore "live" — long after it is logically useless. The collector dutifully keeps it forever.

The three dominant leak shapes in production Go are:

1. **Goroutine leaks** — a goroutine blocks forever (on a channel, lock, or network read) and never returns. Its entire stack plus everything its closures capture stays alive.
2. **Slice retention** — a small sub-slice keeps a huge backing array alive, because `len` shrinks but the underlying array does not.
3. **Map growth** — a map's internal buckets grow with insertions but Go maps *never shrink* on delete; long-lived caches and dedup sets balloon.

This chapter dissects how each arises at the runtime level, how to find them with `pprof`, and how senior and staff engineers prevent them by design.

---

## 2. Why It Exists

These leaks are not bugs in Go; they are consequences of deliberate design trade-offs.

- **Goroutines are cheap to start (≈2 KB stack) but have no owner.** There is no `join`, no parent that automatically reaps children, and no built-in timeout. The runtime cannot know whether a blocked goroutine is "stuck" or "patiently waiting" — so it never kills it. Lifecycle is *your* responsibility.
- **Slices are a view, not a copy.** A slice is a 3-word header `{ptr, len, cap}` pointing into a shared backing array. Re-slicing is O(1) precisely because it copies no data — the cost is that any live slice header pins the *entire* array.
- **Maps trade memory for amortized O(1).** To keep probe sequences short, maps over-allocate buckets and only ever grow. Shrinking would require rehashing on delete, adding latency spikes to a hot path. Go chooses predictable speed over reclaiming buckets.

> [!NOTE]
> A GC eliminates *use-after-free* and *double-free*. It does not eliminate *logical* leaks — keeping a reference you no longer need. That class of bug survives garbage collection in every managed language.

---

## 3. Internal Working

### Goroutine leak — what the runtime holds

Every goroutine is a `g` struct on the runtime's allocator, plus a growable stack (starts at 2 KB, can grow to 1 GB). When a goroutine blocks on a channel, the runtime parks it: the `g` is removed from the run queue and attached to the channel's `sudog` wait list. It consumes no CPU, but it is fully reachable from the channel, and the channel is reachable from whoever holds it. Nothing is collected.

```text
 leaked goroutine                 channel (unbuffered, no receiver)
 +-----------------+              +------------------------+
 |  g struct       |              |  hchan                 |
 |  stack (2KB+)   |---parked---> |  sendq -> sudog -> g   |
 |  captured vars: |              |  recvq -> (empty)      |
 |   *bigBuffer  --+--------------+--> [ 8 MB backing ] kept alive
 +-----------------+              +------------------------+
        ^                                   ^
        | runtime allg list                 | still referenced by app
   (never freed: GC sees it as live)
```

Critically, the GC scans the goroutine's stack registers as roots. Anything the goroutine captured — a 50 MB buffer, a DB connection, a `*http.Request` — is pinned for the program's lifetime.

### Slice retention — the header vs. the array

```text
data := make([]byte, 0, 10_000_000)   // 10 MB backing array
// ... fill it ...
head := data[:10]                      // header {ptr, len=10, cap=10_000_000}

  head ---> { ptr ─────────────┐ }
                               v
            [ b0 b1 ... b9 | .................... 10 MB ........... ]
                            ^ logically dead but ptr keeps it all alive
```

The slice header still points at offset 0 of the 10 MB array, and `cap` proves the rest is reachable. The GC keeps the whole array because *any* reachable pointer into a heap object keeps the entire object alive. You freed `len` conceptually, but the runtime frees nothing.

### Map growth — buckets never shrink

A Go map (`hmap`) holds an array of buckets, each storing up to 8 key/value pairs. When the load factor exceeds 6.5 entries/bucket, the map doubles its bucket array and incrementally evacuates old buckets. On `delete`, the runtime marks the cell `emptyOne`/`emptyRest` but **never** reduces the bucket count. A map that peaked at 10M entries and was emptied to 100 still owns buckets sized for 10M — tens to hundreds of MB of `hmap` overhead retained.

```text
hmap{ B: 21 }  -> 2^21 buckets allocated at peak
delete all but 100 -> B stays 21 -> buckets array still ~hundreds of MB
```

---

## 4. Syntax

There is no leak "syntax" — there is *anti-leak* syntax. The core primitives:

```go
// 1. Bound every goroutine's lifetime with context.
ctx, cancel := context.WithCancel(parent)
defer cancel() // ALWAYS cancel, even on the happy path.

go worker(ctx) // worker must select on <-ctx.Done()

// 2. Copy out of a large array to release the backing store.
small := make([]byte, len(head))
copy(small, head) // small has its own tiny array; big one can be GC'd.

// 3. Replace a grown map instead of deleting from it.
m = make(map[K]V) // old map (and its huge bucket array) becomes garbage.

// 4. Nil out pointers in slices/structs you still hold but no longer need.
items[i] = nil // let the pointed-to object be collected.
```

---

## 5. Common Interview Questions

**Q1. Does Go's garbage collector prevent memory leaks?**
No. It prevents *unreachable* memory from accumulating, but a leak is *reachable* memory you forgot about — leaked goroutines, retained slices, growing maps, lingering map/cache entries, and timers/tickers not stopped. The GC will faithfully keep all of it.
*Follow-up: name a leak the GC can't help with.* A goroutine blocked forever on an unbuffered channel — it's a live root.

**Q2. How does a goroutine leak happen and how do you detect it?**
A goroutine blocks on a channel/lock/syscall that never unblocks. Detect via `runtime.NumGoroutine()` trending up, or `pprof` goroutine profile showing a growing count stuck on the same line.
*Follow-up: a common cause?* Writing to an unbuffered channel after the only reader returned early (e.g., on the first error in a fan-in).

**Q3. Explain slice retention with `s = s[:n]`.**
Re-slicing changes `len`/`ptr` but the backing array (size `cap`) stays alive as long as any slice references it. A 10-byte slice can pin a 10 MB array. Fix: `copy` into a right-sized slice, or use `append([]T(nil), src...)`.
*Follow-up: does `clear()` or `s = s[:0]` free the array?* No — both keep `cap` and the backing array. Only dropping all references frees it.

**Q4. Why do Go maps not release memory after deletes?**
Maps only grow their bucket array; `delete` marks cells empty but never shrinks `B`. This avoids rehash latency on the hot path. Fix: periodically `m = make(map[K]V)` and re-insert live keys, or shard.
*Follow-up: what about Go 1.24's Swiss-table maps?* They changed the internal layout and growth behavior, but still do not shrink on delete; you must rebuild.

**Q5. How do you find a leak with pprof?**
Take two heap profiles minutes apart and `go tool pprof -base old.pprof new.pprof` to see *growth*. For goroutines, profile the goroutine endpoint and look at the stack with the highest count.
*Follow-up: inuse_space vs alloc_space?* `inuse_space` shows live memory (leak hunting); `alloc_space` shows cumulative allocation (GC pressure / churn).

**Q6. A `time.Ticker` — why can it leak?**
`time.Tick` and an unstopped `time.NewTicker` keep an internal runtime timer alive; if you never call `Stop()`, it never goes away. Always `defer ticker.Stop()`.
*Follow-up: `time.After` in a select loop?* Each iteration creates a new timer that lives until it fires — in a tight loop that's a transient pile-up; use a reset `Timer` instead.

**Q7. You see RSS climbing but the heap profile is flat. Why?**
Likely off-heap: cgo allocations, mmap'd files, growing goroutine *stacks* (counted separately), or memory returned to the OS lazily (`MADV_FREE`). Check `runtime.ReadMemStats`, `GODEBUG=madvdontneed=1`, and goroutine count.
*Follow-up: how to confirm cgo?* Watch with OS tools (`pmap`, `ps`) vs `runtime/metrics`; a gap implies non-Go allocations.

---

## 6. Production Use Cases

Real systems where these leaks bit teams:

- **HTTP request fan-out** — gateway and proxy teams (Cloudflare among them) have post-mortems on goroutines leaked because a downstream call had no context deadline; goroutines piled up until OOM. The fix pattern is `context.WithTimeout` on every outbound call.
- **Kubernetes / controller-runtime** — informer caches are essentially big maps that grow with cluster size; operators that never bound watch buffers leak. controller-runtime uses bounded work queues precisely to cap this.
- **Prometheus / metrics libraries** — high-cardinality labels create map entries (one series per label combination) that never shrink; the classic "metrics cardinality explosion" that exhausts memory.
- **gRPC streaming servers** — a server-stream goroutine that doesn't select on `stream.Context().Done()` leaks when the client disconnects mid-stream.
- **Message processing (Kafka/NATS consumers)** — a dedup `map[string]struct{}` of seen message IDs that's never reset grows unbounded; teams move to a TTL cache (e.g., `ristretto`, `bigcache`) or a bounded LRU (`hashicorp/golang-lru`).
- **Log/buffer pooling** — pulling a 4-byte token out of a 1 MB read buffer and storing it long-term retains the whole buffer; common in parsers and tokenizers.

---

## 7. Common Mistakes

> [!WARNING]
> The single most common Go leak is a goroutine writing to a channel whose reader has gone away — it blocks on send *forever*.

- Starting a goroutine with no exit path (no `ctx`, no done channel, no closeable input).
- Returning a sub-slice of a large buffer from a function (`return buf[start:end]`) and storing it long-term.
- Using a `map` as a cache with no eviction, no TTL, and no rebuild.
- Forgetting `defer cancel()` after `context.WithCancel/WithTimeout` (this leaks the context's internal timer and any child goroutines).
- `time.NewTicker(...)` without `defer ticker.Stop()`.
- Capturing large objects in closures handed to long-lived goroutines.
- Subscribing to a channel-based event bus and never unsubscribing.
- Appending pointers to a long-lived slice and never niling removed elements.

---

## 8. Performance Considerations

A leak is not just an eventual OOM; it degrades the system *before* it crashes:

- **GC works harder.** The GC must scan all reachable objects on every cycle. More live objects → longer mark phase → higher CPU and longer pauses. A leaking map of 10M entries makes *every* GC cycle scan those buckets.
- **Heap grows → GC triggers more often.** `GOGC` (default 100) triggers a cycle when the heap doubles since the last collection. A steadily growing live set means a steadily growing target, more total bytes scanned over time.
- **Cache pressure.** Retained backing arrays push the live working set out of CPU caches, hurting throughput even when RSS looks "fine."
- **Goroutine count.** Each leaked goroutine costs a `g` struct + stack (≥2 KB) and adds to scheduler and GC-stack-scan work. 100K leaked goroutines ≈ hundreds of MB and measurable scheduler overhead.

Quantify with `runtime.ReadMemStats`: watch `HeapInuse`, `HeapObjects`, `NumGC`, `PauseTotalNs`, and `NumGoroutine` over time. A healthy service has a *flat* sawtooth; a leak shows a rising floor.

---

## 9. Best Practices

- **Give every goroutine a guaranteed exit.** Either a `context`, a `done <-chan struct{}`, or a closeable input channel. If you can't say *how this goroutine dies*, you have a leak.
- **Always `defer cancel()`** immediately after creating a cancellable context.
- **Set deadlines on all I/O.** `http.Client{Timeout}`, `context.WithTimeout` on DB/gRPC calls.
- **Copy small slices out of big buffers** when you keep them: `append([]byte(nil), src...)`.
- **Bound or rebuild maps.** Use an LRU/TTL cache for caches; periodically `make` a fresh map for grow-only sets.
- **`defer Stop()` every Ticker/Timer.**
- **Run a goroutine-count and heap watchdog** in staging; alert on monotonic growth.
- **Use `goleak` in tests** (`go.uber.org/goleak`) to fail tests that leave goroutines running.

---

## 10. Code Examples

Primary: a leaking fan-in vs. a context-bounded, leak-free version.

```go
// LEAKY: if the consumer returns after the first result, the remaining
// producers block forever on send to an unbuffered channel.
func search(queries []string) string {
	results := make(chan string) // unbuffered!
	for _, q := range queries {
		go func(q string) {
			results <- doQuery(q) // blocks forever if no one reads
		}(q)
	}
	return <-results // reads ONE, the rest leak
}
```

```go
// FIXED: context cancels stragglers; buffered channel guarantees sends
// never block even if the receiver has moved on.
func search(ctx context.Context, queries []string) (string, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel() // signals every goroutine to stop

	results := make(chan string, len(queries)) // buffered: sends never block
	for _, q := range queries {
		go func(q string) {
			select {
			case results <- doQuery(ctx, q):
			case <-ctx.Done(): // straggler exits cleanly
			}
		}(q)
	}

	select {
	case r := <-results:
		return r, nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}
```

Fixing slice retention — copy out so the GC can reclaim the big array:

```go
// findToken returns a token that must outlive the read buffer.
func findToken(buf []byte) []byte {
	tok := buf[10:20]
	// BAD: return tok        -> pins all of buf
	out := make([]byte, len(tok))
	copy(out, tok) // GOOD: out owns a 10-byte array; buf can be freed
	return out
}
```

Fixing map growth — rebuild a grown set instead of relying on delete:

```go
func compact[K comparable, V any](m map[K]V, keep func(K) bool) map[K]V {
	fresh := make(map[K]V, len(m)) // sized to current live set
	for k, v := range m {
		if keep(k) {
			fresh[k] = v
		}
	}
	return fresh // old map + its oversized buckets become garbage
}
```

---

## 11. Advanced Concepts

- **`runtime.SetFinalizer` for leak detection.** Attach a finalizer that logs if an object is collected; if it *never* fires, the object is leaked (reachable). Useful in debugging, never in production logic — finalizers run on the GC's schedule and can themselves resurrect objects.
- **Weak pointers (Go 1.24 `weak.Pointer[T]`).** Lets a cache reference an object without keeping it alive, enabling self-cleaning caches that don't leak. Pairs with `runtime.AddCleanup` (the modern replacement for `SetFinalizer`).
- **`GODEBUG` knobs.** `GODEBUG=gctrace=1` prints every GC with heap sizes — a rising "heap goal" floor screams leak. `GODEBUG=schedtrace=1000` surfaces runnable/blocked goroutine counts.
- **`MADV_DONTNEED` vs `MADV_FREE`.** Go returns freed pages lazily; RSS may look high even after the heap shrinks. `GODEBUG=madvdontneed=1` forces eager return — useful when proving a fix to ops who watch RSS.
- **Memory ballast / `GOMEMLIMIT`.** Setting a soft memory limit makes the GC more aggressive as you approach it, turning a slow leak into a CPU spike (more visible) rather than a silent OOM.
- **Escape analysis interplay.** Closures passed to `go` almost always force captured variables to the heap; a leaked goroutine therefore leaks heap, not just stack.

---

## 12. Debugging Tips

The canonical pprof workflow for a suspected leak:

```go
import _ "net/http/pprof" // registers handlers on the default mux

func main() {
	go func() { log.Println(http.ListenAndServe("localhost:6060", nil)) }()
	// ... your service ...
}
```

Then, in a shell:

```text
# Goroutine leak: count + stacks, with full dump
curl localhost:6060/debug/pprof/goroutine?debug=2 | less
go tool pprof http://localhost:6060/debug/pprof/goroutine

# Heap leak: take two snapshots minutes apart, diff them
go tool pprof http://localhost:6060/debug/pprof/heap   # -> base.pb.gz
# wait 5 min
go tool pprof -base base.pb.gz http://localhost:6060/debug/pprof/heap
(pprof) top          # biggest growth
(pprof) list <fn>    # line-level retained bytes
```

> [!TIP]
> The `-base` diff is the most important trick: leaks are about *growth over time*, not absolute size. A single snapshot lies; the delta tells the truth.

Checklist when narrowing down:
1. Is `NumGoroutine()` rising? → goroutine leak; read the dominant stack.
2. Heap rising but goroutines flat? → map/slice/cache retention; diff `inuse_space`.
3. RSS rising but heap flat? → off-heap (cgo, stacks, lazy madvise).
4. Add `goleak.VerifyTestMain(m)` to lock the fix into regression tests.

---

## 13. Senior Engineer Notes

A senior engineer treats leak prevention as a **review discipline**, not an afterthought.

- In code review, the reflex question for every `go func()` is: *"Show me where this returns."* If there's no context, done channel, or closeable input, block the PR.
- Reject returning sub-slices of pooled/large buffers across API boundaries; require an explicit copy and a comment explaining ownership.
- Insist on `defer cancel()` and `defer Stop()` on the line *after* the resource is created — proximity makes a missing defer obvious in review.
- Mentor juniors on the mental model: *reachable ≠ needed*. Most leak bugs come from engineers trusting the GC too much.
- Add `goleak` to the test suite and a goroutine-count gauge to the service's metrics so leaks surface in staging, not at 3 a.m.
- Know when to copy vs. reference: defaulting to copy for *retained* data and reference for *transient* data is a judgement call you make dozens of times a day.

---

## 14. Staff Engineer Notes

A staff engineer addresses leaks at the level of **architecture, standards, and org-wide tooling**.

- **Set platform defaults.** Mandate `GOMEMLIMIT` and timeouts in the shared service template so every team inherits leak-resistant defaults without thinking about it. A leak that turns into a CPU spike (via the memory limit) pages someone *before* it OOM-kills a node.
- **Build-vs-buy on caching.** Rather than each team hand-rolling a `map` cache that leaks, standardize on a vetted library (`ristretto`, `golang-lru`, `bigcache`) with TTL/size bounds. This is an org-level decision that eliminates a whole bug class.
- **Cross-team observability.** Push goroutine-count, heap floor, and GC-pause dashboards into the standard golden-signals template; define SLO alerts on monotonic heap growth so leaks are caught uniformly across services.
- **Capacity & cost trade-offs.** A slow leak that "just" requires a daily restart is real architectural debt: it blocks zero-downtime rollouts and inflates instance counts. Quantify the dollar cost to justify the fix.
- **Cardinality governance.** High-cardinality metrics and unbounded maps are organizationally the same problem; a staff engineer sets cardinality limits and review gates that prevent both.
- **Pre-mortem framing.** When designing a long-lived component, the design doc must answer: *what is the steady-state memory ceiling, and which structures could grow without bound?* Demanding that section catches leaks before code exists.

---

## 15. Revision Summary

- A Go leak is **reachable but useless** memory — the GC never touches it.
- **Three shapes:** goroutine leaks (blocked forever, pins stack + captures), slice retention (small header pins big backing array), map growth (buckets grow, never shrink on delete).
- Every goroutine needs a **guaranteed exit**: context, done channel, or closeable input. `defer cancel()` always.
- Free a big array by **copying the small part out**: `append([]T(nil), src...)`.
- Rebuild grown maps with `m = make(...)`; use **LRU/TTL caches** for caches.
- `defer Stop()` every Ticker/Timer; beware `time.After` in tight loops.
- Find leaks with **pprof `-base` diffs** (heap) and the **goroutine profile** (stuck stacks); watch `NumGoroutine`, `HeapInuse`, `gctrace=1`.
- Senior: review discipline + ownership semantics. Staff: platform defaults, `GOMEMLIMIT`, vetted cache libs, cardinality governance, leak SLOs.

**References:** Go pprof docs (`pkg.go.dev/net/http/pprof`, `go tool pprof`); Go runtime memory model and `runtime/metrics`; Go 1.24 `weak` and `runtime.AddCleanup`; `go.uber.org/goleak`.

---

*Go Engineering Handbook — topic 53.*
