# 09 · Generics

> **In one line:** Type parameters for reusable, type-safe code (Go 1.18+).

---

## 1. Overview

Generics let functions and types operate over a set of types via **type parameters** with **constraints**. They replace many uses of `interface{}` + reflection with compile-time type safety, useful for containers and algorithms.

## 2. Key Concepts

- `func Map[T, U any](s []T, f func(T) U) []U` — type params in brackets.
- Constraints limit allowed types (e.g., comparable, constraints.Ordered).
- The compiler infers type args from arguments when possible.
- Use generics for data structures/algorithms, not everything.
- Constraints are interfaces (method or type sets).

## 3. Syntax & Code

```go
func Map[T, U any](s []T, f func(T) U) []U {
    out := make([]U, len(s))
    for i, v := range s {
        out[i] = f(v)
    }
    return out
}

doubled := Map([]int{1, 2, 3}, func(x int) int { return x * 2 })
```

## 4. Worked Example

**Ordered constraint**

A generic Max using a type-set constraint:

```go
type Ordered interface { ~int | ~int64 | ~float64 | ~string }
func Max[T Ordered](a, b T) T { if a > b { return a }; return b }
```

## 5. Best Practices

- ✅ Use generics for collections/algorithms with repeated logic.
- ✅ Pick the narrowest constraint that works.
- ✅ Let type inference reduce verbosity.
- ✅ Prefer concrete types when only one type is used.
- ✅ Combine with interfaces when behavior (methods) is needed.

## 6. Common Pitfalls

1. ⚠️ Over-engineering simple code with type parameters.
2. ⚠️ Constraints too broad (any) losing needed operations.
3. ⚠️ Confusing method-based vs type-set constraints.
4. ⚠️ Expecting generic specialization to always speed things up.
5. ⚠️ Forgetting ~ for underlying-type constraints.
6. ⚠️ Generic code that's harder to read than a small duplication.

## 7. Interview Questions

1. **Q: What problem do generics solve?**
   A: Type-safe reuse over many types without interface{}+reflection or copy-paste.

2. **Q: What is a constraint?**
   A: An interface limiting acceptable type arguments (methods and/or a type set).

3. **Q: comparable constraint?**
   A: Permits == and map keys; used for generic sets/dedup.

4. **Q: When NOT to use generics?**
   A: When a single concrete type suffices or an interface models the behavior better.

5. **Q: How does inference help?**
   A: The compiler deduces type arguments from the call's argument types.

6. **Q: What does ~int mean in a constraint?**
   A: Any type whose underlying type is int (includes named types).

7. **Q: Generics vs interfaces?**
   A: Generics give compile-time type identity/reuse; interfaces give runtime polymorphism over behavior.

8. **Q: Performance of generics?**
   A: Generally good; the compiler may share instantiations (gcshape) — measure if critical.

## 8. Practice

- [ ] Write a generic Filter[T].
- [ ] Implement Max with an Ordered constraint.
- [ ] Build a generic Set[T comparable].

## 9. Quick Revision

Generics = type parameters + constraints for type-safe reuse (containers/algorithms). Use narrow constraints, lean on inference, and don't over-abstract simple code.

**References:** Go generics tutorial

---

*Go Handbook — topic 09.*
