# 04 · Caching

> **In one line:** Serve hot data from fast memory to cut latency and load.

---

## 1. Overview

Caching stores frequently-accessed data in fast storage (memory/Redis/CDN) to reduce latency and backend load. The hard parts are **invalidation** (keeping caches fresh) and choosing a **write strategy** and **eviction policy**.

## 2. Key Concepts

- Patterns: cache-aside (lazy), write-through, write-back.
- Eviction: LRU, LFU, TTL expiry.
- CDN caches static assets near users (edge).
- Invalidation keeps cache consistent with source.
- Watch for thundering herd / cache stampede.

## 3. Syntax & Code

```text
cache-aside read:
  v = cache.get(k)
  if v is None:
     v = db.get(k); cache.set(k, v, ttl)
  return v
```

## 4. Worked Example

**Stampede protection**

On a cache miss for a hot key, use a lock or 'request coalescing' so only one request rebuilds it.

```text
miss -> acquire lock -> recompute -> set -> release
others wait or serve stale briefly
```

## 5. Best Practices

- ✅ Cache hot, expensive, read-heavy data with TTLs.
- ✅ Use cache-aside as a sensible default.
- ✅ Place a CDN in front of static content.
- ✅ Plan invalidation on writes (delete/update keys).
- ✅ Protect against stampedes (locks, jitter, stale-while-revalidate).

## 6. Common Pitfalls

1. ⚠️ Stale data from missing invalidation.
2. ⚠️ Caching everything (low hit ratio, wasted memory).
3. ⚠️ Thundering herd on popular-key expiry.
4. ⚠️ No TTL → unbounded growth/staleness.
5. ⚠️ Caching per-user data under shared keys.
6. ⚠️ Treating the cache as the source of truth.

## 7. Interview Questions

1. **Q: Why cache?**
   A: To reduce latency and backend load by serving hot data from fast memory.

2. **Q: Cache-aside vs write-through vs write-back?**
   A: Lazy fill on miss / write to cache+DB synchronously / write to cache then async to DB (fast but risk loss).

3. **Q: Eviction policies?**
   A: LRU/LFU/TTL decide what to drop when full or stale.

4. **Q: Hardest caching problem?**
   A: Invalidation — keeping cached data consistent with the source.

5. **Q: What is a cache stampede?**
   A: Many requests recomputing the same expired hot key at once; mitigate with locks/jitter/stale serving.

6. **Q: Where does a CDN fit?**
   A: Caching static/edge content close to users to cut latency and origin load.

7. **Q: How to size a cache?**
   A: From the working set and hit-ratio targets; monitor hit rate.

8. **Q: Risk of write-back?**
   A: Data loss if the cache fails before flushing to the DB.

## 8. Practice

- [ ] Implement cache-aside with TTL for a hot query.
- [ ] Add stampede protection for a popular key.
- [ ] Decide what to cache vs not for a feed.

## 9. Quick Revision

Cache hot read-heavy data (cache-aside default; write-through/back options), evict via LRU/LFU/TTL, CDN for static. Hard part = invalidation; guard against stampedes; never treat cache as source of truth.

**References:** Caching strategies

---

*System Design Handbook — topic 04.*
