# 11 · Control Flow

> **In one line:** Go's control flow is deliberately minimal — `if`, a single unified `for`, a powerful `switch`, plus the rarely-needed escape hatches `label`, `goto`, and `fallthrough`.

---

## 1. Overview

Control flow is how a program decides *what runs next*. Go made an opinionated bet here: instead of giving you `while`, `do-while`, `for`, the ternary `?:`, and three flavors of loop, it ships **exactly one loop keyword (`for`)**, one conditional (`if`), and one multi-way branch (`switch`). On top of that sit three low-level tools — labeled statements, `goto`, and `fallthrough` — that exist for the rare cases where structured control flow gets in your way.

The design goal is *readability under maintenance*. There is one obvious way to write a loop, so when you read someone else's Go you are never decoding which of five loop forms they chose. This chapter covers the mechanics, how the compiler lowers them, and — in the zariya.in spirit — how these constructs actually behave in production hot paths and what interviewers probe.

## 2. Why It Exists

Every language needs branching and iteration; the interesting question is *why Go's flavor looks the way it does*.

- **One loop to rule them all.** C-family languages have `for`, `while`, and `do-while`. Go folds all three into `for` by making each clause optional. This eliminates a category of "which loop should I use" bikeshedding and shrinks the spec.
- **No ternary operator.** `a ? b : c` is famously abusable when nested. Go forces an `if/else`, trading three characters for guaranteed readability.
- **`switch` without fall-through by default.** C's implicit fall-through (forgetting `break`) is a classic bug source. Go inverts the default: each `case` breaks automatically, and you opt *into* fall-through with the explicit `fallthrough` keyword.
- **`goto` survives, but caged.** Go keeps `goto` for generated code and tight state machines, but the compiler forbids jumps that skip variable declarations or jump into a block — removing `goto`'s worst footguns.

The throughline: Go removes *choices* that don't pay for themselves, and removes *defaults* that cause silent bugs.

## 3. Internal Working

Control flow keywords are syntactic sugar over the compiler's internal **control flow graph (CFG)** of basic blocks connected by jumps. Understanding the lowering demystifies performance.

When `gc` (the standard compiler) parses your function, it builds an AST, then lowers it to an **SSA** (Static Single Assignment) intermediate representation. At the SSA level there are no `for` or `switch` keywords — only *basic blocks* ending in control instructions: `If`, `Plain` (unconditional jump), `Ret`, etc.

A `for` loop becomes three blocks: a *condition* block, a *body* block, and an *exit* block, wired with conditional and unconditional branches.

```text
        ┌──────────────┐
        │   init (i=0) │
        └──────┬───────┘
               ▼
        ┌──────────────┐   cond false
   ┌───▶│  cond block  │──────────────┐
   │    │   i < n ?    │              │
   │    └──────┬───────┘              ▼
   │           │ true          ┌────────────┐
   │           ▼               │ exit block │
   │    ┌──────────────┐       └────────────┘
   │    │  body block  │
   │    └──────┬───────┘
   │           ▼
   │    ┌──────────────┐
   └────│  post (i++)  │
        └──────────────┘
```

Key runtime facts:

- **`switch` lowering is adaptive.** A `switch` on integers with dense case values can be compiled to a **jump table** (O(1) indirect branch). Sparse or string switches become a **binary search** or a chain of comparisons. The compiler chooses; you don't control it directly. Since Go 1.19+ the compiler emits jump tables for suitable integer switches, which is why a 200-case `switch` can be faster than an `if/else` ladder.
- **No bounds magic.** A range `for` over a slice compiles to ordinary index arithmetic; the runtime does not allocate an iterator object (unlike, say, Java). Range over a channel compiles to repeated receive operations; range over a map uses the runtime's `mapiterinit`/`mapiternext` with a randomized start bucket (the source of map iteration randomness).
- **`goto` and labels** simply name a basic block so a branch can target it. The compiler validates at compile time that the jump does not skip an in-scope variable declaration.
- **`fallthrough`** removes the implicit `Plain` jump-to-exit that `switch` normally inserts after a case body, instead jumping to the *next* case's body (skipping its condition check entirely).

## 4. Syntax

```go
// if — with optional init statement (scoped to the if/else)
if v, err := doThing(); err != nil {
	return err
} else if v > 10 {
	// v and err visible in else too
}

// for — four forms, one keyword
for i := 0; i < n; i++ { }        // classic three-clause
for cond { }                       // "while"
for { break }                      // infinite loop
for i, v := range items { _ = v }  // range

// switch — no implicit fallthrough; cases can be expressions
switch {
case x > 0:
	// like an if/else-if chain
case x < 0:
default:
}

switch tag := f(); tag {
case 1, 2, 3:       // multiple values per case
	fallthrough     // explicitly continue into next case body
case 4:
}

// type switch
switch v := any(val).(type) {
case int:
	_ = v // v is int here
case string:
	_ = v // v is string here
}

// labels with break/continue/goto
Outer:
	for i := range rows {
		for j := range cols {
			if done {
				break Outer    // break the OUTER loop
			}
			continue Outer     // skip to next i
		}
	}

retry:
	if !ok {
		goto retry
	}
```

## 5. Common Interview Questions

**Q1. Why does Go have only `for` and no `while`?**
*Answer:* `for` subsumes `while` by making its clauses optional: `for cond {}` is a while loop. Fewer keywords, one idiom, smaller spec. **Follow-up: write an infinite loop.** `for {}` — no clauses at all.

**Q2. What's the default behavior of a `switch` case, and how do you fall through?**
*Answer:* Each case `break`s implicitly after its body. Use the `fallthrough` keyword as the last statement of a case to execute the next case's body — *without* evaluating that case's condition. **Follow-up: can `fallthrough` be conditional?** No — it must be the final statement of the case block; you can't write `if x { fallthrough }`.

**Q3. What does `break` do inside a `switch` nested in a `for`?**
*Answer:* It breaks the nearest enclosing `for`, `switch`, or `select` — which is the `switch`, not the loop. To break the loop, label the `for` and `break Label`. **Follow-up: same for `continue`?** `continue` only applies to loops, so `continue` inside a switch-in-loop targets the loop directly; no label needed unless loops are nested.

**Q4. Is map iteration order guaranteed in `for ... range m`?**
*Answer:* No. The runtime deliberately randomizes the starting bucket on each range to prevent code from depending on order. For deterministic output, collect keys into a slice and `sort` them. **Follow-up: why was randomization added?** To surface latent ordering bugs early instead of in production when the hash seed changes.

**Q5. What is the loop-variable scoping change in Go 1.22?**
*Answer:* Before 1.22 the loop variable was *shared* across iterations, so closures/goroutines capturing it saw the final value — a notorious bug. Since Go 1.22 each iteration gets a **fresh copy** of the loop variable. **Follow-up: how did people work around it pre-1.22?** `i := i` shadowing inside the loop body.

**Q6. When would you legitimately use `goto`?**
*Answer:* Cleanup/error-unwind chains in low-level code, and machine-generated parsers/state machines. Idiomatic application code almost never needs it. **Follow-up: what does the compiler forbid?** Jumping over a variable declaration that's in scope at the label, or jumping into a block from outside.

**Q7. How is a large integer `switch` compiled — and does that affect performance?**
*Answer:* The compiler may emit a jump table (O(1)) for dense integer cases, or binary search for sparse ones, so a big `switch` can beat an `if/else` ladder. **Follow-up: does this apply to string switches?** Strings use length-then-comparison / binary-search strategies, not jump tables.

**Q8. Does `range` over a slice copy the elements?**
*Answer:* The value variable (`v` in `for i, v := range s`) is a *copy* of each element. Mutating `v` does not change the slice; index via `s[i]` to mutate. **Follow-up: cost of ranging a `[]LargeStruct`?** Each iteration copies the struct; use `range s` with index, or a pointer slice, to avoid copies in hot paths.

## 6. Production Use Cases

- **Type switches in encoding libraries.** `encoding/json`, `database/sql`, and protobuf runtimes lean heavily on `switch v := x.(type)` to dispatch on dynamic types when (un)marshaling. The standard library's `fmt` package is essentially a giant type switch.
- **Labeled `break` in worker pools / request fan-out.** Kubernetes and Docker code use `Loop:` labels to break out of `select`-inside-`for` event loops cleanly on shutdown signals.
- **Jump-table switches in interpreters/VMs.** The Go runtime's own scheduler, and projects like the `expr` and `cel-go` expression evaluators, use a large integer `switch` over opcodes — exactly the case the jump-table optimization targets.
- **`for range` over channels in pipelines.** The classic Go concurrency pattern (Rob Pike's pipelines, used throughout gRPC-Go stream handling) drains a channel with `for msg := range ch`.
- **`goto` in generated code.** `goyacc`, ragel-generated lexers, and parts of `cgo`-generated glue emit `goto`-based state machines because they map directly onto a CFG.

## 7. Common Mistakes

> [!WARNING]
> The single most common bug historically: capturing a loop variable in a closure/goroutine. Fixed by default in **Go 1.22+**, but you'll still see it in older codebases and must recognize it.

```go
// Pre-1.22 BUG: all goroutines may print the same (last) value.
for _, v := range items {
	go func() { fmt.Println(v) }() // v shared before 1.22
}
// Pre-1.22 fix: v := v  inside the loop.
```

Other frequent errors:

- **Expecting `break` to exit the loop from inside a `switch`/`select`.** It breaks the switch. Use a label.
- **Relying on map range order** — flaky tests that pass locally and fail in CI.
- **Forgetting `default` in a type switch**, letting unexpected types fall silently through.
- **Infinite `for {}` with no exit** when a `select` blocks forever (deadlock) — always have a cancellation path.
- **Mutating the range copy** (`v.Field = x`) and wondering why the slice is unchanged.

## 8. Performance Considerations

- **`switch` vs `if/else` ladder:** For more than ~5 dense integer cases, `switch` often wins via jump tables. For 2-3 cases the difference is noise. Don't micro-optimize without a benchmark.
- **Range copies:** `for _, v := range bigStructs` copies each element. On a slice of, say, 64-byte structs iterated millions of times, switching to `for i := range bigStructs { p := &bigStructs[i] }` can cut both time and `memmove` pressure measurably.
- **Bounds-check elimination (BCE):** Iterating with `for i := range s` and indexing `s[i]` lets the compiler prove `i` is in range and *remove* the bounds check. Hand-rolled index math sometimes defeats BCE — check with `go build -gcflags="-d=ssa/check_bce/debug=1"`.
- **`continue`/`break` are free** — they're just jumps, no overhead.
- **Type switches** cost an interface type comparison per case until a match; ordering hot cases first can help marginally, but the compiler may reorder anyway.

> [!TIP]
> Always benchmark control-flow "optimizations" with `testing.B`. The compiler's choices (jump table vs branch) are version-dependent; what's faster on Go 1.21 may differ on 1.23.

## 9. Best Practices

- **Prefer `switch` over long `if/else if` chains** for readability and potential jump-table speedups.
- **Use `if` with init statements** to scope error variables tightly: `if err := f(); err != nil`.
- **Keep the happy path un-indented.** Return early on errors rather than nesting (`if err != nil { return }` then continue at the outer level).
- **Label loops only when needed**, and name labels meaningfully (`ScanLoop:` not `L1:`).
- **Avoid `goto`** in application code. If you reach for it, ask whether a helper function or a `for` with `break` is clearer.
- **For deterministic map iteration**, sort keys explicitly.
- **Use `fallthrough` sparingly** and comment *why*, since it surprises readers.

## 10. Code Examples

Primary idiomatic example — a small command dispatcher using a clean `switch`, labeled loop, and early returns. The first tab is the idiomatic version; the second tab shows the `if/else` ladder it replaces.

```go
package main

import (
	"errors"
	"fmt"
)

func dispatch(cmds []string) error {
	const maxSteps = 100
	steps := 0

Loop:
	for _, c := range cmds {
		if steps++; steps > maxSteps {
			return errors.New("step budget exceeded")
		}
		switch c {
		case "noop":
			// breaks the switch implicitly; loop continues
		case "skip":
			continue Loop
		case "stop":
			break Loop
		case "warn", "alert": // multiple values
			fmt.Println("notify:", c)
		default:
			return fmt.Errorf("unknown command %q", c)
		}
	}
	return nil
}

func main() {
	fmt.Println(dispatch([]string{"warn", "skip", "noop", "stop", "warn"}))
}
```

```go
package main

import (
	"errors"
	"fmt"
)

// Same logic written as an if/else ladder — works, but noisier and
// harder to extend than the switch above.
func dispatch(cmds []string) error {
	steps := 0
	for _, c := range cmds {
		steps++
		if steps > 100 {
			return errors.New("step budget exceeded")
		}
		if c == "noop" {
			// nothing
		} else if c == "skip" {
			continue
		} else if c == "stop" {
			break
		} else if c == "warn" || c == "alert" {
			fmt.Println("notify:", c)
		} else {
			return fmt.Errorf("unknown command %q", c)
		}
	}
	return nil
}

func main() { _ = dispatch }
```

A standalone type-switch example — the workhorse pattern in serialization code:

```go
func describe(x any) string {
	switch v := x.(type) {
	case nil:
		return "nil"
	case int, int64:
		return fmt.Sprintf("integer %v", v)
	case string:
		return fmt.Sprintf("string of len %d", len(v))
	case error:
		return "error: " + v.Error()
	default:
		return fmt.Sprintf("unhandled %T", v)
	}
}
```

## 11. Advanced Concepts

- **`switch true` / expression-less switch.** `switch { case cond1: ...; case cond2: ... }` is the idiomatic replacement for an `if/else if` ladder and reads cleaner. Note that in a type switch, `case int, string:` keeps `v` as the *interface type* (since it can't be both); only single-type cases give you the concrete type.
- **`select` is control flow too.** Though covered under concurrency, `select` is the channel analog of `switch` — it picks a ready communication, with `default` for the non-blocking case. The same labeled-`break` rules apply.
- **`fallthrough` semantics.** It transfers to the *first statement of the next case body* and **does not re-check** that case's condition. This is why `fallthrough` into a type-switch case is forbidden — there's no meaningful "next type" to bind.
- **Go 1.22 range-over-int and 1.23 range-over-func.** `for i := range 10 {}` iterates 0..9. Go 1.23 added *range over functions* (iterators): `for v := range seq {}` where `seq` is a `func(yield func(V) bool)`. This is control flow generalized — the iterator function *drives* the loop body via the `yield` callback, and a `break` in the loop makes `yield` return `false`.
- **Compiler control of `switch`.** Inspect lowering with `go build -gcflags="-S"` (assembly) — you can literally see a jump table (`JMP (table)(reg)`) emerge for a dense integer switch.

## 12. Debugging Tips

- **Loop-variable capture** (pre-1.22): if goroutines/closures all see the last value, that's the bug. Reproduce with `-race`; fix with `v := v` or upgrade to 1.22+.
- **Flaky map-order tests:** run `go test -count=10`; if results vary, you depend on iteration order. Sort keys.
- **Unexpected switch path:** add a `default:` that `panic`s or logs the unhandled value during development — far better than a silent no-op.
- **Verify BCE:** `go build -gcflags="-d=ssa/check_bce/debug=1"` prints which bounds checks survived; refactor the loop to help the compiler eliminate them.
- **See the jump table:** `go tool compile -S file.go | grep -i jmp` to confirm a switch lowered to a table vs a comparison chain.
- **Stuck `for{}`/`select{}`:** send `SIGQUIT` (Ctrl-\) to dump all goroutine stacks and find the blocked one.

## 13. Senior Engineer Notes

A senior engineer treats control flow as a *readability lever*, not just correctness. In code review, I push back on deeply nested `if`s — the fix is almost always early returns and an expression-less `switch`. I flag every `fallthrough` and every `goto` and ask the author to justify it in a comment; the bar is high.

I mentor juniors specifically on the loop-variable-capture trap (and now teach them *why* Go 1.22 changed it — so they understand the older code they'll inherit). I insist on sorted keys for any map iteration whose output is user-visible or compared in tests, because "works on my machine" map-order bugs are a recurring on-call annoyance.

On performance, my rule is: don't convert `if/else` to `switch` *for speed* without a benchmark — convert it for *clarity*. The speed is a bonus the compiler may or may not deliver this release. I make sure hot-loop reviews check for accidental large-struct range copies, which are an easy, high-ROI win.

## 14. Staff Engineer Notes

At staff level the concern shifts from individual loops to *how control-flow conventions scale across an org*. I'd codify in the org Go style guide: no `goto` in hand-written code (allow it only in vendored/generated code), mandatory `default` in type switches, and a lint rule (`gocritic`, `revive`) enforcing both. Consistency here reduces the cognitive cost of moving engineers between teams.

For **build-vs-buy on dispatch logic**: when a service grows a 300-case opcode `switch`, the staff question is whether to keep the compiler's jump table (fast, zero-dependency, but rigid) or move to a registry/handler-map pattern (pluggable, testable in isolation, but loses the jump-table speed and adds map-lookup + interface dispatch). I'd benchmark both; for latency-critical paths the native `switch` usually wins, and the maintainability argument rarely justifies the regression.

Cross-team, I watch for control-flow patterns that leak into API design — e.g., exporting an `enum`-like int and forcing every consumer to write the same `switch`. That's a signal to provide a method on the type instead, centralizing the branch. And when adopting Go 1.23 range-over-func iterators across an org, I'd stage it: they're powerful for library authors but can obscure control flow for the average reader, so I'd gate their use to library boundaries, not application glue.

## 15. Revision Summary

- **One loop:** `for` covers classic, while-style, infinite, and range forms.
- **`if`** supports an init statement scoped to the if/else.
- **`switch`** breaks by default; `fallthrough` opts into the next case body *without* re-checking its condition; expression-less `switch` replaces if-ladders.
- **`break`/`continue` inside a switch/select** affect the switch, not the loop — use **labels** to target an outer loop.
- **Map range order is randomized**; sort keys for determinism.
- **Go 1.22:** fresh loop variable per iteration (fixes capture bug); `range int`. **Go 1.23:** range-over-func iterators.
- **`switch`** may compile to a jump table (dense ints) or binary search (sparse/strings) — can beat an if-ladder.
- **`goto`** is allowed but caged (no skipping declarations); reserve for generated code/state machines.
- **Range value is a copy** — index `s[i]` to mutate or to avoid large-struct copies.

**References:** A Tour of Go (Flow control statements: for, if, switch, defer); The Go Programming Language Specification (For statements, Switch statements, Goto, Fallthrough); Go 1.22 & 1.23 release notes.

---

*Go Engineering Handbook — topic 11.*
