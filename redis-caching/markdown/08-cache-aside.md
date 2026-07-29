# 08 · Design: Cache-Aside (Lazy Loading)

> **In one line:** Cache-aside is the default caching pattern precisely because it is honest about its own weakness — the application owns population, the cache is a disposable copy, and the one rule you must never forget is *on a write, delete the cache, do not update it*, because delete is the only choice that survives a concurrent read.

---

## 1. Overview

Cache-aside — also called *lazy loading* — is the pattern almost every cache you have ever touched actually uses, whether or not anyone named it. The application talks to *both* the cache and the database, and it treats the cache as a fast, optional, disposable copy of data that authoritatively lives in the store. Nothing is loaded into the cache until someone asks for it (hence *lazy*), and the cache is populated *on the side* of the read path (hence *aside*).

The shape is simple enough to state in three sentences. To read: look in the cache; on a hit, return it; on a miss, load from the database, put the result in the cache, and return it. To write: update the database, then *invalidate* the cached entry so the next read reloads it. Everything hard about caching — staleness, races, stampedes, the choice between deleting and updating — is hidden inside those three sentences, and this chapter is about dragging each of those hard things into the light.

The reason cache-aside is the default is that it degrades gracefully and demands nothing of the cache. If Redis is down, the application still works — every read is a miss that falls through to the database, slower but correct. The cache holds only what has actually been requested, so it never wastes memory on cold data. And because the application owns the read and write paths explicitly, you can reason about exactly what is cached and when it is invalidated, which is more than can be said for patterns that hide the store behind the cache (chapter 09).

This is a **Design** chapter, so we will also frame it the way a system-design interview does: given "put a cache in front of this database", cache-aside is the answer you reach for first, and the follow-up questions — *what do you do on a write? what if two requests race? what happens when the cache is empty and a thousand requests hit at once?* — are exactly the race conditions and safety nets this chapter builds up.

## 2. Core Concepts

- **Cache-aside (lazy loading)** — the application reads from and writes to the cache and the database directly; the cache is populated on demand from the read path.
- **Read path** — check cache &#8594; on miss, load from DB &#8594; populate cache &#8594; return.
- **Write path** — write the database, then *delete* (invalidate) the cached key so the next read repopulates it.
- **Cache hit / miss** — a hit serves from Redis; a miss falls through to the origin store and then populates the cache.
- **Invalidation** — removing a stale entry so it is reloaded fresh; in cache-aside this is a `DEL`/`UNLINK`, not a rewrite.
- **Delete-vs-update** — on a write you can either overwrite the cache with the new value or delete it; delete is safer under concurrency, and understanding *why* is the heart of this chapter.
- **Read-write race** — a read that loaded an old value repopulates the cache *after* a concurrent write invalidated it, leaving a stale entry until TTL.
- **TTL as a safety net** — an expiry on every entry so that even a missed or lost invalidation self-heals within a bounded time.
- **Negative caching** — caching the *absence* of a value (a "not found") with a short TTL to stop repeated misses from hammering the database (chapter 13 goes deeper on penetration).
- **Population ownership** — the question of *who* fills the cache; in cache-aside it is unambiguously the application, which is the pattern's defining property.

## 3. Theory & Principles

### The read path, and why it is the easy half

The read path is the part everyone gets right: check the cache, and on a miss, load from the database, store the result, and return it. The subtle points are all about the *store* step. You store with a TTL (never without — see the safety-net argument below). You store the serialized value in whatever form the read path expects. And you decide what to do about *concurrent* misses on the same cold key, because the naive version lets a thousand simultaneous requests all miss, all query the database, and all write the same value back — a stampede (chapter 12). For now the mental model is: reads populate, and populating is a write to the cache that races with everything else.

### The write path, and why *delete* beats *update*

The write path is where cache-aside earns its reputation for subtlety. You have changed the authoritative data in the database; the cached copy is now stale. You have two options: overwrite the cache with the new value, or delete the cached key so the next read reloads it. Both *sound* correct. Only one is.

The argument for **delete** is a concurrency argument, and it is the single most important idea in this chapter. Consider two writers, W1 setting a field to `A` and W2 setting it to `B`, roughly simultaneously. In the database, one of them wins — say the final committed value is `B`. If both writers *update the cache* after committing, the order in which they touch the cache is independent of the order in which they touched the database: it is entirely possible for W1's database commit to land last (final DB value `A`)... no — let me state the canonical hazard precisely. The database serializes the two writes to some final value. But the two cache updates can be reordered relative to the database commits by scheduling, GC pauses, or network delay, so the cache can end up holding the value from the write that *lost* in the database. Now the cache says `A` while the database says `B`, indefinitely, until TTL. **Deleting** side-steps this entirely: both writers delete the key, the key is simply gone, and the next reader reloads the current authoritative value. Two deletes cannot disagree; two updates can.

Delete also wins for reasons beyond the race. It is cheaper to compute — you do not need to serialize the new value into cache form on the write path. It avoids caching values that may never be read again (why populate on a write when the read path will populate on demand?). And it composes with read-through/write-through cleanly. The only cost of delete is a guaranteed cache miss on the next read, which is a small, bounded price. The rule to memorise: **on a write, delete the cache; let the read path repopulate.**

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="ch1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="ch2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
    <marker id="ch3" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Cache-aside: the read path and the write path</text>

  <rect x="24" y="40" width="410" height="200" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="229" y="62" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">READ path (lazy population)</text>
  <rect x="44" y="78" width="110" height="34" rx="6" fill="#dbeafe" stroke="#2563eb"/><text x="99" y="100" text-anchor="middle" fill="#1e40af">App</text>
  <rect x="200" y="78" width="110" height="34" rx="6" fill="#dbeafe" stroke="#2563eb"/><text x="255" y="100" text-anchor="middle" fill="#1e40af">Redis</text>
  <rect x="200" y="150" width="110" height="34" rx="6" fill="#fef3c7" stroke="#d97706"/><text x="255" y="172" text-anchor="middle" fill="#92400e">Database</text>
  <path d="M154,95 L196,95" stroke="#2563eb" stroke-width="1.5" marker-end="url(#ch1)"/>
  <text x="175" y="88" text-anchor="middle" fill="#1e40af" font-size="8">1. GET</text>
  <path d="M255,112 L255,146" stroke="#dc2626" stroke-width="1.5" marker-end="url(#ch2)"/>
  <text x="300" y="132" fill="#b91c1c" font-size="8">2. MISS &#8594; load</text>
  <path d="M200,168 L154,168 L120,116" stroke="#16a34a" stroke-width="1.5" fill="none" marker-end="url(#ch3)"/>
  <text x="120" y="150" fill="#166534" font-size="8">3. row</text>
  <path d="M154,105 L196,150" stroke="#16a34a" stroke-width="1.5" fill="none" marker-end="url(#ch3)"/>
  <text x="130" y="220" fill="#1e40af" font-size="9">4. SET key val EX ttl (populate), then return to caller</text>

  <rect x="446" y="40" width="410" height="200" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="651" y="62" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">WRITE path (invalidate, don't update)</text>
  <rect x="466" y="78" width="110" height="34" rx="6" fill="#dcfce7" stroke="#16a34a"/><text x="521" y="100" text-anchor="middle" fill="#166534">App</text>
  <rect x="622" y="78" width="110" height="34" rx="6" fill="#fef3c7" stroke="#d97706"/><text x="677" y="100" text-anchor="middle" fill="#92400e">Database</text>
  <rect x="622" y="150" width="110" height="34" rx="6" fill="#dcfce7" stroke="#16a34a"/><text x="677" y="172" text-anchor="middle" fill="#166534">Redis</text>
  <path d="M576,95 L618,95" stroke="#16a34a" stroke-width="1.5" marker-end="url(#ch3)"/>
  <text x="597" y="88" text-anchor="middle" fill="#166534" font-size="8">1. UPDATE</text>
  <path d="M600,112 L660,146" stroke="#dc2626" stroke-width="1.5" marker-end="url(#ch2)"/>
  <text x="560" y="140" fill="#b91c1c" font-size="8">2. DEL key</text>
  <text x="480" y="208" fill="#166534" font-size="9">Next read misses and reloads the fresh row.</text>
  <text x="480" y="224" fill="#166534" font-size="9">Two deletes cannot disagree; two updates can.</text>

  <rect x="24" y="256" width="832" height="196" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="440" y="278" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Why UPDATE-the-cache is a bug: the read-write race</text>
  <text x="44" y="302" fill="#991b1b" font-size="10">t1  Reader R: GET key &#8594; MISS, begins loading old value V0 from DB (slow)</text>
  <text x="44" y="322" fill="#991b1b" font-size="10">t2  Writer W: UPDATE DB to V1, then DEL key  (cache now empty, DB = V1)</text>
  <text x="44" y="342" fill="#991b1b" font-size="10">t3  Reader R (still holding stale V0) does SET key V0 &#8212; repopulates with the OLD value</text>
  <text x="44" y="362" fill="#b91c1c" font-size="10" font-weight="bold">Result: cache = V0 (stale), DB = V1 (fresh) &#8212; stuck until TTL expires</text>
  <rect x="44" y="378" width="792" height="58" rx="6" fill="#fff" stroke="#fca5a5"/>
  <text x="60" y="400" fill="#166534" font-size="10" font-weight="bold">Mitigations:  (a) TTL bounds the staleness window automatically</text>
  <text x="60" y="418" fill="#166534" font-size="10">(b) delete-after-write (not update) shrinks it;  (c) delayed double-delete or versioned writes close it further</text>
</svg>
```

### The read-write race the pattern hides

Even with delete-after-write, cache-aside contains a genuine race that the diagram above makes concrete, and a senior engineer should be able to draw it from memory. A reader misses and begins loading the *old* value `V0` from the database — but this load is not instantaneous. While that load is in flight, a writer commits `V1` to the database and deletes the (already-empty) cache key. Now the slow reader, still holding the stale `V0` it read before the write committed, completes its populate step and writes `V0` into the cache. The cache is now stale and will stay stale until the TTL fires, because no further write is coming to invalidate it. This race is inherent to any pattern where a read can be interleaved with a write and reads populate the cache. You cannot eliminate it for free; you *bound* it with a TTL and *shrink* it with techniques like versioned values or a delayed second delete (chapter 15). The honest position is: cache-aside is eventually consistent, the TTL is the bound on "eventually", and that is usually fine.

### TTL as the safety net, negative caching, and who owns population

Three principles round out the theory. First, **every entry gets a TTL** — not primarily for freshness but as a *self-healing* mechanism: any bug in your invalidation logic, any missed delete, any lost race resolves itself within the TTL, because the entry simply expires and reloads. A cache-aside entry with no TTL is a stale value waiting to happen. Second, **negative caching**: when the database returns "not found", cache that absence too, with a *short* TTL, so a flood of requests for a non-existent key does not fall through to the database every time (this is the seed of cache-penetration defence in chapter 13). Third, **population ownership is explicit and unshared**: in cache-aside the *application* fills the cache, always, on the read path. This is the defining difference from read-through (chapter 09), where a caching layer owns population and the application never sees the store. Owning population yourself is more code but total control — you decide exactly what is cached, in what form, with what TTL, and when it is invalidated.

## 4. Architecture & Workflow

The end-to-end workflow, with the failure modes annotated:

1. **Read — check cache.** `GET key`. On a hit, deserialize and return. This is the fast path and should be the overwhelming majority of reads.
2. **Read — miss, load origin.** On a miss, query the database. Here is where a stampede can occur if many requests miss the same cold key at once; a per-key lock or singleflight (chapter 12) collapses them into one load.
3. **Read — populate.** `SET key value EX ttl`. Always with a TTL. If the load returned "not found", populate a negative marker with a short TTL instead.
4. **Read — return.** Deserialize and return the value to the caller.
5. **Write — update origin.** Commit the change to the authoritative database first. The database is the source of truth; the cache is derived.
6. **Write — invalidate.** `DEL key` (or `UNLINK` for a large value). *Delete, do not update.* The next read repopulates from the fresh database state. Optionally schedule a delayed second delete to close the read-write race (chapter 15).
7. **Failure handling.** If Redis is unavailable, reads fall through to the database (correct, just slower) and writes still commit to the database with the invalidation best-effort. Cache-aside is designed to degrade to "no cache", never to "wrong answer".

```svg
<svg viewBox="0 0 880 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="cd1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#64748b"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Cache-aside decision flow (read) with the safety nets marked</text>

  <rect x="360" y="40" width="160" height="38" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="440" y="64" text-anchor="middle" fill="#1e40af" font-weight="bold">GET key from Redis</text>

  <path d="M440,78 L440,104" stroke="#64748b" stroke-width="1.5" marker-end="url(#cd1)"/>
  <rect x="360" y="106" width="160" height="34" rx="8" fill="#f1f5f9" stroke="#64748b"/>
  <text x="440" y="128" text-anchor="middle" fill="#334155" font-weight="bold">hit or miss?</text>

  <path d="M360,123 L210,123" stroke="#16a34a" stroke-width="1.5" marker-end="url(#cd1)"/>
  <text x="285" y="116" text-anchor="middle" fill="#166534" font-size="9">HIT</text>
  <rect x="40" y="106" width="170" height="34" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="125" y="128" text-anchor="middle" fill="#166534" font-weight="bold">deserialize &amp; return</text>

  <path d="M520,123 L670,123" stroke="#dc2626" stroke-width="1.5" marker-end="url(#cd1)"/>
  <text x="595" y="116" text-anchor="middle" fill="#b91c1c" font-size="9">MISS</text>
  <rect x="672" y="102" width="180" height="42" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="762" y="120" text-anchor="middle" fill="#92400e" font-size="9" font-weight="bold">acquire per-key lock</text>
  <text x="762" y="136" text-anchor="middle" fill="#92400e" font-size="9">(collapse stampede)</text>

  <path d="M762,144 L762,170" stroke="#64748b" stroke-width="1.5" marker-end="url(#cd1)"/>
  <rect x="672" y="172" width="180" height="34" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="762" y="194" text-anchor="middle" fill="#92400e" font-weight="bold">load from database</text>

  <path d="M762,206 L762,232" stroke="#64748b" stroke-width="1.5" marker-end="url(#cd1)"/>
  <rect x="632" y="234" width="260" height="34" rx="8" fill="#f1f5f9" stroke="#64748b"/>
  <text x="762" y="256" text-anchor="middle" fill="#334155" font-weight="bold">row found?</text>

  <path d="M632,251 L470,251" stroke="#16a34a" stroke-width="1.5" marker-end="url(#cd1)"/>
  <text x="550" y="244" text-anchor="middle" fill="#166534" font-size="9">YES</text>
  <rect x="280" y="234" width="190" height="34" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="375" y="256" text-anchor="middle" fill="#166534" font-size="10" font-weight="bold">SET key val EX ttl</text>

  <path d="M762,268 L762,300" stroke="#64748b" stroke-width="1.5" marker-end="url(#cd1)"/>
  <text x="810" y="288" fill="#b91c1c" font-size="9">NO</text>
  <rect x="632" y="302" width="260" height="46" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="762" y="322" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">negative cache</text>
  <text x="762" y="338" text-anchor="middle" fill="#991b1b" font-size="9">SET key NULL EX short_ttl</text>

  <rect x="40" y="360" width="812" height="58" rx="8" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="446" y="382" text-anchor="middle" fill="#1e40af" font-size="11" font-weight="bold">Write path (separate): UPDATE database &#8594; DEL key (never SET). Optional delayed second DEL closes the read-write race.</text>
  <text x="446" y="404" text-anchor="middle" fill="#1e3a8a" font-size="10">If Redis is down: reads fall through to the DB (slower, still correct); writes commit and invalidation is best-effort.</text>
</svg>
```

The architecture's virtue is visible in the last box: every failure path leads to "slower but correct", never to "fast but wrong". That is the property that makes cache-aside the safe default.

## 5. Implementation

A complete, production-shaped cache-aside implementation in Go with `github.com/redis/go-redis/v9`. It shows the read path with negative caching, the write path with delete-not-update, TTL jitter to avoid synchronised expiry, and a stampede-collapsing per-key load using `singleflight`.

```go
package cacheaside

import (
	"context"
	"encoding/json"
	"errors"
	"math/rand"
	"time"

	"github.com/redis/go-redis/v9"
	"golang.org/x/sync/singleflight"
)

// User is the domain object we cache. In a real system this is loaded from a
// relational or document store; here loadFromDB stands in for that.
type User struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

// ErrNotFound is what the origin store returns when the row does not exist.
var ErrNotFound = errors.New("not found")

// negativeMarker is the sentinel we store to cache the ABSENCE of a value.
// A short TTL on this stops a flood of requests for a missing key from
// falling through to the database every single time (cache penetration).
const negativeMarker = "\x00__NULL__"

// Store is the cache-aside repository. It owns BOTH the cache and the DB — that
// explicit dual ownership is the defining property of cache-aside.
type Store struct {
	rdb  *redis.Client
	ttl  time.Duration
	negTTL time.Duration
	group singleflight.Group // collapses concurrent misses on the same key
	loadFromDB func(ctx context.Context, id string) (*User, error)
}

func NewStore(rdb *redis.Client, loader func(context.Context, string) (*User, error)) *Store {
	return &Store{
		rdb:        rdb,
		ttl:        10 * time.Minute,
		negTTL:     30 * time.Second, // negatives expire fast: rows get created
		loadFromDB: loader,
	}
}

func key(id string) string { return "user:" + id }

// jitteredTTL spreads expiry over a window so a batch of keys populated together
// does not all expire in the same instant (a cache-avalanche precursor,
// chapter 11). We add up to +/-10% of the base TTL.
func (s *Store) jitteredTTL(base time.Duration) time.Duration {
	delta := time.Duration(rand.Int63n(int64(base) / 5)) // 0 .. 20% of base
	return base - base/10 + delta                          // base +/- 10%
}

// Get is the READ path: check cache -> miss -> load DB -> populate -> return.
// Concurrent misses on the same id are collapsed into ONE database load by
// singleflight, so a cold key hit by 1000 requests queries the DB once.
func (s *Store) Get(ctx context.Context, id string) (*User, error) {
	// 1. Check the cache.
	raw, err := s.rdb.Get(ctx, key(id)).Result()
	if err == nil {
		if raw == negativeMarker {
			// We previously cached "this row does not exist". Honour it without
			// touching the database — that is the whole point of negative caching.
			return nil, ErrNotFound
		}
		var u User
		if jsonErr := json.Unmarshal([]byte(raw), &u); jsonErr == nil {
			return &u, nil // HIT — the fast path, the vast majority of reads.
		}
		// Corrupt cache entry: fall through and reload rather than trust it.
	} else if err != redis.Nil {
		// A real Redis error (not a miss). Degrade gracefully: skip the cache and
		// serve from the database so a cache outage never breaks reads.
		return s.loadFromDB(ctx, id)
	}

	// 2. MISS. Collapse concurrent loaders for this id into one via singleflight,
	// so a stampede on a cold key becomes a single DB query whose result is
	// shared by every waiter.
	v, err, _ := s.group.Do(id, func() (any, error) {
		user, dbErr := s.loadFromDB(ctx, id)
		if errors.Is(dbErr, ErrNotFound) {
			// 3a. Populate a NEGATIVE entry with a short TTL and propagate the miss.
			s.rdb.Set(ctx, key(id), negativeMarker, s.jitteredTTL(s.negTTL))
			return nil, ErrNotFound
		}
		if dbErr != nil {
			return nil, dbErr // real error: do NOT poison the cache with it.
		}
		// 3b. Populate the cache with the loaded value and a jittered TTL. The TTL
		// is the safety net: any missed invalidation self-heals within it.
		if data, mErr := json.Marshal(user); mErr == nil {
			s.rdb.Set(ctx, key(id), data, s.jitteredTTL(s.ttl))
		}
		return user, nil
	})
	if err != nil {
		return nil, err
	}
	return v.(*User), nil
}

// Put is the WRITE path: update the database first, THEN delete the cache.
// We DELETE, we do not overwrite: two concurrent deletes cannot leave the cache
// holding the value from the write that lost in the database, whereas two
// concurrent SETs can. Delete is the only choice that is race-safe.
func (s *Store) Put(ctx context.Context, u *User, writeDB func(context.Context, *User) error) error {
	// 1. Commit to the source of truth first. If this fails, we never touched the
	// cache, so there is nothing stale to clean up.
	if err := writeDB(ctx, u); err != nil {
		return err
	}
	// 2. Invalidate. UNLINK (not DEL) reclaims memory in a background thread, which
	// matters only for large values but is a harmless default. A failure here is
	// best-effort: the TTL will eventually expire the stale entry regardless.
	if err := s.rdb.Unlink(ctx, key(u.ID)).Err(); err != nil {
		// Optionally: log and schedule a retry. Do not fail the write — the DB is
		// already correct and the TTL bounds the staleness.
		_ = err
	}
	return nil
}

// PutWithDoubleDelete narrows the read-write race window. After the write and the
// immediate delete, we schedule a SECOND delete a short time later, to evict any
// stale value that a slow concurrent reader may have repopulated in between
// (the classic delayed-double-delete). It is a mitigation, not a proof of
// correctness — the TTL remains the real bound.
func (s *Store) PutWithDoubleDelete(ctx context.Context, u *User, writeDB func(context.Context, *User) error) error {
	if err := writeDB(ctx, u); err != nil {
		return err
	}
	s.rdb.Unlink(ctx, key(u.ID))
	go func() {
		// Detach from the request context so it is not cancelled when the request
		// returns; use a fresh, bounded context.
		time.Sleep(500 * time.Millisecond)
		bg, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		s.rdb.Unlink(bg, key(u.ID))
	}()
	return nil
}
```

The code makes the pattern's decisions explicit: delete-not-update on the write path, negative caching and singleflight on the read path, jittered TTLs everywhere as the safety net, and graceful degradation to the database whenever Redis errors. The `redis-cli` equivalent of the two hot paths is worth internalising too:

```bash
# Read path on a miss, then populate with a TTL (seconds):
GET user:42                 # (nil)  -> miss
# ... load row from DB ...
SET user:42 "{...json...}" EX 600   # populate with a 10-minute TTL

# Write path: update DB, then INVALIDATE (delete, never SET):
UNLINK user:42              # next read reloads the fresh row
```

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Graceful degradation.** If the cache is down, reads fall through to the database — slower, but always correct. The pattern degrades to "no cache", never to "wrong answer".
- **Only caches what is used.** Lazy loading means cold data never occupies memory; the cache naturally holds the working set.
- **Explicit control.** The application owns the read and write paths, so you know exactly what is cached, in what form, with what TTL, and when it is invalidated.
- **Store-agnostic and simple.** It works with any database and needs nothing special from the cache — just `GET`, `SET`, `DEL`.
- **Race-safe writes (with delete).** Deleting on write avoids the update-ordering hazard that plagues write-through-the-cache approaches.

**Disadvantages**
- **Every miss pays a penalty.** A miss is a cache round trip *plus* a database query *plus* a populate — three hops where a hit is one. Cold caches are slow.
- **Duplicated read logic.** Every read site must implement check-load-populate, so the pattern's logic is scattered unless you wrap it (which is exactly what read-through does, chapter 09).
- **The read-write race.** Reads populating the cache can be interleaved with writes, leaving a stale entry until TTL. Cache-aside is eventually consistent, not strongly consistent.
- **Stampede-prone.** A hot cold key hit by many requests at once causes a thundering herd on the database unless you add a lock or singleflight.

**Trade-offs**
- *Delete vs update on write:* delete is race-safe and cheaper but guarantees a miss on the next read; update avoids that miss but can leave the cache holding the losing write's value. Prefer delete almost always.
- *TTL length:* a long TTL means higher hit rates but a longer window for staleness from a missed invalidation; a short TTL is fresher but misses more. The TTL is simultaneously your safety net and your staleness bound.
- *Consistency vs simplicity:* closing the read-write race fully (versioned writes, double delete, distributed locks) adds complexity; accepting bounded staleness keeps the pattern simple. Most systems should accept the bound.
- *Population ownership:* owning population in the application (cache-aside) is more code but total control; delegating it to a caching layer (read-through) is less code but hides the store access and its failure modes.

## 7. Common Mistakes & Best Practices

- **Updating the cache on a write instead of deleting it.** The canonical bug: two concurrent updates can reorder relative to the database and leave the cache holding the value from the write that lost. *Best practice:* on a write, `DEL`/`UNLINK` the key and let the read path repopulate.
- **Caching without a TTL.** An entry with no expiry is a stale value waiting to happen — any missed invalidation persists forever. *Best practice:* every entry gets a (jittered) TTL as a self-healing safety net.
- **Deleting the cache *before* committing the database write.** If the delete lands, a concurrent read repopulates the *old* value from the not-yet-updated database, and then your write commits — leaving stale data. *Best practice:* commit the database first, invalidate second.
- **No negative caching.** Repeated requests for a non-existent key fall through to the database every time, an easy denial-of-service vector. *Best practice:* cache the "not found" with a short TTL.
- **No stampede protection on hot keys.** A popular key expiring lets a thousand requests miss and hammer the database simultaneously. *Best practice:* collapse concurrent misses with a per-key lock or singleflight (chapter 12).
- **Failing the write when the cache invalidation fails.** The database is already correct; failing the whole write because a `DEL` errored turns a cache blip into a user-visible error. *Best practice:* make invalidation best-effort with a retry, and rely on the TTL as backstop.
- **Serialising giant objects into one key.** A multi-megabyte cached value makes every read and every network transfer slow. *Best practice:* cache field-addressable objects as hashes (chapter 04) or split large values.
- **Best practice overall:** commit DB first, delete not update, always TTL, negative-cache misses, and collapse stampedes — those five habits make cache-aside correct in production.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** When users report stale data, the first question is *did an invalidation fire?* Check that the write path deletes the key and that the delete actually reached Redis (a dropped `DEL` due to a cache-unavailable degradation is the classic cause). `OBJECT IDLETIME key` and `TTL key` tell you how old an entry is and how long it has left; a stale entry with a long remaining TTL points at a missed invalidation, not an expiry problem. Reproduce the read-write race deliberately in a test by delaying the loader.
- **Monitoring.** The cache hit ratio is the headline metric — a falling ratio signals cold caches, over-aggressive invalidation, or a TTL that is too short. Track it alongside database query rate: a spike in DB queries with a dip in hit ratio is a stampede or a mass expiry. Watch `keyspace_misses`/`keyspace_hits` from `INFO stats`, and alert on the miss rate for hot keyspaces.
- **Security.** The cache inherits the sensitivity of what it holds — a cached user object is still personal data, so the same access controls, encryption-in-transit (TLS), and authentication (`requirepass`/ACLs) apply as for the database (chapter 29). Negative-cache markers must be unforgeable sentinels that cannot collide with a legitimate serialized value, or an attacker could poison a key into permanent "not found".
- **Scaling.** Cache-aside scales horizontally with the cache: shard keys across a Redis Cluster and each node serves its slice. The read-path load on the database at cache-miss time is the scaling risk — a cold cluster restart means every read misses at once, so warm critical keys proactively or stagger TTLs (chapter 11) to avoid synchronised expiry. Because the application owns population, you can also add a small in-process local cache in front of Redis for the hottest keys to cut both round trips and Redis load (chapter 27).

## 9. Interview Questions

**Q: What is cache-aside and how does the read path work?**
A: Cache-aside (lazy loading) is the pattern where the application talks to both the cache and the database directly and populates the cache on demand. The read path is: check the cache with a `GET`; on a hit, deserialize and return; on a miss, load the value from the database, store it in the cache with a TTL (`SET key val EX ttl`), and return it. Nothing is cached until it is first requested, so the cache naturally holds the working set and never wastes memory on cold data. The key subtlety on the read path is that populating is itself a write to the cache that races with concurrent operations, and that many simultaneous misses on the same cold key can stampede the database unless collapsed by a lock or singleflight.

**Q: On a write, should you update the cache or delete it, and why?**
A: Delete it. The reason is concurrency. If two writers both update the cache after committing to the database, the order in which they touch the cache is independent of the order in which they committed, so the cache can end up holding the value from the write that *lost* in the database — stale until the TTL fires. Two deletes cannot disagree: whichever order they run in, the key ends up gone and the next read reloads the current authoritative value. Delete is also cheaper (no need to serialize the new value on the write path) and avoids caching values that may never be read again. The only cost is a guaranteed miss on the next read, which is a small, bounded price for correctness.

**Q: What is the read-write race in cache-aside?**
A: It is the inherent race where a slow read populates the cache with a stale value *after* a concurrent write has invalidated it. A reader misses and begins loading the old value `V0` from the database; while that load is in flight, a writer commits `V1` and deletes the cache key; then the slow reader completes and writes `V0` back into the cache. The cache now holds `V0` while the database holds `V1`, and it stays stale until the TTL expires because no further write is coming. You cannot eliminate this race for free — you bound it with a TTL and shrink it with a delayed second delete or versioned values.

**Q: Why does every cache-aside entry need a TTL?**
A: Primarily as a self-healing safety net, not just for freshness. Any bug in your invalidation logic, any missed delete, any lost read-write race leaves a stale entry — and the TTL guarantees that stale entry disappears and reloads within a bounded time. An entry with no TTL is a stale value waiting to happen, because the only thing that would ever fix it is an explicit invalidation you have already established can be missed. The TTL is simultaneously your staleness bound and your insurance policy against invalidation bugs.

**Q: What is negative caching and why do it?**
A: Negative caching is storing the *absence* of a value — a "not found" marker — in the cache, with a short TTL. Without it, repeated requests for a key that does not exist in the database miss the cache every time and fall through to the database, which is both wasteful and an easy denial-of-service vector (cache penetration). Caching the miss with a short TTL means those requests are absorbed by the cache; the TTL is kept short because the underlying row may be created at any time, and you do not want to serve "not found" for long after it exists.

**Q: Should you invalidate the cache before or after committing the database write?**
A: After. If you delete the cache before the database commit, a concurrent read can miss, load the *old* value from the not-yet-updated database, and repopulate the cache with it — and then your write commits, leaving the cache stale. Committing the database first means the source of truth is already correct when you invalidate, so any read that repopulates after the delete loads the new value. The correct order is: update the database, then delete the cache.

**Q: (Senior) Cache-aside is described as eventually consistent. What exactly is the consistency guarantee, and how would you tighten it if a business requirement demanded?**
A: The guarantee is that the cache converges to the database's value within the TTL, and in the common case immediately after a write's invalidation — but there is a window, opened by the read-write race, where the cache can hold a stale value until the TTL expires. So the honest statement is "the cache is at most TTL-stale, and usually fresh right after a write." To tighten it, I would layer mitigations in increasing order of cost and complexity. First, delayed double-delete: after the write and the immediate delete, schedule a second delete a few hundred milliseconds later to evict any value a slow concurrent reader repopulated in the interim — cheap, and closes most of the window. Second, versioned values: store a monotonically increasing version alongside the value and only accept a populate if its version is not older than what a write recorded, which makes a stale populate a no-op. Third, for truly strong requirements, stop using lazy population for that data and move to a write-through or write-behind model where the cache is updated as part of the write under a lock, or bypass the cache entirely for reads that must be linearizable. The key judgement is that each step trades simplicity and latency for a smaller staleness window, and most systems should accept a short bounded window rather than pay for strong consistency they do not truly need.

**Q: (Senior) A hot key expires and your database falls over. Walk through what happened and how cache-aside should have prevented it.**
A: This is a cache stampede, also called a thundering herd or dogpile. A single very popular key — say a homepage configuration or a trending item — reaches its TTL and is evicted. In the instant after expiry, every concurrent request for that key misses simultaneously; with naive cache-aside, each of those misses independently queries the database and then independently repopulates the cache. If the key is hot enough, that is thousands of identical database queries in the same few milliseconds, which can saturate connection pools and topple the database — and worse, the repopulate storm can repeat on the next expiry. Cache-aside should prevent this by collapsing concurrent misses on the same key into a single load: an in-process singleflight so only one goroutine per process queries the database and the rest wait for its result, and for cross-process protection a short-lived distributed lock (`SET lock NX PX`) so only one process across the fleet does the load while others briefly serve stale or wait. Complementary defences are TTL jitter so hot keys do not all expire at the same instant (an avalanche precursor), probabilistic early recompute so a hot key is refreshed *before* it expires (chapter 11), and stale-while-revalidate so a slightly stale value is served while one worker refreshes. The root cause is always "many misses, one key, at once", and the fix is always "make it one load".

**Q: (Senior) How does cache-aside behave under a Redis outage, and what does that tell you about where to put your correctness guarantees?**
A: Under a Redis outage, a well-built cache-aside path degrades to "no cache": every read errors on the `GET`, catches it, and falls through to the database, returning the correct answer more slowly; every write commits to the database and treats the invalidation as best-effort, since there is no cache to invalidate. Nothing returns a *wrong* answer — the worst case is elevated latency and database load, which is why cache-aside is the safe default. The lesson for where correctness lives is that the database must be the sole source of truth and the cache must be a strictly derived, disposable copy: any logic that treats the cache as authoritative — for example, decrementing an inventory count *in the cache* and trusting it — breaks the moment the cache is unavailable or evicts the key. Correctness guarantees belong in the store; the cache only ever accelerates reads of what the store already knows. The corollary for operations is that you must load-test the "cold cache" and "cache down" cases, because a system that only survives with a warm cache has hidden a hard dependency on an component you deliberately made optional.

**Q: When would you choose read-through over cache-aside?**
A: When you want to centralise the read-path logic and stop every call site from reimplementing check-load-populate, and you are willing to let a caching layer own access to the store. Read-through moves the population into the cache library or proxy: the application asks the cache for a key and the cache, on a miss, invokes a loader you supplied to fetch and populate it, so the application never talks to the database on reads. It is the same read behaviour as cache-aside with the plumbing hidden, which reduces duplication and mistakes, at the cost of the loader abstraction and the caching layer owning the store access and its failure modes. You would keep cache-aside when you want explicit, per-site control or when different read sites cache the same data differently.

## 10. Quick Revision & Cheat Sheet

| Aspect | Cache-aside behaviour |
|---|---|
| Who populates | The application, on the read path (lazy) |
| Read on hit | `GET` &#8594; deserialize &#8594; return |
| Read on miss | load DB &#8594; `SET key val EX ttl` &#8594; return |
| Write | update DB &#8594; `DEL`/`UNLINK` key (never `SET`) |
| Missing value | negative cache with short TTL |
| Cache down | reads fall through to DB (correct, slower) |
| Consistency | eventual; at most TTL-stale |

| Hazard | Fix |
|---|---|
| Update-on-write ordering bug | Delete, don't update |
| Missed invalidation | TTL as safety net |
| Stale after concurrent write | TTL bound + delayed double delete |
| Stampede on hot key | singleflight / per-key lock |
| Penetration by missing keys | negative caching, short TTL |
| Synchronised expiry | TTL jitter (chapter 11) |

**Flash cards**
- **Read path?** &#8594; check cache, miss &#8594; load DB &#8594; populate with TTL &#8594; return.
- **Write path?** &#8594; update DB, then delete the cache key (never overwrite).
- **Why delete not update?** &#8594; two deletes can't disagree; two updates can leave the losing write's value.
- **Why always a TTL?** &#8594; self-healing safety net for missed invalidations and lost races.
- **Read-write race?** &#8594; slow read repopulates stale value after a concurrent write; bounded by TTL.
- **Negative caching?** &#8594; cache "not found" with a short TTL to stop penetration.

## 11. Hands-On Exercises & Mini Project

- [ ] Implement the read path with `GET`/`SET EX` and confirm a cold key does one DB load, then serves from cache on subsequent reads.
- [ ] Implement the write path two ways — update-the-cache and delete-the-cache — then write a concurrent test that reorders two writers and show the update version leaving a stale value the delete version does not.
- [ ] Reproduce the read-write race: add an artificial delay to the loader, fire a write during a slow read, and observe the cache holding the stale value until TTL.
- [ ] Add negative caching for missing keys and measure the drop in database queries when the same missing key is requested repeatedly.
- [ ] Add `singleflight` to the read path and show 1000 concurrent misses on a cold key producing exactly one database query.
- [ ] Add TTL jitter and show that a batch of keys populated together no longer expires in the same instant.

### Mini Project — "Cache-Aside Repository with a Consistency Harness"

**Goal.** Build a reusable cache-aside repository and a test harness that *proves* its consistency properties, so the pattern's races become observable rather than theoretical.

**Requirements.**
1. Implement `Get` (check-load-populate with negative caching and singleflight) and `Put` (update DB then delete) over Redis and a stubbed database with controllable latency.
2. Every populate uses a jittered TTL; expose the base TTL and negative TTL as config.
3. Build a concurrency harness that runs many readers and writers against the same key and reports whether the cache ever disagreed with the database, and for how long.
4. Add the update-on-write variant behind a flag and demonstrate the harness catching the staleness bug that the delete variant avoids.
5. Add delayed double-delete and measure how much it shrinks the observed staleness window.

**Extensions.**
- Add a per-process local cache in front of Redis and measure the reduction in Redis round trips for a hot key, then reason about the new invalidation problem it introduces (chapter 27).
- Add stampede metrics: count database queries per cache miss and chart the effect of adding and removing singleflight under a synthetic thundering-herd load.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Read-Through & Write-Through Caching* (moving population behind the cache), *Write-Behind & Write-Around* (asynchronous and bypass writes), *TTL Strategy, Refresh-Ahead & Adaptive Expiry* (the safety net in depth), *Cache Stampede & the Thundering Herd* (collapsing concurrent misses), *Cache Consistency & Invalidation Strategies* (closing the read-write race).

- **Redis — Client-side caching & caching patterns** — Redis · *Intermediate* · the official framing of cache-aside and its alternatives, and the primitives (`SET EX`, `DEL`, invalidation) the pattern is built from. <https://redis.io/docs/latest/develop/use/client-side-caching/>
- **AWS — Caching strategies: Lazy Loading vs Write-Through** — AWS ElastiCache · *Intermediate* · a clear, vendor-neutral write-up of the read/write paths and the trade-offs, with the lazy-loading terminology. <https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/Strategies.html>
- **Designing Data-Intensive Applications, ch. 5 (Replication) & ch. 9 (Consistency)** — Martin Kleppmann · *Advanced* · the rigorous grounding for why cache-aside is eventually consistent and what the read-write race really is. <https://dataintensive.net/>
- **Facebook — Scaling Memcache at Facebook** — Nishtala et al. (USENIX NSDI) · *Advanced* · the canonical paper on cache-aside at scale, including delete-on-write, leases for stampedes, and the exact races this chapter describes. <https://www.usenix.org/system/files/conference/nsdi13/nsdi13-final170_update.pdf>
- **golang.org/x/sync/singleflight** — Go team · *Intermediate* · the standard primitive for collapsing concurrent cache misses into one load; the read-path stampede fix used in §5. <https://pkg.go.dev/golang.org/x/sync/singleflight>
- **Redis — EXPIRE, SET and key expiration** — Redis · *Beginner* · the commands behind the TTL safety net, including `SET ... EX`, `EXPIRE`, and `TTL`. <https://redis.io/docs/latest/commands/expire/>
- **Martin Kleppmann — Cache invalidation is one of the hard problems** — martin.kleppmann.com · *Advanced* · essays on why invalidation and the delete-vs-update choice are genuinely hard, grounding this chapter's core argument. <https://martin.kleppmann.com/>
- **Redis University — RU101: Introduction to Redis** — Redis · *Beginner* · free hands-on course whose caching module walks through the cache-aside read and write paths in practice. <https://university.redis.com/>

---

*Caching with Redis Handbook — chapter 08.*
