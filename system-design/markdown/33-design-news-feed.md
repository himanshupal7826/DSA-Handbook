# 33 · Design: News Feed / Twitter Timeline

> **In one line:** Assemble a personalized, ranked list of recent posts from the people you follow — where the whole design hinges on *when* you do the fan-out and how you handle celebrities.

---

## 1. Problem & Requirements

A news feed (Twitter home timeline, Instagram feed, Facebook feed) shows a user the recent posts from accounts they follow, usually ranked. The interview crux is **fan-out**: do you push a new post to every follower's timeline at write time, or pull-and-merge followees' posts at read time? The right answer at scale is *both* — a **hybrid**, forced by the celebrity problem.

**Functional**
- **Post**: a user publishes a tweet/post (text, media refs).
- **Follow/unfollow**: build the social graph.
- **View timeline**: fetch the top-N recent (or ranked) posts from followed accounts, paginated (infinite scroll).
- **Ranking**: order by relevance, not strictly chronological (optional but expected at senior level).

**Non-functional**
- **Scale**: ~300M DAU, ~500M posts/day, average fan-out (followers) skewed: median ~200, but celebrities have **100M+** followers.
- **Latency**: timeline load p99 < **200 ms** — it's the app's home screen. This is the number that pushes work to write time.
- **Availability**: 99.99% on read. Feed being stale is fine; feed being *down* is not.
- **Consistency**: **eventual**. A post appearing in followers' feeds a few seconds late is completely acceptable. Timelines are not transactional.
- **Read:write ratio**: extremely read-heavy — a timeline is viewed far more often than posts are created.

## 2. Capacity Estimation

```text
USERS & POSTS
  DAU                  = 300,000,000
  Posts/day            = 500,000,000
  Post write QPS (avg) = 500M / 86,400   ≈ 5,800  posts/s
  Post write QPS (peak)≈ 17,000 posts/s

TIMELINE READS
  Avg user opens feed ~10×/day, refresh -> ~5B timeline reads/day
  Read QPS (avg)       = 5B / 86,400     ≈ 58,000 reads/s
  Read QPS (peak 3×)   ≈ 175,000 reads/s

FAN-OUT COST (the crux)
  Avg followers ~200  -> a normal post writes to 200 timelines.
  5,800 posts/s * 200 = 1.16M timeline-writes/s on average  (fan-out on write)
  A celebrity with 100M followers posting once = 100,000,000 timeline writes
    -> a single such post = ~1.16M writes/s if flushed in ~1 min. Unbounded spike.
  THIS is why pure fan-out-on-write breaks. Hence hybrid.

STORAGE (precomputed timelines)
  Store ~800 post-IDs per user timeline * 8B (id) + metadata ~ a few KB/user
  300M users * ~3KB = ~900 GB of timeline cache -> Redis cluster (sharded)
  Posts themselves: 500M/day * ~1KB (text+meta, media in blob store)
                    = 500 GB/day  -> ~180 TB/yr in a sharded post store
```

**Takeaway:** average fan-out is manageable (~1.16M writes/s, absorbable by a Redis fleet), but **celebrities make the write cost per post unbounded**. The design must special-case high-follower accounts.

## 3. API Design

```http
POST /api/v1/posts
  Body: { "text": "...", "mediaIds": ["m1"] }
  201 { "postId": "p_98211", "createdAt": "..." }

GET /api/v1/timeline?limit=30&cursor=<opaque>
  200 { "items": [ { "postId": "p_98211", "authorId": "u_7",
                     "text": "...", "score": 0.83, "createdAt": "..." }, ... ],
        "nextCursor": "<opaque>" }

POST /api/v1/follow    { "targetId": "u_42" }   -> 204
DELETE /api/v1/follow/{targetId}                 -> 204
```

Timeline uses **cursor pagination** (opaque cursor = last seen post position/score), never `OFFSET` — offsets get slow and skip/duplicate items as new posts arrive.

## 4. Data Model

```text
posts        (sharded by post_id; KV / wide-column)
  post_id (PK)  author_id  text  media_ids[]  created_at

follows      (graph; adjacency lists, both directions cached)
  follower_id  followee_id  created_at
  -- index both ways: "who I follow" (read/pull) and "my followers" (fan-out)

user_timeline  (Redis: per-user list of post_ids, the PRECOMPUTED feed)
  key = timeline:{user_id}  ->  sorted set of (post_id, score/timestamp), capped ~800

user_meta
  user_id  follower_count  is_celebrity (follower_count > THRESHOLD, e.g. 100K)
```

**Datastore choice:** posts in a sharded KV/wide-column store (Cassandra/DynamoDB) partitioned by `post_id`. The social graph in a graph-aware store or adjacency lists in Cassandra. Precomputed timelines live in **Redis sorted sets** (score = timestamp or rank) — the whole point is O(log N) inserts and O(N) range reads for the top posts.

## 5. High-Level Design

On post, a **Fan-out Service** decides: for a normal author, push the post-ID into each follower's Redis timeline (**fan-out on write**). For a celebrity, do nothing at write time — their posts are **pulled at read time** and merged. Reading a timeline returns the precomputed Redis list, then merges in fresh posts from any celebrities the user follows, then ranks.

```svg
<svg viewBox="0 0 780 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="390" y="18" text-anchor="middle" fill="#64748b">Hybrid fan-out: normal authors push on write; celebrities are pulled on read</text>

  <!-- WRITE side -->
  <rect x="20" y="60" width="90" height="42" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="65" y="86" text-anchor="middle" fill="#1e293b">Author</text>

  <rect x="150" y="60" width="100" height="42" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="200" y="80" text-anchor="middle" fill="#1e293b">Post</text>
  <text x="200" y="96" text-anchor="middle" fill="#1e293b">Service</text>

  <rect x="150" y="130" width="100" height="42" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="200" y="150" text-anchor="middle" fill="#1e293b">Post Store</text>
  <text x="200" y="166" text-anchor="middle" fill="#64748b">Cassandra</text>

  <rect x="300" y="60" width="110" height="42" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="355" y="80" text-anchor="middle" fill="#1e293b">Fan-out</text>
  <text x="355" y="96" text-anchor="middle" fill="#1e293b">Service</text>

  <rect x="300" y="130" width="110" height="34" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="355" y="152" text-anchor="middle" fill="#1e293b">Kafka (fan-out jobs)</text>

  <!-- timeline cache -->
  <rect x="470" y="90" width="130" height="52" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="535" y="112" text-anchor="middle" fill="#1e293b">Redis timelines</text>
  <text x="535" y="128" text-anchor="middle" fill="#64748b">sorted set / user</text>

  <!-- celebrity note -->
  <rect x="300" y="200" width="110" height="42" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="355" y="220" text-anchor="middle" fill="#1e293b">Celebrity?</text>
  <text x="355" y="236" text-anchor="middle" fill="#b91c1c">skip write</text>

  <!-- READ side -->
  <rect x="20" y="300" width="90" height="42" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="65" y="326" text-anchor="middle" fill="#1e293b">Reader</text>

  <rect x="150" y="300" width="110" height="42" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="205" y="320" text-anchor="middle" fill="#1e293b">Timeline</text>
  <text x="205" y="336" text-anchor="middle" fill="#1e293b">Service</text>

  <rect x="300" y="300" width="110" height="42" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="355" y="320" text-anchor="middle" fill="#1e293b">Ranking</text>
  <text x="355" y="336" text-anchor="middle" fill="#1e293b">Service</text>

  <!-- write arrows -->
  <line x1="110" y1="81" x2="148" y2="81" stroke="#475569" marker-end="url(#a2)"/>
  <line x1="200" y1="102" x2="200" y2="128" stroke="#475569" marker-end="url(#a2)"/>
  <line x1="250" y1="81" x2="298" y2="81" stroke="#475569" marker-end="url(#a2)"/>
  <line x1="355" y1="102" x2="355" y2="128" stroke="#475569" marker-end="url(#a2)"/>
  <line x1="410" y1="140" x2="468" y2="118" stroke="#475569" marker-end="url(#a2)"/>
  <line x1="355" y1="164" x2="355" y2="198" stroke="#475569" marker-end="url(#a2)" stroke-dasharray="4 3"/>

  <!-- read arrows -->
  <line x1="110" y1="321" x2="148" y2="321" stroke="#475569" marker-end="url(#a2)"/>
  <line x1="260" y1="321" x2="298" y2="321" stroke="#475569" marker-end="url(#a2)"/>
  <line x1="410" y1="315" x2="500" y2="315" stroke="#475569" marker-end="url(#a2)"/>
  <line x1="535" y1="300" x2="535" y2="144" stroke="#475569" marker-end="url(#a2)" stroke-dasharray="4 3"/>
  <text x="548" y="230" fill="#64748b" font-size="11">read cached</text>
  <text x="548" y="246" fill="#64748b" font-size="11">timeline</text>
</svg>
```

## 6. Deep Dive

### 6.1 Fan-out on write vs fan-out on read

| Model | On post | On read | Pros | Cons |
|---|---|---|---|---|
| **Fan-out on write (push)** | Write post-ID into every follower's timeline | Just read your precomputed list | **Fast reads** (O(1) lookup); read path trivial | Expensive/slow writes for high-follower users; wasted work for inactive followers; write amplification |
| **Fan-out on read (pull)** | Just store the post | Gather posts from everyone you follow, merge, sort | Cheap writes; no wasted work; always fresh | **Slow reads** (fan-in over hundreds of followees); heavy read-time compute |

**Push** optimizes the common case (reads dominate) by precomputing. **Pull** avoids the celebrity write explosion. Neither alone works at Twitter scale — push dies on celebrities, pull dies on read latency for everyone.

### 6.2 The celebrity / hot-user problem → hybrid fan-out

A user with 100M followers posting = 100M timeline writes per post. Under pure push that's an unbounded, bursty write storm that can lag fan-out by minutes and blow up Redis. The fix:

- Classify authors as **normal** vs **celebrity** by follower count (threshold ~100K, tunable).
- **Normal author → push:** fan out to followers' Redis timelines at write time (via Kafka jobs, async).
- **Celebrity → no push:** their post is only written to the post store. At read time, the Timeline Service **pulls** the celebrity's recent posts and **merges** them into the reader's precomputed timeline.

So a reader's feed = `precomputed_timeline (from normal followees)` ∪ `fresh posts pulled from the ≤ few celebrities they follow`, merged by score. A user follows at most a handful of celebrities, so the read-time merge is cheap and bounded — the best of both models.

```text
Read timeline(user):
  base   = ZREVRANGE timeline:{user}  0  N          # push results, precomputed
  celebs = [c for c in followees(user) if is_celebrity(c)]   # small set
  fresh  = for c in celebs: recent_posts(c)          # pull, cache celeb posts hard
  merged = rank(base + fresh)
  return top N of merged
```

### 6.3 Feed ranking

Chronological is the baseline; ranked feeds score each candidate post. A practical two-stage design:
1. **Candidate generation** — the hybrid fan-out above produces the candidate set (a few hundred posts).
2. **Scoring** — a lightweight model scores each candidate on features: recency, author affinity (how much you engage with them), predicted engagement (p(like), p(reply)), media type, and diversity penalties. Sort by score.

Ranking must stay within the 200ms budget, so scoring runs on a bounded candidate set (not the entire graph) and heavy ML features are precomputed offline. Store the score in the Redis sorted set so re-reads are cheap.

### 6.4 Timeline storage & caching

Precomputed timelines are **Redis sorted sets**, one per user, **capped** at ~800 entries (`ZADD` then trim). Storing only **post-IDs** (not full posts) keeps them tiny; the actual post bodies are fetched from the post store / a post cache and hydrated at read time. This means an edited/deleted post is reflected everywhere without rewriting every timeline. Inactive users' timelines can be evicted and lazily rebuilt on next login (don't fan out to someone who hasn't opened the app in 30 days).

## 7. Bottlenecks & Scaling

- **Celebrity write storm:** solved by hybrid (don't push celebrity posts). Threshold is tunable per hot-user.
- **Fan-out lag:** async fan-out via Kafka can lag under bursts. Prioritize active followers first; accept eventual delivery for the long tail.
- **Redis hot shards:** shard timelines by `user_id`; a single mega-follower's *timeline* isn't hot (it's their followers' timelines that get writes), so heat spreads naturally.
- **Wasted fan-out to inactive users:** don't maintain timelines for dormant accounts; rebuild lazily. Huge write savings.
- **Read fan-in for celebrities:** cache celebrity recent-posts extremely hard (they're read by millions) — a single cached list serves all their followers.
- **Post store hot reads:** popular posts hit a post cache; hydrate IDs → bodies in batches.
- **Thundering herd on rebuild:** use single-flight / request coalescing when rebuilding an evicted timeline.

## 8. Failure Scenarios

| Failure | Blast radius | Mitigation |
|---|---|---|
| Redis timeline shard down | Those users' feeds unavailable | Replicas + failover; **rebuild from post store** on the fly (pull mode as fallback) |
| Fan-out worker backlog | New posts appear late in feeds | Async Kafka buffering; autoscale workers; prioritize active followers |
| Celebrity misclassified as normal | Write storm on their post | Dynamic threshold + circuit breaker: if a fan-out job exceeds N writes, abort push and flip that author to pull |
| Post store shard down | Some post bodies missing | Replication ≥ 3; serve partial feed, skip unhydratable posts |
| Ranking service down | No personalized order | Fall back to **chronological** — degrade ranking, never the whole feed |
| Kafka down | No fan-out at all | Buffer/replay; readers still see cached timelines + pulled celebrity posts |
| Hot post (viral) | Post-cache node saturated | Replicate hot post across cache nodes / edge cache |

## 9. Trade-offs & Alternatives

- **Hybrid vs pure push/pull:** hybrid is more complex (two code paths, a classifier) but is the only thing that survives both celebrities and read latency. Pure push is simpler and fine *below* the celebrity scale.
- **Store IDs vs full posts in timelines:** IDs keep timelines tiny and make edits/deletes trivial, at the cost of a hydration read — the right trade (hydration is cache-cheap).
- **Chronological vs ranked:** ranked drives engagement but adds a scoring service and offline feature pipeline; ship chronological first, layer ranking behind a flag.
- **At 10×:** widen the celebrity pull path (edge-cache celebrity posts globally), regionalize timeline Redis, and move scoring to a two-tower retrieval model. The hybrid boundary is the knob you keep tuning.

## 10. Interview Follow-ups

**Q: Fan-out on write or on read — which do you pick?**
A: Neither alone at scale. Push (write) for normal users because reads dominate and precomputing makes them O(1); pull (read) for celebrities because pushing 100M writes per post is unbounded. Combine them — hybrid.

**Q: Walk me through the celebrity problem precisely.**
A: A 100M-follower account posting = 100M timeline writes per post, bursty and unbounded, which lags fan-out and overloads Redis. So we *don't* push their posts; readers pull the (few) celebrities they follow at read time and merge. A user follows only a handful of celebrities, so the merge is cheap.

**Q: Where's the threshold between normal and celebrity, and is it static?**
A: ~100K followers as a starting point, but dynamic: also flip an author to pull if a specific fan-out job's write count exceeds a limit (a circuit breaker), catching sudden virality.

**Q: How do you keep timeline read p99 under 200ms?**
A: The bulk is a single Redis `ZREVRANGE` of a precomputed list; only a small bounded pull+merge for celebrities and a scoring pass over a few hundred candidates. Post bodies are hydrated from cache in batch.

**Q: How do you rank the feed?**
A: Two stages — candidate generation (hybrid fan-out) then scoring by recency, author affinity, predicted engagement, and diversity. Scores go into the Redis sorted set. Heavy ML features are precomputed offline to fit the latency budget.

**Q: What do you store in the timeline — full posts or IDs?**
A: Just post-IDs (capped ~800), hydrated to bodies at read time. Tiny storage, and edits/deletes don't require rewriting millions of timelines.

**Q: How do you avoid wasting fan-out on inactive users?**
A: Don't maintain timelines for dormant accounts; drop them and lazily rebuild (pull mode) on next login. Massive write savings since most followers are inactive at any moment.

**Q: A user follows someone new — do their old posts appear instantly?**
A: Not necessarily via push (we don't backfill millions of old posts). We merge the new followee's recent posts at read time (pull) so the feed reflects the follow immediately; the steady state resumes via push for future posts.

**Q: How do you handle a deleted or edited post that's already in millions of timelines?**
A: Timelines hold IDs, not bodies. On read we hydrate from the post store, which reflects the edit/delete — no timeline rewrite needed. A deleted post is simply skipped during hydration.

**Q: What happens if the ranking service is down?**
A: Fall back to chronological order. Degrade the ranking, never the feed itself — availability of *a* feed beats a perfectly ranked one.

**Q: How do you paginate infinite scroll correctly?**
A: Cursor pagination — an opaque cursor encoding the last seen score/position — not OFFSET, which gets slow and skips/dupes as new posts arrive.

## 11. Cheat Sheet

> [!TIP]
> **News Feed in one screen**
> - **Workload:** read-heavy; ~175K peak read QPS, ~17K peak post QPS. Precompute reads.
> - **Core decision:** **hybrid fan-out** — push normal authors' posts into follower timelines on write; **pull celebrities** on read and merge. Threshold ~100K followers, plus a circuit breaker for sudden virality.
> - **Timelines:** Redis **sorted sets** of post-**IDs**, capped ~800; hydrate bodies from post cache at read.
> - **Fan-out:** async via **Kafka**; prioritize active followers; skip dormant users (lazy rebuild).
> - **Ranking:** candidate-gen → score (recency, affinity, predicted engagement); fall back to chronological.
> - **Failure stance:** feed must load even if stale — degrade ranking, rebuild from post store, best-effort fan-out.

**References:** "Twitter Timelines at Scale" (Twitter Eng), System Design Primer (news feed), "Designing Data-Intensive Applications" (ch.1 fan-out example), Instagram Engineering blog

---
*System Design Handbook — topic 33.*
