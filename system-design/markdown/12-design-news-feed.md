# 12 · Design: News Feed

> **In one line:** Fan-out on write vs read; the celebrity problem.

---

## 1. Overview

A social **news feed** (Twitter/Instagram) tests the fan-out trade-off: **push** (precompute each follower's timeline on write) gives fast reads but expensive writes; **pull** (assemble at read time) is cheap to write but slow to read. A **hybrid** handles celebrities.

## 2. Key Concepts

- Fan-out-on-write (push): precompute timelines; fast reads, heavy writes.
- Fan-out-on-read (pull): merge at read time; cheap writes, slow reads.
- Celebrity problem: huge follower counts make push explode.
- Hybrid: push for most, pull for celebrities.
- Rank by recency/relevance; cache hot timelines.

## 3. Syntax & Code

```text
Push:  user posts -> write into each follower's feed cache
Pull:  user opens feed -> fetch + merge recent posts of followees
Hybrid: push normally; for celebrities, pull their posts at read
```

## 4. Worked Example

**Why hybrid**

Pushing a celebrity's post to 100M timelines is infeasible; instead followers pull celebrity posts and merge with their pushed feed.

```text
follower feed = precomputed(push) ∪ pull(celebrity_followees)
```

## 5. Best Practices

- ✅ Use fan-out-on-write for typical users (read-optimized).
- ✅ Switch to pull/hybrid for high-follower accounts.
- ✅ Cache materialized timelines.
- ✅ Paginate with cursors, not offsets.
- ✅ Rank and trim feeds; store limited timeline length.

## 6. Common Pitfalls

1. ⚠️ Pure push breaking on celebrities (write amplification).
2. ⚠️ Pure pull being too slow for active users.
3. ⚠️ Unbounded timeline storage.
4. ⚠️ Offset pagination at scale.
5. ⚠️ Ignoring ranking/freshness.
6. ⚠️ Recomputing feeds synchronously on the request path.

## 7. Interview Questions

1. **Q: Fan-out on write vs read?**
   A: Push precomputes timelines (fast reads, costly writes); pull assembles on read (cheap writes, slow reads).

2. **Q: What is the celebrity problem?**
   A: Accounts with millions of followers make fan-out-on-write explode; handle via pull/hybrid.

3. **Q: Why hybrid?**
   A: Push for normal users' fast reads, pull for celebrities to avoid massive write fan-out.

4. **Q: How to paginate a feed?**
   A: Cursor/keyset pagination on time/id, not offsets.

5. **Q: How to keep feeds fresh?**
   A: Async fan-out via queues and ranking by recency/relevance.

6. **Q: Storage for timelines?**
   A: A cache/KV store of bounded length per user.

7. **Q: How to scale reads?**
   A: Materialized, cached timelines plus replicas/CDN.

8. **Q: How is ranking done?**
   A: Score posts by recency, affinity, and engagement signals.

## 8. Practice

- [ ] Compare push vs pull for a 10M-user feed.
- [ ] Design a hybrid approach for celebrities.
- [ ] Choose a pagination strategy and justify.

## 9. Quick Revision

News feed: push (fast reads/heavy writes) vs pull (cheap writes/slow reads); hybrid for the celebrity problem. Cache timelines, cursor-paginate, rank by recency/relevance, fan-out async.

**References:** Feed system design

---

*System Design Handbook — topic 12.*
