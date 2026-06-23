# 15 · Variadic Functions

> **In one line:** A variadic parameter is syntactic sugar that turns a trailing list of arguments into a freshly-allocated slice, so `func f(args ...T)` is really `func f(args []T)` with compiler-managed packing and spreading.

---

## 1. Overview

A *variadic function* accepts a variable number of trailing arguments of a single type. You declare it by prefixing the last parameter's type with `...`:

```go
func sum(nums ...int) int {
    total := 0
    for _, n := range nums {
        total += n
    }
    return total
}
```

Callers can pass zero, one, or many values: `sum()`, `sum(1)`, `sum(1, 2, 3)`. They can also *spread* an existing slice with the `...` operator: `sum(xs...)`.

The single most important fact — the one that drives every interview question, performance trap, and best practice in this chapter — is that **inside the function, the variadic parameter is just a `[]T`**. `nums` in the example above has static type `[]int`. The `...` at the call site is the compiler packing your arguments into a slice; the `...` at the spread site is you handing the compiler a slice it can use directly. Master that duality and the rest is mechanical.

This is a Beginner topic, but the internals (allocation, escape analysis, `append`'s growth algorithm, the `nil` vs empty-slice subtlety) reach all the way into staff-level performance and API design discussions.

## 2. Why It Exists

Variadics solve a concrete ergonomic problem: APIs where the *number* of inputs is genuinely open-ended and forcing callers to build a slice would be noise.

The canonical example is the entire `fmt` family. `fmt.Println(a ...any)`, `fmt.Printf(format string, a ...any)` — you cannot know at compile time how many values a caller wants to print. Before generics and before variadics, languages handled this with overloads (C++/Java), `printf`'s untyped C varargs (unsafe), or builder objects (verbose). Go chose a type-safe, single-mechanism approach.

Variadics also enable the **functional options pattern**, which is arguably the most important idiomatic use of variadics in production Go (see §6 and §11). `NewServer(opts ...Option)` lets a library evolve its configuration surface without breaking callers — a critical property for long-lived APIs.

Per *Effective Go*, variadics keep the common case clean while still allowing the full-slice case via spreading. The design tradeoff Go accepts: a variadic call *may* allocate a slice. The language made ergonomics win, with escape analysis clawing back performance where it can.

## 3. Internal Working

There is no runtime "varargs" machinery in Go like C's `va_list`. Variadics are resolved almost entirely at compile time. A function `func f(a int, rest ...string)` has the *exact same* calling convention and ABI as `func f(a int, rest []string)`. The signature, the symbol, the way the callee reads `rest` — identical.

The difference is at the **call site**. When you write `f(1, "x", "y")`, the compiler synthesizes a backing array, packs the trailing arguments into it, builds a slice header pointing at it, and passes that header. Conceptually the compiler rewrites:

```text
f(1, "x", "y")
        ──rewritten by compiler──►
tmp := [2]string{"x", "y"}      // backing array
f(1, tmp[:])                    // slice header: {ptr=&tmp[0], len=2, cap=2}
```

A slice header is three words: `{ptr, len, cap}`. So the callee always receives those three words regardless of how many actual arguments were spelled out.

```text
 Call: f(1, "x", "y")

 Stack / heap (backing array)        Slice header passed to f
 ┌──────────┬──────────┐            ┌───────┬───────┬───────┐
 │  "x"     │  "y"     │ ◄────────  │  ptr  │ len=2 │ cap=2 │
 └──────────┴──────────┘            └───────┴───────┴───────┘
   [0]         [1]
```

Three special cases the compiler optimizes:

1. **Zero arguments** (`f(1)`): the slice is passed as `nil` — `{ptr=nil, len=0, cap=0}`. *No allocation happens.* This is why `len(rest) == 0` and `rest == nil` are both true for a no-arg variadic call.
2. **Spread call** (`f(1, xs...)`): no packing, no new backing array. The compiler passes `xs`'s own header straight through. The callee receives a slice *aliasing the caller's data* — a frequent source of bugs (see §7).
3. **Escape analysis**: if the synthesized backing array does not escape the callee (the callee doesn't store it, return it, or pass it somewhere that escapes), the array is allocated on the **stack**, making the call allocation-free. If it escapes, it's heap-allocated and shows up in your profiles.

`append` is the close cousin and shares the slice-header world. `append(s, x)` is a builtin (not an ordinary function) that the compiler lowers specially. When `len(s) < cap(s)`, it writes in place and bumps the length. When `len(s) == cap(s)`, the runtime calls `growslice`, which allocates a new, larger backing array, copies the old elements, then appends. The growth heuristic (Go 1.18+) roughly: double capacity for small slices (< 256 elements), then grow by ~1.25x with smoothing for large ones. `append(dst, src...)` is itself a variadic spread call into `append`.

## 4. Syntax

```go
// Declaration: ... before the type of the LAST parameter only.
func f(prefix string, vals ...int) {}

// Inside the body, vals has type []int.
func describe(vals ...int) {
    fmt.Printf("type=%T len=%d cap=%d nil=%v\n", vals, len(vals), cap(vals), vals == nil)
}

// Call forms:
describe()              // len=0 cap=0 nil=true   — no allocation
describe(1)             // len=1
describe(1, 2, 3)       // len=3
nums := []int{1, 2, 3}
describe(nums...)       // SPREAD: passes nums' own backing array
// describe(nums)       // COMPILE ERROR: cannot use []int as int
```

Rules enforced by the compiler:

- Only the **last** parameter may be variadic: `func f(a ...int, b string)` is illegal.
- A function has **at most one** variadic parameter.
- You cannot mix a spread with extra explicit values for the *same* variadic param: if `nums` is `[]int`, `f(1, nums...)` targeting one `...int` is illegal — use either all-explicit args or a single spread.
- The spread argument must be assignable to `[]T` where `T` is the element type. A `[]any` value *is* spreadable into a `...any` parameter via `someAnySlice...`, but passing it without `...` makes it a single argument.

## 5. Common Interview Questions

**Q1. What is the static type of a variadic parameter inside the function?**
A slice — `[]T`. `func f(x ...int)` makes `x` a `[]int`. *Follow-up: does `f()` allocate?* No; the compiler passes a `nil` slice, so a zero-argument call is allocation-free.

**Q2. What's the difference between `f(slice...)` and `f(slice[0], slice[1], ...)`?**
The spread form passes the slice's *existing backing array* (aliasing — mutations inside `f` can be seen by the caller, and `f` can append into spare capacity). The explicit form packs a brand-new array. *Follow-up: when is the spread form dangerous?* When the callee uses `append` on the variadic slice — it may overwrite the caller's data that lives in the slice's spare capacity.

**Q3. Why does `append(a, b...)` sometimes mutate `a`'s caller and sometimes not?**
If `a` has spare capacity (`cap > len`), `append` writes in place, mutating shared backing memory. If it must grow, it allocates a new array, so the original is untouched. The behavior is *capacity-dependent and therefore non-obvious*. *Follow-up: how do you force a copy?* Use `slices.Clone` first, or the three-index slice `a[:len(a):len(a)]` to cap capacity so any append reallocates.

**Q4. Can you pass `[]any` to a `...any` parameter directly?**
Only with spread: `fmt.Println(anySlice...)`. Passing `fmt.Println(anySlice)` prints the slice as a single argument. *Follow-up: a classic gotcha?* `log.Fatal(args...)` vs `log.Fatal(args)` — forgetting `...` logs the slice's `%v` instead of the intended values.

**Q5. Is there runtime cost to variadics versus a fixed-arity function?**
Potentially one slice allocation per call if the backing array escapes; otherwise stack-allocated and free. The dispatch itself is identical to a normal call. *Follow-up: how do you confirm an allocation?* `go build -gcflags='-m'` for escape analysis, or `testing.B` with `-benchmem` to see `allocs/op`.

**Q6. Why must the variadic parameter be last?**
Because packing is greedy: the compiler assigns all trailing positional arguments to it. With a parameter after it, parsing arguments would be ambiguous. *Follow-up: how do people get "leading variadic" behavior?* They put the required arg first (`Printf(format, a ...any)`), which is exactly why format strings come before the values.

**Q7. What does `func f(x ...int)` receive when called as `f(nil...)` where `nil` is a `[]int`?**
A `nil` slice — `len 0`, `x == nil` true. Distinct from `f()` only in intent; both yield `nil`. *Follow-up: and `f([]int{}...)`?* A non-nil, length-0 slice (`x == nil` is *false*). This nil-vs-empty distinction is a real test trap.

**Q8. How would you write a function that takes "at least one" argument?**
Make the first one required and the rest variadic: `func Max(first int, rest ...int) int`. The type system now enforces the minimum at compile time. *Follow-up: why is this better than checking `len(args) == 0` and panicking?* Compile-time errors beat runtime panics; the caller can't even compile a zero-arg call.

## 6. Production Use Cases

- **Functional options pattern** (the big one). Used across the Go ecosystem: `google.golang.org/grpc` (`grpc.NewServer(opts ...ServerOption)`), `go.uber.org/zap` (`zap.New(core, opts ...Option)`), the AWS SDK v2 (`config.LoadDefaultConfig(ctx, optFns ...func(*config.LoadOptions) error)`), and Kubernetes client-go. Variadic `...Option` lets these libraries add knobs for years without breaking a single caller.
- **Structured logging.** `slog`, `zap`, and `logrus` use variadic key-value or field arguments: `logger.Info("msg", "key", val, "key2", val2)`. `slog.Info(msg string, args ...any)` is variadic at its core.
- **Formatting / printing.** The entire `fmt` package, `t.Errorf`, `t.Logf`, `errors.Join(errs ...error)` (Go 1.20+), and `fmt.Errorf` wrapping.
- **Query builders / ORMs.** `db.Query(sql, args ...any)` in `database/sql` — the canonical "I don't know how many bind parameters" case. Squirrel and GORM build on this.
- **Set/collection constructors.** `slices.Contains`, helpers like `NewSet(items ...T)`, and `append`-based merges.
- **Middleware chains.** HTTP routers (chi, gin) accept `func(...Middleware)` to compose handlers.

## 7. Common Mistakes

> [!WARNING]
> The number one production bug with variadics is **append-into-spare-capacity aliasing** when a slice is spread and the callee appends to it. The callee can silently corrupt the caller's slice.

```go
func appendID(ids []int, more ...int) []int {
    return append(ids, more...) // may write into `ids`' backing array
}

base := make([]int, 2, 8) // len 2, cap 8 — lots of spare capacity
base[0], base[1] = 1, 2
a := appendID(base, 99)    // writes 99 into base's backing array index 2
b := appendID(base, 88)    // writes 88 into the SAME index 2
// a[2] is now 88, not 99 — a and b share memory!
```

Other frequent mistakes:

- **Forgetting `...` on spread**: `log.Println(args)` prints `[1 2 3]` instead of `1 2 3`. Compiles fine, wrong output.
- **Confusing `nil` and empty**: `f()` and `f([]int{}...)` differ in `x == nil`. Tests that assert `== nil` break.
- **Assuming zero-arg calls allocate or panic**: they don't; `range` over a `nil` slice is fine (zero iterations).
- **Overusing `...any`**: it defeats type checking. `func Do(args ...any)` turns compile-time errors into runtime panics.
- **Keying mistakes in `...any` KV logging**: odd number of args (`logger.Info("m", "key")`) — `slog` handles it, but home-grown loggers may panic.

## 8. Performance Considerations

The cost model has exactly two components: **the slice allocation** and **whatever `append` does inside**.

| Scenario | Allocation? | Notes |
|---|---|---|
| `f()` (zero args) | None | Passed as `nil` slice |
| `f(1,2,3)`, array doesn't escape | None (stack) | Escape analysis wins |
| `f(1,2,3)`, array escapes | 1 heap alloc | Callee stores/returns the slice |
| `f(xs...)` (spread) | None | Reuses caller's backing array |
| `append(dst, src...)` needing growth | 1 heap alloc + copy | `growslice` |

Concrete guidance:

- A hot-path function called millions of times that takes `...T` and whose slice escapes can dominate your allocation profile. `fmt.Sprintf` in a tight loop is a classic offender — the `...any` boxes every argument into an interface (each boxed non-pointer value may itself allocate) *and* the slice may escape.
- **Interface boxing** is the sneaky cost of `...any`: passing an `int` to `...any` allocates an `any` holding that int (small ints 0–255 are cached, but arbitrary ints/structs are not). This is often larger than the slice cost itself.
- Prefer a typed variadic (`...int`) over `...any` when the type is known — no boxing.
- For `append` loops, pre-size with `make([]T, 0, n)` to avoid repeated `growslice` reallocations (O(log n) reallocs, O(n) total copies amortized, but the constant matters).

> [!TIP]
> Verify, don't guess. `go test -bench . -benchmem` reports `allocs/op`. `go build -gcflags='-m -m'` tells you *why* something escaped.

## 9. Best Practices

- **Use a typed variadic, not `...any`, whenever the element type is fixed.** Preserve compile-time safety.
- **Require the minimum with a leading parameter**: `func Max(first int, rest ...int)` beats panicking on empty input.
- **Document aliasing for spread-and-append APIs.** If your function appends to a variadic parameter, say so, or defensively `slices.Clone` it.
- **Defensively cap capacity** with the three-index slice when you must guarantee no caller corruption: `safe := args[:len(args):len(args)]`.
- **Reach for the functional options pattern** for constructors with many optional settings instead of a giant config struct or telescoping constructors.
- **Don't expose a variadic purely to save callers a `[]T{...}`** if it muddies the type signature — sometimes an explicit slice param is clearer.
- **In logging APIs**, validate KV pairs or use typed fields (`zap.String`, `slog.Attr`) over raw `...any`.

## 10. Code Examples

Primary idiomatic example — the functional options pattern, the production-grade reason variadics matter:

```go
package server

import "time"

type Server struct {
	addr    string
	timeout time.Duration
	tls     bool
}

// Option mutates a Server during construction.
type Option func(*Server)

func WithTimeout(d time.Duration) Option { return func(s *Server) { s.timeout = d } }
func WithTLS() Option                    { return func(s *Server) { s.tls = true } }

// New takes a required addr and zero-or-more options. Adding a new
// option later never breaks existing callers — the API stays compatible.
func New(addr string, opts ...Option) *Server {
	s := &Server{addr: addr, timeout: 30 * time.Second} // sane defaults
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// Usage:
//   srv := New(":8080")                       // defaults
//   srv := New(":8080", WithTLS())            // one option
//   srv := New(":8080", WithTLS(), WithTimeout(5*time.Second))
```

Alternative approach — a generic typed variadic helper that demonstrates spreading and safe appending:

```go
package collections

import "slices"

// Merge concatenates groups without corrupting any caller's slice.
// slices.Clone on the first group guarantees a fresh backing array,
// so subsequent appends never write into a shared spare capacity.
func Merge[T any](first []T, rest ...[]T) []T {
	out := slices.Clone(first) // never alias the caller's backing array
	for _, g := range rest {
		out = append(out, g...) // spread each group into append
	}
	return out
}

// Variadic typed constructor — no `any` boxing, full type safety.
func NewSet[T comparable](items ...T) map[T]struct{} {
	set := make(map[T]struct{}, len(items))
	for _, it := range items {
		set[it] = struct{}{}
	}
	return set
}
```

A standalone snippet showing the `nil`-vs-empty distinction that trips up tests:

```go
func variadic(xs ...int) bool { return xs == nil }

func main() {
	fmt.Println(variadic())            // true  — no args -> nil slice
	fmt.Println(variadic([]int{}...))  // false — empty but non-nil
	fmt.Println(variadic(nil...))      // true  — explicit nil slice
}
```

## 11. Advanced Concepts

**Functional options, deep cut.** The pattern's power is *forward compatibility*: a library can add `WithRetries(n int) Option` in v1.3 and every v1.0 caller compiles unchanged. Options can also fail — a richer variant uses `Option func(*Config) error`, letting `New` validate and return an error. gRPC and the AWS SDK both use error-returning option functions.

**Generics + variadics.** Since Go 1.18 you can write `func Of[T any](items ...T) []T`. This is how `slices.Concat[S ~[]E, E any](slices ...S) S` (Go 1.22) is defined — a variadic of slices, generic over both the slice and element type. Combining the two gives type-safe, allocation-aware builders without `any`.

**Variadic interfaces and method sets.** A variadic method satisfies an interface whose method is variadic with the identical shape; `func(...int)` and `func([]int)` are *different* types and do not interchange for interface satisfaction, even though the ABI is the same.

**`append` as the universal variadic.** `append(dst, src...)` is the idiomatic concat. The compiler has a fast path for `append(s, b...)` where both are `[]byte` and even for `append(s, "string"...)` (string-to-byte append). Knowing `append` is "just" a variadic spread demystifies a lot of slice code.

**Reflection.** `reflect.Value.Call` and `CallSlice` distinguish the explicit and spread forms — `CallSlice` treats the final argument as the variadic slice. Frameworks doing dynamic dispatch (RPC servers, dependency injectors like `uber/dig`) rely on this.

## 12. Debugging Tips

- **Suspect an allocation?** Run `go build -gcflags='-m'` and look for `... escapes to heap` or `moved to heap` lines naming your variadic parameter or the synthesized backing array.
- **Confirm with benchmarks:** `go test -bench=. -benchmem`. A jump in `allocs/op` when arguments grow points at the variadic slice (or `any` boxing).
- **Aliasing corruption** (values mysteriously changing): check whether a function spreads a slice and then `append`s to it. Reproduce by building the caller slice with `make([]T, n, n+k)` (spare capacity) and observe the shared writes. Fix with `slices.Clone` or three-index slicing.
- **Wrong output from `fmt`/`log`** (`[1 2 3]` instead of `1 2 3`): you forgot `...` on the spread.
- **`go vet`** catches some variadic misuse, notably `Printf`-family format/argument mismatches (`printf` analyzer). Run it in CI.
- **Delve:** inspect the variadic parameter directly — it shows as a normal slice with `ptr/len/cap`, confirming there's no hidden varargs structure.

## 13. Senior Engineer Notes

As a senior engineer, your judgment calls cluster around *API ergonomics vs. safety* and *review discipline*:

- **In code review, flag every spread-then-append.** Ask: "Could this corrupt the caller?" If the function isn't documented as taking ownership, require a `slices.Clone` or a three-index cap. This is the single most valuable variadic review heuristic.
- **Push back on `...any`** in internal APIs. It's a code smell that often hides a missing type or a should-be-a-struct. Reserve it for genuine print/log/format boundaries.
- **Teach the nil-vs-empty distinction** to your team via a test, not a lecture — it shows up in JSON marshaling, equality checks, and protobuf field presence.
- **Mentor on the options pattern** as the default for any constructor with 3+ optional parameters. Show how it beats both telescoping constructors and a sprawling config struct with zero-value ambiguity.
- **Performance reviews:** in hot paths, you should be able to read a `-benchmem` diff and immediately attribute an allocation to either the variadic slice escaping or interface boxing — and know which `gcflags='-m'` line to check.

## 14. Staff Engineer Notes

At staff level the lens widens to *cross-team API contracts, longevity, and build-vs-buy*:

- **Variadic options as an org-wide API-evolution strategy.** When you own a platform library consumed by dozens of internal teams, `...Option` is the difference between a clean minor-version bump and a coordinated migration that costs the org weeks. Standardize the pattern (option naming, error-returning options, defaulting) in your org's Go style guide so every platform team's constructors look the same.
- **Boundary design: typed fields vs. `...any` in observability.** Choosing `slog`/`zap` typed attributes over `...any` KV across hundreds of services materially affects log-pipeline cost and cardinality. The per-call boxing of `...any` at fleet scale is real CPU and GC pressure — this is a build-vs-buy/standardization decision, not a micro-optimization.
- **ABI and plugin boundaries.** Because variadics are pure compile-time sugar with a normal slice ABI, they're safe across `plugin`/cgo/RPC-generated boundaries in a way C varargs never are. When evaluating codegen tools (gRPC, Connect, Thrift), the fact that generated variadic options stay binary-compatible across regeneration is a quiet but important property.
- **Set the guardrails, not just the rules.** Encode "no spread-then-append without ownership" and "no `...any` outside logging/formatting" as `go vet`/custom-analyzer lint rules in the shared CI base image so the judgment scales beyond the people who attend your review.
- **Know when variadics are the wrong tool.** For stable, well-known parameter sets, an explicit struct or fixed params is clearer and cheaper than a variadic; don't let the options pattern become cargo cult on simple constructors.

## 15. Revision Summary

- A variadic parameter `...T` is, inside the function, exactly a `[]T`.
- Call site `f(a, b)` packs args into a fresh backing array; `f(s...)` spreads — passing the caller's own backing array (aliasing!).
- Must be the **last** parameter; at most one per function.
- Zero-arg call → `nil` slice, **no allocation**. `f([]T{}...)` → non-nil empty slice. Mind the difference.
- Spread + `append` can mutate the caller's data when spare capacity exists; defend with `slices.Clone` or `s[:len(s):len(s)]`.
- Costs: one (possibly stack-elided) slice allocation + `any` interface boxing. Verify with `-benchmem` and `gcflags='-m'`.
- Prefer typed variadics over `...any`; require minimums with a leading param.
- Killer production use: **functional options pattern** (gRPC, zap, AWS SDK) for forward-compatible constructors.
- `append(dst, src...)` is itself a variadic spread; growth triggers `growslice` (double then ~1.25x).

**References:** *Effective Go* (variadic functions, slices, `append`); Go spec (Passing arguments to `...` parameters); Go 1.18 generics & Go 1.22 `slices` package.

---

*Go Engineering Handbook — topic 15.*
