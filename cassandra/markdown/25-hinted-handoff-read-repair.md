# 25 · Hinted Handoff, Read Repair & Anti-Entropy

> **In one line:** Cassandra keeps replicas convergent with three layered mechanisms — hints replay writes a node missed, read repair fixes divergence discovered on the read path, and anti-entropy repair sweeps everything else with Merkle trees.

---

## 1. Overview

Cassandra is an **AP** system in the CAP sense: it accepts writes even when some replicas are unreachable. That choice buys availability, but it creates an obligation — the cluster must eventually make those replicas agree again. Eventual consistency is not a hand-wave; it is a set of three concrete, named, tunable mechanisms that run at three different timescales. If you cannot name all three and say when each fires, you do not yet understand Cassandra's durability story.

The problem they solve is simple to state and hard to solve well. Suppose `RF=3` and a client writes at `LOCAL_QUORUM`. Two replicas ack, the coordinator returns success, and the third replica was in a GC pause, rebooting, or partitioned away. That replica now holds stale data. If nothing repairs it, a later `LOCAL_QUORUM` read can hit the stale replica plus one current replica — quorum math still saves you (`R + W > RF` ⇒ `2 + 2 > 3`), but a `ONE` read will serve stale data forever, and worse, a **deleted row can resurrect** when the tombstone expires after `gc_grace_seconds` on the nodes that did receive it.

The three mechanisms layer by timescale. **Hinted handoff** operates in seconds-to-hours: the coordinator stores the missed mutation locally as a *hint* and replays it when the node returns. **Read repair** operates at read time: when a read touches multiple replicas and their digests disagree, the coordinator reconciles and pushes the merged result back. **Anti-entropy repair** (`nodetool repair`) operates on a schedule of days: it builds Merkle trees over token ranges, compares them across replicas, and streams only the mismatched ranges. Hints and read repair are *best-effort optimizations*; only anti-entropy repair is a **correctness guarantee**.

Historically, all three date to the Dynamo lineage. The 2007 Dynamo paper described hinted handoff and Merkle-tree anti-entropy almost exactly as Cassandra implements them; read repair is Cassandra's own addition, sharpened over a decade. The big modern changes: Cassandra 3.0 moved hints from a system table into flat files under `hints_directory` (CASSANDRA-6230), and Cassandra 4.0 removed the old asynchronous background `read_repair_chance` / `dclocal_read_repair_chance` table options entirely (CASSANDRA-13910), replacing them with the per-read `read_repair` option (`BLOCKING` default, or `NONE`).

Concretely: Discord's message cluster runs `RF=3` across a single DC with `LOCAL_QUORUM` reads and writes. A rolling kernel upgrade takes each node down for ~4 minutes. During each window the two surviving replicas serve traffic and the coordinators accumulate hints for the down node — roughly `4 min × 200k writes/s × (1/3 of writes touching that node)` worth of mutations. When the node returns, hint replay drains in a few minutes and the cluster is convergent without any repair being needed. But if a node is down for **more than `max_hint_window` (3 hours by default)**, hints stop being recorded and only a full repair can close the gap — which is exactly why "node down > 3h ⇒ repair it or replace it" is the operational rule of thumb.

## 2. Core Concepts

- **Hinted handoff** — when a replica is down (or times out), the coordinator writes the mutation plus its target to a local hint file and replays it to the target when gossip marks it UP.
- **`max_hint_window_in_ms`** — how long hints keep being *recorded* for a down node. Default `10800000` (3 hours) in 4.x. Past this, the coordinator stops writing hints for that node entirely.
- **Read repair** — during a read, if replica responses disagree, the coordinator merges by last-write-wins timestamp and writes the reconciled version back to stale replicas.
- **Blocking read repair** — the coordinator *waits* for the repair mutations to be acknowledged by enough replicas before returning to the client. This is what makes `QUORUM` monotonic. Default in 4.x (`read_repair = 'BLOCKING'`).
- **Digest request** — a read at `CL > ONE` sends one full data request and N−1 *digest* requests (an MD5 of the reconciled result). Cheap comparison; a mismatch triggers a full data fetch from all replicas.
- **Anti-entropy repair** — `nodetool repair`: builds Merkle trees per token range per replica, diffs them, and streams the differing sub-ranges. The only mechanism that guarantees convergence.
- **Merkle tree** — a binary hash tree over a token range. Cassandra's default is `2^15 = 32768` leaves per range, so each leaf covers a slice of the range; a single differing row dirties one leaf and forces streaming of that whole leaf's range.
- **`gc_grace_seconds`** — default `864000` (10 days). Tombstones survive at least this long so repair can propagate the delete. Repair must complete within this window or deleted data resurrects.
- **Speculative retry** — a per-table setting (`99p` default) that sends an extra read to another replica when the first is slow. Not a repair mechanism, but it interacts with read repair by widening the replica set consulted.
- **Convergence** — the state where all replicas of a token range hold identical data at identical timestamps. Hints and read repair narrow the gap; repair closes it.

## 3. Theory & Internals

**Why hints are not enough.** A hint only exists if a coordinator *observed* the failure. Three cases defeat hints: (a) the node was down longer than `max_hint_window`; (b) the coordinator itself crashed before replaying its hint file; (c) the write never reached a coordinator that knew about the target — e.g. a network partition where the coordinator considers the node UP and the write silently times out after the hint window expired. Hints are stored under `hints_directory` (default `$CASSANDRA_HOME/data/hints`) as `<host-id>-<timestamp>-<version>.hints` files, written by `HintsService`, and are subject to `hinted_handoff_throttle_in_kb` (default 1024 KB/s **per delivery thread across the cluster**) and `max_hints_delivery_threads` (default 2).

**The read path and digest mismatch.** For a read at `CL=LOCAL_QUORUM` with `RF=3`, the coordinator picks replicas ordered by the dynamic snitch, sends a **data read** to the closest and **digest reads** to the rest. Each replica reconciles its own memtable + SSTables and returns either the full result or `MD5(result)`. If digests match, the coordinator returns the data read. If they differ, the coordinator issues full data reads to all responding replicas, merges cell-by-cell by write timestamp (ties broken by value byte comparison), and — under `BLOCKING` read repair — sends the delta as mutations to the stale replicas and **waits for `CL` acks** before responding.

That blocking behaviour is what gives you **monotonic quorum reads**. Without it, two successive `QUORUM` reads could see new-then-old data, because the first read's repair might not have landed. Cassandra 4.0 made blocking the only mode precisely because the old probabilistic background repair provided no such guarantee and created surprising latency spikes.

**Read repair does not cover what you do not read.** Cold data — rows never read — is never repaired by read repair. This is the single most common misconception. A table with a long tail of untouched partitions will silently diverge no matter how much traffic it serves.

**Merkle tree math.** For a token range, Cassandra hashes each row (partition key + row content) into a leaf, then hashes upward. With `2^15` leaves and a range holding, say, 32 M rows, each leaf covers ~1000 rows. Comparing two trees is `O(log n)` in the number of *differing* subtrees but the streaming granularity is the leaf: **one changed row streams ~1000 rows**. This over-streaming is why repair on a large node is expensive and why subrange repair (splitting the range so each tree covers less data) is the standard mitigation.

```svg
<svg viewBox="0 0 780 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="a25a" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="390" y="20" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">Three Convergence Mechanisms by Timescale</text>

  <rect x="20" y="40" width="230" height="120" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="135" y="62" text-anchor="middle" fill="#1e293b" font-weight="700">Hinted Handoff</text>
  <text x="135" y="82" text-anchor="middle" fill="#1e293b">seconds to 3 hours</text>
  <text x="135" y="100" text-anchor="middle" fill="#1e293b">coordinator stores hint</text>
  <text x="135" y="118" text-anchor="middle" fill="#1e293b">replays when node UP</text>
  <text x="135" y="140" text-anchor="middle" fill="#0369a1" font-weight="700">best effort</text>

  <rect x="275" y="40" width="230" height="120" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="390" y="62" text-anchor="middle" fill="#1e293b" font-weight="700">Read Repair</text>
  <text x="390" y="82" text-anchor="middle" fill="#1e293b">at read time, inline</text>
  <text x="390" y="100" text-anchor="middle" fill="#1e293b">digest mismatch triggers</text>
  <text x="390" y="118" text-anchor="middle" fill="#1e293b">merge + write back</text>
  <text x="390" y="140" text-anchor="middle" fill="#15803d" font-weight="700">only what you read</text>

  <rect x="530" y="40" width="230" height="120" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="645" y="62" text-anchor="middle" fill="#1e293b" font-weight="700">Anti-Entropy Repair</text>
  <text x="645" y="82" text-anchor="middle" fill="#1e293b">scheduled, days</text>
  <text x="645" y="100" text-anchor="middle" fill="#1e293b">Merkle tree diff</text>
  <text x="645" y="118" text-anchor="middle" fill="#1e293b">streams mismatched ranges</text>
  <text x="645" y="140" text-anchor="middle" fill="#b45309" font-weight="700">the guarantee</text>

  <text x="390" y="195" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="700">Merkle Tree Comparison (replica A vs replica B)</text>

  <circle cx="200" cy="225" r="16" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="200" y="230" text-anchor="middle" fill="#1e293b" font-size="10">R</text>
  <circle cx="150" cy="275" r="15" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="150" y="279" text-anchor="middle" fill="#1e293b" font-size="10">h1</text>
  <circle cx="250" cy="275" r="15" fill="#fee2e2" stroke="#dc2626"/>
  <text x="250" y="279" text-anchor="middle" fill="#1e293b" font-size="10">h2</text>
  <circle cx="120" cy="325" r="13" fill="#eef2ff" stroke="#4f46e5"/>
  <circle cx="180" cy="325" r="13" fill="#eef2ff" stroke="#4f46e5"/>
  <circle cx="220" cy="325" r="13" fill="#eef2ff" stroke="#4f46e5"/>
  <circle cx="280" cy="325" r="13" fill="#fee2e2" stroke="#dc2626"/>
  <line x1="200" y1="241" x2="150" y2="260" stroke="#475569"/>
  <line x1="200" y1="241" x2="250" y2="260" stroke="#475569"/>
  <line x1="150" y1="290" x2="120" y2="312" stroke="#475569"/>
  <line x1="150" y1="290" x2="180" y2="312" stroke="#475569"/>
  <line x1="250" y1="290" x2="220" y2="312" stroke="#475569"/>
  <line x1="250" y1="290" x2="280" y2="312" stroke="#475569"/>

  <circle cx="560" cy="225" r="16" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="560" y="230" text-anchor="middle" fill="#1e293b" font-size="10">R</text>
  <circle cx="510" cy="275" r="15" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="510" y="279" text-anchor="middle" fill="#1e293b" font-size="10">h1</text>
  <circle cx="610" cy="275" r="15" fill="#fee2e2" stroke="#dc2626"/>
  <text x="610" y="279" text-anchor="middle" fill="#1e293b" font-size="10">h2'</text>
  <circle cx="480" cy="325" r="13" fill="#eef2ff" stroke="#4f46e5"/>
  <circle cx="540" cy="325" r="13" fill="#eef2ff" stroke="#4f46e5"/>
  <circle cx="580" cy="325" r="13" fill="#eef2ff" stroke="#4f46e5"/>
  <circle cx="640" cy="325" r="13" fill="#fee2e2" stroke="#dc2626"/>
  <line x1="560" y1="241" x2="510" y2="260" stroke="#475569"/>
  <line x1="560" y1="241" x2="610" y2="260" stroke="#475569"/>
  <line x1="510" y1="290" x2="480" y2="312" stroke="#475569"/>
  <line x1="510" y1="290" x2="540" y2="312" stroke="#475569"/>
  <line x1="610" y1="290" x2="580" y2="312" stroke="#475569"/>
  <line x1="610" y1="290" x2="640" y2="312" stroke="#475569"/>

  <line x1="300" y1="325" x2="460" y2="325" stroke="#dc2626" stroke-width="2" marker-end="url(#a25a)"/>
  <text x="380" y="318" text-anchor="middle" fill="#b91c1c" font-weight="700">stream only this leaf range</text>
</svg>
```

## 4. Architecture & Workflow

**Hinted handoff, step by step.**

1. Client sends `INSERT` at `LOCAL_QUORUM`; coordinator computes the 3 natural replicas via the partitioner and `NetworkTopologyStrategy`.
2. Coordinator dispatches mutations to all 3. Replica C is DOWN per the failure detector (or times out after `write_request_timeout_in_ms`, default 2000 ms).
3. Replicas A and B ack. `LOCAL_QUORUM` (2) satisfied ⇒ coordinator returns success to the client.
4. Coordinator serialises the mutation plus target host-id into its local hints file, provided the node has been down for less than `max_hint_window_in_ms`.
5. Gossip marks C UP. `HintsDispatchExecutor` opens the hint files targeting C and replays them, throttled by `hinted_handoff_throttle_in_kb`.
6. Successfully delivered hints are deleted. `nodetool tpstats` shows `HintsDispatcher` activity; `HintsService` JMX exposes `HintsSucceeded` / `HintsFailed`.

**Blocking read repair, step by step.**

1. Client reads at `LOCAL_QUORUM`. Coordinator ranks replicas by dynamic snitch latency.
2. Full **data read** to replica A; **digest reads** to B (and C if speculative retry fires).
3. A returns rows; B returns `MD5` digest of its reconciled view.
4. Digests differ ⇒ coordinator issues full data reads to A and B.
5. Coordinator merges: for each cell, highest write timestamp wins; tombstones win ties against same-timestamp data.
6. Coordinator sends **repair mutations** containing only the missing/stale cells to the out-of-date replicas.
7. Under `BLOCKING`, coordinator waits for `CL` acks on those mutations, then returns the merged rows to the client. Metric `ReadRepairStage` / `org.apache.cassandra.metrics:type=ReadRepair,name=RepairedBlocking` increments.

**Anti-entropy repair, step by step.**

1. Operator runs `nodetool repair -pr -full keyspace table` on node N.
2. N acts as repair coordinator: for each token range it owns, it identifies the replica set.
3. Each replica performs a **validation compaction** — a full read of the SSTables covering that range — hashing rows into a Merkle tree. This is CPU + I/O heavy and shows in `nodetool compactionstats` as `Validation`.
4. Replicas ship their trees to the coordinator, which diffs them.
5. For each differing leaf, the coordinator schedules **streaming sessions** between the disagreeing replicas (`nodetool netstats` shows progress).
6. Streamed SSTables land as new files; normal compaction folds them in.
7. Repair session completes; with incremental repair the involved SSTables are marked *repaired* (their `repairedAt` timestamp set) so future incremental runs skip them.

```svg
<svg viewBox="0 0 800 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="a25b" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="400" y="20" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">Write with Hint, then Read Repair</text>

  <rect x="20" y="45" width="110" height="50" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="75" y="68" text-anchor="middle" fill="#1e293b" font-weight="700">Client</text>
  <text x="75" y="85" text-anchor="middle" fill="#64748b" font-size="10">LOCAL_QUORUM</text>

  <rect x="180" y="45" width="130" height="50" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="245" y="68" text-anchor="middle" fill="#1e293b" font-weight="700">Coordinator</text>
  <text x="245" y="85" text-anchor="middle" fill="#64748b" font-size="10">node 1</text>

  <rect x="400" y="35" width="110" height="40" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="455" y="60" text-anchor="middle" fill="#1e293b" font-weight="700">Replica A ok</text>
  <rect x="400" y="88" width="110" height="40" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="455" y="113" text-anchor="middle" fill="#1e293b" font-weight="700">Replica B ok</text>
  <rect x="400" y="141" width="110" height="40" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="455" y="166" text-anchor="middle" fill="#1e293b" font-weight="700">Replica C DOWN</text>

  <line x1="130" y1="70" x2="175" y2="70" stroke="#475569" marker-end="url(#a25b)"/>
  <line x1="310" y1="62" x2="395" y2="55" stroke="#16a34a" marker-end="url(#a25b)"/>
  <line x1="310" y1="75" x2="395" y2="108" stroke="#16a34a" marker-end="url(#a25b)"/>
  <line x1="310" y1="88" x2="395" y2="158" stroke="#dc2626" stroke-dasharray="4 3" marker-end="url(#a25b)"/>

  <rect x="180" y="130" width="130" height="46" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="245" y="150" text-anchor="middle" fill="#1e293b" font-weight="700">hints file</text>
  <text x="245" y="167" text-anchor="middle" fill="#64748b" font-size="10">target = C</text>
  <line x1="245" y1="95" x2="245" y2="126" stroke="#d97706" marker-end="url(#a25b)"/>

  <line x1="313" y1="153" x2="395" y2="168" stroke="#d97706" stroke-dasharray="5 4" marker-end="url(#a25b)"/>
  <text x="355" y="196" text-anchor="middle" fill="#b45309" font-size="10">replay on UP</text>

  <line x1="20" y1="215" x2="780" y2="215" stroke="#cbd5e1"/>

  <text x="400" y="240" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="700">Later: read at LOCAL_QUORUM finds divergence</text>

  <rect x="180" y="258" width="130" height="46" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="245" y="279" text-anchor="middle" fill="#1e293b" font-weight="700">Coordinator</text>
  <text x="245" y="296" text-anchor="middle" fill="#64748b" font-size="10">merge by timestamp</text>

  <rect x="430" y="248" width="150" height="36" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="505" y="271" text-anchor="middle" fill="#1e293b">A: full data read</text>
  <rect x="430" y="292" width="150" height="36" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="505" y="315" text-anchor="middle" fill="#1e293b">C: digest MISMATCH</text>

  <line x1="310" y1="272" x2="425" y2="266" stroke="#475569" marker-end="url(#a25b)"/>
  <line x1="310" y1="290" x2="425" y2="308" stroke="#475569" marker-end="url(#a25b)"/>
  <line x1="580" y1="310" x2="680" y2="310" stroke="#dc2626" stroke-width="2" marker-end="url(#a25b)"/>
  <rect x="620" y="248" width="160" height="40" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="700" y="272" text-anchor="middle" fill="#1e293b" font-weight="700">blocking repair write</text>
  <line x1="700" y1="300" x2="700" y2="292" stroke="#dc2626" marker-end="url(#a25b)"/>
  <text x="700" y="330" text-anchor="middle" fill="#b91c1c" font-size="10">wait for CL acks, then reply</text>
</svg>
```

## 5. Implementation

Set up a table and inspect repair behaviour end to end.

```cql
CREATE KEYSPACE IF NOT EXISTS shop
  WITH replication = {'class':'NetworkTopologyStrategy','dc1':3};

CREATE TABLE shop.orders (
  customer_id uuid,
  order_id    timeuuid,
  total_cents bigint,
  status      text,
  PRIMARY KEY ((customer_id), order_id)
) WITH CLUSTERING ORDER BY (order_id DESC)
  AND read_repair = 'BLOCKING'
  AND gc_grace_seconds = 864000
  AND speculative_retry = '99p';

-- Disable read repair on a table where you accept staleness and want
-- zero extra write amplification (rare; be deliberate).
ALTER TABLE shop.orders WITH read_repair = 'NONE';
ALTER TABLE shop.orders WITH read_repair = 'BLOCKING';
```

Relevant `cassandra.yaml` knobs:

```yaml
# Hinted handoff
hinted_handoff_enabled: true
max_hint_window_in_ms: 10800000        # 3 hours
hinted_handoff_throttle_in_kb: 1024    # per delivery thread, cluster-wide budget
max_hints_delivery_threads: 2
hints_directory: /var/lib/cassandra/hints
hints_flush_period_in_ms: 10000
max_hints_file_size_in_mb: 128

# Repair / streaming
stream_throughput_outbound_megabits_per_sec: 200
inter_dc_stream_throughput_outbound_megabits_per_sec: 100
compaction_throughput_mb_per_sec: 64
```

Operational commands:

```bash
# Are hints piling up for a node?
nodetool statushandoff
# Output: Hinted handoff is running

nodetool tpstats | grep -i hint
# HintsDispatcher                   0         0            418         0                 0

# Drop hints you no longer want (e.g. node is being replaced, not returning)
nodetool truncatehints                 # all nodes' hints on this node
nodetool truncatehints 10.0.1.42       # hints for one endpoint only

# Pause/resume hint delivery during an incident
nodetool pausehandoff
nodetool resumehandoff

# Anti-entropy: primary-range full repair of one table
nodetool repair -pr -full shop orders
# [2026-07-22 09:14:02,113] Starting repair command #7, repairing 16 ranges
# [2026-07-22 09:16:41,908] Repair session ... finished
# [2026-07-22 09:16:41,910] Repair command #7 finished in 2 minutes 39 seconds

# Watch validation + streaming while it runs
watch -n2 'nodetool compactionstats; nodetool netstats | head -20'
```

Driver-side: read repair is server-side, but consistency level is your lever.

```python
from cassandra.cluster import Cluster, ExecutionProfile, EXEC_PROFILE_DEFAULT
from cassandra.policies import DCAwareRoundRobinPolicy, TokenAwarePolicy
from cassandra import ConsistencyLevel

profile = ExecutionProfile(
    load_balancing_policy=TokenAwarePolicy(DCAwareRoundRobinPolicy(local_dc="dc1")),
    consistency_level=ConsistencyLevel.LOCAL_QUORUM,   # R + W > RF with LOCAL_QUORUM writes
    request_timeout=10.0,
)
cluster = Cluster(["10.0.1.10"], execution_profiles={EXEC_PROFILE_DEFAULT: profile})
session = cluster.connect("shop")

stmt = session.prepare("SELECT order_id, total_cents FROM orders WHERE customer_id = ?")
rows = session.execute(stmt, [customer_id])
# A digest mismatch here triggers a BLOCKING read repair transparently;
# the extra latency shows up in ClientRequest.Read.Latency p99, not in an error.
```

Trigger and observe a divergence deliberately (single-host lab, ccm):

```bash
ccm create rrlab -v 4.1.5 -n 3 -s
ccm node3 stop
cqlsh -e "CONSISTENCY LOCAL_QUORUM; INSERT INTO shop.orders (customer_id, order_id, total_cents, status)
          VALUES (11111111-1111-1111-1111-111111111111, now(), 4999, 'PAID');"
ccm node3 start
ccm node3 nodetool statushandoff
# Verify node3 got the row via hint replay:
ccm node3 cqlsh -e "CONSISTENCY ONE; SELECT * FROM shop.orders
                    WHERE customer_id = 11111111-1111-1111-1111-111111111111;"
```

> **Optimization:** the single highest-leverage tuning here is **subrange repair**. `nodetool repair -st <start> -et <end>` bounds each Merkle tree to a small slice, so a mismatch streams kilobytes instead of gigabytes, validation compactions stay short, and a failed session costs you minutes not hours. Cassandra Reaper automates exactly this pattern — segment the ring, run segments serially with backoff, resume on failure. Pair it with `stream_throughput_outbound_megabits_per_sec` capped well under your NIC so repair never starves client traffic.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost/Trade-off |
|---|---|---|
| Hinted handoff | Absorbs short outages (restarts, GC pauses) with zero operator action; keeps `LOCAL_QUORUM` writes succeeding | Hints consume coordinator disk and replay I/O; useless past `max_hint_window`; a coordinator crash loses its hints silently |
| Blocking read repair | Gives monotonic quorum reads; repairs hot data continuously and for free | Adds write amplification and tail latency to reads that hit a mismatch; can turn a read-heavy p99 spiky |
| `read_repair = 'NONE'` | Removes repair write-back latency entirely | Loses monotonicity; quorum reads may go backwards in time. Only for tables where staleness is genuinely fine |
| Anti-entropy repair | The only *guarantee* of convergence; the only thing that prevents zombie data | Validation compaction is CPU + disk heavy; over-streaming at leaf granularity; must finish inside `gc_grace_seconds` |
| Incremental repair | Skips already-repaired SSTables — much cheaper on steady-state clusters | Historically fragile (pre-4.0 anticompaction bugs); splits SSTables into repaired/unrepaired pools which complicates compaction |
| Subrange repair | Small trees, small streams, resumable | Requires orchestration (token math or Reaper); more sessions to schedule and monitor |
| High `RF` | More redundancy, more read-repair opportunities | Repair cost grows with `RF`; more replicas to converge, more streaming |
| Long `gc_grace_seconds` | Bigger safety window for repair scheduling | Tombstones live longer ⇒ more tombstone scanning on reads, bigger SSTables |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Assuming read repair keeps the cluster consistent.** → ✅ Read repair only touches data you read. Cold partitions never converge from it. Schedule anti-entropy repair regardless of read volume.
2. ⚠️ **Never running repair, then being surprised by resurrected deletes.** → ✅ Run repair on every table with deletes/TTLs at least once every `gc_grace_seconds` (default 10 days ⇒ run weekly). Missing this is the #1 cause of "the deleted row came back".
3. ⚠️ **Bringing a node back after a multi-day outage.** → ✅ Past `max_hint_window` (3 h) the node's data is arbitrarily stale, and it will immediately serve stale reads. Either repair it before it takes traffic, or `nodetool removenode` and rebuild it as a replacement.
4. ⚠️ **Running `nodetool repair` with no flags on every node.** → ✅ Without `-pr`, every node repairs *all* ranges it replicates, so each range gets repaired `RF` times. Use `-pr` (primary range) on every node, or use Reaper.
5. ⚠️ **Running `-pr` on a subset of nodes.** → ✅ `-pr` only covers each node's primary ranges, so you must run it on **every** node in every DC for full coverage. Skipping nodes leaves permanently unrepaired ranges.
6. ⚠️ **Running full repair across DCs during peak.** → ✅ Cross-DC streaming saturates WAN links. Use `-local` (or `-dc`) for routine repairs and schedule cross-DC repairs off-peak with `inter_dc_stream_throughput_outbound_megabits_per_sec` capped.
7. ⚠️ **Setting `read_repair = 'NONE'` to "fix" read latency.** → ✅ You have traded a correctness property for milliseconds. Fix the real cause (a lagging replica, a bad disk, an unrepaired range) and keep `BLOCKING`.
8. ⚠️ **Lowering `gc_grace_seconds` to 0 to stop tombstone pain.** → ✅ With `gc_grace_seconds = 0` any replica that missed the delete resurrects the row on the next repair. Only acceptable on single-node or TWCS-with-no-deletes append-only tables.
9. ⚠️ **Letting repair and major compaction run simultaneously.** → ✅ Validation compactions queue behind normal compactions and both fight for the same `compaction_throughput_mb_per_sec` budget. Stagger them.
10. ⚠️ **Treating a repair failure as benign and moving on.** → ✅ A failed session leaves ranges unrepaired and, with incremental repair, can leave SSTables in a pending-repair state. Check logs for `RepairException`, re-run the failed range, and alert on repair age per table.
11. ⚠️ **Ignoring accumulating hints as "self-healing".** → ✅ Growing `hints_directory` means a replica is persistently unreachable or overloaded. Alert on hints directory size; it is a leading indicator of a node about to fall out of the window.
12. ⚠️ **Reading at `ONE` and expecting repaired data.** → ✅ `CL=ONE` reads still trigger read repair only in the sense that no digest comparison happens at all — a single replica is consulted, so there is nothing to compare. Use `LOCAL_QUORUM` where correctness matters.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** When a customer reports "I deleted it and it came back", the chain is always the same: check `nodetool repair` history (or Reaper's repair_run table) for the table, compare last successful repair age against `gc_grace_seconds`, and check whether any node was down longer than the hint window in that period. `nodetool describecluster` catching a **schema disagreement** is a separate but adjacent smoking gun. For divergence you can prove: run the same query at `CL=ONE` against each replica with `cqlsh --request-timeout` and `CONSISTENCY ONE`, using `nodetool getendpoints keyspace table 'partition_key'` to find the replicas.

```bash
nodetool getendpoints shop orders 11111111-1111-1111-1111-111111111111
# 10.0.1.11
# 10.0.2.14
# 10.0.3.19
```

**Monitoring.** Name the beans:
- `org.apache.cassandra.metrics:type=ReadRepair,name=RepairedBlocking` and `name=ReconcileRead` — read-repair volume. A sustained rise means replicas are diverging faster than they converge.
- `org.apache.cassandra.metrics:type=Storage,name=TotalHints` and `name=TotalHintsInProgress` — hint accumulation.
- `org.apache.cassandra.metrics:type=HintsService,name=HintsSucceeded|HintsFailed|HintsTimedOut`.
- `org.apache.cassandra.metrics:type=Table,keyspace=*,scope=*,name=RepairJobsStarted|RepairJobsCompleted` plus `PendingCompactions` (validation compactions land here).
- Streaming progress via `nodetool netstats` and the `org.apache.cassandra.metrics:type=Streaming` beans.
- **Repair age per table** is the single most valuable derived metric: alert at `0.7 × gc_grace_seconds`, page at `0.9 ×`.

**Security.** Hint files contain **full mutation payloads in plaintext on disk** — they are unencrypted copies of your customer data sitting outside the normal SSTable path. If you encrypt data at rest, `hints_directory` and `commitlog_directory` must be on the same encrypted volume. Repair streams travel over the internode port (7000/7001); enable `server_encryption_options: internode_encryption: all` with proper certs, otherwise every repair broadcasts row data in cleartext across your network — including cross-DC over the WAN.

**Performance & Scaling.** Repair cost scales with **data per node**, not cluster size, which is why the community caps nodes at roughly **1–2 TB of data per node** for clusters that must repair regularly. Beyond that, validation compaction alone can run for many hours. Mitigations, in order of leverage: (1) more, smaller nodes; (2) subrange repair via Reaper with concurrency 1–2 per DC; (3) TWCS + no deletes on time-series tables so you can raise `gc_grace_seconds` and repair less often; (4) `-local` repairs plus a rarer cross-DC pass; (5) throttle streaming to ~30–50% of NIC capacity so client p99 is untouched.

## 9. Interview Questions

**Q: What are the three anti-entropy mechanisms in Cassandra and how do they differ?**
A: Hinted handoff, read repair, and anti-entropy repair. Hinted handoff stores mutations a down replica missed and replays them on recovery, within `max_hint_window_in_ms` (3 h default). Read repair reconciles divergence discovered at read time when replica digests disagree. Anti-entropy repair (`nodetool repair`) compares Merkle trees across replicas and streams the differences — it is the only one that guarantees convergence.

**Q: Why is running `nodetool repair` regularly mandatory rather than optional?**
A: Because tombstones are purged after `gc_grace_seconds` (864000s / 10 days by default). If a replica missed a delete and repair does not propagate that tombstone before it is purged elsewhere, the stale replica's live data wins on the next read and the deleted row resurrects. Hints and read repair cover only short outages and hot data respectively.

**Q: What is a digest read and when does Cassandra issue one?**
A: On a read at `CL > ONE`, the coordinator sends a full data request to the closest replica and MD5 digest requests to the others. Comparing digests is far cheaper than shipping full rows. If digests disagree, the coordinator escalates to full data reads from all responders, merges by write timestamp, and issues repair mutations.

**Q: What changed about read repair in Cassandra 4.0?**
A: The probabilistic background options `read_repair_chance` and `dclocal_read_repair_chance` were removed (CASSANDRA-13910). Read repair is now controlled by the per-table `read_repair` option with values `BLOCKING` (default) or `NONE`. Blocking read repair waits for repair mutations to be acknowledged at the read's consistency level before returning, which is what makes quorum reads monotonic.

**Q: A node was down for 8 hours. What must you do before it serves traffic?**
A: Hints stopped being recorded after 3 hours, so it holds up to 5 hours of missing writes. Either run repair on it before it takes reads, or — usually simpler and faster — remove it and bootstrap a replacement with `-Dcassandra.replace_address_first_boot`. Letting it rejoin untouched means `CL=ONE` reads serve stale data immediately.

**Q: What does the `-pr` flag do and why does it matter?**
A: `-pr` (primary range) repairs only the token ranges for which this node is the primary replica. Without it, each node repairs every range it replicates, so with `RF=3` every range gets repaired three times — triple the cost for the same result. The catch: `-pr` must be run on **every** node in **every** DC to achieve full coverage.

**Q: Where are hints stored and what happens if the coordinator dies?**
A: Since Cassandra 3.0 hints are flat files in `hints_directory` (`<host-id>-<ts>-<version>.hints`), not a system table. If the coordinator crashes permanently before replaying them, those hints are lost and the missed mutations exist only on the replicas that acked — only anti-entropy repair will close that gap.

**Q: (Senior) Explain the interaction between `gc_grace_seconds`, repair frequency, and tombstone read cost, and how you would tune all three for a table with heavy deletes.**
A: Repair must complete cluster-wide within `gc_grace_seconds` or deletes resurrect; that sets an upper bound on repair interval. But a larger `gc_grace_seconds` keeps tombstones alive longer, raising per-read tombstone scan counts toward `tombstone_warn_threshold` (1000) and `tombstone_failure_threshold` (100000). The right move is usually to eliminate the deletes: model with TTLs and TWCS so whole SSTables expire and drop, then you can keep `gc_grace_seconds` at the default with a comfortable weekly repair. If deletes are unavoidable, keep `gc_grace_seconds` at 10 days, run subrange repair via Reaper on a 5–7 day cycle, and make sure partitions are small so a tombstone-heavy partition never dominates a read.

**Q: (Senior) Why can blocking read repair cause a read to fail that would otherwise have succeeded, and is that correct behaviour?**
A: Under `BLOCKING`, after merging the coordinator must get the repair mutations acknowledged at the read's consistency level. If a replica that answered the digest read then fails to ack the repair write, the coordinator raises a `ReadTimeoutException` even though it already has a correct merged answer. It is correct in the sense that returning without the write-back would break monotonicity — a subsequent quorum read could see the older value. It is also a real source of surprising timeouts during rolling restarts, which is why you should not interpret every read timeout during maintenance as a client bug.

**Q: (Senior) You have a 20-node cluster with 4 TB per node and repairs never finish. Walk through your remediation.**
A: 4 TB per node is roughly 2–4× the practical repair ceiling, so first accept that no flag tuning fixes it structurally. Short term: switch to subrange repair with Cassandra Reaper, concurrency 1 per DC, `-local` only, segments sized so each takes under 20 minutes, and raise `compaction_throughput_mb_per_sec` on the repair window. Also audit which tables genuinely need repair — append-only TTL tables with no deletes may not. Medium term: double node count to halve data per node, or move the largest table to TWCS with TTLs and drop it from the repair schedule. Long term: enforce a data-per-node SLO in capacity planning; repair time is the real constraint on node density, not disk price.

**Q: (Senior) How does incremental repair change the SSTable layout, and what is the failure mode you must watch for?**
A: Incremental repair marks SSTables with a `repairedAt` timestamp and splits the table's SSTables into repaired and unrepaired pools that compact independently — so a table effectively has two compaction hierarchies. The failure mode is a repair session that dies mid-flight, leaving SSTables in a *pending repair* state associated with a session that never completes; those files are excluded from normal compaction and accumulate. Cassandra 4.0's rewritten incremental repair (CASSANDRA-9143) made this far safer with proper session tracking, but you should still monitor `nodetool repair_admin list` for orphaned sessions and cancel them with `nodetool repair_admin cancel --session <id>`.

**Q: Does read repair happen at `CL=ONE`?**
A: No meaningful repair occurs, because the coordinator contacts a single replica and has nothing to compare against. Divergence at `CL=ONE` is invisible. If you read at `ONE` for latency, you are relying entirely on hints and scheduled anti-entropy repair for convergence.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Cassandra accepts writes when replicas are down, so it must reconverge later. Three mechanisms do it at three timescales. **Hints**: the coordinator saves what a down replica missed and replays it within `max_hint_window_in_ms` (3 h) — best effort, lost if the coordinator dies. **Read repair**: at `CL > ONE` the coordinator compares digests, merges by highest write timestamp, and under `BLOCKING` (the 4.x default and only real mode) writes the fix back and waits for acks before replying — this is what makes quorum reads monotonic, but it only ever touches data you actually read. **Anti-entropy repair**: `nodetool repair` builds Merkle trees (2^15 leaves) per range on each replica, diffs them, and streams differing leaves. It is the only correctness guarantee, and it **must** complete within `gc_grace_seconds` (864000s) or deleted rows resurrect. Use `-pr` on every node, `-local` for routine runs, and subrange/Reaper once data per node exceeds a terabyte.

| Item | Value / Command | Note |
|---|---|---|
| `max_hint_window_in_ms` | `10800000` (3 h) | Past this, no hints recorded |
| `hinted_handoff_throttle_in_kb` | `1024` | Cluster-wide budget per delivery thread |
| `gc_grace_seconds` | `864000` (10 days) | Repair deadline |
| `read_repair` (table option) | `BLOCKING` (default) or `NONE` | 4.0+ replaces `read_repair_chance` |
| Merkle tree leaves | `2^15` = 32768 | Streaming granularity is one leaf |
| Primary-range repair | `nodetool repair -pr -full ks tbl` | Run on **every** node |
| DC-local repair | `nodetool repair -local -pr ks` | Avoid WAN streaming |
| Subrange repair | `nodetool repair -st T1 -et T2 ks tbl` | Smallest blast radius |
| Hint controls | `statushandoff` / `pausehandoff` / `resumehandoff` / `truncatehints` | |
| Incremental sessions | `nodetool repair_admin list` / `cancel --session <id>` | Find orphans |
| Practical data per node | 1–2 TB | Bounded by repair time |
| Repair progress | `nodetool compactionstats` (Validation) + `nodetool netstats` | |

**Flash cards**
- **Which mechanism guarantees convergence?** → Only anti-entropy repair (`nodetool repair`). Hints and read repair are best-effort.
- **What happens if repair does not run within `gc_grace_seconds`?** → Tombstones are purged on nodes that have them; a replica that missed the delete resurrects the row.
- **What does `-pr` do?** → Repairs only this node's primary token ranges; must be run on every node in every DC for full coverage.
- **Why is read repair `BLOCKING` in 4.x?** → So quorum reads are monotonic: the coordinator waits for repair write-backs to be acked at `CL` before replying.
- **How long are hints kept for a down node?** → Only while it has been down less than `max_hint_window_in_ms` (3 hours default); after that, repair is the only path back.

## 11. Hands-On Exercises & Mini Project

- [ ] Build a 3-node cluster (`ccm create rrlab -v 4.1.5 -n 3 -s`), create `shop.orders` with `RF=3`. Stop node3, write 1000 rows at `LOCAL_QUORUM`, and confirm hints accumulate: `du -sh ~/.ccm/rrlab/node1/hints` and `nodetool tpstats | grep -i hint`.
- [ ] Restart node3 and watch hint replay. Then query node3 directly at `CONSISTENCY ONE` and verify all 1000 rows arrived. Time how long replay takes and compute the effective throughput against `hinted_handoff_throttle_in_kb`.
- [ ] Force a hint-window miss: set `max_hint_window_in_ms: 30000`, stop node3, write 1000 rows, wait 60 s, restart. Read node3 at `CONSISTENCY ONE` — count the missing rows. Then run `nodetool repair -pr shop orders` on all three nodes and re-count.
- [ ] Demonstrate zombie data: `ALTER TABLE shop.orders WITH gc_grace_seconds = 60;` Stop node3, delete 100 rows at `LOCAL_QUORUM`, wait 120 s, run `nodetool compact` on nodes 1 and 2 to purge tombstones, restart node3, run repair, and observe the deleted rows come back.
- [ ] Instrument read repair: with node3 stale, run 10k `LOCAL_QUORUM` reads and chart `ReadRepair.RepairedBlocking` and `ClientRequest.Read.Latency` p99 before/after. Quantify the tail-latency cost of divergence.

### Mini Project — Repair Health Dashboard

**Goal.** Build a small service that answers, per keyspace/table, "when was this last fully repaired, and are we at risk of data resurrection?"

**Requirements.**
1. Poll each node over JMX (or `nodetool` via SSH) for `HintsService` counters, `Storage.TotalHints`, and `ReadRepair.RepairedBlocking`.
2. Parse `system_distributed.repair_history` and `system_distributed.parent_repair_history` to compute, for each table, the **oldest token range's last successful repair time**. That number — not the last repair *command* — is the real repair age.
3. Compute `risk = repair_age / gc_grace_seconds` per table; emit `WARN` at 0.7 and `CRIT` at 0.9.
4. Expose a Prometheus endpoint and a one-page HTML summary sorted by risk.

**Extensions.**
- Add a "hint pressure" panel: hints directory size per node with a projected time-to-window-expiry.
- Integrate with Cassandra Reaper's REST API to auto-schedule a subrange repair for any table crossing `WARN`.
- Add a synthetic canary: write a known row at `LOCAL_QUORUM`, read it at `ONE` against each replica via `getendpoints`, and alert on divergence — a direct, table-independent convergence probe.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Repair: Full, Incremental & Subrange* (ch. 29) goes deeper on repair strategy and Reaper; *Consistency Levels & Tunable Consistency* covers the `R + W > RF` math this chapter assumes; *Tombstones & Deletes* explains `gc_grace_seconds` and resurrection in detail; *Gossip & Failure Detection* explains how a node is declared DOWN in the first place; *nodetool & Everyday Cluster Operations* (ch. 27) covers the commands used here; *Storage Engine & SSTable Format* (ch. 26) explains what repair actually streams.

- **Apache Cassandra Docs — Dynamo: Read Repair & Hinted Handoff** — Apache Software Foundation · *Intermediate* · the authoritative description of both mechanisms including 4.x behaviour changes. <https://cassandra.apache.org/doc/latest/cassandra/architecture/dynamo.html>
- **Apache Cassandra Docs — Repair** — Apache Software Foundation · *Advanced* · covers full vs incremental, `-pr`, and the anti-compaction model. <https://cassandra.apache.org/doc/latest/cassandra/managing/operating/repair.html>
- **Dynamo: Amazon's Highly Available Key-value Store** — DeCandia et al., SOSP 2007 · *Advanced* · sections 4.6 and 4.7 are the original hinted-handoff and Merkle-tree anti-entropy designs Cassandra inherits. <https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf>
- **The Last Pickle — Repair in Cassandra series** — Alexander Dejanovski / TLP · *Advanced* · the best practitioner writing on repair strategies, incremental repair pitfalls, and subrange orchestration. <https://thelastpickle.com/blog/2017/12/14/should-you-use-incremental-repair.html>
- **Cassandra Reaper** — TLP / DataStax (open source) · *Intermediate* · the de-facto repair scheduler; the docs explain segmentation and concurrency far better than any blog. <http://cassandra-reaper.io/>
- **CASSANDRA-13910 — Remove read_repair_chance** — Apache JIRA · *Advanced* · read the discussion to understand exactly why probabilistic read repair was removed in 4.0. <https://issues.apache.org/jira/browse/CASSANDRA-13910>
- **CASSANDRA-9143 — Improving consistency of repairAt field** — Apache JIRA · *Expert* · the ticket behind 4.0's rewritten incremental repair; essential background for the pending-repair failure mode. <https://issues.apache.org/jira/browse/CASSANDRA-9143>
- **How Discord Stores Billions of Messages** — Discord Engineering · *Intermediate* · real-world operational context for `RF=3` / `LOCAL_QUORUM` and why repair and tombstones dominated their pain. <https://discord.com/blog/how-discord-stores-billions-of-messages>

---

*Apache Cassandra Handbook — chapter 25.*
