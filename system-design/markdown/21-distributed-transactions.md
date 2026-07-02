# 21 · Distributed Transactions, 2PC & Saga

> **In one line:** When one business operation spans multiple services or databases, you trade ACID atomicity for either a blocking coordinator (2PC) or eventual consistency with compensations (Saga).

---

## 1. Overview

A single database gives you a transaction: `BEGIN … COMMIT`, and either everything happens or nothing does, with isolation from concurrent work. Split that operation across two databases — or, in microservices, across an Orders service and a Payments service and an Inventory service — and the guarantee evaporates. There is no `COMMIT` that spans separate systems with separate storage engines and separate failure timelines. This is the **distributed transaction** problem: how do you make "charge the card **and** reserve the item **and** create the order" atomic when each step lives somewhere else?

Cross-service **ACID is hard** for a fundamental reason: to be atomic, all participants must agree to commit or abort *together*, which requires coordination — and coordination can fail exactly when you're mid-decision. If the coordinator crashes after telling A to commit but before telling B, you have an inconsistent world and no clean way to recover without blocking.

Two families of answers exist. **Two-Phase Commit (2PC)** preserves strict atomicity by voting first, then committing — but it *blocks* if the coordinator dies at the wrong moment, and it holds locks the whole time, murdering availability and throughput. **Sagas** abandon global atomicity: they run the operation as a sequence of local transactions, and if a later step fails, they run **compensating transactions** to semantically undo the earlier ones. You get availability and no distributed locks, at the cost of only *eventual* consistency and temporary visible inconsistency.

Real example: an e-commerce checkout. Booking.com or Amazon do **not** run 2PC across payments, inventory, and shipping — the lock-holding and blocking would be catastrophic at scale. They run a **Saga**: reserve inventory, charge payment, create shipment; if shipment allocation fails, *refund* the payment and *release* the inventory. The system is briefly inconsistent (money taken, order not yet confirmed) but always converges, and it stays available.

## 2. Core Concepts

- **Distributed transaction:** an operation whose atomic unit spans ≥2 independent transactional resources (databases, services, queues).
- **Atomic commit:** all participants commit or all abort — the property 2PC tries to preserve and Saga deliberately relaxes.
- **Two-Phase Commit (2PC):** a **coordinator** asks all participants to **prepare** (vote yes/no, durably lock); if all vote yes it tells them to **commit**, else **abort**.
- **Prepared state:** a participant has durably promised it *can* commit and must wait for the coordinator's verdict — it cannot unilaterally decide, which is the source of blocking.
- **Coordinator blocking failure:** if the coordinator crashes after some participants are prepared, those participants block (holding locks) until it recovers — the fatal 2PC weakness.
- **Three-Phase Commit (3PC):** adds a **pre-commit** phase and timeouts to make participants non-blocking; works only under synchronous-network assumptions, so rarely used in practice.
- **Saga:** a sequence of local transactions T1…Tn, each with a **compensating** transaction C1…Cn that semantically undoes it; on failure at step k, run Ck-1…C1.
- **Compensating transaction:** a *new* transaction that reverses the business effect of a prior one (refund, not rollback) — because the original already committed and is visible.
- **Orchestration vs choreography:** a central orchestrator drives the saga steps, vs services reacting to each other's events with no central brain.
- **Outbox pattern:** atomically write the business row **and** an event row in the *same* local transaction, then relay the event — eliminates the "wrote DB but crashed before publishing" dual-write bug.
- **TCC (Try-Confirm-Cancel):** a saga-like protocol where each service first *reserves* (Try), then the orchestrator *Confirms* or *Cancels* all — a business-level 2PC without held DB locks.

## 3. Architecture

Two fundamentally different shapes. **2PC** centralizes the decision and holds locks across a vote+commit round-trip. A **Saga** chains local commits and compensates backward on failure — no global lock, no blocking coordinator, but transient inconsistency.

```svg
<svg viewBox="0 0 720 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a3" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
    <marker id="a3r" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#b91c1c"/>
    </marker>
  </defs>

  <!-- 2PC half -->
  <text x="180" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">2PC — atomic but blocking</text>
  <rect x="120" y="40" width="120" height="44" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="180" y="67" text-anchor="middle" fill="#1e293b">Coordinator</text>
  <rect x="40"  y="150" width="110" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="95" y="175" text-anchor="middle" fill="#1e293b">Payments</text>
  <rect x="210" y="150" width="110" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="265" y="175" text-anchor="middle" fill="#1e293b">Inventory</text>
  <line x1="150" y1="84" x2="100" y2="146" stroke="#475569" stroke-width="1.4" marker-end="url(#a3)"/>
  <line x1="210" y1="84" x2="262" y2="146" stroke="#475569" stroke-width="1.4" marker-end="url(#a3)"/>
  <text x="55" y="120" fill="#64748b" font-size="10">prepare?</text>
  <text x="245" y="120" fill="#64748b" font-size="10">prepare?</text>
  <text x="180" y="215" text-anchor="middle" fill="#64748b" font-size="11">all vote YES → commit;</text>
  <text x="180" y="230" text-anchor="middle" fill="#b91c1c" font-size="11">coordinator dies here → participants block (locks held)</text>

  <line x1="360" y1="40" x2="360" y2="320" stroke="#cbd5e1" stroke-width="1"/>

  <!-- Saga half -->
  <text x="540" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Saga — available, eventual</text>
  <rect x="400" y="70" width="90" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="445" y="95" text-anchor="middle" fill="#1e293b">T1 Order</text>
  <rect x="520" y="70" width="90" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="565" y="95" text-anchor="middle" fill="#1e293b">T2 Pay</text>
  <rect x="640" y="70" width="70" height="40" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="675" y="95" text-anchor="middle" fill="#1e293b">T3 Ship</text>
  <line x1="490" y1="90" x2="516" y2="90" stroke="#475569" stroke-width="1.4" marker-end="url(#a3)"/>
  <line x1="610" y1="90" x2="636" y2="90" stroke="#475569" stroke-width="1.4" marker-end="url(#a3)"/>
  <text x="675" y="135" text-anchor="middle" fill="#b91c1c" font-size="11">T3 fails ✗</text>
  <!-- compensations -->
  <rect x="400" y="200" width="90" height="40" rx="8" fill="#eff6ff" stroke="#b91c1c"/>
  <text x="445" y="225" text-anchor="middle" fill="#b91c1c">C1 Cancel</text>
  <rect x="520" y="200" width="90" height="40" rx="8" fill="#eff6ff" stroke="#b91c1c"/>
  <text x="565" y="225" text-anchor="middle" fill="#b91c1c">C2 Refund</text>
  <line x1="565" y1="160" x2="565" y2="196" stroke="#b91c1c" stroke-width="1.4" marker-end="url(#a3r)"/>
  <line x1="516" y1="220" x2="492" y2="220" stroke="#b91c1c" stroke-width="1.4" marker-end="url(#a3r)"/>
  <text x="555" y="300" text-anchor="middle" fill="#64748b" font-size="11">run compensations backward:</text>
  <text x="555" y="315" text-anchor="middle" fill="#059669" font-size="11" font-weight="bold">refund pay, cancel order → converge</text>
</svg>
```

## 4. How It Works

**2PC** (the atomic path):

1. **Prepare / voting phase.** The coordinator sends `PREPARE` to every participant. Each does its work, writes it durably to a **prepared** state (locks held, changes not yet visible), and votes `YES` (can commit) or `NO` (must abort).
2. **Decision.** If *all* vote YES, the coordinator durably logs `COMMIT` and sends `COMMIT` to all; if any votes NO or times out, it logs and sends `ABORT`.
3. **Complete.** Participants apply (or roll back), release locks, and ack. Once the coordinator has logged the decision, it *must* drive it to completion, retrying until every participant acks — a prepared participant may not decide on its own.

**Saga** (the eventual path, orchestration flavor):

1. **Execute T1.** Orchestrator invokes step 1 (e.g. create order, `PENDING`) as a *local* committed transaction and records saga state.
2. **Execute T2…** On success, invoke the next step (charge payment). Each step commits locally and is immediately visible — there is no global lock.
3. **On failure at step k.** The orchestrator switches to compensation and invokes **Ck-1, …, C1** in reverse — new local transactions that semantically undo prior steps (refund payment, release inventory, mark order `CANCELLED`).
4. **Retry vs abort.** Transient failures are *retried forward* (steps must be **idempotent**); unrecoverable ones trigger backward compensation. The saga log is the durable source of truth for where it is.
5. **Converge.** Either all forward steps complete (success) or all completed steps are compensated (clean abort). At no instant is it globally atomic — but it always reaches a consistent end state.

## 5. Key Components / Deep Dive

### Why 2PC blocks — the coordinator failure

The lethal window: participants have voted YES and are **prepared** (holding locks, unable to unilaterally commit or abort), and then the **coordinator crashes** before broadcasting the decision. The prepared participants *cannot* proceed — committing risks violating atomicity if the coordinator had decided abort; aborting risks it if the coordinator had decided commit. So they **block**, holding locks, until the coordinator recovers from its log. This freezes rows/resources and can cascade into lock convoys. 2PC also assumes the coordinator's log is durable and it *will* come back — availability is bounded by the least-available participant and the coordinator. This is why 2PC is confined to tightly-coupled, low-latency, same-datacenter settings (e.g. XA across two databases) and shunned across microservices.

### 3PC — the (mostly theoretical) fix

**Three-Phase Commit** inserts a **pre-commit** phase between vote and commit and gives participants timeouts so they can make progress on their own if the coordinator vanishes. It's **non-blocking** under a *synchronous* network with reliable failure detection — but those assumptions don't hold on real networks (a partition breaks it), and the extra round-trip adds latency. In practice almost nobody deploys 3PC; consensus-backed commit (making the *coordinator itself* fault-tolerant via Raft/Paxos, as Spanner/CockroachDB do) is the modern answer.

### Saga: orchestration vs choreography

| | Orchestration | Choreography |
|---|---|---|
| **Control** | Central orchestrator invokes each step & compensation | Each service reacts to events, emits its own |
| **Coupling** | Services coupled to orchestrator, not each other | Fully decoupled, event-driven |
| **Visibility** | Saga state is explicit & centralized — easy to reason & monitor | Flow is emergent — hard to trace, "where is my order?" is painful |
| **Complexity** | Orchestrator is a component to build/run | No central component, but logic smeared across services |
| **Best for** | Complex flows, many steps, strong observability needs | Simple flows, few services, max autonomy |

Orchestration (e.g. Temporal, Netflix Conductor, AWS Step Functions, Camunda) is the pragmatic default for anything non-trivial: the workflow is a first-class, inspectable, resumable object. Choreography scales team autonomy but turns debugging into archaeology once you pass ~3 steps.

### The outbox pattern — killing the dual-write

The classic bug: a service updates its database **and** publishes an event to Kafka. These are two systems — if the DB commits but the process crashes before publishing (or vice versa), state and events diverge, and the saga stalls or double-acts. The **outbox pattern** fixes it: within the *same local DB transaction*, insert the business row **and** a row into an `outbox` table. A separate relay (polling or CDC via Debezium reading the WAL) publishes outbox rows to the broker and marks them sent. Because the write is a single local ACID transaction, event and state can never disagree; the relay guarantees *at-least-once* delivery, so consumers must be **idempotent**.

### TCC — Try-Confirm-Cancel

**TCC** is a business-level 2PC without database locks. **Try** reserves resources (hold inventory, authorize — not capture — the card). Once all Tries succeed, the coordinator **Confirms** all (capture the payment, commit the reservation); if any Try fails, it **Cancels** all (void the auth, release the hold). Unlike 2PC, the reservations are ordinary committed local transactions with business-defined semantics, so nothing holds a DB lock across the whole flow. The cost: every service must implement three idempotent operations and reason about reservation expiry.

## 6. Trade-offs

| Option | Pros | Cons |
|---|---|---|
| **2PC / XA** | True atomicity & isolation; simple mental model; no compensation code | Blocks on coordinator failure; holds locks across round-trips → low throughput/availability; poor at scale/geo |
| **3PC** | Non-blocking in theory | Breaks under partitions; extra latency; rarely used |
| **Saga (orchestration)** | Available, no distributed locks, scales; explicit workflow state | Only eventual consistency; must write compensations; no isolation (dirty reads possible) |
| **Saga (choreography)** | Max decoupling, event-driven | Hard to trace/debug; emergent logic; cyclic-dependency risk |
| **TCC** | No DB locks, atomic-ish via reserve/confirm | 3 operations per service; reservation timeout logic; more code |
| **Outbox + events** | Reliable exactly-the-state event publishing; no dual-write bug | Adds a relay/CDC pipeline; at-least-once → consumers must be idempotent |

The core trade is **atomicity+isolation (2PC)** vs **availability+scalability (Saga)**. At microservice scale and geo distribution, you almost always **choose eventual consistency over 2PC** and design the UX/business process to tolerate transient inconsistency (pending states, "your refund is processing"). Reserve 2PC for two databases in one datacenter where blocking is acceptable.

## 7. When to Use / When to Avoid

**Use 2PC when:**
- A small number of tightly-coupled, low-latency resources (2–3 databases in one DC) must be strictly atomic.
- You genuinely need isolation (no partial visibility) and can tolerate the lock-holding/blocking risk.
- Throughput is modest and the operation is short.

**Use Saga (prefer this at service scale) when:**
- The operation spans multiple independently-owned services / databases.
- Availability and throughput matter more than instantaneous consistency.
- Steps have natural business compensations (refund, cancel, release) and can tolerate transient inconsistency.

**Avoid distributed transactions entirely when you can:**
- Redraw service boundaries so the operation is a *single* local transaction (aggregate design in DDD) — the best fix is often to not need a distributed transaction.
- The steps are independent and don't require all-or-nothing.

## 8. Scaling & Production Best Practices

- **Prefer sagas over 2PC across services** — 2PC's lock-holding caps throughput and its blocking failure mode is unacceptable at scale.
- **Make every step and compensation idempotent** — retries and at-least-once delivery are inevitable; use idempotency keys and dedup tables so re-delivery is a no-op.
- **Use the outbox pattern (CDC via Debezium) for all state-change events** — never dual-write to DB and broker directly.
- **Use a durable workflow engine** (Temporal, Step Functions, Conductor) for orchestration — it persists saga state, survives crashes, and gives retries/timeouts/visibility for free rather than hand-rolling a state machine.
- **Design compensations as business reversals, not rollbacks** — you can't un-send an email; you send an apology. Model "semantic undo."
- **Bound reservations with timeouts (TCC)** — a Try that's never Confirmed must auto-expire so inventory isn't leaked.
- **Handle the "commit after compensation" race** — a slow forward step completing after compensation started must be detected (saga versioning) and re-compensated.
- **Model pending states explicitly** in data and UX (`PENDING`, `CONFIRMING`, `COMPENSATING`) so partial states are legible to users and ops.

## 9. Failure Modes & Mitigations

| Failure | Impact | Mitigation |
|---|---|---|
| **2PC coordinator crash mid-decision** | Prepared participants block, holding locks | Durable coordinator log + recovery; make coordinator fault-tolerant via consensus (Raft) |
| **Participant crash while prepared** | Coordinator can't complete; timeout | Persist prepared state; on restart, ask coordinator for the decision |
| **Dual write (DB ok, event lost)** | State & events diverge; saga stalls | **Outbox pattern** + CDC relay (single local txn) |
| **Duplicate event delivery** | Step runs twice (double charge) | Idempotency keys; dedup table; idempotent handlers |
| **Compensation fails** | Stuck partially-committed saga | Retry compensation with backoff; alert + manual/dead-letter queue; make comps idempotent & retriable |
| **Lack of isolation (dirty read)** | Another txn sees an intermediate saga state | Semantic locks / status flags (`PENDING`); versioning; commutative updates |
| **Orphaned reservation (TCC Try, no Confirm)** | Inventory/credit leaked | Reservation TTL + reaper that auto-cancels |
| **Non-compensatable step ran** | Can't undo (email sent, money wired) | Order steps so irreversible actions are **last**; use pending/pivot steps |

## 10. Monitoring & Metrics

- **Saga completion rate & duration (p50/p99)** — how many finish forward vs how long they take.
- **Compensation rate** — % of sagas that had to roll back; a rising trend signals an unhealthy downstream service.
- **Stuck / in-flight saga count & age** — sagas older than N minutes need paging; the classic "money taken, order never confirmed" leak.
- **Outbox lag** — unpublished outbox rows and relay delay; growth means the CDC/relay is behind and events are stalling.
- **Idempotency-key hit rate / duplicate deliveries** — confirms dedup is working under retries.
- **Dead-letter queue depth** — failed compensations/events needing intervention.
- **2PC (if used): prepared-but-undecided count & lock wait time** — the blocking signal.
- **Reservation expiry / reaper actions (TCC)** — orphaned Tries being cleaned up.

## 11. Common Mistakes

1. ⚠️ **Reaching for 2PC across microservices** — the lock-holding and coordinator-blocking failure mode doesn't scale; use a saga.
2. ⚠️ **Dual-writing to DB and broker** without the outbox — the single most common source of lost events and stuck sagas.
3. ⚠️ **Non-idempotent steps/compensations** — with at-least-once delivery this double-charges and double-ships.
4. ⚠️ Treating compensations as **DB rollbacks** — the original already committed and is visible; you need a *new* business-reversal transaction.
5. ⚠️ **Ignoring isolation** — sagas expose intermediate states; another operation can read a half-done order. Use status flags / semantic locks.
6. ⚠️ Putting an **irreversible step (send money, send email) before** a step that can still fail — order steps so the un-compensatable action is last (or use a pivot/pending step).
7. ⚠️ **Choreography for a complex flow** — beyond ~3 services it becomes untraceable; use orchestration with an explicit workflow engine.
8. ⚠️ Forgetting the **compensation-vs-late-forward race** — a delayed step completing after abort started re-creates the effect you just undid.

## 12. Interview Questions

**Q: Why can't you just use a normal ACID transaction across services?**
A: Each service has its own database and storage engine with independent commit timelines; there's no shared transaction manager, and even distributed protocols can't hide that a network/coordinator failure can strand the operation mid-commit. Atomicity across independent resources requires a coordination protocol (2PC) or giving up global atomicity (saga).

**Q: Walk through 2PC and name its fatal flaw.**
A: Phase 1 (prepare): coordinator asks all participants to durably prepare and vote yes/no. Phase 2 (commit/abort): if all voted yes, coordinator logs and broadcasts commit, else abort. Fatal flaw: if the coordinator crashes after participants are *prepared* but before the decision arrives, those participants block — they hold locks and can't safely decide alone — until the coordinator recovers. Availability is hostage to the coordinator.

**Q: What is a compensating transaction and how does it differ from a rollback?**
A: A rollback reverts an *uncommitted* transaction inside one DB, invisibly. A compensation is a *new, committed* transaction that semantically reverses an *already-committed and visible* prior step — refund a charge, release a reservation, mark cancelled. You can't un-commit; you counteract.

**Q: Orchestration vs choreography for sagas — when each?**
A: Orchestration uses a central coordinator that invokes each step and compensation — explicit, observable, resumable; best for complex, multi-step flows and when you need to answer "where is this order?". Choreography has services react to each other's events — maximally decoupled and autonomous, but the flow is emergent and hard to trace; fine for simple 2–3 step flows. Default to orchestration once flows get non-trivial.

**Q: What problem does the outbox pattern solve?**
A: The dual-write problem: updating your DB and publishing an event are two systems, so a crash between them diverges state and events. Outbox writes the business row and an event row in *one local transaction*, then a relay (polling or CDC on the WAL) publishes the event — so state and event can never disagree. It gives at-least-once delivery, so consumers must be idempotent.

**Q: Why do we say "prefer eventual consistency over 2PC" at scale?**
A: 2PC holds locks across network round-trips and *blocks* on coordinator failure, so throughput and availability collapse under load and partitions — unacceptable across many services and regions. Sagas take local commits with compensations: no distributed locks, always available, at the cost of transient visible inconsistency, which most business processes can absorb with pending states.

**Q: (Senior) Sagas give up isolation. What can go wrong and how do you mitigate?**
A: Because each step commits and is visible immediately, another operation can read or act on an intermediate state (a dirty read) — e.g. see an order as placed while payment is still pending, or two sagas both consuming the same inventory. Mitigations: **semantic locks** (status flags like `PENDING`/`RESERVED` that other operations must respect), **commutative updates** (increment/decrement instead of set), **re-reads/re-validation** at the pivot step, and **versioning** to detect concurrent modification. You're re-implementing isolation at the business layer.

**Q: (Senior) One saga step is irreversible (wiring money to a bank). How do you design around it?**
A: You can't compensate it, so you (1) **order it last**, after every step that can still fail, so by the time you reach it the outcome is certain; and/or (2) split it around a **pivot** — steps before the pivot are all compensatable (retriable/undoable), the pivot is the point of no return, and steps after it are **retriable-forward** only (no failure that requires undoing the irreversible action). If an irreversible action truly must precede fallible ones, add a human/manual compensation path (issue a refund via a different channel) and alert.

**Q: (Senior) Design an order-checkout saga end-to-end, including failure handling.**
A: Steps: T1 create order `PENDING`; T2 reserve inventory; T3 authorize payment (auth, not capture — pivot); T4 capture payment; T5 create shipment; T6 mark order `CONFIRMED`. Compensations: C2 release inventory, C3 void authorization, C5 cancel shipment, plus mark order `CANCELLED`. Use an **orchestrator** (Temporal) persisting saga state; **outbox+CDC** for events; **idempotency keys** on every call. Payment auth is the pivot — reservations before it are freely compensatable; capture/shipment after it are retried forward. Failures before the pivot → compensate backward; failures after → retry forward until success, alert on repeated failure. Expose `PENDING`/`CONFIRMING` states in UX.

**Q: (Senior) When would you still choose 2PC over a saga?**
A: When the resources are a small number of tightly-coupled databases in one low-latency datacenter, the operation is short, you genuinely need isolation (no visible intermediate state — e.g. moving money between two ledger tables in different DBs), and throughput is modest enough that lock-holding is acceptable. XA transactions across two RDBMSs are the canonical case. Even then, prefer collapsing them into one database if you can.

**Q: (Senior) A saga is "stuck" — money captured but order never confirmed. How do you find and fix it?**
A: This is why you monitor **in-flight saga age**: alert on sagas older than a threshold. The orchestrator's persisted saga log tells you exactly which step it's on. Root causes: a compensation that keeps failing (retry with backoff, then dead-letter for manual handling), a lost event (check outbox lag / relay health), or a non-idempotent step that a retry skipped. Fix forward by driving the saga to completion (re-invoke the stuck idempotent step) or compensate to a clean cancelled state and refund. The durable orchestrator + idempotency is what makes recovery deterministic.

## 13. Alternatives & Related

- **CAP, PACELC & Consistency Models** — sagas are you *choosing* eventual consistency on purpose.
- **Consensus: Raft, Paxos & Leader Election** — modern atomic commit makes the *coordinator* fault-tolerant via consensus (Spanner, CockroachDB).
- **Message Queues & Event-Driven Architecture** — the substrate for outbox events and choreographed sagas.
- **Idempotency & exactly-once processing** — the prerequisite that makes at-least-once saga steps safe.
- **Domain-Driven Design / Aggregates** — redraw boundaries so an operation fits in one local transaction and needs no distributed transaction at all.

## 14. Cheat Sheet

> [!TIP]
> **Problem:** one business op across ≥2 services/DBs → no shared `COMMIT`.
> **2PC:** prepare (vote+lock) → commit/abort. **Atomic + isolated** but **blocks** if coordinator dies while participants are prepared, and holds locks. Use only for a few DBs in one DC.
> **3PC:** adds pre-commit + timeouts to be non-blocking — but breaks under partitions; rarely used.
> **Saga:** local txns T1..Tn each with compensation C1..Cn; on failure run comps backward. **Available, no locks, eventual** — no isolation.
> **Orchestration** (central, observable — Temporal/Step Functions) beats **choreography** (event-driven, hard to trace) past ~3 steps.
> **Outbox pattern:** write business row + event row in one local txn, relay via CDC → kills the dual-write bug (at-least-once → idempotent consumers).
> **TCC:** Try (reserve) → Confirm/Cancel — business-level 2PC without DB locks.
> **Rules:** idempotent everything; compensate = business reversal, not rollback; put irreversible steps last (pivot); at scale **choose eventual consistency over 2PC**.

**References:** Garcia-Molina & Salem "Sagas" (1987), DDIA ch.9 (2PC, distributed transactions), microservices.io Saga & Outbox patterns, Temporal / AWS Step Functions docs, Gray & Lamport "Consensus on Transaction Commit".

---
*System Design Handbook — topic 21.*
