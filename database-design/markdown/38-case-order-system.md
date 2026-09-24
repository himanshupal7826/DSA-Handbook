# 38 · Case Study: Amazon-like Order System

> **In one line:** Once catalog, cart, inventory, orders, payments and shipping each own their database, "place an order" can no longer be one ACID transaction — it becomes an **orchestrated saga** of local transactions, glued together by **outbox events**, **idempotent consumers**, **guarded state transitions** and explicit **compensations**, with reporting rebuilt downstream by CDC.

---

## 1. Overview

> **Builds on:** [Ch 31 · E-commerce Database](topic.html?p=31-case-ecommerce) (the single-database version of this problem — read it first; this chapter is the multi-service, distributed version) · [Ch 13 · Distributed Transactions](topic.html?p=13-distributed-transactions) (2PC vs sagas) · [Ch 29 · Advanced Database Patterns](topic.html?p=29-advanced-database-patterns) (outbox, CDC) · [Ch 04 · Concurrency Control](topic.html?p=04-concurrency-control) (conditional updates) · [SQL Handbook · Transactions & ACID](../sql/topic.html?p=25-transactions-acid). For the messaging mechanics of outbox and inbox see [Kafka & RabbitMQ · Idempotency & Outbox](../messaging/topic.html?p=21-idempotency-outbox); this chapter is about the **data design** of each service and the transactions at each step.

### Why this is a different problem from Chapter 31

In [Ch 31](topic.html?p=31-case-ecommerce), one Postgres database holds products, stock and orders, so checkout is one transaction: decrement stock, insert the order, commit. That is the right design for most shops. At Amazon-like scale and organisation size, it stops working for reasons that are only partly technical:

- **Different workloads**: the catalog is read 200,000 times per second and is document-shaped; the cart is a short-lived key-value blob; inventory is a small, extremely hot set of counters; orders are append-heavy with long lifecycles; payments demand an audit trail. One database cannot be tuned for all of them, and one team's migration or runaway query takes everyone down.
- **Independent teams and deploys**: each domain is owned by a team that must change its schema without coordinating with twenty others. **Database-per-service** is the boundary that makes that possible.
- **External participants**: payment processors and carriers are not in your database no matter how you design it. Even the "single database" design already has a distributed step.

Database-per-service buys autonomy and isolation at a price: **no cross-service transactions, no cross-service joins, no cross-service foreign keys**. This chapter is about paying that price correctly.

### Requirements

**Functional**: browse catalog; maintain a cart (guest and signed-in, merged on login); check out an order with multiple items from multiple warehouses; authorise payment, capture on shipment; ship, possibly in several packages; cancel before shipment; return and refund after delivery; order history per customer; business reporting across all of it.

**Non-functional**

- **Never oversell** a unit that is not physically available (small, bounded overselling is tolerated only for explicitly pre-orderable items).
- **Never charge without an order**, never ship without a successful authorisation, never leave a customer charged for a cancelled order.
- Checkout p99 under 1.5 s end to end (payment authorisation dominates); order placement must keep working if analytics, search or email are down.
- Peak events (Prime-Day-style) at 10× normal volume.

### Workload estimate

| Quantity | Normal | Peak event | Notes |
|---|---|---|---|
| Orders | 10 M/day ≈ 115/s avg, ~600/s peak hour | ~6,000/s | |
| Items per order | 2.5 | 3 | 1.4 warehouses per order on average |
| Inventory reservations | ~1,500/s peak | ~18,000/s | one per (order line, warehouse) |
| Catalog reads | ~200 K/s | ~1 M/s | product pages, search results, recommendations |
| Cart operations | ~30 K/s | ~150 K/s | add/remove/view |
| Hot SKUs | a few thousand | one "deal" SKU at 5,000 reservations/s | the design-breaking number |
| Order rows | 3.6 B/year | | ~1 KB with items → ~4 TB/year, plus events |
| SKUs × warehouses (stock rows) | 500 M SKUs, ~200 M active stock rows | | small rows, hot subset |

### Why a naive distributed design breaks

The first distributed attempt usually looks like a synchronous chain in the order service:

```text
placeOrder():
   inventory.decrement(items)      -- HTTP call, commits in inventory DB
   payment.charge(card, total)     -- HTTP call to payment service -> PSP
   db.insert(order)                -- local commit
   shipping.createShipment(order)  -- HTTP call
```

- If the payment call **times out**, you do not know whether the customer was charged; retrying may charge twice, not retrying may lose money or leave stock decremented forever.
- If the process crashes after `inventory.decrement` and before the order insert, stock is gone with no order to explain it — slow, silent inventory leakage.
- Each step's failure needs a hand-written undo, and those undos can themselves fail.
- The call chain's availability is the **product** of every dependency's availability, and its latency the sum.

Wrapping it in 2PC/XA across four databases and a PSP is not an option (the PSP will not join your transaction, and a coordinator crash leaves locks held in every participant — see [Ch 13 · Distributed Transactions](topic.html?p=13-distributed-transactions)). The answer is a saga with durable state.

## 2. Core Concepts

Services, their data, and the invariants each must guarantee **locally**:

- **Catalog** — products, variants (SKUs), attributes, offers (seller + price). Read-heavy, document-shaped. *Invariant:* published price and content are versioned; orders snapshot the price at purchase.
- **Cart** — per shopper, short-lived, key-value. *Invariant:* none that matter for money — a cart is a wish, not a reservation. Prices and availability are re-validated at checkout.
- **Inventory** — `stock(sku, warehouse)` with `on_hand` and `reserved`; `reservations` with expiry. *Invariant:* **`0 <= reserved <= on_hand`** in every row, enforced by a `CHECK` constraint and conditional updates.
- **Reservation** — a time-limited claim on units in one warehouse for one order line. *Invariant:* every `held` reservation is either committed, released or expired — none leak.
- **Order** — the saga's aggregate: header, lines (with price snapshot), status, version. *Invariant:* **status only moves along allowed edges of the state machine**; every transition is recorded in an append-only event table.
- **Saga** — the orchestrator's durable record of which step the order is on, what it is waiting for, and its deadline. *Invariant:* **every saga terminates** (confirmed or fully compensated), driven by timeouts, not hope.
- **Payment** — authorisations, captures, refunds; its own ledger (designed in [Ch 39 · Payment System](topic.html?p=39-case-payment-system)). *Invariant:* captured amount ≤ authorised amount; refunds ≤ captured.
- **Shipment** — packages, carrier, tracking. *Invariant:* a shipment exists only for a confirmed order and only for committed reservations.
- **Outbox / inbox** — per service: events written in the same transaction as the state change; consumed idempotently by message id. *Invariant:* **an event is published iff its state change committed; applying it twice has no additional effect**.
- **Compensation** — a semantic undo (release reservation, void authorisation, refund) — not a rollback. *Why it matters:* between the action and its compensation, other transactions saw the intermediate state; the design must make that acceptable (for example, a briefly reserved unit that is later released).

## 3. Theory & Principles

### Access patterns, ranked, per service

| Service | Top patterns | Rate (peak) | Store |
|---|---|---|---|
| Catalog | product by id (with offers), search, browse by category | ~1 M/s reads | Postgres (JSONB) or document DB + OpenSearch + cache |
| Cart | get cart, add/remove line, merge guest→user | ~150 K/s | Redis or DynamoDB, TTL |
| Inventory | reserve lines for an order, release, commit, expire | ~18 K/s writes | Postgres, sharded by SKU |
| Order | create, transition, get by id, list my orders | ~6 K/s creates, ~30 K/s reads | Postgres, sharded by customer |
| Payment | authorise, capture, refund (idempotent) | ~6 K/s | Postgres ledger |
| Shipment | create from confirmed order, tracking updates | ~6 K/s | Postgres |
| Analytics | revenue by day, sell-through, funnel | batch | warehouse via CDC |

### Consistency boundaries

The rule: **strong consistency inside a service's database, eventual consistency between services, and every cross-service invariant expressed as a saga with compensation.**

| Invariant | Where it is enforced | How |
|---|---|---|
| No oversell | Inventory DB, one row | `UPDATE stock SET reserved = reserved + q WHERE ... AND on_hand - reserved >= q` |
| One order per checkout attempt | Order DB | `UNIQUE (customer_id, checkout_id)` |
| Valid status transitions | Order DB | guarded `UPDATE ... WHERE status IN (...)` + events table |
| One authorisation per order | Payment DB + PSP | idempotency key = `order_id` ([Ch 39](topic.html?p=39-case-payment-system)) |
| Paid ⇒ stock committed ⇒ shipped | **Across services** | orchestrated saga, compensations, deadlines |
| Reporting totals | Warehouse | CDC, eventually consistent, reconciled |

### The orchestrated saga

```svg
<svg viewBox="0 0 880 560" width="100%" height="560" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c38a1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="c38a2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
    <marker id="c38a3" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Place-order saga: local transactions, events, compensations</text>
  <rect x="30" y="40" width="130" height="34" rx="6" fill="#dbeafe" stroke="#2563eb"/><text x="95" y="61" text-anchor="middle" fill="#1e293b" font-weight="bold">Order (orchestrator)</text>
  <rect x="270" y="40" width="130" height="34" rx="6" fill="#dcfce7" stroke="#16a34a"/><text x="335" y="61" text-anchor="middle" fill="#1e293b" font-weight="bold">Inventory</text>
  <rect x="500" y="40" width="130" height="34" rx="6" fill="#ede9fe" stroke="#7c3aed"/><text x="565" y="61" text-anchor="middle" fill="#1e293b" font-weight="bold">Payment</text>
  <rect x="720" y="40" width="130" height="34" rx="6" fill="#fef3c7" stroke="#d97706"/><text x="785" y="61" text-anchor="middle" fill="#1e293b" font-weight="bold">Shipment</text>
  <line x1="95" y1="76" x2="95" y2="540" stroke="#94a3b8" stroke-dasharray="4 3"/>
  <line x1="335" y1="76" x2="335" y2="540" stroke="#94a3b8" stroke-dasharray="4 3"/>
  <line x1="565" y1="76" x2="565" y2="540" stroke="#94a3b8" stroke-dasharray="4 3"/>
  <line x1="785" y1="76" x2="785" y2="540" stroke="#94a3b8" stroke-dasharray="4 3"/>
  <rect x="20" y="88" width="150" height="34" rx="5" fill="#ffffff" stroke="#2563eb"/>
  <text x="95" y="102" text-anchor="middle" fill="#1e293b">T1: order PENDING</text>
  <text x="95" y="116" text-anchor="middle" fill="#334155">+ outbox ReserveStock</text>
  <path d="M172,112 L318,140" stroke="#2563eb" stroke-width="2" marker-end="url(#c38a1)"/>
  <rect x="260" y="140" width="150" height="34" rx="5" fill="#ffffff" stroke="#16a34a"/>
  <text x="335" y="154" text-anchor="middle" fill="#1e293b">T2: reserve per warehouse</text>
  <text x="335" y="168" text-anchor="middle" fill="#334155">held, expires in 15 min</text>
  <path d="M258,168 L112,196" stroke="#16a34a" stroke-width="2" marker-end="url(#c38a2)"/>
  <rect x="20" y="196" width="150" height="34" rx="5" fill="#ffffff" stroke="#2563eb"/>
  <text x="95" y="210" text-anchor="middle" fill="#1e293b">T3: STOCK_RESERVED</text>
  <text x="95" y="224" text-anchor="middle" fill="#334155">+ outbox AuthorizePayment</text>
  <path d="M172,222 L548,248" stroke="#2563eb" stroke-width="2" marker-end="url(#c38a1)"/>
  <rect x="490" y="248" width="150" height="34" rx="5" fill="#ffffff" stroke="#7c3aed"/>
  <text x="565" y="262" text-anchor="middle" fill="#1e293b">T4: authorise at PSP</text>
  <text x="565" y="276" text-anchor="middle" fill="#334155">idem key = order_id</text>
  <path d="M488,276 L112,304" stroke="#16a34a" stroke-width="2" marker-end="url(#c38a2)"/>
  <rect x="20" y="304" width="150" height="34" rx="5" fill="#ffffff" stroke="#2563eb"/>
  <text x="95" y="318" text-anchor="middle" fill="#1e293b">T5: CONFIRMED</text>
  <text x="95" y="332" text-anchor="middle" fill="#334155">+ CommitStock, CreateShipment</text>
  <path d="M172,326 L318,350" stroke="#2563eb" stroke-width="2" marker-end="url(#c38a1)"/>
  <path d="M172,330 L768,372" stroke="#2563eb" stroke-width="2" marker-end="url(#c38a1)"/>
  <rect x="260" y="350" width="150" height="30" rx="5" fill="#ffffff" stroke="#16a34a"/>
  <text x="335" y="369" text-anchor="middle" fill="#1e293b">T6: held to committed</text>
  <rect x="710" y="372" width="150" height="30" rx="5" fill="#ffffff" stroke="#d97706"/>
  <text x="785" y="391" text-anchor="middle" fill="#1e293b">T7: shipment, then capture</text>
  <rect x="20" y="420" width="840" height="120" rx="10" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="440" y="442" text-anchor="middle" fill="#991b1b" font-size="12" font-weight="bold">Failure paths: compensate completed steps in reverse order</text>
  <text x="40" y="464" fill="#991b1b">T2 fails (no stock anywhere): order CANCELLED (reason out_of_stock). Nothing to compensate.</text>
  <text x="40" y="484" fill="#991b1b">T4 declined: ReleaseStock (held to released, reserved -= q), then order CANCELLED (payment_declined).</text>
  <text x="40" y="504" fill="#991b1b">T4 timeout: payment state UNKNOWN; do not release yet; resolve via PSP query or webhook, then continue or compensate.</text>
  <text x="40" y="524" fill="#991b1b">T6 finds reservation expired: re-reserve; if impossible, VoidAuthorization, then CANCELLED. Customer never charged.</text>
</svg>
```

Why **orchestration** rather than choreography: with five participants and several compensation paths, having each service react to others' events ("inventory listens for OrderCreated, payment listens for StockReserved…") spreads the business process across five codebases, and "why is order 42 stuck?" needs five logs. An orchestrator — here the order service — holds the saga state in **its own database**, so the process is readable in one place and every order's current step, deadline and history is one query away. Participants stay simple: each exposes idempotent commands (`Reserve`, `Release`, `Commit`, `Authorize`, `Void`, `Capture`, `Refund`) and emits a reply event.

Why the ordering **reserve → authorise → confirm → commit → ship → capture**: put the step that is cheapest to compensate first. Releasing a reservation is a local update; voiding an authorisation is an external call that usually works; refunding a capture costs fees and customer trust. Capturing money is the last thing you do, only once goods ship.

### Semantic locks and isolation

A saga has no isolation: between T2 and T6, other checkouts see `reserved` already increased. That is intentional — the reservation *is* a **semantic lock**: a business-level claim visible to others. The anomalies a saga can suffer (lost updates between steps, dirty reads of an intermediate state) are handled by designing each intermediate state to be safe to observe: a `held` reservation is a legitimate state that reduces sellable stock; a `PENDING` order is visible to the customer as "processing".

## 4. Architecture & Workflow

```svg
<svg viewBox="0 0 880 540" width="100%" height="540" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c38b1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
    <marker id="c38b2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Database per service, one event backbone, analytics via CDC</text>
  <rect x="20" y="40" width="160" height="120" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="100" y="60" text-anchor="middle" fill="#1e293b" font-weight="bold">Catalog</text>
  <text x="100" y="78" text-anchor="middle" fill="#334155">Postgres + JSONB attrs</text>
  <text x="100" y="94" text-anchor="middle" fill="#334155">OpenSearch (search)</text>
  <text x="100" y="110" text-anchor="middle" fill="#334155">Redis product cache</text>
  <text x="100" y="130" text-anchor="middle" fill="#334155">read replicas</text>
  <text x="100" y="148" text-anchor="middle" fill="#1e3a8a">1 M reads/s</text>
  <rect x="195" y="40" width="160" height="120" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="275" y="60" text-anchor="middle" fill="#1e293b" font-weight="bold">Cart</text>
  <text x="275" y="78" text-anchor="middle" fill="#334155">Redis hash per cart</text>
  <text x="275" y="94" text-anchor="middle" fill="#334155">or DynamoDB + TTL</text>
  <text x="275" y="110" text-anchor="middle" fill="#334155">guest cart merged</text>
  <text x="275" y="126" text-anchor="middle" fill="#334155">on login</text>
  <text x="275" y="148" text-anchor="middle" fill="#92400e">no money invariants</text>
  <rect x="370" y="40" width="160" height="120" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="450" y="60" text-anchor="middle" fill="#1e293b" font-weight="bold">Inventory</text>
  <text x="450" y="78" text-anchor="middle" fill="#334155">Postgres, shard by sku</text>
  <text x="450" y="94" text-anchor="middle" fill="#334155">stock(sku, warehouse)</text>
  <text x="450" y="110" text-anchor="middle" fill="#334155">reservations + expiry</text>
  <text x="450" y="126" text-anchor="middle" fill="#334155">outbox, inbox</text>
  <text x="450" y="148" text-anchor="middle" fill="#166534">never oversell</text>
  <rect x="545" y="40" width="150" height="120" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="620" y="60" text-anchor="middle" fill="#1e293b" font-weight="bold">Order (orchestrator)</text>
  <text x="620" y="78" text-anchor="middle" fill="#334155">Postgres, shard by</text>
  <text x="620" y="94" text-anchor="middle" fill="#334155">customer_id</text>
  <text x="620" y="110" text-anchor="middle" fill="#334155">orders, lines, events</text>
  <text x="620" y="126" text-anchor="middle" fill="#334155">sagas, outbox, inbox</text>
  <text x="620" y="148" text-anchor="middle" fill="#1e3a8a">state machine</text>
  <rect x="710" y="40" width="150" height="56" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="785" y="60" text-anchor="middle" fill="#1e293b" font-weight="bold">Payment</text>
  <text x="785" y="78" text-anchor="middle" fill="#334155">ledger, idem keys (Ch 39)</text>
  <rect x="710" y="104" width="150" height="56" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="785" y="124" text-anchor="middle" fill="#1e293b" font-weight="bold">Shipment</text>
  <text x="785" y="142" text-anchor="middle" fill="#334155">packages, tracking</text>
  <rect x="20" y="200" width="840" height="70" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="440" y="222" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">Kafka: commands and events (outbox relays / Debezium), keyed by order_id</text>
  <text x="440" y="242" text-anchor="middle" fill="#334155">inventory.commands, inventory.events, payment.commands, payment.events, order.events, shipment.events</text>
  <text x="440" y="260" text-anchor="middle" fill="#334155">keying by order_id keeps each saga's messages ordered on one partition</text>
  <path d="M450,162 L450,198" stroke="#7c3aed" stroke-width="2" marker-end="url(#c38b1)"/>
  <path d="M620,162 L620,198" stroke="#7c3aed" stroke-width="2" marker-end="url(#c38b1)"/>
  <path d="M785,162 L785,198" stroke="#7c3aed" stroke-width="2" marker-end="url(#c38b1)"/>
  <rect x="20" y="300" width="400" height="110" rx="10" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="220" y="322" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="bold">CDC to analytics (no cross-service joins in OLTP)</text>
  <text x="40" y="344" fill="#334155">Debezium on every service DB into raw topics</text>
  <text x="40" y="362" fill="#334155">land in warehouse (BigQuery / Snowflake / ClickHouse)</text>
  <text x="40" y="380" fill="#334155">join orders + payments + shipments there</text>
  <text x="40" y="398" fill="#334155">reconcile: paid orders vs captured payments daily</text>
  <rect x="460" y="300" width="400" height="110" rx="10" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="660" y="322" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="bold">Read models for cross-service screens</text>
  <text x="480" y="344" fill="#334155">"Your orders" page: order DB + denormalised</text>
  <text x="480" y="362" fill="#334155">shipment status copied in from shipment.events</text>
  <text x="480" y="380" fill="#334155">product title/image snapshotted into order lines</text>
  <text x="480" y="398" fill="#334155">no synchronous fan-out to 4 services per page view</text>
  <rect x="20" y="430" width="840" height="96" rx="10" fill="#dcfce7" stroke="#16a34a"/>
  <text x="40" y="452" fill="#1e293b" font-weight="bold">Checkout write path</text>
  <text x="40" y="472" fill="#334155">1. API validates cart against catalog prices (read), creates order PENDING + saga row + outbox command in ONE order-DB transaction.</text>
  <text x="40" y="490" fill="#334155">2. Each participant: inbox dedup + local transaction + outbox reply, all in ONE participant-DB transaction.</text>
  <text x="40" y="508" fill="#334155">3. Orchestrator: inbox dedup + guarded status transition + next command, all in ONE order-DB transaction. Deadlines swept.</text>
  <path d="M220,272 L220,298" stroke="#2563eb" stroke-width="2" marker-end="url(#c38b2)"/>
</svg>
```

### The one pattern every step follows

Every service, at every step, runs exactly this transaction shape against **its own** database:

```text
BEGIN
  INSERT INTO inbox (message_id) ... ON CONFLICT DO NOTHING    -- 0 rows -> duplicate: COMMIT and ack, do nothing
  <local state change, guarded by the current state>           -- conditional UPDATE / INSERT
  INSERT INTO outbox (event or next command)                   -- published by relay iff this commits
COMMIT
ack the incoming message
```

That triple — **inbox, guarded change, outbox in one local transaction** — is what turns an at-least-once message bus into effectively-once business steps ([Ch 29 · Advanced Database Patterns](topic.html?p=29-advanced-database-patterns)). There is no step in the saga that writes to two databases.

### Order state machine

```text
                 ┌──────────────── cancel (customer) ─────────────────┐
                 │                                                     ▼
 PENDING ──stock reserved──► STOCK_RESERVED ──authorised──► CONFIRMED ──shipped──► SHIPPED ──► DELIVERED
    │                            │      │                      │                    │            │
    │ out of stock               │      │ declined /           │ cancel before      │            │ return
    ▼                            │      │ auth timeout→void    │ ship: void +       │            ▼
 CANCELLED ◄─────────────────────┘      └──────────────────────► release           │       RETURN_REQUESTED
                                                                                    │            │ received
                                                                             partial shipments   ▼
                                                                             tracked per package REFUNDED
```

Allowed edges are data, not scattered `if` statements:

```sql
CREATE TABLE order_transitions (from_status text, to_status text, PRIMARY KEY (from_status, to_status));
INSERT INTO order_transitions VALUES
 ('PENDING','STOCK_RESERVED'), ('PENDING','CANCELLED'),
 ('STOCK_RESERVED','CONFIRMED'), ('STOCK_RESERVED','CANCELLED'),
 ('CONFIRMED','SHIPPED'), ('CONFIRMED','CANCELLED'),
 ('SHIPPED','DELIVERED'), ('DELIVERED','RETURN_REQUESTED'), ('RETURN_REQUESTED','REFUNDED');
```

## 5. Implementation

### Inventory service (sharded by `sku`)

```sql
CREATE TABLE stock (
    sku           bigint NOT NULL,
    warehouse_id  int    NOT NULL,
    on_hand       int    NOT NULL CHECK (on_hand >= 0),
    reserved      int    NOT NULL DEFAULT 0 CHECK (reserved >= 0),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (sku, warehouse_id),
    CHECK (reserved <= on_hand)                    -- the no-oversell invariant, enforced by the database
) WITH (fillfactor = 80);

CREATE TABLE reservations (
    reservation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id       bigint NOT NULL,
    line_no        int    NOT NULL,
    sku            bigint NOT NULL,
    warehouse_id   int    NOT NULL,
    qty            int    NOT NULL CHECK (qty > 0),
    status         text   NOT NULL DEFAULT 'held'
                   CHECK (status IN ('held','committed','released','expired','shipped')),
    expires_at     timestamptz NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (order_id, line_no, warehouse_id)       -- idempotency of Reserve for the same order line
);
CREATE INDEX reservations_expiry ON reservations (expires_at) WHERE status = 'held';
CREATE INDEX reservations_order  ON reservations (order_id);

CREATE TABLE inbox  (message_id uuid PRIMARY KEY, received_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE outbox (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, topic text NOT NULL,
                     msg_key text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
```

Shard by `sku` so a reservation touches one shard per SKU; an order spanning several SKUs on different shards is several **independent** reservation transactions, each idempotent — the saga, not a distributed transaction, ties them together.

**The reserve transaction** (one SKU line; the handler loops over the order's lines on this shard, in sorted `(sku, warehouse_id)` order so concurrent orders never lock rows in opposite orders):

```sql
BEGIN;
INSERT INTO inbox (message_id) VALUES ('6c1d...') ON CONFLICT DO NOTHING;   -- 0 rows: duplicate command, COMMIT + re-send reply

-- Try warehouses in preference order (nearest first). The conditional UPDATE is the concurrency control:
-- the row lock serialises concurrent reservers and the WHERE is re-evaluated on the latest row version
-- (READ COMMITTED re-check), so two buyers of the last unit cannot both succeed.
UPDATE stock
   SET reserved = reserved + 2, updated_at = now()
 WHERE sku = 555001 AND warehouse_id = 17
   AND on_hand - reserved >= 2
RETURNING warehouse_id;
-- 0 rows -> try warehouse 23, then 4 ... ; none -> reply StockUnavailable

INSERT INTO reservations (order_id, line_no, sku, warehouse_id, qty, expires_at)
VALUES (9000123, 1, 555001, 17, 2, now() + interval '15 minutes')
ON CONFLICT (order_id, line_no, warehouse_id) DO NOTHING;
-- if this conflicts, the reservation already exists from an earlier attempt -> ROLLBACK the UPDATE above
-- (application checks rowcount) so stock is not reserved twice

INSERT INTO outbox (topic, msg_key, payload)
VALUES ('inventory.events', '9000123',
        '{"type":"StockReserved","order_id":9000123,"line_no":1,"warehouse_id":17,"qty":2}');
COMMIT;
```

In practice you check for an existing reservation **first** (`SELECT ... FROM reservations WHERE order_id = $1 AND line_no = $2 AND status IN ('held','committed')`) and short-circuit with the stored answer; the unique constraint is the safety net for races.

**Release** (compensation) and **commit** are guarded so they are idempotent and cannot double-apply:

```sql
-- Release: only a 'held' reservation gives units back
WITH r AS (
  UPDATE reservations SET status = 'released'
   WHERE order_id = 9000123 AND status = 'held'
  RETURNING sku, warehouse_id, qty
)
UPDATE stock s SET reserved = s.reserved - r.qty, updated_at = now()
  FROM r WHERE s.sku = r.sku AND s.warehouse_id = r.warehouse_id;

-- Commit: held -> committed; returns 0 rows if it had expired (the orchestrator must then re-reserve or void)
UPDATE reservations SET status = 'committed'
 WHERE order_id = 9000123 AND status = 'held' AND expires_at > now()
RETURNING reservation_id;

-- On physical pick/ship: units leave the building
WITH r AS (
  UPDATE reservations SET status = 'shipped' WHERE order_id = 9000123 AND status = 'committed'
  RETURNING sku, warehouse_id, qty)
UPDATE stock s SET on_hand = s.on_hand - r.qty, reserved = s.reserved - r.qty
  FROM r WHERE s.sku = r.sku AND s.warehouse_id = r.warehouse_id;
```

(If one order has several lines for the same `(sku, warehouse)`, aggregate `r` with `GROUP BY` before the `UPDATE ... FROM` — an `UPDATE ... FROM` applies only one matching row per target row.)

**The expiry sweeper** — returns abandoned holds to sellable stock, safe to run on many workers:

```sql
WITH expired AS (
  UPDATE reservations SET status = 'expired'
   WHERE reservation_id IN (
         SELECT reservation_id FROM reservations
          WHERE status = 'held' AND expires_at < now()
          ORDER BY expires_at
          LIMIT 500
          FOR UPDATE SKIP LOCKED)               -- workers never block each other
  RETURNING order_id, sku, warehouse_id, qty
), agg AS (
  SELECT sku, warehouse_id, sum(qty) AS q FROM expired GROUP BY sku, warehouse_id
)
UPDATE stock s SET reserved = s.reserved - agg.q, updated_at = now()
  FROM agg WHERE s.sku = agg.sku AND s.warehouse_id = agg.warehouse_id;
-- plus: INSERT INTO outbox one 'ReservationExpired' event per order (omitted)
```

**Hot SKUs.** A lightning deal on one SKU in one warehouse means thousands of reservations per second on **one row** — the same single-row ceiling as a hot counter. Two standard fixes: split the row into **stock buckets** `(sku, warehouse_id, bucket)` with the units spread across 16–64 buckets and reservers picking a random non-empty bucket (sellable stock = sum of buckets); or put the deal SKU's available count in Redis with an atomic Lua `DECRBY`-if-enough as an admission gate in front of the database, so only winners reach Postgres ([Ch 04 · Concurrency Control](topic.html?p=04-concurrency-control), [Caching with Redis · Pipelining, Lua & Transactions](../redis-caching/topic.html?p=22-pipelining-lua-transactions)). The database remains the source of truth; Redis only sheds losers early.

### Order service (sharded by `customer_id`, orchestrator)

```sql
CREATE TABLE orders (
    order_id        bigint PRIMARY KEY,               -- embeds shard bits of customer_id
    customer_id     bigint NOT NULL,
    checkout_id     uuid   NOT NULL,                   -- client idempotency key for "Place order"
    status          text   NOT NULL DEFAULT 'PENDING',
    version         int    NOT NULL DEFAULT 0,
    currency        char(3) NOT NULL,
    total_minor     bigint NOT NULL CHECK (total_minor >= 0),   -- money as integer minor units
    ship_address    jsonb  NOT NULL,                   -- snapshot, not a FK to a mutable address book
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (customer_id, checkout_id)
);
CREATE INDEX orders_by_customer ON orders (customer_id, created_at DESC);

CREATE TABLE order_lines (
    order_id        bigint NOT NULL REFERENCES orders,
    line_no         int    NOT NULL,
    sku             bigint NOT NULL,                   -- no FK: catalog is another service's database
    title_snapshot  text   NOT NULL,
    unit_price_minor bigint NOT NULL,
    qty             int    NOT NULL CHECK (qty > 0),
    PRIMARY KEY (order_id, line_no)
);

CREATE TABLE order_events (                            -- append-only history of every transition
    order_id    bigint NOT NULL,
    seq         int    NOT NULL,
    from_status text,
    to_status   text   NOT NULL,
    reason      text,
    caused_by   uuid,                                  -- message id that caused it
    at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (order_id, seq)
);

CREATE TABLE sagas (
    order_id      bigint PRIMARY KEY REFERENCES orders,
    step          text   NOT NULL,                     -- RESERVING, AUTHORIZING, COMMITTING, COMPENSATING, DONE
    attempts      int    NOT NULL DEFAULT 0,
    deadline_at   timestamptz NOT NULL,                -- when to re-drive or give up on the current step
    compensations jsonb  NOT NULL DEFAULT '[]'         -- steps already completed that would need undo
);
CREATE INDEX sagas_due ON sagas (deadline_at) WHERE step <> 'DONE';
-- plus inbox and outbox tables identical to the inventory service
```

**Place order** — one local transaction creates the order, its saga, and the first command:

```sql
BEGIN;
INSERT INTO orders (order_id, customer_id, checkout_id, currency, total_minor, ship_address)
VALUES (9000123, 77, 'a8b2...', 'USD', 5998, '{"line1":"..."}')
ON CONFLICT (customer_id, checkout_id) DO NOTHING
RETURNING order_id;
-- 0 rows: double-click / retry -> ROLLBACK, SELECT the existing order by (customer_id, checkout_id), return it

INSERT INTO order_lines VALUES (9000123, 1, 555001, 'USB-C cable 2m', 1499, 2), (9000123, 2, 812300, 'Charger 65W', 3000, 1);
INSERT INTO order_events (order_id, seq, to_status) VALUES (9000123, 1, 'PENDING');
INSERT INTO sagas (order_id, step, deadline_at) VALUES (9000123, 'RESERVING', now() + interval '30 seconds');
INSERT INTO outbox (topic, msg_key, payload)
VALUES ('inventory.commands', '9000123', '{"type":"ReserveStock","message_id":"6c1d...","order_id":9000123,"lines":[...]}');
COMMIT;
```

**A guarded transition** — the only way status ever changes:

```sql
WITH t AS (
  UPDATE orders o
     SET status = 'CONFIRMED', version = o.version + 1, updated_at = now()
   WHERE o.order_id = 9000123
     AND o.status = 'STOCK_RESERVED'                                  -- expected current state
     AND EXISTS (SELECT 1 FROM order_transitions
                  WHERE from_status = 'STOCK_RESERVED' AND to_status = 'CONFIRMED')
  RETURNING o.order_id, o.version
)
INSERT INTO order_events (order_id, seq, from_status, to_status, caused_by)
SELECT order_id, version + 1, 'STOCK_RESERVED', 'CONFIRMED', 'e4f0...' FROM t;
-- 0 rows affected: the order is not in STOCK_RESERVED (already confirmed by a duplicate, or cancelled):
-- the handler decides based on the actual current status, never blindly overwrites.
```

(`seq = version + 1` works because `order_events.seq` 1 is the creation event at version 0.)

### Application code: the orchestrator's reply handler

This is the trickiest flow: it must be idempotent, handle out-of-order and late replies, and never leave a saga without a next step or a deadline.

```go
// HandlePaymentReply runs for PaymentAuthorized / PaymentDeclined / PaymentUnknown replies.
func (o *Orchestrator) HandlePaymentReply(ctx context.Context, msg Reply) error {
	return withTx(ctx, o.db, func(tx pgx.Tx) error {
		// 1. Inbox: a redelivered reply is a no-op.
		tag, err := tx.Exec(ctx, `INSERT INTO inbox (message_id) VALUES ($1) ON CONFLICT DO NOTHING`, msg.ID)
		if err != nil || tag.RowsAffected() == 0 {
			return err
		}
		// 2. Lock the saga row: serialises this handler with the deadline sweeper and other replies.
		var step string
		if err := tx.QueryRow(ctx, `SELECT step FROM sagas WHERE order_id = $1 FOR UPDATE`, msg.OrderID).
			Scan(&step); err != nil {
			return err
		}
		if step != "AUTHORIZING" {
			// Late reply: the saga already moved on (e.g. the sweeper cancelled on timeout).
			// If money was authorised for an order we cancelled, compensate: void it.
			if msg.Type == "PaymentAuthorized" {
				return enqueue(ctx, tx, "payment.commands", msg.OrderID, VoidAuth{OrderID: msg.OrderID})
			}
			return nil
		}
		switch msg.Type {
		case "PaymentAuthorized":
			if err := transition(ctx, tx, msg.OrderID, "STOCK_RESERVED", "CONFIRMED", msg.ID); err != nil {
				return err
			}
			if err := setStep(ctx, tx, msg.OrderID, "COMMITTING", 30*time.Second); err != nil {
				return err
			}
			if err := enqueue(ctx, tx, "inventory.commands", msg.OrderID, CommitStock{OrderID: msg.OrderID}); err != nil {
				return err
			}
			return enqueue(ctx, tx, "shipment.commands", msg.OrderID, CreateShipment{OrderID: msg.OrderID})
		case "PaymentDeclined":
			if err := setStep(ctx, tx, msg.OrderID, "COMPENSATING", 30*time.Second); err != nil {
				return err
			}
			return enqueue(ctx, tx, "inventory.commands", msg.OrderID, ReleaseStock{OrderID: msg.OrderID})
		case "PaymentUnknown":
			// PSP timeout: do NOT release stock or cancel. Extend the deadline; payment service resolves it
			// via PSP status query or webhook and sends a definitive reply later.
			return setStep(ctx, tx, msg.OrderID, "AUTHORIZING", 2*time.Minute)
		}
		return nil
	})
}
```

The **deadline sweeper** selects `sagas WHERE deadline_at < now() AND step <> 'DONE' FOR UPDATE SKIP LOCKED` and re-sends the current step's command (safe: every command is idempotent) or, after N attempts, starts compensation. It is what guarantees every saga terminates even if a reply is lost forever.

### Cart (Redis)

```text
HSET   cart:u:77  555001 2  812300 1        # field = sku, value = qty; prices NOT stored
EXPIRE cart:u:77  2592000                   # 30 days for signed-in carts
HSET   cart:g:5f2a... 555001 1              # guest cart keyed by an anonymous cookie id, 7-day TTL
```

On login, merge guest into user atomically with a Lua script (sum quantities, cap per SKU, delete the guest key) so a double login request cannot merge twice. Store the cart in DynamoDB instead (partition key `cart_id`, a TTL attribute) if you need multi-region durability; losing a cart is annoying, not catastrophic, which is why an in-memory store with AOF is acceptable. At checkout the order service **re-prices** every line from the catalog and fails loudly on a price change — the cart never carries authority.

### Catalog (brief — see [Ch 31](topic.html?p=31-case-ecommerce) for the relational model)

Products with category-specific attributes in `jsonb` (GIN index for filterable attributes), offers `(sku, seller_id, price_minor, currency, valid_from)`, served through a product-detail read model in Redis and a search index fed by CDC. The catalog database sees only cache misses and merchant edits. Price history is append-only so an order line's `unit_price_minor` can always be explained.

### Reporting via CDC

```sql
-- In the warehouse (not OLTP): join across services' CDC-landed tables
SELECT date_trunc('day', o.created_at) AS day,
       sum(o.total_minor) FILTER (WHERE o.status IN ('CONFIRMED','SHIPPED','DELIVERED')) / 100.0 AS gmv,
       count(*) FILTER (WHERE o.status = 'CANCELLED') AS cancelled
  FROM raw_orders.orders o
 GROUP BY 1 ORDER BY 1;
```

Each service's database publishes changes through a Debezium connector into Kafka, and a loader lands them in the warehouse. The OLTP databases never serve cross-service reports, and schema changes in a service surface as a contract change on its CDC topic — manage them with a schema registry ([Kafka & RabbitMQ · Kafka Connect & CDC](../messaging/topic.html?p=25-kafka-connect-cdc)).

### Diagnostics

```sql
-- Stuck sagas by step: the single most useful operational query
SELECT step, count(*), min(deadline_at) AS oldest_deadline, max(attempts) AS max_attempts
  FROM sagas WHERE step <> 'DONE' GROUP BY step ORDER BY 2 DESC;

-- Inventory: reservations held past expiry (sweeper falling behind?)
SELECT count(*), min(expires_at) FROM reservations WHERE status = 'held' AND expires_at < now();

-- Outbox backlog per service
SELECT count(*), min(created_at) FROM outbox;   -- if the relay deletes published rows
```

## 6. Advantages, Disadvantages & Trade-offs

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| Cross-service consistency | Orchestrated saga + compensations | 2PC/XA | PSP and carriers cannot participate; blocking in-doubt transactions; availability = product of participants. |
| Coordination style | Orchestration (order service) | Choreography | Process visible in one place; easier to add steps, deadlines, and to answer "why is it stuck". Choreography is fine for 2–3 steps. |
| Messaging | Outbox + inbox in every service | Publish after commit; synchronous HTTP chain | Dual-write gaps; duplicate side effects on retry. |
| Oversell protection | Conditional `UPDATE` + `CHECK (reserved <= on_hand)` | `SELECT` then `UPDATE`; `SERIALIZABLE` everywhere | Atomic, single-row, no retries needed; SSI would add aborts under contention. |
| Reservation timing | At checkout, with expiry | At add-to-cart | Carts are abandoned ~70% of the time; reserving on add-to-cart locks stock for browsers. |
| Order of steps | Reserve → authorise → confirm → commit → ship → capture | Charge first | Cheapest compensations first; capture only when goods ship. |
| Cart store | Redis / DynamoDB with TTL | Relational cart tables | Key-value access, no invariants, natural expiry. |
| Reporting | CDC into a warehouse | Cross-database queries / reporting replica of each DB | No cross-service joins in OLTP; history retained. |
| Status changes | Guarded transitions from a transition table | `UPDATE orders SET status = $new` | Duplicate and late messages cannot move the order backwards. |

### When to use this design

- Multiple teams, multiple deployables, and domains with genuinely different workloads and scaling needs.
- When the business process already crosses organisational or external boundaries (PSPs, warehouses, carriers, marketplaces).

### When this design is wrong

- **One team, one product, < a few hundred orders per second.** The single-database design of [Ch 31](topic.html?p=31-case-ecommerce) gives you ACID checkout for free. Splitting into services first and discovering you need sagas is the most expensive way to learn you did not need services. Start as a modular monolith with one database and separate schemas per module; split along those seams when a module's workload or team demands it.
- **Operations that must be atomic and immediately visible across entities** (a ledger transfer): keep them inside one database ([Ch 32 · Banking Ledger](topic.html?p=32-case-banking)). Sagas are for business processes that can tolerate intermediate states.

## 7. Common Mistakes & Best Practices

- **"Distributed monolith" — synchronous HTTP calls between services inside the request.** Availability multiplies down, latency adds up, and a timeout leaves unknown state. Instead: one local transaction + outbox; downstream steps asynchronous; only the user-facing wait (payment authorisation) is awaited, via the saga's state.
- **Publishing events after commit ("commit, then producer.send").** A crash between them loses the event and the saga stalls silently. Instead: outbox rows in the same transaction.
- **Non-idempotent participants.** A redelivered `ReserveStock` reserves twice; a redelivered `Refund` refunds twice. Instead: inbox dedup by message id **and** business-key uniqueness (`UNIQUE (order_id, line_no, warehouse_id)`), so even a re-sent command with a new message id is harmless.
- **Compensation that assumes the forward step happened.** `ReleaseStock` for an order whose reservation never committed must be a no-op, not a negative `reserved`. Instead: guard every compensation on the current state (`WHERE status = 'held'`), and let `CHECK` constraints catch bugs.
- **Treating a PSP timeout as a failure.** Releasing stock and cancelling while the authorisation actually succeeded leaves a charged customer with a cancelled order. Instead: an explicit `UNKNOWN` state, resolved by query/webhook before deciding ([Ch 39 · Payment System](topic.html?p=39-case-payment-system)).
- **No deadlines.** A lost reply leaves a saga waiting forever and a reservation held until it expires — then the order is confirmed against stock that was released. Instead: a `deadline_at` per saga step, a sweeper, and a commit step that re-validates the reservation.
- **Foreign keys to other services' tables, or reading another service's database directly.** It couples schemas and deployments and defeats the whole point. Instead: store ids, snapshot what you need (title, price, address), and subscribe to events.
- **Cross-service reports against production databases.** Instead: CDC into a warehouse; reconcile there.
- **Blind status writes** (`SET status = 'SHIPPED'`) from event handlers. A late `PaymentAuthorized` can resurrect a cancelled order. Instead: guarded transitions with expected-current-state.

## 8. Production: Failure Scenarios, Monitoring & Scaling

### Scaling path

Following [Ch 21 · Database Scaling](topic.html?p=21-database-scaling):

- **Modular monolith** — one Postgres, one schema per module, sagas unnecessary because checkout is one transaction. Enforce module boundaries in code (no cross-schema joins) so the split is possible later.
- **First split** — extract the module with the most divergent workload (usually catalog/search for reads, or payment for compliance). Introduce outbox + Kafka for that one boundary.
- **Full database-per-service** — orchestrated saga; inventory sharded by `sku` (Citus with `sku` as distribution column, or app-level), orders by `customer_id` ([Ch 12 · Sharding](topic.html?p=12-sharding)).
- **Peak events (10×)** — pre-split hot SKUs into stock buckets, Redis admission gate for deals, pre-scale Kafka partitions and relays, raise reservation expiry slightly to absorb slower payment authorisation, and load-test the saga (not just the API) with synthetic orders. Capacity per [Ch 22 · Capacity Planning](topic.html?p=22-capacity-planning).

### Failure scenarios

- **At 00:01 on sale day, the deal SKU's checkout p99 hits 8 s.** Symptom: `pg_stat_activity` shows hundreds of sessions waiting on `transactionid` for `UPDATE stock ... sku = 555001`. Root cause: 5,000 reservations/s on one row, each holding the lock through its commit. Fix now: turn on the Redis admission gate for that SKU; structurally, stock buckets pre-split before the event, and keep the reserve transaction free of anything slow (no calls, no triggers).
- **Silent inventory leak.** Sellable stock drifts down over weeks; physical counts disagree. Root cause: reservations for orders whose saga died were never released because the sweeper only looked at `expires_at` on a partial index that a migration dropped. Fix: restore the index; a nightly reconciliation job compares `stock.reserved` with `sum(qty) FROM reservations WHERE status IN ('held','committed')` per row and alerts on any difference.
- **Customers charged for cancelled orders.** Root cause: a payment authorisation succeeded after a PSP timeout; the orchestrator had already cancelled on deadline and ignored the late `PaymentAuthorized`. Fix: the late-reply branch voids the authorisation (see the handler above); daily reconciliation between the payment ledger and order states catches the rest.
- **Kafka relay down for 20 minutes.** Orders stay `PENDING`; reservations are not made; the outbox grows. Nothing is lost; when the relay returns, commands flow and sagas continue. But the 15-minute reservation expiry for orders whose `StockReserved` arrived just before the outage may have passed — the commit step detects the expiry and re-reserves. Alert on outbox age > 60 s.
- **Duplicate shipment.** Root cause: `CreateShipment` handler deduplicated only by message id; the orchestrator's sweeper re-sent the command with a new message id after a slow reply. Fix: business-key uniqueness in the shipment DB — `UNIQUE (order_id, package_no)`.
- **Order DB primary fails over.** With async replication, the last few committed transactions may be lost ([Ch 18 · High Availability](topic.html?p=18-high-availability)) — including an order whose `ReserveStock` command was already relayed. Inventory now holds a reservation for a non-existent order; it expires harmlessly. Use synchronous replication for the order and payment databases so an acknowledged order is never lost.

### Monitoring

| Metric | Why | Alert when |
|---|---|---|
| Sagas past deadline, by step | stuck business processes | > 0.1% of in-flight |
| Order funnel: PENDING → CONFIRMED conversion and latency | end-to-end health | p99 > 3 s |
| Outbox age per service; relay / Debezium slot lag | event flow | > 60 s / > 10 GB |
| Reservations held past expiry; stock-vs-reservations reconciliation diff | inventory integrity | any non-zero diff |
| Row lock waits on `stock` per SKU | hot SKUs | lock wait p99 > 50 ms |
| Payment UNKNOWN count and age | PSP trouble | > 1 min old |
| Orders CONFIRMED without shipment after N hours | fulfilment gaps | business-defined |

### Backups, DR and lifecycle

- Each service backs up its own database with PITR ([Ch 26 · Backup & DR](topic.html?p=26-backup-disaster-recovery)). Restoring one service to a point in time creates **cross-service inconsistency** (inventory from 10:00, orders from 10:05). Plan for it: after a restore, replay events from Kafka (retain ≥ 7 days) into the restored service and run reconciliation jobs, rather than trying to restore all services to the same instant.
- Orders are legal records: retain for years, partition `order_events` and closed orders by month and move old partitions to cheaper storage ([Ch 28 · Data Lifecycle](topic.html?p=28-data-lifecycle)). Inbox rows: 7–14 days. Outbox rows: deleted once published. Carts: TTL.

## 9. Interview Questions

**Q: Why not use a distributed transaction (2PC) across the inventory, order and payment databases?**
A: Because the payment processor and carriers cannot participate in your 2PC, so it never covers the whole operation anyway. Within your databases, 2PC blocks: if the coordinator dies after participants have prepared, they hold locks and pin the xmin horizon until someone resolves them, so a coordinator failure stalls checkout and bloats every participant. Availability becomes the product of all participants and latency the sum of their prepare round trips. A saga keeps each step a fast local transaction and handles failure with explicit compensation, accepting visible intermediate states in exchange.

**Q: What is the difference between orchestration and choreography, and which would you use here?**
A: In choreography each service reacts to others' events with no central coordinator; in orchestration one component holds the process state and sends commands to participants. With five participants, timeouts and several compensation paths, I use orchestration: the order service stores each saga's step and deadline in its own database, so "where is order 42 stuck?" is one query and adding a step is one change. Choreography is simpler for two or three steps but spreads the business process across services and makes cyclic dependencies and debugging harder as it grows.

**Q: How do you guarantee you never oversell?**
A: The invariant `reserved <= on_hand` lives in one row per SKU and warehouse, enforced both by a `CHECK` constraint and by the reservation statement itself: `UPDATE stock SET reserved = reserved + q WHERE ... AND on_hand - reserved >= q`. The row lock serialises concurrent reservers, and under READ COMMITTED Postgres re-evaluates the `WHERE` against the latest committed version, so two buyers of the last unit cannot both succeed — the second updates zero rows. No `SELECT` then `UPDATE`, no application-level check. Reservations expire so abandoned checkouts return stock.

**Q: When do you reserve inventory — add to cart or checkout — and why?**
A: At checkout, with a short expiry like 15 minutes. Most carts are abandoned, so reserving on add-to-cart would lock large amounts of stock for people who are just browsing and invite abuse. The cart is treated as a wish list with no invariants; availability and prices are re-validated when the order is placed. For limited drops some sites reserve on "add to cart" deliberately with a very short timer — that is a product decision with the same mechanism.

**Q: How does each service avoid processing the same command twice?**
A: Two layers. An inbox table keyed by message id, inserted with `ON CONFLICT DO NOTHING` in the same transaction as the state change, drops exact redeliveries. And business-key uniqueness — `UNIQUE (order_id, line_no, warehouse_id)` on reservations, `UNIQUE (order_id, package_no)` on shipments — catches the case where the orchestrator legitimately re-sends a command with a new message id after a timeout. Every compensation is also guarded by current state so it is idempotent.

**Q: What is the transactional outbox and why does every service need one?**
A: It is a table in the service's own database where the service writes the event or next command in the same transaction as its state change; a relay or Debezium then publishes committed rows to Kafka. Without it, "commit then publish" can crash in between and the saga stalls forever with no error, or "publish then commit" can emit an event for a change that rolled back. With the outbox, an event exists if and only if its change committed. Delivery becomes at-least-once, which the inbox on the consuming side handles.

**Q: How do you model the order state machine in the database?**
A: Allowed transitions are data in an `order_transitions` table, and the only way to change status is a guarded update — `UPDATE orders SET status = $to, version = version + 1 WHERE order_id = $id AND status = $expected` — that also appends a row to an append-only `order_events` table in the same statement. If zero rows are affected, the handler looks at the actual state and decides, instead of overwriting. That makes duplicate and late messages harmless and gives a full audit trail.

**Q: How do you produce cross-service reports like revenue by day or sell-through?**
A: Not by querying production databases across services. Each service's database streams changes through CDC (Debezium) into Kafka, and a loader lands them in a warehouse where joins across orders, payments and shipments are cheap. The warehouse is eventually consistent, and daily reconciliation jobs there compare, for example, confirmed orders against captured payments. Schema changes become contract changes on the CDC topics, managed with a schema registry.

**Q: The payment authorisation times out. What does the saga do? (Senior)**
A: A timeout is an unknown outcome, not a failure — the PSP may have authorised. The payment service records the attempt as UNKNOWN and resolves it by querying the PSP with the same idempotency key or by waiting for the webhook; meanwhile the orchestrator extends the step's deadline and keeps the reservation held. If the resolution is "authorised", the saga continues; if "declined", it compensates. If the orchestrator has already cancelled by the time a late authorisation arrives, the late-reply path issues a void so the customer is never charged for a cancelled order, and daily reconciliation catches anything that slips through.

**Q: The reservation expired while payment was being authorised. How do you handle it? (Senior)**
A: The commit step is guarded — `UPDATE reservations SET status = 'committed' WHERE ... AND status = 'held' AND expires_at > now()` — so it fails visibly instead of committing stock that was already released and possibly sold to someone else. The orchestrator then tries to re-reserve; if stock is still available the order proceeds with a small delay. If not, it voids the authorisation and cancels with an apology, which is why authorisation (voidable) precedes capture. Tuning the expiry above the p99.9 authorisation time and alerting on commit-after-expiry keeps this rare.

**Q: One deal SKU gets 5,000 checkouts per second. What breaks and how do you fix it? (Senior)**
A: A single `stock` row serialises every reservation on its row lock, each held through a commit, so throughput caps around a thousand per second and everything queues behind it, including other lines in the same orders. I would split the SKU's stock into buckets — `(sku, warehouse_id, bucket)` with units spread over 16–64 rows — and have reservers pick a random non-empty bucket, so the contention spreads. In front of that, an atomic Redis counter with a Lua check-and-decrement admits only as many checkouts as there are units, shedding the losers before they reach Postgres. The database remains the source of truth, and the Redis gate is re-synced from it.

**Q: How do you restore one service's database from backup without corrupting the saga state across services? (Senior)**
A: A point-in-time restore of one service rewinds only that service, so it disagrees with the others — for example, inventory forgets reservations for orders that exist. I would restore, then replay that service's input topics from Kafka from just before the restore point; because every handler is idempotent via inbox and business keys, replaying already-applied messages is harmless and missing ones are re-applied. Then I run the reconciliation jobs — reserved vs reservations, confirmed orders vs committed stock, captured payments vs orders — and fix residual differences with compensating commands. That only works if Kafka retention exceeds the restore window, which is a DR requirement to set explicitly.

## 10. Quick Revision & Cheat Sheet

| Concern | Design |
|---|---|
| Service boundaries | Catalog (PG+JSONB, search, cache) · Cart (Redis/Dynamo, TTL) · Inventory (PG by sku) · Order (PG by customer, orchestrator) · Payment (ledger) · Shipment (PG) |
| Cross-service consistency | Orchestrated saga: reserve → authorise → confirm → commit stock → ship → capture |
| Every step | inbox dedup + guarded local change + outbox, in one local transaction |
| No oversell | `CHECK (reserved <= on_hand)` + `UPDATE ... WHERE on_hand - reserved >= q` |
| Reservations | held with `expires_at`; sweeper with `FOR UPDATE SKIP LOCKED`; commit guarded by expiry |
| State machine | transition table + guarded `UPDATE ... WHERE status = expected` + `order_events` |
| Unknown outcomes | PSP timeout = UNKNOWN; resolve before compensating; void late authorisations |
| Liveness | per-saga `deadline_at` + sweeper; every command idempotent so re-sending is safe |
| Hot SKU | stock buckets + Redis admission gate |
| Reporting | Debezium CDC → Kafka → warehouse; reconciliation jobs |

- Database-per-service means no cross-service transactions, joins or foreign keys — design for that on day one.
- Order the saga so the cheapest compensations come first and capture comes last.
- Compensation is a new forward action, guarded by current state, never a rollback.
- Every saga needs a deadline; lost messages are normal.
- Idempotency twice: by message id and by business key.
- Snapshot what you need from other services (price, title, address) into your own rows.
- If one team and one database can do it, do it that way ([Ch 31](topic.html?p=31-case-ecommerce)).

## 11. Hands-On Exercises

Lab: `docker run --name orders -e POSTGRES_PASSWORD=pw -p 5432:5432 -d postgres:17`. Create two databases, `inventory` and `ordering`, to feel the boundary.

1. **Oversell test.** Create `stock` with `on_hand = 10` for one SKU. Run `pgbench -c 50 -T 20` with a script executing the conditional reserve `UPDATE` for qty 1. Verify `reserved` ends at exactly 10 and count how many transactions updated zero rows. Then rewrite it as `SELECT` + `UPDATE` without locking and show oversell.
2. **Idempotent reserve.** Send the same `ReserveStock` command twice (same message id), then twice with different message ids for the same order line; verify `reserved` increases once in both cases.
3. **Expiry sweeper.** Insert 100 K held reservations with expiries spread over 10 minutes; run three concurrent sweepers using the `SKIP LOCKED` statement and confirm no reservation is released twice and `stock.reserved` matches the reconciliation query.
4. **Guarded transitions.** Implement the transition CTE; feed a shuffled sequence of `StockReserved`, `PaymentAuthorized`, a duplicate `PaymentAuthorized` and a late `Cancel`; assert the final state and the `order_events` history.
5. **Hot SKU buckets.** Split one SKU into 32 buckets and repeat exercise 1 with 200 clients; compare TPS and lock waits against the single-row version.

**Mini project — a working saga.** Build three tiny services (order, inventory, payment-stub) in Go or Python, each with its own Postgres database, outbox and inbox, communicating over Redpanda/Kafka. The payment stub randomly declines 10%, times out 5% (resolving later) and duplicates 5% of replies. Run 10,000 orders and assert at the end: no negative or over-reserved stock, every order is `CONFIRMED` or `CANCELLED`, every `CONFIRMED` order has committed reservations and one authorisation, and no cancelled order has a live authorisation.

## 12. Related Topics & Free Learning Resources

**Concept chapters this design applies**

- [Ch 04 · Concurrency Control](topic.html?p=04-concurrency-control) — conditional updates as compare-and-set.
- [Ch 05 · Locking Internals](topic.html?p=05-locking-internals) — hot rows, lock ordering, `SKIP LOCKED`.
- [Ch 12 · Sharding](topic.html?p=12-sharding) — inventory by SKU, orders by customer.
- [Ch 13 · Distributed Transactions](topic.html?p=13-distributed-transactions) — why sagas, not 2PC.
- [Ch 18 · High Availability](topic.html?p=18-high-availability) — synchronous replication for orders and payments.
- [Ch 21 · Database Scaling](topic.html?p=21-database-scaling) and [Ch 22 · Capacity Planning](topic.html?p=22-capacity-planning) — when to split at all.
- [Ch 26 · Backup & DR](topic.html?p=26-backup-disaster-recovery) — restores in a multi-database world.
- [Ch 28 · Data Lifecycle](topic.html?p=28-data-lifecycle) — order retention and archiving.
- [Ch 29 · Advanced Database Patterns](topic.html?p=29-advanced-database-patterns) — outbox, inbox, CDC.
- Sibling case studies: [Ch 31 · E-commerce Database](topic.html?p=31-case-ecommerce) (single-DB version), [Ch 33 · Ticket Booking](topic.html?p=33-case-ticket-booking) (holds with expiry), [Ch 39 · Payment System](topic.html?p=39-case-payment-system) (the payment step in depth).

**SQL Handbook:** [Transactions & ACID](../sql/topic.html?p=25-transactions-acid) · [Isolation Levels](../sql/topic.html?p=26-isolation-levels) · [Keys & Constraints](../sql/topic.html?p=29-keys-constraints) · [Schema Design](../sql/topic.html?p=30-schema-design)

**Other handbooks:** [System Design · Distributed Transactions](../system-design/topic.html?p=21-distributed-transactions) · [System Design · Microservices](../system-design/topic.html?p=29-microservices) · [Kafka & RabbitMQ · Idempotency & Outbox](../messaging/topic.html?p=21-idempotency-outbox) · [Kafka & RabbitMQ · Kafka Connect & CDC](../messaging/topic.html?p=25-kafka-connect-cdc) · [Caching with Redis · Pipelining, Lua & Transactions](../redis-caching/topic.html?p=22-pipelining-lua-transactions)

**Free resources**

- **Pattern: Saga** — Chris Richardson, microservices.io · *Intermediate* · orchestration vs choreography, compensations, countermeasures for lack of isolation. <https://microservices.io/patterns/data/saga.html>
- **Pattern: Database per service** — Chris Richardson, microservices.io · *Beginner* · the boundary and what it costs. <https://microservices.io/patterns/data/database-per-service.html>
- **Pattern: Transactional outbox** — Chris Richardson, microservices.io · *Intermediate* · the dual-write fix used at every step. <https://microservices.io/patterns/data/transactional-outbox.html>
- **Sagas (Garcia-Molina & Salem, SIGMOD 1987)** — ACM · *Advanced* · the original paper: long-lived transactions as sequences with compensations. <https://dl.acm.org/doi/10.1145/38713.38742>
- **Temporal Documentation** — Temporal · *Intermediate* · a durable-execution engine that implements orchestrated sagas with persisted state and timers. <https://docs.temporal.io/>
- **PostgreSQL Documentation: SELECT ... FOR UPDATE SKIP LOCKED** — PostgreSQL · *Intermediate* · the locking clause behind queue-like sweepers. <https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE>
- **Debezium Documentation** — Debezium · *Intermediate* · CDC from each service database for analytics and outbox relay. <https://debezium.io/documentation/>

---

*Database Design Handbook — chapter 38.*
