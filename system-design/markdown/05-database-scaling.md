# 05 · Database Scaling: Replication & Sharding

> **In one line:** Scale reads with replicas; scale writes/storage with sharding.

---

## 1. Overview

Scale databases by **replication** (copy data to followers for read scaling and HA) and **sharding/partitioning** (split data across nodes for write/storage scaling). Replication brings replication lag; sharding brings cross-shard query complexity.

## 2. Key Concepts

- Leader-follower: writes to leader, reads from replicas.
- Replication lag → followers may serve stale reads.
- Sharding splits data by key (range/hash/consistent hash).
- Choose a shard key that spreads load evenly.
- Cross-shard joins/transactions are hard — avoid or use scatter-gather.

## 3. Syntax & Code

```text
Writes ─▶ [Leader] ──replicate──▶ [Follower-1] ◀─ reads
                       └─────────▶ [Follower-2] ◀─ reads

Sharding (hash(user_id)%N): user data lives on exactly one shard
```

## 4. Worked Example

**Choosing a shard key**

A bad key (e.g., country) creates hotspots; hashing the user id spreads writes evenly but makes range scans expensive.

```text
hash(user_id) -> even spread, no range scans
range by date  -> good for time queries, hot 'today' shard
```

## 5. Best Practices

- ✅ Use read replicas to scale read-heavy workloads.
- ✅ Pick a shard key that distributes load and matches access patterns.
- ✅ Prefer single-shard transactions.
- ✅ Add caching before sharding when possible.
- ✅ Plan for resharding/rebalancing from day one.

## 6. Common Pitfalls

1. ⚠️ Reading from replicas and seeing stale data unexpectedly.
2. ⚠️ Hot shards from a skewed shard key.
3. ⚠️ Cross-shard transactions/joins killing performance.
4. ⚠️ Resharding without a migration plan.
5. ⚠️ Treating replicas as a write-scaling solution (they aren't).
6. ⚠️ Choosing a shard key you can't change later.

## 7. Interview Questions

1. **Q: Replication vs sharding?**
   A: Replication copies data (read scaling + HA); sharding splits data (write/storage scaling).

2. **Q: What is replication lag?**
   A: Delay before followers reflect the leader's writes, causing potentially stale reads.

3. **Q: How to choose a shard key?**
   A: One that spreads load evenly and aligns with common queries to avoid scatter-gather.

4. **Q: Why are cross-shard transactions hard?**
   A: They need distributed coordination (2PC/sagas), increasing latency and failure modes.

5. **Q: How to scale writes?**
   A: Shard/partition, batch, and use write-optimized stores; replicas don't help writes.

6. **Q: What causes hot shards?**
   A: Skewed keys concentrating traffic; fix with better hashing or splitting.

7. **Q: Consistent hashing benefit?**
   A: Minimal data movement when nodes are added/removed.

8. **Q: Read-after-write consistency on replicas?**
   A: Route those reads to the leader or use sticky/quorum reads.

## 8. Practice

- [ ] Design leader-follower for a read-heavy app.
- [ ] Pick and justify a shard key for messages.
- [ ] Explain how to reshard safely.

## 9. Quick Revision

Replication (followers) scales reads + HA but adds lag; sharding splits data for write/storage scale but complicates cross-shard ops. Pick a balanced shard key; prefer single-shard transactions; cache first.

**References:** Database scaling

---

*System Design Handbook — topic 05.*
