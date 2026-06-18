# 09 · Caching & Async Tasks

> **In one line:** Speed up with caching layers and offload work to Celery.

---

## 1. Overview

Scale Django by **caching** expensive reads (per-view, template fragment, or low-level cache API, often backed by Redis/Memcached) and by moving slow work (emails, image processing) to **background tasks** with Celery so requests stay fast.

## 2. Key Concepts

- Cache levels: per-site, per-view, template fragment, low-level API.
- Redis/Memcached are common cache backends.
- Celery runs tasks via a broker (Redis/RabbitMQ) in workers.
- Cache invalidation is the hard part — use keys/TTLs/versioning.
- Async views (async def) for IO-bound concurrency (ASGI).

## 3. Syntax & Code

```python
from django.core.cache import cache
def top_books():
    data = cache.get('top_books')
    if data is None:
        data = list(Book.objects.order_by('-sales')[:10].values())
        cache.set('top_books', data, timeout=300)  # 5 min TTL
    return data
```

## 4. Worked Example

**Celery task**

Offload a slow email send:

```python
from celery import shared_task
@shared_task
def send_welcome(user_id):
    # slow IO runs in a worker, not the request
    ...
# call: send_welcome.delay(user.id)
```

## 5. Best Practices

- ✅ Cache hot, expensive, rarely-changing reads with TTLs.
- ✅ Invalidate on writes (signals or explicit cache.delete).
- ✅ Offload slow/IO tasks to Celery via .delay().
- ✅ Make tasks idempotent and retry-safe.
- ✅ Monitor cache hit ratio and queue depth.

## 6. Common Pitfalls

1. ⚠️ Stale cache from missing invalidation.
2. ⚠️ Caching per-user data under a shared key.
3. ⚠️ Doing slow work synchronously in the request.
4. ⚠️ Non-idempotent tasks duplicating on retry.
5. ⚠️ Unbounded cache growth without TTLs.
6. ⚠️ Storing huge objects in cache.

## 7. Interview Questions

1. **Q: What are Django's cache levels?**
   A: Per-site, per-view, template fragment, and the low-level cache API.

2. **Q: Why use Celery?**
   A: To run slow/IO-bound work asynchronously in workers so web requests stay fast.

3. **Q: Hardest part of caching?**
   A: Invalidation — keeping cached data consistent with the source of truth.

4. **Q: How to invalidate on writes?**
   A: Delete/update keys on save (signals) or use short TTLs and versioned keys.

5. **Q: Idempotent tasks — why?**
   A: Brokers may deliver/retry tasks more than once; idempotency prevents duplicate effects.

6. **Q: Sync vs async views?**
   A: Async (async def, ASGI) helps IO-bound concurrency; CPU-bound work still needs workers.

7. **Q: Redis vs Memcached?**
   A: Both fast KV caches; Redis adds persistence/data structures and doubles as a Celery broker.

8. **Q: How to call a Celery task?**
   A: task.delay(args) (or apply_async) enqueues it for a worker.

## 8. Practice

- [ ] Cache a top-N query with a TTL and invalidate on write.
- [ ] Move an email send to a Celery task.
- [ ] Add a template fragment cache.

## 9. Quick Revision

Cache hot expensive reads (Redis, TTLs, invalidate on write); offload slow work to Celery (.delay, idempotent). Watch hit ratio and queue depth; async views for IO concurrency.

**References:** Cache framework; Celery

---

*Django Handbook — topic 09.*
