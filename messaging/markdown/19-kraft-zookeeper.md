# 19 · KRaft & the Death of ZooKeeper

> **In one line:** For most of its life Kafka needed a second distributed system — ZooKeeper — to remember who the brokers were and who led each partition, and KRaft replaces it by storing that metadata *as a Kafka log* managed by a Raft controller quorum, which is what lets Kafka scale to millions of partitions, fail over in a blink, and finally ship as a single system.

---

## 1. Overview

A Kafka cluster has to agree on a surprising amount of shared truth: which brokers are alive, which broker leads each partition, what topics and partitions exist, what their configs and ACLs are, and — the linchpin — which single broker is the *controller* that makes leadership decisions. That shared, strongly-consistent metadata cannot live in Kafka's own data path (a partition needs a leader *before* it can store anything), so from its origins until recently Kafka outsourced it to **Apache ZooKeeper**, a separate consensus system. ZooKeeper held the cluster's metadata and coordinated controller election, and Kafka brokers watched it for changes.

That worked, and worked for years, but it was always a wart. You had to deploy, secure, monitor and tune a *second* distributed system with its own failure modes and operational culture just to run Kafka. Worse, the architecture had a scaling ceiling: the controller loaded the entire cluster's metadata from ZooKeeper and pushed changes to brokers one RPC at a time, so the number of partitions a cluster could hold — and how fast it could recover when the controller failed — was bounded by how quickly that ZooKeeper-mediated metadata could be read, propagated and re-synced. Big clusters felt this as slow controller failovers and a hard practical limit of low hundreds of thousands of partitions.

**KRaft** (Kafka Raft, from KIP-500) removes ZooKeeper by having Kafka manage its own metadata *the way it already manages data*: as an ordered, replicated **log**. A small set of nodes form a **controller quorum** running the Raft consensus protocol; they store all cluster metadata in an internal `__cluster_metadata` topic, and the active controller is simply the Raft leader of that quorum. Brokers no longer talk to ZooKeeper or get pushed metadata RPC-by-RPC — they *replicate the metadata log* like any consumer following a topic, applying changes incrementally from their last offset. The results are dramatic: failover becomes near-instant (the new controller already has the metadata log rather than reloading it from ZooKeeper), the partition ceiling rises into the millions, and Kafka becomes a *single* system to operate. ZooKeeper mode is deprecated, and as of **Kafka 4.0 it is removed entirely** — KRaft is the only way to run Kafka.

## 2. Core Concepts

- **ZooKeeper** — the external Apache consensus/coordination service Kafka historically used to store cluster metadata and elect the controller.
- **Metadata** — the cluster's shared truth: broker membership, topic/partition assignments, partition leaders and ISRs, configs, ACLs, and quotas.
- **Controller** — the broker (pre-KRaft) or dedicated node (KRaft) responsible for metadata and for electing partition leaders on broker failure. Exactly one is active at a time.
- **KRaft (Kafka Raft)** — the KIP-500 mechanism that replaces ZooKeeper by storing metadata in a Kafka log managed by a Raft quorum of controllers.
- **Raft** — the consensus algorithm KRaft uses: a leader-based protocol where a quorum (majority) of voters agrees on an ordered log of entries.
- **Controller quorum** — the set of controller nodes that vote in Raft; a majority must agree for a metadata write to commit. Typically 3 or 5 nodes.
- **`__cluster_metadata`** — the internal, single-partition Raft-replicated topic that *is* the metadata log; every metadata change is a record appended to it.
- **Active controller** — the Raft *leader* of the controller quorum; the one node that appends metadata changes. The others are hot standbys with the full log.
- **Voter / observer** — a controller-quorum member that votes in Raft (voter) versus a node (e.g. a broker) that only *follows* the metadata log without voting (observer).
- **`process.roles`** — the per-node config declaring whether it runs as `controller`, `broker`, or `broker,controller` (combined).
- **`controller.quorum.voters`** — the static list of voter nodes (id@host:port) that form the Raft quorum.
- **`kafka-storage.sh format`** — the tool that initialises a node's storage with a cluster id before first start, required in KRaft mode.
- **Metadata snapshot** — a periodic compacted checkpoint of the metadata log so the log does not grow unbounded and a new controller can catch up quickly.

## 3. Theory & Principles

### What ZooKeeper actually did, and why it was a burden

ZooKeeper is a hierarchical, strongly-consistent key-value store with watches — a coordination primitive, not a data store. Kafka used it for four things. First, **broker membership**: each broker registered an ephemeral node in ZooKeeper; when the broker's session expired (it died or partitioned away), the node vanished, and that disappearance is how the cluster learned a broker was gone. Second, **controller election**: brokers raced to create a single ZooKeeper node, and the winner became the controller; if it died, the node's ephemeral nature freed it and the survivors re-raced. Third, **metadata storage**: topics, partitions, their replica assignments and leaders, configs, ACLs and quotas all lived as ZooKeeper nodes. Fourth, **change notification**: brokers set ZooKeeper *watches* so they were told when metadata changed.

The burden was twofold. Operationally, ZooKeeper is a whole second distributed system — its own ensemble to size, its own quorum to keep healthy, its own security model (SASL, ACLs, TLS) to configure, its own JVM to tune, its own metrics to watch, its own upgrade cadence. Teams routinely knew Kafka well and ZooKeeper poorly, and ZooKeeper problems became Kafka outages. Architecturally, the *split brain of truth* was awkward: the controller was a Kafka broker, but the source of truth was ZooKeeper, so the controller had to load metadata from ZooKeeper into memory and then act as an intermediary, pushing updates to the other brokers via `LeaderAndIsr`/`UpdateMetadata` RPCs, one broker at a time.

### The scaling ceiling was real, not cosmetic

The deepest problem was not ZooKeeper's existence but the *propagation model* it forced. When the controller changed — a failover — the new controller had to read the *entire* cluster metadata out of ZooKeeper to rebuild its in-memory picture before it could do anything. For a large cluster with hundreds of thousands of partitions, that cold load took many seconds to minutes, during which leadership decisions stalled: a slow controller failover is a cluster-wide latency event. And on every metadata change, the controller pushed full or large updates to brokers RPC-by-RPC, so the cost of a change scaled with the number of brokers and partitions. Together these capped a ZooKeeper-based cluster at roughly low-hundreds-of-thousands of partitions in practice, and made recovery time grow with cluster size — exactly the wrong direction.

The conceptual fix is elegant: metadata *is* just an ordered sequence of changes, which is precisely what a Kafka log is. If you store metadata as a log, then a change is an *append* (cheap, incremental), a standby controller is a *follower* that already has the log (so failover is instant — no cold reload), and a broker learns of changes by *replicating the log from its last offset* (incremental delta, not a full push). The scaling properties invert: instead of every change costing O(brokers × partitions) in RPCs and failover costing a full reload, changes are appends and failover is "the follower with the log becomes leader". This is the core insight of KIP-500 — apply Kafka's own log-and-replication design to Kafka's metadata.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="k1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
    <marker id="k2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">ZooKeeper-based Kafka vs KRaft</text>

  <rect x="24" y="42" width="410" height="400" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="229" y="64" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Before: Kafka + ZooKeeper</text>

  <rect x="120" y="78" width="220" height="66" rx="8" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="230" y="100" text-anchor="middle" fill="#b91c1c" font-size="11" font-weight="bold">ZooKeeper ensemble</text>
  <text x="230" y="118" text-anchor="middle" fill="#991b1b" font-size="8">(separate system: 3&#8211;5 nodes)</text>
  <text x="230" y="132" text-anchor="middle" fill="#991b1b" font-size="8">metadata + controller election</text>

  <rect x="44" y="176" width="110" height="50" rx="6" fill="#fff" stroke="#dc2626" stroke-width="2"/><text x="99" y="197" text-anchor="middle" fill="#b91c1c" font-size="9" font-weight="bold">broker 1</text><text x="99" y="212" text-anchor="middle" fill="#991b1b" font-size="8">CONTROLLER</text>
  <rect x="174" y="176" width="110" height="50" rx="6" fill="#fff" stroke="#dc2626"/><text x="229" y="197" text-anchor="middle" fill="#b91c1c" font-size="9">broker 2</text>
  <rect x="304" y="176" width="110" height="50" rx="6" fill="#fff" stroke="#dc2626"/><text x="359" y="197" text-anchor="middle" fill="#b91c1c" font-size="9">broker 3</text>

  <path d="M99,176 L180,146" stroke="#dc2626" stroke-width="1.5" marker-end="url(#k1)"/>
  <path d="M229,176 L229,146" stroke="#dc2626" stroke-width="1.5" marker-end="url(#k1)"/>
  <path d="M359,176 L300,146" stroke="#dc2626" stroke-width="1.5" marker-end="url(#k1)"/>
  <text x="60" y="250" fill="#991b1b" font-size="9">controller pushes LeaderAndIsr / UpdateMetadata</text>
  <path d="M154,215 L172,215" stroke="#dc2626" stroke-width="1.5" marker-end="url(#k1)"/>
  <path d="M284,215 L302,215" stroke="#dc2626" stroke-width="1.5" marker-end="url(#k1)"/>
  <text x="60" y="268" fill="#991b1b" font-size="9">RPC-by-RPC to each broker</text>

  <text x="44" y="298" fill="#b91c1c" font-size="10" font-weight="bold">Problems</text>
  <text x="44" y="318" fill="#991b1b" font-size="9">&#8226; a SECOND system to run, secure, tune</text>
  <text x="44" y="338" fill="#991b1b" font-size="9">&#8226; controller failover = COLD reload of all</text>
  <text x="58" y="354" fill="#991b1b" font-size="9">metadata from ZK &#8594; slow (secs&#8211;mins)</text>
  <text x="44" y="374" fill="#991b1b" font-size="9">&#8226; change cost scales with brokers &#215; partitions</text>
  <text x="44" y="394" fill="#991b1b" font-size="9">&#8226; ceiling ~ low 100,000s of partitions</text>
  <text x="44" y="414" fill="#991b1b" font-size="9">&#8226; two sources of truth (ZK vs controller memory)</text>
  <text x="44" y="432" fill="#b91c1c" font-size="9" font-weight="bold">removed entirely in Kafka 4.0</text>

  <rect x="446" y="42" width="410" height="400" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="651" y="64" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">After: KRaft (self-managed)</text>

  <rect x="506" y="78" width="290" height="88" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="651" y="98" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">controller QUORUM (Raft)</text>
  <rect x="520" y="108" width="80" height="46" rx="5" fill="#fff" stroke="#16a34a" stroke-width="2"/><text x="560" y="126" text-anchor="middle" fill="#15803d" font-size="8" font-weight="bold">c1 LEADER</text><text x="560" y="140" text-anchor="middle" fill="#166534" font-size="7">(active ctrl)</text>
  <rect x="612" y="108" width="80" height="46" rx="5" fill="#fff" stroke="#16a34a"/><text x="652" y="126" text-anchor="middle" fill="#15803d" font-size="8">c2 voter</text><text x="652" y="140" text-anchor="middle" fill="#166534" font-size="7">hot standby</text>
  <rect x="704" y="108" width="80" height="46" rx="5" fill="#fff" stroke="#16a34a"/><text x="744" y="126" text-anchor="middle" fill="#15803d" font-size="8">c3 voter</text><text x="744" y="140" text-anchor="middle" fill="#166534" font-size="7">hot standby</text>

  <text x="651" y="186" text-anchor="middle" fill="#15803d" font-size="9" font-weight="bold">__cluster_metadata  (the metadata IS a log)</text>
  <g font-size="8">
    <rect x="520" y="194" width="40" height="20" fill="#dcfce7" stroke="#16a34a"/><text x="540" y="208" text-anchor="middle" fill="#15803d">m0</text>
    <rect x="560" y="194" width="40" height="20" fill="#dcfce7" stroke="#16a34a"/><text x="580" y="208" text-anchor="middle" fill="#15803d">m1</text>
    <rect x="600" y="194" width="40" height="20" fill="#dcfce7" stroke="#16a34a"/><text x="620" y="208" text-anchor="middle" fill="#15803d">m2</text>
    <rect x="640" y="194" width="40" height="20" fill="#dcfce7" stroke="#16a34a"/><text x="660" y="208" text-anchor="middle" fill="#15803d">m3</text>
    <rect x="680" y="194" width="104" height="20" fill="#f0fdf4" stroke="#86efac" stroke-dasharray="3 2"/><text x="732" y="208" text-anchor="middle" fill="#15803d">append &#8594;</text>
  </g>

  <rect x="506" y="234" width="90" height="40" rx="5" fill="#fff" stroke="#16a34a"/><text x="551" y="258" text-anchor="middle" fill="#15803d" font-size="9">broker 1</text>
  <rect x="606" y="234" width="90" height="40" rx="5" fill="#fff" stroke="#16a34a"/><text x="651" y="258" text-anchor="middle" fill="#15803d" font-size="9">broker 2</text>
  <rect x="706" y="234" width="90" height="40" rx="5" fill="#fff" stroke="#16a34a"/><text x="751" y="258" text-anchor="middle" fill="#15803d" font-size="9">broker 3</text>
  <path d="M620,216 L560,232" stroke="#16a34a" stroke-width="1.5" marker-end="url(#k2)"/>
  <path d="M640,216 L651,232" stroke="#16a34a" stroke-width="1.5" marker-end="url(#k2)"/>
  <path d="M660,216 L742,232" stroke="#16a34a" stroke-width="1.5" marker-end="url(#k2)"/>
  <text x="466" y="292" fill="#166534" font-size="9">brokers are OBSERVERS: they REPLICATE the log</text>
  <text x="466" y="308" fill="#166534" font-size="9">from their last offset (incremental delta, not a push)</text>

  <text x="466" y="336" fill="#15803d" font-size="10" font-weight="bold">Wins</text>
  <text x="466" y="356" fill="#166534" font-size="9">&#8226; ONE system &#8212; no ZooKeeper to operate</text>
  <text x="466" y="376" fill="#166534" font-size="9">&#8226; failover is instant: standby already HAS the log</text>
  <text x="466" y="396" fill="#166534" font-size="9">&#8226; scales to MILLIONS of partitions</text>
  <text x="466" y="416" fill="#166534" font-size="9">&#8226; one source of truth: the metadata log</text>
  <text x="466" y="432" fill="#15803d" font-size="9" font-weight="bold">active controller = Raft leader of the quorum</text>
</svg>
```

### KRaft: metadata as a replicated log

In KRaft, a dedicated (or combined) set of **controller** nodes form a Raft quorum. Every metadata change — create a topic, a broker joined, a leader moved, an ISR shrank — is a record appended to the internal `__cluster_metadata` log. Raft guarantees that a majority of the quorum agrees on the ordered contents of that log: a write commits only when a majority has it, exactly like `acks=all` with `min.insync.replicas` for data (chapter 17), but for metadata. The **active controller is the Raft leader** of the quorum — the one node that appends — and the other voters are hot standbys that already hold the full committed log. **Brokers** are *observers*: they do not vote, they simply *replicate* the metadata log like a follower and apply each new record to their local view of the world. There is now one source of truth (the log), no external system, and no cold reload on failover — the standby that becomes leader already has the metadata.

## 4. Architecture & Workflow

### Roles, quorum, and the metadata write path

```svg
<svg viewBox="0 0 880 480" width="100%" height="480" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="q1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
    <marker id="q2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
  </defs>
  <text x="440" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">KRaft roles and a metadata change committing through Raft</text>

  <rect x="24" y="42" width="500" height="250" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="274" y="64" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">Metadata write: create-topic committing via Raft</text>

  <rect x="44" y="80" width="100" height="36" rx="6" fill="#fff" stroke="#7c3aed"/><text x="94" y="102" text-anchor="middle" fill="#5b21b6" font-size="9">admin client</text>
  <rect x="200" y="80" width="120" height="36" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="2"/><text x="260" y="98" text-anchor="middle" fill="#5b21b6" font-size="9" font-weight="bold">ACTIVE controller</text><text x="260" y="110" text-anchor="middle" fill="#6d28d9" font-size="8">(Raft leader c1)</text>
  <path d="M144,98 L196,98" stroke="#7c3aed" stroke-width="2" marker-end="url(#q1)"/><text x="170" y="92" text-anchor="middle" fill="#5b21b6" font-size="7">1. create</text>

  <rect x="200" y="150" width="120" height="30" rx="5" fill="#fff" stroke="#7c3aed"/><text x="260" y="169" text-anchor="middle" fill="#5b21b6" font-size="8">voter c2</text>
  <rect x="360" y="150" width="120" height="30" rx="5" fill="#fff" stroke="#7c3aed"/><text x="420" y="169" text-anchor="middle" fill="#5b21b6" font-size="8">voter c3</text>
  <path d="M255,116 L255,148" stroke="#7c3aed" stroke-width="2" marker-end="url(#q1)"/>
  <path d="M300,116 L400,148" stroke="#7c3aed" stroke-width="2" marker-end="url(#q1)"/>
  <text x="44" y="200" fill="#6d28d9" font-size="9">2. append record to __cluster_metadata &amp; replicate to voters</text>
  <text x="44" y="220" fill="#6d28d9" font-size="9">3. a MAJORITY (2 of 3) persist it &#8594; the entry COMMITS</text>
  <text x="44" y="240" fill="#5b21b6" font-size="9" font-weight="bold">4. controller acks the admin client &#8212; topic now exists in the log</text>
  <text x="44" y="264" fill="#6d28d9" font-size="9">Raft majority = strong consistency for metadata, like acks=all for data</text>
  <text x="44" y="282" fill="#6d28d9" font-size="9">quorum of 3 tolerates 1 loss; quorum of 5 tolerates 2</text>

  <rect x="540" y="42" width="316" height="250" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="698" y="64" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">Brokers observe the log</text>
  <rect x="560" y="80" width="120" height="30" rx="5" fill="#fff" stroke="#2563eb"/><text x="620" y="99" text-anchor="middle" fill="#1e40af" font-size="9">broker 1 (observer)</text>
  <rect x="560" y="118" width="120" height="30" rx="5" fill="#fff" stroke="#2563eb"/><text x="620" y="137" text-anchor="middle" fill="#1e40af" font-size="9">broker 2 (observer)</text>
  <rect x="560" y="156" width="120" height="30" rx="5" fill="#fff" stroke="#2563eb"/><text x="620" y="175" text-anchor="middle" fill="#1e40af" font-size="9">broker 3 (observer)</text>
  <rect x="720" y="118" width="110" height="30" rx="5" fill="#ddd6fe" stroke="#7c3aed"/><text x="775" y="137" text-anchor="middle" fill="#5b21b6" font-size="8">metadata log</text>
  <path d="M718,95 L720,128" stroke="#2563eb" stroke-width="1.5" marker-end="url(#q2)"/>
  <path d="M718,133 L720,133" stroke="#2563eb" stroke-width="1.5" marker-end="url(#q2)"/>
  <path d="M718,171 L720,140" stroke="#2563eb" stroke-width="1.5" marker-end="url(#q2)"/>
  <text x="560" y="212" fill="#1d4ed8" font-size="9">brokers pull new records from their last offset</text>
  <text x="560" y="230" fill="#1d4ed8" font-size="9">and apply them &#8212; no push, no ZK watch</text>
  <text x="560" y="254" fill="#1e40af" font-size="9" font-weight="bold">a broker restart resumes from its offset</text>
  <text x="560" y="272" fill="#1d4ed8" font-size="9">plus a periodic snapshot to bound catch-up</text>

  <rect x="24" y="304" width="832" height="164" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="326" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">The three deployment roles (process.roles)</text>

  <rect x="44" y="342" width="256" height="110" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="172" y="364" text-anchor="middle" fill="#5b21b6" font-size="11" font-weight="bold">controller</text>
  <text x="60" y="386" fill="#6d28d9" font-size="9">process.roles=controller</text>
  <text x="60" y="404" fill="#6d28d9" font-size="9">votes in the Raft quorum;</text>
  <text x="60" y="420" fill="#6d28d9" font-size="9">holds metadata; no client data.</text>
  <text x="60" y="440" fill="#5b21b6" font-size="9" font-weight="bold">dedicated: for large clusters</text>

  <rect x="312" y="342" width="256" height="110" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="440" y="364" text-anchor="middle" fill="#1e40af" font-size="11" font-weight="bold">broker</text>
  <text x="328" y="386" fill="#1d4ed8" font-size="9">process.roles=broker</text>
  <text x="328" y="404" fill="#1d4ed8" font-size="9">serves produce/consume;</text>
  <text x="328" y="420" fill="#1d4ed8" font-size="9">observes the metadata log.</text>
  <text x="328" y="440" fill="#1e40af" font-size="9" font-weight="bold">the data plane</text>

  <rect x="580" y="342" width="256" height="110" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="708" y="364" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">combined</text>
  <text x="596" y="386" fill="#166534" font-size="9">process.roles=broker,controller</text>
  <text x="596" y="404" fill="#166534" font-size="9">one node does both roles.</text>
  <text x="596" y="420" fill="#166534" font-size="9">simplest footprint.</text>
  <text x="596" y="440" fill="#15803d" font-size="9" font-weight="bold">dev &amp; small clusters</text>
</svg>
```

The lifecycle of a metadata change, say creating a topic. An admin client sends the request to the active controller (the Raft leader). The controller appends a record describing the change to `__cluster_metadata` and replicates it to the other voters; once a *majority* of the quorum has persisted the record, the entry is committed — Raft's majority rule is the metadata analogue of `acks=all` with `min.insync.replicas`. The controller then acknowledges the client: the topic now durably exists in the log. Brokers, as observers, pull the new record on their next fetch of the metadata log and apply it, learning of the new topic incrementally with no push and no ZooKeeper watch. A broker that restarts resumes from its last metadata offset and catches up on what it missed, with periodic **metadata snapshots** bounding how far back it ever has to read.

Deployment is expressed through `process.roles`. A node with `process.roles=controller` is a dedicated quorum member — it votes, holds metadata, and serves no client data; large clusters run 3 or 5 of these on their own hardware so metadata load never competes with data load. A node with `process.roles=broker` is a pure data-plane broker that observes the metadata log. A node with `process.roles=broker,controller` is **combined** — it does both — which is the simplest footprint for development and small clusters where dedicating machines to controllers is overkill. The quorum size follows Raft's majority arithmetic: 3 voters tolerate 1 failure, 5 voters tolerate 2; you almost never want more than 5, since every additional voter adds replication cost without proportional benefit.

## 5. Implementation

KRaft is configured, formatted and operated with a handful of settings and one mandatory bootstrap step (`kafka-storage.sh format`). Here are the concrete pieces.

**A dedicated controller node (`controller.properties`).**

```properties
# controller.properties  -- a dedicated KRaft controller (votes, no client data)

# This node's roles. `controller` = pure quorum member.
process.roles=controller

# This node's id, unique across the whole cluster (brokers and controllers
# share one id space in KRaft).
node.id=1

# THE quorum definition: every voter as id@host:port. All controllers and
# brokers must list the SAME set so they agree on who forms the Raft quorum.
# (Newer Kafka can also bootstrap the quorum dynamically via
# controller.quorum.bootstrap.servers; the static form is shown for clarity.)
controller.quorum.voters=1@ctrl-1:9093,2@ctrl-2:9093,3@ctrl-3:9093

# Controllers only need a controller listener (no client PLAINTEXT listener).
listeners=CONTROLLER://ctrl-1:9093
controller.listener.names=CONTROLLER

# Where the metadata log (__cluster_metadata) lives.
metadata.log.dir=/var/lib/kafka/metadata

# Snapshot the metadata log after this many new records so a restarting node
# catches up from a snapshot rather than replaying the entire log.
metadata.log.max.record.bytes.between.snapshots=20971520
```

**A pure broker node (`broker.properties`).**

```properties
# broker.properties  -- a data-plane broker that OBSERVES the metadata log

process.roles=broker
node.id=101

# Brokers must know the controller quorum to fetch metadata from, and which
# listener name the controllers expose.
controller.quorum.voters=1@ctrl-1:9093,2@ctrl-2:9093,3@ctrl-3:9093
controller.listener.names=CONTROLLER

# Client-facing and inter-broker listeners (the data plane).
listeners=PLAINTEXT://broker-1:9092
inter.broker.listener.name=PLAINTEXT
advertised.listeners=PLAINTEXT://broker-1:9092

log.dirs=/var/lib/kafka/data
```

**Formatting storage before first start (mandatory in KRaft).** Every node must be initialised with the *same* cluster id, which is baked into a `meta.properties` under the log dirs.

```bash
# 1) Generate ONE cluster id for the whole cluster (run once, reuse everywhere).
KAFKA_CLUSTER_ID="$(kafka-storage.sh random-uuid)"
echo "cluster id: $KAFKA_CLUSTER_ID"   # e.g. 7bqTq0m2S9m8k2C0mzWx3Q

# 2) Format EACH node's storage with that id before the first start. Without
#    this, a KRaft node refuses to start -- there is no ZooKeeper to hand it a
#    cluster identity, so it must be stamped locally.
kafka-storage.sh format \
  --config /etc/kafka/controller.properties \
  --cluster-id "$KAFKA_CLUSTER_ID"

kafka-storage.sh format \
  --config /etc/kafka/broker.properties \
  --cluster-id "$KAFKA_CLUSTER_ID"

# 3) Start the nodes (controllers first, then brokers).
kafka-server-start.sh /etc/kafka/controller.properties
kafka-server-start.sh /etc/kafka/broker.properties
```

**Inspecting the quorum and the metadata log.** These are the KRaft-specific operational commands.

```bash
# Who is in the quorum, who is the leader, and how far behind each voter is.
# LeaderId is the ACTIVE controller; watch that followers' lag stays low.
kafka-metadata-quorum.sh --bootstrap-server broker-1:9092 describe --status

# Per-replica detail: each voter/observer's log-end offset and lag.
kafka-metadata-quorum.sh --bootstrap-server broker-1:9092 describe --replication

# Read the metadata log itself (topics, brokers, configs) as human-readable
# records -- the KRaft analogue of poking around in ZooKeeper's znodes.
kafka-metadata-shell.sh --snapshot \
  /var/lib/kafka/metadata/__cluster_metadata-0/00000000000000000000.log
```

**Combined-mode single node for development.** One process is both broker and controller.

```properties
# dev single-node: broker AND controller in one process.
process.roles=broker,controller
node.id=1
controller.quorum.voters=1@localhost:9093
listeners=PLAINTEXT://localhost:9092,CONTROLLER://localhost:9093
controller.listener.names=CONTROLLER
inter.broker.listener.name=PLAINTEXT
log.dirs=/tmp/kraft-combined-logs
```

The essential difference from the ZooKeeper era in operational terms: there is no `zookeeper.connect`, no ZooKeeper ensemble to run, and one new mandatory step — `kafka-storage.sh format` with a shared cluster id — because there is no external system left to hand a new node its cluster identity.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **One system to operate.** No ZooKeeper ensemble to deploy, secure, tune, monitor or upgrade — a large reduction in operational surface and required expertise.
- **Near-instant controller failover.** A standby controller already holds the committed metadata log, so it takes over without the cold ZooKeeper reload that made large-cluster failovers slow.
- **Massive partition scale.** Storing metadata as an incrementally-replicated log lifts the ceiling from low hundreds of thousands to millions of partitions.
- **Faster metadata propagation.** Brokers replicate a delta of the log from their last offset instead of receiving full RPC pushes, so changes propagate cheaply and cluster-wide operations (restarts, reassignments) are quicker.
- **One source of truth.** Metadata lives in exactly one place — the log — removing the ZooKeeper-versus-controller-memory split and a class of consistency bugs.

**Disadvantages**
- **Migration effort for existing clusters.** Moving a live ZooKeeper-based cluster to KRaft is a staged, careful process (dual-write, then cut over) that must be planned and rehearsed.
- **New operational model to learn.** `process.roles`, quorum voters, `kafka-storage.sh format`, snapshots and the metadata-quorum tools are new concepts even for experienced Kafka operators.
- **Quorum sizing is a fresh decision.** You now own the controller quorum's fault tolerance directly (3 vs 5 voters) rather than inheriting a ZooKeeper ensemble someone else may have sized.
- **Ecosystem catch-up (historically).** Some older tools, dashboards and managed offerings assumed ZooKeeper; that gap has largely closed by Kafka 4.0 but can still bite legacy tooling.

**Trade-offs**
- *Combined vs dedicated controllers:* combined (`broker,controller`) mode is the simplest footprint and ideal for dev and small clusters, but for large or latency-sensitive clusters, dedicated controllers keep metadata work off the data-plane brokers — the classic simplicity-versus-isolation trade.
- *Quorum size — fault tolerance vs cost:* 3 voters tolerate one failure and are the common default; 5 tolerate two but add replication and coordination cost. More than 5 is almost never worth it.
- *Migrate now vs later:* KRaft's benefits are real, but a live migration carries risk; the trade is between running an unsupported-after-4.0 ZooKeeper setup and investing in a careful cutover. After 4.0 there is no "later" — ZooKeeper is gone.

## 7. Common Mistakes & Best Practices

- **Forgetting `kafka-storage.sh format`.** In KRaft there is no ZooKeeper to hand a node its cluster identity, so an unformatted node refuses to start. Every node must be formatted with the *same* cluster id before first start.
- **Mismatched `controller.quorum.voters`.** Every node must list the identical set of voters; a typo or a divergent list means nodes disagree on who forms the quorum and the cluster fails to form. Treat it as a single shared constant.
- **An even number of voters.** Raft needs a majority, so an even quorum (e.g. 4) tolerates the same failures as the odd one below it (3) while costing more. Use 3 or 5.
- **Running combined mode at large scale.** Combining broker and controller on the same nodes is fine for dev and small clusters but lets metadata work contend with data traffic on big ones; dedicate controllers when the cluster is large or latency-sensitive.
- **Under-provisioning controller storage/IO.** The metadata log and its snapshots need durable, reasonably fast storage; putting controllers on flaky or tiny volumes risks the one thing the whole cluster depends on.
- **Migrating without rehearsal.** A ZooKeeper-to-KRaft migration on a production cluster without practising the staged dual-write and cutover in a test cluster first is how you turn an upgrade into an outage.
- **Assuming ZooKeeper is still an option on 4.0.** It is removed. New clusters must be KRaft, and existing ones must migrate before upgrading to 4.0.
- **Best practice: standardise the topology.** Use dedicated controller nodes in an odd-sized quorum (3 for most, 5 for large/critical), one shared cluster id, identical voter lists, durable controller storage, and rehearse migrations in a staging cluster. Combined mode is for dev only.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** The first questions in any KRaft incident are "who is the active controller?" and "is the quorum healthy?" — answered by `kafka-metadata-quorum.sh describe --status` (leader id, voters, their lag). If metadata changes are not propagating, check that brokers (observers) are keeping up with the metadata log via `describe --replication`; a broker lagging the metadata log will have a stale view of leadership. To see what the metadata *is*, `kafka-metadata-shell.sh` reads the log directly — the KRaft replacement for browsing ZooKeeper znodes. A cluster that will not form usually has mismatched voter lists or unformatted storage.
- **Monitoring.** Key signals: `ActiveControllerCount` must be exactly 1 across the whole cluster (0 means no controller — an outage; >1 means split brain); metadata-log replication lag per voter and per broker-observer (rising lag delays leadership propagation); the current metadata offset advancing; snapshot frequency and size; and controller-side commit latency. These replace the old ZooKeeper ensemble health metrics (request latency, outstanding requests, ensemble quorum) you no longer have to watch.
- **Security.** The controller listener carries the cluster's entire metadata and must be locked down: dedicate a `CONTROLLER` listener, put it on a trusted network, and secure it with TLS and SASL just as you would the inter-broker listener. Because the metadata log holds ACLs and configs, access to the controller quorum and to the metadata log directory is equivalent to control of the cluster — restrict both. The upside over ZooKeeper is one fewer security perimeter (the ZooKeeper ensemble's separate SASL/ACL/TLS setup) to get right.
- **Scaling.** KRaft's whole point is metadata scalability: because brokers replicate a metadata delta rather than receiving O(partitions) RPC pushes, and failover is a hot standby taking over, clusters scale to millions of partitions and recover in a fraction of the ZooKeeper-era time. Scale the *data plane* by adding brokers as before; keep the controller quorum small (3 or 5) and well-provisioned rather than large. For very long retention needs, tiered storage (chapter 18) and KRaft together let a cluster hold enormous partition counts and history without the old ceilings.

## 9. Interview Questions

**Q: What did ZooKeeper do for Kafka?**
A: Four things. It held broker membership via ephemeral nodes, so a broker's session expiring is how the cluster learned it was gone. It coordinated controller election, with brokers racing to create a single node and the winner becoming controller. It stored cluster metadata — topics, partitions, replica assignments, leaders, configs, ACLs, quotas — as its znodes. And it provided change notification through watches, so brokers were told when metadata changed. In short, ZooKeeper was Kafka's external source of truth and coordination service, separate from Kafka's own data path because a partition needs a leader before it can store anything.

**Q: What is KRaft and what problem does it solve?**
A: KRaft (Kafka Raft, KIP-500) replaces ZooKeeper by having Kafka manage its own metadata as a replicated log. A quorum of controller nodes runs the Raft consensus protocol and stores all cluster metadata in an internal `__cluster_metadata` topic; the active controller is the Raft leader of that quorum, and brokers replicate the metadata log as observers. It solves three problems: the operational burden of running a second distributed system, the slow controller failover caused by cold-reloading metadata from ZooKeeper, and the partition-count ceiling caused by pushing metadata changes RPC-by-RPC. With metadata as a log, changes are appends, failover is a hot standby taking over, and brokers learn changes incrementally.

**Q: Why did the ZooKeeper architecture limit partition count?**
A: Because of how metadata propagated. On a controller failover, the new controller had to read the entire cluster's metadata out of ZooKeeper to rebuild its in-memory view before it could act, and that cold load grew with the number of partitions — so large clusters had slow, sometimes minutes-long, failovers. And on every metadata change, the controller pushed updates to brokers one RPC at a time, so change cost scaled with brokers times partitions. Together these capped practical clusters at low hundreds of thousands of partitions. KRaft inverts this: metadata is a log, so a change is a cheap append, a standby already has the log (instant failover), and brokers replicate deltas — lifting the ceiling to millions.

**Q: In KRaft, what is the relationship between the controller quorum, Raft, and the active controller?**
A: The controller quorum is a set of nodes (typically 3 or 5) that together run Raft over the metadata log. Raft is a leader-based consensus protocol: a metadata entry commits only when a majority of the quorum has persisted it, which gives strong consistency for metadata just as `acks=all` with `min.insync.replicas` does for data. The active controller is simply the Raft *leader* of that quorum — the single node that appends metadata changes — while the other voters are hot standbys holding the full committed log. If the leader fails, Raft elects a new one from the survivors, and because it already has the log, it takes over almost immediately.

**Q: What are the KRaft node roles?**
A: Set by `process.roles`. A `controller` node is a pure quorum member — it votes in Raft, holds metadata, and serves no client data; large clusters run a dedicated odd-sized set of these. A `broker` node is a data-plane server that handles produce and consume and observes the metadata log without voting. A `broker,controller` (combined) node does both in one process, which is the simplest footprint for development and small clusters but lets metadata work contend with data traffic, so it is not ideal at large scale.

**Q: What replaced the `zookeeper.connect` config and what new step is required?**
A: There is no `zookeeper.connect` in KRaft — brokers instead use `controller.quorum.voters` (or bootstrap servers) to find the controller quorum, and `process.roles` to declare what each node is. The new mandatory step is `kafka-storage.sh format`: before a KRaft node starts for the first time, its storage must be formatted with a shared cluster id, because there is no ZooKeeper to hand it a cluster identity — the id is stamped into a local `meta.properties`. Every node in the cluster must be formatted with the same cluster id.

**Q: (Senior) Walk through migrating a live ZooKeeper-based cluster to KRaft.**
A: The migration is staged so the cluster stays available throughout and is reversible until the point of no return. First, prerequisites: get onto a Kafka version that supports KRaft migration, ensure the cluster has stable metadata, and stand up a new KRaft controller quorum (dedicated controller nodes) formatted with the existing cluster's id and configured in *migration* mode. The KRaft controllers then connect to ZooKeeper and *copy the existing metadata* into the KRaft metadata log, so the log becomes a faithful replica of ZooKeeper's state. Next, the cluster enters a dual-write phase: the KRaft controllers are now the active controllers, but they keep writing metadata back to ZooKeeper as well, so you can still roll back to ZooKeeper mode if something is wrong — this is the safety window. Meanwhile you roll the brokers one at a time, reconfiguring each from ZooKeeper mode to KRaft mode (pointing at the controller quorum, dropping `zookeeper.connect`), and they begin observing the metadata log instead of watching ZooKeeper. Once all brokers are migrated and healthy in dual-write mode, you finalise the migration: the controllers stop writing to ZooKeeper, the cluster is now KRaft-only, and — critically — this is irreversible, so you validate thoroughly in dual-write before finalising. Throughout, I would rehearse the entire sequence on a staging cluster that mirrors production, monitor `ActiveControllerCount` and metadata replication lag at each step, and have a tested rollback runbook for the pre-finalisation phases. The reason for all this ceremony is that metadata is the cluster's nervous system; a botched migration does not lose a topic, it can make the cluster unable to elect leaders at all.

**Q: (Senior) How does KRaft make controller failover faster and more scalable, mechanically?**
A: Two mechanisms working together. First, the standby controllers are already *hot*: because metadata is a Raft-replicated log and every voter holds the full committed log, a follower that becomes the new leader does not need to load anything — it already has the complete, up-to-date metadata in memory and on disk. Contrast the ZooKeeper era, where the new controller was a broker that had to read the entire metadata set out of ZooKeeper and rebuild its in-memory picture from cold before it could make a single leadership decision, an operation whose cost grew with partition count. Second, propagation to brokers is incremental: brokers are observers that replicate the metadata log and apply new records from their last offset, so after a failover they do not need a full metadata push — they simply keep following the log, and any records the new leader commits flow to them as deltas. So both the expensive parts of the old design — cold reload on failover and O(brokers × partitions) RPC fan-out on change — are gone, replaced by "the follower with the log takes over" and "everyone tails the log". Snapshots bound how far back a lagging or restarting node must read, keeping catch-up cheap even for enormous metadata. This is why failover drops from seconds-to-minutes to sub-second and why the partition ceiling rises by orders of magnitude: the metadata plane now scales the same way Kafka's data plane always did.

**Q: (Senior) Where does KRaft's consistency come from, and how does it compare to Kafka's data-plane durability?**
A: KRaft's consistency comes from Raft's majority-commit rule applied to the metadata log, and it is deliberately the same shape as the data-plane durability contract, one level up. On the data plane, a record is committed when the in-sync replicas — at least `min.insync.replicas` of them under `acks=all` — have it, which tolerates the loss of up to `RF - min.insync.replicas` brokers without losing acknowledged data. In KRaft, a metadata entry is committed when a majority of the controller quorum has persisted it, which tolerates the loss of a minority of voters — one of three, two of five — without losing committed metadata or blocking progress, because a majority always survives to elect a new leader and continue. Both are quorum-based, leader-driven replication with a committed watermark below which data is safe; the difference is that the data plane lets you tune the quorum per topic via `acks` and `min.insync.replicas`, while KRaft fixes it at Raft's strict majority because metadata must be strongly consistent — there is no useful "relaxed" setting for "which broker leads this partition". The elegance of KIP-500 is precisely that Kafka did not invent a new consistency mechanism for metadata; it recognised that metadata is just an ordered log of changes and reused the log-and-quorum design it already had, so the same reasoning about majorities, committed offsets and failover applies to both planes.

**Q: How many controller nodes should a quorum have, and why odd?**
A: Three for most clusters, five for large or especially critical ones. The number must be odd because Raft commits on a *majority*, and an even quorum wastes a node: four voters need three to form a majority and so tolerate only one failure — exactly the same as three voters — while costing an extra node's replication and coordination. Three voters tolerate one failure, five tolerate two; beyond five, the coordination cost of every commit rises without meaningfully improving fault tolerance, so you almost never want more. The controllers should be on dedicated, well-provisioned nodes since the entire cluster's ability to elect leaders depends on the quorum staying healthy.

**Q: Is ZooKeeper still supported, and what does that mean for upgrades?**
A: ZooKeeper mode was deprecated and is *removed* in Kafka 4.0 — from 4.0 onward, KRaft is the only way to run Kafka. Practically, new clusters must be created in KRaft mode, and any existing ZooKeeper-based cluster must complete the staged migration to KRaft *before* upgrading to 4.0, because there is no ZooKeeper mode to upgrade into. So "we'll deal with it later" has a hard deadline: the migration is a prerequisite for staying on supported Kafka.

## 10. Quick Revision & Cheat Sheet

| Aspect | ZooKeeper era | KRaft |
|---|---|---|
| Metadata store | External ZooKeeper znodes | `__cluster_metadata` Kafka log |
| Controller | A broker, elected via ZooKeeper | Raft leader of the controller quorum |
| Failover | Cold reload from ZooKeeper (slow) | Hot standby already has the log (instant) |
| Change propagation | Controller pushes RPCs per broker | Brokers replicate the log (deltas) |
| Partition ceiling | Low hundreds of thousands | Millions |
| Systems to run | Kafka + ZooKeeper | Kafka only |

| Config / tool | Purpose |
|---|---|
| `process.roles` | `controller` / `broker` / `broker,controller` |
| `controller.quorum.voters` | The Raft voter set (id@host:port) |
| `kafka-storage.sh format` | Stamp cluster id before first start (mandatory) |
| `kafka-metadata-quorum.sh` | Inspect quorum status and replication |
| `kafka-metadata-shell.sh` | Read the metadata log contents |

**Flash cards**
- **What replaced ZooKeeper?** → KRaft: metadata as a Raft-replicated Kafka log (`__cluster_metadata`).
- **Who is the active controller?** → The Raft leader of the controller quorum.
- **Why does KRaft fail over faster?** → The standby already holds the metadata log — no cold reload.
- **Quorum size?** → Odd: 3 (tolerates 1) or 5 (tolerates 2); never even.
- **Mandatory new step?** → `kafka-storage.sh format` with a shared cluster id.
- **When is ZooKeeper gone?** → Removed entirely in Kafka 4.0; KRaft only.

## 11. Hands-On Exercises & Mini Project

- [ ] Format and start a single-node combined (`broker,controller`) KRaft cluster and produce/consume to confirm no ZooKeeper is involved.
- [ ] Run `kafka-metadata-quorum.sh describe --status` and identify the active controller (leader), the voters and their lag.
- [ ] Use `kafka-metadata-shell.sh` to browse the metadata log and find a topic you created, its partitions and their leaders.
- [ ] Stand up a 3-controller, 3-broker cluster with dedicated roles; kill the active controller and time how quickly a new one takes over.
- [ ] Deliberately give one node a mismatched `controller.quorum.voters` list and observe the cluster failing to form; then fix it.
- [ ] Create thousands of partitions and observe metadata propagation and controller behaviour, comparing the feel to descriptions of the ZooKeeper era.

### Mini Project — "Run and Observe a KRaft Quorum"

**Goal.** Build a real dedicated-role KRaft cluster and observe the metadata log and controller failover directly, making the architecture concrete.

**Requirements.**
1. Provision three dedicated controller nodes and three broker nodes (containers are fine), each with a unique `node.id` and an identical `controller.quorum.voters` list.
2. Generate one cluster id and format every node's storage with it; start controllers first, then brokers.
3. Verify the quorum with `kafka-metadata-quorum.sh describe --status` and confirm exactly one active controller and healthy voter lag.
4. Create topics and produce data, then use `kafka-metadata-shell.sh` to show the corresponding records appearing in `__cluster_metadata`.
5. Kill the active controller during steady traffic; measure failover time, confirm `ActiveControllerCount` returns to exactly 1, and verify no produce/consume disruption beyond the brief blip.

**Extensions.**
- Stand up a small ZooKeeper-based cluster on an older Kafka version, then perform and document the staged migration to KRaft, including the dual-write phase and rollback test.
- Push partition count high (tens of thousands) and compare controller failover time and metadata-propagation behaviour against published ZooKeeper-era figures.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Replication: ISR, Leader Election & min.insync.replicas* (the leadership decisions the controller makes), *Storage Internals: Segments, Indexes & Zero-Copy* (the log design KRaft reuses for metadata), *Kafka Architecture: Brokers, Topics & the Cluster* (where the controller sits), *Production: Operating & Monitoring Kafka* (the metrics that replace ZooKeeper's), *Design: Kafka vs RabbitMQ* (how operational simplicity shapes the choice).

- **KIP-500: Replace ZooKeeper with a Self-Managed Metadata Quorum** — Apache Kafka · *Advanced* · the proposal that defines KRaft, its motivation and design, from the source. <https://cwiki.apache.org/confluence/display/KAFKA/KIP-500%3A+Replace+ZooKeeper+with+a+Self-Managed+Metadata+Quorum>
- **Apache Kafka — KRaft (Documentation)** — Apache · *Intermediate* · the official configuration and operations guide for `process.roles`, quorum voters and `kafka-storage.sh`. <https://kafka.apache.org/documentation/#kraft>
- **Confluent — KRaft: Apache Kafka Without ZooKeeper** — Confluent · *Intermediate* · a clear explainer of why KRaft exists, how the controller quorum works, and the scaling gains. <https://developer.confluent.io/learn/kraft/>
- **The Raft Consensus Algorithm (In Search of an Understandable Consensus Algorithm)** — Ongaro & Ousterhout · *Advanced* · the paper behind the consensus KRaft uses; essential for understanding quorum, leader election and log replication. <https://raft.github.io/raft.pdf>
- **KIP-833: Mark KRaft as Production Ready** — Apache Kafka · *Intermediate* · the milestone declaring KRaft production-ready and the deprecation timeline for ZooKeeper. <https://cwiki.apache.org/confluence/display/KAFKA/KIP-833%3A+Mark+KRaft+as+Production+Ready>
- **Apache Kafka — ZooKeeper to KRaft Migration** — Apache · *Advanced* · the official staged migration procedure, including dual-write and finalisation. <https://kafka.apache.org/documentation/#kraft_zk_migration>
- **Confluent — Why ZooKeeper Was Replaced with KRaft** — Confluent · *Intermediate* · the operational and scaling arguments for removing ZooKeeper, with concrete numbers. <https://www.confluent.io/blog/why-replace-zookeeper-with-kafka-raft-the-log-of-all-logs/>
- **raft.github.io — The Raft visualisation** — Diego Ongaro · *Beginner* · an interactive animation of Raft leader election and log replication; the fastest way to build intuition for the quorum. <https://raft.github.io/>

---

*Kafka & RabbitMQ Handbook — chapter 19.*
