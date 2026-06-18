# 08 · CAP, Consistency & Replication

> **In one line:** Trade consistency vs availability under network partitions.

---

## 1. Overview

The **CAP theorem** says under a network **partition** you must choose **consistency** (reject stale) or **availability** (serve possibly-stale). Real systems tune this via **quorums** and offer a spectrum from strong to **eventual** consistency.

## 2. Key Concepts

- During a partition: pick CP (consistent) or AP (available).
- Strong vs eventual consistency are endpoints of a spectrum.
- Quorums: R + W > N gives strong reads.
- Tunable consistency (Dynamo/Cassandra) per request.
- PACELC extends CAP with latency vs consistency when no partition.

## 3. Syntax & Code

```text
CAP under partition:
  CP -> reject to stay consistent (e.g., spanner, zookeeper)
  AP -> serve stale to stay available (e.g., dynamo, cassandra)

Quorum: N replicas, write to W, read from R; R + W > N => strong
```

## 4. Worked Example

**Quorum reads/writes**

With N=3, W=2, R=2: R+W=4>3, so a read always overlaps the latest write → strong consistency.

```text
N=3, W=2, R=2 -> R+W>N -> consistent
N=3, W=1, R=1 -> fast but eventually consistent
```

## 5. Best Practices

- ✅ Match consistency level to the use case (money=strong, likes=eventual).
- ✅ Use quorums to tune the consistency/latency trade-off.
- ✅ Make eventual-consistency UX-aware (read-your-writes where needed).
- ✅ State CAP choice explicitly in designs.
- ✅ Consider PACELC (latency even without partitions).

## 6. Common Pitfalls

1. ⚠️ Claiming a system is 'CA' (partitions are unavoidable).
2. ⚠️ Assuming eventual consistency is fine for all data.
3. ⚠️ Ignoring read-your-writes expectations.
4. ⚠️ Misconfigured quorums giving neither speed nor consistency.
5. ⚠️ Conflating consistency models with isolation levels.
6. ⚠️ Overpaying for strong consistency where eventual suffices.

## 7. Interview Questions

1. **Q: State the CAP theorem.**
   A: Under a network partition, a system must choose between consistency and availability; you can't have both then.

2. **Q: Is 'CA' achievable?**
   A: Not meaningfully — partitions happen, so you really choose CP or AP under them.

3. **Q: Strong vs eventual consistency?**
   A: Strong returns the latest write always; eventual converges over time, allowing temporary staleness.

4. **Q: How do quorums work?**
   A: With N replicas, requiring R+W>N guarantees read/write overlap for strong consistency.

5. **Q: When is eventual consistency acceptable?**
   A: For non-critical, high-availability data like counts, feeds, presence.

6. **Q: What is PACELC?**
   A: Else (no partition) you still trade Latency vs Consistency.

7. **Q: Read-your-writes consistency?**
   A: A user always sees their own latest write; route to leader or use session guarantees.

8. **Q: Money transfer consistency?**
   A: Strong/transactional — staleness is unacceptable.

## 8. Practice

- [ ] Decide CP vs AP for a banking ledger vs a like counter.
- [ ] Configure N/R/W for strong vs fast reads.
- [ ] Explain read-your-writes for a profile update.

## 9. Quick Revision

CAP: under partition choose C or A. Consistency is a spectrum (strong↔eventual); quorums (R+W>N) tune it. Strong for money, eventual for feeds; remember PACELC (latency vs consistency otherwise).

**References:** CAP theorem

---

*System Design Handbook — topic 08.*
