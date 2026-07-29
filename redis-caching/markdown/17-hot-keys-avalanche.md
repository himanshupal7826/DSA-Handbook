# 17 · Hot Keys, Cache Avalanche & Sharding the Hot Key

> **In one line:** Two different concentrations of load look like the same incident but need opposite fixes — when *many* keys expire at the same instant you spread them out in *time* (TTL jitter), and when *one* key attracts all the traffic you spread it out in *space* (replicate the value across shards), because a hot key lives on a single Redis slot that sharding the keyspace can never divide.

---

## 1. Overview

A cache turns a distributed read problem into a concentration problem, and concentration has two axes: time and space. **Cache avalanche** is concentration in *time* — a large set of keys all expire at (or near) the same instant, so a mass of simultaneous misses hits the origin in one wave. It usually happens by accident: you warmed ten thousand cache entries in a tight loop at deploy time, all with the same 1-hour TTL, so an hour later they all expire together and the database faces ten thousand misses in the same second. It is essentially many stampedes firing at once, and the fix is to *decorrelate the expiry times* with **TTL jitter**.

**Hot key** is concentration in *space* — a single key attracts so much traffic that the one Redis node holding it saturates, no matter how healthy the rest of the cluster is. A celebrity's profile, a flash-sale product, a global feature flag read on every request: the key itself is fine, but its request rate exceeds what one node's single thread and one network interface can serve. The cruel twist is that Redis Cluster's whole scaling model — shard the keyspace across nodes by hashing the key name — *cannot help*, because a single key hashes to a single slot on a single node. You cannot spread one key by sharding the keyspace; you can only spread it by **replicating the value** across several keys (`key:0`, `key:1`, …, `key:N-1`) that hash to different slots, then having each reader pick one at random.

These two failures are grouped in one chapter because they are the load-*concentration* problems (penetration and stampede in chapters 15–16 are the load-*bypass* problems), and because their fixes are instructively opposite: avalanche is fixed by adding *randomness to time* (jitter), hot keys by adding *randomness to space* (replica selection), with **local/near caching** and **request coalescing** as shared supporting tactics. This chapter covers the mechanisms, the fixes with real Go, the specific interaction with Redis Cluster's slot model, and how to *detect* a hot key before it takes a node down.

## 2. Core Concepts

- **Cache avalanche** — many keys expiring simultaneously, causing a mass miss storm against the origin in one wave.
- **Synchronised expiry** — the root cause of avalanche: keys populated together with an identical TTL expire together.
- **TTL jitter** — adding a random spread to each key's TTL so expiries decorrelate across time.
- **Hot key** — a single key whose request rate saturates the one node/shard that holds it.
- **Hotspot / single-slot concentration** — in Redis Cluster, a key maps to one of 16384 slots on one node; a hot key concentrates all its load there.
- **Key replication / value replication** — copying one logical value into N physical keys (`key:0..key:N-1`) that land on different slots, spreading read load.
- **Local cache / near cache** — an in-process cache in front of Redis, so the hottest reads never leave the application node.
- **Request coalescing** — collapsing concurrent reads of the same key into one upstream fetch (singleflight; chapter 15).
- **CRC16 slot mapping** — `CRC16(key) mod 16384` decides a key's slot; hash tags `{...}` force keys onto the same slot.
- **LFU / `--hotkeys`** — detection tools: an LFU eviction policy tracks access frequency; `redis-cli --hotkeys` samples the busiest keys.

## 3. Theory & Principles

### Avalanche: correlation in time, fixed by jitter

Avalanche is the many-key sibling of the stampede. A stampede is one hot key expiring under concurrency; an avalanche is *many* keys expiring in the same instant, each triggering its own miss, so the origin sees the sum of all of them at once. The root cause is almost always **synchronised population**: a cache-warming job, a deploy, or a burst of traffic populates a large batch of keys within a short window, all with the *same* fixed TTL. Fixed TTL plus simultaneous write equals simultaneous expiry, and the origin that comfortably serves a trickle of staggered misses is overwhelmed by the whole batch arriving together.

The fix is to break the correlation by **jittering the TTL**: instead of writing every key with exactly `T`, write it with `T ± random(0, J)`. A batch written at the same instant now expires spread across a `J`-wide window, so the misses arrive as a manageable stream rather than a wall. The jitter magnitude is a trade: too little and expiries still cluster; too much and some keys live far longer than intended. A common rule is `±10%` to `±25%` of the base TTL, or an absolute spread sized to how long the origin needs to absorb the batch. Jitter is cheap, has no correctness cost (the value is the same, only its lifetime shifts slightly), and should be the *default* on every cache write — it is one of those defences with essentially no downside.

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="j1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
    <marker id="j2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Cache avalanche: fixed TTL synchronises expiry; jitter spreads it out</text>

  <rect x="24" y="40" width="410" height="330" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="229" y="62" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">FIXED TTL (T = 60 min for all)</text>
  <text x="229" y="80" text-anchor="middle" fill="#991b1b" font-size="9">10k keys warmed at deploy, all same TTL</text>

  <g font-size="8" fill="#991b1b">
    <rect x="44" y="96" width="150" height="16" rx="3" fill="#fee2e2" stroke="#dc2626"/><text x="48" y="108">key1  write@0 &#8594; expire@60</text>
    <rect x="44" y="116" width="150" height="16" rx="3" fill="#fee2e2" stroke="#dc2626"/><text x="48" y="128">key2  write@0 &#8594; expire@60</text>
    <rect x="44" y="136" width="150" height="16" rx="3" fill="#fee2e2" stroke="#dc2626"/><text x="48" y="148">key3  write@0 &#8594; expire@60</text>
    <rect x="44" y="156" width="150" height="16" rx="3" fill="#fee2e2" stroke="#dc2626"/><text x="48" y="168">...   write@0 &#8594; expire@60</text>
  </g>

  <line x1="230" y1="96" x2="230" y2="200" stroke="#dc2626" stroke-width="3"/>
  <text x="238" y="120" fill="#b91c1c" font-size="9">all expire</text>
  <text x="238" y="134" fill="#b91c1c" font-size="9">at t=60min</text>

  <path d="M230,200 L280,230" stroke="#dc2626" stroke-width="2" marker-end="url(#j1)"/>
  <rect x="60" y="228" width="340" height="130" rx="8" fill="#fecaca" stroke="#dc2626" stroke-width="2"/>
  <text x="230" y="252" text-anchor="middle" fill="#7f1d1d" font-size="11" font-weight="bold">MISS STORM at t=60</text>
  <text x="76" y="276" fill="#991b1b" font-size="9">10k simultaneous misses in one second</text>
  <text x="76" y="296" fill="#991b1b" font-size="9">&#8594; origin sees the WHOLE batch at once</text>
  <text x="76" y="320" fill="#991b1b" font-size="9">&#8594; DB overload, latency spike, cascade</text>
  <text x="76" y="342" fill="#7f1d1d" font-size="9" font-weight="bold">= many stampedes firing together</text>

  <rect x="446" y="40" width="410" height="330" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="651" y="62" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">JITTERED TTL (T = 60 &#177; 6 min)</text>
  <text x="651" y="80" text-anchor="middle" fill="#166534" font-size="9">same batch, each TTL randomised by &#177;10%</text>

  <g font-size="8" fill="#166534">
    <rect x="466" y="96" width="150" height="16" rx="3" fill="#dcfce7" stroke="#16a34a"/><text x="470" y="108">key1  &#8594; expire@57.2</text>
    <rect x="466" y="116" width="150" height="16" rx="3" fill="#dcfce7" stroke="#16a34a"/><text x="470" y="128">key2  &#8594; expire@63.8</text>
    <rect x="466" y="136" width="150" height="16" rx="3" fill="#dcfce7" stroke="#16a34a"/><text x="470" y="148">key3  &#8594; expire@58.9</text>
    <rect x="466" y="156" width="150" height="16" rx="3" fill="#dcfce7" stroke="#16a34a"/><text x="470" y="168">...   &#8594; expire@61.4</text>
  </g>

  <path d="M628,104 L700,220" stroke="#16a34a" stroke-width="1" stroke-dasharray="3,3"/>
  <path d="M628,124 L730,220" stroke="#16a34a" stroke-width="1" stroke-dasharray="3,3"/>
  <path d="M628,144 L680,220" stroke="#16a34a" stroke-width="1" stroke-dasharray="3,3"/>
  <path d="M628,164 L720,220" stroke="#16a34a" stroke-width="1" stroke-dasharray="3,3"/>

  <rect x="482" y="228" width="340" height="130" rx="8" fill="#bbf7d0" stroke="#16a34a" stroke-width="2"/>
  <text x="652" y="252" text-anchor="middle" fill="#14532d" font-size="11" font-weight="bold">STEADY TRICKLE over 54&#8211;66 min</text>
  <text x="498" y="276" fill="#166534" font-size="9">misses spread across a 12-min window</text>
  <text x="498" y="296" fill="#166534" font-size="9">&#8594; origin sees a manageable stream</text>
  <text x="498" y="320" fill="#166534" font-size="9">&#8594; no wall of load, no cascade</text>
  <text x="498" y="342" fill="#14532d" font-size="9" font-weight="bold">jitter is cheap and has no correctness cost</text>
</svg>
```

### Hot key: concentration in space, and why sharding can't fix it

A hot key is a fundamentally different problem, and the reason it is hard is worth stating precisely. Redis Cluster scales the keyspace by hashing each key name to one of **16384 hash slots** (`CRC16(key) mod 16384`) and assigning slots to nodes. This spreads *many keys* evenly across nodes beautifully. But a *single* key name hashes to a *single* slot on a *single* node — so all the traffic for one hot key lands on one node's one execution thread and one network card, and adding more nodes to the cluster does nothing, because the key still lives on exactly one of them. You have hit the ceiling of a single Redis instance for that one key, and the keyspace-sharding model that scales everything else is powerless here.

Because you cannot move one key to many nodes, you must turn one *logical* key into many *physical* keys. **Value replication**: write the same value to `celebrity:42:0`, `celebrity:42:1`, …, `celebrity:42:N-1`, which (having different names) hash to different slots on different nodes, and have each reader pick a *random* replica to read. Now the read load is spread across `N` nodes, and you have bought back horizontal scaling for that key at the cost of writing `N` copies and keeping them consistent. The two supporting tactics apply here too: a **local/near cache** in the application process means the hottest reads never even reach Redis (the ultimate load-spreader, since the load is now distributed across every app instance's memory), and **request coalescing** (singleflight, chapter 15) collapses concurrent reads within each process. In practice a hot key is defended in depth: local cache first, replicated keys behind it, coalescing throughout.

### The interaction: hash tags and deliberate co-location

Redis Cluster's hash tags `{...}` let you *force* keys onto the same slot — `user:{42}:profile` and `user:{42}:settings` both hash on `42` and co-locate, which is how you make multi-key operations work in a cluster. For hot keys this is the tension you must manage in *both* directions: hash tags are what you use to co-locate related keys for atomic operations, but they are exactly what you must *avoid* for hot-key replicas, since replicas must land on *different* slots to spread load. So `celebrity:42:{0}` … `celebrity:42:{N}` would be wrong (the numbers are inside the tag and vary, so that is fine, but a shared tag would defeat the purpose) — the replica suffix must be *outside* any hash tag so the replicas genuinely distribute. Getting this right is the difference between replication that spreads load and replication that piles N copies onto the same overloaded node.

## 4. Architecture & Workflow

The defended read path for load concentration:

1. **Every write jitters its TTL.** The unconditional baseline: `SET key value EX (T ± random)`. This makes avalanche structurally impossible for normally-populated keys, and costs nothing.
2. **Detect hot keys continuously.** Sample access frequency (`redis-cli --hotkeys` with an LFU policy, or client-side instrumentation) so you know *which* keys are hot before they cause an incident, rather than discovering them during one.
3. **Front the hottest keys with a local (near) cache.** An in-process cache with a very short TTL (seconds) absorbs the bulk of reads for a known hot key without a Redis round trip. Because each application instance has its own local cache, this distributes the load across the whole fleet's memory — the most effective single fix.
4. **Replicate the value across shards for the very hottest keys.** For a key so hot that even Redis round trips saturate its node, write `N` replicas with names that hash to different slots, and read a *random* one. This spreads the Redis-level read load across `N` nodes.
5. **Coalesce concurrent reads.** Within each process, singleflight collapses a burst of concurrent reads of the same key (local or Redis) into one upstream fetch, so a hot key's concurrency does not multiply upstream load.
6. **On write/invalidate, update all replicas.** The cost of replication: a write must update (or delete) all `N` physical keys, and a reader must tolerate brief inconsistency between replicas during that window.

The ordering matters: local cache is tried first (cheapest, spreads load furthest), replicas next (spreads Redis load), coalescing throughout (bounds concurrency), and jitter is on every write unconditionally. Avalanche is handled purely by step 1; the hot-key steps (3–6) are applied selectively to the keys detection (step 2) flags.

```svg
<svg viewBox="0 0 880 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="h1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Hot key: one slot can't be sharded &#8212; replicate the VALUE across nodes</text>

  <rect x="24" y="42" width="380" height="176" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="214" y="64" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">PROBLEM: one hot key, one slot</text>
  <text x="214" y="82" text-anchor="middle" fill="#991b1b" font-size="9">CRC16("celeb:42") mod 16384 &#8594; slot on ONE node</text>

  <g font-size="9">
    <rect x="44" y="96" width="70" height="18" rx="3" fill="#fee2e2" stroke="#dc2626"/><text x="79" y="109" text-anchor="middle" fill="#b91c1c">reader</text>
    <rect x="44" y="118" width="70" height="18" rx="3" fill="#fee2e2" stroke="#dc2626"/><text x="79" y="131" text-anchor="middle" fill="#b91c1c">reader</text>
    <rect x="44" y="140" width="70" height="18" rx="3" fill="#fee2e2" stroke="#dc2626"/><text x="79" y="153" text-anchor="middle" fill="#b91c1c">reader &#215;1000s</text>
  </g>
  <path d="M114,105 L176,150" stroke="#dc2626" stroke-width="1.5" marker-end="url(#h1)"/>
  <path d="M114,127 L176,155" stroke="#dc2626" stroke-width="1.5" marker-end="url(#h1)"/>
  <path d="M114,149 L176,160" stroke="#dc2626" stroke-width="1.5" marker-end="url(#h1)"/>
  <rect x="180" y="132" width="200" height="66" rx="8" fill="#fecaca" stroke="#dc2626" stroke-width="2"/>
  <text x="280" y="156" text-anchor="middle" fill="#7f1d1d" font-size="10" font-weight="bold">NODE A (saturated)</text>
  <text x="280" y="176" text-anchor="middle" fill="#991b1b" font-size="9">one thread, one NIC</text>
  <text x="280" y="190" text-anchor="middle" fill="#991b1b" font-size="9">adding nodes does NOTHING</text>

  <rect x="424" y="42" width="432" height="176" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="640" y="64" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">FIX: replicate value to N keys on N slots</text>
  <text x="640" y="82" text-anchor="middle" fill="#166534" font-size="9">celeb:42:0 .. celeb:42:N-1 &#8594; different slots; read a RANDOM one</text>

  <g font-size="9">
    <rect x="444" y="96" width="90" height="18" rx="3" fill="#dcfce7" stroke="#16a34a"/><text x="489" y="109" text-anchor="middle" fill="#166534">reader &#8594; rand(0..N)</text>
  </g>
  <path d="M534,105 L600,120" stroke="#16a34a" stroke-width="1.5" marker-end="url(#h1)"/>
  <path d="M534,105 L600,155" stroke="#16a34a" stroke-width="1.5" marker-end="url(#h1)"/>
  <path d="M534,105 L600,190" stroke="#16a34a" stroke-width="1.5" marker-end="url(#h1)"/>
  <rect x="604" y="108" width="230" height="24" rx="4" fill="#bbf7d0" stroke="#16a34a"/><text x="719" y="124" text-anchor="middle" fill="#14532d" font-size="9">Node A: celeb:42:0</text>
  <rect x="604" y="143" width="230" height="24" rx="4" fill="#bbf7d0" stroke="#16a34a"/><text x="719" y="159" text-anchor="middle" fill="#14532d" font-size="9">Node B: celeb:42:1</text>
  <rect x="604" y="178" width="230" height="24" rx="4" fill="#bbf7d0" stroke="#16a34a"/><text x="719" y="194" text-anchor="middle" fill="#14532d" font-size="9">Node C: celeb:42:2 ...</text>

  <rect x="24" y="232" width="832" height="182" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="254" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Defence in depth for a hot key (cheapest / widest-spreading first)</text>
  <rect x="44" y="268" width="196" height="130" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="142" y="290" text-anchor="middle" fill="#1e40af" font-size="10" font-weight="bold">1. LOCAL / NEAR CACHE</text>
  <text x="58" y="312" fill="#1d4ed8" font-size="9">in-process, seconds TTL</text>
  <text x="58" y="330" fill="#1d4ed8" font-size="9">reads never leave the app</text>
  <text x="58" y="348" fill="#1d4ed8" font-size="9">load spread across whole</text>
  <text x="58" y="366" fill="#1d4ed8" font-size="9">fleet's memory &#8212; best fix</text>
  <text x="58" y="386" fill="#1e40af" font-size="9" font-weight="bold">try FIRST</text>

  <rect x="252" y="268" width="196" height="130" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="350" y="290" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">2. VALUE REPLICATION</text>
  <text x="266" y="312" fill="#166534" font-size="9">N keys on N slots</text>
  <text x="266" y="330" fill="#166534" font-size="9">read a random replica</text>
  <text x="266" y="348" fill="#166534" font-size="9">spreads Redis-level load</text>
  <text x="266" y="366" fill="#166534" font-size="9">cost: write/invalidate all N</text>
  <text x="266" y="386" fill="#15803d" font-size="9" font-weight="bold">for the very hottest</text>

  <rect x="460" y="268" width="196" height="130" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="558" y="290" text-anchor="middle" fill="#5b21b6" font-size="10" font-weight="bold">3. REQUEST COALESCING</text>
  <text x="474" y="312" fill="#6d28d9" font-size="9">singleflight per process</text>
  <text x="474" y="330" fill="#6d28d9" font-size="9">concurrent reads &#8594; 1 fetch</text>
  <text x="474" y="348" fill="#6d28d9" font-size="9">bounds upstream concurrency</text>
  <text x="474" y="366" fill="#6d28d9" font-size="9">(chapter 15)</text>
  <text x="474" y="386" fill="#5b21b6" font-size="9" font-weight="bold">throughout</text>

  <rect x="668" y="268" width="168" height="130" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="752" y="290" text-anchor="middle" fill="#92400e" font-size="10" font-weight="bold">0. TTL JITTER</text>
  <text x="682" y="312" fill="#b45309" font-size="9">on EVERY write</text>
  <text x="682" y="330" fill="#b45309" font-size="9">handles avalanche</text>
  <text x="682" y="348" fill="#b45309" font-size="9">unconditional baseline</text>
  <text x="682" y="366" fill="#b45309" font-size="9">no correctness cost</text>
  <text x="682" y="386" fill="#92400e" font-size="9" font-weight="bold">always on</text>
</svg>
```

## 5. Implementation

Go with `github.com/redis/go-redis/v9`: a jittered-TTL populate (avalanche), then hot-key value replication with random-replica reads, plus a small local-cache front. Comments explain *why*.

```go
package hotkeys

import (
	"context"
	"fmt"
	"math/rand"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// ---------------------------------------------------------------------------
// 1. AVALANCHE FIX: jittered-TTL populate. When warming a batch of keys at
//    once, a FIXED TTL makes them all expire together (avalanche). Jitter
//    decorrelates the expiries so misses arrive as a trickle, not a wall.
// ---------------------------------------------------------------------------

// jitteredTTL returns base +/- pct of base, so keys written together do not
// share an expiry instant. pct of 0.1 means +/-10%.
func jitteredTTL(base time.Duration, pct float64) time.Duration {
	delta := (rand.Float64()*2 - 1) * pct * float64(base) // uniform in [-pct, +pct]
	return base + time.Duration(delta)
}

// WarmBatch populates many keys at once — the classic avalanche setup — but
// gives each a jittered TTL. Without the jitter, an hour after this runs the
// whole batch would expire in the same second and stampede the origin.
func WarmBatch(ctx context.Context, rdb *redis.Client, entries map[string]string, base time.Duration) error {
	// Use a pipeline so warming thousands of keys is a few round trips, not
	// thousands — but each key still gets its OWN jittered TTL.
	pipe := rdb.Pipeline()
	for k, v := range entries {
		pipe.Set(ctx, k, v, jitteredTTL(base, 0.15)) // +/-15% spread
	}
	_, err := pipe.Exec(ctx)
	return err
}

// ---------------------------------------------------------------------------
// 2. HOT-KEY FIX: value replication across shards. One logical key becomes N
//    physical keys whose DIFFERENT names hash to DIFFERENT slots/nodes. Readers
//    pick a random replica, so read load spreads across N nodes instead of
//    saturating the one node the single key would live on.
// ---------------------------------------------------------------------------

type HotKeyCache struct {
	rdb      *redis.Client
	replicas int           // N: how many physical copies to spread across
	ttl      time.Duration
}

func NewHotKeyCache(rdb *redis.Client, replicas int, ttl time.Duration) *HotKeyCache {
	return &HotKeyCache{rdb: rdb, replicas: replicas, ttl: ttl}
}

// replicaKey builds the Nth physical key. CRITICAL: the replica suffix is
// OUTSIDE any hash tag, so the N names hash to DIFFERENT slots and genuinely
// distribute across nodes. If we wrote "celeb:{42}:0".."celeb:{42}:N" the hash
// tag {42} would force ALL replicas onto the SAME slot, defeating the purpose.
func (h *HotKeyCache) replicaKey(logicalKey string, i int) string {
	return fmt.Sprintf("%s:rep:%d", logicalKey, i)
}

// SetReplicated writes the value to ALL N replicas. This is the cost of hot-key
// replication: every write fans out to N keys. Worth it only for a genuinely
// hot key where read load dwarfs write load.
func (h *HotKeyCache) SetReplicated(ctx context.Context, logicalKey, value string) error {
	pipe := h.rdb.Pipeline()
	for i := 0; i < h.replicas; i++ {
		// Jitter each replica's TTL too, so the replicas do not all expire at the
		// same instant (which would briefly collapse all reads onto the origin).
		pipe.Set(ctx, h.replicaKey(logicalKey, i), value, jitteredTTL(h.ttl, 0.1))
	}
	_, err := pipe.Exec(ctx)
	return err
}

// GetReplicated reads ONE random replica. Random selection is what spreads the
// load: over many readers, the requests distribute roughly evenly across the N
// nodes holding the replicas.
func (h *HotKeyCache) GetReplicated(ctx context.Context, logicalKey string) (string, error) {
	i := rand.Intn(h.replicas) // pick a random replica → a random node
	v, err := h.rdb.Get(ctx, h.replicaKey(logicalKey, i)).Result()
	if err == redis.Nil {
		// This replica expired but others may be live — try another before
		// declaring a miss, so one expired replica doesn't cause a spurious miss.
		for j := 0; j < h.replicas; j++ {
			if j == i {
				continue
			}
			if v, err := h.rdb.Get(ctx, h.replicaKey(logicalKey, j)).Result(); err == nil {
				return v, nil
			}
		}
		return "", redis.Nil // genuine miss: caller recomputes and SetReplicated
	}
	return v, err
}

// InvalidateReplicated must remove ALL replicas — the flip side of fan-out on
// write. Missing one leaves a stale copy that a random reader might hit.
func (h *HotKeyCache) InvalidateReplicated(ctx context.Context, logicalKey string) error {
	keys := make([]string, h.replicas)
	for i := 0; i < h.replicas; i++ {
		keys[i] = h.replicaKey(logicalKey, i)
	}
	return h.rdb.Del(ctx, keys...).Err()
}

// ---------------------------------------------------------------------------
// 3. LOCAL / NEAR CACHE: the widest-spreading fix. An in-process cache with a
//    SHORT TTL absorbs the hottest reads without any Redis round trip. Each app
//    instance has its own, so load spreads across the whole fleet's memory.
//    Trade: brief staleness bounded by the local TTL.
// ---------------------------------------------------------------------------

type localEntry struct {
	value   string
	expires time.Time
}

type NearCache struct {
	mu       sync.RWMutex
	entries  map[string]localEntry
	backing  *HotKeyCache
	localTTL time.Duration // seconds: short, so staleness is bounded
}

func NewNearCache(backing *HotKeyCache, localTTL time.Duration) *NearCache {
	return &NearCache{entries: make(map[string]localEntry), backing: backing, localTTL: localTTL}
}

// Get serves from the local cache if fresh, else from the replicated Redis
// cache, repopulating the local copy. The local hit path never touches Redis at
// all — this is what makes a hot key survivable at any read rate.
func (n *NearCache) Get(ctx context.Context, logicalKey string) (string, error) {
	n.mu.RLock()
	e, ok := n.entries[logicalKey]
	n.mu.RUnlock()
	if ok && time.Now().Before(e.expires) {
		return e.value, nil // local hit: zero Redis load
	}

	// Local miss/stale: fetch from the replicated Redis cache (which itself
	// spreads across N nodes), then cache locally for a few seconds.
	v, err := n.backing.GetReplicated(ctx, logicalKey)
	if err != nil {
		return "", err
	}
	n.mu.Lock()
	n.entries[logicalKey] = localEntry{value: v, expires: time.Now().Add(n.localTTL)}
	n.mu.Unlock()
	return v, nil
}
```

The layering is the point: `WarmBatch` jitters so avalanche cannot happen; `NearCache` absorbs the hottest reads in-process (spreading load across the fleet); `HotKeyCache` spreads whatever reaches Redis across N nodes; and the replica-suffix-outside-the-hash-tag detail is what makes that spreading real rather than illusory.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **TTL jitter is free insurance.** One line on every write makes avalanche structurally impossible for normally-populated keys, with no correctness cost.
- **Local caching spreads load furthest.** Serving a hot key from each app instance's memory removes the Redis round trip entirely and distributes load across the whole fleet.
- **Value replication buys back scaling.** It restores horizontal scaling for a single key that Redis Cluster's keyspace sharding cannot help.
- **The tactics compose.** Jitter + local cache + replication + coalescing defend a hot key in depth, each covering a different layer.

**Disadvantages**
- **Replication multiplies writes and consistency work.** N copies means N writes per update and a window of inconsistency between replicas.
- **Local caches add staleness and are per-instance.** Each instance can hold a slightly different value, and invalidation is hard (you cannot easily reach into every instance's memory).
- **Detection is non-trivial.** A hot key can appear suddenly (a viral post) and `--hotkeys` sampling or LFU tracking may lag the onset.
- **Over-jitter distorts intent.** Too much TTL spread means some keys live far longer or shorter than the intended cache lifetime.

**Trade-offs**
- *Jitter magnitude:* more spread better decorrelates expiries but weakens the TTL's meaning; `±10–25%` is the usual sweet spot, sized to how long the origin needs to absorb the batch.
- *Local cache vs freshness:* a longer local TTL spreads more load but serves staler data and makes invalidation slower; a shorter one is fresher but does less spreading. Seconds is the usual range for a hot key.
- *Replication factor N:* larger N spreads read load across more nodes but multiplies write cost and consistency surface; size N to the ratio of read rate over single-node capacity, not larger.
- *Replication vs local cache:* local caching is cheaper and spreads further but is per-instance and staler; replication is consistent-per-copy and shared but costs write fan-out. Prefer local caching first, add replication only when the key is hot enough that even Redis round trips saturate its node.

## 7. Common Mistakes & Best Practices

- **Fixed TTL on a warmed batch.** The classic avalanche cause: populate ten thousand keys with the same TTL and they expire together. **Best practice:** jitter every TTL, unconditionally, as a default.
- **Assuming Cluster spreads a hot key.** Adding nodes does nothing for one key that hashes to one slot. **Best practice:** replicate the *value* across N differently-named keys, not the cluster.
- **Replica keys sharing a hash tag.** Putting the varying part inside `{...}` forces all replicas onto one slot, so they pile onto the same node — the opposite of the goal. **Best practice:** keep the replica suffix *outside* any hash tag so replicas distribute.
- **Forgetting to invalidate all replicas.** Deleting one replica leaves stale copies a random reader can hit. **Best practice:** fan out every write and invalidation to all N replicas.
- **Replicas with synchronised TTLs.** If all N replicas expire together, reads briefly collapse onto the origin — a mini avalanche of the hot key. **Best practice:** jitter each replica's TTL independently.
- **Discovering hot keys during the incident.** No detection means the first sign is a saturated node. **Best practice:** run `--hotkeys`/LFU sampling and client-side instrumentation continuously so you see a key heating up early.
- **Unbounded local caches.** A local cache with no size limit or TTL leaks memory and serves stale data indefinitely. **Best practice:** bound it by size and a short TTL, and accept the staleness as the price of load-spreading.
- **Best practice overall: jitter always, cache locally first, replicate the hottest, coalesce throughout.** Handle avalanche by decorrelating time and hot keys by decorrelating space, and detect before you defend.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Detection & debugging.** `redis-cli --hotkeys` samples the keyspace for the most-accessed keys (it needs an LFU `maxmemory-policy` so Redis tracks access frequency). `redis-cli --bigkeys` finds large keys that often correlate with hotspots. Per-node metrics are the tell for a hot key: one node's CPU, ops/sec, and network egress spike while its peers stay flat — a very different signature from avalanche, which shows a synchronised miss spike across the *origin* aligned to a TTL boundary. `MONITOR` (briefly, never in sustained production — it is itself expensive) or client-side per-key counters pin down the exact key.
- **Monitoring.** For avalanche: alert on origin miss-rate spikes that align to TTL boundaries, and track the *distribution* of your keys' remaining TTLs — a tall spike in the histogram means a synchronised batch that will avalanche. For hot keys: alert on per-node load *imbalance* (one node's ops/sec or CPU far above the cluster median), and instrument per-key request rates client-side for your known-important keys (celebrity ids, global flags).
- **Security.** Both failures are DoS-adjacent. An attacker who can force a synchronised cache-warm (e.g. by triggering a mass invalidation) can engineer an avalanche; one who can concentrate requests on a single key (a scripted flood on one celebrity profile) can engineer a hotspot. Rate-limit per client and per key, and treat a sudden single-key spike as a possible attack, not just organic virality. The local-cache and replication defences also *incidentally* harden against these, since they cap how much of an attack reaches any one node.
- **Scaling.** Avalanche scales *with your warming discipline* — the fix (jitter) is O(1) and always applies. Hot keys are the harder scaling story: as read rate on a single key grows, you climb the ladder — local cache (spreads across the fleet, essentially unlimited if staleness is acceptable), then value replication (spreads across N Redis nodes, limited by write-fan-out cost), then read replicas of the node itself (Redis replication serving reads from replicas of the hot node). The deepest lever is architectural: if a single value is read on *every* request (a global flag), push it to the edge/config layer so it is not a cache read at all.

## 9. Interview Questions

**Q: What is a cache avalanche and what causes it?**
A: A cache avalanche is when a large number of cache keys expire at (or very near) the same instant, so a mass of simultaneous misses hits the origin in one wave and can overwhelm it. The usual cause is *synchronised population with a fixed TTL*: a cache-warming job, a deploy, or a traffic burst writes a big batch of keys within a short window, all with the same TTL, so they all expire together one TTL later. It is essentially many stampedes firing at once. The fix is TTL jitter — give each key a randomised TTL so a batch written together expires spread across a window instead of a single instant, turning the wall of misses into a manageable trickle.

**Q: How does a hot key differ from a cache avalanche?**
A: They are opposite concentrations. A hot key is concentration in *space*: a single key attracts so much traffic that the one node holding it saturates, while the rest of the cluster is idle. An avalanche is concentration in *time*: many different keys expire at the same moment, so the origin sees a synchronised burst of misses. The signatures differ — a hot key shows one node's CPU and network spiking while peers stay flat; an avalanche shows an origin-wide miss spike aligned to a TTL boundary. And the fixes are opposite: avalanche is fixed by decorrelating *time* (TTL jitter), a hot key by decorrelating *space* (replicating the value across nodes, local caching).

**Q: Why can't Redis Cluster solve a hot key by adding more nodes?**
A: Because Redis Cluster shards the keyspace by hashing each *key name* to one of 16384 slots (`CRC16(key) mod 16384`) and assigning slots to nodes — so a *single* key name maps to a *single* slot on a *single* node. All traffic for that one key lands on that one node's single execution thread and network interface, and adding nodes to the cluster does not help, because the key still lives on exactly one of them. Keyspace sharding spreads *many* keys across nodes beautifully but is powerless to spread *one* key. To scale a single hot key you must turn one logical key into many physical keys with different names (which hash to different slots) and read a random one — replicating the value, not sharding the keyspace.

**Q: How do you shard a hot key across the cluster?**
A: Replicate the value into N physical keys whose different names hash to different slots — `celeb:42:rep:0`, `celeb:42:rep:1`, …, `celeb:42:rep:N-1` — and have each reader pick a *random* replica to read, so the read load distributes roughly evenly across the N nodes. The write path fans out: every update writes all N copies, and every invalidation deletes all N. Two details matter: the replica suffix must be *outside* any hash tag `{...}`, or the tag would force all replicas onto the same slot and defeat the spreading; and each replica's TTL should be jittered independently so they do not all expire at once and briefly collapse reads onto the origin. You size N to the ratio of the key's read rate to a single node's capacity.

**Q: Why is jitter almost always the right default, and how much do you use?**
A: Because it has essentially no downside: the cached value is identical, only its lifetime shifts by a small random amount, so there is no correctness cost — and it structurally prevents avalanche for any normally-populated batch of keys. You apply it unconditionally on every write. The magnitude is a trade: too little and expiries still cluster; too much and some keys live noticeably longer or shorter than intended. The usual range is ±10% to ±25% of the base TTL, or an absolute spread sized to how long the origin needs to absorb a batch of misses — if the origin needs 30 seconds to drain a batch comfortably, spread the expiries over at least that window.

**Q: What role does a local (near) cache play for hot keys?**
A: A local cache is an in-process cache in front of Redis with a short TTL (seconds), and it is the single most effective hot-key defence because it removes the Redis round trip entirely for the hottest reads and — crucially — because each application instance has its own, it distributes the load across the whole fleet's memory. A key read a million times a second, served from local caches across 100 app instances, generates only a trickle of Redis reads (one per instance per local-TTL). The trade is staleness bounded by the local TTL and the difficulty of invalidation (you cannot easily reach into every instance's memory to evict), so you keep the local TTL short and accept brief staleness as the price of near-unlimited load-spreading.

**Q: How do you detect a hot key before it causes an incident?**
A: Run detection continuously rather than reaching for it during the fire. `redis-cli --hotkeys` samples the keyspace for the most-frequently-accessed keys, which requires an LFU `maxmemory-policy` so Redis tracks access frequency per key; it gives you a periodic ranking of the busiest keys. Alongside it, watch per-node metrics for *imbalance* — a hot key shows as one node's ops/sec, CPU, and network egress climbing well above the cluster median while peers stay flat, a signature quite different from an avalanche's synchronised origin-wide miss spike. The most responsive signal is client-side instrumentation: keep per-key request counters in the application for your known-important keys (celebrity ids, global flags, trending items) so you see a key heating up in real time. `redis-cli --bigkeys` complements this by finding large keys that often correlate with hotspots. The goal is that a key crossing a rate threshold triggers the local-cache and replication defences automatically, so you never first learn of a hot key from a saturated node.

**Q: (Senior) A viral post suddenly makes one key extremely hot mid-incident. Walk through your response.**
A: First, confirm the diagnosis: per-node metrics showing one node's CPU, ops/sec, and network egress spiking while peers stay flat is the hot-key signature (versus an avalanche's origin-wide, TTL-aligned miss spike). Identify the exact key with `redis-cli --hotkeys` or client-side per-key counters, or briefly with `MONITOR` if I must. The fastest mitigation that does not require a deploy is a *local cache*: enable or shorten the in-process cache TTL for that key across the fleet, which immediately collapses most reads onto app-instance memory and takes the pressure off the node — this is why I want the near-cache machinery already built and toggleable, not written during the incident. In parallel, if reads still saturate the node, turn on *value replication* for that key: write N copies to differently-named keys that land on different slots and switch readers to a random replica, spreading the residual Redis load across N nodes. Throughout, singleflight coalesces concurrent reads so the recompute-on-miss path cannot itself multiply load. Once stable, I would post-mortem the detection lag — the goal is for continuous `--hotkeys`/LFU sampling and per-key instrumentation to flag a key heating up *before* it saturates a node, so next time the local cache engages automatically rather than as a manual scramble. The key discipline is that all of this — local cache, replication, coalescing — is pre-built and configuration-toggled, because you cannot safely ship new caching code in the middle of a saturation incident.

**Q: (Senior) How do hash tags interact with hot-key replication, and where do people get it wrong?**
A: Hash tags `{...}` force keys onto the same slot by hashing only the tagged substring — `user:{42}:profile` and `user:{42}:settings` both hash on `42`, so they co-locate, which is exactly what you want for multi-key atomic operations in a cluster. But that co-location is precisely the *wrong* property for hot-key replicas, whose entire purpose is to land on *different* slots so the load spreads. The mistake is putting the replica index inside a shared hash tag, or reusing an existing tagged key scheme, so that `celeb:{42}:rep:0` … `celeb:{42}:rep:N` all hash on `{42}` and pile every replica onto the same slot and the same overloaded node — you have paid the write-fan-out cost of replication and got none of the spreading. The fix is to keep the replica suffix outside any hash tag, so the full varying name drives the hash and the replicas genuinely distribute. The deeper point is that co-location and distribution are opposite goals: you deliberately use hash tags to co-locate keys you need to operate on atomically, and you deliberately avoid them (or ensure the varying part is unbtagged) for keys you need to spread. Getting a hot-key scheme right means being explicit about which of the two you want for every key, and verifying with `CLUSTER KEYSLOT` that the replicas actually land on different slots.

**Q: (Senior) Compare local caching, value replication, and read replicas as hot-key defences.**
A: They spread load at different layers with different trade-offs. *Local (near) caching* spreads the furthest and costs the least round trips — it serves reads from each app instance's memory, so a key hot at any rate becomes a trickle of Redis reads (one per instance per local TTL); its costs are per-instance staleness bounded by that TTL and the near-impossibility of precise invalidation, so it suits values that tolerate seconds of staleness. *Value replication* spreads Redis-level load across N nodes by turning one key into N differently-slotted keys read at random; it keeps each copy consistent-on-write but multiplies write cost by N and adds a between-replica consistency window, so it suits read-dominated hot keys where even Redis round trips saturate the node. *Read replicas* (Redis replication) let the hot node's replica servers serve reads, scaling read throughput for the node as a whole without changing key names, but reads may be slightly stale (async replication) and you are still bounded by how many replicas you can attach and route to. In practice I layer them: local cache first (widest spread, cheapest), value replication for keys hot enough that Redis round trips still saturate a node, and read replicas as an infrastructure-level backstop — while jitter runs unconditionally underneath so replica and batch expiries never re-synchronise. The choice among them is really a staleness-versus-cost decision: local caching trades the most freshness for the most spreading; replication trades write cost for shared consistency; read replicas trade infrastructure for transparency to the application.

## 10. Quick Revision & Cheat Sheet

| Problem | Concentration | Root cause | Fix |
|---|---|---|---|
| Avalanche | in *time* | many keys, same TTL, written together | TTL jitter |
| Hot key | in *space* | one key saturates its single slot/node | local cache, value replication, coalescing |

| Hot-key defence | Spreads load across | Cost |
|---|---|---|
| Local / near cache | the whole app fleet's memory | per-instance staleness |
| Value replication | N Redis nodes | N× writes, consistency window |
| Read replicas | the node's replica servers | async staleness, infra |
| Request coalescing | (bounds concurrency, not spread) | in-process only |

**Flash cards**
- **Avalanche?** → Many keys expire at once (same TTL, warmed together) → miss storm. Fix: jitter.
- **Hot key?** → One key saturates its single node. Fix: local cache + value replication.
- **Why can't Cluster spread a hot key?** → One key name → one slot → one node; adding nodes doesn't help.
- **How to shard a hot key?** → N copies `key:rep:0..N-1` on different slots, read a random one.
- **Hash-tag gotcha?** → Replica suffix must be *outside* `{...}` or all replicas share one slot.
- **Best hot-key fix?** → Local cache — reads never leave the app, load spreads across the fleet.
- **Detect hot keys?** → `redis-cli --hotkeys` (needs LFU policy), per-node metrics, client counters.

## 11. Hands-On Exercises & Mini Project

- [ ] Warm 10,000 keys with a fixed TTL, then re-run with a jittered TTL, and chart the origin miss-rate at expiry for both; confirm the wall becomes a trickle.
- [ ] Plot the remaining-TTL histogram of a fixed-TTL batch versus a jittered one and see the spike flatten.
- [ ] Build a hot-key cache that replicates a value to N keys and reads a random replica; verify with `CLUSTER KEYSLOT` that the replicas land on different slots.
- [ ] Deliberately put the replica index inside a hash tag and show all replicas collapsing onto one slot; then fix it and show them spreading.
- [ ] Put a short-TTL local cache in front and measure the drop in Redis reads for a hammered key; observe the load spreading across simulated instances.
- [ ] Run `redis-cli --hotkeys` against a workload with one artificially hot key and confirm it surfaces the key.

### Mini Project — "Hotspot & Avalanche Lab"

**Goal.** Reproduce both concentration failures and demonstrate the opposite fixes — jitter for time, replication and local caching for space — with measurements.

**Requirements.**
1. A cache-warming job that populates a large batch of keys, switchable between fixed and jittered TTL, with an origin that counts misses per second.
2. A load generator that can (a) let a warmed batch expire to trigger an avalanche and (b) concentrate traffic on one key to create a hotspot.
3. Implement TTL jitter and show the avalanche miss-storm flattening into a trickle; chart origin miss-rate for fixed vs jittered.
4. Implement value replication (N differently-slotted keys, random-replica reads) and a short-TTL local cache; on a Redis Cluster (or simulated node-tagged keys), chart per-node load with and without each fix.
5. Add detection: sample hot keys (`--hotkeys` or client counters) and per-node metrics, and show the hotspot being identified before it saturates a node.

**Extensions.**
- Combine with chapter 15's stampede protection so that when a jittered key finally expires, its recompute is coalesced.
- Simulate a viral spike (one key's rate jumps 100× suddenly) and measure how quickly detection flags it and how much the local cache absorbs.
- Measure the write-cost and consistency-window overhead of replication as N grows, to find the point where local caching alone is the better trade.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Cache Stampede (Thundering Herd) & Mitigations* (the single-key sibling of avalanche, and coalescing), *Cache Penetration, Null Caching & Bloom Filters* (the load-bypass failures), *Redis Cluster: Slots, Sharding & Resharding* (the 16384-slot model a hot key defeats), *TTL, Expiration & Eviction* (jitter and expiry mechanics), *Client-Side & Near Caching* (the local cache in depth).

- **Redis — Cluster specification & hash slots** — Redis · *Advanced* · how `CRC16 mod 16384` slots and hash tags work; the reason a hot key can't be sharded by the keyspace. <https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/>
- **Redis — LFU eviction & `--hotkeys`** — Redis · *Intermediate* · the access-frequency tracking that powers hot-key detection and the `redis-cli --hotkeys` sampler. <https://redis.io/docs/latest/develop/reference/eviction/>
- **Redis — Scaling with Redis Cluster** — Redis · *Intermediate* · the keyspace-sharding scaling model and its limits, including single-key hotspots. <https://redis.io/docs/latest/operate/oss_and_stack/management/scaling/>
- **Cache penetration, breakdown and avalanche** — Alibaba Cloud engineering · *Intermediate* · the canonical framing of the three cache failure modes; the source of the avalanche terminology. <https://www.alibabacloud.com/blog/cache-penetration-cache-breakdown-and-cache-avalanche_599150>
- **Facebook — Scaling Memcache at Facebook (NSDI)** — Nishtala et al. · *Advanced* · the classic paper on hot keys, near caching, and load-spreading at extreme scale. <https://www.usenix.org/system/files/conference/nsdi13/nsdi13-final170_update.pdf>
- **Netflix — Application data caching (EVCache)** — Netflix Tech Blog · *Advanced* · production near-caching and replication patterns for hot data across zones. <https://netflixtechblog.com/application-data-caching-using-ssds-5bf25df851ef>
- **Designing Data-Intensive Applications, ch. 6 (Partitioning)** — Martin Kleppmann · *Advanced* · partitioning, skewed workloads, and relieving hot spots; the theory behind key replication. <https://dataintensive.net/>
- **Redis University — RU301: Running Redis at Scale** — Redis · *Intermediate* · a free course on Cluster, sharding, and the operational handling of hotspots. <https://university.redis.com/>

---

*Caching with Redis Handbook — chapter 17.*
