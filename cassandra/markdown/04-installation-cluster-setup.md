# 04 · Installation & Cluster Setup

> **In one line:** Installing Cassandra is trivial; building a *correct* cluster is about four files — `cassandra.yaml`, `cassandra-rackdc.properties`, `jvm-server.options`, and your OS limits — plus one rule: bootstrap nodes one at a time.

---

## 1. Overview

Cassandra ships as a single Java process with no external dependencies — no ZooKeeper, no config server, no shared filesystem. You unpack a tarball (or install a package, or run a container), edit a handful of YAML keys, start the JVM, and the node gossips its way into a ring. That simplicity is a direct consequence of the masterless design: there is nothing to elect, nothing to register with, and no bootstrap ordering beyond "contact a seed".

The problem this chapter solves is the gap between *running* Cassandra and running it *correctly*. A default single-node install will happily accept writes with `SimpleStrategy`, `RF=1`, `AllowAllAuthenticator`, `SimpleSnitch`, the JVM's default heap, and `listen_address: localhost` — a configuration that is fine for a laptop and catastrophic in production. Almost every "Cassandra is unstable" story traces back to a handful of setup mistakes: wrong snitch so replicas land in one rack, seeds pointing at themselves, mismatched `cluster_name`, unsynchronised clocks, or `ulimit` defaults that starve the process of file descriptors.

Historically this was much harder. Pre-2.0 you hand-assigned `initial_token` values per node and recalculated them every time the cluster grew. Vnodes (1.2) removed that chore, and Cassandra 4.0 both reduced the vnode default to 16 and added a token allocation algorithm that keeps ownership even without manual math. Cassandra 4.1 reorganised `cassandra.yaml` to use human-readable durations and data sizes (`10000ms`, `64MiB/s`) instead of the old `_in_ms` / `_in_mb` suffixes — so config snippets you find online may use either form.

A concrete picture of what "correct" looks like: a production cluster at a mid-size company might be 12 nodes across three AWS availability zones in `us-east-1` and 12 more in `eu-west-1`. Each node is an `i4i.2xlarge` with local NVMe, 8 vCPU, 64 GB RAM, a 16 GB heap under G1GC, `num_tokens: 16`, `GossipingPropertyFileSnitch` mapping each AZ to a rack, three seeds per datacenter, internode TLS on, `PasswordAuthenticator` on, and chrony keeping clocks within a millisecond. Every keyspace uses `NetworkTopologyStrategy {us-east: 3, eu-west: 3}`. Nothing exotic — just every default that matters, changed deliberately.

## 2. Core Concepts

- **`cassandra.yaml`** — the main configuration file (`/etc/cassandra/` for packages, `conf/` for tarballs). Everything about identity, storage, timeouts, and security lives here.
- **`cluster_name`** — the shared string that defines cluster membership. A node with a different `cluster_name` is rejected at gossip time with a clear error. It is baked into `system.local` at first start and painful to change afterwards.
- **Seed node** — a contact point listed in `seed_provider` that a starting node gossips with to learn the ring. Seeds are *not* masters and hold no special data; they simply skip the bootstrap streaming step, which is why a joining node must never list itself.
- **`listen_address` / `broadcast_address`** — the interface used for internode traffic (port 7000) and the address advertised to peers. In cloud/NAT setups these differ.
- **`rpc_address` / `native_transport_port`** — the client-facing bind address and port (9042).
- **Snitch** — the topology oracle. `SimpleSnitch` (single DC only), `GossipingPropertyFileSnitch` (reads `cassandra-rackdc.properties`, gossips it — the production default), `Ec2Snitch`/`Ec2MultiRegionSnitch`, `GoogleCloudSnitch`.
- **`num_tokens`** — how many vnode token ranges this node claims. Default 16 in 4.x/5.0; fixed at bootstrap and not changeable later.
- **`auto_bootstrap`** — whether a joining node streams its ranges from existing replicas. `true` (default) for normal growth; `false` when seeding an entirely new datacenter you will `rebuild` afterwards.
- **`cqlsh`** — the Python CQL shell bundled with Cassandra; connects over the native protocol on 9042.
- **`nodetool`** — the JMX admin CLI (port 7199): `status`, `info`, `ring`, `netstats`, `repair`, `cleanup`, `drain`, `decommission`.
- **Commitlog / data / hints directories** — put the commit log on a separate device from data if you use spinning disks; on NVMe a single fast volume is fine.

## 3. Theory & Internals

### What actually happens on first start

1. The node reads `cassandra.yaml` and `cassandra-rackdc.properties`, validates them, and initialises the JVM heap per `jvm-server.options`. An empty `system.local` in `data_file_directories` means first boot.
2. It generates `num_tokens` tokens — random, or (with `allocate_tokens_for_local_replication_factor: 3`) chosen to minimise ownership imbalance for RF=3.
3. It contacts the seeds and gossips until it has the full ring view, then enters `JOINING`.
4. If `auto_bootstrap: true` and the cluster is non-empty, it **streams** its new ranges from the current owners. `nodetool netstats` shows progress; this is the slow part (hours for terabytes).
5. On completion it flips to `NORMAL` and serves traffic. The former owners still hold the data they gave away, so `nodetool cleanup` on those nodes reclaims the space.

### Token allocation math

With random tokens and `num_tokens: N` on `M` nodes, ownership variance shrinks as `N` grows — which is why 3.x used 256. But the number of distinct replica sets also grows as roughly `M × N`, and the probability that *some* replica set loses quorum when any RF nodes fail approaches 1. Cassandra 4.0's answer is `num_tokens: 16` **plus** the allocation algorithm:

```
allocate_tokens_for_local_replication_factor: 3
```

This runs a greedy optimisation against the existing ring so each new node's 16 tokens land where they most reduce imbalance. Empirically it holds ownership within ~1–2% of even at 16 tokens, versus ~5–10% for random tokens at 16 and ~1% for random at 256 — you get 256-token balance with 16-token availability.

### Sizing rules that matter

```
Heap:            8–16 GB with G1GC (never above 31 GB — compressed oops boundary)
Page cache:      leave 50%+ of RAM free; Cassandra relies on it heavily
Data per node:   1–2 TB (bootstrap/repair time scales with this)
Nodes per DC:    ≥ RF, and ideally ≥ 3 racks so NTS can spread replicas
Seeds per DC:    2–3 (more adds gossip noise, fewer risks a bootstrap dead end)
File descriptors: ≥ 100000 (SSTables × 5 files each adds up fast)
```

`NetworkTopologyStrategy` places replicas by walking the ring clockwise and skipping nodes whose rack is already used, until RF replicas are found. So with RF=3 and only 2 racks, one rack gets 2 replicas — losing that rack costs you quorum. **Racks should be a multiple of RF, or equal to it.**

```svg
<svg viewBox="0 0 790 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="c4a" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#4f46e5"/></marker>
  </defs>
  <text x="395" y="20" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Node bootstrap: from cassandra.yaml to NORMAL</text>
  <rect x="20" y="42" width="140" height="66" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="90" y="64" text-anchor="middle" fill="#1e293b" font-weight="bold">1. Read config</text>
  <text x="90" y="82" text-anchor="middle" fill="#1e293b" font-size="10">cassandra.yaml</text>
  <text x="90" y="97" text-anchor="middle" fill="#1e293b" font-size="10">rackdc + jvm options</text>
  <rect x="190" y="42" width="140" height="66" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="260" y="64" text-anchor="middle" fill="#1e293b" font-weight="bold">2. Contact seeds</text>
  <text x="260" y="82" text-anchor="middle" fill="#1e293b" font-size="10">gossip on port 7000</text>
  <text x="260" y="97" text-anchor="middle" fill="#1e293b" font-size="10">cluster_name must match</text>
  <rect x="360" y="42" width="140" height="66" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="430" y="64" text-anchor="middle" fill="#1e293b" font-weight="bold">3. Claim tokens</text>
  <text x="430" y="82" text-anchor="middle" fill="#1e293b" font-size="10">num_tokens = 16</text>
  <text x="430" y="97" text-anchor="middle" fill="#1e293b" font-size="10">allocate_tokens_for_...</text>
  <rect x="530" y="42" width="140" height="66" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="600" y="64" text-anchor="middle" fill="#1e293b" font-weight="bold">4. JOINING</text>
  <text x="600" y="82" text-anchor="middle" fill="#1e293b" font-size="10">stream ranges from</text>
  <text x="600" y="97" text-anchor="middle" fill="#1e293b" font-size="10">current owners</text>
  <line x1="162" y1="75" x2="186" y2="75" stroke="#4f46e5" stroke-width="2" marker-end="url(#c4a)"/>
  <line x1="332" y1="75" x2="356" y2="75" stroke="#4f46e5" stroke-width="2" marker-end="url(#c4a)"/>
  <line x1="502" y1="75" x2="526" y2="75" stroke="#4f46e5" stroke-width="2" marker-end="url(#c4a)"/>
  <rect x="530" y="130" width="140" height="60" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="600" y="152" text-anchor="middle" fill="#1e293b" font-weight="bold">5. NORMAL (UN)</text>
  <text x="600" y="170" text-anchor="middle" fill="#1e293b" font-size="10">serving reads + writes</text>
  <text x="600" y="185" text-anchor="middle" fill="#1e293b" font-size="10">on port 9042</text>
  <line x1="600" y1="110" x2="600" y2="126" stroke="#4f46e5" stroke-width="2" marker-end="url(#c4a)"/>
  <rect x="20" y="130" width="480" height="60" rx="8" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="35" y="152" fill="#1e293b" font-weight="bold">6. On the donor nodes afterwards</text>
  <text x="35" y="171" fill="#1e293b" font-size="11">nodetool cleanup &#8594; drops ranges they no longer own and reclaims disk</text>
  <text x="35" y="186" fill="#1e293b" font-size="11">run one node at a time; it is a full compaction of every SSTable</text>
  <rect x="20" y="212" width="745" height="115" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="35" y="234" fill="#1e293b" font-weight="bold">Rack placement with NetworkTopologyStrategy (RF=3)</text>
  <rect x="45" y="248" width="200" height="62" rx="6" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="145" y="268" text-anchor="middle" fill="#1e293b" font-size="11">rack1 (AZ-a)</text>
  <text x="145" y="286" text-anchor="middle" fill="#1e293b" font-size="11">node1  node4</text>
  <text x="145" y="302" text-anchor="middle" fill="#1e293b" font-size="10">holds 1 of the 3 replicas</text>
  <rect x="265" y="248" width="200" height="62" rx="6" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="365" y="268" text-anchor="middle" fill="#1e293b" font-size="11">rack2 (AZ-b)</text>
  <text x="365" y="286" text-anchor="middle" fill="#1e293b" font-size="11">node2  node5</text>
  <text x="365" y="302" text-anchor="middle" fill="#1e293b" font-size="10">holds 1 of the 3 replicas</text>
  <rect x="485" y="248" width="200" height="62" rx="6" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="585" y="268" text-anchor="middle" fill="#1e293b" font-size="11">rack3 (AZ-c)</text>
  <text x="585" y="286" text-anchor="middle" fill="#1e293b" font-size="11">node3  node6</text>
  <text x="585" y="302" text-anchor="middle" fill="#1e293b" font-size="10">holds 1 of the 3 replicas</text>
  <text x="700" y="282" fill="#d97706" font-size="11">lose any</text>
  <text x="700" y="297" fill="#d97706" font-size="11">1 rack &#8594; OK</text>
</svg>
```

## 4. Architecture & Workflow

Standing up a real three-node, three-rack cluster from scratch:

1. **Provision and prepare the OS.** Java 11 or 17 (4.1 and 5.0 support both; 5.0 prefers 17). Set `vm.max_map_count=1048575`, disable swap, `ulimit -n 100000`, `ulimit -u 32768`, disable transparent-huge-page defrag, install chrony, and mount data on `xfs`/`ext4` with `noatime`.
2. **Install.** Apache repo (`apt install cassandra` / `dnf install cassandra`) or a tarball. Do **not** start it yet — the package auto-start creates a single-node cluster with the wrong `cluster_name` and you'll have to wipe `data/`.
3. **Configure identity in `cassandra.yaml`.** `cluster_name`, `listen_address`/`broadcast_address`, `rpc_address: 0.0.0.0` with an explicit `broadcast_rpc_address`, `seed_provider`, `endpoint_snitch: GossipingPropertyFileSnitch`, `num_tokens: 16`.
4. **Configure topology and JVM.** `dc=` and `rack=` in `cassandra-rackdc.properties` matching real failure domains (AZ = rack, region = dc); `-Xms16G -Xmx16G` with G1GC and `-XX:MaxGCPauseMillis=300` in `jvm-server.options`.
5. **Start the seeds first, one at a time.** Wait for each to reach `UN` before starting the next. Concurrent bootstraps collide on token ranges and are the classic way to corrupt a fresh ring.
6. **Start the non-seed nodes, one at a time.** Each streams its ranges (`nodetool netstats`); wait for `UN` before the next.
7. **Verify.** `nodetool status` (all `UN`, ownership roughly even), `nodetool describecluster` (exactly one schema version), `nodetool ring | wc -l` (≈ nodes × `num_tokens`).
8. **Secure, create schema, schedule ops.** Enable `PasswordAuthenticator`/`CassandraAuthorizer` with a rolling restart, replace the default superuser, raise `system_auth` RF, create keyspaces with `NetworkTopologyStrategy`, then schedule repair within `gc_grace_seconds`, monitoring, and `nodetool snapshot` backups.

```svg
<svg viewBox="0 0 790 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="c4b" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#0ea5e9"/></marker>
  </defs>
  <text x="395" y="20" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Two-datacenter topology, seeds, and the ports involved</text>
  <rect x="25" y="40" width="345" height="200" rx="10" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="197" y="62" text-anchor="middle" fill="#1e293b" font-size="13" font-weight="bold">dc_east (us-east-1)</text>
  <rect x="45" y="76" width="95" height="66" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="92" y="96" text-anchor="middle" fill="#1e293b" font-size="11">10.0.1.11</text>
  <text x="92" y="112" text-anchor="middle" fill="#1e293b" font-size="10">rack1 &#183; SEED</text>
  <text x="92" y="128" text-anchor="middle" fill="#1e293b" font-size="10">16 tokens</text>
  <rect x="150" y="76" width="95" height="66" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="197" y="96" text-anchor="middle" fill="#1e293b" font-size="11">10.0.1.12</text>
  <text x="197" y="112" text-anchor="middle" fill="#1e293b" font-size="10">rack2 &#183; SEED</text>
  <text x="197" y="128" text-anchor="middle" fill="#1e293b" font-size="10">16 tokens</text>
  <rect x="255" y="76" width="95" height="66" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="302" y="96" text-anchor="middle" fill="#1e293b" font-size="11">10.0.1.13</text>
  <text x="302" y="112" text-anchor="middle" fill="#1e293b" font-size="10">rack3</text>
  <text x="302" y="128" text-anchor="middle" fill="#1e293b" font-size="10">16 tokens</text>
  <text x="197" y="168" text-anchor="middle" fill="#1e293b" font-size="11">RF = 3, one replica per rack</text>
  <text x="197" y="188" text-anchor="middle" fill="#1e293b" font-size="11">clients here use LOCAL_QUORUM</text>
  <text x="197" y="212" text-anchor="middle" fill="#1e293b" font-size="11">2 seeds per DC; a joining node is never its own seed</text>
  <rect x="420" y="40" width="345" height="200" rx="10" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="592" y="62" text-anchor="middle" fill="#1e293b" font-size="13" font-weight="bold">dc_west (eu-west-1)</text>
  <rect x="440" y="76" width="95" height="66" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="487" y="96" text-anchor="middle" fill="#1e293b" font-size="11">10.0.2.11</text>
  <text x="487" y="112" text-anchor="middle" fill="#1e293b" font-size="10">rack1 &#183; SEED</text>
  <text x="487" y="128" text-anchor="middle" fill="#1e293b" font-size="10">16 tokens</text>
  <rect x="545" y="76" width="95" height="66" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="592" y="96" text-anchor="middle" fill="#1e293b" font-size="11">10.0.2.12</text>
  <text x="592" y="112" text-anchor="middle" fill="#1e293b" font-size="10">rack2 &#183; SEED</text>
  <text x="592" y="128" text-anchor="middle" fill="#1e293b" font-size="10">16 tokens</text>
  <rect x="650" y="76" width="95" height="66" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="697" y="96" text-anchor="middle" fill="#1e293b" font-size="11">10.0.2.13</text>
  <text x="697" y="112" text-anchor="middle" fill="#1e293b" font-size="10">rack3</text>
  <text x="697" y="128" text-anchor="middle" fill="#1e293b" font-size="10">16 tokens</text>
  <text x="592" y="168" text-anchor="middle" fill="#1e293b" font-size="11">added with auto_bootstrap: false, then nodetool rebuild</text>
  <text x="592" y="188" text-anchor="middle" fill="#1e293b" font-size="11">seed list includes seeds from BOTH DCs</text>
  <text x="592" y="212" text-anchor="middle" fill="#1e293b" font-size="11">gossip 7000 &#183; TLS 7001 &#183; CQL 9042 &#183; JMX 7199</text>
  <line x1="372" y1="140" x2="416" y2="140" stroke="#0ea5e9" stroke-width="3" marker-end="url(#c4b)"/>
  <line x1="416" y1="155" x2="372" y2="155" stroke="#0ea5e9" stroke-width="3" marker-end="url(#c4b)"/>
  <text x="394" y="180" text-anchor="middle" fill="#1e293b" font-size="10">async</text>
  <rect x="25" y="258" width="740" height="88" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="40" y="280" fill="#1e293b" font-weight="bold">CREATE KEYSPACE app WITH replication = {</text>
  <text x="40" y="299" fill="#1e293b">&#160;&#160;'class': 'NetworkTopologyStrategy', 'dc_east': 3, 'dc_west': 3 };</text>
  <text x="40" y="322" fill="#1e293b" font-size="11">6 total copies &#183; survives a full DC loss &#183; LOCAL_QUORUM = 2 acks inside one DC</text>
  <text x="40" y="338" fill="#1e293b" font-size="11">never SimpleStrategy in production: it ignores racks and datacenters entirely</text>
</svg>
```

## 5. Implementation

### Fastest path: Docker Compose, 3 nodes

```yaml
# docker-compose.yml — nodes start serially via healthcheck-gated depends_on
x-cass-env: &env
  { CASSANDRA_CLUSTER_NAME: zariya-lab, CASSANDRA_SEEDS: cass1,
    CASSANDRA_ENDPOINT_SNITCH: GossipingPropertyFileSnitch,
    CASSANDRA_DC: dc1, MAX_HEAP_SIZE: 2G, HEAP_NEWSIZE: 400M }
x-cass-health: &health
  { test: ["CMD-SHELL", "nodetool status | grep -q '^UN'"], interval: 15s, retries: 20 }
services:
  cass1:
    image: cassandra:5.0
    environment: { <<: *env, CASSANDRA_RACK: rack1 }
    ports: ["9042:9042"]
    healthcheck: *health
  cass2:
    image: cassandra:5.0
    environment: { <<: *env, CASSANDRA_RACK: rack2 }
    healthcheck: *health
    depends_on: { cass1: { condition: service_healthy } }
  cass3:
    image: cassandra:5.0
    environment: { <<: *env, CASSANDRA_RACK: rack3 }
    depends_on: { cass2: { condition: service_healthy } }
```

```bash
docker compose up -d && docker exec cass1 nodetool status
# Datacenter: dc1
# Status=Up/Down |/ State=Normal/Leaving/Joining/Moving
# --  Address     Load       Tokens  Owns (effective)  Host ID       Rack
# UN  172.20.0.2  248.1 KiB  16      68.9%             3f0e1a5c-...  rack1
# UN  172.20.0.3  212.4 KiB  16      65.3%             a1b2c3d4-...  rack2
# UN  172.20.0.4  197.8 KiB  16      65.8%             9e8d7c6b-...  rack3

docker exec cass1 nodetool describecluster
#   Name: zariya-lab
#   Snitch: org.apache.cassandra.locator.GossipingPropertyFileSnitch
#   Partitioner: org.apache.cassandra.dht.Murmur3Partitioner
#   Schema versions:
#     e2f1a9c0-...: [172.20.0.2, 172.20.0.3, 172.20.0.4]   ONE version = healthy
```

### Bare-metal / VM install

```bash
# Debian/Ubuntu — Apache repo (5.0 series)
echo "deb [signed-by=/etc/apt/keyrings/apache-cassandra.asc] \
  https://debian.cassandra.apache.org 50x main" | sudo tee /etc/apt/sources.list.d/cassandra.sources.list
curl -fsSL https://downloads.apache.org/cassandra/KEYS | sudo tee /etc/apt/keyrings/apache-cassandra.asc >/dev/null
sudo apt update && sudo apt install -y cassandra

# The package starts a single-node cluster immediately. Stop and wipe before configuring.
sudo systemctl stop cassandra
sudo rm -rf /var/lib/cassandra/{data/system,commitlog,saved_caches}/*

# OS prerequisites (persist in /etc/security/limits.d/ and /etc/sysctl.d/)
sudo sysctl -w vm.max_map_count=1048575 -w vm.swappiness=1 && sudo swapoff -a
ulimit -n 100000
sudo timedatectl set-ntp true && chronyc tracking   # clock skew = silent data loss
```

```yaml
# /etc/cassandra/cassandra.yaml — the keys that actually matter
cluster_name: 'zariya-prod'
num_tokens: 16
allocate_tokens_for_local_replication_factor: 3

seed_provider:
  - class_name: org.apache.cassandra.locator.SimpleSeedProvider
    parameters:
      - seeds: "10.0.1.11:7000,10.0.1.12:7000,10.0.2.11:7000,10.0.2.12:7000"

listen_address: 10.0.1.13          # internode bind (port 7000)
broadcast_address: 10.0.1.13       # what peers are told; differs under NAT
rpc_address: 0.0.0.0               # client bind (port 9042)
broadcast_rpc_address: 10.0.1.13   # required when rpc_address is 0.0.0.0

endpoint_snitch: GossipingPropertyFileSnitch
auto_bootstrap: true

data_file_directories: [/var/lib/cassandra/data]
commitlog_directory: /var/lib/cassandra/commitlog
hints_directory: /var/lib/cassandra/hints
commitlog_sync: periodic
commitlog_sync_period: 10000ms
compaction_throughput: 64MiB/s

authenticator: PasswordAuthenticator      # default AllowAllAuthenticator = open
authorizer: CassandraAuthorizer
role_manager: CassandraRoleManager

server_encryption_options:
  internode_encryption: all
  keystore: /etc/cassandra/conf/server-keystore.jks
  keystore_password: CHANGE_ME
  truststore: /etc/cassandra/conf/server-truststore.jks
  truststore_password: CHANGE_ME
client_encryption_options: { enabled: true, optional: false,
  keystore: /etc/cassandra/conf/client-keystore.jks, keystore_password: CHANGE_ME }
```

```properties
# /etc/cassandra/cassandra-rackdc.properties — one per node; AZ maps to rack
dc=dc_east
rack=rack3
```

```bash
# jvm-server.options / jvm17-server.options — equal min/max avoids resize pauses
# -Xms16G  -Xmx16G  -XX:+UseG1GC  -XX:MaxGCPauseMillis=300  -XX:+AlwaysPreTouch

sudo systemctl start cassandra
tail -f /var/log/cassandra/system.log | grep -E "JOINING|state jump to NORMAL"
# INFO  [main] Node /10.0.1.13:7000 state jump to NORMAL

cqlsh 10.0.1.11 9042 -u cassandra -p cassandra
```

### First schema, and fixing the insecure defaults

```cql
-- system_auth ships at RF=1: one node down = nobody can log in. Fix it first.
ALTER KEYSPACE system_auth WITH replication =
  {'class': 'NetworkTopologyStrategy', 'dc_east': 3, 'dc_west': 3};

CREATE ROLE app_admin WITH PASSWORD='strong-random-secret' AND LOGIN=true AND SUPERUSER=true;
-- log back in as app_admin, then demote the well-known default account:
ALTER ROLE cassandra WITH PASSWORD='another-long-random-string' AND SUPERUSER=false;

CREATE KEYSPACE app WITH replication =
  {'class': 'NetworkTopologyStrategy', 'dc_east': 3, 'dc_west': 3};
CREATE ROLE app_service WITH PASSWORD='svc-secret' AND LOGIN=true;
GRANT SELECT, MODIFY ON KEYSPACE app TO app_service;   -- no DDL for the app role

SELECT cluster_name, release_version, partitioner FROM system.local;
--   zariya-prod | 5.0.2 | org.apache.cassandra.dht.Murmur3Partitioner
```

```python
from cassandra.cluster import Cluster
from cassandra.auth import PlainTextAuthProvider
auth = PlainTextAuthProvider(username="app_service", password="svc-secret")
session = Cluster(["10.0.1.11", "10.0.1.12"], auth_provider=auth).connect("app")
print(session.execute("SELECT release_version FROM system.local").one()[0])  # 5.0.2
```

> **Optimization:** when adding a whole new datacenter, do **not** let the new nodes bootstrap normally — with `auto_bootstrap: true` each node streams from a random source and you get uncontrolled cross-WAN traffic. Instead start them with `auto_bootstrap: false` (they join empty and instantly), `ALTER KEYSPACE` to add the new DC's RF, then run `nodetool rebuild -- dc_east` on each new node — serially, with `nodetool setstreamthroughput 200` to cap bandwidth. You control the source DC, the concurrency, and the bandwidth, and clients in the old DC never see a latency blip.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| No external dependencies | One JVM per node; no ZooKeeper, no config server, no shared storage | All coordination is gossip-based, so topology mistakes are silent until failure |
| Docker / ccm for dev | A 3-node cluster in two minutes; identical config surface to prod | Container defaults (tiny heap, `SimpleSnitch`) hide production problems |
| Symmetric nodes | Any node can be replaced by any other; trivial rolling restarts | No cheap read-replica tier — every node needs full capacity |
| Vnodes (`num_tokens`) | Automatic, even token distribution; parallel bootstrap streaming | Fixed at bootstrap; changing it means replacing every node |
| `auto_bootstrap` streaming | New node fills itself with no manual data movement | Hours for terabytes; `nodetool cleanup` afterwards is a full rewrite |
| Package install | systemd unit, log rotation, standard paths | Auto-starts with wrong config — you must stop and wipe before configuring |
| Multi-DC by config | Adding a region is a keyspace `ALTER` plus `rebuild` | Cross-WAN streaming needs throttling; RF changes momentarily disturb quorums |
| Defaults | Sensible for a laptop | Insecure and single-DC for production: auth off, `SimpleSnitch`, `system_auth` RF=1 |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Starting all nodes at once on a fresh cluster.** → ✅ Start seeds one at a time, wait for `UN`, then the rest one at a time. Concurrent bootstraps collide on token ranges and can require wiping the cluster.
2. ⚠️ **Listing a node as a seed in its own `seed_provider` while it bootstraps.** → ✅ Seeds skip bootstrap streaming, so the node joins with no data and silently owns empty ranges. Bootstrap it as a non-seed, then optionally add it to the seed list afterwards.
3. ⚠️ **Mismatched `cluster_name`.** → ✅ It is written into `system.local` at first start; a mismatch means the node is rejected. Fix the YAML *before* first start, or wipe `data/system`.
4. ⚠️ **Leaving `endpoint_snitch: SimpleSnitch` in a multi-rack deploy.** → ✅ `SimpleSnitch` reports every node as `datacenter1/rack1`, so `NetworkTopologyStrategy` cannot spread replicas and one AZ failure takes out all three copies. Use `GossipingPropertyFileSnitch`.
5. ⚠️ **`SimpleStrategy` or `RF=1` keyspaces.** → ✅ Always `NetworkTopologyStrategy` with explicit per-DC RF. Check `system_auth`, `system_distributed`, and `system_traces` too — their defaults are RF=1.
6. ⚠️ **Leaving the default `cassandra/cassandra` superuser and `AllowAllAuthenticator`.** → ✅ Enable `PasswordAuthenticator` + `CassandraAuthorizer`, create a new superuser, demote the default, and never expose 9042/7000/7199 outside the VPC.
7. ⚠️ **Heap set to 31 GB+ or `-Xms` ≠ `-Xmx`.** → ✅ Stay at 8–16 GB with G1GC and set min = max. Above ~32 GB you lose compressed oops and GC pauses grow; leave the rest of RAM to the page cache.
8. ⚠️ **Default `ulimit -n 1024` and swap enabled.** → ✅ Cassandra opens 5+ files per SSTable; set `nofile 100000`, `nproc 32768`, `memlock unlimited`, and disable swap entirely (a swapped-out node fails health checks but stays "up").
9. ⚠️ **Unsynchronised clocks.** → ✅ Last-write-wins is decided by microsecond timestamps. Run chrony on every node and alert on drift > 50 ms — clock skew produces silent, unrecoverable data loss.
10. ⚠️ **Skipping `nodetool cleanup` after adding nodes.** → ✅ Donors keep the data they no longer own; disk usage never drops and reads scan extra SSTables. Run cleanup on each donor, one at a time, after the new node is `UN`.
11. ⚠️ **`kill -9` instead of a clean shutdown, and never scheduling repair.** → ✅ Use `nodetool drain` then stop the service, so startup has no commit log to replay. And every range must be repaired within `gc_grace_seconds` (864000 = 10 days) or deleted data resurrects — use Cassandra Reaper, or `nodetool repair -pr` staggered across nodes.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Startup failures are almost always in `/var/log/cassandra/system.log` within the first 50 lines: a YAML parse error, a bind failure on 7000/9042, a `cluster_name` mismatch, or "Unable to gossip with any peers" (seeds unreachable or firewalled). A node stuck at `UJ` (joining) is streaming — check `nodetool netstats` for progress and `nodetool describecluster` for schema convergence. `DN` for a node you know is alive usually means gossip is blocked or the node is in a long GC pause; check `nodetool failuredetector` and GC logs. If a decommissioned node lingers as a ghost, `nodetool removenode <host-id>`, and only as a last resort `nodetool assassinate <ip>`. For "I edited the YAML and nothing changed", remember most keys require a restart — a few (`compaction_throughput`, `streamthroughput`, hinted handoff) can be changed live with `nodetool set*` commands.

**Monitoring.** From day one export JMX via the Prometheus JMX exporter (`-javaagent:jmx_prometheus_javaagent.jar=7070:cassandra.yml` in `cassandra-env.sh`). Watch node state (`nodetool status` scraped or `type=Storage,name=Load`), `type=ClientRequest,name=Latency|Timeouts|Unavailables`, `type=Compaction,name=PendingTasks`, `type=ThreadPools,...,name=PendingTasks|CurrentlyBlockedTasks`, `type=CommitLog,name=PendingTasks`, disk free per data directory, and JVM GC pause time. Set an alert on "any node not `UN` for 5 minutes" and on disk usage above 60% — compaction needs headroom equal to the largest SSTable set it will merge, and `SizeTieredCompactionStrategy` can transiently need up to 50% free.

**Security.** Beyond auth and TLS: run Cassandra as a non-root `cassandra` user, keep 7000/7001/7199/9042 inside a private subnet with security groups scoped to the cluster and app tiers, and never leave JMX (7199) unauthenticated on a routable interface — it grants full administrative control. Enable `audit_logging_options` (4.0+) with `included_categories: DDL,DCL,AUTH` at minimum, ship those logs off-box, and rotate them. Use `nodetool snapshot` before every schema change and every upgrade; snapshots are hardlinks so they are instant and cheap until compaction diverges the files.

**Performance & scaling.** Grow the cluster by roughly 20–50% at a time rather than one node at a time when you can, but still bootstrap serially. Keep per-node data at 1–2 TB. Set `stream_throughput_outbound` and `compaction_throughput` to values that leave headroom for client traffic (64 MiB/s compaction is a reasonable start on NVMe). Rolling restarts: `nodetool drain`, restart, wait for `UN` and for pending compactions to settle, then move on — never restart two nodes in the same rack simultaneously. For upgrades, complete the rolling binary upgrade across the whole cluster *before* running `nodetool upgradesstables`, and pause repairs for the duration since streaming is disabled across major versions.

## 9. Interview Questions

**Q: What is a seed node and is it special?**
A: A seed is just an IP listed in `seed_provider` that a starting node gossips with to discover the ring. Seeds hold no special data, take no special role, and losing all of them doesn't stop a running cluster — it only prevents new nodes from joining. The one behavioural difference is that a node listed as a seed skips bootstrap streaming, so a new node must not list itself.

**Q: Which files do you edit to configure a Cassandra node?**
A: `cassandra.yaml` for identity, addresses, seeds, snitch, storage, timeouts, and security; `cassandra-rackdc.properties` for the node's datacenter and rack; `jvm-server.options` (and the version-specific variants) for heap and GC; and `cassandra-env.sh` for JMX and agent settings. OS-level limits in `/etc/security/limits.d` and `sysctl` matter just as much.

**Q: What does the snitch do and which one should you use?**
A: The snitch tells Cassandra which datacenter and rack each node belongs to, so `NetworkTopologyStrategy` can place replicas in different failure domains and coordinators can route to the nearest replica. `GossipingPropertyFileSnitch` is the production default: each node reads its own `cassandra-rackdc.properties` and gossips it, which works on-prem and in every cloud.

**Q: How do you add a node to an existing cluster?**
A: Configure it with the same `cluster_name`, the cluster's seeds, the correct DC/rack, and `auto_bootstrap: true`, then start it — alone. It claims tokens, enters `JOINING`, streams its ranges from the current owners (watch `nodetool netstats`), and flips to `NORMAL`. Afterwards run `nodetool cleanup` on the other nodes to reclaim the ranges they gave away.

**Q: How do you safely remove a node?**
A: If the node is alive, `nodetool decommission` on that node — it streams its ranges to the new owners before leaving. If it is dead, run `nodetool removenode <host-id>` from another node, which makes the remaining replicas stream the missing ranges. `nodetool assassinate` forcibly evicts it from gossip without moving any data and is a last resort.

**Q: Why should you never use `SimpleStrategy` in production?**
A: `SimpleStrategy` walks the ring clockwise placing replicas without any awareness of racks or datacenters, so all RF copies can land in a single AZ or a single region. `NetworkTopologyStrategy` takes an explicit RF per datacenter and skips racks already used, which is what actually gives you fault isolation.

**Q: What is `num_tokens` and can you change it later?**
A: It is the number of vnode token ranges a node claims, defaulting to 16 in Cassandra 4.x and 5.0. It is fixed when the node bootstraps and written into the ring, so changing it on a live node is not supported — you must replace the node (or the whole cluster) to change it.

**Q: (Senior) How do you add a second datacenter to a live cluster without impacting the first?**
A: Start the new nodes with `auto_bootstrap: false` so they join instantly and empty, with seeds from both DCs and the correct `dc`/`rack`. Then `ALTER KEYSPACE` to add the new DC's replication factor, and run `nodetool rebuild -- <source_dc>` on each new node serially, with `nodetool setstreamthroughput` capping bandwidth. Clients must be pinned to `LOCAL_QUORUM` with a DC-aware load-balancing policy throughout, and you should run a full repair after rebuild completes.

**Q: (Senior) A node is stuck in `UJ` for six hours. How do you diagnose it?**
A: Check `nodetool netstats` on the joining node for stream progress and on the sources for stuck sessions; a stalled session usually shows a file at a fixed byte count. Look for `StreamException` or socket timeouts in `system.log`, verify `stream_throughput_outbound` isn't throttling to near zero, and confirm no source node is in a GC death spiral or out of disk. If a stream is genuinely dead, stop the node, wipe its data directories, and restart the bootstrap — resuming with `nodetool bootstrap resume` works only if the stream state survived.

**Q: (Senior) What OS-level settings do you change before running Cassandra in production, and why?**
A: `vm.max_map_count` to ~1048575 (Cassandra memory-maps many SSTable files), `nofile` to 100000+ (5 files per SSTable), `nproc` to 32768, `memlock unlimited`, swap fully disabled and `vm.swappiness=1` (a swapping node stays "up" in gossip while being unusably slow, which is worse than being down), transparent huge page defrag disabled to avoid stalls, `noatime` on the data filesystem, and chrony/NTP because last-write-wins makes clock skew a silent data-loss bug.

**Q: What ports does Cassandra use?**
A: 9042 for the CQL native protocol (client), 7000 for internode gossip and messaging (7001 when internode TLS is enabled), and 7199 for JMX which `nodetool` uses. Only 9042 should be reachable by application servers; 7000/7001/7199 should be restricted to the cluster itself.

**Q: What is `nodetool drain` and when do you use it?**
A: `drain` flushes all memtables to SSTables and stops the node accepting new writes, leaving nothing to replay from the commit log. Run it immediately before any planned stop — a restart, an upgrade, a host maintenance window — so startup is fast and there is no risk of commit log replay problems.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Install from the Apache repo, a tarball, or Docker; then configure four things. In `cassandra.yaml`: `cluster_name`, `seed_provider` (2–3 seeds per DC), `listen_address`/`broadcast_address`/`rpc_address`, `endpoint_snitch: GossipingPropertyFileSnitch`, `num_tokens: 16` with `allocate_tokens_for_local_replication_factor: 3`, and auth/TLS on. In `cassandra-rackdc.properties`: the node's real `dc` and `rack` (region and AZ). In `jvm-server.options`: `-Xms` = `-Xmx` at 8–16 GB with G1GC. At the OS: `nofile 100000`, `vm.max_map_count 1048575`, swap off, chrony running. Start seeds one at a time, then the rest one at a time, waiting for `UN` between each. Verify with `nodetool status` (all `UN`, even ownership) and `nodetool describecluster` (one schema version). Create keyspaces with `NetworkTopologyStrategy` and per-DC RF=3, fix `system_auth` RF, replace the default superuser, and schedule repair within `gc_grace_seconds`.

| Item | Value / Command |
|---|---|
| Ports | 9042 CQL · 7000 internode · 7001 internode TLS · 7199 JMX |
| Config files | `cassandra.yaml`, `cassandra-rackdc.properties`, `jvm-server.options`, `cassandra-env.sh` |
| Production snitch | `GossipingPropertyFileSnitch` |
| `num_tokens` (4.x/5.0) | `16` + `allocate_tokens_for_local_replication_factor: 3` |
| Heap | `-Xms` = `-Xmx`, 8–16 GB, G1GC, never > 31 GB |
| `ulimit -n` / `vm.max_map_count` | `100000` / `1048575` |
| Check cluster | `nodetool status`, `nodetool describecluster` |
| Streaming progress | `nodetool netstats` |
| Add node | `auto_bootstrap: true`, start alone, then `nodetool cleanup` on donors |
| Add datacenter | `auto_bootstrap: false` → `ALTER KEYSPACE` → `nodetool rebuild -- <src_dc>` |
| Remove node (alive/dead) | `nodetool decommission` / `nodetool removenode <host-id>` |
| Clean shutdown | `nodetool drain` then stop the service |
| Data / log paths (package) | `/var/lib/cassandra/{data,commitlog,hints}` · `/var/log/cassandra/` |

**Flash cards**
- **What makes a seed special?** → Nothing, except that it skips bootstrap streaming — so a joining node must never list itself as a seed.
- **Which snitch in production?** → `GossipingPropertyFileSnitch`, with `dc`/`rack` in `cassandra-rackdc.properties` mapping region/AZ.
- **How do you start a fresh cluster?** → Seeds first, one node at a time, waiting for `UN` in `nodetool status` before the next.
- **What must you run after adding a node?** → `nodetool cleanup` on the existing nodes, to drop ranges they no longer own.
- **How do you add a DC without hurting the live one?** → `auto_bootstrap: false`, `ALTER KEYSPACE` to add RF, then serial `nodetool rebuild -- <source_dc>` with throttled stream throughput.

## 11. Hands-On Exercises & Mini Project

- [ ] Bring up a 3-node Docker cluster with distinct racks and confirm `nodetool status` shows three `UN` nodes with ownership within a few percent of 33% each after creating an RF=3 keyspace.
- [ ] Deliberately break it: change `cluster_name` on one node and restart, then find the exact rejection message in `system.log` and fix it by wiping `data/system`.
- [ ] Add a fourth node, watch `nodetool netstats` during bootstrap, then run `nodetool cleanup` on the original three and record the disk space reclaimed with `du -sh` before and after.
- [ ] Decommission a node with `nodetool decommission`, observe the outbound streams, and confirm ownership redistributes; then kill a node with `docker kill` and practice `nodetool removenode <host-id>`.
- [ ] Enable `PasswordAuthenticator` and `CassandraAuthorizer` with a rolling restart, create a least-privilege `app_service` role, and verify that it cannot `DROP` a table while it can `INSERT`.

### Mini Project — "Two-Datacenter Cluster from Scratch"

**Goal.** Build, verify, and operate a 6-node, 2-datacenter cluster locally, exercising every setup step you would perform in production.

**Requirements.**
1. Docker Compose (or Vagrant/ccm) with `dc_east` and `dc_west`, three nodes each on three distinct racks, two seeds per DC, `GossipingPropertyFileSnitch`, `num_tokens: 16`.
2. Bring up `dc_east` first with a real keyspace and 1 million rows loaded via `cassandra-stress`. Then add `dc_west` using the production procedure: `auto_bootstrap: false`, `ALTER KEYSPACE`, serial `nodetool rebuild -- dc_east`.
3. Turn on authentication, authorization, and internode + client TLS with self-signed keystores; prove `cqlsh` fails without `--ssl` and succeeds with it.
4. Write a `verify.sh` that asserts: all nodes `UN`, exactly one schema version, `system_auth` RF matches data keyspaces, no keyspace uses `SimpleStrategy`, and ownership variance under 5%.

**Extensions.**
- Simulate an AZ outage by stopping every node in `rack2` of `dc_east` and prove `LOCAL_QUORUM` still works — then repeat with all nodes mapped to one rack and show it doesn't.
- Add a Prometheus JMX exporter sidecar and build a Grafana panel for pending compactions, dropped mutations, and p99 read latency.
- Perform a rolling restart with `nodetool drain` and measure client error rate during the restart with and without a DC-aware, token-aware driver policy.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *What Is Apache Cassandra?* (why nodes are symmetric), *History & Architecture Overview* (gossip, snitches, and the ring you are configuring), *CAP Theorem & Tunable Consistency* (why RF and rack layout decide your availability), *Keyspaces, Tables & CQL Basics* (the first schema you create on the new cluster), *Primary Key: Partition & Clustering Columns* (what the tokens you just allocated actually index).

- **Apache Cassandra — Installing and Configuring** — Apache Software Foundation · *Beginner* · the canonical install guide plus a fully annotated `cassandra.yaml` reference for the exact version you are running. <https://cassandra.apache.org/doc/latest/cassandra/getting-started/installing.html>
- **Apache Cassandra — Operating: Hardware & Production Recommendations** — Apache Software Foundation · *Intermediate* · official sizing, filesystem, JVM, and OS-tuning guidance; the source for `vm.max_map_count` and ulimit values. <https://cassandra.apache.org/doc/latest/cassandra/managing/operating/hardware.html>
- **Cassandra Cluster Manager (ccm)** — Sylvain Lebresne / Apache · *Beginner* · spin up multi-node, multi-DC clusters on one laptop in seconds; the standard tool for experimenting with topology. <https://github.com/riptano/ccm>
- **The Last Pickle — "Token Allocation Algorithm" and "Adding a Datacenter"** — TLP · *Advanced* · the practical reasoning behind `num_tokens: 16` and a step-by-step DC-addition runbook. <https://thelastpickle.com/blog/>
- **Cassandra Reaper** — Apache Cassandra / TLP · *Intermediate* · the standard open-source tool for scheduling and monitoring repairs; set it up as soon as your cluster is running. <http://cassandra-reaper.io/>
- **Official Cassandra Docker Image Documentation** — Docker Official Images · *Beginner* · documents every `CASSANDRA_*` environment variable and how it maps onto `cassandra.yaml`. <https://hub.docker.com/_/cassandra>
- **K8ssandra — Cassandra on Kubernetes** — DataStax / K8ssandra community · *Intermediate* · free, open-source operator with reference topologies if your target is Kubernetes rather than VMs. <https://k8ssandra.io/>
- **DataStax Academy — Cassandra Operations and Performance Tuning** — DataStax · *Intermediate* · free course covering installation, topology, JVM tuning, and repair scheduling with hands-on labs. <https://www.datastax.com/learn>

---

*Apache Cassandra Handbook — chapter 04.*
