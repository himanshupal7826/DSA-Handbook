# 12 · Functions

> **In one line:** In Go, functions are first-class values with explicit signatures, arguments are always passed by value, and that single rule explains almost every surprising behavior you will ever hit.

---

## 1. Overview

A function in Go is a named (or anonymous) block of code with a typed **signature**: a list of parameter types and a list of result types. What makes Go interesting is that `func` is not just a declaration keyword — it is also a **type**. A function value can be stored in a variable, passed as an argument, returned from another function, and put inside a slice or map. This is what "**first-class functions**" means.

The second pillar of this chapter is the calling convention: **Go is strictly pass by value.** Every argument — an `int`, a struct, a slice header, a pointer — is *copied* into the callee's stack frame. There is no pass-by-reference in Go. What looks like reference semantics (slices, maps, channels, pointers) is just copying a small value that happens to point at shared backing storage.

Master these two ideas and you understand: closures, method values, `defer`, callback APIs, why mutating a slice element works but appending inside a function "doesn't," and why passing a 4 KB struct by value can quietly cost you performance.

## 2. Why It Exists

Early systems languages forced a rigid split: code lives in functions, data lives in variables, and never the twain shall meet without macros or function pointers with ugly syntax. Go's designers, coming from C and Plan 9, wanted the expressiveness of higher-order functions (map/filter/handlers/middleware) **without** the cognitive overhead of a full functional language or C's `void (*fp)(int)` declarator soup.

So Go made functions first-class but kept the value model deliberately simple and predictable. The decision to make everything pass-by-value (per the language spec and reinforced in *Effective Go*) removes an entire category of "is this aliased?" reasoning that plagues C++ reference parameters. If you want the callee to mutate your data, you make the sharing **explicit** by passing a pointer. The cost is visible in the signature, which is exactly the Go philosophy: no hidden behavior.

> [!NOTE]
> Pass-by-value + explicit pointers is a *readability* feature, not just a semantic one. The signature `func f(u *User)` tells the reader "this may modify u" before they read a single line of the body.

## 3. Internal Working

A Go function value is **not** a bare code pointer. It is a pointer to a small runtime structure called a **funcval**:

```text
 function value (8 bytes on amd64)
 ┌──────────┐
 │ *funcval │───────►┌─────────────────┐
 └──────────┘        │ fn   (code ptr) │   <- entry point
                     │ captured vars…  │   <- only for closures
                     └─────────────────┘
```

For a plain top-level function, the funcval just holds the code entry address. For a **closure**, the compiler allocates a funcval that holds the code pointer *plus* the captured variables (or pointers to them if they escape). Calling through a function value loads the code pointer from `funcval+0` and jumps — this indirection is why an indirect call is marginally slower than a direct one and cannot be inlined.

**Calling convention.** Since Go 1.17, arguments and results are passed in **registers** (a register-based ABI) on amd64/arm64, falling back to the stack when they don't fit (roughly more than 9 integer + 15 float registers' worth). Before 1.17 everything went on the stack. Either way the semantics are identical: each argument is *copied*.

**Stack frames.** Each call gets a frame on a goroutine's contiguous, growable stack (starts at 8 KB, copied to a larger block when it overflows — "stack copying," which is why Go can rewrite interior pointers safely). Parameters and locals live there until the function returns, *unless* escape analysis proves a value outlives the call, in which case it is heap-allocated.

```text
 caller frame                callee frame (after copy)
 ┌───────────────┐           ┌───────────────┐
 │ s = {ptr,3,4} │── copy ──►│ s'= {ptr,3,4} │  ptr is shared!
 └───────────────┘           └───────────────┘
         │                           │
         └──────────┬────────────────┘
                    ▼
            backing array [_,_,_,_]  (one copy, aliased)
```

This diagram is the whole chapter: the **slice header** `{ptr, len, cap}` is copied, so reassigning the header inside the callee (e.g. via `append` that reallocates) is invisible to the caller, but writing through the shared `ptr` is visible.

## 4. Syntax

```go
// Basic declaration: signature = params + results
func add(a, b int) int { return a + b }

// Multiple return values (idiomatic for (result, error))
func div(a, b int) (int, error) {
    if b == 0 {
        return 0, fmt.Errorf("divide by zero")
    }
    return a / b, nil
}

// Named results (pre-declared locals; usable with a bare return)
func split(sum int) (x, y int) {
    x = sum * 4 / 9
    y = sum - x
    return // returns x, y
}

// Variadic parameter
func sum(nums ...int) int {
    total := 0
    for _, n := range nums {
        total += n
    }
    return total
}

// Function type, function value, and a closure
type BinOp func(int, int) int
var op BinOp = add
adder := func(base int) func(int) int {
    return func(x int) int { return base + x } // captures base
}
```

## 5. Common Interview Questions

**Q1. Is Go pass-by-value or pass-by-reference?**
Always by value. Every argument is copied. Slices/maps/channels/pointers feel like references only because the *value* you copy contains a pointer to shared storage.
*Follow-up: Then why does modifying a slice element inside a function persist?* Because the copied slice header points to the same backing array; you write through the shared pointer. But `append` that grows past `cap` reallocates and updates only the local header.

**Q2. What is a closure and where are captured variables stored?**
A function value bundled with the variables it references from its enclosing scope. If a captured variable escapes the stack, the compiler heap-allocates it and the closure holds a pointer. Multiple closures sharing a variable see each other's writes.
*Follow-up: What's the classic loop-capture bug?* Pre-Go 1.22, `for i := range xs { go func(){ use(i) }() }` captured one shared `i`. Go 1.22 changed loop variables to be **per-iteration**, fixing it.

**Q3. Difference between a method value and a method expression?**
A *method value* `t.Method` binds the receiver `t` and yields a `func(args)`. A *method expression* `T.Method` is unbound and yields `func(T, args)` where the receiver is the first parameter.
*Follow-up: Does a method value copy the receiver?* For a value receiver, yes — the receiver is captured by value at the moment you form `t.Method`.

**Q4. Can you compare two functions with `==`?**
Only against `nil`. Comparing two non-nil function values is a compile error. Functions are not comparable because there is no meaningful identity for closures.
*Follow-up: How do you build a set of callbacks then?* Key by something else (a string/ID) or store them in a slice.

**Q5. What does `defer` do to arguments and cost?**
Deferred call **arguments are evaluated immediately** at the `defer` statement, but the call runs at function return (LIFO). Since Go 1.14, open-coded defers make the common case nearly free (~1 ns).
*Follow-up: Gotcha with named returns?* A deferred closure can read and modify named result values after `return` is written — the basis of error-wrapping `defer func(){ err = wrap(err) }()`.

**Q6. Why prefer multiple return values over exceptions?**
Errors are ordinary values returned in the signature, making control flow explicit and forcing the caller to acknowledge failure. No invisible unwinding.
*Follow-up: Cost of returning a large struct?* It's copied to the caller; the compiler often elides the copy when the result is constructed in place, but a giant struct still favors returning a pointer.

**Q7. What is recursion's risk in Go, given no TCO?**
Go does **not** guarantee tail-call optimization, so deep recursion consumes stack frames. Stacks grow automatically (up to a 1 GB default limit), so you usually get correctness but at memory/perf cost; convert hot deep recursion to iteration.

## 6. Production Use Cases

- **HTTP middleware chains** — the entire `net/http` ecosystem is built on first-class functions: `http.HandlerFunc` adapts a `func(w, r)` into a `Handler`, and middleware is `func(http.Handler) http.Handler`. Chi, Gin, and Echo routers all compose these.
- **Functional options pattern** — `func(*Config)` options, popularized by Dave Cheney and used in gRPC-Go (`grpc.Dial(addr, grpc.WithInsecure(), ...)`), the AWS SDK v2, and Kubernetes client-go.
- **Callbacks / iterators** — `filepath.WalkDir`, `sync.Map.Range`, and Go 1.23 **range-over-func iterators** (`iter.Seq`) all hand you a function to call per element.
- **Concurrency primitives** — `go func(){...}()`, `sync.Once.Do(f)`, `errgroup.Group.Go(func() error)` from `golang.org/x/sync` — all take function values.
- **Test fakes & hooks** — replacing a struct field of function type (e.g. `clock func() time.Time`) is the standard Go way to inject test seams without interfaces.

## 7. Common Mistakes

> [!WARNING]
> **Expecting `append` inside a callee to mutate the caller's slice.** It only works if no reallocation happens. Return the new slice instead: `s = grow(s)`.

- **Capturing a loop variable in a closure** (only an issue before Go 1.22, but you will read pre-1.22 code for years). Shadow it: `i := i`.
- **Mutating a struct received by value** and expecting the caller to see it. Use a pointer receiver/param.
- **Deferring inside a loop** — defers stack up and run at *function* exit, not loop iteration exit, leaking file handles. Extract the loop body into a function.
- **Returning a pointer to a loop-local** thinking it's a bug — it isn't (escape analysis handles it), but returning the *same* pointer each iteration when you meant distinct copies is.
- **Comparing functions** other than to `nil` — compile error.

## 8. Performance Considerations

- **Copy cost scales with argument size.** Passing a `[64]byte` array by value copies 64 bytes per call; a slice or pointer copies ~8–24 bytes. For structs larger than ~3 machine words and called in hot loops, pass `*T`. But beware: pointers can force heap escapes, so measure.
- **Indirect calls (via function value/interface) prevent inlining.** A direct call to a small function may be inlined to zero overhead; a call through a `func` variable cannot, and costs a load + indirect jump (a few ns plus a branch-predictor dependency).
- **Closures that capture escaping variables allocate** on the heap. A closure capturing nothing or only stack-safe values may stay on the stack.
- **Register ABI (1.17+)** made small-argument calls noticeably cheaper than the old stack-based convention — roughly 5–10% on call-heavy code at the time.

> [!TIP]
> Use `go build -gcflags="-m"` to see escape-analysis and inlining decisions, and `go test -bench . -benchmem` to confirm a "pass by pointer" change actually reduced allocations rather than just moving them.

## 9. Best Practices

- Keep signatures small and honest: return `(T, error)`, not sentinel values.
- Prefer value receivers/params for small immutable data; pointers for large structs or when you must mutate.
- Name results only when it aids documentation or you need `defer`-based error wrapping — don't abuse bare `return`.
- Accept interfaces, return concrete types; for callbacks, define a *named* function type (`type Handler func(...)`) so the contract is documented.
- Use the functional-options pattern for constructors with many optional params instead of telescoping arguments or giant config structs.
- Convert deep, hot recursion to iteration or an explicit stack.

## 10. Code Examples

Primary: the functional-options pattern, the most production-relevant use of first-class functions in Go.

```go
package server

import "time"

type Server struct {
    addr    string
    timeout time.Duration
    maxConn int
}

// Option mutates a Server during construction — a first-class func value.
type Option func(*Server)

func WithTimeout(d time.Duration) Option {
    return func(s *Server) { s.timeout = d } // closure captures d
}
func WithMaxConn(n int) Option {
    return func(s *Server) { s.maxConn = n }
}

func New(addr string, opts ...Option) *Server {
    s := &Server{addr: addr, timeout: 30 * time.Second, maxConn: 100}
    for _, opt := range opts {
        opt(s) // s is a pointer, so options mutate the shared value
    }
    return s
}

// New(":8080", WithTimeout(5*time.Second), WithMaxConn(500))
```

Alternative: HTTP middleware composition, showing `func(Handler) Handler`.

```go
package mw

import (
    "log"
    "net/http"
    "time"
)

type Middleware func(http.Handler) http.Handler

func Logging(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()
        next.ServeHTTP(w, r)
        log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start))
    })
}

func Chain(h http.Handler, mws ...Middleware) http.Handler {
    for i := len(mws) - 1; i >= 0; i-- { // apply in declared order
        h = mws[i](h)
    }
    return h
}
```

The slice-mutation gotcha, as a standalone runnable snippet:

```go
package main

import "fmt"

func setFirst(s []int)        { s[0] = 99 }      // visible: writes through shared ptr
func growBroken(s []int)      { s = append(s, 7) } // invisible: reallocates local header
func growFixed(s []int) []int { return append(s, 7) }

func main() {
    a := []int{1, 2, 3}
    setFirst(a)
    fmt.Println(a) // [99 2 3]
    growBroken(a)
    fmt.Println(a) // [99 2 3] — append didn't persist
    a = growFixed(a)
    fmt.Println(a) // [99 2 3 7]
}
```

## 11. Advanced Concepts

- **Range-over-func iterators (Go 1.23).** A function with signature `func(yield func(K, V) bool)` can be used directly in a `for range`. This makes lazy, composable iteration first-class without exposing internal state — standardized as `iter.Seq[V]` and `iter.Seq2[K,V]`.
- **Generics + functions.** `func Map[T, U any](s []T, f func(T) U) []U` combines type parameters with first-class functions — the basis of `slices` helper libraries and pipelines.
- **Method values vs. expressions in dispatch tables.** `T.Method` (expression) is a clean way to build `map[string]func(*T)` command dispatchers because the receiver becomes an explicit parameter.
- **Continuation-passing & trampolining.** Since Go lacks TCO, deep mutual recursion can be expressed as functions returning the next function (a trampoline) to bound stack growth.
- **`//go:noinline` and escape control.** Compiler directives let you force or study inlining/escape behavior when micro-optimizing call-heavy code.

## 12. Debugging Tips

- `go build -gcflags="-m -m"` prints why a value escapes and whether a call inlines — the fastest way to explain a mysterious allocation.
- For "my change didn't take effect," check whether you passed a *value* where you needed a *pointer*, or whether `append` reallocated.
- `go test -bench=. -benchmem -cpuprofile=cpu.out` plus `go tool pprof` reveals time spent in indirect calls and closure allocations.
- In Delve (`dlv`), `args` shows the copied parameters in the current frame; stepping into a closure shows captured variables on the heap.
- A goroutine stack dump (`SIGQUIT` / `panic`) shows the recursive call depth — invaluable for runaway recursion or unbounded callback chains.

## 13. Senior Engineer Notes

A senior engineer reads a signature as a contract and pushes back in review when it lies: a `func Process(data []Item)` that secretly mutates `data` should either be renamed, documented, or take `*[]Item`/return the result. You should know the slice-header copy rule cold and use it to explain bugs to teammates instead of cargo-culting "just use pointers everywhere."

In design, you choose between callbacks, interfaces, and channels deliberately: callbacks for simple synchronous hooks, interfaces when you need multiple methods or mockability, channels when ownership crosses goroutines. You mentor juniors away from premature pointer-passing (which hurts escape analysis and readability) and toward measuring with `-gcflags=-m`. You also recognize the functional-options pattern's downside — discoverability and IDE support are worse than a config struct — and apply it only when the option set is genuinely open-ended.

## 14. Staff Engineer Notes

At staff level the concern shifts from individual functions to **API surfaces that thousands of call sites depend on**. Choosing `func(*Config) Option` vs. a public config struct is a versioning decision: options let you add parameters without breaking callers (Go's strict backward-compat for exported signatures makes this real money), but they make the API harder to document and statically analyze across an org's codebase.

You weigh build-vs-buy for cross-cutting function patterns: standardize one middleware/`errgroup`/options convention org-wide rather than letting each team invent its own callback shape, because inconsistency taxes every code review and onboarding. You think about the performance blast radius of indirect calls in shared hot paths (serialization, logging, tracing) and may mandate concrete types there while allowing function values at the edges. And you set the guidance — backed by *Effective Go* and the spec — that the team relies on: pass-by-value semantics are non-negotiable language behavior, so the architecture must make sharing explicit rather than fighting the language.

## 15. Revision Summary

- A `func` is both a declaration and a **type**; function values are first-class (storable, passable, returnable).
- **Everything is pass by value** — arguments are copied into the callee's frame.
- Slices/maps/channels/pointers *look* like references because the copied value contains a shared pointer; writing through it persists, reassigning the local header (e.g. reallocating `append`) does not.
- A function value is a `*funcval` (code pointer + captured vars for closures); indirect calls can't inline.
- Go 1.17+ uses a register-based ABI; Go 1.22 made loop variables per-iteration; Go 1.23 added range-over-func iterators.
- No guaranteed TCO — deep recursion costs stack; prefer iteration in hot paths.
- Functions compare only to `nil`. `defer` args evaluate immediately, the call runs LIFO at return.
- Production patterns: HTTP middleware, functional options, callbacks/iterators, concurrency primitives, test seams.

**References:** *Effective Go* (Functions, Defer); The Go Programming Language Specification (Function types, Calls, Passing arguments); Go release notes 1.17 (register ABI), 1.22 (loop var), 1.23 (range-over-func); Dave Cheney, "Functional options for friendly APIs."

---
*Go Engineering Handbook — topic 12.*
