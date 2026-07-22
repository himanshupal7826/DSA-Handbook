# 36 · Troubleshooting Latency & Hotspots

> **In one line:** Cassandra latency incidents almost always reduce to one of five causes — a wide partition, a hot partition, GC, compaction backlog, or tombstones — and the diagnostic path is always the same: split coordinator time from local time, then find the one node and the one table.

---

## 1. Overview

The distinctive thing about troubleshooting Cassandra is that the cluster rarely tells you it is broken. Reads still succeed; they just take 300 ms instead of 4 ms. Writes still ack; a few of them silently never landed on one replica. `nodetool status` shows all nodes `UN`. Dashboards averaged across 40 nodes look normal. Meanwhile one node is doing eight times the work of its peers because a single celebrity user's partition grew to 900 MB, and every read of that partition drags the whole coordinator pool down with it.

The problem this chapter solves is **localisation**: converting "the app is slow" into "node 17, table `app.events`, partition key `tenant=acme`, caused by tombstones from a queue-style delete pattern". Cassandra gives you exactly the tools to do that — `proxyhistograms` versus `tablehistograms` to split coordination from storage, `toppartitions` to name the hot key, `tablestats` and `sstablepartitions` to name the wide one, tracing to see per-replica timing, and `tpstats` to see queueing — but only if you use them in the right order. Used in the wrong order you will spend a day tuning the JVM on a node whose real problem is a 40 MB partition.

Historically, Cassandra's most infamous failure modes come from the same source: an LSM engine plus a partition-centric data model means that *the data model determines your latency*, and a data model that was fine at 10k rows per partition is fatal at 10M. The famous public examples all follow this shape — Discord's hot channels concentrating reads onto three replicas, and the near-universal "queue anti-pattern" where a table is used as a work queue, deletes create tombstones, and reads eventually scan hundreds of thousands of tombstones per query until `TombstoneOverwhelmingException` fires at the default `tombstone_failure_threshold` of 100,000.

A concrete example. An e-commerce cluster's p99 read latency went from 5 ms to 240 ms over six weeks with no deploys. Cluster CPU was 35%. `nodetool proxyhistograms` showed coordinator p99 at 238 ms; `nodetool tablehistograms` on every node showed local read p99 at 3 ms. That gap said: not the storage engine. `nodetool tpstats` showed ReadStage pending at 600 on three of thirty nodes. Those three were the replica set for one token range. `nodetool toppartitions` named the partition: a single `merchant_id` doing 40% of all reads. The fix was a data-model change — bucketing that merchant's partition by day — plus `speculative_retry` tuning as a stopgap. **The metric that mattered was the difference between two percentiles, not either one alone.**

The mental model: **latency is a sum of layers, and hotspots are a distribution problem.** Subtract layers to find where time goes; compare nodes to find where load concentrates. Everything else is detail.

## 2. Core Concepts

- **Wide partition** — a partition whose size or row count far exceeds the guidance of < 100 MB and < 100,000 rows; reads of it allocate heavily and can pause the JVM.
- **Hot partition** — a partition receiving a disproportionate share of requests; it concentrates load on exactly RF nodes regardless of cluster size.
- **Hot node** — a node doing more work than peers, from a hot partition, unbalanced tokens, a failed disk, or a noisy neighbour.
- **Dropped mutation** — a write discarded after sitting in the queue past `write_request_timeout` (2 s); it was likely acked to the client, so it is a consistency bug, not just a slow write.
- **Tombstone** — a deletion marker retained for `gc_grace_seconds` (default 864000 = 10 days); reads must scan and discard them, so they cost read time without returning data.
- **`tombstone_warn_threshold` / `tombstone_failure_threshold`** — 1,000 and 100,000 scanned tombstones per query; the first logs a WARN, the second aborts the query with `TombstoneOverwhelmingException`.
- **SSTables per read** — the number of SSTables consulted for one read; the dominant multiplier on local read latency. p99 above 8 means compaction is losing.
- **Speculative retry** — per-table policy that sends a redundant read to another replica when the first is slow, cutting p99 at the cost of extra load.
- **Request tracing** — per-request, per-replica timing written to `system_traces`; enable per-query in cqlsh or probabilistically in production.
- **`toppartitions`** — a live sampler (`nodetool toppartitions ks.tbl <ms>`) that names the most frequently read or written partition keys using a space-saving sketch.

## 3. Theory & Internals

**Why a wide partition is so damaging.** A partition lives entirely on its RF replicas and, within an SSTable, is a contiguous region indexed by the partition index. Reading a slice of a 500 MB partition requires the index entry for that partition — which, above `column_index_size` (64 KB of data by default), becomes a multi-page index with thousands of entries that must be deserialised. Cassandra 3.0's storage engine and 4.0's improvements reduced but did not eliminate this. Worse, compacting a wide partition requires holding its row iterators and produces a very long-running compaction task that blocks a compactor slot. And any query returning a large slice materialises those rows on-heap, which is a direct GC event. The practical thresholds: **< 100 MB and < 100,000 rows per partition**; above 1 GB you will see node-level instability.

**Why a hot partition cannot be scaled away.** A partition key hashes to exactly one token, owned by exactly RF nodes. If one key takes 40% of your reads, then 40% of your read traffic hits 3 nodes no matter whether the cluster has 6 nodes or 600. Adding capacity does nothing. The only fixes are data-model changes that split the key — adding a bucket component (`PRIMARY KEY ((merchant_id, day), ...)`) or a synthetic shard (`PRIMARY KEY ((merchant_id, shard), ...)` with `shard = hash(x) % 16`) — or caching in front of Cassandra. This is the single most important architectural consequence of hash partitioning and the reason data modelling dominates operations.

**Tombstone arithmetic.** A `DELETE` writes a tombstone rather than removing data, because a distributed system has no way to distinguish "deleted" from "never seen" without one. Tombstones survive `gc_grace_seconds` (864,000 s = 10 days) so that a replica that was down cannot resurrect the deleted row. A read must merge tombstones with live data and discard the shadowed rows. In a queue-style table where rows are inserted then deleted, a read of the "head" of the partition scans every tombstone before it: after a million insert/delete cycles the query scans a million tombstones and fails. The counters to watch are `Table.TombstoneScannedHistogram` p99 and the WARN line `Read N live rows and M tombstone cells`. Range tombstones (from `DELETE ... WHERE ck > ?`) are cheaper per deleted row but a large number of overlapping range tombstones has its own cost, addressed by CASSANDRA-8527 and later work.

**Latency decomposition.** Let `T_client` be what the app measures, `T_coord` = `ClientRequest.Read.Latency`, `T_local` = `Table.ReadLatency` on the replica. Then:
- `T_client − T_coord` = driver queueing, connection-pool saturation, client GC.
- `T_coord − T_local` = network, cross-DC routing, coordinator queueing (ReadStage pending), coordinator GC, waiting for the slowest replica in the quorum.
- `T_local` itself = bloom + index + chunk fetch per SSTable, times SSTables-per-read, plus merge and tombstone scanning.

At `LOCAL_QUORUM` with RF 3 you wait for the 2nd of 3 responses, so `T_coord` tracks the *median-of-3 tail*, not the mean. One replica with a 200 ms GC pause therefore does not necessarily hurt you — but two do, and speculative retry exists precisely to route around the first.

```svg
<svg viewBox="0 0 780 350" width="100%" height="350" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="780" height="350" fill="#ffffff"/>
  <defs><marker id="a36" markerWidth="9" markerHeight="9" refX="8" refY="4" orient="auto"><path d="M0 0 L9 4 L0 8 z" fill="#1e293b"/></marker></defs>
  <text x="20" y="26" font-size="15" font-weight="700" fill="#1e293b">Hot partition: why adding nodes does not help</text>
  <circle cx="200" cy="150" r="96" fill="none" stroke="#4f46e5" stroke-width="3"/>
  <text x="200" y="42" font-size="12" font-weight="700" fill="#1e293b" text-anchor="middle">token ring, 30 nodes</text>
  <circle cx="200" cy="54" r="9" fill="#fef3c7" stroke="#d97706" stroke-width="3"/>
  <circle cx="269" cy="87" r="9" fill="#fef3c7" stroke="#d97706" stroke-width="3"/>
  <circle cx="294" cy="160" r="9" fill="#fef3c7" stroke="#d97706" stroke-width="3"/>
  <circle cx="256" cy="228" r="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <circle cx="180" cy="245" r="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <circle cx="115" cy="205" r="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <circle cx="105" cy="122" r="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <circle cx="143" cy="70" r="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="200" y="270" font-size="11" fill="#1e293b" text-anchor="middle">hash(merchant_id=acme) lands here</text>
  <text x="200" y="286" font-size="11" font-weight="700" fill="#1e293b" text-anchor="middle">3 replicas take 40% of all reads</text>
  <rect x="380" y="56" width="380" height="106" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="570" y="80" font-size="12" font-weight="700" fill="#1e293b" text-anchor="middle">Symptoms on those 3 nodes only</text>
  <text x="396" y="102" font-size="11" fill="#1e293b">ReadStage pending 600, others 0</text>
  <text x="396" y="122" font-size="11" fill="#1e293b">coordinator p99 240 ms, local p99 3 ms</text>
  <text x="396" y="142" font-size="11" fill="#1e293b">cluster CPU average looks fine at 35%</text>
  <rect x="380" y="176" width="380" height="106" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="570" y="200" font-size="12" font-weight="700" fill="#1e293b" text-anchor="middle">Fixes, in order of effectiveness</text>
  <text x="396" y="222" font-size="11" fill="#1e293b">1. Split the key: PRIMARY KEY ((merchant_id, day), ...)</text>
  <text x="396" y="242" font-size="11" fill="#1e293b">2. Synthetic shard: shard = hash(txn) % 16</text>
  <text x="396" y="262" font-size="11" fill="#1e293b">3. Cache in front; speculative_retry as a stopgap</text>
  <text x="20" y="312" font-size="12" fill="#1e293b">Adding nodes changes nothing: the key hashes to one token, owned by exactly RF replicas, forever.</text>
  <text x="20" y="332" font-size="12" fill="#1e293b">Find it with: nodetool toppartitions ks.tbl 10000 -k READS   (space-saving sampler over live traffic)</text>
</svg>
```

## 4. Architecture & Workflow

The diagnostic decision tree, in the order that converges fastest:

1. **Confirm the symptom's shape.** Is p99 up while p50 is flat (tail problem: GC, one slow replica, queueing) or is everything up (systemic: compaction, disk, data model)? Is it one table or all tables? One DC or all?
2. **Split coordinator from local.** `nodetool proxyhistograms` versus `nodetool tablehistograms <ks>.<tbl>` on several nodes. A large gap means coordination — queueing, network, GC, cross-DC. No gap means the storage engine.
3. **Find the outlier node.** Compare `Table.ReadLatency` p99 and `ThreadPools.ReadStage.PendingTasks` per instance. Cassandra problems are almost never uniform.
4. **On that node, check the four usual suspects** in order: `nodetool tpstats` (queueing and dropped messages), `nodetool compactionstats` (backlog), `nodetool gcstats` plus `GCInspector` WARNs (pauses), and `iostat -x 1` (device saturation).
5. **Check the data model** with `nodetool tablehistograms`: partition size p99, cell count p99, SSTables-per-read p99, and `Table.TombstoneScannedHistogram`. These four numbers diagnose most "everything is slow" cases outright.
6. **Name the partition.** `nodetool toppartitions` for hot keys; `nodetool tablestats` `Compacted partition maximum bytes` and the `sstablepartitions` / `sstablemetadata` tools for wide keys.
7. **Trace one request** end to end if the above is inconclusive: `TRACING ON` in cqlsh for a repro, or `nodetool settraceprobability 0.001` in production, then read `system_traces.events` grouped by `source`.
8. **Correlate the logs.** `GCInspector`, `Read N live rows and M tombstone cells`, `TombstoneOverwhelmingException`, `Not marking nodes down due to local pause`, and slow-query entries from `slow_query_log_timeout_in_ms` (default 500 ms).

```svg
<svg viewBox="0 0 780 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="780" height="360" fill="#ffffff"/>
  <defs><marker id="b36" markerWidth="9" markerHeight="9" refX="8" refY="4" orient="auto"><path d="M0 0 L9 4 L0 8 z" fill="#1e293b"/></marker></defs>
  <text x="20" y="26" font-size="15" font-weight="700" fill="#1e293b">Latency triage decision tree</text>
  <rect x="270" y="44" width="240" height="46" rx="10" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="390" y="72" font-size="12" font-weight="700" fill="#1e293b" text-anchor="middle">proxyhistograms vs tablehistograms</text>
  <path d="M330 92 L200 122" stroke="#1e293b" stroke-width="2" marker-end="url(#b36)"/>
  <path d="M450 92 L580 122" stroke="#1e293b" stroke-width="2" marker-end="url(#b36)"/>
  <text x="230" y="112" font-size="11" font-weight="700" fill="#1e293b">big gap</text>
  <text x="520" y="112" font-size="11" font-weight="700" fill="#1e293b">no gap</text>
  <rect x="20" y="128" width="340" height="46" rx="10" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="190" y="156" font-size="12" font-weight="700" fill="#1e293b" text-anchor="middle">Coordination problem</text>
  <rect x="420" y="128" width="340" height="46" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="590" y="156" font-size="12" font-weight="700" fill="#1e293b" text-anchor="middle">Storage engine or data model</text>
  <rect x="20" y="188" width="164" height="70" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="102" y="209" font-size="11" font-weight="700" fill="#1e293b" text-anchor="middle">tpstats pending</text>
  <text x="102" y="228" font-size="10" fill="#1e293b" text-anchor="middle">ReadStage queueing</text>
  <text x="102" y="245" font-size="10" fill="#1e293b" text-anchor="middle">dropped messages</text>
  <rect x="196" y="188" width="164" height="70" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="278" y="209" font-size="11" font-weight="700" fill="#1e293b" text-anchor="middle">gcstats + GCInspector</text>
  <text x="278" y="228" font-size="10" fill="#1e293b" text-anchor="middle">pauses over 200 ms</text>
  <text x="278" y="245" font-size="10" fill="#1e293b" text-anchor="middle">local pause warnings</text>
  <rect x="420" y="188" width="164" height="70" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="502" y="209" font-size="11" font-weight="700" fill="#1e293b" text-anchor="middle">tablehistograms</text>
  <text x="502" y="228" font-size="10" fill="#1e293b" text-anchor="middle">SSTables/read p99</text>
  <text x="502" y="245" font-size="10" fill="#1e293b" text-anchor="middle">partition size p99</text>
  <rect x="596" y="188" width="164" height="70" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="678" y="209" font-size="11" font-weight="700" fill="#1e293b" text-anchor="middle">tombstones</text>
  <text x="678" y="228" font-size="10" fill="#1e293b" text-anchor="middle">TombstoneScanned p99</text>
  <text x="678" y="245" font-size="10" fill="#1e293b" text-anchor="middle">WARN live rows / cells</text>
  <rect x="20" y="276" width="360" height="34" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="200" y="298" font-size="11" fill="#1e293b" text-anchor="middle">also: cross-DC routing, driver local_dc, connection pool</text>
  <rect x="420" y="276" width="340" height="34" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="590" y="298" font-size="11" fill="#1e293b" text-anchor="middle">also: compaction backlog, device saturation, hot key</text>
  <rect x="20" y="322" width="740" height="30" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="390" y="342" font-size="12" fill="#1e293b" text-anchor="middle">Still unclear? Trace one request and group system_traces.events by source to see per-replica timing.</text>
</svg>
```

## 5. Implementation

Step 1 and 2 — split the layers:

```bash
# Coordinator-side, microseconds. Includes network + slowest-needed replica.
nodetool proxyhistograms
# Percentile   Read Latency  Write Latency  Range Latency
# 50%               1131.75         454.83        2346.80
# 99%             238098.00        1955.67      654949.00

# Local storage engine on the same node
nodetool tablehistograms shop.orders
# Percentile  SSTables  Write(us)  Read(us)  Partition Size  Cell Count
# 50%             2.00      28.09    310.00            3311          42
# 99%             3.00      88.15   2816.00           74975         642
# -> local p99 2.8 ms vs coordinator p99 238 ms: NOT the storage engine
```

Step 3 and 4 — find the node and the saturated resource:

```bash
nodetool tpstats
# Pool Name          Active Pending Completed Blocked All time blocked
# ReadStage              32     614  98214553       0                0
# MutationStage           2       0 402118776       0                0
# Message type   Dropped
# READ                  41
# MUTATION             213      <- acked to clients, never applied: consistency incident

nodetool gcstats
# Interval(ms) Max GC(ms) Total GC(ms) StdDev  GC Reclaimed(MB) Collections
#      300218        892        38210   61.4        1183429120         1610
#   -> 12.7% of wall clock in GC and an 892 ms max pause: also a problem

iostat -x 1 3 | awk '/nvme0n1/{print $1, "util:", $NF, "await:", $10}'
# nvme0n1 util: 14.2 await: 0.31     <- device is idle; not I/O bound
```

Step 5 and 6 — name the partition:

```bash
# Hot partitions, sampled from live traffic for 10 seconds
nodetool toppartitions shop.orders 10000 -k READS -s 256
# READS Sampler:
#   Cardinality: ~118000
#   Top 10 partitions:
#     Partition                Count      +/-
#     merchant:acme            418221     0
#     merchant:globex           12094     0
#   -> one key is 40% of reads on this node

# Wide partitions, from SSTable metadata (no live traffic needed)
nodetool tablestats shop.orders | grep -E 'Compacted partition|Average live cells'
# Compacted partition minimum bytes: 150
# Compacted partition maximum bytes: 943718400        <- 900 MB partition
# Average live cells per slice (last five minutes): 8214.0

# Which key is it? (4.0+ ships sstablepartitions)
sstablepartitions --min-size 100000000 /var/lib/cassandra/data/shop/orders-*/nb-*-Data.db
# Partition: 'merchant:acme' (6d65...) live, size 943718400, rows 4128331
```

Tombstone diagnosis — the most under-recognised cause:

```bash
grep -E 'tombstone|Tombstone' /var/log/cassandra/system.log | tail -3
# WARN  ReadCommand.java:569 - Read 12 live rows and 84213 tombstone cells for query
#   SELECT * FROM shop.job_queue WHERE tenant = 'acme' LIMIT 100 (see tombstone_warn_threshold)
# ERROR ReadCommand.java:... - Scanned over 100001 tombstones ... aborting query
```

```cql
-- Confirm the tombstone burden per query with tracing
TRACING ON;
SELECT * FROM shop.job_queue WHERE tenant = 'acme' LIMIT 100;
-- activity                                                     | source     | elapsed
-- Read 12 live rows and 84213 tombstone cells                   | 10.1.0.33  |  412991
-- Merged data from memtables and 4 sstables                     | 10.1.0.33  |  413882
TRACING OFF;

-- Per-table tombstone thresholds live in cassandra.yaml, but the data model is the fix:
-- queue anti-pattern -> use TWCS + TTL and never DELETE
ALTER TABLE shop.job_queue WITH compaction = {
  'class':'TimeWindowCompactionStrategy','compaction_window_unit':'HOURS',
  'compaction_window_size':1} AND default_time_to_live = 86400
  AND gc_grace_seconds = 3600;   -- safe ONLY if repairs complete inside this window
```

Fixing hot and wide partitions is a schema change, not a setting:

```cql
-- BEFORE: unbounded, hot, and wide all at once
CREATE TABLE shop.orders (
  merchant_id text, order_id timeuuid, total decimal,
  PRIMARY KEY (merchant_id, order_id));

-- AFTER: bucketed by day bounds size; a synthetic shard bounds heat
CREATE TABLE shop.orders_v2 (
  merchant_id text, day date, shard tinyint, order_id timeuuid, total decimal,
  PRIMARY KEY ((merchant_id, day, shard), order_id)
) WITH CLUSTERING ORDER BY (order_id DESC)
  AND compaction = {'class':'TimeWindowCompactionStrategy',
                    'compaction_window_unit':'DAYS','compaction_window_size':1}
  AND speculative_retry = 'MIN(99p,50ms)';
-- shard = abs(hash(order_id)) % 16 chosen by the app; reads fan out to 16 partitions
-- but each is bounded and spread across the ring.
```

Client-side instrumentation that catches the driver's contribution:

```python
from cassandra.cluster import Cluster
from cassandra.query import SimpleStatement
cluster = Cluster(["10.1.0.31"], protocol_version=5, metrics_enabled=True)
session = cluster.connect("shop")
session.default_fetch_size = 500        # 5000 wide rows per page is a GC event

# Trace a single suspicious query and print per-replica timings
stmt = SimpleStatement("SELECT * FROM orders WHERE merchant_id='acme' LIMIT 100")
rs = session.execute(stmt, trace=True)
for ev in rs.get_query_trace().events:
    print(f"{ev.source} {ev.source_elapsed:>8} us  {ev.description[:70]}")
# 10.1.0.33   412991 us  Read 12 live rows and 84213 tombstone cells
# 10.1.0.33   413882 us  Merged data from memtables and 4 sstables

print(cluster.metrics.stats.request_timeouts, cluster.metrics.request_timer["999percentile"])
```

**Optimization note:** the cheapest permanent instrumentation is the slow-query log. `slow_query_log_timeout_in_ms` (default 500) makes Cassandra write any query exceeding the threshold to `system.log` with its full CQL text and the coordinator's timing, at essentially zero cost. Combined with `nodetool settraceprobability 0.001` for sampled full traces, it gives you an always-on record of your worst queries without the write amplification of blanket tracing. Turn both on before you need them — the worst time to start collecting evidence is during the incident.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost/Trade-off |
|---|---|---|
| `proxyhistograms` vs `tablehistograms` | Instantly separates coordination cost from storage cost | Point-in-time, per node; needs to be run on the right node |
| `toppartitions` | Names the actual hot key from live traffic | Sampling window only; misses keys that are large but infrequently read |
| `sstablepartitions` / `tablestats` | Finds wide partitions from on-disk metadata, no traffic needed | Offline view; `Compacted partition maximum bytes` is per-SSTable, not global |
| Request tracing | Exact per-replica, per-stage timings for one query | Writes to `system_traces` per traced request; unusable above ~1% sampling |
| Slow-query log | Always-on, free, includes the CQL text | Threshold-based; misses the case where every query is moderately slow |
| Speculative retry | Cuts p99/p999 by routing around one slow replica | Adds load — makes a saturated cluster worse |
| Lowering `gc_grace_seconds` | Tombstones purge sooner, reads get faster | Data resurrection risk if repairs do not complete inside the new window |
| Schema fixes (bucketing/sharding) | The only real fix for hot and wide partitions | Requires a migration and dual-write period; changes the read API |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Looking at cluster averages.** One sick node in forty is invisible in an average and is the usual culprit. → ✅ Every latency and saturation panel broken down by instance; alert on `max by (instance)`.
2. ⚠️ **Tuning the JVM or compaction before checking partition size.** → ✅ Run `nodetool tablehistograms` first; a p99 partition of 40 MB explains everything and nothing else will fix it.
3. ⚠️ **Treating dropped mutations as a performance metric.** → ✅ They are unapplied writes that were acked to clients — a consistency incident. Repair the affected ranges and fix the saturation that caused them.
4. ⚠️ **Using a Cassandra table as a work queue.** Insert-then-delete generates tombstones that make reads progressively slower until `TombstoneOverwhelmingException`. → ✅ Use TTLs with TWCS and never `DELETE`, or use an actual queue (Kafka, SQS).
5. ⚠️ **Dropping `gc_grace_seconds` to 0 to "fix tombstones".** → ✅ Only lower it if repair reliably completes within the new window; otherwise deleted data resurrects. TWCS plus TTL is the safe path.
6. ⚠️ **`ALLOW FILTERING` to make a query work.** It turns a targeted read into a cluster-wide scan whose cost grows with your data. → ✅ Model a new table for the access pattern, or use SAI (5.0) where the cardinality suits it.
7. ⚠️ **Adding nodes to fix a hot partition.** The key still hashes to RF replicas. → ✅ Split the key with a bucket or synthetic shard, or cache in front.
8. ⚠️ **Blanket `TRACING ON` in production.** Tracing writes two rows per traced request and becomes the bottleneck. → ✅ `settraceprobability 0.001` plus the slow-query log.
9. ⚠️ **Ignoring the "Not marking nodes down due to local pause" line.** It is literal proof the JVM froze for seconds. → ✅ Alert on it; go to the GC chapter.
10. ⚠️ **Assuming a slow query means a slow cluster.** A single `SELECT` with `fetch_size=5000` over wide rows can pull tens of megabytes per page. → ✅ Check the client's fetch size, paging behaviour and whether `local_dc` is correct before touching the server.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Keep a written triage order and follow it every time, because under pressure people jump to their favourite hypothesis. Mine is: (1) shape of the symptom — p99 only or everything, one table or all; (2) `proxyhistograms` vs `tablehistograms` to split coordination from storage; (3) per-node comparison to find the outlier; (4) on the outlier, `tpstats`, `compactionstats`, `gcstats`, `iostat`; (5) `tablehistograms` four numbers — SSTables/read, partition size, cell count, tombstones scanned; (6) `toppartitions` and `sstablepartitions` to name the key; (7) trace one request. Two shortcuts worth knowing: `nodetool getendpoints <ks> <tbl> <key>` tells you exactly which nodes own a suspect key, so you can go straight to them; and `nodetool tablestats` `Average live cells per slice (last five minutes)` combined with `Average tombstones per slice` gives you a per-table tombstone ratio in one command.

**Monitoring.** The alerting set specifically for this chapter: `Table.SSTablesPerReadHistogram` p99 > 8 (ticket) and > 16 (page); `Table.TombstoneScannedHistogram` p99 > 1000 (ticket); `Table.MaxPartitionSizeBytes` > 100 MB (ticket) and > 1 GB (page); `ClientRequest.Read.Latency` p99 max-by-instance versus median-by-instance, alerting when the ratio exceeds 3 (that is the hot-node detector); `ThreadPools.ReadStage.PendingTasks` > 100; `DroppedMessage.*.Dropped` any increase; count of `GCInspector` WARN lines per minute. Also chart per-node request rate — a node serving 3× its peers is a hot partition or a token imbalance, and `nodetool status` `Owns%` will tell you which.

**Security.** Troubleshooting artefacts leak data. `system_traces.events` contains query text with bound values in some paths, the slow-query log writes CQL to `system.log`, and full-query logging (4.0+) captures every statement including values — all of which may contain personal data and all of which usually land in a log aggregator with weaker access controls than the database. Set a short TTL on `system_traces` (24 h by default), restrict `SELECT` on it to an ops role, keep FQL enabled only for bounded investigation windows and write it to an encrypted volume, and make sure heap dumps taken during a latency incident are treated as production data. Also restrict `nodetool` access: `toppartitions` and `getendpoints` reveal customer identifiers directly.

**Performance & scaling.** The hard truth of this chapter is that most latency problems are data-model problems, and data-model problems are not fixed by scaling. Adding nodes helps with aggregate throughput, per-node density and compaction headroom; it does nothing for a hot partition, a wide partition, or a tombstone-laden queue table. Build the migration muscle instead: a dual-write plus backfill plus read-switch pattern that lets you change a partition key without downtime is the single most valuable operational capability a Cassandra team can have. Where scaling does help directly is per-node density — keeping nodes under roughly 1–2 TB keeps compaction, repair and bootstrap times manageable, which in turn keeps SSTables-per-read low and latency predictable. And when you do fix a data model, verify with the same four numbers you diagnosed with; "it feels faster" is not a result.

## 9. Interview Questions

**Q: Coordinator read p99 is 240 ms but every replica reports 3 ms local read latency. What are the possible causes?**
A: The time is being spent outside the storage engine: ReadStage queueing on the coordinator, GC pauses, cross-datacenter routing because the driver's local DC is wrong or the consistency level is `QUORUM` in a multi-DC keyspace, network problems, or the coordinator waiting on the slowest replica needed by the CL. Check `tpstats` pending, `gcstats`, `Messaging` cross-node latency, and the driver's load-balancing policy in that order.

**Q: What is a hot partition and why doesn't adding nodes fix it?**
A: A partition key whose traffic share vastly exceeds its data share. The key hashes to a single token owned by exactly RF replicas, so all of its traffic lands on those RF nodes regardless of cluster size. Adding nodes redistributes tokens but the key still maps to one of them. The fix is to split the key — add a time bucket or a synthetic shard component to the partition key — or to cache it upstream.

**Q: How do you find the offending partition key during an incident?**
A: `nodetool toppartitions <ks>.<tbl> <duration_ms> -k READS,WRITES` samples live traffic and prints the most frequent keys. For large-rather-than-frequent partitions, `nodetool tablestats` shows `Compacted partition maximum bytes` and `sstablepartitions --min-size` names the key from on-disk metadata. `nodetool getendpoints <ks> <tbl> <key>` then confirms which nodes own it.

**Q: Why do tombstones cause read latency and what are the thresholds?**
A: A delete writes a tombstone rather than removing data, and reads must scan and discard tombstones to determine what is live. `tombstone_warn_threshold` (1,000) logs a WARN with the query text; `tombstone_failure_threshold` (100,000) aborts the query with `TombstoneOverwhelmingException`. Tombstones persist for `gc_grace_seconds` (864,000 s = 10 days) so that a replica that was offline cannot resurrect deleted data.

**Q: A table is used as a work queue and reads get slower every day. Explain and fix.**
A: Each processed item is inserted then deleted, leaving a tombstone at the head of the partition. Reading the head of the queue scans every accumulated tombstone before reaching live rows, so cost grows linearly with throughput until the query fails. The fix is to stop deleting: use `default_time_to_live` with `TimeWindowCompactionStrategy` so whole SSTables expire and are dropped without a read-time scan, or move the queue to a system designed for it.

**Q: What does a nonzero dropped-mutation count mean?**
A: A write sat in the MutationStage queue longer than `write_request_timeout_in_ms` (2 s) and was discarded without being applied. Because the coordinator may already have collected enough acks for `LOCAL_QUORUM`, the client was told the write succeeded while that replica is stale. It is a consistency incident: repair the affected ranges and fix the saturation — usually compaction backlog, GC, or disk — that caused the queue to grow.

**Q: (Senior) Walk me through diagnosing "the app got slow last Tuesday" with no deploys.**
A: Start with the shape: was it p99 only or the whole distribution, one table or all, one DC or all? Then split layers with `proxyhistograms` versus `tablehistograms` across several nodes to decide coordination versus storage. Compare per-node metrics to find the outlier — Cassandra problems are almost never uniform. On the outlier check queueing, compaction backlog, GC and device utilisation. Then check the four data-model numbers: SSTables-per-read p99, partition size p99, cell count p99, tombstones scanned p99. "No deploys" strongly suggests organic growth — a partition crossing a size threshold, a compaction backlog that finally tipped, a working set that outgrew page cache, or a tenant that grew — so plot those four numbers over the last two months rather than the last hour. Finally, name the key with `toppartitions` or `sstablepartitions` and propose the schema fix.

**Q: (Senior) You have a 900 MB partition. What breaks, and how do you migrate away from it safely?**
A: It breaks reads (large index deserialisation and heap allocation, GC pressure), compaction (a single very long task holding a compactor slot, and needing space for the whole partition), repair (streaming that partition is all-or-nothing), and bootstrap. Migration: design a new table with a bounded partition key — add a time bucket, and a synthetic shard if the key is also hot — then dual-write to old and new from the application, backfill historical data with a rate-limited job reading by token range, verify parity on a sample, switch reads to the new table behind a flag, keep dual-writing for a rollback window, then stop writing to the old table and drop it. The critical detail is the backfill must be token-range-based and rate limited, or it becomes its own incident.

**Q: (Senior) When is lowering `gc_grace_seconds` safe, and what is the failure mode if you get it wrong?**
A: It is safe only if repair reliably completes for every table within the new window on every node, because `gc_grace_seconds` is exactly the deadline by which a tombstone must have reached every replica. If a replica misses the tombstone and it is purged elsewhere, a later read repair or repair propagates the still-live old data back — deleted rows resurrect. So lowering it requires proven, monitored, scheduled repair (Reaper) with completion time well inside the window. The safer alternatives are TTL plus TWCS, where whole SSTables expire and are dropped without needing tombstone purging, and `unchecked_tombstone_compaction` / `tombstone_threshold` sub-properties to make single-SSTable compactions purge more aggressively.

**Q: How does speculative retry help, and when does it hurt?**
A: With `MIN(99p,50ms)` the coordinator sends an extra read to another replica if the first has not answered by the table's 99th-percentile latency, so a single slow replica — GC pause, compaction, noisy neighbour — no longer determines your p99. It hurts when the cluster is broadly saturated, because every speculation adds load and can push you further into overload; `ALWAYS` doubles read traffic outright and should essentially never be used in production.

**Q: What are the four `tablehistograms` numbers you check first and what do they mean?**
A: SSTables-per-read p99 (should be ≤ 4; above 8 means compaction is losing), partition size p99 (should be well under 100 MB), cell count p99 (should be under 100,000 rows), and — from `tablestats` or the tombstone histogram — tombstones scanned per read. Together these four diagnose the large majority of "everything on this table is slow" cases without needing any other tool.

**Q: How do you tell a hot node from a hot partition?**
A: Compare per-node request rate and pending queues. If exactly RF nodes (three, for RF 3) are hot and they are the replica set for one token range, it is a hot partition — confirm with `toppartitions` and `getendpoints`. If one node alone is hot, it is node-local: a failing disk, a noisy neighbour, GC, an unbalanced token assignment (check `nodetool status` `Owns%`), or a stuck compaction. If all nodes are equally slow, it is systemic — the data model, a schema change, or a client behaviour change.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Five causes cover nearly every Cassandra latency incident: wide partitions, hot partitions, GC pauses, compaction backlog, and tombstones. Diagnose by subtraction and comparison. Subtraction: `proxyhistograms` (coordinator, includes network and the slowest needed replica) minus `tablehistograms` (local storage engine) tells you whether the problem is coordination or storage. Comparison: per-node metrics find the outlier, because Cassandra problems are almost never uniform. On the suspect node run `tpstats` (queueing and dropped messages), `compactionstats` (backlog), `gcstats` (pauses), `iostat` (device). Then check four numbers in `tablehistograms`: SSTables-per-read p99 (≤ 4), partition size p99 (< 100 MB), cell count p99 (< 100k), tombstones scanned p99 (< 1000). Name the key with `toppartitions` for hot and `sstablepartitions` for wide, and confirm ownership with `getendpoints`. Hot and wide partitions are schema problems — bucket or shard the partition key; adding nodes does nothing. Tombstones from a queue pattern are fixed with TTL plus TWCS, not by lowering `gc_grace_seconds`. Keep the slow-query log and 0.1% trace sampling on permanently.

| Command / threshold | Purpose | Target / default |
|---|---|---|
| `nodetool proxyhistograms` | Coordinator-side percentiles | Compare against local |
| `nodetool tablehistograms ks.tbl` | SSTables/read, partition size, cells | ≤ 4, < 100 MB, < 100k |
| `nodetool tpstats` | Queueing and dropped messages | Pending ≈ 0, Dropped = 0 |
| `nodetool toppartitions ks.tbl 10000` | Names hot partition keys | Sampled from live traffic |
| `sstablepartitions --min-size N` | Names wide partitions from disk | < 100 MB |
| `nodetool getendpoints ks tbl key` | Which nodes own a suspect key | RF nodes |
| `tombstone_warn_threshold` | WARN with query text | 1000 |
| `tombstone_failure_threshold` | Abort the query | 100000 |
| `gc_grace_seconds` | Tombstone retention | 864000 (10 days) |
| `slow_query_log_timeout_in_ms` | Log slow queries with CQL text | 500 |
| `nodetool settraceprobability` | Sampled full tracing | 0.001 in production |

**Flash cards**
- **Coordinator p99 ≫ local p99 means** → Coordination: queueing, GC, network, cross-DC routing — not the storage engine.
- **Why adding nodes cannot fix a hot partition** → The key hashes to one token owned by exactly RF replicas, forever.
- **Two tombstone thresholds** → 1,000 scanned = WARN with query text; 100,000 = `TombstoneOverwhelmingException`.
- **Partition guidance** → Under 100 MB and under 100,000 rows; above 1 GB expect node instability.
- **The queue anti-pattern fix** → TTL plus TWCS so whole SSTables expire; never insert-then-delete.

## 11. Hands-On Exercises & Mini Project

- [ ] Create a table with a single hot partition, drive 90% of reads at it with `cassandra-stress` or a script, and confirm with per-node metrics that exactly RF nodes are hot. Use `nodetool toppartitions` to name the key and `nodetool getendpoints` to confirm the replicas.
- [ ] Build the queue anti-pattern: insert 200k rows to one partition, delete them, then `SELECT ... LIMIT 10` from that partition with `TRACING ON`. Record the tombstone count in the trace and keep going until you hit `TombstoneOverwhelmingException`.
- [ ] Grow a partition past 100 MB, then compare `nodetool tablehistograms` read p99 and `GCInspector` WARN frequency against a bucketed version of the same data.
- [ ] Throttle compaction to 1 MB/s under write load and chart SSTables-per-read p99 against read p99 until the relationship is obvious; then restore and chart the recovery.
- [ ] Practise the subtraction: run `proxyhistograms` and `tablehistograms` while artificially pausing one node (`kill -STOP` for 3 s) and show the coordinator/local gap appear and disappear.

**Mini Project — "Latency Forensics Kit"**

*Goal:* build a single command that an on-call engineer can run to produce a complete, ordered diagnosis of a Cassandra latency incident.

*Requirements:*
1. A script that, given a keyspace and table, collects across all nodes: `proxyhistograms`, `tablehistograms`, `tpstats`, `compactionstats`, `gcstats`, `tablestats`, and `nodetool status`, in parallel and with timeouts.
2. An analysis stage that computes and prints, in order: the coordinator-minus-local gap per node, the max/median ratio of read p99 across nodes (hot-node detector), the top three nodes by ReadStage pending, and any table exceeding the four thresholds (SSTables/read 8, partition 100 MB, cells 100k, tombstones 1000).
3. Automatic escalation: if a hot node is detected, run `toppartitions` on it and print the top keys with `getendpoints` output for each.
4. A log scanner that counts `GCInspector` WARNs, tombstone WARNs, dropped-message lines and "local pause" lines in the last hour and includes them in the report.
5. A one-page Markdown report with a ranked hypothesis list and the specific next command for each hypothesis.

*Extensions:* seed the four failure modes (hot partition, wide partition, compaction throttle, tombstone queue) with scripts and verify the kit reaches the correct diagnosis for each; add a comparison against a stored baseline so the report says "SSTables/read p99 was 3 last week, is 14 now"; wire it to fire automatically when a latency alert triggers and attach the report to the incident.

## 12. Related Topics & Free Learning Resources

Read with **31 · Monitoring, Metrics & Observability** (the metrics that make this diagnosable), **34 · JVM & Garbage Collection Tuning** (hypothesis two on every list), **35 · Performance Tuning & Benchmarking** (how to fix what you find), **32 · Multi-Datacenter Deployment & Replication** (a wrong `local_dc` is a top cause of mystery latency), and the data-modelling, compaction and tombstone chapters, which are where the real fixes live.

- **Troubleshooting (official docs)** — Apache Cassandra · *Intermediate* · the project's own guide to reading logs, using nodetool for diagnosis, and interpreting common exceptions. <https://cassandra.apache.org/doc/latest/cassandra/managing/operating/index.html>
- **nodetool reference: toppartitions, tablehistograms, proxyhistograms** — Apache Cassandra · *Beginner* · exact output semantics for the three commands this chapter is built on. <https://cassandra.apache.org/doc/latest/cassandra/managing/tools/nodetool/nodetool.html>
- **Request tracing** — Apache Cassandra · *Intermediate* · how tracing works, what `system_traces` contains, and how to sample it probabilistically. <https://cassandra.apache.org/doc/latest/cassandra/managing/operating/tracing.html>
- **About Deletes and Tombstones in Cassandra** — The Last Pickle · *Advanced* · the definitive explanation of tombstone lifecycle, `gc_grace_seconds` and data resurrection. <https://thelastpickle.com/blog/2016/07/27/about-deletes-and-tombstones.html>
- **How Discord Stores Trillions of Messages** — Discord Engineering · *Intermediate* · a real hot-partition investigation at extreme scale, including why cluster averages hid it. <https://discord.com/blog/how-discord-stores-trillions-of-messages>
- **CASSANDRA-8527: Improve range tombstone handling** — Apache JIRA · *Advanced* · the engineering behind range-tombstone cost, useful when reasoning about delete-heavy models. <https://issues.apache.org/jira/browse/CASSANDRA-8527>
- **Cassandra data modelling: partition sizing** — DataStax Academy / docs · *Intermediate* · why the 100 MB / 100k-row guidance exists and how to bucket keys to respect it. <https://docs.datastax.com/en/cql-oss/3.x/cql/ddl/dataModelingApproach.html>

---

*Apache Cassandra Handbook — chapter 36.*
