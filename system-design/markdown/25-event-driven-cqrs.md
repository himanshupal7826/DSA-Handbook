# 25 · Event-Driven Architecture, CQRS & Event Sourcing

> **In one line:** Let services react to facts (events) instead of commanding each other, split the read model from the write model when their needs diverge, and — when the *history* itself is the asset — store events as the source of truth and derive all state from them.

---

## 1. Overview

Three related but distinct ideas travel together and are constantly confused. **Event-Driven Architecture (EDA)** is a communication style: services publish **events** ("OrderPlaced," "PaymentCaptured") and other services react, instead of one service directly commanding another (request-driven). **CQRS (Command Query Responsibility Segregation)** is a modeling choice: use a separate **write model** optimized for validating changes and a separate **read model** optimized for queries, instead of one model doing both. **Event Sourcing** is a persistence choice: store the full **sequence of events** that happened as the source of truth and derive current state by replaying them, instead of storing only the latest state and overwriting it.

You can adopt any one without the others. EDA doesn't require event sourcing. CQRS doesn't require events at all (it can just be two databases). But they compose powerfully: an event-sourced write side naturally emits an event stream that feeds CQRS read models over an event-driven backbone. The unifying insight is treating a **change of state as a first-class, immutable fact** rather than a transient side effect of an UPDATE.

A concrete example: a bank ledger. State-oriented design stores `balance = 1200` and overwrites it on each transaction — you lose *why*. Event sourcing stores `Deposited 500`, `Withdrew 200`, `Deposited 900`; the balance is a fold over that history. You get a perfect audit trail, time-travel ("what was the balance last Tuesday?"), and the ability to build a new read view (a fraud model, a monthly-statement projection) by replaying events you already have. The cost is real: eventual consistency, more moving parts, and schema-evolution pain. This page is about applying each deliberately. See **Message Queues & Async Processing** and **Event Streaming & Kafka Internals** for the transport underneath, and **CAP & Consistency** for the consistency implications.

## 2. Core Concepts

- **Event vs. Command** — a **command** is an *imperative request* to do something ("PlaceOrder"), can be rejected, addressed to one handler. An **event** is an *immutable fact* that already happened ("OrderPlaced"), can't be rejected, broadcast to any number of listeners. Past tense vs. imperative.
- **Request-driven vs. event-driven** — synchronous "do this and tell me the result" vs. asynchronous "this happened; whoever cares, react."
- **Choreography vs. orchestration** — **choreography**: services react to each other's events with no central brain (emergent workflow). **Orchestration**: a central coordinator (a saga orchestrator) explicitly directs each step.
- **CQRS** — separate the **command/write model** (enforces invariants, normalized) from the **query/read model** (denormalized, per-view). They may even be different databases synced by events.
- **Event Sourcing** — persist the ordered log of domain events as the source of truth; **current state = left-fold(events)**. Never update-in-place.
- **Projection / materialized view** — a read model built by consuming events and writing a query-optimized shape (a Postgres table, an Elasticsearch index, a Redis cache).
- **Snapshot** — a periodically-saved fold of an aggregate's state so you don't replay thousands of events on every load.
- **Outbox pattern** — write the domain change and the outgoing event in the **same DB transaction** (to an `outbox` table), then relay to the broker — solving the dual-write problem atomically.
- **Eventual consistency** — read models lag the write model by the propagation delay; the UX must account for the gap.
- **Aggregate** — the consistency boundary (a single order, a single account) within which a command is validated and events are emitted atomically.

## 3. Architecture

The write side accepts commands, validates them against an aggregate, and persists events (an event store, or a normal DB + outbox). Events flow over a broker/log to **projectors** that build one or more read models. Queries hit the read models, never the write side. Sagas coordinate cross-aggregate workflows by reacting to events (choreography) or via an orchestrator.

```svg
<svg viewBox="0 0 780 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ar3" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <!-- command side -->
  <rect x="16" y="30" width="110" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="71" y="55" text-anchor="middle" fill="#1e293b">Client</text>
  <text x="71" y="95" text-anchor="middle" fill="#64748b">command</text>
  <rect x="170" y="24" width="150" height="52" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="245" y="45" text-anchor="middle" fill="#1e293b">Command handler</text>
  <text x="245" y="63" text-anchor="middle" fill="#64748b">validate aggregate</text>
  <rect x="170" y="110" width="150" height="60" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="245" y="134" text-anchor="middle" fill="#1e293b">Event store</text>
  <text x="245" y="152" text-anchor="middle" fill="#64748b">append-only (+ outbox)</text>
  <!-- broker -->
  <rect x="380" y="100" width="120" height="80" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="440" y="128" text-anchor="middle" fill="#1e293b">Event bus</text>
  <text x="440" y="146" text-anchor="middle" fill="#64748b">(Kafka / MQ)</text>
  <text x="440" y="164" text-anchor="middle" fill="#64748b">immutable facts</text>
  <!-- projectors + read models -->
  <rect x="560" y="24" width="140" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="630" y="43" text-anchor="middle" fill="#1e293b">Projector → SQL</text>
  <text x="630" y="60" text-anchor="middle" fill="#64748b">order summary view</text>
  <rect x="560" y="90" width="140" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="630" y="109" text-anchor="middle" fill="#1e293b">Projector → Search</text>
  <text x="630" y="126" text-anchor="middle" fill="#64748b">Elasticsearch index</text>
  <rect x="560" y="156" width="140" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="630" y="175" text-anchor="middle" fill="#1e293b">Projector → Cache</text>
  <text x="630" y="192" text-anchor="middle" fill="#64748b">Redis read model</text>
  <!-- query -->
  <rect x="560" y="240" width="140" height="44" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="630" y="267" text-anchor="middle" fill="#1e293b">Query API (reads)</text>
  <rect x="16" y="240" width="110" height="44" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="71" y="267" text-anchor="middle" fill="#1e293b">Client</text>
  <!-- arrows -->
  <line x1="126" y1="50" x2="168" y2="50" stroke="#475569" marker-end="url(#ar3)"/>
  <line x1="245" y1="76" x2="245" y2="108" stroke="#475569" marker-end="url(#ar3)"/>
  <line x1="320" y1="140" x2="378" y2="140" stroke="#475569" marker-end="url(#ar3)"/>
  <line x1="500" y1="120" x2="558" y2="47" stroke="#475569" marker-end="url(#ar3)"/>
  <line x1="500" y1="135" x2="558" y2="113" stroke="#475569" marker-end="url(#ar3)"/>
  <line x1="500" y1="150" x2="558" y2="179" stroke="#475569" marker-end="url(#ar3)"/>
  <line x1="630" y1="202" x2="630" y2="238" stroke="#475569" marker-end="url(#ar3)"/>
  <line x1="558" y1="262" x2="128" y2="262" stroke="#475569" marker-end="url(#ar3)"/>
  <text x="343" y="255" text-anchor="middle" fill="#64748b">reads never touch the write side · eventual consistency</text>
</svg>
```

## 4. How It Works

The command-to-query lifecycle in an event-sourced CQRS system:

1. **Command arrives.** Client sends `PlaceOrder` to the command handler.
2. **Load aggregate.** The handler rebuilds the order aggregate's current state by folding its past events (or loads the latest **snapshot** + events since).
3. **Validate invariants.** Business rules run against that state ("item in stock," "credit ok"). If violated, reject the command — nothing is written.
4. **Append events.** On success, append new immutable events (`OrderPlaced`, `InventoryReserved`) to the **event store** atomically. This is the commit point; state is now official.
5. **Publish reliably.** Emit the events to the bus — using the **outbox pattern** so the event store write and the publish can't diverge (write to outbox in the same txn, relay after).
6. **Project.** Independent **projectors** consume events and update read models: a normalized SQL summary, a search index, a cached dashboard — each shaped for its queries.
7. **Query.** Reads hit the read models directly, fast and denormalized, **never** the write side. They may be milliseconds-to-seconds stale.
8. **React / coordinate.** Other services (or a saga) react to the events to continue the workflow (charge payment, notify shipping), emitting further events.

```text
command ─▶ load aggregate (fold events / snapshot)
        ─▶ validate invariants ─▶ (reject | append events)
event store ──outbox──▶ bus ──▶ projector A ─▶ SQL read model
                              └▶ projector B ─▶ search index
query ─▶ read model (denormalized, eventually consistent)
saga   ─▶ reacts to events ─▶ next command
```

## 5. Key Components / Deep Dive

### Event-driven vs. request-driven

Request-driven (RPC) is synchronous and coupled: the caller knows the callee, waits for it, and fails if it's down. Event-driven inverts control: the producer emits a fact and **doesn't know or care who consumes it**. This buys extensibility (add a new consumer without touching the producer) and resilience (a down consumer just lags), at the cost of harder end-to-end reasoning, debugging, and no synchronous "did it work?" answer. Use request-driven when the caller needs the result *now*; event-driven when reactions are asynchronous and the set of reactors grows.

### Choreography vs. orchestration

For multi-step workflows (a **saga** spanning services), you choose who holds the logic:

| | Choreography | Orchestration |
|---|---|---|
| Control | Distributed; each service reacts to events | Central orchestrator issues commands |
| Coupling | Loose; easy to add reactors | Coupled to orchestrator; logic centralized |
| Visibility | Hard — flow is emergent, spread across services | Easy — the workflow lives in one place |
| Failure/compensation | Each service emits compensating events | Orchestrator drives compensating steps |
| Best for | Simple, few-step flows | Complex, many-step, needs clear control |

Choreography scales organizationally but the workflow becomes implicit and hard to trace. Orchestration is explicit and debuggable but reintroduces a coordinating dependency. Many teams start choreographed and add an orchestrator when flows exceed ~3–4 steps.

### CQRS — why and what it costs

CQRS separates the model that **changes** data from the model that **reads** it. Justification: reads and writes have divergent shapes and scale. Writes need normalization and invariant enforcement; reads need denormalized, per-screen views and often 10–100× the throughput. One model forced to serve both means awkward joins, lock contention, and read/write scaling coupled together. With CQRS you can scale read replicas independently, tailor a read model per query, and even use different stores (Postgres write side, Elasticsearch read side).

The cost is steep and constant: **two models to keep in sync**, **eventual consistency** between them, more infrastructure, and more code. CQRS is **not a default** — apply it to the specific bounded contexts where read/write asymmetry or scale genuinely demands it, not the whole system. Fowler's own guidance: most systems should *not* use CQRS.

### Event Sourcing — events as source of truth

Instead of storing current state and overwriting it, store every state-changing event, append-only. Benefits: a perfect **audit log** (you have every fact, for free — huge in finance/compliance), **temporal queries** (reconstruct state at any past time), **replay** to build brand-new projections from history, and easier debugging (you can see exactly what happened). It pairs naturally with CQRS: the event log is the write side, projections are the read side.

Costs and hard parts:
- **Schema/event evolution** — events are immutable and live *forever*; changing their shape means versioning events and writing upcasters. This is the number-one long-term pain.
- **Replaying large histories** is slow → **snapshots** (persist the fold every N events; load snapshot + tail).
- **Querying current state** is not natural — you *must* build projections; you can't easily `SELECT` across aggregates in the event log.
- **Eventual consistency** and **deletes** (GDPR "right to be forgotten" vs. an immutable log → crypto-shredding).
- It's a **niche** tool: worth it when history *is* the asset (ledgers, audit, collaboration). Overkill for CRUD.

### The outbox pattern — solving the dual write

The trap: a handler must (a) persist state and (b) publish an event. If they're two separate systems (DB + Kafka), a crash between them loses the event or fabricates one — you can't atomically write to both. The **outbox pattern** fixes it: write the business change **and** a row in an `outbox` table in **one local DB transaction**. A separate relay (polling, or **CDC** tailing the DB log via Debezium) reads the outbox and publishes to the broker with at-least-once delivery. Now the event is emitted **iff** the state changed. Consumers dedupe on the event id. This is the standard, correct way to bridge a database and a message bus.

### Projections & materialized views

A projection is a consumer that folds the event stream into a query-optimized shape and writes it to a read store. Key properties: they're **disposable and rebuildable** (drop and replay from the log to fix a bug or add a field), you can run **many** per stream (one per query pattern), and each can use the best store for its job. Rebuild strategy matters at scale — replaying billions of events takes time, so you often rebuild in parallel and cut over.

### Eventual consistency UX

Because read models lag, "write then immediately read" can show stale data — a user creates an order and doesn't see it yet. Mitigations: **read-your-writes** by serving the just-written value from the command side or a session cache; **optimistic UI** that shows the intended result immediately; **version/ETag** so the client can poll until the read model catches up; and honest UX ("processing…"). Never pretend it's strongly consistent — design the interaction around the lag.

## 6. Trade-offs

| Option | Pros | Cons |
|---|---|---|
| **Request-driven (RPC)** | Simple, synchronous result, easy to trace | Tight coupling; caller fails if callee down; hard to extend |
| **Event-driven** | Loose coupling, extensible, resilient, async | Harder to reason/debug; eventual consistency; no sync answer |
| **CQRS** | Independent read/write scaling; per-view read models; store per need | Two models to sync; eventual consistency; more code & infra |
| **Single CRUD model** | Simplest; strong consistency; least code | Read/write scaling coupled; awkward at asymmetric scale |
| **Event Sourcing** | Full audit trail, time-travel, replay, rebuildable views | Event-schema evolution pain; snapshots needed; deletes/GDPR hard; overkill for CRUD |
| **State-oriented storage** | Trivial current-state queries; familiar | No history; audit is bolt-on; lost "why" |
| **Choreography** | Decentralized, extensible | Implicit, hard-to-trace workflow |
| **Orchestration** | Explicit, debuggable workflow | Central coupling; orchestrator is a dependency |

The meta-trade-off: these patterns swap **local simplicity and strong consistency** for **decoupling, scalability, auditability, and extensibility**. They are surgical tools for specific bounded contexts — applying them system-wide is the classic over-engineering failure.

## 7. When to Use / When to Avoid

**Use when:**
- **EDA:** many independent services must react to the same business events; you want to add consumers without touching producers.
- **CQRS:** read and write workloads diverge sharply in shape or scale (e.g. a heavy analytics/search read side over a transactional write side).
- **Event Sourcing:** the *history* is a first-class requirement — ledgers, audit/compliance, collaborative editing, anything needing "how did we get here?" and temporal queries.
- You need to rebuild new read views from existing history, or replay to recover.

**Avoid when:**
- The domain is simple CRUD with symmetric read/write and no audit need — a boring relational table wins.
- The team lacks experience with eventual consistency and distributed debugging (the operational tax is real).
- You need strong read-after-write consistency everywhere and can't design the UX around lag.
- You'd apply it *everywhere* by default — reserve it for the bounded contexts that genuinely need it.

## 8. Scaling & Production Best Practices

- **Adopt per bounded context, not globally.** Most of the system stays plain CRUD; only the contexts with real asymmetry get CQRS/ES.
- **Always use the outbox (or CDC/Debezium)** to publish events — never dual-write to DB and broker separately.
- **Make projectors idempotent** and track the last-processed offset/event id so replays and redeliveries are safe.
- **Design projections as disposable** — you should be able to drop and rebuild any read model from the log.
- **Snapshot event-sourced aggregates** every N events (e.g. 100–1000) to bound replay cost.
- **Version events from day one** and keep upcasters; assume every event shape lives forever.
- **Give events rich, stable schemas** (schema registry, Avro/Protobuf) and treat them as a public contract.
- **Instrument end-to-end** — distributed tracing across the async hops is essential or you'll be blind.
- **Bound read-model lag** with SLOs and expose freshness to clients; scale projectors and read stores independently.

## 9. Failure Modes & Mitigations

| Failure | Impact | Mitigation |
|---|---|---|
| Dual write (DB ok, publish fails) | Missing/ghost events; state and stream diverge | Outbox pattern / CDC — single local transaction |
| Projector lag spike | Stale reads, user sees old data | Alert on lag; scale projectors; read-your-writes fallback |
| Poison event breaks a projection | Read model stops updating | Idempotent + skip-to-DLQ; fix and replay; version guards |
| Event schema change breaks consumers | Consumers crash on new shape | Versioned events + upcasters; backward-compatible evolution |
| Duplicate event delivery | Double-applied projection/state | Idempotent handlers; dedupe by event id; track offset |
| Rebuild replays billions of events | Long downtime / slow cutover | Snapshots; parallel rebuild + blue-green cutover |
| Out-of-order events across aggregates | Inconsistent projection state | Per-aggregate ordering (partition by aggregate id); version numbers |
| GDPR delete on immutable log | Can't erase personal data | Crypto-shredding (delete the key); keep PII out of events |
| Saga step fails mid-flow | Partial cross-service state | Compensating transactions; orchestrator retry/rollback |

## 10. Monitoring & Metrics

- **Projection/read-model lag** (events behind head, and seconds behind) per projector — the core CQRS health signal.
- **Outbox relay lag & backlog** — rising means events aren't reaching the bus.
- **Event throughput** (events/s) per stream and **processing latency** per projector.
- **Duplicate/redelivery rate** and **DLQ depth** for the event pipeline.
- **Saga completion rate, duration, and compensation/rollback rate.**
- **Aggregate load latency** (fold cost) and **snapshot age/hit rate**.
- **Schema-registry compatibility failures** on deploy.
- **End-to-end trace latency** command→projected (the user-visible eventual-consistency window).

## 11. Common Mistakes

1. ⚠️ Applying CQRS/Event Sourcing to the whole system instead of the few contexts that need it — massive over-engineering.
2. ⚠️ Dual-writing to the DB and the broker without an outbox — guaranteed divergence on crash.
3. ⚠️ Treating event schemas as internal and mutable — they're an immutable, forever public contract; version them.
4. ⚠️ Non-idempotent projectors — the first duplicate corrupts the read model.
5. ⚠️ No snapshots — replaying huge histories makes aggregate loads unbearably slow.
6. ⚠️ Confusing commands with events (naming events imperatively / making them rejectable) — muddles the model.
7. ⚠️ Pretending the read side is strongly consistent — then fighting mysterious "I don't see my write" bugs.
8. ⚠️ Putting PII directly in immutable events, then getting a GDPR erasure request with no way out.

## 12. Interview Questions

**Q: What's the difference between a command and an event?**
A: A command is an imperative request to change something ("PlaceOrder"), can be validated and *rejected*, and is addressed to one handler. An event is an immutable fact that *already happened* ("OrderPlaced"), cannot be rejected, and is broadcast to any number of interested consumers. Past tense vs. imperative; one target vs. many.

**Q: EDA, CQRS, and Event Sourcing — how do they relate?**
A: They're independent but composable. EDA is a communication style (react to events). CQRS is a modeling split (separate read/write models). Event Sourcing is persistence (events as source of truth). You can do CQRS with two plain databases and no events, or EDA without event sourcing. Together, an event-sourced write side feeds CQRS read models over an event-driven bus.

**Q: Why would you separate read and write models with CQRS, and what does it cost?**
A: Because reads and writes diverge in shape and scale — writes need normalized, invariant-enforcing models; reads need denormalized per-view models at much higher throughput. CQRS lets you scale and optimize each independently, even on different stores. It costs a second model to keep in sync, eventual consistency between them, and significantly more code and infrastructure — so it's applied per bounded context, not by default.

**Q: How do you reconstruct current state in an event-sourced system?**
A: Left-fold the aggregate's events in order: start from empty (or the latest snapshot) and apply each event to produce current state. For queries across aggregates you don't fold — you consume events into projections (read models) shaped for the query.

**Q: What is the outbox pattern and what problem does it solve?**
A: It solves the dual-write problem — you can't atomically write to a database and a message broker. You write the business change and an outbox row in one local DB transaction; a separate relay (polling or CDC/Debezium) publishes outbox rows to the broker at-least-once. The event is emitted if and only if the state change committed. Consumers dedupe by event id.

**Q: Choreography vs. orchestration for a multi-service workflow — how do you choose?**
A: Choreography (services react to each other's events, no central brain) is loosely coupled and extensible but the workflow is implicit and hard to trace. Orchestration (a central coordinator directs each step) is explicit and debuggable but couples services to the orchestrator. Simple few-step flows suit choreography; complex many-step flows needing visibility and clear compensation suit orchestration.

**Q: (Senior) A user creates a record and immediately doesn't see it in the list. Explain and fix.**
A: Classic CQRS eventual consistency — the write committed on the command side but the projection hasn't caught up, so the read model is stale. Fix options: read-your-writes (serve the just-written value from the command side or a session cache), optimistic UI, or return a version/ETag the client polls until the read model reaches it. Never pretend it's strongly consistent; design the UX around the lag and monitor projection lag with an SLO.

**Q: (Senior) Event Sourcing gives you a perfect audit log — what's the catch in production?**
A: Events are immutable and live forever, so schema evolution is the dominant long-term pain (version events + upcasters). Replaying long histories is slow, needing snapshots. Current-state queries require building projections. Deletes conflict with an append-only log — GDPR erasure forces crypto-shredding or keeping PII out of events entirely. It's a niche tool; for plain CRUD it's pure overhead.

**Q: (Senior) How do you evolve an event's schema without breaking years of stored events?**
A: Treat events as an immutable, forever contract. Only make backward-compatible changes (add optional fields, never repurpose or remove), version the event type, and write upcasters that transform old versions to the current shape on read. Use a schema registry (Avro/Protobuf) to enforce compatibility at publish time. Breaking changes mean a new event type, not mutating the old one.

**Q: (Senior) How do you rebuild a read model that's corrupted or needs a new field?**
A: Because projections are disposable derivations of the log, you drop the read model and replay events from the beginning (or a snapshot) through an idempotent projector to rebuild it — adding the new field as you go. At scale you build the new version in parallel and blue-green cut over to avoid downtime. This rebuildability is a core benefit of event sourcing.

**Q: How do you keep projections correct under duplicate or out-of-order event delivery?**
A: Make projectors idempotent and track the last-processed offset/event id so redeliveries are no-ops. Preserve per-aggregate ordering by partitioning the stream on aggregate id (so one aggregate's events are serialized) and guard writes with the aggregate's version/sequence number to reject stale or out-of-order applies.

**Q: When would you NOT use these patterns?**
A: For simple CRUD with symmetric read/write and no audit requirement — a relational table is simpler, strongly consistent, and cheaper. If the team can't handle eventual consistency and distributed debugging, or you'd need strong read-after-write everywhere, the operational tax outweighs the benefit. And never apply them system-wide by default; reserve them for the bounded contexts that truly need audit, replay, or asymmetric scale.

## 13. Alternatives & Related

- **Message Queues & Async Processing** — the delivery guarantees and idempotency underpinning event delivery.
- **Event Streaming & Kafka Internals** — the log as the durable event backbone (CDC, retention, compaction) for projections.
- **Microservices** — the architecture these patterns most often serve; sagas coordinate cross-service transactions.
- **CAP & Consistency** — the eventual-consistency trade-offs made explicit here.
- **Database Scaling** — CDC/Debezium as the outbox relay mechanism.
- **Saga pattern** — distributed transactions via choreography or orchestration with compensation.

## 14. Cheat Sheet

> [!TIP]
> **EDA / CQRS / Event Sourcing in one screen**
> - **Command** = imperative, rejectable, one handler. **Event** = past-tense fact, immutable, broadcast.
> - Three *independent* ideas: **EDA** (react to events) · **CQRS** (split read/write models) · **Event Sourcing** (events are the source of truth). Compose, don't conflate.
> - **CQRS** = scale/shape reads and writes separately; **cost** = two models + eventual consistency + more code. Not a default.
> - **Event Sourcing:** `state = fold(events)`; free audit trail, time-travel, replayable projections. **Pain** = schema evolution, snapshots, deletes/GDPR. Niche — history must be the asset.
> - **Outbox pattern** (or CDC) is mandatory to publish events — never dual-write DB + broker.
> - **Projections** are disposable, rebuildable, many-per-stream; make projectors **idempotent** and track offsets.
> - **Snapshot** every N events to bound replay cost.
> - **Choreography** (decentralized, implicit) vs **orchestration** (central, explicit) for sagas.
> - **Design UX for eventual consistency** (read-your-writes, optimistic UI, version polling).
> - **Apply per bounded context, never system-wide.**

**References:** Martin Fowler — "CQRS" and "Event Sourcing"; "Designing Data-Intensive Applications" ch. 11 (Kleppmann); microservices.io (Chris Richardson) — Saga & Transactional Outbox; Confluent — event-driven architecture

---
*System Design Handbook — topic 25.*
