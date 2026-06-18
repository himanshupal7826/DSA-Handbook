# 07 · Context: Cancellation & Deadlines

> **In one line:** Propagate cancellation, deadlines, and request values.

---

## 1. Overview

`context.Context` carries cancellation signals, deadlines, and request-scoped values across API boundaries and goroutines. It's the standard way to stop work (HTTP requests, DB queries) when the caller gives up.

## 2. Key Concepts

- Pass ctx as the first parameter: `func F(ctx context.Context, ...)`.
- WithCancel/WithTimeout/WithDeadline derive child contexts.
- Select on `ctx.Done()` to abort blocking work.
- Always call the cancel function (defer cancel()).
- Don't store contexts in structs; pass them explicitly.

## 3. Syntax & Code

```go
ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
defer cancel()

select {
case res := <-doWork(ctx):
    fmt.Println(res)
case <-ctx.Done():
    fmt.Println("aborted:", ctx.Err()) // deadline exceeded / canceled
}
```

## 4. Worked Example

**Propagating cancellation**

Downstream calls inherit the deadline:

```go
func handler(ctx context.Context) error {
    rows, err := db.QueryContext(ctx, "SELECT ...") // canceled if ctx is
    _ = rows
    return err
}
```

## 5. Best Practices

- ✅ Thread ctx through all blocking/IO calls.
- ✅ Always defer cancel() to release resources.
- ✅ Use context.Background() at the top; derive children below.
- ✅ Check ctx.Err() to know why work stopped.
- ✅ Keep request-scoped values minimal and typed via keys.

## 6. Common Pitfalls

1. ⚠️ Forgetting defer cancel() → context/timer leak.
2. ⚠️ Storing context in a struct field.
3. ⚠️ Ignoring ctx.Done() in long loops (no cancellation).
4. ⚠️ Putting large/optional data in context values.
5. ⚠️ Passing nil context (use Background/TODO).
6. ⚠️ Assuming cancellation is instant — code must check it.

## 7. Interview Questions

1. **Q: What is context used for?**
   A: Propagating cancellation, deadlines/timeouts, and request-scoped values across goroutines and APIs.

2. **Q: Why defer cancel()?**
   A: To release the context's resources/timer even on the happy path; not calling it leaks.

3. **Q: How does a goroutine observe cancellation?**
   A: By selecting on ctx.Done() and returning when it closes.

4. **Q: WithTimeout vs WithDeadline?**
   A: Timeout is relative duration; deadline is an absolute time — both auto-cancel.

5. **Q: Where should ctx go in a signature?**
   A: First parameter, conventionally named ctx.

6. **Q: Should context carry business data?**
   A: No — only request-scoped values like auth/trace IDs, kept small.

7. **Q: What does ctx.Err() return?**
   A: nil if active, else context.Canceled or context.DeadlineExceeded.

8. **Q: Background vs TODO?**
   A: Background is the root for real use; TODO marks unfinished plumbing.

## 8. Practice

- [ ] Add a 2s timeout around a blocking call.
- [ ] Propagate ctx into a DB/HTTP call.
- [ ] Make a worker loop honor ctx.Done().

## 9. Quick Revision

Context propagates cancel/deadline/values; pass as first arg, defer cancel(), select on Done(). Don't store in structs or stuff business data in it.

**References:** Go blog: Context

---

*Go Handbook — topic 07.*
