# 12 · Data Modeling Anti-Patterns

> **In one line:** Cassandra almost never fails because of too much data — it fails because one partition grew without bound, one key was too coarse, or someone used it as a queue.

---

## 1. Overview

Cassandra is unusually unforgiving of schema mistakes, and unusually forgiving of everything else. A cluster will absorb node failures, network partitions, rolling upgrades and a tripling of data volume with barely a change in latency. What it will not absorb is a partition that grows to 4 GB, a partition key with eight distinct values, or a table used as a work queue. Those failures are structural: no amount of heap tuning, faster disks, compaction throttling or extra nodes fixes them, because the problem is that the physics of the storage engine is being asked to do something it cannot do.

The reason is that the **partition is the indivisible unit** of everything. It is the unit of placement (one token, one replica set), of read (a partition cannot be split across nodes), of repair (Merkle-tree leaves are partition ranges), of compaction (a partition must be rewritten as a whole), and of streaming during bootstrap. A partition that is too large cannot be balanced away by adding nodes — it lands entirely on `RF` machines no matter how big the ring is. A partition key that is too coarse concentrates all traffic on those same `RF` machines. Both symptoms present the same way in a dashboard: three nodes at 90 % CPU while thirty sit at 8 %.

The second family of anti-patterns comes from tombstones. Cassandra's delete is a write — a marker that shadows earlier data until `gc_grace_seconds` (default **864000**, ten days) has passed *and* compaction can prove every replica has seen it. Any model whose normal operation involves deleting rows in the same partition it reads from will accumulate tombstones faster than it can drop them, and reads slow down linearly with the tombstone count until `tombstone_failure_threshold` (100,000) aborts the query outright. The queue anti-pattern — insert a job, read the oldest, delete it, repeat — is the purest expression of this and is the single most famous way to break a Cassandra cluster.

These are not obscure edge cases. The Apache project cares enough that Cassandra 4.1 shipped a whole **guardrails** subsystem (`guardrails:` in `cassandra.yaml`) whose entire purpose is to warn or fail when an application starts down one of these paths: too many columns, too many secondary indexes, partitions too large, collections too big, `ALLOW FILTERING` used at all. If you are starting a new cluster, turning those on is the cheapest insurance available. A real-world illustration of what they prevent: a well-documented incident pattern recurs across many companies where a "notifications" table keyed by `((user_id), notification_id)` worked for years, until a bot account accumulated 12 million notifications. That single partition became 3 GB. Compaction of it required 6 GB of free space and 40 minutes of I/O; repair streamed the whole thing; reads pulled a huge row index into heap and triggered full GCs. The cluster was healthy in every metric except the ones that mattered. The fix — bucketing the key — required a new table, a dual write and a backfill, i.e. exactly the migration that ten minutes of sizing arithmetic at design time would have avoided.

---

## 2. Core Concepts

- **Unbounded partition** — a partition whose row count grows with time or with user behaviour and has no structural ceiling. The root cause of most Cassandra incidents.
- **Partition size budget** — the practical ceiling: **< 100 MB** and **< 100,000 rows**. Cassandra warns above `compaction_large_partition_warning_threshold` (100 MiB default in 4.x).
- **Hotspot** — disproportionate traffic to one partition or one token range, caused by a low-cardinality key, a sequential key, or a genuinely popular entity (a celebrity, a viral channel).
- **Queue anti-pattern** — using a table as a FIFO work queue, so every consumed item leaves a tombstone in front of the rows still being read.
- **Tombstone** — the marker written by a delete, a TTL expiry, a null insert, or a collection assignment. It shadows data until `gc_grace_seconds` elapses and compaction can safely drop it.
- **`gc_grace_seconds`** — default **864000** (10 days); the window during which a tombstone must survive so that repair can propagate the delete to every replica before it is dropped. Dropping early risks zombie data.
- **Read-before-write** — any pattern where the application reads a row, modifies it in memory, and writes it back. It is not atomic, does not scale, and is a lost-update bug in a concurrent system.
- **Sequential partition key** — a monotonically increasing key (auto-increment id, current timestamp) that sends all writes to one token range at a time.
- **Guardrails (4.1+)** — the `cassandra.yaml` subsystem that warns or fails on partition size, column count, index count, collection size and `ALLOW FILTERING`.
- **Zombie row** — deleted data that reappears because a tombstone was dropped before every replica received it, usually caused by lowering `gc_grace_seconds` without running repair inside the window.

---

## 3. Theory & Internals

### Why a large partition breaks everything at once

A partition is stored contiguously within an SSTable, with a **row index** (entries every `column_index_size`, 64 KiB default) so a slice can seek within it. Four consequences compound:

- **Read heap pressure.** For a 2 GB partition the row index alone is ~32,000 entries; older versions loaded it fully into heap per read. Even in 4.x, wide partitions inflate on-heap structures and cause GC pauses that show up as unexplained p99 spikes cluster-wide.
- **Compaction.** Compacting a partition requires reading and rewriting it entirely. A 4 GB partition needs 4 GB of free disk plus sustained I/O; with `SizeTieredCompactionStrategy` it may be rewritten many times over its life.
- **Repair.** Merkle-tree leaves cover token ranges; a mismatch anywhere in a huge partition streams the *whole partition*. One bit of divergence can move gigabytes across the network.
- **No rebalancing.** Adding nodes redistributes *partitions*, never splits one. A 4 GB partition is 4 GB on `RF` nodes forever.

The sizing formula you should run before any `CREATE TABLE`:

```
rows_per_partition = ∏ (cardinality of each clustering column, per partition key value)
partition_bytes    ≈ rows_per_partition × (row overhead ≈ 8–20 B + Σ column sizes)
```

If the answer is unbounded in time, the key is wrong. Add a bucket: `((sensor_id, day), ts)` caps a 1 Hz sensor at 86,400 rows and ~10 MB. `((sensor_id, month), ts)` gives 2.6 M rows and ~310 MB — over budget on both counts. **The bucket granularity is the sizing knob, and it is chosen from the peak rate, not the average.**

### Why the queue anti-pattern is fatal

Consider `PRIMARY KEY ((queue_id), job_id)` with `job_id` a timeuuid, consumed oldest-first:

```
SELECT * FROM jobs WHERE queue_id = ? LIMIT 10;
DELETE FROM jobs WHERE queue_id = ? AND job_id = ?;   -- ×10
```

Each delete writes a tombstone at the *front* of the clustering order. The next `SELECT ... LIMIT 10` must scan past every tombstone written since the last compaction to find 10 live rows. At 1,000 jobs/minute and `gc_grace_seconds = 864000`, the partition accumulates ~14.4 M tombstones in the grace window. Reads cross `tombstone_warn_threshold` (1,000) within the first minute and `tombstone_failure_threshold` (100,000) within two hours, after which the query fails outright. Lowering `gc_grace_seconds` reduces the ceiling but risks zombies; raising the thresholds just delays a cluster-wide read collapse.

### Hotspot math

With `num_tokens: 16` vnodes and `RF=3`, token ownership across `N` nodes is near-uniform *if* the partition keys are uniformly distributed. Load skew is therefore entirely a function of key cardinality and access distribution:

```
distinct_partition_keys ≥ N × num_tokens × 10          (rule of thumb for even spread)
traffic_to_hottest_node ≈ (QPS to hottest partition) × RF
```

A `country` key has ~200 values — for a 60-node cluster that is far too few, and the `US` partition alone may carry 40 % of traffic on 3 nodes. The fix is always to widen the key: `(country, day)`, or `(country, shard)` with `shard = hash(entity_id) % 32`, read with 32 concurrent queries. Sequential keys (`bucket = current_hour`) are the time-shifted version of the same bug: every writer targets one token at a time, so the write hotspot migrates around the ring instead of being spread.

```svg
<svg viewBox="0 0 760 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="760" height="340" fill="#ffffff"/>
  <text x="20" y="24" font-size="15" font-weight="700" fill="#1e293b">The queue anti-pattern: tombstones accumulate in front of live rows</text>
  <text x="20" y="48" font-size="12" font-weight="700" fill="#1e293b">Partition (queue_id = 'emails'), clustered by job_id ascending</text>
  <rect x="20" y="58" width="720" height="52" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <rect x="30" y="68" width="46" height="32" rx="4" fill="#ffffff" stroke="#d97706"/>
  <text x="38" y="88" font-size="10" fill="#1e293b">TS</text>
  <rect x="80" y="68" width="46" height="32" rx="4" fill="#ffffff" stroke="#d97706"/>
  <text x="88" y="88" font-size="10" fill="#1e293b">TS</text>
  <rect x="130" y="68" width="46" height="32" rx="4" fill="#ffffff" stroke="#d97706"/>
  <text x="138" y="88" font-size="10" fill="#1e293b">TS</text>
  <rect x="180" y="68" width="46" height="32" rx="4" fill="#ffffff" stroke="#d97706"/>
  <text x="188" y="88" font-size="10" fill="#1e293b">TS</text>
  <rect x="230" y="68" width="46" height="32" rx="4" fill="#ffffff" stroke="#d97706"/>
  <text x="238" y="88" font-size="10" fill="#1e293b">TS</text>
  <text x="284" y="88" font-size="11" fill="#d97706">… 100k more tombstones …</text>
  <rect x="560" y="68" width="52" height="32" rx="4" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="570" y="88" font-size="10" fill="#1e293b">live</text>
  <rect x="616" y="68" width="52" height="32" rx="4" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="626" y="88" font-size="10" fill="#1e293b">live</text>
  <rect x="672" y="68" width="52" height="32" rx="4" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="682" y="88" font-size="10" fill="#1e293b">live</text>
  <text x="20" y="128" font-size="11" fill="#1e293b">SELECT ... LIMIT 10 must scan every tombstone to reach 10 live rows.</text>
  <text x="20" y="146" font-size="11" fill="#1e293b">1,000 jobs/min × gc_grace_seconds 864000 s  ≈  14.4 M tombstones in the grace window.</text>
  <text x="20" y="164" font-size="11" fill="#1e293b">tombstone_warn_threshold 1000 crossed in ~1 min · failure_threshold 100000 in ~2 h → query aborts.</text>
  <text x="20" y="196" font-size="14" font-weight="700" fill="#1e293b">Why a big partition cannot be fixed by adding nodes</text>
  <rect x="20" y="208" width="350" height="110" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="34" y="228" font-size="12" font-weight="700" fill="#1e293b">3-node ring</text>
  <circle cx="80" cy="270" r="26" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="64" y="274" font-size="10" fill="#1e293b">4 GB</text>
  <circle cx="160" cy="270" r="26" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="144" y="274" font-size="10" fill="#1e293b">4 GB</text>
  <circle cx="240" cy="270" r="26" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="224" y="274" font-size="10" fill="#1e293b">4 GB</text>
  <text x="34" y="310" font-size="11" fill="#1e293b">one partition, RF=3, 4 GB on each replica</text>
  <rect x="390" y="208" width="350" height="110" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="404" y="228" font-size="12" font-weight="700" fill="#1e293b">300-node ring — identical outcome</text>
  <circle cx="440" cy="270" r="26" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="424" y="274" font-size="10" fill="#1e293b">4 GB</text>
  <circle cx="510" cy="270" r="26" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="494" y="274" font-size="10" fill="#1e293b">4 GB</text>
  <circle cx="580" cy="270" r="26" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="564" y="274" font-size="10" fill="#1e293b">4 GB</text>
  <circle cx="650" cy="270" r="16" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="640" y="274" font-size="9" fill="#1e293b">idle</text>
  <circle cx="700" cy="270" r="16" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="690" y="274" font-size="9" fill="#1e293b">idle</text>
  <text x="404" y="310" font-size="11" fill="#1e293b">a partition is never split — scaling out changes nothing</text>
</svg>
```

---

## 4. Architecture & Workflow

How each anti-pattern manifests as it travels through the cluster, and where you catch it:

1. **Design time — the arithmetic is skipped.** Nobody computes `rows_per_partition`. This is the only step where the fix is free. Countermeasure: require the sizing formula in the table `comment` at code review.
2. **Schema creation — guardrails not enabled.** On 4.1+, `guardrails:` can fail a `CREATE TABLE` with too many columns or reject `ALLOW FILTERING` outright. Left at defaults, nothing objects.
3. **Write path — the partition grows.** Writes are appends, so nothing is slow yet. A 2 GB partition writes exactly as fast as a 2 KB one. **This is why the problem is invisible for months.**
4. **Flush and compaction — the first signal.** When a large partition is compacted, `system.log` emits `Writing large partition <ks>/<table>:<key> (128.402MiB)` at WARN. This log line is the single most valuable early warning Cassandra produces, and it is routinely ignored.
5. **Read path — latency degrades non-linearly.** Reads of the wide partition pull large row-index structures onto heap; GC pauses lengthen; p99 rises for *all* queries on that node, not just the offending one. Tombstone-heavy partitions log `Read N live rows and M tombstone cells` and eventually throw `TombstoneOverwhelmingException`.
6. **Hotspot emerges.** `nodetool status` shows even *ownership* (tokens) while `nodetool tablestats` and OS metrics show wildly uneven *load*. `nodetool toppartitions` names the guilty key.
7. **Repair and streaming amplify.** Anti-entropy repair streams whole partitions on mismatch; bootstrap and decommission stream them too. Operations that took an hour now take a day, and repair may not complete within `gc_grace_seconds` — which is how tombstones stop being reclaimable and zombies become possible.
8. **Remediation.** There is no in-place fix. Create a correctly-keyed table, dual-write, backfill by token range with original timestamps, verify, cut reads over, drop the old table. Budget weeks, not hours.

```svg
<svg viewBox="0 0 760 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="760" height="330" fill="#ffffff"/>
  <text x="20" y="24" font-size="15" font-weight="700" fill="#1e293b">Anti-pattern lifecycle: cheap to prevent, expensive to detect, brutal to fix</text>
  <rect x="20" y="42" width="130" height="64" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="32" y="62" font-size="11" font-weight="700" fill="#1e293b">1. design</text>
  <text x="32" y="80" font-size="10" fill="#1e293b">sizing formula</text>
  <text x="32" y="96" font-size="10" fill="#1e293b">cost: 10 minutes</text>
  <path d="M152 74 L 168 74" stroke="#16a34a" stroke-width="2"/>
  <rect x="172" y="42" width="130" height="64" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="184" y="62" font-size="11" font-weight="700" fill="#1e293b">2. guardrails</text>
  <text x="184" y="80" font-size="10" fill="#1e293b">4.1+ warn/fail</text>
  <text x="184" y="96" font-size="10" fill="#1e293b">cost: 1 config line</text>
  <path d="M304 74 L 320 74" stroke="#16a34a" stroke-width="2"/>
  <rect x="324" y="42" width="150" height="64" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="336" y="62" font-size="11" font-weight="700" fill="#1e293b">3. writes (months)</text>
  <text x="336" y="80" font-size="10" fill="#1e293b">appends stay fast</text>
  <text x="336" y="96" font-size="10" fill="#1e293b">NOTHING looks wrong</text>
  <path d="M476 74 L 492 74" stroke="#0ea5e9" stroke-width="2"/>
  <rect x="496" y="42" width="244" height="64" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="508" y="62" font-size="11" font-weight="700" fill="#1e293b">4. first signal — in the log, ignored</text>
  <text x="508" y="80" font-size="10" fill="#1e293b">WARN Writing large partition</text>
  <text x="508" y="96" font-size="10" fill="#1e293b">shop/orders:8f2a (128.402MiB)</text>
  <path d="M618 108 L 618 128 L 90 128 L 90 148" stroke="#d97706" stroke-width="1.5" fill="none"/>
  <rect x="20" y="152" width="230" height="70" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="32" y="172" font-size="11" font-weight="700" fill="#1e293b">5. reads degrade</text>
  <text x="32" y="190" font-size="10" fill="#1e293b">row index on heap → GC pauses</text>
  <text x="32" y="206" font-size="10" fill="#1e293b">p99 rises for EVERY query on the node</text>
  <path d="M252 187 L 268 187" stroke="#d97706" stroke-width="2"/>
  <rect x="272" y="152" width="230" height="70" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="284" y="172" font-size="11" font-weight="700" fill="#1e293b">6. hotspot visible</text>
  <text x="284" y="190" font-size="10" fill="#1e293b">status: even ownership</text>
  <text x="284" y="206" font-size="10" fill="#1e293b">load: 3 nodes at 90 %, 30 idle</text>
  <path d="M504 187 L 520 187" stroke="#d97706" stroke-width="2"/>
  <rect x="524" y="152" width="216" height="70" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="536" y="172" font-size="11" font-weight="700" fill="#1e293b">7. repair/stream amplify</text>
  <text x="536" y="190" font-size="10" fill="#1e293b">whole partitions streamed</text>
  <text x="536" y="206" font-size="10" fill="#1e293b">repair misses gc_grace → zombies</text>
  <rect x="20" y="240" width="720" height="76" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="34" y="262" font-size="13" font-weight="700" fill="#1e293b">8. Remediation — there is no in-place fix</text>
  <text x="34" y="284" font-size="12" fill="#1e293b">new correctly-keyed table → dual write → token-range backfill with original timestamps →</text>
  <text x="34" y="304" font-size="12" fill="#1e293b">verify per range → cut reads over → drop the old table.  Budget weeks, not hours.</text>
</svg>
```

---

## 5. Implementation

The catalogue, each with the broken schema and the fix.

**1. Unbounded partition**

```cql
-- ❌ grows forever: one partition per sensor, one row per second, no ceiling
CREATE TABLE bad.readings (
  sensor_id uuid, ts timestamp, value double,
  PRIMARY KEY ((sensor_id), ts));

-- ✅ bucketed by day: 86,400 rows ≈ 10 MB, bounded by construction
CREATE TABLE good.readings (
  sensor_id uuid, day date, ts timestamp, value double,
  PRIMARY KEY ((sensor_id, day), ts)
) WITH CLUSTERING ORDER BY (ts DESC)
  AND default_time_to_live = 2592000
  AND compaction = {'class':'TimeWindowCompactionStrategy',
                    'compaction_window_unit':'DAYS','compaction_window_size':1};
```

**2. Low-cardinality (hotspot) partition key**

```cql
-- ❌ ~200 partitions cluster-wide; 'US' carries 40 % of traffic on 3 nodes
CREATE TABLE bad.events_by_country (
  country text, ts timeuuid, payload text, PRIMARY KEY ((country), ts));

-- ✅ widen the key: 200 countries × 365 days × 32 shards = 2.3 M partitions
CREATE TABLE good.events_by_country (
  country text, day date, shard int, ts timeuuid, payload text,
  PRIMARY KEY ((country, day, shard), ts)
) WITH CLUSTERING ORDER BY (ts DESC);
-- writer: shard = abs(hash(event_id)) % 32
-- reader: fan out 32 concurrent queries, merge client-side
```

**3. Queue / job table**

```cql
-- ❌ every consume leaves a tombstone in front of the rows you read next
CREATE TABLE bad.jobs (queue_id text, job_id timeuuid, payload text,
  PRIMARY KEY ((queue_id), job_id));
SELECT * FROM bad.jobs WHERE queue_id='emails' LIMIT 10;
DELETE FROM bad.jobs WHERE queue_id='emails' AND job_id=?;
-- ReadFailure: Operation failed - received 0 responses and 1 failures
-- (TombstoneOverwhelmingException: scanned over 100000 tombstones)

-- ✅ use Kafka/Pulsar/SQS for queues. If you must use Cassandra, make each
--    consumption unit its own short-lived partition that is dropped whole:
CREATE TABLE good.jobs_by_slot (
  queue_id text, slot int, job_id timeuuid, payload text,
  PRIMARY KEY ((queue_id, slot), job_id)
) WITH default_time_to_live = 86400
  AND gc_grace_seconds = 10800
  AND compaction = {'class':'TimeWindowCompactionStrategy',
                    'compaction_window_unit':'HOURS','compaction_window_size':1};
-- consumers claim a slot, drain it, then DELETE the whole partition once —
-- a single partition-level tombstone instead of one per row
```

**4. `ALLOW FILTERING` and unbounded `IN`**

```cql
-- ❌ full cluster scan, and a 500-way scatter-gather
SELECT * FROM orders WHERE status='PENDING' ALLOW FILTERING;
SELECT * FROM orders WHERE user_id IN (…500 values…);

-- ✅ a purpose-built table; and cap IN to a handful, or issue parallel single reads
SELECT * FROM orders_by_status_day WHERE status='PENDING' AND day='2026-07-22';
```

**5. Read-before-write, and 6. sequential partition keys**

```cql
-- ❌ lost update under concurrency, and two round trips
SELECT balance FROM accounts WHERE id=?;         -- app computes balance - 50
UPDATE accounts SET balance=? WHERE id=?;
-- ✅ either a lightweight transaction (Paxos, ~4 round trips — use sparingly)
UPDATE accounts SET balance=950 WHERE id=? IF balance=1000;
-- ✅ or, better, an append-only ledger aggregated on read
CREATE TABLE good.ledger (account_id uuid, entry_id timeuuid, delta_cents bigint,
  PRIMARY KEY ((account_id), entry_id)) WITH CLUSTERING ORDER BY (entry_id DESC);

-- ❌ every write in an hour targets one token: a migrating write hotspot
PRIMARY KEY ((current_hour), event_id)
-- ✅ prefix with a spreader so writes hit N tokens concurrently
PRIMARY KEY ((current_hour, shard), event_id)   -- shard = hash(event_id) % 16
```

Detection:

```bash
grep "Writing large partition" /var/log/cassandra/system.log | tail -3   # the key line
# WARN Writing large partition shop/notifications:9f13c2a1 (312.884MiB) to sstable ...

nodetool tablehistograms shop notifications
# Percentile  SSTables  Write(μs)  Read(μs)   Partition Size   Cell Count
# 99%            8.00      88.15   43388.63        129557750      1629722
# Max           14.00     943.13  186563.16        328050604      4139110   <-- 328 MB

nodetool toppartitions shop notifications 10000       # name the guilty key, live
# WRITES Sampler: Cardinality ~412 Top 10: 9f13c2a1 (48211 writes)

nodetool tablestats shop.jobs | grep -i tombstone
# Average tombstones per slice (last five minutes): 41822.0

nodetool status shop           # ownership even, load wildly uneven = hotspot
# UN 10.0.1.11  1.42 TiB  16  6.2%  ...
# UN 10.0.1.12  184 GiB   16  6.3%  ...
```

```cql
-- 4.0+ virtual tables: query these instead of scraping JMX
SELECT keyspace_name, table_name, max_partition_size
FROM system_views.max_partition_size WHERE max_partition_size > 104857600 ALLOW FILTERING;
SELECT * FROM system_views.tombstones_scanned;
SELECT * FROM system_views.settings WHERE name LIKE 'guardrails%';
```

```yaml
# cassandra.yaml (4.1+) — turn the failure modes into build-time errors
guardrails:
  partition_size_warn_threshold: 100MiB
  partition_tombstones_warn_threshold: 1000
  columns_per_table_warn_threshold: 50
  secondary_indexes_per_table_fail_threshold: 3
  materialized_views_per_table_fail_threshold: 1
  collection_size_warn_threshold: 64KiB
  items_per_collection_warn_threshold: 200
  in_select_cartesian_product_fail_threshold: 25
  allow_filtering_enabled: false
  read_before_write_list_operations_enabled: false

tombstone_warn_threshold: 1000
tombstone_failure_threshold: 100000
compaction_large_partition_warning_threshold: 100MiB
```

> **Optimization:** the cheapest possible intervention is a **CI check on the schema**, not a runtime guardrail. Parse every `CREATE TABLE` in the repository, require a `comment` containing the rows-per-partition estimate, and fail the build if a table has a single-column partition key whose cardinality is declared below `num_nodes × num_tokens × 10`, or if any clustering column is time-based without a bucket in the partition key. This catches every anti-pattern in this chapter *before* the data exists, which is the only point at which the fix costs minutes rather than weeks.

---

## 6. Advantages, Disadvantages & Trade-offs

Each anti-pattern exists because it has a genuine short-term appeal. This table is the honest accounting.

| Aspect | Apparent Strength | Real Cost / Trade-off |
| --- | --- | --- |
| Unbounded partition | Simplest possible key; no bucket logic in reads or writes | Fails silently for months, then breaks compaction, repair, GC and reads at once; unfixable in place |
| Low-cardinality key | Natural, readable key (`country`, `status`) | 3 nodes saturate while the rest idle; adding nodes makes it worse, not better |
| Queue in Cassandra | One less system to operate | Tombstone accumulation guarantees read failure; the workload Cassandra is worst at |
| `ALLOW FILTERING` | The query compiles and works in staging | Full cluster scan; cost scales with total data, not with matches; unpredictable timeouts |
| Large `IN` on partition key | One statement instead of N | N-way scatter-gather; p99 is the max of N reads; coordinator heap pressure |
| Read-before-write | Familiar imperative style from SQL | Lost updates under concurrency, two round trips, and no atomicity without Paxos |
| Lowering `gc_grace_seconds` | Tombstones disappear faster; reads recover | Zombie data if repair does not complete within the new window |
| Raising tombstone thresholds | Failing queries start succeeding | Converts a loud, localized failure into slow, cluster-wide degradation |
| Sequential partition key | Trivially ordered and easy to reason about | The entire write load lands on one token range at a time |
| Many secondary indexes | No new tables, no application changes | Write amplification per index, plus scatter-gather reads that worsen as the cluster grows |

---

## 7. Common Mistakes & Best Practices

1. ⚠️ **No sizing arithmetic before `CREATE TABLE`.** ✅ Compute `rows_per_partition` and `partition_bytes` and put the calculation in the table `comment`. Reject the schema at review if it is missing.
2. ⚠️ **A time-based clustering column with no bucket in the partition key.** ✅ Every time-series table needs `((entity, bucket), ts)`; choose the bucket from the **peak** rate so the partition stays under 100 MB / 100k rows.
3. ⚠️ **Low-cardinality partition keys** (`country`, `status`, `tenant` with 12 tenants). ✅ Widen with a day and/or a `hash(id) % N` shard, and read with bounded concurrent queries.
4. ⚠️ **Using Cassandra as a queue or a mutable-state store.** ✅ Use Kafka, Pulsar or SQS. If you must, make each unit of work a short-lived partition deleted whole (one partition tombstone) with a small `gc_grace_seconds` and hourly TWCS.
5. ⚠️ **`ALLOW FILTERING` in application code.** ✅ Set `allow_filtering_enabled: false` and treat the resulting error as a modeling signal, not an obstacle.
6. ⚠️ **Deleting rows in a partition you read from frequently.** ✅ Prefer TTL-driven expiry with TWCS so whole SSTables are dropped without a read-path scan, and delete at partition granularity where possible.
7. ⚠️ **Lowering `gc_grace_seconds` to make tombstones go away.** ✅ Fix the write pattern. If you must lower it, guarantee that a full repair completes within the new window, or you will resurrect deleted data.
8. ⚠️ **Raising `tombstone_failure_threshold` when reads start failing.** ✅ Leave it at 100,000; it is a circuit breaker protecting the whole node, not a limit to be tuned away.
9. ⚠️ **Read-modify-write on hot rows.** ✅ Model as append-only events and aggregate on read, or use `IF` conditions (Paxos) knowingly and sparingly — roughly 4 round trips and a partition-level serialization point.
10. ⚠️ **Large `IN` clauses on the partition key.** ✅ Cap at a handful of values (`in_select_cartesian_product_fail_threshold: 25`) and issue parallel single-partition reads instead.
11. ⚠️ **Mutable partition keys** (keying on `status`, which changes). ✅ Partition on immutable attributes; represent transitions as new rows with a TTL.
12. ⚠️ **Ignoring `Writing large partition` WARNs in `system.log`.** ✅ Alert on that exact string. It is Cassandra telling you, months in advance, exactly which key will cause the incident.

---

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Start with the logs: `grep "Writing large partition" system.log` names the keyspace, table and partition key with its size, and `grep "Read .* live rows and .* tombstone"` plus `TombstoneOverwhelmingException` identifies tombstone problems. Then quantify with `nodetool tablehistograms <ks> <table>` — the *Max Partition Size* and *Cell Count* columns are the ground truth — and `nodetool tablestats` for average and maximum tombstones per slice. `nodetool toppartitions <ks> <table> 10000` samples live traffic and names the hottest partition for reads and writes separately, which is how you distinguish a *size* problem from a *traffic* problem. For deep forensics, `sstablemetadata` reports estimated droppable tombstone ratios per SSTable and `sstabledump` shows the actual tombstone entries and their `deletion_time`. Finally, `TRACING ON` in cqlsh prints live rows versus tombstone cells for any specific query.

**Monitoring.** The metrics that matter are per-table, not global: `org.apache.cassandra.metrics:type=Table,keyspace=<ks>,scope=<table>,name=EstimatedPartitionSizeHistogram` (alert on max > 100 MB), `...name=TombstoneScannedHistogram` (alert on p99 > 200, well before the 1,000 warn), `...name=LiveScannedHistogram`, `...name=SSTablesPerReadHistogram` (p99 above ~4 means compaction is behind), and `...name=ReadLatency`. For hotspots, compare `...name=ReadLatency` and `...name=WriteLatency` counts *across nodes* — the tokens are even, so a count skew is a key-design skew. Watch `...type=Compaction,name=PendingTasks` and GC pause duration (`java.lang:type=GarbageCollector`), since wide partitions surface first as GC. On 4.0+, `system_views.max_partition_size`, `system_views.tombstones_scanned` and `system_views.local_read_latency` expose the same data over CQL, which is far easier to scrape and alert on.

**Security.** Anti-patterns have a security dimension that is easy to miss. An unbounded partition is a denial-of-service surface: any user who can append to a partition they control (comments, notifications, audit entries) can degrade the node holding it — so guardrails on partition size are a security control, not just a hygiene one. `ALLOW FILTERING` reachable from a user-facing endpoint is a trivially exploitable resource-exhaustion vector; disable it cluster-wide. Multi-tenant clusters keyed by `tenant_id` combine both problems: a coarse tenant key means one noisy tenant starves the others, so always compose the tenant with a bucket or shard. Finally, tombstone-heavy tables complicate right-to-erasure compliance, because a deleted row is not actually gone until `gc_grace_seconds` has passed *and* compaction has rewritten the SSTables — document that lag in your data-deletion policy.

**Performance & scaling.** The defining property of every anti-pattern here is that horizontal scaling does not help. A partition is never split, so a 4 GB partition is 4 GB on `RF` nodes whether the ring has 3 nodes or 300; a hot key is hot on the same `RF` nodes regardless. Adding nodes to a hotspotted cluster increases coordination overhead and streaming work while leaving the bottleneck untouched, which is why "we scaled out and it got worse" is a common and entirely predictable report. The only real remedy is a key change, which means a new table, dual writes, a token-range backfill using the original write timestamps, per-range verification, a read cutover and finally a drop. Plan that as a multi-week project with its own rollback path — and then prevent the next one with guardrails and a CI schema check, because prevention costs ten minutes and remediation costs a quarter.

---

## 9. Interview Questions

**Q: What is the recommended maximum partition size, and why does it matter?**
A: Under 100 MB and under 100,000 rows. Beyond that, compaction must rewrite huge contiguous regions, repair streams whole partitions on any mismatch, reads pull large row-index structures onto heap and cause GC pauses, and — critically — the partition can never be split or rebalanced across nodes.

**Q: Why is using Cassandra as a queue an anti-pattern?**
A: Consuming an item deletes it, and a delete is a tombstone written at the front of the clustering order. Every subsequent read must scan past all accumulated tombstones to reach live rows, so read cost grows with consumption rate until `tombstone_failure_threshold` aborts the query. Tombstones cannot be reclaimed until `gc_grace_seconds` (10 days by default) has elapsed.

**Q: How do you fix an unbounded partition?**
A: Add a bucket to the partition key — a time bucket for time-series data, or a `hash(id) % N` shard — sized so the worst-case partition stays under the budget. It cannot be done in place: you create a new table, dual-write, backfill by token range with the original timestamps, verify, and cut reads over.

**Q: What causes a hotspot when `nodetool status` shows even ownership?**
A: Ownership is about tokens; load is about keys. A low-cardinality or heavily skewed partition key means most traffic hashes to a few tokens, so a handful of nodes carry the load while the rest idle. `nodetool toppartitions` names the offending key.

**Q: What is `gc_grace_seconds` and why is lowering it risky?**
A: It is the window (default 864000 seconds, 10 days) during which a tombstone must be retained so that repair can propagate the deletion to every replica before compaction drops it. If you lower it below your repair cycle, a replica that missed the delete can resurrect the row during a later repair — a zombie.

**Q: Why is `ALLOW FILTERING` dangerous?**
A: It authorizes Cassandra to read rows and discard the non-matching ones server-side, so the query's cost is proportional to the total data scanned rather than to the rows returned, and without a partition key it does that across the whole ring. It works in staging on small data and times out in production on large data.

**Q: What is wrong with a large `IN` clause on the partition key?**
A: Each value is a separate partition on a potentially different replica set, so the coordinator performs an N-way scatter-gather; the query's latency is the maximum of N reads and its failure probability compounds. Issuing N parallel single-partition reads from the client is faster and degrades gracefully.

**Q: (Senior) A table has healthy metrics everywhere except one node showing 4× the read latency. Diagnose it.**
A: Suspect a wide or hot partition owned by that node. Check `system.log` on it for `Writing large partition`, run `nodetool tablehistograms` and compare *Max Partition Size* against the other nodes, then `nodetool toppartitions` to name the key and distinguish read-hot from write-hot. Correlate with GC logs — a wide partition typically shows up as longer, more frequent pauses on that node. If it is size, the fix is a key change and migration; if it is purely traffic on a legitimately popular key, shard the key or put a cache in front of that partition.

**Q: (Senior) Your team wants to raise `tombstone_failure_threshold` to stop queries failing. What do you say?**
A: No. The threshold is a circuit breaker that fails one query to protect the node's heap; raising it converts a loud, contained failure into GC pressure and latency degradation for every query on that node. The real fix is to remove the tombstone source — usually whole-collection assignment, a queue pattern, or row-level deletes in a hot partition — and to shift to TTL-based expiry with TWCS so whole SSTables are dropped without a read-path scan.

**Q: (Senior) How would you migrate a 2 TB-per-node table off a bad partition key with zero downtime?**
A: Create the correctly-keyed table, deploy dual writes behind a feature flag so all new data lands in both, and backfill history with a throttled token-range job (Spark Cassandra Connector or a paged reader) that writes with the *original* `USING TIMESTAMP` values so backfilled rows never overwrite newer live writes. Verify by comparing per-token-range counts and spot-checking rows, then flip reads behind the flag, monitor a full traffic cycle including peak, and only then stop the dual write and drop the old table. Throttle throughout so the backfill never competes with live traffic for compaction and I/O.

**Q: Which single log line predicts most Cassandra incidents?**
A: `WARN ... Writing large partition <keyspace>/<table>:<key> (<size>)`, emitted during compaction when a partition exceeds `compaction_large_partition_warning_threshold` (100 MiB). It names the exact keyspace, table and partition key months before the partition becomes fatal, and it is routinely ignored. Alert on it.

**Q: What are Cassandra 4.1 guardrails and which ones would you enable first?**
A: They are a `cassandra.yaml` subsystem that warns or fails on dangerous schema and query shapes. The first four to enable are `allow_filtering_enabled: false`, `partition_size_warn_threshold: 100MiB`, `secondary_indexes_per_table_fail_threshold: 3`, and `items_per_collection_warn_threshold: 200` — together they block or flag the majority of the failure modes in this chapter before they reach production.

---

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Cassandra fails on structure, not volume. A partition is indivisible — it is the unit of placement, read, repair, compaction and streaming — so a partition that grows without bound cannot be fixed by adding nodes, and a low-cardinality key concentrates all traffic on `RF` machines forever. Always bucket time-series keys from the **peak** rate and keep partitions under **100 MB / 100k rows**. Deletes are writes: tombstones survive `gc_grace_seconds` (864000) and are scanned on every read, which is why queues, row-level deletes in hot partitions and whole-collection assignment destroy read latency. Never use `ALLOW FILTERING`, never use a large `IN` on the partition key, never read-modify-write. The earliest warning is the `Writing large partition` log line; the cheapest prevention is 4.1 guardrails plus a CI check on `CREATE TABLE`. Remediation is always a new table, dual writes and a token-range backfill — weeks of work to avoid ten minutes of arithmetic.

| Item | Value / Command |
| --- | --- |
| Partition budget | < 100 MB, < 100,000 rows |
| Large-partition WARN | `compaction_large_partition_warning_threshold: 100MiB` |
| Tombstone thresholds | warn `1000`, fail `100000` |
| `gc_grace_seconds` | `864000` (10 days) |
| Find big partitions | `nodetool tablehistograms <ks> <tbl>` (Max Partition Size) |
| Find hot partitions | `nodetool toppartitions <ks> <tbl> 10000` |
| Tombstone stats | `nodetool tablestats <ks>.<tbl> \| grep -i tombstone` |
| The predictive log line | `grep "Writing large partition" system.log` |
| Disable filtering | `allow_filtering_enabled: false` |
| Cap `IN` | `in_select_cartesian_product_fail_threshold: 25` |
| Bucketing fix | `((entity, day), ts)` or `((entity, day, shard), ts)` |
| Virtual tables (4.0+) | `system_views.max_partition_size`, `system_views.tombstones_scanned` |

**Flash cards**

- **Why can't adding nodes fix a 4 GB partition?** → A partition is never split; it lands entirely on `RF` nodes regardless of ring size.
- **Why is a queue table fatal?** → Each consume writes a tombstone in front of the live rows; reads scan them all until the query aborts.
- **What is the peak-rate rule?** → Choose the bucket granularity from peak write rate, never from the average.
- **What does lowering `gc_grace_seconds` risk?** → Zombie rows, if a full repair does not complete inside the shortened window.
- **Which log line predicts the incident months early?** → `WARN Writing large partition <ks>/<table>:<key> (<size>)`.

---

## 11. Hands-On Exercises & Mini Project

- [ ] Build `bad.readings` with `PRIMARY KEY ((sensor_id), ts)`, load 5 M rows for 3 sensors, run `nodetool flush` and `nodetool compact`, then find the `Writing large partition` WARN in `system.log` and confirm the size with `nodetool tablehistograms`.
- [ ] Rebuild the same data as `((sensor_id, day), ts)` with TWCS and compare max partition size, read p99 and compaction time against the unbucketed version.
- [ ] Implement the queue anti-pattern: insert 200k jobs, consume and delete them in batches of 10, and record how many consume cycles it takes to hit `tombstone_warn_threshold` and then `TombstoneOverwhelmingException`. Capture the exact exception text.
- [ ] Create a `((country), ts)` table, load skewed data (40 % `US`), then compare per-node read counts from `nodetool tablestats` against `nodetool status` ownership to demonstrate that even token ownership does not imply even load. Fix it with a shard column and re-measure.
- [ ] Enable the 4.1 guardrails block from section 5 and try to violate each one — 60 columns, 4 secondary indexes, an `ALLOW FILTERING` query, a 300-item collection. Record the exact error or warning for your team runbook.

### Mini Project — "An anti-pattern detector for your cluster"

**Goal.** Ship a tool that finds every latent anti-pattern in a running cluster before it becomes an incident.

**Requirements.**
1. Read `system_schema.tables` and `system_schema.columns` and statically flag: single-column partition keys, time-based clustering columns without a bucket in the partition key, tables with more than three secondary indexes, tables with materialized views, and missing table `comment` sizing notes.
2. Query `system_views.max_partition_size` and `system_views.tombstones_scanned` (4.0+) or the equivalent JMX beans, and rank every table by max partition size and by p99 tombstones scanned.
3. Parse `system.log` across all nodes for `Writing large partition`, `TombstoneOverwhelmingException` and `Batch for ... is of size`, and aggregate by keyspace, table and partition key.
4. Emit a single prioritized report: table, anti-pattern, current severity, projected time-to-failure at the observed growth rate, and the recommended fix.
5. Package it as a scheduled job that posts to chat, and add a CI mode that fails a pull request introducing a `CREATE TABLE` matching any static rule.

**Extensions.** Add growth projection by sampling partition sizes over a week and extrapolating to the 100 MB threshold. Add a remediation planner that generates the new schema, the dual-write skeleton and the token-range backfill script for a flagged table. Extend the log parser to correlate GC pauses with reads of specific wide partitions.

---

## 12. Related Topics & Free Learning Resources

**Sibling chapters.** *Query-First Data Modeling* is the methodology that prevents everything catalogued here. *Denormalization & Table-per-Query* covers the migration procedure this chapter keeps referring to. *Secondary Indexes, SAI & SASI* and *Materialized Views* are two anti-patterns' worth of shortcuts in their own right. *Data Types, Collections & UDTs* covers the collection-tombstone trap, and *Tombstones, TTL & gc_grace_seconds* covers the reclamation rules in full.

- **Cassandra Anti-Patterns** — DataStax Docs · *Intermediate* · The canonical list of workloads and schemas Cassandra handles badly, including queues and read-before-write. <https://docs.datastax.com/en/dse-planning/docs/anti-patterns.html>
- **Guardrails — Apache Cassandra 4.1 Documentation** — Apache Software Foundation · *Intermediate* · Every guardrail, its default and its failure behaviour; the fastest way to make anti-patterns loud. <https://cassandra.apache.org/doc/latest/cassandra/managing/configuration/cass_yaml_file.html>
- **About Deletes and Tombstones in Cassandra** — The Last Pickle · *Intermediate–Advanced* · The definitive explanation of tombstone types, `gc_grace_seconds`, zombie data and why queues fail. <https://thelastpickle.com/blog/2016/07/27/about-deletes-and-tombstones.html>
- **CASSANDRA-9754 / large partition handling** — Apache JIRA · *Advanced* · The engineering history of wide-partition support, including the birds-eye row index redesign and its limits. <https://issues.apache.org/jira/browse/CASSANDRA-9754>
- **How Discord Stores Trillions of Messages** — Discord Engineering · *Intermediate* · A real account of bucketed partitions, hot partitions caused by popular channels, and the operational limits they hit. <https://discord.com/blog/how-discord-stores-trillions-of-messages>
- **Cassandra Data Modeling Best Practices** — Apache Cassandra Documentation · *Beginner–Intermediate* · The official rules on partition sizing, bucketing and even key distribution. <https://cassandra.apache.org/doc/latest/cassandra/developing/data-modeling/index.html>
- **Spark Cassandra Connector** — DataStax (GitHub) · *Advanced* · The reference implementation of throttled token-range scanning that every anti-pattern migration depends on. <https://github.com/datastax/spark-cassandra-connector>
- **ScyllaDB University — Common Data Modeling Mistakes** — ScyllaDB · *Intermediate* · Free lessons on large partitions, hotspots and how a compatible engine surfaces the same failure modes. <https://university.scylladb.com/courses/data-modeling/>

---

*Apache Cassandra Handbook — chapter 12.*
