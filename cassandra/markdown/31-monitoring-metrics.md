# 31 · Monitoring, Metrics & Observability

> **In one line:** Cassandra fails slowly and visibly — pending compactions, p99 latency, GC pause time and hint backlog all drift for hours before an outage, so the job of observability is to catch the drift, not the crash.

---

## 1. Overview

Cassandra is a distributed database with no single point of failure, which is exactly why monitoring it is unintuitive. A relational database dies loudly: the primary goes down, connections refuse, pagers fire. A Cassandra cluster almost never dies loudly. It degrades. One node's compaction backlog grows, its read latency creeps from 4 ms to 40 ms, the coordinator's speculative retries mask it, client p99 rises 15%, and three days later that node runs out of disk and takes a replica set with it. Every serious Cassandra incident I have worked has a metric that was screaming for hours.

The problem observability solves here is **attribution**. When a client reports a slow query, the latency you measure at the application is the sum of driver queueing, coordinator work, cross-node network, replica local read, and the slowest replica in the consistency-level quorum. Cassandra exposes metrics at each of those layers separately — `ClientRequest` latency (coordinator-side, includes replica round trip), `Table` ReadLatency (local storage engine only), `Messaging` cross-node latency, and `ThreadPools` pending counts (queueing). Subtracting them tells you *where* the milliseconds went. Without that decomposition you are guessing.

Historically, Cassandra inherited JMX from its Java lineage and, since 2.2, standardised on the Dropwizard Metrics library. Every metric is a `Meter`, `Timer`, `Histogram`, `Counter` or `Gauge` published under the `org.apache.cassandra.metrics` JMX domain. Cassandra 4.0 added **virtual tables** (`system_views`), which expose a meaningful subset of the same data over CQL — so you can now run `SELECT * FROM system_views.thread_pools;` from cqlsh without touching JMX. Cassandra 5.0 extended the virtual table set and improved the histogram reservoir implementation (decaying histograms are the default, so percentiles reflect the recent past rather than all-time).

A concrete example: Discord runs Cassandra (and later ScyllaDB) for message history at trillions-of-rows scale. Their public post-mortems describe "hot partitions" — a single very active channel funnelling reads to three replicas — showing up first as a *per-node* divergence in `ClientRequest.Read.Latency` p99, not as a cluster-wide alarm. The cluster average looked fine. The fix required per-node dashboards and a `nodetool toppartitions` sample to name the offending partition key. That is the shape of nearly every Cassandra investigation: cluster aggregate looks healthy, one node is on fire.

The mental model to carry: **Cassandra's health is a queueing problem.** Every subsystem — flush writers, compaction executors, mutation stage, read stage, hint dispatch — is a bounded thread pool with a queue. When arrival rate exceeds service rate, the queue grows, then drops. `Pending` counts are your leading indicators; `Dropped` counts and latency percentiles are your lagging ones. Alert on the leading indicators.

## 2. Core Concepts

- **JMX (Java Management Extensions)** — the JVM's built-in management protocol; Cassandra publishes every metric and many operations (`nodetool` is a JMX client) under port 7199 by default.
- **Dropwizard metric types** — `Counter` (monotonic), `Meter` (rate: 1/5/15-min EWMA), `Histogram` (distribution with percentiles), `Timer` (Meter + Histogram), `Gauge` (instantaneous value).
- **Decaying histogram** — Cassandra's default reservoir; recent samples are weighted exponentially higher so p99 reflects roughly the last few minutes, not process lifetime.
- **Coordinator vs local latency** — `ClientRequest.*` is measured by the coordinator and includes replica network round trips; `Table.*Latency` is the local storage-engine cost on one node. The gap is network + slow replicas.
- **Dropped message** — a mutation/read that sat in its queue longer than `write_request_timeout_in_ms` and was discarded before execution; surfaced as `DroppedMessage.MUTATION.Dropped`. Silent data divergence until repair.
- **Pending compactions** — the count of compaction tasks the strategy believes it needs to run; the single best proxy for "this node is falling behind".
- **Hints** — writes buffered on a coordinator for a replica that was down (`max_hint_window` default 3 h). A growing `TotalHintsInProgress` means a replica is unreachable or too slow to accept them.
- **Virtual tables** — Cassandra 4.0+ read-only CQL tables in the `system_views` keyspace exposing settings, thread pools, sstable tasks, clients, and per-table metrics.
- **Golden signals for Cassandra** — latency percentiles, error/timeout rate, saturation (pending queues, disk, GC), and traffic (rate per table). Alert on saturation first.

## 3. Theory & Internals

Cassandra registers metrics at object creation. When a `ColumnFamilyStore` (one table) is initialised it creates a `TableMetrics` instance which registers ~80 metrics scoped by keyspace and table, plus aliases into a global "all tables" rollup. The registry is a singleton `CassandraMetricsRegistry` that wraps Dropwizard's `MetricRegistry` and additionally exports each metric as a JMX MBean whose ObjectName encodes the scope:

`org.apache.cassandra.metrics:type=Table,keyspace=ks,scope=tbl,name=ReadLatency`, `type=ClientRequest,scope=Read-LOCAL_QUORUM,name=Latency`, `type=ThreadPools,path=internal,scope=CompactionExecutor,name=PendingTasks`.

The latency histograms are **not** plain histograms. Cassandra stores latency in a `DecayingEstimatedHistogramReservoir`: buckets follow a geometric series (each bucket ~1.2× the previous, starting at 1 µs) and each sample's weight decays with a half-life of 60 seconds (forward-decay, α = ln(2)/60). Two consequences matter operationally. First, percentiles are approximate — bucket width at 10 ms is roughly 1.7 ms, so a reported p99 of 10.5 ms means "somewhere in the 9.9–11.6 ms bucket". Second, **you cannot average percentiles across nodes**. A dashboard that computes `avg(p99)` over 30 nodes is arithmetically meaningless; use `max` for alerting and render per-node series for diagnosis.

The queueing model is the theory that actually predicts outages. Each stage is a `ThreadPoolExecutor` with a fixed thread count and (mostly) unbounded queue:

| Stage | Threads default | What saturation means |
|---|---|---|
| MutationStage | `concurrent_writes` = 32 | Local write apply is behind; commit log or memtable contention |
| ReadStage | `concurrent_reads` = 32 | Disk-bound reads; too many SSTables per read |
| CompactionExecutor | `concurrent_compactors` = min(cores, disks) | Compaction throughput too low for ingest |
| MemtableFlushWriter | `memtable_flush_writers` = 2 | Flush cannot keep up; blocks writes when memtable pool exhausts |

By Little's Law, `L = λW`: queue length equals arrival rate times wait time. A pending count of 1,000 in ReadStage with 32 threads and 5 ms service time means roughly 156 ms of added queueing latency on top of every read — which is exactly the signature of "p99 exploded but disk looks fine". Cassandra's own protection is the timeout: once a message's age exceeds `read_request_timeout` (5 s) or `write_request_timeout` (2 s), it is dropped rather than executed, incrementing `DroppedMessage`. **Dropped mutations are unacknowledged writes that the coordinator may already have counted as successful at CL < ALL**, which is why a dropped-mutation spike is a data-consistency event, not just a performance event.

Compaction backlog has its own arithmetic. For SizeTieredCompactionStrategy, a table ingesting `R` bytes/s with a memtable flushing at size `M` produces `R/M` SSTables per second; each byte is rewritten roughly `log₂(N)` times over its life. If `compaction_throughput_mb_per_sec` (default 64 in 4.x, and **0 = unthrottled** is a common production choice on NVMe) is less than `R × log₂(N)`, `PendingCompactions` grows without bound, SSTables-per-read rises, and read latency degrades super-linearly because each read must consult more bloom filters and merge more fragments.

```svg
<svg viewBox="0 0 760 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="760" height="330" fill="#ffffff"/>
  <text x="20" y="26" font-size="15" font-weight="700" fill="#1e293b">Where the milliseconds go: layered latency attribution</text>

  <defs><marker id="ar31" markerWidth="9" markerHeight="9" refX="8" refY="4" orient="auto"><path d="M0 0 L9 4 L0 8 z" fill="#1e293b"/></marker></defs>
  <rect x="20" y="50" width="150" height="60" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="95" y="75" font-size="12" font-weight="700" fill="#1e293b" text-anchor="middle">Application</text>
  <text x="95" y="94" font-size="11" fill="#1e293b" text-anchor="middle">driver p99 = 46 ms</text>
  <rect x="210" y="50" width="170" height="60" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="295" y="75" font-size="12" font-weight="700" fill="#1e293b" text-anchor="middle">Coordinator</text>
  <text x="295" y="94" font-size="11" fill="#1e293b" text-anchor="middle">ClientRequest p99 = 41 ms</text>
  <rect x="420" y="50" width="150" height="60" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="495" y="75" font-size="12" font-weight="700" fill="#1e293b" text-anchor="middle">Cross-node</text>
  <text x="495" y="94" font-size="11" fill="#1e293b" text-anchor="middle">Messaging p99 = 18 ms</text>
  <rect x="610" y="50" width="130" height="60" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="675" y="75" font-size="12" font-weight="700" fill="#1e293b" text-anchor="middle">Replica local</text>
  <text x="675" y="94" font-size="11" fill="#1e293b" text-anchor="middle">Table read p99 = 3 ms</text>
  <path d="M170 80 L206 80" stroke="#1e293b" stroke-width="2" marker-end="url(#ar31)"/>
  <path d="M380 80 L416 80" stroke="#1e293b" stroke-width="2" marker-end="url(#ar31)"/>
  <path d="M570 80 L606 80" stroke="#1e293b" stroke-width="2" marker-end="url(#ar31)"/>
  <text x="20" y="150" font-size="13" font-weight="700" fill="#1e293b">Subtraction tells you the culprit</text>
  <rect x="20" y="165" width="720" height="36" rx="6" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="34" y="188" font-size="12" fill="#1e293b">46-41 = 5 ms driver queue | 41-18 = 23 ms coordinator wait (ReadStage pending) | 18-3 = 15 ms network + slow replica</text>
  <rect x="20" y="220" width="230" height="90" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="135" y="243" font-size="12" font-weight="700" fill="#1e293b" text-anchor="middle">Healthy signature</text>
  <text x="135" y="264" font-size="11" fill="#1e293b" text-anchor="middle">local approx coordinator</text>
  <text x="135" y="282" font-size="11" fill="#1e293b" text-anchor="middle">pending queues near 0</text>
  <text x="135" y="300" font-size="11" fill="#1e293b" text-anchor="middle">dropped = 0</text>
  <rect x="265" y="220" width="230" height="90" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="380" y="243" font-size="12" font-weight="700" fill="#1e293b" text-anchor="middle">Saturation signature</text>
  <text x="380" y="264" font-size="11" fill="#1e293b" text-anchor="middle">coordinator &gt;&gt; local</text>
  <text x="380" y="282" font-size="11" fill="#1e293b" text-anchor="middle">ReadStage pending &gt; 100</text>
  <text x="380" y="300" font-size="11" fill="#1e293b" text-anchor="middle">GC pause p99 rising</text>
  <rect x="510" y="220" width="230" height="90" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="625" y="243" font-size="12" font-weight="700" fill="#1e293b" text-anchor="middle">Data-model signature</text>
  <text x="625" y="268" font-size="11" fill="#1e293b" text-anchor="middle">local latency high, and</text>
  <text x="625" y="290" font-size="11" fill="#1e293b" text-anchor="middle">SSTablesPerRead p99 &gt; 8</text>
</svg>
```

## 4. Architecture & Workflow

The standard open-source pipeline is JMX → exporter → Prometheus → Grafana → Alertmanager, with `nodetool` and virtual tables as the interactive drill-down layer.

1. **Instrument in-process.** Cassandra registers metrics in `CassandraMetricsRegistry`. Nothing to configure; they exist as soon as the node starts.
2. **Expose.** Attach the Prometheus JMX exporter as a `-javaagent` in `cassandra-env.sh`. It scrapes the local MBean server in-process (no RMI round trip) and serves `/metrics` on a port such as 7070. Its YAML config *must* whitelist patterns — the raw MBean surface is ~50,000 series on a large cluster and will melt your Prometheus.
3. **Scrape.** Prometheus pulls every 15–30 s. Label each series with `instance`, `dc`, `rack`, `keyspace`, `table` so you can slice by datacenter.
4. **Aggregate.** Recording rules pre-compute expensive queries (per-table p99 across a 200-node cluster is a heavy PromQL expression to evaluate at dashboard load).
5. **Alert.** Alertmanager routes on severity. Saturation alerts (pending compactions, hints, disk) page during business hours; latency and dropped-message alerts page 24/7.
6. **Drill down.** When an alert fires, the on-call runs `nodetool tpstats`, `nodetool tablestats <ks>.<tbl>`, `nodetool compactionstats`, `nodetool proxyhistograms`, and `nodetool tablehistograms` on the offending node — or queries `system_views.*` from cqlsh if JMX is locked down.
7. **Trace.** For a specific slow query, enable request tracing (`TRACING ON` in cqlsh, or `probabilistic tracing` at 0.001 in production) and read `system_traces.events` to see per-stage timing on every replica.
8. **Correlate logs.** `GCInspector` WARN lines, `TombstoneOverwhelmingException`, `Maximum memory usage reached`, and `Not marking nodes down due to local pause` in `system.log` are the narrative layer that explains the metric spike.

```svg
<svg viewBox="0 0 780 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="780" height="360" fill="#ffffff"/>
  <text x="20" y="26" font-size="15" font-weight="700" fill="#1e293b">Observability pipeline and the drill-down path</text>

  <defs><marker id="ar31b" markerWidth="9" markerHeight="9" refX="8" refY="4" orient="auto"><path d="M0 0 L9 4 L0 8 z" fill="#1e293b"/></marker></defs>
  <rect x="20" y="50" width="180" height="120" rx="10" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="110" y="74" font-size="12" font-weight="700" fill="#1e293b" text-anchor="middle">Cassandra node</text>
  <rect x="36" y="86" width="148" height="26" rx="5" fill="#ffffff" stroke="#4f46e5"/>
  <text x="110" y="104" font-size="11" fill="#1e293b" text-anchor="middle">MetricsRegistry</text>
  <rect x="36" y="118" width="148" height="26" rx="5" fill="#ffffff" stroke="#4f46e5"/>
  <text x="110" y="136" font-size="11" fill="#1e293b" text-anchor="middle">JMX MBeans :7199</text>
  <text x="110" y="160" font-size="10" fill="#1e293b" text-anchor="middle">system_views virtual tables (4.0+)</text>
  <rect x="240" y="66" width="150" height="60" rx="10" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="315" y="90" font-size="12" font-weight="700" fill="#1e293b" text-anchor="middle">jmx_exporter</text>
  <text x="315" y="110" font-size="11" fill="#1e293b" text-anchor="middle">javaagent :7070</text>
  <rect x="430" y="66" width="150" height="60" rx="10" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="505" y="90" font-size="12" font-weight="700" fill="#1e293b" text-anchor="middle">Prometheus</text>
  <text x="505" y="110" font-size="11" fill="#1e293b" text-anchor="middle">scrape 15s + rules</text>
  <rect x="620" y="40" width="140" height="52" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="690" y="62" font-size="12" font-weight="700" fill="#1e293b" text-anchor="middle">Grafana</text>
  <text x="690" y="80" font-size="11" fill="#1e293b" text-anchor="middle">per-node panels</text>
  <rect x="620" y="102" width="140" height="52" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="690" y="124" font-size="12" font-weight="700" fill="#1e293b" text-anchor="middle">Alertmanager</text>
  <text x="690" y="142" font-size="11" fill="#1e293b" text-anchor="middle">page / ticket</text>
  <path d="M200 96 L236 96" stroke="#1e293b" stroke-width="2" marker-end="url(#ar31b)"/>
  <path d="M390 96 L426 96" stroke="#1e293b" stroke-width="2" marker-end="url(#ar31b)"/>
  <path d="M580 90 L616 70" stroke="#1e293b" stroke-width="2" marker-end="url(#ar31b)"/>
  <path d="M580 102 L616 122" stroke="#1e293b" stroke-width="2" marker-end="url(#ar31b)"/>
  <text x="20" y="205" font-size="13" font-weight="700" fill="#1e293b">Alert fires, then drill down on the named node</text>
  <rect x="20" y="220" width="175" height="56" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="107" y="242" font-size="11" font-weight="700" fill="#1e293b" text-anchor="middle">1. nodetool tpstats</text>
  <text x="107" y="262" font-size="10" fill="#1e293b" text-anchor="middle">pending / dropped</text>
  <rect x="212" y="220" width="175" height="56" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="299" y="242" font-size="11" font-weight="700" fill="#1e293b" text-anchor="middle">2. tablehistograms</text>
  <text x="299" y="262" font-size="10" fill="#1e293b" text-anchor="middle">SSTables/read, cell count</text>
  <rect x="404" y="220" width="175" height="56" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="491" y="242" font-size="11" font-weight="700" fill="#1e293b" text-anchor="middle">3. compactionstats</text>
  <text x="491" y="262" font-size="10" fill="#1e293b" text-anchor="middle">backlog + throughput</text>
  <rect x="596" y="220" width="164" height="56" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="678" y="242" font-size="11" font-weight="700" fill="#1e293b" text-anchor="middle">4. probabilistic tracing</text>
  <text x="678" y="262" font-size="10" fill="#1e293b" text-anchor="middle">per-replica timings</text>
  <rect x="20" y="296" width="740" height="44" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="390" y="323" font-size="12" fill="#1e293b" text-anchor="middle">5. Correlate with system.log: GCInspector pauses, TombstoneOverwhelmingException, hint replay, local pause warnings</text>
</svg>
```

## 5. Implementation

Attach the exporter agent. Add to `cassandra-env.sh`:

```bash
JVM_OPTS="$JVM_OPTS -javaagent:/opt/jmx_exporter/jmx_prometheus_javaagent.jar=7070:/opt/jmx_exporter/cassandra.yml"
curl -s localhost:7070/metrics | grep -c '^cassandra_'    # 1187 series, not 60000
```

A **whitelist-first** exporter config — this is the difference between 1,200 series and 60,000:

```yaml
# /opt/jmx_exporter/cassandra.yml
lowercaseOutputName: true
lowercaseOutputLabelNames: true
whitelistObjectNames:
  - "org.apache.cassandra.metrics:type=ClientRequest,*"
  - "org.apache.cassandra.metrics:type=Table,keyspace=*,scope=*,name=ReadLatency"
  - "org.apache.cassandra.metrics:type=Table,keyspace=*,scope=*,name=WriteLatency"
  - "org.apache.cassandra.metrics:type=Table,keyspace=*,scope=*,name=SSTablesPerReadHistogram"
  - "org.apache.cassandra.metrics:type=Table,keyspace=*,scope=*,name=TombstoneScannedHistogram"
  - "org.apache.cassandra.metrics:type=ThreadPools,*"
  - "org.apache.cassandra.metrics:type=DroppedMessage,*"
  - "org.apache.cassandra.metrics:type=Compaction,*"
  - "org.apache.cassandra.metrics:type=Storage,*"
rules:
  - pattern: 'org\.apache\.cassandra\.metrics<type=(\w+), keyspace=(\S+), scope=(\S+), name=(\w+)><>(\w+)'
    name: cassandra_$1_$4_$5
    labels: {keyspace: "$2", table: "$3"}
  - pattern: 'org\.apache\.cassandra\.metrics<type=(\w+), scope=(\S+), name=(\w+)><>(\w+)'
    name: cassandra_$1_$3_$4
    labels: {scope: "$2"}
```

> **Note:** Filtering at the exporter, not at Prometheus, is the optimisation that matters. Per-table metrics multiply by table count; a cluster with 300 tables and unfiltered `type=Table` produces ~24,000 series *per node*. Whitelisting the eight table metrics you actually alert on cuts that by 90%.

Interactive drill-down with `nodetool`:

```bash
# 1. Queue saturation — the leading indicator
nodetool tpstats
# Pool Name                    Active Pending Completed Blocked All time blocked
# ReadStage                        32     411  98214553       0                0
# CompactionExecutor                2       9   1204411       0                0
# Message type   Dropped
# MUTATION           213     <-- acked to client, never applied here: run repair

# 2. Coordinator-side percentiles (microseconds)
nodetool proxyhistograms
# Percentile   Read Latency  Write Latency
# 50%              1131.75         454.83
# 99%             52066.00        1955.67

# 3. Local storage-engine percentiles + the two killers
nodetool tablehistograms app.events
# Percentile SSTables  Write(us)  Read(us)  Partition Size  Cell Count
# 50%            3.00     35.43     924.00            3311          42
# 99%           12.00    126.93   43388.00        14530764       17084
#     ^ 12 SSTables per read and a 14 MB p99 partition: the data model is the bug

# 4. Compaction backlog and hint status
nodetool compactionstats -H   # pending tasks: 47 ... Compaction app.events 13.60%
nodetool statushandoff; nodetool netstats | head -20
```

Cassandra 4.0+ virtual tables give the same data over CQL, which is invaluable when JMX is firewalled:

```cql
-- Thread pool saturation, no JMX required
SELECT name, active_tasks, pending_tasks, blocked_tasks FROM system_views.thread_pools;

-- Running compactions and their progress
SELECT keyspace_name, table_name, task_type, completion_ratio FROM system_views.sstable_tasks;

-- What is actually connected, and with which driver
SELECT address, connection_stage, protocol_version, driver_name, driver_version
FROM system_views.clients;
```

The PromQL that goes on the wall:

```yaml
# prometheus/rules/cassandra.yml
groups:
- name: cassandra
  rules:
  - alert: CassandraReadLatencyP99High
    expr: cassandra_clientrequest_latency_99thpercentile{scope="Read"} / 1000 > 100
    for: 10m
    labels: {severity: page}
    annotations:
      summary: "{{ $labels.instance }} coordinator read p99 {{ $value }}ms"

  - alert: CassandraPendingCompactions      # leading indicator, ticket not page
    expr: cassandra_compaction_pendingtasks_value > 100
    for: 30m
    labels: {severity: ticket}

  - alert: CassandraDroppedMutations        # consistency incident, not perf
    expr: increase(cassandra_droppedmessage_dropped_count{scope="MUTATION"}[5m]) > 0
    for: 5m
    labels: {severity: page}
```

Programmatic access from the Python driver — useful for CI checks and capacity reports:

```python
from cassandra.cluster import Cluster
from cassandra.auth import PlainTextAuthProvider

cluster = Cluster(["10.0.1.11"], protocol_version=5, metrics_enabled=True,
                  auth_provider=PlainTextAuthProvider("ops", "***"))
session = cluster.connect()

# Virtual tables are per-node scope: iterate hosts to build a cluster view.
rows = session.execute("SELECT name, pending_tasks FROM system_views.thread_pools")
print([(r.name, r.pending_tasks) for r in rows if r.pending_tasks > 50])
# [('ReadStage', 411), ('CompactionExecutor', 91)]
m = cluster.metrics                     # driver-side view, includes client queueing
print(m.request_timer["999percentile"], m.stats.request_timeouts)   # 0.0483 3
```

**Optimization note:** turn on probabilistic tracing rather than per-query tracing in production. `nodetool settraceprobability 0.001` samples one request in a thousand into `system_traces`, which has a default TTL of 24 h. Per-query `TRACING ON` in cqlsh is fine for a repro, but blanket tracing adds two writes per request and will itself become the latency problem.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost/Trade-off |
|---|---|---|
| JMX metric surface | Extremely rich — ~80 metrics per table, every thread pool, every cache | Cardinality explosion; unfiltered scraping can add 10× to your Prometheus bill |
| Decaying histograms | p99 reflects the last ~minute, so alerts respond fast | Approximate buckets (±20%); percentiles are not averageable across nodes |
| Virtual tables (4.0+) | Observability over CQL — works through the driver, no JMX port exposure | Per-node scope; a client must query each host, and the metric set is a subset of JMX |
| `nodetool` drill-down | Zero setup, always available, authoritative | Point-in-time only, no history; requires SSH or JMX access to the specific node |
| Alerting on saturation | Leading indicator — hours of warning before impact | Noisier; requires per-cluster thresholds tuned to hardware |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Averaging p99 across nodes on the dashboard.** Percentiles do not average. → ✅ Use `max by (instance)` for alerting and render one series per node; the whole point is finding the outlier.
2. ⚠️ **Alerting only on latency.** By the time p99 doubles, the node has been sick for an hour. → ✅ Page on saturation first: `PendingCompactions > 100`, `ReadStage pending > 100`, disk > 70%, hints growing.
3. ⚠️ **Ignoring `DroppedMessage.MUTATION`.** Teams treat it as a perf metric. → ✅ Treat any nonzero dropped mutation as a *consistency* incident; the write was acked at LOCAL_QUORUM but one replica never applied it. Run `nodetool repair -pr` on the affected range.
4. ⚠️ **Scraping the whole JMX surface.** → ✅ Whitelist ObjectNames in the exporter; per-table metrics × 300 tables × 100 nodes is millions of series.
5. ⚠️ **Monitoring cluster aggregates only.** A single hot node is invisible in a 100-node average. → ✅ Every latency and saturation panel must be breakdown-by-instance, with a "max vs median node" panel on the overview.
6. ⚠️ **Running blanket `TRACING ON` or high trace probability to "see what's slow".** → ✅ `settraceprobability 0.001`, or use `nodetool toppartitions` / slow-query logging (`slow_query_log_timeout_in_ms`, default 500 ms) which writes offenders to `system.log` for free.
7. ⚠️ **Treating GC log lines as noise.** `GCInspector: G1 Young Generation GC in 1843ms` means the node was invisible to the failure detector for nearly two seconds. → ✅ Alert on GC time > 10% of wall clock, and on the "Not marking nodes down due to local pause" log line, which is Cassandra telling you *it* was the one paused.
8. ⚠️ **Dashboards without keyspace/table labels.** "Read latency is up" is not actionable. → ✅ Label by table and keep a top-10-tables-by-latency panel; 90% of the time one table's data model is the cause.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Start at the layer boundary. If `ClientRequest.Read.Latency` p99 is high but every node's `Table.ReadLatency` p99 is low, the problem is coordination: queueing (`ReadStage.PendingTasks`), GC, or network. If a *single* node's local latency is high, the problem is that node — check `nodetool tablehistograms` for SSTables-per-read and partition size, `iostat -x 1` for device saturation, and the GC log. If *all* nodes' local latency is high on one table, the data model is the problem: wide partitions, tombstones, or too many SSTables from an under-throttled compaction. `nodetool toppartitions app.events 10000 -k WRITES,READS` samples live traffic and names the hottest partition keys, which is usually the fastest path from "a node is hot" to "this customer id is hammering us".

**Monitoring — the specific beans.** The list worth memorising: `ClientRequest.{Read,Write,CASRead,CASWrite,RangeSlice}.{Latency,Timeouts,Unavailables,Failures}`; `Table.{ReadLatency,WriteLatency,SSTablesPerReadHistogram,TombstoneScannedHistogram,LiveSSTableCount,PendingFlushes,LiveDiskSpaceUsed,MaxPartitionSize}`; `ThreadPools.{ReadStage,MutationStage,CompactionExecutor,MemtableFlushWriter}.{PendingTasks,CurrentlyBlockedTasks}`; `Compaction.{PendingTasks,BytesCompacted}`; `DroppedMessage.{MUTATION,READ,READ_REPAIR,HINT}.Dropped`; `Storage.{Load,Exceptions,TotalHints,TotalHintsInProgress}`; `Cache.{KeyCache,RowCache,ChunkCache}.{HitRate,Size,Requests}`; `CommitLog.{PendingTasks,TotalCommitLogSize,WaitingOnCommit}`; plus JVM `java.lang:type=GarbageCollector,name=G1 Young Generation` (`CollectionTime`, `CollectionCount`) and `java.lang:type=Memory` heap usage.

**Security.** JMX is a remote-code-execution surface. Never bind it to `0.0.0.0` unauthenticated. In `cassandra-env.sh` keep `LOCAL_JMX=yes` (binds to 127.0.0.1) and run the exporter as an in-process `-javaagent` so it never needs a remote JMX connection — this is the single best reason to prefer the javaagent over a sidecar. If you must expose JMX remotely, enable `com.sun.management.jmxremote.authenticate=true` with a password file (mode 0400) and TLS. The metrics endpoint itself leaks keyspace/table names and traffic patterns: bind it to the management subnet and put it behind mTLS. Virtual tables respect CQL permissions — grant `SELECT` on `system_views` to an ops role rather than handing out JMX.

**Performance & scaling.** Scrape interval is a real cost: 15 s on 200 nodes with 1,200 series each is 16k samples/s into Prometheus — fine, but at 30k series/node it is not. Use recording rules for anything a dashboard renders across all nodes. For clusters above ~100 nodes, shard Prometheus by datacenter and federate the aggregates, matching Cassandra's own failure domain. Retain 15 days at full resolution and downsample beyond that; capacity planning wants a year of `Storage.Load` and per-table growth rates, not a year of p99 histograms. Finally, monitor the monitoring: an exporter that OOMs or a scrape that times out at 10 s produces gaps that look exactly like a healthy quiet period.

## 9. Interview Questions

**Q: Why is coordinator-side read latency usually higher than the per-node local table read latency?**
A: `ClientRequest.Read.Latency` is measured by the coordinator and covers the full request: dispatch to replicas, network round trip, waiting for enough responses to satisfy the consistency level, and any read repair. `Table.ReadLatency` only measures the local storage-engine work on a single replica. The difference is network plus the tail — at QUORUM you wait for the *slowest* of the required replicas, so coordinator latency tracks the tail of the replica distribution, not its mean.

**Q: What does a growing `PendingCompactions` count actually tell you?**
A: That the compaction strategy believes it needs more work than the compactors are completing — ingest is outrunning compaction throughput. The immediate consequence is more SSTables per read, which raises read latency super-linearly, and more disk used by obsolete data. Fixes are raising `compaction_throughput_mb_per_sec` (or setting it to 0 on NVMe), raising `concurrent_compactors`, or reducing write amplification with a better strategy or data model.

**Q: A node drops mutations. Is that a performance problem or a correctness problem?**
A: Both, but treat it as correctness. A dropped mutation means the message sat in the queue past `write_request_timeout_in_ms` and was discarded unexecuted. If the coordinator still got enough acks to satisfy LOCAL_QUORUM, the client saw success while that replica is now stale. Hinted handoff may cover it if the window applies, but the reliable fix is repair.

**Q: Why can't you average p99 latency across nodes?**
A: Percentiles are order statistics of a distribution, not additive quantities. Averaging thirty p99 values produces a number that corresponds to no percentile of the combined distribution and systematically hides the outlier node — which is exactly what you are looking for. Use max for alerting, and merge raw histograms server-side if you genuinely need a cluster-wide percentile.

**Q: How do you find which partition is making a node hot?**
A: `nodetool toppartitions <ks>.<tbl> <duration_ms> -k READS,WRITES` samples live traffic with a space-saving cardinality sketch and prints the top partition keys by frequency. Complement it with `nodetool tablehistograms` for partition size p99 and `MaxPartitionSizeBytes` from JMX to catch the large-but-not-frequent case.

**Q: What are virtual tables and when do you prefer them to JMX?**
A: Cassandra 4.0 introduced read-only tables in the `system_views` keyspace (thread pools, sstable tasks, clients, settings, caches) queryable with normal CQL. Prefer them when JMX is firewalled or you want observability through the same authenticated driver connection the app uses. They are per-node in scope and expose a subset of JMX, so JMX remains the source for a full metrics pipeline.

**Q: (Senior) Design an alerting strategy that catches Cassandra outages hours before they happen. What pages and what tickets?**
A: Page on things that mean data or availability is already at risk: dropped mutations, `ClientRequest` timeouts or unavailables above baseline, a node down for more than a few minutes, GC time above 10% of wall clock, disk above 70%. Ticket on trends that give hours or days of runway: pending compactions above 100 sustained 30 minutes, hint backlog growing, SSTables-per-read p99 above 8, partition size p99 approaching 100 MB, per-table growth projecting disk exhaustion inside 30 days. The rule is: saturation tickets, symptoms page — and every alert names the node and the table.

**Q: (Senior) You see coordinator p99 of 200 ms, every replica reports 2 ms local read latency, no GC pauses, and thread pools are empty. What is left?**
A: Network or client-side. Check `Messaging.CrossNodeLatency` and per-DC variants — a query at QUORUM in a multi-DC keyspace may be crossing a region. Check whether the driver's load-balancing policy is `DCAwareRoundRobin` with the correct local DC; a misconfigured local DC sends every request across the WAN. Also check driver connection-pool saturation (in-flight requests per connection hitting the protocol's 32k stream limit or the pool's max) and coordinator-side speculative retry settings, which can double effective load. Finally, verify the client isn't paging huge result sets with a tiny fetch size, turning one logical query into hundreds of round trips.

**Q: (Senior) How would you build a cluster-accurate p99 across 200 nodes rather than a max-of-p99?**
A: You need the raw distributions, not the summaries. Either export the histogram buckets themselves — Prometheus native histograms or a fixed bucket set via `histogram_quantile()` over `_bucket` series, which is mergeable — or scrape the estimated-histogram MBean offsets and re-derive percentiles from summed bucket counts. Cassandra's `EstimatedHistogram` buckets are the same geometric series on every node, so summing bucket counts across nodes and then computing the quantile is mathematically sound. Max-of-p99 is still the better *alert*, because it answers "is any node sick"; the merged percentile answers "what do users experience".

**Q: What does `nodetool tpstats` "All time blocked" mean and why is nonzero bad?**
A: It counts tasks that could not be enqueued because the executor's bounded queue was full, so the submitting thread blocked. It appears mainly on `MemtableFlushWriter` and the native transport pool. Nonzero means backpressure reached all the way to the caller — writes are being throttled at the source, and you are one step from dropped mutations.

**Q: Which cache metrics matter and what hit rate should you expect?**
A: `Cache.KeyCache.HitRate` should sit above 0.90 for read-heavy workloads; below that, reads pay an extra index seek. `Cache.ChunkCache.HitRate` (4.0+, the buffer-pool cache for compressed chunks) matters more than key cache on modern hardware. Row cache is usually a trap — enable it only for small, hot, rarely-mutated tables, because any write invalidates the whole cached partition.

**Q: How do you monitor whether repairs are actually keeping data consistent?**
A: Track `Table.RepairedDataTrackingOverreadRows` and the repaired/unrepaired SSTable split via `nodetool tablestats` (percent repaired), plus repair job success from your scheduler (Reaper exposes Prometheus metrics). Cassandra 4.0's repaired-data tracking lets read requests compare digests of repaired data across replicas and report mismatches as `ClientRequest.Read.ConfirmedRepairedInconsistencies` — a direct signal that repair coverage is incomplete.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Cassandra degrades before it dies, so monitor saturation, not just symptoms. Metrics live in JMX under `org.apache.cassandra.metrics` (and, since 4.0, in `system_views` virtual tables). Decompose latency by layer: driver → `ClientRequest` (coordinator, includes network and slow-replica tail) → `Messaging` → `Table.ReadLatency` (local storage engine). Every subsystem is a queue; `PendingTasks` is the leading indicator and `DroppedMessage` is the point where performance becomes a consistency bug. Never average percentiles across nodes — use max and always break down by instance and table. Page on dropped mutations, timeouts, GC above 10% of wall clock, and disk above 70%; ticket on pending compactions, hint backlog, SSTables-per-read, and partition-size growth. Drill down with `tpstats`, `tablehistograms`, `compactionstats`, `toppartitions`, then probabilistic tracing at 0.001.

| Command / setting | Purpose | Default / target |
|---|---|---|
| `nodetool tpstats` | Queue saturation and drops | Pending ≈ 0, Dropped = 0 |
| `nodetool proxyhistograms` | Coordinator p50/p95/p99 (µs) | Read p99 < 50 ms |
| `nodetool tablehistograms ks.tbl` | SSTables/read, partition size, cells | SSTables p99 ≤ 4, partition < 100 MB |
| `nodetool compactionstats -H` | Backlog and progress | Pending < 20 |
| `compaction_throughput_mb_per_sec` | Compaction rate cap | 64 (4.x); 0 = unthrottled |
| `write_request_timeout_in_ms` | Drop threshold for writes | 2000 |
| JMX port | MBean server | 7199, `LOCAL_JMX=yes` |

**Flash cards**
- **Leading indicator of a Cassandra outage** → Pending tasks in a thread pool, or pending compactions, trending up for 30+ minutes.
- **Coordinator latency ≫ local latency means** → Network, cross-DC routing, GC, or queueing — not the storage engine.
- **Dropped mutation means** → A write was acked to the client but never applied on that replica. Consistency incident. Repair.
- **Why max(p99) not avg(p99)** → Percentiles aren't additive, and averaging hides the one sick node you're hunting for.
- **Cheapest production tracing** → `nodetool settraceprobability 0.001` plus `slow_query_log_timeout_in_ms`, never blanket `TRACING ON`.

## 11. Hands-On Exercises & Mini Project

- [ ] Start a 3-node cluster with `ccm create obs -v 4.1.3 -n 3 -s`, then attach the Prometheus JMX exporter as a `-javaagent` on node1 and confirm `curl localhost:7070/metrics | grep cassandra_clientrequest` returns data.
- [ ] Create a table with a deliberately unbounded partition (`PRIMARY KEY (sensor_id, ts)` with one sensor), write 500k rows to a single partition with `cassandra-stress`, then compare `nodetool tablehistograms` partition size p99 before and after. Record where SSTablesPerRead crosses 8.
- [ ] Throttle compaction with `nodetool setcompactionthroughput 1` while running a write-heavy stress test. Watch `nodetool compactionstats` pending grow and correlate it with rising read p99 in `nodetool tablehistograms`. Restore with `setcompactionthroughput 0`.

**Mini Project — "Predictive Cassandra Dashboard"**

*Goal:* build a Grafana dashboard plus alert rules that would have caught a real degradation before customer impact.

*Requirements:*
1. Docker Compose stack: 3 Cassandra 4.1 nodes with the javaagent exporter, Prometheus, Alertmanager, Grafana.
2. A whitelist exporter config that keeps total series per node under 1,500 — prove it with `curl … | wc -l`.
3. Dashboard rows: **Traffic** (ops/s by table), **Latency** (coordinator p50/p99 per node, local p99 per node, side by side), **Saturation** (pending per thread pool, pending compactions, disk %, GC time ratio), **Errors** (timeouts, unavailables, dropped by type), **Data model health** (SSTablesPerRead p99, tombstones scanned p99, max partition size).
4. Five alert rules with distinct page/ticket severities and runbook annotations naming the exact `nodetool` command to run, plus a load generator that injects three failure modes on demand (compaction throttle, hot partition, stopped node) — screenshot the dashboard for each.

*Extensions:* add Cassandra Reaper and graph repair coverage; export driver-side metrics from a Python client and put them on the same latency panel to visualise driver queueing; implement a merged cluster-wide p99 from summed histogram buckets and compare it to max-of-p99 during the hot-partition scenario.

## 12. Related Topics & Free Learning Resources

Read alongside **34 · JVM & Garbage Collection Tuning** (GC is the most common cause of the latency you'll be alerting on), **36 · Troubleshooting Latency & Hotspots** (the diagnostic playbook these metrics feed), **35 · Performance Tuning & Benchmarking** (how to change the numbers you're watching), **32 · Multi-Datacenter Deployment & Replication** (per-DC metric slicing), and the compaction and repair chapters for the subsystems behind `PendingCompactions` and hint metrics.

- **Cassandra Monitoring (official docs)** — Apache Cassandra · *Intermediate* · the authoritative list of every metric family, MBean name and type; keep it open while writing exporter rules. <https://cassandra.apache.org/doc/latest/cassandra/managing/operating/metrics.html>
- **Virtual Tables** — Apache Cassandra · *Intermediate* · the 4.0+ `system_views` reference, including which metrics are exposed over CQL. <https://cassandra.apache.org/doc/latest/cassandra/managing/operating/virtualtables.html>
- **nodetool command reference** — Apache Cassandra · *Beginner* · exact syntax and output semantics for `tpstats`, `tablehistograms`, `proxyhistograms`, `toppartitions`. <https://cassandra.apache.org/doc/latest/cassandra/managing/tools/nodetool/nodetool.html>
- **prometheus/jmx_exporter** — Prometheus · *Intermediate* · the exporter itself plus a bundled Cassandra example config; read the rules syntax before writing your whitelist. <https://github.com/prometheus/jmx_exporter>
- **Monitoring Apache Cassandra** — The Last Pickle · *Advanced* · practitioner series on which metrics predict incidents and how to set thresholds; still the best written treatment of alert design. <https://thelastpickle.com/blog/2017/04/17/Monitoring-Cassandra.html>
- **How Discord Stores Billions of Messages** — Discord Engineering · *Intermediate* · a real hot-partition investigation where per-node metrics, not cluster averages, found the problem. <https://discord.com/blog/how-discord-stores-billions-of-messages>
- **Cassandra Reaper** — The Last Pickle / DataStax · *Intermediate* · repair orchestration with Prometheus metrics, which closes the loop on the consistency side of monitoring. <http://cassandra-reaper.io/>

---

*Apache Cassandra Handbook — chapter 31.*
