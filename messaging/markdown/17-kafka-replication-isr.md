# 17 · Replication: ISR, Leader Election & min.insync.replicas

> **In one line:** Kafka survives broker failure by keeping each partition on several brokers, tracking which replicas are genuinely caught up (the in-sync set), and refusing to acknowledge a write until enough of them hold it — so durability is not a switch you flip but a contract between `acks`, `min.insync.replicas` and the ISR that you must set on both sides.

---

## 1. Overview

A single-broker log is a single point of failure: lose the disk, lose the data; restart the broker, and every producer and consumer stalls. Kafka's answer is **replication** — each partition is stored on more than one broker, so the loss of a broker is a survivable event rather than a data-loss event. This chapter is about the machinery that makes that true, and about the fact that it is *only* true if you configure it correctly. Replication that is switched on but misconfigured gives you the operational cost of three copies with the durability of one.

The mechanism has three moving parts that must be understood together. First, **the replica set**: a partition has a `replication.factor` of, say, 3, meaning three brokers each hold a copy — one **leader** that handles all reads and writes, and two **followers** that continuously fetch from the leader to stay current. Second, the **in-sync replica set (ISR)**: the subset of replicas that are actually caught up with the leader right now. A follower that falls behind — because its broker is slow, GC-paused, or partitioned from the leader — is *removed* from the ISR, because a copy that is behind is not a copy you can safely fail over to. Third, the **durability contract**: the producer's `acks` setting and the topic's `min.insync.replicas` together decide how many in-sync copies must hold a record before the write is acknowledged. Set them right — `acks=all`, `min.insync.replicas=2`, `replication.factor=3` — and a write is confirmed only once two brokers have it, so a single broker failure never loses acknowledged data.

The subtle, load-bearing concept that ties it together is the **high watermark**: consumers can only see records that have been replicated to *all* members of the ISR. An un-replicated record at the tail of the leader's log is invisible until it is safely on every in-sync follower, which is precisely what prevents a consumer from reading a record that a subsequent leader failover would erase. And the sharpest configuration decision in all of Kafka lives here too — **unclean leader election** — the choice, when every in-sync replica is gone, between electing a stale out-of-sync replica (staying available but *losing committed data*) or refusing to elect one (staying durable but *unavailable* until an in-sync replica returns). That single boolean is the availability-versus-durability trade made concrete.

## 2. Core Concepts

- **Replica** — one copy of a partition's log on one broker. `replication.factor=N` means N brokers each hold the full partition.
- **Leader** — the one replica that serves all produce and consume traffic for a partition. Every partition has exactly one leader at a time.
- **Follower** — a non-leader replica. It does nothing but continuously **fetch** records from the leader to stay current; it never serves clients (with the exception of follower fetching for rack-locality reads, KIP-392, which is opt-in).
- **ISR (in-sync replica set)** — the replicas, including the leader, that are caught up with the leader within `replica.lag.time.max.ms`. Membership is dynamic: replicas fall out when they lag and rejoin when they catch up.
- **`replica.lag.time.max.ms`** — how long a follower may fail to fetch up to the leader's log end before it is ejected from the ISR (default 30s).
- **High watermark (HW)** — the highest offset replicated to *all* ISR members. Only records below the HW are **committed** and visible to consumers.
- **Log end offset (LEO)** — the offset of the next record to be written to a replica's log; the leader's LEO is ahead of the HW by exactly the un-fully-replicated tail.
- **`acks`** — the producer's durability request: `0` (fire-and-forget), `1` (leader only), `all`/`-1` (all in-sync replicas).
- **`min.insync.replicas`** — the topic/broker floor: with `acks=all`, at least this many replicas must be in-sync and acknowledge, or the produce fails.
- **Controller** — the broker responsible for cluster metadata and for electing a new partition leader when one fails (chapter 19 covers who the controller is under KRaft).
- **Unclean leader election** — electing an out-of-sync replica as leader when no in-sync replica is available; trades durability for availability.
- **Preferred leader** — the first replica in a partition's assigned replica list; Kafka tries to keep leadership here to balance load.

## 3. Theory & Principles

### Why not just "keep three copies"?

The naive model of replication is "write to three brokers, done". It fails because brokers are not equally healthy at every instant. One follower is mid garbage-collection; another's disk is briefly saturated; a third is on the far side of a flaky network link. If you wait for *all three* copies on every write, your latency is hostage to the slowest replica at all times, and a single sick broker halts all writes. If you wait for *none* of them beyond the leader, a leader crash loses whatever the followers had not yet fetched. Kafka's design threads this needle with the **in-sync set**: it defines, dynamically, *which* replicas are currently trustworthy, and requires acknowledgement only from those — not from all replicas, and not from the leader alone.

A replica is "in sync" if it has fetched up to the leader's log end recently — specifically within `replica.lag.time.max.ms`. Note that this is a *time* bound, not a *message-count* bound. Older Kafka used `replica.lag.max.messages`, which was a trap: a legitimate burst of traffic could push a perfectly healthy follower more than N messages behind the leader for a moment, ejecting it spuriously. The time-based definition asks the right question — "is this follower making progress and keeping up?" — rather than "is it within some absolute message distance", which depends on the producer's rate rather than the follower's health.

### The durability contract is a conjunction

The single most important thing to understand is that durability is the **conjunction** of three settings, and any one of them left slack undoes the others:

- `replication.factor=3` — three physical copies exist. Necessary but not sufficient: three copies help nothing if the write is acked before the followers have it.
- `acks=all` — the producer waits for the *in-sync* replicas to confirm. But "all in-sync" can be as few as one replica if the other two have fallen out of the ISR — so `acks=all` *alone* still permits a single-copy write.
- `min.insync.replicas=2` — the floor. With `acks=all`, if fewer than 2 replicas are in-sync, the broker rejects the write with `NotEnoughReplicas` rather than accepting a write that only one broker holds.

Put together with RF=3: a write is acknowledged only when **at least two brokers** hold it. That is the whole game. Now reason about failure. One broker dies: two in-sync replicas remain, `min.insync.replicas=2` is satisfied, writes continue, and every acknowledged record survives because it was on at least two brokers and only one died. A *second* broker dies: only one in-sync replica remains, the floor of 2 is not met, and producers with `acks=all` now get errors — Kafka **refuses to accept writes it cannot make durable** rather than silently degrading to single-copy writes that the next failure would lose. That refusal is the contract working as designed: it converts a would-be silent data-loss window into a loud, visible unavailability that pages you.

### The high watermark: what consumers are allowed to see

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Leader, followers, ISR and the high watermark</text>

  <rect x="30" y="46" width="500" height="118" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="52" y="68" fill="#1e40af" font-size="12" font-weight="bold">LEADER (broker 1)</text>
  <g font-size="9">
    <rect x="52" y="80" width="34" height="26" fill="#fff" stroke="#2563eb"/><text x="69" y="97" text-anchor="middle" fill="#1e40af">0</text>
    <rect x="86" y="80" width="34" height="26" fill="#fff" stroke="#2563eb"/><text x="103" y="97" text-anchor="middle" fill="#1e40af">1</text>
    <rect x="120" y="80" width="34" height="26" fill="#fff" stroke="#2563eb"/><text x="137" y="97" text-anchor="middle" fill="#1e40af">2</text>
    <rect x="154" y="80" width="34" height="26" fill="#fff" stroke="#2563eb"/><text x="171" y="97" text-anchor="middle" fill="#1e40af">3</text>
    <rect x="188" y="80" width="34" height="26" fill="#dcfce7" stroke="#16a34a"/><text x="205" y="97" text-anchor="middle" fill="#15803d">4</text>
    <rect x="222" y="80" width="34" height="26" fill="#fef3c7" stroke="#d97706"/><text x="239" y="97" text-anchor="middle" fill="#b45309">5</text>
    <rect x="256" y="80" width="34" height="26" fill="#fef3c7" stroke="#d97706"/><text x="273" y="97" text-anchor="middle" fill="#b45309">6</text>
  </g>
  <text x="205" y="126" text-anchor="middle" fill="#15803d" font-size="9">HW = 5 &#8593;</text>
  <text x="273" y="126" text-anchor="middle" fill="#b45309" font-size="9">LEO = 7 &#8593;</text>
  <text x="52" y="150" fill="#1d4ed8" font-size="9">committed: offsets 0&#8211;4 (on ALL ISR) &#183; uncommitted tail: 5&#8211;6</text>

  <rect x="30" y="180" width="240" height="96" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="50" y="202" fill="#15803d" font-size="11" font-weight="bold">FOLLOWER (broker 2)</text>
  <g font-size="9">
    <rect x="50" y="214" width="26" height="24" fill="#fff" stroke="#16a34a"/><text x="63" y="230" text-anchor="middle" fill="#15803d">0</text>
    <rect x="76" y="214" width="26" height="24" fill="#fff" stroke="#16a34a"/><text x="89" y="230" text-anchor="middle" fill="#15803d">1</text>
    <rect x="102" y="214" width="26" height="24" fill="#fff" stroke="#16a34a"/><text x="115" y="230" text-anchor="middle" fill="#15803d">2</text>
    <rect x="128" y="214" width="26" height="24" fill="#fff" stroke="#16a34a"/><text x="141" y="230" text-anchor="middle" fill="#15803d">3</text>
    <rect x="154" y="214" width="26" height="24" fill="#fff" stroke="#16a34a"/><text x="167" y="230" text-anchor="middle" fill="#15803d">4</text>
    <rect x="180" y="214" width="26" height="24" fill="#fff" stroke="#16a34a"/><text x="193" y="230" text-anchor="middle" fill="#15803d">5</text>
  </g>
  <text x="50" y="262" fill="#166534" font-size="9">caught up &#8594; IN SYNC (fetched to offset 5)</text>

  <rect x="290" y="180" width="240" height="96" rx="10" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="310" y="202" fill="#b91c1c" font-size="11" font-weight="bold">FOLLOWER (broker 3)</text>
  <g font-size="9">
    <rect x="310" y="214" width="26" height="24" fill="#fff" stroke="#dc2626"/><text x="323" y="230" text-anchor="middle" fill="#b91c1c">0</text>
    <rect x="336" y="214" width="26" height="24" fill="#fff" stroke="#dc2626"/><text x="349" y="230" text-anchor="middle" fill="#b91c1c">1</text>
    <rect x="362" y="214" width="26" height="24" fill="#fff" stroke="#dc2626"/><text x="375" y="230" text-anchor="middle" fill="#b91c1c">2</text>
  </g>
  <text x="310" y="262" fill="#991b1b" font-size="9">lagging &gt; 30s &#8594; EJECTED from ISR (only at offset 2)</text>

  <rect x="560" y="46" width="292" height="230" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="706" y="68" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">The rules</text>
  <text x="576" y="94" fill="#6d28d9" font-size="10">ISR = { broker 1 (leader), broker 2 }</text>
  <text x="576" y="114" fill="#6d28d9" font-size="10">broker 3 fell &gt; replica.lag.time.max.ms</text>
  <text x="576" y="134" fill="#6d28d9" font-size="10">behind &#8594; not in ISR</text>
  <text x="576" y="160" fill="#5b21b6" font-size="10" font-weight="bold">HW = min LEO across the ISR</text>
  <text x="576" y="178" fill="#6d28d9" font-size="10">= min(7 on ldr not yet, 5 on b2) = 5</text>
  <text x="576" y="204" fill="#5b21b6" font-size="10" font-weight="bold">Consumers see only offsets &lt; HW</text>
  <text x="576" y="222" fill="#6d28d9" font-size="10">offsets 5&#8211;6 are INVISIBLE until</text>
  <text x="576" y="240" fill="#6d28d9" font-size="10">replicated to all ISR members</text>
  <text x="576" y="264" fill="#6d28d9" font-size="10">&#8594; a failover can never erase a</text>

  <rect x="30" y="292" width="822" height="158" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="441" y="314" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Why the HW protects consumers</text>
  <text x="50" y="340" fill="#475569" font-size="10">A record is COMMITTED once it is on every ISR member. The high watermark is the boundary of committed data.</text>
  <text x="50" y="362" fill="#475569" font-size="10">Consumers are only ever handed committed records, so a record a consumer has read is guaranteed to survive any</text>
  <text x="50" y="384" fill="#475569" font-size="10">leader election from within the ISR &#8212; the new leader, being in-sync, also has it.</text>
  <text x="50" y="410" fill="#7c3aed" font-size="10" font-weight="bold">The uncommitted tail (offsets 5&#8211;6) may be lost on failover &#8212; which is exactly why consumers cannot see it.</text>
  <text x="50" y="432" fill="#334155" font-size="10" font-weight="bold">Committed &#8800; acknowledged-to-producer under acks=1; the two align only under acks=all + min.insync.replicas.</text>
</svg>
```

The high watermark is the offset up to which every ISR member has the data. The leader advances it to the minimum log-end-offset across the ISR: a record is committed only once the slowest in-sync follower has it. Consumers are handed records strictly *below* the high watermark. This is not an optimisation — it is a safety property. If a consumer could read the leader's un-replicated tail and the leader then failed, a new leader elected from the ISR (which by definition does not have that tail) would have "un-happened" a record the consumer already acted on. By gating consumer visibility on full-ISR replication, Kafka guarantees that anything a consumer has seen will survive any clean leader election.

## 4. Architecture & Workflow

### The replication data flow and a failover

```svg
<svg viewBox="0 0 880 500" width="100%" height="500" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="r1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="r2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
    <marker id="r3" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">acks=all write path, then a leader failover</text>

  <rect x="24" y="44" width="410" height="220" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="229" y="66" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">1. Normal write (RF=3, min.insync=2)</text>

  <rect x="40" y="82" width="80" height="34" rx="6" fill="#fff" stroke="#2563eb"/><text x="80" y="104" text-anchor="middle" fill="#1e40af" font-size="10" font-weight="bold">producer</text>
  <rect x="200" y="82" width="90" height="34" rx="6" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/><text x="245" y="104" text-anchor="middle" fill="#1e40af" font-size="10" font-weight="bold">LEADER b1</text>
  <rect x="200" y="150" width="90" height="30" rx="6" fill="#dcfce7" stroke="#16a34a"/><text x="245" y="169" text-anchor="middle" fill="#15803d" font-size="9">follower b2</text>
  <rect x="320" y="150" width="90" height="30" rx="6" fill="#dcfce7" stroke="#16a34a"/><text x="365" y="169" text-anchor="middle" fill="#15803d" font-size="9">follower b3</text>

  <path d="M120,96 L196,96" stroke="#2563eb" stroke-width="2" marker-end="url(#r1)"/>
  <text x="158" y="90" text-anchor="middle" fill="#1e40af" font-size="8">1. produce</text>
  <path d="M240,118 L240,148" stroke="#16a34a" stroke-width="2" marker-end="url(#r2)"/>
  <path d="M258,118 L360,148" stroke="#16a34a" stroke-width="2" marker-end="url(#r2)"/>
  <text x="150" y="200" fill="#166534" font-size="9">2. followers FETCH the record from the leader</text>
  <text x="150" y="218" fill="#166534" font-size="9">3. leader sees 2 ISR members hold it &#8594; HW advances</text>
  <path d="M196,110 L124,110" stroke="#2563eb" stroke-width="2" stroke-dasharray="4 3" marker-end="url(#r1)"/>
  <text x="150" y="238" fill="#1e40af" font-size="9" font-weight="bold">4. leader acks producer (min.insync=2 met)</text>
  <text x="40" y="256" fill="#475569" font-size="9">record now on 2 brokers before the producer is told "ok".</text>

  <rect x="446" y="44" width="410" height="220" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="651" y="66" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">2. Leader b1 dies</text>
  <rect x="470" y="88" width="90" height="34" rx="6" fill="#fee2e2" stroke="#dc2626" stroke-width="2" stroke-dasharray="5 3"/><text x="515" y="104" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">b1 DOWN</text><text x="515" y="116" text-anchor="middle" fill="#991b1b" font-size="8">was leader</text>
  <rect x="640" y="82" width="150" height="30" rx="6" fill="#ede9fe" stroke="#7c3aed"/><text x="715" y="101" text-anchor="middle" fill="#5b21b6" font-size="9">controller detects loss</text>
  <path d="M562,100 L636,100" stroke="#dc2626" stroke-width="2" marker-end="url(#r3)"/>
  <rect x="470" y="150" width="90" height="34" rx="6" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/><text x="515" y="167" text-anchor="middle" fill="#1e40af" font-size="9" font-weight="bold">b2 NEW LEADER</text><text x="515" y="179" text-anchor="middle" fill="#1e40af" font-size="8">from ISR</text>
  <rect x="640" y="150" width="90" height="34" rx="6" fill="#dcfce7" stroke="#16a34a"/><text x="685" y="167" text-anchor="middle" fill="#15803d" font-size="9">b3 follower</text><text x="685" y="179" text-anchor="middle" fill="#15803d" font-size="8">fetches b2</text>
  <path d="M685,112 L520,148" stroke="#7c3aed" stroke-width="2" marker-end="url(#r1)"/>
  <text x="470" y="206" fill="#991b1b" font-size="9">controller elects a new leader from the ISR (b2 or b3)</text>
  <text x="470" y="224" fill="#991b1b" font-size="9">b2 had every committed record &#8594; NO committed data lost</text>
  <text x="470" y="244" fill="#b91c1c" font-size="9" font-weight="bold">producers reconnect to b2; consumers resume; HW intact</text>

  <rect x="24" y="284" width="832" height="196" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="306" text-anchor="middle" fill="#334155" font-size="13" font-weight="bold">The decision that defines your cluster: unclean.leader.election.enable</text>

  <rect x="44" y="322" width="390" height="142" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="239" y="344" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">= false (default, durable)</text>
  <text x="60" y="368" fill="#166534" font-size="10">All ISR replicas gone &#8594; partition goes OFFLINE.</text>
  <text x="60" y="388" fill="#166534" font-size="10">Wait for an in-sync replica to return.</text>
  <text x="60" y="408" fill="#166534" font-size="10">No committed record is ever lost.</text>
  <text x="60" y="432" fill="#15803d" font-size="10" font-weight="bold">Choose when correctness &gt; uptime</text>
  <text x="60" y="450" fill="#166534" font-size="10">(payments, ledgers, orders).</text>

  <rect x="446" y="322" width="390" height="142" rx="8" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="641" y="344" text-anchor="middle" fill="#b91c1c" font-size="11" font-weight="bold">= true (available, lossy)</text>
  <text x="462" y="368" fill="#991b1b" font-size="10">All ISR gone &#8594; elect an OUT-OF-SYNC replica.</text>
  <text x="462" y="388" fill="#991b1b" font-size="10">Partition comes back immediately, but that</text>
  <text x="462" y="408" fill="#991b1b" font-size="10">replica is missing records &#8594; committed data LOST.</text>
  <text x="462" y="432" fill="#b91c1c" font-size="10" font-weight="bold">Choose when uptime &gt; correctness</text>
  <text x="462" y="450" fill="#991b1b" font-size="10">(metrics, logs you can afford to gap).</text>
</svg>
```

The workflow, step by step. A producer with `acks=all` sends a record to the partition leader. The leader appends it to its own log (advancing its LEO) but does *not* yet acknowledge. The followers, on their own fetch loop, pull the new record from the leader; each acknowledges its fetch, which tells the leader how far that follower has got. Once enough in-sync replicas — at least `min.insync.replicas` — have the record, the leader advances the high watermark and only *then* sends the acknowledgement to the producer. The record was on multiple brokers before the producer was told "committed", which is the whole point.

Now the leader fails. The controller (chapter 19) notices the broker is gone — its session with the cluster metadata expires — and must elect a new leader for every partition that broker led. For a *clean* election it picks a replica **from the ISR**, which by definition holds every committed record, so nothing committed is lost; producers and consumers transparently reconnect to the new leader. The only records at risk are the uncommitted tail the old leader had not yet fully replicated — and those were never acknowledged to the producer and never visible to consumers, so no promise is broken. The exception is the nightmare case: *every* ISR replica is unavailable. Then Kafka's behaviour is decided entirely by `unclean.leader.election.enable`, the boolean at the bottom of the diagram, which is the availability-versus-durability trade made concrete.

## 5. Implementation

Replication is configured, not coded, on the broker and topic side; the client's contribution is the producer's `acks` and its retry behaviour. Below are the pieces you actually touch.

**Broker defaults (`server.properties`).** These set cluster-wide floors that individual topics inherit unless overridden.

```properties
# server.properties  -- cluster-wide replication defaults

# New topics get 3 replicas unless the create command overrides it.
default.replication.factor=3

# The durability floor for acks=all producers: at least 2 replicas must be
# in-sync and acknowledge, or the produce is rejected. Set this to 2 for RF=3;
# it tolerates the loss of exactly one broker while still refusing single-copy
# writes.
min.insync.replicas=2

# How long a follower may fail to catch up to the leader before it is ejected
# from the ISR. Too low = spurious ejections during load spikes; too high =
# slow to notice a genuinely stuck follower. 30s is the sane default.
replica.lag.time.max.ms=30000

# KEEP THIS FALSE for any data you care about. true would let Kafka elect an
# out-of-sync replica when the ISR is empty, trading committed data for uptime.
unclean.leader.election.enable=false

# The internal offsets topic must itself be durable -- it stores every consumer
# group's position. Replicate it heavily.
offsets.topic.replication.factor=3
transaction.state.log.replication.factor=3
transaction.state.log.min.isr=2
```

**Creating a durable topic (CLI).** `min.insync.replicas` is a *topic* config as well as a broker default; set it explicitly so the topic's durability does not silently depend on the broker default.

```bash
# Create a topic with 6 partitions, 3 replicas, and an explicit ISR floor of 2.
kafka-topics.sh --bootstrap-server localhost:9092 \
  --create --topic payments \
  --partitions 6 \
  --replication-factor 3 \
  --config min.insync.replicas=2 \
  --config unclean.leader.election.enable=false

# Inspect the partition layout: Leader, Replicas (assigned), and Isr (currently
# in-sync). If Isr is SHORTER than Replicas, a follower has fallen behind.
kafka-topics.sh --bootstrap-server localhost:9092 --describe --topic payments
# Topic: payments  Partition: 0  Leader: 1  Replicas: 1,2,3  Isr: 1,2,3
# Topic: payments  Partition: 1  Leader: 2  Replicas: 2,3,1  Isr: 2,3   <-- b1 lagging!

# Find every partition whose ISR is smaller than its replica set right now --
# the single most useful health query for replication.
kafka-topics.sh --bootstrap-server localhost:9092 --describe \
  --under-replicated-partitions
```

**A producer that actually honours the contract (`kafka-go`).** `acks=all` on the producer is the client half of the durability contract; without it, the broker's `min.insync.replicas` does nothing, because the producer never waits for the replicas.

```go
package main

import (
	"context"
	"log"
	"time"

	"github.com/segmentio/kafka-go"
)

func main() {
	w := &kafka.Writer{
		Addr:  kafka.TCP("localhost:9092"),
		Topic: "payments",

		// acks=all: the leader will not acknowledge until min.insync.replicas
		// in-sync replicas hold the record. This is the CLIENT half of the
		// durability contract -- the broker's min.insync.replicas is inert
		// without it, because acks=1 or acks=0 never waits for the followers.
		RequiredAcks: kafka.RequireAll,

		// Idempotent-style safety: bounded retries so a transient
		// NotEnoughReplicas (fewer than min.insync in-sync, e.g. during a
		// rolling restart) is retried rather than dropped. In modern Kafka,
		// enable.idempotence makes these retries duplicate-free (chapter 20).
		MaxAttempts:  10,
		WriteTimeout: 10 * time.Second,

		// Batch a little to amortise the replication round-trip across records.
		BatchTimeout: 20 * time.Millisecond,

		// Keep ordering meaningful: route by key so records for one entity land
		// on one partition, which is the only place order is guaranteed.
		Balancer: &kafka.Hash{},
	}
	defer w.Close()

	ctx := context.Background()
	err := w.WriteMessages(ctx, kafka.Message{
		Key:   []byte("account-42"),
		Value: []byte(`{"type":"debit","amount":1000}`),
	})
	if err != nil {
		// If fewer than min.insync.replicas are in-sync (e.g. two brokers down
		// in an RF=3 / min.insync=2 topic), the broker returns an error rather
		// than accepting a write it cannot make durable. Treat this as a
		// DURABILITY STOP, not a routine retry: the record is NOT lost, but you
		// must not pretend it was written. Surface it, back off, and page.
		log.Fatalf("produce failed (durability floor not met?): %v", err)
	}
	log.Println("record committed on at least min.insync.replicas brokers")
}
```

**Changing the ISR floor on a live topic.** You raise `min.insync.replicas` before adding brokers, or drop it briefly during a controlled maintenance window — but never leave it below 2 on RF=3 in production.

```bash
# Tighten (or loosen) the durability floor without recreating the topic.
kafka-configs.sh --bootstrap-server localhost:9092 --alter \
  --entity-type topics --entity-name payments \
  --add-config min.insync.replicas=2
```

The recurring point in all of this: the broker cannot enforce durability the producer does not ask for. `min.insync.replicas=2` and `acks=all` are two halves of one contract, set in two different places by two different teams, and a mismatch — `acks=1` against a carefully-configured `min.insync.replicas=2` topic — silently gives you leader-only durability while looking safe on the broker side.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Broker-failure survival.** With RF=3 and the durability contract, any single broker can die with zero loss of acknowledged data and only a brief leader-election blip.
- **Rolling maintenance.** You can restart brokers one at a time for upgrades or config changes; leadership migrates and the ISR heals, so the cluster stays available throughout.
- **Tunable durability.** `acks` (0/1/all) and `min.insync.replicas` let you dial the durability-versus-latency point per topic — strict for ledgers, relaxed for metrics.
- **Consumer safety by construction.** The high watermark guarantees consumers never see a record that a clean failover could erase, so consumer-side correctness needs no extra work.
- **Self-healing ISR.** A follower that fell behind rejoins the ISR automatically once it catches up; no operator action is needed for transient lag.

**Disadvantages**
- **Storage and network multiplied.** RF=3 means 3× the disk and constant follower-fetch traffic; replication is not free.
- **Latency floor.** `acks=all` waits for the slowest in-sync follower, so tail latency is bounded by the least-healthy ISR member, not the leader alone.
- **Availability can be *reduced*.** With `min.insync.replicas=2` on RF=3, losing two brokers stops writes to affected partitions — deliberately, but it is still downtime you must plan for.
- **Configuration is a footgun.** Durability depends on three settings in two places matching; a slack `acks` or a `min.insync.replicas=1` quietly removes the guarantee.

**Trade-offs**
- *Durability vs availability:* `min.insync.replicas=2` on RF=3 buys single-broker-loss durability at the cost of stopping writes when two are down. `min.insync.replicas=1` keeps writing through more failures but permits single-copy writes the next failure can lose. There is no setting that is both maximally durable and maximally available — you must choose per topic.
- *Latency vs durability:* `acks=1` acknowledges at the leader (fast, can lose the un-replicated tail on failover); `acks=all` waits for the ISR (slower, survives failover). The gap is the replication round-trip.
- *Unclean election — uptime vs correctness:* the sharpest trade in Kafka. `false` keeps a partition offline rather than lose committed data; `true` restores availability by electing a stale replica and accepting data loss. Default to `false` and only enable `true` per topic where a gap is genuinely acceptable.

## 7. Common Mistakes & Best Practices

- **`acks=1` (or the old default) against a durable topic.** The broker has `min.insync.replicas=2` and RF=3, but the producer never waits for the followers, so a leader crash loses the un-replicated tail. The topic *looks* durable; it is not. Set `acks=all` explicitly on every producer that matters.
- **`min.insync.replicas=1` on RF=3.** This permits a write acknowledged by the leader alone, so the next broker failure loses it. It defeats the entire point of RF=3. Use 2.
- **`min.insync.replicas` equal to `replication.factor`.** Setting `min.insync=3` on RF=3 means *any* single broker being down stops writes — you have made the cluster as fragile as one broker for availability while gaining nothing over `min.insync=2` for durability. Keep a one-replica gap.
- **Leaving `unclean.leader.election.enable=true`.** On some older builds or careless configs this is on; it silently trades committed data for availability. Audit it and set it `false` for anything you cannot afford to lose.
- **Ignoring `UnderReplicatedPartitions`.** A persistently non-empty count means followers cannot keep up — a slow disk, an overloaded broker, or a network problem — and your effective durability is degrading. It is the first metric to alert on.
- **Under-replicating the internal topics.** `__consumer_offsets` and the transaction state log default low in a single-broker dev setup; in production they must be RF=3 or a broker loss orphans every consumer group's committed offsets.
- **Forgetting rack/zone awareness.** RF=3 across three brokers in one availability zone survives broker loss but not zone loss. Set `broker.rack` so replicas spread across zones, and the ISR spans failure domains.
- **Best practice: standardise the trio.** For any topic holding data you cannot regenerate, make `replication.factor=3`, `min.insync.replicas=2`, `acks=all`, `unclean.leader.election.enable=false` the non-negotiable default, and alert on under-replicated partitions. Relax only deliberately, per topic, with the loss you are accepting written down.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** When writes start failing with `NOT_ENOUGH_REPLICAS` / `NOT_ENOUGH_REPLICAS_AFTER_APPEND`, the ISR has shrunk below `min.insync.replicas` — start from `kafka-topics.sh --describe --under-replicated-partitions` to see which partitions and which followers. When a partition is *offline* entirely, its leader and all ISR replicas are unavailable; check the controller log and broker liveness. For a suspected data-loss incident after a failover, the question is always "was `unclean.leader.election` enabled, and was the ISR truly empty?" — a clean election from a non-empty ISR cannot lose committed data.
- **Monitoring.** The vital signs: `UnderReplicatedPartitions` (should be 0 in steady state; a sustained positive value means degrading durability), `OfflinePartitionsCount` (should be 0; positive means unavailable partitions), `IsrShrinksPerSec` / `IsrExpandsPerSec` (frequent flapping points at a chronically slow broker or a too-tight `replica.lag.time.max.ms`), and `ActiveControllerCount` (must be exactly 1 across the cluster). Under-replicated partitions are the single best leading indicator of a durability problem.
- **Security.** Replication traffic between brokers should be authenticated and encrypted (broker-to-broker TLS via the `inter.broker.listener.name`) so a compromised network cannot inject or read replica data. Restrict `Alter`/`Create` topic ACLs so an unprivileged client cannot lower a topic's `min.insync.replicas` or flip `unclean.leader.election` and quietly weaken durability. Treat the durability configs as security-relevant.
- **Scaling.** Replication cost grows with RF and partition count: every partition's followers fetch continuously, so more partitions mean more fetch traffic and more leader-election work on failover. When adding brokers, use `kafka-reassign-partitions.sh` to move replicas onto the new brokers and rebalance leadership, and throttle the reassignment so the catch-up traffic does not starve live produce/consume. Beyond a few thousand partitions per broker, leader-election and metadata overhead become the limiting factor — which is exactly the ceiling KRaft (chapter 19) was built to raise.

## 9. Interview Questions

**Q: What is the ISR and why is it time-based rather than count-based?**
A: The in-sync replica set is the subset of a partition's replicas — including the leader — that are currently caught up with the leader, meaning they have fetched up to the leader's log end within `replica.lag.time.max.ms`. It is dynamic: a follower that falls behind is ejected, and rejoins once it catches up. It is time-based rather than message-count-based because a count bound (`replica.lag.max.messages`, the old approach) depends on the producer's rate, not the follower's health — a legitimate traffic burst could push a perfectly healthy follower more than N messages behind for a moment and eject it spuriously. The time bound asks the right question: is this follower making progress and keeping up recently?

**Q: Explain the durability contract with `acks=all`, `min.insync.replicas` and `replication.factor`.**
A: They are three settings that only deliver durability together. `replication.factor=3` means three brokers hold copies. `acks=all` makes the producer wait for the in-sync replicas to confirm before the write is acknowledged. `min.insync.replicas=2` requires at least two replicas to be in-sync and acknowledge, or the broker rejects the write. Combined, a write is acknowledged only when at least two brokers hold it, so losing one broker never loses acknowledged data. Crucially, `acks=all` alone is not enough — "all in-sync" can be one replica if the others fell out of the ISR — so `min.insync.replicas` provides the floor, and the producer setting and the topic setting must both be right.

**Q: What is the high watermark and what does it protect?**
A: The high watermark is the highest offset that has been replicated to every member of the ISR — the boundary of committed data. The leader advances it to the minimum log-end-offset across the ISR, so a record is committed only once the slowest in-sync follower has it. Consumers are only ever handed records below the high watermark. This protects consumers from reading a record that a leader failover could erase: because anything below the high watermark is on every in-sync replica, a new leader elected from the ISR is guaranteed to have it, so nothing a consumer has already seen can be "un-happened" by a clean election.

**Q: What happens when a broker holding a partition leader dies?**
A: The controller detects the broker's loss (its session expires) and elects a new leader for every partition that broker led. For a clean election it chooses a replica from the ISR, which by definition holds every committed record, so no committed data is lost; producers and consumers reconnect to the new leader and resume. The only records at risk are the leader's un-replicated tail, which was never acknowledged to producers nor visible to consumers, so no promise is broken. The failover is a brief availability blip, not a data-loss event — provided the ISR was non-empty and unclean leader election is disabled.

**Q: What does `min.insync.replicas=2` do when two of three brokers are down?**
A: It stops accepting `acks=all` writes to the affected partitions. With two brokers down, only one in-sync replica remains, which is below the floor of two, so the broker returns `NotEnoughReplicas` rather than accepting a write that only one broker would hold. This is the contract working as designed: it refuses to make a durability promise it cannot keep, converting a silent single-copy-write window that the next failure would lose into a loud, visible unavailability. The already-committed data is safe; only new writes are blocked until an in-sync replica returns.

**Q: Why should `min.insync.replicas` not equal `replication.factor`?**
A: Because then any single broker being down stops writes. With RF=3 and `min.insync.replicas=3`, all three replicas must be in-sync for a write to succeed, so a single broker restart — routine maintenance — halts production to those partitions. You gain nothing in durability over `min.insync.replicas=2` (which already survives one broker loss with zero data loss) while making availability as fragile as a single broker. Keep a one-replica gap: `min.insync.replicas = replication.factor - 1`.

**Q: (Senior) Walk through exactly what unclean leader election trades, and how you would decide.**
A: Unclean leader election governs the case where every in-sync replica for a partition is unavailable at once. With it disabled (the default, `false`), Kafka refuses to elect a leader and takes the partition offline until an in-sync replica returns — it preserves every committed record but sacrifices availability, potentially for a long time if the in-sync brokers stay down. With it enabled (`true`), Kafka elects an *out-of-sync* replica, one that was ejected from the ISR because it was behind; the partition comes back immediately, but that replica is missing records the old ISR had committed, so committed data — data producers were told was safe and consumers may have already read — is silently lost, and worse, the log diverges: offsets that meant one record now mean another. I decide per topic on the cost of a gap versus the cost of downtime. For payments, orders, ledgers, or anything a downstream system has acted on, I keep it `false` and treat an offline partition as a page-the-humans event, because losing committed financial data is unrecoverable and erodes trust in the whole system. For high-volume observability data — metrics, access logs, traces — where a minute-long gap during a rare double-failure is annoying but harmless, I might enable it to keep ingestion flowing. The default must be `false`, and enabling `true` should be a documented, per-topic decision with the accepted loss written down, never a cluster-wide convenience.

**Q: (Senior) A producer uses `acks=all` but you still lost data after a failover. What are the plausible causes?**
A: `acks=all` guarantees the write reached all *in-sync* replicas, so the loss must come from the ISR being smaller or weaker than assumed, or from a config gap. First, `min.insync.replicas=1`: with only one in-sync replica, "all in-sync" is the leader alone, so `acks=all` degraded to leader-only durability and the un-replicated tail died with the leader — the fix is `min.insync.replicas=2` on RF≥3. Second, unclean leader election was enabled and the ISR emptied, so an out-of-sync replica was elected and committed records were truncated away. Third, the ISR had genuinely shrunk to one healthy replica (followers chronically lagging) at the moment of failure, so even with `min.insync.replicas=2` the topic had been running under-replicated and writes that squeaked through a transient window were vulnerable — the `UnderReplicatedPartitions` metric would have been screaming beforehand. Fourth, `replication.factor` was actually 1 or 2 for that topic, not 3, so there was nowhere near enough redundancy. Fifth, and subtler, the producer treated a `NotEnoughReplicas` error as success or swallowed it — the broker correctly refused the write, but the application logged it as sent. I would reconstruct the ISR history from the broker logs and metrics at the time of the incident, check the topic's actual `replication.factor`, `min.insync.replicas` and unclean-election setting, and verify the producer's `acks` and error handling — the cause is almost always one of these slack settings, not the replication mechanism itself.

**Q: (Senior) How does the ISR interact with tail latency, and how would you tune a latency-sensitive but durable topic?**
A: Under `acks=all` the producer's acknowledgement waits for the *slowest* in-sync replica to fetch the record, so your write latency's tail is set by the least-healthy ISR member at that instant — a GC pause, a disk stall, or a saturated link on any follower shows up directly as p99 produce latency. There is genuine tension: you want enough replicas in the ISR for durability but not to be hostage to a straggler. The levers are, first, keep the ISR members homogeneous and healthy — same instance types, fast disks, and headroom — so the slowest in-sync replica is not much slower than the fastest, since replication latency is a max, not an average. Second, tune `replica.lag.time.max.ms` so a genuinely stuck follower is ejected from the ISR promptly (removing it from the acknowledgement path) without being so tight that healthy followers flap in and out under load, which itself causes latency spikes and offset-visibility churn. Third, keep `min.insync.replicas=2` rather than 3 on RF=3 so the write waits for the two fastest in-sync replicas, not all three — you get single-broker-loss durability while a single slow follower does not gate every write. Fourth, batch and compress on the producer (`linger.ms`, `batch.size`, `compression.type`) to amortise the replication round-trip across many records, which improves throughput and effective per-record latency. The thing I would *not* do is drop to `acks=1` to chase latency on a durable topic — that trades away exactly the guarantee the topic exists to provide; the right move is to make the ISR fast and homogeneous so `acks=all` is cheap.

**Q: What is a "preferred leader" and why does Kafka try to keep leadership there?**
A: The preferred leader is the first broker in a partition's assigned replica list. Kafka spreads preferred leaders evenly across brokers when a topic is created, so that in steady state each broker leads roughly the same number of partitions and the read/write load is balanced. After a failover, leadership moves to whichever surviving replica was elected, which unbalances the cluster — one broker may now lead far more partitions than others. The preferred-leader election (automatic via `auto.leader.rebalance.enable`, or manual via `kafka-leader-election.sh`) moves leadership back to the preferred replicas once they are healthy again, restoring the balance. It is about load distribution, not durability.

**Q: If the ISR shrinks to just the leader, is `acks=all` still safe?**
A: Only if `min.insync.replicas` forbids it. If the ISR is down to the leader alone and `min.insync.replicas=1`, then `acks=all` acknowledges after just the leader has the record — you have single-copy durability despite asking for "all", and a leader failure loses the write. If `min.insync.replicas=2`, the broker rejects the write instead, because fewer than two replicas are in-sync — so you are protected from unknowingly writing single-copy data. This is exactly why `min.insync.replicas` exists and why it must be 2 on RF=3: it stops "all in-sync" from silently collapsing to "just the leader" during a period of follower lag.

## 10. Quick Revision & Cheat Sheet

| Concept | One-line meaning |
|---|---|
| `replication.factor` | Number of broker copies of each partition |
| Leader / follower | Serves clients / silently fetches to stay current |
| ISR | Replicas caught up within `replica.lag.time.max.ms` |
| `acks=all` | Producer waits for the in-sync replicas to confirm |
| `min.insync.replicas` | Floor of in-sync replicas needed, or the write is rejected |
| High watermark | Highest offset on all ISR members; consumer-visible boundary |
| LEO | Log end offset — the leader's tail, ahead of the HW |
| Unclean leader election | Elect an out-of-sync replica: available but lossy |

| Setting (RF=3) | Durability | Availability |
|---|---|---|
| `acks=1` | Loses un-replicated tail on failover | Highest |
| `acks=all`, `min.insync=1` | Leader-only if ISR shrinks — unsafe | High |
| `acks=all`, `min.insync=2` | Survives one broker loss, no data loss | Stops writes if 2 down |
| `acks=all`, `min.insync=3` | Same durability, needlessly fragile | Stops writes if 1 down |

**Flash cards**
- **The durability standard?** → `RF=3`, `acks=all`, `min.insync.replicas=2`, `unclean.leader.election.enable=false`.
- **What can a consumer see?** → Only offsets below the high watermark (committed to all ISR).
- **ISR membership rule?** → Caught up within `replica.lag.time.max.ms`, else ejected.
- **Two brokers down on RF=3, `min.insync=2`?** → `acks=all` writes are rejected; committed data is safe.
- **Unclean leader election?** → Elect a stale replica: uptime restored, committed data lost. Keep it off.
- **First metric to alert on?** → `UnderReplicatedPartitions` > 0 (durability degrading).

## 11. Hands-On Exercises & Mini Project

- [ ] Create an RF=3, `min.insync.replicas=2` topic on a 3-broker cluster and confirm `--describe` shows Leader, Replicas and Isr for each partition.
- [ ] Produce with `acks=all`, then kill the leader broker and observe a new leader elected from the ISR with no message loss on the consumer side.
- [ ] Stop two of the three brokers and watch an `acks=all` producer receive `NotEnoughReplicas` — verify committed data is still readable once a broker returns.
- [ ] Throttle one follower (e.g. pause its process briefly) and watch it leave and rejoin the ISR in `--describe` as `replica.lag.time.max.ms` elapses.
- [ ] Deliberately set `min.insync.replicas=1` and `acks=1`, kill the leader mid-produce, and demonstrate the resulting message loss — then fix the config and show it no longer happens.
- [ ] Use `kafka-configs.sh` to raise and lower a live topic's `min.insync.replicas` and observe the effect on producing while a broker is down.

### Mini Project — "Durability Under Failure"

**Goal.** Empirically prove, on a real 3-broker cluster, that the durability contract survives single-broker loss and correctly refuses writes it cannot make durable.

**Requirements.**
1. Stand up a 3-broker Kafka cluster (Docker Compose or three local brokers) with `unclean.leader.election.enable=false`.
2. Create a topic with `replication-factor=3`, `min.insync.replicas=2`, and several partitions; verify the ISR via `--describe`.
3. Write a `kafka-go` producer with `acks=all` that sends a numbered sequence, and a consumer that records every offset it sees.
4. During a steady produce, kill the current leader broker for one partition; confirm the consumer sees no gap and no duplicate at the failover, and that `--describe` shows a new leader from the ISR.
5. Kill a second broker; confirm the producer now receives `NotEnoughReplicas` errors and treats them as a durability stop (does not report success), and that no committed record was lost when a broker rejoins.

**Extensions.**
- Repeat step 5 with `min.insync.replicas=1` and `acks=1` and measure the messages lost, quantifying the cost of a slack contract.
- Enable `unclean.leader.election.enable=true`, force an empty-ISR scenario, and demonstrate committed-data loss and log divergence — then argue in writing which topics in a system could ever tolerate it.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Storage Internals: Segments, Indexes & Zero-Copy* (what each replica physically stores), *KRaft & the Death of ZooKeeper* (who the controller is and how leader election scales), *Design: Kafka Exactly-Once* (how idempotence and transactions build on the durability contract), *Delivery Guarantees* (the at-least-once default the ISR underpins), *Design: Consumers, Groups, Offsets & Rebalancing* (how consumers use the high watermark).

- **Apache Kafka — Replication (Design)** — Apache · *Advanced* · the authoritative description of leaders, followers, the ISR and committed offsets, straight from the docs. <https://kafka.apache.org/documentation/#replication>
- **Apache Kafka — `min.insync.replicas` & `acks`** — Apache · *Intermediate* · the exact semantics of the two halves of the durability contract, with the failure behaviour spelled out. <https://kafka.apache.org/documentation/#producerconfigs_acks>
- **Confluent — Hands Free Kafka Replication: A Lesson in Operational Simplicity** — Confluent · *Advanced* · the design essay on why Kafka's ISR approach differs from quorum replication, and the reasoning behind it. <https://www.confluent.io/blog/hands-free-kafka-replication-a-lesson-in-operational-simplicity/>
- **Kafka: The Definitive Guide, ch. 7 (Reliable Data Delivery)** — Narkhede, Shapira & Palino · *Advanced* · the book-length treatment of replication, acks, `min.insync.replicas` and unclean leader election as one reliability story. <https://www.confluent.io/resources/kafka-the-definitive-guide/>
- **Designing Data-Intensive Applications, ch. 5 (Replication)** — Martin Kleppmann · *Advanced* · the general theory of leader-based replication, in-sync followers and failover, of which Kafka is one instance. <https://dataintensive.net/>
- **Confluent — Optimizing Kafka for durability** — Confluent · *Intermediate* · a practical checklist of the durability configuration this chapter argues for, with the trade-offs. <https://docs.confluent.io/kafka/design/durability.html>
- **Apache Kafka — Documentation: Balancing leadership** — Apache · *Intermediate* · preferred leaders, `auto.leader.rebalance.enable` and keeping leadership evenly distributed after failovers. <https://kafka.apache.org/documentation/#basic_ops_leader_balancing>
- **Jepsen — Kafka analyses** — Kyle Kingsbury · *Advanced* · rigorous testing of Kafka's replication and consistency claims under partitions and failures; sharpens intuition about the edges. <https://jepsen.io/analyses>

---

*Kafka & RabbitMQ Handbook — chapter 17.*
