# 44 · Deadlocks

> **In one line:** A deadlock is a state where a set of goroutines are blocked forever, each waiting on a resource that another member of the set holds — and Go's runtime can only detect the special case where *every* goroutine is asleep.

---

## 1. Overview

A **deadlock** is the permanent stall of two or more goroutines, where each is blocked waiting for an event (a lock release, a channel send/receive, a `WaitGroup` to reach zero) that will never happen because the goroutine that would trigger it is itself blocked. The classic mental model is two goroutines holding lock A and lock B respectively, each then reaching for the lock the other holds — neither can proceed, neither can back out.

Deadlocks matter disproportionately in Go because the language *encourages* concurrency: goroutines are cheap, channels are idiomatic, and `sync.Mutex` is everywhere. The same primitives that make Go productive make it easy to construct **circular wait** chains. The Go runtime ships a built-in deadlock detector, but — and this is the single most misunderstood fact about Go deadlocks — it only fires when *all* goroutines are blocked simultaneously (`fatal error: all goroutines are asleep - deadlock!`). A partial deadlock involving two of your ten thousand goroutines, with the rest happily serving traffic, will **never** be reported by the runtime. It manifests as a slow leak: stuck requests, climbing goroutine counts, and an eventual OOM.

This chapter covers the four classical conditions for deadlock (Coffman conditions), how the Go scheduler actually decides "everyone is asleep," the lock-ordering discipline that prevents circular wait, and the production tooling (pprof goroutine dumps, `SIGQUIT` stack dumps, third-party detectors) used to find the partial deadlocks the runtime can't.

## 2. Why It Exists

Deadlocks are not a feature anyone designed — they are an *emergent property* of concurrent systems that share mutable resources with **blocking** acquisition. The phenomenon predates Go by decades; Edsger Dijkstra's Dining Philosophers (1965) is the canonical illustration. Go inherits the problem because it offers blocking synchronization (`Lock`, `<-ch`, `wg.Wait`) as first-class operations.

The four **Coffman conditions** must *all* hold for a deadlock to be possible. Removing any one makes deadlock impossible:

| # | Condition | Meaning | How to break it |
|---|-----------|---------|-----------------|
| 1 | Mutual exclusion | A resource is held exclusively (a `Mutex`) | Use immutable data / copies / atomics |
| 2 | Hold and wait | Hold one resource while requesting another | Acquire all locks at once, or none |
| 3 | No preemption | A held lock can't be forcibly taken | Use `TryLock` + back-off |
| 4 | Circular wait | A cycle exists in the "waits-for" graph | Impose a global **lock ordering** |

Go's runtime *does* try to help: when the scheduler observes that there are no runnable goroutines and no goroutine can ever become runnable (no timers pending, no network poller activity, no goroutines blocked on syscalls that might return), it concludes the program is wedged and aborts with a fatal error rather than hanging silently. This exists because a hung server with zero CPU usage is far harder to diagnose than a process that crashes with a stack dump pointing at the blocked goroutines.

## 3. Internal Working

Go's deadlock detection lives in the scheduler, not in the mutex or channel code. The runtime tracks, in the global scheduler state (`runtime.sched`, type `schedt`), the population of OS threads and goroutines and their states.

Every blocking operation calls `gopark`, which transitions a goroutine `G` from `_Grunning` to `_Gwaiting` and hands its M (OS thread) back to find other work via `schedule()`. When an M is about to go idle with nothing to do, the runtime calls `checkdead()` (in `runtime/proc.go`). `checkdead` reasons about whether the program can ever make progress again:

```text
grunning  = live user goroutines (excluding system goroutines: GC, sysmon, finalizer)
runnable  = goroutines on run queues that an idle M could pick up
blocked   = goroutines parked on channels / mutex / select / WaitGroup
```

If there are live user goroutines but **none** is runnable, **no** M can make progress, there are no pending timers, and the network poller has nothing waiting, it throws:

```text
fatal error: all goroutines are asleep - deadlock!
```

ASCII view of the decision:

```text
        M (OS thread) goes idle, calls schedule()
                       |
                 run queue empty?
                       | yes
                       v
                  netpoll has fds?  --yes--> wait on epoll/kqueue (NOT a deadlock)
                       | no
                       v
                  pending timers?   --yes--> sleep until timer  (NOT a deadlock)
                       | no
                       v
              any runnable G anywhere? --yes--> steal work, continue
                       | no
                       v
            checkdead(): live user G > 0 && all parked?
                       | yes
                       v
        throw("all goroutines are asleep - deadlock!")
```

Critical consequences of this design:

1. **A goroutine blocked on `time.Sleep` or a timer is NOT considered deadlocked** — a pending timer is "future work," so `checkdead` sees the program can still make progress.
2. **A goroutine blocked on network I/O is NOT a deadlock** — the netpoller is waiting on fds. This is exactly why a real server with an idle goroutine pool never trips the detector even when an internal lock cycle exists: the HTTP listener goroutine is parked in netpoll, which counts as "able to make progress."
3. **The detector is global, not local.** There is no per-subsystem deadlock check. The runtime cannot tell that two of your goroutines form a cycle while the rest serve traffic.

For mutexes specifically (`runtime/sema.go`), a contended `Lock()` parks the goroutine on a *semaphore wait queue* (a treap of `sudog` structures keyed by the lock address). There is **no cycle detection** on these queues — the runtime never builds a waits-for graph. That is why circular-wait detection is entirely the programmer's responsibility.

## 4. Syntax

There is no `deadlock` keyword. Deadlocks arise from the blocking primitives. The relevant syntax surface:

```go
var mu sync.Mutex
mu.Lock()
defer mu.Unlock()

// Go 1.18+: non-blocking acquisition — a primary tool against deadlock
if mu.TryLock() {
	defer mu.Unlock()
	// got it
} else {
	// back off, retry, or take an alternate path
}

ch := make(chan int)      // unbuffered: send blocks until receive
chb := make(chan int, 4)  // buffered: send blocks only when full

// select with default = never blocks (cannot deadlock here)
select {
case v := <-ch:
	_ = v
default:
	// non-blocking path
}

var wg sync.WaitGroup     // wg.Wait() deadlocks if Add/Done are mismatched
```

The runtime fatal error you will see:

```text
fatal error: all goroutines are asleep - deadlock!

goroutine 1 [chan receive]:
main.main()
	/path/main.go:12 +0x...
```

## 5. Common Interview Questions

**Q1. What exactly does Go's runtime deadlock detector detect?**
*Answer:* Only the global case where every live user goroutine is blocked and the program can make no further progress — no runnable goroutines, no pending timers, no netpoller activity. It is a liveness check in `checkdead`, not a cycle detector.
*Follow-up: Why doesn't it catch a two-goroutine lock cycle in a running web server?* Because the HTTP listener (and many other goroutines) are parked in netpoll, which the runtime treats as "can still make progress," so the all-asleep condition is never reached.

**Q2. Name the four Coffman conditions and how you'd break circular wait.**
*Answer:* Mutual exclusion, hold-and-wait, no-preemption, circular wait. Break circular wait with a **total ordering** on locks: always acquire lower-ranked locks first. If you ever need them in a different order, sort by a stable key (e.g., an assigned ID or pointer value) before locking.
*Follow-up: How do you order two `*Account` mutexes for a transfer?* Compare a stable ID and lock the smaller one first; if equal, lock once.

**Q3. Write a deadlock with channels in one goroutine.**
*Answer:* `ch := make(chan int); ch <- 1` — an unbuffered send with no receiver blocks `main` forever, and since it's the only goroutine, the detector fires immediately.
*Follow-up: Make it not deadlock without adding a goroutine.* Buffer it: `make(chan int, 1)`.

**Q4. Difference between a deadlock and a livelock?**
*Answer:* In a deadlock goroutines are blocked (parked, zero CPU). In a livelock they are actively running and changing state but making no useful progress — e.g., two goroutines repeatedly `TryLock`, fail, back off, and retry in lockstep forever. The runtime detector never catches livelock because goroutines are runnable.
*Follow-up: How do you fix the TryLock livelock?* Add randomized/exponential back-off (jitter) so the two goroutines desynchronize.

**Q5. Does `sync.RWMutex` introduce deadlock risks that `Mutex` doesn't?**
*Answer:* Yes. A goroutine that holds `RLock` and then calls `Lock` (read-to-write upgrade) deadlocks — Go's `RWMutex` is neither reentrant nor upgradable. Also, a pending writer blocks new readers (to prevent writer starvation), so a recursive `RLock` taken while a writer waits can self-deadlock.
*Follow-up: How to upgrade safely?* Release the read lock, take the write lock, and **re-validate** state because it may have changed in the gap.

**Q6. Can `defer mu.Unlock()` cause a deadlock?**
*Answer:* Not by itself, but it can mask one: holding the lock until return widens the window for lock-ordering violations. And calling a function that re-acquires the same non-recursive mutex while you hold it deadlocks.
*Follow-up: Is `sync.Mutex` reentrant?* No. Re-locking the same `Mutex` on the same goroutine deadlocks.

**Q7. How would you detect a partial deadlock in production?**
*Answer:* Watch the `go_goroutines` metric for monotonic growth, then capture a goroutine profile (`/debug/pprof/goroutine?debug=2`) and look for many goroutines stuck in `[semacquire]` or `[chan receive]` for a long time at the same stack. Correlate the two blocked stacks to find the cycle.
*Follow-up: What's the giveaway in the dump?* Goroutine states with long wait durations (the `, N minutes` annotation) and matching lock addresses across two stacks.

## 6. Production Use Cases

Deadlocks are anti-patterns, so "use cases" here means *where they bite real systems and the patterns that prevent them*:

- **Database/connection pools** (`database/sql`, pgx, and HikariCP-style pools elsewhere): a goroutine holding one pooled connection while requesting a second, when the pool is exhausted, is a classic hold-and-wait deadlock. Fix: never hold a connection while requesting another; size pools above max concurrent multi-connection operations.
- **Bank/ledger transfers** (Stripe, payment systems): `transfer(A→B)` and `transfer(B→A)` running concurrently with naive `A.Lock(); B.Lock()` produce circular wait. The industry-standard fix is **ordered locking by account ID**.
- **Kubernetes controllers / informers**: workqueue handlers that grab a shared cache lock and then call into a reconciler that grabs the same lock have caused real controller hangs. Controller-runtime guidance is to keep lock scopes tiny and never call out while holding a lock.
- **Actor/message systems**: synchronous request-reply between two goroutines over unbuffered channels (`a` sends to `b` and waits for reply; `b` sends to `a` and waits) deadlocks. Erlang/Akka-style systems and Go services using channel-RPC hit this; fix with buffered reply channels or `select` + `context` timeouts.
- **The Go standard library itself** has shipped deadlock fixes — historical `net/http` and `database/sql` lock-ordering bugs — illustrating that even expert code is vulnerable.

## 7. Common Mistakes

> [!WARNING]
> The most dangerous deadlocks are the ones the runtime detector *cannot* see, because at least one goroutine is parked in netpoll or on a timer.

- **Inconsistent lock ordering.** Function `f` locks A then B; function `g` locks B then A. The textbook cycle.
- **Calling out while holding a lock.** Invoking a callback, a channel op, or an RPC while holding a mutex — the callee may try to re-enter or block on something you're waiting for.
- **Re-locking a non-reentrant `Mutex`** (directly or via a helper that also locks).
- **RWMutex read→write upgrade** in place.
- **Unbuffered channel with no concurrent peer**, especially in `main`.
- **`WaitGroup` misuse:** calling `wg.Add` inside the goroutine (after `Wait` may have started), or forgetting `wg.Done`, leaving `Wait` parked forever.
- **Forgetting a `default` or a `context`/timeout in `select`**, turning a transient stall into a permanent block.
- **Holding a lock across a channel send** to a channel whose reader needs the same lock.

## 8. Performance Considerations

A deadlock is the ultimate performance failure — *zero* throughput for the involved work. But the prevention techniques have real costs worth quantifying:

- **Lock ordering is free at runtime.** Imposing a total order costs nothing in CPU; it's purely a discipline. Prefer it over the alternatives.
- **`TryLock` + back-off trades latency for safety.** Spinning/retrying burns CPU and increases tail latency under contention. Use bounded retries with jitter; never an unbounded busy loop.
- **Coarse locks reduce deadlock surface but throttle throughput.** A single big mutex can't deadlock against itself within ordered code, but it serializes everything. Fine-grained locks scale better yet multiply ordering hazards. This is the central trade-off.
- **Channel buffering** removes some hold-and-wait deadlocks at the cost of memory and weaker backpressure — a full buffer just defers the block.
- **`context.WithTimeout`** converts a potential infinite block into a bounded one; the cost is a timer per operation (cheap, tens of ns to arm) and the need to handle the timeout path.

> [!TIP]
> Measure lock contention with `go tool pprof` on a mutex profile (`runtime.SetMutexProfileFraction(1)`). High contention is the breeding ground for both performance loss and ordering bugs.

## 9. Best Practices

1. **Establish a global lock order** and document it. Acquire in that order, release in reverse.
2. **Keep critical sections tiny.** Compute outside the lock; mutate inside.
3. **Never call unknown code (callbacks, channel ops, RPCs) while holding a lock.**
4. **Prefer channels for ownership transfer, mutexes for protecting state** — don't mix blocking channel ops inside locked regions.
5. **Always pair `Add`/`Done`; call `Add` before launching the goroutine.**
6. **Put a timeout/`context` on every blocking wait** that could plausibly stall.
7. **Use `go vet`, `go test -race`, and a deadlock detector in CI.**
8. **Make helpers explicit about locking** — name them `xxxLocked` if the caller must already hold the lock.

## 10. Code Examples

The primary idiom: **ordered locking** to break circular wait. The two blocks below are switchable tabs — naive (buggy) vs. ordered (correct).

```go
// BUGGY: circular wait. transfer(a,b) and transfer(b,a) can deadlock.
func transfer(from, to *Account, amount int64) {
	from.mu.Lock()
	defer from.mu.Unlock()
	to.mu.Lock() // <-- if another goroutine locked `to` then `from`, deadlock
	defer to.mu.Unlock()

	from.balance -= amount
	to.balance += amount
}
```

```go
// CORRECT: impose a total order on locks via a stable ID.
type Account struct {
	id      int64
	mu      sync.Mutex
	balance int64
}

func transfer(from, to *Account, amount int64) {
	// Always lock the lower id first -> no cycle is possible.
	first, second := from, to
	if from.id > to.id {
		first, second = to, from
	}
	first.mu.Lock()
	defer first.mu.Unlock()
	if from.id != to.id { // guard self-transfer (re-lock would deadlock)
		second.mu.Lock()
		defer second.mu.Unlock()
	}
	from.balance -= amount
	to.balance += amount
}
```

A second, standalone example: using `TryLock` with bounded back-off to avoid the no-preemption condition. This prose separates it so it renders as its own block.

```go
// Avoid no-preemption: if we can't get the second lock, release the first
// and retry with jitter. Caps retries to avoid livelock.
func transferTry(from, to *Account, amount int64) error {
	for attempt := 0; attempt < 100; attempt++ {
		from.mu.Lock()
		if to.mu.TryLock() {
			from.balance -= amount
			to.balance += amount
			to.mu.Unlock()
			from.mu.Unlock()
			return nil
		}
		from.mu.Unlock() // back off — do NOT hold and wait
		time.Sleep(time.Duration(rand.Int63n(int64(time.Millisecond))))
	}
	return errors.New("transfer: lock acquisition timed out")
}
```

And the minimal runtime-detected deadlock, useful in interviews:

```go
func main() {
	ch := make(chan int) // unbuffered
	ch <- 1              // blocks forever; the only goroutine is now asleep
	// fatal error: all goroutines are asleep - deadlock!
}
```

## 11. Advanced Concepts

**Lock ranking (lockdep-style).** Large codebases assign each mutex a numeric *rank* and assert at acquisition time that you only ever take higher-ranked locks while holding lower-ranked ones. The Linux kernel's `lockdep` and Go's internal `runtime/lockrank.go` do exactly this for the runtime's own locks. You can emulate it in app code with a `-tags lockcheck` build that wraps `Mutex` and records the per-goroutine lock-held set.

**The netpoll exemption, formally.** `checkdead` checks whether the network poller has any fds registered. If so, it assumes a network event could unblock a goroutine and refuses to declare deadlock. This is why TCP servers never self-report internal deadlocks — and why `-race` builds plus pprof are mandatory in production.

**System goroutines don't count.** GC workers, the scavenger, `sysmon`, and finalizer goroutines are excluded from the live count. A deadlock among only system goroutines would be a runtime bug, not yours.

**Channel-based deadlocks are graph cycles too.** An unbuffered channel `a→b` plus `b→a` where each side sends-then-receives forms a waits-for cycle identical in spirit to a lock cycle. The fix mirrors lock ordering: make one side asynchronous (buffer) or break symmetry with `select` + `context`.

**Distributed deadlock** (across services, not goroutines) cannot be detected by the Go runtime at all — it requires timeouts, deadlock-detection algorithms (edge-chasing / Chandy-Misra-Haas), or simply *never* taking distributed locks in a cycle. Prefer lease-based locks with TTLs (etcd, Redis with expiry) so a stuck holder self-heals.

## 12. Debugging Tips

> [!NOTE]
> `SIGQUIT` (Ctrl-\\) on a hung Go process dumps **all** goroutine stacks to stderr — the fastest way to see who's blocked on what.

- **Goroutine profile:** `curl localhost:6060/debug/pprof/goroutine?debug=2` (with `net/http/pprof` imported). Look for `[semacquire]`, `[chan receive]`, `[chan send]`, `[sync.WaitGroup.Wait]` states and the `, N minutes` age annotation.
- **Match the cycle:** two stacks, each blocked acquiring a lock the other holds — note the lock addresses if visible, or the function names.
- **`GODEBUG=schedtrace=1000`** prints scheduler state every second; a wedged system shows a constant nonzero goroutine count with zero progress.
- **Race detector:** `go test -race` won't directly find deadlocks but catches the data races that often co-occur with sloppy locking.
- **Third-party:** `github.com/sasha-s/go-deadlock` is a drop-in `Mutex`/`RWMutex` replacement that maintains a lock-order graph and detects potential circular waits *and* long-held locks at runtime — invaluable in test/staging.
- **Reproduce under load:** partial deadlocks are concurrency-dependent; run with high `GOMAXPROCS` and hammer with concurrent requests.

## 13. Senior Engineer Notes

As a senior engineer, your leverage is in **code review and local design judgement**. When reviewing concurrent code, mechanically check: (1) Is there more than one lock acquired in any single call path? If so, is the order consistent everywhere? (2) Is any lock held across a channel op, callback, RPC, or another `Lock`? (3) Are `WaitGroup.Add` calls before goroutine launch? These three questions catch the vast majority of deadlocks.

Push for the *cheapest* fix that works: a total lock order beats `TryLock` back-off, which beats coarsening locks. Insist that any function requiring the caller to hold a lock be named `...Locked` and documented — implicit lock contracts are how teams accidentally re-lock. Mentor juniors to default to **channels for handoff, mutexes for short state protection**, and to treat "I'll just hold the lock a little longer for convenience" as a red flag. Require `go-deadlock` in the test build for any package with non-trivial locking, and make goroutine-count alerting a standard part of every service's dashboard so partial deadlocks surface as graphs, not pages at 3 a.m.

## 14. Staff Engineer Notes

At staff level the question shifts from "is this function deadlock-free" to "does our architecture make deadlocks *structurally* unlikely, and can we detect them org-wide." Favor designs that eliminate the conditions entirely: single-writer goroutines owning state (no shared mutex), event loops, and immutable/CRDT data approaches sidestep mutual exclusion. Where shared locks are unavoidable, define an **org-wide lock-rank registry** and enforce it in CI for core libraries — turn discipline into a test-time guarantee rather than tribal knowledge.

On build-vs-buy: adopt `go-deadlock` (buy) rather than building a bespoke detector, but invest engineering time in **observability standards** (uniform goroutine-state metrics, automatic pprof capture on health-check failure) because that's what catches the partial deadlocks no library will. For cross-team boundaries, mandate that any synchronous cross-service call carry a `context` deadline — distributed deadlocks are undetectable and must be designed out with TTL-based leases. Weigh the throughput cost of coarse locking against the operational cost of subtle deadlocks: for a system handling 100k req/s, a single internal lock cycle that leaks 10 goroutines/sec is a multi-hour-to-OOM incident, so the org-level trade-off usually favors *simplicity and detectability over maximal lock granularity*. Make "no locks held across I/O boundaries" an architectural invariant, not a review comment.

## 15. Revision Summary

- A deadlock = goroutines permanently blocked in a circular waits-for relationship.
- **Four Coffman conditions:** mutual exclusion, hold-and-wait, no-preemption, circular wait — break any one to prevent deadlock.
- Go's runtime detector (`checkdead`) only fires when **all** goroutines are asleep; netpoll fds and pending timers count as "can progress," so partial deadlocks in real servers are invisible to it.
- The runtime builds **no** waits-for graph for mutexes — cycle prevention is the programmer's job.
- **Primary fix: total lock ordering** (lock by stable ID/rank). Secondary: `TryLock` + jittered back-off; tertiary: coarser locks or buffered channels.
- Never hold a lock across a channel op, callback, RPC, or another lock; `sync.Mutex` is not reentrant; `RWMutex` can't upgrade read→write.
- **Detect in prod:** goroutine-count growth, `pprof goroutine?debug=2`, `SIGQUIT` dumps, `GODEBUG=schedtrace`, and `go-deadlock` in tests.
- Distributed deadlocks need timeouts/TTL leases — the runtime can't help.

**References:** Go runtime source (`runtime/proc.go` `checkdead`, `runtime/sema.go`, `runtime/lockrank.go`); Go Memory Model; `sync` package docs; Dijkstra, *Dining Philosophers* (1965); Coffman et al., *System Deadlocks* (1971); `github.com/sasha-s/go-deadlock`.

---

*Go Engineering Handbook — topic 44.*
