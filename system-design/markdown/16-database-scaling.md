# 16 · Replication & Sharding

> **In one line:** Replication copies data across nodes for availability and read scale; sharding splits it across nodes for write scale and capacity — and you reach for sharding only after everything else fails.

---

## 1. Overview

A single database node has three hard limits: it can lose data if it dies, it can only serve so many reads, and it can only hold and write so much. **Replication** attacks the first two — keep multiple copies of the same data on different nodes, so one can fail without data loss (availability/durability) and reads can spread across copies (read scale). **Sharding** (a.k.a. horizontal partitioning) attacks the third — split the dataset into disjoint pieces on different nodes, so writes and storage scale beyond a single machine.

They are orthogonal and almost always combined: production systems shard the data into partitions, then replicate each partition. DynamoDB, Cassandra, MongoDB, and sharded MySQL/Postgres all do exactly this — N shards, each with R replicas.

The critical asymmetry: replication is comparatively cheap and reversible; **sharding is a one-way door.** Once data is split by a shard key, cross-shard joins, transactions, and unique constraints become hard or impossible, and re-choosing the shard key later means moving everything. So the seasoned answer is: exhaust vertical scaling, read replicas, and caching *first*; shard only when a single primary genuinely can't hold the data or absorb the write rate.

Example: a social app starts on one Postgres. Traffic grows, so reads move to replicas and hot data to Redis — replication and caching, no sharding. Only when the write volume of, say, the messages table exceeds one primary do they shard messages by `user_id`, replicate each shard 3×, and use **consistent hashing** to place partitions so adding a node moves minimal data.

## 2. Core Concepts

- **Replication** — maintaining copies of the same data on multiple nodes for availability, durability, and read scale. Copies must be kept in sync.
- **Leader–follower (primary–replica)** — one node accepts writes (the **leader**), streams its change log to read-only **followers**. Simplest model; single write point.
- **Multi-leader** — multiple nodes accept writes (e.g. one per datacenter) and replicate to each other. Better write availability/locality, but write–write **conflicts** must be resolved.
- **Leaderless** — any replica accepts reads and writes; consistency comes from **quorums** (Dynamo/Cassandra style) rather than a designated leader.
- **Sync vs async replication** — synchronous: leader waits for follower ack before committing (no data loss, higher latency); asynchronous: leader commits immediately (fast, but a crash can lose un-replicated writes).
- **Replication lag** — the delay before a write on the leader appears on a follower; the root cause of stale reads and read-your-writes anomalies.
- **Read replica** — a follower serving read traffic to offload the leader; reads may be slightly stale due to lag.
- **Failover** — promoting a follower to leader when the leader dies; the risky part of leader–follower, prone to split-brain and lost writes.
- **Sharding (horizontal partitioning)** — splitting rows across nodes by a **shard key** so each node owns a disjoint subset. Scales writes and storage.
- **Shard key** — the column(s) that decide which shard a row lives on. The single most consequential choice; determines distribution and which queries stay single-shard.
- **Hot shard** — a shard receiving disproportionate load due to a skewed key or a celebrity/large tenant; the classic sharding failure.
- **Quorum (R + W > N)** — in leaderless systems, requiring reads and writes to overlap on enough replicas to guarantee a read sees the latest write.

## 3. Architecture

The standard production topology combines both axes: the data is sharded into N partitions by a shard key, and each partition is replicated R times (one leader + R−1 followers, or a leaderless replica set). A router/coordinator directs each request to the right shard, then to a leader (writes) or a follower (reads).

```svg
<svg viewBox="0 0 760 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#475569"/>
    </marker>
  </defs>
  <text x="380" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">Sharded + replicated: N partitions × R replicas</text>

  <rect x="310" y="40" width="140" height="36" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="380" y="63" text-anchor="middle" fill="#1e293b">Router / Coordinator</text>
  <text x="470" y="62" fill="#64748b" font-size="11">hash(shard_key) → shard</text>

  <!-- Shard A -->
  <rect x="40" y="110" width="200" height="200" rx="10" fill="none" stroke="#94a3b8" stroke-dasharray="4 3"/>
  <text x="140" y="130" text-anchor="middle" fill="#64748b" font-size="12">Shard A  (keys 0–k)</text>
  <rect x="70" y="142" width="140" height="34" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="140" y="164" text-anchor="middle" fill="#1e293b">Leader A (writes)</text>
  <rect x="70" y="200" width="140" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="140" y="220" text-anchor="middle" fill="#1e293b" font-size="12">Follower A1 (read)</text>
  <rect x="70" y="250" width="140" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="140" y="270" text-anchor="middle" fill="#1e293b" font-size="12">Follower A2 (read)</text>
  <line x1="140" y1="176" x2="140" y2="200" stroke="#475569" marker-end="url(#a3)"/>
  <line x1="140" y1="230" x2="140" y2="250" stroke="#475569" marker-end="url(#a3)"/>
  <text x="228" y="215" fill="#64748b" font-size="10" transform="rotate(90 228 215)">async replicate</text>

  <!-- Shard B -->
  <rect x="280" y="110" width="200" height="200" rx="10" fill="none" stroke="#94a3b8" stroke-dasharray="4 3"/>
  <text x="380" y="130" text-anchor="middle" fill="#64748b" font-size="12">Shard B  (keys k–m)</text>
  <rect x="310" y="142" width="140" height="34" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="380" y="164" text-anchor="middle" fill="#1e293b">Leader B (writes)</text>
  <rect x="310" y="200" width="140" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="380" y="220" text-anchor="middle" fill="#1e293b" font-size="12">Follower B1 (read)</text>
  <rect x="310" y="250" width="140" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="380" y="270" text-anchor="middle" fill="#1e293b" font-size="12">Follower B2 (read)</text>
  <line x1="380" y1="176" x2="380" y2="200" stroke="#475569" marker-end="url(#a3)"/>
  <line x1="380" y1="230" x2="380" y2="250" stroke="#475569" marker-end="url(#a3)"/>

  <!-- Shard C -->
  <rect x="520" y="110" width="200" height="200" rx="10" fill="none" stroke="#94a3b8" stroke-dasharray="4 3"/>
  <text x="620" y="130" text-anchor="middle" fill="#64748b" font-size="12">Shard C  (keys m–z)</text>
  <rect x="550" y="142" width="140" height="34" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="620" y="164" text-anchor="middle" fill="#1e293b">Leader C (writes)</text>
  <rect x="550" y="200" width="140" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="620" y="220" text-anchor="middle" fill="#1e293b" font-size="12">Follower C1 (read)</text>
  <rect x="550" y="250" width="140" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="620" y="270" text-anchor="middle" fill="#1e293b" font-size="12">Follower C2 (read)</text>
  <line x1="620" y1="176" x2="620" y2="200" stroke="#475569" marker-end="url(#a3)"/>
  <line x1="620" y1="230" x2="620" y2="250" stroke="#475569" marker-end="url(#a3)"/>

  <line x1="345" y1="76" x2="150" y2="140" stroke="#475569" marker-end="url(#a3)"/>
  <line x1="380" y1="76" x2="380" y2="140" stroke="#475569" marker-end="url(#a3)"/>
  <line x1="415" y1="76" x2="610" y2="140" stroke="#475569" marker-end="url(#a3)"/>

  <text x="380" y="330" text-anchor="middle" fill="#64748b" font-size="11">Sharding scales writes/storage (across shards); replication scales reads + gives failover (within a shard).</text>
</svg>
```

## 4. How It Works

**Replication (leader–follower) write and read flow:**

1. **Write hits the leader.** Only the leader accepts writes for its data; it applies the change and appends it to a **replication log** (WAL/binlog/oplog).
2. **Log ships to followers.** Followers pull the change stream and apply it in order, converging to the leader's state. Under **async** replication the leader has already acked the client; under **sync** it waits for at least one follower's ack first.
3. **Reads fan out to followers.** Read traffic is routed to followers to offload the leader — accepting that a follower may lag by milliseconds to seconds.
4. **Leader fails → failover.** A follower is promoted: the system detects the leader is down, picks the most up-to-date follower, reconfigures routing, and the new leader accepts writes. Async-replicated writes not yet shipped are **lost** unless recovered.

**Sharding request flow:**

5. **Route by shard key.** The client/router computes the target shard from the shard key — `hash(key) mod N`, a range lookup, or a directory service — and sends the request there.
6. **Single-shard op stays local.** A read/write touching one shard key is served entirely by that shard (fast, scalable). This is the design goal — keep the common query single-shard.
7. **Cross-shard op scatters.** A query spanning shards (a join, an aggregate, a search without the shard key) must scatter to all shards and gather results — slow, and it can't be transactional without distributed coordination.
8. **Resharding.** As the cluster grows you add shards and rebalance data; with **consistent hashing** this moves only ~1/N of keys instead of nearly all of them.

## 5. Key Components / Deep Dive

### Replication topologies
- **Leader–follower** — one writer, many readers. Simple, strongly ordered writes, easy reasoning; the leader is a write bottleneck and a failover risk. The default for Postgres/MySQL.
- **Multi-leader** — writers in multiple regions replicate to each other; great for write locality and surviving a region outage, but concurrent writes to the same row **conflict** and need resolution (last-write-wins, version vectors, or CRDTs). Used for multi-datacenter and offline-sync apps.
- **Leaderless (Dynamo-style)** — clients write to and read from multiple replicas directly, using **quorums** (R + W > N) for consistency, plus read-repair and hinted handoff to heal divergence. High availability and no failover step; the app must tolerate eventual consistency. Cassandra, DynamoDB, Riak.

### Sync vs async and replication lag
Synchronous replication guarantees a committed write survives a leader failure (no data loss) but ties commit latency to the slowest replica and stalls if a follower is down. Asynchronous replication keeps writes fast and the leader independent, but a leader crash loses any writes not yet shipped, and followers serve **stale reads**. The common middle ground is **semi-synchronous**: one synchronous follower for durability, the rest async for scale. **Replication lag** is what breaks intuitions — a user updates their profile (leader) then reloads and reads a follower that hasn't caught up, seeing the old value. Fixes: read-your-writes routing (read from leader after your own write), monotonic-read routing (stick a session to one replica), or a consistency token.

### Failover hazards
Promotion is where systems lose data or split-brain. Async lag means the promoted follower may be missing the old leader's last writes (lost writes). If the old leader comes back thinking it's still primary, you get **split-brain** — two leaders accepting conflicting writes. Guards: consensus-based leader election (Raft/ZooKeeper), fencing tokens to reject the zombie leader, and careful timeout tuning (too aggressive → needless failovers, too slow → long outages).

### Sharding strategies
| Strategy | How it splits | Best for / cost |
|---|---|---|
| **Range** | Contiguous key ranges per shard (A–F, G–M…) | Efficient range scans; **prone to hotspots** if keys are sequential (e.g. time) |
| **Hash** | `hash(key)` → shard; spreads uniformly | Even load; **loses range-scan locality**; resharding moves data unless consistent hashing |
| **Geo / entity** | By region or tenant | Data locality, compliance (residency); risk of uneven regions/tenants |
| **Directory** | A lookup table maps key → shard | Maximum flexibility, easy rebalancing; the directory is a bottleneck/SPOF to protect |

### Consistent hashing for placement
Naive `hash(key) mod N` remaps almost every key when N changes — catastrophic on resharding. **Consistent hashing** places both nodes and keys on a hash ring; a key belongs to the next node clockwise, so adding/removing a node moves only the keys between it and its neighbor (~1/N), not the whole dataset. Virtual nodes smooth out imbalance. This is how Dynamo/Cassandra place partitions and rebalance with minimal movement — see the sibling topic **Consistent Hashing**.

### Cross-shard queries, joins, and transactions
A query that includes the shard key hits one shard and is trivial. Anything else — a join across shards, an aggregate over all data, a search on a non-shard-key column, or a transaction spanning shards — becomes a **scatter-gather** (query every shard, merge) or needs **distributed transactions** (2PC/Saga), which are slow and fragile. Mitigations: choose the shard key so the *dominant* query is single-shard; denormalize the join at write time; maintain global secondary indexes/derived stores for the odd cross-shard read. This loss is the core reason sharding is a last resort.

## 6. Trade-offs

| Option | Pros | Cons |
|---|---|---|
| **Leader–follower repl.** | Simple, ordered writes, easy read scaling, mature | Single write bottleneck; failover risk & lost async writes; stale replica reads |
| **Multi-leader repl.** | Write locality, survives region loss, offline-capable | Write conflicts + resolution complexity; weaker consistency |
| **Leaderless (quorum)** | High availability, no failover step, tunable consistency | Eventual consistency; app must handle conflicts/repair |
| **Sync replication** | No data loss on failover | Higher write latency; stalls if a replica is slow/down |
| **Async replication** | Fast writes, leader independent | Lost writes on crash; stale reads |
| **Range sharding** | Fast range scans, ordered | Hotspots on sequential keys |
| **Hash sharding** | Even load distribution | No range locality; resharding pain (mitigated by consistent hashing) |

Replication is the first tool: cheap availability and read scale. Sharding is the last: it buys write/storage scale at the permanent cost of joins, cross-shard transactions, and operational complexity. The whole art is delaying sharding with vertical scaling, replicas, and caching — then, when forced, picking a shard key whose dominant access pattern stays single-shard.

## 7. When to Use / When to Avoid

**Use replication when:**
- You need high availability / durability (survive a node loss with no data loss).
- Reads dominate and you can offload them to followers.
- You want geographic read locality (replicas near users) or DR in another region.

**Use sharding when:**
- A single primary genuinely can't hold the dataset or absorb the **write** rate — and you've already exhausted vertical scaling, read replicas, and caching.
- There's a natural shard key that keeps the dominant query single-shard (e.g. `user_id`, `tenant_id`).

**Avoid / delay sharding when:**
- Reads are the bottleneck (use replicas + cache instead).
- Your workload needs cross-entity joins, multi-row transactions, or global unique constraints — sharding breaks these.
- You can still scale up hardware or split by function (move a big table to its own DB) — do that first.

## 8. Scaling & Production Best Practices

- **Climb the ladder in order:** vertical scale → read replicas → cache → functional/vertical split → shard. Each step buys time and avoids the one-way door.
- **Pick the shard key for even distribution *and* single-shard dominant queries.** Validate against real key distribution; a `tenant_id` shard key hotspots on your biggest customer.
- **Use consistent hashing (with virtual nodes)** for placement so resharding moves ~1/N of data, not everything.
- **Keep replication lag bounded and observable;** route read-your-writes to the leader (or a synced replica) for the writing session. Typical healthy lag: milliseconds; alert past ~1–2 s.
- **Automate failover with consensus + fencing** (Raft/etcd/ZooKeeper, or managed RDS/Aurora) to prevent split-brain; test it with game days.
- **Isolate hot tenants/keys:** give a celebrity or mega-tenant its own shard, or add a salt/composite key to spread them.
- **Reshard online:** move partitions in the background with dual-read/backfill + cutover; never a big-bang migration.
- **Minimize cross-shard work:** denormalize joins at write time; keep global secondary indexes or a search/analytics store for the rare cross-shard read.

## 9. Failure Modes & Mitigations

| Failure | Impact | Mitigation |
|---|---|---|
| Replication lag spike | Stale reads, broken read-your-writes | Route session reads to leader/synced replica; alert on lag; cap follower read staleness |
| Failover loses async writes | Silent data loss | Semi-sync (one sync replica); consensus election choosing most-current follower |
| Split-brain (two leaders) | Divergent, conflicting writes | Consensus-based election + fencing tokens; STONITH old leader |
| Hot shard (skewed key) | One node saturates; tail latency + throttling | Better shard key (hash/salt/composite); isolate hot tenant on its own shard |
| Resharding moves too much data | Long, risky migration; load spike | Consistent hashing + virtual nodes; online background rebalancing |
| Cross-shard transaction needed | Slow 2PC or impossible atomicity | Redesign to single-shard; Saga with compensation; denormalize |
| Follower thundering herd on leader promotion | New leader overwhelmed | Warm caches, staggered reconnection, rate-limit replica catch-up |

## 10. Monitoring & Metrics

- **Replication lag (seconds/bytes) per follower** — the top gate on safe replica reads; alert past threshold.
- **Write/read QPS per shard** and **per-key/per-tenant rate** — reveals hot shards early.
- **Shard data-size skew** — max vs median shard size; triggers rebalancing.
- **Failover count & duration**, **leader-election time**, **split-brain detections**.
- **Cross-shard query rate & latency** — rising scatter-gather signals a shard-key mismatch.
- **Quorum read/write success rate & repair backlog** (leaderless) — convergence health.
- **Resharding progress & data moved** during rebalancing.
- **Primary write saturation** (CPU, IOPS, connections) — the metric that tells you sharding is coming.

## 11. Common Mistakes

1. ⚠️ Sharding to solve a *read* bottleneck — replicas and a cache were the answer, and sharding added permanent complexity for nothing.
2. ⚠️ Picking a shard key that concentrates load (low cardinality, or one giant tenant) → an unfixable hot shard.
3. ⚠️ Using `hash(key) mod N` for placement, so adding a node reshuffles nearly the whole dataset — should be consistent hashing.
4. ⚠️ Treating async read replicas as strongly consistent and shipping read-your-writes bugs.
5. ⚠️ Naive failover without consensus/fencing → split-brain and conflicting writes.
6. ⚠️ Designing queries that need cross-shard joins/transactions instead of choosing a shard key that keeps them single-shard.
7. ⚠️ Big-bang resharding with downtime instead of online background rebalancing.
8. ⚠️ Never testing failover, then discovering during a real outage that promotion loses data or never completes.

## 12. Interview Questions

**Q: What's the difference between replication and sharding?**
A: Replication copies the *same* data to multiple nodes — for availability/durability and read scale. Sharding splits *different* data across nodes by a shard key — for write and storage scale. They're orthogonal and usually combined: shard into N partitions, replicate each R times. Replication is cheap and reversible; sharding is a one-way door that breaks joins and transactions.

**Q: Explain leader–follower, multi-leader, and leaderless replication.**
A: Leader–follower: one node takes writes and streams a log to read-only followers — simple, ordered, but a single write point with failover risk. Multi-leader: several nodes accept writes and replicate to each other — great for regional locality but requires conflict resolution. Leaderless: any replica takes reads/writes and consistency comes from quorums (R+W>N) plus read-repair — highly available, eventually consistent, no failover step.

**Q: Sync vs async replication — what's the trade-off?**
A: Sync waits for a follower to ack before committing — no data loss on failover, but commit latency is tied to the slowest replica and stalls if one is down. Async commits immediately — fast and leader-independent, but a crash loses un-shipped writes and followers serve stale reads. Semi-sync (one sync follower, rest async) is the common compromise.

**Q: What is replication lag and how do you handle read-your-writes under it?**
A: Lag is the delay before a write on the leader reaches a follower; a user can write then read a stale follower. Handle it by routing that session's reads to the leader (or a synced replica) after a write, or pin the session to one replica (monotonic reads), or use a consistency/version token so the read waits until the replica has caught up.

**Q: Walk me through the sharding strategies and when each fits.**
A: Range — contiguous key ranges, great for range scans but hotspots on sequential keys. Hash — `hash(key)` spreads load evenly but loses range locality and reshuffles on resize (use consistent hashing). Geo/entity — by region/tenant for locality and compliance, risk of uneven regions. Directory — a lookup table mapping key→shard, maximally flexible but the directory is a SPOF to protect.

**Q: What is a hot shard and how do you fix it?**
A: A shard taking disproportionate load from a skewed key or a celebrity/mega-tenant, so one node saturates while others idle. Fixes: choose a higher-cardinality or composite/salted shard key to spread the load; isolate the hot tenant on its own dedicated shard; or add a caching layer for its hot keys. Prevention is validating the key against real distribution before sharding.

**Q: Why is sharding considered a last resort?**
A: Because it's a one-way door that permanently costs you cross-shard joins, multi-row transactions, and global unique constraints, plus operational complexity (rebalancing, hot shards, failover per shard). Before sharding you can vertical-scale, add read replicas, cache, and split by function — all reversible. You shard only when a single primary truly can't hold the data or absorb the write rate.

**Q (senior): How does consistent hashing help with sharding, and what problem does it solve?**
A: With `hash(key) mod N`, changing N remaps nearly every key, so adding a shard means moving almost all data — a catastrophic rebalance. Consistent hashing places nodes and keys on a ring; each key maps to the next node clockwise, so adding/removing a node only moves the keys in its arc — about 1/N of the data. Virtual nodes smooth imbalance and speed rebalancing. It's how Dynamo/Cassandra place and move partitions cheaply — see **Consistent Hashing**.

**Q (senior): Your leader crashes and after failover users report lost writes. What happened and how do you prevent it?**
A: Async replication — the promoted follower hadn't received the leader's last writes, so promotion lost them. Prevent with semi-synchronous replication (at least one synchronous follower so a committed write is guaranteed on two nodes), consensus-based election that promotes the most up-to-date replica, and fencing so the old leader can't return as a zombie and reintroduce conflicts. There's an inherent latency-vs-durability trade you tune per system.

**Q (senior): A query needs to join two tables sharded on different keys. How do you handle it?**
A: You can't do a distributed join cheaply. Options in order of preference: (1) reshard/design so both tables share the shard key and the join is single-shard; (2) denormalize — precompute and store the joined result at write time so the read is a single lookup; (3) maintain a derived/secondary-indexed store (search or analytics) fed by CDC for that access pattern; (4) as a last resort, scatter-gather and merge in the application, accepting the latency. The lesson is to choose the shard key around the dominant join.

**Q (senior): How do you reshard a live system from 4 to 8 shards with no downtime?**
A: Never big-bang. Use consistent hashing so only ~half the keys move. Bring up the new shards, start dual-writing and backfilling the migrating key ranges in the background, verify via dual-reads/checksums, then atomically flip the routing for each range and stop writing to the old location. Throttle the backfill to protect live traffic, and keep the old data until verification passes so you can roll back.

**Q (senior): Multi-leader replication across two datacenters — what breaks and how do you resolve it?**
A: Concurrent writes to the same row in different datacenters conflict, and async replication means neither sees the other at write time. Resolution strategies: last-write-wins by timestamp (simple, silently drops data), version vectors to detect and surface conflicts for app resolution, or CRDTs that merge deterministically (great for counters, sets). You also need to prevent replication loops and handle the asymmetric latency. It's why single-leader is preferred unless you truly need multi-region writes.

## 13. Alternatives & Related

- **Consistent Hashing** — the placement algorithm that makes hash-sharding and resharding cheap; pair it with this topic.
- **CAP & Consistency Models** — the theory governing what replication can guarantee under partitions; quorum tuning.
- **SQL vs NoSQL & Data Modeling** — how the datastore family determines your sharding/replication story.
- **Indexes, B-Trees & LSM-Trees** — the per-node storage engine underneath each replica.
- **Caching** — the read-scale tool you deploy *before* sharding.
- **NewSQL** (Spanner, CockroachDB, TiDB) — systems that automate sharding + replication while preserving SQL and distributed transactions.

## 14. Cheat Sheet

> [!TIP]
> - **Replication = copies of the same data** → availability, durability, read scale. **Sharding = split different data** → write + storage scale. Combine them (N shards × R replicas).
> - **Ladder before sharding:** vertical scale → read replicas → cache → functional split → *then* shard. Sharding is a one-way door.
> - **Replication modes:** leader–follower (simple, single writer), multi-leader (regional writes + conflicts), leaderless (quorum R+W>N, highly available).
> - **Sync = no data loss, slower; async = fast, can lose writes + stale reads.** Semi-sync is the compromise.
> - **Replication lag breaks read-your-writes** — route session reads to leader/synced replica.
> - **Failover risks:** lost async writes + split-brain → use consensus election + fencing.
> - **Shard key is destiny:** even distribution + keep the dominant query single-shard. Hot shard = skewed key; isolate or salt it.
> - **Sharding strategies:** range (scans, hotspots), hash (even, use **consistent hashing** for cheap resharding), geo/entity (locality), directory (flexible, SPOF).
> - **Cross-shard joins/txns are the tax** — design them out; denormalize or use derived stores.

**References:** DDIA ch.5 (Replication) & ch.6 (Partitioning), Amazon Dynamo paper (2007), Google Spanner paper (2012), MongoDB & Vitess sharding docs

---
*System Design Handbook — topic 16.*
