# 04 · Redis Data Types & Which to Cache With

> **In one line:** Redis's value in caching comes from choosing the *right* data type for the job — a string for a whole object, a hash for a field-addressable one, a sorted set for a leaderboard or rate limiter, a bitmap or HyperLogLog when approximate answers save enormous memory — because the type you pick decides your round trips, your memory footprint, and which operations are atomic.

---

## 1. Overview

Most people's mental model of Redis is `GET`/`SET` on strings, and for a surprising amount of caching that is enough. But treating Redis as a string store throws away its defining advantage: the *value* of a key can be a structured, server-side data type with its own atomic operations. Choosing the right one is not decoration — it changes how many round trips a task takes, how much memory it consumes, and whether an operation is atomic or a race waiting to happen.

The types split into two groups. The **core collections** — strings, hashes, lists, sets, sorted sets — are the everyday tools, each suited to a shape of data. The **specialised types** — streams, bitmaps, HyperLogLog, geospatial indexes — trade generality for a specific superpower: streams give you a durable, replayable log; bitmaps and HyperLogLog give you approximate answers in a tiny fraction of the memory an exact answer would need.

This chapter is a decision guide, not an exhaustive reference. For each type it answers the only question that matters when you are designing a cache: *what caching job is this type actually best at, and what does choosing it cost me?* A string is right for a whole object you read and write as a unit. A hash is right when you address individual fields. A sorted set is right when order or a score matters — leaderboards, sliding-window rate limiters, time-ranged data. A bitmap is right for dense boolean facts about millions of ids. Getting these matches right is most of what separates a Redis cache that is a joy from one that is a pile of JSON blobs and races.

Later chapters go deep on the important ones — hashes and object caching (18), sorted sets for rate limiting (19), probabilistic types (20), streams (21). This chapter gives you the map so those chapters land in the right place.

## 2. Core Concepts

- **String** — the fundamental type: a binary-safe blob up to 512 MB. Holds anything — a number, a serialized object, a rendered fragment.
- **Hash** — a map of field→value inside one key. Field-addressable: read or update one field without touching the rest.
- **List** — an ordered sequence, push/pop at both ends. Queues, recent-items lists, capped logs.
- **Set** — an unordered collection of unique members, with fast membership tests and set algebra (union/intersection).
- **Sorted set (ZSet)** — members ordered by a floating-point *score*, with range queries by rank or score. Leaderboards, rate limiters, priority queues, time windows.
- **Stream** — an append-only log of entries with consumer groups; durable, replayable event delivery.
- **Bitmap** — a string treated as a bit array; billions of booleans in kilobytes. Presence, feature flags, daily-active tracking.
- **HyperLogLog** — a probabilistic cardinality estimator: count unique items in ~12 KB regardless of how many.
- **Geospatial** — a sorted set specialised for coordinates, with radius queries.
- **Encoding** — Redis internally stores small collections compactly (listpack/intset) and switches to a full structure past a threshold; a memory optimisation you can tune.

## 3. Theory & Principles

### Match the type to the shape of the data and the access pattern

The choice follows from two questions: *what shape is the data* and *how will you access it*.

- **A whole object you read and write as a unit** → **string**. Serialize it (JSON, protobuf, msgpack) and `SET`/`GET`. Simple, and correct when you never need just one field. The cost is that updating one field means fetching, decoding, modifying, re-encoding and re-writing the whole thing.
- **An object where you read or update individual fields** → **hash**. `HGET user:9 email` reads one field; `HINCRBY user:9 logins 1` updates one field atomically, server-side, in one round trip. Also more memory-efficient for small objects (compact listpack encoding). The cost is that a hash cannot itself have a TTL per field — expiry is per key.
- **An ordered sequence with push/pop at the ends** → **list**. A capped "recent activity" feed (`LPUSH` + `LTRIM`), a simple job queue (`LPUSH`/`BRPOP`). The cost is that random access by index is O(N).
- **A collection where membership and uniqueness matter** → **set**. "Has this user seen this item?", tag membership, deduplication, and set algebra like "users in both segment A and B" (`SINTER`). The cost is no ordering.
- **Anything where a score or order matters** → **sorted set**. Leaderboards (score = points), sliding-window rate limiters (score = timestamp), priority queues (score = priority), time-ranged caches (score = time, `ZRANGEBYSCORE` to fetch a window). The most versatile type, and the one that most often replaces application-side logic with one atomic command. The cost is higher per-element memory than a plain set.
- **Approximate answers to save massive memory** → **bitmap or HyperLogLog**. Counting 100 million unique visitors exactly needs gigabytes; HyperLogLog does it in 12 KB with ~0.8% error. Tracking whether each of 50 million users did something today needs 50 million booleans; a bitmap holds them in ~6 MB. When the exact answer is not worth the memory, these are transformative.

### Encodings: why small collections are cheap

Redis stores small collections in a compact form and switches to the full data structure only past a configurable threshold. A hash with a handful of small fields is stored as a **listpack** — a flat, memory-efficient array — not a hash table, so it costs a fraction of the memory. Cross the threshold (`hash-max-listpack-entries`, default 128) and it converts to a real hash table, which is faster for large hashes but uses more memory per field. The same applies to small sets (intset for all-integer sets, listpack otherwise), small sorted sets and small lists.

The practical consequence for caching is a memory-optimisation lever: **many small hashes are far cheaper than the same data as many strings**, because the listpack encoding and the shared key overhead work in your favour. A classic technique is to shard a large flat keyspace into hashes — instead of a million `user:N:email` string keys, use ten thousand hashes each holding a hundred users' emails as fields, staying under the listpack threshold. This is covered in depth in chapter 18; here the point is that the *type* and its *encoding* together determine the memory cost, and the type choice is where the biggest wins are.

```svg
<svg viewBox="0 0 880 500" width="100%" height="500" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Which type? Match the data shape to the caching job</text>

  <rect x="24" y="42" width="272" height="130" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="160" y="64" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">String</text>
  <text x="40" y="86" fill="#1d4ed8" font-size="10">whole object, read/write as a unit</text>
  <text x="40" y="104" fill="#1d4ed8" font-size="10">SET/GET a JSON/protobuf blob</text>
  <text x="40" y="124" fill="#1e40af" font-size="9" font-weight="bold">cache: pages, fragments, whole objects,</text>
  <text x="40" y="140" fill="#1e40af" font-size="9" font-weight="bold">counters (INCR)</text>
  <text x="40" y="160" fill="#64748b" font-size="9">cost: change one field &#8594; rewrite the whole value</text>

  <rect x="304" y="42" width="272" height="130" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="440" y="64" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Hash</text>
  <text x="320" y="86" fill="#166534" font-size="10">field-addressable object</text>
  <text x="320" y="104" fill="#166534" font-size="10">HGET/HSET/HINCRBY one field</text>
  <text x="320" y="124" fill="#15803d" font-size="9" font-weight="bold">cache: user profiles, config objects,</text>
  <text x="320" y="140" fill="#15803d" font-size="9" font-weight="bold">anything you update per-field</text>
  <text x="320" y="160" fill="#64748b" font-size="9">cost: TTL is per key, not per field</text>

  <rect x="584" y="42" width="272" height="130" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="720" y="64" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">Sorted set (ZSet)</text>
  <text x="600" y="86" fill="#6d28d9" font-size="10">score or order matters</text>
  <text x="600" y="104" fill="#6d28d9" font-size="10">ZADD/ZRANGEBYSCORE, atomic</text>
  <text x="600" y="124" fill="#5b21b6" font-size="9" font-weight="bold">cache: leaderboards, rate limiters,</text>
  <text x="600" y="140" fill="#5b21b6" font-size="9" font-weight="bold">time windows, priority queues</text>
  <text x="600" y="160" fill="#64748b" font-size="9">cost: more memory per element</text>

  <rect x="24" y="184" width="272" height="120" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="160" y="206" text-anchor="middle" fill="#92400e" font-size="12" font-weight="bold">Set</text>
  <text x="40" y="228" fill="#b45309" font-size="10">membership + uniqueness + algebra</text>
  <text x="40" y="246" fill="#b45309" font-size="10">SADD/SISMEMBER/SINTER</text>
  <text x="40" y="266" fill="#92400e" font-size="9" font-weight="bold">cache: "seen this?", tags, dedup,</text>
  <text x="40" y="282" fill="#92400e" font-size="9" font-weight="bold">segment intersections</text>
  <text x="40" y="298" fill="#64748b" font-size="9">cost: no ordering</text>

  <rect x="304" y="184" width="272" height="120" rx="8" fill="#fce7f3" stroke="#db2777" stroke-width="2"/>
  <text x="440" y="206" text-anchor="middle" fill="#9d174d" font-size="12" font-weight="bold">List</text>
  <text x="320" y="228" fill="#be185d" font-size="10">ordered sequence, push/pop ends</text>
  <text x="320" y="246" fill="#be185d" font-size="10">LPUSH/LTRIM/BRPOP</text>
  <text x="320" y="266" fill="#9d174d" font-size="9" font-weight="bold">cache: capped recent-items feed,</text>
  <text x="320" y="282" fill="#9d174d" font-size="9" font-weight="bold">simple queues</text>
  <text x="320" y="298" fill="#64748b" font-size="9">cost: random access by index is O(N)</text>

  <rect x="584" y="184" width="272" height="120" rx="8" fill="#cffafe" stroke="#0891b2" stroke-width="2"/>
  <text x="720" y="206" text-anchor="middle" fill="#155e75" font-size="12" font-weight="bold">Stream</text>
  <text x="600" y="228" fill="#0e7490" font-size="10">durable, replayable event log</text>
  <text x="600" y="246" fill="#0e7490" font-size="10">XADD/XREADGROUP, consumer groups</text>
  <text x="600" y="266" fill="#155e75" font-size="9" font-weight="bold">cache: invalidation events, activity</text>
  <text x="600" y="282" fill="#155e75" font-size="9" font-weight="bold">streams, at-least-once delivery</text>
  <text x="600" y="298" fill="#64748b" font-size="9">cost: heavier than Pub/Sub</text>

  <rect x="24" y="316" width="832" height="172" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="338" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Probabilistic types: trade exactness for enormous memory savings</text>
  <rect x="48" y="352" width="380" height="120" rx="6" fill="#fff" stroke="#64748b"/>
  <text x="238" y="372" text-anchor="middle" fill="#334155" font-size="11" font-weight="bold">Bitmap</text>
  <text x="62" y="394" fill="#475569" font-size="10">a string as a bit array &#8594; billions of booleans in KB</text>
  <text x="62" y="412" fill="#475569" font-size="10">SETBIT/GETBIT/BITCOUNT</text>
  <text x="62" y="434" fill="#334155" font-size="9" font-weight="bold">50M users' daily-active flags &#8594; ~6 MB</text>
  <text x="62" y="452" fill="#475569" font-size="9">exact answer, tiny memory &#8212; if the fact is one bit</text>

  <rect x="452" y="352" width="380" height="120" rx="6" fill="#fff" stroke="#64748b"/>
  <text x="642" y="372" text-anchor="middle" fill="#334155" font-size="11" font-weight="bold">HyperLogLog</text>
  <text x="466" y="394" fill="#475569" font-size="10">cardinality estimate in ~12 KB, ANY count</text>
  <text x="466" y="412" fill="#475569" font-size="10">PFADD/PFCOUNT, ~0.8% error</text>
  <text x="466" y="434" fill="#334155" font-size="9" font-weight="bold">100M unique visitors &#8594; 12 KB (vs GBs exact)</text>
  <text x="466" y="452" fill="#475569" font-size="9">approximate answer &#8212; when exact isn't worth GBs</text>
</svg>
```

## 4. Architecture & Workflow

A decision procedure for picking a type:

1. **Is the value a whole object you always read and write together?** → **string**. Serialize and `SET`/`GET`. Reach for a hash instead only if you need per-field access.
2. **Do you read or update individual fields of an object?** → **hash**. One round trip per field, atomic field updates, and cheaper memory for small objects.
3. **Does order or a score matter?** → **sorted set**. Score = points (leaderboard), timestamp (rate limiter, time window), or priority (queue). If you find yourself sorting in the application, the sorted set probably does it atomically for you.
4. **Do you need membership, uniqueness, or set algebra?** → **set**. "Seen it?", tags, deduplication, intersections.
5. **Is it an ordered sequence you push/pop at the ends?** → **list**. Capped feeds, simple queues.
6. **Is it an event log others must replay reliably?** → **stream**. Durable, consumer groups, at-least-once.
7. **Would the exact answer cost more memory than it is worth?** → **bitmap** (one boolean per id) or **HyperLogLog** (unique counts). Accept small error for huge savings.

```svg
<svg viewBox="0 0 880 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="d1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#64748b"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The decision procedure &#8212; each type replaces application logic with one atomic command</text>

  <rect x="300" y="40" width="280" height="38" rx="8" fill="#f1f5f9" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="64" text-anchor="middle" fill="#334155" font-weight="bold">What shape is the value, and how do you access it?</text>

  <path d="M300,59 L150,90" stroke="#64748b" stroke-width="1.5" fill="none" marker-end="url(#d1)"/>
  <path d="M370,78 L300,130" stroke="#64748b" stroke-width="1.5" fill="none" marker-end="url(#d1)"/>
  <path d="M440,78 L440,130" stroke="#64748b" stroke-width="1.5" marker-end="url(#d1)"/>
  <path d="M510,78 L580,130" stroke="#64748b" stroke-width="1.5" fill="none" marker-end="url(#d1)"/>
  <path d="M580,59 L740,90" stroke="#64748b" stroke-width="1.5" fill="none" marker-end="url(#d1)"/>

  <rect x="40" y="92" width="180" height="60" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="130" y="112" text-anchor="middle" fill="#1e40af" font-size="10" font-weight="bold">whole object?</text>
  <text x="130" y="130" text-anchor="middle" fill="#1d4ed8" font-size="10">&#8594; STRING</text>
  <text x="130" y="146" text-anchor="middle" fill="#1d4ed8" font-size="9">SET/GET a blob</text>

  <rect x="230" y="132" width="180" height="60" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="320" y="152" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">per-field object?</text>
  <text x="320" y="170" text-anchor="middle" fill="#166534" font-size="10">&#8594; HASH</text>
  <text x="320" y="186" text-anchor="middle" fill="#166534" font-size="9">HGET/HINCRBY one field</text>

  <rect x="350" y="132" width="180" height="60" rx="6" fill="#ede9fe" stroke="#7c3aed" opacity="0"/>
  <rect x="360" y="200" width="180" height="60" rx="6" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="450" y="220" text-anchor="middle" fill="#5b21b6" font-size="10" font-weight="bold">order/score matters?</text>
  <text x="450" y="238" text-anchor="middle" fill="#6d28d9" font-size="10">&#8594; SORTED SET</text>
  <text x="450" y="254" text-anchor="middle" fill="#6d28d9" font-size="9">leaderboard, rate limit, window</text>

  <rect x="490" y="132" width="180" height="60" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="580" y="152" text-anchor="middle" fill="#92400e" font-size="10" font-weight="bold">membership/algebra?</text>
  <text x="580" y="170" text-anchor="middle" fill="#b45309" font-size="10">&#8594; SET</text>
  <text x="580" y="186" text-anchor="middle" fill="#b45309" font-size="9">SISMEMBER, SINTER</text>

  <rect x="660" y="92" width="190" height="60" rx="6" fill="#f8fafc" stroke="#64748b"/>
  <text x="755" y="112" text-anchor="middle" fill="#334155" font-size="10" font-weight="bold">exact answer not worth GBs?</text>
  <text x="755" y="130" text-anchor="middle" fill="#475569" font-size="10">&#8594; BITMAP / HYPERLOGLOG</text>
  <text x="755" y="146" text-anchor="middle" fill="#475569" font-size="9">boolean-per-id / unique count</text>

  <rect x="40" y="284" width="810" height="60" rx="8" fill="#fefce8" stroke="#ca8a04" stroke-width="2"/>
  <text x="445" y="306" text-anchor="middle" fill="#854d0e" font-size="11" font-weight="bold">Two cross-cutting rules</text>
  <text x="56" y="326" fill="#713f12" font-size="10">1. Prefer the type whose ATOMIC operations match your task &#8212; a rate limiter as a sorted set is one command; faked with strings it is a race.</text>
  <text x="56" y="340" fill="#713f12" font-size="10">2. Stay under the listpack thresholds &#8212; small hashes/sets are dramatically cheaper; shaping data to stay compact is a first-class memory win.</text>
</svg>
```

Two cross-cutting rules. First, **prefer the type whose atomic operations match your task** — a rate limiter as a sorted set is one atomic command, whereas faked with strings it is a race. Second, **stay under the listpack thresholds where you can** — small hashes and sets are dramatically cheaper, so shaping data to stay compact is a first-class memory optimisation.

## 5. Implementation

One example per major type, each showing the *caching job* the type is best at, so the mapping is concrete.

```go
package datatypes

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// STRING — a whole object cached as a unit. Correct when you never need just
// one field. Serialize, SET with a TTL, GET and decode.
func cacheWholeObject(ctx context.Context, rdb *redis.Client, id string, obj any) error {
	data, err := json.Marshal(obj)
	if err != nil {
		return err
	}
	return rdb.Set(ctx, "obj:"+id, data, 10*time.Minute).Err()
}

// HASH — a field-addressable object. Read or update ONE field in one round
// trip, atomically, without fetching the whole object.
func cacheUserAsHash(ctx context.Context, rdb *redis.Client, userID string) error {
	key := "user:" + userID
	if err := rdb.HSet(ctx, key, "name", "Ada", "email", "ada@x.com", "logins", 0).Err(); err != nil {
		return err
	}
	rdb.Expire(ctx, key, 10*time.Minute)
	// Update ONE field atomically — impossible with a string blob without a
	// full fetch/decode/re-encode/store cycle.
	return rdb.HIncrBy(ctx, key, "logins", 1).Err()
}

// SORTED SET — a leaderboard. Score is the value that orders members; range
// queries by rank are one atomic command.
func leaderboard(ctx context.Context, rdb *redis.Client) ([]redis.Z, error) {
	key := "leaderboard:global"
	rdb.ZAdd(ctx, key, redis.Z{Score: 1500, Member: "ada"})
	rdb.ZAdd(ctx, key, redis.Z{Score: 2200, Member: "grace"})
	rdb.ZIncrBy(ctx, key, 100, "ada") // atomic score bump
	// Top 10, highest score first — the application never sorts anything.
	return rdb.ZRevRangeWithScores(ctx, key, 0, 9).Result()
}

// SORTED SET as a TIME WINDOW — cache entries scored by timestamp, fetch a
// window with one range query, and trim old entries. This same shape is the
// basis of the sliding-window rate limiter in chapter 19.
func timeWindowedCache(ctx context.Context, rdb *redis.Client, key string, now time.Time) error {
	score := float64(now.UnixMilli())
	rdb.ZAdd(ctx, key, redis.Z{Score: score, Member: fmt.Sprintf("event:%d", now.UnixNano())})
	// Drop everything older than the window (e.g. 60s), atomically.
	cutoff := float64(now.Add(-60*time.Second).UnixMilli())
	return rdb.ZRemRangeByScore(ctx, key, "0", fmt.Sprintf("%f", cutoff)).Err()
}

// SET — membership and set algebra. "Which users are in BOTH segment A and B?"
// is one atomic intersection, done server-side.
func setAlgebra(ctx context.Context, rdb *redis.Client) ([]string, error) {
	rdb.SAdd(ctx, "seg:A", "u1", "u2", "u3")
	rdb.SAdd(ctx, "seg:B", "u2", "u3", "u4")
	// Intersection computed on the server — no fetching both sets to the client.
	return rdb.SInter(ctx, "seg:A", "seg:B").Result() // -> u2, u3
}

// LIST — a capped recent-activity feed. LPUSH the newest, LTRIM to keep only
// the last N. Constant memory, newest-first order.
func recentActivity(ctx context.Context, rdb *redis.Client, userID, event string) error {
	key := "activity:" + userID
	rdb.LPush(ctx, key, event)
	return rdb.LTrim(ctx, key, 0, 49).Err() // keep only the 50 most recent
}

// BITMAP — dense boolean facts about millions of ids in tiny memory. "Did user
// N do X today?" is one bit; the daily-active count is one BITCOUNT.
func dailyActive(ctx context.Context, rdb *redis.Client, day string, userID int64) error {
	key := "active:" + day
	// Set user N's bit. 50M users' flags fit in ~6 MB.
	return rdb.SetBit(ctx, key, userID, 1).Err()
}

func dailyActiveCount(ctx context.Context, rdb *redis.Client, day string) (int64, error) {
	return rdb.BitCount(ctx, "active:"+day, nil).Result()
}

// HYPERLOGLOG — unique counts in ~12 KB regardless of scale, ~0.8% error.
// "How many unique visitors today?" without storing every visitor id.
func uniqueVisitors(ctx context.Context, rdb *redis.Client, day, visitorID string) error {
	return rdb.PFAdd(ctx, "visitors:"+day, visitorID).Err()
}

func uniqueVisitorCount(ctx context.Context, rdb *redis.Client, day string) (int64, error) {
	// Approximate — but 100M uniques in 12 KB instead of gigabytes of a set.
	return rdb.PFCount(ctx, "visitors:"+day).Result()
}
```

Every one of these replaces application-side logic — sorting, deduplication, counting, windowing — with a single atomic server-side operation, which is the entire reason to use the right type rather than treating Redis as a string store.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages of using the right type**
- **Fewer round trips.** A field update on a hash, a leaderboard query on a sorted set, an intersection on sets — each is one round trip that would be several against a string store.
- **Atomicity where you need it.** The type's operations are atomic, so counters, rate limiters and windows are correct by construction, not racy.
- **Memory efficiency.** Compact encodings for small collections, and probabilistic types that answer in kilobytes what would take gigabytes exactly.
- **Less application code.** Sorting, deduplication, windowing and counting move to the server, so the client is thinner and the logic is atomic.

**Disadvantages**
- **Type lock-in.** A key's type is fixed once set; changing a cached representation from string to hash is a migration.
- **Per-key TTL, not per-field.** A hash's fields cannot expire independently (until the very recent per-field TTL feature); the whole key expires together.
- **Memory varies by type.** Sorted sets cost more per element than sets; a poorly chosen type can be memory-expensive.
- **Complexity.** More types means more to know, and a wrong choice (a list where random access is needed) can be O(N) where a better type is O(1).

**Trade-offs**
- *String vs hash:* string is simplest and correct for whole-object access; hash saves round trips and memory for field access at the cost of per-key-only TTL. Choose by whether you address fields.
- *Exact vs probabilistic:* a set gives exact membership and counts but scales with the data; HyperLogLog and bitmaps give approximate or one-bit answers in tiny memory. Choose by whether the exact answer is worth the memory.
- *Sorted set vs application logic:* a sorted set does ordering, windowing and range queries atomically server-side; doing it in the application is more flexible but racy and chattier. Prefer the atomic type for anything concurrent.

## 7. Common Mistakes & Best Practices

- **Everything as JSON strings.** The default lazy choice throws away field-addressable updates, atomic operations and memory efficiency. Use a hash when you address fields.
- **Faking a sorted structure with strings.** A leaderboard or rate limiter built from string operations is racy and chatty; the sorted set does it atomically in one command.
- **A set where a bitmap fits.** Storing "did user N do X" as a set of ids costs far more than one bit per user in a bitmap, for the same information.
- **Exact counts when approximate suffices.** Storing every unique visitor id in a set to count uniques wastes gigabytes; HyperLogLog answers in 12 KB.
- **Ignoring encodings.** Large hashes/sets past the listpack threshold cost much more memory; shaping data to stay compact is a real optimisation (chapter 18).
- **A list for random access.** Indexing into a list is O(N); if you need random access, a hash or sorted set is right.
- **Changing a key's type in place.** Types are fixed once set; a representation change is a migration, so pick the right type up front.
- **Best practice: pick the type from the access pattern.** Whole-object → string; field access → hash; order/score → sorted set; membership → set; boolean-per-id → bitmap; unique count → HyperLogLog.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** `TYPE key` tells you a key's type, `OBJECT ENCODING key` tells you its internal encoding (listpack vs hashtable, intset vs listpack) — the latter is the tool for diagnosing "why is this hash using so much memory?" (it crossed the threshold). `MEMORY USAGE key` gives the byte cost of a specific key.
- **Monitoring.** Track memory per keyspace and watch for encoding transitions on hot keys, because a hash silently converting from listpack to hashtable can multiply its memory. `MEMORY DOCTOR` flags instances where encoding thresholds or large keys are the problem.
- **Security.** The type does not change the security model, but the *content* does: a sorted set or hash holding personal data inherits that sensitivity, and probabilistic types are worth noting because a HyperLogLog or bitmap stores facts *about* users without storing their ids, which can be a privacy advantage.
- **Scaling.** Type choice affects scaling directly: a single giant sorted set or hash is a big key that concentrates memory and latency on one node and cannot be sharded across a cluster (all its elements share one slot). Sharding a large logical structure across many keys — many small hashes rather than one huge one — is both a memory win and a prerequisite for Cluster (chapter 26).

## 9. Interview Questions

**Q: When would you cache an object as a string versus a hash?**
A: As a string when you always read and write the whole object together and never need just one field — you serialize it, `SET` with a TTL, and `GET`-and-decode. As a hash when you address individual fields: `HGET user:9 email` reads one field in one round trip, and `HINCRBY user:9 logins 1` updates one field atomically without fetching the whole object. The hash is also more memory-efficient for small objects because of the compact listpack encoding. The trade-offs are that a string is simpler and the natural choice for whole-object access, while a hash gives field-level access and atomic field updates but expires per key rather than per field.

**Q: What is a sorted set best at, and why does it come up so often in caching?**
A: A sorted set orders members by a floating-point score with atomic range queries, which makes it the right tool whenever order or a score matters — and that is a surprising number of caching tasks. Leaderboards use points as the score; sliding-window rate limiters use the timestamp as the score and count entries in a range; time-windowed caches score entries by time and fetch a window with one range query; priority queues use priority as the score. It comes up so often because it replaces application-side sorting and windowing — which are chatty and racy under concurrency — with a single atomic server-side command. If you find yourself sorting or filtering by a numeric key in the application, a sorted set probably does it atomically for you.

**Q: When would you use a bitmap or HyperLogLog instead of a set?**
A: When the exact, fully-materialised answer costs more memory than it is worth. A bitmap when the fact about each id is a single boolean — "did user N log in today?" — because 50 million such flags fit in about 6 MB as bits, versus storing 50 million ids in a set. HyperLogLog when you need a unique *count* but not the members themselves — "how many unique visitors today?" — because it estimates cardinality in about 12 KB regardless of scale, with roughly 0.8% error, versus gigabytes to store every visitor id exactly. You give up exactness (for HyperLogLog) or the ability to enumerate members (for both), and in return you get answers in kilobytes. If you need the actual members or an exact count of a small set, use a set.

**Q: What is a listpack encoding and why does it matter for caching memory?**
A: Redis stores small collections in a compact flat form — a listpack (or intset for all-integer sets) — instead of the full data structure, and only converts to the real hash table, skiplist or hash set once the collection crosses a configurable threshold like `hash-max-listpack-entries`. The compact form uses far less memory per element. This matters because it is a lever: many small hashes are dramatically cheaper than the same data spread across many string keys, so a classic optimisation is to shard a large flat keyspace into hashes kept under the listpack threshold. The type and its encoding together determine the memory cost, and staying compact where you can is a first-class memory optimisation.

**Q: Why not just use strings for everything?**
A: Because it throws away Redis's main advantage and reintroduces problems the right type solves for free. A whole-object string cannot update one field without a full fetch-decode-modify-encode-store cycle, where a hash does it in one atomic round trip. A leaderboard or rate limiter built from string operations is racy and chatty, where a sorted set does it atomically in one command. Counting uniques by storing ids in strings wastes gigabytes where HyperLogLog answers in kilobytes. Set algebra like "users in both segments" is one server-side intersection with sets, but a manual fetch-and-compare with strings. Strings are the right choice for genuinely whole-object, opaque values, but using them for everything means more round trips, more races, and more memory than the task needs.

**Q: (Senior) How does data-type choice interact with Redis Cluster and big keys?**
A: Directly, and it is a common scaling mistake. In Cluster, a key's slot is derived from the key name, so *all* of a single key's elements live on one node — a giant sorted set or hash is a "big key" that concentrates its entire memory and command latency on one shard and cannot be spread across the cluster. That has two consequences: the node holding it becomes a hotspot, and any O(N) operation over it blocks that node's single thread for everyone on that shard. So for large logical structures, the type choice must be paired with a sharding strategy — instead of one huge sorted set, many smaller ones keyed by a bucket; instead of one giant hash, many hashes each under the listpack threshold. This both avoids the big-key latency problem and lets the data distribute across the cluster. The type also affects the atomic-operation story under Cluster: multi-key operations only work if the keys share a slot (via hash tags), so a design that needs atomic operations across several keys must co-locate them deliberately.

**Q: (Senior) Walk through choosing types for a social feed cache.**
A: I would decompose the feed into its access patterns and pick a type per part. The feed itself — a per-user, newest-first, capped list of item ids — is a list: `LPUSH` the newest, `LTRIM` to a cap, giving constant memory and the right order, or a sorted set scored by timestamp if I need range queries by time. Each item's cached content — an object with fields I might update individually, like a like-count — is a hash, so I can `HINCRBY` the like-count atomically without rewriting the whole item. "Which items has this user already seen?" for deduplication is a set, with `SISMEMBER` for the check. "How many unique users viewed this item?" is a HyperLogLog, because I want the count cheaply and do not need the viewer ids. A global trending ranking is a sorted set scored by an engagement metric, with `ZREVRANGE` for the top N. And invalidation events — "this item changed, drop it from caches" — go on a stream for durable, replayable delivery to the cache-warming consumers. Each choice replaces application logic with an atomic server-side operation, and I would size the big ones (the trending sorted set) with sharding in mind so no single key becomes a cluster hotspot.

**Q: (Senior) A hash's memory usage suddenly jumped. What happened and what do you do?**
A: The most likely cause is that the hash crossed the listpack threshold and converted from the compact listpack encoding to a full hash table, which uses significantly more memory per field. Redis stores small hashes as a flat listpack and only switches to a real hash table once the number of fields exceeds `hash-max-listpack-entries` (default 128) or a field value exceeds `hash-max-listpack-value`. I would confirm with `OBJECT ENCODING key`, which will show `hashtable` rather than `listpack`, and `MEMORY USAGE key` for the byte cost. The fix depends on intent: if the hash is legitimately large, the hashtable encoding is correct and faster, and the jump is expected. If I was relying on compactness — for example using hashes to shard a flat keyspace cheaply — then I need to keep each hash under the threshold, which means using more, smaller hashes with a finer bucketing of the key space. I might also raise the threshold config if a slightly larger listpack is an acceptable memory-versus-CPU trade, but the usual answer is to shape the data to stay compact rather than to widen the threshold.

## 10. Quick Revision & Cheat Sheet

| Data shape / access | Type | Key commands |
|---|---|---|
| Whole object, read/write together | String | `SET`/`GET`, `INCR` |
| Object, per-field access | Hash | `HGET`/`HSET`/`HINCRBY` |
| Order or score matters | Sorted set | `ZADD`/`ZRANGEBYSCORE`/`ZREVRANGE` |
| Membership, uniqueness, algebra | Set | `SADD`/`SISMEMBER`/`SINTER` |
| Ordered sequence, push/pop ends | List | `LPUSH`/`LTRIM`/`BRPOP` |
| Durable, replayable event log | Stream | `XADD`/`XREADGROUP` |
| One boolean per id, dense | Bitmap | `SETBIT`/`GETBIT`/`BITCOUNT` |
| Unique count, huge scale | HyperLogLog | `PFADD`/`PFCOUNT` |

**Flash cards**
- **Whole object?** → String. **Per-field object?** → Hash.
- **Order/score?** → Sorted set (leaderboard, rate limiter, time window, priority queue).
- **Membership/algebra?** → Set. **Ordered push/pop?** → List.
- **Boolean per id?** → Bitmap (~6 MB for 50M flags). **Unique count?** → HyperLogLog (~12 KB, any scale).
- **Why not all strings?** → Loses field access, atomic ops, memory efficiency; reintroduces round trips and races.
- **Encoding lever?** → Small collections use compact listpack/intset; stay under the threshold to save memory.
- **Big-key hazard?** → One giant sorted set/hash is a cluster hotspot; shard into many smaller keys.

## 11. Hands-On Exercises & Mini Project

- [ ] Cache the same object as a JSON string and as a hash. Update one field in each and count the operations. Measure the memory with `MEMORY USAGE`.
- [ ] Build a leaderboard with a sorted set and fetch the top 10; then try to do the same with strings and note how much application logic and how many round trips it takes.
- [ ] Track 1 million daily-active flags in a bitmap and count them with `BITCOUNT`; compare the memory to storing the same ids in a set.
- [ ] Count unique visitors two ways — a set of ids and a HyperLogLog — and compare the memory and the count accuracy.
- [ ] Create a hash with 128 small fields, check `OBJECT ENCODING`, add one more, and watch it convert from `listpack` to `hashtable` with a memory jump.
- [ ] Implement a capped recent-activity feed with a list and `LTRIM`, and confirm the memory stays constant as events keep arriving.

### Mini Project — "Type Selection Study"

**Goal.** Build the same small feature with the wrong type and the right type, and measure the difference in round trips, memory and correctness, so type selection becomes an instinct.

**Requirements.**
1. Pick a feature with a clear access pattern (a leaderboard, a rate limiter, a unique-visitor counter, or a field-updatable object).
2. Implement it first with strings (the lazy default) and then with the ideal type.
3. Measure and compare: round trips per operation, memory usage (`MEMORY USAGE`), and whether the string version has a race under concurrency that the typed version does not.
4. For a collection type, demonstrate the encoding transition: build it small (compact encoding), grow it past the threshold, and show the memory jump.
5. Write up the mapping — data shape → type → key commands → what it costs — as a reusable decision table.

**Extensions.**
- Show a big-key hazard: build one giant sorted set, run an O(N) command over it, and measure the latency inflicted on concurrent clients; then shard it and show the improvement.
- Compare exact (set) and probabilistic (HyperLogLog / bitmap) implementations of the same counting task across three orders of magnitude of scale, charting memory against error.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Redis as a Cache* (why atomic server-side operations exist), *Strings, Hashes & Object Caching* (the string-vs-hash decision in depth), *Sorted Sets: Rate Limiting, Leaderboards & Windows* (the most versatile type), *HyperLogLog, Bitmaps & Probabilistic Caching* (trading exactness for memory), *Pub/Sub & Streams for Cache Invalidation* (the durable log type), *Memory, maxmemory & Eviction* (how type choice affects the memory budget).

- **Redis — Data types & the data types tutorial** — Redis · *Beginner* · the authoritative reference for every type with its operations and complexity; the map this chapter is a guide to. <https://redis.io/docs/latest/develop/data-types/>
- **Redis — Memory optimization & encodings** — Redis · *Intermediate* · how small collections are stored compactly and how the thresholds work; the basis of the memory-efficiency argument. <https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/memory-optimization/>
- **Redis University — RU101: Introduction to Redis Data Structures** — Redis · *Beginner* · a free, hands-on course covering each type and when to use it. <https://university.redis.com/>
- **Redis — Sorted sets** — Redis · *Intermediate* · the most versatile caching type, with the range and rank operations that replace application logic. <https://redis.io/docs/latest/develop/data-types/sorted-sets/>
- **Redis — Bitmaps & HyperLogLog** — Redis · *Advanced* · the probabilistic types, their memory characteristics and error bounds. <https://redis.io/docs/latest/develop/data-types/probabilistic/>
- **Redis — Streams** — Redis · *Advanced* · the durable event-log type and consumer groups, for reliable invalidation delivery. <https://redis.io/docs/latest/develop/data-types/streams/>
- **Instagram Engineering — Storing hundreds of millions of key-value pairs with Redis** — Instagram · *Advanced* · the classic case study of using hashes and encodings to slash memory, exactly the technique in §3. <https://instagram-engineering.com/storing-hundreds-of-millions-of-simple-key-value-pairs-in-redis-1091ae80f74c>
- **Redis — Commands reference (with time complexity)** — Redis · *Intermediate* · every command's Big-O, so you can choose a type whose operations stay cheap. <https://redis.io/docs/latest/commands/>

---

*Caching with Redis Handbook — chapter 04.*
