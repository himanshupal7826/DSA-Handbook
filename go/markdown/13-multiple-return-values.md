# 13 · Multiple Return Values

> **In one line:** Go functions return several values at once — most famously the `(result, err)` pair — giving you tuple-like semantics without a tuple type.

---

## 1. Overview

Most languages let a function hand back exactly one value. If you need more, you wrap them in an object, a struct, a tuple, or you mutate out-parameters via pointers. Go takes a different stance: a function can natively return *any number* of values, and the language and tooling are built around that fact.

The single most important consequence is the **`(result, err)` idiom**. Instead of throwing exceptions, Go functions return their normal result *and* an `error` as the last value:

```go
f, err := os.Open("config.yaml")
if err != nil {
    return fmt.Errorf("open config: %w", err)
}
defer f.Close()
```

The second pillar is the **comma-ok idiom**, used by map lookups, type assertions, and channel receives to return a value plus a boolean signalling validity:

```go
v, ok := m["key"]      // ok == false if absent
x, ok := i.(int)       // ok == false if i is not an int
v, ok := <-ch          // ok == false if channel closed and drained
```

These are not "tuples" — Go has no tuple type you can store in a variable. Multiple returns exist only at the *call boundary*: you either bind them to variables, discard them with the **blank identifier** `_`, or forward them straight into another call. This chapter explains how that works under the hood, why it was designed this way, and how senior and staff engineers reason about it in production.

## 2. Why It Exists

Multiple return values are a deliberate language-design choice that solves three problems C and its descendants handled awkwardly.

**1. Error handling without exceptions.** Go's designers (Pike, Thompson, Griesemer) wanted errors to be *values*, visible in the function signature and impossible to silently ignore at the type level. Exceptions create invisible control-flow edges; out-parameters via pointers are easy to forget. A returned `error` is explicit, local, and composable. *Effective Go* states the idiom directly: "multiple return values... is used to indicate an error by returning a value alongside the normal return."

**2. Signalling absence/validity cheaply.** Before generics and `Optional` types, Go needed a way to say "the lookup succeeded *and* here's the zero value vs. it genuinely failed." A map returning `0` for a missing `int` key is ambiguous — the comma-ok boolean disambiguates it without allocating an `Option` wrapper.

**3. Avoiding out-parameters and over-structuring.** In C you write `int parse(const char *s, int *out)`. The output is buried in an argument, mutability is implied, and the caller must pre-allocate. Go inverts this: `func parse(s string) (int, error)`. The signature now *documents* what comes back.

> [!NOTE]
> Multiple returns are *tuple-like* but not *tuples*. You cannot write `t := (1, "a")` and pass `t` around. This intentional limitation keeps the type system simple and pushes you toward named structs when you need a real product type.

## 3. Internal Working

Conceptually a multi-value return is "syntactic sugar," but the implementation is concrete and worth understanding because it affects performance and escape analysis.

**The ABI matters.** Go has two calling conventions in play historically:

- **Pre-1.17 (stack-based ABI0):** *all* arguments and return values were passed on the goroutine stack. The caller reserves a slot for each return value in the stack frame; the callee writes into those slots before `RET`. Multiple returns were simply multiple adjacent stack slots — no struct, no heap.
- **Go 1.17+ (register-based ABI, `ABIInternal`):** on amd64, arm64, and others, the first several integer/pointer results go in registers (e.g. `AX, BX, CX, ...` on amd64), with the stack used only for spillover. A `(int, error)` return typically uses a couple of registers — *zero memory traffic*.

So a multi-value return is **not** a hidden allocation. There is no anonymous struct on the heap. The values live in registers and/or the caller's frame.

```text
  func div(a, b int) (int, error)

  Stack-based ABI0 (pre-1.17):           Register ABI (1.17+):

  caller frame                            registers
  +--------------------+                  +---------+
  | arg a              |                  | AX = a  |  inputs
  | arg b              |                  | BX = b  |
  | ret0 (int result)  | <- callee        +---------+
  | ret1 (error iface) |    writes here       |   call
  +--------------------+                       v
        ^                                  +-----------------+
        | callee writes results,           | AX = result int |
        | RET, caller reads slots          | BX = err.tab    | error = (type, data)
                                           | CX = err.data   |
                                           +-----------------+
```

**The `error` value itself** is an interface — a two-word `(itab, data)` pair (16 bytes on 64-bit). So `return 0, err` puts the int in one register and the interface's two words in two more. A `nil` error is two zero words; checking `err != nil` is comparing those words to zero. This is why the happy path is essentially free.

**Comma-ok is compiler-generated, not a real second return.** When you write `v, ok := m[k]`, the compiler emits a call to a runtime function like `runtime.mapaccess2`, whose signature returns *two* values: a pointer to the element and a boolean. The single-value form `v := m[k]` calls `mapaccess1`. The compiler picks the runtime helper based on the assignment arity. The same trick backs type assertions (`typeAssert`) and channel receives (`chanrecv` returns a `received bool`).

**Named return values** become pre-declared local variables in the callee's frame, zero-initialized. A bare `return` reads whatever they currently hold. This is implemented as ordinary locals, which is also why a `defer` can mutate them.

## 4. Syntax

Declaring multiple returns — parenthesize the result types:

```go
func minmax(xs []int) (int, int) {
    lo, hi := xs[0], xs[0]
    for _, x := range xs[1:] {
        if x < lo {
            lo = x
        }
        if x > hi {
            hi = x
        }
    }
    return lo, hi
}
```

Named return values (useful for documentation and `defer`-based mutation):

```go
func split(sum int) (x, y int) {
    x = sum * 4 / 9
    y = sum - x
    return // bare return: returns current x, y
}
```

Consuming the values — bind, discard with `_`, or forward:

```go
lo, hi := minmax(nums)         // bind both
_, hi = minmax(nums)           // discard the first via blank identifier
fmt.Println(minmax(nums))      // forward all returns into a variadic call
```

> [!TIP]
> A multi-value call can be passed directly as the *sole* argument set to another function: `fmt.Println(minmax(nums))` works, but `f(minmax(nums), 7)` does **not** — you cannot mix a spread multi-return with other arguments.

## 5. Common Interview Questions

**Q1. Why does Go return errors instead of throwing exceptions?**
Errors are values: explicit in the signature, checkable locally, and composable with `fmt.Errorf("...: %w", err)`. It avoids invisible control flow. *Follow-up: when DOES Go use exception-like flow?* `panic`/`recover` — reserved for truly unrecoverable conditions or crossing API boundaries (e.g. a parser converting panics to errors at its edge), not for ordinary errors.

**Q2. What is the comma-ok idiom and where does it appear?**
A two-value form returning `(value, bool)` to disambiguate "present/valid" from "zero value." Appears in map access, type assertions, and channel receives. *Follow-up: what happens if you use the single-value type assertion `x := i.(int)` and `i` is not an int?* It **panics**. The two-value form `x, ok := i.(int)` never panics; `ok` is false.

**Q3. Does returning multiple values allocate?**
No. Results pass in registers (Go 1.17+) or on the caller's stack frame — no hidden struct, no heap. *Follow-up: when could a returned value escape to the heap?* When the callee returns a pointer to a local, or stores it where the compiler can't prove it stays on the stack — escape analysis, independent of arity.

**Q4. What's the difference between named and unnamed return values?**
Named returns pre-declare zero-valued locals, enable bare `return`, and let a `defer` modify them. Unnamed are positional only. *Follow-up: name a real bug named returns cause.* Shadowing — `if x, err := f(); err != nil` declares a new `err` inside the `if`, leaving the named `err` untouched, so a deferred cleanup that inspects the named `err` sees the wrong value.

**Q5. How do you ignore one of several return values?**
The blank identifier `_`, e.g. `_, err := f()`. It discards the value without declaring a variable, satisfying "declared and not used." *Follow-up: does `_ = f()` evaluate `f`?* Yes — assignment to `_` still calls the function and runs its side effects; only the value is dropped.

**Q6. Can you store the result of a multi-return in a single variable?**
No — Go has no tuple type. You must bind to N variables, discard with `_`, or use a struct. *Follow-up: how would you return a "tuple" you can pass around?* Define a named struct: `type Pair struct{ Lo, Hi int }`.

**Q7. Where should `error` go in the return list, and why?**
Always **last**, by convention, so readers instantly find it and tooling (linters, `errcheck`) can rely on the position. *Follow-up: should you ever return a non-nil result with a non-nil error?* Usually no — return the zero result on error. Exceptions exist (`io.Reader.Read` returns `n > 0` alongside `io.EOF`), so document them loudly.

## 6. Production Use Cases

- **Standard library, everywhere.** `os.Open`, `strconv.Atoi`, `json.Marshal`, `net.Dial`, `sql.DB.Query` — virtually every fallible operation returns `(T, error)`. This uniformity is why Go codebases read consistently across teams.
- **Database access (`database/sql`, `pgx`, `sqlx`).** `row.Scan(&id, &name)` plus `(sql.Result, error)` on writes. `pgx`'s `QueryRow(...).Scan(...)` returns `pgx.ErrNoRows` you branch on.
- **gRPC and protobuf-generated clients.** Every RPC method is generated as `func (c *Client) Method(ctx, *Req, ...opts) (*Resp, error)` — the `(result, err)` shape is baked into the codegen used at Google, Uber, and across the CNCF ecosystem (etcd, Kubernetes).
- **Kubernetes controllers.** Client-go's informers and `Reconcile(ctx, req) (ctrl.Result, error)` in controller-runtime: the returned `Result` carries requeue timing, the error triggers backoff.
- **Concurrency primitives.** `value, ok := <-ch` is the canonical way to detect a closed channel in worker pools and fan-in/fan-out pipelines.
- **Caching layers.** `val, hit := cache.Get(key)` (e.g. patterns over `groupcache`, Ristretto-style caches) uses comma-ok to distinguish a cache miss from a stored zero value.

## 7. Common Mistakes

> [!WARNING]
> **Ignoring the error.** `data, _ := os.ReadFile(p)` silently swallows failures and proceeds with `nil` data. Use `errcheck`/`golangci-lint` to catch this in CI.

- **Using the single-value type assertion on untrusted interfaces** — `s := v.(string)` panics if the dynamic type differs. Prefer `s, ok := v.(string)`.
- **Treating a comma-ok zero value as "absent" without checking `ok`** — `v := m[k]; if v == 0 { ... }` cannot tell a missing key from a stored `0`.
- **Shadowing named returns with `:=`** inside an `if`/`for`, so deferred cleanup sees stale values (see Q4 follow-up).
- **Returning a partially-populated result alongside an error** without documenting it, leading callers to use garbage data.
- **Over-using named returns**, especially with bare `return` in long functions — it hurts readability and invites bugs.

## 8. Performance Considerations

Multiple returns are **cheap by design**. On Go 1.17+ the register ABI passes the common `(int, error)` or `(*T, error)` shapes entirely in CPU registers, so the call costs the same as a single return plus comparing two words for the `error`.

Where cost can creep in:

| Concern | Reality |
|---|---|
| Hidden struct allocation for N returns | None — registers/stack, no heap. |
| `error` interface boxing | A concrete error value boxed into the `error` interface may allocate *if the value escapes*; sentinel errors (`io.EOF`) are pre-allocated, so returning them is free. |
| Returning large structs by value | Copies the whole struct into the result slots; for big structs return a `*T` instead. |
| Many return values (5+) | Spillover beyond available registers goes to the stack — measurable only in hot loops. |

> [!TIP]
> Don't return `*int` just to "avoid copying" a single int — the pointer forces a heap escape and a dereference, which is *slower* and adds GC pressure. Return the value.

Benchmark with `go test -bench . -benchmem` and inspect escapes via `go build -gcflags='-m'` before optimizing — arity is almost never your bottleneck.

## 9. Best Practices

- **Put `error` last, always.** It is the strongest convention in the language.
- **Return the zero value with a non-nil error.** Callers should not have to reason about half-valid results.
- **Wrap errors with context** as they cross layers: `fmt.Errorf("load user %d: %w", id, err)`; keep `%w` for unwrap-ability.
- **Use comma-ok, not zero-value sniffing**, for maps, assertions, and channels.
- **Discard intentionally with `_`** and add a comment if dropping an error is genuinely safe (e.g. `_ = conn.Close() // best-effort`).
- **Prefer named returns sparingly** — for documentation of which value is which, or when a `defer` must set the error; avoid bare returns in long functions.
- **Promote to a struct** once you return 3+ logically-related values or the same group repeatedly.

## 10. Code Examples

Primary idiomatic example — the `(result, err)` idiom with wrapping, comma-ok, and the blank identifier together:

```go
package main

import (
	"errors"
	"fmt"
	"strconv"
)

var ErrEmpty = errors.New("empty input")

// parsePort returns the parsed port and an error (last position).
func parsePort(s string) (int, error) {
	if s == "" {
		return 0, ErrEmpty // zero result + non-nil error
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0, fmt.Errorf("parse port %q: %w", s, err) // wrap with context
	}
	return n, nil
}

func main() {
	cfg := map[string]string{"port": "8080"}

	raw, ok := cfg["port"] // comma-ok: distinguishes missing from ""
	if !ok {
		raw = "80"
	}

	port, err := parsePort(raw)
	if err != nil {
		if errors.Is(err, ErrEmpty) {
			fmt.Println("port was empty, using default")
		}
		return
	}

	_ = err // blank identifier discards intentionally
	fmt.Println("listening on", port)
}
```

Alternative — when several related values belong together, return a *named struct* instead of a long return list (these two blocks render as switchable tabs):

```go
package main

import "fmt"

// Instead of: func stats(xs []int) (min, max, sum, count int)
type Stats struct {
	Min, Max, Sum, Count int
}

func stats(xs []int) (Stats, error) {
	if len(xs) == 0 {
		return Stats{}, fmt.Errorf("stats: empty slice")
	}
	s := Stats{Min: xs[0], Max: xs[0]}
	for _, x := range xs {
		if x < s.Min {
			s.Min = x
		}
		if x > s.Max {
			s.Max = x
		}
		s.Sum += x
		s.Count++
	}
	return s, nil
}

func main() {
	s, err := stats([]int{3, 1, 4, 1, 5})
	if err != nil {
		fmt.Println("error:", err)
		return
	}
	fmt.Printf("%+v\n", s) // {Min:1 Max:5 Sum:14 Count:5}
}
```

A standalone snippet showing the three comma-ok forms side by side:

```go
v, ok := m["k"]   // map: ok=false if key absent
i, ok := x.(int)  // type assertion: ok=false if wrong dynamic type
d, ok := <-ch     // channel: ok=false if closed and drained
```

## 11. Advanced Concepts

**`defer` + named returns to mutate the error.** A deferred closure can inspect and rewrite the named return value — the canonical pattern for translating panics into errors at an API boundary:

```go
func safeParse(b []byte) (out Doc, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("parse panicked: %v", r)
		}
	}()
	return parse(b), nil // if parse panics, defer sets err
}
```

**Comma-ok is not assignable to a single var.** `x := (v, ok)` is illegal — the multi-value only exists transiently. You cannot capture both into one value without a struct.

**Forwarding multi-returns.** `return f()` where `f`'s signature matches the caller's results compiles and is a clean way to thread errors up; but `return f(), g()` requires each to be single-valued.

**Generics don't add tuples.** Even with Go 1.18+ generics there is still no tuple type; the idiomatic generic helper returns `(T, error)` or `(T, bool)`. People sometimes build a generic `Pair[A, B]` struct, but it's rarely worth fighting the standard idiom.

**Iterator functions (Go 1.23 `range-over-func`).** The new `iter.Seq2[K, V]` yields *pairs* per iteration — a tuple-flavored API: `for k, v := range seq { ... }`. Under the hood the yield function takes two arguments, echoing the comma-ok shape.

## 12. Debugging Tips

- **Catch ignored errors:** run `golangci-lint run` with `errcheck` enabled, or `staticcheck`. It flags every `_` that hides an `error` and every unchecked call.
- **`go vet`** catches some assertion and printf mismatches; pair it with `staticcheck`'s `SA4006`/`SA9003` for dead assignments to `_`.
- **Inspect ABI/escapes:** `go build -gcflags='-m -m'` shows whether a returned pointer escapes; `go tool objdump -s 'funcname' binary` reveals which registers carry the results on 1.17+.
- **Shadowing bugs:** turn on `golangci-lint`'s `govet` `shadow` check (or `go vet -vettool=$(which shadow)`) when a deferred error handler sees the wrong value.
- **Map/assertion panics:** a runtime panic `interface conversion: ... is not ...` means a single-value type assertion failed — switch to comma-ok.
- **Use `errors.Is` / `errors.As`** in a debugger or test to confirm the wrapped chain matches the sentinel you expect.

## 13. Senior Engineer Notes

A senior engineer treats the return signature as the function's *contract* and reviews it accordingly:

- **Enforce `error`-last and zero-on-error** in code review; reject "result valid alongside error" unless explicitly documented like `Read`.
- **Push back on `*int`/`*bool` returns** that exist only to dodge a copy — they leak nil-handling onto callers and cause heap escapes. Mentor juniors on value semantics.
- **Watch for shadowing** in `if err := ...; err != nil` blocks when a named return + `defer` is in play. This is one of the highest-signal bugs to catch in review.
- **Demand error wrapping with `%w`** at layer boundaries so `errors.Is/As` works end-to-end; ban `fmt.Errorf("...%v", err)` where unwrapping is needed.
- **Know when to collapse returns into a struct:** if you see the same `(a, b, c, error)` group threaded through five functions, that's a missing domain type. Make the struct; name the fields.
- **Decide comma-ok vs error:** comma-ok for "absence is normal and expected" (cache miss, optional config); `error` for "this should have worked but didn't."

## 14. Staff Engineer Notes

A staff engineer governs these idioms at the org and architecture level:

- **Standardize error contracts cross-team.** Decide org-wide whether services return wrapped errors, gRPC `status.Status` codes, or domain error types — and codify it in shared linters and a `pkg/errors` module so dozens of teams behave identically. Inconsistent error shapes are a recurring source of cross-service incident toil.
- **API/ABI evolution.** Adding a return value is a *breaking change* to every caller. Staff engineers steer teams toward returning an extensible struct (`(Result, error)`) for public APIs so fields can be added without breaking signatures — a concrete build-for-evolution trade-off.
- **Build-vs-buy on error tooling.** Choose between stdlib `errors` + `errors.Join` (Go 1.20+), or a heavier library; weigh stack-trace capture cost vs. observability value across the whole codebase.
- **Performance at fleet scale.** The register ABI made multi-return effectively free, but staff engineers still review hot-path signatures returning large structs by value (copy cost x billions of calls) and mandate `*T` there — a measured, not cargo-culted, decision.
- **Boundary discipline.** Define where panics get converted to errors (library edges, RPC handlers) so a single goroutine panic can't take down a shared process — an availability/architecture concern, not a syntax one.
- **Teach the philosophy, not the keystrokes.** The `(result, err)` convention is *culture*; staff engineers protect it because uniformity is what lets engineers move between services without relearning error handling.

## 15. Revision Summary

- Go functions return any number of values; results pass in **registers (1.17+)** or on the stack — **no hidden heap allocation**.
- The **`(result, err)`** idiom makes errors explicit values; `error` goes **last**, return **zero value on error**, wrap with **`%w`**.
- **Comma-ok** `(value, bool)` disambiguates presence/validity in **maps, type assertions, channel receives** — compiler picks `mapaccess2` etc.
- **No tuple type:** bind to N vars, discard with **blank identifier `_`**, forward into another call, or promote to a **named struct**.
- **Named returns** enable bare `return` and `defer`-based error mutation, but invite **shadowing** bugs.
- Single-value type assertion **panics** on mismatch; comma-ok form never does.
- Use linters (`errcheck`, `staticcheck`, `govet shadow`) to catch ignored errors and shadowing.
- Senior: enforce contracts, value semantics, struct promotion. Staff: org-wide error standards, evolvable API shapes, fleet-scale copy costs.

**References:** *Effective Go* (Multiple return values, Named result parameters, The blank identifier); Go spec — Calls, Assignments, Type assertions; Go 1.17 release notes (register-based calling convention); `errors` package docs (`Is`, `As`, `Join`).

---

*Go Engineering Handbook — topic 13.*
