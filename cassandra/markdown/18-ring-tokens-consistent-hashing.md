# 18 · The Ring, Tokens & Consistent Hashing

> **In one line:** Every Cassandra node owns a set of positions on a 2^64 token ring, Murmur3 maps each partition key to one of those positions, and that single mapping — computable by any node or client without a lookup service — is what makes the cluster masterless.

---

## 1. Overview

Consistent hashing is the idea that makes Cassandra possible. In a naive sharded system you compute `node = hash(key) % N`, which works beautifully until `N` changes: adding one node to a 10-node cluster remaps roughly 90% of all keys. Consistent hashing, introduced by Karger et al. in 1997 for distributed web caching, replaces modulo with a **ring**: hash both keys and nodes into the same circular space, and assign each key to the first node encountered walking clockwise. Adding a node now displaces only the keys between it and its predecessor — roughly `1/N` of the data. Amazon's Dynamo paper (2007) applied this to a database, and Cassandra inherited it directly.

The ring in Cassandra is the full range of a signed 64-bit integer: `-2^63` to `2^63 - 1`, wrapping around so that the successor of `2^63 - 1` is `-2^63`. A **token** is a position on that ring. The **partitioner** — `Murmur3Partitioner` since 1.2, and the only sane choice today — hashes a partition key into a token. Replica placement then walks clockwise from that token, collecting the next `RF` distinct nodes according to the replication strategy. That is the entire routing algorithm, and it is why every node knows where every key lives without consulting a master, a config server, or a metadata shard.

The problem this solves is not just elasticity; it is *operational simplicity under failure*. Because ownership is derived from a gossiped token map rather than assigned by a coordinator, there is no election, no split-brain, and no metadata service to keep alive. A node that rejoins simply re-announces its tokens. A client driver that knows the token map routes requests directly to a replica, eliminating a network hop. This is why Cassandra clusters routinely run to hundreds of nodes without a control-plane bottleneck.

**Virtual nodes (vnodes)** are the refinement. In the original design each node owned exactly one token, which meant that adding a node split exactly one neighbour's range — so rebuilds streamed from a single source, and any imbalance was permanent until you manually rebalanced. Cassandra 1.2 (CASSANDRA-4119) let each node own `num_tokens` randomly-chosen tokens, spreading its ownership across many small ranges. Bootstrapping now streams from many peers in parallel, and load evens out statistically. The default was 256 for years; Cassandra 4.0 lowered it to **16** and added the `allocate_tokens_for_local_replication_factor` allocation algorithm (CASSANDRA-7032), because 256 vnodes made repair, streaming, and availability materially worse. Cassandra 5.0 keeps 16 as the recommended default.

A concrete example: Apple runs Cassandra deployments in the tens of thousands of nodes; Netflix runs hundreds of clusters across multiple AWS regions. Neither has a metadata master. When Netflix scales a cluster from 60 to 90 nodes during a regional failover, the new nodes pick tokens, gossip them, stream the ranges they now own from the existing owners, and begin serving traffic — with clients discovering the new topology through protocol events and re-computing routing locally.

## 2. Core Concepts

- **Token** — a signed 64-bit position on the ring, from `-2^63` to `2^63 - 1`, wrapping. Both nodes and partition keys map into this space.
- **Partitioner** — the function mapping a partition key to a token. `Murmur3Partitioner` (default, non-cryptographic, fast, well-distributed); `RandomPartitioner` (legacy MD5, 0..2^127-1); `ByteOrderedPartitioner` (deprecated — produces hot spots and must never be used).
- **Token range** — the interval `(predecessor_token, node_token]`, half-open at the low end. A node is the *primary* owner of every key whose token falls in its ranges.
- **vnodes (`num_tokens`)** — the number of tokens a single node owns. Default 16 in 4.x/5.0; 256 historically. More vnodes means finer-grained ownership but more ranges to repair and higher probability that any quorum-breaking pair of failures overlaps.
- **Replication strategy** — how the clockwise walk selects replicas. `NetworkTopologyStrategy` skips nodes until it has `RF` replicas in *distinct racks* per DC; `SimpleStrategy` ignores topology and must never be used in production.
- **Natural replicas / replica set** — the `RF` nodes returned by the placement walk for a given token. Deterministic and computable by any node or driver.
- **Ownership percentage** — the fraction of the ring a node owns, shown by `nodetool status` as `Owns`; with `NetworkTopologyStrategy` it is only meaningful with a keyspace argument.
- **Token allocation algorithm** — `allocate_tokens_for_local_replication_factor: 3` in `cassandra.yaml`, which picks new tokens to minimise ownership variance instead of choosing them randomly. Essential at low `num_tokens`.
- **Token-aware routing** — the driver's ability to compute `murmur3(pk)` client-side and send the request straight to a replica, saving a coordinator hop.
- **Range movement** — the streaming of token ranges between nodes during bootstrap, decommission, or `nodetool move`. Only one node should join or leave at a time unless `cassandra.consistent.rangemovement` semantics are understood.

## 3. Theory & Internals

**The hash.** `Murmur3Partitioner` computes a 128-bit MurmurHash3 (x64 variant) of the serialised partition key and takes the **first 64 bits** as a signed long, with one special case: the value `Long.MIN_VALUE` is remapped to `Long.MAX_VALUE`, because `MIN_VALUE` is reserved as the exclusive lower bound of the ring. Murmur3 is not cryptographic, which is fine — the requirement is uniform distribution and speed, not preimage resistance. It replaced MD5-based `RandomPartitioner` in 1.2 for a roughly 3–5× hashing speedup with equal distribution quality.

You can compute a token yourself in CQL:

```
SELECT token(customer_id, order_month) FROM orders_by_customer WHERE ...;
-- e.g. -3874116103880171532
```

**The math of distribution.** With `T` total tokens spread over the ring and uniformly random placement, each range has expected length `2^64 / T` but the lengths follow an exponential distribution — the variance is high. The coefficient of variation of per-node ownership scales as `1/sqrt(num_tokens)`. With `num_tokens = 1`, imbalance can easily exceed 50%. With 256, the standard deviation drops to roughly 6%, which is why 256 was originally chosen. With 16 and *random* selection, you would see ~25% variance — unacceptable. That is precisely why 4.0 pairs `num_tokens: 16` with `allocate_tokens_for_local_replication_factor`, an algorithm that deterministically picks tokens to equalise replicated ownership, achieving under ~5% variance at 16 tokens.

**Why fewer vnodes is better despite the variance.** Three reasons, all discovered the hard way:

1. **Availability.** A quorum is lost for a range when 2 of its 3 replicas are down. With one token per node, a given node shares ranges with only ~2 neighbours per DC, so most random 2-node failures do not overlap. With 256 vnodes, a node shares ranges with essentially *every* other node, so **any** two simultaneous node failures in the cluster take some range below quorum. Vnodes trade rebuild speed for a dramatically higher probability of partial unavailability.
2. **Repair cost.** Repair builds a Merkle tree per range. 256 vnodes × 100 nodes = 25,600 ranges to validate instead of 100, and each validation is a full compaction-like scan. Repairs that should take an hour take a day.
3. **Streaming overhead.** Bootstrap opens a stream session per range per peer; at 256 vnodes that is thousands of concurrent sessions with per-session overhead and far more small files.

**Replica placement.** For `NetworkTopologyStrategy` with `{'us_east': 3}`, the algorithm is: start at the key's token, walk clockwise through the ring, and for each node in `us_east`, accept it if its rack has not yet contributed a replica; if all racks are already used, accept anyway. This gives rack-diversity when the topology permits — which is why the number of racks should be a multiple of RF (3 racks for RF=3 maps cleanly onto 3 AZs) and why a 2-rack topology with RF=3 silently gives you two replicas in one rack.

```svg
<svg viewBox="0 0 720 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="720" height="380" fill="#ffffff"/>
  <text x="360" y="24" text-anchor="middle" font-size="15" font-weight="600" fill="#1e293b">The token ring: murmur3(pk) then walk clockwise for RF replicas</text>
  <circle cx="250" cy="200" r="130" fill="none" stroke="#4f46e5" stroke-width="2"/>
  <text x="250" y="58" text-anchor="middle" font-size="11" fill="#1e293b">token 0</text>
  <text x="250" y="348" text-anchor="middle" font-size="11" fill="#1e293b">+/- 2^63 (wrap)</text>
  <circle cx="250" cy="70" r="9" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="250" y="92" text-anchor="middle" font-size="10" fill="#1e293b">N1 rack-a</text>
  <circle cx="363" cy="135" r="9" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="405" y="132" text-anchor="middle" font-size="10" fill="#1e293b">N2 rack-b</text>
  <circle cx="363" cy="265" r="9" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="405" y="270" text-anchor="middle" font-size="10" fill="#1e293b">N3 rack-c</text>
  <circle cx="250" cy="330" r="9" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="250" y="320" text-anchor="middle" font-size="10" fill="#1e293b">N4 rack-a</text>
  <circle cx="137" cy="265" r="9" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="95" y="270" text-anchor="middle" font-size="10" fill="#1e293b">N5 rack-b</text>
  <circle cx="137" cy="135" r="9" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="95" y="132" text-anchor="middle" font-size="10" fill="#1e293b">N6 rack-c</text>
  <circle cx="316" cy="97" r="6" fill="#d97706"/>
  <text x="318" y="88" font-size="10" fill="#1e293b">key</text>
  <path d="M322 103 A 130 130 0 0 1 358 128" stroke="#d97706" stroke-width="3" fill="none"/>
  <path d="M358 128 l-2 -10 l8 6 z" fill="#d97706"/>
  <rect x="420" y="60" width="285" height="150" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="562" y="84" text-anchor="middle" font-size="12" font-weight="600" fill="#1e293b">Placement walk, RF=3, NTS</text>
  <text x="440" y="108" font-size="11" fill="#1e293b">token = murmur3('cust-42|2026-07')</text>
  <text x="440" y="128" font-size="11" fill="#1e293b">1st clockwise node: N2 (rack-b)  &#8594; replica</text>
  <text x="440" y="148" font-size="11" fill="#1e293b">next: N3 (rack-c)  new rack  &#8594; replica</text>
  <text x="440" y="168" font-size="11" fill="#1e293b">next: N4 (rack-a)  new rack  &#8594; replica</text>
  <text x="440" y="190" font-size="11" font-weight="600" fill="#1e293b">replica set = {N2, N3, N4}</text>
  <rect x="420" y="222" width="285" height="118" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="562" y="246" text-anchor="middle" font-size="12" font-weight="600" fill="#1e293b">Range ownership</text>
  <text x="440" y="270" font-size="11" fill="#1e293b">N2 owns (token(N1), token(N2)]</text>
  <text x="440" y="290" font-size="11" fill="#1e293b">half-open: low exclusive, high inclusive</text>
  <text x="440" y="312" font-size="11" fill="#1e293b">Adding a node splits ONE range per vnode</text>
  <text x="440" y="332" font-size="11" fill="#1e293b">&#8594; only ~1/N of keys move, not 90%</text>
</svg>
```

**Multi-DC.** Each DC has its own logical placement over the *same* ring; `NetworkTopologyStrategy` walks the ring once and collects `RF_dc` replicas per DC independently. Tokens must therefore be unique cluster-wide, not per-DC. This is why `LOCAL_QUORUM` works: the local DC has its own full replica set, so a quorum can be satisfied without leaving the region.

## 4. Architecture & Workflow

Trace a request and then a topology change:

1. **Client computes the token.** With `TokenAwarePolicy` enabled, the driver serialises the bound partition key exactly as the server would, hashes it with Murmur3, and looks up the owning replicas in its locally-cached token map (refreshed from `system.peers_v2` and protocol topology events).
2. **Coordinator selection.** The driver picks a live local-DC replica as coordinator, shuffling among them for load spread. This removes one network hop versus routing to an arbitrary node.
3. **Coordinator confirms placement.** The coordinator independently computes the token and the replica set — it does not trust the client — and dispatches to the replicas.
4. **Gossip maintains the map.** Every second, each node gossips with up to three peers, exchanging heartbeat versions and application state including `TOKENS`, `DC`, `RACK`, `STATUS`, and `SCHEMA`. The token map converges cluster-wide in `O(log N)` rounds.
5. **A new node bootstraps.** It starts with `auto_bootstrap: true`, contacts the seeds, learns the ring, and either reads `initial_token` from config or allocates `num_tokens` tokens — using `allocate_tokens_for_local_replication_factor` to minimise variance if configured.
6. **Ranges are claimed.** The joining node announces `STATUS=BOOT` with its tokens. Existing owners compute which ranges they will lose and begin **streaming** those SSTable ranges to the newcomer. The node shows as `UJ` in `nodetool status`.
7. **Writes are double-written.** During bootstrap, writes for the pending ranges go to both the old and new owner, so no data is missed. Reads still go to the old owner until the move completes.
8. **Join completes.** The node announces `STATUS=NORMAL`, becomes `UN`, and starts serving reads. Old owners can then run `nodetool cleanup` to delete data they no longer own — until they do, disk usage does not drop.
9. **Decommission is the mirror.** `nodetool decommission` streams the leaving node's ranges to their new owners *before* it exits, so the ring never loses a replica. `nodetool removenode` is the version for an already-dead node and streams from surviving replicas instead.
10. **Clients re-learn.** The protocol emits `TOPOLOGY_CHANGE` events; drivers refresh `system.peers_v2` and rebuild the token map, so routing follows the new ownership within seconds.

```svg
<svg viewBox="0 0 720 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="720" height="340" fill="#ffffff"/>
  <text x="360" y="24" text-anchor="middle" font-size="15" font-weight="600" fill="#1e293b">Bootstrap: vnodes split many ranges, streaming comes from many peers</text>
  <text x="175" y="52" text-anchor="middle" font-size="12" font-weight="600" fill="#1e293b">num_tokens = 1</text>
  <rect x="30" y="64" width="290" height="34" rx="6" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="70" y="86" text-anchor="middle" font-size="11" fill="#1e293b">N1</text>
  <line x1="110" y1="64" x2="110" y2="98" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="150" y="86" text-anchor="middle" font-size="11" fill="#1e293b">N2</text>
  <line x1="190" y1="64" x2="190" y2="98" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="230" y="86" text-anchor="middle" font-size="11" fill="#1e293b">N3</text>
  <line x1="270" y1="64" x2="270" y2="98" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="295" y="86" text-anchor="middle" font-size="11" fill="#1e293b">N4</text>
  <rect x="150" y="106" width="40" height="20" rx="4" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="170" y="121" text-anchor="middle" font-size="9" fill="#1e293b">NEW</text>
  <text x="175" y="146" text-anchor="middle" font-size="10" fill="#1e293b">splits ONE neighbour: streams from 1 source</text>
  <text x="175" y="162" text-anchor="middle" font-size="10" fill="#1e293b">slow rebuild, but failures rarely overlap</text>
  <text x="540" y="52" text-anchor="middle" font-size="12" font-weight="600" fill="#1e293b">num_tokens = 16</text>
  <rect x="390" y="64" width="300" height="34" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <line x1="412" y1="64" x2="412" y2="98" stroke="#0ea5e9" stroke-width="1"/>
  <line x1="440" y1="64" x2="440" y2="98" stroke="#0ea5e9" stroke-width="1"/>
  <line x1="470" y1="64" x2="470" y2="98" stroke="#0ea5e9" stroke-width="1"/>
  <line x1="498" y1="64" x2="498" y2="98" stroke="#0ea5e9" stroke-width="1"/>
  <line x1="528" y1="64" x2="528" y2="98" stroke="#0ea5e9" stroke-width="1"/>
  <line x1="556" y1="64" x2="556" y2="98" stroke="#0ea5e9" stroke-width="1"/>
  <line x1="586" y1="64" x2="586" y2="98" stroke="#0ea5e9" stroke-width="1"/>
  <line x1="614" y1="64" x2="614" y2="98" stroke="#0ea5e9" stroke-width="1"/>
  <line x1="644" y1="64" x2="644" y2="98" stroke="#0ea5e9" stroke-width="1"/>
  <line x1="666" y1="64" x2="666" y2="98" stroke="#0ea5e9" stroke-width="1"/>
  <text x="540" y="86" text-anchor="middle" font-size="10" fill="#1e293b">many small ranges per node</text>
  <text x="540" y="126" text-anchor="middle" font-size="10" fill="#1e293b">streams from MANY peers in parallel</text>
  <text x="540" y="146" text-anchor="middle" font-size="10" fill="#1e293b">fast rebuild, even load</text>
  <text x="540" y="162" text-anchor="middle" font-size="10" fill="#1e293b">but almost any 2 failures break a quorum</text>
  <rect x="30" y="186" width="660" height="60" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="360" y="208" text-anchor="middle" font-size="12" font-weight="600" fill="#1e293b">Bootstrap sequence</text>
  <text x="360" y="230" text-anchor="middle" font-size="11" fill="#1e293b">allocate tokens &#8594; STATUS=BOOT (UJ) &#8594; stream ranges &#8594; double-write pending ranges &#8594; STATUS=NORMAL (UN) &#8594; cleanup on old owners</text>
  <rect x="30" y="258" width="660" height="60" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="360" y="280" text-anchor="middle" font-size="12" font-weight="600" fill="#1e293b">Ownership never drops until you run nodetool cleanup</text>
  <text x="360" y="302" text-anchor="middle" font-size="11" fill="#1e293b">Old owners keep the streamed data on disk. Cleanup is a rewrite &#8212; schedule it, one node at a time.</text>
</svg>
```

## 5. Implementation

`cassandra.yaml` — the settings that define the ring:

```yaml
partitioner: org.apache.cassandra.dht.Murmur3Partitioner   # never change on a live cluster
num_tokens: 16                                             # 4.x default; 256 is legacy
allocate_tokens_for_local_replication_factor: 3            # even ownership at low num_tokens
# initial_token:                                           # only for num_tokens=1 / manual rings
auto_bootstrap: true
endpoint_snitch: GossipingPropertyFileSnitch               # reads cassandra-rackdc.properties
seed_provider:
  - class_name: org.apache.cassandra.locator.SimpleSeedProvider
    parameters:
      - seeds: "10.0.1.11:7000,10.0.2.11:7000,10.0.3.11:7000"
```

```properties
# cassandra-rackdc.properties  -- one per node
dc=us_east
rack=rack-a
prefer_local=true
```

Keyspace placement:

```cql
CREATE KEYSPACE shop WITH replication = {
  'class': 'NetworkTopologyStrategy', 'us_east': 3, 'eu_west': 3
} AND durable_writes = true;

-- NEVER in production: ignores racks and DCs entirely
-- CREATE KEYSPACE bad WITH replication = {'class':'SimpleStrategy','replication_factor':3};
```

Inspecting the ring:

```bash
nodetool status shop
# Datacenter: us_east
# ==================
# Status=Up/Down  |/ State=Normal/Leaving/Joining/Moving
# --  Address     Load       Tokens  Owns (effective)  Host ID     Rack
# UN  10.0.1.11   412.8 GiB  16      33.4%             3f2a...     rack-a
# UN  10.0.1.12   408.1 GiB  16      33.1%             8c19...     rack-b
# UN  10.0.1.13   415.6 GiB  16      33.5%             a710...     rack-c

nodetool ring shop | head -8
# Address     Rack    Status State   Load        Token
#                                                -9187343239835811839
# 10.0.1.12   rack-b  Up     Normal  408.1 GiB   -9151314442816847872
# 10.0.1.13   rack-c  Up     Normal  415.6 GiB   -8935141660703064064

nodetool describering shop | head -6
# TokenRange(start_token:-9151314442816847872, end_token:-8935141660703064064,
#   endpoints:[10.0.1.13, 10.0.2.13, 10.0.3.11], rpc_endpoints:[...],
#   endpoint_details:[EndpointDetails(host:10.0.1.13, datacenter:us_east, rack:rack-c), ...])

# Which nodes hold a specific key?
nodetool getendpoints shop orders_by_customer 11111111-1111-1111-1111-111111111111:2026-07
# 10.0.1.12
# 10.0.2.12
# 10.0.3.13
```

Token math from CQL and from a driver:

```cql
SELECT token(customer_id, order_month), customer_id
  FROM shop.orders_by_customer LIMIT 3;
--  system.token(customer_id, order_month) | customer_id
-- ---------------------------------------+--------------------------------------
--                   -8412998855126843710 | 11111111-1111-1111-1111-111111111111
--                    1204773115501228443 | 22222222-2222-2222-2222-222222222222

-- Walk the whole ring in bounded chunks
SELECT * FROM shop.orders_by_customer
 WHERE token(customer_id, order_month) > -4611686018427387904
   AND token(customer_id, order_month) <= 0;
```

```python
from cassandra.cluster import Cluster
from cassandra.policies import TokenAwarePolicy, DCAwareRoundRobinPolicy
from cassandra.metadata import Murmur3Token
import uuid

cluster = Cluster(["10.0.1.11"],
    load_balancing_policy=TokenAwarePolicy(DCAwareRoundRobinPolicy(local_dc="us_east")))
session = cluster.connect("shop")

md  = cluster.metadata
key = md.keyspaces["shop"].tables["orders_by_customer"]
pk  = session.cluster.metadata.token_map
routing = session.prepare(
    "SELECT * FROM orders_by_customer WHERE customer_id=? AND order_month=?"
).bind((uuid.UUID("11111111-1111-1111-1111-111111111111"), "2026-07")).routing_key

tok = pk.token_class.from_key(routing)
print(tok.value)                              # -8412998855126843710
for r in pk.get_replicas("shop", tok):
    print(r.address, r.datacenter, r.rack)
# 10.0.1.12 us_east rack-b
# 10.0.2.12 eu_west rack-b
```

Topology operations, in order:

```bash
# Add a node: set seeds + rackdc, auto_bootstrap: true, start, then watch
nodetool netstats | head -5
# Mode: JOINING
# Bootstrap 5b1e... : Receiving 214 files, 89.4 GiB total

nodetool status | grep UJ        # UJ = up, joining

# After it reaches UN, reclaim space on the previous owners, one at a time:
nodetool cleanup shop
nodetool compactionstats

# Remove a live node (streams out first)
nodetool decommission

# Remove a dead node (streams from surviving replicas)
nodetool removenode 8c19f3a2-8c4b-4a7d-9f42-0c1f2f6b3d11

# Rebalance a single-token ring (rare; not for vnodes)
nodetool move -3074457345618258603

# Throttle streaming so a bootstrap does not starve OLTP traffic
nodetool setstreamthroughput 200      # MB/s, 0 = unlimited
nodetool setinterdcstreamthroughput 50
```

> **Optimization:** always set `allocate_tokens_for_local_replication_factor` to your production RF *before* the first node starts. With `num_tokens: 16` and random allocation, ownership variance across nodes routinely reaches 20–30%, which means your most-loaded node holds 30% more data and takes 30% more traffic — and since capacity planning is driven by the hottest node, you pay for that skew on every node in the cluster. With the allocation algorithm, variance falls below ~5%. Retrofitting it onto an existing cluster requires a rolling replacement of nodes, so getting it right at cluster creation is worth real money.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Consistent hashing | Adding/removing a node moves only ~1/N of keys, not ~all of them | Ownership is random, so distribution is statistical rather than exact |
| Masterless routing | Any node or client can compute placement; no metadata service to fail | Every node must hold the full token map, propagated by gossip |
| Murmur3 partitioner | Fast, uniform, well-tested; even distribution for any key shape | Destroys key locality — no range scans over partition keys |
| ByteOrderedPartitioner | Would allow ordered range scans on keys | Severe hot spots and manual rebalancing; deprecated, never use |
| vnodes (many) | Fast parallel bootstrap, even load, no manual rebalancing | Any two node failures likely break a quorum somewhere; repair and streaming cost explode |
| vnodes (few, 16 + allocation) | Good balance: modest range count, low variance, better availability | Requires the allocation algorithm configured up front; harder to retrofit |
| `NetworkTopologyStrategy` | Rack- and DC-aware placement, enables `LOCAL_QUORUM` | Requires correct snitch and rack labelling; wrong racks silently reduce fault tolerance |
| Token-aware drivers | Removes one hop per request; measurable p99 improvement | Driver must track schema and topology; stale maps briefly misroute after changes |

## 7. Common Mistakes & Best Practices

1. ⚠️ Using `SimpleStrategy` in production because it "worked in dev". → ✅ It ignores racks and DCs, so all three replicas can land in one AZ and you cannot use `LOCAL_QUORUM`. Always `NetworkTopologyStrategy`, even for a single DC.
2. ⚠️ Leaving `num_tokens: 256` on a new 4.x cluster. → ✅ Use 16 with `allocate_tokens_for_local_replication_factor`. 256 makes repair and streaming an order of magnitude more expensive and makes any two-node failure likely to break a quorum.
3. ⚠️ Setting `num_tokens: 16` without the allocation algorithm. → ✅ Random 16-token allocation gives 20–30% ownership skew. Set `allocate_tokens_for_local_replication_factor` to your RF before the first node ever starts.
4. ⚠️ Changing `num_tokens` or the partitioner on an existing cluster. → ✅ Both are immutable in practice. Changing them requires building a new cluster and migrating; a node that starts with a different partitioner refuses to join.
5. ⚠️ Racks that do not divide evenly into RF (e.g. 2 racks with RF=3, or every node in `rack1`). → ✅ Use exactly RF racks (3 racks / 3 AZs for RF=3) so replicas are spread one per rack. Uneven rack counts silently concentrate replicas.
6. ⚠️ Bootstrapping several nodes at once. → ✅ Add one node at a time and wait for `UN` before starting the next; concurrent joins can claim overlapping pending ranges and produce inconsistent ownership. Cassandra 4.x guards this with consistent range movement, but the safe operational rule stands.
7. ⚠️ Forgetting `nodetool cleanup` after adding nodes. → ✅ Old owners keep the data they no longer own; disk usage never drops and reads scan extra SSTables. Run cleanup one node at a time after the topology settles.
8. ⚠️ Using `nodetool removenode` on a node that is still alive. → ✅ Use `decommission` on a live node so it streams its data out first. `removenode` is for a node that is already down and rebuilds from surviving replicas.
9. ⚠️ Assuming `Owns` in `nodetool status` means data balance. → ✅ It is *ring* ownership, and without a keyspace argument it ignores replication. Compare `Load` alongside `Owns shop`; a mismatch means skewed partition sizes, not skewed tokens.
10. ⚠️ Choosing a low-cardinality partition key and blaming the ring for hot spots. → ✅ The ring distributes *tokens*, not traffic. `PRIMARY KEY (country)` has 200 possible tokens and will always be hot. Distribution is a data-modelling responsibility.
11. ⚠️ Running a bootstrap without throttling streams on a busy cluster. → ✅ Set `nodetool setstreamthroughput` and `setinterdcstreamthroughput` so a rebuild cannot saturate the NICs serving live traffic.
12. ⚠️ Disabling token-aware routing (or using a driver default that lacks it). → ✅ Always wrap `DCAwareRoundRobinPolicy` in `TokenAwarePolicy`. Without it every request pays an extra coordinator hop and the coordinator does fan-out work it did not need to do.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Start with `nodetool status <keyspace>` — `UN` for every node and effective ownership within a few percent of `1/N × RF` is a healthy ring. `nodetool ring` lists every token in order and is how you spot a node with a pathologically large range. `nodetool describering <keyspace>` gives the exact replica set per range, which is the ground truth when you suspect misplacement. `nodetool getendpoints <ks> <table> <key>` answers "which nodes should have this row" so you can go read the SSTables directly. For gossip problems — a node stuck as `DN` on some peers but `UN` on others — `nodetool gossipinfo` shows each endpoint's `STATUS`, `TOKENS`, `DC`, `RACK`, and heartbeat generation; a mismatch in generation numbers usually means a node was restarted with a wiped `system` keyspace. Cassandra 4.0+ also exposes `SELECT * FROM system_views.gossip_info` from cqlsh.

**Monitoring.** Track `org.apache.cassandra.metrics:type=Storage,name=Load` per node and alert on cross-node variance above ~15%, which indicates either token skew or partition-size skew. Watch `type=Streaming` metrics and `nodetool netstats` during any topology change. `type=FailureDetector,name=DownEndpointCount` and per-endpoint `PhiValues` catch flapping gossip before it becomes an outage. `type=ClientRequest,scope=Read,name=Unavailables` rising during a bootstrap means the pending-range double-write is not keeping up. On vnode-heavy clusters, track repair duration per table — a sudden jump usually means range count grew after a topology change.

**Security.** The ring is a trust boundary: any node that can gossip on port 7000 and present the right cluster name can join and be handed replicas of your data. Enforce `server_encryption_options: internode_encryption: all` with proper certificates, restrict 7000/7001 to the cluster's security group or subnet, and never expose it publicly. Set a distinct `cluster_name` per environment so a misconfigured dev node cannot join production. Keep seeds on stable internal addresses and never make every node a seed (three per DC is the convention) — a seed cannot bootstrap normally, so a cluster of all seeds silently skips range streaming. In multi-tenant setups, remember that rack labels drive replica placement, so a compromised snitch configuration is a data-placement attack.

**Performance & scaling.** Scaling out is linear when partitions are well distributed: doubling nodes halves per-node data and roughly doubles throughput, because each request still touches only `RF` nodes. Plan capacity by the *hottest* node, not the average, which is why ownership variance directly costs money. Practical limits: keep per-node data under roughly 1–2 TB (streaming and repair time scale with it), keep `num_tokens` at 16, and grow by 25–50% at a time rather than doubling, so streaming stays bounded. For a multi-region expansion, add the new DC with `ALTER KEYSPACE` to include it, then `nodetool rebuild <source_dc>` on each new node — never bootstrap a whole new DC with `auto_bootstrap: true`, which would stream from the wrong topology and can overwhelm the source region.

## 9. Interview Questions

**Q: What is a token in Cassandra?**
A: A position on a circular 64-bit space from `-2^63` to `2^63 - 1`. The partitioner hashes a partition key into a token, and every node owns one or more tokens; a node is responsible for the range from its predecessor's token (exclusive) to its own (inclusive).

**Q: Why consistent hashing instead of `hash(key) % N`?**
A: Because modulo remaps almost every key when `N` changes — adding one node to a 10-node cluster would move about 90% of the data. Consistent hashing only moves the keys between the new node and its predecessor, roughly `1/N` of the total, so scaling is incremental rather than a full reshuffle.

**Q: Which partitioner should you use and why?**
A: `Murmur3Partitioner`. It is fast, non-cryptographic, and distributes uniformly across the 64-bit ring. `RandomPartitioner` is the slower MD5-based legacy option, and `ByteOrderedPartitioner` preserves key order but causes severe hot spots and constant manual rebalancing — it is deprecated and should never be used.

**Q: What are vnodes and what problem do they solve?**
A: Virtual nodes let one physical node own `num_tokens` separate tokens instead of one, so its ownership is scattered across many small ranges. This makes bootstrap stream from many peers in parallel, evens out load statistically, and removes the need for manual token rebalancing when nodes are added or removed.

**Q: Why did the default `num_tokens` drop from 256 to 16 in Cassandra 4.0?**
A: Because 256 vnodes make every node share ranges with essentially every other node, so any two simultaneous failures take some range below quorum; they also multiply repair Merkle-tree work and streaming session count by orders of magnitude. Sixteen tokens combined with the token-allocation algorithm keeps ownership variance low while restoring reasonable availability and repair cost.

**Q: How does `NetworkTopologyStrategy` choose replicas?**
A: It walks the ring clockwise from the key's token and, for each data centre independently, collects nodes until it has `RF` replicas, skipping a node whose rack has already contributed a replica unless all racks are exhausted. This yields rack diversity when the number of racks is at least RF.

**Q: (Senior) A 30-node cluster with `num_tokens: 16` shows one node holding 40% more data than the others. Diagnose and fix it.**
A: First distinguish token skew from partition skew: compare `nodetool status <keyspace>` effective ownership against `Load`. If ownership itself is uneven, the cluster was built without `allocate_tokens_for_local_replication_factor`, so random 16-token allocation produced high variance — the fix is a rolling replacement of the worst nodes with the allocation setting enabled, or accepting the skew and sizing for it. If ownership is even but Load is not, the cause is data-model skew: a few enormous partitions, confirmed by `nodetool tablehistograms` and the `EstimatedPartitionSizeHistogram` max. Then the fix is bucketing the partition key, not touching the ring.

**Q: (Senior) Why does adding vnodes hurt availability, quantitatively?**
A: With one token per node and RF=3, a node shares ranges with only its ring neighbours, so the probability that a random second node failure overlaps a range with the first is roughly `2×RF/N`. With `num_tokens = 256`, each node's ranges are interleaved with virtually every other node, so essentially any second failure shares at least one range — probability approaching 1. Losing 2 of 3 replicas for even one narrow range means `QUORUM` operations on the keys in that range fail. So vnodes trade a faster, more even rebuild for a much higher probability of *partial* unavailability during concurrent failures.

**Q: (Senior) Walk through adding a third data centre to a live 2-DC cluster without data loss or client impact.**
A: Bring the new DC's nodes up with `auto_bootstrap: false`, correct `cassandra-rackdc.properties`, and seeds from all DCs, so they join the ring and claim tokens without streaming. Ensure all clients are using `LOCAL_QUORUM` and a DC-aware policy pinned to their own DC so the new DC receives no reads. Then `ALTER KEYSPACE ... WITH replication = {..., 'new_dc': 3}` — from this moment writes replicate to the new DC — and run `nodetool rebuild <existing_dc>` on each new node to stream historical data, throttled with `setinterdcstreamthroughput`. Finally run a full repair, verify with `nodetool status <keyspace>`, and only then point any clients at the new DC. Also remember to raise `system_auth` replication to include the new DC.

**Q: What is `nodetool cleanup` and when must you run it?**
A: It rewrites SSTables on a node, dropping any data whose token no longer falls in a range that node owns. You must run it on the pre-existing nodes after adding new nodes, otherwise they keep the streamed-away data on disk forever, inflating storage and read costs. Run it one node at a time since it is compaction-like work.

**Q: What is the difference between `decommission` and `removenode`?**
A: `nodetool decommission` runs on a *live* node and streams its ranges to their new owners before it leaves, so replica counts are never reduced. `nodetool removenode <host_id>` is run from another node for a host that is already dead, and rebuilds the missing replicas from the surviving ones.

**Q: How does a client driver know which node to send a request to?**
A: With token-aware routing, the driver serialises the bound partition key the same way the server does, hashes it with Murmur3, and looks up the owning replicas in a token map it built from `system.peers_v2` and keeps current via protocol topology events. It then sends the request directly to a live local-DC replica, saving a coordinator hop.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** The ring is the signed 64-bit token space; `Murmur3Partitioner` hashes each partition key to a token, and replica placement walks clockwise collecting `RF` nodes, preferring distinct racks per DC under `NetworkTopologyStrategy`. Because that mapping is pure computation over a gossiped token map, any node — or any token-aware client — can route a request without a master. Each node owns `num_tokens` tokens: 16 in 4.x/5.0, paired with `allocate_tokens_for_local_replication_factor` to keep ownership variance under 5%, because random allocation at 16 tokens skews badly and 256 tokens wrecks repair cost and availability. Topology changes stream ranges (bootstrap in, decommission out), and old owners keep stale data until `nodetool cleanup`. The ring distributes tokens evenly; distributing *traffic* evenly is still your data model's job.

| Item | Value / Command |
|---|---|
| Token space | `-2^63` … `2^63 - 1`, wrapping; `MIN_VALUE` reserved |
| Default partitioner | `Murmur3Partitioner` (first 64 bits of MurmurHash3 x64_128) |
| `num_tokens` default | 16 (4.x / 5.0); 256 legacy; 1 for manual rings |
| Token allocation | `allocate_tokens_for_local_replication_factor: 3` |
| Range bounds | `(predecessor, node_token]` — low exclusive, high inclusive |
| Production strategy | `NetworkTopologyStrategy` with racks = RF |
| Snitch | `GossipingPropertyFileSnitch` + `cassandra-rackdc.properties` |
| Ring inspection | `nodetool status <ks>` · `nodetool ring` · `nodetool describering <ks>` |
| Key → nodes | `nodetool getendpoints <ks> <table> <key>` |
| Token from CQL | `SELECT token(pk_cols) FROM t ...` |
| Add a node | `auto_bootstrap: true`, one at a time, then `nodetool cleanup` on others |
| Remove live node | `nodetool decommission` |
| Remove dead node | `nodetool removenode <host_id>` |
| New DC | `ALTER KEYSPACE` then `nodetool rebuild <source_dc>` |
| Stream throttling | `nodetool setstreamthroughput` / `setinterdcstreamthroughput` |
| Gossip state | `nodetool gossipinfo` · `system_views.gossip_info` (4.0+) |

**Flash cards**
- **What does the partitioner do?** → Hashes the partition key to a 64-bit token that determines ring position and therefore replica set.
- **Why not `hash(key) % N`?** → Changing `N` remaps nearly every key; consistent hashing moves only ~1/N.
- **Why is `num_tokens` 16 and not 256?** → 256 makes any two node failures likely to break a quorum and multiplies repair and streaming cost.
- **What must accompany `num_tokens: 16`?** → `allocate_tokens_for_local_replication_factor`, or ownership skews 20–30%.
- **What do you run after adding nodes?** → `nodetool cleanup` on the pre-existing nodes, one at a time.

## 11. Hands-On Exercises & Mini Project

- [ ] Start a 3-node `ccm` cluster with `num_tokens: 16`, then run `nodetool ring` and export all 48 tokens; compute the range lengths and report the coefficient of variation.
- [ ] Repeat with `allocate_tokens_for_local_replication_factor: 3` on a fresh cluster and compare the variance to the random-allocation run.
- [ ] Insert 100,000 rows, run `SELECT token(pk), pk FROM t LIMIT 20`, and verify with `nodetool getendpoints` that the replica set matches what a clockwise walk over `nodetool ring` predicts.
- [ ] Add a fourth node, watch `nodetool netstats` during bootstrap, then run `nodetool status` before and after `nodetool cleanup` on the original nodes and record the disk reclaimed.
- [ ] Decommission a node while running a write workload at `LOCAL_QUORUM` and confirm zero failed writes; then kill a node hard and use `removenode`, comparing the streaming behaviour of the two paths.

**Mini Project — build and rebalance a two-DC ring**

*Goal:* stand up a 6-node, 2-DC cluster from scratch, prove replica placement matches theory, and execute a live expansion.

*Requirements:*
- Two DCs (`us_east`, `eu_west`), 3 nodes each, 3 racks per DC, `GossipingPropertyFileSnitch`, `num_tokens: 16`, `allocate_tokens_for_local_replication_factor: 3`, internode TLS enabled.
- A `shop` keyspace with `NetworkTopologyStrategy {us_east: 3, eu_west: 3}` and `system_auth` replicated to both DCs.
- A verification script that, for 1,000 random keys, computes the Murmur3 token client-side, predicts the replica set by walking the ring from `nodetool describering`, and asserts it matches `nodetool getendpoints`.
- An expansion run: add a 4th node to `us_east` under a live `cassandra-stress` workload at `LOCAL_QUORUM`, capturing p99 latency before/during/after, then `nodetool cleanup` and record reclaimed disk.
- A skew report: per-node `Load` and effective `Owns` before and after expansion, plus a deliberate hot-partition test using a low-cardinality partition key to demonstrate that ring balance does not imply traffic balance.

*Extensions:* rebuild the same cluster with `num_tokens: 256` and compare full-repair wall time; simulate two simultaneous node failures at 16 vs 256 tokens and measure how many ranges drop below quorum; add a third DC using the `auto_bootstrap: false` + `ALTER KEYSPACE` + `nodetool rebuild` procedure.

## 12. Related Topics & Free Learning Resources

Read with **16 · Paging, ALLOW FILTERING & Query Limits** for why `token()` is the correct full-scan primitive and why range scans grow with cluster size, and **13 · CQL: SELECT, INSERT, UPDATE & DELETE** for the partition-key restrictions that exist purely so queries can be routed by token. The replication-strategy, gossip/failure-detection, and repair chapters build directly on this material.

- **Dynamo: Amazon's Highly Available Key-value Store** — DeCandia et al. (Amazon) · *Advanced* · the paper that brought consistent hashing and virtual nodes to databases; section 4.2 is the ring. <https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf>
- **Consistent Hashing and Random Trees** — Karger et al. (MIT) · *Advanced* · the 1997 original; the `1/N` remapping property comes straight from here. <https://www.cs.princeton.edu/courses/archive/fall09/cos518/papers/chash.pdf>
- **Cassandra Architecture: Dynamo** — Apache Cassandra Documentation · *Intermediate* · the normative description of the ring, partitioners, vnodes, and replica placement. <https://cassandra.apache.org/doc/latest/cassandra/architecture/dynamo.html>
- **CASSANDRA-4119: Virtual nodes** — Apache JIRA · *Advanced* · the original vnode implementation and the trade-offs debated at the time. <https://issues.apache.org/jira/browse/CASSANDRA-4119>
- **CASSANDRA-7032: Improve vnode allocation** — Apache JIRA · *Advanced* · the token-allocation algorithm that makes `num_tokens: 16` viable. <https://issues.apache.org/jira/browse/CASSANDRA-7032>
- **Cassandra Vnodes: How Many Should I Use?** — The Last Pickle · *Advanced* · the availability and repair analysis behind moving from 256 to 16 tokens. <https://thelastpickle.com/blog/2019/06/04/should-you-use-incremental-repair.html>
- **Cassandra Adding/Removing Nodes** — Apache Cassandra Documentation · *Intermediate* · the operational procedures for bootstrap, decommission, removenode, rebuild, and cleanup. <https://cassandra.apache.org/doc/latest/cassandra/managing/operating/topo_changes.html>
- **Scaling Cassandra at Netflix** — Netflix Technology Blog · *Intermediate* · real multi-region ring operations, capacity planning, and what breaks at scale. <https://netflixtechblog.com/tagged/cassandra>

---

*Apache Cassandra Handbook — chapter 18.*
