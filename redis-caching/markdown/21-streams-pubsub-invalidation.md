# 21 · Pub/Sub & Streams for Cache Invalidation

> **In one line:** Broadcasting "this key changed, drop it" to every app instance is easy with Pub/Sub and fatally lossy — a disconnected subscriber silently misses the message — so use Pub/Sub only for best-effort near-cache eviction backed by a TTL, and reach for Redis Streams with consumer groups when a missed invalidation is a correctness bug you cannot afford.

---

## 1. Overview

Distributed caches have a hard problem: when the underlying data changes, every copy of it — in Redis, in each app instance's local memory, in a CDN — must be invalidated, and they must be told *quickly*. The moment you add a per-instance near cache (a small in-process map in front of Redis, chapter 27), a single write in one place must reach every other instance to evict their stale copies. That is a fan-out messaging problem, and Redis offers two very different tools for it: **Pub/Sub** and **Streams**.

**Pub/Sub** is the obvious first reach. `PUBLISH` a message to a channel, and every instance that has `SUBSCRIBE`d receives it — instant fan-out to all listeners, trivially simple. It is perfect for "tell everyone to drop key X". But it has one fatal property: it is **fire-and-forget with no persistence**. A subscriber that is disconnected, restarting, or momentarily slow at the instant of publish simply never sees the message — there is no queue, no replay, no acknowledgement. For invalidation, a missed message means an instance keeps serving stale data indefinitely, which is exactly the bug you were trying to prevent.

**Redis Streams** are the durable answer. A stream is an append-only log; `XADD` appends an invalidation event, and consumers read it with `XREADGROUP` through a **consumer group** that tracks each consumer's position, redelivers unacknowledged messages, and lets a returning consumer replay everything it missed from its last offset. That is at-least-once delivery: a consumer that was down catches up when it returns, and `XACK` confirms processing. The cost is more moving parts than Pub/Sub. There is also a third mechanism — **keyspace notifications** — where Redis itself emits events when keys change or expire, so you can invalidate without your application explicitly publishing.

This chapter is about choosing correctly: Pub/Sub for best-effort near-cache eviction where a TTL is the safety net, Streams for must-not-miss invalidation, and keyspace notifications for reacting to Redis's own key lifecycle events.

## 2. Core Concepts

- **Pub/Sub** — publish/subscribe messaging: `PUBLISH channel msg` fans out to all current `SUBSCRIBE`rs of that channel; no persistence, no acknowledgement.
- **Channel** — the named topic Pub/Sub messages are published to and subscribed from; `PSUBSCRIBE` matches channel patterns.
- **Fire-and-forget** — Pub/Sub's delivery model: a message is delivered only to currently-connected subscribers and then gone; a disconnected subscriber misses it forever.
- **Redis Stream** — an append-only log of entries, each with an auto-generated `ID` (timestamp-sequence) and field/value pairs; `XADD` appends, `XRANGE`/`XREAD` reads.
- **Consumer group** — a named group of consumers sharing a stream, where each entry is delivered to exactly one group member, positions are tracked, and unacked entries can be redelivered.
- **`XREADGROUP`** — reads new (or pending) entries for a consumer within a group, advancing the group's last-delivered position.
- **`XACK`** — acknowledges that a consumer finished processing an entry, removing it from the pending list; without it the entry is eligible for redelivery.
- **PEL (Pending Entries List)** — per-group record of delivered-but-unacked entries; the basis of at-least-once redelivery and crash recovery (`XPENDING`, `XCLAIM`).
- **At-least-once delivery** — Streams' guarantee: an entry is delivered until acknowledged, so consumers may see it more than once (handle idempotently) but never zero times.
- **Keyspace notifications** — Redis-emitted events on key changes/expiry, published on `__keyspace@N__:*` / `__keyevent@N__:*` channels, enabled via `notify-keyspace-events`.

## 3. Theory & Principles

### Pub/Sub: instant fan-out, zero durability

Pub/Sub's model is a broadcast. When you `PUBLISH invalidate "user:9"`, Redis immediately delivers that message to every client currently subscribed to the `invalidate` channel, then forgets it. There is no storage: the message exists only in the instant of delivery. This gives Pub/Sub its two defining traits — it is beautifully simple and low-latency for fan-out, and it is completely lossy for anyone not listening at that exact moment.

For cache invalidation the fan-out is exactly right: every app instance subscribes to an invalidation channel, and a write anywhere publishes the changed key, so all instances evict their local copy near-instantly. The loss is the problem. Consider the failure sequence: an instance's subscriber connection blips (a network hiccup, a GC pause, a redeploy) for 200 ms, and during that window a `PUBLISH invalidate "user:9"` goes out. That instance never receives it. Its local cache keeps the stale `user:9` until something else evicts it — and if the local entry had no TTL, that is *forever*. Pub/Sub gives you no way to detect or recover the miss: no queue held it, no acknowledgement was expected, no replay is possible.

The correct way to use Pub/Sub for invalidation, therefore, is to accept that it is **best-effort** and back it with a **TTL safety net**. The near-cache entries carry a short TTL (say 5–30 seconds), so even if an invalidation message is missed, the stale copy self-corrects within that bound. Pub/Sub then does its job of making the *common* case fast — evict promptly on write — while the TTL guarantees the *worst* case is bounded staleness, not permanent staleness. That combination is genuinely good for near caches. What Pub/Sub must never be is your *only* guarantee for an invalidation that must not be missed.

### Streams: durable, replayable, acknowledged

A Stream inverts Pub/Sub's trade. `XADD invalidations * key user:9` appends an entry to a persistent, ordered log that stays until you trim it. Consumers read via `XREADGROUP`, and a **consumer group** maintains, per group, the last-delivered ID and a **Pending Entries List** of entries that were delivered but not yet `XACK`ed. This buys the guarantees Pub/Sub lacks:

- **No loss on disconnect.** A consumer that goes down and comes back calls `XREADGROUP ... >` and receives every entry appended while it was gone — it replays from the group's position. Nothing is missed.
- **At-least-once via acknowledgement.** An entry stays in the PEL until the consumer `XACK`s it. If the consumer crashes mid-processing, the entry remains pending and can be redelivered (to the same or, via `XCLAIM`/`XAUTOCLAIM`, another consumer). Delivery is *at least* once, so handlers must be idempotent.
- **Replay from an offset.** Because the log persists, you can re-read history (`XRANGE`) — reprocess a window of invalidations after a bug, or warm a new cache from recent events.
- **Load-shared consumers.** Within a group, each entry goes to exactly one consumer, so N app instances in a group share the invalidation work; across *different* groups, each group gets its own copy (fan-out to multiple independent subsystems).

The price is complexity and memory: you manage groups, acknowledge entries, handle idempotency, claim stalled entries, and trim the log (`XADD MAXLEN` or `XTRIM`) so it does not grow unbounded. But for invalidation that *must* land — a permission revocation, a price change, a GDPR deletion — that price buys correctness Pub/Sub cannot.

```svg
<svg viewBox="0 0 880 500" width="100%" height="500" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Pub/Sub vs Streams for invalidation: the disconnected subscriber</text>

  <rect x="24" y="42" width="410" height="230" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="229" y="64" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Pub/Sub &#8212; fire-and-forget</text>

  <rect x="44" y="80" width="120" height="30" rx="5" fill="#fee2e2" stroke="#dc2626"/>
  <text x="104" y="100" text-anchor="middle" fill="#b91c1c" font-size="9" font-weight="bold">PUBLISH invalidate</text>
  <path d="M164,95 L200,95" stroke="#dc2626" stroke-width="2" marker-end="url(#pa)"/>
  <defs>
    <marker id="pa" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
    <marker id="ga" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>

  <rect x="204" y="80" width="90" height="30" rx="5" fill="#fecaca" stroke="#dc2626"/>
  <text x="249" y="100" text-anchor="middle" fill="#b91c1c" font-size="9" font-weight="bold">channel</text>

  <path d="M249,110 L120,140" stroke="#16a34a" stroke-width="1.5" marker-end="url(#ga)"/>
  <path d="M249,110 L249,140" stroke="#16a34a" stroke-width="1.5" marker-end="url(#ga)"/>
  <path d="M290,110 L370,140" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#pa)"/>

  <rect x="60" y="144" width="120" height="34" rx="5" fill="#dcfce7" stroke="#16a34a"/>
  <text x="120" y="160" text-anchor="middle" fill="#15803d" font-size="9">instance A (up)</text>
  <text x="120" y="173" text-anchor="middle" fill="#166534" font-size="8">evicts &#8212; OK</text>
  <rect x="189" y="144" width="120" height="34" rx="5" fill="#dcfce7" stroke="#16a34a"/>
  <text x="249" y="160" text-anchor="middle" fill="#15803d" font-size="9">instance B (up)</text>
  <text x="249" y="173" text-anchor="middle" fill="#166534" font-size="8">evicts &#8212; OK</text>
  <rect x="318" y="144" width="100" height="34" rx="5" fill="#fff" stroke="#dc2626" stroke-dasharray="4 3"/>
  <text x="368" y="158" text-anchor="middle" fill="#b91c1c" font-size="9">instance C</text>
  <text x="368" y="171" text-anchor="middle" fill="#b91c1c" font-size="8">reconnecting...</text>

  <rect x="44" y="190" width="374" height="70" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="229" y="210" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">C was disconnected at publish time</text>
  <text x="60" y="228" fill="#991b1b" font-size="9">&#8594; message is GONE. No queue, no replay, no ack.</text>
  <text x="60" y="244" fill="#991b1b" font-size="9">&#8594; C serves STALE user:9 until its TTL saves it.</text>
  <text x="60" y="256" fill="#991b1b" font-size="8" font-weight="bold">No TTL = stale forever. Pub/Sub cannot detect the miss.</text>

  <rect x="446" y="42" width="410" height="230" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="651" y="64" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Streams + consumer group &#8212; durable</text>

  <rect x="466" y="80" width="110" height="30" rx="5" fill="#dcfce7" stroke="#16a34a"/>
  <text x="521" y="100" text-anchor="middle" fill="#15803d" font-size="9" font-weight="bold">XADD invalidations</text>
  <path d="M576,95 L606,95" stroke="#16a34a" stroke-width="2" marker-end="url(#ga)"/>
  <g font-family="ui-monospace,monospace" font-size="8">
    <rect x="610" y="82" width="30" height="26" fill="#bbf7d0" stroke="#16a34a"/><text x="625" y="98" text-anchor="middle" fill="#14532d">e1</text>
    <rect x="642" y="82" width="30" height="26" fill="#bbf7d0" stroke="#16a34a"/><text x="657" y="98" text-anchor="middle" fill="#14532d">e2</text>
    <rect x="674" y="82" width="30" height="26" fill="#bbf7d0" stroke="#16a34a"/><text x="689" y="98" text-anchor="middle" fill="#14532d">e3</text>
    <rect x="706" y="82" width="30" height="26" fill="#fef3c7" stroke="#d97706"/><text x="721" y="98" text-anchor="middle" fill="#92400e">e4</text>
  </g>
  <text x="740" y="98" fill="#166534" font-size="8" font-family="ui-sans-serif,system-ui,sans-serif">persisted log</text>

  <rect x="466" y="120" width="110" height="34" rx="5" fill="#dcfce7" stroke="#16a34a"/>
  <text x="521" y="136" text-anchor="middle" fill="#15803d" font-size="9">consumer A</text>
  <text x="521" y="149" text-anchor="middle" fill="#166534" font-size="8">XREADGROUP + XACK</text>
  <rect x="586" y="120" width="110" height="34" rx="5" fill="#fff" stroke="#16a34a" stroke-dasharray="4 3"/>
  <text x="641" y="136" text-anchor="middle" fill="#15803d" font-size="9">consumer C (was down)</text>
  <text x="641" y="149" text-anchor="middle" fill="#166534" font-size="8">replays from offset</text>

  <rect x="466" y="164" width="370" height="96" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="651" y="184" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">C returns &#8594; XREADGROUP ... &gt;</text>
  <text x="482" y="202" fill="#166534" font-size="9">&#8594; receives EVERY entry it missed (replay from position)</text>
  <text x="482" y="218" fill="#166534" font-size="9">&#8594; PEL tracks unacked; crash &#8594; redeliver (XCLAIM)</text>
  <text x="482" y="234" fill="#166534" font-size="9">&#8594; at-least-once: never zero, maybe &gt;1 (be idempotent)</text>
  <text x="482" y="252" fill="#15803d" font-size="8" font-weight="bold">No invalidation is ever lost. Cost: acks, trimming, idempotency.</text>

  <rect x="24" y="284" width="832" height="206" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="306" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Which to use for invalidation</text>
  <rect x="48" y="320" width="390" height="156" rx="6" fill="#fff" stroke="#64748b"/>
  <text x="243" y="340" text-anchor="middle" fill="#b91c1c" font-size="11" font-weight="bold">Pub/Sub &#8212; best-effort near-cache eviction</text>
  <text x="64" y="362" fill="#475569" font-size="9">&#8226; evict local/near caches on write, fast fan-out</text>
  <text x="64" y="380" fill="#475569" font-size="9">&#8226; ALWAYS pair with a short TTL as the safety net</text>
  <text x="64" y="398" fill="#475569" font-size="9">&#8226; missed message &#8594; bounded staleness, self-heals</text>
  <text x="64" y="420" fill="#334155" font-size="9" font-weight="bold">use when: a miss is tolerable (TTL bounds it)</text>
  <text x="64" y="442" fill="#475569" font-size="9">e.g. evicting a 10s in-process cache of hot config</text>
  <text x="64" y="462" fill="#334155" font-size="9" font-weight="bold">simple, low-latency, lossy</text>

  <rect x="454" y="320" width="382" height="156" rx="6" fill="#fff" stroke="#64748b"/>
  <text x="645" y="340" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">Streams &#8212; must-not-miss invalidation</text>
  <text x="470" y="362" fill="#475569" font-size="9">&#8226; durable, replayable, acknowledged (at-least-once)</text>
  <text x="470" y="380" fill="#475569" font-size="9">&#8226; consumers catch up after downtime, no loss</text>
  <text x="470" y="398" fill="#475569" font-size="9">&#8226; idempotent handlers, XACK, trim the log</text>
  <text x="470" y="420" fill="#334155" font-size="9" font-weight="bold">use when: a miss is a correctness bug</text>
  <text x="470" y="442" fill="#475569" font-size="9">e.g. permission revoke, price change, GDPR delete</text>
  <text x="470" y="462" fill="#334155" font-size="9" font-weight="bold">durable, exactly where correctness demands it</text>
</svg>
```

### Keyspace notifications: let Redis tell you

There is a third path where Redis itself is the event source. With `notify-keyspace-events` enabled, Redis publishes an event every time a key is modified, deleted, or expires, on two families of Pub/Sub channels: `__keyspace@0__:<key>` (keyed by the key, message = the event) and `__keyevent@0__:<event>` (keyed by the event, message = the key). The classic use is reacting to **expiry**: subscribe to `__keyevent@0__:expired` and you learn the moment a key's TTL fires, letting you refresh a downstream cache, clean up a related resource, or trigger recomputation. It is invaluable for "do X when this cached thing expires" without polling.

Two caveats make it a specialised tool, not a general invalidation bus. First, it is delivered over **Pub/Sub**, so it inherits the same fire-and-forget loss — a disconnected subscriber misses expiry events (Redis 7.4+ adds a keyspace-notification-via-Streams path in some setups, but classic keyspace notifications are Pub/Sub). Second, the `expired` event fires when Redis *actually* removes the key, which for a lazily-expired key can be later than its logical expiry time — so it is not a precise timer. Use keyspace notifications for reactive housekeeping where best-effort timing is fine, and back correctness-critical reactions with the same durability thinking as any Pub/Sub use.

## 4. Architecture & Workflow

### The invalidation broadcast workflow

The near-cache invalidation pattern with Pub/Sub:

1. **Each instance subscribes** to an invalidation channel on startup and keeps the subscription open, evicting from its local cache on each message.
2. **On a write** (in any instance), after updating the source of truth and the Redis cache, `PUBLISH invalidate <key>`.
3. **Every subscribed instance** receives the key and drops it from its local near cache.
4. **Every local entry carries a short TTL**, so a missed message self-corrects within the TTL — the safety net that makes the lossy channel acceptable.

The must-not-miss pattern with Streams:

1. **On a change**, `XADD invalidations * key <key> op <delete|update>` — append a durable event.
2. **Each subsystem** that must react runs a **consumer group** (`XGROUP CREATE`), and its consumers `XREADGROUP ... >` to get new events, process them (evict, recompute), then `XACK`.
3. **On restart**, a consumer first drains its **pending** entries (`XREADGROUP ... 0`) — the ones delivered but not acked before it died — then resumes new ones, so nothing is lost across a crash.
4. **A janitor** periodically `XAUTOCLAIM`s entries stuck in another consumer's PEL (a permanently-dead consumer) and `XTRIM`s the stream to a bounded length so it does not grow forever.
5. **Handlers are idempotent** because delivery is at-least-once — evicting an already-evicted key must be a no-op, recomputing must be safe to repeat.

### Choosing the mechanism

```
Is a missed invalidation a correctness bug?
  ├── No  → Pub/Sub + short TTL near cache        (simple, fast, best-effort)
  └── Yes → Streams + consumer group + XACK       (durable, replayable, at-least-once)

Do you want to react to Redis's own key lifecycle (expiry/eviction)?
  └── keyspace notifications (Pub/Sub-delivered; best-effort timing)
```

The decisive question is the cost of a miss. Evicting a 10-second in-process cache of hot config? A missed Pub/Sub message costs you up to 10 seconds of staleness — fine, use Pub/Sub with the TTL. Revoking a user's access after a permission change, or dropping a cached price after it changes? A missed message means serving a wrong, security- or money-relevant answer indefinitely — use Streams so the event is durable and replayed. Many systems use both: Pub/Sub for the fast, best-effort near-cache layer and Streams for the authoritative invalidation of the shared Redis cache and downstream stores.

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="sa" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
  </defs>
  <text x="440" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">A two-tier invalidation bus: one write drives both paths</text>

  <rect x="360" y="42" width="160" height="46" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="440" y="62" text-anchor="middle" fill="#92400e" font-size="11" font-weight="bold">WRITE occurs</text>
  <text x="440" y="80" text-anchor="middle" fill="#b45309" font-size="9">update DB + shared Redis cache</text>

  <path d="M400,88 L230,120" stroke="#334155" stroke-width="1.5" fill="none" marker-end="url(#sa)"/>
  <path d="M480,88 L650,120" stroke="#334155" stroke-width="1.5" fill="none" marker-end="url(#sa)"/>

  <rect x="24" y="124" width="410" height="256" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="229" y="146" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Tier 1: PUBLISH invalidate key</text>
  <text x="229" y="164" text-anchor="middle" fill="#991b1b" font-size="9">best-effort near-cache eviction</text>
  <rect x="44" y="176" width="370" height="30" rx="4" fill="#fff" stroke="#fca5a5"/>
  <text x="229" y="196" text-anchor="middle" fill="#b91c1c" font-size="9" font-family="ui-monospace,monospace">all instances SUBSCRIBE &#8594; evict local copy</text>
  <text x="60" y="228" fill="#991b1b" font-size="9">&#8226; fast fan-out, near-instant</text>
  <text x="60" y="246" fill="#991b1b" font-size="9">&#8226; disconnected instance MISSES it (no replay)</text>
  <rect x="44" y="258" width="370" height="60" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="229" y="278" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">SAFETY NET: short TTL on near-cache entries</text>
  <text x="60" y="298" fill="#166534" font-size="9">missed message &#8594; stale for at most the TTL, then</text>
  <text x="60" y="312" fill="#166534" font-size="9">self-corrects on next read. Bounded, not forever.</text>
  <text x="229" y="344" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">use when: a miss is tolerable</text>
  <text x="229" y="364" text-anchor="middle" fill="#991b1b" font-size="9">hot config, feed metadata, anything TTL-bounded</text>

  <rect x="446" y="124" width="410" height="256" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="651" y="146" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Tier 2: XADD invalidations key op</text>
  <text x="651" y="164" text-anchor="middle" fill="#166534" font-size="9">durable, must-not-miss invalidation</text>
  <rect x="466" y="176" width="370" height="30" rx="4" fill="#fff" stroke="#86efac"/>
  <text x="651" y="196" text-anchor="middle" fill="#15803d" font-size="9" font-family="ui-monospace,monospace">consumer group: XREADGROUP &#8594; evict &#8594; XACK</text>
  <text x="482" y="228" fill="#166534" font-size="9">&#8226; durable log &#8594; down consumer replays on return</text>
  <text x="482" y="246" fill="#166534" font-size="9">&#8226; PEL redelivers unacked (crash recovery)</text>
  <text x="482" y="264" fill="#166534" font-size="9">&#8226; at-least-once &#8594; idempotent handlers</text>
  <text x="482" y="282" fill="#166534" font-size="9">&#8226; XAUTOCLAIM reclaims dead consumers' entries</text>
  <text x="482" y="300" fill="#166534" font-size="9">&#8226; XADD MAXLEN ~ N bounds the log memory</text>
  <rect x="466" y="312" width="370" height="26" rx="4" fill="#dcfce7" stroke="#16a34a"/>
  <text x="651" y="330" text-anchor="middle" fill="#15803d" font-size="9" font-weight="bold">no invalidation is EVER lost</text>
  <text x="651" y="356" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">use when: a miss is a correctness bug</text>
  <text x="651" y="374" text-anchor="middle" fill="#166534" font-size="9">permission revoke, price change, GDPR delete</text>
</svg>
```

## 5. Implementation

Real go-redis implementations: a Pub/Sub invalidation broadcaster with a TTL-backed near cache, and a Streams consumer group that never loses an event.

```go
package invalidation

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// ---------- PUB/SUB: best-effort near-cache eviction ----------

const invalidateChannel = "cache:invalidate"

// NearCache is a tiny in-process cache in front of Redis. Every entry carries a
// short TTL so that even a MISSED Pub/Sub invalidation self-corrects within the
// TTL — the safety net that makes fire-and-forget acceptable.
type NearCache struct {
	mu  sync.RWMutex
	ttl time.Duration
	m   map[string]entry
}

type entry struct {
	val     string
	expires time.Time
}

func NewNearCache(ttl time.Duration) *NearCache {
	return &NearCache{ttl: ttl, m: make(map[string]entry)}
}

func (c *NearCache) Get(key string) (string, bool) {
	c.mu.RLock()
	e, ok := c.m[key]
	c.mu.RUnlock()
	if !ok || time.Now().After(e.expires) {
		return "", false // absent or TTL-expired: the safety net firing
	}
	return e.val, true
}

func (c *NearCache) Set(key, val string) {
	c.mu.Lock()
	c.m[key] = entry{val: val, expires: time.Now().Add(c.ttl)}
	c.mu.Unlock()
}

func (c *NearCache) evict(key string) {
	c.mu.Lock()
	delete(c.m, key)
	c.mu.Unlock()
}

// PublishInvalidation is called after a write updates the source of truth and
// the shared Redis cache. It fans out the changed key to ALL instances. It is
// fire-and-forget: instances that are disconnected right now will miss it, which
// is why the near cache above has a TTL.
func PublishInvalidation(ctx context.Context, rdb *redis.Client, key string) error {
	return rdb.Publish(ctx, invalidateChannel, key).Err()
}

// SubscribeInvalidations runs for the lifetime of the instance, evicting keys
// from the local near cache as invalidation messages arrive. Fast and simple —
// and lossy, which the TTL compensates for.
func SubscribeInvalidations(ctx context.Context, rdb *redis.Client, cache *NearCache) {
	sub := rdb.Subscribe(ctx, invalidateChannel)
	defer sub.Close()
	ch := sub.Channel() // go-redis auto-reconnects, but messages during a gap are LOST
	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-ch:
			if !ok {
				return
			}
			cache.evict(msg.Payload) // drop the stale local copy
		}
	}
}

// ---------- STREAMS: must-not-miss invalidation ----------

const (
	invalidateStream = "cache:invalidations"
	invalidateGroup  = "cache-evictors"
)

// PublishDurableInvalidation appends a DURABLE invalidation event. MAXLEN with
// the approximate flag (~) caps the log length cheaply so it cannot grow
// unbounded, while keeping enough history for a returning consumer to replay.
func PublishDurableInvalidation(ctx context.Context, rdb *redis.Client, key, op string) error {
	return rdb.XAdd(ctx, &redis.XAddArgs{
		Stream: invalidateStream,
		MaxLen: 100000, // keep the last ~100k events
		Approx: true,   // "~" — trim in efficient whole-node chunks
		Values: map[string]any{"key": key, "op": op},
	}).Err()
}

// EnsureGroup creates the consumer group if it does not exist. "$" means the
// group starts reading only NEW entries; use "0" to replay the whole stream.
// MKSTREAM creates the stream if it is not there yet.
func EnsureGroup(ctx context.Context, rdb *redis.Client) error {
	err := rdb.XGroupCreateMkStream(ctx, invalidateStream, invalidateGroup, "$").Err()
	if err != nil && err.Error() != "BUSYGROUP Consumer Group name already exists" {
		return err
	}
	return nil
}

// RunConsumer processes invalidations with at-least-once semantics and NO loss
// across restarts. On start it FIRST drains its own pending (delivered but
// unacked) entries, then reads new ones. Handlers must be idempotent because an
// entry may be delivered more than once (crash between processing and XACK).
func RunConsumer(ctx context.Context, rdb *redis.Client, consumer string, evict func(key, op string)) error {
	if err := EnsureGroup(ctx, rdb); err != nil {
		return err
	}

	// Phase 1: recover our OWN pending entries (id "0" = the PEL for this
	// consumer). These were delivered to us before a previous crash and never
	// acked — process and ack them so nothing from before the crash is lost.
	if err := drain(ctx, rdb, consumer, "0", evict); err != nil {
		return err
	}

	// Phase 2: consume NEW entries forever. ">" = entries never delivered to any
	// consumer in the group. Blocks until entries arrive.
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := drain(ctx, rdb, consumer, ">", evict); err != nil {
			// Transient error (e.g. connection blip): back off and retry. Because
			// the stream is durable, nothing is lost while we are away.
			log.Printf("consumer %s read error: %v", consumer, err)
			time.Sleep(time.Second)
		}
	}
}

// drain reads a batch from the given start id, processes each entry, and ACKs it.
// The XACK is what removes the entry from the pending list; skip it and the entry
// will be redelivered — which is the safety property, not a bug.
func drain(ctx context.Context, rdb *redis.Client, consumer, start string, evict func(key, op string)) error {
	res, err := rdb.XReadGroup(ctx, &redis.XReadGroupArgs{
		Group:    invalidateGroup,
		Consumer: consumer,
		Streams:  []string{invalidateStream, start},
		Count:    64,
		Block:    5 * time.Second, // block-wait for new entries on ">"
	}).Result()
	if err == redis.Nil {
		return nil // no entries this round (timeout) — normal
	}
	if err != nil {
		return err
	}
	for _, stream := range res {
		for _, msg := range stream.Messages {
			key, _ := msg.Values["key"].(string)
			op, _ := msg.Values["op"].(string)
			evict(key, op) // MUST be idempotent (at-least-once delivery)
			// Acknowledge only AFTER successful processing.
			if err := rdb.XAck(ctx, invalidateStream, invalidateGroup, msg.ID).Err(); err != nil {
				return err
			}
		}
	}
	return nil
}

// ReclaimStalled is a periodic janitor: it claims entries stuck in a DEAD
// consumer's pending list (delivered, never acked, idle beyond the threshold)
// so a live consumer can finish them. Without this, a crashed consumer's
// in-flight entries would never be reprocessed.
func ReclaimStalled(ctx context.Context, rdb *redis.Client, consumer string, evict func(key, op string)) error {
	msgs, _, err := rdb.XAutoClaim(ctx, &redis.XAutoClaimArgs{
		Stream:   invalidateStream,
		Group:    invalidateGroup,
		Consumer: consumer,
		MinIdle:  30 * time.Second, // entries idle > 30s are presumed abandoned
		Start:    "0",
		Count:    64,
	}).Result()
	if err != nil {
		return err
	}
	for _, msg := range msgs {
		key, _ := msg.Values["key"].(string)
		op, _ := msg.Values["op"].(string)
		evict(key, op)
		if err := rdb.XAck(ctx, invalidateStream, invalidateGroup, msg.ID).Err(); err != nil {
			return err
		}
	}
	return nil
}

// ---------- KEYSPACE NOTIFICATIONS: react to expiry ----------

// SubscribeExpiries reacts to keys expiring in database 0. Requires the server
// config `notify-keyspace-events Ex` (E = keyevent, x = expired). Delivered over
// Pub/Sub, so it is BEST-EFFORT — a disconnected subscriber misses expiries, and
// the event fires when Redis actually removes the key, not exactly at TTL.
func SubscribeExpiries(ctx context.Context, rdb *redis.Client, onExpire func(key string)) {
	sub := rdb.PSubscribe(ctx, "__keyevent@0__:expired")
	defer sub.Close()
	ch := sub.Channel()
	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-ch:
			if !ok {
				return
			}
			onExpire(msg.Payload) // payload is the expired key's name
		}
	}
}
```

The Pub/Sub path is a dozen lines and lossy-but-fine because the near cache has a TTL; the Streams path is longer precisely because it earns its guarantee — draining pending entries on restart, acknowledging only after processing, and reclaiming a dead consumer's in-flight work. That extra code is the difference between "usually invalidated" and "never misses".

## 6. Advantages, Disadvantages & Trade-offs

**Pub/Sub advantages**
- **Trivially simple.** One `PUBLISH`, one `SUBSCRIBE`; near-instant fan-out to all listeners.
- **Low latency.** No storage, no acknowledgement round trips — the message is delivered the moment it is published.
- **Natural broadcast.** Every subscriber gets every message, exactly what near-cache eviction wants.

**Pub/Sub disadvantages**
- **No persistence — lossy.** A disconnected, restarting, or slow subscriber misses the message forever; there is no queue or replay.
- **No acknowledgement.** You cannot tell whether anyone received it, so you cannot detect or recover a miss.
- **Unbounded slow-consumer risk.** A subscriber that cannot keep up has messages buffered until limits force a disconnect (and then it misses more).

**Streams advantages**
- **Durable and replayable.** Events persist; a returning consumer replays from its offset and misses nothing.
- **At-least-once with acknowledgement.** The PEL tracks unacked entries; crashes redeliver, so processing is guaranteed.
- **Load-sharing and fan-out.** Consumers in a group share work; separate groups each get a full copy.

**Streams disadvantages**
- **More complexity.** Groups, acks, idempotency, claiming stalled entries, trimming — real operational surface.
- **Memory and trimming.** The log grows until trimmed; you must cap it (`MAXLEN`) and reason about retention.
- **At-least-once, not exactly-once.** Handlers must be idempotent because an entry can be delivered more than once.

**Trade-offs**
- *Pub/Sub vs Streams:* speed and simplicity with loss (Pub/Sub) vs durability and guarantees with complexity (Streams). Choose by whether a missed invalidation is tolerable or a correctness bug.
- *TTL as safety net:* Pub/Sub becomes acceptable for invalidation *only* when a short TTL bounds the staleness of a missed message; the shorter the TTL, the safer but the less the near cache helps.
- *Stream retention vs memory:* a longer log allows longer replay/catch-up windows but costs memory; trim to the longest downtime you must survive.
- *Keyspace notifications vs explicit events:* letting Redis emit change/expiry events is zero-app-code but Pub/Sub-lossy and imprecisely timed; explicit `XADD` events are durable but require your write path to publish them.

## 7. Common Mistakes & Best Practices

- **Using Pub/Sub as the only guarantee for must-not-miss invalidation.** A single disconnect drops the message and the data stays stale indefinitely. **Best practice:** Pub/Sub only for best-effort eviction, backed by a TTL; Streams when a miss is a correctness bug.
- **Pub/Sub near cache with no TTL.** A missed message means permanent staleness with no self-healing. **Best practice:** every near-cache entry carries a short TTL so misses self-correct within a bound.
- **Not acknowledging Stream entries (or acking before processing).** No `XACK` means endless redelivery; acking before the work is done means a crash loses the event. **Best practice:** `XACK` only after successful processing.
- **Non-idempotent Stream handlers.** At-least-once delivery means an entry can arrive twice; a non-idempotent handler double-applies. **Best practice:** make eviction/recompute idempotent (evicting an absent key is a no-op).
- **Never trimming the stream.** The log grows unbounded and eventually dominates memory. **Best practice:** `XADD ... MAXLEN ~ N` or a periodic `XTRIM` sized to your maximum catch-up window.
- **Ignoring dead consumers' pending entries.** A crashed consumer's in-flight entries sit unacked forever. **Best practice:** run an `XAUTOCLAIM` janitor to reclaim entries idle beyond a threshold.
- **Enabling all keyspace notifications.** `notify-keyspace-events KEA` publishes an event for *every* operation, a heavy Pub/Sub load. **Best practice:** enable only the classes you consume (e.g. `Ex` for expiry).
- **Best practice overall: match durability to the cost of a miss.** Fast and lossy (Pub/Sub + TTL) where staleness is bounded and cheap; durable and acknowledged (Streams) where a missed invalidation is wrong, unsafe, or costly.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** For Pub/Sub, `PUBSUB CHANNELS` lists active channels and `PUBSUB NUMSUB <channel>` shows how many subscribers are attached — a count lower than your instance count means some instances are not subscribed (and are missing invalidations). For Streams, `XINFO STREAM`/`XINFO GROUPS` show length, last-delivered id and per-group lag; `XPENDING` shows delivered-but-unacked entries (a growing PEL means a stuck or dead consumer); `XRANGE` inspects recent events.
- **Monitoring.** For Streams, alert on **consumer lag** (the gap between the stream's tip and a group's last-delivered id) and on **PEL size** (unacked backlog) — both indicate consumers falling behind or failing, which for invalidation means growing staleness. For Pub/Sub, monitor subscriber count against expected instance count, and watch client output-buffer limits (a slow subscriber that gets disconnected). Track stream length against your `MAXLEN` to confirm trimming works.
- **Security.** Pub/Sub and Streams are commands like any other, so they are governed by ACLs — restrict who can `PUBLISH`/`XADD` to invalidation channels/streams, because an attacker who can publish arbitrary invalidations can force a cache stampede (mass eviction → thundering herd on the origin) or, worse, suppress invalidations. Invalidation messages should carry keys, not sensitive payloads. Keyspace notifications can leak the *existence and names* of keys to any subscriber, so treat the notification channels as sensitive and lock them down with ACLs (chapter 29).
- **Scaling.** Pub/Sub fan-out is O(subscribers) on the publishing node's thread — a very large subscriber count makes each `PUBLISH` more expensive, and in Cluster, classic Pub/Sub broadcasts to all nodes (sharded Pub/Sub, `SPUBLISH`/`SSUBSCRIBE`, confines it to a slot's node for scale). Streams scale by adding consumers to a group (work is shared) and by sharding into multiple streams keyed by some partition; a single hot stream is one key on one node, so partition invalidations across streams if throughput demands it. Trimming keeps per-stream memory bounded regardless of throughput.

## 9. Interview Questions

**Q: Why is Pub/Sub a risky choice for cache invalidation?**
A: Because it is fire-and-forget with no persistence: a `PUBLISH` is delivered only to subscribers connected at that exact instant and then discarded — there is no queue, no acknowledgement, and no replay. So any subscriber that is momentarily disconnected, restarting, GC-pausing, or slow at the moment of publish simply never receives the message, and for invalidation that means the instance keeps serving stale data. Worse, Pub/Sub gives you no way to detect the miss (nothing was acked) or recover it (nothing was stored). It is only safe for invalidation when a short TTL on the cached entries bounds the staleness of a missed message, turning "stale forever" into "stale for a few seconds".

**Q: How do Redis Streams fix what Pub/Sub lacks for invalidation?**
A: Streams are a durable, append-only log rather than a broadcast. `XADD` persists each invalidation event, and consumers read through a consumer group that tracks the last-delivered position and keeps a Pending Entries List of delivered-but-unacknowledged entries. That gives three guarantees Pub/Sub lacks: a consumer that was down replays every event appended while it was gone when it returns (no loss on disconnect); an entry stays pending until the consumer `XACK`s it, so a crash mid-processing leads to redelivery (at-least-once); and because the log persists, you can replay history to reprocess or warm a new cache. The cost is complexity — managing groups, acknowledging, handling idempotency, claiming stalled entries, and trimming the log — but for an invalidation that must not be missed, that cost buys correctness.

**Q: What are keyspace notifications and when would you use them?**
A: They are events Redis itself emits when keys change, are deleted, or expire, published on `__keyspace@N__:*` and `__keyevent@N__:*` Pub/Sub channels and enabled with the `notify-keyspace-events` config. The classic use is reacting to expiry: subscribe to `__keyevent@0__:expired` to learn the moment a key's TTL fires, so you can refresh a downstream cache or clean up a related resource without polling. The caveats are that they are delivered over Pub/Sub — so they are best-effort and a disconnected subscriber misses them — and that the `expired` event fires when Redis actually removes the key (which for lazy expiry can be after the logical TTL), so it is not a precise timer. Use them for reactive housekeeping where best-effort timing is acceptable, not as a durable invalidation guarantee.

**Q: What does at-least-once delivery mean for how you write a Stream consumer?**
A: It means an entry is guaranteed to be delivered *at least* once but may be delivered more than once — for instance if a consumer processes an entry but crashes before `XACK`ing it, the entry stays pending and is redelivered later. So the consumer's handler must be idempotent: applying the same invalidation twice must be safe. For cache invalidation this is usually natural — evicting an already-evicted key is a no-op, and recomputing an already-correct value is harmless — but you must not, for example, use the delivery to increment a counter without deduplication. Concretely you `XACK` only after processing succeeds, drain your own pending list on restart to finish anything left in flight before a crash, and treat every handler as "safe to run again".

**Q: How would you use Pub/Sub and Streams together in one system?**
A: In layers, matched to the cost of a miss. Pub/Sub drives the fast, best-effort near-cache layer: each instance keeps a small in-process cache with a short TTL, and a write publishes the changed key so all instances evict promptly — a missed message just means up to a TTL of staleness, which is fine for that layer. Streams drive the authoritative invalidation: the same write also `XADD`s a durable event that consumer groups process to evict the shared Redis cache and any downstream stores, with acknowledgement and replay so nothing is missed even across consumer downtime. The near cache optimises the common case for latency; the stream guarantees correctness. This is a common and sound architecture: cheap-and-lossy where staleness is bounded, durable-and-acknowledged where it must not be.

**Q: (Senior) Walk through what happens to an invalidation when a consumer crashes, under Pub/Sub versus Streams.**
A: Under Pub/Sub: if the consumer is down at the moment of `PUBLISH`, the message is delivered to whoever is connected and then gone — the crashed consumer never learns of it, and when it restarts there is nothing to replay, so it resumes with a stale cache and no indication anything was missed. Only its TTL will eventually correct it. Under Streams the story is different at two points. If the consumer crashes *before* reading the entry, the entry simply waits in the durable log, and on restart the consumer's `XREADGROUP ... >` delivers it — no loss. If it crashes *after* reading but *before* `XACK`ing, the entry sits in that consumer's Pending Entries List; on restart the consumer first drains its own pending entries (`XREADGROUP ... 0`) and reprocesses them, or if that consumer never comes back, a janitor `XAUTOCLAIM`s entries idle beyond a threshold so another live consumer finishes them. Either way the invalidation is eventually applied exactly because the log persisted it and the group tracked the unacknowledged state. That crash-recovery behaviour — replay for un-read entries, redelivery via the PEL for read-but-unacked entries — is precisely the guarantee Pub/Sub cannot offer, and it is why must-not-miss invalidation belongs on Streams.

**Q: (Senior) An attacker gains the ability to publish to your invalidation channel. What is the blast radius and how do you contain it?**
A: The blast radius is significant. If they can `PUBLISH`/`XADD` arbitrary invalidations, they can force mass eviction — publishing invalidations for hot keys en masse causes every instance to drop them simultaneously, and the ensuing flood of misses stampedes the origin database (a thundering herd), which can take the backend down. If the mechanism also carries payloads, they might inject bad data. And with keyspace notifications enabled, a subscriber can enumerate key names and existence, an information leak. Containment is defence in depth: lock down who can publish/append with ACLs so only trusted services hold that permission, and separate read (subscribe/consume) from write (publish/add) capabilities; keep invalidation messages to key names only, never sensitive payloads, so a leaked message reveals little; protect the origin against the stampede independently with request coalescing / singleflight and per-key locks so that even a burst of misses collapses into one recomputation rather than a herd; rate-limit or sanity-bound invalidation volume so an anomalous flood is detected and throttled; and put the instance on an authenticated, TLS-protected network so the channel is not reachable by outsiders at all. The principle is that the invalidation bus is a control plane and must be treated as privileged — an attacker who controls cache invalidation controls cache correctness and can weaponise the origin's load.

**Q: (Senior) How do you keep a Stream from growing without bound while still guaranteeing no consumer misses an event?**
A: The two requirements pull against each other — retention for catch-up versus bounded memory — and you resolve them by trimming to the longest downtime you must survive, not to the smallest possible size. Practically: cap the log with `XADD ... MAXLEN ~ N` (the approximate `~` lets Redis trim in efficient whole-macro-node chunks rather than exactly, which is much cheaper) where N is sized so the retained history covers your worst realistic consumer outage — if a consumer could be down for an hour and you get 100 events/second, retain well over 360k events. Monitor consumer lag and PEL size so you know how far behind the slowest consumer is, and alert before the trim horizon approaches that lag (the danger case is trimming away entries a lagging consumer has not yet read — that *is* silent loss). For stronger safety, trim by a minimum-id computed from all groups' last-delivered ids (only trim entries every group has consumed), or use `XTRIM MINID` keyed to a time threshold. And handle the truly-stuck consumer separately with `XAUTOCLAIM` so one dead consumer does not hold the trim horizon hostage forever. The essence: bound memory by trimming, but never trim past the position of your slowest live consumer, and monitor the gap so you get warned before the two collide.

**Q: Why must Pub/Sub-based near caches always have a TTL?**
A: Because Pub/Sub is lossy, and the TTL is the only thing that bounds the damage of a lost message. The near cache exists to serve hot keys from process memory without a Redis round trip, and it is kept fresh by Pub/Sub eviction messages — but any one of those messages can be missed if the instance blips at publish time, and Pub/Sub offers no replay. Without a TTL, a missed eviction means that key is stale in that instance's memory *forever*, with no mechanism to correct it. A short TTL converts "stale forever" into "stale for at most the TTL", because the entry expires and the next read repopulates it from the current source. So the TTL is not an optimisation; it is the correctness backstop that makes it safe to rely on a lossy channel for eviction at all.

**Q: When would you choose sharded Pub/Sub over classic Pub/Sub?**
A: In Redis Cluster, when Pub/Sub fan-out volume is high enough that broadcasting every message to every node becomes a bottleneck. Classic Pub/Sub in Cluster propagates each published message to all nodes so any subscriber on any node receives it, which is convenient but means publish cost and inter-node traffic scale with cluster size. Sharded Pub/Sub (`SPUBLISH`/`SSUBSCRIBE`, Redis 7+) confines a channel to the single node that owns its slot, so a message is only delivered to subscribers connected to that node — no cluster-wide broadcast. You choose it when you can partition your subscribers by the channel's slot (they connect to the owning node) and you need the throughput; you keep classic Pub/Sub when you need every node's subscribers to receive every message and the volume is modest. For invalidation it is a scaling lever once fan-out volume across a large cluster becomes expensive.

## 10. Quick Revision & Cheat Sheet

| | Pub/Sub | Streams |
|---|---|---|
| Delivery | fire-and-forget | durable, at-least-once |
| Missed on disconnect? | Yes (lost forever) | No (replay from offset) |
| Acknowledgement | none | `XACK` + PEL |
| Replay history | no | yes (`XRANGE`) |
| Complexity | trivial | groups, acks, trim, idempotency |
| Use for invalidation | best-effort near cache + TTL | must-not-miss |

| Mechanism | Command | Note |
|---|---|---|
| Broadcast evict | `PUBLISH` / `SUBSCRIBE` | pair with short TTL |
| Durable event | `XADD` / `XREADGROUP` / `XACK` | consumer groups, PEL |
| React to expiry | `notify-keyspace-events Ex` → `__keyevent@0__:expired` | Pub/Sub-delivered, best-effort |
| Reclaim stalled | `XAUTOCLAIM` | dead-consumer recovery |
| Bound the log | `XADD MAXLEN ~ N` / `XTRIM` | never trim past slowest consumer |

**Flash cards**
- **Pub/Sub's fatal flaw?** → No persistence; a disconnected subscriber misses the message forever.
- **Streams' guarantee?** → At-least-once: durable, replayable, acked; consumers catch up after downtime.
- **Pub/Sub for invalidation only when?** → Best-effort near-cache eviction backed by a short TTL.
- **Streams for invalidation when?** → A missed invalidation is a correctness/security/money bug.
- **At-least-once implies?** → Idempotent handlers; `XACK` only after processing.
- **Keyspace notifications?** → Redis emits key change/expiry events; Pub/Sub-delivered, best-effort.

## 11. Hands-On Exercises & Mini Project

- [ ] Build a Pub/Sub invalidation broadcaster and a TTL-backed near cache; then disconnect one subscriber during a publish and show it serves stale data until its TTL fires.
- [ ] Convert the same invalidation to a Stream with a consumer group; kill the consumer during a publish and show it replays the missed event on restart.
- [ ] Force a crash between processing and `XACK` and observe redelivery via the pending list; make the handler idempotent and confirm correctness.
- [ ] Enable `notify-keyspace-events Ex`, set a key with a short TTL, and react to its `expired` event.
- [ ] Implement `XAUTOCLAIM` to reclaim a permanently-dead consumer's pending entries.
- [ ] Add `MAXLEN ~` trimming and demonstrate that a consumer down longer than the retention window loses events — then size the retention to prevent it.

### Mini Project — "Invalidation Bus"

**Goal.** Build a two-tier invalidation system — Pub/Sub for a best-effort near cache and Streams for authoritative invalidation — and prove each tier's guarantee (or lack of one).

**Requirements.**
1. Near-cache tier: an in-process cache with a short TTL, evicted by Pub/Sub messages; instrument it to show staleness bounded by the TTL when a message is missed.
2. Authoritative tier: a Stream with a consumer group whose consumers evict the shared Redis cache with `XACK`, drain pending on restart, and reclaim stalled entries with `XAUTOCLAIM`.
3. On every write, both `PUBLISH` (near cache) and `XADD` (authoritative) the changed key.
4. Chaos test: kill and restart consumers during writes and assert the Stream tier never permanently misses an invalidation while the Pub/Sub tier self-heals only via TTL.
5. Bound the stream with `MAXLEN ~` sized to the longest consumer outage you test, and monitor consumer lag and PEL size.

**Extensions.**
- Add keyspace-notification-driven refresh: recompute a derived cache when its source key expires.
- Add sharded Pub/Sub (`SPUBLISH`/`SSUBSCRIBE`) and compare fan-out cost against classic Pub/Sub in a small cluster.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Redis Data Types & Which to Cache With* (Streams as the durable log type), *Cache Invalidation Strategies* (where these mechanisms fit the broader problem), *Cache Stampede & the Thundering Herd* (why a mass invalidation is dangerous), *Client-Side & Near Caching* (the near cache Pub/Sub evicts), *Security: ACLs, TLS & Hardening* (locking down the invalidation control plane).

- **Redis — Streams data type & consumer groups** — Redis · *Advanced* · the authoritative reference for `XADD`/`XREADGROUP`/`XACK`, groups and the PEL. <https://redis.io/docs/latest/develop/data-types/streams/>
- **Redis — Pub/Sub** — Redis · *Intermediate* · the fire-and-forget model, patterns, and sharded Pub/Sub for Cluster. <https://redis.io/docs/latest/develop/interact/pubsub/>
- **Redis — Keyspace notifications** — Redis · *Intermediate* · enabling `notify-keyspace-events` and the `__keyevent@N__:*` channels for reacting to expiry and changes. <https://redis.io/docs/latest/develop/use/keyspace-notifications/>
- **Redis — Introduction to Redis Streams (with consumer groups walkthrough)** — Redis · *Advanced* · the tutorial that motivates at-least-once delivery and `XCLAIM`/`XAUTOCLAIM` recovery. <https://redis.io/docs/latest/develop/data-types/streams-tutorial/>
- **Redis — Client-side caching & invalidation (tracking)** — Redis · *Advanced* · the RESP3 tracking mechanism, an alternative server-driven invalidation for near caches. <https://redis.io/docs/latest/develop/reference/client-side-caching/>
- **Designing Data-Intensive Applications, ch. 11 (Stream Processing)** — Martin Kleppmann · *Advanced* · logs, consumer offsets, at-least-once vs exactly-once — the theory behind Streams. <https://dataintensive.net/>
- **Kafka vs Redis Streams — when a log is the right tool** — Confluent / Redis blogs · *Advanced* · the durable-log model and when Streams suffice versus a dedicated log. <https://redis.io/docs/latest/develop/data-types/streams/>
- **Redis University — RU202: Redis Streams** — Redis · *Intermediate* · a free course dedicated to Streams, consumer groups and reliable delivery. <https://university.redis.com/>

---

*Caching with Redis Handbook — chapter 21.*
