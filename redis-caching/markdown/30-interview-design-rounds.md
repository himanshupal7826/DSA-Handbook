# 30 · Design: Caching Interview Questions & System Design Rounds

> **In one line:** A caching design round is not a memory test — it is a demonstration that you can turn a vague workload into a defensible set of decisions, name the two or three choices that are irreversible, and defend the hard parts (stampede, invalidation, consistency under failure) out loud before the interviewer has to ask.

---

## 1. Overview

This is the synthesis chapter. Every earlier chapter gave you a tool — cache-aside, TTLs, eviction, stampede protection, sorted sets, Cluster, observability, hardening — and a design round is where you assemble them under time pressure into a coherent system while explaining *why* at each step. The difference between a mid-level and a senior answer is rarely knowledge of the tools; it is the *procedure* by which they are chosen, the awareness of which decisions cannot be undone, and the instinct to defend the failure modes before being pushed.

There is a repeatable procedure, and following it visibly is most of the score. You clarify the workload before designing anything (read/write ratio, scale, SLO, staleness tolerance). You decide *what* to cache and the *key schema*. You pick the *pattern* (usually cache-aside). You choose *TTL and invalidation*. You *size memory* and pick an eviction policy. You *protect against* the four failure modes — stampede, penetration, avalanche, hot key. You pick a *topology* (standalone, Sentinel, Cluster). You reason about *consistency under failure*. And you say how you would *observe* it. An interviewer who sees you move through those steps deliberately, flagging trade-offs, has already decided you can do the job.

This chapter gives you that procedure, names the handful of *irreversible* decisions that deserve extra care, works three complete designs end to end (a product-catalog cache, a rate-limiter/session store, and a social-feed cache) each defending its hard parts, and closes with a large question bank organised by level — mechanics, judgement, consequence — with pointers back to the chapters that go deep. Read section 9 as the main event.

One framing worth internalising before the room: a caching design round is deliberately *under-specified*. The interviewer hands you a one-sentence prompt ("design a cache for a news site") precisely so they can watch you impose structure on ambiguity. The candidates who struggle treat the vagueness as a gap to be filled with a bigger design; the candidates who pass treat it as an invitation to ask the three or four questions that collapse the space of reasonable designs down to one. Every clarifying question you ask is a signal that you know which facts matter, and every assumption you state out loud ("I'll assume reads dominate writes 100:1 — correct me") is a signal that you can commit under uncertainty. The design itself is almost a by-product of asking the right questions in the right order.

## 2. Core Concepts

- **Design procedure** — the repeatable sequence (clarify → what/schema → pattern → TTL/invalidation → size/evict → protect → topology → consistency → observe) that structures any caching design round.
- **Clarifying questions** — the workload facts you extract first: read/write ratio, request rate, data size, latency SLO, and staleness tolerance.
- **Irreversible decisions** — the choices that are expensive or impossible to change later: key schema, pattern, and consistency model.
- **Key schema** — the naming convention for keys (`entity:id:field`), which determines invalidation, sharding, and multi-tenancy for the life of the system.
- **Pattern choice** — cache-aside (default), read-through, write-through, write-behind; decided by the read/write shape and consistency needs.
- **Invalidation strategy** — TTL, explicit delete-on-write, or event-driven; the "hardest problem in computer science" and the part interviewers probe.
- **The four failure modes** — stampede (many misses at once), penetration (misses that never fill), avalanche (mass simultaneous expiry), hot key (one key overwhelming a node).
- **Topology** — standalone (simple), Sentinel (HA via failover), Cluster (horizontal sharding); chosen by scale and availability needs.
- **Consistency under failure** — what happens to correctness when the cache, the origin, or the network fails; async replication means possible loss on failover.
- **Level ladder** — mechanics (does it work?) → judgement (why this and not that?) → consequence (what breaks under load/failure?), the axis interviews probe along.

## 3. Theory & Principles

### The procedure is the answer

The most common way strong engineers fail a caching round is by jumping straight to "I'll use Redis with cache-aside and a TTL" — a correct answer with no visible reasoning, which reads as pattern-matching rather than design. The procedure exists to make your reasoning legible. Each step forces a decision that the next step depends on, so following it in order both produces a coherent design and shows the interviewer you understand the dependencies:

1. **Clarify the workload.** You cannot design a cache without the read/write ratio (does caching even help?), the scale (does it fit one node?), the latency SLO (how fast must a hit be?), and the *staleness tolerance* (how wrong can a cached value be, for how long?). This last one is the most under-asked and most decisive question in caching — it sets your TTL and invalidation strategy and half your consistency model.
2. **What to cache + key schema.** Cache the expensive-to-produce, frequently-read data. Design the key schema deliberately — it is irreversible (below).
3. **Pattern.** Cache-aside is the default; deviate only with a reason (chapter on caching patterns).
4. **TTL + invalidation.** Pick a TTL from the staleness tolerance; decide delete-vs-update on write.
5. **Size + evict.** Estimate working-set memory; set `maxmemory` and a policy (chapter 7).
6. **Protect.** Address stampede, penetration, avalanche, hot key explicitly.
7. **Topology.** Standalone / Sentinel / Cluster by scale and HA needs.
8. **Consistency under failure.** Reason about the cache, origin and network failing.
9. **Observe.** Hit ratio, evictions, latency, memory (chapter 28).

### The three irreversible decisions

Most caching decisions are cheap to change — a TTL is a config value, an eviction policy is one line, adding a Bloom filter is additive. Three decisions are not, and they deserve disproportionate care in the room because getting them wrong means a migration, a rewrite, or a correctness bug that persists:

- **Key schema.** The key naming convention (`product:42:price` vs one blob `product:42`) determines what you can invalidate granularly, how data shards across a Cluster (the key decides the slot), and how multi-tenancy isolates (the prefix, chapter 29). Change it later and every writer, reader and cached entry must migrate simultaneously. Design it once, deliberately.
- **Pattern choice.** Cache-aside, write-through and write-behind have different consistency and durability properties baked into the data flow. Moving from write-behind (which acknowledges before the origin is durable) to write-through later is not a config change; it is a change to your durability guarantees and the code around every write.
- **Consistency model.** Whether you promise read-your-writes, accept bounded staleness, or tolerate occasional lost updates on failover is a contract with everything built on top of the cache. Tightening it later can require adding fencing tokens, changing the invalidation strategy, or moving off async replication — pervasive changes, not tweaks.

The interview signal is naming these *as* irreversible: "I'll spend a moment on the key schema because it's the one thing I can't cheaply change later."

```svg
<svg viewBox="0 0 880 480" width="100%" height="480" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The caching design procedure &#8212; follow it visibly; the reasoning IS the score</text>

  <rect x="40" y="44" width="800" height="44" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="60" y="63" fill="#1e40af" font-size="11" font-weight="bold">1. CLARIFY WORKLOAD</text>
  <text x="60" y="80" fill="#1d4ed8" font-size="9">read/write ratio &#183; request rate &#183; data size &#183; latency SLO &#183; STALENESS TOLERANCE (the decisive, under-asked one)</text>

  <rect x="40" y="96" width="390" height="44" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="60" y="115" fill="#15803d" font-size="11" font-weight="bold">2. WHAT TO CACHE + KEY SCHEMA</text>
  <text x="60" y="132" fill="#166534" font-size="9">expensive + frequently read; schema = entity:id:field</text>
  <text x="410" y="112" fill="#b91c1c" font-size="8" text-anchor="end" font-weight="bold">IRREVERSIBLE</text>

  <rect x="450" y="96" width="390" height="44" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="470" y="115" fill="#92400e" font-size="11" font-weight="bold">3. PATTERN</text>
  <text x="470" y="132" fill="#b45309" font-size="9">cache-aside (default) / read-through / write-through / write-behind</text>
  <text x="820" y="112" fill="#b91c1c" font-size="8" text-anchor="end" font-weight="bold">IRREVERSIBLE</text>

  <rect x="40" y="148" width="390" height="44" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="60" y="167" fill="#5b21b6" font-size="11" font-weight="bold">4. TTL + INVALIDATION</text>
  <text x="60" y="184" fill="#6d28d9" font-size="9">TTL from staleness tolerance; delete-on-write vs update</text>

  <rect x="450" y="148" width="390" height="44" rx="8" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="470" y="167" fill="#b91c1c" font-size="11" font-weight="bold">5. SIZE + EVICTION</text>
  <text x="470" y="184" fill="#991b1b" font-size="9">working-set memory estimate; maxmemory + policy (LRU/LFU)</text>

  <rect x="40" y="200" width="800" height="60" rx="8" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="60" y="220" fill="#b91c1c" font-size="11" font-weight="bold">6. PROTECT AGAINST THE FOUR FAILURE MODES</text>
  <text x="60" y="238" fill="#991b1b" font-size="9">STAMPEDE: per-key lock / singleflight / early recompute &#183; PENETRATION: null-cache + Bloom filter</text>
  <text x="60" y="253" fill="#991b1b" font-size="9">AVALANCHE: TTL jitter &#183; HOT KEY: local cache / replicate / shard the key</text>

  <rect x="40" y="268" width="256" height="44" rx="8" fill="#f1f5f9" stroke="#475569" stroke-width="2"/>
  <text x="60" y="287" fill="#334155" font-size="11" font-weight="bold">7. TOPOLOGY</text>
  <text x="60" y="304" fill="#475569" font-size="9">standalone / Sentinel / Cluster</text>

  <rect x="312" y="268" width="256" height="44" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="332" y="287" fill="#15803d" font-size="11" font-weight="bold">8. CONSISTENCY UNDER FAILURE</text>
  <text x="332" y="304" fill="#166534" font-size="9">cache/origin/network fails; async repl loss</text>
  <text x="562" y="264" fill="#b91c1c" font-size="8" text-anchor="end" font-weight="bold">IRREVERSIBLE (model)</text>

  <rect x="584" y="268" width="256" height="44" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="604" y="287" fill="#1e40af" font-size="11" font-weight="bold">9. OBSERVE</text>
  <text x="604" y="304" fill="#1d4ed8" font-size="9">hit ratio, evictions, latency, memory</text>

  <rect x="40" y="332" width="800" height="130" rx="10" fill="#fffbeb" stroke="#ca8a04" stroke-width="2"/>
  <text x="440" y="356" text-anchor="middle" fill="#854d0e" font-size="12" font-weight="bold">The three IRREVERSIBLE decisions &#8212; name them as irreversible in the room</text>
  <rect x="60" y="368" width="245" height="82" rx="6" fill="#fff" stroke="#facc15"/>
  <text x="182" y="388" text-anchor="middle" fill="#854d0e" font-size="10" font-weight="bold">Key schema</text>
  <text x="72" y="406" fill="#713f12" font-size="8">decides invalidation granularity,</text>
  <text x="72" y="420" fill="#713f12" font-size="8">Cluster slot, tenant isolation.</text>
  <text x="72" y="438" fill="#713f12" font-size="8">Change = migrate everything at once.</text>
  <rect x="317" y="368" width="245" height="82" rx="6" fill="#fff" stroke="#facc15"/>
  <text x="439" y="388" text-anchor="middle" fill="#854d0e" font-size="10" font-weight="bold">Pattern choice</text>
  <text x="329" y="406" fill="#713f12" font-size="8">bakes durability/consistency into</text>
  <text x="329" y="420" fill="#713f12" font-size="8">the data flow. Change = rewrite</text>
  <text x="329" y="438" fill="#713f12" font-size="8">every write path + guarantees.</text>
  <rect x="574" y="368" width="245" height="82" rx="6" fill="#fff" stroke="#facc15"/>
  <text x="696" y="388" text-anchor="middle" fill="#854d0e" font-size="10" font-weight="bold">Consistency model</text>
  <text x="586" y="406" fill="#713f12" font-size="8">a contract with everything above.</text>
  <text x="586" y="420" fill="#713f12" font-size="8">Tighten later = fencing tokens,</text>
  <text x="586" y="438" fill="#713f12" font-size="8">new invalidation, off async repl.</text>
</svg>
```

## 4. Architecture & Workflow

The workflow of a live design round maps onto the procedure, but with two dynamics the procedure alone does not capture: the interviewer *interrupts* to probe, and you must *drive* rather than wait. A strong candidate narrates the procedure while inviting the probes: "I'll assume a 100:1 read/write ratio and 50ms staleness tolerance — stop me if that's wrong — which means cache-aside with a short TTL is fine and I don't need write-through."

The level ladder is the axis the interview moves along, and recognising which rung a question is on tells you how deep to go:

- **Mechanics ("does it work?").** How does cache-aside handle a miss? What command sets a TTL? These test that you know the tools. Answer crisply and move up.
- **Judgement ("why this and not that?").** Why cache-aside over write-through here? Why delete-on-write rather than update? These test design taste. Answer with the trade-off and the workload fact that decides it.
- **Consequence ("what breaks under load or failure?").** What happens when this hot key's TTL expires under 50k rps? What does a Sentinel failover do to an in-flight write? These separate senior from mid. Answer by naming the failure mode, its blast radius, and the mitigation.

The interviewer escalates a topic up this ladder until you stop having answers; your job is to pre-empt by volunteering the consequence-level reasoning before being pushed there. The three worked designs below each show this: state the design (mechanics), justify the choices (judgement), then defend the hard part unprompted (consequence).

```svg
<svg viewBox="0 0 880 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="lm" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#64748b"/></marker>
  </defs>
  <text x="440" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The level ladder: interviews climb until you stop answering &#8212; so pre-empt</text>

  <rect x="60" y="48" width="760" height="92" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="80" y="72" fill="#1e40af" font-size="13" font-weight="bold">Rung 1 &#8212; MECHANICS: "does it work?"</text>
  <text x="80" y="94" fill="#1d4ed8" font-size="10">How does cache-aside handle a miss? What sets a TTL? Which type for a leaderboard?</text>
  <text x="80" y="112" fill="#1e40af" font-size="10" font-weight="bold">Tests: you know the tools. &#8594; Answer crisply, climb.</text>
  <text x="80" y="130" fill="#64748b" font-size="9">Mid-level questions live here.</text>

  <path d="M440,140 L440,166" stroke="#64748b" stroke-width="2" marker-end="url(#lm)"/>

  <rect x="60" y="170" width="760" height="92" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="80" y="194" fill="#92400e" font-size="13" font-weight="bold">Rung 2 &#8212; JUDGEMENT: "why this and not that?"</text>
  <text x="80" y="216" fill="#b45309" font-size="10">Why cache-aside over write-through? Why delete-on-write not update? Why LFU not LRU?</text>
  <text x="80" y="234" fill="#92400e" font-size="10" font-weight="bold">Tests: design taste. &#8594; Answer with the trade-off + the workload fact that decides it.</text>
  <text x="80" y="252" fill="#64748b" font-size="9">The mid/senior boundary.</text>

  <path d="M440,262 L440,288" stroke="#64748b" stroke-width="2" marker-end="url(#lm)"/>

  <rect x="60" y="292" width="760" height="100" rx="10" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="80" y="316" fill="#b91c1c" font-size="13" font-weight="bold">Rung 3 &#8212; CONSEQUENCE: "what breaks under load / failure?"</text>
  <text x="80" y="338" fill="#991b1b" font-size="10">Hot key's TTL expires at 50k rps &#8212; what happens? A Sentinel failover mid-write &#8212; what's lost?</text>
  <text x="80" y="356" fill="#b91c1c" font-size="10" font-weight="bold">Tests: seniority. &#8594; Name the failure mode + blast radius + mitigation, UNPROMPTED.</text>
  <text x="80" y="376" fill="#991b1b" font-size="9">Senior questions live here. Pre-empt them: volunteer the consequence before you're pushed to it.</text>
</svg>
```

## 5. Implementation

Section 5 in a synthesis chapter is the *reference toolkit* — the two or three snippets you reach for in almost every design round, so they are muscle memory. Cache-aside with singleflight (stampede protection) is the single most-asked pattern; the sliding-window rate limiter is the second. Here they are in Go, production-shaped.

```go
package designtoolkit

import (
	"context"
	"encoding/json"
	"errors"
	"math/rand"
	"time"

	"github.com/redis/go-redis/v9"
	"golang.org/x/sync/singleflight"
)

// ---------------------------------------------------------------------------
// TOOLKIT 1: Cache-aside with stampede protection + jittered TTL + null-caching.
// This one function answers most of a design round: the default pattern, plus
// defences against stampede, avalanche and penetration in one place.
// ---------------------------------------------------------------------------

type CatalogCache struct {
	rdb *redis.Client
	sf  singleflight.Group // coalesces concurrent misses in THIS process
}

var errNotFound = errors.New("not found in origin")

// Get implements read-through-flavoured cache-aside. On a hit it returns the
// cached value; on a miss it loads from the origin under a singleflight guard
// so a thousand concurrent misses for the same key cause ONE origin load, not a
// thousand — the in-process half of stampede protection.
func (c *CatalogCache) Get(ctx context.Context, id string, load func(ctx context.Context, id string) ([]byte, error)) ([]byte, error) {
	key := "product:" + id // deliberate, stable key schema (irreversible decision)

	// 1. Try the cache.
	val, err := c.rdb.Get(ctx, key).Bytes()
	if err == nil {
		if len(val) == 0 {
			// Empty sentinel = a cached NEGATIVE result (penetration defence):
			// we already know the origin has nothing, so don't hit it again.
			return nil, errNotFound
		}
		return val, nil
	}
	if !errors.Is(err, redis.Nil) {
		return nil, err // a real Redis error, not a miss
	}

	// 2. Miss: coalesce concurrent loads of the same key into one.
	v, err, _ := c.sf.Do(key, func() (any, error) {
		// Re-check the cache inside the guard: another goroutine may have filled
		// it while we queued behind the singleflight lock.
		if val, err := c.rdb.Get(ctx, key).Bytes(); err == nil {
			return val, nil
		}
		data, err := load(ctx, id)
		if errors.Is(err, errNotFound) {
			// Cache the MISS with a SHORT TTL so a flood of requests for a
			// non-existent id can't hammer the origin (penetration).
			c.rdb.Set(ctx, key, "", 30*time.Second)
			return nil, errNotFound
		}
		if err != nil {
			return nil, err // origin error: do NOT cache it, let it retry
		}
		// 3. Fill the cache with a JITTERED TTL so many keys loaded together
		// don't all expire at the same instant (avalanche defence).
		ttl := 10*time.Minute + time.Duration(rand.Int63n(int64(2*time.Minute)))
		c.rdb.Set(ctx, key, data, ttl)
		return data, nil
	})
	if err != nil {
		return nil, err
	}
	return v.([]byte), nil
}

// Invalidate on write: DELETE, not update. Deleting is idempotent and avoids the
// read-modify-write race of updating the cache from stale data; the next read
// re-populates from the origin. This is the safe default for cache-aside.
func (c *CatalogCache) Invalidate(ctx context.Context, id string) error {
	return c.rdb.Del(ctx, "product:"+id).Err()
}

// ---------------------------------------------------------------------------
// TOOLKIT 2: Sliding-window rate limiter as a sorted set — the second
// most-asked snippet. Score = timestamp; the window is a ZRANGEBYSCORE count.
// Runs as a Lua script so the trim+count+add is ONE atomic step (no race).
// ---------------------------------------------------------------------------

var slidingWindow = redis.NewScript(`
  local key    = KEYS[1]
  local now    = tonumber(ARGV[1])   -- current time (ms)
  local window = tonumber(ARGV[2])   -- window length (ms)
  local limit  = tonumber(ARGV[3])   -- max requests per window
  -- Drop entries older than the window.
  redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
  -- Count what's left in the window.
  local count = redis.call('ZCARD', key)
  if count < limit then
    redis.call('ZADD', key, now, now)          -- record this request
    redis.call('PEXPIRE', key, window)          -- let idle keys expire
    return 1                                     -- allowed
  end
  return 0                                       -- rate-limited
`)

func AllowRequest(ctx context.Context, rdb *redis.Client, userID string, limit int, window time.Duration) (bool, error) {
	now := time.Now().UnixMilli()
	res, err := slidingWindow.Run(ctx, rdb,
		[]string{"ratelimit:" + userID},
		now, window.Milliseconds(), limit).Int()
	if err != nil {
		return false, err
	}
	return res == 1, nil
}

// A tiny helper so the examples compile in isolation.
func mustJSON(v any) []byte { b, _ := json.Marshal(v); return b }
```

These two snippets — cache-aside-with-defences and the atomic sliding-window limiter — cover the mechanics of perhaps 70% of caching design rounds. Knowing them cold frees your attention in the room for the judgement and consequence reasoning that actually earns the offer.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages of a procedural approach**
- **Legible reasoning.** Following the procedure visibly shows *why*, which is what is scored — not just that you landed on a correct design.
- **Coverage.** The nine steps guarantee you address invalidation, failure modes and consistency, the parts weak candidates skip.
- **Pre-emption.** Naming irreversible decisions and volunteering consequence-level reasoning defuses the interviewer's hardest probes before they are asked.
- **Transferable.** The same procedure fits a product cache, a rate limiter or a feed, so you are not memorising designs, you are applying a method.

**Disadvantages / risks**
- **Rote recitation.** Marching through the steps mechanically without adapting to the actual workload reads as a script, not thinking.
- **Over-engineering.** Reaching for Cluster, Bloom filters and write-behind on a problem that a standalone cache-aside solves signals poor judgement about cost.
- **Analysis paralysis.** Spending the whole round clarifying and never committing to a design fails the "can you decide?" test.
- **Ignoring the interviewer's steer.** The procedure is a default, not a cage; if the interviewer wants to go deep on invalidation, follow them.

**Trade-offs**
- *Breadth vs depth:* covering all nine steps shallowly vs going deep on the two the interviewer cares about. Read the room — cover the procedure quickly, then invest depth where they probe.
- *Committing early vs clarifying fully:* stating assumptions and designing vs extracting every requirement first. State a reasonable assumption out loud and proceed; let them correct you.
- *Ideal design vs pragmatic one:* the theoretically best system vs the one that fits the stated scale. Senior answers right-size — the cheapest design that meets the SLO, with a note on when you'd upgrade.
- *Consistency vs availability/latency:* stronger consistency (write-through, synchronous invalidation) costs latency and availability; the round is largely about defending where you put that dial for the given workload.

## 7. Common Mistakes & Best Practices

- **Jumping to a solution before clarifying.** "Redis, cache-aside, TTL" with no workload facts reads as pattern-matching. *Best practice:* extract read/write ratio, scale, SLO and staleness tolerance first, out loud.
- **Never mentioning invalidation.** The part interviewers most want to hear, most often skipped. *Best practice:* state the invalidation strategy (TTL + delete-on-write) and its staleness window explicitly.
- **Ignoring the failure modes.** Designing the happy path and going silent on stampede, penetration, avalanche and hot keys. *Best practice:* address all four proactively, even briefly, for any high-traffic cache.
- **Reaching for Cluster unprompted.** Sharding a workload that fits one node signals over-engineering. *Best practice:* start standalone/Sentinel; introduce Cluster only when the size or throughput estimate demands it.
- **Treating the cache as a database.** Assuming cached data is durable and consistent. *Best practice:* say out loud that the cache is a disposable copy, and reason about the origin as the source of truth.
- **Not naming the irreversible decisions.** Spending equal care on a TTL (cheap to change) and the key schema (a migration to change). *Best practice:* flag key schema, pattern and consistency model as the ones to get right up front.
- **Forgetting consistency under failover.** Ignoring that async replication can lose the last writes when Sentinel promotes a replica. *Best practice:* state the loss window and whether the design tolerates it, or needs `WAIT`/fencing.
- **Best practice: drive and narrate.** Own the whiteboard, state assumptions, volunteer trade-offs and consequence-level reasoning, and invite correction — a design round scores the reasoning you make visible, not the design you hold silently in your head.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging (in the round).** When the interviewer injects a fault — "the origin is down", "this key is now hot", "the cache just failed over" — treat it as a consequence-level probe: name the failure mode, trace the blast radius through your design, and give the mitigation. The best answers reference how you'd *see* it (a falling hit ratio, a slowlog entry, a latency spike — chapter 28) and how you'd *fix* it (add a per-key lock, replicate the hot key, add TTL jitter).
- **Monitoring.** Every design should end with "and here's how I'd know it's working": windowed hit ratio, eviction rate, p99 latency, memory-vs-maxmemory. Volunteering the observability plan unprompted is a strong senior signal — it shows you think past the design into operations.
- **Security.** For any design touching user data or multi-tenancy, note the hardening (chapter 29): least-privilege ACL users, key namespacing enforced by ACL patterns, TLS, and never exposing the port. A rate limiter or session store especially invites "how do you isolate tenants?" — answer with ACL key patterns or per-tenant instances.
- **Scaling.** Be explicit about the scaling *path*, not just the endpoint: standalone until the working set or throughput outgrows one node, Sentinel for HA, Cluster to shard — and call out the Cluster constraint that multi-key operations need co-located keys (hash tags), which your key schema must anticipate. Right-size for the stated scale and name the trigger that would make you upgrade.

## 9. Interview Questions

**Q: Walk me through your procedure for a caching design round before you write anything.**
A: I clarify the workload first — read/write ratio (does caching even help?), request rate and data size (does it fit one node?), the latency SLO (how fast must a hit be?), and crucially the staleness tolerance (how wrong can a value be, and for how long?), because that last one sets my TTL and invalidation. Then I decide what to cache (expensive, frequently-read data) and the key schema, which I treat with extra care because it's irreversible. Then the pattern — cache-aside by default. Then TTL and invalidation from the staleness tolerance, choosing delete-on-write. Then I size the working set and set `maxmemory` with an eviction policy. Then I explicitly address the four failure modes — stampede, penetration, avalanche, hot key. Then topology — standalone, Sentinel or Cluster by scale and HA. Then consistency under failure. And I finish with how I'd observe it. Following that visibly is most of the answer, because the round scores my reasoning, not just the final design.

**Q: Design a cache for a product catalog: millions of products, very read-heavy, prices update a few times a day.**
A: Read/write ratio is enormous and staleness tolerance is generous (a price stale by a minute is fine), so this is the easy-consistency case. I cache each product as a value under `product:{id}` (a hash if I update individual fields, a JSON string if I read it whole), with cache-aside and a TTL of maybe 10 minutes — short enough to bound staleness, long enough for a high hit ratio. On a price update I delete-on-write so the next read repopulates from the source of truth. Sizing: millions of small products fit comfortably in memory on a single large node or a small Cluster; `maxmemory` with `allkeys-lru` since access is skewed to popular products. The failure modes: stampede on a popular product's expiry — I add singleflight/per-key locking so one miss loads the origin, not thousands, plus TTL jitter so products loaded together don't expire together (avalanche); penetration from requests for non-existent product ids (scrapers) — I null-cache misses with a short TTL and, at this scale, a Bloom filter of valid ids. Topology: standalone with a replica and Sentinel is plenty unless the catalog exceeds one node's memory, then Cluster keyed by product id. Consistency is relaxed by design — the catalog tolerates seconds of staleness — so I don't need write-through. Finally observability: I'd watch the hit ratio (expecting well above 95% given the read skew), the eviction rate (rising evictions would tell me the hot set outgrew `maxmemory` and it's time to add nodes), and p99 latency with the slowlog, so a stray `KEYS`-style query or a big-key value surfaces immediately. The whole design is deliberately boring, which is the right answer for a read-heavy, staleness-tolerant workload — the interviewer is checking that I don't over-build.

**Q: Design a rate limiter and session store for an API gateway. What are the hard parts?**
A: Two related jobs. The rate limiter I build as a sliding-window sorted set per user (`ratelimit:{user}`, score = timestamp), executed as one Lua script so the trim-count-add is atomic — no race under concurrency, which is the whole point of doing it in Redis rather than the application. The session store is a hash per session (`session:{id}`) with a TTL that I refresh on access (sliding expiration via `EXPIRE`/`GETEX`), so active sessions live and idle ones expire. The hard parts: first, atomicity — a rate limiter faked with GET/INCR/SET is a race that lets bursts through, so it must be one atomic operation. Second, the hot-key problem — a single very active user (or a shared/global limit key) concentrates all their traffic on one Cluster slot; I mitigate with a local pre-check, or by sharding the limit across a few sub-keys. Third, consistency under failover — sessions on a replica that gets promoted may lose the last few writes because replication is async, so a just-created session could vanish; I decide whether that's acceptable (usually yes, the user re-logs in) or whether I need stronger guarantees. Fourth, security and multi-tenancy — sessions are sensitive, so ACL-scoped users, TLS, and per-tenant key isolation.

**Q: Design a social-feed cache. Defend the hardest part.**
A: I decompose the feed by access pattern (the chapter-4 approach). The per-user feed — a capped, newest-first list of item ids — is a list (`LPUSH` + `LTRIM`) or a sorted set scored by time if I need range queries. Each item's content is a hash so I can update a like-count with `HINCRBY` without rewriting the item. "Has this user seen this?" for dedup is a set. A trending ranking is a sorted set scored by engagement. The hardest part is invalidation and fan-out consistency: when a user posts, do I fan-out-on-write (push the item id into every follower's cached feed) or fan-out-on-read (assemble the feed from followees at read time)? Fan-out-on-write gives fast reads but is catastrophic for celebrities with millions of followers — one post is millions of writes and a hot-key storm. So the senior answer is hybrid: fan-out-on-write for normal users, fan-out-on-read for high-follower accounts, merging the two at read time. I'd defend this by naming the consequence: without the hybrid, a celebrity post either stalls the write path or, cached naively, creates a hot key that overwhelms one node. I'd also flag the invalidation subtlety that a naive design misses — when an item is edited or deleted after fan-out-on-write, its id already sits in millions of feed caches, so I either store only ids in the feed and resolve content at read time (so edits are picked up automatically and a delete is a single content-key removal), or I accept eventual consistency and let the item's own TTL age it out. Storing ids and resolving content lazily is usually the cleaner answer, because it turns "invalidate this item everywhere" from millions of writes into one, which is exactly the kind of consequence-level reasoning the round is testing for.

**Q: When would you choose delete-on-write over update-on-write for invalidation?**
A: Almost always delete. Deleting the cached key on a write is idempotent and lets the next read repopulate from the source of truth, which avoids the classic race where two concurrent writers update the cache out of order and leave it holding a stale value that never expires. Updating the cache in place is only worth it when the value is expensive to recompute *and* reads are so hot that you can't afford even one miss to repopulate — and even then you must handle the write-write race, often with a version check. The default is delete; update is an optimisation you justify.

**Q: Why is cache-aside the default, and when would you deviate?**
A: Cache-aside is the default because it's simple, the cache and origin are decoupled (a cache failure just means cache misses, not write failures), and it naturally caches only what's actually read. I deviate for specific reasons: write-through when I need the cache and origin to stay in lockstep and can pay the write latency; write-behind when write throughput to the origin is the bottleneck and I can tolerate the durability risk of acknowledging before the origin is durable; read-through when I want the cache library to own loading so the application code is simpler. Each deviation buys something at a cost, and I name both — but absent a specific reason, cache-aside wins on simplicity and failure isolation.

**Q: (Senior) A design uses cache-aside with a 5-minute TTL. The interviewer says one key is now receiving 80,000 requests per second and its TTL just expired. Trace what happens and fix it.**
A: This is a cache stampede on a hot key, and it's a consequence-level question about the moment of expiry. The instant the key expires, all 80,000 requests per second miss simultaneously; with naive cache-aside every one of them queries the origin, so the database goes from serving ~0 qps for that key to 80,000 qps in an instant — a thundering herd that can take the origin down, and because the origin is now slow or dead, the cache stays empty, so the herd persists rather than resolving. The fix has layers. In-process, singleflight coalesces concurrent misses per key so each application instance makes one origin load, not thousands. Across instances, a distributed per-key lock (`SET lock:key val NX PX`) lets exactly one instance recompute while the others briefly serve stale or wait. Better still, probabilistic early recomputation (XFetch) refreshes the key *before* it expires, based on recompute cost and remaining TTL, so it never hits zero under load. And for a genuinely hot key I add stale-while-revalidate — serve the old value while one worker refreshes — so reads never block on the origin at all. Separately, because it's a *hot* key, I'd address the concentration itself: a local in-process cache with a short TTL absorbs most of the 80k rps before Redis, and in Cluster I'd replicate or shard the key so one slot isn't the bottleneck. The senior move is naming both problems — the stampede at expiry and the hot-key concentration — because they compound.

**Q: (Senior) Your cache runs on Redis with a replica and Sentinel. A write is acknowledged, then the master fails and Sentinel promotes the replica. What can go wrong, and how do you reason about it?**
A: The core issue is that Redis replication is asynchronous, so an acknowledged write is not guaranteed to have reached the replica before the master failed. If the master acks a write, then crashes before propagating it, Sentinel promotes a replica that never saw that write — so the write is silently lost, and a client that read-its-own-write before the failover now reads a value that has effectively rolled back. For a pure cache this is often acceptable: the lost write is a cache entry that will simply be a miss and repopulate from the origin, so correctness is preserved as long as the origin is the source of truth. It becomes dangerous when the cache holds data that isn't backed by a durable origin — a rate-limiter count, a session, a distributed lock. For a lock, this is exactly the scenario that breaks single-instance Redis locking under failover and motivates fencing tokens: even if the lock is "lost" on the new master, the fencing token lets the protected resource reject a stale lock holder. If I genuinely need the write to survive failover, I can use `WAIT numreplicas timeout` to block until the write reaches replicas (trading latency and availability), or accept that Redis is not a durable store and put anything that must survive in the origin. The reasoning discipline is: identify what the cache holds that isn't reconstructable from a durable source, and either make it reconstructable, protect it with fencing, or pay for synchronous replication.

**Q: (Senior) How do you decide between standalone, Sentinel, and Cluster for a given caching workload?**
A: I decide on two axes: does the working set and throughput fit one node, and what availability do I need. If the data fits in one machine's RAM and one core's command throughput is enough (which, given Redis does hundreds of thousands of ops/sec per core, is a lot of workloads), I stay standalone — it's the simplest, has no cross-slot restrictions, and every multi-key operation and transaction just works. If I need high availability on top of that — automatic failover when the master dies — I add replicas and Sentinel, which monitors and promotes without sharding, keeping the simple single-node data model. I only reach for Cluster when the working set exceeds one node's memory or the throughput exceeds one core, because Cluster's horizontal sharding across 16384 slots buys capacity at real costs: multi-key operations only work when keys share a slot (via hash tags), some transactions and Lua scripts are constrained, and the client and operations are more complex. So the progression is standalone → add Sentinel for HA → Cluster only when size or throughput forces it. The mistake I watch for in myself is reaching for Cluster to look sophisticated on a workload that a single node handles trivially — that's over-engineering, and the senior signal is right-sizing and naming the specific threshold (a memory or ops number) that would make me upgrade.

**Q: (Senior) An interviewer asks you to cache something with strict read-your-writes consistency. How does that change your design?**
A: Strict read-your-writes means after a client writes, its subsequent reads must reflect that write — which fights the cache's whole premise of serving possibly-stale copies, so I'd first push back on whether it's truly required or whether bounded staleness suffices, because the cheapest correct design is the one that meets the actual requirement. If it genuinely needs read-your-writes, cache-aside with delete-on-write mostly gets there: the write deletes the cached key, so the writer's next read misses and repopulates from the origin with the fresh value — provided the delete is synchronous and ordered before the read, and provided I read from a source that has the write. The failure points I'd defend: the delete and the origin write must be ordered so I don't delete, then have a concurrent read repopulate the *old* value from a lagging origin replica before the write lands (a race that reintroduces staleness) — I'd address it by deleting after the origin write commits, and possibly a short "hold-down" where the key can't be repopulated for a moment, or versioned values. Under Redis failover, async replication could lose the delete, resurrecting a stale value; if read-your-writes must survive failover I'd need `WAIT` or to route the writer's reads to the origin for a window. And I'd note that per-session read-your-writes (only the writer needs to see it) is far cheaper than global strong consistency (everyone sees it immediately) — I'd nail down which is meant, because it changes whether I need distributed coordination or just careful per-writer routing.

**Q: What's the difference between cache penetration, stampede, and avalanche, and the fix for each?**
A: Penetration is repeated requests for keys that don't exist in the origin either, so they always miss and always hit the origin — the fix is null-caching (cache the negative result with a short TTL) and, at scale, a Bloom filter to reject known-absent keys before touching Redis. Stampede (thundering herd) is many concurrent requests missing on the *same* key at once — typically the moment a hot key expires — all rushing the origin; the fix is coalescing them with a per-key lock or singleflight, plus probabilistic early recomputation so the key refreshes before expiry. Avalanche is a mass of keys expiring at the *same instant* (often because they were loaded together with identical TTLs), causing a synchronized miss storm across many keys; the fix is TTL jitter — add randomness to each TTL so expiries spread out. They're distinct — one key that never exists, one key everyone wants at once, many keys expiring together — and a thorough design addresses all three because high-traffic caches hit all of them.

**Q: How do you size the memory for a cache and pick an eviction policy?**
A: I estimate the working set — the set of keys actually accessed in a window — as (number of hot entries) × (average entry size, including Redis overhead), not the entire dataset, because a cache only needs the hot subset. I set `maxmemory` to that with headroom (and well below the machine's RAM, leaving room for client buffers and any fork). For the policy: `allkeys-lru` (or `allkeys-lfu` when access frequency is more predictive than recency, e.g. a stable set of popular items) for a pure cache where anything is evictable; `volatile-lru`/`volatile-ttl` when only some keys have TTLs and others must persist. I avoid `noeviction` for a cache because it turns a full cache into write errors. LFU is often the better default for a catalog-style workload because it keeps genuinely popular items over recently-but-rarely accessed ones, using its probabilistic counter with decay. And I'd monitor the eviction rate and hit ratio to confirm the sizing holds under real traffic.

**Q: The interviewer says "keep it simple — this is a small internal tool." How does that change your answer?**
A: It should change it a lot, and recognising that is itself a senior signal — right-sizing is design taste, not a lack of ambition. For a small internal tool I collapse most of the procedure: a single standalone Redis (with a replica only if the tool's availability matters), cache-aside with a plain TTL, delete-on-write, `allkeys-lru`, and a straightforward key schema. I'd explicitly *not* reach for Cluster, Bloom filters, singleflight or write-behind, and I'd say why: at low traffic there's no stampede to coalesce, no hot key to shard, no working set that outgrows one node, so those defences are cost without benefit. What I'd keep even at small scale is the cheap, high-value discipline — a deliberate key schema, an invalidation strategy, and a basic hit-ratio/memory check — because those cost nothing and save pain. The mistake I'd avoid is performing sophistication: adding machinery to look senior actually reads as junior, because it shows I can't match the design to the constraints. The senior move is to name the threshold ("if this grew to X requests per second or Y gigabytes, I'd add Z") so it's clear I'm choosing simplicity, not missing the complexity.

## 10. Quick Revision & Cheat Sheet

| Procedure step | The decision | Chapter |
|---|---|---|
| Clarify | read/write ratio, scale, SLO, staleness | — |
| What + key schema | what to cache, `entity:id:field` (irreversible) | 4, 18 |
| Pattern | cache-aside default (irreversible) | patterns |
| TTL + invalidation | TTL from staleness, delete-on-write | 5, 6 |
| Size + evict | working-set memory, LRU/LFU | 7 |
| Protect | stampede, penetration, avalanche, hot key | stampede |
| Topology | standalone / Sentinel / Cluster | 25, 26 |
| Consistency | failover loss, fencing, WAIT (irreversible) | locks, HA |
| Observe | hit ratio, evictions, latency, memory | 28 |

| Failure mode | One-line fix |
|---|---|
| Stampede (herd on one key) | singleflight / per-key lock / early recompute |
| Penetration (missing keys) | null-cache + Bloom filter |
| Avalanche (mass expiry) | TTL jitter |
| Hot key (one node overwhelmed) | local cache / replicate / shard the key |

| Level probe | What it tests | How to answer |
|---|---|---|
| Mechanics ("does it work?") | you know the tools | crisply, then climb |
| Judgement ("why this?") | design taste | trade-off + the workload fact that decides it |
| Consequence ("what breaks?") | seniority | failure mode + blast radius + mitigation, unprompted |

**Flash cards**
- **The procedure?** → clarify → what/schema → pattern → TTL/invalidation → size/evict → protect → topology → consistency → observe.
- **The three irreversible decisions?** → key schema, pattern choice, consistency model.
- **The most under-asked clarifying question?** → staleness tolerance (sets TTL + invalidation).
- **Default pattern + invalidation?** → cache-aside + delete-on-write.
- **The four failure modes?** → stampede, penetration, avalanche, hot key.
- **When Cluster?** → only when working set > one node's RAM or throughput > one core.
- **The level ladder?** → mechanics (works?) → judgement (why this?) → consequence (what breaks?).
- **Feed fan-out for celebrities?** → hybrid: write on post for normal users, read-time merge for high-follower accounts.
- **Async replication + failover?** → last acked writes can be lost; fine for a cache, dangerous for locks/counters (use fencing/WAIT).
- **Biggest scoring signal?** → visible reasoning and right-sizing, not the largest design.

## 11. Hands-On Exercises & Mini Project

- [ ] Take a written design (e.g. "cache a user profile service") and produce the full nine-step procedure on paper, flagging the irreversible decisions.
- [ ] Implement the cache-aside-with-singleflight toolkit and load-test it: hammer one key past its expiry and confirm the origin sees one load, not thousands.
- [ ] Build the sliding-window rate limiter as a Lua script and prove it's race-free under concurrent load, then contrast with a GET/INCR/SET version that lets bursts through.
- [ ] Design the same feature (a rate limiter) three times for three scales — one node, Sentinel, Cluster — and write down what changes and why.
- [ ] For a chosen design, inject each of the four failure modes and write the detection signal (chapter 28) and the mitigation.
- [ ] Write out a read-your-writes design and identify every point where staleness could sneak back in.
- [ ] Practise the "keep it simple" pivot: take an over-scoped design and argue it down to the smallest system that meets the SLO, naming the upgrade threshold.
- [ ] Rehearse answering a consequence-level question in the shape "failure mode → blast radius → detection signal → mitigation" until it's automatic.

### Mini Project — "Mock Design Round Playbook"

**Goal.** Turn the procedure into rehearsed instinct by running three complete mock rounds end to end, each defending its hard part unprompted, so that in a real round the reasoning is automatic and your attention is free for the interviewer's probes.

**Requirements.**
1. Pick three distinct workloads (e.g. product catalog, rate-limiter/session store, social feed) and design each through all nine procedure steps, out loud or written.
2. For each, explicitly name the irreversible decisions and justify them, and address all four failure modes.
3. Implement the core of each design (cache-aside toolkit, rate-limiter script, feed fan-out) and load-test the hard part until you can defend it with numbers.
4. For each design, script the consequence-level questions an interviewer would ask (hot key, failover, penetration) and rehearse the answers with blast radius + mitigation.
5. Build a one-page cheat sheet per design: assumptions, key schema, pattern, TTL/invalidation, protections, topology, consistency, observability.

**Extensions.**
- Run the rounds against a peer acting as interviewer who escalates each topic up the level ladder until you stop having answers, then close those gaps.
- Add a fourth, deliberately over-scoped design (Cluster + Bloom + write-behind for a tiny workload) and practise arguing *down* to the right-sized solution — right-sizing is itself a senior signal.
- For each design, write the one-paragraph consistency contract it offers (read-your-writes? bounded staleness? possible loss on failover?) and check it against what the workload actually needs.
- Time-box each mock round to 40 minutes and deliberately spend the first five on clarifying questions only, to build the habit of not designing before you understand the workload.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Caching Patterns: Cache-Aside, Read/Write-Through & Write-Behind* (step 3 in depth), *TTL, Expiration & Invalidation* (step 4), *Cache Stampede, Penetration & Avalanche* (step 6), *Distributed Locks & Fencing Tokens* (consistency under failure), *Replication, Sentinel & Cluster* (topology), *Observability* (step 9).

- **Redis — Introduction to caching & patterns** — Redis · *Intermediate* · the canonical patterns (cache-aside, read/write-through) that step 3 of the procedure chooses between. <https://redis.io/docs/latest/develop/use/patterns/>
- **Designing Data-Intensive Applications** — Martin Kleppmann · *Advanced* · the definitive treatment of consistency models, replication and failure — the theory behind the "consistency under failure" step. <https://dataintensive.net/>
- **How to do distributed locking** — Martin Kleppmann · *Advanced* · the essay behind the fencing-token reasoning in the failover question; essential for the locks/consistency answers. <https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html>
- **System Design Interview (Alex Xu) — caching chapters** — Alex Xu · *Intermediate* · a widely-used framework for design rounds that complements this procedure. <https://bytebytego.com/>
- **AWS — Caching best practices & the caching challenges** — AWS · *Intermediate* · a vendor-neutral tour of invalidation, sizing and the failure modes for design-round grounding. <https://aws.amazon.com/caching/best-practices/>
- **Redis — Distributed locks with Redlock** — Redis · *Advanced* · the Redlock spec and the debate around it, the source material for the consistency-under-failover answers. <https://redis.io/docs/latest/develop/use/patterns/distributed-locks/>
- **Facebook — Scaling Memcache at Facebook** — Nishtala et al. (USENIX) · *Advanced* · the classic paper on caching at scale, stampede, invalidation and consistency — a goldmine of design-round war stories. <https://www.usenix.org/system/files/conference/nsdi13/nsdi13-final170_update.pdf>
- **Redis University — RU101 & RU301** — Redis · *Beginner–Intermediate* · free courses covering the data structures, patterns and production operations the procedure assembles. <https://university.redis.com/>

---

*Caching with Redis Handbook — chapter 30.*
