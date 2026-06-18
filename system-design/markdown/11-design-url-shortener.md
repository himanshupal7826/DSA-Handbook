# 11 · Design: URL Shortener

> **In one line:** A canonical end-to-end design: encode, store, redirect, scale.

---

## 1. Overview

Designing a URL shortener (TinyURL/bit.ly) exercises the whole toolkit: key generation, a read-heavy KV store, caching, and redirects. Reads vastly outnumber writes, so caching and read scaling dominate.

## 2. Key Concepts

- Generate short keys via base62 of a counter/ID or hashing.
- Store key→URL in a KV store (read-optimized).
- Redirect: 301 (cached) vs 302 (trackable).
- Cache hot keys; CDN at the edge.
- Analytics via async events, not on the hot path.

## 3. Syntax & Code

```text
POST /shorten {url} -> id -> base62(id) = 'aZ3xK' -> store
GET /aZ3xK -> lookup (cache->DB) -> 302 redirect to url
Read:Write ~ 100:1  => cache + replicas
```

## 4. Worked Example

**Key generation choices**

Counter+base62 gives short, collision-free keys; random/hash needs collision checks.

```text
counter=125 -> base62 -> '21'   (sequential, predictable)
hash(url)[:7] -> check collision, retry if taken
```

## 5. Best Practices

- ✅ Use base62 of a unique ID for compact, collision-free keys.
- ✅ Cache hot mappings aggressively (read-heavy).
- ✅ Use 301 for cacheable redirects, 302 if you need click tracking.
- ✅ Offload analytics to a queue.
- ✅ Add replicas for read scaling.

## 6. Common Pitfalls

1. ⚠️ Random keys without collision handling.
2. ⚠️ Putting analytics writes on the redirect hot path.
3. ⚠️ No caching for a 100:1 read system.
4. ⚠️ Predictable keys enabling enumeration (if sensitive).
5. ⚠️ Storing in a write-optimized store for a read workload.
6. ⚠️ Ignoring custom-alias collisions/abuse.

## 7. Interview Questions

1. **Q: How to generate short keys?**
   A: base62-encode a unique counter/ID for compact collision-free keys, or hash+collision-check.

2. **Q: Why is it read-heavy?**
   A: Each created link is read many times — design for read scaling and caching.

3. **Q: 301 vs 302 redirect?**
   A: 301 is cacheable (less load, no tracking); 302 lets you record each click.

4. **Q: Where do analytics go?**
   A: Off the hot path — emit events to a queue and process asynchronously.

5. **Q: How to scale reads?**
   A: Cache hot keys, add read replicas, and a CDN.

6. **Q: How long are the keys?**
   A: ~7 base62 chars give 62^7 ≈ 3.5 trillion combinations.

7. **Q: Handling custom aliases?**
   A: Check uniqueness and reserve/validate them.

8. **Q: Storage choice?**
   A: A read-optimized KV store (Redis/Dynamo) fits the access pattern.

## 8. Practice

- [ ] Design the API + data model for a shortener.
- [ ] Estimate storage and QPS for 100M links.
- [ ] Choose 301 vs 302 and justify.

## 9. Quick Revision

URL shortener: base62(id) keys → KV store → cache/CDN → 301/302 redirect; read-heavy so cache+replicas dominate; analytics async via queue. Handle collisions and custom aliases.

**References:** TinyURL design

---

*System Design Handbook — topic 11.*
