# 16 · Distributed Database Architecture: From One Node to Global

> **In one line:** Every rung on the ladder from one PostgreSQL box to a global distributed SQL cluster buys you capacity or survivability by adding a new piece of machinery — replicas, a router, a metadata service, a consensus group per range, a coordinator that plans queries across machines — and every piece adds latency, failure modes and operational cost, so you climb only as high as your workload forces you to.

---

## 1. Overview

A single PostgreSQL server is a remarkably capable machine. One modern box with 64 cores, 512 GB of RAM and NVMe storage will serve tens of thousands of simple transactions per second and hold several terabytes comfortably. For most products, that is the whole story for years. The trouble starts when one of three limits arrives: **write throughput** (one WAL stream, one set of disks, one buffer pool), **data size** (vacuum, backups, index builds and restores that take days), or **survivability** (one machine, one availability zone, one region). Each limit pushes you up a rung.

The naive response is to jump straight to the top: "we'll use a distributed SQL database so we never have to think about scale." That fails in a predictable way. Distributed SQL makes every write a consensus round, every multi-row transaction a distributed transaction, and every query a potential network fan-out. A workload that ran at 1 ms per transaction on one node can run at 5–15 ms in-region and 100+ ms cross-region, and a schema designed for one node (sequential keys, cross-entity joins, big multi-row transactions) becomes a hotspot and contention generator on a distributed one. The opposite naive response — "we'll shard it ourselves when we get there" — fails because application-level sharding pushes routing, rebalancing, cross-shard queries and schema changes into your code forever.

This chapter gives you the **ladder** and, for each rung, the three questions a senior engineer asks: *what problem does this rung solve, what machinery does it add, and what does that machinery cost in latency and operations?* It then opens up the machinery that all distributed databases share — **metadata/placement services, gateways/coordinators, and distributed query execution** — so you can reason about Spanner, CockroachDB, YugabyteDB, TiDB, Citus and Vitess as variations on one design rather than as brand names.

> **Builds on:** [SQL Handbook · Partitioning](../sql/topic.html?p=23-partitioning) (splitting one table on one node) · [SQL Handbook · Execution Plans](../sql/topic.html?p=22-execution-plans) (reading plans, which become distributed plans here) · [Ch 09 · Database Replication](topic.html?p=09-replication) · [Ch 12 · Sharding](topic.html?p=12-sharding) · [Ch 15 · Consensus](topic.html?p=15-consensus). This chapter assumes replication, shard keys and Raft, and assembles them into whole-system architectures.

> **Why this matters:** In a system design interview, "which database architecture and why" is usually answered with a product name. The senior answer is a rung on the ladder, justified by a number (write QPS, data size, RPO/RTO, regions) and paired with the cost you accept.

## 2. Core Concepts

- **Shared-nothing architecture** — each node owns its CPU, memory and disk; nodes cooperate only over the network. *Why it matters:* it is what lets you add nodes linearly, and it is why every cross-node operation becomes a network round trip.
- **Shared-storage architecture** — compute nodes share a distributed storage layer (Aurora, AlloyDB, Neon). *Why it matters:* scales reads and survivability of storage without sharding, but writes still funnel through one primary compute node.
- **Primary + replicas** — one writable node streams its WAL to read-only followers. *Why it matters:* scales reads and survives node loss, but never scales writes.
- **Shard** — a disjoint subset of rows living on one node (or one replica set). *Why it matters:* the unit of write scaling; a transaction touching one shard is cheap, touching many is expensive.
- **Range / tablet / region / split** — the auto-managed shard unit in distributed SQL (CockroachDB range, YugabyteDB tablet, TiKV Region, Spanner split). *Why it matters:* the database splits, merges and moves them for you, which is exactly the work app-level sharding makes you do.
- **Raft group per range** — each range is replicated (typically 3 or 5 copies) by its own consensus group. *Why it matters:* thousands of small consensus groups instead of one; a node failure only triggers elections for the ranges it led.
- **Leaseholder / leader** — the one replica of a range allowed to serve consistent reads and coordinate writes. *Why it matters:* reads avoid a consensus round only because a lease guarantees nobody else can be serving newer writes.
- **Metadata service / placement driver** — the component that knows which range lives where and decides where ranges should move (Spanner placement driver, TiDB PD, YugabyteDB YB-Master, Vitess topology server, CockroachDB meta ranges). *Why it matters:* every query first needs "where is key K?"; if this is slow or down, everything is.
- **Gateway / coordinator** — the node that receives the SQL, plans it, fans out work and assembles the answer (CockroachDB gateway node, Citus coordinator, VTGate, TiDB server). *Why it matters:* it is where distributed query cost is decided.
- **Scatter-gather** — sending a query to every shard and merging results. *Why it matters:* latency = the slowest shard; load = N times one query.
- **Pushdown** — executing filters, aggregations and joins on the data nodes instead of shipping rows to the coordinator. *Why it matters:* the difference between moving 50 rows and 50 million rows across the network.
- **Co-location** — placing related rows (same tenant, same customer) on the same node so joins and transactions stay local. *Why it matters:* the single most important schema decision in a distributed database.
- **Distributed SQL** — a database that presents one SQL endpoint with serializable or snapshot transactions over automatically sharded, consensus-replicated storage. *Why it matters:* it removes sharding from your app, but not the physics of cross-node coordination.

## 3. Theory & Principles

### The ladder

Think of the architectures as rungs. You climb when a *specific* limit bites, and each rung inherits all the costs of the ones below it.

**Rung 0 — single node.** One PostgreSQL process tree, one data directory. Every transaction is local; commit is a WAL fsync (on the order of 0.1–2 ms on good NVMe). Failure = downtime until you restore or rebuild. Limits: one machine's write throughput and storage, and zero survivability.

**Rung 1 — primary + replicas.** Streaming replication (Ch 09) adds read replicas and a standby. Reads scale roughly linearly with replicas; writes do not scale at all. What it adds: **replication lag** (reads may be stale), a **failover** problem (Ch 18), and a **routing** problem (which queries may go to replicas?). Latency: unchanged for async replication; synchronous replication adds one round trip to the standby per commit (sub-millisecond in the same AZ, 1–2 ms across AZs).

**Rung 2 — sharded database.** Rows are split across several independent primaries by a shard key (Ch 12). This is the first rung that scales writes. There are three places to put the routing logic:

| Where routing lives | Examples | What you own |
| --- | --- | --- |
| **Application-level** | a `shard_for(customer_id)` function in your service; Instagram's early PG sharding | routing, resharding, cross-shard queries, schema migrations on N databases, ID generation |
| **Proxy-level** | Vitess (VTGate + VTTablet over MySQL), ProxySQL query rules, pgcat/PgDog sharding for PG | shard key choice, VSchema/rules; the proxy routes and can scatter-gather |
| **Extension-level** | Citus (PostgreSQL extension: coordinator + workers) | distribution column choice, co-location, which tables are reference tables |

What rung 2 adds: a **router**, a **shard map** (metadata), **cross-shard queries** (scatter-gather), and **cross-shard transactions** (2PC or sagas, Ch 13). Each shard is still a rung-1 primary with replicas, so you now run N failover domains.

**Rung 3 — distributed SQL.** Spanner, CockroachDB, YugabyteDB, TiDB. The database shards itself into small ranges (CockroachDB's default max range size is 512 MiB), replicates each range with its own Raft (or Paxos, in Spanner) group, moves and splits ranges automatically, and runs distributed transactions internally. What it adds: **consensus on every write** (one round trip to a majority of replicas), a **metadata/placement service**, **timestamps that must be comparable across machines** (TrueTime, hybrid logical clocks, or a central timestamp oracle), and **distributed query execution**. What it removes: application-level routing and manual resharding.

**Rung 4 — multi-region.** The same cluster spans regions. Consensus majorities now cross regions for some or all data, so writes pay 30–150+ ms of physics unless you pin data to regions. Covered in [Ch 17 · Multi-Region Databases](topic.html?p=17-multi-region-databases).

**Rung 5 — global database.** Data is partitioned by geography (rows homed near their users), reads served locally with bounded staleness, and a small set of truly global data replicated everywhere. This is what Spanner and CockroachDB's multi-region abstractions, DynamoDB global tables and Aurora Global Database approximate in different ways.

```svg
<svg viewBox="0 0 880 520" width="100%" height="520" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The architecture ladder: what each rung adds, and what it costs</text>
  <rect x="24" y="440" width="832" height="64" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="40" y="462" fill="#166534" font-size="12" font-weight="bold">0 · Single node</text>
  <text x="40" y="480" fill="#166534" font-size="10">adds: nothing &#183; commit = local WAL fsync (~0.1&#8211;2 ms)</text>
  <text x="40" y="496" fill="#166534" font-size="10">limit: one box of writes/storage, zero survivability</text>
  <rect x="84" y="364" width="772" height="64" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="100" y="386" fill="#1e40af" font-size="12" font-weight="bold">1 · Primary + replicas</text>
  <text x="100" y="404" fill="#1e40af" font-size="10">adds: WAL shipping, lag, failover, read routing &#183; scales READS only</text>
  <text x="100" y="420" fill="#1e40af" font-size="10">sync standby: +1 RTT per commit (sub-ms same AZ, ~1&#8211;2 ms cross-AZ)</text>
  <rect x="144" y="288" width="712" height="64" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="160" y="310" fill="#92400e" font-size="12" font-weight="bold">2 · Sharded (app / proxy / extension)</text>
  <text x="160" y="328" fill="#92400e" font-size="10">adds: router, shard map, scatter-gather, cross-shard txns, N failover domains</text>
  <text x="160" y="344" fill="#92400e" font-size="10">first rung that scales WRITES &#183; you own resharding (app-level) or the proxy does</text>
  <rect x="204" y="212" width="652" height="64" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="220" y="234" fill="#5b21b6" font-size="12" font-weight="bold">3 · Distributed SQL (ranges + Raft)</text>
  <text x="220" y="252" fill="#5b21b6" font-size="10">adds: consensus per write, placement service, global timestamps, distributed plans</text>
  <text x="220" y="268" fill="#5b21b6" font-size="10">removes: manual routing/resharding &#183; in-region write ~2&#8211;10 ms</text>
  <rect x="264" y="136" width="592" height="64" rx="8" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="280" y="158" fill="#991b1b" font-size="12" font-weight="bold">4 · Multi-region</text>
  <text x="280" y="176" fill="#991b1b" font-size="10">adds: cross-region quorums or async replicas &#183; writes +30&#8211;150 ms of physics</text>
  <text x="280" y="192" fill="#991b1b" font-size="10">survives a region; data residency questions appear</text>
  <rect x="324" y="60" width="532" height="64" rx="8" fill="#f1f5f9" stroke="#334155" stroke-width="2"/>
  <text x="340" y="82" fill="#1e293b" font-size="12" font-weight="bold">5 · Global (geo-partitioned)</text>
  <text x="340" y="100" fill="#334155" font-size="10">adds: row homing, locality-aware reads, global vs regional tables</text>
  <text x="340" y="116" fill="#334155" font-size="10">local latency for local users; cross-home txns stay slow</text>
  <text x="40" y="100" fill="#334155" font-size="11" font-weight="bold">Climb only when</text>
  <text x="40" y="116" fill="#334155" font-size="10">a measured limit bites:</text>
  <text x="40" y="136" fill="#334155" font-size="10">read QPS &#8594; rung 1</text>
  <text x="40" y="152" fill="#334155" font-size="10">write QPS / size &#8594; rung 2&#8211;3</text>
  <text x="40" y="168" fill="#334155" font-size="10">region loss / latency &#8594; 4&#8211;5</text>
  <text x="40" y="196" fill="#64748b" font-size="10">Each rung inherits every</text>
  <text x="40" y="210" fill="#64748b" font-size="10">cost of the rungs below.</text>
</svg>
```

### What every distributed database must answer

Strip the branding away and every distributed database has to solve the same four problems. Knowing them lets you evaluate any product in ten minutes.

1. **Where is key K?** (placement and routing). Something must map a key to a shard/range and a shard/range to a node. Options: a static function in the app (`hash(k) % N` — resharding hell), a lookup table in a proxy (Vitess vindexes backed by a topology server), or a self-describing index stored in the database itself (CockroachDB stores range descriptors in special `meta1`/`meta2` ranges, cached aggressively by every node; TiDB asks the Placement Driver; YugabyteDB asks YB-Master and caches).
2. **Who may accept writes for K?** (leadership). Exactly one replica per range at a time — the Raft leader / leaseholder, or the MySQL primary in a Vitess shard. Getting this wrong is split brain.
3. **In what order did things happen?** (time). Serializable or snapshot transactions across machines need comparable timestamps. Spanner uses **TrueTime** (GPS + atomic clocks with a bounded uncertainty interval, and a **commit wait** that sleeps out the uncertainty). CockroachDB and YugabyteDB use **hybrid logical clocks** plus a max clock offset (CockroachDB defaults to 500 ms) and restart transactions that read values within the uncertainty window. TiDB uses a centralized **timestamp oracle (TSO)** in PD, which is simple but adds a round trip to PD per transaction.
4. **How does a query that touches many keys run?** (distributed execution). The gateway must plan, push work to data, and merge.

### Inside a distributed SQL write

Follow one `UPDATE accounts SET balance = balance - 10 WHERE id = 42` through CockroachDB-style machinery:

1. The client connects to **any** node; that node becomes the **gateway** for the session. It parses and plans the SQL exactly like a single-node database would.
2. The gateway's KV layer needs the range containing `/accounts/42`. It checks its **range descriptor cache**; on a miss it reads the meta ranges (themselves Raft-replicated ranges) to find the range and its current **leaseholder**.
3. The gateway sends the write to the leaseholder. The leaseholder evaluates it (reading the current value, checking for conflicting write intents/locks) and proposes a Raft log entry.
4. The Raft **leader** (normally the same replica as the leaseholder) appends to its log and sends `AppendEntries` to the followers. When a **majority** (2 of 3) have persisted it, the entry is committed and applied.
5. For a multi-range transaction, each touched range holds a provisional **write intent**; a **transaction record** on one range decides the fate of all of them. Commit flips the transaction record, and intents are resolved asynchronously (Ch 13 covers this as a parallel-commit variant of 2PC).
6. The gateway returns success to the client.

In-region, step 4 is one round trip between AZs (~1–2 ms) plus an fsync on each replica. That is why a single-row write in a distributed SQL database typically costs a few milliseconds rather than a fraction of one: **you pay consensus on every write, even when nothing is contended.**

A consistent **read** skips consensus: the leaseholder holds a time-bounded lease that guarantees no other replica can have accepted newer writes, so it can answer from local state. Reads that don't need the very latest value can be served by any replica via **follower reads** at a slightly old timestamp (Ch 17).

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c16a1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="c16a2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
    <marker id="c16a3" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">A distributed SQL write: gateway &#8594; meta lookup &#8594; leaseholder &#8594; Raft majority</text>
  <rect x="24" y="52" width="110" height="40" rx="6" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="79" y="76" text-anchor="middle" fill="#1e293b">Client</text>
  <path d="M136,72 L186,72" stroke="#2563eb" stroke-width="2" marker-end="url(#c16a1)"/>
  <text x="160" y="64" text-anchor="middle" fill="#1e40af" font-size="9">1. SQL</text>
  <rect x="190" y="44" width="170" height="120" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="275" y="64" text-anchor="middle" fill="#1e40af" font-weight="bold">Gateway node (any node)</text>
  <text x="204" y="84" fill="#1e40af" font-size="10">parse &#8594; plan &#8594; optimize</text>
  <text x="204" y="102" fill="#1e40af" font-size="10">range cache: key &#8594; range</text>
  <text x="204" y="120" fill="#1e40af" font-size="10">txn coordinator</text>
  <text x="204" y="138" fill="#1e40af" font-size="10">DistSQL planner</text>
  <rect x="190" y="200" width="170" height="70" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="275" y="222" text-anchor="middle" fill="#92400e" font-weight="bold">Meta ranges</text>
  <text x="275" y="240" text-anchor="middle" fill="#92400e" font-size="10">range descriptors</text>
  <text x="275" y="256" text-anchor="middle" fill="#92400e" font-size="10">(themselves Raft-replicated)</text>
  <path d="M260,166 L260,196" stroke="#d97706" stroke-width="2" stroke-dasharray="4 3" marker-end="url(#c16a1)"/>
  <text x="330" y="186" fill="#92400e" font-size="9">2. on cache miss</text>
  <rect x="440" y="44" width="200" height="120" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="540" y="64" text-anchor="middle" fill="#5b21b6" font-weight="bold">Range 7 leaseholder</text>
  <text x="454" y="84" fill="#5b21b6" font-size="10">= Raft leader (node B, AZ-b)</text>
  <text x="454" y="102" fill="#5b21b6" font-size="10">evaluate: read, check intents</text>
  <text x="454" y="120" fill="#5b21b6" font-size="10">propose log entry</text>
  <text x="454" y="138" fill="#5b21b6" font-size="10">reads: served locally (lease)</text>
  <path d="M362,90 L436,90" stroke="#2563eb" stroke-width="2" marker-end="url(#c16a1)"/>
  <text x="400" y="82" text-anchor="middle" fill="#1e40af" font-size="9">3. KV write</text>
  <rect x="690" y="44" width="170" height="54" rx="8" fill="#f5f3ff" stroke="#7c3aed"/>
  <text x="775" y="66" text-anchor="middle" fill="#5b21b6">Follower (node A, AZ-a)</text>
  <text x="775" y="84" text-anchor="middle" fill="#5b21b6" font-size="10">persist &#8594; ack</text>
  <rect x="690" y="114" width="170" height="54" rx="8" fill="#f5f3ff" stroke="#7c3aed"/>
  <text x="775" y="136" text-anchor="middle" fill="#5b21b6">Follower (node C, AZ-c)</text>
  <text x="775" y="154" text-anchor="middle" fill="#5b21b6" font-size="10">persist &#8594; ack (maybe late)</text>
  <path d="M642,72 L686,72" stroke="#7c3aed" stroke-width="2" marker-end="url(#c16a2)"/>
  <path d="M642,130 L686,138" stroke="#7c3aed" stroke-width="2" marker-end="url(#c16a2)"/>
  <text x="664" y="104" text-anchor="middle" fill="#6d28d9" font-size="9">4. Append</text>
  <text x="664" y="116" text-anchor="middle" fill="#6d28d9" font-size="9">Entries</text>
  <rect x="440" y="200" width="420" height="70" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="650" y="222" text-anchor="middle" fill="#166534" font-weight="bold">5. Committed when leader + 1 follower persisted (2 of 3)</text>
  <text x="650" y="240" text-anchor="middle" fill="#166534" font-size="10">apply to state machine (Pebble/RocksDB) &#8594; ack gateway</text>
  <text x="650" y="256" text-anchor="middle" fill="#166534" font-size="10">6. gateway &#8594; client: one cross-AZ RTT + fsyncs &#8776; a few ms</text>
  <rect x="24" y="296" width="836" height="160" rx="10" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="40" y="318" fill="#1e293b" font-size="12" font-weight="bold">Where the latency goes (single-row write, 3 replicas in 3 AZs of one region)</text>
  <rect x="40" y="332" width="60" height="22" fill="#dbeafe" stroke="#2563eb"/><text x="70" y="347" text-anchor="middle" fill="#1e40af" font-size="9">parse/plan</text>
  <rect x="100" y="332" width="60" height="22" fill="#fef3c7" stroke="#d97706"/><text x="130" y="347" text-anchor="middle" fill="#92400e" font-size="9">client&#8594;LH</text>
  <rect x="160" y="332" width="180" height="22" fill="#ede9fe" stroke="#7c3aed"/><text x="250" y="347" text-anchor="middle" fill="#5b21b6" font-size="9">Raft round trip to nearest follower + fsync</text>
  <rect x="340" y="332" width="60" height="22" fill="#dcfce7" stroke="#16a34a"/><text x="370" y="347" text-anchor="middle" fill="#166534" font-size="9">apply/ack</text>
  <text x="420" y="347" fill="#334155" font-size="10">&#8776; 2&#8211;10 ms total vs ~1 ms on a single PG node</text>
  <text x="40" y="382" fill="#334155" font-size="10">Multi-range txn: intents on each range + one transaction record; commit waits for all intents' Raft writes (pipelined).</text>
  <text x="40" y="402" fill="#334155" font-size="10">Leaseholder in the wrong AZ/region: add a gateway&#8594;leaseholder hop. Stale range cache: one extra meta lookup, then retry.</text>
  <text x="40" y="422" fill="#334155" font-size="10">Contention on the same key: later txns wait on the intent or restart with a retryable 40001 error &#8212; clients must retry.</text>
  <text x="40" y="442" fill="#991b1b" font-size="10" font-weight="bold">The floor is physics: a majority must hear about every write before it is acknowledged.</text>
</svg>
```

### The metadata service is the heart

Every rung above 1 has a metadata component, and it is usually the least understood part of the system:

- **Spanner:** a *universe master* and *placement driver* move data between zones; each zone has a *zonemaster* assigning data to *spanservers*; each spanserver hosts tablets, each replicated by a Paxos group.
- **TiDB:** **PD (Placement Driver)** — a small Raft-replicated cluster (embedding etcd) storing Region locations, issuing timestamps (TSO), and scheduling Region splits, merges and leader transfers. Every transaction touches PD for a start and commit timestamp (batched), so PD latency sits on every transaction's path.
- **YugabyteDB:** **YB-Master** — a Raft group holding the system catalog, tablet-to-TServer assignments and load balancing; data lives on **YB-TServers**, each tablet a Raft group over DocDB (a RocksDB-based store). The YSQL API reuses PostgreSQL's query layer.
- **CockroachDB:** no separate metadata tier — range addressing lives in the `meta1`/`meta2` system ranges and cluster membership in gossip, so every node is symmetric.
- **Vitess:** a **topology server** (etcd, ZooKeeper or Consul) holds the keyspace/shard map and which tablet is primary; VTGate caches it.
- **Citus:** the **coordinator** stores distribution metadata in `pg_dist_*` catalog tables.

The design lesson: metadata must be **small, consensus-replicated, and cached** by the query path. If a query needs a synchronous metadata round trip on every call, the metadata service becomes the bottleneck and the single point of failure. Well-built systems read metadata from a cache and treat a "wrong node" response as the signal to refresh.

## 4. Architecture & Workflow

### Distributed query execution

Once rows live on many nodes, the gateway/coordinator has to decide *where* each piece of a query runs. Three patterns cover almost everything:

**Router (single-shard) query.** The WHERE clause pins the shard key: `SELECT * FROM orders WHERE customer_id = 7 AND id = 991`. The coordinator sends the whole query to one node. Cost ≈ single-node cost + one hop. This is the query shape you design your schema around.

**Scatter-gather.** No shard-key predicate: `SELECT count(*) FROM orders WHERE status = 'PENDING'`. The coordinator sends a fragment to every shard, each computes a **partial aggregate** (pushdown), and the coordinator combines partials (sum of counts). Latency = slowest shard (tail latency amplifies: with 32 shards each at p99 = 20 ms, a scatter query hits a p99-ish shard on most calls). Load = N queries for one.

**Distributed join.** Three strategies, from cheapest to most expensive:

| Strategy | When it applies | Network cost |
| --- | --- | --- |
| **Co-located join** | both tables distributed on the same key and joined on it (`orders.customer_id = customers.id`, both sharded by customer) | none — each node joins its own slice |
| **Broadcast / reference join** | one side is small (countries, plans, feature flags) and replicated to every node (Citus *reference table*, CockroachDB *global table*) | none at query time; writes to the small table go everywhere |
| **Repartition (shuffle) join** | tables distributed on different keys | both sides re-hashed across the network on the join key; can move gigabytes |
| **Lookup join** | small driving side, index on the other side | one remote index probe per driving row (batched) |

**Pushdown** is the rule that makes all of these tolerable: push filters, projections, partial aggregates, `LIMIT` (as per-shard `LIMIT` + final merge) and even sorts to the data nodes, so only the minimum crosses the network. CockroachDB's DistSQL, TiDB's coprocessor (pushing work into TiKV), Citus's adaptive executor and Vitess's VTGate planner all do some version of this. The ORDER BY ... LIMIT 10 over 32 shards becomes "top 10 from each shard, merge-sort 320 rows at the gateway".

```svg
<svg viewBox="0 0 880 480" width="100%" height="480" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c16b1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="c16b2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Three query shapes on a sharded table</text>
  <rect x="20" y="40" width="270" height="420" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="155" y="62" text-anchor="middle" fill="#166534" font-size="12" font-weight="bold">Router query (shard key given)</text>
  <rect x="95" y="80" width="120" height="34" rx="6" fill="#dcfce7" stroke="#16a34a"/><text x="155" y="101" text-anchor="middle" fill="#166534">coordinator</text>
  <rect x="40" y="180" width="70" height="40" rx="6" fill="#fff" stroke="#94a3b8"/><text x="75" y="204" text-anchor="middle" fill="#64748b" font-size="10">shard 1</text>
  <rect x="120" y="180" width="70" height="40" rx="6" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/><text x="155" y="204" text-anchor="middle" fill="#166534" font-size="10">shard 2</text>
  <rect x="200" y="180" width="70" height="40" rx="6" fill="#fff" stroke="#94a3b8"/><text x="235" y="204" text-anchor="middle" fill="#64748b" font-size="10">shard 3</text>
  <path d="M155,116 L155,176" stroke="#16a34a" stroke-width="2" marker-end="url(#c16b1)"/>
  <text x="36" y="252" fill="#166534" font-size="10">WHERE customer_id = 7</text>
  <text x="36" y="272" fill="#166534" font-size="10">1 node does the work</text>
  <text x="36" y="292" fill="#166534" font-size="10">latency &#8776; single node + 1 hop</text>
  <text x="36" y="312" fill="#166534" font-size="10">scales linearly with shards</text>
  <text x="36" y="344" fill="#166534" font-size="10" font-weight="bold">Design every hot path</text>
  <text x="36" y="360" fill="#166534" font-size="10" font-weight="bold">to be this shape.</text>
  <rect x="305" y="40" width="270" height="420" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="440" y="62" text-anchor="middle" fill="#92400e" font-size="12" font-weight="bold">Scatter-gather with pushdown</text>
  <rect x="380" y="80" width="120" height="34" rx="6" fill="#fde68a" stroke="#d97706"/><text x="440" y="101" text-anchor="middle" fill="#92400e">coordinator</text>
  <rect x="325" y="180" width="70" height="40" rx="6" fill="#fef3c7" stroke="#d97706"/><text x="360" y="198" text-anchor="middle" fill="#92400e" font-size="10">shard 1</text><text x="360" y="212" text-anchor="middle" fill="#92400e" font-size="9">count=41</text>
  <rect x="405" y="180" width="70" height="40" rx="6" fill="#fef3c7" stroke="#d97706"/><text x="440" y="198" text-anchor="middle" fill="#92400e" font-size="10">shard 2</text><text x="440" y="212" text-anchor="middle" fill="#92400e" font-size="9">count=37</text>
  <rect x="485" y="180" width="70" height="40" rx="6" fill="#fef3c7" stroke="#d97706"/><text x="520" y="198" text-anchor="middle" fill="#92400e" font-size="10">shard 3</text><text x="520" y="212" text-anchor="middle" fill="#92400e" font-size="9">count=52</text>
  <path d="M420,116 L365,176" stroke="#d97706" stroke-width="2" marker-end="url(#c16b1)"/>
  <path d="M440,116 L440,176" stroke="#d97706" stroke-width="2" marker-end="url(#c16b1)"/>
  <path d="M460,116 L515,176" stroke="#d97706" stroke-width="2" marker-end="url(#c16b1)"/>
  <text x="321" y="252" fill="#92400e" font-size="10">WHERE status = 'PENDING'</text>
  <text x="321" y="272" fill="#92400e" font-size="10">partial counts pushed down,</text>
  <text x="321" y="288" fill="#92400e" font-size="10">coordinator sums 41+37+52=130</text>
  <text x="321" y="312" fill="#92400e" font-size="10">latency = SLOWEST shard</text>
  <text x="321" y="328" fill="#92400e" font-size="10">load = N queries for 1</text>
  <text x="321" y="360" fill="#92400e" font-size="10" font-weight="bold">Fine for rare/admin queries;</text>
  <text x="321" y="376" fill="#92400e" font-size="10" font-weight="bold">deadly on a hot path.</text>
  <rect x="590" y="40" width="270" height="420" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="725" y="62" text-anchor="middle" fill="#991b1b" font-size="12" font-weight="bold">Repartition (shuffle) join</text>
  <rect x="665" y="80" width="120" height="34" rx="6" fill="#fee2e2" stroke="#dc2626"/><text x="725" y="101" text-anchor="middle" fill="#991b1b">coordinator</text>
  <rect x="610" y="180" width="70" height="40" rx="6" fill="#fee2e2" stroke="#dc2626"/><text x="645" y="204" text-anchor="middle" fill="#991b1b" font-size="10">node 1</text>
  <rect x="690" y="180" width="70" height="40" rx="6" fill="#fee2e2" stroke="#dc2626"/><text x="725" y="204" text-anchor="middle" fill="#991b1b" font-size="10">node 2</text>
  <rect x="770" y="180" width="70" height="40" rx="6" fill="#fee2e2" stroke="#dc2626"/><text x="805" y="204" text-anchor="middle" fill="#991b1b" font-size="10">node 3</text>
  <path d="M680,192 L686,192" stroke="#dc2626" stroke-width="2" marker-end="url(#c16b2)"/>
  <path d="M760,208 L766,208" stroke="#dc2626" stroke-width="2" marker-end="url(#c16b2)"/>
  <path d="M645,222 C 700,250 760,250 800,224" stroke="#dc2626" stroke-width="2" fill="none" marker-end="url(#c16b2)"/>
  <path d="M805,222 C 760,270 690,270 650,224" stroke="#dc2626" stroke-width="2" fill="none" marker-end="url(#c16b2)"/>
  <text x="606" y="300" fill="#991b1b" font-size="10">orders by customer_id JOIN</text>
  <text x="606" y="316" fill="#991b1b" font-size="10">shipments by warehouse_id</text>
  <text x="606" y="336" fill="#991b1b" font-size="10">both sides re-hashed on the</text>
  <text x="606" y="352" fill="#991b1b" font-size="10">join key and shipped between nodes</text>
  <text x="606" y="384" fill="#991b1b" font-size="10" font-weight="bold">Fix: co-locate on the join key,</text>
  <text x="606" y="400" fill="#991b1b" font-size="10" font-weight="bold">or make the small side a</text>
  <text x="606" y="416" fill="#991b1b" font-size="10" font-weight="bold">reference/global table.</text>
</svg>
```

### Co-location is the schema decision

On one node, normalization and joins are free design choices. On a distributed database, **the distribution key decides which joins and transactions stay local**. The multi-tenant SaaS pattern is the canonical example: distribute *every* tenant-scoped table by `tenant_id`, include `tenant_id` in every primary key and foreign key, and every tenant's joins, foreign keys and transactions stay on one node. Citus enforces this with *co-location groups*; Spanner expresses it with **interleaved tables** (`INTERLEAVE IN PARENT`) so child rows physically sit next to their parent; CockroachDB and YugabyteDB achieve it by making the tenant the primary-key prefix so related rows land in the same ranges.

Global lookup data (currencies, plans) becomes a **reference table** replicated to all nodes. Data that is truly cross-tenant (a global username uniqueness index) is the expensive part: it needs either a separate global table with cross-node transactions on write, or a different store.

### What each rung costs to operate

```text
Rung               Components you run                     New pager-worthy failures
0 single node      1 PG                                   disk full, box dies
1 primary+replica  PG x (1+R), failover manager (Patroni) lag, split brain, failed failover
2 sharded          N x rung-1, router/proxy, shard map    hot shard, resharding, cross-shard txn stuck,
                                                          schema drift between shards
3 distributed SQL  3-5+ symmetric nodes (or tiers: PD,     range hotspots, lease thrash, clock skew,
                   TiDB, TiKV / Master, TServer)          retry storms on 40001, rebalancing I/O
4-5 multi-region   the above x regions                    regional partition, residency violations,
                                                          cross-region latency on the wrong txn
```

## 5. Implementation

### Simple example: app-level sharding in 20 lines, and why it hurts

The simplest rung-2 design is a routing function in the application:

```python
import hashlib, psycopg

SHARDS = [
    "postgresql://app@shard0/app",
    "postgresql://app@shard1/app",
    "postgresql://app@shard2/app",
    "postgresql://app@shard3/app",
]
pools = [psycopg.connect(dsn, autocommit=False) for dsn in SHARDS]  # use a real pool in prod

def shard_for(customer_id: int) -> int:
    h = int.from_bytes(hashlib.sha1(str(customer_id).encode()).digest()[:8], "big")
    return h % len(SHARDS)          # resharding = changing len(SHARDS) = moving ~all keys

def get_orders(customer_id: int):
    conn = pools[shard_for(customer_id)]
    with conn.cursor() as cur:
        cur.execute("SELECT id, total FROM orders WHERE customer_id = %s", (customer_id,))
        return cur.fetchall()

def count_pending():               # the scatter-gather you now hand-write
    total = 0
    for conn in pools:
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM orders WHERE status = 'PENDING'")
            total += cur.fetchone()[0]
    return total
```

This works on day one. It hurts later because `% len(SHARDS)` makes adding a shard move almost every key (use a directory table or consistent hashing, Ch 12), `count_pending` runs serially and has no partial-failure story, cross-customer transactions need 2PC or sagas, and every schema migration now runs four times and can half-succeed. Every one of those is machinery that rungs 2 (proxy/extension) and 3 provide for you.

### Extension-level: the same schema on Citus

Citus keeps you on PostgreSQL. The coordinator holds metadata; workers hold shards (by default 32 shards per distributed table).

```sql
CREATE EXTENSION citus;

CREATE TABLE customers (id bigint PRIMARY KEY, name text, plan_id int);
CREATE TABLE orders (
  customer_id bigint NOT NULL,
  id          bigint NOT NULL,
  status      text   NOT NULL,
  total       numeric(12,2),
  PRIMARY KEY (customer_id, id)             -- distribution column must be in PK/unique keys
);
CREATE TABLE plans (id int PRIMARY KEY, name text);

SELECT create_distributed_table('customers', 'id');
SELECT create_distributed_table('orders', 'customer_id', colocate_with => 'customers');
SELECT create_reference_table('plans');      -- copied to every worker
```

A router query (shard key pinned):

```sql
EXPLAIN SELECT o.id, o.total, c.name
FROM orders o JOIN customers c ON c.id = o.customer_id
WHERE o.customer_id = 7;
```

```text
 Custom Scan (Citus Adaptive)
   Task Count: 1
   Tasks Shown: All
   ->  Task
         Node: host=worker-2 port=5432 dbname=app
         ->  Nested Loop
               ->  Index Scan using customers_pkey_102009 on customers_102009 c
                     Index Cond: (id = 7)
               ->  Index Scan using orders_pkey_102041 on orders_102041 o
                     Index Cond: (customer_id = 7)
```

The same join without the filter is still local on each worker (co-located), but runs as 32 tasks:

```text
 Custom Scan (Citus Adaptive)
   Task Count: 32
   Tasks Shown: One of 32
   ->  Task
         Node: host=worker-1 port=5432 dbname=app
         ->  Hash Join  ...
```

`Task Count` is the number to watch: 1 means router, 32 means scatter. A join between `orders` and a table distributed on a *different* column would need repartitioning (Citus supports it for some query shapes, but it is exactly the expensive path in the diagram above). To see where shards live:

```sql
SELECT table_name, shardid, nodename, shard_size
FROM citus_shards WHERE table_name = 'orders'::regclass ORDER BY shardid LIMIT 4;
```

> **MySQL difference:** The MySQL equivalent is **Vitess**. You define a *keyspace* (logical database), a *VSchema* with a *primary vindex* (e.g. `hash` on `customer_id`) per table, and VTGate routes queries — a query with the vindex column in its WHERE goes to one shard; others scatter. Tables that should co-locate share the same vindex. Resharding is an online workflow (`Reshard` via VReplication) that copies rows to new shards and cuts over. ProxySQL, by contrast, is mainly a query router (read/write split, query rules); sharding with it means encoding the shard map in rules yourself.

### Distributed SQL: seeing ranges and leaseholders

On CockroachDB, the same table is automatically split into ranges. Inspect them:

```sql
CREATE TABLE orders (
  customer_id INT8 NOT NULL,
  id          INT8 NOT NULL DEFAULT unique_rowid(),
  status      STRING NOT NULL,
  total       DECIMAL(12,2),
  PRIMARY KEY (customer_id, id)
);

SHOW RANGES FROM TABLE orders WITH DETAILS;
```

```text
 start_key        | end_key          | range_id | replicas | lease_holder | range_size_mb
------------------+------------------+----------+----------+--------------+--------------
 …/1/1000         | …/1/250000       |       87 | {1,2,4}  |            2 |        498.2
 …/1/250000       | …/1/510000       |      112 | {2,3,5}  |            5 |        311.7
(trimmed; column names vary by version)
```

`EXPLAIN ANALYZE (DISTSQL)` shows which nodes ran which processors. The rules you take from this output are the same as Citus: filters on the primary-key prefix become single-range scans; everything else fans out.

**Hotspots from sequential keys.** On one node, a `bigserial` primary key is ideal (append to the rightmost B-tree page). In a range-partitioned distributed database it is a disaster: every insert lands in the *last* range, so one leaseholder takes all writes while other nodes idle. Fixes: UUIDs or `unique_rowid()` spread differently, hash-sharded indexes (`USING HASH` in CockroachDB), or prefixing the key with a well-distributed column (tenant, customer). YugabyteDB defaults the first primary-key column to **hash** sharding for exactly this reason; you opt into range sharding with `ASC`/`DESC`.

### Real-world example: a SaaS climbing the ladder

A B2B analytics SaaS with 8,000 tenants:

1. **Year 1 — rung 0/1.** One PG 16 primary (r6i.4xlarge-class), one sync standby in another AZ, two async read replicas for dashboards. 2 TB, 3,000 writes/s peak. Fine.
2. **Year 3 — write pressure.** 9 TB, 18,000 writes/s peak, vacuum on the events table runs for hours, index builds take a night. The team re-keys every table with `tenant_id` as the leading PK column (the expensive part — weeks of migration work), then moves to **Citus** with 16 workers. Tenant-scoped queries become router queries; the three largest tenants get isolated onto their own workers with `isolate_tenant_to_new_shard`. Cross-tenant admin reports become scatter queries run against a nightly copy.
3. **Year 5 — EU customers demand residency.** EU tenants must live in Frankfurt. Options: a separate EU Citus cluster (simple, but global admin views are now two systems), or a distributed SQL database with regional-by-row tables (Ch 17). They choose the separate cluster; the global control plane (accounts, billing) lives in a small multi-region CockroachDB cluster.

The lesson: each step was triggered by a **measured limit**, and the expensive, irreversible work was the *data model* change (tenant-first keys), not the product switch.

## 6. Advantages, Disadvantages & Trade-offs

| Architecture | Scales reads | Scales writes | Survives | Write latency (in-region) | Ops burden | Main cost |
| --- | --- | --- | --- | --- | --- | --- |
| Single node | vertical only | vertical only | nothing | ~1 ms | lowest | ceiling + no HA |
| Primary + replicas | yes | no | node/AZ (with failover) | ~1 ms async, +RTT sync | low-medium | lag, failover |
| App-level sharding | yes | yes | per-shard | ~1 ms (single shard) | very high | routing/resharding in code forever |
| Proxy (Vitess) | yes | yes | per-shard | ~1 ms + proxy hop | high | proxy tier, vindex design |
| Extension (Citus) | yes | yes | per-node (+HA per node) | ~1 ms + coordinator hop | medium-high | distribution column in every key |
| Distributed SQL | yes | yes | node/AZ/region | ~2–10 ms (consensus) | medium (fewer manual tasks, new failure modes) | per-write consensus, retries, cost |
| Shared storage (Aurora) | yes (replicas) | no (one writer) | AZ (storage 6-way) | ~1–2 ms | low (managed) | writer ceiling, vendor lock-in |

### When to use each rung

- **Stay on a single node + replicas** while write QPS fits one primary with headroom (commonly up to tens of thousands of simple writes/s) and data fits comfortably (low single-digit TB is routine; beyond ~10 TB operations get painful).
- **Shard with an extension or proxy** when you have a natural distribution key (tenant, customer) that covers nearly every hot query and you want to stay on PG/MySQL semantics and tooling.
- **Distributed SQL** when you need write scale *and* cross-entity transactions without a clean distribution key, multi-AZ/region survivability as a default, or automatic rebalancing because the data grows unpredictably.

### When NOT to use

- **Not distributed SQL** for a latency-critical, single-region, write-heavy workload that fits on one node — you pay consensus on every write for nothing.
- **Not app-level sharding** unless you have no alternative; it is the most expensive rung to operate and the hardest to leave.
- **Not sharding at all** when the pain is really missing indexes, bloat, bad queries or connection storms — fix those first ([Ch 21 · Database Scaling](topic.html?p=21-database-scaling), [Ch 23 · Bottleneck Diagnosis](topic.html?p=23-bottleneck-diagnosis)).
- **Not shared-storage** as a write-scaling answer — Aurora-style architectures scale storage and reads, not writes.

## 7. Common Mistakes & Best Practices

- **Choosing the product before the distribution key.** People pick CockroachDB/Citus/Vitess, then discover their hottest queries join on three different keys. *Why it hurts:* every hot query becomes scatter-gather or a shuffle join. *Instead:* list the top 10 queries and transactions by frequency, choose the key that makes most of them single-shard, then pick the product.
- **Sequential primary keys on range-partitioned stores.** *Why it hurts:* one hot range absorbs all inserts. *Instead:* hash-sharded keys, UUIDs, or a distributed prefix.
- **Assuming distributed SQL = single-node latency.** *Why it hurts:* a request doing 20 sequential single-row writes goes from 20 ms to 100+ ms. *Instead:* batch writes, collapse round trips, and budget for per-statement consensus.
- **Not handling retryable errors.** CockroachDB and YugabyteDB default to SERIALIZABLE and return SQLSTATE 40001 on conflicts. *Why it hurts:* surfaced to users as 500s. *Instead:* wrap transactions in a retry loop with backoff (Ch 06, Ch 20).
- **Treating the coordinator as free.** Citus's coordinator and TiDB's PD are on the query path. *Why it hurts:* coordinator CPU saturates or PD becomes a latency floor. *Instead:* monitor them like primaries; give Citus coordinators HA, co-locate PD sensibly.
- **Scatter queries on the hot path.** *Why it hurts:* tail latency grows with shard count and total load multiplies. *Instead:* secondary lookup tables keyed by the other attribute, or a separate read model (CQRS, Ch 29).
- **Global uniqueness via cross-shard checks.** *Why it hurts:* a distributed transaction on every signup. *Instead:* a dedicated global table/range for the unique key, or a key design that embeds the shard.
- **Best practice:** make the distribution key the leading column of every primary key and index on sharded tables; keep a written "query shape budget" (which queries are allowed to scatter).

## 8. Production: Failure Scenarios, Monitoring & Scaling

### Failure scenarios

**The hot range.** At 9am a flash sale starts. p99 write latency on CockroachDB jumps from 8 ms to 900 ms and CPU on one node hits 100% while the other eight idle. Root cause: `orders` uses a timestamp-prefixed key, so all new orders land in one range whose leaseholder is on node 4. Load-based splitting helps only if the load is spread across keys in the range; with strictly increasing keys, the tail range keeps receiving everything. Fix: hash-sharded index on the timestamp column; longer term, key orders by customer.

**Stale range cache after rebalancing.** After adding three nodes, the cluster rebalances ranges. Clients see brief latency spikes and an increase in internal "not leaseholder" redirects. Root cause: gateways' cached range descriptors point to old leaseholders; each miss costs an extra round trip before refresh. Symptom is self-healing; the real risk is rebalancing I/O competing with foreground traffic. Fix: rate-limit rebalance/snapshot throughput and schedule node additions off-peak.

**Citus coordinator saturation.** A dashboard deploy starts issuing 400 scatter queries/s. Coordinator CPU pegs, every tenant's router queries slow down because they all pass through the coordinator. Fix: route dashboard traffic to a separate coordinator or query from workers directly (Citus supports querying from any node in recent versions), and cap scatter-query concurrency.

**Clock skew.** An NTP misconfiguration lets one CockroachDB node drift. Transactions start seeing more uncertainty restarts; if the offset exceeds the configured maximum, the node deliberately shuts itself down to protect consistency. Fix: monitor clock offset per node, use a reliable time source (cloud time sync services).

**PD unavailable (TiDB).** PD loses quorum; new transactions cannot get timestamps, so writes stall cluster-wide even though TiKV nodes are healthy. Lesson: the metadata tier is part of your availability math.

### What to monitor

| Signal | Why |
| --- | --- |
| Per-node and per-range QPS / CPU skew | hotspots show as skew, not as high averages |
| Leaseholder distribution, lease transfers/s | lease thrash = latency spikes |
| Raft proposal/commit latency, unhealthy/under-replicated ranges | consensus health; under-replicated = one more failure from unavailability |
| Transaction restarts / 40001 rate | contention and clock-uncertainty cost |
| Scatter vs router query ratio (Citus task count, VTGate scatter counts) | hot-path design drift |
| Metadata tier health (PD, YB-Master, topology server, coordinator) | single point of dependency |
| Clock offset per node | correctness guard in HLC systems |
| Rebalancing / snapshot bytes | background I/O stealing from foreground |

### Scaling notes

Adding a node to a distributed SQL cluster is an online operation, but data movement is not free: moving 10 TB at 100 MB/s is over a day of background I/O. Plan capacity so you add nodes at ~60–70% utilization, not 95%. For sharded PG/MySQL, the resharding workflow (Citus shard moves/splits, Vitess `Reshard`) is the operation you must rehearse; test it on a staging cluster with production-sized data before you need it.

## 9. Interview Questions

**Q: What limits push you from a single PostgreSQL node to primary + replicas, and what does that rung not fix?**
A: Read throughput and survivability push you to replicas: you add followers for read traffic and a standby for failover. It does not fix write throughput, because every write still goes through one primary with one WAL stream, and it does not fix data size, because every replica holds a full copy. It also adds stale reads from lag and a failover problem you now have to solve. If writes or data size are your limit, replicas are the wrong rung.

**Q: Compare application-level, proxy-level and extension-level sharding?**
A: Application-level puts the routing function, the shard map, cross-shard queries and resharding into your code, which is the most flexible and the most expensive to own forever. Proxy-level (Vitess over MySQL) moves routing and scatter-gather into a proxy tier with a metadata store, and provides online resharding workflows, at the cost of running that tier and learning its query limits. Extension-level (Citus in PostgreSQL) keeps you inside PG: a coordinator plans distributed queries using catalog metadata, with co-location and reference tables as first-class concepts. All three still require you to pick a distribution key well, and all leave cross-shard transactions more expensive than local ones.

**Q: Why does a single-row write cost more on CockroachDB or YugabyteDB than on a single PostgreSQL node?**
A: Every write is replicated through the Raft group of the range it touches, and it is acknowledged only after a majority of replicas have persisted it. With replicas spread across availability zones, that is at least one cross-AZ round trip plus fsyncs on each replica, on top of normal SQL work. There may also be a hop from the gateway node to the leaseholder. So a write that commits in ~1 ms locally typically takes several milliseconds in-region, and far more if the quorum spans regions. You pay this even when there is no contention.

**Q: What is a leaseholder and why do reads not need a consensus round?**
A: A leaseholder is the one replica of a range that currently holds a time-bounded lease allowing it to serve reads and coordinate writes. Because the lease guarantees no other replica can be accepting newer writes during the lease period, the leaseholder can answer consistent reads from its local state without asking a majority. In CockroachDB the leaseholder is normally co-located with the Raft leader so writes don't need an extra hop. If the lease holder is far from the client, you pay a network hop per read, which is why lease placement matters in multi-region designs.

**Q: What is scatter-gather and why is it dangerous on a hot path?**
A: Scatter-gather sends a query to every shard and merges the results at the coordinator. Its latency is the latency of the slowest shard, so tail latency gets worse as you add shards, and its load is N queries for one logical query, so adding shards does not increase capacity for that query shape. With pushdown of filters and partial aggregates, the network cost may be small, but the fan-out cost remains. It is fine for rare admin or reporting queries, and a scaling bug when a top-10 query does it.

**Q: Explain the join strategies a distributed database can use?**
A: A co-located join runs locally on each node because both tables are distributed on the join key; it has no network cost. A broadcast or reference-table join replicates a small table to every node so any node can join against it locally. A repartition (shuffle) join re-hashes one or both sides across the network on the join key, which can move huge volumes. A lookup join probes a remote index per driving row, batched. Schema design aims to make hot joins co-located or reference joins.

**Q: How do distributed databases know which node holds a key?**
A: Through a metadata layer: a static function in the app, a proxy's shard map backed by a topology service (Vitess with etcd/ZooKeeper), a placement driver (TiDB PD, Spanner's placement driver), a master service (YugabyteDB YB-Master), or range descriptors stored in special system ranges (CockroachDB meta ranges). In every good design this metadata is consensus-replicated and cached by the query path, and a "wrong node" response triggers a cache refresh. A synchronous metadata lookup on every query would make the metadata service the bottleneck.

**Q: Why are sequential primary keys a problem in distributed SQL but fine in PostgreSQL? (Senior)**
A: In PostgreSQL, a monotonically increasing key appends to the rightmost B-tree leaf, which stays hot in cache and minimizes page splits — ideal. In a range-partitioned distributed database, keys are split into contiguous ranges, so every new key falls into the last range and a single leaseholder takes all insert traffic while other nodes idle. Splitting the range does not help because the new tail range immediately becomes the hotspot. Fixes are hash-sharded indexes, UUIDs, or prefixing keys with a well-distributed column like tenant or customer. YugabyteDB sidesteps it by hash-sharding the first key column by default.

**Q: A team wants to move a 3 TB, 5,000-writes/s single-region PostgreSQL database to a distributed SQL database "for scale". How do you respond? (Senior)**
A: I would first ask what limit they are hitting, because 3 TB and 5,000 writes/s fit comfortably on one well-provisioned PostgreSQL primary with replicas. If the real problem is slow queries, bloat, or connection storms, distributed SQL makes those harder, not easier, and adds per-write consensus latency and retryable serialization errors. If the driver is survivability, a sync standby with automated failover or a managed Multi-AZ setup solves it more cheaply. I would support distributed SQL if there is a credible growth path to write volumes or data sizes a single node cannot handle, a need for multi-region active writes, or a lack of a clean shard key that rules out Citus/Vitess. Either way I would prototype the top transactions on the target and measure p99 latency and retry rates before committing.

**Q: How would you design a multi-tenant schema so it runs well on Citus or CockroachDB? (Senior)**
A: Make `tenant_id` the leading column of every tenant-scoped table's primary key, foreign keys and hot indexes, and distribute or partition all those tables by it so they are co-located. Then every tenant's joins, foreign-key checks and transactions stay on one node, and queries are router queries. Small shared lookup tables become reference or global tables. Truly cross-tenant queries go to a separate analytics path. Large tenants can be isolated onto dedicated shards or nodes to avoid noisy neighbours. The expensive part is the migration to tenant-first keys, so do it before you need the distributed database.

**Q: How do Spanner, CockroachDB and TiDB order transactions across machines? (Senior)**
A: Spanner uses TrueTime, which exposes clock uncertainty as an interval backed by GPS and atomic clocks; a committing transaction waits out the uncertainty (commit wait) so timestamps are externally consistent. CockroachDB uses hybrid logical clocks with a configured maximum clock offset; a read that encounters a value within its uncertainty window restarts at a higher timestamp, and nodes that drift too far shut themselves down. TiDB uses a centralized timestamp oracle in PD, which gives simple total ordering at the cost of a round trip to PD for timestamps. Each design trades specialised hardware, occasional restarts, or a central dependency.

**Q: Your Citus cluster's p99 got worse after adding workers. How do you investigate?**
A: Check how the hot queries execute: EXPLAIN them and look at Task Count. If important queries are scatter queries, more workers means more tasks per query and worse tail latency, plus more load on the coordinator. Check coordinator CPU and connection counts to workers, since the adaptive executor opens connections per task. Then verify that shards actually rebalanced onto new workers and that the hottest tenants aren't still on one node. The fix is usually query shape (add the distribution column to WHERE clauses) or tenant isolation, not more hardware.

## 10. Quick Revision & Cheat Sheet

| Rung | Scales | Adds | Typical write latency | Pick when |
| --- | --- | --- | --- | --- |
| 0 Single node | vertical | — | ~1 ms | it fits |
| 1 Primary + replicas | reads | lag, failover | ~1 ms (+RTT if sync) | read-heavy, need HA |
| 2 Sharded (app/proxy/ext) | reads + writes | router, shard map, cross-shard txns | ~1 ms + hop | clean shard key, stay on PG/MySQL |
| 3 Distributed SQL | reads + writes | consensus, placement, HLC/TrueTime/TSO | ~2–10 ms | write scale + transactions, no clean key |
| 4 Multi-region | survivability | cross-region quorum or async | +30–150 ms if quorum crosses | region loss unacceptable |
| 5 Global | locality | row homing, global tables | local for home region | global users + residency |

- Climb one rung at a time, triggered by a measured limit.
- Every distributed DB answers: where is K, who writes K, what time is it, how does a multi-key query run.
- The metadata service must be small, replicated and cached.
- Consensus on every write sets the latency floor; reads avoid it via leases.
- Router queries scale; scatter-gather doesn't; shuffle joins are the most expensive.
- The distribution key is the schema decision — co-locate everything that joins or commits together.
- Sequential keys create hot ranges in range-partitioned stores.
- SERIALIZABLE-by-default systems return 40001; retry loops are mandatory.

## 11. Hands-On Exercises

1. **Router vs scatter on Citus.** Run `docker run -d --name citus -p 5432:5432 -e POSTGRES_PASSWORD=pw citusdata/citus:latest` (single-node Citus; coordinator acts as worker). Create the `customers`/`orders`/`plans` schema above, load 1M orders with `generate_series`, and compare `EXPLAIN ANALYZE` Task Count and timing for a query with and without `customer_id` in the WHERE.
2. **Co-located vs non-co-located.** Create `shipments` distributed by `warehouse_id` and join it to `orders` on `order_id`. Observe the error or repartition plan Citus produces, then redistribute `shipments` by `customer_id` and compare.
3. **Ranges on CockroachDB.** Start a 3-node local cluster with `cockroach start --insecure --join=...` (or `cockroach demo --nodes=3`). Create the `orders` table, insert 2M rows, run `SHOW RANGES FROM TABLE orders`, and watch the range count grow. Then set a sequential key and compare per-node QPS in the DB Console during an insert-heavy load.
4. **Hash-sharded index.** On the same cluster, create an index `USING HASH` on a timestamp column and rerun the insert load; compare how writes spread across nodes.
5. **App-level sharding pain.** Take the Python router above, change `len(SHARDS)` from 4 to 5, and compute how many of 100,000 customer ids change shard. Repeat with a consistent-hashing ring (Ch 12) and compare.

**Mini project — "Ladder simulator".** Write a small benchmark harness (Go or Python) that runs the same workload — 80% single-customer reads, 15% single-customer writes, 5% cross-customer report — against (a) single-node PG, (b) Citus with 4 workers in Docker, (c) a 3-node CockroachDB. Report p50/p99 per query type and the retry rate. Write one paragraph per system explaining the numbers in terms of hops, consensus and fan-out.

## 12. Related Topics & Free Learning Resources

**This handbook:** [Ch 01 · Database Architecture](topic.html?p=01-database-architecture) · [Ch 09 · Database Replication](topic.html?p=09-replication) · [Ch 11 · Partitioning](topic.html?p=11-partitioning) · [Ch 12 · Sharding](topic.html?p=12-sharding) · [Ch 13 · Distributed Transactions](topic.html?p=13-distributed-transactions) · [Ch 14 · CAP Theorem](topic.html?p=14-cap-theorem) · [Ch 15 · Consensus](topic.html?p=15-consensus) · [Ch 17 · Multi-Region Databases](topic.html?p=17-multi-region-databases) · [Ch 18 · High Availability](topic.html?p=18-high-availability) · [Ch 21 · Database Scaling](topic.html?p=21-database-scaling) · [Ch 40 · Case Study: Multi-tenant SaaS](topic.html?p=40-case-multi-tenant-saas)

**SQL Handbook:** [Partitioning](../sql/topic.html?p=23-partitioning) · [Execution Plans](../sql/topic.html?p=22-execution-plans) · [Schema Design](../sql/topic.html?p=30-schema-design)

**Other handbooks:** [System Design · Database Scaling](../system-design/topic.html?p=16-database-scaling) · [System Design · Consistent Hashing](../system-design/topic.html?p=17-consistent-hashing) · [System Design · Consensus](../system-design/topic.html?p=20-consensus) · [Cassandra · Ring, Tokens & Consistent Hashing](../cassandra/topic.html?p=18-ring-tokens-consistent-hashing)

- **Spanner: Google's Globally-Distributed Database** — Corbett et al., OSDI 2012 · *Advanced* · the paper that defined distributed SQL: Paxos groups, TrueTime and commit wait. <https://static.googleusercontent.com/media/research.google.com/en//archive/spanner-osdi2012.pdf>
- **CockroachDB Architecture Overview** — Cockroach Labs docs · *Intermediate* · ranges, Raft, leaseholders and the layered design, clearly explained. <https://www.cockroachlabs.com/docs/stable/architecture/overview>
- **Life of a Distributed Transaction** — Cockroach Labs docs · *Advanced* · one query traced through gateway, leaseholder, Raft and intent resolution. <https://www.cockroachlabs.com/docs/stable/architecture/life-of-a-distributed-transaction>
- **TiDB Architecture** — PingCAP docs · *Intermediate* · TiDB server, TiKV and PD as separate tiers, including the timestamp oracle. <https://docs.pingcap.com/tidb/stable/tidb-architecture>
- **YugabyteDB Architecture** — Yugabyte docs · *Intermediate* · YB-Master, YB-TServer, DocDB tablets and how YSQL reuses PostgreSQL. <https://docs.yugabyte.com/preview/architecture/>
- **Citus Documentation** — Citus Data · *Intermediate* · distribution columns, co-location, reference tables and the multi-tenant model on PostgreSQL. <https://docs.citusdata.com/>
- **Vitess Documentation** — Vitess · *Intermediate* · keyspaces, vindexes, VTGate and online resharding for MySQL. <https://vitess.io/docs/>
- **Designing Data-Intensive Applications, ch. 5–6 & 9** — Martin Kleppmann · *Advanced* · replication, partitioning and consistency as one coherent story. <https://dataintensive.net/>

---

*Database Design Handbook — chapter 16.*
