# 30 · Reflection

> **In one line:** Reflection lets a Go program inspect and manipulate the types and values of arbitrary interfaces at runtime via `reflect.Type` and `reflect.Value`, paying a real CPU and safety cost for that dynamism.

---

## 1. Overview

Reflection is the ability of a program to examine its own structure — types, fields, methods, tags — and to read and mutate values *at runtime*, without knowing those types at compile time. Go exposes this through the `reflect` package, built on two core types: `reflect.Type` (the static description of a Go type) and `reflect.Value` (a runtime handle to an actual value).

Go is statically typed, so reflection is the deliberate escape hatch for the small set of problems that genuinely need to operate over *unknown* types: serializers (`encoding/json`), ORMs, dependency-injection containers, validators, and printf-style formatting. The price is steep — you trade compile-time safety and a 10–100× speed penalty for generality.

The canonical mental model is Rob Pike's three **Laws of Reflection** (Go blog, 2011):

1. Reflection goes from interface value to reflection object (`reflect.ValueOf`, `reflect.TypeOf`).
2. Reflection goes from reflection object back to interface value (`Value.Interface()`).
3. To modify a reflection object, the value must be **settable** (addressable and exported).

If you internalize those three laws, 90% of reflection confusion disappears.

## 2. Why It Exists

Without reflection, you cannot write a function whose behaviour depends on a type you have never seen. Consider `json.Marshal(v any)`. It accepts *any* value and must walk its fields, read struct tags, and emit JSON. There is no generic mechanism in Go 1 that could do this — generics (1.18+) help with *parametric* code where the shape is known, but they cannot enumerate the fields of an arbitrary struct or read a `json:"name"` tag. That is fundamentally a runtime, type-introspection problem.

Reflection exists to bridge the gap between Go's static type system and the inherently dynamic boundaries of a program: serialization formats, network protocols, configuration files, database rows, and template engines. Every one of these is a place where data crosses from an untyped wire representation into typed Go structs, and reflection is how the standard library performs that mapping generically.

> [!NOTE]
> Generics did **not** make reflection obsolete. Generics give you type-safe containers and algorithms; reflection gives you runtime introspection over unknown concrete types. Many libraries (e.g. validation) now combine both.

## 3. Internal Working

To understand reflection you must understand how an `interface` is represented. In the Go runtime, a non-empty interface value is a two-word structure:

```text
 interface value (e.g. io.Reader holding *os.File)
 ┌─────────────┬─────────────┐
 │   *itab     │    data     │
 └──────┬──────┴──────┬──────┘
        │             │
        ▼             ▼
  ┌──────────┐   ┌──────────┐
  │  itab    │   │ *os.File │  (the concrete value, or a
  │ _type *  │   │  payload │   pointer to it if it doesn't
  │ fun[...] │   └──────────┘   fit in a word)
  └────┬─────┘
       ▼
  ┌───────────────────────┐
  │  runtime._type (rtype) │  <- size, kind, hash, align,
  │  name, methods, ...    │     gcdata, string, etc.
  └───────────────────────┘
```

The empty interface `any` is similar but uses a plain `*_type` instead of an `*itab` (no method set is needed):

```text
 any value
 ┌─────────────┬─────────────┐
 │   *_type    │    data     │
 └─────────────┴─────────────┘
```

`reflect.TypeOf(x)` simply takes the `*_type` word out of the interface and wraps it as a `reflect.Type` (concretely `*reflect.rtype`, an alias over the runtime's `_type`). `reflect.ValueOf(x)` captures three things into a `reflect.Value` struct: the type pointer, a pointer to the data, and a `flag` bitfield encoding the kind, whether the value is addressable, whether it's read-only/unexported, and indirection.

```text
 reflect.Value (conceptually)
 ┌──────────┬──────────┬───────────────────────────┐
 │  typ *   │  ptr     │  flag (kind|addr|ro|indir) │
 └──────────┴──────────┴───────────────────────────┘
```

The `flag` is the heart of Law #3. `Value.Set` checks `flag&flagAddr != 0` (addressable) and `flag&flagRO == 0` (exported/settable); if not, it panics. Addressability is why you must pass a *pointer* and call `.Elem()` — `reflect.ValueOf(&s).Elem()` produces a Value whose `ptr` points into `s`'s actual storage and whose `flagAddr` bit is set.

Field metadata (`reflect.StructField` — name, type, offset, tag) is read from the type descriptor's field array, which the compiler emits into the read-only data section of the binary for every type used with reflection. Method calls via `Value.Call` build an argument frame on the stack and use the runtime's `reflectcall` to invoke the target, which is why reflective calls cannot be inlined and defeat escape analysis.

## 4. Syntax

```go
package main

import (
	"fmt"
	"reflect"
)

type User struct {
	Name string `json:"name" validate:"required"`
	Age  int    `json:"age"`
}

func main() {
	u := User{Name: "Ada", Age: 36}

	t := reflect.TypeOf(u)  // reflect.Type
	v := reflect.ValueOf(u) // reflect.Value (read-only copy)

	fmt.Println(t.Kind(), t.Name()) // struct User

	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		fmt.Printf("%s = %v (json=%q)\n",
			f.Name, v.Field(i), f.Tag.Get("json"))
	}

	// Mutation requires addressability (Law #3):
	p := reflect.ValueOf(&u).Elem()
	p.FieldByName("Age").SetInt(40)
	fmt.Println(u.Age) // 40
}
```

Key entry points: `TypeOf`, `ValueOf`, `Kind`, `NumField/Field/FieldByName`, `Tag.Get/Lookup`, `Elem` (deref pointer/interface), `Interface()` (back to `any`), `Set/SetInt/SetString`, `Call`, `New`, `MakeSlice`, `MakeMap`.

## 5. Common Interview Questions

**Q1. What are the three Laws of Reflection?**
Interface → reflection object (`ValueOf`/`TypeOf`); reflection object → interface (`Interface()`); to set a value it must be settable (addressable + exported). *Follow-up: why does law 3 require a pointer?* Because `ValueOf` copies its argument; the copy isn't addressable. Passing `&x` and calling `.Elem()` gives a Value aliasing the original storage.

**Q2. Difference between `Type` and `Kind`?**
`Type` is the full named type (`main.User`, `[]int`); `Kind` is the underlying category from a fixed enum (`Struct`, `Slice`, `Int`, `Ptr`…). Two distinct named types can share a Kind. *Follow-up: when do you switch on Kind vs Type?* Use Kind for structural traversal (any struct, any slice); use Type for identity checks like "is this exactly `time.Time`?".

**Q3. Why can't reflection set an unexported field?**
The `flagRO` bit is set for fields obtained via reflection on unexported names; `Set` panics to preserve package encapsulation. *Follow-up: how do some libraries bypass it?* Via `unsafe` + reflect's internal layout (older spew/copier hacks). It's unsupported and fragile.

**Q4. How does `json.Marshal` use reflection?**
It calls `reflect.ValueOf`, switches on `Kind`, walks struct fields, reads the `json` tag from `StructField.Tag`, and recurses. It caches per-type field encoders to amortize cost. *Follow-up: how is the cost amortized?* `encoding/json` keeps a `sync.Map` of compiled `typeEncoder` functions keyed by `reflect.Type`.

**Q5. Is `reflect.DeepEqual` safe for all types?**
No. It handles cycles for maps/slices/pointers but treats func values as unequal unless both nil, and compares unexported fields too. It's slow and can surprise on `time.Time`. *Follow-up: alternative?* Hand-written `Equal` methods or `google/go-cmp` (`cmp.Equal`) with options.

**Q6. What's the performance cost of reflection?**
Allocations (boxing into interfaces), no inlining, type-assertion-like dispatch — typically 10–100× slower than direct code. *Follow-up: how to mitigate?* Cache `reflect.Type`/field offsets, generate code (`go generate`), or use `unsafe.Pointer` with precomputed offsets in hot paths.

**Q7. How do you call a method by name at runtime?**
`reflect.ValueOf(obj).MethodByName("Foo").Call([]reflect.Value{...})`. *Follow-up: pointer vs value receiver?* Methods with pointer receivers are only in the method set of an addressable/pointer Value, so reflect on `&obj`.

**Q8. What does `Value.Elem()` do for a pointer vs an interface?**
For a pointer it dereferences to the pointee (addressable); for an interface it unwraps the dynamic value inside. Calling it on other kinds panics. *Follow-up: what does it return for a nil pointer?* The zero `Value` — check `IsValid()` before using it.

## 6. Production Use Cases

- **`encoding/json`, `encoding/xml`, `gopkg.in/yaml.v3`** — the archetypal reflective serializers; they walk struct fields and tags.
- **ORMs / DB mappers**: GORM, sqlx, and `database/sql`'s `Rows.Scan` (via `convertAssign`) map columns to struct fields by reflection and `db:` tags.
- **Validation**: `go-playground/validator` reads `validate:"required,email"` tags reflectively — used heavily in Gin and Echo request binding.
- **Dependency injection**: Uber's `dig` resolves a constructor's parameter types via reflection to build the graph; Google's `wire` instead generates code to avoid the cost.
- **gRPC / Protobuf**: `protoreflect` enables generic message traversal, used by tools like `grpcurl` and server reflection.
- **CLI / config**: `spf13/viper` and `mitchellh/mapstructure` decode arbitrary maps into structs; `cobra` flag binding.
- **Testing**: `reflect.DeepEqual` in `testify/assert`, and `google/go-cmp`.
- **Templates**: `text/template` and `html/template` resolve `.Field` and method calls on the data via reflection.

## 7. Common Mistakes

> [!WARNING]
> Calling `Value.Interface()` on a Value derived from an **unexported** field panics ("cannot return value obtained from unexported field"). Guard with `f.CanInterface()`.

- **Forgetting addressability**: `reflect.ValueOf(s).Field(0).SetInt(1)` panics. You need `reflect.ValueOf(&s).Elem()`.
- **Confusing `Kind` with `Type`**: switching on `Type` strings is brittle; switch on `Kind` for structure.
- **Mutating a copy**: `ValueOf(x)` copies; changes never reach `x`.
- **Ignoring nil pointers/interfaces**: calling `Elem()` on a nil pointer yields a zero `Value`; `IsValid()`/`IsNil()` checks are mandatory.
- **Tag parsing by hand**: use `StructTag.Get`/`Lookup`, not string splitting — the format has escaping rules.
- **Reflecting in hot loops** without caching the `reflect.Type`.
- **Assuming `DeepEqual` ignores unexported fields** — it does not.

## 8. Performance Considerations

Reflection is slow for concrete, measurable reasons: every `ValueOf` may box a value into an interface (heap allocation if it doesn't fit a word), `Field`/`Call` go through indirection that cannot be inlined, and `Call` builds an argument frame and invokes `reflectcall`. Rough orders of magnitude on a modern CPU:

| Operation | Direct | Reflective | Ratio |
|---|---|---|---|
| Read a struct field | ~0.3 ns | ~3–8 ns | ~10–25× |
| Set a struct field | ~0.3 ns | ~15–30 ns | ~50–100× |
| Call a method | ~1–2 ns | ~150–300 ns | ~100×+ |
| `DeepEqual` small struct | n/a | 100s of ns | — |

Mitigations, in order of preference:

1. **Cache the metadata.** `reflect.Type` and `StructField.Offset` are stable per type — compute once, store in a `sync.Map`.
2. **Compile a closure per type** (what `encoding/json` does): build a `func(unsafe.Pointer, *buf)` once, reuse forever.
3. **Code generation** (`easyjson`, `ffjson`, `sqlc`, `wire`): eliminate reflection entirely; 5–10× faster JSON than `encoding/json`.
4. **`unsafe.Pointer` with precomputed offsets** for the absolute hottest paths — fast but dangerous.

> [!TIP]
> Before optimizing, profile. Reflection in a request handler that does I/O is usually noise; reflection in a per-row decode loop over millions of rows is where it bites.

## 9. Best Practices

- Keep reflection at the **boundary** (serialization, DI wiring, config) and convert to concrete types as early as possible.
- Always pair `ValueOf`/`Field` access with `IsValid`, `CanSet`, `CanInterface` guards.
- **Cache** compiled type plans; never re-walk a type per call.
- Prefer **`go-cmp`** over `reflect.DeepEqual` in tests for clearer diffs and options.
- Document the tag schema you read and validate it (panic early on malformed structs at init).
- Prefer **code generation** over runtime reflection when the type set is known at build time.
- Never use reflection where generics or an interface would do — it's a smell in business logic.

## 10. Code Examples

A generic struct-to-map converter honoring `json` tags — the primary idiomatic approach. Below it, an alternative using a cached field plan for hot paths (switchable tab).

```go
// Primary: simple, correct, uncached.
func StructToMap(v any) map[string]any {
	out := map[string]any{}
	val := reflect.ValueOf(v)
	if val.Kind() == reflect.Ptr {
		val = val.Elem()
	}
	t := val.Type()
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		if f.PkgPath != "" { // unexported
			continue
		}
		name := f.Name
		if tag, ok := f.Tag.Lookup("json"); ok && tag != "-" {
			if comma := strings.IndexByte(tag, ','); comma >= 0 {
				tag = tag[:comma]
			}
			if tag != "" {
				name = tag
			}
		}
		out[name] = val.Field(i).Interface()
	}
	return out
}
```

```go
// Alternative: precompiled, cached plan for hot paths.
type fieldPlan struct {
	name  string
	index int
}

var planCache sync.Map // map[reflect.Type][]fieldPlan

func planFor(t reflect.Type) []fieldPlan {
	if p, ok := planCache.Load(t); ok {
		return p.([]fieldPlan)
	}
	var fs []fieldPlan
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		if f.PkgPath != "" {
			continue
		}
		name := f.Name
		if tag, ok := f.Tag.Lookup("json"); ok && tag != "-" {
			if c := strings.IndexByte(tag, ','); c >= 0 {
				tag = tag[:c]
			}
			if tag != "" {
				name = tag
			}
		}
		fs = append(fs, fieldPlan{name, i})
	}
	planCache.Store(t, fs)
	return fs
}
```

Calling a method dynamically and reading its results:

```go
func CallByName(obj any, method string, args ...any) []reflect.Value {
	v := reflect.ValueOf(obj)
	m := v.MethodByName(method)
	if !m.IsValid() {
		panic("no method " + method)
	}
	in := make([]reflect.Value, len(args))
	for i, a := range args {
		in[i] = reflect.ValueOf(a)
	}
	return m.Call(in)
}
```

## 11. Advanced Concepts

- **Constructing types at runtime**: `reflect.New(t)` allocates a settable pointer; `reflect.MakeSlice`, `MakeMap`, `MakeChan`, and `reflect.StructOf` build composite types — `StructOf` even synthesizes anonymous struct types with custom tags (used by some serialization frameworks).
- **`reflect.MakeFunc`**: create a function value at runtime backed by a Go closure — the mechanism behind mocking frameworks and generic RPC stubs.
- **`reflect.Value.UnsafePointer` / `unsafe`**: bridge to raw memory for zero-allocation field access; the basis of fast codecs.
- **Type identity & assignability**: `Type.AssignableTo`, `ConvertibleTo`, `Implements(ifaceType)` let you ask "does T satisfy this interface?" reflectively — DI containers rely on `Implements`.
- **Channels via reflect**: `reflect.Select` implements a dynamic `select` over a runtime-sized set of cases — impossible with the `select` keyword.
- **Generics interplay**: you can take `reflect.TypeOf((*T)(nil)).Elem()` inside a generic function to get the `reflect.Type` of a type parameter, blending compile-time and runtime worlds.

## 12. Debugging Tips

- Use `%+v` and `%#v` (`fmt` itself uses reflection) to dump unknown values; `%T` prints the dynamic type fast.
- Wrap reflective code in `defer func(){ recover() }()` during exploration — most reflect errors are panics, not errors.
- Print `v.Kind()`, `v.Type()`, `v.CanSet()`, `v.CanAddr()`, `v.IsValid()` at each step; nearly every bug is one of these being unexpectedly false.
- `reflect.TypeOf(x).String()` vs `.Name()` vs `.PkgPath()` disambiguate named vs anonymous vs aliased types.
- For "cannot set" panics, trace back to whether you passed a pointer and called `.Elem()`.
- `go-cmp`'s panic/diff messages tell you exactly which field differs — far better than a bare `DeepEqual` false.

## 13. Senior Engineer Notes

As a senior, your job is to keep reflection *contained*. In code review, the red flag is reflection leaking into business logic — a service method that switches on `Kind` is almost always a missing interface or a misuse of generics. Push back and ask: "Is the type set actually unbounded here?" If it's known, a type switch or generics is clearer and faster.

When you must use reflection, insist on three things in review: (1) metadata is cached per type, not recomputed; (2) every access is guarded (`CanSet`, `CanInterface`, `IsValid`); (3) there's a benchmark proving it isn't on a hot path, or that the cached plan makes it acceptable. Mentor juniors with the Laws of Reflection as the framework — most of their bugs trace to Law 3 (settability) and to mutating copies.

Design judgement: prefer wrapping reflection behind a small, well-tested helper package with a concrete API, so the rest of the codebase never imports `reflect`. This localizes the unsafe-ish surface and makes it swappable for codegen later.

## 14. Staff Engineer Notes

At the staff level the decision is **build vs. buy vs. generate**, made across teams. Runtime reflection (Uber `dig`-style DI, runtime validators) gives velocity but costs startup time, obscures errors until runtime, and resists static analysis. Code generation (Google `wire`, `easyjson`, `sqlc`, protobuf) trades a build step for compile-time safety, better performance (5–10× for serialization), and far better debuggability. For a platform consumed by many teams, generation usually wins because the cost is paid once by the platform team and the safety benefits every consumer.

Org-level trade-offs: heavy reflection frameworks become invisible coupling — a tag typo surfaces as a production 500, not a compile error. Staff engineers set policy: "binding/validation tags are linted in CI," or "no `reflect` outside `internal/serde` and `internal/di`." Consider the long tail: reflection defeats Go's dead-code elimination (the linker must keep reflected methods), inflating binary size and hurting whole-program optimization — relevant for edge/embedded deployments.

Finally, weigh ecosystem gravity. `encoding/json`'s reflection is "free" to maintain because it's stdlib; a bespoke reflective framework is a maintenance liability your org owns forever. The staff move is often to adopt codegen at the boundary and reserve reflection for genuinely dynamic, low-frequency paths (config load, DI wiring at startup) where its cost is amortized to zero.

## 15. Revision Summary

- Reflection = runtime type/value introspection via `reflect.Type` and `reflect.Value`.
- Three Laws: interface→object, object→interface (`Interface()`), set requires settable (addressable + exported).
- Interfaces are 2 words (`*itab`/`*_type` + data); `reflect.Value` carries type ptr + data ptr + a `flag` (kind/addr/RO).
- `Kind` = structural category (enum); `Type` = full named identity.
- Mutation needs `reflect.ValueOf(&x).Elem()` — passing a value copies it.
- ~10–100× slower; mitigate with cached type plans, compiled closures, or code generation.
- Production: json/xml/yaml, GORM/sqlx, validator, dig/wire, protoreflect, viper, templates.
- Guard every access: `IsValid`, `CanSet`, `CanInterface`, `IsNil`.
- Prefer `go-cmp` over `reflect.DeepEqual`; prefer generics/interfaces over reflection in business logic.
- Staff lens: build vs. generate — codegen for known type sets, reflection only at dynamic boundaries.

**References:** Rob Pike, "The Laws of Reflection" (Go blog, 2011); Go `reflect` package documentation; Russ Cox, "Go Data Structures: Interfaces"; `encoding/json` source; `google/go-cmp` and `go-playground/validator` docs.

---

*Go Engineering Handbook — topic 30.*
