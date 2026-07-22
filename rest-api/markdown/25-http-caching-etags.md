# 25 · HTTP Caching: ETags & Cache-Control

> **In one line:** HTTP caching lets you serve a response without recomputing it — `Cache-Control` decides *how long* a copy stays fresh, and validators like `ETag` let a client re-confirm a stale copy for the price of a 304 instead of a full payload.

---

## 1. Overview

Caching is the single highest-leverage performance feature in HTTP, and it is the one most API teams leave switched off. Every response your API returns carries an implicit statement about its own reusability: how long it is good for, who may store it, and how a stored copy can be revalidated later. `Cache-Control` and the validator headers (`ETag`, `Last-Modified`) are how you make that statement explicit. When you do, browsers, mobile HTTP clients, reverse proxies, and CDN edge nodes will all cooperate to keep traffic away from your origin.

The problem it solves is brutally simple arithmetic. A product-catalog endpoint that costs 40 ms of database work and 12 KB of JSON, called 20,000 times a minute, burns roughly 13 CPU-minutes per minute and 240 MB/min of egress. If 90% of those requests can be served from a CDN edge, or answered with a 47-byte `304 Not Modified`, you have removed nine tenths of the cost *without changing a line of business logic*. Caching is not a micro-optimization; it is a change in the order of magnitude of your infrastructure bill.

The lineage matters because the field is littered with folklore. HTTP/1.0 shipped `Expires` (an absolute timestamp, hostage to clock skew) and `Pragma: no-cache`. HTTP/1.1 introduced `Cache-Control` with relative freshness lifetimes and conditional requests. The rules were consolidated in **RFC 7234** and then rewritten and clarified in **RFC 9111 (HTTP Caching, June 2022)**, with the surrounding semantics — conditional requests, validators, `Vary` — living in **RFC 9110 (HTTP Semantics)**. If you learn caching from a 2011 blog post you will get `Pragma`, `must-revalidate` superstition, and `no-cache` confusion. Read 9111.

**Concrete example.** GitHub's REST API returns an `ETag` on essentially every `GET`. A polling integration that sends `If-None-Match` and gets back `304 Not Modified` **does not consume rate limit quota** — GitHub explicitly documents this. That is the strongest possible incentive design: the platform makes conditional requests free, so well-behaved clients poll efficiently, and GitHub's fleet serves millions of pollers for the cost of a hash comparison. Stripe takes a different tack — most Stripe API responses are `Cache-Control: no-store` because balances and charges are money and staleness is unacceptable — which is itself the lesson: *caching policy is a per-resource product decision, not a global switch.* The durable mental model has two independent axes. **Freshness** answers "may I use this copy without asking?" and is governed by `max-age`/`s-maxage`/`Expires`. **Validation** answers "my copy is stale — is it still correct?" and is governed by `ETag`/`Last-Modified` plus `If-None-Match`/`If-Modified-Since`. A response can have both, either, or neither. Freshness saves the round trip entirely; validation saves only the body but still costs an RTT. Most API resources want a short freshness window *and* a validator.

## 2. Core Concepts

- **Freshness lifetime** — the interval during which a stored response may be reused without contacting the origin, computed from `s-maxage`, then `max-age`, then `Expires`, then a heuristic.
- **Age** — how long a response has been sitting in caches, reported by the `Age` response header in seconds; a response is fresh while `age < freshness_lifetime`.
- **Validator** — an opaque token (`ETag`) or timestamp (`Last-Modified`) that identifies a specific representation so a cache can ask "still this one?"
- **Strong vs weak ETag** — a strong validator (`ETag: "abc"`) means byte-for-byte identical; a weak one (`ETag: W/"abc"`) means semantically equivalent and is unusable for byte-range requests.
- **Conditional request** — a request carrying `If-None-Match` or `If-Modified-Since` that the origin answers with `304 Not Modified` (headers only, no body) when the client's copy is still valid.
- **Private vs shared cache** — a browser or app-local cache is private and may store user-specific data; a CDN or reverse proxy is shared and must never store a response marked `private`.
- **`Vary`** — lists the request headers that participate in the cache key, so a response negotiated on `Accept-Encoding` or `Accept-Language` is not served to a client that asked for something else.
- **Stale-while-revalidate** — an extension (RFC 5861) that lets a cache serve a stale copy immediately while asynchronously refreshing it, converting a latency spike into a background fetch.
- **Cache key** — the tuple a cache stores under: normally method + effective URI + the headers named in `Vary`; CDNs let you customize it (e.g., strip tracking query params).
- **Purge vs invalidate** — a purge actively evicts an object from an edge cache; invalidation marks it stale so the next request revalidates. Purges are the escape hatch for long TTLs.

## 3. Theory & Principles

REST names caching as an explicit architectural constraint: *"Cache constraints require that the data within a response to a request be implicitly or explicitly labeled as cacheable or non-cacheable."* Fielding's point is that a stateless, uniform-interface protocol makes intermediary caching possible in the first place — because a request is self-descriptive, any node on the path can reason about reusability without application knowledge. This is why a CDN can accelerate your API but cannot accelerate your gRPC-over-a-custom-framing stream.

**Which methods and statuses are cacheable.** Per RFC 9110, `GET` and `HEAD` are cacheable by default. `POST` responses are cacheable *only* if they carry explicit freshness information — vanishingly rare in practice, and you should not rely on it. Unsafe methods (`POST`, `PUT`, `PATCH`, `DELETE`) **invalidate** the cached entry for the target URI when they return a non-error status. Cacheable-by-default status codes include `200`, `203`, `204`, `206`, `300`, `301`, `308`, `404`, `405`, `410`, `414`, and `501` — note that **`404` is cacheable by default**, which surprises people whose deploy briefly 404s an asset and then serves it from cache for an hour.

**Freshness arithmetic.** A shared cache computes:

```
freshness_lifetime = s-maxage  ?? max-age  ?? (Expires - Date)  ?? heuristic
current_age        = max(apparent_age, corrected_age_value) + resident_time
is_fresh           = freshness_lifetime > current_age
```

`s-maxage` overrides `max-age` for shared caches only, which is the key that unlocks the most useful API pattern: `Cache-Control: private, max-age=0, s-maxage=60` — never trusted blindly by the browser, cached for a minute at the CDN. (In practice `private` forbids shared storage entirely, so the real pairing is `public, max-age=0, s-maxage=60`.)

**The three directives everyone confuses.** `no-cache` means you **may** store the response but **must** revalidate before every reuse. `no-store` means you may not write it to disk or memory at all — this is the privacy directive. `must-revalidate` means that once stale, a cache may not serve the copy even if the origin is unreachable, which blocks stale-on-error. `no-cache` + `ETag` is a superb default for authenticated API resources: zero staleness risk, but repeat reads cost one RTT and 300 bytes instead of a full payload.

**ETag generation.** An ETag must change whenever the representation changes and must be stable when it does not. Three sane strategies: (a) hash the serialized response body (`sha256` truncated to 16 hex chars) — always correct, costs you the serialization; (b) derive it from a monotonic row version (`W/"v42"`) — cheap, and it lets you answer `If-None-Match` *before* touching the serializer; (c) compose it from `updated_at` plus a schema version (`W/"1-1721650000"`) — cheap but has a one-second resolution hazard, which is exactly why `Last-Modified` is weak.

**The `Vary` trap.** If your response body depends on `Authorization`, a shared cache that keys only on URI will serve Alice's data to Bob. The correct answer is *not* `Vary: Authorization` (which technically works but shreds your hit ratio and is easy to get wrong) — it is `Cache-Control: private` so shared caches never store it at all. Reserve `Vary` for genuine content negotiation: `Vary: Accept-Encoding, Accept-Language, Accept`.

```svg
<svg viewBox="0 0 760 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="10" y="10" width="740" height="320" rx="14" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="380" y="38" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Freshness vs Validation: the two axes of HTTP caching</text>

  <rect x="35" y="60" width="140" height="60" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="105" y="86" text-anchor="middle" fill="#1e293b" font-size="13" font-weight="700">Client cache</text>
  <text x="105" y="105" text-anchor="middle" fill="#1e293b" font-size="11">has stored copy</text>
  <path d="M175 90 L245 90" stroke="#4f46e5" stroke-width="2" fill="none"/>
  <polygon points="245,90 237,86 237,94" fill="#4f46e5"/>

  <rect x="245" y="60" width="170" height="60" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="330" y="84" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">age &lt; max-age ?</text>
  <text x="330" y="104" text-anchor="middle" fill="#1e293b" font-size="11">freshness check</text>
  <path d="M330 120 L330 165" stroke="#16a34a" stroke-width="2" fill="none"/>
  <polygon points="330,165 326,157 334,157" fill="#16a34a"/>
  <text x="345" y="146" fill="#16a34a" font-size="11" font-weight="700">FRESH</text>

  <rect x="215" y="165" width="230" height="52" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="330" y="187" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">serve from cache, 0 RTT</text>
  <text x="330" y="205" text-anchor="middle" fill="#1e293b" font-size="11">origin never contacted</text>

  <path d="M415 90 L490 90" stroke="#d97706" stroke-width="2" fill="none"/>
  <polygon points="490,90 482,86 482,94" fill="#d97706"/>
  <text x="452" y="82" text-anchor="middle" fill="#d97706" font-size="11" font-weight="700">STALE</text>

  <rect x="490" y="60" width="230" height="60" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="605" y="84" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">GET /orders/42</text>
  <text x="605" y="104" text-anchor="middle" fill="#1e293b" font-size="11">If-None-Match: "a1b2c3"</text>
  <path d="M605 120 L605 160" stroke="#0ea5e9" stroke-width="2" fill="none"/>
  <polygon points="605,160 601,152 609,152" fill="#0ea5e9"/>

  <rect x="490" y="160" width="230" height="58" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="605" y="183" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Origin compares validator</text>
  <text x="605" y="202" text-anchor="middle" fill="#1e293b" font-size="11">hash / row version lookup</text>

  <rect x="490" y="242" width="110" height="60" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="545" y="266" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">304</text>
  <text x="545" y="285" text-anchor="middle" fill="#1e293b" font-size="10">no body, ~200 B</text>

  <rect x="612" y="242" width="108" height="60" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="666" y="266" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">200 OK</text>
  <text x="666" y="285" text-anchor="middle" fill="#1e293b" font-size="10">body + new ETag</text>

  <path d="M580 218 L552 240" stroke="#16a34a" stroke-width="2" fill="none"/>
  <polygon points="552,240 560,237 556,232" fill="#16a34a"/>
  <path d="M632 218 L658 240" stroke="#d97706" stroke-width="2" fill="none"/>
  <polygon points="658,240 650,233 654,238" fill="#d97706"/>

  <text x="40" y="290" fill="#1e293b" font-size="11" font-weight="700">Freshness saves the round trip.</text>
  <text x="40" y="308" fill="#1e293b" font-size="11" font-weight="700">Validation saves only the body.</text>
</svg>
```

## 4. Architecture & Workflow

Here is the full path of a cacheable `GET /v1/catalog/products?category=lenses` through a browser, a CDN, an API gateway, and the origin service.

1. **Client lookup.** The HTTP client computes a cache key (method + absolute URI + `Vary` headers) and finds a stored response with `max-age=30, Age=12`. It is fresh; the request never leaves the process. Latency ≈ 0.2 ms.
2. **Stale copy, conditional request.** Thirty seconds later the same call finds the entry stale. The client re-issues the request with `If-None-Match: "sha256:9f2c…"` copied from the stored `ETag`.
3. **CDN edge.** The request lands at the nearest PoP. The edge has its own copy governed by `s-maxage=60`. If the edge copy is fresh it answers `200 OK` with `Age: 41` **and the same ETag** — but because the client sent `If-None-Match` and the ETag matches, the edge is entitled to collapse this to `304 Not Modified`. Latency ≈ 8 ms, zero origin traffic.
4. **Edge miss + request collapsing.** On a cold edge, the PoP forwards to the shield/origin. A good CDN performs **request collapsing**: 4,000 simultaneous misses for the same key become one origin fetch, and the rest wait. This is your stampede protection.
5. **API gateway.** The gateway strips cache-busting query params it knows are irrelevant (`utm_*`), enforces auth, and forwards. Note the ordering constraint: **authorization must happen before cache lookup for private data**, otherwise the edge becomes an authorization bypass.
6. **Origin service — cheap validator path.** The handler first resolves the resource's version (`SELECT version, updated_at FROM products WHERE …`, or a Redis `GET etag:products:lenses`). If the client's `If-None-Match` matches, it returns `304` immediately, *without* running the expensive aggregation or serializing 12 KB of JSON.
7. **Origin service — full path.** On a mismatch it executes the query, serializes, computes the new ETag over the response bytes, and returns `200 OK` with `ETag`, `Cache-Control: public, max-age=30, s-maxage=60, stale-while-revalidate=120`, and `Vary: Accept-Encoding`.
8. **Downstream storage.** The edge stores under its key; the client stores under its key. `Age` starts ticking at the edge.
9. **Write-through invalidation.** When an admin `PATCH`es a product, the service bumps the row version, deletes the Redis validator entry, and issues a **surrogate-key purge** to the CDN (`Surrogate-Key: product-88 category-lenses`). The next read repopulates. This is what makes long `s-maxage` values safe.
10. **Stale-while-revalidate window.** If the object goes stale during a traffic spike, the edge serves the stale copy instantly and refreshes in the background, so p99 never sees the origin's cold-path latency.

> **Note:** Steps 6 and 9 are the two that teams skip. Without the cheap validator path you save bandwidth but not CPU. Without purge-on-write you are forced into TTLs so short that the cache stops mattering.

```svg
<svg viewBox="0 0 780 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="8" y="8" width="764" height="364" rx="14" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="390" y="36" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Cache topology: client &#8594; CDN edge &#8594; gateway &#8594; origin</text>

  <rect x="28" y="70" width="120" height="86" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="88" y="98" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Client</text>
  <text x="88" y="118" text-anchor="middle" fill="#1e293b" font-size="10">private cache</text>
  <text x="88" y="134" text-anchor="middle" fill="#1e293b" font-size="10">max-age=30</text>

  <rect x="198" y="70" width="140" height="86" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="268" y="98" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">CDN edge</text>
  <text x="268" y="118" text-anchor="middle" fill="#1e293b" font-size="10">shared cache</text>
  <text x="268" y="134" text-anchor="middle" fill="#1e293b" font-size="10">s-maxage=60</text>

  <rect x="388" y="70" width="140" height="86" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="458" y="98" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">API gateway</text>
  <text x="458" y="118" text-anchor="middle" fill="#1e293b" font-size="10">authN / authZ</text>
  <text x="458" y="134" text-anchor="middle" fill="#1e293b" font-size="10">key normalization</text>

  <rect x="578" y="70" width="166" height="86" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="661" y="98" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Origin service</text>
  <text x="661" y="118" text-anchor="middle" fill="#1e293b" font-size="10">validator lookup first</text>
  <text x="661" y="134" text-anchor="middle" fill="#1e293b" font-size="10">then full render</text>

  <path d="M148 100 L196 100" stroke="#4f46e5" stroke-width="2" fill="none"/>
  <polygon points="196,100 188,96 188,104" fill="#4f46e5"/>
  <path d="M338 100 L386 100" stroke="#4f46e5" stroke-width="2" fill="none"/>
  <polygon points="386,100 378,96 378,104" fill="#4f46e5"/>
  <path d="M528 100 L576 100" stroke="#4f46e5" stroke-width="2" fill="none"/>
  <polygon points="576,100 568,96 568,104" fill="#4f46e5"/>

  <path d="M576 140 L530 140" stroke="#16a34a" stroke-width="2" fill="none"/>
  <polygon points="530,140 538,136 538,144" fill="#16a34a"/>
  <path d="M386 140 L340 140" stroke="#16a34a" stroke-width="2" fill="none"/>
  <polygon points="340,140 348,136 348,144" fill="#16a34a"/>
  <path d="M196 140 L150 140" stroke="#16a34a" stroke-width="2" fill="none"/>
  <polygon points="150,140 158,136 158,144" fill="#16a34a"/>

  <rect x="28" y="192" width="716" height="70" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="44" y="216" fill="#1e293b" font-size="12" font-weight="700">Hit ladder (cheapest first)</text>
  <text x="44" y="238" fill="#1e293b" font-size="11">1. client fresh &#8594; 0 RTT &#8226; 2. edge fresh &#8594; 1 short RTT &#8226; 3. edge 304 &#8594; no body</text>
  <text x="44" y="254" fill="#1e293b" font-size="11">4. origin 304 &#8594; no render &#8226; 5. origin 200 &#8594; full cost. Optimize toward the top.</text>

  <rect x="28" y="282" width="350" height="76" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="44" y="306" fill="#1e293b" font-size="12" font-weight="700">Write path invalidation</text>
  <text x="44" y="330" fill="#1e293b" font-size="11">PATCH &#8594; bump version &#8594; purge Surrogate-Key</text>

  <rect x="394" y="282" width="350" height="76" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="410" y="306" fill="#1e293b" font-size="12" font-weight="700">Stampede control</text>
  <text x="410" y="330" fill="#1e293b" font-size="11">collapsing + jittered TTL + stale-while-revalidate</text>
</svg>
```

## 5. Implementation

### The raw exchange

First request — full response with a validator:

```http
GET /v1/catalog/products?category=lenses HTTP/1.1
Host: api.zariya.in
Accept: application/json
Accept-Encoding: br, gzip
```

```http
HTTP/1.1 200 OK
Date: Tue, 22 Jul 2026 09:14:03 GMT
Content-Type: application/json; charset=utf-8
Content-Encoding: br
Content-Length: 3187
ETag: "sha256:9f2c41b7de0a8e35"
Last-Modified: Tue, 22 Jul 2026 08:57:11 GMT
Cache-Control: public, max-age=30, s-maxage=60, stale-while-revalidate=120
Vary: Accept-Encoding
Surrogate-Key: catalog category-lenses

{"data":[{"id":"prd_88","name":"50mm f/1.8","price_inr":1299000}], "next_cursor":null}
```

Second request after the freshness window:

```http
GET /v1/catalog/products?category=lenses HTTP/1.1
Host: api.zariya.in
If-None-Match: "sha256:9f2c41b7de0a8e35"
Accept-Encoding: br, gzip
```

```http
HTTP/1.1 304 Not Modified
Date: Tue, 22 Jul 2026 09:15:44 GMT
ETag: "sha256:9f2c41b7de0a8e35"
Cache-Control: public, max-age=30, s-maxage=60, stale-while-revalidate=120
Age: 41
Vary: Accept-Encoding
```

Note what a `304` must carry: the same `ETag`, updated `Cache-Control`/`Expires` if they changed, and `Vary`. It must **not** carry a body or `Content-Length` describing one.

### curl

```bash
# See the validator, then replay it conditionally and measure the saving.
curl -sD - -o /dev/null 'https://api.zariya.in/v1/catalog/products?category=lenses'
curl -s -o /dev/null -w 'status=%{http_code} bytes=%{size_download} t=%{time_total}\n' \
  -H 'If-None-Match: "sha256:9f2c41b7de0a8e35"' \
  'https://api.zariya.in/v1/catalog/products?category=lenses'
```

### FastAPI: the cheap-validator pattern

The important detail is that we resolve the ETag from a version counter *before* doing any expensive work, and only serialize on a miss.

```python
import json
from fastapi import APIRouter, Request, Response

router = APIRouter()
CC = "public, max-age=30, s-maxage=60, stale-while-revalidate=120"


def etag_matches(header: str | None, current: str) -> bool:
    """RFC 9110 §13.1.2: If-None-Match is a comma list, or '*'."""
    if not header:
        return False
    if header.strip() == "*":
        return True
    norm = lambda t: t[2:] if t.startswith("W/") else t   # weak comparison
    return norm(current) in {norm(c.strip()) for c in header.split(",")}


def cache_headers(etag: str) -> dict[str, str]:
    return {"ETag": etag, "Cache-Control": CC, "Vary": "Accept-Encoding"}


@router.get("/v1/catalog/products")
async def list_products(request: Request, category: str, db=None, cache=None):
    # 1. Cheap: a monotonic version bumped on every write to this collection.
    version = await cache.get(f"catalog:{category}:version") or "0"
    candidate = f'W/"v{version}"'

    if etag_matches(request.headers.get("if-none-match"), candidate):
        # No DB query, no serialization, no compression. ~0.4 ms.
        return Response(status_code=304, headers=cache_headers(candidate))

    rows = await db.fetch_products(category=category)          # expensive path
    body = json.dumps({"data": rows, "next_cursor": None},
                      separators=(",", ":")).encode()
    return Response(content=body, media_type="application/json",
                    headers=cache_headers(candidate)
                    | {"Surrogate-Key": f"catalog category-{category}"})


@router.patch("/v1/catalog/products/{product_id}")
async def update_product(product_id: str, patch: dict, db=None, cache=None, cdn=None):
    product = await db.update_product(product_id, patch)
    # Invalidate: bump the version, then purge the edge by surrogate key.
    await cache.incr(f"catalog:{product['category']}:version")
    await cdn.purge_surrogate_keys([f"product-{product_id}",
                                    f"category-{product['category']}"])
    return product
```

> **Note:** Do not use FastAPI's default `JSONResponse` when you need a byte-stable ETag — key ordering and separator choices must be deterministic across processes and Python versions, so serialize explicitly with fixed `separators` and `sort_keys` if your data is a dict.

### Node/Express with a conditional short-circuit

```javascript
const app = express();
app.set("etag", false); // Express's default ETag runs AFTER rendering — we want before.

app.get("/v1/catalog/products", async (req, res) => {
  const version = (await redis.get(`catalog:${req.query.category}:version`)) ?? "0";
  const etag = `W/"v${version}"`;
  res.set({ ETag: etag, Vary: "Accept-Encoding",
    "Cache-Control": "public, max-age=30, s-maxage=60, stale-while-revalidate=120" });

  if (req.headers["if-none-match"]?.split(",").some(t => t.trim() === etag))
    return res.status(304).end();

  res.json({ data: await db.products(req.query.category), next_cursor: null });
});
```

### OpenAPI 3.1 fragment

```yaml
paths:
  /v1/catalog/products:
    get:
      operationId: listProducts
      parameters:
        - name: If-None-Match
          in: header
          required: false
          schema: { type: string }
          description: Validator from a prior response; yields 304 when unchanged.
      responses:
        "200":
          description: Product collection
          headers:
            ETag: { schema: { type: string }, description: Weak collection validator }
            Cache-Control:
              schema: { type: string }
              example: public, max-age=30, s-maxage=60, stale-while-revalidate=120
            Vary: { schema: { type: string }, example: Accept-Encoding }
          content:
            application/json:
              schema: { $ref: "#/components/schemas/ProductPage" }
        "304":
          description: Client's cached representation is still valid. No body.
          headers:
            ETag: { schema: { type: string } }
            Cache-Control: { schema: { type: string } }
```

### Optimization note

Three measurable wins, in order of payoff. **(1) Short-circuit before rendering** — a `304` that still runs the query and serializer saves bandwidth only; moving the validator check ahead of serialization dropped p50 on the conditional path from 38 ms to 0.6 ms on a service we profiled. **(2) Jitter your TTLs** — 50,000 objects written at deploy time with `max-age=300` all expire in the same second, so use `max-age = base + rand(0, base * 0.2)`. **(3) Never compute a strong ETag over a compressed body** — the same resource gzipped and brotlied are different representations, so hash the *uncompressed* bytes and mark the validator weak, or hash per-encoding and send `Vary: Accept-Encoding` (which you need anyway).

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost/Trade-off |
|---|---|---|
| Freshness (`max-age`) | Eliminates the round trip entirely; the cheapest possible response | Clients can serve data up to `max-age` seconds stale, and you cannot recall it once sent |
| Validation (`ETag`) | Zero staleness risk with ~95% bandwidth saving | Still costs a full RTT per read; the origin must be reachable |
| Strong ETag (body hash) | Always correct; supports byte ranges | Requires serializing the response to compute it, so it saves bytes but not CPU |
| Weak ETag (row version) | Computable before any expensive work; saves CPU too | Cannot be used for `Range` requests; must be diligently bumped on every write path |
| `s-maxage` at a CDN | Collapses thousands of requests to one origin fetch; global latency drop | A stale edge object is invisible to you until a user complains; needs purge tooling |
| `stale-while-revalidate` | Removes the latency cliff at TTL expiry | Users can see data older than `max-age`; unacceptable for balances or inventory counts |
| `Vary` on negotiated headers | Correctness for compression and i18n | Each distinct header value multiplies cache entries and dilutes hit ratio |
| Surrogate-key purge | Lets you run long TTLs safely | Extra infrastructure, tag bookkeeping, and a new failure mode (purge storms) |

## 7. Common Mistakes & Best Practices

1. ⚠️ Returning `Cache-Control: no-cache` believing it means "do not cache" → ✅ `no-cache` means *revalidate before reuse*; use `no-store` when the data must never be written down, and `no-cache, private` for authenticated-but-revalidatable resources.
2. ⚠️ Serving user-specific data with `public, max-age=60` behind a shared CDN → ✅ any response whose body depends on `Authorization` or a session cookie must be `private` (or `no-store`). This is a real cross-tenant data-leak class, not a theoretical one.
3. ⚠️ Computing the ETag after rendering, then returning `304` → ✅ derive the validator from a version column or a cached digest so the conditional path skips the query and the serializer entirely.
4. ⚠️ ETags that change on every request because you hash a payload containing `"generated_at": now()` or a randomized key order → ✅ exclude volatile fields from the hashed bytes and serialize deterministically; a validator that never matches is worse than none.
5. ⚠️ Sending `200 OK` with an error body and caching it → ✅ use real status codes (`4xx`/`5xx`); remember `404` is cacheable by default, so send `Cache-Control: no-store` on error responses you do not want pinned at the edge.
6. ⚠️ Long `s-maxage` with no invalidation mechanism → ✅ pair every long TTL with surrogate-key purge on the write path, or keep the TTL short enough that the worst-case staleness is a product-acceptable number.
7. ⚠️ Forgetting `Vary: Accept-Encoding` while serving brotli and gzip → ✅ a proxy will hand a brotli body to a client that only accepts gzip; always vary on the headers that actually change the bytes.
8. ⚠️ Uniform TTLs causing a synchronized expiry stampede → ✅ jitter TTLs and enable request collapsing at the edge; add `stale-while-revalidate` so the refresh happens off the critical path.
9. ⚠️ Cache keys that include tracking query parameters (`utm_source`, `fbclid`) → ✅ normalize/strip irrelevant params at the gateway or CDN so one logical resource is not fragmented into thousands of entries.
10. ⚠️ Assuming `PUT` to `/orders/42` invalidates `/orders` → ✅ unsafe methods invalidate only the target URI; collection endpoints need their own explicit invalidation.
11. ⚠️ Using `Last-Modified` alone for fast-changing resources → ✅ its one-second granularity cannot distinguish two writes in the same second; prefer `ETag` and send `Last-Modified` as a secondary hint. Also verify with `curl -D -` in production that no proxy is stripping `ETag` during re-compression.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** The first question is always "where did this response come from?" Read `Age` (nonzero means it came from a cache), the CDN's own `X-Cache: HIT/MISS` or `CF-Cache-Status`, and `Date`. Reproduce with `curl -sD - -o /dev/null` and compare a cold request (`Cache-Control: no-cache` on the *request*) against a warm one. When a client "won't stop seeing old data," check in order: (1) is the client's `max-age` too long? (2) did the edge purge actually fire, and did it return 200? (3) is your ETag being bumped on *every* write path including admin tools and background jobs? (4) is an intermediate proxy rewriting `Cache-Control`? For `Vary` bugs, dump the full request headers of a failing and a working client side by side — the difference is almost always `Accept-Encoding` or `Accept-Language`.

**Monitoring.** Track these as first-class SLIs: **edge hit ratio** (`hits / (hits + misses)`, target ≥ 85% for public content), **origin offload** (fraction of total requests never reaching origin), **304 ratio** on conditional-capable endpoints, **byte offload** (usually higher than request offload, since misses skew to large objects), and **p99 revalidation latency**. Emit a per-route counter labelled `cache_result={fresh,revalidated_304,miss}`. Alert on a *drop* in hit ratio — it is the earliest signal that someone shipped a cache-busting query param or a `Vary` on a high-cardinality header. Also alert on purge failure rate; silent purge failures produce stale data that no dashboard shows.

**Security.** Cache poisoning is the headline risk: if an unkeyed input (a header like `X-Forwarded-Host` reflected into the response) influences the body but not the cache key, an attacker can store a malicious response for every subsequent user. Defenses: never reflect unvalidated request headers into responses, keep the cache key aligned with everything that affects the body, and set `Cache-Control: private, no-store` on anything authenticated. The mirror-image risk is **cache deception** — an attacker tricks a user into requesting `/account/settings.css`, the CDN caches it as a static asset by extension, and the attacker then fetches the victim's data from the edge; defend by keying on the origin's actual `Content-Type` and never caching on file extension alone. Also: `Authorization`-bearing requests are not stored by shared caches by default per RFC 9111 unless you explicitly opt in with `public` or `s-maxage` — do not opt in casually.

**Performance & scaling.** Cache in layers, and make each layer cheaper than the one below: client memory → client disk → CDN edge → CDN shield → gateway → origin in-process LRU → Redis → database. Enable request collapsing at the edge and shield tier so a cold cache cannot become a thundering herd. For write-heavy tenants, prefer short `max-age` + validators over long TTLs; for public catalog and reference data, prefer long `s-maxage` + surrogate-key purge. Measure the CPU cost of ETag computation on your hottest endpoint — if hashing 400 KB responses shows up in profiles, switch that route to a version-derived weak validator.

## 9. Interview Questions

**Q: What is the difference between `no-cache` and `no-store`?**
A: `no-cache` permits storage but requires the cache to revalidate with the origin before every reuse, so you get bandwidth savings via `304` with zero staleness. `no-store` forbids writing the response to any storage at all and is the correct directive for sensitive data like payment details. They are frequently confused because the name `no-cache` implies the behavior of `no-store`.

**Q: How does a conditional request with `If-None-Match` work end to end?**
A: The server sends an `ETag` with the original `200`. The client stores it and, on a subsequent request for the same URI, sends `If-None-Match: "<etag>"`. The server compares that against the current representation's validator; if it matches, it returns `304 Not Modified` with headers and no body, and the client reuses its stored copy. If it does not match, the server returns a fresh `200` with a new `ETag`.

**Q: When would you use a weak ETag instead of a strong one?**
A: Use a weak ETag (`W/"v42"`) when you can derive it cheaply from a version counter or `updated_at` rather than hashing the rendered body — that lets you answer conditional requests without doing the expensive work. The cost is that weak validators cannot be used for `Range` requests and only assert semantic equivalence, not byte equality.

**Q: Which HTTP status codes are cacheable by default, and why does that matter?**
A: RFC 9110 lists `200`, `203`, `204`, `206`, `300`, `301`, `308`, `404`, `405`, `410`, `414`, and `501` as heuristically cacheable. The one that bites people is `404` — a transient deploy gap that 404s a real resource can get stored and served for the full heuristic lifetime, so error responses you do not want pinned should carry explicit `Cache-Control: no-store`.

**Q: What does `Vary` do, and what is the danger of setting it wrong?**
A: `Vary` lists request headers that must match for a stored response to be reused, effectively extending the cache key. Setting it too narrowly causes correctness bugs (serving brotli to a gzip-only client); setting it on a high-cardinality header like `User-Agent` or `Cookie` fragments the cache so badly that the hit ratio collapses to near zero.

**Q: How do `max-age` and `s-maxage` interact?**
A: `s-maxage` applies only to shared caches (CDNs, reverse proxies) and overrides `max-age` for them; private client caches ignore it. This lets you say "browsers may hold this for 5 seconds, but the CDN may hold it for 5 minutes," which is usually the right shape because the CDN is the layer you can purge.

**Q: A client complains it keeps seeing data 10 minutes old. Walk through your diagnosis.**
A: Check `Age` and the CDN's cache-status header to identify which layer served it, confirm the response's effective `Cache-Control`, then verify the write path actually bumps the validator and issues a purge. The most common root cause is a write path — an admin tool, a bulk importer, a background job — that updates the database without touching the version counter or firing the purge.

**Q: (Senior) How would you design caching for a multi-tenant API where responses are user-specific but read volume is enormous?**
A: Do not put user-specific bodies in a shared cache. Instead use `Cache-Control: private, no-cache` plus a cheap per-user validator so repeat reads cost a `304` rather than a render, and push the shared caching down to the *components* — cache the tenant-agnostic reference data at the edge and compose per-user responses from cached fragments at the origin. If you genuinely must cache per-user at the edge, key on a tenant-scoped path segment or a signed edge token rather than `Vary: Authorization`, and make sure authorization runs before the cache lookup.

**Q: (Senior) What is HTTP cache poisoning and how do you prevent it?**
A: Cache poisoning happens when an input that influences the response body is not part of the cache key — classically a reflected header like `X-Forwarded-Host` or an unkeyed query parameter — letting an attacker store a malicious response that is then served to every subsequent user. Prevention is to keep the cache key a superset of everything that can affect the body, never reflect unvalidated request data into responses or headers, normalize/strip unknown headers at the edge, and mark authenticated responses `private, no-store`.

**Q: (Senior) You need a five-minute CDN TTL but data must never be more than a few seconds stale after a write. How?**
A: Use a long `s-maxage` combined with **event-driven invalidation**: tag every response with surrogate keys, and on every write path publish a purge for the affected keys so the edge drops the object within a second or two. Add `stale-while-revalidate` so the post-purge refill does not create a latency cliff, and make the purge path idempotent and retried, with alerting on purge failures — a silently failed purge is indistinguishable from a working cache until a customer notices.

**Q: (Senior) How do you prevent a cache stampede when a popular object expires?**
A: Three complementary controls: enable **request collapsing** at the edge and shield tiers so concurrent misses become one origin fetch; **jitter TTLs** so objects written together do not expire together; and use **`stale-while-revalidate`** (or an origin-side probabilistic early refresh, where the chance of refreshing rises as the object approaches expiry) so the refill happens in the background while users keep getting the stale copy.

**Q: Why should `PATCH`ing `/products/88` not automatically make `/products?category=lenses` fresh again, and what do you do about it?**
A: HTTP only invalidates the cached entry for the exact target URI of the unsafe request, so collection and search endpoints keep serving their stale copies. You handle it explicitly — bump a collection-level version counter or purge a `category-lenses` surrogate key from the write handler — because the protocol will not do it for you.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** HTTP caching has two independent mechanisms. *Freshness* (`max-age`, `s-maxage`, `Expires`) lets a cache reuse a copy with no network call at all; *validation* (`ETag`/`Last-Modified` answered by `If-None-Match`/`If-Modified-Since`) lets a cache confirm a stale copy for the price of one RTT and a `304 Not Modified` with no body. `no-cache` means "revalidate every time," `no-store` means "never write it down," `private` means "browsers only, never a CDN." Derive ETags from a cheap version counter so the conditional path skips your query and serializer, not just the network. Set `Vary` on exactly the headers that change the bytes — usually `Accept-Encoding` — and never on `Cookie` or `Authorization`. Pair long CDN TTLs with surrogate-key purges on every write path, jitter your TTLs, and enable request collapsing. Read RFC 9111 for caching and RFC 9110 for conditional-request semantics; everything older is folklore.

| Header / directive | Meaning | Typical API use |
|---|---|---|
| `no-store` | Never persist anywhere | Payment, auth, PII responses |
| `no-cache` | Store but always revalidate | Authenticated resources with ETags |
| `private` | Client caches only, never shared | Per-user responses |
| `public, max-age=N` | Fresh for N seconds anywhere | Public reference data |
| `s-maxage=N` | Shared-cache freshness, overrides `max-age` | CDN TTL for catalog endpoints |
| `stale-while-revalidate=N` | Serve stale for N s while refreshing | Smoothing TTL-expiry latency spikes |
| `ETag: "…"` / `W/"…"` | Strong / weak validator | Every cacheable `GET` |
| `If-None-Match` / `If-Match` | Conditional read / conditional write | `304` on reads, `412` on writes |
| `Vary: Accept-Encoding` | Extends the cache key | Any compressed response |
| `Age: N` | Seconds spent in caches | Proof a cache served it |
| `304 Not Modified` | Validator matched | Headers only, no body |

**Flash cards**

- **`no-cache` vs `no-store`** → `no-cache` = store but revalidate every time; `no-store` = never write it down at all.
- **What must a `304` include?** → The `ETag`, plus any `Cache-Control`/`Expires`/`Vary` that would have been sent with a `200`. Never a body.
- **Strong vs weak ETag** → Strong asserts byte equality (usable for `Range`); weak (`W/`) asserts semantic equivalence and is cheap to derive from a version.
- **When does `s-maxage` win?** → Only in shared caches (CDN/proxy); it overrides `max-age` there and is ignored by browsers.
- **Cheapest possible cache hit** → Client-side freshness: zero network, zero origin CPU. Everything else costs at least one RTT.

## 11. Hands-On Exercises & Mini Project

- [ ] Take any `GET` endpoint you own, add a body-hash `ETag`, and measure with `curl -w '%{size_download} %{time_total}'` how many bytes and milliseconds a `304` saves versus the `200`.
- [ ] Convert that strong ETag to a version-derived weak ETag and move the comparison *before* the database query. Profile the conditional path again — you should now see CPU savings, not just bandwidth.
- [ ] Deliberately break it: add `"generated_at": datetime.utcnow()` to the payload and observe that the ETag never matches. Then fix it by excluding volatile fields from the hashed bytes.
- [ ] Set `Vary: User-Agent` on a busy endpoint in a staging CDN, record the hit-ratio collapse, and revert. This is the fastest way to internalize why `Vary` cardinality matters.
- [ ] Write a test asserting that a `PATCH` to a resource changes the *collection* endpoint's ETag. Most codebases fail it on first run.

### Mini Project — A cache-aware catalog service

**Goal.** Build a small FastAPI (or Express) service that serves a product catalog with a correct, measurable caching layer in front of it.

**Requirements.**
1. `GET /v1/products` and `GET /v1/products/{id}` return `ETag`, `Cache-Control: public, max-age=30, s-maxage=120, stale-while-revalidate=60`, and `Vary: Accept-Encoding`.
2. Both endpoints answer `If-None-Match` with `304` **without** querying the database — use a Redis-backed version counter per collection and per item.
3. `PATCH /v1/products/{id}` bumps both the item version and its collection version, and logs a simulated surrogate-key purge.
4. Authenticated endpoint `GET /v1/me/orders` must be `private, no-cache` with a per-user validator, plus a test proving a shared cache would never store it.
5. Expose `/metrics` with `cache_result={fresh,revalidated,miss}` counters per route, and ship a `k6`/`hey` script that reports the 304 ratio and bytes saved.

**Extensions.**
- Put a real reverse proxy (Varnish, nginx `proxy_cache`, or Caddy) in front and verify `Age`, `X-Cache`, and request collapsing behave as documented.
- Implement probabilistic early expiration (XFetch) at the origin and show it removes the p99 spike at TTL boundaries.
- Add a deliberately unkeyed reflected header, demonstrate cache poisoning against your own proxy, then fix it and write the regression test.

## 12. Related Topics & Free Learning Resources

**Related chapters.** *Payload Optimization, HTTP/2 & HTTP/3* (chapter 26) — compression and `Vary: Accept-Encoding` interact directly with cache keys. *Idempotency Keys & Safe Retries* (chapter 27) — the write-path counterpart to conditional reads. *Concurrency Control & Optimistic Locking* (chapter 28) — reuses the same `ETag` validator with `If-Match` instead of `If-None-Match`. *Pagination & Filtering* — cursor pages are far more cacheable than offset pages. *API Gateways & Rate Limiting* — where cache-key normalization and purge fan-out usually live.

- **RFC 9111 — HTTP Caching** — IETF · *Advanced* · the normative source for freshness calculation, directives, and cache behavior; short enough to read in one sitting and it settles every `no-cache` argument. <https://www.rfc-editor.org/rfc/rfc9111.html>
- **RFC 9110 — HTTP Semantics** — IETF · *Advanced* · defines validators, conditional requests, and which methods/statuses are cacheable; §8.8 and §13 are the sections you want. <https://www.rfc-editor.org/rfc/rfc9110.html>
- **MDN — HTTP Caching** — Mozilla · *Beginner* · the clearest prose explanation of `Cache-Control` directives with correct, modern advice and worked examples. <https://developer.mozilla.org/en-US/docs/Web/HTTP/Caching>
- **MDN — HTTP Conditional Requests** — Mozilla · *Intermediate* · walks through `If-None-Match`, `If-Match`, and `304`/`412` semantics with request/response transcripts. <https://developer.mozilla.org/en-US/docs/Web/HTTP/Conditional_requests>
- **web.dev — HTTP Caching** — Google · *Intermediate* · practical decision tree for choosing directives, plus the versioned-URL vs revalidation trade-off explained with real numbers. <https://web.dev/articles/http-cache>
- **GitHub REST API — Conditional Requests** — GitHub · *Intermediate* · a production API that documents ETag usage and exempts `304`s from rate limits; the canonical example of incentive-aligned caching. <https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api>
- **Practical Web Cache Poisoning** — PortSwigger Research · *Advanced* · James Kettle's research showing how unkeyed inputs turn caches into attack surface; read before enabling any shared cache. <https://portswigger.net/research/practical-web-cache-poisoning>
- **RFC 5861 — stale-while-revalidate / stale-if-error** — IETF · *Intermediate* · three pages that explain the two extensions responsible for most real-world CDN latency wins. <https://www.rfc-editor.org/rfc/rfc5861.html>

---

*REST API Handbook — chapter 25.*
