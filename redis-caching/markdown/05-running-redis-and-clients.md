# 05 · Running Redis: redis-cli, Go & Python Clients

> **In one line:** Getting Redis running is trivial; the parts that decide whether your cache survives production are the ones nobody demos — the connection pool, the timeouts, and the handful of `redis.conf` lines that stop a cache from behaving like a database.

---

## 1. Overview

You can have Redis serving commands in under a minute — `brew install redis`, `docker run redis`, done — and that ease is exactly why so many teams ship a misconfigured cache. The install is not the interesting part. The interesting part is everything that surrounds the running server: how you talk to it interactively with `redis-cli`, which `redis.conf` settings turn a general-purpose Redis into a *cache*, and — most consequentially — how your application client is configured, because the connection pool and the timeouts are the difference between a cache that absorbs load and one that becomes the outage.

This chapter is the hands-on bridge between "Redis, the architecture" (chapter 3) and everything that follows. We install Redis three ways (Homebrew, apt, Docker), drive it with `redis-cli` so the wire-level commands become muscle memory, and then connect two real application clients: **go-redis v9** (`github.com/redis/go-redis/v9`), the primary language of this handbook, and **redis-py** for Python. For each we go past "it connects" into the settings that matter under load — pool size, dial/read/write timeouts, and the retry policy — and we finish with a first, correct cache-aside read-through, the pattern you will use ninety percent of the time.

The through-line is a bias the rest of the handbook shares: *a Redis client is not a database driver you configure once and forget.* Because Redis is single-threaded and microsecond-fast (chapter 3), the client-side pool and timeouts dominate the latency and failure behaviour your service actually experiences. Get them right here and the advanced chapters have a solid floor to build on.

## 2. Core Concepts

- **Redis server (`redis-server`)** — the daemon that runs the event loop and holds your data in RAM; started from a binary or a container image.
- **`redis-cli`** — the interactive command-line client; your primary tool for inspecting, debugging, and scripting a running instance.
- **`redis.conf`** — the server configuration file; a small subset of its directives (`maxmemory`, `maxmemory-policy`, `bind`, `requirepass`, `save`) turns Redis into a well-behaved cache.
- **Connection** — a long-lived TCP (or Unix-socket) session speaking RESP; clients keep these open rather than reconnecting per command.
- **Connection pool** — the client-side set of reusable connections; sized to concurrency, not to request rate, and the single most important client setting.
- **Dial / read / write timeouts** — bounds on how long the client waits to *establish* a connection and to *send/receive* a command; without them a stalled Redis stalls your service.
- **go-redis v9** — the maintained Go client (`github.com/redis/go-redis/v9`); a `*redis.Client` is safe for concurrent use and owns a pool internally.
- **redis-py** — the reference Python client; a `Redis` instance likewise wraps a pool.
- **Cache-aside (lazy loading)** — the default read pattern: try the cache, on a miss load from the origin and populate the cache with a TTL.
- **Container networking** — connecting to Redis in Docker means resolving the right host/port: `localhost:6379` from the host, the service name from another container on the same network.

## 3. Theory & Principles

### Installing is easy; the defaults are for a database, not a cache

Every install method gives you a Redis whose defaults are tuned for a *durable data store*, not a disposable cache. Out of the box, `maxmemory` is `0` (unlimited — Redis will consume RAM until the OS kills it), the eviction policy is `noeviction` (writes start failing when memory is exhausted rather than making room), and RDB snapshotting is on (periodic `fork`s you do not want for a pure cache). None of these are wrong for a database. All of them are wrong for a cache. So the mental model is: *installation gets you a server; three or four configuration changes get you a cache.* We will make exactly those changes in section 5, and chapters 6 and 7 go deep on TTLs and eviction respectively.

### The client is a pool, and the pool is sized to concurrency

The mistake that dominates real incidents is treating a Redis client like a single connection. Modern clients — go-redis, redis-py, Lettuce, ioredis — are **pools**. When your code calls `rdb.Get(...)`, the client checks out an idle connection from the pool, writes the command, reads the reply, and returns the connection. Under concurrency, many goroutines or threads check out connections simultaneously, so the pool must be large enough that they are not all waiting on each other — but not so large that you exhaust the server's connection limit or waste memory.

The correct sizing intuition is **concurrency, not throughput**. What matters is how many requests are *in flight at once*, each holding a connection for the microseconds a command takes. A service handling 100k requests/sec where each Redis call takes 200 microseconds only needs ~20 connections in flight on average (Little's Law: concurrency = rate × latency = 100,000 × 0.0002). go-redis defaults to `10 × runtime.GOMAXPROCS(0)` connections, which is a sane starting point precisely because it scales with the number of CPUs doing concurrent work. You raise it when you see pool-wait latency (`PoolStats().Timeouts` climbing); you do not raise it speculatively, because idle pooled connections cost memory on both ends.

### Timeouts are not optional — they are how you fail fast

Redis is single-threaded, so if one client issues a blocking command (`KEYS *`, chapter 3) or the network hiccups, *every* command in flight can stall. Without timeouts, your application threads block indefinitely waiting for a reply that may never come, and the stall propagates upward: connection-pool exhaustion, request queues backing up, and a cache dependency turning into a full outage. **Timeouts convert an unbounded stall into a bounded, retryable error.** You set a dial timeout (how long to wait to *open* a connection), a read timeout (how long to wait for a *reply*), and a write timeout (how long to wait to *send*). The read timeout is the load-bearing one: it must be short (single-digit to low-tens of milliseconds for a cache), because a cache call that takes longer than that has already failed its purpose — you would have been better off going to the origin.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="p1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="p2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The client is a pool &#8212; sized to concurrency, bounded by timeouts</text>

  <rect x="24" y="40" width="240" height="410" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="144" y="62" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">Your application</text>
  <g font-size="9" fill="#1e40af">
    <rect x="44" y="76" width="200" height="24" rx="4" fill="#fff" stroke="#2563eb"/><text x="144" y="92" text-anchor="middle">goroutine A: GET user:9</text>
    <rect x="44" y="106" width="200" height="24" rx="4" fill="#fff" stroke="#2563eb"/><text x="144" y="122" text-anchor="middle">goroutine B: SET sess:7</text>
    <rect x="44" y="136" width="200" height="24" rx="4" fill="#fff" stroke="#2563eb"/><text x="144" y="152" text-anchor="middle">goroutine C: HGET cfg</text>
    <rect x="44" y="166" width="200" height="24" rx="4" fill="#fff" stroke="#2563eb"/><text x="144" y="182" text-anchor="middle">goroutine D: waiting...</text>
  </g>
  <text x="144" y="214" text-anchor="middle" fill="#1e40af" font-size="9">many in flight at once = concurrency</text>

  <rect x="320" y="76" width="220" height="300" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="430" y="98" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">Connection pool</text>
  <text x="430" y="114" text-anchor="middle" fill="#6d28d9" font-size="9">default 10 &#215; GOMAXPROCS</text>
  <g font-size="9">
    <rect x="340" y="126" width="180" height="22" rx="4" fill="#c4b5fd" stroke="#7c3aed"/><text x="430" y="141" text-anchor="middle" fill="#4c1d95">conn 1 (in use by A)</text>
    <rect x="340" y="152" width="180" height="22" rx="4" fill="#c4b5fd" stroke="#7c3aed"/><text x="430" y="167" text-anchor="middle" fill="#4c1d95">conn 2 (in use by B)</text>
    <rect x="340" y="178" width="180" height="22" rx="4" fill="#c4b5fd" stroke="#7c3aed"/><text x="430" y="193" text-anchor="middle" fill="#4c1d95">conn 3 (in use by C)</text>
    <rect x="340" y="204" width="180" height="22" rx="4" fill="#ede9fe" stroke="#7c3aed" stroke-dasharray="3 2"/><text x="430" y="219" text-anchor="middle" fill="#6d28d9">conn 4 (idle)</text>
    <rect x="340" y="230" width="180" height="22" rx="4" fill="#ede9fe" stroke="#7c3aed" stroke-dasharray="3 2"/><text x="430" y="245" text-anchor="middle" fill="#6d28d9">conn 5 (idle)</text>
  </g>
  <rect x="340" y="262" width="180" height="102" rx="6" fill="#fff" stroke="#7c3aed"/>
  <text x="430" y="282" text-anchor="middle" fill="#5b21b6" font-size="9" font-weight="bold">Timeouts on every checkout</text>
  <text x="430" y="300" text-anchor="middle" fill="#6d28d9" font-size="8.5">DialTimeout: open a conn</text>
  <text x="430" y="316" text-anchor="middle" fill="#6d28d9" font-size="8.5">WriteTimeout: send command</text>
  <text x="430" y="332" text-anchor="middle" fill="#6d28d9" font-size="8.5">ReadTimeout: await reply</text>
  <text x="430" y="352" text-anchor="middle" fill="#b91c1c" font-size="8.5" font-weight="bold">stall &#8594; bounded error, retry</text>

  <path d="M264,140 L318,150" stroke="#2563eb" stroke-width="1.5" marker-end="url(#p1)"/>
  <path d="M264,180 L318,200" stroke="#dc2626" stroke-width="1.5" marker-end="url(#p2)"/>

  <rect x="600" y="76" width="256" height="300" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="728" y="98" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Redis (single thread)</text>
  <rect x="620" y="116" width="216" height="60" rx="6" fill="#bbf7d0" stroke="#16a34a"/>
  <text x="728" y="140" text-anchor="middle" fill="#14532d" font-size="10" font-weight="bold">event loop</text>
  <text x="728" y="158" text-anchor="middle" fill="#166534" font-size="9">ONE command at a time</text>
  <text x="620" y="200" fill="#166534" font-size="9">Little's Law:</text>
  <text x="620" y="218" fill="#166534" font-size="9">conns needed = rate &#215; latency</text>
  <text x="620" y="240" fill="#166534" font-size="9">100k/s &#215; 0.0002s &#8776; 20 conns</text>
  <text x="620" y="270" fill="#15803d" font-size="9" font-weight="bold">Size the pool to concurrency,</text>
  <text x="620" y="286" fill="#15803d" font-size="9" font-weight="bold">not to request rate.</text>
  <text x="620" y="316" fill="#166534" font-size="9">Too small &#8594; pool-wait timeouts.</text>
  <text x="620" y="334" fill="#166534" font-size="9">Too large &#8594; wasted RAM,</text>
  <text x="620" y="350" fill="#166534" font-size="9">server conn-limit pressure.</text>

  <path d="M540,240 L598,200" stroke="#16a34a" stroke-width="1.5" marker-end="url(#p1)"/>
</svg>
```

## 4. Architecture & Workflow

The lifecycle of a cached read through a real client, from process start to a cache hit:

1. **Construct the client once, at startup.** A `*redis.Client` (go) or `Redis` (python) is created once and shared for the process lifetime. It is safe for concurrent use and owns the pool. Creating one per request is the classic bug — it defeats pooling and floods the server with connections.
2. **Lazy connect.** Most clients do not dial on construction; the first command opens the first connection. A `PING` at startup is how you fail fast if Redis is unreachable, rather than discovering it on the first user request.
3. **Check out a connection.** On each command the client takes an idle connection from the pool (or opens a new one up to `PoolSize`, or waits up to `PoolTimeout` if the pool is saturated).
4. **Write, execute, read.** The command is RESP-encoded and written (bounded by `WriteTimeout`), executed on Redis's single thread, and the reply read back (bounded by `ReadTimeout`).
5. **Return the connection.** The connection goes back to the pool for reuse. It is *not* closed — connection setup (TCP handshake, optional TLS, `AUTH`, `SELECT`) is expensive relative to a command, so reuse is the whole point.
6. **Retry or fail.** On a transient error (timeout, connection reset), the client may retry per its policy; on a persistent failure the error surfaces to your code, which — for a cache — should fall back to the origin, not error the request.

```svg
<svg viewBox="0 0 880 440" width="100%" height="440" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="c1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
    <marker id="c2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#d97706"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Cache-aside read: the default path (and the fallback that keeps you up)</text>

  <rect x="40" y="50" width="150" height="54" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="115" y="74" text-anchor="middle" fill="#1e40af" font-weight="bold" font-size="11">Request</text>
  <text x="115" y="92" text-anchor="middle" fill="#1d4ed8" font-size="9">need user:9</text>

  <rect x="250" y="50" width="180" height="54" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="340" y="72" text-anchor="middle" fill="#5b21b6" font-weight="bold" font-size="11">GET cache</text>
  <text x="340" y="90" text-anchor="middle" fill="#6d28d9" font-size="9">bounded by ReadTimeout</text>

  <path d="M190,77 L246,77" stroke="#16a34a" stroke-width="1.6" marker-end="url(#c1)"/>

  <rect x="500" y="40" width="150" height="30" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="575" y="60" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">HIT: decode &amp; return</text>
  <path d="M430,66 L496,55" stroke="#16a34a" stroke-width="1.6" marker-end="url(#c1)"/>
  <text x="462" y="50" fill="#15803d" font-size="8.5">value found</text>

  <rect x="500" y="86" width="150" height="30" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="575" y="106" text-anchor="middle" fill="#92400e" font-size="10" font-weight="bold">MISS (nil)</text>
  <path d="M430,88 L496,98" stroke="#d97706" stroke-width="1.6" marker-end="url(#c2)"/>
  <text x="455" y="112" fill="#b45309" font-size="8.5">not found</text>

  <rect x="470" y="150" width="210" height="54" rx="8" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="575" y="172" text-anchor="middle" fill="#334155" font-weight="bold" font-size="11">Load from origin (DB)</text>
  <text x="575" y="190" text-anchor="middle" fill="#475569" font-size="9">the slow, authoritative source</text>
  <path d="M575,116 L575,146" stroke="#d97706" stroke-width="1.6" marker-end="url(#c2)"/>

  <rect x="470" y="230" width="210" height="54" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="575" y="252" text-anchor="middle" fill="#15803d" font-weight="bold" font-size="11">SET cache, EX ttl</text>
  <text x="575" y="270" text-anchor="middle" fill="#166534" font-size="9">populate so the next read hits</text>
  <path d="M575,204 L575,226" stroke="#16a34a" stroke-width="1.6" marker-end="url(#c1)"/>

  <rect x="470" y="310" width="210" height="40" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="575" y="335" text-anchor="middle" fill="#1e40af" font-weight="bold" font-size="11">Return value to request</text>
  <path d="M575,284 L575,306" stroke="#16a34a" stroke-width="1.6" marker-end="url(#c1)"/>

  <rect x="40" y="230" width="380" height="150" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="230" y="252" text-anchor="middle" fill="#b91c1c" font-size="11" font-weight="bold">If the cache CALL errors (timeout / down)</text>
  <text x="58" y="278" fill="#991b1b" font-size="10">A cache is an optimisation, not a dependency.</text>
  <text x="58" y="298" fill="#991b1b" font-size="10">On a Redis error, do NOT fail the request &#8594;</text>
  <text x="58" y="318" fill="#991b1b" font-size="10">fall back to the origin, log it, and carry on.</text>
  <text x="58" y="344" fill="#b91c1c" font-size="10" font-weight="bold">This is why ReadTimeout must be SHORT:</text>
  <text x="58" y="362" fill="#991b1b" font-size="10">a slow cache is worse than no cache.</text>
</svg>
```

## 5. Implementation

### Installing Redis

```bash
# --- macOS, Homebrew ---
brew install redis
redis-server                 # run in the foreground (Ctrl-C to stop)
# or run it as a background service that restarts on login:
brew services start redis

# --- Debian/Ubuntu, apt ---
sudo apt-get update
sudo apt-get install -y redis-server
sudo systemctl enable --now redis-server   # start now + on boot

# --- Docker: the most reproducible option ---
# -p publishes the container's 6379 to the host; --name lets other
# containers resolve it by name on a shared network.
docker run --name redis-cache -p 6379:6379 -d redis:7-alpine

# A one-shot redis-cli against that container, no local install needed:
docker exec -it redis-cache redis-cli PING     # -> PONG
```

### Driving Redis with `redis-cli`

```bash
redis-cli                    # connects to 127.0.0.1:6379 by default
redis-cli -h 10.0.0.5 -p 6380 -a "$REDIS_PASSWORD"   # remote + auth
redis-cli -n 2               # select logical DB 2 (0..15 by default)

# --- inside the REPL: the everyday commands ---
127.0.0.1:6379> SET greeting "hello" EX 60      # value with a 60s TTL
OK
127.0.0.1:6379> GET greeting
"hello"
127.0.0.1:6379> TTL greeting                    # seconds left before expiry
(integer) 57
127.0.0.1:6379> TYPE greeting                   # -> string
127.0.0.1:6379> OBJECT ENCODING greeting        # internal encoding (embstr/int/raw)
127.0.0.1:6379> DEL greeting                     # returns count removed

# --- inspection you will reach for constantly ---
redis-cli INFO server                 # version, uptime, config file path
redis-cli INFO memory                 # used_memory, maxmemory, fragmentation
redis-cli DBSIZE                      # number of keys in the current DB
redis-cli --scan --pattern 'user:*'  # SAFE cursor iteration (never KEYS in prod)
redis-cli --stat                      # a live 1s dashboard of ops/sec, memory
redis-cli MONITOR                     # firehose of every command (DEBUG ONLY)
redis-cli SLOWLOG GET 10             # the 10 slowest recent commands
```

### `redis.conf`: the lines that turn Redis into a cache

```conf
# ---- redis.conf: only the directives that matter for a cache ----

# Bind to internal interfaces only. NEVER expose Redis on 0.0.0.0 without
# auth + a firewall; an open Redis is a well-known breach vector (ch. 29).
bind 127.0.0.1 -::1
protected-mode yes

# Require a password. In Redis 6+, prefer ACL users, but requirepass is the
# floor. Use a long random secret; it is sent on every AUTH.
requirepass "change-me-to-a-long-random-secret"

# ---- The three lines that make it a CACHE, not a database ----
# Cap memory so Redis never eats the box and gets OOM-killed (ch. 7).
maxmemory 2gb
# When full, evict keys to make room instead of failing writes. For a pure
# cache, allkeys-lru is the sane default (ch. 7 covers the alternatives).
maxmemory-policy allkeys-lru

# Disable RDB snapshotting for a pure cache: the data is a disposable copy of
# the origin, so there is nothing to persist, and we skip the fork cost (ch. 24).
save ""
appendonly no

# Cap per-client output buffers so one slow consumer can't balloon memory.
timeout 0                    # 0 = don't close idle client connections
tcp-keepalive 300            # detect dead peers
```

### Connecting from Go with go-redis v9

```go
package cache

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"time"

	"github.com/redis/go-redis/v9"
)

// NewClient builds the ONE client the whole process shares. A *redis.Client is
// safe for concurrent use by many goroutines and owns its connection pool
// internally — construct it at startup, never per request.
func NewClient(ctx context.Context, addr, password string) (*redis.Client, error) {
	rdb := redis.NewClient(&redis.Options{
		Addr:     addr,     // "localhost:6379"
		Password: password, // "" if no auth
		DB:       0,        // logical DB; 0 for a cache

		// ---- Pool: sized to CONCURRENCY, not request rate (see §3) ----
		// The default is 10 * GOMAXPROCS; we set it explicitly so it is
		// visible and reviewable. Raise it only if PoolStats().Timeouts climbs.
		PoolSize:        10 * runtime.GOMAXPROCS(0),
		MinIdleConns:    5,               // keep warm conns ready for bursts
		ConnMaxIdleTime: 30 * time.Minute, // reap conns idle longer than this

		// ---- Timeouts: how we FAIL FAST instead of stalling (see §3) ----
		DialTimeout:  2 * time.Second,        // opening a new connection
		ReadTimeout:  200 * time.Millisecond, // awaiting a reply — keep SHORT
		WriteTimeout: 200 * time.Millisecond, // sending the command
		PoolTimeout:  50 * time.Millisecond,  // wait for a free conn, then error

		// ---- Retries for transient blips (a reconnect, a reset) ----
		MaxRetries:      3,
		MinRetryBackoff: 8 * time.Millisecond,
		MaxRetryBackoff: 512 * time.Millisecond,
	})

	// Fail fast at startup if Redis is unreachable, rather than discovering it
	// on the first user request. The lazy-connect model means construction
	// alone does not dial.
	pingCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if err := rdb.Ping(pingCtx).Err(); err != nil {
		return nil, fmt.Errorf("redis unreachable at %s: %w", addr, err)
	}
	return rdb, nil
}

// GetUser is a correct cache-aside (read-through) read. Note the three
// distinct outcomes: hit, clean miss, and cache ERROR — and that an error
// falls through to the origin rather than failing the request.
func GetUser(ctx context.Context, rdb *redis.Client, db UserStore, id string) (User, error) {
	key := "user:" + id

	// 1. Try the cache.
	data, err := rdb.Get(ctx, key).Bytes()
	switch {
	case err == nil:
		// HIT — decode and return.
		return decodeUser(data)
	case errors.Is(err, redis.Nil):
		// Clean MISS (key absent) — fall through to load-and-populate below.
	default:
		// Cache ERROR (timeout, connection reset). A cache is an optimisation,
		// not a dependency: log and fall through to the origin. Do NOT return err.
		logCacheError(key, err)
	}

	// 2. Load from the authoritative source.
	user, err := db.LoadUser(ctx, id)
	if err != nil {
		return User{}, err // origin failure IS a real error
	}

	// 3. Populate the cache with a TTL as a safety net (ch. 6). Best-effort:
	// a failure to cache must not fail the request that already has its data.
	if encoded, encErr := encodeUser(user); encErr == nil {
		// SET key val EX 300 — one atomic command sets value and expiry.
		if setErr := rdb.Set(ctx, key, encoded, 5*time.Minute).Err(); setErr != nil {
			logCacheError(key, setErr)
		}
	}
	return user, nil
}
```

### Connecting from Python with redis-py

```python
import redis

# One pool-backed client for the whole process. redis-py's Redis wraps a
# ConnectionPool; share this instance, don't create one per request.
pool = redis.ConnectionPool(
    host="localhost",
    port=6379,
    password=None,            # or your secret
    db=0,
    max_connections=50,       # cap the pool (sized to concurrency)
    socket_connect_timeout=2, # dial timeout (seconds)
    socket_timeout=0.2,       # read/write timeout — keep SHORT, like go-redis
    health_check_interval=30, # ping idle conns to catch dead ones
    decode_responses=False,   # keep bytes; decode yourself for cached blobs
)
rdb = redis.Redis(connection_pool=pool)
rdb.ping()  # fail fast at startup if unreachable


def get_user(rdb, db, user_id):
    """Cache-aside read, mirroring the Go version: hit / miss / error."""
    key = f"user:{user_id}"
    try:
        data = rdb.get(key)         # None on a clean miss
        if data is not None:
            return decode_user(data)  # HIT
    except redis.exceptions.RedisError as exc:
        log_cache_error(key, exc)   # ERROR -> fall through to origin

    user = db.load_user(user_id)    # authoritative source
    try:
        # SET with ex= sets value and TTL atomically (SET key val EX 300).
        rdb.set(key, encode_user(user), ex=300)  # best-effort populate
    except redis.exceptions.RedisError as exc:
        log_cache_error(key, exc)
    return user
```

### Connecting to a container

```go
// From the HOST machine, a published port looks like a local Redis:
rdb := redis.NewClient(&redis.Options{Addr: "localhost:6379"})

// From ANOTHER container on the same Docker network, use the SERVICE/CONTAINER
// name as the host — Docker's embedded DNS resolves it. In docker-compose:
//
//   services:
//     app:   { depends_on: [redis] }
//     redis: { image: redis:7-alpine }
//
// the app connects with Addr: "redis:6379" — NOT localhost, because inside the
// app container "localhost" is the app container itself, not the Redis one.
rdbInDocker := redis.NewClient(&redis.Options{Addr: "redis:6379"})
_ = rdbInDocker
```

The recurring theme across both languages: construct once, size the pool to concurrency, keep the read timeout short, and always have a fall-through to the origin so a cache problem degrades performance instead of causing an outage.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Trivial to start.** One command (brew/apt/docker) gets you a working server; the barrier to adopting a cache is essentially zero.
- **Uniform tooling.** `redis-cli` works identically against a local binary, a container, or a managed cloud instance, so debugging skills transfer everywhere.
- **Mature, pooled clients.** go-redis and redis-py handle pooling, retries, and RESP for you; you configure behaviour rather than implement a protocol.
- **Reproducible via Docker.** A pinned image (`redis:7-alpine`) gives every developer and CI run the identical Redis, eliminating "works on my machine" for the cache layer.

**Disadvantages**
- **Cache-hostile defaults.** Out of the box `maxmemory` is unlimited, the policy is `noeviction`, and RDB is on — none of which suits a pure cache until you change them.
- **Client misconfiguration is silent.** A too-small pool or missing timeouts causes no error until load arrives, at which point it causes an outage.
- **Container networking trips people up.** `localhost` from inside a container is that container, so cross-container connections need service-name DNS, a frequent first-day bug.

**Trade-offs**
- *Foreground `redis-server` vs a managed service:* running the binary directly is simplest for development; `brew services`/`systemd`/managed Redis add restart-on-failure and lifecycle management you want in production.
- *Small pool vs large pool:* too small and concurrent requests queue on `PoolTimeout`; too large and you waste memory and pressure the server's connection limit. Size to observed concurrency and grow on evidence.
- *Short read timeout vs fewer errors:* a short read timeout surfaces more transient errors but makes a slow cache fail fast to the origin; a long timeout hides blips but lets a stalled Redis stall your service. For a cache, short and fall-through wins.

## 7. Common Mistakes & Best Practices

- **Creating a client per request.** Defeats pooling, floods Redis with connections, and pays the TCP/AUTH handshake every call. **Best practice:** construct one shared client at startup and inject it.
- **No timeouts.** Without a read timeout, a single blocking command or network stall blocks your threads indefinitely and cascades into an outage. **Best practice:** always set dial/read/write timeouts; keep the read timeout in the low tens of milliseconds for a cache.
- **Leaving `maxmemory` at 0.** Redis grows until the OS OOM-kills it, taking the cache down hard. **Best practice:** set `maxmemory` and an eviction policy before any traffic (chapter 7).
- **Persistence on for a pure cache.** RDB `fork`s and AOF write amplification cost latency you do not need when the data is a disposable copy. **Best practice:** `save ""` and `appendonly no` for a cache.
- **Exposing Redis without auth.** An internet-reachable Redis with no password is routinely compromised within minutes. **Best practice:** bind to internal interfaces, set `requirepass`/ACLs, and firewall the port (chapter 29).
- **Using `localhost` between containers.** Inside a container, `localhost` is that container. **Best practice:** connect by service/container name on a shared Docker network.
- **Treating a cache error as a request error.** Returning a 500 because Redis hiccuped turns an optimisation into a dependency. **Best practice:** on a cache error, log and fall back to the origin.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** `redis-cli --stat` gives a live ops/sec and memory dashboard; `redis-cli --latency` measures round-trip latency to spot network or event-loop stalls; `CLIENT LIST` shows every connection and its idle time (useful for spotting pool leaks or a runaway client). `MONITOR` prints every command but is expensive — a debugging tool for a quiet instance, never left running in production.
- **Monitoring.** From the client side, watch `rdb.PoolStats()` (go-redis) — `Hits`, `Misses`, `Timeouts`, `TotalConns`, `IdleConns`; rising `Timeouts` means the pool is too small or Redis is slow. From the server side, `INFO clients` (`connected_clients`, `blocked_clients`), `INFO stats` (`instantaneous_ops_per_sec`, `rejected_connections`), and `INFO memory`. A climbing `connected_clients` with flat traffic is the signature of a per-request-client bug.
- **Security.** Never expose Redis on a public interface. Use `bind` to internal addresses, `requirepass` or ACL users (Redis 6+), TLS for connections crossing untrusted networks, and `rename-command` to disable `FLUSHALL`/`KEYS`/`CONFIG` where feasible (chapter 29). In the client, keep the password in a secret manager, not in code.
- **Scaling.** A single instance scales up to one core of command throughput and the machine's RAM. When you outgrow it, the *client* configuration changes little: go-redis offers `NewFailoverClient` for Sentinel-managed HA (chapter 25) and `NewClusterClient` for a sharded Cluster (chapter 26), both taking the same pool and timeout options. Designing your access with short, O(1) commands now means the move to Cluster later is mostly a client-constructor change.

## 9. Interview Questions

**Q: Why should a Redis client be constructed once and shared, rather than created per request?**
A: Because the client is a connection pool, not a single connection, and the whole point of pooling is to reuse expensive-to-establish connections across many commands. Connection setup involves a TCP handshake, optionally a TLS handshake, an `AUTH`, and a `SELECT` — all far more costly than the microseconds a command itself takes. A per-request client throws that reuse away: it pays the full setup on every call and, worse, floods the server with connections (each request opening its own), which pressures Redis's connection limit and can exhaust file descriptors on both ends. The go-redis `*redis.Client` and redis-py `Redis` are explicitly safe for concurrent use, so the correct pattern is to build one at startup and inject it everywhere.

**Q: How do you size a connection pool?**
A: To concurrency, not to request rate. What matters is how many requests are in flight at the same moment, each holding a connection for the duration of a command. By Little's Law, the average number of connections in use is the request rate multiplied by the per-command latency — so 100,000 requests/sec at 200 microseconds each needs only about 20 connections on average. go-redis defaults to `10 × GOMAXPROCS`, which scales with the CPUs doing concurrent work and is a sound starting point. You raise the pool size when you observe pool-wait timeouts (`PoolStats().Timeouts` climbing), and you avoid making it gratuitously large because idle connections cost memory on both client and server and pressure the server's connection limit.

**Q: What does the read timeout protect you from, and why should it be short for a cache?**
A: The read timeout bounds how long the client waits for a reply after sending a command. It protects you from a stalled Redis — a blocking command monopolising the single thread, or a network hiccup — turning into an unbounded stall in your application, where threads block indefinitely, the pool exhausts, requests queue, and a cache dependency becomes a full outage. Making it short is a design choice specific to caching: a cache exists to be faster than the origin, so a cache call that takes tens of milliseconds has already failed its purpose — you would have been better off going straight to the origin. A short read timeout makes a slow cache fail fast so you fall through to the origin rather than waiting.

**Q: Which `redis.conf` changes turn a default Redis into a cache?**
A: Four, essentially. Set `maxmemory` to a real limit so Redis never consumes the whole box and gets OOM-killed. Set `maxmemory-policy` to an eviction policy such as `allkeys-lru` so that when memory is full Redis makes room by evicting rather than failing writes (the default `noeviction` is a database behaviour). Disable RDB with `save ""` and AOF with `appendonly no`, because a pure cache's data is a disposable copy of the origin, so persistence buys durability you do not need at the cost of fork and disk latency. And, orthogonally but essentially, bind to internal interfaces and set `requirepass`/ACLs so the instance is not exposed.

**Q: You're connecting from one container to a Redis container and it fails with "connection refused" on localhost. Why?**
A: Because inside a container, `localhost` (127.0.0.1) refers to that container itself, not the host and not the Redis container. The app container has no Redis listening on its own loopback, so the connection is refused. The fix is to connect by the Redis container's service or container name on a shared Docker network — for example `redis:6379` in a docker-compose setup — because Docker's embedded DNS resolves the service name to the right container's address. `localhost:6379` only works from the host machine, where the published port maps back to the container.

**Q: What is cache-aside, and how does the client code make it correct?**
A: Cache-aside (lazy loading) is the default read pattern: the application tries the cache; on a hit it returns the cached value; on a miss it loads from the authoritative origin, populates the cache with a TTL, and returns the value. The client code makes it correct by distinguishing three outcomes rather than two. A hit returns the decoded value. A clean miss — go-redis's `redis.Nil`, redis-py's `None` — falls through to load and populate. Crucially, a cache *error* (a timeout or connection reset) is a third case that also falls through to the origin, logged but not fatal, because a cache is an optimisation and not a dependency. The populate step uses a TTL as a safety net and is best-effort, so a failure to write the cache never fails a request that already has its data.

**Q: What is `redis-cli MONITOR` for, and why must you be careful with it?**
A: `MONITOR` streams every command the server processes in real time, which makes it an excellent debugging tool for seeing exactly what a client is doing. The danger is its cost: because Redis is single-threaded and `MONITOR` must format and dispatch a line for every command to the monitoring connection, it adds significant overhead and can meaningfully reduce throughput on a busy instance. So it is a tool for a quiet or staging instance, or a brief targeted look, never something left running against a production server under load. `redis-cli --stat` and `SLOWLOG` are the safe production alternatives for ongoing observation.

**Q: (Senior) A service is intermittently returning errors under load, and you trace it to Redis. `connected_clients` is far higher than expected and `PoolStats().Timeouts` is climbing. Walk through the diagnosis.**
A: The two signals together point at pool exhaustion or a client-lifecycle bug, and I would separate the two causes. A `connected_clients` far above what the pool size should permit — say thousands when the pool is capped at fifty per instance across a handful of instances — is the signature of clients being constructed per request or per goroutine rather than shared: each new client opens its own pool, so connections multiply without bound. I would grep for `redis.NewClient`/`redis.Redis(` calls and confirm there is exactly one, built at startup and injected. If the client is correctly shared, then climbing `PoolStats().Timeouts` means requests are waiting past `PoolTimeout` for a free connection, which has two sub-causes: the pool is genuinely too small for the concurrency (fix by sizing to observed in-flight concurrency, guided by Little's Law), or connections are being *held too long* because Redis itself is slow — a blocking command on the single thread, so every checked-out connection stalls behind it. `SLOWLOG GET` and `INFO commandstats` distinguish these: if there is a slow command, the fix is to eliminate it (an accidental `KEYS`, a big `HGETALL`), not to enlarge the pool, because a bigger pool against a blocked server just means more connections all waiting. I would also check `rejected_connections` in `INFO stats` — if the server's `maxclients` is being hit, that confirms the connection flood. The resolution is almost always "share one client, size the pool to concurrency, and remove the blocking command", in that order of likelihood.

**Q: (Senior) How would you configure client retries and timeouts so that transient Redis failures don't amplify into a cascading outage?**
A: The goal is to fail fast and degrade gracefully rather than to hide failures with patience, because patience under load is how a blip becomes a cascade. I keep the read/write timeouts short — low tens of milliseconds for a cache — so a stalled Redis surfaces quickly instead of holding connections. Retries are bounded and backed off (go-redis's `MaxRetries` with `MinRetryBackoff`/`MaxRetryBackoff`), and I retry only idempotent operations and only transient errors (connection reset, dial failure), never a command that already blocked and timed out on the server, because retrying that just doubles the load on an already-struggling instance. Critically, retries are *not* the last line of defence — the cache-aside fall-through to the origin is. When retries are exhausted, the code treats it as a miss and goes to the origin, logging the error, so a Redis outage becomes elevated origin load rather than user-facing errors. To stop that elevated origin load from itself cascading, I pair the fall-through with a circuit breaker around the origin and request coalescing (singleflight) so a cold cache does not stampede the database (chapter 14). The whole design is layered: short timeouts to detect fast, bounded retries for genuine blips, fall-through to keep serving, and coalescing plus a breaker to protect the origin when the cache is down. `PoolTimeout` is set short for the same reason — waiting a long time for a connection during an incident just deepens the queue.

**Q: (Senior) Explain the trade-offs in running Redis via a foreground binary, a system service, and a container for local development versus production.**
A: Each optimises for a different concern. The foreground `redis-server` binary is the simplest for interactive development — you see the logs, Ctrl-C stops it, and there is no lifecycle machinery — but it does not restart on crash and does not survive a reboot, so it is a development-only choice. A system service (`brew services`, `systemd`) adds supervised lifecycle: restart-on-failure, start-on-boot, and log management, which is what you want for a long-running instance on a VM, though it ties you to the host's Redis version and config. A container gives reproducibility above all: a pinned image such as `redis:7-alpine` is byte-identical across every developer laptop and CI run, which eliminates version and config drift for the cache layer, and it composes cleanly with the rest of the stack via docker-compose. The container trade-off is the networking subtlety — service-name DNS between containers, published ports from the host — and a small overhead, plus the need to mount a volume if you (unusually for a cache) want persistence. In practice I use a pinned container for local development and CI so everyone shares the same Redis, and in production I use a managed Redis (ElastiCache, Memorystore, Redis Cloud) that gives me the supervised-service benefits plus HA and backups without my operating the process at all; the client configuration — pool, timeouts, and, for HA, a failover or cluster client — is what carries across all of these, which is why it is worth getting right first.

## 10. Quick Revision & Cheat Sheet

| Task | Command / setting |
|---|---|
| Install (mac / linux / docker) | `brew install redis` / `apt install redis-server` / `docker run -p 6379:6379 redis` |
| Connect interactively | `redis-cli -h HOST -p PORT -a PASS -n DB` |
| Safe key scan | `redis-cli --scan --pattern 'user:*'` (never `KEYS`) |
| Live dashboard | `redis-cli --stat` |
| Slowest commands | `redis-cli SLOWLOG GET 10` |
| Cap memory (cache) | `maxmemory 2gb` + `maxmemory-policy allkeys-lru` |
| Disable persistence (cache) | `save ""` + `appendonly no` |
| Fail fast at startup | `rdb.Ping(ctx)` after construction |

| go-redis Option | Purpose |
|---|---|
| `PoolSize` | max connections; size to concurrency (default `10×GOMAXPROCS`) |
| `ReadTimeout` | bound on awaiting a reply; keep SHORT for a cache |
| `DialTimeout` | bound on opening a connection |
| `PoolTimeout` | how long to wait for a free connection before erroring |
| `MaxRetries` | bounded, backed-off retries for transient errors |

**Flash cards**
- **Construct the client…** → once, at startup, shared — it is a pool, not a connection.
- **Size the pool to…** → concurrency (rate × latency), not request rate.
- **The load-bearing timeout is…** → read timeout; short, so a slow cache fails fast to the origin.
- **Three lines that make a cache…** → `maxmemory`, `maxmemory-policy`, `save ""`.
- **`localhost` between containers…** → is the container itself; use the service name.
- **On a cache error…** → log and fall through to the origin; never fail the request.

## 11. Hands-On Exercises & Mini Project

- [ ] Install Redis three ways (brew/apt, and a pinned Docker image) and confirm each with `redis-cli PING`.
- [ ] Use `redis-cli` to `SET` a key with `EX`, watch `TTL` count down, and observe the key vanish; inspect it with `TYPE` and `OBJECT ENCODING`.
- [ ] Write a `redis.conf` that caps memory, sets `allkeys-lru`, and disables persistence; start Redis with it and confirm via `CONFIG GET maxmemory-policy`.
- [ ] Build a go-redis client with explicit pool and timeout options, `Ping` at startup, and print `PoolStats()` under a concurrent load test.
- [ ] Reproduce the container `localhost` bug: run app and Redis in separate containers, fail with `localhost:6379`, then fix it with the service name.
- [ ] Implement cache-aside `GetUser` in both go-redis and redis-py, and verify the three paths (hit, miss, injected cache error) all behave correctly.

### Mini Project — "Cache-Aside Starter Kit"

**Goal.** Produce a small, reusable service skeleton with a correctly-configured Redis client and a cache-aside read path, so future features start from a good baseline instead of a naive one.

**Requirements.**
1. A docker-compose stack with an app container and a pinned `redis:7-alpine`, the app connecting by service name with auth enabled.
2. A single shared go-redis client constructed at startup with explicit `PoolSize`, `ReadTimeout`, `DialTimeout`, and `PoolTimeout`, plus a startup `Ping` that aborts boot if Redis is unreachable.
3. A `redis.conf` mounted into the Redis container that sets `maxmemory`, `allkeys-lru`, and disables persistence.
4. A cache-aside `Get` that distinguishes hit, clean miss, and cache error, falling through to a stub origin on both miss and error, and populating with a TTL.
5. A `/healthz` endpoint that reports `PoolStats()` and the result of a `PING`, so pool exhaustion is observable.

**Extensions.**
- Add a load test that drives enough concurrency to trigger `PoolStats().Timeouts`, then tune `PoolSize` and show the timeouts disappear.
- Port the same cache-aside path to redis-py and confirm identical hit/miss/error behaviour, sharing one Redis instance between both apps.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Redis as a Cache* (the single-threaded architecture these clients talk to), *Redis Data Types & Which to Cache With* (what your cached values should be), *Keys, TTL & Expiration Semantics* (the TTL every cache-aside populate needs), *Memory, maxmemory & Eviction Policies* (the config that makes it a cache), *Cache-Aside, Read-Through & Write Patterns* (the pattern from §5 in depth), *Connection Pooling & Client-Side Caching* (the pool from §3 taken further).

- **Redis — Getting started & installation** — Redis · *Beginner* · the official install paths for every platform and the first-commands walkthrough, the canonical companion to §5. <https://redis.io/docs/latest/operate/oss_and_stack/install/>
- **Redis — redis-cli reference** — Redis · *Beginner* · every flag and interactive feature of the CLI you will use daily, including `--scan`, `--stat`, and `--latency`. <https://redis.io/docs/latest/develop/tools/cli/>
- **go-redis — official documentation** — Redis / go-redis · *Intermediate* · the maintained Go client's docs, covering `Options`, pooling, retries, and Cluster/Sentinel constructors. <https://redis.io/docs/latest/develop/clients/go/>
- **redis-py — official documentation** — Redis / redis-py · *Intermediate* · the reference Python client, connection pools, and the `Redis`/`ConnectionPool` API used in §5. <https://redis.io/docs/latest/develop/clients/redis-py/>
- **Redis — Configuration & the self-documented redis.conf** — Redis · *Intermediate* · the annotated default config that explains every directive, including the cache-relevant `maxmemory`/`save`/`bind` lines. <https://redis.io/docs/latest/operate/oss_and_stack/management/config/>
- **Docker Official Image — redis** — Docker · *Beginner* · how to run, configure, and mount config into the Redis image, and the networking notes behind the container section. <https://hub.docker.com/_/redis>
- **Redis University — RU101: Introduction to Redis Data Structures** — Redis · *Beginner* · a free hands-on course that grounds installation and the CLI in real exercises. <https://university.redis.com/>
- **Redis — Connection pools & client-side best practices** — Redis · *Advanced* · guidance on pool sizing, timeouts, and reuse that underpins the §3 principles. <https://redis.io/docs/latest/develop/clients/pools-and-muxing/>

---

*Caching with Redis Handbook — chapter 05.*
