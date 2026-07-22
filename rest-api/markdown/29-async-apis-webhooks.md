# 29 · Async APIs, Webhooks & Long-Running Jobs

> **In one line:** When work takes longer than a request should, return `202 Accepted` with a job resource the client can poll — and push the outcome back with a signed, retried, at-least-once webhook the consumer deduplicates.

---

## 1. Overview

Some operations cannot fit inside a request/response cycle. Rendering a 400-page PDF, transcoding a video, running a KYC check against a third party, generating a monthly settlement report, training a model — these take seconds to hours. Holding an HTTP connection open for them is wrong on every axis: load balancers and browsers time out at 30–120 seconds, a dropped connection loses the result with no way to recover it, connection slots are a finite resource, and the client has no way to check progress or cancel.

The HTTP answer is **`202 Accepted`**, defined in RFC 9110 §15.3.3 as "the request has been accepted for processing, but the processing has not been completed." The server enqueues the work, immediately returns `202` with a `Location` header pointing at a **job resource**, and the client polls that resource until it reaches a terminal state. The job is a first-class REST resource with its own URI, status, progress, timestamps, and — when finished — a link to the result. This turns an unbounded operation into a sequence of short, cacheable, retryable requests.

Polling works but wastes requests. The complement is a **webhook**: the server `POST`s an event to a URL the consumer registered, so the consumer learns about the outcome within milliseconds instead of one poll interval. Webhooks invert the direction of control, and that inversion brings a specific set of problems — the consumer's endpoint may be down, slow, or compromised; the network may lose the delivery; the same event may arrive twice or out of order; and anyone on the internet can `POST` to a public URL. Every serious webhook implementation therefore needs **HMAC signatures with a timestamp**, **retries with exponential backoff**, **at-least-once semantics with consumer-side deduplication**, and a **dead-letter queue** with replay.

**Concrete example.** Stripe's webhooks are the reference implementation: a `Stripe-Signature` header of the form `t=1753171200,v1=5257a869e7…`, where `v1` is `HMAC-SHA256(secret, "{t}.{raw_body}")`; a documented tolerance window of five minutes to block replays; retries with exponential backoff for up to three days; an idempotent event `id` (`evt_1P9x…`) so consumers can deduplicate; and a dashboard showing every delivery attempt with its response. GitHub (`X-Hub-Signature-256`), Shopify, Twilio, and Slack all implement the same shape with different header names. Build to this pattern and your users' existing webhook-handling code mostly just works.

The durable mental model is a **triangle**: the *submit* endpoint returns `202` + a job URI; the *job resource* is pollable and cancellable; the *webhook* pushes terminal-state notifications. Polling is the reliable floor — it always works even if webhooks are misconfigured. Webhooks are the low-latency optimization. Offer both; never offer only webhooks, because a consumer whose endpoint was down for an hour must be able to reconcile.

## 2. Core Concepts

- **`202 Accepted`** — the request was accepted but not completed; the response body and `Location` header describe where to track it.
- **Job (task) resource** — a REST resource representing one unit of async work: `id`, `status`, `progress`, `created_at`, `result_url`, `error`.
- **Terminal state** — `succeeded`, `failed`, `cancelled`, or `expired`; once reached, the job never changes again and becomes cacheable.
- **Polling interval** — how often the client re-reads the job; controlled by the server via `Retry-After` so it can adapt to load.
- **Webhook / callback** — a `POST` from the API provider to a consumer-registered URL carrying an event payload.
- **HMAC signature** — a keyed hash over the timestamp and raw body proving both authenticity and integrity of a webhook delivery.
- **Replay attack** — resending a previously captured, validly signed request; blocked by a timestamp tolerance window plus event-ID deduplication.
- **At-least-once delivery** — the guarantee that an event will arrive one or more times; consumers must be idempotent because duplicates are normal, not exceptional.
- **Dead-letter queue (DLQ)** — where deliveries land after retries are exhausted, so they can be inspected and replayed rather than lost.
- **Thundering herd on callback** — a burst of events delivered simultaneously to one consumer; controlled with per-endpoint concurrency limits and delivery pacing.
- **`Prefer: respond-async`** — RFC 7240 request header letting a client ask for async handling of an operation the server could do either way.

## 3. Theory & Principles

**Sync, async-polling, or async-callback?** Choose by expected duration and by who owns the wait.

| Duration | Pattern | Response |
|---|---|---|
| < 1 s | Synchronous | `200`/`201` with the result |
| 1–10 s | Synchronous, or async if p99 is bad | `200`, or `202` when the tail is long |
| 10 s – minutes | Async job + polling (+ webhook) | `202` + `Location: /jobs/{id}` |
| Minutes – hours | Async job + webhook, polling as fallback | `202`, notify on terminal state |
| Streaming/incremental | SSE or WebSocket (chapter 30) | `200` with an event stream |

**`202` semantics.** `202` is intentionally noncommittal: it promises only that the request was accepted, not that it will succeed. That is exactly right for queued work — validation you can do cheaply should still happen *before* the `202`, so a malformed request gets `400` synchronously and only genuinely-acceptable work is enqueued. Returning `202` and then failing on a validation error the server could have caught up front is a bad contract: the client has to poll to learn it made a typo.

**Which status code for the job resource?** Two schools. (a) `GET /jobs/{id}` returns `200` with `{"status":"running"}` throughout, then `200` with `{"status":"succeeded","result_url":"/reports/9f2"}`. (b) The job returns `303 See Other` with `Location: /reports/9f2` once complete, redirecting to the result. Option (a) is simpler and far more common; option (b) is more RESTful and is what the (now-expired) `draft-ietf-httpapi-status` proposal sketched. Whichever you pick, **include `Retry-After` on in-progress responses** so you control the client's poll rate.

**Delivery guarantees are a choice with consequences.** *At-most-once* — fire and forget, no retries; simple, and you will lose events. *At-least-once* — retry until acknowledged; the universal choice for webhooks, and it guarantees duplicates. *Exactly-once* — impossible over a network, as chapter 27 established. The practical contract is therefore: **the producer guarantees at-least-once delivery with a stable event `id`; the consumer guarantees idempotent processing.** State this explicitly in your docs, because consumers who assume exactly-once will double-ship orders.

**Ordering.** Webhooks are not ordered by default. Parallel delivery workers, retries, and network variance mean `payment.succeeded` can arrive before `payment.created`. Do not try to make delivery ordered — that requires per-consumer serialization, which turns one slow consumer into a global head-of-line block. Instead give every event a monotonic `sequence` or a `created_at` plus the resource's current `version`, and let the consumer discard events older than the state it already has. If a consumer genuinely needs ordering, offer a per-entity ordered stream as a separate, opt-in mechanism.

**Signature construction.** A signature over the body alone is replayable forever. The correct construction, following Stripe and the industry norm, is:

```
signed_payload = f"{timestamp}.{raw_request_body}"
signature      = HMAC_SHA256(webhook_secret, signed_payload)
header         = f"t={timestamp},v1={hex(signature)}"
```

Verification requires four things, all of them load-bearing: (1) recompute over the **raw bytes**, never over re-serialized JSON — key order and whitespace change the hash; (2) compare with a **constant-time** comparison (`hmac.compare_digest`) to avoid a timing oracle; (3) reject if `|now − t|` exceeds a tolerance (300 s is standard) to bound replay; (4) deduplicate on event `id`, because a replay inside the window is still possible. Support **multiple concurrent signatures** (`v1=…,v1=…`) so secrets can be rotated without downtime.

**Retry schedule.** A typical production schedule is exponential with jitter and a long tail: 10 s, 30 s, 2 m, 10 m, 1 h, 3 h, 6 h, 12 h, 24 h — roughly a dozen attempts over three days. Only retry on connection failures, timeouts, `408`, `429`, and `5xx`. A `4xx` other than `408`/`429` means the consumer rejected the payload permanently, so retrying is pure waste — dead-letter it immediately and notify the integrator.

```svg
<svg viewBox="0 0 780 366" width="100%" height="366" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="8" y="8" width="764" height="350" rx="14" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="390" y="34" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">202 Accepted: submit, poll, and push notification</text>

  <text x="80" y="62" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Client</text>
  <text x="390" y="62" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">API</text>
  <text x="690" y="62" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Worker</text>
  <path d="M80 70 L80 344" stroke="#4f46e5" stroke-width="1.5" fill="none"/>
  <path d="M390 70 L390 344" stroke="#4f46e5" stroke-width="1.5" fill="none"/>
  <path d="M690 70 L690 344" stroke="#4f46e5" stroke-width="1.5" fill="none"/>

  <path d="M80 94 L388 94" stroke="#0ea5e9" stroke-width="2" fill="none"/>
  <polygon points="388,94 380,90 380,98" fill="#0ea5e9"/>
  <text x="234" y="88" text-anchor="middle" fill="#1e293b" font-size="11">POST /v1/reports (validate cheaply first)</text>

  <path d="M390 118 L688 118" stroke="#4f46e5" stroke-width="2" fill="none"/>
  <polygon points="688,118 680,114 680,122" fill="#4f46e5"/>
  <text x="540" y="112" text-anchor="middle" fill="#1e293b" font-size="11">enqueue job jb_7c1</text>

  <path d="M388 142 L82 142" stroke="#16a34a" stroke-width="2" fill="none"/>
  <polygon points="82,142 90,138 90,146" fill="#16a34a"/>
  <text x="234" y="136" text-anchor="middle" fill="#1e293b" font-size="11">202 Accepted &#8226; Location: /v1/jobs/jb_7c1</text>

  <path d="M80 176 L388 176" stroke="#0ea5e9" stroke-width="2" stroke-dasharray="5 4" fill="none"/>
  <polygon points="388,176 380,172 380,180" fill="#0ea5e9"/>
  <text x="234" y="170" text-anchor="middle" fill="#1e293b" font-size="11">GET /v1/jobs/jb_7c1</text>
  <path d="M388 200 L82 200" stroke="#0ea5e9" stroke-width="2" stroke-dasharray="5 4" fill="none"/>
  <polygon points="82,200 90,196 90,204" fill="#0ea5e9"/>
  <text x="234" y="194" text-anchor="middle" fill="#1e293b" font-size="11">200 running, progress 0.4 &#8226; Retry-After: 5</text>

  <rect x="596" y="216" width="176" height="34" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="684" y="237" text-anchor="middle" fill="#1e293b" font-size="10">job completes, result stored</text>

  <path d="M688 268 L392 268" stroke="#16a34a" stroke-width="2" fill="none"/>
  <polygon points="392,268 400,264 400,272" fill="#16a34a"/>
  <text x="540" y="262" text-anchor="middle" fill="#1e293b" font-size="11">status = succeeded</text>

  <path d="M388 300 L82 300" stroke="#16a34a" stroke-width="2" fill="none"/>
  <polygon points="82,300 90,296 90,304" fill="#16a34a"/>
  <text x="234" y="294" text-anchor="middle" fill="#1e293b" font-size="11">webhook POST &#8226; signed &#8226; report.completed</text>

  <rect x="40" y="314" width="300" height="30" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="190" y="334" text-anchor="middle" fill="#1e293b" font-size="10">consumer: verify signature &#8594; dedupe on evt id &#8594; 200</text>
</svg>
```

## 4. Architecture & Workflow

The complete lifecycle, from submission through delivery and dead-lettering.

1. **Submit.** `POST /v1/reports` with an `Idempotency-Key` (chapter 27 — job submission is a non-idempotent `POST` and clients will retry it). Validate synchronously: schema, authorization, quota. Reject bad input with `400`/`422` *now*, not asynchronously.
2. **Enqueue.** Write the job row (`status: queued`) and the queue message **in one transaction**, or use a transactional outbox. Enqueuing outside the transaction produces ghost jobs (a message with no row) or orphans (a row nothing will ever process).
3. **Respond `202`.** Return `202 Accepted`, `Location: /v1/jobs/jb_7c1`, `Retry-After: 5`, and a body containing the job resource. `Location` on a `202` points at the *status monitor*, not at a created resource — that distinction from `201` is worth stating in an interview.
4. **Poll.** `GET /v1/jobs/jb_7c1` returns `200` with `status`, `progress`, `attempt`, and `Retry-After` while running. On success it returns `status: "succeeded"` plus `result_url`. Terminal responses are immutable, so mark them `Cache-Control: private, max-age=3600`; in-progress responses are `no-store`.
5. **Cancel.** `DELETE /v1/jobs/jb_7c1` (or `POST /v1/jobs/jb_7c1/cancel`) sets `cancellation_requested`; the worker checks it at safe points. Return `202` for a cancellation request and `409` if the job already reached a terminal state.
6. **Execute.** The worker leases the message with a visibility timeout, heartbeats progress, and writes the result. It must be idempotent, because a lease expiring mid-execution means the message is redelivered — the same at-least-once problem, one layer down.
7. **Emit the event.** On a terminal state, write an event row (`evt_…`, type, payload, `created_at`, `sequence`) in the same transaction as the job update. This is the outbox: the event exists as durable state before any delivery attempt.
8. **Deliver.** A dispatcher reads undelivered events, looks up the consumer's registered endpoints for that event type, signs the payload, and `POST`s it with a short timeout (5–10 s — do not let a slow consumer occupy a worker).
9. **Interpret the response.** `2xx` means delivered. `410 Gone` means the endpoint is permanently dead — disable it and email the integrator. `429`/`5xx`/timeout means retry with backoff. Any other `4xx` means the consumer rejected it permanently — dead-letter immediately.
10. **Retry, dead-letter, reconcile.** Retry on the schedule from section 3; after exhaustion move to the DLQ and expose `POST /v1/webhook_deliveries/{id}/replay` plus a list endpoint so integrators self-serve recovery. Because webhooks can be missed entirely, also expose `GET /v1/events?after=evt_…&types=report.completed` — that reconciliation endpoint is what makes webhooks safe to depend on.

> **Note:** Steps 2 and 7 are the two transactional boundaries that decide whether your system loses events. Everything else is retry policy.

```svg
<svg viewBox="0 0 780 384" width="100%" height="384" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="8" y="8" width="764" height="368" rx="14" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="390" y="34" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Webhook delivery pipeline with signing, retries and DLQ</text>

  <rect x="26" y="56" width="140" height="62" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="96" y="80" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Job worker</text>
  <text x="96" y="99" text-anchor="middle" fill="#1e293b" font-size="10">terminal state reached</text>

  <rect x="200" y="56" width="160" height="62" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="280" y="80" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Outbox (events)</text>
  <text x="280" y="99" text-anchor="middle" fill="#1e293b" font-size="10">written in the same txn</text>

  <rect x="394" y="56" width="170" height="62" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="479" y="76" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Dispatcher</text>
  <text x="479" y="94" text-anchor="middle" fill="#1e293b" font-size="10">t = now, sign body</text>
  <text x="479" y="110" text-anchor="middle" fill="#1e293b" font-size="10">HMAC-SHA256(secret, t.body)</text>

  <rect x="598" y="56" width="150" height="62" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="673" y="80" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Consumer</text>
  <text x="673" y="99" text-anchor="middle" fill="#1e293b" font-size="10">POST, 10 s timeout</text>

  <path d="M166 87 L198 87" stroke="#4f46e5" stroke-width="2" fill="none"/>
  <polygon points="198,87 190,83 190,91" fill="#4f46e5"/>
  <path d="M360 87 L392 87" stroke="#4f46e5" stroke-width="2" fill="none"/>
  <polygon points="392,87 384,83 384,91" fill="#4f46e5"/>
  <path d="M564 87 L596 87" stroke="#4f46e5" stroke-width="2" fill="none"/>
  <polygon points="596,87 588,83 588,91" fill="#4f46e5"/>

  <path d="M673 118 L673 150" stroke="#0ea5e9" stroke-width="2" fill="none"/>
  <polygon points="673,150 669,142 677,142" fill="#0ea5e9"/>

  <rect x="556" y="150" width="192" height="66" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="652" y="170" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">Consumer checks</text>
  <text x="652" y="188" text-anchor="middle" fill="#1e293b" font-size="10">1. |now &#8722; t| &lt; 300 s</text>
  <text x="652" y="204" text-anchor="middle" fill="#1e293b" font-size="10">2. constant-time HMAC compare</text>

  <path d="M652 216 L652 244" stroke="#16a34a" stroke-width="2" fill="none"/>
  <polygon points="652,244 648,236 656,236" fill="#16a34a"/>
  <rect x="556" y="244" width="192" height="58" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="652" y="264" text-anchor="middle" fill="#1e293b" font-size="10">3. dedupe on event id</text>
  <text x="652" y="282" text-anchor="middle" fill="#1e293b" font-size="10">4. enqueue, then return 200 fast</text>

  <rect x="26" y="150" width="500" height="66" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="42" y="172" fill="#1e293b" font-size="12" font-weight="700">Retry policy (only on timeout, 408, 429, 5xx)</text>
  <text x="42" y="192" fill="#1e293b" font-size="11">10 s &#8594; 30 s &#8594; 2 m &#8594; 10 m &#8594; 1 h &#8594; 3 h &#8594; 6 h &#8594; 12 h &#8594; 24 h, jittered</text>
  <text x="42" y="209" fill="#1e293b" font-size="11">410 Gone &#8594; disable endpoint &#8226; other 4xx &#8594; dead-letter immediately</text>

  <rect x="26" y="240" width="240" height="62" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="146" y="262" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Dead-letter queue</text>
  <text x="146" y="281" text-anchor="middle" fill="#1e293b" font-size="10">inspectable + replayable</text>

  <rect x="286" y="240" width="240" height="62" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="406" y="262" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Reconciliation API</text>
  <text x="406" y="281" text-anchor="middle" fill="#1e293b" font-size="10">GET /v1/events?after=evt_...</text>

  <text x="30" y="332" fill="#1e293b" font-size="11" font-weight="700">Producer guarantees at-least-once delivery with a stable event id.</text>
  <text x="30" y="352" fill="#1e293b" font-size="11" font-weight="700">Consumer guarantees idempotent processing. Together: effectively-once.</text>
  <text x="30" y="368" fill="#1e293b" font-size="10">Polling is the reliable floor; webhooks are the latency optimization. Ship both.</text>
</svg>
```

## 5. Implementation

### Submit and poll

```http
POST /v1/reports HTTP/1.1
Host: api.zariya.in
Idempotency-Key: 8c1f0b6d-1a33-4d0a-9e21-3f2a9c1e7b44
Content-Type: application/json

{"type":"settlement","period":"2026-06","format":"pdf"}

HTTP/1.1 202 Accepted
Location: /v1/jobs/jb_7c1Qx9
Retry-After: 5

{"id":"jb_7c1Qx9","status":"queued","progress":0,"created_at":"2026-07-22T09:40:00Z",
 "links":{"self":"/v1/jobs/jb_7c1Qx9","cancel":"/v1/jobs/jb_7c1Qx9"}}
```

```http
GET /v1/jobs/jb_7c1Qx9 HTTP/1.1

HTTP/1.1 200 OK
Retry-After: 5
Cache-Control: no-store

{"id":"jb_7c1Qx9","status":"running","progress":0.42,"attempt":1,
 "started_at":"2026-07-22T09:40:03Z","estimated_completion":"2026-07-22T09:41:10Z"}
```

Terminal responses are immutable, so they are cacheable; failures carry an RFC 9457 problem document inline.

```http
HTTP/1.1 200 OK
Cache-Control: private, max-age=3600

{"id":"jb_7c1Qx9","status":"succeeded","progress":1,"completed_at":"2026-07-22T09:41:07Z",
 "result":{"url":"/v1/reports/rpt_5f2","expires_at":"2026-07-29T09:41:07Z"}}

{"id":"jb_7c1Qx9","status":"failed","attempt":3,
 "error":{"type":"https://api.zariya.in/problems/upstream-timeout","status":504,
          "title":"Ledger service did not respond","retryable":true}}
```

### The webhook delivery

```http
POST /hooks/zariya HTTP/1.1
Host: acme.example.com
Content-Type: application/json
User-Agent: Zariya-Webhooks/1.0
Zariya-Signature: t=1753177267,v1=5257a869e7ecebe3a1b6d2c48f0a3e9f11d0c7a4b8e5f2c1d9a0b3e6c7f8a1b2
Zariya-Event-Id: evt_9f2c41b7
Zariya-Event-Type: report.completed
Zariya-Delivery-Attempt: 1

{"id":"evt_9f2c41b7","type":"report.completed","created_at":"2026-07-22T09:41:07Z",
 "sequence":184402,
 "data":{"job_id":"jb_7c1Qx9","report_id":"rpt_5f2","period":"2026-06"}}
```

### Signature verification — Python (FastAPI)

This is the code every integrator copies. The four rules from section 3 are all visible.

```python
import hmac, hashlib, time
from fastapi import APIRouter, Request, HTTPException

router = APIRouter()
TOLERANCE_S = 300          # 5 minutes, the industry standard


def verify_signature(raw_body: bytes, header: str, secrets: list[str]) -> None:
    """Raise unless `header` is a valid, fresh signature over `raw_body`."""
    pairs = [p.split("=", 1) for p in header.split(",") if "=" in p]
    try:
        timestamp = int(next(v for k, v in pairs if k == "t"))
    except (ValueError, StopIteration):
        raise HTTPException(400, "Malformed signature header")

    # 1. Timestamp tolerance bounds the replay window.
    if abs(time.time() - timestamp) > TOLERANCE_S:
        raise HTTPException(400, "Signature timestamp outside tolerance")

    # 2. Sign the RAW bytes, never a re-serialized dict.
    signed_payload = f"{timestamp}.".encode() + raw_body

    # 3. Accept any configured secret so rotation needs no downtime, and
    #    compare in constant time to avoid a timing oracle.
    candidates = [v for k, v in pairs if k == "v1"]
    for secret in secrets:
        expected = hmac.new(secret.encode(), signed_payload, hashlib.sha256).hexdigest()
        if any(hmac.compare_digest(expected, got) for got in candidates):
            return
    raise HTTPException(401, "Signature verification failed")


@router.post("/hooks/zariya", status_code=200)
async def receive_webhook(request: Request, db=None, queue=None):
    raw = await request.body()                       # RAW bytes, before parsing
    verify_signature(raw, request.headers.get("Zariya-Signature", ""),
                     secrets=[CURRENT_SECRET, PREVIOUS_SECRET])

    event = json.loads(raw)

    # 4. Deduplicate: delivery is at-least-once, so duplicates are normal.
    inserted = await db.execute(
        "INSERT INTO processed_events (id, type, received_at) VALUES ($1,$2,now()) "
        "ON CONFLICT (id) DO NOTHING RETURNING id", event["id"], event["type"])
    if inserted is None:
        return {"status": "duplicate_ignored"}       # 200 — do NOT make it retry

    # 5. Acknowledge fast; do the real work off the request path.
    await queue.enqueue("handle_webhook", event)
    return {"status": "accepted"}
```

### Signature verification — Node

```javascript
import crypto from "node:crypto";
// express.raw is mandatory: JSON.parse + re-stringify changes the bytes and the hash.
app.post("/hooks/zariya", express.raw({ type: "application/json" }), async (req, res) => {
  const parts = Object.fromEntries((req.get("Zariya-Signature") ?? "")
    .split(",").map(p => p.split("=")));
  const ts = Number(parts.t);
  if (!ts || Math.abs(Date.now() / 1000 - ts) > 300)
    return res.status(400).send("stale or missing timestamp");

  const expected = crypto.createHmac("sha256", process.env.WEBHOOK_SECRET)
    .update(`${ts}.`).update(req.body).digest("hex");
  const got = Buffer.from(parts.v1 ?? "", "hex"), exp = Buffer.from(expected, "hex");
  if (got.length !== exp.length || !crypto.timingSafeEqual(got, exp))
    return res.status(401).send("bad signature");

  const event = JSON.parse(req.body.toString("utf8"));
  if (await alreadyProcessed(event.id)) return res.status(200).send("duplicate");
  await enqueue(event);            // acknowledge within milliseconds
  res.status(200).send("ok");
});
```

### The dispatcher side

```python
RETRY_SCHEDULE_S = [10, 30, 120, 600, 3600, 10800, 21600, 43200, 86400]
RETRYABLE = {408, 429, 500, 502, 503, 504}


async def deliver(event: dict, endpoint: dict, attempt: int = 0) -> None:
    body = json.dumps(event, separators=(",", ":")).encode()
    ts = int(time.time())
    sig = hmac.new(endpoint["secret"].encode(),
                   f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
    try:
        r = await http.post(endpoint["url"], content=body, timeout=10.0, headers={
            "Content-Type": "application/json",
            "Zariya-Signature": f"t={ts},v1={sig}",
            "Zariya-Event-Id": event["id"], "Zariya-Event-Type": event["type"],
            "Zariya-Delivery-Attempt": str(attempt + 1)})
        status = r.status_code
    except (TimeoutError, ConnectionError):
        status = 0
    if 200 <= status < 300:
        return
    if status == 410:                                    # permanently gone
        return await disable_endpoint(endpoint["id"], reason="410 Gone")
    if (status not in RETRYABLE and status != 0) or attempt + 1 >= len(RETRY_SCHEDULE_S):
        return await dead_letter(event, endpoint, reason=f"permanent {status}")
    delay = RETRY_SCHEDULE_S[attempt] * (0.75 + random.random() * 0.5)   # jitter
    await schedule_retry(event, endpoint, attempt + 1, delay)
```

### Optimization note

Three things dominate webhook system cost. **Delivery concurrency** — a single slow consumer must not starve the pool, so partition workers by endpoint and cap per-endpoint in-flight deliveries (a global pool plus one slow integrator equals a full outage for everyone). **Payload size** — send a *thin* event (`id`, `type`, resource id) and let the consumer fetch the full object, which keeps deliveries small, avoids stale-payload confusion, and removes the need to re-sign when the resource changes; send fat events only when consumers demand them. **Poll pressure** — `Retry-After` is your throttle, so raise it under load and set it proportional to the job's remaining estimated time rather than a fixed 5 seconds; terminal job responses should be cached for an hour since they are immutable, which removes the tail of clients that keep polling completed jobs.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost/Trade-off |
|---|---|---|
| `202` + job resource | No long-held connections; progress, cancellation, and retry become possible | Two-step protocol; clients must implement polling |
| Polling | Dead simple, works through any firewall, always recoverable | Wasted requests; latency bounded by the poll interval |
| Webhooks | Near-real-time, no wasted polls, scales to many consumers | Consumer must expose a public endpoint; you own retries, signing, and a DLQ |
| At-least-once delivery | No lost events even across consumer outages | Duplicates are guaranteed, so consumers must be idempotent |
| HMAC signatures | Authenticity and integrity with a shared secret; simple to implement | Secret distribution and rotation; consumers frequently verify incorrectly |
| Thin vs fat payloads | Thin stays small, never stale, needs no re-signing | Fat saves the consumer a round trip but can arrive stale and leaks more if the endpoint is compromised |
| DLQ + replay | Integrators self-serve recovery instead of filing support tickets | More surface to build, secure, and rate-limit |
| Reconciliation endpoint | Makes webhooks safe to depend on after an outage | Another paginated, indexed, retained event log to operate |

## 7. Common Mistakes & Best Practices

1. ⚠️ Parsing the JSON body and re-serializing it before verifying the signature → ✅ always compute the HMAC over the **raw bytes**; key ordering and whitespace change the hash and every verification will fail.
2. ⚠️ Comparing signatures with `==` → ✅ use `hmac.compare_digest` / `crypto.timingSafeEqual`; a non-constant-time comparison is a timing oracle that leaks the expected signature byte by byte.
3. ⚠️ Signing only the body with no timestamp → ✅ sign `"{t}.{body}"` and reject deliveries outside a ±300 s window, or a captured valid request is replayable forever.
4. ⚠️ Assuming webhooks arrive exactly once and in order → ✅ delivery is at-least-once and unordered; deduplicate on the event `id` and discard events older than the state you already hold.
5. ⚠️ Doing the real work inside the webhook handler → ✅ verify, deduplicate, enqueue, and return `200` within milliseconds; a slow handler causes producer timeouts, which cause retries, which cause duplicate work.
6. ⚠️ Returning `500` for a duplicate event → ✅ a duplicate is a success from the producer's point of view; return `200` or the producer will retry forever.
7. ⚠️ Returning `202` before validating the request → ✅ do cheap validation synchronously so a typo yields `400` immediately instead of a job the client must poll to discover has failed.
8. ⚠️ Enqueuing the job outside the database transaction that created it → ✅ use a transactional outbox; otherwise you get queue messages with no job row, or job rows nothing will ever process.
9. ⚠️ Retrying every non-`2xx` response forever → ✅ retry only timeouts, `408`, `429`, and `5xx`; disable on `410 Gone` and dead-letter other `4xx` immediately, then tell the integrator.
10. ⚠️ Offering webhooks with no way to catch up after an outage → ✅ ship a paginated `GET /v1/events?after=…` reconciliation endpoint and a delivery-replay API; without one, a two-hour consumer outage becomes permanent data loss.
11. ⚠️ Letting consumers register any URL → ✅ SSRF-guard registrations: HTTPS only, block private and link-local ranges (`10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`), resolve DNS at delivery time and re-check the resolved IP, and disable redirect following.
12. ⚠️ A single global delivery worker pool → ✅ partition by endpoint with per-endpoint concurrency caps, or one slow integrator will consume the whole pool and delay every other customer's events.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Persist every delivery attempt — timestamp, endpoint, attempt number, request headers, response status, response body (truncated), and duration — and expose it to integrators in a dashboard and via `GET /v1/webhook_deliveries?event_id=…`. This single feature eliminates the majority of webhook support tickets, because "we never got it" becomes a question you can answer with evidence in ten seconds. Ship a **signature-verification test tool** and a `POST /v1/webhook_endpoints/{id}/test` that sends a synthetic event, since the most common integration failure by a wide margin is a consumer that verifies against re-serialized JSON. Propagate a trace ID from the original submission through the job, the event, and the delivery so one request ID ties the whole chain together. For "the job is stuck," check queue depth, worker lease expiry, and whether the job's heartbeat is advancing — a job in `running` with a stale heartbeat means a worker died holding the lease.

**Monitoring.** Job-side: **queue depth** and **oldest-message age** (the real saturation signal — depth alone is misleading), **job duration percentiles by type**, **failure rate**, and **retry count distribution**. Delivery-side: **delivery success rate per endpoint** (alert per customer, not globally, because one broken integrator should not page you but should email them), **p50/p99 delivery latency from event creation to first `2xx`**, **attempts-per-successful-delivery**, **DLQ depth and growth rate**, and **consumer response time**, since consumers doing work inline are the leading cause of retry storms. Track **signature-verification failures** per endpoint too: a sudden spike right after you rotate a secret means the rotation did not propagate.

**Security.** The dispatcher makes outbound HTTP to attacker-supplied URLs, which is a textbook **SSRF** primitive — enforce HTTPS, block private/loopback/link-local/metadata ranges (including `169.254.169.254`), re-validate the resolved IP at connection time to defeat DNS rebinding, refuse to follow redirects, and consider egressing through a dedicated proxy with an allowlist. Generate a **per-endpoint secret** of at least 32 random bytes, show it once, and support two active secrets so rotation is zero-downtime. Send **thin payloads** so a compromised endpoint leaks identifiers rather than PII. Rate-limit the replay API, since it is an amplification vector. On the consumer side, the endpoint is unauthenticated by definition, so the signature *is* the authentication — reject unsigned requests outright, and never trust `Zariya-Event-Type` before verifying. Finally, cap request body size on the consumer endpoint to avoid a memory-exhaustion path.

**Performance & scaling.** Partition delivery workers by endpoint so head-of-line blocking is contained to one consumer. Use a **circuit breaker per endpoint**: after N consecutive failures, back off aggressively and probe occasionally instead of hammering a dead host. Batch where consumers allow it (`{"events":[…]}` with a documented max), which cuts connection overhead dramatically for high-volume integrations. For jobs, autoscale workers on oldest-message age rather than CPU, keep result artifacts in object storage with pre-signed expiring URLs rather than streaming through the API, and expire job records on a schedule (30–90 days) so the jobs table does not become your largest. Under overload, shed by extending `Retry-After` and returning `429` to pollers before you start dropping deliveries.

## 9. Interview Questions

**Q: When do you return `202 Accepted` instead of `201 Created`?**
A: `201` means the resource now exists and `Location` points at it. `202` means the request was accepted for processing that has not completed, and `Location` points at a *status monitor* — a job resource — not at the eventual result. Use `202` whenever the work outlives a sensible request timeout, typically anything over about ten seconds.

**Q: How does a client learn that an async job finished?**
A: Two mechanisms, and a good API offers both. Polling: `GET` the job URI returned in `Location` until `status` is terminal, pacing requests using the `Retry-After` header the server sends. Webhooks: the server `POST`s an event to a URL the consumer registered, giving near-real-time notification. Polling is the reliable floor because it works even when webhooks are misconfigured or the consumer was down.

**Q: Why must a webhook signature include a timestamp?**
A: Without one, a captured valid request stays valid forever, so an attacker who observes a single delivery can replay it indefinitely. Signing `"{timestamp}.{raw_body}"` and rejecting deliveries whose timestamp is outside a tolerance window — five minutes is standard — bounds the replay window, and deduplicating on the event ID closes what remains.

**Q: Why verify the signature against the raw request body?**
A: The HMAC is computed over exact bytes. If you parse JSON and re-serialize it, key order, whitespace, number formatting, and Unicode escaping can all change, producing a different hash and a failed verification even though the payload is authentic. Frameworks that eagerly parse bodies must be configured to retain the raw bytes.

**Q: What delivery guarantee do webhooks provide, and what does that require of the consumer?**
A: At-least-once. Retries after timeouts mean the same event can arrive multiple times, and network partitions mean it can arrive out of order relative to other events. The consumer must therefore deduplicate on the event `id` and process idempotently; treating a duplicate as an error and returning `5xx` causes the producer to retry forever.

**Q: What should a webhook consumer do inside the handler?**
A: Verify the signature, check the event ID against a processed-events table, enqueue the event for background processing, and return `200` — all within milliseconds. Doing real work inline causes the producer to time out, which triggers a retry, which causes the same work to run twice; fast acknowledgement is what keeps the whole system stable.

**Q: How do you handle a consumer endpoint that has been down for two hours?**
A: Retries with exponential backoff cover short outages, and after exhaustion the events land in a dead-letter queue that the integrator can inspect and replay. For anything longer you need a reconciliation endpoint — `GET /v1/events?after=evt_…` — so a consumer can enumerate everything it missed. Without that endpoint, a long outage becomes permanent data loss for that integrator.

**Q: (Senior) Design the delivery system for 10,000 endpoints and 50,000 events per minute. What breaks first?**
A: The first thing to break is a shared worker pool: one consumer with a 10-second response time occupies workers and delays everyone else's events, so partition by endpoint (consistent hashing onto worker shards) with per-endpoint concurrency caps and a per-endpoint circuit breaker. Second is the outbox scan — use a partitioned, indexed `undelivered` table or a real queue rather than polling a growing table. Third is retry storms after a broad outage, which need jitter plus a global delivery-rate limiter so recovery does not become a self-inflicted DDoS. Fourth is the delivery-attempt log, which at this rate is your highest-volume table and belongs in time-partitioned storage with a retention policy.

**Q: (Senior) How do you guarantee an event is never lost between the job completing and the delivery being attempted?**
A: Write the event row in the *same database transaction* as the job's terminal-state update — the transactional outbox pattern — so the event's existence is as durable as the state change it describes. A separate dispatcher then reads undelivered events and attempts delivery, marking progress independently. Emitting the event by calling a queue inside the transaction is unsafe, because the queue write can succeed while the transaction rolls back, or vice versa.

**Q: (Senior) A consumer complains about duplicate processing despite deduplicating on event ID. What is happening?**
A: Almost always the deduplication check and the side effect are not atomic: two concurrent deliveries both find no row, both proceed, and both insert. The fix is a single atomic `INSERT … ON CONFLICT DO NOTHING` on the event ID whose success is the right to process, ideally in the same transaction as the side effect. Other candidates are a dedup table with a TTL shorter than the producer's retry horizon (three days for Stripe-style schedules), or a consumer processing at-least-once queue redeliveries downstream of the webhook without its own idempotency.

**Q: (Senior) Thin or fat webhook payloads?**
A: Thin by default — send `id`, `type`, and the affected resource's identifier, and let the consumer `GET` the current state. That keeps deliveries small, avoids the stale-payload problem where a retried event describes a state that has since changed, limits what leaks if an endpoint is compromised, and means you never re-sign because a resource changed. The cost is an extra round trip and read load on your API, so offer fat payloads as an opt-in for high-volume consumers who have measured that cost and want it gone.

**Q: How would you let a client cancel a long-running job?**
A: Model cancellation as a request rather than an instruction: `DELETE /v1/jobs/{id}` or `POST /v1/jobs/{id}/cancel` sets a `cancellation_requested` flag and returns `202`, because the worker may be mid-step and can only honour it at a safe checkpoint. The job then transitions to `cancelled` when the worker observes the flag, and a cancellation request against a job that already reached a terminal state returns `409 Conflict`.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Work that outlives a request returns `202 Accepted` with `Location` pointing at a job resource and a `Retry-After` hint; the client polls until a terminal state and then follows `result_url`. Validate cheaply *before* the `202`. Write the job row and the queue message in one transaction, and write the completion event in the same transaction as the job's terminal update — that outbox is what stops events being lost. Deliver events as signed webhooks: `t={unix},v1={HMAC-SHA256(secret, "t.rawbody")}`, verified against raw bytes with a constant-time comparison and a ±300 s tolerance, with dual secrets for rotation. Delivery is at-least-once and unordered, so consumers deduplicate on event `id`, enqueue, and return `200` in milliseconds. Retry only on timeouts, `408`, `429`, and `5xx` on a jittered schedule out to ~3 days; disable on `410`; dead-letter other `4xx` at once. Ship a replay API and a `GET /v1/events?after=` reconciliation endpoint, guard the dispatcher against SSRF, and partition delivery workers per endpoint.

| Item | Value |
|---|---|
| Submit response | `202 Accepted` + `Location: /v1/jobs/{id}` + `Retry-After` |
| Job in progress | `200` `{"status":"running","progress":0.42}`, `Cache-Control: no-store` |
| Job terminal | `200` with `succeeded`/`failed`/`cancelled`, cacheable for an hour |
| Cancel | `DELETE /v1/jobs/{id}` → `202`; `409` if already terminal |
| Signature header | `t=1753177267,v1=<hex hmac-sha256>` |
| Signed payload | `f"{t}." + raw_body` — raw bytes, never re-serialized |
| Tolerance window | ±300 seconds |
| Comparison | `hmac.compare_digest` / `crypto.timingSafeEqual` |
| Consumer success | Any `2xx`, returned fast; duplicates also return `2xx` |
| Retryable / permanent | timeout, `408`, `429`, `5xx` / `410` disables, other `4xx` dead-letters |
| Retry schedule | 10 s, 30 s, 2 m, 10 m, 1 h, 3 h, 6 h, 12 h, 24 h (jittered) |
| Reconciliation | `GET /v1/events?after=evt_…&types=…` |

**Flash cards**

- **`202` vs `201`** → `201`'s `Location` points at the created resource; `202`'s points at a status monitor for work not yet done.
- **Correct signed payload** → `HMAC-SHA256(secret, f"{timestamp}.{raw_body}")`, compared in constant time within a ±300 s window.
- **Webhook delivery guarantee** → At-least-once and unordered; the consumer must deduplicate on event `id`.
- **What belongs in a webhook handler** → Verify, dedupe, enqueue, return `200`. Nothing slow.
- **Why a reconciliation endpoint** → Retries and DLQs cover minutes to days; only `GET /events?after=` lets a consumer recover from a longer outage.

## 11. Hands-On Exercises & Mini Project

- [ ] Convert a slow synchronous endpoint to `202` + job resource, including `Retry-After` on in-progress polls and an hour of caching on terminal responses.
- [ ] Implement HMAC signing on the producer and verification on the consumer, then write tests that reject a tampered body, a stale timestamp, and a signature compared non-constant-time (assert you use `compare_digest`).
- [ ] Deliberately verify against `json.dumps(json.loads(body))` instead of the raw bytes and observe the verification fail. This is the single most common integration bug — feel it once.
- [ ] Build a consumer that deduplicates with `INSERT … ON CONFLICT DO NOTHING`, then fire the same event 20 times concurrently and assert the side effect happened exactly once.
- [ ] Implement the retry schedule with jitter and a DLQ, take the consumer down for ten minutes, and verify every event eventually arrives or is dead-lettered with a readable reason.

### Mini Project — A production-shaped async report API

**Goal.** Build report generation end to end: submit, poll, cancel, webhook delivery, DLQ, replay, and reconciliation.

**Requirements.**
1. `POST /v1/reports` validates synchronously, requires `Idempotency-Key`, and returns `202` + `Location` + `Retry-After`. Job row and queue message must be written in one transaction.
2. `GET /v1/jobs/{id}` returns status, progress, attempt count, and either `result_url` or an RFC 9457 error; `DELETE /v1/jobs/{id}` requests cancellation and returns `409` if terminal.
3. Emit `report.completed` / `report.failed` events into an outbox table written in the same transaction as the job's terminal update.
4. Dispatcher signs with `t=…,v1=…`, supports two active secrets, uses a 10 s timeout, and honours the full retry schedule with jitter, per-endpoint concurrency caps, and a circuit breaker.
5. `410` disables the endpoint; other `4xx` dead-letters immediately. Expose `GET /v1/webhook_deliveries` and `POST /v1/webhook_deliveries/{id}/replay`.
6. Expose `GET /v1/events?after=evt_…` with cursor pagination for reconciliation, SSRF-guard endpoint registration (HTTPS only, private ranges blocked, no redirects), and ship a sample consumer in a different language that verifies, deduplicates, enqueues, and returns `200` in under 50 ms.

**Extensions.**
- Add batched delivery (`{"events":[…]}`, max 100) and measure the throughput difference against per-event delivery.
- Add a Server-Sent Events channel (chapter 30) so a browser can watch job progress without polling.
- Chaos test: 20% delivery failures plus a consumer down for 30 minutes, then prove via the reconciliation endpoint that no event was lost.

## 12. Related Topics & Free Learning Resources

**Related chapters.** *Idempotency Keys & Safe Retries* (chapter 27) — job submission needs a key, and webhook consumers need the same deduplication logic. *Streaming: SSE, WebSockets & Chunked Responses* (chapter 30) — the alternative when the client wants continuous updates rather than a terminal notification. *Concurrency Control* (chapter 28) — how a webhook's `version` field lets consumers discard out-of-order events. *Error Handling & Problem Details* — job failures should carry RFC 9457 documents. *API Security* — SSRF, secret rotation, and signature verification.

- **RFC 9110 §15.3.3 — 202 Accepted** — IETF · *Beginner* · the normative definition, including the crucial point that the response should indicate where to monitor the request's status. <https://www.rfc-editor.org/rfc/rfc9110.html#name-202-accepted>
- **Stripe Docs — Webhooks & Signature Verification** — Stripe · *Intermediate* · the de facto reference for signature format, tolerance windows, retry behaviour, and consumer best practices; read the "verify signatures" section closely. <https://docs.stripe.com/webhooks>
- **GitHub Docs — Securing Your Webhooks** — GitHub · *Beginner* · a second, independent implementation of the same pattern with worked code in several languages; useful for seeing what is universal versus vendor-specific. <https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries>
- **OWASP — Server Side Request Forgery Prevention Cheat Sheet** — OWASP · *Advanced* · essential before you build any dispatcher that fetches user-supplied URLs; covers DNS rebinding and cloud metadata endpoints. <https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html>
- **Microsoft REST API Guidelines — Long Running Operations** — Microsoft · *Intermediate* · a concrete corporate specification for `202`, operation resources, status polling, and cancellation semantics. <https://github.com/microsoft/api-guidelines/blob/vNext/azure/Guidelines.md>
- **Transactional Outbox Pattern** — Chris Richardson, microservices.io · *Advanced* · why writing the event in the same transaction as the state change is the only way to avoid lost or phantom events. <https://microservices.io/patterns/data/transactional-outbox.html>
- **Amazon Builders' Library — Avoiding Insurmountable Queue Backlogs** — AWS · *Advanced* · what actually goes wrong with async job queues at scale, including oldest-message age as the real saturation signal. <https://aws.amazon.com/builders-library/avoiding-insurmountable-queue-backlogs/>
- **RFC 9457 — Problem Details for HTTP APIs** — IETF · *Beginner* · the format for the `error` object inside a failed job resource and for your `409`/`400` responses. <https://www.rfc-editor.org/rfc/rfc9457.html>

---

*REST API Handbook — chapter 29.*
