# 06 · HTTP Methods, Safety & Idempotency

> **In one line:** Every HTTP method carries three promises — safe, idempotent, cacheable — and those promises are the only thing that tells a client, a proxy or a retry loop whether it is allowed to send your request a second time.

---

## 1. Overview

A method is not a label; it is a **contract about consequences**. RFC 9110 §9 defines each method's semantics and, crucially, two properties that generic software depends on: **safe** (the request is read-only from the client's perspective) and **idempotent** (sending it N times has the same effect on server state as sending it once). A third property, **cacheable**, follows from the first. These properties are what let a browser prefetch a link, a CDN store a response, a load balancer replay a request after a node dies, and an SDK retry after a timeout — all without knowing a single thing about your domain.

The problem they solve is the **partial-failure ambiguity** at the heart of every distributed system. A client sends `POST /payments`, waits, and the connection dies. Did the payment happen? The client cannot tell: the request may never have arrived, or it may have been processed and the response lost. Only two facts resolve this — whether the operation is idempotent, and whether the server offers a deduplication mechanism. Get this wrong and you double-charge customers; get it right and retries become boring. This is the single most consequential chapter for correctness in the handbook.

The lineage is instructive. HTTP/1.0 (1996) already had `GET`, `HEAD` and `POST`. HTTP/1.1 added `PUT`, `DELETE`, `OPTIONS` and `TRACE` and, importantly, wrote down the safe/idempotent distinction so that intermediaries could act on it. `PATCH` arrived separately in **RFC 5789 (2010)** — deliberately defined as *not* idempotent, because a patch document can express relative changes. The current normative text is **RFC 9110 (2022)**; the older 7231 numbering you will see quoted in blog posts is retired. Idempotency keys are not in any RFC yet, though there is an active IETF draft; the de-facto standard is the `Idempotency-Key` header popularised by Stripe.

Concretely: **Stripe** requires an `Idempotency-Key` on every mutating request and stores the first response against that key for 24 hours, so a retried charge returns the original result instead of charging again. **AWS** uses `ClientToken` for the same purpose. **Kubernetes** relies on `PUT` idempotency plus `resourceVersion` preconditions so a controller can reconcile the same desired state a thousand times a minute without churning. Every one of these is the same insight: **make the operation replay-safe, and the unreliable network stops being a correctness problem.**

## 2. Core Concepts

- **Safe** — the method is not *intended* to modify state; the client incurs no obligation by sending it. `GET`, `HEAD`, `OPTIONS`, `TRACE`. Server-side logging and counters do not break safety.
- **Idempotent** — N identical requests leave the server in the same state as one. `GET`, `HEAD`, `OPTIONS`, `TRACE`, `PUT`, `DELETE`. Says nothing about the *response* being identical.
- **Cacheable** — a response may be stored and reused. `GET` and `HEAD` by default; `POST` only with explicit freshness information (rare in practice).
- **`GET`** — retrieve a representation. No request body semantics; never use it for anything with side effects.
- **`HEAD`** — identical to `GET` but the server returns headers only. Useful for existence checks, size probes and validator refreshes.
- **`POST`** — process the enclosed representation according to the resource's own semantics. The general-purpose method: create a subordinate resource, submit to a process resource, run a non-idempotent operation.
- **`PUT`** — replace the target resource's state entirely with the enclosed representation. Idempotent by definition; omitted fields mean "absent".
- **`PATCH`** — apply a partial modification described by a patch document. **Not inherently idempotent** (RFC 5789); whether it is depends on the patch format and the operations used.
- **`DELETE`** — remove the resource. Idempotent: after the first success the resource is gone, and subsequent calls return `404` or `204` without changing state further.
- **`OPTIONS`** — describe the communication options; the mechanism behind CORS preflight.
- **Idempotency key** — a client-generated unique token (`Idempotency-Key: <uuid>`) that lets a server deduplicate retries of a non-idempotent operation.
- **Optimistic concurrency** — `ETag` + `If-Match` preconditions that make a write conditional on the state the client last observed, yielding `412 Precondition Failed` on conflict.

## 3. Theory & Principles

### The three properties, precisely

| Method | Safe | Idempotent | Cacheable | Request body | Typical success |
|---|---|---|---|---|---|
| `GET` | ✅ | ✅ | ✅ | no | `200`, `206`, `304` |
| `HEAD` | ✅ | ✅ | ✅ | no | `200` (no body) |
| `OPTIONS` | ✅ | ✅ | ❌ | no | `204` |
| `TRACE` | ✅ | ✅ | ❌ | no | `200` (disable in production) |
| `POST` | ❌ | ❌ | only with explicit freshness | yes | `201` + `Location`, `202`, `200` |
| `PUT` | ❌ | ✅ | ❌ | yes | `200`, `201`, `204` |
| `PATCH` | ❌ | ❌ (not inherent) | ❌ | yes | `200`, `204` |
| `DELETE` | ❌ | ✅ | ❌ | usually not | `204`, `200`, `202` |

Three misreadings to kill immediately. **(1) Idempotent ≠ same response.** `DELETE /orders/9` returns `204` then `404`; the *state* is identical after both, which is what the property claims. **(2) Safe ≠ no server work.** A `GET` may write access logs, increment counters and populate caches; what it must not do is create an obligation for the client. **(3) Idempotent ≠ concurrency-safe.** Two clients each `PUT`ting a different representation still race; idempotency protects against *retries of the same request*, not against *interleaved different requests*. Preconditions (`If-Match`) handle the second problem.

### Why `PATCH` is not idempotent

`PUT /counters/9` with `{"value": 5}` sets the value to 5 no matter how many times you send it. A JSON Patch (RFC 6902) `[{"op":"add","path":"/tags/-","value":"urgent"}]` appends a tag *every* time it is applied — three retries, three tags. Even a JSON Merge Patch (RFC 7386) `{"status":"shipped"}` is idempotent in practice, but the *method* cannot be assumed idempotent by a generic client because the patch format is not constrained. This is why RFC 5789 explicitly says `PATCH` is neither safe nor idempotent, and why a `PATCH` retry needs either an idempotency key or an `If-Match` precondition.

### The retry decision tree

A client that has not received a response must decide whether to resend. The rule set that is actually correct:

- **Safe methods** (`GET`, `HEAD`, `OPTIONS`) — always retryable.
- **Idempotent writes** (`PUT`, `DELETE`) — retryable, but add `If-Match` if a concurrent writer would be a problem.
- **Non-idempotent writes** (`POST`, `PATCH`) — retryable **only** with an idempotency key, or if the operation is naturally deduplicated by a business key.
- **By status:** retry `408`, `425`, `429`, `500`, `502`, `503`, `504`. Never retry other `4xx` — the request itself is wrong and will fail identically. Honour `Retry-After` when present.
- **How:** exponential backoff with **full jitter** (`sleep = random(0, base * 2^attempt)`), a bounded attempt count, an overall deadline, and a circuit breaker so a dead dependency does not consume all your threads.

```svg
<svg viewBox="0 0 820 350" width="100%" height="350" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="i1" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#4f46e5"/></marker>
    <marker id="i2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="410" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">The partial-failure ambiguity, and what resolves it</text>
  <line x1="120" y1="44" x2="120" y2="240" stroke="#94a3b8" stroke-width="2"/>
  <line x1="640" y1="44" x2="640" y2="240" stroke="#94a3b8" stroke-width="2"/>
  <text x="120" y="40" text-anchor="middle" fill="#1e293b" font-weight="bold">Client</text>
  <text x="640" y="40" text-anchor="middle" fill="#1e293b" font-weight="bold">Server</text>

  <line x1="122" y1="72" x2="636" y2="72" stroke="#4f46e5" stroke-width="2" marker-end="url(#i1)"/>
  <text x="379" y="66" text-anchor="middle" fill="#1e293b" font-size="11">POST /v1/payments &#183; Idempotency-Key: 5f2c</text>
  <rect x="560" y="86" width="160" height="34" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="640" y="107" text-anchor="middle" fill="#1e293b" font-size="11">charge executed &#183; key stored</text>
  <line x1="636" y1="140" x2="380" y2="140" stroke="#dc2626" stroke-width="2" stroke-dasharray="5 4" marker-end="url(#i2)"/>
  <text x="470" y="134" text-anchor="middle" fill="#b91c1c" font-size="11">201 Created &#8212; response LOST</text>
  <text x="360" y="158" text-anchor="middle" fill="#b91c1c" font-size="11">client cannot distinguish "never arrived" from "reply lost"</text>

  <line x1="122" y1="190" x2="636" y2="190" stroke="#4f46e5" stroke-width="2" marker-end="url(#i1)"/>
  <text x="379" y="184" text-anchor="middle" fill="#1e293b" font-size="11">retry: same body, SAME Idempotency-Key: 5f2c</text>
  <line x1="636" y1="226" x2="124" y2="226" stroke="#16a34a" stroke-width="2"/>
  <text x="379" y="220" text-anchor="middle" fill="#1e293b" font-size="11">200 OK &#183; original result replayed &#183; no second charge</text>

  <rect x="20" y="256" width="380" height="82" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <rect x="420" y="256" width="380" height="82" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="34" y="278" fill="#15803d" font-size="12" font-weight="bold">Safe to retry blind</text>
  <text x="434" y="278" fill="#b45309" font-size="12" font-weight="bold">Needs a key or a precondition</text>
  <g fill="#1e293b" font-size="11">
    <text x="34" y="298">GET &#183; HEAD &#183; OPTIONS &#8212; safe</text>
    <text x="34" y="316">PUT &#183; DELETE &#8212; idempotent</text>
    <text x="34" y="332">statuses 408, 425, 429, 5xx only</text>
    <text x="434" y="298">POST &#8212; creates something new each time</text>
    <text x="434" y="316">PATCH &#8212; RFC 5789: not idempotent</text>
    <text x="434" y="332">fix: Idempotency-Key, or If-Match + 412</text>
  </g>
</svg>
```

### `PUT` vs `POST` vs `PATCH`

`POST` when the server assigns the identifier — `POST /orders` returns `201` with `Location: /orders/ord_9F2`. `PUT` when the *client* knows the identifier and is asserting complete desired state — `PUT /users/usr_9/preferences`, `PUT /files/2026/report.pdf`. `PATCH` when you are changing part of an existing representation and sending the whole thing is wasteful or unsafe (you would clobber fields another client changed). A useful heuristic: **`PUT` is "make it look exactly like this"; `PATCH` is "change these bits"; `POST` is "do this thing".**

## 4. Architecture & Workflow

The full lifecycle of an idempotent write through a real stack:

1. **Client generates the key once.** A UUIDv4 created *before* the first attempt and reused across every retry of that logical operation. Generating a new key per attempt defeats the entire mechanism — the single most common implementation bug.
2. **Client sends `POST` with `Idempotency-Key` and a bounded timeout.** It also records the key locally so a process restart can resume with the same key.
3. **Gateway passes the header through** untouched and adds tracing. It must not strip unknown headers or rewrite the body, because the server fingerprints the request.
4. **Server looks up the key** in a fast, durable store (Redis with persistence, or a database table) scoped by **(api key/tenant, endpoint, idempotency key)** so one tenant cannot collide with another.
5. **Three outcomes.** *Miss* — insert a row in state `in_progress` with a unique constraint, then execute. *Hit, completed* — return the stored status, headers and body verbatim; do not re-execute. *Hit, in progress* — return `409 Conflict` (or `425 Too Early`) telling the client to wait; two concurrent retries must never both execute.
6. **Fingerprint check.** Store a hash of the request body. If the same key arrives with a *different* body, that is a client bug — respond `422` (Stripe returns an `idempotency_error`) rather than silently serving the old result.
7. **Execute atomically.** Ideally the business write and the idempotency record commit in the *same* database transaction; otherwise you can charge the card and then fail to record the key. Where a transaction is impossible, write the key first and reconcile.
8. **Store the response** — status code, selected headers (`Location`, `ETag`) and body — with a TTL (24 hours is the Stripe convention).
9. **Replay.** Any retry inside the TTL returns the stored response, usually with `200` rather than `201` and often an `Idempotency-Replayed: true` header for observability.
10. **After TTL expiry** the key is forgotten and a replay would execute again — so the TTL must comfortably exceed your longest client retry window.

```svg
<svg viewBox="0 0 820 370" width="100%" height="370" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="j1" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#4f46e5"/></marker>
  </defs>
  <text x="410" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Server-side idempotency: one key, three outcomes</text>
  <rect x="20" y="46" width="150" height="50" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="95" y="70" text-anchor="middle" fill="#1e293b" font-weight="bold">POST + key</text>
  <text x="95" y="86" text-anchor="middle" fill="#475569" font-size="11">body hash computed</text>

  <rect x="230" y="46" width="170" height="50" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="315" y="70" text-anchor="middle" fill="#1e293b" font-weight="bold">lookup (tenant,</text>
  <text x="315" y="86" text-anchor="middle" fill="#1e293b" font-weight="bold">endpoint, key)</text>
  <line x1="172" y1="71" x2="226" y2="71" stroke="#4f46e5" stroke-width="2" marker-end="url(#j1)"/>

  <g stroke-width="2">
    <rect x="470" y="40" width="330" height="56" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
    <rect x="470" y="112" width="330" height="56" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
    <rect x="470" y="184" width="330" height="56" rx="8" fill="#fef3c7" stroke="#d97706"/>
  </g>
  <g fill="#1e293b" font-size="11">
    <text x="484" y="60" font-weight="bold">MISS &#8594; insert in_progress, execute, store result</text>
    <text x="484" y="80">201 Created &#183; Location &#183; body persisted with 24h TTL</text>
    <text x="484" y="132" font-weight="bold">HIT, completed &#8594; replay stored response</text>
    <text x="484" y="152">200 OK &#183; Idempotency-Replayed: true &#183; NO re-execution</text>
    <text x="484" y="204" font-weight="bold">HIT, in_progress &#8594; concurrent retry</text>
    <text x="484" y="224">409 Conflict &#183; client waits and retries with backoff</text>
  </g>
  <g stroke="#4f46e5" stroke-width="2" marker-end="url(#j1)">
    <line x1="402" y1="62" x2="466" y2="62"/><line x1="402" y1="71" x2="466" y2="138"/>
    <line x1="402" y1="82" x2="466" y2="208"/>
  </g>

  <rect x="20" y="264" width="780" height="94" rx="8" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="34" y="286" fill="#1e293b" font-size="12" font-weight="bold">Two guards that must both exist</text>
  <g fill="#1e293b" font-size="11">
    <text x="34" y="308">1. Unique constraint on (tenant, endpoint, key) &#8212; makes the MISS path race-proof at the database level</text>
    <text x="34" y="328">2. Body fingerprint &#8212; same key + different body &#8594; 422, never silently replay a mismatched result</text>
    <text x="34" y="348">Commit the business write and the idempotency record in ONE transaction, or the guarantee is only best-effort</text>
  </g>
</svg>
```

> **Note:** `PUT` and `DELETE` need no idempotency key — the method already guarantees replay safety. Adding keys everywhere is a smell that the API is really RPC over `POST`.

## 5. Implementation

### The exchanges

```http
POST /v1/payments HTTP/1.1
Host: api.example.com
Idempotency-Key: 5f2c9a11-7b0e-4c2f-9a51-0d3f1b2e77aa
Content-Type: application/json

{"order_id":"ord_9F2xQ","amount":74500,"currency":"inr"}

HTTP/1.1 201 Created
Location: /v1/payments/pay_3Kx91
Content-Type: application/json

{"id":"pay_3Kx91","status":"succeeded","amount":74500}
```

Retry after a lost response — same key, same body, no second charge:

```http
POST /v1/payments HTTP/1.1
Idempotency-Key: 5f2c9a11-7b0e-4c2f-9a51-0d3f1b2e77aa
Content-Type: application/json

{"order_id":"ord_9F2xQ","amount":74500,"currency":"inr"}

HTTP/1.1 200 OK
Idempotency-Replayed: true

{"id":"pay_3Kx91","status":"succeeded","amount":74500}
```

`PUT` (full replacement) versus `PATCH` (partial) — note what `PUT` silently destroys, and what a stale or missing precondition returns:

```http
PUT /v1/users/usr_9/preferences HTTP/1.1
Content-Type: application/json
If-Match: W/"prefs-v3"

{"theme":"dark","locale":"en-IN","notifications":{"email":true,"sms":false}}

HTTP/1.1 200 OK
ETag: W/"prefs-v4"

PATCH /v1/users/usr_9/preferences HTTP/1.1
Content-Type: application/merge-patch+json
If-Match: W/"prefs-v4"

{"theme":"light"}                      # locale and notifications are preserved

HTTP/1.1 200 OK
ETag: W/"prefs-v5"

PATCH /v1/orders/ord_9F2xQ HTTP/1.1    # stale validator
If-Match: W/"ord-9F2-v2"

HTTP/1.1 412 Precondition Failed
Content-Type: application/problem+json

{"type":"https://api.example.com/problems/stale-write","title":"Resource has changed",
 "status":412,"detail":"Current version is v4; you supplied v2. Re-read and retry."}

PATCH /v1/orders/ord_9F2xQ HTTP/1.1    # no If-Match at all

HTTP/1.1 428 Precondition Required
{"type":"https://api.example.com/problems/precondition-required",
 "title":"If-Match required","status":428}
```

### Server-side idempotency (FastAPI + Postgres)

```python
import hashlib, json
from fastapi import FastAPI, Header, HTTPException, Response, status
from typing import Annotated

app = FastAPI()

def fingerprint(body: dict) -> str:
    return hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()

@app.post("/v1/payments", status_code=status.HTTP_201_CREATED)
async def create_payment(
    body: PaymentCreate, response: Response, tenant=Depends(current_tenant),
    key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
):
    if key is None:
        raise HTTPException(400, "Idempotency-Key is required for this endpoint")
    fp = fingerprint(body.model_dump())

    async with db.transaction():                       # ONE transaction for both writes
        row = await db.fetchrow(
            "SELECT state, req_hash, status_code, resp_body FROM idempotency "
            "WHERE tenant=$1 AND endpoint=$2 AND key=$3 FOR UPDATE",
            tenant.id, "POST /v1/payments", key)

        if row and row["req_hash"] != fp:
            raise HTTPException(422, "Idempotency-Key reused with a different payload")
        if row and row["state"] == "completed":
            response.status_code = 200                 # replay: do NOT execute again
            response.headers["Idempotency-Replayed"] = "true"
            return json.loads(row["resp_body"])
        if row and row["state"] == "in_progress":
            raise HTTPException(409, "A request with this key is already in flight")

        await db.execute(                              # unique index makes this race-proof
            "INSERT INTO idempotency(tenant,endpoint,key,req_hash,state,expires_at) "
            "VALUES($1,$2,$3,$4,'in_progress', now() + interval '24 hours')",
            tenant.id, "POST /v1/payments", key, fp)

        payment = await charge(body)                   # the real, non-idempotent work
        await db.execute(
            "UPDATE idempotency SET state='completed', status_code=201, resp_body=$5 "
            "WHERE tenant=$1 AND endpoint=$2 AND key=$3 AND req_hash=$4",
            tenant.id, "POST /v1/payments", key, fp, json.dumps(payment))

    response.headers["Location"] = f"/v1/payments/{payment['id']}"
    return payment
```

```sql
CREATE TABLE idempotency (
  tenant text NOT NULL, endpoint text NOT NULL, key text NOT NULL,
  req_hash text NOT NULL, status_code int, resp_body jsonb,
  state text NOT NULL CHECK (state IN ('in_progress','completed')),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant, endpoint, key)      -- the race guard
);
CREATE INDEX ON idempotency (expires_at);  -- for the reaper job
```

### Client-side: retry only what is safe

```javascript
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);

async function request(method, url, { body, idempotencyKey, retries = 4 } = {}) {
  // A POST/PATCH may only be retried if the caller supplied a key.
  const replaySafe = IDEMPOTENT.has(method) || Boolean(idempotencyKey);

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json",
                 ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return res.json();

    const canRetry = replaySafe && RETRYABLE.has(res.status) && attempt < retries;
    if (!canRetry) throw Object.assign(new Error(res.statusText), { status: res.status });

    const after = Number(res.headers.get("Retry-After"));
    const wait = Number.isFinite(after) ? after * 1000
               : Math.random() * 250 * 2 ** attempt;      // full jitter
    await new Promise(r => setTimeout(r, wait));
  }
}

// The key is created ONCE per logical operation, not once per attempt.
const key = crypto.randomUUID();
await request("POST", "/v1/payments", { body: payload, idempotencyKey: key });
```

> **Optimization note.** Idempotency storage sits on your hottest write path, so keep it cheap: index only `(tenant, endpoint, key)`, store the response body compressed and capped (truncate anything over ~64 KB and re-derive on replay), give rows a TTL and reap them with a partitioned delete rather than a full scan, and keep the in-progress window short so `409`s are rare. If you use Redis, it must be persistent and replicated — losing the key store means duplicate charges, so this is not a cache. Also prefer *natural* idempotency where the domain allows it: a payment keyed by `(order_id, attempt_no)` with a unique constraint needs no separate machinery at all, and a `PUT` that sets desired state is idempotent for free.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| **Safe methods** | Free prefetching, caching and blind retries by browsers, CDNs and crawlers | Anything with a side effect behind `GET` will be triggered by machines you did not authorise — a classic real-world outage |
| **`PUT` idempotency** | Retry-safe by construction; ideal for reconciliation loops and declarative state | Requires the client to send the *complete* representation; omitted fields are destroyed |
| **`PATCH` partial update** | Minimal payloads, no clobbering of concurrently changed fields | Not idempotent; needs `If-Match` or a key, and the patch format must be specified (`merge-patch+json` vs RFC 6902) |
| **`DELETE` idempotency** | Retry after timeout is trivially safe | Second call returns `404`, which naive clients treat as an error; document it |
| **Idempotency keys** | Makes `POST` replay-safe; the only correct answer for payments and orders | New storage on the hot path, TTL and race semantics to get right, extra client discipline |
| **`If-Match` preconditions** | Prevents lost updates without pessimistic locking | Client must round-trip the `ETag`; conflicts surface as `412` the client must resolve |
| **`202 Accepted` for slow work** | Frees the connection, bounds latency, natural retry semantics | Client must poll or subscribe; you now operate a job resource and a status endpoint |
| **Strict method semantics** | Generic tooling (SDKs, gateways, meshes) behaves correctly with no per-API config | Some genuine operations fit awkwardly and need reification into process resources |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Side effects behind `GET`** — `GET /users/9/delete`, `GET /jobs/9/retry`. Prefetchers, link scanners, antivirus proxies and browser preload will fire these unattended. ✅ Any state change is `POST`, `PUT`, `PATCH` or `DELETE`, without exception.
2. ⚠️ **Generating a new idempotency key on every retry attempt.** This is the most common implementation bug and it makes the header decorative. ✅ Generate once per logical operation, persist it with the operation, reuse it across every attempt and every process restart.
3. ⚠️ **Assuming `PATCH` is idempotent.** RFC 5789 says it is not, and a JSON Patch `add` to an array proves it. ✅ Require `If-Match` or an idempotency key on `PATCH`, and specify the patch media type explicitly.
4. ⚠️ **Using `PUT` for partial updates.** Fields the client omitted must be cleared; teams discover this when a mobile client wipes a user's preferences. ✅ `PATCH` for partial change; `PUT` only when the client genuinely sends the complete desired state.
5. ⚠️ **Retrying non-idempotent requests blindly** in an SDK, a service mesh or a load balancer. ✅ Configure retries per method and per status; never enable mesh-level retries on `POST` without keys.
6. ⚠️ **Retrying `4xx`.** A `400` or `422` will fail identically forever, and retrying `429` without backoff amplifies the outage. ✅ Retry `408`, `425`, `429` and `5xx` only, with exponential backoff plus full jitter and a bounded deadline.
7. ⚠️ **Idempotency records committed separately from the business write.** The charge succeeds, the key insert fails, and the retry charges again. ✅ One transaction, or a durable outbox with reconciliation.
8. ⚠️ **Ignoring the concurrent-duplicate case.** Two retries arrive simultaneously and both execute because the check-then-act was not atomic. ✅ A unique constraint on `(tenant, endpoint, key)` plus an `in_progress` state that returns `409`.
9. ⚠️ **Not scoping keys per tenant/credential.** A guessable or colliding key from another tenant leaks a stored response. ✅ Scope by authenticated principal and endpoint; treat keys as opaque and unguessable.
10. ⚠️ **Replaying a stored response for a *different* body.** Silently returning the old result hides a serious client bug and can confirm an unrelated payment. ✅ Fingerprint the body; mismatched reuse is `422`.
11. ⚠️ **`DELETE` that is not actually idempotent** — decrementing a counter, appending an audit row per call, or returning `500` on the second attempt. ✅ Make the second call a no-op returning `404` or `204`.
12. ⚠️ **Long-running work held open on a `POST`.** Gateways time out at 30–60 s and the client retries a job already running. ✅ Return `202 Accepted` with a `Location` pointing at a job resource, and let the client poll or receive a webhook.

## 8. Production: Debugging, Monitoring, Security & Scaling

### Debugging

Duplicate-write incidents are diagnosed by joining three facts: the idempotency key, the request id and the business entity id — so log all three on every mutating request and index the key. When a customer reports a double charge, look for two rows with different keys (a client bug generating per-attempt keys) versus one key with two executions (a server race or a transaction boundary bug). Test the ambiguous case deliberately: a fault-injection proxy that drops the *response* after the server has committed is the only way to exercise the path that matters. Also check every layer that might retry silently — SDK, service mesh, load balancer, CDN — since a mesh retry on `POST` reproduces exactly this bug without any client involvement.

### Monitoring

Track, per endpoint: the **idempotency hit rate** (replays / total — a rising rate means clients are timing out and is an early warning of latency regressions), `409 in_progress` rate (concurrency in the retry path), `422` fingerprint-mismatch rate (a client bug you should report to that consumer), and idempotency-store latency and size. Track retry behaviour: attempts per logical operation, and the ratio of `429`/`503` responses to retries so you can spot retry storms. Alert on any duplicate business entity created within the TTL window — a direct correctness signal. On the method side, watch the distribution of methods per route: `GET`s appearing on a mutating route, or a route that only ever sees `POST`, both indicate a modelling problem.

### Security

Idempotency keys must be **unguessable and scoped**, because a stored response can contain sensitive data — treat a key as a capability and always partition by authenticated principal. Rate-limit key creation so an attacker cannot exhaust your store. Never accept a client-supplied key as an identifier that appears in a URL. Keep `TRACE` disabled (cross-site tracing). Make sure `OPTIONS` responses do not leak the existence of resources the caller may not access. And remember that idempotency is not authorization: a replayed request must still be checked against the current permissions of the caller, not the permissions captured at first execution.

### Performance & scaling

The idempotency store is on the critical path of every write, so size it accordingly: a persistent, replicated store with a short TTL, small rows, and a background reaper. Prefer natural idempotency (unique business keys, `PUT` of desired state) wherever the domain allows it and skip the machinery. Push long operations to `202 Accepted` + job resources so front-end connections are not held. Configure retry budgets — a global cap on the fraction of traffic that may be retries (Envoy and gRPC both support this) — because uncoordinated client retries are the classic cause of metastable failure, where a brief blip becomes a self-sustaining overload. Combine with circuit breakers and load shedding that returns `503` + `Retry-After` early rather than queueing.

## 9. Interview Questions

**Q: What does it mean for an HTTP method to be safe?**
A: The method is not intended to change server state; the client incurs no obligation by sending it. `GET`, `HEAD`, `OPTIONS` and `TRACE` are safe. It does not mean the server does no work — logging, counters and cache warming are all fine — it means generic software like prefetchers and crawlers may send it without asking.

**Q: What does idempotent mean, and which methods are idempotent?**
A: N identical requests leave the server in the same state as one. `GET`, `HEAD`, `OPTIONS`, `TRACE`, `PUT` and `DELETE` are idempotent; `POST` and `PATCH` are not. Note it constrains the resulting *state*, not the response — `DELETE` returning `204` then `404` is still idempotent.

**Q: Why is `PATCH` not idempotent?**
A: Because the patch document can express relative operations. A JSON Patch `{"op":"add","path":"/tags/-","value":"x"}` appends a tag on every application, so three retries add three tags. RFC 5789 therefore declares `PATCH` neither safe nor idempotent, even though a JSON Merge Patch setting absolute values usually behaves idempotently in practice.

**Q: When do you use `PUT` versus `POST`?**
A: `POST` when the server assigns the identifier and you are asking it to process something — creation returns `201` with a `Location` header. `PUT` when the client already knows the URI and is asserting the complete desired state of that resource. `PUT` is idempotent and therefore retry-safe; `POST` is not, which is why creation endpoints need idempotency keys.

**Q: A `POST` times out with no response. What should the client do?**
A: It cannot tell whether the request was processed, so it must not blindly retry a non-idempotent operation. If it sent an `Idempotency-Key` it retries with the *same* key and the server replays the original result. If not, the only safe options are to query for the entity by a business key before retrying, or to surface the ambiguity and reconcile.

**Q: How would you implement idempotency keys server-side?**
A: Store rows keyed by `(tenant, endpoint, idempotency-key)` with a unique constraint, a hash of the request body, a state of `in_progress` or `completed`, the stored response, and a TTL of about 24 hours. On a hit with `completed`, replay the stored response without executing; on `in_progress`, return `409`; on a body-hash mismatch, return `422`. Commit the business write and the idempotency record in one transaction so you cannot execute without recording.

**Q: What is the difference between idempotency and concurrency control?**
A: Idempotency protects against *replays of the same request* — it makes a retry harmless. Concurrency control protects against *different requests interleaving* — two clients writing conflicting state. You need both: an idempotency key for retry safety and `ETag` + `If-Match` preconditions yielding `412` for lost-update protection.

**Q: Which status codes are safe to retry, and how?**
A: `408`, `425`, `429`, and `5xx` (`500`, `502`, `503`, `504`). Never other `4xx` — the request itself is wrong. Retry with exponential backoff plus full jitter, honour `Retry-After`, bound the number of attempts and the overall deadline, and wrap it in a circuit breaker so a dead dependency does not consume your thread pool.

**Q: (Senior) How do you make idempotency work across a distributed system where the write spans two services?**
A: Do not try to make two remote writes atomic. Make the first service's write idempotent and durable, then propagate the operation asynchronously via a transactional outbox: the business row and the outbox row commit together, and a relay publishes the event at-least-once. Downstream consumers must be idempotent too — deduplicate on the event id — so the end-to-end property becomes "at-least-once delivery plus idempotent consumers equals effectively-once processing". For multi-step business flows use a saga with compensating actions rather than a distributed transaction.

**Q: (Senior) Your API sees a latency spike and duplicate orders appear. Walk me through the failure.**
A: Latency rises past the client timeout, so clients retry; if they generate a fresh key per attempt or the SDK/mesh retries `POST` without keys, each retry executes. The retries add load, latency rises further, and you get a metastable failure that persists after the original trigger is gone. The forensic path is duplicate business entities grouped by idempotency key, plus retry-attempt metrics per operation. The fixes are layered: keys generated once per operation, retry budgets capping retry traffic globally, backoff with jitter, load shedding with `503` + `Retry-After`, and a `409` for concurrent in-flight keys so simultaneous retries cannot both execute.

**Q: (Senior) Is `POST` ever cacheable, and when would you actually want it to be?**
A: RFC 9110 permits caching a `POST` response only when it carries explicit freshness information, and the entry may then satisfy a later `GET` on the same URI — not another `POST`. Essentially no cache implements this. If you want a cacheable `POST`, the real issue is that a read was modelled as a write, usually because the query was too big for a URL. The honest fixes are a `GET` with a compact cursor or filter, or a dedicated search resource that creates a query resource with `POST` and then serves results from a cacheable `GET`.

**Q: (Senior) How long should an idempotency key be retained, and what breaks at the boundary?**
A: Long enough to exceed the maximum client retry window including offline queues and process restarts — 24 hours is the common default, but a mobile client that retries on next launch may need days. At expiry the guarantee silently disappears: a late retry executes as a fresh request and creates a duplicate. So the TTL must be documented as part of the contract, the store must survive restarts and failover (a non-persistent Redis is a correctness bug, not a cache miss), and for very-long-tail cases you back it up with a natural business uniqueness constraint that outlives the key.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Methods carry three promises. **Safe** (`GET`, `HEAD`, `OPTIONS`, `TRACE`) means read-only from the client's perspective. **Idempotent** (safe methods plus `PUT` and `DELETE`) means N calls leave the same state as one — it constrains state, not the response. **Cacheable** is `GET` and `HEAD` in practice. `POST` and `PATCH` are neither safe nor idempotent: `PATCH` because RFC 5789 allows relative operations. The reason this matters is the partial-failure ambiguity — a client that gets no response cannot tell whether the request was processed, so it may only retry things that are replay-safe. Make writes replay-safe with an **`Idempotency-Key`**: store `(tenant, endpoint, key)` with a unique constraint, a body fingerprint, a state, the stored response and a 24-hour TTL; replay on hit, `409` while in progress, `422` on a body mismatch, and commit the record in the same transaction as the business write. Use `ETag` + `If-Match` → `412` (and `428` when missing) for lost-update protection — a different problem from idempotency. Retry only `408`, `425`, `429` and `5xx`, with exponential backoff plus full jitter, a bounded deadline, and a retry budget.

| Item | Value |
|---|---|
| Safe | `GET`, `HEAD`, `OPTIONS`, `TRACE` |
| Idempotent | safe + `PUT`, `DELETE` |
| Neither | `POST`, `PATCH` |
| Cacheable | `GET`, `HEAD` (`POST` only with explicit freshness) |
| Create | `POST` → `201` + `Location` |
| Full replace | `PUT` → `200`/`201`/`204` |
| Partial change | `PATCH` + `application/merge-patch+json` or RFC 6902 |
| Remove | `DELETE` → `204`, then `404` on repeat |
| Async accepted | `202` + `Location` of a job resource |
| Retry key header | `Idempotency-Key: <uuid>`, generated once per operation |
| Concurrent retry | `409 Conflict` |
| Key reused, different body | `422` |
| Stale / missing precondition | `412` / `428` |
| Retryable statuses | `408`, `425`, `429`, `500`, `502`, `503`, `504` |
| Backoff | `random(0, base · 2^attempt)` + `Retry-After` + bounded deadline |

**Flash cards**
- **Idempotent means…** → N identical requests leave the same server *state* as one; the responses may differ (`204` then `404`).
- **Why isn't `PATCH` idempotent?** → The patch document can express relative operations (JSON Patch `add` to an array appends every time).
- **`POST` timed out — retry?** → Only with the same `Idempotency-Key`; otherwise query by a business key or reconcile.
- **Idempotency vs `If-Match`** → Keys protect against retries of the same request; `If-Match`/`412` protects against different concurrent writes.
- **Which statuses do you retry?** → `408`, `425`, `429`, `5xx` — with exponential backoff, full jitter and a deadline. Never other `4xx`.

## 11. Hands-On Exercises & Mini Project

- [ ] Build a `POST /payments` endpoint without idempotency, put a proxy in front that drops 30% of *responses* (not requests), drive it with a retrying client, and count the duplicate charges.
- [ ] Add the `Idempotency-Key` table from §5 and re-run the same test. Assert zero duplicates, then break it deliberately by moving the key insert outside the transaction and observe the failure return.
- [ ] Fire 50 concurrent requests with the *same* key and verify exactly one execution, with the rest receiving `409` or the replayed response — never two executions.
- [ ] Implement `PUT` and `PATCH` on the same resource and demonstrate the data-loss bug: `PUT` a partial body and show which fields were silently cleared.

### Mini Project — "Replay-Safe Payments API"

**Goal.** Build a payments endpoint that is provably correct under timeouts, retries, concurrency and restarts.

**Requirements.**
1. `POST /v1/payments` requiring `Idempotency-Key`, backed by a Postgres table keyed on `(tenant, endpoint, key)` with a unique constraint, a body fingerprint, a state machine and a 24-hour TTL.
2. Correct outcomes: first call `201` + `Location`; replay `200` + `Idempotency-Replayed: true`; concurrent in-flight `409`; same key with a different body `422`; missing key `400`.
3. `GET /v1/payments/{id}` with `ETag`, and `PATCH` requiring `If-Match` (`412` on mismatch, `428` when absent).
4. A refunds sub-resource where `POST /v1/payments/{id}/refunds` is idempotent by `(payment_id, reference)` — natural idempotency, no key needed — to contrast the two approaches.
5. A chaos test harness: random response drops, random latency, process kill mid-transaction. Assert invariants — never two payments for one key, never a payment without an idempotency record.
6. Metrics: replay rate, `409` rate, `422` rate, retries per logical operation, store latency.

**Extensions.**
- Add a transactional outbox so a `payment.succeeded` event is published at-least-once, and make the consumer idempotent by event id.
- Convert slow settlement to `202 Accepted` + a `/v1/settlements/{id}` job resource and show the front-end connection is freed.
- Add a retry budget at the gateway capping retries at 10% of traffic, then simulate a latency spike and compare the recovery curve with and without it.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *HTTP Fundamentals for API Builders* (status codes, conditional requests, `ETag` mechanics), *Resource Modeling & URI Design* (process resources that give actions correct retry semantics), *What Is REST? Constraints & Maturity* (why the uniform interface makes these properties useful), *What Is an API? Web APIs & Clients* (partial failure and the contract mindset), *REST vs GraphQL, gRPC & SOAP* (what those styles give up on retry semantics).

- **RFC 9110 §9 — Methods** — IETF, 2022 · *Intermediate* · the normative definitions of safe, idempotent and cacheable, plus the exact semantics of each method; the section to quote in a design review. <https://www.rfc-editor.org/rfc/rfc9110.html#section-9>
- **RFC 5789 — PATCH Method for HTTP** — IETF, 2010 · *Intermediate* · short and worth reading in full; states plainly that `PATCH` is neither safe nor idempotent and explains why the patch format matters. <https://www.rfc-editor.org/rfc/rfc5789>
- **RFC 6902 — JavaScript Object Notation (JSON) Patch** — IETF · *Intermediate* · the operation-based patch format; the `add`/`move`/`test` operations are the concrete reason `PATCH` cannot be assumed idempotent. <https://www.rfc-editor.org/rfc/rfc6902>
- **Designing robust and predictable APIs with idempotency** — Brandur Leach (Stripe) · *Advanced* · the best single article on production idempotency: keys, state machines, transaction boundaries and foreign-state mutations. <https://brandur.org/idempotency>
- **Timeouts, retries and backoff with jitter** — Marc Brooker, Amazon Builders' Library · *Advanced* · the empirical case for full jitter, retry budgets and why uncoordinated retries cause metastable failures. <https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/>
- **MDN — HTTP request methods** — Mozilla · *Beginner* · one clear page per method with the safe/idempotent/cacheable table and browser behaviour notes. <https://developer.mozilla.org/en-US/docs/Web/HTTP/Methods>
- **Google API Design Guide — Standard Methods** — Google · *Intermediate* · how `List`, `Get`, `Create`, `Update` and `Delete` map onto HTTP methods, including long-running operations and custom methods. <https://cloud.google.com/apis/design/standard_methods>
- **The Idempotency-Key HTTP Header Field (IETF draft)** — IETF HTTP API WG · *Advanced* · the in-progress standardisation of the header everyone already uses; useful for aligning your semantics with where the ecosystem is heading. <https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/>

---

*REST API Handbook — chapter 06.*
