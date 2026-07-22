# 11 · Content Negotiation & Media Types

> **In one line:** One resource, many representations — content negotiation lets the client state what it can handle and the server pick the best match, which is also the cleanest way to run two versions of a payload at the same URL.

---

## 1. Overview

**Content negotiation** is the HTTP mechanism by which a client and server agree on the *representation* of a resource: its format, its encoding, its language, and — if you use vendor media types — its schema version. The resource `/v1/invoices/inv_1` is a single, stable identity. What comes back over the wire might be JSON, a PDF, a CSV, a HAL document, or version 2 of your invoice schema, and the client says which it wants using the `Accept` family of request headers.

The problem it solves is **serving diverse consumers from one URI space**. Your invoice resource has three real consumers: a web app that wants JSON, a finance team that wants a PDF to email, and a data pipeline that wants CSV. Without negotiation you end up with `/invoices/{id}.json`, `/invoices/{id}/pdf` and `/invoices/{id}/export.csv` — three URIs, three routes, three sets of authorization checks, three cache entries, and no single canonical identity for "the invoice". With negotiation there is one URI, one authorization path, and the `Accept` header selects the projection. RFC 9110 calls this **proactive negotiation** (server-driven), as opposed to **reactive negotiation** where the server returns a list of alternatives and the client chooses.

The mechanism dates to HTTP/1.0 and is specified today in **RFC 9110 §12** (with media-type syntax in RFC 9110 §8.3 and the historical `Content-Type` grammar from RFC 2045). Its most consequential companion is the **`Vary` response header**: any response whose content depends on a request header must declare that dependency, or every shared cache in the path will serve the wrong representation to the wrong client. `Vary` is the single most commonly forgotten piece of content negotiation and the source of its worst production incidents.

**Concrete example.** GitHub uses vendor media types for both format and version: `Accept: application/vnd.github+json` selects the current API, `application/vnd.github.v3.raw` returns a file's raw bytes, `application/vnd.github.html+json` returns comment bodies rendered to HTML alongside the JSON. Same URL, four representations. Stripe deliberately does the opposite — it negotiates nothing and versions by a `Stripe-Version` header plus per-account pinning — because it decided predictable, pinned behaviour beat flexibility. The Google Cloud APIs support `?alt=json|media|proto` as a query parameter, an explicit rejection of header-driven negotiation on the grounds that URLs should be self-contained and cacheable.

The durable mental model: **`Accept` is the request's wish list, `Content-Type` is the response's declaration, and `Vary` is the promise you make to every cache in between.** Get those three right and negotiation is a quiet, powerful tool. Get `Vary` wrong and you will serve a PDF to a JSON parser.

## 2. Core Concepts

- **Media type (MIME type)** — a `type/subtype` label with optional parameters: `application/json`, `text/csv; charset=utf-8`, `application/vnd.zariya.invoice+json; version=2`. The **structured-syntax suffix** (`+json`, `+xml`, `+cbor`; RFC 6839) tells a generic parser the underlying encoding even when the subtype is unfamiliar.
- **Vendor tree (`vnd.`)** — the IANA registry branch for organisation-specific types; `prs.` is for personal/experimental, `x.` is the unregistered escape hatch.
- **`Accept`** — the client's ranked list of acceptable media types, with quality values: `Accept: application/json;q=1.0, text/csv;q=0.8, */*;q=0.1`.
- **Quality value (`q`)** — a weight from `0` to `1` (three decimal places max) expressing relative preference; `q=0` means "not acceptable".
- **Proactive (server-driven) negotiation** — the server picks the best representation from the client's `Accept` headers. The common case.
- **Reactive (agent-driven) negotiation** — the server returns `300 Multiple Choices` with a list, and the client picks. Rare in practice.
- **`Vary`** — the response header naming which request headers the selected representation depended on; the cache key is (URL + those headers).
- **`Content-Type` vs `Accept`** — `Content-Type` describes the body actually present in *this* message; `Accept` describes what the sender is willing to receive in the response.
- **`415` vs `406`** — `415 Unsupported Media Type` means "I can't read the body you sent"; `406 Not Acceptable` means "I can't produce anything on your `Accept` list".

## 3. Theory & Principles

**The negotiation dimensions.** HTTP defines four proactive-negotiation axes, each with a request header and a matching `Content-*` response header:

| Dimension | Request header | Response header | Typical API use |
|---|---|---|---|
| Format | `Accept` | `Content-Type` | JSON vs CSV vs PDF; schema version |
| Compression | `Accept-Encoding` | `Content-Encoding` | `gzip`, `br`, `zstd` |
| Language | `Accept-Language` | `Content-Language` | localised error messages, descriptions |
| Charset | `Accept-Charset` | `charset` parameter | obsolete — RFC 9110 deprecates it; always UTF-8 |

`Accept-Encoding` is the one every API uses without thinking about it, and it is negotiation in exactly the same sense as `Accept`.

**How `Accept` is actually parsed.** The header is a comma-separated list of media ranges with optional parameters:

```
Accept: application/vnd.zariya.invoice+json;version=2, application/json;q=0.9, text/csv;q=0.5, */*;q=0.1
```

Selection follows two rules. **Specificity first:** `application/json` beats `application/*` beats `*/*`, regardless of `q`. **Then quality:** among equally specific matches, higher `q` wins. A missing `q` defaults to `1.0`. `q=0` explicitly forbids a type. Note the trap: browsers send `Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8`, so a naive "pick the highest-q type I support" implementation will hand a browser whatever your first supported type is via the `*/*` wildcard — usually fine, occasionally not.

**Vendor media types and versioning.** A vendor type embeds your organisation and, optionally, a version:

```
application/vnd.zariya.invoice.v2+json         # version in the subtype
application/vnd.zariya.invoice+json; version=2 # version as a parameter
```

The parameter form is generally better: generic tooling can still see `+json`, the base type stays stable, and `version` is a first-class parameter rather than a string you must regex. This is **media-type versioning**, the third option alongside URL versioning (`/v2/invoices`) and header versioning (`API-Version: 2`). Its theoretical appeal is strong — the resource identity (`/invoices/inv_1`) never changes, only its representation, which is exactly what REST says a version *is*. Its practical drawbacks are equally strong: URLs are no longer self-describing, you cannot paste one into a browser and get v2, CDN configuration must vary on `Accept`, and debugging requires reading headers. This is why most public APIs use URL versioning despite media-type versioning being more architecturally correct.

**`Vary` and cache correctness.** RFC 9111 defines a stored response as usable only if the request's values for the headers listed in `Vary` match those of the stored request. So:

- Negotiating on `Accept` → **must** send `Vary: Accept`.
- Compressing based on `Accept-Encoding` → **must** send `Vary: Accept-Encoding`.
- Localising on `Accept-Language` → **must** send `Vary: Accept-Language`.
- Returning per-user data → **must** send `Vary: Authorization` (or, better, `Cache-Control: private`).

Omitting `Vary: Accept` on a negotiated endpoint means a CDN can cache the CSV representation and serve it to the next client that asked for JSON. This is not theoretical; it is one of the most common CDN incidents in the industry. The counter-pressure is that `Vary` **fragments the cache**: each distinct header value is a separate stored entry, and since `Accept` strings differ across clients and browser versions, `Vary: Accept` can shatter your hit rate. The mitigation is **normalisation at the edge**: rewrite the incoming `Accept` to one of a small canonical set before it reaches the cache, so the cache sees three values rather than three thousand.

**Negotiation on requests, not just responses.** `Content-Type` on a request body is negotiated in the sense that the server either supports it or returns `415`. This matters most for `PATCH`, where the media type *is* the semantics: `application/merge-patch+json` (RFC 7396) means null-deletes-the-field, while `application/json-patch+json` (RFC 6902) means an explicit op array. Advertise what you accept with the `Accept-Patch` response header on `OPTIONS`, and `Accept-Post` for `POST` targets.

```svg
<svg viewBox="0 0 770 355" width="100%" height="355" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="10" y="10" width="750" height="335" rx="14" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="385" y="38" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Proactive negotiation and the Vary contract</text>
  <rect x="30" y="58" width="200" height="120" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="130" y="82" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Client request</text>
  <text x="45" y="106" fill="#1e293b" font-size="10">Accept: text/csv;q=0.9,</text>
  <text x="45" y="122" fill="#1e293b" font-size="10">  application/json;q=1.0,</text>
  <text x="45" y="138" fill="#1e293b" font-size="10">  */*;q=0.1</text>
  <text x="45" y="158" fill="#1e293b" font-size="10">Accept-Encoding: br, gzip</text>
  <text x="45" y="172" fill="#1e293b" font-size="10">Accept-Language: hi, en;q=0.8</text>
  <path d="M230 118 L268 118" stroke="#4f46e5" stroke-width="2"/>
  <rect x="272" y="58" width="200" height="120" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="372" y="82" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Server selection</text>
  <text x="287" y="106" fill="#1e293b" font-size="10">1. specificity: exact &gt; type/* &gt; */*</text>
  <text x="287" y="124" fill="#1e293b" font-size="10">2. then highest q wins</text>
  <text x="287" y="142" fill="#1e293b" font-size="10">3. q=0 means forbidden</text>
  <text x="287" y="162" fill="#1e293b" font-size="10">no match &#8594; 406 Not Acceptable</text>
  <path d="M472 118 L510 118" stroke="#4f46e5" stroke-width="2"/>
  <rect x="514" y="58" width="216" height="120" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="622" y="82" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Response</text>
  <text x="529" y="106" fill="#1e293b" font-size="10">Content-Type: application/json</text>
  <text x="529" y="124" fill="#1e293b" font-size="10">Content-Encoding: br</text>
  <text x="529" y="142" fill="#1e293b" font-size="10">Content-Language: hi</text>
  <text x="529" y="162" fill="#b91c1c" font-size="10" font-weight="700">Vary: Accept, Accept-Encoding,</text>
  <text x="529" y="174" fill="#b91c1c" font-size="10" font-weight="700">      Accept-Language</text>
  <rect x="30" y="196" width="700" height="76" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="50" y="220" fill="#1e293b" font-size="12" font-weight="700">Cache key = URL + every header named in Vary</text>
  <text x="50" y="242" fill="#1e293b" font-size="11">omit Vary: Accept and a CDN will serve the cached CSV to the next client asking for JSON</text>
  <text x="50" y="262" fill="#1e293b" font-size="11">but every distinct header value is a separate entry, so Vary: Accept can shatter hit rate</text>
  <rect x="30" y="286" width="700" height="46" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="50" y="308" fill="#1e293b" font-size="12" font-weight="700">Fix: normalise at the edge</text>
  <text x="50" y="326" fill="#1e293b" font-size="11">rewrite the raw Accept to one of 3&#8211;4 canonical values before the cache key is computed</text>
</svg>
```

## 4. Architecture & Workflow

A negotiated `GET` through a real stack, showing where each decision is made.

1. **Client declares capability.** `Accept: application/vnd.zariya.invoice+json;version=2, application/json;q=0.8`, plus `Accept-Encoding: br, gzip` and optionally `Accept-Language: hi-IN, en;q=0.7`.
2. **Edge normalises.** The CDN rewrites the raw `Accept` into one canonical token (`json-v2`, `json-v1`, `csv`, `pdf`) using a small mapping table, and stores it in a normalised header. This keeps `Vary` from fragmenting the cache into thousands of entries.
3. **Cache lookup.** The key is URL + normalised `Accept` + `Accept-Encoding` (+ `Accept-Language` if localised). A hit returns immediately with the correct representation.
4. **Gateway routes.** On a miss the request reaches the service. Note the URI is identical for every representation — routing, authorization, and rate limiting all happen once, not per-format.
5. **Server parses `Accept`.** Split on commas, parse parameters, sort by (specificity, `q`), and walk the list intersecting with the set of representations this endpoint can produce.
6. **No acceptable match → `406`.** RFC 9110 permits the server to return its default representation instead of `406`; the useful compromise is `406` with a Problem Details body listing what *is* available, since a silent wrong format is worse than an explicit failure.
7. **Load the domain object once.** The resource is fetched from the store exactly once regardless of the chosen representation — this is precisely the advantage over separate `/pdf` and `/csv` endpoints.
8. **Serialize through the chosen renderer.** A JSON serializer, a CSV writer, or a PDF renderer, all fed from the same domain object. Version-2 JSON is a different serializer, not a different data path.
9. **Set the response headers.** `Content-Type` with full parameters (including `charset` and `version`), `Content-Language` if localised, `Content-Encoding` after compression, and — non-negotiably — `Vary` naming every header the selection depended on.
10. **Validators are per-representation.** The `ETag` must differ between the JSON and CSV representations of the same resource, or a conditional request will validate against the wrong body. Derive it from `(resource_version, media_type, encoding)`.
11. **Cache stores under the composite key.** The next identical request short-circuits at the edge.

```svg
<svg viewBox="0 0 780 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="10" y="10" width="760" height="320" rx="14" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="390" y="36" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">One resource, one fetch, many renderers</text>
  <rect x="30" y="58" width="120" height="64" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="90" y="82" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Client</text>
  <text x="90" y="102" text-anchor="middle" fill="#1e293b" font-size="10">Accept: &#8230;</text>
  <rect x="175" y="58" width="150" height="64" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="250" y="78" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Edge / CDN</text>
  <text x="250" y="96" text-anchor="middle" fill="#1e293b" font-size="10">normalise Accept</text>
  <text x="250" y="112" text-anchor="middle" fill="#1e293b" font-size="10">key = URL + Vary hdrs</text>
  <rect x="350" y="58" width="150" height="64" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="425" y="78" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Service</text>
  <text x="425" y="96" text-anchor="middle" fill="#1e293b" font-size="10">parse + rank Accept</text>
  <text x="425" y="112" text-anchor="middle" fill="#1e293b" font-size="10">no match &#8594; 406</text>
  <rect x="525" y="58" width="145" height="64" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="597" y="82" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Domain object</text>
  <text x="597" y="102" text-anchor="middle" fill="#1e293b" font-size="10">loaded exactly once</text>
  <path d="M150 90 L173 90" stroke="#4f46e5" stroke-width="2"/>
  <path d="M325 90 L348 90" stroke="#4f46e5" stroke-width="2"/>
  <path d="M500 90 L523 90" stroke="#4f46e5" stroke-width="2"/>
  <path d="M597 122 L597 146" stroke="#16a34a" stroke-width="2"/>
  <path d="M190 146 L635 146" stroke="#16a34a" stroke-width="1.4" fill="none"/>
  <rect x="120" y="150" width="140" height="56" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="190" y="172" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">JSON v1</text>
  <text x="190" y="192" text-anchor="middle" fill="#1e293b" font-size="10">application/json</text>
  <rect x="275" y="150" width="150" height="56" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="350" y="172" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">JSON v2</text>
  <text x="350" y="192" text-anchor="middle" fill="#1e293b" font-size="10">vnd.zariya+json;version=2</text>
  <rect x="440" y="150" width="120" height="56" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="500" y="172" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">CSV</text>
  <text x="500" y="192" text-anchor="middle" fill="#1e293b" font-size="10">text/csv</text>
  <rect x="575" y="150" width="120" height="56" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="635" y="172" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">PDF</text>
  <text x="635" y="192" text-anchor="middle" fill="#1e293b" font-size="10">application/pdf</text>
  <rect x="30" y="226" width="720" height="90" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="50" y="250" fill="#1e293b" font-size="12" font-weight="700">Every response MUST carry</text>
  <text x="50" y="272" fill="#1e293b" font-size="11">Content-Type (with charset and version params) &#183; Content-Language if localised &#183; Content-Encoding if compressed</text>
  <text x="50" y="292" fill="#1e293b" font-size="11">Vary listing every header used in selection &#183; an ETag derived from (version, media type, encoding)</text>
  <text x="50" y="310" fill="#b91c1c" font-size="11">a shared ETag across representations makes conditional requests validate the wrong body</text>
</svg>
```

## 5. Implementation

Two representations of the same resource, selected by `Accept`. First `GET /v1/invoices/inv_01JQ8Z` with `Accept: application/json` and `Accept-Encoding: br, gzip`:

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Content-Encoding: br
Vary: Accept, Accept-Encoding
ETag: "7-json"
Cache-Control: private, max-age=0, must-revalidate

{"id":"inv_01JQ8Z","status":"open","amount_minor":249900,"currency":"INR"}
```

Now the same URL with `Accept: text/csv`:

```http
HTTP/1.1 200 OK
Content-Type: text/csv; charset=utf-8
Content-Disposition: attachment; filename="invoice-inv_01JQ8Z.csv"
Vary: Accept, Accept-Encoding
ETag: "7-csv"

id,status,amount_minor,currency
inv_01JQ8Z,open,249900,INR
```

Version negotiation through a vendor media type — two schemas, one URL. With `Accept: application/vnd.zariya.invoice+json; version=2`:

```http
HTTP/1.1 200 OK
Content-Type: application/vnd.zariya.invoice+json; version=2
Vary: Accept
ETag: "7-v2"

{"id":"inv_01JQ8Z","status":"open","total":{"amount_minor":249900,"currency":"INR"}}
```

Note that v2 restructured `amount_minor`/`currency` into a nested `total` object — a breaking change served at the same URI, with v1 clients entirely unaffected.

Failure modes, precisely distinguished. A `GET` with `Accept: application/xml`:

```http
HTTP/1.1 406 Not Acceptable
Content-Type: application/problem+json
Vary: Accept

{"type":"https://api.zariya.in/problems/not-acceptable","title":"Not Acceptable","status":406,
 "detail":"No representation matches the Accept header",
 "available":["application/json","text/csv","application/pdf",
              "application/vnd.zariya.invoice+json; version=2"]}
```

And the mirror image — `POST /v1/invoices` with `Content-Type: application/xml`:

```http
HTTP/1.1 415 Unsupported Media Type
Accept-Post: application/json, application/vnd.zariya.invoice+json; version=2
Content-Type: application/problem+json

{"type":"https://api.zariya.in/problems/unsupported-media-type","title":"Unsupported Media Type",
 "status":415,"detail":"Send application/json"}
```

Discovering what a resource supports, without transferring it — `curl -i -X OPTIONS https://api.zariya.in/v1/invoices/inv_01JQ8Z`:

```http
HTTP/1.1 204 No Content
Allow: GET, HEAD, PUT, PATCH, DELETE, OPTIONS
Accept-Patch: application/merge-patch+json, application/json-patch+json
Accept-Post: application/json
```

**FastAPI** — a reusable negotiation dependency plus per-format renderers:

```python
from fastapi import FastAPI, Depends, Header, Request, Response
from fastapi.responses import JSONResponse, PlainTextResponse
import io, csv

app = FastAPI()

SUPPORTED = [("application/vnd.zariya.invoice+json", {"version": "2"}),
             ("application/json", {}), ("text/csv", {}), ("application/pdf", {})]

def parse_accept(header: str):
    """Return media ranges sorted by (specificity, q) descending."""
    out = []
    for part in (header or "*/*").split(","):
        bits = [b.strip() for b in part.split(";") if b.strip()]
        if not bits:
            continue
        mtype, params = bits[0].lower(), {}
        for p in bits[1:]:
            k, _, v = p.partition("=")
            params[k.strip().lower()] = v.strip().strip('"')
        q = float(params.pop("q", 1.0))
        spec = 0 if mtype == "*/*" else (1 if mtype.endswith("/*") else 2)
        out.append((spec, q, mtype, params))
    return sorted(out, key=lambda t: (-t[0], -t[1]))   # specificity, then q

def matches(mtype, params, sup_type, sup_params) -> bool:
    if mtype not in ("*/*", sup_type, sup_type.split("/")[0] + "/*"):
        return False
    # a requested parameter must match if the representation defines it
    return all(sup_params.get(k) == v for k, v in params.items() if k in sup_params)

def negotiate(accept: str = Header(default="*/*")):
    for _spec, q, mtype, params in parse_accept(accept):
        if q == 0:
            continue                      # q=0 means explicitly unacceptable
        for sup_type, sup_params in SUPPORTED:
            if matches(mtype, params, sup_type, sup_params):
                return sup_type, sup_params
    return None, None

@app.get("/v1/invoices/{invoice_id}")
def get_invoice(invoice_id: str, chosen=Depends(negotiate)):
    media, params = chosen
    if media is None:
        return JSONResponse({"title": "Not Acceptable", "status": 406,
                             "available": [t for t, _ in SUPPORTED]},
                            status_code=406, media_type="application/problem+json",
                            headers={"Vary": "Accept"})
    inv = repo.get(invoice_id)
    # ETag is per-representation, or conditional requests validate the wrong body
    hdrs = {"Vary": "Accept, Accept-Encoding", "ETag": f'"{inv.version}-{media[-4:]}"'}

    if media == "text/csv":
        buf = io.StringIO(); w = csv.writer(buf)
        w.writerow(["id", "status", "amount_minor", "currency"]); w.writerow(inv.row())
        return PlainTextResponse(buf.getvalue(), media_type="text/csv; charset=utf-8", headers=hdrs)
    if media == "application/pdf":
        return Response(render_pdf(inv), media_type="application/pdf", headers=hdrs)

    body = serialize_v2(inv) if params.get("version") == "2" else serialize_v1(inv)
    ct = media + (f'; version={params["version"]}' if params.get("version") else "; charset=utf-8")
    return JSONResponse(body, media_type=ct, headers=hdrs)
```

Normalising `Accept` at the edge so `Vary` doesn't shred the cache (Nginx/OpenResty-style logic, expressible in any CDN's edge language):

```javascript
// Edge worker: collapse thousands of raw Accept strings into 4 canonical values
const CANON = [
  [/vnd\.zariya\.invoice\+json.*version=2/, "application/vnd.zariya.invoice+json; version=2"],
  [/text\/csv/, "text/csv"], [/application\/pdf/, "application/pdf"],
];
function normalizeAccept(req) {
  const hit = CANON.find(([re]) => re.test(req.headers.get("Accept") || "*/*"));
  req.headers.set("Accept", hit ? hit[1] : "application/json");  // default
  return req;   // cache key now has at most 4 Accept values
}
```

**Optimization note.** Negotiation's performance story is dominated by cache-key cardinality. `Vary: Accept` is mandatory for correctness but ruinous for hit rate if you pass raw client `Accept` strings through — real-world browsers and HTTP libraries emit hundreds of distinct values. Normalise at the edge to a handful of canonical tokens and hit rate returns to near its un-negotiated level. `Vary: Accept-Encoding` is safer because there are effectively three values (`br`, `gzip`, identity), and most CDNs handle it natively. Never send `Vary: *` — it makes the response uncacheable everywhere. Two more wins: derive each representation's `ETag` from `(resource_version, media_type, encoding)` so `304`s work per-format instead of colliding; and compute expensive representations lazily — a PDF renderer should not run on a request that will be answered with `304`, so validate conditional headers *before* rendering.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| One URI, many representations | Single canonical identity; authorization and routing implemented once | URL no longer tells you what you'll get; harder to debug and to share |
| `Accept`-based format selection | Standard, extensible, invisible to the URL space | Needs `Vary: Accept`, which fragments caches unless normalised |
| Vendor media-type versioning | Architecturally correct — the resource is stable, the representation versions | Can't paste a v2 URL into a browser; CDN and client config get fiddly |
| URL versioning (the alternative) | Trivially visible, cacheable, testable, `curl`-able | Multiplies the URI space; the "same" resource has two identities |
| `Accept-Encoding` / `Accept-Language` | 8–15× compression on JSON; localisation without duplicate endpoints | Each adds a `Vary` dimension that further fragments the cache |
| `406` on no match | Explicit, debuggable failure | RFC permits a default instead; returning `406` can break lax clients |
| Query-parameter format (`?format=csv`) | Self-contained, cacheable, shareable URLs; no `Vary` needed | Not the HTTP mechanism; two URIs for one resource; ignores `Accept` |
| Per-representation `ETag`s | Correct conditional requests per format | More validator bookkeeping; easy to get subtly wrong |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Negotiating without `Vary`.** The CDN caches the CSV and hands it to the next client asking for JSON. This is the single most damaging mistake in this chapter. → ✅ Every negotiated response carries `Vary` listing exactly the headers used in selection.
2. ⚠️ **`Vary: *` "to be safe".** It marks the response uncacheable by every shared cache, silently destroying your hit rate. → ✅ Name the specific headers; if the response is genuinely per-user, use `Cache-Control: private` instead.
3. ⚠️ **Passing raw `Accept` through to the cache key.** Hundreds of distinct client strings become hundreds of cache entries for one resource. → ✅ Normalise `Accept` to a small canonical set at the edge before the cache key is computed.
4. ⚠️ **Confusing `406` and `415`.** They are opposite directions: `406` is about the response you can't produce, `415` about the request body you can't read. → ✅ `406` for an unsatisfiable `Accept`; `415` for an unsupported `Content-Type`, with `Accept-Post`/`Accept-Patch` naming what you do take.
5. ⚠️ **Ignoring `q` values and specificity ordering.** Picking the first listed type hands a browser HTML-shaped expectations, or picks a low-preference format. → ✅ Sort by specificity first, then `q`; honour `q=0` as a prohibition.
6. ⚠️ **Sharing one `ETag` across representations.** A client caches the JSON, later requests CSV with `If-None-Match`, and gets `304` — then parses JSON as CSV. → ✅ Derive validators from `(version, media type, encoding)`.
7. ⚠️ **Omitting `charset` on textual types.** `Content-Type: text/csv` with UTF-8 content gets decoded as Latin-1 by a well-meaning client, mangling every non-ASCII name. → ✅ Always `; charset=utf-8` on `text/*`, and set `X-Content-Type-Options: nosniff`.
8. ⚠️ **Inventing an unregistered top-level or bare subtype.** `application/invoice` collides with anyone else's; `zariya/invoice` is not a legal registration. → ✅ Use the vendor tree with a structured suffix: `application/vnd.zariya.invoice+json`.
9. ⚠️ **Version in the subtype string.** `application/vnd.zariya.invoice.v2+json` forces every consumer to regex the type to learn the version. → ✅ Use a parameter: `application/vnd.zariya.invoice+json; version=2`.
10. ⚠️ **Silently falling back to a default on an unmatched `Accept`.** A client asking for XML gets JSON with no signal and fails deep in its parser. → ✅ Return `406` with a Problem Details body listing available representations.
11. ⚠️ **Rendering an expensive representation before checking conditional headers.** You generate a PDF and then return `304`. → ✅ Evaluate `If-None-Match`/`If-Modified-Since` before invoking the renderer.
12. ⚠️ **Implementing `Accept-Charset`.** RFC 9110 deprecates it, so you add a `Vary` dimension for a header nothing sends. → ✅ UTF-8 everywhere; ignore `Accept-Charset`.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Almost every content-negotiation bug is a `Vary` bug, and they present as "intermittent wrong format" or "one user sees stale data" — symptoms that don't reproduce locally because there's no shared cache in front of your dev server. The diagnostic sequence: `curl -sI` the URL with each `Accept` value and confirm `Content-Type`, `Vary` and `ETag` all differ appropriately; then check the CDN's cache-key configuration, since many CDNs *ignore* `Vary: Accept` by default and require explicit key configuration. Log the raw `Accept` header alongside the selected media type on every request — that pairing is what lets you answer "why did this client get CSV?" without reproducing. `curl -H 'Accept: application/vnd.zariya.invoice+json;version=2' -i` should be in your runbook.

**Monitoring.** Track `responses_total{media_type, version}` — this is how you learn that 4 % of traffic is still on v1 and whether the number is falling. Track `406` and `415` rates per route; a `415` spike means a client changed its serializer, a `406` spike means someone shipped an `Accept` header you don't support. Track **cache hit rate broken down by `Vary` dimension** before and after enabling negotiation; a hit-rate collapse right after adding `Vary: Accept` is the normalisation problem, not a capacity problem. Finally, an unused representation is dead code: if `text/csv` has been requested zero times in a quarter, deprecate it rather than maintaining a renderer.

**Security.** Content type is a security boundary. **Always send `X-Content-Type-Options: nosniff`** — without it, a browser may sniff a JSON response containing attacker-controlled markup as HTML and execute it, which is stored XSS via your API. Serve user-uploaded or user-influenced content from a separate origin with `Content-Disposition: attachment` and a conservative type. On the request side, never trust the client's `Content-Type` as a validation step: a file claiming `image/png` must still be verified by content inspection, and a JSON parser must not be selected purely on a client-supplied label. Negotiation also expands your attack surface — every renderer is a code path, and PDF/XML generators are historically rich in vulnerabilities (XXE in XML parsers, SSRF in HTML-to-PDF renderers that fetch remote resources). Disable external entity resolution, sandbox renderers, and cap output size. Lastly, if `Vary` is wrong on an authenticated endpoint, a shared cache can serve one user's representation to another — always pair per-user responses with `Cache-Control: private` in addition to `Vary: Authorization`.

**Performance & scaling.** The dominant cost is cache-key cardinality; edge normalisation of `Accept` is the fix and typically restores hit rate to within a point or two of the un-negotiated baseline. Second, keep expensive representations off the synchronous path: a large PDF or a full CSV export should be a `202 Accepted` job that produces a downloadable artifact, not a blocking `GET` that ties up a worker for eight seconds. Third, cache *rendered* representations rather than re-rendering — a per-representation cache keyed by `(resource_id, version, media_type)` makes repeated PDF requests free. Fourth, negotiate compression properly: prefer Brotli for text at level 4–5, never compress already-compressed types like PDF or images, and let the CDN do it if it can, since edge compression is both faster and closer to the client.

## 9. Interview Questions

**Q: What is content negotiation and which headers drive it?**
A: It's the mechanism by which client and server agree on which representation of a resource to transfer. The client sends preferences via `Accept` (format), `Accept-Encoding` (compression) and `Accept-Language` (language); the server responds with `Content-Type`, `Content-Encoding` and `Content-Language` describing what it actually sent. RFC 9110 calls the server-picks case proactive negotiation, which is what essentially every API uses.

**Q: What's the difference between `Accept` and `Content-Type`?**
A: `Content-Type` describes the body present in the *current* message — so on a request it describes the request body, and on a response it describes the response body. `Accept` describes what the sender is willing to *receive* in return. A `POST` typically carries both: `Content-Type: application/json` for what it's sending and `Accept: application/json` for what it wants back.

**Q: When do you return `406` versus `415`?**
A: `406 Not Acceptable` means you cannot produce any representation on the client's `Accept` list — it's about the response. `415 Unsupported Media Type` means you cannot parse the `Content-Type` the client sent — it's about the request body. A useful `415` includes an `Accept-Post` or `Accept-Patch` header naming what you do accept.

**Q: Why is the `Vary` header critical?**
A: Because a shared cache keys stored responses by URL, and if the response actually depends on a request header, the cache will serve the wrong representation to the next client. `Vary` names those headers so the cache key becomes URL plus their values. Omitting `Vary: Accept` on a negotiated endpoint is how a CDN ends up serving a CSV to a JSON parser.

**Q: How does `q` work in an `Accept` header?**
A: `q` is a quality weight from 0 to 1 expressing relative preference, defaulting to 1.0 when absent, with `q=0` meaning explicitly unacceptable. Selection sorts by specificity first — an exact `type/subtype` beats `type/*` beats `*/*` — and only uses `q` to break ties among equally specific matches. So `Accept: application/json;q=0.5, */*;q=0.9` still prefers JSON.

**Q: What is a vendor media type and when would you use one?**
A: A media type in the IANA `vnd.` tree identifying an organisation-specific format, typically with a structured suffix: `application/vnd.zariya.invoice+json`. You use it when your payload has API-specific semantics beyond "some JSON", and most importantly to carry a schema version as a parameter — `; version=2` — so two representations of the same resource can be served from one URI.

**Q: What are the downsides of media-type versioning compared to URL versioning?**
A: URLs stop being self-describing: you cannot paste a link and get v2, you cannot see the version in a log line or an access record, and testing requires setting headers. CDN and gateway configuration must vary on `Accept`, which fragments caches unless normalised. It's more architecturally correct — the resource identity genuinely shouldn't change when only the representation does — but URL versioning wins on operability, which is why most public APIs use it.

**Q: Should `?format=csv` be used instead of `Accept`?**
A: It's not the HTTP mechanism, but it's a defensible pragmatic choice and Google's APIs use it. The advantages are real: the URL is self-contained, shareable, cacheable without any `Vary` complexity, and testable in a browser. The cost is that one resource now has multiple URIs and you're ignoring a standard header. A reasonable compromise is to support `Accept` as the primary mechanism and allow a query parameter to override it for browser and debugging convenience.

**Q: (Senior) How do you keep `Vary: Accept` from destroying your cache hit rate?**
A: Normalise `Accept` at the edge before the cache key is computed: map the raw client header — of which there are hundreds of distinct real-world variants — onto a small canonical set of three or four tokens, and let the cache and origin see only those. Most CDNs support either an edge function for this or an explicit cache-key configuration that lets you specify a derived value rather than the raw header. Measure hit rate before and after; a well-normalised negotiated endpoint should land within a point or two of an un-negotiated one. Also remember many CDNs ignore `Vary: Accept` unless configured, so correctness requires checking their behaviour explicitly rather than trusting the header alone.

**Q: (Senior) Design a migration that serves two payload schemas at the same URL. What are the operational requirements?**
A: Introduce a vendor media type with a version parameter, keep `application/json` as an alias for the current default version, and serve both representations from the same handler over one domain-object load. Operationally you need: per-version request metrics broken down by client id so you know who is still on v1; per-representation `ETag`s so conditional requests don't cross-validate; `Vary: Accept` plus edge normalisation; contract tests running the full suite against both representations; and a documented default-version policy — new clients that send bare `application/json` should get the *old* default, not the newest, or you break everyone the day you ship v3. Then deprecate v1 with `Deprecation` and `Sunset` headers and remove it only when usage reaches zero or the sunset date passes.

**Q: (Senior) What are the security implications of content negotiation?**
A: Three main ones. First, response type confusion: without `X-Content-Type-Options: nosniff`, a browser may sniff a JSON response containing attacker-supplied markup as HTML and execute it, turning your API into a stored-XSS vector — so always send it and always set an accurate `Content-Type` with charset. Second, every additional renderer is additional attack surface, and the risky ones are exactly the ones people add for negotiation: XML parsers bring XXE, HTML-to-PDF renderers bring SSRF because they fetch remote resources, and both can be turned into file-read primitives. Third, `Vary` errors on authenticated endpoints let a shared cache serve one principal's representation to another, so per-user responses need `Cache-Control: private` in addition to correct `Vary`. And never treat a client-supplied `Content-Type` as validation — verify uploaded content by inspection, not by label.

**Q: (Senior) A client reports intermittently receiving the wrong format. Walk through your diagnosis.**
A: Intermittency plus format confusion is almost always a caching-key problem, so I'd start by confirming the origin is correct in isolation: `curl -sI` with each `Accept` value and verify that `Content-Type`, `ETag` and `Vary` all differ as expected. If the origin is right, the fault is between origin and client. Check whether `Vary: Accept` is actually present on the affected responses and whether the CDN honours it — many ignore `Vary` on non-standard headers unless the cache key is explicitly configured. Check for a shared `ETag` across representations, which produces exactly this symptom via `304` on a mismatched cached body. Check for an intermediate proxy stripping or rewriting `Accept`. Finally, check whether the client library is reusing a connection with a cached response of its own; browser and HTTP-client caches obey `Vary` too, and a client that upgraded its default `Accept` header mid-session can hit a stale entry stored under the old one.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** A resource has one URI and many representations; `Accept`, `Accept-Encoding` and `Accept-Language` say what the client can take, and `Content-Type`, `Content-Encoding` and `Content-Language` say what the server sent. Selection ranks by specificity first (`application/json` > `application/*` > `*/*`) and then by `q`, with `q=0` meaning forbidden. If nothing matches, `406`; if you can't read the request body, `415` plus `Accept-Post`/`Accept-Patch`. Vendor media types (`application/vnd.zariya.invoice+json; version=2`) let two schema versions live at one URL, which is architecturally cleaner than `/v2/` but worse to operate. The non-negotiable rule: every negotiated response carries a `Vary` header naming exactly the request headers that influenced it, because the cache key is URL plus those headers — and because raw `Accept` strings are wildly varied, normalise them at the edge or your hit rate collapses. Give each representation its own `ETag`, always send `charset=utf-8` on text types, and always send `X-Content-Type-Options: nosniff`.

| Header | Direction | Purpose | Companion |
|---|---|---|---|
| `Accept` | request | acceptable response formats | `Content-Type` + `Vary: Accept` |
| `Accept-Encoding` | request | acceptable compressions | `Content-Encoding` + `Vary: Accept-Encoding` |
| `Accept-Language` | request | preferred languages | `Content-Language` + `Vary: Accept-Language` |
| `Content-Type` | both | format of *this* message body | — |
| `Vary` | response | headers the selection depended on | defines the cache key |
| `Accept-Post` / `Accept-Patch` | response | media types this target accepts | returned on `OPTIONS` and `415` |
| `X-Content-Type-Options: nosniff` | response | forbid MIME sniffing | mandatory on every API response |

Status codes: `406` when nothing matches `Accept` (list `available` in a problem+json body); `415` when the request `Content-Type` is unsupported (include `Accept-Post`/`Accept-Patch`); `200` + `Vary` for ordinary proactive negotiation; `300 Multiple Choices` for reactive negotiation, which almost nothing implements.

**Flash cards**

- **`Accept` vs `Content-Type`?** → `Accept` = what I want back; `Content-Type` = what's in *this* message body.
- **`406` vs `415`?** → `406` = can't produce what you asked for; `415` = can't read what you sent.
- **Why must you send `Vary`?** → The cache key is URL + the headers named in `Vary`; without it, caches serve the wrong representation.
- **How do you version by media type?** → `application/vnd.org.thing+json; version=2` — a parameter, not a string baked into the subtype.
- **How is `Accept` ranked?** → Specificity first (exact > `type/*` > `*/*`), then `q`; `q=0` means unacceptable.

## 11. Hands-On Exercises & Mini Project

- [ ] Write an `Accept` parser that correctly ranks by specificity then `q`, honours `q=0`, and handles parameters; test it against the real `Accept` headers sent by Chrome, `curl`, Python `requests` and Go's `net/http`.
- [ ] Add `text/csv` as a second representation of an existing JSON endpoint, with correct `Content-Type`, `Content-Disposition`, per-representation `ETag`, and `Vary`; then deliberately omit `Vary: Accept` behind a caching proxy and reproduce the wrong-format bug.
- [ ] Serve two schema versions of one resource via `application/vnd.<you>.<thing>+json; version=1|2`, write contract tests for both, then measure cache hit rate with raw `Accept` in the cache key versus a normalised four-value key.

### Mini Project — The Multi-Representation Report API

**Goal.** Build a reporting resource that serves four representations from one URI with correct caching, then prove the caching is correct under a real shared cache.

**Requirements.**
1. `GET /v1/reports/{report_id}` supporting `application/json`, `application/vnd.zariya.report+json; version=2`, `text/csv`, and `application/pdf`.
2. A shared `negotiate()` dependency implementing specificity-then-`q` ranking, returning `406` with a problem+json body listing `available` when nothing matches.
3. Per-representation `ETag`s derived from `(report_version, media_type)`, with `If-None-Match` handled **before** any expensive rendering.
4. `Vary: Accept, Accept-Encoding` on every response; `Cache-Control: private` on anything user-specific.
5. `OPTIONS` returning `Allow`, `Accept-Post` and `Accept-Patch`; `415` with `Accept-Post` on a bad request `Content-Type`.
6. An edge normalisation function collapsing `Accept` to four canonical values, plus a benchmark showing hit rate with and without it, and PDF generation moved off the synchronous path (`202` + job link for large reports).

**Extensions.**
- Add `Accept-Language` with `Content-Language` and a third `Vary` dimension; measure the cache-fragmentation cost.
- Implement reactive negotiation: return `300 Multiple Choices` with a list of alternates and a `Link` header per representation.
- Add a metric `responses_total{media_type, version}` and a dashboard showing the v1 → v2 migration curve.
- Harden the renderers: disable XML external entities, sandbox the PDF renderer's network access, and cap output size — then write tests proving an XXE payload and an SSRF payload both fail safely.

## 12. Related Topics & Free Learning Resources

**Sibling chapters.** *Caching, ETags & Conditional Requests* is the other half of everything `Vary` touches; *Versioning & Deprecation* compares media-type versioning with URL and header versioning; *Request & Response Payload Design* defines the JSON these media types wrap; *HTTP Status Codes Done Right* covers `406`, `415` and `300`; *HATEOAS & Hypermedia APIs* uses media types (`application/hal+json`) as the hypermedia contract; *Naming Conventions* governs how you name a vendor type.

- **RFC 9110 — HTTP Semantics, §12 Content Negotiation** — IETF · *Advanced* · the normative rules for `Accept`, `q` values, proactive vs reactive negotiation, and `406`. <https://www.rfc-editor.org/rfc/rfc9110.html#name-content-negotiation>
- **RFC 9111 — HTTP Caching, §4.1 Calculating Cache Keys with Vary** — IETF · *Advanced* · exactly how `Vary` changes the cache key; read this before enabling negotiation behind a CDN. <https://www.rfc-editor.org/rfc/rfc9111.html#name-calculating-cache-keys-with>
- **MDN — Content negotiation** — Mozilla · *Beginner* · the clearest explanation of `Accept`, `q` values and the selection algorithm, with real browser header examples. <https://developer.mozilla.org/en-US/docs/Web/HTTP/Content_negotiation>
- **MDN — Vary** — Mozilla · *Intermediate* · the header's semantics plus the practical caching caveats. <https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Vary>
- **IANA Media Types registry** — IANA · *Beginner* · check before inventing a type; also the reference for the `vnd.` and `prs.` trees. <https://www.iana.org/assignments/media-types/media-types.xhtml>
- **RFC 6838 — Media Type Specifications and Registration Procedures** — IETF · *Intermediate* · how to name and register a vendor media type properly, including structured suffixes. <https://www.rfc-editor.org/rfc/rfc6838.html>
- **GitHub REST API — Media types** — GitHub · *Beginner* · a working, public example of vendor media types used for both format and version selection. <https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api#media-types>
- **web.dev — Love your cache** — Google · *Intermediate* · practical guidance on cache keys, `Vary`, and why normalisation matters at the edge. <https://web.dev/articles/love-your-cache>

---

*REST API Handbook — chapter 11.*
