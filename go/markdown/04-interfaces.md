# 04 · Interfaces

> **In one line:** Implicit, duck-typed interfaces for decoupling.

---

## 1. Overview

A Go interface is a set of method signatures. Types satisfy interfaces **implicitly** — no `implements` keyword. This enables loose coupling and testability. `any` (empty interface) holds any value; type assertions/switches recover the concrete type.

## 2. Key Concepts

- Implicit satisfaction: implement the methods and you satisfy the interface.
- Accept interfaces, return concrete types (a common guideline).
- An interface value is (type, value); nil interface vs nil pointer differ.
- Type assertion `v, ok := x.(T)`; type switch for many cases.
- Keep interfaces small (often one method).

## 3. Syntax & Code

```go
type Stringer interface{ String() string }

type Point struct{ X, Y int }
func (p Point) String() string { return fmt.Sprintf("(%d,%d)", p.X, p.Y) }

func print(s Stringer) { fmt.Println(s.String()) }
// Point satisfies Stringer implicitly
```

## 4. Worked Example

**Type switch**

Branch on the dynamic type held by an interface:

```go
func describe(x any) string {
    switch v := x.(type) {
    case int:    return fmt.Sprintf("int %d", v)
    case string: return "string " + v
    default:     return "unknown"
    }
}
```

## 5. Best Practices

- ✅ Keep interfaces small (io.Reader/Writer style).
- ✅ Define interfaces where they're consumed, not where implemented.
- ✅ Accept interfaces as parameters for flexibility/testing.
- ✅ Use type switches sparingly; prefer polymorphic methods.
- ✅ Return concrete types so callers retain full API.

## 6. Common Pitfalls

1. ⚠️ The nil-interface trap: a nil *T stored in an interface is non-nil.
2. ⚠️ Huge interfaces that are hard to implement/mock.
3. ⚠️ Overusing `any` and losing type safety.
4. ⚠️ Type-asserting without the comma-ok and panicking.
5. ⚠️ Defining interfaces prematurely (speculative abstraction).
6. ⚠️ Comparing interface values holding uncomparable types (panics).

## 7. Interview Questions

1. **Q: How are interfaces satisfied in Go?**
   A: Implicitly — a type that has the required methods satisfies the interface, no declaration needed.

2. **Q: The nil interface gotcha?**
   A: An interface holding a nil pointer has a non-nil type, so `iface != nil` is true unexpectedly.

3. **Q: Why keep interfaces small?**
   A: Small interfaces are easy to implement, mock, and compose (e.g., io.Reader).

4. **Q: Type assertion vs type switch?**
   A: Assertion extracts one concrete type (with ok); switch branches across many types.

5. **Q: 'Accept interfaces, return structs' — why?**
   A: Flexible inputs for callers/tests, concrete outputs preserve the full API.

6. **Q: What is the empty interface?**
   A: `any`/`interface{}` holds any value; recover the concrete type via assertion/switch.

7. **Q: Where to define interfaces?**
   A: At the consumer, so packages depend on behavior they need, not implementations.

8. **Q: How does an interface value compare?**
   A: Equal if both type and value are equal; panics if the dynamic type is uncomparable.

## 8. Practice

- [ ] Implement io.Writer for a custom buffer.
- [ ] Use a type switch to handle multiple input types.
- [ ] Trigger and explain the nil-interface trap.

## 9. Quick Revision

Interfaces = implicit method sets for decoupling. Keep them small, define at the consumer, accept interfaces/return concretes. Mind the nil-interface trap and prefer comma-ok assertions.

**References:** Effective Go: Interfaces

---

*Go Handbook — topic 04.*
