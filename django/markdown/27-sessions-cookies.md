# 27 · Sessions, Cookies & Messages

> **In one line:** HTTP is stateless, so Django gives each browser an opaque random session key in a cookie and keeps the real state server-side (or signed inside the cookie) — understanding how `SessionMiddleware` loads lazily, saves only on modification, rotates the key on login and flags the cookie is what separates "it logs in" from "it survives a security review and a Redis outage".

---

## 1. Overview

> **Builds on:** [Ch 18 · Middleware](topic.html?p=18-middleware) (the request/response onion `SessionMiddleware` lives in), [Ch 25 · Authentication & the Custom User Model](topic.html?p=25-authentication-custom-user) (`login()` and `logout()` are session operations), [Ch 04 · Views, Requests & Responses](topic.html?p=04-views-requests-responses) (`HttpRequest.COOKIES`, `HttpResponse.set_cookie`).

Every HTTP request arrives with no memory of the previous one. Yet a shopping cart, a logged-in user, a multi-step form and a "Your changes were saved" banner all require state that spans requests. The browser's only built-in mechanism is the **cookie**: a small name/value pair the server sets with `Set-Cookie` and the browser echoes back with `Cookie`.

The naive approach is to put the state itself into cookies: `user_id=42`, `is_admin=1`, `cart=[...]`. That fails immediately. Cookies are fully controlled by the client, so `user_id=1` makes anyone the first user. They are limited to roughly 4 KB each, they are sent on *every* request to the domain (bloating static asset requests too), and once issued you cannot revoke them — a stolen cookie stays valid until it expires.

Django's **sessions framework** (`django.contrib.sessions`) solves this with the classic design: the cookie carries only an unguessable random **session key**, and the data lives server-side — in the database by default, or in a cache, a file, or (with a deliberate trade-off) signed inside the cookie. `request.session` behaves like a dictionary; `SessionMiddleware` loads it lazily on first access and writes it back only when you modify it. The authentication system is built on top: `login()` stores the user id in the session, and `AuthenticationMiddleware` reads it back on each request.

Around sessions sit two related tools. The **signing framework** (`django.core.signing`) produces tamper-proof values with HMAC, used by signed-cookie sessions, password-reset tokens and anything you want to hand to a client and trust later. The **messages framework** (`django.contrib.messages`) provides one-time "flash" notifications that survive a redirect, stored in a cookie or the session.

This chapter covers how sessions work internally, the engine choice and its production consequences, cookie flags and session fixation, signing, and messages — and the interview questions that come up every time ("how do Django sessions work?", "what is session fixation?", "why did my session change not save?").

## 2. Core Concepts

- **Session key** — a 32-character random string (lowercase letters and digits) stored in the `sessionid` cookie. *Why it matters:* it is a bearer credential; whoever holds it *is* the user.
- **`SessionStore`** — the engine class (`SESSION_ENGINE`) implementing load/save/exists/delete/create. *Why:* swapping the engine changes durability, latency and revocability without code changes.
- **`request.session`** — a `SessionBase` dict-like object, loaded on first access. *Why:* views that never touch it cost nothing.
- **`modified` / `accessed` flags** — set by `__setitem__`/`__delitem__` and by any read. *Why:* only `modified` triggers a save; mutations of nested objects do not set it.
- **Session serializer** — `JSONSerializer` (the only built-in one since `PickleSerializer` was removed in Django 5.0). *Why:* you can only store JSON-serializable values — no datetimes, Decimals or model instances without converting.
- **Expiry** — `SESSION_COOKIE_AGE` (default 1,209,600 s = 2 weeks), `SESSION_EXPIRE_AT_BROWSER_CLOSE`, `request.session.set_expiry()`. *Why:* idle timeout and absolute timeout are compliance requirements in finance and health.
- **Cookie flags** — `Secure`, `HttpOnly`, `SameSite`, `Domain`, `Path`. *Why:* they decide whether the cookie leaks over HTTP, to JavaScript, or on cross-site requests.
- **Session fixation** — an attacker plants a known session key in the victim's browser before login, then rides the authenticated session. *Why:* Django defeats it with `cycle_key()` in `login()`; custom login flows must not skip it.
- **Session auth hash** — `_auth_user_hash`, an HMAC of the user's password hash stored in the session. *Why:* changing the password invalidates every other session automatically.
- **Signing** — `Signer`, `TimestampSigner`, `signing.dumps/loads` producing `value:signature` with HMAC keyed by `SECRET_KEY`. *Why:* integrity without server storage; *not* encryption.
- **`SECRET_KEY_FALLBACKS`** (4.1+) — older keys still accepted for verification. *Why:* lets you rotate `SECRET_KEY` without logging everyone out.
- **Messages** — `messages.success(request, "Saved")` stored by `FallbackStorage` (cookie first, session if too large), consumed when iterated. *Why:* the post/redirect/get pattern needs a place to put feedback.

## 3. Theory & Principles

### What `SessionMiddleware` does on every request

`django.contrib.sessions.middleware.SessionMiddleware` is a small class with two hooks:

**`process_request`** reads `request.COOKIES.get(settings.SESSION_COOKIE_NAME)` and assigns `request.session = self.SessionStore(session_key)`. Nothing is loaded yet. `SessionBase` stores the key and defers loading to the `_session` property, which calls `self.load()` the first time any key is read or written. An invalid or expired key loads as an empty session, and the key is discarded so a new one is generated on save — Django never trusts a client-chosen key.

**`process_response`** inspects the flags:

1. If the session was **accessed**, add `Vary: Cookie` to the response (caches must not share a response across users).
2. If the session is **empty** but the request had a cookie, delete the cookie.
3. If the session was **modified**, or `SESSION_SAVE_EVERY_REQUEST` is `True`, and the response status is not 500: call `request.session.save()` and emit `Set-Cookie` with the key, `max_age`/`expires` derived from the expiry policy, and the configured flags.

The diagram traces this lifecycle.

```svg
<svg viewBox="0 0 880 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj27a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="dj27b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">SessionMiddleware: lazy load in, conditional save out</text>
  <rect x="20" y="50" width="120" height="60" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="80" y="74" text-anchor="middle" fill="#1e293b" font-weight="bold">Browser</text>
  <text x="80" y="92" text-anchor="middle" fill="#334155" font-size="10">Cookie: sessionid=k3x...</text>
  <path d="M140,80 L196,80" stroke="#2563eb" stroke-width="2" marker-end="url(#dj27a)"/>
  <rect x="198" y="44" width="220" height="72" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="308" y="64" text-anchor="middle" fill="#1e293b" font-weight="bold">process_request</text>
  <text x="212" y="84" fill="#334155" font-size="10">key = COOKIES["sessionid"]</text>
  <text x="212" y="100" fill="#334155" font-size="10">request.session = SessionStore(key)</text>
  <path d="M418,80 L474,80" stroke="#2563eb" stroke-width="2" marker-end="url(#dj27a)"/>
  <rect x="476" y="44" width="384" height="72" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="668" y="64" text-anchor="middle" fill="#1e293b" font-weight="bold">view: request.session["cart_id"]</text>
  <text x="490" y="84" fill="#334155" font-size="10">first access: _session property calls load()</text>
  <text x="490" y="100" fill="#334155" font-size="10">db: SELECT session_data WHERE key AND expire_date &gt; now</text>
  <rect x="476" y="140" width="384" height="96" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="668" y="160" text-anchor="middle" fill="#1e293b" font-weight="bold">Store (SESSION_ENGINE)</text>
  <text x="490" y="182" fill="#334155" font-size="10">db: django_session (key, data, expire_date)</text>
  <text x="490" y="198" fill="#334155" font-size="10">cache: "django.contrib.sessions.cache" + key</text>
  <text x="490" y="214" fill="#334155" font-size="10">cached_db: cache first, DB on miss, write both</text>
  <text x="490" y="230" fill="#334155" font-size="10">signed_cookies: data is the cookie itself</text>
  <path d="M668,116 L668,138" stroke="#d97706" stroke-width="2" marker-end="url(#dj27a)"/>
  <rect x="198" y="260" width="662" height="110" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="529" y="280" text-anchor="middle" fill="#1e293b" font-weight="bold">process_response</text>
  <text x="214" y="302" fill="#334155" font-size="10">accessed? add Vary: Cookie</text>
  <text x="214" y="320" fill="#334155" font-size="10">empty and cookie present? delete cookie</text>
  <text x="214" y="338" fill="#334155" font-size="10">modified or SESSION_SAVE_EVERY_REQUEST (and status != 500)?</text>
  <text x="234" y="356" fill="#334155" font-size="10">save() then Set-Cookie: sessionid=...; HttpOnly; SameSite=Lax; Secure; Max-Age</text>
  <path d="M198,316 L82,316 L82,112" stroke="#16a34a" stroke-width="2" marker-end="url(#dj27b)"/>
  <text x="440" y="400" text-anchor="middle" fill="#334155" font-size="10">Reads alone never write. Nested mutation (session["cart"].append(x)) does not set modified.</text>
</svg>
```

### The modification rule

`SessionBase.__setitem__` sets `self.modified = True`. Mutating an object *stored in* the session does not go through `__setitem__`:

```python
request.session["cart"] = {"items": []}       # modified = True, saved
request.session["cart"]["items"].append(17)   # modified stays False -> NOT saved
request.session.modified = True               # explicit fix
```

This is the single most-asked session gotcha.

### How login, logout and session fixation fit together

`django.contrib.auth.login(request, user)` does, in order:

1. If the session already holds a *different* user id (or a mismatched auth hash), `flush()` it; otherwise call **`cycle_key()`**, which keeps the data but moves it to a brand-new key and deletes the old record.
2. Store `_auth_user_id`, `_auth_user_backend` and `_auth_user_hash`.
3. Rotate the CSRF token (`rotate_token`) and send `user_logged_in`.

`cycle_key()` is the session-fixation defence: an attacker who planted key `ATTACKER` in your browser (via a subdomain cookie or a URL in old frameworks) finds that key dead the moment you log in. `logout()` calls `flush()`, which deletes the stored record and issues a new empty session, so a stolen pre-logout key is useless — **except** with the `signed_cookies` engine, where there is no stored record to delete.

```svg
<svg viewBox="0 0 880 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj27c" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Session fixation and how cycle_key() defeats it</text>
  <line x1="40" y1="70" x2="840" y2="70" stroke="#94a3b8" stroke-width="2" marker-end="url(#dj27c)"/>
  <text x="40" y="58" fill="#334155" font-size="10">time</text>
  <rect x="40" y="86" width="180" height="64" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="130" y="106" text-anchor="middle" fill="#1e293b" font-weight="bold">1. Attacker plants key</text>
  <text x="130" y="124" text-anchor="middle" fill="#334155" font-size="10">sessionid=ATTACKER set via</text>
  <text x="130" y="140" text-anchor="middle" fill="#334155" font-size="10">a sibling subdomain cookie</text>
  <rect x="240" y="86" width="180" height="64" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="330" y="106" text-anchor="middle" fill="#1e293b" font-weight="bold">2. Victim logs in</text>
  <text x="330" y="124" text-anchor="middle" fill="#334155" font-size="10">POST /login with</text>
  <text x="330" y="140" text-anchor="middle" fill="#334155" font-size="10">Cookie: sessionid=ATTACKER</text>
  <rect x="440" y="86" width="190" height="64" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="535" y="106" text-anchor="middle" fill="#1e293b" font-weight="bold">3. login() cycle_key()</text>
  <text x="535" y="124" text-anchor="middle" fill="#334155" font-size="10">data copied to key NEW123,</text>
  <text x="535" y="140" text-anchor="middle" fill="#334155" font-size="10">record ATTACKER deleted</text>
  <rect x="650" y="86" width="190" height="64" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="745" y="106" text-anchor="middle" fill="#1e293b" font-weight="bold">4. Attacker replays</text>
  <text x="745" y="124" text-anchor="middle" fill="#334155" font-size="10">sessionid=ATTACKER loads as</text>
  <text x="745" y="140" text-anchor="middle" fill="#334155" font-size="10">empty: anonymous user</text>
  <rect x="40" y="180" width="800" height="96" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="56" y="202" fill="#1e293b" font-weight="bold">Without rotation (custom login that sets session["user_id"] directly):</text>
  <text x="56" y="222" fill="#334155" font-size="10">the ATTACKER key now maps to an authenticated session and step 4 succeeds - full account takeover.</text>
  <text x="56" y="244" fill="#1e293b" font-weight="bold">Also rotate on privilege change:</text>
  <text x="56" y="264" fill="#334155" font-size="10">call request.session.cycle_key() after MFA step-up or sudo mode; after password change call update_session_auth_hash().</text>
</svg>
```

### Signing: integrity, not secrecy

`django.core.signing.Signer` computes an HMAC (SHA-256 by default) of the value with a key derived from `SECRET_KEY` and a **salt** (a namespace so a signature from one feature cannot be replayed in another). `Signer().sign("42")` yields `"42:<base64 signature>"`. `TimestampSigner` appends a timestamp so `unsign(value, max_age=3600)` can reject old values with `SignatureExpired`. `signing.dumps(obj)` JSON-encodes, optionally compresses, base64s and signs. Anyone can base64-decode and *read* the payload; they just cannot change it. Never put secrets in signed values.

## 4. Architecture & Workflow

### Choosing a session engine

| Engine (`SESSION_ENGINE`) | Where data lives | Read cost | Durable | Server-side revoke | Notes |
|---|---|---|---|---|---|
| `django.contrib.sessions.backends.db` (default) | `django_session` table | 1 indexed query | Yes | Yes | Needs `clearsessions` cron; write per login |
| `...backends.cache` | Cache (`SESSION_CACHE_ALIAS`) | Cache GET | No — eviction/restart logs users out | Yes | Use Redis/Memcached, never `locmem` with multiple workers |
| `...backends.cached_db` | Cache + DB (write-through) | Cache GET, DB on miss | Yes | Yes | Best general default for production |
| `...backends.file` | Files in `SESSION_FILE_PATH` | File read | On that host only | Yes | Single-server only |
| `...backends.signed_cookies` | The cookie itself | None | N/A | **No** | ~4 KB limit; readable by client; logout cannot kill copies |

The request topology with `cached_db` and Redis:

```text
browser ─Cookie: sessionid─▶ LB ─▶ gunicorn worker N
                                     │ SessionMiddleware
                                     ├─ cache.get("django.contrib.sessions.cached_db" + key) ──▶ Redis   (hit: done)
                                     └─ miss ─▶ SELECT ... FROM django_session WHERE session_key=%s AND expire_date > now
                                                 └─ cache.set(...) repopulates
                         on save:   UPDATE/INSERT django_session  +  cache.set(...)
```

Because the store is shared, **any worker on any host** can serve any user — no sticky sessions needed. That is the key architectural property: Django's session state is externalized, so app servers stay stateless and horizontally scalable.

### Cookie flags and what each defends against

| Setting | Default | Production value | Defends against |
|---|---|---|---|
| `SESSION_COOKIE_SECURE` | `False` | `True` | Cookie sent over plain HTTP and sniffed |
| `SESSION_COOKIE_HTTPONLY` | `True` | `True` | XSS reading `document.cookie` |
| `SESSION_COOKIE_SAMESITE` | `"Lax"` | `"Lax"` (or `"Strict"`) | Cookie sent on cross-site POSTs (CSRF) |
| `SESSION_COOKIE_DOMAIN` | `None` (host-only) | `None` unless SSO across subdomains | Sibling subdomains reading/setting it |
| `SESSION_COOKIE_AGE` | 1209600 | Policy-driven | Long-lived stolen sessions |
| `SESSION_COOKIE_NAME` | `"sessionid"` | Change per app on shared domains | Two Django apps on one domain clobbering each other |
| `CSRF_COOKIE_SECURE` | `False` | `True` | Same as above for the CSRF cookie |

`SameSite=None` requires `Secure` and is only needed for cross-site embeds (an app in an iframe on a partner site). `SameSite=Lax` still sends the cookie on top-level GET navigations, so links from email work while cross-site form POSTs do not carry it.

### Messages workflow (post/redirect/get)

```text
POST /profile ──▶ form valid ──▶ messages.success(request, "Profile saved")
                                   └─ FallbackStorage: try CookieStorage ("messages" cookie, signed)
                                                      too big? overflow to SessionStorage
              ◀── 302 Location: /profile
GET /profile  ──▶ template: {% for m in messages %} ... {% endfor %}
                                   └─ iteration marks storage as used; process_response clears them
```

## 5. Implementation

### Simple example: a session cart and cookie helpers

```python
# settings.py (relevant parts)
INSTALLED_APPS = [
    "django.contrib.sessions",
    "django.contrib.messages",
    # ...
]
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]
```

```python
# shop/views.py
from django.contrib import messages
from django.shortcuts import redirect, render
from django.views.decorators.http import require_POST

CART_KEY = "cart"


@require_POST
def add_to_cart(request, product_id):
    cart = request.session.get(CART_KEY, {})          # JSON: keys must be strings
    key = str(product_id)
    cart[key] = cart.get(key, 0) + 1
    request.session[CART_KEY] = cart                   # reassign -> modified = True
    messages.success(request, "Added to cart.")
    return redirect("cart")


def cart_view(request):
    cart = request.session.get(CART_KEY, {})
    return render(request, "shop/cart.html", {"cart": cart})


def remember_theme(request):
    response = redirect("home")
    response.set_signed_cookie("theme", request.GET.get("t", "light"), salt="ui.theme",
                               max_age=60 * 60 * 24 * 365, secure=True, httponly=True, samesite="Lax")
    return response


def read_theme(request):
    return request.get_signed_cookie("theme", default="light", salt="ui.theme")   # tampered -> default
```

```html
{# templates/base.html #}
{% if messages %}
  <ul class="messages">
    {% for message in messages %}
      <li class="{{ message.tags }}">{{ message }}</li>
    {% endfor %}
  </ul>
{% endif %}
```

What the database row looks like:

```sql
SELECT session_key, expire_date, length(session_data) FROM django_session LIMIT 1;
```

```text
 session_key                      | expire_date                   | length
----------------------------------+-------------------------------+-------
 q8k3m1z0w7n2c5v9b4x6l1j0h3g8f2d5 | 2026-11-08 10:14:03.512+00    |   112
```

```python
>>> from django.contrib.sessions.models import Session
>>> Session.objects.get(pk="q8k3m1z0w7n2c5v9b4x6l1j0h3g8f2d5").get_decoded()
{'cart': {'17': 2}, '_auth_user_id': '42', '_auth_user_backend': 'django.contrib.auth.backends.ModelBackend', '_auth_user_hash': '5f1c...'}
```

### Real-world example: production session settings, idle timeout, step-up auth

```python
# settings/production.py
SESSION_ENGINE = "django.contrib.sessions.backends.cached_db"
SESSION_CACHE_ALIAS = "sessions"            # dedicated Redis DB so cache flushes do not log users out
CACHES = {
    "default":  {"BACKEND": "django.core.cache.backends.redis.RedisCache", "LOCATION": "redis://redis:6379/1"},
    "sessions": {"BACKEND": "django.core.cache.backends.redis.RedisCache", "LOCATION": "redis://redis:6379/2"},
}
SESSION_COOKIE_SECURE = True
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
SESSION_COOKIE_AGE = 60 * 60 * 8            # absolute: 8 hours
SESSION_COOKIE_NAME = "acme_sid"
CSRF_COOKIE_SECURE = True
SECRET_KEY = env("SECRET_KEY")
SECRET_KEY_FALLBACKS = env.list("OLD_SECRET_KEYS", default=[])   # rotation window
```

An idle-timeout middleware (absolute expiry comes from the cookie age; idle expiry must be tracked):

```python
# accounts/middleware.py
import time
from django.contrib.auth import logout
from django.shortcuts import redirect

IDLE_SECONDS = 15 * 60
TOUCH_EVERY = 60          # avoid a session write on every single request


class IdleTimeoutMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.user.is_authenticated:
            now = int(time.time())
            last = request.session.get("last_seen", now)
            if now - last > IDLE_SECONDS:
                logout(request)                       # flush(): deletes record, new key
                return redirect("login")
            if now - last > TOUCH_EVERY:
                request.session["last_seen"] = now    # throttled write
        return self.get_response(request)
```

Step-up authentication for sensitive actions, with key rotation on privilege change:

```python
# accounts/views.py
import time
from django.contrib.auth import update_session_auth_hash
from django.contrib.auth.forms import PasswordChangeForm


def confirm_password(request):
    if request.method == "POST" and request.user.check_password(request.POST["password"]):
        request.session.cycle_key()                      # new key for the elevated session
        request.session["sudo_until"] = int(time.time()) + 300
        return redirect(request.GET.get("next", "/"))
    return render(request, "accounts/confirm.html")


def change_password(request):
    form = PasswordChangeForm(request.user, request.POST or None)
    if form.is_valid():
        user = form.save()
        update_session_auth_hash(request, user)          # keep THIS session; others die via auth hash
        messages.success(request, "Password changed. Other devices were signed out.")
        return redirect("profile")
    return render(request, "accounts/change_password.html", {"form": form})
```

"Log out all other devices" for the db-backed engines (the session table is not indexed by user, so store a mapping on login):

```python
# accounts/models.py
from django.conf import settings
from django.db import models


class UserSession(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    session_key = models.CharField(max_length=40, unique=True)
    created = models.DateTimeField(auto_now_add=True)


# accounts/signals.py  (connected in AppConfig.ready)
from django.contrib.auth.signals import user_logged_in
from django.contrib.sessions.models import Session
from django.dispatch import receiver
from importlib import import_module
from django.conf import settings

SessionStore = import_module(settings.SESSION_ENGINE).SessionStore


@receiver(user_logged_in, dispatch_uid="track_user_session")
def track(sender, request, user, **kwargs):
    UserSession.objects.create(user=user, session_key=request.session.session_key)


def logout_everywhere_else(request):
    keep = request.session.session_key
    for us in UserSession.objects.filter(user=request.user).exclude(session_key=keep):
        SessionStore(session_key=us.session_key).delete()   # clears cache and DB for cached_db
        us.delete()
```

Expiry hygiene for the db engines:

```bash
python manage.py clearsessions        # deletes expired rows; schedule daily (cron or Celery beat)
```

Async views (Django 5.1+) have async session methods:

```python
async def async_cart(request):
    cart = await request.session.aget("cart", {})
    await request.session.aset("visited", True)
    return JsonResponse({"cart": cart})
```

## 6. Advantages, Disadvantages & Trade-offs

| Concern | Server-side sessions (db / cache / cached_db) | Signed-cookie sessions | Stateless JWT in a cookie/header |
|---|---|---|---|
| Revocation (logout, ban) | Immediate — delete the record | Impossible until expiry (unless you add a server-side denylist) | Impossible until expiry (needs denylist) |
| Read cost | Query or cache hit per request | None | Signature check |
| Payload size | Unlimited server-side | About 4 KB, sent on every request | Grows with claims |
| Confidentiality | Opaque key only | Payload readable (base64) | Payload readable |
| Horizontal scaling | Needs shared store | Nothing shared | Nothing shared |
| Best for | Browser apps, admin, anything with logout | Tiny, low-risk state | Service-to-service, mobile APIs — see [REST API · JWT](../rest-api/topic.html?p=20-jwt) |

### When to use

- **`cached_db`** as the production default: fast reads from Redis, durable through cache restarts.
- **`cache`** with a dedicated Redis instance (persistence on) when you accept losing sessions in a disaster and want zero DB writes.
- **`db`** for small apps without a cache tier.
- **Signed cookies** (via `set_signed_cookie`) for small, non-sensitive preferences.
- **Messages** for any feedback across a redirect.

### When NOT to use

- Do not use `signed_cookies` sessions where you need real logout, bans or "sign out all devices".
- Do not use the `cache` engine on `LocMemCache` with more than one process — each worker has its own memory, so users appear randomly logged out.
- Do not store large objects (querysets, full carts with product data) in the session; store ids.
- Do not use sessions for API clients that are not browsers; use token auth.

## 7. Common Mistakes & Best Practices

**1. Mutating nested session data.** `request.session["cart"]["17"] += 1` is not saved. Reassign the top-level key or set `request.session.modified = True`.

**2. Storing non-JSON values.** Putting a `datetime`, `Decimal` or model instance in the session raises `TypeError: Object of type X is not JSON serializable` at response time (inside middleware, far from your view). Store ISO strings, ints and ids.

```python
# Before
request.session["last_order"] = order                  # TypeError in process_response
# After
request.session["last_order_id"] = order.pk
request.session["last_seen"] = timezone.now().isoformat()
```

**3. Writing a custom login that bypasses `login()`.** `request.session["user_id"] = user.pk` skips `cycle_key()`, the auth hash, CSRF rotation and the `user_logged_in` signal. Always call `django.contrib.auth.login` (or `alogin`).

**4. Never running `clearsessions`.** The `django_session` table grows by one row per new visitor (anonymous sessions too, once anything is stored). Teams find a 200 GB table years later. Schedule it.

**5. Using `SESSION_SAVE_EVERY_REQUEST = True` to implement idle timeout.** It writes the session on every request, including every AJAX poll, turning reads into writes and multiplying DB load. Throttle as in the middleware above.

**6. `SESSION_COOKIE_DOMAIN = ".example.com"` without need.** Every subdomain — including a marketing site on a third-party CMS — now receives the session cookie. Keep cookies host-only unless you deliberately share sessions.

**7. Rotating `SECRET_KEY` without fallbacks.** Every session (for signed engines and the auth hash), password-reset link and signed cookie becomes invalid at once. Put the old key in `SECRET_KEY_FALLBACKS`, deploy, wait out the longest token lifetime, then remove it.

**8. Messages that never show.** `messages.debug()` is dropped because `MESSAGE_LEVEL` defaults to `INFO`; messages added in a view that renders (not redirects) appear on the *next* page if the template does not iterate them. Iterate `messages` in the base template.

**Best practices:** keep sessions small and id-based; dedicated cache alias for sessions; `Secure` cookies in production (`check --deploy` warns otherwise); rotate keys on login and privilege changes; one cookie name per app on shared domains.

## 8. Production: Pitfalls, Debugging & Scaling

**Production story — random logouts after scaling to four workers.** *Symptom:* users are logged out every few clicks. *Root cause:* `SESSION_ENGINE = "...cache"` with the default `LocMemCache`; each Gunicorn worker has a private dict, so a session created in worker 1 does not exist in worker 3. *Fix:* Redis cache backend (or `cached_db`). Same symptom appears with the `file` engine on multiple hosts and with multiple Django apps sharing a domain and cookie name.

**Production story — cache flush logs out everyone.** An engineer ran `cache.clear()` to fix stale product pages; sessions lived in the same Redis DB under the `cache` engine. *Fix:* separate `SESSION_CACHE_ALIAS`, or `cached_db` so the DB repopulates the cache.

**Login loop behind a proxy.** *Symptom:* login succeeds, redirect returns to login. *Root cause:* `SESSION_COOKIE_SECURE=True` but TLS terminates at the load balancer and Django sees HTTP — the browser still accepts the cookie over HTTPS, but `SecurityMiddleware` redirects or `request.is_secure()` is wrong and CSRF fails. Also common: `SESSION_COOKIE_DOMAIN` set to a domain not matching the host so the browser rejects the cookie. *Fix:* `SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")` with a proxy that sets it, and correct domain settings. Debug by inspecting the `Set-Cookie` header in browser devtools — a rejected cookie shows a warning icon with the reason.

**Session writes as a hidden load source.** Every authenticated request with idle tracking, "last activity" or cart touches writes the session. On the `db` engine that is an UPDATE per request; at thousands of requests per second the `django_session` table becomes the hottest table in the database, with vacuum pressure on PostgreSQL. *Fix:* `cached_db` (reads from cache) and throttled writes; for pure-read requests make sure nothing sets a key.

**`Vary: Cookie` kills page caching.** Any view that *reads* the session (including via `request.user`, which touches the session) gets `Vary: Cookie`, so shared caches and `cache_page` store per-cookie variants. Anonymous landing pages should avoid touching the session; see [Ch 29 · Caching in Django](topic.html?p=29-caching).

**Debugging toolkit.**

```python
from importlib import import_module
from django.conf import settings
store = import_module(settings.SESSION_ENGINE).SessionStore(session_key="q8k3...")
store.load()                 # {} if expired, missing or tampered
store.get_expiry_date()
```

Log the session key prefix (never the full key — it is a credential) alongside user id in request logs to correlate issues. Sentry scrubs cookies by default; keep it that way.

**Scaling.** Session reads are key lookups, ideal for Redis. A single Redis instance handles very large session volumes; the concerns are memory (keys x average size — another reason to keep sessions small), persistence (enable AOF if you use the pure `cache` engine) and failover (Sentinel or a managed service). See [Redis Caching · Security Hardening](../redis-caching/topic.html?p=29-security-hardening) for protecting the instance that now holds every user's credentials.

## 9. Interview Questions

**Q: How do sessions work in Django?**
A: `SessionMiddleware` reads the `sessionid` cookie and attaches `request.session`, a `SessionStore` for that key, without loading anything. On first access the store loads the data from the configured engine (the `django_session` table by default) where the row is decoded from signed JSON. Views use it like a dict. In the response phase, if the session was modified the middleware saves it and sends `Set-Cookie` with the key and the configured flags. The cookie holds only a random key; the data stays server-side, which is why the client cannot tamper with it.

**Q: What session backends does Django provide and how do you choose?**
A: `db` (default), `cache`, `cached_db`, `file` and `signed_cookies`. `db` is durable but costs a query per request; `cache` is fast but loses sessions on eviction or restart; `cached_db` writes to both and reads from cache first, which is the best production default; `file` only works on a single host; `signed_cookies` stores data in the cookie, needs no server storage but cannot be revoked and is limited to about 4 KB. For multi-worker deployments the store must be shared — never `locmem`.

**Q: Why didn't my change to the session get saved?**
A: Django only saves when `request.session.modified` is `True`, which is set by assigning or deleting a top-level key. Mutating a nested object — `request.session["cart"].append(x)` — changes the dict in memory but does not touch `__setitem__`, so the change is lost. Reassign the key or set `request.session.modified = True`. Other causes: the response was a 500 (Django skips the save), or the value is not JSON-serializable.

**Q: What is session fixation and how does Django prevent it?**
A: The attacker gets the victim to use a session key the attacker knows — for example by setting a cookie from a sibling subdomain — then waits for the victim to log in, and reuses that key as an authenticated session. Django's `login()` calls `cycle_key()`, moving the session data to a new random key and deleting the old one, so the planted key is dead after login. `logout()` calls `flush()`, deleting the data and issuing a new key. Custom login code that writes the user id into the session directly reintroduces the bug.

**Q: What do the `HttpOnly`, `Secure` and `SameSite` cookie flags do, and what are Django's defaults?**
A: `HttpOnly` hides the cookie from JavaScript, limiting what XSS can steal; Django's session cookie is `HttpOnly` by default. `Secure` makes the browser send the cookie only over HTTPS; it defaults to `False` and must be enabled in production (`check --deploy` warns). `SameSite` controls whether the cookie is sent on cross-site requests; Django defaults to `Lax`, which blocks it on cross-site POSTs while allowing top-level link navigations. The CSRF cookie is not `HttpOnly` by default because some JavaScript setups read it.

**Q: Why does changing a password log out other sessions?**
A: `login()` stores `_auth_user_hash`, an HMAC of the user's password hash (`get_session_auth_hash()`). On every request `get_user()` recomputes it and compares; after a password change the hash differs, so other sessions are flushed and become anonymous. `update_session_auth_hash(request, user)` updates the current session so the user who changed the password stays logged in. Rotating `SECRET_KEY` without `SECRET_KEY_FALLBACKS` has the same effect on everyone.

**Q: What is the difference between signing and encryption, and how is Django's signing framework used?**
A: Signing proves a value was produced by someone with the key and has not been changed; encryption hides the value. `django.core.signing` signs with HMAC (SHA-256) using `SECRET_KEY` and a salt; the payload stays readable. It is used for signed-cookie sessions, `set_signed_cookie`, the messages cookie, and password-reset-style tokens. `TimestampSigner` and `signing.loads(max_age=...)` add expiry. Use different salts per purpose so a signature cannot be replayed in another context.

**Q: How do session expiry settings work?**
A: `SESSION_COOKIE_AGE` (default two weeks) sets the cookie max-age and the stored expiry. `SESSION_EXPIRE_AT_BROWSER_CLOSE = True` makes it a browser-session cookie (though browsers restoring tabs often keep them). `request.session.set_expiry(value)` overrides per session: an int is seconds of inactivity, a datetime is absolute, `0` means at browser close, and `None` falls back to the global policy. Expired rows in the db engine remain until `clearsessions` deletes them.

**Q: How does the messages framework work?**
A: `MessageMiddleware` attaches a storage backend to the request; the default `FallbackStorage` tries `CookieStorage` (a signed cookie) and overflows to `SessionStorage`. `messages.success(request, "...")` adds a message with a level and tags. When a template iterates `messages`, the storage is marked used and the messages are removed in the response phase; anything not iterated persists to the next request. The default `MESSAGE_LEVEL` is `INFO`, so debug messages are dropped.

**Q: Should a REST API use sessions or tokens?**
A: For a browser SPA on the same site, session authentication with `HttpOnly` cookies is often the safer choice: no token in JavaScript-accessible storage, real server-side logout, and CSRF protection via DRF's `SessionAuthentication`. For mobile apps, third-party clients and service-to-service calls, tokens (DRF tokens or JWT) fit better because there is no cookie jar and no CSRF concern. The trade-off is revocation versus statelessness. See [REST API · Authentication Basics](../rest-api/topic.html?p=18-authentication-basics).

**Q: Users are randomly logged out after you added more Gunicorn workers. How do you debug it? (Senior)**
A: Random logouts that scale with worker count mean the session store is not shared. Check `SESSION_ENGINE` and the cache it uses: `cache` engine on `LocMemCache`, or `file` on several hosts, gives each process its own store. Confirm by logging worker pid and whether `session.load()` returned empty for a known key. Other suspects: cache eviction (Redis `maxmemory` with `allkeys-lru` evicting session keys), a shared domain with another app using the same cookie name, or the secret key differing between hosts. Fix with a shared Redis or `cached_db`, a dedicated cache alias, and identical settings across hosts.

**Q: How would you implement "sign out of all other devices"? (Senior)**
A: With the db engine, sessions are not indexed by user, so scanning and decoding every row is too slow at scale. Record the mapping on `user_logged_in` in a `UserSession(user, session_key)` table, then delete those keys through the `SessionStore` (which also clears the cache for `cached_db`). A cheaper alternative that needs no table: bump a per-user "session generation" counter and store it in the session at login; middleware logs out sessions whose stored generation is stale. Changing the password also works via the auth hash. With signed-cookie sessions only the generation-counter approach is possible, since there is no record to delete.

**Q: How do you rotate `SECRET_KEY` without logging everyone out? (Senior)**
A: Since Django 4.1, set the new value in `SECRET_KEY` and move the old one into `SECRET_KEY_FALLBACKS`. New signatures use the new key while verification also accepts the fallbacks, so existing sessions' auth hashes, signed cookies, messages and password-reset tokens keep working. After the longest-lived artifact expires (two weeks for default sessions, `PASSWORD_RESET_TIMEOUT` for reset links), remove the fallback. On 4.2 and later this is a routine operation; before 4.1 rotation invalidated everything at once.

**Q: What are the trade-offs of the cache vs cached_db session engines in a high-traffic system? (Senior)**
A: The `cache` engine never touches the database, so login storms and per-request writes cost only Redis operations, but a Redis failover without persistence, eviction under memory pressure, or a `cache.clear()` logs users out. `cached_db` reads from the cache and falls back to the DB, so cache loss is survivable, but every save writes the database too, which matters if you write sessions often. Choose `cached_db` unless DB write volume from sessions is a real problem, then reduce writes (throttled touches) before switching to pure `cache` with a dedicated, persistent, non-evicting Redis.

## 10. Quick Revision & Cheat Sheet

| Item | Value / API |
|---|---|
| Cookie | `sessionid`, HttpOnly, SameSite=Lax, Secure off by default |
| Default engine | `django.contrib.sessions.backends.db` |
| Default age | 1,209,600 s (2 weeks) |
| Serializer | `JSONSerializer` only (Pickle removed in 5.0) |
| Save trigger | `modified` or `SESSION_SAVE_EVERY_REQUEST`; not on 500 |
| Fixation defence | `login()` calls `cycle_key()`; `logout()` calls `flush()` |
| Password change | `update_session_auth_hash(request, user)` |
| Expiry | `set_expiry(int/datetime/0/None)`, `clearsessions` |
| Signing | `Signer`, `TimestampSigner`, `signing.dumps/loads(salt=, max_age=)` |
| Signed cookie | `response.set_signed_cookie()`, `request.get_signed_cookie()` |
| Key rotation | `SECRET_KEY_FALLBACKS` (4.1+) |
| Messages | `messages.success/info/warning/error`, `FallbackStorage` |
| Async | `aget`, `aset`, `asave`, `aflush`, `acycle_key` (5.1+) |

- The cookie holds only a random key; data lives in the store.
- Nested mutations need `request.session.modified = True`.
- Sessions must be shared across workers: Redis or DB, never locmem.
- Signed-cookie sessions cannot be revoked.
- Always use `login()`/`logout()`; never hand-roll session auth.
- Run `clearsessions` on a schedule for db/file engines.
- Session access adds `Vary: Cookie`, which fragments caches.
- Signing is integrity, not secrecy.

## 11. Hands-On Exercises

Set up: `python -m venv .venv && source .venv/bin/activate && pip install "django~=5.2" redis`, start a project, run `migrate` and `createsuperuser`.

1. **Watch the lifecycle.** Add a view that only *reads* `request.session.get("x")` and another that sets it. Use `curl -i` to show that only the second emits `Set-Cookie`, and both emit `Vary: Cookie`.
2. **Nested mutation bug.** Implement a cart with `request.session["cart"]["items"].append(...)`, show it fails to persist across requests, then fix it two ways.
3. **Fixation demo.** Log in through the admin while noting the `sessionid` before and after; confirm it changes. Then write a naive login view that sets `session["user_id"]` and observe the key does not change.
4. **Engines.** Switch between `db`, `cache` (locmem), `cached_db` (Redis) and `signed_cookies`. Run `gunicorn -w 4` with locmem and reproduce random logouts. With signed cookies, copy the cookie, log out, and replay it with `curl` to see the session still valid.
5. **Signing.** In the shell, sign a value with `TimestampSigner(salt="invite")`, tamper with one character, and catch `BadSignature`; wait past `max_age` and catch `SignatureExpired`. Rotate `SECRET_KEY` with and without `SECRET_KEY_FALLBACKS`.
6. **Messages.** Add messages at each level, set `MESSAGE_LEVEL = messages.DEBUG`, and add a message larger than the cookie limit to see it overflow to the session.

**Mini project — device management page.** Build a "Your sessions" page listing each active login (device user agent, IP, created, last seen) with "sign out this device" and "sign out all others" buttons, using a `UserSession` table populated on `user_logged_in`, throttled last-seen updates, an idle timeout middleware and `cached_db` on Redis. Add tests for fixation (key rotates on login) and for the password-change behaviour.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** [Ch 25 · Authentication & the Custom User Model](topic.html?p=25-authentication-custom-user) · [Ch 26 · Permissions, Groups & Authorization](topic.html?p=26-permissions-authorization) · [Ch 28 · Security](topic.html?p=28-security) · [Ch 29 · Caching in Django](topic.html?p=29-caching) · [Ch 18 · Middleware](topic.html?p=18-middleware) · [Ch 23 · DRF Authentication, Permissions & Throttling](topic.html?p=23-drf-auth-permissions-throttling) · [Ch 35 · Deployment & Production Operations](topic.html?p=35-deployment-production)

**Other handbooks:** [REST API · Authentication Basics](../rest-api/topic.html?p=18-authentication-basics) · [REST API · JWT](../rest-api/topic.html?p=20-jwt) · [Redis Caching · Security Hardening](../redis-caching/topic.html?p=29-security-hardening)

- **How to use sessions** — Django docs · *Beginner* · engines, settings, the session API and `clearsessions`. <https://docs.djangoproject.com/en/5.2/topics/http/sessions/>
- **Cryptographic signing** — Django docs · *Intermediate* · `Signer`, `TimestampSigner`, salts and `SECRET_KEY_FALLBACKS`. <https://docs.djangoproject.com/en/5.2/topics/signing/>
- **The messages framework** — Django docs · *Beginner* · storage backends, levels and template usage. <https://docs.djangoproject.com/en/5.2/ref/contrib/messages/>
- **Settings reference (SESSION_*, CSRF_COOKIE_*)** — Django docs · *Beginner* · every cookie flag and its default. <https://docs.djangoproject.com/en/5.2/ref/settings/>
- **OWASP Session Management Cheat Sheet** — OWASP · *Intermediate* · idle/absolute timeouts, rotation and cookie attributes. <https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html>
- **MDN: Using HTTP cookies** — MDN · *Beginner* · cookie attributes and SameSite behaviour across browsers. <https://developer.mozilla.org/en-US/docs/Web/HTTP/Cookies>
- **django-user-sessions** — GitHub · *Intermediate* · a db session backend that records user, IP and user agent for device management. <https://github.com/jazzband/django-user-sessions>

---

*Django Handbook — chapter 27.*
