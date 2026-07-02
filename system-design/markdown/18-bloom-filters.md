# 18 · Bloom Filters & Probabilistic Structures

> **In one line:** Space-efficient structures that answer set-membership, cardinality, and frequency approximately — trading a tunable, bounded error for orders-of-magnitude less memory.

---

## 1. Overview

Exact answers cost memory. Storing 1 billion 64-byte keys in a hash set to answer "have I seen this?" needs ~64 GB+ of RAM. Often you don't need certainty — you need a **fast, tiny, one-sided** answer: "**definitely not present**, or **probably present**." A **Bloom filter** gives exactly that in ~1–2 bytes per element with a controllable false-positive rate, and it **never** returns a false negative.

Invented by Burton Bloom in **1970**, the Bloom filter is the archetype of **probabilistic (approximate) data structures**: you accept a small, mathematically bounded error to collapse memory and gain speed. The same bargain powers **HyperLogLog** (count distinct in ~1.5 KB for billions of items) and the **Count-Min Sketch** (per-item frequency in fixed space).

Where it earns its keep: **LSM-tree storage** (RocksDB, Cassandra, HBase) checks a per-SSTable Bloom filter before touching disk — a "not present" skips the read entirely, saving most of the I/O for point lookups on missing keys. CDNs and caches use "one-hit-wonder" filters to avoid caching items seen only once. Databases and crawlers use them to deduplicate and to avoid re-fetching URLs. Google Bigtable and Chrome's old malicious-URL check are canonical examples.

Example: Cassandra with a 1% Bloom filter on each SSTable typically avoids >99% of disk reads for keys that don't exist in a given SSTable — turning a cold multi-seek miss into a memory-speed "no."

## 2. Core Concepts

- **Bit array of size m** — all zero initially; the filter's entire state.
- **k independent hash functions** — each maps a key to one of the m bit positions.
- **Insert** — set the k bits `h₁(x)…hₖ(x)` to 1.
- **Query** — if **any** of those k bits is 0 → **definitely not in the set**. If all are 1 → **probably in the set**.
- **No false negatives** — bits are only ever set, never cleared, so a present element's bits are all 1.
- **False positives** — collisions can make an absent element's k bits all happen to be 1; probability is tunable.
- **Tunable error** — pick m and k for a target false-positive rate p given expected item count n.
- **No deletion (in the basic form)** — clearing bits would risk false negatives; use a **Counting Bloom filter** (counters instead of bits) to support removal.
- **Not enumerable** — you cannot list the elements or read a key back out; it only answers membership.
- **Union/intersection** — two filters of equal m,k combine with bitwise OR/AND (union is exact; intersection is approximate).

## 3. Architecture

A key is fanned out by k hashes into k positions of one shared bit array. Query short-circuits to "No" on the first 0 bit.

```svg
<svg viewBox="0 0 720 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="22" text-anchor="middle" fill="#1e293b" font-weight="700">Bloom Filter — insert "x" (k=3) and query "y"</text>
  <!-- insert key -->
  <rect x="30" y="60" width="90" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="75" y="82" text-anchor="middle" fill="#2563eb" font-weight="700">insert x</text>
  <text x="160" y="52" text-anchor="middle" fill="#64748b">k hash fns</text>
  <circle cx="160" cy="77" r="16" fill="#ecfdf5" stroke="#059669"/>
  <text x="160" y="82" text-anchor="middle" fill="#059669">h₁₋₃</text>
  <!-- bit array -->
  <text x="430" y="52" text-anchor="middle" fill="#64748b">bit array (m bits)</text>
  <g font-weight="700" text-anchor="middle">
    <rect x="250" y="60" width="34" height="34" rx="4" fill="#eff6ff" stroke="#475569"/><text x="267" y="82" fill="#1e293b">0</text>
    <rect x="286" y="60" width="34" height="34" rx="4" fill="#ecfdf5" stroke="#059669"/><text x="303" y="82" fill="#059669">1</text>
    <rect x="322" y="60" width="34" height="34" rx="4" fill="#eff6ff" stroke="#475569"/><text x="339" y="82" fill="#1e293b">0</text>
    <rect x="358" y="60" width="34" height="34" rx="4" fill="#ecfdf5" stroke="#059669"/><text x="375" y="82" fill="#059669">1</text>
    <rect x="394" y="60" width="34" height="34" rx="4" fill="#eff6ff" stroke="#475569"/><text x="411" y="82" fill="#1e293b">0</text>
    <rect x="430" y="60" width="34" height="34" rx="4" fill="#eff6ff" stroke="#475569"/><text x="447" y="82" fill="#1e293b">0</text>
    <rect x="466" y="60" width="34" height="34" rx="4" fill="#ecfdf5" stroke="#059669"/><text x="483" y="82" fill="#059669">1</text>
    <rect x="502" y="60" width="34" height="34" rx="4" fill="#eff6ff" stroke="#475569"/><text x="519" y="82" fill="#1e293b">0</text>
    <rect x="538" y="60" width="34" height="34" rx="4" fill="#eff6ff" stroke="#475569"/><text x="555" y="82" fill="#1e293b">0</text>
  </g>
  <!-- insert arrows -->
  <path d="M176 77 C210 77 250 77 300 66" fill="none" stroke="#059669" stroke-width="1.5" marker-end="url(#a)"/>
  <path d="M176 80 C220 110 330 110 372 92" fill="none" stroke="#059669" stroke-width="1.5" marker-end="url(#a)"/>
  <path d="M176 84 C260 150 440 130 480 92" fill="none" stroke="#059669" stroke-width="1.5" marker-end="url(#a)"/>
  <text x="150" y="112" fill="#059669">sets bits 1,3,6</text>
  <!-- query -->
  <rect x="30" y="210" width="90" height="34" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="75" y="232" text-anchor="middle" fill="#d97706" font-weight="700">query y</text>
  <text x="360" y="185" text-anchor="middle" fill="#1e293b">y → bits {1, 3, 8}. bit 8 = 0 → <tspan fill="#b91c1c" font-weight="700">DEFINITELY NOT PRESENT</tspan></text>
  <path d="M120 227 C300 240 470 200 540 96" fill="none" stroke="#d97706" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#a)"/>
  <text x="360" y="270" text-anchor="middle" fill="#64748b">Any 0 bit ⇒ No (never wrong). All 1 bits ⇒ "probably yes" (small false-positive p).</text>
</svg>
```

## 4. How It Works

1. **Size the filter.** Given expected item count **n** and target false-positive rate **p**, compute bit-array size `m = −n·ln p / (ln 2)²` and hash count `k = (m/n)·ln 2` (round to nearest int).
2. **Allocate** m bits, all 0. Pick k hash functions (in practice, derive k values cheaply from two hashes: `gᵢ(x) = h₁(x) + i·h₂(x) mod m` — Kirsch–Mitzenmacher double hashing).
3. **Insert x.** For `i` in `1..k`, set bit `hᵢ(x)` to 1. Idempotent; already-set bits stay 1.
4. **Query y.** For `i` in `1..k`, if bit `hᵢ(y)` is 0 → return **No** (short-circuit). If all are 1 → return **Maybe** (treat as yes, then verify against the real source if needed).
5. **On "Maybe", optionally verify.** In an LSM store, "maybe present" means actually read the SSTable; the Bloom filter only saved you when it said "No."
6. **Watch fill ratio.** As n approaches capacity, more bits are 1 and p rises. When ~half the bits are set you're near design capacity — rebuild a larger filter or use a scalable/partitioned variant.

```text
FP math (intuition): with k hashes over m bits after n inserts,
  P(a given bit still 0) ≈ e^(-kn/m)
  false positive p ≈ (1 - e^(-kn/m))^k
  optimal k = (m/n) ln 2  →  bits/element ≈ -1.44 · log2(p)
Rules of thumb:  p=1%  ≈ 9.6 bits/elem, k≈7
                 p=0.1% ≈ 14.4 bits/elem, k≈10
```

## 5. Key Components / Deep Dive

### The size/error math intuition
Each insert sets k bits. After n items, the chance a specific bit is still 0 is `e^(−kn/m)`. A false positive needs all k queried bits to be 1: `p ≈ (1 − e^(−kn/m))^k`. Minimizing over k gives **k = (m/n)·ln2**, at which point exactly **half the bits are set**. Substituting yields the clean result **bits per element ≈ −1.44·log₂(p)**, *independent of n*. So 1% costs ~9.6 bits/element and each 10× reduction in p costs only ~4.8 more bits — error shrinks exponentially in space. Note k trades CPU (more hashes) for space; too-large k actually *raises* p by filling bits faster.

### Variants
- **Counting Bloom filter** — replace each bit with a small counter (e.g. 4 bits); increment on insert, decrement on delete → supports **removal** at ~4× the space.
- **Scalable Bloom filter** — chain filters of growing size when n is unknown, keeping compound p bounded.
- **Blocked Bloom filter** — pack each element's k bits into one cache line → far fewer cache misses (used in RocksDB for speed).
- **Cuckoo filter** — stores fingerprints in a cuckoo hash; supports **deletion**, similar space, and often better lookup locality; slightly better than Bloom below ~3% error.

### HyperLogLog — cardinality (count-distinct)
Estimates the number of **distinct** elements using the observation that in random hashes, seeing a value with **ρ leading zeros** hints the set has ~2^ρ distinct items. HLL splits the hash into a register index + a run-of-zeros value, keeps the max per register, and harmonic-means across registers. **~1.5 KB gives ~2% error for cardinalities into the billions.** Registers merge by taking the max → mergeable across shards. This is Redis `PFADD`/`PFCOUNT`; used for unique visitors, distinct query counts, etc.

### Count-Min Sketch — frequency
A 2D array of `d` rows × `w` counters with `d` hash functions. Increment `CM[i][hᵢ(x)]` for each row on every occurrence; **estimate** a key's count as the **min** across its d cells. It **overestimates** (collisions only add), never underestimates — the dual of Bloom's one-sidedness. Fixed space regardless of stream size; great for **heavy hitters / top-K**, rate-limiting, and traffic analytics on unbounded streams.

## 6. Trade-offs

| Structure | Answers | Error direction | Typical space | Delete? |
|---|---|---|---|---|
| **Hash set** (exact) | membership | none | O(n·keysize) | yes |
| **Bloom filter** | membership | false positives only | ~1.2 B/elem @2%, ~1.8 @0.1% | no |
| **Counting Bloom** | membership | false positives only | ~4× Bloom | yes |
| **Cuckoo filter** | membership | false positives only | ≈ Bloom, better @ low p | yes |
| **HyperLogLog** | cardinality | ±~2% relative | ~1.5 KB fixed | no (mergeable) |
| **Count-Min Sketch** | frequency | over-estimates only | fixed (w×d) | via conservative update |

The through-line: **give up exactness and enumeration to make space independent of (or tiny relative to) n.** Bloom trades memory for a one-sided membership answer; HLL and CMS make the space *constant* for counting problems.

## 7. When to Use / When to Avoid

**Use when:**
- Membership checks where a **cheap "definitely no"** avoids an expensive lookup (LSM/SSTable read skip, disk, network, cache).
- **Dedup** at scale — seen-URLs in a crawler, at-least-once event dedup pre-filter, one-hit-wonder cache admission.
- **Count-distinct** over huge/streaming sets where ±2% is fine (unique visitors) → HyperLogLog.
- **Frequency / heavy-hitters** on unbounded streams (top queries, abusive IPs) → Count-Min Sketch.
- Memory is the binding constraint and a small, **bounded** error is acceptable.

**Avoid when:**
- You need **certainty** (auth, billing correctness) without a verifying backing store.
- You must **enumerate** or read values back — these structures can't.
- Frequent **deletions** and you can't afford counting variants (basic Bloom can't delete).
- The set is **small** enough that an exact hash set is trivial — don't add error for nothing.
- A false positive is **catastrophic** and unverifiable downstream.

## 8. Scaling & Production Best Practices

- **Right-size up front:** compute m,k from a *realistic* n and target p. Over-filling silently degrades p — a filter built for 1M items holding 5M may be ~40% false positives.
- **Reserve headroom** (design for peak n × 1.3); rebuild or use **scalable** Bloom when n is unknown.
- **Use double hashing** (`h1 + i·h2`) to get k indices from 2 hashes — same accuracy, cheaper CPU.
- **Blocked/cache-line layout** for hot lookup paths (RocksDB) to cut cache misses.
- **Persist and version filters** alongside data (SSTable Bloom filters are written with the file); tune bits/key per level — cold levels warrant bigger filters.
- **Shard-merge HLL/CMS**: compute per-shard, merge centrally (HLL = per-register max; CMS = elementwise sum) for cluster-wide counts without shipping raw data.
- **Size CMS for tail collisions**: `w = e/ε`, `d = ln(1/δ)`; use **conservative update** to cut overestimation of light keys.
- Budget memory concretely: 100M keys @1% ≈ 120 MB; @0.1% ≈ 180 MB — fits in RAM, guards TB of disk.

## 9. Failure Modes & Mitigations

| Failure | Impact | Mitigation |
|---|---|---|
| Over-capacity (n ≫ design) | p balloons, "no" rarely returned, filter useless | Size for peak; monitor fill ratio; rebuild/scale |
| Correlated / weak hashes | Real p far above target | Independent hashes; double hashing; test distribution |
| Treating "maybe" as "yes" without verify | False accepts (serve wrong / skip needed read) | Verify against source of truth on positive |
| Trying to delete from basic Bloom | False negatives corrupt correctness | Counting Bloom or Cuckoo filter |
| HLL on small cardinalities | Large relative error | Linear-counting correction (Redis does this) for low n |
| CMS heavy skew | Small keys overcounted by hot keys | More width, conservative update, min across rows |
| Filter/data version skew | Stale filter misjudges membership | Version + rebuild filter with its data segment |

## 10. Monitoring & Metrics

- **Actual vs target false-positive rate** — sample by verifying a fraction of "maybe" answers against ground truth.
- **Fill ratio** (fraction of bits set) — approaching 0.5 means at design capacity; >0.5 means degrade.
- **Element count vs design n** — alert before overfill.
- **Bloom hit/skip effectiveness** — in LSM, % of point lookups skipped by "no"; falling ratio flags mis-sized filters.
- **Memory footprint** per filter and aggregate.
- **HLL relative error / register saturation**; **CMS overestimation** on sampled keys.
- Lookup latency / cache-miss rate on the filter (for blocked variants).

## 11. Common Mistakes

1. ⚠️ **Under-sizing** — building for optimistic n, then blowing past target p as data grows.
2. ⚠️ **Believing "probably present"** and skipping the verifying read where correctness matters.
3. ⚠️ **Deleting from a basic Bloom filter** by clearing bits → false negatives (silent data loss of "seen" state).
4. ⚠️ **Using weak or correlated hash functions**, so measured p far exceeds theory.
5. ⚠️ **Cranking k too high** thinking more hashes = fewer FPs — past optimal it fills bits faster and *raises* p.
6. ⚠️ **Using Bloom for cardinality or frequency** — wrong tool; use HyperLogLog / Count-Min Sketch.
7. ⚠️ **Ignoring HLL's poor accuracy at tiny cardinalities** without the linear-counting correction.
8. ⚠️ **Forgetting a false positive has a real cost** (an extra disk read, a wrongly-skipped cache) and not budgeting for it.

## 12. Interview Questions

**Q: How does a Bloom filter answer membership, and why no false negatives?**
A: Insert sets k hashed bits to 1; query returns No if any of the k bits is 0, else Maybe. Bits are only ever set, so a present element's bits are guaranteed 1 — a false negative is impossible. Collisions can cause false positives.

**Q: How do you choose m and k for a target false-positive rate?**
A: `m = −n·ln p / (ln2)²` and `k = (m/n)·ln2`. Equivalently ~−1.44·log₂(p) bits per element; ~9.6 bits/elem for 1%.

**Q: Why can't you delete from a standard Bloom filter?**
A: Clearing a bit might zero a bit shared by another present element, creating a false negative. Use a **Counting Bloom filter** (counters, decrement on delete) or a **Cuckoo filter**.

**Q: Give a concrete production use.**
A: LSM stores (RocksDB, Cassandra, HBase) keep a per-SSTable Bloom filter; on a point lookup they consult it first and skip the disk read when it says "not present," avoiding most I/O for missing keys.

**Q: What does HyperLogLog do and roughly how?**
A: Estimates distinct-count. It uses the max run of leading zeros in hashed values across many registers (harmonic-mean averaged); ~1.5 KB gives ~2% error into the billions, and registers merge by max across shards.

**Q: When would you reach for a Count-Min Sketch?**
A: Per-item frequency / heavy hitters on an unbounded stream in fixed space — e.g. top queries or abusive IPs. It overestimates (never under), taking the min across d rows.

**Q (senior): Your Cassandra read latency crept up despite Bloom filters. What happened?**
A: Likely the filters are over capacity (SSTables grew, n ≫ design), so false-positive rate rose and "no" rarely fires → more disk reads. Check bloom_filter_fp_ratio, per-SSTable false-positive rate, and tune bits/key or trigger compaction to consolidate.

**Q (senior): Compare Bloom vs Cuckoo filter for a dedup service.**
A: Bloom: simplest, no deletes, slightly more space at low p, great cache behavior with blocked layout. Cuckoo: supports deletion, comparable/less space below ~3% error, better lookup locality, but insert can fail (needs resize) under high load. Choose Cuckoo if you must delete/expire entries; Bloom if append-only.

**Q (senior): How do you compute cluster-wide unique visitors across 100 shards cheaply?**
A: Each shard maintains an HLL; merge by taking the per-register maximum into one HLL, then estimate. O(registers) network, ~2% error, no raw IDs shipped — vastly cheaper than a global distinct.

**Q (senior): A false positive here triggers an expensive fraud re-check. How do you reason about the rate?**
A: Model total cost = p × (cost of a false-positive action) × query volume, and size m,k so that cost is acceptable — false-positive rate drops ~exponentially with a linear bits/element increase, so you can often buy an order-of-magnitude fewer FPs for a few more bits per key.

**Q (senior): Why does increasing k eventually hurt?**
A: More hashes set more bits per insert, filling the array faster; past k=(m/n)ln2 the higher fill dominates and the collision probability — hence p — rises again. There's an optimal k for given m,n.

**Q (senior): How do Bloom filters interact with an at-least-once pipeline for dedup?**
A: Use the filter as a cheap pre-filter: "definitely new" skips the dedup store; "maybe seen" falls through to an exact check (dedup table). It slashes load on the exact store while correctness is preserved by the verifying lookup — see **Idempotency, Exactly-Once & Deduplication**.

## 13. Alternatives & Related

- **Cuckoo filter / Counting Bloom** — deletable membership variants.
- **HyperLogLog** — approximate cardinality (Redis PF*, analytics).
- **Count-Min Sketch / heavy hitters** — approximate frequency on streams.
- **Consistent Hashing** — pairs with Bloom filters in Dynamo/Cassandra read paths.
- **Caching** — one-hit-wonder admission filters.
- **Idempotency & Deduplication** — Bloom as a pre-filter before an exact dedup table.

## 14. Cheat Sheet

> [!TIP]
> **Probabilistic structures in 8 lines**
> - **Bloom** = set k bits; any 0 ⇒ *definitely no*, all 1 ⇒ *probably yes*. **No false negatives.**
> - Size: `m=−n·ln p/(ln2)²`, `k=(m/n)ln2` → **~−1.44·log₂(p) bits/elem** (1%≈9.6, 0.1%≈14.4).
> - Error falls **exponentially** in space; optimal k sets ~half the bits.
> - **Can't delete or enumerate** basic Bloom → use **Counting Bloom / Cuckoo** to delete.
> - **Use:** LSM read-skip, cache admission, dedup pre-filter.
> - **HyperLogLog** = count-distinct, ~1.5 KB, ~2% err, merge by max.
> - **Count-Min Sketch** = frequency/heavy-hitters, fixed space, **over**-estimates (take min).
> - Over-filling silently wrecks p — size for peak, monitor fill ratio.

**References:** Bloom (1970) "Space/Time Trade-offs in Hash Coding with Allowable Errors", DDIA ch.3 (LSM & Bloom filters), Flajolet et al. "HyperLogLog", Cormode & Muthukrishnan "Count-Min Sketch", RocksDB Wiki (Bloom filters)

---
*System Design Handbook — topic 18.*
