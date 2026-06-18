# 03 · Structs & Methods

> **In one line:** Compose data with structs; attach behavior with methods.

---

## 1. Overview

Structs group fields; methods attach behavior to types via a **receiver**. Go favors **composition via embedding** over inheritance. Pointer vs value receivers determine whether methods can mutate and affect copying cost.

## 2. Key Concepts

- Pointer receiver `(*T)` can mutate and avoids copying; value receiver `(T)` operates on a copy.
- Embed a type to promote its fields/methods (composition).
- Struct values are copied on assignment and function calls.
- Zero-value structs are usable if designed for it.

## 3. Syntax & Code

```go
type Counter struct{ n int }

// pointer receiver: mutates the original
func (c *Counter) Inc() { c.n++ }

// value receiver: read-only view
func (c Counter) Value() int { return c.n }

func main() {
    c := Counter{}
    c.Inc(); c.Inc()
    fmt.Println(c.Value()) // 2
}
```

## 4. Worked Example

**Embedding for composition**

Promote methods from an embedded type:

```go
type Logger struct{ prefix string }
func (l Logger) Log(s string) { fmt.Println(l.prefix, s) }

type Service struct {
    Logger // embedded
    name string
}
// s.Log(...) works via promotion
```

## 5. Best Practices

- ✅ Use pointer receivers when mutating or for large structs; be consistent per type.
- ✅ Prefer composition (embedding) over deep type hierarchies.
- ✅ Design zero values to be useful (e.g., bytes.Buffer).
- ✅ Keep structs focused; avoid giant god-structs.
- ✅ Document exported struct fields.

## 6. Common Pitfalls

1. ⚠️ Mixing value and pointer receivers on the same type causing method-set confusion.
2. ⚠️ Mutating a value receiver expecting it to persist (it won't).
3. ⚠️ Copying a struct that contains a mutex (copies the lock).
4. ⚠️ Embedding ambiguity when two embedded types share a method name.
5. ⚠️ Large struct value copies hurting performance.
6. ⚠️ Exported fields breaking invariants without validation.

## 7. Interview Questions

1. **Q: Pointer vs value receiver?**
   A: Pointer can mutate and avoids copying; value works on a copy. Be consistent within a type.

2. **Q: How does Go do inheritance?**
   A: It doesn't — it uses composition via embedding, promoting fields and methods.

3. **Q: What is a method set?**
   A: The set of methods callable on a type/pointer; pointer receivers are only in the pointer's method set.

4. **Q: Why not copy a struct with a mutex?**
   A: Copying duplicates lock state, breaking mutual exclusion; pass by pointer.

5. **Q: Embedding vs subclassing?**
   A: Embedding promotes members but has no virtual dispatch/override; it's composition.

6. **Q: When are structs copied?**
   A: On assignment, function arguments, and range over a slice of structs.

7. **Q: Zero-value usability?**
   A: Designing types so the zero value works without initialization (idiomatic).

8. **Q: Field tags?**
   A: Struct tags (e.g., `json:"name"`) provide metadata for reflection-based libraries.

## 8. Practice

- [ ] Add Inc/Value methods with correct receivers.
- [ ] Embed a Logger into a Service.
- [ ] Show a value-receiver mutation bug and fix it.

## 9. Quick Revision

Structs group data; methods attach behavior via receivers (pointer=mutate/cheap, value=copy). Compose via embedding, not inheritance; don't copy structs holding mutexes.

**References:** Effective Go

---

*Go Handbook — topic 03.*
