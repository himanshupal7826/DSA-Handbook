# 14 · Partial Updates: PUT, PATCH & JSON Patch

> **In one line:** PUT replaces a resource wholesale and is idempotent; PATCH applies a *description of changes* and is not — and the format of that description (JSON Patch vs JSON Merge Patch) decides what you can express and what `null` means.

---

## 1. Overview

Updating a resource sounds like the simplest thing an API does, and it is where most APIs quietly become dangerous. The question is not "how do I change a field" but "**what did the client mean by the fields it did not send?**" Silence is ambiguous: it can mean "leave it alone," "set it to null," or "I don't know about that field because I'm running an older client." HTTP gives you two verbs that answer this differently, and getting the choice wrong causes real data loss.

**PUT** is defined by [RFC 9110 §9.3.4](https://www.rfc-editor.org/rfc/rfc9110#name-put) as *replace the target resource's state with the enclosed representation*. It is complete replacement: everything you omit is gone. Because applying the same PUT twice leaves the resource in the same state, PUT is **idempotent** — a property that makes retries safe and is the reason PUT is the right verb for "make this thing look exactly like this." **PATCH**, added by [RFC 5789](https://www.rfc-editor.org/rfc/rfc5789) in 2010, exists because full replacement is wasteful and unsafe in practice. A mobile client that wants to flip `notifications_enabled` should not have to download the whole user object, mutate one field, and PUT it back — that round trip introduces a lost-update race and forces the client to know about fields it may not understand. PATCH sends **a set of instructions** describing the change. Critically, the PATCH body is *not* a partial resource by definition; it is a **patch document** whose media type tells the server how to interpret it.

Two patch document formats matter. **JSON Patch** ([RFC 6902](https://www.rfc-editor.org/rfc/rfc6902), `application/json-patch+json`) is an array of explicit operations — `add`, `remove`, `replace`, `move`, `copy`, `test` — addressed by [JSON Pointer](https://www.rfc-editor.org/rfc/rfc6901). It can express anything, including array element manipulation and conditional application. **JSON Merge Patch** ([RFC 7386](https://www.rfc-editor.org/rfc/rfc7386), `application/merge-patch+json`) is a JSON object that looks like the resource: present keys are set, `null` means *delete this member*, absent keys are untouched. It is far friendlier but cannot express "set this field to null" or "insert into an array at index 2."

**Concrete example.** GitHub's REST API uses `PATCH /repos/{owner}/{repo}` with a plain JSON body (an ad-hoc merge-patch style) for updating repository settings. Kubernetes exposes all three — `application/json-patch+json`, `application/merge-patch+json`, and its own `application/strategic-merge-patch+json` — and `kubectl patch --type=json|merge|strategic` picks between them. Stripe's `POST /v1/customers/{id}` is a partial update in all but name, with a documented convention that you send `""` to unset a string. Every one of these designs is answering the same question: *what does an omitted field mean?*

## 2. Core Concepts

- **PUT** — full replacement of the resource at the request URI with the enclosed representation. Idempotent. Omitted fields are removed/reset.
- **PATCH** — apply a patch document that *describes* changes. Not inherently idempotent, because operations like `add` to an array append each time it is applied.
- **Patch document** — the request body of a PATCH. Its meaning is entirely determined by `Content-Type`; a server must reject media types it does not support with `415 Unsupported Media Type`.
- **JSON Patch (RFC 6902)** — `[{"op":"replace","path":"/email","value":"a@b.com"}]`. Operations: `add`, `remove`, `replace`, `move`, `copy`, `test`. Media type `application/json-patch+json`.
- **JSON Pointer (RFC 6901)** — the path syntax inside JSON Patch: `/address/city`, `/tags/0`, `/tags/-` (append). `~0` escapes `~`, `~1` escapes `/`.
- **`test` operation** — asserts a value at a path; if it fails the *entire* patch is rejected. This gives you optimistic concurrency at the field level.
- **JSON Merge Patch (RFC 7386)** — a resource-shaped object where `null` means "remove this member" and arrays are replaced wholesale, never merged. Media type `application/merge-patch+json`.
- **Atomicity** — RFC 6902 requires JSON Patch to be applied **all-or-nothing**: if any operation fails, the resource must be unchanged.
- **Idempotency** — applying the request N times yields the same state as applying it once. PUT and `DELETE` are idempotent by definition; PATCH is only idempotent if the patch document happens to be (e.g. all `replace` ops).
- **Optimistic concurrency** — using `ETag` + `If-Match` (or a `version` field) so a client's update is rejected with `412 Precondition Failed` if someone else changed the resource first.
- **Tri-state field** — a field with three meaningful states: *absent* (don't touch), *null* (clear it), *value* (set it). Merge Patch collapses two of these; JSON Patch keeps all three.

## 3. Theory & Principles

### 3.1 The semantics table

The entire chapter reduces to one question — *what happens to a field I did not send?* — answered three ways:

| Field in request | PUT | JSON Merge Patch | JSON Patch |
|---|---|---|---|
| Present with a value | set to that value | set to that value | only via an explicit `replace`/`add` op |
| Present as `null` | set to null (it is part of the new state) | **delete the member** | `{"op":"replace","path":"/x","value":null}` sets null |
| Absent | **removed / reset to default** | untouched | untouched |

The killer consequence: **JSON Merge Patch cannot set a field to `null`.** If your domain has a genuinely nullable field (`cancelled_at`, `manager_id`, `discount_code`), merge patch forces you to invent a sentinel or switch to JSON Patch. This is not an edge case; it is the single most common reason teams move to RFC 6902.

### 3.2 Idempotency, precisely

RFC 9110 §9.2.2 defines a method as idempotent if "the intended effect on the server of multiple identical requests with that method is the same as the effect for a single such request." PUT satisfies this trivially: the final state is the body you sent, no matter how many times you send it.

PATCH does not, and the counterexample is one line:

```json
[{ "op": "add", "path": "/tags/-", "value": "urgent" }]
```

Apply it twice and you have `["urgent", "urgent"]`. So a client retrying a PATCH after a network timeout can silently corrupt data. Three ways to make PATCH safe under retry:

1. **Use only idempotent operations** (`replace` on a scalar path is; `add` to `/tags/-` is not).
2. **Guard with `test`** — prepend `{"op":"test","path":"/tags/2","value":null}` so a second application fails.
3. **Use `If-Match: "<etag>"`** — the retry's precondition fails with `412` because the first application changed the ETag. This is the general, format-independent answer, and it also solves lost updates.

### 3.3 The lost-update problem

Two clients read a resource at version 1. A sets `email`; B sets `phone`. With **PUT** and no precondition, whoever writes last wipes the other's change — the classic lost update. With **PATCH**, the field-level nature of the change means A and B touch disjoint fields and both survive, which is one of PATCH's real advantages. But PATCH does not save you when both edit the *same* field, and it does not save you when the client's decision about *what* to patch was based on stale data.

The correct mechanism is conditional requests ([RFC 9110 §13](https://www.rfc-editor.org/rfc/rfc9110#name-conditional-requests)): the server returns `ETag: "v7"` on GET, the client echoes `If-Match: "v7"` on PUT/PATCH, and the server returns `412 Precondition Failed` if the current ETag differs. For resources where a lost update is unacceptable, require the header and return `428 Precondition Required` when it is missing.

```svg
<svg viewBox="0 0 780 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="10" y="10" width="760" height="310" rx="14" fill="#f8fafc" stroke="#4f46e5"/>
  <text x="390" y="36" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Same intent, three request shapes</text>
  <rect x="26" y="54" width="230" height="60" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="141" y="76" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Stored resource (v7)</text>
  <text x="141" y="94" text-anchor="middle" fill="#1e293b" font-size="11">{ name, email, phone, plan }</text>
  <text x="141" y="108" text-anchor="middle" fill="#1e293b" font-size="11">goal: change email, clear phone</text>
  <rect x="26" y="136" width="230" height="160" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="141" y="158" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">PUT (full replace)</text>
  <text x="42" y="180" fill="#1e293b" font-size="11">{ "name": "Ada",</text>
  <text x="42" y="196" fill="#1e293b" font-size="11">  "email": "ada@new.io",</text>
  <text x="42" y="212" fill="#1e293b" font-size="11">  "phone": null,</text>
  <text x="42" y="228" fill="#1e293b" font-size="11">  "plan": "pro" }</text>
  <text x="42" y="254" fill="#1e293b" font-size="11" font-weight="700">Must send every field.</text>
  <text x="42" y="272" fill="#1e293b" font-size="11">Omit plan &#8594; plan is lost. Idempotent.</text>
  <rect x="272" y="136" width="230" height="160" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="387" y="158" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Merge Patch (RFC 7386)</text>
  <text x="288" y="180" fill="#1e293b" font-size="11">{ "email": "ada@new.io",</text>
  <text x="288" y="196" fill="#1e293b" font-size="11">  "phone": null }</text>
  <text x="288" y="222" fill="#1e293b" font-size="11" font-weight="700">null = delete member.</text>
  <text x="288" y="238" fill="#1e293b" font-size="11">Absent keys untouched.</text>
  <text x="288" y="254" fill="#1e293b" font-size="11">Arrays replaced whole.</text>
  <text x="288" y="270" fill="#1e293b" font-size="11">Cannot store explicit null.</text>
  <rect x="518" y="136" width="234" height="160" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="635" y="158" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">JSON Patch (RFC 6902)</text>
  <text x="534" y="180" fill="#1e293b" font-size="11">[{"op":"test","path":"/email",</text>
  <text x="534" y="194" fill="#1e293b" font-size="11">  "value":"ada@old.io"},</text>
  <text x="534" y="210" fill="#1e293b" font-size="11"> {"op":"replace","path":"/email",</text>
  <text x="534" y="224" fill="#1e293b" font-size="11">  "value":"ada@new.io"},</text>
  <text x="534" y="240" fill="#1e293b" font-size="11"> {"op":"remove","path":"/phone"}]</text>
  <text x="534" y="266" fill="#1e293b" font-size="11" font-weight="700">All-or-nothing application.</text>
  <text x="534" y="282" fill="#1e293b" font-size="11">test op &#8594; conditional update.</text>
</svg>
```

### 3.4 When PUT is still right

Choose PUT when the client legitimately owns the whole representation: configuration documents, feature flags, a full profile edit form, idempotent upserts by a client-chosen id (`PUT /users/{uuid}` creating the resource and returning `201` + `Location`), and any "make it exactly so" reconciliation loop. Its idempotency makes retry logic trivial. Choose PATCH when changes are small, concurrent, or partial by nature.

## 4. Architecture & Workflow

The complete lifecycle of a safe partial update:

1. **Client GETs the resource** and stores the `ETag` (e.g. `"7c9f1a"`) alongside the data.
2. **User edits one field** in the UI. The client computes a *minimal* patch — not a full object diff, which would re-send unrelated fields it never modified.
3. **Client sends PATCH** with `Content-Type: application/merge-patch+json` (or `application/json-patch+json`) and `If-Match: "7c9f1a"`.
4. **Gateway/framework content negotiation** — if the media type is unsupported, respond `415` and advertise what you accept in the problem detail. Do not fall back to "treat it as JSON."
5. **Precondition evaluation** — the server loads the current resource, computes/reads its ETag, and compares. Mismatch → `412 Precondition Failed`, body empty or a problem detail. Missing `If-Match` on a protected resource → `428 Precondition Required`.
6. **Patch parsing & structural validation** — malformed JSON or an invalid op/path syntax → `400`; a well-formed patch that cannot be applied (`remove` of a nonexistent path, failed `test`) → `409 Conflict` per RFC 5789 §2.2.
7. **Apply to an in-memory copy** — never mutate the stored entity directly. RFC 6902 mandates atomicity, so the patched document only becomes real if every operation succeeds.
8. **Domain validation of the *result*** — the patched document must satisfy your schema and business invariants. A patch that produces `age: -5` or removes a required field → `422 Unprocessable Content` with field-level errors. This is the step teams forget: they validate the patch, not the outcome.
9. **Authorization on changed fields** — check that the caller may modify *these specific* fields. `role`, `balance`, `verified`, and `owner_id` must be rejected (`403`) even if the caller may edit the resource generally. Better still, whitelist patchable paths.
10. **Persist with an optimistic concurrency guard** — `UPDATE ... WHERE id = ? AND version = ?`. Zero rows affected → someone raced you → `412`.
11. **Respond** — `200 OK` with the full updated representation and a **new `ETag`** (or `204 No Content` if the client asked for no body). Never return `200` with the *old* ETag.
12. **Emit a domain event / audit record** containing the applied diff, the actor, and the request id.

```svg
<svg viewBox="0 0 780 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="10" y="10" width="760" height="380" rx="14" fill="#f8fafc" stroke="#4f46e5"/>
  <text x="390" y="36" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">PATCH pipeline with conditional request</text>
  <rect x="30" y="56" width="110" height="46" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="85" y="76" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Client</text>
  <text x="85" y="92" text-anchor="middle" fill="#1e293b" font-size="10">holds ETag "7c9f1a"</text>
  <rect x="175" y="56" width="130" height="46" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="240" y="76" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Media type check</text>
  <text x="240" y="92" text-anchor="middle" fill="#1e293b" font-size="10">else 415</text>
  <rect x="340" y="56" width="130" height="46" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="405" y="76" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">If-Match check</text>
  <text x="405" y="92" text-anchor="middle" fill="#1e293b" font-size="10">else 412 / 428</text>
  <rect x="505" y="56" width="120" height="46" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="565" y="76" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Apply patch</text>
  <text x="565" y="92" text-anchor="middle" fill="#1e293b" font-size="10">atomic, on a copy</text>
  <rect x="660" y="56" width="90" height="46" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="705" y="76" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Validate</text>
  <text x="705" y="92" text-anchor="middle" fill="#1e293b" font-size="10">result, not patch</text>
  <path d="M140 79 h31 m-8 -4 l8 4 l-8 4" fill="none" stroke="#4f46e5" stroke-width="2"/>
  <path d="M305 79 h31 m-8 -4 l8 4 l-8 4" fill="none" stroke="#4f46e5" stroke-width="2"/>
  <path d="M470 79 h31 m-8 -4 l8 4 l-8 4" fill="none" stroke="#4f46e5" stroke-width="2"/>
  <path d="M625 79 h31 m-8 -4 l8 4 l-8 4" fill="none" stroke="#4f46e5" stroke-width="2"/>
  <rect x="30" y="130" width="720" height="106" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="46" y="152" fill="#1e293b" font-size="12" font-weight="700">PATCH /v1/users/u_918 HTTP/1.1</text>
  <text x="46" y="172" fill="#1e293b" font-size="12">Content-Type: application/merge-patch+json</text>
  <text x="46" y="192" fill="#1e293b" font-size="12">If-Match: "7c9f1a"</text>
  <text x="46" y="214" fill="#1e293b" font-size="12">{ "email": "ada@new.io", "phone": null }</text>
  <text x="46" y="230" fill="#1e293b" font-size="11">phone is removed; name and plan are untouched.</text>
  <rect x="30" y="252" width="350" height="124" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="46" y="276" fill="#1e293b" font-size="12" font-weight="700">200 OK</text>
  <text x="46" y="298" fill="#1e293b" font-size="12">ETag: "b31d40"</text>
  <text x="46" y="320" fill="#1e293b" font-size="12">{ "id":"u_918", "email":"ada@new.io", ... }</text>
  <text x="46" y="344" fill="#1e293b" font-size="11">New ETag lets the client keep editing safely.</text>
  <rect x="400" y="252" width="350" height="124" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="416" y="276" fill="#1e293b" font-size="12" font-weight="700">412 Precondition Failed</text>
  <text x="416" y="298" fill="#1e293b" font-size="12">{ "title":"Resource was modified",</text>
  <text x="416" y="320" fill="#1e293b" font-size="12">  "current_etag":"c1a992" }</text>
  <text x="416" y="344" fill="#1e293b" font-size="11">Client re-fetches, re-diffs, retries.</text>
</svg>
```

## 5. Implementation

### 5.1 PUT — full replacement, idempotent

```http
PUT /v1/users/u_918 HTTP/1.1
Content-Type: application/json
If-Match: "7c9f1a"

{ "name": "Ada Lovelace", "email": "ada@new.io", "phone": null, "plan": "pro" }
```

```http
HTTP/1.1 200 OK
ETag: "b31d40"

{ "id": "u_918", "name": "Ada Lovelace", "email": "ada@new.io", "phone": null, "plan": "pro" }
```

PUT to a URI that does not exist may **create** the resource (an upsert with a client-chosen id) — respond `201 Created` with a `Location` header, and guard create-only intent with `If-None-Match: *`.

### 5.2 JSON Merge Patch

```http
PATCH /v1/users/u_918 HTTP/1.1
Content-Type: application/merge-patch+json
If-Match: "7c9f1a"

{ "email": "ada@new.io", "phone": null, "prefs": { "theme": "dark" } }
```

Result: `email` set, `phone` **removed**, `prefs.theme` set (merge patch recurses into objects), everything else untouched. But if `tags` were `["a","b"]` and you sent `{"tags":["c"]}`, the result is `["c"]` — arrays are replaced, never merged.

### 5.3 JSON Patch with a `test` guard

```http
PATCH /v1/users/u_918 HTTP/1.1
Content-Type: application/json-patch+json

[ { "op": "test",    "path": "/plan",   "value": "free" },
  { "op": "replace", "path": "/plan",   "value": "pro" },
  { "op": "remove",  "path": "/phone" },
  { "op": "add",     "path": "/tags/-", "value": "upgraded" } ]
```

If `plan` is not `"free"` the whole patch is rejected and **nothing** is applied:

```http
HTTP/1.1 409 Conflict
Content-Type: application/problem+json

{ "type": "https://api.example.com/problems/patch-test-failed",
  "title": "Patch precondition failed", "status": 409,
  "detail": "Operation 0 (test /plan) expected \"free\" but found \"pro\".",
  "failed_operation_index": 0 }
```

Equivalent with curl: `curl -i -X PATCH .../v1/users/u_918 -H 'Content-Type: application/json-patch+json' -H 'If-Match: "7c9f1a"' -d '[{"op":"test",...}]'`.

### 5.4 FastAPI: both patch formats, done correctly

```python
import hashlib, json
from typing import Any, Optional
from fastapi import FastAPI, Header, HTTPException, Request, Response
import jsonpatch                              # pip install jsonpatch

app = FastAPI()
PATCHABLE = ("/name", "/email", "/phone", "/prefs", "/tags")   # allow-list


def etag_of(doc: dict) -> str:
    canonical = json.dumps(doc, sort_keys=True, separators=(",", ":"))
    return '"' + hashlib.sha256(canonical.encode()).hexdigest()[:12] + '"'


def merge_patch(target: Any, patch: Any) -> Any:
    """RFC 7386 reference algorithm — 10 lines, worth memorising."""
    if not isinstance(patch, dict):
        return patch
    if not isinstance(target, dict):
        target = {}
    for k, v in patch.items():
        if v is None:
            target.pop(k, None)               # null means DELETE the member
        else:
            target[k] = merge_patch(target.get(k), v)
    return target


@app.patch("/v1/users/{user_id}")
async def patch_user(user_id: str, request: Request, response: Response,
                     if_match: Optional[str] = Header(None)):
    stored = await load_user(user_id)
    if stored is None:
        raise HTTPException(404, "User not found")
    current = etag_of(stored)
    if if_match is None:
        raise HTTPException(428, "If-Match header is required")
    if if_match not in (current, "*"):
        raise HTTPException(412, "Resource was modified")

    ctype = (request.headers.get("content-type") or "").split(";")[0].strip()
    body = await request.json()
    candidate = json.loads(json.dumps(stored))            # deep copy

    if ctype == "application/merge-patch+json":
        candidate = merge_patch(candidate, body)
    elif ctype == "application/json-patch+json":
        for op in body:
            if not op["path"].startswith(PATCHABLE):
                raise HTTPException(403, f"Path not patchable: {op['path']}")
        try:
            candidate = jsonpatch.JsonPatch(body).apply(candidate)   # atomic
        except jsonpatch.JsonPatchTestFailed as e:
            raise HTTPException(409, f"Patch precondition failed: {e}")
        except jsonpatch.JsonPatchException as e:
            raise HTTPException(400, f"Malformed patch: {e}")
    else:
        raise HTTPException(415, "Use merge-patch+json or json-patch+json")

    updated = User(**candidate)          # Pydantic, extra="forbid": validate the RESULT
    if await save_if_version_matches(user_id, updated, expected=current) == 0:
        raise HTTPException(412, "Resource was modified")
    doc = updated.model_dump()
    response.headers["ETag"] = etag_of(doc)
    return doc
```

### 5.5 Client side: diff minimally, handle `412`

```javascript
// Send only the fields the user actually touched; "" in the form means clear.
const patch = Object.fromEntries([...dirty].map(f => [f, form[f] === "" ? null : form[f]]));
const res = await fetch(`/v1/users/${id}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/merge-patch+json", "If-Match": etag },
  body: JSON.stringify(patch),
});
if (res.status === 412)   // re-diff against fresh state, never blind retry
  showConflictUI(await fetch(`/v1/users/${id}`).then(r => r.json()));
```

### 5.6 OpenAPI 3.1 fragment

```yaml
patch:
  parameters:
    - { name: If-Match, in: header, required: true, schema: { type: string } }
  requestBody:
    required: true
    content:
      application/merge-patch+json:
        schema: { $ref: "#/components/schemas/UserMergePatch" }
      application/json-patch+json:
        schema:
          type: array
          items:
            type: object
            required: [op, path]
            properties:
              op:    { enum: [add, remove, replace, move, copy, test] }
              path:  { type: string, pattern: "^(/[^/~]*(~[01][^/~]*)*)*$" }
              value: {}
              from:  { type: string }
  responses:
    "200": { description: Updated; ETag header carries the new version }
    "409": { description: A test op failed or the patch is inapplicable }
    "412": { description: If-Match did not match the current ETag }
```

### 5.7 Optimization notes

- **Do not read-modify-write in two round trips.** Use `UPDATE users SET email = :e WHERE id = :id AND version = :v RETURNING *` so the concurrency check and the write are one statement holding no locks between round trips.
- **Bound the patch document** — cap JSON Patch at ~100 operations and a few hundred KB; `move`/`copy` over deep structures can be quadratic and is a memory-amplification vector.
- **Cache the ETag** rather than re-hashing the document per request: store a `version` bigint and derive `W/"v{version}"`. Strong ETags require byte-identical representations, which content negotiation breaks, so a weak ETag is usually the honest choice.
- **Prefer merge patch for mobile clients** — smaller bodies, trivially built from a dirty-field set.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| PUT (full replace) | Idempotent, trivially retryable, unambiguous final state, doubles as an upsert with a client-chosen id | Client must know and send *every* field; unknown-field ignorance causes data loss; large bodies; guarantees lost updates without `If-Match` |
| PATCH generally | Small payloads, concurrent edits to disjoint fields both survive, clients need not understand the whole resource | Not idempotent by default; requires a media type contract; server complexity |
| JSON Merge Patch | Reads like the resource, trivial to construct, natural recursion into nested objects | Cannot set a field to `null`; cannot address array elements; arrays replaced wholesale |
| JSON Patch | Expresses everything: array insert/remove, `move`, `copy`, conditional `test`; atomic by spec | Verbose; JSON Pointer escaping is error-prone; clients rarely generate it by hand; ordering bugs |
| ETag + `If-Match` | Format-independent lost-update prevention and PATCH retry safety | Extra round trip on conflict; clients must store and forward the ETag; weak vs strong ETag subtleties |
| Returning the full body on success | Client resyncs in one round trip; new ETag delivered | Larger responses; consider `204` + `ETag` when the client already knows the result |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Using PUT for a partial update** — the client sends 3 of 12 fields and the other 9 are wiped. → ✅ PUT means replace; if the client sends partial data, use PATCH, or reject the PUT with `422` when required fields are missing.
2. ⚠️ **Treating a PATCH body as "a partial resource" without declaring a media type**, so `null` is ambiguous. → ✅ Accept `application/merge-patch+json` explicitly and `415` anything else. If you support plain `application/json` for compatibility, document it as merge-patch semantics.
3. ⚠️ **Merge patch used for a nullable field**, making it impossible to set `cancelled_at: null` back to null. → ✅ Use JSON Patch for tri-state fields, or model the clear operation as a sub-resource action (`DELETE /orders/{id}/cancellation`).
4. ⚠️ **Retrying a PATCH after a timeout** and appending the same array element twice. → ✅ Require `If-Match`; a retry then fails with `412` instead of duplicating. Alternatively use an `Idempotency-Key` header.
5. ⚠️ **Validating the patch instead of the result.** A `remove` of a required field passes patch validation and produces an invalid entity. → ✅ Apply to a copy, then run full schema + invariant validation on the *result*; `422` on failure.
6. ⚠️ **Mass assignment** — blindly merging the patch into the entity lets a caller set `"role": "admin"` or `"balance": 999999`. → ✅ Allow-list patchable paths and check field-level authorization; return `403` for forbidden paths.
7. ⚠️ **Non-atomic JSON Patch application**, leaving the resource half-modified when operation 4 of 6 fails. → ✅ RFC 6902 requires all-or-nothing: apply to a deep copy inside a transaction and commit only on full success.
8. ⚠️ **Returning `200 OK` with the stale ETag** (or no ETag at all), so the client's next conditional request immediately `412`s. → ✅ Always return the new `ETag` with the response, and return the updated representation or `204`.
9. ⚠️ **Wrong status codes** — `400` for a failed `test` op, or `409` for malformed JSON. → ✅ `400` malformed body, `415` unsupported patch type, `422` result violates schema, `409` patch is well-formed but inapplicable (failed `test`, missing path), `412` stale `If-Match`.
10. ⚠️ **Silently ignoring unknown fields** in a PUT, so a typo (`emial`) is accepted and the real field is wiped. → ✅ Reject unknown fields with `422` (Pydantic `extra="forbid"`), or at minimum echo warnings.
11. ⚠️ **JSON Pointer escaping ignored** (a key literally named `a/b` addressed as `/a/b`), or **making PATCH the only update verb** so clients must diff a form that owns the whole object. → ✅ Escape `~` as `~0` and `/` as `~1`, and support both PUT and PATCH — they coexist happily.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Log the *applied diff*, not the raw patch — store `{path, before, after}` triples in an audit record keyed by request id and actor. When a customer says "my phone number disappeared," this is the only artifact that answers whether a merge patch sent `null`, a PUT omitted the field, or a background job did it. Also log the declared `Content-Type` — the most common production surprise is a client sending `application/json` to a merge-patch endpoint and getting different null semantics than it expected — and reproduce failures by replaying the stored patch against the stored pre-image.

**Monitoring.** Track per-endpoint rates of `412` (concurrency contention — a rising rate means users are colliding and your UI needs live refresh or finer-grained resources), `409` (failed `test` ops), `415` (a client shipped with the wrong media type — usually a bad SDK release), and `422` (result-validation failures). Watch the ratio of PATCH to PUT and the average patch size; a patch document that averages the full resource size means clients are diffing badly and you are paying PATCH's complexity for none of its benefit. Emit a histogram of *fields changed per request*.

**Security.** Partial updates are the classic vector for **BOLA/BFLA and mass assignment** — OWASP API Security Top 10 #1 and #3. Three non-negotiables: (1) object-level authorization on the resource *before* applying the patch; (2) a field-level allow-list, so `role`, `is_verified`, `tenant_id`, `balance`, and `price` are never patchable through the user-facing endpoint; (3) validation of the resulting document, including cross-field invariants. JSON Patch adds two extra risks: `copy`/`move` with deeply nested pointers can be used to amplify document size (a zip-bomb-ish DoS), so cap operation count and result size; and pointer paths into arrays can bypass naive prefix-based allow-lists (`/prefs/../role` is not valid JSON Pointer, but `/0/role` on an array-typed resource might be), so resolve and re-check the *effective* changed paths after application by diffing before/after.

**Performance & scaling.** Under contention, `If-Match` turns lost updates into `412`s, which turns into client retry storms. Mitigate by making resources finer-grained (patch `/users/{id}/preferences` instead of the whole user), by using field-level `test` ops so non-conflicting edits succeed, or by moving to a CRDT/last-write-wins-per-field model for genuinely collaborative data. On the storage side, prefer a single conditional `UPDATE ... WHERE version = ?` over a read-then-write transaction — it holds no locks between round trips. For very large documents, store them as JSONB and apply merge patches in the database (`jsonb_set`, `||`) so you never ship the whole document over the wire; measure first, because in-database patching bypasses your application-level validation and authorization.

## 9. Interview Questions

**Q: What is the difference between PUT and PATCH?**
A: PUT replaces the entire resource with the representation in the body — fields you omit are removed or reset. PATCH carries a *patch document* describing changes, so untouched fields are preserved. PUT is idempotent by definition; PATCH is not, unless the patch document happens to be.

**Q: Is PATCH idempotent?**
A: Not inherently. `[{"op":"add","path":"/tags/-","value":"x"}]` appends on every application, so applying it twice differs from applying it once. You make PATCH retry-safe with `If-Match` on an ETag, an idempotency key, a `test` guard, or by restricting yourself to `replace` on scalar paths.

**Q: In JSON Merge Patch, what does `null` mean?**
A: It means *remove this member from the target*, not "set it to null." That is why merge patch cannot express "store an explicit null" — an important limitation for genuinely nullable fields. RFC 7386 also specifies that arrays are replaced wholesale rather than merged.

**Q: When would you choose JSON Patch over JSON Merge Patch?**
A: When you need to address array elements (insert at an index, remove one item), when you need to set a field to null explicitly, or when you want conditional application via the `test` operation. The price is verbosity and a document format clients rarely generate by hand.

**Q: What status code do you return when a JSON Patch `test` operation fails?**
A: `409 Conflict` — the patch document is well-formed and understood, but cannot be applied to the current state of the resource (RFC 5789 §2.2). Reserve `400` for a malformed body, `422` for a result that violates your schema, and `412` for a stale `If-Match`.

**Q: How do you prevent lost updates on a partial update endpoint?**
A: Return an `ETag` on GET, require `If-Match` on PATCH/PUT, and return `412 Precondition Failed` when it does not match the current value. If the header is absent on a resource where lost updates are unacceptable, return `428 Precondition Required`. Back it with a conditional `UPDATE ... WHERE version = ?` so the check is atomic with the write.

**Q: Can PUT create a resource?**
A: Yes — PUT to a URI that does not exist may create it, which makes it the natural verb for upserts with client-chosen identifiers. Respond `201 Created` with a `Location` header on creation and `200`/`204` on replacement, and use `If-None-Match: *` when the client intends create-only semantics.

**Q: Why is content type so important for PATCH?**
A: Because PATCH's body has no fixed meaning — RFC 5789 deliberately leaves the patch format to the media type. `application/merge-patch+json` and `application/json-patch+json` interpret the same bytes completely differently, especially around `null`. A server must reject unknown patch types with `415` rather than guessing.

**Q: (Senior) How do you defend a PATCH endpoint against mass assignment?**
A: Maintain an explicit allow-list of patchable JSON Pointer paths and reject anything else with `403`; never merge the request body straight into the persistence entity. Layer object-level authorization before application, field-level authorization for privileged paths (`role`, `tenant_id`, `balance`), and full validation of the *resulting* document. Finally, diff before/after and assert that only allow-listed paths actually changed — that catches aliasing tricks the pre-check missed.

**Q: (Senior) Two clients patch disjoint fields of the same resource concurrently. What happens under each strategy?**
A: With PUT and no precondition, the later write wipes the earlier one — a silent lost update. With PATCH and no precondition, both changes survive because they touch different fields, which is a genuine advantage of PATCH. With `If-Match`, the second client gets `412` even though the edits do not conflict, so under high contention you either shrink the resource (patch a sub-resource), use field-scoped `test` operations, or use per-field versioning so only true conflicts fail.

**Q: (Senior) How would you evolve a PUT-only API to support partial updates without breaking clients?**
A: Add PATCH as a new method on the same URI, advertise it in the `Allow` header and OPTIONS response, and support `application/merge-patch+json` first because it is easiest for clients. Leave PUT semantics exactly as they are — do not "helpfully" make PUT merge, because existing clients depend on omitted fields being cleared. Ship the ETag/`If-Match` story alongside it, monitor adoption via media-type metrics, and only deprecate PUT (with `Deprecation`/`Sunset` headers) if it truly becomes unused.

**Q: (Senior) What are the risks specific to JSON Patch that merge patch does not have?**
A: Operation ordering makes patches non-commutative and hard to reason about; `move`/`copy` on large nested structures can amplify document size into a memory DoS; JSON Pointer escaping bugs (`~0`/`~1`) silently address the wrong node; and array index paths can slip past prefix-based authorization allow-lists. Mitigate with an operation-count cap, a result-size cap, a resolved-path allow-list check, and before/after diffing to verify only intended paths changed.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** PUT replaces the whole resource — omitted fields are gone — and is idempotent, so it is right for "make this exactly so," including upserts with client-chosen ids (`201` + `Location`). PATCH sends a *patch document* whose meaning comes entirely from its media type. **JSON Merge Patch** (`application/merge-patch+json`) looks like the resource: present keys set, `null` **deletes** the member, absent keys untouched, arrays replaced wholesale — friendly, but it can never store an explicit null. **JSON Patch** (`application/json-patch+json`) is an ordered array of `add/remove/replace/move/copy/test` ops over JSON Pointers, applied atomically, and its `test` op gives conditional updates. PATCH is *not* idempotent, so guard retries with `If-Match` on an ETag — mismatch is `412`, missing on a protected resource is `428`. Always apply the patch to a copy, validate the **result** (not the patch), enforce a patchable-path allow-list against mass assignment, and return the new `ETag`.

| Situation | Response |
|---|---|
| PUT replaced an existing resource | `200` + body + new `ETag`, or `204` |
| PUT created the resource | `201` + `Location` + `ETag` |
| PATCH applied successfully | `200` + updated body + new `ETag` |
| Malformed JSON / invalid op syntax | `400` |
| Unsupported patch media type | `415` |
| Failed `test` op / path not present | `409` |
| Patched result violates schema | `422` |
| `If-Match` does not match | `412` |
| `If-Match` required but absent | `428` |
| Forbidden field path in patch | `403` |

- **PUT vs PATCH** → replace-everything (idempotent) vs describe-a-change (not idempotent).
- **Merge patch `null`** → deletes the member; cannot store an explicit null.
- **JSON Patch atomicity** → all ops succeed or the resource is unchanged (RFC 6902).
- **Retry safety** → `If-Match: "<etag>"`; second application gets `412`.
- **Validate what?** → the patched *result*, plus a patchable-path allow-list.

## 11. Hands-On Exercises & Mini Project

- [ ] Implement the RFC 7386 merge-patch algorithm from scratch and verify it against every example in Appendix A of the RFC.
- [ ] Write a test proving a merge patch cannot set a field to `null`, then express the same intent as a JSON Patch `replace` with `value: null`.
- [ ] Build a PATCH endpoint returning `409` when a `test` op fails and `422` when the patched document fails schema validation; assert both in integration tests.
- [ ] Demonstrate a lost update with two concurrent PUTs, then fix it with `ETag` + `If-Match` and show the second request receiving `412`.
- [ ] Add a patchable-path allow-list and prove `[{"op":"replace","path":"/role","value":"admin"}]` returns `403`.

**Mini Project — a conflict-aware profile service.**
*Goal:* Build `GET/PUT/PATCH /v1/profiles/{id}` in FastAPI supporting both patch media types with correct semantics and full concurrency control.
*Requirements:* Strong-ish `ETag` derived from a `version` column; `If-Match` required on PUT and PATCH (`428` if missing); merge patch and JSON Patch both supported with `415` for anything else; atomic application on a deep copy; result validated by a Pydantic model with `extra="forbid"`; allow-list blocking `/role`, `/tenant_id`, `/verified`; an append-only `profile_audit` table recording `{path, before, after, actor, request_id}`; and a conformance test suite driven by the RFC 6902/7386 example vectors.
*Extensions:* Add an `Idempotency-Key` header so a retried PATCH replays the original response; add a `PATCH /v1/profiles/{id}/preferences` sub-resource to reduce contention; expose the audit log as `GET /v1/profiles/{id}/history` with cursor pagination; emit counters for `412`/`409`/`415` and alert on a `415` spike after a client release.

## 12. Related Topics & Free Learning Resources

**Related chapters:** *HTTP Methods & Idempotency* for the safety/idempotency definitions behind PUT; *Caching, ETags & Conditional Requests* for how ETags are generated and validated; *Error Handling & Problem Details* (chapter 16) for the `409`/`422` bodies shown here; *Validation & Input Handling* (chapter 17) for validating the patched result; *Bulk & Batch Operations* (chapter 15) for applying many patches at once; *API Versioning & Evolution* for adding PATCH without breaking PUT clients.

**Free Learning Resources**
- **RFC 9110 — HTTP Semantics** — IETF · *Intermediate* · normative definitions of PUT, PATCH's place, idempotency, and conditional requests. <https://www.rfc-editor.org/rfc/rfc9110>
- **RFC 5789 — PATCH Method for HTTP** — IETF · *Intermediate* · the four-page spec that defines PATCH and its error semantics (including `409` and `415`). <https://www.rfc-editor.org/rfc/rfc5789>
- **RFC 6902 — JavaScript Object Notation (JSON) Patch** — IETF · *Intermediate* · every operation with examples; read Appendix A as a test suite. <https://www.rfc-editor.org/rfc/rfc6902>
- **RFC 7386 — JSON Merge Patch** — IETF · *Beginner* · six pages including the complete reference algorithm and the null-deletion rule. <https://www.rfc-editor.org/rfc/rfc7386>
- **RFC 6901 — JSON Pointer** — IETF · *Beginner* · the path syntax and the `~0`/`~1` escaping rules that trip everyone up. <https://www.rfc-editor.org/rfc/rfc6901>
- **Update API Objects in Place Using kubectl patch** — Kubernetes · *Advanced* · the best real-world comparison of json, merge, and strategic-merge patch on the same object. <https://kubernetes.io/docs/tasks/manage-kubernetes-objects/update-api-object-kubectl-patch/>
- **OWASP API Security Top 10 — Broken Object Property Level Authorization** — OWASP · *Intermediate* · why mass assignment through PATCH is a top-3 API vulnerability and how to structure defenses. <https://owasp.org/API-Security/editions/2023/en/0xa3-broken-object-property-level-authorization/>

---

*REST API Handbook — chapter 14.*
