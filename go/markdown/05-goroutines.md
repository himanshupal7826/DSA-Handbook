# 05 · Goroutines

> **In one line:** Lightweight concurrent functions multiplexed onto OS threads.

---

## 1. Overview

A goroutine is a function running concurrently, scheduled by the Go runtime onto a small pool of OS threads. They're cheap (KBs of stack) so you can run thousands. Coordinate completion with `sync.WaitGroup`; never assume ordering.

## 2. Key Concepts

- `go f()` starts a goroutine; it returns immediately.
- Goroutines are multiplexed (M:N) onto OS threads by the scheduler.
- Use sync.WaitGroup to wait for a group to finish.
- The main goroutine exiting kills all others.
- Concurrency is not parallelism — GOMAXPROCS controls parallelism.

## 3. Syntax & Code

```go
var wg sync.WaitGroup
for i := 0; i < 3; i++ {
    wg.Add(1)
    go func(id int) {       // pass i as arg to avoid capture bug
        defer wg.Done()
        fmt.Println("worker", id)
    }(i)
}
wg.Wait() // block until all done
```

## 4. Worked Example

**Loop variable capture (pre-Go 1.22)**

Capturing the loop variable by reference is a classic bug:

```go
// BUG (old Go): all goroutines may print the final i
for i := 0; i < 3; i++ { go func(){ fmt.Println(i) }() }
// FIX: pass it in -> go func(i int){...}(i)
```

## 5. Best Practices

- ✅ Pass loop variables as arguments to goroutines.
- ✅ Always have a way to wait for or cancel goroutines.
- ✅ Avoid leaking goroutines blocked forever on a channel.
- ✅ Use the race detector (go test -race).
- ✅ Limit concurrency with a worker pool / semaphore.

## 6. Common Pitfalls

1. ⚠️ Loop-variable capture launching goroutines sharing one variable.
2. ⚠️ Goroutine leaks blocked on channels with no sender/receiver.
3. ⚠️ Main exiting before goroutines run.
4. ⚠️ Data races on shared variables (use channels or mutexes).
5. ⚠️ Unbounded goroutine creation exhausting memory.
6. ⚠️ Forgetting wg.Add before launching.

## 7. Interview Questions

1. **Q: Goroutine vs OS thread?**
   A: Goroutines are user-space, cheap (~KB stack), multiplexed M:N onto threads by the runtime scheduler.

2. **Q: Concurrency vs parallelism?**
   A: Concurrency is structuring independent tasks; parallelism is running them simultaneously (needs multiple cores/GOMAXPROCS).

3. **Q: How to wait for goroutines?**
   A: sync.WaitGroup: Add before launch, Done on finish, Wait to block.

4. **Q: Classic loop-capture bug?**
   A: Goroutines closing over the loop variable share it; pass it as a parameter (fixed by Go 1.22 per-iteration scoping).

5. **Q: What is a goroutine leak?**
   A: A goroutine blocked forever (e.g., on a channel) that never exits, wasting memory.

6. **Q: How to detect data races?**
   A: Run with -race; it instruments memory access to flag concurrent unsynchronized access.

7. **Q: How to bound concurrency?**
   A: Worker pool or a buffered-channel semaphore.

8. **Q: What kills goroutines?**
   A: Nothing explicitly — they end when their function returns or the program exits.

## 8. Practice

- [ ] Launch N workers with a WaitGroup.
- [ ] Reproduce and fix the loop-capture bug.
- [ ] Run a program under -race and fix a reported race.

## 9. Quick Revision

Goroutines = cheap concurrent funcs (M:N scheduled). Coordinate with WaitGroup; pass loop vars as args; avoid leaks/races; bound with pools. Concurrency ≠ parallelism.

**References:** Go blog: Concurrency

---

*Go Handbook — topic 05.*
