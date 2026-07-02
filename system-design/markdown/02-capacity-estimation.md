# 02 · Back-of-the-Envelope Estimation

> **In one line:** Order-of-magnitude math for QPS, storage, and bandwidth that tells you whether one box or a thousand is needed — before you draw a single line.

---

## 1. Overview

**Back-of-the-envelope estimation** is the skill of turning "how big is this system?" into a number in 60 seconds using rounded arithmetic. It exists because architecture is driven by scale: a service at 100 QPS and one at 1 M QPS look nothing alike. Without estimates, every design choice — cache or no cache, one DB or fifty shards, sync or async — is a guess.

The goal is **not precision, it is the right order of magnitude**. Whether a system needs 8 servers or 12 doesn't change the design; whether it needs 8 or 8,000 changes everything. So you round aggressively (a day ≈ 100,000 seconds, not 86,400) and you carry powers of ten, not significant figures. A 2× error is fine; a 100× error picks the wrong architecture.

Concretely, you compute four things: **QPS** (average and peak), **storage** (per item × items/day × retention), **bandwidth** (QPS × payload size), and the **read:write ratio** (which decides caching and replication). Underneath all of it sits the **latency-numbers hierarchy** — knowing that RAM is ~100 ns and a cross-region round trip is ~150 ms tells you where data must live to hit a latency target.

In an interview, estimation is the step that separates candidates who *reason* from candidates who *recite*. When you say "500 K peak writes/sec at 1 KB each is 500 MB/s, which won't fit one node, so I'll shard," you've justified the entire rest of your design in one breath.

## 2. Core Concepts

- **QPS (queries per second)** — daily events ÷ seconds/day. Compute **average QPS** first, then a **peak QPS** by applying a burst factor (commonly 2–5×; up to 10× for spiky, event-driven traffic).
- **Read:write ratio** — how many reads per write. Social and content systems are typically **100:1 to 1000:1 read-heavy** → cache and replicate reads. Write-heavy systems (logging, metrics) invert this → optimize ingestion.
- **Storage growth** — bytes/item × items/day × retention (days/years). Add index and replication overhead (×3 for RF=3). Extrapolate to 1 and 5 years — storage is cumulative, unlike QPS.
- **Bandwidth** — QPS × average payload size, in both directions. A "cheap" 50 KB response at 20 K QPS is 1 GB/s egress — often the real bottleneck.
- **Powers-of-ten rounding** — 1 day ≈ 10⁵ s (86,400 rounded up to 100,000), 1 M s/day is wrong; use 86,400 ≈ 100,000. Carry KB/MB/GB/TB, not exact digits.
- **The latency-numbers hierarchy** — L1 ~1 ns, RAM ~100 ns, SSD read ~100 µs, disk seek ~10 ms, same-DC round trip ~0.5 ms, cross-region ~150 ms. Each tier is roughly 10–1000× the last.
- **The "80/20" working set** — usually ~20% of data serves ~80% of reads; that hot set sizes your cache.
- **Estimation for provisioning** — servers = peak QPS ÷ per-server capacity (assume a single box handles ~1 K–10 K simple QPS, less for heavy work).

## 3. Architecture

Estimation flows from a single input — **DAU (daily active users)** — through a small tree of multiplications into the three numbers that size hardware. Each branch uses one assumption you state out loud.

```svg
<svg viewBox="0 0 760 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="380" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">From DAU to Hardware</text>

  <rect x="300" y="40" width="160" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="380" y="60" text-anchor="middle" fill="#1e293b" font-weight="700">DAU</text>
  <text x="380" y="77" text-anchor="middle" fill="#64748b" font-size="11">× actions/user/day</text>

  <rect x="300" y="120" width="160" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="380" y="140" text-anchor="middle" fill="#1e293b" font-weight="700">Requests / day</text>
  <text x="380" y="157" text-anchor="middle" fill="#64748b" font-size="11">÷ 86,400 s</text>

  <rect x="90"  y="210" width="170" height="60" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="175" y="233" text-anchor="middle" fill="#1e293b" font-weight="700">Avg &amp; Peak QPS</text>
  <text x="175" y="251" text-anchor="middle" fill="#64748b" font-size="11">peak = avg × 2–5</text>
  <text x="175" y="264" text-anchor="middle" fill="#64748b" font-size="11">→ # of servers</text>

  <rect x="295" y="210" width="170" height="60" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="380" y="233" text-anchor="middle" fill="#1e293b" font-weight="700">Storage / yr</text>
  <text x="380" y="251" text-anchor="middle" fill="#64748b" font-size="11">bytes × writes × 365</text>
  <text x="380" y="264" text-anchor="middle" fill="#64748b" font-size="11">× RF(3) → # of disks</text>

  <rect x="500" y="210" width="170" height="60" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="585" y="233" text-anchor="middle" fill="#1e293b" font-weight="700">Bandwidth</text>
  <text x="585" y="251" text-anchor="middle" fill="#64748b" font-size="11">QPS × payload</text>
  <text x="585" y="264" text-anchor="middle" fill="#64748b" font-size="11">→ NIC / CDN</text>

  <line x1="380" y1="86"  x2="380" y2="116" stroke="#475569" marker-end="url(#ah2)"/>
  <path d="M340,166 L175,166 L175,206" fill="none" stroke="#475569" marker-end="url(#ah2)"/>
  <line x1="380" y1="166" x2="380" y2="206" stroke="#475569" marker-end="url(#ah2)"/>
  <path d="M420,166 L585,166 L585,206" fill="none" stroke="#475569" marker-end="url(#ah2)"/>
  <text x="380" y="300" text-anchor="middle" fill="#64748b" font-size="11">One input (DAU), a few stated assumptions, three sizing numbers.</text>
</svg>
```

## 4. How It Works

1. **Anchor on DAU.** State it: "100 M daily active users." If unknown, assume and say so.
2. **Get requests/day.** Multiply DAU by actions per user per day: 100 M × 2 posts = 200 M writes/day; reads at 100:1 = 20 B reads/day.
3. **Convert to average QPS.** Divide by seconds/day. Use **86,400 ≈ 10⁵**. 200 M ÷ 100 K ≈ **2,000 writes/sec**; 20 B ÷ 100 K ≈ **200,000 reads/sec**.
4. **Apply a peak factor.** Multiply by 2–5× (higher for spiky traffic): peak writes ≈ 10 K/s, peak reads ≈ 1 M/s. Size compute for peak.
5. **Compute storage.** bytes/item × writes/day × retention × replication. 200 M posts/day × 1 KB × 365 × 3(RF) ≈ **~220 TB/year**. Extrapolate to 5 years.
6. **Compute bandwidth.** QPS × payload. 200 K reads/s × 1 KB ≈ **200 MB/s egress**; if payloads are 50 KB, it's 10 GB/s → you need a CDN.
7. **Sanity-check against the latency hierarchy.** If the target is < 10 ms and data is cross-region (150 ms RTT), the data must be cached locally or replicated regionally. Numbers meet physics here.

## 5. Key Components / Deep Dive

### The Latency-Numbers Hierarchy

Every senior engineer carries these rounded numbers. They are the physics that bounds any design:

| Operation | Time | Relative |
|---|---|---|
| L1 cache reference | ~1 ns | 1× |
| Branch mispredict | ~5 ns | 5× |
| L2 cache reference | ~7 ns | 7× |
| Main memory (RAM) reference | ~100 ns | 100× |
| Compress 1 KB (fast) | ~1 µs | 1,000× |
| Read 1 MB sequentially from RAM | ~10 µs | 10,000× |
| SSD random read | ~100 µs | 100,000× |
| Read 1 MB from SSD | ~1 ms | 1,000,000× |
| Same-datacenter round trip | ~0.5 ms | 500,000× |
| Disk (HDD) seek | ~10 ms | 10,000,000× |
| Read 1 MB from disk | ~20 ms | — |
| Cross-region round trip (e.g. US↔EU) | ~150 ms | 150,000,000× |

The takeaways: **RAM is ~100× faster than SSD, ~100,000× faster than a disk seek**; **a cross-region hop (150 ms) dwarfs everything** — one avoidable cross-region call can blow an entire latency budget. This table is why we cache (keep hot data in RAM), why we co-locate (avoid cross-region), and why sequential I/O beats random.

### Powers-of-Ten Rounding

Speed comes from ruthless rounding. Memorize: **86,400 s/day ≈ 10⁵**, 1 month ≈ 2.5 M s, 1 year ≈ 3×10⁷ s. Data sizes: char = 1 B, int = 4 B, timestamp/long = 8 B, UUID = 16 B, a tweet ≈ 300 B–1 KB, a photo ≈ 200 KB–2 MB, a minute of video ≈ 10–50 MB. Powers of two: 2¹⁰ ≈ 10³ (KB), 2²⁰ ≈ 10⁶ (MB), 2³⁰ ≈ 10⁹ (GB), 2⁴⁰ ≈ 10¹² (TB). Never chase significant digits — a clean 10⁵ beats a fumbled 86,400.

### Read:Write Ratio Drives Architecture

The ratio is the most consequential single number. **Read-heavy (100:1+)** → add caching (Redis), read replicas, CDN; the write path can stay simple. **Write-heavy** → optimize ingestion with LSM-tree stores (Cassandra), batching, and queues; reads may be secondary. **Balanced** → the DB is likely your bottleneck; consider sharding early. Always ask for or assume this ratio explicitly.

## 6. Trade-offs

| Choice in estimation | Pros | Cons |
|---|---|---|
| **Round hard (10⁵ s/day)** | Fast, mental-math friendly, right order of magnitude | Off by ~15% — irrelevant for sizing |
| **Precise math (86,400)** | "Accurate" | Slow, error-prone under pressure, false confidence |
| **Size for peak** | System survives bursts | Over-provisioned/cost if peak is rare → use autoscaling |
| **Size for average** | Cheapest | Falls over on spikes; unacceptable for user-facing |
| **Assume high RF (3)** | Durable, realistic storage number | Triples storage cost; note it explicitly |

Estimation is intentionally imprecise: the return on a 15% tighter number is zero, while the return on catching a 100× mistake is the whole design. Round fast, state assumptions, and move on.

## 7. When to Use / When to Avoid

**Do estimate when:**
- Choosing between single-node and distributed (the fork the whole design hinges on).
- Justifying a cache, CDN, shard count, or queue.
- Sizing storage growth and infra cost for capacity planning.

**Don't over-invest when:**
- The interviewer explicitly says "assume it fits" or wants to skip ahead.
- The scale is obviously small (internal tool, 100 users) — a one-line "this fits one box" suffices.
- You'd be polishing digits — order of magnitude is enough; stop at the power of ten.

## 8. Scaling & Production Best Practices

- **Always compute peak, not just average** — provision compute and set rate limits for the burst (2–5× average, higher for event-driven spikes).
- **Storage is cumulative; QPS is instantaneous** — project storage to 1 and 5 years; project QPS at steady-state peak.
- **Include replication and index overhead** — a naive "raw bytes" storage number is ~3–5× too low once you add RF=3 and indexes.
- **Bandwidth is often the hidden ceiling** — large payloads (images, video) saturate NICs and egress bills long before CPU; push them to a CDN/object store.
- **Cache the working set, not the dataset** — size the cache for the hot ~20%, which often captures ~80% of reads at a fraction of the RAM.
- **Reconcile numbers with the latency hierarchy** — a sub-10 ms target rules out per-request disk seeks and cross-region hops; that constraint shapes where data lives.

## 9. Failure Modes & Mitigations

| Failure | Impact | Mitigation |
|---|---|---|
| Sized for average, not peak | Brownout/outage during bursts | Peak factor 2–5×; autoscaling + queue to absorb spikes |
| Forgot replication factor | Storage under-estimated 3× → runs out | Always ×RF and ×index overhead |
| Ignored bandwidth | NIC/egress saturates before CPU | Compute QPS × payload; offload to CDN/object store |
| Precision paralysis | Burn 10 min on arithmetic | Round to powers of ten; move on |
| Wrong read:write assumption | Cache/replica strategy misfit | Ask for the ratio; state it as an assumption |
| No growth projection | Capacity exhausted in months | Extrapolate storage to 1–5 years up front |

## 10. Monitoring & Metrics

In production, your estimates become the baselines you alert against:

- **Actual QPS vs projected** (per endpoint, read/write split) — drift signals a bad model or viral growth.
- **Peak-to-average ratio** — validates or corrects your burst factor over time.
- **Storage growth rate (GB/day)** and **projected runway** — alert before disks fill.
- **Bandwidth / egress (bytes/s)** per service and per region — the sneaky cost and saturation metric.
- **Cache hit ratio** — confirms the working-set assumption; a falling hit ratio means the hot set grew past cache size.
- **Per-server utilization** (CPU, connections) vs the assumed per-box capacity — recalibrate provisioning math.

## 11. Common Mistakes

1. ⚠️ **Using average QPS to size compute** — the system dies on the first spike; always provision for peak.
2. ⚠️ **Forgetting the replication factor** — real storage is ~3× your naive number with RF=3.
3. ⚠️ **Ignoring bandwidth** — large payloads saturate the network long before CPU or disk.
4. ⚠️ **Precision paralysis** — computing 86,400 instead of 10⁵ and losing minutes; round hard.
5. ⚠️ **Not stating assumptions** — an unstated DAU or read:write ratio makes every downstream number unverifiable.
6. ⚠️ **Treating QPS and storage the same** — QPS is a rate (peak matters); storage is cumulative (retention matters).
7. ⚠️ **Skipping the latency hierarchy** — promising 5 ms while doing a cross-region (150 ms) call.
8. ⚠️ **Caching the whole dataset** — waste; size the cache for the hot working set.

## 12. Interview Questions

**Q: Estimate the QPS for a service with 100 M DAU where each user makes 10 requests/day.**
A: 100 M × 10 = 1 B requests/day. ÷ 86,400 (≈10⁵) ≈ **10 K average QPS**. Peak at ~3× ≈ **30 K QPS**. That's beyond a single node → load-balanced fleet.

**Q: How do you go from average QPS to peak QPS, and why does it matter?**
A: Multiply by a burst factor of 2–5× (up to 10× for spiky/event traffic). It matters because you provision compute and set rate limits for peak — sizing for average guarantees an outage during the daily spike.

**Q: A system stores 1 KB per event at 5,000 writes/sec. How much storage per year?**
A: 5,000 × 1 KB = 5 MB/s → ×86,400 ≈ 430 GB/day → ×365 ≈ **~150 TB/year raw**, ~**450 TB with RF=3**. Plan multi-node storage and lifecycle/TTL policies.

**Q: Why round 86,400 to 100,000?**
A: Speed and error-avoidance under pressure. The ~15% error never changes an architecture decision; a fumbled long-division might. Estimation targets order of magnitude, not precision.

**Q: What's roughly the latency of RAM vs SSD vs disk vs a cross-region round trip?**
A: RAM ~100 ns, SSD random read ~100 µs, disk seek ~10 ms, cross-region RTT ~150 ms. Each tier is ~10–1000× the previous; that spread is why we cache in RAM and avoid cross-region calls.

**Q (senior): Your latency budget is 20 ms p99 for a read. Walk me through where the data can live.**
A: Budget it: a same-DC hop is ~0.5 ms, RAM lookup ~100 ns, SSD ~100 µs — all fine. A single cross-region round trip (150 ms) alone blows the budget, so the data must be cached in-region or replicated regionally. I'd serve from a local Redis/replica and treat cross-region as async replication, not a synchronous read.

**Q (senior): When does bandwidth, not compute or storage, become the bottleneck?**
A: With large payloads. 20 K reads/s × 50 KB = 1 GB/s egress — that saturates NICs and dominates cost long before CPU. The fix is to keep bytes off the origin: CDN for static/media, object store + signed URLs, compression, and range requests. Always compute QPS × payload, not just QPS.

**Q (senior): How does the read:write ratio change your architecture, concretely?**
A: At 1000:1 read-heavy I lean on a cache tier (Redis) with high hit ratio, read replicas, and a CDN; the primary handles writes only. If it flips to write-heavy (metrics/logs), I switch to an LSM-tree store (Cassandra) tuned for write throughput, batch and buffer via Kafka, and treat reads as secondary/aggregated. The ratio decides where I spend the complexity budget.

**Q (senior): You estimate 500 MB/s of writes. Why can't one node handle it, and what's your shard count?**
A: A single node's sustainable write throughput (disk + replication + compaction overhead) is realistically tens of MB/s for durable random writes, maybe ~50–100 MB/s on good NVMe. 500 MB/s ÷ ~25 MB/s usable ≈ **~20 shards** with headroom, before RF. I'd shard by a high-cardinality key to spread load and avoid hot partitions.

**Q: How much does storage grow if you keep RF=3 and 90-day retention at 200 M 1 KB writes/day?**
A: 200 M × 1 KB = 200 GB/day raw → ×3 (RF) = 600 GB/day → ×90 days ≈ **~54 TB** steady-state working set, plus index overhead. TTL bounds it so it doesn't grow forever.

## 13. Alternatives & Related

- **The System Design Interview Framework** — estimation is step 2; this page is the deep-dive.
- **Latency, Throughput, Availability & SLAs** — the percentiles and availability math your numbers must satisfy.
- **Caching** — sized by the working-set and read:write ratio computed here.
- **Database Scaling** — shard count and replica strategy follow directly from QPS and storage estimates.
- **CDN / object storage** — where bandwidth estimates push large payloads.

## 14. Cheat Sheet

> [!TIP]
> **Rounding:** day ≈ 10⁵ s · month ≈ 2.5×10⁶ s · year ≈ 3×10⁷ s. KB/MB/GB/TB = 10³/10⁶/10⁹/10¹².
> **QPS:** requests/day ÷ 10⁵ = avg; peak = avg × 2–5.
> **Storage/yr:** bytes × writes/day × 365 × RF(3) × index overhead.
> **Bandwidth:** QPS × payload (watch large media → CDN).
> **Latency ladder:** L1 1 ns · RAM 100 ns · SSD 100 µs · same-DC 0.5 ms · disk seek 10 ms · cross-region 150 ms.
> **Read:write ratio decides caching/replication.** Read-heavy → cache + replicas; write-heavy → LSM + queue.
> **Sizes:** int 4 B · UUID 16 B · tweet ~1 KB · photo ~200 KB–2 MB · video ~10–50 MB/min.

**References:** Latency Numbers Every Programmer Should Know (Jeff Dean / Peter Norvig), System Design Primer, Designing Data-Intensive Applications (ch.1)

---
*System Design Handbook — topic 02.*
