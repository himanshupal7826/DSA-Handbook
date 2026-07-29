# 06 · Keys, TTL & Expiration Semantics

> **In one line:** Every cache entry must carry a TTL — not as a convenience but as a correctness safety net — and to reason about your cache you have to know the uncomfortable truth that an "expired" Redis key can still occupy memory and still be logically present until something reaps it.

---

## 1. Overview

Two things about Redis keys separate a cache that behaves from one that surprises you. The first is *naming*: a flat, unstructured keyspace becomes unmanageable, while a disciplined convention — namespaced, colon-delimited, versioned — makes your cache inspectable, invalidatable, and safe to shard. The second is *expiration*, and it is more subtle than it looks. Everyone knows `EXPIRE key 60` sets a sixty-second lifetime. Far fewer know *how* Redis actually removes the key when that time passes — and the answer, that expiration is both **lazy** and **active**, has real consequences for memory, for correctness, and for how you interpret metrics.

This chapter covers the mechanics you need to wield TTLs correctly: the family of commands (`SET ... EX/PX`, `EXPIRE`/`PEXPIRE`/`EXPIREAT`, `TTL`/`PTTL`, `PERSIST`, `GETEX`), the `NX`/`XX`/`GT`/`LT` conditions that let you set expiry safely without clobbering, and — the heart of the chapter — exactly how Redis expires a key. Because Redis is single-threaded (chapter 3), it cannot afford a timer per key firing precisely at expiry; that would be enormous overhead. Instead it uses two cheaper mechanisms working together: it removes an expired key *lazily* when someone touches it, and it *actively* samples and reaps expired keys in the background. Understanding this pair explains a whole class of otherwise-baffling observations — why memory does not drop the instant a key expires, why `TTL` can report a key as gone before `used_memory` reflects it, and why a replica must never expire keys on its own.

The governing principle, stated up front: **give every cache entry a TTL.** Not just the ones where expiry is the point, but *all* of them, because a TTL is the safety net that bounds the damage of a bug, a missed invalidation, or a poison value. A cache entry with no TTL is a memory leak and a stale-data landmine waiting to happen.

## 2. Core Concepts

- **Key** — the string that names a value; binary-safe, but by convention a structured, colon-delimited path like `user:9:profile`.
- **Namespace** — the leading segment(s) of a key that group related entries (`session:`, `cache:v2:`), enabling targeted inspection and invalidation.
- **TTL (time to live)** — the remaining lifetime of a key in seconds; `PTTL` is the same in milliseconds. A key with no expiry has a TTL of `-1`; a missing key reports `-2`.
- **`EXPIRE` / `PEXPIRE`** — set a *relative* expiry (seconds / milliseconds from now).
- **`EXPIREAT` / `PEXPIREAT`** — set an *absolute* expiry as a Unix timestamp.
- **`SET ... EX/PX`** — set value and expiry in one atomic command; the idiomatic way to write a cache entry.
- **`GETEX`** — read a key and adjust its TTL in the same atomic operation (extend, set, or clear expiry on read).
- **`PERSIST`** — remove a key's expiry, making it permanent (TTL becomes `-1`).
- **Lazy expiration** — an expired key is removed the moment a command touches it; the key is invisible to reads regardless.
- **Active expiration** — a background cycle that samples keys with TTLs and reaps the expired ones, so keys never accessed still get reclaimed.
- **`NX`/`XX`/`GT`/`LT`** — conditions on `EXPIRE`: only if no TTL exists / only if one exists / only if greater / only if less than the current TTL.

## 3. Theory & Principles

### Key naming is an interface, not an afterthought

A Redis keyspace is flat — there are no tables or folders — so the *only* structure your keys have is the structure you put in their names. The universal convention is **colon-delimited namespaces** that read like a path from general to specific: `user:9:profile`, `session:abc123`, `cache:product:42:reviews`. This is not cosmetic. A good scheme buys you three concrete capabilities. First, **inspectability**: `redis-cli --scan --pattern 'session:*'` finds every session without a full keyspace scan of unrelated data. Second, **targeted invalidation**: a clear prefix lets you reason about and (carefully, via `SCAN`) sweep a logical group. Third, **schema versioning**: baking a version into the prefix — `cache:v2:user:9` — lets you change a cached value's format by bumping the version, so old and new entries coexist and the old ones simply expire out, avoiding a decode error on a stale format after a deploy.

Two rules keep a scheme healthy. Keep keys reasonably short but readable — key names live in RAM too, and a million verbose keys add up, but obscure abbreviations cost more in confusion than they save in bytes. And put the high-cardinality, shardable identifier where a hash tag can wrap it if you will ever run Cluster (`user:{9}:profile`), so related keys can be co-located on one slot (chapter 26).

A third rule is about *cardinality*: be deliberate about what goes into a key name, because every distinct key is a distinct entry with its own overhead, and an unbounded key space is a slow memory leak even with TTLs. A key like `search:<free-text-query>` can generate millions of one-hit keys as users type novel queries — each cached once, never read again, expiring only via the active cycle. That is not wrong in itself (with a short TTL it self-limits), but you should choose it knowingly, because the alternative — bucketing or normalising the identifier so the key space stays bounded — is often better for both memory and hit rate. Naming decides not just *how* you address data but *how many* keys exist, which is a first-order memory concern (chapter 7).

### The commands: relative, absolute, and set-with-value

There are three ways to attach a lifetime, and choosing the right one avoids subtle bugs. `EXPIRE key 60` and `PEXPIRE key 60000` set a lifetime *relative to now*. `EXPIREAT key 1735689600` and `PEXPIREAT` set an *absolute* wall-clock deadline — invaluable when you want many keys to expire at the same instant (a daily rollover) regardless of when each was written, or when the deadline comes from an upstream system. And `SET key val EX 60` fuses the write and the expiry into one atomic command, which is strictly better than `SET` followed by `EXPIRE`: the two-command form has a window where, if the process crashes or the connection drops between them, the key exists *forever* with no TTL — the exact leak a TTL was meant to prevent. **Always set the TTL in the same command as the value.**

### How Redis actually expires a key: lazy + active

Here is the mechanism most people never learn, and it matters. A naive design would set a timer per key that fires exactly at expiry. Redis does not do this — millions of precise timers would be huge overhead on a single-threaded server. Instead, expiry is *logical*: when you set a TTL, Redis records the absolute expiry time in a table alongside the key, and the key is removed by two cooperating mechanisms.

**Lazy (passive) expiration:** every time a command accesses a key, Redis first checks whether it has passed its expiry time. If it has, Redis deletes it *then and there* and behaves as if the key did not exist (a `GET` returns nil, `EXISTS` returns 0). So from the perspective of *reads*, an expired key is always gone — you can never read a value past its TTL. The catch: if nothing ever touches an expired key, lazy expiration alone never removes it, and its memory is never reclaimed.

**Active expiration:** to reclaim keys that are never accessed, Redis runs a background cycle (roughly ten times a second) that samples a batch of keys *from the set that has TTLs*, deletes the expired ones, and — if more than a quarter of the sample were expired — repeats immediately, on the theory that many are due. This probabilistic sweep keeps the fraction of "logically expired but not yet reclaimed" keys low without scanning the whole keyspace.

The active cycle is deliberately *CPU-budgeted* so that reclaiming expired keys never itself becomes the thing that stalls the single thread. It runs as a fast, time-boxed pass (its effort tunable via `active-expire-effort`, 1–10, trading CPU for tighter reclamation) rather than an exhaustive scan — which is precisely why it is probabilistic and why a very large keyspace of never-accessed expired keys can lag. This is the same design philosophy as everything else in Redis: bound the work each pass does so no single operation can monopolise the event loop (chapter 3), and accept "good enough, eventually" over "exact, but blocking".

The crucial implication: **a key can be logically expired but still counted in `used_memory` until it is accessed (lazy) or the active cycle reaps it.** Expiry frees memory *eventually*, not instantaneously. This is why memory does not drop at the exact second a batch of keys expires, why a burst of same-TTL keys can leave a lingering memory bump, and why you should not treat "TTL reached" as "memory reclaimed". It is also why, when you need memory back *now*, `maxmemory` eviction (chapter 7) — which runs synchronously as part of processing a write — is the mechanism that actually enforces the ceiling, not expiration.

```svg
<svg viewBox="0 0 880 480" width="100%" height="480" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="e1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="e2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#d97706"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Two mechanisms remove an expired key &#8212; and neither is instant</text>

  <rect x="24" y="42" width="832" height="30" rx="6" fill="#f1f5f9" stroke="#64748b"/>
  <text x="440" y="62" text-anchor="middle" fill="#334155" font-size="10">Setting a TTL records an ABSOLUTE expiry time. The key is not deleted at that instant &#8212; it is removed later by one of two paths.</text>

  <rect x="24" y="86" width="404" height="200" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="226" y="108" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">Lazy (passive): on access</text>
  <rect x="44" y="122" width="150" height="30" rx="5" fill="#fff" stroke="#2563eb"/><text x="119" y="142" text-anchor="middle" fill="#1e40af" font-size="9">client: GET k</text>
  <path d="M194,137 L242,137" stroke="#2563eb" stroke-width="1.5" marker-end="url(#e1)"/>
  <rect x="246" y="122" width="160" height="30" rx="5" fill="#bfdbfe" stroke="#2563eb"/><text x="326" y="142" text-anchor="middle" fill="#1e3a8a" font-size="9">past expiry? delete NOW</text>
  <text x="44" y="176" fill="#1d4ed8" font-size="9.5">&#8226; The read sees nil / EXISTS 0 &#8212; the key is</text>
  <text x="54" y="192" fill="#1d4ed8" font-size="9.5">logically gone the instant it is touched.</text>
  <text x="44" y="214" fill="#1d4ed8" font-size="9.5">&#8226; Cost: if NOTHING ever touches the key,</text>
  <text x="54" y="230" fill="#1d4ed8" font-size="9.5">lazy alone NEVER reclaims its memory.</text>
  <text x="44" y="256" fill="#1e40af" font-size="9.5" font-weight="bold">Reads can never return an expired value.</text>
  <text x="44" y="274" fill="#1e40af" font-size="9.5" font-weight="bold">Memory is freed only when accessed.</text>

  <rect x="452" y="86" width="404" height="200" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="654" y="108" text-anchor="middle" fill="#92400e" font-size="12" font-weight="bold">Active: background sampling</text>
  <rect x="472" y="122" width="200" height="30" rx="5" fill="#fff" stroke="#d97706"/><text x="572" y="142" text-anchor="middle" fill="#92400e" font-size="9">~10&#215;/sec: sample keys with TTLs</text>
  <path d="M672,137 L708,137" stroke="#d97706" stroke-width="1.5" marker-end="url(#e2)"/>
  <rect x="712" y="122" width="124" height="30" rx="5" fill="#fde68a" stroke="#d97706"/><text x="774" y="142" text-anchor="middle" fill="#78350f" font-size="9">reap expired</text>
  <text x="472" y="176" fill="#b45309" font-size="9.5">&#8226; If &gt; 25% of the sample were expired,</text>
  <text x="482" y="192" fill="#b45309" font-size="9.5">repeat immediately (many are due).</text>
  <text x="472" y="214" fill="#b45309" font-size="9.5">&#8226; Reclaims keys that are NEVER accessed,</text>
  <text x="482" y="230" fill="#b45309" font-size="9.5">so they don't leak memory forever.</text>
  <text x="472" y="256" fill="#92400e" font-size="9.5" font-weight="bold">Probabilistic &#8212; keeps the "expired but</text>
  <text x="472" y="274" fill="#92400e" font-size="9.5" font-weight="bold">not yet reclaimed" fraction low, not zero.</text>

  <rect x="24" y="300" width="832" height="164" rx="10" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="440" y="322" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">The implication you must internalise</text>
  <text x="44" y="346" fill="#991b1b" font-size="10">A key can be LOGICALLY EXPIRED (reads return nil) yet still counted in used_memory until accessed or reaped.</text>
  <text x="44" y="368" fill="#991b1b" font-size="10">&#8594; Memory does NOT drop at the exact second a batch expires. A burst of same-TTL keys leaves a lingering bump.</text>
  <text x="44" y="390" fill="#991b1b" font-size="10">&#8594; "TTL reached" &#8800; "memory reclaimed". To enforce a ceiling NOW, maxmemory eviction does it (ch. 7), not expiry.</text>
  <text x="44" y="412" fill="#991b1b" font-size="10">&#8594; On a REPLICA, keys are NOT expired independently &#8212; the primary sends an explicit DEL/UNLINK when it expires one,</text>
  <text x="60" y="430" fill="#991b1b" font-size="10">so replicas stay consistent. A read of a logically-expired key on an old replica can briefly still see it.</text>
  <text x="44" y="454" fill="#b91c1c" font-size="10" font-weight="bold">Give every cache entry a TTL: it is the safety net that bounds staleness and memory when everything else fails.</text>
</svg>
```

### The overwrite trap: a plain `SET` clears the TTL

There is a quiet correctness bug lurking in the most ordinary operation. When you overwrite an existing key with a plain `SET key newval` — no `EX`, no `KEEPTTL` — Redis **removes any TTL the key had**, making it permanent. The reasoning is that a fresh `SET` is a new value, and Redis will not guess the new value should inherit the old lifetime. The trap is that a write path which *reads-modifies-writes* a cached value with a bare `SET` silently converts a well-behaved expiring key into an immortal one, and you will not notice until memory creeps or a stale value lives forever. There are two correct fixes: pass the TTL again on every write (`SET key newval EX ttl`), which is the cleanest because the lifetime is always explicit; or use `SET key newval KEEPTTL` to preserve the *existing* expiry across the overwrite. In-place mutations (`HSET`, `INCR`, `LPUSH`, `APPEND`) behave differently — they do *not* touch the TTL, so a key keeps its expiry across those — but the plain-`SET` overwrite is the one that catches people. The rule folds neatly into the chapter's thesis: since every write should carry a TTL anyway, `SET ... EX ttl` on every write sidesteps the trap entirely.

### Replicas do not expire keys on their own

One more consequence of the lazy+active model matters for correctness under replication. A **replica does not independently expire keys**. If it did, the primary and replica could disagree — the replica deleting a key the primary still considers live — producing inconsistent reads. Instead, the primary owns expiration: when the primary expires a key (lazily or actively), it propagates an explicit `DEL`/`UNLINK` to replicas. Until that arrives, a replica *logically* treats an expired key as gone for reads (it will not return the stale value to a client) but does not physically remove it. This is why an overloaded or lagging replica can hold expired keys in memory longer, and why expiration reasoning must always centre on the primary.

### Reacting to expiry: keyspace notifications and their catch

Sometimes you want to *do something* when a key expires — evict a dependent entry, clean up a resource, fire a metric. Redis offers **keyspace notifications**: enable them (`notify-keyspace-events Ex` for expired-key events) and Redis publishes a Pub/Sub message when a key is removed. The catch flows directly from the lazy+active model and is easy to get wrong: the notification fires when the key is **actually removed**, not when it *logically* expires. So a key that expired thirty seconds ago but has not yet been accessed (lazy) or sampled (active) generates its "expired" event only when the active cycle finally reaps it — the event can lag the logical expiry noticeably. Worse, keyspace notifications are fire-and-forget Pub/Sub with no delivery guarantee: a consumer that is disconnected at the moment of the event simply misses it. So they are fine for best-effort reactions (a cache-warming hint, a soft cleanup) but must never be your only mechanism for anything that requires correctness — for reliable expiry-driven work, prefer an explicit design (a sorted set of deadlines you poll, or a durable stream) over relying on the notification arriving.

## 4. Architecture & Workflow

The lifecycle of a cache entry from write to reclamation:

1. **Write with a TTL, atomically.** `SET key value EX ttl` stores the value and records an absolute expiry time in one command. There is never a window where the key exists without its TTL.
2. **Serve reads.** `GET`/`HGET`/etc. return the value. Each access first checks expiry (lazy path); if still live, the value is returned. If you want reads to *extend* the lifetime — a sliding session — use `GETEX key EX ttl` to read and refresh atomically.
3. **Expiry passes.** The absolute deadline is now in the past, but the key may still be resident. It is *logically* expired: any read returns nil.
4. **Reclamation, path A (lazy).** The next command that touches the key deletes it on the spot and reclaims its memory.
5. **Reclamation, path B (active).** If nothing touches it, the ~10 Hz background cycle eventually samples and reaps it. Memory returns then.
6. **Optional: cancel or change expiry.** `PERSIST key` removes the TTL (making it permanent — rare and risky for a cache). `EXPIRE key newttl` resets it, guarded by `NX`/`XX`/`GT`/`LT` when you must not clobber an existing TTL.

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="t1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">EXPIRE guards: NX / XX / GT / LT decide whether the new TTL applies</text>

  <rect x="330" y="44" width="220" height="46" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="440" y="64" text-anchor="middle" fill="#5b21b6" font-weight="bold">EXPIRE key ttl [flag]</text>
  <text x="440" y="82" text-anchor="middle" fill="#6d28d9" font-size="9">current TTL of key = ?</text>

  <rect x="30" y="130" width="190" height="110" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="125" y="152" text-anchor="middle" fill="#15803d" font-weight="bold">NX</text>
  <text x="46" y="174" fill="#166534" font-size="9.5">apply ONLY if the key has</text>
  <text x="46" y="190" fill="#166534" font-size="9.5">NO expiry yet (TTL = -1).</text>
  <text x="46" y="212" fill="#15803d" font-size="9" font-weight="bold">use: set a default TTL</text>
  <text x="46" y="228" fill="#166534" font-size="9">without ever shortening one.</text>

  <rect x="240" y="130" width="190" height="110" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="335" y="152" text-anchor="middle" fill="#1e40af" font-weight="bold">XX</text>
  <text x="256" y="174" fill="#1d4ed8" font-size="9.5">apply ONLY if the key</text>
  <text x="256" y="190" fill="#1d4ed8" font-size="9.5">already HAS an expiry.</text>
  <text x="256" y="212" fill="#1e40af" font-size="9" font-weight="bold">use: refresh an existing</text>
  <text x="256" y="228" fill="#1d4ed8" font-size="9">TTL, never add one.</text>

  <rect x="450" y="130" width="190" height="110" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="545" y="152" text-anchor="middle" fill="#92400e" font-weight="bold">GT</text>
  <text x="466" y="174" fill="#b45309" font-size="9.5">apply ONLY if new TTL is</text>
  <text x="466" y="190" fill="#b45309" font-size="9.5">GREATER than current.</text>
  <text x="466" y="212" fill="#92400e" font-size="9" font-weight="bold">use: extend-only, never</text>
  <text x="466" y="228" fill="#b45309" font-size="9">shorten (keep the longest).</text>

  <rect x="660" y="130" width="190" height="110" rx="8" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="755" y="152" text-anchor="middle" fill="#b91c1c" font-weight="bold">LT</text>
  <text x="676" y="174" fill="#991b1b" font-size="9.5">apply ONLY if new TTL is</text>
  <text x="676" y="190" fill="#991b1b" font-size="9.5">LESS than current.</text>
  <text x="676" y="212" fill="#b91c1c" font-size="9" font-weight="bold">use: shorten-only, never</text>
  <text x="676" y="228" fill="#991b1b" font-size="9">extend (tighten staleness).</text>

  <path d="M400,90 L150,126" stroke="#7c3aed" stroke-width="1.4" fill="none" marker-end="url(#t1)"/>
  <path d="M425,90 L340,126" stroke="#7c3aed" stroke-width="1.4" fill="none" marker-end="url(#t1)"/>
  <path d="M455,90 L540,126" stroke="#7c3aed" stroke-width="1.4" fill="none" marker-end="url(#t1)"/>
  <path d="M480,90 L740,126" stroke="#7c3aed" stroke-width="1.4" fill="none" marker-end="url(#t1)"/>

  <rect x="30" y="270" width="820" height="106" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="292" text-anchor="middle" fill="#334155" font-size="11" font-weight="bold">Why the guards matter for a cache</text>
  <text x="50" y="316" fill="#475569" font-size="10">&#8226; A blind EXPIRE from two code paths can fight: one wants 60s, another 3600s, and last-writer-wins gives you whichever ran last.</text>
  <text x="50" y="338" fill="#475569" font-size="10">&#8226; GT (extend-only) keeps a session alive across concurrent refreshes; LT (shorten-only) lets an invalidation TIGHTEN staleness safely.</text>
  <text x="50" y="360" fill="#475569" font-size="10">&#8226; NX sets a DEFAULT TTL on legacy keys that were written without one &#8212; the exact repair for a "key with no expiry" leak.</text>
</svg>
```

## 5. Implementation

```go
package expiry

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// SetWithTTL is the ONLY correct way to write a cache entry: value and TTL in
// ONE atomic command. Never SET then EXPIRE — a crash between them leaves an
// immortal key with no TTL, which is exactly the leak a TTL exists to prevent.
func SetWithTTL(ctx context.Context, rdb *redis.Client, key string, val []byte, ttl time.Duration) error {
	// go-redis maps SET key val EX <ttl> here; passing a zero ttl would mean
	// "no expiry", so we defend against it — every cache entry gets a TTL.
	if ttl <= 0 {
		return fmt.Errorf("refusing to cache %q with no TTL", key)
	}
	return rdb.Set(ctx, key, val, ttl).Err()
}

// SlidingSession reads a session and refreshes its TTL in ONE atomic round
// trip with GETEX. Doing GET then EXPIRE separately is two round trips and a
// race; GETEX fuses them, so an active session never expires mid-request.
func SlidingSession(ctx context.Context, rdb *redis.Client, sid string, idle time.Duration) ([]byte, error) {
	key := "session:" + sid
	// GETEX key EX <idle>: return the value AND slide the expiry forward.
	data, err := rdb.GetEx(ctx, key, idle).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil // session gone (expired or never existed)
	}
	return data, err
}

// PeekWithoutTouching reads a value WITHOUT changing its TTL. Plain GET does
// not alter expiry, so this is just GET — shown to contrast with GETEX, which
// DOES. (GETEX with PERSIST would instead CLEAR the TTL on read.)
func PeekWithoutTouching(ctx context.Context, rdb *redis.Client, key string) ([]byte, error) {
	return rdb.Get(ctx, key).Bytes()
}

// SetDefaultTTLIfMissing repairs a key that was written without an expiry — a
// legacy "immortal" key. EXPIRE ... NX applies the TTL ONLY if the key has no
// expiry yet, so we never accidentally shorten a key that already has one.
func SetDefaultTTLIfMissing(ctx context.Context, rdb *redis.Client, key string, ttl time.Duration) (bool, error) {
	// The 4th arg "NX" is the guard. Returns true only if the TTL was applied.
	return rdb.ExpireNX(ctx, key, ttl).Result()
}

// ExtendOnly bumps a TTL upward but NEVER shortens it — GT applies the new TTL
// only if it is greater than the current one. Two concurrent refreshers with
// different lifetimes then converge on the longest, instead of fighting.
func ExtendOnly(ctx context.Context, rdb *redis.Client, key string, ttl time.Duration) (bool, error) {
	return rdb.ExpireGT(ctx, key, ttl).Result()
}

// InspectTTL shows how to read remaining lifetime and interpret the sentinels.
// TTL returns: >0 seconds left; -1 the key exists but has NO expiry (a leak
// for a cache!); -2 the key does not exist. PTTL is the same in milliseconds.
func InspectTTL(ctx context.Context, rdb *redis.Client, key string) (string, error) {
	d, err := rdb.TTL(ctx, key).Result()
	if err != nil {
		return "", err
	}
	switch d {
	case -1 * time.Second: // go-redis maps Redis's -1 ("no expiry") to -1s
		return "EXISTS, NO TTL (leak risk — set one)", nil
	case -2 * time.Second: // and -2 ("no such key") to -2s
		return "MISSING", nil
	default:
		return fmt.Sprintf("%v remaining", d), nil
	}
}

// OverwritePreservingTTL avoids the "plain SET clears the TTL" trap. A bare
// SET on an existing key wipes its expiry, silently making a cache entry
// immortal. KEEPTTL preserves the existing lifetime across the overwrite; the
// even-safer alternative is to pass EX again on every write.
func OverwritePreservingTTL(ctx context.Context, rdb *redis.Client, key string, val []byte) error {
	// SET key val KEEPTTL — new value, SAME expiry as before.
	return rdb.Set(ctx, key, val, redis.KeepTTL).Err()
}

// ExpireAtRollover sets an ABSOLUTE deadline so a whole batch of keys expires
// at the same wall-clock instant (e.g. a daily cache rollover at midnight UTC),
// regardless of when each key was written. Relative EXPIRE cannot do this.
func ExpireAtRollover(ctx context.Context, rdb *redis.Client, key string, at time.Time) error {
	// EXPIREAT key <unix-timestamp>. Add jitter in real code to avoid a
	// thundering-herd of simultaneous expiries (the "avalanche", ch. 15).
	return rdb.ExpireAt(ctx, key, at).Err()
}
```

```bash
# The same semantics at the redis-cli, where they are easiest to see:
127.0.0.1:6379> SET page:home "<html>" EX 30      # value + 30s TTL, atomic
OK
127.0.0.1:6379> TTL page:home                     # -> (integer) 30
127.0.0.1:6379> PTTL page:home                    # -> (integer) 29873  (ms)
127.0.0.1:6379> GETEX page:home EX 60            # read AND extend to 60s
"<html>"
127.0.0.1:6379> GETEX page:home PERSIST          # read AND clear the TTL
"<html>"
127.0.0.1:6379> TTL page:home                     # -> (integer) -1  (now immortal!)
127.0.0.1:6379> EXPIRE page:home 60 NX           # NX: only if no TTL -> applies, ->1
127.0.0.1:6379> EXPIRE page:home 10 GT           # GT: 10<60, so NOT applied -> 0
127.0.0.1:6379> EXPIRE page:home 300 GT          # GT: 300>60, applied -> 1
127.0.0.1:6379> PERSIST page:home                 # remove TTL -> 1 (was set)
127.0.0.1:6379> TTL missingkey                    # -> (integer) -2  (no such key)
```

Every line encodes a rule from section 3: write value-and-TTL together, read-and-refresh atomically with `GETEX`, and guard `EXPIRE` with `NX`/`GT` so concurrent writers cannot clobber each other's lifetimes.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **TTLs bound staleness automatically.** A cache entry cannot serve stale data past its TTL, so even a missed invalidation self-heals within one lifetime.
- **Lazy + active expiration is cheap.** No per-key timers; the single thread spends only a small, bounded slice on the active cycle, keeping expiry off the hot path.
- **Atomic set-with-TTL is leak-proof.** `SET ... EX` guarantees a key never exists without its expiry, eliminating a whole class of immortal-key leaks.
- **Guards (`NX`/`XX`/`GT`/`LT`) make concurrent TTL changes safe.** Extend-only and set-if-missing semantics remove the last-writer-wins race on lifetimes.

**Disadvantages**
- **Expiry is eventual, not instant.** A logically expired key can still occupy memory until accessed or reaped, so expiry does not reliably free memory on time.
- **Never-accessed keys rely entirely on the active cycle.** Under a huge cold keyspace, reclamation lags, which can hold memory above what you expect.
- **Replicas lag on physical removal.** A replica keeps an expired key until the primary's `DEL` propagates, so memory accounting differs between roles.

**Trade-offs**
- *Relative (`EXPIRE`) vs absolute (`EXPIREAT`):* relative is the natural default; absolute is right when many keys must expire at one instant or the deadline comes from upstream — but absolute deadlines create synchronised expiries that need jitter to avoid an avalanche (chapter 15).
- *Long TTL vs short TTL:* longer TTLs raise hit rate but widen the staleness window and hold memory longer; shorter TTLs keep data fresh and memory tight but raise miss rate and origin load. Tune per key class by tolerance for staleness.
- *Sliding (`GETEX` refresh) vs fixed TTL:* sliding keeps active entries alive and is right for sessions, but means a hot key may never expire, so pair it with an absolute cap; fixed TTL is simpler and bounds lifetime unconditionally.

## 7. Common Mistakes & Best Practices

- **Caching without a TTL.** A key with no expiry is a memory leak and a stale-data landmine; if invalidation is ever missed, the value is wrong forever. **Best practice:** give *every* cache entry a TTL, as a safety net even when you also invalidate explicitly.
- **`SET` then `EXPIRE` in two commands.** A crash or drop between them leaves an immortal key. **Best practice:** use `SET key val EX ttl` so value and expiry are one atomic write.
- **Assuming memory frees the instant a key expires.** Expiry is lazy + active, so memory returns eventually, not on time. **Best practice:** rely on `maxmemory` eviction (chapter 7) to enforce a hard ceiling, and treat expiry as a staleness bound, not a memory guarantee.
- **Overwriting a key with a bare `SET`, wiping its TTL.** A plain `SET key newval` on an existing key removes its expiry, silently making a cache entry immortal. **Best practice:** pass `EX ttl` on every write, or use `KEEPTTL` to preserve the existing expiry.
- **Blind `EXPIRE` from multiple code paths.** Two writers with different TTLs produce last-writer-wins. **Best practice:** use `GT` (extend-only), `LT` (shorten-only), or `NX` (set-if-missing) to make the intent explicit and race-free.
- **Synchronised TTLs on a large batch.** Thousands of keys with the identical TTL expire together and stampede the origin (an avalanche). **Best practice:** add random jitter to TTLs (chapter 15).
- **Using `PERSIST` on cache entries.** Removing a TTL turns a cache entry immortal, reintroducing the leak. **Best practice:** avoid `PERSIST` for cached data; a cache value should always have a bounded life.
- **Reasoning about expiry on a replica.** Replicas do not expire independently and lag the primary's `DEL`. **Best practice:** centre expiration reasoning and memory accounting on the primary.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** `TTL key`/`PTTL key` tell you a key's remaining life and the two sentinels that matter: `-1` (exists, *no* TTL — a leak signal) and `-2` (missing). `OBJECT IDLETIME key` shows how long since a key was accessed, useful for spotting cold keys the active cycle is slow to reap. `redis-cli --scan --pattern 'prefix:*'` audits a namespace without a blocking `KEYS`. To find keys lacking a TTL, scan and check `TTL` per key (batched, off-peak).
- **Monitoring.** `INFO keyspace` reports, per database, `keys=` and `expires=` — the count of keys and how many have a TTL. A large gap between them (many `keys`, few `expires`) is the direct signature of the no-TTL leak. `INFO stats` includes `expired_keys` (cumulative) and `expired_stale_perc`/active-expire effort; a rising number of keys with a low `expired_keys` rate can indicate the active cycle falling behind. Watch `used_memory` against expected expiry to catch the "logically expired but still resident" bump.
- **Security.** Key names can leak information — an enumerable scheme like `password-reset:<email>` exposes data structure and even PII in the key itself, which appears in `MONITOR`, `SLOWLOG`, and logs. Prefer opaque or hashed identifiers for sensitive keys, and treat the keyspace as observable. `SCAN` (not `KEYS`) for any audit so an inspection never blocks the single thread (chapter 3).
- **Scaling.** In Cluster, a key's slot is `CRC16(key) mod 16384`, so the *structure* of key names determines data distribution. Hash tags (`user:{9}:profile`) force related keys onto one slot for multi-key atomicity, but overusing a single tag concentrates load — a naming decision with a scaling consequence. Absolute-deadline expiries (`EXPIREAT`) that fire simultaneously across a cluster can stampede many shards at once; jitter is even more important at scale (chapter 15).

## 9. Interview Questions

**Q: How does Redis actually remove an expired key?**
A: With two cooperating mechanisms, because a precise per-key timer would be too expensive on a single-threaded server. First, *lazy* (passive) expiration: whenever a command touches a key, Redis checks its recorded absolute expiry time and, if it has passed, deletes the key on the spot and behaves as though it were absent — so a read can never return an expired value. Second, *active* expiration: a background cycle running about ten times a second samples a batch of keys that have TTLs, deletes the expired ones, and if more than a quarter of the sample were expired, repeats immediately. Lazy handles keys that are accessed; active reclaims keys that are never touched so they do not leak. Together they keep the fraction of logically-expired-but-still-resident keys low without ever scanning the whole keyspace.

**Q: Can a key be expired but still using memory? Why does that matter?**
A: Yes. A key whose expiry time has passed is *logically* expired — any read returns nil — but it physically remains, and counts toward `used_memory`, until either a command touches it (lazy path) or the active cycle samples and reaps it. It matters because it breaks the intuition that "TTL reached" equals "memory freed": memory returns eventually, not at the exact second of expiry. A burst of keys sharing one TTL can leave a lingering memory bump after they all logically expire. The practical consequence is that you cannot rely on expiration to enforce a memory ceiling on time — for that you need `maxmemory` with an eviction policy, which runs synchronously when a write needs room (chapter 7).

**Q: Why must you set the value and TTL in the same command?**
A: Because splitting them into `SET` then `EXPIRE` opens a window in which the key exists with no expiry, and if the process crashes or the connection drops between the two commands, the key stays in the cache forever with no TTL — an immortal key that leaks memory and can serve stale data indefinitely, which is exactly what the TTL was meant to prevent. `SET key val EX ttl` fuses the write and the expiry into one atomic command, so the key never exists without its lifetime. It is also one round trip instead of two.

**Q: Does a plain `SET` on an existing key keep its TTL?**
A: No — and this is a common, quiet bug. Overwriting a key with a bare `SET key newval` (no `EX`, no `KEEPTTL`) *removes* any existing expiry, making the key permanent, because Redis treats a fresh `SET` as an entirely new value and will not assume it should inherit the old lifetime. A read-modify-write path that rewrites a cached value with a plain `SET` therefore silently turns a well-behaved expiring key into an immortal one. The fixes are to pass the TTL again on every write (`SET key newval EX ttl`, the cleanest since the lifetime is always explicit) or to use `SET key newval KEEPTTL` to preserve the current expiry. In-place mutations like `HSET`, `INCR`, `LPUSH`, and `APPEND` are different — they do not disturb the TTL — so it is specifically the plain-`SET` overwrite to watch.

**Q: How would you react when a key expires — and what is unreliable about that?**
A: Redis keyspace notifications let you subscribe (via Pub/Sub) to an event when a key is removed; enabling `notify-keyspace-events Ex` publishes an "expired" event per key. The two caveats both flow from the expiration model. First, the event fires when the key is *physically removed*, not when it *logically* expires — because removal is lazy plus active, a key that expired seconds ago but has not been accessed or sampled yet emits its event only when the active cycle finally reaps it, so the notification can lag. Second, Pub/Sub is fire-and-forget with no delivery guarantee: a consumer disconnected at that instant simply misses the event. So notifications are fine for best-effort reactions like a cache-warming hint, but for anything requiring correctness I would use an explicit design — a sorted set of deadlines I poll, or a durable stream — rather than depend on the notification arriving.

**Q: What do `TTL` return values of -1 and -2 mean?**
A: `-1` means the key exists but has no associated expiry — it is permanent. For a cache that is a warning sign: a cached value with no TTL is a leak and a staleness risk. `-2` means the key does not exist at all (either it was never set or it has already been removed). Any positive value is the remaining lifetime in seconds (`PTTL` gives milliseconds). A quick health check for a cache is to look at `INFO keyspace`: if `keys` is much larger than `expires`, many keys are in the `-1` state and you likely have a no-TTL leak.

**Q: What does `GETEX` give you that `GET` plus `EXPIRE` does not?**
A: Atomicity and a single round trip. `GETEX key EX ttl` reads the value and adjusts the TTL in one atomic operation, so an active session or sliding-window entry is refreshed exactly when it is read, with no window in between. Doing `GET` then `EXPIRE` is two round trips and a race: between them the key could expire, or a concurrent operation could change the TTL, so the refresh might apply to a key that no longer exists or fight another writer. `GETEX` also has variants — `EX`/`PX` to set a new relative TTL, `EXAT`/`PXAT` for an absolute one, and `PERSIST` to *clear* the TTL on read — giving you read-and-retune in one command.

**Q: When would you use `EXPIREAT` instead of `EXPIRE`?**
A: When the expiry is an absolute point in time rather than a duration from now. Two common cases: first, when many keys must all expire at the same wall-clock instant regardless of when each was written — a daily cache that rolls over at midnight UTC is naturally `EXPIREAT midnight`, whereas relative `EXPIRE` would give each key a different deadline based on its write time. Second, when the deadline originates upstream — a token that is valid until a specific timestamp supplied by an auth service. The caveat is that synchronised absolute deadlines make many keys expire simultaneously, which can stampede the origin, so in practice you add jitter to the absolute time (chapter 15).

**Q: Why should every cache entry have a TTL, even ones you also invalidate explicitly?**
A: Because the TTL is a safety net for when your explicit invalidation fails, and it eventually will. Invalidation is a distributed problem — a missed message, a deploy that skips a path, a bug that forgets to delete on update — and any of those leaves a stale value that, with no TTL, is wrong forever. A TTL bounds that damage: however the invalidation is missed, the entry self-heals within one lifetime because it simply expires and the next read repopulates from the origin. A no-TTL key is also a straightforward memory leak, since nothing will ever reclaim it. So the discipline is belt-and-braces: invalidate explicitly for freshness, and keep a TTL as the backstop that guarantees eventual correctness and bounded memory.

**Q: (Senior) You deploy a change and immediately see stale values served from cache even though you invalidate on write. The keys have TTLs. What could explain it, and how does expiration semantics factor in?**
A: Several mechanisms can produce this, and expiration semantics narrow them down. First, the invalidation and the write race: with cache-aside, a reader can load the old value from the origin and populate the cache *after* the writer's invalidate has already run, re-inserting stale data (chapter 13's read/write race) — the TTL bounds how long that stale value lives but does not prevent it. Second, if you read from a replica, remember replicas do not expire keys independently: a logically-expired-or-invalidated key is removed on the replica only when the primary's `DEL` propagates, so a lagging replica can briefly serve a value the primary already considers gone — though for an *explicit* invalidation the `DEL` is what replicates, so replica lag is the window. Third, a schema-version mismatch: if the new code reads under the same key prefix as the old, it may decode an old-format value that has not yet expired; versioning the prefix (`cache:v2:...`) avoids this by letting old entries expire out under the old prefix. Fourth, check that the invalidation actually targets the right key — a naming mismatch (a trailing segment, a different tenant prefix) silently no-ops the `DEL`. The TTL guarantees the staleness is bounded to one lifetime, which is exactly why every entry needs one; but to *eliminate* the window you address the race (delete-after-write plus a short TTL, or write-through), the replica lag (read-your-writes from the primary for critical paths), and the key hygiene (versioned prefixes, exact-match invalidation).

**Q: (Senior) A Redis instance's memory stays high long after a large batch of keys should have expired. Walk through the causes and fixes.**
A: The root is that expiration is lazy plus active, so "should have expired" and "memory reclaimed" are different events, and I would work through why reclamation is lagging. If the batch of keys is never accessed again — which is common for a cache of one-off results — lazy expiration will never fire on them, so reclamation falls entirely to the active cycle. That cycle is probabilistic and bounded (it samples keys with TTLs about ten times a second and only escalates when a sample is heavily expired), so a very large cold set of expired keys can take many cycles to clear, and if the keyspace with TTLs is huge the sampling covers a smaller fraction each pass. `INFO stats` (`expired_keys` rate) and `INFO keyspace` (the `expires=` count trending down) show whether the cycle is making progress. Fixes, in order: confirm the keys genuinely have TTLs (`INFO keyspace` gap between `keys` and `expires` reveals no-TTL keys that will *never* expire — the real leak); if reclamation is merely slow, `maxmemory` with an eviction policy is what actually enforces the ceiling, because eviction runs synchronously when a write needs room and does not wait for the active cycle; for a known large batch, an explicit `UNLINK` (background free) over the group reclaims immediately without blocking the thread, better than waiting. I would also rule out fragmentation — `used_memory` may have dropped while `used_memory_rss` (what the OS sees) has not, because the allocator has not returned freed pages, in which case `mem_fragmentation_ratio` is high and `activedefrag` or a restart is the lever (chapter 7). And on a replica, high memory can simply be the primary's `DEL`s lagging. The mental model is that expiry bounds *staleness* reliably but bounds *memory* only eventually; when you need memory back on a deadline, eviction and `UNLINK` are the tools, not TTLs.

**Q: (Senior) Design a key-naming and TTL scheme for a multi-tenant cache that will run on Redis Cluster. What do you optimise for?**
A: I optimise for four things simultaneously: safe distribution across slots, targeted invalidation, schema evolution, and bounded staleness. The scheme is a versioned, tenant-scoped, colon-delimited path — for example `cache:v3:t{42}:user:9:profile`. The version segment (`v3`) lets me change a value's serialized format by bumping it, so old and new entries coexist under different prefixes and the old ones expire out rather than causing decode errors after a deploy. The tenant id is wrapped in a hash tag (`t{42}`) so that all of a tenant's keys hash to the same slot via `CRC16` over just the braces' contents, which co-locates them for multi-key operations and makes per-tenant invalidation reason-about-able — but I keep the tag to the tenant, not something too coarse, because everything sharing a tag lands on one slot and an over-broad tag creates a hotspot and defeats the point of clustering. For TTLs, every entry gets one as a non-negotiable safety net, with the length tuned per class by staleness tolerance (a profile might get minutes, a rarely-changing config might get an hour), and I add random jitter to each TTL so a batch written together does not expire together and stampede the origin — especially important at cluster scale where a synchronised avalanche hits many shards at once. Invalidation is explicit `DEL`/`UNLINK` on write for freshness, but the TTL remains the backstop. For auditing I rely on `SCAN` with the namespace pattern (never `KEYS`) so inspection never blocks a shard's single thread, and I avoid putting PII or enumerable secrets in key names because names are observable in `MONITOR` and logs. The scheme is thus a single naming decision that carries distribution, invalidation, versioning, and privacy properties at once — which is why naming is an interface, not an afterthought.

## 10. Quick Revision & Cheat Sheet

| Command | Effect |
|---|---|
| `SET k v EX 60` | set value + 60s TTL, atomically (the idiomatic cache write) |
| `EXPIRE k 60` / `PEXPIRE k 60000` | set relative TTL (s / ms) |
| `EXPIREAT k <ts>` / `PEXPIREAT` | set absolute expiry (Unix s / ms) |
| `TTL k` / `PTTL k` | remaining life (s / ms); `-1` = no TTL, `-2` = missing |
| `GETEX k EX 60` | read AND refresh TTL, atomically |
| `GETEX k PERSIST` | read AND clear TTL |
| `PERSIST k` | remove TTL (make permanent) |
| `EXPIRE k 60 NX/XX/GT/LT` | set TTL only if none / exists / greater / less |
| `SET k v KEEPTTL` | overwrite value but preserve the existing TTL |
| `SET k v` (bare) | overwrite value and CLEAR the TTL (the trap) |

| Expiration mechanism | Behaviour |
|---|---|
| Lazy (on access) | expired key deleted when touched; reads never see expired values |
| Active (~10 Hz) | samples keys with TTLs, reaps expired; reclaims never-accessed keys |
| Consequence | logically expired ≠ memory freed; reclamation is eventual |
| Replica | never expires independently; waits for the primary's `DEL` |

**Flash cards**
- **How does Redis expire keys?** → Lazy (on access) + active (background sampling ~10×/sec).
- **Expired but still in memory?** → Yes, until accessed or the active cycle reaps it.
- **Set value + TTL how?** → In one command: `SET k v EX ttl` (never SET then EXPIRE).
- **`TTL` returns -1 / -2?** → -1 = no expiry (leak risk); -2 = no such key.
- **Read and slide the TTL?** → `GETEX k EX ttl` (atomic read-and-refresh).
- **Plain `SET` on an existing key?** → Clears the TTL; use `EX` again or `KEEPTTL`.
- **Do replicas expire keys themselves?** → No; they wait for the primary's `DEL`/`UNLINK`.
- **Why a TTL on everything?** → Safety net: bounds staleness and memory if invalidation is missed.

## 11. Hands-On Exercises & Mini Project

- [ ] `SET` a key with `EX`, watch `PTTL` count down in `redis-cli`, and confirm a `GET` after expiry returns nil.
- [ ] Demonstrate the lazy-vs-active difference: set many keys with a short TTL, stop touching them, and watch `INFO keyspace`/`used_memory` reclaim gradually rather than instantly.
- [ ] Reproduce the immortal-key bug: `SET` then (in a separate step) `EXPIRE`, kill the client between them, and find the key with `TTL == -1`; then fix it with `SET ... EX`.
- [ ] Use `EXPIRE ... GT` and `... LT` from two clients to prove extend-only and shorten-only semantics.
- [ ] Build a sliding session with `GETEX` and verify the TTL slides on each read but the session still dies after the idle window with no reads.
- [ ] Audit a namespace for no-TTL keys with `--scan` + `TTL`, then repair them with `EXPIRE ... NX`.
- [ ] Reproduce the overwrite trap: `SET` a key with `EX`, overwrite it with a bare `SET`, and confirm `TTL` is now `-1`; then redo with `KEEPTTL` and confirm it survives.
- [ ] Enable `notify-keyspace-events Ex`, subscribe to expired events, and observe how the event lags the logical expiry for a key nothing accesses.

### Mini Project — "TTL Correctness Lab"

**Goal.** Make lazy vs active expiration and the TTL-as-safety-net principle measurable, so the semantics become intuition rather than trivia.

**Requirements.**
1. Load 100k keys with identical short TTLs, stop accessing them, and chart `used_memory` and `INFO keyspace` `expires=` over time to observe active expiration reclaiming gradually.
2. Repeat but access a subset continuously, and show those subset keys reclaim *immediately* on expiry (lazy) while the untouched ones lag (active).
3. Implement a cache-aside layer where every populate uses `SET ... EX` with jittered TTLs, and prove that deleting the invalidation step still self-heals within one TTL.
4. Add a sliding-session store with `GETEX` and an absolute cap (`EXPIREAT`) so an always-active session cannot live forever.
5. Build a `--scan`-based auditor that reports the `keys` vs `expires` gap and flags no-TTL keys.

**Extensions.**
- Introduce a replica and observe that expired keys linger on it until the primary's `DEL` propagates; measure the window under replication lag.
- Compare synchronised vs jittered TTLs on a batch by measuring origin load at the expiry moment, quantifying the avalanche the jitter prevents (chapter 15).

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Memory, maxmemory & Eviction Policies* (what enforces a ceiling when expiry lags), *Running Redis: redis-cli, Go & Python Clients* (where the `SET ... EX` populate lives), *Cache-Aside, Read-Through & Write Patterns* (the read/write race a TTL bounds), *Cache Invalidation Strategies* (why a TTL backstops explicit invalidation), *Cache Avalanche, Stampede & Penetration* (why TTLs need jitter), *Redis Cluster & Sharding* (how key names map to slots).

- **Redis — EXPIRE command & "How Redis expires keys"** — Redis · *Intermediate* · the authoritative description of the lazy + active expiration algorithm this chapter explains, straight from the command reference. <https://redis.io/docs/latest/commands/expire/>
- **Redis — SET command (EX/PX/EXAT/KEEPTTL options)** — Redis · *Beginner* · every expiry-related option of `SET`, including `KEEPTTL`, the basis of the atomic set-with-TTL rule. <https://redis.io/docs/latest/commands/set/>
- **Redis — GETEX command** — Redis · *Intermediate* · read-and-retune-TTL semantics used for sliding windows and read-time expiry changes. <https://redis.io/docs/latest/commands/getex/>
- **Redis — Keyspace & key naming guidance** — Redis · *Beginner* · conventions for namespacing and the keyspace model that make a cache inspectable and shardable. <https://redis.io/docs/latest/develop/use/keyspace/>
- **Redis — TTL / PTTL / PERSIST commands** — Redis · *Beginner* · the inspection and cancellation commands and the meaning of the `-1`/`-2` sentinels. <https://redis.io/docs/latest/commands/ttl/>
- **Redis — Keyspace notifications** — Redis · *Advanced* · how to receive events when keys expire, useful for reacting to expiry (with the caveat that notifications fire on removal, not the expiry instant). <https://redis.io/docs/latest/develop/use/keyspace-notifications/>
- **Redis — Replication & how expires are handled on replicas** — Redis · *Advanced* · why replicas do not expire independently and how the primary propagates deletions. <https://redis.io/docs/latest/operate/oss_and_stack/management/replication/>
- **Redis University — RU101** — Redis · *Beginner* · a free course that grounds keys, TTLs, and expiration in hands-on exercises. <https://university.redis.com/>

---

*Caching with Redis Handbook — chapter 06.*
