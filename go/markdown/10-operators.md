# 10 · Operators

> **In one line:** Go's operators are a small, deliberately unsurprising set — arithmetic, comparison, logical, and bitwise — with fixed precedence, no operator overloading, and a few sharp edges around integer division, shifts, and untyped constants.

---

## 1. Overview

Operators are the symbols that combine operands into expressions: `+`, `-`, `*`, `/`, `%`, the comparison set `== != < <= > >=`, the logical `&& || !`, and the bitwise family `& | ^ &^ << >>`. Go also has assignment forms (`+=`, `<<=`, `&^=`, …), the address/pointer pair `& *`, the channel operator `<-`, and the post-statements `++` / `--`.

The defining trait of Go's operator design is *restraint*. There is **no operator overloading**: `+` means numeric addition or string concatenation and nothing user-definable. There is no ternary `?:`. There is no comma operator. `++` and `--` are statements, not expressions, so you cannot write `b = a++`. This minimalism is not an oversight — it is a load-bearing language decision aimed at readability and predictability across large teams.

This chapter covers the full operator surface, how the compiler lowers them, the precedence table you must internalize, the bitwise patterns that show up in real systems (flags, masks, packed structs), and the subtle traps (signed shift, `%` sign, overflow wraparound) that produce production bugs and interview rejections.

## 2. Why It Exists

Every language needs to express computation, but the *shape* of the operator set encodes a philosophy. Go's authors came from C and from large-codebase pain at Google. Two design pressures shaped the operators:

- **Readability at scale.** Code is read far more than written. Operator overloading lets `a + b` hide a database call, a matrix multiply, or a network round-trip. In a million-line monorepo with thousands of engineers, that ambiguity is expensive. Go forbids it so that `a + b` is *always* a cheap, obvious numeric or string operation.
- **One way to do things.** A ternary operator and an `if` are redundant; Go keeps the `if`. `++` as a statement removes the `i = i++` undefined-behavior class of bugs that plague C.

The bitwise operators exist because Go is a *systems* language: it writes network protocols, file formats, encryption, and OS-level code where you manipulate individual bits. The unusual `&^` (AND NOT / bit-clear) operator exists precisely because clearing flag bits is common enough to deserve a dedicated, unambiguous symbol instead of the error-prone `x & ^mask`.

## 3. Internal Working

Operators are not function calls. The Go compiler (`cmd/compile`) lowers most operators directly to machine instructions during SSA (Static Single Assignment) generation. There is no runtime dispatch, no vtable, no allocation for arithmetic on machine-word types.

The pipeline:

```text
 source: c := a + b*2
        │
        ▼  parser  → AST node: OADD(a, OMUL(b, 2))
        │
        ▼  type check → operands must be identical type;
        │              untyped constant 2 converts to typeof(b)
        ▼  SSA build  → v1 = Mul64 b, 2
        │               v2 = Add64 a, v1
        ▼  lowering    → architecture-specific ops
        │   amd64:     IMULQ / LEAQ / ADDQ
        ▼  regalloc + codegen → bytes in the .text segment
```

Key implementation facts:

- **Integer arithmetic wraps.** `int`/`uint` are fixed-width two's-complement. `+ - *` overflow silently (mod 2^N). There is no overflow trap in release builds.
- **Division and modulo emit a runtime check.** `a / b` and `a % b` for integers compile to a `DIV` instruction *plus* a zero-check that panics with `runtime error: integer divide by zero`. The compiler elides the check when it can prove `b != 0` (e.g. a non-zero constant).
- **Shifts have special rules.** `<<` and `>>` accept any integer shift count (negative counts panic at runtime). If the shift count is `>=` the operand width, the result is `0` (logical) — Go *defines* this, unlike C where it is undefined behavior. Right shift of a **signed** value is arithmetic (sign-extending); of an **unsigned** value is logical (zero-filling). This is decided purely by the operand's type at compile time.
- **`&^` is a single op.** `x &^ y` lowers to `ANDN`-style code (or `AND` with a complemented operand), clearing in `x` every bit set in `y`.
- **Comparisons** produce a `bool`. For structs and arrays, `==` is a *recursive field-by-field* comparison the compiler synthesizes; for large comparable structs it may call a generated equality routine rather than inlining.

Because operators map to hardware, an `int` add is ~1 cycle. A `/` can be 20–40 cycles. That asymmetry matters in hot loops (see §8).

## 4. Syntax

```go
// Arithmetic
a + b   a - b   a * b   a / b   a % b      // %, / integers only for modulo
-a      +a                                  // unary

// Comparison → bool
a == b  a != b  a < b  a <= b  a > b  a >= b

// Logical (short-circuit)
a && b  a || b  !a

// Bitwise (integers)
a & b   a | b   a ^ b   a &^ b              // and, or, xor, and-not
a << n  a >> n                              // shifts
^a                                          // unary: bitwise complement (NOT)

// Assignment forms
a += 1  a -= 1  a *= 2  a /= 2  a %= 2
a &= m  a |= m  a ^= m  a &^= m  a <<= 1  a >>= 1

// Statements (not expressions)
i++   i--

// Pointer / channel
&x      *p       ch <- v      v := <-ch
```

Precedence, highest to lowest (5 levels — far fewer than C):

| Prec | Operators |
|------|-----------|
| 5 | `*  /  %  <<  >>  &  &^` |
| 4 | `+  -  \|  ^` |
| 3 | `==  !=  <  <=  >  >=` |
| 2 | `&&` |
| 1 | `\|\|` |

> [!NOTE]
> Critically, `&` (bitwise AND) binds *tighter* than `+`. So `a + b & c` parses as `a + (b & c)`. This is the **opposite** of C, where `&` is below `+`. Reformatting C code into Go can change behavior — always parenthesize bit ops in mixed expressions.

## 5. Common Interview Questions

**Q1. Why does Go have no operator overloading? What is the trade-off?**
*Answer:* Readability and predictability at scale — `+` can never hide expensive or surprising behavior, which matters in large shared codebases. The trade-off: numeric libraries (`big.Int`, `math/bits`, matrix types) must use verbose method calls like `z.Add(x, y)` instead of `z = x + y`. Go accepts ergonomic cost for review clarity.
*Follow-up: How does `big.Int` cope?* It exposes methods returning the receiver, so you chain: `new(big.Int).Mul(a, b)`. Generics (1.18+) help write generic numeric code but still don't add overloading.

**Q2. What does `-7 % 3` evaluate to in Go, and why?**
*Answer:* `-1`. Go's `%` follows the sign of the *dividend*, matching truncated division (`-7 / 3 == -2`, and `-2*3 + (-1) == -7`). It is **not** Euclidean modulo, so it can return negatives.
*Follow-up: How do you get a non-negative modulo?* `((a % n) + n) % n`, or a small helper for performance.

**Q3. Difference between `>>` on a signed vs unsigned integer?**
*Answer:* Signed → arithmetic shift (sign bit replicated), so `-8 >> 1 == -4`. Unsigned → logical shift (zero-filled). The operand type alone decides; there's no separate operator.
*Follow-up: What if the shift count exceeds the bit width?* Go defines the result as 0 (no UB), unlike C.

**Q4. What's wrong with `b = a++`?**
*Answer:* It doesn't compile. `++`/`--` are statements, not expressions. This eliminates the C class of sequence-point bugs.
*Follow-up: How do you express it?* Two lines: `b = a; a++`.

**Q5. Explain `flags &^= Active`.**
*Answer:* `&^` is bit-clear (AND NOT). It clears the `Active` bit(s) in `flags` while leaving others untouched. Equivalent to `flags = flags & ^Active` but a single, clearer operator.
*Follow-up: How do you set vs toggle a bit?* Set: `flags |= Active`. Toggle: `flags ^= Active`. Test: `flags & Active != 0`.

**Q6. Are `&&` and `||` short-circuiting? Why does it matter?**
*Answer:* Yes. `x != nil && x.Ready()` is safe because the right side never evaluates if `x` is nil. It also lets you guard expensive calls: `cheap() || expensive()`.
*Follow-up: Is `&` (bitwise) short-circuiting?* No — it's a value operator that always evaluates both sides.

**Q7. Can you compare two structs with `==`?**
*Answer:* Yes, if all fields are comparable (no slices, maps, or funcs). It's a recursive field comparison. Comparing structs containing a slice is a compile error.
*Follow-up: How do you compare slices?* `slices.Equal` (1.21+) or `reflect.DeepEqual` (slower).

**Q8. What does `1 << 63` do for an `int64` vs in constant context?**
*Answer:* As a typed `int64`, `1 << 63` sets the sign bit → the most-negative number. As an *untyped constant* it's evaluated at arbitrary precision and only errors if it doesn't fit the eventual target type.

## 6. Production Use Cases

- **Feature flags / permission bitsets.** Linux file modes, `os.FileMode`, and AWS IAM-style bitmasks pack many booleans into one integer. `mode & 0o400 != 0` tests read permission. Kubernetes and Docker manipulate Unix mode bits this way.
- **Network protocols.** Parsing TCP/IP, DNS, TLS, and HTTP/2 frame headers requires shifting and masking fields out of packed bytes. Go's `encoding/binary` and the standard library's `net` internals are saturated with `b[0]<<8 | b[1]`.
- **Hashing & checksums.** FNV, CRC32, and Go's runtime map hash use `^` (XOR) and shifts heavily. `hash/crc32` and `hash/fnv` are pure operator code.
- **Roaring bitmaps / set operations.** Databases (analytics engines, Elasticsearch-style postings) implement set intersection/union as `&` and `|` over `uint64` words. Go libraries like `RoaringBitmap/roaring` are built on this.
- **Rate limiting & ring buffers.** Power-of-two ring buffers use `idx & (size-1)` instead of `%` for fast wraparound — used in lock-free queues and high-throughput buffers.
- **Compilers/VMs.** Tagged pointers and small-integer optimizations pack type tags in low bits using `& mask`.

## 7. Common Mistakes

> [!WARNING]
> **Operator precedence surprise.** Because `&` (prec 5) binds tighter than `==` (prec 3), `x & mask == 0` actually parses as `(x & mask) == 0` — but most engineers *misremember* this and add wrong parentheses. Don't rely on memory; parenthesize explicitly.

- **Integer division truncation.** `1 / 2 == 0`. Computing an average as `(a + b) / 2` with integers loses the fraction; percentages need `float64` conversion *before* dividing.
- **Negative modulo.** Assuming `%` is always non-negative; hashing/sharding with `hash % n` on a signed value can produce a negative index → panic.
- **Signed overflow assumptions.** Believing `+` traps on overflow; it silently wraps. `math.MaxInt + 1` is `math.MinInt`.
- **`&^` confused with XOR.** `&^` clears bits; `^` toggles. Using `^` to "remove" a flag toggles it back on next time.
- **Shift count sign.** A *negative* runtime shift count panics; guard computed shift amounts.
- **Comparing floats with `==`.** Floating point equality is fragile; use an epsilon tolerance.

## 8. Performance Considerations

- **`/` and `%` are slow.** Integer division is 20–40+ cycles vs ~1 for add. For power-of-two divisors the compiler auto-converts `x / 8` to `x >> 3` and `x % 8` to `x & 7` — but only when the divisor is a *constant* power of two and the operand is unsigned (signed needs extra rounding correction). Make ring-buffer sizes powers of two and mask.
- **Bitwise ops are essentially free** — single-cycle, fully pipelined, branch-free. Replacing a branch with a bit trick can win in hot loops by avoiding misprediction.
- **`math/bits` is intrinsified.** `bits.OnesCount64`, `bits.LeadingZeros64`, `bits.TrailingZeros64`, `bits.RotateLeft64` lower to single CPU instructions (`POPCNT`, `LZCNT`, `TZCNT`, `ROL`). Never hand-roll these.
- **Short-circuit ordering.** Put the cheap, most-likely-decisive operand first in `&&`/`||` to skip expensive evaluation. `cache.Has(k) || db.Has(k)` avoids the DB hit on cache hits.
- **Struct `==` cost.** Comparing large comparable structs is O(size); for big structs in hot paths, compare a key field or a hash instead.

```go
// Power-of-two masking beats modulo in a ring buffer
const size = 1 << 12 // 4096, must be power of two
idx := (head + 1) & (size - 1) // fast wrap, no DIV
```

## 9. Best Practices

- **Parenthesize mixed bitwise/arithmetic/comparison expressions.** Don't rely on memory of the 5-level table; make intent explicit.
- **Use typed constants with `iota` and shifts for flag sets** so each flag is a distinct power of two.
- **Prefer `&^` for clearing**, `|=` for setting, `^=` for toggling, `&… != 0` for testing — a consistent vocabulary reviewers recognize.
- **Convert to `float64` before dividing** when you need fractional results; never `int(a)/int(b)*100`.
- **Normalize modulo** for indexing: write a `mod(a, n)` helper that guarantees non-negative.
- **Reach for `math/bits`** instead of clever shifts for population count, rotations, and leading/trailing zeros.
- **Don't fight the lack of overloading** — embrace method chaining for `big.Int`/`big.Float`; it's idiomatic.

## 10. Code Examples

Primary: a type-safe flag set using bitwise operators and `iota`.

```go
package main

import "fmt"

type Permission uint8

const (
	Read    Permission = 1 << iota // 0b0001
	Write                          // 0b0010
	Execute                        // 0b0100
	Delete                         // 0b1000
)

func (p Permission) Has(flag Permission) bool          { return p&flag != 0 }
func (p Permission) Set(flag Permission) Permission    { return p | flag }
func (p Permission) Clear(flag Permission) Permission  { return p &^ flag } // AND NOT
func (p Permission) Toggle(flag Permission) Permission { return p ^ flag }

func main() {
	var perm Permission
	perm = perm.Set(Read).Set(Write) // 0b0011
	fmt.Printf("%04b can write: %v\n", perm, perm.Has(Write))

	perm = perm.Clear(Write) // 0b0001
	fmt.Printf("%04b can write: %v\n", perm, perm.Has(Write))

	perm = perm.Toggle(Execute) // 0b0101
	fmt.Printf("%04b can exec:  %v\n", perm, perm.Has(Execute))
}
```

Alternative: parsing a packed protocol header with shifts and masks (extracting fields from a 16-bit value).

```go
package main

import "fmt"

// A 16-bit field: [ 4-bit version | 4-bit type | 8-bit length ]
func decode(hdr uint16) (version, kind, length uint16) {
	version = hdr >> 12 & 0x0F
	kind = hdr >> 8 & 0x0F
	length = hdr & 0xFF
	return
}

func encode(version, kind, length uint16) uint16 {
	return version<<12 | kind<<8 | length&0xFF
}

func main() {
	h := encode(3, 7, 200)
	v, k, l := decode(h)
	fmt.Printf("raw=%016b version=%d type=%d length=%d\n", h, v, k, l)
}
```

A safe non-negative modulo helper — prose separates this so it renders as a standalone block.

```go
// mod returns a result in [0, n) even for negative a.
func mod(a, n int) int {
	m := a % n
	if m < 0 {
		m += n
	}
	return m
}
```

## 11. Advanced Concepts

- **Untyped constant arithmetic is arbitrary-precision.** `const big = 1 << 100` is legal *as a constant* and evaluated with unbounded precision; it only errors if you try to assign it to a type that can't hold it. This lets you write `const KB = 1 << 10; const GB = KB << 20` cleanly. Operators on untyped constants never overflow at compile time.
- **Strength-reduction & bit idioms.** The compiler applies `* 2` → `<< 1`, constant folding, and `&^` fusion. `x & (x - 1)` (clear lowest set bit) and `x & -x` (isolate lowest set bit) are recognized idioms used inside `math/bits`-style code.
- **Comparable type constraints (generics).** `comparable` in type parameters is defined precisely by what `==` accepts. As of recent Go, interface types satisfy `comparable` but may *panic at runtime* if the dynamic type is non-comparable — a subtle interaction between the `==` operator and generics.
- **No overloading, but method sets emulate it.** `time.Time` has `Add`, `Sub`, `Before`, `After` — a deliberate, named substitute for `+ - < >`. `big.Int` and `net/netip.Addr` follow the same pattern.
- **Carry-aware arithmetic.** When a single `uint64` add isn't enough, `math/bits.Add64`/`Mul64` expose hardware carry/overflow that plain operators hide — the building blocks of `math/big`.

## 12. Debugging Tips

- **Inspect generated assembly** to confirm strength reduction: `go build -gcflags=-S ./...` or `go tool compile -S file.go`. Look for `DIVQ` (a real divide — possibly a perf bug) vs `SHRQ`/`ANDQ`.
- **`go vet` catches some operator misuse**, including suspicious shifts and self-assignment.
- **Print binary** with `fmt.Printf("%08b", x)` (or `%016b`, `%032b`) to *see* bits when masks misbehave — far better than decimal.
- **Reproduce precedence bugs** by adding explicit parentheses and checking whether behavior changes; if it does, the original was a precedence trap.
- **Divide-by-zero panics** include the exact line; the same applies to `% 0`. Guard with a check or assert the invariant.
- **Overflow hunting:** when a counter wraps to a huge or negative value, suspect silent integer overflow; switch to `int64`/`uint64` or `math/bits.Add64` for carry-aware arithmetic.

## 13. Senior Engineer Notes

A senior engineer treats operators as a *code-review* and *correctness* surface, not just syntax.

- **In reviews, flag every un-parenthesized mixed bit/arithmetic expression.** The Go precedence table differs from C; a teammate porting code will introduce bugs. Insist on `(x & mask) == target`.
- **Demand non-negative-modulo discipline** anywhere `%` touches user input or hashes used for sharding/indexing — a single negative index panics in production.
- **Push back on integer division for ratios.** "Compute the percentage" written as integer math is a classic silent-zero bug; require explicit float conversion and a comment.
- **Mentor on bit-flag vocabulary.** Teach the `|= / &^= / ^= / & != 0` quartet so flag manipulation reads consistently across the team; ban ad-hoc `& ^mask`.
- **Choose the right width deliberately.** `int` is platform-dependent (32 or 64 bit); for protocol/serialization code mandate fixed-width `uint32`/`uint64` so overflow and shift behavior are portable.
- **Know when overflow is intended.** Hashing and PRNGs *rely* on wraparound; document it so a well-meaning reviewer doesn't "fix" it with bounds checks.

## 14. Staff Engineer Notes

A staff engineer reasons about operators at the level of architecture, portability, and organizational risk.

- **Standardize numeric conventions org-wide.** Decide and lint: fixed-width integers in all wire formats, a shared `mathutil.Mod` helper, and a rule that bit-flag enums live in one place with `iota`. This prevents the same negative-modulo / overflow bug from recurring across teams.
- **Build-vs-buy for bit-heavy domains.** For large set operations, don't hand-roll `uint64` word arrays — evaluate `RoaringBitmap/roaring`. For arbitrary precision, `math/big` over custom. For SIMD-style bit work, weigh assembly/intrinsics against maintainability; the org pays the maintenance cost forever.
- **Portability as a contract.** If services run on both amd64 and arm64, ensure no code depends on `int` width or on undefined-in-C shift semantics (Go defines them, but cgo boundaries may not). Encode this in CI with cross-compilation builds.
- **The "no overloading" decision as a cultural asset.** When evaluating whether to introduce a DSL or numeric library that *wants* overloading, recognize that fighting Go's grain costs more than the ergonomic win. Prefer fluent method APIs; this keeps the codebase legible to new hires and static-analysis tools.
- **Performance budgets.** At org scale, mandating power-of-two sizing for ring buffers/hash tables (mask instead of modulo) is a measurable latency win across thousands of QPS — worth a lint rule and a design-doc guideline, not a per-PR debate.

## 15. Revision Summary

- Operators: arithmetic `+ - * / %`, comparison `== != < <= > >=`, logical `&& || !` (short-circuit), bitwise `& | ^ &^ << >>` and unary `^`.
- **No operator overloading, no ternary; `++`/`--` are statements.**
- Precedence has only **5 levels**; `&` and `<<` bind *tighter* than `+` (opposite of C) — parenthesize.
- `%` follows the **dividend's sign** → can be negative; normalize with `((a%n)+n)%n`.
- Right shift is **arithmetic for signed, logical for unsigned**; over-width shifts give 0 (defined, not UB).
- Integer `+ - *` **wrap silently** on overflow; `/` and `%` panic on zero divisor.
- `&^` = bit-clear; flag idioms: set `|=`, clear `&^=`, toggle `^=`, test `& != 0`.
- `/` and `%` are slow; const power-of-two divisors become shifts/masks; use `math/bits` for popcount/rotate.
- Structs compare with `==` only if all fields are comparable.

**References:** Go spec: Operators (https://go.dev/ref/spec#Operators); `math/bits` package; Go spec: Arithmetic operators, Comparison operators, Constant expressions.

---
*Go Engineering Handbook — topic 10.*
