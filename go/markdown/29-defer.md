# 29 · Defer

> **In one line:** `defer` schedules a function call to run when the surrounding function returns, executing deferred calls in LIFO order with their arguments evaluated *at the point of the `defer` statement*.

---

## 1. Overview

`defer` is Go's mechanism for guaranteeing that cleanup runs no matter how a function exits — normal return, early `return`, or `panic`. You write the cleanup *next to* the resource acquisition, so the code that opens a file, locks a mutex, or starts a span sits one line above the code that closes it. The Go runtime then guarantees the deferred call fires on the way out.

Three rules define almost everything about `defer`:

1. **LIFO order.** Deferred calls run last-in-first-out — the most recently deferred runs first.
2. **Argument capture at `defer` time.** The arguments to the deferred function are *evaluated immediately* when `defer` executes, not when the call eventually runs. Only the actual invocation is delayed.
3. **It can read and mutate named return values.** A deferred closure runs *after* the `return` statement sets the result variables but *before* the function actually hands control back to the caller — so it can inspect and rewrite the return.

These three rules are the source of every interview trick and every subtle bug. Master them and `defer` becomes boring and reliable, which is exactly what you want from cleanup code.

## 2. Why It Exists

Before `defer`, resource cleanup in C-style languages relies on either (a) `goto cleanup` ladders or (b) remembering to call `close`/`unlock` at *every* exit point. Both are fragile: add an early `return` for a new error case and you silently leak a file descriptor or hold a lock forever. Go has no exceptions and no RAII destructors, so it needed a first-class way to tie cleanup to a scope.

`defer` solves this by decoupling *when you write* cleanup from *when it runs*. The benefits:

- **Locality:** acquisition and release are adjacent, so reviewers verify correctness by eye.
- **Exit-path safety:** the cleanup runs across *all* return paths and during `panic` unwinding — critical for releasing mutexes so a panicking goroutine doesn't deadlock the rest of the program.
- **Composability with `recover`:** `recover` only works inside a deferred function, making `defer` the foundation of Go's panic-handling model (see the Go blog, *Defer, Panic, and Recover*).

The philosophy is *make the safe thing the easy thing*. `defer mu.Unlock()` immediately after `mu.Lock()` is harder to get wrong than scattering unlocks across ten branches.

## 3. Internal Working

A `defer` statement registers a deferred call on the goroutine. Historically (Go ≤ 1.12) every `defer` allocated a `_defer` struct on the heap and pushed it onto a singly linked list hanging off the goroutine (`g._defer`). At function return, the runtime walked that list calling `runtime.deferreturn`. That cost ~50ns per defer plus an allocation.

Modern Go (1.13 introduced *stack-allocated defers*; 1.14 introduced *open-coded defers*) is far cheaper:

- **Stack-allocated `_defer` (1.13+):** when a `defer` isn't in a loop, the `_defer` record lives on the stack instead of the heap — no GC pressure.
- **Open-coded defers (1.14+):** when the compiler can statically bound the defers in a function (no `defer` inside a loop, ≤ 8 defers), it skips the `_defer` struct entirely. It allocates the deferred funcs' arguments as locals, sets a bitmask ("defer bits") tracking which defers are active, and *inlines* the calls directly at each return site. This makes `defer` nearly as cheap as a hand-written function call — within a few nanoseconds.

The `_defer` struct (heap/stack path) roughly looks like this, and LIFO falls naturally out of prepending to the list head:

```text
type _defer struct {
    started bool
    heap    bool      // heap- or stack-allocated?
    sp      uintptr   // stack pointer at defer time
    pc      uintptr   // return address
    fn      func()    // the deferred function (Go 1.18+ closure form)
    link    *_defer   // next defer in the LIFO chain
    ...
}

goroutine g
   |
   | g._defer  -->  [defer C] --link--> [defer B] --link--> [defer A] --> nil
                       ^ pushed last                          ^ pushed first
   pop from head  ===> runs C, then B, then A   (LIFO)
```

Each `defer` *prepends* to the head of the list, so unwinding from the head reverses registration order. Argument capture timing is explained by *when* the record is built — the runtime evaluates the deferred call's arguments and stores them in the `_defer`/local slots *at the moment the `defer` executes*, then only the call happens later.

During a `panic`, `runtime.gopanic` walks the same `_defer` chain, running deferred funcs; if one calls `recover`, the panic is marked recovered and normal return resumes from that frame.

## 4. Syntax

```go
defer fmt.Println("runs last, before return")

f, err := os.Open("data.txt")
if err != nil {
    return err
}
defer f.Close() // f captured now; Close() called at function exit

mu.Lock()
defer mu.Unlock()

// Deferred closure (no args captured eagerly — reads vars at run time):
defer func() {
    fmt.Println("cleanup with current state")
}()
```

Key syntactic facts:

- `defer` must be followed by a *function or method call*, not an arbitrary expression.
- Arguments and the receiver are evaluated immediately; the call is deferred.
- A bare deferred function call vs. a deferred *closure* (`func(){ ... }()`) is the single most important distinction — the closure defers argument evaluation by reading variables lazily inside its body.

## 5. Common Interview Questions

**Q1. What order do deferred calls run in?**
LIFO — reverse of registration. `defer A; defer B; defer C` runs C, B, A.
*Follow-up: why LIFO?* Because cleanup must mirror acquisition: you release the inner resource before the outer one (close file before releasing the buffer that wraps it).

**Q2. When are the arguments to a deferred function evaluated?**

```go
func f() {
    i := 0
    defer fmt.Println(i) // prints 0
    i = 10
}
```

At `defer` time, not at call time — so this prints `0`.
*Follow-up: how do I print the final value of `i`?* Use a closure: `defer func() { fmt.Println(i) }()` prints `10` because it reads `i` lazily.

**Q3. Can `defer` modify the return value?**

```go
func f() (result int) {
    defer func() { result *= 2 }()
    return 21 // result set to 21, then deferred doubles it -> 42
}
```

Yes, but only with *named* return values, because the deferred closure runs after `return` assigns them.
*Follow-up: what if returns are unnamed?* Then the deferred func cannot touch the result; the value is already copied out.

**Q4. What happens with `defer` inside a loop?**
Each iteration registers a new defer, but none run until the *function* returns — not the loop iteration. In a long loop this leaks resources (open files, locks) and grows the defer chain.
*Follow-up: fix it?* Wrap the loop body in its own function (or use a closure) so each iteration's defers fire per-iteration; Go 1.22's per-iteration loop variables don't change this — scope is still the function.

**Q5. Does `defer` run if the function panics?**
Yes. Deferred calls run during panic unwinding, which is exactly why you can `recover` inside one.
*Follow-up: does it run on `os.Exit`?* No. `os.Exit` terminates immediately without running any defers — a common gotcha.

**Q6. What's the performance cost of `defer`?**
With open-coded defers (Go 1.14+) it's within a few ns of a direct call. In hot loops or pre-1.14 code it can matter (~35–50ns + heap alloc).
*Follow-up: when does open-coding *not* apply?* Defers inside loops, or more than 8 defers in a function, fall back to the slower runtime path.

**Q7. If a deferred function panics, what happens to other defers?**
The remaining deferred calls *still run*; the new panic replaces/augments any in-flight panic. The last unrecovered panic propagates.
*Follow-up:* you can see the chain via `panic: ... [recovered]` and nested panic messages.

## 6. Production Use Cases

- **Mutex release:** `mu.Lock(); defer mu.Unlock()` is ubiquitous across the Go standard library (`sync`, `net/http`, `database/sql`) and ensures locks release even on panic — preventing cluster-wide deadlocks in services like etcd and Kubernetes controllers.
- **Closing resources:** `defer f.Close()`, `defer rows.Close()` (in `database/sql`), `defer resp.Body.Close()` (in `net/http` clients). Forgetting the last one leaks connections and is one of the most common production bugs in Go HTTP clients.
- **Transaction rollback:** `defer tx.Rollback()` paired with a `tx.Commit()` — `Rollback` after `Commit` is a no-op, so this idiom guarantees no dangling transactions. Used heavily in GORM-based and `sqlx`-based services.
- **Tracing/metrics spans:** OpenTelemetry and Datadog Go SDKs use `ctx, span := tracer.Start(ctx, "op"); defer span.End()`. Timing wrappers: `defer func(t time.Time){ metrics.Observe(time.Since(t)) }(time.Now())`.
- **Unbuffering/flushing:** `defer w.Flush()` for `bufio.Writer`, `defer pprof.StopCPUProfile()`.
- **`recover` boundaries:** HTTP middleware (e.g., gin's `Recovery()`, gRPC interceptors) wrap handlers in a deferred `recover` so one panicking request doesn't crash the whole server process.

## 7. Common Mistakes

> [!WARNING]
> The most expensive `defer` bugs are silent resource leaks — they pass tests and only surface under production load as FD exhaustion or connection-pool starvation.

- **`defer` in a long loop** — defers accumulate until function exit; can exhaust file descriptors.
- **Ignoring the error from a deferred `Close()`** — for writers, `Close()` may flush and *fail*; `defer f.Close()` swallows that error. Capture it (see §10).
- **Expecting eager argument evaluation to be lazy** — `defer log.Printf("done %d", count)` captures `count` *now*, not at exit.
- **`defer resp.Body.Close()` before checking `err`** — if `http.Get` errored, `resp` is `nil` and the deferred close panics. Check `err` first.
- **Assuming `os.Exit` / `log.Fatal` run defers** — they don't.
- **Deferring inside a goroutine and expecting it to run when the parent returns** — it runs when *that goroutine's* function returns.

## 8. Performance Considerations

| Scenario | Mechanism | Approx. cost |
|---|---|---|
| ≤ 8 defers, none in loops (Go 1.14+) | Open-coded, inlined at returns | ~1–3 ns (near-free) |
| Stack-allocated `_defer` (Go 1.13) | Stack record + `deferreturn` | ~10–35 ns |
| Heap path (loop defers, >8 defers, pre-1.13) | Heap alloc + linked list | ~35–50 ns + GC pressure |

Practical guidance: in the **vast majority of code, `defer` is free enough to always use**. Only in *measured* hot paths — tight loops executing millions of times, e.g., a lock taken per element in an inner loop — should you consider hoisting the lock or inlining the unlock manually. Always benchmark with `go test -bench` before micro-optimizing; the readability and safety of `defer` usually wins.

> [!NOTE]
> A `defer` inside a `for` loop forces the heap path *and* delays all cleanup to function exit — it's both a correctness and performance smell.

## 9. Best Practices

- Place `defer cleanup()` *immediately* after successful acquisition, after the error check.
- Prefer a **closure** when you need the final value of a variable or must capture an error from `Close()`.
- For per-iteration cleanup in loops, **extract the body into a function**.
- Don't `defer` in extreme hot paths if a benchmark proves it matters — otherwise always do.
- Use `defer` for `recover` only at well-defined boundaries (request handlers, worker loops), never to mimic try/catch for ordinary control flow.
- Name return values when a deferred function must adjust them — and document *why* to avoid surprising reviewers.

## 10. Code Examples

Primary idiomatic example — guaranteeing cleanup and capturing a `Close` error via a named return:

```go
// writeConfig writes data and reports a Close error if the write itself succeeded.
func writeConfig(path string, data []byte) (err error) {
    f, err := os.Create(path)
    if err != nil {
        return fmt.Errorf("create: %w", err)
    }
    defer func() {
        if cerr := f.Close(); cerr != nil && err == nil {
            err = fmt.Errorf("close: %w", cerr) // surface a flush failure
        }
    }()

    if _, err = f.Write(data); err != nil {
        return fmt.Errorf("write: %w", err)
    }
    return nil // deferred close runs here; may overwrite err if it fails
}
```

```go
// Alternative: per-iteration cleanup by extracting the loop body.
func processAll(paths []string) error {
    for _, p := range paths {
        if err := processOne(p); err != nil { // defers fire per call, not per loop
            return err
        }
    }
    return nil
}

func processOne(p string) error {
    f, err := os.Open(p)
    if err != nil {
        return err
    }
    defer f.Close() // runs when processOne returns, every iteration
    return scan(f)
}
```

A second standalone example showing LIFO and argument-capture timing together:

```go
func demo() {
    for i := 0; i < 3; i++ {
        defer fmt.Print(i, " ") // captures i now: 0,1,2 registered
    }
    // Output at return (LIFO): 2 1 0
}
```

## 11. Advanced Concepts

- **`defer` + `recover` + re-panic:** middleware often recovers, logs, then re-panics or converts to a `500`. A recovered panic stops unwinding at that frame; returning normally afterward resumes as a clean return.
- **Multiple panics:** if a deferred func panics while a panic is already unwinding, Go records both; the runtime prints `panic: A [recovered]` chains. Only one can ultimately be recovered.
- **Open-coded defer fallback triggers:** the compiler emits a "defer is not open-coded" decision visible via `go build -gcflags=-d=defer`. Knowing this helps explain a benchmark regression when someone adds a 9th defer.
- **`defer` and goroutine stacks:** because `_defer` records reference the stack pointer, a deferred call participates correctly in stack copying/growth — you never observe a moved stack.
- **Deferred method-value vs method-expression:** `defer obj.Method()` evaluates `obj` (the receiver) at `defer` time. If `obj` is a pointer that's later reassigned, the *original* pointee is used.

```go
type T struct{ name string }

func (t T) show() { fmt.Println(t.name) }

func capture() {
    t := T{"first"}
    defer t.show() // value receiver copied NOW -> prints "first"
    t.name = "second"
}
```

## 12. Debugging Tips

- **"Why is my file still open?"** — search for `defer ... Close()` *inside a loop*; refactor into a helper.
- **Unexpected return value** — check for a deferred closure mutating a *named* return. `grep` the func signature for named results.
- **Wrong logged value** — you used `defer log.Print(x)` (eager) instead of `defer func(){ log.Print(x) }()` (lazy).
- **Panic with no defers running** — confirm the process didn't hit `os.Exit`/`log.Fatal`.
- **Benchmark regression** — run `go build -gcflags='-m -d=defer'` to see whether open-coding was disabled; count your defers (>8) and check for loop defers.
- Use `dlv` (Delve): set a breakpoint on the deferred closure to inspect captured state at the moment it runs.

## 13. Senior Engineer Notes

As a senior engineer, your `defer` judgement shows up in code review. Things to enforce:

- **Reject `defer` inside loops** unless the loop body is trivially short and the function exits soon. Push for an extracted helper. This is the single highest-value `defer` review comment.
- **Demand error handling on deferred `Close()` for writers.** A swallowed flush error has corrupted production data more than once. For *readers*, `defer f.Close()` ignoring the error is acceptable and idiomatic — know the difference and articulate it.
- **Watch the eager-vs-lazy argument trap** in logging/metrics defers — it's a frequent source of "the log says 0" tickets.
- **Mentor on named returns:** they're powerful for `defer`-based error wrapping but reduce readability if overused. Teach the team a consistent house style.
- **Insist on `tx.Rollback()` deferred immediately** after `Begin`, relying on Rollback-after-Commit being a no-op. It eliminates an entire class of leaked transactions.

You should be able to explain *why* a given `defer` is or isn't open-coded when a teammate asks why a benchmark moved.

## 14. Staff Engineer Notes

At staff level, `defer` is rarely the headline — but its *systemic* consequences are. Your concerns are org- and architecture-wide:

- **Standardize panic-recovery boundaries.** Decide org-wide where `recover` lives (HTTP/gRPC middleware, worker frameworks) and forbid ad-hoc recovers that hide bugs. A consistent `defer recover()` layer that logs, emits a metric, and returns a structured error is a reliability contract across every service.
- **Build-vs-buy for cleanup-heavy abstractions.** When teams repeatedly hand-roll `defer span.End()` / `defer metrics.Observe(...)`, invest in a shared middleware/decorator library so observability is consistent rather than copy-pasted with subtle differences.
- **FD/connection budgets as an SLO input.** Loop-defer leaks manifest as connection-pool exhaustion under load. Bake `golangci-lint` rules (e.g., `bodyclose`, `sqlclosecheck`, `revive`) into CI so the entire org catches leaks pre-merge instead of in an incident.
- **Performance posture:** publish guidance that `defer` is "always on" by default, with a narrow, *benchmarked* exception list for hot paths. Prevents cargo-cult micro-optimization that hurts readability across hundreds of repos.
- **Failure-mode literacy:** ensure your platform handles the `os.Exit`-skips-defers reality — e.g., graceful-shutdown code must not rely on defers in `main` if a hard exit path exists. This shapes how shutdown, draining, and flush-on-exit are designed fleet-wide.

## 15. Revision Summary

- `defer` schedules a call to run at function exit, in **LIFO** order.
- **Arguments are evaluated at `defer` time**; use a **closure** for lazy/final values.
- A deferred closure can **read and modify named return values** (runs after `return` assigns them, before control leaves).
- Runs during **panic** unwinding → foundation of **`recover`**; does **not** run on `os.Exit`/`log.Fatal`.
- **Loop defer** delays cleanup to function exit and forces the heap path — extract a helper instead.
- Modern Go uses **open-coded defers** (1.14+): near-free for ≤ 8 non-loop defers; loops/>8 fall back to the slower runtime chain.
- Idioms: `defer mu.Unlock()`, `defer f.Close()`, `defer rows.Close()`, `defer resp.Body.Close()`, `defer tx.Rollback()`, `defer span.End()`.
- Handle the error from a deferred `Close()` on **writers**; ignoring it on readers is fine.

**References:** Go blog — *Defer, Panic, and Recover*; Go spec (Defer statements); `runtime/panic.go` (`_defer`, `gopanic`, `deferreturn`); Go 1.13/1.14 release notes (stack-allocated & open-coded defers).

---
*Go Engineering Handbook — topic 29.*
