# 28 · Panic and Recover

> **In one line:** `panic` unwinds the stack running deferred functions, `recover` stops that unwind inside a `defer`, and neither is a substitute for ordinary error handling.

---

## 1. Overview

Go deliberately has no exceptions. Errors are values, returned explicitly and checked by the caller. But Go *does* have a mechanism for truly exceptional, unrecoverable-in-the-normal-flow situations: `panic` and `recover`.

A `panic` is a controlled crash. It immediately stops the normal execution of the current function, begins **unwinding the stack**, and runs every `defer` registered along the way. If nothing intervenes, the panic reaches the top of the goroutine, the runtime prints the panic value and a stack trace, and the *entire process* exits with status 2.

`recover` is the one tool that can intervene. Called from inside a deferred function, it stops the unwind, captures the panic value, and lets the surrounding function return normally. Outside of a deferred function, `recover` does nothing and returns `nil`.

The mental model that keeps you out of trouble:

- **`error`** — expected, recoverable conditions (file missing, bad input, timeout). The 99% case.
- **`panic`** — programmer bugs and invariant violations (nil map write, index out of range, "this should never happen").
- **`recover`** — a *boundary guard*, not an error handler. Used to convert a panic in a sub-system into an error at a well-defined edge (one request, one job, one plugin) so the rest of the process keeps running.

> [!NOTE]
> If you find yourself using panic/recover to control normal flow, you are writing exceptions in a language that chose not to have them. Stop and return an `error`.

---

## 2. Why It Exists

Two distinct needs justify panic/recover:

**1. The runtime needs a way to report fatal bugs.** When you index a slice out of bounds, dereference a nil pointer, divide by zero, or write to a nil map, there is no sensible `error` to return — the program is in an undefined state. The runtime panics. This is *not* optional; it is how Go signals that an invariant the type system couldn't enforce has been broken.

**2. Library authors occasionally need a long jump.** Some algorithms are dramatically simpler if a deeply nested helper can abort all the way to the top without threading an `error` through twenty call frames. The canonical example is a recursive descent parser: `encoding/json`, `text/template`, and `database/sql` drivers all use panic internally for parse/scan failures, then `recover` at the public API boundary and return a clean `error`. The user never sees a panic — it is an *implementation detail confined to one package*.

So the design intent is narrow: panic is for "I cannot continue," and recover exists so a server doesn't die because one request handler hit a bug. The Go blog's classic article *Defer, Panic, and Recover* frames it exactly this way — recover is meant to "stop the panicking sequence" and is most useful at package boundaries.

---

## 3. Internal Working

Understanding the runtime mechanics removes all the mystery. The relevant structures live in the runtime: each goroutine (`g`) holds two linked lists — one of deferred calls (`_defer`) and one of active panics (`_panic`).

```text
goroutine g
 ┌───────────────────────────────────────────────┐
 │ g._defer  ──▶ _defer ──▶ _defer ──▶ nil        │  (LIFO stack of defers)
 │ g._panic  ──▶ _panic ──▶ nil                   │  (active panic chain)
 └───────────────────────────────────────────────┘

 _defer { started bool; sp uintptr; pc uintptr; fn func(); link *_defer }
 _panic { arg any; link *_panic; recovered bool; aborted bool; ... }
```

When you call `panic(v)`:

1. The runtime allocates a `_panic` record holding `v` and pushes it onto `g._panic`.
2. It walks `g._defer` from the top (most recent first), marking each `_defer.started = true` and invoking its function. This is the **stack unwind**: frames are abandoned in LIFO order, running their deferred calls as they go.
3. Inside one of those deferred functions, code may call `recover`. `recover` checks: am I being called directly from a deferred function that is running *because of* the current panic? If yes, it sets `_panic.recovered = true` and returns the panic argument `v`.
4. After that deferred function returns, the runtime sees `recovered == true`. It pops the `_panic`, and instead of continuing the unwind, it makes the **deferring function** return normally (using the saved `sp`/`pc` to resume just after the deferred call site). Execution continues in that function's caller as if nothing happened.
5. If no `recover` is found, the unwind reaches `runtime.goexit` at the base of the goroutine. The runtime calls `fatalpanic`, prints the value and traceback, and terminates the **whole process**.

Two consequences fall directly out of this design:

- **`recover` only works one level deep, inside a `defer`.** `func() { recover() }` called normally returns `nil`, because there is no active panic associated with a deferred frame. Even `defer func() { helper() }()` where `helper` calls `recover` returns `nil` — `recover` must be called *directly* by the deferred function (the runtime checks the call depth).
- **A panic crosses a goroutine boundary as a crash, never as a value.** Each `g` has its own `_panic`/`_defer` chains. A `recover` in goroutine A cannot catch a `panic` in goroutine B. An unrecovered panic in *any* goroutine takes down the entire process — there is no parent goroutine to catch it.

Modern Go (1.13+) optimized the common case with **open-coded defers**: when the number of defers in a function is small and statically known, the compiler inlines them as direct calls guarded by a bitmask, skipping the `_defer` heap allocation entirely. The linked-list machinery above is the fallback for defers inside loops or behind conditionals.

---

## 4. Syntax

```go
// Trigger a panic.
panic("invariant violated")
panic(fmt.Errorf("bad state: %w", err)) // panic value can be any type

// Recover — ONLY meaningful inside a deferred function.
func safe() (err error) {
    defer func() {
        if r := recover(); r != nil {
            // r is the value passed to panic(); type is `any`.
            err = fmt.Errorf("recovered: %v", r)
        }
    }()
    risky()
    return nil
}
```

Key rules: `panic` accepts any value (`any`), conventionally an `error` or string. `recover` takes no arguments and returns `any` — `nil` when there is no panic in progress. Named return values (`err error` above) are how you propagate the recovered state out: you can only mutate the function's return inside the deferred closure.

---

## 5. Common Interview Questions

**Q1. What happens, step by step, when `panic` is called?**
Model answer: The current function stops, the runtime begins unwinding the stack running every deferred function in LIFO order. If a deferred function calls `recover`, the unwind stops and the deferring function returns normally. Otherwise the panic propagates to the top of the goroutine and crashes the whole process with exit code 2.
*Follow-up: Does it crash the goroutine or the process?* The process — an unrecovered panic in any goroutine is fatal program-wide.

**Q2. Can you recover from a panic in a different goroutine?**
No. `recover` only catches panics on its own goroutine's stack. Each goroutine must defer/recover for itself. This is the #1 cause of "but I had a recover!" production crashes — the panic happened in a `go func()` that had no recover.
*Follow-up: How do you protect spawned goroutines?* Wrap their body in a deferred recover, ideally via a `go func(){ defer recoverer(); work() }()` helper.

**Q3. Why does `recover` return `nil` here?**
```go
func f() {
    if r := recover(); r != nil { /* never runs */ }
    panic("boom")
}
```
Because `recover` is not called from within a deferred function during an active panic. It must be invoked inside a `defer`.
*Follow-up: What if I wrap recover in a helper called by the defer?* Still `nil` — `recover` must be called *directly* by the deferred function, not by a function it calls.

**Q4. Does `defer` run if the function panics?**
Yes. That is the whole point — deferred functions run during stack unwinding, which is exactly how cleanup (closing files, unlocking mutexes) survives a panic. This is why `defer mu.Unlock()` is safe even if the critical section panics.
*Follow-up: What about `os.Exit`?* No — `os.Exit` and a fatal runtime crash (e.g. concurrent map writes) bypass deferred functions entirely.

**Q5. When is panic the *right* choice over returning an error?**
For programmer errors and unrecoverable invariant violations — `nil` map writes, impossible switch cases, package init failures. Also acceptable inside a single package as a long-jump that is recovered at the public boundary (like `encoding/json`). Never for expected conditions a caller might reasonably handle.
*Follow-up: Give an example from the standard library.* `regexp.MustCompile` panics on a bad pattern because patterns are compile-time constants; the non-`Must` `regexp.Compile` returns an error for runtime input.

**Q6. What is the difference between `panic` and `log.Fatal`/`os.Exit`?**
`panic` unwinds the stack and runs defers; it is recoverable. `log.Fatal` calls `os.Exit(1)` which terminates *immediately*, skipping all deferred functions and giving no chance to recover or clean up.
*Follow-up: Which should a library use?* Neither `os.Exit` nor `log.Fatal` — libraries should return errors. Only `main` and tightly-scoped tooling should exit.

**Q7. Can you re-panic after recovering?**
Yes. A common pattern is to recover, inspect the value, handle known cases, and `panic(r)` again to re-raise anything you didn't expect — preserving the original for the real crash handler.
*Follow-up: Does the stack trace stay intact?* Re-panicking with the same value preserves the value but the trace now points at the re-panic site; log the original `debug.Stack()` first if you need the true origin.

---

## 6. Production Use Cases

- **HTTP server middleware.** Every serious Go web stack wraps handlers in a recovery middleware so one buggy handler returns a 500 instead of killing the server. `net/http`'s own `Server` recovers per-connection (logging the trace and closing the conn). Frameworks like **Gin** (`gin.Recovery()`), **Echo** (`middleware.Recover()`), and **gRPC** (`grpc_recovery` interceptor from `go-grpc-middleware`) ship this as standard.
- **Worker pools / job runners.** Systems like **Temporal**, **Asynq**, and **Machinery** recover around each task so one poisoned job doesn't take down the worker, then mark the job failed and move on.
- **Parser/serializer boundaries.** `encoding/json`, `text/template`, `html/template`, and the `database/sql` scan path use internal panic-as-longjump, recovered at the API edge.
- **Plugin / user-code sandboxes.** Anything running untrusted or third-party Go (extension hooks, expression evaluators like CEL wrappers, scripting bridges) recovers at the call site.
- **`testing` framework.** A panic in a test is caught by the runner and reported as a failed test, not a crashed test binary.

---

## 7. Common Mistakes

> [!WARNING]
> The most expensive bug: assuming a top-level recover protects goroutines. It does not. Each `go func()` needs its own defer/recover or an unhandled panic there kills the entire process.

- **Recover in the wrong place.** Calling `recover()` outside a `defer`, or in a helper called by the defer — returns `nil`, panic still propagates.
- **Swallowing panics silently.** `defer func(){ recover() }()` with an empty body hides real bugs. At minimum log the value and a stack trace.
- **Using panic for control flow.** Panicking to break out of nested loops or to return early is an anti-pattern that hides intent and wrecks performance and readability.
- **Leaking a held lock by recovering wrong.** Recover should sit at the boundary, not interleaved with locking; recovering into a function whose mutex state is inconsistent can deadlock.
- **Re-using a recovered server in a bad state.** Recovering keeps the process alive but the in-flight operation may have left shared state half-mutated. Recover should isolate a *request*, and request-scoped state should be discarded.

---

## 8. Performance Considerations

- **`defer` is cheap now.** Pre-Go 1.13, each defer cost ~50ns (heap alloc + linked-list push). Open-coded defers (1.14+) brought the common case down to near the cost of a direct call — roughly single-digit nanoseconds. There is no longer a meaningful reason to avoid `defer mu.Unlock()` for performance in normal code.
- **`panic`/`recover` are *not* cheap.** A panic allocates a `_panic` record, walks the full defer chain, and gathers stack-trace metadata. It is orders of magnitude slower than a function return — think microseconds, not nanoseconds. This is by design: panics are exceptional.
- **The "panic as control flow" trap.** Some libraries used panic for early-exit in hot paths and measured 10–100× slowdowns under load versus error returns. The deep recursive parsers that use panic do so because the *error path is rare*; on the happy path no panic occurs.
- **Defers in loops** that fall back to the heap-allocated form (e.g. `for { defer ... }`) can allocate per iteration and pile up until function return — a classic memory/latency footgun. Move the deferred work into a closure called each iteration instead.

---

## 9. Best Practices

> [!TIP]
> One recover per boundary. Define exactly where panics become errors — the HTTP handler edge, the job runner, the goroutine wrapper — and nowhere else.

- Prefer returning `error`. Reach for panic only for programmer bugs and invariants.
- Recover at boundaries, log the value **and** the stack (`debug.Stack()`), then translate to a clean error or 500.
- Always wrap goroutine bodies that run application logic in a recover helper.
- Use the `MustXxx` convention for panic-on-bad-input functions intended for package-level/init use (`template.Must`, `regexp.MustCompile`).
- Make panic values informative — panic with an `error`, not a bare string, so recovery code can type-switch.
- After recovering, decide deliberately: handle, re-panic, or fail the unit of work. Never silently continue.
- Don't recover in libraries except to convert internal long-jumps to errors at your public API; never swallow a caller's panic.

---

## 10. Code Examples

Primary idiomatic example — an HTTP recovery middleware that converts panics into 500s without crashing the server. Below it, an alternative goroutine-safe wrapper is shown as a switchable tab.

```go
package main

import (
	"log/slog"
	"net/http"
	"runtime/debug"
)

// Recover wraps a handler so a panic becomes a 500 + log, not a crash.
func Recover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				slog.Error("panic in handler",
					"err", rec,
					"path", r.URL.Path,
					"stack", string(debug.Stack()),
				)
				http.Error(w, "internal server error", http.StatusInternalServerError)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func buggy(w http.ResponseWriter, r *http.Request) {
	var m map[string]int
	m["x"] = 1 // panic: assignment to entry in nil map
	_ = w
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/boom", buggy)
	http.ListenAndServe(":8080", Recover(mux))
}
```

```go
package safego

import (
	"log/slog"
	"runtime/debug"
)

// Go runs fn in a goroutine that can never crash the process.
// onErr (optional) receives the recovered panic value.
func Go(fn func(), onErr func(any)) {
	go func() {
		defer func() {
			if rec := recover(); rec != nil {
				slog.Error("goroutine panic", "err", rec, "stack", string(debug.Stack()))
				if onErr != nil {
					onErr(rec)
				}
			}
		}()
		fn()
	}()
}
```

A second, standalone example: converting an internal panic to an error at a package boundary (the `encoding/json` pattern). The prose between the blocks keeps this from being grouped with the tabs above.

```go
// parse runs a recursive descent that panics on malformed input,
// but the public Parse never panics — it returns an error.
type parseError struct{ msg string }

func Parse(b []byte) (ast *Node, err error) {
	defer func() {
		if r := recover(); r != nil {
			if pe, ok := r.(parseError); ok {
				err = errors.New(pe.msg) // expected internal long-jump
				return
			}
			panic(r) // unexpected: re-panic, it's a real bug
		}
	}()
	return parseValue(b), nil // parseValue may panic(parseError{...})
}
```

---

## 11. Advanced Concepts

- **Typed re-panic for selective recovery.** Recover everything, type-switch on the value, handle your sentinel types, and `panic(r)` the rest. This keeps your boundary from swallowing genuine bugs (nil derefs) while catching your own deliberate long-jumps.
- **`recover()` and named returns are the only way to "return from a defer."** You cannot change a function's return value from a defer unless the returns are named. This is the mechanism behind error-translation patterns.
- **Fatal panics that bypass recover.** Some runtime errors are *non-recoverable* even with a perfect recover: concurrent map read/write detection, stack overflow, out-of-memory, and deadlock detection call `fatalthrow` and exit unconditionally. Recover cannot catch these — they indicate the runtime itself can't safely continue.
- **`panic(nil)` semantics.** Historically `panic(nil)` made `recover()` return `nil`, indistinguishable from "no panic." Go 1.21 changed this: `panic(nil)` now yields a `*runtime.PanicNilError` to `recover`, closing a long-standing footgun (gated by `GODEBUG=panicnil=1` for compatibility).
- **`errors.Join` and recover.** When recovering at a boundary that may itself defer cleanup that errors, combine with `errors.Join` so neither the panic-derived error nor the cleanup error is lost.
- **`runtime.Goexit`** terminates a goroutine running all defers but is *not* a panic — `recover` returns `nil` during a Goexit unwind. Used by `testing` (`t.FailNow`/`t.Fatal`) under the hood.

---

## 12. Debugging Tips

- **Read the trace top-down.** The first goroutine in a panic dump is the one that panicked; the line directly under `panic(...)` is your culprit frame. Subsequent goroutines are just context.
- **`GOTRACEBACK`.** `GOTRACEBACK=all` shows all goroutines; `GOTRACEBACK=system` and `=crash` add runtime frames and dump core respectively. Set it in production for richer crash dumps.
- **Capture `debug.Stack()` at recover time.** Logging `string(debug.Stack())` inside the deferred recover gives you the unwound stack including the original panic location — do it immediately in the defer.
- **`exit status 2`** in CI/process supervisors almost always means an unrecovered panic — grep logs for `panic:` and `goroutine`.
- **Reproduce nil-map / index panics** with `-race` builds; many production panics are concurrency bugs that the race detector surfaces deterministically.
- **Don't recover while debugging.** Temporarily removing a too-broad recover often reveals the real panic the boundary was hiding.

---

## 13. Senior Engineer Notes

As a senior engineer your job is to make panic/recover *invisible and consistent* in the codebase. In code review, three reflexes:

1. **Every `go` statement gets scrutiny.** If the goroutine runs anything beyond trivial, fully-controlled code, it needs a recover wrapper. A single unguarded `go func()` is a latent production outage. Mandate a shared `safego.Go` helper and lint for raw `go` in handlers/jobs.
2. **Recover only at boundaries.** Reject PRs that sprinkle recover inside business logic to "be safe." That hides bugs and makes failures non-deterministic. Recover belongs in middleware, the job runner, and the goroutine helper — period.
3. **Panics must carry context and be logged with a stack.** A recover that does `http.Error(w, "error", 500)` with no log is a debugging black hole. Require `debug.Stack()` + structured logging at every boundary.

Mentoring framing: teach juniors the dichotomy — *errors are values you reason about; panics are bugs you fix*. The smell to flag is panic used as `try/catch`. Design judgement: choosing `MustXxx` vs returning errors is about *who provides the input* — constants/config-at-init can panic; runtime/user input must not.

---

## 14. Staff Engineer Notes

At staff level the questions move from "is this recover correct" to "what is our org-wide failure-isolation contract." Concerns:

- **Define the blast radius policy.** What is the unit of isolation — request, RPC, job, partition, tenant? A panic should fail exactly that unit and no more. This is an architectural decision that shapes how every service is built. Encode it in shared platform middleware so 200 microservices behave identically, rather than each team reinventing (and getting wrong) recovery.
- **Build-vs-buy on resilience.** Don't have each team hand-roll recovery interceptors. Provide them in the company's internal framework alongside metrics (`panic_total` counter), tracing (attach the panic to the span), and alerting. One vetted implementation beats N subtly-broken ones.
- **Process-crash-as-strategy.** Sometimes the *right* org answer is to *let it crash* — for stateless services behind a supervisor (Kubernetes, systemd), a panic-and-restart can be cleaner and safer than recovering into unknown state. Erlang-style "let it crash" is a legitimate cross-team posture. The trade-off: restart latency and thundering-herd vs. the risk of serving corrupted state. Staff engineers decide this per service tier and document it.
- **Observability contract.** Mandate that recovered panics emit a metric and a high-cardinality-safe log so SREs can dashboard panic rates and catch regressions before they page. A spike in recovered panics is a leading indicator of a bad deploy.
- **Cross-language consistency.** In a polyglot org, align Go's panic/recover boundaries with how Java/Python services handle uncaught exceptions, so a single incident runbook works everywhere.

---

## 15. Revision Summary

- `panic` unwinds the stack running all `defer`s in LIFO order; if unrecovered, the **whole process** crashes (exit 2).
- `recover` works **only** when called *directly* inside a deferred function during an active panic; otherwise returns `nil`.
- `recover` is **per-goroutine** — it cannot catch a panic in another goroutine. Wrap every `go func()` that runs real logic.
- Use `error` for expected conditions; reserve `panic` for programmer bugs/invariants and internal long-jumps recovered at a package boundary.
- Mechanics: runtime keeps `_defer` and `_panic` linked lists on each `g`; open-coded defers make the happy path nearly free; panic itself is microsecond-scale and slow.
- Best practice: recover **at boundaries** (HTTP middleware, job runner, goroutine wrapper), log value + `debug.Stack()`, translate to error or 500, re-panic unexpected types.
- Fatal/un-recoverable: `os.Exit`, `log.Fatal`, concurrent map writes, OOM, stack overflow — these bypass recover. `panic(nil)` yields `*runtime.PanicNilError` since Go 1.21.
- Staff lens: define org-wide blast-radius/isolation policy, provide one vetted recovery middleware, and consciously choose recover vs. "let it crash + restart."

**References:** Go blog — *Defer, Panic, and Recover*; Go spec (Handling panics); `runtime` package (`_panic`, `_defer`, `PanicNilError`); Go 1.13/1.14 open-coded defer release notes; `go-grpc-middleware` recovery interceptor; Gin/Echo recovery middleware.

---

*Go Engineering Handbook — topic 28.*
