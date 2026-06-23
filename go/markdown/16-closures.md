# 16 · Closures

> **In one line:** A closure is a function value that captures and holds a live reference to variables from its enclosing scope, keeping them alive past the scope's normal lifetime.

---

## 1. Overview

A *closure* is a function literal that references variables declared *outside* its own body. When you write a `func(...) {...}` expression that mentions a variable from the surrounding function, Go produces a function value that "closes over" that variable — hence the name. The captured variable is not copied at creation time; the closure holds a reference to the same storage, so reads and writes inside the closure are visible to the outer scope and to every other closure that captured the same variable.

Closures are the backbone of idiomatic Go: `http.HandlerFunc` adapters, `defer func(){}()` cleanup, `sync.Once` initializers, functional options (`WithTimeout(...)`), middleware chains, and `errgroup.Go(func() error {...})` all rely on them. Understanding closures is mostly understanding *what exactly gets captured, by reference or by value, and how long it stays alive*.

> [!NOTE]
> Go 1.22 changed the semantics of the `for` loop variable specifically to make the most common closure footgun disappear. Half of this chapter only makes sense once you understand *both* the pre-1.22 and post-1.22 worlds.

## 2. Why It Exists

Closures exist to let functions carry *state* without a class, a struct, or a global variable. Before closures, capturing context meant either passing every dependency through parameters on every call, or smuggling it through package-level state (which destroys testability and concurrency safety).

Three concrete needs closures solve:

1. **Deferred behavior with context.** A `defer` or a goroutine that runs later needs access to local variables. Closures let those variables travel with the function.
2. **Configuration and adaptation.** Functional options, decorators, and middleware bind configuration *once* and return a function specialized to it.
3. **Encapsulated mutable state.** A counter, a memoizer, or a rate limiter can keep private state that no other code can touch — the only handle is the returned function(s).

The alternative — passing a `*Context` struct everywhere or using globals — is more verbose and far easier to get wrong under concurrency. Closures make "a function plus the data it needs" a single first-class value.

## 3. Internal Working

The key compiler concept is **variable escape**. The Go compiler runs *escape analysis*. If a local variable is captured by a closure that may outlive the current stack frame, the variable cannot live on the stack (the frame is destroyed on return). The compiler **heap-allocates** that variable and the closure stores a pointer to it.

A closure value at runtime is a two-word structure on most architectures: a pointer to the function's code, plus a pointer to a *closure context* (sometimes called the "func value" or environment). The context holds pointers to (or inlined copies of) each captured variable.

```text
   captured variable n (int) lives on heap because it escapes
   +---------------------+
   |   n = 7             |  <--- shared storage
   +---------------------+
        ^         ^
        |         |
   +----------+   +----------+
   | closure A|   | closure B|     two closures, same n
   | code ptr |   | code ptr |
   | ctx ptr -+---+- ctx ptr |     both ctx point to same heap cell
   +----------+   +----------+
```

Because both closures point to the *same* heap cell, a write through closure A is observed by closure B. This is what people mean by "capture by reference." Go does not have a separate "capture by value" syntax; to capture a value, you create a *new* variable (often by shadowing) and capture that instead.

When a closure does *not* escape (e.g. you call it immediately and it never leaves the frame), escape analysis keeps the captured variables on the stack and the closure context is a stack pointer — zero heap cost. You can see all of this with `go build -gcflags='-m'`.

> [!TIP]
> Run `go build -gcflags='-m -m' ./...` and look for lines like `moved to heap: n` and `func literal escapes to heap`. That is the ground truth about what your closures cost.

The pre-1.22 loop trap comes directly from this model: in older Go, the `for i := ...` variable `i` was a *single* variable reused across iterations. Every closure that captured `i` shared one heap cell, so they all saw the final value. Go 1.22 made each iteration declare a *fresh* `i`, so each closure captures a distinct cell.

## 4. Syntax

```go
// A function literal that captures `prefix` and `count` from its scope.
func makeLogger(prefix string) func(msg string) {
	count := 0
	return func(msg string) {
		count++ // mutates captured state, persists across calls
		fmt.Printf("[%s #%d] %s\n", prefix, count, msg)
	}
}

log := makeLogger("API")
log("started") // [API #1] started
log("ready")   // [API #2] ready
```

A closure can capture multiple variables, return multiple closures sharing state, and be assigned, passed, and stored like any other value. The capture is implicit — there is no capture list as in C++ lambdas.

## 5. Common Interview Questions

**Q1. What does this print (pre-Go 1.22)?**
```go
funcs := []func(){}
for i := 0; i < 3; i++ {
	funcs = append(funcs, func() { fmt.Print(i) })
}
for _, f := range funcs { f() }
```
*Answer:* In Go ≤1.21 it prints `333` — all closures share one `i`, which is `3` after the loop. In Go ≥1.22 it prints `012` because each iteration has a fresh `i`. **Follow-up:** *How would you get `012` under Go 1.21?* Add `i := i` inside the loop (shadowing creates a per-iteration variable) or pass `i` as a parameter to an IIFE.

**Q2. Are Go closures capture-by-value or capture-by-reference?**
*Answer:* By reference — the closure shares the variable's storage, so mutations are mutually visible. To capture a snapshot, introduce a new variable. **Follow-up:** *Why does the compiler heap-allocate the captured variable?* Because the closure may outlive the stack frame; escape analysis forces it to the heap so the pointer stays valid.

**Q3. Does capturing a loop variable that escapes hurt performance?**
*Answer:* Yes — it forces a heap allocation per captured variable (and in 1.22, per iteration if the closure escapes). For hot loops, this can be the dominant cost. **Follow-up:** *How do you confirm?* `go build -gcflags='-m'` and `go test -bench -benchmem` to see allocs/op.

**Q4. How do `defer func(){}()` closures interact with named return values?**
*Answer:* A deferred closure can read and *modify* named return values because it captures them by reference. This is the standard pattern for `recover`-based error translation. **Follow-up:** *What if the return is unnamed?* The closure cannot change the returned value; it only sees its own copies.

**Q5. Explain a memory leak caused by a closure.**
*Answer:* If a long-lived closure (e.g. stored in a global registry or a long-running goroutine) captures a large object, that object cannot be garbage-collected for as long as the closure lives — even if you only use one small field. **Follow-up:** *Fix?* Capture just the needed field into a local, or set the large reference to `nil` after extracting what you need.

**Q6. What's the difference between these two?**
```go
go func() { process(item) }()      // captures item
go func(it Item) { process(it) }(item) // passes item
```
*Answer:* The first captures `item` by reference — dangerous in a pre-1.22 loop or if `item` is reassigned. The second copies `item` into a parameter at goroutine launch, snapshotting it safely. **Follow-up:** *Is the second still needed in 1.22?* For range/loop variables, no. But if `item` is reassigned later in the same scope (not a loop var), parameter passing is still the safe choice.

**Q7. Can two closures share private state safely across goroutines?**
*Answer:* They share the variable, but sharing is not synchronization. Concurrent access to captured state needs a mutex, atomic, or channel — closures give you shared memory, not safety. **Follow-up:** *Detect it?* Run with `-race`.

## 6. Production Use Cases

- **HTTP middleware** (net/http, chi, gin, echo): each middleware is `func(http.Handler) http.Handler` returning a closure that captures the next handler — the entire request pipeline is a chain of closures.
- **Functional options** (gRPC-Go, Uber's `zap`, AWS SDK v2 config): `WithTimeout(d)` returns `func(*Config){ c.timeout = d }`, capturing `d`.
- **`errgroup` / worker pools** (Kubernetes, Docker): `g.Go(func() error { return fetch(url) })` captures per-task data.
- **`sync.Once` lazy initialization**: `once.Do(func(){ conn = dial() })` captures the variable to populate.
- **Lazy/memoized computation**: caching layers in databases and CDNs return a closure that captures the cache map.
- **Test fixtures and table-driven tests** (everywhere in Go's stdlib): `t.Run(name, func(t *testing.T){ ... })` capturing the test case — *the* canonical place the loop-var trap historically bit people.
- **Rate limiters and circuit breakers** (`golang.org/x/time/rate`, sony/gobreaker patterns) keep counters and timestamps in captured state.

## 7. Common Mistakes

> [!WARNING]
> The classic loop-variable capture bug. Pre-1.22, launching goroutines or building handler slices inside a `for` loop and capturing the loop variable gives every closure the *final* value.

```go
// BUG (pre-1.22): every goroutine may print the same / last value
for _, v := range items {
	go func() { fmt.Println(v) }() // v shared
}
```

Other frequent mistakes:

1. **Assuming a snapshot.** Capturing a variable that gets mutated later, expecting the closure to remember the old value.
2. **Accidental retention (leak).** Capturing a huge struct or an entire request when you only need one ID.
3. **Unsynchronized shared state.** Multiple goroutines writing the same captured counter without atomics.
4. **`defer` in a loop capturing loop state.** Deferred closures all run at function end with whatever the captured variable holds, and they pile up.
5. **Mutating the captured variable in a `defer` and being surprised** the return value changed (this is sometimes intended, sometimes a bug).

## 8. Performance Considerations

The cost of a closure is dominated by **whether captured variables escape to the heap**.

| Scenario | Allocation | Notes |
|---|---|---|
| Closure called immediately, no escape | none | Stays on stack; effectively free |
| Closure returned/stored, captures 1 int | 1 heap alloc | The int moves to heap |
| Closure in a loop that escapes (1.22) | 1 alloc/iteration | Fresh var per iteration |
| Closure capturing a large struct | retains whole struct | GC pressure / leak risk |

Each closure *value* itself is a two-word value (16 bytes on 64-bit); passing it around is cheap. The expensive part is the captured environment. A tight loop creating millions of escaping closures will show up clearly in `-benchmem` as allocs/op. For hot paths, prefer passing data as parameters (stays on stack) or reuse a single closure outside the loop.

> [!TIP]
> Closures also block inlining in some cases and add an indirect call. For ultra-hot inner loops, a method value or a plain function with explicit args can be measurably faster — but only optimize after profiling.

## 9. Best Practices

- **Capture the smallest thing.** Extract the one field you need into a local and capture that, not the whole object — better for both performance and leak-avoidance.
- **Prefer parameters for goroutines** when there's any doubt about mutation: `go func(x T){...}(x)` is self-documenting and snapshot-safe.
- **On Go 1.22+, rely on per-iteration loop variables** but still set `go 1.22` (or higher) in `go.mod` so the new semantics are guaranteed; the behavior is gated on the module's language version.
- **Synchronize shared captured state** with mutex/atomic/channel; closures share memory, not safety.
- **Keep closures small.** A closure spanning 50 lines is a function that wants a name. Name it.
- **Document captured mutable state** when a closure mutates something the caller also holds.

## 10. Code Examples

Primary idiomatic example — a memoizer that keeps private, encapsulated state:

```go
package main

import (
	"fmt"
	"sync"
)

// Memoize returns a function that caches results of fn. The cache is
// captured private state — no other code can reach it.
func Memoize(fn func(int) int) func(int) int {
	var mu sync.Mutex
	cache := make(map[int]int)
	return func(n int) int {
		mu.Lock()
		defer mu.Unlock()
		if v, ok := cache[n]; ok {
			return v
		}
		v := fn(n)
		cache[n] = v
		return v
	}
}

func main() {
	calls := 0
	square := Memoize(func(n int) int { calls++; return n * n })
	fmt.Println(square(4), square(4), square(5)) // 16 16 25
	fmt.Println("underlying calls:", calls)      // 2
}
```

Alternative idiom — functional options, the most common production closure pattern:

```go
package main

import (
	"fmt"
	"time"
)

type Server struct {
	addr    string
	timeout time.Duration
}

type Option func(*Server) // a closure that configures a Server

func WithTimeout(d time.Duration) Option {
	return func(s *Server) { s.timeout = d } // captures d
}

func WithAddr(a string) Option {
	return func(s *Server) { s.addr = a }
}

func NewServer(opts ...Option) *Server {
	s := &Server{addr: ":8080", timeout: 30 * time.Second}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

func main() {
	s := NewServer(WithAddr(":9000"), WithTimeout(5*time.Second))
	fmt.Printf("%+v\n", s)
}
```

Demonstrating the loop-var fix explicitly (works correctly on 1.22+, and on older Go with the shadow line):

```go
for _, v := range items {
	v := v // belt-and-suspenders for pre-1.22; harmless on 1.22+
	go func() { fmt.Println(v) }()
}
```

## 11. Advanced Concepts

**Named returns + deferred closures = error decoration.** The standard recover-to-error idiom relies on a deferred closure mutating a named return:

```go
func safeRun() (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("recovered: %v", r) // mutates named return
		}
	}()
	panic("boom")
}
```

**Mutual recursion via closures.** Because a closure can capture a variable that is later assigned the closure itself, you can build recursive lambdas:

```go
var fib func(int) int
fib = func(n int) int {
	if n < 2 {
		return n
	}
	return fib(n-1) + fib(n-2) // captures fib by reference
}
```

**Method values are closures in disguise.** `obj.Method` produces a function value that captures the receiver `obj`. It allocates if the receiver escapes — same rules apply.

**Capture granularity in 1.22.** The per-iteration variable applies to both `for i := 0; ...` and `for k, v := range`. The change is purely about the *loop variable's* lifetime; variables you declare *inside* the loop body already had fresh-per-iteration semantics in every Go version.

## 12. Debugging Tips

- **`-race`** is your first tool when captured state is shared across goroutines — it catches the unsynchronized-counter bug instantly.
- **`go build -gcflags='-m'`** prints escape decisions: `func literal escapes to heap`, `moved to heap: x`. Use it to explain surprising allocations.
- **`go vet`** with `loopclosure` analysis flags the classic loop-capture pattern (especially valuable in mixed-version codebases targeting pre-1.22).
- **`go test -bench=. -benchmem`** quantifies allocs/op caused by escaping closures.
- **Delve (`dlv`)**: when stepping, captured variables appear under the closure's scope; inspect the func value to confirm what was captured.
- **Memory profiling (`pprof` heap profile)** reveals closures retaining large objects — look for unexpected retention rooted in goroutines or global registries.

> [!NOTE]
> If you see "this worked in tests but fails in prod" with goroutines, suspect a loop-capture or mutation-after-capture bug first — and check the module's `go` directive, since the loop semantics depend on it.

## 13. Senior Engineer Notes

A senior engineer treats closures as a *judgement* tool, not a reflex. In code review, the questions I ask: *What does this capture? Does it escape? Could the captured variable change before the closure runs? Is captured state shared across goroutines, and if so, where's the synchronization?* A goroutine launched in a loop without parameter-passing gets a comment even on 1.22 — because the *next* refactor might reintroduce a reassignment, and explicit is safer than clever.

I push back on closures that have grown into 40-line anonymous monsters: they hurt readability, stack traces (`func1`, `func2`), and testability. Pull them into named functions. I also watch for the leak pattern — a handler closure capturing the whole `*http.Request` to grab one header — and ask for the minimal capture.

When mentoring, I make engineers run `-gcflags='-m'` themselves so they *see* the heap allocation rather than take my word for it. The mental model "closure = code pointer + environment pointer, environment may live on the heap" is what separates someone who memorized the loop bug from someone who can reason about any new variation of it.

## 14. Staff Engineer Notes

At the staff level, closures are an *architecture and migration* concern. The Go 1.22 loop-variable change is a rare language semantics change: I drive the org-wide story — bump `go` directives module by module, enable `loopclosure` vet in CI, and decide whether to keep defensive `v := v` lines (I usually say remove them once everything is ≥1.22, to reduce noise, but only after the lint gate is enforced). This is a cross-team coordination problem more than a coding one.

I weigh closures against alternatives at the API boundary. Functional options (closures) versus a config struct is a genuine build-vs-buy-style trade-off: options give backward-compatible extensibility and great ergonomics, but they're harder to introspect, harder to serialize, and add allocation per option. For a public SDK with a long deprecation horizon, options usually win; for an internal hot-path constructor called millions of times, a plain struct is cheaper and clearer. I make that call explicitly and document the reasoning.

Org-wide, I care about the *failure modes closures enable at scale*: goroutine leaks from captured contexts, retained memory in long-lived registries, and "spooky action at a distance" when shared captured state crosses team boundaries. My guidance favors passing explicit, immutable data into goroutines and reserving shared-mutable-via-closure for tightly-owned, well-synchronized components. The cost of one team's closure bug is paid by whoever's on call, so the architectural defaults should make the safe path the easy path.

## 15. Revision Summary

- A closure = function value + captured environment; capture is **by reference**, sharing storage with the outer scope.
- Captured variables that outlive their frame **escape to the heap** (escape analysis); confirm with `-gcflags='-m'`.
- Runtime shape: two words — code pointer + context pointer to captured vars.
- **Go ≤1.21:** one shared loop variable → classic `333` bug. **Go ≥1.22:** fresh per-iteration variable → prints `012`. Behavior gated on the module's `go` directive.
- Snapshot a value by introducing a new variable (`v := v`) or passing it as a parameter to the closure.
- Closures share memory, **not synchronization** — use mutex/atomic/channel and `-race`.
- Capture the smallest needed value to avoid leaks; keep closures short and named when large.
- Production patterns: middleware, functional options, `errgroup`, `sync.Once`, memoization, `defer`+named-return error decoration.

**References:** Go blog — *Closures*; Go 1.22 release notes (loop variable scoping); `go vet` loopclosure analyzer; "The Go Memory Model".

---
*Go Engineering Handbook — topic 16.*
