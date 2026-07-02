# 20 · Consensus: Raft, Paxos & Leader Election

> **In one line:** Getting a group of unreliable machines to agree on a single value — or a single ordered log — despite crashes, delays, and network splits.

---

## 1. Overview

Consensus is the beating heart of every strongly-consistent distributed system. The problem: several nodes must **agree on one value** (or, more usefully, on the *order of a sequence of values* — a replicated log) even though messages are delayed or lost, and nodes crash and restart at the worst moments. If they can do that, you can build a fault-tolerant state machine: feed every replica the same ordered log of commands, and they all end up in the same state. This is **state-machine replication**, and it's how etcd, ZooKeeper, Spanner, CockroachDB, and Kafka's controller stay correct.

Why is this hard? Because a node can't tell the difference between a peer that **crashed** and a peer it simply **can't reach**. The FLP result (1985) proves that in a fully asynchronous network you cannot guarantee consensus terminates if even one node may fail. Real systems dodge FLP by assuming *partial synchrony* — messages eventually arrive within some bound — and using **timeouts** plus **randomization** to make progress in practice while never sacrificing safety.

The workhorse algorithms are **Paxos** (Lamport, 1998 — provably correct, famously hard to understand) and **Raft** (Ongaro & Ousterhout, 2014 — designed for understandability, now the default for new systems). Both rely on the same foundational trick: **majority quorums**. Any two majorities of an N-node cluster share at least one node, so no two conflicting decisions can both win.

A real-world example: when you `kubectl apply`, Kubernetes writes to **etcd**, which runs Raft across 3 or 5 nodes. The write isn't acknowledged until a majority have durably logged it — so a single node dying loses nothing, and there is never more than one authoritative answer.

## 2. Core Concepts

- **Consensus problem:** all correct nodes decide the *same* value (agreement), that value was *proposed* by someone (validity), and every correct node eventually decides (termination). Safety (agreement/validity) is never violated; termination is only guaranteed under partial synchrony.
- **Replicated log / state machine:** consensus on an *ordered sequence* of commands. Apply the same log to identical deterministic state machines → identical state everywhere.
- **Majority quorum (⌊N/2⌋+1):** the safety engine. Any two majorities overlap, so a value committed by one majority is visible to any future majority. N=3 tolerates 1 failure; N=5 tolerates 2.
- **Leader / single-decree:** electing one leader turns consensus into "the leader proposes, followers accept," collapsing rounds and giving linear ordering cheaply.
- **Term / epoch / ballot:** a monotonically increasing number that stamps leadership. Higher term always wins; it's how the cluster rejects a stale leader — the anti-split-brain mechanism.
- **Log replication:** the leader appends a command, ships it to followers, and **commits** it once a majority have persisted it.
- **Commit index:** the highest log position known to be safely replicated to a majority; entries at or below it will never be lost or reordered.
- **Split-brain:** two nodes both believing they're leader (e.g. after a partition). Prevented by requiring a *majority* to elect a leader and rejecting lower terms.
- **Fencing token:** a monotonically increasing number handed out with a lock/lease so a resource can reject a stale holder that "comes back from the dead."

## 3. Architecture

A Raft cluster has exactly one **leader** per term; all client writes flow through it. The leader replicates its log to **followers**; a **majority** ack commits an entry. If the leader is silent past an election timeout, a follower becomes a **candidate** and stands for election.

```svg
<svg viewBox="0 0 720 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Raft: one leader replicates a log to a majority (N=5)</text>

  <!-- client -->
  <rect x="30" y="150" width="100" height="50" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="80" y="180" text-anchor="middle" fill="#1e293b">Client</text>

  <!-- leader -->
  <rect x="270" y="140" width="150" height="70" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="345" y="168" text-anchor="middle" fill="#1e293b" font-weight="bold">Leader (term 4)</text>
  <text x="345" y="188" text-anchor="middle" fill="#64748b" font-size="11">log: [x=1, y=2, z=3]</text>

  <line x1="130" y1="175" x2="265" y2="175" stroke="#475569" stroke-width="1.5" marker-end="url(#a2)"/>
  <text x="197" y="167" text-anchor="middle" fill="#64748b" font-size="11">write</text>

  <!-- followers -->
  <rect x="560" y="45"  width="140" height="44" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="630" y="72" text-anchor="middle" fill="#1e293b">Follower 1 ✓</text>
  <rect x="560" y="105" width="140" height="44" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="630" y="132" text-anchor="middle" fill="#1e293b">Follower 2 ✓</text>
  <rect x="560" y="200" width="140" height="44" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="630" y="227" text-anchor="middle" fill="#1e293b">Follower 3 ✓</text>
  <rect x="560" y="260" width="140" height="44" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="630" y="287" text-anchor="middle" fill="#1e293b">Follower 4 (lag)</text>

  <line x1="420" y1="160" x2="555" y2="70"  stroke="#475569" stroke-width="1.5" marker-end="url(#a2)"/>
  <line x1="420" y1="168" x2="555" y2="127" stroke="#475569" stroke-width="1.5" marker-end="url(#a2)"/>
  <line x1="420" y1="185" x2="555" y2="222" stroke="#475569" stroke-width="1.5" marker-end="url(#a2)"/>
  <line x1="420" y1="195" x2="555" y2="282" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#a2)"/>

  <text x="345" y="250" text-anchor="middle" fill="#1e293b" font-size="12">Leader + 2 followers = 3 of 5 = majority →</text>
  <text x="345" y="268" text-anchor="middle" fill="#059669" font-size="12" font-weight="bold">entry committed. F4 catches up later.</text>
  <text x="345" y="300" text-anchor="middle" fill="#64748b" font-size="11">AppendEntries also acts as heartbeat; silence → election timeout → new term</text>
</svg>
```

## 4. How It Works

Raft in one pass — leader election then log replication:

1. **Start as follower.** Every node begins as a follower with a randomized **election timeout** (e.g. 150–300 ms). Followers expect periodic heartbeats (`AppendEntries`) from a leader.
2. **Timeout → candidate.** If a follower hears nothing before its timeout, it increments its **term**, votes for itself, and sends `RequestVote` RPCs to all peers.
3. **Win by majority.** A node grants its vote at most once per term, and only to a candidate whose log is at least as up-to-date as its own. A candidate that collects votes from a **majority** becomes **leader** for that term. Randomized timeouts make simultaneous candidacies (split votes) rare; a split vote just triggers another randomized round.
4. **Leader serves writes.** Clients send commands to the leader. The leader appends the command to its log (uncommitted) and sends `AppendEntries` to followers.
5. **Commit on majority.** Once a **majority** have persisted the entry, the leader advances its **commit index**, applies the command to its state machine, and returns success to the client. It tells followers the new commit index on the next heartbeat so they apply it too.
6. **Heartbeats keep the crown.** The leader sends empty `AppendEntries` as heartbeats to suppress follower timeouts. If the leader crashes or is partitioned into the minority, followers time out and elect a new leader in a higher term (step 2).
7. **Reconcile stale logs.** A new leader forces followers' logs to match its own by finding the last agreeing index and overwriting divergent tails — the **Log Matching** property guarantees this is safe.
8. **Stale leader steps down.** An old leader that rejoins sees a higher term in a reply and immediately reverts to follower — no split-brain.

## 5. Key Components / Deep Dive

### Raft's safety properties

Raft's correctness rests on a handful of invariants: **Election Safety** (≤1 leader per term), **Leader Append-Only** (a leader never overwrites its own log), **Log Matching** (if two logs share an entry at some index+term, all prior entries match), **Leader Completeness** (a committed entry is present in every future leader's log — enforced by the "at least as up-to-date" vote rule), and **State Machine Safety** (no two nodes apply different commands at the same log index). These together guarantee linearizable semantics.

### Paxos intuition — and why Raft is taught instead

Basic (single-decree) **Paxos** decides one value via two phases. A **proposer** picks a ballot number and sends **Prepare(n)** to acceptors; each acceptor promises not to accept anything lower and reports any value it already accepted. If a majority promise, the proposer sends **Accept(n, v)** — but if any acceptor already had a value, it must reuse that value, which is what preserves agreement. A majority of accepts commits. **Multi-Paxos** adds a stable leader to skip Phase 1 on the common path, converging on the same shape as Raft.

Paxos is provably correct but notoriously slippery: the paper leaves the practical "how do I build a log from this" as an exercise, and real Multi-Paxos implementations diverge. **Raft** was explicitly designed for *understandability* — it decomposes the problem into leader election, log replication, and safety, and forbids log holes (entries commit in order). That's why new systems (etcd, CockroachDB, TiKV, Consul) and most teaching pick Raft, even though Paxos underlies older giants (Chubby, Spanner, ZooKeeper's ZAB is Paxos-like).

### The coordination systems: ZooKeeper & etcd

These are consensus-as-a-service. **ZooKeeper** (ZAB protocol) and **etcd** (Raft) expose a small, strongly-consistent key-value/tree store used for the things a fleet must agree on: **leader election**, **distributed locks/leases**, **configuration**, **service discovery**, and **membership**. You rarely implement Raft yourself — you delegate the hard part to one of these and build on primitives like ephemeral nodes (ZK) or leases + compare-and-swap (etcd). Kubernetes uses etcd; Kafka historically used ZooKeeper (now its own Raft-based **KRaft**); HBase/Hadoop use ZooKeeper.

### Split-brain and fencing tokens

Even with a correct election, a paused leader (long GC, VM stall) can *think* it's still leader after its lease expired and a new one was elected. If it then writes to a shared resource (a database, a file), it corrupts state. The fix is **fencing tokens**: the lock service hands each leader a monotonically increasing token; the protected resource **remembers the highest token it has seen and rejects any lower one**. The zombie leader's write carries an old token and is refused. This is the critical, often-missed complement to leader election.

## 6. Trade-offs

| Option | Pros | Cons |
|---|---|---|
| **Raft** | Understandable, single strong leader, well-specified, great libraries (etcd/raft, hashicorp/raft) | Leader is a write bottleneck & single point of latency; all writes serialize through it |
| **Multi-Paxos** | Battle-tested, flexible (leaderless variants, EPaxos), powers Spanner/Chubby | Hard to implement correctly; many under-specified corners |
| **ZAB (ZooKeeper)** | Mature, primitives (ephemeral znodes, watches) ideal for coordination | JVM/ops heavy; write throughput capped by single leader |
| **Leaderless (Dynamo-style quorums)** | No election, high availability, no leader bottleneck | *Not* linearizable by itself; needs conflict resolution (see CAP topic) |
| **Larger cluster (N=5,7)** | Tolerates more failures (2,3) | Every write waits for a bigger majority → higher latency, lower throughput |

Consensus buys you linearizability and a single source of truth, but you pay in **write latency** (a majority round-trip) and **throughput** (one leader). Keep consensus clusters small (3 or 5) and *only* store the data that truly needs agreement — metadata, leadership, locks — not your bulk application data.

## 7. When to Use / When to Avoid

**Use consensus when:**
- You need a single authoritative leader / lock / lease (primary election, distributed locks).
- Strongly-consistent metadata: cluster membership, config, service registry, schema/sharding maps.
- Linearizable operations on small, critical state (counters that must be exact, sequencers).
- Building a replicated state machine (a consistent database's control plane, a consistent queue's ordering).

**Avoid / don't reach for consensus when:**
- You're storing high-volume application data — put it in a sharded/replicated DB; use consensus only for the metadata.
- Eventual consistency is acceptable (feeds, caches, telemetry) — quorum replication or gossip is cheaper and more available.
- You need cross-region low-latency writes — a majority spanning continents adds 100 ms+ per write; consider a single-region leader + async replicas.
- The workload is embarrassingly parallel with no shared decision — no agreement needed.

## 8. Scaling & Production Best Practices

- **Use odd cluster sizes, 3 or 5.** 3 tolerates 1 failure, 5 tolerates 2. Going to 7 rarely pays — bigger majorities slow every write. Even numbers waste a node (4 still only tolerates 1).
- **Keep the quorum in one region/low-latency zone.** A write costs one majority round-trip (~1–5 ms same-DC, ~30–150 ms cross-region). Place followers across AZs, not continents, for the voting set.
- **Snapshot and compact the log.** The replicated log grows forever; take periodic snapshots of the state machine and truncate applied entries or you'll run out of disk and slow restarts/catch-up.
- **Batch and pipeline.** Amortize the majority round-trip by batching many commands per `AppendEntries` and pipelining in-flight entries — etcd/Raft do thousands of ops/s this way.
- **Separate the data plane from the consensus plane.** Store bulk data in a normal store; keep only leadership, config, and small metadata in the consensus cluster.
- **Tune election timeouts.** Randomized, and ≫ broadcast time (e.g. 10× RTT) to avoid spurious elections during transient jitter; too long delays failover.
- **Use learners / non-voting members** to add read replicas or bootstrap new nodes without enlarging the voting quorum.

## 9. Failure Modes & Mitigations

| Failure | Impact | Mitigation |
|---|---|---|
| **Leader crash** | Writes stall until re-election | Randomized timeouts → new leader in ~1 election timeout; clients retry/redirect |
| **Network partition** | Minority side can't elect/commit (no majority) | Majority side keeps serving; minority is read-only or unavailable (correct by design) |
| **Split-brain (stale leader)** | Zombie leader corrupts shared resource | Terms reject lower-term leaders; **fencing tokens** on the protected resource |
| **Split vote** | No majority, election retries | Randomized election timeouts make repeated splits improbable |
| **Log divergence** | Followers disagree with new leader | Leader overwrites divergent follower tails (Log Matching); safe by construction |
| **Slow/lagging follower** | Reduced fault tolerance, catch-up load | Snapshots for fast catch-up; monitor lag; treat as failed if it can't keep up |
| **Loss of majority** | Cluster totally unavailable for writes | This is intentional (safety > liveness); restore nodes / use durable disks; consider N=5 |
| **Clock-based lease expiry mistimed** | Two "leaders" briefly | Fencing tokens; conservative lease margins; don't trust wall clocks for safety |

## 10. Monitoring & Metrics

- **Leader elections / term changes per minute** — should be near zero; churn signals flapping, bad timeouts, or an overloaded leader.
- **Has-leader / leader-uptime** — alert immediately on "no leader."
- **Commit latency (p50/p99)** — the majority round-trip; spikes mean a slow follower or disk fsync stalls.
- **Log replication lag per follower** (entries/bytes behind) — a lagging follower erodes fault tolerance.
- **Raft proposal failures / dropped proposals** — backpressure or lost leadership.
- **Snapshot frequency, size, duration & log size on disk** — watch for unbounded log growth.
- **Fsync / WAL commit duration** — consensus safety depends on durable writes; slow disks throttle the whole cluster.
- **Quorum health / member count** — how many failures you can still tolerate right now.

## 11. Common Mistakes

1. ⚠️ Using an **even number of nodes** — 4 tolerates the same 1 failure as 3 but needs a larger majority; always go odd.
2. ⚠️ **Leader election without fencing tokens** — a paused-then-resumed old leader corrupts shared state. Election alone does *not* prevent split-brain damage.
3. ⚠️ Putting the **voting quorum across regions** — every write pays cross-continent latency; keep voters close, use async/learner replicas far away.
4. ⚠️ **Storing bulk data in etcd/ZooKeeper** — they're for small, critical metadata, not your dataset. They'll fall over.
5. ⚠️ Forgetting **log compaction/snapshots** — the log grows without bound and restarts take forever.
6. ⚠️ Assuming **quorum reads are automatically linearizable** — a stale leader can serve old reads; use leader leases or read-index/ReadIndex protocols.
7. ⚠️ Setting **election timeouts too tight**, causing spurious elections under normal jitter — or too loose, delaying failover.
8. ⚠️ Believing consensus gives **availability during a partition** — the minority side is *supposed* to stop; that's CP, by design.

## 12. Interview Questions

**Q: What problem does consensus solve, and why is it hard?**
A: Getting a set of unreliable nodes to agree on a single value or a single ordered log despite crashes and lost/delayed messages. It's hard because a node can't distinguish a crashed peer from an unreachable one; FLP proves you can't guarantee termination in a fully async network, so systems use timeouts + partial synchrony to make progress while never violating safety.

**Q: Why a majority quorum?**
A: Any two majorities of N nodes share at least one member. So a value committed by one majority is guaranteed to be seen by any future majority (e.g. a new leader's election quorum), which makes two conflicting commits impossible. N=3 tolerates 1 failure, N=5 tolerates 2.

**Q: Walk through Raft leader election.**
A: Nodes start as followers with randomized election timeouts. On timeout a follower increments its term, votes for itself, and requests votes. Peers vote at most once per term and only for a candidate whose log is at least as up-to-date. A majority makes the candidate leader; it then sends heartbeats. Randomized timeouts prevent persistent split votes.

**Q: How does Raft replicate and commit a log entry?**
A: The leader appends the command locally (uncommitted), sends `AppendEntries` to followers, and once a majority persist it, advances the commit index, applies it, and returns success. Followers learn the commit index on the next heartbeat and apply too. Entries commit in order — no holes.

**Q: What is a term/epoch and what does it protect against?**
A: A monotonically increasing leadership number. Higher term wins; any node seeing a higher term steps down, and lower-term messages are rejected. It's the mechanism that prevents a stale leader from acting after a new one is elected — the core anti-split-brain guard.

**Q: Paxos vs Raft — why is Raft usually taught and chosen for new systems?**
A: Both are majority-quorum consensus and are equally powerful; Multi-Paxos with a stable leader looks a lot like Raft. But basic Paxos is under-specified for building a log and famously hard to reason about, so implementations vary. Raft was designed for understandability — clean decomposition into election, replication, safety, and no log holes — so it's easier to teach and to implement correctly (etcd, Consul, CockroachDB, TiKV).

**Q: (Senior) Leader election isn't enough to prevent split-brain damage. Explain and give the fix.**
A: A leader can pause (long GC/VM stall) past its lease, a new leader gets elected, then the old one resumes still believing it's leader and writes to a shared resource — corrupting it. Election prevented *two elected leaders*, but not the zombie's *writes*. Fix: **fencing tokens** — the lock/lease service issues a monotonically increasing token per leadership; the protected resource records the highest token seen and rejects anything lower, so the zombie's stale-token write is refused.

**Q: (Senior) How do you serve linearizable reads without paying a full log write per read?**
A: A naive read from the leader can be stale if it was just deposed. Use the **ReadIndex/read-lease** technique: the leader records its current commit index, confirms it's still leader by a heartbeat round to a majority (or relies on a leader lease bounded by clock uncertainty), waits until its state machine has applied up to that index, then serves the read. This gives linearizable reads with a lightweight round-trip or none (with leases) instead of appending a log entry.

**Q: (Senior) Your 3-node etcd cluster spans us-east, us-west, and eu-west. Writes are slow and elections flap. Diagnose.**
A: Every commit needs a majority (2 of 3) round-trip, and with nodes on three continents the second-fastest ack is ~80–150 ms away — so write latency is dominated by inter-region RTT, and cross-region jitter/packet loss trips election timeouts, causing leader churn. Fix: colocate the *voting* members within one region across AZs (single-digit-ms RTT), and put remote sites as **non-voting learners** for local reads, or run separate regional clusters with async replication. Consensus voters must be close.

**Q: (Senior) Why does a consensus cluster become unavailable when it loses a majority, and is that a bug?**
A: Not a bug — it's the safety/liveness trade. To commit or elect, you need a majority; with N=3, losing 2 nodes leaves 1, which cannot form a majority, so it must refuse writes rather than risk two divergent histories. This is deliberate CP behavior: it sacrifices availability to never violate agreement. Mitigate by using N=5 (tolerates 2), durable disks so nodes recover, and spreading across independent failure domains.

**Q: (Senior) When would you NOT use Raft/consensus even though you need consistency?**
A: When the consistent state is large or high-throughput — a single leader serializing every write becomes the bottleneck. Instead, use consensus only for the *control plane* (sharding map, leadership) and shard the data across many independent consensus/replication groups (like Spanner's per-tablet Paxos groups or CockroachDB's per-range Raft), so throughput scales horizontally while each small group stays linearizable.

## 13. Alternatives & Related

- **CAP, PACELC & Consistency Models** — consensus is how you *implement* the CP / linearizable end of the spectrum.
- **Distributed Transactions, 2PC & Saga** — 2PC often uses consensus to make the *coordinator* fault-tolerant.
- **Leaderless quorum replication (Dynamo-style)** — the AP alternative; available but not linearizable.
- **Distributed locks & leases** — the primitives ZooKeeper/etcd expose on top of consensus.
- **State-machine replication** — the general pattern consensus enables.

## 14. Cheat Sheet

> [!TIP]
> **Goal:** agree on one ordered **log** despite crashes/partitions → replicate it to identical state machines.
> **Safety engine:** **majority quorum** (⌊N/2⌋+1); two majorities always overlap. N=3→tolerate 1, N=5→tolerate 2. Use **odd** sizes.
> **Raft = election + log replication + safety.** One **leader** per **term**; commit an entry when a **majority** persist it; advance the **commit index**.
> **Term/epoch:** higher term wins; stale leader steps down → no split-brain.
> **Paxos:** provably correct, hard; Multi-Paxos ≈ Raft. Raft chosen for understandability.
> **etcd (Raft) / ZooKeeper (ZAB):** consensus-as-a-service for leader election, locks, config, membership.
> **Split-brain fix:** election alone isn't enough → **fencing tokens** (reject lower token at the resource).
> **Cost:** write = 1 majority round-trip; keep voters in one region, cluster small, log snapshotted.

**References:** Ongaro & Ousterhout "In Search of an Understandable Consensus Algorithm" (Raft paper), Lamport "Paxos Made Simple", DDIA ch.9, etcd/Raft docs, Google "Chubby" paper, Kleppmann "How to do distributed locking" (fencing tokens).

---
*System Design Handbook — topic 20.*
