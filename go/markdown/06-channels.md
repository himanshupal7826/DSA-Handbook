# 06 · Channels & select

> **In one line:** Typed pipes for goroutine communication and synchronization.

---

## 1. Overview

Channels are typed conduits that let goroutines communicate by passing values — Go's motto is *'share memory by communicating.'* Unbuffered channels synchronize sender and receiver; buffered channels decouple them. `select` waits on multiple channel operations.

## 2. Key Concepts

- Send `ch <- v`, receive `v := <-ch`. Unbuffered = rendezvous.
- Buffered channel holds N values before blocking the sender.
- Close signals 'no more values'; receivers get zero value + ok=false.
- `select` picks a ready case; `default` makes it non-blocking.
- Only the sender should close a channel; never close twice.

## 3. Syntax & Code

```go
ch := make(chan int)      // unbuffered
go func() { ch <- 42 }()  // blocks until received
v := <-ch                 // receives 42

// fan-in with select + timeout
select {
case x := <-ch:
    fmt.Println(x)
case <-time.After(time.Second):
    fmt.Println("timeout")
}
```

## 4. Worked Example

**Worker pool**

Distribute jobs over channels:

```go
jobs := make(chan int, 100)
results := make(chan int, 100)
for w := 0; w < 3; w++ {
    go func(){ for j := range jobs { results <- j*j } }()
}
for i := 1; i <= 5; i++ { jobs <- i }
close(jobs)
```

## 5. Best Practices

- ✅ Let the sender own and close the channel.
- ✅ Use buffered channels to decouple producer/consumer rates.
- ✅ Use select with context for cancellation/timeouts.
- ✅ Range over a channel to drain until closed.
- ✅ Prefer channels for ownership transfer, mutexes for shared state.

## 6. Common Pitfalls

1. ⚠️ Deadlock: sending on an unbuffered channel with no receiver.
2. ⚠️ Closing a channel twice or sending on a closed channel (panic).
3. ⚠️ Receiving from a nil channel blocks forever.
4. ⚠️ Goroutine leak when nobody drains a channel.
5. ⚠️ Assuming buffered = unlimited (it blocks when full).
6. ⚠️ Using channels where a simple mutex is clearer.

## 7. Interview Questions

1. **Q: Unbuffered vs buffered channel?**
   A: Unbuffered synchronizes sender/receiver (rendezvous); buffered allows N queued values before blocking.

2. **Q: Who should close a channel?**
   A: The sender, exactly once; closing signals completion to receivers.

3. **Q: What does select do?**
   A: Blocks until one of several channel operations is ready; default makes it non-blocking.

4. **Q: How to implement a timeout?**
   A: select with a case on time.After (or a context's Done channel).

5. **Q: What causes a channel deadlock?**
   A: All goroutines blocked, e.g., sending on an unbuffered channel with no receiver.

6. **Q: Receiving from a closed channel?**
   A: Returns the zero value immediately with ok=false.

7. **Q: Channels vs mutexes — when?**
   A: Channels to transfer ownership/coordinate; mutexes to protect shared mutable state.

8. **Q: Nil channel behavior?**
   A: Send/receive on a nil channel blocks forever — useful to disable a select case.

## 8. Practice

- [ ] Build a 3-worker pool over jobs/results channels.
- [ ] Add a timeout with select + time.After.
- [ ] Trigger and fix an unbuffered-channel deadlock.

## 9. Quick Revision

Channels pass typed values between goroutines (unbuffered=rendezvous, buffered=decouple). select multiplexes; sender closes once. Deadlocks come from no-receiver sends and nil channels.

**References:** Go blog: Share memory by communicating

---

*Go Handbook — topic 06.*
