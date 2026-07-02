# 19 · CAP, PACELC & Consistency Models

> **In one line:** During a network partition you must choose consistency or availability — and even when the network is healthy you still trade latency against consistency.

---

## 1. Overview

A single-node database gives you consistency for free: there is one copy of the truth. The moment you **replicate** data across nodes — for durability, read scaling, or geo-locality — you inherit a hard question: when two replicas disagree, which one is right, and what do you tell a client that reads the loser?

The **CAP theorem** (Brewer, formalized by Gilbert & Lynch, 2002) frames the sharpest version of this. In an asynchronous network that can drop or delay messages, a replicated store cannot simultaneously guarantee **Consistency** (every read sees the latest write — really *linearizability*), **Availability** (every request to a non-failing node gets a non-error response), and **Partition tolerance** (the system keeps working despite dropped messages between nodes). You get to keep two.

The catch that trips up most candidates: **partitions are not optional**. Networks fail — a switch reboots, a cable is cut, a GC pause makes a node look dead. So P is a fact of life, not a design choice. The real choice is **CP vs AP**: when a partition happens, do you sacrifice consistency (serve possibly-stale data, stay up) or availability (refuse to answer, stay correct)?

**PACELC** (Abadi, 2012) completes the picture: **if** there is a **P**artition, trade **A**vailability vs **C**onsistency; **E**lse (normal operation), trade **L**atency vs **C**onsistency. This is the more useful lens in practice, because partitions are rare but the latency-vs-consistency tax is paid on *every single request*.

## 2. Core Concepts

- **Linearizability (strong consistency):** the system behaves as if there is one copy of the data and every operation takes effect atomically at some instant between its call and return. Once a write completes, *all* subsequent reads see it. This is a **recency** guarantee.
- **Partition:** a network split where nodes cannot communicate but are individually alive. Indistinguishable, from a node's view, from the peers having crashed — which is exactly why it's hard.
- **Availability (CAP sense):** *every* request to a live node returns a non-error response. This is stricter than "high uptime" — a node returning an error or hanging counts as unavailable.
- **CP system:** under partition, refuse requests that can't be made safe (e.g. minority side stops serving). Prioritizes correctness. Examples: **ZooKeeper**, **etcd**, **Spanner**, HBase.
- **AP system:** under partition, keep serving on all sides and reconcile later. Prioritizes uptime. Examples: **Cassandra**, **DynamoDB** (default), Riak.
- **PACELC:** the two-axis framing — Partition→(A vs C), Else→(L vs C). Lets you classify e.g. Cassandra as **PA/EL**, Spanner as **PC/EC**, DynamoDB as **PA/EL** (tunable to PC/EC).
- **Quorum (W + R > N):** with N replicas, if every write hits W nodes and every read consults R nodes and W+R>N, the read set and write set *overlap* in at least one node → the read sees the latest write.
- **Tunable consistency:** per-request choice of W and R (Cassandra `ONE`/`QUORUM`/`ALL`, DynamoDB strong vs eventual reads) so one datastore serves both a payments path and a like-counter.
- **Consistency ≠ isolation:** CAP's C is about *recency across replicas*; ACID's C/isolation (serializability) is about *concurrent transactions on one logical copy*. Different axes — don't conflate them.

## 3. Architecture

The knob is where a write is considered "done" and where a read looks. A CP design forces overlap and blocks when it can't reach a majority; an AP design accepts any node and repairs divergence in the background.

```svg
<svg viewBox="0 0 720 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Quorum replication: N=3, W=2, R=2 (W+R&gt;N)</text>

  <!-- client -->
  <rect x="40" y="120" width="110" height="52" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="95" y="150" text-anchor="middle" fill="#1e293b">Client</text>

  <!-- coordinator -->
  <rect x="210" y="120" width="130" height="52" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="275" y="143" text-anchor="middle" fill="#1e293b">Coordinator</text>
  <text x="275" y="160" text-anchor="middle" fill="#64748b" font-size="11">picks quorum</text>

  <!-- replicas -->
  <rect x="470" y="55" width="180" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="560" y="83" text-anchor="middle" fill="#1e293b">Replica A  (v7 ✓)</text>
  <rect x="470" y="123" width="180" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="560" y="151" text-anchor="middle" fill="#1e293b">Replica B  (v7 ✓)</text>
  <rect x="470" y="191" width="180" height="46" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="560" y="214" text-anchor="middle" fill="#1e293b">Replica C  (v6 stale)</text>
  <text x="560" y="230" text-anchor="middle" fill="#64748b" font-size="11">lagging / partitioned</text>

  <line x1="150" y1="146" x2="205" y2="146" stroke="#475569" stroke-width="1.5" marker-end="url(#ah)"/>
  <line x1="340" y1="140" x2="465" y2="78"  stroke="#475569" stroke-width="1.5" marker-end="url(#ah)"/>
  <line x1="340" y1="146" x2="465" y2="146" stroke="#475569" stroke-width="1.5" marker-end="url(#ah)"/>
  <line x1="340" y1="152" x2="465" y2="214" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#ah)"/>

  <text x="300" y="280" text-anchor="middle" fill="#1e293b" font-size="12">Write reaches A+B (W=2). Read consults any 2 → set includes A or B →</text>
  <text x="300" y="298" text-anchor="middle" fill="#059669" font-size="12" font-weight="bold">read always overlaps latest write. Stale C is repaired async.</text>
</svg>
```

## 4. How It Works

The end-to-end flow of a quorum write followed by a read, and what happens when a partition strikes:

1. **Write v7.** Client sends `SET k=v7` to a coordinator. The coordinator forwards to all N=3 replicas but waits for only **W=2** acks before telling the client "OK." Replica C is slow/partitioned and still holds v6.
2. **Acknowledge.** Two acks arrive (A, B). The write is durable on a majority; the client sees success. C will catch up via hinted handoff or read-repair.
3. **Read k.** A read consults **R=2** replicas. Since W+R = 4 > N = 3, the read set of 2 nodes *must* include at least one of the 2 nodes that took the write → it sees v7.
4. **Resolve conflicts.** If the read sees mismatched versions (v7 vs v6), the coordinator picks the winner by **version/timestamp** (last-write-wins) or **vector clocks** (detect concurrent writes → return siblings for app resolution) and issues a **read-repair** to the stale replica.
5. **Partition hits.** Suppose A+B are on one side, C on the other. A **CP** system on the majority side (A,B) keeps serving (it can still form a 2-of-3 quorum); the minority side (C) refuses writes → consistent but partially unavailable. An **AP** system lets C accept writes too → both sides stay up but diverge, reconciled later.
6. **Heal.** When the partition clears, replicas exchange missed updates (anti-entropy / Merkle-tree sync) and converge.

## 5. Key Components / Deep Dive

### The consistency spectrum (strongest → weakest)

| Model | Guarantee | Cost / note |
|---|---|---|
| **Linearizable (strong)** | Reads see the latest committed write; single-copy illusion | Needs consensus or majority quorum; cross-region latency |
| **Sequential** | All nodes see operations in the *same* order, but not necessarily real-time recent | Weaker than linearizable (no realtime bound) |
| **Causal** | Operations with a cause→effect relationship are seen in order; concurrent ops may reorder | Cheap-ish, matches human intuition; great default for social apps |
| **Read-your-writes** | A client always sees its *own* prior writes | Session guarantee; sticky routing or write-timestamp tracking |
| **Monotonic reads** | You never see time go backwards on re-reads | Session guarantee |
| **Eventual** | If writes stop, replicas eventually converge — no recency bound | Cheapest, most available; app must tolerate staleness |

Causal, read-your-writes, and monotonic reads are **session guarantees** — sweet spots that give a "feels correct" experience far cheaper than full linearizability.

### Quorum math and its holes

`W + R > N` guarantees read/write set overlap; `W > N/2` also prevents two conflicting writes from both succeeding. Common configs on N=3: `W=R=2` (balanced strong-ish), `W=3,R=1` (fast reads, slow writes), `W=1,R=1` (fast, eventual). **But quorums are not linearizable by themselves** — concurrent writes, failed writes leaving partial state, and read-repair races can still surface anomalies (DDIA §9 covers these). True linearizability needs consensus (see **Consensus: Raft, Paxos & Leader Election**).

### Why "CA" doesn't exist

A "CA" system means "consistent and available as long as there is no partition." But P isn't a property you can turn off — it's an environmental fact. So "CA" just describes a CP or AP system that hasn't been tested by a partition yet. Rejecting the "CA" label is a classic senior-signal in interviews.

## 6. Trade-offs

| Option | Pros | Cons |
|---|---|---|
| **CP (strong / linearizable)** | Correct reads always; simple app logic; no reconciliation code | Minority side unavailable during partition; higher latency (cross-node/region coordination); lower throughput |
| **AP (eventual)** | Always writable, low latency, survives partitions; scales geo | App must handle stale reads & conflicts; last-write-wins can silently drop data |
| **Tunable (per-request W/R)** | One store serves both payments (QUORUM) and likes (ONE) | Foot-guns: wrong knob = neither fast nor correct; harder to reason about |
| **Causal / session guarantees** | Cheap, feels correct to users, partition-tolerant | Not sufficient for money/inventory; needs dependency tracking |

The decision is per-*data-class*, not per-system. Money, inventory, and unique-username checks want CP/linearizable. Feeds, counters, presence, and analytics are fine on AP/eventual. Most real products run both, often in the *same* database via tunable knobs.

## 7. When to Use / When to Avoid

**Choose strong consistency (CP) when:**
- Correctness beats uptime: payments, ledgers, inventory decrements, unique constraints, leader/lock state.
- The app can't afford reconciliation logic or user-visible anomalies.
- Data is regionally co-located so coordination latency is tolerable.

**Choose eventual/AP (or weaker session guarantees) when:**
- Availability and low latency dominate: shopping carts, feeds, likes, presence, telemetry.
- Writes are naturally conflict-free or commutative (CRDT-friendly counters, sets).
- You serve globally and can't pay cross-region round-trips per request.

## 8. Scaling & Production Best Practices

- **Keep coordination local.** Cross-region linearizable writes cost a round-trip (~30–150 ms trans-continental). Pin the strongly-consistent write path to one region; replicate read-only followers globally.
- **Use quorums sized to your failure budget.** N=3, W=R=2 tolerates 1 replica loss with strong-ish reads. N=5, W=R=3 tolerates 2 losses — for control-plane/consensus data.
- **Exploit tunable consistency per call.** Read a user's own profile with read-your-writes (route to leader / QUORUM); read a trending feed with `ONE`.
- **Layer session guarantees cheaply.** Sticky-route a session to one replica, or track the last-write timestamp client-side, to get read-your-writes without global strong consistency.
- **Bound staleness.** DynamoDB/Cosmos offer *bounded-staleness* (converge within K versions or T seconds) — a pragmatic middle ground for dashboards.
- **Measure the tax.** Strong reads on Cosmos DB cost ~2× the RUs of eventual reads; budget for it.

## 9. Failure Modes & Mitigations

| Failure | Impact | Mitigation |
|---|---|---|
| **Network partition** | Minority side unavailable (CP) or divergence (AP) | Majority quorums; hinted handoff; anti-entropy repair on heal |
| **Last-write-wins clobber** | Concurrent writes silently drop one update | Vector clocks / version vectors → return siblings; use CRDTs for counters |
| **Clock skew (LWW by wall-clock)** | Wrong write "wins," data loss | Hybrid logical clocks; Spanner TrueTime; avoid wall-clock LWW for critical data |
| **Read-repair race** | Non-linearizable read despite quorum | Use real consensus for linearizable needs; don't oversell quorum as strong |
| **Stale read after failover** | Client sees data go backwards | Fence with terms/epochs; monotonic-read routing; read from leader |
| **Split-brain (two leaders)** | Conflicting authoritative writes | Majority-elected single leader + fencing tokens (see Consensus topic) |

## 10. Monitoring & Metrics

- **Replication lag** (seconds and *versions* behind) per replica — the leading indicator of stale reads.
- **Read staleness distribution** — sample how old served data is; alert on p99 > SLA.
- **Quorum failures / write timeouts** — spikes signal partitions or an overloaded replica.
- **Conflict / sibling rate** (AP stores) — rising vector-clock conflicts mean hot contested keys.
- **Read-repair rate & hinted-handoff backlog** — sustained high values = a replica falling behind.
- **Per-consistency-level latency** (ONE vs QUORUM vs ALL) — quantify the consistency tax.
- **Leader election / view-change frequency** for CP stores — churn indicates flapping.

## 11. Common Mistakes

1. ⚠️ Calling a system **"CA."** Partitions are unavoidable; every real replicated system is CP or AP.
2. ⚠️ Believing a **quorum = linearizability.** W+R>N gives overlap, not a total order; concurrent/failed writes still cause anomalies.
3. ⚠️ Using **wall-clock last-write-wins** for important data — clock skew silently drops writes.
4. ⚠️ Applying **one consistency level system-wide** instead of per-data-class.
5. ⚠️ Ignoring **PACELC's "else"** — you pay latency-vs-consistency on every request, not just during rare partitions.
6. ⚠️ Conflating **CAP consistency** (recency across replicas) with **ACID isolation** (concurrent-txn ordering).
7. ⚠️ Assuming **eventual consistency is fine everywhere** — inventory and unique usernames will burn you.
8. ⚠️ Forgetting **read-your-writes**: users expect to see their own edit immediately, even on an AP store.

## 12. Interview Questions

**Q: State the CAP theorem precisely.**
A: In an asynchronous network subject to partitions, a replicated store cannot simultaneously provide linearizable consistency, availability (every request to a live node returns a non-error), and partition tolerance. Since partitions occur, the real trade is CP vs AP.

**Q: Why is Partition tolerance not a real "choice"?**
A: Partitions are caused by the environment (dropped/delayed packets, dead switches, GC pauses that look like crashes), not by the system's design. You can't opt out of network failure, so P is fixed and the choice is what to do *during* one: sacrifice C or A.

**Q: What does PACELC add over CAP?**
A: It covers the common case. **P**→(A vs C) is CAP; **E**lse→(**L**atency vs **C**onsistency) captures that even with a healthy network, staying strongly consistent costs coordination latency. Cassandra is PA/EL, Spanner PC/EC.

**Q: Walk me through quorum consistency. When does W+R>N still return stale data?**
A: With N replicas, writing to W and reading from R where W+R>N forces the read and write sets to overlap on ≥1 node, so a read sees the latest *completed* write. It can still be non-linearizable: a write in progress (some replicas updated, some not) read concurrently, a failed write that partially applied, or read-repair reordering can surface stale or flip-flopping values. Quorum ≠ consensus.

**Q: Classify Spanner, DynamoDB, Cassandra, and ZooKeeper in PACELC.**
A: Spanner **PC/EC** (TrueTime-backed linearizable, pays latency). ZooKeeper **PC/EC** (majority consensus). DynamoDB default **PA/EL** but offers strongly-consistent reads (→ PC/EC per request). Cassandra **PA/EL**, tunable up to QUORUM/ALL for stronger reads.

**Q: A user updates their profile then reloads and sees the old value. Which guarantee is missing and how do you fix it cheaply?**
A: Read-your-writes (a session guarantee). Fix without global strong consistency: route the user's reads to the leader/replica that took their write for a short window, use sticky sessions, or track the write's timestamp/version client-side and only read from a replica caught up to it.

**Q: (Senior) You need linearizable uniqueness (no two users get the same username) on a globally-distributed AP store. How?**
A: You can't get it from the AP path alone. Options: (1) route unique-constraint operations through a CP subsystem — a consensus group (etcd/ZooKeeper) or a single-leader shard keyed by username hash; (2) use a compare-and-set/conditional-write primitive (DynamoDB conditional put with strong consistency) on the username partition; (3) accept eventual and reconcile with a background dedupe + compensation. (1)/(2) are correct; (3) allows a transient double-claim.

**Q: (Senior) Last-write-wins is dropping concurrent updates in production. Diagnose and fix.**
A: LWW keeps the highest timestamp and discards the rest, so genuinely concurrent writes lose data — worsened by clock skew making an *earlier* write appear later. Fixes: replace wall-clock timestamps with **version vectors / vector clocks** to *detect* concurrency and return siblings for app-level merge; use **CRDTs** for commutative types (counters, sets, LWW-registers with logical clocks); adopt **hybrid logical clocks** to bound skew. For anything monetary, move it to a CP/serializable path entirely.

**Q: (Senior) Design the consistency model for an e-commerce checkout end-to-end.**
A: Split by data class. **Inventory decrement & payment**: strong/linearizable — single-leader shard or serializable transaction, because overselling and double-charging are unacceptable. **Cart**: read-your-writes session guarantee — cheap, tolerant of a little staleness. **Product catalog & reviews**: eventual/AP, cached at the edge — reads dominate, staleness of seconds is fine. **Order history**: read-your-writes so the buyer sees their order immediately. This mixed model gives correctness where it's mandatory and availability/latency everywhere else.

**Q: (Senior) Your CP store's minority region is down during a partition. The business demands "always writable." What do you do?**
A: You're being asked to change the C/A trade for this data. Either (a) reclassify the data as AP-tolerable and accept reconciliation (add conflict resolution/compensation), or (b) keep it CP but reduce partition *impact*: co-locate the write leader with the majority region, shrink blast radius by sharding so only affected keys block, and add a degraded read-only mode on the minority side. You cannot have both linearizability and availability on the partitioned side simultaneously — the honest answer names the trade rather than pretending to dodge it.

## 13. Alternatives & Related

- **Consistency, Replication & Quorums** — the mechanics of W/R/N and anti-entropy (sibling topic **08 · CAP, Consistency & Replication**).
- **Consensus: Raft, Paxos & Leader Election** — how you actually *get* linearizability and a single leader.
- **Distributed Transactions, 2PC & Saga** — consistency across *services*, not just replicas.
- **CRDTs** — data types that converge without coordination, the AP-world answer to conflicts.
- **Isolation levels (serializable, snapshot)** — the orthogonal, transaction-ordering axis.

## 14. Cheat Sheet

> [!TIP]
> **CAP:** during a Partition, pick **C**onsistency or **A**vailability; **P** is mandatory (networks fail) → real choice is **CP vs AP**.
> **PACELC:** if Partition → A vs C; **Else** → **Latency vs Consistency** (paid every request).
> **Spectrum:** linearizable → sequential → causal → read-your-writes → monotonic → eventual.
> **Quorum:** `W+R>N` = read/write overlap (strong-ish); `W>N/2` = no split writes; quorum ≠ consensus.
> **Classify:** Spanner/ZK/etcd = PC/EC · Cassandra = PA/EL · DynamoDB = PA/EL (tunable).
> **Rule:** consistency is chosen **per data class** — money=strong, likes=eventual.
> **Never** call a system "CA"; **never** trust wall-clock LWW for critical data.

**References:** Gilbert & Lynch "Brewer's Conjecture" (CAP proof), Abadi "Consistency Tradeoffs in Modern Distributed Database Design" (PACELC), DDIA ch.5 & ch.9, Jepsen consistency-models page, AWS DynamoDB developer guide.

---
*System Design Handbook — topic 19.*
