# 26 · Payload Optimization, HTTP/2 & HTTP/3

> **In one line:** Most API latency is bytes and round trips, not CPU — shrink the payload with compression and response shaping, then let HTTP/2 multiplexing and HTTP/3's QUIC transport remove the round trips that remain.

---

## 1. Overview

API latency has three components: the time the server spends thinking, the time the bytes spend on the wire, and the number of round trips the protocol forces before those bytes can flow. Teams instrument the first obsessively and ignore the other two. Yet for a mobile client on a 120 ms RTT link, a 180 KB JSON response over HTTP/1.1 with a cold TCP+TLS connection costs roughly 400 ms of pure protocol overhead before your handler has produced a single byte. Payload optimization and protocol choice are where that time actually goes.

The problem this chapter solves is that **REST over HTTP/1.1 was structurally bad at concurrency.** HTTP/1.1 allows one in-flight request per connection (pipelining exists on paper and is disabled everywhere because of head-of-line blocking), so browsers opened 6 connections per origin and API clients invented batching endpoints and `?include=` graph parameters to work around the limit. Every one of those workarounds is a design compromise forced by a transport limitation.

**HTTP/2 (RFC 9113, originally RFC 7540, derived from Google's SPDY)** fixed it by introducing binary framing, **multiplexing** many logical streams over one TCP connection, per-stream flow control, and **HPACK** header compression that removes the repeated 800-byte header blocks that dominate small API responses. **HTTP/3 (RFC 9114)** goes further: it replaces TCP with **QUIC (RFC 9000)**, a UDP-based transport with per-stream loss recovery, so a dropped packet on stream 3 no longer stalls streams 1, 2, and 4. QUIC also folds the TLS handshake into the transport handshake — 1-RTT connection setup, or 0-RTT on resumption.

On the payload side the lever is compression. **gzip** (DEFLATE, RFC 1952) has been ubiquitous since 1999. **Brotli** (RFC 7932, Google, 2016) typically beats gzip by 15–25% on JSON at comparable CPU cost, and **Zstandard** (RFC 8878, `Content-Encoding: zstd`) offers similar ratios at markedly higher throughput. JSON is exceptionally compressible — highly repetitive key names and structural punctuation — so a 180 KB response routinely lands around 12–18 KB with Brotli at quality 5.

**Concrete example.** Shopify's Storefront and Admin APIs, GitHub, and Stripe all negotiate compression by default and serve over HTTP/2 or HTTP/3 at the edge. Cloudflare reported that enabling Brotli cut JSON and HTML transfer sizes by roughly 15–20% versus gzip across its network, and its HTTP/3 rollout measurements showed meaningfully lower tail latency on lossy mobile networks — precisely where head-of-line blocking hurts most. The pattern is consistent: compression is the biggest single win, protocol upgrade is the second, and the two compound because HTTP/2's header compression only matters once your bodies are small.

The durable mental model: **bytes × round trips = latency.** Compression attacks bytes. Field selection and pagination attack bytes. HTTP/2 multiplexing attacks round trips caused by connection limits. HTTP/3 attacks round trips caused by handshakes and packet loss. Nothing here changes your resource model — that is the point.

## 2. Core Concepts

- **`Content-Encoding`** — a transformation applied to the *representation* body (`gzip`, `br`, `zstd`); the client negotiates it with `Accept-Encoding` and the server must send `Vary: Accept-Encoding`.
- **`Transfer-Encoding: chunked`** — a hop-by-hop framing that lets a server stream a body of unknown length; distinct from `Content-Encoding` and absent in HTTP/2 and HTTP/3, which frame natively.
- **Brotli quality levels** — 0–11; levels 4–6 are the practical range for dynamic API responses (11 is for pre-compressed static assets and is far too slow per request).
- **Multiplexing** — many concurrent request/response streams interleaved as frames over a single connection, eliminating HTTP/1.1's one-at-a-time constraint.
- **HPACK / QPACK** — header compression for HTTP/2 and HTTP/3 respectively; both use a shared dynamic table so repeated headers cost a few bytes instead of hundreds.
- **Head-of-line (HOL) blocking** — a stalled unit blocks everything behind it; HTTP/1.1 blocks at the request level, HTTP/2 blocks at the TCP level on packet loss, HTTP/3 eliminates transport-level HOL.
- **QUIC** — a UDP-based transport with built-in TLS 1.3, per-stream ordering, connection migration across network changes, and 0-RTT resumption.
- **Sparse fieldsets** — a query parameter (`?fields=id,name,price`) letting clients request only the attributes they need, cutting payload at the source rather than compressing waste.
- **Connection coalescing** — HTTP/2 clients reuse one connection for multiple hostnames covered by the same certificate, saving handshakes.
- **`Content-Length` vs streaming** — a known length enables progress bars and better buffer sizing; streaming trades that for lower time-to-first-byte.

## 3. Theory & Principles

**Where the milliseconds actually are.** A single HTTP/1.1 request on a fresh connection costs: DNS (0–1 RTT) + TCP handshake (1 RTT) + TLS 1.3 handshake (1 RTT) + request/response (1 RTT + transfer time). At 100 ms RTT that is ~300 ms before the first byte of your JSON. TLS 1.2 adds another RTT. QUIC collapses TCP+TLS into a single 1-RTT handshake, and 0-RTT on resumption sends application data in the very first flight. This is why protocol choice dominates for short-lived mobile sessions and matters little for a long-lived server-to-server connection pool.

**Transfer time.** `transfer_ms ≈ (bytes × 8) / bandwidth_bps × 1000`, but on a cold TCP connection the real constraint is **slow start**: the congestion window begins near 10 MSS ≈ 14 KB and doubles each RTT. A 14 KB response fits in the first flight; a 180 KB response takes roughly `ceil(log2(180/14)) ≈ 4` extra RTTs to drain. That single fact — *compress below the initial congestion window and you save entire round trips* — is the strongest argument for compression and is invisible in bandwidth-only reasoning.

**Compression trade-off curve.** For a representative 180 KB JSON catalog page:

| Encoding | Size | Ratio | Compress time | Notes |
|---|---|---|---|---|
| none | 180 KB | 1.0× | 0 ms | 4+ extra RTTs in slow start |
| gzip -6 | 19 KB | 9.5× | ~2.0 ms | universal support, safe default |
| br q4 | 17 KB | 10.6× | ~1.5 ms | faster *and* smaller than gzip -6 |
| br q5 | 15 KB | 12.0× | ~2.6 ms | best dynamic-content sweet spot |
| br q11 | 12 KB | 15.0× | ~180 ms | static assets only, never per request |
| zstd -3 | 16 KB | 11.3× | ~0.8 ms | highest throughput; growing support |

Two rules fall out. First, **do not compress below ~1 KB** — the encoding overhead plus CPU exceeds any saving, and for tiny bodies gzip can make the payload *larger*. Second, **never use maximum quality for dynamic responses**; br q11 on every request will melt your CPU budget for a 20% size gain over q5.

**Multiplexing changes what "optimal" means.** Under HTTP/1.1, six connections meant six concurrent requests, so coarse-grained endpoints that returned everything at once were faster than many small calls. Under HTTP/2 and HTTP/3, 100 concurrent small requests over one connection are cheap, so **fine-grained, individually cacheable resources become the better design** — each has its own ETag and its own TTL, and a change to one does not invalidate the rest. HTTP/2 does not make request count free (each still costs a server round trip through your stack), but it removes the connection-count penalty that made batching mandatory.

**Where HTTP/2 still hurts.** Because all streams share one TCP connection, a single lost packet stalls *every* stream until retransmission — TCP delivers bytes in order and cannot hand stream 5's data to the application while stream 3 has a gap. On a link with 2% loss this can make HTTP/2 slower than HTTP/1.1 with six connections. QUIC fixes exactly this: streams are independently ordered, so loss on one stream does not block the others. That is why HTTP/3's wins are concentrated on mobile and lossy networks, and are near-zero on a clean datacenter link.

```svg
<svg viewBox="0 0 780 350" width="100%" height="350" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="8" y="8" width="764" height="334" rx="14" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="390" y="36" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Head-of-line blocking across three protocol generations</text>

  <text x="30" y="72" fill="#1e293b" font-size="12" font-weight="700">HTTP/1.1 &#8212; one request per connection, serialized</text>
  <rect x="30" y="82" width="150" height="26" rx="5" fill="#fef3c7" stroke="#d97706"/>
  <text x="105" y="99" text-anchor="middle" fill="#1e293b" font-size="11">req A</text>
  <rect x="186" y="82" width="200" height="26" rx="5" fill="#fef3c7" stroke="#d97706"/>
  <text x="286" y="99" text-anchor="middle" fill="#1e293b" font-size="11">req B waits for A</text>
  <rect x="392" y="82" width="180" height="26" rx="5" fill="#fef3c7" stroke="#d97706"/>
  <text x="482" y="99" text-anchor="middle" fill="#1e293b" font-size="11">req C waits for B</text>
  <text x="600" y="99" fill="#d97706" font-size="11" font-weight="700">6 conns to fake it</text>

  <text x="30" y="146" fill="#1e293b" font-size="12" font-weight="700">HTTP/2 &#8212; multiplexed streams, but shared TCP ordering</text>
  <rect x="30" y="156" width="542" height="26" rx="5" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="90" y="173" fill="#1e293b" font-size="11">A</text>
  <text x="150" y="173" fill="#1e293b" font-size="11">B</text>
  <text x="210" y="173" fill="#1e293b" font-size="11">C</text>
  <text x="270" y="173" fill="#1e293b" font-size="11">A</text>
  <rect x="300" y="156" width="34" height="26" rx="5" fill="#fef3c7" stroke="#d97706"/>
  <text x="317" y="173" text-anchor="middle" fill="#1e293b" font-size="10" font-weight="700">LOST</text>
  <text x="360" y="173" fill="#1e293b" font-size="11">B, C stalled until retransmit</text>
  <text x="600" y="173" fill="#d97706" font-size="11" font-weight="700">TCP HOL blocking</text>

  <text x="30" y="220" fill="#1e293b" font-size="12" font-weight="700">HTTP/3 over QUIC &#8212; independently ordered streams</text>
  <rect x="30" y="230" width="542" height="26" rx="5" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="90" y="247" fill="#1e293b" font-size="11">A</text>
  <text x="150" y="247" fill="#1e293b" font-size="11">B</text>
  <text x="210" y="247" fill="#1e293b" font-size="11">C</text>
  <rect x="240" y="230" width="34" height="26" rx="5" fill="#fef3c7" stroke="#d97706"/>
  <text x="257" y="247" text-anchor="middle" fill="#1e293b" font-size="10" font-weight="700">LOST</text>
  <text x="300" y="247" fill="#1e293b" font-size="11">only stream A waits; B and C keep delivering</text>
  <text x="600" y="247" fill="#16a34a" font-size="11" font-weight="700">no transport HOL</text>

  <rect x="30" y="278" width="716" height="52" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="46" y="299" fill="#1e293b" font-size="11" font-weight="700">Handshake cost: HTTP/1.1+TLS1.3 = 2 RTT &#8226; HTTP/2+TLS1.3 = 2 RTT &#8226; HTTP/3 (QUIC) = 1 RTT, 0-RTT on resume</text>
  <text x="46" y="319" fill="#1e293b" font-size="11">Header cost per request: HTTP/1.1 ~700 B plaintext &#8594; HPACK/QPACK ~20&#8211;50 B after the first request</text>
</svg>
```

## 4. Architecture & Workflow

The path of a compressed API response through a modern edge, and where each optimization applies.

1. **Connection setup.** The client resolves `api.zariya.in`, sees `Alt-Svc: h3=":443"; ma=86400` cached from a previous response (or an HTTPS/SVCB DNS record), and opens a QUIC connection directly. One RTT, TLS included. Without `Alt-Svc` the first connection is TCP+TLS HTTP/2 and *advertises* h3 for next time — HTTP/3 is always an upgrade, never a hard requirement.
2. **ALPN negotiation.** TLS ALPN selects `h3`, `h2`, or `http/1.1`. Your infrastructure must support all three; a client behind a UDP-blocking corporate firewall will silently fall back to h2, and that must be seamless.
3. **Request framing.** The client sends `:method`, `:path`, `:authority`, `accept-encoding: br, gzip, zstd` as QPACK-compressed header fields. After the first request the dynamic table means these cost tens of bytes, not hundreds.
4. **Edge/CDN.** The PoP terminates QUIC and checks its cache using a key that includes `Accept-Encoding` (because `Vary: Accept-Encoding` is set). A hit for the `br` variant returns immediately. Note the interaction with chapter 25: **each encoding is a separate cache entry**, so normalizing `Accept-Encoding` down to a small set (`br`, `gzip`, identity) at the edge is important — raw browser values have thousands of variants.
5. **Origin fetch.** On a miss, the edge fetches from origin over HTTP/2, usually requesting the uncompressed or gzip variant and re-compressing to brotli itself. Many CDNs prefer to own compression so they can cache one variant and transcode.
6. **Origin handler.** The service builds the response. If `?fields=` was supplied it projects only the requested columns — this is the cheapest byte reduction available because the bytes are never produced. It then serializes compactly (no pretty-printing, `separators=(",",":")`).
7. **Compression middleware.** The middleware checks `Content-Type` (compress `application/json`, `text/*`, `application/xml`; skip `image/*`, `video/*`, already-compressed archives), checks size (skip below ~1 KB), picks the best mutually supported encoding by `Accept-Encoding` q-values, and compresses at a dynamic-safe quality.
8. **Headers set.** `Content-Encoding: br`, `Vary: Accept-Encoding`, `ETag` computed over the *uncompressed* bytes and marked weak, `Content-Length` of the compressed body.
9. **Response frames.** The origin writes the body as DATA frames; QUIC delivers them on one stream. Concurrent requests from the same client interleave on other streams with no connection contention.
10. **Client.** The HTTP stack transparently decompresses, and stores the response with its `Vary`-aware cache key.

> **Note:** Do not compress twice. If your CDN compresses, having the origin also compress wastes CPU and can produce double-encoded bodies when a proxy mishandles `Content-Encoding`. Pick one layer and disable the other explicitly.

```svg
<svg viewBox="0 0 780 370" width="100%" height="370" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="8" y="8" width="764" height="354" rx="14" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="390" y="36" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Byte-reduction pipeline: where each optimization applies</text>

  <rect x="28" y="62" width="150" height="72" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="103" y="88" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Client</text>
  <text x="103" y="107" text-anchor="middle" fill="#1e293b" font-size="10">Accept-Encoding:</text>
  <text x="103" y="122" text-anchor="middle" fill="#1e293b" font-size="10">br, gzip, zstd</text>

  <rect x="212" y="62" width="160" height="72" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="292" y="88" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Edge (h3 / h2)</text>
  <text x="292" y="107" text-anchor="middle" fill="#1e293b" font-size="10">normalizes encoding</text>
  <text x="292" y="122" text-anchor="middle" fill="#1e293b" font-size="10">one entry per variant</text>

  <rect x="406" y="62" width="160" height="72" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="486" y="88" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Handler</text>
  <text x="486" y="107" text-anchor="middle" fill="#1e293b" font-size="10">?fields= projection</text>
  <text x="486" y="122" text-anchor="middle" fill="#1e293b" font-size="10">compact serialization</text>

  <rect x="600" y="62" width="146" height="72" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="673" y="88" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Compressor</text>
  <text x="673" y="107" text-anchor="middle" fill="#1e293b" font-size="10">br q5 if &gt; 1 KB</text>
  <text x="673" y="122" text-anchor="middle" fill="#1e293b" font-size="10">Vary: Accept-Encoding</text>

  <path d="M178 98 L210 98" stroke="#4f46e5" stroke-width="2" fill="none"/>
  <polygon points="210,98 202,94 202,102" fill="#4f46e5"/>
  <path d="M372 98 L404 98" stroke="#4f46e5" stroke-width="2" fill="none"/>
  <polygon points="404,98 396,94 396,102" fill="#4f46e5"/>
  <path d="M566 98 L598 98" stroke="#4f46e5" stroke-width="2" fill="none"/>
  <polygon points="598,98 590,94 590,102" fill="#4f46e5"/>

  <text x="30" y="176" fill="#1e293b" font-size="13" font-weight="700">Cumulative effect on one catalog page</text>

  <rect x="30" y="192" width="620" height="24" rx="4" fill="#fef3c7" stroke="#d97706"/>
  <text x="662" y="209" fill="#1e293b" font-size="11" font-weight="700">180 KB raw</text>
  <text x="42" y="209" fill="#1e293b" font-size="11">full objects, pretty-printed, no encoding</text>

  <rect x="30" y="226" width="330" height="24" rx="4" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="372" y="243" fill="#1e293b" font-size="11" font-weight="700">96 KB after ?fields= projection</text>

  <rect x="30" y="260" width="120" height="24" rx="4" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="162" y="277" fill="#1e293b" font-size="11" font-weight="700">11 KB after gzip -6</text>

  <rect x="30" y="294" width="92" height="24" rx="4" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="134" y="311" fill="#1e293b" font-size="11" font-weight="700">8.4 KB after brotli q5 &#8212; fits the initial congestion window</text>

  <text x="30" y="344" fill="#1e293b" font-size="11">Bytes never generated are cheaper than bytes compressed. Project first, then compress.</text>
</svg>
```

## 5. Implementation

### Negotiated exchange

```http
GET /v1/catalog/products?fields=id,name,price_inr&limit=50 HTTP/2
:authority: api.zariya.in
accept: application/json
accept-encoding: br;q=1.0, gzip;q=0.8, zstd;q=0.9, *;q=0.1
```

```http
HTTP/2 200 OK
content-type: application/json; charset=utf-8
content-encoding: br
content-length: 8617
vary: accept-encoding
etag: W/"cat-v918"
cache-control: public, max-age=60, s-maxage=300
alt-svc: h3=":443"; ma=86400
server-timing: db;dur=11.4, serialize;dur=2.1, compress;dur=2.6
```

Note `Server-Timing` — it is the single most useful header for proving where your latency budget went, and browsers surface it natively in devtools.

### curl: measure the real difference

```bash
# Uncompressed baseline
curl -s --http2 -o /dev/null -w 'raw=%{size_download}B ttfb=%{time_starttransfer}s\n' \
  'https://api.zariya.in/v1/catalog/products?limit=50'

# Brotli-negotiated
curl -s --http2 -H 'Accept-Encoding: br' -o /dev/null \
  -w 'br=%{size_download}B ttfb=%{time_starttransfer}s\n' \
  'https://api.zariya.in/v1/catalog/products?limit=50'

# Confirm HTTP/3 is actually being used (curl built with HTTP/3 support)
curl -sI --http3 'https://api.zariya.in/v1/catalog/products' | head -1
```

### FastAPI: conditional compression + field projection

```python
from fastapi import FastAPI, Query, Request, Response
import brotli, gzip, json

app = FastAPI()

COMPRESSIBLE = ("application/json", "text/", "application/xml", "application/problem+json")
MIN_BYTES = 1024


def negotiate(accept_encoding: str) -> str | None:
    """Pick the best encoding we support, honouring simple q-value ordering."""
    prefs = {}
    for part in (accept_encoding or "").split(","):
        token, _, params = part.strip().partition(";")
        q = float(params.split("=")[1]) if params.startswith("q=") else 1.0
        prefs[token.lower()] = q
    for enc in ("br", "gzip"):                       # our supported set, best first
        if prefs.get(enc, 0) > 0:
            return enc
    return None


@app.middleware("http")
async def compress(request: Request, call_next):
    resp: Response = await call_next(request)
    ctype = resp.headers.get("content-type", "")
    body = resp.body if hasattr(resp, "body") else b""

    if (len(body) < MIN_BYTES
            or not ctype.startswith(COMPRESSIBLE)
            or "content-encoding" in resp.headers):
        return resp

    enc = negotiate(request.headers.get("accept-encoding", ""))
    if enc == "br":
        body = brotli.compress(body, quality=5)      # q5: the dynamic sweet spot
    elif enc == "gzip":
        body = gzip.compress(body, compresslevel=6)
    else:
        return resp

    resp.headers["content-encoding"] = enc
    resp.headers["content-length"] = str(len(body))
    # Vary must be additive — never clobber an existing value.
    existing = resp.headers.get("vary", "")
    resp.headers["vary"] = ", ".join(filter(None, [existing, "Accept-Encoding"]))
    resp.body = body
    return resp


@app.get("/v1/catalog/products")
async def products(fields: str | None = Query(None), limit: int = 50, db=None):
    """Sparse fieldsets: never generate bytes the client did not ask for."""
    allowed = {"id", "name", "price_inr", "sku", "description", "images"}
    projection = (set(fields.split(",")) & allowed) if fields else allowed
    rows = await db.products(limit=limit, columns=sorted(projection))
    return Response(
        content=json.dumps({"data": rows}, separators=(",", ":")).encode(),
        media_type="application/json",
        headers={"Server-Timing": f"serialize;dur={0.0:.1f}"},
    )
```

> **Note:** In production prefer a battle-tested middleware (`brotli-asgi`, nginx `brotli`, or your CDN) over hand-rolled compression — the edge cases around `HEAD`, `204`, `206`, SSE streams, and already-encoded bodies are numerous.

### nginx: terminate h2/h3 and compress correctly

```yaml
server:
  listen: "443 ssl"
  http2: "on"
  listen_quic: "443 quic reuseport"
  add_header: 'Alt-Svc: h3=":443"; ma=86400'
  gzip: "on"
  gzip_types: "application/json application/problem+json text/plain"
  gzip_min_length: 1024
  gzip_comp_level: 5
  gzip_vary: "on"
  brotli: "on"
  brotli_comp_level: 5
  brotli_types: "application/json application/problem+json"
  brotli_min_length: 1024
```

### Optimization note

Order your effort by payoff per hour of work. **(1) Compression** — one middleware line, typically 8–12× on JSON; this is always the first move. **(2) Response shaping** — sparse fieldsets, sane pagination defaults (`limit=25`, hard cap `100`), and dropping `null` fields from the serializer often halve the payload before compression, and unlike compression they also reduce database and serialization cost. **(3) `Alt-Svc` + h3** — an infrastructure toggle worth 10–30% tail-latency reduction for mobile clients and nothing at all for datacenter traffic. **(4) Avoid pretty-printing** — `indent=2` inflates JSON 15–20%; make it opt-in via `?pretty=1` for humans. **(5) Measure with `Server-Timing`** rather than guessing; if `compress;dur` exceeds `db;dur`, lower your quality level.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost/Trade-off |
|---|---|---|
| gzip | Universal support, ~9× on JSON, negligible risk | 15–25% larger than brotli at similar CPU |
| Brotli (q4–q6) | Best size/CPU balance for dynamic JSON; near-universal client support | Higher qualities are far too slow per request; needs a library or module |
| Zstandard | Highest compression throughput, excellent ratios | `Content-Encoding: zstd` support is still uneven across clients and proxies |
| Sparse fieldsets | Cuts bytes *and* DB/serialization cost; the only lever that reduces origin work | Extra API surface, harder to cache (each field combination is a distinct key) |
| HTTP/2 multiplexing | Removes connection-count limits; makes fine-grained resources practical | TCP-level HOL blocking makes it worse than HTTP/1.1 on lossy links |
| HPACK/QPACK | Header overhead drops from ~700 B to tens of bytes per request | Shared dynamic-table state complicates proxies and adds a memory bound |
| HTTP/3 / QUIC | 1-RTT (0-RTT on resume) setup, no transport HOL, connection migration | UDP is blocked or deprioritized on some networks; more CPU per byte; harder to debug |
| 0-RTT resumption | Fastest possible reconnect | Early data is replayable — only safe for idempotent requests |
| Edge compression | Offloads CPU from origin, one place to tune | Origin must not double-compress; edge must honour `Vary` correctly |

## 7. Common Mistakes & Best Practices

1. ⚠️ Compressing every response including 200-byte ones → ✅ set a `min_length` around 1 KB; below that, encoding overhead and CPU exceed the saving and gzip can grow the body.
2. ⚠️ Compressing already-compressed content (JPEG, PNG, MP4, ZIP) → ✅ restrict compression by `Content-Type` allowlist; re-compressing burns CPU for ~0% gain.
3. ⚠️ Omitting `Vary: Accept-Encoding` → ✅ always send it, or a shared cache will hand a brotli body to a gzip-only client. If middleware sets `Vary`, append rather than overwrite.
4. ⚠️ Using brotli quality 11 for dynamic responses → ✅ q4–q6 for per-request compression; reserve q11 for build-time pre-compression of static assets.
5. ⚠️ Computing a strong `ETag` over the compressed bytes → ✅ hash the uncompressed representation and emit a weak validator, otherwise the same resource has different ETags per encoding.
6. ⚠️ Assuming HTTP/2 makes request count free, so firing 300 requests on page load → ✅ multiplexing removes connection contention, not server work; each request still costs auth, routing, and a database round trip.
7. ⚠️ Keeping HTTP/1.1-era workarounds (batch endpoints, sprite-style mega-responses) after moving to h2 → ✅ re-evaluate; fine-grained resources cache better and invalidate independently.
8. ⚠️ Enabling HTTP/3 without a working h2 fallback → ✅ `Alt-Svc` is advisory and UDP is blocked on many corporate networks; h3 must always be an optimization, never a requirement.
9. ⚠️ Sending 0-RTT early data for non-idempotent requests → ✅ QUIC early data is replayable by an attacker; restrict 0-RTT to safe methods, or require an idempotency key (chapter 27).
10. ⚠️ Pretty-printing JSON in production responses → ✅ compact separators by default; gate `indent` behind an explicit query parameter.
11. ⚠️ Double compression (origin *and* CDN) → ✅ pick one layer; the other must be explicitly disabled or you waste CPU and risk mangled `Content-Encoding` chains.
12. ⚠️ Caching on the raw `Accept-Encoding` header value → ✅ normalize to a small set at the edge; unnormalized browser values create thousands of cache variants per URL.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Confirm what was actually negotiated before theorizing: `curl -sI --http3 URL | head -1` and `curl -w '%{http_version}\n'` tell you the protocol; `openssl s_client -alpn h2 -connect host:443` verifies ALPN. For compression, compare `curl -H 'Accept-Encoding: identity'` against `-H 'Accept-Encoding: br'` and diff `%{size_download}`. In Chrome devtools, add the Protocol column to the Network panel — you will frequently find that your "HTTP/3 rollout" is serving h2 because a load balancer in the path does not speak QUIC. The classic bug report "responses are garbage bytes" is almost always a proxy that stripped or duplicated `Content-Encoding`. Log the negotiated encoding and protocol version per request so you can slice latency by both.

**Monitoring.** Track: **compression ratio** (`uncompressed_bytes / wire_bytes`) per route — a sudden drop means someone started returning binary or already-compressed content through the JSON path; **protocol mix** (`h3` / `h2` / `http1.1` percentage) — this is your rollout dashboard; **`Server-Timing` breakdown** shipped to your RUM tool so you can see `db` vs `serialize` vs `compress`; **p50/p95/p99 response body size** per endpoint, alerting on growth (payload bloat is a slow leak that nobody notices until mobile users complain); **compression CPU seconds** as a share of total; and **QUIC handshake failure / fallback rate**, which tells you how many clients cannot reach you over UDP.

**Security.** Compression combined with attacker-controlled input in the same response leaks secrets — this is the BREACH/CRIME family. If a response body contains both a secret (CSRF token, session identifier) and attacker-influenced text, an attacker can infer the secret from compressed-size variations. Mitigations: never reflect user input into a response that also contains a secret, mask per-response tokens with a random XOR pad, and disable compression on the few endpoints that must contain both. Second risk: **decompression bombs on request bodies** — if you accept `Content-Encoding: gzip` on inbound requests, enforce a hard decompressed-size cap and a ratio cap (reject above ~100:1) before buffering. Third: QUIC 0-RTT early data is replayable, so gate it to safe methods. Finally, HTTP/2 has a history of resource-exhaustion CVEs (`HTTP/2 Rapid Reset`, CVE-2023-44487) — keep your server and proxy patched and cap `max_concurrent_streams`.

**Performance & scaling.** Compression is CPU-bound and scales linearly with body size, so push it to the edge where you can scale it horizontally and independently of your origin. Cache compressed variants rather than recompressing on every hit. For very large responses prefer streaming with chunked/DATA frames so time-to-first-byte stays low. Keep connection pools warm for server-to-server traffic — the protocol handshake savings of h3 matter far less when a connection lives for hours. Finally, remember that the biggest scaling lever here is not the codec: an endpoint that returns 50 items instead of 5,000 by default beats any compression setting.

## 9. Interview Questions

**Q: What is the difference between `Content-Encoding` and `Transfer-Encoding`?**
A: `Content-Encoding` is an end-to-end property of the representation — the body is genuinely gzip or brotli data and the client must decode it, and it participates in `Vary` and caching. `Transfer-Encoding: chunked` is a hop-by-hop framing mechanism for HTTP/1.1 that lets a server send a body of unknown length; it is removed at each hop and does not exist in HTTP/2 or HTTP/3, which frame natively.

**Q: Why is there a minimum size threshold for compression?**
A: Both gzip and brotli add framing and dictionary overhead, so for bodies under roughly 1 KB the compressed output can be the same size or larger, and you have paid CPU for nothing. A `min_length` of about 1024 bytes is the common default.

**Q: What does HTTP/2 multiplexing actually solve, and what does it not?**
A: It removes HTTP/1.1's one-request-per-connection limit, so dozens of requests share a single connection without the six-connection browser cap or the cost of extra handshakes. It does not make requests free — each still costs server work — and it does not remove head-of-line blocking at the TCP layer, so packet loss still stalls all streams.

**Q: When is HTTP/3 meaningfully better than HTTP/2?**
A: On lossy or high-latency networks — mobile, satellite, congested Wi-Fi — because QUIC's per-stream ordering means a lost packet only stalls its own stream, and its combined transport+TLS handshake is one RTT instead of two. On a clean, low-latency datacenter link with long-lived connections the difference is close to noise.

**Q: How do compression and caching interact?**
A: Each `Content-Encoding` produces a different byte stream, so a shared cache must key on it via `Vary: Accept-Encoding`, and every encoding becomes a separate cache entry. This is also why ETags should be computed over the uncompressed representation and marked weak — otherwise the same resource has a different validator per encoding.

**Q: What is brotli quality 11 for, and why should you not use it on API responses?**
A: It is designed for build-time pre-compression of static assets, where you compress once and serve millions of times. Compressing a 180 KB dynamic response at q11 costs on the order of 100+ ms of CPU for perhaps 20% less than q5 — a catastrophic trade for a per-request path.

**Q: How would you reduce a 400 KB JSON response without touching the compression settings?**
A: Reduce what you generate: enforce a sane default `limit` with a hard cap, add sparse fieldsets so clients request only needed attributes, drop `null`/empty fields from the serializer, replace embedded sub-objects with links or explicit `?include=`, and use compact separators instead of pretty-printing. These also cut database and serialization cost, which compression does not.

**Q: (Senior) Explain the BREACH attack and how it constrains compression.**
A: BREACH exploits the fact that compressed size leaks information about content: if a response contains both a secret and attacker-controlled input, the attacker varies their input and observes the compressed length to guess the secret byte by byte. Mitigations are to avoid putting reflected user input in the same response as a secret, mask CSRF tokens with a per-response random pad, add length randomization, or selectively disable compression on those endpoints — you generally do not disable compression globally, because the performance cost is severe.

**Q: (Senior) You roll out HTTP/3 and a subset of users report slower or failed requests. Diagnose.**
A: Segment by network: QUIC runs on UDP, which some corporate firewalls, mobile carriers, and middleboxes block, rate-limit, or deprioritize, so those clients pay a failed h3 attempt before falling back to h2. Check your QUIC handshake failure and fallback rates, confirm `Alt-Svc` has a sane `ma` so you are not pinning clients to a broken path for a day, verify every hop (LB, WAF, CDN) actually terminates QUIC, and confirm h2 fallback is fully functional — `Alt-Svc` must be advisory, never load-bearing.

**Q: (Senior) Under HTTP/2, should you still design coarse-grained batch endpoints?**
A: Usually no. Multiplexing removes the connection-count penalty that made batching necessary, and fine-grained resources cache and invalidate independently — one changed item does not bust a mega-response. The remaining reasons to batch are per-request server overhead you cannot amortize (auth, tracing, N+1 database work) and transactional semantics across multiple writes, which are real but should be a deliberate decision rather than a protocol-era reflex.

**Q: (Senior) How do you safely accept compressed request bodies?**
A: Enforce three limits before you buffer anything: a maximum compressed `Content-Length`, a maximum decompressed size, and a maximum expansion ratio (roughly 100:1), streaming the decompression and aborting the moment any limit is exceeded with `413 Content Too Large`. Without these, a few kilobytes of crafted gzip can expand into gigabytes and take the process down.

**Q: What is `Server-Timing` and why should an API emit it?**
A: `Server-Timing` is a response header carrying named duration metrics (`db;dur=11.4, compress;dur=2.6`) that browsers surface in devtools and RUM tools can collect. It turns "the API feels slow" into an attributable breakdown without requiring the client to have access to your tracing backend.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Latency is bytes multiplied by round trips. Attack bytes first: sparse fieldsets and sane pagination reduce what you generate, then brotli at quality 4–6 (or gzip -6) compresses JSON roughly 8–12×, with a ~1 KB minimum size and a `Content-Type` allowlist. Always send `Vary: Accept-Encoding`, and compute ETags over the uncompressed body as weak validators. Attack round trips second: HTTP/2 multiplexes streams over one connection and compresses headers with HPACK, which kills HTTP/1.1's six-connection workaround and makes fine-grained resources practical again. HTTP/3 replaces TCP with QUIC over UDP, giving a 1-RTT handshake and eliminating transport head-of-line blocking — a large win on lossy mobile links and near-zero in the datacenter. Advertise it with `Alt-Svc` and always keep h2 fallback working. Watch out for BREACH (compression plus secrets plus reflected input), decompression bombs on inbound bodies, and replayable 0-RTT early data.

| Item | Value / rule |
|---|---|
| `Accept-Encoding` | Client's supported codecs with q-values |
| `Content-Encoding` | `br` \| `gzip` \| `zstd` — end-to-end body encoding |
| `Vary: Accept-Encoding` | Mandatory whenever you compress |
| Min compress size | ~1024 bytes |
| Brotli quality | q4–q6 dynamic, q11 static only |
| gzip level | 5–6 for dynamic content |
| Initial congestion window | ~14 KB — aim to fit responses inside it |
| `Alt-Svc: h3=":443"; ma=86400` | Advertises HTTP/3 availability |
| HTTP/2 header compression | HPACK · HTTP/3 uses QPACK |
| `Server-Timing` | `db;dur=11.4, compress;dur=2.6` |
| `413 Content Too Large` | Reject oversized or bomb-like request bodies |

**Flash cards**

- **Why compress below 14 KB matters** → That is roughly the initial TCP congestion window; fitting inside it saves entire round trips, not just bandwidth.
- **Brotli quality for dynamic APIs** → 4–6. Quality 11 is for build-time static assets only.
- **HTTP/2's remaining weakness** → TCP-level head-of-line blocking: one lost packet stalls every multiplexed stream.
- **What QUIC changes** → UDP transport with per-stream ordering, TLS 1.3 folded into a 1-RTT handshake, and connection migration across network changes.
- **BREACH in one line** → Compressed response size leaks secrets when a response mixes a secret with attacker-controlled input.

## 11. Hands-On Exercises & Mini Project

- [ ] Take a real endpoint returning ≥ 100 KB of JSON. Measure `size_download` with `Accept-Encoding: identity`, `gzip`, and `br`, and build the ratio/CPU table from section 3 with your own numbers.
- [ ] Add `?fields=` projection to that endpoint and measure the payload *before* compression. Compare the saving against what compression alone achieved.
- [ ] Enable `Server-Timing` with `db`, `serialize`, and `compress` phases, then open the endpoint in Chrome devtools and read the breakdown.
- [ ] Sweep brotli quality 1 through 11 on a fixed 200 KB payload, plotting compressed size against compression time. Identify where the curve flattens — that is your production setting.
- [ ] Write a request-body decompression guard that enforces compressed-size, decompressed-size, and ratio caps, and prove it with a 10 KB gzip bomb that expands to 1 GB.

### Mini Project — A latency-budgeted catalog endpoint

**Goal.** Take one heavy JSON endpoint from 400 KB / 900 ms to under 15 KB on the wire and under 150 ms, with every step measured.

**Requirements.**
1. Baseline it: record wire bytes, TTFB, and total time over HTTP/1.1 with no compression, using a 100 ms simulated RTT (`tc netem` or Chrome throttling).
2. Add sparse fieldsets, a default `limit=25` with a hard cap of 100, null-field stripping, and compact separators. Re-measure.
3. Add content-negotiated brotli/gzip with a 1 KB threshold, a `Content-Type` allowlist, and correct additive `Vary`. Re-measure.
4. Serve over HTTP/2, then advertise HTTP/3 with `Alt-Svc`. Record the protocol mix your test client actually negotiates.
5. Emit `Server-Timing` for `db`, `serialize`, and `compress`, and assert in a test that `compress;dur` stays under 5 ms at p95.
6. Produce a one-page before/after table showing bytes and milliseconds attributable to each change.

**Extensions.**
- Add `zstd` as a third encoding and compare throughput against brotli under a load test.
- Simulate 2% packet loss with `tc netem` and compare h2 versus h3 tail latency — this is where QUIC's advantage becomes visible.
- Implement an inbound decompression guard and add a fuzz test that feeds it malformed and bomb-shaped gzip streams.

## 12. Related Topics & Free Learning Resources

**Related chapters.** *HTTP Caching: ETags & Cache-Control* (chapter 25) — `Vary: Accept-Encoding` makes each encoding a distinct cache entry. *Streaming: SSE, WebSockets & Chunked Responses* (chapter 30) — streaming trades `Content-Length` for time-to-first-byte. *Pagination & Filtering* — the largest payload lever is not returning everything. *API Gateways & Rate Limiting* — where compression and protocol termination usually live. *Idempotency Keys & Safe Retries* (chapter 27) — required before you allow QUIC 0-RTT early data.

- **RFC 9113 — HTTP/2** — IETF · *Advanced* · the normative spec for binary framing, streams, flow control, and HPACK usage; read §5 (streams) and §6 (frames). <https://www.rfc-editor.org/rfc/rfc9113.html>
- **RFC 9114 — HTTP/3** and **RFC 9000 — QUIC** — IETF · *Advanced* · how HTTP maps onto QUIC and what QUIC guarantees; the source of truth for stream independence and 0-RTT semantics. <https://www.rfc-editor.org/rfc/rfc9114.html>
- **MDN — HTTP Compression** — Mozilla · *Beginner* · clear treatment of `Accept-Encoding`/`Content-Encoding` negotiation and the `Vary` requirement, with correct modern guidance. <https://developer.mozilla.org/en-US/docs/Web/HTTP/Compression>
- **High Performance Browser Networking** — Ilya Grigorik (free, full text online) · *Intermediate* · the definitive free book on TCP slow start, TLS handshakes, and HTTP/2; chapters 1–3 and 12 explain why bytes and RTTs dominate. <https://hpbn.co/>
- **Cloudflare Blog — HTTP/3 and QUIC** — Cloudflare · *Intermediate* · practical rollout data, UDP-blocking realities, and measured tail-latency effects from one of the largest deployments. <https://blog.cloudflare.com/tag/http3/>
- **web.dev — Content Delivery and Text Compression** — Google · *Beginner* · actionable guidance on enabling and tuning gzip/brotli, with the size thresholds and quality trade-offs spelled out. <https://web.dev/articles/reduce-network-payloads-using-text-compression>
- **BREACH Attack** — breachattack.com · *Advanced* · the original paper and mitigations for the compression-plus-secrets side channel; short and worth reading before enabling compression on authenticated pages. <https://www.breachattack.com/>
- **MDN — Server-Timing** — Mozilla · *Beginner* · header syntax and devtools integration for shipping server-side latency attribution to clients. <https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Server-Timing>

---

*REST API Handbook — chapter 26.*
