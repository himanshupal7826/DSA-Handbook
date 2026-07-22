# 27 · Idempotency Keys & Safe Retries

> **In one line:** A network timeout never tells you whether the write happened, so make `POST` safely repeatable with a client-supplied idempotency key and retry with exponential backoff plus jitter.

---

## 1. Overview

Every distributed system runs into the same uncomfortable fact: when a request times out, the client learns nothing. The request may have been lost on the way out, processed successfully with the response lost on the way back, or still be executing right now. This is the **two generals problem** in its everyday form, and there is no protocol trick that removes it. What you can do is make the *second* attempt harmless.

That is what an **idempotency key** is. The client generates a unique identifier — typically a UUIDv4 — for a logical operation and sends it as `Idempotency-Key: <uuid>` on the `POST`. The server records the key alongside the outcome. If the same key arrives again, the server does **not** re-execute; it replays the stored response. The client can now retry as aggressively as it likes, and the charge is created exactly once.

The reason this matters more for REST than for internal RPC is that `POST` is neither safe nor idempotent by HTTP semantics (RFC 9110 §9.2). `GET`, `HEAD`, `OPTIONS`, and `TRACE` are safe; `PUT` and `DELETE` are idempotent by definition; `POST` and `PATCH` are neither. A client library that blindly retries a timed-out `POST /v1/charges` will double-charge a customer, and it will do so under exactly the conditions — network instability, an overloaded server — where it is hardest to notice.

**Concrete example.** Stripe introduced `Idempotency-Key` on its API in 2015 and it is now the industry template: keys are stored for 24 hours, a repeated key returns the original response verbatim, a repeated key with a *different request body* returns a `400`, and a key whose original request is still in flight returns `409 Conflict`. Adyen, Square, PayPal, Shopify, and AWS (as `ClientToken`) all implement the same shape. The IETF has an active draft, `draft-ietf-httpapi-idempotency-key-header`, aiming to standardize the header — but the de facto convention is already universal, so implement Stripe's semantics and you will be compatible with every client library your users already know.

The durable mental model has two halves that must both be present. The **server side** provides an idempotency contract: a key, a fingerprint of the request, a durable record of the outcome, and a concurrency guard. The **client side** provides a retry policy: which errors are retryable, exponential backoff with jitter, a bounded attempt count, a total deadline, and a circuit breaker so a struggling dependency is not hammered into the ground. Idempotency without retries is unused insurance; retries without idempotency are a duplication engine.

## 2. Core Concepts

- **Idempotent operation** — one whose effect on server state is identical whether applied once or many times; `PUT /users/7` with the same body is idempotent, `POST /users` is not.
- **Idempotency key** — a client-generated unique token identifying a *logical* operation, sent in `Idempotency-Key`, used by the server to deduplicate retries.
- **Request fingerprint** — a hash of the method, path, and canonical body stored with the key so the server can detect a key being reused for a different request.
- **Replay** — returning the stored response for a previously completed key, ideally with `Idempotent-Replayed: true` so clients and dashboards can distinguish it.
- **In-flight conflict** — a second request arrives with a key whose first attempt has not finished; the correct answer is `409 Conflict`, telling the client to retry shortly.
- **Exponential backoff** — delay of `base × 2^attempt`, which spreads retries out geometrically instead of amplifying load on a struggling service.
- **Jitter** — randomization applied to the backoff delay to break the synchronization that turns retries into a thundering herd.
- **Retry budget** — a cap on retries as a *fraction of total traffic* (e.g., 10%), which prevents a partial outage from becoming a self-inflicted DDoS.
- **Circuit breaker** — a state machine (closed → open → half-open) that stops sending requests to a dependency that is failing, giving it room to recover.
- **Exactly-once delivery** — impossible at the network layer; what systems actually achieve is at-least-once delivery plus idempotent processing, which is *effectively* exactly-once.

## 3. Theory & Principles

**HTTP method guarantees (RFC 9110 §9.2).** *Safe* means the method is read-only and has no side effects the client is responsible for: `GET`, `HEAD`, `OPTIONS`, `TRACE`. *Idempotent* means N identical requests have the same effect as one: all safe methods plus `PUT` and `DELETE`. `POST` and `PATCH` are neither. Note two subtleties. First, idempotent does **not** mean the same *response*: `DELETE /orders/7` returns `204` then `404`, and that is fine — the guarantee is about state, not status codes. Second, `PATCH` is not idempotent in general because a JSON Patch operation like `{"op":"add","path":"/tags/-","value":"vip"}` appends on every application; a JSON Merge Patch that sets absolute values usually *is* idempotent, but the method carries no such promise, so clients must not assume it.

**Why exactly-once is a myth.** Consider client C and server S. C sends a request; the request or the response can be lost. If C retries on timeout, S may process twice (at-least-once). If C does not retry, the operation may never happen (at-most-once). There is no strategy giving exactly-once over an unreliable channel — this is the FLP/two-generals result in applied form. The engineering answer is: **at-least-once delivery + idempotent processing = effectively-once semantics.** The idempotency key is what makes the processing idempotent.

**The deduplication window.** A key must be stored long enough to cover the client's maximum retry horizon and any human-driven retry (a user hitting "Pay" again, an operator re-running a batch). Stripe uses 24 hours; 24–72 hours is the industry norm. Storage cost is trivial — a key row is roughly 1 KB, so 10 million operations a day costs about 10 GB for a 24-hour window with TTL eviction.

**Which errors are retryable.** Retrying a `400` will fail forever and waste capacity. The rule:

| Class | Retry? | Reason |
|---|---|---|
| Connection refused / reset / DNS failure | Yes | The request almost certainly never executed |
| Timeout (no response) | Yes, **with an idempotency key** | Outcome genuinely unknown |
| `408`, `425`, `429` | Yes, honour `Retry-After` | Server explicitly invites a retry |
| `500`, `502`, `503`, `504` | Yes | Transient server-side failure |
| `409` on an in-flight key | Yes, short delay | The original attempt is still running |
| `400`, `401`, `403`, `404`, `422` | No | Deterministic; the same request will fail identically |
| `501`, `505` | No | The server will never support it |

**Backoff math.** Naive exponential backoff (`delay = base × 2^n`) desynchronizes a single client but not a fleet: 10,000 clients that all failed at T will all retry at T+1s, T+2s, T+4s, producing load spikes precisely when the service is recovering. Jitter fixes this. The three standard variants, from AWS's well-known analysis:

```
no jitter    : delay = min(cap, base * 2^attempt)
full jitter  : delay = random(0, min(cap, base * 2^attempt))
equal jitter : t = min(cap, base * 2^attempt); delay = t/2 + random(0, t/2)
decorrelated : delay = min(cap, random(base, prev_delay * 3))
```

**Full jitter** minimizes both total work and completion-time variance in AWS's simulations and is the sensible default. With `base = 100 ms`, `cap = 20 s`, and 5 attempts, worst-case elapsed time is about 31 s — which is why you also need an absolute deadline that overrides the attempt count.

**Retry amplification.** If service A retries 3× into B, and B retries 3× into C, a single user request can become 9 calls to C. In a five-layer stack that is 243×. The defenses are: **retry only at one layer** (usually the edge closest to the user), enforce a **retry budget** (Google SRE and Envoy both cap retries at ~10–20% of request volume), and **propagate a deadline** so inner layers stop when the outer deadline has already expired.

```svg
<svg viewBox="0 0 780 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="8" y="8" width="764" height="344" rx="14" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="390" y="36" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">The ambiguous timeout, and how a key resolves it</text>

  <text x="70" y="66" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Client</text>
  <text x="390" y="66" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Network</text>
  <text x="690" y="66" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Server</text>
  <path d="M70 74 L70 336" stroke="#4f46e5" stroke-width="1.5" fill="none"/>
  <path d="M690 74 L690 336" stroke="#4f46e5" stroke-width="1.5" fill="none"/>

  <path d="M70 100 L688 100" stroke="#0ea5e9" stroke-width="2" fill="none"/>
  <polygon points="688,100 680,96 680,104" fill="#0ea5e9"/>
  <text x="380" y="94" text-anchor="middle" fill="#1e293b" font-size="11">POST /v1/charges &#8226; Idempotency-Key: k-9f2c</text>

  <rect x="596" y="112" width="180" height="34" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="686" y="133" text-anchor="middle" fill="#1e293b" font-size="10">charge created, key stored</text>

  <path d="M690 164 L400 164" stroke="#d97706" stroke-width="2" stroke-dasharray="6 4" fill="none"/>
  <rect x="352" y="150" width="44" height="28" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="374" y="169" text-anchor="middle" fill="#1e293b" font-size="10" font-weight="700">LOST</text>
  <text x="180" y="160" fill="#d97706" font-size="11" font-weight="700">response never arrives</text>

  <rect x="20" y="188" width="200" height="34" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="120" y="209" text-anchor="middle" fill="#1e293b" font-size="10">client times out: did it happen?</text>

  <text x="120" y="244" text-anchor="middle" fill="#1e293b" font-size="10">wait 100ms &#215; 2^n + jitter</text>

  <path d="M70 268 L688 268" stroke="#0ea5e9" stroke-width="2" fill="none"/>
  <polygon points="688,268 680,264 680,272" fill="#0ea5e9"/>
  <text x="380" y="262" text-anchor="middle" fill="#1e293b" font-size="11">retry: same key k-9f2c, same body</text>

  <rect x="560" y="278" width="216" height="34" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="668" y="299" text-anchor="middle" fill="#1e293b" font-size="10">key found &#8594; replay, do NOT re-charge</text>

  <path d="M688 328 L72 328" stroke="#16a34a" stroke-width="2" fill="none"/>
  <polygon points="72,328 80,324 80,332" fill="#16a34a"/>
  <text x="380" y="322" text-anchor="middle" fill="#1e293b" font-size="11">200 OK &#8226; same body &#8226; Idempotent-Replayed: true</text>
</svg>
```

## 4. Architecture & Workflow

The full server-side lifecycle of an idempotent `POST /v1/charges`.

1. **Client generates the key.** A UUIDv4 created *once* per logical operation and reused across every retry of that operation. Generating a new key per attempt defeats the entire mechanism — this is the most common client bug.
2. **Gateway passes it through.** The `Idempotency-Key` header must survive the gateway, and the gateway's own retries (if any) must reuse it. Many gateways strip unknown headers by default; check.
3. **Validate.** Reject a missing key on a mutating endpoint that requires one with `400` (or `428 Precondition Required` if you want to be explicit); reject a malformed or over-long key with `400`. Scope the key to `(tenant_id, key)` so tenants cannot collide or probe each other's keys.
4. **Atomic claim.** `INSERT INTO idempotency_keys (tenant_id, key, fingerprint, state) VALUES (…, 'in_progress') ON CONFLICT DO NOTHING`. The insert succeeding *is* the lock. This must be a single atomic statement — a `SELECT` followed by an `INSERT` has a race window that two concurrent retries will find.
5. **Branch on the claim result.**
   - *Insert succeeded* → this is the first attempt; proceed to step 6.
   - *Row exists, state `completed`, fingerprint matches* → replay the stored status, headers, and body. Add `Idempotent-Replayed: true`.
   - *Row exists, state `in_progress`* → return `409 Conflict` with a `Retry-After: 1`, telling the client the original is still running.
   - *Row exists, fingerprint differs* → return `422 Unprocessable Content` (Stripe uses `400`): the client reused a key for a different request, which is a client bug you must surface loudly.
6. **Execute inside a transaction.** Perform the business operation and persist the result. Critically, **write the idempotency record and the business record in the same transaction** where possible — otherwise a crash between them leaves a key marked complete with no charge, or a charge with no key.
7. **Store the response.** Persist status code, selected headers (`Location`, `Content-Type`), and the response body, then set state to `completed`. Set a TTL of 24 hours.
8. **Return.** `201 Created` with `Location: /v1/charges/ch_1P9x` on the first attempt; the identical `201` and body on every replay.
9. **Handle crashes.** A key stuck `in_progress` past a timeout (say 60 s) must be reclaimable — a sweeper marks it `failed` so a retry can proceed, or the recovery path re-derives the outcome from the business table by looking up the charge whose `idempotency_key` column matches.
10. **Downstream idempotency.** If the handler calls a payment processor, pass a **derived** key (`sha256(tenant, key, "psp")`) so the processor deduplicates too. Idempotency must be end-to-end or the duplicate simply moves one hop down.

> **Note:** Step 6 is where most implementations are subtly wrong. If your idempotency store is Redis and your business data is Postgres, you cannot make them atomic — so make the *business* table the source of truth by putting a unique index on `(tenant_id, idempotency_key)` there, and treat Redis purely as a fast path.

```svg
<svg viewBox="0 0 780 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="8" y="8" width="764" height="364" rx="14" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="390" y="34" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Server-side idempotency state machine</text>

  <rect x="290" y="52" width="200" height="42" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="390" y="70" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">POST + Idempotency-Key</text>
  <text x="390" y="86" text-anchor="middle" fill="#1e293b" font-size="10">fingerprint = sha256(method, path, body)</text>

  <path d="M390 94 L390 122" stroke="#4f46e5" stroke-width="2" fill="none"/>
  <polygon points="390,122 386,114 394,114" fill="#4f46e5"/>

  <rect x="256" y="122" width="268" height="42" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="390" y="140" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">INSERT ... ON CONFLICT DO NOTHING</text>
  <text x="390" y="156" text-anchor="middle" fill="#1e293b" font-size="10">the atomic claim is the lock</text>

  <path d="M256 143 L150 143 L150 196" stroke="#16a34a" stroke-width="2" fill="none"/>
  <polygon points="150,196 146,188 154,188" fill="#16a34a"/>
  <text x="150" y="136" text-anchor="middle" fill="#16a34a" font-size="10" font-weight="700">claimed</text>

  <path d="M524 143 L640 143 L640 196" stroke="#d97706" stroke-width="2" fill="none"/>
  <polygon points="640,196 636,188 644,188" fill="#d97706"/>
  <text x="640" y="136" text-anchor="middle" fill="#d97706" font-size="10" font-weight="700">row exists</text>

  <rect x="40" y="196" width="220" height="70" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="150" y="218" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">state = in_progress</text>
  <text x="150" y="236" text-anchor="middle" fill="#1e293b" font-size="10">execute in one transaction</text>
  <text x="150" y="252" text-anchor="middle" fill="#1e293b" font-size="10">store status + headers + body</text>

  <path d="M150 266 L150 296" stroke="#16a34a" stroke-width="2" fill="none"/>
  <polygon points="150,296 146,288 154,288" fill="#16a34a"/>
  <rect x="40" y="296" width="220" height="46" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="150" y="316" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">201 Created</text>
  <text x="150" y="332" text-anchor="middle" fill="#1e293b" font-size="10">Location: /v1/charges/ch_1P9x</text>

  <rect x="530" y="196" width="220" height="52" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="640" y="216" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">completed + fingerprint ok</text>
  <text x="640" y="234" text-anchor="middle" fill="#1e293b" font-size="10">replay stored response, 200/201</text>

  <rect x="530" y="256" width="220" height="42" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="640" y="273" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">still in_progress</text>
  <text x="640" y="290" text-anchor="middle" fill="#1e293b" font-size="10">409 Conflict + Retry-After: 1</text>

  <rect x="530" y="306" width="220" height="42" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="640" y="323" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">fingerprint mismatch</text>
  <text x="640" y="340" text-anchor="middle" fill="#1e293b" font-size="10">422 &#8212; key reused for a different body</text>

  <rect x="290" y="196" width="220" height="152" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="400" y="220" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Client retry policy</text>
  <text x="400" y="244" text-anchor="middle" fill="#1e293b" font-size="10">same key on every attempt</text>
  <text x="400" y="264" text-anchor="middle" fill="#1e293b" font-size="10">full jitter: rand(0, base &#215; 2^n)</text>
  <text x="400" y="284" text-anchor="middle" fill="#1e293b" font-size="10">cap 20 s, max 5 tries</text>
  <text x="400" y="304" text-anchor="middle" fill="#1e293b" font-size="10">absolute deadline overrides</text>
  <text x="400" y="324" text-anchor="middle" fill="#1e293b" font-size="10">honour Retry-After on 429/503</text>
  <text x="400" y="342" text-anchor="middle" fill="#1e293b" font-size="10">circuit breaker + retry budget</text>
</svg>
```

## 5. Implementation

### The exchange

```http
POST /v1/charges HTTP/1.1
Host: api.zariya.in
Authorization: Bearer sk_live_…
Idempotency-Key: 3f2a9c1e-7b44-4d0a-9e21-8c5f0b6d1a33
Content-Type: application/json

{"amount_inr": 249900, "currency": "INR", "customer": "cus_7Kq", "capture": true}
```

```http
HTTP/1.1 201 Created
Location: /v1/charges/ch_1P9xQ2
Content-Type: application/json

{"id":"ch_1P9xQ2","amount_inr":249900,"status":"succeeded","created":1753171200}
```

The retry, after a timeout — byte-identical body, same key:

```http
HTTP/1.1 201 Created
Location: /v1/charges/ch_1P9xQ2
Idempotent-Replayed: true
Content-Type: application/json

{"id":"ch_1P9xQ2","amount_inr":249900,"status":"succeeded","created":1753171200}
```

Key reused with a different body — an RFC 9457 problem document:

```http
HTTP/1.1 422 Unprocessable Content
Content-Type: application/problem+json

{"type":"https://api.zariya.in/problems/idempotency-key-reuse","status":422,
 "title":"Idempotency key reused with a different request body",
 "detail":"Key 3f2a9c1e… was first used with a different payload. Generate a new key."}
```

### Schema

```yaml
table: idempotency_keys          # primary key (tenant_id, key); index on created_at for TTL
columns:
  tenant_id: uuid not null       # scope keys per tenant — never key alone
  key: text not null
  fingerprint: text not null     # sha256(method|path|canonical_body)
  state: text not null           # in_progress | completed | failed
  response_status: int
  response_headers: jsonb
  response_body: jsonb
  locked_until: timestamptz      # reclaim window for crashed workers
  created_at: timestamptz not null default now()
```

### FastAPI implementation

```python
import hashlib, json, uuid
from fastapi import APIRouter, Header, Request, Response, HTTPException

router = APIRouter()

CLAIM_SQL = """
INSERT INTO idempotency_keys (tenant_id, key, fingerprint, state, locked_until)
VALUES ($1, $2, $3, 'in_progress', now() + interval '60 seconds')
ON CONFLICT (tenant_id, key) DO UPDATE
  SET locked_until = now() + interval '60 seconds'
  WHERE idempotency_keys.state = 'in_progress'
    AND idempotency_keys.locked_until < now()
RETURNING state
"""


def fingerprint(method: str, path: str, body: bytes) -> str:
    canonical = json.dumps(json.loads(body or b"{}"), sort_keys=True,
                           separators=(",", ":")).encode()
    return hashlib.sha256(f"{method}|{path}|".encode() + canonical).hexdigest()


@router.post("/v1/charges", status_code=201)
async def create_charge(request: Request, response: Response, db=None,
                        idempotency_key: str = Header(None, alias="Idempotency-Key")):
    try:
        uuid.UUID(idempotency_key or "")
    except ValueError:
        raise HTTPException(400, "Idempotency-Key header must be a UUID")

    tenant, body = request.state.tenant_id, await request.body()
    fp = fingerprint("POST", request.url.path, body)

    async with db.transaction():
        claimed = await db.fetchrow(CLAIM_SQL, tenant, idempotency_key, fp)

        if claimed is None:                       # someone else owns this key
            row = await db.fetchrow(
                "SELECT * FROM idempotency_keys WHERE tenant_id=$1 AND key=$2",
                tenant, idempotency_key)
            if row["fingerprint"] != fp:
                raise HTTPException(422, "Idempotency key reused with a different body")
            if row["state"] == "in_progress":
                raise HTTPException(409, "Request with this key is still in progress",
                                    headers={"Retry-After": "1"})
            return Response(                      # exact replay of the original
                content=json.dumps(row["response_body"]).encode(),
                status_code=row["response_status"], media_type="application/json",
                headers={**row["response_headers"], "Idempotent-Replayed": "true"})

        # First attempt: do the real work in the SAME transaction as the key update.
        charge = await db.create_charge(tenant=tenant, idempotency_key=idempotency_key,
                                        **json.loads(body))
        result = {"id": charge["id"], "amount_inr": charge["amount_inr"],
                  "status": charge["status"], "created": charge["created"]}
        headers = {"Location": f"/v1/charges/{charge['id']}"}
        await db.execute(
            """UPDATE idempotency_keys SET state='completed', response_status=201,
               response_headers=$3, response_body=$4
               WHERE tenant_id=$1 AND key=$2""",
            tenant, idempotency_key, json.dumps(headers), json.dumps(result))

    response.headers["Location"] = headers["Location"]
    return result
```

> **Note:** The business table must carry its own `UNIQUE (tenant_id, idempotency_key)` constraint. That constraint — not the key table — is your last line of defence if the two stores ever diverge.

### Client: retry with full jitter and a deadline

```javascript
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

async function postIdempotent(url, body, { maxAttempts = 5, deadlineMs = 30_000 } = {}) {
  const key = crypto.randomUUID();        // ONE key for the whole logical operation
  const started = Date.now();
  let lastErr;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (Date.now() - started > deadlineMs) break;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });

      if (res.ok) return res.json();
      if (!RETRYABLE.has(res.status) && res.status !== 409) throw await res.json();
      lastErr = new Error(`HTTP ${res.status}`);
      const ra = Number(res.headers.get("Retry-After"));   // server knows best
      await sleep(ra > 0 ? ra * 1000 : jitter(attempt));
    } catch (e) {
      lastErr = e;                          // timeout / connection error: retry is safe
      await sleep(jitter(attempt));
    }
  }
  throw lastErr ?? new Error("retries exhausted");
}

const jitter = n => Math.random() * Math.min(20_000, 100 * 2 ** n);  // full jitter
const sleep = ms => new Promise(r => setTimeout(r, ms));
```

### Optimization note

The idempotency lookup sits on the hot path of every write, so keep it cheap. Use a **two-tier store**: a Redis `SET key value NX EX 86400` as the fast claim (sub-millisecond, absorbs the overwhelming majority of duplicate probes) backed by the Postgres unique constraint for correctness. Keep the stored response body small — persist a compact canonical form, not the full serialized envelope with debug fields. Sweep expired keys with a partial index on `created_at` and batched `DELETE … LIMIT 10000` rather than one giant statement that locks the table. And measure: if `idempotency_lookup_ms` at p99 approaches your handler's total budget, you have made writes slower to make them safer, and the fast path needs work.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost/Trade-off |
|---|---|---|
| Client-supplied key | Client controls operation identity; works across process restarts and user retries | Clients get it wrong — new key per attempt, or the same key for different operations |
| Server-side dedup store | Effectively-once semantics for non-idempotent operations | An extra write on every request plus a store to size, shard, and expire |
| Response replay | Retries are transparent; the client sees one consistent outcome | Must store response bodies, which is storage and a PII-retention question |
| `409` on in-flight keys | Prevents concurrent double-execution cleanly | Clients must handle `409` as retryable, which naive libraries do not |
| Fingerprint check | Catches key-reuse bugs loudly instead of silently replaying a wrong response | Requires canonical serialization; whitespace or key-order changes cause false mismatches |
| Exponential backoff + jitter | Sheds load exactly when a service is struggling and breaks retry storms | Worst-case latency grows to tens of seconds and becomes less predictable |
| Retry budget / circuit breaker | Prevents retry amplification from turning a blip into an outage | Adds failures during partial degradation that a retry might have papered over |
| 24-hour key TTL | Covers human and batch retries | Storage growth; a retry after the window silently duplicates |

## 7. Common Mistakes & Best Practices

1. ⚠️ Generating a new idempotency key on each retry attempt → ✅ the key identifies the *logical operation*; create it once, before the first attempt, and reuse it for every retry including retries after a process restart.
2. ⚠️ Retrying a timed-out `POST` with no idempotency key → ✅ never retry a non-idempotent request without one; either add the key or fail the operation and surface the ambiguity to the user.
3. ⚠️ `SELECT` then `INSERT` to check the key → ✅ two concurrent retries will both pass the `SELECT`; use a single atomic `INSERT … ON CONFLICT` or `SET NX` so the write itself is the lock.
4. ⚠️ Writing the business record and the idempotency record in separate transactions → ✅ commit them together, and add a `UNIQUE (tenant_id, idempotency_key)` constraint on the business table as the authoritative guard.
5. ⚠️ Returning `200` with a *new* charge when a completed key is replayed → ✅ replay the original stored status, headers, and body verbatim, plus `Idempotent-Replayed: true`.
6. ⚠️ Retrying `400`, `403`, `404`, or `422` → ✅ these are deterministic; retrying wastes capacity and hides the real bug. Retry only connection errors, timeouts, `408`, `425`, `429`, and `5xx`.
7. ⚠️ Exponential backoff without jitter → ✅ a fleet retrying at exactly T+1, T+2, T+4 recreates the spike that caused the failure; use full jitter, `random(0, min(cap, base × 2^n))`.
8. ⚠️ Retrying at every layer of the stack → ✅ retry at one layer only, enforce a retry budget of ~10% of traffic, and propagate deadlines so inner calls abort when the outer deadline is gone.
9. ⚠️ Ignoring `Retry-After` on `429` and `503` → ✅ the server knows better than your backoff formula; honour it, and treat exceeding your own deadline as a hard stop.
10. ⚠️ Keys not scoped per tenant or per API key → ✅ scope to `(tenant_id, key)` so one customer's UUID collision or probing cannot read another's stored response.
11. ⚠️ Keys stuck `in_progress` forever after a worker crash → ✅ store `locked_until` so a retry can reclaim an expired lock, then reconstruct the outcome from the business table before re-executing.
12. ⚠️ Not propagating idempotency downstream → ✅ derive a stable key (`sha256(tenant, key, "psp")`) so your payment processor deduplicates too; otherwise the duplicate moves one hop away.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Log the idempotency key on every request line and attach it to your trace as a span attribute — it is the only identifier that ties all attempts of one logical operation together, and it is worth more than a request ID during an incident. When investigating "the customer was charged twice," query the business table for the two charges and compare their `idempotency_key` values: if they differ, the client generated a new key per attempt (a client bug); if one is null, the request bypassed the idempotent path entirely (a routing or gateway bug); if they are equal, your dedup store or transaction boundary is broken (a server bug). Those three cases have completely different fixes, and the key tells you which one you are in within seconds. Also verify the header actually reaches your handler — gateways and service meshes strip unknown headers by default more often than anyone expects.

**Monitoring.** Track: **duplicate rate** (`replayed / total` on idempotent endpoints) — a healthy API sits around 0.1–2%, and a spike means a client is retrying too aggressively or a dependency is timing out; **`409` in-flight rate**, which indicates clients retrying faster than your p99 handler latency; **fingerprint-mismatch `422` count** per API key, which is a direct signal of a broken integration and is worth an automated email to that customer; **retry ratio** (`retries / initial_requests`) with an alert above 10%; **idempotency store latency and size**; and **keys stuck `in_progress`**, which points at crashed workers. Add a dashboard panel for retry-storm detection: a sudden correlated rise in `5xx` plus retry ratio is the shape of an outage about to be amplified by your own clients.

**Security.** The idempotency store holds full response bodies, so it inherits the sensitivity of your most sensitive endpoint — encrypt it at rest, apply the same retention policy you apply to the underlying records, and redact fields you are not permitted to keep for 24 hours. Scope keys per tenant so a key is never a cross-tenant oracle: if an attacker can guess another tenant's key and receive their stored response, you have built a data-leak endpoint. Rate-limit key creation to stop a client from filling your store, and cap key length (128 characters is generous) to prevent memory abuse. Finally, be careful about what the `422` fingerprint-mismatch response reveals — say that the key was used with a different body, never echo the original body.

**Performance & scaling.** The dedup store is written on every mutating request, so it must scale with your write volume, not your key-collision volume. Shard by tenant, use a TTL-native store (Redis with `EX`, DynamoDB with TTL, or Postgres with a partitioned table and a partition-drop sweeper — never a bulk `DELETE` on an unpartitioned hot table). Under load shedding, prefer failing fast with `503` plus `Retry-After` over queueing, because queued requests will time out and generate more retries. Circuit breakers belong on the client and on any service-to-service hop; combine them with a retry budget so the breaker opening does not simply move the load to another path.

## 9. Interview Questions

**Q: Which HTTP methods are idempotent, and why is `POST` not one of them?**
A: `GET`, `HEAD`, `OPTIONS`, and `TRACE` are safe and therefore idempotent; `PUT` and `DELETE` are idempotent because they specify an absolute target state or removal. `POST` submits data for processing and by convention creates a new subordinate resource each time, so two identical `POST`s create two resources. `PATCH` is also not idempotent in general, because operations like "append to array" or "increment" compound.

**Q: What exactly is an idempotency key and where does it come from?**
A: It is a unique token — normally a UUIDv4 — generated by the *client*, once per logical operation, and sent as `Idempotency-Key`. The server stores it with the operation's outcome, so any later request bearing the same key returns the stored response instead of executing again. The client generates it because only the client knows which attempts constitute the same logical operation.

**Q: Why can't we just have exactly-once delivery?**
A: Over an unreliable network, a timeout is indistinguishable from a lost response, so the sender must choose between retrying (at-least-once, risking duplicates) and not retrying (at-most-once, risking loss). No protocol removes that choice. What systems build instead is at-least-once delivery combined with idempotent processing, which yields effectively-once semantics.

**Q: What should the server return if the same key arrives while the first request is still running?**
A: `409 Conflict`, ideally with `Retry-After: 1`, meaning "this operation is in flight, ask again shortly." Returning `200` with an empty or partial result would be a lie, and blocking the second request risks tying up a connection for the duration of a slow operation.

**Q: Why store a fingerprint of the request body alongside the key?**
A: So you can detect a client reusing one key for two different operations. Without the fingerprint you would silently replay the first operation's response for a completely different request, which is far worse than an error — the client believes their second operation succeeded when it never ran. On mismatch, return `422` (or `400`) and say so explicitly.

**Q: Which HTTP status codes are safe to retry?**
A: Connection errors and timeouts (with an idempotency key), `408 Request Timeout`, `425 Too Early`, `429 Too Many Requests`, and `500`/`502`/`503`/`504`. Do not retry `400`, `401`, `403`, `404`, `409` on a fingerprint mismatch, or `422` — those are deterministic and will fail identically. Always honour `Retry-After` when present.

**Q: What is jitter and why does backoff need it?**
A: Jitter is randomization added to the backoff delay. Without it, every client that failed at the same instant retries at the same instants — T+1s, T+2s, T+4s — producing synchronized load spikes exactly while the service is trying to recover. Full jitter, `random(0, min(cap, base × 2^attempt))`, spreads those retries uniformly and in AWS's simulations minimizes both total work and completion-time variance.

**Q: (Senior) How do you make the idempotency record and the business write atomic when they live in different stores?**
A: You cannot make them atomic, so you stop relying on it: put a `UNIQUE (tenant_id, idempotency_key)` constraint on the business table itself and treat that as the source of truth, using the fast store (Redis) only as a cache to avoid hitting the database for the common duplicate case. On a fast-store miss, the unique-constraint violation on insert tells you the operation already happened, and you rebuild the response by reading the existing row. The alternative is a transactional outbox, where the key record and business record are written in one database transaction and the response is materialized afterwards.

**Q: (Senior) Explain retry amplification and how you bound it.**
A: If each of N layers retries three times, one user request can become 3^N calls at the bottom of the stack, so a transient blip in a leaf service becomes a self-inflicted DDoS precisely when it is least able to cope. You bound it by retrying at only one layer — normally the one closest to the user — enforcing a retry budget capping retries at roughly 10% of request volume, propagating an absolute deadline so inner calls abort when the outer deadline has passed, and adding circuit breakers that stop sending traffic to a dependency that is already failing.

**Q: (Senior) What happens when a worker crashes after creating the charge but before marking the key completed?**
A: The key is left `in_progress`, so naive implementations either replay `409` forever or, worse, let a retry create a second charge. The fix is a lease: store `locked_until`, and let a retry after lease expiry reclaim the row — but before re-executing, the handler must check whether the business operation already succeeded, which is exactly what the `UNIQUE (tenant_id, idempotency_key)` column on the business table lets you do. Recover the existing record, materialize the response, and mark the key completed.

**Q: (Senior) How long should keys be retained, and what breaks at the boundary?**
A: Long enough to cover your clients' maximum retry horizon plus human and batch retries — 24 hours is the industry norm and 72 hours is defensible for financial operations. Past the window, a retry with the same key is treated as a brand-new request and duplicates the operation silently, so the TTL must exceed any documented client retry policy, and expiry should be an explicit, monitored process rather than an accidental consequence of cache eviction.

**Q: Should `GET` endpoints accept an idempotency key?**
A: No. `GET` is already safe and idempotent by definition, so a key adds storage and latency for nothing. Reserve keys for `POST` and for any `PATCH` whose semantics are not naturally idempotent; `PUT` and `DELETE` normally do not need one either, though a key can still be useful when the response body itself must be stable across retries.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** `POST` is neither safe nor idempotent, and a timeout never tells you whether the write landed — so the client generates one UUID per *logical operation*, sends it as `Idempotency-Key`, and reuses it on every retry. The server claims the key atomically (`INSERT … ON CONFLICT DO NOTHING`), executes the operation and stores the response in the same transaction, and thereafter replays that stored response with `Idempotent-Replayed: true`. A key seen while the original is still running gets `409` plus `Retry-After`; a key reused with a different body fingerprint gets `422`. Keys are scoped per tenant and expire after ~24 hours. On the client, retry only connection errors, timeouts, `408`/`425`/`429`, and `5xx`, using full jitter `random(0, min(cap, base × 2^n))`, an attempt cap, an absolute deadline, a retry budget, and a circuit breaker. Exactly-once does not exist; at-least-once delivery plus idempotent processing does.

| Item | Value |
|---|---|
| Header | `Idempotency-Key: <uuid-v4>` |
| Replay marker | `Idempotent-Replayed: true` |
| First success | `201 Created` + `Location` |
| Replayed success | Same status and body as the original |
| In-flight duplicate | `409 Conflict` + `Retry-After: 1` |
| Key reused, different body | `422 Unprocessable Content` |
| Missing required key | `400` (or `428 Precondition Required`) |
| Storage key / retention | `(tenant_id, key)`, never key alone · 24 h (72 h for money) |
| Backoff | `random(0, min(20s, 100ms × 2^attempt))` |
| Retry budget | ≤ 10% of request volume |

**Flash cards**

- **Why is `POST` not idempotent?** → It submits data for processing and conventionally creates a new subordinate resource each time, so N identical calls create N resources.
- **One key per what?** → One key per *logical operation*, reused across every retry. A new key per attempt defeats the mechanism entirely.
- **Response to an in-flight duplicate** → `409 Conflict` with `Retry-After`, not `200` and not a block.
- **Full jitter formula** → `delay = random(0, min(cap, base × 2^attempt))`.
- **Exactly-once, honestly** → Impossible on the wire; achieved as at-least-once delivery plus idempotent processing.

## 11. Hands-On Exercises & Mini Project

- [ ] Add `Idempotency-Key` support to one `POST` endpoint using a single atomic `INSERT … ON CONFLICT DO NOTHING`, then fire 50 concurrent identical requests and assert exactly one record was created.
- [ ] Break it deliberately: replace the atomic claim with `SELECT` then `INSERT`, rerun the concurrency test, and count the duplicates. Record the number — it is the most persuasive argument you will ever make in a code review.
- [ ] Implement full jitter, equal jitter, and no jitter in a simulator with 5,000 clients failing simultaneously, and plot requests-per-second at the server for each strategy.
- [ ] Kill the process between the business insert and the key completion, then verify your recovery path returns the original response rather than creating a duplicate.
- [ ] Write a test asserting that reusing a key with a modified body returns `422` and that the original operation is unchanged.

### Mini Project — An idempotent payments endpoint

**Goal.** Build `POST /v1/charges` with production-grade idempotency and a matching client SDK, then prove correctness under adversarial conditions.

**Requirements.**
1. Require `Idempotency-Key`; validate it is a UUID and reject missing or malformed keys with `400`. Store the full key table with a 24-hour TTL sweeper.
2. Claim atomically, and support lease reclamation after 60 s so crashed workers do not wedge a key permanently.
3. Return `201` + `Location` first, exact replay with `Idempotent-Replayed: true` after, `409` + `Retry-After` while in flight, and `422` on fingerprint mismatch (as RFC 9457 problem+json).
4. Add `UNIQUE (tenant_id, idempotency_key)` on the charges table and prove it catches divergence between the two stores.
5. Ship a client with full jitter, a 30 s deadline, a 5-attempt cap, `Retry-After` handling, and a circuit breaker.
6. Chaos test: inject 30% response loss and 10% mid-transaction process kills, run 10,000 logical operations, and assert the charge count equals exactly 10,000.

**Extensions.**
- Add a derived downstream key so a mock payment processor also deduplicates, and prove end-to-end effectively-once.
- Add a retry budget at the client and show that it prevents amplification when the server returns sustained `503`.
- Emit `duplicate_rate`, `in_flight_409_rate`, and `fingerprint_mismatch_total` metrics and build a retry-storm alert.

## 12. Related Topics & Free Learning Resources

**Related chapters.** *Concurrency Control & Optimistic Locking* (chapter 28) — `If-Match` handles the *lost update* problem, which idempotency does not. *Async APIs, Webhooks & Long-Running Jobs* (chapter 29) — webhook delivery is at-least-once, so consumers need exactly this deduplication logic. *HTTP Caching: ETags & Cache-Control* (chapter 25) — the read-side counterpart to write-side safety. *Error Handling & Problem Details* — `422` and `409` bodies should be RFC 9457. *Rate Limiting* — `429` plus `Retry-After` is the server's half of a retry contract.

- **RFC 9110 §9.2 — Common Method Properties** — IETF · *Intermediate* · the normative definition of safe and idempotent methods, including the often-missed note that idempotency constrains state, not status codes. <https://www.rfc-editor.org/rfc/rfc9110.html#name-common-method-properties>
- **The Idempotency-Key HTTP Header Field (IETF draft)** — IETF HTTPAPI WG · *Intermediate* · the in-progress standardization of the header, including recommended status codes and failure modes. <https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/>
- **Stripe API — Idempotent Requests** — Stripe · *Beginner* · the reference implementation everyone copies: 24-hour retention, replay semantics, and `409` on concurrent keys, documented from the client's point of view. <https://docs.stripe.com/api/idempotent_requests>
- **Exponential Backoff and Jitter** — Marc Brooker, AWS Architecture Blog · *Intermediate* · the simulation that established full jitter as the default; short, quantitative, and directly actionable. <https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/>
- **Timeouts, Retries and Backoff with Jitter** — Amazon Builders' Library · *Advanced* · production guidance on retry budgets, deadline propagation, and how retries turn brownouts into outages. <https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/>
- **Google SRE Book — Handling Overload & Addressing Cascading Failures** — Google · *Advanced* · chapters 21–22 explain retry amplification, per-client retry budgets, and load shedding with real incident reasoning. <https://sre.google/sre-book/handling-overload/>
- **Implementing Stripe-like Idempotency Keys in Postgres** — Brandur Leach · *Advanced* · a detailed walkthrough of transaction boundaries, recovery points, and why the atomic claim must be a single statement. <https://brandur.org/idempotency-keys>
- **RFC 9457 — Problem Details for HTTP APIs** — IETF · *Beginner* · the format your `409` and `422` idempotency errors should use so clients can handle them programmatically. <https://www.rfc-editor.org/rfc/rfc9457.html>

---

*REST API Handbook — chapter 27.*
