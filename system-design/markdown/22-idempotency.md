# 22 · Idempotency, Exactly-Once & Deduplication

> **In one line:** Since networks force you to retry and retries cause duplicates, you make operations safe to apply more than once — turning at-least-once delivery into exactly-once *effect*.

---

## 1. Overview

Every distributed call can fail *after* the work is done but *before* the caller sees the ack — a lost response, a timeout, a crash. The caller cannot tell "failed" from "succeeded-but-ack-lost," so it must **retry**. Retries mean the same request may be processed twice. If that request is "charge $50," you just double-charged.

The fix is not to eliminate retries — you can't — but to make repeated application **harmless**. An operation is **idempotent** if applying it N times has the same effect as applying it once. `SET balance=100` is idempotent; `balance += 50` is not. Where the operation isn't naturally idempotent, you attach an **idempotency key** and remember which keys you've already applied, so the second execution is a no-op that returns the first result.

This is the crux of a famous truth: **exactly-once *delivery* is impossible**, but **exactly-once *processing* (effect) is achievable** — by combining at-least-once delivery with **deduplication** and idempotent handlers. **Stripe** exposes this directly: every mutating API call takes an `Idempotency-Key` header, and a retry with the same key returns the original response instead of charging again. Kafka's "exactly-once semantics," payment systems, order services, and event pipelines all rest on the same three ideas: **idempotency keys, dedup stores, and idempotent operation design.**

Concrete example: a payment API times out. The client retries with the same idempotency key. The server sees the key already committed, skips the charge, and replays the stored `201` response — the customer is charged once, the client sees success, and the ledger stays correct.

## 2. Core Concepts

- **At-most-once** — deliver/process 0 or 1 times; no retries, so losses are possible. Fast, lossy (fire-and-forget metrics).
- **At-least-once** — retry until acked; never lost, but **duplicates** happen. The practical default.
- **Exactly-once (delivery)** — impossible over an unreliable network (the Two Generals problem); don't promise it.
- **Exactly-once processing** — achievable: at-least-once **delivery** + **idempotent** handling / dedup = each effect applied once.
- **Idempotency** — f(f(x)) = f(x); repeating the operation changes nothing after the first.
- **Idempotency key** — a client-generated unique token (UUID) identifying a *logical* request across retries.
- **Deduplication store** — a table/set recording processed keys (with the stored response) so repeats are caught.
- **Dedup window** — how long you remember keys (TTL); bounds storage but risks late-duplicate leakage.
- **Outbox pattern** — atomically write business change + an event in one DB transaction, then relay the event, so state and messaging can't diverge (dedup handles the relay's at-least-once).
- **Natural vs synthetic idempotency** — some ops are inherently idempotent (`PUT`, `DELETE`, set-absolute); others need a key + dedup to *become* idempotent.

## 3. Architecture

An idempotent write path: the client sends a stable key; the server checks a dedup store inside the same transaction as the business effect, so "record the key" and "do the work" commit together.

```svg
<svg viewBox="0 0 720 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ar" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="20" text-anchor="middle" fill="#1e293b" font-weight="700">Idempotent write with a dedup store</text>
  <rect x="20" y="120" width="110" height="44" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="75" y="140" text-anchor="middle" fill="#2563eb" font-weight="700">Client</text>
  <text x="75" y="156" text-anchor="middle" fill="#64748b">retries same key</text>
  <rect x="230" y="120" width="130" height="44" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="295" y="140" text-anchor="middle" fill="#2563eb" font-weight="700">Service</text>
  <text x="295" y="156" text-anchor="middle" fill="#64748b">handler</text>
  <!-- decision -->
  <path d="M470 142 l40 -26 l40 26 l-40 26 z" fill="#fff7ed" stroke="#d97706"/>
  <text x="510" y="140" text-anchor="middle" fill="#d97706" font-weight="700">key</text>
  <text x="510" y="154" text-anchor="middle" fill="#d97706">seen?</text>
  <!-- stores -->
  <rect x="600" y="60" width="100" height="44" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="650" y="80" text-anchor="middle" fill="#059669" font-weight="700">Dedup +</text>
  <text x="650" y="96" text-anchor="middle" fill="#059669">Business DB</text>
  <text x="650" y="122" text-anchor="middle" fill="#64748b" font-size="11">one txn:</text>
  <text x="650" y="136" text-anchor="middle" fill="#64748b" font-size="11">insert key</text>
  <text x="650" y="149" text-anchor="middle" fill="#64748b" font-size="11">+ apply effect</text>
  <!-- arrows -->
  <path d="M130 138 L228 138" stroke="#475569" marker-end="url(#ar)"/>
  <text x="180" y="130" text-anchor="middle" fill="#64748b" font-size="11">Idempotency-Key: k</text>
  <path d="M360 138 L468 142" stroke="#475569" marker-end="url(#ar)"/>
  <path d="M550 128 C580 110 585 100 600 92" stroke="#475569" marker-end="url(#ar)"/>
  <text x="560" y="210" fill="#059669" font-size="12">NEW → commit effect + store response (201)</text>
  <text x="560" y="230" fill="#d97706" font-size="12">SEEN → skip, replay stored response</text>
  <!-- return -->
  <path d="M600 96 C420 40 200 60 78 118" stroke="#475569" stroke-dasharray="4 3" marker-end="url(#ar)"/>
  <text x="330" y="52" text-anchor="middle" fill="#64748b">same response on every retry (charged once)</text>
</svg>
```

## 4. How It Works

The idempotent request lifecycle (payment example):

1. **Client mints a key.** Generate a UUID `k` for the *logical* operation ("charge order 42") and reuse it on **every** retry of that operation.
2. **Send with the key.** `POST /charges` with `Idempotency-Key: k` and the request body.
3. **Server looks up k.** In the dedup store: **NEW**, **IN-PROGRESS**, or **COMPLETED**.
4. **NEW → claim + do work.** Atomically insert `k` (state IN-PROGRESS) — an insert that fails on a unique constraint means a concurrent duplicate lost the race. Then perform the charge and, **in the same transaction**, record the result and mark COMPLETED.
5. **COMPLETED → replay.** Return the **stored** response (status + body) without re-charging. This is what makes the retry safe.
6. **IN-PROGRESS → concurrency.** A second request while the first runs: return `409`/retry-after, or block until the first commits — never run the effect twice.
7. **Body must match.** Reject (`422`) if the same key arrives with a *different* payload — the key must bind to one logical request.
8. **Expire keys.** After a TTL (Stripe: 24h) purge keys to bound storage; retries after the window are treated as new (accept the small risk or lengthen the window for money).

```text
handle(req, key):
  row = dedup.get(key)
  if row.completed: return row.stored_response      # replay
  if row.in_progress: return 409 retry-later        # concurrent dup
  BEGIN TX
    insert dedup(key, hash(req.body), IN_PROGRESS)   # unique(key) => race guard
    result = apply_effect(req)                       # the real work
    dedup.set(key, COMPLETED, response=result)
  COMMIT                                             # effect + dedup atomic
  return result
```

## 5. Key Components / Deep Dive

### Idempotency keys — scope and lifetime
The key must identify a **logical operation**, generated by the **client** (the party that retries) and stable across retries but unique across distinct operations. Scope it correctly: usually `(tenant, endpoint, key)` so keys can't collide across customers. Bind it to a **fingerprint of the request body** so a reused key with different content is rejected rather than silently returning the wrong prior result. Lifetime = the dedup window; money-critical flows keep it long (24h+), high-volume telemetry keeps it short.

### The dedup store and the atomicity requirement
The single most common bug: doing the work and recording the key in **separate** steps. If you charge then crash before recording the key, the retry charges again; if you record then crash before charging, you skip a real charge. They must be **atomic** — same DB transaction as the effect (ideal), or a carefully ordered protocol. Options: a unique-constraint row (`INSERT ... ON CONFLICT DO NOTHING`), Redis `SET key val NX EX ttl` for a fast pre-check (backed by a durable store for money), or a dedicated idempotency table storing the frozen response.

### Designing operations to be idempotent
Prefer operations that are **naturally** idempotent so you need less machinery:
- **Absolute over relative:** `SET status='paid'` not `increment`. `PUT /resource/42` (full replace) is idempotent; `POST /resource` (create) is not.
- **Client-supplied IDs:** let the client pick the primary key (`orders/{uuid}`) so a duplicate create hits a unique-key conflict instead of making a second row.
- **Conditional writes / CAS:** `UPDATE ... WHERE version=n` (optimistic concurrency) makes replays no-ops.
- **State machines:** transitions guarded by current state (`pending→paid` only once) reject repeats.
- **Upserts:** merge on key so re-applying converges.

### Dedup windows and streaming
In event pipelines you dedup on a **sequence/offset or event id** within a **window** (time or count). Kafka's exactly-once uses a **producer id + sequence number** so brokers drop duplicate produces, plus **transactions** to make "consume→process→produce" atomic (read-process-write). Flink/streaming use checkpoints + idempotent sinks. The window bounds state but a duplicate arriving after eviction slips through — size it to your max retry horizon.

### Retries + idempotency together
Retries are only safe *because* of idempotency; the two are a pair. Combine **client-side idempotency keys** with **capped exponential backoff + jitter** and **retry budgets** so a downstream blip doesn't become a self-inflicted DDoS (retry storm). The server's job is to make each retry cheap and harmless; the client's job is to retry sanely and reuse the key.

### Link to the Outbox pattern
When one action must both **change state** and **emit an event** (charge + publish "payment.succeeded"), a dual write to DB and broker can partially fail. The **outbox pattern** writes the event into an `outbox` table in the **same transaction** as the state change; a relay polls/CDCs the outbox and publishes at-least-once. Consumers **dedup by event id**. State and messaging can no longer diverge, and idempotent consumers absorb the relay's duplicates.

## 6. Trade-offs

| Approach | Pros | Cons |
|---|---|---|
| **Naturally idempotent op** (PUT/SET/CAS) | No extra store; simplest, self-healing | Not always expressible (counters, side effects) |
| **Idempotency key + dedup table** | Works for any op; stores exact replay | Extra write per request; TTL & storage mgmt |
| **Redis `SETNX` dedup** | Fast, cheap pre-check | Volatile; needs durable backing for money; TTL races |
| **Kafka EOS (pid+seq+txn)** | Broker-level dedup + atomic read-process-write | Throughput cost; scoped to Kafka; complex config |
| **Outbox + idempotent consumer** | No dual-write; state & events consistent | Relay lag; consumers must dedup; more moving parts |
| **At-most-once (no retry)** | Trivial, no dup logic | Data loss on failure |

Rule of thumb: **make it naturally idempotent if you can; add keys + a dedup store if you can't; use the outbox when state and events must stay in lockstep.** The cost is always an extra durable write and a TTL policy — cheap insurance against double-charges.

## 7. When to Use / When to Avoid

**Use idempotency when:**
- Any **mutating** operation over an unreliable network that clients will retry (payments, orders, provisioning).
- **At-least-once** queues/streams where consumers see duplicates (Kafka, SQS, webhooks).
- **Webhooks you send** (Stripe/GitHub send an event id; receivers must dedup).
- **Financial / inventory** effects where a duplicate is expensive or illegal.

**Avoid / relax when:**
- **Reads** and other naturally idempotent ops — GET needs nothing.
- **Best-effort, loss-tolerant** telemetry where a dropped or duplicated sample is harmless (at-most-once is cheaper).
- The operation is **already** idempotent by construction (absolute set, CAS) — don't add a key store for nothing.
- Ultra-low-latency paths where the dedup write is the bottleneck and duplicates are truly benign.

## 8. Scaling & Production Best Practices

- **Store the response, not just the key** — replays must return the *original* status/body byte-for-byte, or clients see inconsistent results across retries.
- **Make the dedup insert + effect one transaction**; if the store differs from the business DB, use the outbox or a two-phase claim (INSERT IN_PROGRESS → work → mark DONE) with a reaper for stuck rows.
- **Index by (tenant, key)** and add a **body fingerprint**; reject key-reuse-with-different-body (`422`).
- **TTL keys** (24h typical; longer for money) and expire in the datastore (Redis EX, or a partitioned table dropped by day) to keep the set bounded — 1M req/day @ ~200 B/key ≈ 200 MB/day.
- **Bound retries**: exponential backoff + full jitter, a max attempt count, and a **retry budget/circuit breaker** to prevent retry storms.
- **Idempotent consumers** in every stream stage; dedup by event id + windowed state; prefer idempotent sinks (upserts) over "process then ack."
- **Test the crash points** explicitly (kill between effect and dedup-commit); most double-charge bugs live exactly there.
- **Make keys mandatory** on money endpoints (Stripe rejects/deduces automatically) rather than optional.

## 9. Failure Modes & Mitigations

| Failure | Impact | Mitigation |
|---|---|---|
| Effect committed, dedup not recorded (crash between) | Retry re-applies → double charge | Single transaction for effect + dedup key |
| Dedup recorded, effect failed | Real op skipped, "success" returned | Record COMPLETED only after effect commits; IN_PROGRESS state + reaper |
| Concurrent duplicates race | Two workers apply effect | Unique constraint on key; atomic claim; 409 on in-progress |
| Key reused with different body | Wrong prior response replayed | Bind key to body fingerprint; reject mismatch (422) |
| Late duplicate after TTL eviction | Duplicate slips through | Size window ≥ max retry horizon; longer TTL for money |
| Retry storm | Self-DDoS on a downstream blip | Backoff+jitter, retry budgets, circuit breaker |
| Dedup store outage | Can't verify → block or double-apply | HA dedup store; fail-closed for money (reject) not fail-open |
| Non-idempotent side effect (email/SMS) | Duplicate external action | Idempotent provider keys, or outbox + dedup on send |

## 10. Monitoring & Metrics

- **Duplicate/replay rate** — % of requests short-circuited by the dedup store (rising = more client retries or a broken client).
- **Double-effect incidents** — reconciliation mismatches (e.g. charges vs orders); should be zero.
- **Idempotency key store size / growth** and TTL expiry rate.
- **IN_PROGRESS stuck rows** (crashed mid-op) — reaper backlog.
- **Retry counts & backoff** per client; retry-budget exhaustion / circuit-breaker trips.
- **Body-fingerprint mismatch (422)** rate — clients misusing keys.
- **Consumer lag & redelivery counts** on queues; DLQ volume.
- **Outbox relay lag** and unpublished-row age.

## 11. Common Mistakes

1. ⚠️ **Applying the effect and recording the key in separate, non-atomic steps** — the classic double-charge on retry.
2. ⚠️ **Promising exactly-once *delivery*** — it's impossible; design for exactly-once *effect* via dedup.
3. ⚠️ **Server-generated idempotency keys** — the retrying party (client) must own the key, or retries get new keys and duplicate.
4. ⚠️ **Not storing the original response** — replays return different results, confusing clients.
5. ⚠️ **Ignoring the body** — same key + different payload silently returns the wrong prior result.
6. ⚠️ **Unbounded retries with no jitter** — turning a transient error into a retry storm.
7. ⚠️ **Too-short dedup window** — late duplicates leak through after eviction.
8. ⚠️ **Assuming the queue gives exactly-once** so consumers aren't idempotent — SQS/Kafka can redeliver.

## 12. Interview Questions

**Q: Explain at-most-once vs at-least-once vs exactly-once.**
A: At-most-once: no retries, may lose messages. At-least-once: retry until acked, may duplicate. Exactly-once: each effect applied once. Over a network you get at-least-once *delivery* and must add dedup/idempotency to reach exactly-once *effect*.

**Q: Why is exactly-once delivery impossible but exactly-once processing achievable?**
A: The sender can't distinguish a lost message from a lost ack (Two Generals), so it must retry → duplicates are inevitable in delivery. But if the receiver deduplicates by id or the operation is idempotent, repeated deliveries produce a single effect — exactly-once *processing*.

**Q: What is an idempotency key and who generates it?**
A: A unique token (UUID) identifying a logical operation, generated by the **client** and reused on every retry, so the server can recognize and short-circuit duplicates.

**Q: How do you make a "charge card" endpoint idempotent?**
A: Require an Idempotency-Key. On NEW, in one transaction insert the key (unique constraint) and perform the charge, storing the response; on COMPLETED, replay the stored response without charging; on IN_PROGRESS, return 409. TTL the keys.

**Q: How does the outbox pattern relate?**
A: When you must both change state and emit an event, write the event to an outbox table in the same transaction as the state change; a relay publishes it at-least-once and consumers dedup by event id — avoiding dual-write divergence.

**Q: Which HTTP methods are naturally idempotent?**
A: GET, PUT, DELETE, HEAD (by spec); POST is not. So model "create-or-replace" as PUT with a client-chosen id when you want idempotency for free.

**Q (senior): Walk through exactly where a double-charge bug hides and how you kill it.**
A: Between applying the effect and durably recording the idempotency key. If the process crashes there, the retry sees no key and charges again. Fix: commit the effect and the key in one transaction (or use IN_PROGRESS claim + response storage). Test by injecting a crash at that point.

**Q (senior): Redis SETNX vs a database unique constraint for dedup — trade-offs?**
A: Redis is fast and cheap for a pre-check but volatile and separate from the business DB, so it can't be atomic with the effect — risky for money and prone to TTL races. A DB unique row in the same transaction as the effect gives true atomicity at higher cost. Common pattern: Redis fast-path + durable DB source of truth, fail-closed for financial ops.

**Q (senior): How does Kafka provide "exactly-once semantics"?**
A: Idempotent producers tag records with a producer id + monotonic sequence so brokers drop duplicate produces; transactions make the consume→process→produce cycle atomic (records + consumer offsets commit together), and consumers read-committed. It's exactly-once *within Kafka's* read-process-write, not a universal guarantee.

**Q (senior): How do you choose the dedup window, and what's the risk?**
A: Size it at least the maximum retry/redelivery horizon (client backoff caps, broker redelivery, webhook retry schedules). Too short and late duplicates leak through after eviction; too long and storage grows. Money flows favor long windows (24h+); high-volume telemetry favors short.

**Q (senior): Retries and idempotency together — how do you prevent a retry storm while staying correct?**
A: Keep the key stable across retries (correctness), and cap retries with exponential backoff + full jitter, a max attempt count, and a retry budget/circuit breaker (stability). The server makes each retry cheap and harmless; the client retries sanely — neither alone is sufficient.

**Q (senior): A non-idempotent external side effect (send SMS) sits inside your handler. How do you keep it once-only?**
A: Move it behind an idempotent boundary: use the provider's idempotency key if offered, or record "SMS sent for key k" in the same dedup transaction and gate the send on it, or emit via the outbox and dedup on the send worker — so a handler retry never re-sends.

## 13. Alternatives & Related

- **Message Queues** — at-least-once delivery, redelivery, DLQs (the source of duplicates).
- **CAP, Consistency & Replication** — consistency model shapes how dedup state is read.
- **Outbox / transactional messaging** — atomic state + event emission.
- **Bloom Filters** — cheap pre-filter before an exact dedup table lookup.
- **Rate Limiting** — retry budgets and backoff to prevent storms.
- **Consistent Hashing** — route a key's requests to a consistent shard for local dedup state.

## 14. Cheat Sheet

> [!TIP]
> **Idempotency & exactly-once in 8 lines**
> - Retries are inevitable (lost ack ≠ lost work) → duplicates are inevitable.
> - Exactly-once **delivery = impossible**; exactly-once **effect = achievable** (at-least-once + dedup/idempotent).
> - **Idempotency key** = client-generated UUID, stable across retries, bound to body fingerprint.
> - **Atomic rule:** record the key **in the same transaction** as the effect (else double-charge).
> - States: NEW→do+store response, COMPLETED→replay, IN_PROGRESS→409.
> - Prefer **naturally idempotent** ops: PUT/SET/CAS/upsert, client-chosen ids.
> - **TTL** keys (24h for money); size the dedup window ≥ max retry horizon.
> - Pair with **backoff+jitter+retry budgets**; use the **outbox** for state+event atomicity.

**References:** Stripe API docs (Idempotent Requests), DDIA ch.9–11 (consistency, streams, exactly-once), Kafka docs (Exactly-Once Semantics / transactions), Nygard "Release It!" (retries & circuit breakers), microservices.io (Transactional Outbox)

---
*System Design Handbook — topic 22.*
