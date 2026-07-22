# 14 · Batches & Lightweight Transactions

> **In one line:** A logged batch buys you atomicity across partitions but never isolation, and a lightweight transaction buys you linearizable compare-and-set at the price of four round trips of Paxos — neither one is a database transaction.

---

## 1. Overview

Two CQL features are misunderstood more often than everything else in Cassandra combined: `BEGIN BATCH` and `IF NOT EXISTS`. Both borrow syntax from the relational world and both mean something materially different here. `BATCH` is not `BEGIN TRANSACTION` — there is no rollback, no isolation, and no read view. Lightweight transactions (LWT) are not lightweight — they run a full Paxos consensus round and cost roughly 4× the latency of a normal write. Getting these two wrong is the single most common cause of a Cassandra cluster that "mysteriously" falls over at 3× normal load.

Batches exist to solve one narrow problem: **denormalized-table consistency**. Cassandra's data model forces you to write the same logical fact into several tables — `users_by_id`, `users_by_email`, `users_by_org` — because there are no joins and no secondary lookups at scale. If your application writes three of those four tables and then crashes, your data is permanently inconsistent with no mechanism to detect it. A *logged* batch closes that gap: the coordinator persists the batch to a replicated batchlog before applying anything, and a background replay ensures every mutation eventually lands even if the coordinator dies mid-flight. That is atomicity (all-or-nothing, eventually) without isolation (readers can and will observe partial state).

LWTs exist to solve a different narrow problem: **the absence of read-before-write**. Cassandra normally cannot answer "does this username already exist?" atomically, because two coordinators can both see "no" and both write. Cassandra 2.0 (CASSANDRA-5062) added Paxos-based conditional updates: `INSERT ... IF NOT EXISTS`, `UPDATE ... IF col = value`, `DELETE ... IF EXISTS`. These are *linearizable* per partition — a genuinely strong guarantee, stronger than QUORUM — implemented by running a full Paxos ballot among replicas. Cassandra 5.0 ships accord/`ACCORD` transactions as an experimental successor (CEP-15), but Paxos LWT remains the production answer.

The historical motivation is instructive. Early Cassandra deployments routinely faked uniqueness with `SELECT` then `INSERT`, and routinely produced duplicate accounts under concurrency. Meanwhile, unlogged batches were being used as "bulk insert" by developers coming from JDBC, where batching is a client-side latency optimisation. In Cassandra it is the opposite: a large unlogged batch across many partitions makes a *single* coordinator responsible for fanning out to the whole ring, creating a hot node, filling its mutation queue, and producing exactly the tail-latency spike batching was supposed to avoid.

A concrete example: a ride-hailing platform assigns each driver a unique vehicle plate. Registering a driver writes `drivers_by_id` and `drivers_by_plate` — a two-table logged batch, so a coordinator crash never leaves a driver with no plate index. Claiming the plate itself is `INSERT INTO drivers_by_plate (...) IF NOT EXISTS` — an LWT, because two simultaneous registrations of the same plate must not both succeed. Everything else in the system — location pings, trip events, fare updates — is a plain single-partition upsert, because at 200k writes/second nothing else is affordable.

## 2. Core Concepts

- **Logged batch** — the default `BEGIN BATCH`. The coordinator writes the batch to the `system.batches` table on two replicas *in other racks* before applying mutations; a replay daemon retries incomplete batches. Guarantees eventual atomicity, not isolation.
- **Unlogged batch** — `BEGIN UNLOGGED BATCH`. No batchlog, no atomicity guarantee. Only useful when all mutations share the **same partition key**, where it becomes a single atomic-and-isolated row mutation.
- **Batchlog** — the `system.batches` table plus the `BatchlogManager` replay thread; entries are removed when all mutations are confirmed applied, replayed every `batchlog_replay_throttle` window otherwise.
- **Single-partition batch** — a batch where every statement targets one partition; Cassandra collapses it into one `Mutation`, giving both atomicity **and** isolation for free at normal write cost.
- **Lightweight transaction (LWT)** — a conditional statement (`IF NOT EXISTS`, `IF EXISTS`, `IF col = v`) executed via Paxos, providing linearizable compare-and-set scoped to a single partition.
- **Paxos ballot** — a `TimeUUID` proposal number; higher ballots pre-empt lower ones. Stored per-partition in `system.paxos`.
- **SERIAL / LOCAL_SERIAL** — the *serial consistency level* controlling the Paxos quorum: `SERIAL` requires a quorum of all replicas across DCs; `LOCAL_SERIAL` a quorum within the local DC only. Set separately from the normal consistency level.
- **`[applied]` column** — every LWT returns a result set whose first column is a boolean `[applied]`; when `false`, the current values of the tested columns are returned so the client can retry with fresh state.
- **Paxos contention** — when concurrent LWTs on the same partition pre-empt each other's ballots, causing retries and eventually `WriteTimeoutException` with `writeType=CAS`. Throughput on a hot partition collapses non-linearly.
- **CAS latency profile** — 4 round trips (prepare/promise, propose/accept, commit, plus a read) versus 1 for a normal write; expect ~4× p50 and much worse p99 under contention.

## 3. Theory & Internals

**Batch internals.** A logged batch is not a transaction log in the WAL sense. The coordinator serialises all mutations into a single blob and writes it to `system.batches` at consistency level ONE on **two** replica nodes chosen from different racks (or different nodes if only one rack exists). Only then does it dispatch the individual mutations to their own replica sets at the client's consistency level. When every mutation is acknowledged, the coordinator deletes the batchlog entry. If the coordinator dies before that, the `BatchlogManager` on the batchlog replicas notices an entry older than `write_request_timeout_in_ms * 2` and replays every mutation in it.

The guarantee this yields is precisely: *if any mutation in the batch is visible, all of them will eventually become visible.* It says nothing about **when**, and nothing about what a concurrent reader sees. A reader can observe mutation 1 applied and mutation 2 not applied, indefinitely, until replay completes. There is no rollback: a batch that fails halfway is rolled *forward*, never back.

The cost is real: every logged batch is 2 extra writes plus 2 extra deletes on top of the actual mutations, all funnelled through one coordinator. A 100-statement logged batch spanning 100 partitions makes that coordinator do the work of 100 clients. `batch_size_warn_threshold` (5 KiB default) and `batch_size_fail_threshold` (50 KiB) exist because this pattern reliably kills clusters.

**Paxos internals.** An LWT runs the classic four-phase sequence, scoped to one partition:

1. **Prepare/Promise** — the coordinator picks a ballot (a `TimeUUID`, so monotonic and globally ordered) and asks a SERIAL quorum of replicas to promise not to accept lower ballots. Replicas reply with any previously accepted-but-uncommitted proposal.
2. **Read** — the coordinator reads the current values of the tested columns at quorum, to evaluate the `IF` condition.
3. **Propose/Accept** — if the condition holds, the coordinator proposes the mutation; a SERIAL quorum must accept it.
4. **Commit** — the accepted value is committed to the normal storage engine on the replicas and the Paxos state is cleared.

If a replica reports an in-flight proposal from an older ballot, the coordinator must first *finish that one* (a "repair" of the Paxos round) before proceeding — this is why contention is so punishing: N concurrent writers can spend all their time completing each other's rounds.

The quorum math: `SERIAL` quorum = `floor(RF_total/2) + 1` across all DCs; `LOCAL_SERIAL` = `floor(RF_local/2) + 1`. Critically, **reads of LWT-managed data must also use `SERIAL`/`LOCAL_SERIAL`** to be linearizable; a normal `LOCAL_QUORUM` read can return a value from an accepted-but-not-yet-committed Paxos round or miss one, breaking linearizability.

```svg
<svg viewBox="0 0 720 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="720" height="320" fill="#ffffff"/>
  <text x="360" y="24" text-anchor="middle" font-size="15" font-weight="600" fill="#1e293b">Paxos LWT: four phases on one partition (RF=3, LOCAL_SERIAL=2)</text>
  <rect x="20" y="50" width="110" height="240" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="75" y="72" text-anchor="middle" font-size="12" font-weight="600" fill="#1e293b">Coordinator</text>
  <text x="75" y="96" text-anchor="middle" font-size="11" fill="#1e293b">ballot =</text>
  <text x="75" y="112" text-anchor="middle" font-size="11" fill="#1e293b">TimeUUID(now)</text>
  <rect x="580" y="50" width="120" height="70" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="640" y="90" text-anchor="middle" font-size="12" fill="#1e293b">Replica A</text>
  <rect x="580" y="130" width="120" height="70" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="640" y="170" text-anchor="middle" font-size="12" fill="#1e293b">Replica B</text>
  <rect x="580" y="210" width="120" height="70" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="640" y="243" text-anchor="middle" font-size="12" fill="#1e293b">Replica C</text>
  <text x="640" y="262" text-anchor="middle" font-size="10" fill="#1e293b">(not needed)</text>
  <rect x="150" y="52" width="410" height="46" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="355" y="70" text-anchor="middle" font-size="11" font-weight="600" fill="#1e293b">1. PREPARE(ballot) &#8594; PROMISE</text>
  <text x="355" y="88" text-anchor="middle" font-size="10" fill="#1e293b">replicas promise to reject lower ballots</text>
  <rect x="150" y="106" width="410" height="46" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="355" y="124" text-anchor="middle" font-size="11" font-weight="600" fill="#1e293b">2. READ current values at SERIAL quorum</text>
  <text x="355" y="142" text-anchor="middle" font-size="10" fill="#1e293b">evaluate the IF condition</text>
  <rect x="150" y="160" width="410" height="46" rx="6" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="355" y="178" text-anchor="middle" font-size="11" font-weight="600" fill="#1e293b">3. PROPOSE(ballot, mutation) &#8594; ACCEPT</text>
  <text x="355" y="196" text-anchor="middle" font-size="10" fill="#1e293b">quorum must accept, else pre-empted &#8594; retry</text>
  <rect x="150" y="214" width="410" height="46" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="355" y="232" text-anchor="middle" font-size="11" font-weight="600" fill="#1e293b">4. COMMIT &#8594; storage engine, clear system.paxos</text>
  <text x="355" y="250" text-anchor="middle" font-size="10" fill="#1e293b">return [applied]=true, or false + current values</text>
  <text x="360" y="285" text-anchor="middle" font-size="11" fill="#1e293b">4 round trips vs 1 for a plain write. Reads must use SERIAL to stay linearizable.</text>
  <text x="360" y="305" text-anchor="middle" font-size="11" fill="#1e293b">Concurrent ballots pre-empt each other &#8212; throughput collapses on a hot partition.</text>
</svg>
```

Two details that bite in production. First, **LWT and non-LWT writes to the same partition do not interact safely**: a blind `UPDATE` can overwrite a value an LWT just conditionally set, because the blind write never consults Paxos state. Choose one discipline per table. Second, `system.paxos` rows are themselves data with their own tombstones; heavy LWT traffic on one partition generates continuous churn there, and 4.0 added `paxos_purge_grace_seconds` plus `nodetool` visibility to manage it.

## 4. Architecture & Workflow

Walk a real registration flow — claim a unique plate, then write two denormalized tables:

1. **Client issues the LWT.** `INSERT INTO drivers_by_plate (plate, driver_id) VALUES (?, ?) IF NOT EXISTS` with `serial_consistency = LOCAL_SERIAL`, `consistency = LOCAL_QUORUM`.
2. **Coordinator selection.** The driver routes token-aware to a replica of `plate`. That node becomes both coordinator and Paxos proposer.
3. **Prepare phase.** Coordinator generates ballot `b1`, sends `PREPARE(b1)` to the 3 local replicas, waits for 2 promises. Any replica holding an uncommitted higher-ballot proposal replies with it, forcing the coordinator to finish that round first.
4. **Condition read.** Coordinator reads `plate` at the serial quorum and evaluates `IF NOT EXISTS`. If the row exists, it short-circuits: returns `[applied]=false` plus the existing row — **no mutation is proposed**, but the prepare round still cost 2 round trips.
5. **Propose phase.** Coordinator sends `PROPOSE(b1, mutation)`; 2 replicas persist it in `system.paxos` and accept.
6. **Commit phase.** Coordinator sends `COMMIT`; replicas apply the mutation through the normal write path (commitlog + memtable) and clear the Paxos state. `[applied]=true` returns to the client.
7. **Batch for the denormalized tables.** With the plate claimed, the app issues `BEGIN BATCH ... APPLY BATCH` containing the `drivers_by_id` and `drivers_by_org` inserts.
8. **Batchlog write.** Coordinator serialises both mutations and writes them to `system.batches` on 2 replicas in distinct racks at CL ONE.
9. **Mutation fan-out.** Coordinator dispatches each mutation to its own replica set at `LOCAL_QUORUM`, in parallel.
10. **Batchlog cleanup.** On full acknowledgement the coordinator deletes the batchlog rows. If it crashed at step 9, `BatchlogManager` on the batchlog replicas replays both mutations within ~2× the write timeout.

```svg
<svg viewBox="0 0 720 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="720" height="330" fill="#ffffff"/>
  <text x="360" y="24" text-anchor="middle" font-size="15" font-weight="600" fill="#1e293b">Logged batch: batchlog first, then fan-out, then cleanup</text>
  <rect x="20" y="60" width="110" height="60" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="75" y="85" text-anchor="middle" font-size="12" font-weight="600" fill="#1e293b">Client</text>
  <text x="75" y="104" text-anchor="middle" font-size="11" fill="#1e293b">BEGIN BATCH</text>
  <rect x="175" y="60" width="130" height="60" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="240" y="85" text-anchor="middle" font-size="12" font-weight="600" fill="#1e293b">Coordinator</text>
  <text x="240" y="104" text-anchor="middle" font-size="11" fill="#1e293b">serialise blob</text>
  <path d="M133 90 L171 90" stroke="#4f46e5" stroke-width="2" fill="none"/>
  <path d="M171 90 l-9 -5 v10 z" fill="#4f46e5"/>
  <rect x="360" y="40" width="150" height="60" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="435" y="63" text-anchor="middle" font-size="11" font-weight="600" fill="#1e293b">system.batches</text>
  <text x="435" y="82" text-anchor="middle" font-size="10" fill="#1e293b">2 replicas, distinct racks</text>
  <path d="M307 80 L356 70" stroke="#d97706" stroke-width="2" fill="none"/>
  <path d="M356 70 l-10 -3 v9 z" fill="#d97706"/>
  <text x="333" y="47" text-anchor="middle" font-size="10" fill="#1e293b">step 1</text>
  <rect x="360" y="120" width="150" height="46" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="435" y="140" text-anchor="middle" font-size="11" fill="#1e293b">drivers_by_id</text>
  <text x="435" y="157" text-anchor="middle" font-size="10" fill="#1e293b">replica set P1</text>
  <rect x="360" y="176" width="150" height="46" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="435" y="196" text-anchor="middle" font-size="11" fill="#1e293b">drivers_by_org</text>
  <text x="435" y="213" text-anchor="middle" font-size="10" fill="#1e293b">replica set P2</text>
  <path d="M307 100 L356 138" stroke="#16a34a" stroke-width="1.5" fill="none"/>
  <path d="M307 108 L356 194" stroke="#16a34a" stroke-width="1.5" fill="none"/>
  <text x="333" y="175" text-anchor="middle" font-size="10" fill="#1e293b">step 2</text>
  <rect x="545" y="120" width="155" height="102" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="622" y="145" text-anchor="middle" font-size="11" font-weight="600" fill="#1e293b">All acked?</text>
  <text x="622" y="166" text-anchor="middle" font-size="10" fill="#1e293b">yes &#8594; delete batchlog</text>
  <text x="622" y="185" text-anchor="middle" font-size="10" fill="#1e293b">no  &#8594; BatchlogManager</text>
  <text x="622" y="204" text-anchor="middle" font-size="10" fill="#1e293b">replays after ~2x timeout</text>
  <path d="M514 170 L541 170" stroke="#4f46e5" stroke-width="1.5" fill="none"/>
  <rect x="150" y="248" width="420" height="40" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="360" y="273" text-anchor="middle" font-size="11" fill="#1e293b">A reader between step 2 and completion sees P1 applied and P2 not. No isolation.</text>
  <text x="360" y="312" text-anchor="middle" font-size="11" fill="#1e293b">Atomicity = rolled forward eventually. There is no rollback in Cassandra.</text>
</svg>
```

## 5. Implementation

```cql
CREATE KEYSPACE fleet WITH replication = {
  'class': 'NetworkTopologyStrategy', 'us_east': 3, 'eu_west': 3
};

CREATE TABLE fleet.drivers_by_id (
  driver_id uuid PRIMARY KEY, plate text, org_id uuid, name text, status text);

CREATE TABLE fleet.drivers_by_plate (
  plate text PRIMARY KEY, driver_id uuid, claimed_at timestamp);

CREATE TABLE fleet.drivers_by_org (
  org_id uuid, driver_id uuid, name text, PRIMARY KEY (org_id, driver_id));
```

Uniqueness via LWT — the only correct way:

```cql
INSERT INTO fleet.drivers_by_plate (plate, driver_id, claimed_at)
VALUES ('KA01AB1234', 6f1c2d10-6a1c-11f0-9c3d-0242ac120002, toTimestamp(now()))
IF NOT EXISTS;

--  [applied] | plate      | driver_id                            | claimed_at
-- -----------+------------+--------------------------------------+---------------------
--      False | KA01AB1234 | 3ab19f20-5511-11f0-8e0a-0242ac120002 | 2026-07-19 09:11:04
```

Conditional state machine transition — guard against illegal transitions:

```cql
UPDATE fleet.drivers_by_id SET status = 'ON_TRIP'
 WHERE driver_id = 6f1c2d10-6a1c-11f0-9c3d-0242ac120002
    IF status = 'AVAILABLE';

DELETE FROM fleet.drivers_by_plate WHERE plate = 'KA01AB1234' IF EXISTS;
```

Batches — the good and the bad:

```cql
-- GOOD: single-partition unlogged batch. Atomic AND isolated, normal write cost.
BEGIN UNLOGGED BATCH
  INSERT INTO fleet.drivers_by_org (org_id, driver_id, name) VALUES (?, ?, 'Ada');
  INSERT INTO fleet.drivers_by_org (org_id, driver_id, name) VALUES (?, ?, 'Grace');
APPLY BATCH;   -- same org_id => same partition

-- ACCEPTABLE: small logged batch keeping denormalized views in sync.
BEGIN BATCH
  INSERT INTO fleet.drivers_by_id  (driver_id, plate, org_id, name, status)
    VALUES (?, ?, ?, ?, 'AVAILABLE');
  INSERT INTO fleet.drivers_by_org (org_id, driver_id, name) VALUES (?, ?, ?);
APPLY BATCH;

-- BAD: 5000 unrelated partitions through one coordinator. This is not "bulk insert".
BEGIN BATCH
  INSERT INTO fleet.drivers_by_id (driver_id, name) VALUES (uuid(), 'd1');
  -- ... 4999 more ...
APPLY BATCH;
-- WARN  Batch of prepared statements for [fleet.drivers_by_id] is of size 214812,
--       exceeding specified threshold of 5120 by 209692.
```

Batch-scoped conditions are allowed only within one partition:

```cql
BEGIN BATCH
  UPDATE fleet.drivers_by_id SET status = 'OFFLINE' WHERE driver_id = ? IF status = 'AVAILABLE';
  UPDATE fleet.drivers_by_id SET name   = 'Ada'     WHERE driver_id = ?;
APPLY BATCH;
-- All statements must target the SAME partition, else:
-- InvalidRequest: Batch with conditions cannot span multiple partitions
```

Python driver: correct retry loop with fresh state and separate serial CL:

```python
from cassandra.cluster import Cluster
from cassandra.query import SimpleStatement, ConsistencyLevel
import uuid, time

session = Cluster(["10.0.1.11"]).connect("fleet")

claim = session.prepare("""
    INSERT INTO drivers_by_plate (plate, driver_id, claimed_at)
    VALUES (?, ?, toTimestamp(now())) IF NOT EXISTS
""")
claim.consistency_level        = ConsistencyLevel.LOCAL_QUORUM
claim.serial_consistency_level = ConsistencyLevel.LOCAL_SERIAL
claim.is_idempotent            = False          # NEVER retry an LWT blindly

def claim_plate(plate, driver_id, attempts=3):
    for i in range(attempts):
        row = session.execute(claim, (plate, driver_id)).one()
        if row.applied:
            return True
        if row.driver_id == driver_id:
            return True                          # our own earlier attempt won
        return False                             # someone else owns it: do not retry
    raise RuntimeError("contention")

# Linearizable READ of LWT-managed data must also be SERIAL:
read = SimpleStatement("SELECT driver_id FROM drivers_by_plate WHERE plate = %s",
                       consistency_level=ConsistencyLevel.SERIAL)
print(session.execute(read, ("KA01AB1234",)).one())
```

Java, with the batch built explicitly:

```java
BatchStatement batch = BatchStatement.builder(DefaultBatchType.LOGGED)
    .addStatement(insertById.bind(driverId, plate, orgId, name, "AVAILABLE"))
    .addStatement(insertByOrg.bind(orgId, driverId, name))
    .setConsistencyLevel(DefaultConsistencyLevel.LOCAL_QUORUM)
    .build();
session.execute(batch);

ResultSet rs = session.execute(
    SimpleStatement.newInstance("UPDATE drivers_by_id SET status=? WHERE driver_id=? IF status=?",
                                "ON_TRIP", driverId, "AVAILABLE")
        .setSerialConsistencyLevel(DefaultConsistencyLevel.LOCAL_SERIAL));
if (!rs.wasApplied()) {
    String current = rs.one().getString("status");   // conflict: act on real state
}
```

Guardrails in `cassandra.yaml`:

```yaml
batch_size_warn_threshold: 5KiB
batch_size_fail_threshold: 50KiB
unlogged_batch_across_partitions_warn_threshold: 10
cas_contention_timeout: 1800ms
write_request_timeout: 2000ms
paxos_purge_grace_seconds: 60s
```

> **Optimization:** always use `LOCAL_SERIAL`, never `SERIAL`, in a multi-DC cluster unless you genuinely need global uniqueness. `SERIAL` requires a quorum across every DC, so a single LWT becomes a cross-continent round trip — 150 ms instead of 3 ms — and any DC partition makes the operation unavailable. If you need global uniqueness, shard the namespace per DC (prefix the key with the DC) and keep `LOCAL_SERIAL`.

Measure contention directly:

```bash
nodetool tablestats fleet.drivers_by_plate | grep -i "cas\|contention"
# Percent repaired: 0.0
# CAS contention histogram: 1 -> 98%, 2 -> 1.7%, 3+ -> 0.3%

nodetool proxyhistograms
# CAS Read Latency  p99  =  8.2 ms
# CAS Write Latency p99  = 24.5 ms   (vs Write p99 = 3.1 ms)
```

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Logged batch | Atomic across partitions: all mutations eventually apply or none is orphaned | 2 extra writes + 2 deletes, single-coordinator fan-out, no isolation, no rollback |
| Unlogged batch (same partition) | One atomic, isolated mutation at plain write cost | Only valid when every statement shares the partition key |
| Unlogged batch (multi-partition) | Marginal network savings on very small sets | Hot coordinator, tail-latency spike, no atomicity — almost always wrong |
| LWT `IF NOT EXISTS` | True linearizable uniqueness, impossible any other way | ~4 round trips, ~4–8× latency, collapses under same-partition contention |
| LWT `IF col = v` | Safe state-machine transitions without external locks | Must read at `SERIAL` too, or the guarantee is void |
| `LOCAL_SERIAL` | Keeps Paxos inside one DC: single-digit ms | Uniqueness is only per-DC; two DCs can each claim the same key |
| `SERIAL` | Global linearizability across DCs | Cross-DC RTT per phase; unavailable during any DC partition |
| Mixing LWT and blind writes | — | A blind write silently clobbers an LWT result; the guarantee is lost table-wide |

## 7. Common Mistakes & Best Practices

1. ⚠️ Using `BEGIN BATCH` as a bulk-loading optimisation, JDBC-style. → ✅ Batches are for atomicity, not throughput. For bulk load, fire many concurrent single-partition prepared statements (`execute_concurrent_with_args`, or Java's async + semaphore).
2. ⚠️ Assuming a logged batch gives isolation or rollback. → ✅ It gives neither. Readers see partial state; a failed batch rolls *forward*. If you need isolation, use a single-partition batch.
3. ⚠️ Multi-partition **unlogged** batches. → ✅ Either make it single-partition, or make it logged, or split it into individual statements. `unlogged_batch_across_partitions_warn_threshold` is warning you for a reason.
4. ⚠️ Running LWTs on a hot partition (e.g. `IF` on a single counter row). → ✅ Paxos contention is quadratic in concurrency. Shard the key, or move to a design where the write is an append rather than a CAS.
5. ⚠️ Reading LWT-managed data at `LOCAL_QUORUM`. → ✅ Use `SERIAL`/`LOCAL_SERIAL` for reads that must observe the linearizable value, otherwise you may read a value from an in-flight ballot.
6. ⚠️ Marking LWT statements idempotent so the driver retries them. → ✅ Never. A retried CAS can apply twice under a different ballot with different observed state. Set `is_idempotent = False` and handle `WriteTimeoutException(writeType=CAS)` explicitly — for CAS the correct recovery is to *read at SERIAL* and decide.
7. ⚠️ Mixing conditional and non-conditional writes to the same table. → ✅ Pick one discipline per table. A blind `UPDATE` bypasses Paxos entirely and can overwrite a conditionally-set value.
8. ⚠️ Using `SERIAL` in a multi-DC cluster by default. → ✅ `LOCAL_SERIAL` unless global uniqueness is a hard requirement; otherwise every write pays cross-DC latency and dies during a partition.
9. ⚠️ Ignoring `[applied] = false` and treating the LWT as successful. → ✅ Always inspect `wasApplied()` / `row.applied` and act on the returned current values; a false result is normal control flow, not an error.
10. ⚠️ Building a distributed lock from LWTs with TTL. → ✅ It mostly works and then fails catastrophically under GC pause + TTL expiry. Use a purpose-built coordination service (etcd/ZooKeeper) if you need locks; use LWT only for compare-and-set on data you already own.
11. ⚠️ Batching statements that carry different `USING TIMESTAMP` values, expecting ordering. → ✅ All statements in a batch share the batch timestamp by default; explicit per-statement timestamps in a batch are legal but make reconciliation order surprising.
12. ⚠️ Letting `system.paxos` grow unbounded from LWT churn. → ✅ Keep `paxos_purge_grace_seconds` sane, run repairs, and monitor `system.paxos` size — heavy CAS on few partitions creates constant tombstone pressure there.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** The three signatures to recognise. `WriteTimeoutException` with `writeType=CAS` means the Paxos round did not reach quorum in `cas_contention_timeout` — usually contention, sometimes a slow replica. `writeType=BATCH_LOG` means the coordinator could not write the batchlog itself; the batch never started. `writeType=BATCH` means the batchlog succeeded but mutations timed out — the batch *will* be replayed, so do not blindly retry it at the application layer. `TRACING ON` in cqlsh on an LWT shows every Paxos phase with per-replica timing, which is the fastest way to prove whether you are contending or just slow.

**Monitoring.** JMX beans that matter: `org.apache.cassandra.metrics:type=ClientRequest,scope=CASWrite,name=Latency` and `scope=CASRead,name=Latency` (compare against plain Write latency; a ratio above ~8× means contention), `type=Table,keyspace=*,scope=*,name=CasCommitLatency` / `CasPrepareLatency` / `CasProposeLatency` to isolate which phase is slow, `type=ClientRequest,scope=CASWrite,name=ContentionHistogram` (any mass above 2 retries is a red flag), and `type=Storage,name=TotalBatchesReplayed` — a nonzero rate means coordinators are dying mid-batch. Also alert on the `BatchStatement` size WARN lines in `system.log`.

**Security.** LWTs are the standard mechanism for enforcing uniqueness on security-relevant identifiers (usernames, API keys, plates). Use them, and grant `MODIFY` on the claim table narrowly. Note that a failed LWT *returns the existing row*, which is an information disclosure channel: `INSERT ... IF NOT EXISTS` on a username table tells an attacker whether a username exists, and returns the whole row. Select only what you need by keeping such tables narrow, and rate-limit the endpoint. Audit logging (4.0+) records CAS statements under the `DML` category.

**Performance & scaling.** Budget LWTs explicitly: they should be a small single-digit percentage of your write volume. A useful rule is that one partition can sustain roughly a few hundred CAS operations per second before contention dominates; beyond that, shard. Batches scale by *shrinking*: keep logged batches to 2–5 statements over 2–5 partitions and under the 5 KiB warn threshold. When a batch grows, that is a data-modelling signal — you are probably maintaining too many denormalized views synchronously and should move some to an async fan-out consumer. For genuinely transactional workloads across partitions, evaluate Cassandra 5.0's Accord (CEP-15) transactions, still experimental, or accept that Cassandra is the wrong tool for that slice of your system.

## 9. Interview Questions

**Q: Does a logged batch give you ACID transactions?**
A: No. It gives atomicity in the sense that all mutations will eventually apply if any did, enforced by the replicated batchlog and a replay daemon. It provides no isolation — concurrent readers see partial state — no consistency guarantees beyond the individual writes, and no rollback whatsoever.

**Q: When is an unlogged batch actually the right choice?**
A: When every statement in it targets the same partition key. Cassandra collapses it into a single `Mutation` applied atomically and in isolation on each replica, at the cost of a normal write. Across partitions, unlogged batches are almost always a mistake.

**Q: Why are batches not a bulk-insert optimisation?**
A: Because a batch makes one coordinator responsible for fanning out every mutation to every replica set, serialising work that would otherwise be spread across the ring. The result is a hot node, a full mutation queue, and worse tail latency than issuing the statements concurrently.

**Q: What does `[applied]` mean in an LWT result?**
A: It is a boolean first column indicating whether the condition held and the mutation was performed. When it is `false`, Cassandra also returns the current values of the columns referenced in the `IF` clause, so the client can decide what to do without an extra read.

**Q: What is the latency cost of an LWT versus a normal write?**
A: Roughly four network round trips (prepare/promise, condition read, propose/accept, commit) against one, so approximately 4× at p50 and considerably worse at p99 because contention triggers ballot pre-emption and retries. Measure `CASWrite` versus `Write` latency to see it directly.

**Q: What is the difference between SERIAL and LOCAL_SERIAL?**
A: `SERIAL` requires a Paxos quorum across all replicas in all data centres, giving global linearizability at cross-DC latency. `LOCAL_SERIAL` requires a quorum only within the local DC, giving DC-local linearizability at single-digit millisecond latency — but two DCs can independently claim the same key.

**Q: (Senior) You have an LWT-managed table and someone adds a plain UPDATE path. What breaks?**
A: Linearizability, table-wide. A blind write does not consult or update Paxos state, so it can overwrite a value that an in-flight or just-committed CAS established, and a subsequent CAS will evaluate its condition against a value that never went through consensus. The only safe rule is that every write to a partition governed by LWTs must itself be an LWT — or at minimum every conditional invariant must be re-derivable from an LWT-only column set.

**Q: (Senior) An LWT throws WriteTimeoutException with writeType=CAS. Is it safe to retry?**
A: Not blindly. The timeout means the coordinator did not observe quorum, but the proposal may have been accepted and could still be committed by another coordinator finishing the round. The correct recovery is to read at `SERIAL` — which forces completion of any in-flight Paxos round — and then decide whether to re-issue the CAS based on the actual committed state.

**Q: (Senior) Why does LWT throughput degrade non-linearly with concurrency on one partition?**
A: Because Paxos rounds pre-empt each other. With N concurrent proposers, a proposer that discovers an uncommitted higher ballot must first drive that round to completion before retrying its own, so useful work per round trip falls as N rises, and each retry generates fresh contention. The result is a throughput curve that peaks at low concurrency and then declines — a classic livelock-adjacent pattern. The fix is architectural: shard the contended key or replace CAS with an append-and-resolve model.

**Q: How do you enforce a unique username in Cassandra?**
A: A dedicated table keyed by username, written with `INSERT ... IF NOT EXISTS` at `LOCAL_SERIAL` (or `SERIAL` for global uniqueness). Never `SELECT` then `INSERT` — two coordinators will both see "not found". Reads that must be authoritative use `SERIAL`.

**Q: What are `batch_size_warn_threshold` and `batch_size_fail_threshold`?**
A: `cassandra.yaml` guardrails, defaulting to 5 KiB and 50 KiB of serialised batch payload. Exceeding the warn threshold logs a WARN naming the table; exceeding the fail threshold rejects the batch outright. They exist because oversized batches are the most reliable way to destabilise a coordinator.

**Q: What happens to a batch if the coordinator crashes after writing the batchlog?**
A: The batchlog entry survives on two other replicas. The `BatchlogManager` on those nodes detects an entry older than roughly twice the write timeout and replays every mutation in it at the recorded consistency level. The batch therefore completes even though the original coordinator is gone — rolled forward, never back.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** `BEGIN BATCH` means atomicity-by-replay, not transactions: the coordinator persists the mutations to `system.batches` on two rack-distinct replicas, fans out, and a daemon replays anything left behind. There is no isolation and no rollback. Use logged batches only to keep 2–5 denormalized tables in sync, keep them under 5 KiB, and never use them for bulk load. Unlogged batches are only correct when every statement shares a partition key, where they become one atomic isolated mutation. LWTs (`IF NOT EXISTS`, `IF col = v`) run Paxos over a single partition, giving true linearizability at ~4 round trips; they require `SERIAL`/`LOCAL_SERIAL` on reads too, must never be retried blindly, and must never share a table with blind writes.

| Item | Value / Command |
|---|---|
| Default batch type | `LOGGED` (batchlog on 2 rack-distinct replicas) |
| Batch guardrails | `batch_size_warn_threshold: 5KiB`, `batch_size_fail_threshold: 50KiB` |
| Multi-partition unlogged warn | `unlogged_batch_across_partitions_warn_threshold: 10` |
| LWT syntax | `IF NOT EXISTS` · `IF EXISTS` · `IF col = v [AND ...]` |
| Serial CL | `LOCAL_SERIAL` (per-DC) · `SERIAL` (all DCs) |
| Serial quorum | `floor(RF/2) + 1` over the relevant replica set |
| LWT cost | ~4 round trips; `CASWrite` p99 typically 5–10× `Write` p99 |
| CAS timeout knob | `cas_contention_timeout: 1800ms` |
| Result inspection | `rs.wasApplied()` (Java) · `row.applied` (Python) |
| Batch conditions | allowed only within a single partition |
| Idempotence | batches: yes if all statements are · LWT: **never** |
| Contention metric | `ClientRequest,scope=CASWrite,name=ContentionHistogram` |

**Flash cards**
- **Does a logged batch isolate readers?** → No. Readers observe partial state until every mutation lands.
- **When is an unlogged batch safe?** → Only when all statements share the same partition key.
- **How many round trips does an LWT take?** → Four: prepare/promise, read, propose/accept, commit.
- **Which CL must reads of LWT data use?** → `SERIAL` or `LOCAL_SERIAL`, otherwise linearizability is lost.
- **Can you retry an LWT after a CAS write timeout?** → Not blindly — read at `SERIAL` first to force the round to resolve.

## 11. Hands-On Exercises & Mini Project

- [ ] On a 3-node cluster, run `INSERT ... IF NOT EXISTS` from two cqlsh sessions simultaneously against the same key and capture both `[applied]` results plus the returned current row.
- [ ] Compare latencies: time 10,000 plain inserts versus 10,000 `IF NOT EXISTS` inserts to distinct keys, then to the *same* 10 keys. Plot p50/p99 and explain the contention curve.
- [ ] Build a 200-statement logged batch across 200 partitions and observe the `Batch of prepared statements ... exceeding specified threshold` WARN in `system.log`; then measure coordinator CPU with `nodetool tpstats` during the run.
- [ ] Kill a coordinator mid-batch (`nodetool stopdaemon` timed against a slow batch) and prove via `SELECT * FROM system.batches` on the other nodes that the entry exists and is later replayed.
- [ ] Demonstrate the mixing hazard: run an `UPDATE ... IF status='A'` concurrently with a blind `UPDATE ... SET status='C'` and show a state the CAS should have made impossible.

**Mini Project — a plate-registry service with correct coordination**

*Goal:* implement driver registration where plate uniqueness is guaranteed, denormalized views never diverge, and the LWT rate stays under 5% of total writes.

*Requirements:*
- Three tables: `drivers_by_id`, `drivers_by_plate`, `drivers_by_org`, all `NetworkTopologyStrategy` RF 3.
- `claim_plate()` using `IF NOT EXISTS` at `LOCAL_SERIAL` + `LOCAL_QUORUM`, with explicit handling of `[applied]=false` (return the current owner) and of `WriteTimeoutException(CAS)` (read at `SERIAL`, then decide).
- `register_driver()` performing the claim first, then a **logged batch** of the two view inserts; on batch failure, do *not* retry — assert eventual convergence via the batchlog and log for reconciliation.
- A status transition API using `IF status = ?` that rejects illegal transitions.
- A load generator producing 95% plain location-ping writes and 5% registrations; report `CASWrite` vs `Write` p99 from `nodetool proxyhistograms`.

*Extensions:* add a compensating "release plate" path with `DELETE ... IF EXISTS`; shard the hottest CAS key by suffixing a bucket and measure the contention-histogram improvement; replace the logged batch with an async fan-out via a queue and compare coordinator CPU.

## 12. Related Topics & Free Learning Resources

Pair this with **13 · CQL: SELECT, INSERT, UPDATE & DELETE** for the read-free upsert model these features work around, **15 · TTL, Counters & Static Columns** for the other non-idempotent write type, and **18 · The Ring, Tokens & Consistent Hashing** for why single-partition scope is the boundary of every guarantee here. Consistency-level and repair chapters explain the quorum arithmetic Paxos builds on.

- **Lightweight Transactions in Cassandra** — Apache Cassandra Documentation · *Advanced* · the normative description of conditional statements, serial consistency, and their limits. <https://cassandra.apache.org/doc/latest/cassandra/developing/cql/dml.html#lightweight-transactions>
- **CASSANDRA-5062: Support CAS** — Apache JIRA · *Advanced* · the original design discussion for Paxos LWT, including the four-phase rationale and rejected alternatives. <https://issues.apache.org/jira/browse/CASSANDRA-5062>
- **Lightweight Transactions in Cassandra 2.0** — DataStax Engineering (Jonathan Ellis) · *Advanced* · the canonical explanation of why CAS costs four round trips. <https://www.datastax.com/blog/lightweight-transactions-cassandra-20>
- **Cassandra Batches: Good, Bad and Ugly** — The Last Pickle · *Intermediate* · practitioner-grade breakdown of batchlog cost and when batches help or hurt. <https://thelastpickle.com/blog/2019/02/26/data-modeling-guide.html>
- **Paxos Made Simple** — Leslie Lamport · *Advanced* · the eleven-page source for the consensus protocol Cassandra implements; read it once and the phases stop being magic. <https://lamport.azurewebsites.net/pubs/paxos-simple.pdf>
- **CEP-15: General Purpose Transactions (Accord)** — Apache Cassandra Enhancement Proposal · *Advanced* · the leaderless multi-partition transaction protocol intended to succeed Paxos LWT. <https://cwiki.apache.org/confluence/display/CASSANDRA/CEP-15%3A+General+Purpose+Transactions>
- **DataStax Java Driver: Batches and Conditional Updates** — DataStax · *Intermediate* · practical API-level guidance on `BatchStatement`, `wasApplied()`, and idempotence flags. <https://docs.datastax.com/en/developer/java-driver/latest/manual/core/statements/batch/>
- **Cassandra Summit talks on LWT performance** — Apache Cassandra / YouTube · *Intermediate* · conference sessions measuring CAS contention behaviour on real clusters. <https://www.youtube.com/@PlanetCassandra>

---

*Apache Cassandra Handbook — chapter 14.*
