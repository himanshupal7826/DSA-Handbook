# 03 · CAP Theorem & Tunable Consistency

> **In one line:** Cassandra is AP by default because it never refuses a write for lack of a leader — but consistency is a *per-query* dial, and whenever `R + W > RF` holds you have bought CP-like behaviour for that operation at the cost of availability.

---

## 1. Overview

The CAP theorem, proved by Gilbert and Lynch in 2002 from Eric Brewer's 2000 conjecture, says that when a network **partition (P)** splits your replicas, you must choose between **consistency (C)** — every read sees the latest write — and **availability (A)** — every request to a live node gets a non-error response. It is a statement about behaviour *during a partition*, not a permanent three-way personality test, and the popular "pick two" framing has done more damage than good.

Cassandra is conventionally labelled **AP**. That label is earned in a specific, narrow sense: there is no leader whose loss stops writes, so as long as the coordinator can reach enough replicas to satisfy the requested consistency level, the write succeeds — and with `CL=ONE` and hinted handoff, that bar is very low. A minority partition of the ring will happily keep accepting `CL=ONE` writes, and the two sides will reconcile later by timestamp. That is exactly the behaviour a shopping cart, a metrics pipeline, or a chat backlog wants.

But the label is incomplete, and this is where interviews separate people. Cassandra's consistency is **tunable per request**. The client sets a consistency level on every statement, and the coordinator enforces it. Ask for `QUORUM` reads and `QUORUM` writes on `RF=3` and the replica sets provably overlap, so you read your writes — and the minority side of a partition now *fails* requests rather than serving stale data. You have chosen C over A, for that query, at runtime. Ask for `ALL` and you have chosen maximum consistency and minimum availability. The database does not have one CAP position; your query does.

The problem this solves is that real systems are not uniform. In a single product you might have: session heartbeats where a lost write is irrelevant (`CL=ONE`, `RF=3`), account balances where a stale read is a support ticket (`LOCAL_QUORUM` both ways, or LWT for compare-and-set), and audit logs where you must never lose an acknowledged write even if a whole DC burns (`EACH_QUORUM` writes). A single global consistency setting would force the strictest requirement's latency onto every query.

A concrete example: **Netflix** runs Cassandra across AWS regions with `RF=3` per region and reads/writes at `LOCAL_QUORUM`. A user in `us-east-1` gets 2-of-3 local acks — single-digit millisecond latency, no cross-Atlantic round trip — and the write replicates asynchronously to `eu-west-1`. If `us-east-1` is severed from `eu-west-1`, both regions keep serving their local users at full speed (AP across regions, CP-ish within a region). The cost is honest and understood: a viewing event written in `us-east-1` may not be visible in `eu-west-1` for a few hundred milliseconds, and a hard region failover can lose the in-flight tail. For viewing history that is the right trade; for a payment ledger it would not be.

## 2. Core Concepts

- **CAP theorem** — during a network partition, a distributed system must sacrifice either consistency or availability. It says nothing about behaviour when the network is healthy.
- **PACELC** — the better model: *if Partition, choose Availability or Consistency; Else, choose Latency or Consistency.* Cassandra is **PA/EL** by default and **PC/EC** when you use quorums.
- **Consistency Level (CL)** — a per-statement setting for how many replicas must acknowledge before the coordinator responds. Not a keyspace property, not a connection property (though drivers set a default).
- **`QUORUM`** — `floor(RF/2) + 1` replicas across **all** datacenters combined. On a 2-DC RF=3+3 cluster that is 4 of 6, which requires cross-DC round trips.
- **`LOCAL_QUORUM`** — quorum of the replicas in the coordinator's datacenter only. The production default: strong within a DC, no WAN latency.
- **`EACH_QUORUM`** — a quorum in *every* datacenter (writes only). Use for data that must survive a whole-DC loss with no window.
- **`ONE` / `TWO` / `THREE` / `ALL` / `ANY`** — literal counts. `ANY` is write-only and counts a *hint* as success, so the data may exist on no replica at all — effectively "fire and forget".
- **`SERIAL` / `LOCAL_SERIAL`** — read consistency used with lightweight transactions; forces the read to see (and complete) any in-flight Paxos round.
- **Lightweight Transaction (LWT)** — `IF NOT EXISTS` / `IF col = ?`, implemented with Paxos over a single partition. Gives linearizable compare-and-set at roughly 4 round trips and 10–20× the latency of a normal write.
- **Read repair** — reconciliation triggered by a digest mismatch during a read; `blocking` for the replicas needed to satisfy CL, background for the rest.
- **Hinted handoff** — the coordinator stores a mutation destined for a down replica (default window `max_hint_window: 3h`) and replays it on recovery. It improves durability but is **not** a consistency guarantee.
- **Monotonic reads** — the guarantee that a client never sees time move backwards. Cassandra does *not* provide it across coordinators at `CL=ONE`.

## 3. Theory & Internals

### The quorum overlap proof

```
QUORUM(RF) = floor(RF / 2) + 1

RF = 1 → 1     RF = 2 → 2     RF = 3 → 2
RF = 4 → 3     RF = 5 → 3     RF = 6 → 4
```

Let `W` be the number of replicas that acknowledged the write and `R` the number consulted by the read. Both sets are drawn from the same `RF` replicas. By the pigeonhole principle, if `R + W > RF` then `|R ∩ W| ≥ 1` — at least one replica in the read set participated in the write and therefore holds the newest cell. Because Cassandra reconciles by comparing per-cell timestamps and returns the highest, that one replica is enough for the coordinator to return the current value.

```
RF=3, W=QUORUM(2), R=QUORUM(2)  → 2+2 = 4 > 3   ✅ read-your-writes
RF=3, W=ALL(3),    R=ONE(1)     → 3+1 = 4 > 3   ✅ (fast reads, fragile writes)
RF=3, W=ONE(1),    R=ALL(3)     → 1+3 = 4 > 3   ✅ (fast writes, fragile reads)
RF=3, W=ONE(1),    R=QUORUM(2)  → 1+2 = 3 = 3   ❌ eventual only
RF=3, W=ONE(1),    R=ONE(1)     → 1+1 = 2 < 3   ❌ eventual only
```

Note `W=ALL, R=ONE` satisfies the inequality but means a single down replica blocks all writes — availability zero for that partition. `QUORUM/QUORUM` is the only symmetric point that also tolerates `floor((RF-1)/2)` failures.

### What quorum does *not* give you

`R + W > RF` gives **read-your-writes for a completed write**. It does **not** give linearizability, because Cassandra's write path has no consensus: two clients writing to the same cell at the same microsecond timestamp both "succeed", and the byte-larger value wins. Nor does it prevent a *partially applied* write from being read — if a `QUORUM` write times out after reaching one replica, the operation is neither committed nor rolled back, and a later `QUORUM` read may or may not see it, and read repair may then make it permanent. This is the classic "Cassandra failed my write but the data is there" surprise, and it is why **all writes must be idempotent**.

For genuine compare-and-set you need **LWT**, which runs Paxos over the partition: prepare/promise → read → propose/accept → commit. Four round trips among the replicas, `SERIAL` (or `LOCAL_SERIAL`) consistency for the ballot, and a separate `system.paxos` table. Budget 10–20× a normal write.

### Availability arithmetic under CL

With `RF=3` in one DC:

| CL | Replicas needed | Nodes that may fail | Behaviour in a 2/1 partition |
|---|---|---|---|
| `ONE` | 1 | 2 | both sides serve (AP, divergent) |
| `QUORUM` / `LOCAL_QUORUM` | 2 | 1 | majority serves, minority errors (CP) |
| `ALL` | 3 | 0 | neither side serves |
| `ANY` (write) | 0 (hint counts) | 3 | always accepts, may be nowhere |

```svg
<svg viewBox="0 0 790 350" width="100%" height="350" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="c3a" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#4f46e5"/></marker>
  </defs>
  <text x="395" y="20" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">R + W &gt; RF: why quorum sets must overlap (RF=3)</text>
  <rect x="30" y="44" width="345" height="290" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="202" y="68" text-anchor="middle" fill="#1e293b" font-size="13" font-weight="bold">W=QUORUM(2), R=QUORUM(2)</text>
  <text x="202" y="86" text-anchor="middle" fill="#1e293b" font-size="11">2 + 2 = 4 &gt; 3 &#8594; guaranteed overlap</text>
  <circle cx="120" cy="150" r="34" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="120" y="148" text-anchor="middle" fill="#1e293b" font-size="11">R1</text>
  <text x="120" y="162" text-anchor="middle" fill="#1e293b" font-size="10">t=105</text>
  <circle cx="285" cy="150" r="34" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="285" y="148" text-anchor="middle" fill="#1e293b" font-size="11">R2</text>
  <text x="285" y="162" text-anchor="middle" fill="#1e293b" font-size="10">t=105</text>
  <circle cx="202" cy="240" r="34" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="202" y="238" text-anchor="middle" fill="#1e293b" font-size="11">R3</text>
  <text x="202" y="252" text-anchor="middle" fill="#1e293b" font-size="10">t=99 stale</text>
  <rect x="55" y="105" width="230" height="92" rx="46" fill="none" stroke="#16a34a" stroke-width="2" stroke-dasharray="6 3"/>
  <text x="170" y="100" fill="#16a34a" font-size="11">WRITE set {R1,R2}</text>
  <rect x="168" y="105" width="185" height="180" rx="60" fill="none" stroke="#4f46e5" stroke-width="2" stroke-dasharray="6 3"/>
  <text x="300" y="300" text-anchor="middle" fill="#4f46e5" font-size="11">READ set {R2,R3}</text>
  <text x="202" y="320" text-anchor="middle" fill="#1e293b" font-size="12">overlap = R2 &#8594; newest cell always seen</text>
  <rect x="405" y="44" width="355" height="290" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="582" y="68" text-anchor="middle" fill="#1e293b" font-size="13" font-weight="bold">W=ONE(1), R=ONE(1)</text>
  <text x="582" y="86" text-anchor="middle" fill="#1e293b" font-size="11">1 + 1 = 2 &lt; 3 &#8594; overlap not guaranteed</text>
  <circle cx="490" cy="150" r="34" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="490" y="148" text-anchor="middle" fill="#1e293b" font-size="11">R1</text>
  <text x="490" y="162" text-anchor="middle" fill="#1e293b" font-size="10">t=105</text>
  <circle cx="672" cy="150" r="34" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="672" y="148" text-anchor="middle" fill="#1e293b" font-size="11">R2</text>
  <text x="672" y="162" text-anchor="middle" fill="#1e293b" font-size="10">t=99</text>
  <circle cx="582" cy="240" r="34" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="582" y="238" text-anchor="middle" fill="#1e293b" font-size="11">R3</text>
  <text x="582" y="252" text-anchor="middle" fill="#1e293b" font-size="10">t=99</text>
  <rect x="452" y="112" width="78" height="78" rx="39" fill="none" stroke="#16a34a" stroke-width="2" stroke-dasharray="6 3"/>
  <text x="452" y="106" fill="#16a34a" font-size="11">W {R1}</text>
  <rect x="543" y="202" width="78" height="78" rx="39" fill="none" stroke="#4f46e5" stroke-width="2" stroke-dasharray="6 3"/>
  <text x="600" y="298" fill="#4f46e5" font-size="11">R {R3}</text>
  <text x="582" y="320" text-anchor="middle" fill="#1e293b" font-size="12">disjoint &#8594; read returns stale t=99</text>
</svg>
```

## 4. Architecture & Workflow

How the coordinator actually enforces a consistency level, step by step, for a `LOCAL_QUORUM` read on `RF=3`:

1. **Client sends the statement with a CL.** The driver attaches the CL byte to the native-protocol frame; there is no server-side override.
2. **Coordinator resolves replicas.** Partitioner → token → replication strategy → 3 endpoints; the failure detector removes dead ones; the dynamic snitch orders survivors by recent latency.
3. **Availability pre-check.** If fewer live replicas exist than the CL requires, the coordinator immediately throws `UnavailableException` **without contacting anyone**. This is the "fail fast" path and is distinguishable in metrics from a timeout.
4. **Data + digest fan-out.** The closest replica is asked for the full data; the others are asked for a **digest** (an MD5 of the requested columns). This keeps network cost near-constant regardless of CL.
5. **Speculative retry.** If the chosen data replica has not answered by the `speculative_retry` threshold (default `99p` of recent latency), the coordinator fires a redundant request to another replica. This is what keeps p99 flat when one node GC-pauses.
6. **Wait for CL responses.** For `LOCAL_QUORUM` on RF=3 that is 2. If they do not arrive within `read_request_timeout` (default 5000 ms), the coordinator throws `ReadTimeoutException` carrying `received` vs `required` counts.
7. **Compare digests.** If all digests match, return the data. If they differ, the coordinator issues a **blocking read repair**: fetch full data from the mismatching replicas, merge by cell timestamp, write the reconciled result back, and only then answer the client. Blocking repair covers exactly the replicas needed for CL; the remainder are repaired in the background.
8. **Writes are symmetric but simpler.** The coordinator always sends the mutation to *all* replicas and counts acks up to the CL; unreachable replicas get hints. `CL=ANY` is satisfied by writing a hint alone.
9. **LWT takes a different path entirely.** `IF` clauses route through Paxos: `PREPARE` to a `SERIAL` quorum, read the current value, `PROPOSE`, `COMMIT`. Any concurrent LWT on the same partition contends and may fail with `CasWriteTimeoutException` — which, like a normal timeout, means *unknown*, not *failed*.

```svg
<svg viewBox="0 0 790 370" width="100%" height="370" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="c3b" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#0ea5e9"/></marker>
    <marker id="c3c" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#d97706"/></marker>
  </defs>
  <text x="395" y="20" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">LOCAL_QUORUM read with digest mismatch &#8594; blocking read repair</text>
  <rect x="20" y="52" width="100" height="46" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="70" y="80" text-anchor="middle" fill="#1e293b">Client</text>
  <rect x="160" y="52" width="130" height="46" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="225" y="72" text-anchor="middle" fill="#1e293b">Coordinator</text>
  <text x="225" y="89" text-anchor="middle" fill="#1e293b" font-size="10">CL=LOCAL_QUORUM</text>
  <rect x="600" y="46" width="165" height="52" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="682" y="66" text-anchor="middle" fill="#1e293b">Replica A (closest)</text>
  <text x="682" y="84" text-anchor="middle" fill="#1e293b" font-size="10">full data, ts=1721 640 000</text>
  <rect x="600" y="122" width="165" height="52" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="682" y="142" text-anchor="middle" fill="#1e293b">Replica B</text>
  <text x="682" y="160" text-anchor="middle" fill="#1e293b" font-size="10">digest, ts=1721 639 000 stale</text>
  <rect x="600" y="198" width="165" height="52" rx="8" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="682" y="218" text-anchor="middle" fill="#1e293b">Replica C</text>
  <text x="682" y="236" text-anchor="middle" fill="#1e293b" font-size="10">not contacted (CL met by A+B)</text>
  <line x1="122" y1="75" x2="156" y2="75" stroke="#0ea5e9" stroke-width="2" marker-end="url(#c3b)"/>
  <line x1="292" y1="68" x2="596" y2="68" stroke="#0ea5e9" stroke-width="2" marker-end="url(#c3b)"/>
  <text x="444" y="62" text-anchor="middle" fill="#1e293b" font-size="10">1. data request</text>
  <line x1="292" y1="80" x2="596" y2="140" stroke="#0ea5e9" stroke-width="2" marker-end="url(#c3b)"/>
  <text x="430" y="112" text-anchor="middle" fill="#1e293b" font-size="10">2. digest request (MD5 only)</text>
  <line x1="596" y1="156" x2="292" y2="96" stroke="#d97706" stroke-width="2" marker-end="url(#c3c)"/>
  <text x="430" y="140" text-anchor="middle" fill="#d97706" font-size="10">3. digest mismatch detected</text>
  <rect x="140" y="196" width="330" height="70" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="155" y="218" fill="#1e293b" font-weight="bold">4. Blocking read repair</text>
  <text x="155" y="236" fill="#1e293b" font-size="11">fetch full rows from B, merge by cell timestamp</text>
  <text x="155" y="253" fill="#1e293b" font-size="11">write newest back to B, then answer the client</text>
  <line x1="472" y1="222" x2="596" y2="160" stroke="#d97706" stroke-width="2" marker-end="url(#c3c)"/>
  <rect x="20" y="290" width="745" height="62" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="35" y="312" fill="#1e293b" font-weight="bold">Failure branches</text>
  <text x="35" y="331" fill="#1e293b" font-size="11">fewer live replicas than CL &#8594; UnavailableException immediately (no network calls)</text>
  <text x="35" y="347" fill="#1e293b" font-size="11">CL replicas alive but slow &#8594; speculative retry, then ReadTimeoutException after read_request_timeout 5000 ms</text>
</svg>
```

## 5. Implementation

```cql
-- Two-datacenter production keyspace
CREATE KEYSPACE ledger WITH replication = {
  'class': 'NetworkTopologyStrategy', 'dc_east': 3, 'dc_west': 3
};
USE ledger;

CREATE TABLE accounts (
    account_id uuid PRIMARY KEY,
    balance_cents bigint,
    version int,
    updated_at timestamp
);

-- Per-statement consistency in cqlsh
CONSISTENCY LOCAL_QUORUM;
INSERT INTO accounts (account_id, balance_cents, version, updated_at)
VALUES (11111111-1111-1111-1111-111111111111, 250000, 1, toTimestamp(now()));

CONSISTENCY ONE;
SELECT balance_cents, version FROM accounts
WHERE account_id = 11111111-1111-1111-1111-111111111111;
-- may return a stale version: W(2)+R(1)=3 which is NOT > RF(3) per-DC

CONSISTENCY LOCAL_QUORUM;
SELECT balance_cents, version FROM accounts
WHERE account_id = 11111111-1111-1111-1111-111111111111;
-- 2+2 = 4 > 3 → guaranteed to see the write

-- Lightweight transaction: linearizable compare-and-set on one partition
UPDATE accounts SET balance_cents = 249000, version = 2
WHERE account_id = 11111111-1111-1111-1111-111111111111
IF version = 1;
--  [applied]
-- -----------
--       True

-- A losing contender sees the current value returned with applied=false
UPDATE accounts SET balance_cents = 240000, version = 2
WHERE account_id = 11111111-1111-1111-1111-111111111111
IF version = 1;
--  [applied] | version
-- -----------+---------
--      False |       2
```

```python
from cassandra.cluster import Cluster, ExecutionProfile, EXEC_PROFILE_DEFAULT
from cassandra.policies import DCAwareRoundRobinPolicy, TokenAwarePolicy
from cassandra import ConsistencyLevel, Unavailable, WriteTimeout, ReadTimeout

# Two profiles: one strong, one cheap. Choose per call site.
strong = ExecutionProfile(
    load_balancing_policy=TokenAwarePolicy(DCAwareRoundRobinPolicy("dc_east")),
    consistency_level=ConsistencyLevel.LOCAL_QUORUM,
    serial_consistency_level=ConsistencyLevel.LOCAL_SERIAL)
cheap = ExecutionProfile(
    load_balancing_policy=TokenAwarePolicy(DCAwareRoundRobinPolicy("dc_east")),
    consistency_level=ConsistencyLevel.ONE)

cluster = Cluster(["10.0.1.11"], execution_profiles={
    EXEC_PROFILE_DEFAULT: strong, "cheap": cheap})
session = cluster.connect("ledger")

debit = session.prepare(
  "UPDATE accounts SET balance_cents=?, version=? WHERE account_id=? IF version=?")

try:
    row = session.execute(debit, (249000, 2, acct, 1)).one()
    if not row.applied:
        print("lost the race; current version is", row.version)
except Unavailable as e:
    # Fewer live replicas than CL required — fail fast, safe to retry elsewhere
    print(f"unavailable: needed {e.required_replicas}, alive {e.alive_replicas}")
except (WriteTimeout, ReadTimeout) as e:
    # UNKNOWN outcome. The write may or may not have applied.
    # Only safe to retry because this statement is idempotent (IF version=1).
    print(f"timeout: received {e.received_responses}/{e.required_responses}")

# Heartbeats do not need quorum — use the cheap profile explicitly
session.execute("UPDATE sessions SET last_seen=toTimestamp(now()) WHERE sid=%s",
                (sid,), execution_profile="cheap")
```

```yaml
# cassandra.yaml — timeouts and repair behaviour that shape consistency
read_request_timeout: 5000ms
write_request_timeout: 2000ms
cas_contention_timeout: 1800ms
counter_write_request_timeout: 5000ms
max_hint_window: 3h
hinted_handoff_enabled: true
```

```bash
# Per-table read-repair behaviour (4.0+: read_repair = BLOCKING | NONE)
cqlsh -e "ALTER TABLE ledger.accounts WITH read_repair = 'BLOCKING';"

# Prove read repair happened: watch the metric before and after a stale read
nodetool tablestats ledger.accounts | grep -i "read repair"

# See the whole decision in one query
cqlsh -e "CONSISTENCY LOCAL_QUORUM; TRACING ON; SELECT * FROM ledger.accounts LIMIT 1;"
# ... Determining replicas | 10.0.1.11 | 121
# ... Sending READ message to /10.0.1.12 | 10.0.1.11 | 402
# ... Digest mismatch: org.apache.cassandra.service.DigestMismatchException | 1802
# ... Initiating read-repair | 10.0.1.11 | 1911
```

> **Optimization:** the biggest consistency-related latency win in multi-DC clusters is replacing `QUORUM` with `LOCAL_QUORUM` everywhere except the handful of statements that genuinely need cross-DC durability. On a 2-DC RF=3+3 cluster, `QUORUM` needs 4 of 6 acks, which *always* includes at least one remote replica — so every write pays the WAN RTT (60–150 ms). `LOCAL_QUORUM` needs 2 of the 3 local replicas and typically completes in 1–3 ms, while the remote DC still gets the data asynchronously. Reserve `EACH_QUORUM` for the writes you cannot afford to lose in a region failure.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Tunable CL | One cluster serves both "must be correct" and "must be fast" workloads | Consistency becomes an application concern; a wrong CL is a silent correctness bug |
| AP default (`CL=ONE`) | Writes survive almost any failure; latency near the disk | Stale reads, no read-your-writes, divergence until repair |
| `LOCAL_QUORUM` | Strong within a DC at LAN latency; survives one node loss | Not strong across DCs; a region failover can expose unreplicated writes |
| `QUORUM` (multi-DC) | Strong across the whole cluster | Every request pays WAN RTT; a DC outage can break the global quorum |
| `EACH_QUORUM` | Survives full-DC loss with no consistency window (writes) | Highest latency; unavailable if any DC is down |
| LWT / Paxos | True linearizable compare-and-set on a partition | ~4 round trips, 10–20× latency, contention failures, `system.paxos` bloat |
| Read repair | Self-healing; consistency improves with read traffic | Adds latency to the read that discovers the mismatch; cold data never heals |
| Hinted handoff | Smooths short outages, keeps writes flowing | Not a guarantee — hints expire after 3 h and are lost if the coordinator dies |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Believing "Cassandra is AP, therefore it cannot be consistent."** → ✅ CAP describes partition behaviour. With `R + W > RF` Cassandra gives read-your-writes; the price is that the minority side of a partition returns `UnavailableException` instead of stale data.
2. ⚠️ **Writing at `QUORUM` and reading at `ONE` and expecting freshness.** → ✅ On RF=3 that is `2 + 1 = 3`, not `> 3`. Do the arithmetic for every read/write pair; only `>` counts.
3. ⚠️ **Using `QUORUM` in a multi-DC cluster.** → ✅ `QUORUM` spans all DCs (4 of 6 at RF=3+3), so it always crosses the WAN and breaks when a DC is down. Use `LOCAL_QUORUM`, and `EACH_QUORUM` only for critical writes.
4. ⚠️ **Treating a `WriteTimeoutException` as a failure.** → ✅ A timeout means **unknown**: the mutation may have applied on some replicas and will be spread by read repair. Make every write idempotent so blind retries are safe, and never "compensate" a timeout by writing the inverse.
5. ⚠️ **Using `CL=ANY` for anything you care about.** → ✅ `ANY` is satisfied by writing a hint on the coordinator alone. If that coordinator dies before replaying, the data never existed. It is fire-and-forget, not a consistency level.
6. ⚠️ **Using LWT for high-throughput paths.** → ✅ Paxos is ~4 round trips, contends badly under concurrency, and is confined to a single partition. Use it for uniqueness checks and state machines, not for counters or hot rows.
7. ⚠️ **Mixing LWT and non-LWT writes to the same row.** → ✅ A plain `UPDATE` bypasses Paxos entirely and can clobber a linearizable value. If a column is guarded by LWT, *every* write to it must be an LWT.
8. ⚠️ **Setting a global driver CL of `ALL` "to be safe".** → ✅ `ALL` means zero fault tolerance — one slow node breaks every query. It is almost never the right answer; `QUORUM` plus repair is.
9. ⚠️ **Relying on hinted handoff instead of repair.** → ✅ Hints expire (`max_hint_window: 3h`) and are dropped under pressure. Anti-entropy repair within `gc_grace_seconds` (864000) is the only real guarantee.
10. ⚠️ **Forgetting `RF=1` keyspaces (especially `system_auth`).** → ✅ At RF=1, `QUORUM` = 1 replica and any node loss makes that data unavailable — including logins. Set `system_auth` RF to match your data keyspaces and repair it.
11. ⚠️ **Assuming monotonic reads.** → ✅ At `CL=ONE` consecutive reads can hit different replicas and move backwards in time. If a user must never see their own write disappear, use `LOCAL_QUORUM` for that read path.
12. ⚠️ **Ignoring clock skew while relying on timestamps.** → ✅ Last-write-wins is decided by microsecond timestamps; a node minutes ahead makes its writes permanently unbeatable. Run chrony/NTP everywhere and alert on drift > 50 ms.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Distinguish the three failure shapes precisely. `UnavailableException` = the coordinator knew up front there weren't enough live replicas → a topology/gossip problem; check `nodetool status` and the failure detector. `ReadTimeoutException`/`WriteTimeoutException` = enough replicas were alive but too slow → a load, GC, compaction, or wide-partition problem. `ReadFailureException` = a replica actively errored, most often `TombstoneOverwhelmingException`. Use `TRACING ON` in cqlsh to see the exact replicas contacted, the digest comparison, and whether a read repair fired. `nodetool proxyhistograms` gives coordinator-level read/write/range latency percentiles across the cluster.

**Monitoring.** The core beans: `org.apache.cassandra.metrics:type=ClientRequest,scope=Read|Write,name=Latency` (p99/p999), `...,name=Unavailables` (CL could not be met), `...,name=Timeouts`, `...,name=Failures`, and the CAS-specific `scope=CASRead|CASWrite,name=Latency|ConditionNotMet|ContentionHistogram`. Track `type=ReadRepair,name=RepairedBlocking|RepairedBackground` — a rising blocking-repair rate means replicas are diverging faster than repair fixes them. Track `type=HintsService,name=HintsSucceeded|HintsFailed|HintsTimedOut` and `type=Storage,name=TotalHints`; a growing hint backlog is an early warning of a partial outage. Alert on any non-zero `Unavailables` and on `Dropped mutations` from `nodetool tpstats`.

**Security.** Consistency and security intersect at `system_auth`: leave it at the default RF=1 and a single node failure locks everyone out, while a stale auth replica can serve an old password hash. Set `system_auth` to `NetworkTopologyStrategy` with RF=3 per DC, repair it, and consider raising `roles_validity`, `permissions_validity`, and `credentials_validity` (default 2000 ms caches) to reduce auth read load — accepting a longer window before a revoked permission takes effect. Audit logging (4.0+) can record the CL of every statement, which is useful when proving that a compliance-critical write path really used `EACH_QUORUM`.

**Performance & scaling.** `speculative_retry` (per table, default `99p`) is the main lever for tail latency: it sends a redundant request when a replica is slower than the 99th percentile, so one GC-pausing node stops driving your p99. `ALWAYS` doubles read load; `NONE` maximises throughput at the cost of tails. When adding a datacenter, remember that `QUORUM` semantics change the moment RF changes — add the DC with RF=0 first, `nodetool rebuild`, then raise RF, or you will briefly fail quorums. Under sustained overload, prefer shedding load in the client (bounded in-flight requests, backpressure) over raising `read_request_timeout`, which just converts fast failures into slow ones.

## 9. Interview Questions

**Q: State the CAP theorem and say where Cassandra sits.**
A: During a network partition a distributed system can guarantee either consistency or availability, not both. Cassandra is AP by default because it has no leader and will accept writes at low consistency levels on either side of a partition. But consistency is tunable per query, so `QUORUM` reads and writes make an individual operation behave CP.

**Q: What is `R + W > RF` and why does it work?**
A: If the number of replicas that acknowledged the write plus the number consulted by the read exceeds the replication factor, the two sets must share at least one replica. That shared replica holds the newest cell, and Cassandra reconciles by highest per-cell timestamp, so the read returns the current value. With RF=3, QUORUM+QUORUM gives 2+2 > 3.

**Q: What is the difference between `QUORUM` and `LOCAL_QUORUM`?**
A: `QUORUM` is `floor(RF_total/2)+1` counting replicas in every datacenter, so on RF=3+3 it needs 4 of 6 and always crosses the WAN. `LOCAL_QUORUM` needs a quorum only within the coordinator's datacenter — 2 of 3 — giving strong consistency locally at LAN latency. `LOCAL_QUORUM` is the production default; `QUORUM` breaks when a DC is unreachable.

**Q: What does `CL=ANY` mean, and when should you use it?**
A: `ANY` is a write-only level satisfied if the coordinator manages to store a hint, even when no replica accepted the data. It maximises write availability but provides no durability guarantee — if the coordinator dies before hint replay, the write is gone. In practice, don't use it.

**Q: A write times out. Did it succeed?**
A: Unknown. A `WriteTimeoutException` means the coordinator didn't receive enough acks in time, but the mutation may have been applied on one or more replicas and will spread via read repair or anti-entropy. The correct response is to make writes idempotent and retry; never issue a compensating write.

**Q: What is read repair and when does it run?**
A: On a read, the coordinator asks one replica for data and others for digests; if a digest mismatches, it fetches the full rows, merges by timestamp, and pushes the newest version back to stale replicas. In 4.0+ repair is `BLOCKING` for the replicas needed to satisfy the CL — the client waits — and background for the rest. It only heals data that is actually read, which is why scheduled anti-entropy repair is still mandatory.

**Q: What is a lightweight transaction and what does it cost?**
A: An `IF`-guarded statement implemented with Paxos over a single partition, giving linearizable compare-and-set. It costs roughly four round trips (prepare/promise, read, propose/accept, commit) plus `SERIAL` reads, typically 10–20× a normal write, and it contends: concurrent LWTs on the same partition can fail with `CasWriteTimeoutException`. It never spans partitions.

**Q: (Senior) Explain PACELC and why it describes Cassandra better than CAP.**
A: PACELC says: if there is a Partition, choose Availability or Consistency; Else (normal operation), choose Latency or Consistency. Cassandra is PA/EL at `CL=ONE` and PC/EC at quorum levels — and the *else* branch is the one that dominates day-to-day, because partitions are rare while the latency-versus-consistency trade is made on every single request. CAP only describes the rare branch.

**Q: (Senior) Does `QUORUM` give you linearizability?**
A: No. Quorum overlap guarantees that a *completed* write is visible to a subsequent read, but Cassandra's write path has no consensus, ordering, or rollback. Two concurrent writers can both succeed with the loser silently discarded by last-write-wins, and a timed-out write is in an indeterminate state that read repair may later make permanent. Linearizable operations require LWT/Paxos with `SERIAL` consistency.

**Q: (Senior) You have a 2-DC cluster, RF=3 per DC, and dc_west is severed. What still works at each CL?**
A: `LOCAL_QUORUM` and `LOCAL_ONE` work fully in both DCs independently — each keeps serving its own users, and the two diverge. `QUORUM` needs 4 of 6, so dc_east (3 replicas) fails and dc_west fails too; the whole cluster loses those queries. `EACH_QUORUM` writes fail everywhere. `ALL` fails everywhere. When the link heals, hints (if within 3 h) and repair reconcile the divergence by timestamp, with concurrent edits resolved last-write-wins.

**Q: (Senior) How would you design a "reserve a unique username" flow?**
A: Use `INSERT INTO users_by_name (username, user_id) VALUES (?, ?) IF NOT EXISTS` with `SERIAL`/`LOCAL_SERIAL` — Paxos on the `username` partition gives true uniqueness. Every other write touching that row must also be an LWT, or a plain update can clobber it. Then denormalize into the main `users` table with a normal `LOCAL_QUORUM` write, accepting that the two tables are briefly inconsistent and reconciling asynchronously if the second write fails.

**Q: How do hinted handoff and repair differ?**
A: Hinted handoff is opportunistic and short-lived: the coordinator stores mutations for a replica it knows is down and replays them for up to `max_hint_window` (3 h), and hints are lost if the coordinator itself fails. Anti-entropy repair is authoritative: replicas build Merkle trees over token ranges, compare them, and stream the differences, guaranteeing convergence. Hints reduce how much repair has to do; they never replace it.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** CAP applies only during partitions; PACELC (`PA/EL` by default, `PC/EC` at quorum) is the better model. Cassandra has no leader, so writes never block on election — that's the AP default. Consistency is set **per statement**: `ONE`, `LOCAL_ONE`, `QUORUM = floor(RF/2)+1`, `LOCAL_QUORUM` (quorum within the local DC), `EACH_QUORUM` (write-only, quorum in every DC), `ALL`, `ANY` (write-only, a hint counts). Strong read-your-writes when `R + W > RF`; on RF=3 that's `LOCAL_QUORUM` + `LOCAL_QUORUM` = 2+2 > 3. Quorum is **not** linearizability — for compare-and-set use LWT (`IF ...`) with `SERIAL`/`LOCAL_SERIAL`, at ~4 round trips and 10–20× latency. Timeouts mean *unknown*, so all writes must be idempotent. Convergence comes from hinted handoff (≤ 3 h), read repair (only on data you read), and anti-entropy repair (mandatory, within `gc_grace_seconds` = 864000).

| Consistency level | Replicas required (RF=3, 1 DC) | Typical use |
|---|---|---|
| `ANY` (write only) | 0 — a hint suffices | never, in practice |
| `ONE` / `LOCAL_ONE` | 1 | metrics, heartbeats, caches |
| `TWO` | 2 | rare, explicit tuning |
| `QUORUM` | 2 (4 of 6 across 2 DCs) | single-DC strong reads |
| `LOCAL_QUORUM` | 2 in local DC | **production default** |
| `EACH_QUORUM` (write) | 2 in every DC | cross-region critical writes |
| `ALL` | 3 | verification, migrations only |
| `SERIAL` / `LOCAL_SERIAL` | Paxos quorum | LWT reads |

**Flash cards**
- **Strong-consistency inequality** → `R + W > RF`; RF=3 ⇒ `LOCAL_QUORUM` + `LOCAL_QUORUM` (2+2 > 3).
- **QUORUM formula** → `floor(RF/2) + 1`; RF=3 → 2, RF=5 → 3, RF=6 → 4.
- **`QUORUM` vs `LOCAL_QUORUM`** → `QUORUM` counts replicas in all DCs (crosses the WAN); `LOCAL_QUORUM` only the coordinator's DC.
- **What does a write timeout mean?** → Unknown outcome — it may have applied. Make writes idempotent and retry.
- **When is CAP's "C" actually chosen?** → Whenever the CL forces a quorum: the minority side of a partition returns `UnavailableException` rather than stale data.

## 11. Hands-On Exercises & Mini Project

- [ ] On a 3-node RF=3 cluster, write at `ONE`, immediately stop the replica that received it, then read at `ONE` repeatedly and record how often you get the stale value. Repeat with `QUORUM` and show it never happens.
- [ ] Stop two of three nodes and demonstrate the exact exceptions: `LOCAL_ONE` succeeds, `LOCAL_QUORUM` throws `UnavailableException` with `required=2, alive=1`, and `ALL` throws too.
- [ ] Enable `TRACING ON`, force a digest mismatch (write at `ONE` to one node while another is down, restart it, then read at `QUORUM`), and capture the `DigestMismatchException` plus read-repair lines from the trace.
- [ ] Benchmark the same `UPDATE` as a plain write versus an LWT (`IF version = ?`) with `cassandra-stress` or a loop of 10,000 operations; record the p50/p99 ratio.
- [ ] Build a 2-DC cluster with Docker and measure `LOCAL_QUORUM` versus `QUORUM` versus `EACH_QUORUM` write latency with an artificial 80 ms delay on the inter-DC link (`tc qdisc add dev eth0 root netem delay 80ms`).

### Mini Project — "Consistency Lab"

**Goal.** Build a harness that empirically demonstrates each CAP/consistency trade-off on a real cluster, so you can answer any interview question from data rather than memory.

**Requirements.**
1. Docker-compose a 6-node, 2-DC cluster (3 per DC), keyspace `lab` with `NetworkTopologyStrategy {dc1:3, dc2:3}`.
2. A writer that writes an incrementing counter row every 10 ms at a configurable CL, and a reader that reads the same row at a configurable CL and logs every time the value goes *backwards* (a monotonicity violation).
3. A chaos script that partitions the cluster (`iptables -A INPUT -s <ip> -j DROP` between DCs, or between one node and the rest) and heals it after N seconds.
4. Produce a table of: CL pair, writes accepted during partition, stale reads observed, monotonicity violations, and time to convergence after healing. Verify that every row with `R + W > RF` shows zero stale reads.

**Extensions.**
- Add an LWT variant of the writer and measure contention failure rate as concurrency rises from 1 to 32 clients.
- Skew one node's clock by 10 s and show that its writes win permanently even when logically older.
- Instrument `ReadRepair.RepairedBlocking` and plot how divergence decays after the partition heals, with and without `nodetool repair`.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *What Is Apache Cassandra?* (why masterless implies AP), *History & Architecture Overview* (Dynamo's quorum heritage and why vector clocks were dropped), *Installation & Cluster Setup* (setting up the multi-DC topology these levels assume), *Keyspaces, Tables & CQL Basics* (where replication factor is actually declared), *Primary Key: Partition & Clustering Columns* (the partition is the unit that LWT and repair operate on).

- **Brewer's CAP Theorem: Twelve Years Later** — Eric Brewer, IEEE Computer 2012 · *Intermediate* · the author himself explaining that "pick two" was always a simplification and that the real choice is per-operation. <https://www.infoq.com/articles/cap-twelve-years-later-how-the-rules-have-changed/>
- **Consistency Tradeoffs in Modern Distributed Database Design (PACELC)** — Daniel Abadi · *Intermediate* · the paper that introduces the *else latency-or-consistency* branch CAP omits. <https://www.cs.umd.edu/~abadi/papers/abadi-pacelc.pdf>
- **Apache Cassandra Docs — Dynamo & Guarantees** — Apache Software Foundation · *Intermediate* · the normative description of consistency levels, read repair, and what Cassandra does and does not guarantee. <https://cassandra.apache.org/doc/latest/cassandra/architecture/dynamo.html>
- **Lightweight Transactions in Cassandra** — DataStax Docs · *Advanced* · the Paxos round-trip breakdown, `SERIAL` semantics, and the rules for mixing LWT with normal writes. <https://docs.datastax.com/en/cql-oss/3.3/cql/cql_using/useInsertLWT.html>
- **Jepsen: Cassandra** — Kyle Kingsbury (aphyr) · *Advanced* · rigorous, adversarial testing showing exactly where quorum reads and LWT do and do not hold; essential for calibrating your intuition. <https://jepsen.io/analyses>
- **Read Repair in Cassandra 4.0** — The Last Pickle · *Advanced* · what changed with blocking read repair and per-table `read_repair` settings, with real metrics. <https://thelastpickle.com/blog/>
- **Netflix: Cassandra Benchmarks on AWS** — Netflix Technology Blog · *Intermediate* · the classic linear-scaling benchmark plus the reasoning behind `LOCAL_QUORUM` in a multi-region deployment. <https://netflixtechblog.com/benchmarking-cassandra-scalability-on-aws-over-a-million-writes-per-second-39f45f066c9e>
- **Cassandra Summit talks on consistency and repair** — Planet Cassandra / Apache Cassandra · *Intermediate* · conference talks walking through real incidents caused by CL misconfiguration. <https://www.youtube.com/@PlanetCassandra>

---

*Apache Cassandra Handbook — chapter 03.*
