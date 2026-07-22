# 28 · Adding, Removing & Replacing Nodes

> **In one line:** Growing, shrinking and healing a Cassandra cluster is four distinct procedures — bootstrap, decommission, removenode, and replace_address — each with its own streaming pattern, its own failure modes, and one non-negotiable rule: never skip the cleanup or the consistency-level math.

---

## 1. Overview

A Cassandra cluster is masterless, so there is no "add node to config, restart the leader" step. Topology change is a **distributed, streaming, online** operation: the new node claims token ranges, the current owners of those ranges stream the data to it, and gossip propagates the new ownership. Nothing goes down, no lock is taken, and clients keep writing throughout. This is the single biggest operational advantage Cassandra has over sharded relational systems — and also the operation most often botched.

The problem being solved is elasticity without downtime. Your cluster is at 70% disk, or Black Friday is coming, or an EC2 instance's underlying host died. Each of those is a different procedure, and using the wrong one destroys data or leaves the ring permanently wrong. **Bootstrap** adds capacity. **Decommission** removes a *live* node gracefully — it streams its data out first. **Removenode** removes a *dead* node — the surviving replicas stream to cover the gap. **Replace** substitutes a new node for a dead one at the *same tokens*, which is the fastest and least disruptive way to recover from hardware failure.

The historical arc matters. Pre-1.2, each node had one token and adding a node meant halving one neighbour's range, so growth was doubling-only and rebalancing was manual (`nodetool move`). **Vnodes** (virtual nodes, CASSANDRA-4119, Cassandra 1.2) gave each node many tokens scattered around the ring, so a new node draws small slices from *every* existing node in parallel — bootstrap became fast and balance became automatic. The default was 256 vnodes for years; Cassandra **4.0 reduced it to `num_tokens: 16`** and added `allocate_tokens_for_local_replication_factor`, because 256 random tokens made repair and range scans far more expensive while the allocation algorithm gets good balance with far fewer tokens.

Concretely: a Netflix-scale team doubling a 24-node cluster does not add 24 nodes at once. They add them **one at a time** (or, in 4.0+, in carefully-managed parallel with `cassandra.consistent.rangemovement=false` only when they fully understand the risk), waiting for each to reach `UN`, then run `nodetool cleanup` across the existing nodes before the next. The whole operation takes days, is entirely online, and the application never notices — provided `LOCAL_QUORUM` is used and no more than one node per rack is in flight.

## 2. Core Concepts

- **Bootstrap** — a new node joins, claims tokens, and streams the data for those ranges from the current owners. It shows as `UJ` in `nodetool status` and does not serve reads until it reaches `UN`.
- **Streaming** — the internode bulk data transfer used by bootstrap, decommission, repair and rebuild. Cassandra 4.0 rewrote it on Netty (**Zero Copy Streaming**, CASSANDRA-14556), making whole-SSTable streaming dramatically faster.
- **Token allocation** — how a joining node picks its `num_tokens` tokens. Random by default; `allocate_tokens_for_local_replication_factor: 3` uses an algorithm that minimises ownership variance.
- **`auto_bootstrap`** — `true` by default; when true a joining node streams its data before serving. Setting it `false` means the node joins **empty** — correct only for a brand-new empty cluster or a DC-add followed by `nodetool rebuild`.
- **Decommission** — `nodetool decommission` on a **live** node: it streams its ranges to the new owners, then leaves. Shows as `UL` while in progress. The safe removal path.
- **Removenode** — `nodetool removenode <host-id>` for a **dead** node: surviving replicas stream to restore `RF`. No data comes from the dead node, so any data only it had is lost unless repaired.
- **Replace** — start a replacement node with `-Dcassandra.replace_address_first_boot=<old-ip>`; it takes over the dead node's exact tokens and streams from the other replicas. No ring rebalance, no cleanup needed.
- **Cleanup** — `nodetool cleanup`: rewrites SSTables dropping rows the node no longer owns after a topology change. Never automatic.
- **Rebuild** — `nodetool rebuild <source-dc>`: streams all data for this node's ranges from another DC. The mechanism for adding a whole datacenter.
- **Assassinate** — `nodetool assassinate <ip>`: forcibly evict a gossip entry with **no streaming**. A last resort for a ghost node; it does not restore replication.
- **`consistent.rangemovement`** — the safety property that only one range movement happens at a time, so consistency guarantees hold during bootstrap. Disabling it allows parallel bootstraps at the cost of possible consistency violations.

## 3. Theory & Internals

**How a joining node picks tokens.** On first boot with `auto_bootstrap: true`, the node contacts a seed, learns the ring, and selects `num_tokens` tokens. With plain random selection, each token splits an existing range at a random point; ownership variance across nodes is roughly `1/sqrt(num_tokens)`, so 16 random tokens give ~±25% spread — visibly imbalanced. With `allocate_tokens_for_local_replication_factor: 3` set in `cassandra.yaml`, the node runs an optimisation that picks tokens minimising the variance of *replicated* ownership for that RF, typically holding spread under 5%. **This setting must be present before the first node of the cluster starts**, or at minimum before each new node bootstraps; retrofitting it to an existing badly-balanced ring does not fix the existing tokens.

**What actually streams.** Once tokens are chosen, the node computes, for each token range it will now own, which nodes currently hold replicas. It requests streams from **one replica per range** (chosen by the snitch, preferring same-rack/same-DC). With `RF=3` and 16 vnodes, that means dozens of concurrent stream sessions from many peers — which is why bootstrap is fast with vnodes and was slow without them. Cassandra 4.0's zero-copy streaming sends entire SSTables at the block level when the whole file falls inside the requested range, bypassing deserialization entirely; the community-reported speedup is roughly **5×** on large datasets.

**Why the joining node does not serve reads.** During `UJ`, the node is a *pending* replica: coordinators send it **writes** (so it does not fall behind while streaming) but not **reads**. Write consistency levels count it as an extra required acknowledgement in some paths, which is why bootstrapping a node into a cluster already at its availability limit can cause `UnavailableException`. Once streaming completes, the node atomically transitions to `UN` and begins serving reads.

**The `consistent.rangemovement` guarantee.** Cassandra enforces that only one node may be joining or leaving at a time (`RING_DELAY`, 30 s, plus a check against gossip). The reason is subtle: if two nodes bootstrap simultaneously and their token ranges overlap, each may stream from a source that is itself about to stop owning that range, producing a range with fewer than `RF` complete replicas. Setting `-Dcassandra.consistent.rangemovement=false` disables the check and allows parallel bootstraps — occasionally necessary when adding many nodes under time pressure, but it **can silently violate consistency** and must be followed by a full repair.

**Cleanup is not optional and not automatic.** After a bootstrap, the previous owners still physically hold the rows for ranges they gave up. They will not serve them (ownership is computed from the ring, not from disk) but they occupy space and are compacted forever. `nodetool cleanup` rewrites each SSTable, dropping out-of-range partitions. It costs a full read+write of the table's data, so it is scheduled, serialised, and throttled like a compaction.

```svg
<svg viewBox="0 0 820 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="a28a" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="410" y="20" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">Bootstrap: new node draws slices from every peer</text>

  <circle cx="230" cy="200" r="115" fill="none" stroke="#4f46e5" stroke-width="2"/>
  <text x="230" y="45" text-anchor="middle" fill="#64748b" font-size="11">Murmur3 token ring</text>

  <circle cx="230" cy="85" r="16" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="230" y="90" text-anchor="middle" fill="#1e293b" font-size="10">n1</text>
  <circle cx="330" cy="143" r="16" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="330" y="148" text-anchor="middle" fill="#1e293b" font-size="10">n2</text>
  <circle cx="330" cy="257" r="16" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="330" y="262" text-anchor="middle" fill="#1e293b" font-size="10">n3</text>
  <circle cx="230" cy="315" r="16" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="230" y="320" text-anchor="middle" fill="#1e293b" font-size="10">n4</text>
  <circle cx="130" cy="257" r="16" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="130" y="262" text-anchor="middle" fill="#1e293b" font-size="10">n5</text>
  <circle cx="130" cy="143" r="16" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="130" y="148" text-anchor="middle" fill="#1e293b" font-size="10">n6</text>

  <rect x="500" y="160" width="150" height="70" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="575" y="185" text-anchor="middle" fill="#1e293b" font-weight="700">new node n7</text>
  <text x="575" y="203" text-anchor="middle" fill="#64748b" font-size="10">state UJ</text>
  <text x="575" y="220" text-anchor="middle" fill="#64748b" font-size="10">16 vnodes claimed</text>

  <line x1="246" y1="90" x2="497" y2="168" stroke="#16a34a" marker-end="url(#a28a)"/>
  <line x1="346" y1="145" x2="497" y2="176" stroke="#16a34a" marker-end="url(#a28a)"/>
  <line x1="346" y1="255" x2="497" y2="205" stroke="#16a34a" marker-end="url(#a28a)"/>
  <line x1="246" y1="313" x2="497" y2="222" stroke="#16a34a" marker-end="url(#a28a)"/>
  <line x1="146" y1="268" x2="497" y2="228" stroke="#16a34a" marker-end="url(#a28a)"/>
  <line x1="146" y1="136" x2="497" y2="164" stroke="#16a34a" marker-end="url(#a28a)"/>
  <text x="420" y="130" text-anchor="middle" fill="#15803d" font-size="11" font-weight="700">parallel streams</text>

  <rect x="500" y="255" width="290" height="120" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="645" y="278" text-anchor="middle" fill="#1e293b" font-weight="700">During UJ</text>
  <text x="645" y="298" text-anchor="middle" fill="#1e293b" font-size="11">receives writes as a pending replica</text>
  <text x="645" y="316" text-anchor="middle" fill="#1e293b" font-size="11">does NOT serve reads</text>
  <text x="645" y="334" text-anchor="middle" fill="#1e293b" font-size="11">one range movement at a time</text>
  <text x="645" y="352" text-anchor="middle" fill="#1e293b" font-size="11">4.0 zero copy streaming, whole SSTables</text>
  <text x="645" y="368" text-anchor="middle" fill="#b45309" font-size="10">then flips to UN atomically</text>

  <rect x="20" y="345" width="420" height="45" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="230" y="364" text-anchor="middle" fill="#1e293b" font-weight="700">After UN: run nodetool cleanup on n1 to n6</text>
  <text x="230" y="381" text-anchor="middle" fill="#64748b" font-size="10">one node at a time, drops ranges they no longer own</text>
</svg>
```

## 4. Architecture & Workflow

**Adding a node (bootstrap).**

1. Pre-flight: confirm cluster health (`nodetool status` all `UN`, `describecluster` one schema version), confirm no repair is running, confirm disk headroom on existing nodes (they must sustain compaction while streaming out).
2. Install the **exact same Cassandra version**. Mixed-version bootstrap is unsupported and will fail or corrupt tokens.
3. Configure `cassandra.yaml`: same `cluster_name`, same `seeds` list (the new node must **not** be in its own seed list — a node listed as a seed skips bootstrap and joins empty), correct `listen_address`/`rpc_address`, `endpoint_snitch` matching the cluster, `num_tokens: 16`, `allocate_tokens_for_local_replication_factor: 3`. Set the rack/DC in `cassandra-rackdc.properties`.
4. Start Cassandra. `nodetool status` on a peer shows `UJ`. `nodetool netstats` on the new node shows inbound streams.
5. Wait. On a 1 TB-per-node cluster expect hours. Monitor `nodetool netstats` progress and `system.log` for `Starting to bootstrap` → `Bootstrap completed`.
6. The node flips to `UN` and starts serving reads.
7. Run `nodetool cleanup <keyspace>` on **every pre-existing node**, one at a time. Verify `Load` drops in `nodetool status`.
8. Repeat for the next node. Do **not** start the next bootstrap until step 6 completes (unless you have deliberately disabled `consistent.rangemovement`).

**Removing a live node (decommission).**

1. Pre-flight: verify remaining nodes can hold the data (`total_load / (n-1)` vs disk), verify `RF` is still satisfiable (you cannot go below `RF` nodes per DC).
2. `nodetool decommission` **on the node being removed**. It transitions to `UL` and streams its ranges to the new owners.
3. Monitor with `nodetool netstats` on the leaving node. When done, the process exits and the node disappears from `nodetool status`.
4. Run `nodetool cleanup` on the remaining nodes.
5. Wipe the decommissioned node's data directories before ever reusing that host.

**Removing a dead node (removenode).**

1. Confirm it is genuinely dead and not coming back. `nodetool status` shows `DN`.
2. Get its host ID from `nodetool status`.
3. `nodetool removenode <host-id>` from any live node. Surviving replicas stream to each other to restore `RF` for the affected ranges.
4. Monitor `nodetool removenode status`. If it hangs, `nodetool removenode force` completes the ring change **without** restoring replication — you must then run repair.
5. Run `nodetool cleanup` afterwards, then a repair of the affected keyspaces.

**Replacing a dead node (the preferred hardware-failure path).**

1. Note the dead node's IP. Do **not** run `removenode`.
2. Provision a new host with the same Cassandra version and config.
3. Add to `jvm.options` (or `-D` on the command line): `-Dcassandra.replace_address_first_boot=10.0.1.13`.
4. Start it. It adopts the dead node's exact tokens, streams from the other replicas, shows as `UJ`, then `UN`. The ring shape is unchanged.
5. **No cleanup is needed** — no other node's ownership changed.
6. Remove the `replace_address_first_boot` flag from config so a future restart is a normal restart.
7. Run repair on the replaced node if it was down longer than `max_hint_window_in_ms` before failing.

**Adding a datacenter.**

1. Configure the new DC's nodes with `auto_bootstrap: false` and the correct `cassandra-rackdc.properties`. Start them; they join empty and fast.
2. `ALTER KEYSPACE ... WITH replication = {'class':'NetworkTopologyStrategy','dc1':3,'dc2':3};`
3. Run `nodetool rebuild -- dc1` on **every** node in the new DC (can be parallelised carefully) to stream in the data.
4. Only after rebuild completes should any client point `LOCAL_QUORUM` at the new DC.
5. Run a full repair to catch writes that landed during the window.

```svg
<svg viewBox="0 0 820 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="a28b" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="410" y="20" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">Four Topology Operations and Their Streaming Direction</text>

  <rect x="20" y="42" width="380" height="165" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="210" y="64" text-anchor="middle" fill="#1e293b" font-weight="700">decommission  (node is ALIVE)</text>
  <rect x="45" y="80" width="90" height="40" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="90" y="98" text-anchor="middle" fill="#1e293b" font-size="11">leaving node</text>
  <text x="90" y="113" text-anchor="middle" fill="#64748b" font-size="10">state UL</text>
  <rect x="265" y="70" width="105" height="30" rx="6" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="317" y="90" text-anchor="middle" fill="#1e293b" font-size="11">new owner A</text>
  <rect x="265" y="110" width="105" height="30" rx="6" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="317" y="130" text-anchor="middle" fill="#1e293b" font-size="11">new owner B</text>
  <line x1="135" y1="93" x2="260" y2="85" stroke="#16a34a" stroke-width="2" marker-end="url(#a28b)"/>
  <line x1="135" y1="107" x2="260" y2="125" stroke="#16a34a" stroke-width="2" marker-end="url(#a28b)"/>
  <text x="210" y="165" text-anchor="middle" fill="#1e293b" font-size="11">data streams OUT of the leaving node</text>
  <text x="210" y="184" text-anchor="middle" fill="#15803d" font-size="11" font-weight="700">no data loss; cleanup after</text>

  <rect x="420" y="42" width="380" height="165" rx="10" fill="#fee2e2" stroke="#dc2626"/>
  <text x="610" y="64" text-anchor="middle" fill="#1e293b" font-weight="700">removenode  (node is DEAD)</text>
  <rect x="445" y="80" width="90" height="40" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-dasharray="4 3"/>
  <text x="490" y="98" text-anchor="middle" fill="#64748b" font-size="11">dead node</text>
  <text x="490" y="113" text-anchor="middle" fill="#64748b" font-size="10">state DN</text>
  <rect x="600" y="70" width="105" height="30" rx="6" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="652" y="90" text-anchor="middle" fill="#1e293b" font-size="11">replica A</text>
  <rect x="600" y="110" width="105" height="30" rx="6" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="652" y="130" text-anchor="middle" fill="#1e293b" font-size="11">replica B</text>
  <line x1="705" y1="85" x2="740" y2="105" stroke="#dc2626" stroke-width="2" marker-end="url(#a28b)"/>
  <line x1="705" y1="125" x2="740" y2="110" stroke="#dc2626" stroke-width="2" marker-end="url(#a28b)"/>
  <text x="610" y="165" text-anchor="middle" fill="#1e293b" font-size="11">survivors stream to each other to restore RF</text>
  <text x="610" y="184" text-anchor="middle" fill="#b91c1c" font-size="11" font-weight="700">data only the dead node had is lost</text>

  <rect x="20" y="222" width="380" height="180" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="210" y="244" text-anchor="middle" fill="#1e293b" font-weight="700">replace_address_first_boot</text>
  <rect x="45" y="262" width="100" height="38" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-dasharray="4 3"/>
  <text x="95" y="285" text-anchor="middle" fill="#64748b" font-size="11">dead 10.0.1.13</text>
  <rect x="255" y="262" width="115" height="38" rx="6" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="312" y="279" text-anchor="middle" fill="#1e293b" font-size="11">new host</text>
  <text x="312" y="294" text-anchor="middle" fill="#64748b" font-size="10">SAME tokens</text>
  <line x1="148" y1="281" x2="250" y2="281" stroke="#0ea5e9" stroke-width="2" stroke-dasharray="5 3" marker-end="url(#a28b)"/>
  <text x="210" y="325" text-anchor="middle" fill="#1e293b" font-size="11">streams from the other replicas of those ranges</text>
  <text x="210" y="345" text-anchor="middle" fill="#1e293b" font-size="11">ring shape unchanged</text>
  <text x="210" y="365" text-anchor="middle" fill="#0369a1" font-size="11" font-weight="700">no rebalance, no cleanup needed</text>
  <text x="210" y="386" text-anchor="middle" fill="#64748b" font-size="10">preferred path for hardware failure</text>

  <rect x="420" y="222" width="380" height="180" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="610" y="244" text-anchor="middle" fill="#1e293b" font-weight="700">rebuild  (adding a datacenter)</text>
  <rect x="445" y="262" width="120" height="45" rx="6" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="505" y="281" text-anchor="middle" fill="#1e293b" font-size="11">dc1 nodes</text>
  <text x="505" y="297" text-anchor="middle" fill="#64748b" font-size="10">full data</text>
  <rect x="640" y="262" width="130" height="45" rx="6" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="705" y="281" text-anchor="middle" fill="#1e293b" font-size="11">dc2 nodes</text>
  <text x="705" y="297" text-anchor="middle" fill="#64748b" font-size="10">auto_bootstrap false</text>
  <line x1="568" y1="284" x2="635" y2="284" stroke="#4f46e5" stroke-width="2" marker-end="url(#a28b)"/>
  <text x="610" y="330" text-anchor="middle" fill="#1e293b" font-size="11">1. ALTER KEYSPACE to add dc2 to NTS</text>
  <text x="610" y="350" text-anchor="middle" fill="#1e293b" font-size="11">2. nodetool rebuild dc1 on every dc2 node</text>
  <text x="610" y="370" text-anchor="middle" fill="#1e293b" font-size="11">3. full repair, then route LOCAL_QUORUM traffic</text>
  <text x="610" y="390" text-anchor="middle" fill="#4338ca" font-size="10">never point clients at dc2 before rebuild finishes</text>
</svg>
```

## 5. Implementation

New-node `cassandra.yaml` essentials:

```yaml
cluster_name: 'prod-eu'                  # must match exactly
num_tokens: 16
allocate_tokens_for_local_replication_factor: 3
auto_bootstrap: true                     # default; explicit is better

seed_provider:
  - class_name: org.apache.cassandra.locator.SimpleSeedProvider
    parameters:
      - seeds: "10.0.1.11,10.0.2.11,10.0.3.11"   # NOT this node's own IP

listen_address: 10.0.1.15
rpc_address: 10.0.1.15
endpoint_snitch: GossipingPropertyFileSnitch

stream_throughput_outbound_megabits_per_sec: 400
inter_dc_stream_throughput_outbound_megabits_per_sec: 100
streaming_keep_alive_period_in_secs: 300
```

```properties
# cassandra-rackdc.properties  (GossipingPropertyFileSnitch)
dc=dc1
rack=rack2
```

Adding a node, end to end:

```bash
systemctl start cassandra
tail -f /var/log/cassandra/system.log | grep -E 'bootstrap|JOINING|Starting listening'
# INFO  [main] StorageService.java:1600 - JOINING: waiting for ring information
# INFO  [main] StorageService.java:1600 - JOINING: schema complete, ready to bootstrap
# INFO  [main] StorageService.java:1600 - JOINING: calculation complete, ready to bootstrap
# INFO  [main] StorageService.java:1600 - JOINING: Starting to bootstrap...
# INFO  [main] StorageService.java:1600 - Bootstrap completed for tokens [...]
# INFO  [main] Server.java:159 - Starting listening for CQL clients on /10.0.1.15:9042

# From a peer node:
nodetool status shop
# UN  10.0.1.11   612.4 GiB  16      60.1%   3f2a9c1e-...  rack1
# UJ  10.0.1.15   184.2 GiB  16       ?      9a8b7c6d-...  rack2     <-- joining

nodetool netstats -H         # on the joining node
# Mode: JOINING
# Bootstrap 7c1a2b3d-...
#     /10.0.1.11
#         Receiving 412 files, 188.4 GiB total. Already received 189 files, 84.1 GiB total
#     /10.0.1.12
#         Receiving 398 files, 181.2 GiB total. Already received 174 files, 79.8 GiB total

# After it reaches UN, on each pre-existing node, ONE AT A TIME:
nodetool cleanup shop
nodetool status shop        # Load should drop on the old nodes
```

Decommission, removenode, replace:

```bash
# --- Graceful removal of a LIVE node (run ON that node) ---
nodetool decommission
# Watch from a peer: state goes UL, then the node vanishes from status.
nodetool netstats -H        # on the leaving node: outbound streams

# --- Removal of a DEAD node (run from any live node) ---
nodetool status | grep DN
# DN  10.0.1.13   631.9 GiB  16   25.4%   c1b2a3d4-5e6f-4708-9a1b-2c3d4e5f6a7b  rack3
nodetool removenode c1b2a3d4-5e6f-4708-9a1b-2c3d4e5f6a7b
nodetool removenode status
# RemovalStatus: Removing token (-3074457345618258603). Waiting for replication confirmation from [/10.0.1.11,/10.0.1.12].
# If it stalls permanently (a required source is also down):
nodetool removenode force        # completes the ring change WITHOUT restoring RF -> repair after

# --- Replacing a DEAD node at the same tokens (preferred) ---
# On the replacement host, before first start:
echo '-Dcassandra.replace_address_first_boot=10.0.1.13' >> /etc/cassandra/jvm.options
systemctl start cassandra
# system.log:
# INFO  [main] StorageService.java - Replacing a node with token(s): [...]
# INFO  [main] StorageService.java - JOINING: Starting to bootstrap...
# Afterwards, remove the flag from jvm.options.

# --- Adding a datacenter ---
# On every dc2 node: auto_bootstrap: false, then start.
```

```cql
ALTER KEYSPACE shop
  WITH replication = {'class':'NetworkTopologyStrategy','dc1':3,'dc2':3};

-- Verify what a node is now responsible for
SELECT peer, data_center, rack, tokens FROM system.peers_v2;
SELECT data_center, rack, tokens FROM system.local;
```

```bash
# Then on EVERY node in dc2:
nodetool rebuild -- dc1
nodetool netstats -H          # watch inbound
# Finally:
nodetool repair -pr -full shop
```

Driver-side: topology changes are handled automatically, but the load-balancing policy must be pinned to a DC so a new DC does not start absorbing traffic prematurely.

```python
from cassandra.cluster import Cluster, ExecutionProfile, EXEC_PROFILE_DEFAULT
from cassandra.policies import DCAwareRoundRobinPolicy, TokenAwarePolicy
from cassandra import ConsistencyLevel

profile = ExecutionProfile(
    # used_hosts_per_remote_dc=0 => never send traffic to a DC still rebuilding
    load_balancing_policy=TokenAwarePolicy(
        DCAwareRoundRobinPolicy(local_dc="dc1", used_hosts_per_remote_dc=0)),
    consistency_level=ConsistencyLevel.LOCAL_QUORUM,
)
cluster = Cluster(["10.0.1.11", "10.0.1.12"], execution_profiles={EXEC_PROFILE_DEFAULT: profile})
session = cluster.connect("shop")
# The driver auto-discovers the new node via the control connection's
# TOPOLOGY_CHANGE event; no restart or config change is needed.
```

> **Optimization:** bootstrap and rebuild are almost always **network- or compaction-bound, not CPU-bound**. Raise `stream_throughput_outbound_megabits_per_sec` on the *source* nodes to roughly 60–70% of NIC capacity for the duration (`nodetool setstreamthroughput 600` — live, no restart), and raise `compaction_throughput_mb_per_sec` on the *joining* node so it can absorb the incoming SSTables. Then put both back before peak traffic. On 4.0+, ensure the tables use compression settings compatible with **zero-copy streaming** (entire-SSTable transfer applies when the file falls wholly inside the requested range) — a table with 256 vnodes fragments ranges so finely that few SSTables qualify, which is one more concrete reason `num_tokens: 16` beats 256.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost/Trade-off |
|---|---|---|
| Online bootstrap | Add capacity with zero downtime and no client changes | Hours per node at TB scale; streaming competes with client traffic |
| Vnodes (`num_tokens`) | Automatic balance; new node draws from all peers in parallel | More tokens means more ranges: slower repair, more range scans, less zero-copy streaming |
| `num_tokens: 16` + allocation algorithm | Under 5% ownership spread with cheap repairs | Must be configured **before** nodes bootstrap; not retrofittable to existing tokens |
| `decommission` | Streams data out first — no data loss, no repair required | Slow; the leaving node must stay up throughout; halves your removal speed |
| `removenode` | Works on a node that is already gone | Data only that node held is lost; survivors do the streaming under load |
| `replace_address_first_boot` | Fastest failure recovery; ring unchanged; no cleanup | Requires the dead node to stay dead — if it returns, you get two nodes with the same tokens |
| `rebuild` for a new DC | Clean, resumable way to add a region | Saturates the WAN; must run on every node; clients must not use the DC until done |
| `consistent.rangemovement=true` | Guarantees consistency during topology change | Serialises node additions — doubling a 50-node cluster takes days |
| Disabling it for parallel bootstrap | Much faster fleet growth | Can silently violate consistency; mandatory full repair afterwards |
| `assassinate` | Removes a ghost gossip entry nothing else can clear | No streaming at all — replication is left broken; almost always the wrong tool |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Listing the new node in its own `seeds` list.** → ✅ A seed node **skips bootstrap** and joins empty, silently taking ownership of ranges it has no data for — instant data loss on reads at `CL=ONE`. Seeds should be a stable set of 2–3 nodes per DC that the new node is *not* a member of.
2. ⚠️ **Using `removenode` on a dead node when you have a replacement ready.** → ✅ `removenode` rebalances the whole ring and forces survivors to stream under load. `replace_address_first_boot` keeps the ring identical and streams only what the replacement needs. Replace is faster and cheaper in every dimension.
3. ⚠️ **Bootstrapping two nodes at once without understanding `consistent.rangemovement`.** → ✅ Cassandra will refuse by default. If you override it with `-Dcassandra.consistent.rangemovement=false`, you accept possible under-replicated ranges and **must** run a full repair afterwards.
4. ⚠️ **Skipping `nodetool cleanup` after a bootstrap.** → ✅ Old owners keep the data forever: disk never drops, compaction keeps rewriting dead rows, and `nodetool status` load looks permanently wrong. Run cleanup on every pre-existing node, one at a time.
5. ⚠️ **Running `cleanup` on all nodes simultaneously.** → ✅ It is a full SSTable rewrite per node. Concurrent cleanup across the cluster saturates disk and spikes client latency. Serialise it, and never overlap it with repair.
6. ⚠️ **Adding a DC with `auto_bootstrap: true`.** → ✅ Each new-DC node will try to bootstrap from the existing DC across the WAN individually and unpredictably. The correct sequence is `auto_bootstrap: false`, `ALTER KEYSPACE`, then `nodetool rebuild -- <source-dc>` on every node.
7. ⚠️ **Pointing application traffic at a new DC before `rebuild` completes.** → ✅ The DC has partial data; `LOCAL_QUORUM` reads there return missing rows. Keep `used_hosts_per_remote_dc=0` and switch clients only after rebuild plus a repair.
8. ⚠️ **Decommissioning below `RF` nodes per DC.** → ✅ With `RF=3` you cannot operate on 2 nodes. Cassandra will let you get there and then every `QUORUM` operation fails. Check `n_after >= RF` and disk capacity before removing anything.
9. ⚠️ **Reusing a decommissioned node's data directories.** → ✅ Old SSTables and `system` keyspace state make it rejoin with stale tokens or a duplicate host ID. Wipe `data/`, `commitlog/`, `hints/`, `saved_caches/` before reuse.
10. ⚠️ **Bootstrapping a node running a different Cassandra version.** → ✅ Streaming is version-sensitive and schema propagation across major versions is unsupported. Never bootstrap during a rolling upgrade — finish the upgrade first.
11. ⚠️ **Reaching for `nodetool assassinate` when `removenode` is slow.** → ✅ Assassinate rips the entry out of gossip with **no streaming**, leaving ranges under-replicated with no indication. Use `removenode force` if you must, then repair. Assassinate is only for a phantom entry that no longer maps to any real host.
12. ⚠️ **Adding one node when the cluster is at 85% disk.** → ✅ Existing nodes need headroom to compact while streaming out, and the incoming node needs headroom to compact what it receives. Expand before you cross ~70%; below that you have options, above it you have an incident.
13. ⚠️ **Ignoring rack placement when adding nodes.** → ✅ `NetworkTopologyStrategy` places replicas in distinct racks. Adding nodes unevenly across racks skews replica placement and can make a single rack failure lose quorum. Add in rack-balanced groups.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** A stuck bootstrap is the classic incident. Symptoms: node sits at `UJ` for hours with no progress in `nodetool netstats`. Check, in order: (1) `system.log` on both the joining node and the stream *sources* for `StreamException` or socket timeouts; (2) whether a source node died mid-stream — pre-4.0 this killed the whole bootstrap and required restarting from scratch after wiping the data dir, while 4.0's resumable bootstrap can continue with `nodetool bootstrap resume`; (3) `streaming_keep_alive_period_in_secs` versus any firewall/NAT idle timeout on port 7000 (a 5-minute NAT timeout silently kills long-idle stream sockets — a very common cloud failure); (4) disk full on the joining node.

If a bootstrap must be abandoned: stop the node, wipe `data/`, `commitlog/`, `saved_caches/`, and restart. If it partially joined and is now a ghost, `nodetool removenode <host-id>` from a live node clears it.

For a stalled `removenode`, `nodetool removenode status` names the nodes it is waiting on. If one of those is itself down, `removenode force` is the escape hatch — followed immediately by repair.

**Monitoring.** During any topology change, watch:
- `org.apache.cassandra.metrics:type=Streaming,name=TotalIncomingBytes|TotalOutgoingBytes` — progress and rate.
- `nodetool netstats` / `system_views.sstable_tasks` for the receiving node's compaction backlog.
- `org.apache.cassandra.metrics:type=ClientRequest,scope=Write,name=Unavailables|Timeouts` on the **coordinators** — this is your early warning that streaming is hurting production.
- `org.apache.cassandra.metrics:type=Storage,name=Load` per node — the balance you are trying to achieve.
- `org.apache.cassandra.metrics:type=Compaction,name=PendingTasks` on the joining node — if it climbs past a few hundred, the node is receiving faster than it can compact and you should throttle the sources.
- Disk free percentage on every node — the operation that fills a disk is almost always a topology change.

**Security.** Streaming travels on the internode port (7000, or 7001 with TLS) and carries **raw row data**. If `server_encryption_options: internode_encryption` is not at least `dc` (and `all` for cross-DC), every bootstrap and rebuild broadcasts your entire dataset in cleartext — across the WAN in the DC-add case. Also: a node that can gossip into your cluster can bootstrap and receive a full replica of your data, so the internode port must be firewalled to known cluster members, and `require_client_auth: true` with a private CA is the correct posture. Never expose 7000 to the internet; a rogue node join is a complete data exfiltration.

**Performance & Scaling.** Plan capacity so you never add nodes under duress: expand at ~70% disk, not 85%. Practical throughput: with `stream_throughput_outbound_megabits_per_sec: 400` and 4.0 zero-copy streaming, expect roughly 30–50 MB/s effective per source stream, so a 1 TB node bootstraps in a few hours drawing from many peers in parallel. Because `consistent.rangemovement` serialises additions, growing a large cluster is measured in **days**; plan it as a project, not a task. When doubling capacity, the standard pattern is to add nodes rack-by-rack so replica placement stays balanced, run cleanup between each, and schedule a full repair at the end. For very large expansions, consider adding a whole new DC and using `rebuild` — it parallelises far better than serial bootstrap and gives you a clean rollback (just point clients back at the old DC).

## 9. Interview Questions

**Q: What is the difference between `decommission` and `removenode`?**
A: `decommission` runs **on a live node** and streams that node's data out to the new range owners before it leaves — no data is lost and no repair is required. `removenode` runs from any live node against a **dead** node's host ID; the dead node contributes nothing, so surviving replicas stream to each other to restore `RF`, and any data only the dead node held is gone.

**Q: When should you use `replace_address_first_boot` instead of `removenode` plus bootstrap?**
A: Whenever a node dies and you have a replacement host. Replace takes over the dead node's exact tokens, so the ring shape is unchanged, only the replacement streams, and no `cleanup` is needed anywhere. `removenode` plus a later bootstrap rebalances the ring twice and forces two rounds of streaming and cleanup.

**Q: Why must a new node never appear in its own `seeds` list?**
A: A seed node skips the bootstrap process entirely and joins the ring immediately, empty. It will then own token ranges for which it has no data, so reads at `CL=ONE` against it return nothing and quorum reads may return incorrect merged results. Seeds should be a stable set of existing nodes.

**Q: What does `nodetool cleanup` do and when is it required?**
A: It rewrites a node's SSTables, dropping partitions whose tokens the node no longer owns. It is required after any operation that shrinks a node's ownership — a bootstrap of another node, a decommission, a removenode, or a token move. It is *not* required after `replace_address`, because ownership does not change. Run it one node at a time; it costs as much I/O as a major compaction.

**Q: What are vnodes and why did the default drop from 256 to 16 in Cassandra 4.0?**
A: Vnodes give each node many small token ranges instead of one contiguous range, so a joining node streams from all peers in parallel and balance is automatic. 256 tokens made balance good but made every range-based operation expensive: repair had 256 ranges per node to validate, range scans hit more nodes, and finely fragmented ranges defeat 4.0's zero-copy whole-SSTable streaming. `num_tokens: 16` plus `allocate_tokens_for_local_replication_factor` gets comparable balance at a fraction of the operational cost.

**Q: How do you add a new datacenter to an existing cluster?**
A: Start the new DC's nodes with `auto_bootstrap: false` so they join empty and fast, with the correct DC/rack in `cassandra-rackdc.properties`. Then `ALTER KEYSPACE` to add the new DC to `NetworkTopologyStrategy`, run `nodetool rebuild -- <source-dc>` on every node in the new DC, and finally run a repair. Only after that should clients be allowed to use `LOCAL_QUORUM` against the new DC.

**Q: What state does `nodetool status` show during a bootstrap, and does the node serve traffic then?**
A: `UJ` — Up and Joining. During that state the node is a *pending* replica: coordinators send it writes so it does not fall behind while streaming, but it does not serve reads. It flips to `UN` atomically when streaming completes, at which point it begins serving reads for its ranges.

**Q: (Senior) What is `cassandra.consistent.rangemovement` and what breaks if you disable it?**
A: It enforces that only one node is joining or leaving at a time. The reason is that concurrent range movements can overlap: node X may stream a range from node Y, while Y is simultaneously giving up ownership of that range, so the resulting replica set for the range has fewer than `RF` complete copies and a `QUORUM` read can miss data that was successfully written. Disabling it with `-Dcassandra.consistent.rangemovement=false` allows parallel bootstraps — sometimes necessary when you must add twenty nodes in a weekend — but you are trading a correctness guarantee for speed and **must** run a full repair of every keyspace afterwards before trusting quorum semantics again.

**Q: (Senior) A bootstrap has been at `UJ` for six hours with no netstats progress. Walk through your response.**
A: First establish whether streams are dead or merely slow: `nodetool netstats` on the joining node and on each source, plus `system.log` on both sides for `StreamException`, `SocketTimeoutException`, or a source that restarted. The classic cloud cause is an idle-connection timeout on a NAT gateway or firewall killing long-lived port-7000 sockets — check that `streaming_keep_alive_period_in_secs` (300) is shorter than the network idle timeout. Second, check disk free and compaction backlog on the joining node; if it is receiving faster than it compacts, it can appear stalled while thrashing. Third, on 4.0+ try `nodetool bootstrap resume`, which continues from completed ranges rather than restarting. If none of that works, abandon: stop the node, wipe `data/`, `commitlog/` and `saved_caches/`, clear any ghost entry with `nodetool removenode <host-id>` from a live node, fix the network cause, and start over — ideally with `stream_throughput` raised and during a quieter traffic window.

**Q: (Senior) You need to double a 40-node cluster before a launch in one week. How do you plan it?**
A: Serial bootstrap with `consistent.rangemovement` enabled is roughly one node per few hours plus a cleanup pass, which does not fit — so I would evaluate two options. Option A: add a **new datacenter** of 40 nodes with `auto_bootstrap: false`, `ALTER KEYSPACE` to replicate there, and run `nodetool rebuild` in parallel across all 40 (rebuild is per-node and independent, so it parallelises well), then repair, then either cut clients over or leave both DCs live. This is the safest and fastest path and gives a clean rollback. Option B: parallel bootstrap into the existing DC with `consistent.rangemovement=false`, adding nodes rack-by-rack with at most one per rack in flight, followed by a mandatory full repair and cleanup on every node. I would pick A unless network cost or client topology forbids it. Either way: verify disk headroom first, raise stream and compaction throughput during the window, keep `LOCAL_QUORUM` (never `QUORUM`) so cross-DC latency does not leak into the app, and hold a full-repair window at the end before the launch.

**Q: (Senior) Why is `nodetool assassinate` dangerous, and when is it legitimately the right call?**
A: Assassinate forcibly removes an endpoint from gossip state on the node you run it from, with **no streaming and no replication restoration**. Every range the assassinated node replicated is left with `RF-1` copies and nothing tells you. It is legitimate only for a **phantom** entry — an IP that appears in `nodetool gossipinfo` or `nodetool status` but corresponds to no real host and cannot be cleared by `removenode` (typically after a botched replace or a node that was terminated mid-bootstrap). Even then, run it on every node so gossip state is consistent, and follow immediately with a full repair of every keyspace.

**Q: What happens to client applications during a bootstrap?**
A: Nothing, if the driver is configured properly. The control connection receives a `TOPOLOGY_CHANGE` event and the driver adds the new host to its pool automatically once it reaches `UN`; token-aware routing recalculates. The real client-visible risk is not membership but **load**: streaming and the extra compaction on the joining node consume disk and network, which shows up as elevated p99 latency and, if you are already near capacity, `WriteTimeoutException`. Throttle streaming and do it off-peak.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Four operations, four different streaming patterns. **Bootstrap**: a new node (never in its own seed list, `auto_bootstrap: true`, `num_tokens: 16` with `allocate_tokens_for_local_replication_factor`) claims tokens and streams in from all peers, showing `UJ` while it takes writes but not reads, then `UN`. Follow with `nodetool cleanup` on every pre-existing node, one at a time. **Decommission**: run on a *live* node; it streams its data out and leaves; then cleanup. **Removenode**: run against a *dead* node's host ID; survivors stream to restore `RF` and any data only it held is lost; `removenode force` completes the ring change without restoring replication, so repair after. **Replace**: `-Dcassandra.replace_address_first_boot=<dead-ip>` takes over the dead node's exact tokens — no ring change, no cleanup, the preferred hardware-failure path. Adding a **DC**: `auto_bootstrap: false` → `ALTER KEYSPACE` → `nodetool rebuild -- <src-dc>` on every node → repair → only then send clients. `consistent.rangemovement` serialises additions for correctness; disabling it needs a mandatory full repair. Expand at 70% disk, encrypt internode traffic, never bootstrap during a version upgrade.

| Operation | Command | Cleanup after? | Repair after? |
|---|---|---|---|
| Add node | start with `auto_bootstrap: true` | **Yes**, all pre-existing nodes | No (if serial) |
| Remove live node | `nodetool decommission` (on that node) | Yes | No |
| Remove dead node | `nodetool removenode <host-id>` | Yes | Recommended |
| Force-complete removal | `nodetool removenode force` | Yes | **Mandatory** |
| Replace dead node | `-Dcassandra.replace_address_first_boot=<ip>` | **No** | If down > hint window |
| Add datacenter | `auto_bootstrap:false` + `nodetool rebuild -- dc1` | No | Yes |
| Parallel bootstrap | `-Dcassandra.consistent.rangemovement=false` | Yes | **Mandatory** |
| Clear phantom entry | `nodetool assassinate <ip>` | n/a | **Mandatory** |
| Resume failed bootstrap (4.0+) | `nodetool bootstrap resume` | — | — |

| Setting | Value | Note |
|---|---|---|
| `num_tokens` | `16` (4.x default) | 256 in 3.x; lower is better for repair and streaming |
| `allocate_tokens_for_local_replication_factor` | `3` | Must be set before bootstrap; not retrofittable |
| `auto_bootstrap` | `true` | `false` only for a brand-new cluster or a DC add |
| `stream_throughput_outbound_megabits_per_sec` | `200`–`400` | Live change: `nodetool setstreamthroughput` |
| `inter_dc_stream_throughput_outbound_megabits_per_sec` | `100` | Protect the WAN |
| `streaming_keep_alive_period_in_secs` | `300` | Must be under any NAT idle timeout |
| Expand threshold | ~70% disk | Above 85% you have no options |

**Flash cards**
- **Which removal path loses data?** → `removenode` on a dead node (and `removenode force` / `assassinate` more so); `decommission` on a live node loses nothing.
- **After which operation is `cleanup` NOT needed?** → `replace_address_first_boot` — the replacement takes the same tokens, so no other node's ownership changed.
- **Why must a new node not be in its own seeds list?** → Seeds skip bootstrap and join empty, owning ranges with no data.
- **What does `UJ` mean for reads?** → The node takes writes as a pending replica but serves no reads until it reaches `UN`.
- **How do you add a datacenter?** → `auto_bootstrap: false`, `ALTER KEYSPACE` to add the DC, `nodetool rebuild -- <source-dc>` on every node, repair, then move clients.

## 11. Hands-On Exercises & Mini Project

- [ ] Create a 3-node cluster with `ccm` (`ccm create topo -v 4.1.5 -n 3 -s`), load 2 GB with `cassandra-stress`, then add a 4th node (`ccm add node4 -i 127.0.0.4 -j 7400 -b && ccm node4 start`). Capture `nodetool status` at `UJ` and at `UN`, and `nodetool netstats` mid-bootstrap. Record the bootstrap duration and the ownership before/after.
- [ ] After the node reaches `UN`, record `Load` on nodes 1–3, run `nodetool cleanup` on each in turn, and record the disk reclaimed. Explain why the drop is roughly `1/4` of each node's prior load.
- [ ] Decommission node4 (`ccm node4 nodetool decommission`) and watch `UL` plus the outbound streams. Then re-add it and compare the time to the original bootstrap.
- [ ] Simulate a dead node: `ccm node3 stop --not-gently`. Practise both recovery paths on separate runs — (a) `nodetool removenode <host-id>` and (b) a fresh node started with `-Dcassandra.replace_address_first_boot=127.0.0.3`. Compare total streaming volume and wall-clock time.
- [ ] Add a second datacenter in `ccm` (`ccm add node5 --data-center=dc2 ...`), `ALTER KEYSPACE` to `{'dc1':3,'dc2':3}`, run `nodetool rebuild -- dc1`, and verify with `SELECT * FROM system.peers_v2` and a `LOCAL_QUORUM` read against dc2 both before and after rebuild — observe the missing rows before.
- [ ] Deliberately misconfigure: put a new node's own IP in its `seeds` list, start it, and observe that it joins directly as `UN` with near-zero load. Query it at `CONSISTENCY ONE` and count the missing rows. Then fix it properly.

### Mini Project — Topology Change Runbook Automation

**Goal.** A tool that executes a node addition or removal safely, with pre-flight checks and automatic verification, so no human has to remember step 7.

**Requirements.**
1. **Pre-flight**: verify all nodes `UN`, one schema version (`nodetool describecluster`), no repair or streaming in progress (`nodetool netstats`, `system_views.sstable_tasks`), disk usage below a configurable threshold on every node, and — for removals — that `nodes_after >= RF` per DC and remaining disk suffices.
2. **Execute** the chosen operation (`bootstrap`, `decommission`, `removenode`, `replace`), polling `nodetool status` and `netstats` and printing a progress bar with an ETA derived from bytes streamed per second.
3. **Post-flight**: automatically run `nodetool cleanup` on the correct set of nodes, serially, with a configurable throttle, skipping it entirely for the `replace` path.
4. **Verify**: assert final ownership spread is within a threshold, assert `Load` dropped on the expected nodes, and emit a report.
5. **Abort safely**: if streaming stalls for longer than a timeout, stop, print the diagnostic bundle (both sides' `system.log` stream lines, netstats, disk free), and refuse to proceed.

**Extensions.**
- Add a `--rack-aware` mode that refuses to start an operation if another node in the same rack is already down or in flight.
- Add a `--dc-add` workflow that drives the whole `auto_bootstrap:false` → `ALTER KEYSPACE` → parallel `rebuild` → repair sequence, with a confirmation gate before the `ALTER`.
- Emit Prometheus metrics for streaming rate and estimated completion so the operation is visible on the same dashboard as client latency — the two numbers you actually need side by side.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *nodetool & Everyday Cluster Operations* (ch. 27) covers the commands used throughout; *Repair: Full, Incremental & Subrange* (ch. 29) is the mandatory follow-up to several of these operations; *Replication Strategies & Snitches* explains `NetworkTopologyStrategy` and rack awareness; *Multi-Datacenter Deployment* goes deeper on the DC-add workflow; *Gossip & Failure Detection* explains `UJ`/`UL`/`DN` state propagation; *Capacity Planning & Sizing* tells you when to add nodes in the first place.

- **Apache Cassandra Docs — Adding, replacing, moving and removing nodes** — Apache Software Foundation · *Advanced* · the authoritative procedure for every topology operation, including the exact JVM flags. <https://cassandra.apache.org/doc/latest/cassandra/managing/operating/topo_changes.html>
- **Apache Cassandra Docs — Bootstrap** — Apache Software Foundation · *Intermediate* · what streaming does during a join and how resumable bootstrap works. <https://cassandra.apache.org/doc/latest/cassandra/managing/operating/bootstrap.html>
- **CASSANDRA-14556 — Zero Copy Streaming** — Apache JIRA · *Expert* · the 4.0 streaming rewrite; explains why whole-SSTable transfer needs coarse token ranges. <https://issues.apache.org/jira/browse/CASSANDRA-14556>
- **CASSANDRA-13701 — Lower default num_tokens** — Apache JIRA · *Advanced* · the reasoning behind the 256 → 16 change and the token allocation algorithm. <https://issues.apache.org/jira/browse/CASSANDRA-13701>
- **The Last Pickle — Cassandra Token Allocation Algorithm** — TLP · *Advanced* · measured comparison of random tokens vs `allocate_tokens_for_local_replication_factor`. <https://thelastpickle.com/blog/2019/02/21/set-up-a-cluster-with-even-token-distribution.html>
- **DataStax Docs — Adding a datacenter to an existing cluster** — DataStax · *Intermediate* · the step-by-step DC-add sequence including the `auto_bootstrap: false` requirement. <https://docs.datastax.com/en/cassandra-oss/3.x/cassandra/operations/opsAddDCToCluster.html>
- **Netflix Tech Blog — Scaling Time Series Data Storage / Cassandra at Netflix** — Netflix Engineering · *Advanced* · real-world scaling patterns, cluster growth strategy and why they favour DC-level operations. <https://netflixtechblog.com/scaling-time-series-data-storage-part-i-ec2b6d44ba39>
- **ccm (Cassandra Cluster Manager)** — Apache / Sylvain Lebresne · *Beginner* · the tool that makes every exercise in this chapter runnable on a laptop in minutes. <https://github.com/riptano/ccm>

---

*Apache Cassandra Handbook — chapter 28.*
