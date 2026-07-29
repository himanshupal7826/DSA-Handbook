# 20 · HyperLogLog, Bitmaps & Probabilistic Caching

> **In one line:** When the exact answer costs gigabytes and a 1%-wrong answer costs kilobytes, take the kilobytes — HyperLogLog counts unique things in ~12 KB regardless of scale, bitmaps pack one boolean per id into a bit array, and the whole art is knowing which questions tolerate approximation (analytics, dashboards) and which never do (billing, correctness).

---

## 1. Overview

Some caching questions are ruinously expensive to answer exactly. "How many unique visitors did we have today?" answered precisely means storing every distinct visitor id — for 100 million uniques, that is gigabytes of set membership, just to produce a single number. "Which of our 50 million users were active today?" answered as a set of ids is tens of megabytes for a fact that is really one bit per user. In both cases the *exact* machinery is enormously larger than the *answer*, and that mismatch is exactly where probabilistic and bit-packed structures win.

Redis ships three tools for this. **HyperLogLog** estimates *cardinality* — the number of distinct items — in a fixed ~12 KB no matter whether you counted a thousand items or a billion, with a standard error around 0.81%. **Bitmaps** treat a string as an array of bits, so a yes/no fact about each of millions of ids costs one bit each — 50 million flags in about 6 MB — and `BITCOUNT` totals them in one command. And **Bloom filters** (via RedisBloom, covered in the caching context in chapter 16) answer "have I seen this before?" with no false negatives and a tunable false-positive rate, in a fraction of a set's memory — the classic guard that stops cache-penetration queries from ever reaching the database.

The organising principle of this chapter is a single judgement: *when is approximate good enough?* For analytics, dashboards, trend lines, capacity planning, and abuse heuristics, a 1% error is invisible and the memory saving is transformative. For billing, quotas you charge against, correctness-critical dedup, and anything a customer will dispute, approximate is unacceptable and you pay for exact. Getting that judgement right — and reaching for the tiny structure whenever it is — is what separates a cache that scales cheaply from one that hoards ids it never needed to keep.

## 2. Core Concepts

- **Cardinality** — the number of *distinct* elements in a multiset; "unique visitors", "distinct search terms". Expensive to compute exactly at scale.
- **HyperLogLog (HLL)** — a probabilistic cardinality estimator using ~12 KB for any count, with ~0.81% standard error; commands `PFADD`, `PFCOUNT`, `PFMERGE`.
- **Bitmap** — a Redis string addressed as an array of bits; `SETBIT`/`GETBIT` flip and read a bit, `BITCOUNT` totals the set bits, `BITOP` combines bitmaps.
- **BITFIELD** — treats a bitmap as packed integers of arbitrary width, for compact counters (e.g. millions of small per-id counters in one key).
- **Bloom filter** — a probabilistic set-membership structure: no false negatives, tunable false positives, tiny memory; a cache-penetration guard (chapter 16).
- **Standard error** — HLL's typical relative error (~0.81% at the default precision); the accuracy you trade memory for.
- **Registers / buckets** — HLL's internal array of small counters, each holding the maximum leading-zero run seen for items hashed to it.
- **`PFMERGE`** — union of HyperLogLogs: merge daily HLLs into a weekly/monthly unique count with no double-counting, still ~12 KB.
- **`BITOP`** — bitwise AND/OR/XOR/NOT across bitmaps: "users active on both day A and day B" is one server-side `BITOP AND` + `BITCOUNT`.
- **Dense vs sparse HLL** — Redis stores an HLL sparsely when the count is small (well under 12 KB) and switches to the dense 12 KB layout as it grows.
- **Overflow behaviour** — `BITFIELD` overflow modes (`WRAP`, `SAT`, `FAIL`) decide what happens when a packed counter exceeds its width; `SAT` (saturate) is usually what a bounded counter wants.
- **Count-Min sketch** — a sibling sketch (RedisBloom `CMS.*`) estimating per-item *frequencies* in fixed memory, complementing HLL (distinct counts) and Bloom (membership).
- **Retention rollup** — pre-merging fine-grained period keys (daily HLLs, daily bitmaps) into coarser ones (weekly, monthly) with `PFMERGE`/`BITOP`, run off the request path and cached.

## 3. Theory & Principles

### HyperLogLog: counting distinct things with leading zeros

HyperLogLog answers "how many *distinct* items have I seen?" without storing the items. The intuition is beautiful. Hash each item to a uniformly-random bit string. In a stream of random bit strings, seeing one that begins with many leading zeros is rare in proportion to how many you have drawn: a string starting with `k` zeros appears roughly once every `2^k` draws. So the *maximum* number of leading zeros you have observed is a (very noisy) estimate of the log of the cardinality — if you have seen a run of 20 leading zeros, you have probably drawn on the order of a million items.

A single such estimate is far too noisy to be useful, so HyperLogLog does two things. First, it uses the first few bits of each hash to distribute items across many **registers** (Redis uses 16,384 of them), each tracking the maximum leading-zero run for the items that fell into it — this is *stochastic averaging*, turning one noisy estimator into thousands. Second, it combines the registers with a **harmonic mean** (which tames the outliers that a plain average would be dominated by) and applies bias corrections. The result is a cardinality estimate with a standard error of about **0.81%**, using a fixed **~12 KB** — because it stores 16,384 small registers, not the items. Count a thousand things or a billion, the memory is the same; only the accuracy of the estimate is bounded, not the scale.

Three properties make HLL a caching workhorse. It is **fixed-size** (budget it once), it is **mergeable** (`PFMERGE` unions two HLLs into their combined distinct count with no double-counting — so daily HLLs roll up into a monthly unique count), and it is **cheap to update** (`PFADD` is O(1)). What you give up is the ability to enumerate the members (it never stored them) and exactness (the count is an estimate). For "how many unique X", that is a trade you almost always want at scale.

A practical detail worth knowing: Redis does not always use the full 12 KB. It keeps a **sparse** representation while the cardinality is small — storing only the non-zero registers, which for a few hundred distinct items is a handful of bytes — and transparently upgrades to the **dense** 16,384-register layout as the count grows. So a key that will eventually count millions starts tiny and grows to ~12 KB, which matters when you keep one HLL per fine-grained dimension (per-page, per-campaign) and most of them stay small. The `HLL_SPARSE_MAX_BYTES` config governs the switchover. The error is also not uniform: the ~0.81% figure is the *standard* error at the dense representation, and Redis applies bias correction at very small and very large cardinalities where the raw estimator is skewed, so the relative accuracy holds across the whole range rather than degrading at the extremes.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">HyperLogLog: estimate cardinality from leading-zero runs, in ~12 KB</text>

  <rect x="24" y="42" width="832" height="150" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="440" y="62" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">1. Hash each item &#8594; use first bits to pick a register, count leading zeros of the rest</text>
  <g font-family="ui-monospace,monospace" font-size="9">
    <rect x="44" y="78" width="360" height="20" rx="3" fill="#fff" stroke="#93c5fd"/><text x="52" y="92" fill="#1d4ed8">hash("ada@x.com")  = 0110 | 0001011...  &#8594; reg 6, lz=3</text>
    <rect x="44" y="102" width="360" height="20" rx="3" fill="#fff" stroke="#93c5fd"/><text x="52" y="116" fill="#1d4ed8">hash("bob@x.com")  = 1010 | 0000001...  &#8594; reg 10, lz=6</text>
    <rect x="44" y="126" width="360" height="20" rx="3" fill="#fff" stroke="#93c5fd"/><text x="52" y="140" fill="#1d4ed8">hash("ada@x.com")  = 0110 | 0001011...  &#8594; reg 6, lz=3 (dup)</text>
  </g>
  <text x="440" y="164" fill="#1e40af" font-size="9" font-weight="bold">A run of k leading zeros appears ~once per 2^k distinct items &#8594; rarity encodes scale.</text>
  <text x="440" y="180" fill="#1d4ed8" font-size="9">Duplicates don't change a register's max &#8594; the same item never inflates the count.</text>

  <rect x="24" y="204" width="410" height="150" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="229" y="226" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">2. 16,384 registers, each = max lz seen</text>
  <g font-family="ui-monospace,monospace" font-size="9">
    <rect x="44" y="240" width="34" height="24" fill="#bbf7d0" stroke="#16a34a"/><text x="61" y="256" text-anchor="middle" fill="#14532d">3</text>
    <rect x="80" y="240" width="34" height="24" fill="#bbf7d0" stroke="#16a34a"/><text x="97" y="256" text-anchor="middle" fill="#14532d">1</text>
    <rect x="116" y="240" width="34" height="24" fill="#bbf7d0" stroke="#16a34a"/><text x="133" y="256" text-anchor="middle" fill="#14532d">6</text>
    <rect x="152" y="240" width="34" height="24" fill="#bbf7d0" stroke="#16a34a"/><text x="169" y="256" text-anchor="middle" fill="#14532d">2</text>
    <rect x="188" y="240" width="34" height="24" fill="#bbf7d0" stroke="#16a34a"/><text x="205" y="256" text-anchor="middle" fill="#14532d">4</text>
    <rect x="224" y="240" width="34" height="24" fill="#bbf7d0" stroke="#16a34a"/><text x="241" y="256" text-anchor="middle" fill="#14532d">1</text>
    <rect x="260" y="240" width="34" height="24" fill="#bbf7d0" stroke="#16a34a"/><text x="277" y="256" text-anchor="middle" fill="#14532d">5</text>
    <text x="316" y="256" fill="#166534" font-family="ui-sans-serif,system-ui,sans-serif">... 16,384</text>
  </g>
  <text x="229" y="292" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">harmonic mean of registers &#8594; estimate</text>
  <text x="44" y="316" fill="#166534" font-size="9">stochastic averaging tames the noise of a single estimator;</text>
  <text x="44" y="332" fill="#166534" font-size="9">harmonic mean tames outliers; bias correction at the ends.</text>
  <text x="44" y="348" fill="#15803d" font-size="9" font-weight="bold">std error ~0.81% at 16,384 registers</text>

  <rect x="446" y="204" width="410" height="150" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="651" y="226" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">3. Fixed ~12 KB, any cardinality</text>
  <text x="466" y="250" fill="#475569" font-size="10">PFADD hll item        (O(1) update)</text>
  <text x="466" y="270" fill="#475569" font-size="10">PFCOUNT hll           (estimate)</text>
  <text x="466" y="290" fill="#475569" font-size="10">PFMERGE all d1 d2 d3  (union, no double-count)</text>
  <rect x="466" y="304" width="370" height="40" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="651" y="322" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">100M uniques &#8594; 12 KB   (a set &#8594; ~GBs)</text>
  <text x="651" y="338" text-anchor="middle" fill="#166534" font-size="9">trade: no enumeration, ~0.81% error</text>

  <rect x="24" y="366" width="832" height="90" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="440" y="388" text-anchor="middle" fill="#92400e" font-size="12" font-weight="bold">When approximate is fine vs when it isn't</text>
  <text x="240" y="412" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">FINE (approximate OK)</text>
  <text x="240" y="430" text-anchor="middle" fill="#166534" font-size="9">analytics, dashboards, trends,</text>
  <text x="240" y="444" text-anchor="middle" fill="#166534" font-size="9">capacity planning, abuse heuristics</text>
  <line x1="440" y1="400" x2="440" y2="450" stroke="#d97706" stroke-width="1.5"/>
  <text x="640" y="412" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">NOT FINE (need exact)</text>
  <text x="640" y="430" text-anchor="middle" fill="#991b1b" font-size="9">billing, metered quotas you charge,</text>
  <text x="640" y="444" text-anchor="middle" fill="#991b1b" font-size="9">correctness-critical dedup, disputes</text>
</svg>
```

### Bitmaps: one bit per id

A bitmap is not a separate type — it is a Redis string you address by bit position with `SETBIT key offset 0|1` and `GETBIT key offset`. That makes it the perfect home for a dense boolean fact indexed by a small integer id: "did user N do X today?" is bit N of a per-day key. Fifty million users' daily-active flags occupy 50 million bits ≈ **6 MB** — a rounding error compared to storing 50 million ids in a set. `BITCOUNT` returns the number of set bits (the daily-active total) in one command, and `BITOP AND/OR/XOR/NOT` combines bitmaps server-side, so "users active on *both* Monday and Tuesday" is `BITOP AND result mon tue` then `BITCOUNT result` — retention analytics with no application-side set intersection.

Bitmaps are exact (unlike HLL) — every bit is a real fact — but they are only cheap when the ids are dense small integers. If ids are sparse (bit 4 billion set, everything else zero) the bitmap allocates up to that offset and wastes space; and if the "fact" needs more than a boolean, you want `BITFIELD`, which packs arbitrary-width integers into the string (millions of tiny per-id counters in one key). The rule: bitmaps for dense boolean-per-id facts with small contiguous ids; map external ids to a dense integer space first if they are not already.

`BITFIELD` deserves a moment because it generalises the bitmap from one bit to arbitrary-width packed integers. `BITFIELD counters SET u8 #42 200` treats the string as an array of unsigned 8-bit slots and writes 200 into slot 42; `INCRBY u8 #42 1` bumps it with optional overflow behaviour (`WRAP`, `SAT` to saturate at the max, or `FAIL`). This lets you hold, say, a small per-user counter (0–255 events) for tens of millions of users in a single key at one byte each — far cheaper than tens of millions of separate integer keys, each paying full key overhead. It is the same memory-density argument as the Instagram hash technique from chapter 18, applied to fixed-width numeric facts: pack many tiny values into one string and address them by offset. The trade, as with any big string, is that the whole thing is one key on one Cluster slot, so size it and shard it deliberately.

### Bloom filters as a caching guard

A Bloom filter answers set membership — "is X in the set?" — with a critical asymmetry: it can say "definitely not" or "probably yes", never a false negative. That is exactly the shape of a **cache-penetration guard**. Cache penetration is when requests for keys that do not exist anywhere sail through the cache (a miss) and hammer the database (another miss), repeatedly. A Bloom filter of all *valid* keys sits in front: if the filter says "definitely not present", you reject instantly without touching the database; if it says "probably present", you proceed to the cache/DB as normal. The false positives cost only an occasional unnecessary lookup; the false negatives — which would be catastrophic (rejecting a real key) — cannot happen. This is covered in the cache-penetration context in chapter 16; here the point is that it is another member of the same family — trade a little accuracy for a large memory saving on a question where the error is tolerable in one direction.

## 4. Architecture & Workflow

### Choosing a probabilistic structure

The decision procedure:

1. **Do you need a unique *count* but not the members?** → **HyperLogLog**. `PFADD` on each item, `PFCOUNT` for the estimate, `PFMERGE` to roll up periods. ~12 KB, ~0.81% error, no enumeration.
2. **Is the fact a boolean per small-integer id?** → **Bitmap**. `SETBIT`/`GETBIT`, `BITCOUNT` to total, `BITOP` to combine days/segments. Exact, ~1 bit per id, dense ids only.
3. **Do you need small per-id counters, packed tight?** → **BITFIELD**. Arbitrary-width integers in one string.
4. **Do you need "have I seen this?" as a guard, tolerating rare false positives?** → **Bloom filter** (RedisBloom). No false negatives, tiny memory, the cache-penetration defence.
5. **Does the answer feed billing, quotas you charge, or anything disputable?** → **exact structures** (sets, precise counters). Do not approximate money.

The workflow for the two headline cases:

- **Unique visitors:** one HLL per period (`visitors:2026-07-29`), `PFADD` the visitor id on each request (idempotent — duplicates don't inflate the count), `PFCOUNT` for today's uniques, `PFMERGE` the daily HLLs for a weekly/monthly figure. Total memory: ~12 KB per day, a handful of KB for a year of rollups.
- **Daily active users:** one bitmap per day (`active:2026-07-29`), `SETBIT` the user's integer id on activity, `BITCOUNT` for the DAU, `BITOP AND` across consecutive days for retention (users active both days). ~6 MB per day for 50M users, trivially combinable.

### Memory: the comparison that decides it

The whole reason these structures exist is the memory gap, so it is worth stating concretely. To count 100 million unique visitors: a `SET` of 100M ~20-byte ids is roughly **2–4 GB** (ids plus set overhead); an HLL is **12 KB** — a ratio of about 200,000:1, for a 0.81% error. To track daily-active for 50 million users: a `SET` of the active ids is tens of MB and varies with the active count; a bitmap is a fixed **~6 MB** and is exact. The structures are not merely a little cheaper — they change the order of magnitude of what a cache can hold, which is why "unique counts" and "boolean-per-id" facts belong in HLLs and bitmaps by default at scale.

```svg
<svg viewBox="0 0 880 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The memory gap that decides it (100M items / 50M ids)</text>

  <rect x="24" y="42" width="832" height="176" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="64" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Counting 100M unique visitors</text>

  <text x="60" y="96" fill="#b91c1c" font-size="10" font-weight="bold">SET of ids (exact + enumerable)</text>
  <rect x="60" y="104" width="700" height="30" rx="4" fill="#fca5a5" stroke="#dc2626"/>
  <text x="410" y="124" text-anchor="middle" fill="#7f1d1d" font-size="11" font-weight="bold">~2&#8211;4 GB</text>
  <text x="770" y="124" fill="#991b1b" font-size="9">stores every id</text>

  <text x="60" y="160" fill="#15803d" font-size="10" font-weight="bold">HyperLogLog (estimate, ~0.81% error)</text>
  <rect x="60" y="168" width="6" height="30" rx="2" fill="#86efac" stroke="#16a34a"/>
  <text x="80" y="188" fill="#14532d" font-size="11" font-weight="bold">~12 KB</text>
  <text x="200" y="188" fill="#166534" font-size="9">&#8594; ratio ~200,000 : 1  &#8212; a sliver of a pixel at this scale</text>
  <text x="60" y="212" fill="#64748b" font-size="9">give up: enumeration &amp; exactness. keep: the count, mergeable across periods.</text>

  <rect x="24" y="230" width="832" height="176" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="252" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Tracking 50M users' daily-active flag</text>

  <text x="60" y="284" fill="#b91c1c" font-size="10" font-weight="bold">SET of active ids (exact, varies with active count)</text>
  <rect x="60" y="292" width="360" height="30" rx="4" fill="#fca5a5" stroke="#dc2626"/>
  <text x="240" y="312" text-anchor="middle" fill="#7f1d1d" font-size="11" font-weight="bold">tens of MB</text>

  <text x="60" y="348" fill="#15803d" font-size="10" font-weight="bold">Bitmap, one bit per id (EXACT, not approximate)</text>
  <rect x="60" y="356" width="60" height="30" rx="4" fill="#86efac" stroke="#16a34a"/>
  <text x="90" y="376" text-anchor="middle" fill="#14532d" font-size="11" font-weight="bold">~6 MB</text>
  <text x="200" y="376" fill="#166534" font-size="9">fixed size, BITCOUNT totals it, BITOP AND gives retention</text>
  <text x="60" y="398" fill="#64748b" font-size="9">requirement: dense small-integer ids (map external ids into a contiguous space first)</text>
</svg>
```

## 5. Implementation

Real go-redis implementations: unique-visitor counting with HyperLogLog (including rollups) and daily-active tracking with bitmaps (including retention).

```go
package probabilistic

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// ---------- HYPERLOGLOG: unique visitors ----------

// hllKey names the per-day HLL, e.g. "visitors:2026-07-29".
func hllKey(day time.Time) string {
	return "visitors:" + day.Format("2006-01-02")
}

// RecordVisitor adds a visitor to today's HLL. PFADD is O(1) and idempotent:
// adding the same id twice does NOT change the count, because a duplicate never
// raises any register's max leading-zero run. So we never need to dedup ourselves.
func RecordVisitor(ctx context.Context, rdb *redis.Client, day time.Time, visitorID string) error {
	key := hllKey(day)
	if err := rdb.PFAdd(ctx, key, visitorID).Err(); err != nil {
		return err
	}
	// The HLL is a disposable analytics artefact — give it a retention TTL.
	return rdb.Expire(ctx, key, 90*24*time.Hour).Err()
}

// UniqueVisitors returns today's estimated unique count in ~12 KB, ~0.81% error.
// Contrast: a set of ids would cost gigabytes to answer the same question.
func UniqueVisitors(ctx context.Context, rdb *redis.Client, day time.Time) (int64, error) {
	return rdb.PFCount(ctx, hllKey(day)).Result()
}

// UniqueVisitorsInRange rolls up a span of days into ONE distinct count using
// PFMERGE. The union is exact set-union semantics on the estimators: a visitor
// who came on three days is counted ONCE across the merged HLL — no
// double-counting, still ~12 KB, still ~0.81% error.
func UniqueVisitorsInRange(ctx context.Context, rdb *redis.Client, start time.Time, days int) (int64, error) {
	keys := make([]string, 0, days)
	for i := 0; i < days; i++ {
		keys = append(keys, hllKey(start.AddDate(0, 0, i)))
	}
	dest := fmt.Sprintf("visitors:range:%s:%dd", start.Format("2006-01-02"), days)
	// PFMERGE dest src1 src2 ... unions the source HLLs into dest.
	if err := rdb.PFMerge(ctx, dest, keys...).Err(); err != nil {
		return 0, err
	}
	rdb.Expire(ctx, dest, time.Hour) // the merged rollup is transient
	return rdb.PFCount(ctx, dest).Result()
}

// ---------- BITMAP: daily-active users ----------

// dauKey names the per-day activity bitmap, e.g. "active:2026-07-29".
func dauKey(day time.Time) string {
	return "active:" + day.Format("2006-01-02")
}

// MarkActive sets the user's bit in today's bitmap. The user id MUST be a dense
// small integer (map external ids into a contiguous space first) so the bitmap
// stays compact: 50M users' flags occupy ~6 MB. This is EXACT, not approximate.
func MarkActive(ctx context.Context, rdb *redis.Client, day time.Time, userID int64) error {
	key := dauKey(day)
	if err := rdb.SetBit(ctx, key, userID, 1).Err(); err != nil {
		return err
	}
	return rdb.Expire(ctx, key, 90*24*time.Hour).Err()
}

// WasActive reads one user's bit — exact membership in O(1).
func WasActive(ctx context.Context, rdb *redis.Client, day time.Time, userID int64) (bool, error) {
	bit, err := rdb.GetBit(ctx, dauKey(day), userID).Result()
	return bit == 1, err
}

// DailyActiveCount totals the set bits — the DAU — in one BITCOUNT command.
func DailyActiveCount(ctx context.Context, rdb *redis.Client, day time.Time) (int64, error) {
	return rdb.BitCount(ctx, dauKey(day), nil).Result()
}

// Retained computes users active on BOTH days via a server-side BITOP AND, then
// counts the result. This is set intersection done in bit operations — no ids
// ever leave Redis, no application-side set logic.
func Retained(ctx context.Context, rdb *redis.Client, dayA, dayB time.Time) (int64, error) {
	dest := "active:and:" + dayA.Format("2006-01-02") + ":" + dayB.Format("2006-01-02")
	// BITOP AND dest a b: bit i of dest = a[i] AND b[i] = "active on both days".
	if err := rdb.BitOpAnd(ctx, dest, dauKey(dayA), dauKey(dayB)).Err(); err != nil {
		return 0, err
	}
	rdb.Expire(ctx, dest, time.Hour)
	return rdb.BitCount(ctx, dest, nil).Result()
}

// ---------- BITFIELD: packed per-id counters ----------

// IncrSmallCounter bumps a tiny per-id counter packed into one bitmap string:
// millions of, say, 8-bit counters in a fraction of the memory of millions of
// separate keys. Here we treat each id as an unsigned 8-bit slot (0..255).
func IncrSmallCounter(ctx context.Context, rdb *redis.Client, key string, id int64) (int64, error) {
	// BITFIELD key INCRBY u8 <offset> 1  — offset is id*8 bits into the string.
	res, err := rdb.BitField(ctx, key, "INCRBY", "u8", fmt.Sprintf("#%d", id), 1).Result()
	if err != nil {
		return 0, err
	}
	return res[0], nil
}

// ---------- CHOOSING: exact vs approximate ----------

// countUniqueExact is the EXACT alternative to the HLL — a set of ids. Correct
// when the count feeds billing or a disputed quota, but it stores every id and
// costs memory proportional to the cardinality (gigabytes at 100M uniques).
// Use this ONLY when approximation is unacceptable; otherwise prefer the HLL.
func countUniqueExact(ctx context.Context, rdb *redis.Client, day time.Time, visitorID string) (int64, error) {
	key := "visitors:exact:" + day.Format("2006-01-02")
	if err := rdb.SAdd(ctx, key, visitorID).Err(); err != nil {
		return 0, err
	}
	return rdb.SCard(ctx, key).Result() // exact, but memory grows with the count
}
```

Every one of these replaces a memory-heavy exact structure with a tiny approximate or bit-packed one where the question tolerates it — and the last function is the deliberate exception, the exact path you keep for the questions (billing, quotas) that never tolerate error.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Order-of-magnitude memory savings.** HLL turns gigabytes of unique-counting into ~12 KB; bitmaps turn tens of MB of activity ids into ~6 MB of bits.
- **Fixed, predictable budgets.** An HLL is ~12 KB regardless of scale; a per-day bitmap is a fixed size for a given id range — trivial to capacity-plan.
- **Composable server-side.** `PFMERGE` unions HLLs into period rollups; `BITOP` intersects bitmaps for retention — analytics without moving data to the client.
- **Cheap updates.** `PFADD`, `SETBIT` and `BITFIELD` are O(1); high-throughput ingestion is not a bottleneck.
- **Privacy side-benefit.** HLLs and bitmaps store facts *about* users without keeping their ids — a smaller blast radius and often a compliance advantage.

**Disadvantages**
- **HLL is approximate and non-enumerable.** ~0.81% error, and you cannot list the members or answer "was *this specific* item counted?".
- **Bitmaps need dense small-integer ids.** Sparse or large ids waste space (the string allocates up to the highest offset); external ids must be mapped to a dense space.
- **`BITCOUNT`/`BITOP` are O(N) in the bitmap length.** A huge bitmap makes these commands a blocking risk on the single thread.
- **Not for money.** Approximate counts are wrong by design; anything billed, charged, or legally disputable needs exact structures.

**Trade-offs**
- *Exact vs approximate:* a set gives exact counts and enumeration but scales with the data; an HLL gives a ~0.81%-accurate count in fixed tiny memory but no members. Choose by whether the exact answer is worth the memory and whether error is tolerable.
- *Bitmap vs set for presence:* a bitmap is ~1 bit per dense id and exact; a set is heavier but handles sparse/large/string ids. Choose by id density.
- *HLL precision vs memory:* Redis's HLL is fixed at ~0.81% error / ~12 KB; other implementations let you trade precision for memory. In Redis you accept the fixed point.
- *Bloom filter false-positive rate:* a lower rate needs more bits; tune the rate against the memory budget and the cost of an occasional unnecessary lookup (chapter 16).

## 7. Common Mistakes & Best Practices

- **Using a set to count uniques at scale.** Storing every id to answer "how many unique" wastes gigabytes for a single number. **Best practice:** use a HyperLogLog unless you need the members or exactness.
- **Using an HLL where you need billing accuracy.** A 0.81% error on a metered, charged quantity is a customer dispute. **Best practice:** exact structures for anything billed or disputable; HLL only for analytics.
- **Bitmaps with sparse or huge ids.** Setting bit 4 billion allocates a 500 MB string for one flag. **Best practice:** map external ids to a dense contiguous integer space before using a bitmap.
- **`BITCOUNT`/`BITOP` on giant bitmaps in the hot path.** These are O(N) in the bitmap size and can stall the single thread. **Best practice:** run heavy bit operations off the hot path (background job), or on bounded ranges.
- **Forgetting HLLs and bitmaps are mergeable/combinable.** Recomputing a monthly unique count from raw data when `PFMERGE` would union the daily HLLs. **Best practice:** design period keys (daily) and roll up with `PFMERGE`/`BITOP`.
- **No TTL on analytics keys.** Per-day HLLs and bitmaps accumulate forever. **Best practice:** set a retention TTL matching how long the analytics matter.
- **Treating a Bloom filter's "probably present" as "present".** It has false positives; proceeding as if certain is a bug. **Best practice:** use it only as a negative guard ("definitely not" → reject), and verify positives downstream (chapter 16).
- **Best practice overall: pick the structure from the question's tolerance for error.** Unique count, error OK → HLL; boolean-per-id, exact, dense → bitmap; membership guard, one-sided error → Bloom; money or disputes → exact.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** `PFCOUNT` gives the current estimate; if it looks wrong, remember it is approximate (~0.81%) and that `PFADD` is idempotent (duplicates are expected and harmless). `STRLEN` on a bitmap reveals its byte size — a surprisingly large bitmap means a sparse/huge id set the highest offset. `BITCOUNT` with a `BYTE`/`BIT` range inspects a slice. `OBJECT ENCODING` on an HLL shows whether it is still the sparse or the dense representation. `DEBUG OBJECT` gives low-level detail when validating memory.
- **Monitoring.** Track the byte size of bitmaps (`STRLEN`) and watch for unexpected growth (a bad id mapping). Watch the latency of `BITCOUNT`/`BITOP`/`PFMERGE` in the `SLOWLOG` since they are O(N) and can block. Alert if analytics keys lack TTLs and accumulate. For HLLs, periodically sanity-check the estimate against a known-exact sample to confirm the error stays near 0.81%.
- **Security & privacy.** These structures are a privacy *advantage*: an HLL stores no ids at all, and a bitmap stores only a bit per id, not the id's data — so a leaked HLL reveals a count, not identities. That said, a bitmap combined with an external id→offset mapping can re-identify, so protect that mapping. As always, the keys live on an authenticated, TLS-protected instance with ACLs (chapter 29). And never let an approximate count leak into a place that implies exactness to a user (a billing line, a legal report).
- **Scaling.** HLLs and bitmaps are naturally shardable by period (one key per day), and the per-key size is bounded, so they distribute cleanly across a cluster. The scaling hazard is the O(N) combine operations: `PFMERGE` over a year of daily HLLs, or `BITOP` across many large bitmaps, is O(N) work on one node's single thread — run those as scheduled background jobs writing a cached result, not on the request path. For extreme ingestion, `PFADD`/`SETBIT` are O(1) and pipeline well, so the write path scales easily; it is the aggregation reads you stage and cache.

## 9. Interview Questions

**Q: What problem does HyperLogLog solve, and what does it cost you?**
A: It estimates cardinality — the number of distinct items — without storing the items, using a fixed ~12 KB regardless of whether you counted a thousand or a billion, with about 0.81% standard error. That solves the memory blow-up of counting uniques exactly: a set of 100 million visitor ids is gigabytes, an HLL is 12 KB. What it costs you is exactness (the count is an estimate) and enumeration (it never stored the members, so you cannot list them or ask "was this specific item counted"). For "how many unique X" questions — visitors, distinct search terms — where you want the number and a fraction of a percent of error is invisible, it is a near-perfect trade.

**Q: How does HyperLogLog work at a high level?**
A: It hashes each item to a uniformly-random bit string and observes that a run of `k` leading zeros appears roughly once per `2^k` distinct items, so the maximum leading-zero run seen estimates the log of the cardinality. A single such estimate is far too noisy, so it uses the first bits of each hash to spread items across many registers (Redis uses 16,384), each holding the max leading-zero run for items that fell into it — stochastic averaging across thousands of estimators. It then combines the registers with a harmonic mean, which resists the outliers a plain average would be dominated by, plus bias corrections at small and large cardinalities. The result is a ~0.81%-error estimate in ~12 KB, because it stores 16,384 small registers rather than the items themselves. Duplicates are harmless: re-adding an item cannot raise any register's max, so it never inflates the count.

**Q: When would you use a bitmap, and what is its main constraint?**
A: When the fact about each id is a single boolean and the ids are dense small integers — "did user N do X today?" is bit N of a per-day key, so 50 million flags occupy about 6 MB, `BITCOUNT` totals them in one command, and `BITOP AND` across days gives retention. Bitmaps are exact, unlike HyperLogLog. The main constraint is that they are only cheap when the ids are dense: the underlying string allocates up to the highest bit offset you set, so a sparse or very large id (bit 4 billion) balloons the string. So you map external ids into a contiguous integer space first. If the per-id fact needs more than one bit, `BITFIELD` packs arbitrary-width integers instead.

**Q: How do you combine per-day HyperLogLogs into a monthly unique count?**
A: With `PFMERGE`, which unions the source HLLs into a destination HLL representing their combined set of distinct items — then `PFCOUNT` on the merged HLL gives the monthly uniques. The union has proper set-union semantics: a visitor who appeared on ten different days is counted once across the merge, no double-counting, and the result is still ~12 KB with ~0.81% error. This is why you design analytics as one HLL per day: rollups to weekly, monthly, or arbitrary spans are a cheap `PFMERGE` rather than a recomputation from raw data, and merging is associative so you can pre-merge weeks into months.

**Q: When is approximate not good enough?**
A: When the number is billed, charged against, or legally disputable. A 0.81% error on "unique visitors" for a dashboard is invisible and fine; the same 0.81% error on "API calls this customer made" that you invoice against is a systematic billing error and a dispute waiting to happen. The dividing line is whether someone acts on the exact value in a way that must be defensible: analytics, trends, dashboards, capacity planning and abuse heuristics tolerate approximation happily; billing, metered quotas you enforce or charge, correctness-critical deduplication, and anything a customer or auditor can challenge require exact structures. The engineering judgement is to reach for the tiny approximate structure by default and consciously pay for exactness only where error is unacceptable.

**Q: (Senior) Compare the memory and use cases of sets, HyperLogLog and bitmaps for counting.**
A: They answer different counting questions at very different costs. A set stores every distinct member, so it gives an exact count *and* enumeration *and* membership tests, but its memory scales with cardinality — 100 million ~20-byte ids is roughly 2–4 GB with overhead. A HyperLogLog answers only "how many distinct" with ~0.81% error in a fixed ~12 KB regardless of scale, and it is mergeable, but it stores no members so you cannot enumerate or test membership. A bitmap answers "is id N present/true" exactly with one bit per id, so it is both a membership structure and a counter (`BITCOUNT`), fixed at ~1 bit per id-slot — but only cheap for dense small-integer ids, and it does not help if ids are strings or sparse. So: need the members or a small exact set → set; need a unique *count* at scale and can tolerate error → HLL; need exact per-id boolean facts over dense ids → bitmap. In a real system you often use all three: a bitmap for exact daily-active, an HLL for unique counts across huge dimensions, and a set only where you genuinely need enumeration or exactness on a small cardinality.

**Q: (Senior) What are the production hazards of bitmaps and HyperLogLog, and how do you mitigate them?**
A: The headline hazard is that the aggregation commands are O(N). `BITCOUNT` and `BITOP` scale with the bitmap's byte length, and `PFMERGE` scales with the number and size of HLLs, so running them on the request path over large structures blocks the single thread and spikes everyone's latency. Mitigation: precompute aggregates in scheduled background jobs and cache the result (the DAU for yesterday does not change), and bound ranges where possible. The second hazard is bitmap id density: a bad id mapping that sets a huge offset silently allocates a gigantic string; mitigate by mapping external ids to a dense contiguous space and monitoring `STRLEN`. The third is treating approximate as exact — leaking an HLL estimate into a billing or compliance context; mitigate with a clear policy that approximate structures never feed money or disputes. The fourth is missing TTLs causing per-day keys to accumulate forever; mitigate with retention TTLs. And in Cluster, `PFMERGE`/`BITOP` are multi-key operations that require all keys on the same slot (hash tags) or they error — so design the key names so a period's keys co-locate if you intend to combine them. The write path (`PFADD`/`SETBIT`, both O(1)) is not the problem; it is the aggregation reads you must stage, bound, and cache.

**Q: (Senior) How do these structures interact with privacy and compliance?**
A: They are generally a privacy advantage and occasionally a subtle risk. A HyperLogLog stores no identifiers at all — only 16,384 small registers — so a leaked HLL reveals a count, never who was counted; that is a smaller blast radius and can simplify compliance because you are not retaining PII to answer "how many unique users". A bitmap stores only a single bit per id and no attributes, so it too is far less sensitive than a set of ids or a table of events. The subtlety is re-identification: a bitmap is meaningful only with the external id→offset mapping, so that mapping is the sensitive asset and must be protected; and combining several bitmaps (active on these specific days) can narrow down to individuals. The practical stance is to treat the aggregate structures as low-sensitivity (they help you avoid hoarding ids), protect any id-mapping table as the real PII, and never present an approximate figure where a user would reasonably assume it is exact. Used well, HLLs and bitmaps let you answer analytics questions while holding less personal data than the exact alternatives would force you to keep.

**Q: Why is `PFADD` idempotent and why does that matter?**
A: Because adding an item only ever *raises* a register to a new maximum leading-zero run, and re-adding the same item hashes to the same register with the same leading-zero count, so it cannot raise anything — the estimate is unchanged. That matters operationally: you never have to deduplicate before `PFADD`. You can fire it on every request, every event, every retry, and the unique count stays correct without any client-side "have I already counted this?" bookkeeping — which is exactly what makes it cheap to ingest at high throughput.

**Q: How would you compute 7-day retention with bitmaps?**
A: Keep one daily-active bitmap per day. For "users active on day 1 who were also active on day 7", `BITOP AND result active:day1 active:day7` produces a bitmap whose set bits are exactly the users active on both, and `BITCOUNT result` gives the retained count; divide by `BITCOUNT active:day1` for the retention rate. For "active every day in a 7-day window", `BITOP AND` across all seven days. Because these are O(N) in the bitmap size, run them as a nightly job over yesterday's completed bitmaps and cache the resulting numbers, rather than on the request path. The elegance is that a retention question that sounds like a heavy analytical join becomes a couple of bit operations over ~6 MB structures.

**Q: Where does the Count-Min sketch fit alongside HyperLogLog and Bloom filters?**
A: The three answer different approximate questions and compose well. HyperLogLog estimates *how many distinct* items there are; a Bloom filter answers *is this specific item present* (with no false negatives); and a Count-Min sketch estimates *how many times* each item has occurred — per-item frequency — in fixed memory, over-counting a little but never under-counting. In a caching context you reach for Count-Min for "what are the hot keys" or "roughly how many times has this id appeared" when an exact per-item counter for millions of items would cost too much, for instance to drive a heavy-hitters detector that decides which keys deserve a local near-cache. All three are in the same trade family — accept a bounded, one-directional error for a large memory saving — and RedisBloom ships Bloom, Cuckoo, Count-Min and Top-K together, so you pick the sketch whose error shape matches the question.

## 10. Quick Revision & Cheat Sheet

| Question | Structure | Commands | Memory |
|---|---|---|---|
| How many unique X? (error OK) | HyperLogLog | `PFADD`/`PFCOUNT`/`PFMERGE` | ~12 KB, any scale |
| Boolean per dense id (exact) | Bitmap | `SETBIT`/`GETBIT`/`BITCOUNT`/`BITOP` | ~1 bit/id |
| Small packed counters | BITFIELD | `BITFIELD ... INCRBY u8` | bits × ids |
| "Seen it?" guard (one-sided error) | Bloom filter | `BF.ADD`/`BF.EXISTS` | tiny (ch. 16) |
| Billed / disputed count | Set / exact counter | `SADD`/`SCARD`/`INCR` | scales with data |

| Exact vs approximate | Exact needed | Approximate fine |
|---|---|---|
| Examples | billing, quotas charged, dedup correctness | analytics, dashboards, trends, capacity |
| Structure | set, precise counter | HLL, bitmap, Bloom |

**Flash cards**
- **Unique count at scale?** → HyperLogLog: ~12 KB, ~0.81% error, any cardinality.
- **How does HLL work?** → Max leading-zero run across 16,384 registers, harmonic-mean averaged.
- **Boolean per id?** → Bitmap: ~1 bit/id, exact, dense small ids only.
- **Roll up periods?** → `PFMERGE` for HLLs, `BITOP` for bitmaps — no double-count.
- **When NOT approximate?** → Billing, charged quotas, disputes → use exact.
- **`PFADD` idempotent?** → Yes; duplicates never inflate the count, so no client-side dedup.

## 11. Hands-On Exercises & Mini Project

- [ ] Count unique visitors two ways — a set of ids and a HyperLogLog — over 1M, 10M and 100M ids, charting memory and the HLL's error.
- [ ] Track daily-active for 1M users in a bitmap, count with `BITCOUNT`, and compare the memory to storing the active ids in a set.
- [ ] Roll up seven daily HLLs into a weekly unique count with `PFMERGE` and confirm no double-counting versus a brute-force distinct count.
- [ ] Compute 2-day and 7-day retention with `BITOP AND` + `BITCOUNT` and verify against an exact set intersection.
- [ ] Deliberately set a huge bitmap offset and observe the string balloon (`STRLEN`); then fix it with a dense id mapping.
- [ ] Pack per-id counters with `BITFIELD` and compare the memory to millions of separate integer keys.

### Mini Project — "Analytics Without the Ids"

**Goal.** Build an analytics layer that answers unique-count and activity questions at scale using HLLs and bitmaps, and prove the memory and accuracy trade against exact structures.

**Requirements.**
1. Ingest a stream of events (visitor id, user id, timestamp) via `PFADD` (uniques) and `SETBIT` (daily-active), both O(1).
2. Serve unique-visitor counts per day (`PFCOUNT`) and per arbitrary range (`PFMERGE`), and DAU (`BITCOUNT`).
3. Serve retention (users active on both of two days) via `BITOP AND` + `BITCOUNT`, run as a background job and cached.
4. Maintain an exact set-based path for one metric that is "billed", and enforce that only exact structures feed it.
5. Benchmark memory and accuracy: HLL vs set for uniques, bitmap vs set for activity, across three orders of magnitude of scale.

**Extensions.**
- Add a RedisBloom cache-penetration guard in front of a lookup and measure the DB queries it prevents (cross-ref chapter 16).
- Add retention TTLs and a rollup job that pre-merges daily HLLs into weekly/monthly, and measure the read-path savings.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Redis Data Types & Which to Cache With* (where these structures fit), *Cache Penetration & Bloom Filters* (the Bloom-filter guard in depth, chapter 16), *Strings, Hashes & Object Caching* (bitmaps are strings under the hood), *Sorted Sets: Rate Limiting, Leaderboards & Windows* (another memory-vs-precision type), *Memory, maxmemory & Eviction* (the budget these structures protect).

- **Redis — Probabilistic data types (HyperLogLog & Bloom)** — Redis · *Intermediate* · the official reference for `PFADD`/`PFCOUNT`/`PFMERGE` and the RedisBloom structures, with memory characteristics. <https://redis.io/docs/latest/develop/data-types/probabilistic/>
- **Redis — Bitmaps & bitfields** — Redis · *Intermediate* · `SETBIT`/`BITCOUNT`/`BITOP`/`BITFIELD` and the daily-active and BITFIELD patterns. <https://redis.io/docs/latest/develop/data-types/bitmaps/>
- **HyperLogLog: the analysis of a near-optimal cardinality estimation algorithm** — Flajolet, Fusy, Gandouet, Meunier · *Advanced* · the original paper defining the algorithm, registers and error bounds. <https://algo.inria.fr/flajolet/Publications/FlFuGaMe07.pdf>
- **Redis — PFADD/PFCOUNT internals (antirez blog)** — Salvatore Sanfilippo · *Advanced* · the creator's write-up of the sparse/dense representation and the 0.81% error in Redis's HLL. <http://antirez.com/news/75>
- **Damn Cool Algorithms: Cardinality Estimation** — Nick Johnson · *Intermediate* · an approachable intuition-building explanation of the leading-zero counting idea. <http://blog.notdot.net/2012/09/Dam-Cool-Algorithms-Cardinality-Estimation>
- **RedisBloom — Bloom & Cuckoo filters** — Redis · *Advanced* · the membership-guard module for cache-penetration defence and its false-positive tuning. <https://redis.io/docs/latest/develop/data-types/probabilistic/bloom-filter/>
- **Google — Sketching data structures (Count-Min, Bloom, HLL) overview** — various · *Advanced* · the broader family of sketches and when each applies. <https://florian.github.io/count-min-sketch/>
- **Redis University — RU101** — Redis · *Beginner* · free course covering the probabilistic types with hands-on exercises. <https://university.redis.com/>

---

*Caching with Redis Handbook — chapter 20.*
