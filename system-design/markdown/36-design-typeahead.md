# 36 · Design: Search Autocomplete (Typeahead)

> **In one line:** Return the top few completions for a prefix in under ~50 ms as the user types each key — a read-dominated problem solved by a trie with precomputed top-k, updated offline.

---

## 1. Problem & Requirements

Typeahead suggests the most likely completions as a user types into a search box (Google search, Amazon products, IDE symbol search). It fires on **every keystroke**, so it's extraordinarily read-heavy and latency-critical. The crux: a **trie of prefixes with precomputed top-k** at each node, counts updated **offline** (not per query), the trie **sharded** across nodes, and results **cached** and **debounced** on the client.

**Functional**
- Given a prefix, return the **top-k** (e.g. 5–10) most relevant completions.
- Rank by popularity (query frequency), possibly time-decayed and **personalized**.
- Reflect new/trending queries within some freshness window (minutes to hours, not seconds).
- Support typo tolerance (nice-to-have).

**Non-functional**
- **Latency**: p99 < **50–100 ms** end-to-end per keystroke — it must feel instant. Server budget ~20–30 ms.
- **Scale**: high query volume — a search engine with 400M searches/day generates *many* keystroke lookups per search (often 5–20× the search volume).
- **Availability**: 99.9%+. A missing suggestion degrades UX but isn't fatal — graceful.
- **Consistency**: **eventual/stale is fine**. Suggestions built from data a few hours old are acceptable; there's no correctness requirement, only relevance.
- **Read:write ratio**: overwhelmingly reads. Writes (count updates) are batched offline.

## 2. Capacity Estimation

```text
QUERY VOLUME
  Searches/day        = 400,000,000
  Keystrokes/search   ~ 4 (avg prefix lookups before submit, after debounce)
  Prefix lookups/day  = 400M * 4 = 1.6B
  Lookup QPS (avg)    = 1.6B / 86,400   ≈ 18,500 QPS
  Lookup QPS (peak 3×)≈ 55,000 QPS      <-- read path must serve this from memory

CORPUS
  Distinct search phrases in the trie ~ 100M
  Avg phrase length ~ 20 chars; store phrase + count
  Trie nodes: bounded by total unique prefixes; with top-k cached per node
  Rough: 100M phrases * (20B phrase + 8B count + top-k list) ~ tens of GB
        -> the trie does NOT fit on one node comfortably -> shard it

TOP-K PRECOMPUTE
  Store top-k (say 10) completions AT each trie node -> a lookup is O(prefix length)
  to walk to the node, then O(1) to read its cached list. No ranking at query time.

WRITE / UPDATE
  Log every submitted search -> aggregate frequencies offline (hourly batch)
  400M events/day -> stream to Kafka -> rollup -> rebuild/patch trie
  This is a bulk write, NOT on the query hot path.
```

**Takeaway:** ~55K peak read QPS served from an in-memory trie whose nodes already hold their top-k answers. All the expensive work (counting, ranking, top-k selection) happens **offline**; the online path is just a memory walk + read.

## 3. API Design

```http
GET /api/v1/suggest?q=har&limit=10&lang=en&userId=u_7
  200 OK
  { "prefix": "har",
    "suggestions": [
      { "text": "harry potter", "score": 0.98 },
      { "text": "hard drive",   "score": 0.71 },
      { "text": "harvard",      "score": 0.64 } ],
    "tookMs": 12 }
```

Design notes:
- Client **debounces** (~150–300 ms) so it doesn't fire on every single keystroke — cuts backend QPS dramatically and avoids racing responses.
- Responses are small and heavily **cacheable** (`Cache-Control` short TTL) — the same prefixes repeat constantly.
- Return results **ranked**; the score is optional metadata for the client.

## 4. Data Model

```text
TRIE (in-memory, served)
  node {
    char
    children: map<char, node>
    isTerminal: bool
    topK: [ (phrase, score) ]     -- PRECOMPUTED at build time; the whole trick
  }
  Lookup("har") = walk h->a->r, return node.topK

PHRASE / FREQUENCY STORE (offline, source of truth)
  phrase (PK)   frequency   last_seen   decayed_score
  -- aggregated from the query log; used to rebuild the trie

QUERY LOG (append-only, e.g. Kafka -> data warehouse)
  ts   raw_query   userId   resultClicked
```

**Datastore choice:** the **serving trie lives in memory** (the point is µs-scale traversal) on the suggestion servers, periodically rebuilt from the frequency store. The frequency store is a batch/warehouse system (Cassandra / a data lake). The query log streams through Kafka. Personalization data (a user's own recent searches) sits in a fast KV store keyed by user.

## 5. High-Level Design

Two decoupled loops. **Online (read):** client (debounced) → CDN/cache → Suggestion Service → in-memory trie shard → return precomputed top-k. **Offline (write):** query log → Kafka → aggregation job computes frequencies → builds/patches the trie → new trie snapshot is pushed to serving nodes. The two only meet through periodic trie snapshots — the query path never touches the aggregation pipeline.

```svg
<svg viewBox="0 0 780 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a4" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="390" y="16" text-anchor="middle" fill="#64748b">Online read path (fast) is decoupled from the offline count/build path (slow)</text>

  <!-- ONLINE -->
  <rect x="20" y="70" width="90" height="44" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="65" y="90" text-anchor="middle" fill="#1e293b">Client</text>
  <text x="65" y="106" text-anchor="middle" fill="#64748b">debounce</text>

  <rect x="150" y="70" width="90" height="44" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="195" y="90" text-anchor="middle" fill="#1e293b">CDN /</text>
  <text x="195" y="106" text-anchor="middle" fill="#1e293b">Cache</text>

  <rect x="280" y="70" width="110" height="44" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="335" y="90" text-anchor="middle" fill="#1e293b">Suggestion</text>
  <text x="335" y="106" text-anchor="middle" fill="#1e293b">Service</text>

  <rect x="430" y="60" width="130" height="64" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="495" y="84" text-anchor="middle" fill="#1e293b">Trie shards</text>
  <text x="495" y="100" text-anchor="middle" fill="#64748b">in-memory,</text>
  <text x="495" y="114" text-anchor="middle" fill="#64748b">top-k per node</text>

  <!-- OFFLINE -->
  <rect x="20" y="250" width="110" height="44" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="75" y="270" text-anchor="middle" fill="#1e293b">Query log</text>
  <text x="75" y="286" text-anchor="middle" fill="#64748b">Kafka</text>

  <rect x="170" y="250" width="120" height="44" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="230" y="270" text-anchor="middle" fill="#1e293b">Aggregation</text>
  <text x="230" y="286" text-anchor="middle" fill="#64748b">freq + decay</text>

  <rect x="330" y="250" width="120" height="44" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="390" y="270" text-anchor="middle" fill="#1e293b">Trie Builder</text>
  <text x="390" y="286" text-anchor="middle" fill="#64748b">top-k select</text>

  <rect x="490" y="250" width="120" height="44" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="550" y="270" text-anchor="middle" fill="#1e293b">Trie snapshot</text>
  <text x="550" y="286" text-anchor="middle" fill="#64748b">versioned</text>

  <!-- online arrows -->
  <line x1="110" y1="92" x2="148" y2="92" stroke="#475569" marker-end="url(#a4)"/>
  <line x1="240" y1="92" x2="278" y2="92" stroke="#475569" marker-end="url(#a4)"/>
  <line x1="390" y1="92" x2="428" y2="92" stroke="#475569" marker-end="url(#a4)"/>

  <!-- offline arrows -->
  <line x1="130" y1="272" x2="168" y2="272" stroke="#475569" marker-end="url(#a4)"/>
  <line x1="290" y1="272" x2="328" y2="272" stroke="#475569" marker-end="url(#a4)"/>
  <line x1="450" y1="272" x2="488" y2="272" stroke="#475569" marker-end="url(#a4)"/>

  <!-- snapshot -> trie -->
  <line x1="550" y1="250" x2="510" y2="126" stroke="#475569" marker-end="url(#a4)" stroke-dasharray="5 3"/>
  <text x="565" y="190" fill="#64748b" font-size="11">push new</text>
  <text x="565" y="205" fill="#64748b" font-size="11">snapshot</text>

  <!-- client logs queries -->
  <line x1="65" y1="114" x2="70" y2="248" stroke="#475569" marker-end="url(#a4)" stroke-dasharray="5 3"/>
  <text x="80" y="180" fill="#64748b" font-size="11">log submitted</text>
  <text x="80" y="195" fill="#64748b" font-size="11">searches</text>
</svg>
```

## 6. Deep Dive

### 6.1 Trie with precomputed top-k

A raw trie gives you all completions under a prefix, but collecting and ranking them at query time is too slow for hot prefixes (a prefix like "a" subtends millions of phrases). The key optimization: **store the top-k completions directly at each node**. Building the trie, you propagate each phrase's frequency up and keep, at every node, a small sorted list of its k best descendant phrases.

```text
Query("har"):
  1. Walk h -> a -> r          (O(prefix length), ~microseconds)
  2. Return node.topK          (O(1), already sorted)
  Total: O(len(prefix)) with NO ranking, NO subtree scan at query time.
```

This turns an expensive subtree aggregation into a constant-time read. The cost moves entirely to **build time**, which is offline and amortized. To bound memory you can also collapse single-child chains (a **radix/compressed trie**) so "harry potter" isn't 12 separate nodes.

### 6.2 Updating counts offline

You never update frequencies on the query hot path — a keystroke lookup must not write. Instead:
1. Every **submitted** search is logged to Kafka (submissions, not keystrokes — that's the signal for popularity).
2. A batch/stream job aggregates frequencies over a window, applying **time decay** (e.g. exponential) so trending queries rise and stale ones fade.
3. A **Trie Builder** recomputes top-k per node and produces a new **versioned trie snapshot**.
4. Snapshots are pushed to serving nodes, which hot-swap the in-memory trie (double-buffer: build the new one, atomically flip the pointer — no read downtime).

Cadence is a freshness/cost trade: full rebuilds hourly/daily, plus a fast path (incremental patch or a small "trending" overlay trie) for breaking queries that need minute-level freshness.

### 6.3 Sharding the trie

The trie doesn't fit on one node and one node can't serve peak QPS, so shard it. Options:

| Strategy | How | Pros | Cons |
|---|---|---|---|
| **By first letter(s) / prefix range** | Shard owns prefixes `a–f`, etc. | Simple routing; a query goes to exactly one shard | **Skew** — some prefixes far hotter ("a", "the"); uneven load |
| **By prefix hash** | Hash the (short) prefix to a shard | Even load distribution | A single logical trie is split arbitrarily; still route by prefix |
| **Replicate hot shards** | Keep N replicas of hot prefix shards | Absorbs skew on popular prefixes | More memory; replica sync |

Practical answer: **shard by prefix**, then **replicate the hot shards** to handle skew (short, common prefixes get more replicas). Route each lookup to the owning shard by its leading characters. Because a lookup only needs the node for its prefix, it's a single-shard read — no scatter-gather.

### 6.4 Caching, debounce & ranking

- **Client debounce (~200 ms):** wait for a typing pause before firing — collapses a burst of keystrokes into one request, slashing QPS and avoiding out-of-order responses. Also cancel in-flight requests when a newer keystroke arrives.
- **Caching:** popular prefixes repeat enormously (Zipfian). Cache prefix→suggestions at the CDN/edge and in a Redis layer with a short TTL; a huge fraction of lookups never reach a trie node.
- **Ranking:** base score is decayed frequency; blend in context (language, region, recency/trending boost). Precompute the base ranking offline; apply light context adjustments online only if they fit the latency budget.

### 6.5 Personalization

Global top-k is the default, but you can blend a user's **own recent searches / history**. Keep per-user recent queries in a fast KV store; at query time, merge the global top-k with the user's matching history (a cheap in-memory merge of two small lists). Keep it light — heavy per-user models blow the latency budget. Personalization is a re-rank/blend on top of the shared trie, never a per-user trie.

## 7. Bottlenecks & Scaling

- **Hot prefix ("a", "the"):** short prefixes dominate traffic. Mitigate with edge/Redis caching (they cache extremely well) and **replicating hot shards**.
- **QPS from keystrokes:** debounce on the client is the single biggest QPS reducer; caching absorbs the rest.
- **Trie memory / rebuild cost:** compress with a radix trie; rebuild incrementally; double-buffer to swap without downtime.
- **Freshness vs cost:** hourly rebuilds are cheap but lag trends; add a small trending overlay for minute-level freshness on breaking terms.
- **Fan-out at query time:** avoided entirely — precomputed top-k means single-node, no subtree scan, no scatter-gather.
- **Cold start after deploy:** warm caches and preload the trie snapshot before taking traffic.

## 8. Failure Scenarios

| Failure | Blast radius | Mitigation |
|---|---|---|
| Trie shard down | Prefixes on that shard return no suggestions | Replicas per shard + failover; degrade gracefully (empty suggestions, box still works) |
| Stale/failed trie build | Suggestions don't reflect recent trends | Keep serving last-good snapshot (versioned); alert on build failures; suggestions being a few hours stale is acceptable |
| Cache layer down | Load slams trie nodes | Trie serves from memory anyway (fast); autoscale suggestion service; request coalescing |
| Hot prefix overload | One shard/replica set saturated | Add replicas of hot shards; heavier edge caching |
| Aggregation pipeline lag | New/trending queries missing | Trending overlay trie for breaking terms; core suggestions unaffected |
| Bad data / spam in counts | Offensive/garbage suggestions | Offline filtering & blocklists in the build step; the offline path is where you sanitize |

## 9. Trade-offs & Alternatives

- **Precomputed top-k vs query-time ranking:** precompute trades build cost and staleness for O(prefix) reads — essential at this QPS. Query-time ranking is fresher but can't meet the latency budget on hot prefixes.
- **Trie vs inverted index / n-gram:** a trie is ideal for *prefix* completion; a full search index (Elasticsearch completion suggester) adds fuzzy/typo tolerance and mid-word matching at higher cost. Use the trie for the fast prefix path and a fuzzy fallback for typos.
- **Shard by range vs hash:** range routing is simpler but skews; hash evens load. We shard by prefix and replicate hot shards to get both.
- **Freshness:** batch rebuild is cheap but lags; a trending overlay buys minute-level freshness where it matters (news/breaking) without rebuilding the whole trie.
- **At 10×:** push more suggestions to the edge (regional trie snapshots at CDN PoPs), split the trie into more shards with weighted replication, and move personalization to a lightweight on-device re-rank.

## 10. Interview Follow-ups

**Q: What's the core data structure and why?**
A: A **trie** keyed by prefix, with the **top-k completions precomputed and stored at each node**. A lookup is O(prefix length) to walk to the node then O(1) to read its list — no subtree scan or ranking at query time, which is what makes sub-50ms possible.

**Q: How do you avoid ranking on the hot path?**
A: All ranking happens offline during the trie build. Each node already holds its sorted top-k, so the online path only reads it. Counting and top-k selection are amortized in the batch pipeline.

**Q: How and when do you update the counts?**
A: Never per query. Submitted searches are logged to Kafka; an offline job aggregates frequencies with time decay and rebuilds a versioned trie snapshot (hourly/daily), plus a small trending overlay for breaking terms. Serving nodes hot-swap snapshots via double-buffering.

**Q: How do you shard the trie?**
A: By prefix (leading characters) so each lookup routes to exactly one shard, then replicate the hot shards to absorb skew — short common prefixes get more replicas. Because top-k is precomputed, it's a single-shard read, no scatter-gather.

**Q: The prefix "a" gets a huge share of traffic — how do you cope?**
A: Short prefixes are extremely cacheable (Zipfian), so edge + Redis caching absorbs most of it, and I replicate the hot shard. The precomputed top-k also means even a hot prefix is an O(1) read.

**Q: How do you reduce the QPS from firing on every keystroke?**
A: Client-side **debounce** (~200ms, fire on a typing pause and cancel in-flight requests) plus aggressive caching of repeated prefixes. Debounce alone can cut lookup volume several-fold.

**Q: How fresh are suggestions, and is that OK?**
A: A few hours stale from batch rebuilds, which is fine — there's no correctness requirement, only relevance. For breaking/trending terms I add a fast trending overlay for minute-level freshness.

**Q: How do you add personalization without blowing the latency budget?**
A: Keep the shared global trie; store per-user recent searches in a fast KV; at query time merge the user's matching history into the global top-k — a cheap merge of two small lists. It's a re-rank/blend, never a per-user trie.

**Q: How do you support typo tolerance?**
A: The trie handles exact prefixes; for fuzzy matching add an edit-distance/n-gram fallback (or an Elasticsearch completion suggester) that runs when the exact-prefix result is thin. Keep the fast trie path primary and the fuzzy path secondary.

**Q: How do you deploy a new trie without downtime?**
A: Double-buffer — build the new trie in memory alongside the live one and atomically flip the pointer. Snapshots are versioned so I can roll back to the last-good build if one is bad.

**Q: How do you keep spam/offensive queries out of suggestions?**
A: Filter in the offline build step with blocklists and quality thresholds. The batch path is exactly where sanitization belongs, so bad data never reaches the served trie.

**Q: Why not just query the search index directly for each prefix?**
A: An inverted index isn't optimized for prefix top-k at 55K QPS with a 20ms budget; you'd rank on every request. The precomputed trie moves that cost offline. The index is the fuzzy fallback, not the primary path.

## 11. Cheat Sheet

> [!TIP]
> **Typeahead in one screen**
> - **Workload:** fires per keystroke, ~55K peak read QPS, sub-50ms. Overwhelmingly reads.
> - **Core structure:** **trie** with **precomputed top-k at each node** → lookup is O(prefix len) walk + O(1) read. No ranking on the hot path.
> - **Updates:** offline — log submitted searches → Kafka → aggregate freq (with time decay) → rebuild **versioned trie snapshot** → hot-swap (double-buffer). Batch, never per query.
> - **Sharding:** by prefix, **replicate hot shards** for skew. Single-shard reads, no scatter-gather.
> - **Client:** **debounce** ~200ms + cancel in-flight; heavy CDN/Redis caching of repeated prefixes.
> - **Personalization:** blend per-user recent searches into global top-k (light re-rank).
> - **Failure stance:** serve last-good snapshot; stale is fine; empty suggestions degrade gracefully.

**References:** System Design Interview (Alex Xu) — Design Search Autocomplete, "Designing Data-Intensive Applications" (batch/stream processing), Elasticsearch completion suggester docs, Google/Amazon search UX engineering write-ups

---
*System Design Handbook — topic 36.*
