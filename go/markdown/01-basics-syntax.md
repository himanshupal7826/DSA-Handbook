# 01 · Syntax, Variables & Functions

> **In one line:** Go's minimal syntax: packages, typed variables, multiple returns.

---

## 1. Overview

Go is a statically-typed, compiled language with a deliberately small syntax. Programs are organized into **packages**; `main` is the entry point. Functions can return multiple values, which underpins Go's error-handling idiom.

## 2. Key Concepts

- `:=` declares + infers type inside functions; `var` works anywhere.
- Functions return multiple values: `val, err := f()`.
- Exported identifiers start with an uppercase letter.
- Zero values: 0, "", nil, false — no uninitialized variables.
- No implicit type conversion; convert explicitly.

## 3. Syntax & Code

```go
package main

import "fmt"

// divide returns a result and an error (idiomatic multi-return).
func divide(a, b int) (int, error) {
    if b == 0 {
        return 0, fmt.Errorf("divide by zero")
    }
    return a / b, nil
}

func main() {
    q, err := divide(10, 2)
    if err != nil {
        fmt.Println("error:", err)
        return
    }
    fmt.Println("quotient:", q) // 5
}
```

## 4. Worked Example

**Named returns + defer**

Named returns can be set in a deferred function:

```go
func read() (n int, err error) {
    defer func() { if err != nil { n = 0 } }()
    // ...
    return 42, nil
}
```

## 5. Best Practices

- ✅ Handle every returned error explicitly.
- ✅ Prefer `:=` inside functions; `var` for package-level/zero-value clarity.
- ✅ Keep functions small and return early.
- ✅ Use gofmt — formatting is non-negotiable in Go.
- ✅ Group related code into packages by responsibility.

## 6. Common Pitfalls

1. ⚠️ Ignoring errors with `_` when they matter.
2. ⚠️ Shadowing variables with `:=` in inner scopes.
3. ⚠️ Unused imports/variables are compile errors.
4. ⚠️ Assuming zero value is 'unset' (it's a real value).
5. ⚠️ Mixing tabs/spaces — let gofmt handle it.
6. ⚠️ Forgetting that Go has no exceptions for normal control flow.

## 7. Interview Questions

1. **Q: How does Go handle errors?**
   A: Functions return an error value; callers check `if err != nil`. No exceptions for expected failures.

2. **Q: `:=` vs `var`?**
   A: `:=` declares with inferred type inside functions; `var` works at package scope and when you want the zero value or explicit type.

3. **Q: What are zero values?**
   A: Default initialized values: 0, false, "", nil — every variable is always initialized.

4. **Q: How are identifiers exported?**
   A: Capitalized names are exported (public) across packages; lowercase are package-private.

5. **Q: Does Go allow implicit conversions?**
   A: No — you must convert types explicitly, e.g., float64(i).

6. **Q: What is defer?**
   A: Schedules a call to run when the surrounding function returns, used for cleanup (closing files, unlocking).

7. **Q: Why are unused variables errors?**
   A: Go enforces clean code at compile time to prevent bugs and dead code.

8. **Q: Multiple return values use?**
   A: Returning (result, error) or (value, ok) pairs idiomatically.

## 8. Practice

- [ ] Write a function returning (value, error) and handle it.
- [ ] Use defer to close a resource.
- [ ] Demonstrate variable shadowing and fix it.

## 9. Quick Revision

Go: small syntax, packages, multi-return for errors, zero values, explicit conversions, gofmt-enforced style. Handle every error; defer for cleanup.

**References:** A Tour of Go

---

*Go Handbook — topic 01.*
