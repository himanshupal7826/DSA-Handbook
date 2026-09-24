# 04 · Concurrency Control: Races, Lost Updates & CAS

> **In one line:** Every read-modify-write that spans two statements is a race waiting for traffic, and the fix is never "be careful" — it is to push the check and the write into one atomic step (a conditional UPDATE, a lock, a version compare, a constraint, or a serializable transaction with retries) chosen by how often conflicts really happen.

---

## 1. Overview

> **Builds on:** [SQL Handbook · Transactions & ACID](../sql/topic.html?p=25-transactions-acid) (atomicity is not isolation) · [SQL Handbook · Locking, MVCC & Deadlocks](../sql/topic.html?p=27-locking-mvcc) (`FOR UPDATE` and the version-column idea) · [Ch 03 · MVCC](topic.html?p=03-mvcc) (why readers see stale snapshots). The SQL Handbook introduced optimistic vs pessimistic locking in a table; this chapter is the working engineer's catalogue — which bug each pattern fixes, exactly how PostgreSQL executes it, how it fails under load, and the application code around it.

Here is the bug almost every backend ships at least once. A product has `stock = 1`. Two customers press "Buy" within the same few milliseconds. Each request runs:

```text
stock = SELECT stock FROM products WHERE id = 7;     -- both read 1
if stock > 0:
    UPDATE products SET stock = :stock - 1 WHERE id = 7;   -- both write 0
    INSERT INTO orders ...                                 -- two orders
```

Both requests see `1`, both decide there is stock, both write `0`, both create an order. You sold one item twice and your stock column says everything is fine. Wrapping it in `BEGIN … COMMIT` does not help: at PostgreSQL's default READ COMMITTED level, each statement sees the latest committed data, and nothing stops two transactions from reading the same value before either writes. Transactions give you atomicity (all or nothing), not mutual exclusion.

The naive fixes fail in instructive ways. "Check in the application, then write" is exactly the bug. "Add a mutex in the service" works on one instance and silently breaks when you scale to three pods. "Use a distributed lock in Redis" adds a second system whose failure modes (lease expiry during a GC pause, failover) reintroduce the race ([Caching with Redis · Distributed Locks](../redis-caching/topic.html?p=23-distributed-locks-redlock)). "Raise the isolation level to SERIALIZABLE" is correct but, without a retry loop, turns races into user-facing errors. The database already has the right primitives; the skill is picking the right one for the conflict rate and the shape of the invariant.

> **Why this matters:** oversold inventory, double-spent balances, duplicate signups, two workers processing the same job and counters that drift are all the same bug. Interviewers probe it in every design round that involves money, inventory or quotas.

## 2. Core Concepts

- **Race condition** — the outcome depends on the timing of concurrent operations. *Why it matters:* it passes every test run serially and fails only under production concurrency.
- **Read-modify-write (RMW)** — read a value, compute in the app, write the result. *Why it matters:* the gap between read and write is where another writer slips in.
- **Lost update** — two RMW cycles interleave and the second write overwrites the first. *Why it matters:* the most common concurrency bug; silent, no error raised.
- **Write-write conflict** — two transactions update the same row. *Why it matters:* the database always serialises these with a row lock; what differs is what the second writer sees afterwards.
- **Read-write conflict (write skew)** — transactions read overlapping data and write *different* rows, jointly violating an invariant. *Why it matters:* row locks on written rows do not catch it; see [Ch 06](topic.html?p=06-isolation-deep-dive).
- **Pessimistic concurrency control** — lock before you read what you will change (`SELECT … FOR UPDATE`). *Why it matters:* conflicting transactions wait instead of failing; costs lock hold time and deadlock risk.
- **Optimistic concurrency control (OCC)** — read without locking, then write only if nothing changed; retry on conflict. *Why it matters:* no locks held across think time; costs retries when conflicts are frequent.
- **Compare-and-swap (CAS)** — "set X to new if X still equals expected", atomically. *Why it matters:* the primitive under every optimistic scheme, from CPU instructions to `UPDATE … WHERE version = $v` to DynamoDB condition expressions.
- **Version column** — an integer (or timestamp) bumped on every write and used as the CAS "expected" value. *Why it matters:* makes any multi-field edit optimistic-lockable.
- **Atomic conditional update** — `UPDATE … SET x = x - 1 WHERE id = $1 AND x > 0`: check and write in one statement. *Why it matters:* the simplest correct fix for counters and inventory, no app-side retry needed.
- **Serialization failure (SQLSTATE 40001)** — the database aborts a transaction it cannot serialise. *Why it matters:* at REPEATABLE READ and SERIALIZABLE it is expected, not exceptional; the app must retry.
- **Retry loop** — re-run the whole transaction on 40001 / 40P01 / version conflicts with backoff and jitter. *Why it matters:* optimistic schemes are only correct *with* it.
- **Hot row** — a single row written by many concurrent transactions (global counter, popular product). *Why it matters:* every pattern serialises on it; throughput is capped by lock hold time.

## 3. Theory & Principles

### Anatomy of the lost update — and what the database does with the second writer

A lost update needs three ingredients: a read, a decision or computation in the application based on that read, and a write that does not re-verify the read. Take away any one and the bug disappears. The patterns in this chapter each remove one.

What makes the fixes work is how PostgreSQL executes an UPDATE on a row that another transaction is modifying:

1. The second UPDATE finds the row version it would modify, sees that its `xmax` belongs to an in-progress transaction, and **waits** for that transaction's row lock ([Ch 05](topic.html?p=05-locking-internals)).
2. When the first transaction **commits**, the behaviour depends on isolation level:
   - **READ COMMITTED (default):** PostgreSQL follows the update chain to the *newest* version, **re-evaluates the WHERE clause against it** (the "EvalPlanQual" recheck), and if it still matches, applies the UPDATE to that newest version — with expressions like `stock - 1` computed from the new value.
   - **REPEATABLE READ / SERIALIZABLE:** the newest version is not in the transaction's snapshot, so PostgreSQL raises `ERROR: could not serialize access due to concurrent update` (SQLSTATE `40001`). The application must retry the entire transaction.
3. If the first transaction **rolls back**, the second proceeds on the original version.

That is why `UPDATE products SET stock = stock - 1 WHERE id = 7 AND stock > 0` is safe at READ COMMITTED with no explicit lock: the second decrement waits, then re-checks `stock > 0` against the committed result, and either decrements the true current value or matches zero rows. The application learns the outcome from the affected-row count (or `RETURNING`).

```svg
<svg viewBox="0 0 880 440" width="100%" height="440" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c04a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#d97706"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">stock = 1, two buyers: read-then-write vs one atomic conditional UPDATE</text>

  <rect x="20" y="40" width="410" height="330" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="225" y="62" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Read in app, write back (lost update)</text>
  <text x="120" y="86" text-anchor="middle" fill="#1e293b" font-weight="bold">T1</text><text x="330" y="86" text-anchor="middle" fill="#1e293b" font-weight="bold">T2</text>
  <line x1="120" y1="94" x2="120" y2="300" stroke="#94a3b8" stroke-dasharray="4 3"/><line x1="330" y1="94" x2="330" y2="300" stroke="#94a3b8" stroke-dasharray="4 3"/>
  <rect x="40" y="104" width="160" height="26" rx="4" fill="#fff" stroke="#fca5a5"/><text x="120" y="121" text-anchor="middle" fill="#7f1d1d" font-size="10">SELECT stock → 1</text>
  <rect x="250" y="138" width="160" height="26" rx="4" fill="#fff" stroke="#fca5a5"/><text x="330" y="155" text-anchor="middle" fill="#7f1d1d" font-size="10">SELECT stock → 1</text>
  <rect x="40" y="172" width="160" height="26" rx="4" fill="#fee2e2" stroke="#dc2626"/><text x="120" y="189" text-anchor="middle" fill="#7f1d1d" font-size="10">UPDATE stock = 0 · COMMIT</text>
  <rect x="250" y="206" width="160" height="40" rx="4" fill="#fee2e2" stroke="#dc2626"/><text x="330" y="222" text-anchor="middle" fill="#7f1d1d" font-size="10">UPDATE stock = 0 (waits,</text><text x="330" y="236" text-anchor="middle" fill="#7f1d1d" font-size="10">then writes 0) · COMMIT</text>
  <rect x="40" y="258" width="370" height="30" rx="4" fill="#fee2e2" stroke="#dc2626"/><text x="225" y="277" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">2 orders, stock 0 — one unit sold twice, no error anywhere</text>
  <text x="40" y="318" fill="#991b1b" font-size="10">The row lock DID serialise the two UPDATEs.</text>
  <text x="40" y="334" fill="#991b1b" font-size="10">The bug is that T2's written value came from a stale read.</text>
  <text x="40" y="354" fill="#991b1b" font-size="10" font-weight="bold">Locks protect writes, not decisions made in app code.</text>

  <rect x="450" y="40" width="410" height="330" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="655" y="62" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">UPDATE … SET stock = stock - 1 WHERE stock &gt; 0</text>
  <text x="550" y="86" text-anchor="middle" fill="#1e293b" font-weight="bold">T1</text><text x="760" y="86" text-anchor="middle" fill="#1e293b" font-weight="bold">T2</text>
  <line x1="550" y1="94" x2="550" y2="300" stroke="#94a3b8" stroke-dasharray="4 3"/><line x1="760" y1="94" x2="760" y2="300" stroke="#94a3b8" stroke-dasharray="4 3"/>
  <rect x="470" y="104" width="160" height="40" rx="4" fill="#dcfce7" stroke="#16a34a"/><text x="550" y="120" text-anchor="middle" fill="#14532d" font-size="10">UPDATE: 1 &gt; 0 ✓ → 0</text><text x="550" y="134" text-anchor="middle" fill="#14532d" font-size="10">row lock held</text>
  <rect x="680" y="138" width="160" height="40" rx="4" fill="#fef3c7" stroke="#d97706"/><text x="760" y="154" text-anchor="middle" fill="#92400e" font-size="10">UPDATE: row locked</text><text x="760" y="168" text-anchor="middle" fill="#92400e" font-size="10">→ WAIT</text>
  <rect x="470" y="186" width="160" height="26" rx="4" fill="#dcfce7" stroke="#16a34a"/><text x="550" y="203" text-anchor="middle" fill="#14532d" font-size="10">COMMIT → UPDATE 1</text>
  <path d="M632,200 L676,218" stroke="#d97706" stroke-width="1.5" marker-end="url(#c04a)"/>
  <rect x="680" y="206" width="160" height="40" rx="4" fill="#dcfce7" stroke="#16a34a"/><text x="760" y="222" text-anchor="middle" fill="#14532d" font-size="10">re-check on NEW version:</text><text x="760" y="236" text-anchor="middle" fill="#14532d" font-size="10">0 &gt; 0 ✗ → UPDATE 0</text>
  <rect x="470" y="258" width="370" height="30" rx="4" fill="#dcfce7" stroke="#16a34a"/><text x="655" y="277" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">1 order, T2 told "sold out" — invariant holds</text>
  <text x="470" y="318" fill="#166534" font-size="10">READ COMMITTED: re-evaluates WHERE on the latest row.</text>
  <text x="470" y="334" fill="#166534" font-size="10">REPEATABLE READ: T2 gets 40001 instead → retry.</text>
  <text x="470" y="354" fill="#166534" font-size="10" font-weight="bold">Check + write in ONE statement = no gap to race in.</text>

  <rect x="20" y="384" width="840" height="44" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="440" y="402" text-anchor="middle" fill="#334155" font-size="10">Same logic, three other ways to close the gap: lock the row before reading (FOR UPDATE), compare a version at write time (CAS),</text>
  <text x="440" y="418" text-anchor="middle" fill="#334155" font-size="10">or let SERIALIZABLE detect the conflict and abort one side. Each moves the check to where the database can enforce it.</text>
</svg>
```

> **MySQL difference:** InnoDB's default REPEATABLE READ does **not** protect the read-then-write pattern either: a plain `SELECT` reads the transaction's snapshot, but an `UPDATE` always operates on the **latest committed** version (locking reads and writes are "current reads"). There is no first-updater-wins abort, so T2's `UPDATE stock = 0` simply waits and then overwrites. `UPDATE … SET stock = stock - 1 WHERE stock > 0` is safe in InnoDB because the WHERE and the expression are evaluated on the current version under the row lock. Also note that MySQL's "affected rows" counts rows *changed*, not *matched*, unless the client sets `CLIENT_FOUND_ROWS` — an UPDATE that writes identical values reports 0.

### Optimistic vs pessimistic: a cost model, not a preference

Both approaches are correct; they differ in who pays and when.

**Pessimistic** (`SELECT … FOR UPDATE`, then compute, then UPDATE): the second transaction blocks at the SELECT until the first commits, then reads the fresh value. Cost = **waiting**, proportional to the lock hold time of the first transaction. Risks: deadlocks when transactions lock multiple rows in different orders, and catastrophic behaviour if the lock is held across a slow external call.

**Optimistic** (read with a version, compute, `UPDATE … WHERE id = $1 AND version = $2`): nobody waits on the read. If the version changed, the UPDATE matches zero rows and the application re-reads and retries. Cost = **wasted work** on conflict, proportional to conflict probability × work per attempt. Risks: under high contention, retries multiply load and some requests starve.

A rough rule: if the probability that two transactions touch the same row within one transaction's duration is low (user profile edits, document saves, admin forms), optimistic wins — no locks, no deadlocks, works across HTTP round trips. If it is high (a flash-sale product, a shared account balance, a global counter), pessimistic or atomic updates win, because retry storms waste more than queuing does. And if the whole operation can be expressed as one conditional statement, do that — it is pessimistic locking with the smallest possible hold time.

### The hot-row ceiling

Whatever pattern you pick, writes to one row serialise: a transaction holds the row lock from its UPDATE until COMMIT. If a transaction holds that lock for `h` milliseconds (statement time + any work after it + commit fsync + client round trips), the row supports at most about `1000 / h` updates per second. With an autocommitted single UPDATE and a ~1 ms WAL flush, that is on the order of hundreds to low thousands per second; wrap it in a transaction that does three more queries over the network and it drops to a few hundred. Past that ceiling, latency grows without bound as requests queue. The only escapes are shorter hold times or **not having one row**: sharded counters, batching, or moving the counter out of the transactional path.

## 4. Architecture & Workflow

### The pattern catalogue

| # | Pattern | Fixes | Mechanism | Retry needed? |
|---|---|---|---|---|
| 1 | Atomic conditional UPDATE | Lost update on counters, stock, balances | Check + write in one statement, row lock + recheck | No (0 rows = business "no") |
| 2 | `SELECT … FOR UPDATE` | RMW with complex app logic | Row lock before read | Only on deadlock (40P01) |
| 3 | Version column (OCC) | Lost update across think time / HTTP | CAS on `version` | Yes, on 0 rows |
| 4 | REPEATABLE READ + retry | Lost update in multi-statement txns | First-updater-wins → 40001 | Yes |
| 5 | SERIALIZABLE + retry | Write skew, complex invariants | SSI conflict detection → 40001 | Yes |
| 6 | Unique / exclusion constraint | Duplicate inserts, overlapping ranges | Index enforces invariant | Handle 23505 / ON CONFLICT |
| 7 | `FOR UPDATE SKIP LOCKED` | Two workers claiming one job | Skip rows others locked | No |
| 8 | Advisory lock | Mutual exclusion on a non-row concept | Named lock in lock manager | Only on timeout |
| 9 | Sharded / batched counter | Hot-row throughput ceiling | Spread writes over N rows | No |

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c04b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Choosing a concurrency pattern</text>

  <rect x="320" y="40" width="240" height="40" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="440" y="58" text-anchor="middle" fill="#5b21b6" font-weight="bold">What must never happen?</text>
  <text x="440" y="72" text-anchor="middle" fill="#5b21b6" font-size="9">write the invariant down first</text>

  <path d="M360,82 L150,120" stroke="#334155" stroke-width="1.5" marker-end="url(#c04b)"/>
  <path d="M440,82 L440,120" stroke="#334155" stroke-width="1.5" marker-end="url(#c04b)"/>
  <path d="M520,82 L730,120" stroke="#334155" stroke-width="1.5" marker-end="url(#c04b)"/>

  <rect x="30" y="122" width="240" height="46" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="150" y="140" text-anchor="middle" fill="#1e40af" font-weight="bold">A value goes wrong</text>
  <text x="150" y="156" text-anchor="middle" fill="#1e40af" font-size="9">counter, stock, balance, a row's fields</text>
  <rect x="320" y="122" width="240" height="46" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="440" y="140" text-anchor="middle" fill="#1e40af" font-weight="bold">A duplicate / overlap exists</text>
  <text x="440" y="156" text-anchor="middle" fill="#1e40af" font-size="9">two accounts per email, double booking</text>
  <rect x="610" y="122" width="240" height="46" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="730" y="140" text-anchor="middle" fill="#1e40af" font-weight="bold">A rule across rows breaks</text>
  <text x="730" y="156" text-anchor="middle" fill="#1e40af" font-size="9">"≥ 1 doctor on call", "sum ≤ limit"</text>

  <path d="M150,170 L150,196" stroke="#334155" stroke-width="1.5" marker-end="url(#c04b)"/>
  <rect x="30" y="198" width="240" height="40" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="150" y="215" text-anchor="middle" fill="#1e293b" font-size="10" font-weight="bold">Expressible as ONE UPDATE … WHERE?</text>
  <text x="150" y="229" text-anchor="middle" fill="#334155" font-size="9">(arithmetic + a guard condition)</text>
  <path d="M90,240 L70,266" stroke="#16a34a" stroke-width="1.5" marker-end="url(#c04b)"/><text x="62" y="258" fill="#15803d" font-size="9">yes</text>
  <path d="M210,240 L230,266" stroke="#dc2626" stroke-width="1.5" marker-end="url(#c04b)"/><text x="226" y="258" fill="#b91c1c" font-size="9">no</text>
  <rect x="20" y="268" width="120" height="50" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="80" y="288" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">Atomic</text>
  <text x="80" y="302" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">conditional UPDATE</text>
  <rect x="160" y="268" width="130" height="50" rx="6" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="225" y="286" text-anchor="middle" fill="#1e293b" font-size="10" font-weight="bold">Conflicts frequent?</text>
  <text x="225" y="300" text-anchor="middle" fill="#334155" font-size="9">or think time between</text>
  <text x="225" y="312" text-anchor="middle" fill="#334155" font-size="9">read and write?</text>
  <path d="M190,320 L140,356" stroke="#334155" stroke-width="1.5" marker-end="url(#c04b)"/><text x="130" y="344" fill="#334155" font-size="9">frequent</text>
  <path d="M260,320 L290,356" stroke="#334155" stroke-width="1.5" marker-end="url(#c04b)"/><text x="282" y="344" fill="#334155" font-size="9">rare / HTTP</text>
  <rect x="60" y="358" width="140" height="44" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="130" y="376" text-anchor="middle" fill="#92400e" font-size="10" font-weight="bold">SELECT … FOR UPDATE</text>
  <text x="130" y="391" text-anchor="middle" fill="#92400e" font-size="9">short txn, lock order</text>
  <rect x="220" y="358" width="140" height="44" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="290" y="376" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">Version column (OCC)</text>
  <text x="290" y="391" text-anchor="middle" fill="#15803d" font-size="9">+ retry loop / ETag</text>

  <path d="M440,170 L440,196" stroke="#334155" stroke-width="1.5" marker-end="url(#c04b)"/>
  <rect x="330" y="198" width="220" height="70" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="440" y="218" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">Let a constraint enforce it</text>
  <text x="440" y="234" text-anchor="middle" fill="#166534" font-size="9">UNIQUE / partial UNIQUE index</text>
  <text x="440" y="248" text-anchor="middle" fill="#166534" font-size="9">EXCLUDE USING gist (ranges)</text>
  <text x="440" y="262" text-anchor="middle" fill="#166534" font-size="9">INSERT … ON CONFLICT</text>
  <text x="440" y="296" text-anchor="middle" fill="#334155" font-size="9">never "SELECT then INSERT if absent"</text>

  <path d="M730,170 L730,196" stroke="#334155" stroke-width="1.5" marker-end="url(#c04b)"/>
  <rect x="620" y="198" width="220" height="70" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="730" y="218" text-anchor="middle" fill="#5b21b6" font-size="10" font-weight="bold">SERIALIZABLE + retry (40001)</text>
  <text x="730" y="236" text-anchor="middle" fill="#5b21b6" font-size="9">or materialise the conflict:</text>
  <text x="730" y="250" text-anchor="middle" fill="#5b21b6" font-size="9">lock a parent/summary row FOR UPDATE</text>
  <text x="730" y="264" text-anchor="middle" fill="#5b21b6" font-size="9">(see Ch 06 for write skew)</text>

  <rect x="400" y="330" width="450" height="120" rx="8" fill="#fef2f2" stroke="#dc2626"/>
  <text x="625" y="350" text-anchor="middle" fill="#b91c1c" font-size="11" font-weight="bold">Then check the throughput ceiling</text>
  <text x="414" y="372" fill="#7f1d1d" font-size="10">One hot row ≈ at most 1 / (lock hold time) writes per second.</text>
  <text x="414" y="390" fill="#7f1d1d" font-size="10">Need more? Shard the row (N counter rows, SUM on read), batch</text>
  <text x="414" y="406" fill="#7f1d1d" font-size="10">increments, or pre-allocate (split stock into buckets).</text>
  <text x="414" y="430" fill="#7f1d1d" font-size="10" font-weight="bold">And every pattern that can fail with 40001/40P01 needs a retry loop.</text>
</svg>
```

### Workflow: an optimistic edit across an HTTP round trip

Optimistic locking shines when the "transaction" spans a user: the edit form was loaded at 10:00 and submitted at 10:07. Holding a database lock for seven minutes is absurd; comparing a version at submit time is trivial.

```text
10:00  GET /products/7          → SELECT ..., version FROM products WHERE id = 7   → version 12
                                → response header  ETag: "12"
10:03  (colleague saves)        → UPDATE ... SET ..., version = 13 WHERE id = 7 AND version = 12   → 1 row
10:07  PUT /products/7          → request header   If-Match: "12"
                                → UPDATE ... SET ..., version = 13 WHERE id = 7 AND version = 12   → 0 rows
                                → 412 Precondition Failed  ("someone else changed this — reload")
```

The same CAS shape appears in almost every data store: DynamoDB `ConditionExpression`, etcd transactions comparing `mod_revision`, Redis `WATCH`/`MULTI`/`EXEC` ([Caching with Redis · Pipelining, Lua & Transactions](../redis-caching/topic.html?p=22-pipelining-lua-transactions)), Cassandra lightweight transactions (`UPDATE … IF version = 12`, [Cassandra · Batches & LWT](../cassandra/topic.html?p=14-batches-lightweight-transactions)), Elasticsearch `if_seq_no`/`if_primary_term`. Learn it once.

## 5. Implementation

### Simple example: reproduce and fix the race in two psql sessions

```sql
CREATE TABLE products (id int PRIMARY KEY, name text, stock int NOT NULL CHECK (stock >= 0), version int NOT NULL DEFAULT 1);
INSERT INTO products VALUES (7, 'Limited sneaker', 1, 1);
```

The bug (both sessions at READ COMMITTED):

```text
S1: BEGIN;
S1: SELECT stock FROM products WHERE id = 7;            -- 1
S2: BEGIN;
S2: SELECT stock FROM products WHERE id = 7;            -- 1
S1: UPDATE products SET stock = 0 WHERE id = 7;         -- app computed 1 - 1
S2: UPDATE products SET stock = 0 WHERE id = 7;         -- blocks on S1's row lock...
S1: COMMIT;
S2: -- ...unblocks: UPDATE 1                            -- overwrote with a stale computation
S2: COMMIT;                                             -- two sales, stock 0
```

Fix 1 — atomic conditional update (preferred when it fits):

```sql
UPDATE products SET stock = stock - 1
WHERE id = 7 AND stock > 0
RETURNING stock;
-- S1: stock = 0 (1 row)       S2 (after waiting): 0 rows → "sold out"
```

Fix 2 — pessimistic, when the decision needs app logic between read and write:

```sql
BEGIN;
SELECT stock, name FROM products WHERE id = 7 FOR UPDATE;   -- S2 waits here, then reads the fresh value
-- app: fraud checks, per-customer limits, pricing rules...
UPDATE products SET stock = stock - 1 WHERE id = 7;
INSERT INTO orders (product_id, customer_id) VALUES (7, 991);
COMMIT;
```

Fix 3 — optimistic, when the read and write are far apart:

```sql
SELECT stock, version FROM products WHERE id = 7;           -- stock 1, version 1
UPDATE products SET stock = 0, version = version + 1
WHERE id = 7 AND version = 1;                               -- S1: UPDATE 1 · S2: UPDATE 0 → re-read, retry
```

Fix 4 — isolation level, when many rows are read and written in one transaction:

```text
S1: BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT stock ... → 1; UPDATE products SET stock = 0 ...
S2: BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT stock ... → 1; UPDATE products SET stock = 0 ... (waits)
S1: COMMIT;
S2: ERROR:  could not serialize access due to concurrent update       -- SQLSTATE 40001 → retry whole txn
```

### Uniqueness belongs in constraints

"Check whether the email exists, then insert" is a race for the same reason: both requests check, both see nothing, both insert. The database can enforce the invariant atomically through an index:

```sql
-- One account per email, case-insensitively
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

INSERT INTO users (email, name) VALUES ($1, $2)
ON CONFLICT (lower(email)) DO NOTHING
RETURNING id;                                  -- no row returned → already exists

-- At most one ACTIVE subscription per user (history rows allowed)
CREATE UNIQUE INDEX one_active_sub ON subscriptions (user_id) WHERE status = 'active';

-- No double-booking of a room: ranges must not overlap
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE bookings ADD CONSTRAINT no_overlap
  EXCLUDE USING gist (room_id WITH =, during WITH &&);
-- a concurrent overlapping insert fails with SQLSTATE 23P01 (exclusion_violation)
```

The second inserter of a duplicate key waits for the first to commit or abort before deciding — the unique index is itself a concurrency-control mechanism.

### Counters: from one hot row to sharded rows

```sql
-- Hot: every like on a viral post updates the same row
UPDATE posts SET like_count = like_count + 1 WHERE id = $1;

-- Sharded: 16 rows per post, pick one at random, sum on read
CREATE TABLE post_like_shards (post_id bigint, shard smallint, n bigint NOT NULL DEFAULT 0,
                               PRIMARY KEY (post_id, shard));
INSERT INTO post_like_shards (post_id, shard, n) VALUES ($1, floor(random() * 16)::int, 1)
ON CONFLICT (post_id, shard) DO UPDATE SET n = post_like_shards.n + 1;

SELECT sum(n) AS likes FROM post_like_shards WHERE post_id = $1;
```

Contention drops roughly N-fold; reads become an aggregate over N rows (fine for N ≈ 8–64, and cacheable). For very high rates, batch in the application (accumulate for 1 s, write once) or append events and aggregate asynchronously.

### Advisory locks: mutual exclusion for things that are not rows

```sql
-- "Only one invoice run per tenant at a time", held until the transaction ends
BEGIN;
SELECT pg_try_advisory_xact_lock(hashtextextended('invoice-run:' || $1, 0)) AS got_it;
-- got_it = false → another worker is running it; skip
-- ... do the run ...
COMMIT;   -- lock released automatically
```

Prefer the `_xact_` variants: session-level advisory locks survive the transaction and break under PgBouncer transaction pooling, where the next transaction on that server connection may belong to a different client ([Ch 20](topic.html?p=20-database-application-architecture)).

### Real-world example: the optimistic retry loop in Go

A product-catalogue service lets merchants edit listings through an API (optimistic, version column), and runs multi-row inventory rebalancing jobs at SERIALIZABLE. Both need one retry wrapper that understands which errors are safe to retry. Using `pgx/v5`:

```go
package store

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrVersionConflict = errors.New("version conflict")
var ErrNotFound = errors.New("not found")

// retryable reports whether re-running the WHOLE transaction may succeed.
func retryable(err error) bool {
	if errors.Is(err, ErrVersionConflict) {
		return true
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "40001", // serialization_failure (RR / SERIALIZABLE)
			"40P01": // deadlock_detected
			return true
		}
	}
	return false
}

// withRetry runs fn up to maxAttempts times with capped exponential backoff and full jitter.
func withRetry(ctx context.Context, maxAttempts int, fn func(context.Context) error) error {
	var err error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		if err = fn(ctx); err == nil || !retryable(err) {
			return err
		}
		ceiling := time.Duration(10<<(attempt-1)) * time.Millisecond // 10, 20, 40, 80ms...
		if ceiling > 500*time.Millisecond {
			ceiling = 500 * time.Millisecond
		}
		select {
		case <-time.After(time.Duration(rand.Int63n(int64(ceiling)))):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return fmt.Errorf("giving up after %d attempts: %w", maxAttempts, err)
}

type Listing struct {
	ID         int64
	Title      string
	PriceCents int64
	Version    int32
}

// UpdateListing applies a pure function to the latest listing with optimistic concurrency.
// apply must be free of side effects: it may run several times.
func UpdateListing(ctx context.Context, pool *pgxpool.Pool, id int64, apply func(*Listing) error) (Listing, error) {
	var out Listing
	err := withRetry(ctx, 5, func(ctx context.Context) error {
		var l Listing
		err := pool.QueryRow(ctx,
			`SELECT id, title, price_cents, version FROM listings WHERE id = $1`, id,
		).Scan(&l.ID, &l.Title, &l.PriceCents, &l.Version)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if err := apply(&l); err != nil {
			return err // business validation failure: not retryable
		}
		tag, err := pool.Exec(ctx,
			`UPDATE listings SET title = $1, price_cents = $2, version = version + 1
			  WHERE id = $3 AND version = $4`,
			l.Title, l.PriceCents, l.ID, l.Version)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrVersionConflict // changed (or deleted) since we read it: re-read and re-apply
		}
		l.Version++
		out = l
		return nil
	})
	return out, err
}

// Rebalance moves stock between warehouses at SERIALIZABLE; the whole txn is retried on 40001.
func Rebalance(ctx context.Context, pool *pgxpool.Pool, sku string, from, to int64, qty int32) error {
	return withRetry(ctx, 8, func(ctx context.Context) error {
		return pgx.BeginTxFunc(ctx, pool, pgx.TxOptions{IsoLevel: pgx.Serializable}, func(tx pgx.Tx) error {
			var avail int32
			if err := tx.QueryRow(ctx,
				`SELECT qty FROM stock WHERE sku = $1 AND warehouse_id = $2`, sku, from).Scan(&avail); err != nil {
				return err
			}
			if avail < qty {
				return fmt.Errorf("insufficient stock: have %d, need %d", avail, qty)
			}
			if _, err := tx.Exec(ctx,
				`UPDATE stock SET qty = qty - $3 WHERE sku = $1 AND warehouse_id = $2`, sku, from, qty); err != nil {
				return err
			}
			_, err := tx.Exec(ctx,
				`INSERT INTO stock (sku, warehouse_id, qty) VALUES ($1, $2, $3)
				 ON CONFLICT (sku, warehouse_id) DO UPDATE SET qty = stock.qty + EXCLUDED.qty`, sku, to, qty)
			return err // commit happens in BeginTxFunc; a 40001 at COMMIT is retried too
		})
	})
}
```

Three details that separate a correct retry loop from a dangerous one:

1. **Retry the whole transaction, including the reads.** Retrying just the failed statement re-applies a decision based on stale data.
2. **Keep side effects out of the retried function.** Sending an email or calling a payment API inside `apply` means doing it once per attempt. Record intent in the database (an outbox row) and act after commit ([Kafka & RabbitMQ · Idempotency & Outbox](../messaging/topic.html?p=21-idempotency-outbox)).
3. **Bound attempts and add jitter.** Unbounded, synchronised retries turn a contention spike into a thundering herd.

One more failure mode no retry loop can fix blindly: the connection drops *during* `COMMIT`. You do not know whether it committed. Retrying a non-idempotent transaction can double-apply it; make such operations idempotent with a client-supplied key and a unique constraint ([System Design · Idempotency](../system-design/topic.html?p=22-idempotency)).

A Python equivalent of the atomic path, for completeness — no retry loop needed because the database does the check:

```python
import psycopg

def reserve(conn: psycopg.Connection, product_id: int, qty: int) -> bool:
    with conn.transaction():
        row = conn.execute(
            "UPDATE products SET stock = stock - %s "
            "WHERE id = %s AND stock >= %s RETURNING stock",
            (qty, product_id, qty),
        ).fetchone()
        if row is None:
            return False            # sold out (or no such product): a business answer, not an error
        conn.execute(
            "INSERT INTO reservations (product_id, qty) VALUES (%s, %s)", (product_id, qty)
        )
        return True
```

> **MySQL difference:** the same patterns apply with different spellings: `INSERT … ON DUPLICATE KEY UPDATE` instead of `ON CONFLICT`, `GET_LOCK('name', timeout)` / `RELEASE_LOCK` for named locks (session-scoped), SQLSTATE `40001` with MySQL error 1213 for deadlocks and 1205 for lock-wait timeouts (the latter rolls back only the statement by default, so the application must decide to roll back the transaction). No exclusion constraints — overlapping-range rules need `SELECT … FOR UPDATE` on a parent row or SERIALIZABLE.

## 6. Advantages, Disadvantages & Trade-offs

| Pattern | Strength | Weakness | Best for |
|---|---|---|---|
| Atomic conditional UPDATE | Minimal lock time, no retries, simplest | Only fits arithmetic + guard logic | Stock, balances, quotas, counters |
| `SELECT … FOR UPDATE` | Arbitrary app logic, no retries | Waiting, deadlocks, terrible if held across I/O | Short RMW with complex rules |
| Version column (OCC) | No locks across think time; works over HTTP | Retries; starvation under contention | Edits, forms, documents, config |
| REPEATABLE READ + retry | Protects every row the txn updates | 40001 retries; does not stop write skew | Multi-row updates in one txn |
| SERIALIZABLE + retry | Protects arbitrary invariants | More aborts, retry discipline required | Cross-row rules, complex logic |
| Constraints | Declarative, cannot be bypassed by any client | Only uniqueness/exclusion/check shapes | Identity, booking, "at most one" |
| Advisory locks | Lock arbitrary concepts cheaply | Easy to leak (session locks), invisible to schema | Jobs, migrations, per-tenant work |
| Sharded counter | Removes the hot-row ceiling | Reads aggregate; approximate if cached | Likes, views, rate counters |

### When to use each

- Use the **atomic UPDATE** whenever the check and the change fit in one statement — it should be your default.
- Use **pessimistic locking** for short transactions with logic between read and write, when conflicts are common.
- Use **optimistic locking** when the read and write are separated by user think time or network hops, or when conflicts are rare.
- Use **constraints** for any "must be unique / must not overlap" invariant, always, even if you also check in code for nicer errors.
- Use **SERIALIZABLE** when invariants span rows you do not write and you can afford retries.

### When NOT to use them

- Do not use optimistic locking on a hot row: at high contention, most attempts fail and retries amplify load.
- Do not hold `FOR UPDATE` locks across HTTP calls, queues or user interaction.
- Do not use application mutexes or in-process locks as the correctness mechanism in a horizontally scaled service.
- Do not reach for a Redis/ZooKeeper distributed lock to protect a row that lives in one database — the database's own locking is stronger and simpler.

## 7. Common Mistakes & Best Practices

1. **Trusting `BEGIN … COMMIT` to prevent races.** Developers wrap a check-then-write in a transaction and assume it is safe. At READ COMMITTED it is not; the transaction only makes the writes atomic. Instead use one of the patterns above and write a concurrent test that proves it.
2. **Computing new values in the application.** `SET balance = :newBalance` bakes in a stale read. Instead express the change relative to the current value (`balance = balance - :amount`) with a guard in the WHERE.
3. **Ignoring the affected-row count.** An optimistic or conditional UPDATE that matches zero rows is the *signal*; code that does not check it silently loses the write. Instead check `RowsAffected()` or use `RETURNING` and treat "no row" explicitly.
4. **Retrying only the failed statement.** On 40001 people re-run the UPDATE that failed. Instead roll back and re-run the whole transaction from its first read.
5. **Side effects inside retried code.** Emails, payments or messages sent inside the retried block happen once per attempt. Instead write an outbox row in the transaction and dispatch after commit.
6. **Check-then-insert for uniqueness.** Two requests pass the check and both insert. Instead create a unique (or partial unique / exclusion) constraint and handle `23505` / use `ON CONFLICT`.
7. **One global counter row for a high-rate event.** Every write serialises on it; latency explodes under load. Instead shard the counter, batch, or aggregate asynchronously.
8. **Session-level advisory locks behind a transaction pooler.** The lock stays on a server connection that the next client inherits. Instead use `pg_advisory_xact_lock` or a session pool for lock-holding workers.

**Best practices:** write the invariant down; prefer declarative enforcement (constraints) over procedural; make the default pattern the atomic conditional UPDATE; keep transactions short; centralise retry logic in one helper that knows the retryable SQLSTATEs; and load-test with deliberate concurrency (e.g. 50 goroutines buying the last item) in CI.

## 8. Production: Failure Scenarios, Monitoring & Scaling

### Failure scenarios

**The oversold flash sale.** At 12:00:00 a 500-unit drop gets 40,000 purchase requests in 3 seconds. Orders created: 612. Root cause: stock was read in the service, decremented in memory and written back (`SET stock = :new`); the row lock serialised the writes but not the decisions. Fix: `UPDATE … SET stock = stock - 1 WHERE id = $1 AND stock > 0 RETURNING stock`, and reconcile the 112 oversold orders with customer service.

**Retry storm on a hot row.** A "team budget" row is updated optimistically by every expense submission. During month-end, 300 submissions/s target 20 teams. Conflict rate rises above 80%; each failed attempt re-reads and recomputes, database CPU hits 100%, and p99 goes from 40 ms to 9 s with many requests exhausting retries. Fix: switch to an atomic conditional UPDATE (`remaining = remaining - $amt WHERE remaining >= $amt`), which queues instead of retrying; consider per-team sub-budgets if throughput is still insufficient.

**Hot-row lock pile-up.** A global `sequence_numbers` table issues invoice numbers with `UPDATE … SET n = n + 1 RETURNING n` inside the large invoice-creation transaction (which also calls a tax API). Lock hold time is ~300 ms, so throughput caps at ~3 invoices/s and requests time out behind the lock. Fix: take the number at the very end of the transaction, move the tax call out of the transaction, or use a real sequence (accepting gaps) if the business allows.

**Duplicate accounts despite a check.** Signup does `SELECT … WHERE email = $1` then INSERT. A double-click creates two accounts roughly 50 times a day. Fix: unique index on `lower(email)`, `ON CONFLICT DO NOTHING`, and a data clean-up migration (which must run *before* the index can be created).

### Metrics to watch

| Metric | Where | Why |
|---|---|---|
| Serialization failures and deadlocks | `pg_stat_database.deadlocks`, app counters by SQLSTATE 40001 / 40P01 | Conflict rate trend |
| Optimistic conflict rate and retries per request | App metrics | Detect contention before it becomes a storm |
| Lock waits on hot rows | `pg_stat_activity` with `wait_event_type = 'Lock'`, `wait_event = 'transactionid'` | Hot-row ceiling approaching |
| Top statements by total time with low rows | `pg_stat_statements` | Hot UPDATEs queueing |
| Unique / exclusion violations | App metrics by SQLSTATE 23505 / 23P01 | Duplicate attempts (good sign the constraint works) |

### Scaling notes

Concurrency patterns scale with *contention*, not with data size. The progression is: atomic statements and constraints first; then shorten lock hold times (move work out of transactions); then remove hot rows (sharding, batching, buckets of stock); and only when a single row's rate truly exceeds what one primary can do, move that state to a system designed for it (an in-memory counter with periodic persistence, or a partitioned log). Sharding the database ([Ch 12](topic.html?p=12-sharding)) does not help a single hot row; it lives on one shard either way.

## 9. Interview Questions

**Q: What is a lost update, and why doesn't wrapping the code in a transaction prevent it?**
A: A lost update happens when two transactions read the same value, each computes a new value in application code, and the second write overwrites the first, so one change disappears. A transaction guarantees atomicity of its writes, but at READ COMMITTED it does not stop another transaction from reading the same value before either writes. The row lock taken by UPDATE does serialise the writes, but the second one writes a value computed from a stale read. You need the check and write to be atomic, a lock before the read, a version compare, or a higher isolation level with retries.

**Q: Why is UPDATE ... SET stock = stock - 1 WHERE id = $1 AND stock > 0 safe at READ COMMITTED in PostgreSQL?**
A: The update takes a row lock, so a concurrent update of the same row waits. When the first transaction commits, PostgreSQL re-evaluates the WHERE clause against the newest committed version and computes `stock - 1` from that version. If stock is now zero, the second update matches no rows. The check and the write happen in one statement on current data, so there is no window to race in, and the application learns the outcome from the affected-row count or `RETURNING`.

**Q: Compare optimistic and pessimistic concurrency control. When do you choose each?**
A: Pessimistic locks the row before reading it with `SELECT … FOR UPDATE`, so conflicting transactions wait; the cost is lock hold time and deadlock risk. Optimistic reads without locking and writes only if a version is unchanged, retrying on conflict; the cost is wasted work on conflicts. Choose optimistic when conflicts are rare or when read and write are separated by user think time or HTTP round trips. Choose pessimistic, or better an atomic conditional update, when conflicts are frequent, because retries under high contention amplify load.

**Q: How do you implement optimistic locking with a version column?**
A: Add an integer `version` column. Read the row with its version, apply changes in the application, then `UPDATE … SET …, version = version + 1 WHERE id = $1 AND version = $2`. If the affected-row count is one, you won; if zero, someone else changed or deleted the row, so re-read and retry or report a conflict. Over HTTP the version maps naturally to an ETag, with `If-Match` on the write and 412 Precondition Failed on conflict.

**Q: What happens in PostgreSQL when two REPEATABLE READ transactions update the same row?**
A: The second waits for the first's row lock. If the first commits, the second cannot apply its update because the newest row version is not in its snapshot, so it fails with "could not serialize access due to concurrent update", SQLSTATE 40001. If the first rolls back, the second proceeds. The application must roll back and retry the entire transaction, including its reads, which is what prevents the lost update.

**Q: Why should uniqueness be enforced with a constraint rather than a check in code?**
A: A check followed by an insert is a race: two requests can both see no existing row and both insert. A unique index enforces the invariant atomically — the second inserter of the same key waits for the first to commit and then fails with 23505, or does nothing with `ON CONFLICT DO NOTHING`. Partial unique indexes and exclusion constraints extend this to "one active row per user" and "no overlapping bookings". A constraint also protects against every other writer, including scripts and future services.

**Q: What errors should a retry loop retry, and what must it be careful about?**
A: Serialization failures (40001), deadlocks (40P01) and application-level version conflicts are safe to retry because the transaction was rolled back. It must retry the whole transaction from its first read, bound the number of attempts, and use exponential backoff with jitter to avoid synchronised retry storms. The retried code must be free of external side effects, since it may run several times. And a connection lost during COMMIT is ambiguous, so non-idempotent operations need an idempotency key.

**Q: How does a hot row limit throughput, and how do you get past it?**
A: Updates to one row serialise because each holds the row lock until commit, so throughput is at most about one divided by the lock hold time. Long transactions around the update, network round trips and commit latency all reduce the ceiling. You raise it by shortening hold time — do the hot update last, move external calls out of the transaction — and ultimately by removing the single row: shard the counter over N rows and sum on read, batch increments in the application, or split a stock quantity into buckets.

**Q: When would you use a PostgreSQL advisory lock, and what are the pitfalls?**
A: For mutual exclusion over something that is not a single row — one invoice run per tenant, one migration at a time, one leader for a cron job. Use `pg_try_advisory_xact_lock` with a key hashed from a name so the lock is released automatically at transaction end. The pitfalls are session-level advisory locks leaking or misbehaving behind a transaction-mode pooler, key collisions from poor hashing, and locks being invisible in the schema, so they need documentation.

**Q: A flash sale oversold 20% of its inventory. Walk me through the root cause and the fix. (Senior)**
A: I would look at the purchase code path for a read-modify-write: stock read into the service, decremented in memory, written back as an absolute value. The row lock serialises the writes but not the decisions, so every request that read before the first commit believed stock existed. The fix is an atomic conditional update — `SET stock = stock - $qty WHERE id = $1 AND stock >= $qty RETURNING stock` — with the order insert in the same transaction, which removes the race without retries. For a very hot SKU I would also shorten the transaction and consider splitting stock into buckets to lift the hot-row ceiling, then reconcile the oversold orders.

**Q: Design the concurrency control for a collaborative document editor's metadata and for a shared team budget. (Senior)**
A: They have opposite contention profiles. Document metadata such as title and settings is edited rarely and with long think time, so optimistic locking with a version column exposed as an ETag is ideal: no locks held, conflicts surfaced as "reload and merge". The team budget is written by many concurrent expense submissions, so optimistic locking would degrade into retry storms; I would use an atomic conditional update on the remaining amount, which queues contention instead of wasting work. If the budget becomes a hot row, I would split it into per-sub-team allocations or pre-reserved chunks.

**Q: How would you implement "at most 5 active API keys per user" without race conditions? (Senior)**
A: It is a cross-row invariant, so a check-then-insert at READ COMMITTED allows two concurrent inserts to both see four keys. Options: materialise the conflict by locking the user row with `SELECT … FOR UPDATE` before counting and inserting, so key creation for one user serialises; or maintain an `active_key_count` column on the user with an atomic conditional update `WHERE active_key_count < 5` in the same transaction as the insert; or run the transaction at SERIALIZABLE with a retry loop. I would choose the counter column or the parent-row lock because contention is per user and low, and add a `CHECK (active_key_count <= 5)` as a backstop.

**Q: Your service retries on 40001, but you see duplicate charges after database failovers. Why, and how do you fix it? (Senior)**
A: A retry loop is safe only when the transaction definitely rolled back. During a failover the connection can drop after COMMIT was sent, so the client cannot know whether it committed; if the code treats that as retryable, it re-runs a transaction that already succeeded. Separately, any external call inside the retried function runs once per attempt. The fix is an idempotency key per logical operation stored under a unique constraint in the same transaction, so a replay either finds the existing record or fails harmlessly, and moving external side effects to after commit via an outbox.

## 10. Quick Revision & Cheat Sheet

| Situation | Pattern | SQL shape |
|---|---|---|
| Decrement if available | Atomic conditional UPDATE | `UPDATE t SET x = x - $n WHERE id = $1 AND x >= $n RETURNING x` |
| Complex logic between read and write | Pessimistic | `SELECT … FOR UPDATE` → logic → `UPDATE` |
| Edit across HTTP / think time | Optimistic (CAS) | `UPDATE … SET v = v + 1 WHERE id = $1 AND v = $2` → 0 rows = conflict |
| Multi-row txn must not lose updates | RR + retry | 40001 → rerun txn |
| Cross-row invariant | SERIALIZABLE + retry, or lock a parent row | 40001 → rerun txn |
| Must be unique / must not overlap | Constraint | `UNIQUE`, partial unique, `EXCLUDE USING gist` |
| Workers claim jobs | Skip locked | `FOR UPDATE SKIP LOCKED` |
| One-at-a-time job per key | Advisory lock | `pg_try_advisory_xact_lock(hash)` |
| Very hot counter | Shard / batch | N rows + `SUM` on read |

**Remember this**
- Transactions give atomicity, not mutual exclusion.
- Locks protect writes; stale *decisions* made in app code are still wrong.
- Default to a single conditional UPDATE; check the affected-row count.
- Optimistic for rare conflicts and long think time; pessimistic or atomic for hot rows.
- Retry the whole transaction, with jitter, and no side effects inside.
- Uniqueness and overlap rules belong in constraints.
- One row ≈ at most 1 / (lock hold time) writes per second.

## 11. Hands-On Exercises

Lab: `docker run -d --name pg -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:17`.

1. **Reproduce the lost update.** Run the two-session transcript from §5 exactly. Then repeat with Fix 1 through Fix 4 and record, for each, what session 2 sees.
2. **Race under load.** Write a script (Go, Python or `pgbench -f` with a custom file) that runs 50 concurrent "buy" transactions against `stock = 10` using the read-then-write bug. Count orders created. Then switch to the atomic UPDATE and confirm exactly 10.
3. **Optimistic retry rate.** Use the Go `UpdateListing` loop with 2, 10 and 100 concurrent editors of the same listing; chart attempts per successful update. Compare to `SELECT … FOR UPDATE` latency at the same concurrency.
4. **Constraint enforcement.** Create the `no_overlap` exclusion constraint and fire 20 concurrent overlapping bookings; confirm one succeeds and the rest fail with 23P01.
5. **Hot row ceiling.** With `pgbench -c 32 -T 30` run a script that increments one counter row, then a 16-shard counter. Compare TPS and `pg_stat_activity` lock waits.

### Mini project — "Inventory service that cannot oversell"

Build a small HTTP service (Go or Python) with `POST /reserve {sku, qty, idempotency_key}` and `POST /release`. Requirements: never oversell under 500 concurrent requests; exactly-once effect per idempotency key even when the client retries after a timeout; a 10,000-reservations/min load test with zero invariant violations (verify with a SQL audit query summing reservations vs initial stock); and metrics for conflicts, retries and lock waits. Extension: support a single hot SKU at 5,000 reservations/s by splitting its stock into 32 buckets and picking a random bucket with remaining stock.

## 12. Related Topics & Free Learning Resources

**In this handbook:** [Ch 03 · MVCC](topic.html?p=03-mvcc) · [Ch 05 · Locking Internals](topic.html?p=05-locking-internals) (what `FOR UPDATE` and waits really do) · [Ch 06 · Isolation Deep Dive](topic.html?p=06-isolation-deep-dive) (write skew and SSI) · [Ch 13 · Distributed Transactions](topic.html?p=13-distributed-transactions) · [Ch 20 · Database + Application](topic.html?p=20-database-application-architecture) · [Ch 31 · Case Study: E-commerce](topic.html?p=31-case-ecommerce) · [Ch 33 · Case Study: Ticket Booking](topic.html?p=33-case-ticket-booking).

**SQL Handbook:** [Transactions & ACID](../sql/topic.html?p=25-transactions-acid) · [Isolation Levels](../sql/topic.html?p=26-isolation-levels) · [Locking, MVCC & Deadlocks](../sql/topic.html?p=27-locking-mvcc) · [Keys & Constraints](../sql/topic.html?p=29-keys-constraints).

**Other handbooks:** [System Design · Idempotency](../system-design/topic.html?p=22-idempotency) · [Caching with Redis · Distributed Locks & Redlock](../redis-caching/topic.html?p=23-distributed-locks-redlock) · [Kafka & RabbitMQ · Idempotency & Outbox](../messaging/topic.html?p=21-idempotency-outbox).

- **PostgreSQL docs — Transaction Isolation (READ COMMITTED update behaviour)** — PostgreSQL · *Intermediate* · the precise rules for what a concurrent UPDATE sees and when 40001 is raised. <https://www.postgresql.org/docs/current/transaction-iso.html>
- **PostgreSQL docs — Explicit Locking (row locks, advisory locks)** — PostgreSQL · *Intermediate* · `FOR UPDATE` variants and advisory lock functions. <https://www.postgresql.org/docs/current/explicit-locking.html>
- **Optimistic Offline Lock** — Martin Fowler (P of EAA) · *Beginner* · the classic description of version-based optimistic locking across user sessions. <https://martinfowler.com/eaaCatalog/optimisticOfflineLock.html>
- **Hermitage: testing transaction isolation levels** — Martin Kleppmann · *Advanced* · runnable test cases showing lost updates and other anomalies per database. <https://github.com/ept/hermitage>
- **Designing Data-Intensive Applications, ch. 7** — Martin Kleppmann · *Intermediate* · lost updates, atomic writes, explicit locking and compare-and-set in one chapter. <https://dataintensive.net/>
- **PostgreSQL docs — INSERT … ON CONFLICT** — PostgreSQL · *Beginner* · upsert semantics that make uniqueness races safe. <https://www.postgresql.org/docs/current/sql-insert.html>

---

*Database Design Handbook — chapter 04.*
