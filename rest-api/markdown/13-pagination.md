# 13 · Pagination: Offset, Cursor & Keyset

> **In one line:** Offset pagination is easy to write and quietly falls apart at scale; cursor/keyset pagination trades random page access for correctness and constant-time reads.

---

## 1. Overview

Every collection endpoint you ship is a promise about **bounded work**. `GET /orders` looks innocent on day one when the table has 400 rows; on day 900 it has 400 million rows, and the same handler will happily try to serialize all of them into a single response. Pagination is the mechanism that turns an unbounded collection into a stream of bounded, cacheable, resumable pages. It is not a nicety — an unpaginated list endpoint is a latent outage.

The problem pagination solves is threefold. First, **response size**: clients, proxies, and JSON parsers all degrade badly past a few megabytes. Second, **database work**: a query that scans an entire table holds locks, blows out the buffer pool, and starves other queries. Third, **client experience**: users want the first 20 results in 80 ms, not all 4 million in 40 seconds. A good pagination contract answers all three while remaining stable when the underlying data changes mid-traversal — which it always does.

Early web APIs copied the SQL they were built on: `LIMIT 20 OFFSET 40`, exposed as `?page=3&per_page=20`. This mirrors how humans think about paginated documents, and for small datasets it is fine. As APIs grew, two failures became undeniable: `OFFSET N` forces the database to *generate and discard* N rows on every request, so page 10,000 costs 10,000× page 1; and because offsets index into a **snapshot that no longer exists**, inserts and deletes between requests cause items to be skipped or duplicated. The industry answer, popularized by Facebook's Graph API, Twitter, Stripe, and Slack, is **cursor pagination**: the server hands the client an opaque token that encodes "where I stopped," and the next request resumes from that exact position using an indexed range scan.

The durable mental model: *offset pagination asks "skip N rows then give me 20"; keyset pagination asks "give me the 20 rows immediately after this known point."* The second question is answerable by an index seek in constant time; the first is not.

**Concrete example.** Stripe's API returns `{"object": "list", "data": [...], "has_more": true}` and you paginate with `starting_after=<last_object_id>` — a cursor, not a page number. GitHub's REST API returns an [RFC 8288](https://www.rfc-editor.org/rfc/rfc8288) `Link` header with `rel="next"` / `rel="prev"` URLs so clients follow links instead of constructing offsets, and its GraphQL and newer REST endpoints use opaque `after` cursors. The Google Cloud APIs standardize on `page_size` + `page_token` / `next_page_token`. Notice the convergence: **no large-scale public API asks you to compute an offset.**

## 2. Core Concepts

- **Page size (`limit` / `per_page` / `page_size`)** — the maximum number of items the server will return. Always server-clamped; a client asking for 10,000 gets your maximum, not an outage.
- **Offset pagination** — skip a fixed number of rows, then take `limit`. Expressed as `?offset=100&limit=20` or `?page=6&per_page=20`. Supports random page access; cost grows linearly with offset.
- **Keyset pagination (seek method)** — filter on the last row's sort key: `WHERE (created_at, id) < (:ts, :id) ORDER BY created_at DESC, id DESC LIMIT 20`. Constant cost regardless of depth.
- **Cursor** — an **opaque** token the server issues that encodes the keyset position (and often the sort/filter parameters). Clients must treat it as a black box; that opacity is what lets you change the encoding later.
- **Tie-breaker** — a unique column (usually the primary key) appended to the sort key so ordering is *total*. Without it, rows sharing a `created_at` value can be skipped or repeated at a page boundary.
- **Stable sort / total order** — the guarantee that any two distinct rows have a deterministic relative position. Keyset pagination is only correct on a total order.
- **`has_more` vs `total_count`** — a boolean "is there another page" is cheap (fetch `limit + 1` rows); an exact total requires a `COUNT(*)` that may scan the whole filtered set. Prefer `has_more`.
- **Link header (RFC 8288)** — `Link: <url>; rel="next"` — server-generated navigation URLs, so clients never build pagination URLs themselves. The HATEOAS idea that actually got adopted.
- **Page drift** — items skipped or duplicated during traversal because rows were inserted/deleted between page requests. The core correctness failure of offset pagination.
- **Deep pagination** — requesting a very high offset (e.g. `offset=1000000`). Cheap for clients to ask, catastrophically expensive for the server. Also a favourite DoS vector.

## 3. Theory & Principles

### 3.1 Why `OFFSET` is O(offset)

SQL's `OFFSET N` is defined as *discard the first N rows of the result set*. There is no index structure that lets a B-tree jump to "the 500,000th matching row" — the engine must walk the index (or heap), materialize rows, count them, and throw them away. So the cost of page *k* is:

`cost(page k) ≈ (k × page_size + page_size) row-visits`. Fetching the whole collection page by page is therefore **O(n²/page_size)** total work, versus O(n) for a single scan. That is why "just paginate the export job" quietly becomes a 6-hour job that pins a replica.

Keyset pagination replaces the skip with a **range predicate on an indexed prefix**:

```sql
SELECT id, created_at, ... FROM orders
WHERE customer_id = :cid AND (created_at, id) < (:last_created_at, :last_id)
ORDER BY created_at DESC, id DESC LIMIT 21;
```

With an index on `(customer_id, created_at DESC, id DESC)`, the engine performs one **index seek** to the boundary and then reads 21 consecutive entries. Cost is O(page_size), independent of depth. The `21` (i.e. `limit + 1`) is the standard trick for computing `has_more` without a second query: if you get 21 rows back, there is another page — return 20 and set `has_more: true`.

> **Note:** The row-value comparison `(a, b) < (x, y)` is standard SQL and is supported natively by PostgreSQL and MySQL 8. It is *not* the same as `a < x AND b < y` — the correct manual expansion is `a < x OR (a = x AND b < y)`. Getting this wrong is the single most common keyset bug.

### 3.2 The correctness argument: drift

Consider a feed sorted newest-first, page size 20. The client fetches `offset=0` and gets items 1–20. Before the second request, three new items are inserted at the head. Now `offset=20` returns what *was* items 18–37 — the client sees items 18, 19, 20 **again**. Conversely, if five items are deleted from the head, `offset=20` skips five items the client never saw. Neither is a bug in your code; it is the definition of offset semantics applied to a moving dataset.

Keyset pagination has no such failure for the *forward* direction: "everything strictly older than (ts, id)" is a well-defined predicate against the data as it exists *now*. New items inserted at the head are simply not seen (correct — the client already passed that point); deletions below the cursor shrink later pages but never duplicate or skip surviving rows. This is the *snapshot-free* correctness property, and it is the real reason to adopt cursors — the speed is a bonus.

### 3.3 What you give up

Cursors are not free:

- **Random access.** There is no "jump to page 500" — only next/prev from a token you hold. Related: no cheap "page 3 of 4,182."
- **Arbitrary re-sorting mid-traversal.** The cursor encodes the sort; changing `sort=` invalidates it (you must `400` on a mismatch, not silently misbehave).
- **Bookmarkable page URLs**, unless you accept that a stored cursor may point at a deleted row (handle it by seeking to the next surviving row, not by erroring).

```svg
<svg viewBox="0 0 760 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="10" y="10" width="740" height="320" rx="14" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="380" y="38" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Offset drift vs keyset stability</text>
  <text x="40" y="70" fill="#1e293b" font-size="13" font-weight="700">OFFSET 20 (3 rows inserted between requests)</text>
  <rect x="40" y="82" width="46" height="34" fill="#fef3c7" stroke="#d97706"/>
  <rect x="88" y="82" width="46" height="34" fill="#fef3c7" stroke="#d97706"/>
  <rect x="136" y="82" width="46" height="34" fill="#fef3c7" stroke="#d97706"/>
  <text x="111" y="104" text-anchor="middle" fill="#1e293b" font-size="11">new 3 rows</text>
  <rect x="184" y="82" width="240" height="34" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="304" y="104" text-anchor="middle" fill="#1e293b" font-size="11">page 1 already seen (items 1-20)</text>
  <rect x="424" y="82" width="140" height="34" fill="#fee2e2" stroke="#dc2626"/>
  <text x="494" y="104" text-anchor="middle" fill="#1e293b" font-size="11">re-served 18,19,20</text>
  <rect x="564" y="82" width="150" height="34" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="639" y="104" text-anchor="middle" fill="#1e293b" font-size="11">new items 21+</text>
  <text x="40" y="140" fill="#1e293b" font-size="12">Client asks offset=20 and receives 3 duplicates it has already rendered.</text>
  <line x1="40" y1="160" x2="720" y2="160" stroke="#94a3b8"/>
  <text x="40" y="192" fill="#1e293b" font-size="13" font-weight="700">KEYSET: WHERE (created_at, id) &lt; (2026-07-02T10:00Z, 8841)</text>
  <rect x="40" y="204" width="46" height="34" fill="#fef3c7" stroke="#d97706"/>
  <rect x="88" y="204" width="46" height="34" fill="#fef3c7" stroke="#d97706"/>
  <rect x="136" y="204" width="46" height="34" fill="#fef3c7" stroke="#d97706"/>
  <text x="111" y="226" text-anchor="middle" fill="#1e293b" font-size="11">new 3 rows</text>
  <rect x="184" y="204" width="240" height="34" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="304" y="226" text-anchor="middle" fill="#1e293b" font-size="11">page 1 already seen</text>
  <line x1="424" y1="196" x2="424" y2="252" stroke="#4f46e5" stroke-width="3"/>
  <text x="424" y="268" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">cursor boundary</text>
  <rect x="424" y="204" width="290" height="34" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="569" y="226" text-anchor="middle" fill="#1e293b" font-size="11">page 2: exactly the next 20 unseen rows</text>
  <text x="40" y="300" fill="#1e293b" font-size="12">Index seek to the boundary, then a sequential read. Cost is independent of depth.</text>
</svg>
```

## 4. Architecture & Workflow

End-to-end life of a paginated request in a typical service:

1. **Client sends the first request** with no cursor: `GET /v1/orders?limit=20&status=paid`. It does *not* construct offsets.
2. **Gateway/edge** enforces a hard ceiling on `limit` (e.g. 100) and applies a rate limit keyed on the caller. Deep-pagination abuse is largely a rate-limiting problem.
3. **Handler validates and normalizes** the query: parse `limit`, clamp it, parse `status`, and — if a cursor is present — decode it.
4. **Cursor decoding** — base64url-decode, verify the HMAC signature (or at minimum a version byte), and check that the embedded filter/sort fingerprint matches the current request. Mismatch → `400 Bad Request` with a problem detail, never a silently wrong page.
5. **Query build** — turn the cursor into a keyset predicate and append the tie-breaker to `ORDER BY`. Request `limit + 1` rows.
6. **Database executes an index seek** using the composite index that matches the sort order exactly. Verify with `EXPLAIN` that you see an index range scan, not a sort or a filter.
7. **Trim and encode** — if `limit + 1` rows came back, drop the extra, set `has_more = true`, and build `next_cursor` from the *last returned* row's sort key + id.
8. **Serialize the envelope** — items plus pagination metadata, and set a `Link` header with `rel="next"` (and `rel="prev"` if you support backward traversal).
9. **Cache headers** — first page of a public, slow-moving collection can be `Cache-Control: public, max-age=30`; user-scoped pages must be `private` (or `no-store` for sensitive data). Cursor pages are highly cacheable because the URL fully determines the content.
10. **Client follows `next`** verbatim until `has_more` is false or the `next` link is absent.

```svg
<svg viewBox="0 0 780 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="10" y="10" width="760" height="360" rx="14" fill="#f8fafc" stroke="#4f46e5"/>
  <text x="390" y="36" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Cursor pagination request flow</text>
  <rect x="30" y="60" width="120" height="58" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="90" y="84" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Client</text>
  <text x="90" y="102" text-anchor="middle" fill="#1e293b" font-size="10">holds next_cursor</text>
  <rect x="200" y="60" width="130" height="58" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="265" y="84" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Gateway</text>
  <text x="265" y="102" text-anchor="middle" fill="#1e293b" font-size="10">clamp limit, rate limit</text>
  <rect x="380" y="60" width="150" height="58" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="455" y="80" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">API handler</text>
  <text x="455" y="96" text-anchor="middle" fill="#1e293b" font-size="10">decode + verify cursor</text>
  <text x="455" y="110" text-anchor="middle" fill="#1e293b" font-size="10">build keyset predicate</text>
  <rect x="590" y="60" width="150" height="58" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="665" y="80" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Database</text>
  <text x="665" y="96" text-anchor="middle" fill="#1e293b" font-size="10">index seek on</text>
  <text x="665" y="110" text-anchor="middle" fill="#1e293b" font-size="10">(status, created_at, id)</text>
  <line x1="150" y1="89" x2="196" y2="89" stroke="#4f46e5" stroke-width="2"/>
  <polygon points="196,89 188,85 188,93" fill="#4f46e5"/>
  <line x1="330" y1="89" x2="376" y2="89" stroke="#4f46e5" stroke-width="2"/>
  <polygon points="376,89 368,85 368,93" fill="#4f46e5"/>
  <line x1="530" y1="89" x2="586" y2="89" stroke="#4f46e5" stroke-width="2"/>
  <polygon points="586,89 578,85 578,93" fill="#4f46e5"/>
  <rect x="30" y="150" width="710" height="76" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="46" y="172" fill="#1e293b" font-size="12" font-weight="700">1. GET /v1/orders?limit=20&amp;status=paid&amp;cursor=eyJ0IjoiMjAyNi0wNy0wMlQxMDowMFoiLCJpIjo4ODQxfQ</text>
  <text x="46" y="192" fill="#1e293b" font-size="12">2. SELECT ... WHERE status='paid' AND (created_at,id) &lt; ('2026-07-02T10:00Z',8841) LIMIT 21</text>
  <text x="46" y="212" fill="#1e293b" font-size="12">3. 21 rows returned &#8594; trim to 20, has_more=true, next_cursor from row 20</text>
  <rect x="30" y="248" width="710" height="106" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="46" y="270" fill="#1e293b" font-size="12" font-weight="700">200 OK</text>
  <text x="46" y="290" fill="#1e293b" font-size="12">Link: &lt;https://api.example.com/v1/orders?limit=20&amp;status=paid&amp;cursor=...&gt;; rel="next"</text>
  <text x="46" y="310" fill="#1e293b" font-size="12">Cache-Control: private, max-age=30</text>
  <text x="46" y="332" fill="#1e293b" font-size="12">{ "data": [ ... 20 orders ... ], "has_more": true, "next_cursor": "..." }</text>
</svg>
```

## 5. Implementation

### 5.1 The wire contract

```http
GET /v1/orders?limit=20&status=paid HTTP/1.1
Host: api.example.com
Authorization: Bearer sk_live_...
Accept: application/json
```

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: private, max-age=30
Link: <https://api.example.com/v1/orders?limit=20&status=paid&cursor=eyJ2IjoxLCJ0IjoiMjAyNi0wNy0wMlQxMDowMDowMFoiLCJpIjo4ODQxfQ>; rel="next"
X-Request-Id: req_01J9K2M3

{
  "data": [
    { "id": "ord_8860", "status": "paid", "amount": 4200, "created_at": "2026-07-02T11:40:00Z" },
    { "id": "ord_8841", "status": "paid", "amount": 1990, "created_at": "2026-07-02T10:00:00Z" }
  ],
  "has_more": true,
  "next_cursor": "eyJ2IjoxLCJ0IjoiMjAyNi0wNy0wMlQxMDowMDowMFoiLCJpIjo4ODQxfQ"
}
```

The final page returns `"has_more": false`, `"next_cursor": null`, and **no** `Link: rel="next"`. An empty collection is still `200 OK` with `"data": []` — never `404`.

An invalid or mismatched cursor is a client error, reported with [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem details:

```http
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json

{
  "type": "https://api.example.com/problems/invalid-cursor",
  "title": "Invalid pagination cursor",
  "status": 400,
  "detail": "The cursor was issued for sort=created_at:desc but this request used sort=amount:desc.",
  "instance": "/v1/orders"
}
```

### 5.2 curl

```bash
# First page
curl -sS "https://api.example.com/v1/orders?limit=20&status=paid" \
  -H "Authorization: Bearer $TOKEN" -D headers.txt

# Follow the Link header instead of hand-building URLs
NEXT=$(grep -i '^link:' headers.txt | sed -n 's/.*<\([^>]*\)>; rel="next".*/\1/p')
curl -sS "$NEXT" -H "Authorization: Bearer $TOKEN"
```

### 5.3 FastAPI: signed cursor + keyset query

```python
import base64, hmac, hashlib, json
from datetime import datetime
from typing import Optional
from fastapi import FastAPI, Query, HTTPException, Response
from sqlalchemy import text

app = FastAPI()
SECRET = b"rotate-me-from-kms"
MAX_LIMIT = 100
CURSOR_VERSION = 1


def encode_cursor(created_at: datetime, row_id: int, sort: str) -> str:
    payload = {"v": CURSOR_VERSION, "t": created_at.isoformat(), "i": row_id, "s": sort}
    raw = json.dumps(payload, separators=(",", ":")).encode()
    sig = hmac.new(SECRET, raw, hashlib.sha256).digest()[:12]
    return base64.urlsafe_b64encode(raw + sig).decode().rstrip("=")


def decode_cursor(cursor: str, sort: str) -> tuple[datetime, int]:
    try:
        blob = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
        raw, sig = blob[:-12], blob[-12:]
        expected = hmac.new(SECRET, raw, hashlib.sha256).digest()[:12]
        assert hmac.compare_digest(sig, expected), "bad signature"
        payload = json.loads(raw)
        assert payload["v"] == CURSOR_VERSION and payload["s"] == sort, "mismatch"
        return datetime.fromisoformat(payload["t"]), int(payload["i"])
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid pagination cursor")


@app.get("/v1/orders")
async def list_orders(
    response: Response,
    db=Depends(get_db),
    limit: int = Query(20, ge=1, le=MAX_LIMIT),
    status: Optional[str] = None,
    cursor: Optional[str] = None,
    sort: str = "created_at:desc",
):
    params = {"limit": limit + 1, "status": status}
    where = ["(:status IS NULL OR status = :status)"]

    if cursor:
        ts, last_id = decode_cursor(cursor, sort)
        where.append("(created_at, id) < (:ts, :last_id)")
        params |= {"ts": ts, "last_id": last_id}

    sql = text(f"""SELECT id, status, amount, created_at FROM orders
                   WHERE {' AND '.join(where)}
                   ORDER BY created_at DESC, id DESC LIMIT :limit""")
    rows = (await db.execute(sql, params)).mappings().all()

    has_more = len(rows) > limit
    rows = rows[:limit]
    next_cursor = (encode_cursor(rows[-1]["created_at"], rows[-1]["id"], sort)
                   if has_more and rows else None)
    if next_cursor:
        url = f"/v1/orders?limit={limit}&cursor={next_cursor}"
        response.headers["Link"] = f'<{url}>; rel="next"'
    response.headers["Cache-Control"] = "private, max-age=30"
    return {"data": [dict(r) for r in rows], "has_more": has_more,
            "next_cursor": next_cursor}
```

### 5.4 Node client that drains all pages safely

```javascript
async function* paginate(url, token) {
  let next = url;
  while (next) {
    const res = await fetch(next, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 429) {                       // retry the SAME page
      await new Promise(r => setTimeout(r, Number(res.headers.get("Retry-After") ?? 1) * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`pagination failed: ${res.status}`);
    const body = await res.json();
    yield* body.data;
    const m = (res.headers.get("Link") ?? "").match(/<([^>]+)>;\s*rel="next"/);
    next = m ? m[1] : null;           // trust the server's link, never build one
  }
}

for await (const o of paginate("https://api.example.com/v1/orders?limit=100", TOKEN)) process(o);
```

### 5.5 OpenAPI 3.1 fragment

```yaml
parameters:
  - name: limit
    in: query
    schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
  - name: cursor
    in: query
    description: Opaque token from a previous response. Do not construct or parse.
    schema: { type: string }
responses:
  "200":
    headers:
      Link:
        schema: { type: string }
        description: RFC 8288 header carrying rel="next" when more pages exist.
    content:
      application/json:
        schema:
          type: object
          required: [data, has_more]
          properties:
            data: { type: array, items: { $ref: "#/components/schemas/Order" } }
            has_more: { type: boolean }
            next_cursor: { type: [string, "null"] }
```

### 5.6 Optimization notes

- **Index must match the sort exactly**, including direction and the tie-breaker: `CREATE INDEX ON orders (status, created_at DESC, id DESC);`. If `EXPLAIN` shows a `Sort` node, the index is wrong and your "keyset" pagination is still O(n).
- **Never `COUNT(*)` on every page.** If the UI truly needs a total, approximate it (`reltuples` in Postgres, a cached counter, or a capped `COUNT` reported as "10,000+"). `limit + 1` beats a second query for `has_more` — one round trip, one index scan.
- **Cap the page size server-side and document it.** Returning fewer items than requested is legal and must be expected by clients.
- **Backward pages**: encode a direction flag in the cursor, flip the comparison + `ORDER BY`, then reverse the array before serializing.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Offset pagination | Trivial to implement; supports jump-to-page and "page 7 of 92" UIs | O(offset) database work; duplicates/skips under concurrent writes; a deep-pagination DoS vector |
| Keyset pagination | Constant-time reads at any depth; no drift for forward traversal | No random access; requires an index matching the sort; backward paging needs extra work |
| Opaque cursor token | Lets you change encoding, add sharding info, or sign for tamper-resistance without breaking clients | Undebuggable by hand; you must version it and reject stale versions cleanly |
| `Link` header navigation | Clients never build URLs; server can change parameterization freely | Some HTTP clients discard headers; needs documentation and a header-parsing helper |
| `has_more` boolean | One extra row instead of a `COUNT(*)` scan | No total count, so no progress bars or "N results found" |
| Exact `total_count` | Great UX, enables page-number UIs | Full filtered scan per request; often the slowest part of a list endpoint |
| Server-clamped `limit` | Bounded memory, bounded latency, predictable capacity planning | Clients must handle short pages; naive clients that assume `len(data) == limit` break |
| Snapshot/consistent pagination | Perfectly stable traversal even with heavy writes | Requires holding a MVCC snapshot or materializing a result set — expensive and stateful |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Unbounded list endpoint** — `GET /orders` returns everything because nobody added a limit. → ✅ Make `limit` default to 20 and hard-cap at 100 *in the framework layer*, so a new endpoint cannot ship unbounded.
2. ⚠️ **Offset pagination on a write-heavy feed**, causing users to see duplicate items. → ✅ Use keyset/cursor pagination for anything ordered by a mutable or insert-heavy column.
3. ⚠️ **No tie-breaker in `ORDER BY`** — `ORDER BY created_at DESC` alone, where thousands of rows share a timestamp. → ✅ Always append the primary key: `ORDER BY created_at DESC, id DESC`.
4. ⚠️ **Wrong keyset predicate** — writing `created_at < :ts AND id < :id` instead of the row-value comparison. → ✅ Use `(created_at, id) < (:ts, :id)` or its correct expansion `created_at < :ts OR (created_at = :ts AND id < :id)`.
5. ⚠️ **Transparent cursors** clients start parsing — you encoded `{"offset": 40}` in base64 and now can't change it. → ✅ Sign the cursor with an HMAC and version it; document loudly that it is opaque.
6. ⚠️ **`COUNT(*)` on every page request**, making page loads slower than the data fetch. → ✅ Return `has_more`; offer `total_count` only behind an explicit opt-in query parameter, and cap or approximate it.
7. ⚠️ **404 on an empty page.** → ✅ An empty collection is `200 OK` with `"data": []`; `404` means the *collection resource* itself does not exist (e.g. a bad customer id).
8. ⚠️ **Cursor reused after the sort or filter changed**, silently returning a nonsensical page. → ✅ Fingerprint sort+filters in the cursor and return `400` with an `invalid-cursor` problem type on mismatch.
9. ⚠️ **Client assumes a short page means the end.** → ✅ Document that servers may return fewer items than `limit`; termination is signalled by `has_more: false` or a missing `next` link only.
10. ⚠️ **Deep pagination left unthrottled**, so a scraper hits `offset=5000000` in a loop. → ✅ Reject offsets past a documented ceiling with `400`, rate-limit list endpoints, and steer bulk consumers to an export/streaming API.
11. ⚠️ **Pagination state stored server-side per session** (a scroll cursor in memory), which breaks on deploy and doesn't scale horizontally, or **mixing `offset` and `cursor`** on one endpoint with undefined precedence. → ✅ Keep cursors stateless and self-describing; accept exactly one style and `400` if both appear.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** When a customer reports "missing records," reproduce with the *exact* cursor chain: log a hash of the issued cursor with each response and the `X-Request-Id`. Ninety percent of pagination bugs are (a) a missing tie-breaker, (b) an incorrect row-value comparison, or (c) a client rebuilding URLs from a `next_cursor` while dropping the filter parameters. Run `EXPLAIN (ANALYZE, BUFFERS)` on the generated SQL for a deep page — a `Sort` node or high `Rows Removed by Filter` proves the index does not match the query.

**Monitoring.** Track, per endpoint: `p50/p95/p99` latency **bucketed by page depth** (offset value or cursor generation), rows examined per row returned (`examined/returned` ratio — should be ~1.05 for keyset), page size distribution, `has_more=true` rate, and the count of `400 invalid-cursor` responses (a spike means a client broke or a cursor version rolled without a grace period). Emit `X-Request-Id` on every response and log the decoded cursor fields at DEBUG. Alert when p99 list latency rises while row counts stay flat — that is index drift.

**Security.** Cursors can leak data: an unsigned cursor containing `{"customer_id": 42}` invites a client to edit it and page through another tenant's data. Always (1) sign cursors, and (2) re-apply the authorization predicate server-side on every page — never trust the cursor to carry the tenant scope. Deep pagination is a denial-of-service amplifier: one cheap request causing a million row-visits is the definition of asymmetric cost, so rate-limit list endpoints by *work done*, not just request count. Avoid exposing monotonically increasing integer ids in cursors if they let a caller infer your volume; use ULIDs or opaque public ids.

**Performance & scaling.** Push list queries to a read replica and accept the replication lag (document it — a just-created object may not appear on page 1). For sharded stores, a cursor must encode per-shard positions: fan out to each shard with the same keyset predicate, merge with a heap, and store all shard cursors in one token. For search-backed lists (Elasticsearch/OpenSearch), use `search_after` — the same keyset idea — never `from`/`size` past a few thousand. For full-collection consumers (data warehouse syncs), do not make them paginate at all: offer a change-feed endpoint (`GET /orders?updated_since=`) or a bulk export job that returns `202 Accepted` and a download URL.

## 9. Interview Questions

**Q: Why is offset pagination slow at high offsets?**
A: `OFFSET N` is defined as producing and discarding the first N rows, and no index can jump directly to the Nth matching row. So page *k* costs roughly `k × page_size` row visits, and draining the collection is quadratic. Keyset pagination replaces the skip with an indexed range predicate, making each page O(page_size).

**Q: What exactly goes wrong with offset pagination on a live dataset?**
A: The offset indexes into a result set that changes between requests. Inserts before your position shift everything down, so the next page repeats items; deletions shift up, so items are skipped entirely. The client sees duplicates or gaps even though every individual query was correct.

**Q: What is a cursor and why must it be opaque?**
A: A cursor is a server-issued token encoding the position of the last returned row in the sort order, plus the sort/filter fingerprint. Making it opaque (base64 + signature) means clients cannot depend on its structure, which lets you change the encoding, add shard positions, or migrate from offsets to keysets without a breaking change.

**Q: Why do you need a tie-breaker column?**
A: Keyset pagination requires a *total* order. If two rows share the same `created_at`, their relative position is undefined and can differ between queries, so a row at the page boundary can be returned twice or never. Appending a unique column (the primary key) makes the ordering deterministic.

**Q: How do you tell the client there are more pages without a `COUNT(*)`?**
A: Request `limit + 1` rows. If you get `limit + 1` back, trim the extra and set `has_more: true`; otherwise it is the last page. This costs one extra row read instead of a full filtered scan.

**Q: When is offset pagination still the right choice?**
A: When the dataset is small and bounded (admin tables, config lists, a few thousand rows), when the data is effectively immutable during traversal, or when the product genuinely requires jump-to-page-N navigation. Even then, cap the maximum offset.

**Q: What status code do you return for an empty page?**
A: `200 OK` with `"data": []`. `404` is reserved for a non-existent collection resource — for example `/customers/cus_999/orders` where the customer does not exist. Emptiness is a valid state of an existing collection.

**Q: How does the `Link` header fit in?**
A: RFC 8288 lets the server return `Link: <url>; rel="next"` (plus `prev`, `first`, `last`), so clients follow server-generated URLs rather than assembling their own. It survives parameterization changes and is the pragmatic slice of HATEOAS that the industry actually adopted — GitHub is the reference implementation.

**Q: (Senior) How do you paginate across a sharded database or a federated set of services?**
A: Issue the same keyset predicate to every shard, merge results with a k-way merge on the sort key, and encode a per-shard position map inside a single opaque cursor. You over-fetch (`limit` per shard) and discard, so cost scales with shard count; cap fan-out and consider a materialized global index for very wide fan-outs. Exact totals become effectively impossible — design the UX around `has_more`.

**Q: (Senior) A customer says a nightly export is missing records. How do you diagnose it?**
A: First check whether they are using offset pagination against a table receiving concurrent writes — that alone explains skips. Then verify the `ORDER BY` includes a unique tie-breaker and that the keyset predicate is a true row-value comparison rather than `a < x AND b < y`. Finally, check for read-replica lag and whether the export re-issues the *first* page after a retry instead of resuming from the stored cursor. Reproduce by logging cursor hashes per page and replaying the chain.

**Q: (Senior) How would you offer a stable snapshot for a long traversal without pinning a database transaction?**
A: Pin the traversal to a logical snapshot rather than a physical one: add an upper bound to the query — `WHERE created_at <= :snapshot_ts` — and embed `snapshot_ts` in the cursor issued on page 1. Every subsequent page filters against the same ceiling, so inserts after the traversal started are invisible and the sequence is stable. Deletes and updates still leak through, so for true point-in-time semantics use an append-only event log or a versioned/soft-delete table and paginate over the version column.

**Q: (Senior) Deep pagination is being abused as a DoS vector. What is your mitigation strategy, in order?**
A: Reject offsets beyond a documented ceiling with `400` and a problem detail pointing at the cursor API; migrate the endpoint to cursors so cost stops scaling with depth. Add cost-based rate limiting — charge tokens proportional to rows examined, not requests — and return `429` with `Retry-After`. Provide a legitimate high-volume path (change feed via `updated_since`, or an async bulk export returning `202` plus a signed download URL) so well-behaved bulk consumers stop hammering the list endpoint. Finally, monitor the `examined/returned` ratio per client to spot abuse before it becomes an incident.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Every collection endpoint must be bounded. Offset pagination (`?page=&per_page=`) is easy and supports jump-to-page, but `OFFSET N` costs O(N) and drifts — duplicating or skipping rows when the data changes mid-traversal. Keyset pagination filters on the last row's sort key `(created_at, id) < (:ts, :id)` with an index matching the `ORDER BY` exactly, giving O(page_size) reads at any depth and no forward drift. Wrap the keyset position in an opaque, HMAC-signed, versioned **cursor** so you can change the encoding later, and always re-apply authorization server-side — never trust the cursor for tenancy. Signal more pages with `has_more` (fetch `limit + 1`) rather than `COUNT(*)`, and hand clients a `Link: <...>; rel="next"` header so they never build URLs. Clamp `limit` server-side, return `200` + `[]` for empty pages, `400` for a bad or mismatched cursor, and give bulk consumers a change feed or export instead of deep pages.

| Item | Value / Rule |
|---|---|
| Default page size | 20 (documented) |
| Max page size | 100, clamped server-side |
| Empty result | `200 OK` with `"data": []` |
| Bad/stale cursor, offset over ceiling | `400` + `application/problem+json` |
| Rate-limited list | `429` + `Retry-After` |
| More pages header | `Link: <url>; rel="next"` (RFC 8288) |
| Keyset predicate | `(sort_col, id) < (:val, :id)` |
| Required index | `(filter_cols…, sort_col DESC, id DESC)` |
| has_more trick | fetch `limit + 1`, trim to `limit` |

- **Why offset breaks** → cost is O(offset) and the offset indexes a snapshot that no longer exists.
- **Keyset predicate** → `WHERE (created_at, id) < (:ts, :id) ORDER BY created_at DESC, id DESC LIMIT n+1`.
- **Cursor rule** → opaque, signed, versioned, encodes sort+filter fingerprint; authorization re-checked server-side.
- **has_more vs total_count** → one extra row vs a full filtered scan; prefer `has_more`.
- **Client rule** → follow `Link: rel="next"`; never assume a full page means more data.

## 11. Hands-On Exercises & Mini Project

- [ ] Seed a table with 2,000,000 rows and time `LIMIT 20 OFFSET 0` vs `OFFSET 1000000`; then time the equivalent keyset query and compare `EXPLAIN (ANALYZE, BUFFERS)` output.
- [ ] Write a failing test that proves offset drift: fetch page 1, insert 3 rows at the head, fetch page 2, and assert on the duplicate ids.
- [ ] Implement `encode_cursor`/`decode_cursor` with an HMAC signature and a version byte; add a test that a tampered cursor yields `400`, not a wrong page.
- [ ] Add backward pagination (`rel="prev"`): flip the comparison operator and `ORDER BY`, then reverse the array before serializing. Verify prev(next(page1)) == page1.

**Mini Project — a drift-proof `/v1/events` feed.**
*Goal:* Build a FastAPI (or Express) service exposing `GET /v1/events` over a table of ≥1M rows with correct cursor pagination and a hostile test suite.
*Requirements:* `limit` (default 20, max 100), `type` and `since` filters, composite index matching the sort, signed versioned cursors carrying a sort/filter fingerprint, `has_more` via `limit + 1`, `Link: rel="next"`, `400` problem-details for bad cursors, and a `Cache-Control` header appropriate to the data's scope. Include a writer process inserting 100 rows/second while an integration test drains all pages and asserts zero duplicates and zero gaps.
*Extensions:* Add backward pagination; add a `snapshot_ts` ceiling encoded on page 1 for stable long traversals; shard the table into 4 partitions and merge with a per-shard cursor map; expose an approximate `total_count` behind `?include_total=true` with a documented cap; add a Prometheus histogram of rows-examined-per-row-returned and alert when it exceeds 2.

## 12. Related Topics & Free Learning Resources

**Related chapters:** *Resource Modeling & URI Design* for how collection URLs are shaped; *Filtering, Sorting & Search* for the query parameters cursors must fingerprint; *Caching, ETags & Conditional Requests* for making page responses cacheable; *Rate Limiting & Throttling* for defending list endpoints; *Error Handling & Problem Details* (chapter 16) for the `invalid-cursor` response body; *Bulk & Batch Operations* (chapter 15) for the export path that replaces deep pagination.

**Free Learning Resources**
- **RFC 9110 — HTTP Semantics** — IETF · *Intermediate* · the normative source for status-code and method semantics that pagination responses must respect. <https://www.rfc-editor.org/rfc/rfc9110>
- **RFC 8288 — Web Linking** — IETF · *Intermediate* · defines the `Link` header and `rel="next"/"prev"` relations used by GitHub and most mature APIs. <https://www.rfc-editor.org/rfc/rfc8288>
- **Stripe API Reference — Pagination** — Stripe · *Beginner* · the canonical production cursor design (`starting_after`, `has_more`) with auto-paging client helpers. <https://docs.stripe.com/api/pagination>
- **Using pagination in the REST API** — GitHub Docs · *Beginner* · shows Link-header navigation and why clients must follow links rather than build URLs. <https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api>
- **"Pagination" — Google API Improvement Proposal AIP-158** — Google · *Intermediate* · the reasoning behind `page_size`/`page_token` and opaque token rules at Google scale. <https://google.aip.dev/158>
- **We need tool support for keyset pagination** — Markus Winand (Use The Index, Luke!) · *Advanced* · the definitive explanation of the seek method, its SQL, and its index requirements. <https://use-the-index-luke.com/no-offset>
- **Zalando RESTful API Guidelines — Pagination** — Zalando · *Intermediate* · a battle-tested corporate standard covering cursor structure, limits, and response envelopes. <https://opensource.zalando.com/restful-api-guidelines/#pagination>

---

*REST API Handbook — chapter 13.*
