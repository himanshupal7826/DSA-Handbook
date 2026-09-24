# 14 · CAP Theorem: What Happens When the Network Breaks

> **In one line:** CAP is not a menu where you pick two letters; it is a statement about one specific moment — when replicas cannot talk to each other, every request must either wait/fail (stay consistent) or answer from local state (stay available) — and real databases make that choice per operation, per range and per configuration setting.

---

## 1. Overview

The popular version of CAP — "consistency, availability, partition tolerance: pick two" — has done more harm than good. It suggests you choose a database by circling two letters, that "CA" systems exist, and that a "CP" database is somehow down all the time. None of that is true, and senior interviewers use the question precisely to see whether you know it.

Here is the useful framing. You replicated your data so that it survives a machine failure and so reads can be served close to users. Now consider the moment when **the replicas cannot communicate** — a switch fails, a cross-region link drops, a firewall rule is pushed wrongly, a node pauses for 20 seconds in garbage collection. A client sends a write to a node that cannot reach the others. That node has exactly two options:

1. **Refuse or wait** until it can coordinate with enough peers. The data stays **consistent** (no one will ever see two conflicting histories), but this request is **not available**.
2. **Accept it locally** and reconcile later. The request is **available**, but a client on the other side of the break can now read a value that does not include this write — the system is not **consistent** in the linearizable sense — and if both sides accept writes to the same key, they will have to be merged.

There is no third option. That is the entire theorem, and it is proven (Gilbert & Lynch, 2002, formalising Brewer's 2000 conjecture). What makes it practical is everything around it: how often partitions happen, what they look like, how each database behaves when one occurs, which operations need which side, and what you pay in latency *even when the network is healthy* (PACELC).

The naive approach — "we'll use a CP database, so we're consistent" or "we'll use Cassandra, it's AP" — fails because the choice is not made by the product; it is made by **configuration and per-request settings**. PostgreSQL with asynchronous replicas behaves AP for replica reads. Cassandra at `QUORUM` behaves CP-like for that operation. MongoDB with `w:1` can acknowledge writes that later get rolled back. You need to know what your system does when the network breaks, operation by operation.

> **Builds on:** [Ch 09 · Replication](topic.html?p=09-replication) (synchronous vs asynchronous replicas, lag) · [Ch 10 · Consistency Models](topic.html?p=10-consistency-models) (linearizability and weaker models) · [SQL Handbook · Isolation Levels](../sql/topic.html?p=26-isolation-levels) (isolation is a *different* axis from CAP consistency) · [System Design · CAP & Consistency Models](../system-design/topic.html?p=19-cap-consistency) (the spectrum, quorum math, why "CA" doesn't exist) · [Cassandra · CAP & Tunable Consistency](../cassandra/topic.html?p=03-cap-tunable-consistency) (per-query consistency levels). This chapter goes into precise definitions, what partitions look like in practice, and how specific databases behave during one.

## 2. Core Concepts

- **Consistency (CAP's C) = linearizability** — every operation appears to take effect atomically at one instant between its call and its return; once a write returns, every later read (by anyone) sees it or something newer. *Why it matters:* it is much stronger than "replicas eventually agree" and unrelated to ACID's C.
- **Availability (CAP's A)** — every request received by a *non-failed* node eventually gets a *non-error* response. *Why it matters:* it's a property of each node, not an uptime SLA; a CP system can have 99.999% uptime and still not be "available" in CAP's sense.
- **Partition (CAP's P)** — the network may lose arbitrarily many messages between nodes. *Why it matters:* you can't opt out of it; any system that communicates over a network is subject to it.
- **Network partition in practice** — any situation where some nodes can't get timely answers from others: link failure, asymmetric reachability, a paused process, an overloaded NIC. *Why it matters:* from inside a node, "slow" and "partitioned" look the same.
- **CP behaviour** — during a partition, the side without a quorum refuses (or blocks) operations that need coordination. *Why it matters:* the majority side keeps working; only the minority loses availability.
- **AP behaviour** — during a partition, every reachable replica keeps answering from local state. *Why it matters:* you must have a plan for divergence — last-writer-wins, CRDTs, application merges.
- **Quorum** — a majority (or overlapping read/write sets) that must acknowledge an operation. *Why it matters:* it is the mechanism CP systems use to guarantee that at most one side can make progress.
- **PACELC** — if Partition, choose Availability or Consistency; Else, choose Latency or Consistency. *Why it matters:* partitions are rare, but the latency cost of consistency is paid on every request.
- **Per-operation choice** — many systems let you pick consistency per request (Cassandra CL, DynamoDB `ConsistentRead`, MongoDB read/write concern, etcd serializable vs linearizable reads). *Why it matters:* "is X CP or AP?" usually has the answer "depends on the call".

## 3. Theory & Principles

### The proof in one paragraph

Take two replicas, G1 and G2, holding `x = 0`, and partition them so no messages pass. A client writes `x = 1` to G1. If the system is available, G1 must acknowledge. Another client then reads `x` from G2. If the system is available, G2 must answer — and since no message from G1 can have arrived, it can only answer `0`. The write completed before the read began, so a linearizable system must return `1`. Contradiction. Therefore, during a partition, you cannot have both linearizability and availability. Everything else in the "CAP debate" is about definitions, probabilities and engineering around this fact.

### What CAP does not say

| Misconception | Reality |
|---|---|
| "Pick any two of C, A, P" | P is not optional. The choice is C *or* A, and only *during* a partition. |
| "Single-node PostgreSQL is CA" | A single node isn't a distributed system; CAP says nothing about it. Once you add a replica, you are CP or AP per operation. |
| "CP systems are unavailable" | Only the *minority* side of a partition loses availability; the majority side serves normally. |
| "AP systems are inconsistent" | They are not *linearizable* during a partition; they may still offer eventual, causal or session guarantees, and are often strongly consistent when healthy. |
| "CAP's C is ACID's C" | ACID's C means "invariants hold". CAP's C means linearizability — a recency guarantee across replicas. |
| "CAP consistency = SERIALIZABLE" | Serializability is about transactions interleaving (isolation); linearizability is about single-object recency. You can have either without the other; *strict serializability* is both. |
| "CAP is about latency" | The original theorem has no notion of time; a very slow response still counts as available. PACELC adds latency. |
| "A system is CP or AP" | Systems have many operations and configurations; each may make a different choice. |

### Partitions in practice

Partitions are not only cut cables. Real incidents that behave as partitions:

- **A switch or top-of-rack failure** isolating one rack or one availability zone.
- **Asymmetric partitions**: A can reach B, B cannot reach A (a one-way firewall rule, a broken route). Leader elections behave strangely: a node may keep sending heartbeats that are received while never receiving replies.
- **Process pauses**: a 30-second stop-the-world GC, a VM live-migration, a swapped-out process. The node is "partitioned" for 30 s and then comes back *believing it is still the leader*.
- **Overload**: a saturated NIC or a CPU-starved node drops or delays heartbeats; timeouts fire exactly as if the network were down.
- **Cross-region link degradation**: packet loss of a few percent on a WAN link turns into timeouts at the application.

Bailis & Kingsbury's survey "The Network is Reliable" catalogues many such incidents at large companies. The takeaway: design as if partitions are routine, because from a node's point of view "the other side is slow" and "the other side is gone" are indistinguishable until a timeout decides.

```svg
<svg viewBox="0 0 880 500" width="100%" height="500" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c14a1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
    <marker id="c14a2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Same partition (5 replicas split 3 | 2), two behaviours</text>
  <rect x="20" y="40" width="410" height="300" rx="10" fill="#f8fafc" stroke="#2563eb" stroke-width="2"/>
  <text x="225" y="62" text-anchor="middle" fill="#1e40af" font-size="13" font-weight="bold">CP: majority quorum (etcd, Raft/Paxos stores)</text>
  <rect x="36" y="80" width="200" height="130" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="136" y="98" text-anchor="middle" fill="#15803d" font-weight="bold">Majority side (3 of 5)</text>
  <circle cx="76" cy="126" r="16" fill="#ffffff" stroke="#16a34a" stroke-width="2"/><text x="76" y="130" text-anchor="middle" fill="#14532d" font-size="10">N1</text>
  <circle cx="136" cy="126" r="16" fill="#ffffff" stroke="#16a34a" stroke-width="2"/><text x="136" y="130" text-anchor="middle" fill="#14532d" font-size="10">N2</text>
  <circle cx="196" cy="126" r="16" fill="#ffffff" stroke="#16a34a" stroke-width="2"/><text x="196" y="130" text-anchor="middle" fill="#14532d" font-size="10">N3</text>
  <text x="46" y="164" fill="#166534" font-size="10">elects / keeps a leader</text>
  <text x="46" y="180" fill="#166534" font-size="10">writes commit (3 acks)</text>
  <text x="46" y="196" fill="#166534" font-size="10">linearizable reads OK</text>
  <line x1="246" y1="80" x2="246" y2="210" stroke="#dc2626" stroke-width="3" stroke-dasharray="6 4"/>
  <rect x="256" y="80" width="160" height="130" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="336" y="98" text-anchor="middle" fill="#b91c1c" font-weight="bold">Minority (2 of 5)</text>
  <circle cx="306" cy="126" r="16" fill="#ffffff" stroke="#dc2626" stroke-width="2"/><text x="306" y="130" text-anchor="middle" fill="#7f1d1d" font-size="10">N4</text>
  <circle cx="366" cy="126" r="16" fill="#ffffff" stroke="#dc2626" stroke-width="2"/><text x="366" y="130" text-anchor="middle" fill="#7f1d1d" font-size="10">N5</text>
  <text x="266" y="164" fill="#7f1d1d" font-size="10">cannot reach 3 votes</text>
  <text x="266" y="180" fill="#7f1d1d" font-size="10">writes time out / error</text>
  <text x="266" y="196" fill="#7f1d1d" font-size="10">stale reads only if asked</text>
  <text x="36" y="236" fill="#1e293b" font-size="11" font-weight="bold">Client outcomes</text>
  <text x="36" y="256" fill="#15803d" font-size="10">client near N1-N3: normal service</text>
  <text x="36" y="274" fill="#b91c1c" font-size="10">client near N4-N5: errors until healed or rerouted</text>
  <text x="36" y="296" fill="#1e40af" font-size="10" font-weight="bold">Never two histories. No merge needed on heal.</text>
  <text x="36" y="316" fill="#1e40af" font-size="10">Minority nodes just catch up from the leader's log.</text>
  <rect x="450" y="40" width="410" height="300" rx="10" fill="#f8fafc" stroke="#d97706" stroke-width="2"/>
  <text x="655" y="62" text-anchor="middle" fill="#92400e" font-size="13" font-weight="bold">AP: any replica answers (Cassandra CL=ONE)</text>
  <rect x="466" y="80" width="200" height="130" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="566" y="98" text-anchor="middle" fill="#92400e" font-weight="bold">Side A (3 replicas)</text>
  <circle cx="506" cy="126" r="16" fill="#ffffff" stroke="#d97706" stroke-width="2"/><text x="506" y="130" text-anchor="middle" fill="#78350f" font-size="10">N1</text>
  <circle cx="566" cy="126" r="16" fill="#ffffff" stroke="#d97706" stroke-width="2"/><text x="566" y="130" text-anchor="middle" fill="#78350f" font-size="10">N2</text>
  <circle cx="626" cy="126" r="16" fill="#ffffff" stroke="#d97706" stroke-width="2"/><text x="626" y="130" text-anchor="middle" fill="#78350f" font-size="10">N3</text>
  <text x="476" y="164" fill="#78350f" font-size="10">accepts x = "blue"</text>
  <text x="476" y="180" fill="#78350f" font-size="10">at t = 10:00:01.200</text>
  <text x="476" y="196" fill="#78350f" font-size="10">hints stored for N4, N5</text>
  <line x1="676" y1="80" x2="676" y2="210" stroke="#dc2626" stroke-width="3" stroke-dasharray="6 4"/>
  <rect x="686" y="80" width="160" height="130" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="766" y="98" text-anchor="middle" fill="#92400e" font-weight="bold">Side B (2)</text>
  <circle cx="736" cy="126" r="16" fill="#ffffff" stroke="#d97706" stroke-width="2"/><text x="736" y="130" text-anchor="middle" fill="#78350f" font-size="10">N4</text>
  <circle cx="796" cy="126" r="16" fill="#ffffff" stroke="#d97706" stroke-width="2"/><text x="796" y="130" text-anchor="middle" fill="#78350f" font-size="10">N5</text>
  <text x="696" y="164" fill="#78350f" font-size="10">accepts x = "red"</text>
  <text x="696" y="180" fill="#78350f" font-size="10">at t = 10:00:01.450</text>
  <text x="696" y="196" fill="#78350f" font-size="10">reads return "red"</text>
  <text x="466" y="236" fill="#1e293b" font-size="11" font-weight="bold">Client outcomes</text>
  <text x="466" y="256" fill="#15803d" font-size="10">everyone gets answers on both sides</text>
  <text x="466" y="274" fill="#b91c1c" font-size="10">readers disagree; "blue" write was acknowledged</text>
  <text x="466" y="296" fill="#92400e" font-size="10" font-weight="bold">On heal: last-write-wins by timestamp keeps "red",</text>
  <text x="466" y="316" fill="#92400e" font-size="10">"blue" silently lost, unless CRDT / app merge.</text>
  <rect x="20" y="356" width="840" height="130" rx="10" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="440" y="378" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">The choice is per operation, not per product</text>
  <text x="40" y="402" fill="#4c1d95" font-size="11">Cassandra at QUORUM (RF=5 needs 3): side A serves, side B errors with UnavailableException  (CP-like for that call)</text>
  <text x="40" y="424" fill="#4c1d95" font-size="11">etcd with a serializable read (--consistency=s): the minority answers from local, possibly stale state  (AP-like read)</text>
  <text x="40" y="446" fill="#4c1d95" font-size="11">Cassandra LWT (IF NOT EXISTS) uses Paxos: needs a quorum of replicas even at CL=ONE for normal reads</text>
  <text x="40" y="468" fill="#4c1d95" font-size="11">PostgreSQL: reads from an async replica are available but stale; commits with a sync standby block if it is unreachable</text>
</svg>
```

### PACELC: the trade-off you pay every day

Partitions are rare — minutes per year for a well-run cluster. Latency is paid on every request. Abadi's PACELC makes this explicit: **if** there is a Partition, trade Availability vs Consistency; **else**, trade Latency vs Consistency. A linearizable write must be acknowledged by a quorum, so its latency is the round trip to the *second-closest* replica (for 3 replicas) — about a millisecond or two across availability zones in one region, and on the order of 60–150 ms if the quorum spans continents. A read that must be linearizable either goes to the leader or confirms leadership with a quorum round. Systems that choose low latency (read any replica, acknowledge after one replica) are EL; systems that always coordinate are EC.

| System (typical configuration) | During partition (PAC) | Normal operation (ELC) |
|---|---|---|
| Cassandra, CL=ONE | PA | EL |
| Cassandra, CL=QUORUM reads + writes | PC (per operation) | EC |
| DynamoDB, default eventually consistent reads | PA for reads | EL |
| DynamoDB global tables (multi-active, LWW) | PA across regions | EL |
| etcd / ZooKeeper / Consul (writes) | PC | EC |
| Spanner, CockroachDB | PC | EC (with clever latency optimisations) |
| MongoDB, `w:"majority"` + `readConcern:"majority"` from primary | PC | EC |
| PostgreSQL primary + async replicas, reads on replicas | PA for replica reads | EL |
| PostgreSQL with synchronous standby | PC for commits | EC |

## 4. Architecture & Workflow

### How specific databases behave during a partition

**etcd / ZooKeeper / Consul (CP coordination stores).** These run Raft or ZAB with a majority quorum ([Ch 15 · Consensus](topic.html?p=15-consensus)). The side with a majority keeps (or elects) a leader and serves normally. On the minority side, writes cannot commit and time out. etcd reads are linearizable by default, so they fail on the minority too; a client that explicitly asks for a serializable read (`--consistency=s`) gets a local, possibly stale answer. ZooKeeper serves reads from the connected server, which may lag (a client calls `sync()` first to catch up); servers that lose contact with the quorum stop serving clients unless read-only mode is enabled. This is why Kubernetes, Patroni and Kafka's KRaft trust these systems for leadership: the minority can never believe it is in charge.

**Spanner and CockroachDB (CP distributed SQL).** Data is split into ranges (CockroachDB) or splits (Spanner), each replicated by its own consensus group. A partition affects each range independently: a range whose majority and leaseholder are on your side keeps working; a range whose majority is on the other side becomes unavailable to you. Spanner is technically CP, but Google's argument (Brewer, 2017) is that with a private, heavily redundant network, partitions are rare enough that it is "effectively CA" — i.e. the availability you actually observe exceeds five nines. The lesson is that CP plus a very good network is a practical design point.

**MongoDB replica sets.** A primary that can no longer see a majority steps down; the majority side elects a new primary once heartbeats time out (`electionTimeoutMillis`, 10 s by default). Writes with `w:"majority"` (the default write concern since MongoDB 5.0) are safe. Writes acknowledged with `w:1` by the old primary during the partition window, but never replicated to the majority, are **rolled back** when it rejoins — written to rollback files rather than silently dropped, but gone from the data. The client was told "success". That is the concrete cost of choosing availability (`w:1`) in a system you think of as CP.

**Cassandra (tunable, Dynamo-style).** There is no leader; every replica accepts writes. With consistency level ONE, both sides of a partition accept writes and answer reads; coordinators store **hints** for unreachable replicas, and read repair and anti-entropy repair converge data after healing with last-write-wins by timestamp. With QUORUM, a side that can't reach a majority of replicas for a key returns `UnavailableException` — CP-like for that operation. Lightweight transactions (`IF NOT EXISTS`, `IF col = x`) use Paxos and need a quorum. See [Cassandra · CAP & Tunable Consistency](../cassandra/topic.html?p=03-cap-tunable-consistency).

**DynamoDB.** Within a region, each partition's replicas across three availability zones use a leader-based protocol. Strongly consistent reads (`ConsistentRead=true`) go to the leader; the default eventually consistent reads may hit any replica. Global tables replicate asynchronously between regions and resolve concurrent writes with last-writer-wins: across regions it is AP. AWS has added a multi-Region strong-consistency mode for global tables, which — as CAP predicts — pays for it in write latency and in availability when a region is isolated.

**PostgreSQL.** Not a distributed database, but a primary with replicas is a replicated system, so CAP applies. Reads from an **asynchronous replica** are always available and possibly stale (AP for reads). Commits with a **synchronous standby** (`synchronous_standby_names`, `synchronous_commit = on`) block when the standby is unreachable (CP for commits). Failover through Patroni is CP: only the node holding the leader key in etcd may be primary, and a primary that can't renew the key demotes itself ([Ch 18 · High Availability](topic.html?p=18-high-availability)).

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c14b1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Timeline: MongoDB primary isolated in the minority, client using w:1</text>
  <line x1="40" y1="60" x2="860" y2="60" stroke="#334155" stroke-width="2" marker-end="url(#c14b1)"/>
  <text x="40" y="50" fill="#334155" font-size="10">t = 0</text>
  <text x="250" y="50" fill="#334155" font-size="10">t = 0 to 10 s</text>
  <text x="500" y="50" fill="#334155" font-size="10">t = about 12 s</text>
  <text x="720" y="50" fill="#334155" font-size="10">t = heal</text>
  <rect x="30" y="76" width="180" height="120" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="120" y="96" text-anchor="middle" fill="#b91c1c" font-weight="bold">Partition</text>
  <text x="40" y="116" fill="#7f1d1d" font-size="10">P (old primary) alone in AZ-a</text>
  <text x="40" y="132" fill="#7f1d1d" font-size="10">S1, S2 together in AZ-b</text>
  <text x="40" y="148" fill="#7f1d1d" font-size="10">app servers in AZ-a still</text>
  <text x="40" y="164" fill="#7f1d1d" font-size="10">reach P</text>
  <rect x="230" y="76" width="200" height="120" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="330" y="96" text-anchor="middle" fill="#92400e" font-weight="bold">Split window</text>
  <text x="240" y="116" fill="#78350f" font-size="10">P still thinks it is primary</text>
  <text x="240" y="132" fill="#78350f" font-size="10">until it notices lost majority</text>
  <text x="240" y="148" fill="#78350f" font-size="10">w:1 writes: ACKED by P</text>
  <text x="240" y="164" fill="#78350f" font-size="10">w:majority writes: wait, then</text>
  <text x="240" y="180" fill="#78350f" font-size="10">time out (never acked)</text>
  <rect x="450" y="76" width="200" height="120" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="550" y="96" text-anchor="middle" fill="#1e40af" font-weight="bold">New primary</text>
  <text x="460" y="116" fill="#1e3a8a" font-size="10">P steps down (no majority)</text>
  <text x="460" y="132" fill="#1e3a8a" font-size="10">S1 wins election in AZ-b,</text>
  <text x="460" y="148" fill="#1e3a8a" font-size="10">higher term</text>
  <text x="460" y="164" fill="#1e3a8a" font-size="10">drivers rediscover, retry</text>
  <text x="460" y="180" fill="#1e3a8a" font-size="10">writes go to S1</text>
  <rect x="670" y="76" width="190" height="120" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="765" y="96" text-anchor="middle" fill="#5b21b6" font-weight="bold">Rejoin + rollback</text>
  <text x="680" y="116" fill="#4c1d95" font-size="10">P rejoins as secondary</text>
  <text x="680" y="132" fill="#4c1d95" font-size="10">its w:1 writes diverge from</text>
  <text x="680" y="148" fill="#4c1d95" font-size="10">S1's history</text>
  <text x="680" y="164" fill="#4c1d95" font-size="10">rolled back to rollback files</text>
  <text x="680" y="180" fill="#4c1d95" font-size="10">client was told "success"</text>
  <rect x="30" y="216" width="830" height="110" rx="10" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="50" y="238" fill="#1e293b" font-size="12" font-weight="bold">Same incident, PostgreSQL + Patroni (etcd DCS, ttl=30 s, async replication)</text>
  <text x="50" y="260" fill="#334155" font-size="11">Old primary cannot renew its leader key in etcd, so Patroni demotes it (read-only) before the key expires.</text>
  <text x="50" y="280" fill="#334155" font-size="11">After the key expires, a replica on the majority side is promoted. Commits that reached only the old primary are lost</text>
  <text x="50" y="300" fill="#334155" font-size="11">(async), bounded by replication lag; maximum_lag_on_failover limits how stale a promoted replica may be.</text>
  <text x="50" y="318" fill="#334155" font-size="11">With synchronous replication, those commits would have blocked instead: no acknowledged write lost.</text>
  <rect x="30" y="342" width="410" height="116" rx="10" fill="#fee2e2" stroke="#dc2626"/>
  <text x="235" y="364" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Choosing A (w:1, async)</text>
  <text x="50" y="386" fill="#7f1d1d" font-size="11">writes keep succeeding for a few seconds</text>
  <text x="50" y="406" fill="#7f1d1d" font-size="11">some acknowledged writes disappear</text>
  <text x="50" y="426" fill="#7f1d1d" font-size="11">acceptable for: likes, views, telemetry</text>
  <text x="50" y="446" fill="#7f1d1d" font-size="11">unacceptable for: payments, inventory</text>
  <rect x="450" y="342" width="410" height="116" rx="10" fill="#dcfce7" stroke="#16a34a"/>
  <text x="655" y="364" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Choosing C (w:majority, sync)</text>
  <text x="470" y="386" fill="#14532d" font-size="11">writes in the split window time out</text>
  <text x="470" y="406" fill="#14532d" font-size="11">client retries with an idempotency key</text>
  <text x="470" y="426" fill="#14532d" font-size="11">no acknowledged write is ever lost</text>
  <text x="470" y="446" fill="#14532d" font-size="11">cost: extra latency every write (PACELC)</text>
</svg>
```

### A workflow for deciding per operation

For each operation in your system, ask:

1. **What goes wrong if two sides accept it concurrently?** For "increment view count", nothing that a merge can't fix (a counter CRDT). For "reserve the last seat", a double booking.
2. **What goes wrong if it is refused for a minute?** For "post a like", a mild annoyance. For "ingest telemetry", data loss unless buffered.
3. **Can the conflict be merged automatically?** Sets, counters, and append-only logs merge well (CRDTs). Balances with invariants do not.

Operations that can't tolerate divergence get quorum writes, leader reads, and idempotent retries so a refused request can be retried safely. Operations that can tolerate it get local writes, a merge strategy, and a reconciliation job. A single product usually has both, which is why the same database is often configured differently for different tables or calls.

## 5. Implementation

### Simple example: watching a CP store refuse on the minority

A three-node etcd cluster in Docker; isolate one node and observe both sides.

```bash
# docker-compose with etcd1..etcd3 on network "etcdnet" (image: quay.io/coreos/etcd:v3.5.x)
docker network disconnect etcdnet etcd3            # etcd3 is now a minority of one

# On the majority side: writes and linearizable reads succeed
docker exec etcd1 etcdctl put /config/flag on
docker exec etcd1 etcdctl get /config/flag

# On the minority: a write cannot reach a quorum
docker exec etcd3 etcdctl --command-timeout=3s put /config/flag off
# Error: context deadline exceeded

# Linearizable read (default) also fails on the minority...
docker exec etcd3 etcdctl --command-timeout=3s get /config/flag
# Error: context deadline exceeded

# ...but a serializable read answers from local state, possibly stale (the A choice, opt-in)
docker exec etcd3 etcdctl get /config/flag --consistency=s

docker network connect etcdnet etcd3               # heal: etcd3 catches up from the leader's log
```

### PostgreSQL: the same choice, made by configuration

```ini
# primary postgresql.conf — synchronous commit to one of two standbys
synchronous_standby_names = 'ANY 1 (standby_a, standby_b)'
synchronous_commit = on        # commit waits until a standby has flushed the WAL
```

With both standbys partitioned away, a commit on the primary blocks:

```sql
INSERT INTO payments (id, amount) VALUES (1, 100);
-- hangs; pg_stat_activity shows wait_event = 'SyncRep'

-- If the client cancels (Ctrl-C), PostgreSQL says exactly what happened:
-- WARNING:  canceling wait for synchronous replication due to user request
-- DETAIL:  The transaction has already committed locally, but might not have been replicated to the standby.
```

That warning is CAP in two lines: the write is durable on the primary but not yet on a replica, so the system can't promise it survives a failover — and it won't pretend otherwise. Diagnostic views:

```sql
-- On the primary: who is sync, how far behind
SELECT application_name, state, sync_state, write_lag, flush_lag, replay_lag
FROM pg_stat_replication;

-- On a replica: how stale is what I serve?
SELECT now() - pg_last_xact_replay_timestamp() AS replica_staleness;
```

> **MySQL difference:** MySQL's **semi-synchronous replication** makes the primary wait for at least one replica to acknowledge receipt of the transaction's events before returning to the client — but after `rpl_semi_sync_source_timeout` (10 s by default) with no acknowledgement, it silently falls back to asynchronous replication. That is an automatic switch from C to A during a partition; set the timeout very high if you want CP behaviour. **Group Replication** (InnoDB Cluster) uses a Paxos-based protocol with majority agreement: a member in a minority partition cannot commit writes.

### Real-world example: a client that picks its side explicitly

A product service reads catalogue data (tolerates staleness) and reserves inventory (must not diverge). The code makes the CAP choice visible per call rather than leaving it to a driver default.

```python
import time
import psycopg

PRIMARY = "host=pg-primary dbname=shop"
REPLICA = "host=pg-replica dbname=shop"
MAX_STALENESS_S = 5.0

class Unavailable(Exception):
    pass

def read_product(product_id: int) -> dict:
    """AP choice: prefer the replica; accept staleness up to a bound, else fall back to primary."""
    try:
        with psycopg.connect(REPLICA, connect_timeout=1) as c:
            lag = c.execute(
                "SELECT COALESCE(EXTRACT(epoch FROM now() - pg_last_xact_replay_timestamp()), 0)"
            ).fetchone()[0]
            if lag <= MAX_STALENESS_S:
                row = c.execute("SELECT id, name, price FROM products WHERE id = %s",
                                (product_id,)).fetchone()
                return {"id": row[0], "name": row[1], "price": row[2], "stale_s": float(lag)}
    except psycopg.OperationalError:
        pass                                   # replica unreachable: try primary
    with psycopg.connect(PRIMARY, connect_timeout=1) as c:
        row = c.execute("SELECT id, name, price FROM products WHERE id = %s",
                        (product_id,)).fetchone()
        return {"id": row[0], "name": row[1], "price": row[2], "stale_s": 0.0}

def reserve(sku: str, qty: int, idempotency_key: str) -> bool:
    """CP choice: primary only, sync-replicated commit, bounded wait, safe to retry."""
    try:
        with psycopg.connect(PRIMARY, connect_timeout=1,
                             options="-c statement_timeout=3000") as c:
            with c.transaction():
                done = c.execute("INSERT INTO reservations_seen (key) VALUES (%s) "
                                 "ON CONFLICT DO NOTHING", (idempotency_key,)).rowcount
                if done == 0:
                    return True                # already applied by an earlier attempt
                n = c.execute("UPDATE stock SET available = available - %s "
                              "WHERE sku = %s AND available >= %s", (qty, sku, qty)).rowcount
                if n != 1:
                    raise ValueError("insufficient stock")
            return True
    except (psycopg.OperationalError, psycopg.errors.QueryCanceled) as e:
        # Outcome unknown (maybe committed locally, not replicated). Refuse, and let the
        # caller retry with the SAME idempotency key: the retry is safe either way.
        raise Unavailable(str(e)) from e
```

Note the subtlety at the end: a timed-out commit in a CP system has an **unknown outcome**. The only safe response is an error plus an idempotent retry — which is why CP systems and idempotency keys go together.

## 6. Advantages, Disadvantages & Trade-offs

| | CP choice (quorum / leader / sync) | AP choice (local / async / any replica) |
|---|---|---|
| During partition | Minority side errors or blocks | Every side answers |
| Acknowledged writes | Never lost or contradicted | May be overwritten (LWW) or rolled back |
| Reads | Linearizable (leader or quorum) | Possibly stale; bounded only by monitoring |
| Normal latency (PACELC) | Quorum round trip on writes (and often reads) | Single-replica latency |
| After heal | Minority catches up; nothing to merge | Merge: LWW, CRDTs, app reconciliation |
| App complexity | Retries with idempotency, unknown outcomes | Conflict handling, stale-read UX |
| Good for | Money, inventory, uniqueness, locks, leadership | Feeds, counters, telemetry, carts (with merge), caches |

### When to use (CP)
- Invariants that must hold at every instant: balances, stock, seat allocation, unique usernames, leases and leader election.
- Metadata that other systems act on (cluster membership, config): a stale answer causes wrong actions.

### When to use (AP)
- Data where a temporarily stale or merged answer beats an error: timelines, likes, presence, metrics, shopping carts with union merge.
- Multi-region writes where cross-region round trips on every write are unacceptable.

### When NOT to use
- Don't choose AP for data with invariants and then try to patch divergence with application code; you will lose writes you acknowledged.
- Don't choose CP across continents for high-frequency, low-value writes; you pay 100+ ms per write for guarantees nobody needs.
- Don't use "our database is CP" as an argument when your reads go to asynchronous replicas.

## 7. Common Mistakes & Best Practices

- **Saying "we chose CA".** It signals the network was assumed reliable. *Instead:* state what each operation does during a partition.
- **Labelling a product instead of an operation.** "Mongo is CP" hides `w:1` writes that get rolled back. *Instead:* audit write concerns, read preferences and consistency levels per call path.
- **Confusing isolation with CAP consistency.** SERIALIZABLE on the primary does not make replica reads linearizable. *Instead:* treat recency (where reads go) and isolation (how transactions interleave) as separate decisions ([Ch 10 · Consistency Models](topic.html?p=10-consistency-models)).
- **Ignoring the unknown-outcome case.** A CP write that times out may have committed. *Instead:* idempotency keys and retry-safe operations.
- **Treating MySQL semi-sync as CP.** It degrades to async after a timeout. *Instead:* know your fallback behaviour and alert on it.
- **LWW without thinking about clocks.** Last-writer-wins with skewed clocks drops the "newer" write. *Instead:* use CRDTs or version vectors where merges matter; keep NTP healthy.
- **Testing only clean node kills.** Real partitions are asymmetric, partial and slow. *Instead:* test with network faults (`tc netem`, iptables, Toxiproxy, Jepsen-style tools).
- **Best practice:** write a one-page "partition behaviour" table for your system — per operation: what happens on each side, what clients see, how it heals.

## 8. Production: Failure Scenarios, Monitoring & Scaling

**Failure scenario: acknowledged orders vanished.** After an AZ network blip, customer support finds 37 orders customers have confirmation emails for but which don't exist in the database. Root cause: the order service used MongoDB `w:1`; the primary was isolated in the minority for ~11 s, accepted writes, stepped down, and those writes were rolled back on rejoin (the rollback files contain them). Fix: `w:"majority"` for orders, idempotent retries in the service, and a recovery script replaying the rollback files after review.

**Failure scenario: checkout hangs instead of failing.** A standby's network flaps and every commit on the primary waits on `SyncRep`; request threads pile up and the service falls over. Root cause: one synchronous standby with no timeout on the application side. Fix: `synchronous_standby_names = 'ANY 1 (a, b)'` so any one of two standbys suffices, client-side `statement_timeout`, and a runbook for deliberately degrading to async (a conscious A choice, with an alert).

**Failure scenario: two leaders for a cron job.** A distributed lock in an AP store (Redis with async replication, or Cassandra at ONE) allowed two workers to both believe they held the lock during a partition; a billing job ran twice. Fix: leadership and locks belong in a CP store (etcd, ZooKeeper, a PostgreSQL advisory lock on the primary) and, more importantly, protected actions must check a fencing token ([Ch 15 · Consensus](topic.html?p=15-consensus)).

**Failure scenario: stale reads after failover.** Users see their just-updated profile revert. Root cause: reads go to async replicas behind a load balancer; after a failover one replica replays from a lagging position. Fix: read-your-writes by routing a user's reads to the primary for a short window after they write, or by waiting for the replica to reach the write's LSN.

**Metrics to watch**
- Replication lag (bytes and seconds) per replica: `pg_stat_replication`, `pg_last_xact_replay_timestamp()`.
- Commits waiting on `SyncRep` (`pg_stat_activity.wait_event`).
- Leader elections / term changes in etcd, MongoDB, Kafka KRaft; unavailable errors per consistency level in Cassandra.
- Hinted handoff backlog and repair status (Cassandra); rollback file creation (MongoDB).
- Cross-AZ and cross-region packet loss and RTT.

**Scaling notes.** CP costs rise with geographic spread: a quorum across three regions puts a WAN round trip on every write. Common patterns are to keep the consensus quorum inside one region (with async DR elsewhere), to place quorums across nearby regions, or to partition data so each item's quorum lives near its users ([Ch 17 · Multi-Region Databases](topic.html?p=17-multi-region-databases)).

## 9. Interview Questions

**Q: State the CAP theorem precisely.**
A: In an asynchronous network where messages between nodes can be lost, a replicated data store cannot guarantee both linearizability (every read sees the most recent completed write) and availability (every request to a non-failed node gets a non-error response) during a partition. Partition tolerance isn't a choice; any networked system experiences partitions. So the real statement is: when a partition happens, each operation must either give up availability, by waiting or failing, or give up linearizability, by answering from local state. When there is no partition, CAP places no restriction.

**Q: Why is "pick two" misleading?**
A: It implies you could drop P and have a CA system, but partitions happen whether you choose them or not; a "CA" system is just one whose behaviour during a partition hasn't been thought through. It also implies the choice is made once per product, when real systems choose per operation and per configuration: Cassandra at QUORUM behaves CP for that call, and PostgreSQL replica reads are AP. Finally it hides that CP systems remain available on the majority side, and that AP systems can be strongly consistent when the network is healthy.

**Q: What is the difference between CAP consistency and ACID consistency?**
A: ACID's C means a transaction takes the database from one valid state to another, respecting constraints and invariants; it's about correctness of a single database's state. CAP's C means linearizability: a recency guarantee that all clients see a single, up-to-date copy of each object across replicas. You can violate one without the other. A single PostgreSQL node trivially has CAP consistency but can violate ACID consistency if your constraints are missing, and a system can enforce all constraints yet serve stale replica reads.

**Q: What does a CP database do during a partition? Give a concrete example.**
A: The side with a quorum keeps working; the side without refuses operations that need coordination. In a five-node etcd cluster split 3/2, the three-node side keeps or elects a leader and commits writes with three acknowledgements. On the two-node side, writes and default linearizable reads time out, though a client can explicitly request a serializable, possibly stale read. When the partition heals, the minority nodes simply catch up from the leader's log; there are never two histories to merge.

**Q: What does an AP database do during a partition, and what happens when it heals?**
A: Every reachable replica keeps accepting reads and writes. In Cassandra at consistency level ONE, both sides accept writes to the same key; coordinators store hints for unreachable replicas. On heal, hints are replayed and read repair and anti-entropy repair converge replicas, using last-write-wins by cell timestamp. So one of two concurrent writes is silently discarded unless the data model avoids conflicts, for example with append-only rows, counters or CRDT-like structures. The price of availability is a merge policy you must be able to live with.

**Q: What does PACELC add, and why does it matter more day to day?**
A: PACELC says: if there is a Partition, choose Availability or Consistency; Else, choose Latency or Consistency. Partitions are rare, but a consistent write needs a quorum acknowledgement and a consistent read needs the leader or a quorum on every request, so consistency costs latency all the time. Within one region that's a millisecond or two; across continents it can be 100 ms or more per write. That's usually the deciding factor in multi-region design, not partition behaviour.

**Q: Is PostgreSQL CP or AP?**
A: A single node isn't distributed, so CAP doesn't apply. With replicas it depends on configuration and on where reads go. Reads from asynchronous replicas are available during a partition but can be stale, which is AP for reads. Commits with synchronous replication block if no synchronous standby is reachable, which is CP for commits. Failover through Patroni relies on etcd's CP guarantees, so only one node can hold the leader key, but with async replication, commits acknowledged by the old primary and not yet replicated can be lost at failover. So the honest answer is per operation.

**Q: How can a MongoDB client lose acknowledged writes?**
A: With `w:1`, the primary acknowledges once it has applied the write locally. If that primary is isolated in the minority, it keeps acknowledging for a short window until it notices it has lost the majority and steps down. Meanwhile the majority elects a new primary and moves on. When the old primary rejoins, writes that never reached the majority conflict with the new history and are rolled back into rollback files. `w:"majority"`, the default since 5.0, avoids this because a write isn't acknowledged until a majority has it.

**Q: You're designing a global social app with users on three continents. How do you apply CAP/PACELC? (Senior)**
A: I split by operation. Likes, views, feed fan-out and presence are high-volume and tolerate staleness, so they go AP and EL: local-region writes, async cross-region replication, counters and sets that merge, and read-your-writes via session stickiness. Account identity, usernames and payments need uniqueness and invariants, so they go CP: each user has a home region where their authoritative record lives and is written with a quorum inside that region, and a globally unique username is claimed through a single CP service, accepting cross-region latency on that rare operation. During a region partition, AP features keep working everywhere, and CP features work only for users whose home region is reachable, with clear errors and idempotent retries elsewhere.

**Q: A CP write timed out. Did it commit? How should the client behave? (Senior)**
A: The outcome is unknown. In PostgreSQL with synchronous replication, a cancelled wait means the transaction committed locally but may not be replicated. In Raft stores, the entry may have reached a majority just before the timeout. The client must not assume failure and must not blindly re-execute a non-idempotent operation. The correct design is an idempotency key recorded in the same transaction as the effect, so a retry either applies the operation once or discovers it already applied. For operations that can't be made idempotent, the client queries the outcome by key before retrying.

**Q: Why do Kubernetes, Patroni and Kafka KRaft use CP stores for leadership, even though they care about availability? (Senior)**
A: Because leadership is exactly the kind of state where two answers are catastrophic: two primaries accepting writes, two schedulers acting on the same pod, two controllers making conflicting decisions. A CP store guarantees that at most one side of a partition can hold or renew the lease, so the minority can't elect its own leader. The availability cost is small and well understood: the minority side stops managing things while the majority continues. Pairing the lease with fencing, a term or epoch checked by the resource, covers the remaining gap where an old leader hasn't yet noticed it lost the lease.

**Q: Spanner claims to be "effectively CA". What does that mean and is it true? (Senior)**
A: Formally Spanner is CP: it uses Paxos groups, and a group that loses its majority, or a client cut off from it, can't make progress. The "effectively CA" argument, made by Brewer in 2017, is that Google's private, redundant network and operations make partitions so rare that the measured availability exceeds five nines, so users experience both consistency and availability. That's a statement about probabilities, not a way around the theorem. The takeaway for your own designs is that investing in network reliability and placement can make a CP design practical at very high availability, but you still need defined behaviour for the partitions that do happen.

## 10. Quick Revision & Cheat Sheet

| Term | Precise meaning |
|---|---|
| C | Linearizability: single up-to-date copy semantics |
| A | Every request to a non-failed node gets a non-error response |
| P | Messages between nodes may be lost; not optional |
| The theorem | During a partition, each operation chooses C (wait/fail) or A (answer locally) |
| CP in practice | Majority side works; minority refuses; no merge on heal |
| AP in practice | All sides answer; divergence merged (LWW / CRDT / app) |
| PACELC | Else-case: latency vs consistency, paid every request |
| etcd / ZooKeeper | CP writes; opt-in stale reads on minority |
| MongoDB | `w:majority` safe; `w:1` can roll back acknowledged writes |
| Cassandra | Tunable per query; QUORUM = CP-like; LWT = Paxos |
| DynamoDB | EC reads opt-in; global tables LWW (AP across regions) |
| PostgreSQL | Async replica reads AP; sync commit CP; Patroni leader via etcd |
| MySQL semi-sync | Falls back to async after timeout (C to A) |

- CAP applies only while nodes can't communicate; it constrains operations, not products.
- "CA" is not a design; it's an untested assumption.
- CP loses availability only on the minority side.
- AP needs a merge policy you'd be happy to explain to a customer.
- Timed-out CP writes have unknown outcomes: idempotency keys.
- Leadership and locks belong in CP stores, plus fencing.
- PACELC's latency cost usually decides multi-region designs.

## 11. Hands-On Exercises

1. **etcd partition.** Run a 3-node etcd cluster with Docker Compose. Disconnect one node; run writes, default reads, and `--consistency=s` reads on both sides. Then disconnect two nodes and observe that the remaining node can't serve writes either. Reconnect and check `etcdctl endpoint status` for term changes.
2. **PostgreSQL sync commit.** Primary + one standby (`postgres:17`), `synchronous_standby_names = 'standby1'`. Stop the standby's network; run an INSERT, watch `wait_event = 'SyncRep'` in `pg_stat_activity`, cancel it and read the warning. Verify the row exists on the primary. Switch to `ANY 1 (s1, s2)` with two standbys and repeat with one down.
3. **Replica staleness.** With an async replica, add `tc qdisc add dev eth0 root netem delay 500ms` on the replica container (requires `NET_ADMIN`), run a write loop on the primary, and graph `now() - pg_last_xact_replay_timestamp()` on the replica.
4. **Cassandra consistency levels.** In a 3-node Cassandra cluster with RF=3, stop two nodes; try reads and writes at ONE, QUORUM and ALL, and an LWT insert. Record which succeed.
5. **Lost acknowledged writes.** In a 3-member MongoDB replica set, isolate the primary, write with `w:1` for 10 seconds, reconnect, and find the rolled-back documents in the rollback directory. Repeat with `w:"majority"`.

**Mini project — "Partition behaviour table".** Pick a real service design (e.g. e-commerce checkout: catalogue, cart, inventory, payment, order history). For each operation, document: store, consistency setting, behaviour on the majority side, behaviour on the minority side, what the user sees, and how it heals. Then implement the two most critical paths with Docker (PostgreSQL + etcd or Cassandra) and prove the table true with injected partitions.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** [Ch 09 · Replication](topic.html?p=09-replication) · [Ch 10 · Consistency Models](topic.html?p=10-consistency-models) · [Ch 15 · Consensus](topic.html?p=15-consensus) · [Ch 17 · Multi-Region Databases](topic.html?p=17-multi-region-databases) · [Ch 18 · High Availability](topic.html?p=18-high-availability) · [Ch 13 · Distributed Transactions](topic.html?p=13-distributed-transactions).

**SQL Handbook:** [Isolation Levels](../sql/topic.html?p=26-isolation-levels) (isolation is a different axis) · [Transactions & ACID](../sql/topic.html?p=25-transactions-acid) (ACID's C).

**Other handbooks:** [System Design · CAP & Consistency Models](../system-design/topic.html?p=19-cap-consistency) · [Cassandra · CAP & Tunable Consistency](../cassandra/topic.html?p=03-cap-tunable-consistency) · [Cassandra · Multi-Datacenter](../cassandra/topic.html?p=32-multi-datacenter) · [Caching with Redis · Consistency Models](../redis-caching/topic.html?p=13-consistency-models).

- **Brewer's Conjecture and the Feasibility of Consistent, Available, Partition-Tolerant Web Services** — Gilbert & Lynch, 2002 · *Advanced* · the formal definitions and proof. <https://dl.acm.org/doi/10.1145/564585.564601>
- **CAP Twelve Years Later: How the "Rules" Have Changed** — Eric Brewer, IEEE Computer 2012 · *Intermediate* · Brewer's own correction of "pick two". <https://www.infoq.com/articles/cap-twelve-years-later-how-the-rules-have-changed/>
- **Consistency Tradeoffs in Modern Distributed Database System Design (PACELC)** — Daniel Abadi, IEEE Computer 2012 · *Intermediate* · the latency/consistency else-case. <https://www.cs.umd.edu/~abadi/papers/abadi-pacelc.pdf>
- **Spanner, TrueTime and the CAP Theorem** — Eric Brewer, Google 2017 · *Advanced* · why a CP system can be "effectively CA". <https://research.google/pubs/pub45855/>
- **Please stop calling databases CP or AP** — Martin Kleppmann · *Intermediate* · why the labels mislead and what to say instead. <https://martin.kleppmann.com/2015/05/11/please-stop-calling-databases-cp-or-ap.html>
- **The Network is Reliable** — Bailis & Kingsbury, ACM Queue 2014 · *Beginner* · real-world partition incidents. <https://queue.acm.org/detail.cfm?id=2655736>
- **Jepsen analyses** — Kyle Kingsbury · *Advanced* · how real databases behave under partitions, tested. <https://jepsen.io/analyses>

---

*Database Design Handbook — chapter 14.*
