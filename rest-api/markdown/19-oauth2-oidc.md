# 19 · OAuth 2.0 & OpenID Connect

> **In one line:** OAuth 2.0 is a *delegated authorization* framework that lets a user grant a client limited, revocable access to an API without sharing their password — and OpenID Connect is the thin identity layer bolted on top that finally answers "who is this user?".

---

## 1. Overview

Before OAuth, the only way for a third-party app to read your Gmail contacts was to ask for your Gmail *password*. That anti-pattern — the "password anti-pattern" — meant the app got unlimited, permanent, unauditable access to everything, and revoking it meant changing your password everywhere. OAuth 2.0 (RFC 6749, 2012) replaced that with a triangle: the **resource owner** (you) authorises a **client** (the app) at an **authorization server**, and the client receives a scoped, expiring **access token** it presents to the **resource server** (the API). The user's credentials never touch the client.

The critical framing that trips up most candidates: **OAuth 2.0 is not authentication.** It answers "may this client call `GET /v1/repos` on behalf of someone?" — it does not reliably answer "who is that someone?". An access token is a valet key, not an ID card. Companies that built login on raw OAuth 2.0 in 2010-2014 all invented mutually incompatible `/userinfo` endpoints and all shipped the same token-substitution vulnerability. **OpenID Connect (OIDC, 2014)** standardised the fix: a second artifact, the **ID token**, is a signed JWT with a defined claim set (`iss`, `sub`, `aud`, `exp`, `iat`, `nonce`) that the client validates *itself*. OAuth gives you access; OIDC gives you identity.

The 2012 spec has aged, and the modern guidance is materially different from what most tutorials show. **RFC 9700 (OAuth 2.0 Security Best Current Practice, January 2025)** and the **OAuth 2.1** draft consolidate a decade of attacks into a short list: the implicit grant (`response_type=token`) is removed, the resource owner password credentials (ROPC) grant is removed, redirect URIs must be compared by exact string match, bearer tokens must never travel in query strings, and **PKCE is required for all clients using the authorization code grant** — not just public ones. If an interviewer asks "which grant should a SPA use?", the only correct answer in 2025 is *authorization code with PKCE*, ideally with the tokens held by a backend-for-frontend rather than in browser storage.

A concrete example: **Stripe Connect**. A bookkeeping SaaS wants to read its customers' Stripe charges. The SaaS redirects the merchant to `https://connect.stripe.com/oauth/authorize?client_id=ca_123&scope=read_only&response_type=code&state=...`. The merchant logs into *Stripe*, sees "Books&Co wants read-only access to your account", approves, and Stripe redirects back with a one-time `code`. The SaaS exchanges that code — server-to-server, authenticating with its client secret — for an access token bound to `acct_1M...` with `read_only` scope. The SaaS never sees the merchant's Stripe password, the merchant can revoke the connection from a Stripe dashboard, and the token cannot create charges because the scope forbids it. GitHub Apps, Slack, Google Workspace and Twilio all use structurally identical flows.

The whole framework is worth learning precisely because it is *unavoidable*: every B2B integration, every "Sign in with…", every mobile app calling a first-party API, and every service-to-service call inside a modern platform is some specialisation of the same four-party dance.

---

## 2. Core Concepts

- **Resource owner** — the human (or entity) who owns the data and can grant access. Usually the end user.
- **Client** — the application requesting access. *Confidential* clients (server-side) can hold a secret; *public* clients (SPAs, mobile, CLI) cannot and must use PKCE.
- **Authorization server (AS)** — issues tokens after authenticating the resource owner and recording consent. Exposes `/authorize`, `/token`, `/jwks`, `/introspect`, `/revoke`.
- **Resource server (RS)** — the API that accepts access tokens and enforces scope + object-level authorization. Often a different team than the AS.
- **Access token** — short-lived (5–60 min) credential presented as `Authorization: Bearer <token>`. Opaque or JWT. Audience-restricted to specific APIs.
- **Refresh token** — long-lived credential used *only* at the token endpoint to mint new access tokens. Never sent to the resource server. Should rotate on each use.
- **ID token** — an OIDC-only signed JWT *about the authentication event*, consumed by the client, never sent to an API as a credential.
- **Scope** — a coarse, space-delimited list of permissions the client requests (`openid profile invoices:read`). A ceiling on what the token can do, not a replacement for authorization.
- **PKCE (RFC 7636)** — Proof Key for Code Exchange. The client sends `code_challenge = BASE64URL(SHA256(code_verifier))` on `/authorize` and the raw `code_verifier` on `/token`, binding the code to the instance that requested it.
- **`state` and `nonce`** — `state` is an opaque, per-request CSRF token for the redirect; `nonce` is echoed inside the ID token to bind it to this authentication request and defeat replay.
- **Discovery document** — `/.well-known/openid-configuration`, the JSON metadata (RFC 8414) listing endpoints, supported algorithms and the JWKS URI.

---

## 3. Theory & Principles

OAuth's security rests on three ideas: **separation of credentials**, **short-lived bearer artifacts**, and **channel binding**.

**Separation of credentials.** The user's password is only ever presented to the authorization server, over a front-channel the user can visually verify (correct domain, TLS padlock). The client receives a derived, attenuated credential. Attenuation happens along three axes simultaneously: *time* (`exp`), *authority* (`scope`), and *target* (`aud`). A token that is short-lived but omnipotent, or scoped but eternal, is only one-third safe.

**Front channel vs back channel.** The `/authorize` request travels via the browser's address bar (front channel) — it is visible to the user, logged by proxies, stored in history, and leakable via `Referer`. The `/token` request is a direct TLS call from client to AS (back channel) — invisible to the browser. The authorization code grant deliberately puts only a *useless-on-its-own* artifact (the code) on the front channel and moves the actual token exchange to the back channel. The implicit grant put the access token itself in a URL fragment, which is why it is dead.

**Why PKCE, precisely.** Consider a mobile app registered on `myapp://callback`. A malicious app on the same device can register the same custom scheme and intercept the redirect, stealing the authorization code. With PKCE the attacker holds a code but not the `code_verifier`, and the token endpoint rejects the exchange because `SHA256(verifier) ≠ challenge`. PKCE also defends confidential clients against **authorization code injection**, where an attacker injects their own stolen code into a victim's session; RFC 9700 therefore mandates PKCE universally, not just for public clients. Always use `code_challenge_method=S256`; the `plain` method exists only for constrained devices and offers no protection against a channel that can read the challenge.

**Token lifetime math.** Let `T_a` = access-token TTL and `T_d` = detection-to-revocation time for a compromise. Exposure window for a stolen access token is `min(T_a, T_d)`. Since `T_d` for most orgs is hours or days, `T_a` is the only lever you control — hence 5–15 minutes for high-value APIs. Refresh tokens invert the problem: they live for weeks, so they must be *rotated*. On each refresh the AS issues a new refresh token and invalidates the old one; if the old one is ever presented again, that proves two parties hold it, and the entire token family is revoked. This is **refresh token rotation with reuse detection**, and it turns a silent theft into a loud, detectable event.

**Sender-constrained tokens.** A bearer token is like cash — whoever holds it can spend it. **DPoP (RFC 9449)** and **mTLS-bound tokens (RFC 8705)** bind the token to a key the client proves possession of on every call, so a stolen token is useless without the private key. Adopt DPoP for public clients handling sensitive data; adopt mTLS for high-assurance service-to-service.

```svg
<svg viewBox="0 0 760 300" width="100%" height="300" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="760" height="300" fill="#ffffff"/>
  <text x="20" y="26" font-size="15" font-weight="700" fill="#1e293b">Token attenuation: three independent axes</text>

  <rect x="24" y="52" width="220" height="96" rx="10" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="40" y="76" font-size="13" font-weight="700" fill="#1e293b">TIME</text>
  <text x="40" y="98" font-size="11" fill="#1e293b">exp = iat + 900s</text>
  <text x="40" y="116" font-size="11" fill="#1e293b">access token: 5-15 min</text>
  <text x="40" y="134" font-size="11" fill="#1e293b">refresh token: rotates</text>
  <rect x="268" y="52" width="220" height="96" rx="10" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="284" y="76" font-size="13" font-weight="700" fill="#1e293b">AUTHORITY</text>
  <text x="284" y="98" font-size="11" fill="#1e293b">scope = invoices:read</text>
  <text x="284" y="116" font-size="11" fill="#1e293b">no write, no delete</text>
  <text x="284" y="134" font-size="11" fill="#1e293b">consent recorded at AS</text>
  <rect x="512" y="52" width="224" height="96" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="528" y="76" font-size="13" font-weight="700" fill="#1e293b">TARGET</text>
  <text x="528" y="98" font-size="11" fill="#1e293b">aud = https://api.acme.io</text>
  <text x="528" y="116" font-size="11" fill="#1e293b">rejected by billing-api</text>
  <text x="528" y="134" font-size="11" fill="#1e293b">RFC 8707 resource param</text>
  <rect x="24" y="178" width="712" height="46" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="40" y="200" font-size="12" font-weight="700" fill="#1e293b">Exposure window = min(access-token TTL, time-to-detect-and-revoke)</text>
  <text x="40" y="217" font-size="11" fill="#1e293b">You control the first term. Rotation + reuse detection makes the second term observable.</text>
  <rect x="24" y="242" width="712" height="42" rx="10" fill="#ffffff" stroke="#4f46e5" stroke-width="2" stroke-dasharray="5 3"/>
  <text x="40" y="262" font-size="12" font-weight="700" fill="#1e293b">Bearer &#8594; Sender-constrained</text>
  <text x="40" y="278" font-size="11" fill="#1e293b">DPoP (RFC 9449) or mTLS (RFC 8705) bind the token to a key: theft alone is no longer enough.</text>
</svg>
```

**Where OIDC fits.** OIDC does not change the flow; it adds `openid` to the scope, which makes the AS additionally return an `id_token` from the token endpoint. The client validates the ID token's signature against the AS's JWKS, checks `iss` matches the discovery issuer, `aud` equals its own `client_id`, `exp` is in the future, and `nonce` matches what it sent. Only then does it create a local session keyed by `iss` + `sub` (never by email — emails change and are reassignable).

---

## 4. Architecture & Workflow

The canonical flow for a browser or mobile client is **authorization code + PKCE**. Numbered walkthrough:

1. **Client generates PKCE material.** `code_verifier` = 43–128 chars of cryptographically random URL-safe text; `code_challenge` = `BASE64URL(SHA256(verifier))`. It also generates `state` (CSRF) and `nonce` (replay), storing all three in session/local state.
2. **Redirect to `/authorize`.** Browser navigates to the AS with `response_type=code`, `client_id`, `redirect_uri`, `scope=openid profile invoices:read`, `state`, `nonce`, `code_challenge`, `code_challenge_method=S256`, and (RFC 8707) `resource=https://api.acme.io`.
3. **AS authenticates the user.** Password + WebAuthn/TOTP, or an existing SSO session. This is the *only* place credentials are entered. The AS validates that `redirect_uri` exactly string-matches a pre-registered URI.
4. **Consent.** If the client has not previously been granted these scopes for this user, the AS shows a consent screen naming the client and each scope. First-party clients are usually pre-consented.
5. **Redirect back with code.** `302 Location: https://app.acme.io/callback?code=SplxlOB...&state=xyz`. The code is single-use and short-lived (≤60s recommended). The client **must** verify `state` before proceeding.
6. **Back-channel token exchange.** `POST /token` with `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `code_verifier`. Confidential clients also authenticate (client secret, or better, `private_key_jwt` / mTLS).
7. **AS validates and issues.** It checks the code is unused, unexpired, bound to this `client_id` and `redirect_uri`, and that `SHA256(code_verifier)` equals the stored challenge. It returns `access_token`, `token_type: Bearer`, `expires_in`, `refresh_token`, `id_token`, and the *granted* `scope` (which may be narrower than requested).
8. **Client validates the ID token** (signature via JWKS, `iss`/`aud`/`exp`/`nonce`) and establishes its own session. It does **not** validate the access token — that token is opaque to the client by design.
9. **API call.** `GET /v1/invoices` with `Authorization: Bearer <access_token>`. The resource server validates signature/introspection, `iss`, `aud`, `exp`, then checks `scope` contains `invoices:read`, then checks *object-level* ownership (`invoice.tenant_id == token.tenant_id`).
10. **Expiry and refresh.** On `401` with `WWW-Authenticate: Bearer error="invalid_token"`, the client posts `grant_type=refresh_token`. With rotation enabled it receives a *new* refresh token; the old one is now poison.
11. **Revocation and logout.** `POST /revoke` (RFC 7009) kills a refresh token family. OIDC RP-Initiated Logout redirects to `end_session_endpoint` to clear the AS session too.

```svg
<svg viewBox="0 0 780 400" width="100%" height="400" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="780" height="400" fill="#ffffff"/>
  <text x="18" y="24" font-size="15" font-weight="700" fill="#1e293b">Authorization Code + PKCE (OIDC)</text>

  <rect x="18" y="42" width="140" height="40" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="46" y="67" font-size="12" font-weight="700" fill="#1e293b">Client / SPA</text>
  <rect x="216" y="42" width="140" height="40" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="252" y="67" font-size="12" font-weight="700" fill="#1e293b">User Agent</text>
  <rect x="414" y="42" width="160" height="40" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="436" y="67" font-size="12" font-weight="700" fill="#1e293b">Authorization Srv</text>
  <rect x="622" y="42" width="140" height="40" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="650" y="67" font-size="12" font-weight="700" fill="#1e293b">Resource Srv</text>

  <g stroke="#94a3b8" stroke-width="1" stroke-dasharray="4 4"><line x1="88" y1="82" x2="88" y2="376"/><line x1="286" y1="82" x2="286" y2="376"/><line x1="494" y1="82" x2="494" y2="376"/><line x1="692" y1="82" x2="692" y2="376"/></g>

  <line x1="88" y1="106" x2="282" y2="106" stroke="#4f46e5" stroke-width="2"/>
  <polygon points="286,106 278,102 278,110" fill="#4f46e5"/>
  <text x="96" y="100" font-size="11" fill="#1e293b">1. verifier + S256 challenge, state, nonce</text>

  <line x1="286" y1="140" x2="490" y2="140" stroke="#0ea5e9" stroke-width="2"/>
  <polygon points="494,140 486,136 486,144" fill="#0ea5e9"/>
  <text x="294" y="134" font-size="11" fill="#1e293b">2. GET /authorize?code_challenge=...</text>

  <rect x="414" y="152" width="160" height="34" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="424" y="166" font-size="10" fill="#1e293b">3. authenticate user</text>
  <text x="424" y="180" font-size="10" fill="#1e293b">4. record consent</text>

  <line x1="490" y1="206" x2="290" y2="206" stroke="#16a34a" stroke-width="2"/>
  <polygon points="286,206 294,202 294,210" fill="#16a34a"/>
  <text x="300" y="200" font-size="11" fill="#1e293b">5. 302 ?code=SplxlOB&amp;state=xyz</text>

  <line x1="282" y1="234" x2="92" y2="234" stroke="#0ea5e9" stroke-width="2"/>
  <polygon points="88,234 96,230 96,238" fill="#0ea5e9"/>
  <text x="100" y="228" font-size="11" fill="#1e293b">code delivered to callback</text>

  <line x1="88" y1="266" x2="490" y2="266" stroke="#4f46e5" stroke-width="2.5"/>
  <polygon points="494,266 486,262 486,270" fill="#4f46e5"/>
  <text x="96" y="260" font-size="11" font-weight="700" fill="#1e293b">6. POST /token (back channel): code + code_verifier</text>

  <line x1="490" y1="300" x2="92" y2="300" stroke="#16a34a" stroke-width="2.5"/>
  <polygon points="88,300 96,296 96,304" fill="#16a34a"/>
  <text x="96" y="294" font-size="11" font-weight="700" fill="#1e293b">7. access_token + refresh_token + id_token</text>

  <rect x="18" y="312" width="200" height="30" rx="6" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="28" y="331" font-size="10" fill="#1e293b">8. validate id_token vs JWKS</text>

  <line x1="88" y1="362" x2="688" y2="362" stroke="#d97706" stroke-width="2.5"/>
  <polygon points="692,362 684,358 684,366" fill="#d97706"/>
  <text x="96" y="356" font-size="11" font-weight="700" fill="#1e293b">9. GET /v1/invoices  Authorization: Bearer &lt;access_token&gt;</text>
</svg>
```

**Other flows.** For machine-to-machine there is no user: the client posts `grant_type=client_credentials&scope=ledger:write&resource=https://api.acme.io` and gets an access token only — no refresh token (just re-request), no ID token (no user to identify); authenticate with `private_key_jwt` or mTLS, not a static shared secret. The **device authorization grant (RFC 8628)** covers input-constrained devices (TVs, CLIs): the device shows a short user code, the user enters it on a phone, and the device polls `/token` until approved.

---

## 5. Implementation

**Step 1 — build the authorization URL (Node):**

```javascript
import crypto from 'node:crypto';

const b64url = (buf) => buf.toString('base64url');
const verifier  = b64url(crypto.randomBytes(64));            // 86 chars
const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
const state = b64url(crypto.randomBytes(24));
const nonce = b64url(crypto.randomBytes(24));
// Persist verifier/state/nonce in an HttpOnly, SameSite=Lax session cookie.
const url = new URL('https://auth.acme.io/authorize');
url.search = new URLSearchParams({
  response_type: 'code',
  client_id: 'app_web_prod',
  redirect_uri: 'https://app.acme.io/callback',   // exact match, pre-registered
  scope: 'openid profile invoices:read',
  state, nonce,
  code_challenge: challenge,
  code_challenge_method: 'S256',
  resource: 'https://api.acme.io',                 // RFC 8707 audience pinning
}).toString();
```

**Step 2 — the token exchange, on the wire:**

```http
POST /token HTTP/1.1
Host: auth.acme.io
Content-Type: application/x-www-form-urlencoded
Authorization: Basic YXBwX3dlYl9wcm9kOnNfM2Ux...

grant_type=authorization_code
&code=SplxlOBeZQQYbYS6WxSbIA
&redirect_uri=https%3A%2F%2Fapp.acme.io%2Fcallback
&client_id=app_web_prod
&code_verifier=dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk
```

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store

{
  "access_token": "eyJhbGciOiJSUzI1NiIsImtpZCI6IjIwMjUtMDYifQ...",
  "token_type": "Bearer",
  "expires_in": 900,
  "refresh_token": "v1.MnLh8xQ...",
  "id_token": "eyJhbGciOiJSUzI1NiIsImtpZCI6IjIwMjUtMDYifQ...",
  "scope": "openid profile invoices:read"
}
```

> **Note:** `Cache-Control: no-store` on token responses is mandatory (RFC 6749 §5.1). A caching proxy that stores a token response is a credential leak.

**Step 3 — resource server validation (FastAPI):**

```python
import time, httpx
from fastapi import FastAPI, Depends, HTTPException, Request
from jose import jwt
from cachetools import TTLCache

app = FastAPI()
ISSUER, AUDIENCE = "https://auth.acme.io", "https://api.acme.io"
_jwks: TTLCache = TTLCache(maxsize=4, ttl=3600)   # cache keys for 1h, keyed by kid

async def jwks() -> dict:
    if "k" not in _jwks:
        async with httpx.AsyncClient(timeout=3.0) as c:
            meta = (await c.get(f"{ISSUER}/.well-known/openid-configuration")).json()
            _jwks["k"] = (await c.get(meta["jwks_uri"])).json()
    return _jwks["k"]

async def require_scope(request: Request, scope: str) -> dict:
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(401, "missing bearer token",
                            headers={"WWW-Authenticate": 'Bearer realm="api"'})
    token = auth[7:]
    try:
        claims = jwt.decode(
            token, await jwks(),
            algorithms=["RS256", "ES256"],   # allow-list; NEVER read alg from the header
            audience=AUDIENCE, issuer=ISSUER,
            options={"require_exp": True, "require_iat": True},
        )
    except Exception:
        raise HTTPException(401, "invalid_token", headers={
            "WWW-Authenticate": 'Bearer error="invalid_token"'})
    if scope not in claims.get("scope", "").split():
        raise HTTPException(403, "insufficient_scope", headers={
            "WWW-Authenticate": f'Bearer error="insufficient_scope", scope="{scope}"'})
    return claims

@app.get("/v1/invoices")
async def list_invoices(request: Request):
    claims = await require_scope(request, "invoices:read")
    tenant = claims["tenant_id"]          # object-level filter, not optional
    return {"data": await repo.list_invoices(tenant_id=tenant, limit=50)}
```

**Step 4 — refresh with rotation:**

```bash
curl -sS -X POST https://auth.acme.io/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d grant_type=refresh_token \
  -d refresh_token="$RT" \
  -d client_id=app_web_prod \
  -d scope='invoices:read'          # may down-scope, never up-scope
```

A reuse of an already-rotated refresh token must return:

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{ "error": "invalid_grant",
  "error_description": "refresh token reuse detected; family revoked" }
```

**Step 5 — OpenAPI 3.1 fragment:**

```yaml
components:
  securitySchemes:
    oauth2:
      type: oauth2
      flows:
        authorizationCode:
          authorizationUrl: https://auth.acme.io/authorize
          tokenUrl: https://auth.acme.io/token
          refreshUrl: https://auth.acme.io/token
          scopes:
            invoices:read: Read invoices for the authenticated tenant
            invoices:write: Create and void invoices
paths:
  /v1/invoices:
    get:
      security: [{ oauth2: [invoices:read] }]
      responses:
        '200': { description: OK }
        '401': { description: Missing or invalid token }
        '403': { description: Token lacks invoices:read }
```

**Optimization note.** Never call `/introspect` per request against a remote AS — that adds a synchronous network hop to your p99 and couples your API's availability to the AS. Prefer self-contained JWT access tokens validated locally against a **cached JWKS** (cache by `kid`, TTL 1h, refresh-on-unknown-`kid` with a rate limit so a bogus `kid` cannot DoS your JWKS endpoint). If you must introspect (opaque tokens, immediate revocation), cache the positive result for `min(30s, exp - now)` keyed by a hash of the token. Measured on a typical service, local RS256 verification is ~50–150 µs versus ~5–20 ms for a remote introspection round trip.

---

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Delegated access | User's password never reaches the client; access is revocable per-client | Four-party protocol with many failure modes; hard to reason about |
| Scopes | Coarse, user-visible consent boundaries that map well to consent UI | Too coarse for object-level rules; scope explosion (`invoices:read:eu:2024`) is a smell |
| JWT access tokens | Stateless, local validation, no AS round trip, scales linearly | Cannot be revoked before `exp`; forces short TTLs and a refresh dance |
| Opaque tokens + introspection | Instant revocation, tiny tokens, no claim leakage | Network hop per request; AS becomes a hard availability dependency |
| PKCE | Kills code interception and injection; costs one SHA-256 | None meaningful — the reason RFC 9700 makes it universal |
| Refresh rotation | Converts silent theft into a detectable, self-healing event | Race conditions with parallel tabs/retries; needs a short grace window |
| OIDC ID tokens | Standard identity claims, client-side validation, no bespoke `/userinfo` parsing | Tempting to misuse as an API credential; a real and common bug |
| DPoP / mTLS binding | Stolen token alone is worthless | Client key management, clock-skew handling, extra proof per request |
| Self-hosted AS | Full control over claims, sessions, and data residency | You now own a high-value crypto system; most teams should buy |

---

## 7. Common Mistakes & Best Practices

1. ⚠️ **Using the implicit grant (`response_type=token`) for a SPA.** → ✅ Authorization code + PKCE. Implicit is removed in OAuth 2.1 because it leaks tokens through URLs, history and `Referer`.
2. ⚠️ **Sending the ID token to your API as `Authorization: Bearer`.** → ✅ ID tokens are for the *client*; APIs accept *access* tokens. An API that accepts ID tokens has an `aud` mismatch and usually skips scope checks entirely.
3. ⚠️ **Skipping `state` or `nonce`.** → ✅ `state` prevents login CSRF (an attacker grafting their account onto your session); `nonce` prevents ID-token replay. Both are cheap; both are mandatory.
4. ⚠️ **Prefix or wildcard matching of `redirect_uri`.** → ✅ Exact string comparison against a registered allow-list. `https://app.acme.io/cb` must not match `https://app.acme.io.evil.com/cb` or `https://app.acme.io/cb/../../open-redirect`.
5. ⚠️ **Validating a JWT without pinning `aud` and `iss`.** → ✅ A token minted for the analytics API must be rejected by the payments API. Without `aud`, any service that trusts the same issuer becomes a confused deputy.
6. ⚠️ **Storing refresh tokens in `localStorage`.** → ✅ Any XSS exfiltrates them permanently. Use a backend-for-frontend holding tokens server-side with an `HttpOnly; Secure; SameSite=Lax` session cookie, or at minimum DPoP-bound tokens in memory.
7. ⚠️ **Treating scope as authorization.** → ✅ `invoices:read` says the *client* may read invoices; it says nothing about *which* invoices. Always add an object-level check (`row.tenant_id == claims.tenant_id`) or you have shipped BOLA/API1:2023.
8. ⚠️ **Long-lived access tokens ("24h is easier").** → ✅ 5–15 minutes plus a rotating refresh token. Long TTLs make revocation a fiction.
9. ⚠️ **Accepting `alg` from the token header, or fetching JWKS on every request (or never refreshing it).** → ✅ Hard-code an algorithm allow-list server-side (see chapter 20 for the alg-confusion class), and cache JWKS by `kid` with ~1h TTL plus a rate-limited refresh on unknown `kid` so rotation is seamless and unbounded fetches impossible.
10. ⚠️ **Reusing one client registration across web, mobile and CLI, or logging out only locally.** → ✅ One `client_id` per app type (secrets shipped in a mobile binary are public), and use RP-Initiated Logout against `end_session_endpoint` — clearing your own cookie leaves the AS session alive, so "log out" then "log in" silently re-authenticates.

---

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Ninety percent of OAuth incidents are one of four things: a `redirect_uri` byte-mismatch (trailing slash, `http` vs `https`, port), clock skew making `exp`/`nbf` fail (allow ≤60s leeway and run NTP), a stale JWKS after rotation, or an `aud` mismatch. Decode tokens with a *local* tool (`jwt` CLI, `python -m jose`) — never paste production tokens into a website. The AS's `error` and `error_description` on the redirect are the fastest signal: `invalid_grant` means code expired/reused/verifier mismatch; `invalid_client` means client auth failed; `invalid_scope` means an unregistered scope was requested.

**Monitoring.** Track: token issuance rate by grant type and client; `/token` error rate split by `error` code; **refresh-token reuse-detection events** (should be ~0 — every one is a potential theft); authorization-code exchange latency p50/p99; JWKS fetch rate and cache hit ratio; `401 invalid_token` vs `403 insufficient_scope` ratio on the RS (a spike in the latter means a client is misconfigured, not attacked); consent-grant and revocation counts. Alert on any nonzero rate of `alg=none` or unknown-`kid` attempts — those are active attacks, not bugs.

**Security.** Enforce TLS 1.2+ everywhere with HSTS on the AS. Pin `aud` via RFC 8707 `resource`. Rotate signing keys on a schedule (publish the new key in JWKS, wait past max token TTL, then sign with it, then retire the old). Rate-limit `/token` and `/authorize` per client and per IP. Log every consent grant and revocation with actor, client, scopes and timestamp for audit. For high-value flows require **PAR (RFC 9126)** so authorization parameters never appear in the browser URL, and **JAR (RFC 9101)** for signed request objects — both are FAPI 2.0 baseline requirements in financial APIs.

**Performance & scaling.** The authorization server is a tier-0 dependency: if `/token` is down, every session eventually expires and the whole product goes dark. Run it multi-AZ, keep `/jwks` behind a CDN with a sane `Cache-Control` (≈300s), and make resource servers fail *closed* on validation but *tolerant* of a briefly unreachable JWKS by serving from cache. Refresh storms after a mass token expiry are real — jitter client refresh at `exp - 60s ± random(30s)` rather than refreshing on 401 in lockstep. For very high-volume M2M, mint client-credentials tokens with 30–60 min TTL and cache them in the calling service.

---

## 9. Interview Questions

**Q: What problem does OAuth 2.0 actually solve, and what does it explicitly not solve?**
A: It solves *delegated authorization*: letting a third-party client act on a user's behalf with a scoped, expiring, revocable credential instead of the user's password. It explicitly does not solve authentication — an access token proves someone authorised the client, not who that someone is. OpenID Connect adds that identity layer via the ID token.

**Q: Why is the authorization code grant safer than the implicit grant?**
A: Implicit returns the access token in a URL fragment on the front channel, where it lands in browser history, `Referer` headers and proxy logs. The code grant puts only a single-use code on the front channel and exchanges it for tokens over a direct back-channel TLS call. Implicit is removed in OAuth 2.1 and RFC 9700.

**Q: Explain PKCE in terms of what an attacker gains and loses.**
A: The client sends `SHA256(code_verifier)` on `/authorize` and the raw verifier on `/token`. An attacker who intercepts the redirect gets the code but not the verifier, so the token endpoint rejects the exchange. It defeats both code interception on mobile custom schemes and code injection into a victim's session.

**Q: Access token vs refresh token vs ID token — who consumes each?**
A: The access token is consumed by the resource server as `Authorization: Bearer`. The refresh token is consumed only by the authorization server's token endpoint and must never reach an API. The ID token is consumed by the client to learn who logged in and is never a valid API credential.

**Q: What must a resource server validate on a JWT access token?**
A: Signature against a JWKS key selected by `kid` with a server-side algorithm allow-list; `iss` equals the expected issuer; `aud` includes this API; `exp`/`nbf` with ≤60s clock leeway; then the required `scope`; then object-level ownership of the specific resource being touched.

**Q: How do you revoke a stateless JWT before it expires?**
A: Strictly you cannot, which is why TTLs are short. Practical options: keep a denylist of `jti` values in Redis until `exp`; bump a per-user or per-tenant `token_version` claim and reject stale versions; or use opaque tokens with introspection when hard revocation is a requirement.

**Q: When is the client credentials grant appropriate?**
A: Machine-to-machine calls where no user is involved and the client acts as itself — batch jobs, service-to-service, partner integrations. There is no refresh token or ID token. Authenticate with `private_key_jwt` or mTLS rather than a static secret.

**Q: (Senior) Design token handling for a SPA on a different origin from the API. Justify every choice.**
A: Use a backend-for-frontend: the BFF runs the code+PKCE flow, holds access and refresh tokens server-side, and gives the browser only an `HttpOnly; Secure; SameSite=Lax` session cookie, proxying API calls. This removes tokens from JavaScript reach entirely, so XSS can at most ride the session rather than exfiltrate a long-lived refresh token. If a BFF is impossible, keep the access token in memory only, never in `localStorage`, use rotating refresh tokens with reuse detection, and bind tokens with DPoP.

**Q: (Senior) Refresh token rotation breaks when a client fires two refreshes concurrently. How do you handle it?**
A: Serialise refreshes client-side behind a single in-flight promise or mutex so parallel tabs share one result. Server-side, allow a short grace window (a few seconds) in which the immediately-preceding refresh token still returns the *same* new pair, distinguishing a retry from a theft. Outside that window, reuse means revoke the whole family and force re-authentication, and emit a security event.

**Q: (Senior) You inherit an API where every service validates tokens differently. What is your remediation plan?**
A: Centralise validation in a shared library or at the gateway with a single hardened path: fixed algorithm allow-list, mandatory `iss`/`aud`/`exp`, cached JWKS with `kid` rotation, and a canonical claims object passed downstream over a trusted internal header or mTLS-authenticated hop. Add contract tests that assert rejection of `alg=none`, wrong `aud`, expired tokens and unknown `kid`. Then instrument per-service acceptance metrics so you can prove every service is on the shared path before deleting the old code.

**Q: (Senior) What is a mix-up attack and how do PAR and the `iss` parameter mitigate it?**
A: If a client supports multiple authorization servers and an attacker can influence which one is used, the client may send a code minted by a malicious AS to the honest AS's token endpoint, or leak its credentials. RFC 9207 adds an `iss` parameter to the authorization response so the client can confirm which AS actually responded; PAR (RFC 9126) pushes parameters back-channel so they cannot be tampered with in the browser at all.

**Q: How does OIDC discovery reduce operational risk?**
A: `/.well-known/openid-configuration` publishes endpoints, supported algorithms and the `jwks_uri`, so clients and resource servers resolve them at runtime instead of hard-coding. That makes key rotation, endpoint moves and algorithm upgrades a server-side change rather than a coordinated redeploy of every consumer.

---

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** OAuth 2.0 replaces password sharing with a scoped, expiring, revocable access token issued by an authorization server. The only grant you should design new systems around is **authorization code with PKCE (S256)** — plus **client credentials** for machine-to-machine and **device code** for input-constrained devices; implicit and password grants are removed in OAuth 2.1. The front channel carries only a single-use code; tokens are fetched over the back channel. `state` stops CSRF, `nonce` stops ID-token replay, PKCE stops code interception and injection. OIDC adds the ID token — a signed JWT the *client* validates (`iss`, `aud`, `exp`, `nonce`) to learn who logged in. Resource servers validate access tokens (signature via cached JWKS, `iss`, `aud`, `exp`), then scope, then object-level ownership. Access tokens live minutes; refresh tokens rotate with reuse detection; DPoP or mTLS turn bearer tokens into sender-constrained ones.

| Item | Value / Rule |
|---|---|
| Recommended grant | `authorization_code` + PKCE `S256` (all clients) |
| Deprecated grants | `implicit`, `password` (ROPC) — removed in OAuth 2.1 |
| M2M grant | `client_credentials` + `private_key_jwt` or mTLS |
| Access token TTL | 5–15 min (sensitive) / 60 min (max sane); rotate refresh every use |
| API header | `Authorization: Bearer <access_token>` |
| Missing/invalid token | `401` + `WWW-Authenticate: Bearer error="invalid_token"` |
| Valid token, wrong scope | `403` + `error="insufficient_scope", scope="..."` |
| Token endpoint response | `200` + `Cache-Control: no-store` |
| Refresh reuse detected | `400` + `{"error":"invalid_grant"}` |
| Discovery | `GET /.well-known/openid-configuration` |
| Key RFCs | 6749, 7636 (PKCE), 8628 (device), 9068 (JWT AT), 9126 (PAR), 9207 (iss), 9449 (DPoP), 9700 (BCP) |

**Flash cards**

- **Why is the access token useless to a code interceptor?** → They never get one: the code is exchanged over the back channel and PKCE binds it to the original `code_verifier`.
- **Which token does the API accept?** → The access token only. ID tokens are for clients; refresh tokens only for `/token`.
- **What does `nonce` protect?** → ID-token replay: the value must round-trip inside the ID token from the same authorization request.
- **401 or 403 for a valid token missing a scope?** → `403` with `insufficient_scope`; `401` is only for missing/invalid/expired credentials.
- **What makes refresh-token theft detectable?** → Rotation plus reuse detection: a second presentation of a rotated token revokes the entire family.

---

## 11. Hands-On Exercises & Mini Project

- [ ] Implement the PKCE pair generator and verify by hand that `base64url(sha256(verifier))` equals the challenge your library produces; then deliberately corrupt the verifier and confirm the token endpoint returns `invalid_grant`.
- [ ] Fetch `/.well-known/openid-configuration` from a public issuer (Google, Auth0, Keycloak) and write a script that resolves `jwks_uri`, caches keys by `kid`, and re-fetches only on an unknown `kid`.
- [ ] Build a resource-server middleware that returns `401` for a missing token, `401 invalid_token` for an expired one, and `403 insufficient_scope` for a valid token lacking `invoices:write` — assert all three with tests.
- [ ] Simulate refresh-token theft: refresh once, replay the old refresh token, and implement family revocation plus a security event on detection. Then present a token issued for `https://api.acme.io` to a service expecting `https://billing.acme.io`, confirm rejection, and remove the `aud` check to observe the confused-deputy hole you just opened.

**Mini Project — "Connect" style third-party integration**

*Goal:* build a miniature Stripe-Connect-like integration end to end.

*Requirements:*
1. An authorization server (Keycloak or Ory Hydra in Docker, or a hand-rolled one) with two scopes: `invoices:read` and `invoices:write`.
2. A resource server (FastAPI) exposing `GET /v1/invoices` and `POST /v1/invoices`, enforcing scope *and* `tenant_id` object-level filtering.
3. A confidential web client that runs authorization code + PKCE, validates the ID token (`iss`, `aud`, `exp`, `nonce`), and stores tokens server-side behind an `HttpOnly` session cookie.
4. Refresh-token rotation with reuse detection and a `/revoke` call on logout, plus RP-initiated logout at the AS.
5. Structured audit logs for every consent, issuance, refresh, reuse-detection and revocation event.

*Extensions:* add DPoP proof-of-possession; add the device authorization grant for a CLI companion; add PAR so no authorization parameters appear in the browser URL; add a second resource server and prove that audience pinning stops cross-API token reuse; wire a dashboard showing active grants per client with one-click revocation.

---

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *JWT: Structure, Validation & Pitfalls* (chapter 20) goes deep on token verification and the alg-confusion bug class; *Authorization: RBAC, ABAC & Scopes* (chapter 21) covers what to do *after* the token is valid; *TLS, CORS & Security Headers* (chapter 22) covers the browser constraints every redirect flow runs into; *OWASP API Security Top 10* (chapter 23) places broken authentication (API2) and broken object-level authorization (API1) in context; *Rate Limiting, Quotas & Throttling* (chapter 24) covers protecting `/token` and `/authorize` from abuse.

- **RFC 6749 — The OAuth 2.0 Authorization Framework** — IETF · *Intermediate* · the normative source for grant types, endpoints and error codes; read §4.1 and §10 in full. <https://www.rfc-editor.org/rfc/rfc6749>
- **RFC 7636 — Proof Key for Code Exchange** — IETF · *Intermediate* · short and readable; explains exactly what PKCE binds and why `S256` beats `plain`. <https://www.rfc-editor.org/rfc/rfc7636>
- **RFC 9700 — OAuth 2.0 Security Best Current Practice** — IETF · *Advanced* · the single most useful modern document: what changed since 2012 and why implicit/ROPC are gone. <https://www.rfc-editor.org/rfc/rfc9700>
- **OpenID Connect Core 1.0** — OpenID Foundation · *Advanced* · defines the ID token, claim set and the exact validation steps a client must perform. <https://openid.net/specs/openid-connect-core-1_0.html>
- **OAuth 2.0 Simplified** — Aaron Parecki · *Beginner* · the clearest free prose introduction; excellent flow diagrams and a "which grant do I use" decision guide. <https://www.oauth.com/>
- **OWASP Authentication Cheat Sheet** — OWASP · *Intermediate* · practical hardening rules for sessions, tokens and logout that complement the RFCs. <https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html>
- **RFC 9068 — JWT Profile for OAuth 2.0 Access Tokens** — IETF · *Advanced* · standardises the claims (`aud`, `client_id`, `scope`, `jti`) resource servers should expect in JWT access tokens. <https://www.rfc-editor.org/rfc/rfc9068>
- **Stripe Connect OAuth Reference** — Stripe · *Intermediate* · a production-grade public implementation you can read end to end, including scope design and revocation. <https://docs.stripe.com/connect/oauth-reference>

---

*REST API Handbook — chapter 19.*
