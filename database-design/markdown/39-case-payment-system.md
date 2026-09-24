# 39 · Case Study: Payment System

> **In one line:** A payment system cannot have exactly-once delivery anywhere — not from the client, not to the processor, not from webhooks — so it builds the *illusion* of exactly-once from **at-least-once everywhere plus idempotency at every hop**, records every movement of money in an **append-only double-entry ledger**, drives each payment through a **guarded state machine** that admits "unknown", and proves itself daily by **reconciliation** against the outside world.

---

## 1. Overview

> **Builds on:** [SQL Handbook · Transactions & ACID](../sql/topic.html?p=25-transactions-acid) · [SQL Handbook · Keys & Constraints](../sql/topic.html?p=29-keys-constraints) · [Ch 04 · Concurrency Control](topic.html?p=04-concurrency-control) · [Ch 06 · Isolation Deep Dive](topic.html?p=06-isolation-deep-dive) · [Ch 13 · Distributed Transactions](topic.html?p=13-distributed-transactions). The internal ledger for account-to-account transfers is designed in depth in [Ch 32 · Banking Ledger](topic.html?p=32-case-banking); this chapter focuses on the part a bank ledger does not have: **talking to external payment processors that can time out, retry, and call you back**. For generic outbox/inbox mechanics see [Kafka & RabbitMQ · Idempotency & Outbox](../messaging/topic.html?p=21-idempotency-outbox).

### The product

You are building the payments platform of a marketplace (or a Stripe-like API for merchants). Merchants' backends call your API; you call one or more **PSPs** (payment service providers — card acquirers, wallets, bank-transfer rails); the PSPs send you webhooks and, every day, a **settlement file** saying what money actually moved.

**Functional requirements**

- `POST /payments` — create and authorise a card payment; optionally capture immediately.
- Capture (full or partial), void an authorisation, refund (full or partial, multiple times).
- Receive PSP webhooks (authorised, captured, refunded, disputed, settled).
- Pay out merchant balances to their bank accounts.
- Daily reconciliation against PSP settlement files and bank statements.
- Full audit trail: who did what, when, and why, for every cent.

**Non-functional requirements**

- **Never double-charge**, never lose a successful charge, never pay out money that has not settled.
- A merchant retrying `POST /payments` with the same idempotency key gets the same result, byte for byte.
- API p99 < 2 s (dominated by the PSP); availability 99.99% for accepting payments.
- **RPO = 0** for every acknowledged operation; the ledger must balance at all times.
- Data retention for regulatory purposes (years), PCI DSS scope minimised (card numbers are tokenised by a vault or the PSP; your database never stores a PAN).

### Workload estimate

| Quantity | Estimate | Notes |
|---|---|---|
| Payments | 30 M/day → ~350/s avg, ~3,000/s peak (Black Friday ≈ 10×) | |
| API requests including retries | ~1.2× payments | merchants retry on timeouts |
| PSP calls | ~2.5 per payment | authorise, capture, occasional status query |
| Webhooks received | ~3 per payment → ~100 M/day | duplicates are common |
| Refunds | ~2–5% of payments | |
| Ledger postings | ~6 per captured payment → ~180 M rows/day | capture, fees, settlement, payout legs |
| Ledger growth | ~100 B/row + indexes → on the order of 20–30 GB/day, ~8–10 TB/year | partitioned monthly, retained 7–10 years |
| Idempotency keys | 30 M+ rows/day, retained ~24 h–7 d | high churn |
| Read : write | ~3 : 1 | payments are write-heavy; dashboards read replicas |

This is a **modest** throughput for Postgres. The difficulty is not scale — it is correctness under partial failure. Most of this chapter would be identical at 30 payments per second.

### Why the naive design breaks

```python
def create_payment(req):
    p = db.insert("payments", amount=req.amount, status="pending")
    result = psp.charge(card=req.token, amount=req.amount)      # network call
    db.update("payments", p.id, status="paid" if result.ok else "failed")
    db.update("merchants", req.merchant, balance=F("balance") + req.amount)
    return {"id": p.id, "status": ...}
```

- The merchant's HTTP call times out and they retry: **two payments, two charges**.
- `psp.charge` times out: was the card charged? The code marks it `failed`; the customer was charged; the merchant ships nothing; support tickets follow.
- The process crashes after the charge and before the update: a charge exists at the PSP that your database has never heard of.
- `balance = balance + amount` is a mutable number with no history: when it is wrong (and it will be), nobody can explain why.
- Webhooks for the same event arrive twice and are applied twice.
- `amount` is a float somewhere in the stack, and 0.1 + 0.2 ≠ 0.3.

## 2. Core Concepts

Entities and the invariants that must hold:

- **Money** — an integer amount in **minor units** plus an ISO-4217 currency (`bigint amount_minor, char(3) currency`). Currencies have different exponents (JPY 0, USD 2, KWD 3). *Invariant:* **never floating point; never add amounts of different currencies.**
- **Payment** — the merchant-facing object: amount, currency, merchant, status, captured and refunded totals. *Invariant:* `refunded_minor <= captured_minor <= authorized_minor`.
- **Payment attempt** — one try at one PSP, with **its own idempotency key sent to the PSP**. A payment may have several attempts (retry on another PSP after a decline). *Invariant:* at most one attempt can succeed.
- **State machine** — `created → authorizing → authorized → capturing → captured → settled`, with `failed`, `canceled`, `refunded` / `partially_refunded` branches and an explicit **unknown** outcome while a PSP call is unresolved. *Invariant:* **only allowed transitions; every transition recorded.**
- **Idempotency key** — merchant-supplied key on each mutating request, stored with a **request fingerprint** and the **stored response**. *Invariant:* **same key + same request ⇒ same response; same key + different request ⇒ error.**
- **Ledger (double-entry)** — journal entries made of postings to accounts; each posting is a signed amount. *Invariant:* **for every entry and every currency, the postings sum to zero** ("debits = credits"), and **postings are never updated or deleted** — corrections are reversing entries.
- **Account** — a ledger account (merchant payable, PSP receivable, fee revenue, bank cash, refunds clearing…). Its balance is the sum of its postings.
- **Webhook event** — an inbound notification with a PSP event id. *Invariant:* **each PSP event id is applied at most once.**
- **Settlement / reconciliation** — matching the PSP's statement of what settled against the ledger. *Invariant:* **every difference ("break") is detected, classified and resolved** — the ledger is proven, not assumed.

## 3. Theory & Principles

### Access patterns, ranked

| # | Pattern | Rate | Consistency |
|---|---|---|---|
| 1 | Create/confirm payment with idempotency key | ~3 K/s peak | Strong (single DB); external call outside the transaction |
| 2 | Apply PSP result / webhook: transition + postings | ~3–10 K/s | Strong, idempotent |
| 3 | Get payment by id (merchant API, dashboard) | ~10 K/s | Read-your-writes for the merchant |
| 4 | Capture / refund / void | ~1 K/s | Strong, guarded by state and amounts |
| 5 | Resolve unknown attempts (status query to PSP) | bursts during PSP incidents | Strong |
| 6 | Merchant balance for payout | ~10/s | Exact, from the ledger |
| 7 | Daily reconciliation | batch, millions of lines | Exact |
| 8 | Reporting, dashboards | high, stale OK | Replicas / warehouse |

### The exactly-once illusion

Every arrow in a payment flow is a network hop, and every network hop can deliver a message zero, one or several times, or deliver it and lose the reply. There is no protocol that fixes that ([Ch 13 · Distributed Transactions](topic.html?p=13-distributed-transactions)). What you *can* do is make every receiver **idempotent**, and then make every sender **retry until it gets a definitive answer**. At-least-once delivery × idempotent processing = exactly-once *effect*.

| Hop | Duplicate source | Dedup mechanism |
|---|---|---|
| Merchant → your API | client retry after timeout | `idempotency_keys (merchant_id, key)` + stored response |
| Your API → PSP | your retry after timeout | PSP idempotency key = your `attempt_id` |
| PSP → your webhook endpoint | PSP redelivery until 2xx | `webhook_events (psp, psp_event_id)` primary key |
| Your services → each other | outbox relay / consumer redelivery | inbox table keyed by message id |
| Ledger postings | any of the above replayed | `UNIQUE (payment_id, entry_kind, attempt/refund id)` on journal entries |

Break any one link and a duplicate leaks through. The last row is the backstop: even if every dedup above fails, the ledger refuses to post "capture of attempt 881" twice.

### The state machine, with unknown

```svg
<svg viewBox="0 0 880 520" width="100%" height="520" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c39a1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="c39a2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
    <marker id="c39a3" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#d97706"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Payment state machine: guarded transitions and the unknown outcome</text>
  <rect x="20" y="60" width="110" height="44" rx="8" fill="#f1f5f9" stroke="#94a3b8" stroke-width="2"/>
  <text x="75" y="87" text-anchor="middle" fill="#1e293b" font-weight="bold">created</text>
  <rect x="170" y="60" width="120" height="44" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="230" y="80" text-anchor="middle" fill="#1e293b" font-weight="bold">authorizing</text>
  <text x="230" y="96" text-anchor="middle" fill="#92400e">PSP call in flight</text>
  <rect x="340" y="60" width="120" height="44" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="400" y="87" text-anchor="middle" fill="#1e293b" font-weight="bold">authorized</text>
  <rect x="510" y="60" width="110" height="44" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="565" y="87" text-anchor="middle" fill="#1e293b" font-weight="bold">capturing</text>
  <rect x="660" y="60" width="100" height="44" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="710" y="87" text-anchor="middle" fill="#1e293b" font-weight="bold">captured</text>
  <rect x="780" y="60" width="84" height="44" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="822" y="87" text-anchor="middle" fill="#1e293b" font-weight="bold">settled</text>
  <path d="M132,82 L168,82" stroke="#2563eb" stroke-width="2" marker-end="url(#c39a1)"/>
  <path d="M292,82 L338,82" stroke="#2563eb" stroke-width="2" marker-end="url(#c39a1)"/>
  <path d="M462,82 L508,82" stroke="#2563eb" stroke-width="2" marker-end="url(#c39a1)"/>
  <path d="M622,82 L658,82" stroke="#2563eb" stroke-width="2" marker-end="url(#c39a1)"/>
  <path d="M762,82 L778,82" stroke="#2563eb" stroke-width="2" marker-end="url(#c39a1)"/>
  <rect x="170" y="170" width="120" height="44" rx="8" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="230" y="197" text-anchor="middle" fill="#1e293b" font-weight="bold">failed</text>
  <path d="M230,106 L230,168" stroke="#dc2626" stroke-width="2" marker-end="url(#c39a2)"/>
  <text x="238" y="140" fill="#991b1b">declined</text>
  <rect x="340" y="170" width="120" height="44" rx="8" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="400" y="197" text-anchor="middle" fill="#1e293b" font-weight="bold">canceled</text>
  <path d="M400,106 L400,168" stroke="#dc2626" stroke-width="2" marker-end="url(#c39a2)"/>
  <text x="408" y="140" fill="#991b1b">void / auth expired</text>
  <rect x="640" y="170" width="140" height="44" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="710" y="190" text-anchor="middle" fill="#1e293b" font-weight="bold">partially_refunded</text>
  <text x="710" y="206" text-anchor="middle" fill="#5b21b6">/ refunded</text>
  <path d="M710,106 L710,168" stroke="#7c3aed" stroke-width="2" marker-end="url(#c39a1)"/>
  <text x="718" y="140" fill="#5b21b6">refund(s)</text>
  <rect x="20" y="250" width="840" height="120" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="440" y="272" text-anchor="middle" fill="#92400e" font-size="12" font-weight="bold">The unknown outcome: a PSP timeout is NOT a failure</text>
  <text x="40" y="294" fill="#334155">The payment stays in authorizing (attempt.outcome = unknown). It is never moved to failed on a timeout.</text>
  <text x="40" y="312" fill="#334155">Resolution: (a) retry the SAME request with the SAME PSP idempotency key (attempt_id), which returns the original result;</text>
  <text x="40" y="330" fill="#334155">(b) query the PSP for the attempt's status; (c) the webhook arrives. Whichever comes first applies the guarded transition.</text>
  <text x="40" y="348" fill="#334155">Never start a NEW attempt (new key, maybe another PSP) while an old attempt is unknown: that is how double charges happen.</text>
  <rect x="20" y="390" width="840" height="116" rx="10" fill="#f8fafc" stroke="#94a3b8" stroke-width="2"/>
  <text x="440" y="412" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="bold">Every transition is a compare-and-set</text>
  <text x="40" y="436" fill="#1e293b" font-family="ui-monospace,monospace">UPDATE payments SET status = 'authorized', version = version + 1</text>
  <text x="40" y="454" fill="#1e293b" font-family="ui-monospace,monospace"> WHERE payment_id = $1 AND status = 'authorizing'</text>
  <text x="40" y="478" fill="#334155">0 rows = someone else (webhook, resolver, duplicate response) already moved it: read the current state and do nothing blind.</text>
  <text x="40" y="496" fill="#334155">The same statement's transaction posts the ledger entry, so state and money never disagree.</text>
</svg>
```

### Consistency boundaries

Everything that must agree — payment state, attempt state, idempotency record, ledger entries, outbox — lives in **one Postgres database** and changes in **one local transaction** per step. This is the most important design decision in the chapter: payments at this throughput fit comfortably in one well-provisioned primary (with synchronous standbys), and keeping the ledger and the state machine in the same database means you never need a distributed transaction *inside* your own system. The only non-transactional boundary is the PSP, and it is handled by idempotency and reconciliation, not by locking.

The PSP call happens **between** transactions, never inside one. Holding a database transaction (and its row locks, and its snapshot pinning the xmin horizon — [Ch 03 · MVCC](topic.html?p=03-mvcc)) open across a two-second network call to a third party is how a PSP slowdown becomes a database outage ([Ch 20 · Database + Application](topic.html?p=20-database-application-architecture)).

## 4. Architecture & Workflow

```svg
<svg viewBox="0 0 880 560" width="100%" height="560" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c39b1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="c39b2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
    <marker id="c39b3" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Payment request: three short transactions around one external call</text>
  <rect x="20" y="40" width="130" height="50" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="85" y="62" text-anchor="middle" fill="#1e293b" font-weight="bold">Merchant</text>
  <text x="85" y="78" text-anchor="middle" fill="#334155">Idempotency-Key: k1</text>
  <rect x="190" y="40" width="150" height="50" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="265" y="62" text-anchor="middle" fill="#1e293b" font-weight="bold">Payments API</text>
  <text x="265" y="78" text-anchor="middle" fill="#334155">stateless workers</text>
  <path d="M152,65 L188,65" stroke="#2563eb" stroke-width="2" marker-end="url(#c39b1)"/>
  <rect x="720" y="40" width="140" height="50" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="790" y="62" text-anchor="middle" fill="#1e293b" font-weight="bold">PSP</text>
  <text x="790" y="78" text-anchor="middle" fill="#334155">Idempotency-Key: att_881</text>
  <rect x="20" y="112" width="840" height="64" rx="8" fill="#ffffff" stroke="#2563eb"/>
  <text x="40" y="132" fill="#1e3a8a" font-weight="bold">Tx 1 (ms): claim the key</text>
  <text x="40" y="150" fill="#334155">INSERT idempotency_keys (merchant, k1, fingerprint, locked_at) ON CONFLICT DO NOTHING; if exists: completed = replay response,</text>
  <text x="40" y="166" fill="#334155">in progress = 409, fingerprint differs = 422. New: INSERT payment (authorizing) + attempt att_881 (pending); recovery_point = attempt_created.</text>
  <rect x="20" y="190" width="840" height="50" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="40" y="210" fill="#92400e" font-weight="bold">External call (no transaction open): POST /authorize, key att_881, timeout 10 s</text>
  <text x="40" y="228" fill="#334155">ok / declined: definitive. timeout / 5xx / connection reset: UNKNOWN; retry with the same key, else leave for the resolver.</text>
  <path d="M790,92 L790,188" stroke="#d97706" stroke-width="2" marker-end="url(#c39b1)"/>
  <rect x="20" y="254" width="840" height="64" rx="8" fill="#ffffff" stroke="#16a34a"/>
  <text x="40" y="274" fill="#166534" font-weight="bold">Tx 2 (ms): apply the result</text>
  <text x="40" y="292" fill="#334155">guarded transition authorizing to authorized/failed; attempt result + PSP ref; ledger entry if money moved; outbox event;</text>
  <text x="40" y="308" fill="#334155">idempotency_keys: status = completed, response_code, response_body. COMMIT, then reply. A retry of k1 now replays this response.</text>
  <rect x="20" y="340" width="260" height="96" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="150" y="362" text-anchor="middle" fill="#1e293b" font-weight="bold">Webhook receiver</text>
  <text x="150" y="380" text-anchor="middle" fill="#334155">verify signature</text>
  <text x="150" y="396" text-anchor="middle" fill="#334155">INSERT webhook_events ON CONFLICT</text>
  <text x="150" y="412" text-anchor="middle" fill="#334155">(psp, event_id) DO NOTHING; 200</text>
  <text x="150" y="428" text-anchor="middle" fill="#334155">apply async via guarded transition</text>
  <rect x="310" y="340" width="260" height="96" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="440" y="362" text-anchor="middle" fill="#1e293b" font-weight="bold">Unknown resolver</text>
  <text x="440" y="380" text-anchor="middle" fill="#334155">attempts WHERE outcome = unknown</text>
  <text x="440" y="396" text-anchor="middle" fill="#334155">FOR UPDATE SKIP LOCKED</text>
  <text x="440" y="412" text-anchor="middle" fill="#334155">GET /payments?key=att_881 at PSP</text>
  <text x="440" y="428" text-anchor="middle" fill="#334155">same guarded transition as Tx 2</text>
  <rect x="600" y="340" width="260" height="96" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="730" y="362" text-anchor="middle" fill="#1e293b" font-weight="bold">Reconciliation (daily)</text>
  <text x="730" y="380" text-anchor="middle" fill="#334155">load PSP settlement file</text>
  <text x="730" y="396" text-anchor="middle" fill="#334155">FULL JOIN vs ledger by psp_ref</text>
  <text x="730" y="412" text-anchor="middle" fill="#334155">classify breaks, open cases</text>
  <text x="730" y="428" text-anchor="middle" fill="#334155">post settlement entries</text>
  <path d="M790,92 C860,200 860,300 150,338" stroke="#7c3aed" stroke-width="2" fill="none" marker-end="url(#c39b2)"/>
  <text x="826" y="300" fill="#5b21b6">webhooks</text>
  <rect x="20" y="458" width="840" height="86" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="440" y="480" text-anchor="middle" fill="#1e3a8a" font-size="12" font-weight="bold">One Postgres primary + 2 synchronous standbys (ANY 1): payments, attempts, idempotency_keys, ledger, webhook_events, outbox</text>
  <text x="440" y="500" text-anchor="middle" fill="#334155">every write path above is a short local transaction on the same database; the ledger and the state machine never disagree</text>
  <text x="440" y="520" text-anchor="middle" fill="#334155">outbox to Kafka for merchants' webhooks, analytics, risk; replicas and warehouse for dashboards</text>
  <path d="M265,92 L265,110" stroke="#2563eb" stroke-width="2" marker-end="url(#c39b3)"/>
</svg>
```

### Idempotency key lifecycle

This follows the well-known Stripe-style design (see Brandur Leach's write-up in the resources):

```text
state of (merchant_id, key)        request arrives with same key
─────────────────────────────      ─────────────────────────────────────────────────────────────
absent                             insert, lock, process
in progress, locked < 90 s ago     409 Conflict "request in progress" (client retries later)
in progress, lock stale (crash)    take over the lock; resume from recovery_point
completed                          fingerprint equal  -> replay stored status + body, no side effects
                                   fingerprint differs -> 422 "key reused with different parameters"
expired (deleted after 24 h)       treated as absent (document the window to merchants)
```

**Recovery points** let a request that crashed halfway resume instead of restarting: `started → attempt_created → psp_called → finished`. Because the PSP call uses the **attempt id** as the PSP's idempotency key, resuming from `attempt_created` re-sends the *same* PSP request and gets the *original* answer, not a second charge.

### Ledger postings for one card payment

```text
                                      psp_receivable   merchant_payable   fee_revenue   bank_cash   psp_fees
capture 100.00, platform fee 2.90        +100.00          -100.00
                                                            +2.90            -2.90
PSP settles (net of 0.80 PSP fee)        -100.00                                         +99.20      +0.80
payout to merchant 97.10                                   +97.10                        -97.10
refund 20.00 (fee not returned)          -20.00            +20.00
────────────────────────────────────────────────────────────────────────────────────────────────────────────
signs: + debit, - credit (asset/expense accounts normally debit, liability/revenue normally credit)
every row sums to zero; every account balance = sum of its postings
```

Authorisation moves no money and posts nothing (or a memo entry in a separate "holds" ledger). Money is posted at capture, settlement, payout and refund — the events that change who owes whom.

## 5. Implementation

### Money and core tables

```sql
CREATE DOMAIN money_minor AS bigint;          -- integer minor units; currency always stored next to it
CREATE DOMAIN currency_code AS char(3) CHECK (VALUE ~ '^[A-Z]{3}$');

CREATE TABLE payments (
    payment_id        bigint PRIMARY KEY,
    merchant_id       bigint NOT NULL,
    amount_minor      money_minor   NOT NULL CHECK (amount_minor > 0),
    currency          currency_code NOT NULL,
    status            text NOT NULL DEFAULT 'created' CHECK (status IN
                      ('created','authorizing','authorized','capturing','captured','settled',
                       'failed','canceled','partially_refunded','refunded')),
    authorized_minor  money_minor NOT NULL DEFAULT 0,
    captured_minor    money_minor NOT NULL DEFAULT 0,
    refunded_minor    money_minor NOT NULL DEFAULT 0,
    version           int NOT NULL DEFAULT 0,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CHECK (refunded_minor <= captured_minor AND captured_minor <= authorized_minor
           AND authorized_minor <= amount_minor)
);
CREATE INDEX payments_merchant ON payments (merchant_id, created_at DESC);

CREATE TABLE payment_attempts (
    attempt_id     bigint PRIMARY KEY,             -- also the PSP idempotency key (e.g. 'att_881')
    payment_id     bigint NOT NULL REFERENCES payments,
    psp            text   NOT NULL,
    operation      text   NOT NULL CHECK (operation IN ('authorize','capture','void','refund')),
    amount_minor   money_minor NOT NULL,
    outcome        text   NOT NULL DEFAULT 'pending'
                   CHECK (outcome IN ('pending','succeeded','declined','unknown','error')),
    psp_ref        text,                           -- PSP's id for the operation, used in reconciliation
    decline_code   text,
    next_check_at  timestamptz,                    -- for the unknown resolver
    created_at     timestamptz NOT NULL DEFAULT now(),
    resolved_at    timestamptz
);
-- At most one successful authorisation per payment, whatever happens upstream:
CREATE UNIQUE INDEX one_successful_auth ON payment_attempts (payment_id)
    WHERE operation = 'authorize' AND outcome = 'succeeded';
-- At most one in-flight or unknown authorisation per payment: blocks "just try another PSP" while unknown
CREATE UNIQUE INDEX one_open_auth ON payment_attempts (payment_id)
    WHERE operation = 'authorize' AND outcome IN ('pending','unknown');
CREATE INDEX attempts_unknown ON payment_attempts (next_check_at) WHERE outcome = 'unknown';
CREATE UNIQUE INDEX attempts_psp_ref ON payment_attempts (psp, psp_ref) WHERE psp_ref IS NOT NULL;

CREATE TABLE payment_events (                      -- append-only audit of transitions
    payment_id  bigint NOT NULL,
    seq         int    NOT NULL,
    from_status text, to_status text NOT NULL,
    actor       text   NOT NULL,                   -- 'api:merchant_42', 'webhook:adyen', 'resolver', 'ops:alice'
    request_id  text,
    at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (payment_id, seq)
);
```

The two partial unique indexes are the database-level guarantee against the classic double charge: no code path, however buggy, can record two successful authorisations for one payment or start a second authorisation while the first is unresolved.

> **MySQL difference:** MySQL has no partial indexes. Emulate `one_open_auth` with a generated column that is `payment_id` when the attempt is open and `NULL` otherwise, and put a unique index on it (InnoDB unique indexes allow multiple `NULL`s). There are also no `DOMAIN`s; use `BIGINT` + `CHAR(3)` with `CHECK` constraints (enforced since 8.0.16).

### Idempotency keys

```sql
CREATE TABLE idempotency_keys (
    merchant_id      bigint NOT NULL,
    idem_key         text   NOT NULL CHECK (length(idem_key) <= 255),
    request_method   text   NOT NULL,
    request_path     text   NOT NULL,
    request_hash     bytea  NOT NULL,              -- sha256 of canonicalised body + method + path
    status           text   NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed')),
    recovery_point   text   NOT NULL DEFAULT 'started',
    locked_at        timestamptz,                  -- NULL when not being processed
    payment_id       bigint,
    response_code    int,
    response_body    jsonb,
    created_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (merchant_id, idem_key)
);
CREATE INDEX idempotency_keys_created ON idempotency_keys (created_at);  -- for the 24 h expiry job
```

**Tx 1 — claim the key** (the critical, concurrency-sensitive transaction):

```sql
BEGIN;
INSERT INTO idempotency_keys (merchant_id, idem_key, request_method, request_path, request_hash, locked_at)
VALUES (42, 'order-7781-pay', 'POST', '/v1/payments', '\x9f2c...', now())
ON CONFLICT (merchant_id, idem_key) DO NOTHING
RETURNING recovery_point;
-- 1 row: brand new -> continue below.
-- 0 rows: the key exists. Lock it and decide:
SELECT status, request_hash, recovery_point, locked_at, response_code, response_body, payment_id
  FROM idempotency_keys
 WHERE merchant_id = 42 AND idem_key = 'order-7781-pay'
   FOR UPDATE;
--   request_hash differs                       -> ROLLBACK; 422
--   status = 'completed'                       -> ROLLBACK; replay response_code/response_body
--   locked_at > now() - interval '90 seconds'  -> ROLLBACK; 409 (another worker is on it)
--   otherwise (stale lock after a crash)       -> UPDATE ... SET locked_at = now(); resume at recovery_point

-- New request: create the payment and the attempt in the same transaction
INSERT INTO payments (payment_id, merchant_id, amount_minor, currency, status)
VALUES (700001, 42, 4999, 'EUR', 'authorizing');
INSERT INTO payment_attempts (attempt_id, payment_id, psp, operation, amount_minor)
VALUES (881, 700001, 'adyen', 'authorize', 4999);
INSERT INTO payment_events (payment_id, seq, from_status, to_status, actor, request_id)
VALUES (700001, 1, 'created', 'authorizing', 'api:merchant_42', 'req_5c1');
UPDATE idempotency_keys SET recovery_point = 'attempt_created', payment_id = 700001
 WHERE merchant_id = 42 AND idem_key = 'order-7781-pay';
COMMIT;
```

Two concurrent requests with the same key: the second `INSERT ... ON CONFLICT` blocks on the first's uncommitted unique-index entry, then sees the committed row and falls into the `SELECT ... FOR UPDATE` branch, where the fresh `locked_at` tells it to return 409. There is no window in which both create a payment. The request hash stops a merchant bug that reuses keys across different orders from silently returning the wrong payment.

**Tx 2 — apply a definitive PSP result** (called by the request path, the webhook applier and the unknown resolver alike — one function, three callers):

```sql
BEGIN;
-- Attempt: only a pending/unknown attempt can be resolved; a second resolution is a no-op.
UPDATE payment_attempts
   SET outcome = 'succeeded', psp_ref = 'ADY-8812736', resolved_at = now()
 WHERE attempt_id = 881 AND outcome IN ('pending','unknown')
RETURNING payment_id;
-- 0 rows -> already resolved by someone else: COMMIT and return the current state.

UPDATE payments
   SET status = 'authorized', authorized_minor = 4999, version = version + 1, updated_at = now()
 WHERE payment_id = 700001 AND status = 'authorizing'
RETURNING version;

INSERT INTO payment_events (payment_id, seq, from_status, to_status, actor)
VALUES (700001, 2, 'authorizing', 'authorized', 'api:merchant_42');

INSERT INTO outbox (topic, msg_key, payload)
VALUES ('payment.events', '700001', '{"type":"payment.authorized","payment_id":700001,"amount_minor":4999,"currency":"EUR"}');

UPDATE idempotency_keys
   SET status = 'completed', recovery_point = 'finished', locked_at = NULL,
       response_code = 201, response_body = '{"id":"pay_700001","status":"authorized"}'
 WHERE merchant_id = 42 AND idem_key = 'order-7781-pay';
COMMIT;
```

Storing the response **in the same transaction** as the state change is what makes replays exact: there is no moment when the payment is authorised but the key would replay something else.

### The double-entry ledger

```sql
CREATE TABLE ledger_accounts (
    account_id   bigint PRIMARY KEY,
    code         text   NOT NULL UNIQUE,           -- 'merchant_payable:42:EUR', 'psp_receivable:adyen:EUR'
    kind         text   NOT NULL CHECK (kind IN ('asset','liability','revenue','expense','equity')),
    currency     currency_code NOT NULL
);

CREATE TABLE journal_entries (
    entry_id      bigint GENERATED ALWAYS AS IDENTITY,
    entry_kind    text   NOT NULL,                 -- 'capture','fee','settlement','refund','payout','reversal'
    payment_id    bigint,
    source_ref    text   NOT NULL,                 -- attempt id / refund id / settlement line: the dedup key
    effective_on  date   NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    reverses      bigint,                          -- entry_id this one reverses, if any
    PRIMARY KEY (entry_id, effective_on),
    UNIQUE (entry_kind, source_ref, effective_on)  -- ledger-level idempotency backstop
) PARTITION BY RANGE (effective_on);

CREATE TABLE postings (
    entry_id      bigint NOT NULL,
    effective_on  date   NOT NULL,
    account_id    bigint NOT NULL REFERENCES ledger_accounts,
    amount_minor  money_minor NOT NULL CHECK (amount_minor <> 0),   -- + debit, - credit
    currency      currency_code NOT NULL,
    FOREIGN KEY (entry_id, effective_on) REFERENCES journal_entries (entry_id, effective_on)
) PARTITION BY RANGE (effective_on);
CREATE INDEX postings_account ON postings (account_id, effective_on);
-- monthly partitions for both tables, created ahead of time by a job
```

Note the partition key is in every unique constraint, as partitioned tables require ([Ch 11 · Partitioning](topic.html?p=11-partitioning)). Because `effective_on` is part of the dedup key, the ledger service always derives it deterministically from the source event (for example, the capture's business date), so a replay lands on the same key.

**Enforce "debits = credits" in the database**, at commit, per entry and per currency:

```sql
CREATE FUNCTION assert_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM postings
              WHERE entry_id = NEW.entry_id AND effective_on = NEW.effective_on
              GROUP BY currency HAVING sum(amount_minor) <> 0) THEN
    RAISE EXCEPTION 'journal entry % is unbalanced', NEW.entry_id USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER postings_balanced
  AFTER INSERT ON postings
  DEFERRABLE INITIALLY DEFERRED                      -- checked at COMMIT, after all legs are inserted
  FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();

-- Append-only: the application role can insert, never change history
REVOKE UPDATE, DELETE, TRUNCATE ON journal_entries, postings FROM payments_app;
CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ledger is append-only; post a reversing entry'; END $$;
CREATE TRIGGER postings_immutable BEFORE UPDATE OR DELETE ON postings
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
```

(Trigger support on partitioned parents has grown release by release; if your version rejects either trigger on the parent table, have the job that pre-creates monthly partitions also create both triggers on each new partition — test this in CI, because a partition without the trigger silently loses the invariant.)

**Posting a capture with fee** — inside the same transaction that moves the payment to `captured`:

```sql
WITH e AS (
  INSERT INTO journal_entries (entry_kind, payment_id, source_ref, effective_on)
  VALUES ('capture', 700001, 'att_902', DATE '2026-09-24')
  ON CONFLICT (entry_kind, source_ref, effective_on) DO NOTHING
  RETURNING entry_id, effective_on
)
INSERT INTO postings (entry_id, effective_on, account_id, amount_minor, currency)
SELECT e.entry_id, e.effective_on, a.account_id, v.amt, 'EUR'
  FROM e,
       (VALUES ('psp_receivable:adyen:EUR',  4999),
               ('merchant_payable:42:EUR',  -4999),
               ('merchant_payable:42:EUR',    145),
               ('fee_revenue:EUR',           -145)) AS v(code, amt)
  JOIN ledger_accounts a ON a.code = v.code;
-- If the entry already existed (replay), e is empty and no postings are inserted.
```

**Balances.** A merchant's payable balance is `sum(amount_minor)` over its account's postings. Summing years of postings per payout is slow, so keep a **balance snapshot** per account per day (`account_daily_balances(account_id, day, closing_minor)`) computed by a job from immutable postings, and compute today's balance as the last snapshot plus today's postings — an index range scan on `postings_account`. Do **not** keep a running `balance = balance + x` row for system accounts like `psp_receivable`: every payment in the platform touches it, and a single hot row would serialise all captures ([Ch 04 · Concurrency Control](topic.html?p=04-concurrency-control)). For merchant accounts a running balance is fine if you need it for synchronous overdraft checks, because contention per merchant is low.

### Webhooks

```sql
CREATE TABLE webhook_events (
    psp           text   NOT NULL,
    psp_event_id  text   NOT NULL,
    event_type    text   NOT NULL,
    payload       jsonb  NOT NULL,
    received_at   timestamptz NOT NULL DEFAULT now(),
    processed_at  timestamptz,
    PRIMARY KEY (psp, psp_event_id)
);
CREATE INDEX webhook_unprocessed ON webhook_events (received_at) WHERE processed_at IS NULL;
```

The HTTP handler verifies the PSP's signature, does `INSERT ... ON CONFLICT DO NOTHING`, and returns 200 immediately — it never calls business logic inline, so a slow ledger never causes the PSP to retry. A worker processes unprocessed rows with `FOR UPDATE SKIP LOCKED`, calling the same "apply result" function as Tx 2. Webhooks can arrive **before** your own Tx 2 (the PSP is fast, your response path was slow) or **out of order** (`captured` before `authorized`); the guarded transitions make both harmless — an event that cannot yet be applied is retried later, and an event describing an already-reached state is a no-op.

### Application code: the payment request flow

```go
func (s *Service) CreatePayment(ctx context.Context, m MerchantID, key string, req PaymentReq) (Resp, error) {
	claim, err := s.claimKey(ctx, m, key, req) // Tx 1: insert-or-lock the key, create payment + attempt
	switch {
	case err != nil:
		return Resp{}, err
	case claim.Replay != nil:
		return *claim.Replay, nil // completed earlier: byte-identical response, no side effects
	case claim.InProgress:
		return Resp{Code: 409}, nil
	}

	// External call with NO transaction open. The attempt id is the PSP idempotency key, so a
	// resumed or retried request re-sends the same PSP request and gets the original answer.
	res, err := s.psp.Authorize(ctx, psp.AuthReq{
		IdempotencyKey: claim.AttemptID, Amount: req.AmountMinor, Currency: req.Currency, Token: req.Token,
	})
	if isUnknown(err) { // timeout, connection reset, 5xx: we do NOT know whether money moved
		if err := s.markUnknown(ctx, claim.AttemptID, time.Now().Add(30*time.Second)); err != nil {
			return Resp{}, err
		}
		// Keep the idempotency key in progress (unlocked) at recovery point 'psp_called'.
		// The merchant's retry resumes and re-sends the same PSP request; the resolver may finish first.
		return Resp{Code: 202, Body: pendingBody(claim.PaymentID)}, nil
	}
	if err != nil {
		return Resp{}, err // definitive client-side error before sending: safe to fail the attempt
	}
	// Tx 2: guarded transitions, ledger (if captured), outbox, store response in the key row.
	return s.applyResult(ctx, claim, res)
}
```

The **unknown resolver** runs every few seconds: `SELECT ... FROM payment_attempts WHERE outcome = 'unknown' AND next_check_at < now() ORDER BY next_check_at LIMIT 100 FOR UPDATE SKIP LOCKED`, asks the PSP for the attempt's status by its idempotency key, and calls `applyResult`. If the PSP says "never received", the resolver re-sends the original request with the **same** key — never a new attempt — and backs off exponentially. After a bounded time (for example 24 h) an unresolved attempt goes to a human queue; reconciliation will settle it for certain the next day.

### Reconciliation

```sql
CREATE TABLE settlement_lines (                  -- loaded from the PSP's daily file, one row per line
    psp          text NOT NULL,
    file_id      text NOT NULL,
    line_no      int  NOT NULL,
    psp_ref      text NOT NULL,
    line_type    text NOT NULL,                  -- 'capture','refund','chargeback','fee'
    gross_minor  bigint NOT NULL,
    fee_minor    bigint NOT NULL,
    currency     char(3) NOT NULL,
    settled_on   date NOT NULL,
    PRIMARY KEY (psp, file_id, line_no)          -- loading the same file twice is a no-op
);

-- Break detection for one PSP and settlement day
WITH ours AS (
  SELECT a.psp, a.psp_ref, a.operation, a.amount_minor, p.currency
    FROM payment_attempts a JOIN payments p USING (payment_id)
   WHERE a.psp = 'adyen' AND a.outcome = 'succeeded' AND a.operation IN ('capture','refund')
     AND a.resolved_at >= DATE '2026-09-22' AND a.resolved_at < DATE '2026-09-24'   -- settlement lag window
), theirs AS (
  SELECT psp, psp_ref, line_type, gross_minor, currency
    FROM settlement_lines WHERE psp = 'adyen' AND settled_on = DATE '2026-09-24'
)
SELECT coalesce(o.psp_ref, t.psp_ref) AS psp_ref,
       CASE WHEN t.psp_ref IS NULL THEN 'missing_at_psp'         -- we think it moved; PSP does not (yet)
            WHEN o.psp_ref IS NULL THEN 'missing_in_ledger'      -- PSP moved money we never recorded
            WHEN o.amount_minor <> abs(t.gross_minor) OR o.currency <> t.currency THEN 'amount_mismatch'
            ELSE 'matched' END AS result
  FROM ours o FULL OUTER JOIN theirs t ON o.psp_ref = t.psp_ref
 WHERE t.psp_ref IS NULL OR o.psp_ref IS NULL
    OR o.amount_minor <> abs(t.gross_minor) OR o.currency <> t.currency;
```

Matched lines produce settlement journal entries (`DR bank_cash`, `DR psp_fees`, `CR psp_receivable`), keyed by `source_ref = file_id:line_no` so reloading is idempotent. Breaks become cases with owners and ageing: `missing_at_psp` often clears the next day (settlement lag); `missing_in_ledger` almost always means an unknown outcome was resolved wrongly or a webhook was lost — the most serious class, because a customer was charged for something your system does not know about.

## 6. Advantages, Disadvantages & Trade-offs

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| Where state lives | One Postgres (payments + ledger + keys + outbox) with sync standbys | Payments and ledger as separate services/databases | Keeps every internal step a local ACID transaction; throughput easily fits. Split only when a team or scale forces it — then the ledger consumes events idempotently. |
| Money type | `bigint` minor units + currency | `numeric`, `float`, `money` type | Exact, fast, currency-explicit. `numeric` is fine but slower; PG's `money` type depends on `lc_monetary` and has no currency. |
| Ledger | Append-only double-entry postings + deferred balance check | Mutable `balance` columns | Every cent explainable; corrections are reversals; invariant enforced by the DB. |
| Balances | Daily snapshots + postings since | Running balance rows on every account | Hot system accounts would serialise all payments. |
| API dedup | Idempotency key + fingerprint + stored response, locked row | Dedup by payload hash; "check then insert" | Exact replay; detects key misuse; race-free. |
| PSP dedup | Attempt id as PSP idempotency key; one open attempt enforced by index | New key per retry | A retry with a new key is a new charge. |
| Timeout handling | Explicit unknown + resolver + reconciliation | Treat timeout as failure | Timeouts often succeeded; failing them loses or double-charges. |
| External call placement | Between transactions | Inside a transaction | A slow PSP must not hold locks or pin the xmin horizon. |
| Webhooks | Store-then-ack, process async, guarded | Process inline | Fast acks, no PSP retry storms, out-of-order safe. |

### When to use this design

- Anything that moves money through a third party: marketplaces, subscriptions, wallets, payouts, ride-hailing fares, ticketing.
- The same skeleton — idempotency keys, attempts with external keys, unknown state, reconciliation — applies to *any* integration with an external side effect: sending SMS, provisioning cloud resources, booking a flight with a GDS.

### When it is overkill or wrong

- **Pure hosted checkout** where the PSP owns the whole payment and you only store "order paid" from a webhook: you need webhook dedup and reconciliation, not your own ledger.
- **Internal transfers between your own accounts** with no external rail: the harder problem there is concurrency on balances, covered in [Ch 32 · Banking Ledger](topic.html?p=32-case-banking).
- **Extreme throughput ledgers** (hundreds of thousands of postings per second across millions of accounts): a single Postgres primary is no longer enough; purpose-built ledgers (for example TigerBeetle) or sharding by account with careful cross-shard transfer protocols become necessary ([Ch 12 · Sharding](topic.html?p=12-sharding)).

## 7. Common Mistakes & Best Practices

- **Floats for money.** Rounding errors accumulate into reconciliation breaks. Use integer minor units with the currency beside them, and a per-currency exponent table.
- **Calling the PSP inside a database transaction.** A PSP slowdown holds row locks and connections; the pool drains; the whole API goes down. Instead: short transaction → external call → short transaction.
- **Timeout = failure.** The single most expensive mistake in payments. Instead: unknown state, same-key retry, status query, webhook, reconciliation.
- **A new PSP idempotency key on every retry** (or on failover to another PSP while the first attempt is unknown). Instead: the attempt id is the key; a new attempt only after the previous one is definitively declined.
- **Idempotency keys without a fingerprint.** A merchant bug reuses a key for a different order and silently gets the old payment back. Instead: hash method + path + canonical body; 422 on mismatch.
- **Storing the idempotency response outside the state-change transaction.** A crash between them leaves a key that replays nothing or the wrong thing. Instead: same transaction.
- **Mutable balances as the source of truth.** Instead: the ledger is the truth; balances are derived and verifiable (`sum(postings)` must equal the snapshot).
- **Updating or deleting ledger rows to fix mistakes.** Destroys the audit trail. Instead: reversing entries that reference the original.
- **Processing webhooks inline and trusting their order.** Instead: store, ack, process async, guarded transitions.
- **Skipping reconciliation because "the code is correct".** Reconciliation is how you *find out* whether it is. Run it daily from day one.

## 8. Production: Failure Scenarios, Monitoring & Scaling

### Scaling path

([Ch 21 · Database Scaling](topic.html?p=21-database-scaling))

- **1×** — one primary, two synchronous standbys (`synchronous_standby_names = 'ANY 1 (s1, s2)'`), PgBouncer, replicas for dashboards. At 3,000 payments/s peak with ~6 statements each, this is comfortable on modern hardware.
- **10×** — partition the ledger and `payment_events` monthly; move dashboards and exports to a warehouse via CDC; tune the idempotency-key table (it churns 30 M+ rows/day — daily partitions dropped after 48 h beat `DELETE`); keep the external-call pool separate from the DB pool.
- **100×** — shard by merchant (payments, keys, merchant accounts co-located per merchant) with the platform's system accounts split into per-shard sub-accounts that are consolidated in reporting. Cross-shard movements (platform fee to a central revenue account) become per-shard postings to per-shard sub-accounts — no cross-shard transactions ([Ch 12 · Sharding](topic.html?p=12-sharding)).

### Failure scenarios

- **At 14:00 the PSP's p99 goes from 400 ms to 30 s.** Symptom: API workers saturated, unknown attempts climbing, merchants retrying. Because no transaction is open during PSP calls, the database is fine. Responses: circuit-break the PSP (fail new attempts fast with a retryable error rather than queueing), route *new* payments to a secondary PSP, and let the resolver work through unknowns with the **same** keys once the PSP recovers. Never re-route an *unknown* attempt to the second PSP.
- **Double charge reported by a customer.** Investigation shows two successful authorisations on two different payments with the same order reference. Root cause: the merchant sent two requests with **different** idempotency keys (they generated a key per HTTP attempt). Your system behaved correctly. Mitigation: document key semantics, detect duplicates heuristically (same merchant, amount, card fingerprint within 60 s) and flag, and void automatically if the merchant opts in.
- **Reconciliation shows 312 `missing_in_ledger` lines.** Root cause: a deploy changed the webhook signature verification and rejected valid webhooks with 401 for two hours; the PSP gave up retrying; the resolver had a bug that skipped attempts older than one hour. Fix: replay from the settlement file (it is the authoritative record), fix the resolver, alert on webhook 4xx rate, and never make the resolver's window shorter than the PSP's retry window.
- **Primary failover.** With synchronous replication (`synchronous_commit = on` and a quorum standby), no acknowledged transaction is lost ([Ch 18 · High Availability](topic.html?p=18-high-availability)). The dangerous window is a PSP call in flight during failover: the request's Tx 2 fails, the attempt stays `pending`, and the resolver or the merchant's retry resolves it with the same key. Design so that every in-flight state is resumable.
- **Ledger does not balance after a migration.** Symptom: the deferred trigger starts rejecting commits with 23514. Root cause: a new fee type posted in two currencies. The trigger did its job — the bad code failed loudly instead of corrupting the ledger. This is why the invariant lives in the database, not only in the application.
- **Idempotency table bloat.** 30 M inserts + 30 M updates + 30 M deletes per day in one heap produces heavy autovacuum load ([Ch 03 · MVCC](topic.html?p=03-mvcc)). Fix: partition by day and drop partitions older than the key-retention window; set `fillfactor` so completion updates are HOT.

### Monitoring

| Metric | Why | Alert when |
|---|---|---|
| Unknown attempts: count and oldest age, per PSP | PSP trouble; double-charge risk | oldest > 5 min |
| Reconciliation breaks by class and age | proof of correctness | any `missing_in_ledger`; any break > 3 days |
| Trial balance: `sum(amount_minor)` over all postings per currency | must be exactly 0 | ≠ 0 (page someone) |
| Idempotency: 409 and 422 rates per merchant | client retry storms, key misuse | spike |
| Webhook acceptance rate, 4xx/5xx returned to PSPs | lost notifications | any 4xx burst |
| PSP latency / error rate; circuit breaker state | upstream health | p99 > 5 s |
| Replication: sync standby connected, `replay_lag` | RPO = 0 guarantee | no sync standby |
| Long transactions (`xact_start` age) | nothing should exceed seconds | > 10 s |

### Backups, audit and lifecycle

- PITR with WAL archiving, tested restores, and a delayed replica (for example 1 h behind) to recover from a destructive mistake quickly ([Ch 26 · Backup & DR](topic.html?p=26-backup-disaster-recovery)).
- Audit: `payment_events` and the ledger are append-only and carry `actor` and `request_id`; database roles separate the application (insert-only on the ledger) from operators (read-only by default, break-glass for writes, all logged). Some teams add a hash chain over journal entries so tampering is detectable.
- Retention: ledger and payment records for the regulatory period (often 7–10 years) — old monthly partitions detached and moved to cheaper storage, but queryable ([Ch 28 · Data Lifecycle](topic.html?p=28-data-lifecycle)); idempotency keys 24 h–7 d; raw webhook payloads 90 days; PAN never stored (tokens only), which keeps the database out of the heaviest PCI scope.

## 9. Interview Questions

**Q: Why store money as integer minor units rather than floats or decimals?**
A: Floating point cannot represent most decimal fractions exactly, so sums drift and reconciliation against a PSP that uses exact integers breaks by cents. Integer minor units (cents, yen, fils) are exact, fast and compare cleanly; the currency is stored alongside because amounts in different currencies must never be added and because exponents differ (JPY has 0 decimal places, KWD 3). `numeric` is also exact and acceptable, just slower and easier to misuse with implicit rounding. The PostgreSQL `money` type should be avoided because it has no currency and depends on locale settings.

**Q: How do you implement idempotency keys for `POST /payments`?**
A: A table keyed by `(merchant_id, key)` stores a fingerprint of the request, a status, a lock timestamp, a recovery point and the final response. The first request inserts the row; a concurrent duplicate blocks on the unique index and then sees the row, returning 409 while the first is in progress. When processing finishes, the response is stored in the same transaction as the state change, so any later retry replays it exactly. A retry with the same key but a different body returns 422, which catches clients that reuse keys incorrectly. Keys expire after a documented window such as 24 hours.

**Q: Why must the PSP call not happen inside a database transaction?**
A: Because PSP latency is outside your control and can jump to tens of seconds. An open transaction holds row locks, a pooled connection and a snapshot that pins the xmin horizon, so a PSP slowdown turns into lock queues, pool exhaustion and vacuum falling behind — a database outage caused by a third party. Splitting the flow into a short transaction before the call and another after it keeps the database healthy, at the cost of having to handle the intermediate state explicitly, which you need anyway for crashes.

**Q: The PSP call times out. What state is the payment in and what do you do?**
A: It is unknown: the PSP may or may not have authorised. The attempt is marked `unknown` and the payment stays `authorizing`; it is never marked failed on a timeout. Resolution comes from retrying the same request with the same PSP idempotency key (which returns the original result), from a status query, or from a webhook, whichever arrives first, and all three call the same guarded transition. A partial unique index prevents creating a new authorisation attempt while one is unknown, which is exactly the path to a double charge.

**Q: What is double-entry bookkeeping and how do you enforce it in Postgres?**
A: Every movement of money is a journal entry made of postings to at least two accounts whose signed amounts sum to zero, so money is never created or destroyed, only moved, and every account balance is the sum of its postings. In Postgres, postings are inserted into an append-only table and a deferred constraint trigger checks at commit that each entry's postings sum to zero per currency, raising an error otherwise. Update and delete are revoked from the application role and blocked by a trigger, so corrections must be reversing entries, preserving the audit trail.

**Q: How do you deduplicate PSP webhooks?**
A: The endpoint verifies the signature, inserts the event keyed by `(psp, psp_event_id)` with `ON CONFLICT DO NOTHING`, and returns 200 immediately. Processing happens asynchronously from that table with `FOR UPDATE SKIP LOCKED`, using the same guarded transition function as the synchronous path. Duplicates hit the primary key; out-of-order events are handled because transitions check the current state, and an event describing a state already reached is a no-op.

**Q: How do you get merchant balances without scanning years of postings?**
A: Keep immutable daily balance snapshots per account, computed from postings by a job, and compute the current balance as the latest snapshot plus postings since, an index range scan on `(account_id, effective_on)`. I avoid running balance rows for system accounts like PSP receivable because every payment touches them and a single row would serialise the platform. For merchant accounts a running balance is acceptable if synchronous overdraft checks need it, because per-merchant contention is low, and it can be verified against the postings.

**Q: What is reconciliation and what breaks does it find?**
A: Reconciliation matches the PSP's daily settlement file, and the bank statement, against your ledger by PSP reference and amount. It classifies differences as missing at the PSP (often settlement lag, clears in a day or two), missing in your ledger (money moved that you never recorded — usually a mis-resolved unknown or lost webhook), and amount or currency mismatches. Matched lines produce settlement journal entries, and breaks become tracked cases with owners and ageing. It is the mechanism that proves the rest of the system correct.

**Q: Explain the "exactly-once illusion" end to end in this system. (Senior)**
A: No hop can guarantee exactly-once delivery, so each hop is at-least-once with a dedup on the receiving side. The merchant's retries are absorbed by the idempotency-key table with stored responses; our retries to the PSP are absorbed by the PSP using our attempt id as its idempotency key; the PSP's webhook retries are absorbed by the webhook events primary key; our internal events use an outbox with idempotent consumers; and the ledger has a unique `(entry_kind, source_ref)` backstop so no source event is posted twice. Guarded state transitions make late or reordered messages harmless. Finally, reconciliation against the settlement file catches anything that slipped through, so the system is exactly-once in effect and verified daily.

**Q: A customer reports being charged twice. How do you investigate? (Senior)**
A: First determine whether there are two payments or one payment charged twice. If there are two payment rows, check their idempotency keys: different keys usually mean the merchant generated a new key per retry, which our system correctly treated as two requests; the fix is on the merchant side, and we can offer duplicate detection. If one payment shows two successful authorisations at the PSP, that should be impossible given the unique indexes, so I look for an attempt retried with a new PSP key or re-routed to another PSP while unknown, using `payment_attempts` and `payment_events` with their actors and request ids. Reconciliation data confirms what the PSP actually settled. The remedy is a refund or void through the normal state machine, with a reversal in the ledger — never a manual update.

**Q: When would you split the ledger into its own service and database, and what changes? (Senior)**
A: When a separate team owns it, when other products besides card payments post to it, or when its write volume needs independent scaling. Then the payment state change and the ledger posting are no longer one transaction, so the payment service writes an outbox event in the same transaction as the transition, and the ledger consumes it idempotently using the source reference as the unique key. The ledger becomes eventually consistent with payment state, typically by milliseconds to seconds, and a reconciliation job between payment states and ledger entries is added. Until those pressures exist, co-locating them is simpler and strictly safer.

**Q: How would you handle a PSP outage without losing payments or double-charging? (Senior)**
A: Circuit-break the failing PSP so new requests fail fast with a retryable error or are routed to a secondary PSP as new attempts, which is safe because they have not been sent anywhere yet. Attempts already sent and now unknown stay bound to the original PSP and key; the resolver queries or retries them with the same key once the PSP recovers, with backoff. Merchants retrying with their idempotency keys get 409 or the pending response, not a new payment. After recovery, reconciliation of that day's settlement file confirms every unknown was resolved correctly.

## 10. Quick Revision & Cheat Sheet

| Concern | Design |
|---|---|
| Money | `bigint` minor units + `char(3)` currency; never float |
| API dedup | `idempotency_keys (merchant_id, key)`: fingerprint, lock, recovery point, stored response in the same txn |
| PSP dedup | attempt id = PSP idempotency key; partial unique indexes: one open and one successful auth per payment |
| Timeout | outcome `unknown`; same-key retry, status query, webhook; never a new attempt |
| Transaction shape | short txn → external call (no txn) → short txn |
| State machine | CHECK on status + guarded `UPDATE ... WHERE status = expected` + `payment_events` |
| Ledger | append-only postings; deferred trigger: sum per entry per currency = 0; reversals not updates |
| Ledger dedup | `UNIQUE (entry_kind, source_ref, effective_on)` |
| Balances | daily snapshots + postings since; no hot running balance on system accounts |
| Webhooks | verify, insert `(psp, event_id)` ON CONFLICT DO NOTHING, 200, process async |
| Proof | daily reconciliation vs settlement files; trial balance = 0 |
| Durability | sync standby quorum, PITR, delayed replica |

- Exactly-once is an effect built from at-least-once plus idempotency at every hop.
- A timeout is an unknown, not a failure.
- The ledger is the truth; balances are derived and verifiable.
- Put invariants in the database (CHECK, partial unique indexes, deferred triggers) so bugs fail loudly.
- Never hold a transaction open across a network call to someone else.
- Reconciliation is not optional; it is how you know.

## 11. Hands-On Exercises

Lab: `docker run --name pay -e POSTGRES_PASSWORD=pw -p 5432:5432 -d postgres:17`.

1. **Idempotency race.** Create `idempotency_keys` and run Tx 1 from two psql sessions with the same key; pause the first before COMMIT and observe the second blocking on the insert, then returning 0 rows and taking the `FOR UPDATE` path. Repeat with a different request hash and return 422.
2. **Balanced ledger.** Create the ledger tables and the deferred trigger. Insert a balanced three-leg entry (commits) and an unbalanced one (fails at COMMIT with 23514). Try `UPDATE postings` as the app role and see it rejected.
3. **Replay safety.** Run the capture posting CTE twice with the same `source_ref`; confirm postings are inserted once. Then compute a trial balance: `SELECT currency, sum(amount_minor) FROM postings GROUP BY currency` must be 0.
4. **Unknown handling.** Write a tiny fake PSP (Python/Flask) that sometimes sleeps past your timeout but still records the charge. Drive 1,000 payments with retries and the resolver; verify the fake PSP recorded exactly one charge per payment.
5. **Reconciliation.** Generate a settlement file from the fake PSP, delete three attempts' success records and alter one amount in your DB, run the break query, and confirm each break is classified correctly.
6. **Hot account.** Maintain a running balance row for `psp_receivable` and run `pgbench` captures at 64 clients; compare TPS with the snapshot-based design.

**Mini project — mini Stripe.** Build `POST /payments`, `POST /payments/{id}/capture`, `POST /payments/{id}/refunds` and a webhook endpoint over Postgres with the schema above and the fake PSP. Include the resolver and a nightly reconciliation job. Chaos test: kill the API process at random points (between Tx 1 and the PSP call, between the call and Tx 2), drop 10% of webhooks, duplicate 10%, and assert: trial balance is zero, no payment has more than one successful authorisation, every merchant retry with the same key returns an identical body, and reconciliation reports zero `missing_in_ledger` after the resolver runs.

## 12. Related Topics & Free Learning Resources

**Concept chapters this design applies**

- [Ch 03 · MVCC](topic.html?p=03-mvcc) — why long transactions and churny key tables hurt.
- [Ch 04 · Concurrency Control](topic.html?p=04-concurrency-control) — compare-and-set transitions, hot accounts.
- [Ch 06 · Isolation Deep Dive](topic.html?p=06-isolation-deep-dive) — why unique constraints and guarded updates beat check-then-act.
- [Ch 11 · Partitioning](topic.html?p=11-partitioning) — monthly ledger partitions, daily key partitions.
- [Ch 13 · Distributed Transactions](topic.html?p=13-distributed-transactions) — why the PSP boundary is handled by idempotency, not 2PC.
- [Ch 18 · High Availability](topic.html?p=18-high-availability) — synchronous quorum for RPO = 0.
- [Ch 20 · Database + Application](topic.html?p=20-database-application-architecture) — keeping external calls out of transactions and pools.
- [Ch 26 · Backup & DR](topic.html?p=26-backup-disaster-recovery) and [Ch 28 · Data Lifecycle](topic.html?p=28-data-lifecycle) — PITR, retention, archiving.
- [Ch 29 · Advanced Database Patterns](topic.html?p=29-advanced-database-patterns) — outbox, inbox, event sourcing.
- Sibling case studies: [Ch 32 · Banking Ledger](topic.html?p=32-case-banking) (internal transfers and balances), [Ch 38 · Order System](topic.html?p=38-case-order-system) (the saga that calls this service).

**SQL Handbook:** [Transactions & ACID](../sql/topic.html?p=25-transactions-acid) · [Keys & Constraints](../sql/topic.html?p=29-keys-constraints) · [Procedures & Triggers](../sql/topic.html?p=32-procedures-triggers) · [Data Types](../sql/topic.html?p=04-data-types)

**Other handbooks:** [System Design · Idempotency](../system-design/topic.html?p=22-idempotency) · [System Design · Distributed Transactions](../system-design/topic.html?p=21-distributed-transactions) · [Kafka & RabbitMQ · Idempotency & Outbox](../messaging/topic.html?p=21-idempotency-outbox) · [Kafka & RabbitMQ · Delivery Guarantees](../messaging/topic.html?p=04-delivery-guarantees)

**Free resources**

- **Implementing Stripe-like Idempotency Keys in Postgres** — Brandur Leach · *Advanced* · recovery points, locking the key row, atomic phases; the model for this chapter's key table. <https://brandur.org/idempotency-keys>
- **Idempotent Requests — Stripe API Reference** — Stripe · *Beginner* · the public contract merchants see: key reuse, fingerprint mismatch, 24 h retention. <https://docs.stripe.com/api/idempotent_requests>
- **Designing robust and predictable APIs with idempotency** — Stripe Engineering · *Intermediate* · why retries plus idempotency, and exponential backoff. <https://stripe.com/blog/idempotency>
- **PostgreSQL Documentation: CREATE TRIGGER (constraint triggers)** — PostgreSQL · *Intermediate* · deferred constraint triggers used to enforce balanced entries. <https://www.postgresql.org/docs/current/sql-createtrigger.html>
- **PostgreSQL Documentation: Partial Indexes** — PostgreSQL · *Intermediate* · the "one open attempt" and "one success" guarantees. <https://www.postgresql.org/docs/current/indexes-partial.html>
- **TigerBeetle Documentation** — TigerBeetle · *Advanced* · a purpose-built double-entry ledger database; useful for seeing the invariants stated precisely. <https://docs.tigerbeetle.com/>
- **Designing Data-Intensive Applications, ch. 11 & 12** — Martin Kleppmann · *Advanced* · end-to-end idempotence and "the end-to-end argument" for correctness. <https://dataintensive.net/>

---

*Database Design Handbook — chapter 39.*
