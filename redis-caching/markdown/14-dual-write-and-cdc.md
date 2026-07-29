# 14 · The Dual-Write Problem & Change Data Capture

> **In one line:** Writing to the database and then to the cache from application code is two writes with no shared transaction, so a crash or a race between them corrupts the cache silently — and the fix is not more careful application code but moving the invalidation *downstream of the database's own committed log*, via the outbox pattern or Change Data Capture.

---

## 1. Overview

The most common cache-consistency bug is also the most innocent-looking. Your write path does the obvious thing: update the database, then update (or invalidate) the cache. Two lines. It works in every test, every demo, and almost every request in production — until the process crashes, or the network hiccups, or two writers interleave, in the narrow gap *between* the two operations. Then the database holds the new value and the cache holds the old one, with nothing to reconcile them, and the cache serves the stale value until a TTL or another write rescues it. This is the **dual-write problem**: two independent writes to two systems that must agree, with no atomic operation spanning both.

The instinct is to fix it with more careful code — retries, ordering, "wrap it in a transaction". None of these work, because the fundamental issue is that a database transaction covers the database only; it cannot include a write to Redis. There is no distributed transaction here (and even if you reached for one, it is a heavy, fragile hammer for a caching problem). The dual-write problem is not a coding mistake to be tidied up; it is a structural property of writing to two systems from one place.

The durable fix inverts the flow. Instead of the application writing to both systems, you make the *database's committed log of changes* the single source of invalidation events. Two patterns achieve this. The **outbox pattern** writes the business row and an "event" row in the *same* database transaction, so they commit atomically; a relay then reads the outbox and publishes the events. **Change Data Capture (CDC)** goes further: a tool like Debezium tails the database's write-ahead log or binlog directly and emits a change event for every committed row change, which a consumer turns into a cache invalidation. Both share one idea — *the cache follows the committed log of truth*, so an event exists if and only if the write committed, and the cache can never disagree with the database for longer than the pipeline's lag. This chapter explains why the dual-write problem is unfixable in application code, and how outbox and CDC fix it properly.

## 2. Core Concepts

- **Dual write** — two separate writes to two systems (database and cache) that must stay consistent, with no atomic operation covering both.
- **The gap** — the window between the two writes where a crash, error, or race leaves the systems disagreeing.
- **Atomicity across systems** — the property a single database transaction *cannot* provide, because it commits only the database, not Redis.
- **Distributed transaction (2PC)** — the heavyweight, fragile mechanism that *could* span both systems but is almost never worth it for a cache.
- **Outbox pattern** — writing the business change and an event record in one database transaction, then relaying the event from the outbox table asynchronously.
- **Relay / message relay** — the process that reads committed outbox rows and publishes them to a broker or applies them as cache invalidations, marking them done.
- **Change Data Capture (CDC)** — capturing every committed row change by reading the database's replication log (WAL/binlog) and emitting change events.
- **Debezium** — the de-facto open-source CDC platform; connectors tail Postgres WAL, MySQL binlog, etc., and produce change events (commonly to Kafka).
- **Write-ahead log (WAL) / binlog** — the database's own ordered, durable record of committed changes; the source of truth CDC reads.
- **Log follower** — any consumer (a cache invalidator here) that subscribes to the change log and applies its effects; the cache becomes one.
- **At-least-once delivery & idempotency** — the delivery guarantee of these pipelines, and the reason cache invalidations must be safe to apply twice.

## 3. Theory & Principles

### Why the dual write is unsafe

Consider the canonical write path: `UPDATE users SET email=… WHERE id=9` against the database, then `DEL user:9` against Redis. Enumerate what can go wrong *between* them:

- **The process crashes after the DB commit, before the cache delete.** The database has the new email; the cache still holds the old one; nothing will delete it. The cache is stale until its TTL expires — and if there is no TTL, indefinitely.
- **The cache delete fails** (Redis is briefly unreachable, a timeout). Same outcome: DB updated, cache stale, and unless you built a retry-with-durability mechanism, the failure is lost.
- **Two writers race.** Writer A commits email=X, writer B commits email=Y, but their cache operations are reordered by scheduling so the cache ends on X while the DB ends on Y. The systems disagree permanently.
- **You reorder to "cache first".** Delete the cache, then write the DB — now if the DB write fails, you have thrown away a warm cache for nothing, and a reader in the gap repopulates the *old* value from the unchanged DB, re-staling the cache you just cleared.

Every ordering has a failure mode, because the problem is not the order — it is that the two writes are not atomic. There is a moment where one has happened and the other has not, and any interruption in that moment leaves the systems inconsistent with no record that they disagree.

### Why "just wrap it in a transaction" doesn't work

The reflexive fix is a transaction. But a database transaction is a guarantee *the database makes about itself*: it makes a set of database operations atomic, isolated and durable *within the database*. It has no reach into Redis. You can `BEGIN … UPDATE users … COMMIT`, and the `DEL user:9` sits entirely outside that transaction — if the commit succeeds and the delete then fails, the transaction cannot roll back, because from the database's perspective nothing went wrong. Redis is not a participant.

The only mechanism that genuinely makes a write to two systems atomic is a **distributed transaction** with two-phase commit (2PC), where a coordinator asks both systems to *prepare*, and only if both agree does it tell both to *commit*. This exists, but for a cache it is the wrong tool by a wide margin: it is operationally heavy, it blocks (a participant that prepares and then loses the coordinator is stuck holding locks), Redis is not a natural 2PC participant, and you would be paying a synchronous, latency-adding, availability-reducing protocol on every write to keep a cache — whose entire job was to *improve* latency and availability — in sync. Nobody sensible does this. The right answer is not to make the two writes atomic; it is to *stop doing two writes*.

```svg
<svg viewBox="0 0 880 460" width="100%" height="460" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="dw1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
    <marker id="dw2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The dual write vs following the committed log</text>

  <rect x="24" y="40" width="410" height="180" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="229" y="62" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Dual write from app code (unsafe)</text>
  <rect x="44" y="76" width="120" height="40" rx="6" fill="#fff" stroke="#dc2626"/>
  <text x="104" y="100" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">App</text>
  <path d="M164,90 L214,90" stroke="#dc2626" stroke-width="1.8" marker-end="url(#dw1)"/>
  <rect x="216" y="76" width="90" height="40" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="261" y="96" text-anchor="middle" fill="#b91c1c" font-size="9" font-weight="bold">1. DB</text>
  <text x="261" y="110" text-anchor="middle" fill="#991b1b" font-size="8">UPDATE</text>
  <path d="M104,116 L104,150" stroke="#dc2626" stroke-width="1.8" marker-end="url(#dw1)"/>
  <rect x="44" y="152" width="120" height="40" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="104" y="172" text-anchor="middle" fill="#b91c1c" font-size="9" font-weight="bold">2. Cache</text>
  <text x="104" y="186" text-anchor="middle" fill="#991b1b" font-size="8">DEL</text>
  <path d="M170,172 L320,172" stroke="#dc2626" stroke-width="2" stroke-dasharray="4 3" marker-end="url(#dw1)"/>
  <text x="248" y="150" fill="#b91c1c" font-size="9" font-weight="bold">THE GAP</text>
  <text x="248" y="166" fill="#991b1b" font-size="8">crash / error /</text>
  <text x="248" y="180" fill="#991b1b" font-size="8">race here &#8594;</text>
  <text x="248" y="194" fill="#991b1b" font-size="8">DB new, cache old</text>
  <text x="229" y="212" text-anchor="middle" fill="#991b1b" font-size="9">No transaction spans both. Every ordering has a failure mode.</text>

  <rect x="446" y="40" width="410" height="180" rx="10" fill="#fefce8" stroke="#ca8a04" stroke-width="2"/>
  <text x="651" y="62" text-anchor="middle" fill="#854d0e" font-size="12" font-weight="bold">Outbox: one transaction, two rows</text>
  <rect x="466" y="80" width="150" height="56" rx="6" fill="#fff" stroke="#ca8a04"/>
  <text x="541" y="100" text-anchor="middle" fill="#854d0e" font-size="9" font-weight="bold">DB TRANSACTION</text>
  <text x="541" y="116" text-anchor="middle" fill="#713f12" font-size="8">UPDATE users (business row)</text>
  <text x="541" y="130" text-anchor="middle" fill="#713f12" font-size="8">INSERT outbox (event row)</text>
  <path d="M616,108 L664,108" stroke="#ca8a04" stroke-width="1.8" marker-end="url(#dw1)"/>
  <rect x="666" y="80" width="170" height="56" rx="6" fill="#fff" stroke="#ca8a04"/>
  <text x="751" y="100" text-anchor="middle" fill="#854d0e" font-size="9" font-weight="bold">Relay</text>
  <text x="751" y="116" text-anchor="middle" fill="#713f12" font-size="8">reads committed outbox rows</text>
  <text x="751" y="130" text-anchor="middle" fill="#713f12" font-size="8">publishes &#8594; invalidates cache</text>
  <text x="651" y="158" text-anchor="middle" fill="#713f12" font-size="9">Both rows commit atomically, so the event exists</text>
  <text x="651" y="174" text-anchor="middle" fill="#713f12" font-size="9">if and only if the business write committed.</text>
  <text x="651" y="196" text-anchor="middle" fill="#854d0e" font-size="9" font-weight="bold">No gap: one transaction, not two writes.</text>

  <rect x="24" y="236" width="832" height="204" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="440" y="258" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">CDC: the cache follows the database's own committed log</text>

  <rect x="48" y="276" width="150" height="60" rx="6" fill="#fff" stroke="#16a34a"/>
  <text x="123" y="300" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">App</text>
  <text x="123" y="318" text-anchor="middle" fill="#166534" font-size="9">writes DB only</text>
  <path d="M198,306 L246,306" stroke="#16a34a" stroke-width="1.8" marker-end="url(#dw2)"/>

  <rect x="248" y="276" width="170" height="60" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="333" y="300" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">Database + WAL/binlog</text>
  <text x="333" y="318" text-anchor="middle" fill="#166534" font-size="9">ordered, durable, committed</text>
  <path d="M418,306 L466,306" stroke="#16a34a" stroke-width="1.8" marker-end="url(#dw2)"/>

  <rect x="468" y="276" width="170" height="60" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="553" y="296" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">CDC (Debezium)</text>
  <text x="553" y="314" text-anchor="middle" fill="#166534" font-size="9">tails the log, emits</text>
  <text x="553" y="328" text-anchor="middle" fill="#166534" font-size="9">a change event per commit</text>
  <path d="M638,306 L686,306" stroke="#16a34a" stroke-width="1.8" marker-end="url(#dw2)"/>

  <rect x="688" y="276" width="150" height="60" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="763" y="296" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">Consumer</text>
  <text x="763" y="314" text-anchor="middle" fill="#166534" font-size="9">UNLINK user:9</text>
  <text x="763" y="328" text-anchor="middle" fill="#166534" font-size="9">on each change</text>

  <rect x="48" y="352" width="790" height="74" rx="8" fill="#fff" stroke="#16a34a"/>
  <text x="443" y="374" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">The guarantee this buys</text>
  <text x="66" y="394" fill="#166534" font-size="9">An event exists if and only if the write COMMITTED (never for a rolled-back write, never missing for a committed one).</text>
  <text x="66" y="410" fill="#166534" font-size="9">The app makes ONE write. The cache can disagree for at most the pipeline lag, then converges. At-least-once &#8594; make invalidation idempotent.</text>
</svg>
```

### The insight: make the cache a follower of the log

The unifying principle is that the database *already keeps* a perfect, ordered, durable record of every committed change — its write-ahead log (Postgres) or binlog (MySQL). That log is the source of truth about *what actually happened*, in the exact order it committed. If the cache's invalidations are driven by that log, they inherit its properties: an invalidation exists precisely when a change committed, in commit order, with nothing lost and nothing spurious. The cache becomes a **follower of the log**, the same way a read replica is — and a read replica is never permanently inconsistent with its primary, only lagging. That is exactly the guarantee you want for a cache: bounded lag, eventual convergence, no silent permanent disagreement. The outbox pattern approximates this with an application-level event table; CDC does it directly against the database's real log. Both replace "the app writes twice and hopes" with "the cache follows what the database actually committed".

## 4. Architecture & Workflow

### The outbox pattern, step by step

The outbox pattern gets atomicity by making the event part of the *same database transaction* as the business change:

1. **In one transaction:** update the business row *and* insert a row into an `outbox` table describing the change (`{aggregate: "user", id: 9, op: "update"}`). Because they are in one transaction, they commit together or not at all — no gap.
2. **A relay process polls the outbox** (or is triggered) for unpublished rows, in commit order.
3. **The relay publishes each event** — to a message broker, or directly as a cache invalidation (`UNLINK user:9`).
4. **The relay marks the row published** (or deletes it) once the publish is acknowledged. If the relay crashes after publishing but before marking, it republishes on restart — hence *at-least-once*, hence invalidations must be idempotent.

The outbox turns the dual write into a single write (the transaction) plus an *asynchronous, retryable, durable* relay. The event can never be lost, because it is committed durably with the business change; it can only be *delayed* (if the relay is behind) or *duplicated* (if the relay retries) — both of which a cache invalidation tolerates fine.

### CDC, step by step

CDC removes even the outbox table by reading the database's own log:

1. **The app writes the database normally** — no outbox, no second write, no special code.
2. **A CDC connector (Debezium) tails the WAL/binlog**, which the database already produces for its own replication and durability. It reads committed changes in order.
3. **The connector emits a change event** per row change — before/after images, table, operation — typically onto a durable topic (Kafka) but it can drive other sinks.
4. **A cache-invalidation consumer** reads those change events and applies the corresponding `UNLINK`/`DEL` (or refill) to Redis, tracking its offset so a restart resumes exactly where it left off.

CDC's advantage over the outbox is that it *cannot be bypassed*. With an outbox, a write path that forgets to insert the outbox row (a batch job, an admin tool, a raw SQL migration) silently skips the event. CDC reads the log every committed change lands in, so *every* write — however it was made — produces an event. The cost is running the CDC pipeline: the connector, the topic, the consumer, and the operational care they need.

### Delivery semantics you must design for

Both outbox and CDC give **at-least-once** delivery: an event is never lost but may be delivered more than once (after a relay/consumer restart). This is fine *if and only if* your cache invalidation is **idempotent** — and a `DEL`/`UNLINK` naturally is (deleting an already-absent key is a no-op). If instead you *update* the cache in place from the change event, you must handle out-of-order or duplicate delivery (e.g. by only applying a change whose version is newer than what the cache holds), or you can reintroduce the very inconsistency you removed. The safe default is: **CDC/outbox events drive deletes, not in-place updates**, so idempotency is automatic.

```svg
<svg viewBox="0 0 880 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="wf1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Outbox relay vs CDC connector &#8212; and the at-least-once loop</text>

  <rect x="24" y="40" width="410" height="150" rx="10" fill="#fefce8" stroke="#ca8a04" stroke-width="2"/>
  <text x="229" y="62" text-anchor="middle" fill="#854d0e" font-size="12" font-weight="bold">Outbox relay</text>
  <text x="40" y="86" fill="#713f12" font-size="9" font-weight="bold">1  poll outbox for unpublished rows (commit order)</text>
  <text x="40" y="106" fill="#713f12" font-size="9" font-weight="bold">2  publish each event / apply invalidation</text>
  <text x="40" y="126" fill="#713f12" font-size="9" font-weight="bold">3  mark row published (or delete it)</text>
  <text x="40" y="150" fill="#92400e" font-size="9">Can be BYPASSED: a write that skips the outbox insert</text>
  <text x="40" y="166" fill="#92400e" font-size="9">(batch job, admin tool, raw SQL) emits no event.</text>
  <text x="229" y="184" text-anchor="middle" fill="#854d0e" font-size="9" font-weight="bold">Lives in your DB &#8212; minimal new infrastructure.</text>

  <rect x="446" y="40" width="410" height="150" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="651" y="62" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">CDC connector (Debezium)</text>
  <text x="462" y="86" fill="#166534" font-size="9" font-weight="bold">1  tail the WAL / binlog (single ordered stream)</text>
  <text x="462" y="106" fill="#166534" font-size="9" font-weight="bold">2  emit a change event per committed row change</text>
  <text x="462" y="126" fill="#166534" font-size="9" font-weight="bold">3  consumer invalidates + advances offset</text>
  <text x="462" y="150" fill="#15803d" font-size="9">CANNOT be bypassed: every committed change lands</text>
  <text x="462" y="166" fill="#15803d" font-size="9">in the log, whatever wrote it.</text>
  <text x="651" y="184" text-anchor="middle" fill="#15803d" font-size="9" font-weight="bold">Runs a connector &#8212; but correctness is mechanical.</text>

  <rect x="24" y="206" width="832" height="200" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="440" y="228" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">The consumer loop: apply the effect, THEN commit the offset</text>

  <rect x="48" y="244" width="150" height="54" rx="6" fill="#fff" stroke="#2563eb"/>
  <text x="123" y="266" text-anchor="middle" fill="#1e40af" font-size="10" font-weight="bold">read next event</text>
  <text x="123" y="284" text-anchor="middle" fill="#1d4ed8" font-size="9">+ offset token</text>
  <path d="M198,271 L246,271" stroke="#2563eb" stroke-width="1.8" marker-end="url(#wf1)"/>

  <rect x="248" y="244" width="180" height="54" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="338" y="266" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">UNLINK key (idempotent)</text>
  <text x="338" y="284" text-anchor="middle" fill="#166534" font-size="9">safe to apply twice</text>
  <path d="M428,271 L476,271" stroke="#2563eb" stroke-width="1.8" marker-end="url(#wf1)"/>

  <rect x="478" y="244" width="180" height="54" rx="6" fill="#fff" stroke="#2563eb"/>
  <text x="568" y="266" text-anchor="middle" fill="#1e40af" font-size="10" font-weight="bold">commit offset LAST</text>
  <text x="568" y="284" text-anchor="middle" fill="#1d4ed8" font-size="9">only after invalidation</text>
  <path d="M658,271 L706,271" stroke="#2563eb" stroke-width="1.8" marker-end="url(#wf1)"/>

  <rect x="708" y="244" width="128" height="54" rx="6" fill="#fff" stroke="#2563eb"/>
  <text x="772" y="266" text-anchor="middle" fill="#1e40af" font-size="10" font-weight="bold">loop</text>
  <text x="772" y="284" text-anchor="middle" fill="#1d4ed8" font-size="9">next event</text>

  <rect x="48" y="316" width="390" height="76" rx="8" fill="#fef2f2" stroke="#dc2626"/>
  <text x="243" y="338" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">Commit offset FIRST (wrong)</text>
  <text x="64" y="358" fill="#991b1b" font-size="9">crash after commit, before UNLINK &#8594; event LOST</text>
  <text x="64" y="374" fill="#991b1b" font-size="9">(at-most-once) &#8594; cache silently stale forever</text>

  <rect x="452" y="316" width="384" height="76" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="644" y="338" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">Apply effect FIRST (right)</text>
  <text x="468" y="358" fill="#166534" font-size="9">crash before commit &#8594; event REDELIVERED</text>
  <text x="468" y="374" fill="#166534" font-size="9">(at-least-once) &#8594; idempotent UNLINK absorbs it</text>
</svg>
```

## 5. Implementation

Two pieces of real Go. First, the outbox *write* — the business change and the event in one transaction. Second, a CDC *consumer* that invalidates Redis on change events (modelled on a Debezium-style event shape delivered via a stream/broker). Uses `database/sql` and `github.com/redis/go-redis/v9`.

```go
package cdc

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/redis/go-redis/v9"
)

// ---------------------------------------------------------------------------
// OUTBOX WRITE — the business change and the event commit ATOMICALLY.
//
// The whole point: there is no second write to a different system inside the
// hot path. We write two ROWS in ONE database transaction, so they are atomic.
// The event is relayed to the cache asynchronously and durably afterwards.
// Schema assumed:
//   outbox(id BIGSERIAL, aggregate TEXT, aggregate_id TEXT, op TEXT,
//          published BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT now())
// ---------------------------------------------------------------------------

func UpdateUserWithOutbox(ctx context.Context, db *sql.DB, userID, newEmail string) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	// If anything below fails, the deferred rollback undoes BOTH the business
	// change and the outbox insert — they are all-or-nothing.
	defer func() { _ = tx.Rollback() }()

	// 1) The business change.
	if _, err := tx.ExecContext(ctx,
		`UPDATE users SET email = $1 WHERE id = $2`, newEmail, userID); err != nil {
		return fmt.Errorf("update user: %w", err)
	}

	// 2) The event, in the SAME transaction. Because it commits with the business
	//    row, the event exists if and only if the write committed — no dual-write
	//    gap, no lost event, no event for a rolled-back write.
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO outbox (aggregate, aggregate_id, op) VALUES ('user', $1, 'update')`,
		userID); err != nil {
		return fmt.Errorf("insert outbox: %w", err)
	}

	// One atomic commit for both rows.
	return tx.Commit()
}

// ---------------------------------------------------------------------------
// CDC CONSUMER — invalidate Redis on committed change events.
//
// This models the downstream half of either an outbox relay OR a Debezium CDC
// stream: we receive change events (here decoded from a Debezium-style JSON
// envelope) and apply an idempotent cache invalidation. Because delivery is
// AT-LEAST-ONCE, every action here must be safe to apply twice — UNLINK is.
// ---------------------------------------------------------------------------

// ChangeEvent is a trimmed Debezium-style envelope: the table, the operation
// (c=create, u=update, d=delete, r=snapshot read), and the row key we need to
// build the cache key to invalidate.
type ChangeEvent struct {
	Table string          `json:"table"`
	Op    string          `json:"op"`
	Key   map[string]any  `json:"key"`   // primary key columns
	After json.RawMessage `json:"after"` // new row image (nil for deletes)
}

// cacheKeyFor maps a change event to the cache key(s) it invalidates. In a real
// system this is where you also fan out to derived keys / tags (chapter 12).
func cacheKeyFor(ev ChangeEvent) (string, bool) {
	switch ev.Table {
	case "users":
		id, ok := ev.Key["id"]
		if !ok {
			return "", false
		}
		return fmt.Sprintf("user:%v", id), true
	default:
		return "", false // not a table we cache
	}
}

// InvalidateOnChange applies one change event to the cache. Idempotent by
// construction: UNLINK of an absent key is a no-op, so a duplicate delivery is
// harmless. We deliberately DELETE rather than UPDATE from the event, so we do
// not have to reason about out-of-order delivery re-staling the cache.
func InvalidateOnChange(ctx context.Context, rdb *redis.Client, ev ChangeEvent) error {
	key, ok := cacheKeyFor(ev)
	if !ok {
		return nil // event for an uncached table — nothing to do
	}
	// UNLINK, not DEL: freeing a large value happens off the command thread.
	if err := rdb.Unlink(ctx, key).Err(); err != nil {
		return fmt.Errorf("invalidate %s: %w", key, err)
	}
	return nil
}

// ConsumeStream is the run loop: read change events from the source (a Kafka
// consumer or a Redis stream fed by the relay), invalidate, then COMMIT THE
// OFFSET only after the invalidation succeeded. Committing the offset last is
// what makes the pipeline at-least-once rather than at-most-once: a crash
// before the commit replays the event, and idempotent invalidation absorbs it.
func ConsumeStream(
	ctx context.Context,
	rdb *redis.Client,
	next func(context.Context) (ChangeEvent, string, error), // event + offset token
	commitOffset func(context.Context, string) error,
) error {
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		ev, offset, err := next(ctx)
		if err != nil {
			return err
		}
		// Apply the effect BEFORE committing the offset. Order matters: if we
		// committed the offset first and then crashed, the event would be lost
		// (at-most-once). This ordering gives at-least-once.
		if err := InvalidateOnChange(ctx, rdb, ev); err != nil {
			// Do NOT advance the offset — the event will be redelivered and retried.
			return err
		}
		if err := commitOffset(ctx, offset); err != nil {
			return err
		}
	}
}
```

The two halves embody the fix: the write side makes the change and its event atomic (one transaction, not two writes), and the consume side applies invalidations idempotently and commits its offset only after success, so the cache follows the committed log with at-least-once safety and no silent divergence.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **No dual-write gap.** The event commits with the write (outbox) or is read from the commit log (CDC), so it exists exactly when the write committed — no crash-in-the-gap inconsistency.
- **Cannot be bypassed (CDC).** Every committed change lands in the WAL/binlog, so *any* write path — app, batch job, admin tool, migration — produces an invalidation, closing the "forgot to invalidate" hole.
- **Ordered and complete.** The log delivers changes in commit order with nothing lost, so the cache converges deterministically.
- **Decoupled.** The write path no longer knows or cares about the cache; invalidation is a downstream concern, which keeps the hot path simple and fast.

**Disadvantages**
- **Operational weight.** CDC means running a connector, a durable topic, and a consumer, plus monitoring their health and lag; the outbox means a relay and an outbox table to prune.
- **Latency / lag.** Invalidation is asynchronous, so there is a propagation lag (the pipeline's) — the staleness window is the lag, which must fit the data's budget (chapter 13).
- **At-least-once complexity.** Duplicate and (for some sinks) out-of-order delivery must be handled; safe only if invalidations are idempotent.
- **More infrastructure to fail.** A stuck connector or a lagging consumer silently widens the staleness window; the pipeline itself becomes something to watch.

**Trade-offs**
- *Dual write vs pipeline:* the dual write is trivial to write and usually works, but fails silently in the gap; the pipeline is more infrastructure but is correct by construction. Choose the pipeline when silent staleness is unacceptable.
- *Outbox vs CDC:* the outbox needs no external log-reading tooling and lives in your database, but it can be bypassed by write paths that skip the outbox insert; CDC cannot be bypassed but needs a connector against the DB log. Choose CDC when multiple/unknown write paths exist.
- *Delete-from-event vs update-from-event:* deleting is idempotent and tolerates duplicate/out-of-order delivery; updating keeps the cache warm but must guard against re-staling from reordered events. Default to delete.
- *2PC vs following the log:* a distributed transaction makes the two writes truly atomic but is heavy, blocking, and reduces availability; following the log gives eventual consistency with far less cost. Almost always prefer the log.

## 7. Common Mistakes & Best Practices

- **Writing DB then cache and calling it done.** The gap between the two writes corrupts the cache on any crash, error, or race. *Best practice: drive invalidation from the committed log via outbox or CDC; if you must dual-write, always keep a TTL backstop so the staleness self-heals.*
- **"Wrapping it in a transaction" to fix it.** A database transaction covers the database only; the cache write is outside it. *Best practice: put the event in the same transaction (outbox), not the cache write.*
- **Reaching for a distributed transaction (2PC).** Heavy, blocking, and availability-reducing for what is only a cache. *Best practice: accept eventual consistency and follow the log instead.*
- **Updating the cache in place from CDC events.** At-least-once and possibly out-of-order delivery can re-stale the cache. *Best practice: delete/UNLINK from events so invalidation is idempotent, or gate updates on a monotonically increasing version.*
- **Forgetting the outbox can be bypassed.** A write path that skips the outbox insert emits no event. *Best practice: funnel all writes through the outbox, or use CDC which reads the log every write lands in.*
- **Committing the consumer offset before applying the effect.** A crash then loses the event (at-most-once). *Best practice: apply the invalidation first, commit the offset only after it succeeds.*
- **Not monitoring pipeline lag.** The staleness window *is* the lag; an unwatched, stuck connector means silently stale caches. *Best practice: alert on connector health and consumer lag against your staleness budget.*
- **Letting the outbox table grow unbounded.** Published rows accumulate. *Best practice: prune or partition the outbox, and index it for the relay's poll query.*

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** When the cache is stale despite a pipeline, trace one change end to end with a correlation id: did the write commit (check the row and the WAL position), did the connector emit an event (check its offset and the topic), did the consumer receive and apply it (check consumer lag and the `UNLINK` outcome)? A common finding is a write path that bypassed an outbox, or a consumer stuck on a poison event and not advancing. For outbox specifically, query for unpublished rows older than the relay interval — a backlog means the relay is down or slow.
- **Monitoring.** The headline metric is **end-to-end lag**: time from commit to cache invalidation, because that lag *is* the staleness window. Monitor connector health (Debezium exposes connector/task status and the WAL/binlog position it has read), consumer lag on the topic, outbox backlog size, and the rate of redelivered/duplicated events (a proxy for retries). Alert when lag exceeds the tightest data type's staleness budget.
- **Security.** CDC reads the database's change log, which contains *every column of every changed row*, including sensitive fields — so the CDC topic and connector are a high-value data path that must be access-controlled, encrypted in transit (TLS), and often column-filtered or masked so secrets and PII are not broadcast to every consumer. The connector's database credentials need replication privileges, which are powerful; scope and rotate them. On the Redis side, the invalidation consumer needs only the commands to delete keys — grant it a minimal ACL, not full access.
- **Scaling.** The pipeline scales by *partitioning the change stream* — typically by aggregate/entity id — so many consumers invalidate in parallel while preserving per-key order (all changes to `user:9` land on one partition, so they apply in commit order). The connector reading the WAL/binlog is usually single-writer per database (the log is a single ordered stream), so the connector is scaled *up* and made highly available (failover with offset persistence) rather than scaled out. Watch that the connector never falls so far behind that the database recycles the WAL/binlog segments it still needs — that is a hard failure mode requiring a re-snapshot, and it is the CDC equivalent of a replica falling off the replication window.

## 9. Interview Questions

**Q: What is the dual-write problem?**
A: It is the inconsistency that arises when you write to two systems that must agree — typically the database and the cache — from application code, with no atomic operation spanning both. The write path updates the database and then updates or invalidates the cache as two separate operations. Between them is a gap: if the process crashes, the cache operation errors, or two writers interleave, the database ends up with the new value and the cache with the old one, and there is nothing to reconcile them. The cache then serves stale data until a TTL or another write happens to fix it. It looks like a trivial two-line write, but it is a structural consistency flaw, not a coding oversight.

**Q: Why can't you fix the dual write by wrapping it in a database transaction?**
A: Because a database transaction is a guarantee the database makes about *itself* — it makes a set of database operations atomic, isolated and durable within the database — and it has no reach into Redis. The cache write sits entirely outside the transaction, so if the commit succeeds and the cache write then fails, the transaction cannot and will not roll back; from the database's perspective nothing went wrong. The transaction covers one of the two systems, and the whole problem is the *gap between* the two systems, which a single-system transaction cannot close.

**Q: Why is a distributed transaction (2PC) the wrong fix for cache consistency?**
A: Two-phase commit could genuinely make the two writes atomic — a coordinator asks both systems to prepare and commits only if both agree — but it is the wrong tool for a cache by a wide margin. It is operationally heavy, it blocks (a participant that prepares and then loses the coordinator is stuck holding locks), Redis is not a natural 2PC participant, and it adds synchronous latency and reduces availability on every write. You would be degrading exactly the latency and availability the cache exists to improve, all to keep a disposable copy in sync. The sensible answer is not to make the two writes atomic but to stop doing two writes — drive invalidation from the committed log and accept eventual consistency.

**Q: What is the outbox pattern?**
A: The outbox pattern gets atomicity by writing the business change and an event record in the *same* database transaction. In one transaction you update the business row and insert a row into an `outbox` table describing the change; because they commit together, the event exists if and only if the write committed — no dual-write gap. A separate relay process then reads committed outbox rows in order, publishes them (to a broker or directly as cache invalidations), and marks them published. The dual write becomes one atomic transaction plus an asynchronous, durable, retryable relay, so the event can be delayed or duplicated but never lost.

**Q: What is Change Data Capture and how does it invalidate a cache?**
A: CDC captures every committed row change by reading the database's own replication log — the Postgres WAL or MySQL binlog — which the database already produces for replication and durability. A tool like Debezium tails that log and emits a change event per committed row change, usually onto a durable topic. A cache-invalidation consumer reads those change events and applies the corresponding delete or refill to Redis, tracking its offset so it resumes exactly on restart. Because the events come straight from the commit log, an invalidation exists precisely when a change committed, in commit order, with nothing lost — the cache becomes a follower of the log, like a read replica.

**Q: What delivery guarantee do outbox and CDC pipelines give, and why does it matter?**
A: At-least-once: an event is never lost but may be delivered more than once, typically after a relay or consumer restarts having applied an effect but not yet recorded its progress. It matters because your cache invalidation must be *idempotent* — safe to apply twice — or the duplicates cause problems. A `DEL`/`UNLINK` is naturally idempotent (deleting an absent key is a no-op), which is why the safe default is to drive *deletes* from change events rather than in-place updates. If you update the cache from events instead, you must additionally guard against duplicate and out-of-order delivery, for example by only applying a change whose version is newer than what the cache holds.

**Q: Why prefer delete over update when consuming change events?**
A: Because delete is idempotent and order-insensitive, which matches the at-least-once, possibly-out-of-order nature of these pipelines. Deleting a key that is already gone is a no-op, so a duplicate delivery is harmless, and it does not matter in what order two deletes for the same key arrive. Updating the cache in place from events reintroduces ordering hazards: two change events applied in a different order than they committed can leave the cache holding an older value, re-staling the very cache the pipeline exists to keep fresh. Delete-and-refill-on-read sidesteps all of that, at the cost of a subsequent cache miss.

**Q: (Senior) Compare the outbox pattern and CDC — when would you choose each?**
A: Both make the cache follow the committed log rather than depending on a dual write, but they differ in where the log lives and what can bypass it. The outbox keeps the event in your own database in the same transaction as the business change, so it needs no external log-reading tooling — a relay and an outbox table suffice — and it is a natural fit when your service already owns all its write paths and you want to stay within your database and message broker. Its weakness is that it can be *bypassed*: any write that changes the business data without inserting the outbox row — a batch job, an admin console, a manual SQL fix, a schema migration — emits no event, and the cache silently misses it. CDC reads the database's real WAL/binlog, which *every* committed change lands in regardless of how it was made, so it cannot be bypassed; it is the right choice when there are multiple or unknown write paths, or when you cannot guarantee every writer cooperates with an outbox. The trade is operational: CDC means running and monitoring a connector against the database log, handling snapshotting and offset management, and guarding against the connector falling behind the log's retention. My rule of thumb: outbox when the service cleanly owns its writes and you want minimal new infrastructure; CDC when correctness must not depend on every write path remembering to cooperate.

**Q: (Senior) Your CDC-based invalidation is running but the cache is still occasionally stale. How do you investigate?**
A: I trace a single stale key end to end and ask where the chain broke. First, did the write actually commit, and did it land in the WAL/binlog at a position the connector has passed? If the connector's read offset is behind that position, the answer is simply lag, and I look at why — a slow consumer, a rebalancing storm, a large transaction, or the connector paused. Second, did the connector emit an event for that table and row, or is the table not captured (a whitelist/publication misconfiguration is a classic cause of "some tables invalidate, others don't")? Third, did the consumer receive and apply it — is it stuck on a poison event and not advancing its offset, so everything behind it is starved? Fourth, is the staleness actually a *different* write path that CDC does hit but that writes a *derived* cache the consumer doesn't know to invalidate — i.e. the change event fired but the fan-out to tags/derived keys is incomplete (chapter 12). Fifth, in the nastier case, has the connector fallen so far behind that the database recycled WAL/binlog segments, forcing a gap or a re-snapshot during which changes were missed. I would instrument end-to-end lag (commit-to-invalidation) as the primary signal, alert on connector task failures and consumer lag, and keep a TTL backstop on the cache so that even when the pipeline hiccups, staleness is bounded rather than indefinite. The most common real findings are consumer lag exceeding the staleness budget and an uncaptured table or incomplete derived-key fan-out.

**Q: (Senior) How does making the cache a "follower of the log" change how you reason about consistency?**
A: It reframes the cache from an independently-written copy that might diverge into a *replica of the database's change log*, and that reframing brings the cache under the same mental model as replication, which is far easier to reason about. A dual-written cache can be *permanently* inconsistent — the gap can leave it wrong with no self-correction — so you are reasoning about arbitrary divergence. A log-following cache can only ever be *behind*, never permanently wrong, because every committed change is in the log in order and will be applied; the worst case is bounded lag, then convergence, exactly like a read replica that is catching up. That lets me state a real guarantee — "the cache is eventually consistent with a staleness window equal to the pipeline lag" — and size that lag against each data type's staleness budget (chapter 13). It also relocates the correctness question from "did every write path remember to invalidate" (a human, error-prone property) to "is the pipeline healthy and keeping up" (a mechanical, monitorable property), which is a much better place to have your consistency depend. The remaining subtleties are the delivery semantics — at-least-once means idempotent invalidations — and the fan-out to derived caches, but the core divergence problem is gone because the cache no longer has an independent, forgettable write path.

## 10. Quick Revision & Cheat Sheet

| Concept | One-liner |
|---|---|
| Dual write | Two writes to two systems, no atomic span; the gap corrupts the cache |
| Why txn fails | A DB transaction covers the DB only, not Redis |
| 2PC | Would work, but heavy/blocking — wrong tool for a cache |
| Outbox | Business row + event row in ONE transaction; relay publishes |
| CDC | Tail the WAL/binlog; every committed change becomes an event |
| Follower of the log | Cache can only lag, never permanently diverge |
| At-least-once | Never lost, maybe duplicated → invalidations must be idempotent |

| Outbox vs CDC | Pick |
|---|---|
| Service owns all write paths, minimal infra | Outbox |
| Multiple/unknown write paths, cannot be bypassed | CDC |
| Sensitive columns, must control the change feed | CDC with masking/filtering |

**Flash cards**
- **Dual-write problem?** → DB then cache, no shared transaction; a crash/race in the gap leaves them disagreeing.
- **Fix with a DB transaction?** → No — it covers the DB only, not the cache.
- **Outbox?** → Business change + event in one transaction; a relay publishes the event.
- **CDC?** → Tail the committed WAL/binlog and emit a change event per commit; cannot be bypassed.
- **Delivery guarantee?** → At-least-once → make invalidation idempotent (delete, not update).
- **Why "follower of the log"?** → The cache can only lag, never permanently diverge — like a read replica.

## 11. Hands-On Exercises & Mini Project

- [ ] Build the naive dual write (DB then `DEL`), then inject a crash/error between the two and observe the cache pinned stale with no self-correction.
- [ ] Add a TTL backstop and show the same staleness now self-heals when the TTL expires.
- [ ] Implement the outbox pattern: write the business row and an outbox row in one transaction, and a relay that publishes and marks rows published.
- [ ] Kill the relay mid-publish and restart it; confirm the event is redelivered (at-least-once) and that the idempotent `UNLINK` absorbs the duplicate.
- [ ] Stand up Debezium against a local Postgres/MySQL, write to a table, and watch change events appear; wire a consumer that `UNLINK`s the matching Redis key.
- [ ] Measure end-to-end lag (commit → cache invalidation) and relate it to the staleness window from chapter 13.

### Mini Project — "Log-Following Cache"

**Goal.** Replace a dual-write invalidation with a CDC/outbox pipeline and prove the difference: the dual write goes stale under an injected crash, while the log-following cache converges.

**Requirements.**
1. Start with a service that caches an entity and invalidates via a dual write; add a fault injector that crashes between the DB commit and the cache delete.
2. Demonstrate the dual write leaves the cache stale after a crash in the gap, with no self-correction (no TTL).
3. Implement the outbox pattern: business change and event in one transaction, plus a durable relay that publishes to a stream/broker.
4. Implement an idempotent CDC-style consumer that invalidates Redis and commits its offset only after applying the effect.
5. Re-run the fault injection and show the log-following cache converges once the pipeline catches up, and measure the end-to-end lag as the staleness window.

**Extensions.**
- Swap the outbox relay for real Debezium reading the WAL/binlog and show it captures a write made *outside* the app (a raw SQL update) that an outbox would have missed.
- Add derived-cache fan-out: map a single change event to a primary key plus its tags (chapter 12), and show one committed change invalidating a whole group idempotently.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Design: Cache Invalidation Strategies* (the invalidation mechanisms this pipeline drives), *Consistency Models: Stale Reads & Read-Your-Writes* (the staleness window the pipeline lag becomes), *Pub/Sub & Streams for Cache Invalidation* (the transport for change events), *Cache-Aside, Read-Through & Write Strategies* (the write paths CDC replaces the invalidation half of), *Replication, Sentinel & Failover* (the WAL/binlog CDC reads is the same log replication uses).

- **Debezium — Documentation** — Debezium / Red Hat · *Advanced* · the reference CDC platform: connectors, change-event format, snapshotting and offsets. <https://debezium.io/documentation/>
- **microservices.io — Transactional Outbox pattern** — Chris Richardson · *Intermediate* · the canonical write-up of the outbox pattern and its relay, with variants. <https://microservices.io/patterns/data/transactional-outbox.html>
- **Designing Data-Intensive Applications (ch. 11, stream processing & CDC)** — Martin Kleppmann · *Advanced* · why change logs are the right substrate for keeping derived data (caches, indexes) consistent. <https://dataintensive.net/>
- **Martin Kleppmann — "Turning the database inside out" & "Using logs to build a solid data infrastructure"** — Martin Kleppmann · *Advanced* · the conceptual case for logs and CDC as the backbone of derived data. <https://martin.kleppmann.com/2015/05/27/logs-for-data-infrastructure.html>
- **Confluent — The dual-write problem** — Confluent · *Intermediate* · a clear engineering explanation of the dual write and how CDC/outbox with Kafka solve it. <https://www.confluent.io/blog/dual-write-problem/>
- **PostgreSQL — Logical decoding & write-ahead log** — PostgreSQL · *Advanced* · how the WAL and logical replication that CDC connectors consume actually work. <https://www.postgresql.org/docs/current/logicaldecoding.html>
- **Redis — Streams & consumer groups** — Redis · *Advanced* · a durable, replayable transport for change events with at-least-once consumer groups. <https://redis.io/docs/latest/develop/data-types/streams/>
- **Redis University — RU202 (Redis Streams) & RU101** — Redis · *Intermediate* · free courses on streams and the data structures that carry invalidation events. <https://university.redis.com/>

---

*Caching with Redis Handbook — chapter 14.*
