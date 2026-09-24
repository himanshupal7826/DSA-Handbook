# 32 · Case Study: Banking Ledger Database

> **In one line:** A banking data layer is an append-only, double-entry ledger in which every transfer is a set of immutable entries that sum to zero, balances are either derived from those entries or cached next to them under a checked invariant, and every write is short, idempotent, lock-ordered and strongly consistent — because in this domain "eventually correct" means "wrong in an audit".

---

## 1. Overview

> **Builds on:** [SQL Handbook · Transactions & ACID](../sql/topic.html?p=25-transactions-acid) · [SQL Handbook · Isolation Levels](../sql/topic.html?p=26-isolation-levels) · [Ch 04 · Concurrency Control](topic.html?p=04-concurrency-control) · [Ch 05 · Locking Internals](topic.html?p=05-locking-internals) · [Ch 06 · Isolation Deep Dive](topic.html?p=06-isolation-deep-dive). This chapter assumes you know what ACID and the isolation levels are and focuses on how a ledger is laid out, locked, audited and scaled.

You are designing the core ledger of a digital bank (or the wallet of a fintech, or the balance system of a marketplace — the data design is the same). Customers hold accounts in one or more currencies, move money between accounts inside the bank, receive and send external payments, and pay by card. Finance needs to close the books daily; regulators need every cent explainable for seven years or more.

The naive design is a `balance` column that you `UPDATE`. It works in a demo and fails in every way that matters: when a number is wrong you cannot tell *why* it is wrong, because the history was overwritten; a lost update silently creates or destroys money; and a bug that credits one side of a transfer but not the other leaves the bank's books unbalanced with no structural way to notice. Accounting solved this in the 15th century with **double-entry bookkeeping**: money never appears or disappears, it only moves, and every movement is recorded as matching debits and credits that sum to zero. Your database design is that idea, enforced by constraints and transactions.

### Requirements

**Functional:** open accounts (per currency); internal transfers between any two accounts; external incoming/outgoing payments via a settlement (clearing) account; card authorization holds and their later capture or release; statement and balance queries; reversals (never edits); daily reconciliation and trial balance.

**Non-functional:**

- **Money is conserved:** for every ledger transaction, entries sum to zero per currency.
- **No lost updates, no double spends:** a balance cannot go below its allowed limit, even under concurrent withdrawals.
- **Exactly-once effect** for client requests (retries must not transfer twice).
- **Immutability & auditability:** no entry is ever updated or deleted; corrections are new entries.
- **Durability:** RPO = 0 for committed transfers (a committed transfer survives the loss of a node), RTO in minutes.
- Balance read p99 < 50 ms; transfer p99 < 150 ms.

### Workload estimate

| Quantity | Estimate | Reasoning |
|---|---|---|
| Customers / accounts | 10 M / 15 M | ~1.5 accounts each (current + savings/FX) |
| Ledger transactions | 5 M/day ≈ 60/s avg, ~600/s peak | payday, salary runs, card peaks at lunch |
| Entries per transaction | ~2.5 | two legs, plus fees/FX legs sometimes |
| Entries per day | ~12.5 M | 5 M × 2.5 |
| Entry size incl. indexes | ~300 B | ids, amount, currency, timestamps, 2–3 indexes |
| Ledger growth | ~3.8 GB/day, ~1.4 TB/year, ~10 TB over 7 years | 12.5 M × 300 B |
| Balance reads | ~3,000/s peak | app opens, card authorizations |
| Read : write | ~5 : 1 | balances are read constantly, transfers are frequent |

At 600 transfers/s peak with ~5 row writes each, a single well-provisioned PostgreSQL primary with a synchronous standby is comfortable (see [Ch 22 · Capacity Planning](topic.html?p=22-capacity-planning)). The pressures are elsewhere: **correctness under concurrency**, **hot internal accounts** that sit on one side of every transaction, and **ten terabytes of history** that must stay queryable and immutable.

## 2. Core Concepts

- **Account** — a bucket of value in exactly one currency, with a **normal balance** side. Customer deposit accounts are *liabilities* of the bank; the bank's cash at the central bank is an *asset*. *Why it matters:* the sign convention for "debit" and "credit" depends on account type; get it wrong and every report is inverted.
- **Ledger transaction (journal)** — one business event (a transfer, a card capture, a fee). It owns two or more entries. *Invariant L1:* `SUM(amount) = 0` per transaction per currency.
- **Entry (posting)** — one signed amount against one account. Immutable. *Invariant L2:* never updated, never deleted — enforced by privileges and a trigger.
- **Signed-amount convention** — store debits as positive and credits as negative (or the reverse) in one `amount_minor BIGINT` column. *Why it matters:* "sum to zero" becomes a single `SUM()`.
- **Balance** — the sum of an account's entries. *Invariant L3:* `accounts.balance_minor = SUM(entries.amount_minor)` for that account whenever a cached balance exists.
- **Available balance** — balance minus active holds (card authorizations). *Invariant L4:* `available >= -overdraft_limit` after every debit.
- **Hold (authorization)** — a reservation of funds that is later captured (becomes entries) or released. Same shape as an inventory reservation in [Ch 31 · E-commerce](topic.html?p=31-case-ecommerce).
- **Minor units** — integer cents (or the currency's smallest unit; JPY has 0 decimals, KWD has 3). *Why it matters:* `0.1 + 0.2 = 0.30000000000000004` in binary floating point; a ledger that stores floats cannot balance.
- **Idempotency key** — a client-supplied id per transfer request. *Invariant L5:* one key, at most one ledger transaction.
- **Reversal** — a new ledger transaction with the opposite entries, linked to the original. The only way to "undo".
- **Suspense / clearing account** — an internal account that temporarily holds money in flight (external payments, cross-shard transfers). *Why it matters:* it lets each local transaction balance on its own.
- **Reconciliation** — proving internal records match each other (balances vs entries) and match external truth (settlement files from card networks and payment rails).

## 3. Theory & Principles

### Access patterns, ranked

| # | Access pattern | Rate (peak) | Consistency | Notes |
|---|---|---|---|---|
| 1 | Read available balance (app, card auth) | ~3,000/s | **strong** for authorization; slightly stale OK for app display | primary for auth, replica for app with "as of" time |
| 2 | Post a transfer / capture | ~600/s | **strong, serializable effect** | the critical transaction |
| 3 | Place / release a card hold | ~400/s | strong | same locking as a debit |
| 4 | Statement: entries of account X in a date range | ~300/s | stale OK (seconds) | index `(account_id, created_at)`; replica |
| 5 | Idempotency lookup on retry | ~50/s | strong | unique key, same transaction as the post |
| 6 | End-of-day trial balance and reconciliation | batch | snapshot-consistent | replica, REPEATABLE READ snapshot |
| 7 | Regulator / audit query of old history | rare | stale OK | archive partitions, warehouse |

### Where consistency must be strong

Everything that can **move money or authorize spending** sits inside one strongly consistent boundary: accounts, holds, ledger transactions, entries and idempotency records, all in one PostgreSQL cluster with synchronous replication. The reasons are specific. An authorization that reads a stale balance on a lagging replica can approve spending of money that was already spent (see [Ch 10 · Consistency Models](topic.html?p=10-consistency-models)). An asynchronous standby that is promoted after the primary dies can lose acknowledged transfers — the customer saw "sent", the ledger forgot. That is why RPO = 0 here means `synchronous_commit = on` with a synchronous standby in another availability zone ([Ch 09 · Replication](topic.html?p=09-replication), [Ch 18 · High Availability](topic.html?p=18-high-availability)).

**Eventual** is acceptable for everything derived: statements, analytics, notifications, the balance shown on a home screen (if labelled with its as-of time), and the data warehouse — all fed from the ledger by CDC or the outbox.

### How a transfer becomes entries

```svg
<svg viewBox="0 0 860 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs><marker id="c32a1" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#334155"/></marker></defs>
  <text x="430" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Alice sends Bob 25.00 USD with a 0.50 fee: one ledger transaction, three entries, sum = 0</text>
  <rect x="20" y="45" width="220" height="70" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="130" y="67" text-anchor="middle" fill="#1e3a8a" font-weight="bold">Request</text>
  <text x="130" y="85" text-anchor="middle" fill="#1e3a8a">POST /transfers  key=9b1e...</text>
  <text x="130" y="101" text-anchor="middle" fill="#1e3a8a">from A-1001 to A-2002, 2500</text>
  <path d="M240,80 L298,80" stroke="#334155" stroke-width="1.5" marker-end="url(#c32a1)"/>
  <rect x="300" y="45" width="250" height="70" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="425" y="67" text-anchor="middle" fill="#5b21b6" font-weight="bold">ledger_txn 88412</text>
  <text x="425" y="85" text-anchor="middle" fill="#5b21b6">kind=TRANSFER  idem_key=9b1e...</text>
  <text x="425" y="101" text-anchor="middle" fill="#5b21b6">status=POSTED  (immutable)</text>
  <rect x="300" y="140" width="520" height="130" rx="8" fill="#ffffff" stroke="#94a3b8"/>
  <text x="560" y="160" text-anchor="middle" fill="#1e293b" font-weight="bold">entries (append-only)</text>
  <text x="320" y="182" fill="#334155" font-weight="bold">account</text><text x="480" y="182" fill="#334155" font-weight="bold">amount_minor</text><text x="640" y="182" fill="#334155" font-weight="bold">balance after</text>
  <line x1="315" y1="188" x2="805" y2="188" stroke="#94a3b8"/>
  <text x="320" y="206" fill="#1e293b">A-1001 Alice (liability)</text><text x="480" y="206" fill="#dc2626">-2550</text><text x="640" y="206" fill="#1e293b">10000 to 7450</text>
  <text x="320" y="226" fill="#1e293b">A-2002 Bob (liability)</text><text x="480" y="226" fill="#16a34a">+2500</text><text x="640" y="226" fill="#1e293b">300 to 2800</text>
  <text x="320" y="246" fill="#1e293b">R-FEES revenue (house)</text><text x="480" y="246" fill="#16a34a">+50</text><text x="640" y="246" fill="#92400e">not cached (hot)</text>
  <line x1="315" y1="254" x2="805" y2="254" stroke="#94a3b8"/>
  <text x="320" y="266" fill="#14532d" font-weight="bold">SUM</text><text x="480" y="266" fill="#14532d" font-weight="bold">0</text>
  <path d="M425,115 L425,138" stroke="#334155" stroke-width="1.5" marker-end="url(#c32a1)"/>
  <rect x="20" y="140" width="250" height="130" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="145" y="162" text-anchor="middle" fill="#78350f" font-weight="bold">Sign convention used here</text>
  <text x="35" y="184" fill="#78350f">amount &lt; 0 : money leaves the account</text>
  <text x="35" y="202" fill="#78350f">amount &gt; 0 : money enters the account</text>
  <text x="35" y="220" fill="#78350f">(customer-facing view; accounting</text>
  <text x="35" y="236" fill="#78350f">reports map it to debit/credit by</text>
  <text x="35" y="252" fill="#78350f">account type)</text>
  <rect x="20" y="295" width="820" height="90" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="430" y="317" text-anchor="middle" fill="#14532d" font-weight="bold">Invariants checked in the SAME database transaction</text>
  <text x="40" y="340" fill="#166534">L1  SUM(entries.amount) per ledger_txn per currency = 0  (deferred constraint trigger at COMMIT)</text>
  <text x="40" y="358" fill="#166534">L3  accounts.balance = previous balance + entry amount  (updated in the same txn; checked nightly against SUM)</text>
  <text x="40" y="376" fill="#166534">L4  Alice available balance - 2550 &gt;= -overdraft_limit  (checked under row lock before insert)</text>
</svg>
```

### Balances: derived or cached?

There are two honest designs, and most real ledgers combine them.

**Derived balance** — `SELECT SUM(amount_minor) FROM entries WHERE account_id = $1`. The ledger is the only truth, so there is nothing to drift. It is too slow on its own for an account with 50,000 entries read 3,000 times a second, so you add **balance snapshots**: a nightly (or hourly) row `(account_id, as_of_entry_id, balance)` and compute `snapshot + SUM(entries after it)`. Reads touch at most a day of entries.

**Cached balance** — an `accounts.balance_minor` column updated in the same transaction that inserts the entries. Reads are a primary-key lookup, and the column doubles as the **lock target** for "is there enough money?". The risk is drift if anything writes entries without updating the balance, which you prevent by making one stored function the only writer and verify with a continuous invariant query (L3).

The combination used below: **cached balance for customer accounts** (they need fast, locked, strong reads for authorization) and **derived balance for hot house accounts** (fee revenue, settlement, interest expense — accounts that appear in a large fraction of all transactions and would otherwise become a single hot row, see section 4).

### Concurrency: lock ordering, not luck

A transfer touches two customer rows. If transfer X locks Alice then Bob while transfer Y locks Bob then Alice, each waits for the other: a deadlock, which PostgreSQL detects after `deadlock_timeout` (1 s default) and resolves by aborting one with SQLSTATE 40P01. The fix from [Ch 05 · Locking Internals](topic.html?p=05-locking-internals) is **global lock ordering**: always lock the accounts of a transaction in ascending `id` order, with a single statement.

```text
Without ordering                               With ORDER BY id FOR UPDATE
T1: lock A-1001  (Alice to Bob)                T1: lock A-1001, then A-2002
T2: lock A-2002  (Bob to Alice)                T2: wants A-1001 first -> waits for T1
T1: wants A-2002 -> waits T2                   T1: posts entries, COMMIT (~2 ms)
T2: wants A-1001 -> waits T1  => DEADLOCK      T2: gets A-1001, A-2002 -> posts, COMMIT
    (1 s later: one aborted, 40P01)                no cycle is possible
```

**SERIALIZABLE vs FOR UPDATE.** You could run the transfer at SERIALIZABLE and write it naively: PostgreSQL's SSI will detect that two concurrent withdrawals both read Alice's balance and wrote it, and abort one with 40001. That is correct, and it is attractive for invariants that span many rows (for example "sum of all of this customer's accounts may not go below -500"). The cost is that aborts, not waits, resolve contention, and every caller needs a retry loop. For a two-account transfer, explicit `SELECT ... FOR UPDATE` in id order (or conditional `UPDATE ... WHERE balance - $x >= -overdraft`) gives the same safety with predictable waits and no aborts. Use SERIALIZABLE where the invariant cannot be pinned to rows you can lock; see [Ch 06 · Isolation Deep Dive](topic.html?p=06-isolation-deep-dive).

## 4. Architecture & Workflow

```svg
<svg viewBox="0 0 880 460" width="100%" height="460" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs><marker id="c32b1" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#2563eb"/></marker><marker id="c32b2" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#7c3aed"/></marker></defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Ledger data architecture: one synchronous core, everything else read-only and derived</text>
  <rect x="20" y="50" width="140" height="40" rx="6" fill="#f1f5f9" stroke="#94a3b8"/><text x="90" y="75" text-anchor="middle" fill="#1e293b">Mobile / web API</text>
  <rect x="20" y="110" width="140" height="40" rx="6" fill="#f1f5f9" stroke="#94a3b8"/><text x="90" y="135" text-anchor="middle" fill="#1e293b">Card processor</text>
  <rect x="20" y="170" width="140" height="40" rx="6" fill="#f1f5f9" stroke="#94a3b8"/><text x="90" y="195" text-anchor="middle" fill="#1e293b">Payment rails</text>
  <rect x="210" y="100" width="150" height="60" rx="6" fill="#dbeafe" stroke="#2563eb"/><text x="285" y="124" text-anchor="middle" fill="#1e3a8a" font-weight="bold">Ledger service</text><text x="285" y="140" text-anchor="middle" fill="#1e3a8a" font-size="9">ONLY writer of the ledger</text><text x="285" y="152" text-anchor="middle" fill="#1e3a8a" font-size="9">idempotency + lock order</text>
  <path d="M160,70 L208,115" stroke="#2563eb" stroke-width="1.5" marker-end="url(#c32b1)"/>
  <path d="M160,130 L208,130" stroke="#2563eb" stroke-width="1.5" marker-end="url(#c32b1)"/>
  <path d="M160,190 L208,145" stroke="#2563eb" stroke-width="1.5" marker-end="url(#c32b1)"/>
  <rect x="410" y="60" width="230" height="170" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="525" y="80" text-anchor="middle" fill="#14532d" font-weight="bold">PostgreSQL primary (AZ-a)</text>
  <rect x="425" y="92" width="95" height="22" rx="3" fill="#ffffff" stroke="#16a34a"/><text x="472" y="107" text-anchor="middle" fill="#14532d" font-size="9">accounts</text>
  <rect x="530" y="92" width="95" height="22" rx="3" fill="#ffffff" stroke="#16a34a"/><text x="577" y="107" text-anchor="middle" fill="#14532d" font-size="9">holds</text>
  <rect x="425" y="120" width="95" height="22" rx="3" fill="#ffffff" stroke="#16a34a"/><text x="472" y="135" text-anchor="middle" fill="#14532d" font-size="9">ledger_txns</text>
  <rect x="530" y="120" width="95" height="22" rx="3" fill="#ffffff" stroke="#16a34a"/><text x="577" y="135" text-anchor="middle" fill="#14532d" font-size="9">entries (monthly)</text>
  <rect x="425" y="148" width="95" height="22" rx="3" fill="#ffffff" stroke="#16a34a"/><text x="472" y="163" text-anchor="middle" fill="#14532d" font-size="9">idempotency</text>
  <rect x="530" y="148" width="95" height="22" rx="3" fill="#ffffff" stroke="#7c3aed"/><text x="577" y="163" text-anchor="middle" fill="#5b21b6" font-size="9">outbox</text>
  <text x="525" y="192" text-anchor="middle" fill="#166534" font-size="9">synchronous_commit = on</text>
  <text x="525" y="208" text-anchor="middle" fill="#166534" font-size="9">UPDATE/DELETE on entries revoked</text>
  <text x="525" y="222" text-anchor="middle" fill="#166534" font-size="9">+ trigger raising an error</text>
  <path d="M360,130 L408,130" stroke="#16a34a" stroke-width="2" marker-end="url(#c32b1)"/>
  <rect x="690" y="60" width="170" height="50" rx="6" fill="#dcfce7" stroke="#16a34a"/><text x="775" y="80" text-anchor="middle" fill="#14532d" font-weight="bold">Sync standby (AZ-b)</text><text x="775" y="96" text-anchor="middle" fill="#166534" font-size="9">ack before COMMIT returns</text>
  <path d="M640,85 L688,85" stroke="#16a34a" stroke-width="2" marker-end="url(#c32b1)"/>
  <rect x="690" y="130" width="170" height="44" rx="6" fill="#f1f5f9" stroke="#94a3b8"/><text x="775" y="150" text-anchor="middle" fill="#1e293b">Async replica (AZ-c)</text><text x="775" y="165" text-anchor="middle" fill="#334155" font-size="9">statements, balance display</text>
  <path d="M640,150 L688,150" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#c32b1)"/>
  <rect x="410" y="270" width="230" height="44" rx="6" fill="#ede9fe" stroke="#7c3aed"/><text x="525" y="290" text-anchor="middle" fill="#5b21b6" font-weight="bold">Kafka: LedgerPosted events</text><text x="525" y="305" text-anchor="middle" fill="#5b21b6" font-size="9">outbox via CDC, keyed by account</text>
  <path d="M577,230 L550,268" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#c32b2)"/>
  <rect x="690" y="200" width="170" height="44" rx="6" fill="#fef3c7" stroke="#d97706"/><text x="775" y="220" text-anchor="middle" fill="#78350f" font-weight="bold">Reconciliation jobs</text><text x="775" y="235" text-anchor="middle" fill="#92400e" font-size="9">internal + external files</text>
  <path d="M775,174 L775,198" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#c32b1)"/>
  <rect x="210" y="350" width="150" height="40" rx="6" fill="#f1f5f9" stroke="#94a3b8"/><text x="285" y="368" text-anchor="middle" fill="#1e293b">Notifications</text><text x="285" y="382" text-anchor="middle" fill="#334155" font-size="9">"You sent 25.00"</text>
  <rect x="410" y="350" width="230" height="40" rx="6" fill="#f1f5f9" stroke="#94a3b8"/><text x="525" y="368" text-anchor="middle" fill="#1e293b">Data warehouse</text><text x="525" y="382" text-anchor="middle" fill="#334155" font-size="9">finance reporting, fraud, ML</text>
  <rect x="690" y="350" width="170" height="40" rx="6" fill="#f1f5f9" stroke="#94a3b8"/><text x="775" y="368" text-anchor="middle" fill="#1e293b">WORM archive</text><text x="775" y="382" text-anchor="middle" fill="#334155" font-size="9">closed months, 7+ years</text>
  <path d="M480,314 L300,348" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#c32b2)"/>
  <path d="M525,314 L525,348" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#c32b2)"/>
  <path d="M600,314 L740,348" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#c32b2)"/>
  <text x="20" y="425" fill="#1e293b" font-weight="bold">Write path:</text><text x="100" y="425" fill="#334155">ledger service, one short txn: idempotency row + lock accounts by id + entries + balances + outbox, sync-replicated</text>
  <text x="20" y="445" fill="#1e293b" font-weight="bold">Read path:</text><text x="100" y="445" fill="#334155">authorization reads primary; statements and home-screen balance read the async replica with an as-of time</text>
</svg>
```

A single **ledger service** owns every table in the ledger database and exposes exactly a handful of operations: `post_transfer`, `place_hold`, `capture_hold`, `release_hold`, `reverse`. No other service, admin tool, or migration script writes to `entries`. This is not bureaucracy; it is how invariants L1–L3 remain true, because constraints can only check what every writer goes through.

### Hot house accounts

Every card transaction credits the bank's **fee revenue** account and every external transfer touches the **settlement** account. If those rows carried a cached balance, every transaction in the bank would take the same row lock — an unintentional global mutex. Three standard answers, from simplest:

1. **Do not cache house balances.** Insert entries for house accounts but do not update a balance row; compute their balance from snapshots plus recent entries. Inserts do not conflict with each other, so there is no hot row.
2. **Sub-accounts.** Split `R-FEES` into 16 sub-accounts and pick one by `hash(txn_id) % 16`; the reported balance is their sum.
3. **Batch the house leg.** Post customer legs against a per-shard suspense account and sweep suspense into the house account every few seconds in one transaction.

### External money and cross-shard money: the clearing pattern

Money that leaves the bank does not vanish; it moves to a **settlement/clearing account** that represents "owed to the payment network". The outgoing payment is two local, balanced ledger transactions: (1) customer → clearing (instant, visible to the customer), (2) clearing → nostro/central-bank account when the rail confirms settlement. If the rail rejects the payment, you post a reversal of (1). Every step balances on its own, and the clearing account's balance at any moment is exactly "money in flight" — which reconciliation compares to the rail's file.

The same trick is how you eventually cross shards: a transfer from an account on shard 1 to one on shard 2 becomes *debit Alice / credit clearing-1* on shard 1 and *debit clearing-2 / credit Bob* on shard 2, linked by a transfer id and driven by a saga. Each shard's books balance locally; the two clearing accounts net to zero globally, and a reconciliation job proves it.

## 5. Implementation

### Core schema (PostgreSQL)

```sql
CREATE TABLE accounts (
  id                 BIGINT PRIMARY KEY,                 -- allocated, not random: lock ordering uses it
  customer_id        BIGINT,                             -- NULL for house accounts
  kind               TEXT   NOT NULL CHECK (kind IN ('CUSTOMER','REVENUE','EXPENSE','CLEARING','ASSET','SUSPENSE')),
  currency           CHAR(3) NOT NULL,
  status             TEXT   NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','FROZEN','CLOSED')),
  overdraft_limit    BIGINT NOT NULL DEFAULT 0 CHECK (overdraft_limit >= 0),
  cache_balance      BOOLEAN NOT NULL DEFAULT true,      -- false for hot house accounts
  balance_minor      BIGINT NOT NULL DEFAULT 0,          -- cached ledger balance (L3)
  held_minor         BIGINT NOT NULL DEFAULT 0 CHECK (held_minor >= 0),
  last_entry_id      BIGINT,
  version            BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT available_ok CHECK (NOT cache_balance OR balance_minor - held_minor >= -overdraft_limit)  -- L4
);

CREATE TABLE ledger_txns (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind            TEXT NOT NULL,                    -- TRANSFER, CARD_CAPTURE, FEE, REVERSAL, ...
  reverses_id     BIGINT REFERENCES ledger_txns(id),
  external_ref    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (reverses_id)                              -- a transaction can be reversed at most once
);

CREATE TABLE entries (
  id            BIGINT GENERATED ALWAYS AS IDENTITY,
  txn_id        BIGINT NOT NULL,
  account_id    BIGINT NOT NULL,
  amount_minor  BIGINT NOT NULL CHECK (amount_minor <> 0),
  currency      CHAR(3) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);                 -- monthly partitions; closed months go read-only
CREATE INDEX entries_account_time ON entries (account_id, created_at, id);   -- statements
CREATE INDEX entries_txn ON entries (txn_id);                                 -- L1 check, audits

CREATE TABLE idempotency (
  client_id      BIGINT NOT NULL,
  key            UUID   NOT NULL,
  request_hash   BYTEA  NOT NULL,                  -- same key + different body = 422, not a replay
  txn_id         BIGINT NOT NULL,
  response       JSONB  NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, key)
);

CREATE TABLE holds (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id   BIGINT NOT NULL REFERENCES accounts(id),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  status       TEXT   NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CAPTURED','RELEASED','EXPIRED')),
  auth_ref     TEXT   NOT NULL UNIQUE,
  expires_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX holds_expiring ON holds (expires_at) WHERE status = 'ACTIVE';

CREATE TABLE balance_snapshots (
  account_id     BIGINT NOT NULL,
  as_of_entry_id BIGINT NOT NULL,
  as_of_time     TIMESTAMPTZ NOT NULL,
  balance_minor  BIGINT NOT NULL,
  PRIMARY KEY (account_id, as_of_time)
);
```

Primary key `(id, created_at)` on `entries` is forced by partitioning (a unique constraint on a partitioned table must include the partition key). The two indexes are exactly the two access paths: by account over time (statements, derived balances) and by transaction (the balance check, audits).

### Enforcing immutability and "sum to zero"

```sql
-- L2: entries are append-only. Privileges first, trigger as a second lock.
REVOKE UPDATE, DELETE, TRUNCATE ON entries, ledger_txns FROM PUBLIC, ledger_app;

CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger is append-only: % on % is not allowed', TG_OP, TG_TABLE_NAME;
END $$;
CREATE TRIGGER entries_immutable BEFORE UPDATE OR DELETE ON entries
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- L1: checked once per transaction at COMMIT, after all legs are inserted.
CREATE FUNCTION check_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bad RECORD;
BEGIN
  SELECT currency, sum(amount_minor) AS s INTO bad
    FROM entries WHERE txn_id = NEW.txn_id
   GROUP BY currency HAVING sum(amount_minor) <> 0 LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'ledger txn % unbalanced in %: %', NEW.txn_id, bad.currency, bad.s;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER entries_balanced AFTER INSERT ON entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_balanced();
```

The deferred constraint trigger fires at COMMIT, once per inserted entry — each fire re-sums a two- or three-row transaction via `entries_txn`, which costs microseconds. If a bug inserts only one leg, the COMMIT fails and nothing was ever visible. Cross-currency transfers (FX) balance per currency by posting through an FX position account in each currency.

### Critical transaction: the transfer

```sql
BEGIN;  -- READ COMMITTED + explicit row locks in id order
-- (1) Idempotency: claim the key first. A concurrent duplicate blocks here on the
--     unique index until we commit, then gets a conflict and replays our response.
INSERT INTO idempotency (client_id, key, request_hash, txn_id, response)
VALUES ($client, $key, $hash, 0, '{}')
ON CONFLICT (client_id, key) DO NOTHING;
-- 0 rows => SELECT the stored row: same hash -> return stored response; different hash -> 422

-- (2) Lock both customer accounts in ascending id order, in ONE statement.
SELECT id, currency, status, balance_minor, held_minor, overdraft_limit
  FROM accounts
 WHERE id = ANY (ARRAY[$from, $to])
 ORDER BY id
   FOR NO KEY UPDATE;       -- weaker than FOR UPDATE: doesn't block FK checks from other tables
-- app checks: both OPEN, same currency, balance - held - amount - fee >= -overdraft_limit

-- (3) The ledger transaction and its legs.
INSERT INTO ledger_txns (kind) VALUES ('TRANSFER') RETURNING id;          -- $txn
INSERT INTO entries (txn_id, account_id, amount_minor, currency) VALUES
  ($txn, $from,     -($amount + $fee), 'USD'),
  ($txn, $to,        $amount,          'USD'),
  ($txn, $fee_acct,  $fee,             'USD');   -- house account: entry only, no balance update

-- (4) Cached balances for the two customer accounts (house account not cached).
UPDATE accounts SET balance_minor = balance_minor - ($amount + $fee), version = version + 1
 WHERE id = $from;
UPDATE accounts SET balance_minor = balance_minor + $amount, version = version + 1
 WHERE id = $to;
-- The CHECK available_ok re-validates L4 on the new row version: a bug in step 2 still cannot overdraw.

-- (5) Finish the idempotency record and emit the event.
UPDATE idempotency SET txn_id = $txn, response = $response_json
 WHERE client_id = $client AND key = $key;
INSERT INTO outbox (aggregate, agg_id, event_type, payload)
VALUES ('ledger_txn', $txn, 'TransferPosted', $payload);
COMMIT;   -- deferred trigger verifies SUM = 0; sync standby acknowledges; then success
```

Three layers protect the balance: the application check under a row lock (fast, good error messages), the `CHECK` constraint on the new row version (catches bugs), and the nightly L3 reconciliation (catches anything that bypassed both). The idempotency row is inserted *first* so a concurrent duplicate request waits on the unique index instead of racing to post twice — the pattern from [Kafka & RabbitMQ · Idempotency & Outbox](../messaging/topic.html?p=21-idempotency-outbox) applied at the request layer.

> **MySQL difference:** InnoDB has no deferred constraints and no constraint triggers, so L1 must be enforced by the posting procedure itself (insert legs, then `SELECT SUM ... FOR UPDATE` and `SIGNAL` on mismatch) or by a periodic checker. `SELECT ... FOR UPDATE` with `ORDER BY id` works the same way for lock ordering, and InnoDB detects deadlocks immediately rather than after a timeout. `CHECK` constraints are enforced from MySQL 8.0.16 onward.

### Card authorization and capture

```sql
-- Authorization (hold): lock the account, check available, record the hold.
BEGIN;
UPDATE accounts
   SET held_minor = held_minor + $amt, version = version + 1
 WHERE id = $acct AND status = 'OPEN'
   AND balance_minor - held_minor - $amt >= -overdraft_limit;    -- conditional write, no separate SELECT
-- 0 rows => decline (insufficient funds or frozen)
INSERT INTO holds (account_id, amount_minor, auth_ref, expires_at)
VALUES ($acct, $amt, $auth_ref, now() + interval '7 days');
COMMIT;

-- Capture (merchant settles, maybe for a different amount, e.g. tip added)
BEGIN;
UPDATE holds SET status = 'CAPTURED' WHERE auth_ref = $auth_ref AND status = 'ACTIVE'
RETURNING account_id, amount_minor;                          -- guarded: capture happens once
-- post ledger txn: customer -(captured), clearing +(captured); release the hold amount
UPDATE accounts SET held_minor = held_minor - $held_amt,
                    balance_minor = balance_minor - $captured_amt
 WHERE id = $acct;
COMMIT;
```

### Application code: posting with bounded retries (Python)

```python
import psycopg, time, random

RETRYABLE = {"40001", "40P01"}   # serialization failure, deadlock

def post_transfer(pool, client_id, key, req):
    for attempt in range(4):
        try:
            with pool.connection() as conn, conn.transaction():
                conn.execute("SET LOCAL lock_timeout = '500ms'")
                conn.execute("SET LOCAL statement_timeout = '2s'")
                claimed = conn.execute(
                    """INSERT INTO idempotency (client_id, key, request_hash, txn_id, response)
                       VALUES (%s, %s, %s, 0, '{}') ON CONFLICT DO NOTHING RETURNING 1""",
                    (client_id, key, req.hash())).fetchone()
                if not claimed:
                    return replay_or_reject(conn, client_id, key, req)   # same answer as the first time
                accts = conn.execute(
                    """SELECT id, balance_minor, held_minor, overdraft_limit, status, currency
                         FROM accounts WHERE id = ANY(%s) ORDER BY id FOR NO KEY UPDATE""",
                    ([req.from_id, req.to_id],)).fetchall()
                check_business_rules(accts, req)          # raises InsufficientFunds -> rollback
                txn_id = insert_legs_and_balances(conn, req)
                finish_idempotency_and_outbox(conn, client_id, key, txn_id)
                return {"txn_id": txn_id, "status": "POSTED"}
        except psycopg.errors.lookup("40P01") as e:        # deadlock: should be rare with ordering
            last = e
        except psycopg.errors.SerializationFailure as e:
            last = e
        except psycopg.errors.LockNotAvailable as e:       # lock_timeout hit: account is hot
            last = e
        time.sleep((2 ** attempt) * 0.01 + random.random() * 0.01)
    raise TransferBusy() from last
```

The rollback on `InsufficientFunds` also rolls back the idempotency claim, so a later retry with more money in the account is evaluated fresh. If your API contract says "a declined request with key K stays declined", commit the idempotency row with the decline response instead — decide deliberately.

### Reconciliation queries

```sql
-- L3: cached balance equals the ledger (run on a replica inside one REPEATABLE READ snapshot).
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT a.id, a.balance_minor, coalesce(e.s, 0) AS ledger_sum
FROM accounts a
LEFT JOIN (SELECT account_id, sum(amount_minor) AS s FROM entries GROUP BY account_id) e
       ON e.account_id = a.id
WHERE a.cache_balance AND a.balance_minor <> coalesce(e.s, 0);
-- Trial balance: the whole ledger sums to zero per currency.
SELECT currency, sum(amount_minor) FROM entries GROUP BY currency HAVING sum(amount_minor) <> 0;
COMMIT;
```

In production you do not sum ten years of entries nightly; you sum *since the last verified snapshot* and roll the snapshot forward, so the job reads one day of entries.

## 6. Advantages, Disadvantages & Trade-offs

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| Record model | Double-entry, append-only entries | Mutable `balance` column only | no history, no audit, no structural detection of lost money |
| Money type | `BIGINT` minor units (or `NUMERIC`) | `float` / `double precision` | binary floats cannot represent 0.10 exactly; sums drift |
| Balance | Cached for customers, derived for house accounts | Always derived | authorization needs a lockable, O(1) balance |
| Concurrency | Row locks in id order, READ COMMITTED | SERIALIZABLE for all | same safety for 2-row transfers, waits instead of aborts |
| Retries | Idempotency table in the same txn | Dedup in Redis | Redis and DB can disagree after a crash; one txn cannot |
| Replication | Synchronous standby (RPO 0) | Async only | promoted async replica can lose acknowledged transfers |
| Corrections | Reversal transactions | UPDATE/DELETE entries | edits destroy the audit trail |
| Scale-out | Clearing accounts + saga across shards | 2PC across shards | 2PC blocks on coordinator failure; clearing keeps each shard balanced |

### When to use this design

Any system where value moves between parties and must be provable: bank cores, wallets, marketplace payouts, loyalty points, cloud credits, in-game currency. The double-entry pattern costs a little write amplification and returns auditability, invariants and easy reconciliation.

### When NOT to use it

- **Pure counters with no counterparty** (page views, likes): double-entry is ceremony; use the counter patterns from [Ch 35 · Instagram-like Storage](topic.html?p=35-case-social-media).
- **Throughput far beyond one primary on a few hot accounts** (millions of postings per second, e.g. a national instant-payment switch): consider a purpose-built ledger database (TigerBeetle-style) or a distributed SQL database, keeping the same double-entry model.

## 7. Common Mistakes & Best Practices

**Mistake: floats for money.** People reach for `double precision` because the language default is float. It hurts because `0.1 + 0.2 <> 0.3`, so balances drift by fractions of a cent and trial balances never reach zero. Instead: `BIGINT` minor units with a currency code, or `NUMERIC(19,4)` where sub-cent precision is needed (FX rates, interest accrual), rounding explicitly with a documented rule.

**Mistake: `UPDATE accounts SET balance = $new` with `$new` computed in the app.** Two concurrent withdrawals both read 100, both write 50: 50 was created from nothing. Instead: `balance = balance - $x` under a row lock, with the sufficiency check in the WHERE clause or after `FOR UPDATE`. See [Ch 04 · Concurrency Control](topic.html?p=04-concurrency-control).

**Mistake: locking accounts in request order.** A→B and B→A deadlock under load. Instead: lock with one `SELECT ... WHERE id = ANY(...) ORDER BY id FOR NO KEY UPDATE`.

**Mistake: editing or deleting entries to fix errors.** It destroys the audit trail and breaks every snapshot after it. Instead: post a reversal (linked by `reverses_id`, unique) and a corrected transaction.

**Mistake: a cached balance on the fee or settlement account.** Every transaction then serializes on one row; p99 explodes at peak. Instead: derived balances or sub-accounts for house accounts.

**Mistake: idempotency in a cache, separate from the ledger write.** A crash between "posted" and "cached the key" produces a double transfer on retry. Instead: the idempotency row commits in the same transaction as the entries.

**Mistake: authorization reads from a replica.** Replica lag of 200 ms is enough for a card to be approved twice against the same money. Instead: authorizations read and lock on the primary.

**Mistake: sharding by customer id on day one "because banks are big".** Transfers between customers become distributed transactions and every reconciliation becomes cross-shard. Instead: one primary until the numbers demand otherwise; then shard with clearing accounts (section 8).

**Best practices:** revoke UPDATE/DELETE on ledger tables from every role; run the ledger service's DB role with `lock_timeout`, `statement_timeout` and `idle_in_transaction_session_timeout`; enable data checksums; keep closed monthly partitions read-only and hash them into a tamper-evident chain if regulators ask for it; alert on any row from any invariant query.

## 8. Production: Failure Scenarios, Monitoring & Scaling

### Failure scenarios

**Payday, 09:00: transfer p99 jumps to 4 s.** Symptom: `pg_stat_activity` shows many sessions waiting on `transactionid`; `pg_locks` shows them all behind one account id. Root cause: the payroll provider's funding account is the debit side of 200,000 salary transfers submitted concurrently; its cached balance row is the hot lock. Fix: post payroll as a batch — one ledger transaction debiting the funding account once and crediting employees in chunks of 1,000 legs — or mark the funding account `cache_balance = false` and check sufficiency once for the whole batch.

**Failover loses nothing, but the app double-posts.** Symptom: after a Patroni failover, a handful of customers see duplicated transfers. Root cause: clients retried with a *new* idempotency key after a connection error, because the mobile app generated the key per HTTP attempt rather than per user action. Fix: key generated when the user taps "Send" and persisted locally; server-side, also detect same-amount/same-counterparty within seconds and flag for review.

**Nightly L3 reconciliation reports 3 mismatched accounts.** Root cause: an engineer ran a data fix directly in psql with a superuser, inserting entries without updating balances. Fix: break-glass access only through the ledger service's `adjustment` operation (which posts balanced entries against a suspense account and requires a second approver); superuser sessions audited via `pgaudit`.

**Disk fills on the primary.** Root cause: the CDC slot feeding Kafka stalled during a connector upgrade, retaining WAL. Fix: `max_slot_wal_keep_size` to cap retention (and accept rebuilding the connector), alert on `pg_replication_slots` lag, see [Ch 24 · Database Monitoring](topic.html?p=24-database-monitoring).

**Synchronous standby dies.** With `synchronous_standby_names = 'FIRST 1 (standby_b)'`, commits hang until it returns. Fix: `ANY 1 (standby_b, standby_c)` so either of two standbys can acknowledge, preserving RPO 0 without a single point of stall.

### Monitoring

| Metric | Why | Alert |
|---|---|---|
| Invariant queries L1/L3 + trial balance | correctness | any non-empty result |
| Transfer p99, 40P01/40001/55P03 rates | contention and hot accounts | p99 > 300 ms; deadlocks > 0/min sustained |
| Lock waits grouped by account id | hot-account detection | one id > 20 waiters |
| Sync replication `flush_lag`, standby count | RPO 0 depends on it | standby missing; lag > 100 ms |
| Clearing account balance vs rail files | external reconciliation | any unexplained difference |
| Holds ACTIVE past `expires_at` | sweeper health | > 0 after grace |
| Entry insert rate vs partition size | partition lifecycle planning | next partition missing |

### Scaling path

Following [Ch 21 · Database Scaling](topic.html?p=21-database-scaling):

1. **Now (600 tx/s peak):** one primary, sync standby, async replica for statements, PgBouncer (transaction mode). Monthly partitions on `entries` ([Ch 11 · Partitioning](topic.html?p=11-partitioning)).
2. **10× (6,000 tx/s):** vertical scale and fewer bytes per entry; batch payroll and interest postings; house accounts all derived; statement reads fully on replicas with read-your-writes for the user's own last transfer.
3. **100×:** shard by `account_id` (usually by customer, so a customer's accounts co-locate). Intra-shard transfers stay one local transaction; cross-shard transfers use per-shard clearing accounts and a saga with an outbox on each side ([Ch 12 · Sharding](topic.html?p=12-sharding), [Ch 13 · Distributed Transactions](topic.html?p=13-distributed-transactions)). Alternatively move to a distributed SQL database that gives multi-row serializable transactions across ranges ([Ch 16 · Distributed Database Architecture](topic.html?p=16-distributed-database-architecture)) and accept its higher per-transaction latency.

### Backups, DR, lifecycle

Continuous WAL archiving plus base backups for PITR ([Ch 26 · Backup & Disaster Recovery](topic.html?p=26-backup-disaster-recovery)); cross-region async replica for regional disaster (RPO of seconds for that rare event, documented and accepted by risk). Restore drills monthly with an automated trial balance on the restored copy — a backup that does not balance is not a backup. Closed months: partitions set read-only, exported to WORM object storage, retained per regulation (commonly 7–10 years), then dropped from the hot cluster ([Ch 28 · Data Lifecycle](topic.html?p=28-data-lifecycle)).

## 9. Interview Questions

**Q: Why use double-entry instead of a balance column?**
A: A balance column records *what* the balance is but not *why*, so any error is unexplainable and unrecoverable once overwritten. Double-entry records every movement as entries that sum to zero, which gives you history, a structural invariant (money cannot be created or destroyed by a bug without the sum failing), and trivial reconciliation. You can still cache the balance for speed, but the entries are the truth and the balance is checkable against them.

**Q: How do you enforce that entries sum to zero in PostgreSQL?**
A: With a deferred constraint trigger on `entries` that, at COMMIT, sums the entries of the inserted row's `txn_id` per currency and raises an exception if the sum is non-zero. Deferring it to commit lets you insert the legs one by one. Belt and braces: the posting function builds all legs in one place, and a nightly trial-balance query verifies the whole ledger sums to zero per currency.

**Q: Why store money as integers?**
A: Binary floating point cannot represent most decimal fractions exactly, so `0.1 + 0.2` is not `0.3` and sums drift. Integer minor units (cents) are exact, fast, and sum without error; you format them for display. Where you need more precision — FX rates, interest accrual — use `NUMERIC` with an explicit scale and a documented rounding rule at the point you post an entry, which is always in minor units.

**Q: Two transfers go A→B and B→A at the same time. What happens in your design?**
A: Both lock accounts with one statement ordered by id, so both try to lock the lower id first. One gets it and proceeds to lock the higher id; the other waits on the lower id. The first posts and commits in a couple of milliseconds, then the second proceeds with fresh balances. There is no cycle, so no deadlock and no retry.

**Q: How is a transfer request made idempotent?**
A: The client sends an idempotency key generated once per user action. The first statement of the transfer transaction inserts `(client_id, key, request_hash)` with `ON CONFLICT DO NOTHING`. A concurrent duplicate blocks on the unique index until the first commits, then sees the conflict and returns the stored response; a duplicate with a different body gets a 422. Because the key row commits atomically with the entries, there is no window where the money moved but the key was not recorded.

**Q: Why not read balances for card authorizations from a replica?**
A: Replicas lag, even by tens of milliseconds, and an authorization is a check-then-act on money. Two authorizations on the same account served from a replica that has not yet seen the first hold would both be approved. Authorizations must perform a conditional update on the primary; the home-screen balance can come from a replica if it is labelled with an as-of time.

**Q: Would you run transfers at SERIALIZABLE? (Senior)**
A: For a two-account transfer I prefer READ COMMITTED with explicit row locks in id order: it gives the same correctness with predictable waits and no abort storms under contention. SERIALIZABLE (SSI) earns its keep when the invariant spans rows you cannot conveniently lock — say, a limit on the sum of a customer's accounts or a rule over a set defined by a predicate. In that case I would use it for that operation only, keep transactions short to limit false positives, and ensure every caller retries on 40001 with backoff. Using it everywhere turns hot-account contention into aborts, and retries add load exactly when there is none to spare.

**Q: The fee revenue account is in every transaction. How do you stop it becoming a bottleneck? (Senior)**
A: Do not keep a cached, lockable balance for it. Its entries are inserted like any others, and inserts of different rows do not conflict, so the hot row disappears; its balance is derived from the latest snapshot plus entries since. If you need a near-real-time figure, split it into N sub-accounts chosen by hash and report their sum, or post customer legs against a suspense account and sweep into revenue every few seconds in one transaction. The invariant "entries sum to zero" still holds because each variant posts balanced transactions.

**Q: How would you shard this ledger, and what do you do about transfers between shards? (Senior)**
A: Shard by customer so all of a customer's accounts co-locate and most activity is single-shard. A cross-shard transfer is split into two locally balanced transactions linked by a transfer id: debit the sender and credit shard 1's clearing account, then debit shard 2's clearing account and credit the receiver, driven by a saga through outboxes on both sides. If the second leg fails permanently, the first is reversed. Each shard's books balance independently, and a global reconciliation proves the clearing accounts net to zero. I would avoid 2PC because a coordinator failure after prepare leaves locks held on both shards until someone resolves the in-doubt transaction.

**Q: A regulator asks what Alice's balance was on 3 March at 14:02. How do you answer?**
A: Take the latest balance snapshot for Alice at or before that time and add the sum of her entries with `created_at` after the snapshot and at or before 14:02, using the `(account_id, created_at)` index. Because entries are immutable and reversals are new entries, the answer is reproducible forever and matches what the ledger said at the time. If that month is archived, the same query runs against the archived partition or the warehouse copy.

**Q: How do you reconcile with the outside world?**
A: Every external movement goes through a clearing account, so at any moment its balance is "money in flight". Daily, you load the card network's or payment rail's settlement file into a staging table and match records by external reference and amount against clearing-account entries. Matched items are closed, unmatched ones become breaks that operations investigate and resolve with explicit adjustment transactions. Internal reconciliation (cached balances vs entries, trial balance) runs alongside, so you know whether a break is yours or theirs.

**Q: What RPO/RTO would you commit to, and how? (Senior)**
A: RPO 0 for committed transfers within a region, via a synchronous standby in another AZ with `synchronous_commit = on` and a quorum of two candidate standbys so one failure does not stall commits. RTO of a minute or two with Patroni-managed failover and fencing of the old primary. For a full regional loss, an async cross-region replica gives an RPO of seconds; the lost tail is recovered by replaying the idempotent requests clients retry and by reconciling against external rail files, and that residual risk is written down and accepted by the business.

## 10. Quick Revision & Cheat Sheet

| Concern | Design choice |
|---|---|
| Source of truth | append-only `entries`, grouped by `ledger_txns` |
| Conservation | deferred constraint trigger: SUM per txn per currency = 0 |
| Immutability | REVOKE UPDATE/DELETE + BEFORE UPDATE/DELETE trigger; reversals only |
| Money | `BIGINT` minor units + currency; NUMERIC only for rates |
| Balance | cached on customer accounts (lock target), derived for house accounts |
| No overdraw | row lock + app check, `CHECK (balance - held >= -overdraft)`, nightly L3 |
| Deadlocks | `WHERE id = ANY(...) ORDER BY id FOR NO KEY UPDATE` |
| Retries | idempotency row first, same txn as entries |
| Card holds | conditional UPDATE on `held_minor`; capture/release guarded by status |
| Durability | synchronous standby, `ANY 1 (...)` quorum, PITR |
| Scale-out | shard by customer; cross-shard via clearing accounts + saga |

- Money only moves; every ledger transaction sums to zero.
- Never update or delete an entry; reverse it.
- Integers for money, always.
- Lock accounts in id order in a single statement.
- The idempotency key commits in the same transaction as the money.
- Hot house accounts get derived balances, not a lockable row.
- Authorizations read the primary; statements read replicas.
- Reconciliation is a product feature, not a script someone runs.

## 11. Hands-On Exercises

Lab: `docker run --rm -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:17`, then `psql -h localhost -U postgres`.

1. **Floats lie.** Run `SELECT sum(0.1::float8) FROM generate_series(1,10);` and `SELECT sum(0.1::numeric) FROM generate_series(1,10);` and explain the difference. Then store 10 cents as `10::bigint` and show exact sums.
2. **Unbalanced transaction rejected.** Create `entries` with the deferred constraint trigger. In one transaction insert only the debit leg and COMMIT; observe the error at commit time. Then insert both legs and succeed.
3. **Deadlock and its fix.** In two sessions lock account 1 then 2, and 2 then 1, with `pg_sleep(2)` between. Observe `deadlock detected` after about a second. Repeat with `WHERE id = ANY(ARRAY[2,1]) ORDER BY id FOR NO KEY UPDATE` and observe a clean wait.
4. **Concurrent withdrawal.** With balance 100, run two sessions that each withdraw 80 using the conditional `UPDATE ... WHERE balance_minor - held_minor - 80 >= 0`. Show exactly one succeeds. Then try the read-then-write version at READ COMMITTED and REPEATABLE READ and record what each does.
5. **Idempotency race.** From two psql sessions start the transfer transaction with the same key; pause the first after the idempotency insert. Show the second blocks on the unique index and, after the first commits, inserts nothing.

**Mini project:** implement the ledger service (`post_transfer`, `place_hold`, `capture_hold`, `reverse`) in Go or Python. Write a load test with 10,000 random concurrent transfers among 100 accounts plus a hot fee account. Assert at the end: trial balance is zero, every cached balance equals its entry sum, no account is below its overdraft limit, and no idempotency key produced two ledger transactions. Measure p99 with and without a cached balance on the fee account.

## 12. Related Topics & Free Learning Resources

**Concept chapters this design applies:** [Ch 04 · Concurrency Control](topic.html?p=04-concurrency-control) · [Ch 05 · Locking Internals](topic.html?p=05-locking-internals) (lock ordering, FOR NO KEY UPDATE) · [Ch 06 · Isolation Deep Dive](topic.html?p=06-isolation-deep-dive) (when SSI is worth it) · [Ch 07 · Write-Ahead Logging](topic.html?p=07-write-ahead-logging) (what COMMIT guarantees) · [Ch 09 · Replication](topic.html?p=09-replication) · [Ch 10 · Consistency Models](topic.html?p=10-consistency-models) · [Ch 12 · Sharding](topic.html?p=12-sharding) · [Ch 13 · Distributed Transactions](topic.html?p=13-distributed-transactions) · [Ch 18 · High Availability](topic.html?p=18-high-availability) · [Ch 26 · Backup & Disaster Recovery](topic.html?p=26-backup-disaster-recovery) · [Ch 29 · Advanced Database Patterns](topic.html?p=29-advanced-database-patterns).

**Related case studies:** [Ch 31 · E-commerce](topic.html?p=31-case-ecommerce) · [Ch 39 · Payment System](topic.html?p=39-case-payment-system).

**SQL Handbook:** [Transactions & ACID](../sql/topic.html?p=25-transactions-acid) · [Isolation Levels](../sql/topic.html?p=26-isolation-levels) · [Locking & MVCC](../sql/topic.html?p=27-locking-mvcc) · [Keys & Constraints](../sql/topic.html?p=29-keys-constraints) · [Procedures & Triggers](../sql/topic.html?p=32-procedures-triggers).

**Other handbooks:** [Kafka & RabbitMQ · Idempotency & Outbox](../messaging/topic.html?p=21-idempotency-outbox).

- **PostgreSQL docs — CREATE TRIGGER (constraint triggers, DEFERRABLE)** — PostgreSQL · *Intermediate* · how the sum-to-zero check is deferred to commit. <https://www.postgresql.org/docs/current/sql-createtrigger.html>
- **PostgreSQL docs — Explicit Locking** — PostgreSQL · *Intermediate* · row lock modes (FOR UPDATE vs FOR NO KEY UPDATE) and deadlocks. <https://www.postgresql.org/docs/current/explicit-locking.html>
- **PostgreSQL docs — Synchronous Replication** — PostgreSQL · *Advanced* · `synchronous_standby_names` with FIRST/ANY for RPO 0. <https://www.postgresql.org/docs/current/warm-standby.html#SYNCHRONOUS-REPLICATION>
- **Accounting for Computer Scientists** — Martin Kleppmann · *Beginner* · double-entry bookkeeping explained as a graph of transfers. <https://martin.kleppmann.com/2011/03/07/accounting-for-computer-scientists.html>
- **Idempotent Requests** — Stripe API docs · *Intermediate* · the idempotency-key contract applied to money movement. <https://docs.stripe.com/api/idempotent_requests>
- **TigerBeetle documentation** — TigerBeetle · *Advanced* · a purpose-built double-entry ledger database and its design choices. <https://docs.tigerbeetle.com/>
- **Designing Data-Intensive Applications, ch. 7 & 9** — Martin Kleppmann · *Advanced* · transactions, write skew, and linearizability for money. <https://dataintensive.net/>

---

*Database Design Handbook — chapter 32.*
