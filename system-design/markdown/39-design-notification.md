# 39 · Design: Notification System

> **In one line:** A channel-agnostic fan-out engine that turns one event into millions of reliably-delivered, deduplicated, preference-respecting messages across push, SMS, and email.

---

## 1. Problem & Requirements

A **notification system** accepts events ("order shipped", "you were mentioned", "OTP 483920") from dozens of upstream services and delivers them to the right user on the right **channel** — mobile push (APNs/FCM), SMS, email, and in-app — honoring the user's preferences, quiet hours, and locale. It is the classic *many producers → one platform → many providers* problem.

**Functional**
- Accept notification requests via API and via an event stream (Kafka topics).
- Multi-channel delivery: **push** (APNs, FCM), **SMS** (Twilio/Sinch), **email** (SES/SendGrid), **in-app/WebSocket**.
- **Templates** with localization and variable interpolation; server-side rendering.
- **User preferences**: per-category, per-channel opt-in/out; **do-not-disturb** (quiet hours); frequency caps.
- **Fan-out**: one logical event → N recipients → M channels each.
- **Dedup** (idempotency) so a retried producer or double-fired event sends once.
- **Delivery status tracking**: sent → delivered → opened/clicked, surfaced back to producers.
- **Retries** with backoff, provider failover, and a **dead-letter queue** for poison messages.

**Non-functional**
- **Scale**: 500M notifications/day, peak ~50k/s (marketing blast + txnal spikes).
- **Latency**: transactional (OTP, security) p99 **< 2s** end-to-end; marketing tolerant (minutes).
- **Availability**: 99.95% for the ingestion API; delivery is best-effort but **at-least-once** with no silent drops.
- **Consistency**: eventual for status; **exactly-once *user-visible*** effect for critical classes (OTP must not double-send) — achieved via idempotency, not distributed transactions.
- **Durability**: an accepted request is never lost — persisted/committed to a log before ack.
- **Priority isolation**: an OTP must never queue behind a 10M-row marketing campaign.

## 2. Capacity Estimation

```text
ASSUMPTIONS
  Total volume         500M notifications/day
  Channel mix          push 60% | email 25% | SMS 5% | in-app 10%
  Peak factor          ~8× average (campaign + evening spike)

THROUGHPUT
  Avg/sec   = 500M / 86,400            ≈ 5,800 notif/s
  Peak/sec  = 5,800 × 8                ≈ 46,000 notif/s  (~50k/s design target)
  Push peak = 46k × 0.60               ≈ 28,000/s   -> APNs/FCM batch APIs
  Email     = 46k × 0.25               ≈ 11,500/s
  SMS       = 46k × 0.05               ≈  2,300/s   (provider TPS-capped!)

FAN-OUT AMPLIFICATION
  A "flash sale" campaign = 1 request -> 20M recipients.
  If each recipient has push+email enabled => 40M channel-sends from ONE row.
  This is why ingestion QPS != delivery QPS. Fan-out is decoupled by a queue.

STORAGE (status + audit, 90-day retention)
  Row = notif_id, user, channel, template, status, ts, provider_msg_id ≈ 300 B
  500M/day × 300 B                     ≈ 150 GB/day
  × 90 days                            ≈ 13.5 TB   -> wide-column store (Cassandra)
  Dedup keys (idempotency), 24h TTL:
  500M keys × ~60 B in Redis           ≈ 30 GB     -> fits one clustered Redis

BANDWIDTH (push egress)
  Avg push payload ~1 KB. Peak 28k/s × 1 KB ≈ 28 MB/s ≈ 224 Mbps. Trivial.
  The bottleneck is provider TPS + connection limits, NOT our bandwidth.
```

**Takeaway:** ingestion is small (~50k/s), but **fan-out amplifies 1 → tens of millions**, and third-party **provider rate limits** (SMS TPS, APNs connection count) — not CPU or bandwidth — are the true ceiling.

## 3. API Design

```http
POST /v1/notifications                      # single or fan-out request
Idempotency-Key: 8f3c-order-shipped-9921    # dedup within 24h window
{
  "recipients": ["user_123"],               # or "segment_id" for campaigns
  "category":   "order_updates",            # drives preference + priority
  "template":   "order_shipped",
  "data":       { "order_id": "A-77", "eta": "Tue" },
  "channels":   ["push","email"],           # optional; else preference-derived
  "priority":   "transactional",            # transactional | marketing
  "send_at":    null                        # null=now, or ISO ts for scheduled
}
-> 202 Accepted { "notification_id": "ntf_5a1", "status": "queued" }

GET  /v1/notifications/{id}                  # delivery status + per-channel breakdown
-> 200 { "id":"ntf_5a1","status":"delivered",
         "channels":{"push":"delivered","email":"opened"} }

POST /v1/campaigns                           # bulk: segment -> async fan-out job
GET  /v1/users/{id}/preferences              # read prefs / DND
PUT  /v1/users/{id}/preferences
{ "order_updates": {"push":true,"email":false},
  "marketing": {"push":false},
  "quiet_hours": {"start":"22:00","end":"07:00","tz":"Asia/Kolkata"} }

POST /webhooks/provider/{name}               # inbound delivery receipts (DLR)
```

Notes: ingestion returns **202** after the request is durably committed to the log — delivery is asynchronous. The `Idempotency-Key` is the dedup contract with producers.

## 4. Data Model

```text
notification_request           (source of truth, Postgres/committed log)
  id, idempotency_key(unique), producer, category, template_id,
  priority, payload(jsonb), send_at, created_at, status

delivery_attempt               (per-channel per-recipient; Cassandra, wide-column)
  PK (user_id, created_at)  CK (notification_id, channel)
  provider, provider_msg_id, status, attempt_no, error_code, updated_at
  -- partition by user for "my notifications" reads; TTL 90d

user_preference                (Postgres, cached in Redis)
  user_id, category, channel, enabled, quiet_hours, frequency_cap

device_token                   (push routing; Cassandra/Dynamo)
  user_id, platform(ios|android), token, app_version, last_seen, valid

template                       (versioned; object store + metadata DB)
  template_id, version, channel, locale, subject, body(handlebars), status

dedup_key                      (Redis, SETNX + TTL 24h)  key = idempotency_key
frequency_counter              (Redis, INCR + TTL)        key = user:category:window
```

**Datastore choices.** *Postgres* for the authoritative request row and preferences (relational, low volume, needs unique constraint for idempotency). *Cassandra* for the huge, write-heavy, TTL'd `delivery_attempt` log — partitioned by `user_id` so a user's history is one partition read, and time-ordered clustering for recency. *Redis* for the hot path: dedup, frequency counters, preference cache, and rate-limit token buckets.

## 5. High-Level Design

Producers hit the **Notification Service** (or publish to Kafka). It validates, deduplicates, resolves preferences, renders the template, and **fans out** one job per recipient×channel onto **per-channel queues**. Dedicated **channel workers** drain each queue, apply per-provider **rate limiting**, call the provider through an **abstraction layer**, and record status. Failures retry with backoff and land in a **DLQ** after exhaustion. Providers post delivery receipts back via **webhooks**, closing the status loop.

```svg
<svg viewBox="0 0 900 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>

  <!-- producers -->
  <rect x="10" y="30" width="120" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="70" y="55" text-anchor="middle" fill="#1e293b">Producer svcs</text>
  <text x="70" y="73" text-anchor="middle" fill="#64748b">API / Kafka</text>

  <!-- ingestion / notification service -->
  <rect x="180" y="20" width="170" height="150" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="265" y="42" text-anchor="middle" fill="#1e293b" font-weight="bold">Notification Svc</text>
  <text x="265" y="64" text-anchor="middle" fill="#64748b">validate</text>
  <text x="265" y="82" text-anchor="middle" fill="#64748b">dedup (Redis)</text>
  <text x="265" y="100" text-anchor="middle" fill="#64748b">prefs + DND</text>
  <text x="265" y="118" text-anchor="middle" fill="#64748b">render template</text>
  <text x="265" y="136" text-anchor="middle" fill="#64748b">fan-out</text>
  <text x="265" y="158" text-anchor="middle" fill="#64748b">priority split</text>

  <!-- per-channel queues -->
  <rect x="410" y="20" width="130" height="34" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="475" y="42" text-anchor="middle" fill="#1e293b">push queue</text>
  <rect x="410" y="66" width="130" height="34" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="475" y="88" text-anchor="middle" fill="#1e293b">SMS queue</text>
  <rect x="410" y="112" width="130" height="34" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="475" y="134" text-anchor="middle" fill="#1e293b">email queue</text>
  <rect x="410" y="158" width="130" height="34" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="475" y="180" text-anchor="middle" fill="#1e293b">in-app queue</text>

  <!-- workers -->
  <rect x="590" y="20" width="120" height="172" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="650" y="42" text-anchor="middle" fill="#1e293b" font-weight="bold">Channel</text>
  <text x="650" y="60" text-anchor="middle" fill="#1e293b" font-weight="bold">workers</text>
  <text x="650" y="82" text-anchor="middle" fill="#64748b">rate limit</text>
  <text x="650" y="100" text-anchor="middle" fill="#64748b">provider</text>
  <text x="650" y="118" text-anchor="middle" fill="#64748b">abstraction</text>
  <text x="650" y="136" text-anchor="middle" fill="#64748b">retry/backoff</text>
  <text x="650" y="158" text-anchor="middle" fill="#64748b">status write</text>

  <!-- providers -->
  <rect x="760" y="20" width="130" height="172" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="825" y="42" text-anchor="middle" fill="#1e293b" font-weight="bold">Providers</text>
  <text x="825" y="66" text-anchor="middle" fill="#64748b">APNs / FCM</text>
  <text x="825" y="88" text-anchor="middle" fill="#64748b">Twilio</text>
  <text x="825" y="110" text-anchor="middle" fill="#64748b">SES / SendGrid</text>
  <text x="825" y="132" text-anchor="middle" fill="#64748b">WebSocket GW</text>

  <!-- stores -->
  <rect x="180" y="210" width="170" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="265" y="235" text-anchor="middle" fill="#1e293b">Postgres (req, prefs)</text>
  <rect x="180" y="262" width="170" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="265" y="287" text-anchor="middle" fill="#1e293b">Redis (dedup/RL/cache)</text>
  <rect x="590" y="262" width="120" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="650" y="287" text-anchor="middle" fill="#1e293b">Cassandra (status)</text>

  <!-- DLQ -->
  <rect x="410" y="230" width="130" height="40" rx="8" fill="#fff7ed" stroke="#b91c1c"/>
  <text x="475" y="255" text-anchor="middle" fill="#b91c1c">DLQ</text>

  <!-- arrows -->
  <line x1="130" y1="60" x2="176" y2="70" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="350" y1="60" x2="406" y2="37" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="350" y1="90" x2="406" y2="83" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="350" y1="115" x2="406" y2="129" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="350" y1="140" x2="406" y2="175" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="540" y1="105" x2="586" y2="105" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="710" y1="105" x2="756" y2="105" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="265" y1="170" x2="265" y2="206" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="650" y1="192" x2="650" y2="258" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="590" y1="150" x2="540" y2="245" stroke="#b91c1c" stroke-dasharray="4 3" marker-end="url(#ah)"/>
  <!-- webhook return -->
  <line x1="760" y1="150" x2="712" y2="285" stroke="#059669" stroke-dasharray="4 3" marker-end="url(#ah)"/>
  <text x="705" y="215" text-anchor="middle" fill="#059669" font-size="11">DLR webhook</text>
</svg>
```

## 6. Deep Dive

### 6.1 Fan-out, priority isolation & per-channel queues

The **fan-out** step is where 1 request becomes millions of sends. A single "campaign" row is expanded by a **fan-out worker** that pages through the segment (never materialize 20M rows in memory — cursor through it), emitting one message per recipient×channel. Doing this inline on the API thread would blow the p99, so ingestion only writes the *request*; a separate consumer performs expansion.

The crux of correctness is **priority isolation**. Transactional traffic (OTP, password reset, fraud alert) and marketing share nothing but the platform. Use **separate physical queues** (or separate Kafka topics/partitions) per priority *and* per channel — e.g. `push.txn`, `push.mkt`. Workers on the txn queue are scaled and reserved so a 20M marketing blast can back up its own queue for minutes without adding a millisecond to an OTP. A single shared queue is the #1 mistake: head-of-line blocking turns an OTP into a 4-minute delay behind a campaign.

```svg
<svg viewBox="0 0 880 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12.5">
  <defs>
    <marker id="a2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <!-- lifelines -->
  <text x="70"  y="24" text-anchor="middle" fill="#1e293b" font-weight="bold">Producer</text>
  <text x="230" y="24" text-anchor="middle" fill="#1e293b" font-weight="bold">Notif Svc</text>
  <text x="400" y="24" text-anchor="middle" fill="#1e293b" font-weight="bold">Queue(chan)</text>
  <text x="570" y="24" text-anchor="middle" fill="#1e293b" font-weight="bold">Worker+RL</text>
  <text x="760" y="24" text-anchor="middle" fill="#1e293b" font-weight="bold">Provider</text>
  <line x1="70"  y1="32" x2="70"  y2="280" stroke="#cbd5e1"/>
  <line x1="230" y1="32" x2="230" y2="280" stroke="#cbd5e1"/>
  <line x1="400" y1="32" x2="400" y2="280" stroke="#cbd5e1"/>
  <line x1="570" y1="32" x2="570" y2="280" stroke="#cbd5e1"/>
  <line x1="760" y1="32" x2="760" y2="280" stroke="#cbd5e1"/>

  <line x1="70"  y1="55" x2="230" y2="55" stroke="#475569" marker-end="url(#a2)"/>
  <text x="150" y="49" text-anchor="middle" fill="#64748b">POST +Idempotency-Key</text>

  <text x="230" y="82" text-anchor="middle" fill="#059669" font-size="11">dedup? prefs? DND? render</text>
  <line x1="230" y1="95" x2="70" y2="95" stroke="#475569" stroke-dasharray="3 3" marker-end="url(#a2)"/>
  <text x="150" y="90" text-anchor="middle" fill="#64748b">202 queued</text>

  <line x1="230" y1="122" x2="400" y2="122" stroke="#475569" marker-end="url(#a2)"/>
  <text x="315" y="116" text-anchor="middle" fill="#64748b">enqueue job (per recipient×chan)</text>

  <line x1="400" y1="150" x2="570" y2="150" stroke="#475569" marker-end="url(#a2)"/>
  <text x="485" y="144" text-anchor="middle" fill="#64748b">worker pulls</text>
  <text x="570" y="172" text-anchor="middle" fill="#d97706" font-size="11">token-bucket wait</text>

  <line x1="570" y1="190" x2="760" y2="190" stroke="#475569" marker-end="url(#a2)"/>
  <text x="665" y="184" text-anchor="middle" fill="#64748b">send</text>
  <line x1="760" y1="212" x2="570" y2="212" stroke="#475569" stroke-dasharray="3 3" marker-end="url(#a2)"/>
  <text x="665" y="206" text-anchor="middle" fill="#64748b">accepted + msg_id</text>

  <line x1="570" y1="240" x2="400" y2="240" stroke="#b91c1c" stroke-dasharray="4 3" marker-end="url(#a2)"/>
  <text x="485" y="234" text-anchor="middle" fill="#b91c1c">5xx -> retry / DLQ</text>

  <line x1="760" y1="266" x2="230" y2="266" stroke="#059669" stroke-dasharray="4 3" marker-end="url(#a2)"/>
  <text x="495" y="261" text-anchor="middle" fill="#059669">async DLR webhook -> status=delivered</text>
</svg>
```

### 6.2 Dedup, idempotency & exactly-once *effect*

True exactly-once delivery across a network is impossible; you engineer **exactly-once user-visible effect** instead. Two dedup layers: (1) **producer idempotency** — the `Idempotency-Key` is `SETNX`'d in Redis with a 24h TTL at ingestion; a duplicate request short-circuits to the original `notification_id`. (2) **delivery idempotency** — each fan-out job carries a deterministic `dedup_id = hash(notification_id, user_id, channel)`. The channel worker `SETNX`s this before calling the provider, so a queue redelivery (at-least-once queues *will* redeliver) doesn't double-send. Because the check-then-send isn't atomic with the provider call, a crash between them can still duplicate — acceptable for most classes, and for OTP the provider's own message expiry plus a short worker-side lease covers it.

### 6.3 Rate limiting, throttling & provider abstraction

Three limits stack: **provider TPS** (Twilio ~ region-capped SMS/s; APNs connection concurrency), **per-user frequency caps** (max 5 marketing pushes/day — Redis `INCR` on `user:category:day`), and **global backpressure**. Workers gate every send through a **distributed token bucket** (Redis) keyed per provider; when a provider returns `429`/`503` the worker reads `Retry-After`, trips a **circuit breaker**, and pauses that bucket — pulling from the queue but parking messages rather than hammering a degraded provider.

The **provider abstraction** is a `ChannelProvider` interface (`send(msg) -> {status, provider_msg_id}`, `parseReceipt(webhook)`). Each concrete provider (APNs, FCM, Twilio, SES) implements it; the worker is provider-agnostic. This enables **failover** (SES down → route email to SendGrid), **canarying** a new provider by percentage, and **least-cost routing** for SMS by destination country — all config, no code change on the hot path.

### 6.4 Retries, DLQ & delivery-status tracking

Transient failures (`5xx`, timeout, `429`) retry with **exponential backoff + jitter** (e.g. 1s, 4s, 15s, 60s) up to N attempts; permanent failures (`400` bad token, unsubscribed, invalid number) do **not** retry — a `410` from APNs means the device token is dead, so mark it invalid and stop. After exhausting retries the message goes to a **dead-letter queue** for inspection/replay, never silently dropped. Status is a state machine `queued → sent → delivered → opened/clicked` (or `failed/bounced`), advanced synchronously on the send call and asynchronously by **provider webhooks** (DLRs). Hard bounces feed back into token/address invalidation to protect sender reputation.

## 7. Bottlenecks & Scaling

- **Provider TPS is the ceiling, not us.** Shard load across multiple provider accounts/regions; batch (APNs/FCM accept multicast/batch APIs — 1 call, 1000 tokens); pre-warm and pool HTTP/2 connections to APNs.
- **Fan-out explosion.** A campaign to 50M is a *job*, not a request — chunk the segment (e.g. 10k/batch), process batches in parallel, checkpoint progress so a worker crash resumes mid-campaign instead of restarting (and re-notifying).
- **Hot queues / head-of-line blocking.** Partition queues by priority and channel; autoscale worker pools on queue depth + oldest-message age, not CPU.
- **Redis hot keys.** Dedup and frequency counters can concentrate; use Redis Cluster hash-slot spreading and short TTLs to bound memory (~30GB for a day of dedup keys).
- **Status write amplification.** 40M sends → 40M Cassandra writes at peak; batch status updates, and only persist terminal transitions for non-critical classes to cut write volume.
- **Template rendering.** Cache compiled templates in-process; never hit the DB per recipient — render once per (template, locale) and interpolate per user.

## 8. Failure Scenarios

| Failure | Blast radius | Mitigation |
|---|---|---|
| Provider (APNs/Twilio) down or 5xx-ing | One channel stalls | Circuit breaker + failover to secondary provider; park in queue, don't drop |
| Queue redelivers a message | Duplicate send | `dedup_id` SETNX at worker before provider call |
| Producer double-fires event | Duplicate notification | `Idempotency-Key` SETNX at ingestion (24h TTL) |
| Marketing blast floods platform | OTP delivery delayed | Separate txn/mkt queues + reserved txn workers (priority isolation) |
| Poison message (unparseable payload) | Worker crash-loop | Bounded retries → DLQ; worker keeps draining rest |
| Stale/dead device token | Wasted sends, APNs penalty | Treat 410/invalid-token as permanent; invalidate token, stop retrying |
| Redis (dedup) unavailable | Dedup gap → possible dupes | Fail-open for non-critical, fail-closed (delay) for OTP; multi-AZ Redis |
| Webhook receiver down | Status stuck at "sent" | Providers retry DLRs; reconcile via polling status API as backstop |
| Template misrendered (bad var) | Broken messages sent | Validate + render in staging; canary campaigns to 1% first |
| Clock/timezone bug in quiet hours | Notifications at 3am | Store tz per user; compute DND in user-local time, test DST edges |

## 9. Trade-offs & Alternatives

| Decision | Option A | Option B | Choice & why |
|---|---|---|---|
| Ingestion | Sync API | Event stream (Kafka) | **Both** — API for txnal, Kafka for high-volume producers; Kafka gives durable buffer |
| Delivery semantics | Exactly-once | At-least-once + dedup | **At-least-once + idempotency** — exactly-once is a myth over networks |
| Queue-per-channel | One shared queue | Queue per channel×priority | **Per channel×priority** — isolation beats simplicity here |
| Status store | Postgres | Cassandra | **Cassandra** — write-heavy, TTL'd, partition-by-user reads |
| Fan-out | On write (precompute) | On demand (expand at send) | **On demand w/ checkpointing** — 50M precompute is wasteful & fragile |

**At 10×** (5B/day): move fan-out to a dedicated stream-processing job (Flink) reading segments; regionalize the whole stack (data-residency + provider locality); introduce a **notification budget/ranking service** to suppress low-value notifications (users churn from noise, not from missing one email); and negotiate dedicated provider throughput / run own SMTP pools for cost. The scaling problem shifts from "can we deliver" to "*should* we deliver" — relevance and frequency capping become the product.

## 10. Interview Follow-ups

**Q: How do you guarantee an OTP is never sent twice but always sent once?**
A: You can't get true exactly-once over a network. Layer defenses: idempotency key at ingestion (SETNX), deterministic `dedup_id` at the worker before the provider call, short worker lease so a redelivery within the window is suppressed, and rely on OTP expiry so a rare duplicate is harmless. Combine at-least-once delivery with dedup for exactly-once *effect*.

**Q: A marketing campaign of 20M is queued — how do you keep OTPs fast?**
A: Priority isolation. Physically separate txn and marketing queues/topics with dedicated, reserved worker pools. The campaign backs up its own queue; the txn queue stays near-empty. Never share a queue — head-of-line blocking is the failure.

**Q: How does fan-out actually work for a 50M-user segment?**
A: It's an async job, not a request. Ingestion stores the campaign row; a fan-out worker cursors the segment in chunks (e.g. 10k), emits per-recipient×channel jobs, and checkpoints offset. On crash it resumes from the checkpoint. Never materialize 50M rows in memory or precompute all sends up front.

**Q: A user has push disabled for marketing but enabled for security. How is that enforced?**
A: The preference service is consulted during fan-out, keyed by (user, category, channel). Channels not opted-in are dropped before enqueue. Category drives it: `security` overrides most caps; `marketing` respects frequency caps and DND. Preferences are cached in Redis with DB as source of truth.

**Q: Provider APNs starts returning 503. What happens?**
A: The worker's circuit breaker for that provider trips, the token bucket pauses, in-flight messages stay in the queue (not dropped), and — if a secondary is configured — traffic fails over. On recovery the breaker half-opens and probes before resuming full rate. `Retry-After` headers are honored.

**Q: How do you handle retries without amplifying load or duplicating?**
A: Exponential backoff with jitter, bounded attempts, and classify errors: retry transient (5xx/429/timeout), never retry permanent (400/410/unsubscribed). Each retry carries the same `dedup_id` so a success that we merely failed to observe isn't re-sent as a new message. Exhausted → DLQ.

**Q: How is delivery status tracked end-to-end?**
A: A state machine `queued→sent→delivered→opened`. `sent` is set on the provider ack; `delivered`/`opened`/`bounced` arrive asynchronously via provider webhooks (DLRs) keyed by `provider_msg_id`. If webhooks are unreliable we reconcile via a polling backstop. Stored in Cassandra partitioned by user.

**Q (senior): Redis holding dedup keys goes down. What's your failure posture?**
A: It's a policy decision per class. For marketing, **fail-open** — better a rare duplicate than blocked sends. For OTP/security, **fail-closed** — delay until Redis (multi-AZ, replicated) recovers, because a duplicate security code or a gap is worse than latency. Make the fail mode explicit per category, not a global default.

**Q (senior): How do you prevent notification fatigue at scale?**
A: Frequency caps (Redis counters per user/category/window), a ranking/budget service that scores notifications and suppresses low-value ones, digest batching (roll N events into one email), quiet hours, and per-category unsubscribe. At scale the constraint is user attention, not throughput — over-sending drives channel opt-outs and hurts deliverability reputation.

**Q (senior): How do you make delivery multi-region and respect data residency?**
A: Regionalize the full pipeline — ingestion, queues, workers, and status store per region — and route by user home-region. Use provider endpoints local to the region for latency and compliance (e.g. EU SMS via EU provider account). Preferences/tokens replicate with residency constraints. Idempotency keys must be region-scoped or globally coordinated to avoid cross-region dupes.

**Q (senior): Exactly-once vs at-least-once — defend your choice to a skeptic.**
A: Two-phase-commit / exactly-once transport across a third-party provider you don't control is infeasible and slow. At-least-once + idempotent effect is simpler, faster, and provably safe when the *effect* is deduplicated. The provider call is the un-transactional boundary; you make everything around it idempotent and accept a vanishingly small, harmless duplicate rate.

**Q (staff): A campaign was sent with a broken template to 5M users. How do you limit and recover?**
A: Prevent via canary — every campaign auto-sends to 1% and pauses for a health/render check before the remaining 99%. Blast radius is capped at 50k. Recovery: halt the fan-out job at its checkpoint, no rollback of sent messages (can't unsend), issue a correction only if warranted, and add a post-render validation gate. The lesson: fan-out jobs must be *pausable and staged*, never fire-and-forget.

## 11. Cheat Sheet

> [!TIP]
> **Notification System in one screen**
> - **Shape:** producers → Notification Svc (dedup, prefs, DND, render, fan-out) → per-channel×priority queues → channel workers (rate-limit, provider abstraction, retry) → APNs/FCM/Twilio/SES → status via webhooks.
> - **Scale:** ~50k/s ingest; fan-out amplifies 1 → tens of millions; **provider TPS is the real ceiling**, not bandwidth.
> - **Correctness:** at-least-once + idempotency (key at ingest, `dedup_id` at worker) = exactly-once *effect*. Never claim true exactly-once.
> - **Isolation:** separate txn vs marketing queues — reserved workers so OTP never queues behind a blast.
> - **Reliability:** backoff+jitter retries, classify permanent vs transient, circuit-breaker + provider failover, DLQ for poison — never silent drop.
> - **Preferences:** per user×category×channel, quiet hours (user-local tz), frequency caps in Redis; security overrides, marketing respects caps.
> - **Stores:** Postgres (request, prefs) · Cassandra (status, TTL, partition-by-user) · Redis (dedup, RL, cache).
> - **Fatigue:** cap, rank, digest, quiet hours — at scale the question is *should* we send, not *can* we.

**References:** ByteByteGo "Design a Notification System", Uber Engineering "Real-time notifications", APNs & FCM provider docs, DDIA ch.11 (stream processing), AWS SES/SNS docs.

---
*System Design Handbook — topic 39.*
