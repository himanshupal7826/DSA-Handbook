# 37 · Case Study: YouTube-like Storage

> **In one line:** A video platform's database stores almost nothing of the video: bytes live in object storage behind a CDN, the database owns **small, read-mostly metadata**, and every high-rate signal — views, likes, comment counts — is **appended as an event and aggregated off the hot path**, then served from denormalised, heavily cached read models.

---

## 1. Overview

> **Builds on:** [SQL Handbook · Schema Design](../sql/topic.html?p=30-schema-design) (entities and keys, not repeated) · [SQL Handbook · Sorting & Pagination](../sql/topic.html?p=03-sorting-pagination) (keyset paging) · [Ch 04 · Concurrency Control](topic.html?p=04-concurrency-control) (why hot counters serialise) · [Ch 19 · Database Caching Architecture](topic.html?p=19-database-caching-architecture) · [Ch 29 · Advanced Database Patterns](topic.html?p=29-advanced-database-patterns) (CDC, CQRS read models). The end-to-end system — transcoding, adaptive bitrate, CDN economics, recommendations — is covered in [System Design · Design YouTube](../system-design/topic.html?p=37-design-youtube). This chapter designs only the **data layer**.

### The product

**Functional requirements**

- Upload a video; it goes through processing (transcode to renditions, thumbnails, captions) and becomes playable.
- Watch page: title, description, channel, subscriber count, view count, like count, whether *you* liked it, and the top comments.
- Channel page: the channel's videos, newest first.
- Like / unlike (and dislike); comment and reply; sort comments by "Top" or "Newest".
- Search by title, description, tags.
- Creators see analytics (views per day, watch time) — can be hours stale.

**Non-functional requirements**

- Watch-page metadata p99 under 50 ms at the origin; most requests never reach the origin.
- A view count may be **approximate and lag by minutes**; a like count may lag by seconds; *your own* like must show immediately (read-your-writes).
- Never lose a like; never count the same user's like twice.
- Metadata must be highly available — if metadata is down, nothing plays even though the CDN has the bytes.

### Workload estimate

| Quantity | Estimate | Derivation |
|---|---|---|
| Daily active users | 800 M | product assumption |
| Views per day | 5 B → ~58 K/s avg, ~150 K/s peak | 6 views/DAU; peak 2.5× |
| Video-card reads (feeds, search results, sidebars) | ~50 B/day → ~600 K/s avg | each page shows ~20 cards |
| Uploads | ~50/s (≈ 500 hours of video per minute at ~10 min avg) | industry-reported order of magnitude |
| Likes/dislikes | ~500 M/day → ~6 K/s avg | |
| Comments | ~100 M/day → ~1.2 K/s | |
| Total videos | on the order of 1 B+ | |
| Metadata per video | ~2–4 KB (row + indexes) | a few TB total: fits a modest sharded cluster |
| Video bytes | exabyte order across renditions | object storage, never the database |
| Read : write (metadata) | > 1,000 : 1 | |

The two numbers that shape the design: **~600 K metadata reads per second**, which no primary database should see, and **~150 K view events per second at peak**, concentrated on a small number of viral videos — a single trending video can take tens of thousands of views per second.

### Why the naive schema breaks

```sql
CREATE TABLE videos (id bigserial PRIMARY KEY, channel_id bigint, title text, description text,
                     video_data bytea, views bigint DEFAULT 0, likes bigint DEFAULT 0, ...);
-- per view:  UPDATE videos SET views = views + 1 WHERE id = $1;
-- per like:  UPDATE videos SET likes = likes + 1 WHERE id = $1;
-- search:    SELECT ... WHERE title ILIKE '%cat%';
```

- **`bytea` for video.** A 10-minute 1080p video is hundreds of MB; with renditions, GBs. Storing that in a row means TOAST pages, huge backups, replication streams full of video bytes and a buffer pool evicted by blobs. Blobs belong in object storage, addressed by key.
- **`UPDATE views = views + 1` per view.** Every update takes the row lock and writes a new tuple version plus WAL ([Ch 03 · MVCC](topic.html?p=03-mvcc)). A single row serialises on its lock: with a durable commit of ~1 ms the row tops out around 1,000 increments per second, and a viral video needs 30,000. The row also churns so fast that autovacuum cannot keep up, and because `views` lives in the same wide row as the title and description, every increment copies the whole row.
- **`likes = likes + 1` without a per-user record.** A double-tap or a retried request counts twice, and there is no way to answer "did I like this?".
- **`ILIKE '%cat%'`.** A sequential scan over a billion rows. Search needs an inverted index in a search engine.
- **One unsharded table serving 600 K reads/s.** Even perfectly indexed point reads at that rate need a cache tier and read models, not a bigger primary.

## 2. Core Concepts

Entities and the invariants that must hold:

- **Video (metadata)** — id, channel, title, description, visibility, status, duration, and **keys** of the master file, renditions and thumbnails in object storage. *Invariant:* a video is playable only when `status = 'ready'` and all referenced objects exist.
- **Asset** — an object in object storage (S3/GCS) under an immutable key like `vod/{video_id}/{rendition}/…`. *Invariant:* the database never holds bytes, only keys; objects are written before the row that references them is marked ready.
- **Channel** — owner of videos; subscriber count is a counter with the same treatment as views.
- **View event** — an append-only record "user/session S watched video V for T seconds". *Invariant:* the displayed count is derived from events, never incremented in-place per view.
- **Reaction (like/dislike)** — one row per `(user_id, video_id)`. *Invariant:* **at most one reaction per user per video**; the aggregate count equals the number of rows (eventually).
- **Counter / aggregate** — `video_stats(video_id, views, likes, dislikes, comments)`, a derived projection. *Invariant:* **monotonically converges** to the true count; each event is applied exactly once in effect.
- **Comment** — belongs to a video; either top-level or a reply to a top-level comment (two levels). *Invariant:* a reply's parent is in the same video.
- **Read model** — a denormalised document ("video card", "watch page") built from the source tables by CDC, stored in a cache/KV store, and served at scale. *Invariant:* rebuildable from the source of truth at any time.
- **Search index** — a separate system (OpenSearch/Elasticsearch) fed from the same change stream; eventually consistent, never authoritative.

## 3. Theory & Principles

### Access patterns, ranked

| # | Access pattern | Rate | Served from | Consistency |
|---|---|---|---|---|
| 1 | Video-card lookup by `video_id` (batch of ~20) | ~600 K/s | Read model in cache/KV | Stale by seconds–minutes |
| 2 | Record a view | ~58 K/s avg, 150 K/s peak | Kafka append | At-least-once; dedup in aggregation |
| 3 | Watch page: metadata + stats + my reaction + top comments | ~60 K/s | Cache → replicas; my reaction from the user shard | My reaction: read-your-writes |
| 4 | Like / unlike | ~6 K/s | Primary (user shard), then event | Strong per user; count eventual |
| 5 | Comments page (top / newest, keyset) | ~20 K/s | Cache → comment shard replicas | Eventual |
| 6 | Channel page: videos by channel, newest first | ~15 K/s | Cache → video shard | Eventual |
| 7 | Search | ~30 K/s | Search cluster | Eventual (seconds) |
| 8 | Upload / processing state changes | ~50 /s × a few transitions | Primary | Strong (state machine) |
| 9 | Creator analytics | low | OLAP warehouse | Hours stale |

The pattern is lopsided: writes that matter for correctness (uploads, reactions, comments, state transitions) are **thousands per second**, while reads are **hundreds of thousands per second** and view events are the one write stream that is enormous. So:

- The **source-of-truth database handles only the low-rate, correctness-sensitive writes**, plus cache misses.
- **View events never touch the relational database per event** — they go to a log and are aggregated.
- **Reads are served from layered caches and precomputed read models**, and the database is sized for cache-miss traffic plus a cold-cache safety margin.

### The counter problem

A counter at 30 K increments per second on one row is a contention problem, not a capacity problem: one row can only be modified by one transaction at a time ([Ch 04 · Concurrency Control](topic.html?p=04-concurrency-control), [Ch 05 · Locking Internals](topic.html?p=05-locking-internals)). There are three families of fixes, and a video platform uses all three at different layers:

1. **Aggregate before writing** — collect events in a stream processor over a window (say 10 s or 1 min) and apply one `+delta` per video per window. 30 K/s on a video becomes one update every 10 s.
2. **Shard the counter** — split one logical counter into N physical rows or keys (`views:{vid}:{0..15}`) and sum on read. Useful for a *live* counter in Redis.
3. **Approximate** — the displayed number is rounded ("1.2M views") and unique-viewer counts use HyperLogLog (~0.8% error at 12 KB per counter in Redis). Exactness is reserved for money: monetised views go through a separate, audited, exact pipeline.

```svg
<svg viewBox="0 0 880 540" width="100%" height="540" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c37a1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
    <marker id="c37a2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="c37a3" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Counting 30,000 views per second on one video</text>
  <rect x="20" y="40" width="840" height="130" rx="10" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="440" y="62" text-anchor="middle" fill="#991b1b" font-size="12" font-weight="bold">Naive: UPDATE videos SET views = views + 1 per view</text>
  <rect x="40" y="80" width="90" height="26" rx="5" fill="#ffffff" stroke="#dc2626"/><text x="85" y="97" text-anchor="middle" fill="#334155">view 1</text>
  <rect x="40" y="110" width="90" height="26" rx="5" fill="#ffffff" stroke="#dc2626"/><text x="85" y="127" text-anchor="middle" fill="#334155">view 2</text>
  <rect x="40" y="140" width="90" height="24" rx="5" fill="#ffffff" stroke="#dc2626"/><text x="85" y="156" text-anchor="middle" fill="#334155">... 30,000/s</text>
  <path d="M132,93 L238,118" stroke="#dc2626" stroke-width="2" marker-end="url(#c37a1)"/>
  <path d="M132,123 L238,123" stroke="#dc2626" stroke-width="2" marker-end="url(#c37a1)"/>
  <path d="M132,152 L238,128" stroke="#dc2626" stroke-width="2" marker-end="url(#c37a1)"/>
  <rect x="240" y="100" width="170" height="46" rx="6" fill="#ffffff" stroke="#dc2626" stroke-width="2"/>
  <text x="325" y="118" text-anchor="middle" fill="#991b1b" font-weight="bold">one row, one lock</text>
  <text x="325" y="134" text-anchor="middle" fill="#334155">queue of waiters</text>
  <text x="440" y="96" fill="#991b1b">- each txn holds the row lock through its commit fsync: ~1,000/s ceiling</text>
  <text x="440" y="116" fill="#991b1b">- each UPDATE writes a full new tuple version (title, description too)</text>
  <text x="440" y="136" fill="#991b1b">- dead tuples faster than autovacuum can reclaim; WAL volume explodes</text>
  <text x="440" y="156" fill="#991b1b">- retries double count; no dedup, no fraud filtering</text>
  <rect x="20" y="186" width="840" height="340" rx="10" fill="#f8fafc" stroke="#94a3b8" stroke-width="2"/>
  <text x="440" y="208" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="bold">Event log + windowed aggregation + idempotent delta apply</text>
  <rect x="40" y="228" width="120" height="60" rx="6" fill="#ffffff" stroke="#94a3b8"/>
  <text x="100" y="250" text-anchor="middle" fill="#1e293b" font-weight="bold">Player</text>
  <text x="100" y="266" text-anchor="middle" fill="#334155">view event after 30 s</text>
  <text x="100" y="280" text-anchor="middle" fill="#334155">event_id = uuid</text>
  <path d="M162,258 L208,258" stroke="#2563eb" stroke-width="2" marker-end="url(#c37a2)"/>
  <rect x="210" y="228" width="140" height="60" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="280" y="250" text-anchor="middle" fill="#1e293b" font-weight="bold">Kafka views</text>
  <text x="280" y="266" text-anchor="middle" fill="#334155">key = video_id</text>
  <text x="280" y="280" text-anchor="middle" fill="#334155">7-day retention</text>
  <path d="M352,258 L398,258" stroke="#2563eb" stroke-width="2" marker-end="url(#c37a2)"/>
  <rect x="400" y="222" width="190" height="72" rx="6" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="495" y="242" text-anchor="middle" fill="#1e293b" font-weight="bold">Stream aggregator</text>
  <text x="495" y="258" text-anchor="middle" fill="#334155">dedup event_id, bot filter</text>
  <text x="495" y="274" text-anchor="middle" fill="#334155">tumbling 10 s window</text>
  <text x="495" y="288" text-anchor="middle" fill="#334155">per video: +delta</text>
  <path d="M592,258 L638,258" stroke="#16a34a" stroke-width="2" marker-end="url(#c37a3)"/>
  <rect x="640" y="222" width="200" height="72" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="740" y="242" text-anchor="middle" fill="#1e293b" font-weight="bold">Postgres stats shard</text>
  <text x="740" y="258" text-anchor="middle" fill="#334155">INSERT stat_windows</text>
  <text x="740" y="272" text-anchor="middle" fill="#334155">ON CONFLICT DO NOTHING</text>
  <text x="740" y="286" text-anchor="middle" fill="#334155">then views += delta</text>
  <text x="440" y="322" text-anchor="middle" fill="#166534" font-weight="bold">30,000 row updates/s become 1 update per video per 10 s: 3 per 30 s instead of 900,000</text>
  <rect x="40" y="340" width="380" height="80" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="230" y="360" text-anchor="middle" fill="#1e293b" font-weight="bold">Optional live counter (Redis)</text>
  <text x="230" y="378" text-anchor="middle" fill="#334155">INCR views:{vid}:{rand 0..15}  (16 sharded keys)</text>
  <text x="230" y="394" text-anchor="middle" fill="#334155">read = sum of 16 keys, cached 5 s</text>
  <text x="230" y="410" text-anchor="middle" fill="#334155">display only, never the system of record</text>
  <rect x="460" y="340" width="380" height="80" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="650" y="360" text-anchor="middle" fill="#1e293b" font-weight="bold">Exact vs approximate</text>
  <text x="650" y="378" text-anchor="middle" fill="#334155">displayed: rounded ("1.2M"), minutes stale</text>
  <text x="650" y="394" text-anchor="middle" fill="#334155">unique viewers: HyperLogLog, ~0.8% error</text>
  <text x="650" y="410" text-anchor="middle" fill="#334155">monetised views: separate exact, audited batch</text>
  <rect x="40" y="436" width="800" height="76" rx="6" fill="#ffffff" stroke="#94a3b8"/>
  <text x="60" y="456" fill="#1e293b" font-weight="bold">Why the window table makes it exactly-once in effect</text>
  <text x="60" y="474" fill="#334155">The aggregator may re-emit a window after a crash (at-least-once sink). (video_id, window_start) is a primary key,</text>
  <text x="60" y="490" fill="#334155">so the second insert conflicts and the += delta is skipped in the same transaction. Replaying Kafka from an old offset</text>
  <text x="60" y="506" fill="#334155">re-derives the same windows and is therefore harmless: the counter converges to the true value.</text>
</svg>
```

### Consistency boundaries

| Data | Consistency | Reason |
|---|---|---|
| Video row, status state machine | Strong, single shard | Publishing a video that is not ready breaks playback. |
| Reaction row per `(user, video)` | Strong, single shard (user) | Dedup and "did I like this" must be exact; you see your own like immediately. |
| Like / view / comment counts | Eventual, convergent | Nobody can tell 1,203,004 from 1,203,117; seconds to minutes of lag is invisible. |
| Video cards, watch-page read model | Eventual (CDC lag + cache TTL) | Title edits can take a minute to propagate. |
| Search index | Eventual | A newly uploaded video appearing in search 10 s later is fine. |
| Creator analytics | Batch (hours) | Warehouse, not OLTP. |

## 4. Architecture & Workflow

```svg
<svg viewBox="0 0 880 560" width="100%" height="560" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c37b1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="c37b2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Video platform data layer: bytes, truth, events, read models</text>
  <rect x="20" y="40" width="200" height="60" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="120" y="64" text-anchor="middle" fill="#1e293b" font-weight="bold">Clients</text>
  <text x="120" y="82" text-anchor="middle" fill="#334155">watch, browse, like, comment</text>
  <rect x="260" y="40" width="190" height="60" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="355" y="64" text-anchor="middle" fill="#1e293b" font-weight="bold">CDN</text>
  <text x="355" y="82" text-anchor="middle" fill="#334155">segments + public metadata JSON</text>
  <rect x="490" y="40" width="370" height="60" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="675" y="64" text-anchor="middle" fill="#1e293b" font-weight="bold">Object storage</text>
  <text x="675" y="82" text-anchor="middle" fill="#334155">masters/{id}/source, vod/{id}/{rendition}/seg_*, thumbs/{id}/*</text>
  <path d="M222,70 L258,70" stroke="#2563eb" stroke-width="2" marker-end="url(#c37b1)"/>
  <path d="M452,70 L488,70" stroke="#2563eb" stroke-width="2" marker-end="url(#c37b1)"/>
  <rect x="20" y="124" width="840" height="84" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="440" y="144" text-anchor="middle" fill="#1e3a8a" font-size="12" font-weight="bold">Read tiers (a request stops at the first hit)</text>
  <rect x="40" y="156" width="180" height="40" rx="6" fill="#ffffff" stroke="#2563eb"/><text x="130" y="174" text-anchor="middle" fill="#1e293b">1. CDN edge</text><text x="130" y="188" text-anchor="middle" fill="#334155">anonymous watch JSON, 30 s</text>
  <rect x="245" y="156" width="180" height="40" rx="6" fill="#ffffff" stroke="#2563eb"/><text x="335" y="174" text-anchor="middle" fill="#1e293b">2. in-process LRU</text><text x="335" y="188" text-anchor="middle" fill="#334155">top 100k video cards, 5 s</text>
  <rect x="450" y="156" width="180" height="40" rx="6" fill="#ffffff" stroke="#2563eb"/><text x="540" y="174" text-anchor="middle" fill="#1e293b">3. Redis / KV read model</text><text x="540" y="188" text-anchor="middle" fill="#334155">video_card:{id}, CDC-fed</text>
  <rect x="655" y="156" width="185" height="40" rx="6" fill="#ffffff" stroke="#2563eb"/><text x="747" y="174" text-anchor="middle" fill="#1e293b">4. PG replicas, then primary</text><text x="747" y="188" text-anchor="middle" fill="#334155">misses and rebuilds only</text>
  <rect x="20" y="232" width="410" height="170" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="225" y="254" text-anchor="middle" fill="#166534" font-size="12" font-weight="bold">Postgres (source of truth, sharded)</text>
  <rect x="36" y="266" width="185" height="58" rx="6" fill="#ffffff" stroke="#16a34a"/>
  <text x="128" y="284" text-anchor="middle" fill="#1e293b" font-weight="bold">by channel_id</text>
  <text x="128" y="300" text-anchor="middle" fill="#334155">channels, videos, renditions</text>
  <text x="128" y="314" text-anchor="middle" fill="#334155">video_id embeds shard bits</text>
  <rect x="230" y="266" width="185" height="58" rx="6" fill="#ffffff" stroke="#16a34a"/>
  <text x="322" y="284" text-anchor="middle" fill="#1e293b" font-weight="bold">by user_id</text>
  <text x="322" y="300" text-anchor="middle" fill="#334155">reactions(user, video)</text>
  <text x="322" y="314" text-anchor="middle" fill="#334155">subscriptions, outbox</text>
  <rect x="36" y="332" width="185" height="58" rx="6" fill="#ffffff" stroke="#16a34a"/>
  <text x="128" y="350" text-anchor="middle" fill="#1e293b" font-weight="bold">by video_id</text>
  <text x="128" y="366" text-anchor="middle" fill="#334155">comments, top_comments</text>
  <text x="128" y="380" text-anchor="middle" fill="#334155">keyset paging</text>
  <rect x="230" y="332" width="185" height="58" rx="6" fill="#ffffff" stroke="#16a34a"/>
  <text x="322" y="350" text-anchor="middle" fill="#1e293b" font-weight="bold">by video_id</text>
  <text x="322" y="366" text-anchor="middle" fill="#334155">video_stats, stat_windows</text>
  <text x="322" y="380" text-anchor="middle" fill="#334155">written only by aggregator</text>
  <rect x="470" y="232" width="390" height="170" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="665" y="254" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">Change stream (Kafka)</text>
  <rect x="486" y="266" width="170" height="52" rx="6" fill="#ffffff" stroke="#7c3aed"/>
  <text x="571" y="286" text-anchor="middle" fill="#1e293b" font-weight="bold">views, reactions</text>
  <text x="571" y="302" text-anchor="middle" fill="#334155">key = video_id</text>
  <rect x="674" y="266" width="170" height="52" rx="6" fill="#ffffff" stroke="#7c3aed"/>
  <text x="759" y="286" text-anchor="middle" fill="#1e293b" font-weight="bold">CDC (Debezium)</text>
  <text x="759" y="302" text-anchor="middle" fill="#334155">videos, comments, stats</text>
  <rect x="486" y="330" width="110" height="58" rx="6" fill="#ffffff" stroke="#7c3aed"/>
  <text x="541" y="352" text-anchor="middle" fill="#1e293b">aggregator</text>
  <text x="541" y="368" text-anchor="middle" fill="#334155">to video_stats</text>
  <rect x="606" y="330" width="120" height="58" rx="6" fill="#ffffff" stroke="#7c3aed"/>
  <text x="666" y="352" text-anchor="middle" fill="#1e293b">read-model builder</text>
  <text x="666" y="368" text-anchor="middle" fill="#334155">to video_card KV</text>
  <rect x="736" y="330" width="108" height="58" rx="6" fill="#ffffff" stroke="#7c3aed"/>
  <text x="790" y="352" text-anchor="middle" fill="#1e293b">indexer</text>
  <text x="790" y="368" text-anchor="middle" fill="#334155">to OpenSearch</text>
  <path d="M432,300 L468,300" stroke="#7c3aed" stroke-width="2" marker-end="url(#c37b2)"/>
  <rect x="20" y="424" width="410" height="120" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="40" y="446" fill="#1e293b" font-weight="bold">Write paths</text>
  <text x="40" y="466" fill="#334155">upload: row (status=uploading) then multipart to object store</text>
  <text x="40" y="484" fill="#334155">processing: renditions written, then status=ready (one txn)</text>
  <text x="40" y="502" fill="#334155">like: reactions row + outbox (user shard), count via stream</text>
  <text x="40" y="520" fill="#334155">view: Kafka only; never a per-view database write</text>
  <rect x="470" y="424" width="390" height="120" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="490" y="446" fill="#1e293b" font-weight="bold">Read paths</text>
  <text x="490" y="466" fill="#334155">card grid: multi-get video_card:{ids} from KV</text>
  <text x="490" y="484" fill="#334155">watch page: card + stats + top comments (cached)</text>
  <text x="490" y="502" fill="#334155">"did I like?": point read on user shard (primary)</text>
  <text x="490" y="520" fill="#334155">search: OpenSearch returns ids, then multi-get cards</text>
</svg>
```

### Who owns what

- **Object storage** owns bytes. Keys are derived from `video_id`, so the database stores a small `manifest_key` per rendition, not a URL (URLs are signed and minted per request).
- **Video/channel shards** (keyed by `channel_id`) own metadata. A channel's videos are colocated so the channel page is a single-shard keyset scan. The `video_id` is a 64-bit id with the **logical shard number embedded** (Instagram-style: timestamp bits + shard bits + sequence), so a lookup by `video_id` routes without a directory ([Ch 12 · Sharding](topic.html?p=12-sharding)).
- **User shards** own reactions and subscriptions: "did I like this?" and "my subscriptions" are per-user lookups.
- **Comment shards** (keyed by `video_id`) own comments; a video's comments are colocated.
- **Stats shards** hold `video_stats`, written only by the aggregator. Keeping counters out of the `videos` row means counter churn never rewrites titles and descriptions and never touches the metadata shard's WAL.
- **Read models** — `video_card:{id}` (title, thumbnail key, duration, channel name, avatar, rounded counts) — are denormalised documents in Redis or a KV store like Bigtable/Cassandra, built by a CDC consumer. The 600 K/s card reads hit this tier, not Postgres ([Ch 29 · Advanced Database Patterns](topic.html?p=29-advanced-database-patterns)).

### The upload state machine

```text
 client            API / videos shard                          object storage        processing
 POST /videos ──►  INSERT videos (status='uploading')  ─► returns video_id + presigned multipart URL
 PUT parts  ──────────────────────────────────────────────────► masters/{id}/source
 complete   ──►  UPDATE status='processing' WHERE status='uploading'   ──────────────► transcode job
                                                      renditions written ◄──────────── vod/{id}/...
                 BEGIN; INSERT renditions (...); UPDATE videos SET status='ready', published_at=now()
                        WHERE video_id=$1 AND status='processing'; INSERT outbox('video.published'); COMMIT;
                 CDC ─► read model, search indexer, subscriber notifications
```

The guarded `WHERE status = 'processing'` makes each transition a compare-and-set: a duplicate "transcode done" callback updates zero rows and is ignored.

## 5. Implementation

### Metadata schema (channel-sharded)

```sql
CREATE TABLE channels (
    channel_id    bigint PRIMARY KEY,
    owner_user_id bigint NOT NULL,
    handle        text   NOT NULL,          -- globally unique: enforced by a small, unsharded handles table
    title         text   NOT NULL,
    avatar_key    text,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE videos (
    video_id      bigint PRIMARY KEY,       -- shard bits embedded: routes without lookup
    channel_id    bigint NOT NULL REFERENCES channels,
    title         text   NOT NULL,
    description   text   NOT NULL DEFAULT '',
    tags          text[] NOT NULL DEFAULT '{}',
    visibility    smallint NOT NULL DEFAULT 0,            -- 0 private, 1 unlisted, 2 public
    status        text   NOT NULL DEFAULT 'uploading'
                  CHECK (status IN ('uploading','processing','ready','failed','removed')),
    duration_ms   int,
    master_key    text   NOT NULL,          -- masters/{video_id}/source
    thumb_key     text,
    published_at  timestamptz,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- Channel page: newest public videos first, keyset by (published_at, video_id)
CREATE INDEX videos_channel_pub ON videos (channel_id, published_at DESC, video_id DESC)
    WHERE status = 'ready' AND visibility = 2;

CREATE TABLE renditions (
    video_id      bigint   NOT NULL REFERENCES videos ON DELETE CASCADE,
    rendition     text     NOT NULL,        -- '1080p_av1', '720p_h264', ...
    manifest_key  text     NOT NULL,        -- vod/{video_id}/1080p_av1/index.m3u8
    bitrate_kbps  int      NOT NULL,
    PRIMARY KEY (video_id, rendition)
);
```

The partial index serves exactly one access pattern (channel page) and stays small because it excludes private, failed and processing videos. There is **no** index on `title` — search is not the database's job.

### Stats: counters written only by the aggregator

```sql
CREATE TABLE video_stats (                       -- sharded by video_id
    video_id   bigint PRIMARY KEY,
    views      bigint NOT NULL DEFAULT 0,
    likes      bigint NOT NULL DEFAULT 0,
    dislikes   bigint NOT NULL DEFAULT 0,
    comments   bigint NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now()
) WITH (fillfactor = 70);                         -- counters are not indexed: HOT updates

CREATE TABLE stat_windows (                       -- idempotency ledger for applied windows
    video_id     bigint      NOT NULL,
    window_start timestamptz NOT NULL,
    views        bigint NOT NULL,
    likes        bigint NOT NULL,
    dislikes     bigint NOT NULL,
    comments     bigint NOT NULL,
    PRIMARY KEY (video_id, window_start)
) PARTITION BY RANGE (window_start);              -- daily partitions; drop after Kafka retention + margin
```

The critical transaction — applying a window of aggregated deltas **exactly once in effect**, in one statement for a whole batch of videos:

```sql
-- $1..$6 are parallel arrays from the aggregator: one element per (video, window)
WITH incoming AS (
    SELECT * FROM unnest($1::bigint[], $2::timestamptz[], $3::bigint[], $4::bigint[], $5::bigint[], $6::bigint[])
           AS t(video_id, window_start, views, likes, dislikes, comments)
), applied AS (
    INSERT INTO stat_windows (video_id, window_start, views, likes, dislikes, comments)
    SELECT * FROM incoming
    ON CONFLICT (video_id, window_start) DO NOTHING      -- a replayed window inserts nothing...
    RETURNING video_id, views, likes, dislikes, comments
)
INSERT INTO video_stats AS s (video_id, views, likes, dislikes, comments)
SELECT video_id, sum(views), sum(likes), sum(dislikes), sum(comments) FROM applied GROUP BY video_id
ON CONFLICT (video_id) DO UPDATE                          -- ...so it adds nothing here
   SET views    = s.views    + EXCLUDED.views,
       likes    = s.likes    + EXCLUDED.likes,
       dislikes = s.dislikes + EXCLUDED.dislikes,
       comments = s.comments + EXCLUDED.comments,
       updated_at = now();
```

One statement, one transaction: either the window is recorded **and** the deltas added, or neither. The aggregator commits its Kafka offsets after this succeeds; a crash in between replays the window, which conflicts and adds zero. Sort the batch by `video_id` before sending it so that two concurrent aggregator instances lock `video_stats` rows in the same order and cannot deadlock ([Ch 05 · Locking Internals](topic.html?p=05-locking-internals)). Each video is owned by exactly one Kafka partition, so in practice one aggregator task owns a given video's row anyway.

A 10-second window means at most 8,640 updates per video per day, regardless of whether it gets 10 views or 100 million.

### Reactions: per-user rows for dedup, counts via the stream

```sql
CREATE TABLE reactions (                           -- sharded by user_id
    user_id    bigint   NOT NULL,
    video_id   bigint   NOT NULL,
    value      smallint NOT NULL CHECK (value IN (-1, 1)),   -- 1 like, -1 dislike
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, video_id)
);

CREATE TABLE outbox (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    topic      text  NOT NULL,
    msg_key    text  NOT NULL,
    payload    jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
```

The like transaction must emit the **delta that actually happened**, which depends on the previous state (none → like: +1 like; dislike → like: -1 dislike, +1 like; like → like: nothing):

```sql
BEGIN;
-- Lock any existing reaction so two concurrent taps from the same user serialise.
SELECT value FROM reactions WHERE user_id = 42 AND video_id = 9001 FOR UPDATE;   -- -> prev (maybe none)

INSERT INTO reactions (user_id, video_id, value) VALUES (42, 9001, 1)
ON CONFLICT (user_id, video_id) DO UPDATE SET value = EXCLUDED.value, created_at = now()
WHERE reactions.value <> EXCLUDED.value;            -- no-op (no new tuple) if already liked

-- Application computes the delta from prev and new: here prev = NULL -> {likes:+1}
INSERT INTO outbox (topic, msg_key, payload)
VALUES ('reactions', '9001', '{"event_id":"b7d1...","video_id":9001,"likes":1,"dislikes":0}');
COMMIT;

-- Unlike:
DELETE FROM reactions WHERE user_id = 42 AND video_id = 9001 RETURNING value;   -- 0 rows -> nothing to emit
```

If the `SELECT ... FOR UPDATE` finds no row, two concurrent first-likes can both see "none"; the loser's `INSERT ... ON CONFLICT DO UPDATE` then hits the `WHERE reactions.value <> EXCLUDED.value` guard and updates nothing — the application checks the affected-row count and emits a delta only when a row was actually inserted or changed. The delta events flow through the same windowed aggregator as views, so like counts inherit its exactly-once-in-effect application.

"Did I like this?" is a primary-key read on the user's shard, served from the primary (or from a replica only if it has replayed the user's last write LSN) so your own like is visible immediately ([Ch 09 · Replication](topic.html?p=09-replication), [Ch 10 · Consistency Models](topic.html?p=10-consistency-models)).

### Comments: threaded, keyset-paginated

```sql
CREATE TABLE comments (                            -- sharded by video_id
    video_id     bigint NOT NULL,
    comment_id   bigint NOT NULL,                   -- time-ordered 64-bit id
    parent_id    bigint,                            -- NULL = top-level; else a top-level comment of the same video
    author_id    bigint NOT NULL,
    body         text   NOT NULL CHECK (length(body) <= 10000),
    like_count   int    NOT NULL DEFAULT 0,         -- aggregated, like video_stats
    reply_count  int    NOT NULL DEFAULT 0,
    status       smallint NOT NULL DEFAULT 0,       -- 0 visible, 1 held for review, 2 removed
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (video_id, comment_id),
    FOREIGN KEY (video_id, parent_id) REFERENCES comments (video_id, comment_id)
);

CREATE INDEX comments_top_level_new ON comments (video_id, comment_id DESC)
    WHERE parent_id IS NULL AND status = 0;
CREATE INDEX comments_replies ON comments (video_id, parent_id, comment_id)
    WHERE parent_id IS NOT NULL AND status = 0;

-- "Newest" page 2: keyset after the last comment_id shown
SELECT comment_id, author_id, body, like_count, reply_count, created_at
  FROM comments
 WHERE video_id = 9001 AND parent_id IS NULL AND status = 0
   AND comment_id < 7300118822451
 ORDER BY comment_id DESC
 LIMIT 20;

-- Replies to one comment, oldest first
SELECT comment_id, author_id, body, created_at
  FROM comments
 WHERE video_id = 9001 AND parent_id = 7300118822451 AND status = 0
   AND comment_id > $last_seen
 ORDER BY comment_id
 LIMIT 20;
```

Why only two levels: arbitrary-depth trees need recursive queries or path columns and make pagination of subtrees awkward; YouTube-style "top-level + flat replies" makes every page a single index range scan. The composite foreign key `(video_id, parent_id)` enforces the invariant "a reply's parent is in the same video" — and keeps the FK check on the same shard.

**"Top" comments** cannot be keyset-paginated over a live `like_count`: the score changes between page 1 and page 2, so rows jump pages and repeat or vanish. Instead a periodic job (every few minutes, only for videos with recent comment activity) materialises a ranked snapshot:

```sql
CREATE TABLE top_comments (
    video_id    bigint NOT NULL,
    snapshot_at timestamptz NOT NULL,
    rank        int    NOT NULL,
    comment_id  bigint NOT NULL,
    PRIMARY KEY (video_id, snapshot_at, rank)
);
-- Client receives snapshot_at with page 1 and pages with (snapshot_at, rank > $last_rank):
-- a stable order for the whole browsing session.
```

### Read model builder (the trickiest flow)

The video card is read ~600 K times per second, so it is built once per change and served from a KV store. The builder consumes CDC events for `videos`, `channels` and `video_stats` and must not regress a card with an out-of-order event:

```python
# Consumes Debezium change events (keyed by video_id) and upserts the denormalised card.
def on_change(evt, kv, pg_replica):
    vid = evt.key["video_id"]
    lsn = evt.source["lsn"]                      # commit position of the source change
    # Rebuild from source rather than patching fields: simpler and self-healing.
    row = pg_replica.fetch_one("""
        SELECT v.video_id, v.title, v.thumb_key, v.duration_ms, v.visibility, v.status,
               c.channel_id, c.title AS channel_title, c.avatar_key,
               s.views, s.likes, s.comments
          FROM videos v JOIN channels c USING (channel_id)
          LEFT JOIN video_stats s USING (video_id)      -- cross-shard in production: 2 lookups
         WHERE v.video_id = %s""", (vid,))
    if row is None or row["status"] != "ready" or row["visibility"] != 2:
        kv.delete(f"video_card:{vid}")            # unpublished/removed: must disappear from every surface
        return
    card = {**row, "views_display": round_views(row["views"] or 0), "built_lsn": lsn}
    # Compare-and-set on built_lsn: never overwrite a card built from a newer source state.
    kv.set_if_newer(f"video_card:{vid}", card, version=lsn, ttl_seconds=24 * 3600)
```

Stats change every 10 s for hot videos; rebuilding the whole card at that rate is wasteful, so counts are usually kept in a separate, smaller key (`video_counts:{id}`) that the API merges at read time. Removals (`status = 'removed'`, visibility → private) are the one case where staleness is **not** acceptable — takedowns also trigger an explicit purge of the CDN and the in-process caches.

### Diagnostics

```sql
-- Is anything still incrementing counters in place? (should be only the aggregator's batched statement)
SELECT calls, round(mean_exec_time::numeric, 2) AS mean_ms, rows, left(query, 90)
  FROM pg_stat_statements
 WHERE query ILIKE 'update video%' ORDER BY calls DESC LIMIT 5;

-- Counter table health
SELECT n_tup_upd, n_tup_hot_upd, n_dead_tup, last_autovacuum
  FROM pg_stat_user_tables WHERE relname = 'video_stats';
```

## 6. Advantages, Disadvantages & Trade-offs

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| Video bytes | Object storage + CDN, key in DB | `bytea` / large objects | Cost, backup size, buffer pool pollution, replication bandwidth. |
| View counting | Kafka → windowed aggregation → idempotent delta apply | `UPDATE views = views + 1`; Redis `INCR` as system of record | Row-lock ceiling and bloat; Redis loses increments on failover and has no replay. |
| Counter location | Separate `video_stats` table | Columns on `videos` | Counter churn would rewrite wide rows and churn the metadata shard's WAL and caches. |
| Like dedup | Row per `(user, video)` + aggregated count | Counter only; Bloom filter of likers | Exactness per user and "did I like" require the row. |
| Like shard key | `user_id` | `video_id` | "Did I like it?" and "my liked videos" are per-user; per-video likers list is rarely needed and can be a CDC projection. |
| Video shard key | `channel_id` with shard bits in `video_id` | `video_id` hash | Channel page is single-shard; point lookups still route directly. |
| Comments | Two levels, keyset, ranked snapshots for "Top" | Arbitrary depth; `OFFSET` | Every page is one index range scan; stable ordering for "Top". |
| Search | Separate index via CDC | `ILIKE`, PG full-text on the OLTP primary | Relevance, fuzzy matching, and load isolation. PG `tsvector` is fine for a small catalog. |
| Card reads | Denormalised KV read model | Joins on replicas per request | 600 K/s of joins is a replica fleet; a KV get is ~1 ms and trivially horizontal. |

### When to use this design

- Any content platform where objects are large and immutable (video, images, audio, documents) and engagement signals are high-rate and tolerant of lag: podcast apps, image hosting, news sites with view counters, e-learning platforms.
- Whenever a counter is hotter than ~hundreds of increments per second per row.

### When NOT to use it

- **Counters that are money or quotas** (ad billing impressions, API rate quotas, inventory): approximate or minute-stale counts are wrong there. Use exact, transactional counting or a ledger ([Ch 39 · Payment System](topic.html?p=39-case-payment-system)).
- **A small platform** (thousands of videos, hundreds of views per second in total): `UPDATE ... views = views + 1` on a separate stats table with a Redis buffer flushed every few seconds is fine; Kafka + a stream processor would be over-engineering ([Ch 21 · Database Scaling](topic.html?p=21-database-scaling)).
- **Private, per-user media** (a cloud-drive clone): read patterns are per-owner, not viral, so the elaborate read-model tier buys little.

## 7. Common Mistakes & Best Practices

- **Storing blobs in the database.** Tempting because it is "one transaction". It hurts backups, replicas, the buffer pool and cost per GB. Instead: object storage, immutable keys derived from ids, database row created first (`uploading`) and flipped to `ready` only when objects exist.
- **Per-view `UPDATE ... + 1`.** Covered above; the fix is aggregation before the write. Even at small scale, keep counters in their own table.
- **Counting views without dedup or validity rules.** Retries, refreshes and bots inflate numbers. Instead: `event_id` dedup in the aggregator, minimum watch time, bot filtering — and accept that the displayed count is a *policy output*, not a raw tally.
- **A like counter without per-user rows.** Double counts and no "did I like". Instead: `reactions` PK `(user_id, video_id)` and derived counts.
- **Recounting with `SELECT count(*) FROM reactions WHERE video_id = ?` on the watch page.** It is a scan of millions of rows on a cross-shard key. Instead: the aggregated counter, plus an occasional reconciliation job that recounts per video from a CDC-fed per-video projection.
- **`OFFSET` pagination for comments.** Page 500 reads 10,000 rows. Instead: keyset on `comment_id`; ranked snapshot for "Top".
- **Caching without a removal path.** A taken-down video stays visible in CDN and read-model caches for their TTL. Instead: explicit purge on removal/visibility change; TTLs only as a backstop.
- **Letting cache misses stampede the database.** A viral video's card expires and 20 K requests miss at once. Instead: request coalescing (single flight), stale-while-revalidate, jittered TTLs ([Caching with Redis · Cache Stampede](../redis-caching/topic.html?p=15-cache-stampede), [Caching with Redis · Hot Keys](../redis-caching/topic.html?p=17-hot-keys-avalanche)).
- **Search via `ILIKE`.** Instead: a search engine fed by CDC, returning ids that are hydrated from the card store.

## 8. Production: Failure Scenarios, Monitoring & Scaling

### Scaling path

Following [Ch 21 · Database Scaling](topic.html?p=21-database-scaling) and sized with [Ch 22 · Capacity Planning](topic.html?p=22-capacity-planning):

- **1× (a million views/day)** — one Postgres, `video_stats` separate from `videos`, views buffered in Redis and flushed every 5 s with one `UPDATE ... + delta` per video, Postgres full-text search, a Redis cache for watch pages.
- **10×** — read replicas for metadata and comments; CDN caching of anonymous watch JSON; move search to OpenSearch fed by Debezium; a proper outbox for reactions.
- **100×** — Kafka + stream aggregation for views and reactions; KV read models for cards; shard by channel (videos), user (reactions), video (comments, stats). Metadata is only a few TB — the sharding is for **write isolation and cache-miss throughput**, not storage.
- **1,000× (this chapter's target)** — multi-region read models and caches in every region; metadata writes homed per channel region ([Ch 17 · Multi-Region Databases](topic.html?p=17-multi-region-databases)); the aggregator runs per region and emits deltas to the stats home region.

### Failure scenarios

- **A video goes viral; the watch page for it times out.** Symptom: one Redis key receives 200 K gets/s, its node's CPU pins, latency spikes for every key on that node. Root cause: a single hot key in a cluster is served by one shard. Fix: in-process LRU with a 1–5 s TTL in every API server in front of Redis (the hot set is tiny), and replicate hot keys under suffixed names (`video_card:{id}#3`).
- **The view aggregator is down for 40 minutes.** Symptom: view counts frozen; Kafka consumer lag climbing. Nothing is lost — events are in Kafka for 7 days. On restart, it replays and the `stat_windows` ledger makes already-applied windows no-ops. Alert on consumer lag, not on "views stopped changing".
- **Replay after a bug fix double counts.** Engineers reset offsets to reprocess a day with a corrected bot filter; counts double. Root cause: the new job used different window boundaries (1 min instead of 10 s), so `(video_id, window_start)` keys did not collide. Fix: re-derivations must go to a **new** stats version (compute the corrected totals into a fresh table and swap), never replay into the live counter with different keys.
- **Comment spam wave on one video.** 5 K comments/s on one `video_id` shard. Symptom: that shard's WAL rate and `comments` insert latency spike. Fix: per-video and per-user rate limits at the API, moderation queue (`status = 1`) so spam never enters the visible indexes; the partial indexes exclude held comments.
- **Cold cache after a regional failover.** All read-model caches in the new region are empty; the metadata replicas take 50× their normal load and fall over. Fix: keep read models warm in both regions (replicate the KV store, not just the database), and gate traffic shifts gradually.

### Monitoring

| Metric | Why | Alert when |
|---|---|---|
| Cache hit ratio per tier (CDN, in-process, KV) | the database is sized for misses | KV hit < 98% |
| Kafka consumer lag: aggregator, read-model builder, indexer | freshness of counts, cards, search | > 5 min / > 60 s / > 60 s |
| `video_stats` HOT %, `n_dead_tup` | counter churn health | HOT < 90% |
| Replica replay lag | read-your-writes routing correctness | > 1 s |
| Hot-key detection (Redis `--hotkeys`, proxy stats) | viral videos | single key > 20 K ops/s |
| Orphaned objects (object storage keys with no ready row older than 24 h) | failed uploads cost money | growing |

### Backups, DR and lifecycle

- Metadata, reactions and comments are the irreplaceable data: PITR per shard ([Ch 26 · Backup & DR](topic.html?p=26-backup-disaster-recovery)). Counters can be recomputed from the event lake, so their backups matter less than their correctness.
- Object storage: versioning plus cross-region replication for masters; renditions can be regenerated from masters, so they can live in cheaper, single-region storage classes.
- Raw view events go from Kafka to a data lake (Parquet on object storage) partitioned by day — the source for analytics, fraud re-scoring and counter rebuilds ([Ch 28 · Data Lifecycle](topic.html?p=28-data-lifecycle)).
- Deleted videos: soft delete (`status = 'removed'`) for a grace period, then delete rows and objects; cascade to comments and reactions via background jobs, not a single giant transaction.

## 9. Interview Questions

**Q: Where do you store the video file, and what does the database hold?**
A: The bytes live in object storage (S3/GCS) and are served through a CDN; the database holds only metadata and object keys such as `masters/{video_id}/source` and per-rendition manifest keys. Storing hundreds of megabytes per row would bloat backups, replication and the buffer pool, and object storage is far cheaper per GB and scales without limit. The row is created first with `status = 'uploading'`, the client uploads directly to object storage with a presigned multipart URL, and processing flips the row to `ready` only after the renditions exist. That ordering ensures metadata never points at missing objects.

**Q: Why can't you just run `UPDATE videos SET views = views + 1` per view?**
A: Because every update of the same row serialises on its row lock, each holding it through a durable commit, so one row manages on the order of a thousand increments per second while a viral video needs tens of thousands. Each update also writes a whole new tuple version and WAL record, generating dead tuples faster than vacuum can clean, and if the counter is in the `videos` row it copies the title and description every time. Retries double count and there is no place for bot filtering. The fix is to append view events to a log and apply aggregated deltas per window.

**Q: How do you make windowed counter updates exactly-once in effect?**
A: The aggregator's sink is at-least-once: after a crash it can re-emit a window it already wrote. So the apply statement first inserts `(video_id, window_start, deltas)` into a ledger table whose primary key is that pair with `ON CONFLICT DO NOTHING`, and only the rows actually inserted feed the `+ delta` on the counter, in the same statement. A replayed window conflicts and adds nothing. Offsets are committed after the database transaction, so the failure modes are "applied and replayed" (harmless) or "not applied and replayed" (correct).

**Q: How do you implement likes so a user cannot like twice, and how is the count maintained?**
A: A `reactions` table with primary key `(user_id, video_id)` holds one row per user per video, which gives dedup and answers "did I like this?" with a point read. Liking inserts or updates that row and, in the same transaction, writes an outbox event with the delta that actually occurred, computed from the previous state. The count is maintained by the same windowed aggregation pipeline as views. That keeps the per-user truth strongly consistent and the aggregate eventually consistent, which is exactly what users perceive.

**Q: How do you paginate comments sorted by "Top"?**
A: You cannot keyset-paginate on a live score because it changes between pages, so comments jump pages, repeat or vanish. Instead a job periodically materialises a ranked snapshot per active video — `(video_id, snapshot_at, rank, comment_id)` — and the client pages through one snapshot using `rank > last_rank`, getting a stable order for the session. "Newest" is a straightforward keyset on the time-ordered `comment_id`. Both are single index range scans on the video's shard.

**Q: What is a read model here and why do you need it?**
A: A read model is a denormalised document — the video card with title, thumbnail key, duration, channel name, avatar and rounded counts — built from the source tables by a CDC consumer and stored in a KV store or Redis. Card grids need about 600 K lookups per second, and serving each as a multi-table join on replicas would require an enormous replica fleet. With a read model each card is a single key get, the source database sees only cache misses and rebuilds, and the model can be thrown away and rebuilt from the database at any time.

**Q: How do you shard video metadata?**
A: By `channel_id`, so a channel's videos are colocated and the channel page is a single-shard keyset scan, and with the logical shard number embedded in the 64-bit `video_id` so a lookup by `video_id` routes without a directory. Reactions are sharded by `user_id` because their hot query is per user, and comments and stats by `video_id`. Each table gets the shard key of its dominant access pattern, and cross-cutting views are built by CDC projections. The metadata volume is only terabytes, so sharding is about write isolation and miss throughput rather than capacity.

**Q: Why is search a separate system?**
A: Search needs an inverted index with tokenisation, stemming, fuzzy matching and relevance ranking, and its query load is large and spiky; running it on the OLTP database would compete with correctness-critical writes. A search cluster fed by CDC keeps the index within seconds of the source and returns ids, which are hydrated from the card read model. For a small catalog, Postgres full-text search with a GIN index on a `tsvector` column is perfectly adequate and avoids another system.

**Q: A replay of a day of view events doubled the counts. What happened and how do you prevent it? (Senior)**
A: Idempotency depended on the `(video_id, window_start)` key colliding with windows already applied. If the replayed job uses different window boundaries — a different window size or alignment — the keys do not collide and every delta is applied again. More generally, re-deriving numbers with changed logic is not a replay, it is a new computation. I would compute corrected totals from the event lake into a new stats table (or a new version column), validate them against the old ones, and swap atomically, never pour a re-derivation into the live counter. The ledger protects against duplicates of the same computation, not against a different computation.

**Q: How do you handle a single viral video whose card key is hit 200 K times per second? (Senior)**
A: A Redis cluster serves each key from one shard, so one hot key saturates one node regardless of cluster size. The main fix is a small in-process cache with a 1–5 second TTL in every API server: the hot set is tiny, and 200 K/s across hundreds of servers becomes a trickle to Redis. For the remaining traffic I would replicate the key under several suffixed names and pick one at random, and protect misses with single-flight so an expiry does not stampede the database. For anonymous traffic, CDN caching of the watch JSON for a few seconds removes most of the load before it reaches the origin.

**Q: How would you provide an exact, auditable view count for monetisation? (Senior)**
A: The displayed count is approximate and allowed to be revised; the billable count must be exact, reproducible and explainable. I would keep raw validated view events in the data lake, partitioned by day and immutable, and compute billable views in a batch job with a versioned rule set, writing results to a ledger-like table keyed by `(video_id, day, rule_version)` that is never updated in place — corrections are new versions. Reconciliation compares batch totals against the streaming totals and flags divergences. That separates "fast and approximate for display" from "slow and exact for money", which is the standard split.

**Q: Your watch-page read model shows a video that was taken down an hour ago. Why, and what is the fix? (Senior)**
A: Removal propagated as an ordinary CDC update, but the card lived in several caches with TTLs — CDN, in-process caches, the KV read model — and one of them either missed the event or had a TTL longer than the propagation path. Staleness is fine for titles and counts, but not for takedowns, which are a legal and trust issue. The fix is an explicit removal path: the takedown transaction writes an outbox event that synchronously purges the CDN, deletes the KV key and broadcasts an invalidation to in-process caches, and the read path double-checks `status` for any card served from a tier that did not receive the purge. TTLs are only the backstop.

## 10. Quick Revision & Cheat Sheet

| Concern | Design |
|---|---|
| Video bytes | Object storage + CDN; DB stores keys; row `uploading → processing → ready` via guarded updates |
| Metadata | Postgres sharded by `channel_id`; shard bits in `video_id`; partial index for channel page |
| Views | Kafka → dedup + bot filter → 10 s windows → `stat_windows` ledger + `video_stats += delta` in one statement |
| Live counter (optional) | Redis sharded keys, summed on read, display only |
| Likes | `reactions (user_id, video_id)` PK on user shard + outbox delta → same aggregator |
| Comments | Sharded by `video_id`; two levels; keyset on `comment_id`; ranked snapshots for "Top" |
| Card reads (600 K/s) | CDN → in-process LRU → KV read model (CDC-built) → replicas → primary |
| Search | OpenSearch via CDC, returns ids |
| Removals | Explicit purge of every cache tier, not TTL |

- The database is sized for cache misses, not for traffic.
- Never increment a hot row per event; aggregate, then apply idempotent deltas.
- Per-user rows for dedup, aggregated counters for display — both, never one.
- Counters live in their own narrow table so churn stays HOT and away from metadata.
- Keyset pagination everywhere; snapshot rankings that change.
- Approximate for display, exact (and batch) for money.
- Every read model must be rebuildable from the source of truth.

## 11. Hands-On Exercises

Lab: `docker run --name vids -e POSTGRES_PASSWORD=pw -p 5432:5432 -d postgres:17`.

1. **Measure the hot-row ceiling.** Create `video_stats` and run `pgbench -n -c 64 -T 30 -f incr.sql` where `incr.sql` is `UPDATE video_stats SET views = views + 1 WHERE video_id = 1;`. Record TPS and `n_dead_tup`. Repeat with `synchronous_commit = off` for the session and explain the difference.
2. **Windowed apply is idempotent.** Implement the `unnest` apply statement; run the same batch twice and confirm the counters change once. Then run it with a batch where half the windows are new.
3. **Deadlock-proof batching.** Run two concurrent apply statements whose batches contain the same videos in opposite order; provoke a deadlock (`40P01`). Sort both batches by `video_id` and show it disappears.
4. **Comments keyset vs OFFSET.** Load 2 M comments on one video; compare `EXPLAIN (ANALYZE, BUFFERS)` for page 5,000 via `OFFSET` and via keyset.
5. **Reaction state transitions.** Write the like/dislike/unlike functions and a test that drives random sequences of taps from 10 concurrent sessions for one user; verify that the sum of emitted deltas equals the final state.
6. **Search separation (small scale).** Add a generated `tsvector` column on title/description with a GIN index, compare it to `ILIKE '%term%'` on 1 M rows, and write down at what point you would move to a search engine.

**Mini project — view pipeline.** Build a tiny pipeline: a producer writes view events (with `event_id`, occasional duplicates) to Redpanda/Kafka; an aggregator in Python or Go keeps 10 s tumbling windows per video, dedups `event_id` within the window, and applies deltas with the ledger statement; a card builder writes `video_card:{id}` to Redis from Postgres. Kill the aggregator mid-window, restart from committed offsets, and prove the final counts match an offline `count(DISTINCT event_id)`.

## 12. Related Topics & Free Learning Resources

**Concept chapters this design applies**

- [Ch 03 · MVCC](topic.html?p=03-mvcc) — why hot counters bloat.
- [Ch 04 · Concurrency Control](topic.html?p=04-concurrency-control) and [Ch 05 · Locking Internals](topic.html?p=05-locking-internals) — row-lock serialisation and deadlock-free batch ordering.
- [Ch 09 · Replication](topic.html?p=09-replication) and [Ch 10 · Consistency Models](topic.html?p=10-consistency-models) — read-your-writes for your own like.
- [Ch 12 · Sharding](topic.html?p=12-sharding) — a different shard key per table family.
- [Ch 17 · Multi-Region Databases](topic.html?p=17-multi-region-databases) — regional read models and homed writes.
- [Ch 19 · Database Caching Architecture](topic.html?p=19-database-caching-architecture) — cache tiers and invalidation.
- [Ch 21 · Database Scaling](topic.html?p=21-database-scaling) and [Ch 22 · Capacity Planning](topic.html?p=22-capacity-planning) — the ladder and the numbers.
- [Ch 28 · Data Lifecycle](topic.html?p=28-data-lifecycle) — event lake, removal, retention.
- [Ch 29 · Advanced Database Patterns](topic.html?p=29-advanced-database-patterns) — outbox, CDC, CQRS read models.
- Sibling case studies: [Ch 35 · Instagram-like Storage](topic.html?p=35-case-social-media) (likes and feeds), [Ch 36 · WhatsApp-like Messaging](topic.html?p=36-case-messaging) (keyset logs).

**SQL Handbook:** [Schema Design](../sql/topic.html?p=30-schema-design) · [Index Design](../sql/topic.html?p=20-index-design) · [Sorting & Pagination](../sql/topic.html?p=03-sorting-pagination) · [Partitioning](../sql/topic.html?p=23-partitioning)

**Other handbooks:** [System Design · Design YouTube](../system-design/topic.html?p=37-design-youtube) · [System Design · CDN](../system-design/topic.html?p=11-cdn) · [Caching with Redis · Cache Stampede](../redis-caching/topic.html?p=15-cache-stampede) · [Caching with Redis · Hot Keys & Avalanche](../redis-caching/topic.html?p=17-hot-keys-avalanche) · [Caching with Redis · Probabilistic Structures](../redis-caching/topic.html?p=20-probabilistic-structures) · [Kafka & RabbitMQ · Kafka Connect & CDC](../messaging/topic.html?p=25-kafka-connect-cdc)

**Free resources**

- **Sharding & IDs at Instagram** — Instagram Engineering · *Intermediate* · 64-bit ids with embedded shard bits, the scheme used for `video_id` here. <https://instagram-engineering.com/sharding-ids-at-instagram-1cf5a71e5a5c>
- **Scaling Memcache at Facebook (NSDI 2013)** — Nishtala et al. · *Advanced* · lease-based stampede protection and cache tiers in front of MySQL. <https://www.usenix.org/conference/nsdi13/technical-sessions/presentation/nishtala>
- **PostgreSQL Documentation: INSERT ... ON CONFLICT** — PostgreSQL · *Beginner* · the upsert and conflict semantics behind the delta ledger. <https://www.postgresql.org/docs/current/sql-insert.html>
- **PostgreSQL Documentation: Full Text Search** — PostgreSQL · *Intermediate* · when in-database search is enough. <https://www.postgresql.org/docs/current/textsearch.html>
- **Redis: HyperLogLog** — Redis · *Beginner* · approximate unique counts in 12 KB. <https://redis.io/docs/latest/develop/data-types/probabilistic/hyperloglogs/>
- **Debezium Documentation** — Debezium · *Intermediate* · CDC from Postgres for read models and search indexing. <https://debezium.io/documentation/>
- **Designing Data-Intensive Applications, ch. 11 & 12** — Martin Kleppmann · *Advanced* · stream processing, derived data and idempotent sinks. <https://dataintensive.net/>

---

*Database Design Handbook — chapter 37.*
