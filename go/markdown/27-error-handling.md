# 27 · Error Handling

> **In one line:** In Go, errors are ordinary values you create, wrap with `%w`, and inspect with `errors.Is`/`errors.As` — not exceptions you throw and catch.

---

## 1. Overview

Go has no exceptions, no `try`/`catch`, and no stack unwinding for ordinary failures. Instead it embraces a deceptively simple idea: **errors are values**. A function that can fail returns an `error` as its last return value, and the caller is expected to inspect it explicitly:

```go
f, err := os.Open("config.yaml")
if err != nil {
    return fmt.Errorf("loading config: %w", err)
}
defer f.Close()
```

The `error` type is a one-method interface:

```go
type error interface {
    Error() string
}
```

That is the entire contract. Everything else — sentinel errors, error wrapping with `%w`, `errors.Is`, `errors.As`, `errors.Join` — is built on top of this interface plus a couple of optional, conventional interfaces (`Unwrap() error`). This chapter covers how that machinery actually works at runtime, how to use it in production, and the judgement calls senior and staff engineers make around error design.

`panic`/`recover` exist too, but they are *not* the error-handling mechanism — they are for truly unrecoverable programmer bugs and a narrow set of control-flow cases. We cover the boundary in section 11.

## 2. Why It Exists

Exceptions decouple the point of failure from the point of handling. That sounds convenient until you maintain a large system: any line can throw, control flow becomes invisible, and you discover handling gaps only in production. Go's designers, scarred by C++ and Java codebases, chose explicitness over convenience.

The trade-offs Go deliberately made:

| Concern | Exceptions | Go errors as values |
|---|---|---|
| Control flow | Hidden (invisible `throw`) | Explicit (`if err != nil`) |
| Performance | Costly unwind on throw | Cheap interface return |
| Forgetting to handle | Silent propagation | Visible, often vet-caught |
| Composition | Try/catch nesting | Wrap chain via `%w` |
| Verbosity | Low | High (the famous complaint) |

The verbosity is real and intentional: Go trades keystrokes for the guarantee that *every failure point is visible at the call site*. The `%w` verb (Go 1.13, 2019) and `errors.Is`/`errors.As` were added precisely because the original "errors are just strings" approach made it impossible to reliably *programmatically* distinguish error kinds without fragile `strings.Contains` checks. Wrapping gave errors structure while preserving the value-based model. See the Go blog post *"Working with Errors in Go 1.13"* and the earlier *"Error handling and Go."*

## 3. Internal Working

An `error` is an **interface value**. At runtime a non-nil interface value is a two-word struct: a pointer to an *itab* (interface table) and a pointer to the underlying data.

```text
 error interface value (2 words on the stack/heap)
 +------------------+------------------+
 |     *itab        |     data ptr     |
 +------------------+------------------+
        |                    |
        v                    v
  +-------------+      +------------------------+
  | _type *T    |      | concrete value, e.g.   |
  | interface   |      | *fs.PathError{...}     |
  | method set  |      |  Op, Path, Err         |
  | Error() fn  |      +------------------------+
  +-------------+
```

The `itab` caches the concrete type's `Error()` method pointer, so calling `err.Error()` is a single indirect call — no reflection, no allocation.

**The `nil` gotcha lives here.** An interface is `nil` only when *both* words are zero. If you return a `(*MyError)(nil)` typed pointer stored in an `error` interface, the itab word is non-nil (it points to `*MyError`'s itab), so `err != nil` is **true** even though the underlying pointer is nil. This is the single most common Go error bug.

**Wrapping.** `fmt.Errorf("...: %w", err)` returns a `*fmt.wrapError`:

```text
wrapError{ msg: "loading config: open foo: no such file",
           err: <the wrapped error> }   // implements Unwrap() error
```

`errors.Is(err, target)` walks the chain by repeatedly calling `Unwrap()` (or `Unwrap() []error` for `errors.Join`), comparing each node to `target` with `==`, and also calling a custom `Is(target) bool` method if the node implements one. `errors.As(err, &target)` walks the same chain but uses type assertion / `As(any) bool` to find the first node assignable to `*target`.

`errors.Join(e1, e2)` (Go 1.20) returns a `*joinError` holding a `[]error`; its `Unwrap() []error` lets `Is`/`As` traverse a tree, not just a list. The traversal is depth-first.

## 4. Syntax

```go
import (
    "errors"
    "fmt"
)

// Sentinel error: a package-level value compared by identity.
var ErrNotFound = errors.New("not found")

// Creating errors.
e1 := errors.New("plain error")
e2 := fmt.Errorf("formatted: %d", 42)         // no wrap
e3 := fmt.Errorf("ctx: %w", ErrNotFound)      // wraps, chain preserved
e4 := fmt.Errorf("a:%w and b:%w", err1, err2) // multi-wrap (Go 1.20+)
e5 := errors.Join(err1, err2, nil)            // nil entries dropped

// Inspecting.
if errors.Is(e3, ErrNotFound) { /* matches sentinel anywhere in chain */ }

var perr *fs.PathError
if errors.As(err, &perr) {                    // extract a concrete/typed error
    log.Printf("op=%s path=%s", perr.Op, perr.Path)
}

// Custom error type.
type ValidationError struct{ Field, Msg string }
func (e *ValidationError) Error() string {
    return fmt.Sprintf("%s: %s", e.Field, e.Msg)
}
```

> [!NOTE]
> Use `%w` only when you intend callers to unwrap. Use `%v` to *flatten* an error into a message when you deliberately want to hide the underlying type (an abstraction boundary).

## 5. Common Interview Questions

**Q1. Why does `err != nil` return true when I returned a nil `*MyError`?**
Because `error` is an interface. The interface stores a type pointer plus a data pointer; assigning a typed nil pointer leaves the type pointer set, so the interface is non-nil. *Fix:* declare the return as `error` and `return nil` literally, not a typed nil variable.
*Follow-up: How would you catch this?* `go vet` has limited detection; the robust fix is to never store a typed nil into an error return — return the interface `nil` directly.

**Q2. Difference between `errors.Is` and `errors.As`?**
`Is` answers "is this *equal to* (or does it match) a specific sentinel value anywhere in the chain?" — used for sentinels like `io.EOF`. `As` answers "is there a value of *this concrete type* in the chain, and if so bind it?" — used to extract structured fields.
*Follow-up: Which for `io.EOF`?* `errors.Is(err, io.EOF)`.

**Q3. When do you wrap with `%w` vs `%v`?**
`%w` when the caller may legitimately need to inspect the cause programmatically; `%v` when you want to break the chain and present an opaque error across an API boundary so callers don't couple to your internals.
*Follow-up: Why is exposing the chain a coupling risk?* Callers may write `errors.Is` checks against internal sentinels, turning an implementation detail into a de-facto API contract.

**Q4. Are sentinel errors a good idea?**
They're fine for a small, stable set of well-known conditions (`sql.ErrNoRows`, `io.EOF`). They become coupling and a versioning hazard when overused; prefer typed errors when callers need data, or behavioral interfaces (`Temporary()`/`Timeout()`).
*Follow-up: What replaced `net.Error.Temporary()`?* It's deprecated; prefer `Timeout()` and context-based cancellation checks.

**Q5. How does `errors.Is` traverse joined errors?**
`errors.Join` produces a node whose `Unwrap() []error` returns multiple children; `Is`/`As` do a depth-first walk over the tree, checking each node.
*Follow-up: Order guarantee?* Depth-first, in slice order; don't rely on it for "first match wins" semantics across unrelated errors.

**Q6. Is returning `error` allocating?**
Creating a new error value usually allocates (the struct escapes to the heap via the interface). Package-level sentinels allocate **once** at init. Hot paths that return the same sentinel allocate nothing per call.
*Follow-up: How to avoid allocs in hot loops?* Reuse sentinels; avoid `fmt.Errorf` in the hot path; consider returning a bool/typed result when "error" is an expected, frequent outcome.

**Q7. panic vs error — when each?**
`error` for expected, recoverable failures (I/O, validation, not-found). `panic` for programmer bugs / impossible states (nil map write, invariant violation) and a few intentional cases (e.g., `MustCompile` in package init).
*Follow-up: Should a library panic?* Almost never across its public API for runtime conditions; only for `Must*` constructors meant for init-time use.

## 6. Production Use Cases

- **Database layers.** `database/sql` returns `sql.ErrNoRows`; idiomatic data-access code does `if errors.Is(err, sql.ErrNoRows) { return ErrUserNotFound }`, translating an infra sentinel into a domain sentinel at the repository boundary. GORM, `pgx`, and sqlc-generated code all follow this.
- **gRPC / Kubernetes.** gRPC encodes errors as `status.Status` with codes; `k8s.io/apimachinery/pkg/api/errors` exposes `errors.IsNotFound(err)`, `IsConflict(err)` helpers — classic typed/behavioral inspection at scale. Controllers retry on conflict by inspecting error kind.
- **HTTP services.** Mapping internal errors to status codes via `errors.As` to a typed `*APIError{Code, HTTPStatus}` is a near-universal pattern (used in Stripe-style API servers, Mattermost, etc.).
- **`github.com/pkg/errors` (legacy) and `cockroachdb/errors`.** CockroachDB's errors package adds stack traces, redaction, and gRPC-safe wire encoding on top of the stdlib model — a real-world example of extending errors-as-values for a distributed database.
- **Retry / circuit-breaker libraries.** They inspect errors for `Temporary()`/`Timeout()` or specific sentinels to decide retryability (e.g., AWS SDK's retryer, `cenkalti/backoff`).

## 7. Common Mistakes

> [!WARNING]
> These are the recurring bugs that show up in code review and production incidents.

- **Typed-nil interface** (section 3): returning `(*T)(nil)` as `error`.
- **`==` comparison after wrapping.** `err == sql.ErrNoRows` fails once anyone wraps it. Always use `errors.Is`.
- **`%v` when you meant `%w`** — silently breaks the chain so downstream `errors.Is` checks stop matching. A nasty, invisible regression.
- **Double logging.** Logging an error *and* returning it, at every layer, producing 5 copies of one failure in the logs. Log once, at the top boundary, or wrap-and-return.
- **Swallowing context.** `return err` instead of `fmt.Errorf("fetching user %d: %w", id, err)` — losing the breadcrumb of *where* it happened.
- **Over-sentineling.** Dozens of exported sentinels create an accidental API surface.
- **Re-wrapping with `%v`** loses the typed info downstream code needs.
- **Comparing error strings** (`strings.Contains(err.Error(), "not found")`) — brittle and locale/format dependent.

## 8. Performance Considerations

- **Returning an error is cheap on the happy path**: `nil` is two zero words; the `if err != nil` branch is well-predicted.
- **Creating an error is the cost.** `errors.New`/`fmt.Errorf` allocate. `fmt.Errorf` also runs the formatter (parsing the verb string), making it ~5–10× more expensive than `errors.New`. Benchmark numbers vary, but `fmt.Errorf` is on the order of hundreds of ns + an alloc; a returned sentinel is ~0 ns, 0 allocs.
- **Hot paths:** prefer pre-allocated sentinels; don't `fmt.Errorf` per request when the error is frequent and expected.
- **Stack traces are expensive.** `runtime.Callers` (used by `pkg/errors`/`cockroachdb/errors`) costs microseconds and allocates. Capture stacks only at error *creation* boundaries, never per wrap layer.
- **`errors.Is/As` cost** is O(depth of chain) with a few comparisons/type assertions per node — negligible unless your chain is pathologically deep.

> [!TIP]
> If you find error creation in a CPU profile, you usually have a control-flow-as-errors smell: an "expected" outcome is being modeled as an error in a tight loop.

## 9. Best Practices

- **Wrap with context at each boundary you cross**, with a verb-phrase prefix and `%w`: `fmt.Errorf("query users: %w", err)`. Read top-to-bottom the chain tells a story.
- **Don't capitalize or punctuate** error strings (`go vet` enforces this) — they get concatenated.
- **Add context, not the word "error"**: avoid `failed to`/`error while` noise; just say what you were doing.
- **Decide your unwrap contract per API.** Public packages: document which sentinels/types are part of the contract. Hide everything else with `%v`.
- **Translate at boundaries.** Convert infra errors (`sql.ErrNoRows`) into domain errors at the repository edge so upper layers don't depend on the driver.
- **Handle errors once.** Either log-and-stop or wrap-and-return — not both.
- **Prefer `errors.Is`/`As` over `==`/type-switch** for anything that may be wrapped.

## 10. Code Examples

Primary: a repository that translates an infra sentinel into a domain error, with a typed validation error inspected via `errors.As`.

```go
package user

import (
    "context"
    "database/sql"
    "errors"
    "fmt"
)

var ErrUserNotFound = errors.New("user: not found")

type NotValidError struct {
    Field, Reason string
}

func (e *NotValidError) Error() string {
    return fmt.Sprintf("user: invalid %s: %s", e.Field, e.Reason)
}

type Repo struct{ db *sql.DB }

func (r *Repo) Find(ctx context.Context, id int64) (*User, error) {
    var u User
    err := r.db.QueryRowContext(ctx,
        "SELECT id, email FROM users WHERE id = $1", id).
        Scan(&u.ID, &u.Email)
    switch {
    case errors.Is(err, sql.ErrNoRows):
        return nil, fmt.Errorf("find user %d: %w", id, ErrUserNotFound)
    case err != nil:
        return nil, fmt.Errorf("find user %d: %w", id, err)
    }
    return &u, nil
}

// At the HTTP boundary, map error kinds to status codes.
func statusFor(err error) int {
    var nv *NotValidError
    switch {
    case err == nil:
        return 200
    case errors.Is(err, ErrUserNotFound):
        return 404
    case errors.As(err, &nv):
        return 422
    default:
        return 500
    }
}
```

Alternative: aggregating independent failures with `errors.Join` (e.g., validating multiple fields and reporting all at once).

```go
func validate(u *User) error {
    var errs []error
    if u.Email == "" {
        errs = append(errs, &NotValidError{"email", "required"})
    }
    if len(u.Email) > 254 {
        errs = append(errs, &NotValidError{"email", "too long"})
    }
    // Join drops nils; returns nil if all entries are nil.
    return errors.Join(errs...)
}

func report(u *User) {
    if err := validate(u); err != nil {
        // errors.As still finds typed errors inside a Join tree.
        var nv *NotValidError
        if errors.As(err, &nv) {
            fmt.Println("first invalid field:", nv.Field)
        }
        fmt.Println("all problems:\n", err) // Join prints one per line
    }
}
```

## 11. Advanced Concepts

- **Custom `Is`/`As` methods.** Implement `func (e *MyErr) Is(target error) bool` to define *semantic* equality (e.g., match on an error code regardless of message), or `As(any) bool` for custom extraction. `errors.Is/As` will call them.
- **Behavioral errors.** Instead of checking type, check capability: `if te, ok := err.(interface{ Timeout() bool }); ok && te.Timeout()`. This decouples callers from concrete types — `net` uses it.
- **`panic`/`recover` boundaries.** Convert panics to errors at trust boundaries (e.g., an HTTP middleware that `recover()`s, logs, and returns 500; or a worker pool that protects the dispatcher). Don't use `recover` as general control flow. Note `recover` only works in a deferred function in the same goroutine.
- **Goroutines and errors.** A panic in a goroutine you don't recover crashes the whole process. Propagate errors via channels or `golang.org/x/sync/errgroup`, which collects the first error and cancels the group's context.
- **Redaction & wire encoding.** In distributed systems (gRPC, log pipelines), `Error()` strings may leak PII. `cockroachdb/errors` separates safe vs unsafe details; consider this when errors cross process or trust boundaries.
- **Stack traces.** Stdlib errors carry none. If you need them, wrap at creation with a package that captures `runtime.Callers`, and avoid double-capturing on every wrap.

## 12. Debugging Tips

- **Print the full chain:** `fmt.Printf("%+v\n", err)` — with `pkg/errors`/`cockroachdb/errors` this prints stack traces; with stdlib it prints the concatenated chain.
- **Lost match?** If an `errors.Is` check suddenly fails, search for a `%v` that should be `%w` along the call path — that's the usual culprit.
- **Typed nil?** Add a guard: print `fmt.Printf("%T %v\n", err, err)`; a non-nil error printing `<nil>` with a concrete type name reveals the typed-nil interface bug.
- **`go vet`** catches `%w` with non-error args, bad format verbs, and `errors.As` with a non-pointer target — run it in CI.
- **`errcheck`/`golangci-lint`** flag unchecked error returns; `errorlint` flags `==` comparisons and non-`%w` wrapping that *should* wrap.
- **Reproduce error paths in tests** by injecting failures (interface fakes returning sentinels) and asserting with `errors.Is`.

## 13. Senior Engineer Notes

A senior engineer owns the *judgement* of error handling within a service:

- **Define the unwrap contract per package.** Decide and document which sentinels/types are public API. In reviews, push back on `%w` that leaks internal driver errors past an abstraction boundary, and on `%v` that destroys a chain callers legitimately need.
- **Enforce "context at boundaries, handle once."** In reviews, the two highest-value comments are "wrap this with what you were doing" and "you're logging *and* returning — pick one."
- **Mentor on `Is` vs `As` vs type switch.** Junior code is full of `err == X` and `strings.Contains`; teach the failure mode (wrapping) that makes those wrong.
- **Catch the typed-nil bug** on sight — it's the canonical Go trap and worth a team lint rule.
- **Right-size sentinels.** Resist a sprawling catalog of exported errors; prefer a small set plus typed errors carrying data.
- **Tooling is leverage:** get `errorlint`, `errcheck`, and `go vet` into CI so these aren't manual review burdens.

## 14. Staff Engineer Notes

A staff engineer sets the error *strategy* across services and teams:

- **Org-wide error taxonomy.** Standardize how errors map to gRPC codes / HTTP statuses / log severity, so a "NotFound" looks the same in every service and dashboards/alerts can be built generically. This is a contract decision, not a code decision.
- **Build-vs-buy on the error package.** Stdlib is enough for most services. Adopt `cockroachdb/errors` (stacks, redaction, wire-safe encoding) when you run a *distributed* system where errors cross processes and PII redaction + cross-node propagation matter. Don't impose its weight on simple services.
- **Observability coupling.** Decide where stack traces are captured and how errors flow into tracing (OpenTelemetry span status) and structured logs. Capturing stacks on every wrap is a latency/cost regression at fleet scale — set the policy.
- **Cross-team API stability.** Treat exported sentinels/typed errors as semver-relevant API. A staff engineer guards against teams unwrapping internal errors of *another* service's client library, which silently creates cross-team coupling that breaks on upgrade.
- **Failure-mode economics.** Errors-as-values means retry/circuit-breaker policy is driven by error *classification*; standardize a `Retryable()`/code-based contract so platform-level resilience (service mesh, backoff libs) works uniformly. The org-level payoff is consistent, debuggable failure handling rather than per-team snowflakes.

## 15. Revision Summary

- `error` is a one-method interface; errors are **values**, inspected explicitly — no exceptions.
- Wrap with `fmt.Errorf("...: %w", err)`; `%w` preserves the chain, `%v` flattens it.
- `errors.Is` = match a **sentinel/value**; `errors.As` = extract a **concrete type**; both walk the unwrap chain (and `errors.Join` trees, depth-first).
- Interface = (type ptr, data ptr); typed-nil pointer ⇒ non-nil interface ⇒ the classic `err != nil` bug.
- Creating errors allocates (`fmt.Errorf` ≫ `errors.New`); pre-allocate sentinels in hot paths; the happy path is free.
- Best practices: add context at each boundary, handle once, translate infra errors to domain errors, document your unwrap contract, never compare error strings.
- `panic`/`recover` is for bugs/invariants, recovered only at trust boundaries; goroutine panics crash the process — use `errgroup`/channels.
- Staff lens: org-wide taxonomy, code/status mapping, build-vs-buy (`cockroachdb/errors`), retryability contracts, semver-aware sentinels.

**References:** Go blog — *Error handling and Go* and *Working with Errors in Go 1.13*; stdlib `errors` package docs; `cockroachdb/errors`; `golang.org/x/sync/errgroup`.

---

*Go Engineering Handbook — topic 27.*
