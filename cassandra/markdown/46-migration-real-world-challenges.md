# 46 · Migration & Real-World Challenges

> **In one line:** A zero-downtime migration to Cassandra is dual writes plus a timestamp-correct backfill plus shadow-read validation, cut over one read percentage at a time behind a rollback gate you keep open until you are bored of it.

---

## 1. Overview

Nobody starts on Cassandra. They start on Postgres or MySQL, or on MongoDB, and they arrive at Cassandra because a single primary stopped being able to absorb writes, or because a second region became a business requirement. That means almost every real Cassandra project is a *migration* project, and migrations are where the interesting failures live: the schema was right, the cluster was healthy, and the data still ended up wrong because a backfill overwrote live writes with stale values.

The problem this chapter solves is **moving a live, mutating dataset into Cassandra without downtime and without losing correctness**, and doing it in a way you can abandon halfway if it goes badly. The three hard parts are ordering (a backfill and live traffic write the same rows concurrently), verification (proving two datastores agree at scale), and reversibility (staying able to roll back after you have already taken production reads).

The one-line history: early Cassandra migrations were "stop the world, run `sstableloader`, pray." The industry converged on a much better pattern borrowed from the strangler-fig approach to monoliths — run both stores in parallel, shift reads incrementally, and let the old store remain authoritative until the new one has proven itself. DataStax's Zero Downtime Migration proxy productised exactly this shape, and CDC pipelines (Debezium into Kafka) made the dual-write half reliable without touching application code.

**Concrete example.** A payments company has an `orders` service on a 4 TB MySQL primary doing 8,000 writes/sec at peak, with read replicas straining and a second region on the roadmap. The order history table is 2.1 billion rows. They cannot take downtime, they cannot lose an order, and the finance team requires provable reconciliation. The migration ran 11 weeks: two weeks of modelling and shadow schema, one week standing up dual writes through the existing service layer, three weeks of throttled Spark backfill (throttled because the first attempt drove compaction pending-tasks to 4,000 and pushed P99 reads to 900 ms), three weeks of shadow reads at 100% with a diff rate that fell from 0.4% to 0.0001%, and two weeks of read cutover at 1% → 10% → 50% → 100%. MySQL stayed authoritative for another 30 days before anyone typed `DROP TABLE`.

The durable mental model: **the backfill and the live stream are two writers to the same rows, and Cassandra's last-write-wins timestamp is the only referee.** Get the timestamps right and the two commute — you can run them in any order, restart the backfill, and re-run it, and the result is identical. Get them wrong and your backfill silently reverts customer data.

## 2. Core Concepts

- **Dual write** — the application (or a CDC pipeline) writes every mutation to both the old store and Cassandra. The new store starts accumulating live truth immediately, while the old one remains authoritative.
- **Backfill** — a bulk job that copies historical rows into Cassandra, running concurrently with dual writes. Must be idempotent, restartable and rate-limited.
- **`USING TIMESTAMP`** — the CQL clause that sets a write's conflict-resolution timestamp explicitly, in **microseconds since epoch**. The single most important tool in a migration.
- **Shadow read (dark read)** — serving the read from the old store while asynchronously issuing the same read against Cassandra and recording differences. Validation without user risk.
- **Cutover** — the progressive shift of read traffic from old to new, expressed as a percentage behind a feature flag, with an instant revert.
- **Rollback gate** — the period during which the old store still receives writes and can resume serving. It closes only when you stop dual-writing, and it should stay open far longer than feels necessary.
- **CDC (change data capture)** — streaming a relational store's binlog/WAL (Debezium → Kafka) so mutations reach Cassandra without modifying application code.
- **`UNSET_VALUE`** — the driver constant that means "do not write this column." Binding `null` instead writes a **tombstone**, which is how migrations accidentally create billions of them.
- **DC-add migration** — the Cassandra-to-Cassandra pattern: extend `NetworkTopologyStrategy` to a new datacenter, `nodetool rebuild` from the old one, repoint clients, decommission. No dual writes required.
- **Outbox pattern** — writing the business change and an event row in the same source-store transaction, so the CDC stream is exactly as atomic as the source, avoiding "wrote to A but not B" dual-write drift.

## 3. Theory & Internals: why timestamps make it commute

Cassandra resolves conflicting writes to the same cell by **last-write-wins on the cell's timestamp**, with the value's bytes as a deterministic tie-break. Every write carries a timestamp: by default the coordinator's clock in microseconds, or whatever you supply with `USING TIMESTAMP`.

That gives the migration its correctness proof. Let a row's history in the source store be a sequence of versions `v1 @ t1 < v2 @ t2 < ... < vn @ tn`. Two writers race:

```
backfill   writes  v_k  USING TIMESTAMP t_k        (t_k = source updated_at, in micros)
live CDC   writes  v_n  USING TIMESTAMP t_n        (t_n = source commit time, in micros)

Cassandra keeps max-by-timestamp  ->  v_n  whenever  t_n > t_k
```

Because `t_n > t_k` for any live write that happened after the backfilled version, **the backfill can never win against fresher data** — no matter what order the writes land in, how many times the backfill is retried, or whether it restarts from scratch. The operations commute. Contrast the naive version:

```
backfill writes v_k with the DEFAULT timestamp (= now)
now > t_n   ->   the stale historical value WINS and clobbers the live write
```

That is the classic migration data-loss bug, and it is silent.

**Two corollaries you must state in an interview.** First, timestamps are microseconds, not milliseconds — `updated_at_ms * 1000`. Second, **clock skew is now a correctness issue**: if the source's clock and Cassandra coordinators' clocks disagree by more than the gap between two writes to the same cell, LWW picks the wrong winner. Run chrony/NTP everywhere and monitor offset.

**What does not commute.** Counters ignore `USING TIMESTAMP` entirely and are not idempotent — a retried counter increment double-counts. Counters must be recomputed at cutover from a source of truth, never replayed. Deletes are also asymmetric: a tombstone written with a low timestamp will be shadowed by any later write, so a "delete this row" event replayed out of order behaves differently from an update.

**The `null` trap.** In Cassandra, writing `null` to a column is a *delete of that cell* — it creates a tombstone. A backfill of 2 billion rows where 40% have a nullable column produces 800 million tombstones, which then have to be compacted away and are scanned by reads until they are. The fix is `UNSET_VALUE` in prepared statements (or omit the column from the INSERT).

```svg
<svg viewBox="0 0 760 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="760" height="340" fill="#ffffff"/> <text x="380" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">Why USING TIMESTAMP makes backfill and live writes commute</text>
  <line x1="60" y1="120" x2="700" y2="120" stroke="#1e293b" stroke-width="2"/> <text x="60" y="140" fill="#1e293b" font-size="10">t1</text> <text x="230" y="140" fill="#1e293b" font-size="10">t2</text> <text x="400" y="140" fill="#1e293b" font-size="10">t3 (live edit)</text>
  <text x="620" y="140" fill="#1e293b" font-size="10">now (backfill runs)</text> <circle cx="62" cy="120" r="6" fill="#eef2ff" stroke="#4f46e5"/> <circle cx="232" cy="120" r="6" fill="#eef2ff" stroke="#4f46e5"/> <circle cx="402" cy="120" r="6" fill="#f0fdf4" stroke="#16a34a"/>
  <circle cx="622" cy="120" r="6" fill="#fef3c7" stroke="#d97706"/> <text x="380" y="60" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">source row history: v1 &#8594; v2 &#8594; v3</text>
  <text x="62" y="100" text-anchor="middle" fill="#1e293b" font-size="10">v1</text> <text x="232" y="100" text-anchor="middle" fill="#1e293b" font-size="10">v2</text> <text x="402" y="100" text-anchor="middle" fill="#16a34a" font-size="10" font-weight="700">v3</text>
  <rect x="40" y="170" width="330" height="146" rx="10" fill="#fef3c7" stroke="#d97706"/> <text x="205" y="192" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">WRONG: default timestamp</text> <rect x="60" y="204" width="290" height="28" rx="6" fill="#ffffff" stroke="#d97706"/>
  <text x="205" y="223" text-anchor="middle" fill="#1e293b" font-size="10">backfill INSERT v2   (ts = now)</text> <rect x="60" y="238" width="290" height="28" rx="6" fill="#ffffff" stroke="#16a34a"/>
  <text x="205" y="257" text-anchor="middle" fill="#1e293b" font-size="10">live INSERT v3       (ts = t3)</text> <text x="205" y="286" text-anchor="middle" fill="#d97706" font-size="11" font-weight="700">now &gt; t3 &#8594; stale v2 wins</text>
  <text x="205" y="304" text-anchor="middle" fill="#1e293b" font-size="10">silent data loss, no error raised</text> <rect x="390" y="170" width="330" height="146" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="555" y="192" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">RIGHT: source updated_at</text> <rect x="410" y="204" width="290" height="28" rx="6" fill="#ffffff" stroke="#4f46e5"/>
  <text x="555" y="223" text-anchor="middle" fill="#1e293b" font-size="10">backfill INSERT v2 USING TIMESTAMP t2</text> <rect x="410" y="238" width="290" height="28" rx="6" fill="#ffffff" stroke="#16a34a"/>
  <text x="555" y="257" text-anchor="middle" fill="#1e293b" font-size="10">live INSERT v3 USING TIMESTAMP t3</text> <text x="555" y="286" text-anchor="middle" fill="#16a34a" font-size="11" font-weight="700">t3 &gt; t2 &#8594; v3 wins, any order</text>
  <text x="555" y="304" text-anchor="middle" fill="#1e293b" font-size="10">backfill is restartable and idempotent</text>
</svg>
```

## 4. Architecture & Workflow: the eight-phase migration

1. **Model and stand up the target schema.** Enumerate the access patterns the *new* service will serve — not the old table list. One Cassandra table per query. Prove partition bounds. This is where you discover that `orders WHERE status = 'PENDING'` has no home and needs its own table.
2. **Instrument the source.** Emit metrics for write rate, row count per key range, and value-size distribution. You need a baseline to reconcile against, captured *before* anything changes.
3. **Turn on dual writes.** Either in the service layer (write to both stores; failure to write Cassandra logs and alerts but does not fail the request) or via CDC with the outbox pattern. Every write carries `USING TIMESTAMP = source_commit_time_micros`.
4. **Backfill, throttled.** Parallelise over source primary-key ranges, write with the source's `updated_at` as the timestamp, use `UNSET_VALUE` for nulls, and rate-limit against Cassandra's compaction backlog rather than a fixed rate. Restartable by design — checkpoint the completed ranges.
5. **Shadow-read at increasing sample rates.** Serve from the source; asynchronously read the same key from Cassandra; canonicalise both and diff. Log the key, the differing field and both timestamps. Ramp from 1% to 100%. Expect a nonzero baseline diff rate from in-flight writes and set a tolerance band.
6. **Cut reads over progressively.** 1% → 10% → 50% → 100% behind a flag, watching P99, error rate and business metrics at each step. Bake for at least a full weekly traffic cycle at 100% before proceeding.
7. **Flip the source of truth.** Cassandra becomes authoritative; the old store now receives *reverse* dual writes (or nothing, if you accept a longer rollback). This is the last easily reversible step.
8. **Close the gate.** After a deliberate soak — 30 days is a common choice — stop writing the old store, archive it, then drop it. Only now is the migration over.

```svg
<svg viewBox="0 0 760 350" width="100%" height="350" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="760" height="350" fill="#ffffff"/> <text x="380" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">Phased cutover with an open rollback gate</text> <rect x="20" y="40" width="720" height="86" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="380" y="60" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Steady state during phases 3&#8211;6</text>
  <rect x="42" y="72" width="120" height="42" rx="8" fill="#ffffff" stroke="#4f46e5"/> <text x="102" y="90" text-anchor="middle" fill="#1e293b" font-size="10">application</text>
  <text x="102" y="106" text-anchor="middle" fill="#1e293b" font-size="10">write path</text> <line x1="162" y1="82" x2="228" y2="82" stroke="#4f46e5" stroke-width="2"/>
  <line x1="162" y1="104" x2="228" y2="104" stroke="#0ea5e9" stroke-width="2"/> <rect x="230" y="66" width="140" height="24" rx="6" fill="#ffffff" stroke="#4f46e5"/> <text x="300" y="83" text-anchor="middle" fill="#1e293b" font-size="10">MySQL (authoritative)</text>
  <rect x="230" y="96" width="140" height="24" rx="6" fill="#ffffff" stroke="#0ea5e9"/> <text x="300" y="113" text-anchor="middle" fill="#1e293b" font-size="10">Cassandra (shadow)</text>
  <rect x="400" y="66" width="150" height="54" rx="8" fill="#ffffff" stroke="#16a34a"/> <text x="475" y="86" text-anchor="middle" fill="#1e293b" font-size="10">Spark backfill</text> <text x="475" y="102" text-anchor="middle" fill="#1e293b" font-size="10">USING TIMESTAMP</text>
  <text x="475" y="116" text-anchor="middle" fill="#1e293b" font-size="9">throttled, restartable</text> <line x1="550" y1="93" x2="576" y2="93" stroke="#16a34a" stroke-width="2"/>
  <rect x="578" y="66" width="146" height="54" rx="8" fill="#ffffff" stroke="#d97706"/> <text x="651" y="86" text-anchor="middle" fill="#1e293b" font-size="10">shadow-read diff</text> <text x="651" y="102" text-anchor="middle" fill="#1e293b" font-size="10">key, field, both ts</text>
  <text x="651" y="116" text-anchor="middle" fill="#1e293b" font-size="9">target: &lt; 0.001%</text> <line x1="60" y1="180" x2="700" y2="180" stroke="#1e293b" stroke-width="2"/>
  <rect x="60" y="164" width="120" height="32" rx="6" fill="#e0f2fe" stroke="#0ea5e9"/> <text x="120" y="185" text-anchor="middle" fill="#1e293b" font-size="10">reads 0% new</text>
  <rect x="184" y="164" width="120" height="32" rx="6" fill="#e0f2fe" stroke="#0ea5e9"/> <text x="244" y="185" text-anchor="middle" fill="#1e293b" font-size="10">1%</text>
  <rect x="308" y="164" width="120" height="32" rx="6" fill="#e0f2fe" stroke="#0ea5e9"/> <text x="368" y="185" text-anchor="middle" fill="#1e293b" font-size="10">10%</text>
  <rect x="432" y="164" width="120" height="32" rx="6" fill="#f0fdf4" stroke="#16a34a"/> <text x="492" y="185" text-anchor="middle" fill="#1e293b" font-size="10">50%</text>
  <rect x="556" y="164" width="144" height="32" rx="6" fill="#f0fdf4" stroke="#16a34a"/> <text x="628" y="185" text-anchor="middle" fill="#1e293b" font-size="10">100% + soak</text> <rect x="60" y="216" width="640" height="46" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="380" y="236" text-anchor="middle" fill="#16a34a" font-size="12" font-weight="700">ROLLBACK GATE OPEN: MySQL still written, revert = flip one flag</text> <text x="380" y="253" text-anchor="middle" fill="#1e293b" font-size="10">every step above is reversible in seconds</text>
  <rect x="60" y="276" width="310" height="54" rx="8" fill="#fef3c7" stroke="#d97706"/> <text x="215" y="296" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">phase 7: flip source of truth</text>
  <text x="215" y="313" text-anchor="middle" fill="#1e293b" font-size="10">reverse dual write keeps gate ajar</text> <rect x="390" y="276" width="310" height="54" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="545" y="296" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">phase 8: gate closes</text> <text x="545" y="313" text-anchor="middle" fill="#1e293b" font-size="10">stop dual write, archive, then DROP</text>
</svg>
```

## 5. Implementation

### 5.1 Translating a relational schema

The source, normalised across three tables:

```sql
-- MySQL
CREATE TABLE customers (id BIGINT PK, email VARCHAR(255) UNIQUE, name VARCHAR(255));
CREATE TABLE orders    (id BIGINT PK AUTO_INCREMENT, customer_id BIGINT, status VARCHAR(16),
                        total DECIMAL(12,2), created_at DATETIME, updated_at DATETIME);
CREATE TABLE order_items (order_id BIGINT, sku VARCHAR(64), qty INT, price DECIMAL(12,2));
-- Queries: order by id; a customer's orders newest-first; pending orders for a given day.
```

The target — one table per query, items collapsed into the order row, and the auto-increment id replaced:

```cql
CREATE KEYSPACE shop WITH replication =
  {'class':'NetworkTopologyStrategy','us_east':3,'eu_west':3};

CREATE TYPE shop.order_item (sku text, qty int, price decimal);

CREATE TABLE shop.orders_by_id (
  order_id uuid PRIMARY KEY,
  customer_id bigint, status text, total decimal,
  items list<frozen<order_item>>, created_at timestamp, updated_at timestamp);

CREATE TABLE shop.orders_by_customer (          -- newest-first history
  customer_id bigint, bucket int, order_id uuid,
  status text, total decimal, created_at timestamp,
  PRIMARY KEY ((customer_id, bucket), created_at, order_id)
) WITH CLUSTERING ORDER BY (created_at DESC, order_id DESC);

CREATE TABLE shop.orders_by_status_day (        -- operational queue view
  status text, day date, created_at timestamp, order_id uuid,
  customer_id bigint,
  PRIMARY KEY ((status, day), created_at, order_id)
) WITH CLUSTERING ORDER BY (created_at DESC, order_id DESC);

CREATE TABLE shop.customer_by_email (           -- replaces the UNIQUE constraint
  email text PRIMARY KEY, customer_id bigint);
```

> **Note:** `customer_by_email` plus `INSERT ... IF NOT EXISTS` (a lightweight transaction at `LOCAL_SERIAL`) is how you replace a `UNIQUE` index. It costs roughly four round trips, which is fine for signup and unacceptable on a hot path.

### 5.2 Dual writes with correct timestamps

```python
from cassandra.query import UNSET_VALUE

INSERT_ORDER = session.prepare("""
  INSERT INTO shop.orders_by_id
    (order_id, customer_id, status, total, items, created_at, updated_at)
  VALUES (?,?,?,?,?,?,?) USING TIMESTAMP ?""")
INSERT_ORDER.is_idempotent = True

def write_order(row, source_commit_ms):
    session.execute(INSERT_ORDER, (
        row.order_uuid, row.customer_id, row.status, row.total,
        row.items if row.items is not None else UNSET_VALUE,   # never bind None
        row.created_at, row.updated_at,
        source_commit_ms * 1000))                              # micros, not millis
```

The CDC alternative keeps application code untouched — Debezium reads the MySQL binlog into Kafka, and the consumer uses `source.ts_ms × 1000` as the CQL timestamp:

```json
{"name": "orders-cdc", "config": {
  "connector.class": "io.debezium.connector.mysql.MySqlConnector",
  "database.include.list": "shop",
  "table.include.list": "shop.orders,shop.order_items",
  "topic.prefix": "shop", "snapshot.mode": "schema_only",
  "decimal.handling.mode": "string", "time.precision.mode": "connect"}}
```

### 5.3 Backfill with Spark, throttled and restartable

```python
# spark-submit --packages com.datastax.spark:spark-cassandra-connector_2.12:3.5.0
from pyspark.sql import functions as F

src = (spark.read.format("jdbc")
       .option("url", "jdbc:mysql://mysql-replica/shop")   # a REPLICA, never the primary
       .option("dbtable", "(SELECT * FROM orders WHERE id BETWEEN %d AND %d) t" % (lo, hi))
       .option("partitionColumn", "id").option("numPartitions", 256)
       .option("lowerBound", lo).option("upperBound", hi).load())

out = (src.withColumn("writetime",
                      (F.unix_timestamp("updated_at") * F.lit(1000000)).cast("long"))
          .withColumnRenamed("id", "order_id"))

(out.write.format("org.apache.spark.sql.cassandra")
    .options(keyspace="shop", table="orders_by_id",
             **{"spark.cassandra.output.timestamp": "writetime",
                "spark.cassandra.output.ignoreNulls": "true",   # -> UNSET, no tombstones
                "spark.cassandra.output.concurrent.writes": "8",
                "spark.cassandra.output.throughputMBPerSec": "40"})   # the throttle
    .mode("append").save())
```

Throttle against the cluster's own back-pressure, not a guessed rate:

```bash
# Watch this in a loop while the backfill runs. Back off when pending climbs.
watch -n10 'nodetool compactionstats | head -3; nodetool tpstats | grep -E "MutationStage|Dropped"'
# pending tasks: 12          <- healthy
# pending tasks: 3841        <- STOP. you are creating debt faster than you can pay it.

nodetool setcompactionthroughput 128      # MB/s; raise while backfilling, restore after
nodetool setstreamthroughput 200
```

### 5.4 Preserving TTL and per-cell timestamps

```cql
-- WRITETIME and TTL are per CELL and do not exist for primary-key columns.
SELECT status, WRITETIME(status) AS ws, TTL(status) AS t FROM shop.orders_by_id
WHERE order_id = 5b6e...;                       -- ws=1718300000123456  t=2591000
INSERT INTO shop.orders_by_id (order_id, status) VALUES (5b6e..., 'SHIPPED')
USING TIMESTAMP 1718300000123456 AND TTL 2591000;
```

### 5.5 Cassandra → Cassandra: the DC-add migration (no dual writes at all)

```bash
# 1. Stand up the new DC. On every new node, BEFORE starting:
#    cassandra.yaml: auto_bootstrap: false ; endpoint_snitch: GossipingPropertyFileSnitch
#    cassandra-rackdc.properties: dc=us_east_2 rack=rack1
# 2. Extend replication (this does NOT move any data yet):
cqlsh -e "ALTER KEYSPACE shop WITH replication = \
  {'class':'NetworkTopologyStrategy','us_east':3,'us_east_2':3};"
cqlsh -e "ALTER KEYSPACE system_auth WITH replication = \
  {'class':'NetworkTopologyStrategy','us_east':3,'us_east_2':3};"   # do not forget this one

# 3. Stream history into the new DC, one node at a time; 4. repair; 5. repoint clients
nodetool rebuild -- us_east    # run on EACH node of us_east_2
nodetool repair -pr            # then set local_dc=us_east_2, LOCAL_QUORUM, and soak

# 6. Only after the new DC has served production for a soak period:
cqlsh -e "ALTER KEYSPACE shop WITH replication = \
  {'class':'NetworkTopologyStrategy','us_east_2':3};"
nodetool decommission        # on each old-DC node
```

### 5.6 Validating

```bash
# Coarse: per-token-range counts, parallelised. Never SELECT COUNT(*) on a whole table.
dsbulk count -k shop -t orders_by_id -h cass1        # total rows: 2,108,441,203

# Fine: sampled deep compare. Canonicalise decimals and timestamps before hashing.
python compare.py --sample 0.001 --source mysql-replica --target cass1 \
                  --on-diff log --emit-metric migration_diff_rate
# examined 2,108,441  differing 3  rate 1.4e-06  (all three: target ts > source ts, in-flight)
```

**Optimization note.** The backfill's real constraint is almost never Cassandra's write path — it is compaction. Writes are cheap; merging what you wrote is not. Raise `setcompactionthroughput` during the backfill, prefer `LeveledCompactionStrategy` only if the table is genuinely read-heavy (LCS multiplies write amplification and will make a backfill much worse), and consider loading with STCS and switching strategy afterwards. If the table is time-ordered and TTL'd, backfill directly into TWCS with windows sized for the *historical* range so old windows are immediately droppable.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| **Dual write in app code** | Full control over timestamps, transformation and error handling | Touches every write path; drift when one store fails and the other succeeds; needs reconciliation |
| **CDC (Debezium) dual write** | No application changes; ordered, replayable, exactly as atomic as the source with the outbox pattern | Another distributed system to run; schema-change handling is fiddly; adds seconds of lag |
| **Proxy-based (DataStax ZDM)** | Zero application changes, dual writes and async validation reads built in, staged read routing | Only for CQL-to-CQL migrations; a new component on the hot path; version and feature constraints |
| **Bulk-only (`sstableloader`, DSBulk)** | Fastest raw throughput; simple; no live coordination | Requires a write freeze or accepts a gap; only viable for immutable or low-churn data |
| **DC-add (`nodetool rebuild`)** | The cleanest possible path for Cassandra-to-Cassandra; no dual writes, no timestamp work, trivially reversible | Cassandra-to-Cassandra only; needs network between DCs and roughly double the hardware for a period |
| **Big-bang cutover** | Simple to reason about; short project | Requires downtime; rollback means restoring a backup; the failure mode is a bad weekend |
| **Progressive read cutover** | Risk is bounded at every step; instant revert; real production validation | Weeks of running two stores; double cost; the team must resist declaring victory at 100% reads |
| **Long rollback gate** | Cheap insurance against a defect found in week three | Ongoing dual-write cost and complexity; someone must eventually remember to close it |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Backfilling with the default write timestamp.** → ✅ Always `USING TIMESTAMP source_updated_at_micros`. Without it the backfill overwrites live writes with stale data, silently and unrecoverably.
2. ⚠️ **Passing milliseconds where microseconds are expected.** → ✅ Multiply by 1000. A millisecond value is interpreted as a timestamp in 1970, so *every* backfilled cell loses to everything, and the backfill appears to do nothing.
3. ⚠️ **Binding `null` for absent columns.** → ✅ Use `UNSET_VALUE` (or `spark.cassandra.output.ignoreNulls=true`). Binding null writes a tombstone per cell and a large backfill will generate hundreds of millions of them.
4. ⚠️ **Replaying counter increments.** → ✅ Counters are not idempotent and ignore `USING TIMESTAMP`. Recompute counters at cutover from an authoritative source, or move them out of Cassandra entirely.
5. ⚠️ **Backfilling at full speed.** → ✅ Rate-limit against `nodetool compactionstats` pending tasks and dropped `MUTATION` counts. A backfill that outruns compaction turns into a production latency incident within hours.
6. ⚠️ **Reading the source's primary during backfill.** → ✅ Read a dedicated replica. Otherwise the migration degrades the very system that is still serving your users.
7. ⚠️ **Porting the relational schema table-for-table.** → ✅ Model from the *access patterns of the new service*. A one-to-one port guarantees joins you cannot perform and filters you cannot serve.
8. ⚠️ **Forgetting `system_auth` when adding a DC.** → ✅ Alter its replication too, or authentication fails in the new DC the moment the old one is unreachable.
9. ⚠️ **Running concurrent DDL from multiple nodes/scripts.** → ✅ Apply schema changes serially from one coordinator and confirm convergence with `nodetool describecluster` (one schema version) before the next change. Schema disagreement is a genuine outage class.
10. ⚠️ **Declaring success at 100% reads.** → ✅ 100% reads is phase 6 of 8. Keep dual-writing and keep the old store restorable for a deliberate soak — 30 days is a reasonable default.
11. ⚠️ **No clock discipline, or treating shadow-read diffs as pass/fail.** → ✅ Run chrony/NTP everywhere and alert on offset, because LWW correctness is now clock correctness. And expect a nonzero baseline diff rate from in-flight writes: classify diffs by cause (in-flight, transformation bug, missing backfill range) and drive the *unexplained* rate to zero.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** When a shadow-read diff appears, the first query is always the timestamp: `SELECT WRITETIME(col) FROM ... WHERE key = ?` on the Cassandra side, compared with the source's `updated_at`. If the Cassandra writetime is older, a backfill range is missing or the CDC stream is lagging; if it is newer but the value is wrong, your transformation is buggy. For "the backfill wrote nothing," check for millisecond-vs-microsecond timestamps — the writes succeed and lose. For a stalled backfill, `nodetool tpstats` will show dropped `MUTATION` messages and `nodetool compactionstats` a growing backlog. Cassandra 4.0's Full Query Logging (`nodetool enablefullquerylog`) captures exactly what the backfill actually sent.

**Monitoring.** Migration-specific dashboards on top of the usual: CDC/dual-write lag in seconds; backfill ranges completed versus total; unexplained diff rate; and per-table `MaxPartitionSize` (a backfill is the moment you discover a partition the old schema was hiding). Cassandra beans that matter during a migration: `type=Compaction,name=PendingTasks`, `type=DroppedMessage,scope=MUTATION`, `type=Table,name=TombstoneScannedHistogram` (catches the `null`-binding bug), `type=ClientRequest,scope=Write,name=Timeouts`, and `type=Storage,name=Load` growth rate against your projection. Alert if `Load` grows more than ~1.5× your predicted bytes/day — that means the model or the tombstones are wrong.

**Security.** Migration is when credentials sprawl. Give the backfill job its own Cassandra role with write-only grants on the target keyspace and its own read-only credentials on the source replica, both short-lived. Enable TLS on the Spark-to-Cassandra and CDC-to-Kafka links since you are now shipping the entire production dataset across the network. Ensure `audit_logging_options` (Cassandra 4.0+) is on during the migration window — you will want the record. And confirm the archived source store is encrypted and retention-limited before you forget it exists.

**Performance & Scaling.** Size the target cluster for the *end state plus the migration*, not the end state alone: during the backfill you carry the write throughput of live traffic plus the bulk load plus the compaction of both. A common rule is to provision 30–40% more capacity than steady state for the migration window, then scale down after. For the DC-add pattern, budget for both DCs running simultaneously for weeks — that is the real cost of its simplicity. And measure `nodetool tablehistograms` on the target during backfill: if max partition size is trending toward 100 MB before you are half done, stop and re-model rather than finishing and hoping.

## 9. Interview Questions

**Q: How do you migrate a live table to Cassandra without downtime?**
A: Dual-write every mutation to both stores while the old one remains authoritative, backfill history concurrently with `USING TIMESTAMP` set to the source row's update time, validate with shadow reads that diff old versus new, then shift read traffic progressively behind a flag from 1% to 100%. Keep dual-writing through a soak period so rollback is a flag flip, and only then stop writing and archive the old store.

**Q: Why is `USING TIMESTAMP` the central tool in a migration?**
A: Cassandra resolves conflicts by last-write-wins on the cell timestamp. If the backfill writes with the source's `updated_at` and live traffic writes with the source commit time, then any live write is always newer than the historical version it supersedes — so the two writers commute and the backfill can be restarted or re-run at will. With default timestamps the backfill's "now" beats every live write and silently reverts data.

**Q: What unit does `USING TIMESTAMP` take, and what happens if you get it wrong?**
A: Microseconds since the Unix epoch. Passing milliseconds produces a timestamp around 1970, so every backfilled cell loses to every other write and the backfill appears to have done nothing while reporting complete success. It is one of the most common and most confusing migration bugs.

**Q: Why is binding `null` during a backfill dangerous?**
A: In Cassandra, writing `null` to a column deletes that cell, which writes a tombstone. A backfill of billions of rows with nullable columns can create hundreds of millions of tombstones that must be compacted away and are scanned by reads until they are. Use the driver's `UNSET_VALUE`, or `ignoreNulls` in the Spark connector, so absent columns are simply not written.

**Q: How would you migrate between two Cassandra clusters or datacenters?**
A: Use the DC-add pattern rather than dual writes. Join the new nodes with `auto_bootstrap: false`, extend the keyspace's `NetworkTopologyStrategy` to include the new DC (including `system_auth`), run `nodetool rebuild -- <old_dc>` on each new node to stream history, repair, then repoint clients to `local_dc = new` with `LOCAL_QUORUM`. After a soak, remove the old DC from the replication map and decommission. Live writes replicate automatically the moment you alter replication, so there is nothing to reconcile.

**Q: What do you do about counters?**
A: Do not migrate them by replay. Counters ignore `USING TIMESTAMP` and are not idempotent, so any retry double-counts. Either recompute them at cutover from an authoritative event log, or take the opportunity to move them out of Cassandra into a cache with periodic snapshots, which is usually the better long-term design anyway.

**Q: How do you validate that two datastores agree at billions of rows?**
A: Three layers. Coarse counts per token or key range with `dsbulk count` on the target and a partitioned count on the source. Continuous shadow reads on live traffic, diffing canonicalised rows and emitting an unexplained-diff-rate metric. And a sampled deep compare — 0.1% of keys, full field-by-field — run as a batch job. Classify every diff by cause and drive the unexplained rate to zero rather than chasing an absolute zero that in-flight writes make impossible.

**Q: (Senior) You are at 100% reads on Cassandra and finance reports 40 orders with wrong totals. Walk through the response.**
A: Flip reads back to the old store immediately — that is what the gate is for — and confirm the incident stops. Then take the 40 keys and compare `WRITETIME` per cell against the source's `updated_at`. Older Cassandra writetime means a missing backfill range or CDC lag; newer writetime with a wrong value means a transformation bug; equal timestamps with differing values means a tie-break on a genuine concurrent write. Fix the class of bug, re-run the affected ranges (safe, because the writes are idempotent and timestamp-ordered), extend the shadow-read soak, and only then re-attempt the ramp.

**Q: (Senior) Your backfill is projected to take five weeks. How do you make it faster without hurting production?**
A: Attack compaction rather than the write path, because that is the real bottleneck. Raise `setcompactionthroughput`, load into STCS and switch strategy afterwards if the target is LCS, and if the table is time-ordered, load directly into TWCS with windows aligned to the historical range so old windows are droppable rather than mergeable. Then parallelise by source key range with checkpointing, read from a dedicated replica, and add temporary Cassandra capacity for the migration window. Throttle on the cluster's pending-compaction and dropped-mutation signals, not a fixed rate.

**Q: (Senior) The relational source has a `UNIQUE` constraint on email and a foreign key from orders to customers. What replaces them?**
A: The unique constraint becomes a lookup table `customer_by_email(email PRIMARY KEY, customer_id)` written with `INSERT ... IF NOT EXISTS`, a lightweight transaction at `LOCAL_SERIAL` — acceptable at signup rates, not on a hot path. The foreign key becomes an application invariant plus a periodic reconciliation job that sweeps for orphans, because Cassandra will happily store an order referencing a nonexistent customer. Say the second part explicitly: you are trading enforced integrity for write availability, and the cost is a sweeper and an alert.

**Q: (Senior) When would you *not* migrate to Cassandra?**
A: When the workload needs cross-entity transactions, ad-hoc analytical queries, or joins you cannot precompute; when the dataset comfortably fits one well-provisioned relational primary with read replicas; when the team has no capacity to own a stateful distributed system; or when the real problem is a missing index or an N+1 query pattern. Migrations cost months and permanently raise operational complexity, so the honest answer is often "shard or optimise the relational store instead."

**Q: What is the rollback gate and when does it close?**
A: It is the window during which the old store still receives every write and can resume serving instantly, so reverting is a feature-flag flip rather than a restore-from-backup. It closes only when you stop dual-writing — which should be after a deliberate soak at 100% reads, commonly 30 days, long enough to cover monthly batch jobs and reporting cycles that only exercise the data once a month.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Every real Cassandra project is a migration. The pattern is: model from the *new* service's access patterns, dual-write (in the service or via Debezium CDC with an outbox), backfill concurrently with `USING TIMESTAMP = source_updated_at × 1000` in **microseconds**, never bind `null` (use `UNSET_VALUE`), throttle against pending compactions rather than a fixed rate, validate with token-range counts plus shadow reads plus a sampled deep compare, cut reads over 1% → 10% → 50% → 100%, soak, then close the rollback gate. Correct timestamps make backfill and live writes commute, which is what makes the whole thing restartable. Counters break all of this because they are not idempotent — recompute them. For Cassandra-to-Cassandra, skip all of it: `ALTER KEYSPACE` to add the DC (including `system_auth`), `nodetool rebuild -- old_dc`, repair, repoint clients to `LOCAL_QUORUM` on the new DC, soak, decommission. Relational constructs map as: `UNIQUE` → lookup table with `IF NOT EXISTS`, foreign key → application invariant plus an orphan sweeper, join → denormalise, aggregate → precompute or Spark, auto-increment → TimeUUID or Snowflake.

| Step / concern | Command or setting | Gotcha |
|---|---|---|
| Set write timestamp | `INSERT ... USING TIMESTAMP <micros>` | microseconds, not milliseconds |
| Avoid tombstones | `UNSET_VALUE` / `output.ignoreNulls=true` | binding `null` deletes the cell |
| Idempotent retries | `stmt.is_idempotent = True` | required for speculative execution |
| Throttle backfill | `nodetool setcompactionthroughput 128` | watch `compactionstats` pending |
| Preserve TTL | `SELECT TTL(c), WRITETIME(c)` then `USING TIMESTAMP ... AND TTL ...` | per-cell; PK columns have neither |
| Add a DC | `ALTER KEYSPACE ... NetworkTopologyStrategy` | include `system_auth` |
| Stream to new DC | `nodetool rebuild -- <src_dc>` | `auto_bootstrap: false` before start |
| Schema changes | one coordinator, serially | verify with `nodetool describecluster` |
| Count rows | `dsbulk count -k ks -t tbl` | never `SELECT COUNT(*)` on a table |
| Unique constraint | lookup table + `IF NOT EXISTS` | Paxos, ~4 round trips, `LOCAL_SERIAL` |

**Flash cards**
- **The one rule** → backfill with the source's timestamp in microseconds, or you overwrite live data silently.
- **The tombstone trap** → binding `null` writes a tombstone; use `UNSET_VALUE`.
- **Counters** → not idempotent, ignore `USING TIMESTAMP`; recompute, never replay.
- **Cassandra → Cassandra** → `ALTER KEYSPACE` + `nodetool rebuild` + repair + repoint + decommission. No dual writes.
- **Rollback gate** → open until you stop dual-writing; 100% reads is phase 6 of 8, not the finish line.

## 11. Hands-On Exercises & Mini Project

- [ ] Build a two-writer race locally: insert a row via a "live" write, then run a "backfill" write with an older value — once with the default timestamp and once with `USING TIMESTAMP`. Read back both times and confirm exactly which one loses.
- [ ] Backfill 1 M rows binding `null` for a nullable column, then re-run with `UNSET_VALUE`, and compare `nodetool tablestats` tombstone counts and read latency between the two tables.
- [ ] Stand up MySQL plus Debezium plus Kafka in Docker, stream `orders` into Cassandra with `source.ts_ms` as the CQL timestamp, and verify an update made during the load reaches Cassandra with the right winner.
- [ ] Run a DC-add migration on a local two-DC ccm cluster: alter replication, `nodetool rebuild`, verify data with `dsbulk count` in both DCs, repoint a client to the new DC, and decommission the old one.
- [ ] Write the shadow-read comparator: sample 1% of reads, canonicalise decimals and timestamps, emit a diff-rate metric, and classify each diff as in-flight, missing-range or transformation bug.

**Mini Project — A Complete Zero-Downtime Migration Harness**
*Goal:* migrate a live, continuously mutating relational table into Cassandra with no downtime and provable correctness, end to end.
*Requirements:* (1) run a load generator that continuously inserts and updates rows in MySQL so the source is genuinely moving; (2) implement dual writes with correct microsecond timestamps and `UNSET_VALUE` handling; (3) implement a checkpointed, restartable, rate-limited backfill parallelised over key ranges; (4) implement shadow reads with a classified diff-rate metric on a dashboard; (5) implement a read-routing flag supporting 1/10/50/100% and demonstrate an instant rollback under load; (6) produce a reconciliation report proving row counts and a 0.1% deep sample match.
*Extensions:* kill the backfill halfway and restart it, proving idempotence by showing the diff rate is unchanged; introduce deliberate 200 ms clock skew on one host and demonstrate the resulting LWW anomaly, then fix it; add a counter column and demonstrate why replay double-counts, then implement the recompute-at-cutover alternative; add a second Cassandra DC afterwards using `nodetool rebuild` and compare the effort with the dual-write path.

## 12. Related Topics & Free Learning Resources

**Related chapters:** *Query-First Data Modelling* (how to model the target, not port the source), *Consistency Levels & Tunable Consistency*, *Lightweight Transactions & Paxos* (replacing `UNIQUE`), *Compaction Strategies* (the backfill's real bottleneck), *Multi-DC Replication & Snitches* (the DC-add pattern), *Production Case Studies & Architectures*, and *Cassandra System Design (Interview)*.

**Free Learning Resources**
- **DataStax Zero Downtime Migration documentation** — DataStax · *Intermediate–Advanced* · the proxy-based migration architecture, phase by phase, including dual writes and async validation reads. <https://docs.datastax.com/en/data-migration/introduction.html>
- **Apache Cassandra — CQL: INSERT, UPDATE and the `USING TIMESTAMP` clause** — Apache Software Foundation · *Intermediate* · the authoritative statement of timestamp units and last-write-wins semantics. <https://cassandra.apache.org/doc/latest/cassandra/developing/cql/dml.html>
- **DataStax Bulk Loader (DSBulk) documentation** — DataStax · *Beginner–Intermediate* · fast unload/load/count, including how to count billions of rows without a full-table `COUNT(*)`. <https://docs.datastax.com/en/dsbulk/docs/index.html>
- **Spark Cassandra Connector documentation** — DataStax (GitHub) · *Advanced* · `output.timestamp`, `ignoreNulls`, throughput throttling and token-aware writes — the exact knobs a backfill needs. <https://github.com/datastax/spark-cassandra-connector/blob/master/doc/reference.md>
- **Debezium MySQL / PostgreSQL connector documentation** — Debezium · *Intermediate* · CDC semantics, snapshot modes, and the `source.ts_ms` field that becomes your CQL timestamp. <https://debezium.io/documentation/reference/stable/connectors/mysql.html>
- **Apache Cassandra — Adding a datacenter to a cluster** — Apache Software Foundation · *Intermediate* · the canonical `auto_bootstrap` / `ALTER KEYSPACE` / `nodetool rebuild` procedure. <https://cassandra.apache.org/doc/latest/cassandra/managing/operating/topo_changes.html>
- **The Last Pickle — About Deletes and Tombstones in Cassandra** — The Last Pickle · *Advanced* · why null-binding and delete-heavy migrations hurt, with the compaction detail behind it. <https://thelastpickle.com/blog/2016/07/27/about-deletes-and-tombstones.html>
- **How Discord Stores Trillions of Messages** — Discord Engineering · *Intermediate* · a real large-scale migration including the migrator design, throughput achieved and the cutover strategy. <https://discord.com/blog/how-discord-stores-trillions-of-messages>

---

*Apache Cassandra Handbook — chapter 46.*
