# 02 · HTTP Fundamentals for API Builders

> **In one line:** HTTP is a stateless request/response protocol whose *semantics* — methods, status codes, headers, representations, conditional requests — are the shared vocabulary every web API, proxy, cache and browser already speaks, and knowing them precisely is the difference between an API that works and one that merely returns 200.

---

## 1. Overview

**HTTP** is the application protocol the web runs on: a client sends a **request** naming a method and a target URI, and the server returns a **response** with a numeric status code and (usually) a representation of some resource. That is the whole shape. Everything else — caching, authentication, content negotiation, ranged downloads, conditional updates — is expressed through headers layered onto those two messages. HTTP is deliberately **stateless**: each request is self-contained and the server is not required to remember anything about the previous one, which is precisely why you can put a hundred identical servers behind a load balancer and have it just work.

The problem HTTP solved was universal document retrieval across heterogeneous machines. Tim Berners-Lee's HTTP/0.9 (1991) was a single line — `GET /page` — with no headers, no status codes and no metadata. **HTTP/1.0 (RFC 1945, 1996)** added headers, status codes and content types. **HTTP/1.1 (RFC 2068/2616, 1997–1999)** added persistent connections, chunked transfer encoding, `Host` (making virtual hosting possible), caching directives and conditional requests. The 2014 rewrite split HTTP/1.1 into RFCs 7230–7235; that series was itself **obsoleted in June 2022 by RFC 9110 (HTTP Semantics)**, **RFC 9111 (Caching)** and **RFC 9112 (HTTP/1.1)** — the crucial reorganisation being that *semantics* are now specified independently of *wire format*. That is why `GET`, `404` and `ETag` mean exactly the same thing whether you are on HTTP/1.1 over TCP, **HTTP/2 (RFC 9113)** with binary framing and multiplexing, or **HTTP/3 (RFC 9114)** over QUIC and UDP.

Why does this matter to an API builder? Because HTTP's semantics are *enforced and exploited by machinery you do not own*. A CDN caches your `GET` because RFC 9110 says `GET` is safe. A client library retries your request because it sees `503` and `Retry-After`. A browser sends a preflight `OPTIONS` because of CORS. A proxy returns `304` on your behalf because you emitted an `ETag`. If you invent your own conventions — `POST /getUser`, `200` with `{"error": true}`, a custom `X-My-Cache-Time` header — none of that machinery helps you, and you end up rebuilding it badly inside your application.

Concretely: **GitHub's REST API** returns `ETag: W/"a1b2..."` on every resource. A polling integration that sends `If-None-Match` gets back `304 Not Modified` with an empty body — and GitHub does not count that request against the client's rate limit. The same integration written without conditional requests burns its 5,000 requests/hour in minutes and transfers hundreds of megabytes. Nothing about that is clever application code; it is just using HTTP as specified. Chapter 02 is about being fluent enough in the protocol that these wins are automatic.

## 2. Core Concepts

- **URI / URL** — the request target. Structure: `scheme://host:port/path?query#fragment`. The fragment is **never** sent to the server. Path identifies the resource; query parameters filter, paginate or shape the representation.
- **Method (verb)** — the operation requested on the target: `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, `TRACE`, `CONNECT`. Method semantics — **safe**, **idempotent**, **cacheable** — are defined in RFC 9110 §9.
- **Status code** — a three-digit result: `1xx` informational, `2xx` success, `3xx` redirection, `4xx` client error, `5xx` server error. The class is the part intermediaries act on.
- **Header field** — case-insensitive `Name: value` metadata. **Representation headers** (`Content-Type`, `Content-Length`, `Content-Encoding`) describe the body; **control headers** (`Cache-Control`, `Authorization`, `Host`) direct processing.
- **Message body / payload** — the bytes of the representation. Not all messages have one: `204`, `304` and responses to `HEAD` must not.
- **Representation** — a specific serialisation of a resource's state at a point in time, identified by a **media type** (`application/json`, `application/problem+json`, `text/csv`).
- **Content negotiation** — the client states preferences (`Accept`, `Accept-Language`, `Accept-Encoding`) and the server picks a representation, echoing the choice in `Content-Type` and listing the deciding headers in `Vary`.
- **Conditional request** — a request carrying a precondition (`If-None-Match`, `If-Match`, `If-Modified-Since`) evaluated against a **validator** (`ETag`, `Last-Modified`), enabling `304 Not Modified` for reads and `412 Precondition Failed` for lost-update protection.
- **Connection management** — HTTP/1.1 keeps TCP connections alive and pipelines poorly (head-of-line blocking); HTTP/2 multiplexes many streams over one connection with header compression (HPACK); HTTP/3 moves to QUIC over UDP, eliminating TCP-level head-of-line blocking.
- **Statelessness** — the server holds no client session between requests; identity and context travel in every request (typically an `Authorization` header).

## 3. Theory & Principles

### Anatomy of the two messages

An HTTP/1.1 request is a start line, header fields, a blank line, and an optional body:

```
POST /v1/orders HTTP/1.1          <- method, request-target, version
Host: api.example.com             <- required in HTTP/1.1; enables virtual hosting
Content-Type: application/json    <- describes the body that follows
Content-Length: 87
                                  <- blank line ends the header section
{"customer_id":"cus_4Kd82",...}   <- body
```

A response replaces the start line with a **status line** (`HTTP/1.1 201 Created`). HTTP/2 and HTTP/3 carry the same information in binary `HEADERS` and `DATA` frames — the method becomes the `:method` pseudo-header, the status becomes `:status` — but the semantics are unchanged. This separation is exactly why RFC 9110 exists independently of RFC 9112/9113/9114.

### Method properties: safe, idempotent, cacheable

Three orthogonal properties, defined in RFC 9110 §9.2:

| Method | Safe | Idempotent | Cacheable | Typical body |
|---|---|---|---|---|
| `GET` | ✅ | ✅ | ✅ | none |
| `HEAD` | ✅ | ✅ | ✅ | none (headers only) |
| `OPTIONS` | ✅ | ✅ | ❌ | none |
| `POST` | ❌ | ❌ | only with explicit freshness | request + response |
| `PUT` | ❌ | ✅ | ❌ | full replacement |
| `PATCH` | ❌ | ❌ (not inherently) | ❌ | partial change |
| `DELETE` | ❌ | ✅ | ❌ | usually none |

**Safe** means "read-only from the client's point of view" — a safe request must not be *expected* to change state (logging and counters are fine). **Idempotent** means the *effect* of N identical requests equals the effect of one; note this constrains server state, not the response. `DELETE /orders/9` is idempotent even though the second call returns `404` — the resulting state is the same. **Cacheable** means a shared or private cache may store and reuse the response, subject to freshness rules.

### Status codes carry meaning, not decoration

`4xx` says "you made a mistake, do not retry unchanged"; `5xx` says "I made a mistake, retrying may work". Getting the specific code right is what makes generic client libraries behave correctly: `401` triggers a token refresh, `403` does not; `429` and `503` trigger backoff honouring `Retry-After`; `409` signals a conflict a human or a merge routine must resolve; `412` says your precondition failed so re-read and retry.

### Conditional requests and the caching validator loop

Caching (RFC 9111) has two independent mechanisms. **Freshness** avoids the request entirely: if `Cache-Control: max-age=300` and 200 seconds have passed, the cache serves from storage with zero network cost. **Validation** avoids the *body*: once stale, the cache re-asks the origin with `If-None-Match: <etag>`; if the representation is unchanged the origin replies `304 Not Modified` with headers only. An `ETag` is an opaque validator — strong (`"abc"`, byte-for-byte identical) or weak (`W/"abc"`, semantically equivalent). `Vary` tells caches which request headers participated in selecting the representation; forgetting `Vary: Accept-Encoding, Authorization` is how one user's private data gets served to another.

```svg
<svg viewBox="0 0 820 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="m1" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#4f46e5"/></marker>
    <marker id="m2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="410" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Freshness, then validation: the ETag / 304 loop</text>
  <rect x="20" y="55" width="130" height="230" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <rect x="345" y="55" width="130" height="230" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <rect x="670" y="55" width="130" height="230" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <g text-anchor="middle" fill="#1e293b" font-weight="bold">
    <text x="85" y="76">Client</text><text x="410" y="76">Shared cache</text><text x="735" y="76">Origin</text>
  </g>
  <g stroke="#4f46e5" stroke-width="2" marker-end="url(#m1)">
    <line x1="152" y1="105" x2="341" y2="105"/><line x1="477" y1="200" x2="666" y2="200"/>
  </g>
  <g stroke="#16a34a" stroke-width="2" marker-end="url(#m2)">
    <line x1="341" y1="140" x2="154" y2="140"/><line x1="666" y1="235" x2="479" y2="235"/>
    <line x1="341" y1="268" x2="154" y2="268"/>
  </g>
  <g fill="#1e293b" font-size="11">
    <text x="246" y="99" text-anchor="middle">GET /v1/orders/9</text>
    <text x="246" y="134" text-anchor="middle">HIT within max-age=300</text>
    <text x="246" y="155" text-anchor="middle">200 OK (0 network to origin)</text>
    <text x="571" y="194" text-anchor="middle">stale: If-None-Match: W/"v7"</text>
    <text x="571" y="229" text-anchor="middle">304 Not Modified (no body)</text>
    <text x="246" y="262" text-anchor="middle">200 OK from revalidated copy</text>
  </g>
  <rect x="180" y="290" width="460" height="30" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="410" y="310" text-anchor="middle" fill="#1e293b" font-size="12">Cache-Control: public, max-age=300, stale-while-revalidate=60 | Vary: Accept-Encoding</text>
</svg>
```

> **Note:** `Cache-Control` is a *directive*, not a request. `no-store` means never write it down anywhere; `no-cache` means you may store it but must revalidate before reuse; `private` means browsers only, never a shared CDN. Confusing `no-cache` with `no-store` is the single most common caching bug in production APIs.

## 4. Architecture & Workflow

Trace a browser-based `PATCH` from keypress to render — it exercises DNS, TLS, CORS, negotiation and conditional updates in one flow:

1. **URL resolution.** The client parses `https://api.example.com/v1/orders/9`, resolves DNS, and opens a TCP+TLS (or QUIC) connection — or reuses an existing pooled one, which is why keep-alive matters so much.
2. **CORS preflight.** Because this is a cross-origin `PATCH` with a JSON `Content-Type`, the browser first sends `OPTIONS /v1/orders/9` with `Origin`, `Access-Control-Request-Method` and `Access-Control-Request-Headers`. The server must answer `204` with matching `Access-Control-Allow-*` headers, ideally plus `Access-Control-Max-Age` so the preflight is cached.
3. **The real request.** The client sends `PATCH` with `Authorization`, `Content-Type: application/merge-patch+json`, and `If-Match: W/"v7"` — the ETag it received when it read the resource.
4. **Edge and proxy hops.** Each intermediary may add `Via`, `X-Forwarded-For` and trace headers. Hop-by-hop headers (`Connection`, `Transfer-Encoding`, `Upgrade`) are consumed and not forwarded; end-to-end headers pass through.
5. **Server routing and negotiation.** The framework matches method + path template, parses `Accept` to choose a media type, and validates `Content-Type` — mismatch is `415 Unsupported Media Type`.
6. **Precondition evaluation.** The server compares `If-Match` against the current entity tag. Mismatch ⇒ `412 Precondition Failed` (someone else wrote first). Absent, on an API that requires it ⇒ `428 Precondition Required`.
7. **Business logic and persistence.** Validation failures split: syntactically malformed ⇒ `400`; well-formed but semantically rejected ⇒ `422`. Success writes the new state and computes a new `ETag`.
8. **Response.** `200 OK` with the updated representation, a fresh `ETag: W/"v8"`, `Cache-Control: private, no-cache` and `Vary`. The client updates its cached copy and its stored validator.
9. **Connection reuse.** The connection stays open. On HTTP/2 the next twenty requests multiplex over the same connection with compressed headers; on HTTP/1.1 they queue.

```svg
<svg viewBox="0 0 820 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="n1" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#4f46e5"/></marker>
    <marker id="n2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#d97706"/></marker>
  </defs>
  <text x="410" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Request lifecycle: preflight, negotiation, precondition</text>
  <line x1="120" y1="45" x2="120" y2="330" stroke="#94a3b8" stroke-width="2"/>
  <line x1="700" y1="45" x2="700" y2="330" stroke="#94a3b8" stroke-width="2"/>
  <text x="120" y="40" text-anchor="middle" fill="#1e293b" font-weight="bold">Browser</text>
  <text x="700" y="40" text-anchor="middle" fill="#1e293b" font-weight="bold">API server</text>

  <line x1="122" y1="80" x2="696" y2="80" stroke="#4f46e5" stroke-width="2" marker-end="url(#n1)"/>
  <text x="409" y="74" text-anchor="middle" fill="#1e293b" font-size="11">OPTIONS /v1/orders/9 &#183; Origin &#183; Access-Control-Request-Method: PATCH</text>
  <line x1="698" y1="112" x2="124" y2="112" stroke="#16a34a" stroke-width="2"/>
  <text x="409" y="106" text-anchor="middle" fill="#1e293b" font-size="11">204 No Content &#183; Access-Control-Allow-Methods &#183; Access-Control-Max-Age: 600</text>

  <line x1="122" y1="152" x2="696" y2="152" stroke="#4f46e5" stroke-width="2" marker-end="url(#n1)"/>
  <text x="409" y="146" text-anchor="middle" fill="#1e293b" font-size="11">PATCH /v1/orders/9 &#183; Authorization &#183; If-Match: W/"v7" &#183; Accept: application/json</text>

  <rect x="600" y="170" width="200" height="86" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <g fill="#1e293b" font-size="11">
    <text x="612" y="190">1. route + method match</text>
    <text x="612" y="208">2. 415 if Content-Type bad</text>
    <text x="612" y="226">3. 412 if ETag mismatch</text>
    <text x="612" y="244">4. 400 vs 422 on validation</text>
  </g>

  <line x1="698" y1="286" x2="124" y2="286" stroke="#16a34a" stroke-width="2"/>
  <text x="409" y="280" text-anchor="middle" fill="#1e293b" font-size="11">200 OK &#183; ETag: W/"v8" &#183; Cache-Control: private, no-cache &#183; Vary: Accept</text>
  <line x1="122" y1="318" x2="696" y2="318" stroke="#d97706" stroke-width="2" stroke-dasharray="5 4" marker-end="url(#n2)"/>
  <text x="409" y="312" text-anchor="middle" fill="#b45309" font-size="11">connection kept alive &#8212; next requests multiplex (HTTP/2) or queue (HTTP/1.1)</text>
</svg>
```

## 5. Implementation

### A full exchange, warts and all

```http
GET /v1/orders?status=shipped&limit=25 HTTP/1.1
Host: api.example.com
Accept: application/json
Accept-Encoding: gzip, br
Authorization: Bearer eyJhbGciOiJSUzI1NiJ9...
If-None-Match: W/"page-7-a91f"

HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Content-Encoding: gzip
ETag: W/"page-7-b02c"
Cache-Control: private, max-age=30, stale-while-revalidate=60
Vary: Accept, Accept-Encoding, Authorization
RateLimit-Limit: 5000
RateLimit-Remaining: 4873
Date: Wed, 22 Jul 2026 09:14:03 GMT

{"data":[{"id":"ord_9F2xQ","status":"shipped"}],"next_cursor":"eyJpZCI6..."}
```

Re-issue with the *new* ETag and the origin answers with no body at all:

```http
GET /v1/orders?status=shipped&limit=25 HTTP/1.1
If-None-Match: W/"page-7-b02c"

HTTP/1.1 304 Not Modified
ETag: W/"page-7-b02c"
Cache-Control: private, max-age=30
```

### Inspecting real traffic

```bash
# Headers only — HEAD is GET without the body; ideal for probing size and validators
curl -sS -I https://api.github.com/repos/torvalds/linux

# Show the full exchange plus TLS and HTTP version negotiation
curl -sS -v --http2 https://api.github.com/repos/torvalds/linux -o /dev/null

# Conditional GET: expect "HTTP/2 304" and zero bytes of body
ETAG=$(curl -sSI https://api.github.com/repos/torvalds/linux | awk -F': ' '/^etag/{print $2}' | tr -d '\r')
curl -sS -o /dev/null -w '%{http_code} %{size_download} bytes\n' \
     -H "If-None-Match: $ETAG" https://api.github.com/repos/torvalds/linux

# Content negotiation in action
curl -sS -H 'Accept: application/vnd.github.raw+json' https://api.github.com/zen
```

### Serving the protocol correctly (FastAPI)

```python
import hashlib, json
from fastapi import FastAPI, Request, Response, HTTPException

app = FastAPI()
ORDERS = {"ord_9F2xQ": {"id": "ord_9F2xQ", "status": "shipped", "version": 7}}

def etag_for(obj: dict) -> str:
    body = json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()
    return 'W/"%s"' % hashlib.sha256(body).hexdigest()[:16]

@app.get("/v1/orders/{oid}")
def read_order(oid: str, request: Request, response: Response):
    order = ORDERS.get(oid) or _not_found()
    tag = etag_for(order)
    response.headers["ETag"] = tag
    response.headers["Cache-Control"] = "private, max-age=30"
    response.headers["Vary"] = "Accept, Accept-Encoding, Authorization"
    if request.headers.get("if-none-match") == tag:
        response.status_code = 304          # 304 MUST NOT carry a body
        return Response(status_code=304, headers=dict(response.headers))
    return order

@app.patch("/v1/orders/{oid}")
def patch_order(oid: str, patch: dict, request: Request, response: Response):
    order = ORDERS.get(oid) or _not_found()
    if_match = request.headers.get("if-match")
    if if_match is None:
        raise HTTPException(428, "If-Match required for updates")   # lost-update guard
    if if_match != etag_for(order):
        raise HTTPException(412, "Resource has changed since you read it")
    if set(patch) - {"status"}:
        raise HTTPException(422, "Only 'status' may be patched")    # semantic, not syntax
    order.update(patch); order["version"] += 1
    response.headers["ETag"] = etag_for(order)
    return order

def _not_found():
    raise HTTPException(404, "No such order")
```

### Client-side: honouring the protocol

```javascript
// Cache the validator alongside the payload and let the server decide.
const store = new Map();                     // url -> { etag, body }

async function getCached(url, token) {
  const prev = store.get(url);
  const res = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/json",
      ...(prev ? { "If-None-Match": prev.etag } : {}),
    },
  });
  if (res.status === 304) return prev.body;  // free: no body transferred
  const body = await res.json();
  const etag = res.headers.get("ETag");
  if (etag) store.set(url, { etag, body });
  return body;
}
```

> **Optimization note.** Three protocol-level wins, in order of payoff. **(1) Conditional requests** turn repeat polls into ~200-byte `304`s and, on APIs like GitHub, stop consuming quota. **(2) Connection reuse** — every fresh TLS handshake costs 1–2 RTTs; with HTTP/2 one connection multiplexes hundreds of streams and HPACK compresses the repeated `Authorization` and `User-Agent` headers that would otherwise dominate small requests. **(3) Compression** — `Content-Encoding: br` or `gzip` typically cuts JSON by 70–90%. Measure with `curl -w '%{time_connect} %{time_starttransfer} %{size_download}\n'` before you optimise anything in your application code.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| **Ubiquity** | Every language, proxy, firewall and CDN speaks it; port 443 is open everywhere | You inherit decades of quirks: header casing, `Referer`'s misspelling, ambiguous `Content-Length`/`Transfer-Encoding` handling |
| **Uniform semantics** | Intermediaries cache, retry and route without knowing your domain | Only works if you use codes and methods *correctly*; a `200`-for-everything API forfeits all of it |
| **Statelessness** | Any replica serves any request; scaling and deploys are simple | Auth and context re-sent per request; HTTP/2 HPACK mitigates but does not eliminate the cost |
| **Text-based (1.1)** | Trivially debuggable with `curl`, `tcpdump`, browser devtools | Verbose; HTTP/2 and HTTP/3 are binary and need tooling (`nghttp`, Wireshark, `--http2` in curl) |
| **Caching model** | `ETag` + `Cache-Control` can eliminate most origin traffic | Correctness is subtle — `Vary`, `no-cache` vs `no-store`, and private data in shared caches are real incident sources |
| **Content negotiation** | One URI can serve JSON, CSV and protobuf to different clients | Multiplies cache keys and test surface; most APIs are better off with a single media type |
| **HTTP/2 multiplexing** | Removes HTTP/1.1 head-of-line blocking and per-request handshakes | TCP-level head-of-line blocking remains under packet loss (HTTP/3 fixes this); one connection is now one failure domain |
| **Request/response shape** | Simple, well-understood, easy to instrument | Poor fit for server push and streaming; needs SSE, WebSockets or long-polling for those |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Returning `200 OK` for failures** with `{"error": "..."}` in the body. Every cache, dashboard, retry policy and generated SDK reads the status line. ✅ Use the accurate code and put the detail in an RFC 9457 `application/problem+json` body.
2. ⚠️ **Verbs in URIs** (`POST /createOrder`, `GET /deleteUser?id=9`). This makes safe operations unsafe and destroys cacheability. ✅ Nouns in the path, semantics in the method.
3. ⚠️ **Confusing `400` and `422`.** `400` is for malformed syntax the parser rejected; `422` is for well-formed input your business rules refuse. Collapsing them makes client error handling guesswork. ✅ Distinguish them, and always name the offending field.
4. ⚠️ **Confusing `401` and `403`.** `401` means "I do not know who you are" and MUST include a `WWW-Authenticate` header; `403` means "I know exactly who you are and you still may not". ✅ A client that refreshes its token on `403` will loop forever.
5. ⚠️ **`no-cache` when you meant `no-store`.** `no-cache` permits storage and requires revalidation; `no-store` forbids writing the response down at all. ✅ Use `Cache-Control: no-store` for tokens, PII and one-time links.
6. ⚠️ **Forgetting `Vary`.** If the response depends on `Accept`, `Accept-Encoding` or `Authorization` and you omit `Vary`, a shared cache can serve one tenant's data to another. ✅ Emit `Vary` for every header that influenced the representation, or mark it `private`/`no-store`.
7. ⚠️ **Putting a body on `204` or `304`.** RFC 9110 forbids it; some clients hang or error. ✅ `204` for empty success, `200` when you genuinely return content.
8. ⚠️ **`PUT` used for partial updates.** `PUT` replaces the whole representation, so omitted fields must be cleared — sending `{"status":"shipped"}` with `PUT` should wipe everything else. ✅ Use `PATCH` (`application/merge-patch+json` or RFC 6902 JSON Patch) for partial change.
9. ⚠️ **Ignoring `Retry-After` and retrying `4xx`.** Hammering a `429` amplifies the outage you are inside; retrying a `400` will never succeed. ✅ Retry only `408`, `425`, `429` and `5xx`, with exponential backoff plus jitter, honouring `Retry-After`.
10. ⚠️ **Unbounded request bodies and header sizes.** A 2 GB JSON body or a 100 KB header is a trivial DoS. ✅ Enforce limits at the edge and return `413 Content Too Large` / `431 Request Header Fields Too Large`.
11. ⚠️ **`Content-Type: text/html` or none on JSON responses.** Clients sniff, browsers may render, XSS becomes possible. ✅ Always `application/json; charset=utf-8`, plus `X-Content-Type-Options: nosniff`.
12. ⚠️ **Wildcard CORS with credentials.** `Access-Control-Allow-Origin: *` combined with `Allow-Credentials: true` is rejected by browsers and signals a broken security model. ✅ Echo a validated origin from an allow-list.

## 8. Production: Debugging, Monitoring, Security & Scaling

### Debugging

`curl -v` is the ground truth; `-I` for a `HEAD` probe, `--http1.1` / `--http2` to pin the version, `-w` for timing breakdowns (`time_namelookup`, `time_connect`, `time_appconnect`, `time_starttransfer`). When a browser and `curl` disagree, the difference is almost always CORS, cookies, or a `Vary`-keyed cache entry. For "it works then suddenly 400s", check header size limits and proxies rewriting `Transfer-Encoding`. Capture with `tcpdump`/Wireshark only after you have exhausted `curl` — on HTTP/2 you will need `SSLKEYLOGFILE` to decrypt.

### Monitoring

Instrument by **route template** and method: request rate, status-class distribution, and latency histograms (p50/p95/p99) split into `time_to_first_byte` versus total. Watch cache-effectiveness explicitly — the ratio of `304` to `200` on your conditional endpoints, CDN hit ratio, and `Age` header distribution. Watch protocol health: HTTP/2 `GOAWAY` frames, connection churn, TLS handshake rate (a spike means clients stopped reusing connections), and `499`/client-cancelled rates. Emit and propagate `traceparent`; return `X-Request-Id` on every response including errors.

### Security

Enforce HTTPS only, with HSTS (`Strict-Transport-Security: max-age=31536000; includeSubDomains`). Send `X-Content-Type-Options: nosniff` and a restrictive `Content-Security-Policy` on anything a browser might render. Keep credentials out of URLs — query strings land in access logs, `Referer` headers and browser history; use `Authorization`. Return `WWW-Authenticate` with `401`. Bound body size, header size, URL length and the number of query parameters. Treat `X-Forwarded-For` as untrusted unless your edge overwrites it. Disable `TRACE` (cross-site tracing) and never reflect arbitrary request headers into responses.

### Performance & scaling

Enable HTTP/2 at the edge and keep-alive to upstreams — connection setup often dominates small-payload latency. Terminate TLS at the edge with session resumption and OCSP stapling. Compress with Brotli, falling back to gzip. Set correct `Cache-Control` so the CDN absorbs read traffic and use `stale-while-revalidate` to hide origin latency during revalidation. For large payloads, support `Range` requests (`206 Partial Content`) and streaming (`Transfer-Encoding: chunked` on 1.1, `DATA` frames on 2/3). Set server-side timeouts on read, write and idle so slow-loris clients cannot pin connections.

## 9. Interview Questions

**Q: What are the parts of an HTTP request and response?**
A: A request is a start line (method, request target, version), header fields, a blank line, and an optional body. A response replaces the start line with a status line (version, status code, reason phrase) and otherwise has the same structure. HTTP/2 and HTTP/3 encode the same semantics in binary frames with pseudo-headers like `:method` and `:status`.

**Q: What does it mean for a method to be safe versus idempotent?**
A: Safe means the client does not request a state change — `GET`, `HEAD`, `OPTIONS` and `TRACE` are safe. Idempotent means N identical requests leave the server in the same state as one: `GET`, `HEAD`, `PUT` and `DELETE` are idempotent, `POST` and `PATCH` are not. Safe implies idempotent, but not the reverse.

**Q: Explain `400` versus `422`, and `401` versus `403`.**
A: `400` is malformed syntax the server could not parse; `422` is well-formed content that violates a semantic or business rule. `401` means unauthenticated — credentials are missing or invalid, and the response must carry `WWW-Authenticate`; `403` means authenticated but not permitted, so retrying with a fresh token is pointless.

**Q: What is an `ETag` and how does a conditional request use it?**
A: An `ETag` is an opaque validator the server assigns to a specific representation. On a read, the client sends it back as `If-None-Match`; if unchanged the server returns `304 Not Modified` with no body. On a write, the client sends `If-Match`; if the resource has changed the server returns `412 Precondition Failed`, which prevents the lost-update problem.

**Q: Difference between `Cache-Control: no-cache` and `no-store`?**
A: `no-cache` allows caches to store the response but requires revalidation with the origin before every reuse. `no-store` forbids writing the response to any storage at all and is what you use for tokens, PII and one-time links. `private` is a third thing: storable by the user's own browser cache but never by a shared/CDN cache.

**Q: Why does `Vary` exist and what breaks without it?**
A: `Vary` lists the request headers that influenced which representation the server selected, so caches key their entries on those headers too. Without `Vary: Accept-Encoding` a cache can hand a gzip body to a client that cannot decode it; without `Vary: Authorization` (or `private`) a shared cache can serve one user's data to another. It is a correctness header, not an optimisation.

**Q: What is a CORS preflight and when is it triggered?**
A: For cross-origin requests that are not "simple" — anything using `PUT`/`PATCH`/`DELETE`, a non-simple `Content-Type` like `application/json`, or custom headers — the browser first sends `OPTIONS` with `Origin` and `Access-Control-Request-*` headers. The server must respond with matching `Access-Control-Allow-*` headers; `Access-Control-Max-Age` lets the browser cache that decision and skip future preflights.

**Q: What actually changed in HTTP/2 and HTTP/3?**
A: HTTP/2 kept the semantics but replaced the wire format with binary framing, added multiplexing of many streams over one TCP connection, header compression (HPACK) and server push (now largely deprecated). HTTP/3 keeps HTTP/2's model but runs over QUIC on UDP, so packet loss on one stream no longer blocks the others and connection setup merges with the TLS handshake.

**Q: (Senior) A client reports intermittent stale data from your API. How do you diagnose it?**
A: Determine which layer is serving the stale copy by inspecting `Age`, `X-Cache`, `Via` and the `Date` header, and reproduce with a cache-busting query parameter to confirm the origin is correct. The usual causes are an overlong `max-age` with no revalidation path, a missing `Vary` so the cache is keyed too coarsely, or a CDN configured to ignore origin headers. The fix is usually a short `max-age` plus `stale-while-revalidate`, an accurate `ETag`, and explicit purge on write.

**Q: (Senior) Why is `POST` cacheable "in principle" but never in practice?**
A: RFC 9110 allows a `POST` response to be cached only when it carries explicit freshness information, and the cached entry may then be used for subsequent `GET`/`HEAD` on the same URI — not for subsequent `POST`s. Since `POST` is neither safe nor idempotent and its response usually depends on the body, essentially no cache implements it. If you find yourself wanting a cacheable `POST`, the real problem is that a read operation was modelled as a write, often because the query was too large for a URL; the honest fixes are a `GET` with a compact cursor or a dedicated search resource.

**Q: (Senior) How do you protect against the lost-update problem in a REST API?**
A: Use optimistic concurrency with entity tags: every read returns an `ETag`, every write must carry `If-Match`. A mismatch yields `412 Precondition Failed` and the client must re-read and merge; an absent header on an API that requires one yields `428 Precondition Required`. Version numbers in the body are a weaker variant because they bypass HTTP's own precondition machinery and intermediaries cannot participate.

**Q: (Senior) You see a spike in TLS handshakes with flat request volume. What is happening and why does it matter?**
A: Clients have stopped reusing connections — a changed keep-alive timeout, a load balancer sending `Connection: close`, an SDK creating a new client per call, or HTTP/2 `GOAWAY` frames forcing reconnects. It matters because each handshake adds 1–2 RTTs and significant CPU on both ends, so p99 latency rises and the front-end tier saturates on crypto rather than work. Diagnose with connection-lifetime and `GOAWAY` metrics, then fix the pooling or the idle timeout mismatch.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** HTTP is a stateless request/response protocol. A request is method + target + headers + optional body; a response is a status code + headers + optional body. Semantics live in **RFC 9110**, caching in **RFC 9111**, and are identical across HTTP/1.1, /2 and /3 — only the wire format changes. Methods have three properties: safe (`GET`, `HEAD`, `OPTIONS`, `TRACE`), idempotent (those plus `PUT`, `DELETE`), and cacheable (`GET`, `HEAD`). Status classes drive intermediary behaviour: `4xx` is the caller's fault and must not be blindly retried, `5xx` is yours and may be. Caching has two independent layers — freshness (`Cache-Control: max-age`) avoids the request; validation (`ETag` + `If-None-Match` ⇒ `304`) avoids the body. `If-Match` ⇒ `412` gives you optimistic concurrency. `Vary` keeps shared caches correct. Content negotiation happens through `Accept`/`Content-Type`. Cross-origin browser calls trigger an `OPTIONS` preflight. Get these right and CDNs, proxies and client libraries do a large part of your work for free.

| Item | Value |
|---|---|
| Semantics / caching / HTTP-1.1 specs | RFC 9110 / 9111 / 9112 |
| Safe methods | `GET`, `HEAD`, `OPTIONS`, `TRACE` |
| Idempotent methods | safe + `PUT`, `DELETE` |
| Cacheable by default | `GET`, `HEAD` |
| Read validator flow | `ETag` → `If-None-Match` → `304 Not Modified` |
| Write precondition flow | `ETag` → `If-Match` → `412` (or `428` if missing) |
| Never store | `Cache-Control: no-store` |
| Store but revalidate | `Cache-Control: no-cache` |
| Browser-only cache | `Cache-Control: private` |
| Payload too large / header too large | `413` / `431` |
| Wrong media type sent | `415 Unsupported Media Type` |
| Throttled | `429` + `Retry-After` |
| Retryable statuses | `408`, `425`, `429`, `500`, `502`, `503`, `504` |
| Must not have a body | `204`, `304`, and any response to `HEAD` |

**Flash cards**
- **Safe vs idempotent** → Safe = no requested state change (`GET`/`HEAD`/`OPTIONS`/`TRACE`); idempotent = N calls ≡ 1 call (safe + `PUT`/`DELETE`).
- **`no-cache` vs `no-store`** → `no-cache` = may store, must revalidate; `no-store` = must not write it down anywhere.
- **How do you prevent lost updates?** → Return `ETag` on read, require `If-Match` on write, answer `412` on mismatch and `428` when the header is absent.
- **What triggers a CORS preflight?** → A cross-origin request that is not "simple": `PUT`/`PATCH`/`DELETE`, JSON `Content-Type`, or custom headers.
- **What did HTTP/2 change?** → Wire format only: binary framing, stream multiplexing, HPACK header compression. The semantics of RFC 9110 are untouched.

## 11. Hands-On Exercises & Mini Project

- [ ] Use `curl -v` against three public APIs and write down, for each: negotiated HTTP version, `Content-Type`, presence of `ETag`/`Cache-Control`/`Vary`, and the full timing breakdown from `-w '%{time_connect} %{time_appconnect} %{time_starttransfer}\n'`.
- [ ] Reproduce a `304` end to end: fetch a GitHub resource, capture the `ETag`, re-fetch with `If-None-Match`, and record the byte and quota difference.
- [ ] Trigger each of `400`, `401`, `403`, `404`, `405`, `409`, `412`, `415`, `422`, `428` and `429` against a local server you write, and confirm the response body is `application/problem+json` in every case.
- [ ] Build a two-tab lost-update demo: read a resource in both tabs, `PATCH` from tab A, then `PATCH` from tab B with the stale `If-Match` and observe the `412`.
- [ ] Put Varnish or nginx in front of your API and prove that a `Vary`-less endpoint serves a gzip body to an `Accept-Encoding: identity` client.

### Mini Project — "HTTP Protocol Lab"

**Goal.** Build a small API that implements HTTP correctly enough that a generic CDN and a generic client library both behave optimally against it without custom configuration.

**Requirements.**
1. `GET /v1/articles/{id}` returning `ETag`, `Last-Modified`, `Cache-Control: public, max-age=60, stale-while-revalidate=120` and `Vary: Accept, Accept-Encoding`; support `If-None-Match` and `If-Modified-Since`.
2. `PATCH /v1/articles/{id}` requiring `If-Match`, answering `428` when absent and `412` on mismatch, and `415` if `Content-Type` is not `application/merge-patch+json`.
3. Content negotiation: serve `application/json` and `text/csv` from the same URI based on `Accept`, returning `406` when nothing acceptable can be produced.
4. A CORS layer with an origin allow-list, correct preflight handling and `Access-Control-Max-Age: 600`.
5. Enforced limits returning `413` and `431`, plus a token-bucket limiter returning `429` with `Retry-After` and `RateLimit-*` headers.

**Extensions.**
- Add `Range` support with `206 Partial Content` and `Accept-Ranges: bytes` for an article's attachment.
- Run the same service behind nginx as a caching proxy and measure origin request reduction with and without correct `Cache-Control`.
- Serve it over HTTP/1.1 and HTTP/2 and benchmark 200 concurrent small requests to quantify the multiplexing win.
- Write a conformance test suite asserting that `204`/`304` carry no body and that every error is `application/problem+json`.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *What Is an API? Web APIs & Clients* (why this protocol became the integration substrate), *What Is REST? Constraints & Maturity* (the architectural style built on these semantics), *Resource Modeling & URI Design* (designing the request targets), *HTTP Methods, Safety & Idempotency* (method semantics in full depth), *REST vs GraphQL, gRPC & SOAP* (what other styles do with the same transport).

- **MDN Web Docs — HTTP** — Mozilla · *Beginner* · the best-organised HTTP reference available: one page per header, method and status code, each with examples and browser-compatibility notes. <https://developer.mozilla.org/en-US/docs/Web/HTTP>
- **RFC 9110 — HTTP Semantics** — IETF, 2022 · *Intermediate* · the normative source; §9 (methods), §13 (conditional requests) and §15 (status codes) repay careful reading and settle most team arguments. <https://www.rfc-editor.org/rfc/rfc9110.html>
- **RFC 9111 — HTTP Caching** — IETF, 2022 · *Advanced* · freshness, validation, `Vary`, and the exact rules shared caches follow; essential before you configure a CDN. <https://www.rfc-editor.org/rfc/rfc9111.html>
- **Caching best practices & max-age gotchas** — Jake Archibald, web.dev · *Intermediate* · the clearest practical explanation of cache patterns, immutable assets and revalidation anywhere. <https://web.dev/articles/http-cache>
- **High Performance Browser Networking** — Ilya Grigorik (free full text) · *Advanced* · definitive chapters on TCP, TLS, HTTP/1.1 vs HTTP/2 and QUIC, with the latency math behind every optimisation. <https://hpbn.co/>
- **MDN — Cross-Origin Resource Sharing (CORS)** — Mozilla · *Beginner* · the preflight flow, simple-request rules and every `Access-Control-*` header, with the common failure modes named. <https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS>
- **HTTP/3 explained** — Daniel Stenberg (curl author) · *Intermediate* · free book on QUIC and HTTP/3: why UDP, what head-of-line blocking really costs, and what changes for API operators. <https://http3-explained.haxx.se/>
- **OWASP HTTP Security Headers Cheat Sheet** — OWASP · *Intermediate* · which security headers to send, what each one actually prevents, and safe defaults for JSON APIs. <https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html>

---

*REST API Handbook — chapter 02.*
