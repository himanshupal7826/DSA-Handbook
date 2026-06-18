# 10 · Concurrency Patterns & Sync

> **In one line:** Mutexes, atomics, and pipeline/fan-out patterns.

---

## 1. Overview

When goroutines share memory, protect it with `sync.Mutex`/`RWMutex` or use `sync/atomic` for simple counters. Structured patterns — pipelines, fan-out/fan-in, worker pools — keep concurrent code correct and bounded. Always test with the race detector.

## 2. Key Concepts

- Mutex guards a critical section; RWMutex allows concurrent readers.
- sync/atomic for lock-free counters/flags.
- sync.Once for one-time initialization.
- Pipeline: stages connected by channels; fan-out: many workers from one channel.
- Detect races with go test/build -race.

## 3. Syntax & Code

```go
type SafeCounter struct {
    mu sync.Mutex
    n  int
}
func (c *SafeCounter) Inc() {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.n++
}
```

## 4. Worked Example

**Fan-out / fan-in**

Spread work, then merge results:

```go
func fanIn(chs ...<-chan int) <-chan int {
    out := make(chan int)
    var wg sync.WaitGroup
    for _, c := range chs {
        wg.Add(1)
        go func(c <-chan int){ defer wg.Done(); for v := range c { out <- v } }(c)
    }
    go func(){ wg.Wait(); close(out) }()
    return out
}
```

## 5. Best Practices

- ✅ Guard all access to shared mutable state with the same lock.
- ✅ Keep critical sections short.
- ✅ Use atomics for simple counters/flags instead of a mutex.
- ✅ Bound concurrency with worker pools.
- ✅ Run -race in CI.

## 6. Common Pitfalls

1. ⚠️ Forgetting to unlock (use defer).
2. ⚠️ Copying a struct containing a Mutex.
3. ⚠️ Mixed atomic and non-atomic access to the same variable.
4. ⚠️ Deadlocks from acquiring locks in inconsistent order.
5. ⚠️ RWMutex misuse (writers starved or read-locked during writes).
6. ⚠️ Closing a channel from multiple goroutines.

## 7. Interview Questions

1. **Q: Mutex vs channel?**
   A: Mutex protects shared state in place; channels transfer ownership/coordinate. Choose by the problem.

2. **Q: When use sync/atomic?**
   A: For simple lock-free counters/flags where a full mutex is overkill.

3. **Q: What does sync.Once do?**
   A: Guarantees a function runs exactly once, e.g., lazy singleton init.

4. **Q: RWMutex benefit?**
   A: Multiple concurrent readers, exclusive writers — good for read-heavy data.

5. **Q: How to bound concurrency?**
   A: Worker pool or a semaphore channel of fixed size.

6. **Q: Why not copy a Mutex?**
   A: Copying duplicates lock state and breaks mutual exclusion.

7. **Q: Fan-out/fan-in?**
   A: Distribute work to N workers (fan-out) and merge their outputs into one channel (fan-in).

8. **Q: How to find races?**
   A: Build/test with -race; it instruments memory accesses to detect unsynchronized sharing.

## 8. Practice

- [ ] Make a thread-safe counter with Mutex and with atomic.
- [ ] Build a pipeline of 3 stages via channels.
- [ ] Implement fan-out/fan-in for a CPU task.

## 9. Quick Revision

Protect shared state with Mutex/RWMutex or atomics; structure work as pipelines/fan-out/worker pools; keep critical sections short; never copy a Mutex; test with -race.

**References:** sync package; race detector

---

*Go Handbook — topic 10.*
