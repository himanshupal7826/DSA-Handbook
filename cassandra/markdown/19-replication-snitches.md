# 19 · Replication Strategies & Snitches

> **In one line:** The replication strategy decides *how many* copies of a partition exist and *where* they go, and the snitch is the component that teaches every node which datacenter and rack each peer lives in so that placement is actually fault-tolerant.

---

## 1. Overview

Cassandra has no primary node and no shard router. A partition key is hashed by Murmur3 into a 64-bit token, and that token lands somewhere on a ring spanning `-2^63` to `2^63 - 1`. The node that owns the range containing that token is the **primary replica**. Everything else — the second copy, the third copy, whether they sit in the same rack, whether one of them lives in Frankfurt — is decided by the **replication strategy** configured on the keyspace.

The problem this solves is *correlated failure*. Storing three copies is worthless if all three sit in the same rack behind the same top-of-rack switch and the same PDU: when that rack loses power you lose the partition, and you lose quorum availability for every partition that landed there. Replica placement must therefore be *topology-aware* — spread copies across failure domains, deterministically, so every node computes the identical replica set without coordination. Cassandra ships two strategies. `SimpleStrategy` walks the ring clockwise and takes the next `RF` distinct nodes, ignoring topology entirely — fine for a laptop, catastrophic in production. `NetworkTopologyStrategy` (NTS) takes a per-datacenter replication factor and, within each DC, walks the ring picking nodes in *distinct racks* until that DC's RF is satisfied. It is the only strategy you should configure for a real cluster, even a single-DC one, because it lets you add a second DC later without rewriting placement.

The **snitch** is the other half of the equation. NTS needs to know, for every node in the ring, its datacenter and rack. It also needs to answer "how close is this node to me?" so the coordinator can route reads to the fastest replica. That knowledge comes from the snitch: `GossipingPropertyFileSnitch` (GPFS) reads `cassandra-rackdc.properties` on each node and gossips the values; `Ec2Snitch` and `GoogleCloudSnitch` derive DC and rack from cloud instance metadata (region → DC, availability zone → rack). Changing the snitch on a live cluster is one of the most dangerous operations in Cassandra because it can silently relocate every replica.

Concretely: Discord stores billions of messages in Cassandra (and later ScyllaDB) with `NetworkTopologyStrategy` and RF=3 spread over three availability zones, reading and writing at `LOCAL_QUORUM`. A full AZ outage takes out exactly one replica per partition, `floor(3/2)+1 = 2` replicas remain, and the service keeps serving reads and writes with zero operator intervention. That property is not a happy accident — it is the direct consequence of one keyspace DDL line and one properties file.

## 2. Core Concepts

- **Token** — a 64-bit signed integer produced by `Murmur3Partitioner` from the partition key; determines position on the ring.
- **Replication factor (RF)** — the number of nodes that store a copy of each partition, configured *per datacenter* under NTS.
- **NetworkTopologyStrategy (NTS)** — the production replication strategy; places replicas in distinct racks within each named datacenter.
- **SimpleStrategy** — topology-blind strategy that takes the next RF nodes clockwise; never use it in production, and never in a multi-DC cluster.
- **Snitch** — the pluggable component that maps every node's IP to a `(datacenter, rack)` pair and defines network proximity for request routing.
- **Rack** — a failure domain inside a datacenter; in cloud deployments this maps to an availability zone, not a physical rack.
- **Dynamic snitch** — a wrapper enabled by default over whatever snitch you configure; it scores replicas by recent latency and routes reads away from slow nodes.
- **Natural replica** — a node that legitimately owns a copy of a partition per the strategy, as opposed to a node holding a hint or a pending range during bootstrap.
- **vnodes (`num_tokens`)** — virtual nodes; each physical node owns many small token ranges instead of one big one, smoothing distribution. Default is 16 in Cassandra 4.x.
- **`LOCAL_QUORUM`** — consistency level satisfied by `floor(RF_local/2)+1` replicas *in the coordinator's own DC*, the default choice for multi-DC production.

## 3. Theory & Internals

### Token math

`Murmur3Partitioner` hashes the serialized partition key into a signed 64-bit token. With `num_tokens: 16`, a 12-node cluster owns 192 token ranges, and each node's share of the ring converges to roughly `1/12` with a standard deviation far lower than a single-token assignment would give. Ownership of a token `t` belongs to the first node whose token is `>= t`, wrapping around at the ring boundary.

Verify with:

```
nodetool ring        # every token, its owner, and its DC/rack
nodetool status ks   # per-node effective ownership percentage for a keyspace
```

`Owns` in `nodetool status` is only meaningful when you pass a keyspace, because ownership depends on the replication strategy.

### How NTS actually picks replicas

For each datacenter, NTS walks the ring clockwise starting at the token, and for each candidate node:

1. Skip it if it is not in the datacenter currently being filled.
2. If its rack has already contributed a replica **and** there are still unvisited racks in this DC, skip it and remember it as a fallback.
3. Otherwise accept it as a replica.
4. Stop when the DC's RF is satisfied. If racks run out, fall back to the skipped nodes.

The critical consequence: **with RF=3 and exactly 3 racks, you get exactly one replica per rack**, which is what makes AZ-loss survivable. With RF=3 and 2 racks you get 2 in one rack and 1 in the other — losing the wrong rack drops you below quorum. With RF=3 and 1 rack you get no rack diversity at all. *Number of racks should equal, or be a multiple of, your highest RF.*

Racks must also be **balanced**. If AZ-a has 9 nodes and AZ-b has 3, the AZ-b nodes each carry roughly three times the data of an AZ-a node, because NTS insists on one replica per rack.

### Quorum math across datacenters

```
QUORUM       = floor(sum(RF over all DCs) / 2) + 1
LOCAL_QUORUM = floor(RF_local / 2) + 1
Strong consistency  ⟺  R + W > RF
```

With `{'dc_east': 3, 'dc_west': 3}` the global RF is 6, so `QUORUM = 4` — meaning any QUORUM operation must cross the WAN, adding 60–150 ms. `LOCAL_QUORUM = 2` stays inside one region. `LOCAL_QUORUM` reads plus `LOCAL_QUORUM` writes give `2 + 2 > 3` — strong consistency *within a DC*, with the remote DC catching up asynchronously.

```svg
<svg viewBox="0 0 660 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="660" height="330" fill="#eef2ff"/>
  <text x="18" y="26" font-size="15" fill="#1e293b" font-weight="bold">NetworkTopologyStrategy: RF 3 per DC, one replica per rack</text>
  <rect x="20" y="45" width="300" height="250" rx="10" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.6"/>
  <text x="36" y="68" font-size="13" fill="#1e293b" font-weight="bold">dc_east (RF=3)</text>
  <rect x="36" y="80" width="270" height="60" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.3"/>
  <text x="48" y="99" font-size="11" fill="#1e293b">rack rack1 / AZ us-east-1a</text>
  <rect x="48" y="106" width="60" height="26" rx="4" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.4"/>
  <text x="60" y="124" font-size="11" fill="#1e293b">n1 R1</text>
  <rect x="120" y="106" width="60" height="26" rx="4" fill="#ffffff" stroke="#94a3b8" stroke-width="1"/>
  <text x="134" y="124" font-size="11" fill="#1e293b">n2</text>
  <rect x="36" y="150" width="270" height="60" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.3"/>
  <text x="48" y="169" font-size="11" fill="#1e293b">rack rack2 / AZ us-east-1b</text>
  <rect x="48" y="176" width="60" height="26" rx="4" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.4"/>
  <text x="60" y="194" font-size="11" fill="#1e293b">n3 R2</text>
  <rect x="120" y="176" width="60" height="26" rx="4" fill="#ffffff" stroke="#94a3b8" stroke-width="1"/>
  <text x="134" y="194" font-size="11" fill="#1e293b">n4</text>
  <rect x="36" y="220" width="270" height="60" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.3"/>
  <text x="48" y="239" font-size="11" fill="#1e293b">rack rack3 / AZ us-east-1c</text>
  <rect x="48" y="246" width="60" height="26" rx="4" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.4"/>
  <text x="60" y="264" font-size="11" fill="#1e293b">n5 R3</text>
  <rect x="120" y="246" width="60" height="26" rx="4" fill="#ffffff" stroke="#94a3b8" stroke-width="1"/>
  <text x="134" y="264" font-size="11" fill="#1e293b">n6</text>
  <rect x="345" y="45" width="295" height="250" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="1.6"/>
  <text x="361" y="68" font-size="13" fill="#1e293b" font-weight="bold">dc_west (RF=3)</text>
  <rect x="361" y="80" width="262" height="60" rx="6" fill="#ffffff" stroke="#d97706" stroke-width="1.2"/>
  <text x="373" y="99" font-size="11" fill="#1e293b">rack1 / us-west-2a</text>
  <rect x="373" y="106" width="60" height="26" rx="4" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.4"/>
  <text x="385" y="124" font-size="11" fill="#1e293b">w1 R4</text>
  <rect x="361" y="150" width="262" height="60" rx="6" fill="#ffffff" stroke="#d97706" stroke-width="1.2"/>
  <text x="373" y="169" font-size="11" fill="#1e293b">rack2 / us-west-2b</text>
  <rect x="373" y="176" width="60" height="26" rx="4" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.4"/>
  <text x="385" y="194" font-size="11" fill="#1e293b">w2 R5</text>
  <rect x="361" y="220" width="262" height="60" rx="6" fill="#ffffff" stroke="#d97706" stroke-width="1.2"/>
  <text x="373" y="239" font-size="11" fill="#1e293b">rack3 / us-west-2c</text>
  <rect x="373" y="246" width="60" height="26" rx="4" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.4"/>
  <text x="385" y="264" font-size="11" fill="#1e293b">w3 R6</text>
  <text x="345" y="315" font-size="11" fill="#1e293b">LOCAL_QUORUM = 2 (in-DC). Global QUORUM = 4 (crosses the WAN).</text>
</svg>
```

### The dynamic snitch

Whatever endpoint snitch you configure, Cassandra wraps it in `DynamicEndpointSnitch` (`dynamic_snitch: true`, default). It maintains an exponentially-decaying histogram of read latency per replica and reorders the preference list. `dynamic_snitch_badness_threshold: 0.1` means the pinned primary replica is only bypassed when an alternative is at least 10% faster. This is why a single GC-thrashing node does not tank p99 across the cluster — until it does, because the dynamic snitch can also cause request flapping under uniform load. Some large operators disable it.

## 4. Architecture & Workflow

Walk a single `LOCAL_QUORUM` write in a two-DC cluster:

1. **Client picks a coordinator.** The driver's `TokenAwarePolicy` wrapped around `DCAwareRoundRobinPolicy` hashes the partition key locally and picks a node in the local DC that is a natural replica — saving one network hop.
2. **Coordinator computes the token.** `Murmur3Partitioner.getToken(pk)` → a 64-bit value.
3. **Coordinator asks the replication strategy for endpoints.** `AbstractReplicationStrategy.getNaturalReplicas(token)` runs the NTS walk described above, using the snitch's DC/rack map. For `{'dc_east':3,'dc_west':3}` it returns 6 endpoints.
4. **Coordinator splits local vs remote.** Three `dc_east` replicas get direct MessagingService writes. For `dc_west`, the coordinator picks **one** replica as a *forwarding coordinator* and sends a single message across the WAN with the other two endpoints attached — so the mutation crosses the expensive link once, not three times.
5. **Local replicas apply the mutation** — commit log append + memtable insert (Chapter 21) — and ACK.
6. **Coordinator counts ACKs.** At `LOCAL_QUORUM` it returns success to the client after 2 local ACKs. The remote DC and the third local replica complete asynchronously.
7. **Failures become hints.** Any replica that was down gets a hint stored on the coordinator for up to `max_hint_window` (3 hours by default), replayed when the node returns.
8. **Anti-entropy closes the gap.** Whatever hints miss is repaired by read repair or by scheduled `nodetool repair` (Chapter on repair).

```svg
<svg viewBox="0 0 660 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="660" height="320" fill="#e0f2fe"/>
  <text x="18" y="26" font-size="15" fill="#1e293b" font-weight="bold">LOCAL_QUORUM write: one WAN hop, not three</text>
  <rect x="20" y="120" width="90" height="44" rx="6" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.6"/>
  <text x="40" y="147" font-size="12" fill="#1e293b">client</text>
  <rect x="150" y="120" width="110" height="44" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.8"/>
  <text x="163" y="140" font-size="11" fill="#1e293b">coordinator</text>
  <text x="163" y="156" font-size="11" fill="#1e293b">n1 dc_east</text>
  <line x1="110" y1="142" x2="150" y2="142" stroke="#4f46e5" stroke-width="1.8" marker-end="url(#ar19)"/>
  <rect x="300" y="55" width="110" height="36" rx="5" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.4"/>
  <text x="312" y="78" font-size="11" fill="#1e293b">n3 rack2</text>
  <rect x="300" y="105" width="110" height="36" rx="5" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.4"/>
  <text x="312" y="128" font-size="11" fill="#1e293b">n5 rack3</text>
  <line x1="260" y1="135" x2="300" y2="75" stroke="#16a34a" stroke-width="1.6" marker-end="url(#ar19)"/>
  <line x1="260" y1="140" x2="300" y2="123" stroke="#16a34a" stroke-width="1.6" marker-end="url(#ar19)"/>
  <text x="268" y="52" font-size="10" fill="#16a34a">1 ms LAN</text>
  <rect x="300" y="200" width="130" height="44" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="1.8"/>
  <text x="311" y="220" font-size="11" fill="#1e293b">w1 dc_west</text>
  <text x="311" y="236" font-size="11" fill="#1e293b">forwarder</text>
  <line x1="215" y1="164" x2="300" y2="215" stroke="#d97706" stroke-width="2" stroke-dasharray="5 3" marker-end="url(#ar19b)"/>
  <text x="185" y="200" font-size="10" fill="#d97706">1 WAN msg (70 ms)</text>
  <rect x="480" y="175" width="110" height="34" rx="5" fill="#fef3c7" stroke="#d97706" stroke-width="1.3"/>
  <text x="492" y="197" font-size="11" fill="#1e293b">w2</text>
  <rect x="480" y="225" width="110" height="34" rx="5" fill="#fef3c7" stroke="#d97706" stroke-width="1.3"/>
  <text x="492" y="247" font-size="11" fill="#1e293b">w3</text>
  <line x1="430" y1="215" x2="480" y2="195" stroke="#d97706" stroke-width="1.4" marker-end="url(#ar19b)"/>
  <line x1="430" y1="225" x2="480" y2="240" stroke="#d97706" stroke-width="1.4" marker-end="url(#ar19b)"/>
  <text x="18" y="290" font-size="11" fill="#1e293b">Client is ACKed after 2 local replicas respond. Remote DC replicates in the background.</text>
  <text x="18" y="308" font-size="11" fill="#1e293b">Down replicas accumulate hints on the coordinator for up to max_hint_window (3 h).</text>
  <defs>
    <marker id="ar19" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#16a34a"/></marker>
    <marker id="ar19b" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#d97706"/></marker>
  </defs>
</svg>
```

## 5. Implementation

### Node-level topology

```yaml
# cassandra.yaml  — identical on every node in the cluster
endpoint_snitch: GossipingPropertyFileSnitch
dynamic_snitch: true
dynamic_snitch_badness_threshold: 0.1
dynamic_snitch_update_interval_in_ms: 100
num_tokens: 16
allocate_tokens_for_local_replication_factor: 3
```

```properties
# conf/cassandra-rackdc.properties  — per node, this is what GPFS gossips
dc=dc_east
rack=rack2
prefer_local=true
```

> **Note:** `prefer_local=true` makes nodes in the same DC talk over their private/broadcast address instead of the public one — essential in AWS to avoid paying inter-AZ egress twice.

### Keyspace DDL

```cql
-- Production: NetworkTopologyStrategy, always, even single-DC.
CREATE KEYSPACE orders
WITH replication = {
  'class': 'NetworkTopologyStrategy',
  'dc_east': 3,
  'dc_west': 3
} AND durable_writes = true;

-- Inspect what the cluster actually believes
SELECT keyspace_name, replication FROM system_schema.keyspaces;
--  orders | {'class': 'org.apache.cassandra.locator.NetworkTopologyStrategy',
--            'dc_east': '3', 'dc_west': '3'}

-- Which nodes hold a given partition? (virtual table, Cassandra 4.0+)
SELECT * FROM system_views.clients LIMIT 1;
```

Adding a datacenter is a three-step dance — **never** just ALTER and walk away: (1) bootstrap the `dc_west` nodes with `auto_bootstrap: false` so they join empty, (2) extend replication with `ALTER KEYSPACE orders WITH replication = {'class':'NetworkTopologyStrategy','dc_east':3,'dc_west':3};`, (3) stream the data across.

```bash
# Step 3: until this finishes, LOCAL_QUORUM reads in dc_west return empty results.
nodetool rebuild -- dc_east

# Verify placement for one partition key
nodetool getendpoints orders orders_by_customer 'cust-9931'
# 10.0.1.14
# 10.0.2.31
# 10.0.3.7
# 10.1.1.9
# 10.1.2.4
# 10.1.3.22

# Confirm the snitch is what you think it is
nodetool info | grep -i snitch
nodetool status orders
# Datacenter: dc_east
# ==================
# --  Address     Load     Tokens  Owns(effective)  Host ID   Rack
# UN  10.0.1.14   412.9 GiB  16    33.4%            8a1f...   rack1
# UN  10.0.2.31   408.1 GiB  16    33.2%            c04e...   rack2
# UN  10.0.3.7    415.6 GiB  16    33.4%            51bb...   rack3
```

### Driver configuration

```python
from cassandra.cluster import Cluster, ExecutionProfile, EXEC_PROFILE_DEFAULT
from cassandra.policies import DCAwareRoundRobinPolicy, TokenAwarePolicy
from cassandra import ConsistencyLevel

profile = ExecutionProfile(
    # Token-aware over DC-aware: hash the key locally, hit a natural replica
    # in the local DC directly. Zero remote-DC fallback -> no silent WAN reads.
    load_balancing_policy=TokenAwarePolicy(
        DCAwareRoundRobinPolicy(local_dc="dc_east")
    ),
    consistency_level=ConsistencyLevel.LOCAL_QUORUM,
    request_timeout=10.0,
)
cluster = Cluster(["10.0.1.14", "10.0.2.31"],
                  execution_profiles={EXEC_PROFILE_DEFAULT: profile})
session = cluster.connect("orders")

stmt = session.prepare(
    "INSERT INTO orders_by_customer (customer_id, order_id, total) VALUES (?, ?, ?)"
)
session.execute(stmt, ("cust-9931", "ord-7712", 249.90))

# Prove which replicas the driver targeted
rs = session.execute(stmt, ("cust-9931", "ord-7713", 19.00), trace=True)
for e in rs.get_query_trace().events[:3]:
    print(e.source, e.description)
# 10.0.1.14 Parsing INSERT INTO ...
# 10.0.1.14 Sending MUTATION message to /10.0.2.31
# 10.0.1.14 Sending MUTATION message to /10.0.3.7
```

```java
CqlSession session = CqlSession.builder()
    .addContactPoint(new InetSocketAddress("10.0.1.14", 9042))
    .withLocalDatacenter("dc_east")          // required in driver 4.x
    .withKeyspace("orders").build();
```

**Optimization:** set `allocate_tokens_for_local_replication_factor: 3` before bootstrapping new nodes. Cassandra's default random token assignment with `num_tokens: 16` can leave ±20% ownership skew; the RF-aware allocator drives it under ±5%, which directly reduces p99 on the hottest node and shrinks repair time on the largest one.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost/Trade-off |
| --- | --- | --- |
| NTS rack awareness | Survives a full AZ/rack loss with RF=3 across 3 racks | Requires racks to be balanced; unbalanced racks create hot nodes |
| Per-DC RF | Tune copies per region (e.g. 3 in prod DC, 1 in analytics DC) | Global `QUORUM` grows with total RF and crosses the WAN |
| `LOCAL_QUORUM` | Strong consistency inside a DC at LAN latency | Remote DC lags; a DC failover may read stale data |
| GossipingPropertyFileSnitch | Explicit, portable, works on bare metal and cloud alike | You own the properties file; a typo silently re-shards placement |
| Cloud snitches (`Ec2Snitch`) | Zero-config DC/rack from instance metadata | Region naming is fixed; migrating clouds means a snitch change |
| Dynamic snitch | Routes around a slow/GC-ing replica automatically | Can oscillate under uniform load; adds scoring overhead |
| vnodes | Even distribution, fast bootstrap, parallel streaming | More token ranges → more repair sessions; 256 vnodes hurts repair badly |
| Increasing RF | More durability and read capacity | Every write costs more; must run full repair before raising CL |

## 7. Common Mistakes & Best Practices

1. ⚠️ Using `SimpleStrategy` in production because it was the tutorial default → ✅ Always `NetworkTopologyStrategy`, even for one DC. Migrating later requires an `ALTER` plus a full repair and is far riskier than getting it right on day one.
2. ⚠️ Running RF=3 with all nodes in one rack (`rack=rack1` copy-pasted everywhere) → ✅ Set as many racks as your RF and keep node counts per rack equal. Verify with `nodetool status` before you take traffic.
3. ⚠️ Changing `endpoint_snitch` on a live cluster → ✅ Treat it as a data migration. If DC/rack names change, every replica set changes; you must run `nodetool repair -full` on every node afterwards or data is unreachable. Prefer standing up a new DC and decommissioning the old one.
4. ⚠️ `ALTER KEYSPACE` to add a DC and calling it done → ✅ You must run `nodetool rebuild -- <source_dc>` on every node of the new DC. The ALTER only changes *where data should be*, not where it is.
5. ⚠️ Using `QUORUM` in a multi-DC cluster → ✅ Use `LOCAL_QUORUM`. Global `QUORUM` with `{dc1:3, dc2:3}` needs 4 acks and will hang the moment the WAN link blips.
6. ⚠️ Setting RF greater than the node count in a DC → ✅ Cassandra accepts the DDL but every write will fail with `UnavailableException`. RF ≤ node count, and for RF=3 you want at least 5–6 nodes for headroom during maintenance.
7. ⚠️ Leaving `num_tokens: 256` from an old 3.x config → ✅ Use 16 (the 4.x default) with `allocate_tokens_for_local_replication_factor`. 256 vnodes multiplies repair sessions by 16× and dramatically increases the probability that any 3-node loss makes some range unavailable.
8. ⚠️ Forgetting `withLocalDatacenter()` / `local_dc` in the driver → ✅ Without it, the driver may pick a remote-DC coordinator and every request pays WAN RTT. Driver 4.x refuses to start without it precisely because of this bug class.
9. ⚠️ Assuming `Owns` in `nodetool status` is meaningful without a keyspace → ✅ Always run `nodetool status <keyspace>`; the bare form shows raw token ownership that ignores RF.
10. ⚠️ Adding one node to fix a hot rack → ✅ Add nodes one per rack (or a full rack at a time) so NTS balance is preserved; otherwise you skew load further.

## 8. Production: Debugging, Monitoring, Security & Scaling

### Debugging
- `nodetool getendpoints <ks> <table> <pk>` is ground truth for "where does this row live?" Run it whenever a read returns unexpected data.
- `nodetool describecluster` shows schema version across nodes — a split version after a keyspace ALTER means gossip has not converged and placement is temporarily inconsistent.
- `nodetool gossipinfo | grep -E 'DC|RACK'` shows what each node *believes* about its peers; `DC:UNKNOWN` means `cassandra-rackdc.properties` was missing at startup.
- `TRACING ON` in cqlsh (or `trace=True` in the driver) reveals the exact replica set contacted and per-hop latency.

### Monitoring
- `org.apache.cassandra.metrics:type=ClientRequest,scope=Write,name=Latency` and `scope=Read` — p99 per DC.
- `type=ClientRequest,scope=Write,name=Unavailables` — spikes here mean you cannot reach `RF/2+1` replicas; correlate with rack outages.
- `type=Storage,name=TotalHints` and `name=HintsSucceeded` — a rising hint backlog means a replica is down or slow.
- `type=DynamicEndpointSnitch,name=Severity` — how badly the local node is scored; sustained high severity = compaction or GC pressure.
- Alert on `nodetool status` ownership drifting more than 10% between nodes in the same rack.

### Security
- Replication happens over `storage_port` (7000) or `ssl_storage_port` (7001). In a multi-DC cluster set `server_encryption_options.internode_encryption: dc` at minimum — that encrypts the WAN hop while leaving intra-DC traffic in the clear for performance.
- `system_auth` must use `NetworkTopologyStrategy` with RF equal to the node count (up to 3–5 per DC) and be read at `LOCAL_QUORUM`; if the auth keyspace is under-replicated a single node loss locks everyone out.
- Never expose ports 7000/7001/7199 outside the VPC; snitch/gossip traffic is unauthenticated at the transport level unless internode encryption and `require_client_auth` are on.

### Performance & Scaling
- Scale by adding one node per rack at a time; that keeps NTS balanced and lets you stop safely at any point.
- Adding a datacenter is the standard mechanism for cloud migration, a major-version upgrade with rollback, or an analytics split (`{'prod':3,'analytics':1}` read at `LOCAL_ONE`).
- Raising RF 3→5 requires ALTER, then `nodetool repair -full` on every node, and only then a consistency-level increase. Reads between the ALTER and the repair can return missing data.
- `stream_throughput_outbound` (default 200 Mb/s) governs `rebuild`/`bootstrap` speed; raise it on 10 GbE, lower it if bootstrap starves client traffic.

## 9. Interview Questions

**Q: What is the difference between SimpleStrategy and NetworkTopologyStrategy?**
A: `SimpleStrategy` walks the ring clockwise from the token and takes the next RF distinct nodes with no knowledge of datacenters or racks. `NetworkTopologyStrategy` accepts a replication factor per named datacenter and, within each, places replicas in distinct racks. Only NTS survives a rack or AZ failure predictably, and only NTS supports multi-DC, so production keyspaces should always use it.

**Q: What does a snitch actually do?**
A: It maps every node's address to a `(datacenter, rack)` pair so the replication strategy can place replicas in distinct failure domains, and it defines relative network proximity so the coordinator can order replicas by closeness when routing reads. It does not move data; it only supplies topology information that other components act on.

**Q: Why is GossipingPropertyFileSnitch usually recommended over PropertyFileSnitch?**
A: `PropertyFileSnitch` requires an identical `cassandra-topology.properties` listing every node on every node, so adding a node means editing and redistributing a file cluster-wide. GPFS has each node declare only its own DC and rack in `cassandra-rackdc.properties` and gossips it, so the cluster self-describes and there is no fan-out file to keep in sync.

**Q: How is QUORUM computed with RF=3 in each of two datacenters?**
A: Global `QUORUM` uses the sum of all replication factors: `floor(6/2)+1 = 4`, which necessarily crosses the WAN. `LOCAL_QUORUM` uses only the local DC's RF: `floor(3/2)+1 = 2`. Almost all production traffic should use `LOCAL_QUORUM`.

**Q: What happens if you set RF higher than the number of nodes in a datacenter?**
A: The DDL succeeds — Cassandra does not validate RF against live node count at schema time. Every write then fails with `UnavailableException` because the required number of natural replicas does not exist. You have to lower RF or add nodes.

**Q: If a partition needs 3 replicas but a DC only has 2 racks, where do they go?**
A: NTS walks the ring, takes one node from rack A, one from rack B, and then, having exhausted distinct racks, accepts a second node from whichever rack comes next. So you get a 2/1 split. Losing the rack holding two replicas leaves only one, which is below `LOCAL_QUORUM`, so that rack becomes a single point of failure for quorum operations.

**Q: What is the dynamic snitch and when would you disable it?**
A: It wraps your configured snitch and reorders replicas by recent read latency, bypassing the preferred replica when another is faster by more than `dynamic_snitch_badness_threshold` (10%). You might disable it when your workload is uniform and the reordering causes cache thrash, or when you rely strictly on token-aware routing hitting the same replica for row-cache locality.

**Q: (Senior) Walk me through safely changing the snitch on a live 60-node cluster.**
A: Determine whether the DC/rack names produced by the new snitch match the old ones. If they are identical, it is a rolling restart with no data movement. If they differ, replica sets change and data is effectively orphaned — the safe path is not an in-place change at all: stand up a new logical datacenter with the new snitch, `ALTER KEYSPACE` to replicate into it, `nodetool rebuild` from the old DC, cut clients over with a new `local_dc`, then decommission the old DC. In-place changes require a cluster-wide `repair -full` and a window of unavailable data.

**Q: (Senior) Why are 16 vnodes preferred over 256 in Cassandra 4.x, and what breaks with 256?**
A: Availability and repair cost. With `num_tokens: 256` each node participates in hundreds of token ranges, so almost any random 3-node failure with RF=3 will fully own at least one range — the probability of a quorum-unavailable range approaches 1 as vnodes grow. Repair also splits per range, so 256 vnodes means 16× more repair sessions, Merkle trees, and streaming overhead. 16 vnodes plus `allocate_tokens_for_local_replication_factor` gives near-even distribution with far better failure and repair characteristics.

**Q: (Senior) How would you use replication strategy to isolate an analytics workload from OLTP?**
A: Add a logical datacenter — say `analytics` — running the same Cassandra version but sized for scan throughput, and set `{'NetworkTopologyStrategy', 'prod': 3, 'analytics': 1}`. Spark or Trino connects with `local_dc=analytics` and reads at `LOCAL_ONE`, so full-table scans never touch a prod replica, never pollute prod page cache, and never contend for prod compaction throughput. RF=1 in analytics is acceptable because it is a derived, rebuildable copy; a node loss there is fixed with `nodetool rebuild`.

**Q: What is `nodetool rebuild` and when is it required?**
A: It streams all data a node should own, from a specified source datacenter, without changing token ownership. It is required after adding a new datacenter and extending the keyspace replication — the ALTER changes intent, `rebuild` moves the bytes. Skipping it means `LOCAL_QUORUM` reads in the new DC silently return empty results.

**Q: Why does `nodetool status` show different `Owns` values with and without a keyspace argument?**
A: Without a keyspace it reports raw token-range ownership, which ignores replication entirely. With a keyspace it reports *effective* ownership — the fraction of data each node actually stores given that keyspace's strategy and RF — so with RF=3 in a 6-node DC each node shows about 50%, not about 17%.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Murmur3 hashes the partition key to a 64-bit token; the replication strategy turns that token into a replica set. Always use `NetworkTopologyStrategy` with a per-DC RF, because it places one replica per rack and therefore survives an AZ failure at RF=3 across 3 racks. The snitch supplies the DC/rack map — `GossipingPropertyFileSnitch` reads `cassandra-rackdc.properties` locally and gossips it, cloud snitches derive it from instance metadata, and the dynamic snitch layer reorders replicas by observed latency. `LOCAL_QUORUM = floor(RF_local/2)+1` keeps traffic on the LAN and gives strong consistency inside a DC when `R + W > RF`. Adding a DC is always `ALTER KEYSPACE` **plus** `nodetool rebuild`; changing a snitch on a live cluster is a data migration, not a config change.

| Item | Value / Command |
| --- | --- |
| Default partitioner | `Murmur3Partitioner`, tokens in `[-2^63, 2^63-1]` |
| Default `num_tokens` (4.x) | `16` |
| Recommended snitch | `GossipingPropertyFileSnitch` |
| Topology file | `conf/cassandra-rackdc.properties` (`dc=`, `rack=`, `prefer_local=`) |
| Prod strategy | `{'class':'NetworkTopologyStrategy','dc1':3,'dc2':3}` |
| `LOCAL_QUORUM` with RF=3 | 2 replicas |
| Global `QUORUM` with 3+3 | 4 replicas (crosses WAN) |
| Where does key K live? | `nodetool getendpoints ks tbl 'K'` |
| Effective ownership | `nodetool status <keyspace>` |
| After adding a DC | `nodetool rebuild -- <source_dc>` |
| Dynamic snitch threshold | `dynamic_snitch_badness_threshold: 0.1` |
| Internode ports | 7000 plaintext / 7001 TLS / 7199 JMX |

Flash cards:
- **Why never SimpleStrategy in prod?** → It ignores racks and datacenters, so all RF copies can land in one failure domain and it cannot express multi-DC.
- **How many racks for RF=3?** → Exactly 3 (or a multiple), with equal node counts, so NTS places one replica per rack.
- **What does the snitch NOT do?** → It never moves data; it only reports DC/rack and proximity that the strategy and coordinator consume.
- **`ALTER KEYSPACE` to add a DC — what's missing?** → `nodetool rebuild -- <source_dc>` on every node of the new DC; without it the new DC serves empty reads.
- **`QUORUM` vs `LOCAL_QUORUM` in 3+3?** → 4 replicas across the WAN vs 2 replicas on the LAN.

## 11. Hands-On Exercises & Mini Project

- [ ] Start a 6-node cluster with `ccm create demo -v 4.1.3 -n 6 -s`, assign `rack1/rack2/rack3` in each node's `cassandra-rackdc.properties`, and confirm the layout with `nodetool status`.
- [ ] Create one keyspace with `SimpleStrategy` RF=3 and one with NTS RF=3, insert the same key into both, and compare `nodetool getendpoints` — show only NTS spreads across racks.
- [ ] Stop all nodes in `rack3`, then run a `LOCAL_QUORUM` read against both keyspaces. Record which succeeds and explain why using the NTS walk.
- [ ] With `TRACING ON`, issue a `LOCAL_QUORUM` write and identify from the trace which replicas were contacted and how long the slowest took.
- [ ] Set `dynamic_snitch: false`, replay a `cassandra-stress` read workload, and compare p99 against the dynamic-snitch-enabled run.

### Mini Project — Multi-DC failover drill

**Goal.** Build a two-datacenter cluster and prove that a full DC loss is survivable with zero data loss and a measured RTO.

**Requirements.**
1. Provision `dc_east` (3 nodes, 3 racks) and `dc_west` (3 nodes, 3 racks) with `GossipingPropertyFileSnitch`.
2. Create `orders` with `{'NetworkTopologyStrategy','dc_east':3,'dc_west':3}` and an `orders_by_customer` table partitioned by `customer_id`.
3. Write 1 M rows at `LOCAL_QUORUM` from a Python client pinned to `dc_east` via `TokenAwarePolicy(DCAwareRoundRobinPolicy('dc_east'))`.
4. Kill all of `dc_east` mid-write, repoint the client to `local_dc='dc_west'`, resume, and measure how many seconds of writes were lost.
5. Restart `dc_east`, run `nodetool repair -pr` everywhere, and verify row counts converge across both DCs.

**Extensions.**
- Repeat step 4 using global `QUORUM` and document how the behaviour differs (hint: it does not survive at all).
- Add an `analytics` DC at RF=1, run a full-table scan there, and measure p99 on `dc_east` to prove workload isolation.
- Script the drill in CI against ccm and fail the build if RTO exceeds 60 seconds.

## 12. Related Topics & Free Learning Resources

Pairs directly with **Gossip & Failure Detection** (how the snitch's DC/rack values actually propagate), **The Write Path** (what a replica does once the coordinator reaches it), **Consistency Levels & Tunable Consistency** (the `R + W > RF` companion), and **Repair & Anti-Entropy** (how divergent replicas reconverge).

- **Data Replication — Apache Cassandra Documentation** — Apache Software Foundation · *Beginner* · The authoritative description of NTS's rack-walking algorithm and per-DC RF semantics. <https://cassandra.apache.org/doc/latest/cassandra/architecture/dynamo.html>
- **Snitches — Apache Cassandra Documentation** — Apache Software Foundation · *Intermediate* · Full list of shipped snitches with the exact config keys each one reads. <https://cassandra.apache.org/doc/latest/cassandra/architecture/snitch.html>
- **Cassandra: A Decentralized Structured Storage System** — Lakshman & Malik (Facebook) · *Advanced* · The original paper; section 5.2 explains rack-aware and datacenter-aware replication as originally designed. <https://www.cs.cornell.edu/projects/ladis2009/papers/lakshman-ladis2009.pdf>
- **Multi-DC and Rack Awareness Best Practices** — The Last Pickle · *Advanced* · Field-tested guidance on rack balance, adding datacenters, and the traps in snitch changes. <https://thelastpickle.com/blog/2019/02/26/data-center-switch.html>
- **How Discord Stores Billions of Messages** — Discord Engineering · *Intermediate* · A real production account of RF=3 across AZs, `LOCAL_QUORUM`, and what actually broke. <https://discord.com/blog/how-discord-stores-billions-of-messages>
- **CASSANDRA-13701: Lower default num_tokens** — Apache JIRA · *Advanced* · The discussion and simulations behind moving from 256 to 16 vnodes, including availability math. <https://issues.apache.org/jira/browse/CASSANDRA-13701>
- **DataStax Docs: Configuring Replication** — DataStax · *Beginner* · Clear worked examples of per-DC RF and the DDL for adding a datacenter. <https://docs.datastax.com/en/cassandra-oss/3.x/cassandra/architecture/archDataDistributeReplication.html>
- **Consistent Hashing and Data Distribution** — ScyllaDB University · *Beginner* · Free interactive course covering token rings and replica placement, useful as a second explanation of the same model. <https://university.scylladb.com/courses/scylla-essentials-overview/lessons/high-availability/>

---

*Apache Cassandra Handbook — chapter 19.*
