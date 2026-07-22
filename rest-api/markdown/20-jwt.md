# 20 · JWT: Structure, Validation & Pitfalls

> **In one line:** A JWT is three base64url segments joined by dots — a header, a claims payload and a signature — and every serious JWT bug comes from trusting the first segment or skipping a check on the second.

---

## 1. Overview

A JSON Web Token (RFC 7519) is a compact, URL-safe way to carry a set of claims between two parties such that the receiver can verify the claims were not tampered with. In practice "JWT" almost always means **JWS Compact Serialization** (RFC 7515): `base64url(header) . base64url(payload) . base64url(signature)`. The signature covers the *exact ASCII bytes* of the first two segments joined by a dot — which is why you must never re-serialise the JSON before verifying.

The problem it solves is **stateless trust across a network boundary**. Classic session cookies require the server to look up a session record on every request; that lookup is a database round trip and a shared-state dependency that makes horizontal scaling and multi-region deployment painful. A JWT moves the state into the credential itself: the API validates a signature locally in ~50–150 µs and reads `sub`, `scope` and `tenant_id` straight out of the payload with zero I/O. That is genuinely transformative for a fleet of stateless services behind a gateway.

The lineage matters because it explains the footguns. JOSE (JSON Object Signing and Encryption) was designed in 2011–2015 as a *general-purpose, algorithm-agile* framework: RFC 7515 (JWS), 7516 (JWE), 7517 (JWK), 7518 (JWA), 7519 (JWT). Algorithm agility means the token itself declares which algorithm to use — and that single design decision is the root of the entire **alg-confusion** bug class. RFC 8725 (JWT Best Current Practices, 2020) exists specifically to tell you to ignore the header's `alg` and use a server-side allow-list instead.

A concrete example: **Auth0, Okta, AWS Cognito, Firebase, Keycloak and Kubernetes service accounts** all issue RS256- or ES256-signed JWTs. A Kubernetes projected service-account token is a JWT with `iss: https://kubernetes.default.svc`, an audience naming the intended API, a short `exp`, and a `kubernetes.io` claim block naming the pod and namespace. The kube-apiserver validates it against a published JWKS — the same primitives you would use for a customer-facing API, at cluster scale.

The critical honest framing for an interview: **a JWT is a signed assertion, not a session.** It is fast because it is not revocable, and it is not revocable because it is fast. If your design needs immediate revocation, you either accept short TTLs plus a small denylist, or you use opaque tokens with introspection and pay the network hop. Anyone who tells you JWTs are strictly better than sessions is selling something.

---

## 2. Core Concepts

- **JWS** — JSON Web Signature. A signed (integrity-protected) token. The payload is *encoded, not encrypted* — anyone can read it.
- **JWE** — JSON Web Encryption. A token whose payload is actually confidential; five segments, not three. Rare in APIs, used when claims contain PII.
- **Registered claims** — the IANA-registered set from RFC 7519 §4.1: `iss`, `sub`, `aud`, `exp`, `nbf`, `iat`, `jti`. Short names, defined semantics.
- **`kid`** — key ID in the header. Selects which key from the issuer's JWKS to verify against; the *only* header field you should trust, and only as a lookup key into a set you control.
- **JWKS** — JSON Web Key Set, published at `jwks_uri` (usually `/.well-known/jwks.json`). A JSON array of public keys with `kty`, `kid`, `use`, `alg`, and key material (`n`/`e` for RSA, `crv`/`x`/`y` for EC).
- **HS256** — HMAC-SHA256, a *symmetric* MAC. Signer and verifier share one secret, so every verifier can also forge.
- **RS256 / PS256 / ES256 / EdDSA** — *asymmetric* signatures. The issuer holds the private key; verifiers hold only a public key and cannot forge. Prefer ES256 or EdDSA for size and speed, RS256 for compatibility.
- **Alg confusion** — an attack that makes the verifier use a key of a different type than intended (e.g. verifying an HS256 token using an RSA *public* key as the HMAC secret).
- **Clock skew leeway** — a small tolerance (≤60 s) applied to `exp`/`nbf`/`iat` so unsynchronised clocks do not cause spurious 401s.
- **Token binding / `cnf`** — a confirmation claim (RFC 7800) tying the token to a key the presenter must prove possession of, as used by DPoP and mTLS-bound tokens.

---

## 3. Theory & Principles

**The three segments.** Decode a real token and you see:

```json
{ "header": { "alg": "RS256", "typ": "at+jwt", "kid": "2025-06-a" },
  "payload": {
    "iss": "https://auth.acme.io", "sub": "usr_8f21c", "aud": "https://api.acme.io",
    "exp": 1774915200, "iat": 1774914300, "jti": "9c1f2ab4", "scope": "invoices:read",
    "tenant_id": "ten_42", "client_id": "app_web_prod"
  }
}
```

The signing input is the literal string `header_b64 + "." + payload_b64`. Base64url uses `-` and `_` instead of `+` and `/` and strips `=` padding, so a JWT is safe in URLs, headers and cookies — but it is **not encryption**. Putting a password, a card number or an internal database DSN in a JWT payload is publishing it.

**Why `typ: at+jwt` matters.** RFC 9068 defines the media type `application/at+jwt` for OAuth access tokens. Setting and *checking* `typ` prevents **cross-token substitution**: an ID token (`typ: JWT`, `aud: <client_id>`) presented to an API, or a refresh token presented as an access token. Combined with strict `aud` checking, it closes an entire confusion family.

**The alg-confusion class, precisely.** There are three distinct bugs, and interviewers expect you to separate them:

1. **`alg: none`.** RFC 7515 defines an "Unsecured JWS" with an empty signature. A naive verifier that switches on the header's `alg` will happily accept `eyJhbGciOiJub25lIn0.<payload>.` with no signature at all. Fix: never accept `none`; hard-code an allow-list.
2. **RS256 → HS256 downgrade.** The verifier is given "the issuer's key" and asked to verify whatever the header says. The attacker changes `alg` to `HS256` and HMACs the token using the issuer's **public** key (which is, by definition, public) as the shared secret. The library dutifully computes HMAC-SHA256 with that byte string and it matches. Fix: bind the algorithm to the key type, not to the header.
3. **`jku` / `jwk` / `x5u` header injection.** Some libraries honour a `jku` (JWK Set URL) or embedded `jwk` in the header, letting the attacker supply their own key. Fix: ignore all key-locating headers except `kid`, and resolve `kid` only against a JWKS fetched from a hard-configured issuer.

**The validation order is not arbitrary.** Parse → select key by `kid` → verify signature with an allow-listed algorithm → *then* read claims. Reading claims before verifying the signature means acting on attacker-controlled JSON. Then check, in order: `iss` (exact match), `aud` (must contain this API's identifier), `exp` (with leeway), `nbf`/`iat` (with leeway), `typ`, and finally application claims (`scope`, `tenant_id`, `jti` denylist).

**Signature math and cost.** HS256 is a keyed hash: one pass, sub-microsecond, but symmetric. RS256 verification is a modular exponentiation with a small public exponent (65537) — fast to verify (~30–60 µs for 2048-bit), slow to sign. ES256 (ECDSA over P-256) produces a 64-byte signature versus RSA-2048's 256 bytes, so an ES256 token is ~250 bytes shorter — meaningful when the token rides on every request and header budgets are ~8 KB. EdDSA (Ed25519) is faster still and has no nonce-reuse failure mode.

```svg
<svg viewBox="0 0 780 340" width="100%" height="340" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="780" height="340" fill="#ffffff"/>
  <text x="18" y="24" font-size="15" font-weight="700" fill="#1e293b">JWS Compact Serialization and the signing input</text>
  <rect x="18" y="42" width="228" height="60" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="32" y="62" font-size="12" font-weight="700" fill="#1e293b">HEADER (b64url)</text>
  <text x="32" y="80" font-size="10" fill="#1e293b">alg: RS256  typ: at+jwt</text>
  <text x="32" y="95" font-size="10" fill="#1e293b">kid: 2025-06-a</text>
  <text x="252" y="78" font-size="18" font-weight="700" fill="#1e293b">.</text>
  <rect x="268" y="42" width="248" height="60" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="282" y="62" font-size="12" font-weight="700" fill="#1e293b">PAYLOAD (b64url)</text>
  <text x="282" y="80" font-size="10" fill="#1e293b">iss aud sub exp iat jti</text>
  <text x="282" y="95" font-size="10" fill="#1e293b">scope tenant_id  NOT ENCRYPTED</text>
  <text x="522" y="78" font-size="18" font-weight="700" fill="#1e293b">.</text>
  <rect x="538" y="42" width="224" height="60" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="552" y="62" font-size="12" font-weight="700" fill="#1e293b">SIGNATURE (b64url)</text>
  <text x="552" y="80" font-size="10" fill="#1e293b">Sign(privKey,</text>
  <text x="552" y="95" font-size="10" fill="#1e293b">  header_b64 + "." + payload_b64)</text>
  <path d="M 132 108 L 132 126 L 650 126 L 650 108" fill="none" stroke="#4f46e5" stroke-width="1.5" stroke-dasharray="4 3"/>
  <text x="300" y="142" font-size="11" fill="#1e293b">signing input = exact ASCII bytes of segment 1 + "." + segment 2</text>
  <rect x="18" y="162" width="744" height="164" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="34" y="184" font-size="13" font-weight="700" fill="#1e293b">Mandatory validation order (RFC 8725)</text>
  <text x="34" y="206" font-size="11" fill="#1e293b">1. Split and base64url-decode. Do NOT parse claims yet.</text>
  <text x="34" y="224" font-size="11" fill="#1e293b">2. Read kid only. Ignore alg, jku, jwk, x5u from the header.</text>
  <text x="34" y="242" font-size="11" fill="#1e293b">3. Look up key by kid in a JWKS from a hard-configured issuer.</text>
  <text x="34" y="260" font-size="11" fill="#1e293b">4. Verify signature with a server-side algorithm allow-list bound to the key type.</text>
  <text x="34" y="278" font-size="11" fill="#1e293b">5. Check iss (exact), aud (contains this API), exp / nbf / iat (leeway &lt;= 60s), typ.</text>
  <text x="34" y="296" font-size="11" fill="#1e293b">6. Check jti against a revocation denylist if you need sub-TTL revocation.</text>
  <text x="34" y="314" font-size="11" font-weight="700" fill="#1e293b">7. Only now read scope / tenant_id and authorize the specific object.</text>
</svg>
```

---

## 4. Architecture & Workflow

A production JWT pipeline has an **issuance side** and a **verification side** that share only a public key set. Step by step:

1. **Key generation.** The authorization server generates an asymmetric key pair (ES256 or RS256) in an HSM or KMS. The private key never leaves; signing is an API call. Each key gets a stable `kid` — a hash of the public key or a date-stamped identifier like `2025-06-a`.
2. **JWKS publication.** The public key is published at `https://auth.acme.io/.well-known/jwks.json` with `Cache-Control: public, max-age=300`. The set contains *all currently valid* keys, not just the active signer.
3. **Issuance.** After a successful OAuth flow, the AS builds the claim set, sets `exp = now + 900`, `iat = now`, a random `jti`, the `aud` from the requested `resource` parameter, and signs. `typ` is `at+jwt` for access tokens, `JWT` for ID tokens.
4. **Transport.** `Authorization: Bearer <jwt>` over TLS. Never in a query string (logged, cached, in `Referer`), never in `localStorage` if you can avoid it.
5. **Gateway pre-check (optional).** An API gateway can verify signature and `exp` once at the edge and reject early, saving backend CPU. It must still forward the token — the service does its own check, because a gateway is not a trust boundary you want to be single.
6. **Service verification.** The service loads the JWKS (cached, keyed by `kid`), verifies, then applies the full claim checklist from §3.
7. **Unknown `kid` handling.** If the `kid` is absent from cache, refresh the JWKS **once**, rate-limited (e.g. max 1 refresh per 30 s per process, with a singleflight lock so 500 concurrent requests trigger one fetch). Without that limit, a forged `kid` becomes a DoS amplifier against your own AS.
8. **Rotation.** Publish the new public key to JWKS → wait longer than the maximum token TTL plus the maximum JWKS cache TTL → start signing with the new key → wait another max-TTL → remove the old public key. Overlapping validity is what makes rotation invisible to clients.
9. **Revocation.** For sub-TTL revocation, maintain a Redis set of revoked `jti` (or a `token_version` per user) with TTL equal to the remaining token lifetime. Because access tokens live 15 minutes, this set stays tiny.

```svg
<svg viewBox="0 0 780 360" width="100%" height="360" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="780" height="360" fill="#ffffff"/>
  <text x="18" y="24" font-size="15" font-weight="700" fill="#1e293b">JWKS distribution, verification and zero-downtime key rotation</text>
  <rect x="18" y="46" width="164" height="70" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="34" y="68" font-size="12" font-weight="700" fill="#1e293b">Auth Server</text>
  <text x="34" y="86" font-size="10" fill="#1e293b">private key in KMS/HSM</text>
  <text x="34" y="102" font-size="10" fill="#1e293b">signs with kid=2025-06-a</text>
  <rect x="240" y="46" width="164" height="70" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="256" y="68" font-size="12" font-weight="700" fill="#1e293b">/jwks.json (CDN)</text>
  <text x="256" y="86" font-size="10" fill="#1e293b">max-age=300</text>
  <text x="256" y="102" font-size="10" fill="#1e293b">holds old + new keys</text>
  <rect x="462" y="46" width="150" height="70" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="478" y="68" font-size="12" font-weight="700" fill="#1e293b">Gateway</text>
  <text x="478" y="86" font-size="10" fill="#1e293b">early reject on sig/exp</text>
  <text x="478" y="102" font-size="10" fill="#1e293b">forwards token intact</text>
  <rect x="656" y="46" width="106" height="70" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="672" y="68" font-size="12" font-weight="700" fill="#1e293b">Service</text>
  <text x="672" y="86" font-size="10" fill="#1e293b">full claim</text>
  <text x="672" y="102" font-size="10" fill="#1e293b">validation</text>
  <line x1="182" y1="81" x2="236" y2="81" stroke="#16a34a" stroke-width="2"/>
  <polygon points="240,81 232,77 232,85" fill="#16a34a"/>
  <line x1="404" y1="81" x2="458" y2="81" stroke="#0ea5e9" stroke-width="2"/>
  <polygon points="462,81 454,77 454,85" fill="#0ea5e9"/>
  <line x1="612" y1="81" x2="652" y2="81" stroke="#4f46e5" stroke-width="2"/>
  <polygon points="656,81 648,77 648,85" fill="#4f46e5"/>
  <rect x="18" y="140" width="744" height="90" rx="10" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="34" y="162" font-size="13" font-weight="700" fill="#1e293b">Rotation timeline (overlap is what makes it invisible)</text>
  <line x1="46" y1="196" x2="734" y2="196" stroke="#1e293b" stroke-width="1.5"/>
  <circle cx="110" cy="196" r="6" fill="#16a34a"/><text x="70" y="216" font-size="10" fill="#1e293b">T0 publish new</text>
  <circle cx="300" cy="196" r="6" fill="#0ea5e9"/><text x="250" y="216" font-size="10" fill="#1e293b">T0+cacheTTL sign new</text>
  <circle cx="520" cy="196" r="6" fill="#d97706"/><text x="464" y="216" font-size="10" fill="#1e293b">T0+2x maxTTL retire old</text>
  <circle cx="700" cy="196" r="6" fill="#4f46e5"/><text x="654" y="216" font-size="10" fill="#1e293b">steady state</text>
  <text x="70" y="184" font-size="10" fill="#1e293b">both keys valid</text>
  <rect x="18" y="248" width="744" height="98" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="34" y="270" font-size="13" font-weight="700" fill="#1e293b">Unknown kid path (must be rate limited)</text>
  <text x="34" y="292" font-size="11" fill="#1e293b">token.kid not in cache  &#8594;  singleflight lock  &#8594;  refresh JWKS at most 1x / 30s per process</text>
  <text x="34" y="310" font-size="11" fill="#1e293b">still unknown  &#8594;  401 invalid_token, emit security metric jwt.unknown_kid</text>
  <text x="34" y="330" font-size="11" font-weight="700" fill="#1e293b">Without the limit, a forged kid turns every request into a fetch against your own auth server.</text>
</svg>
```

---

## 5. Implementation

**Verification done correctly (Python, PyJWT):**

```python
import time, threading, httpx, jwt
from jwt import PyJWKClient
from fastapi import FastAPI, Request, HTTPException

ISSUER   = "https://auth.acme.io"
AUDIENCE = "https://api.acme.io"
ALGS     = ["RS256", "ES256"]          # allow-list; the header's alg is IGNORED
jwk_client = PyJWKClient(f"{ISSUER}/.well-known/jwks.json",
                         cache_keys=True, lifespan=3600, max_cached_keys=8)

def verify(token: str) -> dict:
    signing_key = jwk_client.get_signing_key_from_jwt(token).key   # selects by kid
    claims = jwt.decode(
        token, signing_key,
        algorithms=ALGS,                    # never [header['alg']]
        audience=AUDIENCE,
        issuer=ISSUER,
        leeway=30,                          # clock skew, seconds
        options={"require": ["exp", "iat", "iss", "aud", "sub"],
                 "verify_exp": True, "verify_aud": True, "verify_iss": True},
    )
    hdr = jwt.get_unverified_header(token)
    if hdr.get("typ", "").lower() not in ("at+jwt", "jwt"):
        raise jwt.InvalidTokenError("unexpected typ")
    if revoked(claims["jti"]):              # Redis SISMEMBER, TTL = remaining exp
        raise jwt.InvalidTokenError("revoked")
    return claims
```

**The 401 an API must return:**

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="api", error="invalid_token",
  error_description="The access token expired"
Content-Type: application/problem+json

{
  "type": "https://api.acme.io/problems/invalid-token",
  "title": "Invalid or expired access token",
  "status": 401,
  "detail": "Token expired at 2026-07-22T09:14:00Z"
}
```

> **Note:** `401` means *we could not authenticate you*. A perfectly valid token that lacks a required scope is `403` with `error="insufficient_scope"`. Returning `403` for an expired token breaks every client's automatic-refresh logic.

**Node/Express verification with `jose`:**

```javascript
import { createRemoteJWKSet, jwtVerify } from 'jose';

const JWKS = createRemoteJWKSet(new URL('https://auth.acme.io/.well-known/jwks.json'), {
  cooldownDuration: 30_000,     // rate-limit refetch on unknown kid
  cacheMaxAge: 600_000,
});

export async function requireAuth(req, res, next) {
  const m = /^Bearer (.+)$/.exec(req.get('authorization') ?? '');
  if (!m) return res.status(401).set('WWW-Authenticate', 'Bearer realm="api"').end();
  try {
    const { payload } = await jwtVerify(m[1], JWKS, {
      issuer: 'https://auth.acme.io',
      audience: 'https://api.acme.io',
      algorithms: ['ES256', 'RS256'],
      clockTolerance: '30s',
      typ: 'at+jwt',
      requiredClaims: ['sub', 'jti', 'scope'],
    });
    req.auth = payload;
    next();
  } catch (e) {
    res.status(401).set('WWW-Authenticate',
      `Bearer error="invalid_token", error_description="${e.code ?? 'invalid'}"`).end();
  }
}
```

**Inspecting a token from the shell (locally — never paste production tokens into a website):**

```bash
T='eyJhbGciOiJFUzI1NiIsImtpZCI6IjIwMjUtMDYtYSIsInR5cCI6ImF0K2p3dCJ9.eyJzdWIiOiJ1c3JfOGYyMSJ9.sig'
for i in 1 2; do
  echo "$T" | cut -d. -f$i | tr '_-' '/+' | base64 -d 2>/dev/null | python3 -m json.tool
done
```

**A JWKS document:**

```json
{ "keys": [
  { "kty": "EC", "crv": "P-256", "kid": "2025-06-a", "use": "sig", "alg": "ES256",
    "x": "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
    "y": "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0" },
  { "kty": "RSA", "kid": "2024-11-legacy", "use": "sig", "alg": "RS256",
    "n": "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx...", "e": "AQAB" }
] }
```

**Optimization note.** Verification cost is dominated by the asymmetric operation and by JSON parsing. Three wins, in order of impact: (1) **cache the parsed key object**, not the raw JWKS JSON — re-constructing an RSA public key per request costs more than the verification itself; (2) prefer **ES256/EdDSA** over RS256 — smaller tokens mean less header bandwidth on every hop and faster base64 decode, and Ed25519 verification is roughly 3–5× faster than RSA-2048 in most libraries; (3) if the gateway already verified the signature, services can skip re-verification *only* if the gateway-to-service hop is mTLS-authenticated and the token is re-signed or passed with an internal proof — otherwise re-verify, because 60 µs is cheaper than a lateral-movement incident. Keep tokens small: every claim rides on every request, and a 4 KB token with embedded permission lists will hit proxy header limits (`431 Request Header Fields Too Large`).

---

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Stateless validation | No DB or cache lookup; ~50–150 µs local verify; scales horizontally with zero shared state | Cannot revoke before `exp` without reintroducing shared state |
| Self-contained claims | `sub`, `scope`, `tenant_id` available with no round trip; great for gateways and service meshes | Claims go stale — a role revoked at 10:00 is still honoured until the token expires |
| Asymmetric signing | Verifiers hold only public keys; a compromised service cannot mint tokens | Key management, JWKS distribution, rotation choreography |
| Compact and URL-safe | Fits in a header, a cookie, a query param (don't), a WebSocket subprotocol | Every claim you add is paid on *every* request; 8 KB header limits are real |
| Algorithm agility | Can migrate RS256 → ES256 → EdDSA without a protocol change | The entire alg-confusion bug class exists because of it |
| Transparency | Debuggable — decode and read the claims in any language | Payload is public; PII in a JWT is PII on the wire and in logs |
| Short TTL + refresh | Bounds the blast radius of theft | Refresh machinery, rotation, reuse detection, clock-skew handling |
| vs opaque + introspection | No AS dependency in the hot path; AS outage does not break reads | Loses instant revocation and central visibility of active sessions |

---

## 7. Common Mistakes & Best Practices

1. ⚠️ **Passing the header's `alg` into the verify call (`algorithms=[header.alg]`).** → ✅ Hard-code a server-side allow-list (`["RS256","ES256"]`). This single line prevents `alg: none` and RS256→HS256 downgrade.
2. ⚠️ **Using one verify path that accepts both HMAC and RSA keys.** → ✅ Bind algorithm to key type: if the key is RSA/EC, only asymmetric algorithms are permissible. Libraries that "just pick" are how public keys become HMAC secrets.
3. ⚠️ **Not validating `aud`.** → ✅ Every service must require its own identifier in `aud`. Without it, a token minted for the low-value analytics API is a valid credential at the payments API — a textbook confused deputy.
4. ⚠️ **Not validating `iss`, or matching it loosely.** → ✅ Exact string comparison against a configured issuer. A `startswith` check lets `https://auth.acme.io.evil.com` through.
5. ⚠️ **Trusting `jku`, `jwk` or `x5u` headers.** → ✅ Ignore all key-locating headers except `kid`, and resolve `kid` only within a JWKS fetched from a hard-coded issuer URL.
6. ⚠️ **Putting PII or secrets in the payload.** → ✅ The payload is base64, not encrypted. Store an opaque `sub` and look up the profile server-side; use JWE if claims genuinely must be confidential.
7. ⚠️ **Long-lived access tokens because "refresh is annoying".** → ✅ 5–15 minutes for access tokens. A 30-day JWT is an unrevocable password with extra steps.
8. ⚠️ **Fetching JWKS on every request, or caching it forever.** → ✅ Cache parsed keys ~1 h; refresh on unknown `kid` behind a singleflight lock and a 30 s cooldown; never let an attacker-chosen `kid` drive unbounded fetches.
9. ⚠️ **Zero clock-skew tolerance.** → ✅ Allow ≤60 s leeway on `exp`/`nbf`/`iat` and run NTP. Also refuse tokens whose `exp - iat` exceeds a sane maximum — that catches misconfigured issuers.
10. ⚠️ **Returning `403` for an expired token, or `401` for a missing scope.** → ✅ `401` + `WWW-Authenticate: Bearer error="invalid_token"` for authentication failure; `403` + `error="insufficient_scope"` for authorization failure. Clients branch on this.
11. ⚠️ **Rotating keys by swapping them atomically.** → ✅ Overlap: publish, wait, sign, wait, retire. An atomic swap invalidates every in-flight token instantly.
12. ⚠️ **Verifying the token but not authorizing the object.** → ✅ A valid token with `tenant_id: ten_42` must not read `invoice_9` belonging to `ten_7`. Signature validity says nothing about ownership — see chapters 21 and 23.

---

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Decode locally first: `jwt decode` (the `jwt-cli` tool), `python -m jwt`, or the base64 loop above. The four recurring causes of "it works in staging" are: `aud` mismatch (staging issuer, prod audience), clock skew on a container host, a JWKS cached across a rotation, and a proxy truncating or lower-casing the `Authorization` header. Log the *reason* for every rejection as a low-cardinality enum (`expired`, `bad_aud`, `bad_iss`, `unknown_kid`, `bad_sig`, `revoked`) — never log the token itself, and redact `Authorization` in access logs and APM traces.

**Monitoring.** Instrument `jwt_validation_total{result}` split by that enum, `jwt_validation_duration_seconds` (p50/p99 — a p99 spike usually means JWKS fetches leaking into the hot path), `jwks_fetch_total{outcome}` and cache hit ratio, `jwt_unknown_kid_total` (should be ~0 outside a rotation window; a spike is either a botched rotation or an attack), and token `exp - iat` distribution to catch issuers drifting from policy. Alert immediately on any occurrence of `alg=none` or `alg=HS256` when you only issue asymmetric tokens — those are exploitation attempts, not bugs.

**Security.** Enforce TLS everywhere; a JWT on plaintext HTTP is a password on a postcard. Keep private keys in KMS/HSM with signing as a service call and a documented rotation schedule (90 days is a reasonable default; immediate on suspected compromise). Set `typ` and check it. Add `jti` and a denylist if you need sub-TTL revocation, or a per-user `token_version` claim compared against a cached counter — bumping the counter logs everyone out instantly. For high-value operations, require sender-constrained tokens (DPoP `cnf.jkt` or mTLS `cnf.x5t#S256`) so a stolen bearer token is inert. Never accept a JWT from a query string; if a legacy client does this, the token is in your access logs, your CDN logs and the user's browser history.

**Performance & scaling.** Local verification means your API's availability does not depend on the authorization server — protect that property fiercely by serving JWKS from cache during an AS outage (fail-open on *fetch*, fail-closed on *verification*). Watch token size: base64 inflates by 33%, and a fat token multiplied by every hop in a service mesh is real bandwidth. If you find yourself embedding hundreds of permissions, stop — put a `roles` array or a policy version in the token and resolve fine-grained permissions server-side. At very high RPS, pre-warm the key cache at process start so the first requests after a deploy do not stampede the JWKS endpoint.

---

## 9. Interview Questions

**Q: What are the three parts of a JWT and what exactly does the signature cover?**
A: Header, payload and signature, each base64url-encoded and joined by dots. The signature covers the exact ASCII bytes of `header_b64 + "." + payload_b64`. That is why you verify the raw string and never re-serialise the decoded JSON — whitespace or key ordering changes would break the signature.

**Q: Is a JWT encrypted?**
A: No. A standard JWS JWT is signed, not encrypted, and anyone who holds it can base64-decode and read every claim. Use JWE if confidentiality is required, but the better answer for APIs is to keep PII and secrets out of the payload entirely.

**Q: Explain the RS256-to-HS256 alg confusion attack.**
A: The verifier trusts the header's `alg` and is handed "the issuer's key". The attacker rewrites `alg` to `HS256` and HMACs the token using the issuer's RSA *public* key bytes as the shared secret. Since that key is public, the forgery verifies. The fix is a server-side algorithm allow-list bound to the key type.

**Q: Why must you validate `aud` and `iss`?**
A: `iss` proves the token came from the issuer you trust; `aud` proves it was minted for *this* API. Without `aud`, a token issued for a low-privilege service is replayable against a high-privilege one that shares the issuer — the confused-deputy problem.

**Q: How do you revoke a JWT before it expires?**
A: Strictly you cannot, which is why TTLs are short. Practically: keep revoked `jti` values in Redis with a TTL equal to the remaining lifetime; or include a `token_version` claim and reject tokens whose version is below a cached per-user counter; or switch to opaque tokens with introspection where instant revocation is a hard requirement.

**Q: What is `kid` for and why is it the only header field you trust?**
A: `kid` names which key from the issuer's JWKS to verify against, enabling rotation with multiple simultaneously valid keys. It is safe only because you use it as a lookup key into a set *you* control — unlike `jku` or `jwk`, it cannot introduce attacker-supplied key material.

**Q: 401 or 403 for an expired token?**
A: `401` with `WWW-Authenticate: Bearer error="invalid_token"`. `403` is for a valid, authenticated token that lacks the required scope or permission, signalled with `error="insufficient_scope"`. Clients use the distinction to decide whether to refresh or to surface a permission error.

**Q: (Senior) Design zero-downtime signing-key rotation across 200 services.**
A: Publish the new public key into JWKS first and wait longer than the maximum JWKS cache TTL so every verifier has it. Then switch signing to the new `kid`. Wait longer than the maximum token TTL, then remove the old public key. Verifiers must handle unknown `kid` with a rate-limited, singleflight JWKS refresh; instrument `jwt_unknown_kid_total` so you can confirm the overlap window was sufficient before retiring anything.

**Q: (Senior) When would you choose opaque tokens over JWTs, and what do you give up?**
A: Choose opaque when you need immediate revocation, central visibility of active sessions, or when claims are sensitive and must not leave the AS — banking, healthcare, admin consoles. You give up stateless validation: every request now depends on the introspection endpoint, adding 5–20 ms and making the AS a hard availability dependency, which you mitigate with short-lived positive caching. Many platforms run a hybrid: opaque externally, JWT internally after the gateway exchanges it.

**Q: (Senior) A pentest report says your API accepts tokens with `alg: none`. Walk through remediation and blast-radius assessment.**
A: Immediately pin the allow-list and ship it; then rotate signing keys, because you must assume forged tokens were issued. Blast radius: search access logs for requests whose token header decodes to `alg` outside the allow-list, and for `sub` values that never authenticated — anything forged had a signature your issuer never produced, so correlate token `jti` and `iat` against issuance records. Add a regression test that asserts rejection of `alg: none`, `alg: HS256`, wrong `aud`, expired, and unknown `kid`, and add a contract test to CI for every service so the fix cannot regress.

**Q: (Senior) How do DPoP or mTLS-bound tokens change the threat model?**
A: They convert a bearer token into a proof-of-possession token via a `cnf` claim holding a thumbprint of the client's key. The client must sign a fresh proof (covering method, URI and a nonce) on every request, so a token exfiltrated from logs, storage or a compromised proxy is useless without the private key. The cost is client-side key management, clock-skew handling on the proof, and server-side replay caching of proof `jti` values.

**Q: Why prefer ES256 or EdDSA over RS256 for new systems?**
A: Signatures are 64 bytes instead of 256, so tokens are ~250 bytes smaller on every request; verification is faster; and Ed25519 avoids RSA padding pitfalls entirely. RS256 remains the compatibility default because older libraries and some enterprise IdPs still assume it.

---

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** A JWT is `base64url(header).base64url(payload).base64url(signature)`, signed over the exact bytes of the first two segments. It is **encoded, not encrypted** — never put secrets or PII inside. Verification order is fixed: select the key by `kid` from a JWKS fetched from a hard-configured issuer, verify with a **server-side algorithm allow-list** (never the header's `alg`), then check `iss` exactly, `aud` contains this API, `exp`/`nbf`/`iat` with ≤60 s leeway, `typ`, and only then read `scope` and application claims — and *then* still authorize the specific object. The three killer bugs are `alg: none`, RS256→HS256 downgrade using the public key as an HMAC secret, and honouring `jku`/`jwk` header injection. Keys rotate with overlap: publish → wait → sign → wait → retire. JWTs trade revocability for statelessness, so keep access tokens at 5–15 minutes and add a `jti` denylist or `token_version` if you need faster revocation.

| Item | Rule |
|---|---|
| Structure | `header.payload.signature`, base64url, dot-separated |
| Signing input | `header_b64 + "." + payload_b64` (raw ASCII) |
| Safe header field | `kid` only — ignore `alg`, `jku`, `jwk`, `x5u` |
| Algorithms | Allow-list `["ES256","RS256"]`; reject `none` and `HS*` if asymmetric |
| Required claims | `iss`, `aud`, `sub`, `exp`, `iat` (+ `jti` for revocation) |
| Clock leeway | ≤ 60 s on `exp` / `nbf` / `iat` |
| Access token TTL | 5–15 min; `typ: at+jwt` (RFC 9068) |
| Auth failure | `401` + `WWW-Authenticate: Bearer error="invalid_token"` |
| Scope failure | `403` + `error="insufficient_scope"` |
| JWKS cache | ~1 h parsed keys; refresh on unknown `kid`, singleflight + 30 s cooldown |
| Rotation | Publish → wait cacheTTL → sign new → wait maxTTL → retire old |
| Key RFCs | 7515 JWS · 7517 JWK · 7519 JWT · 8725 BCP · 9068 access tokens |

**Flash cards**

- **What does the header's `alg` tell your verifier?** → Nothing you should act on. Use a server-side allow-list bound to the key type.
- **Is the payload secret?** → No — base64url is encoding, not encryption. Assume the client and every proxy can read it.
- **Which claim stops cross-API token reuse?** → `aud`, checked for an exact match against this API's identifier.
- **How do you rotate keys without downtime?** → Overlap: publish the new public key, wait past cache TTL, sign with it, wait past max token TTL, retire the old.
- **Fastest way to make JWTs revocable?** → Short TTL plus a `jti` denylist (or `token_version` claim) held only for the remaining lifetime.

---

## 11. Hands-On Exercises & Mini Project

- [ ] Craft an `alg: none` token by hand (header `{"alg":"none"}`, empty third segment) and fire it at a deliberately naive verifier; then fix the verifier with an allow-list and confirm rejection.
- [ ] Reproduce RS256→HS256 confusion: take a public key PEM, HMAC a modified payload with it, and observe a vulnerable library accept it. Document exactly which line of the fixed version prevents it.
- [ ] Build a JWKS cache with `kid` lookup, a 1 h TTL, singleflight refresh and a 30 s cooldown; load-test with 1,000 concurrent requests carrying a bogus `kid` and prove only one JWKS fetch occurs per cooldown window.
- [ ] Implement `jti`-based revocation in Redis with TTL set to `exp - now`, then measure the memory footprint at 10,000 revocations/hour with 15-minute tokens.
- [ ] Write a contract test suite asserting rejection of: `alg: none`, `alg: HS256`, wrong `aud`, wrong `iss`, expired, `nbf` in the future, unknown `kid`, and a token with a valid signature but a tampered payload.

**Mini Project — a hardened token verification library**

*Goal:* build a reusable middleware every service in a fleet can adopt, with security properties provable by tests.

*Requirements:*
1. Config-driven issuer, audience and algorithm allow-list; no per-service copy-paste of validation logic.
2. JWKS client with parsed-key caching, `kid` selection, singleflight refresh, cooldown, and graceful degradation to cache during an issuer outage.
3. Full claim validation with configurable leeway, `typ` checking, and a maximum permitted `exp - iat`.
4. Structured rejection reasons exposed as a low-cardinality Prometheus label plus RFC 9457 problem-details responses with correct `401` vs `403` semantics.
5. A red-team test suite covering all attacks from the exercises, running in CI as a merge gate.

*Extensions:* add DPoP proof validation with a replay cache keyed on proof `jti`; add `token_version` revocation with a cached per-tenant counter; add an offline JWKS bundle for air-gapped deployments; benchmark ES256 vs RS256 vs EdDSA verification and token size, and publish the numbers in the README.

---

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *OAuth 2.0 & OpenID Connect* (chapter 19) explains where these tokens come from and how refresh works; *Authorization: RBAC, ABAC & Scopes* (chapter 21) covers what to enforce once the signature is valid; *TLS, CORS & Security Headers* (chapter 22) covers the transport that makes bearer tokens tolerable at all; *OWASP API Security Top 10* (chapter 23) places broken authentication in the wider risk landscape; *Rate Limiting, Quotas & Throttling* (chapter 24) covers protecting token and JWKS endpoints.

- **RFC 7519 — JSON Web Token** — IETF · *Intermediate* · the normative claim definitions and the exact validation requirements for `exp`, `nbf`, `aud` and `iss`. <https://www.rfc-editor.org/rfc/rfc7519>
- **RFC 8725 — JWT Best Current Practices** — IETF · *Advanced* · short, blunt, and the single best defence against alg confusion and header-injection bugs. <https://www.rfc-editor.org/rfc/rfc8725>
- **RFC 7515 — JSON Web Signature** — IETF · *Advanced* · defines compact serialization and the signing input; read Appendix A for worked examples you can verify by hand. <https://www.rfc-editor.org/rfc/rfc7515>
- **RFC 9068 — JWT Profile for OAuth 2.0 Access Tokens** — IETF · *Advanced* · standardises `typ: at+jwt` and the claim set resource servers should require. <https://www.rfc-editor.org/rfc/rfc9068>
- **OWASP JSON Web Token Cheat Sheet** — OWASP · *Intermediate* · concise checklist of storage, algorithm and validation rules mapped to real attack scenarios. <https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html>
- **PortSwigger Web Security Academy — JWT attacks** — PortSwigger · *Intermediate* · free interactive labs for `alg: none`, HS256 confusion, `jku`/`kid` injection; the fastest way to internalise the bug class. <https://portswigger.net/web-security/jwt>
- **JWT.io Introduction and Algorithm Reference** — Auth0 · *Beginner* · clear structural walkthrough and a library-support matrix; use the local decoder, never paste production tokens. <https://jwt.io/introduction>
- **jose (JavaScript) documentation** — Filip Skokan · *Intermediate* · a reference implementation whose API forces correct choices (explicit `algorithms`, remote JWKS with cooldown). <https://github.com/panva/jose>

---

*REST API Handbook — chapter 20.*
