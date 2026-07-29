# 12 · Design: Cache Invalidation Strategies

> **In one line:** Invalidation is the art of deciding *when a cached copy stops being allowed to be believed* — and it is genuinely hard because the moment of truth (the write) and the copies that must forget (the caches) live in different places, with a network and a race in between.

---

## 1. Overview

There is a famous joke, attributed to Phil Karlton: *there are only two hard things in computer science — cache invalidation and naming things.* The joke endures because the first half is true. Reading from a cache is easy. Writing to a cache is easy. Deciding the precise instant at which a cached value becomes a *lie* — and making every copy of it forget in time, across many machines, under concurrent writes — is where careers are quietly humbled.

This chapter is a design-round treatment of the invalidation spectrum. On one end is the laziest possible strategy: attach a **TTL** and let the value expire on its own, accepting that reads are stale until it does. On the other end is **event-driven invalidation**, where a change to the source of truth actively pushes a "forget this key" signal to every cache. In between sit **explicit delete-on-write**, **versioned/generation keys**, and **tag-based invalidation**. Each buys you a different point on the staleness-versus-complexity curve, and a real system usually mixes several.

The reason invalidation is hard is not that any single technique is complicated — most are a line or two of code. It is that invalidation is a *distributed consistency problem wearing a simple costume*. The write happens in the database; the forgetting must happen in the cache; there is no transaction spanning both; and between the two, another request can read the old value and re-populate the cache with it, resurrecting the very staleness you just tried to kill. Getting invalidation right means reasoning carefully about *ordering* and *races*, not about clever commands. This chapter gives you the strategies and, more importantly, the failure modes each one still leaves on the table — which is exactly what a design round wants you to name out loud.

## 2. Core Concepts

- **Invalidation** — declaring a cached entry no longer authoritative, so the next read misses and refetches from the source of truth.
- **TTL (time-to-live)** — an expiry attached to a key; the value self-destructs after a set duration with no action from anyone. The simplest invalidation there is.
- **Explicit delete-on-write** — on a write to the source of truth, actively `DEL`/`UNLINK` the cached key so the next read repopulates it.
- **Update-in-place vs delete** — the choice between overwriting the cache with the new value versus deleting it and letting the next read lazily refill it.
- **Versioned / generation keys** — embedding a version number in the key (`user:9:v7`); bumping the version orphans all old keys at once, sidestepping the delete race.
- **Tag-based invalidation** — associating keys with logical tags (`product:42`, `user:9`) so you can invalidate an entire *group* in one operation.
- **Event-driven invalidation** — a change to the source of truth emits an event (keyspace notification, Pub/Sub message, CDC record) that fans out to invalidate caches.
- **Purge / cache busting** — the CDN/edge vocabulary for the same idea: actively evicting a cached artifact, often by URL or by a surrogate key (a tag).
- **The invalidation race** — the window where a reader repopulates a stale value between a database write and the cache delete, or reads-then-writes across the two.
- **Staleness window** — the maximum time a cache may serve an out-of-date value; bounded by the TTL under TTL-only, by propagation delay under event-driven.

## 3. Theory & Principles

### The spectrum, from laziest to most active

Every invalidation strategy is a point on a single axis: *how aggressively do we force caches to forget?* Laziness is cheap but stale; aggression is fresh but complex and race-prone.

- **TTL-only.** Set a TTL, walk away. The value is authoritative until it expires, then a read misses and refetches. This is *eventually consistent by construction*: staleness is bounded by the TTL, and you never write invalidation logic at all. It is the correct default for a huge amount of data — anything where "stale for up to N seconds" is acceptable, which is most caching.

- **Explicit delete-on-write.** When you write the source of truth, you also delete the cached key. The next read misses and repopulates with fresh data. This narrows the staleness window from "TTL" to "the propagation time of the delete", but it introduces the invalidation race (below) and requires the write path to *know* which keys to delete.

- **Versioned / generation keys.** Instead of deleting `user:9`, you read and write `user:9:v{N}` where `N` is a version you bump on every write. After a bump, all readers compute the new key, miss, and refill; the old-version keys are simply *orphaned* and expire on their own TTL. This elegantly sidesteps the delete race — you never race to delete anything, you just stop referencing the old key — at the cost of storing a version pointer and briefly holding orphaned copies.

- **Tag-based invalidation.** You attach *tags* to keys (a cached search result is tagged with every `product:N` it contains). Invalidating `product:42` invalidates *every* cached entry carrying that tag in one operation. This solves the "one write must invalidate many derived caches" problem that delete-on-write handles badly.

- **Event-driven.** A change to the source of truth emits an event, and a fan-out mechanism turns that event into invalidations across every cache node and every derived entry. This is the most active and the most consistent — the cache follows the *committed log of truth* — and the most operationally involved.

### Why "just delete the key on write" isn't as safe as it looks

Delete-on-write has a race that catches nearly everyone. Consider two concurrent operations on a cache-aside system:

1. Reader R gets a **miss** on `user:9`, so it queries the database and reads the *old* value V1.
2. Writer W updates the database to V2 and deletes `user:9` from the cache.
3. Reader R — still holding V1 in hand from step 1 — now writes V1 into the cache.

The database says V2; the cache says V1; and the cache will keep serving V1 until its TTL expires or another write comes. The delete *happened*, and yet the cache is stale. This is not a hypothetical — it is the single most common cache-consistency bug in production, and it is why serious systems either use versioned keys (which have nothing to race on), a short TTL as a backstop (so the staleness is bounded even when the race fires), or a proper event-driven pipeline built on the database's commit log (chapter 14). The lesson a design round wants: *deleting the key is necessary but not sufficient; you must also reason about the reader who is mid-flight.*

### Delete vs update: the debate

When a write happens, should you *delete* the cached key (and let the next read lazily refill) or *update* it in place with the new value?

- **Delete (invalidate) is usually right.** It is simple, and it avoids caching a value nobody has asked for. Crucially, under two concurrent writes, deleting is *idempotent and order-insensitive* — both writers delete, and whoever reads next gets fresh data. Updating in place, by contrast, has its own race: two writers can apply their updates to the cache in a *different order* than they applied them to the database, leaving the cache permanently disagreeing with the database.
- **Update-in-place is tempting** because it keeps the cache warm (no subsequent miss) and can be right for a hot key that would otherwise thundering-herd on the refill. But it is more dangerous, so the mainstream advice — and the default you should reach for — is **delete on write, refill on read**, reserving in-place update for specific hot-key optimisations where you have thought the ordering through.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="iv1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
    <marker id="iv2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The delete-on-write race &#8212; and why versioned keys dodge it</text>

  <rect x="24" y="40" width="410" height="240" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="229" y="62" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Delete-on-write: the resurrection race</text>
  <text x="40" y="88" fill="#7f1d1d" font-size="10" font-weight="bold">t1  Reader R: MISS on user:9</text>
  <text x="52" y="104" fill="#991b1b" font-size="9">reads DB &#8594; gets OLD value V1 (in hand)</text>
  <text x="40" y="128" fill="#7f1d1d" font-size="10" font-weight="bold">t2  Writer W: UPDATE db to V2</text>
  <text x="52" y="144" fill="#991b1b" font-size="9">then DEL user:9 from cache</text>
  <text x="40" y="168" fill="#7f1d1d" font-size="10" font-weight="bold">t3  Reader R: SET user:9 = V1</text>
  <text x="52" y="184" fill="#991b1b" font-size="9">R was mid-flight; it writes the STALE V1</text>
  <rect x="40" y="200" width="378" height="66" rx="6" fill="#fff" stroke="#fca5a5"/>
  <text x="229" y="222" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">Result: DB = V2, cache = V1</text>
  <text x="229" y="240" text-anchor="middle" fill="#991b1b" font-size="9">the DEL happened &#8212; and the cache is STILL stale</text>
  <text x="229" y="256" text-anchor="middle" fill="#991b1b" font-size="9">until TTL expiry or the next write</text>

  <rect x="446" y="40" width="410" height="240" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="651" y="62" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Versioned keys: nothing to race on</text>
  <text x="462" y="88" fill="#14532d" font-size="10" font-weight="bold">pointer:  user:9:ver = 7</text>
  <text x="462" y="112" fill="#166534" font-size="9">reads/writes use key  user:9:v7</text>
  <text x="462" y="136" fill="#14532d" font-size="10" font-weight="bold">on write: INCR user:9:ver &#8594; 8</text>
  <text x="462" y="160" fill="#166534" font-size="9">all readers now compute user:9:v8 &#8594; MISS &#8594; refill</text>
  <text x="462" y="184" fill="#166534" font-size="9">the old user:9:v7 is ORPHANED, expires on its TTL</text>
  <rect x="462" y="200" width="378" height="66" rx="6" fill="#fff" stroke="#86efac"/>
  <text x="651" y="222" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">A mid-flight reader writes user:9:v7</text>
  <text x="651" y="240" text-anchor="middle" fill="#166534" font-size="9">&#8212; but nobody reads v7 anymore, so it is harmless</text>
  <text x="651" y="256" text-anchor="middle" fill="#166534" font-size="9">the version bump made the stale write irrelevant</text>

  <rect x="24" y="296" width="832" height="156" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="318" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">The spectrum of aggression</text>
  <g font-size="9">
    <rect x="44" y="334" width="150" height="100" rx="6" fill="#dbeafe" stroke="#2563eb"/>
    <text x="119" y="352" text-anchor="middle" fill="#1e40af" font-weight="bold">TTL-only</text>
    <text x="119" y="370" text-anchor="middle" fill="#1d4ed8">laziest</text>
    <text x="119" y="386" text-anchor="middle" fill="#1d4ed8">stale &#8804; TTL</text>
    <text x="119" y="402" text-anchor="middle" fill="#1d4ed8">zero write logic</text>
    <text x="119" y="422" text-anchor="middle" fill="#64748b">eventual</text>

    <rect x="206" y="334" width="150" height="100" rx="6" fill="#dcfce7" stroke="#16a34a"/>
    <text x="281" y="352" text-anchor="middle" fill="#15803d" font-weight="bold">delete-on-write</text>
    <text x="281" y="370" text-anchor="middle" fill="#166534">narrows window</text>
    <text x="281" y="386" text-anchor="middle" fill="#166534">has the race</text>
    <text x="281" y="402" text-anchor="middle" fill="#166534">needs key map</text>
    <text x="281" y="422" text-anchor="middle" fill="#64748b">+ short TTL backstop</text>

    <rect x="368" y="334" width="150" height="100" rx="6" fill="#fef3c7" stroke="#d97706"/>
    <text x="443" y="352" text-anchor="middle" fill="#92400e" font-weight="bold">versioned keys</text>
    <text x="443" y="370" text-anchor="middle" fill="#b45309">no delete race</text>
    <text x="443" y="386" text-anchor="middle" fill="#b45309">bump = orphan</text>
    <text x="443" y="402" text-anchor="middle" fill="#b45309">holds old copies</text>
    <text x="443" y="422" text-anchor="middle" fill="#64748b">briefly</text>

    <rect x="530" y="334" width="150" height="100" rx="6" fill="#ede9fe" stroke="#7c3aed"/>
    <text x="605" y="352" text-anchor="middle" fill="#5b21b6" font-weight="bold">tag-based</text>
    <text x="605" y="370" text-anchor="middle" fill="#6d28d9">invalidate a group</text>
    <text x="605" y="386" text-anchor="middle" fill="#6d28d9">one op, many keys</text>
    <text x="605" y="402" text-anchor="middle" fill="#6d28d9">tag bookkeeping</text>
    <text x="605" y="422" text-anchor="middle" fill="#64748b">derived caches</text>

    <rect x="692" y="334" width="146" height="100" rx="6" fill="#fee2e2" stroke="#dc2626"/>
    <text x="765" y="352" text-anchor="middle" fill="#b91c1c" font-weight="bold">event-driven</text>
    <text x="765" y="370" text-anchor="middle" fill="#991b1b">most consistent</text>
    <text x="765" y="386" text-anchor="middle" fill="#991b1b">follows the log</text>
    <text x="765" y="402" text-anchor="middle" fill="#991b1b">most machinery</text>
    <text x="765" y="422" text-anchor="middle" fill="#64748b">CDC / Pub-Sub</text>
  </g>
</svg>
```

### Why invalidation is *genuinely* one of the hard problems

Strip away the commands and the difficulty is this: a cache is a *derived copy* of authoritative state, and there is no atomic operation that updates the authority and every copy together. The write commits in one system; the copies live in another (often many others); and the gap between them is where correctness leaks. TTL sidesteps the problem by *never trying to be exactly right* — it accepts bounded staleness. Every strategy more aggressive than TTL is really an attempt to shrink that gap, and each new attempt trades simplicity for a new, subtler race. That is why the joke lands: invalidation is not one hard command, it is a distributed-systems problem that hides behind a `DEL`.

## 4. Architecture & Workflow

### Event-driven invalidation: the mechanisms

When you outgrow TTL and delete-on-write, invalidation becomes a *fan-out* problem: one change must reach many caches. Redis and the surrounding stack give you several transports:

1. **Keyspace notifications.** Redis can emit Pub/Sub events when keys change (`CONFIG SET notify-keyspace-events KEA`), publishing to channels like `__keyevent@0__:expired` or `__keyevent@0__:del`. A subscriber can react — for example, to cascade an invalidation to a second-tier cache when a Redis key expires. Useful, but note these are *Redis's* key events, not your *database's* changes.
2. **Pub/Sub.** Your application, on a write, publishes an invalidation message (`PUBLISH cache.invalidate user:9`) that every application instance's local (in-process) cache subscribes to and acts on. This is the classic way to invalidate a *near cache* (an L1 in each app process) sitting in front of Redis.
3. **Client-side caching / tracking (RESP3).** Redis can *track* which keys a client has read and push an invalidation message when any of them changes, so a client-side cache stays coherent automatically (chapter on client-side caching). This is invalidation as a first-class server feature.
4. **Change Data Capture (CDC).** The most robust: a tool like Debezium tails the database's write-ahead log / binlog and emits a change event for every committed row change, which a consumer turns into cache invalidations. Because it reads the *committed log of truth*, it cannot miss a write and cannot fire for an uncommitted one — the subject of chapter 14.

The design decision is *what is the source of the invalidation event*. Application-published Pub/Sub is simple but couples correctness to the application remembering to publish on every write path (and to the write and the publish not being a dual-write problem of their own). CDC moves the source to the database's own log, which is the only place that *cannot* be bypassed, at the cost of running the CDC pipeline.

```svg
<svg viewBox="0 0 880 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="ev1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Event-driven invalidation: one write, fan-out to many caches</text>

  <rect x="30" y="46" width="150" height="60" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="105" y="70" text-anchor="middle" fill="#1e40af" font-size="11" font-weight="bold">Writer</text>
  <text x="105" y="90" text-anchor="middle" fill="#1d4ed8" font-size="9">UPDATE product 42</text>

  <path d="M180,76 L228,76" stroke="#7c3aed" stroke-width="1.8" marker-end="url(#ev1)"/>
  <rect x="230" y="46" width="150" height="60" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="305" y="70" text-anchor="middle" fill="#92400e" font-size="11" font-weight="bold">Source of truth</text>
  <text x="305" y="90" text-anchor="middle" fill="#b45309" font-size="9">committed WAL / binlog</text>

  <path d="M380,76 L428,76" stroke="#7c3aed" stroke-width="1.8" marker-end="url(#ev1)"/>
  <rect x="430" y="46" width="180" height="60" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="520" y="70" text-anchor="middle" fill="#5b21b6" font-size="11" font-weight="bold">Event source</text>
  <text x="520" y="90" text-anchor="middle" fill="#6d28d9" font-size="9">CDC / Pub/Sub / keyspace notif</text>

  <path d="M520,106 L520,150" stroke="#7c3aed" stroke-width="1.8" marker-end="url(#ev1)"/>
  <rect x="360" y="152" width="320" height="46" rx="8" fill="#f1f5f9" stroke="#64748b" stroke-width="2"/>
  <text x="520" y="174" text-anchor="middle" fill="#334155" font-size="10" font-weight="bold">Invalidation event: "product:42 changed"</text>
  <text x="520" y="190" text-anchor="middle" fill="#475569" font-size="9">carries the key and, ideally, its tags</text>

  <path d="M420,198 L200,242" stroke="#7c3aed" stroke-width="1.5" fill="none" marker-end="url(#ev1)"/>
  <path d="M520,198 L520,242" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#ev1)"/>
  <path d="M620,198 L820,242" stroke="#7c3aed" stroke-width="1.5" fill="none" marker-end="url(#ev1)"/>

  <rect x="70" y="244" width="230" height="70" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="185" y="266" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">Redis (shared L2)</text>
  <text x="185" y="284" text-anchor="middle" fill="#166534" font-size="9">DEL product:42</text>
  <text x="185" y="300" text-anchor="middle" fill="#166534" font-size="9">DEL every key tagged product:42</text>

  <rect x="405" y="244" width="230" height="70" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="520" y="266" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">App instance A &#8212; L1 near cache</text>
  <text x="520" y="284" text-anchor="middle" fill="#166534" font-size="9">drop product:42 from in-process map</text>
  <text x="520" y="300" text-anchor="middle" fill="#166534" font-size="9">next read misses &#8594; refill</text>

  <rect x="700" y="244" width="150" height="70" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="775" y="266" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">App instance B</text>
  <text x="775" y="284" text-anchor="middle" fill="#166534" font-size="9">L1 near cache</text>
  <text x="775" y="300" text-anchor="middle" fill="#166534" font-size="9">drop product:42</text>

  <rect x="70" y="336" width="780" height="76" rx="8" fill="#fefce8" stroke="#ca8a04" stroke-width="2"/>
  <text x="460" y="358" text-anchor="middle" fill="#854d0e" font-size="11" font-weight="bold">The design question: where does the event come from?</text>
  <text x="88" y="378" fill="#713f12" font-size="9">App-published Pub/Sub &#8212; simple, but the app must publish on EVERY write path, and write+publish is itself a dual-write.</text>
  <text x="88" y="394" fill="#713f12" font-size="9">CDC from the DB log &#8212; cannot be bypassed, cannot miss a committed write, fires only for committed changes. More machinery. (ch. 14)</text>
</svg>
```

### Tag-based invalidation, concretely

The problem tags solve: a single write can invalidate *many derived caches*. A cached search-results page for "red shoes" depends on products 42, 51 and 77. When product 42's price changes, that page is stale — but the write path has no idea the "red shoes" page exists. Tagging inverts the dependency: when the page is cached, it is tagged with `product:42`, `product:51`, `product:77`. When product 42 changes, you invalidate the tag `product:42`, and *every* cached entry carrying it is dropped.

In Redis this is typically implemented with a **set per tag**: `tag:product:42` is a Redis set containing the cache keys that depend on product 42. Invalidating the tag means reading the set, deleting all its members, and deleting the set. CDN vendors expose exactly this under the name **surrogate keys** or **cache tags** — you attach a `Surrogate-Key` header when caching and issue a purge-by-key to bust every artifact carrying it.

## 5. Implementation

Real, runnable Go using `github.com/redis/go-redis/v9`, showing four strategies: delete-on-write with a TTL backstop, versioned keys, tag-based invalidation, and a keyspace-notification listener.

```go
package invalidation

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// ---------------------------------------------------------------------------
// 1. DELETE-ON-WRITE with a short TTL backstop.
//
// The delete narrows the staleness window to the delete's propagation time;
// the TTL is the safety net that bounds staleness EVEN IF the resurrection
// race fires (a mid-flight reader repopulating the old value). Never rely on
// the delete alone — always keep a TTL so a lost/raced delete self-heals.
// ---------------------------------------------------------------------------

const cacheTTL = 5 * time.Minute // backstop: worst-case staleness if a delete is raced/lost

// WriteThroughDB updates the source of truth, then invalidates the cache. We
// DELETE rather than UPDATE: delete is idempotent and order-insensitive under
// concurrent writers, so two racing writes cannot leave the cache pinned to an
// out-of-order value.
func WriteThroughDB(ctx context.Context, rdb *redis.Client, id string, persist func() error) error {
	// 1) Commit to the source of truth FIRST. If this fails, we must not touch
	//    the cache — the old cached value is still the correct current value.
	if err := persist(); err != nil {
		return fmt.Errorf("db write: %w", err)
	}
	// 2) Invalidate. UNLINK (not DEL) so freeing a large value happens in a
	//    background thread and never blocks the single command thread.
	if err := rdb.Unlink(ctx, key(id)).Err(); err != nil {
		// A failed invalidation is a correctness risk, not a user-facing error:
		// the TTL backstop bounds the damage, but we surface it for alerting.
		return fmt.Errorf("cache invalidate (TTL backstop active): %w", err)
	}
	return nil
}

func key(id string) string { return "user:" + id }

// ---------------------------------------------------------------------------
// 2. VERSIONED / GENERATION KEYS.
//
// We never delete the data key. We bump a version pointer; readers compute the
// current key from the pointer, so a bump orphans every old-version copy at
// once. There is NOTHING to race on: a mid-flight reader can only write an
// old-version key that nobody will ever read again.
// ---------------------------------------------------------------------------

func versionPtr(id string) string { return "user:" + id + ":ver" }

// versionedKey builds the concrete data key for the current generation. If the
// pointer is missing we treat the generation as 1.
func versionedKey(ctx context.Context, rdb *redis.Client, id string) (string, error) {
	v, err := rdb.Get(ctx, versionPtr(id)).Int64()
	if errors.Is(err, redis.Nil) {
		v = 1
	} else if err != nil {
		return "", err
	}
	return fmt.Sprintf("user:%s:v%d", id, v), nil
}

// ReadVersioned is the read path: resolve the version, then GET that key.
func ReadVersioned(ctx context.Context, rdb *redis.Client, id string) (string, bool, error) {
	k, err := versionedKey(ctx, rdb, id)
	if err != nil {
		return "", false, err
	}
	val, err := rdb.Get(ctx, k).Result()
	if errors.Is(err, redis.Nil) {
		return "", false, nil // miss — caller fetches from DB and fills k
	}
	return val, err == nil, err
}

// BumpVersion is the invalidation: one INCR orphans the whole generation. The
// pointer itself gets a long TTL so it does not accumulate forever; the old
// data keys expire on their own TTL, so we hold at most one stale generation.
func BumpVersion(ctx context.Context, rdb *redis.Client, id string) error {
	if err := rdb.Incr(ctx, versionPtr(id)).Err(); err != nil {
		return err
	}
	return rdb.Expire(ctx, versionPtr(id), 24*time.Hour).Err()
}

// ---------------------------------------------------------------------------
// 3. TAG-BASED INVALIDATION.
//
// Each derived cache key registers itself under every tag it depends on, using
// a Redis SET per tag. Invalidating a tag deletes every member key and the tag
// set itself — one logical operation invalidates a whole group.
// ---------------------------------------------------------------------------

func tagKey(tag string) string { return "tag:" + tag }

// CacheWithTags stores a derived value AND records the key under each tag, in a
// pipeline so the writes travel in one round trip. The tag sets get a TTL a bit
// longer than the value so a stale tag membership self-cleans.
func CacheWithTags(ctx context.Context, rdb *redis.Client, cacheKey, value string, ttl time.Duration, tags ...string) error {
	pipe := rdb.TxPipeline()
	pipe.Set(ctx, cacheKey, value, ttl)
	for _, t := range tags {
		pipe.SAdd(ctx, tagKey(t), cacheKey)
		pipe.Expire(ctx, tagKey(t), ttl+time.Minute)
	}
	_, err := pipe.Exec(ctx)
	return err
}

// InvalidateTag drops every cached entry carrying a tag. We SCAN the members in
// batches so a tag with many members never blocks the server, then UNLINK them
// and the tag set. This is the "invalidate a group in one call" primitive.
func InvalidateTag(ctx context.Context, rdb *redis.Client, tag string) error {
	tk := tagKey(tag)
	var cursor uint64
	for {
		members, next, err := rdb.SScan(ctx, tk, cursor, "", 200).Result()
		if err != nil {
			return err
		}
		if len(members) > 0 {
			// UNLINK a batch — background free, never blocks the event loop.
			if err := rdb.Unlink(ctx, members...).Err(); err != nil {
				return err
			}
		}
		cursor = next
		if cursor == 0 {
			break
		}
	}
	return rdb.Unlink(ctx, tk).Err()
}

// ---------------------------------------------------------------------------
// 4. KEYSPACE-NOTIFICATION LISTENER.
//
// Redis can publish events when keys change/expire. Here we listen for key
// expiries so a second-tier or in-process cache can cascade the invalidation.
// Requires: CONFIG SET notify-keyspace-events KEA  (K=keyspace, E=keyevent,
// A=all classes). Note these are REDIS key events, not your DATABASE changes.
// ---------------------------------------------------------------------------

func ListenForExpiries(ctx context.Context, rdb *redis.Client, onExpire func(key string)) error {
	// Subscribe to the expired-key event channel for database 0.
	pubsub := rdb.PSubscribe(ctx, "__keyevent@0__:expired")
	defer pubsub.Close()

	ch := pubsub.Channel()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case msg, ok := <-ch:
			if !ok {
				return nil
			}
			// msg.Payload is the key that just expired — cascade the forget.
			onExpire(msg.Payload)
		}
	}
}
```

The through-line: the delete-on-write path *always* keeps a TTL backstop; the versioned path has nothing to race on; the tag path scans in batches and uses `UNLINK` so a big group never blocks; and the notification listener shows how Redis's own events can drive cascading invalidation.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **A tunable freshness dial.** From TTL-only (accept staleness, zero logic) to event-driven (near-immediate), you can dial each data type to exactly the freshness it needs.
- **Cheap where cheap is fine.** TTL costs one argument on `SET` and needs no write-path coupling, which handles most data correctly.
- **Precise where precise matters.** Tag-based and event-driven invalidation let one write reach exactly the derived caches it affects, no more and no fewer.
- **Race-free options exist.** Versioned keys remove the delete race entirely, which is a genuine correctness upgrade for hot, frequently-written data.

**Disadvantages**
- **Delete-on-write has a race.** The mid-flight-reader resurrection is real and easy to miss; without a TTL backstop it can pin a stale value indefinitely.
- **Every step up the spectrum adds machinery.** Tags need bookkeeping sets; event-driven needs a transport; CDC needs a pipeline to run and monitor.
- **Coupling.** Delete-on-write and tag-based invalidation couple the write path to knowledge of which keys/tags to invalidate — a coupling that rots as caches multiply.
- **Orphans and dangling tags.** Versioned keys briefly hold old generations; tag sets can accumulate dead members. Both need TTLs to self-clean.

**Trade-offs**
- *TTL vs active invalidation:* TTL is eventual and free but stale up to the TTL; active invalidation is fresher but couples the write path and adds races. Choose by the staleness budget of the data (chapter 13).
- *Delete vs update:* delete is simple and order-insensitive under concurrency; update keeps the cache warm but can commit writes to the cache out of order. Default to delete; reserve update for thought-through hot keys.
- *Versioned vs delete:* versioned keys dodge the delete race but store a pointer and hold orphans; delete is simpler but needs the TTL backstop. Use versioned for hot, write-heavy keys where the race actually bites.
- *App-published events vs CDC:* app Pub/Sub is simple but is itself a dual-write and can be bypassed; CDC follows the committed log and cannot be bypassed but is more to operate (chapter 14).

## 7. Common Mistakes & Best Practices

- **Relying on delete-on-write with no TTL.** The resurrection race can pin a stale value forever. *Best practice: always keep a TTL as a backstop, even when you actively invalidate — belt and braces.*
- **Updating the cache in place under concurrent writes.** Two writers can apply updates to the cache in a different order than to the database, leaving a permanent disagreement. *Best practice: delete on write and refill on read unless you have specifically reasoned through the ordering for a hot key.*
- **Invalidating the cache before committing the database.** If you delete the key first and the DB write then fails, the next read repopulates the (unchanged) old value — but you have also thrown away a warm cache for nothing, and a reader between the two sees a miss. *Best practice: commit the source of truth first, then invalidate.*
- **Forgetting derived caches.** A write invalidates the primary key but not the search page, the aggregate, or the list that included it. *Best practice: use tags so derived caches declare their dependencies and get invalidated as a group.*
- **Unbounded tag sets.** Tag sets grow forever if members are never cleaned. *Best practice: TTL the tag sets and use `UNLINK` when busting them so a big group never blocks the thread.*
- **Assuming Pub/Sub invalidation is reliable.** Redis Pub/Sub is fire-and-forget; a subscriber that is down misses the message and stays stale. *Best practice: back Pub/Sub with a TTL, or use a durable transport (streams / CDC) when you cannot tolerate a missed invalidation.*
- **Trusting keyspace notifications for database truth.** They fire on *Redis* key events, not *database* commits, and are also best-effort. *Best practice: use them for cascading within Redis, not as your primary DB-change signal — for that, use CDC.*

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** When users report stale data, first check whether the key still exists and its remaining TTL (`TTL key`, `PTTL key`) — a value that should have been invalidated but is present with a full TTL points at a missed or raced delete. `OBJECT IDLETIME key` and access patterns help confirm. For tag-based systems, inspect the tag set (`SSCAN tag:product:42`) to see whether the derived key was ever registered. For event-driven systems, the question is *did the event fire and was it consumed* — check consumer lag and dead-letter counts.
- **Monitoring.** Track the cache **hit ratio** (a sudden drop after a deploy can mean an over-aggressive invalidation dropping the whole cache), invalidation **event rate** and **consumer lag** (the practical staleness window under event-driven invalidation *is* the lag), and the count of **failed invalidations** (each is a potential stale entry relying on the TTL backstop). Alert on tag sets growing without bound.
- **Security.** Invalidation is a fan-out primitive, which makes it an amplification target: an attacker who can trigger writes can trigger mass invalidation and a thundering-herd refill (an invalidation-driven cache stampede — chapter on stampede). Rate-limit and authenticate the write paths that drive invalidation, and guard `PUBLISH`/keyspace-notification access with ACLs. A leaked `FLUSHALL` or an unauthenticated invalidation channel is a denial-of-service vector.
- **Scaling.** Under Redis Cluster, a tag's member keys may live on different slots than the tag set, so `SSCAN`-then-`UNLINK` crosses slots and must be issued per-key (the client handles routing) rather than as one multi-key command. Consider hash tags (`{product:42}`) to co-locate a tag set with its members if you need atomic group operations. Event-driven invalidation scales by partitioning the event stream (per entity, per shard) so consumers keep up; the moment consumer lag exceeds your staleness budget, the invalidation is effectively a slow TTL.

## 9. Interview Questions

**Q: Why is cache invalidation considered one of the hard problems in computer science?**
A: Because a cache is a *derived copy* of authoritative state, and there is no atomic operation that updates the authority and every copy together. The write commits in the database; the copies live in the cache (often many caches on many machines); and the gap between them — a network hop and a scheduling delay — is where correctness leaks. On top of that, concurrent readers and writers race across that gap: a reader mid-refill can repopulate a value a writer just invalidated. So it is not that any one command is complicated — `DEL` is trivial — it is that invalidation is a distributed-systems consistency problem hiding behind a simple-looking operation, and every attempt to make it more precise introduces a new, subtler race.

**Q: What is the difference between TTL-based and explicit invalidation?**
A: TTL-based invalidation attaches an expiry to the key and lets it self-destruct; you write no invalidation logic, and staleness is bounded by the TTL. It is eventually consistent by construction and is the right default for anything that tolerates "stale for up to N seconds". Explicit invalidation actively deletes (or updates) the key when the source of truth changes, narrowing the staleness window from the TTL down to the propagation time of the delete — but it couples the write path to knowledge of which keys to invalidate and introduces the delete-on-write race. In practice you often combine them: explicit delete for freshness plus a TTL as a backstop so a missed or raced delete self-heals.

**Q: Explain the delete-on-write race and how you'd avoid it.**
A: Under cache-aside, a reader can miss and fetch the old value V1 from the database; then a writer updates the database to V2 and deletes the cached key; then the reader — still holding V1 — writes V1 back into the cache. The delete happened, yet the cache now serves the stale V1 until its TTL or the next write. To avoid it: use versioned keys (there is nothing to race on — a bump orphans the old key, and a mid-flight reader can only write a key nobody reads anymore); or keep a short TTL as a backstop so the staleness is bounded even when the race fires; or drive invalidation from the database's committed log via CDC so the invalidation always follows the write. The one thing that does *not* fix it is deleting harder.

**Q: Should you delete the cache key on write or update it in place?**
A: Default to delete. Delete is idempotent and order-insensitive: under two concurrent writers, both delete and whoever reads next refills from fresh data. Update-in-place has a nastier race — two writers can apply their updates to the cache in a different order than they applied them to the database, leaving the cache permanently disagreeing with the database — and it also caches a value that may never be read. Update-in-place is worth it only for a hot key where the post-invalidation refill would cause a thundering herd and you have specifically reasoned through the ordering; otherwise, delete on write and refill lazily on read.

**Q: What are versioned/generation keys and what problem do they solve?**
A: Instead of storing and deleting `user:9`, you keep a version pointer (`user:9:ver = 7`) and read/write the concrete key `user:9:v7`. On a write you bump the version (`INCR` to 8); every reader now computes `user:9:v8`, misses, and refills, while the old `user:9:v7` is simply orphaned and expires on its TTL. This solves the delete-on-write race: you never race to delete anything, so a mid-flight reader can only write an old-version key that nobody will ever read again — the write is harmless. The costs are storing the pointer and briefly holding one stale generation of orphaned copies, which the TTL cleans up.

**Q: How does tag-based invalidation work and when do you need it?**
A: You associate each cache key with logical tags describing its dependencies — a cached search page for "red shoes" is tagged with `product:42`, `product:51`, `product:77`. When product 42 changes, you invalidate the tag `product:42`, and every cached entry carrying it is dropped. In Redis this is a set per tag holding the dependent keys; invalidating means scanning the set and unlinking its members. You need it when a single write must invalidate *many derived caches* that the write path has no direct knowledge of — aggregates, rendered pages, list results. CDNs expose the same idea as surrogate keys / cache tags with purge-by-key.

**Q: What are keyspace notifications and what are their limits?**
A: Keyspace notifications are Redis Pub/Sub events emitted when keys change or expire — enabled with `notify-keyspace-events` — publishing to channels like `__keyevent@0__:expired`. A subscriber can react, for example to cascade an invalidation to a second-tier cache when a Redis key expires. Their limits: they signal *Redis* key events, not your *database* commits, so they are not a substitute for CDC when the database is the source of truth; and, being Pub/Sub, they are best-effort fire-and-forget, so a subscriber that is down misses events. Use them for cascading within Redis, backed by a TTL, not as a reliable database-change feed.

**Q: (Senior) Design an invalidation strategy for a system where a single product update must invalidate the product page, several search-result pages, a category aggregate, and per-user recommendation caches.**
A: This is a fan-out problem, so I would build around tags and an event source. Every derived cache declares its dependencies as tags when it is written: the product page carries `product:42`; each search page carries `product:42` for every product it contains; the category aggregate carries `category:shoes` and each contributing `product:N`; the recommendation caches carry `product:42` where relevant. The write path emits a single logical event — "product 42 changed" — rather than trying to enumerate keys itself, because it cannot know every derived page that exists. I would source that event from CDC on the products table so it follows the committed write and cannot be bypassed by an alternate write path (chapter 14). A consumer turns the event into `InvalidateTag("product:42")` and `InvalidateTag("category:shoes")`, unlinking every member in batches. Each cache still carries a TTL as a backstop for anything the tagging missed. For the very hottest pages I would use versioned keys or a stale-while-revalidate refill so the invalidation does not cause a synchronized stampede. The key design decisions I would call out: dependencies flow *from the cache entry* (via tags) not from the write path; the event comes from the committed log; and TTL remains the safety net beneath all of it.

**Q: (Senior) You've added event-driven invalidation but users still occasionally see stale data. How do you find the cause?**
A: I would decompose the pipeline and ask, for a specific stale read, *where did the invalidation break*. First, did the event fire at all? I check the source — if it is CDC, is the connector healthy and is it emitting a change for that row (verify against the WAL/binlog position and the connector's offset)? If it is app-published Pub/Sub, is the write path that changed the data actually the one that publishes, or is there a second write path (a batch job, an admin tool) that mutates the database without publishing — a classic gap. Second, was the event consumed? I look at consumer lag: if lag exceeds the staleness users report, the invalidation is simply late, and the fix is scaling or partitioning consumers. Third, was the event lost? Pub/Sub drops messages to down subscribers, so if the transport is Pub/Sub rather than a durable stream, a consumer restart is a silent hole — I would move to a durable stream or CDC with committed offsets. Fourth, is there a resurrection race — a reader repopulating between the DB write and the invalidation — in which case the TTL backstop bounds it but a versioned-key approach removes it. Fifth, did the invalidation reach *every* copy, including per-instance L1 near caches, or only the shared Redis L2? I would instrument each stage (event emitted, event consumed, key deleted) with a correlation id so a single stale report can be traced end to end; the usual culprit is either an unpublished second write path or consumer lag.

**Q: (Senior) When is TTL-only invalidation the *right* engineering choice rather than a lazy one?**
A: When the data's staleness budget comfortably exceeds the TTL and the cost of active invalidation is not justified — which is far more often than engineers like to admit. If a value tolerates being a minute stale (a product description, a config blob, a rendered marketing page), a 60-second TTL delivers that with zero write-path coupling, zero invalidation machinery, no races, and no operational surface to monitor. Active invalidation would add code on every write path, a fan-out transport, and new failure modes — all to shave a staleness window the business does not care about. TTL-only is also *more robust*: there is no invalidation to miss, so the system is self-healing by design. I reach past TTL-only only when the staleness budget is genuinely tight (a price, an inventory count, a permission change) or when the refill is so expensive that I want to control exactly when it happens. The senior instinct is to match the strategy to the staleness budget, and to treat "just set a TTL" as the correct answer until the data proves it needs more.

## 10. Quick Revision & Cheat Sheet

| Strategy | Staleness window | Race? | Cost |
|---|---|---|---|
| TTL-only | up to the TTL | none | trivial; eventual |
| Delete-on-write (+ TTL) | delete propagation (TTL backstop) | resurrection race | write-path coupling |
| Versioned keys | until readers see new version | none to race on | pointer + orphans |
| Tag-based | until tag invalidation runs | as underlying delete | tag bookkeeping |
| Event-driven / CDC | consumer/propagation lag | none if from committed log | pipeline to run |

| Decision | Rule of thumb |
|---|---|
| Delete or update on write? | Delete (order-insensitive); update only for reasoned hot keys |
| Invalidate or commit first? | Commit the DB first, then invalidate |
| One write, many derived caches? | Tag them; invalidate the tag |
| Hot, write-heavy key with a delete race? | Versioned keys |
| Cannot miss an invalidation? | Durable transport / CDC, not fire-and-forget Pub/Sub |

**Flash cards**
- **Two hard things?** → Cache invalidation and naming things. The joke is true.
- **Delete-on-write race?** → Mid-flight reader repopulates the old value after the delete; bound it with a TTL, remove it with versioned keys.
- **Delete vs update on write?** → Delete — idempotent and order-insensitive under concurrency.
- **Versioned keys win?** → Bump a version; old keys are orphaned; nothing to race on.
- **Tags for?** → One write invalidating many derived caches as a group.
- **TTL backstop?** → Keep a TTL even when you actively invalidate, so a raced/lost delete self-heals.

## 11. Hands-On Exercises & Mini Project

- [ ] Build cache-aside with delete-on-write, then reproduce the resurrection race with two goroutines (one slow reader, one writer) and observe the cache pinned to the stale value.
- [ ] Add a short TTL backstop and show the same race now self-heals when the TTL expires.
- [ ] Reimplement the same key with versioned/generation keys and show the race no longer produces staleness.
- [ ] Implement tag-based invalidation with a set per tag; cache three derived pages tagged with a shared product and invalidate all three with one tag bust.
- [ ] Enable keyspace notifications and write a listener that logs every expiry, then cascade it to an in-process cache.
- [ ] Measure the hit-ratio impact of an over-broad tag invalidation (one that drops far more than it should).

### Mini Project — "Invalidation Bench"

**Goal.** Build one small cached entity four ways — TTL-only, delete-on-write+TTL, versioned keys, tag-based — and measure staleness, races and complexity so the trade-offs become concrete rather than theoretical.

**Requirements.**
1. Model an entity (say a `product`) cached in Redis, backed by a mock database with an artificial write latency you can tune.
2. Implement all four strategies behind a common interface so a test harness can swap them.
3. Drive concurrent readers and writers and *measure* the observed staleness window for each strategy (how long, after a write, a stale read is still possible).
4. Deliberately trigger the delete-on-write resurrection race and show which strategies exhibit it and which do not.
5. Record the extra code and Redis keys each strategy costs, producing a staleness-versus-complexity table.

**Extensions.**
- Add an event-driven variant driven by keyspace notifications or a Redis stream, and measure how consumer lag maps directly to the staleness window.
- Add a per-tag "invalidate a group" scenario (a product appearing on several cached pages) and show delete-on-write cannot do it cleanly while tags can.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Consistency Models: Stale Reads & Read-Your-Writes* (the consistency the strategies here can and cannot offer), *The Dual-Write Problem & Change Data Capture* (making event-driven invalidation reliable), *Cache-Aside, Read-Through & Write Strategies* (where invalidation plugs into the write path), *TTL, Expiration & Eviction* (the TTL mechanics behind the simplest strategy), *Cache Stampede & Thundering Herd* (what an over-aggressive invalidation triggers on refill).

- **Redis — Keyspace notifications** — Redis · *Intermediate* · the reference for enabling and consuming key-change/expiry events, the basis of the notification-driven strategy. <https://redis.io/docs/latest/develop/use/keyspace-notifications/>
- **Redis — EXPIRE and key expiration** — Redis · *Beginner* · how TTLs, lazy and active expiration behave; the mechanics under TTL-only invalidation. <https://redis.io/docs/latest/commands/expire/>
- **Redis — Client-side caching & tracking** — Redis · *Advanced* · server-driven invalidation that keeps a client cache coherent, invalidation as a first-class feature. <https://redis.io/docs/latest/develop/use/client-side-caching/>
- **Fastly — Surrogate keys & instant purge** — Fastly · *Intermediate* · the CDN vocabulary for tag-based invalidation (surrogate keys) and cache busting at the edge. <https://developer.fastly.com/reference/http/http-headers/Surrogate-Key/>
- **Designing Data-Intensive Applications (ch. 5, replication & consistency)** — Martin Kleppmann · *Advanced* · why keeping derived copies consistent with a source of truth is genuinely hard, the theory behind the difficulty. <https://dataintensive.net/>
- **Facebook — Scaling Memcache at Facebook** — Nishtala et al. (NSDI) · *Advanced* · a real-world treatment of invalidation at scale, including leases to defeat the stale-set race. <https://www.usenix.org/system/files/conference/nsdi13/nsdi13-final170_update.pdf>
- **Martin Kleppmann — blog on caches, logs and derived data** — Martin Kleppmann · *Advanced* · the "turn the database inside out" framing that motivates log/CDC-driven invalidation. <https://martin.kleppmann.com/>
- **Redis University — RU101 & RU330 (running Redis)** — Redis · *Beginner/Intermediate* · free courses covering TTL, eviction and operational patterns that underpin invalidation. <https://university.redis.com/>

---

*Caching with Redis Handbook — chapter 12.*
