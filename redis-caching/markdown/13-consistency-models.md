# 13 · Consistency Models: Stale Reads & Read-Your-Writes

> **In one line:** A cache is eventually consistent by its very nature, so the useful question is never "is it consistent?" but "how *wide* is the staleness window, what guarantees do I owe each user, and which reads must I route around the cache to keep those promises?"

---

## 1. Overview

The word *consistency* gets used loosely around caches, usually to mean "is the cache showing the right value?". That framing sets you up to fail, because the honest answer for any cache is *not always* — a cache is a copy of authoritative state, and a copy is, by definition, sometimes behind. The productive move is to stop asking whether the cache is consistent and start asking *which consistency model* it offers: what a reader is guaranteed to observe, and under what timing.

This chapter reasons about the consistency a cache can and cannot provide. It starts from the base fact — a cache is **eventually consistent**: after a write, reads *converge* on the new value, but there is a window in which they may not — and then makes that precise by bounding the **staleness window**. Under TTL-only invalidation the window is the TTL; under active invalidation it is the propagation delay. From there it works through the specific guarantees applications actually need. **Read-your-writes** (a user must see their *own* write immediately, even if others see it late) is the one users notice most viscerally — nothing feels more broken than saving a change and having it vanish on refresh. **Monotonic reads** (a reader never sees time go *backwards*) is the guarantee replication quietly breaks when a lagging replica serves a read after a fresher one did.

The reason this matters is that replication adds a *second* source of staleness on top of the cache's own. A read from a lagging replica can be older than the cache, so the two staleness windows compound. A serious cache design assigns each data type a **staleness budget** and then chooses invalidation, TTL, and read-routing to fit within it — treating consistency as a *budget to spend* rather than a property to either have or lack. That reframing is the whole chapter.

## 2. Core Concepts

- **Consistency model** — the contract describing what values a reader is guaranteed to observe relative to writes and to other reads. Not one thing; a family of increasingly strong guarantees.
- **Eventual consistency** — after writes stop, all reads *eventually* return the latest value; in the meantime they may return stale values. The default a cache provides.
- **Staleness window** — the maximum time a read may return a value older than the latest committed write. The single most useful number to bound.
- **Read-your-writes (read-your-own-writes)** — a session guarantee: a user always sees the effect of their *own* prior writes, even if other users see it only later.
- **Monotonic reads** — a session guarantee: successive reads never go *backwards* in time; once you have seen a value, you never see an older one.
- **Cache coherence** — whether multiple caches (and cache tiers) agree with each other and with the source of truth at a point in time.
- **Replication lag** — the delay between a write committing on the primary and being visible on a replica; a second, independent source of staleness.
- **Strong consistency / linearizability** — every read returns the latest write as if there were a single copy; what a cache *cannot* offer without giving up being a cache.
- **Staleness budget** — the maximum staleness a given data type is allowed to exhibit, set by the business, against which you size TTL and invalidation.
- **Read-through-to-primary** — deliberately bypassing the cache (and replicas) for reads that require a stronger guarantee than the cache can give.

## 3. Theory & Principles

### A cache is eventually consistent by nature

The moment you keep a copy of authoritative data and serve reads from it, you have accepted eventual consistency. The authority (the database) can change at any instant; the copy (the cache) learns of the change only later — when its TTL expires and it refetches, or when an invalidation reaches it. Between the write and that moment, the cache serves the old value. This is not a bug to be fixed; it is the *definition* of a cache. A cache that was always perfectly current with the database would be doing a synchronous round trip to the database on every read, which is to say it would not be a cache.

So the design question is never "how do I make the cache strongly consistent" — you cannot, not without destroying the point of it — but "how do I *bound and manage* the inevitable staleness". That reframing is liberating: it turns an unsolvable problem (perfect consistency) into a tractable one (an acceptable, quantified staleness window).

### Bounding the staleness window

The staleness window is the maximum age a cached read can have relative to the latest write. Its size depends entirely on your invalidation strategy (chapter 12):

- **Under TTL-only:** the window is *the TTL*. A value written just after the cache was populated is invisible to readers until the TTL expires and the next read refetches. Worst case: nearly the full TTL. This is a clean, predictable bound — you literally choose your maximum staleness by choosing the TTL.
- **Under active invalidation (delete-on-write / event-driven):** the window collapses to the *propagation delay* of the invalidation — how long it takes the delete or the invalidation event to reach the cache and take effect. On a single Redis instance this is sub-millisecond; through an event pipeline it is the consumer lag; across a CDN it is the purge propagation time.
- **Under a resurrection race (chapter 12):** the window can *silently exceed* both of the above, because a mid-flight reader can repopulate a stale value after the invalidation — which is exactly why a TTL backstop matters even when you actively invalidate: it re-imposes an upper bound the race would otherwise remove.

The practical upshot: you can always state a number. "This data is stale for at most 60 seconds" (TTL-only, 60s TTL) or "at most the invalidation lag, bounded by a 5-minute TTL backstop" (active + backstop). A design that cannot state that number does not understand its own consistency.

```svg
<svg viewBox="0 0 880 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The staleness window: how wide, and bounded by what?</text>

  <line x1="60" y1="80" x2="820" y2="80" stroke="#94a3b8" stroke-width="2"/>
  <text x="60" y="70" fill="#475569" font-size="9">t = write commits</text>
  <line x1="60" y1="72" x2="60" y2="88" stroke="#dc2626" stroke-width="2"/>
  <text x="440" y="70" text-anchor="middle" fill="#475569" font-size="9">time &#8594;</text>

  <rect x="60" y="96" width="500" height="40" rx="6" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="310" y="121" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">TTL-only: stale reads possible for the WHOLE TTL</text>
  <line x1="560" y1="90" x2="560" y2="142" stroke="#16a34a" stroke-width="2"/>
  <text x="560" y="156" text-anchor="middle" fill="#15803d" font-size="9">TTL expires &#8594; refetch &#8594; fresh</text>

  <rect x="60" y="176" width="70" height="40" rx="6" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="95" y="201" text-anchor="middle" fill="#15803d" font-size="9" font-weight="bold">delete</text>
  <text x="200" y="201" fill="#166534" font-size="10">Active invalidation: window = invalidation propagation delay (often sub-ms on one instance)</text>

  <rect x="60" y="256" width="360" height="40" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="240" y="281" text-anchor="middle" fill="#92400e" font-size="10" font-weight="bold">Event-driven: window = consumer / propagation LAG</text>
  <text x="440" y="281" fill="#b45309" font-size="9">the lag IS the staleness &#8212; monitor it</text>

  <rect x="60" y="336" width="640" height="40" rx="6" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="380" y="361" text-anchor="middle" fill="#5b21b6" font-size="10" font-weight="bold">Resurrection race: window can SILENTLY exceed all of the above &#8212; bounded only by the TTL backstop</text>
  <line x1="700" y1="330" x2="700" y2="382" stroke="#16a34a" stroke-width="2"/>
  <text x="700" y="396" text-anchor="middle" fill="#15803d" font-size="9">TTL backstop re-imposes a bound</text>

  <text x="60" y="416" fill="#334155" font-size="10" font-weight="bold">Design rule: you must be able to STATE the number. "Stale for at most N." A design that can't state N doesn't understand its own consistency.</text>
</svg>
```

### Read-your-writes: the guarantee users feel

Eventual consistency is tolerable for *other people's* data — you rarely notice that someone else's change took a few seconds to appear. It is intolerable for *your own* data. If a user edits their profile, hits save, and the page reloads showing the old value, the app looks broken, even though it is behaving exactly as an eventually consistent cache should. **Read-your-writes** is the session guarantee that a user always observes the effect of their own prior writes. It is not global consistency — other users may still see the old value briefly — it is *per-session* freshness for the writer.

Techniques to provide it, from cheapest to strongest:

- **Invalidate/update the writer's cache on their write**, so their very next read misses and refetches (or reads the value you just wrote through). On a single shared cache this is often enough — the write path deletes the key, the reader refills.
- **Route the writer's reads to the primary for a short window** after their write (a "read-your-writes window"). For a few seconds after a user writes, their reads bypass the cache and any replica and go to the primary, guaranteeing they see their own change; everyone else keeps hitting the cache.
- **Write-through the user's own cache** (or a per-user near cache) so their local copy is updated synchronously with the write, making their next read trivially fresh.
- **Sticky routing** so a user's requests hit the same instance/replica that has their write, avoiding a lagging replica that has not yet received it.
- **A short per-user TTL** on their own entries, so even if nothing else fires, their stale window is tiny.

The design instinct: *read-your-writes is a session property, so solve it in the session*, not by making the whole cache strongly consistent. You spend the cost (a primary read, a sticky route) only on the writer, only briefly.

### Monotonic reads and the second staleness source

Replication introduces a guarantee cache-only reasoning misses. **Monotonic reads** says that once a session has observed a value, it never subsequently observes an *older* one — reads move forward in time, never backwards. Replication breaks this trivially: a user reads a fresh value from replica A, then their next read is routed to replica B, which is lagging and returns an *older* value. Time appears to go backwards; a comment they just saw disappears. Nothing is corrupt — B simply hasn't caught up — but the experience is jarring and, for some data, incorrect.

This matters because **replication lag is a second, independent source of staleness stacked on top of the cache's own**. Your read might be stale because the cache is behind the primary *and* because the replica the cache refilled from is behind the primary. The two windows compound. Fixes for monotonic reads are again *session-scoped*: sticky routing (a session always reads the same replica, so it never regresses), or tracking the write position (the session carries the log position of its last read and only reads from a replica caught up to at least that position). The general principle repeats: replication makes staleness worse and less predictable, so if you route cache refills or reads through replicas, you must reason about lag as explicitly as you reason about TTL.

## 4. Architecture & Workflow

### Choosing a per-data-type staleness budget

Consistency is not one setting for the whole system; it is a *per-data-type budget*. The workflow:

1. **Classify each cached data type by its staleness tolerance.** A price or an inventory count near zero: seconds or tighter. A permission/entitlement change: often must be near-immediate for security. A user's own profile: read-your-writes required, but others can lag. A product description or marketing copy: minutes is fine. An aggregate/analytics number: often *very* tolerant, minutes to hours.
2. **Set the TTL and invalidation strategy to fit the budget.** Tight budget → active invalidation with a short TTL backstop, possibly read-through-to-primary for the writer. Loose budget → TTL-only with a comfortable TTL and no invalidation machinery at all.
3. **Decide read routing per guarantee.** Reads that need read-your-writes get routed to primary (or the writer's cache) briefly after a write. Reads that need monotonic behaviour get sticky routing or write-position tracking. Everything else reads the cache.
4. **State the resulting guarantee explicitly** so downstream engineers know what they can rely on: "profiles are read-your-writes for the owner, eventually consistent (≤30s) for others."

```svg
<svg viewBox="0 0 880 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="cm1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#64748b"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Consistency as a per-data-type budget, spent on read-routing</text>

  <rect x="30" y="44" width="820" height="150" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="66" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Staleness budget by data type (tightest &#8594; loosest)</text>

  <rect x="48" y="80" width="150" height="96" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="123" y="100" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">Permissions</text>
  <text x="123" y="118" text-anchor="middle" fill="#991b1b" font-size="9">near-immediate</text>
  <text x="123" y="136" text-anchor="middle" fill="#991b1b" font-size="9">event-driven +</text>
  <text x="123" y="152" text-anchor="middle" fill="#991b1b" font-size="9">tiny/no TTL</text>
  <text x="123" y="170" text-anchor="middle" fill="#64748b" font-size="8">security-critical</text>

  <rect x="212" y="80" width="150" height="96" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="287" y="100" text-anchor="middle" fill="#92400e" font-size="10" font-weight="bold">Price / stock</text>
  <text x="287" y="118" text-anchor="middle" fill="#b45309" font-size="9">seconds</text>
  <text x="287" y="136" text-anchor="middle" fill="#b45309" font-size="9">active invalidation</text>
  <text x="287" y="152" text-anchor="middle" fill="#b45309" font-size="9">+ short TTL</text>
  <text x="287" y="170" text-anchor="middle" fill="#64748b" font-size="8">money-sensitive</text>

  <rect x="376" y="80" width="150" height="96" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="451" y="100" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">Own profile</text>
  <text x="451" y="118" text-anchor="middle" fill="#166534" font-size="9">read-your-writes</text>
  <text x="451" y="136" text-anchor="middle" fill="#166534" font-size="9">route writer to</text>
  <text x="451" y="152" text-anchor="middle" fill="#166534" font-size="9">primary briefly</text>
  <text x="451" y="170" text-anchor="middle" fill="#64748b" font-size="8">others may lag</text>

  <rect x="540" y="80" width="150" height="96" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="615" y="100" text-anchor="middle" fill="#1e40af" font-size="10" font-weight="bold">Descriptions</text>
  <text x="615" y="118" text-anchor="middle" fill="#1d4ed8" font-size="9">minutes</text>
  <text x="615" y="136" text-anchor="middle" fill="#1d4ed8" font-size="9">TTL-only</text>
  <text x="615" y="152" text-anchor="middle" fill="#1d4ed8" font-size="9">no machinery</text>
  <text x="615" y="170" text-anchor="middle" fill="#64748b" font-size="8">low sensitivity</text>

  <rect x="704" y="80" width="130" height="96" rx="6" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="769" y="100" text-anchor="middle" fill="#5b21b6" font-size="10" font-weight="bold">Aggregates</text>
  <text x="769" y="118" text-anchor="middle" fill="#6d28d9" font-size="9">minutes&#8211;hours</text>
  <text x="769" y="136" text-anchor="middle" fill="#6d28d9" font-size="9">long TTL</text>
  <text x="769" y="152" text-anchor="middle" fill="#6d28d9" font-size="9">very tolerant</text>
  <text x="769" y="170" text-anchor="middle" fill="#64748b" font-size="8">analytics</text>

  <rect x="30" y="210" width="820" height="196" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="440" y="232" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">Read routing decides which guarantee a read gets</text>

  <rect x="60" y="248" width="150" height="50" rx="6" fill="#fff" stroke="#2563eb"/>
  <text x="135" y="270" text-anchor="middle" fill="#1e40af" font-size="10" font-weight="bold">Incoming read</text>
  <text x="135" y="288" text-anchor="middle" fill="#1d4ed8" font-size="9">for user U, key K</text>

  <path d="M210,273 L266,273" stroke="#64748b" stroke-width="1.5" marker-end="url(#cm1)"/>
  <rect x="268" y="240" width="230" height="66" rx="6" fill="#fff" stroke="#16a34a"/>
  <text x="383" y="262" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">Did U write K in the last few seconds?</text>
  <text x="383" y="282" text-anchor="middle" fill="#166534" font-size="9">YES &#8594; read PRIMARY (read-your-writes)</text>
  <text x="383" y="298" text-anchor="middle" fill="#166534" font-size="9">NO  &#8594; read cache</text>

  <path d="M498,273 L554,273" stroke="#64748b" stroke-width="1.5" marker-end="url(#cm1)"/>
  <rect x="556" y="240" width="270" height="66" rx="6" fill="#fff" stroke="#7c3aed"/>
  <text x="691" y="262" text-anchor="middle" fill="#5b21b6" font-size="10" font-weight="bold">Cache read needs monotonic behaviour?</text>
  <text x="691" y="282" text-anchor="middle" fill="#6d28d9" font-size="9">sticky replica / track last-read position</text>
  <text x="691" y="298" text-anchor="middle" fill="#6d28d9" font-size="9">so reads never regress on a lagging replica</text>

  <rect x="60" y="322" width="766" height="70" rx="8" fill="#fefce8" stroke="#ca8a04" stroke-width="2"/>
  <text x="443" y="344" text-anchor="middle" fill="#854d0e" font-size="11" font-weight="bold">The compounding hazard</text>
  <text x="78" y="364" fill="#713f12" font-size="9">Staleness source 1: the cache is behind the primary (bounded by TTL / invalidation lag).</text>
  <text x="78" y="380" fill="#713f12" font-size="9">Staleness source 2: the replica the cache refilled from is behind the primary (replication lag). The two windows ADD UP.</text>
</svg>
```

### Where the cache sits relative to replicas

If your cache refills by reading a *replica* rather than the primary, every cached value inherits the replica's lag at refill time. So a "5-second-stale" TTL on top of a replica lagging 3 seconds is really *up to 8 seconds* stale relative to the primary. For tight budgets, refill from the primary; for loose budgets, refilling from a replica is a fine way to offload the primary, as long as you count the lag in your budget.

## 5. Implementation

Go with `github.com/redis/go-redis/v9`, implementing the two guarantees applications most need: a read-your-writes window that routes a writer's reads to the primary, and monotonic reads via a tracked read position. Comments explain the *why*.

```go
package consistency

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// ---------------------------------------------------------------------------
// READ-YOUR-WRITES via a per-user "recently wrote" marker.
//
// After a user writes, we set a short-lived marker key. While that marker
// exists, the user's reads BYPASS the cache and any replica and go straight to
// the primary, guaranteeing they observe their own write. Everyone else keeps
// reading the cache, so we pay the primary-read cost ONLY for the writer, ONLY
// briefly. This is read-your-writes solved as a SESSION property, not by making
// the whole cache strongly consistent.
// ---------------------------------------------------------------------------

// rywWindow is how long after a write a user's reads are pinned to the primary.
// It should comfortably exceed the cache-invalidation + replication propagation
// so that by the time the window closes, the cache/replica have caught up.
const rywWindow = 5 * time.Second

func rywMarker(userID, key string) string {
	return fmt.Sprintf("ryw:%s:%s", userID, key)
}

// OnUserWrite records that userID just wrote `key`, opening their RYW window.
// The caller has already committed to the primary; this only manages routing.
func OnUserWrite(ctx context.Context, rdb *redis.Client, userID, key string) error {
	// A tiny value with a short TTL: presence == "route this user to primary".
	return rdb.Set(ctx, rywMarker(userID, key), 1, rywWindow).Err()
}

// ReadForUser returns the value for `key`, honouring read-your-writes for the
// user who recently wrote it. `primary` reads the source of truth; the cache is
// used only when the user is NOT in their RYW window.
func ReadForUser(
	ctx context.Context,
	rdb *redis.Client,
	primary *sql.DB,
	userID, key string,
	fromCache func() (string, bool, error), // (value, hit, err)
	fromPrimary func() (string, error),
) (string, error) {
	// Is this user inside their read-your-writes window for this key?
	inWindow, err := rdb.Exists(ctx, rywMarker(userID, key)).Result()
	if err != nil {
		return "", err
	}
	if inWindow == 1 {
		// Bypass cache AND replica: read the primary so they see their own write.
		return fromPrimary()
	}

	// Normal path: try the cache, fall back to primary on a miss and refill.
	if val, hit, err := fromCache(); err != nil {
		return "", err
	} else if hit {
		return val, nil
	}
	return fromPrimary()
}

// ---------------------------------------------------------------------------
// MONOTONIC READS via a tracked read position.
//
// Replication can make reads go BACKWARDS: read fresh from replica A, then read
// stale from lagging replica B. We prevent regression by having each session
// carry the highest version/position it has observed, and refusing to accept a
// cached/replica value older than that. If the candidate is behind, we escalate
// to the primary (which is never behind).
// ---------------------------------------------------------------------------

// VersionedValue is a value stamped with the source-of-truth version it
// reflects (e.g. a monotonically increasing row version or WAL position).
type VersionedValue struct {
	Value   string
	Version int64
}

// MonotonicRead returns a value whose version is >= the session's last-seen
// version, so the session never observes time going backwards. `lastSeen` is
// the session's high-water mark, carried between requests (cookie, session store).
func MonotonicRead(
	ctx context.Context,
	lastSeen int64,
	fromCacheOrReplica func() (VersionedValue, bool, error),
	fromPrimary func() (VersionedValue, error),
) (VersionedValue, int64, error) {
	candidate, hit, err := fromCacheOrReplica()
	if err != nil {
		return VersionedValue{}, lastSeen, err
	}
	// Accept the candidate only if it is at least as fresh as what this session
	// has already seen. Otherwise the candidate is a REGRESSION — reject it.
	if hit && candidate.Version >= lastSeen {
		return candidate, candidate.Version, nil
	}
	// The cache/replica is behind the session's high-water mark (or missed):
	// escalate to the primary, which cannot be behind.
	fresh, err := fromPrimary()
	if err != nil {
		return VersionedValue{}, lastSeen, err
	}
	// Advance the session's high-water mark so future reads never regress below it.
	newSeen := fresh.Version
	if lastSeen > newSeen {
		newSeen = lastSeen
	}
	return fresh, newSeen, nil
}

// ---------------------------------------------------------------------------
// Helper: a cache read that also surfaces the version, so the caller can reason
// about monotonicity. Returns (value, hit, err); redis.Nil is a clean miss.
// ---------------------------------------------------------------------------

func CachedVersioned(ctx context.Context, rdb *redis.Client, key string) (VersionedValue, bool, error) {
	// We store value and version in a hash so one HGETALL yields both atomically.
	m, err := rdb.HGetAll(ctx, key).Result()
	if err != nil {
		return VersionedValue{}, false, err
	}
	if len(m) == 0 {
		return VersionedValue{}, false, nil // miss
	}
	var v int64
	_, scanErr := fmt.Sscanf(m["version"], "%d", &v)
	if scanErr != nil {
		return VersionedValue{}, false, errors.New("corrupt version in cache")
	}
	return VersionedValue{Value: m["value"], Version: v}, true, nil
}
```

The two mechanisms share a philosophy: consistency guarantees are *session-scoped*, so you provide them by routing a specific session's reads (to the primary for read-your-writes, past stale replicas for monotonic reads) rather than by trying to make the shared cache globally strong.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **A precise, statable guarantee.** Bounding the staleness window turns "the cache might be wrong" into "stale for at most N seconds", which downstream code can rely on.
- **Cheap strong guarantees where needed.** Read-your-writes and monotonic reads are provided per-session, so you pay the cost only for the sessions that need it, only briefly.
- **Budget-driven design.** Assigning each data type a staleness budget lets you use TTL-only where it is fine and reserve machinery for where it is not.
- **Honest about replication.** Explicitly counting replication lag as a second staleness source prevents the classic "why is my read older than my write" surprise.

**Disadvantages**
- **You cannot get strong consistency and keep a cache.** Any read that must be linearizable has to bypass the cache, forfeiting its benefit for that read.
- **Session routing adds state.** Read-your-writes windows and monotonic high-water marks are per-session state that must be carried and stored.
- **Compounding windows are easy to miss.** Refilling the cache from a lagging replica silently widens the staleness window beyond the TTL.
- **More guarantees, more complexity.** Sticky routing, write-position tracking and primary-read escalation are all moving parts that can fail.

**Trade-offs**
- *Staleness vs cost:* a tighter staleness budget means more active invalidation and more primary reads; a looser budget means more cache offload. Choose per data type, not globally.
- *Read-your-writes routing vs cache hit ratio:* routing the writer to the primary guarantees they see their write but skips the cache for those reads; keep the window short so the hit-ratio cost is negligible.
- *Refill from primary vs replica:* refilling from a replica offloads the primary but adds its lag to your staleness window; refilling from the primary is fresher but heavier. Match to the budget.
- *Global strong consistency vs a cache at all:* you can have a linearizable read or a cached read, not both for the same read. Decide which reads genuinely need linearizability and cache the rest.

## 7. Common Mistakes & Best Practices

- **Claiming the cache is "consistent" without a number.** Consistency is a window, not a boolean. *Best practice: state the staleness budget and the mechanism that bounds it for every cached data type.*
- **Ignoring read-your-writes.** Users tolerate others' data lagging but not their own vanishing on refresh. *Best practice: give writers a short read-your-writes window (route them to primary or update their cache) after every write.*
- **Refilling the cache from a lagging replica and forgetting the lag.** The cached value is then stale by TTL *plus* the replica lag at refill time. *Best practice: count replication lag in the staleness budget, or refill from the primary for tight budgets.*
- **Assuming replicas give monotonic reads.** Routing successive reads to different replicas can make time go backwards. *Best practice: use sticky routing or a tracked read position for sessions that need monotonic reads.*
- **One consistency setting for the whole system.** Permissions and marketing copy do not have the same staleness budget. *Best practice: set the budget per data type and let it drive TTL, invalidation and routing.*
- **Trying to make the cache strongly consistent.** You will either destroy its performance benefit or build a fragile edifice that still races. *Best practice: accept eventual consistency, bound it, and bypass the cache for the few reads that truly need linearizability.*
- **Forgetting the resurrection race silently widens the window.** Active invalidation without a TTL backstop can exceed your stated budget. *Best practice: keep a TTL backstop so the window is bounded even when a delete is raced (chapter 12).*

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** When a user reports "my change didn't save", the question is *which guarantee broke*. Check whether their write opened a read-your-writes window and whether their read honoured it; check whether the read hit a lagging replica (compare the read's version/timestamp against the primary's). A read older than a prior read in the same session points at a monotonic-reads violation from replica hopping. Reproduce by pinning reads to a deliberately lagged replica.
- **Monitoring.** The staleness window under event-driven invalidation *is* the consumer lag, so monitor and alert on it directly. Track **replication lag** on every replica you read from, because it adds to the window. Track the **read-your-writes bypass rate** (how often reads route to primary) — a spike means either a write storm or a mis-sized window hurting your hit ratio. Track cache hit ratio alongside, since consistency mechanisms trade against it.
- **Security.** Consistency and security intersect at *permission and entitlement caches*. A stale "allow" is a security hole — a user who lost access keeps it until the cache catches up — so entitlement data usually needs a near-zero staleness budget: event-driven invalidation, tiny or no TTL, and read-your-writes on revocation so the change takes effect immediately for the affected session. Treat revocations as the tight case; grants can tolerate more lag.
- **Scaling.** Consistency mechanisms shape how you scale reads. Read-your-writes routing to the primary caps how much you can offload writers' reads onto replicas/cache, so keep the window tight. Sticky routing for monotonic reads constrains load balancing (a session is pinned), so weigh it against even load distribution. As you add replicas to scale reads, lag variance grows and both monotonic reads and the compounded staleness window get harder — which is why write-position tracking (carry the last-seen log position, only read replicas caught up to it) scales better than naive sticky routing at high replica counts.

## 9. Interview Questions

**Q: Is a cache strongly or eventually consistent, and why?**
A: Eventually consistent, by its very nature. The moment you serve reads from a copy of authoritative data, the authority can change while the copy is unaware, so reads return the old value until the copy learns of the change — via TTL expiry or an invalidation. A cache that was always perfectly current would be doing a synchronous round trip to the database on every read, which is not a cache at all. So you cannot make a cache strongly consistent without destroying its purpose; the real work is bounding and managing the inevitable staleness, not eliminating it.

**Q: What is the staleness window and what bounds it?**
A: The staleness window is the maximum time a cached read can return a value older than the latest committed write. Under TTL-only invalidation it is bounded by the TTL — worst case a write lands just after a refill and is invisible until the TTL expires. Under active invalidation it collapses to the propagation delay of the delete or event (sub-millisecond on one Redis instance, the consumer lag through an event pipeline). A resurrection race can silently exceed both, which is why a TTL backstop matters even with active invalidation — it re-imposes an upper bound. The key discipline is that you should always be able to state the number.

**Q: What is read-your-writes and why do users care about it so much?**
A: Read-your-writes is a session guarantee that a user always observes the effect of their own prior writes, even if other users see them only later. Users care viscerally because eventual consistency is fine for other people's data but feels broken for their own — saving a profile edit and seeing the old value on refresh looks like the app lost the change. It is not global consistency; it is per-session freshness for the writer, so you provide it cheaply: invalidate/update the writer's cache on their write, or route their reads to the primary for a few seconds after they write, while everyone else keeps reading the cache.

**Q: How do you implement read-your-writes with a cache?**
A: Solve it as a session property. The simplest robust approach is a short read-your-writes window: when a user writes, record a short-lived marker (e.g. a Redis key with a few-seconds TTL), and while that marker exists, route that user's reads for that data to the primary, bypassing the cache and any replica so they always see their own write. Cheaper variants: update or delete the writer's cache entry synchronously with the write so their next read is fresh; use a per-user near cache written through on the write; or use sticky routing so the user hits the instance/replica that has their write. You pay the primary-read cost only for the writer and only briefly, rather than making the whole cache strongly consistent.

**Q: What are monotonic reads and how does replication break them?**
A: Monotonic reads guarantee that once a session has observed a value, it never subsequently observes an older one — reads move forward in time. Replication breaks it easily: a session reads a fresh value from replica A, then its next read is routed to replica B which is lagging and returns an older value, so time appears to go backwards and something the user just saw disappears. Nothing is corrupt — B simply hasn't caught up. Fixes are session-scoped: sticky routing so a session always reads the same replica and never regresses, or carrying the last-read log position and only reading from a replica caught up to at least that position, escalating to the primary otherwise.

**Q: How does replication lag interact with cache staleness?**
A: It adds a second, independent source of staleness on top of the cache's own. If the cache refills by reading a replica, the cached value inherits the replica's lag at refill time, so a value with a 5-second TTL sitting on top of a replica lagging 3 seconds is up to 8 seconds stale relative to the primary — the two windows compound. This is easy to miss because you reason about the TTL and forget the replica. For tight staleness budgets, refill the cache from the primary; for loose budgets, refilling from a replica is a fine way to offload the primary as long as you count the lag in your budget.

**Q: How do you decide the TTL for a piece of cached data?**
A: From its staleness budget — the maximum staleness the business tolerates for that data type. Classify the data: permissions and money-sensitive values (price, stock) get tight budgets and thus short TTLs plus active invalidation; a user's own data needs read-your-writes but others can lag; descriptions and marketing copy tolerate minutes; aggregates and analytics tolerate minutes to hours. Set the TTL to fit the budget, tightening it with active invalidation only where the budget demands, and remember to include any replication lag if you refill from a replica. TTL is not a guess; it is the staleness budget expressed as a number.

**Q: (Senior) Walk through designing the consistency guarantees for a system with a shared Redis cache in front of a primary with read replicas.**
A: I would treat consistency as a per-data-type budget and provide guarantees per session rather than globally. First I classify data by staleness tolerance and set TTL plus invalidation accordingly: permissions get event-driven invalidation with a tiny TTL and immediate effect on revocation; prices get active invalidation with a short TTL backstop; profiles are read-your-writes for the owner and eventually consistent for others; descriptions and aggregates are TTL-only with generous TTLs. For read-your-writes I open a short window on each write during which the writer's reads bypass the cache and replicas to the primary; the window is sized to comfortably exceed invalidation plus replication propagation, so by the time it closes the cache and replicas have caught up. For monotonic reads I carry a per-session high-water mark (the last-seen version or log position) and refuse cache/replica values older than it, escalating to the primary on a regression. Critically, I decide where the cache refills from: for tight budgets from the primary, for loose budgets from a replica while counting its lag in the budget. Then I state each guarantee explicitly — "prices ≤5s stale, permissions near-immediate with immediate revocation, profiles read-your-writes for the owner" — so downstream engineers know exactly what they can rely on, and I monitor replication lag and invalidation consumer lag because those *are* the staleness windows in practice.

**Q: (Senior) A user complains that a value they just saw sometimes disappears on the next page load. Diagnose it.**
A: The symptom — a value going backwards in time within one session — is a monotonic-reads violation, and the usual cause is replica hopping. The user's first read hit a fresher source (the primary, a caught-up replica, or a freshly-refilled cache), and the next read was routed to a lagging replica (or a cache refilled from one) that hasn't yet received the write, so it returns the older value. I would confirm by capturing the version/timestamp of the value on each read and showing the second read's version is lower than the first's, then checking replication lag on the replicas involved and whether the load balancer is spreading the session's reads across replicas rather than pinning them. There is often a compounding factor: if the cache refills from a replica, a stale refill can serve the old value even after the primary and other replicas caught up, widening the window. The fix is session-scoped: sticky routing so the session reads a consistent source, or carrying the last-seen position and only accepting values at least that fresh (escalating to the primary otherwise). I would also verify a TTL backstop is present so a raced invalidation can't pin the stale value indefinitely. The tell that distinguishes this from a lost write is that the data *reappears* later — nothing was lost; a lagging copy was briefly read.

**Q: (Senior) When is it correct to bypass the cache entirely for a read, and how do you decide?**
A: When the read requires a guarantee stronger than eventual consistency and the cost of a fresh read is justified — because you fundamentally cannot have both a linearizable read and a cached read for the same access. The clear cases: a read-your-writes read for a user inside their post-write window, where serving stale data looks like data loss; a security/entitlement check on a revocation, where a stale "allow" is a hole; a read that gates a money or inventory decision at the edge of correctness (the last item in stock, a balance before a transfer), where showing a stale value causes a real error. I decide by the data's staleness budget and the *consequence* of staleness: if a stale read merely shows slightly old content, cache it; if a stale read causes an incorrect action or a security failure, route it to the primary. The discipline is to bypass narrowly — for the specific reads and the specific sessions that need it — so the cache still absorbs the overwhelming majority of reads, rather than weakening the whole cache to satisfy a minority of strict reads.

## 10. Quick Revision & Cheat Sheet

| Guarantee | What it promises | How to provide it |
|---|---|---|
| Eventual consistency | reads converge after writes stop | the default; bound the window |
| Bounded staleness | stale for at most N | TTL (=N) or invalidation lag + TTL backstop |
| Read-your-writes | you see your own writes | route writer to primary briefly / update their cache |
| Monotonic reads | reads never go backwards | sticky replica / track last-seen position |
| Strong / linearizable | always the latest write | bypass the cache (and replicas) for that read |

| Staleness source | Bounded by |
|---|---|
| Cache behind primary | TTL, or invalidation propagation lag |
| Replica behind primary | replication lag (adds to the above) |
| Resurrection race | only the TTL backstop |

**Flash cards**
- **Cache consistency?** → Eventual by nature; bound the staleness window, don't try to eliminate it.
- **Staleness window under TTL-only?** → The TTL. Under active invalidation? → The propagation/consumer lag.
- **Read-your-writes?** → Writer sees their own write; route them to primary briefly after a write.
- **Monotonic reads?** → Reads never regress; broken by replica hopping; fix with sticky routing or last-seen position.
- **Second staleness source?** → Replication lag; it compounds with the cache's own window.
- **Consistency is a...?** → Per-data-type budget, spent on read-routing — not a global on/off switch.

## 11. Hands-On Exercises & Mini Project

- [ ] Cache a value with a 30s TTL and measure the actual observed staleness window by writing to the DB and polling reads until they flip.
- [ ] Reproduce a read-your-writes failure: write, then read from a cache that wasn't invalidated, and watch your own change vanish. Then add a read-your-writes window and show it fixed.
- [ ] Simulate two replicas with different lag and reproduce a monotonic-reads violation by alternating reads between them.
- [ ] Add last-seen-position tracking and show the session never regresses even when it hits the lagging replica.
- [ ] Refill a cache from a lagging replica and measure how the replica's lag adds to the TTL to widen the real staleness window.
- [ ] Assign three data types different staleness budgets and configure TTL/invalidation/routing for each; document the resulting guarantee.

### Mini Project — "Consistency Budget Lab"

**Goal.** Build a small service with a Redis cache in front of a primary and a lagged replica, and make each consistency guarantee — bounded staleness, read-your-writes, monotonic reads — observable and measurable.

**Requirements.**
1. Stand up a primary and a replica with a configurable, injectable replication lag, plus a Redis cache in front.
2. Implement per-data-type staleness budgets and set TTL/invalidation to fit each.
3. Implement a read-your-writes window that routes a writer's reads to the primary, and demonstrate the guarantee holds while others still see the old value.
4. Implement monotonic reads with a tracked last-seen position and demonstrate reads never regress even under replica hopping.
5. Measure and chart the actual staleness window for each strategy, including the compounding effect of refilling from the lagged replica.

**Extensions.**
- Add an entitlement/permission cache and demonstrate that a revocation takes effect immediately for the affected session (read-your-writes on revocation) while a stale "allow" would be a security hole.
- Introduce an invalidation event pipeline with tunable consumer lag and show the staleness window tracking the lag directly.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Design: Cache Invalidation Strategies* (the mechanisms that set the staleness window), *The Dual-Write Problem & Change Data Capture* (making invalidation follow the committed log so the window is predictable), *Replication, Sentinel & Failover* (where replication lag comes from), *Cache-Aside, Read-Through & Write Strategies* (the read/write paths these guarantees route), *TTL, Expiration & Eviction* (the TTL that bounds the simplest window).

- **Designing Data-Intensive Applications (ch. 5 & 9)** — Martin Kleppmann · *Advanced* · the definitive treatment of replication lag, read-your-writes, monotonic reads and consistency models. <https://dataintensive.net/>
- **Martin Kleppmann — "Please stop calling databases CP or AP" & consistency writing** — Martin Kleppmann · *Advanced* · sharp essays on what consistency terms actually mean, useful for reasoning precisely. <https://martin.kleppmann.com/>
- **Jepsen — Consistency models** — Kyle Kingsbury (Jepsen) · *Advanced* · a clear, rigorous map of the consistency-model hierarchy from eventual to linearizable. <https://jepsen.io/consistency>
- **Redis — Replication** — Redis · *Intermediate* · how async replication works and why replicas lag, the source of the second staleness window. <https://redis.io/docs/latest/operate/oss_and_stack/management/replication/>
- **Redis — Client-side caching & tracking** — Redis · *Advanced* · server-driven invalidation that tightens the staleness window for client caches. <https://redis.io/docs/latest/develop/use/client-side-caching/>
- **AWS — Read-your-writes & replica lag in RDS/Aurora** — AWS · *Intermediate* · practical guidance on read-after-write consistency when reading from replicas. <https://aws.amazon.com/builders-library/>
- **Werner Vogels — Eventually Consistent** — Werner Vogels (ACM Queue) · *Intermediate* · the classic essay introducing eventual consistency and session guarantees to a broad audience. <https://queue.acm.org/detail.cfm?id=1466448>
- **Redis University — RU301 (Running Redis) & RU101** — Redis · *Intermediate* · free courses covering replication, expiry and the operational reality behind these consistency choices. <https://university.redis.com/>

---

*Caching with Redis Handbook — chapter 13.*
