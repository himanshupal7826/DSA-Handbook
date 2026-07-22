# 22 · TLS, CORS & Security Headers

> **In one line:** TLS protects bytes in transit, the same-origin policy protects one site's data from another site's JavaScript, CORS is the *controlled relaxation* of that policy, and security headers are the cheap declarative controls that close what remains.

---

## 1. Overview

Three distinct mechanisms get bundled into "web security" and confused constantly. **TLS** is a transport-layer protocol that gives you confidentiality, integrity and server authentication on the wire — it says nothing about who may call your API from where. The **same-origin policy (SOP)** is a browser rule: script from `https://app.acme.io` cannot *read* responses from `https://api.acme.io` unless the latter opts in. **CORS** (Cross-Origin Resource Sharing, now part of the WHATWG Fetch standard) is that opt-in protocol. **Security headers** are per-response directives — HSTS, CSP, `X-Content-Type-Options` — that tell the browser to enforce additional constraints.

The problem each solves is different. Before ubiquitous TLS, any coffee-shop Wi-Fi could read session cookies off the wire (Firesheep, 2010, made this a mainstream scandal). Before SOP, any website could read your webmail by simply fetching it with your cookies attached. Before CORS, legitimate cross-origin APIs were forced into ugly workarounds — JSONP, which is literally "execute arbitrary script from another origin", and cross-domain Flash policy files, both of which caused their own breaches.

The lineage: SSL 3.0 (1996) → TLS 1.0 (RFC 2246, 1999) → TLS 1.2 (RFC 5246, 2008) → **TLS 1.3 (RFC 8446, 2018)**, which cut the handshake to one round trip, removed every algorithm with a known weakness (RC4, 3DES, static RSA key exchange, MD5/SHA-1 signatures, renegotiation, compression), and made forward secrecy mandatory. SSL 3.0 and TLS 1.0/1.1 are formally deprecated (RFC 7568, RFC 8996). CORS was standardised by the W3C in 2014 and folded into the Fetch spec, which is now the normative reference. HSTS is RFC 6797; CSP Level 3 is a W3C specification.

A concrete example: **Stripe's API**. `api.stripe.com` requires TLS 1.2+, publishes HSTS with a two-year `max-age` and `preload`, and — crucially — **does not send CORS headers for secret-key endpoints at all**. That is deliberate: Stripe does not want your secret key in browser JavaScript, so the browser's own SOP enforces the architecture. Stripe.js talks to a *different*, purpose-built origin with publishable keys. That is the mature pattern: CORS policy is an architectural statement about which clients are allowed to exist, not a checkbox to make a console error disappear.

The framing that separates senior engineers from juniors: **CORS is not a server-side access control.** It constrains browsers only. `curl`, Postman, a mobile app and any server-side attacker ignore it entirely. `Access-Control-Allow-Origin: *` on a public, unauthenticated endpoint is fine; the same header on an endpoint that returns tenant data is meaningless as protection — the actual protection is the bearer token and the object-level check. CORS protects *your users from other websites*, not your API from attackers.

---

## 2. Core Concepts

- **Origin** — the tuple `(scheme, host, port)`. `https://acme.io` and `https://acme.io:8443` are different origins; so are `http://` and `https://` versions of the same host.
- **Same-origin policy** — a browser rule preventing script on one origin from *reading* responses from another. Cross-origin *sending* is often still allowed (which is why CSRF exists).
- **Simple request** — a cross-origin request that skips preflight: method `GET`/`HEAD`/`POST`, only CORS-safelisted headers, and `Content-Type` limited to `text/plain`, `multipart/form-data` or `application/x-www-form-urlencoded`.
- **Preflight** — an automatic `OPTIONS` request the browser sends before a non-simple request, carrying `Access-Control-Request-Method` and `Access-Control-Request-Headers`.
- **`Access-Control-Allow-Credentials`** — permits cookies and TLS client certs on cross-origin requests. Cannot be combined with `Access-Control-Allow-Origin: *`.
- **HSTS** — `Strict-Transport-Security`, which tells the browser to use HTTPS for this host for `max-age` seconds, eliminating the plaintext first hop that SSL-stripping attacks exploit.
- **CSP** — `Content-Security-Policy`, an allow-list of what a document may load and execute. The main defence-in-depth against XSS.
- **Forward secrecy** — the property that compromising the server's long-term private key does not decrypt past sessions. Mandatory in TLS 1.3 via ephemeral (EC)DHE.
- **Certificate Transparency** — public append-only logs of issued certificates (RFC 6962), which browsers require so mis-issuance is detectable.
- **mTLS** — mutual TLS: the client also presents a certificate, giving cryptographic client authentication independent of bearer tokens.

---

## 3. Theory & Principles

**What TLS actually gives you.** Three properties, and it is worth being precise: *confidentiality* (an on-path observer sees ciphertext, though not hidden metadata — SNI, IP, packet sizes and timing all leak), *integrity* (AEAD ciphers detect any modification), and *server authentication* (the certificate chain proves you are talking to the host you asked for, assuming the CA system holds). It does **not** give you client authentication (unless mTLS), non-repudiation, or any guarantee about what the server does with your data after decryption.

**The TLS 1.3 handshake, one round trip.** ClientHello carries the supported cipher suites *and* a key share guess (usually X25519). ServerHello returns its key share; both sides derive the shared secret immediately, so everything after ServerHello — including the certificate — is encrypted. Compare TLS 1.2, which needed two round trips and sent the certificate in the clear. On a 80 ms RTT link that is 80 ms saved on every new connection. TLS 1.3 also offers 0-RTT resumption, which sends application data in the first flight — but 0-RTT data is **replayable**, so restrict it to safe, idempotent requests or disable it on APIs that mutate state.

**Why the same-origin policy exists, and precisely what it blocks.** Ambient authority: browsers attach cookies to requests based on destination, not on who initiated them. Without SOP, `evil.com` could `fetch('https://bank.com/accounts')` with your cookies and read the response. SOP blocks the *read*. It does not block the *send* — a cross-origin `<form>` POST or a simple `fetch` still reaches your server with cookies attached, which is exactly the CSRF attack, mitigated separately by `SameSite` cookies and CSRF tokens.

**Preflight logic.** The browser preflights when a request could not have been made by pre-CORS HTML. `PUT`, `DELETE`, `PATCH`, `Content-Type: application/json`, and any custom header (`Authorization` counts, since it is not safelisted) all trigger it. The preflight is a real HTTP round trip — `OPTIONS` with no body — and its result is cacheable for `Access-Control-Max-Age` seconds. Browsers cap this: Chromium honours at most 7200 s (2 h), Firefox 86400 s. Setting `Access-Control-Max-Age: 600` on a chatty API removes a full RTT from most requests.

**The credentials rule is a hard constraint, not a suggestion.** If the request carries credentials (`fetch(..., {credentials: 'include'})`), then `Access-Control-Allow-Origin` must be a *specific* origin — the wildcard is rejected — and `Access-Control-Allow-Headers`/`-Methods` may not be `*` either. This exists to stop a server from accidentally exposing authenticated data to every origin on the internet with one lazy header.

**Reflecting `Origin` is the classic disaster.** `Access-Control-Allow-Origin: <whatever the client sent>` plus `Allow-Credentials: true` is equivalent to disabling SOP for your API. Equally bad: regex matching like `^https://.*acme\.io$`, which matches `https://evil-acme.io` (unescaped dot) or `https://acme.io.evil.com` (unanchored). Always compare against an exact allow-list of full origin strings.

```svg
<svg viewBox="0 0 780 360" width="100%" height="360" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="780" height="360" fill="#ffffff"/>
  <text x="18" y="24" font-size="15" font-weight="700" fill="#1e293b">Same-origin policy: what is blocked, what is not</text>
  <rect x="18" y="42" width="352" height="130" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="34" y="64" font-size="13" font-weight="700" fill="#1e293b">SOP BLOCKS the READ</text>
  <text x="34" y="86" font-size="11" fill="#1e293b">evil.com script calls fetch("https://bank.io/me")</text>
  <text x="34" y="104" font-size="11" fill="#1e293b">request may still be SENT with cookies</text>
  <text x="34" y="122" font-size="11" fill="#1e293b">response body is hidden from the caller</text>
  <text x="34" y="140" font-size="11" fill="#1e293b">unless bank.io sends Access-Control-Allow-Origin</text>
  <text x="34" y="160" font-size="11" font-weight="700" fill="#16a34a">This is what CORS relaxes.</text>
  <rect x="394" y="42" width="368" height="130" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="410" y="64" font-size="13" font-weight="700" fill="#1e293b">SOP DOES NOT BLOCK the SEND</text>
  <text x="410" y="86" font-size="11" fill="#1e293b">cross-origin form POST still arrives</text>
  <text x="410" y="104" font-size="11" fill="#1e293b">cookies attach by destination, not by initiator</text>
  <text x="410" y="122" font-size="11" fill="#1e293b">side effects happen even if the reply is unread</text>
  <text x="410" y="140" font-size="11" fill="#1e293b">this gap is CSRF</text>
  <text x="410" y="160" font-size="11" font-weight="700" fill="#d97706">Fix: SameSite cookies + CSRF token, not CORS.</text>
  <rect x="18" y="190" width="744" height="72" rx="10" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="34" y="212" font-size="13" font-weight="700" fill="#1e293b">Preflight triggers (anything pre-CORS HTML could not have sent)</text>
  <text x="34" y="234" font-size="11" fill="#1e293b">method not in GET / HEAD / POST  &#8226;  Content-Type: application/json  &#8226;  any non-safelisted header</text>
  <text x="34" y="252" font-size="11" fill="#1e293b">Authorization is NOT safelisted, so token-authenticated calls always preflight.</text>
  <rect x="18" y="280" width="744" height="66" rx="10" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="34" y="302" font-size="13" font-weight="700" fill="#1e293b">The hard credentials rule</text>
  <text x="34" y="324" font-size="11" fill="#1e293b">credentials: "include"  &#8594;  Allow-Origin must be an EXACT origin. Wildcard is rejected by the browser.</text>
  <text x="34" y="340" font-size="11" font-weight="700" fill="#1e293b">Never reflect the Origin header. Never regex-match it. Use an exact allow-list.</text>
</svg>
```

**Security headers, ranked by value for an API.** For a JSON API the priority order is: `Strict-Transport-Security` (removes the plaintext hop), `X-Content-Type-Options: nosniff` (stops a JSON response being interpreted as HTML/script), `Cache-Control: no-store` on anything sensitive, `Content-Security-Policy: default-src 'none'` (an API serves no documents, so lock it to nothing), `Referrer-Policy: no-referrer`, and `X-Frame-Options`/`frame-ancestors 'none'`. `X-XSS-Protection` is obsolete and should be omitted — the legacy auditor it enabled introduced its own vulnerabilities and has been removed from browsers.

---

## 4. Architecture & Workflow

A cross-origin, credentialed API call from `https://app.acme.io` to `https://api.acme.io`, step by step:

1. **DNS + TCP.** The browser resolves `api.acme.io` and opens TCP (or QUIC for HTTP/3).
2. **TLS 1.3 handshake.** ClientHello with cipher suites, supported groups and a X25519 key share plus SNI. ServerHello with the chosen suite and its key share; from that point the channel is encrypted, including the certificate. The browser validates the chain to a trusted root, checks hostname, validity dates, revocation signals and Certificate Transparency SCTs.
3. **HSTS registration.** On the response, `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` is recorded. Every subsequent navigation to `http://api.acme.io` is rewritten to HTTPS *by the browser*, before any packet leaves.
4. **Preflight decision.** The app calls `fetch('https://api.acme.io/v1/invoices', {method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer …'}, credentials:'omit'})`. Non-simple `Content-Type` and a non-safelisted header ⇒ preflight required.
5. **`OPTIONS` preflight.** Browser sends `Origin`, `Access-Control-Request-Method: POST`, `Access-Control-Request-Headers: authorization,content-type`. **No cookies, no `Authorization` header, no body** — your auth middleware must not reject it.
6. **Preflight response.** `204 No Content` with `Access-Control-Allow-Origin: https://app.acme.io`, `-Allow-Methods`, `-Allow-Headers`, `-Max-Age: 600`, and `Vary: Origin` (critical if any cache sits in front).
7. **Preflight cache.** The browser caches the decision per (origin, URL, method) for `Max-Age`, so subsequent POSTs skip step 5 entirely.
8. **Actual request.** The real `POST` goes out with `Origin` and `Authorization`.
9. **Response and header check.** The server echoes `Access-Control-Allow-Origin` on the *actual* response too — omitting it here is the single most common CORS bug, because the preflight passed and developers assume they are done. If the app needs to read `ETag` or `X-Request-Id`, the server must list them in `Access-Control-Expose-Headers`; otherwise only the safelisted response headers are visible to script.
10. **Error responses count.** A `500` or `429` without CORS headers surfaces in the browser as an opaque network error with no status code, making outages undebuggable. Emit CORS headers on *every* response, including errors, from a layer that runs before your error handler.

```svg
<svg viewBox="0 0 780 380" width="100%" height="380" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="780" height="380" fill="#ffffff"/>
  <text x="18" y="24" font-size="15" font-weight="700" fill="#1e293b">Preflight then actual request: the full exchange</text>
  <rect x="18" y="42" width="150" height="40" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="36" y="67" font-size="12" font-weight="700" fill="#1e293b">app.acme.io</text>
  <rect x="600" y="42" width="162" height="40" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="620" y="67" font-size="12" font-weight="700" fill="#1e293b">api.acme.io</text>
  <g stroke="#94a3b8" stroke-width="1" stroke-dasharray="4 4"><line x1="93" y1="82" x2="93" y2="368"/><line x1="681" y1="82" x2="681" y2="368"/></g>
  <rect x="18" y="96" width="744" height="106" rx="10" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="34" y="118" font-size="12" font-weight="700" fill="#1e293b">STEP 1 &#8212; PREFLIGHT (browser generated, no cookies, no body)</text>
  <text x="34" y="138" font-size="11" fill="#1e293b">OPTIONS /v1/invoices    Origin: https://app.acme.io</text>
  <text x="34" y="154" font-size="11" fill="#1e293b">Access-Control-Request-Method: POST</text>
  <text x="34" y="170" font-size="11" fill="#1e293b">Access-Control-Request-Headers: authorization, content-type</text>
  <text x="34" y="192" font-size="11" font-weight="700" fill="#4f46e5">204  Allow-Origin: https://app.acme.io  Allow-Methods: POST  Max-Age: 600  Vary: Origin</text>
  <line x1="93" y1="212" x2="677" y2="212" stroke="#0ea5e9" stroke-width="2"/>
  <polygon points="681,212 673,208 673,216" fill="#0ea5e9"/>
  <text x="240" y="206" font-size="10" fill="#1e293b">cached for 600s per (origin, url, method)</text>
  <rect x="18" y="226" width="744" height="102" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="34" y="248" font-size="12" font-weight="700" fill="#1e293b">STEP 2 &#8212; ACTUAL REQUEST</text>
  <text x="34" y="268" font-size="11" fill="#1e293b">POST /v1/invoices    Origin: https://app.acme.io    Authorization: Bearer eyJ...</text>
  <text x="34" y="284" font-size="11" fill="#1e293b">Content-Type: application/json</text>
  <text x="34" y="306" font-size="11" font-weight="700" fill="#16a34a">201  Location: /v1/invoices/inv_9f2  Allow-Origin: https://app.acme.io  Vary: Origin</text>
  <text x="34" y="322" font-size="11" fill="#1e293b">Access-Control-Expose-Headers: ETag, Location, X-Request-Id</text>
  <rect x="18" y="340" width="744" height="34" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="34" y="362" font-size="11" font-weight="700" fill="#1e293b">Forgetting Allow-Origin on the ACTUAL response (or on 4xx/5xx) is the #1 CORS bug.</text>
</svg>
```

---

## 5. Implementation

**A correct, explicit CORS layer (FastAPI):**

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

ALLOWED = {"https://app.acme.io", "https://admin.acme.io"}   # exact strings, no regex

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(ALLOWED),      # never ["*"] with credentials
    allow_credentials=False,            # True only if you truly use cookies
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type", "Idempotency-Key"],
    expose_headers=["ETag", "Location", "X-Request-Id", "RateLimit-Remaining"],
    max_age=600,
)

@app.middleware("http")
async def security_headers(request, call_next):
    r = await call_next(request)
    r.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains; preload"
    r.headers["X-Content-Type-Options"] = "nosniff"
    r.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'"
    r.headers["Referrer-Policy"] = "no-referrer"
    r.headers["Cross-Origin-Resource-Policy"] = "same-site"
    r.headers.setdefault("Cache-Control", "no-store")
    r.headers["Vary"] = ", ".join(filter(None, [r.headers.get("Vary"), "Origin"]))
    return r
```

**The exchange on the wire:**

```http
OPTIONS /v1/invoices HTTP/1.1
Host: api.acme.io
Origin: https://app.acme.io
Access-Control-Request-Method: POST
Access-Control-Request-Headers: authorization,content-type,idempotency-key
```

```http
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: https://app.acme.io
Access-Control-Allow-Methods: GET, POST, PATCH, DELETE
Access-Control-Allow-Headers: Authorization, Content-Type, Idempotency-Key
Access-Control-Max-Age: 600
Vary: Origin, Access-Control-Request-Method, Access-Control-Request-Headers
```

```http
POST /v1/invoices HTTP/1.1
Host: api.acme.io
Origin: https://app.acme.io
Authorization: Bearer eyJhbGciOiJFUzI1NiJ9...
Content-Type: application/json
Idempotency-Key: 01J8Z4K7QW3

{"customer_id": "cus_71a", "amount_cents": 480000, "currency": "eur"}
```

```http
HTTP/1.1 201 Created
Location: /v1/invoices/inv_9f2
Content-Type: application/json
Access-Control-Allow-Origin: https://app.acme.io
Access-Control-Expose-Headers: ETag, Location, X-Request-Id
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Content-Type-Options: nosniff
Cache-Control: no-store
Vary: Origin

{"id": "inv_9f2", "status": "open", "amount_cents": 480000}
```

**Express, when you need dynamic origin logic:**

```javascript
import cors from 'cors';
const ALLOWED = new Set(['https://app.acme.io', 'https://admin.acme.io']);

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, false);          // curl / server-to-server: no CORS headers
    return ALLOWED.has(origin)                    // exact match only
      ? cb(null, origin)
      : cb(null, false);                          // omit headers; do NOT throw a 500
  },
  credentials: false,
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
  exposedHeaders: ['ETag', 'Location', 'X-Request-Id'],
  maxAge: 600,
}));
app.use((_req, res, next) => { res.setHeader('Vary', 'Origin'); next(); });
```

**Cookie-based sessions (BFF pattern) need three attributes, all of them:**

```http
Set-Cookie: sid=v1.8fa2...; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600
```

`HttpOnly` keeps JavaScript (and therefore XSS) away from it; `Secure` prevents it going over plaintext; `SameSite=Lax` blocks it on cross-site POSTs, which kills most CSRF. If you genuinely need cross-site cookies you must use `SameSite=None; Secure`, and then you *must* add CSRF tokens back.

**Verifying your TLS configuration:**

```bash
# Negotiated version, cipher and cert chain
openssl s_client -connect api.acme.io:443 -servername api.acme.io -tls1_3 </dev/null 2>/dev/null \
  | grep -E 'Protocol|Cipher|Verify return code'

# Confirm legacy protocols are refused (should fail)
openssl s_client -connect api.acme.io:443 -tls1_1 </dev/null 2>&1 | grep -i 'alert|failure'

# Headers on a real response
curl -sSI https://api.acme.io/v1/health | grep -iE 'strict-transport|content-type-options|content-security|vary'

# Prove CORS is not an access control
curl -sS https://api.acme.io/v1/invoices -H 'Authorization: Bearer '"$TOKEN"   # succeeds; no browser involved
```

**Optimization note.** Preflights are pure latency: an extra RTT before every non-simple request. Four levers, in order of impact: (1) set `Access-Control-Max-Age` to 600–7200 s so the browser caches the decision (Chromium caps at 7200); (2) **serve preflights at the edge** — a CDN or gateway can answer `OPTIONS` in single-digit milliseconds without waking your origin; (3) avoid gratuitous custom headers, since each one widens `Access-Control-Request-Headers` and can invalidate a cached preflight; (4) prefer same-site deployment (`app.acme.io` + `api.acme.io` behind one edge with path routing) so many calls become same-origin and skip CORS entirely. On the TLS side, enable session resumption and OCSP stapling, keep certificate chains short, and enable HTTP/2 or HTTP/3 so connection setup is amortised across many requests. Terminate TLS at the edge but **re-encrypt to the origin** — plaintext inside the datacentre is how lateral movement becomes data exfiltration.

---

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| TLS 1.3 | 1-RTT handshake, mandatory forward secrecy, all weak algorithms removed | 0-RTT resumption data is replayable; must be disabled for non-idempotent requests |
| HSTS + preload | Eliminates the plaintext first hop and SSL-stripping entirely | Preload removal takes months; a broken cert becomes a hard outage with no click-through |
| CORS allow-list | Precise control over which web origins may read your responses | Zero protection against non-browser clients; easy to misconfigure into full bypass |
| Preflight caching | Removes an RTT from most cross-origin calls | Stale cached decisions during a policy change; capped at 2 h in Chromium |
| `Allow-Origin: *` | Simple, cacheable, ideal for public read-only endpoints | Illegal with credentials; a footgun if the endpoint ever becomes authenticated |
| Cookie sessions + BFF | Tokens never reach JavaScript; XSS cannot exfiltrate a refresh token | Reintroduces CSRF; needs `SameSite`, CSRF tokens and a proxy tier |
| Bearer tokens in headers | Immune to CSRF by construction; trivial for non-browser clients | Always triggers preflight; vulnerable to XSS exfiltration if stored in the DOM |
| CSP on an API | `default-src 'none'` is a one-line, zero-risk hardening | Almost no value if you never serve HTML — spend the effort on the front end instead |
| mTLS | Cryptographic client identity; stolen bearer tokens become useless | Certificate lifecycle, rotation and revocation for every client |

---

## 7. Common Mistakes & Best Practices

1. ⚠️ **Reflecting the `Origin` header into `Access-Control-Allow-Origin` with `Allow-Credentials: true`.** → ✅ Compare against an exact allow-list of full origin strings. Reflection plus credentials is a complete SOP bypass for your API.
2. ⚠️ **Regex origin matching like `/acme\.io$/` or `/^https:\/\/.*acme.io/`.** → ✅ Unanchored or unescaped patterns match `evil-acme.io` and `acme.io.evil.com`. Use set membership on the exact string.
3. ⚠️ **Treating CORS as access control.** → ✅ CORS constrains browsers only; `curl` ignores it. Authentication, authorization and object-level checks are the actual controls.
4. ⚠️ **Requiring authentication on `OPTIONS`.** → ✅ Preflights carry no credentials by design. Handle `OPTIONS` *before* auth middleware, or every cross-origin call fails with an opaque error.
5. ⚠️ **Sending CORS headers on the preflight but not on the actual response, or not on 4xx/5xx.** → ✅ Emit them from an outermost middleware so errors are readable in the browser too; otherwise your outages look like network failures with no status code.
6. ⚠️ **Omitting `Vary: Origin` behind a CDN.** → ✅ Without it a cache can serve a response containing origin A's `Allow-Origin` header to origin B — a cache-poisoning class bug.
7. ⚠️ **Assuming the client can read every response header.** → ✅ Only CORS-safelisted headers are exposed; `ETag`, `Location`, `X-Request-Id` and `RateLimit-*` need explicit `Access-Control-Expose-Headers`.
8. ⚠️ **HSTS with `includeSubDomains` before every subdomain has valid certs.** → ✅ Roll out with a short `max-age` (300 s), verify all subdomains, then ramp to two years and only then submit for preload. Preload is effectively one-way for months.
9. ⚠️ **Terminating TLS at the load balancer and using plaintext inside the network.** → ✅ Re-encrypt origin-side or use a service mesh with mTLS. "The datacentre is trusted" is not a security model.
10. ⚠️ **Enabling TLS 1.3 0-RTT on mutating endpoints.** → ✅ 0-RTT early data is replayable by an on-path attacker. Restrict it to safe, idempotent `GET`s or turn it off.
11. ⚠️ **Shipping `X-XSS-Protection` and skipping `nosniff`.** → ✅ `X-XSS-Protection` is obsolete and was itself exploitable; `X-Content-Type-Options: nosniff` is the one that matters, preventing a JSON body from being sniffed as HTML.
12. ⚠️ **Setting `SameSite=None` without understanding it.** → ✅ It re-enables cross-site cookie sending and therefore CSRF. Use `Lax` by default, pair `None` with CSRF tokens and `Secure`, and never send session cookies without `HttpOnly`.

---

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** CORS failures are deliberately opaque in the browser — script sees a generic `TypeError: Failed to fetch` with no status. Work from the network panel, not the console: check whether the `OPTIONS` fired, what it returned, and whether the *actual* response carried `Access-Control-Allow-Origin`. Reproduce server-side with `curl -H 'Origin: https://app.acme.io' -X OPTIONS -i` — if the headers are right there and wrong in the browser, an intermediary (CDN, WAF, ingress) is stripping or rewriting them. For TLS, `openssl s_client` and `curl -v` show the negotiated version and chain; `Verify return code: 0 (ok)` is what you want, and code 20/21 usually means a missing intermediate certificate that works in browsers (which fetch it) but breaks `curl` and mobile clients.

**Monitoring.** Track TLS version and cipher distribution across connections (you cannot deprecate TLS 1.2 without knowing who still uses it), certificate expiry with alerts at 30/14/7 days, `OPTIONS` request volume and its ratio to real requests (a high ratio means your `Max-Age` is too low or headers keep changing), and per-origin rejection counts on the CORS layer — a spike from an unknown origin is either a new internal app nobody told you about or someone testing. Add a synthetic check that asserts the presence of `Strict-Transport-Security`, `X-Content-Type-Options` and correct `Access-Control-Allow-Origin` on both a `200` and a `500`, and fail the deploy if they regress. Certificate Transparency monitoring (via `crt.sh` or a commercial feed) alerts you when *anyone* issues a certificate for your domain.

**Security.** Baseline: TLS 1.2 minimum (1.3 preferred), AEAD suites only, ECDSA P-256 or RSA-2048+ keys, OCSP stapling, HSTS with a two-year `max-age` and `includeSubDomains`. Automate renewal (ACME/Let's Encrypt or your cloud CA) so expiry is never a human responsibility. Publish a CAA DNS record restricting which CAs may issue for your domain. Keep the CORS allow-list in configuration, code-reviewed, and identical across environments in *structure* even when the values differ — most CORS incidents start as "we allowed `*` in staging" and get promoted. For internal service-to-service traffic use mTLS and treat the certificate identity, not a network location, as the principal. Never put tokens in URLs; they land in access logs, CDN logs, `Referer` headers and browser history regardless of TLS.

**Performance & scaling.** TLS handshakes are the expensive part of a connection, so maximise reuse: HTTP/2 multiplexes many requests per connection, keep-alive timeouts should exceed typical client idle gaps, and session tickets should be rotated frequently but not so aggressively that resumption fails. Offload `OPTIONS` to the edge. Under load, remember that HSTS and CSP headers are sent on *every* response — keep them short, and prefer HTTP/2's HPACK (which compresses repeated headers to a few bytes) over manually trimming them. If you serve a global audience, terminate TLS at the nearest PoP: cutting RTT from 200 ms to 20 ms saves a full handshake's worth of latency per new connection.

---

## 9. Interview Questions

**Q: What exactly does the same-origin policy prevent?**
A: It prevents script on one origin from *reading* responses from a different origin. It does not prevent the request from being sent, and cookies still attach by destination — which is precisely why CSRF exists and is mitigated separately with `SameSite` cookies and CSRF tokens.

**Q: When does a browser send a preflight?**
A: Whenever the request could not have been made by pre-CORS HTML: a method other than `GET`/`HEAD`/`POST`, a `Content-Type` outside the three safelisted values, or any non-safelisted header. Since `Authorization` is not safelisted and JSON bodies are not safelisted, virtually every authenticated API call preflights.

**Q: Why can't you use `Access-Control-Allow-Origin: *` with credentials?**
A: The Fetch spec forbids it — a browser rejects a credentialed response whose `Allow-Origin` is the wildcard. Allowing it would mean one careless header exposes authenticated data to every origin on the internet, so the spec forces you to name a specific origin.

**Q: Is CORS a security control for your API?**
A: No. It is a browser-enforced relaxation of the same-origin policy that protects *your users* from other websites reading their data. Any non-browser client ignores it entirely, so authentication, authorization and object-level checks remain the real controls.

**Q: What does HSTS do that a redirect from HTTP to HTTPS does not?**
A: A redirect still requires one plaintext request, which an on-path attacker can intercept and strip (SSL-stripping). HSTS makes the *browser* rewrite `http://` to `https://` before any packet leaves, and preloading ships that instruction with the browser so even the very first visit is protected.

**Q: Which security headers actually matter for a JSON API?**
A: `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` on sensitive responses, and `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` since an API serves no documents. `X-XSS-Protection` is obsolete and should be omitted.

**Q: Why is `Vary: Origin` important?**
A: Because the response body may be identical while the `Access-Control-Allow-Origin` header differs per requester. Without `Vary: Origin`, a shared cache or CDN can serve origin A's headers to origin B, effectively poisoning the CORS decision.

**Q: (Senior) A team wants `Access-Control-Allow-Origin` reflected from the request so partners can integrate. What do you propose instead?**
A: I would refuse reflection with credentials outright, since it is a full SOP bypass. The right design is a registered-origin model: partners register their origins, the value is served from a validated configuration store with exact string matching, and the response carries `Vary: Origin`. If the partner integration is server-to-server, CORS is irrelevant — issue them API credentials and drop the browser path entirely.

**Q: (Senior) You must deprecate TLS 1.0/1.1 on a public API with unknown clients. Plan it.**
A: First measure: log negotiated TLS version and cipher per connection, attributed to API key or user agent, and build a report of affected clients. Then communicate with a dated deprecation notice, `Sunset` headers and direct outreach to the identified clients. Run scheduled brownouts — short windows where legacy protocols are refused — to surface clients that ignored the notice, then enforce permanently while keeping a documented, time-boxed exception endpoint if a regulated partner genuinely cannot migrate.

**Q: (Senior) Design browser-facing auth for a SPA on `app.acme.io` calling `api.acme.io`. Cookies or bearer tokens?**
A: I would deploy a backend-for-frontend on the same site as the SPA, holding OAuth tokens server-side and giving the browser only an `HttpOnly; Secure; SameSite=Lax` session cookie — that keeps tokens out of JavaScript entirely so XSS cannot exfiltrate a refresh token, and `SameSite=Lax` handles CSRF. If a BFF is not possible, use bearer tokens in headers (immune to CSRF by construction), keep them in memory rather than `localStorage`, and accept the preflight cost with a generous `Access-Control-Max-Age`. The choice is really XSS exposure versus CSRF exposure, and the BFF wins because XSS is more common and more damaging.

**Q: What is TLS 1.3 0-RTT and why is it dangerous?**
A: 0-RTT lets a resuming client send application data in its very first flight, eliminating handshake latency. That data has no replay protection, so an on-path attacker can capture and resend it — which is fine for an idempotent `GET` but catastrophic for a payment. Restrict 0-RTT to safe methods or disable it.

**Q: Your frontend cannot read the `ETag` header your API returns cross-origin. Why?**
A: Only the CORS-safelisted response headers (`Cache-Control`, `Content-Language`, `Content-Length`, `Content-Type`, `Expires`, `Last-Modified`, `Pragma`) are visible to script by default. Anything else — `ETag`, `Location`, `X-Request-Id`, `RateLimit-*` — must be named in `Access-Control-Expose-Headers`, or the browser hides it even though it arrived on the wire.

---

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** TLS 1.3 gives confidentiality, integrity and server authentication in one round trip with mandatory forward secrecy; enforce it with HSTS (`max-age=63072000; includeSubDomains; preload`) so the plaintext first hop disappears, and re-encrypt inside your network rather than trusting the datacentre. The **same-origin policy** blocks cross-origin *reads*, not *sends* — the send gap is CSRF, fixed with `SameSite` cookies and CSRF tokens, not with CORS. **CORS** is the opt-in that relaxes the read block: exact-match origin allow-lists (never reflection, never regex), `Allow-Credentials` incompatible with `*`, `Vary: Origin` always, CORS headers on *every* response including errors, `Access-Control-Expose-Headers` for anything beyond the safelist, and `Access-Control-Max-Age` to amortise preflight RTTs. CORS constrains browsers only — `curl` ignores it, so it is never your access control. For an API, the headers worth sending are HSTS, `nosniff`, `Cache-Control: no-store`, `CSP: default-src 'none'; frame-ancestors 'none'` and `Referrer-Policy: no-referrer`.

| Header | Value | Purpose |
|---|---|---|
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | Force HTTPS, kill SSL-stripping |
| `X-Content-Type-Options` | `nosniff` | Stop MIME sniffing of JSON as HTML |
| `Content-Security-Policy` | `default-src 'none'; frame-ancestors 'none'` | APIs serve no documents |
| `Referrer-Policy` | `no-referrer` | Keep URLs (and any tokens in them) out of `Referer` |
| `Cache-Control` | `no-store` | Sensitive responses must not be cached |
| `Access-Control-Allow-Origin` | exact origin (or `*` if public+anonymous) | Who may read the response |
| `Access-Control-Allow-Credentials` | `true` only with an exact origin | Cookies on cross-origin requests |
| `Access-Control-Expose-Headers` | `ETag, Location, X-Request-Id` | Beyond the safelist, script sees nothing |
| `Access-Control-Max-Age` | `600`–`7200` | Cache the preflight decision |
| `Vary` | `Origin` | Prevent cache poisoning of CORS headers |
| `Set-Cookie` | `HttpOnly; Secure; SameSite=Lax` | Session cookies, minimum viable |

**Flash cards**

- **Does CORS protect your API from attackers?** → No. It protects users from other *websites*; `curl` and mobile apps ignore it entirely.
- **What triggers a preflight?** → Non-simple method, `Content-Type: application/json`, or any non-safelisted header — including `Authorization`.
- **Wildcard plus credentials?** → Rejected by the browser. Credentialed responses require an exact origin.
- **Why `Vary: Origin`?** → So a shared cache never serves one origin's `Allow-Origin` header to another.
- **What does HSTS add over an HTTPS redirect?** → It removes the plaintext first request entirely; the browser rewrites the scheme before sending anything.

---

## 11. Hands-On Exercises & Mini Project

- [ ] Serve a page on `http://localhost:3000` calling an API on `http://localhost:4000`; capture the preflight in DevTools, then set `Access-Control-Max-Age: 600` and prove subsequent calls skip it.
- [ ] Deliberately implement origin reflection with credentials, write an attacker page on a third origin that reads authenticated data, then fix it with an exact allow-list and re-run the attack.
- [ ] Return a `500` from your API and confirm the browser sees an opaque failure; move the CORS layer outside the error handler and confirm the status becomes readable.
- [ ] Run `openssl s_client` against your API to record the negotiated protocol and cipher, then disable TLS 1.1 and verify old clients fail loudly rather than silently downgrading.
- [ ] Score a deployment with an HTTP-header scanner, fix every finding, and add a synthetic test asserting HSTS and `nosniff` on both a `200` and a `404`.

**Mini Project — a hardened cross-origin API edge**

*Goal:* stand up an API whose transport and browser-facing security posture is correct and continuously verified.

*Requirements:*
1. TLS 1.2+ (1.3 preferred) with automated certificate renewal, OCSP stapling, and a CAA DNS record.
2. An exact-match CORS allow-list driven by configuration, applied as the outermost middleware so it covers 2xx, 4xx and 5xx alike, with `Vary: Origin` and a curated `Expose-Headers` list.
3. Preflight handling short-circuited before authentication, returning `204` with a tuned `Max-Age`, and served from the edge where possible.
4. A security-header middleware emitting HSTS, `nosniff`, `CSP: default-src 'none'`, `Referrer-Policy` and `Cache-Control: no-store`.
5. An automated test suite that asserts: wildcard is never sent with credentials, an unknown origin receives no CORS headers, headers are present on error responses, and TLS 1.0/1.1 handshakes are refused.

*Extensions:* add mTLS for a partner service-to-service path and compare its ergonomics to bearer tokens; add a BFF with `HttpOnly; SameSite=Lax` cookies and measure the XSS/CSRF trade-off; add Certificate Transparency monitoring with alerting; measure p50/p99 latency with and without edge-served preflights.

---

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *OAuth 2.0 & OpenID Connect* (chapter 19) covers the redirect flows that live inside these browser rules; *JWT: Structure, Validation & Pitfalls* (chapter 20) covers the credentials that ride over TLS; *Authorization: RBAC, ABAC & Scopes* (chapter 21) covers the real access controls CORS is often mistaken for; *OWASP API Security Top 10* (chapter 23) covers security misconfiguration (API8) in depth; *Rate Limiting, Quotas & Throttling* (chapter 24) covers the headers you must remember to expose.

- **MDN — Cross-Origin Resource Sharing (CORS)** — Mozilla · *Beginner* · the clearest practical reference, with exact preflight rules, safelisted headers and worked examples. <https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS>
- **WHATWG Fetch Standard — CORS protocol** — WHATWG · *Advanced* · the normative definition; go here when MDN and your framework disagree about an edge case. <https://fetch.spec.whatwg.org/#http-cors-protocol>
- **RFC 8446 — TLS 1.3** — IETF · *Advanced* · the handshake, key schedule and the explicit warnings about 0-RTT replay. <https://www.rfc-editor.org/rfc/rfc8446>
- **RFC 6797 — HTTP Strict Transport Security** — IETF · *Intermediate* · why the plaintext first hop matters and exactly what `includeSubDomains` commits you to. <https://www.rfc-editor.org/rfc/rfc6797>
- **Mozilla Server Side TLS Guidelines** — Mozilla · *Intermediate* · maintained modern/intermediate/old configuration profiles plus a generator for nginx, Apache, HAProxy and more. <https://wiki.mozilla.org/Security/Server_Side_TLS>
- **OWASP HTTP Security Response Headers Cheat Sheet** — OWASP · *Intermediate* · which headers to send, which are obsolete, and the reasoning behind each. <https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html>
- **web.dev — Same-origin policy and cross-origin isolation** — Google · *Beginner* · approachable explanations of SOP, CORP/COEP/COOP and when each applies. <https://web.dev/articles/same-origin-policy>
- **PortSwigger Web Security Academy — CORS** — PortSwigger · *Intermediate* · free labs exploiting origin reflection, null origin and trusted-subdomain misconfigurations. <https://portswigger.net/web-security/cors>

---

*REST API Handbook — chapter 22.*
