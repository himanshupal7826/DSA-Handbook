# 41 · Spark, Kafka & Streaming Integration

> **In one line:** Cassandra is a superb serving store and a terrible analytics engine, so you push scans into Spark via the token-range-aware connector and move changes in and out with Kafka Connect and CDC — always on a workload-isolated datacenter.

---

## 1. Overview

Cassandra answers "give me this partition" in single-digit milliseconds at any scale, and answers "sum this column across the whole table" by falling over. There is no distributed query planner, no shuffle, no join, and aggregation happens on a single coordinator holding results in heap. That is a deliberate design: every feature that would make analytics work would compromise the write path that makes Cassandra worth using. The consequence is that every serious Cassandra deployment eventually grows an analytics arm, and the standard shape of that arm is Spark for batch and interactive analytics, Kafka for movement of change events, and a dedicated datacenter so neither can touch production latency.

The Spark Cassandra Connector, maintained by DataStax and open source since 2014, is the piece that makes this work well rather than badly. Its central trick is **token-range partitioning**: instead of issuing one giant `SELECT *`, it splits the ring into ranges of roughly `spark.cassandra.input.split.sizeInMB` (default 512 MB) and generates one Spark partition per range with a `WHERE token(pk) > ? AND token(pk) <= ?` clause. Each Spark task then runs on the executor co-located with a replica of that range, so the scan is local disk reads and no data crosses the network unnecessarily. It also pushes down predicates, projects only requested columns, and — critically for joins — offers `joinWithCassandraTable`, which turns a join into per-key point lookups instead of a full scan and shuffle.

Kafka handles the other axis: movement. The **DataStax Apache Kafka Connector** (a sink connector) writes Kafka topics into Cassandra tables with configurable mapping, TTL, and consistency. In the other direction, Cassandra's **CDC** feature (introduced in 3.8 via `CASSANDRA-8844`, substantially improved in 4.0) copies commit log segments to a `cdc_raw` directory when a table has `cdc = true`, where an external agent parses them and publishes mutations. CDC is real but rough: it emits raw mutations, not resolved rows; it emits one event per replica, so `RF=3` means three copies of every change; and if nobody drains `cdc_raw`, writes to CDC-enabled tables are **rejected** once `cdc_total_space` fills. Most teams therefore prefer dual-write or outbox patterns over raw CDC.

Cassandra 5.0 does not change this architecture but sharpens two edges. Storage-Attached Indexes make a class of filtered scan viable inside Cassandra that previously demanded Spark, and vector search plus the Analytics-oriented improvements in the connector make Cassandra a plausible feature store rather than only a serving store.

A concrete example: a telecom stores 30 days of call detail records at 200k inserts/sec in `dc_serving` (`RF=3`), with an asynchronous `dc_analytics` (`RF=2`) replica set on cheaper, denser nodes. Spark jobs run only against `dc_analytics` with `LOCAL_ONE` consistency and `spark.cassandra.input.readsPerSec` throttling, producing hourly aggregates written back to a serving table. Meanwhile a Kafka Connect sink writes enriched records from a topic into a lookup table, and an outbox table plus a poller publishes billing events into Kafka. Production p99 never moves when analytics runs, because analytics is on different hardware in a different datacenter.
## 2. Core Concepts

- **Spark Cassandra Connector (SCC)** — the library that maps Cassandra tables to Spark RDDs/DataFrames, splits scans by token range, pushes down predicates, and writes back in batches grouped by partition key.
- **Token range split** — the connector divides the ring into ranges sized by `input.split.sizeInMB`, producing one Spark partition per range so scans parallelize and stay replica-local.
- **Data locality** — running Spark executors on (or near) Cassandra nodes so each task reads a range from a local replica, avoiding a network hop per row.
- **Predicate pushdown** — translating Spark filters into CQL `WHERE` clauses when they hit the partition key, clustering columns, or an index; everything else is filtered in Spark after the scan.
- **`joinWithCassandraTable`** — connector API turning a join into concurrent single-partition lookups keyed by the left side, avoiding a full table scan and shuffle.
- **`directJoin`** — the DataFrame/SQL equivalent, automatically chosen when the join key covers the Cassandra partition key and the left side is small relative to the table.
- **Workload-isolated datacenter** — a Cassandra DC that receives replicas but no client traffic, dedicated to analytics so scans cannot affect serving latency.
- **Kafka Connect sink** — the DataStax connector consuming Kafka topics and writing rows to Cassandra with declarative field-to-column mapping.
- **CDC (change data capture)** — per-table `cdc = true` causing commit log segments to be hard-linked into `cdc_raw` for external consumption after flush.
- **Outbox pattern** — writing business events to a Cassandra table in the same partition as the state change, then polling it to publish to Kafka; the pragmatic alternative to CDC.
- **`readsPerSec` / `throughputMBPerSec`** — connector throttles that cap how hard a Spark job hits Cassandra, the difference between a healthy job and an incident.
## 3. Theory & Internals

### 3.1 How the connector parallelizes a scan

The connector asks the cluster for the token ranges and their replicas (via `system.size_estimates` and the driver's token map), estimates the data size per range, and groups ranges into Spark partitions targeting `input.split.sizeInMB` each. For each Spark partition it generates:

```cql
SELECT col_a, col_b FROM ks.tbl
 WHERE token(pk) > -3074457345618258602
   AND token(pk) <= 3074457345618258602
   ALLOW FILTERING
```

`ALLOW FILTERING` here is safe and idiomatic — unlike in application code — because the token bound *is* the partition restriction; the clause only tells the server that additional non-key predicates may be evaluated during the scan.

The number of Spark partitions is roughly:

```
num_partitions ≈ estimated_table_bytes_per_dc / (split.sizeInMB × 1MB)
```

Too few partitions and each task is enormous and prone to timeout; too many and scheduling overhead dominates. For a 2 TB table with the 512 MB default you get ~4000 partitions — reasonable. If `system.size_estimates` is stale (it updates every 5 minutes and is empty on freshly loaded tables), the connector guesses badly, which is why `spark.cassandra.input.split.sizeInMB` sometimes has to be set manually.

### 3.2 Locality and consistency

Each generated partition carries preferred locations equal to the replica endpoints for its range. If a Spark executor runs on the same host, `NODE_LOCAL` scheduling means zero network transfer. This is why the classic deployment co-locates Spark workers with Cassandra nodes in the analytics DC.

Consistency matters more than people expect. Analytics should read at `LOCAL_ONE`:

```
LOCAL_ONE  → 1 replica read, minimal load, may see slightly stale data
LOCAL_QUORUM → 2 replicas at RF=3, doubling read load for a full-table scan
```

For a table scan, `LOCAL_QUORUM` doubles or triples the I/O for a correctness guarantee that a batch job computing hourly aggregates rarely needs.

```svg
<svg viewBox="0 0 760 370" width="100%" height="370" font-family="ui-sans-serif,system-ui,sans-serif"> <rect x="0" y="0" width="760" height="370" fill="#ffffff"/>
<text x="20" y="26" font-size="15" font-weight="bold" fill="#1e293b">Token range splitting drives Spark parallelism</text>
<circle cx="150" cy="180" r="105" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/> <text x="112" y="62" font-size="12" fill="#1e293b">token ring</text>
<line x1="150" y1="75" x2="150" y2="180" stroke="#4f46e5" stroke-width="1.5"/> <line x1="241" y1="232" x2="150" y2="180" stroke="#4f46e5" stroke-width="1.5"/>
<line x1="59" y1="232" x2="150" y2="180" stroke="#4f46e5" stroke-width="1.5"/> <text x="196" y="120" font-size="11" fill="#1e293b">R1</text>
<text x="196" y="252" font-size="11" fill="#1e293b">R2</text> <text x="90" y="252" font-size="11" fill="#1e293b">R3</text>
<rect x="320" y="60" width="180" height="52" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/> <text x="334" y="82" font-size="11" fill="#1e293b">Spark partition 1</text>
<text x="334" y="100" font-size="10" fill="#1e293b">token(pk) in (min, t1]</text> <rect x="320" y="130" width="180" height="52" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
<text x="334" y="152" font-size="11" fill="#1e293b">Spark partition 2</text> <text x="334" y="170" font-size="10" fill="#1e293b">token(pk) in (t1, t2]</text>
<rect x="320" y="200" width="180" height="52" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/> <text x="334" y="222" font-size="11" fill="#1e293b">Spark partition 3</text>
<text x="334" y="240" font-size="10" fill="#1e293b">token(pk) in (t2, max]</text> <path d="M258 130 L320 90" stroke="#0ea5e9" stroke-width="1.5" marker-end="url(#a41)"/>
<path d="M258 180 L320 158" stroke="#0ea5e9" stroke-width="1.5" marker-end="url(#a41)"/> <path d="M258 228 L320 226" stroke="#0ea5e9" stroke-width="1.5" marker-end="url(#a41)"/>
<rect x="545" y="60" width="195" height="192" rx="8" fill="#f0fdf4" stroke="#16a34a"/> <text x="561" y="84" font-size="12" font-weight="bold" fill="#1e293b">Executor placement</text>
<text x="561" y="110" font-size="11" fill="#1e293b">Each partition carries the</text> <text x="561" y="128" font-size="11" fill="#1e293b">replica endpoints as</text>
<text x="561" y="146" font-size="11" fill="#1e293b">preferred locations.</text> <text x="561" y="172" font-size="11" fill="#1e293b">NODE_LOCAL scheduling</text>
<text x="561" y="190" font-size="11" fill="#1e293b">means local disk reads,</text> <text x="561" y="208" font-size="11" fill="#1e293b">no cross node transfer.</text>
<text x="561" y="234" font-size="11" fill="#1e293b">Read at LOCAL_ONE.</text> <rect x="20" y="300" width="720" height="56" rx="8" fill="#fef3c7" stroke="#d97706"/>
<text x="36" y="324" font-size="12" font-weight="bold" fill="#1e293b">Sizing rule</text>
<text x="36" y="344" font-size="11" fill="#1e293b">partitions ≈ table bytes per DC / input.split.sizeInMB (default 512 MB). Stale system.size_estimates makes this wrong.</text> <defs>
<marker id="a41" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"> <path d="M0 0 L8 4 L0 8 z" fill="#1e293b"/> </marker> </defs> </svg>
```

### 3.3 Why joins must be direct joins

A naive Spark join between a 10-million-row DataFrame and a 5-billion-row Cassandra table scans all 5 billion rows and shuffles them. `joinWithCassandraTable` (RDD) and `directJoin` (DataFrame) instead issue one prepared single-partition query per left-side key, concurrently, with token-aware routing:

```
Full scan join:  5e9 rows read + shuffle          ≈ hours, cluster-hostile
Direct join:     1e7 point lookups at ~1 ms       ≈ minutes, cluster-friendly
```

The DataFrame optimizer chooses `directJoin` automatically when the join key includes the full Cassandra partition key and the size ratio passes `spark.cassandra.sql.inClauseToJoinConversionThreshold`; force it with `spark.cassandra.sql.enableDirectJoin` or the `directJoin` hint. Always verify with `explain()` — the plan will show `Cassandra Direct Join` when it worked.

### 3.4 CDC mechanics and their sharp edges

With `cdc = true` on a table, commit log segments containing mutations for that table are hard-linked into `cdc_raw` on flush (in 4.0, with an index file so consumers can tail the current segment rather than waiting for it to close). Key properties:

- **Per-replica, not per-row.** At `RF=3`, each mutation appears in three nodes' `cdc_raw`. Deduplication is the consumer's problem.
- **Mutations, not rows.** You get the delta that was written, not the resolved row — no before-image, no merged view.
- **Back-pressure is fatal.** `cdc_total_space` (default 4096 MiB or 1/8 of the commitlog volume) caps `cdc_raw`. When full, writes to CDC tables fail with `CDCWriteException`. An unattended consumer takes production down.
- **No ordering guarantee across partitions**, and commit log order is per-node.

This is why the **outbox pattern** — writing an event row into a Cassandra table in the same batch as the state change, and polling it — is more common than CDC for application-level event publication. It is at-least-once, ordered within a partition, easy to reason about, and cannot wedge the write path.
## 4. Architecture & Workflow

The standard production topology and the flow through it:

1. **Split the cluster into datacenters.** `dc_serving` with `RF=3` on latency-optimized nodes takes all application traffic; `dc_analytics` with `RF=2` on dense, cheaper nodes takes replicas only. Keyspace replication: `{'class':'NetworkTopologyStrategy','dc_serving':3,'dc_analytics':2}`.
2. **Point applications at `dc_serving`** with `LOCAL_QUORUM` and a DC-pinned load balancing policy, so they can never read from analytics nodes.
3. **Run Spark workers in `dc_analytics`**, ideally co-located with the Cassandra processes for `NODE_LOCAL` scheduling, configured with `spark.cassandra.connection.local_dc = dc_analytics` and `input.consistency.level = LOCAL_ONE`.
4. **A Spark job starts.** The connector reads `system.size_estimates` and the token map, computes token-range splits, and creates Spark partitions with replica-preferred locations.
5. **Tasks scan.** Each task issues token-bounded `SELECT`s with projection and any pushed-down predicates, throttled by `input.readsPerSec` so the scan cannot saturate the node.
6. **Spark computes.** Joins against Cassandra use `directJoin`; joins against other sources shuffle normally.
7. **Results are written back.** The connector groups rows by partition key into unlogged batches (`output.batch.grouping.key = partition`), writes at `LOCAL_QUORUM` into `dc_analytics`, and Cassandra replicates them to `dc_serving` asynchronously.
8. **Kafka inbound.** A Kafka Connect cluster runs the DataStax Cassandra sink, mapping topic fields to columns, applying TTLs, and writing into serving tables with configurable consistency and `maxConcurrentRequests`.
9. **Kafka outbound.** Either (a) an outbox table polled by a small service that publishes to Kafka and deletes/TTLs the row, or (b) CDC with an agent tailing `cdc_raw`, deduplicating across replicas, and publishing.
10. **Everything is throttled and monitored.** Connector read/write rates, Kafka Connect lag, `cdc_raw` directory size, and serving-DC p99 are all alerted, because the entire architecture exists to protect that last number.

```svg
<svg viewBox="0 0 760 390" width="100%" height="390" font-family="ui-sans-serif,system-ui,sans-serif"> <rect x="0" y="0" width="760" height="390" fill="#ffffff"/>
<text x="20" y="26" font-size="15" font-weight="bold" fill="#1e293b">Serving DC and analytics DC: the isolation topology</text>
<rect x="20" y="50" width="330" height="150" rx="10" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
<text x="40" y="76" font-size="13" font-weight="bold" fill="#1e293b">dc_serving  RF=3</text> <rect x="40" y="92" width="80" height="40" rx="6" fill="#ffffff" stroke="#0ea5e9"/>
<text x="62" y="117" font-size="11" fill="#1e293b">node</text> <rect x="135" y="92" width="80" height="40" rx="6" fill="#ffffff" stroke="#0ea5e9"/>
<text x="157" y="117" font-size="11" fill="#1e293b">node</text> <rect x="230" y="92" width="80" height="40" rx="6" fill="#ffffff" stroke="#0ea5e9"/>
<text x="252" y="117" font-size="11" fill="#1e293b">node</text> <text x="40" y="158" font-size="11" fill="#1e293b">app traffic only, LOCAL_QUORUM</text>
<text x="40" y="178" font-size="11" fill="#1e293b">latency optimized hardware</text> <rect x="410" y="50" width="330" height="150" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
<text x="430" y="76" font-size="13" font-weight="bold" fill="#1e293b">dc_analytics  RF=2</text> <rect x="430" y="92" width="90" height="40" rx="6" fill="#ffffff" stroke="#16a34a"/>
<text x="440" y="117" font-size="10" fill="#1e293b">node+spark</text> <rect x="535" y="92" width="90" height="40" rx="6" fill="#ffffff" stroke="#16a34a"/>
<text x="545" y="117" font-size="10" fill="#1e293b">node+spark</text> <rect x="640" y="92" width="90" height="40" rx="6" fill="#ffffff" stroke="#16a34a"/>
<text x="650" y="117" font-size="10" fill="#1e293b">node+spark</text> <text x="430" y="158" font-size="11" fill="#1e293b">scans only, LOCAL_ONE, throttled</text>
<text x="430" y="178" font-size="11" fill="#1e293b">dense cheap disks</text> <path d="M350 125 L410 125" stroke="#4f46e5" stroke-width="2" marker-end="url(#a41b)"/>
<text x="352" y="116" font-size="10" fill="#1e293b">async replication</text> <rect x="20" y="232" width="220" height="70" rx="8" fill="#fef3c7" stroke="#d97706"/>
<text x="36" y="256" font-size="12" font-weight="bold" fill="#1e293b">Kafka Connect sink</text> <text x="36" y="278" font-size="11" fill="#1e293b">topic to table mapping,</text>
<text x="36" y="294" font-size="11" fill="#1e293b">TTL, LOCAL_QUORUM</text> <rect x="270" y="232" width="220" height="70" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
<text x="286" y="256" font-size="12" font-weight="bold" fill="#1e293b">Outbox poller</text> <text x="286" y="278" font-size="11" fill="#1e293b">event rows to Kafka,</text>
<text x="286" y="294" font-size="11" fill="#1e293b">at least once, ordered per pk</text> <rect x="520" y="232" width="220" height="70" rx="8" fill="#fef3c7" stroke="#d97706"/>
<text x="536" y="256" font-size="12" font-weight="bold" fill="#1e293b">CDC agent</text> <text x="536" y="278" font-size="11" fill="#1e293b">tails cdc_raw, dedups RF</text>
<text x="536" y="294" font-size="11" fill="#1e293b">copies, must never stall</text> <path d="M130 232 L130 200" stroke="#d97706" stroke-width="1.5" marker-end="url(#a41b)"/>
<path d="M380 232 L200 200" stroke="#4f46e5" stroke-width="1.5" marker-end="url(#a41b)"/> <path d="M630 232 L300 202" stroke="#d97706" stroke-width="1.5" marker-end="url(#a41b)"/>
<rect x="20" y="322" width="720" height="56" rx="8" fill="#f0fdf4" stroke="#16a34a"/> <text x="36" y="346" font-size="12" font-weight="bold" fill="#1e293b">The invariant</text>
<text x="36" y="366" font-size="11" fill="#1e293b">No analytics workload ever issues a query against dc_serving. Isolation is topological, not a setting.</text> <defs>
<marker id="a41b" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"> <path d="M0 0 L8 4 L0 8 z" fill="#1e293b"/> </marker> </defs> </svg>
```
## 5. Implementation

### 5.1 Keyspace with an analytics datacenter

```cql
ALTER KEYSPACE telecom WITH replication = {
  'class': 'NetworkTopologyStrategy',
  'dc_serving': 3,
  'dc_analytics': 2
};
-- Then, on every analytics node:
--   nodetool rebuild -- dc_serving
```

```cql
CREATE TABLE telecom.cdr (
  subscriber_id text,
  call_day      date,
  call_ts       timestamp,
  duration_s    int,
  cell_id       text,
  cost_cents    int,
  PRIMARY KEY ((subscriber_id, call_day), call_ts)
) WITH CLUSTERING ORDER BY (call_ts DESC)
  AND compaction = {'class':'TimeWindowCompactionStrategy',
                    'compaction_window_unit':'DAYS','compaction_window_size':1}
  AND default_time_to_live = 2592000;
```

### 5.2 Spark: read, aggregate, write back

```bash
spark-submit \
  --packages com.datastax.spark:spark-cassandra-connector_2.12:3.5.1 \
  --conf spark.cassandra.connection.host=10.9.0.11,10.9.0.12 \
  --conf spark.cassandra.connection.localDC=dc_analytics \
  --conf spark.cassandra.auth.username=$CASS_USER \
  --conf spark.cassandra.auth.password=$CASS_PASSWORD \
  --conf spark.cassandra.input.consistency.level=LOCAL_ONE \
  --conf spark.cassandra.output.consistency.level=LOCAL_QUORUM \
  --conf spark.cassandra.input.split.sizeInMB=256 \
  --conf spark.cassandra.input.fetch.sizeInRows=2000 \
  --conf spark.cassandra.input.readsPerSec=8000 \
  --conf spark.cassandra.output.throughputMBPerSec=32 \
  --conf spark.cassandra.output.concurrent.writes=32 \
  --conf spark.sql.extensions=com.datastax.spark.connector.CassandraSparkExtensions \
  daily_revenue.py
```

```python
# daily_revenue.py
from pyspark.sql import SparkSession
from pyspark.sql import functions as F

spark = SparkSession.builder.appName("daily-revenue").getOrCreate()

cdr = (spark.read
       .format("org.apache.spark.sql.cassandra")
       .options(keyspace="telecom", table="cdr")
       .load())

# Predicate pushdown: call_day is part of the partition key, so this becomes
# a CQL WHERE clause instead of a full scan filtered in Spark.
daily = (cdr
         .filter(F.col("call_day") == "2026-07-21")
         .groupBy("subscriber_id", "call_day")
         .agg(F.sum("cost_cents").alias("total_cents"),
              F.sum("duration_s").alias("total_seconds"),
              F.count("*").alias("call_count")))

daily.explain(True)
# == Physical Plan ==
# *(2) HashAggregate(keys=[subscriber_id, call_day], ...)
#  +- Cassandra Scan: telecom.cdr
#     - Cassandra Filters: [["call_day" = ?, 2026-07-21]]
#     - Requested Columns: [subscriber_id,call_day,cost_cents,duration_s]

(daily.write
      .format("org.apache.spark.sql.cassandra")
      .options(keyspace="telecom", table="daily_revenue")
      .mode("append")
      .save())
```

### 5.3 Direct join instead of a full scan

```python
# A 10M-row list of subscribers to enrich from a 5B-row Cassandra table.
subs = spark.read.parquet("s3://data/target_subscribers/")   # column: subscriber_id

profiles = (spark.read.format("org.apache.spark.sql.cassandra")
            .options(keyspace="telecom", table="subscriber_profile").load())

joined = subs.join(profiles, on="subscriber_id", how="inner")
joined.explain()
# == Physical Plan ==
# Cassandra Direct Join [subscriber_id = subscriber_id] telecom.subscriber_profile
#   +- FileScan parquet [subscriber_id]
# ^ "Cassandra Direct Join" means per-key lookups, NOT a 5B row scan.
```

```scala
// RDD API equivalent, still the most explicit form
import com.datastax.spark.connector._
val keys = sc.parallelize(subscriberIds).map(id => Tuple1(id))
val enriched = keys.joinWithCassandraTable("telecom", "subscriber_profile")
                   .withConnector(analyticsConnector)
```

### 5.4 Kafka Connect sink into Cassandra

```json
{
  "name": "cdr-cassandra-sink",
  "config": {
    "connector.class": "com.datastax.oss.kafka.sink.CassandraSinkConnector",
    "tasks.max": "8",
    "topics": "cdr.enriched",
    "contactPoints": "10.0.1.11,10.0.1.12",
    "loadBalancing.localDc": "dc_serving",
    "auth.provider": "PLAIN",
    "auth.username": "${env:CASS_USER}",
    "auth.password": "${env:CASS_PASSWORD}",
    "ssl.provider": "JDK",
    "ssl.truststore.path": "/etc/ssl/cassandra/truststore.jks",
    "topic.cdr.enriched.telecom.cdr.mapping":
      "subscriber_id=value.msisdn, call_day=value.day, call_ts=value.ts, duration_s=value.dur, cell_id=value.cell, cost_cents=value.cost",
    "topic.cdr.enriched.telecom.cdr.consistencyLevel": "LOCAL_QUORUM",
    "topic.cdr.enriched.telecom.cdr.ttlTimeUnit": "SECONDS",
    "topic.cdr.enriched.telecom.cdr.ttl": "2592000",
    "topic.cdr.enriched.telecom.cdr.nullToUnset": "true",
    "maxConcurrentRequests": "500",
    "maxNumberOfRecordsInBatch": "32",
    "queryExecutionTimeout": "30",
    "ignoreErrors": "None"
  }
}
```

> **Note:** `nullToUnset: true` is important. Writing an explicit `null` creates a **tombstone**; treating null as "unset" leaves the existing value alone and creates nothing. A sink connector with `nullToUnset: false` on a sparse topic is a tombstone factory.

### 5.5 CDC and the outbox alternative

```yaml
# cassandra.yaml -- enable CDC infrastructure
cdc_enabled: true
cdc_raw_directory: /var/lib/cassandra/cdc_raw
cdc_total_space: 8192MiB          # writes to CDC tables FAIL when this fills
cdc_free_space_check_interval: 250ms
```

```cql
ALTER TABLE telecom.cdr WITH cdc = true;
```

```cql
-- The outbox alternative: safer, simpler, at-least-once.
CREATE TABLE telecom.event_outbox (
  shard      int,
  event_ts   timeuuid,
  event_type text,
  payload    text,
  PRIMARY KEY ((shard), event_ts)
) WITH CLUSTERING ORDER BY (event_ts ASC)
  AND default_time_to_live = 604800
  AND compaction = {'class':'TimeWindowCompactionStrategy',
                    'compaction_window_unit':'HOURS','compaction_window_size':6};
```

```python
# Poller: read a shard forward from the last published timeuuid, publish, advance.
from cassandra.util import unix_time_from_uuid1
SELECT_BATCH = session.prepare("""
    SELECT event_ts, event_type, payload FROM telecom.event_outbox
     WHERE shard = ? AND event_ts > ? LIMIT 500
""")
SELECT_BATCH.is_idempotent = True

def drain(shard, cursor, producer):
    rows = list(session.execute(SELECT_BATCH, (shard, cursor)))
    for r in rows:
        producer.send("telecom.events", key=str(shard).encode(),
                      value=r.payload.encode())
    producer.flush()
    return rows[-1].event_ts if rows else cursor   # advance only after flush
```

**Optimization note.** Four settings decide whether a Spark job is neighbourly or an outage. `input.split.sizeInMB` controls task size — lower it (128–256 MB) for wide rows so tasks do not time out. `input.readsPerSec` throttles per-executor read rate; set it so `executors × readsPerSec` stays comfortably under the analytics DC's capacity. `output.throughputMBPerSec` and `output.concurrent.writes` do the same for the write path. And `output.batch.grouping.key = partition` with `output.batch.size.rows` groups writes by partition key into unlogged batches, which is the one case where batching genuinely helps because every row in the batch lands on the same replica set. Always read at `LOCAL_ONE` for analytics; `LOCAL_QUORUM` on a full-table scan doubles the load for a guarantee you almost never need.
## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost/Trade-off |
|---|---|---|
| Spark connector token splits | Parallel, replica-local scans; the only sane way to full-scan Cassandra | Relies on `system.size_estimates`, which is stale or empty for new tables |
| Data locality (co-located Spark) | Zero-copy-ish local reads; large throughput gain | Spark and Cassandra compete for CPU, page cache, and disk on the same box |
| Predicate pushdown | Filters on partition/clustering keys become cheap CQL restrictions | Anything else is scanned then filtered in Spark — deceptively expensive |
| `directJoin` | Turns a 5B-row scan into 10M point lookups | Only applies when the join key covers the full partition key |
| Analytics datacenter | Complete workload isolation; serving p99 unaffected | Extra hardware and the full storage cost of another replica set |
| Kafka Connect sink | Declarative, at-least-once ingestion with mapping, TTL, and CL control | Another cluster to run; needs `nullToUnset` care to avoid tombstone storms |
| CDC | Native change stream without dual writes | Per-replica duplicates, raw mutations not rows, and a full `cdc_raw` **blocks writes** |
| Outbox pattern | Simple, ordered per partition, cannot wedge the write path | Extra write per event; polling latency; requires TTL/cleanup discipline |
| Writing Spark results back to Cassandra | Serving-ready aggregates with no extra store | Heavy write bursts can trigger compaction storms; throttle output |
| SAI (Cassandra 5.0) | Some filtered queries no longer need Spark at all | Still not a substitute for joins, shuffles, or large aggregations |
## 7. Common Mistakes & Best Practices

1. ⚠️ **Running Spark jobs against the serving datacenter.** → ✅ Create `dc_analytics`, `nodetool rebuild` it, and pin `spark.cassandra.connection.localDC` to it. A full scan against serving nodes evicts page cache and destroys p99 for everything else.
2. ⚠️ **Reading at `LOCAL_QUORUM` in Spark.** → ✅ Use `input.consistency.level=LOCAL_ONE`. A quorum full-table scan doubles or triples read I/O for a freshness guarantee batch analytics rarely needs.
3. ⚠️ **Leaving the connector unthrottled.** → ✅ Set `input.readsPerSec` and `output.throughputMBPerSec`. Spark will happily issue as many concurrent requests as it has cores and produce `OverloadedException` across the cluster.
4. ⚠️ **Assuming a Spark filter became a CQL predicate.** → ✅ Call `.explain(True)` and read the `Cassandra Filters` line. Only partition key, clustering key (in order), and indexed columns push down; everything else scans first.
5. ⚠️ **Joining a DataFrame to a Cassandra table without `directJoin`.** → ✅ Verify `Cassandra Direct Join` appears in the plan; if not, enable `spark.cassandra.sql.enableDirectJoin` or use `joinWithCassandraTable`. Otherwise you are scanning billions of rows to match millions.
6. ⚠️ **Enabling CDC without a consumer that provably keeps up.** → ✅ Monitor `cdc_raw` directory size and alert well below `cdc_total_space`. When it fills, writes to CDC-enabled tables are rejected — CDC can take production down.
7. ⚠️ **Treating CDC output as a row stream.** → ✅ It is a mutation stream, duplicated once per replica, with no before-image. Deduplicate by (partition key, clustering key, timestamp) and resolve state yourself, or use the outbox pattern instead.
8. ⚠️ **Kafka sink with `nullToUnset: false`.** → ✅ Set it to `true`. Every null field otherwise becomes a tombstone, and a sparse topic at high volume produces tombstone-driven read failures within days.
9. ⚠️ **Using the default 512 MB split with very wide rows.** → ✅ Lower `input.split.sizeInMB` to 128–256 so tasks finish inside the read timeout; otherwise you get repeated task failures and a job that never completes.
10. ⚠️ **Writing Spark output with logged batches or unpartitioned batching.** → ✅ Keep `output.batch.grouping.key = partition`, which groups rows destined for the same partition into unlogged batches. Cross-partition batching in a write-heavy job is pure overhead.
11. ⚠️ **Expecting `system.size_estimates` to be right immediately.** → ✅ It refreshes roughly every 5 minutes and is empty for freshly written tables, which makes the connector generate one enormous partition. Run a flush and wait, or set the split size explicitly.
12. ⚠️ **Bulk-loading through the CQL write path.** → ✅ For very large initial loads, generate SSTables offline with `CQLSSTableWriter` and stream them in with `sstableloader`. It bypasses the commit log and memtable path entirely and is an order of magnitude cheaper than inserting row by row.
## 8. Production: Debugging, Monitoring, Security & Scaling

### Debugging

```bash
# Is the analytics DC actually receiving replicas?
nodetool status telecom
# Datacenter: dc_analytics   -- all nodes UN with non-trivial Load

# Did a Spark job hurt the serving DC? Compare before/after on serving nodes:
nodetool tpstats | grep -E "ReadStage|Dropped"
nodetool proxyhistograms

# Is size_estimates populated (the connector depends on it)?
cqlsh -e "SELECT keyspace_name, table_name, range_start, mean_partition_size, partitions_count
          FROM system.size_estimates WHERE keyspace_name='telecom' LIMIT 5;"

# CDC backlog -- the number that must never approach cdc_total_space
du -sh /var/lib/cassandra/cdc_raw
```

In Spark, the two artefacts that answer most questions are `df.explain(True)` (did predicates push down, did the direct join fire) and the Spark UI's task-duration distribution (a long tail means uneven token ranges or a hot partition).

### Monitoring

| Signal | Where | Alert |
|---|---|---|
| Serving-DC read p99 | `ClientRequest.Read.Latency` on `dc_serving` | any change during analytics windows |
| Analytics-DC read rate | `ClientRequest.Read.Count` on `dc_analytics` | above planned `readsPerSec × executors` |
| Dropped mutations | `DroppedMessage.MUTATION` | any non-zero |
| `cdc_raw` size | filesystem | > 50% of `cdc_total_space` |
| Kafka Connect lag | consumer group lag on sink topics | sustained growth |
| Sink task failures | Connect REST `/connectors/<n>/status` | any FAILED task |
| Spark task failure rate | Spark UI / history server | > 1% |
| Tombstones scanned | `Table.TombstoneScannedHistogram` | p99 > 1000 (often the sink's fault) |

### Security

Analytics paths are a classic privilege sprawl vector. Give Spark its own Cassandra role with `SELECT` on exactly the tables it reads and `MODIFY` only on the result tables, restricted with `ACCESS TO DATACENTERS {'dc_analytics'}` (4.1+). Give the Kafka sink a separate role with `MODIFY` on its target tables only. Both should use TLS with hostname verification, and credentials must come from the platform's secret store — Kafka Connect supports `${env:VAR}` and file-based config providers precisely so passwords do not sit in connector JSON. Treat Spark result artefacts (Parquet in object storage) as carrying the same data classification as the source tables.

### Performance & Scaling

Scale the analytics DC on storage and sequential throughput, not on latency; dense nodes with big disks are ideal because scans are sequential and nobody is waiting on a p99. Scale Spark executors until the connector throttles become the binding constraint, then raise the throttles only if analytics-DC metrics show headroom. For very large ingests, prefer `sstableloader` over the CQL path. And schedule: run heavy jobs in a window, stagger them, and make the job fail fast if serving-DC latency alerts are firing — analytics should always be the thing that yields.
## 9. Interview Questions

**Q: Why can't you just run analytical queries directly in Cassandra?**
A: Cassandra has no distributed query planner, no shuffle, and no joins; aggregations run on a single coordinator that must hold intermediate results in heap, and full scans read every SSTable on every node while evicting page cache. It is optimized for partition-scoped access at low latency, and any query that ignores the partition key fights that design. Spark supplies the missing execution engine while the connector supplies parallel, replica-local access.

**Q: How does the Spark Cassandra Connector parallelize a table scan?**
A: It reads the token map and `system.size_estimates`, divides the ring into token ranges sized by `spark.cassandra.input.split.sizeInMB` (default 512 MB), and creates one Spark partition per group of ranges, each issuing a `WHERE token(pk) > ? AND token(pk) <= ?` query. Each Spark partition carries the range's replica endpoints as preferred locations, so with co-located executors the scan reads from local disk.

**Q: What is `joinWithCassandraTable` and why does it matter?**
A: It joins a Spark RDD/DataFrame to a Cassandra table by issuing concurrent single-partition lookups for each left-side key rather than scanning the whole table and shuffling. For a 10-million-row left side against a 5-billion-row table, that is the difference between minutes of point reads and hours of full scan. The DataFrame equivalent is `directJoin`, and you should confirm it fired by looking for `Cassandra Direct Join` in `explain()`.

**Q: What consistency level should Spark use, and why?**
A: `LOCAL_ONE` for reads. A full-table scan at `LOCAL_QUORUM` contacts two replicas per row at `RF=3`, doubling the I/O and cluster load for a freshness guarantee that batch aggregation does not need. Writes back into Cassandra should still use `LOCAL_QUORUM` because those results are read by applications.

**Q: What is Cassandra CDC and what are its main limitations?**
A: With `cdc = true` on a table, commit log segments containing its mutations are hard-linked into `cdc_raw` for an external agent to parse. The limitations are severe: you get raw mutations rather than resolved rows, one copy per replica so `RF=3` triples events, no cross-partition ordering, and — most dangerously — writes to CDC-enabled tables are rejected once `cdc_raw` fills to `cdc_total_space`, so a stalled consumer becomes a production outage.

**Q: Why do many teams use an outbox table instead of CDC?**
A: An outbox writes the event as an ordinary row in the same partition-scoped operation as the state change, then a poller reads it forward by clustering key and publishes to Kafka. It gives at-least-once delivery ordered within a partition, is trivial to reason about and debug, uses TTL and TWCS for automatic cleanup, and cannot block the write path if the consumer stops. The cost is one extra write per event and polling latency.

**Q: (Senior) A nightly Spark job makes API p99 jump from 4 ms to 60 ms. Diagnose and fix.**
A: The job is almost certainly reading from the serving datacenter, or from an analytics DC that shares hardware, and its scan is evicting page cache and consuming read threads. Confirm by correlating job start time with `ClientRequest.Read.Latency` and `ReadStage` pending on serving nodes. The structural fix is a dedicated `dc_analytics` with `nodetool rebuild` and `spark.cassandra.connection.localDC` pinned to it; the immediate mitigations are `input.consistency.level=LOCAL_ONE`, `input.readsPerSec` throttling, smaller `split.sizeInMB`, and moving the job to a low-traffic window. Long term, enforce it with RBAC: the Spark role gets `ACCESS TO DATACENTERS {'dc_analytics'}` so it physically cannot query serving nodes.

**Q: (Senior) Your Kafka sink connector is causing read timeouts on a table within a week of deployment. What happened?**
A: Almost certainly `nullToUnset` is false and the topic has sparse records, so every absent field writes an explicit null, which is a tombstone. Reads then scan thousands of tombstones per partition, blow past `tombstone_warn_threshold` (1000) and eventually `tombstone_failure_threshold` (100000), and fail. Confirm with `nodetool tablehistograms` and the `TombstoneScannedHistogram` metric plus WARN lines in `system.log`. Fix by setting `nullToUnset: true`, then clean up by running compaction — and consider whether `gc_grace_seconds` plus repair cadence lets those tombstones actually be purged.

**Q: (Senior) How would you bulk-load 20 TB of historical data into a live cluster?**
A: Not through the CQL write path — 20 TB of inserts generates enormous commit log, memtable, and compaction pressure on nodes that are also serving traffic. Instead generate SSTables offline with `CQLSSTableWriter` in a Spark job (or use the connector's bulk writer), then stream them in with `sstableloader` against the analytics DC, throttled with `--throttle`. Load in chunks aligned to partition-key ranges so you can pause between chunks, monitor compaction backlog and serving-DC latency between chunks, and choose a compaction strategy (often TWCS if the data is time-series) that will not rewrite the whole dataset afterwards.

**Q: What does `spark.cassandra.input.split.sizeInMB` control and when do you change it?**
A: It is the target amount of Cassandra data per Spark partition, defaulting to 512 MB, and it determines how many tasks the job creates. Lower it to 128–256 MB when rows are wide or tasks are timing out, and raise it when you have millions of tiny partitions and scheduling overhead dominates. It only works well if `system.size_estimates` is populated, so freshly written tables may need an explicit value.

**Q: What is data locality in this context and how do you get it?**
A: Each Spark partition generated by the connector reports the replica endpoints for its token range as preferred locations, so Spark's scheduler will place the task on an executor running on one of those hosts if one exists. You get it by running Spark workers on the Cassandra nodes themselves (or in the same rack/AZ), which turns a network read into a local disk read. The trade-off is CPU and page-cache contention between Spark and Cassandra on the same machine, which is exactly why you do it in the analytics DC and not the serving DC.

**Q: How do you write Spark results back to Cassandra efficiently?**
A: Use the connector's write path with `output.batch.grouping.key = partition` so rows going to the same partition are grouped into unlogged batches destined for one replica set, and set `output.concurrent.writes` and `output.throughputMBPerSec` so the burst does not trigger a compaction storm. Write at `LOCAL_QUORUM` since applications read the results, and prefer writing into the analytics DC and letting Cassandra replicate to serving asynchronously rather than driving the write directly at serving nodes.
## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Cassandra serves partitions; Spark does analytics; Kafka moves change. Give analytics its own datacenter (`NetworkTopologyStrategy` with `dc_analytics`, `nodetool rebuild`) and pin `spark.cassandra.connection.localDC` to it — isolation is topological, not a setting. The connector splits the ring into token ranges of `input.split.sizeInMB` (512 MB default), one Spark partition each, scheduled on replica-local executors, so scans are parallel and local. Read at `LOCAL_ONE`, throttle with `input.readsPerSec` and `output.throughputMBPerSec`, and always check `explain(True)` for pushed-down `Cassandra Filters` and `Cassandra Direct Join`. Joins must be direct joins or you scan billions of rows. Inbound from Kafka, use the DataStax sink with `nullToUnset: true` or you build a tombstone factory. Outbound, prefer an outbox table over CDC — CDC gives per-replica raw mutations and, if `cdc_raw` fills to `cdc_total_space`, it rejects writes and takes production down. For huge loads, `CQLSSTableWriter` plus `sstableloader`, not the CQL path.

| Setting / Command | Purpose |
|---|---|
| `spark.cassandra.connection.localDC` | Pin all connector traffic to the analytics DC |
| `spark.cassandra.input.split.sizeInMB` | Bytes per Spark partition (default 512) |
| `spark.cassandra.input.consistency.level` | `LOCAL_ONE` for scans |
| `spark.cassandra.input.readsPerSec` | Per-executor read throttle |
| `spark.cassandra.output.throughputMBPerSec` | Write throttle |
| `spark.cassandra.output.batch.grouping.key` | `partition` — group writes by partition key |
| `spark.cassandra.sql.enableDirectJoin` | Force per-key lookups instead of scan+shuffle |
| `joinWithCassandraTable(ks, tbl)` | RDD direct join |
| `df.explain(True)` | Verify pushdown and direct join |
| `nodetool rebuild -- dc_serving` | Populate a new analytics DC |
| `cdc_total_space` | Cap on `cdc_raw`; writes fail when full |
| `nullToUnset: true` | Kafka sink: do not turn nulls into tombstones |
| `sstableloader` | Stream pre-built SSTables for bulk load |

**Flash cards**

- **Why an analytics DC** → Scans evict page cache and consume read threads; isolation must be topological.
- **Connector parallelism** → One Spark partition per token range of `input.split.sizeInMB`, replica-local.
- **Join rule** → `directJoin` / `joinWithCassandraTable`, or you scan the whole table.
- **CDC's fatal edge** → `cdc_raw` full → writes to CDC tables rejected. Monitor it.
- **Kafka sink trap** → `nullToUnset: false` writes a tombstone for every null field.
## 11. Hands-On Exercises & Mini Project

- [ ] Create a two-DC cluster with `ccm` (or Docker Compose), replicate a keyspace to both, run `nodetool rebuild` on the analytics DC, and confirm with `nodetool status` that both DCs hold data.
- [ ] Load 5 million rows, then run the same Spark aggregation twice: once with `input.split.sizeInMB=512` and once with `128`. Compare task counts, task duration distribution, and total runtime in the Spark UI.
- [ ] Write two versions of a join — a plain DataFrame join and one using `directJoin` — against a table with 10 million rows, and compare `explain()` output plus wall-clock time.
- [ ] Deploy the DataStax Kafka sink against a local Cassandra, publish 100k records with several null fields with `nullToUnset` false, then check `nodetool tablehistograms` and the tombstone counters. Repeat with `nullToUnset: true` and compare.
- [ ] Enable `cdc = true` on a table with a small `cdc_total_space`, write until `cdc_raw` fills, and observe the exact exception the client receives. Then write a minimal consumer that deletes drained segments and show writes resume.
- [ ] Build an outbox table with TWCS and a poller that publishes to a local Kafka, and demonstrate exactly-once-ish behaviour by making the consumer idempotent on `event_ts`.

### Mini Project — "Telecom Analytics Pipeline"

**Goal.** Build an end-to-end pipeline where streaming ingest, serving reads, and batch analytics coexist without any of them degrading the others.

**Requirements.**
1. A two-datacenter Cassandra cluster (`dc_serving` RF=3, `dc_analytics` RF=2) with the `cdr` schema, TWCS, and a 30-day TTL.
2. A Kafka producer generating synthetic CDRs, and the DataStax Kafka sink writing them into `dc_serving` with `nullToUnset: true`, a TTL, and `LOCAL_QUORUM`.
3. A Spark job running against `dc_analytics` only, computing daily per-subscriber revenue with predicate pushdown verified by `explain(True)`, and writing results back to a serving table with grouped, throttled writes.
4. An outbox table plus poller publishing "high spend detected" events to Kafka, with a documented at-least-once contract and an idempotent consumer.
5. A load harness that drives serving reads continuously and records p99, plus a report showing serving p99 is statistically unchanged while the Spark job runs.

**Extensions.**
- Replace the outbox with real CDC: enable `cdc = true`, write an agent that tails `cdc_raw`, deduplicates across the three replicas, and publishes; then document precisely what breaks when you stop the agent.
- Add a bulk-load path using `CQLSSTableWriter` in Spark plus `sstableloader`, and compare wall-clock and cluster impact against the same volume loaded through the CQL write path.
- Add Cassandra 5.0 SAI indexes to the serving table and show which of your Spark filters could be answered directly by Cassandra instead, quantifying the saved Spark work.
## 12. Related Topics & Free Learning Resources

**Sibling chapters.** *Multi-Datacenter Deployment* — the mechanics of adding and rebuilding the analytics DC; *Drivers & Application Development* — the driver layer the connector and sink are built on; *Compaction Strategies* — why TWCS matters for both CDR and outbox tables; *Tombstones & Deletes* — the failure mode behind the Kafka sink trap; *Data Modeling & Partition Design* — direct joins require the full partition key; *Cassandra 4.x & 5.x New Features* — SAI, vector search, and the improved 4.0 CDC.

- **Spark Cassandra Connector Documentation** — DataStax / open source · *Intermediate* · The complete reference for token splits, pushdown, direct joins, and every `spark.cassandra.*` setting. <https://github.com/datastax/spark-cassandra-connector/blob/master/doc/reference.md>
- **Spark Cassandra Connector — Data Frames and Direct Join** — DataStax · *Advanced* · Explains when `directJoin` engages and how to force and verify it. <https://github.com/datastax/spark-cassandra-connector/blob/master/doc/14_data_frames.md>
- **Apache Cassandra — Change Data Capture** — Apache Software Foundation · *Advanced* · Official CDC semantics, `cdc_raw` handling, and the back-pressure behaviour that blocks writes. <https://cassandra.apache.org/doc/latest/cassandra/managing/operating/cdc.html>
- **CASSANDRA-8844: Change Data Capture** — Apache JIRA · *Advanced* · The original design discussion, including why CDC emits mutations rather than resolved rows. <https://issues.apache.org/jira/browse/CASSANDRA-8844>
- **DataStax Apache Kafka Connector Documentation** — DataStax · *Intermediate* · Mapping syntax, `nullToUnset`, TTL, consistency, and concurrency settings for the sink. <https://docs.datastax.com/en/kafka/doc/index.html>
- **Apache Cassandra — Bulk Loading with sstableloader** — Apache Software Foundation · *Advanced* · How to build and stream SSTables directly, bypassing the CQL write path. <https://cassandra.apache.org/doc/latest/cassandra/managing/tools/sstable/sstableloader.html>
- **Netflix Tech Blog — "Delta: A Data Synchronization and Enrichment Platform"** — Netflix · *Advanced* · A real production account of CDC-style pipelines out of datastores including Cassandra, and the dedup problems involved. <https://netflixtechblog.com/delta-a-data-synchronization-and-enrichment-platform-e82c36a79aee>
- **ApacheCon / Cassandra Summit talks on Spark + Cassandra** — Apache Software Foundation (YouTube) · *Intermediate* · Conference talks walking through connector internals and analytics-DC topologies with production numbers. <https://www.youtube.com/@PlanetCassandra>

---

*Apache Cassandra Handbook — chapter 41.*
