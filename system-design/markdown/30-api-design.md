# 30 · API Design, Versioning & Pagination

> **In one line:** A good API is a durable contract — model resources cleanly, fail predictably, evolve without breaking callers, and page large results without melting your database.

---

## 1. Overview

An **API is a contract** you can't easily take back. Once a client integrates, every field name, status code, and default behavior is load-bearing; changing them breaks code you don't control. So API design is really *interface design under the constraint of permanence* — you optimize for clarity today and evolvability forever.

Great APIs share a texture: **consistent resource modeling** (predictable URLs and shapes), **honest status codes and error envelopes** (so clients can react programmatically), **idempotency** (safe retries in an unreliable network), a **versioning strategy** (so you can change without breaking), and **pagination + filtering** (so a call for "all orders" doesn't return 40M rows).

Two references define the modern bar. The **Google API Design Guide** codifies resource-oriented design, standard methods, and long-running operations. The **Stripe API** is the gold standard of developer experience: cursor pagination, idempotency keys, versioned by date, and error objects rich enough to build UIs from.

Example: an e-commerce `POST /orders` must return a stable order representation, handle a retried payment without double-charging (idempotency key), page a customer's order history (cursor), and let a mobile client fetch only the fields it renders (sparse fieldsets) — all while a `v1` client from three years ago keeps working.

## 2. Core Concepts

- **Resource modeling** — design around **nouns** (`/customers/{id}/orders`), not verbs. Collections are plural; sub-resources express containment; keep hierarchies shallow (2–3 levels).
- **Standard methods** — `GET` (read, safe), `POST` (create), `PUT` (full replace, idempotent), `PATCH` (partial update), `DELETE` (idempotent). Match semantics, don't tunnel everything through `POST`.
- **Status codes as protocol** — `2xx` success, `4xx` caller's fault (don't retry as-is), `5xx` server's fault (retryable). `201` created, `202` accepted (async), `409` conflict, `422` validation, `429` rate-limited.
- **Error envelope** — a consistent JSON body: a stable machine `code`, a human `message`, a `type`/category, and field-level `details`. Clients switch on `code`, never parse `message`.
- **Idempotency key** — a client-supplied unique key on unsafe writes; the server records the first result and returns it on retries, making `POST` safe to retry after a timeout.
- **Versioning** — a strategy to evolve the contract: **URI** (`/v1/...`), **header** (`Accept`/custom), or **date-based** (Stripe). Only breaking changes bump the version.
- **Backward compatibility** — additive changes (new optional field, new endpoint) don't break clients; renames, removals, type changes, and tightened validation do.
- **Pagination** — **offset/limit** (simple, breaks on shifting data, slow deep) vs **cursor/keyset** (stable, O(1) deep, the production default).
- **Filtering, sorting, sparse fieldsets** — `?status=paid&sort=-created&fields=id,total` so clients shape results without new endpoints.
- **Rate-limit headers** — `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (+ `Retry-After` on `429`) so clients self-throttle instead of hammering.

## 3. Architecture

An API sits behind a gateway that enforces cross-cutting concerns before requests hit business logic. Versioning, auth, rate limiting, and idempotency are gateway/middleware responsibilities; resource logic and pagination live in the service.

```svg
<svg viewBox="0 0 720 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a3" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <rect x="30" y="120" width="110" height="44" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="85" y="140" text-anchor="middle" fill="#1e293b">Client</text>
  <text x="85" y="156" text-anchor="middle" fill="#64748b" font-size="10">v1, Idem-Key</text>

  <line x1="140" y1="142" x2="185" y2="142" stroke="#475569" marker-end="url(#a3)"/>

  <rect x="190" y="70" width="150" height="150" rx="10" fill="#ecfdf5" stroke="#059669"/>
  <text x="265" y="90" text-anchor="middle" fill="#1e293b" font-weight="700">API Gateway</text>
  <text x="265" y="116" text-anchor="middle" fill="#64748b" font-size="11">• version route</text>
  <text x="265" y="136" text-anchor="middle" fill="#64748b" font-size="11">• authn / authz</text>
  <text x="265" y="156" text-anchor="middle" fill="#64748b" font-size="11">• rate limit (429)</text>
  <text x="265" y="176" text-anchor="middle" fill="#64748b" font-size="11">• idempotency</text>
  <text x="265" y="196" text-anchor="middle" fill="#64748b" font-size="11">• error envelope</text>

  <line x1="340" y1="120" x2="400" y2="110" stroke="#475569" marker-end="url(#a3)"/>
  <line x1="340" y1="170" x2="400" y2="180" stroke="#475569" marker-end="url(#a3)"/>

  <rect x="405" y="88" width="140" height="44" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="475" y="108" text-anchor="middle" fill="#1e293b">Orders service</text>
  <text x="475" y="124" text-anchor="middle" fill="#64748b" font-size="10">resource + cursor page</text>
  <rect x="405" y="158" width="140" height="44" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="475" y="178" text-anchor="middle" fill="#1e293b">Customers service</text>

  <line x1="545" y1="110" x2="600" y2="130" stroke="#475569" marker-end="url(#a3)"/>
  <line x1="545" y1="180" x2="600" y2="150" stroke="#475569" marker-end="url(#a3)"/>

  <rect x="605" y="110" width="90" height="60" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="650" y="136" text-anchor="middle" fill="#1e293b">DB</text>
  <text x="650" y="154" text-anchor="middle" fill="#64748b" font-size="10">keyset index</text>

  <rect x="190" y="240" width="150" height="40" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="265" y="260" text-anchor="middle" fill="#1e293b">Idempotency store</text>
  <text x="265" y="274" text-anchor="middle" fill="#64748b" font-size="10">key → saved response</text>
  <line x1="265" y1="220" x2="265" y2="240" stroke="#475569" marker-end="url(#a3)"/>
</svg>
```

## 4. How It Works

Lifecycle of an **idempotent, paginated** request:

1. **Client sends** `POST /v1/orders` with an `Idempotency-Key: <uuid>` header and a JSON body.
2. **Gateway routes by version** (`v1`), authenticates, and checks the **rate limit** — returns `429` + `Retry-After` if exceeded.
3. **Idempotency check** — the server looks up the key. If seen, it returns the *stored* prior response (same status + body) and skips execution. If new, it proceeds and locks the key.
4. **Validation** — malformed input → `422` with field-level `details`; the error envelope has a stable `code`.
5. **Execute + persist** — create the order, then **save the response against the idempotency key** (with a TTL, e.g. 24h) so retries are safe.
6. **Respond** `201 Created` with the order representation and a `Location` header.
7. **Later, the client lists history**: `GET /v1/orders?limit=20&sort=-created`. The server runs a **keyset** query (`WHERE created < :cursor ORDER BY created DESC LIMIT 21`), returns 20 items plus a `next_cursor` derived from the 21st.
8. **Client pages** by resending with `?cursor=<opaque>`; stable even as new orders arrive.

```text
POST /v1/orders                 GET /v1/orders?limit=20&cursor=eyJ...
Idempotency-Key: 6f1e-...       →
{ "amount": 4200, ... }         { "data": [...20...],
→ 201 Created                     "has_more": true,
{ "id":"or_9", "status":... }     "next_cursor": "eyJjcmVhdGVkIjoi..." }
```

## 5. Key Components / Deep Dive

### Status codes & error envelopes
Return the *right* code so clients branch correctly: `400` malformed, `401` unauthenticated, `403` unauthorized, `404` missing, `409` conflict (e.g., version mismatch), `422` semantic validation, `429` throttled, `503` overloaded. The envelope is a stable contract:

```text
{ "error": {
    "type": "invalid_request_error",
    "code": "amount_too_small",      // machine-stable, switch on this
    "message": "Amount must be ≥ 50",// human, may change
    "param": "amount",
    "doc_url": "https://.../amount_too_small" } }
```

Never leak stack traces; never encode failure as `200 { "ok": false }` — it breaks caches, retries, and monitoring.

### Idempotency keys
Non-safe operations (`POST` payments, transfers) must survive retries after a network timeout where the client doesn't know if the write landed. The client sends a unique `Idempotency-Key`; the server stores `key → (status, body)` on first success and *replays* it for duplicates within a TTL. Handle the race: two concurrent requests with the same key — lock on the key so the second waits or returns `409`. `PUT`/`DELETE` are naturally idempotent; `POST`/`PATCH` need the key.

### Versioning strategies
| Strategy | Example | Notes |
|---|---|---|
| **URI** | `/v1/orders` | Explicit, cache/browser-friendly, easy to route; couples version to path. |
| **Header** | `Accept: application/vnd.api+json;version=1` | Clean URLs, content-negotiation-native; less visible, harder to test in a browser. |
| **Date-based** | `Stripe-Version: 2024-06-20` | Pin per-account; ship many small dated changes; server maintains transform shims. |

Bump versions **only for breaking changes**. Prefer additive evolution so most changes need no bump. Maintain old versions with a deprecation window (6–12 months) and sunset headers.

### Pagination: offset vs cursor
**Offset** (`?offset=10000&limit=20`) is simple but the DB must scan and discard 10K rows (slow deep pages), and inserts/deletes shift the window (items skipped or duplicated). **Cursor/keyset** encodes the last item's sort key (`WHERE (created, id) < (:c, :id) ORDER BY created DESC, id DESC LIMIT n`): O(1) regardless of depth (uses the index) and **stable** under concurrent writes. Cursors should be **opaque** (base64 the key state) so you can change internals later. Fetch `limit+1` rows to know if there's a next page.

## 6. Trade-offs

| Option | Pros | Cons |
|---|---|---|
| **Offset pagination** | Trivial, jump to any page, total count easy | O(n) deep scans, unstable under writes (skips/dupes) |
| **Cursor/keyset pagination** | O(1) deep, stable under concurrency, index-friendly | No random page jumps, no cheap total, needs a stable sort key |
| **URI versioning** | Explicit, easy routing/testing/caching | Version leaks into every path, encourages big-bang v2 |
| **Header/date versioning** | Clean URLs, granular evolution | Less discoverable, transform shims add server complexity |
| **Idempotency keys** | Safe retries, no double-charge | Storage + TTL, race handling, client must generate keys |

The recurring theme: **spend complexity where correctness lives.** Cursor pagination and idempotency add server work but prevent the two most common production disasters — timeouts on deep pages and double-charges on retries.

## 7. When to Use / When to Avoid

**Do this when:**
- Use **cursor pagination** for any large/growing or write-heavy collection, and for infinite-scroll feeds.
- Use **idempotency keys** on all money/side-effectful `POST`s and any write a client may retry.
- Use **URI versioning** for public APIs where explicitness and cacheability matter; **date versioning** when you ship frequent small changes to many integrators.
- Use **field-level error codes + envelope** whenever clients build UI or logic from failures.

**Avoid / reconsider when:**
- **Offset pagination** for deep or high-churn datasets (deep-page latency + skips) — fine for small, admin, "page 1–3" UIs.
- **Versioning bumps** for additive changes — evolve in place instead; reserve versions for breaking changes.
- **Idempotency keys** on naturally-idempotent `PUT`/`DELETE` (redundant) or pure reads.
- **Deeply nested resources** (`/a/{}/b/{}/c/{}/d`) — flatten; expose sub-resources by ID.

## 8. Scaling & Production Best Practices

- **Index the cursor sort key** — keyset pagination is only O(1) if `(sort_col, id)` is indexed; otherwise it degrades to a scan.
- **Cap `limit`** (e.g., max 100) and set a sane default (20–50) to bound payload and DB work.
- **Idempotency TTL** ~24h in Redis/Postgres; long enough to cover client retry windows, short enough to bound storage.
- **Rate-limit at the gateway** and always emit `RateLimit-*` + `Retry-After` so well-behaved clients back off (see **Rate Limiting**).
- **Compress + ETag** GET responses; support `If-None-Match` for `304` on unchanged reads.
- **Contract tests** in CI that fail on backward-incompatible schema changes (removed field, tightened validation).
- **Deprecation discipline** — `Deprecation` / `Sunset` headers, changelog, 6–12 month windows before removing a version.
- **Envelope consistency** — one error shape across every endpoint; document every `code`.

## 9. Failure Modes & Mitigations

| Failure | Impact | Mitigation |
|---|---|---|
| Deep offset pagination | Slow queries, DB CPU spikes, timeouts | Switch to cursor/keyset with indexed sort key |
| Retried POST after timeout | Double charge / duplicate resource | Idempotency keys with stored response + TTL |
| Breaking change shipped in place | Silent client breakage in the field | Additive-only changes; version bump; contract tests |
| Error returned as `200` | Clients miss failures; retries/caches misbehave | Correct 4xx/5xx codes + consistent envelope |
| Unbounded `limit` | Huge payloads, memory pressure, OOM | Enforce max page size server-side |
| Cursor tied to internal ids | Can't refactor storage without breaking clients | Opaque (base64/encrypted) cursors |
| No rate-limit headers | Clients retry blindly, amplify overload | `RateLimit-*` + `Retry-After`, exponential backoff docs |
| Concurrent same-key writes | Duplicate side effects despite idempotency | Lock/uniqueness on the key; second waits or 409 |

## 10. Monitoring & Metrics

- **Status-code distribution** per endpoint — a rising `4xx` often means a broken client contract; `5xx` is your bug.
- **Latency p50/p95/p99 per endpoint** — watch deep-pagination endpoints specifically.
- **Idempotency replay rate** — high replays signal client timeouts/retries upstream.
- **Pagination depth histogram** and rows-scanned-per-request (offset abuse detector).
- **Rate-limit `429` rate** per client/API key.
- **Per-error-`code` counts** — spot a spiking validation error after a client release.
- **Version adoption** — traffic share per API version, to time deprecations.
- **Payload size distribution** — catch missing `limit` caps.

## 11. Common Mistakes

1. ⚠️ Verbs in URLs (`/getOrders`, `/createUser`) instead of resources + HTTP methods.
2. ⚠️ Returning `200` with `{"success": false}` instead of a real `4xx`/`5xx`.
3. ⚠️ Offset pagination on huge/churning tables — deep pages time out and skip rows.
4. ⚠️ No idempotency on payment `POST`s → double charges on client retries.
5. ⚠️ Breaking changes without a version bump (removing a field, tightening validation).
6. ⚠️ Inconsistent error shapes across endpoints, forcing clients to special-case each.
7. ⚠️ Transparent cursors exposing internal row ids/offsets, blocking future refactors.
8. ⚠️ No `RateLimit-*`/`Retry-After` headers, so clients can't self-throttle.

## 12. Interview Questions

**Q: How do you model resources in a REST API?**
A: Nouns not verbs, plural collections (`/orders`), IDs for instances (`/orders/{id}`), sub-resources for containment (`/customers/{id}/orders`), shallow hierarchies, and HTTP methods for actions. Non-CRUD actions become sub-resources or a `POST /orders/{id}:cancel`-style custom method.

**Q: Offset vs cursor pagination — trade-offs?**
A: Offset is simple and allows page jumps but scans+discards rows (slow deep) and is unstable under concurrent writes. Cursor/keyset encodes the last sort key, is O(1) at any depth via the index, and is stable — the production default; cost is no random jumps and no cheap total count.

**Q: What is an idempotency key and when do you need one?**
A: A client-supplied unique key on unsafe writes; the server stores and replays the first response for duplicates, making `POST` safe to retry after a timeout. Needed on money/side-effectful `POST`/`PATCH`; `PUT`/`DELETE` are already idempotent.

**Q: URI vs header versioning?**
A: URI (`/v1`) is explicit, cacheable, easy to route/test, but leaks into paths. Header/content-negotiation keeps URLs clean and is more granular, but less discoverable and harder to test in a browser. Stripe's date-based header pins per-account and enables frequent small changes.

**Q: What makes a change backward compatible?**
A: Additive, optional changes — new endpoints, new optional fields, new enum values clients ignore. Breaking: removing/renaming fields, changing types, tightening validation, changing defaults or error codes clients depend on.

**Q: Design a good error response.**
A: Correct HTTP status + a JSON envelope with a stable machine `code`, human `message`, a category `type`, and field-level `param`/`details`. Clients switch on `code`; never on `message`.

**Q (Senior): A client's payment request times out and they retry — how do you prevent a double charge end to end?**
A: Require an `Idempotency-Key`; on first request store `key → (status, body)` transactionally with the charge; replay the stored response for the same key within a TTL. Guard concurrency with a lock/unique constraint on the key so a simultaneous retry waits or gets `409`. The charge and the key record must commit atomically.

**Q (Senior): Cursor pagination — how do you keep results stable and how is the cursor built?**
A: Sort by a monotonic, unique tuple like `(created_at, id)`; the cursor encodes the last row's tuple; query `WHERE (created_at, id) < (:c, :id) ORDER BY ... LIMIT n+1`. It's stable because new inserts don't shift already-seen keys. Make the cursor opaque (base64/encrypted) so storage internals can change without breaking clients.

**Q (Senior): You must remove a field 40% of clients still use. Process?**
A: Don't remove in place. Introduce a new version or additive replacement, mark the old field deprecated with `Deprecation`/`Sunset` headers and changelog, monitor per-field usage, notify integrators, keep it for a 6–12 month window, then remove only after usage drops. Contract tests prevent accidental early removal.

**Q (Senior): How do you evolve an API without a version explosion?**
A: Prefer additive changes so most evolution needs no version. Use tolerant readers (ignore unknown fields), feature flags/date-pinned versions (Stripe model) with server-side transform shims translating old shapes to new, and reserve full version bumps for genuinely breaking changes.

**Q (Senior): What rate-limit information should an API expose and why?**
A: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, and `Retry-After` on `429`. They let well-behaved clients self-throttle and back off precisely instead of blind retrying, which otherwise amplifies overload into a cascading failure.

## 13. Alternatives & Related

- **API Styles (REST/GraphQL/gRPC)** — GraphQL/gRPC handle versioning and fetching differently (schema evolution, Protobuf tags).
- **Rate Limiting** — the algorithms and headers behind `429` responses.
- **Caching** — `ETag`/`Cache-Control`/`304` for read APIs.
- **Idempotency & Message Queues** — exactly-once semantics and dedup in async systems.
- **Microservices** — where consistent contracts and versioning across teams matter most.

## 14. Cheat Sheet

> [!TIP]
> **Model nouns**, use HTTP methods + honest status codes (4xx caller, 5xx server), and one **error envelope** with a stable machine `code`. **Idempotency keys** on side-effectful POSTs → safe retries, no double-charge. **Version only on breaking changes** (URI = explicit, header/date = granular); evolve additively for everything else. **Cursor/keyset pagination** (indexed sort key, opaque cursor, `limit+1`) beats offset for deep/churning data. Emit **`RateLimit-*` + `Retry-After`**. Support **filter/sort/sparse fields** to avoid endpoint sprawl. Never return errors as `200`.

**References:** Google API Design Guide (AIP), Stripe API docs, Microsoft REST API Guidelines, JSON:API specification

---
*System Design Handbook — topic 30.*
