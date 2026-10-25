# 28 · Security: CSRF, XSS, SQL Injection & Hardening

> **In one line:** Django is secure by default against the classic web attacks — CSRF tokens, template autoescaping, parameterized SQL, `X-Frame-Options: DENY`, `ALLOWED_HOSTS` — but every one of those defences has an explicit off switch, and real Django breaches come from developers flipping them (`|safe`, `@csrf_exempt`, f-strings in `raw()`, `DEBUG=True`) or from never turning on the production settings that `check --deploy` lists.

---

## 1. Overview

> **Builds on:** [Ch 18 · Middleware](topic.html?p=18-middleware) (security features are middleware), [Ch 05 · Templates](topic.html?p=05-templates) (autoescaping), [Ch 27 · Sessions, Cookies & Messages](topic.html?p=27-sessions-cookies) (cookie flags, signing, `SECRET_KEY`), [Ch 25 · Authentication & the Custom User Model](topic.html?p=25-authentication-custom-user) (password hashing).

A web application is a program that executes instructions from strangers. Every request carries attacker-controlled data — URL, headers, cookies, body — and every place that data is *interpreted* is an injection point: HTML (XSS), SQL (injection), the browser's ambient credentials (CSRF), frames (clickjacking), the `Host` header (cache and password-reset poisoning), redirects (open redirect). The naive approach — "validate inputs carefully" — fails because there are hundreds of sinks and one forgotten one is enough.

Django's philosophy is **secure by default with explicit, greppable opt-outs**:

| Attack | Django's default defence | The opt-out that reopens it |
|---|---|---|
| Cross-site request forgery | `CsrfViewMiddleware` + `{% csrf_token %}` + `SameSite=Lax` cookies | `@csrf_exempt`, removing the middleware |
| Cross-site scripting | Template autoescaping of `< > ' " &` | `|safe`, `mark_safe()`, `{% autoescape off %}`, building HTML in Python |
| SQL injection | ORM parameterizes every value | f-strings in `raw()`, `extra()`, `RawSQL`, `cursor.execute()` |
| Clickjacking | `XFrameOptionsMiddleware`, `X_FRAME_OPTIONS = "DENY"` | `@xframe_options_exempt` |
| Host header attacks | `ALLOWED_HOSTS` checked by `request.get_host()` | `ALLOWED_HOSTS = ["*"]` |
| Session theft over HTTP | `SecurityMiddleware` + `Secure`/HSTS settings | Off by default — you must enable them |
| Information disclosure | `DEBUG = False` hides tracebacks | Shipping `DEBUG = True` |

Notice the last two rows: some protections are *off* by default because they depend on your deployment (HTTPS, proxy). That is what `python manage.py check --deploy` is for.

This chapter explains how each defence works *internally* — what `CsrfViewMiddleware.process_view` actually compares, why autoescaping does not protect `<script>` blocks or `href="javascript:..."`, which ORM APIs are injection-safe — and the production hardening list interviewers expect: `SECRET_KEY` handling, HTTPS/HSTS, CSP, uploads, admin hardening and the holes developers open by accident.

## 2. Core Concepts

- **CSRF (cross-site request forgery)** — a malicious site makes the victim's browser send an authenticated request to your site using its cookies. *Why it matters:* any cookie-authenticated, state-changing endpoint is a target.
- **CSRF token** — a secret in the `csrftoken` cookie plus a *masked* copy in the form (`csrfmiddlewaretoken`) or the `X-CSRFToken` header; the middleware unmasks and compares. *Why:* a cross-site attacker cannot read your cookie or page, so cannot produce the matching value.
- **Origin / Referer checking** — for unsafe requests Django checks `Origin` (and, on HTTPS, `Referer` when `Origin` is absent) against the host and `CSRF_TRUSTED_ORIGINS`. *Why:* defence in depth; also why reverse-proxy and subdomain setups fail with 403.
- **XSS (cross-site scripting)** — attacker-controlled data rendered as active HTML/JS in your origin. *Why:* runs with the victim's session; can do anything the user can.
- **Autoescaping** — templates HTML-escape every variable unless marked safe. *Why:* converts the default from "vulnerable" to "safe"; context-insensitive, so it has gaps.
- **`SafeString` / `mark_safe`** — a string subclass that tells the template engine "already escaped". *Why:* the opt-out; every use is an audit point.
- **SQL injection** — user data interpreted as SQL syntax. *Why:* full data exfiltration or destruction.
- **Parameterization** — sending SQL and values separately to the driver (`%s` placeholders). *Why:* values can never become syntax.
- **Clickjacking** — your page framed invisibly under a decoy so clicks land on your buttons. *Why:* bypasses CSRF because the real user really clicks.
- **Host header poisoning** — a forged `Host` used to build absolute URLs (password-reset links, cache keys). *Why:* reset emails pointing to the attacker's domain leak tokens.
- **`SECRET_KEY`** — HMAC key for sessions' auth hash, signed cookies, messages, password-reset tokens. *Why:* leaking it lets attackers forge all of those.
- **HSTS** — `Strict-Transport-Security` tells browsers to use HTTPS only for a period. *Why:* stops SSL-stripping on first plain-HTTP request.
- **CSP (Content Security Policy)** — a header whitelisting script/style/frame sources. *Why:* the best mitigation when an XSS slips through; via django-csp on 5.2 (built into Django 6.0).

## 3. Theory & Principles

### How CSRF protection works inside Django

`django.middleware.csrf.CsrfViewMiddleware` participates in two phases.

**When a token is needed** (a template uses `{% csrf_token %}` or code calls `get_token(request)`), Django ensures a **secret** exists for the client and returns a **masked token**: the secret combined with a fresh random mask, so the value in the HTML changes on every render. Masking is the defence against BREACH-style compression attacks, which can recover a constant secret from compressed HTTPS responses. In the response phase the middleware sets the `csrftoken` cookie (or stores the secret in the session when `CSRF_USE_SESSIONS = True`).

**When a request arrives**, `process_view` runs after URL resolution, just before the view:

1. If the view is marked `csrf_exempt`, or the method is safe (`GET`, `HEAD`, `OPTIONS`, `TRACE`), accept. Safe methods must therefore never change state.
2. If an `Origin` header is present, it must match the request's own origin or one in `CSRF_TRUSTED_ORIGINS` (which must include the scheme since Django 4.0, e.g. `https://app.example.com`); otherwise reject.
3. If the request is HTTPS and there is no `Origin`, a `Referer` is required and must be same-origin or trusted (blocks a man-in-the-middle on HTTP from forging HTTPS posts).
4. Read the secret from the cookie (or session). Missing: reject ("CSRF cookie not set").
5. Read the submitted token from `request.POST["csrfmiddlewaretoken"]` or the `X-CSRFToken` header (`CSRF_HEADER_NAME`). Unmask it and compare to the secret with a **constant-time** comparison. Mismatch: reject.
6. Rejection calls `CSRF_FAILURE_VIEW`, a 403 page whose DEBUG version names the exact reason.

```svg
<svg viewBox="0 0 880 450" width="100%" height="450" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj28a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
    <marker id="dj28b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">CsrfViewMiddleware.process_view decision path</text>
  <rect x="30" y="44" width="250" height="40" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="155" y="68" text-anchor="middle" fill="#1e293b" font-weight="bold">POST /transfer (cookie auth)</text>
  <path d="M155,84 L155,104" stroke="#334155" stroke-width="2" marker-end="url(#dj28a)"/>
  <rect x="30" y="106" width="250" height="40" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="155" y="124" text-anchor="middle" fill="#1e293b">csrf_exempt view or safe method?</text>
  <text x="155" y="139" text-anchor="middle" fill="#334155" font-size="10">GET HEAD OPTIONS TRACE</text>
  <path d="M155,146 L155,166" stroke="#334155" stroke-width="2" marker-end="url(#dj28a)"/>
  <text x="166" y="160" fill="#334155" font-size="10">no</text>
  <rect x="30" y="168" width="250" height="40" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="155" y="186" text-anchor="middle" fill="#1e293b">Origin header present?</text>
  <text x="155" y="201" text-anchor="middle" fill="#334155" font-size="10">must equal own origin or CSRF_TRUSTED_ORIGINS</text>
  <path d="M155,208 L155,228" stroke="#334155" stroke-width="2" marker-end="url(#dj28a)"/>
  <rect x="30" y="230" width="250" height="40" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="155" y="248" text-anchor="middle" fill="#1e293b">HTTPS and no Origin?</text>
  <text x="155" y="263" text-anchor="middle" fill="#334155" font-size="10">Referer required, same-origin or trusted</text>
  <path d="M155,270 L155,290" stroke="#334155" stroke-width="2" marker-end="url(#dj28a)"/>
  <rect x="30" y="292" width="250" height="40" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="155" y="310" text-anchor="middle" fill="#1e293b">secret from csrftoken cookie</text>
  <text x="155" y="325" text-anchor="middle" fill="#334155" font-size="10">(or session if CSRF_USE_SESSIONS)</text>
  <path d="M155,332 L155,352" stroke="#334155" stroke-width="2" marker-end="url(#dj28a)"/>
  <rect x="30" y="354" width="250" height="44" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="155" y="372" text-anchor="middle" fill="#1e293b">unmask POST token or X-CSRFToken</text>
  <text x="155" y="388" text-anchor="middle" fill="#334155" font-size="10">constant_time_compare(secret, unmasked)</text>
  <path d="M280,126 L400,126" stroke="#16a34a" stroke-width="2" marker-end="url(#dj28a)"/>
  <text x="340" y="118" text-anchor="middle" fill="#16a34a" font-size="10">yes</text>
  <rect x="402" y="106" width="200" height="40" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="502" y="130" text-anchor="middle" fill="#1e293b">accept: call the view</text>
  <path d="M280,376 L400,376" stroke="#16a34a" stroke-width="2" marker-end="url(#dj28a)"/>
  <text x="340" y="368" text-anchor="middle" fill="#16a34a" font-size="10">match</text>
  <rect x="402" y="356" width="200" height="40" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="502" y="380" text-anchor="middle" fill="#1e293b">accept: call the view</text>
  <path d="M280,188 L640,188" stroke="#dc2626" stroke-width="2" marker-end="url(#dj28b)"/>
  <path d="M280,250 L640,250" stroke="#dc2626" stroke-width="2" marker-end="url(#dj28b)"/>
  <path d="M280,312 L640,312" stroke="#dc2626" stroke-width="2" marker-end="url(#dj28b)"/>
  <text x="460" y="182" text-anchor="middle" fill="#dc2626" font-size="10">untrusted Origin</text>
  <text x="460" y="244" text-anchor="middle" fill="#dc2626" font-size="10">missing or bad Referer</text>
  <text x="460" y="306" text-anchor="middle" fill="#dc2626" font-size="10">CSRF cookie not set</text>
  <rect x="642" y="168" width="218" height="164" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="751" y="194" text-anchor="middle" fill="#1e293b" font-weight="bold">reject</text>
  <text x="656" y="218" fill="#334155" font-size="10">CSRF_FAILURE_VIEW</text>
  <text x="656" y="236" fill="#334155" font-size="10">403 Forbidden</text>
  <text x="656" y="254" fill="#334155" font-size="10">DEBUG page states reason</text>
  <text x="656" y="290" fill="#334155" font-size="10">attacker site cannot read</text>
  <text x="656" y="306" fill="#334155" font-size="10">your cookie or page, so it</text>
  <text x="656" y="322" fill="#334155" font-size="10">cannot forge the token</text>
  <path d="M600,380 L750,380 L750,334" stroke="#dc2626" stroke-width="2" stroke-dasharray="4 3" marker-end="url(#dj28b)"/>
  <text x="680" y="400" text-anchor="middle" fill="#dc2626" font-size="10">mismatch</text>
  <text x="440" y="436" text-anchor="middle" fill="#334155" font-size="10">SameSite=Lax session cookies add a second, browser-side layer; tokens remain the primary defence.</text>
</svg>
```

### How autoescaping works — and where it stops

When the template engine renders `{{ comment.body }}`, it calls `conditional_escape(value)`: if the value is a `SafeData` instance it is output as-is; otherwise `<`, `>`, `&`, `'`, `"` become entities. Filters are marked `is_safe` or `needs_autoescape` so the engine knows whether their output stays safe. In Python, `django.utils.html.format_html()` is the safe way to build HTML: it escapes every argument and marks the result safe.

Autoescaping is **HTML-body escaping**. It does not understand context:

- **Inside `<script>`**: `var name = "{{ name }}";` — escaping quotes helps, but `</script>` breaking and JS string rules make this fragile. Use `{{ data|json_script:"data-id" }}` and `JSON.parse(document.getElementById("data-id").textContent)`.
- **Unquoted attributes**: `<div class={{ cls }}>` — a space plus `onmouseover=...` injects an attribute without needing any escaped character. Always quote attributes.
- **URL attributes**: `<a href="{{ user.website }}">` — `javascript:alert(1)` contains nothing to escape. Validate the scheme (`URLField` with `URLValidator` restricts to http/https/ftp/ftps by default) on input.
- **Markdown or rich text**: rendering user HTML requires a sanitizer such as `nh3` (or bleach, now deprecated) with an allowlist, then `mark_safe` on the sanitized output only.

### How the ORM prevents SQL injection

A QuerySet compiles to SQL via `SQLCompiler.as_sql()`, which returns `(sql_string, params)` with `%s` placeholders. The database driver (psycopg) sends parameters separately or quotes them safely; a value can never become syntax. `filter(name=user_input)`, `raw("... WHERE id = %s", [user_input])`, `cursor.execute(sql, params)` and `RawSQL("...", params)` are all parameterized. What parameterization *cannot* cover is **identifiers** — column names, table names, `ORDER BY` directions — so those must come from an allowlist, never from the user.

## 4. Architecture & Workflow

Security in a Django deployment is layered from the edge inward. The diagram maps each threat to the component that stops it and the configuration it depends on.

```svg
<svg viewBox="0 0 880 440" width="100%" height="440" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj28c" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Defence layers from the edge to the database</text>
  <rect x="20" y="40" width="130" height="380" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="85" y="62" text-anchor="middle" fill="#1e293b" font-weight="bold">Browser</text>
  <text x="32" y="86" fill="#334155" font-size="10">honours HSTS,</text>
  <text x="32" y="100" fill="#334155" font-size="10">SameSite, CSP,</text>
  <text x="32" y="114" fill="#334155" font-size="10">X-Frame-Options,</text>
  <text x="32" y="128" fill="#334155" font-size="10">nosniff, COOP</text>
  <path d="M150,230 L176,230" stroke="#2563eb" stroke-width="2" marker-end="url(#dj28c)"/>
  <rect x="178" y="40" width="150" height="380" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="253" y="62" text-anchor="middle" fill="#1e293b" font-weight="bold">Proxy / LB</text>
  <text x="190" y="86" fill="#334155" font-size="10">TLS termination</text>
  <text x="190" y="100" fill="#334155" font-size="10">sets X-Forwarded-Proto</text>
  <text x="190" y="114" fill="#334155" font-size="10">rejects unknown Host</text>
  <text x="190" y="128" fill="#334155" font-size="10">body size limits</text>
  <text x="190" y="142" fill="#334155" font-size="10">WAF, rate limits</text>
  <path d="M328,230 L354,230" stroke="#2563eb" stroke-width="2" marker-end="url(#dj28c)"/>
  <rect x="356" y="40" width="250" height="380" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="481" y="62" text-anchor="middle" fill="#1e293b" font-weight="bold">Django middleware</text>
  <rect x="368" y="74" width="226" height="56" rx="6" fill="#ffffff" stroke="#16a34a"/>
  <text x="378" y="92" fill="#1e293b" font-size="10" font-weight="bold">SecurityMiddleware (first)</text>
  <text x="378" y="106" fill="#334155" font-size="10">SSL redirect, HSTS, nosniff,</text>
  <text x="378" y="120" fill="#334155" font-size="10">Referrer-Policy, COOP</text>
  <rect x="368" y="138" width="226" height="40" rx="6" fill="#ffffff" stroke="#16a34a"/>
  <text x="378" y="156" fill="#1e293b" font-size="10" font-weight="bold">CommonMiddleware / get_host()</text>
  <text x="378" y="170" fill="#334155" font-size="10">ALLOWED_HOSTS: 400 on bad Host</text>
  <rect x="368" y="186" width="226" height="40" rx="6" fill="#ffffff" stroke="#16a34a"/>
  <text x="378" y="204" fill="#1e293b" font-size="10" font-weight="bold">CsrfViewMiddleware</text>
  <text x="378" y="218" fill="#334155" font-size="10">Origin/Referer + token</text>
  <rect x="368" y="234" width="226" height="40" rx="6" fill="#ffffff" stroke="#16a34a"/>
  <text x="378" y="252" fill="#1e293b" font-size="10" font-weight="bold">XFrameOptionsMiddleware</text>
  <text x="378" y="266" fill="#334155" font-size="10">X-Frame-Options: DENY</text>
  <rect x="368" y="282" width="226" height="40" rx="6" fill="#ffffff" stroke="#16a34a"/>
  <text x="378" y="300" fill="#1e293b" font-size="10" font-weight="bold">django-csp (5.2) / built-in (6.0)</text>
  <text x="378" y="314" fill="#334155" font-size="10">Content-Security-Policy</text>
  <text x="368" y="350" fill="#334155" font-size="10">order: Security, Session, Common,</text>
  <text x="368" y="364" fill="#334155" font-size="10">Csrf, Auth, Messages, XFrame</text>
  <path d="M606,230 L632,230" stroke="#2563eb" stroke-width="2" marker-end="url(#dj28c)"/>
  <rect x="634" y="40" width="226" height="180" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="747" y="62" text-anchor="middle" fill="#1e293b" font-weight="bold">View + template</text>
  <text x="646" y="86" fill="#334155" font-size="10">forms/serializers validate</text>
  <text x="646" y="100" fill="#334155" font-size="10">explicit fields (no mass assign)</text>
  <text x="646" y="114" fill="#334155" font-size="10">authorization (Ch 26)</text>
  <text x="646" y="128" fill="#334155" font-size="10">autoescape, json_script</text>
  <text x="646" y="142" fill="#334155" font-size="10">safe redirects</text>
  <text x="646" y="170" fill="#dc2626" font-size="10">holes: |safe, mark_safe,</text>
  <text x="646" y="184" fill="#dc2626" font-size="10">csrf_exempt, fields="__all__"</text>
  <rect x="634" y="240" width="226" height="180" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="747" y="262" text-anchor="middle" fill="#1e293b" font-weight="bold">ORM / database</text>
  <text x="646" y="286" fill="#334155" font-size="10">parameterized SQL</text>
  <text x="646" y="300" fill="#334155" font-size="10">least-privilege DB role</text>
  <text x="646" y="314" fill="#334155" font-size="10">TLS to database</text>
  <text x="646" y="342" fill="#dc2626" font-size="10">holes: f-strings in raw(),</text>
  <text x="646" y="356" fill="#dc2626" font-size="10">extra(), cursor.execute,</text>
  <text x="646" y="370" fill="#dc2626" font-size="10">user-chosen identifiers,</text>
  <text x="646" y="384" fill="#dc2626" font-size="10">**user_dict into values()</text>
</svg>
```

### What `check --deploy` inspects

```bash
DJANGO_SETTINGS_MODULE=config.settings.production python manage.py check --deploy --fail-level WARNING
```

```text
System check identified some issues:

WARNINGS:
?: (security.W004) You have not set a value for the SECURE_HSTS_SECONDS setting. ...
?: (security.W008) Your SECURE_SSL_REDIRECT setting is not set to True. ...
?: (security.W009) Your SECRET_KEY has less than 50 characters, less than 5 unique characters, or it's prefixed with 'django-insecure' ...
?: (security.W012) SESSION_COOKIE_SECURE is not set to True. ...
?: (security.W016) You have 'django.middleware.csrf.CsrfViewMiddleware' in your MIDDLEWARE, but you have not set CSRF_COOKIE_SECURE to True. ...
?: (security.W018) You should not have DEBUG set to True in deployment.
```

Run it in CI against the production settings module with `--fail-level WARNING` so a regression fails the build.

## 5. Implementation

### Simple example: the safe and unsafe versions of each sink

**CSRF in a form and in fetch:**

```html
<form method="post" action="{% url 'transfer' %}">
  {% csrf_token %}
  <input name="amount"><button>Send</button>
</form>

{{ config|json_script:"page-config" }}
<script>
  function getCookie(name) {
    return document.cookie.split("; ").find(r => r.startsWith(name + "="))?.split("=")[1];
  }
  fetch("/api/transfer/", {
    method: "POST",
    headers: {"X-CSRFToken": getCookie("csrftoken"), "Content-Type": "application/json"},
    credentials: "same-origin",
    body: JSON.stringify({amount: 10}),
  });
</script>
```

For a SPA that never renders a Django form, decorate the page view (or a `/csrf/` endpoint) with `@ensure_csrf_cookie` so the cookie is set.

**XSS — building HTML in Python:**

```python
from django.utils.html import format_html, format_html_join
from django.utils.safestring import mark_safe

# Vulnerable: the name is inserted raw and then trusted
def badge_bad(user):
    return mark_safe(f'<span class="badge">{user.display_name}</span>')

# Safe: format_html escapes arguments and marks the whole result safe
def badge(user):
    return format_html('<span class="badge">{}</span>', user.display_name)

def tag_list(tags):
    return format_html_join(", ", '<a href="/t/{}/">{}</a>', ((t.slug, t.name) for t in tags))
```

**SQL — the parameterized and the injectable:**

```python
from django.db import connection
from django.db.models.expressions import RawSQL

# Injectable: q = "x' OR '1'='1"
Product.objects.raw(f"SELECT * FROM shop_product WHERE name = '{q}'")

# Safe: params are sent separately
Product.objects.raw("SELECT * FROM shop_product WHERE name = %s", [q])
with connection.cursor() as cur:
    cur.execute("UPDATE shop_product SET views = views + 1 WHERE id = %s", [pid])
Product.objects.annotate(score=RawSQL("similarity(name, %s)", (q,)))

# Note: do NOT quote placeholders yourself: "WHERE name = '%s'" breaks parameterization
```

The ORM's own SQL shows the separation:

```python
>>> qs = Product.objects.filter(name="x' OR '1'='1")
>>> qs.query.sql_with_params()
('SELECT "shop_product"."id", "shop_product"."name" FROM "shop_product" WHERE "shop_product"."name" = %s',
 ("x' OR '1'='1",))
```

**Identifiers from an allowlist:**

```python
SORTABLE = {"price": "price", "-price": "-price", "new": "-created_at"}

def product_list(request):
    order = SORTABLE.get(request.GET.get("sort"), "-created_at")
    return render(request, "shop/list.html", {"products": Product.objects.order_by(order)})
```

`order_by(user_input)` will not inject SQL (unknown names raise `FieldError`), but without an allowlist a user can order by `password` or `supplier__cost_price` and infer hidden values by observing order — an information leak.

**Clickjacking:**

```python
from django.views.decorators.clickjacking import xframe_options_sameorigin

@xframe_options_sameorigin          # allow our own pages to embed this widget only
def embeddable_chart(request): ...
```

### Real-world example: a production security settings module

```python
# config/settings/production.py
import os
from .base import *  # noqa

DEBUG = False
SECRET_KEY = os.environ["DJANGO_SECRET_KEY"]                       # never in git
SECRET_KEY_FALLBACKS = [k for k in os.environ.get("DJANGO_OLD_SECRET_KEYS", "").split(",") if k]

ALLOWED_HOSTS = ["app.example.com", "api.example.com"]
CSRF_TRUSTED_ORIGINS = ["https://app.example.com", "https://admin.example.com"]

# TLS terminates at the load balancer, which sets X-Forwarded-Proto.
# Only safe if the proxy strips client-supplied X-Forwarded-Proto.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_SSL_REDIRECT = True
SECURE_REDIRECT_EXEMPT = [r"^healthz$"]                          # LB health check over HTTP

SECURE_HSTS_SECONDS = 60 * 60 * 24 * 365      # start with 300, raise after verifying
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_HSTS_PRELOAD = True

SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SESSION_COOKIE_SAMESITE = "Lax"
SECURE_CONTENT_TYPE_NOSNIFF = True            # default True
SECURE_REFERRER_POLICY = "strict-origin-when-cross-origin"
SECURE_CROSS_ORIGIN_OPENER_POLICY = "same-origin"
X_FRAME_OPTIONS = "DENY"                      # default since 3.0

DATA_UPLOAD_MAX_MEMORY_SIZE = 5 * 1024 * 1024
FILE_UPLOAD_PERMISSIONS = 0o640

PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.Argon2PasswordHasher",          # pip install argon2-cffi
    "django.contrib.auth.hashers.PBKDF2PasswordHasher",          # verifies existing hashes, upgraded on login
]

MIDDLEWARE.insert(1, "csp.middleware.CSPMiddleware")              # django-csp

# django-csp 4.x dict-style configuration
CONTENT_SECURITY_POLICY = {
    "DIRECTIVES": {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'"],
        "img-src": ["'self'", "data:", "https://cdn.example.com"],
        "frame-ancestors": ["'none'"],
        "form-action": ["'self'"],
    }
}

LOGGING["loggers"]["django.security"] = {"handlers": ["console"], "level": "WARNING", "propagate": False}
```

Hiding secrets from error reports and logs:

```python
from django.views.decorators.debug import sensitive_post_parameters, sensitive_variables

@sensitive_variables("card_number", "cvv")
@sensitive_post_parameters("card_number", "cvv", "password")
def checkout(request):
    card_number = request.POST["card_number"]
    ...
```

Safe redirects after login (open-redirect defence):

```python
from django.utils.http import url_has_allowed_host_and_scheme

def post_login_redirect(request):
    nxt = request.POST.get("next", "/")
    if not url_has_allowed_host_and_scheme(nxt, allowed_hosts={request.get_host()},
                                           require_https=request.is_secure()):
        nxt = "/"
    return redirect(nxt)
```

Mass assignment — explicit fields only:

```python
# Vulnerable: a user can POST is_staff=on or balance=1000000
class ProfileForm(forms.ModelForm):
    class Meta:
        model = User
        fields = "__all__"

# Safe
class ProfileForm(forms.ModelForm):
    class Meta:
        model = User
        fields = ["first_name", "last_name", "email"]
```

User-generated rich text, sanitized before `mark_safe`:

```python
import nh3   # pip install nh3
ALLOWED = {"p", "b", "i", "em", "strong", "a", "ul", "ol", "li", "code", "pre"}

def clean_html(dirty: str) -> str:
    return nh3.clean(dirty, tags=ALLOWED, attributes={"a": {"href"}}, url_schemes={"http", "https", "mailto"})
```

Admin hardening: move it off `/admin/`, require 2FA (django-otp), rate-limit login attempts (django-axes), and restrict by IP at the proxy if you can.

```python
# urls.py
urlpatterns = [path(os.environ.get("ADMIN_URL", "control-7f3a/"), admin.site.urls), ...]
```

## 6. Advantages, Disadvantages & Trade-offs

| Defence | Cost | Gaps | Alternative / complement |
|---|---|---|---|
| CSRF tokens | Token plumbing for AJAX, 403 debugging behind proxies | Useless if XSS exists (script reads the token) | SameSite cookies; token auth for non-browser clients |
| SameSite=Lax | None | Same-site subdomains can still attack; GET state changes | Keep tokens; never change state on GET |
| Autoescaping | Occasional `|safe` temptation | Context-insensitive: JS, URLs, unquoted attributes | `json_script`, `format_html`, CSP |
| ORM parameterization | None | Raw SQL, identifiers | Allowlists, least-privilege DB user |
| X-Frame-Options DENY | Breaks legit embeds | Legacy header | CSP `frame-ancestors` |
| HSTS + preload | Hard to undo; all subdomains must support HTTPS | First visit before preload | Start with short max-age |
| CSP | Inline scripts must be refactored or nonce'd | Misconfigured `unsafe-inline` nullifies it | Report-only mode first |

### When to use

- Always: default middleware, `check --deploy` in CI, explicit form fields, `ALLOWED_HOSTS`, HTTPS settings.
- CSP in report-only mode on day one of a new app (cheap) and enforce once violations are understood.
- `CSRF_USE_SESSIONS = True` when you must not have a JS-readable CSRF cookie (strict compliance), accepting that the token must be rendered into pages.
- HSTS preload only when every subdomain is permanently HTTPS.

### When NOT to use

- Do not `@csrf_exempt` an endpoint to "fix" a 403 — find which check failed (DEBUG page or `django.security.csrf` log). Webhooks from third parties are the legitimate exemption, and they must be authenticated by a signature instead.
- Do not set `SECURE_PROXY_SSL_HEADER` unless your proxy always sets/overwrites that header; otherwise clients can claim HTTPS.
- Do not enable long HSTS before confirming HTTPS works everywhere — browsers will refuse HTTP for the whole max-age.

## 7. Common Mistakes & Best Practices

**1. `DEBUG = True` in production.** The technical 500 page shows settings (Django masks names containing KEY, SECRET, PASS, TOKEN, API, SIGNATURE, but not your custom names like `DATABASE_URL`), local variables, SQL and paths. Bots scan for it. Load `DEBUG` from the environment with a default of `False`.

**2. `ALLOWED_HOSTS = ["*"]`.** Enables Host-header poisoning: `PasswordResetView` builds the reset link from `request.get_host()`, so a forged `Host: evil.com` sends the victim a link to evil.com containing a valid token. List exact hosts; reject unknown hosts at the proxy too.

**3. `|safe` on user data.** Usually added to render line breaks or links. Use `|linebreaks` / `|urlize` (which escape), or sanitize and then mark safe.

**4. Variables inside `<script>`.**

```html
<!-- Before: XSS if title contains </script> or quotes in some contexts -->
<script>const title = "{{ article.title }}";</script>
<!-- After -->
{{ article.title|json_script:"title" }}
<script>const title = JSON.parse(document.getElementById("title").textContent);</script>
```

**5. Changing state on GET.** `GET /logout/` or `GET /delete/42/` bypasses CSRF (safe methods skip the check) and SameSite=Lax allows top-level GET navigations, so an `<img src>` or link triggers it. Since Django 5.0, `LogoutView` only accepts POST for this reason.

**6. Committing `SECRET_KEY`.** Anyone with the repo can forge password-reset tokens, signed cookies and messages. If it leaked: rotate immediately (old key into `SECRET_KEY_FALLBACKS` only if you are sure it was not exposed to attackers; otherwise accept the logout), and consider every signed artifact compromised.

**7. Serving user uploads from your main origin.** An uploaded `.html` or SVG with script served from `app.example.com/media/` is stored XSS. Serve media from a separate domain (S3/CDN bucket on another origin), set `Content-Disposition: attachment` for downloads, validate file types by content, not extension.

**8. Splatting user dicts into ORM kwargs.** `Model.objects.values(**request.GET.dict())` or `annotate(**user_dict)` lets users choose aliases and lookups. Several Django CVEs (2022 and 2024) were SQL injection through user-controlled column aliases or JSON keys in exactly these APIs. Never pass user-controlled keys as kwargs, and stay on a patched release.

**Best practices:** keep Django on the latest patch of an LTS (security releases are announced in advance on the django-announce list); `pip-audit` or Dependabot in CI; run `bandit` for Python sinks; one security review checklist per PR touching auth, templates with `safe`, raw SQL or exemptions; grep-able opt-outs mean you can audit them: `grep -rn "csrf_exempt\|mark_safe\||safe\|raw(\|extra(\|cursor.execute" .`.

## 8. Production: Pitfalls, Debugging & Scaling

**Production story — 403 CSRF verification failed after moving behind a load balancer.** *Symptom:* every login POST fails with "Origin checking failed - https://app.example.com does not match any trusted origins." *Root cause:* TLS terminated at the LB, Django saw `http://` and computed its own origin as `http://app.example.com`, which does not equal the browser's `https://` Origin. *Fix:* `SECURE_PROXY_SSL_HEADER` with a proxy that sets `X-Forwarded-Proto`, and `USE_X_FORWARDED_HOST` only if the proxy controls that header. For cross-subdomain posts (admin on another subdomain), add the exact origin with scheme to `CSRF_TRUSTED_ORIGINS`.

**Production story — "Invalid HTTP_HOST header" floods.** Sentry fills with `DisallowedHost` errors from scanners hitting the IP directly. *Fix:* reject unknown Host headers at Nginx (`server_name _; return 444;` default server) and silence the `django.security.DisallowedHost` logger rather than allowing `*`.

**Stored XSS via the admin.** A staff-editable "announcement banner" rendered with `|safe` because marketing wanted bold text. A compromised low-privilege staff account then injected script that ran in every superuser's browser. *Fix:* sanitize with an allowlist on save, CSP that forbids inline script, and treat staff input as untrusted.

**HSTS lockout.** A team enabled `SECURE_HSTS_SECONDS = 31536000` with `INCLUDE_SUBDOMAINS` while an internal HTTP-only subdomain existed; browsers refused it for a year. *Fix:* ramp HSTS (300 s, then a day, a week, a month) and inventory subdomains first.

**Debugging tools.**

- The DEBUG CSRF failure page states the exact reason; in production log `django.security.csrf` at WARNING.
- `curl -I https://app.example.com/` to verify headers: `Strict-Transport-Security`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Cross-Origin-Opener-Policy`, `Content-Security-Policy`.
- Mozilla Observatory or securityheaders.com for an external header scan.
- `python manage.py check --deploy` in CI; `pip-audit` for known CVEs in dependencies.
- Brute force: django-axes logs and locks out; also rate limit at the edge.

**Scaling security.** At scale, push generic defences to the edge (WAF, rate limits, bot detection, Host filtering at the CDN) so Django workers spend time on real traffic, but keep application-level defences (CSRF, escaping, authorization) in Django because only the app understands the semantics. Secrets go into a secret manager injected as environment variables, rotated on a schedule with `SECRET_KEY_FALLBACKS`. Database credentials should be a least-privilege role without DDL rights for the web process; migrations run with a separate role.

## 9. Interview Questions

**Q: How does Django prevent CSRF attacks?**
A: `CsrfViewMiddleware` requires every unsafe request (POST, PUT, PATCH, DELETE) to carry a token that matches a secret stored in the `csrftoken` cookie (or the session). Templates insert a masked copy with `{% csrf_token %}`; JavaScript sends it in the `X-CSRFToken` header. A malicious site can make the browser send your cookies but cannot read your cookie or page, so it cannot produce the token. On HTTPS Django also checks `Origin`/`Referer` against the host and `CSRF_TRUSTED_ORIGINS`. SameSite=Lax session cookies add a browser-side layer.

**Q: Why is the CSRF token in the form different on every page load?**
A: The cookie holds a constant secret, but the token rendered into HTML is the secret combined with a random mask, regenerated each time. The middleware unmasks it before comparing. This defeats BREACH-style attacks, which recover a repeated secret from the size of compressed HTTPS responses; a value that changes every render leaks nothing useful.

**Q: Does a DRF API need CSRF protection?**
A: Only if it authenticates with cookies. DRF's `SessionAuthentication` enforces CSRF for authenticated requests (it runs Django's check explicitly, because `APIView` is `csrf_exempt` by default). `TokenAuthentication` and JWT in an `Authorization` header do not need CSRF, because a cross-site attacker cannot make the browser attach that header. If you store a JWT in a cookie, you are back to needing CSRF protection.

**Q: How does Django prevent XSS, and where does autoescaping fail?**
A: The template engine HTML-escapes `< > & ' "` in every variable unless it is a `SafeString`. It fails when you opt out (`|safe`, `mark_safe`, `autoescape off`), and in contexts where HTML escaping is the wrong encoding: inside `<script>` blocks, in unquoted attributes, and in URL attributes where `javascript:` URLs contain nothing to escape. Use `json_script` for data to JavaScript, always quote attributes, validate URL schemes, sanitize rich text with an allowlist, and add CSP as a backstop.

**Q: How does the Django ORM prevent SQL injection, and when can you still be vulnerable?**
A: The compiler produces SQL with `%s` placeholders and a separate parameter list, and the driver transmits values without letting them become syntax. You are vulnerable when you build SQL with string formatting in `raw()`, `extra()`, `RawSQL` or `cursor.execute()`, when you quote a placeholder yourself (`'%s'`), and when user input chooses identifiers like column names or sort fields, which cannot be parameterized. Use params everywhere and allowlists for identifiers.

**Q: What is clickjacking and how does Django defend against it?**
A: The attacker loads your page in a transparent iframe over a decoy and tricks the user into clicking your real buttons; CSRF tokens do not help because the real page submits the real form. `XFrameOptionsMiddleware` sends `X-Frame-Options: DENY` by default (since Django 3.0), so browsers refuse to frame the page. `@xframe_options_sameorigin` and `@xframe_options_exempt` relax it per view. The modern equivalent is CSP `frame-ancestors`.

**Q: What does `ALLOWED_HOSTS` protect against?**
A: Host header attacks. Django uses `request.get_host()` to build absolute URLs, for example in password-reset emails and redirects; if any Host is accepted, an attacker can request a reset for a victim with `Host: evil.com`, and the email contains a valid token linking to the attacker's domain. With `DEBUG=False`, Django returns 400 for hosts not in `ALLOWED_HOSTS`. It also protects caches keyed by host from poisoning.

**Q: What does `python manage.py check --deploy` do?**
A: It runs the system checks tagged for deployment against the current settings: `DEBUG`, `SECRET_KEY` strength, `ALLOWED_HOSTS`, `SECURE_SSL_REDIRECT`, HSTS settings, `SESSION_COOKIE_SECURE`, `CSRF_COOKIE_SECURE`, missing security middleware, `X_FRAME_OPTIONS` and so on, and prints warnings with ids like `security.W004`. Run it against the production settings module in CI with `--fail-level WARNING`. It does not scan your code for `mark_safe` or raw SQL; it only checks configuration.

**Q: What is `SECRET_KEY` used for, and what happens if it leaks?**
A: It is the HMAC key for Django's cryptographic signing: the session auth hash, signed-cookie sessions, the messages cookie, `signing.dumps`, password-reset tokens and anything using `Signer`. It is not used to hash passwords. If it leaks, attackers can forge password-reset tokens for any user, forge signed cookies and messages, and with the signed-cookie session engine, forge whole sessions. Rotate it, revoke sessions, and treat signed data issued before the leak as untrusted.

**Q: What HTTPS-related settings must you set in production?**
A: `SECURE_SSL_REDIRECT = True`, `SESSION_COOKIE_SECURE = True`, `CSRF_COOKIE_SECURE = True`, `SECURE_HSTS_SECONDS` (ramped up), optionally `SECURE_HSTS_INCLUDE_SUBDOMAINS` and `SECURE_HSTS_PRELOAD`, and `SECURE_PROXY_SSL_HEADER` if TLS terminates at a proxy that sets `X-Forwarded-Proto`. `SecurityMiddleware` must be first so the redirect happens before any other work. Without the proxy header setting, Django thinks requests are HTTP, which causes redirect loops and CSRF origin failures.

**Q: You inherit a Django codebase. How do you audit its security? (Senior)**
A: Start with configuration: `check --deploy` against production settings, Django and dependency versions against advisories (`pip-audit`), and where `SECRET_KEY` and credentials live. Then grep the explicit opt-outs, because Django makes them greppable: `csrf_exempt`, `mark_safe`, `|safe`, `autoescape off`, `raw(`, `extra(`, `RawSQL`, `cursor.execute`, `fields = "__all__"`, `xframe_options_exempt`, `ALLOWED_HOSTS`. Review authorization next — querysets not scoped by owner or tenant are the most common real bug (IDOR). Check file upload handling and where media is served, redirects using `next`, and admin exposure (URL, 2FA, rate limiting). Finally scan response headers externally and add CSP in report-only mode to see what an XSS would be able to do.

**Q: How would you deploy CSP on a large existing Django app without breaking it? (Senior)**
A: Install django-csp on 5.2 (Django 6.0 has built-in CSP support) and ship the policy in `Content-Security-Policy-Report-Only` mode with a `report-uri`/`report-to` endpoint so browsers report violations without blocking. Inventory violations by directive and source, move inline scripts to static files or add per-request nonces (django-csp exposes `request.csp_nonce` for templates), and replace inline event handlers. Tighten progressively — `frame-ancestors` and `object-src 'none'` first, then `script-src` — and only switch to enforcing mode when reports are quiet. Avoid `'unsafe-inline'` in `script-src`, which defeats most of CSP's XSS protection.

**Q: How do you handle third-party webhooks that cannot send a CSRF token? (Senior)**
A: Exempting the view from CSRF is correct here, because webhooks are not browser requests and carry no user cookies; but you must replace CSRF with real authentication. Verify the provider's HMAC signature over the raw body with `hmac.compare_digest`, check the timestamp to reject replays outside a window, optionally restrict source IPs, and make processing idempotent on the event id because providers retry. In DRF, use an `APIView` with no `SessionAuthentication` and a custom authentication class that verifies the signature, so the endpoint is never cookie-authenticated.

**Q: How does Django protect against brute-force login and password attacks?**
A: Password storage is strong: PBKDF2-SHA256 by default with a high iteration count, or Argon2 if configured, with per-password salts and hashes upgraded on login. Password validators (`AUTH_PASSWORD_VALIDATORS`) reject common, numeric, short and user-similar passwords. Django does not rate-limit login attempts itself; add django-axes or edge rate limiting, and 2FA for staff. `login()` rotates the session key, and changing the password invalidates other sessions via the session auth hash.

## 10. Quick Revision & Cheat Sheet

| Threat | Default protection | Opt-out to audit | Extra hardening |
|---|---|---|---|
| CSRF | `CsrfViewMiddleware`, `{% csrf_token %}`, SameSite=Lax | `@csrf_exempt` | `CSRF_TRUSTED_ORIGINS` with scheme, POST-only state changes |
| XSS | Autoescape | `|safe`, `mark_safe`, `autoescape off` | `json_script`, `format_html`, CSP, nh3 |
| SQLi | Parameterized ORM | f-strings in `raw`/`extra`/`cursor` | Identifier allowlists, least-privilege DB role |
| Clickjacking | `X_FRAME_OPTIONS = "DENY"` | `@xframe_options_exempt` | CSP `frame-ancestors` |
| Host header | `ALLOWED_HOSTS` | `["*"]` | Reject at proxy |
| Transport | — | — | SSL redirect, HSTS, Secure cookies, proxy header |
| Disclosure | — | `DEBUG = True` | `sensitive_variables`, Sentry scrubbing |
| Mass assignment | — | `fields = "__all__"` | Explicit fields / serializer `read_only_fields` |

- Security features are mostly middleware; order starts with `SecurityMiddleware`.
- Safe methods skip CSRF, so GET must never change state.
- Autoescaping is HTML-body escaping only.
- Parameterize values; allowlist identifiers.
- `check --deploy --fail-level WARNING` in CI.
- `CSRF_TRUSTED_ORIGINS` entries need a scheme (4.0+).
- `SECRET_KEY` signs things; it does not hash passwords. Rotate with `SECRET_KEY_FALLBACKS`.
- CSP: django-csp on 5.2, built-in from 6.0; start report-only.
- Serve user uploads from another origin.

## 11. Hands-On Exercises

Set up: `python -m venv .venv && source .venv/bin/activate && pip install "django~=5.2" django-csp nh3`, `django-admin startproject site .`.

1. **Forge a CSRF.** Build a POST `/transfer/` view. Serve a separate HTML page on another port with an auto-submitting form to it. Observe the 403; add `@csrf_exempt` and watch the attack succeed with your logged-in session (note SameSite=Lax may still block it — set `SESSION_COOKIE_SAMESITE = None` with Secure on localhost HTTPS to see why both layers matter). Remove the exemption.
2. **XSS gallery.** Render a comment containing `<script>alert(1)</script>` normally and with `|safe`; then a website field `javascript:alert(1)` in an `href`; then a value inside `<script>`. Fix each with escaping, `URLValidator`, and `json_script`.
3. **SQL injection.** Write a search using `raw(f"... '{q}'")` and extract all users with a crafted `q`. Rewrite with params and show `qs.query.sql_with_params()`.
4. **Host header.** Set `ALLOWED_HOSTS = ["*"]`, trigger a password reset with `curl -H "Host: evil.test"` and the console email backend; inspect the link. Fix and confirm the 400.
5. **Deploy check.** Create a `production.py` settings module, run `check --deploy`, and drive warnings to zero. Verify headers with `curl -I`.
6. **CSP.** Add django-csp in report-only mode, add an inline script, and watch the browser console report; move it to a static file.

**Mini project — security baseline package.** Create a reusable `security_baseline` app: a production settings mixin, a CI script that runs `check --deploy`, `pip-audit`, and a grep for opt-outs that fails on any un-annotated `mark_safe`/`csrf_exempt`/raw SQL; a signed-webhook `APIView` base class with HMAC and timestamp verification; and a test suite asserting response headers and CSRF enforcement on every POST route.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** [Ch 27 · Sessions, Cookies & Messages](topic.html?p=27-sessions-cookies) · [Ch 26 · Permissions, Groups & Authorization](topic.html?p=26-permissions-authorization) · [Ch 25 · Authentication & the Custom User Model](topic.html?p=25-authentication-custom-user) · [Ch 18 · Middleware](topic.html?p=18-middleware) · [Ch 05 · Templates](topic.html?p=05-templates) · [Ch 20 · Static & Media Files](topic.html?p=20-static-media-files) · [Ch 23 · DRF Authentication, Permissions & Throttling](topic.html?p=23-drf-auth-permissions-throttling) · [Ch 35 · Deployment & Production Operations](topic.html?p=35-deployment-production)

**Other handbooks:** [REST API · TLS, CORS & Security Headers](../rest-api/topic.html?p=22-tls-cors-security-headers) · [REST API · OWASP API Security](../rest-api/topic.html?p=23-owasp-api-security) · [REST API · Validation & Input Sanitization](../rest-api/topic.html?p=17-validation-input-sanitization)

- **Security in Django** — Django docs · *Beginner* · the official overview of every built-in protection. <https://docs.djangoproject.com/en/5.2/topics/security/>
- **Cross Site Request Forgery protection** — Django docs · *Intermediate* · how the token, Origin checks and AJAX usage work. <https://docs.djangoproject.com/en/5.2/ref/csrf/>
- **Deployment checklist** — Django docs · *Beginner* · the settings `check --deploy` inspects, explained. <https://docs.djangoproject.com/en/5.2/howto/deployment/checklist/>
- **Django security releases archive** — Django docs · *Intermediate* · real CVEs and what they teach about risky APIs. <https://docs.djangoproject.com/en/dev/releases/security/>
- **OWASP Cheat Sheet Series (CSRF, XSS, SQLi)** — OWASP · *Intermediate* · framework-neutral prevention guidance. <https://cheatsheetseries.owasp.org/>
- **django-csp** — GitHub (Mozilla) · *Intermediate* · Content Security Policy middleware for Django 5.2. <https://github.com/mozilla/django-csp>
- **MDN: Content Security Policy** — MDN · *Intermediate* · directives, nonces and report-only mode. <https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP>
- **PortSwigger Web Security Academy** — PortSwigger · *Intermediate* · free hands-on labs for CSRF, XSS, SQLi and Host header attacks. <https://portswigger.net/web-security>

---

*Django Handbook — chapter 28.*
