# 03 · Redis as a Cache: Architecture & Why It Fits

> **In one line:** Redis is fast because it does the counterintuitive thing — it processes commands on a *single* thread — and that one design choice is simultaneously the source of its atomicity guarantees, its predictable latency, and the operational rules you must never break.

---

## 1. Overview

Redis — **RE**mote **DI**ctionary **S**erver — is an in-memory data structure store, created by Salvatore Sanfilippo in 2009, that has become the default distributed cache for a large fraction of the internet. It is used for far more than caching (message queues, rate limiters, leaderboards, session stores), but caching is its most common job, and understanding *why* it fits that job requires understanding its architecture, which is unusual in a specific and instructive way.

The headline surprise is that **Redis executes commands on a single thread**. In an era where performance is assumed to come from parallelism, Redis serves hundreds of thousands of operations per second from one core running a tight event loop. This is not a limitation Redis works around; it is the design, and it is the reason for most of Redis's best properties. Because only one command runs at a time, every single command is atomic with no locking. Because there is no lock contention or context switching, latency is low and predictable. Because the data model is rich — not just strings but hashes, sets, sorted sets, streams — a single round trip can do work that would take many in a plain key-value store.

The counterpart is that the single thread is also the constraint you must respect. A slow command — one that touches millions of elements, or a badly-written Lua script — blocks *every other client* while it runs, because there is only one thread to run them on. The most damaging Redis production incidents are almost always some variant of "one command blocked the event loop". So the architecture gives you atomicity and predictability for free, and asks in return that you never issue a command that takes a long time.

This chapter explains the event loop, the memory model, the RESP protocol, and how Redis compares to its main alternative, Memcached — so that when later chapters say "this is atomic" or "never run this command in production", you know precisely why.

## 2. Core Concepts

- **In-memory store** — all data lives in RAM, which is why reads and writes are microsecond-fast and why capacity is bounded by memory.
- **Single-threaded command execution** — one thread runs the event loop and executes every command; the source of atomicity and predictable latency.
- **Event loop** — the loop that multiplexes many client connections, reading commands, executing them one at a time, and writing replies.
- **I/O threads** — optional helper threads (Redis 6+) that parallelise *reading and writing sockets*, not command execution.
- **RESP** — REdis Serialization Protocol, the simple text-based wire format between client and server.
- **Command atomicity** — every individual command is atomic because nothing else runs during it; no locks needed.
- **Data structures** — strings, hashes, lists, sets, sorted sets, streams, plus bitmaps and HyperLogLog — server-side types that reduce round trips.
- **Blocking command** — one whose execution time scales with data size; the thing that stalls the event loop and hurts everyone.
- **Persistence** — optional durability via snapshots (RDB) or an append-only log (AOF); usually disabled for a pure cache (chapter 24).
- **Memcached** — the other classic distributed cache; simpler, multi-threaded, strings-only, and a useful contrast.

## 3. Theory & Principles

### Why single-threaded is fast

The intuition that more threads means more speed breaks down for a workload like Redis's, where each operation is tiny (a hash lookup, an increment) and the bottleneck is not CPU computation but memory access and coordination. Adding threads to that workload buys you the *costs* of concurrency — locks, cache-line contention, context switches — while the *work* itself is too small to parallelise usefully. Redis's designer measured this and chose the opposite: one thread, no locks, no contention.

The performance then comes from three places:

1. **No locking.** Because only one command runs at a time, data structures need no mutexes. Every operation runs at memory speed with no coordination overhead. In a multi-threaded store, a huge fraction of the code is lock management; in Redis, none of it is.
2. **An efficient event loop.** Redis multiplexes thousands of connections with `epoll`/`kqueue`, so one thread handles enormous concurrency without a thread per connection. The loop reads ready sockets, executes commands, and writes replies in a tight cycle.
3. **Everything in RAM.** No disk I/O on the read or write path (persistence, when enabled, happens out of band). A memory access is ~100 ns; a disk seek is ~10 ms — five orders of magnitude. Keeping the working set in RAM is the whole point.

Redis 6 added *I/O threads*, but this is widely misunderstood: they parallelise the *socket reading and writing*, not the command execution. Command execution is still single-threaded, so atomicity is preserved. I/O threads only help when network I/O — not command processing — is the bottleneck, which is a specific and less common case.

### Atomicity for free — and the blocking hazard

The single most useful consequence of single-threaded execution is that **every command is atomic without you doing anything**. `INCR` reads, increments, and writes with no possibility of a lost update, because no other command can interleave. `SETNX` (set if not exists) is a correct lock primitive because the check-and-set cannot be split. This is why Redis is a natural fit for counters, rate limiters and locks — operations that in a multi-threaded store would need careful synchronisation are atomic by construction.

The hazard is the mirror image. Because there is one thread, **a slow command blocks all others**. `KEYS *` on a database with ten million keys scans every key on the single thread, and for the seconds that takes, every other client's commands wait. `FLUSHALL` on a huge dataset, a `SORT` over a giant list, a Lua script with an accidental loop — each monopolises the one thread. The operational rule that falls out is absolute: **never run an O(N) command over a large N in production**. The safe alternatives exist for exactly this reason — `SCAN` instead of `KEYS`, `UNLINK` instead of `DEL` for large keys, `SCAN`-based iteration instead of `SMEMBERS` on a huge set.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="a1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
    <marker id="a2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">One thread: the source of atomicity AND the blocking hazard</text>

  <rect x="30" y="44" width="820" height="180" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="440" y="66" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Normal operation: fast commands, atomic by construction</text>

  <g font-size="9">
    <rect x="50" y="82" width="90" height="24" rx="4" fill="#dcfce7" stroke="#16a34a"/><text x="95" y="98" text-anchor="middle" fill="#166534">client A: INCR</text>
    <rect x="50" y="112" width="90" height="24" rx="4" fill="#dcfce7" stroke="#16a34a"/><text x="95" y="128" text-anchor="middle" fill="#166534">client B: GET</text>
    <rect x="50" y="142" width="90" height="24" rx="4" fill="#dcfce7" stroke="#16a34a"/><text x="95" y="158" text-anchor="middle" fill="#166534">client C: SETNX</text>
  </g>
  <path d="M142,94 L206,110" stroke="#16a34a" stroke-width="1.5" marker-end="url(#a1)"/>
  <path d="M142,124 L206,124" stroke="#16a34a" stroke-width="1.5" marker-end="url(#a1)"/>
  <path d="M142,154 L206,138" stroke="#16a34a" stroke-width="1.5" marker-end="url(#a1)"/>

  <rect x="210" y="96" width="180" height="56" rx="8" fill="#bbf7d0" stroke="#16a34a" stroke-width="2"/>
  <text x="300" y="118" text-anchor="middle" fill="#14532d" font-size="11" font-weight="bold">event loop</text>
  <text x="300" y="136" text-anchor="middle" fill="#166534" font-size="9">ONE command at a time</text>

  <path d="M392,124 L448,124" stroke="#16a34a" stroke-width="1.5" marker-end="url(#a1)"/>
  <rect x="452" y="82" width="380" height="132" rx="8" fill="#fff" stroke="#16a34a"/>
  <text x="642" y="102" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">executed serially, in microseconds each</text>
  <text x="468" y="124" fill="#166534" font-size="9">INCR &#8594; read, +1, write &#8212; NOTHING can interleave</text>
  <text x="468" y="142" fill="#166534" font-size="9">&#8594; atomic with no locks, no mutexes, no coordination</text>
  <text x="468" y="164" fill="#166534" font-size="9">SETNX is a correct lock primitive for the same reason</text>
  <text x="468" y="186" fill="#15803d" font-size="9" font-weight="bold">100k&#8211;1M ops/sec from ONE core, predictable latency</text>
  <text x="468" y="204" fill="#166534" font-size="9">(no lock contention, no context switches)</text>

  <rect x="30" y="240" width="820" height="212" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="440" y="262" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">The mirror image: one slow command blocks EVERYONE</text>

  <rect x="50" y="278" width="200" height="30" rx="4" fill="#fee2e2" stroke="#dc2626"/>
  <text x="150" y="298" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">client X: KEYS *  (10M keys)</text>
  <path d="M252,293 L308,293" stroke="#dc2626" stroke-width="2" marker-end="url(#a2)"/>
  <rect x="312" y="278" width="220" height="30" rx="4" fill="#fecaca" stroke="#dc2626" stroke-width="2"/>
  <text x="422" y="298" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">event loop busy for SECONDS</text>

  <rect x="312" y="320" width="120" height="24" rx="4" fill="#fff" stroke="#fca5a5"/><text x="372" y="336" text-anchor="middle" fill="#991b1b" font-size="9">A: GET &#8212; WAITING</text>
  <rect x="312" y="350" width="120" height="24" rx="4" fill="#fff" stroke="#fca5a5"/><text x="372" y="366" text-anchor="middle" fill="#991b1b" font-size="9">B: SET &#8212; WAITING</text>
  <rect x="312" y="380" width="120" height="24" rx="4" fill="#fff" stroke="#fca5a5"/><text x="372" y="396" text-anchor="middle" fill="#991b1b" font-size="9">C: INCR &#8212; WAITING</text>
  <text x="500" y="360" fill="#991b1b" font-size="10">Every other client's latency spikes to seconds.</text>
  <text x="500" y="378" fill="#991b1b" font-size="10">This is the #1 cause of Redis production incidents.</text>

  <text x="50" y="336" fill="#b91c1c" font-size="10" font-weight="bold">The rule:</text>
  <text x="50" y="356" fill="#991b1b" font-size="9">Never run an O(N)</text>
  <text x="50" y="370" fill="#991b1b" font-size="9">command over large N.</text>
  <text x="50" y="392" fill="#166534" font-size="9">Use SCAN not KEYS,</text>
  <text x="50" y="406" fill="#166534" font-size="9">UNLINK not DEL,</text>
  <text x="50" y="420" fill="#166534" font-size="9">cursor-iterate large sets.</text>
</svg>
```

### The RESP protocol and rich data types

Redis speaks **RESP** (REdis Serialization Protocol), a simple, human-readable, text-based format. A `SET foo bar` command on the wire is just `*3\r\n$3\r\nSET\r\n$3\r\nfoo\r\n$3\r\nbar\r\n` — a count of arguments, then each argument prefixed by its length. Its simplicity is deliberate: it is trivial to parse, which keeps the event loop fast, and trivial to implement, which is why Redis has clients in every language. RESP3 (Redis 6+) adds richer types (maps, sets, doubles) and the push messages that enable client-side caching (chapter 27).

The other architectural advantage is the **rich data model**. Redis is not a plain key-value store; a value can be a hash (a map of fields), a sorted set (elements ordered by score), a stream (an append-only log), and more. This matters for caching because it moves work to the server and cuts round trips. Caching a user object as a Redis *hash* lets you read or update a single field (`HGET user:9 email`) without fetching and rewriting the whole object. Implementing a rate limiter as a *sorted set* lets one atomic command do what would otherwise be several. The data model is why one Redis round trip often replaces several round trips against a dumb key-value store — a real latency win that Memcached, which stores only opaque strings, cannot match.

## 4. Architecture & Workflow

The path of a command through Redis:

1. **Connection.** A client opens a TCP connection (or a Unix socket). Redis registers it with the event loop. Connections are long-lived and pooled by clients (chapter 27).
2. **Read.** The event loop, via `epoll`/`kqueue`, notices the socket has data, reads the RESP-encoded command, and parses it.
3. **Execute.** The command runs on the single thread. This is where atomicity lives: nothing else executes until this command finishes. The command mutates the in-memory data structures directly.
4. **Reply.** The result is RESP-encoded and written back to the client's socket. If the socket is not immediately writable, the reply is buffered and written when the loop next sees it ready.
5. **Persistence (out of band).** If RDB or AOF is enabled, changes are recorded — RDB via a forked child process taking a snapshot, AOF by appending to a log. Crucially, this happens *outside* the command execution path so it does not block the event loop (though the `fork` for RDB has its own cost, chapter 24).
6. **Eviction (as needed).** If `maxmemory` is set and reached, the configured policy evicts keys to make room, on the same thread, as part of processing the command that needed the space (chapter 7).

For a *pure cache*, persistence is usually disabled entirely: the data is a disposable copy of the origin, so there is nothing to protect, and disabling RDB/AOF removes the fork cost and the disk I/O. This is a deliberate configuration choice that distinguishes "Redis as a cache" from "Redis as a database".

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Redis vs Memcached: the trade a cache designer makes</text>

  <rect x="24" y="42" width="410" height="300" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="229" y="66" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Memcached</text>
  <g font-size="10" fill="#7f1d1d">
    <text x="42" y="92" font-weight="bold">Multi-threaded</text>
    <text x="42" y="110">scales across cores for pure GET/SET throughput</text>
    <text x="42" y="134" font-weight="bold">Strings only</text>
    <text x="42" y="152">opaque blobs; all structure lives in the client</text>
    <text x="42" y="176" font-weight="bold">No persistence, no replication (core)</text>
    <text x="42" y="194">pure ephemeral cache; a restart is a cold cache</text>
    <text x="42" y="218" font-weight="bold">LRU eviction, slab allocator</text>
    <text x="42" y="236">simple and predictable memory behaviour</text>
  </g>
  <rect x="42" y="252" width="374" height="76" rx="6" fill="#fff" stroke="#fca5a5"/>
  <text x="229" y="272" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">Choose when</text>
  <text x="56" y="292" fill="#991b1b" font-size="9">you need ONLY a fast string cache at very high throughput,</text>
  <text x="56" y="308" fill="#991b1b" font-size="9">the extra cores help, and you want nothing but GET/SET.</text>
  <text x="56" y="322" fill="#991b1b" font-size="9">Rare today &#8212; Redis usually wins on features.</text>

  <rect x="446" y="42" width="410" height="300" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="651" y="66" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Redis</text>
  <g font-size="10" fill="#14532d">
    <text x="464" y="92" font-weight="bold">Single-threaded execution</text>
    <text x="464" y="110">atomic commands, predictable latency, no locks</text>
    <text x="464" y="134" font-weight="bold">Rich data types</text>
    <text x="464" y="152">hashes, sorted sets, streams, bitmaps, HLL &#8594; fewer round trips</text>
    <text x="464" y="176" font-weight="bold">Optional persistence + replication + Cluster</text>
    <text x="464" y="194">can survive restarts and scale horizontally</text>
    <text x="464" y="218" font-weight="bold">Lua, transactions, Pub/Sub, client-side caching</text>
    <text x="464" y="236">server-side atomicity and invalidation primitives</text>
  </g>
  <rect x="464" y="252" width="374" height="76" rx="6" fill="#fff" stroke="#86efac"/>
  <text x="651" y="272" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">Choose when (almost always)</text>
  <text x="478" y="292" fill="#166534" font-size="9">you want a cache that is also a data-structure server:</text>
  <text x="478" y="308" fill="#166534" font-size="9">rate limiters, leaderboards, locks, atomic counters,</text>
  <text x="478" y="322" fill="#166534" font-size="9">precise invalidation, and HA/scaling paths when you grow.</text>
</svg>
```

## 5. Implementation

The best way to internalise the architecture is to see its consequences in code — atomicity you can rely on, and the blocking commands you must avoid.

```go
package redisbasics

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// AtomicCounter demonstrates the atomicity the single thread gives for free.
// A thousand concurrent clients calling INCR on the same key produce exactly
// 1000 with NO lost updates and NO locking on the client side — because on the
// server, the read-modify-write of INCR cannot be interleaved by any other
// command. This is the property that makes Redis a natural counter/limiter.
func AtomicCounter(ctx context.Context, rdb *redis.Client, key string) (int64, error) {
	// INCR: atomic by construction. There is no compare-and-set loop, no
	// mutex, no transaction — the single thread guarantees it.
	return rdb.Incr(ctx, key).Result()
}

// SafeKeyScan shows the CORRECT way to iterate keys in production. KEYS * would
// scan every key on the single thread and block the whole server for the
// duration; SCAN returns a cursor and a small batch, yielding the thread
// between batches so other clients are not starved.
func SafeKeyScan(ctx context.Context, rdb *redis.Client, pattern string) ([]string, error) {
	var (
		cursor uint64
		keys   []string
	)
	for {
		// COUNT is a hint for batch size — small enough that each SCAN call is
		// a short, non-blocking operation on the event loop.
		batch, next, err := rdb.Scan(ctx, cursor, pattern, 100).Result()
		if err != nil {
			return nil, err
		}
		keys = append(keys, batch...)
		cursor = next
		if cursor == 0 { // a returned cursor of 0 means iteration is complete
			break
		}
	}
	return keys, nil
}

// DEMONSTRATION of what NOT to do. This function exists only to be pointed at.
// Never ship it.
func DangerousBlockingScan(ctx context.Context, rdb *redis.Client) ([]string, error) {
	// KEYS * is O(N) over the ENTIRE keyspace on the single thread. On a
	// production instance with millions of keys this blocks the event loop for
	// seconds, spiking every other client's latency. The Redis docs say in
	// bold: do not use KEYS in production. Use SCAN.
	return rdb.Keys(ctx, "*").Result()
}

// DeleteLargeKey shows UNLINK vs DEL. DEL frees a large collection's memory
// synchronously on the single thread (blocking); UNLINK removes the key from
// the keyspace immediately and reclaims the memory in a BACKGROUND thread, so
// the event loop is not blocked freeing millions of elements.
func DeleteLargeKey(ctx context.Context, rdb *redis.Client, key string) error {
	// For a small key it makes no difference; for a huge hash/set/zset, UNLINK
	// avoids a multi-second stall.
	return rdb.Unlink(ctx, key).Err()
}

// UseRichTypes shows why the data model reduces round trips. Caching a user as
// a HASH lets you read or update a single field without fetching and
// rewriting the whole object — impossible in a strings-only store.
func UseRichTypes(ctx context.Context, rdb *redis.Client, userID string) error {
	key := fmt.Sprintf("user:%s", userID)

	// One round trip populates a structured object.
	if err := rdb.HSet(ctx, key,
		"name", "Ada", "email", "ada@example.com", "logins", 0,
	).Err(); err != nil {
		return err
	}
	rdb.Expire(ctx, key, 10*time.Minute)

	// Read ONE field — no need to fetch the whole object (contrast: a JSON
	// string in Memcached would require GET + decode + re-encode + SET).
	email, err := rdb.HGet(ctx, key, "email").Result()
	if err != nil {
		return err
	}
	_ = email

	// Increment ONE field atomically — server-side, one round trip.
	return rdb.HIncrBy(ctx, key, "logins", 1).Err()
}
```

The code encodes the two lessons of the architecture: rely on atomicity (it is free and correct), and never issue a command whose cost scales with a large N, because it will block the one thread that serves everyone.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Atomicity for free.** Every command is atomic with no locking, which makes counters, rate limiters and locks correct by construction.
- **Predictable, low latency.** No lock contention or context switching means microsecond command times and a tight latency distribution.
- **Rich data model.** Hashes, sorted sets, streams and more move work to the server and cut round trips versus a plain key-value store.
- **A path to scale and durability.** Replication, Sentinel, Cluster and persistence exist when you need them, without changing the programming model.
- **Ubiquity.** Clients in every language, and it is the assumed default in most caching discussions and system designs.

**Disadvantages**
- **The single thread is a shared resource.** One slow command blocks every client, so an accidental O(N) operation is a whole-instance latency incident.
- **Memory-bound.** Capacity is limited by RAM, which is more expensive per byte than disk, so the working set must genuinely fit.
- **One core for execution.** A single Redis instance cannot use more than one core for command processing; scaling command throughput past one core means clustering (chapter 26).
- **Persistence has a cost.** RDB forks the process (memory and latency spikes); AOF adds write amplification. A pure cache usually disables both.

**Trade-offs**
- *Redis vs Memcached:* Redis wins on data types, atomicity primitives, persistence and scaling paths; Memcached's only edge is multi-threaded pure-string throughput, which rarely decides it today.
- *Features vs the single thread:* the rich data model is powerful but every command runs on the one thread, so a powerful command (a big `SORT`, a heavy Lua script) is also a blocking risk. Power and hazard are the same property.
- *Cache vs database:* running Redis as a durable database (persistence on, replication, careful failover) is possible but changes the operational profile; a pure cache disables persistence and treats data as disposable, which is simpler and faster.

## 7. Common Mistakes & Best Practices

- **`KEYS *` in production.** The canonical incident: an O(N) scan blocks the single thread for seconds. Always `SCAN`.
- **`DEL` on a huge collection.** Frees memory synchronously and blocks. Use `UNLINK` for large keys.
- **Heavy Lua scripts.** A script runs atomically on the one thread, so a slow script blocks everyone. Keep scripts short and bounded (chapter 22).
- **Assuming I/O threads make execution parallel.** They parallelise socket I/O, not command execution. Atomicity is preserved; command throughput per instance is still one core.
- **Treating Redis as unlimited memory.** It is RAM-bound. Set `maxmemory` and an eviction policy, or an OOM will take the instance down (chapter 7).
- **Persistence on for a pure cache.** The fork and disk I/O cost you latency for durability you do not need if the data is a disposable copy of the origin.
- **Storing giant values.** A single multi-megabyte value makes every command touching it slow and every network transfer large. Keep values small; split large objects.
- **Best practice: respect the one thread.** Every command should be O(1) or O(log N) or bounded; anything O(N) over large N is a production hazard, and the safe alternative almost always exists.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** The `SLOWLOG` records commands that exceeded a latency threshold — it is the first place to look when latency spikes, because it names the blocking command directly (chapter 28). `LATENCY DOCTOR` and `INFO commandstats` diagnose event-loop stalls and per-command cost.
- **Monitoring.** Watch commands-per-second, the latency distribution, and — critically — any command that appears in the slowlog, because on a single-threaded server one slow command is a global latency event. Memory usage and fragmentation matter too, since Redis is RAM-bound.
- **Security.** Redis historically trusted its network entirely; a Redis exposed to the internet with no auth is a well-known breach vector. Protected mode, `requirepass`/ACLs, TLS, and binding to internal interfaces are mandatory (chapter 29). Dangerous commands (`FLUSHALL`, `KEYS`, `CONFIG`) can be renamed or disabled.
- **Scaling.** A single instance scales *up* to the limits of one core and the machine's RAM. Past that, you scale *out*: replication for read scaling and HA (chapter 25), and Cluster for sharding the keyspace across multiple single-threaded instances, each owning a slice (chapter 26). The single-thread model is preserved per node; you get parallelism by having many nodes.

## 9. Interview Questions

**Q: Why is Redis single-threaded, and why is that fast?**
A: Because Redis's workload is many tiny operations — a hash lookup, an increment — where the bottleneck is not CPU computation but coordination, and adding threads to that buys the costs of concurrency (locks, contention, context switches) while the per-operation work is too small to parallelise usefully. With one thread, data structures need no mutexes, there is no lock contention or context switching, and everything runs at memory speed. The result is hundreds of thousands of operations per second from a single core with a tight, predictable latency distribution. Redis 6 added I/O threads, but those parallelise socket reading and writing, not command execution, so the single-threaded atomicity is preserved.

**Q: What does single-threaded execution give you as a cache designer?**
A: Atomicity for free. Because only one command runs at a time, every command is atomic with no locking — `INCR` cannot lose an update, `SETNX` is a correct lock primitive, an atomic rate-limiter is a single command. Operations that in a multi-threaded store would need careful synchronisation are correct by construction. It also gives predictable latency, because there is no lock contention to introduce tail-latency spikes. The cost, and the flip side of the same property, is that a slow command blocks every other client, so you must never run an O(N) command over a large N.

**Q: What is the single most dangerous thing you can do to a Redis instance?**
A: Run a command whose cost scales with a large dataset on the single execution thread — the canonical example being `KEYS *` on an instance with millions of keys. Because there is one thread, that command blocks every other client for however long it takes, turning a routine operation into a whole-instance latency incident that spikes everyone's p99 into seconds. The Redis documentation says in bold not to use `KEYS` in production for exactly this reason. The general rule is that any O(N) command over large N — `KEYS`, `SMEMBERS` on a huge set, `DEL` on a giant collection, an unbounded Lua loop — is a hazard, and the safe alternative almost always exists: `SCAN`, cursor iteration, `UNLINK`.

**Q: How does Redis's data model help caching compared to Memcached?**
A: Redis stores rich server-side data structures — hashes, sorted sets, streams, bitmaps — where Memcached stores only opaque strings. That moves work to the server and cuts round trips. Caching a user object as a Redis hash lets you read or update a single field with `HGET`/`HSET` without fetching and rewriting the whole object; in Memcached the object is one blob, so changing one field means GET, decode, modify, re-encode, SET. A rate limiter is one atomic sorted-set operation in Redis; in Memcached it is several non-atomic ones. So one Redis round trip frequently replaces several against a strings-only store, which is a real latency win.

**Q: When would you actually choose Memcached over Redis?**
A: Rarely, and only for a narrow profile: you need purely a fast string cache at very high throughput, the workload is so heavy on raw GET/SET that Memcached's multi-threaded execution across cores genuinely helps, and you want none of Redis's data types, persistence, replication, atomic primitives or scaling features. Memcached is simpler and its multi-threaded design can push more pure-string throughput per node. But most real caching benefits from at least one Redis feature — atomic counters, precise invalidation, structured objects, a path to HA — so in practice Redis is the default and Memcached is the exception.

**Q: (Senior) Explain the operational consequences of the single-threaded model for how you run Redis.**
A: The whole operational discipline flows from "one thread serves everyone". First, no command may be slow: I audit for `KEYS`, big `DEL`, unbounded `SORT`, heavy Lua, and `SMEMBERS`/`HGETALL` on large keys, and replace them with cursor-based or background alternatives, because any of them stalls the event loop for all clients. Second, big keys are a latency risk in themselves — a multi-megabyte value makes every touching command slow — so I monitor for and split large keys. Third, throughput per instance is capped at one core, so when command volume outgrows that, the answer is Cluster to shard across many single-threaded nodes, not a bigger machine. Fourth, persistence is out of band but not free — RDB forks the process, causing a memory copy-on-write spike and latency blip — so for a pure cache I disable it. Fifth, monitoring centres on the slowlog and the latency distribution, because on a single-threaded server one slow command is a global event, not a local one. The model gives me atomicity and predictability in exchange for never being allowed to block the thread.

**Q: (Senior) A Redis instance shows periodic latency spikes across all clients simultaneously. How do you investigate?**
A: Simultaneous spikes across all clients point at the shared resource — the single event loop being blocked — so I look for what monopolised it. First stop is `SLOWLOG GET`, which records commands that exceeded a threshold and often names the culprit directly: a `KEYS`, a big `SORT`, a heavy Lua script, a `DEL` on a giant key. If the slowlog is clean, I consider the out-of-band costs that still touch the process: an RDB `BGSAVE` fork causes a copy-on-write memory spike and, on large datasets, a latency blip, and AOF rewrite is similar — `INFO persistence` and the timing of spikes against save intervals confirm it. `LATENCY HISTORY` and `LATENCY DOCTOR` diagnose event-loop and fork-related stalls specifically. I would also check for a large key being accessed periodically (a cron job doing `HGETALL` on a growing hash), swap activity (Redis on a swapping host is catastrophic because a "memory" access becomes a disk seek on the one thread), and network saturation if I/O rather than execution is the bottleneck. The pattern of *all clients at once* is the tell: it is almost always the event loop being held, not any single client's problem.

**Q: (Senior) How does Redis stay atomic while also persisting data, without blocking?**
A: By keeping persistence out of the command execution path. Command execution — including any mutation — happens on the single thread and is atomic. Persistence then records those changes separately: RDB snapshots by forking a child process that writes a point-in-time copy of memory to disk using copy-on-write, so the parent keeps serving commands while the child writes; AOF appends each write command to a log file, with the actual `fsync` governed by a configurable policy that can be deferred so it does not block each command. Neither mechanism sits between the client and the atomic command, so atomicity and the single-threaded model are preserved. The costs are real but out of band: the RDB fork causes a copy-on-write memory amplification and a brief latency spike on large datasets, and AOF adds write amplification and a background rewrite. For a pure cache where the data is a disposable copy of the origin, I disable both, which removes even those out-of-band costs.

## 10. Quick Revision & Cheat Sheet

| Property | Consequence |
|---|---|
| Single-threaded execution | Atomic commands, no locks, predictable latency |
| One thread for all clients | A slow command blocks everyone — never run O(N) over large N |
| In-memory | Microsecond ops; RAM-bound capacity |
| RESP protocol | Simple, fast to parse, clients everywhere |
| Rich data types | Hashes/zsets/streams cut round trips vs strings-only |
| I/O threads (6+) | Parallelise sockets, NOT command execution |
| Persistence (optional) | Out of band; usually OFF for a pure cache |

| Never | Use instead |
|---|---|
| `KEYS *` | `SCAN` (cursor, batched) |
| `DEL` (huge key) | `UNLINK` (background free) |
| `SMEMBERS`/`HGETALL` (huge) | `SSCAN`/`HSCAN` |
| Heavy Lua / big `SORT` | Bounded, short scripts |

**Flash cards**
- **Why single-threaded?** → Tiny ops where coordination costs exceed parallelism gains; gives free atomicity + predictable latency.
- **What blocks the whole server?** → Any O(N) command over large N, on the one execution thread.
- **What do I/O threads do?** → Parallelise socket read/write, not command execution.
- **Atomicity comes from?** → One command at a time; no interleaving, no locks needed.
- **Redis vs Memcached?** → Rich types + atomics + persistence + scaling vs pure multi-threaded string throughput.
- **Persistence for a cache?** → Usually off; the data is a disposable copy of the origin.

## 11. Hands-On Exercises & Mini Project

- [ ] Hammer one key with 1000 concurrent `INCR`s and confirm the final value is exactly 1000, with no client-side locking. Explain why.
- [ ] Load a million keys, run `KEYS *`, and measure the latency of a concurrent `GET` during it. Then repeat with `SCAN` and observe the difference.
- [ ] Create a large hash and delete it with `DEL`, timing a concurrent command; repeat with `UNLINK` and compare.
- [ ] Cache a user object as a JSON string and as a hash, and compare the round trips needed to update one field.
- [ ] Inspect a command on the wire with `redis-cli --no-raw` or a packet capture to see the RESP encoding.
- [ ] Enable and read the `SLOWLOG`, then deliberately trigger a slow command and find it there.

### Mini Project — "Single-Thread Stress Lab"

**Goal.** Make the single-threaded architecture's benefits and hazards measurable, so the operational rules become intuition rather than memorised advice.

**Requirements.**
1. Demonstrate free atomicity: many concurrent clients incrementing a shared counter, arriving at the exact correct total with no coordination.
2. Demonstrate the blocking hazard: load millions of keys, run a blocking command (`KEYS`, big `DEL`, a heavy Lua loop) and chart the latency spike it inflicts on concurrent innocent clients.
3. Show the safe alternative: repeat with `SCAN`/`UNLINK` and show the latency staying flat.
4. Measure the round-trip advantage of the data model: cache an object as a string and as a hash and compare the operations required to read and update one field.
5. Instrument the slowlog and confirm the blocking command appears in it, so you can diagnose the same problem in production.

**Extensions.**
- Enable RDB persistence, trigger a `BGSAVE` under load, and measure the fork-induced latency blip; then disable persistence and confirm it disappears.
- Run a heavy Lua script and show it blocking all clients for its duration, illustrating that "atomic" and "blocking" are the same property for a slow script.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *What Is Caching?* (why we cache at all), *Where Caches Live* (Redis's place in the stack), *Redis Data Types & Which to Cache With* (the data model in depth), *Memory, maxmemory & Eviction* (the RAM bound), *Build: Pipelining, Transactions & Lua* (atomicity and the blocking hazard in practice), *Persistence: RDB, AOF & the Durability Trade-off* (the out-of-band cost).

- **Redis — Architecture & An introduction to Redis data types** — Redis · *Beginner* · the official overview of the model this chapter explains, and the natural next read. <https://redis.io/docs/latest/develop/data-types/>
- **Redis — FAQ: single-threaded and performance** — Redis · *Intermediate* · the maintainers' own explanation of why single-threaded, and what I/O threads do and do not parallelise. <https://redis.io/docs/latest/develop/get-started/faq/>
- **Redis — RESP protocol specification** — Redis · *Advanced* · the exact wire format, useful for understanding why the protocol is fast and how clients are built. <https://redis.io/docs/latest/develop/reference/protocol-spec/>
- **Redis vs Memcached** — Redis / AWS ElastiCache docs · *Intermediate* · a feature-by-feature comparison from both perspectives, useful for the "when Memcached?" question. <https://aws.amazon.com/elasticache/redis-vs-memcached/>
- **Redis — Latency monitoring & SLOWLOG** — Redis · *Advanced* · how to diagnose event-loop stalls, the direct consequence of the single-thread model. <https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency/>
- **Redis — Commands documentation (time complexity)** — Redis · *Intermediate* · every command lists its O(...) complexity; the reference for "will this block the thread?". <https://redis.io/docs/latest/commands/>
- **The Design and Implementation of Redis (talks by antirez)** — Salvatore Sanfilippo · *Advanced* · the creator's own explanation of the design decisions behind the architecture. <https://www.youtube.com/results?search_query=antirez+redis+design>
- **Redis University — RU101** — Redis · *Beginner* · a free course grounding the architecture and data types in hands-on exercises. <https://university.redis.com/>

---

*Caching with Redis Handbook — chapter 03.*
