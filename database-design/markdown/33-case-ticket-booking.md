# 33 · Case Study: Ticket Booking Database

> **In one line:** Ticket booking is inventory where every unit is unique and everyone wants the same units at the same second, so the data layer is a per-seat state machine (available → held → sold) guarded by conditional writes and a unique constraint, holds that expire on their own, `SKIP LOCKED` for "any seat" requests, and a waiting room that meters demand down to what the database can serve.

---

## 1. Overview

> **Builds on:** [SQL Handbook · Locking & MVCC](../sql/topic.html?p=27-locking-mvcc) (row locks, SELECT FOR UPDATE basics) · [SQL Handbook · Keys & Constraints](../sql/topic.html?p=29-keys-constraints) · [Ch 04 · Concurrency Control](topic.html?p=04-concurrency-control) · [Ch 05 · Locking Internals](topic.html?p=05-locking-internals) · [Ch 31 · E-commerce](topic.html?p=31-case-ecommerce) (reservations with expiry). This chapter takes the reservation idea from e-commerce and applies it where each unit has an identity — seat 14 in row F — and demand arrives as a synchronized spike.

You are designing the data layer for a Ticketmaster/BookMyShow-style platform: venues with seat maps, events (concerts, matches, films), a seat picker, holds while the user pays, payment, tickets, cancellations and resale. Most of the year it is a quiet OLTP system. A few times a year a superstar goes on sale at 10:00 and a million people press the same button at once, for 70,000 seats that will be gone in minutes.

What makes this different from generic e-commerce is **identity**: in e-commerce, any of the 1,000 units of a SKU satisfies a buyer, so you count; here, a buyer wants *these two adjacent seats*, so you track each seat. And the **arrival pattern** is not a peak on a curve but a wall: demand for the first minute can be 100× the entire inventory.

### Requirements

**Functional:** browse events; view a seat map with live-ish availability; pick specific seats (reserved seating) or "best available N in section X"; general-admission (GA) sections with a capacity count; hold seats for a few minutes while paying; confirm on payment; release on timeout or cancel; issue tickets; refunds; a virtual waiting room for high-demand on-sales.

**Non-functional:**

- **Never sell a seat twice** (hard invariant, legal exposure).
- **Never sell more GA tickets than capacity.**
- A held seat is invisible to others until it is released or expires; an expired hold must become sellable again within seconds.
- Fairness: first-come-first-served through the waiting room; bots throttled.
- The platform stays up during on-sales; the booking core degrades by *queueing*, not by erroring.

### Workload estimate

| Quantity | Normal day | Big on-sale (10:00, one event) |
|---|---|---|
| Users arriving | ~5 M DAU | 1.5 M in the first 5 minutes |
| Seat-map / availability reads | ~5,000/s | 100,000–300,000/s |
| Hold attempts | ~50/s | as many as you admit (target 2,000–5,000/s) |
| Seats confirmed | ~100 K/day | 70,000 in ~10–20 minutes |
| Events with open inventory | ~50,000 | 1 hot event |
| `event_seats` rows | 50 K events × ~2,000 avg = ~100 M | 70 K rows for the hot event |
| Data growth (tickets + bookings) | ~40 M tickets/year × ~1 KB ≈ 40 GB/year | — |

The normal day is small for one PostgreSQL primary. The on-sale is the design problem, and the numbers say something important: the database does not need to handle 1.5 million users — it needs to handle **70,000 successful holds plus the failed attempts you let through**. Everything else (reads, queueing, rejection) must be absorbed before the database. See [Ch 22 · Capacity Planning](topic.html?p=22-capacity-planning).

### Why the naive design breaks

The naive design stores `seats.is_booked BOOLEAN`, lets the client show a seat map from the database, and on click runs `SELECT is_booked` then `UPDATE ... SET is_booked = true` then calls the payment provider, then COMMITs. Two users who both saw F-14 free both pass the SELECT and both book it — a double sale. Holding the transaction open through payment locks the seat row for 30–90 s and the connection for the same time, so the connection pool empties in seconds at 10:00. And rendering the seat map from the primary at 200,000 reads per second takes the primary down before a single ticket is sold.

## 2. Core Concepts

- **Seat (venue template)** — a physical seat: section, row, number, coordinates, accessibility flags. Static per venue.
- **Event seat (inventory row)** — the seat *for one event*, with status and price tier. *Why it matters:* this is the unit of locking; one row per seat per event.
- **Seat status** — `AVAILABLE`, `HELD`, `SOLD` (plus `BLOCKED` for production holds/kills). *Invariant T1:* a seat has at most one current holder.
- **Hold** — a short-lived claim on one or more seats for a user, with `expires_at` (typically 5–10 minutes). *Invariant T2:* an expired hold never blocks a sale.
- **Ticket** — the sold right to a seat. *Invariant T3:* `UNIQUE (event_id, seat_id)` among valid tickets — the database-level last line against double selling.
- **GA capacity counter** — for unnumbered sections, a counted inventory `(capacity, held, sold)`. *Invariant T4:* `held + sold <= capacity`, enforced exactly like stock in [Ch 31 · E-commerce](topic.html?p=31-case-ecommerce).
- **Optimistic status transition** — `UPDATE ... WHERE status = 'AVAILABLE'` (or `version = $v`); the row count tells you whether you won.
- **SKIP LOCKED** — a locking read that silently skips rows currently locked by others. *Why it matters:* "give me any 2 seats in section 104" becomes non-blocking under contention.
- **NOWAIT** — a locking read that errors immediately (SQLSTATE 55P03) if the row is locked. *Why it matters:* "that exact seat was just taken" without queueing behind the winner.
- **Waiting room / admission token** — a queue in front of the booking API that admits users at a controlled rate and issues a signed, expiring token. *Why it matters:* it turns an unbounded spike into a bounded, fair flow.
- **Payment timeout** — the hold's expiry is the payment deadline; a payment that completes after it must be reconciled (re-hold or refund).

## 3. Theory & Principles

### Access patterns, ranked

| # | Access pattern | Peak rate | Consistency | Served from |
|---|---|---|---|---|
| 1 | Seat map availability for an event | 300,000/s | stale 1–2 s is fine | Redis snapshot / CDN, refreshed from DB changes |
| 2 | Waiting-room position / admission | 100,000/s | per-user monotonic | Redis |
| 3 | Hold specific seats | 2,000–5,000/s (admitted) | **strong per seat** | Postgres primary |
| 4 | Hold best-available N in a section | same | **strong, non-blocking** | Postgres primary, SKIP LOCKED |
| 5 | Confirm on payment | ~1,000/s | **strong, idempotent** | Postgres primary |
| 6 | Expire holds | continuous | strong | sweeper on primary |
| 7 | "My tickets" | ~2,000/s | read-your-writes | primary briefly after purchase, then replica/cache |
| 8 | Reporting (sales by tier, revenue) | low | stale OK | replica / warehouse |

### Consistency boundary

The strong boundary is the **seat's status and its holder**, plus the hold → booking → ticket chain. Everything the user merely *looks at* is outside it: the seat map is a picture of the recent past, and that is acceptable because every action on a seat goes through a conditional write that checks the present. The worst thing a stale seat map can cause is "Sorry, that seat was just taken — here are the nearest available", which is a UX problem, not a correctness one ([Ch 10 · Consistency Models](topic.html?p=10-consistency-models)).

### The seat state machine

```svg
<svg viewBox="0 0 860 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs><marker id="c33a1" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#334155"/></marker><marker id="c33a2" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#dc2626"/></marker></defs>
  <text x="430" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">One event_seats row: every arrow is a single conditional UPDATE</text>
  <rect x="40" y="130" width="170" height="70" rx="10" fill="#dcfce7" stroke="#16a34a"/>
  <text x="125" y="160" text-anchor="middle" fill="#14532d" font-size="13" font-weight="bold">AVAILABLE</text>
  <text x="125" y="180" text-anchor="middle" fill="#166534" font-size="9">hold_id NULL</text>
  <rect x="345" y="130" width="170" height="70" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="430" y="155" text-anchor="middle" fill="#78350f" font-size="13" font-weight="bold">HELD</text>
  <text x="430" y="173" text-anchor="middle" fill="#92400e" font-size="9">hold_id = H, held_until = t+8m</text>
  <text x="430" y="188" text-anchor="middle" fill="#92400e" font-size="9">invisible to other buyers</text>
  <rect x="650" y="130" width="170" height="70" rx="10" fill="#dbeafe" stroke="#2563eb"/>
  <text x="735" y="160" text-anchor="middle" fill="#1e3a8a" font-size="13" font-weight="bold">SOLD</text>
  <text x="735" y="180" text-anchor="middle" fill="#1e3a8a" font-size="9">ticket row, UNIQUE(event, seat)</text>
  <path d="M210,150 L343,150" stroke="#334155" stroke-width="1.8" marker-end="url(#c33a1)"/>
  <text x="276" y="120" text-anchor="middle" fill="#1e293b" font-weight="bold">hold</text>
  <text x="276" y="138" text-anchor="middle" fill="#334155" font-size="9">WHERE status='AVAILABLE'</text>
  <path d="M515,150 L648,150" stroke="#334155" stroke-width="1.8" marker-end="url(#c33a1)"/>
  <text x="582" y="120" text-anchor="middle" fill="#1e293b" font-weight="bold">confirm (paid)</text>
  <text x="582" y="138" text-anchor="middle" fill="#334155" font-size="9">WHERE hold_id=H AND status='HELD'</text>
  <path d="M345,190 C 300,250 250,250 210,190" stroke="#dc2626" stroke-width="1.8" fill="none" marker-end="url(#c33a2)"/>
  <text x="278" y="262" text-anchor="middle" fill="#991b1b" font-weight="bold">release / expire</text>
  <text x="278" y="278" text-anchor="middle" fill="#991b1b" font-size="9">user cancel, or held_until &lt; now()</text>
  <path d="M345,140 C 300,70 250,70 210,140" stroke="#d97706" stroke-width="1.5" stroke-dasharray="5 3" fill="none" marker-end="url(#c33a1)"/>
  <text x="278" y="62" text-anchor="middle" fill="#92400e" font-size="9">lazy: an EXPIRED hold counts as AVAILABLE</text>
  <text x="278" y="76" text-anchor="middle" fill="#92400e" font-size="9">in the next buyer's predicate</text>
  <path d="M735,200 C 700,300 170,320 125,202" stroke="#7c3aed" stroke-width="1.5" fill="none" marker-end="url(#c33a1)"/>
  <text x="430" y="312" text-anchor="middle" fill="#5b21b6" font-size="9">refund / resale return: ticket voided, seat back to AVAILABLE (new version)</text>
  <rect x="40" y="330" width="780" height="40" rx="6" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="430" y="347" text-anchor="middle" fill="#1e293b">Zero rows updated = somebody else moved the seat first. The caller re-reads, never overwrites.</text>
  <text x="430" y="362" text-anchor="middle" fill="#334155" font-size="9">Holds expire two ways: lazily inside the hold predicate (correctness) and by a sweeper (so the seat map turns green again).</text>
</svg>
```

### Three locking tools, three request shapes

**Exact seats ("F-14 and F-15").** Use a single conditional UPDATE over the requested seats and require the row count to equal the number requested. The predicate accepts seats that are AVAILABLE *or* HELD with an expired `held_until`, which is **lazy expiry**: correctness never depends on the sweeper having run. If another transaction is mid-hold on F-14, the UPDATE would wait for it; if you prefer to fail fast, lock first with `SELECT ... FOR UPDATE NOWAIT` and treat SQLSTATE 55P03 as "just taken". Waiting is fine when holds are short; NOWAIT is better during an on-sale, because nobody wants to queue for a seat they will probably lose.

**Best available ("any 2 in section 104").** `SELECT ... WHERE status = 'AVAILABLE' ORDER BY quality LIMIT 2 FOR UPDATE SKIP LOCKED` hands each concurrent buyer a *different* set of seats with no waiting: rows another transaction has locked are simply skipped. It is the same mechanism job queues use ([Ch 05 · Locking Internals](topic.html?p=05-locking-internals)). The catch is adjacency — skipping locked rows can hand a pair of buyers seats 7 and 9 instead of 7 and 8. Handle it by choosing within a row block and retrying on a non-adjacent result, or by locking a whole row-block with an advisory lock keyed by `(event, section, row)` for the few milliseconds of selection.

**GA sections (no seat identity).** Counted inventory: `UPDATE ga_sections SET held = held + $n WHERE event_id = $e AND section_id = $s AND held + sold + $n <= capacity`. One row per GA section is a hot row during an on-sale; split it into buckets exactly as in [Ch 31 · E-commerce](topic.html?p=31-case-ecommerce).

```text
Best-available with SKIP LOCKED, three buyers, section 104 has seats 1..6 free
t0  B1: SELECT ... ORDER BY quality LIMIT 2 FOR UPDATE SKIP LOCKED  -> locks 1,2
t0  B2: same query                                                   -> 1,2 locked, skipped -> locks 3,4
t0  B3: same query                                                   -> locks 5,6
t1  B1: UPDATE seats 1,2 SET HELD; INSERT hold; COMMIT               (about 3 ms)
t1  B2, B3 likewise. Nobody waited, nobody got a duplicate, nobody retried.
With plain FOR UPDATE instead: B2 and B3 queue on seats 1,2, wake up, find them HELD,
re-run the query -> a convoy of retries at exactly the moment the section is busiest.
```

## 4. Architecture & Workflow

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs><marker id="c33b1" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#2563eb"/></marker><marker id="c33b2" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#16a34a"/></marker></defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">On-sale data path: absorb the wall before it reaches Postgres</text>
  <rect x="20" y="50" width="140" height="60" rx="6" fill="#f1f5f9" stroke="#94a3b8"/><text x="90" y="75" text-anchor="middle" fill="#1e293b" font-weight="bold">1.5 M users</text><text x="90" y="92" text-anchor="middle" fill="#334155" font-size="9">10:00:00 on-sale</text>
  <rect x="210" y="45" width="170" height="70" rx="6" fill="#fef3c7" stroke="#d97706"/><text x="295" y="68" text-anchor="middle" fill="#78350f" font-weight="bold">Waiting room</text><text x="295" y="84" text-anchor="middle" fill="#92400e" font-size="9">Redis: queue position, admit rate</text><text x="295" y="98" text-anchor="middle" fill="#92400e" font-size="9">signed token, 15-min TTL</text>
  <path d="M160,80 L208,80" stroke="#2563eb" stroke-width="1.8" marker-end="url(#c33b1)"/>
  <text x="185" y="72" text-anchor="middle" fill="#1e3a8a" font-size="9">all</text>
  <rect x="430" y="45" width="190" height="70" rx="6" fill="#dbeafe" stroke="#2563eb"/><text x="525" y="68" text-anchor="middle" fill="#1e3a8a" font-weight="bold">Booking service</text><text x="525" y="84" text-anchor="middle" fill="#1e3a8a" font-size="9">rejects requests without a token</text><text x="525" y="98" text-anchor="middle" fill="#1e3a8a" font-size="9">per-event concurrency cap</text>
  <path d="M380,80 L428,80" stroke="#2563eb" stroke-width="1.8" marker-end="url(#c33b1)"/>
  <text x="404" y="72" text-anchor="middle" fill="#1e3a8a" font-size="9">~3k/s</text>
  <rect x="670" y="40" width="190" height="80" rx="6" fill="#f1f5f9" stroke="#94a3b8"/><text x="765" y="62" text-anchor="middle" fill="#1e293b" font-weight="bold">Seat-map cache</text><text x="765" y="78" text-anchor="middle" fill="#334155" font-size="9">Redis bitmap per section</text><text x="765" y="92" text-anchor="middle" fill="#334155" font-size="9">+ CDN JSON, 1 s TTL</text><text x="765" y="106" text-anchor="middle" fill="#334155" font-size="9">~300k reads/s never hit DB</text>
  <rect x="330" y="170" width="300" height="170" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="480" y="190" text-anchor="middle" fill="#14532d" font-weight="bold">PostgreSQL primary: the only truth</text>
  <rect x="345" y="202" width="130" height="24" rx="3" fill="#ffffff" stroke="#16a34a"/><text x="410" y="218" text-anchor="middle" fill="#14532d" font-size="9">event_seats (per event)</text>
  <rect x="485" y="202" width="130" height="24" rx="3" fill="#ffffff" stroke="#16a34a"/><text x="550" y="218" text-anchor="middle" fill="#14532d" font-size="9">ga_sections (buckets)</text>
  <rect x="345" y="232" width="130" height="24" rx="3" fill="#ffffff" stroke="#16a34a"/><text x="410" y="248" text-anchor="middle" fill="#14532d" font-size="9">holds</text>
  <rect x="485" y="232" width="130" height="24" rx="3" fill="#ffffff" stroke="#16a34a"/><text x="550" y="248" text-anchor="middle" fill="#14532d" font-size="9">bookings, payments</text>
  <rect x="345" y="262" width="130" height="24" rx="3" fill="#ffffff" stroke="#2563eb"/><text x="410" y="278" text-anchor="middle" fill="#1e3a8a" font-size="9">tickets UNIQUE(ev,seat)</text>
  <rect x="485" y="262" width="130" height="24" rx="3" fill="#ffffff" stroke="#7c3aed"/><text x="550" y="278" text-anchor="middle" fill="#5b21b6" font-size="9">outbox</text>
  <text x="480" y="308" text-anchor="middle" fill="#166534" font-size="9">sweeper: expire holds with SKIP LOCKED every 2 s</text>
  <text x="480" y="324" text-anchor="middle" fill="#166534" font-size="9">lock_timeout 200ms on the on-sale path</text>
  <path d="M525,115 L495,168" stroke="#16a34a" stroke-width="2" marker-end="url(#c33b2)"/>
  <text x="545" y="145" fill="#166534" font-size="9">hold / confirm txns</text>
  <rect x="680" y="200" width="180" height="46" rx="6" fill="#ede9fe" stroke="#7c3aed"/><text x="770" y="220" text-anchor="middle" fill="#5b21b6" font-weight="bold">Kafka</text><text x="770" y="236" text-anchor="middle" fill="#5b21b6" font-size="9">SeatHeld / Released / Sold</text>
  <path d="M615,274 L678,236" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#c33b1)"/>
  <path d="M770,200 L770,122" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#c33b1)"/>
  <text x="780" y="165" fill="#5b21b6" font-size="9">refresh bitmap</text>
  <rect x="680" y="290" width="180" height="50" rx="6" fill="#fee2e2" stroke="#dc2626"/><text x="770" y="310" text-anchor="middle" fill="#991b1b" font-weight="bold">Payment provider</text><text x="770" y="326" text-anchor="middle" fill="#991b1b" font-size="9">deadline = hold expires_at</text>
  <path d="M770,340 C 740,400 560,400 500,342" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="4 3" fill="none" marker-end="url(#c33b1)"/>
  <text x="640" y="410" text-anchor="middle" fill="#991b1b" font-size="9">webhook: confirm if hold still ours, else re-hold or refund</text>
  <rect x="20" y="200" width="250" height="110" rx="6" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="145" y="220" text-anchor="middle" fill="#1e293b" font-weight="bold">What reaches the DB</text>
  <text x="35" y="242" fill="#334155">admitted holds: ~3,000/s</text>
  <text x="35" y="260" fill="#334155">confirms: ~1,000/s</text>
  <text x="35" y="278" fill="#334155">sweeper: 1 query / 2 s</text>
  <text x="35" y="296" fill="#334155">seat-map reads: 0</text>
  <text x="20" y="445" fill="#1e293b" font-weight="bold">Write path:</text><text x="100" y="445" fill="#334155">token check, then hold txn (conditional UPDATE / SKIP LOCKED), then payment, then confirm txn (tickets + outbox)</text>
  <text x="20" y="463" fill="#1e293b" font-weight="bold">Read path:</text><text x="100" y="463" fill="#334155">seat map from Redis/CDN (1-2 s stale), refreshed by CDC events; the hold predicate is the real check</text>
</svg>
```

### The waiting room, from the data layer's point of view

The waiting room is a demand shaper, and its only database-relevant job is to cap arrival rate at the booking core. Arrivals get a position (`INCR onsale:{event}:seq` in Redis) and poll; an admitter process advances an `admitted_upto` counter at a rate chosen from measured capacity (say 3,000 users per second, then tuned live by watching hold latency). An admitted user receives a signed token `{user, event, exp}`; the booking API checks the signature and expiry without any database call and enforces one active hold per token. When inventory is gone, the admitter stops and everyone still queued is told "sold out" without ever touching Postgres. See [Caching with Redis · Sorted Sets & Rate Limiting](../redis-caching/topic.html?p=19-sorted-sets-rate-limiting) for the counter mechanics.

### Hold, pay, confirm: the timeline

```text
t=0       user admitted (token), opens section 104 map (Redis bitmap, 1 s stale)
t=4s      POST /holds {event, seats:[F-14,F-15]}           -> TXN H (~3 ms)
            conditional UPDATE 2 event_seats rows; rowcount must be 2
            INSERT holds (expires_at = now()+8 min); INSERT outbox(SeatHeld)
t=5s      create payment intent (metadata: hold_id), no DB txn open
t=3m      user pays; provider webhook (at-least-once)        -> TXN C (~4 ms)
            UPDATE holds SET status='CONFIRMED' WHERE id=H AND status='ACTIVE' AND expires_at > now()
            UPDATE event_seats SET status='SOLD' WHERE hold_id=H AND status='HELD'
            INSERT tickets (UNIQUE event_id, seat_id)
            INSERT booking, payment, outbox(SeatSold)
t=8m      (if never paid) sweeper: hold ACTIVE and expired -> EXPIRED; seats -> AVAILABLE; outbox(SeatReleased)
t=8m+3s   late webhook: TXN C finds hold EXPIRED -> try re-hold same seats (conditional),
            success -> confirm; failure -> refund via outbox; user told "seats released"
```

## 5. Implementation

### Core schema

```sql
CREATE TABLE events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  venue_id    BIGINT NOT NULL,
  starts_at   TIMESTAMPTZ NOT NULL,
  on_sale_at  TIMESTAMPTZ NOT NULL,
  hold_ttl    INTERVAL NOT NULL DEFAULT '8 minutes',
  max_per_user SMALLINT NOT NULL DEFAULT 6
);

-- One row per seat per event. Created from the venue template when the event is published.
CREATE TABLE event_seats (
  event_id     BIGINT   NOT NULL,
  seat_id      INT      NOT NULL,           -- venue seat id
  section_id   INT      NOT NULL,
  row_label    TEXT     NOT NULL,
  seat_no      SMALLINT NOT NULL,
  quality      INT      NOT NULL,           -- lower = better; drives "best available"
  price_tier   SMALLINT NOT NULL,
  status       TEXT     NOT NULL DEFAULT 'AVAILABLE'
               CHECK (status IN ('AVAILABLE','HELD','SOLD','BLOCKED')),
  hold_id      BIGINT,
  held_until   TIMESTAMPTZ,
  version      INT      NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, seat_id),
  CHECK ((status = 'HELD') = (hold_id IS NOT NULL AND held_until IS NOT NULL))
) PARTITION BY HASH (event_id);
-- 16 hash partitions keep per-partition indexes and vacuum small; one event stays in one partition.
CREATE TABLE event_seats_p0 PARTITION OF event_seats FOR VALUES WITH (MODULUS 16, REMAINDER 0);
-- ... p1 .. p15

-- "Best available in section": only unsold seats, in quality order.
CREATE INDEX event_seats_pick ON event_seats (event_id, section_id, quality)
  WHERE status = 'AVAILABLE';
-- Confirm and release find seats by hold.
CREATE INDEX event_seats_hold ON event_seats (hold_id) WHERE hold_id IS NOT NULL;

CREATE TABLE holds (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id    BIGINT NOT NULL,
  user_id     BIGINT NOT NULL,
  seat_count  SMALLINT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CONFIRMED','EXPIRED','RELEASED')),
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX holds_expiring ON holds (expires_at) WHERE status = 'ACTIVE';
-- At most one active hold per user per event (anti-hoarding), enforced by the database.
CREATE UNIQUE INDEX holds_one_active ON holds (event_id, user_id) WHERE status = 'ACTIVE';

CREATE TABLE bookings (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hold_id     BIGINT NOT NULL UNIQUE,            -- one booking per hold: duplicate webhooks collapse
  user_id     BIGINT NOT NULL,
  event_id    BIGINT NOT NULL,
  total_minor BIGINT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'CONFIRMED',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payments (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hold_id       BIGINT NOT NULL,
  provider_ref  TEXT   NOT NULL UNIQUE,         -- duplicate webhooks collapse here
  amount_minor  BIGINT NOT NULL,
  status        TEXT   NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tickets (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id  BIGINT NOT NULL REFERENCES bookings(id),
  event_id    BIGINT NOT NULL,
  seat_id     INT    NOT NULL,
  status      TEXT   NOT NULL DEFAULT 'VALID' CHECK (status IN ('VALID','VOID')),
  barcode     UUID   NOT NULL UNIQUE DEFAULT gen_random_uuid()
);
-- T3: the last line of defence. Even if every other guard had a bug, a seat cannot have two valid tickets.
CREATE UNIQUE INDEX tickets_one_per_seat ON tickets (event_id, seat_id) WHERE status = 'VALID';
CREATE INDEX tickets_booking ON tickets (booking_id);

CREATE TABLE ga_sections (
  event_id    BIGINT NOT NULL,
  section_id  INT    NOT NULL,
  bucket      SMALLINT NOT NULL,              -- capacity split across buckets for on-sales
  capacity    INT NOT NULL,
  held        INT NOT NULL DEFAULT 0,
  sold        INT NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, section_id, bucket),
  CHECK (held >= 0 AND sold >= 0 AND held + sold <= capacity)    -- T4
);
```

The partial unique index on `tickets` is the design's most important line. It is a structural guarantee that does not depend on the status machine being bug-free: a second `INSERT` of a valid ticket for the same seat fails with a unique violation (23505) and rolls back the whole confirm transaction. The partial index on `event_seats (…) WHERE status = 'AVAILABLE'` shrinks as the event sells out, so best-available queries get *faster* as inventory runs down — the opposite of what an unfiltered index does. See [SQL Handbook · Index Design](../sql/topic.html?p=20-index-design) for partial-index basics.

### Critical transaction 1: hold exact seats

```sql
BEGIN;
SET LOCAL lock_timeout = '200ms';     -- on-sale path: fail fast instead of queueing

INSERT INTO holds (event_id, user_id, seat_count, expires_at)
VALUES ($event, $user, cardinality($seats), now() + interval '8 minutes')   -- events.hold_ttl in practice
RETURNING id;                          -- unique violation => user already has an active hold

UPDATE event_seats
   SET status = 'HELD', hold_id = $hold, held_until = now() + interval '8 minutes',
       version = version + 1
 WHERE event_id = $event
   AND seat_id  = ANY ($seats)                                   -- e.g. '{5114,5115}'
   AND ( status = 'AVAILABLE'
      OR (status = 'HELD' AND held_until < now()) );             -- lazy expiry of stale holds
-- application: IF rowcount <> cardinality($seats) THEN ROLLBACK -> "one of those seats was just taken"

INSERT INTO outbox (aggregate, agg_id, event_type, payload)
VALUES ('hold', $hold, 'SeatHeld', jsonb_build_object('event', $event, 'seats', $seats));
COMMIT;
```

The UPDATE locks the matching rows in index order of `(event_id, seat_id)` in practice, but PostgreSQL does not promise an order for a multi-row UPDATE; if you see deadlocks between two users grabbing overlapping seat pairs, lock first with `SELECT ... WHERE ... ORDER BY seat_id FOR UPDATE NOWAIT` and then update. If you take over a stale hold (the lazy-expiry branch), the previous holder's `holds` row stays `ACTIVE` until the sweeper visits it; its confirm transaction checks `hold_id = H` on the seats and will find them no longer its own, which is exactly the right outcome.

### Critical transaction 2: hold best available N in a section

```sql
BEGIN;
INSERT INTO holds (event_id, user_id, seat_count, expires_at)
VALUES ($event, $user, $n, now() + interval '8 minutes') RETURNING id;

WITH picked AS (
  SELECT seat_id
    FROM event_seats
   WHERE event_id = $event AND section_id = $section AND status = 'AVAILABLE'
   ORDER BY quality
   LIMIT $n
     FOR UPDATE SKIP LOCKED              -- concurrent buyers get disjoint seats, no waiting
)
UPDATE event_seats s
   SET status = 'HELD', hold_id = $hold, held_until = now() + interval '8 minutes', version = version + 1
  FROM picked p
 WHERE s.event_id = $event AND s.seat_id = p.seat_id
RETURNING s.seat_id, s.row_label, s.seat_no;
-- fewer than $n rows => section (nearly) sold out: ROLLBACK or offer the partial result
COMMIT;
```

Note what this does *not* include: expired-but-not-yet-swept seats (status still `HELD`). That is deliberate — the best-available path relies on the sweeper, which runs every couple of seconds; the exact-seat path uses lazy expiry because the user explicitly asked for that seat.

> **MySQL difference:** InnoDB supports `FOR UPDATE SKIP LOCKED` and `NOWAIT` since 8.0 with the same semantics. Under InnoDB's default REPEATABLE READ, a locking range scan on `(event_id, section_id, quality)` also takes **next-key (gap) locks**, which can block concurrent *inserts* into the scanned range; that rarely matters here because seats are pre-created, but it surprises people who insert event seats while an on-sale runs.

### Critical transaction 3: confirm on payment (idempotent)

```sql
BEGIN;
-- Guarded transition: only an ACTIVE, unexpired hold can be confirmed, and only once.
UPDATE holds SET status = 'CONFIRMED'
 WHERE id = $hold AND status = 'ACTIVE' AND expires_at > now()
RETURNING user_id, event_id, seat_count;
-- 0 rows: already CONFIRMED (duplicate webhook -> return existing booking) or EXPIRED (go to recovery)

UPDATE event_seats SET status = 'SOLD', held_until = NULL, version = version + 1
 WHERE event_id = $event AND hold_id = $hold AND status = 'HELD'
RETURNING seat_id;
-- rowcount must equal seat_count; if a seat was taken over via lazy expiry, ROLLBACK -> recovery

INSERT INTO bookings (hold_id, user_id, event_id, total_minor)
VALUES ($hold, $user, $event, $total) RETURNING id;          -- UNIQUE(hold_id): second insert fails
INSERT INTO tickets (booking_id, event_id, seat_id)
SELECT $booking, $event, unnest($sold_seat_ids);             -- T3 unique index checked here
INSERT INTO outbox (aggregate, agg_id, event_type, payload)
VALUES ('booking', $booking, 'SeatSold', jsonb_build_object('event', $event, 'seats', $sold_seat_ids));
COMMIT;
```

> **Why this matters:** the `CHECK ((status = 'HELD') = (hold_id IS NOT NULL AND held_until IS NOT NULL))` constraint is written around the state machine. Confirm keeps `hold_id` as provenance but clears `held_until`, so a SOLD row satisfies it; a buggy code path that sets `status = 'HELD'` without a holder, or leaves `held_until` on a sold seat, fails at the statement that did it rather than surfacing weeks later as a seat-map oddity.

### Critical transaction 4: the sweeper

```sql
WITH expired AS (
  SELECT id FROM holds
   WHERE status = 'ACTIVE' AND expires_at < now()
   ORDER BY expires_at
   LIMIT 1000
     FOR UPDATE SKIP LOCKED            -- don't fight a confirm that is committing right now
), marked AS (
  UPDATE holds h SET status = 'EXPIRED' FROM expired e WHERE h.id = e.id
  RETURNING h.id, h.event_id
)
UPDATE event_seats s
   SET status = 'AVAILABLE', hold_id = NULL, held_until = NULL, version = version + 1
  FROM marked m
 WHERE s.event_id = m.event_id AND s.hold_id = m.id AND s.status = 'HELD';
```

**Sweeper vs lazy expiry.** Lazy expiry alone keeps correctness (no expired hold blocks an exact-seat request) but leaves the seat map red and the best-available index missing those seats until someone happens to request them. A sweeper alone is simpler to reason about but makes correctness depend on a background job's health. Use both: lazy for correctness, sweeper for freshness. Keep the sweeper's batch small and frequent so each run holds few locks for a short time.

### Application code: the late-payment recovery path (Go)

```go
// ConfirmOrRecover handles a payment webhook. Duplicates are no-ops; a payment that
// lands after the hold expired tries to re-hold the same seats, else refunds.
func ConfirmOrRecover(ctx context.Context, db *pgxpool.Pool, holdID int64, pay Payment) error {
	err := pgx.BeginFunc(ctx, db, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `INSERT INTO payments (hold_id, provider_ref, amount_minor, status)
			VALUES ($1,$2,$3,'CAPTURED') ON CONFLICT (provider_ref) DO NOTHING`, holdID, pay.Ref, pay.Amount); err != nil {
			return err
		}
		_, err := confirm(ctx, tx, holdID) // TXN C body; returns ErrHoldNotActive on 0 rows
		if err == nil || errors.Is(err, ErrAlreadyConfirmed) {
			return nil
		}
		if !errors.Is(err, ErrHoldNotActive) {
			return err
		}
		// Hold expired: can we still get the same seats?
		seats, err := seatsOfHold(ctx, tx, holdID)
		if err != nil {
			return err
		}
		newHold, ok, err := reHoldExact(ctx, tx, pay.UserID, pay.EventID, seats) // conditional UPDATE, rowcount check
		if err != nil {
			return err
		}
		if ok {
			_, err = confirm(ctx, tx, newHold)
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO outbox (aggregate, agg_id, event_type, payload)
			VALUES ('payment', $1, 'RefundRequested', jsonb_build_object('ref', $2::text, 'reason', 'hold_expired'))`,
			holdID, pay.Ref)
		return err
	})
	return err // on 40P01/55P03 the provider will retry the webhook; everything above is idempotent
}
```

### Diagnostics during an on-sale

```sql
-- How many seats are in each state right now (run on the primary; it is one partition, cheap).
SELECT status, count(*) FROM event_seats WHERE event_id = $event GROUP BY status;

-- Are holds piling up because payments are slow?
SELECT date_trunc('minute', created_at) AS m, status, count(*)
FROM holds WHERE event_id = $event AND created_at > now() - interval '30 minutes'
GROUP BY 1, 2 ORDER BY 1;

-- Lock waits on the seat table (should be near zero with SKIP LOCKED / NOWAIT).
SELECT count(*) FILTER (WHERE wait_event_type = 'Lock') AS lock_waiters, count(*) AS active
FROM pg_stat_activity WHERE state = 'active';
```

## 6. Advantages, Disadvantages & Trade-offs

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| Unit of inventory | row per seat per event | `sold_count` per section for reserved seating | seats have identity; counts cannot prevent two buyers getting F-14 |
| Double-sale guard | conditional UPDATE + partial UNIQUE on tickets | app-level check only | constraint survives app bugs and races |
| Best available | `FOR UPDATE SKIP LOCKED` | plain `FOR UPDATE` | no convoys; each buyer gets disjoint seats |
| Exact seat contention | `NOWAIT` / `lock_timeout` during on-sales | wait indefinitely | waiting for a seat you will lose wastes connections |
| Hold expiry | lazy predicate + sweeper | sweeper only / lazy only | correctness from lazy, freshness from sweeper |
| Hold storage | in Postgres with the seats | Redis TTL keys as holds | a hold and the seat must change atomically; Redis expiry cannot update Postgres |
| Seat map | Redis bitmap/CDN, 1 s stale | query Postgres | 300k reads/s would drown the primary |
| Demand | waiting room with admission tokens | autoscale the database | you cannot autoscale a single hot event's rows |
| Payment | hold TTL as deadline, re-hold or refund | keep txn open during payment | open txns hold locks and connections for minutes |

### When to use this design

Any inventory with **identity plus contention**: reserved seating, appointment slots, hotel rooms by number, parking bays, restaurant tables, limited-edition numbered items.

### When NOT to use it

- **General admission only** (festival wristbands): per-seat rows are waste; use bucketed counters as in [Ch 31 · E-commerce](topic.html?p=31-case-ecommerce).
- **Low contention bookings** (a dentist's calendar): a plain unique constraint on `(resource, slot)` and an INSERT is enough; no holds, no waiting room.
- **Airline seats with overbooking**: the invariant is "sold ≤ capacity × (1 + overbook%)" across fare classes, which is a revenue-management problem with counted inventory, not per-seat locking.

## 7. Common Mistakes & Best Practices

**Mistake: holding a database transaction open while the user pays.** It looks like the simplest way to keep the seat. It holds the row lock, the connection and the snapshot for minutes; at 10:00 the pool is exhausted in seconds and vacuum is blocked by the old snapshots. Instead: commit the hold, let `expires_at` be the lock, confirm in a new transaction.

**Mistake: holds as Redis keys with TTL and seats in Postgres.** Redis expires the key, but nothing tells Postgres; or Postgres commits the sale while Redis still thinks the hold is someone else's. Two stores, no shared transaction ([Ch 19 · Database Caching Architecture](topic.html?p=19-database-caching-architecture)). Instead: holds live with the seats; Redis only mirrors for display.

**Mistake: relying only on status transitions.** A single bug in a new code path (for example, resale) can set a SOLD seat back to AVAILABLE and sell it again. Instead: keep the partial unique index on valid tickets as an independent invariant.

**Mistake: "best available" with plain FOR UPDATE.** Every buyer queues on the same best seats; each waiter wakes to find them taken and retries. Instead: SKIP LOCKED.

**Mistake: letting the whole world hit the booking API at 10:00.** No database tier survives a million synchronized requests for one event's rows. Instead: waiting room with a measured admission rate; reject without a token at the edge.

**Mistake: expiring holds by `DELETE`.** You lose the history needed for fraud analysis and payment reconciliation ("which hold was this payment for?"). Instead: status transitions; archive old holds by partition.

**Mistake: a TTL shorter than real payment completion.** With 3-D Secure and bank redirects, p99 payment time can exceed 5 minutes; a 5-minute hold turns p99 into refunds. Instead: size the TTL from measured p99 and extend holds when the provider reports "processing".

**Best practices:** create `event_seats` in bulk at publish time (never lazily during the on-sale); pre-warm the event's partition and indexes into memory before `on_sale_at` (a `SELECT count(*)` over the event's seats); set `lock_timeout` and `statement_timeout` on the on-sale role; one active hold per user per event via a partial unique index; run the sweeper every 1–2 s with small batches.

## 8. Production: Failure Scenarios, Monitoring & Scaling

### Failure scenarios

**10:00:03 — connection pool exhausted, holds time out.** Symptom: booking p99 > 10 s, `pg_stat_activity` shows hundreds of sessions `idle in transaction`. Root cause: a new feature fetched the user's loyalty tier from another service *inside* the hold transaction. Fix: move remote calls before BEGIN; set `idle_in_transaction_session_timeout = '5s'` for the booking role ([Ch 20 · Database + Application](topic.html?p=20-database-application-architecture)).

**Seat map shows seats free that cannot be held.** Symptom: users click green seats and get "just taken" 40% of the time. Root cause: the CDC connector feeding the Redis bitmap lagged 30 s behind during the spike. Fix: alert on connector lag; fall back to a direct "availability summary" query per section at most once per second per section (a single cached query, not per-user); show "limited availability" rather than exact seats when lag exceeds 5 s.

**Payments succeed for expired holds after a provider slowdown.** Symptom: a spike of `RefundRequested` events. Root cause: provider latency rose from 3 s to 90 s during the on-sale, pushing many payments past the 8-minute TTL. Fix: extend holds on "payment processing" status from the provider; admission rate reduced automatically when payment latency rises (the waiting room reads a latency signal).

**Deadlocks between overlapping exact-seat holds.** Symptom: sporadic 40P01 on holds for adjacent seats. Root cause: multi-row UPDATE lock order not guaranteed. Fix: `SELECT ... ORDER BY seat_id FOR UPDATE NOWAIT` before the UPDATE.

**Sweeper stuck.** Symptom: seat map stays red long after holds lapse; best-available returns "sold out" while exact-seat requests succeed (lazy expiry). Root cause: sweeper process crashed on deploy. Fix: alert on "ACTIVE holds with `expires_at < now() - 1 min`"; run two sweeper replicas (SKIP LOCKED makes that safe).

### Monitoring

| Metric | Why | Alert |
|---|---|---|
| Hold success rate and p99 per event | the on-sale's health | p99 > 300 ms |
| Lock waits / 55P03 / 40P01 on `event_seats` | contention shape | deadlocks > 0 sustained |
| Overdue ACTIVE holds | sweeper health | any older than 1 min |
| Hold → confirm conversion, payment p99 | TTL sizing | payment p99 > 50% of TTL |
| CDC lag to seat-map cache | stale map | > 5 s |
| Waiting-room admit rate vs hold p99 | feedback loop | latency rising while admit rate constant |
| Unique violations on `tickets_one_per_seat` | a guard caught a bug | any |

### Scaling path

With [Ch 21 · Database Scaling](topic.html?p=21-database-scaling) as the ladder:

1. **Baseline:** one primary + replicas; hash-partitioned `event_seats` ([Ch 11 · Partitioning](topic.html?p=11-partitioning)); Redis for maps and the waiting room.
2. **10× more events:** read replicas take "my tickets" and event browsing; old events' seats are detached and archived after the event date ([Ch 28 · Data Lifecycle](topic.html?p=28-data-lifecycle)).
3. **100× / many simultaneous mega on-sales:** shard by `event_id` ([Ch 12 · Sharding](topic.html?p=12-sharding)) — every booking transaction touches exactly one event, so this is a clean shard key with no cross-shard transactions. A single mega event is still one shard's hot spot, which is why the waiting room, not the shard count, is the true scaling lever for the peak. User-centric reads ("my tickets across events") move to a user-keyed read model built from the outbox events.

### DR and lifecycle

Bookings and tickets are financial records: synchronous standby, PITR ([Ch 18 · High Availability](topic.html?p=18-high-availability), [Ch 26 · Backup & Disaster Recovery](topic.html?p=26-backup-disaster-recovery)). A failover during an on-sale is survivable because holds carry `expires_at` in the database: after promotion, the sweeper and lazy expiry resume exactly where they left off, and the waiting room simply pauses admission during the failover window. Event-seat rows for past events are detached monthly; tickets are kept per tax retention rules.

## 9. Interview Questions

**Q: How do you guarantee a seat is never sold twice?**
A: Three independent layers. The hold is a conditional UPDATE that only succeeds on an AVAILABLE (or expired-HELD) seat, and the caller checks the row count. The confirm is a conditional UPDATE from HELD-by-this-hold to SOLD. And a partial unique index on `tickets (event_id, seat_id) WHERE status = 'VALID'` makes a second valid ticket physically impossible even if both state-machine guards had bugs. The first two give good behaviour; the third gives a guarantee.

**Q: Why not keep the transaction open until the user pays?**
A: Payment takes seconds to minutes. An open transaction holds the row locks, a database connection, and an old snapshot for that whole time, which blocks other buyers, exhausts the pool within seconds of an on-sale, and holds back vacuum. The hold row with `expires_at` is a *logical* lock that costs nothing while it waits; the database transactions on either side of the payment are a few milliseconds each.

**Q: What does SKIP LOCKED give you for "best available"?**
A: Concurrent buyers selecting the top N available seats with `FOR UPDATE SKIP LOCKED` each get a disjoint set immediately, because rows locked by another in-flight transaction are skipped instead of waited on. Without it, every buyer queues on the same best seats, then wakes to find them taken and has to retry, which creates convoys exactly when the section is busiest. The trade-off is that results can be non-adjacent, which you handle with a row-block strategy or a retry.

**Q: When would you use NOWAIT instead of SKIP LOCKED?**
A: When the user asked for a specific seat. Skipping it would silently give them a different seat, which is wrong; waiting would queue them behind a buyer who will most likely win. `NOWAIT` fails immediately with 55P03 so you can say "that seat was just taken" and suggest neighbours. Outside on-sales, simply waiting a few milliseconds for the other transaction is fine.

**Q: Lazy expiry or a sweeper for holds?**
A: Both. Lazy expiry puts `OR (status = 'HELD' AND held_until < now())` in the hold predicate, so correctness never depends on a background job — an expired hold can never block a buyer who asks for that seat. The sweeper exists for freshness: it turns expired seats green on the map and returns them to the best-available partial index. Relying only on the sweeper makes correctness depend on its uptime; relying only on lazy expiry makes seats look sold that are not.

**Q: How does the seat map stay fast?**
A: It never reads Postgres per request. Seat changes flow through the outbox to Kafka, a consumer updates a Redis bitmap per section, and the client fetches a compact JSON or bitmap cached at the CDN for about a second. It is intentionally stale; the hold transaction is the real check. When the pipeline lags, the UI degrades to "limited availability" rather than falling back to per-user database queries.

**Q: A payment arrives after the hold expired. What happens? (Senior)**
A: The confirm transaction's guarded UPDATE on the hold returns zero rows because the hold is EXPIRED. The handler records the payment regardless, then tries to re-hold the same seats with the same conditional UPDATE; if they are still free, it confirms under a new hold and the user never notices. If someone else has them, it writes a `RefundRequested` event in the same transaction and tells the user. To keep this rare, the TTL is sized from measured payment p99 and extended when the provider reports that a payment is processing.

**Q: How do you survive a million users at 10:00 for 70,000 seats? (Senior)**
A: By not letting them reach the database. A waiting room assigns queue positions in Redis and admits users at a rate calibrated to measured hold latency, issuing signed, expiring tokens that the booking API checks without a database call. The seat map is served from cache. The database therefore sees a few thousand hold transactions per second, each touching a handful of rows with SKIP LOCKED or NOWAIT and a tight `lock_timeout`. When inventory hits zero, the waiting room stops admitting and tells the remaining queue — the database never sees them.

**Q: What is your shard key and why? (Senior)**
A: `event_id`. Every booking transaction — hold, confirm, release — touches seats of exactly one event, so there are no cross-shard transactions. The weakness is that a mega on-sale is a single-shard hot spot, and sharding cannot help that; the waiting room and per-event concurrency caps are the scaling levers for peaks. User-centric queries like "all my tickets" are served from a user-keyed read model built from outbox events rather than by scattering across shards.

**Q: How do you stop one user or bot from holding a whole section?**
A: A partial unique index `holds (event_id, user_id) WHERE status = 'ACTIVE'` allows only one active hold per user per event, and `max_per_user` bounds its size. The waiting-room token binds the user to the session, and rate limits at the edge throttle token farming. These are database-enforced where possible, so a bug in the API layer does not quietly lift the limit.

**Q: Where would a stale read cause harm in this system?**
A: Only if an action trusted it. The seat map, event listings, and "my tickets" shortly after purchase can all be slightly stale safely — the last one with a read-your-writes rule after a purchase ([Ch 10 · Consistency Models](topic.html?p=10-consistency-models)). The hold and confirm transactions must read and write the primary, because they are check-then-act decisions. A design that validated a hold against a replica would reintroduce double selling.

**Q: How would you model general admission alongside reserved seats? (Senior)**
A: As counted inventory in `ga_sections` with `held + sold <= capacity` enforced by a CHECK and by the conditional UPDATE, split into buckets during on-sales so no single row becomes the bottleneck. Holds reference either seat rows or a GA quantity, and confirm converts `held` to `sold` in the same guarded way. Tickets for GA carry no seat id, so the unique-seat index does not apply; the counter's CHECK constraint is the equivalent structural guarantee.

## 10. Quick Revision & Cheat Sheet

| Concern | Design choice |
|---|---|
| Inventory unit | `event_seats` row per seat per event, status + hold_id + held_until |
| Exact seats | conditional UPDATE, rowcount must match; `NOWAIT` during on-sales |
| Best available | `ORDER BY quality LIMIT n FOR UPDATE SKIP LOCKED` |
| GA | counter rows `held + sold <= capacity`, bucketed |
| Double-sale guard | partial `UNIQUE (event_id, seat_id) WHERE status='VALID'` on tickets |
| Hold expiry | lazy in predicate + sweeper with SKIP LOCKED |
| Anti-hoarding | partial unique index: one ACTIVE hold per user per event |
| Payment | hold TTL = deadline; late payment: re-hold or refund |
| Seat map | Redis bitmap + CDN, CDC-fed, ~1 s stale |
| Spike | waiting room, signed admission tokens, admit rate tied to hold p99 |
| Shard key | `event_id` |

- Seats have identity; count only for GA.
- The ticket unique index is your invariant; state transitions are your behaviour.
- Never hold a transaction open across a payment.
- SKIP LOCKED for "any", NOWAIT for "this one".
- Expired holds must never block — put expiry in the predicate.
- The waiting room is the real scaling lever for a mega on-sale.
- The seat map is a picture of the past; only the hold transaction speaks for the present.

## 11. Hands-On Exercises

Lab: `docker run --rm -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:17`, then `psql -h localhost -U postgres`.

1. **Double sale, then prevention.** Create `event_seats` with one seat. In two sessions run `SELECT status` then `UPDATE ... SET status='HELD'` without a predicate; observe both "win". Repeat with the conditional UPDATE and observe one update 0 rows. Finally drop the guards, insert two tickets for the same seat and watch the partial unique index reject the second.
2. **SKIP LOCKED vs FOR UPDATE.** Create a section of 20 seats. Open three sessions; in each run `BEGIN; SELECT ... ORDER BY quality LIMIT 2 FOR UPDATE SKIP LOCKED;` and note the disjoint results. Repeat with plain `FOR UPDATE` and observe sessions 2 and 3 block.
3. **NOWAIT.** Lock seat 1 in session A. In session B run `SELECT ... WHERE seat_id = 1 FOR UPDATE NOWAIT` and read the 55P03 error text.
4. **Lazy expiry.** Hold a seat with `held_until = now() - interval '1 second'`. Without running the sweeper, hold it from another user with the exact-seat UPDATE and show it succeeds; show best-available does not see it until the sweeper runs.
5. **Load test.** Use `pgbench` with a custom script that holds 2 best-available seats in a 5,000-seat section at 64 clients. Record TPS and lock waits; then change `SKIP LOCKED` to plain `FOR UPDATE` and compare.

**Mini project:** implement hold, confirm, release, sweeper and a toy waiting room (Redis `INCR` for positions, an admitter advancing a counter). Simulate an on-sale: 50,000 simulated users, 5,000 seats, random payment times with a long tail, 5% abandonment. Verify at the end: sold + available + blocked = 5,000, no seat has two valid tickets, every payment either has a booking or a refund event, and the database never saw more concurrent transactions than your admission cap.

## 12. Related Topics & Free Learning Resources

**Concept chapters this design applies:** [Ch 04 · Concurrency Control](topic.html?p=04-concurrency-control) (conditional writes, optimistic transitions) · [Ch 05 · Locking Internals](topic.html?p=05-locking-internals) (SKIP LOCKED, NOWAIT, lock_timeout, deadlocks) · [Ch 10 · Consistency Models](topic.html?p=10-consistency-models) · [Ch 11 · Partitioning](topic.html?p=11-partitioning) · [Ch 12 · Sharding](topic.html?p=12-sharding) · [Ch 19 · Database Caching Architecture](topic.html?p=19-database-caching-architecture) · [Ch 20 · Database + Application](topic.html?p=20-database-application-architecture) · [Ch 21 · Database Scaling](topic.html?p=21-database-scaling) · [Ch 29 · Advanced Database Patterns](topic.html?p=29-advanced-database-patterns) (outbox, CDC-fed read models).

**Related case studies:** [Ch 31 · E-commerce](topic.html?p=31-case-ecommerce) (counted inventory, reservations) · [Ch 39 · Payment System](topic.html?p=39-case-payment-system).

**SQL Handbook:** [Locking & MVCC](../sql/topic.html?p=27-locking-mvcc) · [Keys & Constraints](../sql/topic.html?p=29-keys-constraints) · [Index Design](../sql/topic.html?p=20-index-design) · [Transactions & ACID](../sql/topic.html?p=25-transactions-acid).

**Other handbooks:** [Caching with Redis · Sorted Sets & Rate Limiting](../redis-caching/topic.html?p=19-sorted-sets-rate-limiting) · [Caching with Redis · Hot Keys & Avalanche](../redis-caching/topic.html?p=17-hot-keys-avalanche) · [Kafka & RabbitMQ · Idempotency & Outbox](../messaging/topic.html?p=21-idempotency-outbox).

- **PostgreSQL docs — The Locking Clause (SKIP LOCKED, NOWAIT)** — PostgreSQL · *Intermediate* · exact semantics of the two tools this design depends on. <https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE>
- **PostgreSQL docs — Partial Indexes** — PostgreSQL · *Intermediate* · why `WHERE status = 'VALID'` and `WHERE status = 'AVAILABLE'` indexes work. <https://www.postgresql.org/docs/current/indexes-partial.html>
- **PostgreSQL docs — Client Connection Defaults (lock_timeout, idle_in_transaction_session_timeout)** — PostgreSQL · *Intermediate* · the timeouts that keep an on-sale from draining the pool. <https://www.postgresql.org/docs/current/runtime-config-client.html>
- **MySQL docs — Locking Reads (NOWAIT and SKIP LOCKED)** — MySQL · *Intermediate* · the InnoDB variant, including gap-lock caveats. <https://dev.mysql.com/doc/refman/8.0/en/innodb-locking-reads.html>
- **Microservices Patterns — Transactional Outbox** — Chris Richardson · *Intermediate* · how seat changes reach the seat-map cache reliably. <https://microservices.io/patterns/data/transactional-outbox.html>
- **Designing Data-Intensive Applications, ch. 7** — Martin Kleppmann · *Advanced* · write skew and materializing conflicts — the theory behind per-seat rows. <https://dataintensive.net/>

---

*Database Design Handbook — chapter 33.*
