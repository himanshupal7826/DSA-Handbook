# 31 · Case Study: E-commerce Database

> **In one line:** An e-commerce data layer is a catalog you can cache aggressively wrapped around a tiny, brutally contended core — inventory and orders — where the one invariant that matters ("never sell stock you do not have") is enforced by short, conditional transactions in the database, with reservations that expire, an order state machine with guarded transitions, and payments wired in through an outbox rather than a network call inside a transaction.

---

## 1. Overview

> **Builds on:** [SQL Handbook · Schema Design](../sql/topic.html?p=30-schema-design) (entities, junction tables, basic DDL) · [Ch 04 · Concurrency Control](topic.html?p=04-concurrency-control) · [Ch 05 · Locking Internals](topic.html?p=05-locking-internals) · [Ch 29 · Advanced Database Patterns](topic.html?p=29-advanced-database-patterns). This chapter assumes you can draw the customers/orders/order_items ER diagram in your sleep, and spends its time on what the ER diagram does not show: the races, the hot rows, and the failure paths.

You are designing the data layer for a mid-to-large online store: a product catalog, a cart, checkout, payment, fulfilment and order history. The functional requirements are familiar. The interesting requirements are non-functional, and they pull in opposite directions: the **catalog** must be fast and cheap to read at enormous volume and can be a few seconds stale, while **inventory and orders** must be exactly right under concurrency — a store that oversells a limited-edition sneaker 400 times has a customer-service disaster, and a store that double-charges has a legal one.

### Requirements

**Functional:** browse and search products; view price and availability; add to cart; place an order (multi-line, multi-SKU); pay via an external payment provider; cancel before shipping; view order history; admins adjust stock and prices; flash sales ("1,000 units at 10:00").

**Non-functional:**

- **Never oversell** a SKU beyond its on-hand quantity (or beyond a configured backorder allowance).
- **Never double-charge** and never ship an unpaid order; every order ends in exactly one terminal state.
- Checkout p99 under ~300 ms excluding the payment provider; catalog p99 under ~100 ms.
- 99.95% availability for checkout; catalog degrades gracefully (serve stale) rather than fail.
- Order history retained for 7+ years (tax/audit), but only the last ~90 days are hot.

### Workload estimate

| Quantity | Estimate | Reasoning |
|---|---|---|
| Registered users | 20 M | mid-to-large retailer |
| DAU | 3 M | ~15% of registered |
| Product page views | ~120 M/day ≈ 1,400/s avg, ~7,000/s peak | 40 views per DAU, 5× diurnal peak |
| Orders | ~500 K/day ≈ 6/s avg, ~60/s peak | ~17% of DAU order; normal peak 10× avg |
| Flash-sale burst | 2,000–5,000 checkout attempts/s on **one SKU** for ~30 s | the case that actually breaks designs |
| SKUs | 10 M active | long tail; 1% of SKUs get ~50% of traffic |
| Order + items + events | ~3–4 KB per order incl. indexes | ~2.5 line items, status history, payment row |
| Order data growth | ~0.6 TB/year | 500 K × 365 × ~3.5 KB |
| Read : write | ~200 : 1 overall; ~2 : 1 on inventory rows | catalog is read-mostly, inventory is write-hot |

Two conclusions fall straight out of the table, and they drive the whole design (see [Ch 22 · Capacity Planning](topic.html?p=22-capacity-planning)). First, **60 orders/s is nothing** for one well-tuned PostgreSQL primary — a single node handles thousands of short write transactions per second. You do not need sharding for orders on day one. Second, **5,000 attempts/s on a single inventory row is a lot**, because every one of them wants an exclusive lock on the *same* row. The bottleneck is not throughput of the database; it is serialization on one tuple. That is the problem this chapter is really about.

### Why the naive schema breaks

The textbook design puts `stock INT` on the `products` table and does this in application code:

```text
1. SELECT stock FROM products WHERE id = 42;        -- reads 1
2. if stock >= qty:                                  -- app decides "ok"
3.     UPDATE products SET stock = 0 WHERE id = 42; -- writes stock - qty computed in app
4.     INSERT INTO orders ...
5.     call payment provider (800 ms)               -- inside the transaction!
6. COMMIT
```

It fails three ways at once. (1) Steps 1–3 are a **read-modify-write race**: two buyers both read `stock = 1`, both pass the check, both write `0`, and you sold two of one — the classic lost update from [Ch 04 · Concurrency Control](topic.html?p=04-concurrency-control). (2) The payment call inside the transaction holds the row lock for 800 ms, so the hot SKU can process roughly one checkout per second. (3) If the provider call succeeds and the COMMIT then fails (or the process dies), you charged a card for an order that does not exist. Fixing all three is the design.

## 2. Core Concepts

The entities are ordinary; the **invariants** are what you are actually designing for. Each one below names where it is enforced, because "the app checks it" is not an answer.

- **SKU (stock-keeping unit)** — the sellable variant (shoe, size 10, black). Inventory is tracked per SKU per warehouse, never per "product". *Why it matters:* the lock granularity is the SKU row, so that is the unit of contention.
- **on_hand** — physical units in the warehouse. Changes when goods arrive or ship.
- **reserved** — units promised to orders that are not yet shipped (or not yet paid). *Invariant I1:* `0 <= reserved <= on_hand` — enforced by a `CHECK` constraint *and* by a conditional `UPDATE`.
- **available** — `on_hand - reserved`, the number you may still sell. Derived, never stored separately (two stored numbers drift).
- **Reservation** — a row that holds `qty` of a SKU for an order until `expires_at`. *Invariant I2:* the sum of active reservations for a SKU equals `inventory.reserved` — enforced by changing both in the same transaction, and checked by a reconciliation job.
- **Order state machine** — `PENDING_PAYMENT → PAID → FULFILLING → SHIPPED → DELIVERED`, with `CANCELLED` / `EXPIRED` / `REFUNDED` exits. *Invariant I3:* transitions only along allowed edges, each exactly once — enforced by `UPDATE ... WHERE status = <expected>` (a compare-and-swap on the status column).
- **Price snapshot** — `order_items.unit_price_minor` copies the price at checkout. *Invariant I4:* an order's total never changes because the catalog price changed later.
- **Idempotency key** — client-generated key per checkout attempt. *Invariant I5:* one key produces at most one order — enforced by a `UNIQUE` constraint, not by a lookup.
- **Payment attempt** — one row per call to the provider, keyed by the provider's reference. *Invariant I6:* an order is `PAID` only if a captured payment for exactly its total exists — enforced by doing both writes in one transaction when the webhook arrives.
- **Outbox** — the table that turns "commit the order and tell other services" into one atomic write (see [Kafka & RabbitMQ · Idempotency & Outbox](../messaging/topic.html?p=21-idempotency-outbox)). *Why it matters:* it removes every network call from inside the critical transaction.
- **Money as integer minor units** — `BIGINT` cents (or `NUMERIC(19,4)`), plus a currency code. Never `float`/`double precision`.

## 3. Theory & Principles

### Access patterns, ranked

Design tables for the queries, not for the diagram. Ranked by frequency at peak:

| # | Access pattern | Rate (peak) | Consistency need | Served from |
|---|---|---|---|---|
| 1 | Product page: details + price + "in stock?" | ~7,000/s | stale OK (seconds) | cache / search index, fed by CDC |
| 2 | Search and category listing | ~3,000/s | stale OK | search engine (not Postgres) |
| 3 | Cart read/write | ~1,500/s | per-user, read-your-writes | Redis or a `carts` table keyed by user |
| 4 | Reserve inventory at checkout | ~60/s (5,000/s flash) | **strong, linearizable per SKU** | Postgres primary |
| 5 | Create order + items | ~60/s | **strong, atomic with #4** | Postgres primary |
| 6 | Payment webhook → mark paid | ~60/s | **strong, idempotent** | Postgres primary |
| 7 | "My orders" list | ~300/s | read-your-writes for own orders | primary for 30 s after a write, replica otherwise |
| 8 | Expire stale reservations | batch, every few s | strong | Postgres primary |
| 9 | Admin / analytics reports | low | stale OK (minutes) | replica or warehouse |

The ranking tells you where to spend your consistency budget (see [Ch 10 · Consistency Models](topic.html?p=10-consistency-models)). Patterns 1–3 are 95% of traffic and tolerate staleness, so they never touch the primary. Patterns 4–6 are under 1% of traffic but carry every invariant, so they get the primary, short transactions, and conditional writes.

### Consistency boundaries

The **strong boundary** is drawn tightly around three tables: `inventory`, `orders` (+ items + reservations), and `payments`. Inside it, one PostgreSQL primary gives you ACID transactions across all three — which is the single biggest reason not to split inventory and orders into separate databases early. The display "In stock" badge on the product page lives *outside* the boundary: it is a cached, eventually-consistent hint, and the checkout transaction is the only thing allowed to say yes. A shopper may see "In stock" and then get "Sorry, just sold out" at checkout; that is a correct, acceptable outcome. The reverse — "Order confirmed" followed by "we oversold" — is not.

### Three ways to decrement stock correctly

All three are correct; they differ in lock hold time, throughput on a hot row, and what they cost you elsewhere.

**(A) Atomic conditional decrement.** One statement does the check and the write: `UPDATE inventory SET reserved = reserved + $q WHERE sku_id = $s AND on_hand - reserved >= $q`. In READ COMMITTED, if a concurrent transaction updated the row first, PostgreSQL waits for it, then **re-evaluates the WHERE clause against the newest committed version** (EvalPlanQual) — so the second buyer sees the decremented value and the predicate correctly fails. Zero rows updated means "sold out". No explicit lock, no retry loop, shortest possible hold time.

**(B) SELECT ... FOR UPDATE, then decide.** Lock the row, read it, run arbitrary application logic (backorder rules, per-customer limits, bundle logic), then UPDATE. Correct because the lock serializes deciders, but the lock is held across an application round trip — typically 1–5 ms instead of ~0.1 ms — which cuts peak throughput on a hot SKU several-fold. Use it when the decision cannot be expressed as a single predicate.

**(C) Reservations with expiry.** Either A or B is used to move units from *available* into *reserved*, and a separate `inventory_reservations` row records who holds them until when. Payment success converts the reservation into a real decrement; expiry or cancellation releases it. This is what you want anyway, because payment happens *after* reservation and can fail or be abandoned.

```svg
<svg viewBox="0 0 860 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs><marker id="c31a1" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#334155"/></marker></defs>
  <text x="430" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Two buyers, one unit left: naive read-modify-write vs atomic conditional UPDATE</text>
  <rect x="20" y="40" width="400" height="370" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="220" y="62" text-anchor="middle" fill="#991b1b" font-size="12" font-weight="bold">Naive: SELECT, check in app, UPDATE</text>
  <line x1="120" y1="80" x2="120" y2="395" stroke="#94a3b8"/><line x1="320" y1="80" x2="320" y2="395" stroke="#94a3b8"/>
  <text x="120" y="92" text-anchor="middle" fill="#1e293b" font-weight="bold">Buyer T1</text><text x="320" y="92" text-anchor="middle" fill="#1e293b" font-weight="bold">Buyer T2</text>
  <rect x="45" y="110" width="150" height="26" rx="4" fill="#ffffff" stroke="#94a3b8"/><text x="120" y="127" text-anchor="middle" fill="#334155">SELECT available = 1</text>
  <rect x="245" y="145" width="150" height="26" rx="4" fill="#ffffff" stroke="#94a3b8"/><text x="320" y="162" text-anchor="middle" fill="#334155">SELECT available = 1</text>
  <rect x="45" y="185" width="150" height="26" rx="4" fill="#ffffff" stroke="#94a3b8"/><text x="120" y="202" text-anchor="middle" fill="#334155">1 &gt;= 1 so OK</text>
  <rect x="245" y="220" width="150" height="26" rx="4" fill="#ffffff" stroke="#94a3b8"/><text x="320" y="237" text-anchor="middle" fill="#334155">1 &gt;= 1 so OK</text>
  <rect x="45" y="260" width="150" height="26" rx="4" fill="#ffffff" stroke="#94a3b8"/><text x="120" y="277" text-anchor="middle" fill="#334155">SET available = 0</text>
  <rect x="245" y="295" width="150" height="26" rx="4" fill="#ffffff" stroke="#94a3b8"/><text x="320" y="312" text-anchor="middle" fill="#334155">SET available = 0</text>
  <text x="220" y="355" text-anchor="middle" fill="#991b1b" font-weight="bold">Both commit. 2 orders, 1 unit.</text>
  <text x="220" y="375" text-anchor="middle" fill="#991b1b">T2 wrote a value computed from a stale read</text>
  <text x="220" y="392" text-anchor="middle" fill="#991b1b">(lost update; READ COMMITTED does not prevent it)</text>
  <rect x="440" y="40" width="400" height="370" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="640" y="62" text-anchor="middle" fill="#14532d" font-size="12" font-weight="bold">Atomic: check lives in the WHERE clause</text>
  <line x1="540" y1="80" x2="540" y2="395" stroke="#94a3b8"/><line x1="740" y1="80" x2="740" y2="395" stroke="#94a3b8"/>
  <text x="540" y="92" text-anchor="middle" fill="#1e293b" font-weight="bold">Buyer T1</text><text x="740" y="92" text-anchor="middle" fill="#1e293b" font-weight="bold">Buyer T2</text>
  <rect x="455" y="110" width="170" height="38" rx="4" fill="#ffffff" stroke="#16a34a"/><text x="540" y="126" text-anchor="middle" fill="#334155">UPDATE ... WHERE</text><text x="540" y="140" text-anchor="middle" fill="#334155">on_hand - reserved &gt;= 1</text>
  <text x="540" y="166" text-anchor="middle" fill="#166534">1 row, holds row lock</text>
  <rect x="655" y="130" width="170" height="38" rx="4" fill="#ffffff" stroke="#d97706"/><text x="740" y="146" text-anchor="middle" fill="#334155">same UPDATE</text><text x="740" y="160" text-anchor="middle" fill="#92400e">blocks on T1 row lock</text>
  <rect x="455" y="190" width="170" height="26" rx="4" fill="#ffffff" stroke="#16a34a"/><text x="540" y="207" text-anchor="middle" fill="#334155">INSERT order, COMMIT</text>
  <path d="M625,216 L700,245" stroke="#334155" stroke-width="1.5" marker-end="url(#c31a1)"/>
  <rect x="655" y="248" width="170" height="52" rx="4" fill="#ffffff" stroke="#16a34a"/><text x="740" y="265" text-anchor="middle" fill="#334155">wakes, re-checks WHERE</text><text x="740" y="279" text-anchor="middle" fill="#334155">on NEW row version</text><text x="740" y="293" text-anchor="middle" fill="#166534">0 &gt;= 1 false: 0 rows</text>
  <rect x="655" y="312" width="170" height="26" rx="4" fill="#ffffff" stroke="#16a34a"/><text x="740" y="329" text-anchor="middle" fill="#334155">ROLLBACK: "sold out"</text>
  <text x="640" y="365" text-anchor="middle" fill="#14532d" font-weight="bold">Exactly 1 order. No retry loop, no explicit lock.</text>
  <text x="640" y="385" text-anchor="middle" fill="#14532d">Lock held only for the statement + commit</text>
</svg>
```

> **Why this matters:** the atomic UPDATE is not "faster SELECT FOR UPDATE". It moves the invariant check into the database, where it is evaluated against the latest committed row under the row lock. Anything the application decides from a value it read earlier is a race unless something holds that value still.

### The hot-row ceiling

Every correct design above serializes buyers of the same SKU on one tuple. The ceiling is roughly `1 / (lock hold time)`. With an atomic UPDATE plus a synchronous-commit fsync, the hold time is on the order of a millisecond or two — so a single inventory row tops out somewhere in the high hundreds to low thousands of reservations per second, and far less if the transaction does anything slow while holding the lock. A flash sale at 5,000 attempts/s therefore needs either a shorter critical section, **more rows** (sharded inventory buckets), or a **gate in front of the database** (Redis pre-decrement, a queue). Section 4 shows all three.

## 4. Architecture & Workflow

### Data architecture

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs><marker id="c31b1" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#2563eb"/></marker><marker id="c31b2" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#16a34a"/></marker></defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">E-commerce data layer: one strong core, everything else derived</text>
  <rect x="20" y="45" width="120" height="40" rx="6" fill="#f1f5f9" stroke="#94a3b8"/><text x="80" y="70" text-anchor="middle" fill="#1e293b">Web / app</text>
  <rect x="190" y="45" width="150" height="40" rx="6" fill="#dbeafe" stroke="#2563eb"/><text x="265" y="63" text-anchor="middle" fill="#1e3a8a" font-weight="bold">Catalog API</text><text x="265" y="77" text-anchor="middle" fill="#1e3a8a" font-size="9">reads only</text>
  <rect x="190" y="130" width="150" height="40" rx="6" fill="#dbeafe" stroke="#2563eb"/><text x="265" y="148" text-anchor="middle" fill="#1e3a8a" font-weight="bold">Checkout service</text><text x="265" y="162" text-anchor="middle" fill="#1e3a8a" font-size="9">owns orders + inventory</text>
  <rect x="190" y="215" width="150" height="40" rx="6" fill="#dbeafe" stroke="#2563eb"/><text x="265" y="233" text-anchor="middle" fill="#1e3a8a" font-weight="bold">Payment service</text><text x="265" y="247" text-anchor="middle" fill="#1e3a8a" font-size="9">owns payments</text>
  <path d="M140,65 L188,65" stroke="#2563eb" stroke-width="1.5" marker-end="url(#c31b1)"/>
  <path d="M140,75 L188,145" stroke="#2563eb" stroke-width="1.5" marker-end="url(#c31b1)"/>
  <rect x="400" y="40" width="160" height="50" rx="6" fill="#fef3c7" stroke="#d97706"/><text x="480" y="60" text-anchor="middle" fill="#78350f" font-weight="bold">Redis</text><text x="480" y="75" text-anchor="middle" fill="#92400e" font-size="9">product cache, carts, flash gate</text>
  <rect x="400" y="115" width="200" height="160" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="500" y="135" text-anchor="middle" fill="#14532d" font-weight="bold">PostgreSQL primary</text>
  <text x="500" y="150" text-anchor="middle" fill="#166534" font-size="9">the strong consistency boundary</text>
  <rect x="415" y="160" width="80" height="22" rx="3" fill="#ffffff" stroke="#16a34a"/><text x="455" y="175" text-anchor="middle" fill="#14532d" font-size="9">inventory</text>
  <rect x="505" y="160" width="80" height="22" rx="3" fill="#ffffff" stroke="#16a34a"/><text x="545" y="175" text-anchor="middle" fill="#14532d" font-size="9">reservations</text>
  <rect x="415" y="188" width="80" height="22" rx="3" fill="#ffffff" stroke="#16a34a"/><text x="455" y="203" text-anchor="middle" fill="#14532d" font-size="9">orders, items</text>
  <rect x="505" y="188" width="80" height="22" rx="3" fill="#ffffff" stroke="#16a34a"/><text x="545" y="203" text-anchor="middle" fill="#14532d" font-size="9">payments</text>
  <rect x="415" y="216" width="170" height="22" rx="3" fill="#ffffff" stroke="#7c3aed"/><text x="500" y="231" text-anchor="middle" fill="#5b21b6" font-size="9">outbox (same transaction)</text>
  <text x="500" y="260" text-anchor="middle" fill="#166534" font-size="9">catalog tables live here too</text>
  <path d="M340,150 L398,170" stroke="#16a34a" stroke-width="2" marker-end="url(#c31b2)"/>
  <path d="M340,235 L398,210" stroke="#16a34a" stroke-width="2" marker-end="url(#c31b2)"/>
  <path d="M340,60 L398,62" stroke="#2563eb" stroke-width="1.5" marker-end="url(#c31b1)"/>
  <rect x="660" y="115" width="200" height="45" rx="6" fill="#ede9fe" stroke="#7c3aed"/><text x="760" y="135" text-anchor="middle" fill="#5b21b6" font-weight="bold">Kafka</text><text x="760" y="150" text-anchor="middle" fill="#5b21b6" font-size="9">OrderPlaced, OrderPaid, StockChanged</text>
  <path d="M600,225 L658,145" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#c31b1)"/>
  <text x="640" y="200" fill="#5b21b6" font-size="9">CDC relay</text>
  <rect x="660" y="190" width="200" height="36" rx="6" fill="#f1f5f9" stroke="#94a3b8"/><text x="760" y="212" text-anchor="middle" fill="#1e293b">Search index (availability hint)</text>
  <rect x="660" y="236" width="200" height="36" rx="6" fill="#f1f5f9" stroke="#94a3b8"/><text x="760" y="258" text-anchor="middle" fill="#1e293b">Fulfilment, email, analytics</text>
  <path d="M760,160 L760,188" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#c31b1)"/>
  <rect x="400" y="310" width="200" height="40" rx="6" fill="#f1f5f9" stroke="#94a3b8"/><text x="500" y="328" text-anchor="middle" fill="#1e293b">2 async read replicas</text><text x="500" y="342" text-anchor="middle" fill="#334155" font-size="9">order history, admin, reports</text>
  <path d="M500,275 L500,308" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#c31b1)"/>
  <rect x="660" y="300" width="200" height="50" rx="6" fill="#fee2e2" stroke="#dc2626"/><text x="760" y="320" text-anchor="middle" fill="#991b1b" font-weight="bold">Payment provider</text><text x="760" y="336" text-anchor="middle" fill="#991b1b" font-size="9">called OUTSIDE any DB txn</text>
  <path d="M340,245 C 500,380 600,360 658,330" stroke="#dc2626" stroke-width="1.5" fill="none" marker-end="url(#c31b1)"/>
  <path d="M660,340 C 560,420 380,400 300,258" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="4 3" fill="none" marker-end="url(#c31b1)"/>
  <text x="470" y="410" fill="#991b1b" font-size="9">webhook (at-least-once) back to payment service</text>
  <text x="20" y="440" fill="#1e293b" font-weight="bold">Write path:</text><text x="100" y="440" fill="#334155">checkout txn (reserve + order + outbox) then payment call then webhook txn (payment + PAID + outbox)</text>
  <text x="20" y="458" fill="#1e293b" font-weight="bold">Read path:</text><text x="100" y="458" fill="#334155">catalog from Redis/search (stale OK); "my orders" from primary for 30 s after a write, replica otherwise</text>
</svg>
```

The service boundary matches the consistency boundary: the **checkout service owns `inventory`, `inventory_reservations`, `orders` and `order_items`** and is the only writer to them. The payment service owns `payments`; in a single-database deployment both live in the same PostgreSQL cluster, which is fine and lets the "mark paid" step be one local transaction. If you later split payments into its own database, the handoff becomes an event-driven saga (see [Ch 13 · Distributed Transactions](topic.html?p=13-distributed-transactions)), and the outbox is already in place.

### The checkout flow, step by step

```text
t=0     client POST /checkout  Idempotency-Key: 7f3c...  (cart snapshot)
t=2ms   TXN 1 (checkout service, ~3-8 ms total)
          INSERT orders(... status='PENDING_PAYMENT', idem_key) ON CONFLICT DO NOTHING
          for each line, sorted by (sku_id, warehouse_id):
             UPDATE inventory SET reserved = reserved + q
              WHERE sku_id=? AND warehouse_id=? AND on_hand - reserved >= q
             -> 0 rows? ROLLBACK, return "out of stock: sku X"
             INSERT inventory_reservations(..., expires_at = now() + 15 min)
          INSERT order_items (price snapshot)
          INSERT outbox('OrderPlaced')
        COMMIT
t=10ms  create payment intent at provider (idempotency key = order_id)  -- no DB txn open
t=900ms provider returns client secret; user completes 3-DS in browser
t=40s   webhook payment_intent.succeeded (may arrive 2+ times, may arrive late)
        TXN 2 (~2-5 ms)
          INSERT payments(provider_ref UNIQUE, ...) ON CONFLICT DO NOTHING
          UPDATE orders SET status='PAID' WHERE id=? AND status='PENDING_PAYMENT'
          UPDATE inventory_reservations SET status='CONSUMED' WHERE order_id=? AND status='ACTIVE'
          UPDATE inventory SET on_hand = on_hand - q, reserved = reserved - q  (per line)
          INSERT outbox('OrderPaid')
        COMMIT
t=15min (if never paid) sweeper: reservation ACTIVE and expires_at < now()
          -> release reserved units, order -> EXPIRED  (same guarded transitions)
```

Two properties to notice. **No transaction spans a network call.** The provider is called between TXN 1 and TXN 2, and a crash anywhere leaves a state the system can recover from (a pending order with an active reservation that either gets paid or expires). And **every write in TXN 2 is guarded**, so a duplicate webhook is a no-op and a webhook racing the expiry sweeper has exactly one winner.

### Order state machine

```text
                   +-------------------- cancel (user) ------------------+
                   |                                                     v
  PENDING_PAYMENT --pay ok--> PAID --pick--> FULFILLING --ship--> SHIPPED --> DELIVERED
        |                      |                                    |
        | reservation expired  +--cancel before pick--> CANCELLED   +--return--> RETURNED --> REFUNDED
        v                                     (refund issued)
     EXPIRED
```

Every arrow is one `UPDATE orders SET status = $to, version = version + 1 WHERE id = $id AND status = $from`. Zero rows means someone else moved the order first — you re-read and decide, you never overwrite. Allowed edges live in a small `order_transitions` table (or a `CHECK` via trigger) so an application bug cannot jump `PENDING_PAYMENT → SHIPPED`.

### Flash sale: protecting the hot row

A flash sale on one SKU is an intentional hot key. The layered defence, cheapest first:

1. **Keep the critical section tiny.** Only the conditional UPDATE and the reservation insert touch the hot row, and they run *last* in the transaction (after the order row insert), so the lock is held for the shortest time before COMMIT. With the row lock held for ~1 ms, one row sustains on the order of several hundred to ~1,000 reservations per second.
2. **Shard the inventory row into buckets.** Split 10,000 units across N rows `(sku_id, bucket)`; each buyer picks a random bucket and falls back to others if it is empty. N buckets ≈ N× the throughput, at the cost of a "sold out" check that must look at all buckets and a small chance of a false "sold out" when the chosen buckets are empty but others are not (fall back before giving up).
3. **Gate in Redis, commit in Postgres.** Pre-load `stock:sku:42 = 10000` into Redis; each attempt runs an atomic Lua `DECRBY`-if-positive. Only the ~10,000 winners proceed to the Postgres transaction, so the database sees 10,000 checkouts over a few minutes, not 5,000/s of mostly-failing attempts. **The database stays the source of truth**: Redis can over-admit (after a failover that lost a write) and the conditional UPDATE still rejects; Redis can under-admit (a winner abandons) and a reconciliation job returns units to the gate.
4. **Waiting room / queue.** Beyond that, admit users through a token queue so arrival rate never exceeds what the core can serve (the same idea as [Ch 33 · Ticket Booking](topic.html?p=33-case-ticket-booking)).

## 5. Implementation

### Core schema (PostgreSQL 16/17)

```sql
CREATE TABLE customers (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE skus (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id    BIGINT NOT NULL,
  sku_code      TEXT NOT NULL UNIQUE,
  price_minor   BIGINT NOT NULL CHECK (price_minor >= 0),   -- cents, never float
  currency      CHAR(3) NOT NULL,
  attrs         JSONB NOT NULL DEFAULT '{}'                  -- size/colour; catalog detail
);

-- The hot table. Narrow on purpose: fewer bytes per version, more HOT updates.
CREATE TABLE inventory (
  sku_id        BIGINT NOT NULL REFERENCES skus(id),
  warehouse_id  INT    NOT NULL,
  on_hand       INT    NOT NULL CHECK (on_hand >= 0),
  reserved      INT    NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (sku_id, warehouse_id),
  CONSTRAINT reserved_le_on_hand CHECK (reserved <= on_hand)   -- invariant I1
) WITH (fillfactor = 70);   -- leave room on the page for HOT updates (no index column changes)

CREATE TABLE orders (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id     BIGINT NOT NULL REFERENCES customers(id),
  idempotency_key UUID   NOT NULL,
  status          TEXT   NOT NULL DEFAULT 'PENDING_PAYMENT',
  total_minor     BIGINT NOT NULL CHECK (total_minor >= 0),
  currency        CHAR(3) NOT NULL,
  version         INT    NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT orders_idem UNIQUE (customer_id, idempotency_key),              -- invariant I5
  CONSTRAINT orders_status_chk CHECK (status IN ('PENDING_PAYMENT','PAID','FULFILLING',
      'SHIPPED','DELIVERED','CANCELLED','EXPIRED','RETURNED','REFUNDED'))
);
CREATE INDEX orders_customer_recent ON orders (customer_id, created_at DESC);   -- "my orders"
CREATE INDEX orders_open ON orders (status, created_at)
  WHERE status IN ('PENDING_PAYMENT','PAID','FULFILLING');                     -- ops queues stay small

CREATE TABLE order_items (
  order_id          BIGINT NOT NULL REFERENCES orders(id),
  line_no           SMALLINT NOT NULL,
  sku_id            BIGINT NOT NULL,
  warehouse_id      INT    NOT NULL,
  qty               INT    NOT NULL CHECK (qty > 0),
  unit_price_minor  BIGINT NOT NULL,          -- snapshot at checkout: invariant I4
  PRIMARY KEY (order_id, line_no)
);

CREATE TABLE inventory_reservations (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id      BIGINT NOT NULL REFERENCES orders(id),
  sku_id        BIGINT NOT NULL,
  warehouse_id  INT    NOT NULL,
  qty           INT    NOT NULL CHECK (qty > 0),
  status        TEXT   NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CONSUMED','RELEASED')),
  expires_at    TIMESTAMPTZ NOT NULL,
  UNIQUE (order_id, sku_id, warehouse_id)
);
-- The sweeper's only query: tiny partial index, only live reservations.
CREATE INDEX resv_expiring ON inventory_reservations (expires_at) WHERE status = 'ACTIVE';

CREATE TABLE payments (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id       BIGINT NOT NULL REFERENCES orders(id),
  provider       TEXT   NOT NULL,
  provider_ref   TEXT   NOT NULL,           -- e.g. the payment intent id
  status         TEXT   NOT NULL,           -- AUTHORIZED / CAPTURED / FAILED / REFUNDED
  amount_minor   BIGINT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_ref)            -- duplicate webhooks collapse here
);

CREATE TABLE outbox (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  aggregate   TEXT NOT NULL,
  agg_id      BIGINT NOT NULL,
  event_type  TEXT NOT NULL,
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Why these indexes and no others: `orders_customer_recent` serves access pattern #7 as an index range scan in `created_at DESC` order; `orders_open` is a **partial index** so the operations dashboards and the fulfilment poller scan thousands of open orders, not hundreds of millions of delivered ones; `resv_expiring` is partial for the same reason. `inventory` has *only* its primary key, because every additional index on a table updated thousands of times a second multiplies write cost and blocks HOT updates (see [Ch 02 · Storage Internals](topic.html?p=02-storage-internals) and [Ch 03 · MVCC](topic.html?p=03-mvcc)).

### Critical transaction 1: place order and reserve stock

```sql
BEGIN;  -- READ COMMITTED is enough: every check is inside a conditional write

-- (1) Idempotent order header. A retry with the same key returns the existing order.
INSERT INTO orders (customer_id, idempotency_key, total_minor, currency)
VALUES ($1, $2, $3, 'USD')
ON CONFLICT (customer_id, idempotency_key) DO NOTHING
RETURNING id;
-- no row returned => this key already produced an order: ROLLBACK and return that order

-- (2) Items first (no locks on shared rows yet).
INSERT INTO order_items (order_id, line_no, sku_id, warehouse_id, qty, unit_price_minor)
SELECT $order_id, l.line_no, l.sku_id, l.wh, l.qty, s.price_minor
FROM   unnest($4::bigint[], $5::int[], $6::int[], $7::smallint[]) AS l(sku_id, wh, qty, line_no)
JOIN   skus s ON s.id = l.sku_id;

-- (3) Reserve, one line at a time, in (sku_id, warehouse_id) order to avoid deadlocks
--     between two carts containing the same two SKUs in different orders.
UPDATE inventory
   SET reserved = reserved + $qty, updated_at = now()
 WHERE sku_id = $sku AND warehouse_id = $wh
   AND on_hand - reserved >= $qty;
-- 0 rows => out of stock => ROLLBACK (releases every earlier reservation automatically)

INSERT INTO inventory_reservations (order_id, sku_id, warehouse_id, qty, expires_at)
VALUES ($order_id, $sku, $wh, $qty, now() + interval '15 minutes');

-- (4) Tell the world, atomically with the data.
INSERT INTO outbox (aggregate, agg_id, event_type, payload)
VALUES ('order', $order_id, 'OrderPlaced', jsonb_build_object('order_id', $order_id));
COMMIT;
```

Notice the ordering inside the transaction: the hot-row UPDATEs come **after** the order and item inserts, so the row locks on popular SKUs are held only from the UPDATE to COMMIT. The sort by `(sku_id, warehouse_id)` is the lock-ordering rule from [Ch 05 · Locking Internals](topic.html?p=05-locking-internals): two transactions that lock the same set of rows in the same order cannot deadlock on them.

> **MySQL difference:** in InnoDB the same conditional `UPDATE ... WHERE on_hand - reserved >= ?` is safe too — UPDATE is a locking read that sees the latest committed version, even under the default REPEATABLE READ. What bites MySQL users is doing a *plain* `SELECT` first under REPEATABLE READ: it reads the transaction's snapshot, which can be older than what the subsequent UPDATE sees, so application logic based on it is stale. Put the check in the UPDATE in both engines.

### Critical transaction 2: payment webhook marks the order paid

```sql
BEGIN;
INSERT INTO payments (order_id, provider, provider_ref, status, amount_minor)
VALUES ($order_id, 'stripe', $intent_id, 'CAPTURED', $amount)
ON CONFLICT (provider, provider_ref) DO NOTHING
RETURNING id;
-- no row => duplicate webhook: COMMIT and return 200 (idempotent no-op)

UPDATE orders
   SET status = 'PAID', version = version + 1, updated_at = now()
 WHERE id = $order_id AND status = 'PENDING_PAYMENT' AND total_minor = $amount;
-- 0 rows => order already EXPIRED/CANCELLED (payment raced the sweeper) or amount mismatch:
--           keep the payment row, enqueue a refund via outbox, COMMIT

-- Convert reservations into real stock movement (guarded: only ACTIVE ones, once).
WITH consumed AS (
  UPDATE inventory_reservations
     SET status = 'CONSUMED'
   WHERE order_id = $order_id AND status = 'ACTIVE'
  RETURNING sku_id, warehouse_id, qty
)
UPDATE inventory i
   SET on_hand = i.on_hand - c.qty, reserved = i.reserved - c.qty, updated_at = now()
  FROM consumed c
 WHERE i.sku_id = c.sku_id AND i.warehouse_id = c.warehouse_id;

INSERT INTO outbox (aggregate, agg_id, event_type, payload)
VALUES ('order', $order_id, 'OrderPaid', jsonb_build_object('order_id', $order_id));
COMMIT;
```

A design choice hides in the last UPDATE: some shops decrement `on_hand` at **payment** time (as above) and some at **shipment** time (leaving the units `reserved` until the warehouse scans them). Decrement-at-ship keeps `on_hand` equal to physical stock, which is what the warehouse team expects; decrement-at-pay keeps `reserved` small. Pick one and document it — mixing them is how reconciliation reports go red.

### Critical transaction 3: the expiry sweeper

```sql
-- Runs every ~5 s. SKIP LOCKED lets several sweeper replicas run without blocking each other
-- or a webhook transaction that is currently consuming the same reservation.
WITH expired AS (
  SELECT id FROM inventory_reservations
   WHERE status = 'ACTIVE' AND expires_at < now()
   ORDER BY expires_at
   LIMIT 500
   FOR UPDATE SKIP LOCKED
), released AS (
  UPDATE inventory_reservations r SET status = 'RELEASED'
    FROM expired e WHERE r.id = e.id AND r.status = 'ACTIVE'
  RETURNING r.order_id, r.sku_id, r.warehouse_id, r.qty
), stock AS (
  UPDATE inventory i SET reserved = i.reserved - s.qty, updated_at = now()
    FROM (SELECT sku_id, warehouse_id, sum(qty) AS qty FROM released GROUP BY 1, 2) s
   WHERE i.sku_id = s.sku_id AND i.warehouse_id = s.warehouse_id
)
UPDATE orders o SET status = 'EXPIRED', version = version + 1, updated_at = now()
  FROM (SELECT DISTINCT order_id FROM released) x
 WHERE o.id = x.order_id AND o.status = 'PENDING_PAYMENT';
```

The `GROUP BY` before touching `inventory` matters: two expiring reservations for the same SKU must become one UPDATE of that row, because PostgreSQL's `UPDATE ... FROM` updates each target row at most once and silently ignores the extra join matches.

### Application code: checkout with retries (Go)

```go
// PlaceOrder runs the reservation transaction with bounded retries on transient
// conflicts. Lines are sorted so every transaction locks inventory rows in the
// same order; out-of-stock is a business result, not an error to retry.
func PlaceOrder(ctx context.Context, db *pgxpool.Pool, cust int64, key uuid.UUID, lines []Line) (int64, error) {
	sort.Slice(lines, func(i, j int) bool {
		if lines[i].SKU != lines[j].SKU {
			return lines[i].SKU < lines[j].SKU
		}
		return lines[i].WH < lines[j].WH
	})
	for attempt := 0; attempt < 3; attempt++ {
		id, err := placeOnce(ctx, db, cust, key, lines)
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && (pgErr.Code == "40P01" || pgErr.Code == "40001") {
			time.Sleep(time.Duration(10*(attempt+1)+rand.Intn(20)) * time.Millisecond) // jittered backoff
			continue
		}
		return id, err // success, ErrOutOfStock, or a real error
	}
	return 0, ErrBusy
}

func placeOnce(ctx context.Context, db *pgxpool.Pool, cust int64, key uuid.UUID, lines []Line) (int64, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second) // never hold hot-row locks for long
	defer cancel()
	tx, err := db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx) // no-op after Commit

	var orderID int64
	err = tx.QueryRow(ctx, `INSERT INTO orders (customer_id, idempotency_key, total_minor, currency)
		VALUES ($1,$2,$3,'USD') ON CONFLICT (customer_id, idempotency_key) DO NOTHING RETURNING id`,
		cust, key, total(lines)).Scan(&orderID)
	if errors.Is(err, pgx.ErrNoRows) {
		return existingOrder(ctx, db, cust, key) // retried request: same answer as the first time
	} else if err != nil {
		return 0, err
	}
	if err := insertItems(ctx, tx, orderID, lines); err != nil {
		return 0, err
	}
	for _, l := range lines { // hot rows last, in sorted order
		tag, err := tx.Exec(ctx, `UPDATE inventory SET reserved = reserved + $1, updated_at = now()
			WHERE sku_id = $2 AND warehouse_id = $3 AND on_hand - reserved >= $1`, l.Qty, l.SKU, l.WH)
		if err != nil {
			return 0, err
		}
		if tag.RowsAffected() == 0 {
			return 0, &OutOfStockError{SKU: l.SKU} // deferred Rollback releases earlier lines
		}
		if _, err := tx.Exec(ctx, `INSERT INTO inventory_reservations (order_id, sku_id, warehouse_id, qty, expires_at)
			VALUES ($1,$2,$3,$4, now() + interval '15 minutes')`, orderID, l.SKU, l.WH, l.Qty); err != nil {
			return 0, err
		}
	}
	if _, err := tx.Exec(ctx, `INSERT INTO outbox (aggregate, agg_id, event_type, payload)
		VALUES ('order', $1, 'OrderPlaced', jsonb_build_object('order_id', $1::bigint))`, orderID); err != nil {
		return 0, err
	}
	return orderID, tx.Commit(ctx)
}
```

### Flash-sale gate in Redis (Lua)

```lua
-- KEYS[1] = stock:sku:{42}   ARGV[1] = qty
-- Atomic: decrement only if enough remains. Runs single-threaded inside Redis.
local left = tonumber(redis.call('GET', KEYS[1]) or '0')
local q = tonumber(ARGV[1])
if left >= q then
  return redis.call('DECRBY', KEYS[1], q)   -- winner: proceed to the Postgres transaction
end
return -1                                    -- loser: "sold out" without touching Postgres
```

If the Postgres transaction for a Redis winner fails (payment abandoned, reservation expired), the release path does `INCRBY stock:sku:{42} q` so the unit returns to the gate; a reconciliation job every minute resets the gate to `on_hand - reserved` from Postgres to erase drift. The gate is an **admission filter**, never the ledger — see [Caching with Redis · Pipelining, Lua & Transactions](../redis-caching/topic.html?p=22-pipelining-lua-transactions) and [Caching with Redis · Hot Keys & Avalanche](../redis-caching/topic.html?p=17-hot-keys-avalanche).

### Checking the invariants in production

```sql
-- I2: reserved column equals the sum of ACTIVE reservations (run on a replica, alert on any row)
SELECT i.sku_id, i.warehouse_id, i.reserved, coalesce(r.active, 0) AS active_resv
FROM inventory i
LEFT JOIN (SELECT sku_id, warehouse_id, sum(qty) AS active
             FROM inventory_reservations WHERE status = 'ACTIVE'
            GROUP BY 1, 2) r USING (sku_id, warehouse_id)
WHERE i.reserved <> coalesce(r.active, 0);

-- Who is waiting on the hot SKU right now?
SELECT pid, wait_event_type, wait_event, now() - xact_start AS xact_age, left(query, 60)
FROM pg_stat_activity
WHERE wait_event_type = 'Lock' ORDER BY xact_age DESC;
```

## 6. Advantages, Disadvantages & Trade-offs

| Decision | Chosen | Rejected alternative | Why |
|---|---|---|---|
| Stock decrement | Atomic conditional UPDATE | SELECT then UPDATE in app | the app version is a lost-update race |
| Complex stock rules | SELECT ... FOR UPDATE (only when needed) | SERIALIZABLE everywhere | FOR UPDATE is targeted; SSI would abort-and-retry hot transactions en masse |
| Payment-time stock | Reservation with `expires_at` | Decrement at order creation, no expiry | abandoned carts would lock stock forever |
| Expiry | Sweeper + guarded transitions | Lazy expiry on read only | `reserved` column must actually go down or availability never recovers |
| Payment integration | Outbox + webhook txn | Call provider inside the txn | a network call holding row locks kills throughput and creates charge-without-order |
| Inventory & orders | Same database | Separate "inventory service" DB | cross-DB reserve + order needs a saga; same DB gives one ACID transaction |
| Flash sales | Redis gate + DB as truth | Redis as the only stock counter | Redis failover can lose acknowledged writes; the DB constraint is the last line |
| Order IDs | `BIGINT` identity (later Snowflake-style) | Random UUIDv4 PK | v4 scatters inserts across the B-tree; use UUIDv7 or bigint |

### When to use this design

- A single-region store up to tens of thousands of orders per minute: one PostgreSQL primary with replicas, the reservation model, and an outbox is enough, and it is simple to operate.
- Any catalog where overselling is costly (limited stock, regulated goods, tickets-like drops).

### When NOT to use it

- **Marketplace with millions of sellers and independent inventories** (Amazon-scale): you will shard by seller or by order id and move inventory into its own service — see [Ch 38 · Amazon-like Order System](topic.html?p=38-case-order-system).
- **Digital goods with unlimited stock**: skip reservations entirely; the invariant disappears.
- **Deliberate overselling allowed** (airline-style overbooking, backorders): model an `allow_backorder` limit and change the predicate, but keep the conditional write.

## 7. Common Mistakes & Best Practices

**Mistake: checking stock with a SELECT and deciding in the application.** People do it because it reads naturally. It hurts because READ COMMITTED gives each statement a fresh snapshot but nothing holds the value between your SELECT and your UPDATE, so two buyers both pass. Instead, put the predicate in the UPDATE, or lock with `FOR UPDATE` first. Raising the isolation level to REPEATABLE READ is not the fix it looks like: PostgreSQL would then abort one of the two with a serialization error on the concurrent update, which is correct but turns every contended checkout into a retry.

**Mistake: calling the payment provider inside the transaction.** It feels atomic. It is not — the provider has no idea about your transaction — and it holds row locks for the full provider latency (hundreds of ms, seconds on a bad day). Instead, commit the order first, call the provider, and apply the result in a second idempotent transaction.

**Mistake: storing `available` as its own column next to `on_hand` and `reserved`.** Three numbers that must agree will eventually disagree. Instead, store the two primitives and derive `available`, or enforce the relationship with a `CHECK` / generated column.

**Mistake: reservations with no expiry, or expiry only "when someone looks".** A lazy check (`WHERE expires_at > now()`) hides expired holds from queries but never decrements `reserved`, so the conditional UPDATE keeps failing and the SKU looks sold out. Instead, run a sweeper (with `SKIP LOCKED`) and treat lazy checks as an extra safety net.

**Mistake: one inventory row per product for a flash sale.** Every buyer queues on one tuple; lock waits pile up, connections max out, and *other* products' checkouts time out because the pool is full of waiters. Instead, bucket the row, gate in Redis, and cap concurrency with a per-SKU semaphore or queue.

**Mistake: overwriting status without a guard.** `UPDATE orders SET status='PAID' WHERE id=?` turns a late webhook into resurrecting an `EXPIRED` order whose stock was already released and resold. Instead, always `WHERE status = <expected>` and handle the zero-row case explicitly (refund).

**Mistake: random UUIDv4 primary keys on orders.** Inserts land on random B-tree leaf pages, causing page splits and a working set equal to the whole index. Instead, use a bigint identity or a time-ordered UUIDv7 ([Ch 02 · Storage Internals](topic.html?p=02-storage-internals)).

**Best practices:** `lock_timeout = '2s'` and `statement_timeout` on the checkout role so a stuck hot row fails fast instead of draining the pool ([Ch 20 · Database + Application](topic.html?p=20-database-application-architecture)); sort lines before locking; keep `inventory` narrow with few indexes; run invariant-check queries continuously; publish every state change via the outbox.

## 8. Production: Failure Scenarios, Monitoring & Scaling

### Failure scenarios

**Flash sale at 10:00:00, checkout p99 goes from 200 ms to 30 s.** Symptom: `pg_stat_activity` shows hundreds of sessions in `wait_event = transactionid` all on the same `UPDATE inventory`; application pool exhausted, unrelated checkouts fail. Root cause: one row, 4,000 attempts/s, lock hold time inflated because the transaction also did a slow price lookup after locking. Fix: move hot-row updates to the end of the transaction, set `lock_timeout = '500ms'` for the flash-sale path, enable the Redis gate, and split the SKU into 16 buckets for the next sale.

**Webhook arrives after the sweeper expired the order.** Symptom: payment `CAPTURED` but order `EXPIRED`; customer charged, no order. Root cause: 3-D Secure took 16 minutes, reservation TTL was 15. Fix: the guarded UPDATE returns zero rows, so the webhook transaction attempts a fresh reservation; if stock is gone, it writes a `RefundRequested` outbox event. Also: extend `expires_at` when the provider reports the payment is in progress.

**Deadlock storm on multi-item carts.** Symptom: `ERROR: deadlock detected` (40P01) spikes during a bundle promotion. Root cause: a new code path reserved lines in cart order rather than SKU order. Fix: sort lines by `(sku_id, warehouse_id)` in one shared function; alert on `pg_stat_database.deadlocks` rate.

**Relay lag: emails and fulfilment 20 minutes behind.** Symptom: outbox table growing, Kafka consumers idle. Root cause: the CDC connector's replication slot stalled; WAL is being retained on the primary (disk alarm next). Fix: restart the connector, cap retention with `max_slot_wal_keep_size`, and alert on slot lag ([Ch 29 · Advanced Database Patterns](topic.html?p=29-advanced-database-patterns)).

**Reconciliation shows `reserved` > sum of active reservations.** Root cause: a manual admin script released reservations without touching `inventory`. Fix: make the only writers stored functions or the service; revoke direct UPDATE on the two tables from human roles.

### Monitoring

| Metric | Why | Alert |
|---|---|---|
| Checkout txn p99 and error rate by SQLSTATE (40P01, 40001, 55P03) | contention shows here first | p99 > 500 ms for 5 min |
| Lock waits on `inventory` (`pg_locks` not granted, grouped by relation) | hot-row pile-ups | > 50 waiters |
| Out-of-stock rate vs Redis-gate "sold out" | detects gate drift | divergence > 1% |
| Active reservations older than TTL + 2 min | sweeper broken | any |
| Invariant queries I1/I2 | correctness | any row returned |
| Orders stuck in PENDING_PAYMENT > 30 min | payment/webhook failure | > 0.5% of orders |
| Outbox backlog / replication slot lag | event pipeline health | > 60 s |
| `n_dead_tup` and autovacuum frequency on `inventory` | a hot narrow table churns versions fast | dead tuples > 20% |

### Scaling path

Following the [Ch 21 · Database Scaling](topic.html?p=21-database-scaling) ladder, in order:

1. **Today (60 orders/s):** one primary (e.g. 16 vCPU, 64 GB), two async replicas, PgBouncer in transaction mode, Redis for catalog and carts. Catalog reads never hit the primary.
2. **10× (600 orders/s):** still one primary for writes. Tune: `fillfactor` on `inventory`, partial indexes, aggressive autovacuum on hot tables. Partition `orders`, `order_items` and `outbox` by month ([Ch 11 · Partitioning](topic.html?p=11-partitioning)) so old months detach to cheap storage. Flash-sale gate always on.
3. **100× (6,000 orders/s sustained):** the write primary is the limit. Shard orders by `customer_id` hash (order history is per customer; that is your dominant read) — see [Ch 12 · Sharding](topic.html?p=12-sharding). Inventory is sharded by `sku_id` and becomes its own service, which means reserve-then-create-order is now a saga with the reservation-with-expiry as its compensating step. Global order ids become Snowflake-style so they are unique across shards.

### Backups, DR and lifecycle

Orders and payments are financial records: PITR with continuous WAL archiving (RPO of seconds), a synchronous standby in another AZ for failover (RPO ≈ 0 for committed checkouts), quarterly restore drills ([Ch 26 · Backup & Disaster Recovery](topic.html?p=26-backup-disaster-recovery), [Ch 18 · High Availability](topic.html?p=18-high-availability)). Lifecycle: monthly partitions; after 13 months detach and move to an archive tablespace or export to Parquet in object storage; keep 7 years for audit; PII in `customers` is erasable independently (orders keep the id, not the name) — see [Ch 28 · Data Lifecycle](topic.html?p=28-data-lifecycle).

## 9. Interview Questions

**Q: Two users click "Buy" on the last unit at the same moment. Walk through exactly what your database does.**
A: Both run `UPDATE inventory SET reserved = reserved + 1 WHERE sku_id = ? AND on_hand - reserved >= 1`. The first to reach the row takes its row lock and updates it. The second blocks on that lock (it waits on the first transaction's id). When the first commits, PostgreSQL in READ COMMITTED re-evaluates the WHERE clause against the newly committed row version, finds `on_hand - reserved = 0`, and updates zero rows. The application sees zero rows affected, rolls back, and returns "sold out". Exactly one order exists and neither transaction needed a retry loop or explicit lock.

**Q: When would you use SELECT ... FOR UPDATE instead of the atomic conditional UPDATE?**
A: When the decision cannot be written as one predicate: per-customer purchase limits that look at other tables, bundle rules, backorder policies that depend on supplier lead time, or when you need to read several columns and branch. `FOR UPDATE` holds the row still while the application decides, so it is correct, but the lock is held across at least one round trip, which lowers throughput on hot SKUs. For the common "enough stock?" check, the conditional UPDATE is strictly better.

**Q: Why do you need reservations at all? Why not just decrement stock when the order is created?**
A: Because payment happens after order creation and can fail, be abandoned, or take minutes (3-D Secure). If you decrement permanently at order creation, abandoned checkouts lock stock forever unless something restores it — and that something is exactly a reservation with an expiry. Modelling it explicitly as `reserved` plus a reservation row with `expires_at` makes the release path a first-class, testable transaction and keeps "available" honest.

**Q: How does the payment webhook stay correct if it is delivered twice?**
A: The webhook transaction starts with `INSERT INTO payments ... ON CONFLICT (provider, provider_ref) DO NOTHING`; a second delivery inserts nothing, so the handler commits and returns 200 without further effects. Every subsequent write is also guarded — the order moves to PAID only `WHERE status = 'PENDING_PAYMENT'`, reservations are consumed only `WHERE status = 'ACTIVE'` — so even if the unique check were missing, a replay would change nothing. Defence in depth: a unique key plus guarded transitions.

**Q: What happens if the payment succeeds but your service crashes before recording it?**
A: The provider retries the webhook until it gets a 2xx, and a reconciliation job also polls the provider for payment intents attached to orders still `PENDING_PAYMENT`. Either path runs the same idempotent transaction. Because we never tried to make "charge" and "record" atomic across two systems, we instead made "record" safely repeatable, which is the only achievable form of exactly-once here.

**Q: Why keep inventory and orders in the same database?**
A: Because reserving stock and creating the order must succeed or fail together, and a single local ACID transaction gives you that for free. Splitting them into two services with two databases turns every checkout into a distributed transaction: either 2PC (blocking, rarely used in practice) or a saga with compensations and a window of visible inconsistency. At 60 or even 600 orders/s one primary handles both easily, so the split buys nothing but complexity until the scale forces it.

**Q: The product page shows "In stock" from the cache but checkout says sold out. Is that a bug?**
A: No; it is the consistency boundary working as designed. The badge is an eventually consistent hint fed by CDC with a lag of seconds, and only the checkout transaction is authoritative. The opposite failure — confirming an order that cannot be fulfilled — is the one we prevent. You can shrink the window by invalidating the cache on the `StockChanged` event, but you should never make the page read the primary.

**Q: A flash sale puts 5,000 checkout attempts per second on one SKU. What do you do? (Senior)**
A: First recognise that the limit is serialization on a single row, not database throughput: each reservation holds the row lock until commit, so one row serves on the order of hundreds to about a thousand reservations per second. I would put an admission gate in front — an atomic Lua decrement in Redis pre-loaded with the stock — so only as many requests as there are units reach Postgres, and losers are rejected in microseconds. Postgres remains the source of truth with the conditional UPDATE, so if Redis over-admits after a failover the database still refuses. If the winners alone exceed a single row's capacity, I split the stock across N bucket rows and pick one at random with fallback. Finally I add a waiting room so arrival rate is bounded, and set a tight `lock_timeout` on that path so waiters fail fast instead of exhausting the connection pool.

**Q: Payment succeeds after the reservation expired and the unit was sold to someone else. How does your design handle it? (Senior)**
A: The webhook transaction inserts the payment row, then tries `UPDATE orders SET status='PAID' WHERE status='PENDING_PAYMENT'`, which returns zero rows because the sweeper already moved it to EXPIRED. The handler then attempts a fresh conditional reservation for the same lines; if stock is available the order is revived through an explicit `EXPIRED → PAID` edge, otherwise it writes a refund request to the outbox in the same transaction. The money is never lost track of because the payment row commits regardless. To make this rare, the payment service extends `expires_at` while the provider reports the payment in progress, and the TTL is chosen from the observed p99 of payment completion.

**Q: How would you scale orders past a single primary, and what breaks? (Senior)**
A: I would shard orders by `customer_id`, because the dominant read is "my orders" and it becomes single-shard. What breaks is everything that spanned customers in one transaction: inventory is keyed by SKU, not customer, so reserve-and-create can no longer be one local transaction. Inventory becomes its own sharded service keyed by `sku_id`, and checkout becomes a saga — reserve (with expiry) in the inventory shard, create the order in the customer shard, and let the expiry be the compensation if the second step fails. IDs must become globally unique (Snowflake or UUIDv7), admin queries across all orders move to a warehouse fed by CDC, and cross-shard uniqueness such as coupon codes needs its own keyed table.

**Q: How do you prove your inventory numbers are right?**
A: Continuously run invariant queries on a replica: `reserved` must equal the sum of ACTIVE reservations per SKU, `reserved <= on_hand` (also a CHECK), no ACTIVE reservation older than TTL plus a grace period, and `on_hand` must equal the warehouse system's physical count after each cycle count. Any row returned is a page. Every stock movement also emits a `StockChanged` event via the outbox, so you can rebuild the numbers from the event history when you need to find where drift started.

**Q: Why not just run all checkout transactions at SERIALIZABLE and let the database sort it out? (Senior)**
A: SERIALIZABLE (SSI in PostgreSQL) would prevent the oversell, but it does so by aborting one transaction of every dangerous pair with 40001, so under flash-sale contention a large fraction of checkouts become abort-and-retry, and retries add load exactly when you have none to spare. The conditional UPDATE achieves the same invariant with a wait instead of an abort. SSI is valuable when the invariant spans rows in a way you cannot express as one guarded write — for example "no more than 3 units per customer across all their open orders" — and even then I would scope it to that transaction rather than the whole system.

## 10. Quick Revision & Cheat Sheet

| Concern | Design choice |
|---|---|
| Never oversell | `UPDATE inventory ... WHERE on_hand - reserved >= q`; `CHECK (reserved <= on_hand)` |
| Abandoned checkouts | reservation row with `expires_at`; sweeper with `FOR UPDATE SKIP LOCKED` |
| Order lifecycle | status column + guarded `WHERE status = expected` transitions |
| Duplicate checkout clicks | `UNIQUE (customer_id, idempotency_key)` + `ON CONFLICT DO NOTHING` |
| Duplicate webhooks | `UNIQUE (provider, provider_ref)` + guarded transitions |
| Payment integration | no network in txn; outbox events; reconciliation poller |
| Deadlocks | lock inventory rows in `(sku_id, warehouse_id)` order |
| Flash sale | Redis Lua gate, bucketed inventory rows, waiting room, `lock_timeout` |
| Catalog reads | Redis + search index fed by CDC; stale OK |
| Growth | monthly partitions on orders/outbox; shard by customer_id at 100× |

- The database, not the app, decides "is there stock?" — the check lives in the WHERE clause.
- A hot row's ceiling is roughly 1 / lock hold time; shrink the hold time before adding hardware.
- Reserve first, pay second, convert or release third — three short transactions, none spanning a network call.
- Every status change is a compare-and-swap on the status column; zero rows is information, not an error.
- Redis can gate admission; it must never be the only stock counter.
- Keep inventory and orders in one database until the numbers force a saga.
- Continuously query your invariants; drift is found by checks, not by customers.

## 11. Hands-On Exercises

Lab: `docker run --rm -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:17`, then `psql -h localhost -U postgres`.

1. **Reproduce the oversell.** Create `inventory` with `on_hand = 1`. In two psql sessions, run `BEGIN; SELECT on_hand - reserved FROM inventory WHERE sku_id = 1;` in both, then `UPDATE inventory SET reserved = 1 WHERE sku_id = 1; COMMIT;` in both. Observe two "successful" reservations of one unit. Repeat with the conditional UPDATE and observe the second session update 0 rows after the first commits.
2. **Measure the hot-row ceiling.** Write a `pgbench` script that runs the conditional reservation UPDATE plus an INSERT on a single SKU with `on_hand = 1000000`. Run `pgbench -c 64 -j 8 -T 30 -f reserve.sql` and note TPS. Now spread across 16 bucket rows (`sku_id = 1, bucket = random(0,15)`) and compare.
3. **Deadlock on purpose.** In two sessions reserve SKUs (1 then 2) and (2 then 1) with a pause between. Observe `ERROR: deadlock detected` after `deadlock_timeout`. Fix it by sorting and show the deadlock disappears.
4. **Sweeper vs webhook race.** Create a reservation with `expires_at = now() - interval '1 second'`. In session A run the webhook transaction but stop before COMMIT; in session B run the sweeper. Show that `SKIP LOCKED` makes the sweeper skip the row, and that after A commits the reservation is CONSUMED, not RELEASED.
5. **Invariant check.** Deliberately break invariant I2 with a manual UPDATE and verify the reconciliation query returns the row. Then revoke UPDATE on `inventory` from a `human_ops` role and confirm the manual fix now fails.

**Mini project:** build the checkout service end to end — the three transactions, a Go or Python webhook handler, a polling outbox relay to Kafka (or to stdout), and a load test that fires 2,000 concurrent checkouts at a 500-unit SKU. Assert: exactly 500 orders reach PAID or PENDING_PAYMENT, `reserved + sold = 500`, zero rows from the invariant queries, and no deadlocks.

## 12. Related Topics & Free Learning Resources

**Concept chapters this design applies:** [Ch 04 · Concurrency Control](topic.html?p=04-concurrency-control) (conditional writes, CAS on status) · [Ch 05 · Locking Internals](topic.html?p=05-locking-internals) (row locks, lock ordering, SKIP LOCKED) · [Ch 06 · Isolation Deep Dive](topic.html?p=06-isolation-deep-dive) (why READ COMMITTED + guarded writes is enough here) · [Ch 10 · Consistency Models](topic.html?p=10-consistency-models) · [Ch 11 · Partitioning](topic.html?p=11-partitioning) · [Ch 12 · Sharding](topic.html?p=12-sharding) · [Ch 13 · Distributed Transactions](topic.html?p=13-distributed-transactions) (the saga you get after splitting) · [Ch 19 · Database Caching Architecture](topic.html?p=19-database-caching-architecture) · [Ch 21 · Database Scaling](topic.html?p=21-database-scaling) · [Ch 22 · Capacity Planning](topic.html?p=22-capacity-planning) · [Ch 29 · Advanced Database Patterns](topic.html?p=29-advanced-database-patterns) (outbox, CDC).

**Related case studies:** [Ch 32 · Banking Ledger](topic.html?p=32-case-banking) · [Ch 33 · Ticket Booking](topic.html?p=33-case-ticket-booking) · [Ch 38 · Amazon-like Order System](topic.html?p=38-case-order-system) · [Ch 39 · Payment System](topic.html?p=39-case-payment-system).

**SQL Handbook:** [Schema Design](../sql/topic.html?p=30-schema-design) · [Keys & Constraints](../sql/topic.html?p=29-keys-constraints) · [Transactions & ACID](../sql/topic.html?p=25-transactions-acid) · [Locking & MVCC](../sql/topic.html?p=27-locking-mvcc).

**Other handbooks:** [Kafka & RabbitMQ · Idempotency & Outbox](../messaging/topic.html?p=21-idempotency-outbox) · [Caching with Redis · Hot Keys & Avalanche](../redis-caching/topic.html?p=17-hot-keys-avalanche) · [Caching with Redis · Pipelining, Lua & Transactions](../redis-caching/topic.html?p=22-pipelining-lua-transactions).

- **PostgreSQL docs — Concurrency Control (Read Committed and UPDATE re-check)** — PostgreSQL · *Intermediate* · the exact rule that makes the conditional UPDATE safe. <https://www.postgresql.org/docs/current/transaction-iso.html>
- **PostgreSQL docs — The Locking Clause (FOR UPDATE, SKIP LOCKED)** — PostgreSQL · *Intermediate* · lock strengths and SKIP LOCKED semantics used by the sweeper. <https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE>
- **Microservices Patterns — Transactional Outbox** — Chris Richardson · *Intermediate* · the pattern that removes the dual write from checkout. <https://microservices.io/patterns/data/transactional-outbox.html>
- **Microservices Patterns — Saga** — Chris Richardson · *Advanced* · what checkout becomes after inventory and orders split. <https://microservices.io/patterns/data/saga.html>
- **Idempotent Requests** — Stripe API docs · *Intermediate* · the idempotency-key contract the checkout endpoint mirrors. <https://docs.stripe.com/api/idempotent_requests>
- **Designing Data-Intensive Applications, ch. 7** — Martin Kleppmann · *Advanced* · lost updates, write skew and the fixes used here. <https://dataintensive.net/>
- **MySQL docs — Locking Reads** — MySQL · *Intermediate* · InnoDB's `FOR UPDATE` / `SKIP LOCKED` behaviour for the MySQL variant of this design. <https://dev.mysql.com/doc/refman/8.0/en/innodb-locking-reads.html>

---

*Database Design Handbook — chapter 31.*
