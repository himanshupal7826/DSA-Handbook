# 40 · Drivers & Application Development

> **In one line:** A Cassandra driver is a miniature distributed system in your process — it holds the topology, routes each query to a replica that owns the token, reuses prepared statement ids, and decides what to retry — and most Cassandra "performance problems" are actually driver misconfiguration.

---

## 1. Overview

Cassandra has no primary node, no proxy tier, and no query planner in the server that decides where work goes. The client does that. A modern DataStax driver maintains a live map of the cluster from `system.peers_v2` and gossip-driven events, computes the token for each query's partition key with the same Murmur3 hash the server uses, and sends the request directly to a node that owns a replica of that token. Getting that right eliminates a network hop and a coordinator's worth of latency on every single query; getting it wrong doubles your p99 and you will never see it in a server-side metric.

The problem drivers solve is that Cassandra's protocol is asynchronous and multiplexed, its topology changes while you are running, and its consistency model gives you choices that the server cannot make for you. One TCP connection carries up to 32,768 in-flight requests in protocol v5, identified by stream id. Nodes come and go. A `LOCAL_QUORUM` write that times out may or may not have been applied. The driver has to hold all of that: connection pools, reconnection with backoff, speculative execution, retry policies, and paging state for large result sets.

The lineage matters when reading documentation. The original Java driver 1.x/2.x/3.x used `Cluster`/`Session` with `QueryOptions`; the 4.x rewrite (2019) replaced it with a single immutable `CqlSession`, a HOCON `application.conf`, and mandatory `withLocalDatacenter`. The Python driver kept `Cluster.connect()` but added `ExecutionProfile` in 3.x, which is where consistency level, load balancing, and timeouts now belong. Cassandra 5.0's drivers add vector type support and SAI-aware query handling. Anything you read that calls `Session.execute` with a `ConsistencyLevel` argument directly is pre-profile-era advice.

The single highest-leverage habit is **prepared statements**. A prepared statement is parsed once per node and cached by a 16-byte MD5 id; subsequent executions send only the id and bind values. That saves parsing CPU on the coordinator, but far more importantly the driver knows which bind marker corresponds to the partition key, which is the *only* way token-aware routing can work. A simple string statement is routed to a random node.

A concrete example: a food delivery company saw p99 read latency of 34 ms against a cluster whose server-side `ReadLatency` p99 was 3 ms. The gap was entirely client-side — they built statements with Python f-strings (no preparation, no routing), used the default round-robin policy across two datacenters (half their queries crossed a 40 ms WAN), and opened a new `Cluster` per Celery worker. Switching to prepared statements, `TokenAwarePolicy(DCAwareRoundRobinPolicy(local_dc=...))`, and one module-level session took p99 to 4 ms with no server change at all.
## 2. Core Concepts

- **Session** — the long-lived, thread-safe object holding connection pools, topology metadata, and prepared statement caches. One per application process, for the process lifetime.
- **Prepared statement** — a server-parsed statement identified by a `PreparedId`; execution sends the id plus bind values. Prerequisite for token-aware routing.
- **Bound statement** — a prepared statement with values bound, ready to execute. Cheap to create; create per request, never re-prepare.
- **Execution profile** — a named bundle of consistency level, serial consistency, timeout, load balancing policy, retry policy, and page size, selectable per query.
- **Load balancing policy** — decides the query plan: which node to try first, second, third. `TokenAwarePolicy` wrapping `DCAwareRoundRobinPolicy` is the production default.
- **Retry policy** — decides what to do on timeout or unavailability: retry same node, retry next node, rethrow, or ignore. Must be idempotency-aware.
- **Speculative execution** — pre-emptively sending the same query to a second replica after a latency threshold, taking whichever answers first. Only safe for idempotent queries.
- **Paging** — automatic fetching of large result sets in pages of `fetch_size` (default 5000) rows, with an opaque `paging_state` cursor.
- **Idempotence flag** — a per-statement declaration that re-executing the statement is harmless. Drivers refuse to retry or speculate on non-idempotent statements.
- **Connection pool** — per-host TCP connections; each multiplexes many concurrent requests via stream ids (32,768 in protocol v5).
- **Token-aware routing** — hashing the routing key with Murmur3 to find the replicas and sending directly to one of them, saving the coordinator hop.
## 3. Theory & Internals

### 3.1 Why token awareness saves a hop

Cassandra partitions data by `token = murmur3(partition_key)`. With `RF=3`, three nodes own each token. If the client sends a query to a node that does *not* own the token, that node becomes a coordinator and must forward to a real replica, wait, and forward the response back — an extra round trip and an extra node's worth of queueing.

```
Non token-aware:  client → coordinator → replica → coordinator → client   (2 hops)
Token-aware:      client → replica(=coordinator) → client                 (1 hop)
```

On a LAN that saves 0.3–1 ms; the bigger win is eliminating a queueing point under load, which matters most at p99.

For this to work, the driver must know the routing key. With a prepared statement, the server returns column metadata including `partition_key_bind_indexes`, so the driver knows that bind marker 0 is the partition key. With a simple string statement there is no metadata, so the driver falls back to the wrapped child policy — effectively random.

### 3.2 The query plan

A load balancing policy produces an ordered iterator of hosts per query. `TokenAwarePolicy(DCAwareRoundRobinPolicy(local_dc="dc_east"))` yields:

1. Local-DC replicas that own the token, shuffled (so the same replica is not always first).
2. Remaining local-DC nodes, round-robin.
3. Remote-DC nodes — only if the policy is configured to allow them, which in modern drivers is **off by default and should stay off**.

The driver walks this plan on failure: `UnavailableException` or a connection error moves to the next host. This is why a well-configured driver survives single-node failure with no application code involvement.

```svg
<svg viewBox="0 0 760 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif"> <rect x="0" y="0" width="760" height="380" fill="#ffffff"/>
<text x="20" y="26" font-size="15" font-weight="bold" fill="#1e293b">Token-aware routing versus blind routing</text>
<text x="20" y="56" font-size="12" font-weight="bold" fill="#1e293b">Blind (simple statement, round robin)</text>
<rect x="20" y="68" width="110" height="46" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/> <text x="42" y="96" font-size="12" fill="#1e293b">App</text>
<rect x="190" y="68" width="140" height="46" rx="8" fill="#fef3c7" stroke="#d97706"/> <text x="204" y="90" font-size="11" fill="#1e293b">Node C (not a</text>
<text x="204" y="106" font-size="11" fill="#1e293b">replica) coordinates</text> <rect x="390" y="68" width="140" height="46" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
<text x="404" y="96" font-size="11" fill="#1e293b">Node A owns token</text> <path d="M130 91 L190 91" stroke="#1e293b" stroke-width="1.5" marker-end="url(#a40)"/>
<path d="M330 91 L390 91" stroke="#1e293b" stroke-width="1.5" marker-end="url(#a40)"/>
<path d="M460 114 L460 134 L75 134 L75 114" stroke="#d97706" stroke-width="1.5" fill="none" marker-end="url(#a40)"/> <text x="556" y="96" font-size="11" fill="#1e293b">2 network hops</text>
<text x="20" y="186" font-size="12" font-weight="bold" fill="#1e293b">Token aware (prepared statement)</text>
<rect x="20" y="198" width="110" height="46" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/> <text x="42" y="226" font-size="12" fill="#1e293b">App</text>
<text x="26" y="262" font-size="10" fill="#1e293b">murmur3(pk)</text> <text x="26" y="278" font-size="10" fill="#1e293b">= token 42</text>
<rect x="250" y="198" width="180" height="46" rx="8" fill="#f0fdf4" stroke="#16a34a"/> <text x="264" y="226" font-size="11" fill="#1e293b">Node A owns token 42</text>
<path d="M130 221 L250 221" stroke="#16a34a" stroke-width="2" marker-end="url(#a40)"/>
<path d="M340 244 L340 266 L75 266 L75 244" stroke="#16a34a" stroke-width="1.5" fill="none" marker-end="url(#a40)"/>
<text x="456" y="226" font-size="11" fill="#1e293b">1 network hop, one queue</text> <rect x="20" y="300" width="719" height="62" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
<text x="36" y="324" font-size="12" font-weight="bold" fill="#1e293b">Why preparation is required</text>
<text x="36" y="346" font-size="11" fill="#1e293b">Only a prepared statement returns partition_key_bind_indexes, so only then can the driver compute the routing key.</text> <defs>
<marker id="a40" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"> <path d="M0 0 L8 4 L0 8 z" fill="#1e293b"/> </marker> </defs> </svg>
```

### 3.3 Retries, idempotence, and the timeout trap

A `WriteTimeoutException` means the coordinator did not hear enough acknowledgements before `write_request_timeout_in_ms` (5000 ms default). It does **not** mean the write failed — the mutation may already be applied on some replicas, and hinted handoff may deliver it to the rest. Retrying is therefore only safe when the statement is idempotent.

```
INSERT ... VALUES (?, ?)             idempotent (same values overwrite)
UPDATE t SET counter = counter + 1   NOT idempotent (counters accumulate)
UPDATE t SET l = l + ['x']           NOT idempotent (list append duplicates)
INSERT ... IF NOT EXISTS             NOT idempotent (LWT: result differs on retry)
now() / uuid() in the statement      NOT idempotent (value changes per execution)
```

Modern drivers default `isIdempotent` to **false** and refuse to retry or speculate. Set it explicitly to `true` on your ordinary reads and writes, or you silently lose the resilience you configured.

### 3.4 Connection pooling and concurrency

Protocol v5 multiplexes 32,768 streams per connection, so pool sizing is not about concurrency limits — it is about spreading work across event loop threads and avoiding head-of-line blocking on a single socket. Java driver 4.x defaults to 1 connection per node with `max-requests-per-connection = 1024`; Python's driver defaults to 1 core connection with 32,768 max requests. Raise `max-requests-per-connection`, not the connection count, unless you are genuinely saturating a socket.

The real concurrency control lives in your application: unbounded async fan-out is the classic way to melt a cluster. Bound in-flight requests with a semaphore.
## 4. Architecture & Workflow

What happens between `session.execute(bound)` and a `Row`:

1. **Session initialization (once).** The driver connects to a contact point, issues `STARTUP`, negotiates protocol version and compression, authenticates, then queries `system.local` and `system.peers_v2` to build the topology and token map.
2. **Event subscription.** The driver registers for `TOPOLOGY_CHANGE`, `STATUS_CHANGE`, and `SCHEMA_CHANGE` events so node additions, removals, and schema updates update metadata live.
3. **Prepare.** `session.prepare("SELECT ... WHERE id = ?")` sends `PREPARE` to one node; the response carries the `PreparedId` plus result and bind metadata including partition key indexes. The driver caches this by query string and re-prepares automatically on nodes that report `UNPREPARED`.
4. **Bind.** The application binds values, producing a `BoundStatement`. The driver serializes the partition key components to compute the routing key.
5. **Query plan.** The load balancing policy returns an ordered host iterator: token replicas in the local DC first.
6. **Stream assignment.** A connection to host 1 is chosen, a free stream id allocated, and the `EXECUTE` frame written. The calling thread does not block — a future is returned.
7. **Coordinator work.** The chosen node, being a replica, reads locally and from `RF-1` peers as the consistency level requires, merges, and returns `RESULT`.
8. **Speculative execution (optional).** If no response after the profile's threshold (say 20 ms), the driver sends the same query to host 2 and takes the first answer, cancelling the loser.
9. **Failure handling.** On `Unavailable`, `WriteTimeout`, `ReadTimeout`, or a connection error, the retry policy decides: retry next host, retry same host, or rethrow. Non-idempotent statements are never retried on timeout.
10. **Paging.** If the result exceeds `page_size`, the driver returns the first page plus a `paging_state`; iterating past it transparently fetches the next page.
11. **Completion.** The future completes with a `ResultSet`; the stream id is released back to the connection.

```svg
<svg viewBox="0 0 760 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif"> <rect x="0" y="0" width="760" height="360" fill="#ffffff"/>
<text x="20" y="26" font-size="15" font-weight="bold" fill="#1e293b">Anatomy of a driver session</text> <rect x="20" y="48" width="230" height="290" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
<text x="40" y="72" font-size="13" font-weight="bold" fill="#1e293b">CqlSession (one per process)</text> <text x="40" y="98" font-size="11" fill="#1e293b">Topology + token map</text>
<text x="40" y="120" font-size="11" fill="#1e293b">Prepared statement cache</text> <text x="40" y="142" font-size="11" fill="#1e293b">Execution profiles</text>
<text x="40" y="164" font-size="11" fill="#1e293b">Connection pools per host</text> <text x="40" y="186" font-size="11" fill="#1e293b">Reconnection policy</text>
<text x="40" y="208" font-size="11" fill="#1e293b">Metrics registry</text> <text x="40" y="236" font-size="11" fill="#1e293b">Thread safe. Never build</text>
<text x="40" y="254" font-size="11" fill="#1e293b">one per request.</text> <rect x="290" y="48" width="200" height="130" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
<text x="308" y="72" font-size="12" font-weight="bold" fill="#1e293b">Per query</text> <text x="308" y="96" font-size="11" fill="#1e293b">1 bind values</text>
<text x="308" y="116" font-size="11" fill="#1e293b">2 compute routing key</text> <text x="308" y="136" font-size="11" fill="#1e293b">3 build query plan</text>
<text x="308" y="156" font-size="11" fill="#1e293b">4 pick stream id</text> <rect x="290" y="200" width="200" height="138" rx="8" fill="#fef3c7" stroke="#d97706"/>
<text x="308" y="224" font-size="12" font-weight="bold" fill="#1e293b">On failure</text> <text x="308" y="248" font-size="11" fill="#1e293b">Unavailable to next host</text>
<text x="308" y="268" font-size="11" fill="#1e293b">ReadTimeout to retry rules</text> <text x="308" y="288" font-size="11" fill="#1e293b">WriteTimeout only if</text>
<text x="308" y="306" font-size="11" fill="#1e293b">idempotent is true</text> <text x="308" y="328" font-size="11" fill="#1e293b">UNPREPARED to re-prepare</text>
<rect x="530" y="48" width="210" height="130" rx="8" fill="#f0fdf4" stroke="#16a34a"/> <text x="548" y="72" font-size="12" font-weight="bold" fill="#1e293b">Local DC replicas</text>
<text x="548" y="96" font-size="11" fill="#1e293b">node A owns token</text> <text x="548" y="116" font-size="11" fill="#1e293b">node B owns token</text>
<text x="548" y="136" font-size="11" fill="#1e293b">node C owns token</text> <text x="548" y="158" font-size="11" fill="#1e293b">shuffled per query</text>
<rect x="530" y="200" width="210" height="138" rx="8" fill="#f0fdf4" stroke="#16a34a"/> <text x="548" y="224" font-size="12" font-weight="bold" fill="#1e293b">Remote DC</text>
<text x="548" y="248" font-size="11" fill="#1e293b">Not in the query plan</text> <text x="548" y="268" font-size="11" fill="#1e293b">by default in driver 4.x.</text>
<text x="548" y="292" font-size="11" fill="#1e293b">Use LOCAL_QUORUM and</text> <text x="548" y="310" font-size="11" fill="#1e293b">a per DC session instead</text>
<text x="548" y="328" font-size="11" fill="#1e293b">of cross DC failover.</text> <path d="M250 110 L290 110" stroke="#1e293b" stroke-width="1.5" marker-end="url(#a40b)"/>
<path d="M490 110 L530 110" stroke="#1e293b" stroke-width="1.5" marker-end="url(#a40b)"/> <defs> <marker id="a40b" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
<path d="M0 0 L8 4 L0 8 z" fill="#1e293b"/> </marker> </defs> </svg>
```
## 5. Implementation

### 5.1 Schema for the examples

```cql
CREATE KEYSPACE IF NOT EXISTS shop
  WITH replication = {'class':'NetworkTopologyStrategy','dc_east':3,'dc_west':3};

CREATE TABLE shop.orders_by_customer (
  customer_id uuid,
  order_ts    timestamp,
  order_id    uuid,
  total_cents bigint,
  status      text,
  PRIMARY KEY ((customer_id), order_ts, order_id)
) WITH CLUSTERING ORDER BY (order_ts DESC);
```

### 5.2 Python: a correct session

```python
import os, uuid
from cassandra.cluster import Cluster, ExecutionProfile, EXEC_PROFILE_DEFAULT
from cassandra.policies import (TokenAwarePolicy, DCAwareRoundRobinPolicy,
                                ExponentialReconnectionPolicy,
                                ConstantSpeculativeExecutionPolicy)
from cassandra.auth import PlainTextAuthProvider
from cassandra import ConsistencyLevel

READS = ExecutionProfile(
    load_balancing_policy=TokenAwarePolicy(DCAwareRoundRobinPolicy(local_dc="dc_east")),
    consistency_level=ConsistencyLevel.LOCAL_QUORUM,
    request_timeout=2.0,
    row_factory=None,
    speculative_execution_policy=ConstantSpeculativeExecutionPolicy(
        delay=0.020, max_attempts=2),      # 20 ms, idempotent statements only
)

WRITES = ExecutionProfile(
    load_balancing_policy=TokenAwarePolicy(DCAwareRoundRobinPolicy(local_dc="dc_east")),
    consistency_level=ConsistencyLevel.LOCAL_QUORUM,
    request_timeout=5.0,
)

cluster = Cluster(
    contact_points=["10.0.1.11", "10.0.1.12", "10.0.1.13"],
    port=9042,
    protocol_version=5,
    auth_provider=PlainTextAuthProvider(os.environ["CASS_USER"],
                                        os.environ["CASS_PASSWORD"]),
    execution_profiles={EXEC_PROFILE_DEFAULT: READS, "writes": WRITES},
    reconnection_policy=ExponentialReconnectionPolicy(base_delay=1.0, max_delay=60.0),
    idle_heartbeat_interval=30,
)
session = cluster.connect("shop")          # module level, created ONCE

# Prepare ONCE at startup, never inside a request handler.
SELECT_RECENT = session.prepare("""
    SELECT order_id, order_ts, total_cents, status
      FROM orders_by_customer
     WHERE customer_id = ?
     LIMIT ?
""")
SELECT_RECENT.is_idempotent = True         # required for retry + speculation

INSERT_ORDER = session.prepare("""
    INSERT INTO orders_by_customer (customer_id, order_ts, order_id, total_cents, status)
    VALUES (?, ?, ?, ?, ?)
""")
INSERT_ORDER.is_idempotent = True          # same values -> same result

def recent_orders(customer_id: uuid.UUID, limit: int = 20):
    return list(session.execute(SELECT_RECENT, (customer_id, limit)))
```

### 5.3 Python: bounded async fan-out

```python
from cassandra.concurrent import execute_concurrent_with_args

def bulk_load(rows):
    """Bounded concurrency: the driver caps in-flight requests at `concurrency`."""
    results = execute_concurrent_with_args(
        session, INSERT_ORDER, rows,
        concurrency=64,            # NOT unbounded; 64-256 is the usual sweet spot
        raise_on_first_error=False,
    )
    failures = [r.result_or_exc for r in results if not r.success]
    return len(failures)

# Hand-rolled alternative with explicit back-pressure
import threading
class Bounded:
    def __init__(self, session, limit=128):
        self.session, self.sem = session, threading.Semaphore(limit)
    def submit(self, stmt, params):
        self.sem.acquire()
        fut = self.session.execute_async(stmt, params)
        fut.add_callbacks(lambda _r: self.sem.release(),
                          lambda _e: self.sem.release())
        return fut
```

### 5.4 Java driver 4.x

```java
import com.datastax.oss.driver.api.core.CqlSession;
import com.datastax.oss.driver.api.core.cql.*;
import java.net.InetSocketAddress;
import java.time.Duration;
import java.util.UUID;

public final class OrderRepository implements AutoCloseable {
  private final CqlSession session;
  private final PreparedStatement selectRecent;
  private final PreparedStatement insertOrder;

  public OrderRepository() {
    this.session = CqlSession.builder()
        .addContactPoint(new InetSocketAddress("10.0.1.11", 9042))
        .withLocalDatacenter("dc_east")            // mandatory in 4.x
        .withKeyspace("shop")
        .build();

    this.selectRecent = session.prepare(
        "SELECT order_id, order_ts, total_cents, status "
      + "FROM orders_by_customer WHERE customer_id = ? LIMIT ?");
    this.insertOrder = session.prepare(
        "INSERT INTO orders_by_customer "
      + "(customer_id, order_ts, order_id, total_cents, status) VALUES (?,?,?,?,?)");
  }

  public ResultSet recent(UUID customerId, int limit) {
    BoundStatement bs = selectRecent.bind(customerId, limit)
        .setIdempotent(true)                       // enables retry + speculation
        .setPageSize(200)
        .setTimeout(Duration.ofSeconds(2));
    return session.execute(bs);
  }

  public CompletionStage<AsyncResultSet> recentAsync(UUID customerId, int limit) {
    return session.executeAsync(selectRecent.bind(customerId, limit).setIdempotent(true));
  }

  @Override public void close() { session.close(); }
}
```

```hocon
# application.conf -- Java driver 4.x
datastax-java-driver {
  basic {
    contact-points = ["10.0.1.11:9042", "10.0.1.12:9042"]
    load-balancing-policy.local-datacenter = dc_east
    request {
      consistency = LOCAL_QUORUM
      page-size = 500
      timeout = 2 seconds
      default-idempotence = false
    }
  }
  advanced {
    connection.pool.local.size = 2
    connection.max-requests-per-connection = 2048
    reconnection-policy { class = ExponentialReconnectionPolicy
                          base-delay = 1 second, max-delay = 60 seconds }
    retry-policy.class = DefaultRetryPolicy
    speculative-execution-policy {
      class = ConstantSpeculativeExecutionPolicy
      max-executions = 2
      delay = 20 milliseconds
    }
    metrics.session.enabled = [ bytes-sent, bytes-received, connected-nodes,
                                cql-requests, cql-client-timeouts ]
  }
  profiles {
    analytics { basic.request { consistency = LOCAL_ONE, timeout = 30 seconds,
                                page-size = 5000 } }
  }
}
```

### 5.5 Paging large result sets correctly

```python
# WRONG: materializes everything, OOMs on a big partition
rows = list(session.execute("SELECT * FROM shop.orders_by_customer"))

# RIGHT: stream page by page
stmt = SimpleStatement("SELECT * FROM shop.orders_by_customer", fetch_size=1000)
for row in session.execute(stmt):        # driver fetches pages transparently
    process(row)

# RIGHT for stateless HTTP pagination: hand the cursor to the client
result = session.execute(stmt, paging_state=incoming_state_bytes)
page   = list(result.current_rows)
next_state = result.paging_state         # opaque bytes; base64 it into the response
```

**Optimization note.** In priority order: (1) one session per process, created at startup — this is worth more than every other tuning combined; (2) prepare every statement once at startup and keep the handle, which enables token-aware routing; (3) set `is_idempotent = True` on reads and non-counter writes so retries and speculative execution actually engage; (4) pin `local_dc` and never enable remote-DC failover in the load balancing policy, because a silent cross-WAN query is a 40 ms p99; (5) raise `max-requests-per-connection` rather than opening more connections; (6) bound async fan-out with `execute_concurrent` or a semaphore — unbounded `execute_async` in a loop is the most common way applications overwhelm a healthy cluster.
## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost/Trade-off |
|---|---|---|
| Prepared statements | Saves coordinator parsing; enables token-aware routing; type-safe binding | Statement cache is per node; a node restart triggers re-preparation storms if the cache is huge |
| Token-aware routing | Removes a network hop and a queueing point; big p99 win | Only works with prepared statements or an explicitly set routing key |
| Speculative execution | Hides a slow replica; dramatically tightens p99 tails | Multiplies load on the cluster; unsafe for non-idempotent statements |
| Async API | High throughput from few threads; natural for event loops | Easy to fan out without bounds and self-inflict overload |
| Execution profiles | Per-workload consistency/timeout/paging without new sessions | Another layer of config to keep in sync; defaults are easy to forget |
| Client-side retries | Transparent survival of single-node failure | Retrying a non-idempotent write can double-apply; retry storms amplify an outage |
| DC-aware policy pinned to local DC | Predictable low latency; no accidental WAN queries | No automatic failover if the whole local DC dies — that must be an application/deploy decision |
| Automatic paging | Bounded memory on large scans | Each page is a fresh coordinator round trip; page size is a real tuning knob |
| Object mappers (`cassandra-driver` mapper, Spring Data) | Less boilerplate | Hides query shape; encourages relational patterns Cassandra punishes |
## 7. Common Mistakes & Best Practices

1. ⚠️ **Creating a new `Cluster`/`CqlSession` per request or per worker.** → ✅ One session per process, created at startup, closed at shutdown. Session construction opens pools, fetches metadata, and authenticates — tens to hundreds of milliseconds each time.
2. ⚠️ **Building CQL with string formatting.** → ✅ Always prepare with `?` bind markers. String interpolation loses token-aware routing, costs coordinator parse CPU, and is a CQL-injection vector.
3. ⚠️ **Calling `session.prepare()` inside a request handler.** → ✅ Prepare once at startup and store the handle. Preparing per request adds a round trip and, at scale, hammers the server's prepared statement cache.
4. ⚠️ **Leaving `is_idempotent` unset.** → ✅ Set it explicitly `True` on reads and non-counter, non-LWT writes. Drivers default it to false and will silently skip retries and speculative execution.
5. ⚠️ **Marking counter updates, list appends, LWTs, or `now()` statements idempotent.** → ✅ Leave those false. A retried counter increment double-counts; a retried list append duplicates the element.
6. ⚠️ **Forgetting `withLocalDatacenter` / `local_dc`.** → ✅ Always pin it. In Java driver 4.x it is mandatory; in Python, omitting it gives you round-robin across all DCs and random WAN latency.
7. ⚠️ **Enabling remote-DC failover in the load balancing policy.** → ✅ Keep the query plan local-only. Cross-DC fallback turns a local blip into a cluster-wide latency event, and `LOCAL_QUORUM` cannot even be satisfied remotely. Handle DC failure at the deployment layer.
8. ⚠️ **Unbounded `execute_async` in a loop.** → ✅ Use `execute_concurrent_with_args(concurrency=64…)` or a semaphore. Unbounded fan-out fills coordinator queues and produces `OverloadedException` and dropped mutations.
9. ⚠️ **Using logged batches as a performance optimization.** → ✅ Batches are for atomicity within a single partition, not throughput. A multi-partition logged batch writes a batchlog, coordinates across replicas, and is slower than N parallel writes.
10. ⚠️ **`SELECT *` with no `LIMIT` and no paging awareness.** → ✅ Set `fetch_size`/`page-size` and iterate; never `list()` an unbounded result set. Better still, do not write unbounded scans.
11. ⚠️ **Setting driver `request_timeout` longer than the server's `read_request_timeout_in_ms`.** → ✅ Keep the client timeout slightly *above* the server timeout so the server's own timeout fires first and returns a meaningful error, but not so high that a slow query pins a client thread for 30 seconds.
12. ⚠️ **Ignoring driver metrics.** → ✅ Enable `cql-requests`, `cql-client-timeouts`, `connected-nodes`, and per-node `retries`/`errors`, and graph them. Client-side latency histograms are the only place a coordinator-hop problem is visible.
## 8. Production: Debugging, Monitoring, Security & Scaling

### Debugging

The decisive question when latency is bad: is the gap client-side or server-side? Compare the driver's `cql-requests` histogram against the server's `ClientRequest.Read.Latency`. A large gap means the driver, the network, or GC in your application.

```python
# Prove token awareness is working: trace a single query.
stmt = SELECT_RECENT.bind((customer_id, 20))
result = session.execute(stmt, trace=True)
trace = result.get_query_trace()
print(trace.coordinator, trace.duration)
for e in trace.events:
    print(f"{e.source} {e.source_elapsed:>7} {e.description}")
# 10.0.1.12  0        Parsing SELECT ...
# 10.0.1.12  312      Executing single-partition query on orders_by_customer
# 10.0.1.12  1104     Read 20 live rows and 0 tombstone cells
# If coordinator == a replica for that key, routing is correct.
```

```java
// Java: inspect the query plan actually used
ExecutionInfo info = rs.getExecutionInfo();
System.out.println(info.getCoordinator());          // which node served it
System.out.println(info.getErrors());               // per-node failures before success
System.out.println(info.getSpeculativeExecutionCount());
```

Enable driver logging at `DEBUG` for `com.datastax.oss.driver.internal.core.pool` / `cassandra.pool` to see reconnections, and watch for `Re-preparing` log lines, which indicate the server's prepared cache is evicting.

### Monitoring

| Client-side metric | Why it matters |
|---|---|
| `cql-requests` (timer) | End-to-end latency including client queueing — the number your users feel |
| `cql-client-timeouts` | Requests the driver gave up on; should be near zero |
| `connected-nodes` | Drops indicate topology or network problems before the server notices |
| `throttling.delay` / in-flight count | Whether your own back-pressure is engaging |
| per-node `retries`, `errors`, `ignores` | Isolates a single bad replica |
| `speculative-executions` | If high, a replica is consistently slow |
| `bytes-sent` / `bytes-received` | Detects accidental `SELECT *` and oversized rows |

Pair these with server-side `ClientRequest` latencies and `Table` metrics from chapter 37's list.

### Security

Credentials come from the environment or a secrets manager, never from source. Enable TLS with hostname verification in the driver's SSL context (chapter 39) — a driver configured with `check_hostname = False` silently accepts any certificate. Use a narrow application role (chapter 38), and prefer prepared statements not only for performance but because they eliminate CQL injection: bind values are never parsed as CQL. If you use mutual TLS, keep the client keystore out of container images and mount it at runtime.

### Performance & Scaling

Scaling client-side is mostly about not doing harmful things: reuse the session, bound concurrency, keep the query plan local. When you genuinely need more throughput from one process, raise `max-requests-per-connection` first and `pool.local.size` second, and confirm with `bytes-sent` that the socket is actually the bottleneck. For batch/ETL workloads, use a dedicated execution profile with `LOCAL_ONE`, a large page size, and a longer timeout, so analytics traffic cannot starve the interactive profile. And instrument in-flight request counts — the single best early-warning signal that your application is about to overwhelm the cluster.
## 9. Interview Questions

**Q: Why is a prepared statement faster than a simple statement, beyond parse time?**
A: Preparation returns metadata that includes which bind markers make up the partition key, which is what lets the driver compute the routing key and send the query straight to a replica that owns the token. Without it, the driver picks a host by round-robin, so roughly two out of three queries at `RF=3` take an extra coordinator hop. The saved parsing CPU is real but secondary to eliminating that hop and its queueing.

**Q: How many sessions should an application create?**
A: One per process, for the lifetime of the process. A session holds connection pools, cluster metadata, the token map, and the prepared statement cache, and creating one costs a full topology discovery plus authentication. Creating a session per request or per worker thread is the single most common and most expensive driver mistake.

**Q: What does the idempotence flag control?**
A: It tells the driver whether re-executing a statement is safe, which gates both retry-on-timeout and speculative execution. Drivers default it to false, so ordinary reads and writes get none of that resilience unless you set it explicitly. Counter updates, collection appends, lightweight transactions, and statements using `now()` or `uuid()` must stay non-idempotent.

**Q: A write times out. Was the write applied?**
A: Unknown. A `WriteTimeoutException` means the coordinator did not receive enough acknowledgements before its timeout, but the mutation may already be durable on one or more replicas and hinted handoff may complete it later. That is precisely why safe retry requires idempotent statements — and why you should design writes to be naturally idempotent wherever possible.

**Q: What load balancing policy should production use, and why?**
A: `TokenAwarePolicy` wrapping `DCAwareRoundRobinPolicy` pinned to the local datacenter. Token awareness removes the coordinator hop; DC awareness keeps queries off the WAN; and the token-aware wrapper shuffles among the local replicas so one node does not absorb all the traffic for a hot token range. Remote-DC failover should stay disabled.

**Q: What is speculative execution and when is it dangerous?**
A: After a configured delay (say 20 ms), the driver sends the same query to a second replica and uses whichever response arrives first, which hides a single slow node and sharply tightens p99. It is dangerous when the statement is not idempotent, because the query genuinely executes more than once, and it is dangerous when set too aggressively, because it multiplies cluster load exactly when the cluster is already struggling.

**Q: (Senior) Client p99 is 34 ms; server-side p99 is 3 ms. Where is the time?**
A: Somewhere between the application and the coordinator, so investigate in this order: client GC pauses and thread-pool queueing in the application, unbounded async fan-out filling the driver's in-flight queue, missing token awareness adding a hop, an unpinned `local_dc` sending some fraction of queries across the WAN, and connection pool saturation. Turn on `trace=True` for a sample of queries and check whether the coordinator is a replica for the key; check `cql-requests` versus per-node `ClientRequest` latency to localize the gap; and graph in-flight request count against latency to detect self-inflicted queueing.

**Q: (Senior) How do prepared statements interact with node restarts and schema changes?**
A: Prepared statements are cached per node. When a node restarts its cache is empty, so it responds `UNPREPARED` and the driver transparently re-prepares — fine occasionally, but a large statement set across a rolling restart produces a re-preparation burst. Schema changes are the sharper edge: altering a table invalidates prepared statements whose result metadata changed, and historically `SELECT *` prepared statements could return stale column metadata after an `ALTER TABLE ADD`, which is one more reason to enumerate columns explicitly. Keep the number of distinct prepared statements bounded — generating one per unique query string in a loop will blow both the driver and server caches.

**Q: (Senior) Design the driver configuration for a service with an interactive path and a nightly export.**
A: Use one session with two execution profiles. The interactive profile: `LOCAL_QUORUM`, 2-second timeout, page size ~500, token-aware DC-aware policy, speculative execution at ~p99 latency, idempotent statements. The export profile: `LOCAL_ONE` to reduce replica load, 30-second timeout, page size 5000, no speculative execution, and explicit bounded concurrency via `execute_concurrent`. Run the export against a workload-isolated datacenter if one exists, and throttle it in the application so it can never consume the in-flight budget the interactive path needs. Sharing a session keeps connection and metadata overhead single, while the profiles keep the two workloads' failure modes independent.

**Q: Why should client timeouts relate to server timeouts?**
A: The server enforces `read_request_timeout_in_ms` and `write_request_timeout_in_ms` (2000 ms and 5000 ms by default) and returns a structured timeout exception the driver can act on. If the client timeout is shorter, the driver abandons a request the server is still working on, wasting cluster capacity and hiding the real error. Setting the client timeout modestly above the server's lets the server's own timeout fire first and produce an actionable exception.

**Q: When should you use a batch?**
A: Only when you need atomicity across rows in the *same partition* — an unlogged, single-partition batch is one mutation on one replica set and is genuinely efficient. Multi-partition logged batches write a batchlog to two replicas first and then coordinate, which is slower than issuing the same statements concurrently and does not give you a transaction. Using batches to "reduce round trips" is the classic relational instinct that hurts on Cassandra.

**Q: How does automatic paging work and what should the page size be?**
A: The server returns up to `page_size` rows plus an opaque `paging_state` cursor; iterating past the end of a page makes the driver fetch the next one transparently. Defaults are 5000 rows in most drivers, which is often too large for wide rows — each page must be materialized in coordinator memory. Use a few hundred for interactive queries with fat rows and several thousand for narrow-row exports, and for stateless HTTP APIs hand the encoded `paging_state` back to the client instead of re-scanning.
## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** The driver is where routing, retries, and consistency choices live. Create exactly one session per process and keep it forever. Prepare every statement once at startup — preparation is what gives the driver `partition_key_bind_indexes`, and without it token-aware routing cannot work, costing an extra coordinator hop on most queries. Use `TokenAwarePolicy(DCAwareRoundRobinPolicy(local_dc=...))` and never enable remote-DC failover. Set `is_idempotent = True` on reads and ordinary writes so retries and speculative execution engage, and leave it false for counters, list appends, LWTs, and `now()`. A write timeout does not mean the write failed. Bound async fan-out with `execute_concurrent` or a semaphore; unbounded `execute_async` in a loop is how healthy clusters get overwhelmed. Use execution profiles to separate interactive (`LOCAL_QUORUM`, 2 s, small pages) from analytics (`LOCAL_ONE`, 30 s, big pages). Watch client-side `cql-requests` versus server `ClientRequest` latency to find where the time actually goes.

| Item | Python | Java 4.x |
|---|---|---|
| Session | `Cluster(...).connect(ks)` | `CqlSession.builder()...build()` |
| Local DC | `DCAwareRoundRobinPolicy(local_dc=...)` | `.withLocalDatacenter("dc_east")` (mandatory) |
| Prepare | `session.prepare(cql)` | `session.prepare(cql)` |
| Idempotent | `stmt.is_idempotent = True` | `.setIdempotent(true)` |
| Consistency | `ExecutionProfile(consistency_level=...)` | `basic.request.consistency` |
| Page size | `fetch_size=500` | `basic.request.page-size = 500` |
| Async | `session.execute_async(...)` | `session.executeAsync(...)` |
| Bounded bulk | `execute_concurrent_with_args(..., concurrency=64)` | semaphore + `executeAsync` |
| Speculative | `ConstantSpeculativeExecutionPolicy(0.02, 2)` | `ConstantSpeculativeExecutionPolicy` |
| Tracing | `session.execute(stmt, trace=True)` | `rs.getExecutionInfo().getQueryTrace()` |
| Default page size | 5000 rows | 5000 rows |
| Streams per connection | 32768 (protocol v5) | 32768 (protocol v5) |

**Flash cards**

- **Sessions per process** → Exactly one, for the process lifetime.
- **Why prepare** → Metadata gives partition key indexes → token-aware routing → one fewer hop.
- **Idempotence default** → `false`; retries and speculative execution are disabled until you set it.
- **Production LB policy** → `TokenAware(DCAwareRoundRobin(local_dc))`, remote failover off.
- **Write timeout meaning** → "Not enough acks in time", not "did not happen".
## 11. Hands-On Exercises & Mini Project

- [ ] Build the `shop.orders_by_customer` table on a 3-node `ccm` cluster, then measure p99 latency for 10,000 reads issued (a) with an f-string simple statement and round-robin, and (b) with a prepared statement and `TokenAwarePolicy`. Report the difference.
- [ ] Use `session.execute(stmt, trace=True)` to print the coordinator for 20 queries with different partition keys, and verify the coordinator is always a replica for that key when token awareness is on.
- [ ] Write a loop that issues 100,000 `execute_async` calls with no back-pressure and record what happens (client memory, `OverloadedException`, timeouts). Then rewrite it with `execute_concurrent_with_args(concurrency=64)` and compare throughput and error rate.
- [ ] Take a node down with `ccm node2 stop` while a read loop runs, with and without `is_idempotent = True`, and observe how many requests fail in each case.
- [ ] Implement stateless HTTP pagination: expose an endpoint that returns 50 rows plus a base64 `paging_state`, and accepts that cursor to fetch the next page. Verify the cursor survives across processes.

### Mini Project — "Order History Service"

**Goal.** Build a small HTTP service over `shop.orders_by_customer` that demonstrates every production driver practice, with measurements proving each one matters.

**Requirements.**
1. A single module-level session created at startup with pinned `local_dc`, TLS, environment-sourced credentials, and two execution profiles (`interactive` and `export`).
2. All statements prepared at startup into a registry; a startup assertion that fails the process if any statement is prepared after the first request is served.
3. Endpoints: `GET /customers/{id}/orders?cursor=` with driver paging exposed as an opaque cursor, and `POST /orders` writing with `LOCAL_QUORUM` and idempotent statements.
4. A `/metrics` endpoint exporting driver metrics (`cql-requests` histogram, `cql-client-timeouts`, `connected-nodes`, in-flight count) in Prometheus format.
5. A load-test script that reports client p50/p99/p999 and, for a sample of requests, the coordinator node from the query trace — proving token-aware routing.

**Extensions.**
- Add a bulk import path using `execute_concurrent_with_args` with a configurable concurrency, and chart throughput versus error rate as concurrency goes from 8 to 1024 to find the knee.
- Add speculative execution to the interactive profile with a delay set from the measured p99, then artificially slow one node (`tc netem delay 50ms`) and show the p99 improvement.
- Add a circuit breaker that trips on sustained `cql-client-timeouts` and sheds load rather than queueing, and demonstrate that the cluster recovers faster with it than without.
## 12. Related Topics & Free Learning Resources

**Sibling chapters.** *Consistency Levels & Tunable Consistency* — what `LOCAL_QUORUM` in an execution profile actually costs; *Data Modeling & Partition Design* — the partition key the driver hashes; *Authentication, Authorization & RBAC* and *Encryption & Auditing* — auth providers and SSL contexts on the client; *Spark, Kafka & Streaming Integration* — bulk paths that bypass the request path; *Cassandra 4.x & 5.x New Features* — protocol v5, vector types, and SAI-aware querying; *Performance Tuning* — matching client timeouts to server timeouts.

- **DataStax Java Driver 4.x Manual** — DataStax · *Intermediate* · The reference for `CqlSession`, execution profiles, `application.conf`, load balancing, and retry semantics. <https://docs.datastax.com/en/developer/java-driver/latest/>
- **DataStax Python Driver Documentation** — DataStax · *Beginner* · Covers `ExecutionProfile`, `execute_concurrent`, paging, and policies with runnable examples. <https://docs.datastax.com/en/developer/python-driver/latest/>
- **Apache Cassandra — Native Protocol v5 Specification** — Apache Software Foundation · *Advanced* · The wire format: frames, stream ids, PREPARE/EXECUTE, and error codes. Read it once and driver behaviour stops being mysterious. <https://github.com/apache/cassandra/blob/trunk/doc/native_protocol_v5.spec>
- **DataStax — Driver Best Practices** — DataStax Developer Docs · *Intermediate* · Concise, opinionated list covering session reuse, preparation, idempotence, and paging. <https://docs.datastax.com/en/developer/java-driver/latest/manual/core/>
- **Apache Cassandra — Query Tracing** — Apache Software Foundation · *Intermediate* · How to read a trace, which is the only way to prove where a query's time went. <https://cassandra.apache.org/doc/latest/cassandra/managing/tools/nodetool/settraceprobability.html>
- **The Last Pickle — "Improving Cassandra Client Performance"** — The Last Pickle · *Advanced* · Practitioner analysis of prepared statements, token awareness, and concurrency limits with measurements. <https://thelastpickle.com/blog/2019/03/28/cassandra-performance-tuning.html>
- **DataStax Academy — DS210: Operations and Performance Tuning** — DataStax Academy · *Intermediate* · Free course covering the client/server latency split and how to attribute it correctly. <https://www.datastax.com/learn/datastax-academy>
- **Cassandra Java Driver GitHub — examples/** — DataStax · *Beginner* · Runnable programs for async, paging, mapper usage, and SSL configuration. <https://github.com/apache/cassandra-java-driver/tree/4.x/examples>

---

*Apache Cassandra Handbook — chapter 40.*
