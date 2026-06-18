# 10 · Rate Limiting & Resilience

> **In one line:** Protect systems with limits, timeouts, and circuit breakers.

---

## 1. Overview

Resilience patterns keep systems stable under load and partial failure: **rate limiting** (token/leaky bucket, sliding window) caps request rates; **timeouts, retries with backoff, and circuit breakers** prevent cascading failures and resource exhaustion.

## 2. Key Concepts

- Token bucket allows bursts up to a capacity, refilled at a rate.
- Sliding window smooths fixed-window edge bursts.
- Distributed rate limiting uses a shared store (Redis).
- Timeouts + retries (with jittered backoff) handle transient failures.
- Circuit breakers stop calling a failing dependency.

## 3. Syntax & Code

```text
Token bucket: capacity C, refill R/sec
  on request: if tokens>0: tokens--; allow  else: reject(429)
Circuit breaker: closed -> (failures>threshold) -> open -> half-open -> closed
```

## 4. Worked Example

**Retry with backoff + jitter**

Avoid retry storms by spacing retries with exponential backoff and randomness.

```text
attempt n: wait = min(cap, base * 2^n) + random_jitter
```

## 5. Best Practices

- ✅ Rate-limit per user/IP/key to prevent abuse.
- ✅ Use token bucket for burst tolerance.
- ✅ Always set timeouts on remote calls.
- ✅ Retry idempotent ops with exponential backoff + jitter.
- ✅ Add circuit breakers around flaky dependencies.

## 6. Common Pitfalls

1. ⚠️ No timeouts → threads pile up on a slow dependency.
2. ⚠️ Retrying non-idempotent operations (duplicate effects).
3. ⚠️ Retry storms without backoff/jitter (thundering herd).
4. ⚠️ Fixed-window limiting allowing edge bursts.
5. ⚠️ Local-only limits in a distributed fleet.
6. ⚠️ No circuit breaker → cascading failures.

## 7. Interview Questions

1. **Q: Common rate-limiting algorithms?**
   A: Token bucket, leaky bucket, fixed window, sliding window (log/counter).

2. **Q: Token vs leaky bucket?**
   A: Token bucket allows bursts up to capacity; leaky bucket enforces a steady output rate.

3. **Q: Why timeouts on remote calls?**
   A: To free resources and avoid pile-ups when a dependency is slow.

4. **Q: How to retry safely?**
   A: Only idempotent operations, with exponential backoff and jitter, bounded attempts.

5. **Q: What does a circuit breaker do?**
   A: Stops calling a failing service after a threshold, allowing it to recover; probes via half-open.

6. **Q: Distributed rate limiting?**
   A: Coordinate counts in a shared store (e.g., Redis) across instances.

7. **Q: Fixed vs sliding window?**
   A: Sliding window avoids the double-burst at fixed-window boundaries.

8. **Q: How to prevent retry storms?**
   A: Backoff + jitter and circuit breakers.

## 8. Practice

- [ ] Implement token-bucket limiting logic.
- [ ] Add timeout + backoff retry to an API call.
- [ ] Describe a circuit breaker's state transitions.

## 9. Quick Revision

Resilience: rate limit (token/leaky bucket, sliding window; distributed via Redis), timeouts, idempotent retries with backoff+jitter, circuit breakers. Prevent pile-ups, retry storms, and cascading failure.

**References:** Rate limiting algorithms

---

*System Design Handbook — topic 10.*
