# 01 · What Is Caching? The Cost Model & When to Cache

> **In one line:** A cache is a small, fast copy of data kept close to where it is used, and the only honest reason to add one is that a specific, measured access pattern makes the copy cheaper to serve than the original — everything else in caching is managing the lie that the copy tells.

---

## 1. Overview

Caching is the single highest-leverage performance technique in most systems, and also the one that introduces the most subtle bugs. Both facts come from the same source: a cache holds a *copy* of data that lives authoritatively somewhere else, and the moment the original changes, the copy is a lie. Everything hard about caching — invalidation, consistency, stampedes — is the work of managing that lie. Everything easy about it — the 100× latency drop, the order-of-magnitude load reduction on a database — is the reward for accepting it.

The word "cache" comes from the French *cacher*, to hide, and that is exactly what a cache does: it hides the cost of fetching data from its true source. A CPU's L1 cache hides main-memory latency. A CDN hides the origin server. A Redis cache hides a database query, an API call, or an expensive computation. In every case the structure is the same — a fast, small, nearby store in front of a slow, large, distant one — and so is the fundamental trade: you spend memory and accept staleness to buy latency and throughput.

This handbook is about **application-level distributed caching with Redis**, but this first chapter deliberately stays above Redis. Before you choose a cache technology, you need the *cost model*: the arithmetic that tells you whether a cache will help at all, and by how much. Most caches that cause more trouble than they are worth were added without that arithmetic — someone assumed caching is always good, added it reflexively, and inherited invalidation bugs to solve a latency problem that did not exist.

The discipline this chapter teaches is to **treat a cache as a hypothesis with a measurable payoff**, not a default. A cache is justified when the data is read far more often than it changes, when the source is genuinely expensive, and when some staleness is tolerable. When any of those three is false, a cache is at best pointless and at worst a new class of bug.

## 2. Core Concepts

- **Cache** — a fast store holding copies of data whose authoritative version (the *source of truth* or *origin*) lives elsewhere.
- **Cache hit** — a request served from the cache. Fast, cheap, and the reason the cache exists.
- **Cache miss** — a request the cache cannot serve, requiring a fetch from the origin. The cost you are trying to reduce the *frequency* of.
- **Hit ratio** — hits ÷ total requests. The single most important cache metric; a low one means the cache is not earning its keep.
- **Origin / backing store** — the authoritative source: a database, an API, a filesystem, or a computation.
- **Population (warming)** — how entries get into the cache: lazily on a miss, or eagerly (pre-warming).
- **Eviction** — removing an entry to make room, driven by a policy (LRU, LFU) when the cache is full.
- **Expiration (TTL)** — an entry's maximum lifetime, after which it is treated as absent regardless of space.
- **Staleness** — the gap between the cached copy and the current origin value. The cost you pay for the speed.
- **Working set** — the subset of data actually accessed in a given window. A cache only needs to hold *this*, not everything.
- **Locality** — the tendency of accesses to cluster: *temporal* (recently used data is used again soon) and *spatial* (nearby data is used together). Caches work because real workloads have locality.

## 3. Theory & Principles

### The cost model: average latency

The reason to cache is captured in one equation. If a hit costs `T_hit`, a miss costs `T_miss` (which includes the origin fetch *and* usually the cost of writing to the cache), and the hit ratio is `h`, then the average request latency is:

```
T_avg = h · T_hit + (1 − h) · T_miss
```

Plug in realistic numbers. A Redis hit over the network is ~0.5 ms. A database query is ~50 ms. With no cache, every request costs 50 ms. With a 90% hit ratio:

```
T_avg = 0.90 · 0.5 ms + 0.10 · 50 ms = 0.45 + 5.0 = 5.45 ms
```

A 9× improvement. But the shape of this curve is the lesson. At 99% hit ratio it is 0.995 ms — an 50× improvement. At 50% hit ratio it is 25.25 ms — barely 2×. **The value of a cache is dominated by the hit ratio, and the hit ratio is dominated by the workload, not the cache technology.** A faster cache lowers `T_hit`, but `T_hit` is already tiny; you cannot buy your way to a good cache by choosing faster hardware if your access pattern produces a 40% hit ratio.

The second, subtler point: the miss is *more* expensive than the un-cached request, because a miss usually pays the origin cost *plus* the cost of populating the cache. A cache with a very low hit ratio can make a system slower than no cache at all.

### The three questions that justify a cache

Before adding a cache, answer three questions honestly:

1. **Is it read-heavy?** A cache amortises the cost of a fetch across many reads. If data is read once per write, there is nothing to amortise — the entry is populated and then changes before it is read again. The read-to-write ratio is the first gate.
2. **Is the origin genuinely expensive?** Caching a 50 ms query is worth it. Caching a 0.3 ms primary-key lookup on an indexed column is not — the cache adds a network hop and a consistency problem to save nothing. Measure the origin cost; do not assume it.
3. **Is staleness tolerable?** Every cache serves data that may be out of date. If the domain cannot tolerate *any* staleness — a bank balance at the moment of a transaction, a stock trade — then a cache either must be invalidated synchronously (expensive, and often defeats the point) or must not be used. Most data tolerates *some* staleness; the question is how much, and for how long.

If all three are "yes", cache. If any is "no", the cache is probably a mistake, and the honest move is to fix the origin (add an index, denormalise, precompute) rather than paper over it.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="c1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#4f46e5"/></marker>
  </defs>
  <text x="440" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The value of a cache is the hit ratio &#8212; not the technology</text>

  <rect x="30" y="44" width="500" height="220" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="280" y="66" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">T_avg = h &#183; T_hit + (1&#8722;h) &#183; T_miss</text>
  <text x="280" y="84" text-anchor="middle" fill="#64748b" font-size="10">T_hit = 0.5 ms &#183; T_miss = 50 ms</text>

  <line x1="80" y1="240" x2="500" y2="240" stroke="#94a3b8" stroke-width="1.5"/>
  <line x1="80" y1="240" x2="80" y2="104" stroke="#94a3b8" stroke-width="1.5"/>
  <text x="70" y="110" text-anchor="end" fill="#64748b" font-size="9">50ms</text>
  <text x="70" y="240" text-anchor="end" fill="#64748b" font-size="9">0</text>
  <text x="290" y="258" text-anchor="middle" fill="#64748b" font-size="9">hit ratio &#8594;</text>

  <path d="M80,104 L164,172 L248,213 L332,227 L416,235 L500,240" stroke="#4f46e5" stroke-width="2.5" fill="none"/>
  <circle cx="332" cy="227" r="4" fill="#dc2626"/>
  <text x="332" y="220" text-anchor="middle" fill="#b91c1c" font-size="9" font-weight="bold">50% &#8594; 25ms (2&#215;)</text>
  <circle cx="416" cy="235" r="4" fill="#d97706"/>
  <text x="416" y="228" text-anchor="middle" fill="#b45309" font-size="9" font-weight="bold">90% &#8594; 5.5ms (9&#215;)</text>
  <circle cx="490" cy="239" r="4" fill="#16a34a"/>
  <text x="480" y="232" text-anchor="middle" fill="#15803d" font-size="9" font-weight="bold">99% &#8594; 1ms (50&#215;)</text>
  <text x="90" y="130" fill="#7f1d1d" font-size="9">a low hit ratio barely helps &#8212;</text>
  <text x="90" y="144" fill="#7f1d1d" font-size="9">and a miss costs MORE than no cache</text>
  <text x="90" y="158" fill="#991b1b" font-size="9">(origin fetch + cache write)</text>

  <rect x="548" y="44" width="304" height="220" rx="10" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="700" y="66" text-anchor="middle" fill="#3730a3" font-size="12" font-weight="bold">The three gates &#8212; all must be YES</text>
  <text x="564" y="94" fill="#4338ca" font-size="11" font-weight="bold">1. Read-heavy?</text>
  <text x="564" y="110" fill="#4338ca" font-size="10">read-to-write ratio high enough to amortise</text>
  <text x="564" y="140" fill="#4338ca" font-size="11" font-weight="bold">2. Origin genuinely expensive?</text>
  <text x="564" y="156" fill="#4338ca" font-size="10">50 ms query yes; 0.3 ms PK lookup no</text>
  <text x="564" y="186" fill="#4338ca" font-size="11" font-weight="bold">3. Staleness tolerable?</text>
  <text x="564" y="202" fill="#4338ca" font-size="10">how stale, for how long &#8212; measure it</text>
  <text x="564" y="234" fill="#3730a3" font-size="10" font-weight="bold">Any "no" &#8594; fix the origin instead:</text>
  <text x="564" y="250" fill="#4338ca" font-size="10">add an index, denormalise, precompute.</text>

  <rect x="30" y="280" width="822" height="176" rx="10" fill="#fefce8" stroke="#ca8a04" stroke-width="2"/>
  <text x="441" y="302" text-anchor="middle" fill="#854d0e" font-size="12" font-weight="bold">Why a cache works at all: the working set is small</text>
  <text x="48" y="326" fill="#713f12">Real workloads have LOCALITY. Accesses cluster in time (recently used &#8594; used again) and follow a power law:</text>
  <text x="48" y="344" fill="#713f12">a small fraction of keys serves most requests. So a cache holding a few GB can front a database holding terabytes.</text>

  <rect x="60" y="360" width="360" height="80" rx="6" fill="#fff" stroke="#ca8a04"/>
  <text x="240" y="380" text-anchor="middle" fill="#854d0e" font-size="10" font-weight="bold">Zipfian access (typical)</text>
  <rect x="76" y="392" width="40" height="36" fill="#ca8a04"/><rect x="120" y="404" width="40" height="24" fill="#eab308"/>
  <rect x="164" y="412" width="40" height="16" fill="#facc15"/><rect x="208" y="416" width="40" height="12" fill="#fde047"/>
  <rect x="252" y="419" width="40" height="9" fill="#fef08a"/><rect x="296" y="421" width="40" height="7" fill="#fef9c3"/>
  <rect x="340" y="422" width="60" height="6" fill="#fefce8" stroke="#eab308"/>
  <text x="240" y="440" text-anchor="middle" fill="#713f12" font-size="8">top 20% of keys &#8594; ~80% of hits &#8212; cache THOSE</text>

  <rect x="452" y="360" width="380" height="80" rx="6" fill="#fff" stroke="#ca8a04"/>
  <text x="642" y="380" text-anchor="middle" fill="#854d0e" font-size="10" font-weight="bold">The consequence</text>
  <text x="468" y="400" fill="#713f12" font-size="10">You do not cache the whole dataset. You cache the</text>
  <text x="468" y="416" fill="#713f12" font-size="10">WORKING SET &#8212; the hot subset a real workload touches.</text>
  <text x="468" y="432" fill="#713f12" font-size="10">Uniform-random access has no locality &#8594; caching fails.</text>
</svg>
```

### Why caches work: locality and the working set

A cache would be useless if every key were equally likely to be requested, because then holding a small fraction of keys would only serve a small fraction of requests. Caches work because **real workloads are not uniform** — they exhibit locality, and access frequencies typically follow a power law (Zipfian): a small fraction of keys accounts for a large fraction of requests. The top 20% of keys might serve 80% of traffic; the top 1% might serve 50%.

This is why a cache holding a few gigabytes can front a database holding terabytes: it does not need to hold everything, only the *working set* — the hot subset actually being accessed. The corollary is a warning: if your workload genuinely *is* uniform-random over a huge keyspace (some analytics scans, some security lookups), there is no working set to hold, and a cache will churn without ever building a useful hit ratio. Diagnosing "no locality" early saves you from a cache that never works.

## 4. Architecture & Workflow

The lifecycle of a cached request, and the decisions at each branch:

1. **Request arrives** for some key. The application first asks the cache.
2. **Hit** → return the cached value immediately. This is the fast path, and in a healthy cache it is the overwhelming majority of requests.
3. **Miss** → fetch from the origin (the slow path). Now three sub-decisions: how to fetch, whether to populate the cache, and with what TTL.
4. **Populate** → write the fetched value into the cache, usually with a TTL so it cannot live forever without validation.
5. **Return** the value to the caller.
6. **On a write to the origin** → the cached copy is now potentially stale. Either invalidate it (delete or update) or let its TTL expire. This is the hard half (chapters 8–14).
7. **Under memory pressure** → the cache evicts entries by policy to stay within its size budget (chapter 7).

```svg
<svg viewBox="0 0 880 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="w1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
    <marker id="w2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The two paths of a cached request</text>

  <rect x="30" y="46" width="130" height="50" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="95" y="68" text-anchor="middle" fill="#3730a3" font-size="11" font-weight="bold">request</text>
  <text x="95" y="86" text-anchor="middle" fill="#4338ca" font-size="10">for key K</text>

  <path d="M162,71 L216,71" stroke="#334155" stroke-width="2" marker-end="url(#w1)"/>

  <rect x="220" y="42" width="150" height="58" rx="8" fill="#f1f5f9" stroke="#64748b" stroke-width="2"/>
  <text x="295" y="66" text-anchor="middle" fill="#334155" font-size="11" font-weight="bold">ask the cache</text>
  <text x="295" y="86" text-anchor="middle" fill="#64748b" font-size="10">is K present?</text>

  <path d="M372,60 L470,54" stroke="#16a34a" stroke-width="2.5" marker-end="url(#w1)"/>
  <text x="420" y="44" fill="#15803d" font-size="10" font-weight="bold">HIT (~99%)</text>
  <rect x="474" y="40" width="180" height="40" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="564" y="65" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">return value &#8212; ~0.5 ms</text>

  <path d="M372,84 L470,110" stroke="#dc2626" stroke-width="2.5" marker-end="url(#w2)"/>
  <text x="415" y="112" fill="#b91c1c" font-size="10" font-weight="bold">MISS</text>
  <rect x="474" y="96" width="180" height="40" rx="8" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="564" y="121" text-anchor="middle" fill="#b91c1c" font-size="11" font-weight="bold">fetch from origin &#8212; ~50 ms</text>

  <path d="M656,116 L710,116" stroke="#dc2626" stroke-width="2" marker-end="url(#w2)"/>
  <rect x="714" y="96" width="140" height="40" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="784" y="115" text-anchor="middle" fill="#92400e" font-size="10" font-weight="bold">populate cache</text>
  <text x="784" y="129" text-anchor="middle" fill="#b45309" font-size="9">+ TTL, then return</text>

  <rect x="30" y="176" width="822" height="140" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="441" y="198" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Two properties that recur throughout the handbook</text>
  <rect x="52" y="212" width="380" height="88" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="242" y="232" text-anchor="middle" fill="#1e40af" font-size="11" font-weight="bold">Read path vs write path are asymmetric</text>
  <text x="66" y="254" fill="#1d4ed8" font-size="10">Reads are simple: hit, or fetch-and-populate.</text>
  <text x="66" y="272" fill="#1d4ed8" font-size="10">Writes are where ALL the consistency difficulty</text>
  <text x="66" y="288" fill="#1d4ed8" font-size="10">lives &#8212; invalidation (chapters 8&#8211;14).</text>

  <rect x="452" y="212" width="380" height="88" rx="6" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="642" y="232" text-anchor="middle" fill="#5b21b6" font-size="11" font-weight="bold">Every entry has two clocks</text>
  <text x="466" y="254" fill="#6d28d9" font-size="10">TTL &#8594; how long until it is considered STALE.</text>
  <text x="466" y="272" fill="#6d28d9" font-size="10">Last-access &#8594; drives EVICTION under pressure.</text>
  <text x="466" y="288" fill="#6d28d9" font-size="10">Confusing them is a classic bug: evicted-while-fresh,</text>
  <text x="466" y="304" fill="#6d28d9" font-size="10">or expired-while-hot.</text>
</svg>
```

Two properties of this workflow deserve naming now, because they recur throughout the handbook. First, the **read path and the write path are asymmetric**: reads are simple (hit or fetch-and-populate), writes are where all the consistency difficulty lives. Second, **every entry has two clocks**: a TTL (how long until it is considered stale) and a last-access time (which drives eviction). Confusing these two is a common source of bugs — an entry can be evicted while still fresh, or expire while still hot.

## 5. Implementation

Before touching Redis, it is worth measuring whether a cache helps at all. Here is a small harness that measures hit ratio and the resulting average latency for a given workload, so the decision to cache is evidence rather than assumption.

```go
package cacheanalysis

import (
	"math"
	"sort"
	"time"
)

// AccessLog is a sequence of key accesses observed from production traffic.
// The point of analysing it BEFORE building a cache is to answer the three
// gates from §3 with numbers rather than hope.
type AccessLog []string

// Stats summarises whether a cache is worth building for this workload.
type Stats struct {
	TotalAccesses  int
	UniqueKeys     int
	// HitRatioAt reports the achievable hit ratio for a cache holding the top
	// N keys — the answer to "how big must the cache be, and is it worth it?"
	HitRatioAt     map[int]float64
	// Top1PctShare is the fraction of all requests served by the hottest 1% of
	// keys. A high value means strong locality and a cache will work well.
	Top1PctShare   float64
}

// Analyze computes the cache-relevant properties of a workload. Run this on a
// real access log before deciding to cache anything.
func Analyze(log AccessLog, cacheSizes []int) Stats {
	freq := make(map[string]int)
	for _, k := range log {
		freq[k]++
	}

	// Rank keys by access frequency (Zipfian workloads have a steep head).
	type kf struct {
		key   string
		count int
	}
	ranked := make([]kf, 0, len(freq))
	for k, c := range freq {
		ranked = append(ranked, kf{k, c})
	}
	sort.Slice(ranked, func(i, j int) bool { return ranked[i].count > ranked[j].count })

	total := len(log)
	stats := Stats{
		TotalAccesses: total,
		UniqueKeys:    len(freq),
		HitRatioAt:    make(map[int]float64),
	}

	// For each candidate cache size, what fraction of requests would hit?
	// This is the whole decision: if caching the top 10k keys only yields a
	// 40% hit ratio, the cache is barely worth it (see the T_avg curve).
	for _, size := range cacheSizes {
		hits := 0
		for i := 0; i < size && i < len(ranked); i++ {
			hits += ranked[i].count
		}
		stats.HitRatioAt[size] = float64(hits) / float64(total)
	}

	// Locality check: share of traffic served by the hottest 1% of keys.
	// Near 0 means uniform access and NO working set to cache.
	onePct := int(math.Ceil(float64(len(ranked)) * 0.01))
	hot := 0
	for i := 0; i < onePct && i < len(ranked); i++ {
		hot += ranked[i].count
	}
	stats.Top1PctShare = float64(hot) / float64(total)

	return stats
}

// AverageLatency applies the cost model from §3, so the payoff of a proposed
// cache is a concrete number rather than a vibe.
func AverageLatency(hitRatio float64, tHit, tMiss time.Duration) time.Duration {
	avg := hitRatio*float64(tHit) + (1-hitRatio)*float64(tMiss)
	return time.Duration(avg)
}

// ShouldCache applies the three gates. It returns a recommendation and the
// reasoning, so "we decided not to cache" is a defensible, recorded choice.
func ShouldCache(readWriteRatio float64, originCost time.Duration, achievableHitRatio float64) (bool, string) {
	switch {
	case readWriteRatio < 2:
		return false, "not read-heavy: too few reads per write to amortise population"
	case originCost < 1*time.Millisecond:
		return false, "origin is already cheap: a network hop to the cache would add latency, not remove it"
	case achievableHitRatio < 0.5:
		return false, "no working set: achievable hit ratio too low; fix the origin instead (index, denormalise, precompute)"
	default:
		return true, "read-heavy, expensive origin, strong locality: cache justified"
	}
}
```

Running this on a real access log turns "should we cache?" into a decision backed by the hit-ratio curve and the locality measurement — which is exactly the discipline the rest of this handbook depends on.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Latency collapse.** A hit is typically 10–100× faster than the origin fetch it replaces, and the win compounds at high hit ratios.
- **Load shedding.** Every hit is a request the origin never sees. A 90% hit ratio means the database handles a tenth of the traffic, which often turns "we need a bigger database" into "we don't".
- **Cost.** RAM to serve a hot read is far cheaper than the database capacity to serve the same read from disk, at scale.
- **Absorbing spikes.** A cache flattens read spikes that would otherwise overwhelm the origin, buying time for the origin to keep up.

**Disadvantages**
- **Staleness.** The cache serves copies, and copies go out of date. Every cache is a deliberate choice to sometimes serve wrong data.
- **A new failure mode.** The cache itself can fail, and a cache failure often means every request falls through to an origin sized for cached traffic — potentially taking the whole system down (chapter 17).
- **Consistency complexity.** Invalidation is genuinely hard (chapters 12–14), and a subtle invalidation bug can be far worse than the latency it was meant to fix.
- **Debugging difficulty.** "It works, but sometimes returns old data" is a miserable bug class that caches introduce.

**Trade-offs**
- *Latency vs freshness:* a longer TTL raises the hit ratio and lowers latency, at the cost of serving staler data. This dial is set per data type, from its tolerance for staleness.
- *Memory vs hit ratio:* a bigger cache holds more of the working set and hits more, at the cost of RAM. The hit-ratio-versus-size curve (from §5) tells you where the knee is.
- *Simplicity vs consistency:* TTL-only expiration is simple and eventually consistent; explicit invalidation is precise and complex. Most systems should start with TTLs and add invalidation only where the staleness window is genuinely too long.

## 7. Common Mistakes & Best Practices

- **Caching reflexively.** Adding a cache without measuring the origin cost or the read/write ratio. Run the analysis first; a cache that saves nothing costs consistency bugs for free.
- **Caching cheap reads.** Putting a network hop in front of a 0.3 ms indexed lookup. The cache is slower than the thing it caches.
- **Ignoring the hit ratio.** Deploying a cache and never measuring whether it hits. A 40% hit ratio is a cache that is barely helping and fully paying the consistency cost.
- **Assuming locality.** Caching a uniform-random workload that has no working set, so the cache churns and never builds a useful hit ratio.
- **Forgetting the miss is more expensive.** A low-hit-ratio cache can make the system *slower* than no cache, because each miss pays the origin cost plus the population cost.
- **No TTL.** Caching without expiration, so a stale entry can live indefinitely if invalidation ever fails. Always give entries a maximum lifetime as a safety net.
- **Best practice: measure, then cache.** Instrument the origin, estimate the working set, compute the achievable hit ratio, and only then decide. Record the decision, including "we chose not to cache and here is why".

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** The two questions that diagnose most cache problems: *what is the hit ratio?* and *what is the p99 latency of a miss?* A falling hit ratio explains rising latency; a slow miss path explains why misses hurt. Both must be instrumented from day one, not added after an incident.
- **Monitoring.** Track hit ratio, request rate, and the latency distribution of hits and misses *separately* — a blended average hides the story. Alert on hit ratio dropping below a workload-specific floor, because that is the earliest sign a cache has stopped earning its keep (a bad deploy, a key-schema change, or a working-set shift).
- **Security.** A cache is a copy of data, so it inherits the data's sensitivity. Cached personal or financial data is subject to the same access controls, encryption and retention rules as the origin — a common oversight is treating the cache as "just a performance layer" and skipping the controls the origin has.
- **Scaling.** The cache scales the *read* path; it does nothing for writes, and it makes the origin's write path slightly worse (invalidation traffic). When a system scales, the cache's job is to keep the origin's read load flat as request volume grows — so the metric that matters is origin reads per second, which should stay roughly constant even as user traffic climbs.

## 9. Interview Questions

**Q: What is caching, in one sentence, and what is the fundamental trade-off?**
A: Caching keeps a fast, nearby copy of data whose authoritative version lives elsewhere, so that reads can be served without paying the full cost of fetching from the origin. The fundamental trade-off is latency and load versus freshness and complexity: you buy a large latency and throughput improvement by accepting that the copy may be stale and that you now own the hard problem of keeping it consistent enough.

**Q: How do you decide whether to add a cache?**
A: Three gates, all measured rather than assumed. Is it read-heavy — is the read-to-write ratio high enough that amortising a fetch across many reads pays off? Is the origin genuinely expensive — caching a 50 ms query is worth it, caching a 0.3 ms indexed lookup adds a network hop to save nothing? And is staleness tolerable — can the domain accept data that may be out of date for the length of the staleness window? If any gate is no, the honest fix is usually to improve the origin, not to add a cache.

**Q: Why does the hit ratio matter more than the cache's speed?**
A: Because of the cost model. Average latency is `h·T_hit + (1−h)·T_miss`, and `T_hit` is already tiny — half a millisecond — so making it faster barely moves the average. The average is dominated by how often you *miss*, which is `1−h`. A cache at 99% hit ratio gives a 50× improvement; the same cache at 50% gives barely 2×. And the hit ratio is set by the workload's locality, not by the cache technology, so a faster cache cannot rescue a bad access pattern.

**Q: Why can a cache make a system slower?**
A: Because a miss costs *more* than an un-cached request. A miss pays the origin fetch and then also pays to populate the cache, plus the network hop to check the cache in the first place. If the hit ratio is low enough, the average request pays the miss cost most of the time, and the extra work of maintaining the cache is pure overhead. This is why a cache on a workload with no working set — uniform-random access — is worse than no cache at all.

**Q: What is a working set and why does it determine whether caching works?**
A: The working set is the subset of data actually accessed in a given time window. Caches work because real workloads have locality: accesses cluster, and frequencies follow a power law, so a small fraction of keys serves most requests. A cache only has to hold the working set — the hot subset — not the whole dataset, which is why a few gigabytes of cache can front terabytes of database. If a workload has no working set, because access is uniform-random over a huge keyspace, there is nothing hot to hold and the cache churns without building a hit ratio.

**Q: (Senior) How would you size a cache?**
A: Empirically, from the hit-ratio-versus-size curve. I take a real access log, rank keys by frequency, and compute what fraction of requests a cache holding the top N keys would serve, for a range of N. That curve almost always has a knee — a point past which doubling the cache size barely improves the hit ratio because you are now caching cold keys — and I size at or just past the knee. I would validate against the cost model: the marginal RAM to move from, say, 90% to 95% hit ratio has to be worth the latency it buys, and often the last few percent are not. I would also add headroom for working-set growth and for the memory overhead Redis adds per key, and I would leave the eviction policy to reclaim the tail rather than sizing to hold everything.

**Q: (Senior) A team wants to cache everything to "make it fast". How do you respond?**
A: I would push back with the cost model and the three gates, because "cache everything" almost always caches things that fail at least one gate. Cheap reads gain nothing and inherit a consistency bug. Write-heavy data gets populated and invalidated before it is ever read again, so the cache does work without payoff. Data with no locality churns. And every cached entry is a copy that can go stale, so "cache everything" is really "introduce a staleness and invalidation problem everywhere". I would instead identify the specific expensive, read-heavy, staleness-tolerant reads — usually a handful — cache exactly those, measure the hit ratio, and treat the rest by improving the origin. The goal is not maximum caching; it is maximum payoff per unit of consistency risk taken on.

**Q: (Senior) How do you reason about the staleness a cache introduces?**
A: I quantify the *staleness window* — the maximum time a stale value can be served — and check it against the domain's tolerance, per data type. With TTL-only expiration, the window is bounded by the TTL: an entry can be at most one TTL old. With explicit invalidation, the window is bounded by the propagation delay of the invalidation, plus the failure case where invalidation is lost, which is why a TTL should back invalidation as a safety net. Different data has wildly different tolerance: a product description can be minutes stale, a price should be seconds, an inventory count near a checkout may need to be read from the origin entirely. The design output is a per-data-type staleness budget, which then sets the TTL and decides whether TTL alone suffices or explicit invalidation is required.

## 10. Quick Revision & Cheat Sheet

| Concept | Definition |
|---|---|
| Cache | Fast nearby copy of data whose truth lives elsewhere |
| Hit / miss | Request served from cache / requiring an origin fetch |
| Hit ratio `h` | hits ÷ total; the metric that dominates the payoff |
| Cost model | `T_avg = h·T_hit + (1−h)·T_miss` |
| Working set | The hot subset a workload actually accesses |
| Locality | Why caches work: accesses cluster (temporal + Zipfian) |
| Staleness | The gap between the copy and the origin; the price of speed |
| TTL | Maximum entry lifetime; a safety net under invalidation |

**The three gates — cache only if all yes**
1. **Read-heavy** — high read-to-write ratio to amortise population.
2. **Expensive origin** — the fetch is genuinely slow (≥ ~1 ms of real work).
3. **Staleness tolerable** — the domain can accept the staleness window.

**Flash cards**
- **What dominates cache value?** → The hit ratio, which is set by the workload's locality — not the cache's speed.
- **Why can a cache be slower than none?** → A miss costs the origin fetch *plus* population; a low hit ratio pays that most of the time.
- **What must you hold in the cache?** → The working set (the hot subset), not the whole dataset.
- **What makes caching fail?** → No locality (uniform-random access) — there is no working set to hold.
- **What is the safety net under any invalidation scheme?** → A TTL, so a lost invalidation cannot make an entry stale forever.
- **First step before caching?** → Measure: origin cost, read/write ratio, and achievable hit ratio.

## 11. Hands-On Exercises & Mini Project

- [ ] Take a real access log (or generate a Zipfian one) and compute the hit-ratio-versus-cache-size curve. Find the knee.
- [ ] Using the cost model, compute `T_avg` at 50%, 90%, 95% and 99% hit ratios for your own `T_hit`/`T_miss`. Note where the marginal improvement stops being worth it.
- [ ] For three data types in a system you know, work the three gates and record a cache/don't-cache decision with reasoning for each.
- [ ] Instrument one endpoint to measure hit ratio and separate hit/miss latencies. Confirm the blended average hides the real story.
- [ ] Find one thing currently cached that fails a gate (a cheap read, write-heavy data, or no locality) and argue for removing the cache.
- [ ] Estimate the staleness budget for one data type and translate it into a concrete TTL.

### Mini Project — "Cache Justification Report"

**Goal.** Produce the artefact that should precede any cache: a data-driven decision for a real workload, so the cache is a hypothesis with a measured payoff rather than a reflex.

**Requirements.**
1. Capture (or realistically simulate) an access log for a real read path, with per-key frequencies over a representative window.
2. Compute the hit-ratio-versus-size curve, identify the knee, and recommend a cache size.
3. Measure the actual origin cost (`T_miss`) and the expected cache hit cost (`T_hit`), and apply the cost model to project `T_avg` at the recommended size.
4. Measure locality (the hottest-1% share) and state explicitly whether a working set exists.
5. Run the three gates and produce a recommendation: cache (with size and TTL) or do not cache (with the origin fix to make instead).
6. State the staleness budget for the data and the TTL it implies.

**Extensions.**
- Repeat the analysis for a workload with no locality and show the cache failing to build a hit ratio.
- Model a cache failure: compute the origin load if the cache disappears and the hit traffic falls through, and decide whether the origin is sized to survive it.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Where Caches Live* (the tiers this analysis applies to), *Redis as a Cache* (the technology this handbook uses), *Memory, maxmemory & Eviction* (sizing and the eviction that reclaims the tail), *Design: Cache-Aside* (the pattern most reads use), *Consistency Models* (reasoning about the staleness this chapter introduces).

- **Redis — Introduction & Use cases** — Redis · *Beginner* · what Redis is and the caching problems it is used for; the natural next read after this cost model. <https://redis.io/docs/latest/develop/get-started/>
- **AWS — Caching Overview & Strategies** — Amazon · *Beginner* · the cost model and the read/write patterns, from a cloud-provider perspective; a good cross-check on the three gates. <https://aws.amazon.com/caching/>
- **Designing Data-Intensive Applications, ch. 1 & 11** — Martin Kleppmann · *Advanced* · latency, load and the systems-level reasoning behind why and where to cache; the reference for the cost model. <https://dataintensive.net/>
- **MDN — HTTP caching** — Mozilla · *Beginner* · the browser and CDN tiers, and how HTTP formalises freshness and staleness — the same ideas one layer up. <https://developer.mozilla.org/en-US/docs/Web/HTTP/Caching>
- **The Zipf, Power-law, Pareto tutorial** — Lada Adamic · *Intermediate* · why access frequencies follow a power law, which is exactly why caches work. <https://www.hpl.hp.com/research/idl/papers/ranking/ranking.html>
- **Facebook — Scaling Memcache at Facebook** — Nishtala et al., NSDI 2013 · *Advanced* · the canonical paper on caching at scale, including the cost model, working set and failure reasoning in production. <https://www.usenix.org/system/files/conference/nsdi13/nsdi13-final170_update.pdf>
- **Redis University — RU101: Introduction to Redis Data Structures** — Redis · *Beginner* · a free course covering the fundamentals this handbook builds on. <https://university.redis.com/>
- **Caching at Reddit** — Reddit Engineering · *Intermediate* · a real-world account of what caching bought and cost, useful for calibrating expectations. <https://www.redditinc.com/blog>

---

*Caching with Redis Handbook — chapter 01.*
