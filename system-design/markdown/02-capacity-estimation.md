# 02 · Back-of-the-Envelope Estimation

> **In one line:** Quick math for QPS, storage, and bandwidth to size systems.

---

## 1. Overview

Estimation turns vague scale into concrete numbers that justify design choices. Compute **QPS** (writes & reads), **storage** growth, and **bandwidth** from user counts and per-item sizes, and reason with the classic latency numbers (memory ns, SSD μs, network ms).

## 2. Key Concepts

- QPS = daily actions / 86,400 (×peak factor 2–10).
- Storage = items/day × size × retention.
- Read:write ratios drive caching/replication.
- Latency hierarchy: RAM ns « SSD μs « network ms.
- Round aggressively; the order of magnitude matters.

## 3. Syntax & Code

```text
Example: 10M DAU, 1 post each, read:write = 100:1
writes/day = 10M  -> ~115 wps avg, ~1000 wps peak
reads      = 1B/day -> ~11.5k rps avg, ~100k rps peak  (need caching!)
storage    = 10M * 1KB * 365 = ~3.65 TB/year
```

## 4. Worked Example

**Latency intuition**

Memory reference ~100ns, SSD ~100μs, network round trip within DC ~0.5ms, cross-region ~100ms — design to keep hot paths in memory.

```text
L1 ~1ns | RAM ~100ns | SSD ~100us | DC RTT ~0.5ms | Cross-region ~100ms
```

## 5. Best Practices

- ✅ Do the math out loud; it justifies decisions.
- ✅ Apply a peak multiplier over averages.
- ✅ Round to powers of ten.
- ✅ Separate read and write paths.
- ✅ Use latency numbers to choose storage tiers.

## 6. Common Pitfalls

1. ⚠️ Skipping estimation entirely.
2. ⚠️ Using averages without peak factors.
3. ⚠️ Over-precise figures (false confidence).
4. ⚠️ Ignoring storage growth/retention.
5. ⚠️ Forgetting metadata/replication overhead.
6. ⚠️ Treating reads and writes as one number.

## 7. Interview Questions

1. **Q: How do you estimate QPS?**
   A: Daily actions ÷ 86,400, then multiply by a peak factor (2–10×).

2. **Q: Why separate reads and writes?**
   A: They scale differently; high read:write ratios point to caching/replicas.

3. **Q: Key latency numbers?**
   A: RAM ~100ns, SSD ~100μs, intra-DC RTT ~0.5ms, cross-region ~100ms.

4. **Q: How to estimate storage?**
   A: items/day × item size × retention period × replication factor.

5. **Q: Why round aggressively?**
   A: Order of magnitude drives the design; precision is false confidence.

6. **Q: What's a peak factor?**
   A: A multiplier capturing traffic spikes over the average.

7. **Q: How does estimation drive design?**
   A: High QPS → caching/sharding; large storage → partitioning; tight latency → in-memory.

8. **Q: Bandwidth estimation?**
   A: QPS × payload size, both ingress and egress.

## 8. Practice

- [ ] Estimate QPS for a 50M-DAU feed.
- [ ] Compute yearly storage for image uploads.
- [ ] Use latency numbers to justify a cache.

## 9. Quick Revision

Estimate QPS (daily/86.4k × peak), storage (items×size×retention×replication), bandwidth (QPS×size). Use latency hierarchy (RAM≪SSD≪network). Round to orders of magnitude; split reads/writes.

**References:** Latency numbers every programmer should know

---

*System Design Handbook — topic 02.*
