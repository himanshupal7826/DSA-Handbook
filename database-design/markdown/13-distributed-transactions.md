# 13 · Distributed Transactions: 2PC, Sagas & When to Avoid Them

> **In one line:** Atomic commit across independent databases is possible — two-phase commit does it — but only by letting a failed coordinator freeze participants with locks held; sagas stay available by giving up isolation and replacing rollback with compensation, and the best distributed transaction is usually the one you designed away by redrawing data boundaries.

---

## 1. Overview

Inside one PostgreSQL instance, atomicity is almost free: a transaction's changes become visible at the single instant its commit record is flushed to the WAL ([Ch 07 · Write-Ahead Logging](topic.html?p=07-write-ahead-logging)). There is one log, one lock manager, one clock of truth. The moment one business operation spans two databases — an `orders` shard and an `inventory` shard, a ledger database and a payments service, a PostgreSQL row and a Kafka topic — that single instant no longer exists. Each system has its own log and commits on its own. A crash, a timeout or a network partition between the two commits leaves one side done and the other not.

The naive approach is "commit A, then commit B, and retry B if it fails". It fails in two ways. If B can *refuse* (insufficient stock, a constraint violation), A is already committed and cannot be rolled back. And if the process crashes between the commits, nothing remembers that B still needs doing. Retrying harder does not help; the problem is structural. You need either a **protocol** that makes all participants commit or none (two-phase commit), or a **workflow** that makes partial progress safe and recoverable (sagas).

This chapter goes deeper than the system-design treatment of the same topic, on the *database* side: what a PostgreSQL prepared transaction actually holds on disk and in memory, what happens at every failure point of 2PC, why an orphaned prepared transaction is a slow-motion outage, how XA works in MySQL, how to design compensations and semantic locks so a saga is not a data-corruption generator, and — most importantly — how to redraw boundaries so the transaction becomes local again.

> **Builds on:** [SQL Handbook · Transactions & ACID](../sql/topic.html?p=25-transactions-acid) (atomicity, commit/rollback, the WAL intuition) · [Ch 07 · Write-Ahead Logging](topic.html?p=07-write-ahead-logging) (what commit means on one node) · [Ch 12 · Sharding](topic.html?p=12-sharding) (where cross-shard transactions come from) · [System Design · Distributed Transactions](../system-design/topic.html?p=21-distributed-transactions) (the service-level overview of 2PC, 3PC, sagas and TCC). This chapter assumes those and goes into prepared-transaction internals, failure analysis, compensation design and boundary redesign.

## 2. Core Concepts

- **Atomic commit problem** — all participants must reach the same commit/abort outcome, and commit only if all can. *Why it matters:* it is harder than it sounds; with crash failures and unbounded delays no protocol can be both safe and never blocking.
- **Coordinator (transaction manager)** — the process that asks participants to prepare, decides, and broadcasts the decision. *Why it matters:* its durable decision log is the single source of truth; losing it loses the outcome.
- **Participant (resource manager)** — each database taking part. *Why it matters:* after voting YES it gives up the right to decide alone.
- **Prepare / vote** — the participant makes the transaction durable-but-undecided and promises it can commit. *Why it matters:* this promise is what forces it to keep locks until told the outcome.
- **In-doubt (uncertain) transaction** — prepared, outcome unknown. *Why it matters:* holds locks and, in PostgreSQL, the xmin horizon, indefinitely.
- **Presumed abort** — if the coordinator has no record of a transaction, the answer is "abort". *Why it matters:* lets the coordinator skip logging aborts and makes recovery simple.
- **Heuristic decision** — an operator (or timeout) forcing an in-doubt transaction to commit or roll back without the coordinator. *Why it matters:* can produce a *heuristic mixed* outcome — the exact inconsistency 2PC exists to prevent.
- **XA** — the X/Open standard interface between transaction managers and resource managers; MySQL implements `XA START/END/PREPARE/COMMIT`. *Why it matters:* how Java app servers and some brokers drive 2PC.
- **Saga** — a sequence of local transactions T1…Tn with compensations C1…Cn−1. *Why it matters:* no locks span steps, so it stays available — and intermediate states are visible.
- **Compensation** — a semantic undo (refund, release, cancel), not a physical rollback. *Why it matters:* it must be idempotent and must eventually succeed.
- **Pivot transaction** — the step after which the saga can no longer be compensated and must go forward. *Why it matters:* order the steps so irreversible actions come at or after the pivot.
- **Semantic lock** — an application-level "in progress" marker (status = `PENDING`) that other transactions respect. *Why it matters:* it is how sagas regain a little isolation.
- **Orchestration vs choreography** — a central state machine drives the saga, versus services reacting to each other's events. *Why it matters:* determines where saga state lives and how you debug it.

## 3. Theory & Principles

### Two-phase commit, step by step

1. **Execute.** The coordinator runs the transaction's statements on each participant inside ordinary local transactions. Locks are taken as usual.
2. **Phase 1 — prepare.** The coordinator sends `PREPARE` to every participant. Each participant flushes everything needed to commit later — in PostgreSQL, a WAL record plus two-phase state — and replies YES, or replies NO (or times out) if it cannot. After YES the participant is in doubt: it may not commit on its own (others might have voted NO) and may not abort on its own (the coordinator might already have decided COMMIT).
3. **Decision.** If all voted YES, the coordinator **durably logs COMMIT**. This log write *is* the commit point of the distributed transaction. Any NO or timeout → ABORT (with presumed abort, nothing needs logging).
4. **Phase 2 — commit/abort.** The coordinator sends the decision to all participants and retries until each acknowledges. Participants apply it and release locks.
5. **Forget.** Once every participant has acknowledged, the coordinator can garbage-collect the log entry.

The protocol is safe — no participant commits if another aborts — as long as the coordinator's log survives and participants keep their prepared state across crashes. What it cannot be is **non-blocking**: in the window between a participant voting YES and learning the decision, the only process that knows the outcome is the coordinator.

```svg
<svg viewBox="0 0 880 520" width="100%" height="520" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c13a1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="c13a2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
    <marker id="c13a3" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Two-phase commit: messages, durable writes, and where each failure lands</text>
  <rect x="40" y="40" width="160" height="30" rx="6" fill="#ede9fe" stroke="#7c3aed"/><text x="120" y="60" text-anchor="middle" fill="#5b21b6" font-weight="bold">Coordinator</text>
  <rect x="360" y="40" width="160" height="30" rx="6" fill="#dbeafe" stroke="#2563eb"/><text x="440" y="60" text-anchor="middle" fill="#1e40af" font-weight="bold">Participant A (orders)</text>
  <rect x="680" y="40" width="160" height="30" rx="6" fill="#dbeafe" stroke="#2563eb"/><text x="760" y="60" text-anchor="middle" fill="#1e40af" font-weight="bold">Participant B (stock)</text>
  <line x1="120" y1="70" x2="120" y2="440" stroke="#94a3b8" stroke-dasharray="4 3"/>
  <line x1="440" y1="70" x2="440" y2="440" stroke="#94a3b8" stroke-dasharray="4 3"/>
  <line x1="760" y1="70" x2="760" y2="440" stroke="#94a3b8" stroke-dasharray="4 3"/>
  <path d="M120,96 L432,96" stroke="#2563eb" stroke-width="1.5" marker-end="url(#c13a1)"/><text x="276" y="90" text-anchor="middle" fill="#1e40af" font-size="10">BEGIN; INSERT order ...</text>
  <path d="M120,112 L752,112" stroke="#2563eb" stroke-width="1.5" marker-end="url(#c13a1)"/><text x="600" y="106" text-anchor="middle" fill="#1e40af" font-size="10">BEGIN; UPDATE stock ...</text>
  <text x="450" y="130" fill="#334155" font-size="10">locks held</text><text x="770" y="130" fill="#334155" font-size="10">locks held</text>
  <path d="M120,150 L432,150" stroke="#7c3aed" stroke-width="2" marker-end="url(#c13a3)"/>
  <path d="M120,150 L752,158" stroke="#7c3aed" stroke-width="2" marker-end="url(#c13a3)"/>
  <text x="200" y="144" fill="#5b21b6" font-size="10" font-weight="bold">PHASE 1: PREPARE TRANSACTION 'g1'</text>
  <rect x="446" y="168" width="150" height="34" rx="4" fill="#fef3c7" stroke="#d97706"/><text x="521" y="183" text-anchor="middle" fill="#78350f" font-size="10">fsync prepare record</text><text x="521" y="196" text-anchor="middle" fill="#78350f" font-size="10">now IN DOUBT</text>
  <rect x="604" y="168" width="150" height="34" rx="4" fill="#fef3c7" stroke="#d97706"/><text x="679" y="183" text-anchor="middle" fill="#78350f" font-size="10">fsync prepare record</text><text x="679" y="196" text-anchor="middle" fill="#78350f" font-size="10">now IN DOUBT</text>
  <path d="M432,222 L128,222" stroke="#16a34a" stroke-width="1.5" marker-end="url(#c13a2)"/><text x="280" y="216" text-anchor="middle" fill="#15803d" font-size="10">YES</text>
  <path d="M752,232 L128,232" stroke="#16a34a" stroke-width="1.5" marker-end="url(#c13a2)"/><text x="600" y="246" text-anchor="middle" fill="#15803d" font-size="10">YES</text>
  <rect x="20" y="256" width="200" height="34" rx="4" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/><text x="120" y="271" text-anchor="middle" fill="#4c1d95" font-size="10" font-weight="bold">fsync decision COMMIT g1</text><text x="120" y="284" text-anchor="middle" fill="#4c1d95" font-size="10">= the commit point</text>
  <path d="M120,310 L432,310" stroke="#7c3aed" stroke-width="2" marker-end="url(#c13a3)"/>
  <path d="M120,310 L752,318" stroke="#7c3aed" stroke-width="2" marker-end="url(#c13a3)"/>
  <text x="200" y="304" fill="#5b21b6" font-size="10" font-weight="bold">PHASE 2: COMMIT PREPARED 'g1'</text>
  <text x="450" y="340" fill="#15803d" font-size="10">commit, release locks</text><text x="770" y="340" fill="#15803d" font-size="10">commit, locks</text>
  <path d="M432,356 L128,356" stroke="#16a34a" stroke-width="1.5" marker-end="url(#c13a2)"/><text x="280" y="350" text-anchor="middle" fill="#15803d" font-size="10">ack</text>
  <path d="M752,366 L128,366" stroke="#16a34a" stroke-width="1.5" marker-end="url(#c13a2)"/><text x="600" y="380" text-anchor="middle" fill="#15803d" font-size="10">ack</text>
  <text x="20" y="400" fill="#334155" font-size="10">forget g1</text>
  <circle cx="300" cy="130" r="9" fill="#dc2626"/><text x="300" y="134" text-anchor="middle" fill="#ffffff" font-size="10" font-weight="bold">1</text>
  <circle cx="600" cy="214" r="9" fill="#dc2626"/><text x="600" y="218" text-anchor="middle" fill="#ffffff" font-size="10" font-weight="bold">2</text>
  <circle cx="240" cy="246" r="9" fill="#dc2626"/><text x="240" y="250" text-anchor="middle" fill="#ffffff" font-size="10" font-weight="bold">3</text>
  <circle cx="240" cy="296" r="9" fill="#dc2626"/><text x="240" y="300" text-anchor="middle" fill="#ffffff" font-size="10" font-weight="bold">4</text>
  <circle cx="620" cy="336" r="9" fill="#dc2626"/><text x="620" y="340" text-anchor="middle" fill="#ffffff" font-size="10" font-weight="bold">5</text>
  <rect x="20" y="410" width="840" height="100" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="36" y="428" fill="#7f1d1d" font-size="10"><tspan font-weight="bold">1 before prepare:</tspan> anyone can abort unilaterally. Safe, cheap: coordinator aborts, participants roll back.</text>
  <text x="36" y="446" fill="#7f1d1d" font-size="10"><tspan font-weight="bold">2 participant dies after YES:</tspan> prepared state survives restart; on recovery it asks the coordinator for the outcome.</text>
  <text x="36" y="464" fill="#7f1d1d" font-size="10"><tspan font-weight="bold">3 coordinator dies before logging decision:</tspan> participants BLOCK in doubt. On recovery: no record, so presumed abort.</text>
  <text x="36" y="482" fill="#7f1d1d" font-size="10"><tspan font-weight="bold">4 coordinator dies after logging COMMIT:</tspan> participants BLOCK until it restarts and re-sends COMMIT. Locks held throughout.</text>
  <text x="36" y="500" fill="#7f1d1d" font-size="10"><tspan font-weight="bold">5 phase-2 message lost to B:</tspan> A committed, B still prepared. Coordinator must retry until acked. Never "give up".</text>
</svg>
```

### Why blocking is fundamental, and how real systems remove it

Case 3 and case 4 look identical from a participant's point of view: it voted YES and hears nothing. It cannot distinguish "coordinator decided COMMIT and crashed" from "coordinator crashed before deciding", so it cannot safely do anything. Three-phase commit tries to fix this with an extra round and timeouts, but it relies on bounded message delays; under a real network partition it can produce inconsistent outcomes, so it is essentially unused.

The modern fix is to make the coordinator itself **fault-tolerant**: store the transaction's state in a replicated, consensus-backed record ([Ch 15 · Consensus](topic.html?p=15-consensus)). Spanner runs 2PC across Paxos groups, so the "coordinator" is a group that survives a machine failure. CockroachDB keeps a *transaction record* in a Raft-replicated range and, with **parallel commits**, writes it in a `STAGING` state alongside the final writes so that commit needs one round of consensus rather than two. Blocking remains in theory — if a whole majority is lost — but a single crashed machine no longer freezes anything. See [Ch 16 · Distributed Database Architecture](topic.html?p=16-distributed-database-architecture).

### What a PostgreSQL prepared transaction actually is

`PREPARE TRANSACTION 'gid'` detaches the current transaction from the session and turns it into a durable object:

- Its state is written to WAL (and, if it lives across a checkpoint, to a file in `pg_twophase/`). It **survives a server crash or restart**.
- All its **row and table locks stay held**. Other writers to the same rows wait on it — possibly for days.
- Its **xid stays running**, so it pins the **xmin horizon**: vacuum cannot remove any tuple version that died after it started, across the whole cluster. Left long enough, that means bloat everywhere and eventually XID-wraparound pressure ([Ch 03 · MVCC](topic.html?p=03-mvcc)).
- It is visible in `pg_prepared_xacts` and can be finished from **any** session with `COMMIT PREPARED 'gid'` or `ROLLBACK PREPARED 'gid'`.
- It requires `max_prepared_transactions > 0` (default **0**, i.e. disabled; restart required). Hot standbys need a value at least as high as the primary's.
- You cannot prepare a transaction that touched temporary tables, created `WITH HOLD` cursors, or ran `LISTEN`/`UNLISTEN`/`NOTIFY`.

An **orphaned** prepared transaction — one whose coordinator died or was redeployed without recovery logic — is therefore a slow-motion outage: nothing errors, but locks and the xmin horizon are held until a human notices.

## 4. Architecture & Workflow

### Sagas: availability by giving up isolation

A saga splits the business operation into local transactions, each committed immediately in its own database, plus a compensation for each step that must be undoable. If step k fails, the saga runs C(k−1)…C1 in reverse. No lock is held across steps, so no participant is ever blocked by another's failure. The price is that **intermediate states are visible**: between "stock reserved" and "payment captured", another request can observe the reservation. Sagas are ACD — atomicity (eventually, via compensation), consistency and durability, but no isolation.

```svg
<svg viewBox="0 0 880 500" width="100%" height="500" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c13b1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
    <marker id="c13b2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
    <marker id="c13b3" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Orchestrated order saga: compensable steps, pivot, retriable steps</text>
  <rect x="20" y="40" width="840" height="56" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="440" y="60" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">Orchestrator: saga row in its own DB (state, current_step, version) + outbox for commands</text>
  <text x="440" y="80" text-anchor="middle" fill="#5b21b6" font-size="10">each transition = one local txn: update saga state + insert next command into outbox</text>
  <rect x="20" y="126" width="150" height="70" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="95" y="146" text-anchor="middle" fill="#1e40af" font-weight="bold">T1 create order</text>
  <text x="95" y="164" text-anchor="middle" fill="#1e3a8a" font-size="10">status = PENDING</text>
  <text x="95" y="180" text-anchor="middle" fill="#1e3a8a" font-size="10">(semantic lock)</text>
  <rect x="195" y="126" width="150" height="70" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="270" y="146" text-anchor="middle" fill="#1e40af" font-weight="bold">T2 reserve stock</text>
  <text x="270" y="164" text-anchor="middle" fill="#1e3a8a" font-size="10">reservation row</text>
  <text x="270" y="180" text-anchor="middle" fill="#1e3a8a" font-size="10">expires_at = +15 min</text>
  <rect x="370" y="126" width="150" height="70" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="445" y="146" text-anchor="middle" fill="#92400e" font-weight="bold">T3 capture payment</text>
  <text x="445" y="164" text-anchor="middle" fill="#78350f" font-size="10">PIVOT: after this we</text>
  <text x="445" y="180" text-anchor="middle" fill="#78350f" font-size="10">only go forward</text>
  <rect x="545" y="126" width="150" height="70" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="620" y="146" text-anchor="middle" fill="#15803d" font-weight="bold">T4 confirm stock</text>
  <text x="620" y="164" text-anchor="middle" fill="#166534" font-size="10">retriable: must</text>
  <text x="620" y="180" text-anchor="middle" fill="#166534" font-size="10">eventually succeed</text>
  <rect x="720" y="126" width="140" height="70" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="790" y="146" text-anchor="middle" fill="#15803d" font-weight="bold">T5 order CONFIRMED</text>
  <text x="790" y="164" text-anchor="middle" fill="#166534" font-size="10">send email</text>
  <text x="790" y="180" text-anchor="middle" fill="#166534" font-size="10">(irreversible, last)</text>
  <path d="M172,161 L191,161" stroke="#16a34a" stroke-width="2" marker-end="url(#c13b1)"/>
  <path d="M347,161 L366,161" stroke="#16a34a" stroke-width="2" marker-end="url(#c13b1)"/>
  <path d="M522,161 L541,161" stroke="#16a34a" stroke-width="2" marker-end="url(#c13b1)"/>
  <path d="M697,161 L716,161" stroke="#16a34a" stroke-width="2" marker-end="url(#c13b1)"/>
  <path d="M95,98 L95,122" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#c13b3)"/>
  <path d="M270,98 L270,122" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#c13b3)"/>
  <path d="M445,98 L445,122" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#c13b3)"/>
  <path d="M620,98 L620,122" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#c13b3)"/>
  <rect x="20" y="236" width="150" height="56" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="95" y="258" text-anchor="middle" fill="#b91c1c" font-weight="bold">C1 cancel order</text>
  <text x="95" y="276" text-anchor="middle" fill="#7f1d1d" font-size="10">status = CANCELLED</text>
  <rect x="195" y="236" width="150" height="56" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="270" y="258" text-anchor="middle" fill="#b91c1c" font-weight="bold">C2 release stock</text>
  <text x="270" y="276" text-anchor="middle" fill="#7f1d1d" font-size="10">idempotent by saga id</text>
  <path d="M445,198 C445,250 380,264 349,264" stroke="#dc2626" stroke-width="2" fill="none" marker-end="url(#c13b2)"/>
  <text x="420" y="232" fill="#b91c1c" font-size="10">T3 declined</text>
  <path d="M193,264 L174,264" stroke="#dc2626" stroke-width="2" marker-end="url(#c13b2)"/>
  <text x="550" y="236" fill="#15803d" font-size="10">after the pivot there are no compensations:</text>
  <text x="550" y="252" fill="#15803d" font-size="10">failures are retried (with idempotency keys)</text>
  <text x="550" y="268" fill="#15803d" font-size="10">until they succeed or a human is paged</text>
  <rect x="20" y="314" width="840" height="176" rx="10" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="440" y="336" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="bold">The anomalies a saga allows, and the countermeasures</text>
  <text x="40" y="360" fill="#334155" font-size="11"><tspan font-weight="bold">Dirty read:</tspan> another request sees stock reserved by a saga that will be compensated.  Fix: reads treat PENDING as not-yet-real.</text>
  <text x="40" y="382" fill="#334155" font-size="11"><tspan font-weight="bold">Lost update:</tspan> C2 "restores stock to 10" overwrites a concurrent sale.  Fix: compensations are deltas (+qty), never absolute writes.</text>
  <text x="40" y="404" fill="#334155" font-size="11"><tspan font-weight="bold">Out-of-order:</tspan> "cancel" arrives before "reserve" was processed.  Fix: record the cancel; a later reserve for a cancelled saga is a no-op.</text>
  <text x="40" y="426" fill="#334155" font-size="11"><tspan font-weight="bold">Stuck saga:</tspan> orchestrator crashed mid-flow.  Fix: saga state is durable; a sweeper resumes sagas whose updated_at is old.</text>
  <text x="40" y="448" fill="#334155" font-size="11"><tspan font-weight="bold">Abandoned reservation:</tspan> the saga never completes.  Fix: reservations carry expires_at; an expiry job releases them.</text>
  <text x="40" y="474" fill="#16a34a" font-size="11" font-weight="bold">Rule: put reversible steps first, the pivot next, and irreversible side effects (emails, shipping) last.</text>
</svg>
```

### Orchestration vs choreography, from the data layer's view

In **orchestration**, a saga row (`saga_id, type, state, step, payload, version, updated_at`) is the single source of truth for progress; each transition is one local transaction that updates the row and writes the next command to an outbox ([Kafka & RabbitMQ · Idempotency & Outbox](../messaging/topic.html?p=21-idempotency-outbox)). "Where is order 42?" is one query. Engines like Temporal, AWS Step Functions or Camunda are this pattern, productised.

In **choreography**, each service reacts to events and emits its own; there is no saga row. Progress is inferred by correlating events across services, which is fine for two or three steps and painful beyond that. Either way, every step and compensation consumes at-least-once messages, so every handler must be idempotent, keyed by `(saga_id, step)`.

### Designing compensations

A compensation is a new business transaction, not an undo log. Rules that keep sagas from corrupting data:

1. **Semantic, not physical.** You don't delete the charge; you issue a refund that appears on the statement. Audit trails stay intact.
2. **Idempotent.** It will be delivered more than once. Key it by `(saga_id, step)`.
3. **Commutative where possible.** Use deltas (`available = available + 3`) instead of absolute writes, so ordering with concurrent transactions does not matter.
4. **Must not fail permanently.** If a compensation can be refused (refund to a closed card), the design needs a fallback path (store credit, manual queue). A saga that cannot compensate is stuck in an inconsistent state.
5. **Tolerate running before its forward step.** Messages reorder; a `release` for a reservation that has not arrived yet should record a tombstone so the late `reserve` is ignored.

## 5. Implementation

### Simple example: PostgreSQL 2PC by hand

```ini
# postgresql.conf on both participants (restart required)
max_prepared_transactions = 100   # >= expected concurrent prepared txns; 0 disables 2PC
```

```sql
-- Session on participant A (orders)
BEGIN;
INSERT INTO orders (id, customer_id, status) VALUES (9001, 42, 'CONFIRMED');
PREPARE TRANSACTION 'order-9001';
-- the session is now free; the transaction lives on without it

-- Session on participant B (inventory)
BEGIN;
UPDATE stock SET available = available - 1 WHERE sku = 'SKU-7' AND available >= 1;
-- (coordinator checks rowcount = 1; if 0 it would ROLLBACK here and abort A)
PREPARE TRANSACTION 'order-9001';
```

Now look at what a prepared transaction holds — from any session on A:

```sql
SELECT gid, prepared, now() - prepared AS age, owner, database, age(transaction) AS xid_age
FROM pg_prepared_xacts;
```

```text
    gid     |           prepared            |       age       |  owner   | database | xid_age
------------+-------------------------------+-----------------+----------+----------+---------
 order-9001 | 2026-09-24 10:14:03.21+00     | 00:00:41.30221  | app      | shop     |      12
```

```sql
-- Its locks are still there, owned by no backend (pid is NULL for prepared xacts):
SELECT locktype, relation::regclass, mode, granted, pid
FROM pg_locks WHERE virtualtransaction LIKE '-1/%';

-- Restart the server now: the prepared txn is still in pg_prepared_xacts afterwards.
```

Finish it (the coordinator logged COMMIT):

```sql
COMMIT PREPARED 'order-9001';     -- on A, then on B; each is its own statement, not in a txn block
```

### Real-world example: a coordinator with a decision log and recovery

The dangerous part of 2PC is not the happy path; it is recovery. A minimal but correct coordinator durably logs the decision before phase 2 and runs a recovery loop that resolves every prepared transaction it owns.

```sql
-- On the coordinator's own database
CREATE TABLE tpc_log (
  gid        text PRIMARY KEY,
  decision   text NOT NULL CHECK (decision IN ('commit')),   -- presumed abort: aborts are not logged
  decided_at timestamptz NOT NULL DEFAULT now()
);
```

```python
from datetime import datetime, timedelta, timezone

import psycopg

PARTICIPANTS = {"orders": "dbname=orders host=pg-a", "stock": "dbname=stock host=pg-b"}
COORD_DSN = "dbname=coord host=pg-c"

def place_order(order_id: int, customer_id: int, sku: str) -> bool:
    gid = f"shop:{order_id}"            # prefix = ownership: recovery only touches its own gids
    conns = {name: psycopg.connect(dsn) for name, dsn in PARTICIPANTS.items()}
    xid = {name: c.xid(format_id=1, gtrid=gid, bqual=name) for name, c in conns.items()}
    prepared = []
    try:
        for name, c in conns.items():
            c.tpc_begin(xid[name])
        conns["orders"].execute(
            "INSERT INTO orders (id, customer_id, status) VALUES (%s, %s, 'CONFIRMED')",
            (order_id, customer_id))
        cur = conns["stock"].execute(
            "UPDATE stock SET available = available - 1 WHERE sku = %s AND available >= 1", (sku,))
        if cur.rowcount != 1:
            raise RuntimeError("out of stock")          # vote NO before anyone prepares
        for name, c in conns.items():                    # PHASE 1
            c.tpc_prepare()
            prepared.append(name)
    except Exception:
        for name, c in conns.items():                    # abort: nothing logged (presumed abort)
            try:
                c.tpc_rollback()
            except Exception:
                pass                                     # recovery loop will clean up anything prepared
        return False

    with psycopg.connect(COORD_DSN, autocommit=True) as coord:   # THE COMMIT POINT
        coord.execute("INSERT INTO tpc_log (gid, decision) VALUES (%s, 'commit')", (gid,))

    for name, c in conns.items():                        # PHASE 2: best effort now, recovery later
        try:
            c.tpc_commit()
        except Exception:
            pass                                         # never "give up": recovery will retry
    return True

def recover(stale_after_seconds: int = 60) -> None:
    """Run on startup AND every minute. Resolves every in-doubt txn this coordinator owns."""
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=stale_after_seconds)
    with psycopg.connect(COORD_DSN, autocommit=True) as coord:
        for name, dsn in PARTICIPANTS.items():
            with psycopg.connect(dsn, autocommit=True) as c:
                for x in c.tpc_recover():                # reads pg_prepared_xacts, decodes XA xids
                    if not str(x.gtrid).startswith("shop:"):
                        continue                         # not ours: never touch
                    decided = coord.execute(
                        "SELECT 1 FROM tpc_log WHERE gid = %s", (x.gtrid,)).fetchone()
                    if decided:
                        c.tpc_commit(x)                  # decision was COMMIT: finish it (any age)
                    elif x.prepared and x.prepared < cutoff:
                        c.tpc_rollback(x)                # old + no record: presumed abort
                    # young + no record: a live coordinator may be about to decide; leave it
```

Three details carry all the correctness. The decision row is written with its own fsync **before** any `COMMIT PREPARED` is sent. Recovery treats "no decision row" as abort, which is only safe because the decision row is written *before* phase 2. And the gid prefix scopes recovery so one coordinator never resolves another's transactions. The age check matters too: a young prepared transaction with no decision row may belong to a coordinator that is alive and about to decide, so only old ones are presumed aborted. Garbage-collecting `tpc_log` rows is safe only after every participant has acknowledged.

> **MySQL difference:** MySQL exposes 2PC as **XA**: `XA START 'g1'; ...; XA END 'g1'; XA PREPARE 'g1';` then `XA COMMIT 'g1'` or `XA ROLLBACK 'g1'`; `XA RECOVER` lists prepared transactions (the analogue of `pg_prepared_xacts`). Since MySQL 5.7.7, prepared XA transactions survive client disconnects and server restarts. MySQL also uses 2PC *internally* on every commit, between the binlog and InnoDB's redo log, so that replicas (which read the binlog) and the primary's storage agree after a crash. Prepared XA transactions hold InnoDB row locks and, like PostgreSQL, stop purge from cleaning undo older than them.

### Watching for orphans in production

```sql
-- Alert: any prepared txn older than a few minutes is almost certainly orphaned
SELECT gid, now() - prepared AS age, age(transaction) AS xid_age
FROM pg_prepared_xacts
WHERE prepared < now() - interval '5 minutes';

-- What is holding back vacuum? Prepared xacts show up here, not in pg_stat_activity.
SELECT 'prepared' AS kind, gid AS who, age(transaction) AS xid_age FROM pg_prepared_xacts
UNION ALL
SELECT 'backend', pid::text, age(backend_xmin) FROM pg_stat_activity WHERE backend_xmin IS NOT NULL
UNION ALL
SELECT 'slot', slot_name, age(xmin) FROM pg_replication_slots WHERE xmin IS NOT NULL
ORDER BY xid_age DESC NULLS LAST;
```

### Other places 2PC hides

- **Kafka transactions** are 2PC: a transaction coordinator logs to `__transaction_state` and writes commit/abort *markers* into each partition ([Kafka & RabbitMQ · Kafka Exactly-Once](../messaging/topic.html?p=20-kafka-exactly-once)). They do not span your database.
- **postgres_fdw** does *not* provide atomic commit across servers: the remote transaction commits when the local one does, but a crash in between can leave one side committed.
- **Citus** uses 2PC for transactions that write to more than one worker, with automatic recovery of in-doubt transactions from the coordinator's metadata.

## 6. Advantages, Disadvantages & Trade-offs

| | 2PC / XA | Saga | Redrawn boundary (local txn) |
|---|---|---|---|
| Atomicity | Yes | Eventually, via compensation | Yes |
| Isolation | Yes (locks held to the end) | No: intermediate states visible | Yes |
| Availability | Blocks on coordinator failure | High; each step independent | Single database's availability |
| Latency | 2+ round trips with locks held | Sum of steps, but no cross-step locks | One commit |
| Failure handling | Recovery loop; heuristic decisions | Compensations, retries, sweepers | Rollback |
| Operational risk | Orphaned prepared txns pin xmin | Stuck sagas, compensation bugs | Bigger single database |
| Typical use | Shards of one database; DB + broker via XA | Cross-service business flows | Anything that can be co-located |

**Advantages of 2PC:** real ACID across participants; no application-level compensation logic; well supported inside distributed databases where the coordinator is replicated.
**Disadvantages of 2PC:** blocking; locks held across network round trips; throughput limited by the slowest participant; orphan risk; many services (HTTP APIs, most brokers) cannot participate at all.
**Advantages of sagas:** no cross-service locks; each service keeps its own database; works over messaging and HTTP.
**Disadvantages of sagas:** no isolation; compensation logic is extra code with its own bugs; eventual consistency visible to users ("order pending").

### When to use
- **2PC:** between shards or databases you control, in one datacenter, with short transactions and a coordinator that has real recovery — or, better, inside a distributed SQL database that runs it over consensus for you.
- **Sagas:** long-running or cross-service business processes (checkout, travel booking, onboarding) where steps involve external systems and minutes of latency are acceptable.

### When NOT to use
- **2PC** across microservices owned by different teams, across regions, or with participants that can't guarantee durable prepared state (HTTP APIs).
- **Sagas** for invariants that must never be observed broken — a ledger where debits must equal credits at every instant. Put those rows in one database.
- **Either** when a boundary redesign makes the operation local.

## 7. Common Mistakes & Best Practices

- **Enabling `max_prepared_transactions` without a recovery process.** Every coordinator crash leaves orphans holding locks and the xmin horizon. *Instead:* ship recovery with the coordinator, alert on prepared transactions older than minutes, and keep `max_prepared_transactions` at 0 on databases that don't need 2PC.
- **Sending COMMIT before durably logging the decision.** A coordinator crash then leaves some participants committed and no record to finish the rest. *Instead:* fsync the decision first; it is the commit point.
- **"Resolving" in-doubt transactions by guessing.** Rolling back a prepared transaction whose sibling committed creates the inconsistency 2PC was meant to prevent. *Instead:* consult the coordinator's log; if it is lost, reconcile the business data before deciding.
- **Compensations as absolute writes.** `SET available = 10` erases concurrent changes. *Instead:* deltas and idempotency keys.
- **Irreversible steps early in the saga.** Sending the confirmation email before payment capture means a failure cannot be undone. *Instead:* order steps: compensable → pivot → retriable/irreversible.
- **No expiry on reservations.** Crashed sagas leak held stock forever. *Instead:* `expires_at` plus a sweeper.
- **Choreographed sagas with many steps.** Nobody can answer "where is this order?". *Instead:* orchestrate anything beyond two or three steps.
- **Reaching for a distributed transaction first.** *Instead:* ask whether the rows can live together.

### Redraw the boundary first

Most distributed transactions exist because of a data-ownership decision, not a business need. Options, in order of preference:

1. **Co-locate.** If orders and order payments must commit together, give them the same shard key or the same service database. A ledger's debit and credit rows belong in one database ([Ch 32 · Case Study: Banking Ledger](topic.html?p=32-case-banking)).
2. **Make one side the owner and the other a follower.** The order service commits the order and an outbox row in one local transaction; inventory consumes the event. No atomic commit is needed if inventory can't refuse — for example, when stock was reserved earlier.
3. **Reserve, then confirm (escrow).** Split a scarce resource into per-owner allotments so the hot path decrements a local counter; rebalance asynchronously.
4. **Accept and reconcile.** For low-stakes aggregates, let them diverge briefly and reconcile with a periodic job.

## 8. Production: Failure Scenarios, Monitoring & Scaling

**Failure scenario: the silent bloat.** Over three weeks, table sizes grow 40% and autovacuum runs constantly without reclaiming space. `n_dead_tup` climbs on every busy table. Nothing in `pg_stat_activity` is old. Root cause: a prepared transaction from a coordinator that was redeployed mid-transfer three weeks ago; `pg_prepared_xacts` shows it with an xid age of 180 million. It pins the xmin horizon cluster-wide. Fix: find its sibling on the other participant and the coordinator's log to decide the outcome, `COMMIT PREPARED` or `ROLLBACK PREPARED` it, then let vacuum catch up. Prevent: alert on prepared transactions older than five minutes, and include prepared xacts in the "oldest xmin" dashboard.

**Failure scenario: lock pile-up behind a prepared transaction.** At 14:02 checkout latency jumps; `pg_locks` shows dozens of sessions waiting on a transactionid whose holder is not any backend. Root cause: a prepared transaction holding a row lock on a popular SKU after the coordinator lost its connection. Fix: run the coordinator's recovery, which finds the COMMIT decision and finishes it. Lesson: recovery must run continuously, not just on coordinator startup.

**Failure scenario: stuck sagas after a deploy.** Customer support sees orders stuck in `PENDING` for hours. Root cause: the new orchestrator version renamed a step, so sagas persisted mid-flow with the old step name never resumed. Fix: versioned saga definitions (keep old step handlers until in-flight sagas drain), plus a sweeper that alerts on sagas whose `updated_at` is older than the expected step duration.

**Failure scenario: compensation refused.** A refund fails because the card was closed; the saga retries forever. Fix: a bounded retry followed by an alternative compensation (store credit) and a manual-review queue, with the saga in an explicit `COMPENSATION_FAILED` state rather than looping.

**Metrics to watch**
- `pg_prepared_xacts`: count, max age, max xid age (alert above a few minutes).
- Oldest xmin holder across backends, prepared transactions and replication slots.
- Lock waits where the blocker is a prepared transaction (`pg_locks` with `virtualtransaction LIKE '-1/%'`).
- Saga metrics: in-flight count by state, age of oldest in-flight saga, compensation rate, `COMPENSATION_FAILED` count.
- Coordinator: phase-2 retry count, decision-log size.

**Scaling notes.** 2PC throughput is bounded by prepare latency (a WAL flush per participant) plus the decision flush plus round trips — typically several milliseconds per transaction even within one datacenter, with locks held throughout. Hot rows under 2PC therefore contend much worse than under local transactions. Sagas scale horizontally with the messaging layer; their bottleneck is usually the saga-state table, which should be indexed on `(state, updated_at)` for the sweeper and partitioned or archived by completion time ([Ch 11 · Partitioning](topic.html?p=11-partitioning)).

## 9. Interview Questions

**Q: Why is atomic commit across two databases hard when each database is already ACID?**
A: Each database guarantees atomicity only for its own log; there is no shared commit instant. If you commit one and then the other, the second can refuse (a constraint, insufficient stock) after the first is already durable, or the process can crash between the two commits with nothing remembering the second is owed. You need either a protocol where every participant first promises it can commit and a single decision is recorded, which is 2PC, or a workflow that makes partial completion recoverable through compensations, which is a saga. Retries alone can't fix it, because the failure is a decision problem, not a transient error.

**Q: Walk through two-phase commit and identify the commit point.**
A: The coordinator runs the work on each participant, then sends PREPARE. Each participant makes the transaction durable and able to commit later, then votes YES, or votes NO if it can't. If all vote YES, the coordinator durably logs COMMIT, and that log write is the commit point of the distributed transaction. It then sends COMMIT to every participant and retries until each acknowledges; any NO or timeout before the decision leads to ABORT. After voting YES a participant can neither commit nor abort on its own; it must wait for the decision.

**Q: Why does 2PC block, and in which failure exactly?**
A: It blocks when the coordinator fails after participants have voted YES but before they learn the decision. A prepared participant can't tell whether the coordinator decided COMMIT and crashed, or crashed before deciding. Committing could violate atomicity if the decision was abort, and aborting could violate it if the decision was commit. So it waits, holding locks, until the coordinator recovers from its log. Participant failures are less severe: prepared state survives restart and the participant asks the coordinator for the outcome.

**Q: What does a PostgreSQL prepared transaction hold, and why is an orphan dangerous?**
A: `PREPARE TRANSACTION` persists the transaction so it survives crashes and restarts, detached from any session. It keeps all its row and table locks and its xid remains in progress, so it holds back the cluster-wide xmin horizon. An orphan therefore blocks writers to the rows it touched and stops vacuum from removing dead tuples anywhere, causing bloat and eventually wraparound pressure. It doesn't show up in `pg_stat_activity`, only in `pg_prepared_xacts`, which is why it goes unnoticed. That is why `max_prepared_transactions` defaults to 0.

**Q: What is presumed abort?**
A: A convention where the coordinator logs only COMMIT decisions. If recovery finds a prepared transaction with no decision record, it rolls it back. It works because the coordinator always writes the COMMIT record before sending any COMMIT message, so "no record" can only mean it never decided to commit. This saves a log write on every abort and makes recovery a simple lookup. The one invariant you must never break is sending COMMIT before the decision is durable.

**Q: What is a saga, and what does it give up compared with 2PC?**
A: A saga is a sequence of local transactions, each committed in its own database, with a compensating transaction for each step that may need undoing; on failure the saga runs the compensations in reverse. It gives up isolation: between steps, other transactions can see partial results, such as reserved stock or a pending order. Atomicity becomes eventual, through compensation rather than rollback. In exchange, no locks span services, so a failed service doesn't freeze the others, and steps can be long-running or involve external APIs.

**Q: Orchestration or choreography for a five-step checkout saga?**
A: Orchestration. With five steps, compensation logic and timeouts, you want a single durable saga record that says which step it is on, drives commands through an outbox, and can be resumed by a sweeper after a crash. It makes "where is order 42?" a single query and puts the business flow in one versioned place. Choreography suits two or three loosely coupled reactions, but beyond that the flow exists only as event correlations spread across services, which is hard to debug and change. Either way every handler must be idempotent by `(saga_id, step)`.

**Q: What makes a good compensating transaction?**
A: It is a semantic undo, such as a refund or a release, rather than a physical delete, so audit history is preserved. It is idempotent, because it will be delivered more than once. It uses deltas rather than absolute values so it commutes with concurrent changes. It cannot permanently fail, or it has a defined fallback and a manual path. And it tolerates arriving before the forward step it compensates, by recording a tombstone. Steps that cannot be compensated, such as sending an email or shipping, should come after the pivot.

**Q: You find a three-week-old entry in pg_prepared_xacts. What do you do? (Senior)**
A: First I don't guess. I identify which coordinator owns it from the gid, then check that coordinator's decision log. If the log says COMMIT, I `COMMIT PREPARED`; if there is no record and the coordinator uses presumed abort, I `ROLLBACK PREPARED`. If the log is lost, I check the sibling participants: if the same gid committed elsewhere, I commit; if the sibling is still prepared or rolled back, I roll back. When none of that is conclusive, I reconcile the business data before deciding. Afterwards I measure the damage: vacuum lag, bloat and xid age. Then I fix the root cause: continuous recovery in the coordinator and an alert on prepared transactions older than minutes.

**Q: How do Spanner and CockroachDB make 2PC non-blocking in practice? (Senior)**
A: They keep 2PC but replace the single-machine coordinator and participants with consensus groups. In Spanner, each participant is a Paxos group and the coordinator is one of those groups' leaders, so its decision is replicated before it is acted on; a machine crash triggers a leader change, not a stall. CockroachDB stores a transaction record in a Raft-replicated range, and with parallel commits writes it in a STAGING state alongside the final intent writes, so commit takes one round of consensus. Any node can later decide the outcome by checking whether all the listed writes succeeded. Blocking can still happen in theory if a majority of a group is lost, but ordinary machine failures no longer freeze transactions.

**Q: Design the data flow for "transfer money between two users on different shards". (Senior)**
A: I'd first try to avoid it: if a ledger must balance at every instant, keep all ledger entries for a currency in one database or shard the ledger so a transfer's debit and credit are co-located, for example by moving money through a per-shard clearing account. If the accounts must stay on different shards, I'd run a saga with a hold: T1 on the source shard debits the balance into a `held` entry with the transfer id; T2 on the destination credits; T3 on the source finalises the hold. The compensation for a failed T2 releases the hold back to the balance. Each step is idempotent by transfer id, and pending holds are excluded from available balance, which is a semantic lock. For regulatory-grade atomic visibility, I'd use a distributed SQL database or Citus 2PC within one datacenter, with recovery and orphan alerting.

**Q: When is a distributed transaction the wrong answer altogether? (Senior)**
A: Usually when the need comes from how the data was split rather than from the business. If two rows must always change together, they probably belong in the same database or under the same shard key, and a microservice boundary that separates them is drawn in the wrong place. Other signs: the participants belong to different teams or regions, one participant is an HTTP API with no durable prepare, or the flow takes human-scale time. In those cases I'd redraw ownership, use an outbox so one side owns the decision and the other follows, reserve capacity ahead of time, or accept eventual consistency with reconciliation. 2PC is best kept inside a database system that runs it for you.

## 10. Quick Revision & Cheat Sheet

| Concept | Remember |
|---|---|
| Commit point of 2PC | Coordinator's durable COMMIT record |
| Blocking window | Participant voted YES, coordinator gone |
| Presumed abort | No record = abort; log COMMIT before sending it |
| PG prepared txn | Survives restart; holds locks and the xmin horizon; `pg_prepared_xacts` |
| `max_prepared_transactions` | Default 0; set only with recovery + alerting |
| MySQL | `XA START/END/PREPARE/COMMIT`, `XA RECOVER`; internal binlog/redo 2PC |
| Non-blocking in practice | Coordinator on consensus (Spanner, CockroachDB) |
| Saga | Local txns + compensations; no isolation |
| Pivot | After it, only forward (retry); irreversible steps last |
| Semantic lock | PENDING status / holds with `expires_at` |
| Compensation rules | Semantic, idempotent, delta-based, cannot fail, order-tolerant |

- The best distributed transaction is a local one: co-locate first.
- 2PC is safe but can block; sagas never block but are not isolated.
- Orphaned prepared transactions are invisible in `pg_stat_activity` and pin vacuum.
- Recovery code is part of the coordinator, not an afterthought.
- Orchestrate sagas beyond two or three steps; persist their state.
- Every saga message handler is idempotent by `(saga_id, step)`.

## 11. Hands-On Exercises

Lab: two containers, `docker run -d --name pa -e POSTGRES_PASSWORD=pg postgres:17 -c max_prepared_transactions=10` and the same for `pb`.

1. **Prepared transaction anatomy.** On `pa`, create `accounts`, `BEGIN; UPDATE ... ; PREPARE TRANSACTION 't1';`. From another session try to update the same row (it blocks). Inspect `pg_prepared_xacts`, and `pg_locks` for rows with `virtualtransaction LIKE '-1/%'`. Restart the container and confirm `t1` is still there.
2. **Orphan bloat.** With `t1` still prepared, run an update loop on a different table for a few minutes, then `VACUUM (VERBOSE)` it. Note that dead tuples are "not yet removable". `ROLLBACK PREPARED 't1'` and vacuum again.
3. **Coordinator crash.** Implement the Python coordinator from §5. Insert `os._exit(1)` right after the decision log write; run it; then run `recover()` and verify both participants committed. Move the crash to before the decision log and verify recovery rolls both back.
4. **Saga with compensation.** Build `orders`, `reservations(expires_at)` and `payments` tables, plus a `saga` table. Implement T1–T3 and C1–C2 as idempotent functions keyed by `(saga_id, step)`. Force T3 to fail and confirm compensations run once even when you invoke them three times.
5. **Lost update via compensation.** Implement C2 as `SET available = <old value>` and run a concurrent sale during compensation; observe the lost sale. Fix with a delta.

**Mini project — "Checkout two ways".** Implement the same checkout (order + stock + payment ledger across three databases) once with 2PC and a recovering coordinator, and once as an orchestrated saga with an outbox, holds with expiry and a sweeper. Run a chaos script that kills processes at random points. Report for each: invariant violations (should be zero), p99 latency, lock waits, and the operational alerts you needed.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** [Ch 12 · Sharding](topic.html?p=12-sharding) · [Ch 14 · CAP Theorem](topic.html?p=14-cap-theorem) · [Ch 15 · Consensus](topic.html?p=15-consensus) · [Ch 16 · Distributed Database Architecture](topic.html?p=16-distributed-database-architecture) · [Ch 29 · Advanced Database Patterns](topic.html?p=29-advanced-database-patterns) (outbox, CDC) · [Ch 03 · MVCC](topic.html?p=03-mvcc) (xmin horizon) · [Ch 38 · Case Study: Order System](topic.html?p=38-case-order-system) · [Ch 39 · Case Study: Payment System](topic.html?p=39-case-payment-system).

**SQL Handbook:** [Transactions & ACID](../sql/topic.html?p=25-transactions-acid) · [Isolation Levels](../sql/topic.html?p=26-isolation-levels).

**Other handbooks:** [System Design · Distributed Transactions](../system-design/topic.html?p=21-distributed-transactions) · [Kafka & RabbitMQ · Idempotency & Outbox](../messaging/topic.html?p=21-idempotency-outbox) · [Kafka & RabbitMQ · Kafka Exactly-Once](../messaging/topic.html?p=20-kafka-exactly-once).

- **PREPARE TRANSACTION** — PostgreSQL Documentation · *Intermediate* · exact semantics, restrictions and the warning about leaving prepared transactions open. <https://www.postgresql.org/docs/current/sql-prepare-transaction.html>
- **XA Transactions** — MySQL Reference Manual · *Intermediate* · XA statements, states and recovery in InnoDB. <https://dev.mysql.com/doc/refman/8.0/en/xa.html>
- **Sagas** — Garcia-Molina & Salem, SIGMOD 1987 · *Advanced* · the original paper defining sagas and compensation. <https://dl.acm.org/doi/10.1145/38713.38742>
- **Pattern: Saga** — Chris Richardson, microservices.io · *Intermediate* · orchestration vs choreography and countermeasures for the lack of isolation. <https://microservices.io/patterns/data/saga.html>
- **Parallel Commits** — Cockroach Labs blog · *Advanced* · how an atomic commit protocol runs over Raft in one round of consensus. <https://www.cockroachlabs.com/blog/parallel-commits/>
- **Designing Data-Intensive Applications, ch. 9** — Martin Kleppmann · *Advanced* · atomic commit, 2PC, in-doubt transactions and why consensus is related. <https://dataintensive.net/>

---

*Database Design Handbook — chapter 13.*
