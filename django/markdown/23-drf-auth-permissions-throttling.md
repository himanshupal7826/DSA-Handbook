# 23 · DRF Authentication, Permissions & Throttling

> **In one line:** In DRF, authentication only answers *who are you* (lazily, by trying each authenticator in order), permissions answer *may you do this* (view-level for every request, object-level only when `get_object()` runs), and throttles answer *how often* (cache-backed counters) — and almost every API security bug is one of those three being misunderstood.

---

## 1. Overview

> **Builds on:** [Ch 22 · DRF Views, ViewSets & Routers](topic.html?p=22-drf-views-viewsets-routers) (the `initial()` pipeline), [Ch 25 · Authentication & the Custom User Model](topic.html?p=25-authentication-custom-user) (users, passwords, backends), [Ch 27 · Sessions, Cookies & Messages](topic.html?p=27-sessions-cookies).

Django's own auth system was built for server-rendered sites: a login form, a session cookie, `request.user` filled in by `AuthenticationMiddleware`, and `@login_required`. An API has different clients — a React SPA on another origin, a mobile app that cannot keep a cookie jar sensibly, a partner's cron job, another microservice — and each wants a different credential: a cookie, a long-lived API key, a short-lived bearer token.

The naive approach is to check a header at the top of every view: `if request.headers.get("X-Api-Key") != settings.KEY: return 403`. Then you add per-user tokens, then "only the owner can edit", then "admins can do anything", and soon every view has a slightly different hand-rolled `if` ladder. One forgotten ladder is an IDOR (insecure direct object reference — OWASP API1, *Broken Object Level Authorization*), the most common API vulnerability there is ([REST API · OWASP API Security](../rest-api/topic.html?p=23-owasp-api-security)).

DRF separates the problem into three pluggable policies that run for every request in a fixed order inside `APIView.initial()`: **authentication classes** produce `request.user`/`request.auth`, **permission classes** allow or deny, and **throttle classes** rate-limit. Each is a list you set globally in `REST_FRAMEWORK` and override per view. The power is composability; the danger is the defaults — DRF's default permission is **`AllowAny`**. A new endpoint with no `permission_classes` is public unless you changed the global default.

> **Why this matters:** "JWT vs session vs token auth", "`has_permission` vs `has_object_permission`", and "why doesn't my object permission run on the list endpoint?" are among the most-asked DRF interview questions, and the last one is also among the most common real-world data leaks.

## 2. Core Concepts

- **Authentication class** — implements `authenticate(request) -> (user, auth) | None` and optionally `authenticate_header(request)`. *Why:* `None` means "not my credential, try the next"; raising `AuthenticationFailed` means "your credential is bad, stop".
- **`request.user` / `request.auth`** — the authenticated user (or `AnonymousUser`) and the credential object (token instance, decoded JWT, `None`). *Why:* `request.auth` lets you read token scopes/claims.
- **Lazy authentication** — authenticators run on first access to `request.user`; `initial()` forces it via `perform_authentication()`. *Why:* explains odd ordering bugs in middleware.
- **`SessionAuthentication`** — uses Django's session; **enforces CSRF** for authenticated requests. *Why:* the right choice for a same-site SPA.
- **`TokenAuthentication`** — `Authorization: Token <key>`, one DB-stored key per user, no expiry (`rest_framework.authtoken`). *Why:* simple server-to-server keys; weak for browsers.
- **`JWTAuthentication`** (SimpleJWT) — `Authorization: Bearer <jwt>`; signed, self-contained, short-lived access tokens + refresh tokens. *Why:* stateless verification, mobile/SPA friendly, hard to revoke.
- **Permission class** — `has_permission(request, view)` and `has_object_permission(request, view, obj)`, both default `True`. *Why:* all classes in the list must pass (AND).
- **Object-level permission** — checked only in `get_object()` / `check_object_permissions()`. *Why:* never runs on list views — scope querysets instead.
- **Built-ins** — `AllowAny`, `IsAuthenticated`, `IsAdminUser` (`is_staff`), `IsAuthenticatedOrReadOnly`, `DjangoModelPermissions`, `DjangoModelPermissionsOrAnonReadOnly`, `DjangoObjectPermissions`. *Why:* covers most needs; compose with `&`, `|`, `~`.
- **`SAFE_METHODS`** — `("GET", "HEAD", "OPTIONS")`. *Why:* the read-only check in every "OrReadOnly" permission.
- **Throttle** — `allow_request(request, view)` + `wait()`. `AnonRateThrottle` (by IP), `UserRateThrottle` (by user id), `ScopedRateThrottle` (by `throttle_scope`). *Why:* stores request timestamps in the cache.
- **CORS** — browser-enforced cross-origin rules, added by `django-cors-headers`. *Why:* CORS is not authentication; it only controls which origins' JavaScript can read responses.

## 3. Theory & Principles

### How authentication runs internally

`Request.user` is a property. On first access it calls `self._authenticate()`, which loops over `self.authenticators` (instances of `get_authenticators()`, i.e. your `authentication_classes`):

```text
for authenticator in self.authenticators:
    try:
        user_auth_tuple = authenticator.authenticate(self)
    except exceptions.APIException:
        self._not_authenticated()      # set AnonymousUser, then re-raise → 401/403
        raise
    if user_auth_tuple is not None:
        self._authenticator = authenticator
        self.user, self.auth = user_auth_tuple
        return
self._not_authenticated()              # AnonymousUser, auth = None
```

Three rules fall out. **First match wins** — order matters. **Returning `None` is not failure** — the request just stays anonymous; it is the *permission* classes that then deny it. **Raising stops the chain** — a malformed or expired JWT raises `AuthenticationFailed` even if a valid session cookie is also present.

Whether the client sees 401 or 403 is decided in `APIView.permission_denied()` and `handle_exception()`: if the request is unauthenticated and the **first** authenticator provides `authenticate_header()` (Token: `Token`, JWT: `Bearer realm="api"`, Basic: `Basic realm="api"`), the response is **401** with `WWW-Authenticate`; `SessionAuthentication` has no header, so you get **403**.

```svg
<svg viewBox="0 0 880 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj23a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="dj23b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
    <marker id="dj23c" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">request.user: authenticators tried in order (first non-None wins)</text>
  <rect x="20" y="50" width="140" height="50" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="90" y="72" text-anchor="middle" fill="#1e293b">access request.user</text>
  <text x="90" y="88" text-anchor="middle" fill="#334155" font-size="9">perform_authentication()</text>
  <path d="M160,75 L196,75" stroke="#2563eb" stroke-width="2" marker-end="url(#dj23a)"/>
  <rect x="198" y="50" width="160" height="50" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="278" y="70" text-anchor="middle" fill="#1e293b">1. JWTAuthentication</text>
  <text x="278" y="86" text-anchor="middle" fill="#334155" font-size="9">Authorization: Bearer ...</text>
  <path d="M358,75 L394,75" stroke="#2563eb" stroke-width="2" marker-end="url(#dj23a)"/>
  <text x="376" y="66" text-anchor="middle" fill="#334155" font-size="9">None</text>
  <rect x="396" y="50" width="160" height="50" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="476" y="70" text-anchor="middle" fill="#1e293b">2. SessionAuthentication</text>
  <text x="476" y="86" text-anchor="middle" fill="#334155" font-size="9">sessionid cookie + CSRF</text>
  <path d="M556,75 L592,75" stroke="#2563eb" stroke-width="2" marker-end="url(#dj23a)"/>
  <text x="574" y="66" text-anchor="middle" fill="#334155" font-size="9">None</text>
  <rect x="594" y="50" width="266" height="50" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="727" y="70" text-anchor="middle" fill="#1e293b">no match: AnonymousUser, auth=None</text>
  <text x="727" y="86" text-anchor="middle" fill="#334155" font-size="9">not an error by itself</text>
  <path d="M278,100 L278,150" stroke="#16a34a" stroke-width="2" marker-end="url(#dj23c)"/>
  <text x="290" y="128" fill="#16a34a" font-size="9">(user, token)</text>
  <path d="M476,100 L476,150" stroke="#16a34a" stroke-width="2" marker-end="url(#dj23c)"/>
  <text x="488" y="128" fill="#16a34a" font-size="9">(user, None)</text>
  <rect x="198" y="152" width="358" height="44" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="377" y="178" text-anchor="middle" fill="#1e293b">request.user, request.auth set; stop the loop</text>
  <path d="M727,100 L727,150" stroke="#2563eb" stroke-width="2" marker-end="url(#dj23a)"/>
  <rect x="594" y="152" width="266" height="44" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="727" y="172" text-anchor="middle" fill="#1e293b">permissions decide next</text>
  <text x="727" y="187" text-anchor="middle" fill="#334155" font-size="9">IsAuthenticated denies anonymous</text>
  <rect x="20" y="226" width="400" height="110" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="220" y="246" text-anchor="middle" fill="#1e293b" font-weight="bold">authenticate() RAISES AuthenticationFailed</text>
  <text x="220" y="266" text-anchor="middle" fill="#334155" font-size="10">expired / bad signature JWT, inactive user, bad token</text>
  <text x="220" y="284" text-anchor="middle" fill="#334155" font-size="10">chain stops even if a valid cookie exists</text>
  <text x="220" y="302" text-anchor="middle" fill="#334155" font-size="10">response: 401 if FIRST authenticator has</text>
  <text x="220" y="318" text-anchor="middle" fill="#334155" font-size="10">authenticate_header(), else 403</text>
  <path d="M278,100 L220,224" stroke="#dc2626" stroke-width="2" stroke-dasharray="4 3" marker-end="url(#dj23b)"/>
  <rect x="450" y="226" width="410" height="110" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="655" y="246" text-anchor="middle" fill="#1e293b" font-weight="bold">SessionAuthentication.enforce_csrf()</text>
  <text x="655" y="266" text-anchor="middle" fill="#334155" font-size="10">only after a session user is found</text>
  <text x="655" y="284" text-anchor="middle" fill="#334155" font-size="10">unsafe methods need X-CSRFToken header</text>
  <text x="655" y="302" text-anchor="middle" fill="#334155" font-size="10">anonymous requests are not CSRF-checked here</text>
  <text x="655" y="318" text-anchor="middle" fill="#334155" font-size="10">(APIView itself is csrf_exempt)</text>
</svg>
```

### Session vs Token vs JWT

| | Session (`SessionAuthentication`) | DRF Token (`TokenAuthentication`) | JWT (SimpleJWT) |
|---|---|---|---|
| Credential | `sessionid` cookie | opaque key in `Authorization: Token` | signed JSON in `Authorization: Bearer` |
| Server state | session row/cache entry | `authtoken_token` row | none for access tokens (optional blacklist for refresh) |
| Per-request cost | session lookup + user lookup | token + user lookup (one JOIN) | signature check + user lookup (by default) |
| Expiry | `SESSION_COOKIE_AGE` (2 weeks default) | none built-in | access: 5 min default; refresh: 1 day default |
| Revocation | delete session / logout | delete token | hard: wait for expiry, or denylist |
| CSRF | required (cookies auto-sent) | not needed | not needed (if not in a cookie) |
| XSS exposure | `HttpOnly` cookie not readable by JS | token in JS storage is readable | same, if in `localStorage` |
| Best for | same-site SPA, admin, browsable API | internal/server clients, simple keys | mobile apps, cross-domain SPAs, multi-service |

The interview-grade nuance: **JWT is not "more secure"**; it is **stateless**. You trade revocation and simplicity for not needing a shared session store. Most monolithic Django APIs serving a first-party SPA on the same site are better served by session auth with CSRF. Details of JWT structure and pitfalls live in [REST API · JWT](../rest-api/topic.html?p=20-jwt).

### SimpleJWT mechanics

`TokenObtainPairView` authenticates username/password via `authenticate()` ([Ch 25](topic.html?p=25-authentication-custom-user)) and returns an **access** and a **refresh** token, both signed with `SIGNING_KEY` (defaults to `SECRET_KEY`, HS256). On each request `JWTAuthentication` reads the header, validates signature and `exp`, checks the `token_type` is access, then by default **loads the user from the database** by the `user_id` claim (and rejects inactive users). `TokenRefreshView` exchanges a refresh token for a new access token; with `ROTATE_REFRESH_TOKENS=True` it also issues a new refresh token, and with `BLACKLIST_AFTER_ROTATION=True` plus the `token_blacklist` app the old refresh token is recorded in `BlacklistedToken` so it cannot be reused. Only refresh tokens are blacklisted; an issued access token is valid until it expires — which is why access lifetimes are short.

### Permissions: two hooks, two moments

`APIView.check_permissions(request)` runs in `initial()` for **every** request and calls `has_permission` on each permission instance; the first `False` calls `self.permission_denied(request, message=..., code=...)`. `check_object_permissions(request, obj)` calls `has_object_permission` on each — but it is only called from `GenericAPIView.get_object()` (or explicitly by you). So:

- list / create → `has_permission` only,
- retrieve / update / destroy / detail actions that call `get_object()` → `has_permission`, then `has_object_permission`.

Because `BasePermission.has_object_permission` returns `True`, a class implementing only `has_permission` passes the object stage; a class implementing only `has_object_permission` passes the view stage. Composition with `&`, `|`, `~` (DRF 3.9+) builds `OperandHolder` objects that combine both hooks — OR across two permissions where one only implements the object hook has had surprising semantics in past versions, so test composed permissions explicitly.

```svg
<svg viewBox="0 0 880 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj23d" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">When each permission hook runs</text>
  <rect x="20" y="44" width="400" height="270" rx="10" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="220" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">GET /api/invoices/   (list)</text>
  <rect x="50" y="82" width="340" height="40" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="220" y="106" text-anchor="middle" fill="#1e293b">initial(): has_permission(request, view)</text>
  <path d="M220,122 L220,144" stroke="#2563eb" stroke-width="2" marker-end="url(#dj23d)"/>
  <rect x="50" y="146" width="340" height="40" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="220" y="170" text-anchor="middle" fill="#1e293b">list(): filter_queryset(get_queryset())</text>
  <path d="M220,186 L220,208" stroke="#2563eb" stroke-width="2" marker-end="url(#dj23d)"/>
  <rect x="50" y="210" width="340" height="40" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="220" y="228" text-anchor="middle" fill="#1e293b">has_object_permission NEVER called</text>
  <text x="220" y="243" text-anchor="middle" fill="#334155" font-size="9">every row the queryset returns is exposed</text>
  <text x="220" y="280" text-anchor="middle" fill="#dc2626" font-size="10" font-weight="bold">Fix: get_queryset().filter(tenant=...)</text>
  <text x="220" y="298" text-anchor="middle" fill="#334155" font-size="9">authorization for lists = queryset scoping</text>
  <rect x="460" y="44" width="400" height="270" rx="10" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="660" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">PATCH /api/invoices/42/   (detail)</text>
  <rect x="490" y="82" width="340" height="40" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="660" y="106" text-anchor="middle" fill="#1e293b">initial(): has_permission(request, view)</text>
  <path d="M660,122 L660,144" stroke="#2563eb" stroke-width="2" marker-end="url(#dj23d)"/>
  <rect x="490" y="146" width="340" height="40" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="660" y="164" text-anchor="middle" fill="#1e293b">get_object(): get_object_or_404(scoped qs)</text>
  <text x="660" y="179" text-anchor="middle" fill="#334155" font-size="9">not in scope: 404, existence not leaked</text>
  <path d="M660,186 L660,208" stroke="#2563eb" stroke-width="2" marker-end="url(#dj23d)"/>
  <rect x="490" y="210" width="340" height="40" rx="6" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="660" y="228" text-anchor="middle" fill="#1e293b">check_object_permissions: has_object_permission</text>
  <text x="660" y="243" text-anchor="middle" fill="#334155" font-size="9">fails: 403 (or 401 if anonymous)</text>
  <path d="M660,250 L660,272" stroke="#2563eb" stroke-width="2" marker-end="url(#dj23d)"/>
  <rect x="490" y="274" width="340" height="30" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="660" y="294" text-anchor="middle" fill="#1e293b">serializer validate + save</text>
</svg>
```

### Throttling internals

`SimpleRateThrottle` parses a rate like `"100/hour"` into `(num_requests, duration)`, builds a cache key via `get_cache_key()` (`throttle_user_<pk>` or `throttle_anon_<ident>`), loads the **list of request timestamps** from the default cache, drops those older than the window, and allows the request if fewer than `num_requests` remain — a sliding-window log. It then writes the list back with `cache.set`. Two properties matter in production: it is **not atomic** (concurrent requests read the same list and both pass), and it is only as shared as your cache — with the default `LocMemCache`, every Gunicorn worker has its own counter, so a "100/hour" limit becomes roughly 100 × workers × pods. Use Redis ([Ch 29 · Caching](topic.html?p=29-caching)) and treat DRF throttles as fair-use limits, not as a security boundary; brute-force protection and DDoS defence belong at the gateway/WAF too ([REST API · Rate Limiting](../rest-api/topic.html?p=24-rate-limiting-throttling)).

Anonymous identity comes from `get_ident()`: with `NUM_PROXIES` unset it uses the **whole** `X-Forwarded-For` header (if present) as the key, which a client can set to anything — a trivially bypassable limit. Set `NUM_PROXIES` to the number of trusted proxies in front of Django.

## 4. Architecture & Workflow

### JWT login, use and refresh

```text
SPA/mobile                    Django + SimpleJWT                       DB
   │ POST /api/token/ {username,password}
   │──────────────────────────────▶ TokenObtainPairView
   │                                 authenticate() → ModelBackend ──────▶ SELECT user; check hash
   │◀──────── 200 {access (5 min), refresh (1 day)}
   │ GET /api/orders/  Authorization: Bearer <access>
   │──────────────────────────────▶ JWTAuthentication: verify sig + exp
   │                                 get_user(user_id) ────────────────────▶ SELECT user (is_active)
   │                                 IsAuthenticated ✓ → queryset scoped to user
   │◀──────── 200 [...]
   │ ... 5 minutes later: 401 {"code": "token_not_valid"}
   │ POST /api/token/refresh/ {refresh}
   │──────────────────────────────▶ TokenRefreshView (ROTATE_REFRESH_TOKENS)
   │                                 blacklist old refresh ────────────────▶ INSERT blacklistedtoken
   │◀──────── 200 {access, refresh(new)}
   │ POST /api/token/blacklist/ {refresh}   (logout)
```

### Where each policy sits

Authentication, permissions and throttles are only three of the layers between a client and your handler; the picture below places them next to the edge and CORS so you can see what each one can and cannot stop.

```svg
<svg viewBox="0 0 880 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj23e" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Layers a request passes before your handler</text>
  <rect x="20" y="50" width="120" height="70" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="80" y="80" text-anchor="middle" fill="#1e293b">Browser /</text>
  <text x="80" y="96" text-anchor="middle" fill="#1e293b">mobile</text>
  <path d="M140,85 L160,85" stroke="#2563eb" stroke-width="2" marker-end="url(#dj23e)"/>
  <rect x="162" y="50" width="130" height="70" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="227" y="74" text-anchor="middle" fill="#1e293b">Gateway / WAF</text>
  <text x="227" y="90" text-anchor="middle" fill="#334155" font-size="9">global rate limit</text>
  <text x="227" y="104" text-anchor="middle" fill="#334155" font-size="9">TLS, IP blocks</text>
  <path d="M292,85 L312,85" stroke="#2563eb" stroke-width="2" marker-end="url(#dj23e)"/>
  <rect x="314" y="50" width="130" height="70" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="379" y="74" text-anchor="middle" fill="#1e293b">CorsMiddleware</text>
  <text x="379" y="90" text-anchor="middle" fill="#334155" font-size="9">preflight OPTIONS</text>
  <text x="379" y="104" text-anchor="middle" fill="#334155" font-size="9">Access-Control-*</text>
  <path d="M444,85 L464,85" stroke="#2563eb" stroke-width="2" marker-end="url(#dj23e)"/>
  <rect x="466" y="50" width="120" height="70" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="526" y="74" text-anchor="middle" fill="#1e293b">Authentication</text>
  <text x="526" y="90" text-anchor="middle" fill="#334155" font-size="9">who are you?</text>
  <text x="526" y="104" text-anchor="middle" fill="#334155" font-size="9">401</text>
  <path d="M586,85 L606,85" stroke="#2563eb" stroke-width="2" marker-end="url(#dj23e)"/>
  <rect x="608" y="50" width="120" height="70" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="668" y="74" text-anchor="middle" fill="#1e293b">Permissions</text>
  <text x="668" y="90" text-anchor="middle" fill="#334155" font-size="9">may you?</text>
  <text x="668" y="104" text-anchor="middle" fill="#334155" font-size="9">403</text>
  <path d="M728,85 L748,85" stroke="#2563eb" stroke-width="2" marker-end="url(#dj23e)"/>
  <rect x="750" y="50" width="110" height="70" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="805" y="74" text-anchor="middle" fill="#1e293b">Throttles</text>
  <text x="805" y="90" text-anchor="middle" fill="#334155" font-size="9">how often?</text>
  <text x="805" y="104" text-anchor="middle" fill="#334155" font-size="9">429 Retry-After</text>
  <rect x="466" y="150" width="394" height="74" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="663" y="172" text-anchor="middle" fill="#1e293b" font-weight="bold">Handler: queryset scoping + get_object()</text>
  <text x="663" y="190" text-anchor="middle" fill="#334155" font-size="10">has_object_permission on detail routes</text>
  <text x="663" y="206" text-anchor="middle" fill="#334155" font-size="10">tenant / owner filter on every list</text>
  <path d="M805,120 L805,148" stroke="#2563eb" stroke-width="2" marker-end="url(#dj23e)"/>
  <rect x="20" y="150" width="424" height="74" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="232" y="172" text-anchor="middle" fill="#1e293b" font-weight="bold">CORS is NOT access control</text>
  <text x="232" y="190" text-anchor="middle" fill="#334155" font-size="10">curl, mobile apps and servers ignore it entirely;</text>
  <text x="232" y="206" text-anchor="middle" fill="#334155" font-size="10">it only stops other sites' JS from reading responses</text>
</svg>
```

## 5. Implementation

### Simple example: global defaults that fail closed

```bash
pip install "django~=5.2" "djangorestframework>=3.15" djangorestframework-simplejwt django-cors-headers
```

```python
# settings.py
INSTALLED_APPS += [
    "rest_framework",
    "rest_framework_simplejwt.token_blacklist",
    "corsheaders",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "corsheaders.middleware.CorsMiddleware",          # as high as possible, before CommonMiddleware
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "rest_framework_simplejwt.authentication.JWTAuthentication",   # first → 401 + WWW-Authenticate
        "rest_framework.authentication.SessionAuthentication",         # admin/browsable API
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",                  # fail closed (default is AllowAny!)
    ],
    "DEFAULT_THROTTLE_CLASSES": [
        "rest_framework.throttling.AnonRateThrottle",
        "rest_framework.throttling.UserRateThrottle",
    ],
    "DEFAULT_THROTTLE_RATES": {
        "anon": "60/min",
        "user": "1000/hour",
        "login": "5/min",
        "exports": "10/day",
    },
    "NUM_PROXIES": 1,                     # exactly one trusted load balancer in front
}

from datetime import timedelta

SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=5),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=1),
    "ROTATE_REFRESH_TOKENS": True,
    "BLACKLIST_AFTER_ROTATION": True,
    "AUTH_HEADER_TYPES": ("Bearer",),
    "SIGNING_KEY": env("JWT_SIGNING_KEY"),   # separate from SECRET_KEY so you can rotate independently
}

CORS_ALLOWED_ORIGINS = ["https://app.example.com"]
CORS_ALLOW_CREDENTIALS = False             # True only if you send cookies cross-origin

CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.redis.RedisCache",
        "LOCATION": env("REDIS_URL"),       # shared counters across workers and pods
    }
}
```

```python
# config/urls.py
from rest_framework_simplejwt.views import (
    TokenBlacklistView, TokenObtainPairView, TokenRefreshView,
)

urlpatterns += [
    path("api/token/", TokenObtainPairView.as_view(), name="token_obtain_pair"),
    path("api/token/refresh/", TokenRefreshView.as_view(), name="token_refresh"),
    path("api/token/blacklist/", TokenBlacklistView.as_view(), name="token_blacklist"),
]
```

```bash
python manage.py migrate      # creates token_blacklist tables
curl -s -X POST localhost:8000/api/token/ -H 'Content-Type: application/json' \
     -d '{"username":"ann","password":"s3cret!"}'
```

```text
{"refresh":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...","access":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."}
```

### Custom claims (and what not to put in them)

```python
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer
from rest_framework_simplejwt.views import TokenObtainPairView


class ClaimsSerializer(TokenObtainPairSerializer):
    @classmethod
    def get_token(cls, user):
        token = super().get_token(user)
        token["tenant_id"] = user.tenant_id      # fine: non-secret, stable
        token["role"] = user.role                # stale until token expires — keep TTL short
        return token


class LoginView(TokenObtainPairView):
    serializer_class = ClaimsSerializer
    throttle_scope = "login"
    throttle_classes = [ScopedRateThrottle]     # brute-force friction, not a full defence
```

JWT payloads are **base64-encoded, not encrypted** — never put emails you consider private, permissions you cannot afford to be stale, or secrets in them.

### Real-world example: multi-tenant permissions

```python
# billing/permissions.py
from rest_framework.permissions import SAFE_METHODS, BasePermission


class IsTenantMember(BasePermission):
    message = "You are not a member of this workspace."

    def has_permission(self, request, view):
        return bool(request.user and request.user.is_authenticated and request.user.tenant_id)

    def has_object_permission(self, request, view, obj):
        return obj.tenant_id == request.user.tenant_id


class IsOwnerOrReadOnly(BasePermission):
    def has_object_permission(self, request, view, obj):
        if request.method in SAFE_METHODS:
            return True
        return obj.created_by_id == request.user.id


class HasScope(BasePermission):
    """Checks a 'scope' claim on the JWT (request.auth is the validated token)."""

    def has_permission(self, request, view):
        required = getattr(view, "required_scope", None)
        if required is None:
            return True
        token = request.auth
        scopes = token.get("scope", "").split() if token is not None else []
        return required in scopes
```

```python
# billing/views.py
from rest_framework import permissions, viewsets
from rest_framework.decorators import action
from rest_framework.throttling import ScopedRateThrottle

from .models import Invoice
from .permissions import IsOwnerOrReadOnly, IsTenantMember
from .serializers import InvoiceSerializer


class InvoiceViewSet(viewsets.ModelViewSet):
    serializer_class = InvoiceSerializer
    permission_classes = [IsTenantMember & (IsOwnerOrReadOnly | permissions.IsAdminUser)]

    def get_queryset(self):
        # THE authorization for list endpoints: scope rows to the tenant.
        return (Invoice.objects
                .filter(tenant_id=self.request.user.tenant_id)
                .select_related("customer")
                .order_by("-issued_at"))

    def perform_create(self, serializer):
        serializer.save(tenant_id=self.request.user.tenant_id, created_by=self.request.user)

    @action(detail=False, methods=["get"])
    def export(self, request):
        ...   # expensive CSV build; throttled via get_throttles() below
```

The SQL for a cross-tenant detail request shows why scoping matters — the row simply is not found:

```sql
SELECT ... FROM "billing_invoice"
INNER JOIN "billing_customer" ON (...)
WHERE ("billing_invoice"."tenant_id" = 3 AND "billing_invoice"."id" = 42)
LIMIT 21;   -- get() fetches up to 21 rows to detect MultipleObjectsReturned → 0 rows → 404
```

> **Gotcha:** `ScopedRateThrottle` reads `view.throttle_scope`. For a ViewSet that is one attribute for all actions; per-action scopes need `get_throttles()` keyed on `self.action`, or a small view for the expensive endpoint.

```python
    def get_throttles(self):
        if self.action == "export":
            self.throttle_scope = "exports"
            return [ScopedRateThrottle()]
        return super().get_throttles()
```

### `DjangoModelPermissions`

```python
class ProductViewSet(viewsets.ModelViewSet):
    queryset = Product.objects.all()            # required: it reads the model from the queryset
    serializer_class = ProductSerializer
    permission_classes = [permissions.DjangoModelPermissions]
```

It maps POST → `add_product`, PUT/PATCH → `change_product`, DELETE → `delete_product`; GET/HEAD/OPTIONS need no model permission by default (subclass and extend `perms_map` to require `view_product`). It uses `user.has_perms()`, i.e. Django's group/permission system covered in [Ch 26 · Permissions, Groups & Authorization](topic.html?p=26-permissions-authorization). `DjangoObjectPermissions` additionally needs an object-permission backend such as django-guardian.

### A custom authentication class (API keys for partners)

```python
import hashlib

from rest_framework import authentication, exceptions

from .models import ApiKey


class ApiKeyAuthentication(authentication.BaseAuthentication):
    keyword = "Api-Key"

    def authenticate(self, request):
        header = authentication.get_authorization_header(request).decode()
        if not header.startswith(self.keyword + " "):
            return None                                     # not ours — let others try
        raw = header[len(self.keyword) + 1:].strip()
        digest = hashlib.sha256(raw.encode()).hexdigest()   # store only hashes of keys
        try:
            key = ApiKey.objects.select_related("owner").get(digest=digest, revoked=False)
        except ApiKey.DoesNotExist:
            raise exceptions.AuthenticationFailed("Invalid API key.")
        if not key.owner.is_active:
            raise exceptions.AuthenticationFailed("User inactive.")
        return (key.owner, key)

    def authenticate_header(self, request):
        return self.keyword                                 # enables 401 responses
```

### Testing auth

```python
from rest_framework.test import APITestCase


class InvoiceAuthTests(APITestCase):
    def test_anonymous_gets_401(self):
        self.assertEqual(self.client.get("/api/invoices/").status_code, 401)

    def test_other_tenant_gets_404(self):
        inv = InvoiceFactory(tenant=self.tenant_a)
        self.client.force_authenticate(UserFactory(tenant=self.tenant_b))
        self.assertEqual(self.client.get(f"/api/invoices/{inv.pk}/").status_code, 404)

    def test_jwt_flow(self):
        resp = self.client.post("/api/token/", {"username": "ann", "password": "pw"}, format="json")
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {resp.data['access']}")
        self.assertEqual(self.client.get("/api/invoices/").status_code, 200)
```

`force_authenticate` skips authenticators entirely — keep at least one test per scheme that goes through real credentials.

## 6. Advantages, Disadvantages & Trade-offs

| Decision | Option A | Option B | Guidance |
|---|---|---|---|
| Browser SPA, same site | Session + CSRF | JWT in memory + refresh in HttpOnly cookie | Session is simpler and revocable; choose JWT only for cross-site or multi-service needs |
| Mobile app | DRF Token (no expiry) | JWT with refresh rotation | JWT/expiring tokens (or django-rest-knox) |
| Server-to-server | API key (hashed) | OAuth2 client credentials | API key for few partners; OAuth2 at scale ([REST API · OAuth2/OIDC](../rest-api/topic.html?p=19-oauth2-oidc)) |
| Token storage in browser | `localStorage` | `HttpOnly` cookie | localStorage is XSS-readable; cookies need CSRF and SameSite |
| Authorization of lists | Queryset scoping | Object permission | Always scoping; object permission is for detail routes |
| Rate limiting | DRF throttles | Gateway / Redis atomic limiter | DRF for per-user fair use; gateway for abuse |

### When to use
- `IsAuthenticated` as the global default; loosen per view with explicit `AllowAny`.
- `SessionAuthentication` for first-party web apps on the same registrable domain and for the admin.
- SimpleJWT with short access tokens and rotating, blacklisted refresh tokens for mobile and cross-domain clients.
- `ScopedRateThrottle` for expensive or sensitive endpoints (login, exports, OTP).

### When NOT to use
- Do not use DRF `TokenAuthentication` for public browser clients — tokens never expire and must live in JS-readable storage.
- Do not rely on `has_object_permission` for list security, or on CORS for any security.
- Do not use LocMem cache for throttles in a multi-process deployment.
- Do not embed rapidly changing authorization data in JWT claims.

## 7. Common Mistakes & Best Practices

**1. Leaving the default `AllowAny`.** A new view without `permission_classes` is public. Set `IsAuthenticated` globally, and add a test that enumerates URL patterns and checks anonymous access is denied except for an allowlist.

**2. Expecting object permissions on lists.** Covered above; fix with `get_queryset()` scoping, ideally in a shared base class or a tenant-aware manager.

**3. Overriding `permission_classes` and dropping the default.** `permission_classes = [IsOwner]` *replaces* `IsAuthenticated`; an anonymous user then reaches `has_object_permission` with `AnonymousUser`. Include both: `[IsAuthenticated, IsOwner]`.

**4. Returning `False` from `authenticate()` instead of `None`.** DRF expects a tuple or `None`; anything else breaks unpacking. Raise `AuthenticationFailed` for bad credentials.

**5. `@csrf_exempt` sprinkled on API views to "fix" 403s.** APIView is already csrf-exempt; the 403 comes from `SessionAuthentication.enforce_csrf`. Send `X-CSRFToken` from the SPA (read from the `csrftoken` cookie) and configure `CSRF_TRUSTED_ORIGINS` — or use token auth for that client.

**6. `CORS_ALLOW_ALL_ORIGINS = True` with credentials.** Browsers reject `*` with credentials anyway; teams then reflect any origin, which lets any site make authenticated reads. Use an explicit allowlist.

**7. Long-lived access tokens "to avoid refresh complexity".** A leaked 30-day access token is a 30-day breach with no revocation. Keep access tokens minutes long.

**8. Throttle key spoofing.** `NUM_PROXIES` unset with a load balancer: clients rotate `X-Forwarded-For` to dodge anon limits. Set it correctly.

**Best practices:** fail closed globally; one authorization helper for tenant scoping; hash stored API keys; separate JWT signing key; logout = blacklist refresh + delete client copy; log authentication failures with user/IP for alerting; test 401/403/404 matrices per endpoint.

## 8. Production: Pitfalls, Debugging & Scaling

**Pitfall: throttles that don't throttle.** Symptom: a scraper does 5,000 req/hour against a "1000/hour" limit. Root cause: `LocMemCache` default — 8 workers × 4 pods = 32 independent counters, plus non-atomic read-modify-write. Fix: Redis cache, gateway limit for hard caps; for exact limits, a Redis `INCR`+`EXPIRE` or Lua-based throttle ([Redis · Sorted Sets & Rate Limiting](../redis-caching/topic.html?p=19-sorted-sets-rate-limiting)).

**Pitfall: every request hits the DB for the user.** `JWTAuthentication` loads the user per request; at high RPS that is a hot query. Usually fine (PK lookup), but if it matters use `JWTStatelessUserAuthentication` (a `TokenUser` built from claims, no DB) for read-only services, accepting that deactivation takes effect only at token expiry.

**Pitfall: "logged out" user still has access.** Blacklisting the refresh token does not kill an issued access token. Expected behaviour; keep the access TTL short, or keep a small Redis denylist of `jti`s checked by a custom authenticator for high-risk cases.

**Pitfall: rotating `SECRET_KEY` logs everyone out and invalidates JWTs.** Since SimpleJWT signs with `SECRET_KEY` by default, a rotation invalidates all tokens and sessions. Use a dedicated `SIGNING_KEY`, and for `SECRET_KEY` use `SECRET_KEY_FALLBACKS` (Django 4.1+) during rotation.

**Pitfall: CSRF failures behind a proxy.** Symptom: SPA POSTs fail with "CSRF Failed: Origin checking failed". Root cause: `CSRF_TRUSTED_ORIGINS` missing the scheme-qualified SPA origin, or `SECURE_PROXY_SSL_HEADER` not set so Django thinks the request is HTTP. See [Ch 28 · Security](topic.html?p=28-security).

**Debugging.**
- `request.successful_authenticator` tells you which class authenticated the request — log it.
- Decode a JWT locally (`jwt.io` or `python -c "import jwt; print(jwt.decode(t, options={'verify_signature': False}))"`) to inspect `exp`, `token_type`, `user_id`.
- Inspect throttle state: `cache.get("throttle_user_42")` returns the timestamp list.
- `curl -i` to see `WWW-Authenticate`, `Retry-After` and CORS headers; browser devtools for preflight responses.

**Scaling.** Stateless JWT verification scales without a session store; sessions scale fine on Redis (`cached_db` or `cache` engine). Authorization cost is dominated by queryset scoping — index `tenant_id` (often composite with the ordering column). Move abuse-oriented rate limiting to the edge so Django workers are not spent rejecting traffic.

## 9. Interview Questions

**Q: What is the difference between authentication and permissions in DRF?**
A: Authentication identifies the caller: authentication classes inspect the request and set `request.user` and `request.auth`, or leave the request anonymous. Permissions authorise: permission classes look at the user, the view and possibly the object and allow or deny. They run in that order in `APIView.initial()`, followed by throttles. A request with no credentials is not rejected by authentication — it is the `IsAuthenticated` permission that rejects it.

**Q: What is the difference between `has_permission` and `has_object_permission`?**
A: `has_permission(request, view)` runs for every request in `initial()`, before the handler. `has_object_permission(request, view, obj)` runs only when `check_object_permissions()` is called — which `GenericAPIView.get_object()` does for retrieve, update, destroy and detail actions. It never runs on list or create. Both default to `True` in `BasePermission`, and all permission classes must pass.

**Q: Why doesn't my object-level permission protect the list endpoint, and how do you fix it?**
A: Because list views never call `get_object()`, so `has_object_permission` is never invoked; every row of the queryset is serialised. The fix is to filter `get_queryset()` by the user/tenant so unauthorised rows are not in the result at all. That filtering also makes detail lookups of foreign objects return 404, which avoids leaking existence.

**Q: Compare session, token and JWT authentication. When would you use each?**
A: Session auth stores state server-side and uses an `HttpOnly` cookie; it is revocable and simple but needs CSRF protection and works best same-site. DRF's TokenAuthentication is an opaque DB-backed key with no expiry — fine for internal or server clients. JWT is a signed, self-contained token verified without a session store; it suits mobile and cross-domain clients and multi-service setups, but cannot easily be revoked, so access tokens must be short-lived with refresh tokens rotated and blacklisted. JWT is about statelessness, not extra security.

**Q: How does SimpleJWT's refresh flow work, and what does blacklisting do?**
A: Login returns an access token (default 5 minutes) and a refresh token (default 1 day). When access expires the client posts the refresh token to the refresh endpoint and gets a new access token; with `ROTATE_REFRESH_TOKENS` it also gets a new refresh token. With `BLACKLIST_AFTER_ROTATION` and the `token_blacklist` app installed, the old refresh token is recorded as blacklisted so it cannot be reused; logout blacklists the current refresh token. Access tokens are not blacklisted — they live until `exp`.

**Q: Why does DRF return 403 instead of 401 for an unauthenticated request?**
A: A 401 must carry `WWW-Authenticate`. DRF uses the first authentication class's `authenticate_header()`; `SessionAuthentication` doesn't provide one, so the response becomes 403. Put `JWTAuthentication` or `TokenAuthentication` first to get 401, which SPAs typically use to trigger a token refresh.

**Q: Does DRF enforce CSRF?**
A: `APIView.as_view()` is `csrf_exempt`, so Django's middleware does not check DRF views. `SessionAuthentication` re-applies Django's CSRF check itself, but only when the request was authenticated by session — so cookie-authenticated unsafe requests need the `X-CSRFToken` header. Token and JWT auth in headers need no CSRF protection because browsers do not attach them automatically.

**Q: How does DRF throttling work and what are its limitations?**
A: Throttle classes run after permissions. `SimpleRateThrottle` keeps a list of request timestamps per key (user id, IP, or scope + id) in Django's cache and allows the request if fewer than N fall within the window; otherwise it raises `Throttled` (429, `Retry-After`). It is non-atomic and only as shared as the cache — with LocMem each worker counts separately — and anonymous keys depend on `X-Forwarded-For` handling via `NUM_PROXIES`. Treat it as fair-use limiting and enforce hard limits at the gateway.

**Q: What is CORS and is it a security mechanism for your API?**
A: CORS is a browser mechanism: the server's `Access-Control-Allow-*` headers tell a browser whether JavaScript from another origin may read a response (and whether non-simple requests may be sent after a preflight). It protects users' browsers from other sites reading their authenticated data, but it does nothing against curl, scripts or mobile apps. Your API's protection is authentication and authorization. In Django use `django-cors-headers` with an explicit `CORS_ALLOWED_ORIGINS`.

**Q: Design authentication for a Django API serving a web SPA, a mobile app and partner integrations. (Senior)**
A: For the web SPA on the same site, session auth with CSRF (or, if cross-site, JWT access token in memory plus refresh token in an `HttpOnly`, `Secure`, `SameSite` cookie used only on the refresh endpoint). For mobile, SimpleJWT with short access TTL, refresh rotation and blacklisting, plus device-bound refresh token records so a user can revoke a device. For partners, hashed API keys with scopes and per-key throttles, or OAuth2 client credentials if partners are many. Order authenticators so the header-based ones come first (proper 401s), set `IsAuthenticated` globally, scope querysets by tenant, use a dedicated JWT signing key with a rotation plan, and log/alert on authentication failures and unusual token refresh rates.

**Q: Your rate limit of 100/min is being exceeded by some clients by 10x. Diagnose. (Senior)**
A: First check the cache backend — LocMem gives each worker its own counters, so effective limit = limit × workers × pods. Then check the key: for anonymous traffic `get_ident()` uses `X-Forwarded-For`; with `NUM_PROXIES` unset clients can spoof it. Then concurrency: the throttle reads and writes the timestamp list non-atomically, so bursts slip through. Fixes: Redis-backed cache, correct `NUM_PROXIES`, an atomic Redis counter throttle for strict endpoints, and a gateway limit as the outer bound. Verify by logging the throttle key and inspecting the cache entry.

**Q: How do you revoke access immediately for a compromised user when you use JWTs? (Senior)**
A: Deactivate the user (`is_active=False`): SimpleJWT's default authenticator loads the user per request and rejects inactive users, so access stops immediately — that's a reason not to use stateless user auth for user-facing APIs. Blacklist all their outstanding refresh tokens (`OutstandingToken` → `BlacklistedToken`). If you must keep the user active but kill sessions, add a `token_version` on the user, include it as a claim, and reject tokens whose version is stale in a custom authenticator — trading one cache/DB read for revocability. Also shorten access TTLs and rotate the signing key in a true key-compromise scenario.

**Q: How would you implement role-based plus object-based permissions cleanly in DRF? (Senior)**
A: Keep three layers: coarse role checks in `has_permission` (e.g. `HasRole("billing_admin")`), row visibility in `get_queryset()` (tenant/team scoping), and fine object rules in `has_object_permission` (owner, status-based rules like "cannot edit a paid invoice"). Compose with `&`/`|` and test the composition. For per-object ACLs use Django's permission framework with django-guardian or `rules` predicates so the logic is reusable in admin and templates too ([Ch 26](topic.html?p=26-permissions-authorization)). Put rules in one module, not inlined in views, and drive tests from a permission matrix.

**Q: What does `request.auth` contain?**
A: The second element of the tuple returned by the successful authenticator: the `Token` instance for TokenAuthentication, the validated `AccessToken` for SimpleJWT, `None` for session auth, or whatever a custom authenticator returns (e.g. an ApiKey row). Use it to read scopes, claims or key metadata in permissions.

## 10. Quick Revision & Cheat Sheet

| Item | Value / rule |
|---|---|
| Default auth classes | `SessionAuthentication`, `BasicAuthentication` |
| Default permission | **`AllowAny`** — change it to `IsAuthenticated` |
| Order in `initial()` | authenticate → permissions → throttles |
| Auth result | tuple wins; `None` = try next; raise = stop |
| 401 vs 403 | first authenticator's `authenticate_header()` |
| Object permission | only via `get_object()`; never on list |
| `SAFE_METHODS` | GET, HEAD, OPTIONS |
| SimpleJWT defaults | access 5 min, refresh 1 day, HS256, `Bearer` |
| Blacklist | refresh tokens only; needs `token_blacklist` app |
| Throttles | cache-backed timestamp lists; use Redis; set `NUM_PROXIES` |
| CORS | `CorsMiddleware` high in the stack; allowlist origins |

- Scope every queryset by user/tenant — that is list authorization.
- Overriding `permission_classes` replaces the defaults; restate `IsAuthenticated`.
- SessionAuthentication enforces CSRF only for session-authenticated requests.
- JWT is stateless, not magic; keep access tokens short.
- Never put secrets or fast-changing permissions in JWT claims.
- Hash API keys at rest.
- CORS protects browsers, not your API.

## 11. Hands-On Exercises

```bash
python -m venv .venv && source .venv/bin/activate
pip install "django~=5.2" "djangorestframework>=3.15" djangorestframework-simplejwt django-cors-headers redis
```

1. **Authenticator order.** Configure `[SessionAuthentication, JWTAuthentication]`, call an endpoint anonymously and note 403; swap the order and get 401. Send an expired JWT with a valid session cookie and observe the chain stopping.
2. **List leak.** Build an `InvoiceViewSet` with only `IsOwner.has_object_permission`; show that `/invoices/` lists everyone's invoices; fix with `get_queryset()` and write tests.
3. **JWT lifecycle.** Obtain, use, let expire (set access lifetime to 10 s), refresh with rotation, reuse the old refresh token (expect 401), and blacklist on logout.
4. **Throttle accuracy.** Run Gunicorn with 4 workers and LocMem cache; hammer an endpoint limited to `10/min` with `hey` or a loop and count 200s. Switch to Redis and repeat.
5. **API key auth.** Implement the `ApiKeyAuthentication` above with hashed keys and a `revoked` flag; add a management command to issue keys.

**Mini project — "Multi-tenant Billing API".** Tenants, users with roles, invoices. Requirements: JWT with tenant claim and rotation; session auth for the admin; global `IsAuthenticated`; tenant scoping in a base viewset; owner/role object permissions with a test matrix; scoped throttles for login and export; CORS allowlist; a test that asserts every registered route denies anonymous access.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** [Ch 22 · DRF Views, ViewSets & Routers](topic.html?p=22-drf-views-viewsets-routers) · [Ch 25 · Authentication & the Custom User Model](topic.html?p=25-authentication-custom-user) · [Ch 26 · Permissions, Groups & Authorization](topic.html?p=26-permissions-authorization) · [Ch 27 · Sessions, Cookies & Messages](topic.html?p=27-sessions-cookies) · [Ch 28 · Security: CSRF, XSS, SQL Injection & Hardening](topic.html?p=28-security) · [Ch 29 · Caching in Django](topic.html?p=29-caching) · [Ch 38 · Interview: DRF, Security & Scale](topic.html?p=38-interview-drf-advanced)

**Other handbooks:** [REST API · Authentication Basics](../rest-api/topic.html?p=18-authentication-basics) · [REST API · OAuth 2.0 & OIDC](../rest-api/topic.html?p=19-oauth2-oidc) · [REST API · JWT](../rest-api/topic.html?p=20-jwt) · [REST API · Authorization: RBAC & ABAC](../rest-api/topic.html?p=21-authorization-rbac-abac) · [REST API · TLS, CORS & Security Headers](../rest-api/topic.html?p=22-tls-cors-security-headers) · [REST API · Rate Limiting](../rest-api/topic.html?p=24-rate-limiting-throttling)

- **Authentication (API Guide)** — Django REST framework · *Intermediate* · every built-in scheme and how to write your own. <https://www.django-rest-framework.org/api-guide/authentication/>
- **Permissions (API Guide)** — Django REST framework · *Intermediate* · view vs object permissions, composition, custom classes. <https://www.django-rest-framework.org/api-guide/permissions/>
- **Throttling (API Guide)** — Django REST framework · *Intermediate* · rates, scopes, client identification and caveats. <https://www.django-rest-framework.org/api-guide/throttling/>
- **Simple JWT documentation** — jazzband · *Intermediate* · settings, rotation, blacklist app, custom claims. <https://django-rest-framework-simplejwt.readthedocs.io/>
- **django-cors-headers** — adamchainz on GitHub · *Beginner* · configuration and middleware placement. <https://github.com/adamchainz/django-cors-headers>
- **OWASP API Security Top 10** — OWASP · *Intermediate* · BOLA, broken auth and resource consumption explained. <https://owasp.org/www-project-api-security/>
- **Django CSRF protection** — Django docs · *Intermediate* · how the token and Origin checks work, AJAX usage. <https://docs.djangoproject.com/en/5.2/howto/csrf/>

---

*Django Handbook — chapter 23.*
