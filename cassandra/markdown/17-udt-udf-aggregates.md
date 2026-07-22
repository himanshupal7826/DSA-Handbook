# 17 · UDTs, UDFs & User-Defined Aggregates

> **In one line:** CQL lets you extend the type system with UDTs and the execution engine with UDFs and UDAs — but UDTs are frozen blobs you cannot query into, and UDFs run arbitrary code inside the coordinator's JVM, which is why they ship disabled.

---

## 1. Overview

Cassandra's data model is deliberately narrow, and three extension points widen it: **user-defined types** (UDTs) let you nest a structured value inside a column, **user-defined functions** (UDFs) let you compute a per-row scalar server-side, and **user-defined aggregates** (UDAs) chain a UDF over a result set to produce a single value. All three arrived together in Cassandra 2.2 (2015) via CASSANDRA-4914 and CASSANDRA-7395, filling gaps that developers were otherwise filling with awkward client-side code or a second table.

The problem UDTs solve is *shape*. Before them, storing an address meant five columns (`addr_street`, `addr_city`, ...) with a prefix convention, or a JSON blob you could not validate. A UDT gives you a named, schema-validated composite: `CREATE TYPE address (street text, city text, zip text)`. It composes — you can have `frozen<list<address>>`, or an address field inside another UDT. Because Cassandra has no joins, nesting structure inside a partition is not a modelling smell here; it is the intended approach.

The problem UDFs and UDAs solve is *round trips*. Computing `max(temperature)` over 10,000 sensor readings by shipping all 10,000 rows to a client is wasteful when the coordinator already has them in memory. A UDA lets you push that computation to the coordinator. But note *coordinator*, not replica: unlike a MapReduce system, Cassandra's aggregation happens on one node after data arrives, so it saves network to the client but does nothing to reduce the fundamental read cost. `SELECT avg(x) FROM huge_table` is still a full cluster scan that happens to return one row.

The security story is the reason these features feel half-finished. A Java UDF is compiled and executed **inside the Cassandra JVM**, in the coordinator's request path. A buggy UDF can throw, allocate unboundedly, spin forever, or — before hardening — call `System.exit()`. Cassandra 3.0 added a security-manager sandbox and a `Runnable` timeout (`user_defined_function_fail_timeout`), and Cassandra 4.1 removed the JavaScript engine entirely (CASSANDRA-17280) because Nashorn was deprecated and the scripting surface was indefensible. In Cassandra 5.0 the Java security manager itself is deprecated in the JDK, so UDF sandboxing is again under active redesign. `enable_user_defined_functions` defaults to **false** for good reason.

A concrete example: an IoT platform stores sensor readings with `location frozen<geo_point>` (a UDT of lat/lon/accuracy) and uses a UDA `avg_state` to compute rolling averages per device per hour directly on the coordinator, avoiding shipping 3,600 rows per query to a Python service. The UDT is used everywhere; the UDA is used only inside bounded single-partition queries, which is the only place it is safe.

## 2. Core Concepts

- **UDT (user-defined type)** — a named composite type created with `CREATE TYPE`, scoped to a keyspace, usable as a column type or nested inside collections and other UDTs.
- **`frozen`** — a modifier meaning "serialise the whole value as one opaque blob". A frozen UDT can only be replaced wholesale, never field-by-field, and can be part of a primary key.
- **Non-frozen UDT** — since Cassandra 3.6, a top-level UDT column can be non-frozen, allowing `UPDATE t SET addr.city = 'Pune'` on individual fields. UDTs inside collections must still be frozen.
- **UDF (user-defined function)** — a scalar function written in Java, registered with `CREATE FUNCTION`, executed per row on the coordinator during result assembly.
- **`CALLED ON NULL INPUT` / `RETURNS NULL ON NULL INPUT`** — mandatory null-handling declaration. The latter short-circuits and never invokes the body when any argument is null.
- **UDA (user-defined aggregate)** — a `(STYPE, SFUNC, FINALFUNC, INITCOND)` tuple: a state type, a state-transition UDF applied per row, an optional final UDF, and an initial state.
- **`SFUNC`** — the state function, invoked as `sfunc(state, column_value)` for each row, returning the new state. Must accept `STYPE` as its first argument.
- **UDF sandbox** — the security manager plus a whitelist of permitted packages (`java.lang`, `java.math`, `java.nio`, `java.util`, `java.time`, `org.apache.cassandra.cql3.functions.types`); everything else — reflection, IO, threads, class loading — is denied.
- **`user_defined_function_fail_timeout`** — 1,500 ms default; a UDF exceeding it triggers the configured `user_function_timeout_policy` (`die`, `die_immediate`, or `ignore`).
- **Deterministic requirement** — UDFs must be pure and deterministic; Cassandra may invoke them any number of times and caches nothing, and non-determinism breaks read repair comparisons if used in a materialised context.

## 3. Theory & Internals

**UDT storage.** A frozen UDT is serialised as a single cell value: a length-prefixed concatenation of its fields in declaration order, with a 4-byte length per field (`-1` for null). That is why the whole value must be rewritten to change one field — the cell is atomic. It is also why frozen UDTs are safe in primary keys: the byte representation is stable and comparable.

A **non-frozen** UDT is stored completely differently: each field becomes its own cell with its own write timestamp, exactly like a `map<field_id, value>`. This gives per-field last-write-wins (two clients updating different fields both survive) and enables `SET addr.city = ?`. It costs more storage (per-cell overhead per field) and, critically, **overwriting a whole non-frozen UDT writes a range tombstone** covering the old fields before writing new ones — the same tombstone hazard as collections. Adding a field to a UDT (`ALTER TYPE address ADD country text`) is a metadata-only operation; existing rows simply have no cell for the new field and read back null.

**Type-system rules that trip people up.** Any UDT used inside a collection must be frozen (`list<frozen<address>>`), because collection elements are single cells. A frozen collection or UDT can be part of a partition key or clustering key; a non-frozen one cannot. You cannot drop a type still referenced by a table, and you cannot remove a field from a UDT at all — only add.

**UDF execution.** `CREATE FUNCTION` stores the source in `system_schema.functions` and propagates it via schema gossip; each node compiles it at load time with the embedded Java compiler into a class implementing `JavaUDF`. Execution happens on the **coordinator**, inside `ResultSetBuilder`, after rows are reconciled and before they are serialised to the client. Each invocation is wrapped in an `Executor` with a watchdog: if the call exceeds `user_defined_function_warn_timeout` (500 ms) it logs; past `user_defined_function_fail_timeout` (1,500 ms) the `user_function_timeout_policy` applies — and the default `die` will **shut the node down**, on the theory that a runaway UDF holding a request thread is worse than a missing node.

The sandbox is a `SecurityManager` with a whitelist. Denied: `java.io`, `java.net`, `java.lang.reflect`, `Thread`, `ClassLoader`, `System.exit`, and any third-party package. This blocks the obvious attacks but not resource exhaustion: an allocation-heavy UDF can still trigger a full GC on a coordinator serving unrelated traffic, and `while(true){}` in a non-interruptible loop cannot always be stopped by the watchdog.

```svg
<svg viewBox="0 0 720 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="720" height="330" fill="#ffffff"/>
  <text x="360" y="24" text-anchor="middle" font-size="15" font-weight="600" fill="#1e293b">Frozen vs non-frozen UDT storage</text>
  <rect x="20" y="46" width="320" height="130" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="180" y="68" text-anchor="middle" font-size="12" font-weight="600" fill="#1e293b">frozen&#60;address&#62;  &#8594;  ONE cell</text>
  <rect x="40" y="82" width="280" height="30" rx="4" fill="#ffffff" stroke="#4f46e5" stroke-width="1"/>
  <text x="180" y="102" text-anchor="middle" font-size="10" fill="#1e293b">[len]street [len]city [len]zip   ts=1785000123456789</text>
  <text x="180" y="132" text-anchor="middle" font-size="11" fill="#1e293b">Replace whole value only. Legal in a primary key.</text>
  <text x="180" y="154" text-anchor="middle" font-size="11" fill="#1e293b">Compact on disk, one timestamp for all fields.</text>
  <rect x="380" y="46" width="320" height="130" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="540" y="68" text-anchor="middle" font-size="12" font-weight="600" fill="#1e293b">address (non-frozen)  &#8594;  cell per field</text>
  <rect x="400" y="80" width="86" height="26" rx="4" fill="#ffffff" stroke="#0ea5e9" stroke-width="1"/>
  <text x="443" y="97" text-anchor="middle" font-size="10" fill="#1e293b">street ts=100</text>
  <rect x="492" y="80" width="86" height="26" rx="4" fill="#ffffff" stroke="#0ea5e9" stroke-width="1"/>
  <text x="535" y="97" text-anchor="middle" font-size="10" fill="#1e293b">city ts=142</text>
  <rect x="584" y="80" width="96" height="26" rx="4" fill="#ffffff" stroke="#0ea5e9" stroke-width="1"/>
  <text x="632" y="97" text-anchor="middle" font-size="10" fill="#1e293b">zip ts=100</text>
  <text x="540" y="132" text-anchor="middle" font-size="11" fill="#1e293b">UPDATE t SET addr.city = ? works. Per-field LWW.</text>
  <text x="540" y="154" text-anchor="middle" font-size="11" fill="#1e293b">Whole-value overwrite writes a range tombstone first.</text>
  <rect x="20" y="196" width="680" height="46" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="360" y="216" text-anchor="middle" font-size="11" font-weight="600" fill="#1e293b">Rule: any UDT inside a collection MUST be frozen. list&#60;frozen&#60;address&#62;&#62;</text>
  <text x="360" y="234" text-anchor="middle" font-size="11" fill="#1e293b">Only frozen values may appear in a partition or clustering key.</text>
  <rect x="20" y="256" width="680" height="46" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="360" y="276" text-anchor="middle" font-size="11" font-weight="600" fill="#1e293b">ALTER TYPE address ADD country text  &#8594;  metadata only, old rows read null</text>
  <text x="360" y="294" text-anchor="middle" font-size="11" fill="#1e293b">Fields can never be removed or reordered. Design UDTs as append-only.</text>
</svg>
```

**UDA execution.** A UDA is state folding. Cassandra initialises `state = INITCOND`, then for every row in the result set calls `state = SFUNC(state, value)`, and finally returns `FINALFUNC(state)` (or `state` if no final function). All of this happens **on the coordinator, single-threaded, after the rows arrive**. There is no partial aggregation on replicas and no parallelism. Therefore a UDA over a multi-partition query is a full scan with the network savings of returning one row — the read cost is unchanged. Aggregates are only a good idea when the underlying query is already a bounded single-partition read.

Cassandra 5.0 note: native aggregates (`count`, `min`, `max`, `sum`, `avg`) follow exactly the same coordinator-side model, so the same warning applies to `SELECT count(*)`.

## 4. Architecture & Workflow

Trace a schema change, a write, and an aggregated read:

1. **`CREATE TYPE` executes.** The coordinator validates field names and types, writes the definition into `system_schema.types`, and bumps the schema version.
2. **Schema gossip.** The new schema version propagates via gossip; every node pulls the delta and rebuilds its in-memory `KeyspaceMetadata`. `nodetool describecluster` shows a single schema version once converged — a split here means a node missed the change.
3. **Driver metadata refresh.** Clients receive a `SCHEMA_CHANGE` event on the control connection and refresh their type codecs, so the UDT deserialises into a Python `namedtuple` or a Java `UdtValue`.
4. **`CREATE FUNCTION` executes.** The source is stored in `system_schema.functions`, gossiped, and each node compiles it locally into a `JavaUDF` subclass. A compilation error on one node means that node cannot serve queries using it.
5. **Write with a frozen UDT.** The driver serialises the UDT to its byte layout client-side using the schema metadata, and the coordinator stores it as one opaque cell — it never introspects the fields.
6. **Write to a non-frozen UDT field.** `UPDATE t SET addr.city = ?` sends a mutation targeting the sub-cell for `city` only, with its own timestamp; the other fields are untouched.
7. **Read with a UDA.** `SELECT avg_temp(reading) FROM sensor_data WHERE device_id = ? AND day = ?` routes as a normal single-partition read; replicas return raw rows.
8. **Coordinator folds.** After digest reconciliation, the coordinator initialises state from `INITCOND` and calls `SFUNC` once per row, each call guarded by the UDF watchdog and sandbox.
9. **Final function.** `FINALFUNC` converts the accumulator (e.g. a `tuple<bigint,int>` of sum and count) into the result type, and one row is serialised to the client.
10. **Timeout path.** If any single `SFUNC` invocation exceeds `user_defined_function_fail_timeout`, the policy fires — with the default `die`, the coordinator logs `FATAL` and shuts down, and the client sees the connection drop.

```svg
<svg viewBox="0 0 720 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="720" height="320" fill="#ffffff"/>
  <text x="360" y="24" text-anchor="middle" font-size="15" font-weight="600" fill="#1e293b">UDA folding happens on the coordinator, after the read</text>
  <rect x="20" y="52" width="120" height="150" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="80" y="74" text-anchor="middle" font-size="12" font-weight="600" fill="#1e293b">Replicas</text>
  <text x="80" y="98" text-anchor="middle" font-size="10" fill="#1e293b">merge memtable</text>
  <text x="80" y="114" text-anchor="middle" font-size="10" fill="#1e293b">+ SSTables</text>
  <text x="80" y="140" text-anchor="middle" font-size="10" fill="#1e293b">return RAW rows</text>
  <text x="80" y="164" text-anchor="middle" font-size="10" fill="#1e293b">no aggregation</text>
  <text x="80" y="180" text-anchor="middle" font-size="10" fill="#1e293b">happens here</text>
  <path d="M144 128 L192 128" stroke="#16a34a" stroke-width="2" fill="none"/>
  <path d="M192 128 l-9 -5 v10 z" fill="#16a34a"/>
  <rect x="198" y="52" width="300" height="200" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="348" y="74" text-anchor="middle" font-size="12" font-weight="600" fill="#1e293b">Coordinator JVM</text>
  <rect x="216" y="86" width="264" height="26" rx="4" fill="#ffffff" stroke="#4f46e5" stroke-width="1"/>
  <text x="348" y="104" text-anchor="middle" font-size="10" fill="#1e293b">state = INITCOND  (0, 0)</text>
  <rect x="216" y="118" width="264" height="26" rx="4" fill="#ffffff" stroke="#4f46e5" stroke-width="1"/>
  <text x="348" y="136" text-anchor="middle" font-size="10" fill="#1e293b">row 1 &#8594; state = SFUNC(state, 21.4)</text>
  <rect x="216" y="150" width="264" height="26" rx="4" fill="#ffffff" stroke="#4f46e5" stroke-width="1"/>
  <text x="348" y="168" text-anchor="middle" font-size="10" fill="#1e293b">row N &#8594; state = SFUNC(state, 22.9)</text>
  <rect x="216" y="182" width="264" height="26" rx="4" fill="#ffffff" stroke="#4f46e5" stroke-width="1"/>
  <text x="348" y="200" text-anchor="middle" font-size="10" fill="#1e293b">result = FINALFUNC(state)</text>
  <text x="348" y="230" text-anchor="middle" font-size="10" fill="#1e293b">single-threaded, watchdog per call</text>
  <path d="M502 152 L548 152" stroke="#4f46e5" stroke-width="2" fill="none"/>
  <path d="M548 152 l-9 -5 v10 z" fill="#4f46e5"/>
  <rect x="554" y="112" width="146" height="80" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="627" y="136" text-anchor="middle" font-size="12" font-weight="600" fill="#1e293b">Client</text>
  <text x="627" y="158" text-anchor="middle" font-size="11" fill="#1e293b">1 row returned</text>
  <text x="627" y="178" text-anchor="middle" font-size="10" fill="#1e293b">N rows still read!</text>
  <rect x="20" y="266" width="680" height="42" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="360" y="284" text-anchor="middle" font-size="11" font-weight="600" fill="#1e293b">Aggregates save network to the client. They do NOT reduce read cost.</text>
  <text x="360" y="301" text-anchor="middle" font-size="11" fill="#1e293b">Use them only on bounded single-partition queries; a UDF timeout can kill the coordinator.</text>
</svg>
```

## 5. Implementation

```cql
CREATE KEYSPACE iot WITH replication = {
  'class': 'NetworkTopologyStrategy', 'us_east': 3, 'eu_west': 3};
USE iot;

CREATE TYPE geo_point (lat double, lon double, accuracy_m float);
CREATE TYPE address   (street text, city text, region text, zip text);

CREATE TABLE devices (
  device_id  uuid PRIMARY KEY,
  label      text,
  install_at frozen<address>,        -- frozen: replaced wholesale
  last_seen  geo_point,              -- non-frozen (3.6+): per-field updates
  tags       set<text>,
  waypoints  list<frozen<geo_point>> -- MUST be frozen inside a collection
);

CREATE TABLE sensor_data (
  device_id uuid, day date, ts timestamp,
  reading double, position frozen<geo_point>,
  PRIMARY KEY ((device_id, day), ts)
) WITH CLUSTERING ORDER BY (ts DESC);
```

Working with UDTs:

```cql
INSERT INTO devices (device_id, label, install_at, last_seen, waypoints) VALUES (
  6f1c2d10-6a1c-11f0-9c3d-0242ac120002, 'gw-mumbai-04',
  {street: '12 Marine Dr', city: 'Mumbai', region: 'MH', zip: '400020'},
  {lat: 18.9432, lon: 72.8231, accuracy_m: 4.5},
  [{lat: 18.94, lon: 72.82, accuracy_m: 9.0}]
);

-- Non-frozen: update ONE field. Only legal because last_seen is not frozen.
UPDATE devices SET last_seen.accuracy_m = 2.1 WHERE device_id = 6f1c2d10-6a1c-11f0-9c3d-0242ac120002;

-- Frozen: this is REJECTED
UPDATE devices SET install_at.city = 'Pune' WHERE device_id = ...;
-- InvalidRequest: Invalid operation (install_at.city = 'Pune') for frozen UDT column install_at

-- Frozen must be replaced whole
UPDATE devices SET install_at = {street:'9 FC Rd', city:'Pune', region:'MH', zip:'411004'}
 WHERE device_id = ...;

ALTER TYPE geo_point ADD altitude_m double;   -- metadata only; old rows read null
-- ALTER TYPE ... DROP  -> not supported. UDTs are append-only.

SELECT label, install_at.city, last_seen FROM devices WHERE device_id = ...;
--  label        | install_at.city | last_seen
-- --------------+-----------------+---------------------------------------------------
--  gw-mumbai-04 | Pune            | {lat: 18.9432, lon: 72.8231, accuracy_m: 2.1, ...}
```

Enable and define UDFs (disabled by default):

```yaml
# cassandra.yaml  -- restart required
user_defined_functions_enabled: true          # 4.x name; 3.x: enable_user_defined_functions
user_defined_functions_threads_enabled: false
user_defined_function_warn_timeout: 500ms
user_defined_function_fail_timeout: 1500ms
user_function_timeout_policy: die             # die | die_immediate | ignore
# scripted_user_defined_functions_enabled removed in 4.1 (CASSANDRA-17280) - Java only
```

```cql
CREATE OR REPLACE FUNCTION iot.c_to_f (celsius double)
  RETURNS NULL ON NULL INPUT
  RETURNS double
  LANGUAGE java
  AS 'return celsius * 9.0 / 5.0 + 32.0;';

CREATE OR REPLACE FUNCTION iot.haversine_km (a geo_point, b geo_point)
  RETURNS NULL ON NULL INPUT
  RETURNS double
  LANGUAGE java
  AS $$
    double la1 = a.getDouble("lat"), lo1 = a.getDouble("lon");
    double la2 = b.getDouble("lat"), lo2 = b.getDouble("lon");
    double dLa = Math.toRadians(la2 - la1), dLo = Math.toRadians(lo2 - lo1);
    double h = Math.sin(dLa/2)*Math.sin(dLa/2)
             + Math.cos(Math.toRadians(la1))*Math.cos(Math.toRadians(la2))
             * Math.sin(dLo/2)*Math.sin(dLo/2);
    return 6371.0 * 2 * Math.asin(Math.sqrt(h));
  $$;

SELECT ts, reading, c_to_f(reading) AS fahrenheit
  FROM sensor_data WHERE device_id = ? AND day = '2026-07-22' LIMIT 5;
--  ts                       | reading | fahrenheit
-- --------------------------+---------+------------
--  2026-07-22 11:04:00+0000 |   21.40 |     70.520
```

A complete UDA — average with a tuple accumulator:

```cql
CREATE OR REPLACE FUNCTION iot.avg_state (state tuple<double,bigint>, val double)
  CALLED ON NULL INPUT
  RETURNS tuple<double,bigint>
  LANGUAGE java
  AS $$
    if (val == null) return state;
    state.setDouble(0, state.getDouble(0) + val);
    state.setLong(1, state.getLong(1) + 1L);
    return state;
  $$;

CREATE OR REPLACE FUNCTION iot.avg_final (state tuple<double,bigint>)
  CALLED ON NULL INPUT
  RETURNS double
  LANGUAGE java
  AS 'if (state.getLong(1) == 0L) return null; return state.getDouble(0) / state.getLong(1);';

CREATE OR REPLACE AGGREGATE iot.rolling_avg (double)
  SFUNC     avg_state
  STYPE     tuple<double,bigint>
  FINALFUNC avg_final
  INITCOND  (0.0, 0);

-- SAFE: bounded, single partition
SELECT rolling_avg(reading) FROM sensor_data
 WHERE device_id = 6f1c2d10-6a1c-11f0-9c3d-0242ac120002 AND day = '2026-07-22';
--  iot.rolling_avg(reading)
-- --------------------------
--                    21.873

-- DANGEROUS: full cluster scan that returns one row
SELECT rolling_avg(reading) FROM sensor_data;   -- do not do this in production
```

Python driver — UDTs map to classes automatically:

```python
from cassandra.cluster import Cluster
from collections import namedtuple

session = Cluster(["10.0.1.11"]).connect("iot")

GeoPoint = namedtuple("GeoPoint", ["lat", "lon", "accuracy_m", "altitude_m"])
session.cluster.register_user_type("iot", "geo_point", GeoPoint)

ins = session.prepare(
  "INSERT INTO sensor_data (device_id, day, ts, reading, position) VALUES (?,?,?,?,?)")
session.execute(ins, (dev, day, ts, 21.4, GeoPoint(18.9432, 72.8231, 4.5, 11.0)))

row = session.execute(
  "SELECT position FROM sensor_data WHERE device_id=%s AND day=%s LIMIT 1", (dev, day)).one()
print(row.position.lat, row.position.accuracy_m)   # 18.9432 4.5
```

Java — explicit `UdtValue` construction:

```java
UserDefinedType geo = session.getMetadata().getKeyspace("iot").flatMap(ks -> ks.getUserDefinedType("geo_point")).orElseThrow();
UdtValue p = geo.newValue().setDouble("lat", 18.9432).setDouble("lon", 72.8231).setFloat("accuracy_m", 4.5f);
session.execute(insert.bind(deviceId, day, Instant.now(), 21.4, p));
```

Inspect and secure:

```cql
SELECT type_name, field_names, field_types FROM system_schema.types WHERE keyspace_name='iot';
SELECT function_name, argument_types, language, called_on_null_input
  FROM system_schema.functions WHERE keyspace_name='iot';

CREATE ROLE analytics WITH LOGIN = true AND PASSWORD = '...';
GRANT EXECUTE ON FUNCTION iot.rolling_avg(double) TO analytics;   -- least privilege
REVOKE CREATE ON ALL FUNCTIONS IN KEYSPACE iot FROM analytics;
```

> **Optimization:** prefer frozen UDTs unless you genuinely need per-field updates. A frozen UDT is one cell — one timestamp, one bloom-filter entry's worth of overhead, no range tombstone on overwrite. A non-frozen UDT with 8 fields is 8 cells per row, and rewriting it whole emits a range tombstone every time. On a 500-million-row table that difference is tens of gigabytes and a measurable change in `SSTablesPerReadHistogram`.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| UDT (frozen) | Named, validated structure in one compact cell; usable in primary keys | Whole-value rewrite on any change; cannot filter or index individual fields |
| UDT (non-frozen) | Per-field updates and per-field last-write-wins | One cell per field; whole-value overwrite emits a range tombstone; illegal in keys and collections |
| Schema evolution | `ALTER TYPE ... ADD` is metadata-only and instant | Fields can never be removed or reordered — UDTs are append-only forever |
| UDF | Push per-row computation to the server, avoid a client round trip | Runs in the coordinator JVM; a timeout can shut the node down under the default policy |
| UDA | Return one row instead of a million; expressive server-side folding | Executes single-threaded on the coordinator after the full read — no reduction in read cost |
| Java-only (4.1+) | Removes the indefensible Nashorn scripting surface | No lightweight scripting option; every function needs Java and a schema change to modify |
| Sandbox | Blocks IO, reflection, threads, class loading | Does not bound memory or CPU; an allocating UDF still causes GC pressure for other queries |
| Permissions | `GRANT EXECUTE ON FUNCTION` gives least-privilege control | `CREATE FUNCTION` is effectively remote code execution — guard it like `sudo` |

## 7. Common Mistakes & Best Practices

1. ⚠️ Assuming you can query or index a UDT field: `WHERE install_at.city = 'Pune'`. → ✅ Not supported (a frozen UDT is one opaque blob). Denormalize the field into its own column, or into a table keyed by it.
2. ⚠️ Using a non-frozen UDT everywhere because "it's more flexible". → ✅ Default to frozen. Non-frozen costs a cell per field and emits a range tombstone on whole-value overwrite; use it only when per-field updates are a real requirement.
3. ⚠️ Forgetting `frozen` inside a collection. → ✅ `list<address>` is rejected; it must be `list<frozen<address>>`. Same for sets, maps, and tuples containing UDTs.
4. ⚠️ Planning to remove a UDT field later. → ✅ `ALTER TYPE ... DROP` does not exist. Treat UDTs as append-only; if you must remove a field, create a new type and migrate.
5. ⚠️ Running an aggregate over an unbounded query: `SELECT avg(reading) FROM sensor_data`. → ✅ That is a full cluster scan returning one row. Restrict to one partition, or precompute aggregates with a counter/rollup table or Spark.
6. ⚠️ Leaving `user_function_timeout_policy: die` while shipping unaudited UDFs. → ✅ Understand what `die` means: a slow UDF shuts down the coordinator. Either audit every UDF rigorously or set `ignore` and monitor — but never ship untested UDFs to production.
7. ⚠️ Granting `CREATE FUNCTION` broadly. → ✅ It is remote code execution inside the database JVM. Restrict it to a break-glass admin role, deploy functions through schema migrations in version control, and `GRANT EXECUTE` narrowly.
8. ⚠️ Writing non-deterministic UDFs (using `System.currentTimeMillis()`, randomness, mutable static state). → ✅ UDFs must be pure. Cassandra may call them any number of times per row across retries and read repairs; non-determinism produces irreproducible results.
9. ⚠️ Allocating large objects inside a UDF body. → ✅ The sandbox does not bound memory. Per-row allocation of even a few KB across a million-row aggregate produces GC pauses that affect every query on that coordinator.
10. ⚠️ Assuming a `CALLED ON NULL INPUT` function handles nulls for you. → ✅ It does the opposite: it invokes the body *with* nulls, so you must null-check explicitly. Use `RETURNS NULL ON NULL INPUT` unless the null case is meaningful (it always is for a UDA state function).
11. ⚠️ Changing a UDF body with `CREATE OR REPLACE` during peak traffic. → ✅ It is a schema change that gossips cluster-wide and forces recompilation on every node; in-flight queries can see either version. Do it in a maintenance window with `nodetool describecluster` verifying schema agreement afterwards.
12. ⚠️ Storing a large UDT (megabyte-scale nested structure) in one column. → ✅ A frozen UDT is one cell read and written in full every time; keep them small and consider whether the nested data belongs in its own clustering rows.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Schema disagreement is the number-one UDT/UDF failure: `nodetool describecluster` must show one schema version. If a node reports a different version, it may lack the type or have failed to compile the function, and queries routed there fail with `InvalidRequest: Unknown type` or a compilation stack trace in `system.log`. Introspect definitions with `SELECT * FROM system_schema.types` and `system_schema.functions`, or `DESCRIBE TYPE iot.geo_point` in cqlsh. For UDF failures, grep `system.log` for `UDF` and `execution failed`; the compiler error includes the generated class source, which is usually enough to spot a sandbox violation (`java.io.FileNotFoundException` and `AccessControlException` are the classic signatures).

**Monitoring.** Watch `org.apache.cassandra.metrics:type=ClientRequest,scope=Read,name=Latency` on coordinators running UDAs — the fold is single-threaded and shows up as coordinator-local latency with normal replica latency, a distinctive signature. Track JVM `GC` pause time and old-gen occupancy on the coordinator pool, because UDF allocation pressure lands there first. Grep for `WARN ... exceeded the configured warn timeout` lines from the UDF watchdog; treat any occurrence as an incident precursor since the fail threshold is only 3× the warn threshold. `nodetool tpstats` `ReadStage` pending growth on a specific node while peers are idle usually means a UDA is monopolising that coordinator.

**Security.** Treat `CREATE FUNCTION` as equivalent to shell access on the database host: the sandbox blocks the easy escapes, but the code still runs in-process with the cluster's heap and file descriptors. Concretely: keep `user_defined_functions_enabled: false` unless you need them; grant `CREATE`/`ALTER` on functions only to a deployment role used by migrations; use `GRANT EXECUTE ON FUNCTION ks.fn(types) TO role` for least privilege; never accept function bodies from user input; and audit function DDL with `audit_logging_options` and `included_categories: DDL`. Note the version boundary: JavaScript UDFs were removed in 4.1 (CASSANDRA-17280), so any migration from 3.x/4.0 must rewrite scripted functions in Java. In 5.0, with the JDK security manager deprecated, review the release notes for the current sandboxing posture before enabling UDFs at all.

**Performance & scaling.** UDTs scale exactly like the cells they compile to — frozen is one cell, non-frozen is one per field — so the scaling question is really a storage-overhead question; measure with `nodetool tablestats` average cell count per partition. UDAs do not scale: aggregation is coordinator-local and single-threaded, so throughput is bounded by one node's CPU regardless of cluster size. The correct scaling path for aggregation is precomputation — write rollup rows at ingest time, use counters for additive metrics, or run Spark against an analytics DC. Reserve UDAs for interactive, bounded, single-partition queries where the alternative is shipping thousands of rows to a client.

## 9. Interview Questions

**Q: What does `frozen` mean on a UDT?**
A: It means the entire value is serialised into a single cell, so it can only be replaced wholesale — you cannot update one field. In exchange it is compact, has one write timestamp, and is legal in a primary key. Non-frozen UDTs store one cell per field and support per-field updates.

**Q: Can you index or filter on a field inside a UDT?**
A: Not on a frozen UDT — it is one opaque blob to the storage engine, so `WHERE addr.city = ?` is not supported. The correct approach is to denormalize the field into its own column or a table keyed by it. (SAI in 5.0 indexes columns, not UDT sub-fields.)

**Q: Where does a UDA actually execute?**
A: On the coordinator, single-threaded, after all rows have been read from replicas and reconciled. Replicas perform no partial aggregation. The aggregate therefore reduces bytes returned to the client but does nothing to reduce the cost of the underlying read.

**Q: Why are UDFs disabled by default?**
A: Because they execute arbitrary Java inside the Cassandra JVM on the coordinator's request path. The sandbox blocks IO, reflection, and threads, but not CPU or memory exhaustion, and the default timeout policy `die` will shut the node down if a UDF runs too long. Enabling them is a deliberate security decision.

**Q: What are `SFUNC`, `STYPE`, `FINALFUNC` and `INITCOND`?**
A: The four parts of a UDA: `STYPE` is the accumulator type, `INITCOND` its starting value, `SFUNC(state, value)` is called once per row to fold the value into the state, and `FINALFUNC(state)` optionally converts the accumulator into the returned type. An average, for example, uses a `tuple<double,bigint>` state and divides in the final function.

**Q: What is the difference between `CALLED ON NULL INPUT` and `RETURNS NULL ON NULL INPUT`?**
A: `RETURNS NULL ON NULL INPUT` short-circuits — if any argument is null the function returns null without executing the body. `CALLED ON NULL INPUT` invokes the body with the nulls, so you must handle them yourself. UDA state functions almost always need the latter, because the initial state or an individual value may be null.

**Q: (Senior) You need per-field updates on a UDT but are worried about tombstones. Walk through the trade-off.**
A: A non-frozen UDT stores one cell per field, so `SET addr.city = ?` writes exactly one cell with its own timestamp and produces no tombstone — that is the good path. The hazard is the *whole-value* assignment `SET addr = {...}`, which must first shadow every existing field and therefore emits a range tombstone before writing the new cells, exactly like overwriting a collection. If your workload does both patterns, you get tombstone accumulation you did not expect. The mitigation is to standardise on one access pattern per column: either always field-level updates on a non-frozen UDT, or always frozen with whole-value replacement.

**Q: (Senior) A UDA query is slow and the replicas show normal latency. What's happening and how do you confirm it?**
A: The fold is coordinator-local and single-threaded, so the time is being spent in `SFUNC` invocations after the data arrives. Confirm by comparing `ClientRequest` read latency (high) against per-replica `Table` local read latency (normal) on the same query, and by checking `nodetool tpstats` for `ReadStage` backlog on that one coordinator while peers are idle. Enable tracing to see the gap between the last replica response and the response to the client. The fix is to precompute the aggregate at write time, not to tune the UDF.

**Q: (Senior) You are migrating a 3.11 cluster with JavaScript UDFs to 4.1. What breaks and what is your plan?**
A: JavaScript UDF support was removed in 4.1 by CASSANDRA-17280 (Nashorn was deprecated and removed from the JDK), so every `LANGUAGE javascript` function must be rewritten in Java before the upgrade or the schema will fail to load on the upgraded nodes. The plan: inventory `system_schema.functions WHERE language='javascript'`, port each to Java with equivalent null-handling declarations, deploy them under new names on 3.11 first, migrate all callers, drop the JavaScript versions, verify schema agreement with `nodetool describecluster`, and only then begin the rolling upgrade. Also re-evaluate whether the functions are needed at all — many are better as client-side or precomputed logic.

**Q: Can you add or remove a field from a UDT?**
A: You can add with `ALTER TYPE ... ADD`, which is a metadata-only change — existing rows simply read null for the new field. You cannot remove or reorder fields; UDTs are append-only. If a field must go, create a new type and migrate the data.

**Q: How do you restrict who can create and run functions?**
A: Keep `user_defined_functions_enabled: false` unless required, restrict `CREATE`/`ALTER` on functions to a deployment role, and use `GRANT EXECUTE ON FUNCTION ks.fn(argtypes) TO role` to give each application only the functions it needs. Deploy function DDL through version-controlled migrations, never ad-hoc.

**Q: When should you use a UDT versus a separate table?**
A: Use a UDT when the nested data is always read and written together with its parent row and is small — an address, a geo point, a money amount with currency. Use a separate table (or clustering rows) when the nested items are numerous, individually queryable, or independently updated, because a UDT gives you no way to filter, index, or page into its contents.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** UDTs give CQL nested structure: frozen means one cell replaced wholesale and legal in a primary key, non-frozen (3.6+) means one cell per field with per-field updates but a range tombstone on whole-value overwrite, and any UDT inside a collection must be frozen. UDTs are append-only — you can add fields, never remove them — and you cannot filter or index into their fields. UDFs are Java scalars that run in the coordinator JVM behind a package whitelist and a 1.5-second watchdog whose default policy shuts the node down; they are disabled by default and JavaScript was removed in 4.1. UDAs fold a UDF over the result set on the coordinator, single-threaded, after the read completes — so they save client bandwidth but never read cost, and belong only on bounded single-partition queries.

| Item | Value / Command |
|---|---|
| Create a type | `CREATE TYPE ks.address (street text, city text, zip text);` |
| Frozen column | `install_at frozen<address>` — one cell, key-legal |
| Non-frozen column | `last_seen address` (3.6+) — cell per field |
| Inside a collection | `list<frozen<address>>` — frozen is mandatory |
| Field update | `UPDATE t SET last_seen.lat = ?` (non-frozen only) |
| Evolve a type | `ALTER TYPE address ADD country text;` (add only) |
| Enable UDFs | `user_defined_functions_enabled: true` (restart) |
| UDF timeouts | warn `500ms`, fail `1500ms`, policy `die` |
| UDF languages | Java only (JavaScript removed in 4.1, CASSANDRA-17280) |
| Null handling | `RETURNS NULL ON NULL INPUT` \| `CALLED ON NULL INPUT` |
| Create aggregate | `SFUNC` / `STYPE` / `FINALFUNC` / `INITCOND` |
| Inspect definitions | `system_schema.types`, `system_schema.functions`, `system_schema.aggregates` |
| Least privilege | `GRANT EXECUTE ON FUNCTION ks.fn(double) TO role;` |
| Schema agreement | `nodetool describecluster` → one schema version |

**Flash cards**
- **What does `frozen` change?** → The UDT becomes one opaque cell: whole-value replacement only, but legal in a primary key.
- **Can you `WHERE` on a UDT field?** → No. Denormalize the field into its own column or table.
- **Where does a UDA run?** → Single-threaded on the coordinator, after all rows are read — no replica-side aggregation.
- **What is the default UDF timeout policy?** → `die` at 1,500 ms: the coordinator shuts itself down.
- **Can you drop a UDT field?** → Never. `ALTER TYPE` only adds; UDTs are append-only.

## 11. Hands-On Exercises & Mini Project

- [ ] Create a `frozen<address>` column and a non-frozen one; update a single field on each and record which succeeds. Then `sstabledump` both partitions and count the cells written per row.
- [ ] Run `ALTER TYPE address ADD country text` on a table with existing rows and confirm old rows read `null` for the new field with no rewrite (check `nodetool tablestats` space before/after).
- [ ] Enable UDFs, write `c_to_f`, and then deliberately write a UDF that sleeps 3 seconds; observe the warn and fail log lines and what `user_function_timeout_policy: die` does to the node (do this on a throwaway cluster).
- [ ] Implement the `rolling_avg` UDA, then compare `SELECT rolling_avg(reading) WHERE device_id=? AND day=?` against `SELECT rolling_avg(reading) FROM sensor_data` with `TRACING ON` — record rows scanned in both cases.
- [ ] Write a UDF that attempts `new java.io.File("/etc/passwd").exists()` and capture the exact sandbox exception from `system.log`.

**Mini Project — an IoT telemetry model with server-side enrichment**

*Goal:* build a telemetry store using UDTs for structure and a UDA for interactive rollups, with an explicit safety boundary around both.

*Requirements:*
- `geo_point` and `device_meta` UDTs; a `devices` table using one frozen and one non-frozen UDT column, and a `sensor_data((device_id, day), ts)` table with `frozen<geo_point>`.
- A `haversine_km(geo_point, geo_point)` UDF and a `rolling_avg(double)` UDA with a `tuple<double,bigint>` state, deployed via a version-controlled `.cql` migration file.
- An API method returning `{avg_reading, distance_travelled_km}` for one device-day using exactly one query, and a guard in code asserting a partition key is always bound.
- A benchmark comparing server-side `rolling_avg` against fetching all rows and averaging client-side, at 100 / 10,000 / 100,000 rows per partition — report latency and coordinator CPU.
- Security config: `user_defined_functions_enabled: true`, `GRANT EXECUTE` only to the app role, `CREATE FUNCTION` revoked from it, and an audit-log grep proving no ad-hoc function DDL occurred.

*Extensions:* add a rollup table written at ingest time and compare it against the UDA at 1M rows; measure the storage delta between frozen and non-frozen variants of the same UDT with `nodetool tablestats`; attempt a JavaScript UDF and document the 4.1 rejection.

## 12. Related Topics & Free Learning Resources

Read with **13 · CQL: SELECT, INSERT, UPDATE & DELETE** for the cell model that frozen versus non-frozen storage is built on, **15 · TTL, Counters & Static Columns** for the counter-based alternative to server-side aggregation, and **16 · Paging, ALLOW FILTERING & Query Limits** for why an unbounded `SELECT avg(...)` is the same hazard as `ALLOW FILTERING`. Collection-type and schema-evolution chapters cover the neighbouring rules.

- **CQL: User-Defined Types** — Apache Cassandra Documentation · *Intermediate* · normative rules for `CREATE TYPE`, freezing, nesting, and `ALTER TYPE`. <https://cassandra.apache.org/doc/latest/cassandra/developing/cql/types.html#udts>
- **CQL: Functions and Aggregates** — Apache Cassandra Documentation · *Advanced* · `CREATE FUNCTION`/`CREATE AGGREGATE` syntax, null-handling modes, and permissions. <https://cassandra.apache.org/doc/latest/cassandra/developing/cql/functions.html>
- **CASSANDRA-7395: User-defined aggregates** — Apache JIRA · *Advanced* · the design thread that defined the SFUNC/STYPE/FINALFUNC model and its coordinator-side execution. <https://issues.apache.org/jira/browse/CASSANDRA-7395>
- **CASSANDRA-17280: Remove scripted UDFs** — Apache JIRA · *Intermediate* · why JavaScript UDFs were removed in 4.1 and what the migration path is. <https://issues.apache.org/jira/browse/CASSANDRA-17280>
- **CASSANDRA-7423: Non-frozen UDTs** — Apache JIRA · *Advanced* · the change that enabled per-field UDT updates and the storage implications. <https://issues.apache.org/jira/browse/CASSANDRA-7423>
- **DataStax: Using User-Defined Types** — DataStax Documentation · *Beginner–Intermediate* · practical examples plus driver-side codec registration for Python and Java. <https://docs.datastax.com/en/cql-oss/3.3/cql/cql_using/useInsertUDT.html>
- **DataStax Java Driver: UDTs and Tuples** — DataStax · *Intermediate* · `UserDefinedType`, `UdtValue`, and custom codecs for mapping UDTs to your own classes. <https://docs.datastax.com/en/developer/java-driver/latest/manual/core/udts/>
- **Cassandra Security Configuration Guide** — Apache Cassandra Documentation · *Advanced* · the authorization model behind `GRANT EXECUTE`, function permissions, and audit logging. <https://cassandra.apache.org/doc/latest/cassandra/managing/operating/security.html>

---

*Apache Cassandra Handbook — chapter 17.*
