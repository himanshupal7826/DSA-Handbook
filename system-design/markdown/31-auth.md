# 31 · Authentication: OAuth2, OIDC, JWT & SSO

> **In one line:** Authentication proves *who* you are; OAuth2 delegates *access* without sharing passwords, OIDC adds *identity* on top, JWT is the *token format*, and SSO ties it all into one login — confuse them at your peril.

---

## 1. Overview

**Authentication (authn)** answers "who are you?" — verifying identity via a password, a passkey, or a token. **Authorization (authz)** answers "what are you allowed to do?" These are constantly conflated; keep them distinct, because most real systems get the *authz* part wrong.

The core problem OAuth2 solves is **delegated access without password sharing.** In 2005, letting a photo-printing site access your photos meant handing over your email password — catastrophic. **OAuth 2.0** (RFC 6749) replaced that with a flow where you authorize a third-party app to get a scoped, revocable **access token** — it never sees your credentials. Crucially, OAuth2 is a framework for **authorization/delegation, not authentication** — a distinction whose violation caused a decade of security bugs.

That gap is why **OpenID Connect (OIDC)** exists: a thin identity layer *on top of* OAuth2 that adds a signed **ID token** answering "who is the user, and when/how did they authenticate?" Today, "Log in with Google" is OIDC, not raw OAuth2.

Threaded through all of this is the **token**: increasingly a **JWT** (JSON Web Token) — a self-contained, signed claim set that services can validate without a database round-trip. And **SSO** (Single Sign-On) is the user-facing outcome: authenticate once at an identity provider, access many apps. Real-world example: logging into Gmail also logs you into YouTube and Google Docs — one authentication, many services, via OIDC-based SSO.

## 2. Core Concepts

- **Authentication vs Authorization** — authn = proving identity; authz = granting permissions. AuthN happens first; authZ decides what that identity may do. Different failures, different fixes.
- **Session/cookie auth** — server stores session state; the browser holds an opaque session ID cookie. **Stateful**: easy to revoke, but needs shared session storage to scale.
- **Token auth** — the client holds a self-describing token (often a JWT) sent as `Authorization: Bearer <token>`. **Stateless**: scales horizontally, but revocation is hard.
- **JWT (JSON Web Token)** — `header.payload.signature`, base64url-encoded, signed. Carries **claims** (sub, exp, iss, aud, scope). Self-contained: verifiable by signature alone.
- **Signing: HMAC vs RSA/ECDSA** — symmetric (HS256, one shared secret) vs asymmetric (RS256/ES256, private key signs, public key verifies). Asymmetric lets many services verify without holding a signing secret.
- **Access token vs refresh token** — access token: short-lived (5–15 min), used on every API call. Refresh token: long-lived, used only to mint new access tokens; kept far more securely.
- **OAuth2 roles** — Resource Owner (user), Client (the app), Authorization Server (issues tokens), Resource Server (the API holding data).
- **Authorization Code + PKCE** — the recommended OAuth2 flow: user authenticates at the auth server, app gets a one-time **code**, exchanges it (with a PKCE verifier) for tokens over a back channel.
- **OIDC & the ID token** — identity layer on OAuth2; the **ID token** (always a JWT) proves *authentication* and carries user identity claims. Access tokens are for APIs; ID tokens are for the client.
- **SSO / SAML** — authenticate once at an Identity Provider, reach many Service Providers. **SAML** is the older XML-based enterprise standard; OIDC is the modern JSON/JWT successor.

## 3. Architecture

OAuth2/OIDC separates four roles so no party sees more than it needs. The **client** never touches credentials — it redirects the user to the **authorization server**, which authenticates the user and issues tokens. The **resource server** (API) trusts tokens minted by the auth server, validating them by signature (asymmetric) against the auth server's public keys (published at a **JWKS** endpoint), with no shared secret.

```svg
<svg viewBox="0 0 740 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a31" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>

  <rect x="40" y="30" width="120" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="100" y="50" text-anchor="middle" fill="#1e293b">Resource Owner</text>
  <text x="100" y="66" text-anchor="middle" fill="#64748b" font-size="11">(the user)</text>

  <rect x="40" y="200" width="120" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="100" y="220" text-anchor="middle" fill="#1e293b">Client</text>
  <text x="100" y="236" text-anchor="middle" fill="#64748b" font-size="11">(the app)</text>

  <rect x="310" y="30" width="150" height="46" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="385" y="50" text-anchor="middle" fill="#1e293b">Authorization</text>
  <text x="385" y="66" text-anchor="middle" fill="#1e293b">Server (IdP)</text>

  <rect x="560" y="200" width="150" height="46" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="635" y="220" text-anchor="middle" fill="#1e293b">Resource Server</text>
  <text x="635" y="236" text-anchor="middle" fill="#64748b" font-size="11">(the API)</text>

  <rect x="560" y="30" width="150" height="46" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="635" y="50" text-anchor="middle" fill="#1e293b">JWKS</text>
  <text x="635" y="66" text-anchor="middle" fill="#64748b" font-size="11">public keys</text>

  <line x1="100" y1="76" x2="100" y2="198" stroke="#475569" stroke-width="1.4" marker-end="url(#a31)"/>
  <text x="100" y="145" text-anchor="middle" fill="#64748b" font-size="11">uses</text>

  <line x1="160" y1="53" x2="308" y2="53" stroke="#475569" stroke-width="1.4" marker-end="url(#a31)"/>
  <text x="234" y="45" text-anchor="middle" fill="#64748b" font-size="11">authenticate</text>

  <line x1="160" y1="210" x2="385" y2="78" stroke="#475569" stroke-width="1.4" marker-end="url(#a31)"/>
  <text x="290" y="150" text-anchor="middle" fill="#64748b" font-size="11">code → tokens</text>

  <line x1="160" y1="223" x2="558" y2="223" stroke="#475569" stroke-width="1.4" marker-end="url(#a31)"/>
  <text x="360" y="216" text-anchor="middle" fill="#64748b" font-size="11">Bearer access token</text>

  <line x1="635" y1="198" x2="635" y2="78" stroke="#475569" stroke-width="1.3" stroke-dasharray="5 3" marker-end="url(#a31)"/>
  <text x="668" y="140" text-anchor="middle" fill="#64748b" font-size="11">verify sig</text>
</svg>
```

## 4. How It Works

The **Authorization Code flow with PKCE** — the recommended flow for web, mobile, and SPA clients. PKCE (Proof Key for Code Exchange) binds the code to the client that started the flow, defeating code-interception attacks. Sequence:

```svg
<svg viewBox="0 0 760 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12.5">
  <defs>
    <marker id="s31" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>

  <!-- lifelines -->
  <rect x="40" y="16" width="110" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="95" y="38" text-anchor="middle" fill="#1e293b">User / Browser</text>
  <rect x="300" y="16" width="110" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="355" y="38" text-anchor="middle" fill="#1e293b">Client App</text>
  <rect x="540" y="16" width="160" height="34" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="620" y="38" text-anchor="middle" fill="#1e293b">Auth Server</text>

  <line x1="95" y1="50" x2="95" y2="345" stroke="#94a3b8" stroke-width="1"/>
  <line x1="355" y1="50" x2="355" y2="345" stroke="#94a3b8" stroke-width="1"/>
  <line x1="620" y1="50" x2="620" y2="345" stroke="#94a3b8" stroke-width="1"/>

  <!-- 1 click login -->
  <line x1="95" y1="74" x2="353" y2="74" stroke="#475569" stroke-width="1.3" marker-end="url(#s31)"/>
  <text x="224" y="68" text-anchor="middle" fill="#1e293b" font-size="11">1. "Log in"</text>

  <!-- 2 redirect + code_challenge -->
  <line x1="355" y1="102" x2="93" y2="102" stroke="#475569" stroke-width="1.3" marker-end="url(#s31)"/>
  <text x="224" y="96" text-anchor="middle" fill="#1e293b" font-size="11">2. redirect: client_id, scope, code_challenge</text>

  <!-- 3 browser -> auth server -->
  <line x1="95" y1="130" x2="618" y2="130" stroke="#475569" stroke-width="1.3" marker-end="url(#s31)"/>
  <text x="330" y="124" text-anchor="middle" fill="#1e293b" font-size="11">3. GET /authorize (user authenticates + consents)</text>

  <!-- 4 auth server -> browser code -->
  <line x1="620" y1="158" x2="97" y2="158" stroke="#475569" stroke-width="1.3" marker-end="url(#s31)"/>
  <text x="360" y="152" text-anchor="middle" fill="#1e293b" font-size="11">4. redirect back with one-time auth code</text>

  <!-- 5 browser -> client code -->
  <line x1="95" y1="186" x2="353" y2="186" stroke="#475569" stroke-width="1.3" marker-end="url(#s31)"/>
  <text x="224" y="180" text-anchor="middle" fill="#1e293b" font-size="11">5. deliver code to client</text>

  <!-- 6 client -> auth server exchange (back channel) -->
  <line x1="355" y1="214" x2="618" y2="214" stroke="#059669" stroke-width="1.5" marker-end="url(#s31)"/>
  <text x="487" y="208" text-anchor="middle" fill="#059669" font-size="11">6. POST /token: code + code_verifier</text>

  <!-- 7 auth server -> client tokens -->
  <line x1="620" y1="248" x2="357" y2="248" stroke="#059669" stroke-width="1.5" marker-end="url(#s31)"/>
  <text x="487" y="242" text-anchor="middle" fill="#059669" font-size="11">7. access + refresh (+ ID) token</text>

  <!-- 8 client -> resource -->
  <text x="355" y="292" text-anchor="middle" fill="#64748b" font-size="11">8. call API with</text>
  <text x="355" y="307" text-anchor="middle" fill="#64748b" font-size="11">Authorization: Bearer &lt;access token&gt;</text>
  <text x="355" y="330" text-anchor="middle" fill="#64748b" font-size="10.5">(green = secure back channel, no browser)</text>
</svg>
```

1. **User clicks "Log in with X."** The client generates a random `code_verifier` and its SHA-256 hash `code_challenge`.
2. **Redirect to the authorization server** with `client_id`, requested `scope`, `redirect_uri`, `state` (CSRF guard), and the `code_challenge`.
3. **User authenticates and consents** directly at the auth server — the client never sees the password.
4. **Auth server redirects back** to `redirect_uri` with a short-lived, single-use **authorization code**.
5. **Client receives the code** (via the browser redirect).
6. **Back-channel token exchange:** the client POSTs the code + the original `code_verifier` to `/token`. The server hashes the verifier and checks it matches the earlier challenge — proving the same client.
7. **Auth server returns tokens:** an **access token**, a **refresh token**, and (if OIDC scope `openid`) an **ID token**.
8. **Client calls the resource server** with `Authorization: Bearer <access token>`. The API validates the token (signature, `exp`, `iss`, `aud`, `scope`) and serves the request.

Why a code instead of returning the token directly? The code passes through the browser (interceptable), but is useless without the back-channel exchange + PKCE verifier — so the actual tokens never travel through the front channel.

## 5. Key Components / Deep Dive

### JWT Structure & Validation

A JWT is three base64url segments joined by dots: `header.payload.signature`.
- **Header** — `{"alg":"RS256","typ":"JWT","kid":"..."}` — the signing algorithm and key ID.
- **Payload** — the **claims**: `sub` (subject/user id), `iss` (issuer), `aud` (audience), `exp` (expiry), `iat` (issued-at), plus custom claims like `scope` or `roles`.
- **Signature** — `sign(base64(header) + "." + base64(payload), key)`.

> [!WARN]
> The payload is **encoded, not encrypted** — anyone can base64-decode and read it. Never put secrets (passwords, PII you wouldn't log) in a JWT. Signing guarantees *integrity*, not confidentiality.

**Validation on every request** (all must pass): verify the **signature** against the issuer's key (fetched from the JWKS endpoint by `kid`); check `exp` not passed; check `iss` matches the expected issuer; check `aud` matches *this* API; then enforce `scope`/roles for authorization.

> [!WARN]
> The classic JWT vulnerability: trusting the token's own `alg` header. An attacker sets `alg: none` (no signature) or swaps RS256→HS256 to sign with the *public* key as an HMAC secret. **Pin the expected algorithm server-side; never let the token choose.**

### HMAC vs RSA/ECDSA Signing

| | HMAC (HS256) | RSA/ECDSA (RS256/ES256) |
|---|---|---|
| Keys | One shared secret | Private (sign) + public (verify) |
| Who can verify | Anyone with the secret (= anyone who can also forge) | Anyone with the public key; only the auth server can sign |
| Best for | Single service that both issues & verifies | Many services / third parties verifying centrally-issued tokens |

Asymmetric signing is standard for OAuth2/OIDC: the auth server holds the private key; every resource server verifies via the public JWKS. No shared forge-able secret is distributed.

### Access vs Refresh Tokens

**Access tokens are short-lived (5–15 min)** and sent on every API call — so if one leaks, the exposure window is small. **Refresh tokens are long-lived** (days/weeks), sent *only* to the auth server's `/token` endpoint to obtain fresh access tokens, and stored more securely (httpOnly cookie, or server-side). This split limits blast radius: frequent-use credentials expire fast; the powerful long-lived one is rarely transmitted. **Refresh token rotation** (issue a new refresh token on each use and invalidate the old) detects theft — a replayed old token signals compromise and revokes the family.

### OIDC — Identity on Top of OAuth2

OAuth2 alone gives an access token that says nothing reliable about *who* logged in (using it for login is the "confused deputy" bug). OIDC adds the **ID token** — always a JWT, audience = the client — with authentication claims: `sub`, `email`, `name`, `auth_time`, `nonce`. Rule: **the ID token is for the client to learn who the user is; the access token is for calling APIs. Never use an access token as proof of identity, and never send an ID token to a resource server.**

### Sessions/Cookies vs Tokens — where state lives

Session auth keeps state on the server (revoke instantly by deleting the session; needs shared session storage to scale). Token/JWT auth is stateless (scales trivially, verify by signature; but you *can't easily revoke* a valid unexpired JWT). Most real systems are hybrid: short-lived JWT access tokens for API scale + a server-side refresh/session for revocation control.

### SSO & SAML (brief)

**SSO** = authenticate once at an Identity Provider (IdP), access many Service Providers (SPs) without re-login. **SAML 2.0** is the older enterprise standard: XML assertions, browser POST bindings, common in corporate/B2B (Okta, ADFS). **OIDC** is the modern successor: JSON/JWT, mobile-friendly, simpler. New builds pick OIDC; SAML persists for legacy enterprise integrations.

## 6. Trade-offs

| Option | Pros | Cons |
|---|---|---|
| **Server-side sessions (cookies)** | Instant revocation; small opaque cookie; server controls state | Needs shared session store (Redis) to scale; CSRF surface; stateful |
| **Stateless JWT** | No DB lookup to verify; scales horizontally; works across services/domains | Can't revoke before `exp`; larger than a cookie; footgun-prone validation |
| **HMAC (HS256)** | Fast; simple; one secret | Secret shared with every verifier = every verifier can forge |
| **Asymmetric (RS256)** | Verifiers need only the public key; central signing | Slightly slower; key rotation via JWKS to manage |
| **OAuth2 (authz)** | Delegated, scoped, revocable access; no password sharing | Not authentication — misused for login = security bugs |
| **OIDC (authn)** | Proper identity via ID token; SSO; standardized | More moving parts; must validate ID vs access token correctly |

The central tension is **stateless scale vs revocation control.** Pure JWT scales beautifully but can't kill a compromised session before expiry — which is why access tokens are kept short and paired with a revocable refresh token / server-side session.

## 7. When to Use / When to Avoid

**Use tokens/OAuth2/OIDC when:**
- Third-party or delegated access is needed (OAuth2) — an app acting on a user's behalf.
- "Log in with Google/Apple," or SSO across many apps (OIDC).
- Stateless, horizontally-scaled APIs / microservices verifying without a shared session store (JWT).
- Mobile/SPA clients and machine-to-machine (client-credentials) auth.

**Prefer simple sessions / avoid rolling your own when:**
- A single traditional web app with one backend — a plain server-side session cookie is simpler and safer than JWT.
- You need instant, reliable logout/revocation and can't tolerate token TTL windows.
- You'd be hand-rolling crypto or token validation — use a battle-tested library/provider (Auth0, Keycloak, Cognito). Never implement JWT verification from scratch.

## 8. Scaling & Production Best Practices

- **Keep access tokens short (5–15 min)** and refresh tokens long but **rotating** — bounds leak exposure and detects theft.
- **Sign with asymmetric keys (RS256/ES256)** and publish via **JWKS**; resource servers fetch & cache public keys by `kid`. Rotate keys without redeploying verifiers.
- **Always pin the algorithm** server-side and validate `iss`, `aud`, `exp`, and `nbf` on every request — not just the signature.
- **Store tokens safely in browsers:** refresh tokens in `httpOnly`, `Secure`, `SameSite` cookies (not `localStorage`, which is XSS-readable). Consider the BFF (backend-for-frontend) pattern for SPAs.
- **Enforce PKCE for all clients** (public and confidential) — it's now the baseline in OAuth 2.1.
- **Cache JWKS** but honor rotation; handle `kid` misses by refetching.
- **Centralize authz** as scopes/claims in the token, but re-check critical permissions at the resource server — don't trust the client to self-limit.
- **Use short revocation lists / token introspection** for high-value actions where you can't wait for expiry.

## 9. Failure Modes & Mitigations

| Failure | Impact | Mitigation |
|---|---|---|
| `alg:none` or RS256→HS256 confusion | Forged tokens accepted as valid | Pin expected algorithm server-side; never trust the token's `alg` |
| JWT stored in `localStorage` | XSS steals the token | `httpOnly`+`Secure`+`SameSite` cookies; sanitize; CSP |
| Long-lived access token leaks | Attacker has access until far-off `exp` | Short TTL (mins) + rotating refresh tokens |
| Can't revoke a valid JWT | Compromised/logged-out user still authorized until expiry | Short TTL; server-side deny-list; introspection for critical ops |
| Missing `aud` validation | Token issued for app A accepted by app B (confused deputy) | Always validate `aud` == this resource server |
| Authorization code interception | Attacker exchanges the stolen code | PKCE (`code_verifier`) + `state`; one-time, short-lived codes |
| Access token used as identity proof | Impersonation / broken login | Use OIDC ID token for identity; never authenticate with an access token |
| Signing key compromise | All tokens forgeable | Asymmetric keys, HSM/KMS-held private key, JWKS rotation, short key lifetime |

## 10. Monitoring & Metrics

- **Auth outcome rates** — login success/failure, token issuance rate, and failure reasons (bad signature, expired, wrong `aud`).
- **Anomaly signals** — spikes in failed logins per IP/user (credential stuffing), unusual geo/velocity, refresh-token reuse (rotation replay = theft indicator).
- **Token validation errors at resource servers** — sudden `alg`/`kid` mismatch spikes can mean key-rotation breakage or attack.
- **Refresh & revocation activity** — refresh rate, revocations issued, deny-list size and hit rate.
- **JWKS endpoint health** — availability and latency (if it's down, every verifier eventually fails).
- **Session/token lifetime distribution** and forced-logout counts; MFA challenge and step-up rates.
- **Alerts** on refresh-token reuse detection, `alg:none` attempts, and abnormal consent grants to new clients.

## 11. Common Mistakes

1. ⚠️ **Using OAuth2 access tokens for authentication.** OAuth2 is authorization; use OIDC's ID token to know *who* the user is.
2. ⚠️ **Trusting the JWT's `alg` header** — enables `alg:none` and RS256↔HS256 confusion. Pin the algorithm server-side.
3. ⚠️ **Putting secrets/PII in the JWT payload** — it's base64, not encrypted; anyone can read it.
4. ⚠️ **Storing tokens in `localStorage`** — trivially stolen via XSS. Use `httpOnly` cookies.
5. ⚠️ **Skipping `aud`/`iss`/`exp` checks** and validating only the signature — accepts tokens meant for other services or already expired.
6. ⚠️ **Long-lived access tokens with no revocation story** — a leak means indefinite access. Keep them short; rotate refresh tokens.
7. ⚠️ **Omitting PKCE / `state`** — opens authorization-code interception and CSRF.
8. ⚠️ **Hand-rolling JWT/crypto** instead of a vetted library or IdP — you will get an edge case wrong.

## 12. Interview Questions

**Q: Authentication vs authorization — precisely?**
A: Authentication verifies *identity* ("who are you?" — password, passkey, token). Authorization decides *permissions* ("what may you do?" — scopes, roles, policies). AuthN runs first and produces an identity; authZ consumes that identity to allow/deny actions. OIDC does authN; OAuth2 does authZ.

**Q: Walk me through the OAuth2 Authorization Code flow with PKCE.**
A: Client generates `code_verifier` + SHA-256 `code_challenge`; redirects the user to the auth server with client_id/scope/redirect_uri/state/code_challenge; user authenticates and consents; auth server returns a one-time code via redirect; client exchanges the code + `code_verifier` on the back channel at `/token`; server verifies the hash matches and returns access + refresh (+ ID) tokens. PKCE binds the code to the originating client so an intercepted code is useless.

**Q: What are the three parts of a JWT and what does each do?**
A: `header` (alg + kid), `payload` (claims: sub, iss, aud, exp, scope…), and `signature` (of header+payload). Dot-separated, base64url. The signature guarantees integrity; the payload is readable, not secret.

**Q: Access token vs refresh token — why both?**
A: Access tokens are short-lived and sent on every API call, so a leak has a small window. Refresh tokens are long-lived, sent only to the auth server to mint new access tokens, and stored more securely. The split trades off usability (don't re-login constantly) against exposure (limit blast radius).

**Q: How does OIDC relate to OAuth2?**
A: OIDC is a thin identity layer *on top of* OAuth2. OAuth2 gives an access token for API authorization; OIDC adds an **ID token** (a JWT) that proves authentication and carries identity claims. "Log in with Google" is OIDC. Use the ID token for identity, the access token for API calls.

**Q: Sessions vs JWTs — trade-offs?**
A: Sessions are stateful — instant revocation, but need shared server-side storage to scale. JWTs are stateless — verify by signature with no DB lookup, scale horizontally and cross-service, but you can't revoke a valid one before `exp`. Hybrid (short JWT + server refresh) is common.

**Q: How do you validate a JWT on the resource server?**
A: Verify the signature against the issuer's public key (JWKS, matched by `kid`) with a **pinned** algorithm; then check `exp` (not expired), `iss` (expected issuer), `aud` (this API), and finally enforce `scope`/roles. Reject if any fails.

**Q (senior): You can't revoke a stateless JWT before it expires. How do you handle logout and compromised tokens?**
A: Accept the trade-off and mitigate: keep access-token TTL very short (minutes) so revocation is "soon by default"; put the actual revocation power on the refresh token / server-side session, which you *can* invalidate; maintain a short-lived deny-list (by `jti`) checked for high-value operations or introspect tokens for critical endpoints; on suspected compromise, rotate signing keys (nuclear option, invalidates everything). It's a spectrum from pure-stateless to introspection-on-every-call — choose per risk.

**Q (senior): Explain the `alg:none` and RS256/HS256 confusion attacks and the fix.**
A: `alg:none` tells a naive verifier "no signature needed," so a forged token passes. The RS256→HS256 attack swaps the algorithm so the verifier HMAC-validates using the *public* RSA key as the secret — which the attacker also has — letting them forge tokens. Both stem from trusting the token's self-declared `alg`. Fix: hardcode the expected algorithm(s) server-side and reject anything else; never let the token pick.

**Q (senior): Where do you store tokens in a browser SPA, and why is each option risky?**
A: `localStorage` is XSS-readable — one script injection steals everything. Memory-only loses tokens on refresh and is still XSS-exposed while running. `httpOnly` cookies are safe from XSS reads but need CSRF defenses (`SameSite`, anti-CSRF tokens). The robust modern answer is the **BFF (backend-for-frontend)**: keep tokens server-side, hand the SPA only a session cookie — tokens never reach JavaScript.

**Q (senior): What does PKCE actually protect against, and why do confidential clients now use it too?**
A: PKCE defeats **authorization-code interception**: on mobile/SPA (public clients that can't hold a secret), a malicious app registered on the same redirect scheme could grab the code. Binding the code to a per-request `code_verifier` makes a stolen code unusable. OAuth 2.1 mandates PKCE even for confidential clients because it's cheap defense-in-depth against code leakage (logs, referrers, redirects) regardless of client type.

**Q (senior): Why is using an OAuth2 access token to log a user in a security bug?**
A: An access token is a bearer capability for an API — it doesn't reliably tell the client *which user* it belongs to or that they just authenticated. A malicious app can obtain a valid access token for *its own* user and present it to log in as someone else (the "confused deputy" / token-substitution problem). OIDC fixes this with the ID token, whose `aud` is the client and which carries verified identity + `nonce` binding.

## 13. Alternatives & Related

- **Session cookies** — the simpler stateful alternative for single-backend web apps; instant revocation.
- **SAML 2.0** — the XML-based enterprise SSO predecessor to OIDC; still common in B2B/corporate.
- **API keys** — coarse, long-lived secrets for server-to-server; no user identity, no scoping granularity.
- **mTLS / client certificates** — strong machine-to-machine auth without bearer tokens.
- **Passkeys / WebAuthn / FIDO2** — phishing-resistant passwordless *authentication* that feeds into these token flows.
- **OAuth2 Client Credentials grant** — machine-to-machine flow (no user) for service accounts.
- **Rate Limiting & API Gateway** — where token validation and throttling typically live.

## 14. Cheat Sheet

> [!TIP]
> - **AuthN = who you are; AuthZ = what you can do.** OIDC does authN, OAuth2 does authZ.
> - **JWT = `header.payload.signature`**, base64url, **signed not encrypted** — no secrets in the payload.
> - **Validate everything:** signature (pinned alg, JWKS by `kid`) + `exp` + `iss` + `aud`, then scopes. Never trust the token's `alg`.
> - **Access token:** short (5–15 min), sent everywhere. **Refresh token:** long, rotating, sent only to `/token`, stored securely.
> - **Auth Code + PKCE** is the flow: code via front channel, tokens via back channel; PKCE stops code interception; `state` stops CSRF.
> - **OIDC ID token** proves identity (for the client); **access token** authorizes APIs. Never swap their roles.
> - **Browser storage:** `httpOnly` cookie or BFF — never `localStorage`.
> - **Stateless JWTs can't be revoked** before `exp` → keep them short; revoke via refresh token / deny-list.
> - **Don't roll your own** — use a vetted library or IdP (Keycloak, Auth0, Cognito).

**References:** OAuth 2.0 — RFC 6749; PKCE — RFC 7636; JWT — RFC 7519; OpenID Connect Core 1.0; OWASP Authentication & JWT Cheat Sheets.

---
*System Design Handbook — topic 31.*
