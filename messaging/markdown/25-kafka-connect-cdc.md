# 25 · Kafka Connect & Change Data Capture

> **In one line:** Most of the data you want in Kafka already lives in a database, and most of what you want to do with Kafka's data is put it somewhere else — Kafka Connect moves both directions *without you writing consumer or producer code*, and its sharpest application, Change Data Capture via Debezium, turns a database's transaction log into a stream of every insert, update and delete.

---

## 1. Overview

You have Kafka, and you have the rest of your estate: a Postgres orders database, a MySQL users table, an Elasticsearch cluster for search, an S3 bucket for the data lake, a Snowflake warehouse. The naive way to bridge them is to write code — a service that polls Postgres and produces to Kafka, another that consumes from Kafka and writes to Elasticsearch, a third for S3. Each is a small, boring, error-prone program that you must build, deploy, monitor, restart, and get *exactly-once-ish* right, and you will write dozens of them. This is precisely the work that should not be bespoke, and **Kafka Connect** is the framework that makes it configuration instead of code.

Kafka Connect is a component of Apache Kafka for **streaming data between Kafka and external systems declaratively**. You do not write a consumer or a producer; you pick a **connector** (a reusable, pre-built integration for a given system) and hand it a JSON configuration, and Connect runs it for you — managing offsets, restarts, scaling, retries and delivery semantics. Connectors come in two directions, and the naming is the one thing to fix in your head immediately: a **source connector** pulls data *from* an external system *into* Kafka, and a **sink connector** pushes data *from* Kafka *out to* an external system. Source = into Kafka; sink = out of Kafka. There are hundreds — JDBC, Debezium (databases), Elasticsearch, S3, JMS, MongoDB, BigQuery, and so on — so most integrations are "find the connector, write the config".

The chapter's second half is the highest-value use of a source connector: **Change Data Capture (CDC)**. Instead of periodically asking a database "what changed since I last looked?" (query-based polling, which misses deletes and intermediate states and hammers the table), CDC reads the database's own **transaction log** — the write-ahead log in Postgres, the binlog in MySQL — and emits *every* committed `INSERT`, `UPDATE` and `DELETE` as a Kafka event, in commit order, including the before and after images. **Debezium** is the open-source engine that does this, packaged as a set of Kafka Connect source connectors. Log-based CDC is how you replicate databases, invalidate caches, keep a search index in sync, and — critically — implement the **outbox pattern** (chapter 21) to solve the dual-write problem. This chapter covers the Connect architecture (workers, modes, tasks, converters, transforms, the REST API), then CDC and Debezium in depth, with real connector configs and REST calls throughout.

## 2. Core Concepts

- **Kafka Connect** — a framework and runtime, shipped with Kafka, for streaming data between Kafka and external systems using configuration rather than bespoke code.
- **Connector** — a reusable plugin that integrates one external system. A logical job: "replicate this database", "sink this topic to S3".
- **Source connector** — pulls data from an external system *into* Kafka topics.
- **Sink connector** — pushes data from Kafka topics *out to* an external system.
- **Worker** — a JVM process running the Connect runtime. Connectors and tasks execute inside workers.
- **Standalone mode** — a single worker, config from files; simple, no fault tolerance. For dev and edge cases.
- **Distributed mode** — a cluster of workers coordinating via Kafka; fault-tolerant, scalable, managed over a REST API. The production default.
- **Task** — the unit of work and parallelism. A connector is split into one or more tasks that Connect distributes across workers.
- **Converter** — serialises/deserialises the data crossing the Kafka boundary: `JsonConverter`, `AvroConverter`, `ProtobufConverter` (chapter 26). Separate from the connector itself.
- **SMT (Single Message Transform)** — a lightweight per-message transformation applied in the pipeline: rename a field, mask a value, route to a topic, extract a key — no code.
- **Connect REST API** — the HTTP interface (default port 8083) to create, update, pause, resume, delete and inspect connectors in distributed mode.
- **Change Data Capture (CDC)** — capturing every row-level change (`INSERT`/`UPDATE`/`DELETE`) from a database as a stream of events.
- **Log-based CDC** — reading the database's transaction log (WAL/binlog) to capture changes, versus **query-based** polling that repeatedly SELECTs a table.
- **Debezium** — the open-source CDC platform, a family of Kafka Connect source connectors that read the transaction log of Postgres, MySQL, MongoDB, SQL Server, Oracle and others.
- **Outbox pattern** — writing domain events to an `outbox` table in the same transaction as the business data, then letting Debezium publish them — solving the dual-write problem (chapter 21).

## 3. Theory & Principles

### Why a framework and not just consumers and producers

Anyone can write a program that consumes a topic and writes rows to Postgres. Writing *fifty* of them, each correctly handling offset management, restart-from-where-you-left-off, back-off and retry, schema evolution, partial-batch failures, scaling to multiple workers, and configuration-driven deployment, is a platform problem — and rebuilding that platform badly, once per integration, is the mistake Connect exists to prevent. Connect factors out everything that is *common* to data-movement jobs (offset tracking, task distribution, restarts, converters, transforms, REST management, monitoring) and leaves the connector author to implement only what is *specific* to their system (how to read a JDBC result set, how to write an Elasticsearch bulk request). For you, the operator, that means a new integration is usually a JSON document, not a codebase, and the operational behaviour is uniform across all of them.

### Query-based vs log-based CDC — the distinction that matters

There are two ways to capture what changed in a database, and choosing the wrong one causes silent data loss. **Query-based CDC** repeatedly runs a `SELECT ... WHERE updated_at > :last` against the table, using a monotonically increasing column (a timestamp or an incrementing id) as a high-water mark. It is simple and needs no special database privileges, but it has fundamental gaps: it **cannot see deletes** (a deleted row simply stops appearing — there is no row to select), it **misses intermediate states** (if a row changes twice between polls you see only the final value), it depends on the application *always* updating the watermark column correctly, and each poll is a table scan that competes with production load. **Log-based CDC** instead reads the database's own transaction log — the ordered, durable record the database itself writes to guarantee durability and replication. Because *every* committed change goes through that log, log-based CDC captures **every** insert, update and delete, in exact commit order, with before-and-after images, at low overhead (it tails a log the database was writing anyway), and with no impact on the table's query load. The trade-off is operational: you must enable logical replication / row-based binlog, grant replication privileges, and manage replication slots — but the completeness and correctness are worth it, and it is what Debezium does.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="c1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
    <marker id="c2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Query-based polling vs log-based CDC</text>

  <rect x="24" y="42" width="410" height="196" rx="10" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="229" y="64" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Query-based: SELECT ... WHERE updated_at &gt; :last</text>
  <rect x="48" y="80" width="120" height="40" rx="6" fill="#fff" stroke="#fca5a5"/><text x="108" y="104" text-anchor="middle" fill="#7f1d1d" font-size="10">orders table</text>
  <rect x="300" y="80" width="110" height="40" rx="6" fill="#fff" stroke="#fca5a5"/><text x="355" y="104" text-anchor="middle" fill="#7f1d1d" font-size="10">poller</text>
  <path d="M298,100 L172,100" stroke="#dc2626" stroke-width="2" stroke-dasharray="5 3" marker-end="url(#c1)"/>
  <text x="235" y="94" text-anchor="middle" fill="#b91c1c" font-size="9">poll every N s (table scan)</text>
  <text x="40" y="146" fill="#991b1b" font-size="10">&#215; cannot see DELETEs (no row to select)</text>
  <text x="40" y="166" fill="#991b1b" font-size="10">&#215; misses intermediate states (2 changes/poll &#8594; 1)</text>
  <text x="40" y="186" fill="#991b1b" font-size="10">&#215; needs a reliable updated_at column, always set</text>
  <text x="40" y="206" fill="#991b1b" font-size="10">&#215; every poll competes with production query load</text>
  <text x="40" y="226" fill="#7f1d1d" font-size="10" font-weight="bold">simple, no special privileges &#8212; but lossy</text>

  <rect x="446" y="42" width="410" height="196" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="651" y="64" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Log-based: tail the transaction log (WAL/binlog)</text>
  <rect x="470" y="80" width="120" height="40" rx="6" fill="#fff" stroke="#86efac"/><text x="530" y="98" text-anchor="middle" fill="#14532d" font-size="10">DB engine</text><text x="530" y="112" text-anchor="middle" fill="#166534" font-size="8">writes WAL anyway</text>
  <rect x="620" y="78" width="80" height="44" rx="6" fill="#bbf7d0" stroke="#16a34a"/><text x="660" y="97" text-anchor="middle" fill="#14532d" font-size="9">WAL /</text><text x="660" y="110" text-anchor="middle" fill="#14532d" font-size="9">binlog</text>
  <rect x="726" y="80" width="110" height="40" rx="6" fill="#fff" stroke="#86efac"/><text x="781" y="98" text-anchor="middle" fill="#14532d" font-size="10">Debezium</text><text x="781" y="112" text-anchor="middle" fill="#166534" font-size="8">reads the log</text>
  <path d="M590,100 L618,100" stroke="#16a34a" stroke-width="2" marker-end="url(#c2)"/>
  <path d="M700,100 L724,100" stroke="#16a34a" stroke-width="2" marker-end="url(#c2)"/>
  <text x="462" y="146" fill="#166534" font-size="10">&#10003; captures EVERY insert / update / delete</text>
  <text x="462" y="166" fill="#166534" font-size="10">&#10003; exact commit order, before + after images</text>
  <text x="462" y="186" fill="#166534" font-size="10">&#10003; low overhead (tails a log already written)</text>
  <text x="462" y="206" fill="#166534" font-size="10">&#10003; no extra load on the table's queries</text>
  <text x="462" y="226" fill="#14532d" font-size="10" font-weight="bold">needs replication privileges + slot management</text>

  <rect x="24" y="252" width="832" height="200" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="274" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">A Debezium change event (Postgres UPDATE), simplified</text>
  <g font-family="ui-monospace,monospace" font-size="9.5" fill="#334155">
    <text x="48" y="298">"op": "u",            &#8592; c=create, u=update, d=delete, r=read (snapshot)</text>
    <text x="48" y="316">"ts_ms": 1717000000123,</text>
    <text x="48" y="334">"source": { "db":"shop", "table":"orders", "lsn":42007, "txId":9912 },</text>
    <text x="48" y="352">"before": { "id":42, "status":"PENDING", "total":1000 },   &#8592; prior row image</text>
    <text x="48" y="370">"after":  { "id":42, "status":"PAID",    "total":1000 }    &#8592; new row image</text>
  </g>
  <text x="48" y="398" fill="#475569" font-size="10">The event carries what changed, from what to what, when, and where in the log (lsn) &#8212; a delete carries the "before" and a null "after".</text>
  <text x="48" y="420" fill="#475569" font-size="10">Key = the primary key &#8594; same row's changes go to the same partition &#8594; per-row ordering preserved.</text>
  <text x="48" y="440" fill="#334155" font-size="10" font-weight="bold">This is a complete, ordered audit trail of the database &#8212; the raw material for replication, caches, search and the outbox.</text>
</svg>
```

### Connect handles the hard parts so connectors stay simple

The framework owns *offset management* on both sides: a source connector reports a source-specific position (for Debezium, the log sequence number / binlog coordinate) which Connect stores in an internal topic, so on restart it resumes exactly where it stopped; a sink connector's progress is ordinary Kafka consumer-group offsets. It owns *task distribution and failover* (in distributed mode, tasks rebalance across workers when one dies), *converters* (the pluggable serialisation at the Kafka boundary, independent of the connector), *transforms* (SMTs applied inline), and *dead-letter routing* for records a sink cannot process. This separation — framework common, connector specific — is why the ecosystem has hundreds of connectors and why they behave consistently in production.

## 4. Architecture & Workflow

Connect's runtime is a set of **workers**; connectors and their tasks run inside them. The two deployment modes differ sharply:

1. **Standalone mode.** One worker process, configured from properties files, offsets stored in a local file. Simple, no coordination, but a single point of failure and no horizontal scaling. Use it for development, a laptop demo, or a genuinely single-node edge collector.
2. **Distributed mode.** A cluster of workers sharing a `group.id`; they coordinate through Kafka itself, storing connector configs, offsets and status in three internal *compacted* topics (`connect-configs`, `connect-offsets`, `connect-status`). Any worker can die and its tasks rebalance onto the survivors. You manage everything through the **REST API** (port 8083) — POST a connector config, GET its status, PUT to reconfigure, DELETE to remove. This is the production model.
3. **Connectors split into tasks.** A connector declares how many tasks it can run (`tasks.max`), and Connect distributes those tasks across workers for parallelism. A Debezium connector for one database typically runs a *single* task (the transaction log is a single serial stream), whereas a JDBC source or an S3 sink can parallelise across many tasks by table or partition.
4. **Data flows through converters and transforms.** For a source: connector reads the external system → produces records → **SMTs** transform each record → **converter** serialises → Kafka. For a sink: Kafka → converter deserialises → SMTs transform → connector writes to the external system. Converters (JSON/Avro/Protobuf) are configured separately from the connector, so the same connector can emit JSON in dev and Avro-with-Schema-Registry in prod.
5. **Failure handling.** Source position and sink offsets are durable, so a restart resumes cleanly. Sinks can route un-processable records to a **dead-letter queue** topic (`errors.tolerance=all` + `errors.deadletterqueue.topic.name`) instead of halting the connector.

```svg
<svg viewBox="0 0 880 450" width="100%" height="450" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="w1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="w2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Kafka Connect (distributed): sources IN, sinks OUT</text>

  <rect x="24" y="44" width="150" height="70" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="99" y="74" text-anchor="middle" fill="#92400e" font-size="10" font-weight="bold">Postgres / MySQL</text>
  <text x="99" y="94" text-anchor="middle" fill="#b45309" font-size="9">(transaction log)</text>

  <rect x="24" y="130" width="150" height="60" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="99" y="156" text-anchor="middle" fill="#92400e" font-size="10" font-weight="bold">S3 / Elasticsearch</text>
  <text x="99" y="174" text-anchor="middle" fill="#b45309" font-size="9">(sinks write here)</text>

  <rect x="240" y="52" width="360" height="150" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="420" y="74" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">Connect cluster (workers share group.id)</text>
  <rect x="260" y="86" width="150" height="46" rx="6" fill="#fff" stroke="#60a5fa"/><text x="335" y="104" text-anchor="middle" fill="#1e40af" font-size="9">worker 1</text><text x="335" y="122" text-anchor="middle" fill="#1d4ed8" font-size="8">source task (Debezium)</text>
  <rect x="430" y="86" width="150" height="46" rx="6" fill="#fff" stroke="#60a5fa"/><text x="505" y="104" text-anchor="middle" fill="#1e40af" font-size="9">worker 2</text><text x="505" y="122" text-anchor="middle" fill="#1d4ed8" font-size="8">sink task (S3)</text>
  <text x="260" y="152" fill="#1d4ed8" font-size="9">converters: Json / Avro / Protobuf (at the Kafka boundary)</text>
  <text x="260" y="170" fill="#1d4ed8" font-size="9">SMTs: rename / mask / route / extract-key (per message)</text>
  <text x="260" y="190" fill="#1d4ed8" font-size="9">REST API :8083 &#8212; POST/GET/PUT/DELETE connectors</text>

  <path d="M174,80 L238,110" stroke="#2563eb" stroke-width="2" marker-end="url(#w1)"/>
  <text x="192" y="86" fill="#1e40af" font-size="8">source: IN</text>
  <path d="M238,150 L176,158" stroke="#16a34a" stroke-width="2" marker-end="url(#w2)"/>
  <text x="192" y="184" fill="#15803d" font-size="8">sink: OUT</text>

  <rect x="668" y="52" width="188" height="150" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="762" y="74" text-anchor="middle" fill="#5b21b6" font-size="11" font-weight="bold">Kafka</text>
  <g font-size="8" fill="#5b21b6">
    <rect x="684" y="86" width="156" height="18" fill="#fff" stroke="#a78bfa"/><text x="692" y="99">topic: shop.public.orders</text>
    <rect x="684" y="108" width="156" height="18" fill="#fff" stroke="#a78bfa"/><text x="692" y="121">topic: shop.public.users</text>
    <rect x="684" y="134" width="156" height="16" fill="#f5f3ff" stroke="#c4b5fd"/><text x="692" y="146">connect-configs (compacted)</text>
    <rect x="684" y="152" width="156" height="16" fill="#f5f3ff" stroke="#c4b5fd"/><text x="692" y="164">connect-offsets (compacted)</text>
    <rect x="684" y="170" width="156" height="16" fill="#f5f3ff" stroke="#c4b5fd"/><text x="692" y="182">connect-status (compacted)</text>
  </g>
  <path d="M600,120 L666,120" stroke="#2563eb" stroke-width="2" marker-end="url(#w1)"/>

  <rect x="24" y="222" width="832" height="106" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="440" y="244" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">The pipeline for one record</text>
  <text x="40" y="268" fill="#166534" font-size="10">SOURCE: external read &#8594; connector emits record &#8594; SMTs (rename/route) &#8594; converter serialises &#8594; produced to a topic; position saved in connect-offsets</text>
  <text x="40" y="290" fill="#166534" font-size="10">SINK: consume topic (group offsets) &#8594; converter deserialises &#8594; SMTs &#8594; connector writes to external system; un-processable &#8594; dead-letter topic</text>
  <text x="40" y="314" fill="#14532d" font-size="10" font-weight="bold">You configure this. You do not write a consumer or a producer.</text>

  <rect x="24" y="340" width="832" height="96" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="362" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Standalone vs distributed</text>
  <text x="40" y="386" fill="#475569" font-size="10">STANDALONE: one worker, file config + file offsets, no HA, no scale-out &#8212; dev / single-node edge only.</text>
  <text x="40" y="408" fill="#475569" font-size="10">DISTRIBUTED: worker cluster, config/offsets/status in Kafka, tasks rebalance on failure, managed via REST &#8212; the production default.</text>
  <text x="40" y="428" fill="#334155" font-size="10" font-weight="bold">Rule: standalone to try it, distributed to run it.</text>
</svg>
```

The workflow lesson is that a data-integration *pipeline* is now a set of JSON documents posted to a REST API against a fault-tolerant cluster, with serialisation and transforms as pluggable, declarative stages. The engineering you do is choosing connectors, converters and transforms — not writing and operating movers.

## 5. Implementation

Everything below is real: connector JSON configs, `curl` against the Connect REST API, and a Debezium config for both Postgres and MySQL. Start with the REST API lifecycle — this is how you operate distributed Connect.

```bash
# List the connector plugins this worker has installed (Debezium, JDBC, S3, ...).
curl -s http://localhost:8083/connector-plugins | jq '.[].class'

# List running connectors, and inspect one connector's status (state + task states).
curl -s http://localhost:8083/connectors | jq
curl -s http://localhost:8083/connectors/orders-cdc/status | jq

# Create a connector by POSTing its config. This is the entire "deployment".
curl -s -X POST http://localhost:8083/connectors \
  -H 'Content-Type: application/json' \
  -d @orders-cdc.json | jq

# Pause / resume / restart a failed task / reconfigure (PUT replaces config) / delete.
curl -s -X PUT    http://localhost:8083/connectors/orders-cdc/pause
curl -s -X PUT    http://localhost:8083/connectors/orders-cdc/resume
curl -s -X POST   http://localhost:8083/connectors/orders-cdc/restart?includeTasks=true
curl -s -X PUT    http://localhost:8083/connectors/orders-cdc/config -H 'Content-Type: application/json' -d @orders-cdc-config-only.json
curl -s -X DELETE http://localhost:8083/connectors/orders-cdc
```

A **Debezium Postgres source connector** (`orders-cdc.json`) — log-based CDC over the WAL via the `pgoutput` logical-decoding plugin. Every committed change to the listed tables becomes an event on a topic named `<topic.prefix>.<schema>.<table>`:

```json
{
  "name": "orders-cdc",
  "config": {
    "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
    "tasks.max": "1",

    "database.hostname": "postgres.internal",
    "database.port": "5432",
    "database.user": "debezium",
    "database.password": "${file:/secrets/creds.properties:pg_password}",
    "database.dbname": "shop",

    "topic.prefix": "shop",
    "plugin.name": "pgoutput",
    "slot.name": "debezium_orders",
    "publication.name": "dbz_publication",

    "table.include.list": "public.orders,public.order_items",
    "snapshot.mode": "initial",

    "key.converter": "org.apache.kafka.connect.json.JsonConverter",
    "value.converter": "org.apache.kafka.connect.json.JsonConverter",
    "key.converter.schemas.enable": "false",
    "value.converter.schemas.enable": "false",

    "transforms": "unwrap,route",
    "transforms.unwrap.type": "io.debezium.transforms.ExtractNewRecordState",
    "transforms.unwrap.drop.tombstones": "false",
    "transforms.unwrap.delete.handling.mode": "rewrite",
    "transforms.route.type": "org.apache.kafka.connect.transforms.RegexRouter",
    "transforms.route.regex": "shop.public.(.*)",
    "transforms.route.replacement": "cdc.$1"
  }
}
```

The two SMTs earn their keep. `ExtractNewRecordState` (Debezium's `unwrap`) flattens the verbose `{before, after, op, source}` envelope down to just the `after` row for consumers that want the current state (a delete becomes a tombstone or a rewritten record). `RegexRouter` renames the auto-generated `shop.public.orders` topic to a tidier `cdc.orders`. Neither required code.

The MySQL equivalent reads the **binlog** (row-based) and needs a unique server id:

```json
{
  "name": "users-cdc-mysql",
  "config": {
    "connector.class": "io.debezium.connector.mysql.MySqlConnector",
    "tasks.max": "1",
    "database.hostname": "mysql.internal",
    "database.port": "3306",
    "database.user": "debezium",
    "database.password": "${file:/secrets/creds.properties:mysql_password}",
    "database.server.id": "184054",
    "topic.prefix": "app",
    "database.include.list": "app",
    "table.include.list": "app.users",
    "schema.history.internal.kafka.bootstrap.servers": "kafka:9092",
    "schema.history.internal.kafka.topic": "schema-history.app",
    "snapshot.mode": "initial"
  }
}
```

The **outbox pattern via Debezium** (cross-ref chapter 21) is the most valuable CDC use of all. Your service writes a domain event row into an `outbox` table *in the same local transaction* as the business change, so there is no dual-write to fail. Debezium's purpose-built `EventRouter` SMT reads those rows and publishes each as an event on a topic derived from the aggregate type:

```json
{
  "name": "outbox-connector",
  "config": {
    "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
    "tasks.max": "1",
    "database.hostname": "postgres.internal",
    "database.dbname": "shop",
    "database.user": "debezium",
    "database.password": "${file:/secrets/creds.properties:pg_password}",
    "topic.prefix": "shop",
    "table.include.list": "public.outbox",
    "transforms": "outbox",
    "transforms.outbox.type": "io.debezium.transforms.outbox.EventRouter",
    "transforms.outbox.table.field.event.key": "aggregate_id",
    "transforms.outbox.route.by.field": "aggregate_type",
    "transforms.outbox.route.topic.replacement": "events.${routedByValue}"
  }
}
```

And a **sink** connector to prove data flows the other way — stream a topic straight into Elasticsearch for search indexing, no consumer code:

```json
{
  "name": "orders-to-elasticsearch",
  "config": {
    "connector.class": "io.confluent.connect.elasticsearch.ElasticsearchSinkConnector",
    "tasks.max": "3",
    "topics": "cdc.orders",
    "connection.url": "http://elasticsearch:9200",
    "key.ignore": "false",
    "schema.ignore": "true",
    "behavior.on.null.values": "delete",
    "errors.tolerance": "all",
    "errors.deadletterqueue.topic.name": "dlq.orders-es",
    "errors.deadletterqueue.context.headers.enable": "true"
  }
}
```

Note `behavior.on.null.values=delete`: a Debezium tombstone (null value for a deleted primary key) becomes a *delete* in Elasticsearch, so a row deleted in Postgres disappears from search automatically — CDC keeping a search index in perfect sync with three lines of config. And `errors.tolerance=all` with a dead-letter topic means one poison record does not stall the whole sink.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **No integration code.** A source or sink is a JSON config against a running cluster; hundreds of connectors already exist for common systems.
- **Uniform operations.** Offset management, restarts, retries, scaling and monitoring are the same for every connector — one operational model, not fifty.
- **Fault-tolerant and scalable.** Distributed mode rebalances tasks across workers on failure and parallelises via `tasks.max`.
- **Log-based CDC via Debezium is complete.** Every insert/update/delete in commit order, with before/after images, at low database overhead and no query-load impact.
- **Pluggable serialisation and transforms.** Converters (JSON/Avro/Protobuf) and SMTs are declarative stages, so the same connector adapts across environments.

**Disadvantages**
- **Another distributed system to run.** A Connect cluster, its internal topics, plugins and versions are real operational surface (unless you use a managed offering).
- **CDC has database prerequisites.** Logical replication / row-based binlog, replication privileges, and replication-slot management — and an abandoned slot can bloat the WAL and threaten the source database.
- **SMTs are deliberately limited.** Single-message, stateless transforms only; anything involving joins, aggregation or lookups belongs in Kafka Streams or ksqlDB, not a transform.
- **Schema and type mapping surprises.** Database types (decimals, timestamps, enums, JSON) map to Connect types in ways that bite without care (chapter 26).
- **Delivery is at-least-once by default.** Sinks can deliver duplicates on retry; the target must tolerate them (idempotent upserts) unless the connector supports exactly-once.

**Trade-offs**
- *Config vs control:* Connect trades the fine-grained control of hand-written code for uniformity and speed — wonderful until you need behaviour the connector does not expose, at which point you extend it or fall back to code.
- *Log-based vs query-based CDC:* log-based is complete and low-impact but demands database privileges and slot management; query-based is trivial to set up but misses deletes and intermediate states. Choose log-based unless you truly cannot.
- *SMT vs stream processor:* SMTs are free and inline but only do per-message reshaping; real transformation (enrichment, aggregation, joins) belongs downstream in Streams/ksqlDB. Overloading SMTs makes pipelines brittle.
- *Managed vs self-hosted:* a managed Connect service removes the operational burden at the cost of money and connector availability; self-hosting is cheaper and more flexible but you own the cluster.

## 7. Common Mistakes & Best Practices

- **Confusing source and sink.** Source pulls *into* Kafka; sink pushes *out*. Wiring a sink where you meant a source (or vice versa) is the first-week mistake — say the direction out loud.
- **Using query-based CDC and losing deletes.** A JDBC source polling `updated_at` never sees deletions and misses intermediate states; if you need a faithful change stream, use log-based Debezium.
- **Neglecting the replication slot.** A Debezium Postgres connector that is paused or removed without dropping its slot leaves the slot holding WAL, which grows until it fills the disk and takes the database down. Monitor slot lag; clean up slots you retire.
- **Over-parallelising a CDC connector.** The transaction log is a single serial stream, so a Debezium connector runs one task; setting `tasks.max` higher does nothing and misleads. Parallelism for CDC comes from the topic's partitions downstream, not the connector.
- **Ignoring schema evolution.** A column added or a type changed upstream flows into the change events; without a Schema Registry and a compatibility policy this breaks consumers silently (chapter 26).
- **No dead-letter queue on sinks.** One malformed record halts a sink that lacks `errors.tolerance=all` + a DLQ topic, stalling the whole pipeline behind it.
- **Hard-coding secrets in connector JSON.** Configs are stored (in `connect-configs`) and returned by the REST API; put credentials in a `ConfigProvider` (file/Vault) and reference them, never inline.
- **Best practice:** run distributed mode with externalised secrets, prefer log-based CDC, keep `tasks.max=1` for CDC connectors, put a Schema Registry and a DLQ in every pipeline, and monitor replication-slot lag and connector/task state from day one.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** The REST API is your first stop: `GET /connectors/<name>/status` shows the connector and each task's state (`RUNNING`, `FAILED`) with the stack trace of a failed task; `POST .../restart?includeTasks=true` recovers a task that failed on a transient error. For CDC specifically, check the source database's replication view (Postgres `pg_replication_slots`, MySQL `SHOW BINARY LOGS`) to see how far behind the connector is reading. When a sink misbehaves, the dead-letter topic (with `errors.deadletterqueue.context.headers.enable=true`) carries the failing record and the reason in headers.
- **Monitoring.** Connect exposes JMX metrics: `source-record-poll-rate` and `sink-record-send-rate` (throughput), `source-record-write-total`, task `status` (alert on any `FAILED`), and for CDC the **replication lag** — how far the connector trails the current log position — which is the CDC analogue of consumer lag and the number to watch. Alert on failed tasks and on replication-slot growth (a growing slot on a healthy-looking connector means it stopped reading and the WAL is piling up).
- **Security.** Connect talks to Kafka and to external systems, so both edges need securing: TLS + SASL and ACLs to Kafka (including on the internal `connect-*` topics and the connector's consumer groups), and least-privilege credentials to each external system — a Debezium user needs *only* replication and read on the captured tables, nothing more. Externalise every secret via a `ConfigProvider` so credentials are not stored in cleartext in the config topic or leaked through the REST API, and protect the REST endpoint itself (it can create and delete connectors) behind auth and network controls (chapter 29).
- **Scaling.** Add workers to a distributed cluster to spread tasks; raise `tasks.max` for connectors that can parallelise (JDBC by table, S3 by partition) — but *not* for a single-log CDC connector, whose throughput scales via the downstream topic's partitions instead. Size the internal topics and the converter/Schema-Registry path for your record rate, and keep an eye on rebalance frequency, since a flapping worker triggers task reassignment that pauses movement.

## 9. Interview Questions

**Q: What is Kafka Connect and why use it instead of writing consumers and producers?**
A: It is a framework, shipped with Kafka, for streaming data between Kafka and external systems *declaratively* — you configure a pre-built connector rather than writing code. The reason to prefer it is that a data-movement job is 90% boilerplate that is easy to get wrong: offset tracking, resume-after-restart, retries and back-off, scaling across workers, serialisation, and per-message transforms. Connect factors all of that out and handles it uniformly, leaving the connector author to implement only what is specific to their system. So instead of building and operating fifty bespoke movers, you post JSON configs to a fault-tolerant cluster, and they all behave consistently.

**Q: What is the difference between a source and a sink connector?**
A: A source connector pulls data *from* an external system *into* Kafka topics — a database, a message queue, a file. A sink connector pushes data *from* Kafka topics *out to* an external system — Elasticsearch, S3, a warehouse. The mnemonic is that Kafka is the centre: source flows in, sink flows out. Debezium is a source (database → Kafka); the Elasticsearch and S3 connectors are sinks (Kafka → external).

**Q: What is the difference between standalone and distributed mode?**
A: Standalone runs a single worker configured from properties files with offsets in a local file — simple, but a single point of failure with no horizontal scaling; it suits development or a single-node edge collector. Distributed mode runs a cluster of workers that coordinate through Kafka, storing connector configs, offsets and status in internal compacted topics, so tasks rebalance onto surviving workers when one dies, and you manage everything through the REST API. Distributed is the production default; standalone is for trying things out.

**Q: What is Change Data Capture?**
A: CDC is capturing every row-level change — inserts, updates and deletes — from a database as a stream of events, so other systems can react to data changes in near-real-time. Rather than periodically asking "what does the table look like now?", CDC produces a change event for each modification, ideally read from the database's own transaction log so nothing is missed. It is the foundation for database replication, cache invalidation, keeping search indexes in sync, feeding data lakes and warehouses, and the outbox pattern.

**Q: What is Debezium and how does it capture changes?**
A: Debezium is an open-source CDC platform packaged as a family of Kafka Connect source connectors for Postgres, MySQL, MongoDB, SQL Server, Oracle and others. It captures changes by reading the database's *transaction log* — the write-ahead log in Postgres (via logical decoding), the binlog in MySQL — which is the ordered, durable record the database writes for its own durability and replication. Because every committed change passes through that log, Debezium emits an event for every insert, update and delete, in commit order, with before-and-after row images, at low overhead and with no extra load on the table's queries. It first takes an initial snapshot of existing rows, then streams ongoing changes from the log.

**Q: What is an SMT and what should it not be used for?**
A: A Single Message Transform is a lightweight, stateless transformation applied to each record as it flows through a connector pipeline — renaming or dropping a field, masking a sensitive value, routing to a different topic, extracting a key, flattening a Debezium envelope. It is configured, not coded. What it should *not* do is anything requiring state or multiple records: joins, aggregations, lookups, or windowing. Those belong in a stream processor like Kafka Streams or ksqlDB downstream. SMTs are for per-message reshaping only; overloading them makes pipelines brittle.

**Q: How does CDC enable cache invalidation and search indexing?**
A: Because CDC emits an event for every change to the source data, any system that must stay in sync with that data can subscribe to the change stream and update itself. For a cache, you consume the change events and invalidate or refresh the corresponding cache entries whenever the underlying row changes, so the cache never serves stale data indefinitely. For a search index, a sink connector (say Elasticsearch) consumes the change topic and upserts each changed document — and, crucially, a delete in the database becomes a tombstone that the sink turns into a delete in the index, so the index tracks the database precisely. Both are near-real-time and require no polling, because the database's own log drives the updates.

**Q: (Senior) Compare log-based and query-based CDC and explain when each is appropriate.**
A: Query-based CDC repeatedly runs a `SELECT ... WHERE change_column > last_seen` against the table using a monotonic timestamp or id as a high-water mark. It is trivial to set up and needs no special privileges, but it has fundamental correctness gaps: it cannot observe deletes (a deleted row simply stops appearing), it misses intermediate states when a row changes more than once between polls, it depends on the application reliably maintaining the watermark column, and each poll is a table scan competing with production load. Log-based CDC instead reads the database's transaction log, which contains *every* committed change in order — so it captures all inserts, updates and deletes with before/after images, faithfully, at low overhead, and without touching the table's query path. The costs are operational: you must enable logical replication or row-based binlog, grant replication privileges, and manage replication slots (an abandoned slot can bloat the WAL and endanger the database). I choose log-based CDC by default for anything that must be a faithful, complete change stream — replication, the outbox, search sync — and only fall back to query-based when I genuinely cannot get replication access to the database and can tolerate missing deletes and intermediate states, for example a coarse periodic export of an append-mostly table.

**Q: (Senior) How does Debezium implement the outbox pattern, and what problem does it solve?**
A: The problem is the dual write: a service that must both persist a business change *and* publish an event has two separate systems to write to — its database and Kafka — and if it writes the database and then crashes before publishing (or vice versa), the two diverge, with no clean transaction spanning both. The outbox pattern removes the second write. The service inserts the event as a row into an `outbox` table *within the same local database transaction* as the business change, so either both the business row and the event row commit or neither does — a single atomic transaction, no distributed commit. Debezium then captures the `outbox` table via CDC and publishes each new row to Kafka using its `EventRouter` SMT, which routes by the aggregate type to a per-aggregate topic and keys by the aggregate id so a given entity's events stay ordered. The result is guaranteed at-least-once publication of exactly the events the transaction committed, with no lost or phantom events and no two-phase commit — the event stream becomes a faithful projection of committed database state. The subtlety to get right is that consumers are at-least-once (Debezium can re-emit on restart), so they must be idempotent, and the outbox table needs a cleanup strategy so it does not grow unbounded. This is the canonical, production-grade solution to the dual-write problem, and it is why CDC is central to event-driven architecture, not just a replication tool.

**Q: (Senior) A Debezium connector shows RUNNING but no new events arrive, and the source database's disk is filling. What is going on?**
A: This is the classic replication-slot pathology. A Debezium Postgres connector holds a *replication slot*, and the slot marks the oldest WAL position the connector still needs; Postgres cannot recycle WAL past that position until the connector confirms it has consumed it. If the connector has silently stopped making progress — a stuck task, a downstream Kafka outage blocking the producer, a converter or Schema-Registry failure so records cannot be written, or a connector that was *paused* rather than deleted — it stops advancing the slot, so the database retains WAL indefinitely and the disk fills, which will eventually take the source database down. "RUNNING" is misleading because the connector process is up even though it is not committing offsets. The diagnosis is to query `pg_replication_slots` and look at the retained-WAL / `confirmed_flush_lsn` lag: a large, growing value confirms it. The fixes are to unblock whatever downstream is stalling the producer (Kafka reachability, Schema Registry, the sink), restart the failed task, and, if you are retiring a connector, to *drop the slot* explicitly rather than leaving it orphaned. The preventive controls are alerting on replication-slot lag (not just on task state), setting a slot's `max_slot_wal_keep_size` where the database supports it so a runaway slot is capped rather than fatal, and never pausing a CDC connector for long without watching the slot. The general lesson is that with log-based CDC the health of the *source database* is coupled to the connector, so slot lag is a first-class metric alongside connector status.

## 10. Quick Revision & Cheat Sheet

| Term | Meaning |
|---|---|
| Source connector | External system → Kafka (data *in*) |
| Sink connector | Kafka → external system (data *out*) |
| Worker | JVM process running the Connect runtime |
| Standalone / Distributed | One worker, file config / worker cluster, config in Kafka + REST |
| Task | Unit of parallelism; a connector splits into `tasks.max` tasks |
| Converter | Serialisation at the Kafka boundary (JSON/Avro/Protobuf) |
| SMT | Per-message, stateless transform (rename/mask/route/extract) |
| CDC | Capture every insert/update/delete as an event stream |
| Debezium | Log-based CDC source connectors (WAL/binlog) |

| CDC approach | Sees deletes? | Intermediate states? | DB load | Setup |
|---|---|---|---|---|
| Query-based (poll) | No | No | High (scans) | Trivial |
| Log-based (Debezium) | Yes | Yes | Low (tails log) | Needs replication access |

**Flash cards**
- **Source vs sink?** → Source = into Kafka; sink = out of Kafka.
- **Standalone vs distributed?** → File config, single node / worker cluster + REST + config-in-Kafka, HA.
- **Why log-based CDC over polling?** → Polling misses deletes and intermediate states; the log captures every change in order.
- **What does Debezium read?** → The transaction log — Postgres WAL, MySQL binlog.
- **Outbox pattern?** → Write event to an outbox table in the business transaction; Debezium publishes it — no dual write.
- **CDC's #1 production metric?** → Replication-slot / log lag; a stuck slot bloats the source DB's disk.

## 11. Hands-On Exercises & Mini Project

- [ ] Stand up distributed Connect and use the REST API to list plugins, create a connector from JSON, check its status, pause/resume it, and delete it.
- [ ] Configure a Debezium Postgres (or MySQL) source connector against a demo table and watch inserts/updates/deletes appear as change events on the topic.
- [ ] Delete a row in the source and observe the delete event (and the tombstone) in Kafka — then contrast with a query-based JDBC source that never emits it.
- [ ] Add the `ExtractNewRecordState` and `RegexRouter` SMTs and see the envelope flattened and the topic renamed, with no code.
- [ ] Add an Elasticsearch (or a file/JDBC) sink with `behavior.on.null.values=delete` and a dead-letter topic, and confirm a source delete removes the indexed document.
- [ ] Break a downstream deliberately (stop Kafka or the sink), watch the replication slot lag grow in `pg_replication_slots`, then recover and confirm it drains.

### Mini Project — "Zero-Code Database-to-Search Pipeline with the Outbox"

**Goal.** Build an end-to-end, code-free pipeline that replicates an orders database into a search index and publishes domain events via the outbox pattern, entirely through Kafka Connect configuration.

**Requirements.**
1. Run distributed Kafka Connect with Debezium and an Elasticsearch sink installed, secrets externalised via a `ConfigProvider`.
2. Configure a Debezium Postgres source over the WAL capturing the `orders` and `outbox` tables, with an initial snapshot then streaming.
3. Use SMTs to flatten the change envelope and route topics to tidy names; route the outbox table with the `EventRouter` SMT to per-aggregate `events.*` topics.
4. Configure an Elasticsearch sink on the orders change topic with `behavior.on.null.values=delete` and a dead-letter topic, so inserts/updates upsert documents and deletes remove them.
5. Have a small app write an order and an outbox event in one transaction; verify the order appears in Elasticsearch and the domain event on `events.order`, proving no dual write.

**Extensions.**
- Add a Schema Registry with the Avro converter (chapter 26) and demonstrate a backward-compatible column addition flowing through without breaking the sink.
- Simulate a downstream outage, show the replication slot retaining WAL, alert on slot lag, and recover cleanly.
- Add a second sink (S3 or a warehouse) on the same change topic to show one change stream feeding multiple destinations.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Idempotency, Deduplication & the Outbox Pattern* (the dual-write problem Debezium solves), *Schema Management: Avro, Protobuf & the Registry* (the converters and compatibility CDC needs), *Design: Kafka Streams & Stream Processing Basics* (transforming the change streams Connect produces), *The Log: Offsets, Segments & Retention* (why the change topics behave as they do), *Delivery Guarantees* (the at-least-once semantics of sinks and CDC).

- **Kafka Connect — Documentation** — Apache Kafka · *Intermediate* · the authoritative reference for workers, modes, tasks, converters and the REST API. <https://kafka.apache.org/documentation/#connect>
- **Debezium Documentation** — Debezium · *Intermediate* · connector-by-connector guides for Postgres, MySQL and more, including snapshots, SMTs and the outbox router. <https://debezium.io/documentation/>
- **The Debezium Blog — Outbox Event Router** — Debezium · *Advanced* · the canonical write-up of implementing the outbox pattern with CDC. <https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html>
- **Confluent — Kafka Connect Deep Dive** — Confluent (Robin Moffatt) · *Intermediate* · practical guidance on converters, SMTs, error handling and dead-letter queues. <https://www.confluent.io/blog/kafka-connect-deep-dive-converters-serialization-explained/>
- **Designing Data-Intensive Applications, ch. 11** — Martin Kleppmann · *Advanced* · change data capture and the log as the source of truth for derived systems. <https://dataintensive.net/>
- **PostgreSQL — Logical Decoding & Replication Slots** — PostgreSQL · *Advanced* · what Debezium reads and the slot mechanics you must operate. <https://www.postgresql.org/docs/current/logicaldecoding.html>
- **Confluent Hub — Connector Catalogue** — Confluent · *Beginner* · the searchable index of available source and sink connectors. <https://www.confluent.io/hub/>
- **Kafka Connect REST API reference** — Confluent · *Intermediate* · every endpoint for creating, inspecting and managing connectors in distributed mode. <https://docs.confluent.io/platform/current/connect/references/restapi.html>

---

*Kafka & RabbitMQ Handbook — chapter 25.*
