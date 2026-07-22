# 18 · API Authentication Fundamentals

> **In one line:** Authentication is the act of proving *who is calling* — and every scheme (API key, Basic, bearer, mTLS, HMAC signature) is a different trade between how easy the credential is to use and how catastrophic it is when it leaks.

---

## 1. Overview

Every API call arrives as bytes on a socket. Nothing in TCP, and nothing in HTTP itself, tells your service who sent them. **Authentication** is the layer you bolt on to answer that question: the caller attaches a credential, the server verifies it, and the request gains an *identity*. Only after that can you answer the second question — **authorization** — which is "is *this* identity allowed to do *this* thing to *this* object?" Conflating the two is the single most common source of security bugs in REST APIs, and it shows up directly in the wire protocol: `401 Unauthorized` means "I don't know who you are", `403 Forbidden` means "I know exactly who you are, and no".

HTTP has carried an authentication framework since 1996. The modern normative text is **RFC 9110 §11 (HTTP Semantics, June 2022)**, which obsoletes the old RFC 7235 and defines the whole dance: a server that rejects an unauthenticated request returns `401` with a `WWW-Authenticate` header naming one or more *challenges*; the client retries with an `Authorization` header carrying credentials in the named scheme. **RFC 7617** defines the `Basic` scheme, **RFC 6750** defines `Bearer`, and the IANA HTTP Authentication Scheme Registry lists the rest (`Digest`, `Negotiate`, `HOBA`, `Mutual`, `SCRAM-SHA-256`). What most APIs actually deploy is a small subset: a bearer token, a raw API key, mutual TLS, or a signed request.

The problem all of this exists to solve is that **credentials travel**. A password sitting in a database is at rest; a credential attached to an HTTP request crosses proxies, load balancers, CDNs, log pipelines, browser histories, `curl` shell history, CI environment dumps and screenshots. Schemes differ almost entirely in how much damage a single leaked copy does. A static API key is a *bearer* credential: whoever holds the bytes is the customer, forever, from anywhere, until someone notices. An HMAC-signed request is a *proof-of-possession* credential: the secret never crosses the wire at all, so a leaked request log is worthless to an attacker. mTLS goes further and binds identity to a private key held in a keystore or HSM that never leaves the host.

A concrete example makes the taxonomy click. **Stripe** issues secret keys shaped like `sk_live_51H8xK2...` — a prefix (`sk_live_`) that makes the credential greppable by secret scanners, plus high-entropy random bytes. You send it as `Authorization: Bearer sk_live_...` over TLS from your *server*, never from a browser. **AWS** does the opposite: your access key ID travels in the clear but the secret key is used to compute a **SigV4 HMAC-SHA256 signature** over the canonical request, so intercepting a request gives an attacker one replayable call within a 5-minute window, not a permanent credential. **GitHub** issues fine-grained PATs prefixed `github_pat_` with a checksum, publishes them to secret-scanning partners, and auto-revokes on detection. **Cloudflare, Kubernetes and most service meshes** authenticate machine-to-machine calls with mTLS client certificates. Four companies, four schemes, four different threat models — all correct for their context.

The rest of this chapter is a decision framework: what each scheme actually proves, where it fails, and how to store, rotate and revoke the resulting secrets. Chapter 19 covers **OAuth 2.0 & OpenID Connect** — the delegated-authorization framework that produces most bearer tokens you will encounter — and chapter 20 covers **JWT**, the most common bearer-token *format*. This chapter is the layer beneath both.

---

## 2. Core Concepts

- **Authentication (AuthN)** — establishing *who* is calling by verifying a credential. Produces a principal (user id, service account, tenant).
- **Authorization (AuthZ)** — deciding whether that principal may perform the requested operation on the requested resource. Always *after* AuthN, and never once: scope check, then object-level check.
- **Credential** — the secret or proof presented. Either **bearer** (possession is sufficient) or **proof-of-possession / sender-constrained** (you must demonstrate control of a key without revealing it).
- **`Authorization` header** — the request header carrying `<scheme> <credentials>` (RFC 9110 §11.6.2). `Proxy-Authorization` is its hop-by-hop twin for proxies.
- **`WWW-Authenticate`** — the response header on a `401` listing challenges the client may satisfy, e.g. `Bearer realm="api", error="invalid_token"` (RFC 9110 §11.6.1). A `401` without it is a protocol violation.
- **API key** — a long, opaque, high-entropy string identifying an application or account. Simple, static, and a bearer credential with no built-in expiry.
- **Basic auth** — `Authorization: Basic base64(user:password)`. Base64 is *encoding*, not encryption — it is plaintext credentials on every request.
- **Bearer token** — an opaque or JWT credential from RFC 6750, usually short-lived and issued by an authorization server. "Any party in possession of a bearer token can use it."
- **mTLS (mutual TLS)** — both sides present X.509 certificates during the TLS handshake; the server derives identity from the client cert's subject/SAN. Authentication happens *below* HTTP.
- **HMAC request signing** — the client computes `HMAC(secret, canonical_request)` and sends the digest; the server recomputes it. AWS SigV4 style. The secret never transits.
- **Key prefix** — a fixed, searchable string at the start of a credential (`sk_live_`, `github_pat_`) so scanners find leaked keys in repos and logs; **rotation** replaces a credential with an overlap window where both old and new are valid.

---

## 3. Theory & Principles

**The core asymmetry.** Authentication schemes divide cleanly into two families, and the split determines everything else:

| Family | What crosses the wire | Cost of a captured request |
|---|---|---|
| Bearer (API key, Basic, `Bearer` token) | the secret itself | total compromise until revoked |
| Proof-of-possession (HMAC, mTLS, DPoP) | a *derivation* of the secret | at most a replay inside a narrow window |

Bearer credentials are overwhelmingly more popular because they are trivial to use: one header, no client-side crypto, works from `curl`. That convenience is exactly the risk. RFC 6750 §1 says it plainly: *"any party in possession of a bearer token (a 'bearer') can use it to get access to the associated resources (without demonstrating possession of a cryptographic key)."* Every bearer scheme therefore depends on three external controls: TLS on every hop, short lifetimes, and fast revocation.

**Entropy, not obscurity.** An API key's only defence against guessing is length. A key drawn from a 62-character alphabet has ~5.95 bits per character; 32 characters gives ~190 bits, far past any brute-force horizon. Generate with a CSPRNG (`secrets.token_urlsafe(32)`, `crypto.randomBytes(32)`), never `Math.random()`, never a UUIDv4 alone (122 bits, and v1/v4 collisions and predictability have burned teams before). The *identifier* portion should be separate from the *secret* portion so you can look up the record without scanning.

**Hash keys at rest — but not with bcrypt.** An API key must be stored the way a password is: you keep a one-way digest, so a database dump does not hand over live credentials. The twist is that password hashes are deliberately *slow* (bcrypt/argon2 at ~100 ms), and you cannot afford 100 ms on every API request. Because a 190-bit random key has no dictionary structure to attack, a single fast hash is sufficient: store `SHA-256(key)` (optionally HMAC-SHA-256 with a server-side pepper held in a KMS). Lookup then becomes: parse the key's `id` prefix, fetch the row, compare digests in **constant time** (`hmac.compare_digest`). Never `SELECT ... WHERE key = ?` on the raw key, and never log the key.

**Why `401` and `403` are not interchangeable.** RFC 9110 §15.5.2 defines `401 Unauthorized` as "the request has not been applied because it lacks valid authentication credentials for the target resource" — and it **must** be accompanied by `WWW-Authenticate`. §15.5.4 defines `403 Forbidden` as "the server understood the request but refuses to fulfill it"; re-authenticating will not help. The practical decision table: no credential or a bad/expired one → `401`. Good credential, insufficient permission → `403`. Good credential, resource exists but this principal must not even learn it exists → `404` (hiding existence is a legitimate choice for tenant-scoped objects). A valid OAuth token missing a scope is `403` with `WWW-Authenticate: Bearer error="insufficient_scope"`.

**Signature schemes and canonicalization.** HMAC signing works only if client and server compute the *same* string to sign. AWS SigV4 constructs a canonical request from the method, URI-encoded path, sorted query string, sorted lowercase signed headers, the signed-header list and a hash of the body; then a string-to-sign including a timestamp and scope; then a derived signing key `HMAC(HMAC(HMAC(HMAC("AWS4"+secret, date), region), service), "aws4_request")`. The derivation matters: the daily/regional key limits blast radius if an intermediate is leaked. Replay is bounded by requiring an `X-Amz-Date` within ±5 minutes plus, for stricter APIs, a server-tracked nonce.

```svg
<svg viewBox="0 0 780 330" width="100%" height="330" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="780" height="330" fill="#ffffff"/>
  <text x="18" y="26" font-size="15" font-weight="700" fill="#1e293b">Bearer vs proof-of-possession: what a captured request is worth</text>

  <rect x="18" y="46" width="360" height="128" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="34" y="70" font-size="13" font-weight="700" fill="#1e293b">BEARER  (API key / Basic / Bearer token)</text>
  <text x="34" y="92" font-size="11" fill="#1e293b">Authorization: Bearer sk_live_51H8xK2...</text>
  <text x="34" y="112" font-size="11" fill="#1e293b">The secret itself is on the wire, in every request.</text>
  <text x="34" y="130" font-size="11" fill="#1e293b">Captured once &#8594; full access until revoked.</text>
  <text x="34" y="148" font-size="11" fill="#1e293b">Defences: TLS, short TTL, rotation, revocation.</text>
  <text x="34" y="166" font-size="11" fill="#1e293b">Leaks via: logs, proxies, browser history, CI dumps.</text>

  <rect x="402" y="46" width="360" height="128" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="418" y="70" font-size="13" font-weight="700" fill="#1e293b">PROOF OF POSSESSION  (HMAC / mTLS / DPoP)</text>
  <text x="418" y="92" font-size="11" fill="#1e293b">Authorization: AWS4-HMAC-SHA256 Signature=9f3c...</text>
  <text x="418" y="112" font-size="11" fill="#1e293b">Only a derivation crosses the wire; key stays home.</text>
  <text x="418" y="130" font-size="11" fill="#1e293b">Captured once &#8594; one replay, inside a 5 min window.</text>
  <text x="418" y="148" font-size="11" fill="#1e293b">Defences: timestamp skew, nonce cache, body hash.</text>
  <text x="418" y="166" font-size="11" fill="#1e293b">Cost: client-side crypto, canonicalization bugs.</text>

  <rect x="18" y="192" width="744" height="52" rx="10" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="34" y="214" font-size="12" font-weight="700" fill="#1e293b">Storage rule: keys are secrets, so persist only a digest.</text>
  <text x="34" y="232" font-size="11" fill="#1e293b">id = ak_live_7Fq2 (indexed, plaintext)   secret = SHA&#8209;256(rest) + server pepper   compare in constant time.</text>

  <rect x="18" y="258" width="360" height="56" rx="10" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="34" y="280" font-size="12" font-weight="700" fill="#1e293b">401 Unauthorized</text>
  <text x="34" y="298" font-size="11" fill="#1e293b">No / bad / expired credential. MUST send WWW&#8209;Authenticate.</text>

  <rect x="402" y="258" width="360" height="56" rx="10" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="418" y="280" font-size="12" font-weight="700" fill="#1e293b">403 Forbidden</text>
  <text x="418" y="298" font-size="11" fill="#1e293b">Identity known, permission denied. Retrying auth will not help.</text>
</svg>
```

**Where each scheme belongs.** The choice is driven by the *caller*, not by taste. A **browser** must never hold a long-lived secret, because any XSS exfiltrates it and there is no safe storage — use a session cookie backed by a server-side OAuth flow (chapter 19). A **first-party mobile app** is a public client: no embedded secret survives decompilation, so use authorization code + PKCE. **Server-to-server inside your perimeter** should use mTLS or short-lived workload identity tokens (SPIFFE, IRSA, Workload Identity Federation). **Partner integrations** get API keys or client-credentials OAuth, with HMAC signing when non-repudiation or replay resistance matters (payments, webhooks). **Webhooks you send outbound** invert the direction: *you* sign, the receiver verifies — see chapter 29.

---

## 4. Architecture & Workflow

The full lifecycle of an authenticated request, from key issuance to revocation:

1. **Issuance.** An operator creates a credential in a dashboard or via a management API. The server generates `secret = CSPRNG(32 bytes)`, composes the display value `ak_live_<id>_<base62(secret)>`, stores `sha256(secret)` plus metadata (owner, tenant, scopes, IP allow-list, `created_at`, `expires_at`), and returns the full value **exactly once**. It is never retrievable again.
2. **Distribution and storage.** The consumer places the key in a secret manager (Vault, AWS Secrets Manager, GCP Secret Manager, Kubernetes Secret backed by KMS) and injects it as an environment variable or mounted file at runtime — not in the repo, not in the container image, not in a `.env` committed "temporarily".
3. **Request.** The client sends `Authorization: Bearer ak_live_...` over TLS 1.3. If HMAC signing is in use, it instead builds a canonical request, computes the signature, and sends `Authorization: <ALG> Credential=..., SignedHeaders=..., Signature=...` plus a timestamp header.
4. **Edge termination.** TLS ends at the load balancer or gateway. If mTLS is used, this is where the client certificate is verified against the trusted CA bundle and CRL/OCSP, and the identity is forwarded downstream as a header (`X-Forwarded-Client-Cert`) over a trusted internal hop.
5. **Gateway authentication.** The gateway parses the scheme, extracts the key id, looks up the credential record from a short-TTL cache (30–60 s) backed by the datastore, and compares digests in constant time. On failure it returns `401` + `WWW-Authenticate` **before** the request reaches your service, and never proxies the credential further.
6. **Principal construction.** On success the gateway builds a normalized principal — `{sub, tenant_id, scopes, key_id, auth_method}` — and forwards it as a signed internal header or an mTLS-authenticated call. Downstream services must **not** re-parse the customer credential.
7. **Rate-limit and quota bucketing.** The key id (not the IP) is the bucket key. Unauthenticated requests get a much tighter IP-based bucket so `401` floods cannot be used to enumerate keys (chapter 24).
8. **Authorization.** The service checks scopes (`invoices:write`), then object-level ownership (`invoice.tenant_id == principal.tenant_id`). Missing scope → `403 insufficient_scope`. Wrong tenant → `404` to avoid leaking existence.
9. **Audit.** Log `key_id`, `auth_method`, `principal`, `outcome`, request id, source IP. Never log the credential — redact by prefix (`ak_live_7Fq2…`) so support can identify a key without possessing it.
10. **Rotation.** The customer creates a second key, deploys it, watches `last_used_at` on the old key drop to zero, then deletes the old key. Support **two live keys per account** or rotation forces downtime.
11. **Revocation and leak response.** On compromise, mark the row revoked and purge every cache entry within the cache TTL. Secret-scanning partners (GitHub, GitLab) can push a webhook to you the moment a prefixed key appears in a public repo; the mature response is automatic revocation plus an email, not a ticket.

```svg
<svg viewBox="0 0 800 400" width="100%" height="400" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="800" height="400" fill="#ffffff"/>
  <text x="18" y="24" font-size="15" font-weight="700" fill="#1e293b">API key lifecycle: issue &#8594; verify &#8594; rotate &#8594; revoke</text>

  <rect x="18" y="44" width="176" height="62" rx="10" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="32" y="66" font-size="12" font-weight="700" fill="#1e293b">1. Issue</text>
  <text x="32" y="84" font-size="10" fill="#1e293b">CSPRNG 32 bytes, prefix</text>
  <text x="32" y="99" font-size="10" fill="#1e293b">store SHA&#8209;256 only, show once</text>

  <rect x="218" y="44" width="176" height="62" rx="10" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="232" y="66" font-size="12" font-weight="700" fill="#1e293b">2. Store</text>
  <text x="232" y="84" font-size="10" fill="#1e293b">Vault / Secrets Manager</text>
  <text x="232" y="99" font-size="10" fill="#1e293b">injected as env or file</text>

  <rect x="418" y="44" width="176" height="62" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="432" y="66" font-size="12" font-weight="700" fill="#1e293b">3. Send</text>
  <text x="432" y="84" font-size="10" fill="#1e293b">Authorization: Bearer ...</text>
  <text x="432" y="99" font-size="10" fill="#1e293b">TLS 1.3, never in query string</text>

  <rect x="618" y="44" width="164" height="62" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="632" y="66" font-size="12" font-weight="700" fill="#1e293b">4. Edge / mTLS</text>
  <text x="632" y="84" font-size="10" fill="#1e293b">verify client cert vs CA</text>
  <text x="632" y="99" font-size="10" fill="#1e293b">terminate TLS at gateway</text>

  <line x1="194" y1="75" x2="214" y2="75" stroke="#4f46e5" stroke-width="2"/>
  <polygon points="218,75 210,71 210,79" fill="#4f46e5"/>
  <line x1="394" y1="75" x2="414" y2="75" stroke="#0ea5e9" stroke-width="2"/>
  <polygon points="418,75 410,71 410,79" fill="#0ea5e9"/>
  <line x1="594" y1="75" x2="614" y2="75" stroke="#16a34a" stroke-width="2"/>
  <polygon points="618,75 610,71 610,79" fill="#16a34a"/>

  <rect x="18" y="132" width="764" height="98" rx="10" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="34" y="154" font-size="12" font-weight="700" fill="#1e293b">5&#8211;7. Gateway verification path</text>
  <text x="34" y="176" font-size="11" fill="#1e293b">parse scheme &#8594; split key id from secret &#8594; cache lookup (TTL 30&#8211;60s) &#8594; constant&#8209;time digest compare</text>
  <text x="34" y="196" font-size="11" fill="#1e293b">fail &#8594; 401 + WWW&#8209;Authenticate, request never reaches the service</text>
  <text x="34" y="216" font-size="11" fill="#1e293b">pass &#8594; build principal {sub, tenant_id, scopes, key_id} &#8594; rate&#8209;limit bucket keyed by key_id</text>

  <rect x="18" y="248" width="368" height="66" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="34" y="270" font-size="12" font-weight="700" fill="#1e293b">8. Authorization (two checks)</text>
  <text x="34" y="288" font-size="10" fill="#1e293b">scope contains invoices:write &#8594; else 403</text>
  <text x="34" y="304" font-size="10" fill="#1e293b">row.tenant_id == principal.tenant_id &#8594; else 404</text>

  <rect x="414" y="248" width="368" height="66" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="430" y="270" font-size="12" font-weight="700" fill="#1e293b">9. Audit</text>
  <text x="430" y="288" font-size="10" fill="#1e293b">log key_id + auth_method + outcome + request id</text>
  <text x="430" y="304" font-size="10" fill="#1e293b">redact secret: ak_live_7Fq2&#8230; never the full value</text>

  <rect x="18" y="332" width="764" height="54" rx="10" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="34" y="354" font-size="12" font-weight="700" fill="#1e293b">10&#8211;11. Rotate and revoke</text>
  <text x="34" y="372" font-size="11" fill="#1e293b">two live keys per account &#8594; deploy new &#8594; watch last_used_at hit zero &#8594; delete old. Leak &#8594; revoke + purge cache + notify.</text>
</svg>
```

---

## 5. Implementation

**The `401` challenge on the wire.** This is the exchange RFC 9110 §11 describes:

```http
GET /v1/invoices HTTP/1.1
Host: api.acme.io
Accept: application/json
```

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="acme-api", error="invalid_request", error_description="missing access token"
Content-Type: application/problem+json
Cache-Control: no-store

{
  "type": "https://api.acme.io/problems/unauthenticated",
  "title": "Authentication required",
  "status": 401,
  "detail": "Send an API key as: Authorization: Bearer ak_live_...",
  "instance": "/v1/invoices"
}
```

> **Note:** the body uses `application/problem+json` per **RFC 9457** (chapter 16). Never put the *reason* a credential failed in fine-grained detail — "key revoked" vs "key not found" is an oracle. `invalid_token` is enough.

The authenticated retry, and a scope failure:

```http
GET /v1/invoices HTTP/1.1
Host: api.acme.io
Authorization: Bearer ak_live_7Fq2_9tXm3vRk1sPzA0bLcNeD8gHjYuIoQwErTyUi
```

```http
HTTP/1.1 403 Forbidden
WWW-Authenticate: Bearer realm="acme-api", error="insufficient_scope", scope="invoices:read"
Content-Type: application/problem+json

{ "type": "https://api.acme.io/problems/insufficient-scope",
  "title": "Insufficient scope", "status": 403,
  "detail": "This key is scoped to webhooks:read only." }
```

**Generating, hashing and verifying a key (FastAPI):**

```python
import os, hmac, hashlib, secrets, time
from fastapi import FastAPI, Request, HTTPException, Depends

app = FastAPI()
PEPPER = os.environ["API_KEY_PEPPER"].encode()   # from KMS, rotated with a key version

def new_api_key(live: bool = True) -> tuple[str, str, str]:
    """Returns (display_value, key_id, digest). Show display_value exactly once."""
    key_id, secret = secrets.token_hex(4), secrets.token_urlsafe(32)  # id + ~256 bits
    display = f"ak_{'live' if live else 'test'}_{key_id}_{secret}"
    return display, key_id, digest_of(secret)

def digest_of(secret: str) -> str:
    # Fast keyed hash: a 256-bit random secret has no dictionary structure,
    # so bcrypt/argon2 cost is unnecessary and far too slow per request.
    return hmac.new(PEPPER, secret.encode(), hashlib.sha256).hexdigest()

async def principal(request: Request) -> dict:
    scheme, _, value = request.headers.get("authorization", "").partition(" ")
    try:
        assert scheme.lower() == "bearer"
        _, _env, key_id, secret = value.split("_", 3)
    except (AssertionError, ValueError):
        raise HTTPException(401, "unauthenticated", headers={
            "WWW-Authenticate": 'Bearer realm="acme-api", error="invalid_request"'})

    row = await keys.get_cached(key_id)                 # 30s TTL cache
    ok = row is not None and hmac.compare_digest(row["digest"], digest_of(secret))
    if not ok or row["revoked_at"] or (row["expires_at"] and row["expires_at"] < time.time()):
        raise HTTPException(401, "invalid_token", headers={
            "WWW-Authenticate": 'Bearer realm="acme-api", error="invalid_token"'})

    await keys.touch_async(key_id)                      # last_used_at, fire-and-forget
    return {"key_id": key_id, "tenant_id": row["tenant_id"], "scopes": set(row["scopes"])}

def require(scope: str):
    async def dep(p: dict = Depends(principal)) -> dict:
        if scope not in p["scopes"]:
            raise HTTPException(403, "insufficient_scope", headers={
                "WWW-Authenticate": f'Bearer realm="acme-api", error="insufficient_scope", scope="{scope}"'})
        return p
    return dep

@app.get("/v1/invoices")
async def list_invoices(p: dict = Depends(require("invoices:read"))):
    return {"data": await repo.list(tenant_id=p["tenant_id"], limit=50)}
```

**Basic auth — only where it belongs.** Basic is acceptable for an internal admin endpoint behind a VPN, or as the *client authentication* method at an OAuth token endpoint. It is not acceptable as your public API's primary scheme, because it re-transmits a long-lived password on every request:

```bash
curl -sS https://internal.acme.io/admin/health -u 'ops:$PASSWORD'
# sends: Authorization: Basic b3BzOnMzY3JldA==   (base64, trivially decoded)
```

**HMAC request signing (client side, Node):**

```javascript
import crypto from 'node:crypto';

function sign({ method, path, body, secret, keyId }) {
  const ts = Math.floor(Date.now() / 1000);
  const bodyHash = crypto.createHash('sha256').update(body ?? '').digest('hex');
  const canonical = [method.toUpperCase(), path, ts, bodyHash].join('\n');
  const sig = crypto.createHmac('sha256', secret).update(canonical).digest('hex');
  return { 'Authorization': `ACME-HMAC-SHA256 KeyId=${keyId}, Signature=${sig}`,
           'X-Acme-Timestamp': String(ts), 'X-Acme-Content-Sha256': bodyHash };
}
```

Server side: reject if `|now - ts| > 300`, recompute the canonical string from the *received* method/path/body, `crypto.timingSafeEqual` the digests, and cache `(keyId, sig)` in Redis for 300 s to block replays. Note the body hash — without it an attacker can swap the payload while keeping a valid signature over the headers alone.

**mTLS at the edge (nginx), identity forwarded downstream:**

```nginx
server {
  listen 443 ssl;
  ssl_client_certificate /etc/ssl/partner-ca.pem;   # trust anchor
  ssl_verify_client on;                             # reject unauthenticated handshakes
  ssl_verify_depth 2;
  ssl_crl /etc/ssl/partner-crl.pem;                 # revocation list
  location /v1/ {
    proxy_set_header X-Client-Cert-Subject $ssl_client_s_dn;
    proxy_set_header X-Client-Verify       $ssl_client_verify;   # SUCCESS | FAILED:...
    proxy_pass http://api_upstream;
  }
}
```

The upstream must treat those headers as trusted **only** because the network path is private and the gateway strips any client-supplied copies. Forgetting to strip inbound `X-Client-Cert-*` headers is a full authentication bypass.

**OpenAPI 3.1 declaration:**

```yaml
components:
  securitySchemes:
    apiKey:   { type: http, scheme: bearer, bearerFormat: opaque }
    mutualTLS: { type: mutualTLS }
security: [{ apiKey: [] }]
paths:
  /v1/invoices:
    get:
      responses:
        '200': { description: OK }
        '401': { description: Missing or invalid credential; WWW-Authenticate present }
        '403': { description: Valid credential, insufficient scope }
```

**Optimization note.** Credential verification sits on every request, so it must not be a database round trip. Cache the credential record keyed by `key_id` with a 30–60 s TTL and a negative-cache entry for unknown ids (so a key-guessing flood cannot hammer your database). A local SHA-256 comparison costs ~1 µs; a Postgres lookup costs 0.5–3 ms; bcrypt at cost 12 costs ~250 ms and would cap a single core at four requests per second — this is the single most common performance mistake in API-key implementations. Keep `last_used_at` writes asynchronous and batched (a per-minute upsert), never synchronous on the hot path.

---

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| API key | Trivial to issue, use and document; works from any language and `curl`; easy per-key rate limiting and analytics | Bearer credential with no expiry by default; leaks constantly into repos, logs and Slack; revocation is the only defence |
| Basic auth | Universal client support; zero infrastructure; fine for internal or OAuth client auth | Sends a long-lived password on *every* request; no scope; browser prompt UX is poor; MFA impossible |
| Bearer token (OAuth/JWT) | Short-lived, scoped, audience-restricted, revocable at the AS; standard tooling | Requires an authorization server; token can't be revoked before `exp` if self-contained; refresh dance adds moving parts |
| mTLS | Strongest binding — identity is a private key that never transits; kills replay and phishing outright | Certificate lifecycle is real work (issuance, rotation, CRL/OCSP, expiry outages); painful for browsers and mobile |
| HMAC signing | Secret never crosses the wire; integrity over method, path and body; replay-bounded; gives non-repudiation | Client-side crypto burden; canonicalization mismatches are an endless support cost; proxies that rewrite headers break it |
| Hashing keys at rest | A stolen database yields nothing usable | You can never show the key again — needs "shown once" UX and a good rotation story |
| Key prefixing | Secret scanners find leaks in public repos automatically; humans can identify a key in logs | Slightly reduces entropy budget; publicly advertises which vendor a leaked string belongs to |
| Long-lived credentials | No refresh logic; simple ops | Exposure window equals detection time, which is typically weeks; mandates aggressive rotation policy |
| Gateway-level auth | One hardened implementation; services stay simple; consistent `401`/`403` | A hop and a failure domain; risk of services trusting spoofable internal headers |

---

## 7. Common Mistakes & Best Practices

1. ⚠️ **Putting the key in the query string** (`GET /v1/invoices?api_key=sk_live_...`). → ✅ Use the `Authorization` header. URLs land in access logs, `Referer` headers, browser history and CDN cache keys; RFC 6750 §2.3 deprecates the URI query parameter method for exactly this reason.
2. ⚠️ **Storing API keys in plaintext** so support can "look them up". → ✅ Store `HMAC-SHA256(pepper, secret)` and display only a redacted prefix. If your dashboard can re-display a full key, so can an attacker with read access to that dashboard.
3. ⚠️ **Using bcrypt/argon2 for API keys.** → ✅ A 256-bit CSPRNG key needs no work factor. Use a single fast keyed hash; bcrypt on the hot path is a self-inflicted DoS.
4. ⚠️ **Comparing digests with `==`.** → ✅ Use `hmac.compare_digest` / `crypto.timingSafeEqual`. String comparison short-circuits and leaks position information under load.
5. ⚠️ **Returning `403` for a missing or expired credential, or `401` without `WWW-Authenticate`.** → ✅ `401` means "authenticate"; RFC 9110 §15.5.2 requires the challenge header. `403` means "authenticated but denied" and must not be retried with new credentials.
6. ⚠️ **Shipping an API key inside a mobile app or SPA bundle.** → ✅ Anything in a client binary or JS bundle is public. Use authorization code + PKCE (chapter 19) with a backend-for-frontend; if a key must exist client-side, treat it as a *publishable* key with read-only, rate-limited, origin-restricted scope — Stripe's `pk_live_` model.
7. ⚠️ **One key per account with no rotation path.** → ✅ Support at least two concurrent live keys, expose `last_used_at`, and document a rotate-without-downtime procedure. If rotating requires downtime, nobody will ever rotate.
8. ⚠️ **Logging the `Authorization` header.** → ✅ Add a redaction filter in your logging middleware, your reverse proxy, and your APM agent — all three. Grep your log pipeline for `sk_`/`ak_` prefixes in CI as a regression test.
9. ⚠️ **Treating authentication as authorization** — "the key is valid, therefore return the invoice". → ✅ Every read and write must also check `resource.tenant_id == principal.tenant_id`. This is OWASP API1:2023 Broken Object Level Authorization, still the most-exploited API flaw (chapter 23).
10. ⚠️ **Unbounded, unauthenticated `401` responses.** → ✅ Rate-limit failed authentication by IP *and* by presented key id, with exponential backoff, so credential stuffing and key enumeration are expensive. Emit a metric, not just a log line.
11. ⚠️ **Trusting internal identity headers that clients can set.** → ✅ The gateway must strip `X-Client-Cert-*`, `X-User-Id` and friends from inbound requests before adding its own, and internal hops should be mTLS-authenticated so a compromised pod cannot mint principals.
12. ⚠️ **No leak-response plan.** → ✅ Register with GitHub/GitLab secret-scanning partner programmes, wire the webhook to automatic revocation, and rehearse the incident: revoke, purge caches, notify the customer, audit what the key touched via `key_id` in your request logs.

---

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Authentication failures are almost always one of five things: the credential never left the client (a proxy or SDK stripped `Authorization` on redirect — `curl -L` does this across hosts by design), a copy-paste whitespace or newline in the key, an expired or revoked key, clock skew breaking an HMAC timestamp window, or a certificate that expired at 03:00 UTC. Reproduce with `curl -v` and read the `WWW-Authenticate` value — it is the API's own diagnosis. For mTLS, `openssl s_client -connect api.acme.io:443 -cert client.pem -key client.key` shows the handshake and the verify result directly. Give every `401`/`403` a `traceparent`-correlated request id in the problem body so support can find the exact log line without ever seeing the key.

**Monitoring.** Track: `401` rate and `403` rate as separate series (a `403` spike means a misconfigured integration; a `401` spike means an outage, a rotation gone wrong, or an attack); authentication latency p50/p99 broken out from total request latency; credential cache hit ratio; distinct `key_id` count per source IP per minute (enumeration signal); count of requests per key approaching an unused-key threshold; **certificate expiry countdown** as a gauge with alerts at 30/14/7 days — expired client certs are one of the most reliable outage causes in mTLS estates. Alert on any successful authentication from a key that was flagged as leaked, and on any `auth_method` regression (a partner suddenly falling back from mTLS to plain bearer).

**Security.** TLS 1.2+ everywhere with HSTS; a credential that traverses plain HTTP is compromised the moment it does so, so treat any plaintext request as a revocation trigger. Bound every credential in time — even API keys should carry an `expires_at`, defaulting to 90–365 days. Scope every key to the minimum set of operations and, for partners, to an IP allow-list. Separate `test` and `live` key namespaces so a sandbox key can never touch production data. Pepper key digests from a KMS with a key version so you can re-pepper without re-issuing. Enforce per-key quotas so a single compromised key cannot exfiltrate your whole dataset before you notice — rate limits are a *containment* control, not just a fairness one. Follow OWASP API Security Top 10 API2:2023 (Broken Authentication) as a checklist during review.

**Performance & scaling.** Verification must be O(1) and local: prefix parse, cache lookup, constant-time digest compare. Push the whole path into the gateway so it is implemented once and benefits from a shared cache; do it in a language with a fast hash and avoid per-request JSON parsing of credential records by caching the deserialized object. Negative-cache unknown key ids for a few seconds to blunt enumeration floods. For mTLS, enable TLS session resumption and OCSP stapling — a full handshake per request will dominate your latency budget at high RPS. When you revoke, the propagation delay equals your cache TTL, so publish revocations over a pub/sub channel to invalidate immediately, and keep the TTL short enough that a missed message still self-heals within a minute.

---

## 9. Interview Questions

**Q: What is the difference between authentication and authorization, and how does it show up in HTTP?**
A: Authentication establishes *who* is calling by verifying a credential; authorization decides whether that identity may perform this operation on this resource. In HTTP, a failure of the first is `401 Unauthorized` with a mandatory `WWW-Authenticate` challenge; a failure of the second is `403 Forbidden`, which should not be retried with different credentials.

**Q: Why is `Authorization: Basic` considered weak even over TLS?**
A: Base64 is encoding, not encryption, so the credential is effectively plaintext inside the request, and it is a long-lived password re-sent on every single call — vastly increasing exposure to logs, proxies and memory dumps. It also has no scoping, no expiry, and no path to MFA. It is fine for internal endpoints or OAuth client authentication, not for a public API.

**Q: How should an API key be stored server-side, and why not bcrypt?**
A: Store a one-way digest — `SHA-256` or `HMAC-SHA-256` with a server-side pepper — so a database dump yields nothing usable, and compare in constant time. bcrypt/argon2 exist to slow dictionary attacks on low-entropy human passwords; a 256-bit CSPRNG key has no dictionary, and a 250 ms hash on every request would destroy your throughput.

**Q: Why do vendors prefix keys with strings like `sk_live_` or `github_pat_`?**
A: A fixed, high-signal prefix makes leaked credentials mechanically findable — GitHub's secret scanning, `git-secrets`, and log scrubbers all pattern-match on it — and lets a human identify a key's vendor, environment and type from a redacted fragment. The tiny loss of entropy is irrelevant next to the detection win.

**Q: When would you choose mTLS over a bearer token?**
A: For server-to-server traffic where both endpoints are under operational control and identity must be bound to a key that never crosses the wire — service mesh internals, high-value partner links, financial APIs. It defeats replay and credential theft from logs, at the cost of certificate lifecycle management, which is real operational work and a real outage source.

**Q: What does HMAC request signing protect that a bearer token does not?**
A: The secret is never transmitted, so capturing a request — from a log, a proxy, or a mirrored port — yields no reusable credential. Signing also covers the method, path and a hash of the body, giving integrity and non-repudiation, and a timestamp plus nonce bounds replay to a few minutes.

**Q: A valid token is presented but lacks the required scope. What do you return?**
A: `403 Forbidden` with `WWW-Authenticate: Bearer error="insufficient_scope", scope="invoices:write"`. `401` is wrong because the credential is valid — the client re-authenticating would change nothing.

**Q: (Senior) Design a key rotation scheme for 10,000 partners with zero downtime.**
A: Allow at least two active keys per account with independent `created_at`, `expires_at` and `last_used_at`. Rotation is: create key B, deploy it, watch B's traffic rise and A's `last_used_at` go stale for a full business cycle, then revoke A. Automate the nudge — email at 30/14/7 days before `expires_at`, expose the state in the dashboard and via a management API, and publish a `Sunset`-style deprecation signal for keys past policy. Enforce a hard maximum age so rotation is not optional, and make revocation propagate over pub/sub rather than waiting for cache TTLs.

**Q: (Senior) A customer's live key appears in a public GitHub repo. Walk through your response.**
A: Ideally you learned it from GitHub's secret-scanning partner webhook within seconds, and automation already revoked the key and emailed the owner. Then: purge every cache entry, query request logs by `key_id` for the full exposure window to determine what was read or written, check for anomalies in source IP and access pattern, notify the customer with a concrete blast-radius statement, and issue a replacement. Post-incident, verify the prefix pattern is registered with all scanning partners and consider tightening default key scopes and per-key quotas so the next leak reads less.

**Q: (Senior) How do you prevent downstream services from being fooled by spoofed identity headers?**
A: The gateway must strip all inbound identity headers before injecting its own, and the internal hop must itself be authenticated — mTLS between gateway and service, or a short-lived signed internal token (a JWT with a 30-second `exp` and an `aud` naming the target service). Never rely on network position alone: a compromised pod inside the mesh can otherwise mint any principal it likes. Add a contract test asserting that a client-supplied `X-User-Id` is ignored.

**Q: (Senior) Compare bearer tokens and sender-constrained credentials in terms of exposure window.**
A: A bearer credential's exposure window is `min(TTL, time-to-detect-and-revoke)` — for an API key with no expiry that is entirely detection time, typically weeks. A sender-constrained credential (mTLS, DPoP per RFC 9449, HMAC signing) reduces the value of a captured artifact to at most a replay inside the signature's validity window, usually five minutes, and to zero if a nonce cache is enforced. The trade is client-side key management and crypto complexity.

**Q: How do you keep authentication off the critical path at high request rates?**
A: Verify at the gateway with an O(1) local path: parse the key id from a prefix, look the record up in a short-TTL in-process or Redis cache, and do a constant-time digest comparison — never a per-request database read or a slow KDF. Negative-cache unknown ids to blunt enumeration, write `last_used_at` asynchronously, and for mTLS enable session resumption and OCSP stapling so you are not paying for full handshakes.

---

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Authentication answers *who*; authorization answers *may they*. HTTP models it with `401` + `WWW-Authenticate` (RFC 9110 §11) and the `Authorization: <scheme> <credentials>` request header. Schemes split into **bearer** (API key, Basic, `Bearer` token — the secret itself is on the wire, so possession is everything) and **proof-of-possession** (mTLS, HMAC signing, DPoP — only a derivation transits, so a captured request is nearly worthless). Generate keys from a CSPRNG with a searchable prefix, store only a fast keyed digest, compare in constant time, cache the lookup, and never log the value. Give every credential an expiry, a scope, two-key rotation and an instant revocation path. Browsers and mobile apps get OAuth + PKCE, never a static secret; server-to-server gets mTLS or client credentials; partners get keys plus HMAC signing where replay matters. Then, always, do object-level authorization — a valid key is not permission to read *that* invoice.

| Item | Value / Rule |
|---|---|
| Missing / bad / expired credential | `401` + `WWW-Authenticate: Bearer realm="…", error="invalid_token"` |
| Valid credential, missing permission | `403` + `error="insufficient_scope", scope="…"` |
| Header format | `Authorization: <scheme> <credentials>` (RFC 9110 §11.6.2) |
| Key generation | CSPRNG ≥ 256 bits, e.g. `secrets.token_urlsafe(32)` |
| Key format | `ak_live_<key_id>_<secret>` — prefix for scanners, id for lookup |
| Storage at rest | `HMAC-SHA256(pepper, secret)`, constant-time compare, never bcrypt |
| Basic auth | `base64(user:password)` — encoding, not encryption; internal use only |
| Bearer in URLs | Never (RFC 6750 §2.3 deprecates the query parameter form) |
| mTLS identity | Client cert subject/SAN, verified at the edge, forwarded on a trusted hop |
| HMAC replay window | ±300 s timestamp + nonce cache + body hash in the signed string |
| Rotation | Two live keys, `last_used_at` visible, hard max age, no-downtime swap |
| Error body | `application/problem+json` (RFC 9457), no oracle detail |

**Flash cards**

- **What must accompany every `401`?** → A `WWW-Authenticate` header naming at least one challenge scheme — RFC 9110 §15.5.2 requires it.
- **Why not bcrypt an API key?** → No dictionary structure to defend against (256 bits of CSPRNG entropy), and a slow KDF on every request is a self-inflicted DoS. Fast keyed hash + constant-time compare.
- **Bearer vs proof-of-possession in one sentence?** → Bearer puts the secret on the wire so a captured request is a full compromise; proof-of-possession puts only a derivation there so a capture is at most a bounded replay.
- **Where does an API key never belong?** → In a query string, a browser bundle, a mobile binary, a git repo, or a log line.
- **`401` or `403` for a valid key with the wrong scope?** → `403` — the credential is fine; re-authenticating changes nothing.

---

## 11. Hands-On Exercises & Mini Project

- [ ] Implement `new_api_key()` / `verify()` with a prefix, a peppered SHA-256 digest and a constant-time compare. Then benchmark the same verification with bcrypt cost 12 and measure the requests-per-second collapse.
- [ ] Write a middleware that returns `401` + `WWW-Authenticate` for a missing key, `401 invalid_token` for a revoked key, and `403 insufficient_scope` for a valid key lacking `invoices:write`. Assert all three with tests, including that the problem body never reveals *why* the credential failed.
- [ ] Implement HMAC signing over `METHOD\nPATH\nTIMESTAMP\nSHA256(body)`. Verify server-side, then prove three attacks fail: a modified body, a replayed request outside the ±300 s window, and a replay *inside* the window once you add a nonce cache.
- [ ] Stand up nginx with `ssl_verify_client on` and a self-signed CA. Connect with a valid cert, an untrusted cert and an expired cert, and record what the client sees in each case. Then confirm that a client-supplied `X-Client-Cert-Subject` header is stripped by the proxy.
- [ ] Write a log-redaction filter and a CI check that greps your test-run logs for `ak_live_` / `sk_live_` patterns and fails the build on a hit.

**Mini Project — "Keyring": an API-key management service**

*Goal:* build the credential plane a real SaaS needs behind its public API.

*Requirements:*
1. `POST /v1/keys` issues a key (`ak_{env}_{id}_{secret}`), returns the full value exactly once, and persists only a peppered digest plus `tenant_id`, `scopes`, `expires_at`, `ip_allowlist`.
2. `GET /v1/keys` lists keys with redacted prefixes, `created_at`, `last_used_at` and `expires_at`. `DELETE /v1/keys/{id}` revokes with immediate cache invalidation over pub/sub.
3. A verification middleware with a 30 s positive cache, a 5 s negative cache, constant-time comparison and asynchronous `last_used_at` updates.
4. Correct `401` vs `403` semantics with `WWW-Authenticate` challenges and RFC 9457 problem bodies, plus per-key rate limiting keyed by `key_id` and a tighter IP bucket for unauthenticated traffic.
5. Structured audit events for issue, use, failed-auth, rotate and revoke, queryable by `key_id`.

*Extensions:* add an HMAC-signed request mode as an opt-in per key; add mTLS for a "partner" tier and record `auth_method` on every request; add a leak-response webhook endpoint that revokes a key and emails the owner; add `test`/`live` namespace isolation with a hard boundary; add a rotation reminder job that emails owners at 30/14/7 days before `expires_at`; export a Prometheus metric for certificate and key expiry countdowns.

---

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *OAuth 2.0 & OpenID Connect* (chapter 19) is the standard way to mint short-lived, scoped bearer tokens for user-facing and partner clients; *JWT: Structure, Validation & Pitfalls* (chapter 20) covers the dominant token format and its verification traps; *Authorization: RBAC, ABAC & Scopes* (chapter 21) covers everything that happens after identity is established; *TLS, CORS & Security Headers* (chapter 22) covers the transport and browser constraints every scheme here assumes; *OWASP API Security Top 10* (chapter 23) places Broken Authentication (API2) and BOLA (API1) in context; *Rate Limiting, Quotas & Throttling* (chapter 24) covers containing a compromised credential; *Error Handling & Problem Details* (chapter 16) defines the `application/problem+json` bodies used throughout.

- **RFC 9110 — HTTP Semantics, §11 Authentication** — IETF · *Intermediate* · the normative definition of the `Authorization`/`WWW-Authenticate` framework, `401` and `403`; replaces the retired RFC 7235. <https://www.rfc-editor.org/rfc/rfc9110#section-11>
- **RFC 7617 — The 'Basic' HTTP Authentication Scheme** — IETF · *Beginner* · short and precise on what Basic is, its charset rules, and its explicitly stated weaknesses. <https://www.rfc-editor.org/rfc/rfc7617>
- **RFC 6750 — OAuth 2.0 Bearer Token Usage** — IETF · *Intermediate* · defines the `Bearer` scheme, the `error`/`error_description` challenge parameters, and why query-string tokens are deprecated. <https://www.rfc-editor.org/rfc/rfc6750>
- **OWASP API Security Top 10 — API2:2023 Broken Authentication** — OWASP · *Intermediate* · a concrete checklist of the authentication failures actually exploited in the wild, with remediation. <https://owasp.org/API-Security/editions/2023/en/0xa2-broken-authentication/>
- **OWASP Secrets Management Cheat Sheet** — OWASP · *Intermediate* · practical guidance on generation, storage, rotation and leak response for the credentials this chapter creates. <https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html>
- **AWS Signature Version 4 signing process** — Amazon Web Services · *Advanced* · the canonical worked example of HMAC request signing, including canonicalization and scoped key derivation. <https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv4-signing-process.html>
- **Stripe API — Authentication** — Stripe · *Beginner* · the industry-reference model for key prefixes, `test`/`live` separation, restricted keys and publishable vs secret keys. <https://docs.stripe.com/api/authentication>
- **MDN — HTTP authentication** — Mozilla · *Beginner* · the clearest practical walkthrough of the challenge/response exchange, proxy authentication and browser behaviour. <https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Authentication>

---

*REST API Handbook — chapter 18.*
