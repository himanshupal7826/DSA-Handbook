# 28 · Concurrency Control & Optimistic Locking

> **In one line:** When two clients edit the same resource, the second write silently destroys the first unless the request carries a precondition — `If-Match` with an `ETag` turns that lost update into an honest `412 Precondition Failed`.

---

## 1. Overview

The **lost update** problem is the oldest bug in shared-state systems and the one API designers most often ship by accident. Alice `GET`s `/v1/documents/42`, sees `{"title":"Q3 Plan","status":"draft"}`, and starts editing. Bob `GET`s the same document a second later and changes `status` to `review`. Bob `PUT`s. Alice `PUT`s thirty seconds afterwards with the body she built from the *old* representation. Bob's change is gone — no error, no warning, no audit trail. Both writes returned `200 OK`.

Nothing in plain REST prevents this. HTTP is stateless, each request is independent, and a naive `PUT` handler that does `UPDATE documents SET … WHERE id = 42` will happily overwrite whatever is there. The database was never the problem; the *protocol contract* was. What is missing is a way for the client to say "apply this write **only if** the resource is still in the state I read."

HTTP has had exactly that since 1997, and it was restated in **RFC 9110 §13 (Conditional Requests)**. The client sends `If-Match: "<etag>"` carrying the validator it received on the read. The server compares that against the resource's current validator: on a match it applies the write and returns a *new* ETag; on a mismatch it returns **`412 Precondition Failed`** and changes nothing. This is **optimistic concurrency control** — optimistic because it assumes conflicts are rare and detects them at commit time rather than locking up front.

A stricter variant exists: **`428 Precondition Required` (RFC 6585)**, which lets the server *refuse* unconditional writes altogether. If a `PUT` or `PATCH` arrives with no `If-Match`, the server responds `428`, forcing every client to participate in the protocol. Without `428`, an old client that never learned about ETags keeps clobbering data while everyone else plays by the rules.

**Concrete example.** Google's Cloud Storage JSON API supports `ifGenerationMatch`/`ifMetagenerationMatch` preconditions and documents them as the mechanism for safe read-modify-write. Google Docs and Etcd expose version numbers (`revision`) for compare-and-swap. CouchDB requires the document `_rev` on every update and rejects mismatches with `409`. The Kubernetes API rejects a stale `resourceVersion` with `409 Conflict` and expects clients to re-read and retry. Different status codes, identical idea: **carry the version you read, and let the server refuse if it moved.**

The durable mental model: chapter 25 used `ETag` + `If-None-Match` on reads to save bandwidth; this chapter uses the *same validator* with `If-Match` on writes to preserve correctness. One validator, two directions. Reads ask "is my copy still current?"; writes assert "only proceed if it still is."

## 2. Core Concepts

- **Lost update** — a write based on a stale read silently overwrites an intervening write; the classic read-modify-write hazard.
- **Optimistic concurrency control (OCC)** — assume conflicts are rare, do not lock, validate at write time using a version or validator, and reject on mismatch.
- **Pessimistic locking** — acquire an exclusive lock before reading, hold it through the edit, release after writing; correct but poorly suited to stateless HTTP.
- **`ETag`** — the resource's version validator, returned on reads and echoed by clients on conditional writes.
- **`If-Match`** — precondition header meaning "apply only if the current validator is one of these"; `If-Match: *` means "only if the resource exists."
- **`If-Unmodified-Since`** — the timestamp-based fallback precondition; weaker than `ETag` because of one-second granularity.
- **`412 Precondition Failed`** — the precondition evaluated false; the server made no change.
- **`428 Precondition Required`** — the server requires a precondition and refuses to process an unconditional write.
- **`409 Conflict`** — the request conflicts with the current resource state for a *semantic* reason (a state-machine violation, a duplicate unique field), distinct from a version mismatch.
- **Version field** — a monotonically increasing integer (`version`, `_rev`, `resourceVersion`) stored on the row and used to derive the ETag; the cheapest correct validator.
- **Merge / rebase** — resolving a conflict by combining changes rather than rejecting; requires field-level diffs or a CRDT.

## 3. Theory & Principles

**RFC 9110 §13.2 precondition evaluation order.** When multiple conditional headers appear, the server must evaluate them in a defined order: `If-Match`, then `If-Unmodified-Since` (only when `If-Match` is absent), then `If-None-Match`, then `If-Modified-Since` (only for `GET`/`HEAD` when `If-None-Match` is absent), then `If-Range`. Two consequences matter in practice. First, `If-Match` wins over `If-Unmodified-Since`, so sending both is harmless — the timestamp is ignored when the validator is present. Second, **preconditions must be evaluated before the request is processed**, atomically with respect to the write. Checking the version, then updating in a separate statement, reintroduces exactly the race you were trying to close.

**Strong vs weak validators for writes.** `If-None-Match` on reads uses *weak comparison*, so `W/"v42"` matches `"v42"`. `If-Match` on writes requires **strong comparison** — a weak validator never matches. That is a genuine tension: chapter 25 recommended weak, version-derived ETags because they are cheap, but those cannot be used with `If-Match` under a strict reading. The pragmatic resolution used by most APIs is to emit a **strong** ETag derived from the row version (`ETag: "42"` rather than `W/"42"`) for resources that support conditional writes. It is byte-stable for a given version as long as your serialization is deterministic, so calling it strong is honest.

**The compare-and-swap.** The correctness of OCC rests on a single atomic statement:

```sql
UPDATE documents
   SET title = $2, status = $3, version = version + 1, updated_at = now()
 WHERE id = $1 AND version = $4;
-- rows affected = 1 → success, new version = $4 + 1
-- rows affected = 0 → either the row is gone (404) or the version moved (412)
```

The `WHERE version = $4` clause *is* the lock. It is a compare-and-swap executed by the database's row-level locking, so no application-level mutex is needed and no lock is held across the client's think time. Note the ambiguity of zero rows affected: you must disambiguate with a follow-up existence check to choose between `404 Not Found` and `412 Precondition Failed`.

**Why not pessimistic locking?** A pessimistic lock would require the server to hold state between the client's `GET` and `PUT` — a lock table with owners and expiry, a lease renewal endpoint, and a recovery story for clients that crash mid-edit. That violates REST's statelessness constraint and creates operational misery: abandoned locks, lock-timeout tuning, and lock convoys under load. The honest comparison:

| Property | Optimistic (`If-Match`) | Pessimistic (lock resource) |
|---|---|---|
| Cost when no conflict | Zero | Two extra round trips |
| Cost when conflict | Client redoes work | Client waits or is refused |
| Server state | None | Lock table, leases, expiry sweeper |
| Fits stateless HTTP | Yes | Only via an explicit lock sub-resource |
| Best for | Low-contention CRUD, the vast majority of APIs | Long human edits on hot rows, seat/inventory reservation |

**Choosing the right status code.** This is the most common interview trap. `412 Precondition Failed` means *the validator you sent does not match the current one* — a purely version-level statement. `409 Conflict` means the request is semantically incompatible with current state — cancelling an already-shipped order, or creating a user whose email already exists. `428 Precondition Required` means you sent no precondition at all and this endpoint requires one. And `422 Unprocessable Content` means the body was well-formed but semantically invalid, which is a validation concern, not a concurrency one.

**Granularity.** A whole-document ETag treats any change as a conflict, so two users editing different fields collide unnecessarily. Three escalating options: (a) resource-level ETag — simple, coarse, right for most APIs; (b) `PATCH` with field-level preconditions or a JSON Patch `test` operation, which lets non-overlapping edits both succeed; (c) CRDTs or operational transformation, which merge automatically and are what real collaborative editors use — powerful and far more complex than a REST CRUD API should take on.

```svg
<svg viewBox="0 0 780 356" width="100%" height="356" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="8" y="8" width="764" height="340" rx="14" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="390" y="34" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Lost update, and how If-Match converts it into a 412</text>

  <text x="90" y="62" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Alice</text>
  <text x="390" y="62" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Server / row v3</text>
  <text x="690" y="62" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Bob</text>
  <path d="M90 70 L90 332" stroke="#4f46e5" stroke-width="1.5" fill="none"/>
  <path d="M390 70 L390 332" stroke="#4f46e5" stroke-width="1.5" fill="none"/>
  <path d="M690 70 L690 332" stroke="#4f46e5" stroke-width="1.5" fill="none"/>

  <path d="M90 96 L388 96" stroke="#0ea5e9" stroke-width="2" fill="none"/>
  <polygon points="388,96 380,92 380,100" fill="#0ea5e9"/>
  <text x="238" y="90" text-anchor="middle" fill="#1e293b" font-size="11">GET &#8594; 200, ETag: "3"</text>

  <path d="M690 124 L392 124" stroke="#0ea5e9" stroke-width="2" fill="none"/>
  <polygon points="392,124 400,120 400,128" fill="#0ea5e9"/>
  <text x="542" y="118" text-anchor="middle" fill="#1e293b" font-size="11">GET &#8594; 200, ETag: "3"</text>

  <path d="M690 162 L392 162" stroke="#16a34a" stroke-width="2" fill="none"/>
  <polygon points="392,162 400,158 400,166" fill="#16a34a"/>
  <text x="542" y="156" text-anchor="middle" fill="#1e293b" font-size="11">PUT, If-Match: "3" &#8594; 200, ETag: "4"</text>

  <rect x="300" y="176" width="180" height="26" rx="7" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="390" y="194" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">row is now v4</text>

  <path d="M90 226 L388 226" stroke="#d97706" stroke-width="2" fill="none"/>
  <polygon points="388,226 380,222 380,230" fill="#d97706"/>
  <text x="238" y="220" text-anchor="middle" fill="#1e293b" font-size="11">PUT, If-Match: "3" (stale)</text>

  <rect x="240" y="240" width="300" height="44" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="390" y="258" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">"3" &#8800; "4" &#8594; reject, write nothing</text>
  <text x="390" y="275" text-anchor="middle" fill="#1e293b" font-size="10">UPDATE ... WHERE version = 3 affects 0 rows</text>

  <path d="M388 306 L92 306" stroke="#d97706" stroke-width="2" fill="none"/>
  <polygon points="92,306 100,302 100,310" fill="#d97706"/>
  <text x="238" y="300" text-anchor="middle" fill="#1e293b" font-size="11">412 Precondition Failed &#8594; re-read, merge, retry</text>

  <rect x="560" y="228" width="200" height="80" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="660" y="250" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">Without If-Match</text>
  <text x="660" y="270" text-anchor="middle" fill="#1e293b" font-size="10">Alice&#8217;s PUT returns 200</text>
  <text x="660" y="287" text-anchor="middle" fill="#1e293b" font-size="10">Bob&#8217;s change is gone,</text>
  <text x="660" y="302" text-anchor="middle" fill="#1e293b" font-size="10">silently, with no error</text>
</svg>
```

## 4. Architecture & Workflow

The full read-modify-write cycle with preconditions, including the conflict path.

1. **Read.** `GET /v1/documents/42` returns `200 OK` with `ETag: "3"` (derived from the row's `version` column) and `Cache-Control: private, no-cache`. The client stores both the body and the validator.
2. **Edit locally.** The user changes fields. No server state is held — no lock, no lease, no session. The user can take thirty seconds or thirty minutes.
3. **Conditional write.** The client sends `PUT /v1/documents/42` (or `PATCH`) with `If-Match: "3"` and `Content-Type: application/json`.
4. **Gateway.** `If-Match` must survive the gateway untouched. Some WAFs and proxies strip conditional headers on non-`GET` methods — verify this explicitly, because the failure mode is silent loss of protection, not an error.
5. **Precondition gate.** The handler parses `If-Match`. If it is absent and the endpoint requires it, return `428 Precondition Required` with a problem document explaining how to obtain a validator. If it is `*`, the precondition means "the resource must exist."
6. **Atomic compare-and-swap.** Execute `UPDATE … WHERE id = $1 AND version = $2 RETURNING version`. Never `SELECT` the version, compare in application code, then `UPDATE` — that is a race with a window measured in milliseconds and it *will* be hit under load.
7. **Branch on rows affected.**
   - *1 row* → success. Return `200 OK` (or `204 No Content`) with the **new** `ETag: "4"`.
   - *0 rows, resource exists* → `412 Precondition Failed` with a problem document carrying the current version so the client can decide what to do.
   - *0 rows, resource absent* → `404 Not Found` (or `410 Gone` if deletion is tracked).
8. **Client conflict handling.** On `412` the client re-reads the resource, presents a diff or merges non-overlapping fields, and retries with the new validator. It must bound retries — an unbounded conflict-retry loop on a hot row is a livelock.
9. **Cache interaction.** Because the ETag changed, any cached copy is now stale. Send `Cache-Control: private, no-cache` on these resources so intermediaries always revalidate, and purge any CDN entry for the URI on write.
10. **Deletes.** `DELETE /v1/documents/42` with `If-Match: "4"` prevents deleting a version you have not seen — the same protection, applied to removal.

> **Note:** Steps 6 and 7 are the whole chapter. If the version comparison is not in the same statement as the write, you have written documentation, not concurrency control.

```svg
<svg viewBox="0 0 780 372" width="100%" height="372" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="8" y="8" width="764" height="356" rx="14" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="390" y="34" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Conditional write path and the four outcomes</text>

  <rect x="286" y="52" width="208" height="44" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="390" y="72" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">PUT /v1/documents/42</text>
  <text x="390" y="88" text-anchor="middle" fill="#1e293b" font-size="10">If-Match: "3"</text>

  <path d="M390 96 L390 122" stroke="#4f46e5" stroke-width="2" fill="none"/>
  <polygon points="390,122 386,114 394,114" fill="#4f46e5"/>

  <rect x="266" y="122" width="248" height="42" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="390" y="140" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">precondition present?</text>
  <text x="390" y="156" text-anchor="middle" fill="#1e293b" font-size="10">absent + required &#8594; 428</text>

  <path d="M514 143 L640 143 L640 176" stroke="#d97706" stroke-width="2" fill="none"/>
  <polygon points="640,176 636,168 644,168" fill="#d97706"/>
  <rect x="546" y="176" width="196" height="40" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="644" y="193" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">428 Precondition Required</text>
  <text x="644" y="209" text-anchor="middle" fill="#1e293b" font-size="10">GET first, then resend with If-Match</text>

  <path d="M390 164 L390 190" stroke="#4f46e5" stroke-width="2" fill="none"/>
  <polygon points="390,190 386,182 394,182" fill="#4f46e5"/>

  <rect x="228" y="190" width="324" height="48" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="390" y="210" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">UPDATE ... WHERE id=$1 AND version=$2</text>
  <text x="390" y="228" text-anchor="middle" fill="#1e293b" font-size="10">one atomic compare-and-swap &#8212; the WHERE is the lock</text>

  <path d="M300 238 L170 238 L170 274" stroke="#16a34a" stroke-width="2" fill="none"/>
  <polygon points="170,274 166,266 174,266" fill="#16a34a"/>
  <path d="M390 238 L390 274" stroke="#d97706" stroke-width="2" fill="none"/>
  <polygon points="390,274 386,266 394,266" fill="#d97706"/>
  <path d="M480 238 L620 238 L620 274" stroke="#d97706" stroke-width="2" fill="none"/>
  <polygon points="620,274 616,266 624,266" fill="#d97706"/>

  <rect x="40" y="274" width="260" height="66" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="170" y="296" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">1 row affected</text>
  <text x="170" y="315" text-anchor="middle" fill="#1e293b" font-size="10">200 OK / 204 No Content</text>
  <text x="170" y="331" text-anchor="middle" fill="#1e293b" font-size="10">ETag: "4" (the new version)</text>

  <rect x="312" y="274" width="156" height="66" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="390" y="296" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">0 rows, exists</text>
  <text x="390" y="315" text-anchor="middle" fill="#1e293b" font-size="10">412 Precondition</text>
  <text x="390" y="331" text-anchor="middle" fill="#1e293b" font-size="10">Failed &#8226; nothing written</text>

  <rect x="490" y="274" width="252" height="66" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="616" y="296" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">0 rows, absent</text>
  <text x="616" y="315" text-anchor="middle" fill="#1e293b" font-size="10">404 Not Found (or 410 Gone)</text>
  <text x="616" y="331" text-anchor="middle" fill="#1e293b" font-size="10">disambiguate with an existence check</text>
</svg>
```

## 5. Implementation

### The exchange

```http
GET /v1/documents/42 HTTP/1.1
Host: api.zariya.in

HTTP/1.1 200 OK
ETag: "3"
Cache-Control: private, no-cache
Content-Type: application/json

{"id":"42","title":"Q3 Plan","status":"draft","version":3}
```

```http
PUT /v1/documents/42 HTTP/1.1
If-Match: "3"
Content-Type: application/json

{"title":"Q3 Plan (revised)","status":"draft"}

HTTP/1.1 200 OK
ETag: "4"

{"id":"42","title":"Q3 Plan (revised)","status":"draft","version":4}
```

Conflict — the version moved underneath the client:

```http
HTTP/1.1 412 Precondition Failed
ETag: "5"
Content-Type: application/problem+json

{"type":"https://api.zariya.in/problems/version-conflict","status":412,
 "title":"Resource was modified by another request",
 "detail":"Your If-Match value \"3\" is stale; the current version is 5.",
 "current_version":5,"modified_by":"usr_bob","modified_at":"2026-07-22T09:41:07Z"}
```

Unconditional write on an endpoint that requires a precondition:

```http
HTTP/1.1 428 Precondition Required
Content-Type: application/problem+json

{"type":"https://api.zariya.in/problems/precondition-required","status":428,
 "title":"If-Match header is required","detail":"GET the resource to obtain its ETag, then resend with If-Match."}
```

### FastAPI: atomic compare-and-swap

```python
from fastapi import APIRouter, Header, Response, HTTPException
from pydantic import BaseModel

router = APIRouter()


class DocumentUpdate(BaseModel):
    title: str
    status: str


def parse_if_match(header: str | None) -> list[str] | None:
    """None when absent, ['*'] for wildcard, else the list of strong tags."""
    if header is None:
        return None
    return ["*"] if header.strip() == "*" else [t.strip().strip('"')
                                                for t in header.split(",")]


@router.put("/v1/documents/{doc_id}")
async def update_document(doc_id: str, body: DocumentUpdate, response: Response,
                          db=None, if_match: str | None = Header(None, alias="If-Match")):
    tags = parse_if_match(if_match)
    if tags is None:
        raise HTTPException(428, "If-Match is required; GET the resource for its ETag")

    # The WHERE clause is the lock. One statement, no read-then-write race.
    row = await db.fetchrow(
        """UPDATE documents
              SET title = $2, status = $3, version = version + 1, updated_at = now()
            WHERE id = $1 AND ($4::bool OR version::text = ANY($5))
        RETURNING id, title, status, version""",
        doc_id, body.title, body.status, tags == ["*"], tags,
    )

    if row is None:
        current = await db.fetchrow(
            "SELECT version, updated_by, updated_at FROM documents WHERE id = $1", doc_id)
        if current is None:
            raise HTTPException(404, "Document not found")
        raise HTTPException(
            status_code=412,
            detail={"type": "https://api.zariya.in/problems/version-conflict",
                    "title": "Resource was modified by another request",
                    "current_version": current["version"],
                    "modified_by": current["updated_by"]},
            headers={"ETag": f'"{current["version"]}"'},
        )

    response.headers["ETag"] = f'"{row["version"]}"'
    return dict(row)
```

### JSON Patch with a `test` operation

RFC 6902 gives you field-level preconditions without any HTTP header — the patch fails atomically if the `test` does not hold, letting two clients edit *different* fields of the same document concurrently.

```http
PATCH /v1/documents/42 HTTP/1.1
Content-Type: application/json-patch+json

[
  {"op": "test",    "path": "/status", "value": "draft"},
  {"op": "replace", "path": "/status", "value": "review"}
]
```

A failed `test` yields `409 Conflict` (the patch is semantically inapplicable), not `412` — `412` is reserved for HTTP-header preconditions.

### Client retry-on-conflict

```javascript
async function updateWithRetry(url, mutate, maxAttempts = 3) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const read = await fetch(url);
    const etag = read.headers.get("ETag");
    const current = await read.json();

    const res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": etag },
      body: JSON.stringify(mutate(current)),   // recompute from the FRESH state
    });

    if (res.status !== 412) return res.json();      // success or a real error
    await new Promise(r => setTimeout(r, Math.random() * 50 * 2 ** attempt));
  }
  throw new Error("Conflict: the resource is changing faster than we can update it");
}
```

> **Note:** The mutation must be recomputed from the freshly read state on each attempt. Replaying the *original* body after a `412` reintroduces the lost update you were preventing — a bug that appears in an alarming number of "retry on conflict" helpers.

### OpenAPI 3.1 fragment

```yaml
put:
  operationId: updateDocument
  parameters:
    - { name: If-Match, in: header, required: true, schema: { type: string },
        description: ETag from a prior GET. Unconditional writes are rejected. }
  responses:
    "200": { description: Updated, headers: { ETag: { schema: { type: string } } } }
    "404": { description: Not found }
    "412": { description: ETag mismatch — resource changed; re-read and retry }
    "428": { description: If-Match missing }
```

### Optimization note

The version column costs nothing: it is an `int` on a row you are already writing, and the compare-and-swap adds no extra query because the predicate rides along on the `UPDATE` you were issuing anyway. The real cost is **conflict rate**, which grows roughly with `writers² × think_time` on a hot row. If your `412` rate exceeds a few percent, do not tune retries — reduce contention. Split the aggregate so different fields live on different rows, move counters into dedicated increment endpoints (`POST /documents/42/views` doing `SET views = views + 1`, which needs no precondition because it is commutative), or switch that specific hot field to a CRDT-style merge. And index `(id, version)` only if your access pattern needs it; the primary key alone is usually sufficient because the version predicate is evaluated on an already-located row.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost/Trade-off |
|---|---|---|
| Optimistic locking | No server-side lock state; fits stateless HTTP perfectly | Work is wasted on conflict; the client must re-read and redo |
| `If-Match` + `ETag` | Standard, cacheable, reuses the read-side validator | Clients must actually send it; old clients silently bypass protection |
| `428` enforcement | Makes participation mandatory, closing the bypass | Breaking change for existing clients; needs a deprecation window |
| Version integer | Trivially cheap, monotonic, human-readable in logs | Coarse: any field change conflicts with any other field change |
| Content-hash ETag | Semantically precise — identical content is not a conflict | Requires serializing to compute; no cheap pre-write short-circuit |
| JSON Patch `test` | Field-level precondition; non-overlapping edits both succeed | More complex client and server; patch semantics are easy to get wrong |
| Pessimistic locking | Guarantees the write succeeds once the lock is held | Server state, lease expiry, abandoned locks, poor fit for HTTP |
| Retry-on-`412` loop | Transparent for commutative updates | Livelock risk on hot rows; must be bounded and jittered |

## 7. Common Mistakes & Best Practices

1. ⚠️ Accepting `PUT`/`PATCH` with no precondition and hoping clients behave → ✅ return `428 Precondition Required` on mutable resources so participation is enforced, not requested.
2. ⚠️ `SELECT version` → compare in Python → `UPDATE` → ✅ that is the race you are trying to close; put the version in the `UPDATE`'s `WHERE` clause so the database performs the compare-and-swap atomically.
3. ⚠️ Returning `409 Conflict` for a version mismatch → ✅ `412 Precondition Failed` is the correct code for a failed HTTP precondition; reserve `409` for semantic conflicts like an illegal state transition or a duplicate unique field.
4. ⚠️ Not returning a new `ETag` on a successful write → ✅ the client immediately needs the new validator; without it the next write is guaranteed to `412` and you have doubled every round trip.
5. ⚠️ Retrying a `412` by replaying the original request body → ✅ re-read the resource and recompute the mutation from the fresh state, or you will silently reproduce the lost update.
6. ⚠️ Using `If-Unmodified-Since` as the primary precondition → ✅ HTTP dates have one-second granularity, so two writes in the same second are indistinguishable; use `ETag` and treat the timestamp as a fallback only.
7. ⚠️ Emitting weak ETags (`W/"3"`) on resources that support `If-Match` → ✅ `If-Match` requires strong comparison and a weak validator never matches; emit strong tags for conditionally writable resources.
8. ⚠️ Treating a `412` as a `5xx` and alerting on it → ✅ conflicts are normal and expected; alert on the *rate* crossing a contention threshold, not on individual occurrences.
9. ⚠️ Letting a gateway or WAF strip `If-Match` on non-`GET` methods → ✅ add an integration test that asserts the header reaches the handler through the full production path; silent stripping disables all protection with no error.
10. ⚠️ Whole-document ETags on a resource many users edit simultaneously → ✅ split the aggregate, move commutative operations (counters, tags, "add member") to dedicated sub-resource endpoints that need no precondition, or adopt field-level patches.
11. ⚠️ Unbounded retry-on-conflict loops → ✅ cap attempts, add jittered backoff, and surface a real error to the user when the row is too hot — a livelock is worse than an honest failure.
12. ⚠️ `DELETE` without a precondition → ✅ accept `If-Match` on deletes too, so you cannot destroy a version you never saw.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Log the `If-Match` value, the resource's actual version, and the outcome on every conditional write; a `412` line that shows `sent="3" current="7"` immediately tells you the client is working from a very stale read, which is usually a caching or a UI-refresh bug rather than genuine contention. For "the user's edit vanished" reports, reconstruct the timeline from your version history: if versions increment 3 → 4 → 5 with no `412` in between, nobody was sending preconditions and you have found the bug. Keep an `updated_by`/`updated_at` pair on every versioned row — it costs two columns and turns conflict forensics from guesswork into a query. Test the whole path end to end, including the gateway, since header stripping is invisible from the application side.

**Monitoring.** Track the **`412` rate per endpoint** (healthy is under 1%; above 5% you have a contention problem, not a client problem), the **`428` rate** (which measures how many clients still send unconditional writes — this is your migration burn-down chart), the **conflict-retry success rate** (if retries mostly fail, the row is too hot), the **version churn** on your top-N hottest resources, and the **distribution of validator staleness** (`current_version − sent_version`), which distinguishes "two users collided" from "a client is caching a version from an hour ago." Alert on a sudden `412` spike, which frequently signals a deployment that changed how ETags are derived.

**Security.** Preconditions are not authorization: check that the caller may modify the resource *before* evaluating `If-Match`, or a `412` versus `404` difference becomes an existence oracle that lets an attacker enumerate resource IDs and observe write activity. Do not put sensitive data in ETags — a content-hash validator can leak information about the body, and a sequential version reveals write frequency, which may itself be sensitive in a multi-tenant context (returning the current version in a `412` body is a deliberate, and usually acceptable, disclosure to the authorized caller only). Rate-limit conflict retries so a client cannot use a hot resource as an amplification vector. Finally, be careful with `If-Match: *` — it asserts only existence, so it prevents accidental creation but provides no protection at all against a lost update.

**Performance & scaling.** Optimistic concurrency scales beautifully because there is no shared lock and no held state: the only cost is a failed `UPDATE` that touched one row. It degrades when contention concentrates — a global counter, a shared settings document, an inventory row for a flash-sale product. The fixes are structural: shard the hot row (N counter rows summed on read), make the operation commutative so it needs no precondition, or queue writes to that resource through a single-writer partition. In the rare case where a long human edit on a hot resource genuinely needs exclusivity, model it explicitly as a lock sub-resource (`PUT /documents/42/lock` returning a lease with a TTL) rather than smuggling server state into your `PUT` handler — and accept that you now own lease expiry and abandonment.

## 9. Interview Questions

**Q: What is the lost update problem?**
A: Two clients read the same resource, both modify it locally, and both write back; the second write overwrites the first, which is silently lost. Neither client receives an error because each `PUT` is a valid, independent request. It appears whenever a read-modify-write cycle spans a network round trip without a version check.

**Q: How do `ETag` and `If-Match` prevent it?**
A: The server returns an `ETag` identifying the exact version the client read. On the write the client echoes it in `If-Match`, and the server applies the change only if the current validator still matches. On a mismatch it returns `412 Precondition Failed` and makes no change, so the client learns the resource moved and can re-read and merge.

**Q: What is the difference between `409 Conflict` and `412 Precondition Failed`?**
A: `412` means an HTTP precondition header evaluated false — the validator you sent is not the current one. `409` means the request conflicts with the resource's current state for a semantic reason, such as cancelling an already-shipped order or creating a duplicate unique value. Version mismatches should be `412`; business-rule conflicts should be `409`.

**Q: When would you return `428 Precondition Required`?**
A: When a mutating endpoint requires a precondition and the client sent none. It closes the loophole where a legacy or lazy client bypasses concurrency control entirely by omitting `If-Match`, converting a silent data-loss risk into an explicit, fixable error.

**Q: Optimistic or pessimistic locking for a REST API — and why?**
A: Optimistic, in almost all cases. Pessimistic locking requires the server to hold state between the read and the write, which violates HTTP's statelessness and forces you to build lock tables, leases, expiry sweepers, and abandonment recovery. Optimistic locking costs nothing when there is no conflict, which is the overwhelmingly common case, and degrades gracefully into a `412` when there is.

**Q: Why must the version check be in the same statement as the update?**
A: If you `SELECT` the version, compare it in application code, and then `UPDATE`, another request can commit in the gap between the read and the write — reintroducing exactly the race you were closing. Putting `WHERE version = $expected` on the `UPDATE` makes the comparison and the write a single atomic operation enforced by the database's row lock.

**Q: What does `If-Match: *` mean?**
A: It asserts only that the resource currently exists, with no constraint on its version. It is useful to prevent a `PUT` from accidentally creating a resource, but it gives no lost-update protection whatsoever — for that you must send the actual validator.

**Q: (Senior) Your `412` rate is 15% on one endpoint. What do you do?**
A: Treat it as a data-model problem, not a retry-tuning problem. Identify whether conflicts come from genuine concurrent human edits or from a client caching stale representations, then reduce contention structurally: split the aggregate so unrelated fields live on separate resources, move commutative operations like counters and tag-adds to dedicated endpoints that need no precondition, shard hot counters, or adopt field-level `PATCH` with `test` operations so non-overlapping edits stop colliding. Simply retrying harder on a hot row produces a livelock.

**Q: (Senior) How do preconditions interact with idempotency keys?**
A: They solve orthogonal problems and are often needed together. An idempotency key makes a *retry* of the same logical operation safe — it deduplicates. A precondition makes a write conditional on the resource not having changed — it detects interference from *other* actors. A `POST /charges` needs a key but no precondition; a `PUT /documents/42` needs a precondition and, if the client retries on timeout, benefits from a key too. Note that `If-Match` gives a limited form of idempotency for free: the second application of the same conditional write fails with `412` because the version already advanced.

**Q: (Senior) How would you support conflict *resolution* rather than just conflict detection?**
A: Return enough information in the `412` for the client to merge — the current version, the current representation or a diff, and who changed it — so a UI can present a three-way merge against the common ancestor the client still holds. For automatic resolution, move to field-level semantics: JSON Patch with `test` operations so disjoint edits commute, per-field version vectors, or CRDTs for types with well-defined merges such as counters, sets, and sequences. Full automatic merge is what collaborative editors implement with operational transformation or CRDTs, and it is a large step up in complexity that a CRUD API should take only when the product genuinely requires it.

**Q: (Senior) Can you use weak ETags with `If-Match`?**
A: Not under a strict reading of RFC 9110 — `If-Match` mandates strong comparison, and a weak validator never matches, so a conditional write with a `W/` tag would always fail. That conflicts with the read-side advice to use cheap weak validators, and the practical resolution is to emit strong ETags derived from a version column on any resource that supports conditional writes, since a version-derived tag is genuinely stable for a given state provided serialization is deterministic.

**Q: How should `DELETE` participate in concurrency control?**
A: Accept `If-Match` on `DELETE` so a client cannot remove a version it never observed, returning `412` when the validator is stale and `204` on success. Deleting a resource that someone else just modified is exactly as destructive as overwriting it, and the same protection applies.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Two clients doing read-modify-write on the same resource silently lose one of the updates unless the write carries a precondition. The server returns `ETag` on `GET`; the client echoes it as `If-Match` on `PUT`/`PATCH`/`DELETE`; the server performs a single atomic `UPDATE … WHERE id = $1 AND version = $2` where the `WHERE` clause *is* the lock. One row affected means success — return the new `ETag`. Zero rows means either `412 Precondition Failed` (resource exists, version moved) or `404` (gone). Missing precondition on an endpoint that requires one is `428 Precondition Required`. Never `SELECT`-then-`UPDATE`; never return `409` for a version mismatch; never retry a `412` by replaying the original body — re-read and recompute. `If-Match` needs strong ETags, so derive a strong tag from a version integer. Keep `412` rates under a few percent by reducing contention structurally rather than retrying harder.

| Situation | Status | Notes |
|---|---|---|
| Conditional write succeeds | `200` / `204` | Must return the **new** `ETag` |
| Validator stale | `412 Precondition Failed` | Nothing written; include current version |
| Precondition missing but required | `428 Precondition Required` | Tell the client to `GET` first |
| Semantic/state conflict | `409 Conflict` | Illegal transition, duplicate unique field |
| Resource gone | `404` / `410` | Disambiguate from `412` with an existence check |
| Read validator check | `304 Not Modified` | `If-None-Match`, weak comparison |
| Write validator check | `If-Match` | Strong comparison — no `W/` tags |
| Existence-only precondition | `If-Match: *` | Prevents creation; no update protection |
| Timestamp fallback | `If-Unmodified-Since` | 1-second granularity; use only as a fallback |

**Flash cards**

- **Lost update in one line** → Two read-modify-write cycles overlap and the second write silently erases the first.
- **`412` vs `409`** → `412` = the HTTP precondition you sent does not match; `409` = the request conflicts with business state.
- **Where does the lock live?** → In the `WHERE version = $expected` clause of a single atomic `UPDATE`.
- **What does `428` enforce?** → That every mutating request carries a precondition, closing the unconditional-write bypass.
- **Retrying a `412` correctly** → Re-read the resource, recompute the mutation from fresh state, resend with the new ETag. Never replay the old body.

## 11. Hands-On Exercises & Mini Project

- [ ] Write a failing test that reproduces a lost update: two clients `GET` version 3, both `PUT` different bodies, and assert that the first change survives. Watch it fail, then add `If-Match` and watch it pass.
- [ ] Implement the compare-and-swap as `SELECT`-then-`UPDATE`, run 100 concurrent writers against one row, and count how many updates are lost. Then move the predicate into the `UPDATE` and rerun.
- [ ] Add `428 Precondition Required` to a mutating endpoint and observe how many of your existing clients break. That number is your real ETag adoption rate.
- [ ] Build a client that retries on `412` by re-reading and recomputing, and a deliberately broken one that replays the original body. Show that the broken one reproduces the lost update.
- [ ] Implement a JSON Patch endpoint with `test` operations and demonstrate that two clients editing *different* fields both succeed where whole-document ETags would have conflicted.

### Mini Project — A collaboratively edited document API

**Goal.** Build `/v1/documents/{id}` supporting safe concurrent editing, with measured conflict behaviour under load.

**Requirements.**
1. `GET` returns a strong `ETag` derived from an integer `version` column, plus `Cache-Control: private, no-cache`.
2. `PUT`, `PATCH`, and `DELETE` require `If-Match` and return `428` when it is absent, with an RFC 9457 problem document.
3. Implement the write as one atomic `UPDATE … WHERE id AND version`, returning `200` + new `ETag`, `412` with the current version, or `404`.
4. Keep an append-only `document_versions` audit table recording `version`, `changed_by`, `changed_at`, and the diff.
5. Support `PATCH` with `application/json-patch+json` including `test` operations, returning `409` on a failed `test`.
6. Ship a client with bounded, jittered retry-on-conflict that recomputes the mutation from fresh state each attempt. Load test with 50 concurrent editors on one document for 60 seconds, report the `412` and retry-success rates, and prove zero lost updates by reconciling the audit table against the final state.

**Extensions.**
- Add field-level version vectors so edits to disjoint fields never conflict, and compare the `412` rate against whole-document ETags under the same load.
- Add an explicit lock sub-resource (`PUT /documents/{id}/lock` with a 5-minute lease) and implement expiry and stealing, then write down which model you would ship and why.
- Implement a last-writer-wins merge for a `tags` array modelled as an OR-Set CRDT and show that concurrent tag additions all survive.

## 12. Related Topics & Free Learning Resources

**Related chapters.** *HTTP Caching: ETags & Cache-Control* (chapter 25) — the same validator, used with `If-None-Match` on reads. *Idempotency Keys & Safe Retries* (chapter 27) — deduplicates retries of one operation, which is orthogonal to detecting interference from others. *Error Handling & Problem Details* — your `412`, `409`, and `428` bodies should be RFC 9457 documents. *PUT vs PATCH* — why partial updates need field-level thinking. *Async APIs & Webhooks* (chapter 29) — long-running jobs need their own conflict story.

- **RFC 9110 §13 — Conditional Requests** — IETF · *Advanced* · the normative rules for `If-Match`, `If-Unmodified-Since`, precondition evaluation order, and strong versus weak comparison. <https://www.rfc-editor.org/rfc/rfc9110.html#name-conditional-requests>
- **RFC 6585 §3 — 428 Precondition Required** — IETF · *Beginner* · two paragraphs that explain exactly why servers should refuse unconditional writes; the clearest statement of the lost-update motivation in any RFC. <https://www.rfc-editor.org/rfc/rfc6585.html#section-3>
- **MDN — HTTP Conditional Requests** — Mozilla · *Intermediate* · worked transcripts of `If-Match`/`412` flows including the avoid-lost-update section, with clear diagrams. <https://developer.mozilla.org/en-US/docs/Web/HTTP/Conditional_requests>
- **RFC 6902 — JSON Patch** — IETF · *Intermediate* · defines the `test` operation that gives you field-level preconditions and atomic patch application. <https://www.rfc-editor.org/rfc/rfc6902.html>
- **Google Cloud Storage — Request Preconditions** — Google · *Intermediate* · a production API's take on generation/metageneration preconditions, including guidance on when each is appropriate. <https://cloud.google.com/storage/docs/request-preconditions>
- **Optimistic Offline Lock** — Martin Fowler, *P of EAA* · *Intermediate* · the pattern write-up that names and motivates version-based OCC, with the trade-off against pessimistic locking laid out plainly. <https://martinfowler.com/eaaCatalog/optimisticOfflineLock.html>
- **Kubernetes API Concepts — Resource Versions** — Kubernetes · *Advanced* · how a very large distributed control plane uses `resourceVersion` for compare-and-swap and why it returns `409` on mismatch. <https://kubernetes.io/docs/reference/using-api/api-concepts/>
- **Zalando RESTful API Guidelines — Optimistic Locking** — Zalando · *Intermediate* · a concrete corporate style guide with rules on `ETag`/`If-Match` versus version fields and when to require each. <https://opensource.zalando.com/restful-api-guidelines/>

---

*REST API Handbook — chapter 28.*
