# 29 · Advanced Database Patterns: Outbox, CDC, CQRS & More

> **In one line:** Outbox, inbox, CDC, CQRS, event sourcing, materialized views, audit logs, temporal tables and idempotency keys are all ways of making the database record *more than current state* — and each one is only as correct as its table design, its transaction boundaries, its ordering guarantees and its retention plan, so adopt one only when its specific problem is actually yours.

---

## 1. Overview

> **Builds on:** [SQL Handbook · Views & Materialized Views](../sql/topic.html?p=31-views) (view and matview syntax, `REFRESH ... CONCURRENTLY`) · [SQL Handbook · Stored Procedures, Functions & Triggers](../sql/topic.html?p=32-procedures-triggers) (trigger mechanics) · [Kafka & RabbitMQ · Idempotency, Deduplication & the Outbox Pattern](../messaging/topic.html?p=21-idempotency-outbox) (outbox/inbox from the messaging side, with a full Go relay and consumer) · [System Design · Event-Driven Architecture, CQRS & Event Sourcing](../system-design/topic.html?p=25-event-driven-cqrs) (the architectural view). Those chapters explain *what* these patterns are. This chapter is about the **database side**: the tables, indexes, transactions, ordering and retention that decide whether they work in production.

A plain relational table stores the *current* state of the world. An `UPDATE` destroys the previous value; a `DELETE` destroys the row. For many systems that is exactly right. But a surprising number of requirements need the database to remember or broadcast something extra:

- other services must *learn* about a change reliably (outbox, CDC);
- a consumer must process each message *once* in effect (inbox, idempotency keys);
- reads need a *different shape* than writes (CQRS, read models, materialized views);
- the business needs *history* — who changed what, when, and what was true on a given date (audit logs, temporal tables, event sourcing).

Each requirement has a naive implementation that looks fine in a demo and fails in production. Publishing to Kafka after `COMMIT` loses events on a crash. Polling an outbox with `WHERE id > last_seen` silently skips rows because sequence values are not assigned in commit order. A materialized view refreshed every minute recomputes the whole dataset every minute. An audit trigger doubles write latency on a hot table. An event store without a concurrency check lets two commands corrupt the same aggregate. An idempotency table without a request fingerprint lets a retried request with different parameters return a stale success.

The goal of this chapter is to give you, for each pattern: the problem it solves, the schema that implements it, the transaction and ordering rules that make it correct, how its tables are retained, and — just as important — **when not to use it**. Every one of these patterns adds moving parts, and most systems need only two or three of them.

> **Why this matters:** Senior design interviews reach these patterns quickly ("how does the payment service tell the ledger service?"), and the follow-up questions are always database-side: what is in the outbox row, what if the relay crashes, how do you keep order, how big does the table get.

## 2. Core Concepts

- **Transactional outbox** — a table written in the same transaction as the business change, holding messages to publish. *Why it matters:* the only way to make "change the DB and tell the world" atomic without distributed transactions.
- **Inbox / dedup table** — a table of processed message IDs written in the same transaction as the consumer's effect. *Why it matters:* turns at-least-once delivery into effectively-once processing.
- **CDC (change data capture)** — reading committed changes from the database's log (PostgreSQL logical decoding, MySQL binlog). *Why it matters:* delivers every committed change, in commit order, without touching application code.
- **Replication slot** — a server-side cursor that makes PostgreSQL retain WAL until a consumer confirms it. *Why it matters:* guarantees no change is missed, and can fill the disk if the consumer stops.
- **CQRS** — separate models (and often stores) for writes and reads. *Why it matters:* lets each side be shaped for its workload at the cost of synchronization and staleness.
- **Read model / projection** — a denormalized table built from writes or events for a specific query. *Why it matters:* fast reads without distorting the write schema.
- **Event sourcing** — storing the sequence of domain events as the source of truth and deriving state from them. *Why it matters:* perfect history and replay, at a large cost in complexity.
- **Materialized view** — a stored query result refreshed on demand. *Why it matters:* the cheapest read model to build, but refresh is a full recomputation.
- **Audit log** — an append-only record of who changed what and when. *Why it matters:* compliance, security investigations and debugging; its capture mechanism decides completeness and context.
- **System time vs valid time** — when the database *recorded* a fact versus when the fact is *true in the business*. *Why it matters:* "what did we know on March 1" and "what price applied on March 1" are different questions.
- **Idempotency key** — a client-supplied key making a request safe to retry. *Why it matters:* network retries of non-idempotent operations (payments, orders) are otherwise duplicates.

## 3. Theory & Principles

### Outbox: the table is the easy part, ordering is the hard part

The messaging handbook covers *why* the outbox exists and gives a complete relay. The database-side questions are: what does the row look like, how does the relay find new rows, how is order preserved, and how does the table not grow forever.

**The high-watermark trap.** The obvious relay remembers the last ID it published and polls `WHERE id > $last`. This is wrong in PostgreSQL (and MySQL), because an identity/sequence value is assigned when the row is *inserted*, not when the transaction *commits*. Two concurrent transactions can commit in the opposite order of their IDs:

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c29a1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
    <marker id="c29a2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Why "WHERE id &gt; last_seen" loses outbox rows: IDs are assigned at insert, visible at commit</text>
  <line x1="120" y1="56" x2="860" y2="56" stroke="#334155" stroke-width="1.5" marker-end="url(#c29a1)"/>
  <text x="850" y="48" text-anchor="end" fill="#334155">time</text>
  <text x="20" y="92" fill="#1e293b" font-weight="bold">Txn A</text>
  <rect x="130" y="76" width="170" height="26" rx="4" fill="#dbeafe" stroke="#2563eb"/>
  <text x="140" y="93" fill="#1e293b">INSERT outbox, gets id 100</text>
  <rect x="300" y="76" width="360" height="26" rx="4" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="310" y="93" fill="#334155">slow: payment API call, lock wait ...</text>
  <rect x="660" y="76" width="110" height="26" rx="4" fill="#dcfce7" stroke="#16a34a"/>
  <text x="670" y="93" fill="#14532d">COMMIT (t=5)</text>
  <text x="20" y="142" fill="#1e293b" font-weight="bold">Txn B</text>
  <rect x="200" y="126" width="170" height="26" rx="4" fill="#dbeafe" stroke="#2563eb"/>
  <text x="210" y="143" fill="#1e293b">INSERT outbox, gets id 101</text>
  <rect x="370" y="126" width="110" height="26" rx="4" fill="#dcfce7" stroke="#16a34a"/>
  <text x="380" y="143" fill="#14532d">COMMIT (t=3)</text>
  <text x="20" y="192" fill="#1e293b" font-weight="bold">Relay</text>
  <rect x="500" y="176" width="140" height="26" rx="4" fill="#fef3c7" stroke="#d97706"/>
  <text x="510" y="193" fill="#78350f">poll at t=4: sees 101</text>
  <rect x="700" y="176" width="150" height="26" rx="4" fill="#fee2e2" stroke="#dc2626"/>
  <text x="710" y="193" fill="#7f1d1d">poll: id &gt; 101, finds none</text>
  <path d="M640,189 L698,189" stroke="#dc2626" stroke-width="2" marker-end="url(#c29a2)"/>
  <text x="669" y="218" text-anchor="middle" fill="#b91c1c">last_seen = 101</text>
  <rect x="20" y="236" width="840" height="150" rx="10" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="440" y="258" text-anchor="middle" fill="#1e293b" font-weight="bold">Row 100 is committed but never published. Three correct designs:</text>
  <rect x="36" y="272" width="260" height="100" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="166" y="292" text-anchor="middle" fill="#166534" font-weight="bold">1. Poll by STATE, not cursor</text>
  <text x="46" y="312" fill="#14532d">select unpublished rows with</text>
  <text x="46" y="328" fill="#14532d">FOR UPDATE SKIP LOCKED, then</text>
  <text x="46" y="344" fill="#14532d">delete or mark them. Late commits</text>
  <text x="46" y="360" fill="#14532d">are simply found next poll.</text>
  <rect x="310" y="272" width="260" height="100" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="440" y="292" text-anchor="middle" fill="#1e40af" font-weight="bold">2. Read in COMMIT order (CDC)</text>
  <text x="320" y="312" fill="#1e293b">logical decoding emits whole</text>
  <text x="320" y="328" fill="#1e293b">transactions in commit order,</text>
  <text x="320" y="344" fill="#1e293b">tracked by LSN, so B then A</text>
  <text x="320" y="360" fill="#1e293b">both arrive. Debezium does this.</text>
  <rect x="584" y="272" width="260" height="100" rx="6" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="714" y="292" text-anchor="middle" fill="#5b21b6" font-weight="bold">3. Cursor below in-flight txns</text>
  <text x="594" y="312" fill="#1e293b">store xid8 per row; only read</text>
  <text x="594" y="328" fill="#1e293b">rows whose txn is older than</text>
  <text x="594" y="344" fill="#1e293b">pg_snapshot_xmin(current</text>
  <text x="594" y="360" fill="#1e293b">snapshot). Used by event stores.</text>
</svg>
```

**Per-aggregate order.** Consumers usually need events for the *same entity* in order (OrderCreated before OrderCancelled), not a global order. Two rules deliver it. First, transactions that change the same aggregate must serialize — they do naturally if each first updates the aggregate's row (a row lock), and the outbox row is inserted *after* that update, so the second transaction's outbox row is created only after the first commits. Second, carry an **aggregate version** in the event (the row's version column after the update) so consumers can reject or buffer out-of-order or duplicate events. When publishing to Kafka, use the aggregate ID as the message key so one partition preserves that order ([Kafka & RabbitMQ · Ordering, Partitioning & Keys](../messaging/topic.html?p=22-ordering-partitioning-keys)). A multi-threaded polling relay with `SKIP LOCKED` can still reorder two events of the same aggregate if they are claimed by different workers; either shard relay workers by `hash(aggregate_id)` or let a single worker own the publish loop.

**Retention.** An outbox is a queue table: every row is inserted, read once, and removed. That is a worst case for MVCC — each "mark published" `UPDATE` creates a dead tuple, each `DELETE` creates one, and a busy outbox can churn millions of dead tuples per hour. If vacuum falls behind (or a long transaction pins the xmin horizon), polls get slower as they skip dead index entries. Designs, from simplest to most scalable:

1. **Delete on publish**, with aggressive per-table autovacuum (`autovacuum_vacuum_scale_factor = 0`, `autovacuum_vacuum_threshold = 10000`, low cost delay).
2. **Partition the outbox by time** and drop old partitions; the relay deletes nothing, it just advances.
3. **Use CDC and never keep rows**: insert the outbox row and delete it in the same transaction. Logical decoding still sees the `INSERT` in the WAL, so Debezium publishes it, but the table stays empty. PostgreSQL also offers `pg_logical_emit_message(true, 'outbox', payload)`, which writes a message straight into the WAL inside the transaction with no table at all.

### Inbox and idempotency keys: dedup is a unique constraint plus a transaction

The inbox is the consumer-side twin. Its whole correctness rests on one line: `INSERT INTO inbox (consumer, message_id) ... ON CONFLICT DO NOTHING` inside the same transaction as the side effect, and checking whether a row was inserted. The primary key must include the consumer name, because two different consumers of the same message both need to process it once each. Retention is time-based: keep IDs for longer than the longest plausible redelivery window (broker retention, DLQ replays), partition by day and drop.

**Idempotency keys** apply the same idea to synchronous APIs, with two extra problems: the client needs the *original response* back on retry, and a retry can arrive while the first attempt is still running. So the table stores the request fingerprint, a state machine and the response:

```text
state:  (absent) ──insert──▶ started ──work commits──▶ completed(response stored)
                                  │
                                  └── lease expires (crash) ──▶ retry may take it over
retry with same key:
  completed + same fingerprint   → return stored response (same status code)
  completed + different fingerprint → 422: key reused for a different request
  started, lease valid           → 409: request in progress, retry later
```

If the work involves an external side effect (charging a card through a payment provider), the local transaction cannot contain it. Split the handler into **atomic phases** with a recorded recovery point between them, and pass your idempotency key *down* to the provider so their side also dedups. Brandur Leach's write-up on Stripe-style idempotency keys (linked in §12) is the canonical deep dive.

### CDC: reading the log instead of the tables

PostgreSQL logical decoding turns WAL into a stream of row changes. With `wal_level = logical`, a **publication** declares which tables to stream and a **logical replication slot** with the `pgoutput` plugin tracks how far a consumer has confirmed. The server decodes WAL on the fly, groups changes by transaction, and emits each transaction **only when it commits, in commit order** — which is exactly the ordering property the polling relay lacks. The slot's `confirmed_flush_lsn` advances as the consumer acknowledges; WAL older than the slot's `restart_lsn` can be recycled.

Three details decide whether a CDC pipeline is correct:

- **Replica identity.** `UPDATE` and `DELETE` events carry the old row's key according to `REPLICA IDENTITY` (default: primary key). Tables without a primary key cannot publish updates/deletes unless you set `REPLICA IDENTITY FULL`, which logs the whole old row (more WAL). Unchanged TOASTed columns are *not* included in update events unless identity is FULL; Debezium substitutes a placeholder you must handle.
- **Initial snapshot.** A new consumer needs existing data before the stream. Debezium takes a consistent snapshot exported from the slot's creation point, then switches to streaming — so the snapshot and the stream meet without gaps or duplicates (at-least-once still applies after restarts).
- **Slot retention.** A slot that is not consumed pins WAL forever: a stopped Debezium connector over a long weekend can fill the primary's disk. Set `max_slot_wal_keep_size` to cap it (the slot is invalidated instead, and the consumer must re-snapshot), and alert on slot lag. Slots were historically lost on failover; PostgreSQL 17 can synchronize logical slots to a physical standby (`failover` slot option plus `sync_replication_slots`), and tools such as Patroni manage them too.

Logical decoding does not stream DDL, and sequences are not replicated as changes, so schema changes need a coordinated process (see [Ch 27 · Schema Evolution](topic.html?p=27-schema-evolution)) and downstream schemas must be tolerant.

## 4. Architecture & Workflow

### The data-flow picture

```svg
<svg viewBox="0 0 880 440" width="100%" height="440" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c29b1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="c29b2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
    <marker id="c29b3" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">One write transaction, many derived views: where each pattern sits</text>
  <rect x="20" y="40" width="300" height="250" rx="10" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="170" y="60" text-anchor="middle" fill="#1e293b" font-weight="bold">Primary PostgreSQL, ONE transaction</text>
  <rect x="36" y="74" width="268" height="26" rx="4" fill="#dbeafe" stroke="#2563eb"/>
  <text x="46" y="91" fill="#1e293b">idempotency_keys: claim key (started)</text>
  <rect x="36" y="106" width="268" height="26" rx="4" fill="#dbeafe" stroke="#2563eb"/>
  <text x="46" y="123" fill="#1e293b">orders: UPDATE ... version = version + 1</text>
  <rect x="36" y="138" width="268" height="26" rx="4" fill="#fef3c7" stroke="#d97706"/>
  <text x="46" y="155" fill="#78350f">trigger: orders_history (system time)</text>
  <rect x="36" y="170" width="268" height="26" rx="4" fill="#fef3c7" stroke="#d97706"/>
  <text x="46" y="187" fill="#78350f">trigger: audit_log (who, what, old/new)</text>
  <rect x="36" y="202" width="268" height="26" rx="4" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="46" y="219" fill="#5b21b6">outbox: OrderCancelled v7 (key=order_id)</text>
  <rect x="36" y="234" width="268" height="26" rx="4" fill="#dbeafe" stroke="#2563eb"/>
  <text x="46" y="251" fill="#1e293b">idempotency_keys: completed + response</text>
  <text x="170" y="280" text-anchor="middle" fill="#1e293b" font-weight="bold">COMMIT: all or nothing</text>
  <rect x="350" y="80" width="170" height="130" rx="10" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="435" y="100" text-anchor="middle" fill="#5b21b6" font-weight="bold">WAL</text>
  <text x="362" y="122" fill="#1e293b">logical decoding</text>
  <text x="362" y="140" fill="#1e293b">slot: debezium_orders</text>
  <text x="362" y="158" fill="#1e293b">commit order, by LSN</text>
  <text x="362" y="176" fill="#dc2626">retains WAL until</text>
  <text x="362" y="192" fill="#dc2626">confirmed_flush_lsn</text>
  <path d="M320,165 L348,150" stroke="#7c3aed" stroke-width="2" marker-end="url(#c29b2)"/>
  <rect x="550" y="80" width="130" height="60" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="615" y="104" text-anchor="middle" fill="#5b21b6" font-weight="bold">Debezium</text>
  <text x="615" y="122" text-anchor="middle" fill="#5b21b6">outbox router</text>
  <path d="M520,110 L548,110" stroke="#7c3aed" stroke-width="2" marker-end="url(#c29b2)"/>
  <rect x="710" y="80" width="150" height="60" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="785" y="104" text-anchor="middle" fill="#5b21b6" font-weight="bold">Kafka topic</text>
  <text x="785" y="122" text-anchor="middle" fill="#5b21b6">keyed by order_id</text>
  <path d="M680,110 L708,110" stroke="#7c3aed" stroke-width="2" marker-end="url(#c29b2)"/>
  <rect x="550" y="170" width="140" height="70" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="620" y="192" text-anchor="middle" fill="#166534" font-weight="bold">Consumer svc</text>
  <text x="620" y="210" text-anchor="middle" fill="#166534">inbox + effect</text>
  <text x="620" y="226" text-anchor="middle" fill="#166534">in one txn</text>
  <rect x="710" y="170" width="150" height="70" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="785" y="192" text-anchor="middle" fill="#166534" font-weight="bold">Projector</text>
  <text x="785" y="210" text-anchor="middle" fill="#166534">read model rows +</text>
  <text x="785" y="226" text-anchor="middle" fill="#166534">checkpoint in one txn</text>
  <path d="M760,140 L640,168" stroke="#16a34a" stroke-width="2" marker-end="url(#c29b3)"/>
  <path d="M785,140 L785,168" stroke="#16a34a" stroke-width="2" marker-end="url(#c29b3)"/>
  <rect x="20" y="310" width="840" height="116" rx="10" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="440" y="330" text-anchor="middle" fill="#1e293b" font-weight="bold">Consistency you get from each path</text>
  <text x="36" y="352" fill="#334155">In-transaction (history, audit trigger, sync read model): strong, same commit, costs write latency on the hot path.</text>
  <text x="36" y="372" fill="#334155">Materialized view: consistent snapshot as of its last REFRESH; staleness = refresh interval + refresh duration.</text>
  <text x="36" y="392" fill="#334155">Outbox/CDC to other services and projections: eventual, typically sub-second, at-least-once, ordered per key.</text>
  <text x="36" y="412" fill="#1e293b" font-weight="bold">Decide per read: which of these staleness levels does THIS query tolerate?</text>
</svg>
```

### CQRS inside one database first

CQRS does not require two databases or a message broker. The cheapest version is **a read model table in the same database**, updated in the *same transaction* as the write: strongly consistent, no infrastructure, but it adds write latency and contention on the read-model rows (a counter row updated by every order becomes a hotspot). The next step is an **asynchronous projection** in the same database, fed by the outbox or CDC; the projector applies each event to the read model *and* advances a checkpoint row in one transaction:

```sql
CREATE TABLE projection_checkpoint (
  projection text PRIMARY KEY,
  position   pg_lsn NOT NULL          -- or a Kafka offset / event global position
);
```

Because the checkpoint and the read-model change commit together, a crash replays from the last committed checkpoint and never double-applies. Only when the read side needs a different engine (full-text search, a key-value cache, a columnar store) or independent scaling do you move the read model out — and then you are running the full architecture described in the [system design chapter](../system-design/topic.html?p=25-event-driven-cqrs), with the same checkpoint-plus-idempotency discipline in each consumer.

**Rebuilds** are the operational feature that makes read models safe to change: create `order_summary_v2`, replay from the start of the event history or a fresh snapshot, let it catch up, switch reads with a view or feature flag, drop v1. Design every read model so it can be rebuilt, and know how long a rebuild takes.

### Event sourcing: the event store schema

```sql
CREATE TABLE events (
  stream_id      uuid        NOT NULL,
  version        int         NOT NULL,          -- per-stream, 1, 2, 3 ...
  global_pos     bigint      GENERATED ALWAYS AS IDENTITY,
  tx_id          xid8        NOT NULL DEFAULT pg_current_xact_id(),
  event_type     text        NOT NULL,
  schema_version smallint    NOT NULL,
  data           jsonb       NOT NULL,
  metadata       jsonb       NOT NULL,          -- causation id, correlation id, actor
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (stream_id, version)
);
CREATE UNIQUE INDEX ON events (global_pos);

CREATE TABLE snapshots (
  stream_id uuid PRIMARY KEY, version int NOT NULL, state jsonb NOT NULL
);
```

- **Optimistic concurrency is the primary key.** A command loads stream `S` at version 6, decides, and appends version 7. If another command appended 7 first, the insert fails with a unique violation — the loser reloads and retries. No locks held across the decision.
- **Global ordering for subscribers** has the same trap as the outbox: `global_pos` is assigned before commit. Subscribers either read via CDC, or read only events whose `tx_id` is older than the oldest in-flight transaction (`WHERE tx_id < pg_snapshot_xmin(pg_current_snapshot())`), which guarantees nothing with a lower position can still appear.
- **Snapshots** bound load time: fold events into state every N versions and load the snapshot plus the tail.
- **Events are forever**, so `schema_version` and upcasters are part of the design from day one, and personal data inside events needs crypto-shredding for erasure ([Ch 28 · Data Lifecycle](topic.html?p=28-data-lifecycle)).

### Temporal data: two different "when"s

- **System time (transaction time)** — when the database stored a version. Answers "what did our system say on March 1?" Implemented by a history table maintained by triggers; nobody may edit it. Useful for audits and debugging.
- **Valid time (application/business time)** — the period during which a fact is true in the real world. Answers "what price applied on March 1?", including facts recorded later ("the price change effective March 1 was entered on March 3"). Implemented with a range column and a constraint preventing overlaps.
- **Bitemporal** — both: needed for insurance, finance and payroll where retroactive corrections must not erase what was previously reported.

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE product_prices (
  product_id bigint    NOT NULL,
  price      numeric(12,2) NOT NULL,
  valid      tstzrange NOT NULL,            -- [from, to) business effective period
  EXCLUDE USING gist (product_id WITH =, valid WITH &&)   -- no overlapping periods
);

-- effective price at a moment
SELECT price FROM product_prices
WHERE product_id = 42 AND valid @> timestamptz '2026-03-01 00:00+00';
```

The exclusion constraint is what makes effective dating trustworthy: two overlapping price periods for one product are rejected by the database, not discovered in a month-end report. PostgreSQL 18 adds SQL-standard `WITHOUT OVERLAPS` primary and unique keys for the same purpose; MariaDB and SQL Server offer built-in system-versioned tables.

## 5. Implementation

### Simple example: an outbox that stays small

```sql
CREATE TABLE outbox (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  aggregate_type text        NOT NULL,
  aggregate_id   text        NOT NULL,
  aggregate_ver  int         NOT NULL,
  event_type     text        NOT NULL,
  payload        jsonb       NOT NULL,
  headers        jsonb       NOT NULL DEFAULT '{}',   -- trace id, message id (uuid)
  created_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE outbox SET (autovacuum_vacuum_scale_factor = 0,
                        autovacuum_vacuum_threshold = 10000,
                        autovacuum_vacuum_cost_delay = 0);

-- Write path: lock the aggregate first, then emit.
BEGIN;
UPDATE orders SET status = 'cancelled', version = version + 1
WHERE id = 981 AND status IN ('placed', 'paid')
RETURNING version;                                    -- say 7
INSERT INTO outbox (aggregate_type, aggregate_id, aggregate_ver, event_type, payload)
VALUES ('order', '981', 7, 'OrderCancelled', '{"order_id":981,"reason":"customer"}');
COMMIT;

-- Relay: claim, publish, delete — all in one transaction. If publish fails, ROLLBACK
-- and the rows become visible again. At-least-once; consumers dedup on headers.message_id.
BEGIN;
SELECT id, aggregate_id, event_type, payload, headers
FROM outbox ORDER BY id LIMIT 200
FOR UPDATE SKIP LOCKED;
-- ... publish each to Kafka with key = aggregate_id, wait for acks ...
DELETE FROM outbox WHERE id = ANY($1);
COMMIT;
```

Holding the transaction open while publishing is acceptable here because it is short (a batch, with a broker timeout well under a few seconds) and it locks only outbox rows. Monitor outbox depth and the age of the oldest row: `SELECT count(*), now() - min(created_at) FROM outbox;`.

### Real-world example: CDC pipeline setup and slot hygiene

```ini
# postgresql.conf
wal_level = logical
max_replication_slots = 10
max_wal_senders = 10
max_slot_wal_keep_size = 200GB     # cap WAL pinned by a stuck consumer
```

```sql
CREATE PUBLICATION orders_pub FOR TABLE orders, order_items, outbox;
SELECT pg_create_logical_replication_slot('debezium_orders', 'pgoutput');
ALTER TABLE legacy_no_pk REPLICA IDENTITY FULL;   -- only where there is no PK

-- The query to alert on:
SELECT slot_name, active, wal_status,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)) AS lag
FROM pg_replication_slots WHERE slot_type = 'logical';
```

```text
    slot_name    | active | wal_status |  lag
-----------------+--------+------------+--------
 debezium_orders | f      | extended   | 143 GB
```

An inactive slot with a growing lag is an incident in progress: that WAL cannot be recycled. `wal_status` moves through `reserved` → `extended` → `unreserved` → `lost` as the cap is approached and exceeded; `lost` means the consumer must re-snapshot.

With Debezium, the outbox can be kept empty by deleting in the same transaction — Debezium's outbox event router reads the insert from the WAL:

```sql
BEGIN;
UPDATE orders SET status = 'cancelled', version = version + 1 WHERE id = 981;
WITH o AS (
  INSERT INTO outbox (aggregate_type, aggregate_id, aggregate_ver, event_type, payload)
  VALUES ('order', '981', 7, 'OrderCancelled', '{"order_id":981}') RETURNING id)
DELETE FROM outbox WHERE id IN (SELECT id FROM o);
COMMIT;
```

### Idempotency keys table

```sql
CREATE TABLE idempotency_keys (
  client_id      bigint      NOT NULL,
  key            text        NOT NULL,
  request_hash   bytea       NOT NULL,          -- sha256 of method + path + body
  state          text        NOT NULL CHECK (state IN ('started','completed')),
  locked_until   timestamptz,                   -- lease for in-progress attempts
  recovery_point text        NOT NULL DEFAULT 'start',
  response_code  int,
  response_body  jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, key)                  -- keys are scoped per client
);
CREATE INDEX ON idempotency_keys (created_at);  -- for the expiry job (e.g. 24 h)
```

```python
def handle(conn, client_id, key, req):
    h = sha256(canonical(req)).digest()
    with conn.transaction():
        row = conn.execute("""
          INSERT INTO idempotency_keys (client_id, key, request_hash, state, locked_until)
          VALUES (%s, %s, %s, 'started', now() + interval '30 seconds')
          ON CONFLICT (client_id, key) DO UPDATE
             SET locked_until = now() + interval '30 seconds'
           WHERE idempotency_keys.state = 'started'
             AND idempotency_keys.locked_until < now()        -- take over a dead attempt
          RETURNING state, request_hash""", (client_id, key, h)).fetchone()
    if row is None:                                           # exists and not claimable
        existing = load(conn, client_id, key)
        if existing.request_hash != h: return 422, "idempotency key reused"
        if existing.state == 'completed': return existing.response_code, existing.response_body
        return 409, "request in progress"
    if row.request_hash != h: return 422, "idempotency key reused"
    with conn.transaction():                                  # the business work, atomic
        result = create_order(conn, req)
        conn.execute("""UPDATE idempotency_keys SET state='completed',
                          response_code=201, response_body=%s
                        WHERE client_id=%s AND key=%s""", (json(result), client_id, key))
    return 201, result
```

The key design points: scope keys per client, fingerprint the request so a reused key with different content is rejected, store the response so retries get the *same* answer, use a lease so a crashed attempt can be taken over, and expire keys after a documented window. See [System Design · Idempotency](../system-design/topic.html?p=22-idempotency) for the API-contract side.

### Audit log: trigger-based, with application context

```sql
CREATE TABLE audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY,
  at         timestamptz NOT NULL DEFAULT now(),
  table_name text NOT NULL,
  op         char(1) NOT NULL,                     -- I / U / D
  row_pk     text NOT NULL,
  actor      text,                                 -- from the app, not current_user
  request_id text,
  old_row    jsonb,
  new_row    jsonb,
  tx_id      xid8 NOT NULL DEFAULT pg_current_xact_id(),
  PRIMARY KEY (id, at)
) PARTITION BY RANGE (at);
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM PUBLIC;   -- append-only for app roles

CREATE FUNCTION audit_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_log (table_name, op, row_pk, actor, request_id, old_row, new_row)
  VALUES (TG_TABLE_NAME, left(TG_OP, 1),
          (CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END)::text,
          current_setting('app.actor', true),        -- set by the app per transaction
          current_setting('app.request_id', true),
          CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
          CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END);
  RETURN NULL;
END $$;

CREATE TRIGGER orders_audit AFTER INSERT OR UPDATE OR DELETE ON orders
FOR EACH ROW EXECUTE FUNCTION audit_row();
```

The application runs `SET LOCAL app.actor = 'user:1234'` at the start of each transaction (works with transaction-mode PgBouncer because `SET LOCAL` ends with the transaction). The three capture options compare like this:

| Capture | Completeness | Who/why context | Hot-path cost | Failure mode |
|---|---|---|---|---|
| Trigger | every write, including manual SQL | only if the app sets it | extra insert per row, same txn | slows bulk updates; can be disabled by superusers |
| CDC (logical decoding) | every committed write | only what is in the row (e.g. `updated_by` column) | none on the write path | slot lag; asynchronous |
| Application-level | only paths that remember to log | richest (intent, request) | extra write or event | silently incomplete; bypassed by scripts |

`pgaudit` is a different tool: it logs *statements and sessions* to the server log for compliance ("who ran which SQL"), not row-level before/after images. Many regulated systems use pgaudit plus one of the row-capture options.

### Materialized views: know their limits

```sql
CREATE MATERIALIZED VIEW merchant_daily AS
SELECT merchant_id, date_trunc('day', created_at) AS day,
       count(*) AS orders, sum(amount) AS revenue
FROM orders GROUP BY 1, 2;
CREATE UNIQUE INDEX ON merchant_daily (merchant_id, day);   -- required for CONCURRENTLY

REFRESH MATERIALIZED VIEW CONCURRENTLY merchant_daily;
```

`CONCURRENTLY` keeps readers unblocked (it takes an `EXCLUSIVE` lock, which still allows `SELECT`), but it is not incremental: it re-runs the *entire* query, computes a diff against the current contents, and applies inserts, updates and deletes — so it is often *slower* than a plain refresh, generates dead tuples in the view, and only one refresh can run at a time. It needs a unique index on plain columns covering all rows, and it cannot be used for the very first population. Consequences: matviews are excellent for rollups over bounded data refreshed every few minutes, and a poor fit for large, fast-changing datasets. The next step up is an **incrementally maintained summary table**: a job that aggregates only rows newer than a stored watermark (again, beware the commit-order gap: use a lag margin or xid-based cursor) and upserts into the summary with `INSERT ... ON CONFLICT DO UPDATE`, or the `pg_ivm` extension for incremental view maintenance.

> **MySQL difference:** MySQL has no materialized views (use summary tables maintained by events or jobs). CDC uses the **binlog** with `binlog_format = ROW` and `binlog_row_image = FULL` (Debezium's MySQL connector reads it as a replica, tracking GTID positions); there are no slots, so the risk is the reverse — if binlogs expire (`binlog_expire_logs_seconds`) before a stopped connector resumes, it must re-snapshot. Auto-increment values are also assigned at insert time, so the outbox high-watermark trap applies equally. MySQL triggers work for audit tables, but MySQL has no `SET LOCAL`; pass context via session variables reset per request. MariaDB supports SQL:2011 system-versioned tables (`WITH SYSTEM VERSIONING`) natively.

## 6. Advantages, Disadvantages & Trade-offs

| Pattern | Solves | Costs | Use when | Do NOT use when |
|---|---|---|---|---|
| Outbox | atomic "change + publish" | queue table churn, relay to run | another system must reliably learn of changes | the only consumer is in the same database (just use a table) |
| Inbox | duplicate deliveries | table growth, one more write | effects are not naturally idempotent | effect is an upsert keyed by the message's natural key |
| CDC | stream every change in commit order, no app code | slots, connectors, schema coupling to tables | many consumers, search/cache sync, audit, migrations | you need business intent (use outbox events, possibly via CDC) |
| CQRS (same DB) | read shape differs from write shape | extra writes, sync logic | a few heavy read paths | one model serves both fine |
| CQRS (separate store) | independent read scaling, other engines | eventual consistency, rebuild tooling | search, very high read QPS, analytics | strong read-after-write needed everywhere |
| Event sourcing | full history, replay, temporal queries | complexity, event versioning, erasure, projections mandatory | ledgers, domains where history is the product | CRUD; teams new to eventual consistency |
| Materialized view | expensive query read often | full recompute per refresh | bounded rollups, minutes of staleness OK | large, fast-changing data; freshness in seconds |
| Audit log | who changed what | write amplification, storage | compliance, security, support forensics | as a substitute for backups or events |
| Temporal tables | "as of" and effective-dated queries | range columns, exclusion constraints, bigger tables | prices, contracts, policies, HR, finance | data with no meaningful history |
| Idempotency keys | safe retries of mutating APIs | table + expiry, state machine | payments, orders, anything non-idempotent over a network | naturally idempotent PUT/DELETE by ID |

The meta trade-off: each pattern moves work from read time to write time or from synchronous to asynchronous, and each adds a table that needs its own retention, monitoring and failure handling. Two or three well-run patterns beat seven half-run ones.

## 7. Common Mistakes & Best Practices

- **Polling the outbox with a high-watermark ID.** Rows committed out of ID order are skipped forever. Instead: poll by state with `SKIP LOCKED`, read via CDC, or use an xid-based safe cursor.
- **Publishing inside the business transaction ("send to Kafka, then COMMIT").** A rollback after a successful send emits an event for a change that never happened. Instead: outbox.
- **Letting the outbox or inbox grow forever.** Millions of rows and dead tuples slow every poll. Instead: delete-on-publish with tuned autovacuum, time partitions, or insert-then-delete with CDC.
- **Forgetting slots.** A test Debezium slot left behind pins WAL until the primary's disk fills. Instead: `max_slot_wal_keep_size`, alerts on inactive slots and slot lag, and dropping unused slots.
- **Inbox key without the consumer name.** A second consumer group sees "already processed" and skips. Instead: `PRIMARY KEY (consumer, message_id)`.
- **Idempotency key without a request fingerprint.** A retry with a different amount returns the first request's success. Instead: store and compare a hash of the request.
- **Using CDC row events as your domain events.** Consumers couple to your internal table layout; a column rename breaks five services. Instead: CDC the *outbox* (stable, versioned event schema) and keep raw table CDC for internal uses like search sync.
- **Refreshing a large matview every minute.** Full recompute every minute, constant I/O and bloat. Instead: incremental summary tables.
- **Audit triggers on bulk jobs.** A 10 M-row backfill writes 10 M audit rows. Instead: statement-level triggers with transition tables for bulk operations, or suspend audit for approved maintenance with a record of it.
- **Event sourcing everything.** CRUD entities become streams of `FieldChanged` events and every read needs a projection. Instead: use it only for the aggregates whose history is the business.
- **Best practice:** for every pattern, write down its table's retention, the lag/depth metric you alert on, and the rebuild or replay procedure — before shipping it.

## 8. Production: Failure Scenarios, Monitoring & Scaling

### Failure scenarios

- **The weekend slot.** Friday 18:00 the Kafka Connect cluster is scaled down for maintenance; the Debezium slot goes inactive. Sunday 03:00 the primary's disk hits 95%, `pg_wal` holds 900 GB. Root cause: no slot lag alert, no `max_slot_wal_keep_size`. Fix now: restart the connector (it catches up) or drop the slot (the consumer re-snapshots). Fix forever: cap and alert.
- **Out-of-order order events.** Two relay workers publish `OrderShipped` before `OrderPaid` for the same order; the downstream state machine rejects shipping an unpaid order. Root cause: `SKIP LOCKED` workers split one aggregate's events. Fix: partition relay work by `hash(aggregate_id)`, key messages by aggregate, and include `aggregate_ver` so consumers can detect gaps.
- **The idempotency race.** Mobile clients retry after 2 s; the first request takes 3 s. Without a `started` state and lease, both attempts create an order. Fix: claim the key first, return 409 to concurrent retries.
- **Projection drift.** A bug in a projector dropped a field for three days. Fix: rebuild the read model from the event history or the outbox archive into a v2 table, switch reads. If you cannot rebuild, your read model is a source of truth in disguise.
- **Audit table explosion.** Audit rows are 3x the size of the business table after a year because every `updated_at` touch writes full old/new rows. Fix: `WHEN (OLD IS DISTINCT FROM NEW)`, store only changed columns, partition and tier old audit data ([Ch 28](topic.html?p=28-data-lifecycle)).

### Metrics to watch

| Metric | Query / source | Alert when |
|---|---|---|
| Outbox depth and oldest age | `count(*), now() - min(created_at)` | age > publish SLO |
| Logical slot lag / active | `pg_replication_slots` | inactive > 5 min; lag > threshold |
| Inbox duplicate rate | consumer metrics | sudden spike (redelivery storm) |
| Projection lag | checkpoint position vs head | > freshness SLO |
| Matview refresh duration and last success | job metrics | duration approaching interval |
| Idempotency conflicts (409/422) | API metrics | spikes signal client bugs |
| Dead tuples on queue tables | `pg_stat_user_tables` | growing across vacuums |

### Scaling notes

Outbox throughput scales with batch size and with moving the relay to CDC; beyond that, shard the outbox by aggregate hash across relay workers. Logical decoding is single-threaded per slot and decodes all WAL (even for unpublished tables), so on very write-heavy databases several slots multiply decoding cost — prefer one slot feeding Kafka, with fan-out there. Event stores grow without bound by design: partition by time for archival of old streams or snapshot and archive closed streams. Read models scale out on their own stores; the database-side bottleneck is usually the rebuild, so measure rebuild time as the history grows.

## 9. Interview Questions

**Q: Why can't a relay safely poll the outbox with WHERE id > last_published_id?**
A: Because sequence and identity values are assigned when a row is inserted, while the row becomes visible only when its transaction commits. A transaction that inserted id 100 can commit after one that inserted id 101; if the relay polls in between, it publishes 101, advances its cursor to 101, and never looks at 100 again. The fixes are to poll by state (select unpublished rows with `FOR UPDATE SKIP LOCKED` and delete or mark them), to read changes in commit order through logical decoding as Debezium does, or to only advance a cursor past positions whose transactions are older than the oldest in-flight transaction.

**Q: How do you keep an outbox table from bloating?**
A: An outbox is a queue: every row is inserted, read once and removed, which generates a dead tuple per row whether you mark it published or delete it. I would tune autovacuum for that table specifically — zero scale factor, a fixed row threshold, no cost delay — and make sure no long-running transaction pins the xmin horizon. At higher volume I would partition the outbox by time and drop old partitions, or switch to CDC and insert-then-delete in the same transaction so the table stays empty while Debezium still sees the insert in the WAL. `pg_logical_emit_message` removes the table entirely.

**Q: What is the difference between CDC on business tables and an outbox?**
A: CDC on business tables streams row-level changes of your internal schema: every column change, in commit order, without application code. It is great for internal derived data like search indexes and caches, but it couples consumers to your table layout, and row changes do not carry intent — an update of `status` does not say whether it was a cancellation or a refund. An outbox carries explicit, versioned domain events designed as a public contract. The two combine well: write events to an outbox and use CDC to publish the outbox, which gives commit-ordered delivery without polling and a stable event schema.

**Q: What does a PostgreSQL logical replication slot guarantee, and what is its main operational risk?**
A: A slot records how far its consumer has confirmed and makes the server retain all WAL needed from that point, so the consumer can disconnect and resume without missing any committed change, and changes are delivered per transaction in commit order. The risk is the flip side of that guarantee: if the consumer stops, the slot pins WAL indefinitely and the primary's disk fills. You mitigate with `max_slot_wal_keep_size`, which invalidates the slot instead of letting the disk fill, alerts on inactive slots and slot lag, and cleanup of abandoned slots. Historically slots were also lost on failover; PostgreSQL 17 can synchronize logical slots to standbys.

**Q: How would you design an idempotency key table for a payment API?**
A: Keys are scoped per client, so the primary key is (client_id, key). Each row stores a hash of the request, a state (started or completed), a lease timestamp for in-progress attempts, the recovery point reached, and the stored response code and body. The first request inserts the row in `started` state; a concurrent retry finds it with a valid lease and gets 409; a retry after completion gets the stored response; a retry with a different request hash gets 422. Because charging a card is an external side effect, the flow is split into atomic phases with recovery points and the key is passed to the payment provider. Keys expire after a documented window, such as 24 hours, via a job on `created_at`.

**Q: When would you use a materialized view and when an incrementally maintained summary table?**
A: A materialized view is ideal when the underlying query is expensive, the data it covers is bounded, and minutes of staleness are acceptable, because it is trivial to create and refresh. But every refresh, including `CONCURRENTLY`, recomputes the entire query and then diffs the result, so cost grows with total data, not with changes. For large or fast-changing data I would maintain a summary table incrementally: a job or projector aggregates only new changes and upserts into the summary, with a safe cursor that accounts for late commits. That costs more code but keeps refresh cost proportional to new data.

**Q: Compare trigger-based, CDC-based and application-level audit logging.**
A: Triggers capture every change in the same transaction, including manual SQL, so they are complete and consistent, but they add a write to every modification, and they only know who acted if the application passes context, for example via `SET LOCAL app.actor`. CDC-based auditing adds nothing to the write path and sees every committed change, but it is asynchronous, depends on slot health, and only knows what is in the row itself. Application-level logging has the richest context — intent, request, user — but misses any path that forgets to log, including scripts and migrations. Regulated systems often combine database-level capture for completeness with application context stored alongside.

**Q: What is the difference between system time and valid time, and how do you model valid time in PostgreSQL?**
A: System time records when the database knew something: it is set by the system, never edited, and answers "what did we record on date X". Valid time records when something is true in the business, is set by users, can be retroactive, and answers "what applied on date X". I model valid time with a `tstzrange` column and an exclusion constraint using `btree_gist` so that periods for the same entity cannot overlap, and query with the containment operator `@>`. System time is usually a history table filled by triggers; needing both gives a bitemporal model.

**Q: You are asked to event-source an order management system. How do you decide, and what does the store look like if you proceed? (Senior)**
A: I would first ask whether history is actually the product: if the requirements are current state plus an audit trail, a normal schema with an outbox and an audit log is far cheaper. Event sourcing earns its cost when we must replay decisions, answer temporal questions precisely, or build new projections from the complete past. If we proceed, the store is an events table with primary key (stream_id, version) — the unique constraint gives optimistic concurrency — plus a global position, the writing transaction's xid, event type, schema version, payload and metadata, and a snapshots table. Subscribers read either through CDC or with an xid-based safe cursor so late commits are never skipped. Projections are rebuildable with checkpoints committed together with read-model changes, events are versioned with upcasters from day one, and personal data in events is encrypted per subject for erasure. I would scope it to the order aggregate, not the whole company.

**Q: Your CQRS read model is sometimes missing updates that exist in the write model. How do you debug it? (Senior)**
A: I would first establish whether updates are lost or only late: compare the projection's checkpoint with the head of the source, and check projection lag. If they are truly lost, the classic database causes are a cursor that skips late-committing rows (a high-watermark on a sequence or timestamp), a checkpoint committed separately from the read-model change so a crash advanced it without applying, a consumer that treats a failed event as processed, or events published outside the write transaction and lost on rollback. I would look for those in code and then prove the hypothesis with a reproduction: two concurrent writes with one delayed commit. The fix is a commit-ordered source (CDC or xid-safe cursor), checkpoint plus apply in one transaction, and a reconciliation job that periodically compares write and read models and repairs drift, so the next bug is detected in hours instead of by a customer.

**Q: Design the data layer for exactly-once effects between an order service and a payment service. (Senior)**
A: On the order side, the order change and an `OrderPlaced` event are written in one transaction — the event into an outbox with an aggregate version and a message ID — and a relay or Debezium publishes it to Kafka keyed by order ID. That makes publishing at-least-once and truthful. The payment service consumes and, in one transaction, inserts (consumer, message_id) into its inbox, performs its local effect, and writes its own outbox event such as `PaymentCaptured`; duplicates hit the inbox conflict and are skipped. The external card charge cannot be inside that transaction, so the payment service uses an idempotency key derived from the order ID with the provider and records recovery points, making the external call safe to retry. Both sides monitor outbox age and consumer lag, retain inbox IDs longer than Kafka's retention, and run reconciliation between orders and payments as a backstop.

**Q: Should temporal history live in the same table as current state? (Senior)**
A: Usually not. Mixing current and historical rows means every query for current state needs a `WHERE valid_to IS NULL` or range predicate, every index carries the history, the hot table grows with time, and uniqueness constraints must be written as partial indexes or exclusion constraints. A separate history table keeps the current table small and fast, lets history be partitioned and tiered independently, and can be append-only. The exception is valid-time data that is itself the business object — like price lists with effective dates — where queries routinely ask "what applies at time T" and the exclusion constraint belongs on the one table. The question to ask is whether the application's hot queries are about "now" or about "a point in time".

## 10. Quick Revision & Cheat Sheet

| Pattern | Key table design | Correctness rule | Retention |
|---|---|---|---|
| Outbox | id, aggregate id + version, type, payload, message id | same txn as change; lock aggregate first; poll by state or CDC | delete on publish / partitions / insert+delete with CDC |
| Inbox | PK (consumer, message_id) | insert + effect in one txn | > max redelivery window, partition drop |
| CDC | publication + logical slot, replica identity | commit order by LSN | `max_slot_wal_keep_size`, alert slot lag |
| CQRS read model | denormalized table + checkpoint | apply + checkpoint in one txn | rebuildable |
| Event store | PK (stream_id, version), global_pos, xid8 | unique PK = optimistic concurrency; xid-safe cursor | forever; snapshots; crypto-shred PII |
| Matview | unique index for CONCURRENTLY | full recompute each refresh | n/a |
| Audit log | partitioned, append-only, old/new jsonb, actor | trigger in same txn; `SET LOCAL` context | tier by age |
| Temporal | `tstzrange` + `EXCLUDE USING gist` | no overlapping periods | history partitioned |
| Idempotency keys | PK (client, key), request hash, state, lease, response | claim first; compare hash; store response | expire (e.g. 24 h) |

- Sequence IDs are assigned at insert, visible at commit: never use them as a "seen everything up to" cursor.
- Per-aggregate order: lock the aggregate, then insert the event; key messages by aggregate.
- Queue-like tables need their own vacuum settings or partitions.
- Every slot needs a cap and an alert.
- CDC the outbox for public events; CDC raw tables only for internal derived data.
- `REFRESH ... CONCURRENTLY` is non-blocking, not incremental.
- Audit: triggers for completeness, application context via `SET LOCAL`.
- Most systems need outbox + inbox + idempotency keys; far fewer need event sourcing.

## 11. Hands-On Exercises

Lab: `docker run --name pg -e POSTGRES_PASSWORD=pg -d postgres:17 -c wal_level=logical`.

1. **Reproduce the watermark bug.** In session A, `BEGIN; INSERT INTO outbox ...;` (do not commit). In B, insert and commit. Run a `WHERE id > $last` poller, then commit A and show row A is never published. Fix it with the `SKIP LOCKED` delete-on-publish relay.
2. **Watch logical decoding.** Create a slot with `test_decoding`, make interleaved transactions, and read with `pg_logical_slot_peek_changes` to see changes grouped per transaction in commit order. Then stop reading and watch `pg_replication_slots` lag grow while `pgbench` runs.
3. **Idempotency race.** Implement the idempotency table and fire two identical requests concurrently (e.g. with `xargs -P2 curl`). Confirm exactly one order and one 409 or replayed response. Then send the same key with a different amount and get 422.
4. **Matview vs summary table.** On 10 M orders, time `REFRESH MATERIALIZED VIEW CONCURRENTLY` after inserting 1,000 rows, then build an incremental summary job and time it for the same change.
5. **Effective dating.** Create `product_prices` with the exclusion constraint, try to insert an overlapping period, and write the query for "price on date X" plus a retroactive correction.

**Mini project — reliable order events.** Build an order service with `orders`, `outbox`, `audit_log` and `idempotency_keys`; publish outbox events through Debezium (or the polling relay) into Kafka; build a projector into an `order_summary` read model with a checkpoint table; and write a chaos script that kills the relay, the projector and the API at random points while a load generator creates and cancels orders with retries. Success criteria: the read model matches the write model exactly after the run, no duplicate orders exist, and every change appears once in the audit log.

## 12. Related Topics & Free Learning Resources

**In this handbook:** [Ch 03 · MVCC](topic.html?p=03-mvcc) (why queue tables bloat) · [Ch 07 · Write-Ahead Logging](topic.html?p=07-write-ahead-logging) (what logical decoding reads) · [Ch 09 · Database Replication](topic.html?p=09-replication) (slots) · [Ch 13 · Distributed Transactions](topic.html?p=13-distributed-transactions) (why the outbox beats 2PC) · [Ch 19 · Database Caching Architecture](topic.html?p=19-database-caching-architecture) (CDC-driven invalidation) · [Ch 27 · Schema Evolution](topic.html?p=27-schema-evolution) · [Ch 28 · Data Lifecycle](topic.html?p=28-data-lifecycle).

**SQL Handbook:** [SQL Handbook · Views & Materialized Views](../sql/topic.html?p=31-views) · [SQL Handbook · Stored Procedures, Functions & Triggers](../sql/topic.html?p=32-procedures-triggers) · [SQL Handbook · JSON & Semi-Structured Data](../sql/topic.html?p=24-json-semistructured).

**Other handbooks:** [Kafka & RabbitMQ · Idempotency, Deduplication & the Outbox Pattern](../messaging/topic.html?p=21-idempotency-outbox) · [Kafka & RabbitMQ · Kafka Connect & CDC](../messaging/topic.html?p=25-kafka-connect-cdc) · [Kafka & RabbitMQ · Ordering, Partitioning & Keys](../messaging/topic.html?p=22-ordering-partitioning-keys) · [System Design · Event-Driven Architecture, CQRS & Event Sourcing](../system-design/topic.html?p=25-event-driven-cqrs) · [System Design · Idempotency](../system-design/topic.html?p=22-idempotency) · [Caching with Redis · Dual Write & CDC](../redis-caching/topic.html?p=14-dual-write-and-cdc).

- **Logical Decoding** — PostgreSQL Docs · *Advanced* · slots, output plugins and the commit-order guarantee. <https://www.postgresql.org/docs/current/logicaldecoding.html>
- **Implementing Stripe-like Idempotency Keys in Postgres** — Brandur Leach · *Advanced* · atomic phases, recovery points and the keys table, in depth. <https://brandur.org/idempotency-keys>
- **Reliable Microservices Data Exchange With the Outbox Pattern** — Debezium blog · *Intermediate* · outbox via CDC, including the insert-then-delete technique. <https://debezium.io/blog/2019/02/19/reliable-microservices-data-exchange-with-the-outbox-pattern/>
- **Debezium PostgreSQL Connector** — Debezium Docs · *Advanced* · snapshots, replica identity, TOAST placeholders and slot management. <https://debezium.io/documentation/reference/stable/connectors/postgresql.html>
- **CQRS** — Martin Fowler · *Beginner* · the pattern and the warning that most systems should not use it. <https://martinfowler.com/bliki/CQRS.html>
- **Event Sourcing** — Martin Fowler · *Intermediate* · the original description with replay and temporal query. <https://martinfowler.com/eaaDev/EventSourcing.html>
- **REFRESH MATERIALIZED VIEW** — PostgreSQL Docs · *Beginner* · the exact requirements and behaviour of `CONCURRENTLY`. <https://www.postgresql.org/docs/current/sql-refreshmaterializedview.html>
- **Designing Data-Intensive Applications, ch. 11** — Martin Kleppmann · *Advanced* · CDC, event sourcing and derived data as one idea. <https://dataintensive.net/>

---

*Database Design Handbook — chapter 29.*
