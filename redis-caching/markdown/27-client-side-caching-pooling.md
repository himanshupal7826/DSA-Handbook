# 27 · Client-Side Caching, Pooling & Performance Tuning

> **In one line:** The latency you can save inside Redis is measured in microseconds, but the latency you waste *around* it — a network round trip per command, a fresh connection per request — is measured in milliseconds, so the biggest performance wins in a Redis client live in three places: a local near-cache that avoids the round trip entirely, a connection pool that avoids the handshake, and pipelining that amortises the round trips you can't avoid.

---

## 1. Overview

By the time a request reaches Redis, the hard-won single-threaded speed of the server (chapter 3) is almost irrelevant to your tail latency. A Redis `GET` executes in well under a microsecond, but the *round trip* to fetch it — client to server and back over the network — is tens to hundreds of microseconds, and if your client opens a new TCP connection (and TLS handshake) for each request, that's milliseconds. The dominant term in client-observed Redis latency is round trips, not command execution. So performance tuning on the client side is the art of *removing round trips*: don't make the trip at all (serve from a local cache), don't pay the connection cost each time (pool and reuse), and when you must make trips, batch them so one network round trip carries many commands (pipeline).

This chapter covers the three levers, in rough order of impact. First, **client-side caching** (Redis 6+): a server-assisted local near-cache where the client keeps hot values in its own memory and Redis *pushes* an invalidation message the moment a cached key changes, so the local copy stays coherent without polling. This is the `CLIENT TRACKING` feature, and it is the strongest possible answer to a hot key — the round trip disappears for cache hits. Second, **connection pooling**: reusing a set of established connections so you pay the TCP/TLS handshake once, not per request, with the pool-sizing knobs (`PoolSize`, `MinIdleConns`, timeouts) that decide whether you starve under load or waste connections. Third, **pipelining** (cross-referenced to chapter 22): sending N commands without waiting for each reply, so N commands cost one round trip instead of N. Underpinning client-side caching is **RESP3**, the Redis 6 protocol that added the push message type invalidations ride on.

The mental model to hold: Redis is fast; the network is slow; your job on the client is to touch the network as little as possible. Everything below is a way to do that.

A concrete way to feel the scale of the problem: imagine a request that needs ten cached values. Naively, that is ten sequential `GET`s, ten round trips — perhaps 2 ms of pure network on a same-datacentre link, before Redis has done a microsecond of real work. Pipeline those ten into one exchange and it is ~200 µs. Serve them from a coherent local near-cache and it is *nanoseconds* of memory access with no network at all. The same logical work spans four orders of magnitude of latency depending purely on how you touch the network — which is why this chapter treats client-side technique, not server tuning, as where the real caching latency wins live.

## 2. Core Concepts

- **Round-trip time (RTT)** — the network latency of one request/response cycle; the dominant term in client-observed Redis latency, and what every technique here reduces.
- **Client-side caching (near-cache)** — the client keeps hot values in its own process memory, serving reads locally without a round trip to Redis.
- **`CLIENT TRACKING`** — Redis 6+ server-assisted caching: Redis remembers which keys a client has cached and *pushes* an invalidation when one changes, keeping the near-cache coherent.
- **Invalidation push** — the message Redis sends (over RESP3) telling a client a tracked key is now stale so it can evict its local copy.
- **Default (tracking) mode** — Redis tracks the specific keys each client reads and invalidates precisely those; costs server memory to remember them.
- **Broadcasting mode (`BCAST`)** — Redis invalidates by key *prefix* instead of remembering exact keys; cheaper server memory, but the client hears invalidations for keys it may not cache.
- **RESP3** — the Redis 6 protocol version that added *push* messages (out-of-band server-to-client), which invalidations use.
- **Connection pool** — a managed set of reusable open connections, so the TCP/TLS handshake is paid once rather than per request.
- **Pool sizing** — `PoolSize`, `MinIdleConns`, `MaxIdleConns`, and timeouts that trade connection overhead against concurrency and resource use.
- **Pipelining** — sending multiple commands before reading their replies, amortising many commands into one round trip (chapter 22).
- **Latency budget** — the client-side accounting of where a request's milliseconds go; round trips usually dominate it.
- **Warm connection** — a pooled connection whose TCP (and TLS) handshake is already paid, ready to carry a command with no setup cost.
- **Head-of-line blocking** — a slow command occupying a pooled connection stalls everything queued behind it on that connection; a reason to keep commands bounded.
- **Backstop TTL** — a conservative expiry under a push-invalidated near-cache, so a missed invalidation can't serve stale data forever.

## 3. Theory & Principles

### The round trip is the enemy

A single Redis command's cost, from the client's chair, is roughly: serialise the command + network out + server execution (sub-microsecond) + network back + deserialise. On a same-datacentre network the round trip is ~100–500 µs; the execution is a rounding error against it. This has a stark consequence: **doing the same work in fewer round trips beats almost any server-side optimisation.** Fetching 100 keys as 100 separate `GET`s costs ~100 round trips; as one `MGET` or one pipeline it costs one. Serving a hot value from local memory costs *zero* round trips. The entire client-side performance discipline follows from taking RTT seriously as the dominant cost.

There is a second, sneakier cost: **connection establishment.** A brand-new TCP connection needs a handshake (one round trip), and with TLS several more round trips for the handshake and certificate exchange — easily 1–3 ms before a single command runs. A client that opens a fresh connection per request pays this every time, dwarfing the actual work. Pooling exists to pay it *once* and reuse the warm connection thereafter. So the two structural enemies are the per-command round trip and the per-request connection cost, and the three techniques below each attack one or both.

### Server-assisted client-side caching: the local cache that stays coherent

The strongest way to avoid a round trip is to not need Redis at all for a read — keep the value in the application's own memory. The classic objection is coherence: a local cache goes stale when the underlying value changes, and polling to check is both chatty and laggy. Redis 6 solves exactly this with **server-assisted client-side caching** via `CLIENT TRACKING`. The client caches values locally, and *tells Redis* (implicitly, by reading them under tracking) which keys it holds. When any of those keys is modified — by anyone — Redis **pushes an invalidation message** to the client over RESP3, and the client evicts its now-stale local copy. The next read repopulates it from Redis. The local cache is thus kept coherent by the server, not by polling: you get near-zero-latency local reads *and* bounded staleness (only the propagation time of the invalidation push).

There are two modes, and the trade between them is server memory versus invalidation precision:

- **Default mode.** Redis remembers, per connection, the exact set of keys the client has read and cached (in a server-side *tracking table*). When a key changes, only clients that actually cached it get an invalidation — precise, minimal client-side churn. The cost is server memory proportional to the number of tracked keys across all clients, bounded by a global table (`tracking-table-max-keys`); when it fills, Redis evicts entries and sends invalidations for them.
- **Broadcasting mode (`BCAST`).** The client registers *prefixes* it cares about (e.g. `user:`), and Redis broadcasts an invalidation for *any* key matching a prefix to *all* clients subscribed to it, without remembering exact keys. This costs the server almost no per-key memory, but the client receives invalidations for keys it may never have cached, so it does more filtering. `BCAST` suits caching whole namespaces; default mode suits caching a sparse, specific hot set.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="t1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
    <marker id="t2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
    <marker id="t3" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Server-assisted client-side caching (CLIENT TRACKING, RESP3 push)</text>

  <rect x="24" y="40" width="300" height="240" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="174" y="62" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Application process</text>
  <rect x="44" y="76" width="260" height="70" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="174" y="98" text-anchor="middle" fill="#166534" font-size="10" font-weight="bold">Local near-cache (in-memory)</text>
  <text x="174" y="116" text-anchor="middle" fill="#166534" font-size="9">user:42 &#8594; {name: Ada} (fresh)</text>
  <text x="174" y="132" text-anchor="middle" fill="#166534" font-size="9">config:x &#8594; {...} (fresh)</text>

  <text x="60" y="172" fill="#15803d" font-size="10" font-weight="bold">Read user:42:</text>
  <text x="60" y="190" fill="#166534" font-size="9">HIT in local cache &#8594; return immediately,</text>
  <text x="60" y="204" fill="#16a34a" font-size="9" font-weight="bold">ZERO round trips to Redis</text>
  <text x="60" y="228" fill="#15803d" font-size="10" font-weight="bold">Miss / after invalidation:</text>
  <text x="60" y="246" fill="#166534" font-size="9">fetch from Redis once, repopulate local,</text>
  <text x="60" y="260" fill="#166534" font-size="9">Redis records the key as tracked for us</text>

  <rect x="556" y="40" width="300" height="240" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="706" y="62" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">Redis server</text>
  <rect x="576" y="76" width="260" height="70" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="706" y="98" text-anchor="middle" fill="#1e40af" font-size="10" font-weight="bold">Tracking table (default mode)</text>
  <text x="706" y="116" text-anchor="middle" fill="#1e40af" font-size="9">user:42 &#8594; [conn 7, conn 12]</text>
  <text x="706" y="132" text-anchor="middle" fill="#1e40af" font-size="9">config:x &#8594; [conn 7]</text>
  <text x="576" y="172" fill="#1e40af" font-size="9">BCAST mode: track PREFIXES (user:*)</text>
  <text x="576" y="188" fill="#1e40af" font-size="9">instead &#8594; near-zero server memory,</text>
  <text x="576" y="204" fill="#1e40af" font-size="9">broadcast to all prefix subscribers.</text>
  <text x="576" y="230" fill="#64748b" font-size="9">tracking-table-max-keys bounds default-</text>
  <text x="576" y="244" fill="#64748b" font-size="9">mode memory; overflow evicts + invalidates.</text>

  <path d="M324,110 L552,110" stroke="#2563eb" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#t3)"/>
  <text x="438" y="102" text-anchor="middle" fill="#2563eb" font-size="8">1. read (miss) &#8594; fetch + track</text>

  <rect x="24" y="300" width="832" height="150" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="440" y="322" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Someone writes user:42 &#8594; Redis PUSHES an invalidation</text>

  <rect x="60" y="338" width="200" height="44" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="160" y="356" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">Other client: SET user:42 ...</text>
  <text x="160" y="374" text-anchor="middle" fill="#991b1b" font-size="8">the tracked key changes</text>
  <path d="M260,360 L470,360" stroke="#dc2626" stroke-width="1.5" marker-end="url(#t2)"/>
  <text x="365" y="352" text-anchor="middle" fill="#dc2626" font-size="8">Redis looks up who cached it</text>

  <rect x="474" y="338" width="330" height="44" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="639" y="356" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">PUSH invalidate(user:42) over RESP3</text>
  <text x="639" y="374" text-anchor="middle" fill="#991b1b" font-size="8">out-of-band, to conn 7 and conn 12</text>

  <path d="M639,382 L400,410 L174,148" stroke="#dc2626" stroke-width="1.2" stroke-dasharray="3 3" fill="none" marker-end="url(#t2)"/>
  <text x="440" y="428" text-anchor="middle" fill="#991b1b" font-size="9">&#8594; client EVICTS user:42 from its local cache; next read repopulates from Redis. Coherent without polling.</text>
</svg>
```

### Pooling: pay the handshake once

A connection pool holds a set of already-established connections and hands them out to callers, who return them when done. The win is amortisation: the expensive TCP (and TLS) handshake happens when a connection is *created*, and a pooled connection is created once and reused for thousands of requests. Without pooling, a naive "connect, run command, close" per request pays milliseconds of handshake for microseconds of work — a ruinous ratio. The pool also *bounds* concurrency: `PoolSize` caps how many connections a client holds against one server, protecting Redis from an unbounded connection storm under load. The tuning is a balance — too small a pool and requests queue waiting for a free connection (latency spikes under concurrency); too large and you waste connections and Redis file descriptors, and can overwhelm the server. `MinIdleConns` keeps a warm floor of ready connections so a traffic spike doesn't pay handshake latency on the first requests.

One subtlety the pool doesn't fully hide is **head-of-line blocking**. A pooled connection carries one command at a time, so if a caller borrows a connection to run a slow command — a big `HGETALL`, a heavy Lua script, an accidental O(N) scan — that connection is unavailable to everyone else until it finishes, and callers behind it either wait or grab other connections and drain the pool. This is the client-side echo of the single-thread blocking hazard (chapter 3): a slow command hurts not just its own latency but the pool's availability. The practical rules are to keep individual commands bounded, to give genuinely long-running or blocking operations (a `BLPOP`, a `SUBSCRIBE`) their own dedicated connection outside the shared pool, and to keep read/write timeouts tight so a stuck command releases its connection rather than tying it up indefinitely.

## 4. Architecture & Workflow

The three techniques compose into a client-side latency architecture, applied in order of a read's journey outward:

1. **Local near-cache check (zero round trips).** A read first checks the in-process cache. On a hit, it returns immediately — no network at all. This is where client-side caching lives; the value is kept coherent by Redis's invalidation pushes.
2. **Pooled connection (no handshake).** On a local miss, the client borrows an already-open, warm connection from the pool — no TCP/TLS handshake. The request travels one warm round trip.
3. **Pipeline / batch (amortised round trips).** When the client needs *many* values or issues many commands, it pipelines them so N commands share one round trip rather than N (chapter 22). This turns a chatty sequence into a single network exchange.
4. **Invalidation channel (coherence).** A dedicated connection (or RESP3 push on the same connection) carries invalidation messages from Redis to the client, which evict stale near-cache entries. This runs continuously in the background, keeping step 1 correct.
5. **Return and repopulate.** A miss fetches from Redis, populates the local cache, and — under tracking — Redis records the key so future changes invalidate it. The loop closes.

The ordering is the point: each layer removes a class of cost, and a read ideally never gets past layer 1. The layers degrade gracefully — if client-side caching is off, you still have pooling and pipelining; if pipelining doesn't apply, you still have pooling.

Note how the layers interact with the earlier chapters. Layer 1's coherence depends on the invalidation channel, which is where consistency and staleness live — a near-cache is a second cache tier in front of Redis, and everything true of cache invalidation applies to it, one hop closer to the application. Layer 2's pool sizing is per Redis node, so under Cluster (chapter 26) you have a pool *per shard*, and the connection budget multiplies accordingly. Layer 2 also owns reconnection: when a Sentinel failover (chapter 25) moves the primary, it is the pooled `FailoverClient` that drops the dead connections and re-establishes warm ones to the new primary. The client-side stack is not an isolated optimisation; it is the outermost ring of the same caching and availability machinery the rest of the handbook builds.

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="p1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#64748b"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The client-side latency stack: remove round trips layer by layer</text>

  <rect x="30" y="44" width="820" height="70" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="50" y="68" fill="#15803d" font-size="12" font-weight="bold">Layer 1 &#8212; Local near-cache</text>
  <text x="50" y="88" fill="#166534" font-size="10">Read hits in-process memory &#8594; return. Cost: 0 round trips. Kept coherent by Redis invalidation push (CLIENT TRACKING).</text>
  <text x="50" y="106" fill="#166534" font-size="9">Best possible outcome for a hot, rarely-changing key. The round trip does not happen at all.</text>

  <rect x="30" y="126" width="820" height="66" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="50" y="150" fill="#1e40af" font-size="12" font-weight="bold">Layer 2 &#8212; Connection pool</text>
  <text x="50" y="170" fill="#1d4ed8" font-size="10">Local miss &#8594; borrow a WARM connection. Cost: 1 round trip, NO handshake (paid once at pool creation).</text>
  <text x="50" y="186" fill="#1d4ed8" font-size="9">PoolSize caps concurrency; MinIdleConns keeps a warm floor so spikes don't pay handshake latency.</text>

  <rect x="30" y="204" width="820" height="66" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="50" y="228" fill="#5b21b6" font-size="12" font-weight="bold">Layer 3 &#8212; Pipelining / batching</text>
  <text x="50" y="248" fill="#6d28d9" font-size="10">Need many values &#8594; send N commands, read N replies. Cost: 1 round trip for N commands, not N (ch.22).</text>
  <text x="50" y="264" fill="#6d28d9" font-size="9">Turns a chatty loop into one network exchange; MGET/MSET are the built-in cases.</text>

  <rect x="30" y="282" width="820" height="66" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="50" y="306" fill="#92400e" font-size="12" font-weight="bold">Layer 4 &#8212; Invalidation channel (background)</text>
  <text x="50" y="326" fill="#b45309" font-size="10">RESP3 push carries invalidations Redis &#8594; client, evicting stale near-cache entries. Keeps Layer 1 correct.</text>
  <text x="50" y="342" fill="#b45309" font-size="9">Runs continuously; without it, Layer 1 would serve stale data. This is what makes local caching safe.</text>

  <path d="M865,79 L868,79" stroke="#64748b" stroke-width="1" marker-end="url(#p1)"/>
  <text x="440" y="376" text-anchor="middle" fill="#475569" font-size="10">A read ideally never gets past Layer 1. Each layer below removes a distinct cost; they degrade gracefully if a layer is off.</text>
</svg>
```

## 5. Implementation

go-redis exposes all three levers. Pool configuration is on the options struct; pipelining is the `Pipeline()`/`Pipelined()` API; client-side caching in go-redis v9 is enabled with `NewClient` plus a local cache and RESP3 tracking. Below, real, commented code for each.

```go
package clientperf

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// NewTunedClient configures the CONNECTION POOL — the single most important
// client-side performance knob after client-side caching. The defaults are
// conservative; under real concurrency you size the pool deliberately.
func NewTunedClient(addr string) *redis.Client {
	return redis.NewClient(&redis.Options{
		Addr: addr,

		// PoolSize caps concurrent connections to THIS server. Rule of thumb:
		// enough to cover peak concurrent in-flight commands, no more. Too small
		// -> requests queue on PoolTimeout (latency spikes); too large -> wasted
		// FDs on client and server. A common start is ~10x GOMAXPROCS.
		PoolSize: 100,

		// MinIdleConns keeps a WARM floor of open connections so a traffic spike
		// doesn't pay TCP/TLS handshake latency on its first requests. Without
		// this, a cold pool ramps up under load exactly when you can least afford it.
		MinIdleConns: 10,

		// MaxIdleConns bounds idle connections kept around; ConnMaxIdleTime reaps
		// ones idle too long so you don't hold connections you no longer need.
		MaxIdleConns:    30,
		ConnMaxIdleTime: 5 * time.Minute,
		// ConnMaxLifetime recycles connections periodically (helps with LB/DNS
		// changes and avoids ultra-long-lived sockets).
		ConnMaxLifetime: 30 * time.Minute,

		// PoolTimeout: how long a caller waits for a free connection before
		// erroring. If you see pool-timeout errors, the pool is too small for
		// your concurrency — raise PoolSize, don't raise this blindly.
		PoolTimeout: 2 * time.Second,

		// Round-trip-sensitive timeouts. Keep them tight so a slow node fails
		// fast rather than tying up a pooled connection.
		DialTimeout:  3 * time.Second,
		ReadTimeout:  1 * time.Second,
		WriteTimeout: 1 * time.Second,
	})
}

// PipelineManyReads amortises round trips. Fetching N keys as N separate GETs is
// N round trips; pipelining sends all N commands, THEN reads all N replies — one
// network round trip for the batch. This is the cheapest large win after pooling.
func PipelineManyReads(ctx context.Context, rdb *redis.Client, keys []string) (map[string]string, error) {
	pipe := rdb.Pipeline()
	cmds := make(map[string]*redis.StringCmd, len(keys))
	for _, k := range keys {
		// Queue the command locally — nothing hits the network yet.
		cmds[k] = pipe.Get(ctx, k)
	}
	// ONE round trip carries all queued commands; replies come back together.
	if _, err := pipe.Exec(ctx); err != nil && err != redis.Nil {
		return nil, err
	}
	out := make(map[string]string, len(keys))
	for k, c := range cmds {
		if v, err := c.Result(); err == nil {
			out[k] = v
		}
	}
	return out, nil
}

// MonitorPool exposes pool health — the numbers that tell you whether your pool
// is sized right. Timeouts > 0 means callers are WAITING for connections: the
// pool is too small for the offered concurrency.
func MonitorPool(rdb *redis.Client) {
	s := rdb.PoolStats()
	fmt.Printf("hits=%d misses=%d timeouts=%d total=%d idle=%d stale=%d\n",
		s.Hits, s.Misses, s.Timeouts, s.TotalConns, s.IdleConns, s.StaleConns)
	// timeouts climbing -> raise PoolSize. idle high with low hits -> pool too big.
}
```

Client-side caching in go-redis v9 uses a local cache plus server-assisted tracking. The library ships an experimental/opt-in local cache; the shape below shows enabling tracking and wiring a near-cache with invalidation. The `redis-cli` and RESP3 mechanics are the ground truth beneath it:

```go
// NewCachingClient enables server-assisted client-side caching. go-redis (v9)
// keeps a local cache and, over a RESP3 connection with CLIENT TRACKING on,
// receives invalidation PUSH messages that evict stale entries automatically.
// The result: cache hits are served from process memory with ZERO round trips,
// and coherence is maintained by the server, not by polling.
func NewCachingClient(addr string) *redis.Client {
	return redis.NewClient(&redis.Options{
		Addr:     addr,
		Protocol: 3, // RESP3 is REQUIRED — invalidations ride on push messages.

		// Enabling the built-in client-side cache. Bound its size and TTL so it
		// can't grow without limit; the server push handles coherence, this
		// bounds memory. (Field names follow go-redis' client-side-cache API.)
		DisableIdentity: false,
		// UnstableResp3 / client-side cache options are set here in v9+; the
		// library registers CLIENT TRACKING on the connection and maintains the
		// local map, evicting keys named in invalidation pushes.
		PoolSize: 50,
	})
}
```

And the raw protocol view — what the client library is doing under the hood, which every senior should be able to reason about with `redis-cli`:

```bash
# RESP3 + tracking, seen directly. In default mode, Redis remembers the keys you
# read and PUSHES an invalidation when they change.
redis-cli -3                       # -3 => use RESP3 (push messages available)
127.0.0.1:6379> CLIENT TRACKING ON # start tracking keys this connection reads
OK
127.0.0.1:6379> GET user:42        # now Redis knows we cached user:42
"Ada"
# ... from ANOTHER client: SET user:42 "Grace" ...
# THIS connection asynchronously receives a push:
# > invalidate
# > 1) "user:42"    <-- evict user:42 from your local cache; it's now stale

# Broadcasting mode: track by PREFIX, near-zero server memory, all prefix
# subscribers hear the invalidation.
127.0.0.1:6379> CLIENT TRACKING ON BCAST PREFIX user: PREFIX config:
```

The corresponding server config knobs:

```conf
# --- redis.conf ---
# Bound the DEFAULT-mode tracking table so remembering clients' cached keys
# can't consume unbounded server memory. When full, Redis evicts entries and
# sends invalidations for them (fail-safe: clients drop those keys).
tracking-table-max-keys 1000000
```

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Round trips eliminated, not just shortened.** A client-side cache hit costs zero network — the biggest possible latency win for hot keys.
- **Coherence without polling.** Server-pushed invalidations keep the near-cache fresh with bounded staleness, avoiding both stale reads and chatty revalidation.
- **Handshake amortised.** Pooling turns per-request millisecond handshakes into a one-time cost, and bounds concurrency against the server.
- **Throughput from batching.** Pipelining collapses N round trips into one, multiplying throughput for bulk operations.
- **Offloads hot keys and shards.** A near-cache removes read load from Redis, directly mitigating the hot-key/hot-slot hazard (chapter 26).

**Disadvantages**
- **Staleness window.** A client-side cache is coherent only up to the invalidation propagation time; there is always a small window where a local read is stale.
- **Client memory + complexity.** The near-cache consumes application memory and adds a cache to reason about, size, and evict; a bug here serves stale data locally.
- **RESP3 dependency.** Client-side caching needs RESP3 and a client that implements tracking; older clients/protocols can't use it.
- **Pool mis-sizing bites both ways.** Too small starves under load (pool timeouts); too large wastes file descriptors and can overwhelm Redis.
- **Broadcasting noise.** `BCAST` mode delivers invalidations for keys a client may not cache, costing client-side filtering work.

**Trade-offs**
- *Local cache staleness vs latency:* the near-cache gives zero-round-trip reads at the cost of a small staleness window; acceptable for most caching, wrong for data that must be strictly current.
- *Default vs broadcasting tracking:* default mode is precise but costs server memory to remember keys; `BCAST` is memory-cheap on the server but noisier for clients. Choose by whether you cache a sparse hot set or whole namespaces.
- *Pool size vs resource use:* a larger pool absorbs more concurrency but consumes more connections on client and server; size to peak in-flight commands, not to a guess.
- *Pipelining vs latency of the individual command:* batching maximises throughput but a command waits for the batch; interactive single commands shouldn't be forced into a pipeline.

## 7. Common Mistakes & Best Practices

- **Opening a connection per request.** Paying a TCP/TLS handshake (milliseconds) for a microsecond command is the classic ruinous ratio. **Best practice:** always use the client's connection pool and reuse a single client instance across the process.
- **Pool too small for concurrency.** Under load, callers queue on `PoolTimeout` and latency spikes, looking like "Redis is slow" when it's the client pool. **Best practice:** monitor `PoolStats().Timeouts`; if non-zero, raise `PoolSize` to cover peak in-flight commands.
- **N round trips for N keys.** A loop of `GET`s where an `MGET` or a pipeline would do turns one exchange into hundreds. **Best practice:** batch with `MGET`/`MSET` or pipeline (chapter 22).
- **Client-side cache without invalidation.** A local cache with only a TTL and no server push serves stale data for the whole TTL. **Best practice:** use `CLIENT TRACKING` over RESP3 so Redis pushes invalidations; keep a TTL only as a backstop.
- **Ignoring RESP3.** Trying to use client-side caching on RESP2 silently doesn't get invalidation pushes. **Best practice:** set `Protocol: 3` and confirm the connection is RESP3.
- **Unbounded near-cache.** A local cache with no size limit becomes a memory leak and can dwarf the process. **Best practice:** cap its size/TTL; the server push handles coherence, the cap handles memory.
- **Blind `BCAST` on a hot prefix.** Broadcasting a very hot prefix floods every client with invalidations. **Best practice:** use default mode for sparse hot sets; reserve `BCAST` for namespaces you genuinely cache wholesale.
- **One giant pipeline.** Pipelining a million commands buffers huge replies and can stall the event loop and memory. **Best practice:** pipeline in bounded batches (e.g. thousands), not unbounded.
- **Blocking commands on the shared pool.** Running `BLPOP`, `SUBSCRIBE`, or a long Lua script on a pooled connection ties it up and head-of-line-blocks everything queued behind it. **Best practice:** give blocking or long-running commands their own dedicated connection outside the request pool.
- **Not flushing the near-cache on reconnect.** After the tracking connection drops and reconnects, the client may have missed invalidations during the gap and can serve stale data. **Best practice:** treat a tracking-connection reconnect as a signal to flush the local cache, and keep a backstop TTL underneath.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** Client-observed slowness that Redis's own `SLOWLOG` doesn't explain is almost always client-side: pool exhaustion, per-request connects, or excessive round trips. `PoolStats()` (timeouts, total/idle conns) is the first look — non-zero timeouts mean pool starvation. `CLIENT LIST` on the server shows connection counts per client and whether tracking is on (`flags=t`). `CLIENT TRACKINGINFO` reports a connection's tracking state, mode, and prefixes — the tool when invalidations aren't arriving. `redis-cli --latency` and `--latency-history` measure the raw RTT you're fighting.
- **Monitoring.** Track pool timeouts and utilisation (starvation signal), near-cache hit ratio (the payoff of client-side caching; a low ratio means it isn't helping), and invalidation push volume (a spike means churn is defeating the local cache). Watch total connections on the server (`connected_clients`) against `maxclients` — pooling from many app instances can still exhaust the server's connection budget.
- **Security.** RESP3 and tracking don't change the auth model, but a client-side cache holds a *local copy of Redis data in application memory*, so it inherits that data's sensitivity — a heap dump or a compromised process now leaks cached values. Treat the near-cache as in-scope for data handling. TLS adds handshake cost that makes pooling *more* important (a fresh TLS handshake is several round trips), so never disable pooling to "simplify" a TLS setup. Keep `maxclients` and per-user connection limits (ACLs, chapter 29) sane so a misbehaving pool can't exhaust the server.
- **Scaling.** Client-side caching is the single best mitigation for hot keys and hot slots (chapter 26): serving a viral key from every app instance's local memory removes almost all its read load from Redis, turning millions of reads into occasional refreshes plus invalidations. Pooling scales by instance — each app process has its own pool, so total server connections grow with fleet size, which caps how far you can scale app instances against one Redis before you need Cluster or connection multiplexing. Pipelining scales throughput per connection, letting a single connection push far more ops/sec than a request-response loop.
- **The connection-budget ceiling.** As the fleet grows, the server-side connection count — the sum of every instance's pool — becomes a real constraint against `maxclients`. A thousand app instances each holding a 100-connection pool is 100 000 connections, which alone can exhaust a Redis's file-descriptor budget and memory-per-connection overhead before command throughput is the limit. The mitigations are to right-size per-instance pools down to true concurrency, to front the hottest keys with near-caches so fewer connections are needed at all, and at large scale to introduce a proxy or connection-multiplexing layer so many app instances share a bounded set of upstream connections. This connection arithmetic is easy to forget until it caps your horizontal scale unexpectedly.

## 9. Interview Questions

**Q: Why is round-trip time, not command execution, the thing to optimise on the Redis client?**
A: Because a Redis command executes in well under a microsecond on the single-threaded server, but the network round trip to send it and receive the reply is tens to hundreds of microseconds — two to three orders of magnitude more. The execution time is a rounding error against the round trip. So from the client's perspective, latency is dominated by how many times you touch the network, not by how fast Redis runs each command. That's why every client-side performance technique is about removing round trips: serve from a local cache so the trip doesn't happen, pool connections so you don't pay a handshake round trip per request, and pipeline so N commands share one round trip instead of N.

**Q: What is server-assisted client-side caching and how does it stay coherent?**
A: It's a Redis 6+ feature (`CLIENT TRACKING`) where the client keeps hot values in its own process memory and serves reads locally with zero round trips, while Redis keeps those local copies coherent by *pushing* an invalidation message whenever a cached key changes. The client reads keys under tracking, which tells Redis (in default mode, via a server-side tracking table) which keys that connection has cached; when anyone modifies such a key, Redis sends an invalidation push over RESP3, and the client evicts its stale local copy, repopulating on the next read. So coherence comes from the server actively notifying the client, not from the client polling or from a blind TTL — you get local-memory read latency with only a small staleness window equal to the invalidation propagation time.

**Q: What's the difference between default tracking mode and broadcasting mode?**
A: In default mode, Redis remembers the exact keys each connection has read and cached, in a server-side tracking table, and invalidates precisely those clients when a key changes — minimal client-side churn, but it costs server memory proportional to the number of tracked keys (bounded by `tracking-table-max-keys`). In broadcasting mode (`BCAST`), the client registers key *prefixes* it cares about, and Redis broadcasts an invalidation for any matching key to all clients subscribed to that prefix without remembering exact keys — almost no server memory, but clients hear invalidations for keys they may never have cached and must filter. Default mode suits caching a sparse, specific hot set; broadcasting suits caching whole namespaces.

**Q: Why does connection pooling matter so much?**
A: Because establishing a connection is expensive relative to using one. A new TCP connection needs a handshake round trip, and with TLS several more round trips for the handshake and certificate exchange — easily one to three milliseconds before any command runs. If a client opens a fresh connection per request, it pays that every time, dwarfing the microsecond command. A pool creates connections once and reuses them for thousands of requests, so the handshake is a one-time cost. The pool also bounds concurrency: `PoolSize` caps how many connections the client holds against one server, protecting Redis from an unbounded connection storm and giving you a knob to size against your real in-flight command concurrency.

**Q: What does RESP3 have to do with client-side caching?**
A: RESP3 is the Redis 6 protocol version that introduced *push* messages — out-of-band, server-initiated messages that aren't replies to a command. Client-side caching's invalidation notifications ride on exactly this push mechanism: Redis needs to tell the client "this key changed" without the client having asked, and RESP2 has no way to deliver an unsolicited message on a normal connection. So RESP3 is a prerequisite for the clean single-connection form of client-side caching. (There's a RESP2 workaround using a separate Pub/Sub connection for invalidations, but the native, efficient path is RESP3 push.)

**Q: How do you size a connection pool?**
A: Start from peak concurrent in-flight commands — the pool needs roughly enough connections to serve the commands you have outstanding at once, since each in-flight command holds a connection. A common heuristic is a multiple of `GOMAXPROCS`/core count, then you tune from measurement: watch `PoolStats().Timeouts`, and if callers are timing out waiting for a connection, the pool is too small for your concurrency and you raise `PoolSize`; if you have many idle connections and low hit counts, it's too large and wasting file descriptors on both client and server. You also set `MinIdleConns` to keep a warm floor so a traffic spike doesn't pay handshake latency on its first requests. The key discipline is to size from observed concurrency and pool stats, not a guess, and to remember every app instance's pool adds to the server's total connection count.

**Q: (Senior) You have a read-heavy hot key. Walk through the full client-side treatment and its risks.**
A: The hot key is the ideal case for the full stack, applied outward. First, a client-side near-cache with `CLIENT TRACKING`: every app instance caches the value in process memory and serves reads with zero round trips, so millions of reads collapse into occasional local hits plus refreshes — this alone removes almost all the key's read load from Redis and directly mitigates the hot-slot problem, because the traffic never reaches the one shard that owns the key. Redis keeps the local copies coherent by pushing an invalidation whenever the key changes, so I'm not serving stale data for a blind TTL. Second, the reads that do miss go through a pooled, warm connection, so no per-request handshake. Third, if a miss needs several related values, I pipeline them into one round trip. The risks I'd name: (1) a staleness window equal to the invalidation propagation time — fine for most caching, unacceptable if the value must be strictly current, in which case I'd shorten the window or not cache locally; (2) a thundering herd of invalidation-then-refetch if the hot key changes frequently, where every instance invalidates and re-reads at once — I'd add jitter or request coalescing on the refetch (chapter on hot keys); (3) client memory and the risk of a near-cache bug serving stale locally, so I bound its size and keep a backstop TTL; and (4) RESP3 and client support being required. The payoff is enormous — the hottest key stops being a shard hotspot — but I'd size the staleness tolerance consciously rather than assume local caching is free of consistency cost.

**Q: (Senior) Your Redis p99 looks fine on the server but the application sees high Redis latency. How do you diagnose it?**
A: The split between a healthy server-side p99 and a bad client-observed latency is the tell that the problem is *around* Redis, on the client, not inside it — so I stop looking at the server's command timings and look at the client's connection behaviour. First, `SLOWLOG` on the server: if it's clean, no command is actually slow, confirming it's not execution. Then `PoolStats()` on the client — non-zero, climbing `Timeouts` means pool starvation: callers are queueing for a free connection, so the latency is *waiting for a connection*, not running the command, and the fix is a larger `PoolSize` (or fewer, batched commands). I'd check whether the code is opening connections per request instead of reusing a pooled client, which pays a handshake (and with TLS, several round trips) on every call — that shows up as high `connected_clients` churn on the server and per-request millisecond latency. I'd look at round-trip amplification: a loop of single `GET`s that should be an `MGET` or pipeline turns one exchange into hundreds, so I audit hot paths for chattiness. `redis-cli --latency` isolates the raw network RTT so I know the floor. And I'd check for head-of-line blocking: a slow command on a pooled connection (a big `HGETALL`, a Lua script) ties up that connection and stalls everything queued behind it. The frame is: server p99 measures execution; the gap to client-observed latency is round trips, connection acquisition, and network — and pool stats plus a chattiness audit find it almost every time.

**Q: (Senior) What are the consistency and failure-mode implications of a server-pushed invalidation cache versus a plain TTL local cache?**
A: A plain TTL local cache is *pull-based and blind*: it serves a value until the TTL expires regardless of whether the underlying data changed, so its worst-case staleness is the full TTL, and its failure mode is graceful but dumb — it never serves *more* stale than the TTL, but it happily serves stale for the whole window and re-reads on expiry even if nothing changed. A server-pushed invalidation cache is *push-based and precise*: its staleness window is only the propagation time of the invalidation message, typically milliseconds, so it's far fresher, but its correctness now *depends on the delivery of the push*. That introduces new failure modes: if the invalidation connection drops, or a push is missed, the client can serve stale data indefinitely until something else refreshes it — so a robust implementation keeps a backstop TTL underneath the push mechanism (belt and braces) and treats a tracking-connection reconnect as a signal to flush the local cache, because it may have missed invalidations while disconnected. There's also the server-memory dimension: default-mode tracking costs the server memory to remember keys, and when the tracking table overflows it evicts and invalidates, which is a correctness-preserving but churn-inducing event. So the trade is precision and freshness (push) versus simplicity and self-containment (TTL): push gives you a tiny staleness window at the cost of depending on message delivery and needing careful reconnect handling, while TTL gives you a larger but bounded, delivery-independent staleness with no server-side memory cost. In practice I run push *with* a conservative TTL backstop, getting the freshness of invalidation and the safety of expiry.

**Q: When should you NOT use a client-side cache?**
A: When the data must be strictly current and even a millisecond of staleness is unacceptable — a client-side cache always has a non-zero staleness window (the invalidation propagation time), so anything requiring linearizable read-your-writes on every read shouldn't be served locally. Also when the value changes so frequently that the invalidation churn plus refetch costs more than just reading from Redis each time — a write-heavy key defeats the near-cache because every write triggers an invalidation and the next read re-fetches, so you get the complexity with little hit-rate benefit. And when the working set the client would cache is huge and low-hit-ratio, since you'd spend application memory caching things you rarely re-read. The near-cache pays off for hot, read-heavy, tolerably-stale keys; for cold, write-heavy, or strictly-consistent data it's the wrong tool.

## 10. Quick Revision & Cheat Sheet

| Technique | Removes | Key knob |
|---|---|---|
| Client-side caching | The round trip entirely (local hit) | `CLIENT TRACKING`, RESP3 |
| Connection pooling | Per-request handshake | `PoolSize`, `MinIdleConns` |
| Pipelining | N−1 of N round trips | `Pipeline()` / `MGET` |
| RESP3 | (enables invalidation push) | `Protocol: 3` |

| Tracking mode | Server memory | Client sees |
|---|---|---|
| Default | Remembers exact keys (bounded) | Only its own cached keys' invalidations |
| Broadcasting (`BCAST`) | ~Zero (prefixes only) | All invalidations for subscribed prefixes |

| Pool symptom | Meaning | Action |
|---|---|---|
| `Timeouts` > 0 | Callers waiting for a connection | Raise `PoolSize` / batch |
| High idle, low hits | Pool oversized | Lower `PoolSize` |
| High `connected_clients` churn | Connecting per request | Reuse pooled client |

**Flash cards**
- **What dominates client latency?** → Round trips, not command execution; remove them.
- **Zero-round-trip reads?** → Client-side near-cache with `CLIENT TRACKING`.
- **How does the near-cache stay fresh?** → Redis pushes an invalidation over RESP3 when a tracked key changes.
- **Default vs BCAST?** → Exact keys (server memory) vs prefixes (near-zero memory, noisier).
- **Why pool?** → Pay the TCP/TLS handshake once, not per request; bound concurrency.
- **Pool timeouts climbing?** → Pool too small for concurrency; raise `PoolSize`.
- **Best hot-key fix?** → Local cache in every app instance; the round trip never reaches the shard.
- **Head-of-line blocking?** → A slow command holds its pooled connection; give blocking ops a dedicated connection.
- **Connection-budget ceiling?** → Sum of all instances' pools vs `maxclients`; right-size pools, near-cache, or add a proxy.

## 11. Hands-On Exercises & Mini Project

- [ ] Benchmark 10 000 `GET`s with a fresh connection per request versus a pooled client; measure the latency difference and attribute it to the handshake.
- [ ] Fetch 500 keys with a loop of `GET`s versus one pipeline versus `MGET`; chart round trips and total time.
- [ ] Enable `CLIENT TRACKING` in `redis-cli -3`, read a key, modify it from another client, and observe the invalidation push arrive.
- [ ] Build a tiny near-cache in Go that serves from local memory and evicts on invalidation pushes; measure the hit-ratio and latency on a hot key.
- [ ] Deliberately undersize the pool under concurrent load and watch `PoolStats().Timeouts` climb; raise `PoolSize` and watch them disappear.
- [ ] Compare default and `BCAST` tracking modes on a hot prefix and measure the invalidation message volume each client receives.
- [ ] Run a slow command (a big `HGETALL`) on a small pool under concurrent load and observe head-of-line blocking in the latency of unrelated commands; then move it to a dedicated connection.
- [ ] Measure the added latency of TLS by benchmarking pooled versus per-request connections with `tls` enabled, isolating the handshake cost.

### Mini Project — "Near-Cache with Server-Pushed Invalidation"

**Goal.** Build a coherent client-side cache in front of Redis and prove it eliminates round trips for a hot key while staying fresh, so the latency-budget model becomes concrete.

**Requirements.**
1. Configure a go-redis client with a tuned pool (`PoolSize`, `MinIdleConns`) and RESP3 (`Protocol: 3`).
2. Maintain an in-process LRU near-cache with a bounded size and a backstop TTL.
3. Enable `CLIENT TRACKING` and wire the invalidation pushes to evict the corresponding near-cache entries.
4. Drive a read-heavy load on a hot key and measure the near-cache hit ratio and the p99 latency versus a no-near-cache baseline.
5. Mutate the hot key from a second client and prove the near-cache serves the new value within the invalidation propagation window (measure it).

**Extensions.**
- Kill and reconnect the tracking connection mid-run and show that flushing the near-cache on reconnect prevents serving stale data missed during the gap.
- Compare default vs `BCAST` mode under a churny prefix and quantify the server memory (`tracking-table-max-keys` pressure) versus client invalidation volume trade-off.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Build: Pipelining, Transactions & Lua* (the batching lever this chapter cross-references), *Design: Redis Cluster* (where per-node pools and hot-key mitigation matter most), *Redis as a Cache* (RESP and the single-threaded model that makes round trips the cost), *Replication & Redis Sentinel* (how the pooled client discovers and reconnects to the primary), *Hot Keys & Request Coalescing* (the near-cache as the primary hot-key fix), *Consistency & Invalidation* (the staleness window client-side caching introduces).

- **Redis — Client-side caching** — Redis · *Advanced* · the authoritative description of `CLIENT TRACKING`, default vs broadcasting mode, and the RESP3 invalidation protocol. <https://redis.io/docs/latest/develop/reference/client-side-caching/>
- **Redis — RESP3 protocol specification** — Redis · *Advanced* · the push message type that invalidations ride on, and how RESP3 differs from RESP2. <https://redis.io/docs/latest/develop/reference/protocol-spec/>
- **Redis — Pipelining** — Redis · *Intermediate* · why batching commands amortises round trips and the throughput it unlocks. <https://redis.io/docs/latest/develop/use/pipelining/>
- **Redis — CLIENT TRACKING & TRACKINGINFO commands** — Redis · *Advanced* · the exact command surface for enabling and inspecting tracking, used for debugging invalidations. <https://redis.io/docs/latest/commands/client-tracking/>
- **go-redis — Connection pool & options** — redis/go-redis · *Intermediate* · the pool-sizing knobs (`PoolSize`, `MinIdleConns`, `PoolTimeout`) and `PoolStats` used in §5. <https://redis.uptrace.dev/guide/go-redis.html>
- **Redis — Latency diagnosis (redis-cli --latency)** — Redis · *Intermediate* · measuring the raw round-trip time that client-side techniques fight against. <https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency/>
- **Designing Data-Intensive Applications (ch. 1, latency & percentiles)** — Martin Kleppmann · *Advanced* · the reasoning about tail latency and where milliseconds actually go. <https://dataintensive.net/>
- **Redis — CLIENT NO-EVICT / connection management** — Redis · *Intermediate* · how the server accounts for connections and the `maxclients` budget your pools consume. <https://redis.io/docs/latest/commands/client-list/>
- **Redis University — RU101 & RU330** — Redis · *Intermediate* · free courses covering client behaviour, RESP, and performance tuning hands-on. <https://university.redis.com/>

---

*Caching with Redis Handbook — chapter 27.*
