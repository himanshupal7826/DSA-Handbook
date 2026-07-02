# 13 · Vertical vs Horizontal Scaling & Statelessness

> **In one line:** Scaling up buys a bigger box until you hit a ceiling; scaling out adds more boxes indefinitely — but only works if your services are stateless, which is why externalizing state is the real unlock.

---

## 1. Overview

When traffic outgrows a system, you have two moves. **Vertical scaling (scale up)** replaces the machine with a bigger one — more CPU, RAM, faster disk. **Horizontal scaling (scale out)** adds more machines and spreads load across them. Every large system eventually chooses *out*, because there's no `4,000-core` server, but there's no limit to how many `16-core` boxes you can rack.

The problem scale-up solves is immediate and simple: a database at `80%` CPU gets a bigger instance and breathes again — no code changes, no distributed-systems complexity. The problem is it ends. Hardware has a ceiling, cost grows super-linearly (the biggest instances cost far more than `2×` a mid one), and a single box is a single point of failure. Scale-out has no ceiling and gives you redundancy for free — but it demands that any request can be served by any node.

That demand is **statelessness**. A stateless service keeps no client-specific data in its own memory between requests; all state lives in a shared store (Redis, a database) or is carried by the request (a token). Once your services are stateless, scaling becomes trivial: add nodes behind a load balancer, and autoscaling grows and shrinks the fleet with demand. The catch — and the punchline of almost every scaling story — is that the **database becomes the eventual bottleneck**, because it's the one stateful thing everyone shares.

## 2. Core Concepts

- **Vertical scaling (scale up)** — a bigger machine (more cores/RAM/IOPS). Simple, no code changes; bounded by hardware and cost.
- **Horizontal scaling (scale out)** — more machines behind a load balancer. Unbounded and redundant; requires statelessness and coordination.
- **Stateless service** — holds no per-client state between requests in local memory; any instance can serve any request. The precondition for scale-out.
- **Stateful service** — keeps essential state locally (in-memory sessions, local cache/disk); scaling and failover are hard.
- **Externalized state** — session/state moved to a shared store: **Redis** (sessions/cache), a database, or a signed **token (JWT)** the client carries.
- **Sticky sessions vs token auth** — affinity pins a user to a node (fragile); tokens/shared store let any node serve any user (robust).
- **Autoscaling** — automatically adding/removing instances based on a metric (CPU, RPS, queue depth) against target thresholds.
- **Warmup / cold start** — new instances aren't instantly useful (JIT warmup, cache fill, connection pools), so scaling must anticipate load.
- **Scale ceiling** — the point where an approach stops working: hardware limit for scale-up, coordination/data limits for scale-out.
- **Database as bottleneck** — the shared stateful tier that scale-out eventually concentrates pressure on (see **Database Scaling**).

## 3. Architecture

The winning pattern: a stateless app tier that scales horizontally behind a load balancer, with all state pushed down into shared, independently scaled stores. Autoscaling grows the stateless tier freely; the data tier is scaled separately (replicas, sharding, cache).

```svg
<svg viewBox="0 0 760 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah4" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#475569"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" fill="#64748b">Stateless tier scales out; state lives in shared stores</text>

  <rect x="30" y="140" width="95" height="42" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="77" y="166" text-anchor="middle" fill="#1e293b">Clients</text>

  <rect x="170" y="140" width="105" height="42" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="222" y="161" text-anchor="middle" fill="#1e293b">Load</text>
  <text x="222" y="176" text-anchor="middle" fill="#1e293b" font-size="11">Balancer</text>
  <line x1="125" y1="161" x2="168" y2="161" stroke="#475569" stroke-width="1.5" marker-end="url(#ah4)"/>

  <!-- stateless tier -->
  <rect x="315" y="55" width="150" height="230" rx="12" fill="none" stroke="#059669" stroke-dasharray="4 3"/>
  <text x="390" y="73" text-anchor="middle" fill="#059669" font-size="11">stateless app tier (scale out →)</text>
  <rect x="335" y="85" width="110" height="34" rx="7" fill="#ecfdf5" stroke="#059669"/>
  <text x="390" y="107" text-anchor="middle" fill="#1e293b" font-size="12">app-1</text>
  <rect x="335" y="128" width="110" height="34" rx="7" fill="#ecfdf5" stroke="#059669"/>
  <text x="390" y="150" text-anchor="middle" fill="#1e293b" font-size="12">app-2</text>
  <rect x="335" y="171" width="110" height="34" rx="7" fill="#ecfdf5" stroke="#059669"/>
  <text x="390" y="193" text-anchor="middle" fill="#1e293b" font-size="12">app-3</text>
  <rect x="335" y="214" width="110" height="34" rx="7" fill="#ecfdf5" stroke="#059669" stroke-dasharray="3 2"/>
  <text x="390" y="236" text-anchor="middle" fill="#64748b" font-size="12">app-N (autoscale)</text>
  <line x1="275" y1="161" x2="333" y2="150" stroke="#475569" stroke-width="1.5" marker-end="url(#ah4)"/>

  <!-- shared stores -->
  <rect x="540" y="70" width="180" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="630" y="94" text-anchor="middle" fill="#1e293b">Redis (session/cache)</text>
  <rect x="540" y="135" width="180" height="40" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="630" y="153" text-anchor="middle" fill="#1e293b">Database</text>
  <text x="630" y="168" text-anchor="middle" fill="#d97706" font-size="11">eventual bottleneck</text>
  <rect x="540" y="200" width="180" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="630" y="224" text-anchor="middle" fill="#1e293b">Object store / queue</text>

  <line x1="465" y1="120" x2="538" y2="92" stroke="#475569" stroke-width="1.2" marker-end="url(#ah4)"/>
  <line x1="465" y1="160" x2="538" y2="155" stroke="#475569" stroke-width="1.2" marker-end="url(#ah4)"/>
  <line x1="465" y1="200" x2="538" y2="218" stroke="#475569" stroke-width="1.2" marker-end="url(#ah4)"/>
</svg>
```

## 4. How It Works

How a system evolves from one box to an elastic fleet:

1. **Start vertical.** One app + DB on a decent box. Traffic grows → bump the instance size. Zero architectural change; buys months.
2. **Hit the scale-up ceiling.** CPU/RAM maxes on the largest cost-effective instance, or the single box's failure risk becomes unacceptable.
3. **Make the app stateless.** Move in-memory sessions to Redis (or switch to JWTs); move local file writes to object storage; ensure no request depends on landing on a specific node.
4. **Add a load balancer + more app nodes.** Now `N` identical stateless nodes serve traffic; any can die or be replaced without user impact (see **Load Balancing**).
5. **Turn on autoscaling.** Define a policy — e.g. target `60%` CPU or `50 RPS/instance` — so the fleet grows on spikes and shrinks off-peak, with warmup accounted for.
6. **Pressure moves to the data tier.** With app nodes now cheap and plentiful, the shared database becomes the constraint.
7. **Scale the database separately.** Read replicas, caching, then sharding/partitioning — the hard, stateful scaling problem (see **Database Scaling**).

## 5. Key Components / Deep Dive

### Scale up vs scale out — and their ceilings

Scale-up ceilings: a finite max instance size, super-linear cost at the top end, and (critically) a **single point of failure** — one box, one fault domain. Scale-out ceilings are softer but real: **coordination overhead** (distributed locks, consensus), **shared bottlenecks** (the database, a message broker), and **data gravity** — stateless compute scales trivially, but the data it reads/writes does not. You scale out the easy tier freely and fight the data tier deliberately.

### Why stateless services scale

If a node holds a user's session in local memory, only *that* node can serve them → you need affinity (sticky sessions), failover loses the session, and autoscaling can't rebalance existing users. If the node holds **nothing** client-specific, every node is interchangeable: the LB round-robins freely, a dead node is simply replaced, and adding nodes linearly adds capacity. Statelessness converts scaling from a distributed-state problem into "add more identical boxes."

### Externalizing session / state

| Approach | Where state lives | Pros | Cons |
|---|---|---|---|
| **In-memory (local)** | The app node | Fastest; simplest to write | Not scalable; lost on restart; needs sticky sessions |
| **Sticky sessions** | The pinned node | Keeps local state usable | Skewed load, broken failover, blocks autoscale |
| **Shared store (Redis)** | Central Redis/DB | Any node serves any user; survives restarts | Extra hop (`~1 ms`); Redis is now a dependency to scale/HA |
| **Token (JWT)** | The client carries it | Zero server-side session store; fully stateless | Revocation is hard; token size; must protect the signing key |

The practical pattern: **JWT** for stateless authentication + **Redis** for anything that must be server-side and shared (rate-limit counters, carts, ephemeral session data). Sticky sessions are a last resort, treated as best-effort only.

### Autoscaling policies & warmup

- **Metric-driven:** target-tracking (hold CPU at `60%`), step scaling (add 4 nodes if RPS crosses a threshold), or schedule-based (pre-scale before a known 9 a.m. spike).
- **Scale-out fast, scale-in slow:** aggressive on the way up, conservative on the way down (cooldowns) to avoid flapping.
- **Account for warmup / cold start:** a new instance isn't instantly useful — JIT warmup, cache fill, connection-pool ramp, container/JVM boot. Use readiness checks, pre-warmed pools, and scale on a *leading* signal (queue depth, upstream latency) so capacity arrives *before* saturation.
- **Right metric matters:** CPU is fine for compute-bound; use RPS, queue depth, or p99 latency for I/O-bound services.

### The database as the eventual bottleneck

Stateless app tiers scale to thousands of nodes cheaply — and then all of them hammer one shared database. That's the wall. The escalation: **connection pooling / a proxy** (PgBouncer) so `10,000` app threads don't open `10,000` DB connections → **caching** (Redis) to absorb reads → **read replicas** for read scaling → **vertical scale** of the primary as a stopgap → **sharding/partitioning** to scale writes horizontally (the genuinely hard step). See **Database Scaling** and **Caching**.

## 6. Trade-offs

| Option | Pros | Cons |
|---|---|---|
| **Vertical (scale up)** | Simple, no code change, no distributed complexity, low latency (one box) | Hardware ceiling, super-linear cost, SPOF, downtime to resize |
| **Horizontal (scale out)** | Near-unlimited, redundant (no SPOF), commodity hardware, elastic | Needs statelessness, LB, coordination; data tier still hard |
| **Sticky sessions** | Reuse local state, minimal change | Skewed load, lost sessions on failover, blocks autoscale |
| **Redis-externalized state** | Any node serves any user; survives restarts | Network hop; Redis must itself be HA/scaled |
| **JWT tokens** | Fully stateless, no session store | Hard revocation, larger requests, key-management risk |
| **Autoscaling** | Match cost to demand, absorb spikes | Cold-start lag, flapping, thrash if misconfigured |

The core decision: **scale up first, scale out when you must.** Vertical scaling is the right *first* answer — it's cheap in engineering effort and buys real time. Reach for horizontal scaling when you hit the hardware ceiling, need redundancy, or must scale elastically. But horizontal scaling is only free at the *stateless* tier; the stateful database is where the real work always lands.

## 7. When to Use / When to Avoid

**Scale vertically when:**
- You're early — a bigger box is faster than re-architecting and buys months of runway.
- The workload is genuinely hard to distribute (a single-writer database primary, an in-memory graph).
- Latency is paramount and cross-node coordination would hurt more than it helps.

**Scale horizontally when:**
- You've hit the instance-size ceiling or cost per unit is exploding at the top end.
- You need high availability — no single box can be allowed to take the system down.
- Load is spiky and you want elasticity (autoscale up/down with demand).
- The tier is (or can be made) stateless — the precondition for it to work at all.

**Avoid horizontal scaling when:** the service is stubbornly stateful and can't be externalized cheaply, or the added LB/coordination/data-sync complexity outweighs the gain at your current scale.

## 8. Scaling & Production Best Practices

- **Make services stateless first** — externalize sessions to Redis or use JWTs before you scale out; it's the enabling move.
- **Push all state down** — sessions to Redis, files to object storage (S3), nothing durable on local disk.
- **Scale up to buy time, then out for the ceiling/HA** — don't prematurely distribute a service a bigger box would serve fine.
- **Autoscale on the right metric** (RPS/queue depth/p99 for I/O-bound, CPU for compute-bound); scale out fast, in slow.
- **Design for warmup** — readiness probes, pre-warmed connection pools, leading-signal scaling so capacity lands before saturation.
- **Protect the database early** — connection pooling/proxy, then caching, then replicas; plan the sharding story before you need it.
- **Keep instances immutable and identical** — no per-node config drift, so any node truly is interchangeable.
- **Test failure** — kill nodes in staging (chaos) to prove statelessness and that the LB drains and reschedules cleanly.

## 9. Failure Modes & Mitigations

| Failure | Impact | Mitigation |
|---|---|---|
| Scale-up hits hardware ceiling | Can't grow; forced re-architecture under pressure | Plan the stateless/scale-out path before you're maxed |
| Single big box dies | Full outage (SPOF) | Horizontal + LB for redundancy; multi-AZ |
| Hidden local state | New nodes serve wrong/empty data; failover logs users out | Audit for in-memory state; externalize to Redis/JWT; chaos-test |
| Autoscale cold-start lag | Capacity arrives after the spike → latency/errors | Scale on leading signal, pre-warm pools, keep min-capacity headroom |
| Autoscale flapping | Constant churn, thrash, cost spikes | Cooldowns, hysteresis, scale-in slower than scale-out |
| DB connection exhaustion | App scales but DB refuses connections | Connection pooler (PgBouncer); cap per-node pool size |
| Database saturates | Whole system slows despite huge app tier | Cache, read replicas, then shard; the planned escalation |
| Redis (session store) down | All users logged out / requests fail | Redis HA (replication + failover); JWTs to reduce dependence |

## 10. Monitoring & Metrics

- **Per-instance:** CPU, memory, RPS, p50/p95/p99 latency, error rate — the autoscaling inputs.
- **Fleet:** instance count vs demand, scale-out/in events, time-to-ready of new instances (warmup cost).
- **Autoscaling health:** frequency of scaling events (flapping detector), min/max headroom hit, cooldown breaches.
- **Database:** connection count vs max, replication lag, slow-query rate, primary CPU/IOPS — watch these to catch the bottleneck moving.
- **Session store (Redis):** hit ratio, latency, memory usage, eviction rate.
- **Cost per request / per instance-hour** — scale-up vs scale-out economics.
- **Alerts:** DB connections near max, replication lag rising, autoscale at max capacity, new-instance warmup exceeding threshold, session-store memory/eviction spikes.

## 11. Common Mistakes

1. ⚠️ **Scaling out a stateful service** — new nodes can't serve existing users; you bolt on sticky sessions and inherit their fragility.
2. ⚠️ **Keeping sessions in app memory** — restarts and failovers log everyone out; externalize to Redis or JWT.
3. ⚠️ **Prematurely distributing** what a bigger box would serve fine — paying distributed-systems complexity for no reason.
4. ⚠️ **Autoscaling on the wrong metric** — CPU-based scaling for an I/O-bound service that saturates on connections, not CPU.
5. ⚠️ **Ignoring warmup** — scaling exactly at saturation so cold instances arrive too late to help.
6. ⚠️ **Forgetting the DB connection ceiling** — a `500`-node app tier opening `50,000` connections crushes the database.
7. ⚠️ **Treating the database as infinitely scalable** — it's the eventual bottleneck; plan caching/replicas/sharding early.
8. ⚠️ **Writing to local disk** — files vanish on the next node; use object storage so nodes stay disposable.

## 12. Interview Questions

**Q: What's the difference between vertical and horizontal scaling?**
A: Vertical (scale up) means a bigger single machine — more CPU/RAM/IOPS; simple, no code change, but bounded by hardware, expensive at the top, and a single point of failure. Horizontal (scale out) means more machines behind a load balancer; near-unlimited and redundant, but it requires stateless services and adds coordination complexity. Start vertical, go horizontal when you hit the ceiling or need HA.

**Q: Why do stateless services scale so easily?**
A: Because any instance can serve any request. No client-specific state lives in local memory, so the load balancer can send traffic to any node, a dead node is simply replaced, and adding nodes adds capacity linearly. Statelessness turns scaling from a distributed-state problem into "add more identical boxes."

**Q: How do you externalize session state, and what are the options?**
A: Move it out of app memory into a shared store or the request itself. Redis holds server-side sessions/carts/counters — any node reads them, and they survive restarts, at the cost of a `~1 ms` hop and a new HA dependency. Alternatively a signed JWT carries state in the request, needing no server store at all, but revocation is hard and the signing key must be protected. Common pattern: JWT for auth + Redis for shared server-side state.

**Q: Why avoid sticky sessions?**
A: Affinity pins a user to one node so its local state is found, but it skews load toward nodes holding heavy users, loses sessions on failover, and prevents autoscaling from rebalancing existing users. It's a crutch for statefulness; externalize state instead and treat any affinity as best-effort.

**Q: What metrics would you autoscale on, and why not always CPU?**
A: Use the metric that actually saturates the service: CPU for compute-bound work, but RPS, queue depth, active connections, or p99 latency for I/O-bound services that hit limits long before CPU. Autoscaling on CPU for a service bottlenecked on database connections will never trigger while the service dies.

**Q: What is warmup / cold start and why does it matter for autoscaling?**
A: A freshly launched instance isn't immediately useful — JIT/JVM warmup, cache priming, connection-pool ramp, container boot all take time. If you scale exactly at saturation, cold instances arrive too late. Mitigate with readiness probes, pre-warmed pools, minimum-capacity headroom, and scaling on a leading signal (queue depth/upstream latency) so capacity lands before the spike bites.

**Q: (Senior) You've scaled the app tier to hundreds of stateless nodes and the system still slows down. Where's the bottleneck and how do you attack it?**
A: The shared database — hundreds of stateless nodes concentrate all state pressure on it. Attack in order: add a connection pooler/proxy (PgBouncer) so app threads don't exhaust DB connections; add caching (Redis) to absorb reads; add read replicas to scale reads; vertically scale the primary as a stopgap; then shard/partition to scale writes horizontally — the genuinely hard step because it forces data-locality and cross-shard query decisions. See **Database Scaling**.

**Q: (Senior) When would you deliberately choose vertical over horizontal scaling even at large scale?**
A: When the workload resists distribution: a single-writer relational primary where sharding would break transactional invariants, an in-memory analytical/graph workload that needs one large address space, or a latency-critical path where cross-node coordination costs more than it saves. Also as a fast stopgap — a bigger box buys real time to build the harder horizontal path properly instead of rushing it under fire.

**Q: (Senior) Design an autoscaling policy that handles both a predictable 9 a.m. spike and unpredictable flash crowds without flapping or cold-start pain.**
A: Combine schedule-based pre-scaling (grow capacity a few minutes before 9 a.m. from history) with target-tracking on a leading metric (queue depth or upstream p99, not lagging CPU) for the unpredictable spikes. Scale out aggressively (large steps, short cooldown) and scale in conservatively (small steps, long cooldown + hysteresis) to prevent flapping. Keep a minimum-capacity floor for headroom, pre-warm connection pools/readiness so new nodes are useful fast, and cap max capacity to protect the database from being overwhelmed by the very fleet you're growing.

**Q: What does "the database is the eventual bottleneck" mean?**
A: Stateless compute scales out trivially and cheaply, but it all shares one stateful database — so as the app tier grows, pressure concentrates there. It's the one thing you can't just clone. The whole discipline of database scaling (pooling, caching, replicas, sharding) exists because scale-out relentlessly pushes load onto that shared, hard-to-distribute tier.

**Q: How do statelessness and load balancing relate?**
A: They're two halves of horizontal scaling. Statelessness makes every node interchangeable; the load balancer exploits that by freely distributing requests, replacing dead nodes, and draining nodes on deploy. Without statelessness the LB needs sticky sessions and loses most of its power. See **Load Balancing**.

## 13. Alternatives & Related

- **Load Balancing** — the mechanism that distributes traffic across the horizontally scaled, stateless fleet; see topic 09.
- **Database Scaling** — how you tackle the eventual bottleneck (replicas, sharding, partitioning).
- **Caching** — the first defense that keeps read load off the database.
- **CDN** — offloading static/cacheable traffic entirely from the origin; see topic 11.
- **Consistent Hashing** — distributing stateful data across a scaled-out data tier with minimal reshuffle.
- **Microservices** — decomposing so each service scales independently on its own bottleneck.

## 14. Cheat Sheet

> [!TIP]
> **Scaling & Statelessness in 60 seconds**
> - **Scale up** = bigger box (simple, ceilinged, SPOF). **Scale out** = more boxes (unlimited, redundant, needs statelessness).
> - **Rule of thumb:** scale up to buy time; scale out for the ceiling and for HA.
> - **Statelessness is the unlock** — no client state in local memory ⇒ any node serves any request ⇒ add boxes = add capacity.
> - **Externalize state:** sessions/counters → **Redis**, auth → **JWT**, files → **object storage**. Avoid **sticky sessions**.
> - **Autoscale** on the metric that saturates (RPS/queue/p99, not always CPU); out fast, in slow; account for **warmup/cold start**.
> - **The database is the eventual bottleneck:** pooling → caching → read replicas → sharding. Plan it early.

**References:** AWS Well-Architected Framework (Reliability & Performance Efficiency pillars), "Designing Data-Intensive Applications" (ch. 1 "Scalability"), Google SRE Book (autoscaling/load management), The Twelve-Factor App (factors VI "Processes" & VIII "Concurrency")

---
*System Design Handbook — topic 13.*
