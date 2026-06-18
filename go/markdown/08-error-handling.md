# 08 · Error Handling & Wrapping

> **In one line:** Explicit errors, wrapping, and sentinel/typed errors.

---

## 1. Overview

Go treats errors as values. Wrap errors with `%w` to add context while preserving the chain; inspect with `errors.Is` (sentinel match) and `errors.As` (typed extraction). `panic`/`recover` are for truly exceptional, unrecoverable situations — not control flow.

## 2. Key Concepts

- Return errors; don't throw. Check `if err != nil`.
- Wrap with fmt.Errorf("...: %w", err) to keep the cause.
- errors.Is compares against a sentinel; errors.As extracts a type.
- Sentinel errors (var ErrNotFound = errors.New(...)) for known cases.
- panic/recover only at boundaries (e.g., top of a goroutine).

## 3. Syntax & Code

```go
var ErrNotFound = errors.New("not found")

func get(id int) (User, error) {
    u, ok := store[id]
    if !ok {
        return User{}, fmt.Errorf("get user %d: %w", id, ErrNotFound)
    }
    return u, nil
}

// caller
if errors.Is(err, ErrNotFound) { /* handle 404 */ }
```

## 4. Worked Example

**Typed error extraction**

errors.As pulls out a concrete error type:

```go
var perr *os.PathError
if errors.As(err, &perr) {
    fmt.Println("path:", perr.Path)
}
```

## 5. Best Practices

- ✅ Wrap with %w to add context at each layer.
- ✅ Define sentinel/typed errors for cases callers branch on.
- ✅ Inspect with errors.Is/As, not string matching.
- ✅ Don't log and return the same error repeatedly.
- ✅ Reserve panic for programmer errors / unrecoverable states.

## 6. Common Pitfalls

1. ⚠️ Comparing errors with == after wrapping (use errors.Is).
2. ⚠️ String-matching error messages.
3. ⚠️ Swallowing errors with _.
4. ⚠️ Wrapping without context (just returning err loses the call site value-add).
5. ⚠️ Using panic for normal control flow.
6. ⚠️ recover() in the wrong goroutine (it only catches its own).

## 7. Interview Questions

1. **Q: How does Go signal errors?**
   A: As ordinary return values checked with if err != nil — no exceptions for expected failures.

2. **Q: What does %w do?**
   A: Wraps an error preserving the chain so errors.Is/As can inspect the cause.

3. **Q: errors.Is vs errors.As?**
   A: Is checks equality against a sentinel through the chain; As extracts a matching concrete type.

4. **Q: When use panic/recover?**
   A: Only for unrecoverable/programmer errors or at goroutine/server boundaries to avoid crashing the process.

5. **Q: Sentinel error pattern?**
   A: Exported `var ErrX = errors.New(...)` that callers match with errors.Is.

6. **Q: Why not match error strings?**
   A: Brittle; wrapping/i18n changes them. Use typed/sentinel checks.

7. **Q: Does recover work across goroutines?**
   A: No — recover only catches panics in its own goroutine.

8. **Q: How to add context without losing the cause?**
   A: fmt.Errorf with %w including identifiers like ids/operations.

## 8. Practice

- [ ] Wrap an error with %w and match it via errors.Is.
- [ ] Extract a typed error with errors.As.
- [ ] Add a recover at the top of a goroutine.

## 9. Quick Revision

Errors are values: return + check, wrap with %w, inspect with errors.Is/As, define sentinels/typed errors. panic/recover only for the truly exceptional, per-goroutine.

**References:** Go blog: Error handling

---

*Go Handbook — topic 08.*
