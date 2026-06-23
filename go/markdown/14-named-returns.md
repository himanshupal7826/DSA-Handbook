# 14 · Named Returns

> **In one line:** Named result parameters declare your return values up front as pre-zeroed local variables, enabling naked returns and giving `defer` a handle to inspect and mutate what you send back to the caller.

---

## 1. Overview

A Go function signature can name its result parameters, not just their types:

```go
func split(sum int) (x, y int) {
    x = sum * 4 / 9
    y = sum - x
    return
}
```

Here `x` and `y` are **named return values**. They are ordinary local variables, scoped to the function body, **initialized to their zero values** on entry, and whatever they hold when the function returns is what the caller receives. The bare `return` with no operands is a **naked return**: it returns the current values of the named results.

Named returns are a small syntactic feature with an outsized footprint on three things you actually care about in production Go: **documentation** (the signature now reads like a contract), **`defer` interaction** (deferred closures can read and modify the result *after* `return` executes), and **error-handling ergonomics** (the dominant real-world use). This chapter treats all three, with emphasis on the `defer` mechanics that trip up even experienced engineers.

Keywords this chapter weaves in: *named return, naked return, defer, result params, readability*.

## 2. Why It Exists

Three motivations drove this feature into the language (see the Go spec, "Function types" and "Return statements").

1. **Self-documenting signatures.** `func Read(p []byte) (n int, err error)` tells you the first int is a byte count and the second value is an error, directly in the signature and in the generated godoc. Compare `func Read([]byte) (int, error)` — correct but mute.

2. **`defer` needs a name to mutate the result.** A deferred function runs *after* the `return` statement sets the result values but *before* control returns to the caller. Without a name, the deferred closure has no variable to assign to. Named returns are the *only* mechanism by which `defer` can change what a function returns — this is the backbone of the `defer/recover` error-translation pattern.

3. **Fewer temporary variables for multi-value math/parsing.** When a function computes several outputs that mutually reference each other, naming them removes a layer of throwaway locals and lets a naked `return` close the function.

> [!NOTE]
> Named returns are *result params*, a parallel to named function parameters. The symmetry is intentional: both are pre-declared variables in the function's frame.

## 3. Internal Working

There is **no runtime magic and no performance penalty** to naming a result. Named and unnamed results compile to the same calling convention; the name is purely a source-level binding to a slot the compiler already had to allocate.

Mechanically, the Go ABI (register-based since Go 1.17, stack-based before) reserves storage for each result. When you name a result, the compiler binds that identifier to the **same slot** and emits an implicit zero-initialization at function entry — exactly as if you had written `var x, y int` on line one.

A `return expr1, expr2` statement compiles to: *assign each expression into the corresponding result slot, run all pending deferred calls, then jump to the epilogue*. A **naked `return`** simply skips the assignment step (the slots already hold the values you assigned by name) and goes straight to running defers.

The critical ordering — the one interviews probe — is this:

```text
  Caller frame
  ┌──────────────────────────────┐
  │ result slots: [ err ]        │ <-- written by `return`, then
  │                              │     readable/writable by defer,
  │                              │     then read by caller
  └──────────────────────────────┘
            ▲          │
            │ (2) defer│ closure captures &err
   ┌────────┴──────────▼─────────┐
   │ Callee: func f() (err error)│
   │  entry:  err = nil  (zeroed)│  (1)
   │  body:   err = doWork()     │  (3) return assigns slot
   │  defer:  if err != nil {...}│  (4) runs AFTER assign,
   │  epilogue: copy slot to       BEFORE caller resumes (5)
   │            caller             │
   └──────────────────────────────┘
```

Sequence on `return doWork()`:

1. Result slot `err` zero-initialized at entry.
2. `defer` registered; its closure closes over the *variable* `err` (the slot), not a snapshot.
3. `return` evaluates `doWork()` and writes the value into the `err` slot.
4. Deferred closures run; they see and may overwrite the `err` slot.
5. Function epilogue hands the (possibly mutated) slot to the caller.

Because the deferred closure captures the *address* of the result slot, a `return errors.New("x")` followed by a defer that sets `err = nil` will make the function return `nil`. That is the whole trick.

## 4. Syntax

```go
// Named results: parenthesized, with identifiers.
func f() (n int, err error) { /* n, err pre-zeroed */ return }

// Same type can be grouped.
func g() (x, y, z float64) { return }

// Naked return: returns current values of named results.
func h() (s string) { s = "hi"; return }

// Explicit return still works and may set the names.
func k() (n int) { return 42 } // assigns 42 to n, then returns

// Mixed is illegal — all results named or none:
// func bad() (n int, error) {} // compile error
```

Rules from the spec:

- Either **all** results are named or **none** are. You cannot mix `(n int, error)`.
- Named results are in scope for the entire function body.
- A naked `return` is only legal when results are named (or there are no results).
- `return e1, e2` with named results assigns to the slots first, then returns.

## 5. Common Interview Questions

**Q1. What does this print?**
```go
func f() (n int) {
    defer func() { n++ }()
    return 5
}
// fmt.Println(f())
```
*Answer:* `6`. `return 5` assigns `5` to `n`, then the deferred closure increments the `n` slot to `6` before the caller sees it.
*Follow-up:* What if the result were unnamed (`func f() int`)? Then the defer cannot touch the return value; it would print `5`.

**Q2. Can `defer` swallow or convert an error?**
*Answer:* Yes — only with a named `error` result. `defer func() { if r := recover(); r != nil { err = fmt.Errorf("recovered: %v", r) } }()` turns a panic into a returned error.
*Follow-up:* Does this work if you pass `err` as a parameter to the deferred function (`defer func(err error){...}(err)`)? No — that captures a *copy* at defer-registration time; assignment inside won't affect the result.

**Q3. Are named returns slower?**
*Answer:* No. They compile to the same slots as unnamed returns; the name is a source binding plus implicit zeroing you'd do anyway.
*Follow-up:* Do they affect escape analysis? Generally no — but capturing a named result in an escaping closure can force it (and what it points to) to the heap, same as any captured variable.

**Q4. When is a naked return a code smell?**
*Answer:* In long functions. The spec and `gofmt` allow it, but style guides discourage naked returns in functions longer than a few lines because the reader must scan the whole body to know what's returned.
*Follow-up:* Does `golangci-lint` flag it? Yes — the `nakedret` linter flags naked returns in functions exceeding a configurable line count (default ~30).

**Q5. What does this return?**
```go
func f() (err error) {
    defer func() { err = nil }()
    return errors.New("boom")
}
```
*Answer:* `nil`. The defer overwrites the slot after `return` set it. This is a classic *bug* — silently dropping errors.
*Follow-up:* How would you spot this in review? Look for `defer` closures that unconditionally assign to a named `error` result.

**Q6. Why must all results be named or none?**
*Answer:* Ambiguity — a mixed list like `(n int, error)` can't tell whether `error` is a name or a type. The spec forbids it to keep parsing unambiguous.
*Follow-up:* Can you name only some and use `_` for others? You can name with `_` (`(n int, _ error)`), but `_` results can't be set by name and don't help naked returns.

**Q7. Does a named result get the zero value or stay uninitialized?**
*Answer:* Always zero-valued on entry (`0`, `""`, `nil`, etc.), exactly like a `var` declaration.
*Follow-up:* So `func f() (err error) { return }` returns `nil`? Yes.

## 6. Production Use Cases

- **Standard library error/IO contracts.** `io.Reader`'s `Read(p []byte) (n int, err error)` and `database/sql`'s methods use named results for documentation clarity. The `n, err` convention is ubiquitous in `bufio`, `os`, `net`.
- **`defer`-based error wrapping.** Production codebases at Uber, Google, and most Go shops use `defer func() { err = wrap(err) }()` to attach context to *every* exit path of a function. The `github.com/pkg/errors` and modern `fmt.Errorf("...: %w", err)` patterns lean on a named `err`.
- **Transaction rollback.** `database/sql` and ORM wrappers (GORM, `sqlx`) wrap a unit of work: `defer func() { if err != nil { tx.Rollback() } else { err = tx.Commit() } }()`. The named `err` lets one defer decide commit vs. rollback for all paths.
- **`recover` boundaries.** HTTP middleware (e.g., `net/http` servers, gRPC interceptors) and worker pools convert panics into errors at goroutine boundaries via a named-result recover, so a panicking handler returns `500` instead of crashing the process.
- **Instrumentation/metrics.** `defer func() { metrics.Observe(name, err) }()` at the top of a method records latency and the final error for every return path — only feasible because `err` is named.

## 7. Common Mistakes

> [!WARNING]
> **Shadowing the named result.** Inside a block, `if x, err := g(); err != nil { ... }` declares a *new* `err` with `:=`. The outer named `err` is untouched, so a `defer` that wraps the named `err` sees the wrong value (often `nil`).

```go
func f() (err error) {
    if v, err := step(); err != nil { // NEW err shadows result!
        return err                    // returns inner err — OK here
    } else {
        use(v)
    }
    defer func() { err = wrap(err) }() // wraps OUTER err, may be nil
    return
}
```

Other frequent pitfalls:

- **Naked returns in long functions** — the reader can't see what's returned without scrolling. Restrict to tiny helpers.
- **Capturing a copy in the deferred call's args** (`defer log(err)`) when you meant the final value; use a closure `defer func(){ log(err) }()`.
- **Accidentally returning the zero value.** A bare `return` after an early-exit refactor may return zeroed results you forgot to set.
- **Defer overwriting an error to `nil`** unconditionally (see Q5) — silent data/error loss.

## 8. Performance Considerations

- **Zero cost for the naming itself.** Named vs. unnamed results produce identical machine code for the value-passing path. Don't avoid named returns for perf; don't add them expecting a win.
- **`defer` has the real cost, not the name.** Open-coded defers (Go 1.14+) make most single defers nearly free (~1ns), but a defer in a hot loop still allocates if it can't be open-coded (e.g., in a loop, or more than 8 defers in a function). The named result is incidental.
- **Escape analysis.** A named result captured by a closure that escapes (e.g., stored, or the closure is returned) can force the result to the heap. This is identical to capturing any local — naming didn't cause it, capturing did.
- **Large struct results.** Returning a big struct by value copies it into the result slot regardless of naming. Naming neither helps nor hurts; consider returning a pointer if the struct is large and the copy shows up in profiles.

> [!TIP]
> If `pprof` shows time in `runtime.deferproc`/`deferreturn`, the fix is the defer placement (hoist it out of a loop), not the named result.

## 9. Best Practices

| Practice | Rationale |
|---|---|
| Name results for **documentation** (`(n int, err error)`) | Signature + godoc read as a contract |
| Use named `err` when a `defer` must **wrap/rollback/recover** | Only named results are mutable by defer |
| Keep naked returns to **short** functions (< ~10 lines) | Readability; satisfies `nakedret` linter |
| Prefer explicit `return x, err` even with named results in long funcs | Reader sees the value at the return site |
| Avoid `:=` shadowing of named results | Prevents the silent "wrong err" bug |
| Don't name results just to save typing in long functions | The naked return cost to readability outweighs it |

The community split: Google's Go Style Guide says name results when it improves clarity but avoid gratuitous naked returns; Uber's style guide is stricter, reserving named returns mainly for the `defer`-modifies-result case and clarity of multiple same-typed returns.

## 10. Code Examples

Primary idiomatic pattern: **transaction wrapper** using a named `err` to choose commit vs. rollback on every exit path.

```go
func transfer(ctx context.Context, db *sql.DB, from, to string, amt int64) (err error) {
    tx, err := db.BeginTx(ctx, nil)
    if err != nil {
        return fmt.Errorf("begin tx: %w", err)
    }
    // Single defer decides the fate of the tx for ALL return paths below.
    defer func() {
        if p := recover(); p != nil {
            _ = tx.Rollback()
            panic(p) // re-panic after cleanup
        }
        if err != nil {
            _ = tx.Rollback()
            return
        }
        err = tx.Commit() // commit error becomes the function's error
    }()

    if _, err = tx.ExecContext(ctx, `UPDATE acct SET bal=bal-$1 WHERE id=$2`, amt, from); err != nil {
        return fmt.Errorf("debit: %w", err)
    }
    if _, err = tx.ExecContext(ctx, `UPDATE acct SET bal=bal+$1 WHERE id=$2`, amt, to); err != nil {
        return fmt.Errorf("credit: %w", err)
    }
    return // naked: err is nil here, so defer commits
}
```
```go
// Alternative: panic-to-error boundary (e.g., a parser or plugin host).
func safeRun(fn func()) (err error) {
    defer func() {
        if r := recover(); r != nil {
            // Convert the panic into a returned error via the named result.
            if e, ok := r.(error); ok {
                err = fmt.Errorf("panic: %w", e)
            } else {
                err = fmt.Errorf("panic: %v", r)
            }
        }
    }()
    fn() // if fn panics, the defer above catches it
    return
}
```

A short helper where a naked return is genuinely idiomatic (mutually-referencing math):

```go
func splitInTwo(sum int) (a, b int) {
    a = sum / 2
    b = sum - a
    return
}
```

## 11. Advanced Concepts

- **Defer sees mutations, not snapshots.** Because the deferred closure captures the result *variable*, late assignments are visible. This is what makes "wrap on the way out" work and what makes "accidentally nil the error" a bug — same mechanism, opposite outcomes.

- **Naked return + shadowing interaction.** A naked `return` returns the *current named-result slots*. If you've been assigning to a shadowed inner variable, the slots may still be zero. This is the deepest source of "why is my error nil?" confusion.

- **Multiple defers run LIFO.** With several defers all touching the named `err`, the last-registered runs first. Order your wrapping defers accordingly; a metrics defer registered first will observe the *final* error because it runs last.

```go
func op() (err error) {
    defer func() { metrics.Observe("op", err) }() // runs SECOND, sees wrapped err
    defer func() { err = wrap(err) }()            // runs FIRST, wraps
    return doWork()
}
```

- **Named results and `go vet`/`errcheck`.** Static tools track the named `err` to detect ignored errors. A named result can make some analyses cleaner because the data flow is explicit.

- **Generics.** Named results work with type parameters: `func first[T any](s []T) (v T, ok bool) { ... }`. The zero value of `v` is the zero of `T`, useful for "not found" returns without an explicit `var`.

## 12. Debugging Tips

- **"My error is unexpectedly nil/wrong."** Search the function for `:=` on a line that also mentions `err`. A shadowed `err` is the #1 cause. Replace with `=` where you intend to set the result.
- **"My defer didn't change the return."** Check (a) the result is *named*, and (b) you assigned via a closure `defer func(){ err = ... }()`, not `defer f(err)` which copies.
- **Use Delve.** Set a breakpoint on the closing `}` / `return` and inspect the named result slot before and after defers run: `dlv` shows the variable by name. Step over the defer to watch the slot mutate.
- **`go vet`** catches some lost-result and unreachable-return issues; **`golangci-lint`** with `nakedret`, `govet`, and `errcheck` enabled catches naked-return overuse and shadowing.
- **Print at the return boundary.** Temporarily add `defer func(){ log.Printf("ret err=%v", err) }()` (registered first so it runs last) to log the true final value.

## 13. Senior Engineer Notes

As a senior engineer, your judgment calls cluster around **review and clarity**:

- **Approve named results that document or enable defer; push back on cosmetic naming.** In review, a naked `return` in a 60-line function is a comment-worthy readability regression. Ask for explicit returns.
- **Hunt the shadowing bug in PRs.** Any function with a named `err` plus an `if x, err := ...` is a yellow flag. Verify the wrapping/rollback defer references the result, not a shadow.
- **Standardize the transaction/recover idiom.** Mentor the team on the *one* correct shape (commit/rollback driven by named `err`) so it's copy-pasteable and not reinvented (and mis-implemented) per service.
- **Teach the ordering mental model** — "return assigns the slot, then defers run, then the caller sees it." Most named-return bugs dissolve once a junior internalizes this.
- **Be consistent within a package.** Mixed conventions (some funcs named, some not, for no reason) increase cognitive load more than either choice alone.

## 14. Staff Engineer Notes

At staff level the concern shifts from one function to **org-wide consistency and tooling**:

- **Codify the convention in a lint gate, not a wiki.** Enable `nakedret`, `errcheck`, and shadow checks in the shared `golangci-lint` config so the rule is enforced in CI across every repo — humans won't catch shadowing at scale.
- **Build-vs-buy for error context.** Decide org-wide whether error wrapping happens via per-function `defer func(){ err = ... }()`, a helper like `errors.Wrapf`, or middleware. The named-result defer pattern is cheap and stdlib-only; a wrapping library adds dependency and call-site noise. For most orgs, stdlib `%w` plus a thin defer convention wins.
- **Panic boundaries are an architectural decision.** Where do you convert panics to errors — every public method, or only at goroutine/RPC boundaries? Over-using recover hides bugs; under-using it crashes processes. Standardize the boundary (typically: server middleware and worker-pool launchers) and document it; the named-result recover is the implementation detail beneath that policy.
- **Observability hooks.** A uniform `defer func(){ metrics.Observe(op, err) }()` convention, enabled by named results, gives every service consistent per-operation latency+error metrics. Promote this as a platform pattern (or a generated wrapper) rather than hand-rolling per team.
- **Cross-team API contracts.** Encourage named results in *exported* signatures of shared libraries — they become part of the godoc contract other teams read. Internal hot-path code can stay unnamed.

## 15. Revision Summary

- **Named results** = pre-zeroed local variables bound to the function's result slots; all-or-none naming.
- **Naked return** returns the current values of the named results; legal only with named (or zero) results.
- **No performance cost** to naming — same ABI slots as unnamed; the cost (if any) belongs to `defer`.
- **`defer` can read AND mutate** a named result because it captures the *variable* (slot), and runs *after* `return` assigns it but *before* the caller resumes.
- **Killer use cases:** error wrapping, tx commit/rollback, panic→error via `recover`, per-op metrics.
- **Top bugs:** `:=` shadowing the named result; defer arg copies (`defer f(err)`); unconditional `err = nil` in defer; naked returns in long functions.
- **Tooling:** `nakedret`, `errcheck`, `go vet` shadow checks; Delve to watch the slot mutate.
- **Style:** name for documentation and defer-driven logic; keep naked returns to short functions; prefer explicit returns in long ones.

**References:** The Go Programming Language Specification — *Function types*, *Return statements*, *Defer statements*; Effective Go; Google Go Style Guide; Uber Go Style Guide; `golangci-lint` (`nakedret`, `errcheck`).

---

*Go Engineering Handbook — topic 14.*
