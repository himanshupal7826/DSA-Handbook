# 15 · Consensus: Raft, Quorums & Leader Election

> **In one line:** Consensus lets a group of machines agree on one ordered log despite crashes and partitions, by requiring every decision to be acknowledged by a majority whose memberships always overlap; it is what makes "exactly one leader" true, and it is the piece plain database replication does not have — which is why PostgreSQL clusters borrow it from etcd.

---

## 1. Overview

You run a PostgreSQL primary with two streaming replicas. The primary's host stops responding. Should a replica be promoted? The replica can't tell whether the primary is dead, or merely unreachable *from the replica* while still serving application servers on the other side of a network fault. If it promotes itself and the old primary is alive, you have **split brain**: two primaries accepting writes, two diverging histories, and a data-reconciliation nightmare. If it waits forever, you have no availability. Timeouts alone can't solve this, because every node can time out on every other node at the same moment and all reach different conclusions.

What you need is a way for a group of nodes to **agree** — on who the leader is, and on the order of operations — such that no two nodes ever decide differently, even if messages are delayed, lost or reordered and some nodes crash. That is the **consensus problem**. Its practical solutions (Paxos, Raft, ZAB, Viewstamped Replication) share one core idea: **every decision requires a majority**, and because any two majorities of the same group intersect in at least one node, two conflicting decisions can never both be made. A minority can't elect a leader, and a leader that loses its majority can't commit anything.

This chapter treats consensus from the database engineer's angle. You will rarely implement Raft, but you run systems built on it every day — etcd under Kubernetes and Patroni, Kafka's KRaft controllers, CockroachDB and TiKV ranges, MongoDB replica sets (a Raft-like protocol), Consul. Understanding terms, votes, log matching and commit rules lets you size clusters correctly, read their metrics, debug elections that flap, and — crucially — understand why **PostgreSQL streaming replication is replication, not consensus**, and what Patroni adds.

> **Builds on:** [Ch 09 · Replication](topic.html?p=09-replication) (leader/follower log shipping) · [Ch 14 · CAP Theorem](topic.html?p=14-cap-theorem) (why the minority must stop) · [Ch 07 · Write-Ahead Logging](topic.html?p=07-write-ahead-logging) (a replicated log is a distributed WAL) · [System Design · Consensus](../system-design/topic.html?p=20-consensus) (Raft's safety properties, Paxos intuition, ZooKeeper/etcd, fencing). This chapter assumes those and goes into Raft's mechanics step by step, quorum sizing, failure detection, epochs/fencing, and how databases use (or don't use) consensus.

## 2. Core Concepts

- **Consensus** — nodes propose values and all non-faulty nodes decide the same one, which must have been proposed. *Why it matters:* a replicated log is just consensus run once per log slot.
- **Replicated state machine** — every node applies the same commands in the same order and so reaches the same state. *Why it matters:* this is how etcd, CockroachDB ranges and KRaft metadata stay identical on every replica.
- **Leader / follower / candidate** — Raft's three roles. *Why it matters:* all client writes go through the single leader of the current term.
- **Term (epoch)** — a monotonically increasing number; each term has at most one leader. *Why it matters:* terms order leaders in time and let everyone recognise and reject a stale leader.
- **Quorum (majority)** — ⌊N/2⌋ + 1 of the voting members. *Why it matters:* any two quorums intersect, which is the entire safety argument.
- **RequestVote** — the RPC a candidate sends to ask for votes, carrying its last log index and term. *Why it matters:* voters refuse candidates with less up-to-date logs, so a new leader always holds every committed entry.
- **AppendEntries** — the RPC a leader uses to replicate entries (and, with no entries, as a heartbeat). *Why it matters:* its consistency check repairs divergent follower logs.
- **Commit index** — the highest log index known to be replicated on a majority (in the current term). *Why it matters:* only committed entries are applied and acknowledged to clients.
- **Election timeout** — how long a follower waits without hearing from a leader before starting an election; randomised per node. *Why it matters:* too short gives false elections, too long gives slow failover.
- **Fencing token** — a monotonically increasing number (e.g. the term or a lease revision) that a protected resource checks. *Why it matters:* it stops a deposed leader that doesn't yet know it's deposed.
- **Split brain** — two nodes acting as leader at the same time. *Why it matters:* consensus prevents two leaders from *committing*, but only fencing prevents an old leader from acting on *external* resources.

## 3. Theory & Principles

### Why majorities work: quorum math

| Voting members N | Quorum | Failures tolerated | Notes |
|---|---|---|---|
| 1 | 1 | 0 | No fault tolerance |
| 2 | 2 | 0 | Worse than 1: either failure stops progress |
| 3 | 2 | 1 | The common minimum |
| 4 | 3 | 1 | Same tolerance as 3, bigger quorum: slower |
| 5 | 3 | 2 | Typical for control planes that must survive maintenance + a failure |
| 7 | 4 | 3 | Rarely worth the write latency |

To tolerate **f** crash failures you need **2f + 1** members. Even numbers add cost without tolerance. And placement matters as much as count: three etcd members in one availability zone tolerate one *node* failure but not the zone failing. Three members across three zones tolerate a zone. For two-datacenter deployments there is no good answer with majorities — whichever site holds the majority is the one that survives, so you add a small tie-breaker member in a third site.

Quorum intersection gives the two safety guarantees you care about:

1. **At most one leader per term.** Each node votes at most once per term (persisted to disk), and a leader needs a majority, so two candidates can't both win the same term.
2. **Committed entries survive leader changes.** An entry is committed once a majority has it. Any future leader must win votes from a majority, which overlaps the committing majority, and voters refuse candidates whose log is less up-to-date. So every future leader already has every committed entry.

### Leader election in Raft

Every node starts as a **follower**. A follower that hears nothing from a leader for its election timeout (randomised, e.g. 150–300 ms in the Raft paper; etcd defaults to a 100 ms heartbeat and a 1,000 ms election timeout) becomes a **candidate**: it increments its term, votes for itself, persists that, and sends `RequestVote(term, lastLogIndex, lastLogTerm)` to everyone. A voter grants its vote if (a) it hasn't voted in this term, and (b) the candidate's log is **at least as up-to-date** as its own — compare last entries' terms first, then indices. A candidate with votes from a majority becomes **leader** and immediately sends heartbeats to assert itself. Any node that sees a higher term in any message steps down to follower and adopts that term. Randomised timeouts make it unlikely that two candidates split the vote repeatedly.

```svg
<svg viewBox="0 0 880 480" width="100%" height="480" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c15a1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
    <marker id="c15a2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Raft roles, terms and an election after the leader fails</text>
  <rect x="40" y="44" width="150" height="50" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="115" y="66" text-anchor="middle" fill="#1e40af" font-weight="bold">Follower</text>
  <text x="115" y="82" text-anchor="middle" fill="#1e3a8a" font-size="10">passive, votes, appends</text>
  <rect x="365" y="44" width="150" height="50" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="440" y="66" text-anchor="middle" fill="#92400e" font-weight="bold">Candidate</text>
  <text x="440" y="82" text-anchor="middle" fill="#78350f" font-size="10">term+1, votes for self</text>
  <rect x="690" y="44" width="150" height="50" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="765" y="66" text-anchor="middle" fill="#15803d" font-weight="bold">Leader</text>
  <text x="765" y="82" text-anchor="middle" fill="#166534" font-size="10">heartbeats, replicates</text>
  <path d="M192,62 L361,62" stroke="#334155" stroke-width="1.5" marker-end="url(#c15a1)"/>
  <text x="276" y="56" text-anchor="middle" fill="#334155" font-size="10">election timeout, no heartbeat</text>
  <path d="M517,62 L686,62" stroke="#16a34a" stroke-width="1.5" marker-end="url(#c15a2)"/>
  <text x="601" y="56" text-anchor="middle" fill="#15803d" font-size="10">votes from a majority</text>
  <path d="M686,84 C600,120 280,120 192,84" stroke="#334155" stroke-width="1.5" fill="none" marker-end="url(#c15a1)"/>
  <text x="440" y="124" text-anchor="middle" fill="#334155" font-size="10">sees a higher term in any message: step down</text>
  <path d="M440,96 C470,140 410,140 436,98" stroke="#d97706" stroke-width="1.2" fill="none"/>
  <text x="500" y="146" fill="#92400e" font-size="10">split vote: timeout, new term</text>
  <text x="40" y="180" fill="#1e293b" font-size="12" font-weight="bold">Timeline, 5 nodes (S1 leader of term 3 crashes)</text>
  <line x1="120" y1="196" x2="860" y2="196" stroke="#94a3b8"/>
  <text x="40" y="224" fill="#334155" font-size="11" font-weight="bold">S1</text>
  <rect x="120" y="210" width="200" height="22" fill="#dcfce7" stroke="#16a34a"/><text x="220" y="225" text-anchor="middle" fill="#15803d" font-size="10">leader, term 3</text>
  <text x="340" y="225" fill="#dc2626" font-size="10" font-weight="bold">CRASH</text>
  <text x="40" y="256" fill="#334155" font-size="11" font-weight="bold">S2</text>
  <rect x="120" y="242" width="250" height="22" fill="#dbeafe" stroke="#2563eb"/><text x="245" y="257" text-anchor="middle" fill="#1e40af" font-size="10">follower, term 3 (timeout 1.3 s)</text>
  <rect x="372" y="242" width="58" height="22" fill="#fef3c7" stroke="#d97706"/><text x="401" y="257" text-anchor="middle" fill="#78350f" font-size="9">cand t4</text>
  <rect x="432" y="242" width="428" height="22" fill="#dcfce7" stroke="#16a34a"/><text x="646" y="257" text-anchor="middle" fill="#15803d" font-size="10">leader, term 4 (appends a no-op to commit prior entries)</text>
  <text x="40" y="288" fill="#334155" font-size="11" font-weight="bold">S3</text>
  <rect x="120" y="274" width="740" height="22" fill="#dbeafe" stroke="#2563eb"/><text x="330" y="289" text-anchor="middle" fill="#1e40af" font-size="10">follower: votes for S2 in term 4 (S2's log is at least as up-to-date)</text>
  <text x="40" y="320" fill="#334155" font-size="11" font-weight="bold">S4</text>
  <rect x="120" y="306" width="740" height="22" fill="#dbeafe" stroke="#2563eb"/><text x="330" y="321" text-anchor="middle" fill="#1e40af" font-size="10">follower: votes for S2 in term 4</text>
  <text x="40" y="352" fill="#334155" font-size="11" font-weight="bold">S5</text>
  <rect x="120" y="338" width="740" height="22" fill="#dbeafe" stroke="#2563eb"/><text x="330" y="353" text-anchor="middle" fill="#1e40af" font-size="10">follower: its timer (1.7 s) had not fired yet; accepts S2's heartbeat</text>
  <line x1="340" y1="200" x2="340" y2="366" stroke="#dc2626" stroke-dasharray="3 3"/>
  <line x1="432" y1="200" x2="432" y2="366" stroke="#16a34a" stroke-dasharray="3 3"/>
  <text x="386" y="380" text-anchor="middle" fill="#334155" font-size="10">unavailable for writes: about the election timeout</text>
  <rect x="40" y="396" width="820" height="72" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="56" y="416" fill="#1e293b" font-size="11" font-weight="bold">Vote rule (why the new leader has every committed entry)</text>
  <text x="56" y="436" fill="#334155" font-size="11">Grant a vote only if: not yet voted this term, AND candidate's (lastLogTerm, lastLogIndex) is at least mine (term compared first).</text>
  <text x="56" y="456" fill="#334155" font-size="11">currentTerm and votedFor are fsynced BEFORE replying; otherwise a restarted node could vote twice in one term.</text>
</svg>
```

### Log replication and the commit rule

The leader appends each client command to its log and sends `AppendEntries(term, prevLogIndex, prevLogTerm, entries[], leaderCommit)` to every follower. The **consistency check** is the heart of Raft: a follower accepts only if its own log has an entry at `prevLogIndex` whose term equals `prevLogTerm`. If not, it rejects; the leader decrements that follower's `nextIndex` and retries further back until the logs match, and the follower then deletes any conflicting suffix and appends the leader's entries. This guarantees the **Log Matching Property**: if two logs contain an entry with the same index and term, the logs are identical up to that index.

The leader tracks each follower's `matchIndex`. An entry at index N is **committed** when a majority has `matchIndex ≥ N` *and* the entry at N is from the leader's **current term**. That last condition is subtle and famous (Figure 8 in the Raft paper): an entry from an earlier term that is on a majority can still be overwritten by a future leader, so a leader never counts replicas to commit old-term entries directly. They become committed indirectly once an entry from the current term, stacked on top, is committed. That's why a new leader immediately appends a **no-op** entry: it commits everything before it.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Log replication: consistency check, repair, and commit index (leader term 5)</text>
  <text x="130" y="50" text-anchor="middle" fill="#334155" font-size="10">index</text>
  <text x="190" y="50" text-anchor="middle" fill="#334155" font-size="10">1</text>
  <text x="250" y="50" text-anchor="middle" fill="#334155" font-size="10">2</text>
  <text x="310" y="50" text-anchor="middle" fill="#334155" font-size="10">3</text>
  <text x="370" y="50" text-anchor="middle" fill="#334155" font-size="10">4</text>
  <text x="430" y="50" text-anchor="middle" fill="#334155" font-size="10">5</text>
  <text x="490" y="50" text-anchor="middle" fill="#334155" font-size="10">6</text>
  <text x="550" y="50" text-anchor="middle" fill="#334155" font-size="10">7</text>
  <text x="40" y="78" fill="#15803d" font-size="11" font-weight="bold">Leader</text>
  <rect x="165" y="62" width="50" height="26" fill="#dbeafe" stroke="#2563eb"/><text x="190" y="79" text-anchor="middle" fill="#1e3a8a" font-size="10">t1 x=1</text>
  <rect x="225" y="62" width="50" height="26" fill="#dbeafe" stroke="#2563eb"/><text x="250" y="79" text-anchor="middle" fill="#1e3a8a" font-size="10">t1 y=2</text>
  <rect x="285" y="62" width="50" height="26" fill="#ede9fe" stroke="#7c3aed"/><text x="310" y="79" text-anchor="middle" fill="#4c1d95" font-size="10">t3 x=3</text>
  <rect x="345" y="62" width="50" height="26" fill="#ede9fe" stroke="#7c3aed"/><text x="370" y="79" text-anchor="middle" fill="#4c1d95" font-size="10">t3 z=0</text>
  <rect x="405" y="62" width="50" height="26" fill="#dcfce7" stroke="#16a34a"/><text x="430" y="79" text-anchor="middle" fill="#14532d" font-size="10">t5 no-op</text>
  <rect x="465" y="62" width="50" height="26" fill="#dcfce7" stroke="#16a34a"/><text x="490" y="79" text-anchor="middle" fill="#14532d" font-size="10">t5 y=9</text>
  <rect x="525" y="62" width="50" height="26" fill="#dcfce7" stroke="#16a34a"/><text x="550" y="79" text-anchor="middle" fill="#14532d" font-size="10">t5 x=4</text>
  <text x="40" y="118" fill="#334155" font-size="11" font-weight="bold">F1</text>
  <rect x="165" y="102" width="50" height="26" fill="#dbeafe" stroke="#2563eb"/><rect x="225" y="102" width="50" height="26" fill="#dbeafe" stroke="#2563eb"/>
  <rect x="285" y="102" width="50" height="26" fill="#ede9fe" stroke="#7c3aed"/><rect x="345" y="102" width="50" height="26" fill="#ede9fe" stroke="#7c3aed"/>
  <rect x="405" y="102" width="50" height="26" fill="#dcfce7" stroke="#16a34a"/><rect x="465" y="102" width="50" height="26" fill="#dcfce7" stroke="#16a34a"/>
  <text x="600" y="119" fill="#15803d" font-size="10">matchIndex = 6</text>
  <text x="40" y="158" fill="#334155" font-size="11" font-weight="bold">F2</text>
  <rect x="165" y="142" width="50" height="26" fill="#dbeafe" stroke="#2563eb"/><rect x="225" y="142" width="50" height="26" fill="#dbeafe" stroke="#2563eb"/>
  <rect x="285" y="142" width="50" height="26" fill="#ede9fe" stroke="#7c3aed"/><rect x="345" y="142" width="50" height="26" fill="#ede9fe" stroke="#7c3aed"/>
  <rect x="405" y="142" width="50" height="26" fill="#dcfce7" stroke="#16a34a"/>
  <text x="600" y="159" fill="#15803d" font-size="10">matchIndex = 5</text>
  <text x="40" y="198" fill="#334155" font-size="11" font-weight="bold">F3</text>
  <rect x="165" y="182" width="50" height="26" fill="#dbeafe" stroke="#2563eb"/><rect x="225" y="182" width="50" height="26" fill="#dbeafe" stroke="#2563eb"/>
  <rect x="285" y="182" width="50" height="26" fill="#fee2e2" stroke="#dc2626"/><text x="310" y="199" text-anchor="middle" fill="#7f1d1d" font-size="10">t2 q=7</text>
  <rect x="345" y="182" width="50" height="26" fill="#fee2e2" stroke="#dc2626"/><text x="370" y="199" text-anchor="middle" fill="#7f1d1d" font-size="10">t2 q=8</text>
  <text x="600" y="192" fill="#b91c1c" font-size="10">diverged: entries from a term-2</text>
  <text x="600" y="206" fill="#b91c1c" font-size="10">leader that never committed</text>
  <text x="40" y="238" fill="#334155" font-size="11" font-weight="bold">F4</text>
  <rect x="165" y="222" width="50" height="26" fill="#dbeafe" stroke="#2563eb"/><rect x="225" y="222" width="50" height="26" fill="#dbeafe" stroke="#2563eb"/>
  <text x="600" y="239" fill="#92400e" font-size="10">lagging (was down)</text>
  <rect x="160" y="56" width="360" height="160" fill="none" stroke="#16a34a" stroke-width="2" stroke-dasharray="6 3"/>
  <text x="340" y="274" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">commitIndex = 5: index 5 (term 5) is on Leader, F1, F2 = 3 of 5, so entries 1-5 are committed</text>
  <text x="340" y="292" text-anchor="middle" fill="#334155" font-size="10">index 6 is on 2 of 5: not yet committed; clients writing y=9 are still waiting</text>
  <rect x="20" y="308" width="410" height="150" rx="10" fill="#fee2e2" stroke="#dc2626"/>
  <text x="225" y="330" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Repairing F3 (consistency check)</text>
  <text x="36" y="352" fill="#7f1d1d" font-size="10">AppendEntries(prevLogIndex=4, prevLogTerm=3): F3 has t2 at 4, REJECT</text>
  <text x="36" y="370" fill="#7f1d1d" font-size="10">leader decrements nextIndex[F3]; retries with prev=(3, t3): REJECT</text>
  <text x="36" y="388" fill="#7f1d1d" font-size="10">retries with prev=(2, t1): match, ACCEPT</text>
  <text x="36" y="406" fill="#7f1d1d" font-size="10">F3 deletes indexes 3-4 (t2, never committed) and appends</text>
  <text x="36" y="424" fill="#7f1d1d" font-size="10">the leader's entries 3-7</text>
  <text x="36" y="446" fill="#991b1b" font-size="10" font-weight="bold">Only uncommitted entries can ever be overwritten.</text>
  <rect x="450" y="308" width="410" height="150" rx="10" fill="#dcfce7" stroke="#16a34a"/>
  <text x="655" y="330" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Commit rule (current-term entries only)</text>
  <text x="466" y="352" fill="#14532d" font-size="10">N is committed if matchIndex is at least N on a majority</text>
  <text x="466" y="370" fill="#14532d" font-size="10">AND log[N].term == currentTerm</text>
  <text x="466" y="392" fill="#14532d" font-size="10">term-3 entries 3-4 were on a majority before term 5,</text>
  <text x="466" y="410" fill="#14532d" font-size="10">but become committed only via the term-5 no-op at 5</text>
  <text x="466" y="432" fill="#14532d" font-size="10">followers learn commitIndex from leaderCommit</text>
  <text x="466" y="448" fill="#15803d" font-size="10" font-weight="bold">and apply entries 1..commitIndex in order.</text>
</svg>
```

### What consensus cannot do

- **Guarantee progress in all conditions.** The FLP result (Fischer, Lynch, Paterson, 1985) shows no deterministic algorithm can guarantee consensus terminates in a fully asynchronous system if even one process may crash. Raft is always **safe** and is **live** only when the network is well-behaved enough for an election to finish — in practice, randomised timeouts make this the normal case.
- **Tolerate lying nodes.** Raft and Paxos assume crash faults. Byzantine (malicious or corrupted) nodes need BFT protocols with 3f + 1 members.
- **Scale writes.** Every write goes through one leader and waits for a majority. Systems scale by running *many* consensus groups — one per range (CockroachDB), per Region (TiKV), per partition (Kafka's partitions use ISR, but KRaft for metadata) — not by making one group bigger.
- **Make reads linearizable for free.** A leader that has been partitioned away may still *think* it is leader. Linearizable reads need either a quorum round (Raft's **ReadIndex**: confirm leadership with a heartbeat round, then serve once the applied index reaches the commit index recorded at read time) or a **lease** that assumes bounded clock drift.

## 4. Architecture & Workflow

### Failure detection and timeouts

Consensus systems detect failure with heartbeats and timeouts, and the timeout is always a trade-off. Raft's rule of thumb is *broadcastTime ≪ electionTimeout ≪ MTBF*: heartbeats round-trip in a millisecond or so within a datacenter, elections should fire after several missed heartbeats, and failures are rare. Too short, and a GC pause, a slow fsync or a brief network hiccup triggers an unnecessary election — each one a small write outage and a term bump. Too long, and a real failure means seconds of unavailability. Cassandra and Akka use the **phi accrual** detector instead of a fixed timeout: it outputs a suspicion level from the observed distribution of heartbeat intervals, adapting to noisy networks.

Two extensions matter in production. **PreVote** has a would-be candidate first ask "would you vote for me?" without incrementing its term, so a node returning from a partition with an inflated term can't disrupt a healthy leader. **CheckQuorum** makes a leader step down on its own if it hasn't heard from a majority within an election timeout — the leader-side mirror of followers timing out. etcd supports both.

### Split brain, epochs and fencing

Inside a Raft group, split brain can't cause divergent *commits*: an old leader cut off in the minority can't reach a majority, so nothing it appends commits, and its uncommitted suffix is overwritten when it rejoins. But systems built *on* consensus act on the outside world — a PostgreSQL primary accepting writes, a job scheduler charging cards, a process writing files to object storage. An old leader that was paused for 30 seconds wakes up, still believes it is leader, and acts before it learns otherwise. The defence is **fencing**: every leader carries its term/epoch (or its lease revision), every action on the protected resource carries that token, and the resource rejects tokens lower than the highest it has seen.

```svg
<svg viewBox="0 0 880 460" width="100%" height="460" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c15c1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="c15c2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Patroni: PostgreSQL replication + consensus borrowed from etcd, with fencing</text>
  <rect x="330" y="44" width="220" height="92" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="440" y="64" text-anchor="middle" fill="#5b21b6" font-weight="bold">etcd (3 members, Raft)</text>
  <text x="440" y="84" text-anchor="middle" fill="#4c1d95" font-size="10">/service/pg/leader = node-a</text>
  <text x="440" y="100" text-anchor="middle" fill="#4c1d95" font-size="10">TTL 30 s, renewed every loop (10 s)</text>
  <text x="440" y="116" text-anchor="middle" fill="#4c1d95" font-size="10">acquire = compare-and-set (atomic)</text>
  <rect x="30" y="170" width="240" height="120" rx="10" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="150" y="190" text-anchor="middle" fill="#b91c1c" font-weight="bold">node-a (old primary, TL 7)</text>
  <text x="44" y="210" fill="#7f1d1d" font-size="10">partitioned from etcd</text>
  <text x="44" y="226" fill="#7f1d1d" font-size="10">cannot renew leader key</text>
  <text x="44" y="242" fill="#7f1d1d" font-size="10">Patroni demotes PostgreSQL to</text>
  <text x="44" y="258" fill="#7f1d1d" font-size="10">read-only before TTL expires</text>
  <text x="44" y="278" fill="#b91c1c" font-size="10" font-weight="bold">watchdog reboots it if Patroni hangs</text>
  <rect x="610" y="170" width="240" height="120" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="730" y="190" text-anchor="middle" fill="#15803d" font-weight="bold">node-b (replica, promoted)</text>
  <text x="624" y="210" fill="#14532d" font-size="10">sees leader key expired</text>
  <text x="624" y="226" fill="#14532d" font-size="10">healthiest replica within</text>
  <text x="624" y="242" fill="#14532d" font-size="10">maximum_lag_on_failover wins CAS</text>
  <text x="624" y="258" fill="#14532d" font-size="10">pg_promote(): timeline 7 to 8</text>
  <text x="624" y="278" fill="#15803d" font-size="10" font-weight="bold">writes resume on node-b</text>
  <path d="M270,196 L326,120" stroke="#dc2626" stroke-width="2" stroke-dasharray="5 4"/>
  <text x="250" y="150" fill="#b91c1c" font-size="10">renew fails</text>
  <path d="M606,196 L552,120" stroke="#2563eb" stroke-width="2" marker-end="url(#c15c1)"/>
  <text x="600" y="150" fill="#1e40af" font-size="10">CAS leader key</text>
  <rect x="30" y="310" width="820" height="136" rx="10" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="440" y="332" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="bold">Fencing for work driven by a leader (billing job elected via etcd)</text>
  <rect x="50" y="346" width="190" height="40" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="145" y="362" text-anchor="middle" fill="#7f1d1d" font-size="10">worker-1 paused 40 s (GC)</text>
  <text x="145" y="378" text-anchor="middle" fill="#7f1d1d" font-size="10">holds token 41 (stale)</text>
  <rect x="50" y="394" width="190" height="40" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="145" y="410" text-anchor="middle" fill="#14532d" font-size="10">worker-2 elected after lease</text>
  <text x="145" y="426" text-anchor="middle" fill="#14532d" font-size="10">expiry: token 42</text>
  <rect x="560" y="360" width="270" height="60" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="695" y="380" text-anchor="middle" fill="#1e40af" font-size="10" font-weight="bold">PostgreSQL: fence(resource, token)</text>
  <text x="695" y="396" text-anchor="middle" fill="#1e3a8a" font-size="10">UPDATE ... WHERE token &lt;= $mine</text>
  <text x="695" y="410" text-anchor="middle" fill="#1e3a8a" font-size="10">in the same txn as the work</text>
  <path d="M242,414 L556,396" stroke="#16a34a" stroke-width="2" marker-end="url(#c15c1)"/>
  <text x="400" y="420" fill="#15803d" font-size="10">token 42: accepted, fence = 42</text>
  <path d="M242,362 L556,378" stroke="#dc2626" stroke-width="2" marker-end="url(#c15c2)"/>
  <text x="380" y="358" fill="#b91c1c" font-size="10">token 41 later: 0 rows, rejected</text>
</svg>
```

### Consensus vs replication: why PostgreSQL needs Patroni

PostgreSQL streaming replication ships WAL from one primary to standbys ([Ch 09 · Replication](topic.html?p=09-replication)). It *looks* like Raft's log replication — a leader, an ordered log, followers applying it — but it lacks everything that makes Raft a consensus protocol:

| Property | Raft | PostgreSQL streaming replication |
|---|---|---|
| Who is leader? | Elected by majority vote, per term | Whoever is not in recovery; set by an operator or tool |
| Can two leaders exist? | Not in the same term; old leader can't commit | Yes: promote a standby while the old primary runs = split brain |
| Commit rule | Majority has the entry | Local WAL flush (async), or K named standbys acknowledge (sync) |
| Epoch | Term, checked on every message | Timeline ID increments on promotion, but nothing stops the old primary from continuing on the old timeline |
| Divergent follower repair | Automatic: consistency check truncates uncommitted suffix | Manual: `pg_rewind` the old primary before it rejoins |
| Membership changes | Protocol-managed (joint consensus / single-server changes) | Configuration files and restarts |

Synchronous replication with `synchronous_standby_names = 'ANY 1 (s1, s2)'` gives you the *durability* half of a quorum (a commit exists on at least two nodes), but not the *election* half: nothing guarantees the promoted node is one that has the commit, and nothing stops two primaries. So **Patroni** (or Stolon, or pg_auto_failover's monitor, or a cloud control plane) supplies the missing half by storing a leader key in a consensus store and letting only the key holder run as primary. The consensus is borrowed; PostgreSQL itself stays a simple, fast log shipper. With `synchronous_mode: true`, Patroni also records which standby is synchronous in etcd and only promotes that one, closing the "promoted a node that lacks acknowledged commits" gap.

> **MySQL difference:** Classic MySQL async and semi-sync replication are, like PostgreSQL's, replication without consensus; failover tools (Orchestrator, MHA, cloud control planes) decide the new primary. **MySQL Group Replication** (the basis of InnoDB Cluster) is different: it runs a Paxos-based group communication protocol, so a transaction commits only after a majority of members agree on its order, and a member in a minority partition can't commit. Galera (MariaDB/Percona XtraDB Cluster) uses a certification-based group protocol with similar majority semantics.

## 5. Implementation

### Simple example: inspecting a Raft cluster

```bash
# 3-node etcd cluster (docker compose), then:
etcdctl --endpoints=etcd1:2379,etcd2:2379,etcd3:2379 endpoint status -w table
```

```text
+------------+------------------+---------+---------+-----------+-----------+------------+
|  ENDPOINT  |        ID        | VERSION | DB SIZE | IS LEADER | RAFT TERM | RAFT INDEX |
+------------+------------------+---------+---------+-----------+-----------+------------+
| etcd1:2379 | 8e9e05c52164694d |  3.5.x  |  25 kB  |   true    |         4 |        112 |
| etcd2:2379 | 91bc3c398fb3c146 |  3.5.x  |  25 kB  |   false   |         4 |        112 |
| etcd3:2379 | fd422379fda50e48 |  3.5.x  |  25 kB  |   false   |         4 |        112 |
+------------+------------------+---------+---------+-----------+-----------+------------+
```

(Some columns trimmed.) Now stop the leader and watch the term:

```bash
docker stop etcd1
etcdctl --endpoints=etcd2:2379,etcd3:2379 endpoint status -w table   # new leader, RAFT TERM 5
docker stop etcd2                                                    # 1 of 3 left: no quorum
etcdctl --endpoints=etcd3:2379 --command-timeout=3s put k v          # Error: context deadline exceeded
```

A tiny model of the commit rule, useful for interviews and for reasoning about metrics:

```python
def commit_index(leader_term: int, log_terms: list[int], match_index: dict[str, int],
                 leader_last: int, current_commit: int) -> int:
    """log_terms[i-1] is the term of entry i. match_index excludes the leader itself."""
    n_voters = len(match_index) + 1
    majority = n_voters // 2 + 1
    for n in range(leader_last, current_commit, -1):           # highest candidate first
        replicas = 1 + sum(1 for m in match_index.values() if m >= n)
        if replicas >= majority and log_terms[n - 1] == leader_term:
            return n                                            # commits everything <= n
    return current_commit

# The state in the diagram above: leader term 5, entries 1..7
terms = [1, 1, 3, 3, 5, 5, 5]
print(commit_index(5, terms, {"F1": 6, "F2": 5, "F3": 2, "F4": 2}, 7, 2))   # -> 5
```

### Real-world example: leader election with fencing on etcd + PostgreSQL

A billing worker fleet must run exactly one active scheduler. The election uses etcd; the fencing check lives in PostgreSQL, next to the data the leader changes.

```sql
CREATE TABLE fence (
  resource text PRIMARY KEY,
  token    bigint NOT NULL
);
INSERT INTO fence VALUES ('billing-scheduler', 0);
```

```go
package leader

import (
	"context"
	"database/sql"
	"errors"
	"log"

	clientv3 "go.etcd.io/etcd/client/v3"
	"go.etcd.io/etcd/client/v3/concurrency"
)

var ErrFenced = errors.New("fenced: a newer leader exists")

// Run campaigns for leadership and runs work(token) while leader. The token is the
// revision at which our leader key was created: strictly increasing across leaders.
func Run(ctx context.Context, cli *clientv3.Client, db *sql.DB, id string,
	work func(ctx context.Context, token int64) error) error {

	sess, err := concurrency.NewSession(cli, concurrency.WithTTL(10)) // lease: 10 s
	if err != nil {
		return err
	}
	defer sess.Close()

	e := concurrency.NewElection(sess, "/elections/billing-scheduler")
	if err := e.Campaign(ctx, id); err != nil { // blocks until we are leader
		return err
	}
	token := e.Rev()
	log.Printf("%s is leader with token %d", id, token)

	leaderCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() { // lease lost (partition, pause): stop acting as soon as we notice
		<-sess.Done()
		cancel()
	}()
	return work(leaderCtx, token)
}

// ChargeBatch is an example of leader-only work. The fence check and the effect
// commit in ONE transaction, so a deposed leader's write is rejected by the database
// even if the leader has not yet noticed it lost the lease.
func ChargeBatch(ctx context.Context, db *sql.DB, token int64, batchID int64) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	res, err := tx.ExecContext(ctx,
		`UPDATE fence SET token = $1 WHERE resource = 'billing-scheduler' AND token <= $1`, token)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrFenced // someone with a higher token already acted
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE invoices SET status = 'charging' WHERE batch_id = $1 AND status = 'due'`, batchID); err != nil {
		return err
	}
	return tx.Commit()
}
```

The row lock taken by `UPDATE fence` also serialises a stale leader against the new one: whichever commits second either sees a higher token and gets zero rows, or is itself the higher token. The lease alone is not enough — a process paused longer than its TTL resumes believing it still leads.

### Patroni configuration that encodes consensus decisions

```yaml
# patroni.yml (excerpt)
scope: pg-main
etcd3:
  hosts: etcd1:2379,etcd2:2379,etcd3:2379
bootstrap:
  dcs:
    ttl: 30                       # leader key lifetime
    loop_wait: 10                 # HA loop period: renew / check
    retry_timeout: 10             # DCS and PostgreSQL operation retries
    maximum_lag_on_failover: 1048576   # bytes; more-lagged replicas won't be promoted
    synchronous_mode: true        # only a known-synchronous standby may be promoted
watchdog:
  mode: required                  # refuse to be leader without a working watchdog
  device: /dev/watchdog
  safety_margin: 5
```

```text
$ patronictl -c patroni.yml list
+ Cluster: pg-main ----+--------------+-----------+----+-----------+
| Member | Host        | Role         | State     | TL | Lag in MB |
+--------+-------------+--------------+-----------+----+-----------+
| node-a | 10.0.1.11   | Leader       | running   |  7 |           |
| node-b | 10.0.2.12   | Sync Standby | streaming |  7 |         0 |
| node-c | 10.0.3.13   | Replica      | streaming |  7 |         0 |
+--------+-------------+--------------+-----------+----+-----------+
```

The timing math matters: the leader must *demote itself* before its key can be taken over. With `ttl: 30` and `loop_wait: 10`, the leader has several chances to renew and notices a failed renewal well before expiry; the watchdog guarantees that a hung Patroni process can't leave PostgreSQL running as primary past the TTL.

## 6. Advantages, Disadvantages & Trade-offs

| Decision | Option A | Option B | Choose A when |
|---|---|---|---|
| Cluster size | 3 voters | 5 voters | You can tolerate one failure at a time and want lower write latency |
| Placement | One member per AZ/site | All in one AZ | You need to survive a zone failure |
| Election timeout | Short (~1 s) | Long (5-10 s) | Network and disks are consistently fast; failover speed matters |
| Reads | Linearizable (ReadIndex) | Serializable/local | Readers act on the value (locks, config); correctness over latency |
| Postgres HA | Patroni + etcd | Manual failover | You need automated failover without split brain |
| Scaling | Many small groups (per range) | One big group | Throughput must grow beyond one leader |

**Advantages**
- Exactly-one-leader and no divergent commits despite crashes and partitions.
- Automatic failover in roughly an election timeout, without human judgement.
- A replicated log gives a linearizable, totally ordered history — the basis for coordination services and distributed SQL.

**Disadvantages**
- Every write costs a majority round trip plus an fsync on each voter.
- The minority side is unavailable during partitions (CP, see [Ch 14 · CAP Theorem](topic.html?p=14-cap-theorem)).
- Throughput is bounded by a single leader per group.
- Operationally sensitive to disk latency (fsync of the log) and to timeout tuning.

### When to use
- Leader election, locks and leases for anything where two leaders cause damage.
- Cluster metadata and configuration (Kubernetes, Kafka KRaft, Patroni DCS).
- Strongly consistent replicated data where losing an acknowledged write is unacceptable (distributed SQL ranges).

### When NOT to use
- High-volume data where eventual consistency is fine — use leaderless or async replication.
- As a general database: etcd is designed for small, critical data (its default storage quota is a few GB), not for application tables.
- Writing your own Raft for a product feature. Use etcd, ZooKeeper or Consul, or a database that embeds it.

## 7. Common Mistakes & Best Practices

- **Even-sized clusters.** Four members tolerate one failure, the same as three, with a larger quorum. *Instead:* 3 or 5 voters; add non-voting learners/observers for read scaling.
- **All members in one failure domain.** A rack or AZ failure takes the quorum with it. *Instead:* spread voters across at least three zones, or add a tie-breaker in a third site.
- **Slow disks under etcd.** Every Raft write waits for fsync; a noisy-neighbour disk causes missed heartbeats and elections. *Instead:* dedicated low-latency SSDs; watch `etcd_disk_wal_fsync_duration_seconds`.
- **Election timeouts shorter than GC pauses or fsync spikes.** Constant leader churn. *Instead:* measure p99 heartbeat and fsync latency and set the election timeout well above them.
- **Leader election without fencing.** A paused leader acts after losing its lease. *Instead:* pass the term/lease revision to every protected resource and reject stale tokens.
- **Believing synchronous replication equals consensus.** Sync standbys protect durability, not leadership. *Instead:* pair them with a consensus-backed failover manager, and let it promote only a synchronous standby.
- **Local reads from a "leader" for correctness-critical decisions.** A deposed leader serves stale data. *Instead:* linearizable reads (ReadIndex / quorum reads) for anything that decides an action.
- **Removing members by deleting VMs.** The cluster still counts them toward quorum. *Instead:* `etcdctl member remove` first, one change at a time; add new members as learners and promote them once caught up.
- **Best practice:** treat the consensus cluster as tier-0 infrastructure — its own disks, its own alerts, rehearsed quorum-loss recovery, and backups (`etcdctl snapshot save`).

## 8. Production: Failure Scenarios, Monitoring & Scaling

**Failure scenario: elections every few minutes.** Kubernetes API latency spikes periodically; etcd logs show `leader changed` repeatedly. `etcd_disk_wal_fsync_duration_seconds` p99 is 400 ms because etcd shares a disk with a logging agent. Root cause: slow fsync delays heartbeats past the election timeout. Fix: dedicated SSD for the etcd data directory, then confirm `etcd_server_leader_changes_seen_total` flattens.

**Failure scenario: Patroni failover lost acknowledged commits.** After a primary host failure, a few seconds of orders are missing. Root cause: asynchronous replication; the promoted replica was behind by those commits (within `maximum_lag_on_failover`). Consensus picked a single leader correctly, but durability was async. Fix: `synchronous_mode: true` with at least two standbys so one outage doesn't block commits, accepting the extra commit latency — or explicitly accept the RPO.

**Failure scenario: quorum loss.** Two of three etcd members are lost in a zone failure. The survivor can't elect a leader; Patroni can't renew keys and demotes PostgreSQL to read-only — writes stop cluster-wide even though the database host is healthy. Fix now: restore quorum (bring members back) or, as a last resort, force a new single-member cluster from the survivor's data (`etcd --force-new-cluster`), then re-add members. Prevention: members across three zones; Patroni's DCS failsafe mode (in recent versions) lets a primary that can still see all members keep running when only the DCS is down.

**Failure scenario: two primaries after a manual promote.** An on-call engineer runs `pg_ctl promote` on a replica during a network blip "to restore service"; the old primary was fine and kept accepting writes from half the app fleet. Root cause: bypassing the consensus-backed manager. Fix: reconcile divergent writes, `pg_rewind` the loser, and remove manual promotion from runbooks — use `patronictl switchover/failover`, which goes through the DCS.

**Metrics to watch**
- etcd: `etcd_server_has_leader`, `etcd_server_leader_changes_seen_total`, `etcd_server_proposals_failed_total`, `etcd_disk_wal_fsync_duration_seconds`, `etcd_disk_backend_commit_duration_seconds`, `etcd_network_peer_round_trip_time_seconds`, DB size vs quota.
- Patroni: leader key holder, timeline (`TL`) changes, replica lag, sync standby name.
- Kafka KRaft: active controller count (exactly 1), metadata log commit latency.
- Any Raft system: term changes per hour (should be near zero), commit latency, follower lag in entries.

**Scaling notes.** A consensus group's write throughput is bounded by the leader's disk and network and by the slowest member of the fastest majority. Scale by *sharding the consensus*: one Raft group per range or partition, with leaders spread across nodes (CockroachDB, TiKV, YugabyteDB — see [Ch 16 · Distributed Database Architecture](topic.html?p=16-distributed-database-architecture)). Scale reads with learners/followers serving follower reads at a known timestamp, or ReadIndex reads that confirm leadership with one heartbeat round.

## 9. Interview Questions

**Q: Why can't you implement reliable leader election with just timeouts and heartbeats?**
A: Because every node's view of the others is local and can be wrong. A replica that stops hearing from the primary can't distinguish "primary crashed" from "the network between us is broken but the primary still serves clients". If every node promotes itself on a timeout, two nodes can each conclude they should lead. You need an agreement protocol in which a decision requires votes from a majority, so that at most one candidate can collect enough votes in a given term. Timeouts are still used, but only to *trigger* elections, not to decide them.

**Q: Explain why majority quorums prevent split brain.**
A: Any two majorities of the same N-member group share at least one member, because together they contain more than N members. Each member votes at most once per term and persists that vote, so two candidates can't both collect a majority in the same term. Likewise, a leader needs a majority to commit, so a leader stranded in the minority can't commit anything. Once the network heals, its uncommitted entries are overwritten. The intersection property is the whole safety argument, which is why quorum size matters more than node count.

**Q: How many nodes do you need to tolerate two failures, and why not four for one?**
A: 2f + 1, so five nodes to tolerate two failures, with a quorum of three. Four nodes need a quorum of three and still tolerate only one failure, the same as three nodes, while every write waits for one more acknowledgement. An even count also makes an even network split (2/2) leave no side with a majority. So use odd sizes: three for most systems, five when you need to survive a failure during maintenance.

**Q: Walk through a Raft leader election.**
A: A follower that hears no heartbeat for its randomised election timeout becomes a candidate: it increments its term, votes for itself, persists both, and sends RequestVote with its last log index and term. Each voter grants the vote if it hasn't voted in that term and the candidate's log is at least as up-to-date as its own, comparing last-entry terms first and then indices. A candidate with a majority becomes leader, sends heartbeats, and appends a no-op entry to commit prior entries. If the vote splits, timeouts fire again with new random values and a new term. Any node that sees a higher term steps down.

**Q: What does the AppendEntries consistency check do?**
A: Each AppendEntries carries the index and term of the entry immediately before the new ones. A follower accepts only if its log has an entry at that index with that term. If not, it rejects, and the leader moves that follower's nextIndex back and retries until they agree on a prefix. The follower then deletes any conflicting entries after that point and appends the leader's. This inductively guarantees the Log Matching Property — same index and term implies identical prefixes — and automatically repairs followers that hold uncommitted entries from old leaders.

**Q: When is an entry committed in Raft, and why must it be from the current term?**
A: When the leader has it replicated on a majority and the entry's term equals the leader's current term; all earlier entries are then committed too. An entry from an earlier term that happens to sit on a majority can still be overwritten, because a candidate whose last entry has a higher term can win an election without that entry and then replace it. By only counting replicas for current-term entries, and committing older ones indirectly beneath them, Raft ensures a committed entry is present in every future leader's log. The no-op a new leader appends exists to trigger that indirect commit quickly.

**Q: Is PostgreSQL streaming replication a consensus protocol?**
A: No. It's leader-to-follower log shipping with a fixed leader chosen by configuration. Nothing prevents two primaries: if you promote a standby while the old primary runs, both accept writes. Commit is local (or waits for named synchronous standbys), not majority-based, and there is no term checked on each message; the timeline ID changes on promotion but isn't enforced against the old primary. Divergent history is repaired manually with `pg_rewind`. Tools like Patroni add consensus externally by storing the leader key in etcd, ZooKeeper or Consul and letting only its holder run as primary.

**Q: What is a fencing token and why do you need one if you already have leader election?**
A: It's a monotonically increasing number, such as the Raft term or the revision of the leader's lease key, that the leader attaches to every action on a protected resource. The resource remembers the highest token it has accepted and rejects lower ones. You need it because leadership is only known with a delay: a leader paused by GC or cut off by a partition can resume and act before it learns its lease expired and someone else was elected. Election guarantees one leader per term; fencing makes sure a leader from an old term can't do damage.

**Q: Your etcd cluster keeps changing leaders. How do you debug it? (Senior)**
A: I start with `etcd_server_leader_changes_seen_total` and the logs to confirm the churn and see which member keeps losing leadership. The usual cause is disk: I check `etcd_disk_wal_fsync_duration_seconds` and backend commit duration, since slow fsync delays heartbeats and responses past the election timeout. Next I check the network with `etcd_network_peer_round_trip_time_seconds` and packet loss between zones, then CPU starvation or long pauses on the hosts. Fixes are dedicated SSDs, isolating etcd from noisy neighbours, and raising `--heartbeat-interval` and `--election-timeout` in proportion if cross-zone RTT is inherently high. I'd also make sure PreVote and CheckQuorum are on, so a flapping member returning with a higher term doesn't depose a healthy leader.

**Q: Design automated PostgreSQL failover that never produces two writable primaries. (Senior)**
A: Leadership lives in a consensus store: Patroni with a three-member etcd cluster across three zones. Only the holder of the leader key, acquired by compare-and-set with a TTL, runs as primary. The primary renews the key every loop and demotes itself to read-only if it can't renew before the TTL; a hardware or software watchdog reboots the node if Patroni itself hangs, so demotion is guaranteed. Replicas are promoted only through the DCS, never with a manual `pg_ctl promote`. I enable `synchronous_mode` with at least two standbys so the promoted node has every acknowledged commit, and route clients through something that follows the leader key, such as HAProxy using Patroni's REST health checks or libpq multi-host with `target_session_attrs=read-write`. The old primary rejoins via `pg_rewind`.

**Q: How do distributed SQL databases scale writes if every Raft group has one leader? (Senior)**
A: They run thousands of small Raft groups instead of one big one. CockroachDB splits the keyspace into ranges, each with its own Raft group and a leaseholder, and spreads leaders across nodes so each node leads some ranges and follows others. TiKV does the same with Regions and Multi-Raft. Throughput scales with the number of groups, and each group's commit latency is still one majority round trip. Cross-range transactions then need an atomic commit protocol on top, which these systems run over the replicated groups so the coordinator isn't a single point of failure. The costs are more heartbeats, which get batched or coalesced, and more complex rebalancing of leaders and replicas.

**Q: Kafka uses KRaft for metadata but not majority quorums for partition data. Why? (Senior)**
A: Metadata — controller leadership, topic configs, partition leaders and ISR membership — must be totally ordered and never diverge, so it lives in a Raft-based metadata log replicated to a small controller quorum. Partition data uses a leader with an in-sync replica set: with `acks=all` a write is acknowledged once all current ISR members have it, and `min.insync.replicas` bounds how small the ISR may get. That tolerates ISR size minus one failures with fewer replicas than a majority quorum would need for the same fault tolerance, which matters at data volume. It relies on the controller, a consensus-backed component, to decide ISR membership and leader epochs safely. It's a common pattern: consensus for the small control plane, cheaper replication for the bulk data plane.

## 10. Quick Revision & Cheat Sheet

| Concept | Remember |
|---|---|
| Quorum | ⌊N/2⌋+1; tolerate f failures with 2f+1 voters; odd sizes |
| Term | ≤ 1 leader per term; higher term always wins; persisted with votedFor |
| RequestVote | Grant once per term, only to an at-least-as-up-to-date log |
| AppendEntries | prevLogIndex/prevLogTerm check; repair by backing up nextIndex |
| Commit | Majority has it AND entry term == current term; no-op on election |
| Reads | ReadIndex (quorum-confirmed) or leases (clock assumption) |
| Timeouts | broadcast ≪ election timeout ≪ MTBF; etcd 100 ms / 1000 ms defaults |
| PreVote / CheckQuorum | Stop disruptive rejoiners; leader steps down without a majority |
| Fencing | Pass term/lease revision; resource rejects stale tokens |
| PG replication | Log shipping, not consensus; Patroni borrows consensus from etcd |
| Patroni | Leader key, ttl 30 / loop_wait 10, watchdog, synchronous_mode |
| Scaling | Many Raft groups (ranges/Regions), not bigger groups |

- Consensus = majority decisions + intersecting quorums + terms.
- A minority can't elect or commit; that's the CP choice.
- A new leader always has every committed entry (vote restriction).
- Only uncommitted entries are ever overwritten.
- Leader election without fencing is incomplete.
- Sync replication gives durability; consensus gives leadership. You need both.
- etcd health is disk health: watch fsync latency.

## 11. Hands-On Exercises

1. **Watch an election.** Run 3-node etcd; record `endpoint status` (term, leader). Stop the leader, time how long writes fail, and record the new term. Restart it and confirm it rejoins as follower.
2. **Quorum loss.** Stop two of three members; show that writes and linearizable reads fail and `--consistency=s` reads succeed. Restore one member and verify recovery.
3. **Raft visualisation.** Use the interactive visualisation at raft.github.io to reproduce the "Figure 8" scenario: an old-term entry on a majority overwritten by a new leader. Then verify with the `commit_index` function in §5 why it was never committed.
4. **Fencing.** Implement the Go election + fence example against etcd and `postgres:17`. Simulate a paused leader (`kill -STOP` the process for longer than the TTL, then `kill -CONT`). Show the new leader acts and the old leader's `ChargeBatch` returns `ErrFenced`.
5. **Patroni failover.** Use a Patroni docker-compose lab (3 PostgreSQL + 3 etcd). Run a write loop, kill the primary container, and measure the write gap. Repeat with `synchronous_mode: true` and compare lost writes and commit latency.
6. **Manual split brain (lab only).** Without Patroni, promote a standby while the primary still accepts writes; write to both, then try to reattach the old primary. Use `pg_rewind` and observe which writes are lost.

**Mini project — "Failover you can trust".** Build a three-zone lab (containers labelled by zone): 3 etcd members, Patroni-managed PostgreSQL with one synchronous and one async standby, HAProxy routing via Patroni health checks, and a client that writes sequential ids with idempotency keys. Inject faults — kill the primary, partition the primary's zone, slow the etcd leader's disk with `tc`/`ionice`, lose etcd quorum — and for each produce: time to recover, acknowledged writes lost (target: zero with sync mode), whether two writable primaries ever existed, and the metrics that alerted first.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** [Ch 09 · Replication](topic.html?p=09-replication) · [Ch 14 · CAP Theorem](topic.html?p=14-cap-theorem) · [Ch 13 · Distributed Transactions](topic.html?p=13-distributed-transactions) · [Ch 16 · Distributed Database Architecture](topic.html?p=16-distributed-database-architecture) · [Ch 18 · High Availability](topic.html?p=18-high-availability) · [Ch 07 · Write-Ahead Logging](topic.html?p=07-write-ahead-logging).

**SQL Handbook:** [Transactions & ACID](../sql/topic.html?p=25-transactions-acid) (durability on one node, which consensus extends to many).

**Other handbooks:** [System Design · Consensus](../system-design/topic.html?p=20-consensus) · [Kafka & RabbitMQ · KRaft vs ZooKeeper](../messaging/topic.html?p=19-kraft-zookeeper) · [Kafka & RabbitMQ · Kafka Replication & ISR](../messaging/topic.html?p=17-kafka-replication-isr) · [Kafka & RabbitMQ · RabbitMQ Clustering & Quorum Queues](../messaging/topic.html?p=12-rabbitmq-clustering-quorum) (Raft-based queues) · [Caching with Redis · Distributed Locks & Redlock](../redis-caching/topic.html?p=23-distributed-locks-redlock) · [Cassandra · Gossip & Failure Detection](../cassandra/topic.html?p=20-gossip-failure-detection).

- **In Search of an Understandable Consensus Algorithm (Raft)** — Ongaro & Ousterhout, USENIX ATC 2014 · *Intermediate* · the Raft paper; read sections 5.1–5.4 and Figure 8. <https://raft.github.io/raft.pdf>
- **The Raft Consensus Algorithm** — raft.github.io · *Beginner* · interactive visualisation and a list of implementations. <https://raft.github.io/>
- **etcd documentation: tuning and FAQ** — etcd.io · *Intermediate* · heartbeat/election timeouts, disk requirements, cluster sizing. <https://etcd.io/docs/v3.5/tuning/>
- **Patroni documentation** — Patroni · *Intermediate* · DCS leader key, watchdog, synchronous mode, failsafe mode. <https://patroni.readthedocs.io/en/latest/>
- **How to do distributed locking** — Martin Kleppmann · *Intermediate* · why leases need fencing tokens. <https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html>
- **Paxos Made Simple** — Leslie Lamport, 2001 · *Advanced* · the classic short Paxos explanation. <https://lamport.azurewebsites.net/pubs/paxos-simple.pdf>
- **Designing Data-Intensive Applications, ch. 8–9** — Martin Kleppmann · *Advanced* · unreliable clocks, fencing, linearizability and consensus. <https://dataintensive.net/>

---

*Database Design Handbook — chapter 15.*
