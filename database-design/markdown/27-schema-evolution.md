# 27 · Schema Evolution at Scale: Zero-Downtime Migrations

> **In one line:** On a live system the schema and the code are never deployed at the same instant, so every change must be split into steps that are each backward compatible and each take only brief, bounded locks — expand, migrate, contract — with the dangerous step postponed until nothing depends on the old shape.

---

## 1. Overview

> **Builds on:** [SQL Handbook · Schema Design & Data Modeling](../sql/topic.html?p=30-schema-design) (what the schema *should* be) · [SQL Handbook · Keys, Constraints & Referential Integrity](../sql/topic.html?p=29-keys-constraints) (constraints, `NOT VALID`/`VALIDATE`) · [Ch 05 · Locking Internals](topic.html?p=05-locking-internals) (table lock modes and the lock queue) · [Ch 09 · Database Replication](topic.html?p=09-replication) (replica lag). Those chapters design a good schema; this one is about *changing* a schema that 20,000 requests per second are using right now.

The SQL Handbook teaches you how to model a domain. Production teaches you that the model is never finished. Columns get added weekly, types turn out to be too small, a `status` string becomes a foreign key to a table, a 2-billion-row table needs a new index, and the column called `name` must become `first_name` and `last_name`. Each change is a few lines of DDL. On an empty development database, each runs in milliseconds. On production, the same lines can take the site down.

The problem exists for two reasons that compound.

**First, DDL needs locks, and locks queue.** Most `ALTER TABLE` forms take an `ACCESS EXCLUSIVE` lock, which conflicts with everything including plain `SELECT`. Even if the change itself is instant, it must *wait* for every transaction currently touching the table — and while it waits at the head of the lock queue, every new query on that table waits behind it. One long-running analytics query plus one "instant" `ALTER` equals a full outage of every endpoint that touches that table. Some changes are worse: they rewrite the entire table or scan it while holding the lock, turning seconds into hours.

**Second, code and schema cannot change atomically.** A rolling deploy runs old and new application versions side by side for minutes. Canary deploys keep them side by side for hours. A rollback puts old code back on a new schema. If the migration renames a column, the old version breaks the moment it runs; if the new code ships first, it breaks because the column does not exist yet. There is no ordering of "migrate, then deploy" that is safe for a breaking change.

The naive approach — "run the migration in the deploy pipeline, then roll out the code" — works right up to the day a table is big or busy enough. The discipline that replaces it is **expand/contract** (also called parallel change): first *expand* the schema so it supports both old and new code, then migrate data and code in small reversible steps, and only at the end *contract* by removing the old shape, once nothing uses it. Each step uses DDL forms chosen specifically because their locks are brief, with `lock_timeout` so that a step that cannot get its lock quickly gives up instead of stalling traffic.

> **Why this matters:** "Zero downtime migration" is one of the most common senior interview topics because it touches locks, MVCC, replication lag, deploy strategy and rollback at once. It is also one of the most common causes of self-inflicted outages.

## 2. Core Concepts

- **Expand/contract (parallel change)** — split a breaking change into additive steps, a transition period where both shapes coexist, and a final removal. *Why it matters:* every intermediate state is valid for every app version that can be running.
- **Backward-compatible migration** — a schema change that the *currently deployed* code keeps working against. *Why it matters:* migrations run before the new code is fully rolled out, and code can be rolled back after.
- **Forward-compatible code** — code that works with both the old and the new schema. *Why it matters:* lets you deploy code before or after the migration without coordination.
- **Metadata-only change** — DDL that updates the catalog without touching rows (e.g. PG 11+ `ADD COLUMN ... DEFAULT <constant>`, `DROP COLUMN`). *Why it matters:* it still takes `ACCESS EXCLUSIVE` but holds it for milliseconds.
- **Table rewrite** — DDL that creates a new copy of the table and every index (most type changes, volatile defaults, `VACUUM FULL`). *Why it matters:* takes time proportional to table size while holding `ACCESS EXCLUSIVE` — seconds of downtime per GB.
- **Lock queue / convoy** — waiting lock requests are granted in order; a waiting `ACCESS EXCLUSIVE` blocks every later request. *Why it matters:* an instant DDL can cause an outage just by waiting.
- **`lock_timeout`** — maximum time a statement waits to acquire a lock before erroring. *Why it matters:* converts "outage while waiting" into "migration failed, retry later".
- **`NOT VALID` / `VALIDATE CONSTRAINT`** — add a CHECK or FK that is enforced for new writes immediately, and validate existing rows later under a weaker lock. *Why it matters:* avoids a full scan under a strong lock.
- **`CREATE INDEX CONCURRENTLY`** — builds an index without blocking writes. *Why it matters:* a plain `CREATE INDEX` blocks all writes for the duration of the build.
- **Backfill** — populating a new column or table from existing data in small batches. *Why it matters:* one giant `UPDATE` holds row locks for its whole duration, generates huge WAL and replica lag, and bloats the table.
- **Dual write** — application (or trigger) writes both old and new locations during a transition. *Why it matters:* keeps both shapes current so reads can switch over and back.
- **Online schema change tool** — gh-ost, pt-online-schema-change (MySQL), pgroll, pg-osc (PostgreSQL): build a shadow table, sync changes, swap. *Why it matters:* the answer when the engine cannot do a change online.

## 3. Theory & Principles

### The lock queue is the whole story

PostgreSQL has eight table lock modes ([Ch 05](topic.html?p=05-locking-internals)). The ones that matter here:

| DDL | Lock taken | Blocks reads? | Blocks writes? | Duration |
|---|---|---|---|---|
| `ADD COLUMN` (no default, or constant default PG 11+) | ACCESS EXCLUSIVE | yes | yes | milliseconds (catalog only) |
| `ADD COLUMN ... DEFAULT gen_random_uuid()` (volatile) | ACCESS EXCLUSIVE | yes | yes | full rewrite |
| `ALTER COLUMN TYPE int → bigint` | ACCESS EXCLUSIVE | yes | yes | full rewrite + all indexes rebuilt |
| `ALTER COLUMN TYPE varchar(50) → varchar(100)` or `→ text` | ACCESS EXCLUSIVE | yes | yes | catalog only (binary-coercible) |
| `ALTER COLUMN SET NOT NULL` | ACCESS EXCLUSIVE | yes | yes | full scan, unless a validated `CHECK (col IS NOT NULL)` exists (PG 12+) |
| `ADD CONSTRAINT ... CHECK` / `FOREIGN KEY` (validated) | ACCESS EXCLUSIVE / SHARE ROW EXCLUSIVE | CHECK: yes; FK: no | yes | full scan |
| `ADD CONSTRAINT ... NOT VALID` | same as above | — | — | milliseconds |
| `VALIDATE CONSTRAINT` | SHARE UPDATE EXCLUSIVE | no | no | full scan, but non-blocking |
| `CREATE INDEX` | SHARE | no | **yes** | full build |
| `CREATE INDEX CONCURRENTLY` | SHARE UPDATE EXCLUSIVE | no | no | ~2 scans + waits for old txns |
| `DROP COLUMN`, `RENAME COLUMN` | ACCESS EXCLUSIVE | yes | yes | milliseconds |

"Milliseconds" is the *hold* time. The *wait* time is whatever it takes for every conflicting transaction already on the table to finish. `ACCESS EXCLUSIVE` conflicts with the `ACCESS SHARE` that every `SELECT` holds until its transaction ends. So if a reporting query started 20 minutes ago and is still running, your one-millisecond `ADD COLUMN` waits 20 minutes, and — because lock requests are queued in order — every `SELECT`, `INSERT` and `UPDATE` that arrives after it waits too. Connection pools fill, requests time out, the health checks fail. This is the most common "the migration took the site down" incident, and it happens with the *cheapest* DDL.

```svg
<svg viewBox="0 0 880 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c27a1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
    <marker id="c27a2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">An "instant" ALTER TABLE behind a long query: the lock-queue convoy</text>
  <rect x="20" y="36" width="840" height="190" rx="10" fill="#fef2f2" stroke="#dc2626"/>
  <text x="440" y="56" text-anchor="middle" fill="#991b1b" font-weight="bold">Without lock_timeout</text>
  <text x="40" y="84" fill="#334155" font-weight="bold">granted</text>
  <rect x="110" y="70" width="700" height="22" rx="4" fill="#dbeafe" stroke="#2563eb"/>
  <text x="120" y="85" fill="#1e293b">T1: SELECT ... report (ACCESS SHARE) running for 20 min</text>
  <text x="40" y="120" fill="#334155" font-weight="bold">waiting</text>
  <rect x="110" y="106" width="200" height="22" rx="4" fill="#fee2e2" stroke="#dc2626"/>
  <text x="120" y="121" fill="#7f1d1d">T2: ALTER TABLE (ACCESS EXCLUSIVE)</text>
  <rect x="320" y="106" width="110" height="22" rx="4" fill="#fef3c7" stroke="#d97706"/>
  <text x="330" y="121" fill="#78350f">T3: SELECT</text>
  <rect x="440" y="106" width="110" height="22" rx="4" fill="#fef3c7" stroke="#d97706"/>
  <text x="450" y="121" fill="#78350f">T4: INSERT</text>
  <rect x="560" y="106" width="110" height="22" rx="4" fill="#fef3c7" stroke="#d97706"/>
  <text x="570" y="121" fill="#78350f">T5: SELECT</text>
  <rect x="680" y="106" width="130" height="22" rx="4" fill="#fef3c7" stroke="#d97706"/>
  <text x="690" y="121" fill="#78350f">T6..T900 ...</text>
  <path d="M320,140 L210,140" stroke="#dc2626" stroke-width="2" marker-end="url(#c27a1)"/>
  <text x="330" y="150" fill="#991b1b">T3+ conflict with T2's WAITING request, so they queue behind it</text>
  <text x="40" y="180" fill="#991b1b">Symptom: pool exhausted, p99 = timeout, pg_stat_activity full of wait_event_type = Lock</text>
  <text x="40" y="200" fill="#991b1b">on relation; pg_blocking_pids(T3) = {T2}, pg_blocking_pids(T2) = {T1}. The ALTER itself never ran.</text>
  <rect x="20" y="240" width="840" height="166" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="440" y="260" text-anchor="middle" fill="#166534" font-weight="bold">With SET lock_timeout = '2s' and retry with backoff</text>
  <rect x="110" y="276" width="700" height="22" rx="4" fill="#dbeafe" stroke="#2563eb"/>
  <text x="120" y="291" fill="#1e293b">T1: SELECT ... report still running</text>
  <rect x="110" y="310" width="200" height="22" rx="4" fill="#fee2e2" stroke="#dc2626"/>
  <text x="120" y="325" fill="#7f1d1d">T2 waits 2 s, then ERROR 55P03</text>
  <path d="M312,321 L360,321" stroke="#16a34a" stroke-width="2" marker-end="url(#c27a2)"/>
  <text x="370" y="325" fill="#166534">queue drains: T3..T900 proceed, at most 2 s of extra latency</text>
  <rect x="110" y="344" width="330" height="22" rx="4" fill="#dcfce7" stroke="#16a34a"/>
  <text x="120" y="359" fill="#14532d">retry after 10 s, 20 s, 40 s ... until T1 is gone</text>
  <rect x="450" y="344" width="360" height="22" rx="4" fill="#dcfce7" stroke="#16a34a"/>
  <text x="460" y="359" fill="#14532d">T2 acquires, holds a few ms, commits</text>
  <text x="40" y="392" fill="#166534" font-weight="bold">Rule: every migration statement that needs a strong lock runs with lock_timeout and a retry loop.</text>
</svg>
```

### Why rewrites happen and how to avoid them

PostgreSQL rewrites a table when the on-disk representation of existing rows must change. Changing `int` (4 bytes) to `bigint` (8 bytes) changes every tuple, so the whole heap is copied and every index rebuilt, under `ACCESS EXCLUSIVE`. By contrast, PG 11+ stores a constant default for a newly added column in the catalog (`pg_attribute.attmissingval`) and returns it for old rows that physically lack the column, so `ADD COLUMN status text NOT NULL DEFAULT 'active'` is instant even on a billion rows. A *volatile* default (`clock_timestamp()`, `gen_random_uuid()`, `random()`) must produce a different value per row, so it forces a rewrite. `now()` is stable within a transaction, so it is evaluated once and stays metadata-only.

When a change *does* require new physical data (a type change, a split column), the zero-downtime technique is always the same: **do not alter in place; build the new shape alongside the old and migrate data into it incrementally.**

### Backward compatibility across a rolling deploy

At any moment during a rollout, the set of code versions that can hit the database is {previous, current} — and after a rollback, {current, previous} again. So the rule is: **every schema state must work with every code version that can run against it.** That gives the classic ordering:

- **Additive schema changes go before code that uses them.** Add the column, then deploy code that writes it. Old code ignores the new column (so never use `SELECT *` with positional mapping or `INSERT` without a column list).
- **Destructive schema changes go after code stops using them.** Deploy code that no longer reads the column, then deploy code that no longer writes it, then drop it.
- **A rename is an add plus a drop**, so it needs the full expand/contract sequence.

### Constraint validation without long locks

Adding `NOT NULL` or a `CHECK` to an existing big table naively scans every row under `ACCESS EXCLUSIVE`. The two-phase form separates *enforcement for new writes* from *verification of old rows*. `ADD CONSTRAINT ... NOT VALID` records the constraint and enforces it on every future insert/update — a catalog change, milliseconds. `VALIDATE CONSTRAINT` then scans existing rows while holding only `SHARE UPDATE EXCLUSIVE`, which permits reads and writes. For `NOT NULL`, since PG 12 `SET NOT NULL` skips its scan if a validated `CHECK (col IS NOT NULL)` already proves it, so you add the check `NOT VALID`, validate it, set NOT NULL instantly, and drop the redundant check. Foreign keys work the same way (see the SQL Handbook's keys chapter for the basic `NOT VALID` syntax).

## 4. Architecture & Workflow

### Expand/contract for a column rename (`name` → `full_name`)

```svg
<svg viewBox="0 0 880 440" width="100%" height="440" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c27b1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Expand / migrate / contract: every step is compatible with the code that can run beside it</text>
  <line x1="30" y1="60" x2="850" y2="60" stroke="#334155" stroke-width="2" marker-end="url(#c27b1)"/>
  <text x="840" y="52" text-anchor="end" fill="#334155">time (days to weeks)</text>
  <rect x="30" y="74" width="150" height="130" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="105" y="94" text-anchor="middle" fill="#1e40af" font-weight="bold">1. EXPAND</text>
  <text x="40" y="114" fill="#1e293b">ADD COLUMN full_name</text>
  <text x="40" y="130" fill="#1e293b">(nullable, no rewrite)</text>
  <text x="40" y="150" fill="#334155">code v1: reads/writes name</text>
  <text x="40" y="168" fill="#16a34a">v1 unaffected</text>
  <text x="40" y="190" fill="#1e293b" font-size="10">rollback: drop column</text>
  <rect x="192" y="74" width="150" height="130" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="267" y="94" text-anchor="middle" fill="#5b21b6" font-weight="bold">2. DUAL WRITE</text>
  <text x="202" y="114" fill="#1e293b">deploy v2: writes BOTH,</text>
  <text x="202" y="130" fill="#1e293b">still reads name</text>
  <text x="202" y="150" fill="#334155">(or a sync trigger)</text>
  <text x="202" y="168" fill="#16a34a">v1 + v2 coexist fine</text>
  <text x="202" y="190" fill="#1e293b" font-size="10">rollback: redeploy v1</text>
  <rect x="354" y="74" width="150" height="130" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="429" y="94" text-anchor="middle" fill="#92400e" font-weight="bold">3. BACKFILL</text>
  <text x="364" y="114" fill="#1e293b">batches of 5k rows:</text>
  <text x="364" y="130" fill="#1e293b">full_name = name</text>
  <text x="364" y="150" fill="#334155">throttle on replica lag</text>
  <text x="364" y="168" fill="#16a34a">verify: 0 mismatches</text>
  <text x="364" y="190" fill="#1e293b" font-size="10">rollback: nothing to undo</text>
  <rect x="516" y="74" width="150" height="130" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="591" y="94" text-anchor="middle" fill="#166534" font-weight="bold">4. SWITCH READS</text>
  <text x="526" y="114" fill="#1e293b">deploy v3: reads</text>
  <text x="526" y="130" fill="#1e293b">full_name, writes both</text>
  <text x="526" y="150" fill="#334155">(feature flag, % rollout)</text>
  <text x="526" y="168" fill="#16a34a">v2 + v3 coexist fine</text>
  <text x="526" y="190" fill="#1e293b" font-size="10">rollback: flag off</text>
  <rect x="678" y="74" width="172" height="130" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="764" y="94" text-anchor="middle" fill="#991b1b" font-weight="bold">5. CONTRACT</text>
  <text x="688" y="114" fill="#1e293b">deploy v4: stop writing name</text>
  <text x="688" y="130" fill="#1e293b">wait (bake period)</text>
  <text x="688" y="150" fill="#1e293b">then DROP COLUMN name</text>
  <text x="688" y="168" fill="#dc2626">irreversible step</text>
  <text x="688" y="190" fill="#1e293b" font-size="10">backup first; last step</text>
  <rect x="30" y="226" width="820" height="200" rx="10" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="440" y="248" text-anchor="middle" fill="#1e293b" font-weight="bold">Which code versions can be live against which schema state</text>
  <text x="50" y="274" fill="#334155" font-weight="bold">schema state</text>
  <text x="250" y="274" fill="#334155" font-weight="bold">code that may run</text>
  <text x="520" y="274" fill="#334155" font-weight="bold">why it is safe</text>
  <text x="50" y="298" fill="#1e293b">name + full_name (empty)</text>
  <text x="250" y="298" fill="#1e293b">v1, v2</text>
  <text x="520" y="298" fill="#1e293b">v1 ignores the new column</text>
  <text x="50" y="322" fill="#1e293b">name + full_name (partial)</text>
  <text x="250" y="322" fill="#1e293b">v1 (rollback), v2</text>
  <text x="520" y="322" fill="#1e293b">v1 writes would leave full_name stale: use a trigger</text>
  <text x="50" y="346" fill="#1e293b">name + full_name (complete)</text>
  <text x="250" y="346" fill="#1e293b">v2, v3</text>
  <text x="520" y="346" fill="#1e293b">both columns always equal</text>
  <text x="50" y="370" fill="#1e293b">full_name only</text>
  <text x="250" y="370" fill="#1e293b">v4 only</text>
  <text x="520" y="370" fill="#1e293b">no version that reads name can exist anymore</text>
  <text x="50" y="402" fill="#dc2626" font-weight="bold">The one-step RENAME COLUMN breaks v1 instantly: whichever of schema or code goes first, the other is wrong.</text>
</svg>
```

Notice the subtle point in the second row: if you roll back to v1 while full_name is partially backfilled, v1 writes only `name`, and rows it updates now disagree. That is why many teams implement the dual write as a **database trigger** during the transition instead of in application code — the trigger keeps the columns in sync regardless of which code version wrote. The trigger is removed in the contract step.

### Removing a column safely

Dropping a column is metadata-only in PostgreSQL (the column is marked dropped and its space is reclaimed as rows are rewritten), so the lock is brief. The danger is entirely in the application: ORMs cache the column list at boot and generate `INSERT`/`SELECT` naming it. Drop it while any process still has the old list and every insert fails with `column "x" does not exist`. The sequence is:

1. **Stop reading**: deploy code that no longer selects the column (Rails: `self.ignored_columns`; other ORMs: remove the field and ensure no `SELECT *` mapping).
2. **Stop writing**: if the column is `NOT NULL` without a default, first `ALTER COLUMN DROP NOT NULL` (or add a default) so code that omits it can still insert.
3. **Bake**: wait until every running process, cron job and worker is on the new code. Check `pg_stat_statements` for any query still mentioning the column.
4. **Drop** with `lock_timeout`. Take (or confirm) a backup first: this is the only irreversible step.

### Changing a type on a hot table (int → bigint primary key)

The classic emergency: `orders.id` is `integer` and is approaching 2,147,483,647. `ALTER COLUMN id TYPE bigint` rewrites the table and every index under `ACCESS EXCLUSIVE` — hours on a large table. The online path:

```text
1. ADD COLUMN id_new bigint;                                       -- instant
2. trigger: NEW.id_new := NEW.id on INSERT/UPDATE                  -- new rows covered
3. backfill id_new = id in batches (throttled)                     -- old rows covered
4. CREATE UNIQUE INDEX CONCURRENTLY orders_id_new_uq ON orders(id_new);
5. ADD CONSTRAINT id_new_nn CHECK (id_new IS NOT NULL) NOT VALID; VALIDATE ...;
6. one short transaction with lock_timeout:
     LOCK TABLE orders IN ACCESS EXCLUSIVE MODE;
     ALTER TABLE orders DROP CONSTRAINT orders_pkey;
     ALTER TABLE orders ALTER COLUMN id_new SET NOT NULL;           -- no scan: check exists
     ALTER TABLE orders ALTER COLUMN id DROP DEFAULT, ALTER COLUMN id DROP NOT NULL;
     ALTER TABLE orders RENAME COLUMN id TO id_old;
     ALTER TABLE orders RENAME COLUMN id_new TO id;
     ALTER TABLE orders ADD CONSTRAINT orders_pkey PRIMARY KEY USING INDEX orders_id_new_uq;
     ALTER SEQUENCE orders_id_seq OWNED BY orders.id;
     ALTER TABLE orders ALTER COLUMN id SET DEFAULT nextval('orders_id_seq');
     drop the sync trigger;
   COMMIT;
7. later: repeat for every FK column referencing orders.id, then drop id_old.
```

Step 7 is where the real work hides: every referencing table's FK column must also become `bigint`, each via the same dance, and foreign keys must be recreated with `NOT VALID` + `VALIDATE`. Budget weeks, not hours — and alert on sequence usage long before you are at 90%.

## 5. Implementation

### Simple example: adding a required column to a 500 M-row table

```sql
-- Every migration session starts with guardrails
SET lock_timeout = '2s';          -- give up quickly instead of convoying
SET statement_timeout = '15min';  -- no statement runs forever by accident

-- 1. Metadata-only: constant default on PG 11+
ALTER TABLE accounts ADD COLUMN plan text DEFAULT 'free';

-- 2. NOT NULL without a scan under ACCESS EXCLUSIVE
ALTER TABLE accounts ADD CONSTRAINT accounts_plan_nn CHECK (plan IS NOT NULL) NOT VALID;
ALTER TABLE accounts VALIDATE CONSTRAINT accounts_plan_nn;   -- SHARE UPDATE EXCLUSIVE, online
ALTER TABLE accounts ALTER COLUMN plan SET NOT NULL;         -- instant: proven by the check
ALTER TABLE accounts DROP CONSTRAINT accounts_plan_nn;

-- 3. Index without blocking writes (must NOT be inside a transaction block)
CREATE INDEX CONCURRENTLY IF NOT EXISTS accounts_plan_idx ON accounts (plan);

-- 4. Foreign key without a long lock on either table
ALTER TABLE accounts ADD CONSTRAINT accounts_plan_fk
  FOREIGN KEY (plan) REFERENCES plans (code) NOT VALID;
ALTER TABLE accounts VALIDATE CONSTRAINT accounts_plan_fk;
```

`CREATE INDEX CONCURRENTLY` has sharp edges. It cannot run inside a transaction block — and most migration frameworks wrap each migration in one, so you must opt out (Rails `disable_ddl_transaction!`, Django `atomic = False`, Flyway's non-transactional mode for that script). It waits for all transactions that could see the table to finish, so a long-running transaction anywhere delays it. And if it fails (deadlock, unique violation, cancel), it leaves an **INVALID** index that is maintained on every write but never used:

```sql
SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
WHERE NOT i.indisvalid;
-- accounts_plan_idx
DROP INDEX CONCURRENTLY accounts_plan_idx;   -- then retry the build
```

Watch progress for big builds with `pg_stat_progress_create_index` (phase, blocks done/total).

### Real-world example: a throttled backfill with replica-lag checks

The backfill is where teams hurt themselves: one `UPDATE orders SET full_name = name` on 400 M rows runs for hours as one transaction, holds row locks on everything, writes a new version of every row (doubling the table until vacuum), produces hundreds of GB of WAL at once, and puts every replica minutes behind. The correct shape is small batches, each its own transaction, keyed by the primary key, paced by feedback from the system:

```python
import time, psycopg

BATCH = 5_000
MAX_LAG_S = 5.0

def replica_lag_seconds(conn):
    row = conn.execute("""
        SELECT coalesce(max(extract(epoch FROM replay_lag)), 0)
        FROM pg_stat_replication""").fetchone()
    return float(row[0])

def backfill(dsn):
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute("SET lock_timeout = '1s'")
        conn.execute("SET statement_timeout = '30s'")
        last_id, = conn.execute("SELECT coalesce(min(id), 0) - 1 FROM orders").fetchone()
        max_id,  = conn.execute("SELECT max(id) FROM orders").fetchone()
        while last_id < max_id:
            t0 = time.time()
            # keyset batch on the PK: index range scan, no OFFSET, idempotent (IS DISTINCT FROM)
            cur = conn.execute("""
                UPDATE orders SET full_name = name
                WHERE id > %s AND id <= %s
                  AND full_name IS DISTINCT FROM name""", (last_id, last_id + BATCH))
            last_id += BATCH
            took = time.time() - t0
            # feedback 1: replica lag
            while (lag := replica_lag_seconds(conn)) > MAX_LAG_S:
                print(f"replica lag {lag:.1f}s, pausing"); time.sleep(5)
            # feedback 2: keep the DB mostly idle for this job (duty cycle ~50%)
            time.sleep(max(took, 0.05))
            save_checkpoint(last_id)          # your own table/file: resumable after crash/deploy
```

Design choices worth defending in a review:

- **Range by primary key, not `OFFSET` or `WHERE full_name IS NULL LIMIT n`.** A PK range is an index range scan with predictable cost; `IS NULL LIMIT` re-scans the already-done prefix every batch and gets slower as it goes.
- **Each batch commits.** Short transactions release row locks quickly and do not hold back the vacuum xmin horizon ([Ch 03 · MVCC](topic.html?p=03-mvcc)), so autovacuum can reclaim the dead versions the backfill creates.
- **Idempotent predicate and a checkpoint.** The job can crash, be killed by a deploy, or be run twice without harm.
- **Throttle on the replicas, not just the primary.** Replicas apply WAL with a single startup process; a primary that is fine at 30% CPU can still push replicas minutes behind, and read-your-writes on replicas breaks for users.
- **Verify, then flip.** After the job: `SELECT count(*) FROM orders WHERE full_name IS DISTINCT FROM name` must be 0 (run on a replica, in chunks if needed) before step 4.

### Retrying DDL under `lock_timeout`

```python
import random, time, psycopg

def run_ddl_with_retry(conn, sql, attempts=20):
    for i in range(attempts):
        try:
            conn.execute("SET lock_timeout = '2s'")
            conn.execute(sql)
            return
        except psycopg.errors.LockNotAvailable:        # SQLSTATE 55P03
            time.sleep(min(60, 2 ** i) + random.random())
    raise RuntimeError(f"could not acquire lock for: {sql}")
```

Pair this with a pre-check that aborts if any transaction on the table is older than a threshold (`SELECT ... FROM pg_stat_activity WHERE xact_start < now() - interval '1 minute'`), and with a linter in CI — **squawk** for PostgreSQL SQL migrations, or `strong_migrations` for Rails — that rejects unsafe forms (`ADD COLUMN ... DEFAULT volatile`, non-concurrent index, validated FK add, `SET NOT NULL` without a check) before they reach production.

### Tooling

- **Migration frameworks** (Flyway, Liquibase, Alembic, Rails, Django, Atlas, sqitch) give ordering, versioning and history. They do *not* make DDL safe; they happily run a blocking `ALTER` for you.
- **pgroll** (PostgreSQL) implements expand/contract for you: `pgroll start` creates the new columns plus a versioned schema of **views** exposing the new shape, with triggers keeping old and new columns in sync, so v1 (using the old schema via `search_path`) and v2 run simultaneously; `pgroll complete` contracts, `pgroll rollback` removes the expansion.
- **pg-osc / pg_repack** rebuild tables online via a shadow table and triggers, useful for changes PostgreSQL cannot do online.
- **Declarative partitioning** turns some changes into `ATTACH PARTITION` (which since PG 12 takes only `SHARE UPDATE EXCLUSIVE` on the parent) instead of a table-wide rewrite.

> **MySQL difference:** InnoDB online DDL has three algorithms. `ALGORITHM=INSTANT` changes only metadata: adding a column (8.0.12+ at the end, 8.0.29+ at any position), dropping a column (8.0.29+), setting a default, and a few others; a table can accumulate only a limited number of instant row-format versions before a rebuild is required. `ALGORITHM=INPLACE, LOCK=NONE` rebuilds or modifies in place while allowing concurrent DML (adding a secondary index, many column changes), logging concurrent changes and applying them at the end. `ALGORITHM=COPY` blocks writes and copies the table. Specify the algorithm explicitly so MySQL errors instead of silently falling back to COPY. Two production traps: every DDL briefly needs an exclusive **metadata lock**, and a waiting MDL request blocks later queries exactly like PostgreSQL's lock queue (`Waiting for table metadata lock` in the processlist; use `lock_wait_timeout`). And on classic async replication a 3-hour in-place ALTER runs on each replica *after* it finishes on the primary, typically blocking the SQL applier and putting replicas hours behind. That is why large MySQL shops use **gh-ost** (triggerless: copies rows in chunks into a ghost table while tailing the binlog for concurrent changes, throttles on replica lag, and does an atomic rename cut-over you can postpone) or **pt-online-schema-change** (trigger-based copy and atomic `RENAME TABLE`).

## 6. Advantages, Disadvantages & Trade-offs

| Approach | Downtime | Duration | Complexity | Reversible | Best for |
|---|---|---|---|---|---|
| Plain `ALTER` in deploy | lock wait + hold (maybe hours) | shortest | lowest | often not | small tables, off-hours, internal tools |
| Lock-safe DDL forms + `lock_timeout` | ~0 | short | low | yes | additive changes, indexes, constraints |
| Expand/contract with app dual-write | 0 | days–weeks | high | yes until contract | renames, splits, type changes, table moves |
| Trigger-based sync (pgroll, custom) | 0 | days | medium | yes | when old and new code overlap for a long time |
| Shadow-table tools (gh-ost, pt-osc, pg-osc) | ~0 (brief cut-over) | hours | medium | before cut-over | engine cannot do it online; MySQL at scale |
| Maintenance window | planned | shortest | lowest | backup restore | when the business allows it |

### When to use expand/contract

- Any change that removes or renames something that deployed code references.
- Any change that must rewrite data on a table big enough that a rewrite exceeds your tolerated lock time (for many OLTP systems, anything over a few GB).
- Moving data between tables or databases (splitting a service out), where "dual write, backfill, switch reads, stop old writes" is the same pattern at larger scale.

### When NOT to

- Tiny tables (thousands of rows) where the whole rewrite takes milliseconds — just use `lock_timeout` and do it directly.
- Purely additive changes that are already metadata-only; the ceremony adds risk without benefit.
- Systems with an agreed maintenance window and no deploy overlap (some internal and batch systems). Downtime is a legitimate engineering choice when it is cheaper than weeks of transition.
- Never use it as an excuse to leave transitions half-finished: a column that has been "being migrated" for a year, with dual writes and two sources of truth, is its own incident waiting to happen.

## 7. Common Mistakes & Best Practices

- **Running DDL without `lock_timeout`.** What people do: trust that "ADD COLUMN is instant". Why it hurts: the wait, not the hold, causes the outage. Instead: set `lock_timeout` (1–5 s) in every migration session and retry.
- **Combining steps in one transaction.** What people do: add column, backfill, add index and constraint in one migration file wrapped in `BEGIN/COMMIT`. Why it hurts: the strongest lock taken early is held until the end, so the whole backfill runs under `ACCESS EXCLUSIVE`. Instead: one lock-taking statement per transaction, backfills outside migrations.
- **`CREATE INDEX` without `CONCURRENTLY`.** Blocks all writes for the build — minutes to hours. Instead: `CONCURRENTLY`, non-transactional migration, check for INVALID leftovers.
- **Renaming in one step.** Breaks whichever of old or new code is running. Instead: expand/contract, or a view/pgroll compatibility layer.
- **Backfilling with one giant `UPDATE`.** Hours-long transaction, WAL burst, replica lag, bloat, blocked vacuum. Instead: PK-range batches with commits, throttling on replica lag, resumable checkpoints.
- **Dropping a column the ORM still has cached.** Every insert fails after the drop. Instead: stop reading, stop writing, bake, then drop.
- **Adding `NOT NULL`, `CHECK` or `FOREIGN KEY` validated.** Full scan under a strong lock. Instead: `NOT VALID` then `VALIDATE`.
- **Planning a rollback by "down migrations".** A `down` for `DROP COLUMN` cannot bring the data back, and a `down` run while new code is live breaks it. Instead: make every step backward compatible so rollback means redeploying the previous code, and treat contract steps as irreversible (backup first, long bake time).
- **Letting the migration run against a replica-lagged system blind.** Instead: dashboards for lock waits, replica lag, WAL rate and p99 latency open during every large migration; a named person watching them.

## 8. Production: Failure Scenarios, Monitoring & Scaling

### Failure scenarios

- **The convoy.** 11:00, a deploy runs `ALTER TABLE users ADD COLUMN marketing_opt_in boolean`. An hour-long analytics transaction holds `ACCESS SHARE` on `users`. Symptom: login endpoint p99 jumps to the 30 s timeout, all pool connections busy. Root cause: `ALTER` queued behind the analytics query and every new query queued behind the `ALTER`. Fix now: cancel the `ALTER` (`pg_cancel_backend`), traffic recovers instantly. Fix forever: `lock_timeout` in migrations, `idle_in_transaction_session_timeout` and statement timeouts for analytics roles, analytics on a replica.
- **The rewrite nobody expected.** A migration changes `price numeric(10,2)` to `numeric(12,2)` — fine, binary-compatible — and in the same file `quantity int` to `bigint`. Symptom: 40 minutes of `ACCESS EXCLUSIVE`. Fix: CI linting that flags type changes on large tables; test migrations against a production-sized copy and time them.
- **INVALID index silently slowing writes.** A `CREATE INDEX CONCURRENTLY` failed on a unique violation at 03:00; the retry job created a second index with a new name. Symptom: write latency up 15%, two unused indexes. Fix: check `indisvalid`, drop invalid indexes, make index builds idempotent by name.
- **Replicas hours behind after a backfill.** A backfill written as a single `UPDATE` generated 300 GB of WAL in 20 minutes. Read replicas serve stale data, and failover would now lose data or take long to catch up. Fix: batched backfill with lag-based throttling; alert on replay lag.
- **Sequence exhaustion.** `ERROR: nextval: reached maximum value of sequence "events_id_seq" (2147483647)`. All inserts fail. Fix now: if the column is `int`, there is no quick fix — at best, switch the sequence to negative values temporarily. Fix forever: `bigint` identity columns by default and an alert when any sequence passes 50% of its type's range.

### Metrics to watch during a migration

| Signal | Query / source | Why |
|---|---|---|
| Sessions waiting on locks | `pg_stat_activity WHERE wait_event_type = 'Lock'` | the convoy's first sign |
| Blocking chain | `pg_blocking_pids(pid)` | who to cancel |
| Replica replay lag | `pg_stat_replication.replay_lag` | throttle backfills |
| WAL generation rate | `pg_stat_wal.wal_bytes` delta | backfill pressure on replicas and archive |
| Dead tuples on the table | `pg_stat_user_tables.n_dead_tup` | whether vacuum keeps up with the backfill |
| Index build progress | `pg_stat_progress_create_index` | ETA for long builds |
| App p99 and error rate | APM | the ultimate arbiter: pause if it moves |

### Scaling notes

At fleet scale (hundreds of databases or shards), migrations become a *product*: a migration service that applies each change shard by shard with canaries, automatic pause on error-rate or lag regressions, and a registry of which shards are at which version — because a sharded system will have shards at different schema versions for hours ([Ch 12 · Sharding](topic.html?p=12-sharding)). Code must tolerate that too, which is the same backward-compatibility rule applied across shards instead of across deploys. For very large tables, partitioning ([Ch 11](topic.html?p=11-partitioning)) keeps each migration step bounded: index builds, validations and even rewrites can be done partition by partition.

## 9. Interview Questions

**Q: Why can a metadata-only ALTER TABLE still cause an outage?**
A: Because it still needs an `ACCESS EXCLUSIVE` lock, and the danger is the wait, not the hold. If any transaction currently holds even `ACCESS SHARE` on the table — a long `SELECT`, an idle-in-transaction session — the `ALTER` waits in the lock queue. PostgreSQL grants locks in queue order, so every later query on that table, including plain reads, conflicts with the waiting `ACCESS EXCLUSIVE` request and queues behind it. Within seconds the connection pool is full of blocked queries. The fix is `SET lock_timeout` so the `ALTER` gives up after a second or two, plus a retry loop.

**Q: How do you add a NOT NULL column with a default to a very large PostgreSQL table without downtime?**
A: On PostgreSQL 11 or later, `ADD COLUMN ... DEFAULT 'x'` with a constant or stable default is metadata-only: the default is stored in the catalog and returned for existing rows, so no rewrite occurs. Adding `NOT NULL` in the same statement is fine in that case, since the default guarantees it. If the column already exists and was backfilled, add `CHECK (col IS NOT NULL) NOT VALID`, run `VALIDATE CONSTRAINT` (which scans under a lock that allows reads and writes), then `SET NOT NULL`, which skips its own scan because the validated check proves it, and drop the check. Every statement runs with `lock_timeout`. A volatile default such as `gen_random_uuid()` would force a rewrite, so for that you add the column without a default and backfill.

**Q: What is the expand/contract pattern, and why is it necessary for renames?**
A: It splits a breaking change into steps that are each compatible with every code version that can be running: expand the schema additively (add the new column), dual-write and backfill so both shapes hold the same data, switch reads to the new shape, stop writing the old one, then contract by dropping it. A rename needs it because a one-step `RENAME COLUMN` breaks whichever code is live: if the rename goes first, old code queries a missing column; if code goes first, new code queries a column that does not exist yet. Rolling and canary deploys guarantee old and new code overlap, so there is no instant at which a breaking change is safe.

**Q: What are the gotchas of CREATE INDEX CONCURRENTLY?**
A: It cannot run inside a transaction block, so migration frameworks that wrap migrations in transactions must be told not to. It does two passes over the table and waits for existing transactions that might not see the index, so a long-running transaction anywhere delays completion. If it fails — a unique violation, deadlock or cancellation — it leaves an INVALID index that is still updated on every write but not used for reads; you must detect it via `pg_index.indisvalid` and drop it with `DROP INDEX CONCURRENTLY` before retrying. It also uses more total work than a normal build, but it never blocks writes, which is the point.

**Q: How would you backfill a new column on a 1-billion-row table?**
A: In small, independently committed batches keyed by primary-key ranges, not a single `UPDATE`. Each batch touches a few thousand rows so locks are short and vacuum can clean up behind it; the predicate is idempotent so reruns are safe; and progress is checkpointed so the job survives restarts. The job throttles itself on replica replay lag and a duty cycle, since a single massive update would generate a WAL burst that puts replicas far behind and bloats the table. New writes are covered by dual-writing or a trigger before the backfill starts, and afterwards I verify with a count of mismatches before switching reads.

**Q: How do you remove a column that an application uses?**
A: In three deploys. First, deploy code that no longer reads the column, and make sure the ORM no longer includes it in its cached column list. Second, stop writing it; if it is `NOT NULL` without a default, drop the constraint first so inserts that omit it succeed. Third, after every process, worker and cron job runs the new code and `pg_stat_statements` shows no queries referencing it, drop it with `lock_timeout` after confirming a recent backup. The drop is metadata-only in PostgreSQL, but it is the one irreversible step, so it goes last and after a bake period.

**Q: Why are "down" migrations a weak rollback strategy?**
A: Because many schema changes cannot be undone without data loss: a `down` for `DROP COLUMN` recreates an empty column, not the data. And running a `down` while new code is deployed breaks that code, so rollback becomes a coordinated change of both schema and code, which is exactly the coordination you were trying to avoid. The robust approach is to make each forward step backward compatible, so rolling back means redeploying the previous application version against the current schema. Irreversible contract steps are isolated, delayed, and preceded by a backup; recovery from them is a restore, not a migration.

**Q: What does gh-ost do differently from pt-online-schema-change?**
A: Both build a shadow copy of the table with the new schema, copy existing rows in chunks, keep it in sync with concurrent writes, and swap tables with a rename. pt-online-schema-change keeps the copy in sync with triggers on the original table, which add write overhead and locking on the hot table and cannot be paused cleanly. gh-ost is triggerless: it reads the binary log as a replica would and applies changes to the ghost table asynchronously, which lets it throttle and pause completely (on replica lag, load, or a flag file) and lets you postpone the cut-over until a quiet moment. The trade-off is that gh-ost needs row-based binlogs and has its own constraints, such as limited foreign key support.

**Q: Your team needs to change orders.id from int to bigint on a 2 TB table with 40 referencing foreign keys. Plan it. (Senior)**
A: A direct `ALTER COLUMN TYPE` rewrites the table and every index under `ACCESS EXCLUSIVE`, which is hours of downtime, so I would do it online. First I buy time: check sequence headroom and the growth rate to know my deadline. Then for `orders`: add `id_new bigint`, a trigger copying `id` into it on insert and update, a throttled PK-range backfill, a `CREATE UNIQUE INDEX CONCURRENTLY` on `id_new`, and a validated `CHECK (id_new IS NOT NULL)`. The swap is one short transaction under `lock_timeout` with retries: drop the old PK, set NOT NULL (instant thanks to the check), rename the columns, `ADD PRIMARY KEY USING INDEX`, move the sequence ownership and default, drop the trigger. The referencing FK columns are the long tail: each child table gets the same new-column, trigger, backfill process, and the foreign keys are recreated with `NOT VALID` and validated afterwards. I would script it, rehearse it on a production-sized restore to measure each phase, and roll it out table by table over weeks, with alerts on sequences at 50% so we never do it as an emergency again.

**Q: How do you keep schema migrations safe across a fleet of 200 shards? (Senior)**
A: I treat migrations as a deployment of their own, not a side effect of an application deploy. A migration runner applies the change to a canary shard, watches error rates, lock waits and replica lag, then proceeds in waves with automatic pause on regressions, and records the schema version per shard. Because shards will be at different versions for hours, application code must work against both the old and new schema — the expand/contract rule applied across shards. Unsafe DDL is blocked before it gets there by a linter in CI, and every statement runs with `lock_timeout` and retry. Contract steps run only after all shards are expanded and all code is on the new version, and they are gated on a fresh backup per shard.

**Q: A migration is "stuck" and the site is slow. Walk me through diagnosing it live. (Senior)**
A: First I check `pg_stat_activity` for sessions with `wait_event_type = 'Lock'` and see whether they are piling up on one relation; `pg_blocking_pids()` on a victim shows the chain, typically many queries blocked by the migration's `ALTER`, which is itself blocked by an old transaction. The fastest mitigation is to cancel the migration statement with `pg_cancel_backend`, which releases the queue immediately; killing the old transaction instead may be acceptable if it is a known, disposable report. If nothing is waiting on locks, the migration may be doing heavy work — a rewrite, a validation, or an index build — so I check `pg_stat_progress_create_index` or `pg_stat_progress_cluster`, and I/O and replica lag. After the incident I would add `lock_timeout` to the runner, timeouts for idle transactions and long reports, and CI lint rules for the DDL form that caused it.

**Q: When is it acceptable to take downtime for a migration instead of doing it online?**
A: When the cost of the online path exceeds the cost of the downtime. Online migrations of large, heavily referenced tables can take weeks of engineering and carry their own risk from dual writes and long transition states. If the business has an acceptable maintenance window — an internal tool, a B2B product with a contractual window, a batch system — a planned, rehearsed, measured outage with a tested backup can be the safer engineering choice. The key is that downtime is a decision with a measured duration, not an accident caused by a lock queue.

## 10. Quick Revision & Cheat Sheet

| Change | Safe PostgreSQL recipe |
|---|---|
| Add nullable column | `ADD COLUMN` + `lock_timeout` |
| Add column with default | constant/stable default: instant (PG 11+); volatile: add, then backfill |
| Add NOT NULL | `CHECK (c IS NOT NULL) NOT VALID` → `VALIDATE` → `SET NOT NULL` → drop check |
| Add index | `CREATE INDEX CONCURRENTLY` (no txn), check `indisvalid` |
| Add FK / CHECK | `NOT VALID` → `VALIDATE CONSTRAINT` |
| Add unique / PK | unique index concurrently → `ADD CONSTRAINT ... USING INDEX` |
| Rename column/table | expand/contract, or views (pgroll) |
| Change type (rewrite) | new column + trigger + backfill + swap |
| Drop column | stop reading → stop writing → bake → drop |
| Backfill | PK-range batches, commit each, throttle on replica lag, idempotent, resumable |
| MySQL | `ALGORITHM=INSTANT`/`INPLACE, LOCK=NONE` explicitly; gh-ost / pt-osc for the rest |

- The lock *wait* causes outages; always `SET lock_timeout` and retry.
- One strong-lock statement per transaction; never backfill inside a migration transaction.
- Schema changes that add go before code; changes that remove go after code.
- Every intermediate state must work with every code version that can be running.
- Rollback = redeploy old code, which only works if every step is backward compatible.
- The contract step is irreversible: bake, back up, then drop.
- Test migrations against production-sized data and time them.
- Lint migrations in CI (squawk, strong_migrations) so unsafe forms never ship.

## 11. Hands-On Exercises

Lab: `docker run --name pg -e POSTGRES_PASSWORD=pg -d postgres:17` and create `CREATE TABLE big AS SELECT g AS id, md5(g::text) AS name FROM generate_series(1, 20000000) g; ALTER TABLE big ADD PRIMARY KEY (id);`.

1. **Reproduce the convoy.** In session A: `BEGIN; SELECT count(*) FROM big;` (leave open). In B: `ALTER TABLE big ADD COLUMN x int;`. In C: `SELECT * FROM big WHERE id = 1;` — observe C blocks. Inspect `pg_stat_activity` and `pg_blocking_pids`. Repeat with `SET lock_timeout = '2s'` in B.
2. **Rewrite vs metadata-only.** Time `ADD COLUMN a text DEFAULT 'x'`, `ADD COLUMN b timestamptz DEFAULT now()`, and `ADD COLUMN c uuid DEFAULT gen_random_uuid()`. Check `pg_relation_filenode('big')` before and after each to see which rewrote the table.
3. **NOT NULL the safe way.** Add `NOT NULL` to a backfilled column directly and time it; then repeat using `CHECK ... NOT VALID` → `VALIDATE` → `SET NOT NULL` while a concurrent `pgbench` script writes to the table, and compare observed write latency.
4. **Concurrent index failure.** Insert a duplicate value, run `CREATE UNIQUE INDEX CONCURRENTLY` on that column, observe the failure, find the INVALID index, and clean it up.
5. **Throttled backfill.** Add a streaming replica (second container), run the batched backfill script with and without throttling, and graph `replay_lag` in both runs.

**Mini project — rename a column with zero errors.** Write a tiny HTTP service (v1) that reads and writes `users.name` under constant load from a load generator. Implement the full expand/contract rename to `full_name` across four application versions and five migrations, with a sync trigger during the transition. Success criterion: the load generator records zero errors across all deploys, including a deliberate rollback from v3 to v2 midway. Stretch: redo it with pgroll and compare.

## 12. Related Topics & Free Learning Resources

**In this handbook:** [Ch 03 · MVCC](topic.html?p=03-mvcc) (why backfills bloat) · [Ch 05 · Locking Internals](topic.html?p=05-locking-internals) (lock modes and the queue) · [Ch 09 · Database Replication](topic.html?p=09-replication) (replica lag from DDL and backfills) · [Ch 11 · Partitioning](topic.html?p=11-partitioning) · [Ch 12 · Sharding](topic.html?p=12-sharding) · [Ch 20 · Database + Application](topic.html?p=20-database-application-architecture) (timeouts, pools) · [Ch 26 · Backup & Disaster Recovery](topic.html?p=26-backup-disaster-recovery) (backup before contract).

**SQL Handbook:** [SQL Handbook · Schema Design & Data Modeling](../sql/topic.html?p=30-schema-design) · [SQL Handbook · Keys, Constraints & Referential Integrity](../sql/topic.html?p=29-keys-constraints) · [SQL Handbook · Indexes](../sql/topic.html?p=19-indexes) · [SQL Handbook · Locking & MVCC](../sql/topic.html?p=27-locking-mvcc).

**Other handbooks:** [Kafka & RabbitMQ · Schema Registry](../messaging/topic.html?p=26-schema-registry) (the same compatibility rules for event schemas) · [Cassandra · Migration Real-World Challenges](../cassandra/topic.html?p=46-migration-real-world-challenges).

- **ALTER TABLE** — PostgreSQL Docs · *Intermediate* · the notes section lists which forms rewrite, which scan, and which lock level each takes. <https://www.postgresql.org/docs/current/sql-altertable.html>
- **Explicit Locking** — PostgreSQL Docs · *Intermediate* · the lock conflict matrix behind every migration outage. <https://www.postgresql.org/docs/current/explicit-locking.html>
- **ParallelChange** — Martin Fowler (Danilo Sato) · *Beginner* · the original expand/migrate/contract write-up. <https://martinfowler.com/bliki/ParallelChange.html>
- **gh-ost** — GitHub · *Advanced* · design docs for triggerless online schema migration for MySQL. <https://github.com/github/gh-ost>
- **pgroll** — Xata · *Intermediate* · zero-downtime, reversible PostgreSQL migrations via versioned views. <https://github.com/xataio/pgroll>
- **strong_migrations** — Andrew Kane · *Beginner* · a catalogue of unsafe PostgreSQL/MySQL operations and their safe alternatives. <https://github.com/ankane/strong_migrations>
- **Online DDL Operations** — MySQL Reference Manual · *Intermediate* · which operations are INSTANT, INPLACE or COPY. <https://dev.mysql.com/doc/refman/8.0/en/innodb-online-ddl-operations.html>

---

*Database Design Handbook — chapter 27.*
