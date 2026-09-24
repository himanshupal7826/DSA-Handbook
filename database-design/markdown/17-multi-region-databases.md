# 17 · Multi-Region Databases: Latency, Locality & Conflicts

> **In one line:** The speed of light puts 60–200 ms between regions, so a multi-region database can have at most two of "writes anywhere", "local latency" and "no conflicts" — every real design picks which one to give up, per table, and says so out loud.

---

## 1. Overview

Most teams arrive at multi-region for one of three reasons: **a region outage** took them down (or an auditor asked what would happen if it did), **users far away** see 300 ms page loads because every query crosses an ocean, or **law** requires some users' data to stay in a jurisdiction (GDPR-driven EU residency, India's and others' localisation rules). Those three drivers want different things — survivability, latency, residency — and a design that satisfies one can make another worse.

The naive approach is "just replicate the database to another region and let both write". It fails immediately on physics. A write in Virginia that must be confirmed in Frankfurt waits for a round trip of roughly 90 ms; a write that is *not* confirmed can conflict with a concurrent write in Frankfurt, and one of them will be silently discarded by whatever "last writer wins" rule you didn't know you had. The second naive approach — "one primary region, async replica elsewhere, we'll fail over if we need to" — is sound but routinely oversold: European users still pay a cross-Atlantic round trip on every write, and a regional failover loses whatever was in flight (your RPO is the replication lag at the moment of disaster).

This chapter gives you the vocabulary and the physics to reason about the choices precisely: **multi-AZ vs multi-region**, **where reads can be served and how stale they may be**, **where writes must go**, **what happens when two regions write the same row**, and **how you recover a region**. It ends with how DynamoDB global tables, Aurora Global Database, CockroachDB multi-region and Spanner each package these choices.

> **Builds on:** [Ch 09 · Database Replication](topic.html?p=09-replication) (sync vs async, lag) · [Ch 10 · Consistency Models](topic.html?p=10-consistency-models) (read-your-writes, bounded staleness) · [Ch 14 · CAP Theorem](topic.html?p=14-cap-theorem) (PACELC is the everyday version of this chapter) · [Ch 16 · Distributed Database Architecture](topic.html?p=16-distributed-database-architecture) (ranges, leaseholders, Raft). There is no SQL Handbook prerequisite; this chapter goes into cross-region latency, locality and conflict resolution.

> **Why this matters:** "How would you make this global?" is the most common follow-up in senior design interviews. The weak answer is "multi-region replication". The strong answer names the RTT, says which tables are single-home, which are geo-partitioned and which are global, and states the RPO of a region loss.

## 2. Core Concepts

- **Availability zone (AZ)** — an isolated datacenter (or group) within a region, a few km to tens of km apart, with round trips typically around 1 ms. *Why it matters:* synchronous replication across AZs is cheap; this is where most HA lives (Ch 18).
- **Region** — a geographic area containing several AZs, hundreds to thousands of km from other regions. *Why it matters:* cross-region round trips are tens to hundreds of ms, so synchronous cross-region commits are expensive.
- **Multi-AZ** — replicas in several AZs of one region. Survives an AZ failure; does not survive a region failure.
- **Multi-region** — replicas in several regions. Survives a region failure *if* the data and the control plane are there.
- **Home region** — the region that owns writes for a row, table or tenant. *Why it matters:* writes are fast there and slow elsewhere.
- **Data locality** — placing data near the users who read and write it. *Why it matters:* locality, not bandwidth, is what removes cross-region latency.
- **Data residency** — a legal requirement that data (and sometimes its backups and logs) stays within a jurisdiction. *Why it matters:* it constrains *where replicas may exist*, which constrains survivability.
- **Follower read** — a read served by a non-leader replica at a slightly old timestamp. *Why it matters:* local, cheap, and consistent-as-of-a-point-in-time.
- **Bounded staleness** — a read guaranteed to be no older than some bound (e.g. 10 s). *Why it matters:* turns "eventually consistent" into a number you can put in a spec.
- **Multi-leader / active-active** — more than one region accepts writes for the same data. *Why it matters:* local write latency everywhere, paid for with conflicts.
- **Conflict** — two concurrent writes to the same logical item in different regions, neither of which saw the other. *Why it matters:* something must pick a winner or merge.
- **LWW (last writer wins)** — resolve conflicts by highest timestamp. *Why it matters:* simple and silently lossy.
- **CRDT** — a conflict-free replicated data type whose merge is commutative, associative and idempotent, so replicas converge regardless of order. *Why it matters:* no lost updates, but only for data that fits a CRDT.
- **RPO / RTO (regional)** — data you can lose / time you are down when a region fails. *Why it matters:* async cross-region replication means RPO > 0 by definition.

## 3. Theory & Principles

### The physics you cannot negotiate

Light in optical fibre travels at roughly 200,000 km/s — about 5 µs per km one way, so **each 100 km of fibre adds ~1 ms of round trip** in the best case. Real paths are longer than great circles and cross routers, so measured RTTs are typically 1.3–2× the theoretical minimum. Rough, order-of-magnitude numbers between cloud regions:

| Path | Distance (approx.) | Typical RTT |
| --- | --- | --- |
| Between AZs in one region | a few to tens of km | ~0.5–2 ms |
| US East ↔ US West (Virginia ↔ Oregon) | ~3,500–4,000 km | ~60–75 ms |
| US East ↔ Western Europe (Virginia ↔ Ireland/Frankfurt) | ~5,500–6,500 km | ~70–95 ms |
| Western Europe ↔ India | ~6,500–7,500 km | ~110–140 ms |
| US East ↔ Singapore / Sydney | ~15,000+ km | ~200–250 ms |

Now apply them to a commit. A synchronous commit that needs an acknowledgement from another region costs *at least* one RTT. A Raft/Paxos group with replicas in Virginia, Ohio and Oregon commits when the leader hears from the nearest follower — ~12 ms to Ohio — but if Ohio is down, the next-nearest follower is Oregon at ~65 ms. A transaction doing three sequential writes, each needing a cross-region quorum, has a latency floor of three RTTs no matter how fast the machines are. **You cannot tune this away; you can only change which requests need a cross-region round trip.**

### Global reads: three ways to read locally

Reads are the easy half, because you can trade freshness for locality:

1. **Local async replica.** Each region has a read replica fed by async replication. Reads are fast but stale by the replication lag (often sub-second, but unbounded during incidents). Fine for catalogue pages; wrong for "show me the order I just placed" unless you add read-your-writes routing (Ch 10).
2. **Follower reads at a timestamp.** In consensus-based systems, a replica can serve a read *as of* a timestamp it knows is fully replicated — CockroachDB's `AS OF SYSTEM TIME follower_read_timestamp()` (a few seconds in the past), Spanner's **stale reads**. The result is a consistent snapshot, just slightly old, and it never blocks on the leader.
3. **Bounded-staleness reads.** A read that may be stale by *at most* N seconds; the replica serves locally if it is fresh enough, otherwise it waits or forwards. Spanner's `max_staleness`, CockroachDB's `with_max_staleness('10s')`. This is the best default for most "global" read traffic.

Strongly consistent (linearizable) reads of data homed elsewhere must go to the leader/leaseholder — one cross-region RTT. The exception is data that is read-mostly and *designed* for global reads: CockroachDB **GLOBAL tables** and Spanner's read-only replicas make reads local and consistent by making *writes* slower (writes wait out a future timestamp so every replica can serve reads without coordination).

### Global writes: the three models

Every multi-region write design is one of these, or a per-table mix:

**A. Single home region (single-leader).** All writes for the database go to one region; others hold async (or quorum) replicas. Simple, no conflicts, strongly consistent at the primary. Remote users pay one RTT per write (and per strongly consistent read). Aurora Global Database, a PG primary with a cross-region standby, and a Spanner/CockroachDB database with all leaders in one region all look like this.

**B. Geo-partitioned rows (per-row home region).** Each row has a home region (usually the user's), and writes for that row go there. EU users write in Frankfurt at local latency; US users write in Virginia. No conflicts, because each row has exactly one leader. Cross-home transactions (an EU user paying a US merchant) pay cross-region latency. CockroachDB **REGIONAL BY ROW**, Spanner with geo-partitioning, and app-level "cell" architectures (one database stack per region, users pinned to a cell) are this model. It also naturally supports **residency**: pin EU rows' replicas to EU regions.

**C. Multi-leader (active-active).** Every region accepts writes for every row and replicates asynchronously to the others. Local write latency everywhere and survives a region loss with no write downtime — but concurrent writes to the same row in two regions **conflict**, and something must resolve them. DynamoDB global tables (default mode), Cassandra with `LOCAL_QUORUM` in each DC, PostgreSQL BDR/pgactive-style bidirectional logical replication, MySQL multi-source setups.

```svg
<svg viewBox="0 0 880 520" width="100%" height="520" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c17a1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="c17a2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#94a3b8"/></marker>
    <marker id="c17a3" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Three global write models (US-East, EU-West; RTT &#8776; 85 ms)</text>
  <rect x="20" y="40" width="272" height="370" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="156" y="62" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">A. Single home region</text>
  <rect x="40" y="84" width="100" height="56" rx="6" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/><text x="90" y="106" text-anchor="middle" fill="#1e40af" font-weight="bold">US primary</text><text x="90" y="124" text-anchor="middle" fill="#1e40af" font-size="9">all writes</text>
  <rect x="172" y="84" width="100" height="56" rx="6" fill="#f1f5f9" stroke="#94a3b8"/><text x="222" y="106" text-anchor="middle" fill="#334155">EU replica</text><text x="222" y="124" text-anchor="middle" fill="#334155" font-size="9">reads (stale)</text>
  <path d="M142,112 L168,112" stroke="#94a3b8" stroke-width="2" stroke-dasharray="4 3" marker-end="url(#c17a2)"/>
  <text x="156" y="160" text-anchor="middle" fill="#64748b" font-size="9">async WAL</text>
  <path d="M222,176 C 222,200 120,200 100,146" stroke="#2563eb" stroke-width="2" fill="none" marker-end="url(#c17a1)"/>
  <text x="200" y="214" fill="#1e40af" font-size="9">EU write crosses ocean</text>
  <text x="36" y="248" fill="#1e40af" font-size="10">US write: ~1&#8211;5 ms</text>
  <text x="36" y="266" fill="#1e40af" font-size="10">EU write: +85 ms RTT</text>
  <text x="36" y="284" fill="#1e40af" font-size="10">conflicts: none</text>
  <text x="36" y="302" fill="#1e40af" font-size="10">region loss RPO: lag (async)</text>
  <text x="36" y="320" fill="#1e40af" font-size="10">RTO: promote EU (minutes)</text>
  <text x="36" y="356" fill="#1e40af" font-size="10" font-weight="bold">Default. Simple, correct,</text>
  <text x="36" y="372" fill="#1e40af" font-size="10" font-weight="bold">slow for remote writers.</text>
  <rect x="304" y="40" width="272" height="370" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="440" y="62" text-anchor="middle" fill="#166534" font-size="12" font-weight="bold">B. Geo-partitioned rows</text>
  <rect x="324" y="84" width="100" height="56" rx="6" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/><text x="374" y="106" text-anchor="middle" fill="#166534" font-weight="bold">US leader</text><text x="374" y="124" text-anchor="middle" fill="#166534" font-size="9">rows region=us</text>
  <rect x="456" y="84" width="100" height="56" rx="6" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/><text x="506" y="106" text-anchor="middle" fill="#166534" font-weight="bold">EU leader</text><text x="506" y="124" text-anchor="middle" fill="#166534" font-size="9">rows region=eu</text>
  <text x="440" y="170" text-anchor="middle" fill="#166534" font-size="9">each row has exactly ONE leader</text>
  <text x="440" y="186" text-anchor="middle" fill="#166534" font-size="9">(replicas may live elsewhere for survival)</text>
  <text x="320" y="248" fill="#166534" font-size="10">home-region write: local ms</text>
  <text x="320" y="266" fill="#166534" font-size="10">cross-home txn: +RTT</text>
  <text x="320" y="284" fill="#166534" font-size="10">conflicts: none</text>
  <text x="320" y="302" fill="#166534" font-size="10">residency: pin EU replicas to EU</text>
  <text x="320" y="320" fill="#166534" font-size="10">user moves region: re-home row</text>
  <text x="320" y="356" fill="#166534" font-size="10" font-weight="bold">Best when users have a</text>
  <text x="320" y="372" fill="#166534" font-size="10" font-weight="bold">natural home (most apps).</text>
  <rect x="588" y="40" width="272" height="370" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="724" y="62" text-anchor="middle" fill="#991b1b" font-size="12" font-weight="bold">C. Multi-leader (active-active)</text>
  <rect x="608" y="84" width="100" height="56" rx="6" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/><text x="658" y="106" text-anchor="middle" fill="#991b1b" font-weight="bold">US writer</text><text x="658" y="124" text-anchor="middle" fill="#991b1b" font-size="9">any row</text>
  <rect x="740" y="84" width="100" height="56" rx="6" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/><text x="790" y="106" text-anchor="middle" fill="#991b1b" font-weight="bold">EU writer</text><text x="790" y="124" text-anchor="middle" fill="#991b1b" font-size="9">any row</text>
  <path d="M710,104 L736,104" stroke="#dc2626" stroke-width="2" marker-end="url(#c17a3)"/>
  <path d="M738,122 L712,122" stroke="#dc2626" stroke-width="2" marker-end="url(#c17a3)"/>
  <text x="724" y="170" text-anchor="middle" fill="#991b1b" font-size="9">async both ways</text>
  <text x="724" y="186" text-anchor="middle" fill="#991b1b" font-size="9">same row written in both = CONFLICT</text>
  <text x="604" y="248" fill="#991b1b" font-size="10">every write: local ms</text>
  <text x="604" y="266" fill="#991b1b" font-size="10">conflicts: yes &#8594; LWW / CRDT / app</text>
  <text x="604" y="284" fill="#991b1b" font-size="10">region loss: keep writing elsewhere</text>
  <text x="604" y="302" fill="#991b1b" font-size="10">RPO: un-replicated writes in lost region</text>
  <text x="604" y="320" fill="#991b1b" font-size="10">invariants (balance &#8805; 0): unsafe</text>
  <text x="604" y="356" fill="#991b1b" font-size="10" font-weight="bold">Only for data that merges:</text>
  <text x="604" y="372" fill="#991b1b" font-size="10" font-weight="bold">carts, likes, presence, settings.</text>
  <rect x="20" y="424" width="840" height="80" rx="10" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="36" y="446" fill="#1e293b" font-size="11" font-weight="bold">Pick per table, not per database:</text>
  <text x="36" y="466" fill="#334155" font-size="10">ledger / inventory / uniqueness &#8594; A or B (one leader per row) &#183; user profile, orders &#8594; B (home = user's region)</text>
  <text x="36" y="486" fill="#334155" font-size="10">reference data (plans, currencies) &#8594; global table: local consistent reads, slow writes &#183; counters, carts, presence &#8594; C with CRDT merge</text>
</svg>
```

### Conflict resolution: what "active-active" actually costs

A **conflict** occurs when two regions each accept a write to the same item before either has seen the other's. There are three families of resolution, and they are not equally honest.

**Last writer wins (LWW).** Each write carries a timestamp; the highest wins everywhere. It converges, and it is what DynamoDB global tables and Cassandra do by default. The cost is **silent data loss**: the losing write is discarded without error. Worse, "last" is judged by clocks that can be skewed by milliseconds (or more, with a misbehaving NTP), so the write that happened *second* in real time can lose. And LWW works on the whole item (DynamoDB) or per column (Cassandra): if it's per item, concurrent updates to *different fields* still clobber each other.

**CRDTs.** Model the data so merges are mathematically well-defined. A **G-Counter** keeps one counter per region and sums them; a **PN-Counter** adds a decrement vector; an **OR-Set** (observed-remove set) tracks unique tags per add so concurrent add/remove resolve predictably; an **LWW-register** is LWW made explicit per field. Replicas can apply updates in any order and converge. The cost: only certain data shapes fit, metadata grows, and CRDTs guarantee *convergence*, not *invariants* — two regions can each decrement stock from 1 to 0 and the merged counter says −1.

**Application-level merge.** Keep both versions (siblings, like Riak or CouchDB) or record the conflict, and let application logic merge: union the cart, take max of `last_seen`, flag a human review for conflicting address edits. Most honest, most work.

The unifying rule: **active-active is safe only for data whose correctness does not depend on seeing the latest value** — commutative updates, per-user data only written from one place at a time, or data where losing a concurrent update is acceptable. Anything guarded by an invariant (balances, inventory, unique usernames, seat assignment) needs a single leader per item — model A or B.

```svg
<svg viewBox="0 0 880 440" width="100%" height="440" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c17b1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#94a3b8"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">One conflict, three resolutions: cart item quantity edited in two regions</text>
  <line x1="120" y1="60" x2="840" y2="60" stroke="#2563eb" stroke-width="2"/>
  <text x="30" y="64" fill="#1e40af" font-weight="bold">US region</text>
  <line x1="120" y1="150" x2="840" y2="150" stroke="#7c3aed" stroke-width="2"/>
  <text x="30" y="154" fill="#5b21b6" font-weight="bold">EU region</text>
  <circle cx="160" cy="60" r="5" fill="#2563eb"/><text x="160" y="48" text-anchor="middle" fill="#1e40af" font-size="10">cart={book:1}</text>
  <circle cx="160" cy="150" r="5" fill="#7c3aed"/><text x="160" y="172" text-anchor="middle" fill="#5b21b6" font-size="10">cart={book:1}</text>
  <circle cx="300" cy="60" r="6" fill="#dc2626"/><text x="300" y="48" text-anchor="middle" fill="#991b1b" font-size="10">t=10.000 add pen</text>
  <circle cx="320" cy="150" r="6" fill="#dc2626"/><text x="320" y="172" text-anchor="middle" fill="#991b1b" font-size="10">t=10.004 book:2</text>
  <path d="M300,66 L470,144" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#c17b1)"/>
  <path d="M320,144 L480,66" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#c17b1)"/>
  <text x="400" y="110" text-anchor="middle" fill="#64748b" font-size="9">async replication (~85 ms + queue)</text>
  <text x="540" y="100" fill="#334155" font-size="10">Neither write saw the other &#8594; concurrent</text>
  <rect x="20" y="200" width="272" height="226" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="156" y="222" text-anchor="middle" fill="#991b1b" font-size="12" font-weight="bold">LWW (whole item)</text>
  <text x="36" y="246" fill="#991b1b" font-size="10">EU timestamp 10.004 &gt; 10.000</text>
  <text x="36" y="266" fill="#991b1b" font-size="10">final = {book:2}</text>
  <text x="36" y="286" fill="#991b1b" font-size="10" font-weight="bold">pen silently LOST, no error</text>
  <text x="36" y="316" fill="#991b1b" font-size="10">with 5 ms clock skew the</text>
  <text x="36" y="332" fill="#991b1b" font-size="10">real-time order can invert</text>
  <text x="36" y="366" fill="#7f1d1d" font-size="10">DynamoDB global tables,</text>
  <text x="36" y="382" fill="#7f1d1d" font-size="10">Cassandra (per cell) default</text>
  <rect x="304" y="200" width="272" height="226" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="440" y="222" text-anchor="middle" fill="#166534" font-size="12" font-weight="bold">CRDT (map of PN-counters)</text>
  <text x="320" y="246" fill="#166534" font-size="10">US: pen += 1 &#183; EU: book += 1</text>
  <text x="320" y="266" fill="#166534" font-size="10">merge = per-key counter merge</text>
  <text x="320" y="286" fill="#166534" font-size="10" font-weight="bold">final = {book:2, pen:1} everywhere</text>
  <text x="320" y="316" fill="#166534" font-size="10">order-independent, idempotent</text>
  <text x="320" y="332" fill="#166534" font-size="10">but: converges, not invariant-safe</text>
  <text x="320" y="366" fill="#14532d" font-size="10">Redis Enterprise Active-Active,</text>
  <text x="320" y="382" fill="#14532d" font-size="10">Riak data types, Azure Cosmos DB</text>
  <rect x="588" y="200" width="272" height="226" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="724" y="222" text-anchor="middle" fill="#92400e" font-size="12" font-weight="bold">Application merge</text>
  <text x="604" y="246" fill="#92400e" font-size="10">keep both versions (siblings)</text>
  <text x="604" y="266" fill="#92400e" font-size="10">merge rule: union items,</text>
  <text x="604" y="282" fill="#92400e" font-size="10">max(quantity) per item</text>
  <text x="604" y="302" fill="#92400e" font-size="10" font-weight="bold">final = {book:2, pen:1}</text>
  <text x="604" y="332" fill="#92400e" font-size="10">domain-aware, most work;</text>
  <text x="604" y="348" fill="#92400e" font-size="10">some conflicts go to a human</text>
  <text x="604" y="382" fill="#78350f" font-size="10">CouchDB/Riak siblings, custom</text>
  <text x="604" y="398" fill="#78350f" font-size="10">conflict handlers (BDR/PGD)</text>
</svg>
```

## 4. Architecture & Workflow

### Multi-AZ vs multi-region: what each survives

```text
Failure                          Multi-AZ (1 region)        Multi-region (async DR)     Multi-region (quorum across 3 regions)
Disk / node dies                 survive, RPO 0 (sync)      survive                     survive, RPO 0
AZ outage (power, network)       survive, RPO 0 (sync)      survive                     survive, RPO 0
Region outage / regional control survive? NO                failover, RPO = lag,        survive, RPO 0, writes continue
plane failure                                               RTO = minutes               (if 2 of 3 regions remain)
Write latency cost               +~1 ms                     +0 (async)                  +1 cross-region RTT per commit
```

Most outages are node or AZ scoped; region-wide outages are rare but real (and often involve the provider's control plane rather than the datacenters). That is why the common production answer is **multi-AZ synchronous for HA + multi-region asynchronous for DR**, and only the systems whose revenue justifies it pay the cross-region quorum latency.

### Region failure, step by step (single home region, async DR)

```text
T0      us-east primary (sync standby in another AZ), eu-west async replica, lag ~300 ms
T0+0s   us-east region becomes unreachable (network partition to the region)
T0+30s  health checks from outside the region fail; paging starts
T0+3m   humans confirm: region-level, not transient; decision to fail over
        (automatic cross-region failover is rare: false positives are expensive)
T0+5m   eu-west replica promoted (pg_promote() / Aurora "failover global database")
        writes that were committed in us-east but not yet shipped are LOST (RPO ~= lag at T0)
T0+6m   DNS / service discovery points writers to eu-west; app pools reconnect
T0+8m   writes resume at eu-west; all users now pay latency to eu-west
Later   us-east returns: old primary must NOT rejoin as primary (split brain);
        rebuild it as a replica (pg_rewind or re-clone), then plan a controlled switchback
        reconcile the lost-write window from logs/outbox/payment provider if needed
```

The expensive lessons live in that timeline: the **RPO is whatever lag you had** (monitor it as an SLO, not a curiosity); the **RTO is dominated by detection and decision**, not by promotion; and the **rejoin** is where split brain happens. Ch 18 covers fencing and rejoin in depth.

### Data residency shapes topology

Residency says "EU personal data stays in the EU". If you geo-partition rows (model B) and pin the EU partition's replicas to EU regions (say Frankfurt, Ireland, Paris), EU data survives the loss of one EU region with RPO 0 — and never leaves the EU. Note what residency forbids: a cheap "replicate everything to us-east for DR" plan. It also reaches beyond the primary copy: backups, WAL archives, logs, analytics exports, caches and support tooling must obey the same boundary. Designs that treat residency as a database setting and forget the backup bucket fail audits.

## 5. Implementation

### Simple example: PostgreSQL with a cross-region async replica and follower-style reads

The most common real multi-region PostgreSQL deployment is model A: a primary in one region with a synchronous standby in another AZ, plus an asynchronous standby in a second region.

```ini
# primary postgresql.conf (us-east)
synchronous_standby_names = 'ANY 1 (use1_az_b, use1_az_c)'   # sync only within the region
synchronous_commit = on
max_wal_senders = 10
wal_keep_size = '16GB'          # or use replication slots + max_slot_wal_keep_size
```

The EU replica connects with `primary_conninfo = '... application_name=euw1'` and is *not* in `synchronous_standby_names`, so commits never wait on the ocean. Measure the RPO you are actually running with:

```sql
-- on the primary: how far behind is each standby?
SELECT application_name, state, sync_state,
       write_lag, flush_lag, replay_lag,
       pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS replay_bytes_behind
FROM pg_stat_replication;
```

```text
 application_name |   state   | sync_state |    write_lag    |    flush_lag    |   replay_lag    | replay_bytes_behind
------------------+-----------+------------+-----------------+-----------------+-----------------+---------------------
 use1_az_b        | streaming | quorum     | 00:00:00.00041  | 00:00:00.00093  | 00:00:00.00125  |                   0
 use1_az_c        | streaming | quorum     | 00:00:00.00038  | 00:00:00.00088  | 00:00:00.00131  |                   0
 euw1             | streaming | async      | 00:00:00.04312  | 00:00:00.04420  | 00:00:00.29830  |             1843200
```

```sql
-- on the EU replica: staleness of what local readers see
SELECT now() - pg_last_xact_replay_timestamp() AS replica_staleness;
```

`replica_staleness` is the number your "EU reads are fresh within N seconds" promise depends on. (On an idle primary it grows even though nothing is missing; emit a heartbeat write every second to keep it meaningful.)

> **MySQL difference:** The equivalent is an async binlog replica in the remote region (GTID-based so it can be re-pointed after failover), with semi-synchronous replication (`rpl_semi_sync_source_wait_for_replica_count`) used inside the region only. MySQL Group Replication in multi-primary mode detects write-write conflicts at certification time and rolls back the loser, but it needs low, stable latency between members and is generally deployed within a region, not across oceans. Aurora MySQL/PostgreSQL Global Database replicates at the storage layer to secondary regions with typical lag around a second.

### Real-world example: a global app on CockroachDB multi-region

A consumer fintech with users in the US, EU and India. Requirements: EU user data stays in the EU; each user's reads and writes are local; survive a full region loss; product catalogue and FX rates readable everywhere with low latency.

```sql
ALTER DATABASE app SET PRIMARY REGION "us-east1";
ALTER DATABASE app ADD REGION "europe-west1";
ALTER DATABASE app ADD REGION "asia-south1";
ALTER DATABASE app SURVIVE REGION FAILURE;      -- default is SURVIVE ZONE FAILURE

-- per-user data: each row homed in the user's region (hidden crdb_region column)
CREATE TABLE users (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email     STRING NOT NULL UNIQUE,
  name      STRING,
  balance   DECIMAL(14,2) NOT NULL DEFAULT 0
) LOCALITY REGIONAL BY ROW;

-- reference data: local, consistent reads everywhere; writes are slow
CREATE TABLE fx_rates (
  pair  STRING PRIMARY KEY,
  rate  DECIMAL(18,8) NOT NULL,
  as_of TIMESTAMPTZ NOT NULL
) LOCALITY GLOBAL;

-- ops/admin table used from one region
CREATE TABLE audit_exports (...) LOCALITY REGIONAL BY TABLE IN "us-east1";
```

What this buys, mechanically:

- A `users` row with `crdb_region = 'europe-west1'` has its leaseholder in Europe. An EU user's `UPDATE users SET name=... WHERE id=...` commits after a quorum — and with `SURVIVE REGION FAILURE` that quorum needs replicas in *other* regions too, so writes pay a cross-region RTT to the nearest other region. With the default `SURVIVE ZONE FAILURE`, the quorum stays inside Europe and writes are local. **That is the survival-vs-latency trade expressed as one line of DDL.**
- `email STRING UNIQUE` on a REGIONAL BY ROW table means a uniqueness check across all regions on insert — a cross-region round trip for signups. (Using a UUID primary key avoids this for the PK; CockroachDB can skip the global check when the unique column includes `crdb_region` or is a generated UUID.)
- `fx_rates` as GLOBAL: every region serves consistent reads locally; a rate update takes hundreds of ms because the writer commits at a future timestamp and waits for it to pass. Perfect for data updated a few times a minute and read on every request.

For reads that tolerate a few seconds of staleness:

```sql
-- follower read: any nearby replica, consistent snapshot a few seconds old
SELECT name, balance FROM users AS OF SYSTEM TIME follower_read_timestamp() WHERE id = $1;

-- bounded staleness: at most 10 s old, served locally if possible
SELECT rate FROM fx_rates AS OF SYSTEM TIME with_max_staleness('10s') WHERE pair = 'EURUSD';
```

**Residency** comes from a stricter placement: `ALTER DATABASE app PLACEMENT RESTRICTED` keeps REGIONAL BY ROW data's replicas only in its home region (you give up surviving that region's loss for those rows — residency and survivability collide unless you have several regions inside the jurisdiction).

### The same idea at the application layer: region-homed routing

Without a geo-partitioning database, you build model B in the app: one PostgreSQL cluster per region (a "cell"), and a small global directory mapping user → home region.

```python
# minimal region router: the directory is small, globally replicated, read-mostly
HOME_DSN = {
    "us": "postgresql://app@pg-us-east.internal/app",
    "eu": "postgresql://app@pg-eu-west.internal/app",
    "in": "postgresql://app@pg-ap-south.internal/app",
}

def home_region(user_id: str) -> str:
    # directory lookup, cached in-process for minutes; changes only on re-homing
    return directory_cache.get_or_load(user_id)

def update_profile(user_id: str, name: str):
    region = home_region(user_id)
    with pool_for(HOME_DSN[region]).connection() as conn:   # write goes to the home cell
        conn.execute("UPDATE users SET name = %s WHERE id = %s", (name, user_id))
```

Re-homing a user (they moved from Berlin to Boston) is a small migration: freeze writes for that user, copy rows to the new cell, flip the directory entry, unfreeze. Cross-cell operations (an EU user pays a US user) become sagas or outbox-driven workflows (Ch 13, Ch 29).

### Multi-leader on PostgreSQL: know what you are signing up for

PostgreSQL's built-in logical replication can be configured in both directions, and PG 16 added `origin = none` on subscriptions to stop changes looping back:

```sql
-- on eu (and the mirror on us):
CREATE SUBSCRIPTION from_us CONNECTION 'host=pg-us ... dbname=app'
  PUBLICATION app_pub WITH (origin = none, copy_data = false);
```

But core PostgreSQL does **not resolve conflicts**: an insert that collides on a primary key or an update to a missing row raises an error and **stops the apply worker** until a human fixes it, and concurrent updates to the same row are applied in arrival order (a de facto LWW with no timestamps). Production multi-master PG uses extensions/products (pgactive, EDB Postgres Distributed) with explicit conflict handlers, or — more often — avoids same-row multi-region writes entirely by partitioning ownership.

### DynamoDB global tables and Spanner, briefly

**DynamoDB global tables** (default multi-Region eventual consistency mode): every replica Region accepts reads and writes; changes replicate asynchronously, typically within about a second; conflicts resolve with **last writer wins** on the whole item. Conditional writes (`ConditionExpression`) are evaluated only in the Region that receives them, so two Regions can both pass `attribute_not_exists(pk)` — "unique" is not unique across Regions. AWS has also added a multi-Region *strong* consistency mode for global tables; it requires a specific Region configuration and trades write latency for it, so read the current docs before relying on it.

**Spanner** is the other extreme: every read-write transaction is externally consistent across regions. Multi-region instance configurations place read-write replicas in two regions plus a **witness** replica in a third to form a Paxos majority, with a **default leader region** where writes are fastest. Writes from far regions pay RTT to the leader and quorum; stale reads (`exact_staleness`, `max_staleness`) are served by the nearest replica.

## 6. Advantages, Disadvantages & Trade-offs

| Design | Write latency (remote user) | Read latency | Conflicts | Region-loss RPO | Residency support | Complexity |
| --- | --- | --- | --- | --- | --- | --- |
| Single region, multi-AZ | +RTT to region | +RTT | none | total loss of region = outage (restore from backups) | trivially one place | low |
| Home region + async DR replica | +RTT to home | local (stale) or +RTT | none | = replication lag | awkward (replica is a copy) | low-medium |
| Geo-partitioned (per-row home) | local for home rows | local | none | 0 with in-home quorum across ≥3 regions; else lag | natural | medium-high |
| Quorum across 3 regions | +1 RTT to nearest region | local via lease/follower reads | none | 0 | hard | medium |
| Multi-leader async (LWW) | local | local | yes, lossy | un-replicated writes in lost region | hard | medium + data-loss risk |
| Multi-leader + CRDT/app merge | local | local | yes, merged | un-replicated writes | hard | high |

### When to use

- **Home region + async DR** — the default for most products: one write region, regional failover as a runbook, RPO of seconds accepted and measured.
- **Geo-partitioning** — users cluster by geography, you have residency obligations, or remote write latency is a product problem.
- **Cross-region quorum** — RPO must be zero for a region loss (payments, ledgers, identity) and a few tens of ms per write is acceptable.
- **Multi-leader** — offline-capable or write-anywhere data that merges naturally (carts, collaborative documents with CRDTs, presence, counters, user settings where a lost concurrent edit is tolerable).

### When NOT to use

- **Not multi-leader** for anything with an invariant: balances, inventory, bookings, uniqueness. LWW will lose money quietly.
- **Not cross-region synchronous replication** in a chatty, multi-statement OLTP path — ten sequential statements × 80 ms is nearly a second.
- **Not multi-region at all** if the requirement is really "survive an AZ failure"; multi-AZ does that at a fraction of the cost and latency.
- **Not "replicate everything everywhere"** when residency applies.

## 7. Common Mistakes & Best Practices

- **Quoting "active-active" without naming the conflict policy.** Teams enable DynamoDB global tables or bidirectional replication and assume writes are safe. *Why it hurts:* concurrent writes silently vanish under LWW. *Instead:* list which items can be written from two regions concurrently; for each, choose single-home, CRDT or app merge.
- **Enforcing invariants with conditional writes in multi-leader systems.** *Why it hurts:* each region evaluates the condition against its own copy — two regions both see stock = 1. *Instead:* route invariant-guarded writes to one home region.
- **Chatty transactions across regions.** *Why it hurts:* each statement pays an RTT; ORMs issuing 30 queries per request multiply it. *Instead:* move compute next to the data's home region, batch, or use stored procedures/CTEs for multi-step writes.
- **Never measuring the RPO you actually run with.** *Why it hurts:* lag spikes to minutes during a batch job, and that is exactly when disasters strike. *Instead:* alert on cross-region `replay_lag` and heartbeat staleness as an SLO.
- **Automatic cross-region failover on a single signal.** *Why it hurts:* a transient trans-oceanic blip triggers a promotion and creates two primaries. *Instead:* automate within a region; make cross-region failover a fast, rehearsed, human-approved runbook (or use a consensus system that makes it safe).
- **Forgetting the non-database state.** *Why it hurts:* the DB fails over but caches, queues, secrets and object storage are still single-region. *Instead:* DR plans cover the whole stack and are game-dayed.
- **Using wall-clock timestamps for ordering across regions.** *Why it hurts:* clock skew reorders events. *Instead:* hybrid logical clocks, version vectors, or a single sequencer per item.
- **Best practice:** classify every table as *regional (single home)*, *geo-partitioned*, *global (read-mostly)*, or *mergeable (multi-leader)*, and put that classification in the schema docs.

## 8. Production: Failure Scenarios, Monitoring & Scaling

### Failure scenarios

**The silent lost update.** On a Tuesday afternoon, support gets tickets that shipping addresses "revert". Root cause: the mobile app writes via the nearest region (DynamoDB global tables), and a background sync job in another region rewrites the whole profile item from a slightly stale copy; LWW picks the job's later timestamp. Fix: the job does targeted `UpdateExpression`s on the fields it owns, profile writes go through the user's home region, and a version attribute with conditional writes guards against stale overwrites within that region.

**The lag cliff during a regional outage.** At 2am a nightly bulk update generates 40 GB of WAL; the EU replica's replay lag climbs to 11 minutes. At 2:20 the US region has a power event. Promoting EU loses 11 minutes of orders. Root cause: the RPO was never a monitored SLO. Fix: throttle bulk jobs (batch + sleep), alert on lag > 30 s, and use larger replica instances so replay keeps up.

**Signup latency tripled after going multi-region.** p99 signup went from 40 ms to 260 ms. Root cause: a `UNIQUE(email)` on a REGIONAL BY ROW table requires a cross-region uniqueness check on every insert. Fix: accept it for signup (rare path), or partition the uniqueness space (email domains homed per region are not safe; instead a small global `emails` table with the check done once).

**Split brain after failback.** The old US primary returned and, because a config management run restarted it with its old config, briefly accepted writes from a batch worker still pointed at it. Fix: fencing (revoke the old primary's network access or credentials during failover), make promotion change a single endpoint of truth, and rebuild the old primary as a replica with `pg_rewind` before it serves anything (Ch 18).

### What to monitor

| Metric | Source | Why |
| --- | --- | --- |
| Cross-region replication lag (bytes and seconds) | `pg_stat_replication`, heartbeat table, CloudWatch `AuroraGlobalDBReplicationLag`, DynamoDB `ReplicationLatency` | your live RPO |
| Inter-region RTT and packet loss | network probes | explains latency shifts and quorum slowdowns |
| p99 latency by (client region, data home region) | app metrics | reveals rows homed in the wrong place |
| Conflict counts / apply errors | pgactive/PGD conflict logs, logical replication worker errors in `pg_stat_subscription_stats` | multi-leader health |
| Leaseholder/leader placement per region | CockroachDB/Spanner consoles | leaders drifting away from users |
| Residency audit: replica, backup, log locations | infra inventory | compliance |

### Scaling notes

Multi-region scales reads well (add replicas near users) and writes well only with geo-partitioning. Adding a region to a quorum-based cluster changes quorum math: going from 3 to 5 regions lets you survive 2 region failures but a majority now needs 3 regions, which usually means a *farther* third region on the write path. Measure before and after.

## 9. Interview Questions

**Q: What is the difference between multi-AZ and multi-region, and which do most systems need?**
A: Multi-AZ places replicas in separate datacenters within one region, a few milliseconds apart, so synchronous replication is cheap and you survive node and AZ failures with zero data loss. Multi-region places replicas hundreds or thousands of kilometres apart, so synchronous replication costs tens of milliseconds per commit, but you survive a whole region failing. Most outages are node- or AZ-scoped, so most systems need multi-AZ for HA. Multi-region is usually added as asynchronous disaster recovery, and only systems with strict region-loss RPO or global latency needs pay for synchronous cross-region quorums.

**Q: Why can't you make cross-region synchronous replication fast?**
A: Because the latency is set by the speed of light in fibre, roughly 1 ms of round trip per 100 km in the ideal case and more on real paths. A commit that must be acknowledged by another region costs at least one round trip, 60–100 ms between US coasts or across the Atlantic, and a transaction with several sequential writes pays it several times. Faster CPUs or disks do not change it. The only levers are to avoid needing a remote acknowledgement (async, geo-partitioning) or to need fewer round trips per transaction (batching, co-locating compute with data).

**Q: What are follower reads and bounded-staleness reads, and when are they appropriate?**
A: A follower read is served by a nearby non-leader replica at a timestamp known to be fully replicated, so it returns a consistent snapshot that is slightly old without contacting the leader. A bounded-staleness read guarantees the data is no older than a stated bound, serving locally when the replica is fresh enough. They are appropriate for catalogue data, dashboards, feeds, and any read where a few seconds of staleness is acceptable and local latency matters. They are wrong for read-after-write flows and for reads that feed a write decision guarded by an invariant.

**Q: Explain last-writer-wins and why it loses data?**
A: LWW attaches a timestamp to each write and, when two replicas have conflicting versions, keeps the one with the highest timestamp everywhere. It converges, but the losing write is discarded without any error, so a concurrent update simply disappears. If LWW applies to a whole item, concurrent changes to different fields also clobber each other. And timestamps come from clocks that can be skewed, so the write that really happened later can lose. It is acceptable only when losing a concurrent update does not matter.

**Q: What is a CRDT and what can it not do?**
A: A CRDT is a data type whose merge operation is commutative, associative and idempotent, so replicas that receive the same set of updates in any order converge to the same state without coordination. Examples are grow-only and PN counters, observed-remove sets and per-field registers. They let you accept writes in every region without losing updates. What they cannot do is enforce invariants that need coordination: two regions can each decrement a stock counter from 1 and the merged value is -1. They also only fit certain data shapes and carry metadata overhead.

**Q: How would you design writes for a global social app with users in the US, EU and Asia?**
A: I would geo-partition user-owned data: each user has a home region, and their profile, posts and settings are written there with local latency and a single leader per row, so there are no conflicts. Reads of other users' content come from local replicas or follower reads with bounded staleness, since feeds tolerate seconds of lag. Counters like likes can be CRDT or per-region counters summed on read. Global uniqueness, such as usernames, lives in a small globally consistent table and pays cross-region latency only on signup and rename. Region loss is covered by replicating each home region's data to another region, choosing sync or async per the RPO.

**Q: How does DynamoDB global tables handle a conditional write that two regions receive at the same time?**
A: In the default multi-Region eventually consistent mode, each Region evaluates the condition against its own local copy of the item and applies the write if the condition passes. Replication is asynchronous, so both Regions can pass the same `attribute_not_exists` or version check, and when the writes replicate, last-writer-wins keeps one and discards the other. That means conditional writes do not provide cross-Region uniqueness or compare-and-set. The fix is to route writes for a given item to one Region, or use a strongly consistent mode where available and accept its latency.

**Q: Your RPO for a region failure is "under 5 seconds" and you use async replication. How do you know you meet it? (Senior)**
A: I would treat replication lag as an SLO with a measured distribution, not a dashboard curiosity. On PostgreSQL, measure `replay_lag` and bytes behind in `pg_stat_replication`, plus a heartbeat row written every second on the primary and read on the replica, because an idle primary makes timestamp-based lag misleading. Alert well below the RPO, for example at 2 seconds sustained. Then find the lag drivers — bulk jobs, vacuum of large tables, index builds, replica under-provisioning — and throttle or schedule them. Finally, test it: a game day that cuts the primary region and measures how many acknowledged writes are missing after promotion.

**Q: Design the data layer for a payment ledger that must survive a region loss with zero data loss. (Senior)**
A: Zero RPO on region loss requires that a commit is durable in at least two regions before it is acknowledged, so I would use a quorum across three regions, for example a distributed SQL database or Spanner-like system with replicas in three regions, or a PostgreSQL primary with a synchronous standby in a second region. The ledger has invariants, so each account has exactly one leader; no multi-leader writes. I would place the leader region near most write traffic and keep transactions short and single-round-trip where possible, because each commit costs a cross-region RTT. Reads for statements and dashboards use follower or bounded-staleness reads. I would also make the API idempotent with keys so client retries during failover don't double-post, and rehearse region failure regularly.

**Q: How do data residency requirements interact with high availability? (Senior)**
A: Residency restricts where replicas, backups and logs may live, which restricts which failures you can survive. If EU data must stay in the EU and you have only one EU region, you cannot survive that region's loss without breaking residency, so you need at least two or three EU regions for regional survivability. In CockroachDB terms, restricted placement keeps a row's replicas in its home region and forfeits region-failure survival for those rows. Residency also covers the non-obvious copies: WAL archives, snapshots, analytics exports, cache clusters and support tooling. I would model it per table and audit actual replica and backup locations continuously.

**Q: Why does a GLOBAL table in CockroachDB make reads fast and writes slow? (Senior)**
A: A global table is designed so every replica can serve consistent reads locally without contacting the leaseholder. To make that safe, writes are committed at a timestamp in the future, and the writer waits until that timestamp has passed everywhere, accounting for clock uncertainty, before acknowledging. Readers at the present time therefore never encounter a write that another region could still be deciding. The cost is that writes take hundreds of milliseconds. It is the right choice for read-mostly reference data like currencies, plans and feature configuration.

**Q: After a regional failover, the old primary comes back. What must happen before it serves traffic?**
A: It must be fenced so it cannot accept writes, because clients or batch jobs may still point at it and a second writable primary is split brain. Its WAL has diverged from the new primary at the failover point, including writes that were never replicated, so it must be rewound with pg_rewind or re-cloned from the new primary and started as a replica. The lost writes from the divergence window should be extracted for reconciliation if the business needs them. Only after it has caught up as a replica do you plan a controlled switchback, if you want one at all.

## 10. Quick Revision & Cheat Sheet

| Concept | Remember |
| --- | --- |
| RTT physics | ~1 ms per 100 km of fibre (ideal); US coasts ~65 ms, US–EU ~80 ms, US–Asia ~200+ ms |
| Multi-AZ | sync, ~1 ms, survives AZ; the default HA |
| Multi-region async | RPO = lag at failure; RTO = detection + decision |
| Quorum across regions | RPO 0; +1 RTT to nearest other region per commit |
| Global reads | local replicas (stale), follower reads (snapshot), bounded staleness (N s) |
| Global writes | single home · geo-partitioned rows · multi-leader |
| Conflicts | LWW (lossy) · CRDT (converges, no invariants) · app merge (work) |
| DynamoDB global tables | multi-active, async, LWW; conditions are per-Region |
| Aurora Global Database | one writer Region, storage-level replication ~1 s, managed failover |
| CockroachDB | REGIONAL BY ROW / BY TABLE / GLOBAL; SURVIVE ZONE vs REGION FAILURE |
| Spanner | Paxos across regions, leader region, witness replicas, stale reads |

- Pick a write model per table, not per database.
- Anything with an invariant gets one leader per item.
- Measure cross-region lag as your live RPO.
- Cross-region failover is a rehearsed runbook; in-region failover is automated.
- Residency applies to backups, logs and caches too.
- Every sequential statement in a transaction pays the RTT again.
- Clock timestamps are not a safe ordering across regions.

## 11. Hands-On Exercises

1. **Simulate cross-region latency.** Run two `postgres:17` containers (primary and replica) on a Docker network and add latency on the replica's interface: `docker exec --privileged replica tc qdisc add dev eth0 root netem delay 40ms` (≈80 ms RTT). Set up streaming replication and observe `write_lag`/`replay_lag` in `pg_stat_replication`.
2. **Sync vs async cost.** On the same setup, add the replica to `synchronous_standby_names` and run `pgbench -c 8 -T 30 -N`. Compare TPS and latency with async. Then try `SET synchronous_commit = local` in a session and measure again.
3. **Measure your RPO.** Create a `heartbeat(ts)` table updated every 100 ms on the primary; during a heavy `UPDATE` on a big table, sample `now() - max(ts)` on the replica and plot it.
4. **LWW data loss.** Using two containers with bidirectional logical replication (`origin = none`, PG 16+), update the same row on both within a short window and inspect the result and the subscription error behaviour (check the server log and `pg_stat_subscription_stats`).
5. **Geo-partitioning in CockroachDB.** `cockroach demo --global --nodes 9` simulates three regions with latency. Create a REGIONAL BY ROW table and a GLOBAL table, and compare write and read latencies from each region, then flip `SURVIVE REGION FAILURE` and measure again.

**Mini project — "Region planner".** Write a small script that takes a list of tables with (write QPS by region, read QPS by region, invariant yes/no, residency constraint) and outputs a recommended model per table (single-home, geo-partitioned, global, mergeable), the expected p50 write latency per region from an RTT matrix, and the region-loss RPO. Validate two of its recommendations against measurements from exercise 5.

## 12. Related Topics & Free Learning Resources

**This handbook:** [Ch 09 · Database Replication](topic.html?p=09-replication) · [Ch 10 · Consistency Models](topic.html?p=10-consistency-models) · [Ch 13 · Distributed Transactions](topic.html?p=13-distributed-transactions) · [Ch 14 · CAP Theorem](topic.html?p=14-cap-theorem) · [Ch 15 · Consensus](topic.html?p=15-consensus) · [Ch 16 · Distributed Database Architecture](topic.html?p=16-distributed-database-architecture) · [Ch 18 · High Availability](topic.html?p=18-high-availability) · [Ch 26 · Backup & Disaster Recovery](topic.html?p=26-backup-disaster-recovery) · [Ch 29 · Advanced Database Patterns](topic.html?p=29-advanced-database-patterns)

**Other handbooks:** [System Design · CAP & Consistency](../system-design/topic.html?p=19-cap-consistency) · [System Design · Database Scaling](../system-design/topic.html?p=16-database-scaling) · [Cassandra · Multi-Datacenter](../cassandra/topic.html?p=32-multi-datacenter) · [Caching with Redis · Consistency Models](../redis-caching/topic.html?p=13-consistency-models)

- **CockroachDB Multi-Region Capabilities Overview** — Cockroach Labs docs · *Intermediate* · survival goals, table localities and their latency consequences. <https://www.cockroachlabs.com/docs/stable/multiregion-overview>
- **DynamoDB Global Tables** — AWS docs · *Intermediate* · how replication, conflict resolution and consistency modes work across Regions. <https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GlobalTables.html>
- **Using Amazon Aurora Global Database** — AWS docs · *Intermediate* · storage-level cross-Region replication, switchover and failover. <https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database.html>
- **Spanner: Google's Globally-Distributed Database** — Corbett et al., OSDI 2012 · *Advanced* · TrueTime and why external consistency across regions is possible. <https://static.googleusercontent.com/media/research.google.com/en//archive/spanner-osdi2012.pdf>
- **A comprehensive study of Convergent and Commutative Replicated Data Types** — Shapiro, Preguiça, Baquero, Zawirski (INRIA, 2011) · *Advanced* · the foundational CRDT catalogue. <https://inria.hal.science/inria-00555588/document>
- **PostgreSQL: Logical Replication** — PostgreSQL docs · *Intermediate* · publications, subscriptions, `origin`, and how conflicts stop replication. <https://www.postgresql.org/docs/current/logical-replication.html>
- **Designing Data-Intensive Applications, ch. 5 (multi-leader, leaderless)** — Martin Kleppmann · *Advanced* · the clearest treatment of conflict detection and resolution. <https://dataintensive.net/>

---

*Database Design Handbook — chapter 17.*
