# 10 · Consistency Models: Where Do You Need Strong?

> **In one line:** A consistency model is a promise about what a reader can observe when data lives in more than one place, and the senior question is never "do we need consistency?" but "*where* do we need strong consistency, where is a session guarantee enough, and where is eventual fine?" — because every step up the ladder is paid for in latency, availability and money.

---

## 1. Overview

> **Builds on:** [Ch 09 · Replication](topic.html?p=09-replication) (lag, sync vs async, read replicas) · [Ch 06 · Isolation Deep Dive](topic.html?p=06-isolation-deep-dive) (isolation governs concurrent transactions on one node; this chapter governs reads across copies). The SQL Handbook has no replication chapter; the cache-side view of the same ideas lives in [Caching with Redis · Consistency Models](../redis-caching/topic.html?p=13-consistency-models) — this chapter takes the database/replica angle and does not repeat it.

Here are three bug reports from the same week at a growing social app:

1. "I changed my display name, the page reloaded, and my old name was back. I changed it again. Now I've been charged twice for the name-change fee."
2. "I refreshed my notifications and a comment appeared. I refreshed again and it disappeared. Then it came back."
3. "My friend's reply showed up in my feed before the post it was replying to."

Nothing crashed, no data was lost, and every replica eventually held the right data. Each bug is a violation of a specific, nameable **consistency guarantee** — read-your-writes, monotonic reads, and causal consistency respectively — caused by reading from replicas that were at different points in the primary's history. The team had added read replicas for scale (a good decision) without deciding *which reads needed which guarantee* (a missing decision).

The naive reactions both fail. **"Make everything strongly consistent"** — send every read to the primary, or make every write synchronous everywhere — throws away the read scaling you added replicas for, adds latency to every request, and in a multi-region or partitioned system makes you unavailable whenever the network misbehaves. **"Eventual consistency is fine, it converges"** ignores that users don't experience convergence; they experience individual reads, and a single read that travels back in time looks like a bug. What works is to treat consistency as a **per-operation design decision**: identify the few places where a stale read causes real harm (money, inventory, security, a user seeing their own action undone), give those strong or session guarantees, and let everything else be eventual. That act of drawing lines is designing **consistency boundaries**, and it is the practical skill this chapter teaches.

> **Why this matters:** Consistency is where database design meets product experience. Users forgive a like count that lags by a second; they do not forgive a balance that goes up after they spent money, or a saved setting that silently reverts. Knowing which is which — and which mechanism provides each guarantee — is a core system-design interview skill and a daily production one.

## 2. Core Concepts

- **Consistency model** — a contract about which values reads may return given the history of writes. *Why it matters:* it turns "the data looks weird" into a precise, testable property.
- **Linearizability (strong consistency)** — every operation appears to take effect atomically at a single instant between its start and end; once a write completes, every later read (by anyone) sees it. *Why it matters:* it behaves like a single copy — and costs coordination on every read.
- **Sequential consistency** — all clients see operations in one total order consistent with each client's program order, but not necessarily real time. *Why it matters:* a weaker cousin of linearizability; rarely offered as a database setting, useful to recognise.
- **Causal consistency** — if operation A could have influenced B (B read A's result, or the same client did A then B), everyone sees A before B. Concurrent operations may be seen in different orders. *Why it matters:* it fixes "reply before post" without global coordination.
- **Eventual consistency** — if writes stop, all replicas eventually converge. No promise about what a read returns meanwhile. *Why it matters:* cheapest and most available; says nothing about any single read.
- **Read-your-writes (RYW)** — a client always sees its own previous writes. *Why it matters:* the guarantee users notice first; its absence feels like "my save didn't work".
- **Monotonic reads** — once a client has seen a value, it never later sees an older one. *Why it matters:* prevents "time travel" when successive reads hit replicas with different lag.
- **Monotonic writes** — a client's writes are applied everywhere in the order it issued them. *Why it matters:* "set name = A, then name = B" must not end as A.
- **Writes-follow-reads** — a write made after reading X is ordered after X everywhere. *Why it matters:* a reply is never visible before the post it replies to.
- **Session consistency** — the four session guarantees above, scoped to one client session. *Why it matters:* it gives each user a coherent view without global cost.
- **Bounded staleness** — reads may be stale, but by no more than *t* seconds or *k* versions. *Why it matters:* turns "eventual" into an SLO you can monitor.
- **Stale read** — a read that returns a value older than the latest committed write. *Why it matters:* the observable symptom of every weaker model.
- **Consistency boundary** — the line around the data and operations that must be strongly consistent with each other. *Why it matters:* inside it you pay for coordination; outside it you don't.
- **Causality token / LSN token** — a position in the write history (a PostgreSQL LSN, a MySQL GTID set, a MongoDB `operationTime`) carried by the client, so a read can demand "at least this fresh". *Why it matters:* it is the building block of cheap RYW and causal reads.

## 3. Theory & Principles

### Isolation vs consistency: two different questions

Engineers conflate these constantly, so separate them first. **Isolation** ([Ch 06](topic.html?p=06-isolation-deep-dive)) is about *concurrent transactions* on one logical database: can T1 see T2's half-finished work, can two transactions jointly break an invariant. **Consistency models** (in the distributed-systems sense) are about *recency and order* when there are multiple copies: can a read return an old value, can two readers see writes in different orders. A system can be SERIALIZABLE yet serve stale reads from a replica (PostgreSQL SERIALIZABLE on the primary plus async replicas); a system can be linearizable per key but offer no multi-key transactions (etcd without transactions, a Cassandra LWT). **Strict serializability** is the combination — serializable transactions whose order respects real time — which is what Spanner offers ("external consistency") and what a single PostgreSQL primary gives you if you read only from it. And neither is the "C" in ACID, which means "constraints hold".

### The ladder of guarantees and what each costs

Order the models from strongest to weakest and attach the price:

- **Linearizable.** Reads must reflect every completed write, so a read must either go to the one node that orders writes (the leader) *and* that node must be sure it is still the leader (a lease or a quorum round), or it must contact a quorum. Cost: every read pays leader or quorum latency; during a network partition, the minority side must refuse reads and writes to stay correct — the CAP trade in [Ch 14 · CAP Theorem](topic.html?p=14-cap-theorem).
- **Causal.** Each client carries (or the system tracks) dependency metadata; a replica delays showing a write until its dependencies are visible. Cost: metadata and occasional waits; no global coordination, and it remains available during partitions — causal is the strongest model that can stay available under partition.
- **Session guarantees (RYW, monotonic reads, …).** Only *this* client's history matters. Cost: a token per session and routing logic; reads by *other* users may still be stale.
- **Bounded staleness.** Reads are served locally if the replica is within the bound, otherwise redirected or delayed. Cost: lag monitoring and fallback capacity.
- **Eventual.** Read any replica. Cost: nothing at the database; all the cost moves to user confusion and application workarounds.

```svg
<svg viewBox="0 0 880 450" width="100%" height="450" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The consistency ladder: what each rung promises, and what it costs</text>
  <text x="120" y="48" text-anchor="middle" fill="#334155" font-size="11" font-weight="bold">Model</text>
  <text x="380" y="48" text-anchor="middle" fill="#334155" font-size="11" font-weight="bold">Promise to readers</text>
  <text x="630" y="48" text-anchor="middle" fill="#334155" font-size="11" font-weight="bold">Mechanism</text>
  <text x="800" y="48" text-anchor="middle" fill="#334155" font-size="11" font-weight="bold">Cost</text>
  <rect x="20" y="58" width="840" height="58" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="36" y="82" fill="#7f1d1d" font-size="12" font-weight="bold">Linearizable</text>
  <text x="36" y="100" fill="#334155" font-size="9">e.g. balance, inventory, locks</text>
  <text x="250" y="82" fill="#334155" font-size="10">acts like one copy; a completed write</text>
  <text x="250" y="98" fill="#334155" font-size="10">is seen by every later read, anywhere</text>
  <text x="540" y="82" fill="#334155" font-size="10">read the leader (with lease), quorum</text>
  <text x="540" y="98" fill="#334155" font-size="10">reads, sync apply (remote_apply)</text>
  <text x="760" y="82" fill="#7f1d1d" font-size="10">leader/quorum latency</text>
  <text x="760" y="98" fill="#7f1d1d" font-size="10">unavailable in partition</text>
  <rect x="20" y="124" width="840" height="58" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="36" y="148" fill="#92400e" font-size="12" font-weight="bold">Causal</text>
  <text x="36" y="166" fill="#334155" font-size="9">e.g. comments, chat, replies</text>
  <text x="250" y="148" fill="#334155" font-size="10">cause is always seen before effect;</text>
  <text x="250" y="164" fill="#334155" font-size="10">concurrent writes may differ in order</text>
  <text x="540" y="148" fill="#334155" font-size="10">dependency tokens, causal sessions</text>
  <text x="540" y="164" fill="#334155" font-size="10">(MongoDB afterClusterTime)</text>
  <text x="760" y="148" fill="#92400e" font-size="10">metadata, small waits</text>
  <text x="760" y="164" fill="#92400e" font-size="10">stays available</text>
  <rect x="20" y="190" width="840" height="58" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="36" y="214" fill="#5b21b6" font-size="12" font-weight="bold">Session (RYW, monotonic)</text>
  <text x="36" y="232" fill="#334155" font-size="9">e.g. profile, settings, cart</text>
  <text x="250" y="214" fill="#334155" font-size="10">I see my own writes; my view never</text>
  <text x="250" y="230" fill="#334155" font-size="10">goes backwards; others may lag</text>
  <text x="540" y="214" fill="#334155" font-size="10">LSN token routing, pin-to-primary</text>
  <text x="540" y="230" fill="#334155" font-size="10">window, sticky replica</text>
  <text x="760" y="214" fill="#5b21b6" font-size="10">token + router logic</text>
  <text x="760" y="230" fill="#5b21b6" font-size="10">some primary reads</text>
  <rect x="20" y="256" width="840" height="58" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="36" y="280" fill="#1e40af" font-size="12" font-weight="bold">Bounded staleness</text>
  <text x="36" y="298" fill="#334155" font-size="9">e.g. dashboards, search results</text>
  <text x="250" y="280" fill="#334155" font-size="10">stale by at most t seconds</text>
  <text x="250" y="296" fill="#334155" font-size="10">or k versions</text>
  <text x="540" y="280" fill="#334155" font-size="10">route only to replicas with</text>
  <text x="540" y="296" fill="#334155" font-size="10">replay_lag under the bound</text>
  <text x="760" y="280" fill="#1e40af" font-size="10">lag monitoring</text>
  <text x="760" y="296" fill="#1e40af" font-size="10">fallback capacity</text>
  <rect x="20" y="322" width="840" height="58" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="36" y="346" fill="#14532d" font-size="12" font-weight="bold">Eventual</text>
  <text x="36" y="364" fill="#334155" font-size="9">e.g. like counts, view counts</text>
  <text x="250" y="346" fill="#334155" font-size="10">converges if writes stop; any single</text>
  <text x="250" y="362" fill="#334155" font-size="10">read may be arbitrarily old</text>
  <text x="540" y="346" fill="#334155" font-size="10">read any replica / cache</text>
  <text x="540" y="362" fill="#334155" font-size="10">async replication</text>
  <text x="760" y="346" fill="#14532d" font-size="10">cheapest, fastest</text>
  <text x="760" y="362" fill="#14532d" font-size="10">most available</text>
  <text x="440" y="408" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="bold">Each rung up: fewer surprising reads, more coordination per read.</text>
  <text x="440" y="428" text-anchor="middle" fill="#334155" font-size="10">Design question: for THIS operation, what does one stale read cost the user or the business?</text>
</svg>
```

### How replicas produce each anomaly

With a primary and asynchronous replicas (the setup in [Ch 09](topic.html?p=09-replication)), each anomaly has a concrete mechanical cause:

```text
Read-your-writes violation
  t0  client: UPDATE users SET name='Ana B.' -> primary, COMMIT at LSN 5/A000
  t1  client: GET /profile -> load balancer -> replica R1 (replayed up to 5/9F00)
  t1  R1 returns name='Ana'          <- the user's own write is missing

Monotonic-read violation (time travel)
  t0  client reads comments -> replica R1 (replay 5/A100): sees comment #88
  t1  client refreshes     -> replica R2 (replay 5/9E00): comment #88 gone
  t2  client refreshes     -> R1 again: #88 back
  Each replica is internally consistent; the client hopped between two different pasts.

Causal violation (consistent-prefix violation across partitions)
  Post P lives on shard A, reply Q (written after reading P) on shard B.
  Reader's replica of shard B is fresh, replica of shard A is lagging: Q visible, P not.
```

Linearizability is violated by all three, and by a subtler case: two different users. User A completes a write; user B, *after* A's request finished (say A phoned B), reads from a lagging replica and misses it. Session guarantees do not cover this — only linearizability does. That distinction ("my own writes" vs "anyone's completed writes") is exactly the line between session and strong consistency, and it is the right way to decide which one a feature needs.

### Quorums and the R + W > N rule

Leaderless systems (Cassandra, DynamoDB internals, Riak) replicate each item to N nodes and let clients choose how many acknowledge a write (W) and how many answer a read (R). If **R + W > N**, every read quorum overlaps every write quorum in at least one node, so a read will contact at least one replica holding the latest *completed* write. With N = 3, `QUORUM` writes (W = 2) and `QUORUM` reads (R = 2) give R + W = 4 > 3.

That overlap is necessary for fresh reads but **not sufficient for linearizability**. Concurrent writes are resolved by timestamps (last-write-wins), so clock skew can make a later write lose; a write that fails partway may be visible to some reads and not others; and without read repair completing synchronously, two sequential readers can disagree. For true linearizable compare-and-set you need consensus — Cassandra's lightweight transactions use Paxos ([Cassandra · Batches & Lightweight Transactions](../cassandra/topic.html?p=14-batches-lightweight-transactions)). See [Cassandra · CAP & Tunable Consistency](../cassandra/topic.html?p=03-cap-tunable-consistency) for the full tunable-consistency treatment.

## 4. Architecture & Workflow

### Drawing consistency boundaries

The workflow for any feature set:

1. **List the read paths** and, for each, the write that could make it stale.
2. **Ask what one stale read costs.** Money lost or double-spent? A security decision made on old data (revoked permission still honoured)? A user seeing their own action undone? Or a number slightly behind?
3. **Assign the weakest model that makes the cost acceptable** — strong where harm is real, session where only the actor's experience matters, eventual everywhere else.
4. **Pick the mechanism** that provides that model on your stack, and the fallback when it cannot (e.g. replica too far behind).
5. **Monitor the bound** — lag, fallback rate, stale-read rate — because a guarantee you don't measure silently degrades.

Applied to a typical product:

| Data / operation | Harm of one stale read | Model | Mechanism |
|---|---|---|---|
| Account balance before a withdrawal | Overdraft, double spend | Linearizable (+ serializable txn) | Primary read inside the write transaction |
| Inventory at checkout | Oversell | Linearizable | Conditional `UPDATE` on primary |
| Permission / session revocation | Security hole | Linearizable (or bounded, short) | Primary read or short-TTL, invalidated cache |
| My profile right after editing it | "Save didn't work", duplicate edits | Read-your-writes | LSN token or pin-to-primary window |
| My notifications list | Items flicker in and out | Monotonic reads | Sticky replica per session |
| Comment thread | Reply before post | Causal | Carry token of what you read when writing |
| Other users' profiles | Slightly old bio | Eventual (bounded) | Any replica / cache |
| Like and view counts | Off by a few | Eventual | Replica, cache, async counters |
| Analytics dashboard | Minutes old | Bounded staleness | Replica or warehouse with freshness label |

Notice the shape: the **strong** region is small and is almost always *inside a write path* (read-then-decide-then-write). Reads that only *display* data rarely need linearizability; they usually need a session guarantee, if anything.

### LSN-based read routing: read-your-writes without giving up replicas

The most effective session-consistency technique on PostgreSQL is to carry the **commit LSN** as a token. After a write commits, the application records the primary's WAL position; a later read by the same user is sent to a replica only if that replica has replayed at least that far; otherwise it goes to the primary (or waits briefly).

```svg
<svg viewBox="0 0 880 440" width="100%" height="440" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c10a1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="c10a2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
    <marker id="c10a3" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Read-your-writes with an LSN token</text>
  <rect x="30" y="50" width="130" height="60" rx="8" fill="#fff" stroke="#94a3b8"/>
  <text x="95" y="74" text-anchor="middle" fill="#1e293b" font-weight="bold">Client</text>
  <text x="95" y="92" text-anchor="middle" fill="#334155" font-size="10">cookie: min_lsn</text>
  <rect x="250" y="50" width="160" height="60" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="330" y="74" text-anchor="middle" fill="#1e293b" font-weight="bold">App / DB router</text>
  <text x="330" y="92" text-anchor="middle" fill="#334155" font-size="10">knows replicas' replay LSN</text>
  <rect x="560" y="40" width="160" height="50" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="640" y="62" text-anchor="middle" fill="#1e293b" font-weight="bold">Primary</text>
  <text x="640" y="78" text-anchor="middle" fill="#334155" font-size="10">current LSN 5/A000</text>
  <rect x="560" y="120" width="160" height="46" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="640" y="140" text-anchor="middle" fill="#1e293b" font-weight="bold">Replica R1</text>
  <text x="640" y="156" text-anchor="middle" fill="#334155" font-size="10">replayed 5/A040</text>
  <rect x="560" y="180" width="160" height="46" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="640" y="200" text-anchor="middle" fill="#1e293b" font-weight="bold">Replica R2</text>
  <text x="640" y="216" text-anchor="middle" fill="#334155" font-size="10">replayed 5/9F00 (behind)</text>
  <path d="M160,70 L246,70" stroke="#2563eb" stroke-width="2" marker-end="url(#c10a1)"/>
  <text x="203" y="62" text-anchor="middle" fill="#1e40af" font-size="9">1. POST</text>
  <path d="M410,66 L556,62" stroke="#2563eb" stroke-width="2" marker-end="url(#c10a1)"/>
  <text x="484" y="54" text-anchor="middle" fill="#1e40af" font-size="9">2. write + COMMIT</text>
  <text x="484" y="80" text-anchor="middle" fill="#1e40af" font-size="9">3. token = 5/A000</text>
  <path d="M410,100 L556,140" stroke="#16a34a" stroke-width="2" marker-end="url(#c10a2)"/>
  <text x="470" y="136" text-anchor="middle" fill="#14532d" font-size="9">5. GET: R1 &#8805; token, use it</text>
  <path d="M410,106 L556,196" stroke="#dc2626" stroke-width="2" stroke-dasharray="4 3" marker-end="url(#c10a3)"/>
  <text x="452" y="186" text-anchor="middle" fill="#7f1d1d" font-size="9">R2 &lt; token: skip</text>
  <text x="95" y="134" text-anchor="middle" fill="#334155" font-size="10">4. token stored in</text>
  <text x="95" y="148" text-anchor="middle" fill="#334155" font-size="10">session (short TTL)</text>
  <rect x="20" y="246" width="840" height="182" rx="10" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="36" y="266" fill="#1e293b" font-size="12" font-weight="bold">Routing rule for a read carrying token T</text>
  <text x="36" y="288" fill="#334155" font-size="10">a) No token, or token older than every replica's replay LSN: any healthy replica (eventual / bounded).</text>
  <text x="36" y="308" fill="#334155" font-size="10">b) Some replica has replay_lsn &#8805; T: use it (read-your-writes satisfied, replica still does the work).</text>
  <text x="36" y="328" fill="#334155" font-size="10">c) None has caught up: wait up to ~50-100 ms polling, then fall back to the primary.</text>
  <text x="36" y="348" fill="#334155" font-size="10">d) Fallback budget: cap primary fallbacks (rate limit) so a lag spike cannot redirect ALL reads to the primary.</text>
  <text x="36" y="372" fill="#334155" font-size="10">Monotonic reads for free: after every read, raise the token to the LSN you read at, so the next read is never older.</text>
  <text x="36" y="392" fill="#334155" font-size="10">Causal across users: attach the token of what you READ when you WRITE (reply carries the post's LSN).</text>
  <text x="36" y="414" fill="#1e293b" font-size="10" font-weight="bold">Cost: a token per session and a router. Gain: RYW for the actor while replicas still carry most reads.</text>
</svg>
```

Alternatives with different trade-offs:

- **Pin-to-primary window** — after any write, route that user's reads to the primary for *N* seconds (e.g. 5 s, larger than typical p99 lag). Simple; wrong when lag exceeds N; wasteful when lag is 5 ms.
- **Sticky replica** — each session reads from one replica (hash of user id). Gives **monotonic reads** (that replica only moves forward) but **not** RYW; breaks on replica failover.
- **`synchronous_commit = remote_apply`** — the write does not return until synchronous standbys have *replayed* it, so any read on them sees it. Gives RYW (and more) at the cost of commit latency for every write, and only for the synchronous standbys.
- **Read from the primary for the whole "edit" flow** — the edit form and its save confirmation read from the primary; browsing reads go to replicas. Crude, very effective.

### Consistency boundaries and caches

Put a cache in front of the replicas and you add a second staleness source that compounds with replica lag: a cache miss filled from a lagging replica stores the stale value for a full TTL. The cache-side mechanics — staleness budgets, invalidation, and why a cache can never be linearizable — are in [Caching with Redis · Consistency Models](../redis-caching/topic.html?p=13-consistency-models) and [Ch 19 · Database Caching Architecture](topic.html?p=19-database-caching-architecture). The database-side rule: **never fill a cache from a replica for a key that was just written**; fill from the primary or delete-and-let-the-next-read-fill after the replica has caught up.

## 5. Implementation

### Simple example: read-your-writes by LSN in PostgreSQL

On the primary, capture a token right after the write commits:

```sql
BEGIN;
UPDATE users SET display_name = 'Ana B.' WHERE id = 42;
COMMIT;
SELECT pg_current_wal_lsn() AS token;   -- >= this session's commit LSN
```

```text
   token
------------
 5/A0001C28
```

On a replica, check whether it has caught up:

```sql
SELECT pg_last_wal_replay_lsn() >= '5/A0001C28'::pg_lsn AS caught_up;
```

A small Python router implementing the rule from §4 (psycopg 3):

```python
import time
import psycopg

class Router:
    """Routes reads to a replica that has replayed at least the session's token."""

    def __init__(self, primary_dsn: str, replica_dsns: list[str], max_wait_s: float = 0.1):
        self.primary = psycopg.connect(primary_dsn, autocommit=True)
        self.replicas = [psycopg.connect(d, autocommit=True) for d in replica_dsns]
        self.max_wait_s = max_wait_s

    def write(self, sql: str, params=()) -> str:
        with self.primary.transaction():
            self.primary.execute(sql, params)
        # After COMMIT returns, the current WAL position is at or beyond our commit record.
        return self.primary.execute("SELECT pg_current_wal_lsn()::text").fetchone()[0]

    def _caught_up(self, conn, token: str) -> bool:
        return conn.execute("SELECT pg_last_wal_replay_lsn() >= %s::pg_lsn",
                            (token,)).fetchone()[0]

    def read(self, sql: str, params=(), token: str | None = None):
        deadline = time.monotonic() + self.max_wait_s
        while True:
            for r in self.replicas:
                if token is None or self._caught_up(r, token):
                    return r.execute(sql, params).fetchall(), "replica"
            if time.monotonic() >= deadline:
                break
            time.sleep(0.01)
        # No replica caught up in time: fall back to the primary (rate-limit this in production).
        return self.primary.execute(sql, params).fetchall(), "primary"

# Usage in a request handler
router = Router("host=pg1 dbname=app", ["host=pg2 dbname=app", "host=pg3 dbname=app"])
token = router.write("UPDATE users SET display_name = %s WHERE id = %s", ("Ana B.", 42))
session["min_lsn"] = token                      # store in the user's session, short TTL
rows, source = router.read("SELECT display_name FROM users WHERE id = %s", (42,),
                           token=session.get("min_lsn"))
```

In production you would cache each replica's replay LSN (polled every ~50 ms by the router) instead of querying per read, rate-limit primary fallbacks, and expire the token after a few seconds since, beyond the lag tail, every replica satisfies it anyway.

> **MySQL difference:** The token is a **GTID set**. After the write, read `@@gtid_executed` (or enable `session_track_gtids` so the server returns the transaction's GTID in the OK packet), then on the replica run `SELECT WAIT_FOR_EXECUTED_GTID_SET('<gtid_set>', 0.1)` — it returns 0 once the replica has applied it, or 1 on timeout, after which you fall back to the source. MySQL Router and ProxySQL can do GTID-aware routing for you.

### Real-world example: a fintech app — balance vs like count

A fintech app with a social feed: 2 million DAU, 30,000 reads/s and 1,500 writes/s at peak, one PostgreSQL primary with three async replicas and Redis. The consistency map:

- **Balance and transfers — linearizable and serializable.** The transfer reads and writes balances in one transaction on the primary (see [Ch 32 · Banking Ledger](topic.html?p=32-case-banking)). The *balance display* on the home screen is a different question: showing a balance 300 ms old is acceptable for display, but **not** immediately after the user's own transfer. So the home screen reads from replicas **with the LSN token** — RYW for the actor, replicas for everyone else. The "available to spend" check before a transfer never reads a replica.
- **Transaction history — read-your-writes + monotonic.** Token routing, and the token is raised after each read so pull-to-refresh never shows fewer transactions than the last refresh.
- **Card freeze / permission changes — strong.** A frozen card must be refused immediately by the authorization service; it reads the card state from the primary (or a cache invalidated synchronously on write). A stale read here is a security and money bug.
- **Likes on social posts — eventual.** Counts come from Redis counters flushed to the database asynchronously; a like count off by a few for a few seconds harms no one. The user's *own* like is shown optimistically by the client.
- **Comments — causal.** A reply carries the LSN of the post it replies to; the feed reader only renders a reply once its source post is readable at that replica (or fetches the post from the primary).

The measurable result of drawing these boundaries: around 94% of reads stay on replicas or cache, the primary handles writes plus the small strong-read set, and the three bug reports from §1 disappear.

### Other databases: the same decisions, different knobs

```text
DynamoDB
  GetItem / Query with ConsistentRead=true   -> strongly consistent read of the base table
                                                (reads the latest acknowledged write; 2x read-capacity cost)
  Default (eventually consistent)            -> half the cost, may be stale for a short time
  Global secondary indexes                   -> always eventually consistent; ConsistentRead not supported
  Global tables (multi-region)               -> cross-region replication is asynchronous; conflicts: last writer wins

MongoDB (replica set)
  writeConcern: {w: "majority"}              -> write acknowledged once durable on a majority
  readConcern: "majority"                    -> read only majority-committed data (never rolled back)
  readConcern: "linearizable"                -> single-document linearizable read on the primary (slow)
  causally consistent session                -> session.advanceClusterTime / afterClusterTime:
                                                RYW, monotonic reads/writes, writes-follow-reads,
                                                even when reading from secondaries (with majority concerns)

Cassandra (RF = 3)
  write QUORUM + read QUORUM                 -> R + W = 4 > 3: reads see completed writes (not linearizable)
  write ONE + read ONE                       -> fast, eventual
  LOCAL_QUORUM                               -> quorum within the local DC; other DCs eventual
  IF NOT EXISTS / IF col = x (LWT)           -> Paxos; linearizable per partition; much slower
```

## 6. Advantages, Disadvantages & Trade-offs

| Mechanism | Guarantee | Extra latency | Primary load | Breaks when |
|---|---|---|---|---|
| All reads on primary | Linearizable (single node) | None | All reads | Read load exceeds one node |
| `remote_apply` sync standbys | Linearizable reads on sync standbys (for completed writes) | Replay time on every commit | Low | A sync standby is slow or down |
| LSN / GTID token routing | Read-your-writes, monotonic (if token raised), causal (if propagated) | Small wait on fallback | Only lagging-case fallbacks | Router bugs; fallback storm on large lag |
| Pin-to-primary after write | RYW (probabilistic) | None | Recently-writing users | Lag longer than the window |
| Sticky replica | Monotonic reads | None | None | Replica failover; no RYW |
| Bounded staleness routing | Staleness ≤ bound | None | Fallbacks when all replicas exceed bound | Everything lags at once |
| Any replica / cache | Eventual | None | None | Users notice anomalies |
| Quorum R + W > N | Read sees completed writes | Quorum round trips | N/A (leaderless) | Concurrent writes, clock skew (LWW) |

### When to use strong consistency

- Inside **read-decide-write** paths guarding money, inventory, uniqueness, quotas and permissions.
- For **security-relevant reads** (revocations, account locks, card freezes).
- For **coordination** data: leader election, locks, configuration that must not diverge (this is what etcd/ZooKeeper exist for — [Ch 15 · Consensus](topic.html?p=15-consensus)).

### When NOT to

- **Not for display-only reads** where a session guarantee suffices — you would be paying linearizable prices for a UX problem that a token solves.
- **Not for high-volume counters and feeds** — likes, views, follower counts, recommendations.
- **Not across regions by default** — a linearizable cross-region read costs a cross-region round trip and fails under partition ([Ch 17 · Multi-Region Databases](topic.html?p=17-multi-region-databases)).
- **Not "eventual" for anything a user just changed themselves** — that is where eventual consistency is most visible and least forgiven.

## 7. Common Mistakes & Best Practices

- **Asking "do we need consistency?" for the whole system.** It produces either an over-coordinated slow system or an under-protected buggy one. Instead, classify each operation by the harm of one stale read and assign models per operation.
- **Randomly load-balancing reads across replicas.** It violates monotonic reads for every user whenever replicas differ in lag. Instead, use sticky replicas or raise an LSN token after each read.
- **Reading from a replica inside a write decision.** "Check balance on replica, then debit on primary" is a correctness bug, not a staleness nuisance. Instead, read inside the write transaction on the primary, or use a conditional `UPDATE`.
- **Filling caches from replicas right after writes.** It locks stale data into the cache for a full TTL. Instead, fill from the primary for recently-written keys or delete after the replica catches up.
- **Token routing with unlimited fallback.** A replica lag spike sends 100% of token-carrying reads to the primary, which then falls over. Instead, rate-limit fallbacks, wait briefly first, and shed or degrade before overloading the primary.
- **Believing QUORUM means linearizable.** Last-write-wins with clock skew, partial writes and concurrent updates break it. Instead, use LWT/consensus for compare-and-set semantics.
- **Forgetting secondary indexes and derived stores.** DynamoDB GSIs, search indexes, materialized views and CDC-fed read models are eventually consistent even if the base table read is strong. Instead, document the model per read path, including derived ones.
- **Best practice:** write a one-page consistency map for every service — each read path, its model, its mechanism, its monitored bound — and review it whenever you add a replica, a cache or a region.

## 8. Production: Failure Scenarios, Monitoring & Scaling

### Failure scenarios

**The fallback storm.** At 11:00 a backfill job generates heavy WAL; replica replay lag rises to 40 s. Every user who wrote something in the last 40 s carries a token no replica satisfies, and token routing sends their reads to the primary. Symptom: primary CPU jumps from 35% to 100%, write latency degrades for everyone. Root cause: unbounded fallback turning a replica problem into a primary outage. Fix: rate-limit fallbacks (a token bucket per app instance), prefer a short wait, degrade non-critical reads to "possibly stale" with a UI hint, and throttle the backfill by watching `replay_lag`.

**Double charges from a stale read.** A subscription service checks "has this user already paid for this period?" against a replica before charging. Under lag, a retried request sees no payment and charges again. Root cause: a read that guards a write was sent to a replica. Fix: move the check into the write path on the primary with a unique constraint on `(user_id, period)`; the replica read was never a valid guard.

**Notifications flicker after a replica is replaced.** Symptom: support tickets about items vanishing. Root cause: sticky-replica routing re-hashed users onto a new, slightly-behind replica after a replica swap. Fix: carry an LSN token raised after each read so the new replica is only used once it has caught up to the user's last view.

**Revoked access still works.** A permission revocation is written to the primary; the API gateway reads permissions from a cache filled from a replica with a 5-minute TTL. Symptom: an offboarded employee keeps access for minutes. Root cause: a security decision on an eventual path. Fix: permission checks read from the primary (or a cache invalidated synchronously on revocation), with a short TTL as a backstop.

**Cassandra reads miss recent writes.** Writes at `ONE`, reads at `QUORUM`: R + W = 3, not > 3. Symptom: occasional missing messages. Fix: make the pair consistent (`QUORUM`/`QUORUM`, or `LOCAL_QUORUM` pairs), and understand the cost in latency and availability.

### What to monitor

- **Replica lag** (bytes and `replay_lag`, [Ch 09](topic.html?p=09-replication)) against each read path's staleness budget.
- **Primary fallback rate** for token routing, and fallback rejections by the rate limiter.
- **Stale-read rate**: sample reads and compare the returned version/`updated_at` with the primary, or log how often a token-carrying read found no caught-up replica.
- **Read distribution**: share of reads served by primary vs replicas vs cache — a creeping primary share signals over-strict routing.
- **Session-token age distribution**, to tune expiry.
- **Business invariants** (no overdrafts, no duplicate charges) as the final check that strong paths are really strong.

### Scaling notes

Consistency boundaries are what let a system scale: the strong core stays small enough for one primary (or one shard's leader), while replicas, caches and derived stores absorb the eventually-consistent bulk. As you shard ([Ch 12 · Sharding](topic.html?p=12-sharding)), keep each strong boundary inside one shard — an account and its ledger on the same shard — so strong operations never need cross-shard coordination. As you go multi-region, strong consistency across regions requires consensus with cross-region round trips (Spanner, CockroachDB), so most designs home each user's strongly consistent data in one region and replicate the rest asynchronously ([Ch 17](topic.html?p=17-multi-region-databases), [Ch 14 · CAP Theorem](topic.html?p=14-cap-theorem)).

## 9. Interview Questions

**Q: What is the difference between linearizability and read-your-writes?**
A: Read-your-writes is a session guarantee: a client always sees its own completed writes, but other clients may still see stale data. Linearizability is global: once any write completes, every later read by anyone reflects it, as if there were a single copy. The practical test is two users — if user A saves and then tells user B, must B see it? If yes, you need linearizability; if only A must see it, read-your-writes suffices and is much cheaper, because it can be served by any replica that has caught up to A's write.

**Q: How is a consistency model different from an isolation level?**
A: An isolation level describes how concurrent transactions interact on one logical database — whether one transaction can see another's uncommitted or concurrent writes, and whether they can jointly break invariants. A consistency model describes what reads can return when data has multiple copies — how stale, and in what order writes become visible. They are independent: a PostgreSQL primary running SERIALIZABLE with async replicas is serializable but serves stale reads from replicas. Strict serializability combines both: serializable transactions whose order respects real time.

**Q: A user updates their profile and after reload sees the old version. Explain the cause and two fixes.**
A: The write went to the primary, and the reload's read went to an asynchronous replica that had not yet replayed it — a read-your-writes violation. One fix is token routing: after the write, record the primary's WAL LSN in the user's session and route their reads only to replicas whose replay LSN is at least that, falling back to the primary briefly if none has caught up. Another is a pin-to-primary window, where a user's reads go to the primary for a few seconds after they write. A third is `remote_apply` synchronous replication so the write returns only once standbys have replayed it, at the cost of commit latency.

**Q: What is monotonic reads, and how can load balancing across replicas violate it?**
A: Monotonic reads means once you have seen a value, later reads never return an older one. If successive requests from one user are spread randomly across replicas with different lag, the first read may hit a fresher replica and the next a staler one, so data appears and then disappears. Fixes are sticky routing per session to one replica, or tracking the LSN of each read and requiring later reads to come from replicas at least that fresh.

**Q: Does R + W > N in a quorum system give you strong consistency?**
A: It guarantees that every read quorum overlaps every write quorum, so a read contacts at least one replica that has the latest completed write. That is necessary for fresh reads but not sufficient for linearizability. Concurrent writes are usually resolved by last-write-wins timestamps, so clock skew can discard a later write; partially failed writes can be seen by one reader and not the next; and replicas can disagree until read repair completes. For linearizable operations like compare-and-set you need a consensus protocol, such as Cassandra's Paxos-based lightweight transactions.

**Q: What does DynamoDB's `ConsistentRead=true` give you, and what does it not?**
A: On a base-table `GetItem` or `Query`, it returns a result reflecting all writes acknowledged before the read, at twice the read-capacity cost of the default eventually consistent read. It does not apply to global secondary indexes, which are always eventually consistent, so a query through a GSI can miss a just-written item. It also does not make global tables consistent across regions, since cross-region replication is asynchronous with last-writer-wins conflict resolution. So you use it for the specific base-table reads that guard decisions.

**Q: How do MongoDB causally consistent sessions work?**
A: A causally consistent session tracks the cluster time of the operations it has performed and sends it as `afterClusterTime` on later reads. A secondary serving the read waits until it has applied up to that time before answering. Combined with majority read and write concerns, this gives read-your-writes, monotonic reads, monotonic writes and writes-follow-reads within the session, even when reading from secondaries. It is the same idea as PostgreSQL LSN token routing, built into the driver.

**Q: You're designing a banking app with a social feed. Where do you draw consistency boundaries? (Senior)**
A: I classify reads by the harm of one stale value. Anything that guards money — the available-balance check before a transfer, the transfer itself, limits and card-freeze state — is strongly consistent: read and written on the primary inside one transaction, or via conditional updates, never from a replica or cache. Balance and history displays need read-your-writes and monotonic reads, so I use LSN token routing: the actor sees their own transfer immediately while replicas serve everyone else. Comments get causal consistency by carrying the post's token into the reply. Like counts and feeds are eventual, served from replicas and Redis. I document this as a consistency map, keep each account's strongly consistent data on one shard, and monitor lag, fallback rates and invariants.

**Q: Your LSN-based read routing caused a primary outage during a replication lag spike. What happened and how do you redesign it? (Senior)**
A: When replicas fell tens of seconds behind, every recently-writing user's token was unsatisfiable, so the router sent all those reads to the primary. Read traffic that normally lived on three replicas landed on the primary on top of its write load, saturating it and slowing writes for everyone — a replica problem became a primary outage. The redesign bounds the fallback. First a short wait for a replica to catch up. Then fallbacks limited by a token bucket per app instance. Beyond that, degrade: serve from a replica with a "may be out of date" hint, or rely on client-side optimistic display of the user's own change. I would also alert on lag before it reaches the token horizon and throttle the WAL-heavy job that caused the lag.

**Q: When would you choose `synchronous_commit = remote_apply` over token routing? (Senior)**
A: `remote_apply` makes every commit wait until the synchronous standbys have replayed it, so any read on those standbys immediately reflects all completed writes. That gives linearizable-style reads on those standbys with no routing logic, which is attractive when many different clients must see each other's writes immediately, or when you cannot thread a token through the application — for example, a third-party reporting tool reading a standby. The price is added commit latency for every write, since replay is the slowest stage, and write stalls if a synchronous standby is slow. Token routing only charges readers who need it and keeps commits fast, so I prefer it for user-facing read-your-writes and reserve `remote_apply` for small, latency-tolerant write paths.

**Q: Why is causal consistency attractive for comment threads and chat?**
A: The anomaly users hate in threads is seeing an effect before its cause — a reply before the message it answers, or a "yes" before the question. Causal consistency forbids exactly that: anything a write depended on becomes visible before the write itself, everywhere. It does not require global ordering of unrelated messages, so it avoids linearizability's coordination cost and stays available during partitions. You can implement it by carrying the token of what the writer had read, and having readers wait for or fetch dependencies before rendering.

**Q: What makes "eventual consistency" hard to reason about, and how do you make it operational?**
A: Eventual consistency only promises convergence once writes stop; it says nothing about how stale any given read can be or how long convergence takes, and writes never really stop in production. That makes it impossible to test or promise on its own. You make it operational by bounding it: define a staleness budget per read path, measure replica lag and cache age against it, route away from replicas that exceed it, and alert when it is breached. Bounded staleness is eventual consistency with an SLO attached.

## 10. Quick Revision & Cheat Sheet

| Guarantee | One-line meaning | Typical use | PostgreSQL mechanism | Elsewhere |
|---|---|---|---|---|
| Linearizable | Acts like one copy, real time | Money, stock, locks, permissions | Primary reads; `remote_apply` standbys | etcd, Spanner, Mongo `linearizable`, Cassandra LWT |
| Causal | Cause before effect | Comments, chat | Propagate LSN of what you read | Mongo causal sessions |
| Read-your-writes | I see my writes | Profile, settings, history | LSN token routing, pin window | GTID wait (MySQL), Mongo sessions |
| Monotonic reads | Never go back in time | Feeds, notifications | Sticky replica or raised token | Mongo sessions |
| Bounded staleness | At most t old | Dashboards, search | Route by `replay_lag` | Cosmos DB bounded staleness |
| Eventual | Converges eventually | Likes, views | Any replica | DynamoDB default, Cassandra `ONE` |

- Ask "where do we need strong consistency?", not "do we need consistency?".
- Strong consistency belongs inside read-decide-write paths; display reads usually need at most a session guarantee.
- Isolation (concurrent transactions) and consistency models (copies) are different axes; strict serializability is both.
- Random replica load balancing breaks monotonic reads; tokens or stickiness fix it.
- LSN/GTID tokens give RYW cheaply; bound the primary fallback.
- R + W > N gives overlap, not linearizability.
- GSIs, caches, search indexes and CDC read models are eventually consistent — say so in the consistency map.

## 11. Hands-On Exercises

Lab: the primary + replica setup from [Ch 09](topic.html?p=09-replication) (`postgres:17`), plus `recovery_min_apply_delay = '2s'` on the replica to make lag visible and deterministic.

1. **See the RYW violation.** Update a row on the primary and immediately read it from the delayed replica; record the old value. Then read `pg_current_wal_lsn()` after the write and poll `pg_last_wal_replay_lsn()` on the replica until it passes the token; read again.
2. **Build the router.** Implement the Python `Router` from §5 with cached replica LSNs (polled every 50 ms) and a fallback rate limit. Measure the share of reads served by the replica with and without tokens.
3. **Monotonic-read anomaly.** Add a second replica with a different apply delay (0 s and 3 s) and alternate reads between them after a burst of inserts; observe rows appearing and disappearing. Fix it with a raised token.
4. **Fallback storm.** Raise the apply delay to 60 s, generate write+read traffic with tokens, and watch primary load. Add the rate limiter and a "stale OK" degradation path; compare.
5. **`remote_apply`.** Configure the replica as a synchronous standby with `synchronous_commit = remote_apply` (remove the apply delay), measure commit latency with `pgbench -N`, and confirm reads on the standby always see prior commits.
6. **Quorum arithmetic (optional).** In a 3-node Cassandra cluster (`cassandra:5`), write at `ONE`, stop a node, and read at `ONE` vs `QUORUM`; then write at `QUORUM` and repeat. Explain each result with R + W vs N.

### Mini project — "Consistency Map for a Real App"

Take an app you know (or the fintech-with-feed example) and produce: (1) a consistency map table of at least 12 read paths with harm-of-stale-read, chosen model, mechanism and monitored bound; (2) an implementation of three of them on PostgreSQL — a strong path (conditional update), a RYW path (token routing with bounded fallback), and an eventual path (replica or cache); (3) a load test that injects replica lag and reports stale-read rate per path and primary fallback rate. Write a half-page justification of the boundaries as if for a design review.

## 12. Related Topics & Free Learning Resources

**In this handbook:** [Ch 06 · Isolation Deep Dive](topic.html?p=06-isolation-deep-dive) (the single-node axis) · [Ch 09 · Replication](topic.html?p=09-replication) (where staleness comes from) · [Ch 14 · CAP Theorem](topic.html?p=14-cap-theorem) (what strong consistency costs under partition) · [Ch 15 · Consensus](topic.html?p=15-consensus) (how linearizable systems are built) · [Ch 17 · Multi-Region Databases](topic.html?p=17-multi-region-databases) · [Ch 19 · Database Caching Architecture](topic.html?p=19-database-caching-architecture) · [Ch 32 · Banking Ledger](topic.html?p=32-case-banking) · [Ch 35 · Social Media Storage](topic.html?p=35-case-social-media).

**Other handbooks:** [Caching with Redis · Consistency Models](../redis-caching/topic.html?p=13-consistency-models) (the cache-side view: staleness budgets and invalidation) · [System Design · CAP & Consistency](../system-design/topic.html?p=19-cap-consistency) · [Cassandra · CAP & Tunable Consistency](../cassandra/topic.html?p=03-cap-tunable-consistency) · [Cassandra · Batches & Lightweight Transactions](../cassandra/topic.html?p=14-batches-lightweight-transactions).

- **Consistency Models** — Jepsen (Kyle Kingsbury) · *Intermediate* · a clickable map of models from strict serializable to eventual, with precise definitions. <https://jepsen.io/consistency>
- **Eventually Consistent** — Werner Vogels · *Beginner* · the classic essay on client-side consistency, read-your-writes and session guarantees. <https://www.allthingsdistributed.com/2008/12/eventually_consistent.html>
- **Read Consistency (DynamoDB)** — AWS docs · *Beginner* · eventually vs strongly consistent reads, cost, and GSI limits. <https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.ReadConsistency.html>
- **Causal Consistency and Read and Write Concerns** — MongoDB docs · *Intermediate* · which session guarantees each read/write concern combination provides. <https://www.mongodb.com/docs/manual/core/causal-consistency-read-write-concerns/>
- **Hot Standby** — PostgreSQL docs · *Intermediate* · what queries on standbys can see, and replay/visibility behaviour. <https://www.postgresql.org/docs/current/hot-standby.html>
- **Designing Data-Intensive Applications, ch. 5 & 9** — Martin Kleppmann · *Intermediate* · replication-lag anomalies, linearizability and causality explained with care. <https://dataintensive.net/>
- **A Critique of ANSI SQL Isolation Levels** — Berenson et al. · *Advanced* · useful for keeping isolation and consistency vocabulary distinct. <https://arxiv.org/abs/cs/0701157>

---

*Database Design Handbook — chapter 10.*
