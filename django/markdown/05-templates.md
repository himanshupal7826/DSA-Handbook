# 05 · Django Template Language

> **In one line:** The Django Template Language (DTL) is a deliberately limited, autoescaping presentation layer: templates are found by loaders, compiled once into a tree of nodes, and rendered against a context stack — so they are safe by default, fast when cached, and dangerous mainly in two places: when you switch escaping off, and when a loop quietly triggers a database query per row.

---

## 1. Overview

> **Builds on:** [Ch 04 · Views, HttpRequest & HttpResponse](topic.html?p=04-views-requests-responses) (`render()` and `TemplateResponse`) and [Ch 03 · URL Routing & URLconf](topic.html?p=03-urls-routing) (`{% url %}`).

Server-rendered HTML is still how most Django back offices, admin screens, emails, PDFs and many public sites are produced — and with HTMX-style partial rendering it is enjoying a revival. The problem templates solve is separating **presentation** from **logic**: designers and front-end developers edit markup without touching Python, the same layout is shared by hundreds of pages, and user-supplied data is inserted without opening an XSS hole.

The **naive approach** — building HTML with f-strings in views — fails on every count. Every page repeats the `<head>` and navigation. One forgotten `html.escape()` around a username lets an attacker inject `<script>`. Logic and markup interleave until nobody can change either safely.

Django's template system answers with a small set of ideas:

- **Engines and loaders** — the `TEMPLATES` setting configures one or more engines (DTL by default, Jinja2 optionally) and where templates are found (project `DIRS`, each app's `templates/`).
- **Compilation** — a template's source is tokenized and parsed once into a tree of `Node`s; the cached loader keeps compiled templates in memory.
- **Context** — rendering resolves `{{ variables }}` against a stack of dictionaries, filled by the view and by **context processors**.
- **Inheritance** — `{% extends %}` and `{% block %}` let child templates override named regions of a base layout; `{% include %}` composes fragments.
- **Filters and tags** — `{{ value|date:"Y-m-d" }}` transforms values; `{% for %}`, `{% if %}`, `{% url %}` control output; you can write your own.
- **Autoescaping** — every variable is HTML-escaped unless explicitly marked safe.

The DTL is intentionally *not* a programming language: no arbitrary Python expressions, no function calls with arguments. Interviewers probe whether you understand why (keep logic in views, make templates safe to hand to non-programmers), how inheritance and context processors work, how autoescaping protects you and where it doesn't, and how templates cause N+1 queries.

## 2. Core Concepts

- **Template engine / backend** — `django.template.backends.django.DjangoTemplates` or `django.template.backends.jinja2.Jinja2`, configured in `TEMPLATES`. *Why it matters:* `render()` and `get_template()` iterate the engines in order.
- **`DIRS` and `APP_DIRS`** — project-level template directories, and whether to look in each installed app's `templates/` folder. *Why it matters:* lookup order decides which template wins on name collisions.
- **Loader** — finds and loads template source: `filesystem.Loader` (DIRS), `app_directories.Loader` (apps), wrapped by `cached.Loader`. *Why it matters:* the cached loader avoids re-reading and re-parsing on every request.
- **Template name namespacing** — store app templates at `app/templates/app/x.html` and refer to `"app/x.html"`. *Why it matters:* otherwise two apps' `detail.html` collide and the first in `INSTALLED_APPS` silently wins.
- **`Template`, `NodeList`, `Node`** — the compiled form: `TextNode`, `VariableNode`, `IfNode`, `ForNode`, `ExtendsNode`, `BlockNode`, `IncludeNode`...
- **`Context` / `RequestContext`** — a stack of dicts used for lookup; `RequestContext` also runs context processors. `render(request, ...)` always uses the request.
- **Context processor** — a function `processor(request) -> dict` listed in `OPTIONS["context_processors"]`, merged into every `RequestContext`. Defaults include `request`, `auth` (`user`, `perms`) and `messages`.
- **Variable lookup** — `{{ a.b }}` tries dictionary lookup, then attribute lookup, then list-index lookup; callables are called with no arguments.
- **Filter** — a function transforming a value: `{{ name|lower }}`, `{{ price|floatformat:2 }}`.
- **Tag** — logic or output control: `{% for %}`, `{% if %}`, `{% url %}`, `{% static %}`, `{% csrf_token %}`, `{% include %}`, `{% with %}`, `{% cache %}`.
- **Template inheritance** — `{% extends "base.html" %}`, `{% block name %}`, `{{ block.super }}`.
- **Custom template library** — `app/templatetags/<lib>.py` with `register = template.Library()`, loaded with `{% load lib %}`.
- **Autoescaping** — conversion of `<`, `>`, `'`, `"` and `&` to HTML entities in variable output. **`SafeString`** — a string marked as already safe (`mark_safe`, `|safe`, `format_html`).
- **`json_script`** — filter that safely embeds data for JavaScript in a `<script type="application/json">` element.

## 3. Theory & Principles

### 3.1 Finding a template

`render(request, "orders/detail.html", ctx)` calls `loader.render_to_string`, which asks each configured engine for `get_template(name)`. For the DTL engine, the template loaders are tried in order. With `APP_DIRS=True` and no explicit `loaders` option, Django uses:

```python
[("django.template.loaders.cached.Loader", [
    "django.template.loaders.filesystem.Loader",       # each dir in DIRS, in order
    "django.template.loaders.app_directories.Loader",  # each app's templates/, INSTALLED_APPS order
])]
```

The first loader to find the name wins; if none does, `TemplateDoesNotExist` lists every path tried (visible on the DEBUG page's "Template-loader postmortem").

> **Version note:** since Django 4.1 the cached loader is used even when `DEBUG=True`, with the development server's autoreloader clearing it when template files change. On 4.0 and earlier it was only enabled automatically with `DEBUG=False`.

### 3.2 Compiling: lexer, parser, node tree

`Template(source)` compiles immediately:

1. **Lexer** — a regex splits the source into tokens: `TEXT`, `VAR` (`{{ ... }}`), `BLOCK` (`{% ... %}`) and `COMMENT` (`{# ... #}`).
2. **Parser** — walks the tokens. Text becomes a `TextNode`; a variable becomes a `VariableNode` wrapping a `FilterExpression` (the variable plus its filter chain, filters looked up and argument counts checked at compile time); a block token looks up the tag's compilation function in the loaded libraries (built-ins plus anything `{% load %}`ed), which consumes tokens up to its end tag (`{% endfor %}`) and returns a node such as `ForNode`.
3. The result is a `NodeList` stored on the `Template`. Syntax errors (unknown tag, unclosed block, unknown filter) raise `TemplateSyntaxError` here — at compile time, not render time.

With the cached loader, steps 1–2 happen **once per template per process**; afterwards each render only walks the node tree.

### 3.3 Rendering: the context stack and variable resolution

`template.render(context)` calls `nodelist.render(context)`, concatenating each node's output. A `Context` is a **stack of dicts**: tags like `{% for %}` and `{% with %}` `push()` a new layer for their variables and `pop()` it at the end, so inner names shadow outer ones without leaking. `RequestContext` first pushes the output of every context processor, then the view's dict on top.

Resolving `{{ order.customer.name }}` splits on dots and, for each bit, tries in order:

1. dictionary lookup — `obj["customer"]`;
2. attribute lookup — `obj.customer`;
3. list-index lookup — `obj[int("customer")]` (only for numeric bits).

If the result is callable it is **called with no arguments** — which is how `{{ user.get_full_name }}` and `{{ order.items.all }}` work — unless it has `do_not_call_in_templates = True`, or has `alters_data = True` (Django sets this on `save()` and `delete()`), in which case it renders as invalid. A missing variable renders as `string_if_invalid` (empty by default) instead of raising. Exceptions with `silent_variable_failure = True` (for example `ObjectDoesNotExist`) are swallowed the same way. That forgiving behaviour is convenient but hides typos — set `string_if_invalid` to something visible in development.

Every value is then passed through `render_value_in_context`, which converts it to a string, localizes it and **escapes it** if autoescaping is on and the value is not a `SafeString`.

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj05a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">From render() to HTML: load once, compile once, render per request</text>
  <rect x="20" y="44" width="190" height="100" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="115" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">render(request, name, ctx)</text>
  <text x="32" y="88" fill="#334155" font-size="10">engines tried in order</text>
  <text x="32" y="106" fill="#334155" font-size="10">get_template(name)</text>
  <text x="32" y="124" fill="#334155" font-size="10">RequestContext(request, ctx)</text>
  <path d="M210,94 L246,94" stroke="#2563eb" stroke-width="2" marker-end="url(#dj05a)"/>
  <rect x="250" y="44" width="190" height="100" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="345" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">cached.Loader</text>
  <text x="262" y="88" fill="#334155" font-size="10">hit: return compiled Template</text>
  <text x="262" y="106" fill="#334155" font-size="10">miss: filesystem (DIRS), then</text>
  <text x="262" y="124" fill="#334155" font-size="10">app_directories (app order)</text>
  <path d="M440,94 L476,94" stroke="#2563eb" stroke-width="2" marker-end="url(#dj05a)"/>
  <rect x="480" y="44" width="380" height="100" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="670" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">Compile (on cache miss only)</text>
  <text x="492" y="88" fill="#334155" font-size="10">Lexer: TEXT | VAR {{ }} | BLOCK {% %} | COMMENT {# #}</text>
  <text x="492" y="106" fill="#334155" font-size="10">Parser: tag functions build nodes, filters resolved</text>
  <text x="492" y="124" fill="#334155" font-size="10">TemplateSyntaxError raised here, not at render</text>
  <rect x="20" y="170" width="430" height="210" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="235" y="192" text-anchor="middle" fill="#1e293b" font-weight="bold">NodeList (compiled tree)</text>
  <rect x="40" y="206" width="180" height="26" rx="5" fill="#ffffff" stroke="#94a3b8"/>
  <text x="50" y="223" fill="#334155" font-size="10">TextNode "&lt;h1&gt;Order "</text>
  <rect x="40" y="240" width="180" height="26" rx="5" fill="#ffffff" stroke="#94a3b8"/>
  <text x="50" y="257" fill="#334155" font-size="10">VariableNode order.number</text>
  <rect x="40" y="274" width="180" height="26" rx="5" fill="#ffffff" stroke="#94a3b8"/>
  <text x="50" y="291" fill="#334155" font-size="10">ForNode item in order.items.all</text>
  <rect x="70" y="308" width="150" height="26" rx="5" fill="#ffffff" stroke="#94a3b8"/>
  <text x="80" y="325" fill="#334155" font-size="10">VariableNode item.name</text>
  <rect x="40" y="342" width="180" height="26" rx="5" fill="#ffffff" stroke="#94a3b8"/>
  <text x="50" y="359" fill="#334155" font-size="10">IfNode / URLNode / ...</text>
  <text x="240" y="222" fill="#334155" font-size="10">render(context) walks nodes</text>
  <text x="240" y="240" fill="#334155" font-size="10">and concatenates output</text>
  <text x="240" y="268" fill="#334155" font-size="10">ForNode pushes a context</text>
  <text x="240" y="286" fill="#334155" font-size="10">layer per loop (forloop, item)</text>
  <text x="240" y="314" fill="#dc2626" font-size="10">order.items.all runs a QUERY</text>
  <text x="240" y="332" fill="#dc2626" font-size="10">item.product.name in the loop</text>
  <text x="240" y="350" fill="#dc2626" font-size="10">= one query per row (N+1)</text>
  <path d="M450,275 L486,275" stroke="#2563eb" stroke-width="2" marker-end="url(#dj05a)"/>
  <rect x="490" y="170" width="370" height="210" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="675" y="192" text-anchor="middle" fill="#1e293b" font-weight="bold">Resolving {{ order.customer.name }}</text>
  <text x="502" y="216" fill="#334155" font-size="10">for each dotted bit, try in order:</text>
  <text x="514" y="236" fill="#334155" font-size="10">1. dict lookup        obj["customer"]</text>
  <text x="514" y="254" fill="#334155" font-size="10">2. attribute lookup   obj.customer</text>
  <text x="514" y="272" fill="#334155" font-size="10">3. list index         obj[int(bit)]</text>
  <text x="502" y="296" fill="#334155" font-size="10">callable? call with no args (unless alters_data /</text>
  <text x="502" y="312" fill="#334155" font-size="10">do_not_call_in_templates)</text>
  <text x="502" y="334" fill="#334155" font-size="10">missing: string_if_invalid ("" by default)</text>
  <text x="502" y="356" fill="#15803d" font-size="10" font-weight="bold">then escape unless SafeString</text>
</svg>
```

### 3.4 Inheritance: how blocks resolve

`{% extends "base.html" %}` must be the **first tag** in a template. When the child renders, its `ExtendsNode` loads the parent (which may itself extend another template), collects every `{% block %}` from the child and all ancestors into a **block context** (child definitions first), and renders the *root* ancestor. Each `BlockNode` in the root renders the most-derived definition of that block; `{{ block.super }}` renders the next definition up the chain. Content in a child outside any block is ignored. Because the parent name can be a variable (`{% extends layout %}`), you can switch layouts per request.

`{% include "x.html" %}` is different: it renders another template **with the current context** (or only the given variables with `{% include "x.html" with a=1 only %}`) and inserts the output. Blocks inside an included template do not participate in the including template's inheritance.

```svg
<svg viewBox="0 0 880 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj05b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Three-level inheritance: the most-derived block wins, block.super walks up</text>
  <rect x="20" y="44" width="260" height="290" rx="10" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="150" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">base.html (root)</text>
  <rect x="36" y="80" width="228" height="44" rx="6" fill="#ffffff" stroke="#94a3b8"/>
  <text x="46" y="98" fill="#334155" font-size="10">block title: "Acme"</text>
  <text x="46" y="114" fill="#334155" font-size="9">html, head, nav, footer</text>
  <rect x="36" y="134" width="228" height="44" rx="6" fill="#ffffff" stroke="#94a3b8"/>
  <text x="46" y="152" fill="#334155" font-size="10">block sidebar: default links</text>
  <rect x="36" y="188" width="228" height="44" rx="6" fill="#ffffff" stroke="#94a3b8"/>
  <text x="46" y="206" fill="#334155" font-size="10">block content: empty</text>
  <rect x="36" y="242" width="228" height="44" rx="6" fill="#ffffff" stroke="#94a3b8"/>
  <text x="46" y="260" fill="#334155" font-size="10">block scripts: core.js</text>
  <rect x="310" y="44" width="260" height="290" rx="10" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="440" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">shop/base_shop.html</text>
  <text x="326" y="88" fill="#334155" font-size="10">extends "base.html"</text>
  <rect x="326" y="134" width="228" height="44" rx="6" fill="#ffffff" stroke="#7c3aed"/>
  <text x="336" y="152" fill="#334155" font-size="10">block sidebar: categories</text>
  <rect x="326" y="242" width="228" height="44" rx="6" fill="#ffffff" stroke="#7c3aed"/>
  <text x="336" y="260" fill="#334155" font-size="10">block scripts: block.super</text>
  <text x="336" y="276" fill="#334155" font-size="9">+ cart.js</text>
  <rect x="600" y="44" width="260" height="290" rx="10" fill="#dcfce7" stroke="#16a34a"/>
  <text x="730" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">shop/product_detail.html</text>
  <text x="616" y="88" fill="#334155" font-size="10">extends "shop/base_shop.html"</text>
  <rect x="616" y="100" width="228" height="26" rx="6" fill="#ffffff" stroke="#16a34a"/>
  <text x="626" y="117" fill="#334155" font-size="10">block title: product.name</text>
  <rect x="616" y="188" width="228" height="44" rx="6" fill="#ffffff" stroke="#16a34a"/>
  <text x="626" y="206" fill="#334155" font-size="10">block content: product page</text>
  <path d="M600,113 L268,102" stroke="#7c3aed" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#dj05b)"/>
  <path d="M310,156 L268,156" stroke="#7c3aed" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#dj05b)"/>
  <path d="M600,210 L268,210" stroke="#7c3aed" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#dj05b)"/>
  <path d="M310,264 L268,264" stroke="#7c3aed" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#dj05b)"/>
  <text x="440" y="306" text-anchor="middle" fill="#334155" font-size="10">Root template renders; each block slot</text>
  <text x="440" y="322" text-anchor="middle" fill="#334155" font-size="10">is filled by the deepest override (dashed)</text>
  <text x="440" y="350" text-anchor="middle" fill="#1e293b" font-size="10">Output: title=product.name, sidebar=categories, content=product page, scripts=core.js + cart.js</text>
</svg>
```

### 3.5 Autoescaping: what it protects and what it doesn't

With autoescaping on (the default for DTL), `{{ comment.body }}` containing `<script>alert(1)</script>` renders as `&lt;script&gt;alert(1)&lt;/script&gt;`. Escaping converts the five characters `<`, `>`, `'`, `"` and `&`, which makes values safe in **HTML element content** and in **quoted attribute values**.

Escaping is **switched off** by `|safe`, `{% autoescape off %}`, `mark_safe()` in Python, and by any filter/tag that returns a `SafeString`. And it is **insufficient** in some contexts even when on:

- inside `<script>` blocks or `on*=` event handler attributes — HTML entities are not JavaScript escaping;
- in unquoted attributes — `<div class={{ cls }}>` lets a space start a new attribute;
- in `href`/`src` — escaping doesn't stop `javascript:` URLs;
- in CSS contexts.

For data that JavaScript needs, use `{{ data|json_script:"order-data" }}`, which emits a `<script type="application/json" id="order-data">` with `<`, `>` and `&` escaped as Unicode escapes, then `JSON.parse(document.getElementById("order-data").textContent)`. For building HTML in Python, use `format_html()`, which escapes its arguments and marks the result safe. XSS in depth is in [Ch 28 · Security](topic.html?p=28-security).

## 4. Architecture & Workflow

### 4.1 Where templates live

```text
project/
├── templates/                 # DIRS: project-wide layouts and overrides
│   ├── base.html
│   ├── errors/404.html, 500.html
│   ├── emails/base_email.html
│   └── admin/base_site.html   # overrides the admin's template (DIRS searched first)
└── apps/
    └── shop/
        ├── templates/shop/    # namespaced: "shop/product_list.html"
        │   ├── base_shop.html
        │   ├── product_list.html
        │   └── partials/_product_card.html
        └── templatetags/
            ├── __init__.py
            └── shop_tags.py   # {% load shop_tags %}
```

### 4.2 What happens on each render

```text
view: render(request, "shop/product_list.html", {"products": qs, "page": page})
  -> engine.get_template()        cached loader: compiled Template (compile only on first use)
  -> RequestContext(request)      push: csrf + every context processor
                                    request -> {"request": request}
                                    auth    -> {"user": SimpleLazyObject, "perms": PermWrapper}
                                    messages-> {"messages": storage, "DEFAULT_MESSAGE_LEVELS": ...}
                                  push: view context {"products": qs, "page": page}
  -> template.render(context)     ExtendsNode -> base.html; blocks resolved
                                  ForNode iterates qs (QuerySet evaluated here: 1 query)
                                  IncludeNode "_product_card.html" per product (cached compile)
  -> HttpResponse(html)
```

Two performance facts fall out of this. QuerySets passed to templates are **lazy**, so the query runs during rendering — and any relation accessed per row in a loop runs another query unless the view used `select_related`/`prefetch_related`. And context processors run on **every** `RequestContext` render, so a processor that queries the database taxes every page.

## 5. Implementation

### 5.1 Simple example: settings, a base layout and a child page

```python
# config/settings.py (excerpt)
TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
                "core.context_processors.site_settings",       # our own, see §5.3
            ],
        },
    },
]
```

```html
<!-- templates/base.html -->
{% load static %}
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>{% block title %}Acme{% endblock %}</title>
  <link rel="stylesheet" href="{% static 'css/site.css' %}">
</head>
<body>
  <nav>
    <a href="{% url 'home' %}">Home</a>
    {% if user.is_authenticated %}
      Hi, {{ user.get_short_name|default:user.username }}
      <form method="post" action="{% url 'logout' %}">{% csrf_token %}<button>Log out</button></form>
    {% else %}
      <a href="{% url 'login' %}?next={{ request.path|urlencode }}">Log in</a>
    {% endif %}
  </nav>
  {% for message in messages %}
    <div class="alert alert-{{ message.tags }}">{{ message }}</div>
  {% endfor %}
  <main>{% block content %}{% endblock %}</main>
  {% block scripts %}<script src="{% static 'js/core.js' %}" defer></script>{% endblock %}
</body>
</html>
```

```html
<!-- shop/templates/shop/product_list.html -->
{% extends "base.html" %}
{% load humanize shop_tags %}

{% block title %}Products · {{ block.super }}{% endblock %}

{% block content %}
  <h1>Products</h1>
  <ul>
    {% for product in products %}
      {% include "shop/partials/_product_card.html" with product=product only %}
    {% empty %}
      <li>No products yet.</li>
    {% endfor %}
  </ul>
  <p>{{ products|length }} product{{ products|length|pluralize }}, updated {{ updated_at|naturaltime }}</p>
{% endblock %}
```

```html
<!-- shop/templates/shop/partials/_product_card.html -->
<li class="card {% if forloop.first %}first{% endif %}">
  <a href="{{ product.get_absolute_url }}">{{ product.name }}</a>
  <span>{{ product.price|floatformat:2 }} {{ product.currency }}</span>
  {% if product.description %}<p>{{ product.description|truncatewords:20 }}</p>{% endif %}
</li>
```

Note `only` on the include: the partial sees just `product`, not `forloop` — so `forloop.first` there is empty. That's the price of isolation; pass what you need explicitly (`with product=product first=forloop.first only`).

```python
# shop/views.py
from django.shortcuts import render
from django.utils import timezone
from .models import Product

def product_list(request):
    products = Product.objects.filter(active=True).order_by("name")
    return render(request, "shop/product_list.html", {
        "products": products,
        "updated_at": timezone.now(),
    })
```

`humanize` requires `"django.contrib.humanize"` in `INSTALLED_APPS`.

### 5.2 Custom filters and tags

```python
# shop/templatetags/shop_tags.py
from decimal import Decimal
from django import template
from django.utils.html import format_html

register = template.Library()


@register.filter
def money(value, currency="USD"):
    """{{ product.price|money:"EUR" }} -> 'EUR 12.50' (plain text; autoescaped normally)."""
    if value in (None, ""):
        return ""
    return f"{currency} {Decimal(value):,.2f}"


@register.simple_tag(takes_context=True)
def active(context, url_name):
    """{% active 'shop:product-list' %} -> 'active' when the current route matches."""
    match = getattr(context["request"], "resolver_match", None)
    return "active" if match and match.view_name == url_name else ""


@register.simple_tag
def badge(text, level="info"):
    # format_html escapes arguments and returns a SafeString.
    return format_html('<span class="badge badge-{}">{}</span>', level, text)


@register.inclusion_tag("shop/partials/_cart_summary.html", takes_context=True)
def cart_summary(context):
    cart = context["request"].session.get("cart", {})
    return {"count": sum(cart.values()), "user": context.get("user")}
```

```html
{% load shop_tags %}
<a class="{% active 'shop:product-list' %}" href="{% url 'shop:product-list' %}">Shop</a>
{{ product.price|money:"EUR" }}
{% badge "New" "success" %}
{% cart_summary %}
```

The library module must live in a `templatetags` package (with `__init__.py`) inside an **installed app**, and the server must be restarted after creating a new library. Simple tags' return values are autoescaped unless they are `SafeString`s — which is why `badge` uses `format_html` instead of an f-string and `mark_safe`.

> **Version note:** Django 5.2 adds `@register.simple_block_tag`, which makes block tags such as `{% card title="Orders" %}...{% endcard %}` as easy to write as simple tags (the content between the tags is passed as `content`). Before 5.2 you write a compilation function and a `Node` subclass by hand. Django 5.1 added the built-in `{% querystring %}` tag for building query strings (`{% querystring page=page.next_page_number %}`) while preserving other `GET` parameters.

### 5.3 Real-world example: a fast, safe product page

A product detail page shows the product, its variants, reviews with authors, related products, a sidebar of categories that changes rarely, and passes data to a JavaScript widget. Three production concerns: no N+1 queries, no XSS, and no heavy work on every render.

```python
# shop/views.py
from django.db.models import Prefetch
from django.shortcuts import get_object_or_404, render
from .models import Product, Review

def product_detail(request, slug):
    product = get_object_or_404(
        Product.objects.select_related("brand", "category").prefetch_related(
            "variants",
            Prefetch("reviews",
                     queryset=Review.objects.select_related("author").order_by("-created_at")[:20],
                     to_attr="recent_reviews"),
        ),
        slug=slug, active=True,
    )
    widget_data = {
        "productId": product.pk,
        "variants": [{"sku": v.sku, "price": str(v.price), "stock": v.stock} for v in product.variants.all()],
    }
    return render(request, "shop/product_detail.html", {"product": product, "widget_data": widget_data})
```

```html
<!-- shop/templates/shop/product_detail.html -->
{% extends "shop/base_shop.html" %}
{% load cache shop_tags %}

{% block title %}{{ product.name }} · {{ block.super }}{% endblock %}

{% block sidebar %}
  {% cache 600 category_sidebar product.category_id %}
    {% include "shop/partials/_category_tree.html" %}
  {% endcache %}
{% endblock %}

{% block content %}
  <h1>{{ product.name }}</h1>
  <p class="brand">{{ product.brand.name }}</p>            {# select_related: no extra query #}
  <div class="description">{{ product.description_html|safe }}</div>  {# sanitized on save, see below #}

  <h2>Reviews</h2>
  {% for review in product.recent_reviews %}              {# to_attr list: no query, no re-filter #}
    <article>
      <strong>{{ review.author.display_name }}</strong>   {# escaped: user-controlled #}
      <p>{{ review.body|linebreaksbr }}</p>
    </article>
  {% empty %}
    <p>No reviews yet.</p>
  {% endfor %}

  <div id="variant-picker"></div>
  {{ widget_data|json_script:"variant-data" }}
{% endblock %}

{% block scripts %}
  {{ block.super }}
  <script>
    const data = JSON.parse(document.getElementById("variant-data").textContent);
    VariantPicker.mount(document.getElementById("variant-picker"), data);
  </script>
{% endblock %}
```

The rendered `json_script` output escapes HTML-significant characters so that a variant SKU like `</script><script>evil()` cannot break out:

```html
<script id="variant-data" type="application/json">{"productId": 7, "variants": [{"sku": "</script>...", "price": "12.50", "stock": 3}]}</script>
```

The page issues a fixed number of queries regardless of how many reviews or variants exist:

```sql
-- 1: product + brand + category (JOINs)
SELECT ... FROM "shop_product"
INNER JOIN "shop_brand" ON (...) INNER JOIN "shop_category" ON (...)
WHERE ("shop_product"."active" AND "shop_product"."slug" = 'blue-mug') LIMIT 21;
-- 2: variants for that product
SELECT ... FROM "shop_variant" WHERE "shop_variant"."product_id" IN (7);
-- 3: recent reviews with authors (sliced Prefetch uses a window function on 4.2+)
SELECT ... FROM "shop_review" INNER JOIN "accounts_user" ON (...) WHERE ... "product_id" IN (7) ...;
```

`description_html|safe` is acceptable **only** because the HTML is produced by trusted staff and sanitized with an allow-list sanitizer (for example `nh3` or `bleach`) when saved; marking raw user input safe is the classic Django XSS bug. The category sidebar, identical for every product in a category, is fragment-cached for 10 minutes keyed by category ([Ch 29 · Caching](topic.html?p=29-caching)).

A context processor that adds site-wide settings cheaply, using the cache rather than querying on every render:

```python
# core/context_processors.py
from django.core.cache import cache
from .models import SiteSettings

def site_settings(request):
    data = cache.get_or_set("site_settings:v1", lambda: SiteSettings.load().as_dict(), 300)
    return {"site": data}
```

### 5.4 Rendering outside a request: emails

```python
from django.core.mail import EmailMultiAlternatives
from django.template.loader import render_to_string

def send_order_confirmation(order):
    ctx = {"order": order, "site_url": "https://shop.example.com"}
    text = render_to_string("emails/order_confirmed.txt", ctx)
    html = render_to_string("emails/order_confirmed.html", ctx)   # no request: no context processors
    msg = EmailMultiAlternatives(f"Order {order.number} confirmed", text, to=[order.email])
    msg.attach_alternative(html, "text/html")
    msg.send()
```

Without a request there is no `RequestContext`, so `user`, `request` and `messages` are not in the context, and `{% url %}` produces relative paths — prefix absolute links yourself.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | DTL | Jinja2 (`django.template.backends.jinja2.Jinja2`) |
|---|---|---|
| Expressiveness | Intentionally limited; no calls with arguments | Python-like expressions, macros, calls with args |
| Safety | Autoescape on; logic stays in Python | Autoescape on in Django's backend by default; more rope |
| Speed | Fine with cached loader | Generally faster rendering (compiles to Python bytecode) |
| Ecosystem | Admin, third-party apps ship DTL templates | Need a custom `environment` to expose `url`, `static`; context processors via the backend's `context_processors` option |
| Learning curve | Small | Small for Python devs |

| Server-rendered templates | SPA + JSON API |
|---|---|
| One codebase, SEO-friendly, fast first paint, simple auth (sessions + CSRF) | Rich client interactivity, separate deployable front end |
| Partial updates need HTMX/Turbo-style tooling | Two codebases, API versioning, token auth, more JS |

### When to use

- Admin tools, back-office apps, content sites, emails and PDFs — templates are the fastest path.
- HTMX-style apps where the server returns HTML fragments for partial page updates.
- Jinja2 when you have a template-heavy site and measurable rendering cost, or need macros.

### When NOT to use

- Don't put business logic, permissions decisions or queries in templates — compute in the view and pass simple data.
- Don't use DTL to generate non-HTML formats where escaping is wrong (e.g. CSV or JSON); use the proper serializer, or `{% autoescape off %}` with great care for plain-text emails.
- Don't build complex interactive UIs purely in templates if they need lots of client state; a front-end framework fits better.

## 7. Common Mistakes & Best Practices

**N+1 queries from templates.**

```python
# Before: 1 query for orders + 1 per order for customer + 1 per order for items
orders = Order.objects.filter(status="paid")
```

```html
{% for o in orders %}{{ o.customer.name }} ({{ o.items.count }}){% endfor %}
```

```python
# After: 1 query with JOIN + an annotation instead of per-row COUNT
from django.db.models import Count
orders = (Order.objects.filter(status="paid")
          .select_related("customer")
          .annotate(item_count=Count("items")))
```

```html
{% for o in orders %}{{ o.customer.name }} ({{ o.item_count }}){% endfor %}
```

Details in [Ch 13 · QuerySet Optimization & the N+1 Problem](topic.html?p=13-queryset-optimization).

**`|safe` on user input.** `{{ comment.body|safe }}` is an XSS vulnerability. Sanitize with an allow-list on input if you must accept HTML; otherwise let autoescaping work and use `linebreaksbr`/`urlize` for formatting.

**Data in `<script>` via `{{ }}`.** `<script>var name = "{{ user.name }}";</script>` is not safe even with autoescape (and `escapejs` output must still be quoted correctly). Use `json_script`.

**Un-namespaced app templates.** `shop/templates/detail.html` collides with `blog/templates/detail.html`; whichever app is earlier wins everywhere. Always use `app/templates/app/...`.

**Heavy context processors.** A processor that runs `Category.objects.all()` or counts notifications executes on every page, including error pages and AJAX fragments. Make it lazy (return a `SimpleLazyObject` or a callable) or cache it.

**Silent typos.** `{{ ordr.total }}` renders nothing. In development set `"string_if_invalid": "INVALID[%s]"` in `OPTIONS` (but not in production — the admin and some apps rely on empty strings), and render templates in tests.

**Calling methods that change data.** Django blocks `save()`/`delete()` (they have `alters_data = True`), but your own `def send_reminder(self)` will happily run when a template outputs `{{ order.send_reminder }}`. Mark such methods `alters_data = True` or don't expose those objects.

**Best practices**

- Keep templates dumb: prepare data in the view; prefer `annotate()` to template arithmetic.
- One base layout, a small number of intermediate layouts, many small partials named `_x.html`.
- Use `{% url %}` and `{% static %}` everywhere; never hard-code paths.
- Use `format_html` for HTML in Python; `json_script` for JS data; never `mark_safe` on external input.
- Fragment-cache expensive, shared regions with a key that includes everything they depend on.

## 8. Production: Pitfalls, Debugging & Scaling

**Pitfall: slow pages with fast views.** *Symptom:* view code takes 20 ms, response takes 800 ms. *Root cause:* lazy QuerySets and relations evaluated during rendering (N+1), or expensive template tags. *Fix:* Django Debug Toolbar's SQL panel attributes queries to the template line that triggered them; fix with `select_related`/`prefetch_related`/`annotate`. In tests, wrap the client call in `self.assertNumQueries(n)` so the template's queries are counted too.

**Pitfall: `TemplateDoesNotExist` only in production.** *Root cause:* an app missing from production `INSTALLED_APPS`, case-sensitive file systems (macOS dev is case-insensitive by default, Linux isn't), or templates excluded from the Docker image. *Fix:* the error's postmortem lists every path tried; add a test that renders every template.

**Pitfall: stale templates after deploy.** With the cached loader, each process keeps compiled templates in memory until restart. Rolling deploys replace processes, so this is only a problem if you hot-swap template files without restarting.

**Pitfall: fragment cache leaks data between users.** `{% cache 600 header %}` around a block containing `{{ user.username }}` shows the first user's name to everyone. Include the varying values in the key: `{% cache 600 header request.user.pk %}`, or keep per-user parts outside the cached fragment.

**Pitfall: XSS through translations or admin-edited content.** Strings from `{% blocktranslate %}` and admin-managed "HTML snippets" are often marked safe. Treat staff-entered HTML as untrusted unless it's sanitized; set a Content Security Policy (via `django-csp` on 5.2) as defence in depth.

**Debugging**

- DEBUG error page: template source with the failing line highlighted and the loader postmortem.
- `OPTIONS["debug"]` follows `DEBUG` by default; it adds origin info used by debug pages.
- Debug Toolbar's *Templates* panel: which templates rendered, with their contexts; *SQL* panel: queries with template stack traces.
- `python manage.py shell -c "from django.template.loader import get_template; print(get_template('shop/x.html').origin)"` to see which file won.

**Scaling notes.** DTL rendering is CPU work in the worker; for most pages it is small compared to queries. When it isn't: cache fragments that are identical across users, cache whole pages for anonymous users ([Ch 29](topic.html?p=29-caching)), reduce `{% include %}` inside huge loops (each include has overhead — inline or use a custom inclusion tag), and consider Jinja2 for rendering-heavy pages. Move rendering of bulk emails or PDFs to Celery workers so web workers stay free.

## 9. Interview Questions

**Q: How does Django find a template when you call `render()`?**
A: It iterates the engines in `TEMPLATES`; for the DTL engine, it tries the configured loaders in order. By default that's the cached loader wrapping the filesystem loader (each directory in `DIRS`) and then the app-directories loader (each installed app's `templates/` folder, in `INSTALLED_APPS` order). The first match wins, and if nothing matches `TemplateDoesNotExist` lists every path tried. That ordering is why you namespace app templates (`shop/templates/shop/...`) and how you override third-party templates, such as the admin's, from `DIRS` or an earlier app.

**Q: How does template inheritance work?**
A: A child template starts with `{% extends "base.html" %}` and overrides named `{% block %}` regions; the parent defines the layout and default block content. At render time Django loads the chain of ancestors, collects all block definitions, and renders the root template, filling each block with the most-derived definition. `{{ block.super }}` inserts the parent's version of the block. `extends` must be the first tag, and content outside blocks in a child is ignored.

**Q: What is the difference between `{% include %}` and `{% extends %}`?**
A: `extends` establishes an inheritance relationship: the child customizes slots in a parent layout, and there can be only one `extends` per template. `include` inserts the rendered output of another template at that point, using the current context (or only explicit variables with `with ... only`). Blocks inside an included template don't override anything in the including template. Use `extends` for layouts and `include` for reusable fragments.

**Q: What are context processors and when should you write one?**
A: A context processor is a function that takes the request and returns a dict merged into the context of every template rendered with a `RequestContext` — which `render(request, ...)` always uses. Built-ins add `request`, `user` and `perms`, and `messages`. Write one for data genuinely needed on almost every page, such as site settings or the current tenant. Keep them cheap and lazy, because they run on every render including error pages, and a database query there taxes every request.

**Q: How does Django's autoescaping prevent XSS, and how do you disable it?**
A: By default every variable output is HTML-escaped: `<`, `>`, `'`, `"` and `&` become entities, so user input renders as text instead of markup. It's disabled per variable with the `|safe` filter, per region with `{% autoescape off %}`, or for a value by marking it safe in Python with `mark_safe` or `format_html`. You should only mark content safe when you generated it or sanitized it with an allow-list.

**Q: Where does autoescaping not protect you?**
A: HTML escaping is correct for element content and quoted attribute values, but not for JavaScript contexts (inside `<script>` or `on*` attributes), unquoted attributes, URL attributes (`href="{{ url }}"` with a `javascript:` URL), or CSS. For JavaScript data use `json_script`; always quote attributes; validate URLs' schemes. Anything marked safe — `|safe`, `mark_safe`, custom tags returning `SafeString` — bypasses escaping entirely.

**Q: How do you write a custom template filter or tag?**
A: Create a `templatetags` package in an installed app, add a module with `register = template.Library()`, and decorate functions: `@register.filter` for filters, `@register.simple_tag` for tags that return a value, `@register.inclusion_tag("tpl.html")` for tags that render a template with their own context, with `takes_context=True` to access the current context. Load it with `{% load module_name %}`. Return plain strings to keep autoescaping, or use `format_html` to return safe HTML. Fully custom block tags need a compilation function and a `Node` subclass, or `simple_block_tag` on Django 5.2.

**Q: Why can't you call methods with arguments in Django templates?**
A: The DTL is deliberately restricted so that templates stay presentation-only and safe to hand to non-programmers; logic belongs in views, model methods, or custom tags and filters. Variable lookups can call zero-argument callables (`{{ user.get_full_name }}`), and filters take one argument. Django also refuses to call methods flagged `alters_data`, like `save()` and `delete()`, from templates. If you need more expressiveness, write a filter or tag, or use the Jinja2 backend.

**Q: How do templates cause N+1 queries and how do you prevent them?**
A: QuerySets are lazy, so a QuerySet passed to a template is evaluated during rendering, and every relation accessed inside `{% for %}` — `{{ order.customer.name }}`, `{{ order.items.count }}` — can run another query per row. Prevent it in the view with `select_related` for foreign keys and one-to-one, `prefetch_related` for reverse and many-to-many relations, and `annotate` for counts and sums. Detect it with Debug Toolbar's SQL panel and lock it in with `assertNumQueries` in tests.

**Q: What does the cached template loader do?**
A: It wraps the other loaders and keeps compiled `Template` objects in memory per process, so each template is read and parsed once rather than on every render. It has been enabled by default when `loaders` isn't specified, including in development since Django 4.1, with the autoreloader clearing it when files change. In production that means template changes need a process restart, which rolling deploys handle.

**Q: A page's response time grew from 100 ms to 2 s as data grew, but the view's code is trivial. How do you investigate? (Senior)**
A: Growth with data size points to per-row work during rendering. I'd open the page with Debug Toolbar or APM and look at the query count and the template stack traces attached to each query — typically a relation access or `.count` inside a loop, or a custom tag that queries per call. I'd fix it in the view with `select_related`, `prefetch_related` (with a `Prefetch` and `to_attr` for filtered relations) and `annotate`, and paginate if the list is unbounded. Then I'd check render CPU itself: thousands of `{% include %}` calls or heavy filters in a loop, and fragment-cache shared regions. Finally I'd add an `assertNumQueries` test so the number of queries stays constant as data grows.

**Q: How would you safely pass server data to a JavaScript component in a Django template? (Senior)**
A: Use the `json_script` filter: `{{ data|json_script:"widget-data" }}` emits a `<script type="application/json">` element whose content escapes `<`, `>` and `&` as Unicode escapes, so a value like `</script>` can't terminate the element; the script then reads it with `JSON.parse(el.textContent)`. Avoid interpolating `{{ }}` inside inline scripts or `on*` attributes, because HTML escaping isn't JavaScript escaping. Serialize only the fields the client needs — not whole model dicts with private fields — and add a Content Security Policy to reduce the impact of any mistake. For larger or dynamic data, an authenticated JSON endpoint is cleaner.

**Q: How would you design a reusable UI component system on top of DTL for a large team? (Senior)**
A: I'd keep one base layout and a few section layouts, and build components as namespaced partials (`components/_card.html`) exposed through inclusion tags or Django 5.2's `simple_block_tag`, so each component has a clear, explicit set of arguments instead of depending on whatever is in the context. Components return escaped output by default and build HTML with `format_html`. I'd document them in a living style guide page and render every component in tests. For HTMX-style partial updates I'd structure pages so fragments render standalone, with libraries like django-template-partials or django-cotton as options. Performance-wise, avoid deep include chains inside large loops and cache shared fragments.

**Q: What happens when a template references a variable that doesn't exist?**
A: Django doesn't raise; it renders the engine's `string_if_invalid` value, an empty string by default, and filters are applied to it. The same happens for exceptions marked `silent_variable_failure`, such as `ObjectDoesNotExist`. That is forgiving in production but hides typos, so set `string_if_invalid` to a visible marker in development and render templates in tests. Errors in tag syntax are different: they raise `TemplateSyntaxError` when the template is compiled.

## 10. Quick Revision & Cheat Sheet

| Feature | Syntax | Note |
|---|---|---|
| Variable | `{{ order.customer.name }}` | dict, attr, index; callables called |
| Filter | `{{ price\|floatformat:2 }}` | one argument max |
| Default | `{{ name\|default:"Anon" }}` | falsy values |
| Loop | `{% for x in xs %}...{% empty %}...{% endfor %}` | `forloop.counter`, `.first`, `.last` |
| Condition | `{% if a and not b %}` | `==`, `in`, `is` supported |
| Inherit | `{% extends "base.html" %}` + `{% block %}` | first tag; `{{ block.super }}` |
| Include | `{% include "x.html" with a=1 only %}` | current context unless `only` |
| URL | `{% url "app:name" pk=o.pk %}` | reverse by name |
| Static | `{% load static %}{% static "css/a.css" %}` | uses `STORAGES["staticfiles"]` |
| CSRF | `{% csrf_token %}` | inside every POST form |
| Cache | `{% load cache %}{% cache 600 key var %}` | include varying values in key |
| JS data | `{{ data\|json_script:"id" }}` | never `{{ }}` inside `<script>` |
| Query string | `{% querystring page=2 %}` | Django 5.1+ |
| Custom | `templatetags/x.py`, `Library()`, `@register.filter/simple_tag/inclusion_tag` | `{% load x %}` |

- Loaders: DIRS first, then apps in `INSTALLED_APPS` order; first match wins.
- Namespace app templates: `app/templates/app/...`.
- Compile once (cached loader), render per request by walking the node tree.
- Context is a stack; `RequestContext` adds context processors.
- Autoescape is on; `|safe`/`mark_safe` turn it off — only for trusted or sanitized HTML.
- Autoescape doesn't cover JS, CSS, unquoted attributes or `javascript:` URLs.
- Templates evaluate lazy QuerySets: optimize relations in the view.
- Missing variables render as `""` silently.

## 11. Hands-On Exercises

Set up: `python -m venv .venv && source .venv/bin/activate && pip install "django~=5.2" django-debug-toolbar && django-admin startproject config . && python manage.py startapp shop`.

1. **Inheritance chain.** Build `base.html` → `shop/base_shop.html` → `shop/product_detail.html` as in §3.4, using `{{ block.super }}` in the scripts block. Predict the output before rendering.
2. **Loader order.** Create `templates/shop/product_list.html` and `shop/templates/shop/product_list.html` with different text. Which wins? Use `get_template(...).origin` to confirm, then remove the project-level one.
3. **XSS lab.** Save a product description containing `<img src=x onerror=alert(1)>`. Render it with `{{ }}`, with `|safe`, and inside a `<script>` string; then fix the script case with `json_script`.
4. **N+1 hunt.** Create 50 orders with customers and items. Render a list showing customer names and item counts; count queries with Debug Toolbar or `assertNumQueries`; reduce it to 1–2 queries.
5. **Custom tags.** Implement `money`, `active` and `badge` from §5.2; write tests that render `Template("{% load shop_tags %}{% badge '<b>' %}")` and assert the `<b>` is escaped.

**Mini project — Storefront templates.** Build a small shop UI: a base layout with nav and messages, a product list with pagination using `{% querystring %}`, a product page with reviews and a JS variant picker fed by `json_script`, a fragment-cached category sidebar, an inclusion tag for the cart summary, and an HTML + text order confirmation email rendered with `render_to_string`. Add tests that render every template, assert query counts for list and detail pages, and assert that a malicious product name is escaped everywhere.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** [Ch 04 · Views, HttpRequest & HttpResponse](topic.html?p=04-views-requests-responses), [Ch 06 · Forms, ModelForms & Validation](topic.html?p=06-forms-validation) (rendering forms and errors), [Ch 13 · QuerySet Optimization & the N+1 Problem](topic.html?p=13-queryset-optimization), [Ch 17 · Class-Based & Generic Views](topic.html?p=17-class-based-views) (`get_context_data`, `TemplateResponse`), [Ch 20 · Static & Media Files](topic.html?p=20-static-media-files) (`{% static %}`), [Ch 28 · Security](topic.html?p=28-security) (XSS and CSP), [Ch 29 · Caching in Django](topic.html?p=29-caching) (fragment caching).

**Other handbooks:** [REST API · Validation & Input Sanitization](../rest-api/topic.html?p=17-validation-input-sanitization), [REST API · OWASP API Security](../rest-api/topic.html?p=23-owasp-api-security), [System Design · CDN](../system-design/topic.html?p=11-cdn).

- **Templates (topic guide)** — Django docs · *Beginner* · engines, loaders, `TEMPLATES` and the DTL overview. <https://docs.djangoproject.com/en/5.2/topics/templates/>
- **The Django template language** — Django docs · *Beginner* · variables, filters, tags, inheritance and autoescaping for template authors. <https://docs.djangoproject.com/en/5.2/ref/templates/language/>
- **Built-in template tags and filters** — Django docs · *Beginner* · the complete reference. <https://docs.djangoproject.com/en/5.2/ref/templates/builtins/>
- **How to create custom template tags and filters** — Django docs · *Intermediate* · filters, simple/inclusion tags, autoescaping rules, writing `Node`s. <https://docs.djangoproject.com/en/5.2/howto/custom-template-tags/>
- **The Django template language: for Python programmers** — Django docs · *Advanced* · `Context`, `RequestContext`, loaders and the rendering API. <https://docs.djangoproject.com/en/5.2/ref/templates/api/>
- **Security in Django: XSS protection** — Django docs · *Intermediate* · what autoescaping covers and its limits. <https://docs.djangoproject.com/en/5.2/topics/security/>
- **OWASP XSS Prevention Cheat Sheet** — OWASP · *Intermediate* · output encoding per context (HTML, attribute, JS, URL, CSS). <https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html>
- **django-template-partials** — GitHub · *Intermediate* · reusable named partials, handy for HTMX fragment rendering. <https://github.com/carltongibson/django-template-partials>

---

*Django Handbook — chapter 05.*
