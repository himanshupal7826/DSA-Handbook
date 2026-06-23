# 9 · Type Conversion

> **In one line:** Go has no implicit numeric coercion — every type change is an explicit, type-checked conversion `T(x)`, and the dangerous cases are silent numeric truncation and overflow.

---

## 1. Overview

Type conversion in Go is the explicit act of taking a value of one type and producing a value of another, compatible type using the syntax `T(x)`. Unlike C, C++, JavaScript, or Python, Go performs **no implicit coercion** between distinct types. You cannot add an `int32` to an `int64`, assign a `float64` into an `int`, or compare a named type with its underlying type without writing the conversion yourself.

This design is deliberate and central to Go's philosophy: the compiler refuses to guess what you meant. The result is verbose-looking arithmetic but dramatically fewer "I lost precision and didn't notice" bugs that plague languages with promotion rules.

There are three families you must distinguish, and beginners routinely confuse them:

| Operation | What it does | Example |
|---|---|---|
| **Conversion** | Reinterprets/transforms a value between compatible types at compile time | `int64(x)`, `[]byte(s)` |
| **Parsing** | Turns a *string representation* into a typed value at runtime | `strconv.Atoi("42")` |
| **Assertion** | Recovers a concrete type from an `interface{}` at runtime | `v.(int)` |

`int64("42")` does **not** exist — a string is not numerically convertible to an integer. That is parsing's job (`strconv`). Mastering when each applies is the whole game.

---

## 2. Why It Exists

Implicit conversion is one of the great silent bug factories in systems programming. Consider C:

```text
uint32_t a = 4000000000;   // ~4 billion
int b = a;                 // silently becomes negative; no warning by default
```

C's "usual arithmetic conversions" promote and demote operands behind your back. The classic results: signed/unsigned comparison bugs, truncation when a wide value lands in a narrow one, and float-to-int rounding nobody asked for. These bugs are invisible at the call site — the code *looks* fine.

Go's designers (Pike, Thompson, Griesemer — veterans of exactly these C wounds) made a hard rule: **operands of binary operations must be of the same type**, and crossing a type boundary requires you to write it out. The benefits:

- **Readability of intent.** `int64(n)` at the call site tells the reader (and reviewer) "I am widening here, on purpose."
- **Grep-ability.** You can audit every place a value narrows by searching for the conversion.
- **No surprise precision loss.** The compiler forces you to acknowledge a `float64 → int` truncation.
- **Named types carry meaning.** A `type Celsius float64` won't accidentally mix with a `type Fahrenheit float64`; the type system enforces a unit boundary even though both are `float64` underneath.

The cost is verbosity. Go accepts that trade: a few extra characters now versus a production incident later.

---

## 3. Internal Working

Type conversion is overwhelmingly a **compile-time** concept. The Go compiler (`cmd/compile`) classifies each conversion and emits — in most cases — either *nothing* or a single machine instruction. Let's break it down by category.

**Numeric conversions** generate the obvious hardware instruction:

- Widening a signed integer (`int32 → int64`) emits a sign-extend (`MOVLQSX` on amd64).
- Widening unsigned (`uint32 → uint64`) emits a zero-extend (`MOVLQZX`).
- Narrowing (`int64 → int32`) emits a truncate — the high bits are simply dropped. **No check, no panic.**
- `float64 → int` emits a convert-with-truncation-toward-zero instruction (`CVTTSD2SI`). Out-of-range or NaN inputs yield an *implementation-defined* value — a real trap.

**String/byte/rune conversions** are where the runtime actually does work and allocates:

- `[]byte(s)` and `[]rune(s)` allocate a new backing array and copy. They are *not* free reinterpretations — the new slice is mutable and independent of the immutable string.
- `string(b)` (from `[]byte`) allocates and copies bytes.
- `string(r)` where `r` is a single `rune`/`int` produces the UTF-8 encoding of that code point (1–4 bytes), **not** the decimal digits. `string(65)` is `"A"`, not `"65"`. This is so error-prone that `go vet` flags `string(int)`.

**Same-underlying-type conversions** (`Celsius(x)` where both are `float64`) are pure compile-time relabeling — zero instructions, zero cost.

```text
 Memory view of  s := "héllo"   (h,é = 2 bytes,l,l,o)
 string header (16 bytes on 64-bit):
   +----------+--------+
   | *data ---|-> [ 68 c3 a9 6c 6c 6f ]   (immutable, 6 bytes UTF-8)
   | len = 6  |
   +----------+

 b := []byte(s)            r := []rune(s)
   ALLOCATE 6 bytes,         ALLOCATE 5 int32s,
   COPY  -> mutable          DECODE UTF-8 -> code points
   +----------+              +-----------------------------+
   | *data ---|->[68 c3 a9..]| 'h' 'é' 'l' 'l' 'o' (rune)  |
   | len 6 cap 6|            | 104 233 108 108 111         |
   +----------+              +-----------------------------+
```

The key runtime insight: **string ↔ slice conversions cost an allocation + copy** (handled by runtime helpers like `slicebytetostring`, `stringtoslicebyte`), while **numeric conversions are register-level and free-ish.** The compiler has optimizations (e.g. `for i := range []byte(s)` avoids the copy, and `m[string(b)]` map lookups avoid allocating the temporary string), but you should assume a copy unless you've confirmed otherwise.

---

## 4. Syntax

```go
// Numeric — explicit, may truncate/round silently
var i int = 300
var b byte = byte(i)       // 300 -> 44 (300 mod 256). No error.
var f float64 = 3.99
var n int = int(f)         // 3 — truncates toward zero, does NOT round

// Named types with same underlying type
type Celsius float64
type Fahrenheit float64
c := Celsius(100)
f2 := Fahrenheit(c*9/5 + 32)   // explicit cross of the unit boundary
_ = f2

// String <-> bytes/runes (allocates + copies)
s := "héllo"
bs := []byte(s)            // UTF-8 bytes
rs := []rune(s)            // Unicode code points
s2 := string(bs)           // back to string
ch := string(rune(65))     // "A"  (code point), NOT "65"
_, _, _ = rs, s2, ch

// Parsing strings to numbers — this is strconv, not conversion
import "strconv"
x, err := strconv.Atoi("42")            // string -> int
y, err := strconv.ParseFloat("3.14", 64)
z := strconv.Itoa(99)                    // int -> string "99"
```

> [!WARNING]
> `string(someInt)` interprets the int as a Unicode code point, not its decimal text. To get `"42"` from `42`, use `strconv.Itoa(42)`. `go vet` warns on this.

---

## 5. Common Interview Questions

**Q1. Why does Go require explicit conversion when C does not?**
*Answer:* To eliminate silent precision loss and signed/unsigned bugs, and to make widening/narrowing visible and grep-able at the call site. Operands of binary ops must share a type. *Follow-up: does this apply to untyped constants?* No — untyped constants (`const x = 5`) adapt to context, so `var f float64 = 5` needs no conversion; the constant is *not* yet typed.

**Q2. What does `string(65)` produce?**
*Answer:* `"A"` — the UTF-8 encoding of code point 65, not `"65"`. *Follow-up: how do you get `"65"`?* `strconv.Itoa(65)` or `fmt.Sprint(65)`.

**Q3. Is `[]byte(s)` free?**
*Answer:* No. It allocates a new mutable backing array and copies the bytes, because strings are immutable. *Follow-up: name a case the compiler optimizes away the copy.* `m[string(b)]` map indexing, and `range []byte(s)` — both avoid the allocation.

**Q4. What happens with `byte(300)`?**
*Answer:* `44`. Narrowing keeps the low 8 bits (300 mod 256). No panic, no error — a classic overflow trap. *Follow-up: how would you detect this at runtime?* Range-check before converting, or use a helper that returns an error.

**Q5. How do `int(3.9)` and `math.Round(3.9)` differ?**
*Answer:* `int(3.9)` truncates toward zero → `3`. `math.Round(3.9)` rounds to nearest → `4.0` (still a float64; convert after). *Follow-up: what about negatives?* `int(-3.9)` is `-3` (toward zero), while `math.Floor(-3.9)` is `-4`.

**Q6. Difference between type conversion, type assertion, and parsing?**
*Answer:* Conversion `T(x)` is compile-time between compatible types; assertion `x.(T)` is runtime extraction of a concrete type from an interface (can panic / use comma-ok); parsing (`strconv`) is runtime interpretation of a string's textual content. *Follow-up: which can panic?* Only the assertion (single-return form). Conversions never panic; `strconv` returns an error.

**Q7. Can you convert between two struct types?**
*Answer:* Yes, if they have **identical underlying field types** (ignoring struct tags since Go 1.8). `T1(v)` works when the fields line up. *Follow-up: between a struct and a pointer to it?* No — different types; you take its address (`&v`) instead.

**Q8. What's the result type of `len(s)` for a multibyte string, and how does conversion help count characters?**
*Answer:* `len(s)` returns **byte** length, not character count. `len([]rune(s))` (or `utf8.RuneCountInString(s)`) counts code points. *Follow-up: which is faster?* `utf8.RuneCountInString` — it counts without allocating a `[]rune`.

---

## 6. Production Use Cases

- **Wire/serialization boundaries.** Protobuf and gRPC define fields as `int32`/`int64`/`uint64`; your Go domain model often uses `int`. Every encode/decode boundary is full of `int64(x)` / `int(x)` conversions. Kubernetes' API machinery and etcd are saturated with these.
- **Database drivers.** `database/sql` and drivers like `pgx` (Postgres) return values that you convert: a `sql.NullInt64` → `int`, a `[]byte` BLOB → `string`. Misconverting `int64` from Postgres `BIGINT` into a Go `int32` ID has caused real outages when IDs crossed 2^31.
- **String processing & I/O.** HTTP handlers read `[]byte` bodies and convert to `string`; loggers (zap, zerolog) convert between bytes and strings constantly, and zap goes to great lengths to *avoid* those copies for performance.
- **Hashing/crypto.** `sha256.Sum256([]byte(data))` requires the `[]byte` conversion; the result `[32]byte` is converted to `string` or hex.
- **Metrics & monitoring.** The Prometheus client requires `float64` for every metric, so counters tracked as `int64` are converted at observation time (`float64(count)`).
- **Unit/domain types.** Currency libraries and time handling (`time.Duration` is a named `int64`) lean on conversions: `time.Duration(ms) * time.Millisecond`.

---

## 7. Common Mistakes

> [!WARNING]
> These are the conversions that bite teams in production.

- **`string(intVar)` expecting decimal text.** Returns a Unicode character. Use `strconv`.
- **Silent narrowing overflow.** `int32(bigInt64)` wraps with no warning. IDs, counters, and sizes that grow past the narrow type's range corrupt silently.
- **Float→int truncation mistaken for rounding.** `int(price * 1.08)` drops the cents you expected to round. Round explicitly first.
- **Assuming `[]byte(s)` is a cheap view.** It copies. In hot loops this allocates garbage and tanks throughput.
- **Mutating the result expecting the string to change** (or vice versa). They're independent after conversion.
- **`len(unicodeString)` ≠ character count.** Confusing byte length with rune count.
- **Converting `interface{}` with `T(x)` instead of asserting `x.(T)`.** Different mechanism; the compiler error confuses beginners.
- **Loop variable type drift.** `for i := 0; i < len(buf); i++` gives `int i`; passing `i` where a `uint32` is needed forces a conversion that may overflow on 32-bit platforms.

---

## 8. Performance Considerations

| Conversion | Cost | Notes |
|---|---|---|
| Numeric (`int64(x)`, `float64(n)`) | ~free | 0–1 machine instructions; register-level |
| Same underlying type (`Celsius(f)`) | free | Pure compile-time relabel |
| `[]byte(s)` / `string(b)` | alloc + O(n) copy | Heap allocation; GC pressure in hot paths |
| `[]rune(s)` | alloc + O(n) decode | Allocates `int32` per code point — 4× the bytes |
| `string(rune)` | tiny alloc | 1–4 byte result |

The expensive ones are string ↔ slice. Mitigations:

- **Compiler-recognized patterns:** `m[string(b)]` and `for _, c := range []byte(s)` avoid the copy automatically. Lean on these.
- **`unsafe` zero-copy** (Go 1.20+: `unsafe.String` / `unsafe.Slice`) lets you alias a `[]byte` as a `string` with no copy — used by high-perf libraries (fasthttp, jsoniter) but **you must guarantee the bytes never mutate afterward.** Misuse causes memory corruption.
- **`strings.Builder`** to assemble strings without repeated `string([]byte)` round-trips.
- **`strconv.AppendInt(buf, n, 10)`** instead of `[]byte(strconv.Itoa(n))` to avoid an intermediate string in tight serialization loops.

Numeric conversions are not a performance concern — never contort code to avoid an `int64()`.

---

## 9. Best Practices

- **Convert at boundaries, compute in one type.** Decode wire types to your domain type once at the edge; do arithmetic in a single consistent type internally.
- **Range-check before narrowing** anything that can grow (IDs, lengths, counts). Wrap in a helper that returns an error if you need safety.
- **Use `strconv`, never `string(int)`, for text.** And run `go vet` / `golangci-lint` — they catch the misuse.
- **Round before truncating** when you mean to round: `int(math.Round(x))`.
- **Prefer `utf8.RuneCountInString`** over `len([]rune(s))` for counting.
- **Name your unit types** (`type UserID int64`) so conversions become semantic boundaries, not just plumbing.
- **Reserve `unsafe.String`/`unsafe.Slice` for proven hot paths** with a comment explaining the immutability invariant.
- **Keep untyped constants untyped** as long as possible; they adapt without explicit conversion and avoid premature narrowing.

---

## 10. Code Examples

Primary: a safe narrowing helper that refuses to silently overflow — the pattern you want around any width reduction at a trust boundary.

```go
package conv

import (
	"fmt"
	"math"
)

// SafeInt32 narrows an int64 to int32, returning an error on overflow
// instead of silently wrapping (which plain int32(x) would do).
func SafeInt32(x int64) (int32, error) {
	if x < math.MinInt32 || x > math.MaxInt32 {
		return 0, fmt.Errorf("value %d overflows int32", x)
	}
	return int32(x), nil
}

func ExampleNarrow() {
	if v, err := SafeInt32(3_000_000_000); err != nil {
		fmt.Println("rejected:", err) // rejected: value 3000000000 overflows int32
	} else {
		fmt.Println(v)
	}
}
```

```go
package conv

// Naive version that ships the bug: 3_000_000_000 silently becomes
// a negative number. Shown for contrast — do NOT do this at a boundary.
func UnsafeNarrow(x int64) int32 {
	return int32(x) // wraps: 3_000_000_000 -> -1294967296
}
```

Separate, standalone example — string/rune handling that beginners trip over:

```go
package main

import (
	"fmt"
	"strconv"
	"unicode/utf8"
)

func main() {
	n := 65

	fmt.Println(string(rune(n)))   // "A"  (code point) — usually NOT what you want
	fmt.Println(strconv.Itoa(n))   // "65" (decimal text) — usually what you want

	s := "héllo"
	fmt.Println(len(s))                       // 6  (bytes)
	fmt.Println(utf8.RuneCountInString(s))    // 5  (characters)
	fmt.Println(len([]rune(s)))               // 5  (also 5, but allocates)

	// Parsing: string -> number
	if v, err := strconv.Atoi("42"); err == nil {
		fmt.Println(v + 1) // 43
	}
}
```

---

## 11. Advanced Concepts

**Untyped constants vs. typed values.** Go constants are untyped until used. `const k = 1 << 20` can be assigned to `int`, `int64`, or `float64` without conversion because it adopts the destination type. This is why `var ms = 5 * time.Millisecond` compiles — `5` adapts to `time.Duration`. But `var x int64 = 5; var d = x * time.Millisecond` does **not** compile: `x` is already typed `int64`, not the named `time.Duration`.

**Conversion rules for composite types.** Two slice types are convertible if their element types are identical. Struct types convert when fields match (tags ignored since 1.8). Go 1.17 added `(*[N]T)(slice)` to convert a slice to an array pointer (panics if too short); Go 1.20 added `[N]T(slice)` for slice→array value conversion. These matter for crypto code that needs fixed-size arrays from variable slices.

**Generics and conversion (Go 1.18+).** You cannot write `T(x)` for an arbitrary type parameter `T` unless the constraint guarantees convertibility. The `constraints.Integer`/`Float` constraints plus explicit conversions inside generic numeric code are common; conversion between two type parameters is restricted.

**`unsafe` reinterpretation.** `unsafe.Pointer` lets you *reinterpret* bits (e.g. `float64` ↔ `uint64` for bit manipulation — though `math.Float64bits` is the safe wrapper). This is reinterpretation, categorically different from value conversion, and bypasses the type system entirely.

> [!NOTE]
> `math.Float64bits(f)` / `math.Float64frombits(u)` give you the IEEE-754 bit pattern as a `uint64` — distinct from `uint64(f)` which truncates the *value*. Confusing the two is a deep, subtle bug.

---

## 12. Debugging Tips

- **Run `go vet` first.** It flags `string(int)` and several conversion smells for free. Add `golangci-lint` with the `gosec` (G115 integer overflow) linter to catch unchecked narrowing.
- **Reproduce overflow in isolation.** Print `fmt.Printf("%T %v\n", x, x)` before and after a conversion — type + value side by side instantly reveals truncation/wrap.
- **For string mojibake**, dump bytes: `fmt.Printf("% x\n", []byte(s))` to see the actual UTF-8, and `for i, r := range s { ... }` to see code points and their byte offsets.
- **Suspect a silent wrap?** Widen everything to the largest type, do the math, and compare to the narrow result — divergence localizes the overflow.
- **Allocation surprises:** `go test -bench . -benchmem` shows allocs/op; a non-zero count on a numeric-only path usually means a hidden `[]byte`/`string` conversion.
- **Use the race detector** when reaching for `unsafe.String`/`unsafe.Slice` — aliasing bugs often surface as data races.

---

## 13. Senior Engineer Notes

As a senior engineer, your job is judgment at the line and review level. **In code review, flag every narrowing conversion** (`int32(x)`, `byte(x)`) on data that originates outside the function — ask "can this value exceed the target range, ever, in five years?" IDs, counts, sizes, and timestamps are the usual culprits. Require a range check or a documented invariant.

**Mentor the conversion-vs-parsing-vs-assertion distinction early** — it's the single most common confusion in junior Go PRs, and `string(id)` bugs reach production because they don't crash; they just emit garbage. Teach `strconv` reflexively.

**Push for unit types** (`type AccountID int64`) so the type system does boundary-checking for you and conversions read as intentional crossings rather than noise. **Profile before optimizing string/byte conversions** — juniors reach for `unsafe` based on vibes; insist on a benchmark proving the copy is the bottleneck, and demand a comment stating the immutability contract whenever `unsafe.String` ships. Own the `golangci-lint` config so G115 (overflow) is on by default across the repo.

---

## 14. Staff Engineer Notes

At staff level the conversion question becomes an **architectural and organizational** one. The biggest real-world risk is **width mismatch across service and storage boundaries**: a `BIGINT` in Postgres, an `int64` in proto, an `int` (32-bit on some targets) in older code, and a JavaScript `number` (safe only to 2^53) on the frontend. Standardize the integer width policy org-wide — typically "int64 everywhere on the wire, never expose IDs as JS numbers; serialize large IDs as strings." This decision prevents a whole class of incidents and belongs in your API style guide, not in ad-hoc PR comments.

**Build-vs-buy:** for safe numeric conversion, the standard `math` bounds plus a small shared helper are enough — don't build a bespoke conversion library; instead invest in a shared linter ruleset and a generated-code policy so proto/SQL boundaries are uniform across teams.

**Cross-team:** when you migrate a type (e.g. widening an ID from int32 to int64), the conversion sites are your migration surface. Drive it with a typed wrapper and the compiler as your refactoring tool — change the type, let the build break, fix every site. That is Go's narrowing rule paying off at org scale: every place that loses precision is a compile error, not a silent runtime corruption. Weigh the cost of the (large) mechanical change against the latent cost of a 2-billion-row overflow, and the math is always in favor of doing it before the limit, not after.

---

## 15. Revision Summary

- **No implicit coercion** — every cross-type change is explicit `T(x)`; binary ops need identical types.
- **Three different things:** conversion `T(x)` (compile-time, never panics), parsing `strconv.*` (runtime, returns error), assertion `x.(T)` (runtime, can panic).
- **Numeric narrowing wraps silently**; float→int **truncates toward zero** (not rounds). Range-check before narrowing.
- **`string(int)` = code point**, not decimal text — use `strconv.Itoa`. `go vet` catches it.
- **`[]byte(s)`/`[]rune(s)`/`string(b)` allocate and copy**; numeric conversions are ~free.
- **`len(s)` = bytes**, not characters; use `utf8.RuneCountInString`.
- Same-underlying-type and named-type conversions are free relabels; lean on unit types.
- `unsafe.String`/`unsafe.Slice` (1.20+) give zero-copy conversion but demand an immutability guarantee.

**References:** Go spec: Conversions; `go vet` (stringintconv); `strconv`, `unicode/utf8`, `math`, `unsafe` package docs.

---

*Go Engineering Handbook — topic 9.*
