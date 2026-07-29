# 23 · Build: Distributed Locks & Redlock

> **In one line:** A Redis lock is easy to write and easy to get subtly, dangerously wrong — the correct single-node version is `SET NX PX` with a unique token and a Lua compare-and-delete release, and the hard truth is that no Redis lock is safe for *correctness* under pauses and clock skew, so anything where a double-execution is catastrophic needs a fencing token or a real consensus system.

---

## 1. Overview

Sooner or later you need mutual exclusion across processes: only one worker should run this cron job, only one request should rebuild this cache entry, only one node should charge this invoice. Redis is the obvious place to put the lock — it is already there, it is fast, and `SET key value NX` looks like exactly the primitive you need. This chapter builds a *correct* Redis lock and then, just as importantly, is honest about the ceiling on how much a Redis lock can promise. That honesty is the whole point: distributed locks are a topic where confident, plausible-looking code is routinely wrong in ways that only show up as a rare double-charge in production.

The single-node lock is genuinely useful and, done right, correct enough for a large class of problems. The recipe is `SET resource <token> NX PX <ttl>`: set the key only if it does not exist (`NX`), with a time-to-live (`PX`) so the lock cannot be held forever if the holder dies. The two non-obvious parts are the **unique token** — a random value unique to this holder — and the **release**, which must be a Lua compare-and-delete that only removes the key if the token still matches. A naive `DEL` to release is a real bug: if your work overran the TTL, the lock already expired and someone else acquired it, and your `DEL` now deletes *their* lock.

Beyond the single node lies **Redlock**, antirez's algorithm for acquiring a lock across N independent Redis masters, requiring a majority (N/2+1) to consider the lock held, designed to survive the loss of a minority of nodes without a single point of failure. And beyond Redlock lies a famous, still-live debate: Martin Kleppmann's critique that Redlock (and indeed *any* TTL-based lock) cannot guarantee safety under process pauses and clock skew, and antirez's rebuttal. The resolution is not "one side is right" but a distinction you must internalise: locks for **efficiency** (avoid duplicate work, usually harmless if it occasionally happens) versus locks for **correctness** (a double-execution corrupts data or double-charges a customer). Redis locks are fine for the former; for the latter you need a **fencing token** the protected resource itself checks, or a real consensus system like ZooKeeper or etcd.

This is a *build* chapter. You will get a complete, production-shaped Go lock with a Lua release and a fencing token, and a clear map of when it is enough and when it is not.

## 2. Core Concepts

- **Mutual exclusion** — at most one holder of the lock at a time; the property a lock is supposed to provide.
- **`SET NX PX`** — acquire: set the key only if absent (`NX`) with a millisecond TTL (`PX`); the atomic acquire primitive.
- **Unique token** — a random, per-holder value stored as the lock's value, so a holder can prove ownership when releasing.
- **Lua compare-and-delete** — the correct release: delete the key *only if* its value still equals your token, done atomically in a script.
- **TTL / lease** — the lock's automatic expiry; bounds how long a dead holder can block others, but also creates the possibility of expiring *under* a live-but-paused holder.
- **The naive-DEL bug** — releasing with a plain `DEL` can delete someone else's lock after your TTL expired; the canonical mistake.
- **Fencing token** — a monotonically increasing number handed out with the lock; the protected resource rejects any write carrying a token lower than the highest it has seen, defending against a paused-then-resumed holder.
- **GC pause / clock skew** — a stop-the-world pause or a jumping clock can make a holder believe it still owns a lock that has actually expired; the root cause of TTL-lock unsafety.
- **Redlock** — antirez's multi-master algorithm: acquire on a majority (N/2+1) of N independent Redis masters within a time budget.
- **Efficiency vs correctness lock** — the decisive question: is an occasional double-execution merely wasteful (efficiency) or catastrophic (correctness)? It determines whether a Redis lock is acceptable at all.

## 3. Theory & Principles

### The correct single-node lock, and why each part exists

Acquire with one atomic command: `SET lock:resource <token> NX PX 30000`. Every part earns its place. `NX` makes it set-only-if-absent, so exactly one contender wins the race — this is atomic on the single thread, no separate check-then-set. `PX 30000` attaches a 30-second TTL, the *lease*: if the holder crashes, the lock auto-expires and the resource is not blocked forever. The **token** is a random value (a UUID or 16 crypto-random bytes) unique to this acquisition; it is what makes a safe release possible.

Release is where the naivety bites. The obvious release is "delete the key" — `DEL lock:resource`. Consider the timeline: holder A acquires with a 30 s TTL, but A's work takes 35 s (a slow query, a GC pause, a scheduling hiccup). At 30 s the lock **expires automatically**. At 31 s holder B acquires the now-free lock and starts its work. At 35 s A finishes and calls `DEL lock:resource` — deleting **B's** lock. Now C can acquire while B still thinks it holds it: two holders at once, the exact thing the lock exists to prevent. The fix is to release *conditionally*: delete only if the value is still my token. That compare-and-delete must be atomic — a client-side "GET, check, DEL" has the same race between the GET and the DEL — so it goes in a Lua script:

```
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
```

With that, A's late release finds the value is B's token, not A's, and deletes nothing. The token plus the Lua compare-and-delete is the minimum viable correct single-node lock. Anything less has a race.

```svg
<svg viewBox="0 0 880 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="l1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The naive-DEL bug: why release must compare the token</text>

  <line x1="70" y1="70" x2="820" y2="70" stroke="#94a3b8" stroke-width="1.5"/>
  <text x="70" y="60" fill="#64748b" font-size="9">t=0s</text>
  <text x="300" y="60" fill="#64748b" font-size="9">t=30s (TTL expires)</text>
  <text x="470" y="60" fill="#64748b" font-size="9">t=31s</text>
  <text x="640" y="60" fill="#64748b" font-size="9">t=35s</text>
  <line x1="300" y1="64" x2="300" y2="76" stroke="#94a3b8"/>
  <line x1="470" y1="64" x2="470" y2="76" stroke="#94a3b8"/>
  <line x1="640" y1="64" x2="640" y2="76" stroke="#94a3b8"/>

  <rect x="70" y="90" width="230" height="40" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="185" y="106" text-anchor="middle" fill="#1e40af" font-size="9" font-weight="bold">A: SET lock A-token NX PX 30000</text>
  <text x="185" y="122" text-anchor="middle" fill="#1e3a8a" font-size="8">acquires, starts 35s of work (overruns!)</text>
  <rect x="300" y="90" width="340" height="40" rx="6" fill="#fef3c7" stroke="#d97706" stroke-dasharray="4 3"/>
  <text x="470" y="106" text-anchor="middle" fill="#92400e" font-size="9" font-weight="bold">A still working, but lock has EXPIRED</text>
  <text x="470" y="122" text-anchor="middle" fill="#92400e" font-size="8">A no longer actually owns it &#8212; but A doesn't know</text>

  <rect x="470" y="150" width="230" height="40" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="585" y="166" text-anchor="middle" fill="#15803d" font-size="9" font-weight="bold">B: SET lock B-token NX PX 30000</text>
  <text x="585" y="182" text-anchor="middle" fill="#14532d" font-size="8">acquires the now-free lock, starts work</text>

  <rect x="640" y="210" width="200" height="56" rx="6" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="740" y="230" text-anchor="middle" fill="#b91c1c" font-size="9" font-weight="bold">A finishes, calls DEL lock</text>
  <text x="740" y="246" text-anchor="middle" fill="#b91c1c" font-size="8">naive DEL removes B's lock!</text>
  <text x="740" y="260" text-anchor="middle" fill="#b91c1c" font-size="8">&#8594; C can now acquire while B holds &#8594; TWO holders</text>
  <path d="M640,238 L600,238 L600,190" stroke="#dc2626" stroke-width="1.5" fill="none" marker-end="url(#l1)"/>

  <rect x="70" y="292" width="360" height="120" rx="8" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="250" y="314" text-anchor="middle" fill="#b91c1c" font-size="11" font-weight="bold">Naive release (WRONG)</text>
  <text x="86" y="336" fill="#7f1d1d" font-size="10">DEL lock:resource</text>
  <text x="86" y="356" fill="#7f1d1d" font-size="9">&#8226; deletes whatever lock exists now</text>
  <text x="86" y="374" fill="#7f1d1d" font-size="9">&#8226; after your TTL expired, that's SOMEONE ELSE'S</text>
  <text x="86" y="392" fill="#7f1d1d" font-size="9">&#8226; result: two concurrent holders</text>

  <rect x="450" y="292" width="380" height="120" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="640" y="314" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">Compare-and-delete (CORRECT)</text>
  <text x="466" y="336" fill="#14532d" font-size="9">if GET(lock)==my-token then DEL(lock) end</text>
  <text x="466" y="356" fill="#14532d" font-size="9">&#8226; atomic in one Lua script</text>
  <text x="466" y="374" fill="#14532d" font-size="9">&#8226; A's late release sees B's token &#8594; deletes nothing</text>
  <text x="466" y="392" fill="#14532d" font-size="9">&#8226; you can only ever release YOUR OWN lock</text>
</svg>
```

### The deeper problem: pauses, clocks, and fencing

The compare-and-delete release fixes the *release* race, but it does not fix the *fundamental* problem that a TTL lock is a lease that can expire while you still believe you hold it. The overrun above was benign in the sense that A's late `DEL` was neutralised — but during the window where A's lock had expired and A was still working, **A was doing protected work without actually holding the lock**, at the same time as B. The compare-and-delete stops A corrupting the lock's bookkeeping; it does nothing to stop A and B both touching the protected *resource*.

Why does a live holder lose its lock? A **stop-the-world GC pause** can freeze a process for seconds — the JVM, or Go's STW phases, or the OS descheduling the process, or a VM being live-migrated. A holder that acquired a 30 s lease, then paused for 40 s, wakes up believing it still holds a lock that expired 10 s ago and was reacquired by someone else. **Clock skew** is the mirror image: locks rely on time, and if a node's clock jumps forward, its lease appears to expire early; if it jumps back, the lease appears to last too long. You cannot make these windows disappear by tuning the TTL — a shorter TTL just makes expiry-under-a-live-holder *more* likely, and a longer one makes a dead holder block others for longer. The lease model has an irreducible unsafety.

The defence is a **fencing token**: every time the lock is granted, the lock service hands out a monotonically increasing number. The holder includes that token with every write to the protected resource, and the resource **remembers the highest token it has seen and rejects any write carrying a lower one**. Now the paused-then-resumed holder is harmless: while it was paused, a new holder acquired the lock with a *higher* token and did its writes; when the paused holder wakes and tries to write with its *older, lower* token, the resource rejects it. Mutual exclusion at the *lock* is no longer required for safety — the *resource* enforces correctness by ordering. The catch is that the protected resource must support fencing checks; not every downstream (a payment API, an arbitrary file store) does, which is exactly why some correctness-critical operations cannot be safely guarded by any TTL lock alone.

### Redlock and the debate

For a single Redis instance, the lock has an availability problem: if that Redis dies, or fails over to a replica that has not yet received the lock write (replication is asynchronous), the lock can be lost or granted twice. **Redlock** addresses the single-point-of-failure by running N independent Redis masters (typically 5, with no replication between them) and requiring a client to acquire the lock on a **majority, N/2+1**, within a bounded time, counting the lock as held only if it got the majority and the elapsed time left meaningful TTL remaining. Losing a minority of nodes does not lose the lock.

Then comes the debate. **Martin Kleppmann** argued that Redlock does not deliver the safety it implies: because it still relies on TTLs and bounded clocks, it is vulnerable to exactly the GC-pause and clock-skew problems above, and adding more nodes does not fix a per-holder pause. His conclusion: if you need a lock for *correctness*, use a system that provides a fencing token (or use a consensus system built for this, like ZooKeeper), and if you only need it for *efficiency*, a single-instance Redis lock is simpler and just as good — Redlock is an awkward middle. **antirez** rebutted that Redlock's assumptions (bounded clock drift, bounded pauses) are reasonable in practice, that fencing tokens can be layered on top, and that Redlock is a pragmatic, available lock. The useful takeaway is not a verdict but the discipline: **decide whether your lock is for efficiency or correctness first.** For efficiency (don't do duplicate work; an occasional overlap wastes CPU but corrupts nothing), a single-instance `SET NX PX` lock is the right, simple answer. For correctness (a double-execution double-charges a customer or corrupts data), no TTL lock is sufficient on its own — you need a fencing token the resource enforces, or a real consensus system like ZooKeeper/etcd. Redlock buys availability, not the correctness guarantee people assume.

## 4. Architecture & Workflow

The lifecycle of a correct single-node lock with fencing:

1. **Generate a unique token.** 16 cryptographically random bytes (or a UUID). This must be unique per acquisition so release can prove ownership.
2. **Acquire.** `SET lock:resource <token> NX PX <ttl>`. Success means you hold the lease until the TTL; failure means someone else holds it (back off and retry, or give up).
3. **Obtain a fencing token (for correctness locks).** A monotonically increasing number — e.g. `INCR lock:resource:fence` — issued with the lock and carried on every write to the protected resource.
4. **Do the work, bounded by the TTL.** Keep the critical section shorter than the lease. Optionally run a *watchdog* that extends the TTL (another Lua compare-and-extend) while work is ongoing — but understand this reduces, not removes, the pause window.
5. **Guard the resource with the fence.** Every protected write includes the fencing token; the resource rejects any write whose token is below the highest it has seen.
6. **Release.** Lua compare-and-delete: delete the lock only if its value still equals your token, so you never delete a successor's lock.
7. **On failover / node loss.** A single instance can lose the lock on failover to a not-yet-replicated replica; Redlock spreads acquisition across a majority of independent masters to survive minority loss — but the fencing token, not the lock count, is what makes the operation actually safe.

```svg
<svg viewBox="0 0 880 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Fencing tokens defend against a paused-then-resumed holder</text>

  <line x1="60" y1="60" x2="60" y2="360" stroke="#94a3b8"/>
  <text x="60" y="50" text-anchor="middle" fill="#64748b" font-size="9">time &#8595;</text>

  <rect x="90" y="70" width="300" height="36" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="240" y="86" text-anchor="middle" fill="#1e40af" font-size="9" font-weight="bold">Client A acquires lock, gets fence = 33</text>
  <text x="240" y="100" text-anchor="middle" fill="#1e3a8a" font-size="8">starts work, then STOPS (GC pause / VM migration)</text>

  <rect x="90" y="120" width="300" height="34" rx="6" fill="#fef3c7" stroke="#d97706" stroke-dasharray="4 3"/>
  <text x="240" y="136" text-anchor="middle" fill="#92400e" font-size="9" font-weight="bold">A paused &#8212; lease expires while A is frozen</text>
  <text x="240" y="150" text-anchor="middle" fill="#92400e" font-size="8">A still believes it holds the lock</text>

  <rect x="90" y="168" width="300" height="36" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="240" y="184" text-anchor="middle" fill="#15803d" font-size="9" font-weight="bold">Client B acquires lock, gets fence = 34</text>
  <text x="240" y="198" text-anchor="middle" fill="#14532d" font-size="8">writes to resource with token 34 &#8594; accepted</text>

  <rect x="90" y="218" width="300" height="36" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="240" y="234" text-anchor="middle" fill="#b91c1c" font-size="9" font-weight="bold">A resumes, writes with STALE fence = 33</text>
  <text x="240" y="248" text-anchor="middle" fill="#b91c1c" font-size="8">33 &lt; 34 &#8594; resource REJECTS the write</text>

  <rect x="470" y="90" width="360" height="180" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="650" y="112" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Protected resource</text>
  <text x="486" y="136" fill="#475569" font-size="10">keeps: highest fence token seen = 34</text>
  <rect x="486" y="150" width="330" height="34" rx="5" fill="#dcfce7" stroke="#16a34a"/>
  <text x="651" y="171" text-anchor="middle" fill="#15803d" font-size="9" font-weight="bold">write(token=34) &#8594; 34 &#8805; 34 &#8594; ACCEPT, record 34</text>
  <rect x="486" y="192" width="330" height="34" rx="5" fill="#fee2e2" stroke="#dc2626"/>
  <text x="651" y="213" text-anchor="middle" fill="#b91c1c" font-size="9" font-weight="bold">write(token=33) &#8594; 33 &lt; 34 &#8594; REJECT</text>
  <text x="486" y="248" fill="#334155" font-size="9" font-weight="bold">The resource enforces ordering &#8212; so mutual</text>
  <text x="486" y="262" fill="#334155" font-size="9" font-weight="bold">exclusion at the lock is no longer safety-critical.</text>

  <rect x="60" y="292" width="770" height="112" rx="10" fill="#fefce8" stroke="#ca8a04" stroke-width="2"/>
  <text x="445" y="314" text-anchor="middle" fill="#854d0e" font-size="12" font-weight="bold">Efficiency lock vs correctness lock &#8212; decide FIRST</text>
  <text x="76" y="338" fill="#713f12" font-size="10">&#8226; EFFICIENCY (avoid duplicate work; overlap merely wastes CPU) &#8594; a single-instance SET NX PX lock is the right, simple answer.</text>
  <text x="76" y="360" fill="#713f12" font-size="10">&#8226; CORRECTNESS (double-execution double-charges / corrupts data) &#8594; NO TTL lock alone is enough. Need a fencing token the resource</text>
  <text x="90" y="376" fill="#713f12" font-size="10">enforces, or a consensus system (ZooKeeper / etcd). Redlock buys availability, NOT the correctness guarantee people assume.</text>
  <text x="76" y="398" fill="#854d0e" font-size="10" font-weight="bold">Kleppmann vs antirez in one line: adding Redis nodes doesn't fix a per-holder GC pause; only fencing (or real consensus) does.</text>
</svg>
```

## 5. Implementation

A complete, production-shaped single-node lock in Go with `github.com/redis/go-redis/v9`: a unique token, a Lua compare-and-delete release, a Lua compare-and-extend for a watchdog, and a fencing token issued with the lock. Comments explain *why*.

```go
package redislock

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

// releaseScript deletes the lock ONLY if we still own it (value == our token).
// Doing this in Lua makes the compare-and-delete atomic; a client-side
// GET-then-DEL has a race between the two calls where the lock could expire and
// be reacquired, and we'd delete the new owner's lock — the exact bug this fixes.
var releaseScript = redis.NewScript(`
	if redis.call("GET", KEYS[1]) == ARGV[1] then
		return redis.call("DEL", KEYS[1])
	end
	return 0
`)

// extendScript renews the TTL ONLY if we still own the lock. A watchdog uses
// this to keep a lease alive while long work is in progress, without ever
// extending a lock that has already passed to someone else.
var extendScript = redis.NewScript(`
	if redis.call("GET", KEYS[1]) == ARGV[1] then
		return redis.call("PEXPIRE", KEYS[1], ARGV[2])
	end
	return 0
`)

// Lock is one acquisition. token proves ownership; fence is the monotonic
// fencing token the protected resource must check on every write.
type Lock struct {
	rdb   *redis.Client
	key   string
	token string
	fence int64
	ttl   time.Duration
}

// newToken returns 16 cryptographically-random bytes hex-encoded. It MUST be
// unique per acquisition: it is the only thing that lets release distinguish
// "my lock" from "a successor's lock that happens to sit at the same key".
func newToken() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// Acquire attempts to take the lock once. On success it also mints a fencing
// token via INCR on a companion key — a monotonically increasing number the
// protected resource uses to reject stale writers (see §3). Returns nil, nil on
// contention (lock already held) so the caller can back off and retry.
func Acquire(ctx context.Context, rdb *redis.Client, resource string, ttl time.Duration) (*Lock, error) {
	token, err := newToken()
	if err != nil {
		return nil, err
	}
	key := "lock:" + resource

	// SET key token NX PX ttl — the atomic acquire. NX = only if absent;
	// PX = lease so a dead holder can't block forever. This single command IS
	// the mutual-exclusion primitive; nothing here is check-then-set.
	ok, err := rdb.SetNX(ctx, key, token, ttl).Result()
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, nil // held by someone else right now
	}

	// Mint the fencing token. INCR is atomic and monotonic on the single
	// thread, so each successive holder gets a strictly larger number. The
	// resource, not the lock, uses this to enforce correctness.
	fence, err := rdb.Incr(ctx, key+":fence").Result()
	if err != nil {
		// We hold the lock but couldn't fence — release and fail rather than
		// hand back a lock the caller can't safely use for a correctness op.
		releaseScript.Run(ctx, rdb, []string{key}, token)
		return nil, err
	}

	return &Lock{rdb: rdb, key: key, token: token, fence: fence, ttl: ttl}, nil
}

// Fence exposes the token the caller must attach to every protected write.
func (l *Lock) Fence() int64 { return l.fence }

// Release drops the lock, but only if we still own it (Lua compare-and-delete).
// Safe to call even if our lease already expired: it will simply delete nothing.
func (l *Lock) Release(ctx context.Context) error {
	res, err := releaseScript.Run(ctx, l.rdb, []string{l.key}, l.token).Int64()
	if err != nil {
		return err
	}
	if res == 0 {
		// We no longer owned it — a signal our work may have overrun the lease.
		return errors.New("lock lost before release (TTL likely expired)")
	}
	return nil
}

// Extend renews the lease if we still own it. A watchdog goroutine calls this
// periodically for work that legitimately runs long. NOTE: extending narrows
// but does NOT eliminate the pause window — a stop-the-world pause longer than
// the TTL still expires the lock under a live holder. That is why correctness
// still depends on the fencing token, not on the lease staying alive.
func (l *Lock) Extend(ctx context.Context) error {
	res, err := extendScript.Run(ctx, l.rdb, []string{l.key}, l.token, l.ttl.Milliseconds()).Int64()
	if err != nil {
		return err
	}
	if res == 0 {
		return errors.New("cannot extend: lock no longer owned")
	}
	return nil
}

// AcquireWithRetry keeps trying until success, ctx cancellation, or deadline.
// Backoff keeps a contended lock from becoming a busy-wait storm.
func AcquireWithRetry(ctx context.Context, rdb *redis.Client, resource string, ttl, retryEvery time.Duration) (*Lock, error) {
	for {
		lock, err := Acquire(ctx, rdb, resource, ttl)
		if err != nil {
			return nil, err
		}
		if lock != nil {
			return lock, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(retryEvery):
			// try again
		}
	}
}

// Example: how a correctness-critical caller MUST use the fence. The lock alone
// is not enough — the protected resource has to reject stale tokens.
func chargeInvoice(ctx context.Context, rdb *redis.Client, invoiceID string, resource ProtectedResource) error {
	lock, err := AcquireWithRetry(ctx, rdb, "invoice:"+invoiceID, 30*time.Second, 100*time.Millisecond)
	if err != nil {
		return err
	}
	defer lock.Release(ctx)

	// Pass the fencing token to the resource. If this process paused and the
	// lease expired, a newer holder already advanced the resource's high-water
	// token, so this write is rejected — no double charge, even though we still
	// "hold" the lock object in memory.
	return resource.WriteIfFenceValid(ctx, invoiceID, lock.Fence())
}

// ProtectedResource is any downstream that supports fencing: it remembers the
// highest token it has accepted and rejects lower ones. This is what actually
// provides correctness; the Redis lock only provides (best-effort) efficiency.
type ProtectedResource interface {
	WriteIfFenceValid(ctx context.Context, id string, fence int64) error
}
```

The load-bearing lines: `SetNX` with a per-holder token is the acquire, the Lua `releaseScript` is the *only* safe release, and `chargeInvoice` shows the uncomfortable truth — for a correctness-critical operation the Redis lock is not sufficient by itself; the fencing token checked *by the resource* is what actually prevents a double-charge.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Simple and fast.** A single `SET NX PX` is one round trip and one atomic command; the whole lock is a few lines and microseconds.
- **Self-healing via the lease.** The TTL guarantees a crashed holder cannot block the resource forever — no manual lock cleanup.
- **Already there.** If Redis is in your stack, you need no new infrastructure for an efficiency lock.
- **Composable with fencing.** `INCR` gives a cheap monotonic token, so you can add real safety where the downstream supports fencing.
- **Redlock adds availability.** Spreading across N independent masters removes the single point of failure for the lock's *availability*.

**Disadvantages**
- **No lease is safe under pauses/clock skew.** A GC pause or clock jump can expire the lock under a live holder, so two processes can act at once — unfixable by tuning the TTL.
- **The naive release is a real bug.** A plain `DEL` deletes a successor's lock after your TTL expired; you must use the Lua compare-and-delete.
- **Single-instance failover can lose the lock.** Async replication means a failover to a not-yet-updated replica can grant the lock twice.
- **Redlock is operationally heavier and still debated.** N independent masters to run, and it does not deliver the correctness guarantee people assume.
- **Fencing needs downstream support.** Many resources (a third-party payment API, an arbitrary blob store) can't check a token, so some correctness-critical ops can't be safely locked with Redis at all.

**Trade-offs**
- *Efficiency vs correctness:* the decisive question. If an occasional double-execution merely wastes work, a single-instance Redis lock is perfect. If it corrupts data or double-charges, no TTL lock alone suffices — use a fencing token or consensus system.
- *Single instance vs Redlock:* single instance is simpler and, per Kleppmann, just as good for efficiency locks; Redlock adds availability at real operational cost and without adding correctness. Choose Redlock only when lock *availability* matters and you accept it is not a correctness guarantee.
- *Short vs long TTL:* short TTLs make expiry-under-a-live-holder more likely (needs a watchdog); long TTLs make a dead holder block others longer. There is no TTL that removes the window — hence fencing.
- *Redis lock vs ZooKeeper/etcd:* Redis is faster and simpler; ZooKeeper/etcd provide consensus-backed locks with fencing (zxid/mod-revision) built for correctness. Pay for the consensus system when a double-execution is catastrophic.

## 7. Common Mistakes & Best Practices

- **Releasing with a plain `DEL`.** After your TTL expires and someone else acquires, your `DEL` deletes *their* lock, producing two holders. *Best practice:* always release with the Lua compare-and-delete keyed on your unique token.
- **A non-unique or reused lock value.** If the value isn't unique per holder, release cannot tell your lock from a successor's. *Best practice:* use 16 crypto-random bytes or a UUID, fresh per acquisition.
- **`SET` then `EXPIRE` as two commands.** If the client dies between them, the lock has no TTL and blocks forever. *Best practice:* set the TTL atomically in the same command with `PX`/`EX` and `NX`.
- **Assuming the lock guarantees correctness.** A TTL lock cannot prevent a paused-then-resumed holder from acting. *Best practice:* for correctness-critical work, add a fencing token the resource enforces, or use a consensus system.
- **Thinking Redlock fixes the pause problem.** More nodes address availability, not a per-holder GC pause or clock skew. *Best practice:* decide efficiency-vs-correctness first; don't reach for Redlock expecting a safety guarantee it doesn't give.
- **A critical section longer than the TTL, with no plan.** Work that overruns the lease silently loses the lock. *Best practice:* keep the section shorter than the TTL, or run a compare-and-extend watchdog — and still fence.
- **Locking on a replica or ignoring failover.** A single-instance lock can be lost on failover to a stale replica. *Best practice:* understand your failover semantics; use fencing so a lost lock is not a lost invariant.
- **Busy-wait retry with no backoff.** Hammering `SET NX` on a contended lock wastes round trips. *Best practice:* retry with backoff (and jitter), and bound the total wait.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** When you suspect two holders, log the token and fence on every acquire, release, and protected write; a rejected fence (a write with a token below the resource's high-water mark) is the smoking gun that a paused holder came back. `TTL lock:resource` and `GET lock:resource` show the current lease and owner. A `Release` returning "lock lost" tells you the critical section overran the lease — a signal to lengthen the TTL, shorten the work, or add a watchdog.
- **Monitoring.** Track lock acquire success/contention rates, average hold time versus the TTL (hold time approaching the TTL predicts expiry-under-holder incidents), watchdog extension counts, and — most important for correctness locks — the count of rejected fencing tokens, which should be rare and always investigated. Alert on a lock held far longer than its TTL (a leaked lease) and on any downstream fence rejection.
- **Security.** The lock keys live in Redis, so the usual controls apply: require auth/ACLs so an untrusted client can't delete or forge locks, and consider a dedicated ACL user that can only touch `lock:*`. Never let lock values or fencing tokens be attacker-controllable; use crypto-random tokens so a token cannot be guessed and used to release someone else's lock.
- **Scaling.** A single Redis instance is a bottleneck and a single point of failure for lock availability; Redlock spreads acquisition across N independent masters (typically 5) so the loss of a minority doesn't lose the lock — at the cost of running and operating those masters and N acquire round trips. In Redis Cluster, keep a lock and its fence key co-located with a hash tag so they share a slot. When lock *correctness* is the requirement at scale, the honest answer is often to move the lock to a consensus system (ZooKeeper, etcd) whose locks come with fencing tokens by design, and keep Redis for the efficiency locks where it excels.

## 9. Interview Questions

**Q: Write the correct single-instance Redis lock. What are the essential parts?**
A: Acquire with one atomic command: `SET lock:resource <token> NX PX <ttl>`. `NX` sets only if absent so exactly one contender wins; `PX <ttl>` gives the lock a lease so a crashed holder can't block forever; and `<token>` is a value unique to this acquisition (crypto-random bytes or a UUID). Release with a Lua compare-and-delete: delete the key only if its value still equals your token. Those are the essentials — the atomic set-with-TTL-and-NX to acquire, the unique token to prove ownership, and the conditional Lua release. Anything that drops the token or the conditional release has a race.

**Q: Why is releasing a lock with `DEL` a bug?**
A: Because your lease can expire while you still think you hold the lock. If your work overruns the TTL, the lock auto-expires and another client acquires it; when you then call `DEL`, you delete *their* lock, not yours, and now two holders can run concurrently. The fix is to release conditionally — delete only if the lock's value is still your unique token — and to do that compare-and-delete atomically in Lua, because a client-side GET-then-DEL has the same race between the two calls.

**Q: What is a fencing token and what problem does it solve?**
A: A fencing token is a monotonically increasing number the lock service issues each time it grants the lock. The holder attaches it to every write to the protected resource, and the resource remembers the highest token it has seen and rejects any write carrying a lower one. It solves the problem that a TTL lock can expire under a live-but-paused holder: while a holder is paused (GC, VM migration), the lease expires, a new holder acquires with a higher token and does its writes; when the old holder wakes and writes with its older, lower token, the resource rejects it. The resource enforces correctness by ordering, so mutual exclusion at the lock is no longer safety-critical.

**Q: What is Redlock and what does it actually provide?**
A: Redlock is antirez's algorithm for a distributed lock across N independent Redis masters (typically 5, with no replication between them). A client tries to acquire the lock on all N and considers it held only if it got a majority — N/2+1 — within a bounded time with meaningful TTL left. What it provides is *availability*: losing a minority of nodes doesn't lose the lock, removing the single-instance single point of failure and the failover-to-stale-replica problem. What it does *not* provide, per its critics, is a correctness guarantee under process pauses and clock skew — those affect a single holder regardless of how many nodes hold the lock.

**Q: When is a Redis lock the right choice and when is it not?**
A: It's the right choice for an *efficiency* lock: you want to avoid duplicate work — one worker per cron job, one rebuild of a cache entry — and an occasional overlap merely wastes CPU without corrupting anything. There, a single-instance `SET NX PX` lock is simple, fast, and good enough. It's the wrong choice, by itself, for a *correctness* lock where a double-execution is catastrophic — double-charging a customer, corrupting shared state — because no TTL lock can prevent a paused-then-resumed holder from acting. For those you need a fencing token the protected resource enforces, or a consensus system like ZooKeeper or etcd built for the job.

**Q: Why does the lock need a TTL at all, and what problem does the TTL create?**
A: The TTL (the lease, set with `PX`) exists so a holder that crashes or disconnects can't block the resource forever — without it, a dead holder's lock would sit there permanently and nobody else could ever acquire, requiring manual cleanup. The TTL makes the lock self-healing: it auto-expires and the resource frees up. The problem it creates is the mirror image: the lease can expire while a *live* holder is still working — because of a GC pause, a slow dependency, or the OS descheduling the process — so the holder believes it still owns a lock that has actually expired and been reacquired by someone else. That's the root of the two-holders-at-once hazard, and it can't be tuned away, which is why correctness ultimately depends on a fencing token rather than on the lease.

**Q: Why must the compare-and-delete release be done in Lua rather than in application code?**
A: Because the check and the delete must be atomic, and doing them as two separate client commands reintroduces the exact race you're trying to close. If you `GET` the lock, verify the value is your token in your application, and then `DEL`, another client's activity can slip between the `GET` and the `DEL`: your lease could expire and someone else could acquire right after your check passed, and your subsequent `DEL` then deletes *their* lock. A Lua script runs the `GET`-compare-`DEL` as one uninterrupted step on the single thread, so nothing can interleave between the check and the delete — you can only ever delete a lock whose value still matches your token at the instant of deletion. The atomicity is the whole point; a client-side compare-and-delete is not safe.

**Q: (Senior) Summarise the Kleppmann–antirez debate and how it changes your design decisions.**
A: Kleppmann's critique is that Redlock markets safety it can't deliver: like any lease-based lock it depends on TTLs and bounded clocks, so a GC pause or clock jump can expire the lock under a live holder and let two processes act — and adding Redis nodes doesn't fix a per-holder pause. His prescription is a clean split: if you need the lock for correctness, use a system that gives you a fencing token or a real consensus service (ZooKeeper); if you only need it for efficiency, a single-instance Redis lock is simpler than Redlock and just as good, making Redlock an awkward middle that is neither the simplest efficiency lock nor a sound correctness lock. antirez rebutted that Redlock's assumptions — bounded clock drift, bounded pauses — are reasonable in real systems, that fencing can be layered on, and that Redlock is a pragmatic, available lock. What it changes for me is the order of reasoning: I decide efficiency-vs-correctness *first*. For efficiency I use a single-instance lock and don't bother with Redlock's operational weight. For correctness I never rely on the lock's mutual exclusion alone — I require a fencing token the downstream actually checks, and if the downstream can't fence and a double-execution is catastrophic, I move the lock to etcd/ZooKeeper. Redlock I reach for only when lock *availability* is the specific concern and I've accepted, in writing, that it is not a correctness guarantee.

**Q: (Senior) A distributed lock is protecting a job, yet you occasionally see it run twice. Walk through the causes and fixes.**
A: Two concurrent executions under a lock means either the lock let two holders in, or one holder acted after logically losing the lock. I'd work through the ladder. First, the release bug: is release a plain `DEL` rather than a token-checked Lua compare-and-delete? A `DEL` after a TTL overrun deletes a successor's lock and lets a third party in — fix with compare-and-delete. Second, non-atomic acquire: `SET` then a separate `EXPIRE` can leave a lock with no TTL, or a lock value that isn't unique per holder defeats the conditional release — fix with a single `SET NX PX` and a crypto-random token. Third, lease overrun: is the critical section sometimes longer than the TTL (a slow dependency, a big GC pause)? Then the lease expires under a live holder and a second worker legitimately acquires — the classic pause problem. Tuning the TTL or adding a compare-and-extend watchdog *narrows* the window but cannot close it. Fourth, failover: a single-instance lock can be granted twice if it fails over to a replica that hadn't received the lock write. The real fix for the last two is not a better lock but a fencing token: issue a monotonic token with the lock and have the *job's side effects* reject a stale token, so even if two workers hold the lock, only the one with the current token can commit its effect. If the job's downstream genuinely can't fence and running twice is catastrophic, I stop trying to make Redis safe here and move the lock to a consensus system with built-in fencing. The mental model I'd state plainly: a lock that runs twice is usually telling you it's being used as a correctness lock when it can only be an efficiency lock.

**Q: (Senior) Why can't you just make the TTL long enough (or short enough) to be safe, and what's the actual fix?**
A: Because the two failure directions are in tension and neither disappears. If you make the TTL *short*, you make it more likely the lease expires while a legitimate holder is still working — a brief pause or a slow query now loses the lock under a live holder, producing exactly the double-holder situation you're trying to avoid; you'd need a watchdog constantly extending it, and even the watchdog can't cover a pause longer than the TTL. If you make the TTL *long*, a holder that actually crashes now blocks the resource for that whole long duration, hurting availability, and you still haven't closed the pause window — a long-enough pause still exceeds any finite TTL. There is no TTL value that both releases promptly on crash and never expires under a live holder, because those requirements conflict and the pause is unbounded in the worst case. The actual fix is to stop requiring the lock's mutual exclusion to be perfect and instead make the *protected resource* enforce correctness with a fencing token: a monotonically increasing number issued with each grant, checked and high-water-marked by the resource, so a resumed stale holder's writes are rejected regardless of what the lease did. If the resource can't support that and correctness is non-negotiable, use a consensus system designed for locks. TTL tuning is managing the symptom; fencing (or consensus) addresses the cause.

## 10. Quick Revision & Cheat Sheet

| Concern | Correct answer |
|---|---|
| Acquire | `SET lock:res <token> NX PX <ttl>` (one atomic command) |
| Lock value | Unique crypto-random token per acquisition |
| Release | Lua compare-and-delete: `DEL` only if value == your token |
| Long work | Compare-and-extend watchdog (narrows, doesn't close, the pause window) |
| Correctness | Fencing token the *resource* checks, or a consensus system |
| Availability | Redlock: majority (N/2+1) of N independent masters |

| Failure | Cause | Fix |
|---|---|---|
| Deleted someone else's lock | Naive `DEL` release after TTL overrun | Lua compare-and-delete on token |
| Lock with no expiry | `SET` + separate `EXPIRE`, client died between | Atomic `SET … NX PX` |
| Two holders act at once | Lease expired under a paused/skewed holder | Fencing token / consensus |
| Lock granted twice | Failover to a stale replica (single instance) | Redlock for availability + fencing for safety |

**Flash cards**
- **Acquire?** → `SET res token NX PX ttl` — one atomic command.
- **Release?** → Lua: delete only if value == your token. Never a plain `DEL`.
- **Why unique token?** → So release can't delete a successor's lock.
- **Fencing token?** → Monotonic number the resource checks; defends against a paused holder.
- **Redlock gives?** → Availability (majority of N masters), NOT correctness under pauses.
- **Efficiency vs correctness?** → Efficiency → single-instance Redis lock. Correctness → fencing or ZooKeeper/etcd.

## 11. Hands-On Exercises & Mini Project

- [ ] Implement acquire with `SET NX PX` and a unique token, and release with a Lua compare-and-delete; write a test proving a stale holder can't delete a successor's lock.
- [ ] Reproduce the naive-`DEL` bug: hold a short TTL, sleep past expiry, let a second client acquire, then `DEL` from the first and observe you deleted the second's lock.
- [ ] Add a fencing token via `INCR`, build a mock resource that high-water-marks tokens, and show a paused holder's stale-token write being rejected.
- [ ] Add a compare-and-extend watchdog for long work, and demonstrate that a pause longer than the TTL still loses the lock despite it.
- [ ] Add retry-with-backoff-and-jitter on contention and measure the round trips saved versus a busy-wait loop.
- [ ] Simulate a single-instance failover to a stale replica and observe the lock being granted twice; note why fencing is what saves you.

### Mini Project — "Fenced Job Runner"

**Goal.** Build a lock that guards a job, and prove empirically where a Redis lock is enough and where only fencing is.

**Requirements.**
1. Implement the correct single-instance lock: `SET NX PX` acquire, unique token, Lua compare-and-delete release, and a compare-and-extend watchdog.
2. Guard a simulated job whose side effect is idempotent-checked by a mock resource that maintains a high-water fencing token.
3. Inject faults: overrun the TTL, simulate a stop-the-world pause longer than the TTL, and a failover to a stale replica.
4. Show that without fencing the job runs twice and corrupts the resource; with fencing the second (stale) execution is rejected and the resource stays consistent.
5. Record metrics: acquire contention rate, hold time vs TTL, watchdog extensions, and fence rejections.

**Extensions.**
- Implement Redlock across 5 local Redis instances and compare its acquire cost and availability under a single-node failure to the single-instance lock.
- Swap the lock for an etcd/ZooKeeper lease with its built-in fencing (mod-revision / zxid) and compare the correctness story and the latency.
- Chart double-execution rate against TTL length with and without a watchdog, demonstrating that no TTL removes the pause window.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Redis as a Cache* (single-threaded atomicity that makes `SET NX` a correct primitive), *Build: Pipelining, Transactions & Lua Scripting* (the Lua compare-and-delete used here), *Replication & Sentinel* (async replication and the failover-loses-the-lock problem), *Cache Stampede & the Thundering Herd* (a per-key lock as an efficiency lock in practice), *Redis Cluster* (co-locating lock and fence keys with hash tags).

- **Redis — Distributed Locks with Redis (the Redlock reference)** — Redis / antirez · *Advanced* · the canonical description of the single-instance recipe and the Redlock algorithm, with the correctness caveats stated. <https://redis.io/docs/latest/develop/use/patterns/distributed-locks/>
- **How to do distributed locking** — Martin Kleppmann · *Advanced* · the critique that started the debate: why TTL locks are unsafe under pauses/clock skew and why you need fencing tokens. <https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html>
- **Is Redlock safe?** — Salvatore Sanfilippo (antirez) · *Advanced* · the rebuttal; read alongside Kleppmann for the full argument. <http://antirez.com/news/101>
- **Designing Data-Intensive Applications, ch. 8 (fencing tokens, unreliable clocks)** — Martin Kleppmann · *Advanced* · the textbook treatment of pauses, clocks, and why fencing is the fix. <https://dataintensive.net/>
- **ZooKeeper — recipes: locks** — Apache ZooKeeper · *Advanced* · a consensus-backed lock with a built-in monotonic zxid usable as a fencing token, for correctness-critical locks. <https://zookeeper.apache.org/doc/current/recipes.html>
- **etcd — distributed locks & concurrency API** — etcd / CNCF · *Advanced* · lease-based locks with mod-revision as a fencing token, the modern consensus alternative. <https://etcd.io/docs/latest/tutorials/how-to-create-locks/>
- **Redisson — distributed locks (watchdog, fair locks)** — Redisson · *Intermediate* · a mature Java implementation showing lease renewal (watchdog) and Redlock in production code. <https://github.com/redisson/redisson/wiki/8.-distributed-locks-and-synchronizers>
- **go-redis / redsync — Redlock for Go** — go-redsync · *Intermediate* · a Go implementation of the algorithm to study and stress-test against the caveats above. <https://github.com/go-redsync/redsync>

---

*Caching with Redis Handbook — chapter 23.*
