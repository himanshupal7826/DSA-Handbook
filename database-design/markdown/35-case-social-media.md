# 35 · Case Study: Instagram-like Storage

> **In one line:** A social network's data layer is a read-dominated, user-sharded relational core (users, posts, comments, likes, both directions of the follow graph) with IDs that encode time and shard, surrounded by derived structures — precomputed feeds in memory, aggregated counters, media in object storage — that trade exactness and freshness for the ability to serve hundreds of thousands of feed reads per second.

---

## 1. Overview

> **Builds on:** [System Design · Design News Feed](../system-design/topic.html?p=33-design-news-feed) (fan-out on write vs read, ranking, the whole-system view) · [SQL Handbook · Schema Design](../sql/topic.html?p=30-schema-design) · [Ch 12 · Sharding](topic.html?p=12-sharding) · [Ch 19 · Database Caching Architecture](topic.html?p=19-database-caching-architecture) · [Ch 29 · Advanced Database Patterns](topic.html?p=29-advanced-database-patterns). The system-design chapter covers the product architecture and feed ranking; this chapter is about **where each piece of data lives, how it is keyed and sharded, and how the derived data is kept honest**.

You are designing storage for an Instagram-like product: users post photos and videos with captions, follow other users, like and comment, and scroll a home feed of posts from people they follow. It is the textbook "read-heavy at planetary scale" system, and its data design is a lesson in **deciding what does not need to be exact**. A like count that is three seconds behind is fine. A feed missing a post for ten seconds is fine. A follow that shows up in your "following" list but not yet in the other person's "followers" list for a second is fine. A post that vanishes, or a like recorded twice, is not.

The naive design — one relational database, `SELECT posts WHERE author_id IN (SELECT followee_id FROM follows WHERE follower_id = $me) ORDER BY created_at DESC LIMIT 20` for the feed, `UPDATE posts SET like_count = like_count + 1` for likes, photos in a `BYTEA` column — is correct and collapses at every one of those points: the feed query fans out across hundreds of authors per read, the like counter on a celebrity post becomes a hot row absorbing tens of thousands of updates a second, and binary media turns the database into the world's most expensive file server.

### Requirements

**Functional:** sign up, profile; upload photo/video posts with captions; follow/unfollow; home feed (posts from followees, newest or ranked); profile grid (a user's posts); like/unlike; comment; like and comment counts; followers/following lists and counts; notifications ("X liked your post").

**Non-functional:**

- Feed p99 < 200 ms; profile p99 < 150 ms.
- A new post is visible to the author immediately (read-your-writes) and to followers within seconds.
- Likes are idempotent (one per user per post) and never lost; the displayed **count** may lag by seconds.
- Media durable (11 nines class via object storage), served from a CDN.
- Horizontal scale on every axis: users, posts, followers per user (celebrities with 100 M+ followers).

### Workload estimate

| Quantity | Estimate | Reasoning |
|---|---|---|
| MAU / DAU | 2 B / 500 M | large consumer social app |
| Posts | 100 M/day ≈ 1,200/s avg, ~3,500/s peak | ~1 in 5 DAU posts daily |
| Feed loads | 10 B/day ≈ 115,000/s avg, ~350,000/s peak | ~20 feed opens per DAU |
| Likes | 4 B/day ≈ 46,000/s avg, ~150,000/s peak | viral posts concentrate them |
| Comments | 500 M/day ≈ 6,000/s | |
| Follows / unfollows | 50 M/day ≈ 600/s | |
| Read : write (metadata) | ~100 : 1 | feed and profile reads dominate |
| Post metadata | ~500 B/post → ~50 GB/day, ~18 TB/year | ids, caption, media keys, location |
| Like rows | ~40 B/row + index → ~250 GB/day | the largest table by rows |
| Media | 100 M × ~2 MB (all renditions) ≈ 200 TB/day | never in the database |
| Follow edges | ~200 B edges (avg ~100 followees) × 2 directions | graph stored twice |

Three conclusions ([Ch 22 · Capacity Planning](topic.html?p=22-capacity-planning)): media goes to object storage, full stop; every relational table must be sharded from the start (no single machine holds 250 GB/day of likes for long); and the feed read rate (350 K/s) is far beyond what any "query at read time" approach can serve from a database, so feeds must be precomputed or heavily cached.

## 2. Core Concepts

- **User-keyed sharding** — every user-owned row (profile, posts, their outgoing follows) lives on the shard that owns the user. *Why it matters:* a profile page and "my posts" are single-shard reads.
- **Logical shards** — thousands of small shards (e.g. 8,192 PostgreSQL schemas — 13 bits of shard id) mapped onto far fewer physical servers. *Why it matters:* rebalancing moves whole logical shards; the user → logical shard mapping never changes.
- **Instagram-style ID** — a 64-bit id = 41 bits of milliseconds since a custom epoch + 13 bits of logical shard id + 10 bits of per-shard sequence. *Invariant S1:* ids are unique, roughly time-ordered, and reveal their shard. *Why it matters:* `ORDER BY id` is `ORDER BY time`, and you can route a post id without a lookup.
- **Follow graph, both directions** — `following(follower → followee)` on the follower's shard and `followers(followee → follower)` on the followee's shard. *Invariant S2:* eventually, every edge exists in both tables.
- **Like** — a row `(post_id, user_id)`. *Invariant S3:* at most one like per user per post (primary key).
- **Counter** — `like_count`, `comment_count`, `follower_count`: derived aggregates, **eventually consistent**. *Invariant S4:* converges to the true count of rows.
- **Feed (timeline)** — a per-user list of recent post ids from followees, precomputed. *Why it matters:* it is a cache — rebuildable from posts + graph — so it can live in memory and be lossy.
- **Fan-out on write (push)** — on post, insert the post id into every follower's feed. Cheap reads, expensive writes for users with many followers.
- **Fan-out on read (pull)** — on feed load, fetch recent posts of every followee and merge. Cheap writes, expensive reads.
- **Hybrid fan-out** — push for normal users, pull for **celebrities** (accounts above a follower threshold), merged at read time.
- **Media object** — the bytes in object storage (S3-style) keyed by a content-addressed or random key; the database stores only the key and metadata.

## 3. Theory & Principles

### Access patterns, ranked

| # | Access pattern | Peak rate | Consistency | Served from |
|---|---|---|---|---|
| 1 | Home feed page (20 post ids) | 350,000/s | seconds-stale OK; own posts immediately | Redis feed lists + celebrity pull |
| 2 | Hydrate posts by id (feed, grid) | ~5 M ids/s | stale OK (edits rare) | post cache (memcached/Redis) → author shard |
| 3 | Like / unlike | 150,000/s | idempotent, durable | post's shard (`likes`), event to counters |
| 4 | Like/comment counts for displayed posts | ~5 M/s | seconds-stale OK | counter cache ← aggregated counter table |
| 5 | "Did I like this?" | ~5 M/s | read-your-writes for the viewer | per-viewer cache / batch lookup on `likes` |
| 6 | Profile grid (a user's posts, newest first) | 50,000/s | read-your-writes for the author | author's shard, index `(author_id, id DESC)` |
| 7 | Create post | 3,500/s | strong on author shard | author's shard + outbox |
| 8 | Comments on a post (paged) | 30,000/s | seconds-stale OK | post's shard |
| 9 | Follow / unfollow | 600/s | strong on follower side, eventual on followee side | two shards via outbox |
| 10 | Followers list of a celebrity (paged) | low | stale OK | followee's shard, partitioned |

### Consistency boundaries

The only strongly consistent, transactional units are **single-shard writes**: a post and its outbox row; a like row and its outbox row; an outgoing follow edge and its outbox row. Nothing in this system needs a cross-shard transaction, and the design is deliberately arranged so that nothing does ([Ch 13 · Distributed Transactions](topic.html?p=13-distributed-transactions)). Everything that spans shards — the reverse follow edge, counters, feeds, notifications — is **derived asynchronously** from events, with idempotent consumers, and is allowed to lag ([Ch 10 · Consistency Models](topic.html?p=10-consistency-models)).

Two user-visible guarantees are layered on top: **read-your-writes for the author** (your new post appears at the top of your own feed and grid immediately — the client inserts it locally and the grid reads the author's shard primary for a short window after a write) and **monotonic counts per viewer** (the app never shows a like count going down because it hit a staler replica; it keeps the max it has seen for a session).

### IDs that route themselves

```svg
<svg viewBox="0 0 860 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs><marker id="c35a1" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#334155"/></marker></defs>
  <text x="430" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">A 64-bit post id: time, then shard, then sequence</text>
  <rect x="40" y="45" width="460" height="50" fill="#dbeafe" stroke="#2563eb"/>
  <text x="270" y="67" text-anchor="middle" fill="#1e3a8a" font-weight="bold">41 bits: ms since custom epoch</text>
  <text x="270" y="84" text-anchor="middle" fill="#1e3a8a" font-size="10">about 35 years before the sign bit; sorts by time</text>
  <rect x="500" y="45" width="180" height="50" fill="#dcfce7" stroke="#16a34a"/>
  <text x="590" y="67" text-anchor="middle" fill="#14532d" font-weight="bold">13 bits: logical shard</text>
  <text x="590" y="84" text-anchor="middle" fill="#166534" font-size="10">0..8191 = author's shard</text>
  <rect x="680" y="45" width="140" height="50" fill="#fef3c7" stroke="#d97706"/>
  <text x="750" y="67" text-anchor="middle" fill="#78350f" font-weight="bold">10 bits: sequence</text>
  <text x="750" y="84" text-anchor="middle" fill="#92400e" font-size="10">1,024 ids / ms / shard</text>
  <text x="40" y="115" fill="#334155" font-size="10">bit 63</text><text x="800" y="115" fill="#334155" font-size="10">bit 0</text>
  <rect x="40" y="135" width="250" height="60" rx="6" fill="#ffffff" stroke="#94a3b8"/>
  <text x="165" y="157" text-anchor="middle" fill="#1e293b" font-weight="bold">post_id arrives</text>
  <text x="165" y="175" text-anchor="middle" fill="#334155" font-size="10">shard = (id &gt;&gt; 10) &amp; 8191</text>
  <text x="165" y="189" text-anchor="middle" fill="#334155" font-size="10">no directory lookup needed</text>
  <path d="M290,165 L348,165" stroke="#334155" stroke-width="1.5" marker-end="url(#c35a1)"/>
  <rect x="350" y="135" width="200" height="60" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="450" y="157" text-anchor="middle" fill="#14532d" font-weight="bold">logical shard 1337</text>
  <text x="450" y="175" text-anchor="middle" fill="#166534" font-size="10">a Postgres schema: shard_1337</text>
  <text x="450" y="189" text-anchor="middle" fill="#166534" font-size="10">tables: users, posts, likes, ...</text>
  <path d="M550,165 L608,165" stroke="#334155" stroke-width="1.5" marker-end="url(#c35a1)"/>
  <rect x="610" y="135" width="210" height="60" rx="6" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="715" y="157" text-anchor="middle" fill="#5b21b6" font-weight="bold">shard map (small, cached)</text>
  <text x="715" y="175" text-anchor="middle" fill="#5b21b6" font-size="10">1024..1535 on pg-host-03</text>
  <text x="715" y="189" text-anchor="middle" fill="#5b21b6" font-size="10">changes only when rebalancing</text>
  <rect x="40" y="220" width="780" height="160" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="430" y="242" text-anchor="middle" fill="#1e293b" font-weight="bold">8,192 logical shards on a handful of physical servers, rebalanced by moving whole schemas</text>
  <rect x="70" y="260" width="160" height="100" rx="6" fill="#ffffff" stroke="#16a34a"/><text x="150" y="280" text-anchor="middle" fill="#14532d" font-weight="bold">pg-host-01</text><text x="150" y="300" text-anchor="middle" fill="#334155" font-size="10">shards 0..511</text><text x="150" y="318" text-anchor="middle" fill="#334155" font-size="10">primary + replicas</text>
  <rect x="260" y="260" width="160" height="100" rx="6" fill="#ffffff" stroke="#16a34a"/><text x="340" y="280" text-anchor="middle" fill="#14532d" font-weight="bold">pg-host-02</text><text x="340" y="300" text-anchor="middle" fill="#334155" font-size="10">shards 512..1023</text><text x="340" y="318" text-anchor="middle" fill="#334155" font-size="10">primary + replicas</text>
  <rect x="450" y="260" width="160" height="100" rx="6" fill="#ffffff" stroke="#d97706"/><text x="530" y="280" text-anchor="middle" fill="#78350f" font-weight="bold">pg-host-03 (hot)</text><text x="530" y="300" text-anchor="middle" fill="#334155" font-size="10">shards 1024..1535</text><text x="530" y="318" text-anchor="middle" fill="#92400e" font-size="10">move 1280..1535 away</text>
  <rect x="640" y="260" width="160" height="100" rx="6" fill="#ffffff" stroke="#2563eb"/><text x="720" y="280" text-anchor="middle" fill="#1e3a8a" font-weight="bold">pg-host-04 (new)</text><text x="720" y="300" text-anchor="middle" fill="#334155" font-size="10">receives 1280..1535</text><text x="720" y="318" text-anchor="middle" fill="#334155" font-size="10">via logical replication</text>
  <path d="M610,330 L638,330" stroke="#2563eb" stroke-width="1.8" marker-end="url(#c35a1)"/>
  <text x="430" y="376" text-anchor="middle" fill="#334155" font-size="10">user_id and post_id never change; only the shard-to-host map does</text>
</svg>
```

This is the scheme Instagram described publicly for its sharded PostgreSQL: ids generated *inside* each logical shard by a PL/pgSQL function, so no central id service is on the write path. Compared with a Snowflake service ([Ch 12 · Sharding](topic.html?p=12-sharding)), it trades a separate component for a database function; compared with UUIDv4, it keeps B-tree inserts append-mostly and makes `ORDER BY id DESC` a free "newest first".

### Feed: push, pull, hybrid

A post by a user with 300 followers written to 300 feeds costs 300 cheap in-memory inserts, once. A post by a user with 300 M followers would cost 300 M inserts — minutes of work, for a post whose followers will mostly never open the app in the next hour. So: **push** for authors below a threshold (say 1 M followers), **pull** for celebrities. At read time, the feed service takes the precomputed list and merges in the recent posts of the (few) celebrities the reader follows, each of which is a cheap single-shard query on `(author_id, id DESC)` — and in practice a cache hit, because a celebrity's latest posts are read by everyone. The full treatment is in [System Design · Design News Feed](../system-design/topic.html?p=33-design-news-feed); what matters here is the storage consequence: the feed store holds *post ids only*, bounded per user, and is treated as a rebuildable cache.

## 4. Architecture & Workflow

```svg
<svg viewBox="0 0 880 490" width="100%" height="490" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs><marker id="c35b1" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#2563eb"/></marker><marker id="c35b2" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#7c3aed"/></marker><marker id="c35b3" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#16a34a"/></marker></defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Source of truth vs derived data</text>
  <rect x="20" y="45" width="130" height="44" rx="6" fill="#f1f5f9" stroke="#94a3b8"/><text x="85" y="64" text-anchor="middle" fill="#1e293b">App</text><text x="85" y="79" text-anchor="middle" fill="#334155" font-size="9">upload, post, like, feed</text>
  <rect x="200" y="40" width="170" height="54" rx="6" fill="#f1f5f9" stroke="#94a3b8"/><text x="285" y="60" text-anchor="middle" fill="#1e293b" font-weight="bold">Object storage + CDN</text><text x="285" y="76" text-anchor="middle" fill="#334155" font-size="9">presigned PUT; renditions by worker</text><text x="285" y="88" text-anchor="middle" fill="#334155" font-size="9">~200 TB/day, never in the DB</text>
  <path d="M150,62 L198,62" stroke="#2563eb" stroke-width="1.5" marker-end="url(#c35b1)"/>
  <rect x="200" y="120" width="220" height="190" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="310" y="140" text-anchor="middle" fill="#14532d" font-weight="bold">Sharded Postgres (by user)</text>
  <text x="310" y="155" text-anchor="middle" fill="#166534" font-size="9">SOURCE OF TRUTH, 8,192 logical shards</text>
  <rect x="215" y="165" width="90" height="22" rx="3" fill="#ffffff" stroke="#16a34a"/><text x="260" y="180" text-anchor="middle" fill="#14532d" font-size="9">users</text>
  <rect x="315" y="165" width="90" height="22" rx="3" fill="#ffffff" stroke="#16a34a"/><text x="360" y="180" text-anchor="middle" fill="#14532d" font-size="9">posts</text>
  <rect x="215" y="193" width="90" height="22" rx="3" fill="#ffffff" stroke="#16a34a"/><text x="260" y="208" text-anchor="middle" fill="#14532d" font-size="9">following</text>
  <rect x="315" y="193" width="90" height="22" rx="3" fill="#ffffff" stroke="#16a34a"/><text x="360" y="208" text-anchor="middle" fill="#14532d" font-size="9">followers</text>
  <rect x="215" y="221" width="90" height="22" rx="3" fill="#ffffff" stroke="#16a34a"/><text x="260" y="236" text-anchor="middle" fill="#14532d" font-size="9">likes</text>
  <rect x="315" y="221" width="90" height="22" rx="3" fill="#ffffff" stroke="#16a34a"/><text x="360" y="236" text-anchor="middle" fill="#14532d" font-size="9">comments</text>
  <rect x="215" y="249" width="190" height="22" rx="3" fill="#ffffff" stroke="#16a34a"/><text x="310" y="264" text-anchor="middle" fill="#14532d" font-size="9">counters (aggregated)</text>
  <rect x="215" y="277" width="190" height="22" rx="3" fill="#ffffff" stroke="#7c3aed"/><text x="310" y="292" text-anchor="middle" fill="#5b21b6" font-size="9">outbox (per shard)</text>
  <path d="M110,89 L230,118" stroke="#16a34a" stroke-width="2" marker-end="url(#c35b3)"/>
  <text x="120" y="112" fill="#166534" font-size="9">writes</text>
  <rect x="470" y="200" width="170" height="54" rx="6" fill="#ede9fe" stroke="#7c3aed"/><text x="555" y="222" text-anchor="middle" fill="#5b21b6" font-weight="bold">Kafka</text><text x="555" y="238" text-anchor="middle" fill="#5b21b6" font-size="9">PostCreated, LikeAdded, Followed</text>
  <path d="M405,288 L468,240" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#c35b2)"/>
  <text x="440" y="285" fill="#5b21b6" font-size="9">CDC</text>
  <rect x="690" y="100" width="170" height="54" rx="6" fill="#fef3c7" stroke="#d97706"/><text x="775" y="120" text-anchor="middle" fill="#78350f" font-weight="bold">Fan-out workers</text><text x="775" y="136" text-anchor="middle" fill="#92400e" font-size="9">skip celebrities</text><text x="775" y="148" text-anchor="middle" fill="#92400e" font-size="9">page through followers</text>
  <rect x="690" y="180" width="170" height="54" rx="6" fill="#fef3c7" stroke="#d97706"/><text x="775" y="200" text-anchor="middle" fill="#78350f" font-weight="bold">Counter aggregator</text><text x="775" y="216" text-anchor="middle" fill="#92400e" font-size="9">sum deltas per post per 2 s</text><text x="775" y="228" text-anchor="middle" fill="#92400e" font-size="9">one UPDATE per post per window</text>
  <rect x="690" y="260" width="170" height="54" rx="6" fill="#fef3c7" stroke="#d97706"/><text x="775" y="280" text-anchor="middle" fill="#78350f" font-weight="bold">Graph mirror</text><text x="775" y="296" text-anchor="middle" fill="#92400e" font-size="9">write reverse edge on</text><text x="775" y="308" text-anchor="middle" fill="#92400e" font-size="9">followee's shard (idempotent)</text>
  <path d="M640,215 L688,135" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#c35b2)"/>
  <path d="M640,227 L688,207" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#c35b2)"/>
  <path d="M640,240 L688,285" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#c35b2)"/>
  <rect x="470" y="360" width="200" height="70" rx="6" fill="#dbeafe" stroke="#2563eb"/><text x="570" y="380" text-anchor="middle" fill="#1e3a8a" font-weight="bold">Redis feeds</text><text x="570" y="396" text-anchor="middle" fill="#1e3a8a" font-size="9">feed:{user} sorted set of post ids</text><text x="570" y="410" text-anchor="middle" fill="#1e3a8a" font-size="9">capped ~500, rebuildable</text><text x="570" y="422" text-anchor="middle" fill="#1e3a8a" font-size="9">only active users kept</text>
  <path d="M775,154 C 800,300 720,360 672,385" stroke="#d97706" stroke-width="1.5" fill="none" marker-end="url(#c35b1)"/>
  <rect x="700" y="360" width="160" height="70" rx="6" fill="#dbeafe" stroke="#2563eb"/><text x="780" y="380" text-anchor="middle" fill="#1e3a8a" font-weight="bold">Object caches</text><text x="780" y="396" text-anchor="middle" fill="#1e3a8a" font-size="9">post by id, counts by id</text><text x="780" y="410" text-anchor="middle" fill="#1e3a8a" font-size="9">celebrity recent posts</text>
  <rect x="20" y="360" width="400" height="70" rx="6" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="220" y="380" text-anchor="middle" fill="#1e293b" font-weight="bold">Feed read (350k/s)</text>
  <text x="220" y="398" text-anchor="middle" fill="#334155" font-size="10">1. ZREVRANGE feed:{me}  2. merge celebrity recents</text>
  <text x="220" y="414" text-anchor="middle" fill="#334155" font-size="10">3. multi-get posts + counts from cache, misses to shards</text>
  <path d="M420,395 L468,395" stroke="#2563eb" stroke-width="1.5" marker-end="url(#c35b1)"/>
  <text x="20" y="465" fill="#1e293b" font-weight="bold">Rule:</text><text x="70" y="465" fill="#334155">only the green box is authoritative. Everything purple, amber or blue can be lost and rebuilt from it.</text>
</svg>
```

### Write path: create a post

1. The app asks for a presigned upload URL and uploads the media directly to object storage (the database never sees bytes).
2. The app calls `CreatePost(media_key, caption)`. On the author's shard, one transaction inserts the `posts` row (id from the shard's id function) and an `outbox` row `PostCreated`.
3. CDC publishes `PostCreated` to Kafka, keyed by author id.
4. The fan-out worker checks the author's follower count. Below the celebrity threshold, it pages through `followers` on the author's shard (`WHERE followee_id = $a AND follower_id > $cursor ORDER BY follower_id LIMIT 5000`) and pipelines `ZADD feed:{follower} <id> <id>` + `ZREMRANGEBYRANK feed:{follower} 0 -501` for **active** followers only (inactive users' feeds are not materialised; they are built by pull when they return).
5. A media worker produces renditions (thumbnails, sizes) and marks the post `READY`; the app shows the post to its author immediately from local state.

### Write path: like

1. On the **post's** shard (decoded from the post id): `INSERT INTO likes (post_id, user_id) ... ON CONFLICT DO NOTHING` plus an outbox row `LikeAdded` — only if the insert actually inserted.
2. The counter aggregator consumes `LikeAdded`/`LikeRemoved`, sums deltas per post over a short window (1–2 s), and applies **one** `UPDATE post_counters SET likes = likes + $delta` per post per window. A post receiving 20,000 likes per second becomes one row update every two seconds.
3. The counts cache is refreshed from the aggregator's output, not by reading the database per request.

### Write path: follow

On the **follower's** shard: insert `following(follower, followee)` + outbox `Followed`. The graph-mirror consumer inserts `followers(followee, follower)` on the followee's shard with `ON CONFLICT DO NOTHING`, and the counter aggregator increments `follower_count`. Unfollow deletes on the follower's shard and emits `Unfollowed`. The mirror applies events per edge in order because both events for an edge are keyed by `(follower, followee)` on the same Kafka partition ([Kafka & RabbitMQ · Ordering, Partitioning & Keys](../messaging/topic.html?p=22-ordering-partitioning-keys)).

## 5. Implementation

### Id generation inside each shard (PL/pgSQL)

```sql
-- One sequence per logical shard schema. Adapted from the scheme Instagram published.
CREATE SCHEMA shard_1337;
CREATE SEQUENCE shard_1337.id_seq;

CREATE OR REPLACE FUNCTION shard_1337.next_id(OUT result BIGINT) LANGUAGE plpgsql AS $$
DECLARE
  our_epoch  BIGINT := 1609459200000;        -- 2021-01-01 in ms: custom epoch
  seq_id     BIGINT;
  now_ms     BIGINT;
  shard_id   INT    := 1337;
BEGIN
  SELECT nextval('shard_1337.id_seq') % 1024 INTO seq_id;
  now_ms := (extract(epoch FROM clock_timestamp()) * 1000)::BIGINT;
  result := (now_ms - our_epoch) << 23;      -- 41 bits of time
  result := result | (shard_id::BIGINT << 10); -- 13 bits of shard
  result := result | seq_id;                   -- 10 bits of sequence
END $$;
```

If one shard generates more than 1,024 ids in the same millisecond, the sequence wraps and ids could collide within that millisecond; the primary key catches it, and in practice a single logical shard's insert rate is far below a million per second. Clock steps backwards are the other risk: a node whose clock jumps back could reissue a `(ms, seq)` pair — the primary key again catches it, and NTP slewing (not stepping) keeps it rare.

### Core schema (per logical shard)

```sql
SET search_path = shard_1337;

CREATE TABLE users (
  id             BIGINT PRIMARY KEY DEFAULT next_id(),
  username       TEXT NOT NULL,                  -- global uniqueness via a separate username → id table
  display_name   TEXT,
  is_celebrity   BOOLEAN NOT NULL DEFAULT false, -- set by a job when followers cross the threshold
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE posts (
  id           BIGINT PRIMARY KEY DEFAULT next_id(),   -- time-ordered, encodes this shard
  author_id    BIGINT NOT NULL,
  caption      TEXT,
  media        JSONB NOT NULL,                  -- [{"key":"p/9f/..","w":1080,"h":1350,"type":"image"}]
  status       TEXT NOT NULL DEFAULT 'PROCESSING' CHECK (status IN ('PROCESSING','READY','DELETED')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX posts_author_recent ON posts (author_id, id DESC) WHERE status = 'READY';  -- profile grid

-- Outgoing edges: lives on the FOLLOWER's shard. "Who do I follow?"
CREATE TABLE following (
  follower_id  BIGINT NOT NULL,
  followee_id  BIGINT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id)
);

-- Incoming edges: lives on the FOLLOWEE's shard. "Who follows me?" (fan-out reads this)
CREATE TABLE followers (
  followee_id  BIGINT NOT NULL,
  follower_id  BIGINT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (followee_id, follower_id)
);

-- Likes live on the POST's shard (= author's shard), keyed so "did U like P" and uniqueness are one index.
CREATE TABLE likes (
  post_id     BIGINT NOT NULL,
  user_id     BIGINT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE comments (
  id          BIGINT PRIMARY KEY DEFAULT next_id(),
  post_id     BIGINT NOT NULL,
  author_id   BIGINT NOT NULL,
  body        TEXT NOT NULL CHECK (length(body) <= 2200),
  deleted     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX comments_post ON comments (post_id, id DESC);   -- newest comments first, keyset paging

-- Aggregated counters: written by the aggregator only, a few times a second per hot post.
CREATE TABLE post_counters (
  post_id        BIGINT PRIMARY KEY,
  likes          BIGINT NOT NULL DEFAULT 0,
  comments       BIGINT NOT NULL DEFAULT 0,
  last_event_id  BIGINT NOT NULL DEFAULT 0     -- idempotency watermark for the aggregator
) WITH (fillfactor = 80);

CREATE TABLE user_counters (
  user_id     BIGINT PRIMARY KEY,
  followers   BIGINT NOT NULL DEFAULT 0,
  following   BIGINT NOT NULL DEFAULT 0,
  posts       BIGINT NOT NULL DEFAULT 0
) WITH (fillfactor = 80);
```

Why the indexes are exactly these: `posts_author_recent` serves the profile grid and the celebrity pull (`WHERE author_id = $1 ORDER BY id DESC LIMIT 20` — a backward range scan of 20 entries); the primary keys of `following`, `followers` and `likes` *are* their access paths; `comments_post` supports keyset pagination (`AND id < $cursor`). Any other index on `likes` — the largest table — costs 250 GB/day of extra writes; add it only for a measured need. See [SQL Handbook · Index Design](../sql/topic.html?p=20-index-design).

### Critical transaction 1: create post

```sql
BEGIN;  -- on the author's shard
INSERT INTO posts (author_id, caption, media)
VALUES ($author, $caption, $media_json)
RETURNING id;
UPDATE user_counters SET posts = posts + 1 WHERE user_id = $author;    -- same shard, low contention
INSERT INTO outbox (aggregate, agg_id, event_type, payload)
VALUES ('post', $post_id, 'PostCreated', jsonb_build_object('post', $post_id, 'author', $author));
COMMIT;
```

### Critical transaction 2: like (idempotent, exactly one event per real change)

```sql
BEGIN;  -- on the post's shard, decoded from post_id
WITH ins AS (
  INSERT INTO likes (post_id, user_id) VALUES ($post, $user)
  ON CONFLICT (post_id, user_id) DO NOTHING
  RETURNING post_id
)
INSERT INTO outbox (aggregate, agg_id, event_type, payload)
SELECT 'post', post_id, 'LikeAdded', jsonb_build_object('post', $post, 'user', $user) FROM ins;
COMMIT;
-- Unlike is symmetric: DELETE ... RETURNING feeds an outbox row 'LikeRemoved' only if a row was deleted.
```

Tapping "like" five times on a bad connection produces one row and one event. Double-tap then unlike then like produces an insert, a delete and an insert — three events that sum to +1, which is correct. Nothing ever does `UPDATE posts SET like_count = like_count + 1`.

### Critical transaction 3: the counter aggregator's flush

```sql
-- Aggregator batches events from Kafka for ~2 s, per post: delta = adds - removes,
-- and the max Kafka offset seen, then applies all of a shard's posts in one statement.
UPDATE post_counters pc
   SET likes = pc.likes + d.delta,
       last_event_id = d.max_offset
  FROM unnest($post_ids::bigint[], $deltas::bigint[], $max_offsets::bigint[]) AS d(post_id, delta, max_offset)
 WHERE pc.post_id = d.post_id
   AND pc.last_event_id < d.max_offset;     -- replayed batch after a crash is skipped, not double-counted
```

The watermark makes the flush idempotent under at-least-once consumption: if the aggregator crashes after the UPDATE but before committing its Kafka offsets, it re-reads the same events, builds the same batch, and the `last_event_id < max_offset` guard skips posts it already applied. (It relies on one aggregator partition owning each post, which Kafka keying by `post_id` provides.) A nightly job recomputes `count(*)` from `likes` for a sample of posts and for any post whose counter was touched by a failed batch, and repairs drift — the counters are **eventually exact**.

### Alternative for a single viral post: sharded counter rows

```sql
-- When one post alone needs thousands of direct increments per second (no aggregator):
CREATE TABLE post_like_buckets (
  post_id BIGINT, bucket SMALLINT, n BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (post_id, bucket)
);
UPDATE post_like_buckets SET n = n + 1
 WHERE post_id = $post AND bucket = (random() * 15)::int;        -- 16 rows share the heat
SELECT sum(n) FROM post_like_buckets WHERE post_id = $post;        -- read (cached)
```

### Feed read (application code, Go)

```go
// HomeFeed returns up to 20 post ids: precomputed pushes merged with celebrity pulls.
func (s *FeedService) HomeFeed(ctx context.Context, me int64, before int64) ([]int64, error) {
	max := "+inf"
	if before > 0 {
		max = "(" + strconv.FormatInt(before, 10) // exclusive cursor: ids are time-ordered
	}
	pushed, err := s.redis.ZRevRangeByScore(ctx, fmt.Sprintf("feed:{%d}", me),
		&redis.ZRangeBy{Max: max, Min: "-inf", Count: 40}).Result()
	if err == redis.Nil || len(pushed) == 0 {
		return s.rebuildByPull(ctx, me, before) // cold user: fan-out on read, then warm the key
	} else if err != nil {
		return nil, err
	}

	// Celebrities I follow: small list, cached per user for minutes.
	celebs, err := s.celebsFollowedBy(ctx, me)
	if err != nil {
		return nil, err
	}
	pulled := s.recentPostsOf(ctx, celebs, before, 20) // each a cache hit on "recent posts of author X"

	ids := mergeDesc(toInt64(pushed), pulled, 20) // ids sort by time; ranking layer may reorder
	return ids, nil
}
```

`mergeDesc` works because ids are time-ordered: merging by id is merging by time. A ranking service can reorder the candidate set, but the storage layer's job ends at producing it cheaply.

### Diagnostic queries

```sql
-- Drift check for a post: counter vs truth (run on a replica).
SELECT pc.likes AS counter, (SELECT count(*) FROM likes l WHERE l.post_id = pc.post_id) AS truth
FROM post_counters pc WHERE pc.post_id = $post;

-- Edge-mirror check for one sampled user, in two steps (no cross-shard join exists).
-- Step 1, on the follower's shard: the source of truth.
SELECT followee_id FROM following WHERE follower_id = $me;
-- Step 2, on each followee shard, with the followee ids that live there: which mirrors are missing?
SELECT f.followee_id
FROM unnest($followee_ids_on_this_shard::bigint[]) AS f(followee_id)
WHERE NOT EXISTS (SELECT 1 FROM followers r
                   WHERE r.followee_id = f.followee_id AND r.follower_id = $me);
```

> **MySQL difference:** this design runs just as well on sharded MySQL/InnoDB, and famous deployments (Facebook's TAO-backed MySQL, Vitess at YouTube and Slack) do. With InnoDB the table is clustered on the primary key, so `likes (post_id, user_id)` stores a post's likes physically together — excellent for "likes of post P" scans — and secondary indexes carry the PK, which makes wide PKs more expensive. Vitess offers the shard map, resharding and routing that this chapter builds by hand with logical shards.

## 6. Advantages, Disadvantages & Trade-offs

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| Shard key | user id (posts/likes on author's shard) | post id hash | profile and "my posts" single-shard; post id encodes shard anyway |
| Shard layout | 8,192 logical shards on N hosts | N physical shards by modulo | rebalance by moving schemas; no rehash of every row |
| IDs | 41/13/10 time-shard-seq, generated in-shard | UUIDv4; central ticket server | ordered B-tree inserts; no extra service on write path |
| Graph | stored twice (following + followers) | one table + scatter-gather | each direction is a single-shard range scan |
| Feed | hybrid push/pull, Redis ids only | pure pull; pure push | pull too slow at 350k/s; push explodes for celebrities |
| Like counts | aggregated deltas + watermark | `UPDATE posts SET like_count+1` | hot rows on viral posts; lock contention and bloat |
| Media | object storage + CDN | BYTEA / large objects in DB | cost, backup size, replication traffic |
| Comments | relational on post's shard | Cassandra | keyset paging on a B-tree is fine at this rate; revisit at 10× |

### When to use this design

Any follower-graph product with read-heavy timelines: social networks, activity feeds in collaboration tools, creator platforms, "following" features in marketplaces.

### When NOT to use it

- **Under ~10 M users:** one PostgreSQL primary with replicas and a pull feed (cached) is simpler and fast enough; shard later along the same user-id key.
- **Graph-query-heavy features** (friends-of-friends recommendations, shortest path): a graph store or a precomputed offline pipeline serves them; the relational adjacency lists here are optimised for one-hop lookups.
- **Strict counts** (votes in an election, inventory): aggregated eventual counters are the wrong tool — use a ledger or a transactional counter ([Ch 32 · Banking Ledger](topic.html?p=32-case-banking)).

## 7. Common Mistakes & Best Practices

**Mistake: `like_count` updated in place on the post row.** It is the obvious place for it. Under a viral post, tens of thousands of transactions a second queue on one row lock, every update writes a new tuple version of a wide post row, and the table bloats. Instead: likes as rows, counts as aggregated deltas (or bucketed counters) in a narrow side table.

**Mistake: computing counts with `COUNT(*)` at read time.** Five million count reads a second over tables with billions of rows. Instead: precomputed counters, cached, periodically verified.

**Mistake: storing only one direction of the follow graph.** "Who follows me?" then means querying every shard. Instead: store both directions, one as the source of truth, the other mirrored idempotently from events.

**Mistake: synchronous cross-shard writes for follow.** Writing both edges in one request with two connections looks atomic and is not; a crash between them leaves a half edge with no record of the missing half. Instead: one local write plus outbox; the mirror is retried until done ([Kafka & RabbitMQ · Idempotency & Outbox](../messaging/topic.html?p=21-idempotency-outbox)).

**Mistake: fan-out on write for everyone.** A celebrity post triggers hundreds of millions of feed inserts, backing up the fan-out queue for every other user's posts. Instead: hybrid with a celebrity threshold, and fan out only to recently active followers.

**Mistake: treating the feed cache as a source of truth.** Storing whole post objects in feeds, or never being able to rebuild them, makes a Redis failure a data-loss incident. Instead: feeds hold ids only and are rebuildable by pull.

**Mistake: random UUIDs as post ids.** Inserts land on random pages of the B-tree, the working set of the index is the whole index, and `ORDER BY created_at` needs another index. Instead: time-ordered ids ([Ch 02 · Storage Internals](topic.html?p=02-storage-internals)).

**Mistake: media in the database.** Backups become petabytes, replicas replay image bytes, and every read of a post drags TOAST data. Instead: object storage keys in a JSONB column.

**Best practices:** decode shard from id in one shared library; keep counters in narrow tables with `fillfactor` for HOT updates; cap feed length; exclude inactive users from fan-out; run sampled drift checks on counters and graph mirrors; `statement_timeout` on every read path.

## 8. Production: Failure Scenarios, Monitoring & Scaling

### Failure scenarios

**A celebrity crosses the threshold mid-flight.** Symptom: fan-out lag spikes to 20 minutes; everyone's feeds are stale. Root cause: an account went viral and gained 5 M followers in a day, but `is_celebrity` is recomputed nightly, so its posts were still pushed. Fix: the fan-out worker checks follower count in real time (from `user_counters`) and switches to pull above the threshold; per-author fan-out jobs are rate-limited so one author cannot starve the queue.

**Viral post, `post_counters` row contended.** Symptom: aggregator flush latency grows, like counts lag by minutes. Root cause: a bug made the aggregator flush per event instead of per window after a config change. Fix: restore windowing; alert on "flush statements per second per shard".

**Redis feed cluster loses a node.** Symptom: some users get empty feeds. Fix: the read path treats a missing key as cold and rebuilds by pull (bounded: last 3 days, 500 followees max, cached); fan-out resumes into the replacement node. Correctness intact because feeds are derived ([Ch 19 · Database Caching Architecture](topic.html?p=19-database-caching-architecture)).

**Hot shard.** Symptom: one physical host at 90% CPU. Root cause: it holds logical shards of several mega-accounts whose posts and likes are read constantly. Fix: move some logical shards to a new host via logical replication and a short cutover; cache celebrity posts and counts aggressively; in extreme cases give a mega-account's logical shard a host of its own.

**Graph mirror stuck.** Symptom: users see "following" but the followee's follower list misses them. Root cause: the mirror consumer hit a poison message (a deleted user id) and stopped. Fix: dead-letter the poison event, alert on consumer lag, run the sampling reconciliation to repair missing edges.

### Monitoring

| Metric | Why | Alert |
|---|---|---|
| Feed p99 and pull-rebuild rate | cold-cache storms | rebuild rate > 5% of reads |
| Fan-out lag (post created → last follower feed updated) | freshness | p99 > 60 s |
| Counter drift (sampled) | eventual exactness | drift > 0.1% on sampled posts |
| Graph mirror consumer lag | follower lists | > 5 min |
| Per-host CPU / QPS by logical shard | hot shard detection | a shard > 3× median |
| `n_dead_tup` on counters and likes | churn and vacuum health | dead > 20% |
| Object-storage orphan media | uploads never attached to posts | growth trend |

### Scaling path

Following [Ch 21 · Database Scaling](topic.html?p=21-database-scaling):

1. **Launch:** one Postgres primary + replicas, logical shards already defined as schemas on it (all 8,192 on one host), ids already shard-encoded, Redis for feeds and counters. Pull feed with caching.
2. **10×:** spread logical shards across hosts; enable push fan-out; move counts to the aggregator; CDN for media ([Ch 12 · Sharding](topic.html?p=12-sharding)).
3. **100×:** more hosts (no id or key changes, only the shard map); comments and likes possibly moved to a wide-column store where their append-heavy shape fits ([Ch 30 · SQL vs NoSQL](topic.html?p=30-sql-vs-nosql)); regional read replicas and caches ([Ch 17 · Multi-Region Databases](topic.html?p=17-multi-region-databases)); graph queries beyond one hop served by an offline pipeline.

### Lifecycle and deletion

Deleting a user must cascade across shards: their posts (own shard), their likes and comments (on *other* users' shards), both graph directions, feed entries, counters, and media objects. Do it as an asynchronous, idempotent, resumable job driven by a `UserDeleted` event, with a tombstone that hides content immediately and a completion record for compliance ([Ch 28 · Data Lifecycle](topic.html?p=28-data-lifecycle)). Old likes are rarely read; partition `likes` by id range (time) inside each shard and move cold partitions to cheaper storage.

## 9. Interview Questions

**Q: Why shard by user id, and where do likes live?**
A: Because the dominant reads are per user — profile, their posts, their following list — and user-id sharding makes each of those single-shard. Posts live on the author's shard, and likes live with the post (so, also the author's shard), which makes "likes of this post", "did I like it" and the uniqueness check one primary-key lookup on one shard. The post id encodes the shard, so a like request routes without a lookup.

**Q: How do Instagram-style IDs work, and why not UUIDs?**
A: A 64-bit id packs 41 bits of milliseconds since a custom epoch, 13 bits of logical shard id and 10 bits of a per-shard sequence, generated by a function inside each shard. Ids sort by creation time, so the newest-first index is the primary key order and inserts append to the right edge of the B-tree, and any service can extract the shard from the id. Random UUIDs scatter inserts across the index, bloat the working set, need a separate time index, and do not tell you where the row lives.

**Q: Why store the follow graph twice?**
A: Because both directions are hot queries: "who do I follow" drives pull feeds and the following list, "who follows X" drives fan-out and the followers list. With user-id sharding each direction is a single-shard range scan only if it is stored on that user's shard. One direction is written transactionally with an outbox event; the other is mirrored by an idempotent consumer, so the two converge within seconds.

**Q: How do you keep like counts from becoming a hot spot?**
A: Likes are rows, and counts are derived. Each like inserts a row and an outbox event on the post's shard; an aggregator consumes events partitioned by post id, sums deltas over a one- or two-second window, and applies one UPDATE per post per window with an offset watermark for idempotency. A post receiving 20,000 likes a second produces one counter update every two seconds. For a single extreme post without an aggregator, bucketed counter rows spread the increments across N rows.

**Q: Is it acceptable that the like count is wrong?**
A: It is acceptable that it is *late*, not that it is permanently wrong. Users cannot perceive a count a few seconds behind, and product owners accept it in exchange for the scalability. The design keeps counts eventually exact: the aggregator is idempotent, and a periodic job compares counters with `count(*)` of the like rows on sampled and suspicious posts and repairs drift. The per-viewer "did I like this" flag, by contrast, must reflect the viewer's own action immediately.

**Q: Fan-out on write or on read?**
A: Both. Fan-out on write for normal authors, because it makes the 350,000/s feed reads cheap list lookups, and the write cost is proportional to a small follower count. Fan-out on read for celebrities above a threshold, because pushing to hundreds of millions of feeds per post is slow and wasteful. The read path merges the precomputed list with the recent posts of the celebrities the reader follows, which are cache hits.

**Q: What exactly is stored in the feed cache?**
A: Only post ids, as a sorted set per user capped at a few hundred entries, and only for recently active users. Post bodies, media keys and counts are hydrated from separate caches by id at read time. That keeps each feed small, makes edits and deletes take effect everywhere without rewriting feeds, and makes the feed a rebuildable cache: a lost key is reconstructed by pull.

**Q: A user posts and immediately checks their profile but the post is missing. Why, and how do you fix it? (Senior)**
A: The profile read probably went to a replica that had not replayed the insert yet, or to a cache populated before the post existed. The fix is read-your-writes for the author: after a write, the client carries a "last write" timestamp or LSN and the profile read goes to the shard primary (or waits for a replica at least that current) for a short window; the author's grid cache is invalidated on `PostCreated`. The app also inserts the new post locally, so the UI never depends on the round trip ([Ch 10 · Consistency Models](topic.html?p=10-consistency-models)).

**Q: How do you rebalance when one shard host gets hot? (Senior)**
A: Because there are thousands of logical shards per host, rebalancing is moving some whole schemas to a new host, never rehashing keys. For each logical shard you set up logical replication of its tables to the new host, let it catch up, briefly block writes to that logical shard, verify the replica is caught up, flip the shard map entry, and resume. Ids and keys never change because they encode the logical shard, not the host. Celebrity-heavy shards may be isolated on dedicated hosts.

**Q: How would you delete a user completely? (Senior)**
A: Deletion spans shards, so it is an asynchronous, resumable workflow triggered by a `UserDeleted` event, not a transaction. Immediately, a tombstone on the user's shard hides their profile and content from all reads. Then idempotent jobs remove their posts and media objects, their likes and comments on other users' shards (found through per-user activity indexes or an event history), both directions of every graph edge, their feed keys, and adjust counters via compensating deltas. A completion record proves the deletion finished within the regulatory deadline.

**Q: How do you make the follow mirror safe under retries and reordering? (Senior)**
A: Events for one edge are keyed by `(follower, followee)` so they land on one Kafka partition and are consumed in order; the mirror applies `Followed` as an idempotent upsert and `Unfollowed` as an idempotent delete. If ordering could still be violated (for example during a replay from a different source), each edge event carries a version or timestamp and the mirror keeps the last-applied version per edge, ignoring older ones. A sampling reconciler compares both directions for random users and repairs any divergence.

**Q: When would you move likes or comments out of Postgres?**
A: When their write volume and size dominate everything else and the access pattern is purely "append, then read recent by key". Likes at hundreds of billions of rows and comments paged by post are a natural fit for a wide-column store partitioned by post id and clustered by time, where writes are cheap appends and there is no vacuum. You give up ad-hoc queries and transactions with the post row, which this design never used for them anyway ([Ch 30 · SQL vs NoSQL](topic.html?p=30-sql-vs-nosql)).

## 10. Quick Revision & Cheat Sheet

| Concern | Design choice |
|---|---|
| Source of truth | Postgres, 8,192 logical shards (schemas) by user id, mapped to hosts |
| IDs | 41 bits ms · 13 bits shard · 10 bits seq, generated in-shard |
| Posts | author's shard, index `(author_id, id DESC)` |
| Likes | post's shard, PK `(post_id, user_id)`, insert + outbox only on real change |
| Counts | aggregated deltas per window with watermark; bucketed rows for extreme hot spots |
| Graph | `following` on follower's shard (truth) + `followers` mirrored on followee's shard |
| Feed | Redis sorted set of ids, capped, active users only; celebrities pulled at read |
| Media | object storage + CDN; DB stores keys |
| Consistency | single-shard txns only; everything cross-shard derived via outbox + idempotent consumers |
| Rebalancing | move logical shards; ids never change |

- Decide what may be stale before designing tables: counts and feeds may, likes and posts may not be lost.
- Keep every transaction on one shard; push cross-shard effects through events.
- Ids that encode time and shard remove both an index and a lookup.
- Store both graph directions; mirror one from the other.
- Counters are derived data: aggregate, cache, verify.
- Feeds are caches of ids: capped, rebuildable, never authoritative.
- Bytes go to object storage, never to the database.

## 11. Hands-On Exercises

Lab: `docker run --rm -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:17` and `docker run --rm -p 6379:6379 redis:7`.

1. **Id function.** Create two schemas with the `next_id()` function (shards 1 and 2). Generate 100,000 ids in each and verify: all unique, ids sort by generation time, and `(id >> 10) & 8191` returns the shard.
2. **Hot counter.** Create `posts(id, like_count)` with one row. Run `pgbench` at 64 clients doing `UPDATE posts SET like_count = like_count + 1 WHERE id = 1` for 30 s and record TPS and lock waits. Repeat with 16 bucket rows and random bucket choice. Repeat once more by inserting into `likes` and aggregating every 2 s.
3. **Idempotent likes.** Run the like transaction 5 times for the same `(post, user)` and verify one `likes` row and one outbox row.
4. **Feed merge.** In Redis, create `feed:{1}` with 500 post ids, plus three "celebrity" authors with recent posts in Postgres. Implement the merge and verify results are time-ordered by id.
5. **Aggregator idempotency.** Apply the same batch UPDATE with the watermark twice and verify the counter increased once.

**Mini project:** build a mini social backend with 4 logical shards on one Postgres instance: create users, posts, follow (with outbox + a mirror consumer), likes (with outbox + an aggregator), and a hybrid feed in Redis. Load-test with 10,000 users, one "celebrity" with 5,000 followers, and a viral post receiving 2,000 likes/s. Verify after the run: every `following` edge has a `followers` mirror, every post's counter equals `count(*)` of its likes, and feed p99 stays under 20 ms locally.

## 12. Related Topics & Free Learning Resources

**Concept chapters this design applies:** [Ch 02 · Storage Internals](topic.html?p=02-storage-internals) (ordered ids and B-trees) · [Ch 04 · Concurrency Control](topic.html?p=04-concurrency-control) (idempotent writes, hot counters) · [Ch 10 · Consistency Models](topic.html?p=10-consistency-models) (read-your-writes, monotonic reads) · [Ch 11 · Partitioning](topic.html?p=11-partitioning) · [Ch 12 · Sharding](topic.html?p=12-sharding) (logical shards, global ids) · [Ch 13 · Distributed Transactions](topic.html?p=13-distributed-transactions) (why none are needed) · [Ch 17 · Multi-Region Databases](topic.html?p=17-multi-region-databases) · [Ch 19 · Database Caching Architecture](topic.html?p=19-database-caching-architecture) · [Ch 21 · Database Scaling](topic.html?p=21-database-scaling) · [Ch 28 · Data Lifecycle](topic.html?p=28-data-lifecycle) · [Ch 29 · Advanced Database Patterns](topic.html?p=29-advanced-database-patterns) (outbox, CDC, CQRS) · [Ch 30 · SQL vs NoSQL](topic.html?p=30-sql-vs-nosql).

**Related case studies:** [Ch 36 · WhatsApp-like Messaging Storage](topic.html?p=36-case-messaging) · [Ch 37 · YouTube-like Storage](topic.html?p=37-case-video-platform).

**SQL Handbook:** [Schema Design](../sql/topic.html?p=30-schema-design) · [Index Design](../sql/topic.html?p=20-index-design) · [Keys & Constraints](../sql/topic.html?p=29-keys-constraints).

**Other handbooks:** [System Design · Design News Feed](../system-design/topic.html?p=33-design-news-feed) (full-system view, ranking) · [Caching with Redis · Sorted Sets & Rate Limiting](../redis-caching/topic.html?p=19-sorted-sets-rate-limiting) · [Caching with Redis · Hot Keys & Avalanche](../redis-caching/topic.html?p=17-hot-keys-avalanche) · [Kafka & RabbitMQ · Idempotency & Outbox](../messaging/topic.html?p=21-idempotency-outbox) · [Kafka & RabbitMQ · Ordering, Partitioning & Keys](../messaging/topic.html?p=22-ordering-partitioning-keys) · [Cassandra · Counters, TTL & Static Columns](../cassandra/topic.html?p=15-ttl-counters-static-columns).

- **Sharding & IDs at Instagram** — Instagram Engineering · *Intermediate* · the original description of the 41/13/10 id scheme and logical shards in PostgreSQL. <https://instagram-engineering.com/sharding-ids-at-instagram-1cf5a71e5a5c>
- **TAO: Facebook's Distributed Data Store for the Social Graph** — USENIX ATC 2013 · *Advanced* · how the largest social graph is stored and cached over MySQL. <https://www.usenix.org/conference/atc13/technical-sessions/presentation/bronson>
- **Scaling Memcache at Facebook** — NSDI 2013 · *Advanced* · the cache layer that sits in front of a sharded relational core. <https://www.usenix.org/conference/nsdi13/technical-sessions/presentation/nishtala>
- **Announcing Snowflake** — Twitter Engineering · *Intermediate* · the time-ordered id service alternative to in-database id generation. <https://blog.twitter.com/engineering/en_us/a/2010/announcing-snowflake>
- **PostgreSQL docs — Logical Replication** — PostgreSQL · *Advanced* · the mechanism for moving a logical shard between hosts. <https://www.postgresql.org/docs/current/logical-replication.html>
- **Redis sorted sets** — Redis docs · *Beginner* · the data structure behind capped per-user feeds. <https://redis.io/docs/latest/develop/data-types/sorted-sets/>
- **Designing Data-Intensive Applications, ch. 1 & 11** — Martin Kleppmann · *Advanced* · the Twitter timeline fan-out example and derived data from event streams. <https://dataintensive.net/>

---

*Database Design Handbook — chapter 35.*
