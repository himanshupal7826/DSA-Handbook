# 17 · Consistent Hashing

> **In one line:** A hashing scheme that maps both keys and nodes onto a ring so that adding or removing a node moves only ~K/N keys instead of nearly all of them.

---

## 1. Overview

Sharding data across N servers needs a function that turns a key into a server. The naive answer is **`server = hash(key) % N`**. It is fast and perfectly balanced — until N changes. Add one node (N → N+1) and the modulus changes for *almost every key*, so nearly the entire dataset must move. For a cache that means a **mass miss storm** and a thundering herd onto the origin; for a stateful store it means copying terabytes and a long window of unavailability.

**Consistent hashing** (Karger et al., 1997, originally for web caching) fixes this. Keys and nodes are hashed into the *same* circular keyspace — the **hash ring**. A key is owned by the first node found walking **clockwise** from the key's position. When a node joins or leaves, only the keys in *its* arc of the ring move; every other key stays put. The expected fraction relocated is **~K/N** (K keys, N nodes) rather than ~K.

This is the backbone of **Amazon Dynamo** and its descendants (**Cassandra**, **Riak**, **ScyllaDB**), of **memcached client libraries** (ketama), and of many CDN and load-balancer routing layers. It is the standard answer to "how do you partition data so it can grow elastically?"

A concrete example: a 4-node memcached fleet holds 100M cache entries. One node dies. With modulo hashing ~75% of keys now hash to the wrong server → 75M misses hammer the database. With consistent hashing only ~25% (that node's share) are lost; the rest still hit warm cache.

## 2. Core Concepts

- **Hash ring** — the output space of the hash function (e.g. 0 … 2¹²⁸−1 for MD5, or a 32/64-bit space) treated as a circle where the max value wraps to 0.
- **Node placement** — each node is hashed (usually `hash(node_id)` or `hash(ip:port)`) to one or more points on the ring.
- **Clockwise ownership** — a key hashes to a point; its owner is the **first node encountered moving clockwise**. That node owns the arc from the previous node up to itself.
- **Minimal disruption** — adding/removing a node only reassigns the arc between it and its clockwise-neighbor; expected keys moved ≈ **K/N**.
- **Virtual nodes (vnodes)** — each physical node is placed at many ring positions (e.g. 128–256 tokens). This smooths the arc-size variance so load is even and lets you weight heterogeneous hardware.
- **Replication walk** — for a replication factor of R, a key is stored on its owner plus the next **R−1 distinct physical nodes** clockwise (the **preference list**).
- **Bounded imbalance** — with V vnodes per node, load standard deviation shrinks ~1/√V; a few hundred vnodes gives well under 10% skew.
- **Rebalancing is local** — join/leave touches only two neighbors' data, so the network cost is proportional to one node's share, not the whole dataset.
- **Independence from N in the key math** — a key's ring position never changes; only *which node's arc it falls in* changes as membership changes.

## 3. Architecture

Nodes and keys share one circular keyspace. Each key belongs to the next node clockwise. Virtual nodes interleave physical nodes around the ring so no single node owns a giant contiguous arc.

```svg
<svg viewBox="0 0 720 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="arr" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="22" text-anchor="middle" fill="#1e293b" font-weight="700">The Hash Ring — clockwise ownership</text>
  <!-- ring -->
  <circle cx="230" cy="185" r="120" fill="none" stroke="#475569" stroke-width="2"/>
  <text x="230" y="55" text-anchor="middle" fill="#64748b">0 / 2^128</text>
  <!-- direction -->
  <path d="M330 120 A120 120 0 0 1 350 175" fill="none" stroke="#059669" stroke-width="2" marker-end="url(#arr)"/>
  <text x="372" y="135" fill="#059669">clockwise</text>
  <!-- nodes on ring -->
  <circle cx="230" cy="65" r="9" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="230" y="45" text-anchor="middle" fill="#2563eb" font-weight="700">A</text>
  <circle cx="350" cy="185" r="9" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="372" y="190" text-anchor="middle" fill="#2563eb" font-weight="700">B</text>
  <circle cx="230" cy="305" r="9" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="230" y="325" text-anchor="middle" fill="#2563eb" font-weight="700">C</text>
  <circle cx="110" cy="185" r="9" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="88" y="190" text-anchor="middle" fill="#2563eb" font-weight="700">D</text>
  <!-- keys -->
  <circle cx="300" cy="95" r="5" fill="#ecfdf5" stroke="#059669" stroke-width="2"/>
  <text x="312" y="90" fill="#059669">k1</text>
  <circle cx="325" cy="255" r="5" fill="#ecfdf5" stroke="#059669" stroke-width="2"/>
  <text x="337" y="262" fill="#059669">k2</text>
  <circle cx="140" cy="255" r="5" fill="#ecfdf5" stroke="#059669" stroke-width="2"/>
  <text x="118" y="268" fill="#059669">k3</text>
  <!-- ownership arrows -->
  <path d="M304 100 A120 120 0 0 1 348 178" fill="none" stroke="#94a3b8" stroke-dasharray="3 3" marker-end="url(#arr)"/>
  <path d="M328 258 A120 120 0 0 1 236 314" fill="none" stroke="#94a3b8" stroke-dasharray="3 3" marker-end="url(#arr)"/>
  <path d="M136 258 A120 120 0 0 1 112 196" fill="none" stroke="#94a3b8" stroke-dasharray="3 3" marker-end="url(#arr)"/>
  <!-- legend / vnode note -->
  <rect x="480" y="70" width="220" height="200" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="590" y="94" text-anchor="middle" fill="#1e293b" font-weight="700">Key → owner</text>
  <text x="498" y="120" fill="#1e293b">k1 walks CW → owned by <tspan fill="#2563eb" font-weight="700">B</tspan></text>
  <text x="498" y="144" fill="#1e293b">k2 walks CW → owned by <tspan fill="#2563eb" font-weight="700">C</tspan></text>
  <text x="498" y="168" fill="#1e293b">k3 walks CW → owned by <tspan fill="#2563eb" font-weight="700">D</tspan></text>
  <line x1="498" y1="182" x2="682" y2="182" stroke="#d97706" stroke-dasharray="2 2"/>
  <text x="498" y="204" fill="#64748b">Real rings place each node at</text>
  <text x="498" y="222" fill="#64748b">128–256 <tspan fill="#1e293b" font-weight="700">virtual nodes</tspan> so arcs</text>
  <text x="498" y="240" fill="#64748b">are small &amp; evenly sized.</text>
  <text x="498" y="258" fill="#64748b">Add/remove node ⇒ move ~K/N.</text>
</svg>
```

## 4. How It Works

The main flow — placing keys, then absorbing a membership change:

1. **Build the ring.** For each physical node, compute V vnode positions: `pos = hash(node_id + "#" + i)` for `i` in `0..V`. Insert `(pos → node)` into a sorted structure (a balanced tree / sorted array of tokens).
2. **Route a key.** Compute `h = hash(key)`. Find the **smallest token ≥ h** (binary search / `ceilingEntry`); that token's node owns the key. If `h` exceeds the largest token, wrap to the first token (the ring closes).
3. **Read/write.** The client (memcached style) or a coordinator node (Dynamo style) sends the op to the owner. With replication, it also targets the next R−1 distinct physical nodes clockwise.
4. **Add a node X.** Compute X's V tokens and insert them. For each new token, only the keys in the arc between X and its **counter-clockwise predecessor** now belong to X — they are streamed from X's clockwise successor. Everything else is untouched.
5. **Remove / fail a node Y.** Delete Y's tokens. Each of Y's arcs merges into its clockwise successor, which becomes the new owner and (re)builds those keys from replicas. Expected data moved ≈ Y's share ≈ K/N.
6. **Converge.** Membership changes propagate via a config service (ZooKeeper/etcd) or **gossip** (Cassandra/Dynamo). Clients refresh their ring view; brief disagreement is tolerated because ownership is deterministic once views agree.

```text
lookup(key):
  h = hash(key)
  token = ring.ceiling(h)          # first token clockwise, wrap if none
  owner = token.node
  replicas = next R-1 distinct physical nodes clockwise   # preference list
  return owner, replicas
```

## 5. Key Components / Deep Dive

### The ring data structure
A sorted map from **token → node** (e.g. Java `TreeMap`, Go sorted slice + binary search). N physical nodes × V vnodes = N·V tokens. Lookup is **O(log(N·V))**. Memory is trivial (a few MB for tens of thousands of tokens); the hash function should be fast and well-distributed — MD5/Murmur are common (cryptographic strength is not required, uniformity is).

### Virtual nodes and load variance
With one token per node, arc sizes follow the gaps between N random points — high variance, so some node can own 2–3× the average. Placing V tokens per node averages many independent arcs; the coefficient of variation of load falls roughly as **1/√V**. In practice V = 128–256 keeps skew under ~5–10%. Vnodes also enable **weighting**: give a 2× machine 2× the tokens. Cassandra's `num_tokens` is exactly this knob.

### Replication and the preference list
For RF = R, walk clockwise from the key's owner and collect the next R−1 **distinct physical** nodes (skip additional vnodes of a node you already have — otherwise all replicas could land on one machine). Dynamo calls this ordered set the **preference list**. For fault tolerance you further skip nodes so replicas span **racks/AZs**, giving zone-level durability.

### Consistent hashing with bounded loads / rendezvous
Vanilla consistent hashing can still create **hot arcs**. Google's **"consistent hashing with bounded loads"** caps any node at (1+ε)×average and overflows to the next node, trading a little locality for a hard load ceiling. **Rendezvous (HRW) hashing** is an alternative: pick the node maximizing `hash(key, node)` — O(N) per lookup but zero ring state and naturally weighted; good for small N (e.g. shard-selection in proxies).

### Jump consistent hash
Lamping & Veach's **jump hash** maps a key to one of N buckets in O(ln N) time and ~64 bytes of state, with minimal movement on resize. It is faster and perfectly balanced but assumes **buckets numbered 0..N−1** — you can only add/remove at the tail, so it fits stateless bucketing (sharded counters) better than a cluster where arbitrary nodes fail.

## 6. Trade-offs

| Option | Pros | Cons |
|---|---|---|
| **Modulo `hash(key)%N`** | Trivial, perfectly balanced, O(1) | Resize moves ~all keys; no replication story |
| **Consistent hashing + vnodes** | ~K/N movement, elastic, weighted, replication via ring walk | Ring state + gossip; needs enough vnodes for balance |
| **Consistent hashing, no vnodes** | Minimal state | High load skew; hard to weight |
| **Rendezvous (HRW)** | No ring state, natural weights, even spread | O(N) per lookup; poor for large N |
| **Jump hash** | Tiny state, fast, perfectly balanced | Buckets must be contiguous 0..N−1; awkward for arbitrary node removal |
| **Bounded-load CH** | Hard cap on hot nodes | Extra bookkeeping; some keys leave their natural owner |

Consistent hashing with vnodes is the default for distributed **stores**; rendezvous and jump hash shine when N is small or membership only grows at the tail. The core trade is **movement cost on resize** vs **per-lookup cost and balancing effort**.

## 7. When to Use / When to Avoid

**Use when:**
- You shard data/cache across a fleet that **scales elastically** or suffers node failures.
- You want to bound reshuffle cost when membership changes (caches, KV stores, session stores).
- You need **replica placement** derived from the same partitioning (Dynamo-style preference lists).
- You have **heterogeneous** hardware and want weighted distribution (via vnode counts).

**Avoid / reconsider when:**
- N is **fixed and small** and you never resize — plain modulo or a static shard map is simpler.
- You need **range scans** — hashing destroys key order; use **range partitioning** (HBase, Spanner) instead.
- A central coordinator can hold an explicit **lookup table / directory** (a few thousand shards mapped by hand) — sometimes clearer and allows arbitrary rebalancing (e.g. Vitess, Elasticsearch shard allocation).
- Buckets only append at the tail and you want max speed — **jump hash** beats it.

## 8. Scaling & Production Best Practices

- **Use 128–256 vnodes per node**; too few → skew, too many → bloated ring and slow gossip (Cassandra moved from 256 to `num_tokens=16` with the *allocate-tokens* algorithm to reduce streaming while keeping balance).
- **Add nodes in small batches** and throttle streaming (Cassandra `stream_throughput`) so rebalancing doesn't saturate the network or blow p99.
- **Place replicas across AZs/racks** via a topology-aware strategy (Cassandra `NetworkTopologyStrategy`) so a zone loss ≤ RF−1 replicas.
- **Warm caches gradually**: after a topology change, a memcached tier will miss on the moved ~K/N keys — expect an origin load bump and rate-limit backfill.
- **Pin the hash function and ring config** across all clients; a mismatched hash or vnode count silently routes to the wrong node.
- **Deterministic vnode tokens** (seeded, not random) so a restarted node reclaims its arcs and re-warms locality instead of shuffling again.
- At scale, keys per node ≈ K/N; size machines so one node's share fits comfortably in RAM/disk with headroom for a **neighbor's arc** during a failure.

## 9. Failure Modes & Mitigations

| Failure | Impact | Mitigation |
|---|---|---|
| Node dies | Its ~K/N keys unavailable until failover | Replication (RF≥3) so successors serve; hinted handoff |
| Poor hash / few vnodes | Hot node owns 2–3× load | 128+ vnodes; better hash (Murmur); bounded-load CH |
| All replicas on one box | RF illusory — one failure loses data | Skip to distinct physical nodes + rack/AZ awareness |
| Split-brain ring views | Clients route to different owners | Single source of truth (etcd/ZK) or gossip w/ versioning; deterministic ownership |
| Big rebalance storm | Streaming saturates NICs, p99 spikes | Throttle streaming; add nodes incrementally; off-peak |
| Cache tier resize | ~K/N miss storm → origin overload | Gradual backfill, request coalescing, origin rate-limit |
| Clock/token collision | Two nodes claim same token | Hash includes unique node id; detect & re-seed on collision |

## 10. Monitoring & Metrics

- **Per-node key/partition count and byte size** — variance across nodes is your balance signal (alert if max/avg > 1.3).
- **Ownership %** per node vs expected 1/N.
- **Streaming/rebalance throughput and duration** during joins/leaves.
- **Cache hit ratio** before/after topology changes (detects miss storms).
- **Request rate per node / hot-partition detector** (top-K keys) to catch skew a good hash can't fix.
- **Gossip convergence time** / count of divergent ring views.
- **Replica placement audit** — alert if any partition has < RF distinct AZs.
- p99 latency per node — a hot arc shows up as one node's tail blowing out.

## 11. Common Mistakes

1. ⚠️ **Using plain `hash%N`** for a resizable cache/store, then discovering a resize evicts almost everything.
2. ⚠️ **Too few (or one) vnodes**, leaving one node owning a huge arc and becoming a hotspot.
3. ⚠️ **Letting replicas land on vnodes of the same physical node** — RF looks like 3 but a single box loses all copies.
4. ⚠️ **Ignoring rack/AZ topology**, so an entire zone outage takes out a quorum.
5. ⚠️ **Assuming even keys ⇒ even load** — a few hot keys (celebrity, viral) overwhelm one owner regardless of ring balance.
6. ⚠️ **Different hash function or vnode config across clients**, silently misrouting.
7. ⚠️ **Unthrottled rebalancing** that saturates the network and tanks live traffic.
8. ⚠️ **Trying range scans** on a hash-partitioned ring (order is gone; you fan out to every node).

## 12. Interview Questions

**Q: Why not just use `hash(key) % N`?**
A: It is balanced and O(1), but changing N changes the modulus for almost every key, so resizing (or a single node failure) relocates ~all data — a cache miss storm or a massive copy. Consistent hashing moves only ~K/N keys.

**Q: How does a key find its node on the ring?**
A: Hash the key to a point on the ring, then walk **clockwise** to the first node token; that node owns it. Implemented as "smallest token ≥ hash, wrapping to the first token."

**Q: What problem do virtual nodes solve?**
A: With one point per node, arc sizes vary a lot, causing load skew, and you can't weight nodes. Placing each node at many (128–256) tokens averages the arcs (variance ~1/√V) and lets a bigger machine own more tokens.

**Q: Roughly how many keys move when you add the (N+1)th node?**
A: About K/N — the new node's fair share — taken from its clockwise neighbors. Everything else stays put. Contrast with ~K for modulo.

**Q: How is replication done on the ring?**
A: Store the key on its owner plus the next R−1 **distinct physical** nodes clockwise — Dynamo's preference list — and skip nodes so replicas span racks/AZs.

**Q: Who uses this in the real world?**
A: Amazon Dynamo and Cassandra/Riak/Scylla for partitioning + replication; memcached client libs (ketama); many CDNs and L7 proxies for backend selection.

**Q (senior): Consistent hashing balances *keys*, but you still have a hot node. Why, and what do you do?**
A: Balance is about key *count*, not access *frequency*. A few hot keys or a skewed access pattern overload one owner. Mitigations: split/replicate hot keys, add read replicas of that partition, request coalescing, or **consistent hashing with bounded loads** to cap per-node load and overflow to neighbors — accepting reduced locality.

**Q (senior): How do you keep RF replicas actually fault-independent?**
A: Naïvely walking clockwise can pick multiple vnodes of the same physical node or the same rack. Skip to **distinct physical nodes** and enforce **topology awareness** (e.g. NetworkTopologyStrategy) so replicas land in different racks/AZs; then a zone failure costs at most one replica.

**Q (senior): Cassandra moved from 256 tokens to ~16 with an allocation algorithm. Why?**
A: 256 random tokens balance well but fragment ownership into thousands of tiny ranges → expensive streaming on repair/rebuild and heavy gossip. The token-**allocation** algorithm places few tokens deliberately to keep balance while cutting range count, so joins/repairs stream far less.

**Q (senior): How do nodes agree on the ring, and what happens during disagreement?**
A: Via a strongly-consistent config store (etcd/ZooKeeper) or eventually-consistent **gossip** with version numbers. During brief disagreement, requests may hit an old owner; because ownership is deterministic once views converge, and replicas overlap, you tolerate it with read-repair/hinted handoff rather than blocking.

**Q (senior): When would you pick jump hash or rendezvous over ring-based consistent hashing?**
A: **Rendezvous** when N is small and you want zero ring state and natural weighting (proxy backend pick). **Jump hash** when buckets are contiguous 0..N−1 and only grow at the tail (sharded counters), for its tiny state and speed. Ring-based wins when arbitrary nodes fail/join and you need replica placement.

**Q (senior): A resize is causing p99 spikes. Diagnose.**
A: Rebalance streaming is competing with live traffic for NIC/disk. Throttle stream throughput, add nodes in smaller increments off-peak, verify vnode count isn't causing excessive range fragmentation, and confirm you're not simultaneously running repair. Watch per-node streaming bytes and p99 per node.

## 13. Alternatives & Related

- **Range partitioning** — order-preserving shards for scans (see **Database Scaling**); opposite trade-off to hashing.
- **Directory / lookup-table sharding** — explicit map, arbitrary rebalancing (Vitess, ES shard allocation).
- **Rendezvous (HRW)** and **Jump hash** — alternative minimal-movement schemes.
- **CAP, Consistency & Replication** — quorums (R+W>N) over the preference list this produces.
- **Caching** — where the miss-storm motivation is sharpest.
- **Bloom Filters** — often paired in Dynamo/Cassandra read paths to skip SSTables.

## 14. Cheat Sheet

> [!TIP]
> **Consistent Hashing in 8 lines**
> - Problem: `hash%N` moves ~all keys on resize → miss storm / mass copy.
> - Fix: hash keys **and** nodes onto one ring; key → first node **clockwise**.
> - Resize moves only **~K/N** keys (the affected arc), not ~K.
> - **Virtual nodes** (128–256/node) even out load (var ~1/√V) + enable weighting.
> - **Replication** = next R−1 **distinct physical** nodes clockwise = preference list; span AZs.
> - Balance ≠ hotspot-free — hot *keys* still need splitting / bounded-load CH.
> - Lookup: sorted token map, `ceiling(hash)`, O(log N·V).
> - Real users: Dynamo, Cassandra, Riak, memcached (ketama).

**References:** Karger et al. "Consistent Hashing and Random Trees" (1997), Amazon Dynamo paper (SOSP 2007), DDIA ch.6 (Partitioning), Cassandra docs (Data Distribution), Google "Consistent Hashing with Bounded Loads"

---
*System Design Handbook — topic 17.*
