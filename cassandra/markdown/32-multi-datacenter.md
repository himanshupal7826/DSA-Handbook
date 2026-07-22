# 32 · Multi-Datacenter Deployment & Replication

> **In one line:** Multi-DC Cassandra gives you regional low latency and disaster survival for the price of one extra consistency rule — always use `NetworkTopologyStrategy` and `LOCAL_QUORUM`, and never let a client's quorum cross an ocean.

---

## 1. Overview

A single-datacenter Cassandra cluster is a highly available database inside one failure domain. That is fine until the failure domain fails: an AZ-wide power event, a fibre cut, a bad network ACL push, or an entire cloud region degrading. Multi-datacenter replication is Cassandra's answer, and it is genuinely the feature that made Cassandra the default choice for globally distributed systems. Unlike bolt-on replication in most relational engines, cross-DC replication in Cassandra is not a secondary mode — it is the same replication mechanism, just with topology awareness. Every write goes to every DC that the keyspace's replication factor names, at the same time, through the same code path.

The problem it solves is threefold. **Latency:** a user in Frankfurt should not pay a 150 ms round trip to Virginia to read their own profile. **Disaster recovery:** losing a region should cost you capacity, not data. **Workload isolation:** analytics scans and Spark jobs are toxic to a latency-sensitive OLTP workload sharing the same page cache and compaction budget, but perfectly safe in a dedicated DC that replicates the same data. That last use case — a logical "DC" that is really just a workload boundary in the same physical region — is the one teams discover last and value most.

Historically this came from Facebook's original Cassandra design and was hardened by Netflix, who in 2011 published the famous benchmark of a 288-node multi-region cluster on EC2 doing over a million writes per second, and later ran active-active across three AWS regions for their entire subscriber-facing tier. Their operational rule became the industry rule: **write and read at `LOCAL_QUORUM` in your local DC, let Cassandra replicate asynchronously across regions, and accept that cross-region convergence is eventual and measured in tens of milliseconds.**

A concrete example. A payments company runs `eu-west-1` and `us-east-1`, each with 12 nodes, plus a 6-node `analytics` DC colocated with `us-east-1`. The keyspace is `{'class':'NetworkTopologyStrategy','eu_west':3,'us_east':3,'analytics':2}` — RF 8 total, eight copies of every row. European traffic hits the EU coordinator, which writes to 3 EU replicas and returns as soon as 2 ack (`LOCAL_QUORUM = floor(3/2)+1 = 2`), typically in 1.5 ms. In parallel, the coordinator picks **one** replica per remote DC as a forwarding proxy and ships the mutation there once; that node fans it out locally. Spark reads from `analytics` at `LOCAL_ONE`, never touching an OLTP node.

The mental model: **a Cassandra cluster is one ring with topology labels, not several clusters.** Token ownership is global; `NetworkTopologyStrategy` walks the ring and picks replicas per DC, skipping racks it has already used. Consistency levels are the only place where "local" and "each" become meaningful, and choosing them correctly is 90% of multi-DC operations.

## 2. Core Concepts

- **NetworkTopologyStrategy (NTS)** — the only replication strategy for production; RF is specified *per datacenter* and replicas are placed to avoid repeating a rack until it must.
- **Snitch** — the component that tells Cassandra which DC and rack each node is in. `GossipingPropertyFileSnitch` (GPFS) is the production default; `Ec2Snitch`/`Ec2MultiRegionSnitch` derive DC/rack from AWS region and AZ.
- **LOCAL_QUORUM** — quorum computed over the replicas in the coordinator's own DC only: `floor(RF_local/2)+1`. The default production CL.
- **EACH_QUORUM** — a quorum in *every* DC must ack. Write-only in practice (there is no `EACH_QUORUM` read), and it makes you as slow and as fragile as your worst region.
- **LOCAL_ONE / LOCAL_SERIAL** — single local replica, and Paxos restricted to the local DC respectively; `LOCAL_SERIAL` is what you want for LWT in a multi-DC cluster.
- **Forwarding replica (remote coordinator)** — one replica per remote DC receives the mutation once over the WAN and forwards it to its local peers, so cross-DC bandwidth is O(DCs), not O(replicas).
- **Hinted handoff across DCs** — if a remote DC is unreachable, the local coordinator stores hints for up to `max_hint_window` (default 3 h) and replays them on recovery.
- **`dc_local_read_repair_chance` / read repair** — Cassandra 4.0 removed the background `read_repair_chance` settings entirely; only blocking read repair (driven by the CL) and explicit repair remain.
- **Rack** — a failure domain within a DC (an AZ in cloud). NTS places one replica per rack first; the number of racks should equal or be a multiple of RF.
- **`allow_system_auth_rf_override` / auth keyspace RF** — `system_auth` must be replicated to every DC, or a region failure locks you out of logging in.

## 3. Theory & Internals

`NetworkTopologyStrategy.calculateNaturalReplicas` runs per DC. Starting at the token of the partition key, it walks the ring clockwise. For DC *d* with RF *r*, it accepts a node if the node is in *d* and either its rack is unseen or all racks in *d* have already been used. This produces two important properties: replicas within a DC are spread across racks whenever possible, and the placement for each DC is independent — adding a DC never moves the replicas of an existing DC. That independence is why you can add a region to a live cluster without a global data reshuffle.

The quorum math is where teams get hurt. For a keyspace `{eu_west:3, us_east:3}`, total RF is 6, so global `QUORUM = floor(6/2)+1 = 4`. Four acks out of six *cannot* be satisfied by one DC alone, so a plain `QUORUM` write always crosses the WAN, and a full region outage makes every `QUORUM` operation fail — even though half your data is perfectly healthy. `LOCAL_QUORUM` is `floor(3/2)+1 = 2` inside one DC, so it survives losing the other region entirely, and it also survives losing one node locally.

Strong consistency requires `R + W > RF` **within the same replica set**. With `LOCAL_QUORUM` reads and writes in the same DC: `2 + 2 > 3` holds locally, so a reader in that DC always sees its own writes. Across DCs the guarantee does not hold — a write acked in EU may not yet be visible to a `LOCAL_QUORUM` read in US East. That window is exactly the inter-region replication latency plus any queueing, typically 30–120 ms for a transatlantic link, but unbounded if the WAN is saturated or a DC is down and mutations are landing in hints.

Cross-DC write cost is deliberately optimised. Consider RF `{eu:3, us:3}` and a 1 KB mutation written in EU. Naively the coordinator would send 3 copies over the WAN. Instead `StorageProxy.sendToHintedReplicas` groups destinations by DC, picks one replica in `us_east` (preferring one in the same rack index for determinism), and sends a single message with a `forwardToHeader` listing the other two. That node writes locally and forwards over the cheap intra-DC network. WAN traffic is therefore `mutation_size × (num_remote_DCs)`, not `× (remote replicas)` — a 3× saving per remote DC.

```svg
<svg viewBox="0 0 780 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="780" height="360" fill="#ffffff"/>
  <defs><marker id="a32" markerWidth="9" markerHeight="9" refX="8" refY="4" orient="auto"><path d="M0 0 L9 4 L0 8 z" fill="#1e293b"/></marker></defs>
  <text x="20" y="26" font-size="15" font-weight="700" fill="#1e293b">One write, two datacenters: forwarding replicas keep WAN cost at 1x per DC</text>
  <rect x="20" y="46" width="330" height="200" rx="12" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="185" y="70" font-size="13" font-weight="700" fill="#1e293b" text-anchor="middle">DC eu_west (RF=3)</text>
  <rect x="40" y="84" width="120" height="44" rx="8" fill="#ffffff" stroke="#4f46e5" stroke-width="2"/>
  <text x="100" y="103" font-size="11" font-weight="700" fill="#1e293b" text-anchor="middle">Coordinator</text>
  <text x="100" y="119" font-size="10" fill="#1e293b" text-anchor="middle">rack 1a</text>
  <rect x="200" y="84" width="130" height="34" rx="8" fill="#ffffff" stroke="#4f46e5"/>
  <text x="265" y="106" font-size="11" fill="#1e293b" text-anchor="middle">replica A rack 1a</text>
  <rect x="200" y="126" width="130" height="34" rx="8" fill="#ffffff" stroke="#4f46e5"/>
  <text x="265" y="148" font-size="11" fill="#1e293b" text-anchor="middle">replica B rack 1b</text>
  <rect x="200" y="168" width="130" height="34" rx="8" fill="#ffffff" stroke="#4f46e5"/>
  <text x="265" y="190" font-size="11" fill="#1e293b" text-anchor="middle">replica C rack 1c</text>
  <path d="M160 106 L196 101" stroke="#4f46e5" stroke-width="2" marker-end="url(#a32)"/>
  <path d="M160 112 L196 143" stroke="#4f46e5" stroke-width="2" marker-end="url(#a32)"/>
  <path d="M160 118 L196 185" stroke="#4f46e5" stroke-width="2" marker-end="url(#a32)"/>
  <text x="185" y="222" font-size="11" fill="#1e293b" text-anchor="middle">ack after 2 of 3 = LOCAL_QUORUM, about 1.5 ms</text>
  <rect x="430" y="46" width="330" height="200" rx="12" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="595" y="70" font-size="13" font-weight="700" fill="#1e293b" text-anchor="middle">DC us_east (RF=3)</text>
  <rect x="450" y="84" width="140" height="44" rx="8" fill="#ffffff" stroke="#16a34a" stroke-width="2"/>
  <text x="520" y="103" font-size="11" font-weight="700" fill="#1e293b" text-anchor="middle">forwarding replica</text>
  <text x="520" y="119" font-size="10" fill="#1e293b" text-anchor="middle">rack 1a</text>
  <rect x="620" y="96" width="125" height="34" rx="8" fill="#ffffff" stroke="#16a34a"/>
  <text x="682" y="118" font-size="11" fill="#1e293b" text-anchor="middle">replica E rack 1b</text>
  <rect x="620" y="150" width="125" height="34" rx="8" fill="#ffffff" stroke="#16a34a"/>
  <text x="682" y="172" font-size="11" fill="#1e293b" text-anchor="middle">replica F rack 1c</text>
  <path d="M590 110 L616 113" stroke="#16a34a" stroke-width="2" marker-end="url(#a32)"/>
  <path d="M590 118 L616 165" stroke="#16a34a" stroke-width="2" marker-end="url(#a32)"/>
  <text x="595" y="222" font-size="11" fill="#1e293b" text-anchor="middle">applied asynchronously, not part of the client ack</text>
  <path d="M100 128 C 160 300, 400 300, 520 132" stroke="#d97706" stroke-width="3" fill="none" marker-end="url(#a32)"/>
  <rect x="230" y="270" width="330" height="34" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="395" y="292" font-size="12" fill="#1e293b" text-anchor="middle">1 WAN message carrying forwardTo header, about 80 ms RTT</text>
  <text x="20" y="332" font-size="12" fill="#1e293b">QUORUM over RF=6 needs 4 acks and must cross the WAN. LOCAL_QUORUM needs 2 and does not.</text>
  <text x="20" y="350" font-size="12" fill="#1e293b">If us_east is down: LOCAL_QUORUM in eu_west still succeeds; mutations queue as hints for up to 3 h.</text>
</svg>
```

Hint accumulation is the silent multi-DC risk. If `us_east` is unreachable for four hours with a keyspace at RF 3 there, every EU write generates 3 hints. At 50k writes/s and 1 KB rows that is 150 MB/s of hint files — 2 TB after four hours, which will fill the hints directory long before `max_hint_window` expires. Cassandra caps this with `max_hints_delivery_threads`, `hinted_handoff_throttle_in_kb` (1024 KB/s per delivery thread by default) and `max_hints_size_per_host`. Once the window lapses or hints are dropped, only **repair** can restore consistency, and repair across a WAN with `-full` will saturate the link. This is why the standard recovery procedure for a long DC outage is `nodetool rebuild -- <source_dc>` on the recovered nodes rather than a repair.

## 4. Architecture & Workflow

Adding a second DC to a live cluster, in the order that actually works:

1. **Verify the snitch.** Every existing node must already be using `GossipingPropertyFileSnitch` with correct `cassandra-rackdc.properties`. Changing snitch on a live cluster with data is dangerous; do it before you need it.
2. **Confirm keyspaces use NTS.** Any keyspace still on `SimpleStrategy` — including `system_auth`, `system_distributed` and `system_traces` — must be altered to NTS *with the existing DC only* first. `ALTER KEYSPACE ks WITH replication = {'class':'NetworkTopologyStrategy','dc1':3};`
3. **Provision the new DC's nodes** with `auto_bootstrap: false` in `cassandra.yaml`, the same cluster name, seeds from both DCs, and `cassandra-rackdc.properties` naming the new DC and racks. Start them. They join the ring and own tokens but hold no data.
4. **Point clients at their local DC.** Configure the driver's `DCAwareRoundRobinPolicy` (or `DefaultLoadBalancingPolicy` with `local-datacenter`) and switch application CLs to `LOCAL_QUORUM` *before* changing replication — otherwise the ALTER makes `QUORUM` operations start crossing the WAN instantly.
5. **Alter the keyspace** to add the new DC's RF. From this moment, new writes are replicated to the new DC; historical data is not.
6. **Rebuild.** On every node in the new DC run `nodetool rebuild -- <source_dc>`. This streams all data the node now owns from the named DC. Run a few nodes at a time; it is bandwidth-bound and resumable in 4.0+ (`nodetool rebuild --keep-alive`).
7. **Verify.** `nodetool status <keyspace>` should show a healthy `Owns %` in the new DC; run `nodetool repair -pr --full` per node afterwards to catch anything written during the window between steps 5 and 6.
8. **Cut traffic over** gradually, watching `ClientRequest.Read.Latency` per DC and `Messaging.CrossNodeLatency`.

```svg
<svg viewBox="0 0 780 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="780" height="340" fill="#ffffff"/>
  <defs><marker id="b32" markerWidth="9" markerHeight="9" refX="8" refY="4" orient="auto"><path d="M0 0 L9 4 L0 8 z" fill="#1e293b"/></marker></defs>
  <text x="20" y="26" font-size="15" font-weight="700" fill="#1e293b">Three-DC topology: two live regions plus an isolated analytics DC</text>
  <circle cx="140" cy="140" r="70" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="140" y="132" font-size="12" font-weight="700" fill="#1e293b" text-anchor="middle">eu_west</text>
  <text x="140" y="150" font-size="11" fill="#1e293b" text-anchor="middle">RF 3, 12 nodes</text>
  <text x="140" y="166" font-size="10" fill="#1e293b" text-anchor="middle">3 racks = 3 AZs</text>
  <circle cx="390" cy="140" r="70" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="390" y="132" font-size="12" font-weight="700" fill="#1e293b" text-anchor="middle">us_east</text>
  <text x="390" y="150" font-size="11" fill="#1e293b" text-anchor="middle">RF 3, 12 nodes</text>
  <text x="390" y="166" font-size="10" fill="#1e293b" text-anchor="middle">3 racks = 3 AZs</text>
  <circle cx="640" cy="140" r="70" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="640" y="126" font-size="12" font-weight="700" fill="#1e293b" text-anchor="middle">analytics</text>
  <text x="640" y="144" font-size="11" fill="#1e293b" text-anchor="middle">RF 2, 6 nodes</text>
  <text x="640" y="160" font-size="10" fill="#1e293b" text-anchor="middle">Spark, LOCAL_ONE</text>
  <path d="M212 140 L316 140" stroke="#1e293b" stroke-width="2" marker-end="url(#b32)"/>
  <path d="M316 152 L212 152" stroke="#1e293b" stroke-width="2" marker-end="url(#b32)"/>
  <path d="M462 140 L566 140" stroke="#1e293b" stroke-width="2" marker-end="url(#b32)"/>
  <text x="264" y="122" font-size="10" fill="#1e293b" text-anchor="middle">async, 80 ms</text>
  <text x="514" y="122" font-size="10" fill="#1e293b" text-anchor="middle">async, 2 ms</text>
  <rect x="20" y="238" width="230" height="80" rx="10" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="135" y="260" font-size="11" font-weight="700" fill="#1e293b" text-anchor="middle">EU app tier</text>
  <text x="135" y="279" font-size="10" fill="#1e293b" text-anchor="middle">local_dc = eu_west</text>
  <text x="135" y="296" font-size="10" fill="#1e293b" text-anchor="middle">CL = LOCAL_QUORUM (2 of 3)</text>
  <text x="135" y="312" font-size="10" fill="#1e293b" text-anchor="middle">p99 read 4 ms</text>
  <rect x="270" y="238" width="230" height="80" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="385" y="260" font-size="11" font-weight="700" fill="#1e293b" text-anchor="middle">US app tier</text>
  <text x="385" y="279" font-size="10" fill="#1e293b" text-anchor="middle">local_dc = us_east</text>
  <text x="385" y="296" font-size="10" fill="#1e293b" text-anchor="middle">CL = LOCAL_QUORUM (2 of 3)</text>
  <text x="385" y="312" font-size="10" fill="#1e293b" text-anchor="middle">p99 read 4 ms</text>
  <rect x="520" y="238" width="240" height="80" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="640" y="260" font-size="11" font-weight="700" fill="#1e293b" text-anchor="middle">Spark / batch</text>
  <text x="640" y="279" font-size="10" fill="#1e293b" text-anchor="middle">local_dc = analytics</text>
  <text x="640" y="296" font-size="10" fill="#1e293b" text-anchor="middle">CL = LOCAL_ONE, full scans</text>
  <text x="640" y="312" font-size="10" fill="#1e293b" text-anchor="middle">cannot touch OLTP page cache</text>
  <path d="M135 236 L138 214" stroke="#1e293b" stroke-width="2" marker-end="url(#b32)"/>
  <path d="M385 236 L388 214" stroke="#1e293b" stroke-width="2" marker-end="url(#b32)"/>
  <path d="M640 236 L640 214" stroke="#1e293b" stroke-width="2" marker-end="url(#b32)"/>
</svg>
```

## 5. Implementation

Topology configuration — this is what the snitch reads:

```yaml
# cassandra.yaml (every node)
endpoint_snitch: GossipingPropertyFileSnitch
cluster_name: 'payments-prod'
seed_provider:
  - class_name: org.apache.cassandra.locator.SimpleSeedProvider
    parameters:
      - seeds: "10.1.0.11,10.1.0.12,10.2.0.11,10.2.0.12"   # 2 seeds per DC, never all
listen_address: 10.1.0.31
broadcast_address: 10.1.0.31          # public/elastic IP if regions are not peered
internode_compression: dc             # compress cross-DC traffic only
inter_dc_tcp_nodelay: false           # coalesce for WAN throughput
hinted_handoff_throttle_in_kb: 1024
max_hint_window_in_ms: 10800000       # 3 h
```

```bash
# cassandra-rackdc.properties on a Frankfurt node in AZ-a
dc=eu_west
rack=1a
prefer_local=true      # use private IPs within a DC even when broadcast_address is public
```

Keyspace definition and the migration path:

```cql
-- New keyspace: never SimpleStrategy in production
CREATE KEYSPACE payments WITH replication = {
  'class': 'NetworkTopologyStrategy', 'eu_west': 3, 'us_east': 3, 'analytics': 2
} AND durable_writes = true;

-- CRITICAL: auth and distributed system keyspaces must live in every DC
ALTER KEYSPACE system_auth WITH replication = {
  'class':'NetworkTopologyStrategy','eu_west':3,'us_east':3,'analytics':2};
ALTER KEYSPACE system_distributed WITH replication = {
  'class':'NetworkTopologyStrategy','eu_west':3,'us_east':3,'analytics':2};
ALTER KEYSPACE system_traces WITH replication = {
  'class':'NetworkTopologyStrategy','eu_west':2,'us_east':2,'analytics':2};

CREATE TABLE payments.ledger (
  account_id uuid, bucket text, txn_id timeuuid, amount decimal, currency text,
  PRIMARY KEY ((account_id, bucket), txn_id)
) WITH CLUSTERING ORDER BY (txn_id DESC)
  AND compaction = {'class':'TimeWindowCompactionStrategy','compaction_window_size':'1',
                    'compaction_window_unit':'DAYS'};

-- Per-statement CL, the multi-DC default
CONSISTENCY LOCAL_QUORUM;
INSERT INTO payments.ledger (account_id, bucket, txn_id, amount, currency)
VALUES (7f3c..., '2026-07', now(), 42.50, 'EUR');
```

Operational commands for the rebuild flow:

```bash
# On each new-DC node, stream historical data from an existing DC
nodetool rebuild -- eu_west
# ... resumable in 4.0+: nodetool abortrebuild / rebuild again picks up remaining ranges

# Watch the stream
nodetool netstats | grep -E 'Receiving|Sending|files'
# Receiving 214 files, 88.4 GiB total. Already received 97 files, 41.1 GiB

# Verify per-DC ownership (keyspace argument is required for accurate Owns%)
nodetool status payments
# Datacenter: eu_west
# --  Address     Load     Tokens  Owns(effective)  Host ID   Rack
# UN  10.1.0.31   412 GiB  16      25.1%            3f2a...   1a
# Datacenter: us_east
# UN  10.2.0.31   409 GiB  16      24.8%            9b41...   1a

# Cross-DC latency sanity check (4.0+ virtual table)
nodetool gossipinfo | grep -E 'DC|RACK' | head
```

Driver configuration is where most multi-DC incidents originate. The driver must know its local DC and must not fail over blindly:

```python
from cassandra.cluster import Cluster, ExecutionProfile, EXEC_PROFILE_DEFAULT
from cassandra.policies import DCAwareRoundRobinPolicy, TokenAwarePolicy
from cassandra import ConsistencyLevel

profile = ExecutionProfile(
    load_balancing_policy=TokenAwarePolicy(
        # used_hosts_per_remote_dc=0 -> never silently cross the WAN
        DCAwareRoundRobinPolicy(local_dc="eu_west", used_hosts_per_remote_dc=0)),
    consistency_level=ConsistencyLevel.LOCAL_QUORUM,
    request_timeout=5.0,
)
cluster = Cluster(["10.1.0.31", "10.1.0.32"],   # contact points in the LOCAL dc only
                  execution_profiles={EXEC_PROFILE_DEFAULT: profile},
                  protocol_version=5)
session = cluster.connect("payments")
rs = session.execute("SELECT * FROM ledger WHERE account_id=%s AND bucket=%s LIMIT 20",
                     (account_id, "2026-07"))
```

```java
// Java driver 4.x — application.conf equivalent, inline for clarity
CqlSession session = CqlSession.builder()
    .addContactPoint(new InetSocketAddress("10.1.0.31", 9042))
    .withLocalDatacenter("eu_west")                       // mandatory in 4.x
    .withConfigLoader(DriverConfigLoader.programmaticBuilder()
        .withString(DefaultDriverOption.REQUEST_CONSISTENCY, "LOCAL_QUORUM")
        .withDuration(DefaultDriverOption.REQUEST_TIMEOUT, Duration.ofSeconds(5))
        .build())
    .build();
```

> **Note:** Driver 4.x deliberately removed automatic remote-DC failover. That is correct behaviour: if your local DC cannot serve `LOCAL_QUORUM`, silently sending requests to another continent turns a 4 ms p99 into a 180 ms p99 across your whole fleet and hides the outage. Regional failover belongs at the load balancer / DNS layer, where you move *users*, not individual queries.

**Optimization note:** set `internode_compression: dc` rather than `all`. Intra-DC links are cheap and fast, so compression there costs CPU for nothing; cross-DC links are expensive and latency-bound, where LZ4 compression typically cuts WAN bytes by 60–75% on JSON-ish payloads. Pair it with `inter_dc_tcp_nodelay: false` so small mutations coalesce into larger TCP segments over the high-latency link.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost/Trade-off |
|---|---|---|
| Regional read/write latency | Users hit a local DC at `LOCAL_QUORUM`, single-digit ms | Cross-DC data is eventually consistent; read-your-writes only holds within a DC |
| Disaster recovery | Losing a whole region loses zero data and zero availability locally | You pay full storage and node cost per DC — RF 3+3 means 6 copies |
| Workload isolation | An analytics DC absorbs Spark scans with no OLTP impact | More nodes, more repair scope, more schema-change blast radius |
| Same replication path | No separate log-shipping tier to operate or monitor | A schema change or bad mutation propagates everywhere within seconds |
| NTS independence per DC | Add or remove a DC without reshuffling existing replicas | Requires `rebuild`, which is bandwidth-heavy and can take days |
| Hinted handoff across WAN | Short remote outages self-heal with no operator action | Long outages overflow hints; recovery needs `rebuild` or full repair |
| `EACH_QUORUM` writes | Genuine cross-region durability guarantee per write | Latency of the slowest region on every write; any DC outage halts writes |
| LWT with `LOCAL_SERIAL` | Linearizable operations confined to one DC | No global linearizability; two DCs can both "win" a conditional update |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Using `SimpleStrategy` or leaving `system_auth` on it.** A region loss then locks every operator out. → ✅ NTS everywhere, `system_auth` replicated to every DC with RF 3 (or RF = node count if the DC is smaller).
2. ⚠️ **Using `QUORUM` in a multi-DC keyspace.** With RF 3+3, `QUORUM` = 4 acks, so every request crosses the WAN and a DC outage breaks everything. → ✅ `LOCAL_QUORUM` for reads and writes; reserve `EACH_QUORUM` for the rare write that must be durable in both regions before you ack.
3. ⚠️ **Not setting `local-datacenter` in the driver.** Java driver 4.x refuses to start without it; older drivers happily round-robin across continents. → ✅ Always set it, and set `used_hosts_per_remote_dc=0`.
4. ⚠️ **Listing contact points from all DCs.** The driver may bootstrap its view from a remote node and pick remote coordinators. → ✅ Contact points from the local DC only.
5. ⚠️ **Bootstrapping new-DC nodes with `auto_bootstrap: true`.** They will stream from the remote DC before the keyspace is altered, producing partial, inconsistent data. → ✅ `auto_bootstrap: false`, then `ALTER KEYSPACE`, then `nodetool rebuild -- <src_dc>`.
6. ⚠️ **Forgetting repair after `rebuild`.** Writes landing during the ALTER→rebuild window can be missed. → ✅ Run `nodetool repair -pr --full` on the new DC once rebuild completes, then move to incremental/scheduled repair via Reaper.
7. ⚠️ **Assuming a write in DC-A is instantly readable in DC-B.** → ✅ Design for it: route a user's session to one DC (sticky routing at the edge), or read at `LOCAL_QUORUM` in the DC that took the write.
8. ⚠️ **Using LWT (`IF NOT EXISTS`) at `SERIAL` across DCs.** Global Paxos over a WAN costs four round trips and 500 ms+. → ✅ `LOCAL_SERIAL` and confine the contended key's writes to one DC, or redesign to avoid LWT.
9. ⚠️ **Running repair with `-full` across the WAN during peak.** It will saturate the inter-region link and drive up p99 everywhere. → ✅ Repair per DC with `-dc` / `--dc-parallel` scoping, throttle with `streaming_throughput_outbound`, and schedule off-peak.
10. ⚠️ **Letting rack counts diverge from RF.** Two racks with RF 3 puts two replicas in one rack; losing that AZ breaks `LOCAL_QUORUM`. → ✅ Racks per DC = RF (usually 3), with node counts balanced across them.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** The first question in any multi-DC incident is "which DC is the coordinator in, and which DC are the replicas in?" `nodetool status <ks>` answers ownership; `TRACING ON` in cqlsh names the exact replicas and their DCs for one query. If EU latency spikes while US is fine, check `Messaging.CrossNodeLatency` and whether some client accidentally uses `QUORUM`. `nodetool gossipinfo` shows each node's `DC` and `RACK` values as gossiped — a mismatch between `cassandra-rackdc.properties` and what gossip reports means a node started with the wrong file and is now placing replicas incorrectly, which is a data-placement bug, not a config typo. For a suspected split brain, compare `nodetool describecluster` schema versions across DCs; more than one schema UUID means a schema disagreement, usually from concurrent DDL.

**Monitoring.** Per-DC everything. `ClientRequest.{Read,Write}.Latency` sliced by DC; `ClientRequest.Write.Unavailables` and `.Timeouts` per CL scope (the metric scope includes the CL, e.g. `Write-LOCAL_QUORUM`); `Messaging` cross-node latency per peer DC; `Storage.TotalHintsInProgress` and `TotalHints` (a rising hint count on EU nodes means US is unreachable or slow); `HintsService.HintsSucceeded/HintsFailed`; streaming metrics during rebuild. Alert on schema-version disagreement lasting more than 60 s, and on any nonzero `EACH_QUORUM` unavailable count. Track WAN bytes at the network layer too — `internode_compression: dc` savings show up there.

**Security.** Cross-DC traffic leaves your datacenter, so `server_encryption_options` must be `internode_encryption: dc` (or `all`) with real certificates and, in 4.0+, `require_client_auth: true` for mutual TLS between nodes. Use separate truststores per environment so a dev node can never gossip into prod. Client-to-node TLS (`client_encryption_options`) is separate and equally necessary if apps cross a network boundary. Restrict the analytics DC's credentials to a read-only role: `GRANT SELECT ON KEYSPACE payments TO analytics_ro;` — an accidental `TRUNCATE` from a Spark job replicates instantly to production. Firewall port 7000/7001 to known peer CIDRs only; gossip is unauthenticated at the network level and cluster name is the only guard against a stray node joining.

**Performance & scaling.** Scale each DC independently — DCs need not have the same node count or RF, and a DR-only DC at RF 2 with fewer, larger nodes is a legitimate cost optimisation as long as it can absorb full traffic if promoted. Bandwidth planning: steady-state cross-DC traffic ≈ write throughput × mutation size × number of remote DCs, before compression; rebuild traffic is the entire dataset. Cap it with `stream_throughput_outbound_megabits_per_sec` and `inter_dc_stream_throughput_outbound_megabits_per_sec` (defaults 200 Mbit/s and 200 Mbit/s in 4.x) so a rebuild cannot starve live replication. For latency, keep `LOCAL_QUORUM` achievable during a rack loss: RF 3 across 3 racks tolerates one AZ down; RF 3 across 2 racks does not.

## 9. Interview Questions

**Q: Why must production keyspaces use `NetworkTopologyStrategy` instead of `SimpleStrategy`?**
A: `SimpleStrategy` walks the ring and takes the next N nodes with no awareness of DC or rack, so replicas can all land in one rack — or all in one datacenter — making the "replication" useless for failure isolation. NTS lets you set RF per DC and spreads replicas across racks within a DC. There is no scenario where `SimpleStrategy` is correct in production, even single-DC, because you will eventually add a DC and the migration is painful.

**Q: What exactly does `LOCAL_QUORUM` mean and why is it the multi-DC default?**
A: It is a quorum computed only over the replicas in the coordinator's own datacenter: `floor(RF_local/2)+1`. With RF 3 locally that is 2 acks, achievable in one or two milliseconds without touching the WAN. It gives read-your-writes consistency within that DC (`2+2 > 3`) while remaining available if the entire remote region disappears.

**Q: A keyspace is `{dc1:3, dc2:3}`. What happens if the app uses `QUORUM`?**
A: Total RF is 6, so `QUORUM` needs `floor(6/2)+1 = 4` acks. No single DC can supply 4, so every operation crosses the WAN and pays inter-region latency. Worse, if either DC goes down only 3 replicas remain and every `QUORUM` request fails with `UnavailableException` — you have built a system that is less available than a single DC.

**Q: How does Cassandra avoid sending one copy of each mutation per remote replica?**
A: The coordinator groups target replicas by DC and sends a single message over the WAN to one replica in each remote DC, with a `forwardTo` header listing that DC's other replicas. The receiving node applies the mutation locally and forwards it over the cheap local network. WAN cost is therefore one mutation per remote DC regardless of the remote RF.

**Q: What is a snitch and which one should you use?**
A: A snitch maps each node to a datacenter and rack, which NTS uses for replica placement and the driver uses for routing. `GossipingPropertyFileSnitch` is the production choice: each node declares its own DC/rack in `cassandra-rackdc.properties` and gossips it, so it works identically on-prem and in cloud. `Ec2Snitch`/`Ec2MultiRegionSnitch` derive region and AZ automatically but lock you to one topology naming scheme.

**Q: Walk me through adding a new datacenter to a live cluster.**
A: Confirm GPFS and NTS everywhere; start the new nodes with `auto_bootstrap: false`, correct `cassandra-rackdc.properties`, and seeds from both DCs; switch clients to `LOCAL_QUORUM` with an explicit local DC; `ALTER KEYSPACE` to add the new DC's RF; run `nodetool rebuild -- <source_dc>` on each new node; then `nodetool repair -pr --full` to close the gap; finally shift traffic while watching per-DC latency. Skipping `auto_bootstrap: false` or altering replication before clients are on `LOCAL_QUORUM` are the two classic ways to cause an outage.

**Q: (Senior) A whole region is down for six hours. Walk me through recovery.**
A: During the outage the surviving DC serves everything at `LOCAL_QUORUM` — no action needed there beyond capacity. Hints for the dead DC accumulate for `max_hint_window` (3 h default) and then stop, so after six hours a meaningful chunk of mutations exists nowhere in the recovered DC. On recovery, bring nodes up but keep client traffic away from that DC. Because hints are incomplete, run `nodetool repair -pr --full` scoped per node, or if the gap is large, faster and safer to `nodetool rebuild -- <healthy_dc>` after removing the DC's data — repairs of a six-hour delta over a WAN can take longer than a rebuild. Only route traffic back once `nodetool status` and per-DC read latency confirm health, and verify no `ClientRequest` inconsistency signals remain.

**Q: (Senior) How do you get linearizable operations in a multi-DC cluster, and what breaks?**
A: Cassandra's LWT uses Paxos. `SERIAL` runs Paxos over all replicas in all DCs, giving global linearizability at the cost of four WAN round trips — often 400–800 ms transatlantic — and it fails entirely if a global quorum of replicas is unreachable. `LOCAL_SERIAL` confines Paxos to the local DC, which is fast and DC-outage tolerant, but linearizability is then only per DC: two DCs can concurrently accept conflicting conditional updates to the same key and last-write-wins resolves them, silently violating the invariant you thought LWT gave you. The practical answer is to partition the keyspace of contended entities by DC (route all writes for an account to its home region) or to move the invariant out of Cassandra.

**Q: (Senior) Your analytics DC is causing OLTP latency spikes even though it's a separate DC. How?**
A: Several ways, all real. First, the analytics job may not have `local_dc` set to `analytics`, so its coordinators are OLTP nodes. Second, at RF 2 in analytics with a heavy scan, coordinators there fetch from OLTP replicas if the CL demands more replicas than analytics holds — running `QUORUM` instead of `LOCAL_ONE` does exactly this. Third, repair and streaming: a repair session that includes both DCs makes OLTP nodes compute Merkle trees and stream, which is CPU- and disk-heavy. Fourth, schema changes and gossip are cluster-wide, so a Spark job creating tables per run churns schema on every node. Fix: pin `local_dc`, use `LOCAL_ONE`, scope repairs with `--dc`, and give analytics its own credentials and a read-only role.

**Q: What is `EACH_QUORUM` and when would you actually use it?**
A: It requires a quorum of replicas in *every* DC to acknowledge a write. It is available for writes only. Use it when a write must be durable in both regions before you tell the user it succeeded — a financial commit that must survive an immediate region loss. The cost is that write latency equals the slowest region's round trip and any single DC outage stops writes entirely, so it is normally applied to a small subset of statements, not the whole workload.

**Q: Why do racks matter and how many should a DC have?**
A: NTS places replicas in distinct racks before reusing one, so racks are the failure domain that keeps a quorum alive when an AZ dies. With RF 3, use exactly three racks mapped to three AZs and keep node counts balanced across them — then losing one AZ leaves 2 of 3 replicas and `LOCAL_QUORUM` still succeeds. With two racks and RF 3, one rack holds two replicas and losing it breaks quorum for a third of your tokens.

**Q: How do you keep cross-DC bandwidth under control?**
A: Set `internode_compression: dc` so only WAN traffic is compressed, and `inter_dc_tcp_nodelay: false` to coalesce packets. Cap streaming with `inter_dc_stream_throughput_outbound_megabits_per_sec` so a rebuild or repair cannot starve live replication. Reduce the payload itself: avoid replicating high-churn or ephemeral tables to remote DCs by giving them their own keyspace with RF 0 in DCs that do not need them — replication factor is per-keyspace, so this is a first-class design tool.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Multi-DC Cassandra is one ring with topology labels. `GossipingPropertyFileSnitch` plus `cassandra-rackdc.properties` tells each node its DC and rack; `NetworkTopologyStrategy` uses that to place RF replicas per DC, one per rack. Clients set an explicit local DC and use `LOCAL_QUORUM` (`floor(RF_local/2)+1`), which gives read-your-writes inside a DC and survives losing a region; plain `QUORUM` over RF 3+3 needs 4 acks, always crosses the WAN, and fails when a DC dies. Cross-DC writes cost one WAN message per remote DC thanks to forwarding replicas. Add a DC by starting nodes with `auto_bootstrap: false`, altering the keyspace, then `nodetool rebuild -- <src_dc>` and a full repair. Hints cover short remote outages (3 h window); long ones need rebuild. Replicate `system_auth` everywhere, use `LOCAL_SERIAL` for LWT, encrypt internode traffic with `internode_encryption: dc`, and never let analytics jobs coordinate through OLTP nodes.

| Setting / command | Purpose | Default / recommended |
|---|---|---|
| `endpoint_snitch` | DC/rack discovery | `GossipingPropertyFileSnitch` |
| `NetworkTopologyStrategy` | Per-DC replication factor | `{dc1:3, dc2:3}` |
| `LOCAL_QUORUM` | Local quorum CL | `floor(RF_local/2)+1` = 2 at RF 3 |
| `internode_compression` | Compress internode traffic | `dc` (WAN only) |
| `inter_dc_tcp_nodelay` | Coalesce WAN packets | `false` |
| `max_hint_window_in_ms` | Hint retention for a down DC | 10800000 (3 h) |
| `inter_dc_stream_throughput_outbound_megabits_per_sec` | Rebuild/repair WAN cap | 200 |
| `nodetool rebuild -- <dc>` | Stream all owned data from a DC | Run after `ALTER KEYSPACE` |
| `nodetool status <ks>` | Per-DC ownership and state | `Owns(effective)` balanced |
| `internode_encryption` | Internode TLS scope | `dc` minimum in multi-DC |

**Flash cards**
- **RF `{dc1:3, dc2:3}`, what is `QUORUM`?** → 4 of 6 — always crosses the WAN and fails if a DC dies. Use `LOCAL_QUORUM` = 2.
- **How many WAN messages per write with 2 remote DCs at RF 3 each?** → 2 — one forwarding replica per remote DC fans out locally.
- **Order of operations for adding a DC** → `auto_bootstrap:false` → start nodes → clients to `LOCAL_QUORUM` → `ALTER KEYSPACE` → `nodetool rebuild` → repair.
- **LWT in multi-DC** → `LOCAL_SERIAL`; `SERIAL` costs 4 WAN round trips and dies with a DC.
- **Keyspace you must never forget to replicate** → `system_auth` — otherwise a region loss locks out all logins.

## 11. Hands-On Exercises & Mini Project

- [ ] Build a two-DC cluster locally: `ccm create mdc -v 4.1.3 -n 3:3` creates dc1 and dc2. Verify with `ccm node1 nodetool status` that both DCs appear, then create a keyspace with `{'dc1':3,'dc2':3}`.
- [ ] Write a row at `LOCAL_QUORUM` in dc1, immediately read it at `LOCAL_QUORUM` in dc2 with `ccm node4 cqlsh`. Repeat 100 times in a loop and count how often the read misses — then add a 50 ms sleep and observe convergence.
- [ ] Stop all of dc2 (`ccm node4 stop; ccm node5 stop; ccm node6 stop`). Confirm `LOCAL_QUORUM` writes in dc1 still succeed, `QUORUM` writes fail with `UnavailableException`, and `nodetool statushandoff` shows hints accumulating. Restart dc2 and watch hints drain.
- [ ] Add a third DC to the running cluster following the eight-step workflow, including `nodetool rebuild -- dc1`, and verify with `nodetool status <ks>` that ownership is correct in all three.
- [ ] Configure the Python driver with `used_hosts_per_remote_dc=0` and prove that killing the local DC produces `NoHostAvailable` rather than silent cross-WAN failover.

**Mini Project — "Active-Active Regional Ledger"**

*Goal:* build a two-region ledger service that keeps sub-5 ms local latency, survives a full region loss with zero data loss for locally-acked writes, and isolates a reporting workload.

*Requirements:*
1. Docker Compose or ccm with three DCs: `eu`, `us`, `analytics` (RF 3/3/2), NTS everywhere including `system_auth`.
2. A Python or Java service with per-region config: contact points and `local_dc` from environment, `LOCAL_QUORUM` for the ledger path and `LOCAL_SERIAL` for an idempotency-key LWT.
3. A chaos script that stops an entire DC, measures error rate and latency in the surviving one, and reports hint growth; then restores and measures convergence time for a set of known keys.
4. A reporting job pinned to `analytics` at `LOCAL_ONE` doing full-table scans, with a dashboard proving OLTP p99 in `eu` and `us` is unaffected while it runs.
5. A written runbook for "region down > 3 hours" specifying rebuild vs repair with the reasoning and expected duration for your data size.

*Extensions:* add a fourth DC and measure the WAN cost delta per write with and without `internode_compression: dc`; implement sticky user-to-region routing at the edge and show it eliminates cross-DC read-your-writes anomalies; test `EACH_QUORUM` on the commit path and quantify the latency and availability cost.

## 12. Related Topics & Free Learning Resources

Pair this with **31 · Monitoring, Metrics & Observability** (per-DC metric slicing is mandatory here), **33 · Upgrades & Rolling Restarts** (upgrade one DC at a time), **36 · Troubleshooting Latency & Hotspots** (a misconfigured `local_dc` is a top-three cause of mystery latency), and the replication, consistency-level, repair and hinted-handoff chapters for the mechanisms this builds on.

- **Data Replication (official docs)** — Apache Cassandra · *Intermediate* · authoritative description of NTS replica placement and per-DC RF semantics. <https://cassandra.apache.org/doc/latest/cassandra/architecture/dynamo.html>
- **Adding a datacenter to an existing cluster** — DataStax Docs · *Intermediate* · the canonical ordered procedure including `auto_bootstrap: false` and `nodetool rebuild`. <https://docs.datastax.com/en/cassandra-oss/3.x/cassandra/operations/opsAddDCToCluster.html>
- **Netflix: Benchmarking Cassandra Scalability on AWS** — Netflix TechBlog · *Advanced* · the multi-region million-writes-per-second study that set the industry pattern. <https://netflixtechblog.com/benchmarking-cassandra-scalability-on-aws-over-a-million-writes-per-second-39f45f066c9e>
- **Netflix: Active-Active for Multi-Regional Resiliency** — Netflix TechBlog · *Advanced* · how regional failover is done at the traffic layer, not inside the database driver. <https://netflixtechblog.com/active-active-for-multi-regional-resiliency-c47719f9f223>
- **Consistency Levels reference** — Apache Cassandra · *Beginner* · exact semantics of `LOCAL_QUORUM`, `EACH_QUORUM`, `LOCAL_SERIAL` and their availability implications. <https://cassandra.apache.org/doc/latest/cassandra/architecture/guarantees.html>
- **Snitches and cassandra-rackdc.properties** — Apache Cassandra · *Beginner* · configuring GPFS correctly, including `prefer_local`. <https://cassandra.apache.org/doc/latest/cassandra/managing/configuration/cass_rackdc_file.html>
- **Repair in Cassandra — deep dive** — The Last Pickle · *Advanced* · why `--dc` scoping and subrange repair matter enormously across a WAN. <https://thelastpickle.com/blog/2017/12/14/should-you-use-incremental-repair.html>

---

*Apache Cassandra Handbook — chapter 32.*
