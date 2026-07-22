# 15 · Bulk & Batch Operations

> **In one line:** Batching trades per-item HTTP semantics for throughput — so the entire design problem is deciding what "success" means when 97 of 100 items worked.

---

## 1. Overview

REST's resource-per-URI model is beautiful until a client needs to create 10,000 contacts. One hundred HTTP requests cost one hundred TLS handshakes' worth of latency amortization, one hundred auth checks, one hundred rate-limit decrements, and one hundred database transactions. At `p50 = 40 ms` round trip, a naive loop over 10,000 items takes almost seven minutes of pure waiting. Bulk endpoints exist to collapse that into a handful of requests.

The cost is that HTTP was designed to describe the outcome of **one** operation. A response has exactly one status code, and `201 Created` is a lie when three of the hundred items failed validation. So every bulk API must answer three questions explicitly: **Is the batch atomic or independent? How is per-item outcome reported? How does the client safely retry?** Teams that skip these questions ship endpoints that return `200 OK` with silent partial failures, and discover six months later that 2% of customer data never landed.

The history is a series of pragmatic compromises. WebDAV introduced [`207 Multi-Status`](https://www.rfc-editor.org/rfc/rfc4918#section-13) in RFC 4918 precisely for "I did several things and here is what happened to each." OData defined `$batch` with multipart bodies. Google's API design guidance standardizes `BatchCreateX`/`BatchGetX` custom methods with a documented atomicity rule. Stripe, Shopify, and Salesforce each ship a bulk/async import API that returns a **job resource** rather than results, because at 100k items the honest answer is "come back later." Notably, the modern trend is *away* from generic request-envelope batching (`POST /batch` containing serialized sub-requests) and *toward* typed, resource-specific bulk endpoints — the generic version reimplements HTTP badly inside a JSON body and loses caching, routing, and observability.

**Concrete example.** Salesforce's Bulk API 2.0 takes a CSV upload, returns `201` with a job id, and the client polls `GET /jobs/ingest/{id}` until `state: JobComplete`, then downloads `successfulResults` and `failedResults` separately. Elasticsearch's `_bulk` endpoint takes newline-delimited JSON and always returns `200` with a top-level `"errors": true|false` plus a per-item status array — the classic non-atomic multi-status shape. SendGrid's `POST /v3/mail/send` accepts up to 1,000 personalizations in one call. Three different points on the same trade-off curve: synchronous non-atomic, synchronous atomic, and asynchronous job.

The durable mental model: **a batch endpoint is a transport optimization, not a new consistency model** — decide the atomicity contract first, then choose the status code and body shape that tells the truth about it.

## 2. Core Concepts

- **Bulk operation** — one request carrying N items of the *same* type and operation (`POST /v1/contacts:batchCreate`). Typed, schema-validated, cache-friendly.
- **Batch / generic batch** — one request carrying N *heterogeneous* sub-requests, each with its own method and path (`POST /batch`). Maximum flexibility, maximum loss of HTTP semantics.
- **Atomic batch (all-or-nothing)** — the whole batch commits or none of it does. Simple to reason about; one bad row rejects 9,999 good ones.
- **Non-atomic batch (partial success)** — each item succeeds or fails independently; the response reports per-item outcomes. Higher throughput, much harder client code.
- **`207 Multi-Status`** — the RFC 4918 status code meaning "multiple independent outcomes are enclosed in the body." The overall request succeeded; each item's fate is inside.
- **Per-item result object** — `{index, id?, status, error?}` — the unit that makes partial success actionable. Must be correlated to the input by index or client-supplied key.
- **Client-supplied correlation key** — an id the *client* attaches to each item (`"ref": "row-42"`) so results can be matched to source rows even when ordering or ids change.
- **Idempotency key** — a request-scoped unique token (`Idempotency-Key: 4f2c…`) that lets a client retry a whole batch without double-applying it. Essential, because a batch retry is far more dangerous than a single-item retry.
- **Asynchronous job resource** — `202 Accepted` + `Location: /jobs/{id}`, with the client polling or receiving a webhook. The correct answer above a few thousand items or a few seconds of work.
- **Backpressure & batch caps** — a documented maximum item count and body size, enforced with `413 Content Too Large` or `422`. Unbounded batches are a denial-of-service vector with extra steps.

## 3. Theory & Principles

### 3.1 When batching actually wins

Batching helps when **per-request overhead dominates per-item work**. Model total time for N items:

```
sequential:  T = N × (RTT + auth + work)
batched:     T = ceil(N/B) × (RTT + auth + B × work)   with batch size B
```

If `work` is 2 ms and `RTT + auth` is 45 ms, then N=1000 sequential is 47 s; batched at B=100 it is `10 × (45 + 200) = 2.45 s` — a 19× win. But if `work` is 300 ms (say, each item calls a payment processor), batching at B=100 makes a single request take 30 s, which blows past gateway timeouts and gives you nothing. **The rule: batch when work-per-item is small relative to round-trip overhead; go asynchronous when total work exceeds a few seconds.**

Also note what batching does *not* fix: it does not reduce database work, and a batch of 500 inserts inside one transaction holds locks 500× longer than one insert. Batching moves the bottleneck from the network to your datastore, which is usually the point — but only if you actually use set-based operations (`INSERT ... ON CONFLICT`, `COPY`, multi-row `VALUES`) rather than looping single-row statements inside a handler.

### 3.2 The atomicity decision

There are exactly three defensible contracts, and you must pick one *per endpoint* and document it:

| Contract | Status code on mixed outcome | When to use |
|---|---|---|
| **Atomic** | `400`/`422` — nothing was applied | Financial postings, double-entry ledgers, anything with cross-item invariants (a batch that must balance to zero) |
| **Partial success** | `207 Multi-Status` with per-item statuses | Independent items: contact import, log ingestion, tag assignment, notification fan-out |
| **Asynchronous** | `202 Accepted` + job `Location` | Large volumes, long-running work, or when results are best delivered as a file |

The dangerous fourth option — returning `200 OK` with a body that quietly contains failures — is common and wrong: generic clients, retry middleware, and dashboards all treat `200` as success and never look at the body.

> **Note:** `207` is defined in WebDAV (RFC 4918), not RFC 9110, but it is registered in the IANA HTTP status code registry and is the conventional choice for partial success. If you prefer to avoid it, return `200 OK` **plus** an unambiguous top-level `"errors": true` flag *and* document that clients must inspect it — Elasticsearch's approach. Never leave it implicit.

### 3.3 Retry safety is the hard part

A single failed `POST` can be retried with an idempotency key. A *batch* retry has a combinatorial problem: after a timeout, the client does not know which items were applied. Three mechanisms, in increasing strength:

1. **Batch-level idempotency key** — the server stores `(key → full response)` and replays the identical response on retry. Simple, correct, and requires the client to re-send the *byte-identical* batch (fingerprint the body and return `422` if the key is reused with different content).
2. **Item-level idempotency keys** — each item carries its own key; a retry re-processes only what did not land. More work, but survives partial delivery and lets clients construct retry batches from just the failures.
3. **Job resources** — the batch becomes a durable, addressable entity. A retry of the *submission* returns the existing job; results are fetched separately. Strongest, and the only viable option for very large batches.

The practical rule: **clients should retry only the failed subset**, and your response format must make constructing that subset trivial — which is why per-item results must carry a client-supplied correlation key, not just an array index.

```svg
<svg viewBox="0 0 780 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif">
<rect x="10" y="10" width="760" height="300" rx="14" fill="#f8fafc" stroke="#4f46e5"/>
<text x="390" y="36" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Three batch contracts, same 100-item request</text>
<rect x="26" y="58" width="236" height="230" rx="10" fill="#fef3c7" stroke="#d97706"/>
<text x="144" y="82" text-anchor="middle" fill="#1e293b" font-size="13" font-weight="700">Atomic</text>
<text x="42" y="106" fill="#1e293b" font-size="11">3 items invalid</text>
<text x="42" y="126" fill="#1e293b" font-size="11">&#8594; transaction rolled back</text>
<text x="42" y="146" fill="#1e293b" font-size="11">&#8594; 0 rows written</text>
<rect x="42" y="160" width="204" height="40" rx="6" fill="#ffffff" stroke="#d97706"/>
<text x="144" y="178" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">422 Unprocessable</text>
<text x="144" y="193" text-anchor="middle" fill="#1e293b" font-size="11">errors[] point at rows 7,19,88</text>
<text x="42" y="222" fill="#1e293b" font-size="11">Use for: ledger postings,</text>
<text x="42" y="238" fill="#1e293b" font-size="11">cross-item invariants.</text>
<text x="42" y="262" fill="#1e293b" font-size="11" font-weight="700">Client: fix all, resend all.</text>
<rect x="272" y="58" width="236" height="230" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
<text x="390" y="82" text-anchor="middle" fill="#1e293b" font-size="13" font-weight="700">Partial success</text>
<text x="288" y="106" fill="#1e293b" font-size="11">97 committed, 3 rejected</text>
<text x="288" y="126" fill="#1e293b" font-size="11">each item independent</text>
<rect x="288" y="140" width="204" height="60" rx="6" fill="#ffffff" stroke="#0ea5e9"/>
<text x="390" y="158" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">207 Multi-Status</text>
<text x="390" y="174" text-anchor="middle" fill="#1e293b" font-size="11">results[]: {ref, status, id|error}</text>
<text x="390" y="190" text-anchor="middle" fill="#1e293b" font-size="11">summary: 97 ok / 3 failed</text>
<text x="288" y="222" fill="#1e293b" font-size="11">Use for: imports, tagging,</text>
<text x="288" y="238" fill="#1e293b" font-size="11">log and event ingestion.</text>
<text x="288" y="262" fill="#1e293b" font-size="11" font-weight="700">Client: resend the 3 only.</text>
<rect x="518" y="58" width="236" height="230" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
<text x="636" y="82" text-anchor="middle" fill="#1e293b" font-size="13" font-weight="700">Asynchronous job</text>
<text x="534" y="106" fill="#1e293b" font-size="11">100k items / slow work</text>
<text x="534" y="126" fill="#1e293b" font-size="11">accepted, not yet done</text>
<rect x="534" y="140" width="204" height="60" rx="6" fill="#ffffff" stroke="#16a34a"/>
<text x="636" y="158" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">202 Accepted</text>
<text x="636" y="174" text-anchor="middle" fill="#1e293b" font-size="11">Location: /v1/jobs/job_71c</text>
<text x="636" y="190" text-anchor="middle" fill="#1e293b" font-size="11">Retry-After: 5</text>
<text x="534" y="222" fill="#1e293b" font-size="11">Use for: bulk import/export,</text>
<text x="534" y="238" fill="#1e293b" font-size="11">anything over a few seconds.</text>
<text x="534" y="262" fill="#1e293b" font-size="11" font-weight="700">Client: poll or await webhook.</text>
</svg>
```

## 4. Architecture & Workflow

A production bulk-create endpoint with partial-success semantics, end to end:

1. **Client assembles the batch** with a client-supplied `ref` on every item and a batch-level `Idempotency-Key` header derived from the content hash.
2. **Gateway limits** — enforce max body size (`413 Content Too Large`) before the body is fully buffered, and charge the rate limiter *per item*, not per request. A caller sending 100-item batches should exhaust their quota 100× faster than one sending singletons.
3. **Envelope validation** — item count ≤ documented cap, unique `ref` values, well-formed JSON. Envelope violations fail the whole request with `422`; they are not per-item errors.
4. **Idempotency lookup** — key present and body fingerprint matches → replay the stored response verbatim; key present with a *different* fingerprint → `422` (key reuse); key present and still in flight → `409`, retry later.
5. **Authorization** — object-level checks for every item, not just the endpoint. A batch is a favourite way to smuggle one unauthorized id past a per-endpoint-only check.
6. **Per-item validation** — validate every item and collect *all* failures rather than aborting on the first. Failures become result entries; they do not abort the batch.
7. **Set-based persistence** — write the valid items with one statement (`INSERT ... VALUES (...),(...) ON CONFLICT DO NOTHING RETURNING ...`), inside a transaction sized to the batch. For very large batches, chunk into sub-transactions of a few hundred rows so you do not hold locks for seconds.
8. **Assemble results** in *input order*, each carrying `ref`, `status`, and either the created resource (with its `id` and self link) or a problem-detail-shaped error.
9. **Choose the response code** — `207` if outcomes are mixed, `201` if everything succeeded, `422` if the endpoint is atomic and anything failed. Store the response against the idempotency key.
10. **Emit telemetry** — one span per batch with `batch.size` and `batch.failed` attributes (not 500 child spans), and a counter of *items* processed, not requests.
11. **Client reconciles** — walk `results`, map by `ref`, and build a retry batch containing only entries whose `status` is retryable (`429`, `5xx`, lock-contention `409`) — never blindly re-sending the whole batch.

```svg
<svg viewBox="0 0 780 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif">
<rect x="10" y="10" width="760" height="360" rx="14" fill="#f8fafc" stroke="#4f46e5"/>
<text x="390" y="36" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Bulk create pipeline with idempotency and partial success</text>
<rect x="28" y="56" width="106" height="52" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
<text x="81" y="78" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Client</text>
<text x="81" y="94" text-anchor="middle" fill="#1e293b" font-size="10">100 items + ref</text>
<rect x="152" y="56" width="118" height="52" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
<text x="211" y="76" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Gateway</text>
<text x="211" y="92" text-anchor="middle" fill="#1e293b" font-size="10">size cap, quota x N</text>
<rect x="288" y="56" width="130" height="52" rx="8" fill="#fef3c7" stroke="#d97706"/>
<text x="353" y="76" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Idempotency store</text>
<text x="353" y="92" text-anchor="middle" fill="#1e293b" font-size="10">hit &#8594; replay response</text>
<rect x="436" y="56" width="140" height="52" rx="8" fill="#fef3c7" stroke="#d97706"/>
<text x="506" y="76" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Validate + authorize</text>
<text x="506" y="92" text-anchor="middle" fill="#1e293b" font-size="10">per item, collect all</text>
<rect x="594" y="56" width="152" height="52" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
<text x="670" y="76" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Set-based write</text>
<text x="670" y="92" text-anchor="middle" fill="#1e293b" font-size="10">INSERT ... RETURNING</text>
<path d="M134 82 h14 m-6 -4 l6 4 l-6 4" fill="none" stroke="#4f46e5" stroke-width="2"/>
<path d="M270 82 h14 m-6 -4 l6 4 l-6 4" fill="none" stroke="#4f46e5" stroke-width="2"/>
<path d="M418 82 h14 m-6 -4 l6 4 l-6 4" fill="none" stroke="#4f46e5" stroke-width="2"/>
<path d="M576 82 h14 m-6 -4 l6 4 l-6 4" fill="none" stroke="#4f46e5" stroke-width="2"/>
<rect x="28" y="132" width="718" height="98" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
<text x="44" y="154" fill="#1e293b" font-size="12" font-weight="700">POST /v1/contacts:batchCreate</text>
<text x="44" y="174" fill="#1e293b" font-size="12">Idempotency-Key: 8f1c-…   Content-Type: application/json</text>
<text x="44" y="196" fill="#1e293b" font-size="12">{ "items": [ {"ref":"row-1","email":"a@x.io"}, … {"ref":"row-100", …} ] }</text>
<text x="44" y="218" fill="#1e293b" font-size="11">Envelope errors (too many items, duplicate ref) fail the whole request with 422.</text>
<rect x="28" y="246" width="718" height="112" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
<text x="44" y="268" fill="#1e293b" font-size="12" font-weight="700">207 Multi-Status</text>
<text x="44" y="288" fill="#1e293b" font-size="12">{ "summary": { "total":100, "succeeded":97, "failed":3 },</text>
<text x="44" y="306" fill="#1e293b" font-size="12">  "results": [ {"ref":"row-1","status":201,"id":"con_9f2","location":"/v1/contacts/con_9f2"},</text>
<text x="44" y="324" fill="#1e293b" font-size="12">               {"ref":"row-7","status":422,"error":{"type":"…/invalid-email","detail":"…"}} ] }</text>
<text x="44" y="346" fill="#1e293b" font-size="11">Client rebuilds a retry batch from results where status is 429 or 5xx, keyed by ref.</text>
</svg>
```

## 5. Implementation

### 5.1 Partial-success bulk create

```http
POST /v1/contacts:batchCreate HTTP/1.1
Content-Type: application/json
Idempotency-Key: 8f1c9d2a-4b77-4f0e-9a11-3c6f0f2f1d55

{ "items": [ { "ref": "row-1", "email": "ada@example.com",  "name": "Ada" },
             { "ref": "row-7", "email": "not-an-email",     "name": "Bob" },
             { "ref": "row-8", "email": "cleo@example.com", "name": "Cleo" } ] }
```

```http
HTTP/1.1 207 Multi-Status
Content-Type: application/json
X-Request-Id: req_01J9Q7

{ "summary": { "total": 3, "succeeded": 2, "failed": 1 },
  "results": [
    { "ref": "row-1", "status": 201, "id": "con_9f2", "location": "/v1/contacts/con_9f2" },
    { "ref": "row-7", "status": 422,
      "error": { "type": "https://api.example.com/problems/validation",
                 "title": "Validation failed", "detail": "email is not a valid address",
                 "pointer": "/items/1/email" } },
    { "ref": "row-8", "status": 201, "id": "con_9f3", "location": "/v1/contacts/con_9f3" } ] }
```

Envelope-level rejection is different — nothing was attempted, so it is a plain problem detail:

```http
HTTP/1.1 422 Unprocessable Content
Content-Type: application/problem+json

{ "type": "https://api.example.com/problems/batch-too-large",
  "title": "Batch exceeds maximum size", "status": 422,
  "detail": "Received 5000 items; the maximum is 500.", "max_items": 500 }
```

### 5.2 Atomic bulk with all-or-nothing semantics

```bash
curl -i -X POST https://api.example.com/v1/ledger/entries:batchCreate \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: 2a91…' \
  -d '{"atomic":true,"items":[{"ref":"d1","account":"cash","amount":5000},
                              {"ref":"c1","account":"revenue","amount":-4999}]}'
```

```http
HTTP/1.1 422 Unprocessable Content
Content-Type: application/problem+json

{ "type": "https://api.example.com/problems/unbalanced-entry",
  "title": "Batch rejected", "status": 422,
  "detail": "Entries must sum to zero; got 1. No entries were created.",
  "errors": [ { "ref": "c1", "detail": "amount would leave the batch unbalanced" } ] }
```

Note the wording — *"No entries were created."* An atomic endpoint must say so explicitly; clients cannot infer it from the status code.

### 5.3 Async job for large volumes

```http
POST /v1/contacts/import HTTP/1.1
Content-Type: text/csv
Idempotency-Key: c40b…

email,name
ada@example.com,Ada
…200000 more rows…
```

```http
HTTP/1.1 202 Accepted
Location: https://api.example.com/v1/jobs/job_71c8
Retry-After: 5

{ "id": "job_71c8", "state": "queued", "total": 200000 }
```

Polling `GET /v1/jobs/job_71c8` then returns `200 OK` with `Cache-Control: no-store` and a progress document:

```json
{ "id": "job_71c8", "state": "running", "processed": 84200,
  "succeeded": 84115, "failed": 85, "results_url": null, "errors_url": null }
```

When `state` becomes `succeeded` or `partially_succeeded`, `results_url` and `errors_url` point at signed, expiring download URLs. Do **not** return 200,000 result objects in a JSON body.

### 5.4 FastAPI implementation

```python
from typing import Optional
from fastapi import APIRouter, Depends, Header, Response
from pydantic import BaseModel, EmailStr, Field, field_validator

router, MAX_ITEMS = APIRouter(), 500


class ContactIn(BaseModel, extra="forbid"):
    ref: str = Field(min_length=1, max_length=64)
    email: EmailStr
    name: str = Field(min_length=1, max_length=120)


class BatchIn(BaseModel, extra="forbid"):
    items: list[ContactIn] = Field(min_length=1, max_length=MAX_ITEMS)

    @field_validator("items")
    @classmethod
    def refs_unique(cls, v):
        if len({i.ref for i in v}) != len(v):
            raise ValueError("ref values must be unique within a batch")
        return v


@router.post("/v1/contacts:batchCreate")
async def batch_create(body: BatchIn, response: Response, db=Depends(get_db),
                       principal=Depends(auth),
                       idempotency_key: Optional[str] = Header(None)):
    if idempotency_key and (hit := await idem_lookup(idempotency_key, body)):
        response.status_code = hit.status       # 422 raised inside on fingerprint mismatch
        return hit.payload

    results, to_insert = [], []
    for i, item in enumerate(body.items):       # object-level authz PER ITEM
        if not principal.may_create_contact(item.email):
            results.append({"ref": item.ref, "status": 403,
                            "error": {"title": "Forbidden", "pointer": f"/items/{i}"}})
        else:
            to_insert.append(item)
            results.append({"ref": item.ref, "status": None})

    created = await db.fetch_all(               # ONE set-based statement, not a loop
        """INSERT INTO contacts (email, name) VALUES %s
           ON CONFLICT (email) DO NOTHING RETURNING id, email""",
        [(c.email, c.name) for c in to_insert])
    by_email = {r["email"]: r["id"] for r in created}
    by_ref = {r["ref"]: r for r in results}
    for item in to_insert:
        cid = by_email.get(item.email)
        by_ref[item.ref].update(
            {"status": 201, "id": cid, "location": f"/v1/contacts/{cid}"} if cid else
            {"status": 409, "error": {"title": "Contact already exists"}})

    ok = sum(1 for r in results if r["status"] == 201)
    payload = {"summary": {"total": len(results), "succeeded": ok,
                           "failed": len(results) - ok}, "results": results}
    status = 201 if ok == len(results) else 207
    if idempotency_key:
        await idem_store(idempotency_key, body, status, payload)
    response.status_code = status
    return payload
```


### 5.5 Client: retry only what failed

```javascript
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

async function sendBatch(items, attempt = 0) {
  const res = await fetch("/v1/contacts:batchCreate", {
    method: "POST",
    headers: { "Content-Type": "application/json",
               "Idempotency-Key": await fingerprint(items) },  // same key = safe replay
    body: JSON.stringify({ items }),
  });
  if ((res.status === 429 || res.status >= 500) && attempt <= 4) {   // whole request failed
    await sleep(backoff(attempt, res.headers.get("Retry-After")));
    return sendBatch(items, attempt + 1);
  }
  const { results } = await res.json();
  const byRef = new Map(items.map(i => [i.ref, i]));
  const retry = results.filter(r => RETRYABLE.has(r.status)).map(r => byRef.get(r.ref));
  if (retry.length && attempt <= 4) {                  // NEW key: different content
    await sleep(backoff(attempt));
    return sendBatch(retry, attempt + 1);
  }
  return { fatal: results.filter(r => r.status >= 400 && !RETRYABLE.has(r.status)) };
}
```


### 5.6 Optimization notes

- **Set-based SQL or nothing.** A handler that loops `await db.execute(INSERT …)` 500 times pays 500 database round trips and defeats the purpose. Use multi-row `VALUES`, `COPY`/`LOAD DATA`, or `unnest($1::text[])`.
- **Chunk long transactions** — committing 10,000 rows at once holds locks and inflates WAL/redo; commit every 200–1,000 rows and make the chunk boundary resumable via the job record.
- **Stream large request bodies** with NDJSON or CSV rather than one giant JSON array, so you never hold the whole batch in memory — this is exactly why Elasticsearch's `_bulk` uses NDJSON.
- **Compress** — `Content-Encoding: gzip` typically cuts a JSON batch by 80–90%; enforce a *decompressed* size cap to avoid zip bombs. And cap concurrency, not just size: ten concurrent 500-item batches is 5,000 in-flight items, so bound worker parallelism and return `429` + `Retry-After` when the queue is deep.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Typed bulk endpoint (`:batchCreate`) | One round trip for N items; schema-validated; observable; set-based writes | New endpoint per resource/operation; a second code path to keep in sync with the singleton |
| Generic `POST /batch` envelope | One endpoint serves everything; heterogeneous operations | Reimplements HTTP inside JSON; loses caching, routing, per-route auth, and metrics; hard to rate-limit sanely |
| Atomic semantics | Trivial client logic — it worked or it didn't; preserves cross-item invariants | One bad item wastes the whole batch; long transactions hold locks; poor fit for imports |
| Partial success (`207`) | Maximum throughput; bad rows don't block good ones | Client must parse per-item results; naive clients treat `207` as success and lose data |
| Async job (`202`) | Handles unbounded volume; results delivered as files; progress is observable | Extra endpoints (job status, results download); clients need polling or webhooks; eventual results |
| Idempotency keys (batch- or item-level) | Safe retry: batch-level replays a stored response, item-level re-processes only what is missing | Requires stored responses plus a content fingerprint; item-level adds storage and client bookkeeping |
| Large batch sizes | Best amortization of overhead | Timeout risk, memory pressure, lock contention, and a bigger blast radius per failure |

## 7. Common Mistakes & Best Practices

1. ⚠️ **`200 OK` with hidden failures** in the body, so retry middleware and dashboards report success. → ✅ Use `207 Multi-Status`, or `200` with a mandatory top-level `"errors": true` flag that you document and test for.
2. ⚠️ **Undocumented atomicity.** Clients cannot tell whether a `422` means "nothing happened" or "some things happened." → ✅ State the contract in the endpoint docs *and* in the error `detail` ("No entries were created").
3. ⚠️ **Unbounded batch size** — a client posts 2 million items and OOMs the pod. → ✅ Enforce a documented `max_items` and body-size cap; reject with `413`/`422` before buffering the whole body.
4. ⚠️ **Results correlated only by array index**, which breaks the moment the server reorders or filters. → ✅ Require a client-supplied `ref` per item and echo it in every result.
5. ⚠️ **Looping single-row INSERTs inside the handler**, turning one HTTP round trip into 500 database round trips. → ✅ Use set-based statements; measure with a query-count assertion in tests.
6. ⚠️ **Blind full-batch retry after a timeout**, double-creating everything that did land. → ✅ Batch-level `Idempotency-Key` with a stored response, plus per-item retry built from the results array.
7. ⚠️ **Per-request rate limiting** on batch endpoints, letting one caller do 100× the work for the same quota. → ✅ Charge the limiter per item (or per estimated cost) and expose it in `RateLimit-*` headers.
8. ⚠️ **Authorization checked only at the endpoint**, so a batch smuggles in ids the caller cannot touch. → ✅ Object-level authorization for every item; return per-item `403` rather than failing the batch.
9. ⚠️ **Synchronous batch that runs for 90 seconds** and dies at the gateway's 60 s timeout, leaving partial writes and no result. → ✅ Move to `202` + job resource once expected work exceeds a few seconds; keep sync batches comfortably under the gateway timeout.
10. ⚠️ **Returning 200,000 result objects** in a single JSON response. → ✅ For large jobs return counts plus signed `results_url`/`errors_url` files, or paginate a `GET /jobs/{id}/results`.
11. ⚠️ **A generic `POST /batch` that forwards sub-requests internally**, bypassing gateway auth, rate limits, and WAF rules. → ✅ Prefer typed bulk endpoints; if you must have a generic batch, apply the same middleware chain per sub-request and forbid privileged routes.
12. ⚠️ **Stopping validation at the first bad item.** → ✅ Validate everything and return all errors at once, each with a JSON Pointer into the request body.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Give every batch a server-generated `batch_id` and echo it in `X-Request-Id`; log one structured record per batch (size, duration, success/failure counts, idempotency key hash) and per-item records only for failures, sampled. Without a client `ref` you will never answer "which of my 500 rows failed" — treat `ref` as mandatory. Store the request body fingerprint alongside the idempotency key so you can prove whether a "duplicate" retry actually carried identical content. In traces, use a single span per batch with an `batch.item_count` attribute rather than 500 child spans, which will blow your tracing budget.

**Monitoring.** Track items/second (not requests/second) as the primary throughput metric; batch size distribution (p50/p99); per-item failure rate broken out by error type; batch latency p99 against the gateway timeout (alert when p99 exceeds 60% of it); idempotency replay rate (a spike means clients are timing out and retrying — usually a latency problem in disguise); and for async jobs, queue depth and age of the oldest queued job. A rising `207` rate with a flat `4xx` rate means clients are sending progressively dirtier data.

**Security.** Batches amplify every existing weakness. **Authorization**: check object-level permissions per item (OWASP API Top 10 #1); a batch is the easiest way to test 500 ids for existence in one request, so consider whether per-item `404` vs `403` leaks resource existence. **Resource exhaustion** (API Top 10 #4): enforce decompressed body size, item count, per-item field lengths, and total work; a 1 MB gzipped payload can expand to 1 GB. **Rate limiting**: cost-based, per item. **Generic batch endpoints** deserve special suspicion — they are an SSRF-shaped hazard when sub-requests are dispatched by URL, and they routinely bypass the gateway's per-route policies. Finally, do not echo unvalidated input back in per-item errors without escaping; batch error arrays are a common reflected-content sink.

**Performance & scaling.** The right batch size is empirical: start at 100, measure items/second and p99, and increase until latency approaches your timeout budget or lock contention shows up. Beyond that, add concurrency (multiple in-flight batches) rather than bigger batches — it degrades more gracefully. Server-side, decouple ingest from processing: accept the batch, write it to a durable queue or staging table, return `202`, and let workers drain it; this converts a latency problem into a throughput problem you can scale horizontally. For very high volume, prefer a streaming format (NDJSON) with incremental parsing and per-chunk commits so memory stays flat and a failure at row 900,000 does not discard 899,999 rows of work.

## 9. Interview Questions

**Q: When should an API offer a bulk endpoint at all?**
A: When per-request overhead (round trip, TLS, auth, rate-limit checks) dominates per-item work, and clients routinely operate on many items. If each item takes hundreds of milliseconds of real work, batching just builds a timeout bomb — use an asynchronous job instead.

**Q: What status code do you return when 97 of 100 items succeed?**
A: `207 Multi-Status` with a per-item results array, assuming the endpoint is documented as non-atomic. Returning `200 OK` hides failures from generic clients and middleware; returning `422` would be wrong because work *was* committed.

**Q: What is the difference between a bulk endpoint and a generic batch endpoint?**
A: A bulk endpoint applies one operation to N items of one type (`POST /contacts:batchCreate`) — typed, validatable, and observable. A generic batch endpoint carries N arbitrary sub-requests in one envelope, which re-implements HTTP inside JSON and loses caching, per-route auth, routing, and metrics. Prefer typed bulk endpoints.

**Q: How does a client safely retry a batch after a timeout?**
A: Send an `Idempotency-Key` covering the whole request; the server stores the response against the key and replays it on retry, so nothing is double-applied. For partial failures, the client should build a *new* batch containing only the retryable items (with a new key), using the client-supplied `ref` values to correlate.

**Q: Why do results need a client-supplied `ref` instead of just an array index?**
A: Indices break as soon as the server filters, reorders, or splits the batch, and they are meaningless once the client has queued the work across threads. A `ref` the client chose (a row number, a source primary key) survives all of that and makes building a retry batch trivial.

**Q: How should rate limiting work for batch endpoints?**
A: Charge per item or per estimated cost, not per request — otherwise a caller sending 500-item batches consumes 500× the resources for the same quota. Expose the accounting in `RateLimit-Limit`/`RateLimit-Remaining` and return `429` with `Retry-After` when exceeded.

**Q: When do you switch from a synchronous batch to an async job?**
A: When expected processing time approaches your gateway/load-balancer timeout (typically 30–60 s), when the item count is large enough that the result set doesn't belong in a response body, or when the work must survive a client disconnect. The shape is `202 Accepted` + `Location: /jobs/{id}` + `Retry-After`, with results delivered as downloadable files.

**Q: What does atomicity cost you in a bulk import?**
A: One invalid row rejects thousands of valid ones, forcing a fix-and-resubmit cycle; the transaction holds locks for the duration, hurting concurrent writers; and long transactions inflate WAL/undo. Atomicity is right when cross-item invariants exist (a ledger batch that must balance), and wrong for independent-item imports.

**Q: (Senior) Design the response contract for a bulk endpoint that must support partial success, retries, and 100k-item imports.**
A: Two endpoints. The synchronous one caps at ~500 items, requires a per-item `ref` and a batch `Idempotency-Key`, and returns `207` with `{summary, results[{ref, status, id|error}]}` where errors are problem-detail shaped. Above the cap, the same URI accepts NDJSON/CSV and returns `202` + `Location: /v1/jobs/{id}`; the job resource exposes `state`, counters, and signed `results_url`/`errors_url` when complete, plus an optional webhook. Both document atomicity explicitly, charge rate limits per item, and validate every item so all errors come back in one pass.

**Q: (Senior) A customer reports duplicate records after a network blip during a 500-item import. Walk through the diagnosis and fix.**
A: First confirm whether the client retried: look for two requests with the same `Idempotency-Key` hash, or two different keys with the same body fingerprint (which means the client regenerated the key — the actual bug). If keys matched, check that the idempotency store recorded the response *before* the connection dropped and that the record survives across instances (a per-pod in-memory cache is the classic failure). Fix in layers: derive the key from a stable content hash on the client, persist the key + fingerprint + response in a shared store within the same transaction as the write, and add a natural-key uniqueness constraint (`ON CONFLICT (email) DO NOTHING`) so duplicates are impossible even if idempotency fails. Backfill by deduplicating on the natural key.

**Q: (Senior) Your bulk endpoint's p99 latency has crept from 1.2 s to 48 s with the same batch size. How do you investigate?**
A: Separate queueing from execution: check whether time is spent waiting for a worker/connection (pool saturation, queue depth) or inside the database. If it's the database, look for lock contention — large batch transactions serializing against each other on a hot index or an `ON CONFLICT` target — and for a plan regression from a loop of single-row statements that used to be set-based. Check whether item mix changed (bigger payloads, more items triggering an expensive validation or an external call). Then reduce transaction size by chunking, cap concurrent batches, and if the work genuinely grew, move to the async job path before the gateway timeout starts truncating requests and creating partial writes.

**Q: (Senior) What security risks are specific to batch endpoints?**
A: Authorization amplification — one request probing hundreds of object ids, so object-level checks per item are mandatory and per-item `404`/`403` choices leak existence. Resource exhaustion — compressed payloads expanding to gigabytes, unbounded item counts, and quadratic validation, all of which need decompressed-size and count caps enforced before buffering. Policy bypass — generic `POST /batch` endpoints that dispatch sub-requests internally, skipping the gateway's auth, WAF, and rate-limit rules, and sometimes enabling SSRF. Plus error-channel leakage: verbose per-item errors that echo other tenants' data or internal identifiers.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** A batch endpoint is a transport optimization, so decide the contract first: **atomic** (all-or-nothing, `422` and "nothing was created" when anything fails — use for cross-item invariants), **partial success** (`207 Multi-Status` with a per-item results array — use for independent items), or **asynchronous** (`202 Accepted` + `Location: /jobs/{id}` + `Retry-After` — use above a few thousand items or a few seconds of work). Never return `200 OK` with hidden failures. Require a client-supplied `ref` on every item so results correlate, and a batch-level `Idempotency-Key` (stored with a body fingerprint) so retries replay instead of duplicating. Validate every item and return all errors at once with JSON Pointers. Cap item count and decompressed body size, charge rate limits **per item**, authorize **per item**, and write with set-based SQL — not a loop of single-row inserts. Prefer typed `:batchCreate` endpoints over a generic `POST /batch`, which reimplements HTTP inside JSON and bypasses your gateway.

| Situation | Response |
|---|---|
| All items succeeded | `201` (or `200`) with results |
| Mixed outcomes, non-atomic endpoint | `207 Multi-Status` |
| Atomic endpoint, any item invalid | `422` + "nothing was applied" |
| Batch accepted for async processing | `202` + `Location` + `Retry-After` |
| Too many items / body too large | `422` or `413 Content Too Large` |
| Idempotency key reused with new body | `422` |
| Idempotent replay of an in-flight batch | `409` (retry later) |
| Quota exhausted (per-item accounting) | `429` + `Retry-After` |
| Item the caller may not touch | per-item `403` inside `207` |

- **Three contracts** → atomic (`422`), partial (`207`), async (`202` + job).
- **Correlation** → client-supplied `ref` on every item, echoed in every result.
- **Retry safety** → batch `Idempotency-Key` + fingerprint; retry only failed items with a new key.
- **Rate limiting** → per item, never per request.
- **Persistence** → one set-based statement; chunk long transactions.

## 11. Hands-On Exercises & Mini Project

- [ ] Benchmark 1,000 single `POST`s against ten 100-item batches; record wall time, database round trips, and p99.
- [ ] Implement a `207` endpoint whose results carry `ref`, `status`, and problem-detail errors; write a client that retries only entries with status `429`/`5xx`.
- [ ] Add an `Idempotency-Key` store keyed by `(key, body_fingerprint)`; prove that an identical retry replays the stored response and a different body returns `422`.
- [ ] Convert a loop of single-row `INSERT`s into one multi-row `INSERT ... ON CONFLICT DO NOTHING RETURNING`, and assert the query count in a test.
- [ ] Add a gzip-decompression size guard and demonstrate it rejecting a 1 MB payload that expands past your cap.

**Mini Project — a contact import service.**
*Goal:* Ship `POST /v1/contacts:batchCreate` (sync, ≤500 items) and `POST /v1/contacts/import` (async, NDJSON/CSV, unbounded) with a shared validation core.
*Requirements:* Per-item `ref`; `207` with `{summary, results[]}` on mixed outcomes and `201` when all succeed; envelope errors as `422` problem details; batch `Idempotency-Key` persisted with a body fingerprint; per-item object-level authorization; set-based inserts with `ON CONFLICT`; per-item rate limiting with `RateLimit-*` headers; async path returning `202` + `Location`, a `GET /v1/jobs/{id}` resource with counters, and signed `results_url`/`errors_url` on completion.
*Extensions:* Add an HMAC-signed webhook on job completion; add resumable chunked processing so a crash at row 900k restarts from the last committed chunk; add an `atomic: true` mode with cross-item invariant checks; emit metrics for items/second, batch size, and idempotency replay rate, then load-test to find the batch size where p99 hits 60% of the gateway timeout.

## 12. Related Topics & Free Learning Resources

**Related chapters:** *Idempotency & Retries* for the `Idempotency-Key` machinery; *Error Handling & Problem Details* (chapter 16) for the per-item error shape; *Validation & Input Handling* (chapter 17) for collecting all errors in one pass; *Pagination* (chapter 13) for reading back large result sets; *Rate Limiting & Throttling* for per-item cost accounting; *Async APIs, Jobs & Webhooks* for the `202` + job pattern.

**Free Learning Resources**
- **RFC 9110 — HTTP Semantics** — IETF · *Intermediate* · the authority on `202`, `409`, `413`, `422` and why one response carries one status. <https://www.rfc-editor.org/rfc/rfc9110>
- **RFC 4918 §13 — Multi-Status Response** — IETF · *Intermediate* · the definition of `207` and the reasoning behind enclosing multiple outcomes in one body. <https://www.rfc-editor.org/rfc/rfc4918#section-13>
- **AIP-231 / AIP-233 — Batch methods** — Google API Improvement Proposals · *Intermediate* · precise guidance on batch method naming, atomicity, and response shape at scale. <https://google.aip.dev/231>
- **Elasticsearch Bulk API** — Elastic · *Intermediate* · a production NDJSON bulk endpoint with per-item statuses and an explicit top-level `errors` flag. <https://www.elastic.co/guide/en/elasticsearch/reference/current/docs-bulk.html>
- **Bulk API 2.0 Developer Guide** — Salesforce · *Advanced* · the canonical async job model: create job, upload data, poll state, download success/failure files. <https://developer.salesforce.com/docs/atlas.en-us.api_asynch.meta/api_asynch/asynch_api_intro.htm>
- **Stripe API — Idempotent requests** — Stripe · *Beginner* · how idempotency keys, stored responses, and content fingerprints work in a real payments API. <https://docs.stripe.com/api/idempotent_requests>
- **OWASP API Security Top 10 — Unrestricted Resource Consumption** — OWASP · *Intermediate* · the threat model for unbounded batch sizes, decompression bombs, and cost-based limits. <https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/>

---

*REST API Handbook — chapter 15.*
