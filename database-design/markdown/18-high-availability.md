# 18 · High Availability: Failover, RPO & RTO

> **In one line:** High availability is not "we have a replica" — it is a designed, tested path from "the primary is gone" to "writes work again" that bounds how much data you can lose (RPO) and how long you are down (RTO), and that never, under any failure, lets two nodes believe they are the primary.

---

## 1. Overview

Every database will lose its primary eventually: a disk fails, a kernel panics, an AZ loses power, a noisy neighbour saturates the host, an operator runs the wrong command. The question is never *whether* but *what happens next*. Without a plan, the answer is: somebody gets paged, logs in, figures out which replica is most up to date, promotes it by hand, edits connection strings, restarts app servers, and discovers an hour later that the old primary came back and accepted writes for twenty minutes. That is an RTO measured in hours and an RPO nobody can state.

The naive fix is "automatic failover": a script that pings the primary and promotes a replica if the ping fails. This is worse than nothing in a surprising number of cases. A ping that times out under load triggers a failover *during* the load spike, onto a replica with a cold cache that immediately falls over, triggering a failover back. A network partition that separates the script from a perfectly healthy primary produces **two primaries** — split brain — and two diverging histories of your data. A script that picks "any replica" may promote one that was 30 seconds behind, silently discarding committed transactions.

Real HA needs five things working together: **failure domains** you understand, **standbys** that are ready, **a single source of truth about who is primary** (a consensus store, not a script's opinion), **fencing** so the old primary cannot keep writing, and **connection redirection** so clients find the new primary. This chapter builds each piece, with PostgreSQL + Patroni + etcd as the reference design and managed services (RDS Multi-AZ, Aurora) as the comparison, and ends with the arithmetic of RPO, RTO and the nines.

> **Builds on:** [Ch 09 · Database Replication](topic.html?p=09-replication) (streaming replication, sync vs async, lag views) · [Ch 15 · Consensus](topic.html?p=15-consensus) (Raft, leases, majority quorums — etcd is what Patroni uses to elect a leader) · [Ch 07 · Write-Ahead Logging](topic.html?p=07-write-ahead-logging) (timelines and WAL divergence). There is no SQL Handbook prerequisite; this chapter assumes replication works and asks what happens when the primary doesn't.

> **Why this matters:** "What happens when your database primary dies?" is asked in nearly every backend design interview. A senior answer gives RPO and RTO numbers, names the component that decides failover, and explains how split brain is prevented.

## 2. Core Concepts

- **Availability** — fraction of time the service answers correctly; `A = MTBF / (MTBF + MTTR)`. *Why it matters:* you raise it by failing less (MTBF) or recovering faster (MTTR); HA is mostly about MTTR.
- **Failure domain** — a set of components that can fail together: a disk, a host, a rack, an AZ, a region, a cloud control plane, a deploy pipeline, a config file. *Why it matters:* a replica in the same failure domain as the primary protects you from nothing.
- **Availability zone** — an isolated datacenter within a region with independent power and networking, ~1 ms from its siblings. *Why it matters:* the standard boundary for synchronous HA.
- **Standby (hot / warm / cold)** — a hot standby is a streaming replica already applying WAL and able to serve reads; a warm standby applies WAL but isn't serving (or needs startup); a cold standby is a backup you must restore. *Why it matters:* RTO ranges from seconds (hot) to hours (cold).
- **Failover** — promoting a standby after an unplanned primary failure. **Switchover** — a planned, graceful role swap with zero data loss. *Why it matters:* switchovers are how you patch and resize; failovers are what you rehearse.
- **Health check** — the probe that decides a node is healthy. *Why it matters:* a naive probe is the most common cause of *unnecessary* failovers.
- **DCS (distributed configuration store)** — etcd, Consul or ZooKeeper: a consensus-replicated key-value store holding the leader lock. *Why it matters:* it is the single source of truth for "who is primary", surviving partitions correctly.
- **Leader lease / lock** — a key with a TTL the primary must keep renewing. *Why it matters:* if the primary can't renew (it's dead or partitioned), the lock expires and another node can take it — and the old one knows to stop.
- **Fencing / STONITH** — forcibly preventing a deposed primary from accepting writes ("shoot the other node in the head"). *Why it matters:* the only reliable defence against split brain.
- **Split brain** — two nodes simultaneously accepting writes as primary. *Why it matters:* two diverging histories; reconciling them is manual and lossy.
- **Timeline** — PostgreSQL's history branch counter; each promotion starts a new timeline. *Why it matters:* it is how PG knows a node's WAL diverged.
- **pg_rewind** — rewinds a diverged old primary to the point where timelines split so it can follow the new primary. *Why it matters:* rejoin in minutes instead of a multi-hour re-clone.
- **RPO (Recovery Point Objective)** — the maximum data loss, measured in time, you accept. **RTO (Recovery Time Objective)** — the maximum time to restore service. *Why it matters:* they are the requirements; everything else is implementation.

## 3. Theory & Principles

### RPO and RTO, with the arithmetic

**RPO** is determined by what was committed on the primary but not yet durable anywhere that survives:

- Synchronous replication to at least one standby (`synchronous_commit = on` with `synchronous_standby_names`): a commit returns only after the standby has flushed the WAL. If you fail over to *that* standby, **RPO = 0**.
- Asynchronous replication: **RPO ≈ replication lag at the moment of failure**. If lag is typically 200 ms but spikes to 40 s during a nightly batch, your honest RPO is "up to 40 s", and the disaster will pick the worst moment.
- Restore from backup + WAL archive: RPO = time since the last archived WAL segment (bounded by `archive_timeout`, e.g. 60 s), plus anything not yet archived.

**RTO** is a sum, and it is almost never dominated by the promotion itself:

```text
RTO = T_detect + T_decide + T_promote + T_redirect + T_warm

T_detect   time until the failure is noticed        (lease TTL, health-check interval x failures)
T_decide   time to choose and agree on a new leader (consensus: ~seconds; humans: minutes)
T_promote  standby finishes replay + promotes       (seconds; longer if it was lagging)
T_redirect clients find the new primary              (HAProxy check interval, DNS TTL, pool reconnect)
T_warm     new primary's cache warms, latency normal (seconds to many minutes on big working sets)
```

**Worked example — Patroni with default-ish settings.** `ttl = 30`, `loop_wait = 10`, HAProxy checks every 3 s with `fall 3`:

- T_detect: the leader key expires up to 30 s after the last successful renewal (worst case ~30 s; typical ~20–30 s for a hard crash).
- T_decide: replicas notice on their next loop (≤ 10 s) and race for the key; the most up-to-date eligible replica wins — a few seconds.
- T_promote: `pg_ctl promote` on a caught-up replica takes ~1–3 s.
- T_redirect: HAProxy marks the old primary down after 3 × 3 s = 9 s (it already did, during detection) and the new one up after `rise 2` × 3 s = 6 s.
- Total write unavailability: **roughly 30–50 s** for a crash. A graceful switchover (`patronictl switchover`) is typically a few seconds.

You can shrink `ttl` and `loop_wait` to reduce detection time, but every second you remove makes a transient hiccup (a GC pause in etcd, a network blip, a long fsync) more likely to trigger an unnecessary failover. **Detection time and false-positive rate are the same dial.**

**Worked example — RTO/RPO targets.** A checkout service with an SLO of 99.95% monthly availability has an error budget of ~21.9 minutes/month. If you expect roughly one unplanned primary failure per quarter, a 45 s automated failover costs ~15 s/month amortised — comfortably inside the budget. A manual failover with a 20-minute median RTO would burn the entire month's budget in one incident. Conversely, the business says it can lose "no confirmed orders": that is RPO = 0, which forces synchronous replication to at least one standby in another AZ and failover only to a synchronous standby.

### The nines

| Availability | Downtime per year | Downtime per month (30 d) | What it implies for the database |
| --- | --- | --- | --- |
| 99% | ~3.65 days | ~7.2 hours | manual recovery is fine |
| 99.9% | ~8.76 hours | ~43.8 minutes | manual failover barely fits; automate |
| 99.95% | ~4.38 hours | ~21.9 minutes | automated failover, rehearsed |
| 99.99% | ~52.6 minutes | ~4.4 minutes | automated failover in tens of seconds, zero-downtime maintenance, few incidents |
| 99.999% | ~5.3 minutes | ~26 seconds | one ordinary failover per month blows it; needs consensus-replicated DB and multi-region design |

Two formulas matter. Components **in series** (the request needs all of them) multiply: app 99.99% × DB 99.95% × network 99.99% ≈ 99.93%. Components **in parallel** (any one suffices, failures independent) combine as `1 − (1 − A)^n`: two independent 99.9% databases give 99.9999% *in theory* — but only if failover is instant and failures truly independent, which is precisely what shared failure domains and flaky failover break. In practice, **the failover mechanism is itself a component in series**, and it is usually the weakest one.

### Why a naive health check flaps

Consider a failover script that runs `SELECT 1` against the primary with a 2 s timeout and promotes on the first failure. On Monday at 9am, traffic spikes; the primary's connection slots are full and CPU is at 100%. `SELECT 1` waits for a connection, times out. The script promotes the replica. Now:

1. The app reconnects to the replica — whose buffer cache holds the replica's read workload, not the primary's write working set. Every query reads from disk; latency goes from 5 ms to 200 ms; connection pools fill.
2. The health check on the *new* primary times out. The script fails back (or promotes the other replica).
3. Meanwhile, the old primary was never dead. If nothing fenced it, clients with cached connections are still writing to it.

This is **flapping**, and it turns a load spike into an outage plus split brain. Robust health checking:

- **Checks the right thing:** "is PostgreSQL running, is it the leader in the DCS, can it write" — not "did one query finish in 2 s".
- **Requires consecutive failures** from **multiple vantage points** before acting (a single probe host's network problem is not the database's problem).
- **Separates liveness from overload.** A slow primary is a capacity problem; failing over moves the load to a weaker node.
- **Has hysteresis and a cool-down:** no automatic failover within N minutes of the last one; no automatic failback ever.

### Leader election through a DCS, and self-fencing

Patroni's core idea is simple: the right to be primary is a **key in etcd** (`/service/<cluster>/leader`) with a TTL. Every `loop_wait` seconds, the primary's Patroni agent renews it with a compare-and-set that only succeeds if the key still names *this* node. Because etcd is Raft-replicated, "the key names node A" is a linearizable fact agreed by a majority of etcd members.

- **Primary crashes:** it stops renewing; the key expires after `ttl`; replicas race to create it (CAS on absence); exactly one wins because etcd serializes the writes; that replica promotes. The others re-point to follow it.
- **Primary is partitioned from etcd but alive:** it cannot renew. Patroni on the primary notices the failed renewals and **demotes its own PostgreSQL** (restarts it read-only) before the TTL runs out. Meanwhile the other side, which can reach the etcd majority, elects a new leader after expiry. The old primary stops writing *before* the new one starts — this is **self-fencing via lease**.
- **Patroni itself hangs** (so it can neither renew nor demote): the optional **watchdog** (`/dev/watchdog`, softdog) reboots the node if Patroni fails to ping it in time. This covers the case where the agent is dead but PostgreSQL is alive and still accepting writes.
- **etcd loses quorum:** no leader can be elected or renewed. Patroni's safe choice is to demote the primary to read-only (unless DCS failsafe mode is enabled, which lets the primary keep running if it can reach all other Patroni members). This is why the DCS must be deployed across three AZs with its own monitoring: it is now in series with your database's availability.

```svg
<svg viewBox="0 0 880 500" width="100%" height="500" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c18a1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="c18a2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
    <marker id="c18a3" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Patroni HA: etcd holds the leader lock, HAProxy routes by REST health check</text>
  <rect x="330" y="40" width="220" height="44" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="440" y="60" text-anchor="middle" fill="#1e293b" font-weight="bold">Application pools</text>
  <text x="440" y="76" text-anchor="middle" fill="#334155" font-size="10">connect to haproxy:5000 (rw) / :5001 (ro)</text>
  <rect x="300" y="110" width="280" height="56" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="440" y="130" text-anchor="middle" fill="#1e40af" font-weight="bold">HAProxy (x2, behind a VIP or LB)</text>
  <text x="440" y="148" text-anchor="middle" fill="#1e40af" font-size="10">:5000 &#8594; GET :8008/primary == 200 &#183; inter 3s fall 3 rise 2</text>
  <text x="440" y="160" text-anchor="middle" fill="#1e40af" font-size="10">:5001 &#8594; GET :8008/replica == 200</text>
  <path d="M440,86 L440,106" stroke="#2563eb" stroke-width="2" marker-end="url(#c18a1)"/>
  <rect x="30" y="210" width="230" height="130" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="145" y="232" text-anchor="middle" fill="#166534" font-weight="bold">AZ-a: node1 (PRIMARY)</text>
  <rect x="48" y="244" width="194" height="30" rx="5" fill="#fff" stroke="#86efac"/><text x="145" y="263" text-anchor="middle" fill="#166534" font-size="10">PostgreSQL 17 (read-write)</text>
  <rect x="48" y="280" width="194" height="30" rx="5" fill="#fff" stroke="#86efac"/><text x="145" y="299" text-anchor="middle" fill="#166534" font-size="10">Patroni agent + REST :8008</text>
  <text x="145" y="330" text-anchor="middle" fill="#166534" font-size="9">+ watchdog (reboot if agent hangs)</text>
  <rect x="325" y="210" width="230" height="130" rx="10" fill="#f8fafc" stroke="#94a3b8" stroke-width="2"/>
  <text x="440" y="232" text-anchor="middle" fill="#334155" font-weight="bold">AZ-b: node2 (sync standby)</text>
  <rect x="343" y="244" width="194" height="30" rx="5" fill="#fff" stroke="#94a3b8"/><text x="440" y="263" text-anchor="middle" fill="#334155" font-size="10">PostgreSQL hot standby</text>
  <rect x="343" y="280" width="194" height="30" rx="5" fill="#fff" stroke="#94a3b8"/><text x="440" y="299" text-anchor="middle" fill="#334155" font-size="10">Patroni agent + REST :8008</text>
  <text x="440" y="330" text-anchor="middle" fill="#334155" font-size="9">flushes WAL before primary commit returns</text>
  <rect x="620" y="210" width="230" height="130" rx="10" fill="#f8fafc" stroke="#94a3b8" stroke-width="2"/>
  <text x="735" y="232" text-anchor="middle" fill="#334155" font-weight="bold">AZ-c: node3 (async standby)</text>
  <rect x="638" y="244" width="194" height="30" rx="5" fill="#fff" stroke="#94a3b8"/><text x="735" y="263" text-anchor="middle" fill="#334155" font-size="10">PostgreSQL hot standby</text>
  <rect x="638" y="280" width="194" height="30" rx="5" fill="#fff" stroke="#94a3b8"/><text x="735" y="299" text-anchor="middle" fill="#334155" font-size="10">Patroni agent + REST :8008</text>
  <text x="735" y="330" text-anchor="middle" fill="#334155" font-size="9">eligible only if lag &lt; maximum_lag_on_failover</text>
  <path d="M360,168 L180,206" stroke="#2563eb" stroke-width="2" marker-end="url(#c18a1)"/>
  <path d="M262,262 L321,262" stroke="#16a34a" stroke-width="2" marker-end="url(#c18a3)"/>
  <text x="292" y="254" text-anchor="middle" fill="#166534" font-size="9">WAL</text>
  <path d="M262,250 C 400,190 560,190 616,250" stroke="#16a34a" stroke-width="1.5" fill="none" stroke-dasharray="4 3" marker-end="url(#c18a3)"/>
  <rect x="160" y="390" width="560" height="96" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="440" y="412" text-anchor="middle" fill="#5b21b6" font-weight="bold">etcd cluster: 3 members in 3 AZs (Raft, majority = 2)</text>
  <text x="440" y="432" text-anchor="middle" fill="#5b21b6" font-size="10">/service/pg-main/leader = "node1"   (TTL 30 s, renewed every loop_wait = 10 s via compare-and-set)</text>
  <text x="440" y="450" text-anchor="middle" fill="#5b21b6" font-size="10">primary cannot renew &#8594; demotes itself &#183; key expires &#8594; best standby CAS-creates it &#8594; promotes</text>
  <text x="440" y="470" text-anchor="middle" fill="#5b21b6" font-size="10" font-weight="bold">the lock is the single source of truth; HAProxy just follows it via /primary</text>
  <path d="M145,342 L260,386" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#c18a2)"/>
  <path d="M440,342 L440,386" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#c18a2)"/>
  <path d="M735,342 L620,386" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#c18a2)"/>
</svg>
```

## 4. Architecture & Workflow

### Failure domains and where to put things

Place the primary and each standby in **different AZs**, the DCS members in **three** AZs (a two-AZ DCS cannot survive losing the AZ holding the majority), and the load balancer tier redundantly. Then list the failure domains you have *not* covered, because those are your real risks: the region, the cloud provider's control plane (RDS failovers depend on it), your DNS provider, your deployment pipeline (a bad config pushed to all nodes at once), and the humans (a `DROP TABLE` replicates perfectly to every standby — HA is not backup; see [Ch 26 · Backup & Disaster Recovery](topic.html?p=26-backup-disaster-recovery)).

### Standby types and what they cost

| Standby | State | RTO contribution | Cost | Typical use |
| --- | --- | --- | --- | --- |
| **Hot, synchronous** | streaming, replaying, may serve reads; primary waits for its flush | seconds; RPO 0 | a full server + commit latency (+~1 ms cross-AZ) | primary HA pair |
| **Hot, asynchronous** | streaming, replaying, serving reads | seconds; RPO = lag | a full server | read scaling + second failover candidate |
| **Delayed standby** | `recovery_min_apply_delay = '1h'` | not for HA | a full server | fast undo of human error (drop the bad WAL before it applies) |
| **Warm** | restoring from WAL archive, not serving | minutes (catch up + promote) | server or smaller instance | cheap DR |
| **Cold** | backups + WAL archive in object storage | hours (restore TBs + replay) | storage only | last resort, cross-region DR |

### The failover sequence, with split brain prevented

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Partitioned primary: lease expiry fences the old leader before the new one starts</text>
  <line x1="120" y1="70" x2="850" y2="70" stroke="#94a3b8" stroke-width="1"/>
  <text x="120" y="60" fill="#334155" font-size="10">t=0</text>
  <text x="300" y="60" fill="#334155" font-size="10">t=10</text>
  <text x="480" y="60" fill="#334155" font-size="10">t=20</text>
  <text x="660" y="60" fill="#334155" font-size="10">t=30</text>
  <text x="820" y="60" fill="#334155" font-size="10">t=40 s</text>
  <text x="20" y="104" fill="#166534" font-weight="bold">node1 (old)</text>
  <rect x="120" y="90" width="100" height="24" fill="#dcfce7" stroke="#16a34a"/><text x="170" y="106" text-anchor="middle" fill="#166534" font-size="9">primary, renews</text>
  <rect x="220" y="90" width="230" height="24" fill="#fef3c7" stroke="#d97706"/><text x="335" y="106" text-anchor="middle" fill="#92400e" font-size="9">partitioned from etcd: renewals fail, still primary</text>
  <rect x="450" y="90" width="400" height="24" fill="#f1f5f9" stroke="#94a3b8"/><text x="650" y="106" text-anchor="middle" fill="#334155" font-size="9">DEMOTED itself (read-only) before TTL ran out &#8212; cannot accept writes</text>
  <line x1="220" y1="84" x2="220" y2="124" stroke="#dc2626" stroke-width="2"/>
  <text x="224" y="136" fill="#dc2626" font-size="9">partition starts (last renewal ~t=0)</text>
  <text x="20" y="174" fill="#5b21b6" font-weight="bold">etcd leader key</text>
  <rect x="120" y="160" width="540" height="24" fill="#ede9fe" stroke="#7c3aed"/><text x="390" y="176" text-anchor="middle" fill="#5b21b6" font-size="9">leader = node1 (TTL 30 s counting down from last renewal)</text>
  <rect x="660" y="160" width="190" height="24" fill="#dbeafe" stroke="#2563eb"/><text x="755" y="176" text-anchor="middle" fill="#1e40af" font-size="9">leader = node2 (CAS)</text>
  <text x="20" y="234" fill="#1e40af" font-weight="bold">node2 (sync)</text>
  <rect x="120" y="220" width="560" height="24" fill="#f8fafc" stroke="#94a3b8"/><text x="400" y="236" text-anchor="middle" fill="#334155" font-size="9">standby: sees key still held &#8594; waits (no unilateral promotion)</text>
  <rect x="680" y="220" width="170" height="24" fill="#dbeafe" stroke="#2563eb"/><text x="765" y="236" text-anchor="middle" fill="#1e40af" font-size="9">promote &#8594; timeline 2</text>
  <text x="20" y="294" fill="#334155" font-weight="bold">HAProxy :5000</text>
  <rect x="120" y="280" width="330" height="24" fill="#dcfce7" stroke="#16a34a"/><text x="285" y="296" text-anchor="middle" fill="#166534" font-size="9">&#8594; node1 (partition is etcd-side; clients may still reach it)</text>
  <rect x="450" y="280" width="250" height="24" fill="#fee2e2" stroke="#dc2626"/><text x="575" y="296" text-anchor="middle" fill="#991b1b" font-size="9">no /primary = 200 &#8594; writes fail</text>
  <rect x="700" y="280" width="150" height="24" fill="#dbeafe" stroke="#2563eb"/><text x="775" y="296" text-anchor="middle" fill="#1e40af" font-size="9">&#8594; node2 (rise 2)</text>
  <rect x="20" y="330" width="840" height="126" rx="10" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="36" y="352" fill="#1e293b" font-size="12" font-weight="bold">Why no split brain</text>
  <text x="36" y="372" fill="#334155" font-size="10">1. node1 demotes when renewals keep failing, strictly before the TTL can expire (retry_timeout &lt; ttl).</text>
  <text x="36" y="390" fill="#334155" font-size="10">2. node2 may only promote after the key expires AND its CAS create succeeds &#8212; etcd guarantees exactly one winner.</text>
  <text x="36" y="408" fill="#334155" font-size="10">3. If node1's agent hangs instead, the watchdog reboots node1 &#8212; the fence of last resort.</text>
  <text x="36" y="426" fill="#334155" font-size="10">4. Only a sync standby (or one within maximum_lag_on_failover) is eligible &#8212; RPO stays bounded.</text>
  <text x="36" y="446" fill="#991b1b" font-size="10" font-weight="bold">Write unavailability here &#8776; 30&#8211;45 s. That is the price of never having two primaries.</text>
</svg>
```

### Fencing options, strongest first

1. **Power/instance fencing (STONITH):** IPMI power-off or a cloud API call to stop the old instance. Unambiguous; needs credentials and a working API.
2. **Self-fencing by lease + watchdog:** the node demotes when it can't renew and a hardware/software watchdog reboots it if the agent is stuck (Patroni's model).
3. **Network fencing:** remove the old primary from the security group / move the VIP / block port 5432.
4. **Storage fencing:** revoke the old node's access to shared storage (SCSI reservations; the model of shared-disk clusters and of Aurora, where only one writer can write to the storage volume).
5. **Client-side fencing tokens:** a monotonically increasing epoch attached to writes that downstream systems check (the general distributed-systems pattern; PG's timeline ID plays a similar role for replicas).

Relying on "the old primary is probably dead" is not fencing.

### Connection redirection

After promotion, clients must find the new primary. Options, from fastest to slowest to converge:

- **Proxy with health checks** (HAProxy/PgBouncer in front, checking Patroni's `/primary`): converges in `rise × inter` seconds; existing connections to the old primary are killed (use `on-marked-down shutdown-sessions`).
- **VIP (virtual IP)** moved to the new primary (keepalived, vip-manager watching the DCS key, or cloud secondary IP reassignment): converges in seconds; limited to one L2 network/subnet or cloud-specific APIs.
- **libpq multi-host connection strings:** `host=pg1,pg2,pg3 target_session_attrs=read-write` (or `primary` in PG 14+) makes the client try each host until it finds a writable one. No proxy needed; reconnect logic must exist in the pool.
- **DNS** (RDS endpoints, Route 53 records): the CNAME is repointed, but clients honour TTLs and many runtimes cache DNS longer than the TTL (the JVM's default positive-cache behaviour is a classic trap). Converges in tens of seconds to minutes.

Whatever you choose, your **connection pools** must detect dead connections and reconnect with backoff rather than stampeding the new primary — that failure mode belongs to [Ch 20 · Database + Application](topic.html?p=20-database-application-architecture).

### Recovery and rejoin

When promotion happens, the new primary starts **timeline 2**, recorded in a `00000002.history` file stating the LSN where it branched. The old primary, on timeline 1, may have written WAL past that point (transactions that were never replicated — the RPO window). It cannot simply follow the new primary; its data files contain changes the new timeline doesn't have.

`pg_rewind` fixes this: it finds the divergence point from the timeline history, copies from the new primary every block the old primary changed after that point (it reads the old node's WAL to know which), plus configuration and new files, and leaves the node ready to start as a standby and replay forward. It requires `wal_log_hints = on` or data checksums, and it needs the old node's WAL from the divergence point onward. Patroni runs it automatically with `use_pg_rewind: true`. For a multi-TB database, this is the difference between minutes and hours of reduced redundancy.

## 5. Implementation

### Simple example: see roles, timelines and lag from SQL

```sql
-- On any node: am I a primary?
SELECT pg_is_in_recovery() AS is_standby;

-- Current timeline (both primary and standby)
SELECT timeline_id, redo_lsn FROM pg_control_checkpoint();

-- On the primary: who is connected, sync state, lag
SELECT application_name, client_addr, state, sync_state, replay_lag
FROM pg_stat_replication;

-- On a standby: how far behind am I, and am I receiving?
SELECT status, sender_host, latest_end_lsn, latest_end_time FROM pg_stat_wal_receiver;
SELECT now() - pg_last_xact_replay_timestamp() AS replay_delay;

-- Manual promotion (what the HA manager does for you)
SELECT pg_promote(wait => true, wait_seconds => 60);
```

### Real-world example: Patroni + etcd + HAProxy

A trimmed `patroni.yml` for node1:

```yaml
scope: pg-main
name: node1
restapi:
  listen: 0.0.0.0:8008
  connect_address: 10.0.1.11:8008
etcd3:
  hosts: 10.0.1.5:2379,10.0.2.5:2379,10.0.3.5:2379
bootstrap:
  dcs:
    ttl: 30                       # leader lock lifetime
    loop_wait: 10                 # how often agents run their HA loop
    retry_timeout: 10             # DCS/PG op retry before demoting
    maximum_lag_on_failover: 1048576   # bytes; laggier replicas not eligible
    synchronous_mode: true        # Patroni manages synchronous_standby_names
    postgresql:
      use_pg_rewind: true
      parameters:
        wal_log_hints: "on"
        max_wal_senders: 10
        max_replication_slots: 10
        hot_standby: "on"
watchdog:
  mode: required                  # refuse to be leader without a working watchdog
  device: /dev/watchdog
postgresql:
  listen: 0.0.0.0:5432
  connect_address: 10.0.1.11:5432
  data_dir: /var/lib/postgresql/17/main
```

`synchronous_mode: true` makes Patroni pick a synchronous standby and — critically — only allow a *synchronous* standby to take over, which is how Patroni delivers RPO = 0 without you hand-editing `synchronous_standby_names`. (With `synchronous_mode_strict: true` the primary stops accepting writes if no sync standby is available, choosing consistency over availability.)

HAProxy routing by role:

```text
listen primary
    bind *:5000
    option httpchk OPTIONS /primary
    http-check expect status 200
    default-server inter 3s fall 3 rise 2 on-marked-down shutdown-sessions
    server node1 10.0.1.11:5432 maxconn 500 check port 8008
    server node2 10.0.2.11:5432 maxconn 500 check port 8008
    server node3 10.0.3.11:5432 maxconn 500 check port 8008

listen replicas
    bind *:5001
    balance roundrobin
    option httpchk OPTIONS /replica
    http-check expect status 200
    default-server inter 3s fall 3 rise 2 on-marked-down shutdown-sessions
    server node1 10.0.1.11:5432 check port 8008
    server node2 10.0.2.11:5432 check port 8008
    server node3 10.0.3.11:5432 check port 8008
```

Operating it:

```text
$ patronictl -c /etc/patroni.yml list
+ Cluster: pg-main ---------+--------------+-----------+----+-----------+
| Member | Host       | Role         | State     | TL | Lag in MB |
+--------+------------+--------------+-----------+----+-----------+
| node1  | 10.0.1.11  | Leader       | running   |  4 |           |
| node2  | 10.0.2.11  | Sync Standby | streaming |  4 |         0 |
| node3  | 10.0.3.11  | Replica      | streaming |  4 |       0.1 |
+--------+------------+--------------+-----------+----+-----------+

$ patronictl -c /etc/patroni.yml switchover --leader node1 --candidate node2 --force
# planned role swap: node1 demotes, node2 promotes to TL 5, node1 rejoins as a replica
```

A rejoin done by hand (what `use_pg_rewind` automates):

```text
$ pg_ctl -D /var/lib/postgresql/17/main stop -m fast
$ pg_rewind --target-pgdata=/var/lib/postgresql/17/main \
            --source-server="host=10.0.2.11 user=rewind_user dbname=postgres" --progress
pg_rewind: servers diverged at WAL location 3/5A0001C8 on timeline 4
pg_rewind: rewinding from last common checkpoint at 3/59FFE0A0 on timeline 4
pg_rewind: Done!
$ touch /var/lib/postgresql/17/main/standby.signal   # then set primary_conninfo and start
```

Applications connect through HAProxy, or directly with libpq failover:

```text
postgresql://app@10.0.1.11:5432,10.0.2.11:5432,10.0.3.11:5432/app?target_session_attrs=read-write&connect_timeout=3
```

> **MySQL difference:** The MySQL ecosystem's equivalents are **Orchestrator** (topology discovery + automated failover for async/semi-sync replication, relying on GTIDs to re-point replicas), **MySQL InnoDB Cluster** (Group Replication — a Paxos-based group with automatic primary election — fronted by **MySQL Router** for redirection), and older MHA. With semi-synchronous replication (`rpl_semi_sync_source_enabled`), a commit waits for at least one replica to *receive* the event; if no replica acknowledges within `rpl_semi_sync_source_timeout` (10 s default), MySQL silently falls back to asynchronous — a quiet RPO change you must alert on. Rejoining an old MySQL primary relies on GTID sets; errant transactions (GTIDs present only on the old primary) must be found and reconciled, the analogue of PG's timeline divergence.

### Managed services: what you get and what you don't

- **RDS Multi-AZ (instance):** synchronous block-level replication to a standby in another AZ that *does not serve reads*; failover flips the endpoint's DNS record, typically completing in one to two minutes. RPO 0 for committed transactions.
- **RDS Multi-AZ DB cluster:** a writer and two readable standbys in three AZs using PostgreSQL/MySQL replication with commit acknowledged by one standby; failovers are typically faster (on the order of tens of seconds).
- **Aurora:** storage is replicated six ways across three AZs (writes need 4 of 6, reads 3 of 6) independent of compute; failover promotes an Aurora Replica, typically in well under a minute, since replicas share the same storage volume. Only one instance can write to the volume at a time — storage-level fencing.

Managed services remove the Patroni/etcd/HAProxy layer, but you still own DNS caching in clients, connection storm behaviour, retry logic, and testing failovers (both offer a "reboot with failover" action — use it in game days).

## 6. Advantages, Disadvantages & Trade-offs

| Choice | Gains | Costs |
| --- | --- | --- |
| Sync standby (RPO 0) | no committed data lost on failover | +RTT per commit; primary stalls if the standby is slow (use `ANY 1 (s1, s2)` quorum) |
| Async standby | no commit latency | RPO = lag |
| Automatic failover | RTO in tens of seconds, 24/7 | false positives, needs DCS + fencing, harder to reason about |
| Manual failover | humans judge ambiguous cases | RTO in minutes to hours; doesn't fit ≥ 99.95% |
| Short TTL / aggressive checks | faster detection | more flapping and unnecessary failovers |
| Proxy tier (HAProxy/PgBouncer) | fast redirection, role-aware routing | another component to make HA |
| DNS redirection | no extra tier | slow convergence, client DNS caching |
| Managed HA (RDS/Aurora) | no DCS/agent to run | control-plane dependency, less tuning, failover times you don't control |

### When to use

- **Automatic failover with a DCS** whenever the availability target is 99.9% or higher and you run your own PostgreSQL.
- **Synchronous replication to a quorum of standbys** whenever the RPO is zero (money, orders, identity).
- **A delayed standby** in addition, when human error (bad migrations, accidental deletes) is a bigger risk than hardware.

### When NOT to use

- **Not automatic cross-region failover** on a single signal — keep it a human-approved runbook unless the database is consensus-replicated across regions (Ch 17).
- **Not synchronous replication to a single standby without a fallback plan** — if that standby dies, every commit on the primary blocks. Use `ANY 1 (a, b)` or let Patroni manage it.
- **Not HA as a substitute for backups** — replicas faithfully copy `DELETE FROM orders`.
- **Not a two-node DCS or a two-node "cluster" with no witness** — it can't tell a dead peer from a partition.

## 7. Common Mistakes & Best Practices

- **Failing over on a single failed health check.** *Why it hurts:* load spikes become failovers onto cold replicas, then flapping. *Instead:* consecutive failures, multiple vantage points, lease-based leadership, and a cool-down.
- **No fencing.** *Why it hurts:* the old primary keeps accepting writes from stale connections → split brain. *Instead:* lease self-demotion + watchdog, `shutdown-sessions` on proxies, and STONITH/network fencing where available.
- **Standby in the same failure domain.** *Why it hurts:* the AZ outage takes both. *Instead:* one AZ per member, DCS across three AZs.
- **Never testing failover.** *Why it hurts:* the first real failover discovers the app caches DNS for an hour, the replica lacks an extension, or the pool never reconnects. *Instead:* scheduled switchovers (monthly patching is a free rehearsal) and chaos drills that kill the primary.
- **Promoting a lagging async replica silently.** *Why it hurts:* committed transactions vanish. *Instead:* `maximum_lag_on_failover`, synchronous mode, and a post-failover report of the lost LSN range.
- **Letting the old primary rejoin as primary.** *Why it hurts:* two timelines accept writes. *Instead:* the HA manager rewinds and rejoins it as a replica; no automatic failback.
- **Undersized standby.** *Why it hurts:* a standby with half the RAM can't hold the working set; after failover it collapses. *Instead:* standbys are the same size as the primary and ideally serve some reads so their caches stay warm.
- **Forgetting replication slots on failover.** *Why it hurts:* logical replication/CDC consumers lose their slot (slots historically lived only on the primary). *Instead:* PG 17's failover slots (`failover = true` on the slot plus `sync_replication_slots` on standbys), or Patroni's permanent slots.
- **Best practice:** write RPO and RTO down per database, derive the architecture from them, and measure both in every game day.

## 8. Production: Failure Scenarios, Monitoring & Scaling

### Failure scenarios

**The flapping primary.** At 09:02 a marketing push triples traffic. The in-house failover script's `SELECT 1` times out and it promotes the replica. The replica, with a cold cache, reaches 100% I/O and its checks time out too; the script promotes back. Result: 14 minutes of errors, two timelines, and some orders written to each. Root cause: health check measured overload, not death; no DCS, no fencing. Fix: Patroni with etcd, admission control at the pool (Ch 20), no automatic failback.

**The synchronous standby that stopped the world.** At 03:10 the only synchronous standby's disk fills. The primary keeps accepting connections but every `COMMIT` hangs waiting for the standby's flush; the application's pools fill with stuck transactions. Root cause: `synchronous_standby_names = 'node2'` with no alternative. Fix: `ANY 1 (node2, node3)` or Patroni `synchronous_mode` (which re-selects a sync standby), and alert on `sync_state` changes.

**etcd outage takes the database read-only.** An etcd upgrade goes wrong and the cluster loses quorum. Patroni can't renew the leader key and demotes the (healthy) primary: writes fail cluster-wide. Root cause: DCS in series with the database, upgraded without a runbook. Fix: treat etcd like a tier-0 dependency (3 or 5 members, spread across AZs, monitored, upgraded one member at a time); consider Patroni's DCS failsafe mode.

**Failover succeeded, app stayed down.** RDS failover completed in 70 s, but the Java service kept failing for 20 minutes. Root cause: the JVM cached the old IP for the endpoint; pools held dead connections without validation. Fix: set a short DNS cache TTL in the runtime, enable connection validation/max lifetime in the pool, and test it.

**The lost 30 seconds.** An async-only cluster fails over during a bulk load; 30 s of committed orders are missing from the new primary. Payment provider shows charges with no orders. Fix: sync standby for the orders database; reconcile using the payment provider's records and idempotency keys.

### What to monitor

| Metric | Source | Alert when |
| --- | --- | --- |
| Replication lag (bytes, seconds) | `pg_stat_replication`, Patroni `/cluster` | beyond RPO budget |
| Sync standby present | `sync_state = 'sync'/'quorum'` rows | zero sync standbys |
| Leader changes / timeline increments | Patroni events, `pg_control_checkpoint()` | any unplanned change |
| DCS health | etcd `/health`, leader changes, fsync latency | quorum loss risk |
| Health-check failures per node | HAProxy stats | flapping pattern |
| Watchdog status | Patroni logs | watchdog unavailable with `mode: required` |
| Time since last successful failover drill | runbook tracker | > 90 days |
| Measured RTO in drills | game-day records | above target |

### Scaling notes

HA topology scales by adding standbys (more failover candidates, more read capacity) — but each synchronous standby in a `FIRST n` list adds commit latency, so use quorum (`ANY 1`) sync. Cascading replication (standbys feeding other standbys) reduces load on the primary's WAL senders for large replica fleets. At very high availability targets (99.99%+) the limits are no longer the database but the redirection path and client behaviour — the parts people test least.

## 9. Interview Questions

**Q: Define RPO and RTO and explain what architectural choices set each one?**
A: RPO is the maximum amount of data, measured in time, you can lose in a failure; RTO is the maximum time until service is restored. RPO is set by replication mode: synchronous replication to the standby you fail over to gives RPO zero, asynchronous gives RPO equal to the lag at failure, and backup-plus-WAL-archive gives RPO equal to the unarchived window. RTO is the sum of detection, decision, promotion, client redirection and cache warm-up, so it is set by health-check and lease timing, whether failover is automatic, and how clients find the new primary. Promotion itself is usually the smallest term.

**Q: Why does PostgreSQL need Patroni or a managed service for automatic failover?**
A: Core PostgreSQL provides replication and a promote command but no mechanism to decide, safely and automatically, that the primary is dead and which standby should take over. That decision requires agreement that survives network partitions, which is a consensus problem. Patroni delegates it to a consensus store like etcd, holding a leader lock with a TTL, and manages promotion, re-pointing replicas, synchronous standby selection and rejoin with pg_rewind. Managed services such as RDS and Aurora implement the same responsibilities in their control plane.

**Q: How does a naive health check cause flapping?**
A: A check like "run SELECT 1 with a short timeout and fail over on the first failure" cannot distinguish a dead primary from an overloaded one. Under a load spike the check times out, triggering a failover to a replica whose cache is cold, which then struggles under the same load and fails its check, causing another failover. Each transition kills connections and adds load, and without fencing the old primary may still accept writes. Robust checks require consecutive failures from multiple vantage points, base leadership on a lease in a consensus store, and apply cool-downs with no automatic failback.

**Q: What is split brain and how do you prevent it?**
A: Split brain is two nodes both acting as primary and accepting writes, producing two divergent histories that are painful to reconcile. It typically happens when a partition makes a healthy primary look dead to the failover mechanism while clients can still reach it. Prevention requires a single source of truth for leadership that tolerates partitions, such as a lease in etcd, plus fencing so the old primary cannot write: it demotes itself when it can't renew the lease, a watchdog reboots it if the agent hangs, and proxies stop routing to it. Promotion is allowed only after the old lease has definitely expired.

**Q: What is the difference between hot, warm and cold standbys?**
A: A hot standby is a running replica continuously applying WAL and usually serving read queries, so it can be promoted in seconds. A warm standby is applying WAL, often from an archive, but not serving traffic, so it needs some catch-up and startup before promotion, typically minutes. A cold standby is just backups and archived WAL in storage; recovering means provisioning a server, restoring and replaying, which can take hours for large databases. They trade cost against RTO.

**Q: Why and how does pg_rewind work?**
A: After a failover the old primary may have written WAL beyond the point where the new primary's timeline branched, so its data files contain changes the new timeline doesn't have, and it can't simply start following. pg_rewind finds the divergence point from the timeline history, scans the old node's WAL from there to learn which blocks it changed, copies those blocks and other changed files from the new primary, and leaves the node ready to replay as a standby. It requires wal_log_hints or data checksums and the needed WAL. It avoids re-cloning a multi-terabyte database.

**Q: Compare VIP, DNS, proxy and multi-host connection strings for redirecting clients after failover?**
A: A proxy such as HAProxy checking Patroni's /primary endpoint redirects within a few check intervals and can kill sessions to the old primary. A VIP moved to the new primary converges in seconds but is constrained to a network segment or cloud-specific APIs. DNS repointing, as RDS does, is simple but slow to converge because of TTLs and client-side DNS caching. libpq multi-host strings with target_session_attrs=read-write let clients find the writable node themselves without extra infrastructure but depend on the pool reconnecting properly. All of them require pools that detect dead connections and reconnect with backoff.

**Q: Your checkout database needs 99.95% availability and zero loss of confirmed orders. Design the HA setup. (Senior)**
A: 99.95% gives about 22 minutes of downtime a month, so failover must be automatic and complete in well under a minute; zero loss means RPO zero, so commits must be durable on a standby before acknowledgement. I would run a primary and two standbys in three AZs with Patroni in synchronous mode, or quorum sync `ANY 1` of two standbys so one standby's failure doesn't block commits, and etcd across three AZs. Clients connect through redundant HAProxy checking /primary, with pools configured to validate connections and reconnect with jittered backoff. Watchdog and lease-based demotion provide fencing, pg_rewind handles rejoin, and there's a delayed standby or PITR for human error. I would measure RTO in monthly switchovers and quarterly kill-the-primary drills.

**Q: Why is availability of two replicas not simply 1 − (1 − A)²? (Senior)**
A: That formula assumes failures are independent and failover is instant and always succeeds. In reality replicas share failure domains, such as the same region, the same bad config push, or the same buggy query that crashes both. The failover mechanism itself is a component in series: detection time, promotion time and redirection all add downtime, and a failover can fail or flap. So the achievable availability is bounded by the failover path's reliability and speed, and by correlated failures, which is why testing failover matters more than adding replicas.

**Q: Synchronous replication is enabled, and suddenly every commit on the primary hangs. What happened and how do you fix it? (Senior)**
A: With synchronous_commit on and a synchronous standby configured, the primary waits for the standby to confirm the WAL flush before a commit returns. If that standby is down, disconnected, or stuck (for example its disk is full), and there's no alternative in synchronous_standby_names, commits wait indefinitely. I'd confirm via pg_stat_activity wait events (SyncRep) and pg_stat_replication missing a sync standby. Immediate mitigation is to fix the standby or change synchronous_standby_names to include a healthy standby and reload. Long term, use quorum sync with ANY 1 of several standbys or let Patroni manage synchronous mode, and alert on sync standby count.

**Q: What happens to a Patroni cluster if etcd loses quorum? (Senior)**
A: Patroni can no longer renew the leader key or elect a new leader, because every DCS write requires an etcd majority. To avoid split brain, the primary's Patroni demotes PostgreSQL to read-only when it can't update the leader key within its retry window, so writes stop even though the database is healthy. Replicas cannot promote either. This makes the DCS part of the database's availability path, so it needs three or five members across AZs, monitoring and careful upgrades. Patroni's failsafe mode can keep a primary running if it can still reach all other cluster members, trading some safety analysis for availability.

**Q: How would you test that your HA actually works?**
A: I'd start with planned switchovers during maintenance windows, measuring write unavailability from the client's perspective, not the database's. Then run chaos drills: kill the primary process, power off the instance, partition the primary from etcd but not from clients, fill the sync standby's disk, and break DNS caching in a test client. For each I'd record measured RTO, whether any acknowledged writes were lost by comparing a client-side log of committed IDs with the database, and whether the old node rejoined correctly. The results feed back into timeouts, pool settings and runbooks.

## 10. Quick Revision & Cheat Sheet

| Topic | Remember |
| --- | --- |
| RPO | sync standby = 0 · async = lag at failure · backup = unarchived window |
| RTO | detect + decide + promote + redirect + warm; promotion is the small part |
| Nines | 99.9% ≈ 43.8 min/mo · 99.95% ≈ 21.9 min/mo · 99.99% ≈ 4.4 min/mo · 99.999% ≈ 26 s/mo |
| Series vs parallel | multiply availabilities in series; parallel only helps if failures independent + failover works |
| Patroni | leader key in etcd, ttl 30 / loop_wait 10 / retry_timeout 10, synchronous_mode, watchdog |
| Fencing | lease self-demotion, watchdog, STONITH, network, storage, fencing tokens |
| Redirection | proxy (fast) · VIP · libpq multi-host · DNS (slow, cached) |
| Rejoin | new timeline on promotion; pg_rewind needs wal_log_hints or checksums |
| MySQL | Orchestrator, InnoDB Cluster + Router, semi-sync falls back to async on timeout |
| Managed | RDS Multi-AZ: DNS flip, ~1–2 min; Aurora: 6-way storage, faster replica promotion |

- HA is a designed failover path, not a replica.
- One source of truth for "who is primary": a lease in a consensus store.
- Fence the old primary before the new one writes.
- Detection speed and false positives are the same dial.
- No automatic failback.
- Sync to a quorum, not to a single standby.
- HA is not backup.
- Test failover on a schedule; measure RTO from the client.

## 11. Hands-On Exercises

1. **Promote by hand.** With two `postgres:17` containers, set up streaming replication (`pg_basebackup -R`), write rows on the primary, stop it, run `SELECT pg_promote();` on the standby, and inspect the new timeline with `SELECT timeline_id FROM pg_control_checkpoint();` and the `.history` file in `pg_wal`.
2. **Divergence and pg_rewind.** Before stopping the old primary in exercise 1, disconnect the standby and write 1,000 rows to the primary only. After promotion, restart the old primary as-is and observe it can't follow the new one; run `pg_rewind` (enable `wal_log_hints = on` beforehand) and rejoin it. Count which rows survived.
3. **Patroni lab.** Use the Patroni project's docker-compose demo (3 Patroni nodes + etcd + HAProxy). Run `patronictl list`, do a `switchover`, then `docker kill` the leader and time how long writes through HAProxy fail using a loop that inserts a row every 100 ms and logs errors.
4. **Partition the leader.** In the same lab, block the leader's traffic to etcd only (`iptables -A OUTPUT -p tcp --dport 2379 -j DROP` in the container) and confirm it demotes itself before another node promotes. Record the timeline of events from Patroni logs.
5. **Sync standby stall.** Set `synchronous_standby_names = 'node2'`, stop node2, and try a commit. Check `pg_stat_activity` for `wait_event = 'SyncRep'`. Then change to `ANY 1 (node2, node3)` and repeat.

**Mini project — "Failover scorecard".** Build a small client (Go or Python) that writes a monotonically increasing ID every 50 ms through your HA endpoint and logs each acknowledged ID locally. Run it during five failure types (clean switchover, primary kill, primary partition, sync standby loss, etcd member loss). For each, report measured RTO (longest gap between acknowledged writes), RPO (acknowledged IDs missing from the database afterwards) and whether split brain occurred. Compare async vs synchronous mode.

## 12. Related Topics & Free Learning Resources

**This handbook:** [Ch 07 · Write-Ahead Logging](topic.html?p=07-write-ahead-logging) · [Ch 08 · Crash Recovery](topic.html?p=08-crash-recovery) · [Ch 09 · Database Replication](topic.html?p=09-replication) · [Ch 14 · CAP Theorem](topic.html?p=14-cap-theorem) · [Ch 15 · Consensus](topic.html?p=15-consensus) · [Ch 17 · Multi-Region Databases](topic.html?p=17-multi-region-databases) · [Ch 20 · Database + Application](topic.html?p=20-database-application-architecture) · [Ch 25 · Database Reliability Engineering](topic.html?p=25-database-reliability-engineering) · [Ch 26 · Backup & Disaster Recovery](topic.html?p=26-backup-disaster-recovery)

**Other handbooks:** [System Design · Non-Functional Requirements](../system-design/topic.html?p=03-non-functional-requirements) · [System Design · Consensus](../system-design/topic.html?p=20-consensus) · [System Design · Resilience Patterns](../system-design/topic.html?p=27-resilience-patterns) · [Caching with Redis · Replication & Sentinel](../redis-caching/topic.html?p=25-replication-sentinel)

- **Patroni Documentation** — Patroni project · *Intermediate* · the DCS-based HA model, settings (ttl, loop_wait, synchronous_mode) and REST API. <https://patroni.readthedocs.io/en/latest/>
- **PostgreSQL: High Availability, Load Balancing, and Replication** — PostgreSQL docs · *Intermediate* · standby servers, failover, synchronous replication and hot standby. <https://www.postgresql.org/docs/current/high-availability.html>
- **PostgreSQL: pg_rewind** — PostgreSQL docs · *Intermediate* · exactly what pg_rewind copies and its prerequisites. <https://www.postgresql.org/docs/current/app-pgrewind.html>
- **Amazon RDS Multi-AZ deployments** — AWS docs · *Beginner* · how managed synchronous standbys and endpoint failover work. <https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.html>
- **Google SRE Book, ch. 3 "Embracing Risk"** — Google · *Intermediate* · error budgets and what the nines really cost. <https://sre.google/sre-book/embracing-risk/>
- **How to do distributed locking** — Martin Kleppmann · *Advanced* · leases, process pauses, and why fencing tokens are needed. <https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html>
- **Orchestrator** — GitHub (openark/orchestrator) · *Intermediate* · MySQL topology management and failover, the MySQL-side counterpart. <https://github.com/openark/orchestrator>

---

*Database Design Handbook — chapter 18.*
