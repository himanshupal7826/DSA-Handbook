# 16 · Paging, ALLOW FILTERING & Query Limits

> **In one line:** Cassandra will happily let you write a query that scans the entire cluster — paging, `LIMIT`, and the token function are the tools that keep every read bounded, and `ALLOW FILTERING` is the keyword that tells you the model is wrong.

---

## 1. Overview

Every distributed database eventually confronts the same problem: a client asks for more data than a single response can carry, or asks a question whose answer requires visiting every node. Relational systems solve this with cursors and query planners that produce a slow-but-correct answer. Cassandra refuses that bargain. Its entire performance story rests on the assumption that a query touches one partition on `RF` replicas, so it makes unbounded queries either illegal at parse time or explicitly opt-in via `ALLOW FILTERING`.

**Server-side paging** is the mechanism that makes large result sets safe. Introduced with native protocol v2 (Cassandra 2.0), it lets the coordinator return `fetch_size` rows (default 5,000) plus an opaque **paging state** — a serialised cursor holding the partition key and clustering position where the scan stopped. The client sends that state back to continue. Crucially the state lives on the *client*, not the server: there is no server-side cursor holding memory or locks, which is why a Cassandra coordinator can serve thousands of concurrent paged reads without state explosion. Before paging existed, developers wrote manual `WHERE ck > last_seen LIMIT n` loops and the driver ecosystem was full of subtle off-by-one bugs.

**`ALLOW FILTERING`** is a deliberately awkward incantation. Cassandra rejects any `WHERE` clause it cannot satisfy by seeking directly to a known position, and the error message names the escape hatch. Adding it does not make the query fast; it makes the query *legal*, and the query then reads every row in scope and discards non-matching ones on the coordinator. On a single partition that is often fine — filtering 200 rows down to 3 costs nothing. Across the whole table it is a cluster-wide scan that will time out, blow up heap, and page your on-call.

The two are connected: paging is what makes a large legitimate result set survivable, and `ALLOW FILTERING` is what makes an illegitimate one *appear* survivable until data volume grows. The third leg is the **`token()` function**, which lets you walk the entire ring deterministically in bounded chunks — the correct way to do a full-table scan when you genuinely need one.

A concrete example: an e-commerce platform lists a customer's orders. `SELECT ... WHERE customer_id = ? AND order_month = ?` with `fetch_size = 100` pages through a bounded partition — correct. A product manager then asks for "all orders over $500 last month". Written as `SELECT ... WHERE total_cents > 50000 ALLOW FILTERING` it scans every partition on every node and takes 40 seconds on a small dataset, then times out at scale. Written as a second table `orders_by_value((order_month, value_bucket), total_cents, order_id)` it is a single-partition range read in 3 ms. Same question, two orders of magnitude apart.

## 2. Core Concepts

- **Paging state** — an opaque byte string returned with a page, encoding the partition key and clustering position where the scan stopped plus remaining-limit bookkeeping. Client-held; safe to serialise into a URL or cache for stateless pagination.
- **`fetch_size` / page size** — how many rows the coordinator returns per page (driver default 5,000). It is a *row* count, not a byte count, so wide rows still need care.
- **`LIMIT n`** — a hard cap on total rows returned across all pages. Applied after filtering, so `LIMIT 10 ALLOW FILTERING` can still scan millions of rows to find ten matches.
- **`PER PARTITION LIMIT n`** — caps rows returned *per partition*, evaluated before `LIMIT`. The efficient way to get "latest 3 events per device" across many devices.
- **`ALLOW FILTERING`** — an explicit acknowledgement that the query requires reading and discarding rows. Required whenever the `WHERE` clause cannot be answered by a direct seek.
- **Range (multi-partition) query** — any `SELECT` without a fully-specified partition key. Executed as a scan over token ranges, coordinated node by node.
- **`token()` function** — exposes the partitioner's hash of the partition key, e.g. `WHERE token(pk) > ? AND token(pk) <= ?`. The only way to range-scan partitions deterministically.
- **`concurrency_factor` / range slicing** — the coordinator's heuristic for how many token ranges to query in parallel during a range scan; it starts at 1 and adapts based on rows returned per range.
- **`read_request_timeout`** — 5 s default; the wall the coordinator hits when a scan is too wide. `range_request_timeout` (10 s default) applies to multi-partition scans specifically.
- **Guardrails (4.1+)** — `guardrails.page_size_warn_threshold`, `guardrails.allow_filtering_enabled`, `guardrails.partition_keys_in_select_warn_threshold`: server-side policy that can ban `ALLOW FILTERING` outright.

## 3. Theory & Internals

**How paging actually works.** When a `SELECT` executes, the coordinator builds a `ReadCommand` with a `DataLimits` object carrying the page size. Rows stream from replicas into the coordinator, which counts them; at `fetch_size` rows it stops, serialises a `PagingState` containing `(partitionKey, clusteringPrefix, remaining, remainingInPartition)`, and returns. There is no open iterator on the server — the next page re-executes the query with an added lower bound derived from the paging state.

That re-execution is the source of paging's one real gotcha: **pages are not a consistent snapshot**. A row inserted between page 1 and page 2 at a position already passed will never be seen; a row inserted ahead of the cursor will appear. Deletion behaves similarly. If you need snapshot semantics you must derive them yourself (e.g. page by a monotonic clustering key and record a ceiling before starting).

Paging state is also **not portable across queries**: it encodes positions valid only for the exact statement and bound values that produced it. Feeding it to a different query is undefined behaviour, which is why treating it as an opaque token in your API is not just style advice.

**How filtering actually works.** Cassandra's `WHERE` clause is compiled into restrictions. A restriction is *satisfiable by seek* if it is an equality on the partition key, or an equality/range on clustering columns in declaration order, or an index lookup. Anything else — a predicate on a regular column, an equality on a clustering column with an earlier one unrestricted, a range on a partition-key component — requires reading candidate rows and evaluating the predicate in memory. Cassandra computes this at prepare time and throws:

```
InvalidRequest: Cannot execute this query as it might involve data filtering and thus may
have unpredictable performance. If you want to execute this query despite the performance
unpredictability, use ALLOW FILTERING
```

The phrase "unpredictable performance" is precise. The cost of a filtered query is not a function of the result size; it is a function of the *scanned* size, which the query text does not reveal. A `LIMIT 10` on a filtered query looks cheap and can read 40 million rows.

**Range-scan mechanics.** A multi-partition `SELECT` is executed by `StorageProxy.getRangeSlice`. The coordinator splits the full token ring into ranges bounded by replica ownership, then queries them with an adaptive `concurrencyFactor`: it starts with one range, measures rows returned, and estimates how many further ranges are needed to fill the page. Sparse matches mean many rounds; a `LIMIT 10` over a table where matches are one-in-a-million degenerates into scanning nearly the whole ring, one range at a time, until `range_request_timeout` fires.

```svg
<svg viewBox="0 0 720 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="720" height="320" fill="#ffffff"/>
  <text x="360" y="24" text-anchor="middle" font-size="15" font-weight="600" fill="#1e293b">Single-partition paging vs full-ring filtered scan</text>
  <rect x="20" y="46" width="320" height="120" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="180" y="68" text-anchor="middle" font-size="12" font-weight="600" fill="#1e293b">Bounded: pk fully specified</text>
  <rect x="40" y="80" width="280" height="24" rx="4" fill="#ffffff" stroke="#16a34a" stroke-width="1"/>
  <text x="180" y="97" text-anchor="middle" font-size="11" fill="#1e293b">page 1: rows 1..100  + pagingState</text>
  <rect x="40" y="108" width="280" height="24" rx="4" fill="#ffffff" stroke="#16a34a" stroke-width="1"/>
  <text x="180" y="125" text-anchor="middle" font-size="11" fill="#1e293b">page 2: resume at clustering pos</text>
  <text x="180" y="152" text-anchor="middle" font-size="11" fill="#1e293b">1 partition, RF replicas, O(page size)</text>
  <rect x="380" y="46" width="320" height="120" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="540" y="68" text-anchor="middle" font-size="12" font-weight="600" fill="#1e293b">Unbounded: ALLOW FILTERING</text>
  <rect x="400" y="80" width="60" height="24" rx="4" fill="#ffffff" stroke="#d97706" stroke-width="1"/>
  <text x="430" y="97" text-anchor="middle" font-size="10" fill="#1e293b">range 1</text>
  <rect x="466" y="80" width="60" height="24" rx="4" fill="#ffffff" stroke="#d97706" stroke-width="1"/>
  <text x="496" y="97" text-anchor="middle" font-size="10" fill="#1e293b">range 2</text>
  <rect x="532" y="80" width="60" height="24" rx="4" fill="#ffffff" stroke="#d97706" stroke-width="1"/>
  <text x="562" y="97" text-anchor="middle" font-size="10" fill="#1e293b">range 3</text>
  <rect x="598" y="80" width="82" height="24" rx="4" fill="#ffffff" stroke="#d97706" stroke-width="1"/>
  <text x="639" y="97" text-anchor="middle" font-size="10" fill="#1e293b">... range N</text>
  <text x="540" y="125" text-anchor="middle" font-size="11" fill="#1e293b">read every row, discard non-matching</text>
  <text x="540" y="152" text-anchor="middle" font-size="11" fill="#1e293b">cost = SCANNED rows, not returned rows</text>
  <rect x="20" y="186" width="680" height="60" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="360" y="208" text-anchor="middle" font-size="12" font-weight="600" fill="#1e293b">PagingState = (partitionKey, clusteringPrefix, remaining, remainingInPartition)</text>
  <text x="360" y="230" text-anchor="middle" font-size="11" fill="#1e293b">Held by the client. No server cursor, no lock, no snapshot isolation.</text>
  <text x="360" y="272" text-anchor="middle" font-size="11" fill="#1e293b">LIMIT 10 on a filtered query can still scan 40,000,000 rows &#8212; the plan cost is invisible in the SQL.</text>
  <text x="360" y="296" text-anchor="middle" font-size="11" fill="#1e293b">PER PARTITION LIMIT applies before LIMIT and is evaluated on the replica, not the coordinator.</text>
</svg>
```

**When `ALLOW FILTERING` is actually fine.** Two cases. First, when the partition key is fully specified and you are filtering *within* one bounded partition: `WHERE device_id = ? AND status = 'ERROR' ALLOW FILTERING` reads at most one partition's worth of rows and is perfectly reasonable if that partition is bounded. Second, in one-off analytical jobs run with explicit token-range parallelism and a long timeout, where you have accepted the cost. Everything else is a modelling defect.

## 4. Architecture & Workflow

Walk a paged single-partition read and then a filtered range scan:

1. **Client sets `fetch_size`.** The driver sends the prepared statement with `result_page_size = 100` in the protocol frame. No `LIMIT` is set, so the full partition is eligible.
2. **Coordinator plans.** It sees a fully-specified partition key, computes the token, selects `RF` replicas, and issues a `SinglePartitionReadCommand` with `DataLimits.cqlLimits(NO_LIMIT, 100)`.
3. **Replica reads and stops early.** Each replica merges memtable + SSTables for that partition, streaming rows in clustering order, and stops once 100 live rows are produced. Tombstones scanned along the way still count toward `tombstone_failure_threshold`.
4. **Coordinator serialises paging state.** After digest reconciliation it emits 100 rows plus a `PagingState` pointing at clustering position 101.
5. **Client requests page 2.** The driver resends the same statement with the paging state; the coordinator re-plans the query with an implicit `ck > <saved position>` bound. Steps 2–4 repeat.
6. **Termination.** When a page comes back with a null paging state, iteration is complete. The driver's `has_more_pages` / `ResultSet.getExecutionInfo().getPagingState()` exposes this.
7. **Now the filtered query.** `SELECT * FROM orders WHERE total_cents > 50000 ALLOW FILTERING LIMIT 20`. The coordinator sees no partition key restriction and builds a `PartitionRangeReadCommand` over the whole token ring.
8. **Adaptive range concurrency.** It queries the first token range with `concurrencyFactor = 1`, gets 0 matching rows out of 12,000 scanned, and estimates it needs ~far more ranges; it raises concurrency and queries several ranges in parallel.
9. **Fan-out amplification.** Each range is served by its own replica set, so a single client query becomes hundreds of internal reads spread across every node, all buffering results back to one coordinator.
10. **Timeout or heap pressure.** Either `range_request_timeout` (10 s) fires and the client sees `ReadTimeoutException`, or the coordinator's heap spikes and GC pauses cascade into unrelated queries on that node.

```svg
<svg viewBox="0 0 720 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="720" height="330" fill="#ffffff"/>
  <text x="360" y="24" text-anchor="middle" font-size="15" font-weight="600" fill="#1e293b">Paging round trips and the token-range walk</text>
  <rect x="20" y="48" width="100" height="150" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="70" y="70" text-anchor="middle" font-size="12" font-weight="600" fill="#1e293b">Client</text>
  <text x="70" y="94" text-anchor="middle" font-size="10" fill="#1e293b">fetch_size</text>
  <text x="70" y="110" text-anchor="middle" font-size="10" fill="#1e293b">= 100</text>
  <text x="70" y="140" text-anchor="middle" font-size="10" fill="#1e293b">holds</text>
  <text x="70" y="156" text-anchor="middle" font-size="10" fill="#1e293b">pagingState</text>
  <rect x="180" y="48" width="130" height="150" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="245" y="70" text-anchor="middle" font-size="12" font-weight="600" fill="#1e293b">Coordinator</text>
  <text x="245" y="94" text-anchor="middle" font-size="10" fill="#1e293b">re-plans each page</text>
  <text x="245" y="112" text-anchor="middle" font-size="10" fill="#1e293b">no server cursor</text>
  <path d="M122 88 L176 88" stroke="#4f46e5" stroke-width="2" fill="none"/>
  <path d="M176 88 l-9 -5 v10 z" fill="#4f46e5"/>
  <text x="149" y="82" text-anchor="middle" font-size="9" fill="#1e293b">p1</text>
  <path d="M176 118 L122 118" stroke="#0ea5e9" stroke-width="2" fill="none"/>
  <path d="M122 118 l9 -5 v10 z" fill="#0ea5e9"/>
  <text x="149" y="112" text-anchor="middle" font-size="9" fill="#1e293b">100 rows</text>
  <path d="M122 148 L176 148" stroke="#4f46e5" stroke-width="2" fill="none"/>
  <path d="M176 148 l-9 -5 v10 z" fill="#4f46e5"/>
  <text x="149" y="142" text-anchor="middle" font-size="9" fill="#1e293b">p2 + state</text>
  <circle cx="500" cy="130" r="80" fill="none" stroke="#4f46e5" stroke-width="2"/>
  <text x="500" y="42" text-anchor="middle" font-size="12" font-weight="600" fill="#1e293b">token ring</text>
  <circle cx="500" cy="50" r="6" fill="#16a34a"/>
  <circle cx="570" cy="90" r="6" fill="#16a34a"/>
  <circle cx="570" cy="170" r="6" fill="#16a34a"/>
  <circle cx="500" cy="210" r="6" fill="#16a34a"/>
  <circle cx="430" cy="170" r="6" fill="#16a34a"/>
  <circle cx="430" cy="90" r="6" fill="#16a34a"/>
  <text x="500" y="120" text-anchor="middle" font-size="10" fill="#1e293b">range scan visits</text>
  <text x="500" y="136" text-anchor="middle" font-size="10" fill="#1e293b">every range in turn</text>
  <text x="500" y="152" text-anchor="middle" font-size="10" fill="#1e293b">concurrencyFactor adapts</text>
  <path d="M314 110 L414 110" stroke="#d97706" stroke-width="2" fill="none"/>
  <path d="M414 110 l-9 -5 v10 z" fill="#d97706"/>
  <text x="364" y="103" text-anchor="middle" font-size="9" fill="#1e293b">ALLOW FILTERING</text>
  <rect x="20" y="228" width="680" height="72" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="360" y="250" text-anchor="middle" font-size="12" font-weight="600" fill="#1e293b">Controlled full scan: split the ring yourself</text>
  <text x="360" y="272" text-anchor="middle" font-size="11" fill="#1e293b">WHERE token(pk) &#62; ? AND token(pk) &#60;= ?   with N workers, each owning one sub-range</text>
  <text x="360" y="292" text-anchor="middle" font-size="11" fill="#1e293b">Bounded per query, parallel across the cluster, resumable, no coordinator hot spot.</text>
</svg>
```

## 5. Implementation

```cql
CREATE KEYSPACE shop WITH replication = {
  'class': 'NetworkTopologyStrategy', 'us_east': 3, 'eu_west': 3};

CREATE TABLE shop.orders_by_customer (
  customer_id uuid, order_month text, order_id timeuuid,
  status text, total_cents bigint,
  PRIMARY KEY ((customer_id, order_month), order_id)
) WITH CLUSTERING ORDER BY (order_id DESC);

-- The purpose-built table that replaces an ALLOW FILTERING query
CREATE TABLE shop.orders_by_value (
  order_month text, value_bucket int, total_cents bigint, order_id timeuuid,
  customer_id uuid, status text,
  PRIMARY KEY ((order_month, value_bucket), total_cents, order_id)
) WITH CLUSTERING ORDER BY (total_cents DESC, order_id DESC);
```

Bounded queries and their limits:

```cql
-- Paged single-partition read
SELECT order_id, status, total_cents FROM shop.orders_by_customer
 WHERE customer_id = ? AND order_month = '2026-07';

-- Hard cap on total rows
SELECT * FROM shop.orders_by_customer
 WHERE customer_id = ? AND order_month = '2026-07' LIMIT 20;

-- Latest 3 orders for each of several customers, without N queries
SELECT * FROM shop.orders_by_customer
 WHERE customer_id IN (?, ?, ?) AND order_month = '2026-07'
 PER PARTITION LIMIT 3;

-- The replacement for "orders over $500 last month"
SELECT order_id, customer_id, total_cents FROM shop.orders_by_value
 WHERE order_month = '2026-07' AND value_bucket = 5 AND total_cents > 50000
 LIMIT 100;
```

What gets rejected, and why:

```cql
SELECT * FROM shop.orders_by_customer WHERE status = 'SHIPPED';
-- InvalidRequest: Cannot execute this query as it might involve data filtering ...
--                 use ALLOW FILTERING

SELECT * FROM shop.orders_by_customer WHERE order_month = '2026-07';
-- Rejected too: order_month is only PART of the composite partition key.

-- Acceptable use: filtering INSIDE one bounded partition
SELECT * FROM shop.orders_by_customer
 WHERE customer_id = ? AND order_month = '2026-07' AND status = 'SHIPPED'
 ALLOW FILTERING;                       -- scans <= one partition. Fine.
```

Python driver — paging done correctly, including stateless resume:

```python
from cassandra.cluster import Cluster
from cassandra.query import SimpleStatement, ConsistencyLevel
import base64

session = Cluster(["10.0.1.11"]).connect("shop")
session.default_fetch_size = 100          # per-session default

stmt = session.prepare(
    "SELECT order_id, status, total_cents FROM orders_by_customer "
    "WHERE customer_id = ? AND order_month = ?")
stmt.fetch_size = 100
stmt.consistency_level = ConsistencyLevel.LOCAL_QUORUM

# 1) Streaming: iterate transparently, one page fetched at a time
rs = session.execute(stmt, (cid, "2026-07"))
for row in rs:                            # driver fetches pages lazily
    handle(row)

# 2) Stateless REST pagination: hand the opaque token to the client
def page(cid, month, token=None):
    bound = stmt.bind((cid, month))
    rs = session.execute(bound, paging_state=base64.b64decode(token) if token else None)
    rows = list(rs.current_rows)          # exactly this page, no auto-fetch
    nxt  = base64.b64encode(rs.paging_state).decode() if rs.has_more_pages else None
    return rows, nxt

rows, next_token = page(cid, "2026-07")
rows, next_token = page(cid, "2026-07", next_token)
```

Java equivalent:

```java
SimpleStatement stmt = SimpleStatement.newInstance(
        "SELECT order_id, status FROM orders_by_customer WHERE customer_id=? AND order_month=?",
        cid, "2026-07")
    .setPageSize(100)
    .setConsistencyLevel(DefaultConsistencyLevel.LOCAL_QUORUM);

ResultSet rs = session.execute(stmt);
for (Row row : rs.currentPage()) { handle(row); }
ByteBuffer state = rs.getExecutionInfo().getPagingState();   // null when exhausted
// resume later:
session.execute(stmt.setPagingState(state));
```

A correct, parallel full-table scan using `token()`:

```python
from cassandra.query import SimpleStatement

MIN, MAX = -(2**63), 2**63 - 1
SPLITS   = 256                                   # >> node count, for even work

def ranges(n):
    step = (MAX - MIN) // n
    return [(MIN + i*step, MIN + (i+1)*step if i < n-1 else MAX) for i in range(n)]

scan = session.prepare(
    "SELECT customer_id, order_month, total_cents FROM orders_by_customer "
    "WHERE token(customer_id, order_month) > ? AND token(customer_id, order_month) <= ?")
scan.fetch_size = 500

for lo, hi in ranges(SPLITS):                    # run these across a worker pool
    for row in session.execute(scan, (lo, hi)):
        if row.total_cents > 50000:
            emit(row)
# Resumable: record the last completed (lo, hi) and restart there.
```

Server-side guardrails (4.1+) and diagnostics:

```yaml
guardrails:
  allow_filtering_enabled: false          # ban it cluster-wide; forces correct modelling
  page_size_warn_threshold: 5000
  page_size_fail_threshold: 20000
  partition_keys_in_select_warn_threshold: 10
  in_select_cartesian_product_warn_threshold: 25
read_request_timeout: 5000ms
range_request_timeout: 10000ms
tombstone_warn_threshold: 1000
tombstone_failure_threshold: 100000
```

```bash
cqlsh> PAGING 50;                 # cqlsh-side page size
cqlsh> TRACING ON;
cqlsh> SELECT * FROM shop.orders_by_customer WHERE status='SHIPPED' ALLOW FILTERING LIMIT 5;
# Scanned over 1024000 rows, returned 5 | 10.0.1.11 | 9,812,441 us
# ReadTimeout: Operation timed out - received only 0 responses.

nodetool tablestats shop.orders_by_customer | grep -E "partition size|SSTables per read"
# Compacted partition maximum bytes: 43388628
# SSTables per read: 95% 3.00
```

> **Optimization:** tune `fetch_size` by *bytes*, not rows. The default 5,000 rows is fine for 100-byte rows (500 KB per page) and catastrophic for 50 KB rows (250 MB per page, on the coordinator heap). Pick a page size such that `page_size × avg_row_bytes ≈ 1–4 MB`. Then verify with `nodetool tablehistograms` — if p99 partition size is large, drop the page size further.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Server-side paging | Bounded memory on both sides; no server cursor; thousands of concurrent paged reads | Not a snapshot — concurrent writes can be missed or duplicated across pages |
| Client-held paging state | Enables stateless REST pagination; survives client restarts | Opaque and statement-specific; useless across schema or query changes |
| `LIMIT` | Simple hard cap on returned rows | Bounds output, not work; useless as protection on a filtered query |
| `PER PARTITION LIMIT` | Evaluated on the replica — genuinely reduces scanned rows | Only meaningful when multiple partitions are in scope |
| `ALLOW FILTERING` (single partition) | Convenient ad-hoc filtering with bounded cost | Only safe if that partition is genuinely bounded |
| `ALLOW FILTERING` (whole table) | Answers any question without new tables | Cluster-wide scan, coordinator heap pressure, timeouts, unpredictable at scale |
| `token()` scans | Deterministic, parallel, resumable full-table access | Manual work; rows arrive in token order, which is effectively random |
| Guardrails (4.1+) | Server-side prevention rather than code review | Blocks legitimate single-partition filtering too unless carefully scoped |

## 7. Common Mistakes & Best Practices

1. ⚠️ Adding `ALLOW FILTERING` because the error message suggested it. → ✅ Treat the rejection as a design review. Model a new table for the access pattern, or use SAI (5.0) / a secondary index if cardinality is right.
2. ⚠️ Believing `LIMIT 10` makes a filtered query cheap. → ✅ `LIMIT` caps output, not scanned rows. A one-in-a-million match with `LIMIT 10` will walk almost the entire ring.
3. ⚠️ Offset-style pagination (`OFFSET`/`skip N`) emulated with `LIMIT` and client-side discard. → ✅ Cassandra has no `OFFSET`. Use the paging state, or keyset pagination on the clustering key (`WHERE ck < last_seen`).
4. ⚠️ Leaving `fetch_size` at 5,000 for wide rows. → ✅ Size pages by bytes: target 1–4 MB per page. A 5,000 × 50 KB page is a 250 MB coordinator allocation.
5. ⚠️ Assuming pages are a consistent snapshot. → ✅ They are not. If you need snapshot semantics, page by a monotonically increasing clustering key and fix an upper bound before you start.
6. ⚠️ Persisting the paging state and reusing it against a modified statement or after a schema change. → ✅ Paging state is valid only for the exact query and bind values. Version your API tokens and reject stale ones.
7. ⚠️ Using `IN` on the partition key to "batch" a paged query. → ✅ Cartesian `IN` makes one coordinator hold results for every combination; `in_select_cartesian_product_warn_threshold` exists for this. Issue concurrent single-partition queries instead.
8. ⚠️ Running `SELECT COUNT(*)` or `SELECT DISTINCT pk` on a large table from a dashboard. → ✅ Both are full scans. Use a `token()`-split job, Spark, or maintain a counter.
9. ⚠️ Running full-table scans against the production coordinator pool. → ✅ Route analytics to a dedicated DC (`NetworkTopologyStrategy` with an `analytics` DC at `LOCAL_ONE`) so scans cannot starve OLTP traffic.
10. ⚠️ Ignoring tombstone counts on paged reads. → ✅ Tombstones scanned accumulate *within a page*; a partition with 200k tombstones fails at `tombstone_failure_threshold` regardless of how small your page is.
11. ⚠️ Building a token-range scanner with a fixed 3-way split matching node count. → ✅ Split far finer (128–1024 ranges) so work is even and failures retry cheaply; record completed ranges for resumability.
12. ⚠️ Leaving `allow_filtering_enabled: true` in production because "someone might need it". → ✅ Disable it and grant exceptions per analytics user via a separate role and DC. Filtering is the single most common cause of self-inflicted Cassandra outages.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** `TRACING ON` in cqlsh gives the one number that matters: `Scanned over N rows, returned M`. A ratio above ~10:1 is a modelling smell; above 1000:1 is an incident. The slow-query log (`slow_query_log_timeout_in_ms`, 500 ms default) records offenders in `system.log` with the full CQL, which is how you find filtered queries someone deployed at 2 a.m. In 4.0+, `SELECT * FROM system_views.clients` shows connected drivers and their requests, and `system_views.settings` confirms the effective `range_request_timeout` and guardrails without touching JMX. To find the actual offending partition, `nodetool tablehistograms shop.orders_by_customer` gives the partition-size and cell-count percentiles.

**Monitoring.** Alert on `org.apache.cassandra.metrics:type=ClientRequest,scope=RangeSlice,name=Latency` — range-slice latency is the direct signal of scan-shaped traffic, and it should be near zero in an OLTP cluster. Also watch `scope=RangeSlice,name=Timeouts` and `name=Unavailables`, `type=Table,...,name=TombstoneScannedHistogram` p99, `name=EstimatedPartitionSizeHistogram` max, and JVM `GC pause` duration on coordinators (filtered scans show up as heap saturation before they show up as timeouts). A useful synthetic alert: any nonzero `RangeSlice` request count on a keyspace that should only ever do single-partition reads.

**Security.** `ALLOW FILTERING` is a denial-of-service vector as much as a performance problem: one authenticated user with `SELECT` on a large table can saturate the cluster with a single statement. Mitigate with three layers — set `guardrails.allow_filtering_enabled: false` cluster-wide (4.1+), grant `SELECT` only on the tables each role needs rather than `ON ALL KEYSPACES`, and give analytics workloads a separate DC and role so their scans hit dedicated hardware. Cassandra 5.0 also lets you bound damage with `guardrails.page_size_fail_threshold`. Log and review filtered queries via the audit log (`audit_logging_options` with `included_categories: DML`).

**Performance & scaling.** The scaling rule is simple: single-partition paged reads scale linearly with cluster size because each query touches `RF` nodes regardless of cluster size. Range scans scale *inversely* — a bigger cluster means more ranges to visit for the same query, so the same statement gets slower as you grow. That asymmetry is the reason to eliminate scans from the request path entirely. For genuine bulk access, use `token()`-split parallel scans from a Spark job or the DataStax Bulk Loader (`dsbulk unload`), pointed at an analytics DC, with `fetch_size` tuned to bytes and consistency at `LOCAL_ONE`.

## 9. Interview Questions

**Q: What is a paging state and where is it stored?**
A: An opaque serialised cursor containing the partition key, clustering position, and remaining-limit bookkeeping for the point where a page stopped. It is returned to and held by the *client*, not the server, so the coordinator keeps no per-query state and can serve many concurrent paged reads cheaply.

**Q: Are Cassandra pages a consistent snapshot of the data?**
A: No. Each page is a fresh execution of the query with a lower bound derived from the paging state, so rows inserted behind the cursor are missed and rows inserted ahead of it appear. If you need snapshot semantics, page by a monotonic clustering key with a fixed upper bound recorded before you start.

**Q: Why is `LIMIT 10 ... ALLOW FILTERING` not safe?**
A: Because `LIMIT` bounds the rows *returned*, not the rows *scanned*. If matches are rare, the coordinator walks token range after token range looking for ten of them and can read millions of rows before either succeeding or hitting `range_request_timeout`.

**Q: When is `ALLOW FILTERING` acceptable?**
A: When the partition key is fully specified so the scan is bounded by one partition, and that partition is known to be small — filtering 500 rows down to 5 costs nothing. Also acceptable in explicitly-scoped offline analytics jobs on a separate DC. Never in an OLTP path without a partition key.

**Q: What does `PER PARTITION LIMIT` do that `LIMIT` cannot?**
A: It caps rows per partition and is evaluated on the replica during the read, so it actually reduces the work done rather than just truncating the output. It is the efficient way to express "the latest N rows for each of many keys" in one query.

**Q: How do you do offset-based pagination in Cassandra?**
A: You do not — there is no `OFFSET`, because computing it would require scanning and discarding the skipped rows. Use the paging state for sequential pagination or keyset pagination (`WHERE clustering_col < last_seen_value LIMIT n`) for jump-to-position semantics.

**Q: (Senior) Explain why the same range query gets slower as you add nodes.**
A: A range scan visits every token range in the ring, and adding nodes increases the number of ranges (further multiplied by `num_tokens` vnodes per node). Each range is a separate coordinated read with its own round trip and its own adaptive-concurrency step, so total coordination work grows with cluster size while the useful result stays constant. Single-partition reads, by contrast, always touch exactly `RF` replicas, which is why the correct fix is modelling the query as a partition lookup rather than tuning the scan.

**Q: (Senior) A paged query intermittently throws `ReadTimeoutException` on page 7 of 50, but pages 1–6 are fast. What's happening?**
A: Almost certainly a tombstone-heavy or unusually wide region of the partition. Page cost is a function of rows *scanned*, and tombstones and expired TTL cells are scanned but not returned, so a page that must skip 150k tombstones to find 100 live rows blows through `read_request_timeout` and may trip `tombstone_failure_threshold`. Confirm with `TRACING ON` on that page and `nodetool tablehistograms`; fix by repairing/compacting, changing the delete pattern to range deletes, or bucketing the partition.

**Q: (Senior) How would you implement a resumable, parallel export of a 4 TB table without impacting OLTP traffic?**
A: Split the murmur3 token space into several hundred sub-ranges and issue `WHERE token(pk) > ? AND token(pk) <= ?` queries from a worker pool, checkpointing each completed range so a restart resumes rather than repeats. Point the job at a dedicated analytics DC via `NetworkTopologyStrategy` with a DC-aware policy at `LOCAL_ONE`, size `fetch_size` so each page is 1–4 MB, and rate-limit workers. `dsbulk unload` or a Spark connector implements exactly this pattern if you would rather not build it.

**Q: What is the default `fetch_size` and how should you choose one?**
A: 5,000 rows in the DataStax drivers. Choose it by bytes rather than rows: aim for roughly 1–4 MB per page, so wide rows warrant a much smaller page size. Oversized pages allocate on the coordinator heap and are a common cause of GC pauses.

**Q: Why does `SELECT * FROM t WHERE partial_partition_key = ?` get rejected?**
A: Because the token is computed from *all* components of the composite partition key. With only part of it, the coordinator cannot determine which replicas hold the data, so the query would have to scan every range. Cassandra rejects it rather than silently doing a full scan.

**Q: How can you prevent developers from shipping `ALLOW FILTERING` to production?**
A: Set `guardrails.allow_filtering_enabled: false` in `cassandra.yaml` on 4.1+, which rejects such queries server-side regardless of client code. Complement it with narrow `GRANT SELECT` permissions, a separate analytics DC and role for legitimate scans, and an alert on nonzero `ClientRequest,scope=RangeSlice` traffic in OLTP keyspaces.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Paging keeps large result sets bounded by returning `fetch_size` rows plus a client-held opaque paging state that encodes where the scan stopped; there is no server cursor and therefore no snapshot isolation across pages. Size pages by bytes, not rows. `LIMIT` bounds output, `PER PARTITION LIMIT` bounds per-partition work on the replica, and neither bounds a filtered scan — `ALLOW FILTERING` costs what it *scans*, which the query text never reveals. Filtering is fine inside one bounded partition and catastrophic across the ring, so ban it with guardrails, model a table per access pattern, and when you genuinely need every row, split the token space yourself into hundreds of resumable ranges against an analytics DC.

| Item | Value / Command |
|---|---|
| Driver default page size | 5,000 rows (`fetch_size` / `setPageSize`) |
| Recommended page sizing | `page_size × avg_row_bytes ≈ 1–4 MB` |
| cqlsh paging | `PAGING 50;` / `PAGING OFF;` |
| Paging state (Python) | `rs.paging_state`, `rs.has_more_pages` |
| Paging state (Java) | `rs.getExecutionInfo().getPagingState()` |
| Per-partition cap | `SELECT ... PER PARTITION LIMIT 3` |
| Ban filtering (4.1+) | `guardrails.allow_filtering_enabled: false` |
| Page-size guardrails | `page_size_warn_threshold: 5000` / `fail: 20000` |
| Single-partition timeout | `read_request_timeout: 5000ms` |
| Range-scan timeout | `range_request_timeout: 10000ms` |
| Murmur3 token space | `-2^63` to `2^63 - 1` |
| Full scan idiom | `WHERE token(pk) > ? AND token(pk) <= ?` |
| Scan-traffic metric | `ClientRequest,scope=RangeSlice,name=Latency` |
| Diagnose a query | `TRACING ON;` → "Scanned over N rows, returned M" |

**Flash cards**
- **Where does the paging state live?** → On the client. The server keeps no cursor, so pages are separate executions.
- **Does `LIMIT` protect a filtered query?** → No. It caps returned rows; the scan can still traverse the whole ring.
- **When is `ALLOW FILTERING` OK?** → When the partition key is fully specified and that partition is bounded.
- **How do you do an `OFFSET`?** → You don't. Use paging state or keyset pagination on the clustering key.
- **Correct way to scan a whole table?** → Split the token range into hundreds of chunks and query `token(pk)` bounds in parallel.

## 11. Hands-On Exercises & Mini Project

- [ ] Load 100,000 rows into one partition, then run the same `SELECT` with `PAGING 10`, `PAGING 1000`, and `PAGING OFF` in cqlsh; record wall time and coordinator heap from `nodetool info` for each.
- [ ] Implement stateless REST pagination in Python: return base64-encoded paging state as a `next` token and prove that a fresh process can resume with it.
- [ ] Run `SELECT ... WHERE non_key_col = ? ALLOW FILTERING` with `TRACING ON` on a 1M-row table and record "Scanned over N rows, returned M"; then build the correct denormalized table and compare latency.
- [ ] Demonstrate that pages are not a snapshot: start iterating with `fetch_size = 10`, insert rows behind and ahead of the cursor from a second session, and record which ones appear.
- [ ] Write a `token()`-range scanner with 256 splits and a checkpoint file; kill it halfway and prove it resumes without re-reading completed ranges.

**Mini Project — a bounded-query order API**

*Goal:* expose an order-history API where every endpoint is provably bounded, plus one offline analytics job that scans safely.

*Requirements:*
- `orders_by_customer((customer_id, order_month), order_id DESC)` for history, and `orders_by_value((order_month, value_bucket), total_cents DESC, order_id)` to answer "high-value orders" without filtering.
- `GET /orders?customer=&month=&cursor=` returning 50 rows plus an opaque base64 cursor derived from the paging state; reject cursors that fail to decode.
- `GET /orders/top?month=` served entirely from `orders_by_value` — assert in a test that no statement in the codebase contains `ALLOW FILTERING`.
- A latest-3-per-customer endpoint using `PER PARTITION LIMIT 3` over an `IN` of at most 10 customers, with a comment explaining the cartesian-product guardrail.
- An `export.py` performing a 256-way `token()` split with checkpointing, `fetch_size` tuned to ~2 MB pages, and `LOCAL_ONE` consistency.

*Extensions:* enable `guardrails.allow_filtering_enabled: false` and confirm the app still passes its test suite; add a Prometheus alert on `RangeSlice` latency; measure export throughput with 16 vs 256 splits and explain the difference in tail latency.

## 12. Related Topics & Free Learning Resources

Read with **13 · CQL: SELECT, INSERT, UPDATE & DELETE** for the primary-key restriction rules that make queries bounded in the first place, **15 · TTL, Counters & Static Columns** for why tombstones make paged reads unexpectedly expensive, and **18 · The Ring, Tokens & Consistent Hashing** for what `token()` actually returns and why range scans grow with the cluster. Secondary-index and SAI chapters cover the supported alternatives to filtering.

- **CQL SELECT Reference** — Apache Cassandra Documentation · *Beginner–Intermediate* · normative semantics for `LIMIT`, `PER PARTITION LIMIT`, `ALLOW FILTERING`, and `token()`. <https://cassandra.apache.org/doc/latest/cassandra/developing/cql/dml.html#select>
- **Guardrails in Cassandra 4.1** — Apache Cassandra Documentation · *Intermediate* · every guardrail including `allow_filtering_enabled` and page-size thresholds. <https://cassandra.apache.org/doc/latest/cassandra/managing/configuration/cass_yaml_file.html>
- **CASSANDRA-4415: Add ALLOW FILTERING** — Apache JIRA · *Advanced* · the original discussion on why filtering had to be explicit and opt-in. <https://issues.apache.org/jira/browse/CASSANDRA-4415>
- **Paging in the DataStax Java Driver** — DataStax · *Intermediate* · page size, paging state, stateless pagination, and the offset-emulation anti-pattern. <https://docs.datastax.com/en/developer/java-driver/latest/manual/core/paging/>
- **Paging in the DataStax Python Driver** — DataStax · *Beginner* · `fetch_size`, `paging_state`, and lazy iteration semantics. <https://docs.datastax.com/en/developer/python-driver/latest/query_paging/>
- **A Deep Look at the CQL WHERE Clause** — The Last Pickle · *Advanced* · exactly which restrictions are satisfiable by seek and which force filtering. <https://thelastpickle.com/blog/2017/01/24/cassandra-row-cache.html>
- **DataStax Bulk Loader (dsbulk) Documentation** — DataStax · *Intermediate* · production-grade token-range-parallel unload/load, the tool to use instead of hand-rolled scans. <https://docs.datastax.com/en/dsbulk/docs/>
- **Apache Spark Cassandra Connector** — DataStax / Apache · *Advanced* · how token-range splitting is implemented for distributed analytics over Cassandra. <https://github.com/datastax/spark-cassandra-connector>

---

*Apache Cassandra Handbook — chapter 16.*
