# 07 · Memory, maxmemory & Eviction Policies

> **In one line:** A cache is a bet that you can hold the *working set* in RAM and let everything else fall out gracefully — and that bet only pays off if you set `maxmemory` and pick an eviction policy that matches your access pattern, because the default (`noeviction`) turns a full cache into failed writes instead of a smaller cache.

---

## 1. Overview

Redis lives in RAM, which is the source of its speed and the source of its one hard limit: memory is finite and far more expensive per byte than disk. A cache is therefore an exercise in *managing scarcity* — deciding what to keep when you cannot keep everything. That decision is governed by two settings, `maxmemory` (the ceiling) and `maxmemory-policy` (what to do when you hit it), and getting them right is the difference between a cache that degrades gracefully under pressure and one that either falls over or silently stops accepting writes.

The stakes are concrete. Leave `maxmemory` unset and Redis will grow until the operating system's OOM killer terminates the process — a hard, ungraceful failure that takes your cache down entirely. Set `maxmemory` but leave the policy at its default `noeviction`, and when the ceiling is reached Redis starts *rejecting writes* with an error while continuing to serve reads — which for many workloads is a subtle, confusing outage where the cache mysteriously stops accepting new entries. Neither default is right for a cache. The correct configuration is a ceiling plus a policy that *evicts* to make room, and the interesting engineering is in choosing which of the eight policies matches how your keys are actually accessed.

This chapter covers the memory model (`used_memory` versus `used_memory_rss`, and fragmentation), the `maxmemory` ceiling, and all eight eviction policies — the two `allkeys` variants, the four `volatile` variants, and the two "random" and "no-eviction" edge cases. It explains *how* the approximate-LRU sampling and the probabilistic-LFU counter actually work, because "LRU" and "LFU" in Redis are not the textbook algorithms and the difference matters when you tune them. And it gives you a decision procedure: `allkeys-lru` as the sane default for a pure cache, `volatile-ttl` when you set meaningful TTLs, `allkeys-lfu` when you have a stable hot set, and why the others are situational.

## 2. Core Concepts

- **`used_memory`** — the bytes Redis's allocator has handed out for your data and overhead; the number eviction decisions are made against.
- **`used_memory_rss`** — the resident memory the OS sees the process holding; larger than `used_memory` when the allocator holds freed-but-unreturned pages.
- **`maxmemory`** — the configured ceiling; when `used_memory` approaches it, the eviction policy runs to make room (or writes fail, under `noeviction`).
- **`maxmemory-policy`** — one of eight policies deciding *which* keys to evict when the ceiling is reached.
- **Eviction** — removing a key to free memory for an incoming write; runs synchronously as part of processing that write, on the single thread.
- **`allkeys-*`** — policies eligible to evict *any* key (the whole keyspace is a candidate); right for a pure cache where everything is disposable.
- **`volatile-*`** — policies eligible to evict *only keys with a TTL*; right when some keys are persistent and only the expiring ones are cache-like.
- **Approximate LRU** — Redis's LRU: not a true global LRU list, but eviction of the least-recently-used among a small random *sample* (`maxmemory-samples`).
- **LFU (probabilistic)** — Least-Frequently-Used, tracking access *frequency* via an 8-bit logarithmic counter that increments probabilistically (`lfu-log-factor`) and decays over time (`lfu-decay-time`).
- **Fragmentation** — the gap between `used_memory` and `used_memory_rss` (`mem_fragmentation_ratio`); addressed by `activedefrag` or a restart.
- **Working set** — the subset of keys actually accessed in a given window; the cache pays off only if this fits under `maxmemory`.

## 3. Theory & Principles

### The memory model: two numbers that are not the same

There are two memory figures you must not conflate. `used_memory` is what Redis's allocator (jemalloc by default) has allocated for your data plus overhead — this is the number `maxmemory` and eviction are measured against. `used_memory_rss` (Resident Set Size) is what the *operating system* sees the process occupying. In a healthy instance these track closely, but they diverge for a specific reason: when Redis frees memory (a key expires, is deleted, or is evicted), the allocator does not always return those pages to the OS immediately — it holds them for reuse. So `used_memory_rss` can stay high while `used_memory` drops, and the ratio between them, `mem_fragmentation_ratio` (`rss / used_memory`), tells you how much memory the OS is holding beyond what Redis is actively using. A ratio around 1.0–1.5 is normal; well above that signals fragmentation (real physical memory tied up in allocator gaps); *below* 1.0 is a warning that Redis has been swapped to disk, which is catastrophic on a single-threaded server because a "memory" access becomes a disk seek that blocks everyone (chapter 3).

### `maxmemory` and the eight policies

`maxmemory` sets the ceiling. When a write would push `used_memory` past it, Redis consults `maxmemory-policy` to decide what to do. There are eight policies, and they factor along two axes: *which keys are candidates* and *how a victim is chosen*.

The candidate axis splits into **`allkeys-*`** (any key may be evicted) and **`volatile-*`** (only keys that have a TTL may be evicted). The victim axis is **LRU** (least recently used), **LFU** (least frequently used), **TTL** (soonest to expire — volatile only), or **random**. That gives: `allkeys-lru`, `allkeys-lfu`, `allkeys-random`, `volatile-lru`, `volatile-lfu`, `volatile-ttl`, `volatile-random`, and the odd one out, **`noeviction`** — evict nothing, and fail writes when full.

`noeviction` is the default, and it is a *database* default, not a cache default. Under it, once full, every write that needs memory returns an `OOM command not allowed` error while reads keep working — so the symptom is a cache that has silently stopped accepting new data, often mistaken for a bug elsewhere. **For a cache you almost never want `noeviction`.** You want a policy that makes room. The `volatile-*` policies have a sharp edge too: they can only evict keys with a TTL, so if you hit `maxmemory` and *no* eligible key has a TTL, they behave like `noeviction` and fail the write. That is why `volatile-*` is correct only when you deliberately set TTLs on the cache-like keys and want the TTL-less keys treated as persistent.

```svg
<svg viewBox="0 0 880 500" width="100%" height="500" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The eight eviction policies: two axes, one default trap</text>

  <text x="250" y="52" text-anchor="middle" fill="#334155" font-size="11" font-weight="bold">Candidates: which keys may be evicted?</text>
  <rect x="60" y="62" width="180" height="26" rx="5" fill="#dbeafe" stroke="#2563eb"/><text x="150" y="80" text-anchor="middle" fill="#1e40af" font-size="10" font-weight="bold">allkeys-* : ANY key</text>
  <rect x="260" y="62" width="220" height="26" rx="5" fill="#fef3c7" stroke="#d97706"/><text x="370" y="80" text-anchor="middle" fill="#92400e" font-size="10" font-weight="bold">volatile-* : only keys WITH a TTL</text>

  <rect x="40" y="104" width="800" height="150" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="440" y="126" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">allkeys-* &#8212; the whole keyspace is disposable (a PURE cache)</text>
  <rect x="60" y="140" width="240" height="100" rx="8" fill="#fff" stroke="#16a34a"/>
  <text x="180" y="162" text-anchor="middle" fill="#15803d" font-weight="bold">allkeys-lru</text>
  <text x="76" y="184" fill="#166534" font-size="9.5">evict least-RECENTLY-used</text>
  <text x="76" y="202" fill="#166534" font-size="9.5">(approx, via sampling)</text>
  <text x="76" y="224" fill="#15803d" font-size="9.5" font-weight="bold">DEFAULT CHOICE for a cache</text>
  <rect x="316" y="140" width="240" height="100" rx="8" fill="#fff" stroke="#16a34a"/>
  <text x="436" y="162" text-anchor="middle" fill="#15803d" font-weight="bold">allkeys-lfu</text>
  <text x="332" y="184" fill="#166534" font-size="9.5">evict least-FREQUENTLY-used</text>
  <text x="332" y="202" fill="#166534" font-size="9.5">(probabilistic counter)</text>
  <text x="332" y="224" fill="#15803d" font-size="9.5" font-weight="bold">best for a STABLE hot set</text>
  <rect x="572" y="140" width="240" height="100" rx="8" fill="#fff" stroke="#16a34a"/>
  <text x="692" y="162" text-anchor="middle" fill="#15803d" font-weight="bold">allkeys-random</text>
  <text x="588" y="184" fill="#166534" font-size="9.5">evict a random key</text>
  <text x="588" y="202" fill="#166534" font-size="9.5">no recency/frequency signal</text>
  <text x="588" y="224" fill="#64748b" font-size="9.5">rare: uniform access only</text>

  <rect x="40" y="266" width="800" height="150" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="440" y="288" text-anchor="middle" fill="#92400e" font-size="12" font-weight="bold">volatile-* &#8212; some keys are persistent; evict only the TTL'd ones</text>
  <rect x="60" y="302" width="185" height="100" rx="8" fill="#fff" stroke="#d97706"/>
  <text x="152" y="324" text-anchor="middle" fill="#92400e" font-weight="bold">volatile-lru</text>
  <text x="76" y="346" fill="#b45309" font-size="9">LRU among TTL'd keys</text>
  <rect x="255" y="302" width="185" height="100" rx="8" fill="#fff" stroke="#d97706"/>
  <text x="347" y="324" text-anchor="middle" fill="#92400e" font-weight="bold">volatile-lfu</text>
  <text x="271" y="346" fill="#b45309" font-size="9">LFU among TTL'd keys</text>
  <rect x="450" y="302" width="185" height="100" rx="8" fill="#fff" stroke="#d97706" stroke-width="2.5"/>
  <text x="542" y="324" text-anchor="middle" fill="#92400e" font-weight="bold">volatile-ttl</text>
  <text x="466" y="346" fill="#b45309" font-size="9">evict SOONEST-to-expire</text>
  <text x="466" y="362" fill="#92400e" font-size="9" font-weight="bold">good with explicit TTLs</text>
  <rect x="645" y="302" width="175" height="100" rx="8" fill="#fff" stroke="#d97706"/>
  <text x="732" y="324" text-anchor="middle" fill="#92400e" font-weight="bold">volatile-random</text>
  <text x="661" y="346" fill="#b45309" font-size="9">random among TTL'd</text>
  <text x="76" y="392" fill="#b91c1c" font-size="9" font-weight="bold">TRAP: if NO key has a TTL when full, every volatile-* policy acts like noeviction &#8594; writes FAIL.</text>

  <rect x="40" y="428" width="800" height="58" rx="10" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="440" y="450" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">noeviction (the DEFAULT) &#8212; a database default, a cache trap</text>
  <text x="440" y="472" text-anchor="middle" fill="#991b1b" font-size="10">When full: reads work, but every write needing memory FAILS with an OOM error. A cache that silently stops accepting data.</text>
</svg>
```

### How Redis's LRU is *approximate*, and how LFU actually works

Redis does not maintain a true global LRU list — that would cost a linked-list pointer update on every access and extra memory per key on a single-threaded server. Instead, **LRU is approximated by sampling**: when it needs to evict, Redis picks `maxmemory-samples` random keys (default 5), looks at each one's last-access time (stored cheaply in the object header), and evicts the least-recently-used *of that sample*. This is not guaranteed to evict the globally-oldest key, but with a sample of 5 it evicts a key very close to the true LRU choice, and raising `maxmemory-samples` to 10 makes it nearly exact at the cost of more CPU per eviction. The trade is deliberate: near-LRU accuracy for a fraction of the memory and CPU of true LRU.

**LFU** (Redis 4+) tracks *frequency* rather than recency, which is better when a key was accessed heavily once long ago versus a key accessed steadily — recency alone can evict a genuinely hot key just because it was quiet for a moment. But storing an exact access count per key would be expensive and would let one old burst dominate forever, so Redis uses a clever approximation. Each key has an 8-bit counter (max 255) that is *not* a raw count: it increments **probabilistically**, with the probability of an increment shrinking as the counter grows, governed by `lfu-log-factor`. This makes the counter roughly logarithmic — the difference between "accessed 10 times" and "accessed 10,000 times" fits in 8 bits. And the counter **decays** over time, halving (roughly) every `lfu-decay-time` minutes, so a key that was hot yesterday but is cold today loses its standing and becomes evictable. Together these give a frequency estimate that is compact (one byte), bounded, and time-aware — exactly what you want to keep the stable hot set and shed the one-hit wonders.

### Eviction is not free: it runs on the write path

A detail that surprises people the first time it bites: eviction happens *synchronously, on the single thread, as part of processing the write that needed room* (chapter 3). It is not a background task. So when an instance sits right at `maxmemory`, every incoming write may have to evict one or more victims before it can proceed, and that work — sampling candidates, freeing their memory — adds latency to the write. For small values this is negligible, but two cases make it painful. First, evicting a **big key** (a large hash, set, or sorted set) frees a large collection synchronously, which can stall the thread the same way a `DEL` on a big key does; `lazyfree-lazy-eviction yes` mitigates this by freeing evicted keys' memory in a background thread, much as `UNLINK` does. Second, an instance run *perpetually* at the ceiling pays this tax on *every* write, turning a memory-sizing mistake into a latency problem. Redis also has a `maxmemory-eviction-tenacity` knob that controls how hard it tries to keep up when eviction cannot free memory fast enough — raising it makes Redis evict more aggressively (more CPU, more latency) rather than let `used_memory` drift above the ceiling. The operational lesson reinforces the sizing rule: keep the working set comfortably below the ceiling so eviction is an occasional event, not a per-write cost, and enable `lazyfree-lazy-eviction` so that when a big key is evicted the thread is not blocked freeing it.

## 4. Architecture & Workflow

What happens when a write arrives at a full instance:

1. **A write needs memory.** A `SET`/`HSET`/etc. arrives; Redis computes whether serving it would push `used_memory` past `maxmemory`.
2. **Consult the policy.** If room is needed, `maxmemory-policy` decides. Under `noeviction`, the write is rejected with an OOM error and the flow stops here.
3. **Select victims (by sampling).** For an LRU/LFU policy, Redis samples `maxmemory-samples` candidate keys (from all keys, or only TTL'd keys for `volatile-*`) and picks the worst by recency, frequency, or nearest TTL.
4. **Evict, synchronously, on the single thread.** The victim is removed to free memory. This happens as part of processing the write, so a pathological eviction storm can add latency to writes — one reason to keep the working set comfortably under the ceiling rather than perpetually at it.
5. **Repeat until there is room.** Redis may evict several keys in one write's path if one is not enough.
6. **Serve the write.** With room made, the write proceeds. If the policy could not free enough (e.g. `volatile-*` with no TTL'd keys), the write fails as under `noeviction`.

Eviction and expiration (chapter 6) are distinct: expiration removes keys whose TTL has passed (lazy + active, eventually); eviction removes keys to satisfy the `maxmemory` ceiling *now*, driven by the policy, on the write path. A cache typically uses both — TTLs to bound staleness, eviction to enforce the memory ceiling.

```svg
<svg viewBox="0 0 880 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="v1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
    <marker id="v2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Choosing a policy by access pattern</text>

  <rect x="300" y="44" width="280" height="40" rx="8" fill="#f1f5f9" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="62" text-anchor="middle" fill="#334155" font-weight="bold" font-size="11">Is EVERY key a disposable cache entry?</text>
  <text x="440" y="78" text-anchor="middle" fill="#475569" font-size="9">(vs. some keys must never be evicted)</text>

  <path d="M370,84 L200,120" stroke="#16a34a" stroke-width="1.5" fill="none" marker-end="url(#v1)"/>
  <text x="250" y="104" fill="#15803d" font-size="9" font-weight="bold">yes &#8594; allkeys-*</text>
  <path d="M510,84 L680,120" stroke="#d97706" stroke-width="1.5" fill="none" marker-end="url(#v2)"/>
  <text x="600" y="104" fill="#b45309" font-size="9" font-weight="bold">no &#8594; volatile-*</text>

  <rect x="40" y="126" width="330" height="120" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="205" y="148" text-anchor="middle" fill="#15803d" font-weight="bold">Pure cache (allkeys)</text>
  <text x="56" y="172" fill="#166534" font-size="9.5">&#8226; Access is recency-driven, mixed set</text>
  <text x="70" y="188" fill="#15803d" font-size="9.5" font-weight="bold">&#8594; allkeys-lru (the default choice)</text>
  <text x="56" y="210" fill="#166534" font-size="9.5">&#8226; Stable hot set, cold long tail</text>
  <text x="70" y="226" fill="#15803d" font-size="9.5" font-weight="bold">&#8594; allkeys-lfu (keeps the hot set)</text>

  <rect x="510" y="126" width="330" height="120" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="675" y="148" text-anchor="middle" fill="#92400e" font-weight="bold">Mixed store (volatile)</text>
  <text x="526" y="172" fill="#b45309" font-size="9.5">&#8226; You set meaningful TTLs per entry</text>
  <text x="540" y="188" fill="#92400e" font-size="9.5" font-weight="bold">&#8594; volatile-ttl (drop soonest-to-expire)</text>
  <text x="526" y="210" fill="#b45309" font-size="9.5">&#8226; Cache + persistent keys share instance</text>
  <text x="540" y="226" fill="#92400e" font-size="9.5" font-weight="bold">&#8594; volatile-lru / volatile-lfu</text>

  <rect x="40" y="266" width="800" height="150" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="288" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Sizing the working set &#8212; the bet the whole cache rests on</text>
  <text x="60" y="314" fill="#475569" font-size="10">&#8226; The WORKING SET is the keys actually accessed in a window. The cache pays off only if it fits under maxmemory.</text>
  <text x="60" y="336" fill="#475569" font-size="10">&#8226; Too small a ceiling &#8594; the hot set doesn't fit, eviction churns hot keys, hit rate collapses (thrashing).</text>
  <text x="60" y="358" fill="#475569" font-size="10">&#8226; Leave headroom above the working set for spikes, fragmentation, and replication/COW buffers &#8212; don't run at 100%.</text>
  <text x="60" y="380" fill="#334155" font-size="10" font-weight="bold">&#8226; Rule of thumb: size maxmemory so the working set fits with ~25% headroom; watch evicted_keys and the hit rate.</text>
  <text x="60" y="402" fill="#b91c1c" font-size="10">&#8226; NEVER let Redis swap: used_memory_rss &lt; used_memory (ratio &lt; 1) means paging to disk &#8212; catastrophic on one thread.</text>
</svg>
```

## 5. Implementation

```conf
# ---- redis.conf: the memory + eviction block for a cache ----

# The ceiling. Size it so your WORKING SET fits with headroom (see §4).
# Leave room above the hot set for spikes, fragmentation, and (if replicated)
# copy-on-write buffers during a fork. Don't set it to 100% of the box.
maxmemory 4gb

# Make room by evicting, don't fail writes. allkeys-lru is the sane default
# for a PURE cache where every key is a disposable copy of the origin.
maxmemory-policy allkeys-lru

# LRU/LFU accuracy vs CPU per eviction. 5 is near-LRU; 10 is close to exact.
maxmemory-samples 5

# Free evicted keys' memory in a BACKGROUND thread, so evicting a big key does
# not block the single event-loop thread (same idea as UNLINK vs DEL, ch. 3).
lazyfree-lazy-eviction yes

# ---- If you switch to LFU (allkeys-lfu), these tune the counter ----
# Higher log-factor => counter saturates more slowly => distinguishes
# high-frequency keys better. Default 10 is fine for most workloads.
lfu-log-factor 10
# Halve the frequency counter every N minutes of inactivity, so yesterday's
# hot key becomes evictable today. Default 1 minute.
lfu-decay-time 1

# Fight fragmentation online (jemalloc only) instead of restarting.
activedefrag yes
active-defrag-ignore-bytes 100mb   # start only past this much fragmentation
active-defrag-threshold-lower 10   # ...and this fragmentation percentage
```

```go
package memory

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"
)

// ConfigureCacheEviction sets the ceiling and policy at runtime with CONFIG
// SET (persisted to redis.conf only if you CONFIG REWRITE). Doing it in code
// makes the cache's memory contract explicit and reviewable at startup.
func ConfigureCacheEviction(ctx context.Context, rdb *redis.Client, maxmem string) error {
	// noeviction (the default) would make a full cache REJECT writes; for a
	// pure cache we want it to evict the least-recently-used key instead.
	if err := rdb.ConfigSet(ctx, "maxmemory", maxmem).Err(); err != nil {
		return err
	}
	return rdb.ConfigSet(ctx, "maxmemory-policy", "allkeys-lru").Err()
}

// MemoryHealth reads the numbers that actually tell you if the cache is
// healthy: the two memory figures, the fragmentation ratio, and the eviction
// counter. Rising evicted_keys with a falling hit rate = the ceiling is too
// low and the working set no longer fits (thrashing).
type MemoryHealth struct {
	UsedMemory        int64   // bytes the allocator handed out (eviction basis)
	UsedMemoryRSS     int64   // bytes the OS sees the process holding
	FragmentationRatio float64 // rss / used_memory: >1.5 fragmented, <1 SWAPPING
	MaxMemory         int64
	EvictedKeys       int64 // cumulative evictions; watch its RATE
	KeyspaceHits      int64
	KeyspaceMisses    int64
}

func ReadMemoryHealth(ctx context.Context, rdb *redis.Client) (MemoryHealth, error) {
	// INFO returns a text blob; parse the fields we care about. In practice a
	// metrics agent scrapes these, but reading them explicitly shows what to
	// alert on.
	raw, err := rdb.Info(ctx, "memory", "stats").Result()
	if err != nil {
		return MemoryHealth{}, err
	}
	fields := parseInfo(raw)
	h := MemoryHealth{
		UsedMemory:         fields.int("used_memory"),
		UsedMemoryRSS:      fields.int("used_memory_rss"),
		FragmentationRatio: fields.float("mem_fragmentation_ratio"),
		MaxMemory:          fields.int("maxmemory"),
		EvictedKeys:        fields.int("evicted_keys"),
		KeyspaceHits:       fields.int("keyspace_hits"),
		KeyspaceMisses:     fields.int("keyspace_misses"),
	}
	return h, nil
}

// HitRate is the single most important cache metric. If evicted_keys is
// climbing AND this is falling, the ceiling is too small: eviction is churning
// keys the workload still wants. Raise maxmemory or shrink the working set.
func (h MemoryHealth) HitRate() float64 {
	total := h.KeyspaceHits + h.KeyspaceMisses
	if total == 0 {
		return 0
	}
	return float64(h.KeyspaceHits) / float64(total)
}

// Swapping reports the catastrophic case: RSS below used_memory means pages
// have been swapped to disk, so a "memory" access is now a disk seek that
// blocks the single thread for everyone. Alert on this hard.
func (h MemoryHealth) Swapping() bool {
	return h.FragmentationRatio > 0 && h.FragmentationRatio < 1.0
}

// --- tiny INFO parser (WHY: INFO is "field:value" lines per section) ---
type infoFields map[string]string

func parseInfo(raw string) infoFields {
	f := make(infoFields)
	for _, line := range strings.Split(raw, "\r\n") {
		if i := strings.IndexByte(line, ':'); i > 0 {
			f[line[:i]] = line[i+1:]
		}
	}
	return f
}

func (f infoFields) int(k string) int64 {
	n, _ := strconv.ParseInt(strings.TrimSpace(f[k]), 10, 64)
	return n
}

func (f infoFields) float(k string) float64 {
	v, _ := strconv.ParseFloat(strings.TrimSpace(f[k]), 64)
	return v
}

// InspectKey shows per-key memory accounting, the tool for hunting big keys
// that concentrate memory and make eviction lumpy.
func InspectKey(ctx context.Context, rdb *redis.Client, key string) (string, error) {
	bytes, err := rdb.MemoryUsage(ctx, key).Result()
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%s uses %d bytes", key, bytes), nil
}
```

```bash
# The same picture from redis-cli, where you check it during an incident:
127.0.0.1:6379> CONFIG GET maxmemory-policy      # confirm it's NOT noeviction
127.0.0.1:6379> INFO memory                      # used_memory, used_memory_rss,
                                                  # maxmemory, mem_fragmentation_ratio
127.0.0.1:6379> INFO stats | grep evicted_keys   # eviction happening? at what rate?
127.0.0.1:6379> MEMORY DOCTOR                     # human-readable diagnosis
127.0.0.1:6379> MEMORY USAGE user:9              # bytes for one key (hunt big keys)
127.0.0.1:6379> MEMORY STATS                      # detailed allocator breakdown
```

The code and config encode the operating discipline: never leave `noeviction` on a cache, size the ceiling so the working set fits with headroom, and alert on the trio that reveals trouble — a climbing eviction rate, a falling hit rate, and (worst of all) a fragmentation ratio below 1.0 that means swapping.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Graceful degradation under pressure.** With a ceiling and an eviction policy, a full cache becomes a *smaller* cache that keeps serving, rather than an outage or a write-rejecting freeze.
- **Cheap, effective approximations.** Sampled LRU and probabilistic LFU deliver near-optimal victim selection for a tiny fraction of the memory and CPU of exact algorithms.
- **Policy matches pattern.** Eight policies cover the real access patterns — recency, frequency, TTL-driven, and mixed persistent/cache workloads — so you can tune eviction to your data.
- **Frequency-awareness with LFU.** The decaying probabilistic counter keeps a stable hot set and sheds one-hit wonders, which pure recency (LRU) cannot distinguish.

**Disadvantages**
- **Eviction runs on the write path, on the one thread.** Heavy eviction adds latency to writes, so an instance run perpetually at the ceiling pays a continuous tax.
- **Approximation can misfire.** Sampled LRU with too few samples, or LFU with mis-tuned decay, can evict a key you wanted — the accuracy knob (`maxmemory-samples`, `lfu-*`) is a real tuning burden.
- **`volatile-*` can silently become `noeviction`.** If no eligible key has a TTL when full, writes fail — a subtle failure mode of the volatile policies.
- **Fragmentation wastes real RAM.** The allocator holds freed pages, so `used_memory_rss` can exceed `used_memory` and tie up memory you paid for.

**Trade-offs**
- *LRU vs LFU:* LRU is simpler and adapts fast to shifting hot sets; LFU protects a genuinely hot key from eviction during a quiet moment but needs decay tuning so stale-hot keys age out. Choose LFU when the hot set is stable and worth protecting.
- *`allkeys-*` vs `volatile-*`:* `allkeys` treats everything as evictable (right for a pure cache); `volatile` protects TTL-less keys as persistent (right for a mixed instance) but risks write failure if nothing is evictable. Choose by whether the instance holds anything that must survive.
- *Ceiling headroom vs RAM cost:* more headroom above the working set absorbs spikes and fragmentation and reduces eviction churn, but RAM is expensive; too little headroom thrashes the hot set. Size to the working set plus ~25%, then watch the hit rate.
- *`maxmemory-samples` accuracy vs CPU:* more samples make LRU/LFU nearer-exact but cost CPU per eviction on the single thread; the default 5 is a good balance, raised only if eviction quality visibly hurts.

## 7. Common Mistakes & Best Practices

- **Leaving `maxmemory` at 0 (unlimited).** Redis grows until the OS OOM-kills it — a hard, total failure. **Best practice:** always set `maxmemory` below the machine's RAM, with headroom for the OS and any fork buffers.
- **Leaving the policy at `noeviction`.** A full cache stops accepting writes while reads keep working — a confusing silent outage. **Best practice:** use `allkeys-lru` (or another evicting policy) for a cache.
- **Using `volatile-*` without TTLs.** If no eligible key has a TTL, the policy behaves like `noeviction` and writes fail. **Best practice:** use `volatile-*` only when you deliberately set TTLs on the evictable keys; otherwise use `allkeys-*`.
- **Running at 100% of the ceiling continuously.** Perpetual eviction taxes every write on the single thread and thrashes the hot set. **Best practice:** size the ceiling so the working set fits with headroom and eviction is occasional, not constant.
- **Ignoring the hit rate while adding memory.** Throwing RAM at a low hit rate without checking whether the *working set* fits is guesswork. **Best practice:** watch `keyspace_hits`/`misses` and `evicted_keys` together — a climbing eviction rate with a falling hit rate means the working set no longer fits.
- **Confusing `used_memory` and `used_memory_rss`.** Alarming on RSS alone misreads fragmentation as a leak. **Best practice:** track `mem_fragmentation_ratio`; address high fragmentation with `activedefrag`, and treat a ratio below 1.0 as a swapping emergency.
- **One giant key concentrating memory.** A multi-megabyte key makes eviction lumpy and every touching command slow. **Best practice:** find big keys with `MEMORY USAGE`/`--bigkeys` and split them (chapter 4).

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** `MEMORY DOCTOR` gives a plain-language diagnosis (fragmentation, big keys, a policy problem). `MEMORY STATS` breaks down where memory goes (dataset, overhead, replication buffers). `redis-cli --bigkeys` and `--memkeys` sample the keyspace for the largest keys — the usual cause of lumpy eviction and memory spikes. `INFO memory` and `INFO stats` (`evicted_keys`) are the first stops when memory or latency misbehaves.
- **Monitoring.** Alert on four things: `used_memory` approaching `maxmemory` (approaching the ceiling); the *rate* of `evicted_keys` (sustained eviction means the working set does not fit); the hit rate (`keyspace_hits / (hits + misses)` falling under eviction is thrashing); and `mem_fragmentation_ratio` (above ~1.5 is fragmentation, below 1.0 is swapping — the most urgent alert, because a swapped Redis blocks the single thread on disk seeks).
- **Security.** Eviction is a denial-of-service surface: an attacker who can write many keys can evict a victim's hot data (a "cache-flushing" attack), degrading everyone. Mitigations include per-tenant memory accounting (separate instances or Cluster shards per tenant), rate-limiting writes, and — for multi-tenant instances — `volatile-*` policies plus TTLs so only cache-like keys are evictable. Renaming `FLUSHALL`/`FLUSHDB` (chapter 29) prevents an accidental or malicious full wipe.
- **Scaling.** When the working set genuinely outgrows one machine's RAM, the answer is horizontal: Redis Cluster shards the keyspace across nodes (`CRC16(key) mod 16384`), so aggregate memory scales with node count and each node runs its own `maxmemory` and policy (chapter 26). Sizing then becomes per-shard, and an uneven key distribution (a hot slot, a big key pinned to one slot) can make one shard hit its ceiling and evict while others sit idle — so balanced key design is a memory-scaling concern, not just a latency one.

## 9. Interview Questions

**Q: What happens if you don't set `maxmemory`, and what happens if you set it but leave the policy at `noeviction`?**
A: With `maxmemory` unset (0, unlimited), Redis keeps allocating as data grows until it exhausts the machine's RAM, at which point the operating system's OOM killer terminates the process — a hard, total, ungraceful failure that takes the whole cache down. With `maxmemory` set but the policy at its default `noeviction`, Redis stops *before* that: once the ceiling is reached, it continues serving reads but rejects every write that needs memory with an `OOM command not allowed` error. That is a database-appropriate behaviour (protect existing data) but wrong for a cache, where it manifests as the cache mysteriously refusing new entries. For a cache you want a ceiling *and* an evicting policy so a full cache degrades into a smaller cache rather than either crashing or freezing writes.

**Q: How is Redis's LRU different from a textbook LRU?**
A: It is approximate, by design. A true LRU maintains a global ordering of all keys by last access, which requires updating a linked list on every access and storing extra per-key pointers — too expensive in memory and CPU for a single-threaded in-memory server. Redis instead samples: when it must evict, it picks `maxmemory-samples` random keys (default 5), reads each one's last-access timestamp from its object header, and evicts the least-recently-used of that sample. With 5 samples the choice is very close to the true LRU key, and raising the sample count to 10 makes it nearly exact at the cost of more CPU per eviction. So it trades a small amount of accuracy for a large saving in memory and time, which is the right trade for a cache.

**Q: How does Redis's LFU work, and why the probabilistic counter?**
A: LFU evicts by access *frequency* rather than recency, which avoids evicting a genuinely hot key just because it went quiet for a moment. Storing an exact count per key would be memory-expensive and would let one old burst dominate forever, so Redis uses an 8-bit counter with two tricks. First, it increments *probabilistically*: the higher the counter, the lower the chance any given access bumps it, governed by `lfu-log-factor`, which makes the counter roughly logarithmic so it can represent "accessed ten times" and "accessed ten thousand times" in one byte without saturating instantly. Second, it *decays*: the counter roughly halves every `lfu-decay-time` minutes of inactivity, so a key that was hot yesterday but cold today loses standing and becomes evictable. The result is a compact, bounded, time-aware frequency estimate that keeps the stable hot set and sheds one-hit wonders.

**Q: When would you choose `volatile-ttl`?**
A: When you set meaningful, deliberate TTLs on your cache entries and want eviction, when it happens, to drop the entries closest to expiring anyway — evicting the soonest-to-expire key wastes the least useful lifetime. It fits a workload where the TTL genuinely encodes value: a key expiring in two seconds is nearly worthless to keep, so evicting it before a key with an hour left is the sensible choice. The caveat is the general `volatile-*` trap: it only considers keys that have a TTL, so if the instance fills and no eligible key has one, it fails writes like `noeviction`. So `volatile-ttl` is right when essentially all your cache keys carry TTLs and you may also hold some persistent, TTL-less keys you want protected from eviction.

**Q: What is the difference between `used_memory` and `used_memory_rss`?**
A: `used_memory` is the number of bytes Redis's allocator has handed out for your data and its overhead — this is what `maxmemory` and eviction decisions are measured against. `used_memory_rss` is the resident set size the operating system sees the process occupying. They differ because when Redis frees memory (a key expires, is deleted, or is evicted), the allocator often keeps those pages for reuse rather than returning them to the OS, so RSS can stay high while `used_memory` drops. Their ratio, `mem_fragmentation_ratio`, quantifies this: around 1.0–1.5 is normal, well above signals fragmentation (real RAM tied up in allocator gaps, addressable with `activedefrag`), and *below* 1.0 is the alarming case — it means Redis has been swapped to disk, which is catastrophic on a single-threaded server because a memory access becomes a blocking disk seek.

**Q: For a pure cache, which policy is the sane default and why?**
A: `allkeys-lru`. In a pure cache every key is a disposable copy of the origin, so any key is a legitimate eviction candidate — which is exactly what `allkeys` means, and why the `volatile-*` restriction (only evict TTL'd keys) is unnecessary and risky here. LRU is a good general victim-selection strategy because caches usually have temporal locality: recently-used keys are likely to be used again, so evicting the least-recently-used is a sound bet, and Redis's sampled approximation makes it cheap. You would switch to `allkeys-lfu` if your access pattern has a stable hot set worth protecting from a momentary lull, but `allkeys-lru` is the default that is right far more often than not.

**Q: What is the working set, and how does it relate to sizing `maxmemory`?**
A: The working set is the subset of keys actually accessed within a given time window — the data the cache genuinely needs to hold to be useful, as opposed to the entire keyspace. The whole premise of a cache is a bet that this working set fits in RAM; if it does, most requests hit and the origin is spared, and if it does not, eviction constantly churns keys the workload still wants (thrashing) and the hit rate collapses. So you size `maxmemory` so the working set fits with headroom — roughly the working set plus about 25% for spikes, fragmentation, and any fork/replication buffers — rather than sizing to the full dataset or guessing. You confirm the sizing empirically: a healthy instance shows a high hit rate and only occasional evictions; a climbing eviction rate together with a falling hit rate is the signal that the ceiling is too low for the working set.

**Q: (Senior) Your cache's hit rate has dropped and `evicted_keys` is climbing steadily, but you recently doubled `maxmemory`. What is going on and how do you approach it?**
A: The pattern — sustained eviction with a falling hit rate despite more memory — says the working set has grown faster than the ceiling, or that something is consuming the new headroom other than the useful hot set, so I would diagnose rather than reflexively add more RAM. First I confirm the eviction is real and ongoing (the *rate* of `evicted_keys`, not the cumulative total) and correlate it with the hit-rate drop; if they move together, the cache is thrashing — evicting keys the workload still wants. Then I ask *why* the working set grew: a new feature caching more key classes, a change that lengthened TTLs so entries linger, a shift in traffic that widened the hot set, or — importantly — big keys or a memory leak eating the headroom I just added (I'd run `--bigkeys`/`MEMORY DOCTOR` and check `used_memory` composition in `MEMORY STATS`, and rule out fragmentation via `mem_fragmentation_ratio`, since a high ratio means the doubled ceiling is partly wasted on allocator gaps). I'd also check the policy is appropriate: if the access pattern actually has a stable hot set, `allkeys-lru` might be evicting hot keys during quiet moments where `allkeys-lfu` would protect them, so switching to LFU (with tuned decay) can raise the hit rate without more memory. The resolution depends on the cause: genuinely larger working set → size up (and verify it fits now); lingering entries → shorten TTLs; big keys → split them; fragmentation → `activedefrag`; wrong victim strategy → change policy. Blindly doubling memory again is the thing to avoid, because if the working set is unbounded (e.g. caching an ever-growing set of unique queries with long TTLs) no amount of RAM fixes it — that needs shorter TTLs or a bounded key design.

**Q: (Senior) Explain how eviction, expiration, and `maxmemory` interact, and why a cache typically uses all three.**
A: They are three distinct mechanisms for three distinct jobs, and a well-run cache uses each for its purpose. Expiration (chapter 6) enforces *staleness bounds*: a TTL guarantees an entry cannot serve stale data past its lifetime, and Redis removes expired keys lazily on access plus actively via a background sample — but crucially, expiration is *eventual*, so a logically-expired key can still occupy memory until it is touched or reaped. That is exactly why expiration alone cannot enforce a memory ceiling. `maxmemory` is the *ceiling*, and eviction is what enforces it *synchronously*: when a write would exceed `maxmemory`, the policy selects and removes victims on the write path, on the single thread, right then, so the ceiling is a hard guarantee where expiration is a soft eventual one. A cache uses all three because they cover different failure modes: TTLs bound how stale any served value can be and act as a safety net for missed invalidations; `maxmemory` caps total footprint so the process never OOMs the box; and the eviction policy decides *which* keys to shed when the cap is hit so the cache degrades to a smaller-but-useful cache rather than crashing or freezing writes. The interaction to watch is that under memory pressure, eviction may remove keys *before* their TTL — so TTLs bound the maximum lifetime and eviction may shorten it, and if eviction is constantly cutting lifetimes short, that is the signal (climbing `evicted_keys`, falling hit rate) that the working set does not fit and the ceiling or the key design needs attention.

**Q: (Senior) How would you tune LFU (`lfu-log-factor`, `lfu-decay-time`) for a workload with a small, very hot set and a large, cold long tail?**
A: This is the workload LFU is built for, so the goal is to make the hot set's counters clearly dominate the tail's and to make the ranking stable over time rather than reactive to momentary recency. `lfu-log-factor` controls how quickly the probabilistic 8-bit counter saturates: a higher factor slows saturation so the counter can *distinguish* a key hit thousands of times from one hit dozens of times, which is exactly what I want when the hot set is very hot — otherwise both the hot keys and the moderately-warm tail keys pile up near the counter's ceiling and become indistinguishable, and eviction can't tell them apart. So I'd raise `lfu-log-factor` above the default (10) if profiling shows hot and warm keys saturating to the same counter value; I'd verify with `OBJECT FREQ key` on sampled hot vs cold keys that their counters are well separated. `lfu-decay-time` controls how fast counters halve during inactivity: with a stable hot set I want a *longer* decay so a hot key that goes quiet for a few minutes (a lull, a deploy, a traffic dip) does not lose its hard-won frequency and get evicted — a short decay would make LFU behave more like LRU and defeat the point. But not so long that yesterday's hot key, now genuinely cold, is protected forever and wastes memory; the decay has to be long enough to ride out normal lulls yet short enough to age out a real shift in the hot set. Concretely I'd start from the defaults, measure the counter distribution across hot and cold keys under real traffic with `OBJECT FREQ`, raise `lfu-log-factor` until the hot set separates cleanly, and set `lfu-decay-time` to comfortably exceed the longest normal quiet period for a hot key (say a few minutes to tens of minutes depending on the workload's rhythm). I'd validate the whole thing by the outcome that matters — the hit rate and whether hot keys survive quiet periods — rather than by the knobs in isolation, and I'd keep `maxmemory-samples` at 5–10 so the sampled selection actually surfaces the low-frequency tail keys as victims.

## 10. Quick Revision & Cheat Sheet

| Policy | Evicts | Use when |
|---|---|---|
| `noeviction` (default) | nothing — writes fail when full | a database, never a pure cache |
| `allkeys-lru` | least-recently-used, any key | **default for a cache** |
| `allkeys-lfu` | least-frequently-used, any key | stable hot set + cold tail |
| `allkeys-random` | a random key | uniform access (rare) |
| `volatile-lru` | LRU among TTL'd keys | mixed persistent + cache |
| `volatile-lfu` | LFU among TTL'd keys | mixed, frequency-driven |
| `volatile-ttl` | soonest-to-expire (TTL'd) | you set meaningful TTLs |
| `volatile-random` | random TTL'd key | mixed, no recency signal |

| Metric | Meaning / alert |
|---|---|
| `used_memory` vs `maxmemory` | approaching the ceiling |
| `evicted_keys` (rate) | sustained eviction = working set doesn't fit |
| hit rate `hits/(hits+misses)` | falling under eviction = thrashing |
| `mem_fragmentation_ratio` | >1.5 fragmented; **<1.0 = swapping (urgent)** |
| `maxmemory-samples` | LRU/LFU accuracy vs CPU (default 5) |

**Flash cards**
- **Default policy trap?** → `noeviction` fails writes when full; a cache wants `allkeys-lru`.
- **Redis LRU is…** → approximate: evicts the LRU of a random sample of `maxmemory-samples`.
- **Redis LFU counter?** → 8-bit, probabilistic increment (`lfu-log-factor`), decays over time (`lfu-decay-time`).
- **`volatile-*` gotcha?** → acts like `noeviction` if no key has a TTL.
- **`used_memory` vs `rss`?** → allocator-given vs OS-resident; ratio <1.0 means swapping.
- **Size `maxmemory` to…** → the working set plus ~25% headroom; watch eviction rate + hit rate.

## 11. Hands-On Exercises & Mini Project

- [ ] Set a tiny `maxmemory` with `noeviction`, fill it, and observe writes failing with an OOM error while reads still work.
- [ ] Switch to `allkeys-lru`, refill, and watch `evicted_keys` climb while writes keep succeeding.
- [ ] Compare `allkeys-lru` vs `allkeys-lfu` on a skewed workload (a hot set plus random cold keys) and measure the hit rate of each.
- [ ] Vary `maxmemory-samples` (5 vs 10) and measure whether eviction quality (hit rate) improves and what it costs in CPU.
- [ ] Create a large key, delete it, and watch `used_memory` drop while `used_memory_rss` lingers; then enable `activedefrag` and observe the ratio recover.
- [ ] Reproduce the `volatile-*` trap: set `volatile-lru`, fill the instance with TTL-less keys, and watch writes fail as if under `noeviction`.

### Mini Project — "Eviction Policy Bake-Off"

**Goal.** Measure how each policy behaves under a realistic skewed workload, so policy choice and ceiling sizing become evidence-based rather than folklore.

**Requirements.**
1. Generate a workload with a small hot set (heavily accessed) and a large cold tail (random one-off keys), configurable in skew.
2. Run it against `allkeys-lru`, `allkeys-lfu`, `allkeys-random`, and `volatile-ttl` (with TTLs), holding `maxmemory` fixed, and record the hit rate and `evicted_keys` for each.
3. Sweep `maxmemory` from below the working set to comfortably above it, and chart the hit rate to find the "knee" where the working set starts to fit.
4. Under LFU, vary `lfu-log-factor` and `lfu-decay-time` and show their effect on whether the hot set survives a simulated quiet period.
5. Instrument `mem_fragmentation_ratio` throughout and demonstrate `activedefrag` recovering fragmented memory after a churn.

**Extensions.**
- Add a "cache-flushing" adversary that writes many cold keys and show how it evicts the victim's hot data under `allkeys-*`, then mitigate with `volatile-*` + TTLs.
- Simulate a shifting hot set (the hot keys change over time) and compare how fast LRU vs LFU (with different decay) adapt.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Keys, TTL & Expiration Semantics* (expiration vs eviction, and why both), *Redis as a Cache* (the single thread eviction runs on), *Redis Data Types & Which to Cache With* (big keys and encodings that shape memory), *Running Redis: redis-cli, Go & Python Clients* (the `redis.conf` where these settings live), *Cache Avalanche, Stampede & Penetration* (eviction-driven misses and stampedes), *Redis Cluster & Sharding* (scaling memory horizontally).

- **Redis — Key eviction & the maxmemory policies** — Redis · *Intermediate* · the authoritative reference for all eight policies, the sampling approximation, and the LFU tuning knobs this chapter explains. <https://redis.io/docs/latest/develop/reference/eviction/>
- **Redis — Memory optimization** — Redis · *Intermediate* · how encodings, overhead, and big keys drive `used_memory`, and how to shrink it. <https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/memory-optimization/>
- **Redis — Config: maxmemory & maxmemory-policy** — Redis · *Beginner* · the annotated directives and their defaults, the basis of the §5 config block. <https://redis.io/docs/latest/operate/oss_and_stack/management/config/>
- **antirez — "Random notes on improving the Redis LRU algorithm"** — Salvatore Sanfilippo · *Advanced* · the creator's own explanation of approximate LRU, sampling, and the move to LFU, with the reasoning behind the design. <http://antirez.com/news/109>
- **Redis — INFO command (memory & stats sections)** — Redis · *Intermediate* · every field this chapter alerts on (`used_memory`, `used_memory_rss`, `evicted_keys`, `mem_fragmentation_ratio`). <https://redis.io/docs/latest/commands/info/>
- **Redis — Defragmentation (activedefrag)** — Redis · *Advanced* · how online defragmentation works and when to enable it, for the fragmentation section. <https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/memory-optimization/>
- **Caching at Scale with Redis** — Redis (ebook) · *Intermediate* · working-set sizing, eviction, and capacity planning for production caches. <https://redis.io/docs/latest/develop/use/patterns/>
- **Redis University — RU101** — Redis · *Beginner* · a free course covering memory management and eviction with hands-on labs. <https://university.redis.com/>

---

*Caching with Redis Handbook — chapter 07.*
