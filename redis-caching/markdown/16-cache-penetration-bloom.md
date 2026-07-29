# 16 · Cache Penetration, Null Caching & Bloom Filters

> **In one line:** A cache only protects the database from keys that *exist*; requests for keys that were never there miss every time and pass straight through, so the defence is not "cache the answer" but "cache the *absence* and, cheaper still, refuse to look up something you can prove was never stored".

---

## 1. Overview

Cache-aside works because a value, once fetched, sits in the cache and absorbs every subsequent request for it. That logic has a hole: it only ever caches values that *exist*. A request for a key that has no value — a user id that was never created, a product that does not exist, a randomly-generated identifier — misses the cache (nothing to hit), falls through to the database, finds nothing there either, and returns "not found". Crucially, **nothing gets written to the cache**, because there is nothing to write. So the *next* request for that same non-existent key repeats the entire journey: miss, database hit, nothing found. The cache provides zero protection for absent keys, and every request for one is a database query. This is **cache penetration**: traffic that penetrates *through* the cache to the origin because the cache never holds a value that could stop it.

It arrives in two flavours. The benign one is ordinary missing data — a lookup for something that legitimately does not exist yet (a username being checked for availability, a deleted record still linked from stale pages). The malicious one is an attack: an adversary generates a stream of requests for keys they *know* do not exist — `user:99999999`, `user:99999998`, and so on — precisely because they know each one bypasses the cache and costs you a database query. A few thousand requests per second for non-existent keys can load your database as heavily as your entire legitimate cached traffic, while your cache sits there useless because there is nothing to cache.

The defences are three, in increasing power and cost: **null-caching** (cache a small sentinel "not found" so repeat misses are absorbed like any other value), **input validation** (reject obviously-invalid keys before they reach the database at all), and **Bloom filters** (a probabilistic membership structure that answers "this key was *definitely* never stored" in a few bits, short-circuiting the origin read entirely). This chapter builds all three, explains exactly how a Bloom filter can be sure of a negative but not a positive, and covers RedisBloom and cuckoo filters for when you need deletions.

## 2. Core Concepts

- **Cache penetration** — requests for keys with no value bypass the cache (nothing to hit) and always reach the origin.
- **Missing key / negative lookup** — a key that has no value in the origin; the source of both benign and malicious penetration.
- **Null caching / negative cache** — caching a sentinel value meaning "confirmed absent" with a short TTL, so repeat misses hit the cache instead of the origin.
- **Sentinel value** — the placeholder stored to represent "not found" (an empty marker, a magic string) distinct from a real value.
- **Input/request validation** — rejecting structurally-impossible keys (out-of-range ids, malformed formats) before any lookup.
- **Bloom filter** — a probabilistic set-membership structure: "definitely not present" (no false negatives) or "possibly present" (false positives possible), in a tiny bit array.
- **Bit array + k hash functions** — a Bloom filter's guts: k hashes set/test k bits per element in an m-bit array.
- **False positive rate** — the tunable probability a Bloom filter says "possibly present" for an element never added; falls as m grows.
- **Cuckoo filter** — a Bloom-like filter that additionally supports *deletion*, by storing item fingerprints in a cuckoo hash table.
- **RedisBloom** — the Redis module providing `BF.*` (Bloom), `CF.*` (cuckoo), and other probabilistic commands server-side.

## 3. Theory & Principles

### Why absence is the blind spot

A cache is a positive index: it maps keys to values it has *seen*. Absence is invisible to it — there is no value to store, so the cache has no memory that "this key was looked up and found to be missing". Every mitigation is really a way of giving the cache (or a structure beside it) a *memory of absence* so it can stop the next identical miss.

Null-caching does this most directly: it invents a value for "absent" — a sentinel — and caches *that*, converting a negative lookup into a normal cache hit for its TTL. It is trivial and it works, but it has two costs. First, **memory**: an attacker enumerating millions of distinct non-existent keys makes you store millions of sentinels, which can fill the cache and evict real data — so null entries need a short TTL and, ideally, a bounded key space. Second, and more subtly, **the newly-created-key race**: if you null-cache `user:42` as "not found", then `user:42` is *created* a moment later, reads will keep returning "not found" until the sentinel's TTL expires. The mitigations are a short sentinel TTL (bounding the staleness window) and *explicit invalidation on create* — when you write a new key, delete any negative cache entry for it.

### The Bloom filter: certain about negatives, hopeful about positives

A Bloom filter attacks the problem from the other side. Instead of remembering which keys are *absent*, it remembers, extremely compactly, which keys *could possibly exist*, and uses that to reject the rest before they ever reach the database. It is an `m`-bit array plus `k` independent hash functions. To **add** an element, hash it with all `k` functions, each producing an index into the bit array, and set those `k` bits to 1. To **test** membership, hash it the same way and check those `k` bits: if *any* of them is 0, the element was **definitely never added** (adding it would have set that bit) — a guaranteed negative. If *all* `k` bits are 1, the element is **possibly present** — but those bits might have been set by *other* elements' hashes, so this can be a **false positive**.

The asymmetry is the whole point and it is exactly the asymmetry penetration defence needs. A Bloom filter has **no false negatives**: if it says "not present", that is certain, so you can safely skip the database read. It has **false positives**: if it says "possibly present", you fall through and do the (occasional, harmless) real lookup, which correctly returns "not found". So you populate the filter with every key that *does* exist; a request for a non-existent key almost always gets a definite "no" from the filter and never touches the database, while the rare false positive costs one wasted lookup. The false-positive rate is tunable — roughly `(1 − e^(−kn/m))^k` for `n` elements — and you trade memory (`m`) for a lower rate. A filter holding 10 million keys at a 1% false-positive rate needs only about 12 MB; the same as a set of ids would be many times larger.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="b1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="b2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
    <marker id="b3" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Bloom filter: k hashes into an m-bit array &#8212; no false negatives</text>

  <rect x="24" y="40" width="832" height="120" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="440" y="60" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">ADD("user:7"): hash with k=3 functions, set those 3 bits to 1</text>

  <g font-size="9">
    <rect x="60" y="72" width="90" height="24" rx="4" fill="#fff" stroke="#2563eb"/><text x="105" y="88" text-anchor="middle" fill="#1e40af">"user:7"</text>
  </g>
  <path d="M150,84 L206,96" stroke="#2563eb" stroke-width="1.5" marker-end="url(#b1)"/>
  <path d="M150,84 L206,116" stroke="#2563eb" stroke-width="1.5" marker-end="url(#b1)"/>
  <path d="M150,84 L206,136" stroke="#2563eb" stroke-width="1.5" marker-end="url(#b1)"/>
  <text x="178" y="80" fill="#1d4ed8" font-size="8">h1,h2,h3</text>

  <g font-family="ui-monospace,monospace" font-size="12">
    <rect x="210" y="112" width="34" height="34" fill="#bfdbfe" stroke="#2563eb"/><text x="227" y="134" text-anchor="middle" fill="#1e40af" font-weight="bold">1</text>
    <rect x="244" y="112" width="34" height="34" fill="#fff" stroke="#93c5fd"/><text x="261" y="134" text-anchor="middle" fill="#94a3b8">0</text>
    <rect x="278" y="112" width="34" height="34" fill="#bfdbfe" stroke="#2563eb"/><text x="295" y="134" text-anchor="middle" fill="#1e40af" font-weight="bold">1</text>
    <rect x="312" y="112" width="34" height="34" fill="#fff" stroke="#93c5fd"/><text x="329" y="134" text-anchor="middle" fill="#94a3b8">0</text>
    <rect x="346" y="112" width="34" height="34" fill="#fff" stroke="#93c5fd"/><text x="363" y="134" text-anchor="middle" fill="#94a3b8">0</text>
    <rect x="380" y="112" width="34" height="34" fill="#bfdbfe" stroke="#2563eb"/><text x="397" y="134" text-anchor="middle" fill="#1e40af" font-weight="bold">1</text>
    <rect x="414" y="112" width="34" height="34" fill="#fff" stroke="#93c5fd"/><text x="431" y="134" text-anchor="middle" fill="#94a3b8">0</text>
    <rect x="448" y="112" width="34" height="34" fill="#fff" stroke="#93c5fd"/><text x="465" y="134" text-anchor="middle" fill="#94a3b8">0</text>
  </g>
  <text x="620" y="120" fill="#1e40af" font-size="10">m-bit array. Each element sets k bits.</text>
  <text x="620" y="138" fill="#1d4ed8" font-size="9">Bits are SHARED across elements &#8594; positives can collide.</text>

  <rect x="24" y="176" width="405" height="130" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="226" y="198" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">TEST("user:999") &#8594; some bit is 0</text>
  <text x="42" y="222" fill="#166534" font-size="10">at least one of its k bits is 0</text>
  <text x="42" y="242" fill="#166534" font-size="10">&#8594; it was DEFINITELY never added</text>
  <rect x="42" y="254" width="368" height="42" rx="6" fill="#bbf7d0" stroke="#16a34a"/>
  <text x="226" y="272" text-anchor="middle" fill="#14532d" font-size="10" font-weight="bold">GUARANTEED NEGATIVE &#8594; skip the DB read</text>
  <text x="226" y="288" text-anchor="middle" fill="#166534" font-size="9">no false negatives: this is the penetration defence</text>

  <rect x="451" y="176" width="405" height="130" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="653" y="198" text-anchor="middle" fill="#92400e" font-size="12" font-weight="bold">TEST("ghost") &#8594; all k bits are 1</text>
  <text x="469" y="222" fill="#b45309" font-size="10">all k bits happen to be set (by OTHER elements)</text>
  <text x="469" y="242" fill="#b45309" font-size="10">&#8594; POSSIBLY present (maybe a false positive)</text>
  <rect x="469" y="254" width="368" height="42" rx="6" fill="#fde68a" stroke="#d97706"/>
  <text x="653" y="272" text-anchor="middle" fill="#78350f" font-size="10" font-weight="bold">FALL THROUGH &#8594; do the real lookup</text>
  <text x="653" y="288" text-anchor="middle" fill="#92400e" font-size="9">rare &amp; harmless: DB correctly returns "not found"</text>

  <rect x="24" y="322" width="832" height="128" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="344" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">The asymmetry is exactly what penetration defence needs</text>
  <text x="44" y="368" fill="#475569" font-size="10">&#8226; Populate the filter with every key that EXISTS.</text>
  <text x="44" y="388" fill="#475569" font-size="10">&#8226; Non-existent key &#8594; almost always a definite "no" &#8594; DB never touched.</text>
  <text x="44" y="408" fill="#475569" font-size="10">&#8226; False positive &#8594; one wasted lookup that correctly returns "not found". No correctness risk.</text>
  <text x="44" y="430" fill="#334155" font-size="10" font-weight="bold">10M keys at 1% FP rate &#8776; ~12 MB. Tune m for a lower rate.</text>
</svg>
```

### Layering the three defences

The defences are complementary, not competing. **Validation** is the outermost and cheapest: reject a key that *cannot* be valid (an id outside the issued range, a malformed uuid) with no lookup at all — it stops the crudest enumeration attacks for free. **The Bloom filter** sits next: for keys that pass validation but do not exist, it answers "definitely not present" and skips the database. **Null-caching** is the backstop for the false positives and for keys the filter cannot cover (e.g. a filter that is being rebuilt): a miss that reaches the database and finds nothing is cached as a sentinel so the *next* identical miss is absorbed. Together they mean a request for a non-existent key is stopped at the earliest possible layer, and the database sees each distinct non-existent key at most once (and often never).

## 4. Architecture & Workflow

The full read path with all three defences:

1. **Validate the key.** Is it structurally possible? (id in range, correct format, passes a checksum). If not, return "not found" immediately — no cache, no database. This alone defeats naive sequential enumeration of impossible ids.
2. **Check the negative cache.** Is there a sentinel saying "confirmed absent"? If so, return "not found" from the cache. This absorbs repeat misses for keys that genuinely do not exist.
3. **Check the positive cache.** Normal cache-aside: if the value is present, return it.
4. **Consult the Bloom filter.** If the filter says "definitely not present", return "not found" and *skip the database entirely* — the key was never stored, so a lookup is guaranteed to be fruitless. (You may also write a short-TTL sentinel here to short-circuit step 2 next time.)
5. **Real database lookup.** Only reached for keys that pass validation, are not in the negative cache, are not in the positive cache, and the Bloom filter says "possibly present" (a real key, or a rare false positive).
   - **Found:** populate the positive cache (with a jittered TTL) and return the value.
   - **Not found (false positive):** populate the *negative* cache with a short-TTL sentinel and return "not found".
6. **Keep the filter in sync.** On create, add the new key to the Bloom filter *and* delete any negative-cache sentinel for it (defeating the newly-created-key race). Because a plain Bloom filter cannot delete, a *delete* of a real key is handled either by letting the negative cache and TTLs cover it, or by using a cuckoo filter that supports removal.

```svg
<svg viewBox="0 0 880 440" width="100%" height="440" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="p1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Layered penetration defence: stop the miss at the earliest possible layer</text>

  <rect x="330" y="38" width="220" height="34" rx="8" fill="#e2e8f0" stroke="#475569" stroke-width="2"/>
  <text x="440" y="60" text-anchor="middle" fill="#334155" font-weight="bold" font-size="11">request for key K</text>

  <rect x="60" y="92" width="760" height="52" rx="8" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="80" y="114" fill="#b91c1c" font-size="11" font-weight="bold">1. VALIDATE</text>
  <text x="80" y="132" fill="#991b1b" font-size="9">id in range? format valid? checksum ok? &#8212; if NOT: return "not found" (no cache, no DB). Defeats crude enumeration.</text>
  <path d="M440,72 L440,92" stroke="#475569" stroke-width="1.5" marker-end="url(#p1)"/>

  <rect x="60" y="156" width="760" height="52" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="80" y="178" fill="#92400e" font-size="11" font-weight="bold">2. NEGATIVE CACHE</text>
  <text x="80" y="196" fill="#b45309" font-size="9">sentinel "confirmed absent"? &#8212; if yes: return "not found" from cache. Absorbs repeat misses on non-existent keys.</text>
  <path d="M440,144 L440,156" stroke="#475569" stroke-width="1.5" marker-end="url(#p1)"/>

  <rect x="60" y="220" width="760" height="52" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="80" y="242" fill="#1e40af" font-size="11" font-weight="bold">3. POSITIVE CACHE</text>
  <text x="80" y="260" fill="#1d4ed8" font-size="9">normal cache-aside GET &#8212; if present: return the value. The common, happy path.</text>
  <path d="M440,208 L440,220" stroke="#475569" stroke-width="1.5" marker-end="url(#p1)"/>

  <rect x="60" y="284" width="760" height="52" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="80" y="306" fill="#5b21b6" font-size="11" font-weight="bold">4. BLOOM FILTER</text>
  <text x="80" y="324" fill="#6d28d9" font-size="9">"definitely not present"? &#8212; if yes: return "not found", SKIP the DB. Only "possibly present" falls through.</text>
  <path d="M440,272 L440,284" stroke="#475569" stroke-width="1.5" marker-end="url(#p1)"/>

  <rect x="60" y="348" width="760" height="76" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="80" y="370" fill="#15803d" font-size="11" font-weight="bold">5. DATABASE (only reached by real keys + rare false positives)</text>
  <text x="80" y="390" fill="#166534" font-size="9">FOUND &#8594; populate positive cache (jittered TTL), return value.</text>
  <text x="80" y="408" fill="#166534" font-size="9">NOT FOUND &#8594; populate NEGATIVE cache (short-TTL sentinel), return "not found". On CREATE: add to filter + delete sentinel.</text>
  <path d="M440,336 L440,348" stroke="#475569" stroke-width="1.5" marker-end="url(#p1)"/>
</svg>
```

## 5. Implementation

Go with `github.com/redis/go-redis/v9`. First a null-caching read-through, then a Bloom-filter guard using RedisBloom's `BF.*` commands (issued via the generic `Do`), then the create-time sync that defeats the newly-created-key race.

```go
package penetration

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"time"

	"github.com/redis/go-redis/v9"
)

// sentinel is the value we store to mean "confirmed absent". It must be a value
// that a real record can never take. An empty string is risky (a real value
// might be empty); a distinctive magic marker is safer.
const sentinel = "\x00__NULL__\x00"

var ErrNotFound = errors.New("not found")

// Loader fetches from the origin. It returns ErrNotFound (not a nil value) so
// that "absent" is unambiguous and distinct from "empty value".
type Loader func(ctx context.Context, id int64) (string, error)

type Guard struct {
	rdb        *redis.Client
	load       Loader
	valueTTL   time.Duration // TTL for real values
	nullTTL    time.Duration // SHORT TTL for sentinels (bounds the create race)
	maxID      int64         // largest id ever issued: cheap validation bound
	bloomKey   string        // RedisBloom filter of all existing ids
}

func NewGuard(rdb *redis.Client, load Loader, maxID int64) *Guard {
	return &Guard{
		rdb:      rdb,
		load:     load,
		valueTTL: 10 * time.Minute,
		nullTTL:  30 * time.Second, // deliberately short: see the create race below
		maxID:    maxID,
		bloomKey: "exists:users",
	}
}

// ---------------------------------------------------------------------------
// 1. NULL-CACHING read-through. A miss that the DB confirms is absent is cached
//    as a sentinel with a SHORT TTL, so the next identical miss is absorbed by
//    the cache instead of hitting the DB again.
// ---------------------------------------------------------------------------

func (g *Guard) Get(ctx context.Context, id int64) (string, error) {
	// Layer 1: VALIDATION. An id outside the issued range cannot exist, so we
	// reject it with zero cache/DB work. This alone defeats naive sequential
	// enumeration of impossible ids (user:-1, user:999999999).
	if id <= 0 || id > g.maxID {
		return "", ErrNotFound
	}

	key := fmt.Sprintf("user:%d", id)

	// Layer 2+3: read the cache. A hit is either a real value or a sentinel.
	switch v, err := g.rdb.Get(ctx, key).Result(); {
	case err == nil && v == sentinel:
		return "", ErrNotFound // negative cache hit: absorbed, no DB call
	case err == nil:
		return v, nil // positive cache hit
	case !errors.Is(err, redis.Nil):
		return "", err // a real Redis error
	}

	// Miss. Hit the origin.
	val, err := g.load(ctx, id)
	if errors.Is(err, ErrNotFound) {
		// Cache the ABSENCE as a sentinel with a SHORT TTL. Short because if this
		// id is created a moment later we do not want to serve "not found" for
		// long — and because an attacker enumerating distinct missing ids would
		// otherwise fill the cache with sentinels and evict real data.
		_ = g.rdb.Set(ctx, key, sentinel, g.nullTTL).Err()
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}

	// Real value: cache with a JITTERED TTL (avalanche prevention, chapter 17).
	_ = g.rdb.Set(ctx, key, val, jitter(g.valueTTL)).Err()
	return val, nil
}

// ---------------------------------------------------------------------------
// 2. BLOOM-FILTER GUARD (RedisBloom). Before the DB read, ask the filter. A
//    "definitely not present" answer lets us skip the DB entirely — the key was
//    never stored. go-redis has no typed BF.* helpers, so we use the generic Do.
// ---------------------------------------------------------------------------

// bfExists returns true if the key MIGHT exist (BF.EXISTS returned 1) and false
// only when it DEFINITELY does not (returned 0). Because a Bloom filter has no
// false negatives, a false result is authoritative: skip the DB.
func (g *Guard) bfExists(ctx context.Context, id int64) (bool, error) {
	// BF.EXISTS returns integer 1 (maybe present) or 0 (definitely absent).
	res, err := g.rdb.Do(ctx, "BF.EXISTS", g.bloomKey, id).Int()
	if err != nil {
		return true, err // on filter error, FAIL OPEN: assume present, do the DB read
	}
	return res == 1, nil
}

// GetGuarded is Get with the Bloom filter added as layer 4. The filter is
// consulted only after the caches miss, and short-circuits the DB read for
// keys it can prove were never stored.
func (g *Guard) GetGuarded(ctx context.Context, id int64) (string, error) {
	if id <= 0 || id > g.maxID {
		return "", ErrNotFound
	}
	key := fmt.Sprintf("user:%d", id)

	switch v, err := g.rdb.Get(ctx, key).Result(); {
	case err == nil && v == sentinel:
		return "", ErrNotFound
	case err == nil:
		return v, nil
	case !errors.Is(err, redis.Nil):
		return "", err
	}

	// Layer 4: BLOOM FILTER. If the filter is CERTAIN the key was never added,
	// skip the DB. Note we FAIL OPEN on filter errors so a filter outage degrades
	// to plain null-caching rather than dropping real reads.
	if maybe, err := g.bfExists(ctx, id); err == nil && !maybe {
		// Definitely absent. Write a short sentinel so even the filter lookup is
		// skipped next time, and return not-found without touching the DB.
		_ = g.rdb.Set(ctx, key, sentinel, g.nullTTL).Err()
		return "", ErrNotFound
	}

	// "Possibly present" (real key or rare false positive): do the real lookup.
	val, err := g.load(ctx, id)
	if errors.Is(err, ErrNotFound) {
		_ = g.rdb.Set(ctx, key, sentinel, g.nullTTL).Err() // false positive: cache absence
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	_ = g.rdb.Set(ctx, key, val, jitter(g.valueTTL)).Err()
	return val, nil
}

// ---------------------------------------------------------------------------
// 3. CREATE-TIME SYNC. When a new record is created we MUST (a) add it to the
//    Bloom filter so future reads are not wrongly short-circuited, and (b)
//    delete any negative-cache sentinel for it, or reads would keep returning
//    "not found" until the sentinel's TTL expired (the newly-created-key race).
// ---------------------------------------------------------------------------

func (g *Guard) OnCreate(ctx context.Context, id int64, value string) error {
	key := fmt.Sprintf("user:%d", id)

	// (a) Register the key in the Bloom filter. BF.ADD is idempotent.
	if err := g.rdb.Do(ctx, "BF.ADD", g.bloomKey, id).Err(); err != nil {
		return fmt.Errorf("bloom add: %w", err)
	}

	// (b) Invalidate any sentinel. If a read null-cached this id as absent moments
	// before it was created, deleting the sentinel makes the new value visible
	// immediately instead of after nullTTL. This is the fix for the create race.
	if err := g.rdb.Del(ctx, key).Err(); err != nil {
		return fmt.Errorf("invalidate sentinel: %w", err)
	}

	// Optionally warm the positive cache so the first read after create is a hit.
	return g.rdb.Set(ctx, key, value, jitter(g.valueTTL)).Err()
}

// ---------------------------------------------------------------------------
// One-off: (re)build the filter from the source of truth. BF.RESERVE sizes the
// filter for an expected capacity and a target false-positive rate; sizing it
// right up front avoids costly scaling later.
// ---------------------------------------------------------------------------

func (g *Guard) InitFilter(ctx context.Context, expectedItems int64, fpRate float64, allIDs []int64) error {
	// BF.RESERVE key error_rate capacity — provisions m and k for the target FP
	// rate at the given capacity. e.g. 10M items @ 0.01 ~= ~12 MB.
	if err := g.rdb.Do(ctx, "BF.RESERVE", g.bloomKey, fpRate, expectedItems).Err(); err != nil {
		// "item exists" just means it is already reserved; ignore that case.
		if err.Error() != "ERR item exists" {
			return err
		}
	}
	// BF.MADD adds many items in one round trip — far cheaper than one call each.
	args := make([]any, 0, len(allIDs)+2)
	args = append(args, "BF.MADD", g.bloomKey)
	for _, id := range allIDs {
		args = append(args, id)
	}
	return g.rdb.Do(ctx, args...).Err()
}

func jitter(base time.Duration) time.Duration {
	delta := (rand.Float64()*0.2 - 0.1) * float64(base)
	return base + time.Duration(delta)
}
```

The key production details are in the comments: fail *open* on filter errors (a filter outage must degrade to plain null-caching, never drop real reads), keep the sentinel TTL short, and — the most-missed detail — delete the sentinel *and* add to the filter on create, or you will serve "not found" for a record that exists.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Null-caching is trivial and effective.** A few lines convert repeat misses on non-existent keys into cache hits, absorbing the bulk of benign penetration.
- **Validation is free protection.** Rejecting structurally-impossible keys stops the crudest enumeration with no cache or database cost at all.
- **Bloom filters are extremely compact.** Membership for tens of millions of keys in megabytes, answering "definitely absent" without a database round trip.
- **Composable and fail-safe.** The three layers stack, and a Bloom-filter or negative-cache failure degrades gracefully rather than causing incorrect results.

**Disadvantages**
- **Null-caching consumes memory under attack.** Millions of distinct missing keys become millions of sentinels; without a short TTL and bounded key space they can evict real data.
- **The newly-created-key race.** A null entry masks a key created just after it was cached, until the sentinel expires — needs invalidation-on-create to fix.
- **Bloom filters cannot delete (plainly).** Removing a key from a standard Bloom filter is impossible; deletions need rebuilding, TTLs, or a cuckoo filter.
- **False positives fall through.** A Bloom "possibly present" for a non-existent key still costs one database lookup — rare, but non-zero, and rises as the filter fills.

**Trade-offs**
- *Null-caching vs Bloom filter:* null-caching remembers *specific* absences cheaply but scales with the number of distinct missing keys and adds a create race; a Bloom filter covers *all* absences in fixed memory but needs building, syncing, and tolerates false positives. Use null-caching for a modest missing-key set, add a Bloom filter when the missing key space is large or adversarial.
- *Bloom vs cuckoo filter:* Bloom is simpler and slightly more space-efficient at low false-positive rates but cannot delete; a cuckoo filter supports deletion and lookups at similar rates, at some extra complexity. Choose cuckoo when real keys are deleted often enough that a stale "possibly present" matters.
- *False-positive rate vs memory:* a lower rate means fewer wasted lookups but more bits; size the filter to the capacity you actually expect, because an over-full filter's false-positive rate degrades sharply.
- *Sentinel TTL:* short bounds the create-race window and the memory blast radius but absorbs fewer repeats; long absorbs more but masks new keys longer and holds more memory. Short plus invalidate-on-create is the usual answer.

## 7. Common Mistakes & Best Practices

- **No absence handling at all.** The default cache-aside code caches only values, so every request for a non-existent key is a database query — the exact hole penetration exploits. **Best practice:** null-cache confirmed absences with a short TTL.
- **A sentinel that collides with a real value.** Using empty-string or `nil` as the "absent" marker breaks when a real value can also be empty. **Best practice:** use a distinctive magic sentinel that a real value can never take.
- **Long-lived null entries.** A generous sentinel TTL masks newly-created keys and lets an attacker fill the cache with sentinels. **Best practice:** keep the null TTL short and invalidate the sentinel on create.
- **Forgetting to sync the Bloom filter on writes.** A new key not added to the filter gets a false "definitely absent" and becomes invisible until the filter is rebuilt — a correctness bug, not just a performance one. **Best practice:** add to the filter (and delete the sentinel) inside the create path, transactionally with the write where possible.
- **Failing *closed* on filter errors.** Treating a Bloom-filter outage as "definitely absent" drops real reads. **Best practice:** fail *open* — on any filter error, assume "possibly present" and do the real lookup.
- **Under-sizing the filter.** A Bloom filter loaded past its reserved capacity has a false-positive rate far above target, silently letting penetration back through. **Best practice:** `BF.RESERVE` for the real expected capacity (or use a scaling filter) and monitor fill.
- **Using a Bloom filter where keys are frequently deleted.** Deletes cannot be reflected, so deleted keys keep testing "possibly present". **Best practice:** use a cuckoo filter (`CF.*`) when deletions are common, or lean on TTL-based rebuilds.
- **Best practice overall: layer validation, null-cache and filter, and fail safe.** Reject the impossible, remember specific absences, prove general absence — and make every layer degrade to a correct (if slower) answer.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** Penetration shows as a database read-rate that is high while the *positive* cache hit-rate looks healthy — the misses are all for keys that legitimately return nothing, so they never appear as "cache evictions" or "value misses". Break out miss-rate by *outcome* (found vs not-found); a high not-found miss-rate is the tell. `BF.INFO` reports a filter's size, capacity, and number of items so you can see how full it is and whether its false-positive rate has degraded.
- **Monitoring.** Track: not-found lookups per second reaching the database, negative-cache hit-rate (should be high under attack), Bloom-filter fill ratio and estimated false-positive rate, and sentinel memory footprint. Alert when not-found database reads spike (an attack or a filter that has fallen out of sync) or when the filter approaches its reserved capacity.
- **Security.** Penetration is frequently *deliberate*: an attacker enumerates non-existent keys precisely to bypass the cache and load the database, a denial-of-service vector. Combine these defences with request rate-limiting per client, tight input validation (the cheapest layer), and — critically — with stampede protection (chapter 15), because forced misses on an uncacheable key are how an attacker turns penetration into a stampede. Do not leak, via timing or error detail, whether a key exists, or you hand the attacker an oracle.
- **Scaling.** A single Bloom filter is a Redis key and therefore lives on one Cluster slot — a very hot or very large filter concentrates on one node. RedisBloom's scaling Bloom filters (`BF.RESERVE ... EXPANSION`) grow by chaining sub-filters, at some read cost; for extreme scale, shard the filter by key-prefix so each shard's filter is separately sized and located. Null-cache sentinels distribute naturally across the keyspace like any other keys, but their short TTL and eviction interplay must be watched so an attack cannot evict the working set (a `volatile-*` eviction policy that only evicts keys with a TTL can help here).

## 9. Interview Questions

**Q: What is cache penetration and how is it different from a cache stampede?**
A: Cache penetration is when requests for keys that *do not exist* bypass the cache — there is no value to cache, so every such request misses and hits the origin, which also finds nothing, and nothing gets cached, so the next identical request repeats the journey. A stampede (chapter 15) is different: it is about a key that *does* exist but has expired, where many concurrent requests miss *simultaneously* and all recompute the same value at once. Penetration is a *steady* leak of never-cacheable misses (often malicious enumeration); stampede is a *burst* of correlated misses on one real key at its expiry. Penetration is fixed by remembering absence (null-caching, Bloom filters); stampede by coalescing the herd (locking, singleflight, SWR).

**Q: How does null-caching work and what is its main risk?**
A: On a miss where the origin confirms the key is absent, you cache a distinctive sentinel value meaning "confirmed not found" with a short TTL. The next request for that key hits the cache and returns "not found" without touching the origin, so repeat misses are absorbed like any other cache hit. Its main risk is the newly-created-key race: if you null-cache `user:42` as absent and `user:42` is created a moment later, reads keep returning "not found" until the sentinel's TTL expires. You mitigate with a *short* sentinel TTL to bound the staleness window and, more robustly, by explicitly deleting the sentinel when the key is created. A secondary risk is memory: an attacker enumerating millions of distinct missing keys makes you store millions of sentinels, so the short TTL and a bounded key space also protect against cache pollution.

**Q: Explain how a Bloom filter can be certain a key is absent but not certain it is present.**
A: A Bloom filter is an m-bit array with k hash functions. Adding an element sets the k bits its hashes point to; testing checks those k bits. If *any* of the k bits is 0, the element was definitely never added — because adding it would have set that bit — so a negative answer is certain: **no false negatives**. If *all* k bits are 1, the element is only *possibly* present, because those bits could have been set to 1 by *other* elements' hashes, not by this one — a false positive. So the structure is certain about negatives and hopeful about positives. That is exactly the asymmetry penetration defence needs: populate the filter with keys that exist, and a "definitely absent" answer lets you skip the database safely, while the rare false positive costs only one harmless lookup that correctly returns nothing.

**Q: Why is the false-positive-only nature of a Bloom filter safe for penetration defence?**
A: Because a false positive causes a *wasted but correct* action, never an incorrect one. If the filter says "possibly present" for a key that does not exist, you fall through to the real database lookup, which correctly returns "not found" — you did one unnecessary query, but the answer is right. If instead the filter could produce false *negatives* — saying "absent" for a key that exists — you would wrongly skip the lookup and return "not found" for a real record, a correctness bug. Bloom filters guarantee no false negatives, so the only cost of imperfection is the occasional wasted lookup, which is exactly the thing you were trying to reduce and can tune down by enlarging the filter.

**Q: What is a cuckoo filter and when would you prefer it over a Bloom filter?**
A: A cuckoo filter is a Bloom-like probabilistic membership structure that additionally supports *deletion*. Instead of setting bits, it stores a short *fingerprint* of each item in a cuckoo hash table with two candidate buckets per item; deletion removes the fingerprint. You prefer it over a Bloom filter when real keys are deleted often enough that a standard Bloom filter's inability to remove them matters — with a plain Bloom filter, a deleted key keeps testing "possibly present" forever (or until you rebuild the whole filter), so its false-positive population only grows. A cuckoo filter reflects deletions immediately, at comparable false-positive rates and lookup cost, with slightly more implementation complexity and some sensitivity to being filled near capacity. RedisBloom exposes both (`BF.*` and `CF.*`).

**Q: How do you keep a Bloom filter in sync with the source of truth?**
A: Add every newly-created key to the filter in the create path, ideally as close to atomically with the database write as you can manage (or via an outbox/CDC stream so a failed add is retried). Because a plain Bloom filter cannot delete, handle deletions one of three ways: accept the false "possibly present" for deleted keys (harmless — it just costs a lookup that returns not-found), periodically rebuild the filter from the source of truth (cheap with `BF.MADD` in batches), or use a cuckoo filter that supports removal. On startup and after schema changes, rebuild from the authoritative store, sizing with `BF.RESERVE` for the real capacity. Crucially, if a key is missing from the filter it becomes *invisible* (false "definitely absent"), so the create-time add is a correctness requirement, not an optimisation.

**Q: How do you choose the sentinel value, and why not just use an empty string or nil?**
A: The sentinel must be a value a *real* record can never legitimately take, because its entire job is to be unambiguously distinguishable from a genuine value on read. An empty string or `nil` is dangerous precisely because a real value might also be empty — a user with no display name, a config with a blank field — so you could not tell "confirmed absent" from "present but empty", and you would either serve a false not-found for a real empty value or fail to absorb a genuine miss. The safe choice is a distinctive magic marker (a byte sequence with sentinels around it, a reserved prefix, or a typed wrapper in your serialization) that your domain values provably cannot produce. You then check for that exact marker before treating a cache hit as a real value, and you keep its TTL short so an accidental collision or a create race has a bounded blast radius.

**Q: (Senior) Design end-to-end defence for a public API under a key-enumeration attack.**
A: I would layer from cheapest to most powerful and make every layer fail safe. Outermost, per-client rate-limiting and structural *validation* — reject ids outside the issued range, malformed uuids, or failed checksums with no cache or database work; this defeats the crudest sequential enumeration for free and removes most of the volume. Next, a *Bloom filter* of all existing ids, consulted after the cache misses: a "definitely absent" answer short-circuits the database, so even a flood of valid-format-but-nonexistent ids never reaches it; I size the filter with `BF.RESERVE` for real capacity at a target false-positive rate, sync it on create, and *fail open* so a filter outage degrades to null-caching rather than dropping real reads. Behind that, *null-caching* with a short sentinel TTL catches the false positives and any keys the filter cannot cover, absorbing repeats. I would use a `volatile-*` eviction policy so an attacker's flood of sentinels cannot evict the real working set. I would make sure error responses and timings do not reveal whether a key exists (no oracle), and I would pair all of this with stampede protection (chapter 15), because otherwise an attacker can force misses on an uncacheable key and turn penetration into a thundering herd. Finally I would monitor not-found database reads and filter fill ratio, alerting on either spiking. The design principle: reject the impossible, prove general absence, remember specific absence, and never let a defence's failure become a correctness bug.

**Q: (Senior) What are the memory and correctness trade-offs of choosing null-caching versus a Bloom filter, and when do you use both?**
A: Null-caching remembers *specific* absences: memory scales with the number of *distinct* missing keys you have seen, which is fine for a bounded, mostly-benign missing set but is exactly the wrong shape under an enumeration attack, where distinct missing keys are effectively unbounded and each becomes a sentinel — so it needs short TTLs and eviction discipline. Its correctness cost is the newly-created-key race, fixed by invalidate-on-create. A Bloom filter remembers *all* absences implicitly in *fixed* memory regardless of how many distinct missing keys are queried, which is precisely what an adversarial workload needs, but it costs building and syncing, tolerates false positives, and cannot delete plainly — and a missing-from-filter key is a correctness bug (invisible record), so the sync is mandatory. You use both together in production: the Bloom filter handles the vast adversarial absence space in constant memory and skips the database, while a short-TTL negative cache absorbs the filter's false positives and covers the window while the filter is being rebuilt or has fallen out of sync. Each covers the other's weakness — the filter bounds memory under attack, the null cache bounds the correctness blast radius of a filter that is momentarily wrong.

**Q: (Senior) Your Bloom filter starts returning "possibly present" far more often than its configured rate. What happened?**
A: The most likely cause is that the filter is *over capacity* — it holds more items than the `n` it was reserved for. A Bloom filter's false-positive rate is only the configured value at or below its reserved capacity; past that, as more bits get set to 1, the probability that any given set of k bits is all-1 climbs steeply, so the effective false-positive rate degrades well beyond target and more non-existent keys "possibly present" through to the database. I would confirm with `BF.INFO`, comparing the item count to the reserved capacity. Fixes: rebuild the filter with a correctly-sized `BF.RESERVE` for the true capacity (and headroom), switch to a *scaling* Bloom filter (`EXPANSION`) that chains sub-filters as it grows — accepting a slightly higher read cost and rate — or shard the filter by key-prefix so each shard is separately sized. A second, subtler cause is *deletions*: if real keys have been deleted but the filter cannot remove them, their bits linger and inflate false positives over time, which argues for a cuckoo filter or periodic rebuilds. Either way the symptom — false positives above target — means the database is doing more not-found lookups than the design intended, so I would treat it as a penetration-defence regression and alert on filter fill ratio going forward.

## 10. Quick Revision & Cheat Sheet

| Defence | What it remembers | Cost | Fails how |
|---|---|---|---|
| Validation | structurally-impossible keys | ~zero | rejects impossible ids up front |
| Null-caching | specific confirmed absences | memory per distinct miss | short TTL + invalidate on create |
| Bloom filter | all existing keys (implicitly) | fixed (~12 MB / 10M @ 1%) | false positives; can't delete |
| Cuckoo filter | existing keys, deletable | slightly more than Bloom | supports delete; near-full sensitivity |

| Bloom filter fact | Value |
|---|---|
| False negatives | never (a "no" is certain) |
| False positives | possible (a "yes" is a maybe) |
| Structure | m-bit array + k hash functions |
| Add | set k bits |
| Test | all k bits set? maybe : definitely-no |
| RedisBloom | `BF.RESERVE`, `BF.ADD/MADD`, `BF.EXISTS`, `BF.INFO` |

**Flash cards**
- **Penetration in one line?** → Requests for non-existent keys bypass the cache (nothing to hit) and always reach the origin.
- **Cheapest defence?** → Input validation — reject structurally-impossible keys.
- **Null-caching risk?** → Masks a newly-created key until the sentinel expires; fix with short TTL + invalidate-on-create.
- **Bloom guarantee?** → No false negatives; "definitely absent" is safe to trust and skip the DB.
- **Bloom weakness?** → Can't delete; false positives rise if over-filled.
- **Need deletes?** → Cuckoo filter (`CF.*`).
- **On filter error?** → Fail *open* (assume present, do the real lookup).

## 11. Hands-On Exercises & Mini Project

- [ ] Build a cache-aside read path with no absence handling and hammer it with requests for non-existent ids; confirm every one hits the database.
- [ ] Add null-caching with a sentinel and short TTL; confirm repeat misses are absorbed and measure the database read reduction.
- [ ] Demonstrate the newly-created-key race: null-cache an id, create it, and show reads returning "not found" until you delete the sentinel on create.
- [ ] Stand up RedisBloom, `BF.RESERVE` a filter, `BF.MADD` your existing ids, and add the filter as a guard; confirm non-existent ids skip the database.
- [ ] Over-fill the filter past its reserved capacity and measure the false-positive rate climbing above target with `BF.INFO`.
- [ ] Swap the Bloom filter for a cuckoo filter, delete some keys, and show the filter reflecting the deletion where a Bloom filter could not.

### Mini Project — "Penetration-Proof Lookup Service"

**Goal.** Build a read service that stays flat under an enumeration attack, and measure how each defence layer reduces database load.

**Requirements.**
1. A `Get(id)` endpoint backed by a database and a Redis cache, with a synthetic attacker that requests non-existent ids at a configurable rate.
2. Implement the four layers: input validation, positive cache, negative (null) cache with a short sentinel TTL, and a RedisBloom guard synced on create.
3. Under identical attack load, chart database read-rate for each combination of layers enabled (none, +validation, +null-cache, +Bloom) and show it collapsing.
4. Implement create-time sync (add to filter, delete sentinel, warm cache) and prove the newly-created-key race is gone.
5. Size the Bloom filter with `BF.RESERVE`, then deliberately over-fill it and chart the false-positive rate degrading; show a rebuild restoring it.

**Extensions.**
- Add a cuckoo filter variant and compare memory, false-positive rate, and delete behaviour against the Bloom filter across scales.
- Combine with chapter 15's stampede protection and show an attacker being unable to convert forced misses into a thundering herd.
- Shard the Bloom filter by key-prefix and demonstrate it avoiding a single-node hotspot on Redis Cluster.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Cache Stampede (Thundering Herd) & Mitigations* (correlated misses on real keys), *Hot Keys, Cache Avalanche & Sharding the Hot Key* (mass expiry and single-node hotspots), *HyperLogLog, Bitmaps & Probabilistic Caching* (the wider family of probabilistic structures), *Cache-Aside, Read-Through & Write Patterns* (the read path these defences wrap), *Security: Auth, ACLs & Hardening* (rate-limiting and not leaking existence).

- **RedisBloom — Bloom & Cuckoo filters** — Redis · *Intermediate* · the module reference for `BF.*` and `CF.*`, including `BF.RESERVE` sizing and scaling filters. <https://redis.io/docs/latest/develop/data-types/probabilistic/bloom-filter/>
- **Space/Time Trade-offs in Hash Coding with Allowable Errors** — Burton H. Bloom (1970) · *Advanced* · the original Bloom filter paper; the source of the structure and its error analysis. <https://dl.acm.org/doi/10.1145/362686.362692>
- **Cuckoo Filter: Practically Better Than Bloom** — Fan, Andersen, Kaminsky, Mitzenmacher · *Advanced* · the paper introducing cuckoo filters and their deletion support. <https://www.cs.cmu.edu/~dga/papers/cuckoo-conext2014.pdf>
- **Redis — Probabilistic data types overview** — Redis · *Intermediate* · when to reach for Bloom, cuckoo, count-min sketch and top-k, with memory/accuracy trade-offs. <https://redis.io/docs/latest/develop/data-types/probabilistic/>
- **Bloom Filters by Example** — Bill Mill · *Beginner* · an interactive visual explainer of bit arrays and k hashes; the intuition behind §3. <https://llimllib.github.io/bloomfilter-tutorial/>
- **Cache penetration, breakdown and avalanche (the three classic failures)** — Alibaba Cloud / engineering write-ups · *Intermediate* · the canonical framing of the three cache failure modes and their fixes. <https://www.alibabacloud.com/blog/cache-penetration-cache-breakdown-and-cache-avalanche_599150>
- **Designing Data-Intensive Applications, ch. 3** — Martin Kleppmann · *Advanced* · storage and indexing context, including Bloom filters in LSM-tree read paths. <https://dataintensive.net/>
- **Redis University — RU330 & RedisBloom courses** — Redis · *Intermediate* · free hands-on material for the probabilistic modules and operational sizing. <https://university.redis.com/>

---

*Caching with Redis Handbook — chapter 16.*
