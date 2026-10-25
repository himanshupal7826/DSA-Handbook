# 32 · Django Channels & Real-Time

> **In one line:** Channels extends Django beyond request/response by running long-lived ASGI connections (WebSockets) in consumers, and connects every process through a channel layer so that any piece of code — a view, a Celery task, another socket — can broadcast to a group of browsers; the hard parts are authentication, the layer's best-effort delivery, and scaling thousands of open connections.

---

## 1. Overview

> **Builds on:** [Ch 30 · Async Django & ASGI](topic.html?p=30-async-django-asgi) (ASGI, `sync_to_async`), [Ch 01 · Django Architecture & the Request/Response Lifecycle](topic.html?p=01-architecture-request-lifecycle), [Ch 27 · Sessions, Cookies & Messages](topic.html?p=27-sessions-cookies), [Ch 31 · Background Tasks with Celery](topic.html?p=31-celery-background-tasks).

Classic Django answers one HTTP request with one response and forgets the client. That model cannot express "tell every user watching order 42 that it just shipped", "show a new chat message in under 100 ms", or "stream build logs as they are produced". The naive approach is **polling**: the browser asks `/api/orders/42/status` every two seconds. With 10,000 open tabs that is 5,000 requests per second, almost all returning "no change", each paying for middleware, authentication and a database query. Long-polling helps latency but still pins a worker per waiting client under WSGI, which is exactly the resource you have least of.

What you want is a **persistent connection** the server can push into. The WebSocket protocol provides it: an HTTP request with `Upgrade: websocket` turns into a full-duplex TCP stream that stays open for minutes or hours. WSGI cannot host that — a WSGI callable must return a response and finish. **ASGI** can, because an ASGI application is an async callable that receives and sends events for as long as the connection lives. **Django Channels** is the official project that builds on ASGI to give you WebSocket (and other protocol) handling in Django style: routing like URLconf, **consumers** like views, Django's auth and sessions on the socket, and a **channel layer** — a cross-process message bus, usually Redis — so that a message produced anywhere can reach a socket held by any server process.

That last piece is the one people miss. With four Daphne/uvicorn processes behind a load balancer, user A's socket lives in process 1 and user B's in process 3. When A sends a chat message, process 1 must somehow deliver it to B's socket in process 3. The channel layer solves this with **groups**: every consumer for room "lobby" joins group `chat_lobby`; `group_send("chat_lobby", event)` publishes to Redis; each process subscribed for members of that group receives the event and calls the matching handler on its local consumers, which write to their sockets.

## 2. Core Concepts

- **ASGI** — the async successor to WSGI: an app is `async def app(scope, receive, send)`. *Why it matters:* a connection can stay open and receive/send many events, which WebSockets need.
- **Scope** — the connection's metadata dict: `type` (`"http"`/`"websocket"`), `path`, `headers`, `query_string`, and (after middleware) `user`, `session`, `url_route`. *Why:* the WebSocket equivalent of `request`, fixed for the lifetime of the connection.
- **ASGI server** — **Daphne** (from the Channels project), **uvicorn**, or **hypercorn**. *Why:* Gunicorn sync workers cannot hold sockets; you need an async server.
- **`ProtocolTypeRouter`** — top-level router that dispatches by `scope["type"]`: `"http"` to Django's ASGI app, `"websocket"` to your WebSocket stack. *Why:* one ASGI entrypoint serves both.
- **`URLRouter`** — path-based routing for WebSocket URLs, using `path()`/`re_path()`. *Why:* familiar URLconf patterns, captured kwargs land in `scope["url_route"]["kwargs"]`.
- **`AuthMiddlewareStack`** — `CookieMiddleware` + `SessionMiddleware` + `AuthMiddleware`, populating `scope["user"]` lazily from the session cookie. *Why:* the same login works for HTTP and sockets.
- **`AllowedHostsOriginValidator`** — rejects WebSocket handshakes whose `Origin` is not in `ALLOWED_HOSTS`. *Why:* browsers send cookies on cross-site WebSocket connects; without it you are open to cross-site WebSocket hijacking.
- **Consumer** — a class handling one connection: `WebsocketConsumer` (sync), `AsyncWebsocketConsumer`, `AsyncJsonWebsocketConsumer`. *Why:* one instance per connection, so instance attributes are per-socket state.
- **Channel** — a named mailbox unique to one consumer instance (`self.channel_name`). *Why:* the address the layer uses to reach that specific socket.
- **Group** — a named set of channels (`group_add`, `group_discard`, `group_send`). *Why:* broadcast without knowing which process holds which socket.
- **Channel layer** — the cross-process transport: `channels_redis.core.RedisChannelLayer` (production), `RedisPubSubChannelLayer`, `InMemoryChannelLayer` (tests/dev only). *Why:* without it, groups only work inside one process.
- **Event `type`** — a message sent through the layer must have `"type": "chat.message"`; Channels calls the consumer method `chat_message` (dots → underscores). *Why:* this is how one event fans into handler methods.
- **`database_sync_to_async`** — Channels' wrapper that runs sync ORM code in a thread and cleans up old DB connections. *Why:* calling the ORM directly from an async consumer raises `SynchronousOnlyOperation`.
- **SSE (Server-Sent Events)** — one-way server→browser stream over plain HTTP (`text/event-stream`). *Why:* often all you need for notifications, with simpler infra than WebSockets.

## 3. Theory & Principles

### What happens on a WebSocket connect

1. The browser sends `GET /ws/chat/lobby/` with `Upgrade: websocket`, `Sec-WebSocket-Key`, `Origin` and the session cookie.
2. The ASGI server (Daphne/uvicorn) builds a scope with `type: "websocket"` and calls your `application(scope, receive, send)`.
3. `ProtocolTypeRouter` sees `"websocket"` and passes the call to `AllowedHostsOriginValidator`, which checks the `Origin` header against `ALLOWED_HOSTS` and closes the handshake if it does not match.
4. `AuthMiddlewareStack` parses cookies, loads the session from the session engine, and puts a lazy `scope["user"]` in place.
5. `URLRouter` matches the path, adds `url_route` kwargs, and instantiates the consumer via the ASGI app returned by `ChatConsumer.as_asgi()` — **one consumer instance per connection**.
6. The server delivers a `websocket.connect` event; the consumer's `connect()` runs. It must call `self.accept()`; calling `self.close()` *before* accepting rejects the handshake (Daphne answers HTTP 403 and the browser sees a failed connection with close code 1006, without any custom code).
7. On accept, the consumer registers its unique `channel_name` with the channel layer and typically calls `group_add`.
8. From then on, `websocket.receive` events call `receive(text_data=...)`, layer events call the method named by `type`, and `websocket.disconnect` calls `disconnect(code)`.

Internally, a consumer runs **two event sources** concurrently: the socket (`receive` from the server) and its channel-layer mailbox. Channels' base `AsyncConsumer.__call__` subscribes the instance's channel to the layer and uses an `await_many_dispatch` loop that waits on both and dispatches each message to a handler chosen from `message["type"]` by `get_handler_name` (replace `.` with `_`, reject names starting with `_`). That is why a layer event with `"type": "chat.message"` ends up calling `self.chat_message(event)`.

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj32a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">One ASGI entrypoint, two protocol stacks</text>
  <rect x="20" y="170" width="120" height="60" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="80" y="195" text-anchor="middle" fill="#1e293b" font-weight="bold">Browser</text>
  <text x="80" y="213" text-anchor="middle" fill="#334155">HTTP + WS</text>
  <rect x="170" y="160" width="130" height="80" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="235" y="185" text-anchor="middle" fill="#1e293b" font-weight="bold">Daphne / uvicorn</text>
  <text x="235" y="203" text-anchor="middle" fill="#334155">builds scope</text>
  <text x="235" y="221" text-anchor="middle" fill="#334155">calls application</text>
  <rect x="330" y="160" width="140" height="80" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="400" y="185" text-anchor="middle" fill="#1e293b" font-weight="bold">ProtocolTypeRouter</text>
  <text x="400" y="205" text-anchor="middle" fill="#334155">scope["type"]</text>
  <text x="400" y="221" text-anchor="middle" fill="#334155">http | websocket</text>
  <rect x="510" y="50" width="350" height="70" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="685" y="74" text-anchor="middle" fill="#1e293b" font-weight="bold">"http": get_asgi_application()</text>
  <text x="685" y="94" text-anchor="middle" fill="#334155">normal Django: middleware, URLconf, views</text>
  <text x="685" y="110" text-anchor="middle" fill="#334155">(created before importing models)</text>
  <rect x="510" y="150" width="350" height="34" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="685" y="172" text-anchor="middle" fill="#1e293b">AllowedHostsOriginValidator: Origin in ALLOWED_HOSTS?</text>
  <rect x="510" y="194" width="350" height="34" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="685" y="216" text-anchor="middle" fill="#1e293b">AuthMiddlewareStack: cookie, session, scope["user"]</text>
  <rect x="510" y="238" width="350" height="34" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="685" y="260" text-anchor="middle" fill="#1e293b">URLRouter: ws/chat/&lt;room&gt;/ to url_route kwargs</text>
  <rect x="510" y="282" width="350" height="60" rx="6" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="685" y="304" text-anchor="middle" fill="#1e293b" font-weight="bold">ChatConsumer.as_asgi()</text>
  <text x="685" y="322" text-anchor="middle" fill="#334155">new instance per connection: connect, receive,</text>
  <text x="685" y="336" text-anchor="middle" fill="#334155">chat_message (layer events), disconnect</text>
  <path d="M140,200 L168,200" stroke="#334155" stroke-width="2" marker-end="url(#dj32a)"/>
  <path d="M300,200 L328,200" stroke="#334155" stroke-width="2" marker-end="url(#dj32a)"/>
  <path d="M470,185 L508,90" stroke="#2563eb" stroke-width="2" marker-end="url(#dj32a)"/>
  <path d="M470,210 L508,167" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj32a)"/>
  <path d="M685,184 L685,192" stroke="#334155" stroke-width="1.5" marker-end="url(#dj32a)"/>
  <path d="M685,228 L685,236" stroke="#334155" stroke-width="1.5" marker-end="url(#dj32a)"/>
  <path d="M685,272 L685,280" stroke="#334155" stroke-width="1.5" marker-end="url(#dj32a)"/>
  <text x="20" y="375" fill="#334155">Each layer can close the connection before the consumer exists: bad Origin, no route, or a rejected</text>
  <text x="20" y="391" fill="#334155">connect() all appear to the browser as a failed handshake.</text>
</svg>
```

### The channel layer: what it guarantees and what it does not

The Redis channel layer implements two operations. `send(channel, message)` pushes to one consumer's mailbox (a Redis list keyed by the channel name, with the process-specific prefix so the owning process reads it). `group_send(group, message)` looks up the group's members (a Redis sorted set of channel names, scored by join time so stale entries expire after `group_expiry`, default one day) and pushes the message to each member's mailbox in one Lua script. Each server process runs a receive loop that pulls messages for the channels it owns and hands them to the right consumer instance.

The guarantees are deliberately weak. Delivery is **at-most-once**: if a process is down or the consumer disconnected, the message is lost. Messages **expire** (default 60 s) and each channel has a **capacity** (default 100); when a channel is full, `send` raises `ChannelFull`, and `group_send` silently drops for that member. There is **no persistence and no replay**. That is the right design for presence, typing indicators and "something changed, refresh" pings; it is the wrong design for anything a user must not miss. The pattern for important events is: **persist to the database first, then push a notification**; on reconnect, the client fetches what it missed via a normal REST endpoint (for example `GET /api/messages?after=<last_id>`).

`RedisPubSubChannelLayer` uses Redis Pub/Sub instead of lists. It is lighter for pure broadcast, but loses even more under disconnects (Pub/Sub has no buffering at all). Both are documented in the channels_redis README. For the underlying Redis primitives, see [Redis · Streams, Pub/Sub & Invalidation](../redis-caching/topic.html?p=21-streams-pubsub-invalidation).

## 4. Architecture & Workflow

### Broadcasting across processes

The diagram shows why the channel layer exists: Alice and Bob are connected to different server processes, and a Celery task with no socket at all also needs to reach Bob.

```svg
<svg viewBox="0 0 880 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj32b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
    <marker id="dj32c" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">group_send: one event, every member, any process</text>
  <rect x="20" y="60" width="100" height="44" rx="8" fill="#f1f5f9" stroke="#94a3b8"/><text x="70" y="87" text-anchor="middle" fill="#1e293b">Alice tab</text>
  <rect x="20" y="170" width="100" height="44" rx="8" fill="#f1f5f9" stroke="#94a3b8"/><text x="70" y="197" text-anchor="middle" fill="#1e293b">Bob tab</text>
  <rect x="20" y="280" width="100" height="44" rx="8" fill="#f1f5f9" stroke="#94a3b8"/><text x="70" y="307" text-anchor="middle" fill="#1e293b">Carol tab</text>
  <rect x="170" y="45" width="200" height="80" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="270" y="67" text-anchor="middle" fill="#1e293b" font-weight="bold">ASGI process 1</text>
  <text x="270" y="87" text-anchor="middle" fill="#334155">ChatConsumer (Alice)</text>
  <text x="270" y="105" text-anchor="middle" fill="#334155">channel specific.p1!a1</text>
  <rect x="170" y="155" width="200" height="180" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="270" y="177" text-anchor="middle" fill="#1e293b" font-weight="bold">ASGI process 2</text>
  <text x="270" y="199" text-anchor="middle" fill="#334155">ChatConsumer (Bob)</text>
  <text x="270" y="215" text-anchor="middle" fill="#334155">channel specific.p2!b7</text>
  <text x="270" y="295" text-anchor="middle" fill="#334155">ChatConsumer (Carol)</text>
  <text x="270" y="311" text-anchor="middle" fill="#334155">channel specific.p2!c3</text>
  <rect x="460" y="120" width="210" height="150" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="565" y="143" text-anchor="middle" fill="#1e293b" font-weight="bold">Redis channel layer</text>
  <text x="565" y="166" text-anchor="middle" fill="#334155">group chat_lobby =</text>
  <text x="565" y="182" text-anchor="middle" fill="#334155">{p1!a1, p2!b7, p2!c3}</text>
  <text x="565" y="206" text-anchor="middle" fill="#334155">per-channel lists</text>
  <text x="565" y="222" text-anchor="middle" fill="#334155">expiry 60 s, capacity 100</text>
  <text x="565" y="250" text-anchor="middle" fill="#92400e" font-weight="bold">at-most-once, no replay</text>
  <rect x="720" y="300" width="140" height="70" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="790" y="324" text-anchor="middle" fill="#1e293b" font-weight="bold">Celery task / view</text>
  <text x="790" y="342" text-anchor="middle" fill="#334155">async_to_sync(</text>
  <text x="790" y="358" text-anchor="middle" fill="#334155">layer.group_send)</text>
  <path d="M120,80 L168,80" stroke="#334155" stroke-width="2" marker-end="url(#dj32b)"/>
  <text x="140" y="72" text-anchor="middle" fill="#334155" font-size="9">"hi"</text>
  <path d="M370,85 L458,150" stroke="#2563eb" stroke-width="2" marker-end="url(#dj32b)"/>
  <text x="430" y="105" fill="#2563eb" font-size="10">1. group_send</text>
  <path d="M460,185 L372,205" stroke="#d97706" stroke-width="2" marker-end="url(#dj32b)"/>
  <path d="M460,235 L372,295" stroke="#d97706" stroke-width="2" marker-end="url(#dj32b)"/>
  <path d="M460,140 L372,110" stroke="#d97706" stroke-width="2" marker-end="url(#dj32b)"/>
  <text x="395" y="262" fill="#d97706" font-size="10">2. fan out</text>
  <path d="M170,200 L122,195" stroke="#334155" stroke-width="2" marker-end="url(#dj32b)"/>
  <path d="M170,302 L122,302" stroke="#334155" stroke-width="2" marker-end="url(#dj32b)"/>
  <text x="140" y="240" text-anchor="middle" fill="#334155" font-size="9">3. chat_message</text>
  <text x="140" y="252" text-anchor="middle" fill="#334155" font-size="9">sends to socket</text>
  <path d="M720,320 L672,250" stroke="#16a34a" stroke-width="2" marker-end="url(#dj32b)"/>
  <path d="M370,330 L458,262" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="5 3" marker-end="url(#dj32c)"/>
  <text x="380" y="370" fill="#dc2626" font-size="10">Bob offline? message is simply dropped:</text>
  <text x="380" y="386" fill="#dc2626" font-size="10">persist first, push second, refetch on reconnect</text>
</svg>
```

### Deployment topology

```text
              ┌────────── Nginx / ALB (TLS, Upgrade headers, long read timeout) ─────────┐
              │                                                                          │
     /api/*, /admin/*  ──►  Gunicorn (WSGI, sync workers)   ── PostgreSQL ──┐            │
     /ws/*             ──►  Daphne or uvicorn (ASGI)  ◄──►  Redis channel layer ◄── Celery workers
              │                                                                          │
              └──────────────────────────────────────────────────────────────────────────┘
```

Many teams split WSGI (regular traffic) and ASGI (only `/ws/`) so that a pile of open sockets cannot affect request latency, and so the ASGI fleet can scale on connection count while the WSGI fleet scales on CPU. A single ASGI fleet serving both is also fine if your views are well behaved.

## 5. Implementation

### Simple example: a chat room

```bash
pip install "django~=5.2" "channels~=4.1" "daphne~=4.1" "channels-redis~=4.2"
```

```python
# settings.py
INSTALLED_APPS = [
    "daphne",                 # must be first: makes runserver serve ASGI
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "channels",
    "chat",
]

ASGI_APPLICATION = "proj.asgi.application"

CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels_redis.core.RedisChannelLayer",
        "CONFIG": {"hosts": [("127.0.0.1", 6379)]},
    }
}
```

```python
# proj/asgi.py
import os
from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "proj.settings")
# Initialise Django (apps registry) BEFORE importing anything that imports models.
django_asgi_app = get_asgi_application()

from channels.auth import AuthMiddlewareStack                     # noqa: E402
from channels.routing import ProtocolTypeRouter, URLRouter        # noqa: E402
from channels.security.websocket import AllowedHostsOriginValidator  # noqa: E402
import chat.routing                                               # noqa: E402

application = ProtocolTypeRouter({
    "http": django_asgi_app,
    "websocket": AllowedHostsOriginValidator(
        AuthMiddlewareStack(URLRouter(chat.routing.websocket_urlpatterns))
    ),
})
```

```python
# chat/routing.py
from django.urls import path
from . import consumers

websocket_urlpatterns = [
    path("ws/chat/<slug:room>/", consumers.ChatConsumer.as_asgi()),
]
```

```python
# chat/consumers.py
import json
from channels.generic.websocket import AsyncWebsocketConsumer

class ChatConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.room = self.scope["url_route"]["kwargs"]["room"]
        self.group = f"chat_{self.room}"          # ASCII letters, digits, - _ . only
        await self.channel_layer.group_add(self.group, self.channel_name)
        await self.accept()

    async def disconnect(self, code):
        await self.channel_layer.group_discard(self.group, self.channel_name)

    async def receive(self, text_data=None, bytes_data=None):
        payload = json.loads(text_data)
        await self.channel_layer.group_send(
            self.group,
            {"type": "chat.message", "text": payload["text"]},  # -> chat_message()
        )

    async def chat_message(self, event):
        await self.send(text_data=json.dumps({"text": event["text"]}))
```

```html
<script>
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/chat/lobby/`);
  ws.onmessage = (e) => console.log(JSON.parse(e.data).text);
  ws.onopen = () => ws.send(JSON.stringify({text: "hello"}));
</script>
```

```bash
python manage.py runserver          # with "daphne" in INSTALLED_APPS this is an ASGI server
```

```text
Starting ASGI/Daphne version 4.1.2 development server at http://127.0.0.1:8000/
WebSocket HANDSHAKING /ws/chat/lobby/ [127.0.0.1:52144]
WebSocket CONNECT /ws/chat/lobby/ [127.0.0.1:52144]
```

### Real-world example: authenticated order-status notifications

Requirements: only the order's owner may subscribe; status changes come from a Celery task; messages must not be lost across reconnects; the ORM is used from the consumer.

```python
# orders/consumers.py
from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from .models import Order

class OrderStatusConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self):
        user = self.scope["user"]
        self.order_id = int(self.scope["url_route"]["kwargs"]["order_id"])
        if not user.is_authenticated or not await self.owns_order(user.pk, self.order_id):
            # Accept, then close with an app-defined code (4000-4999) so the client
            # can tell "not allowed" (do not retry) from a network drop (retry).
            await self.accept()
            await self.close(code=4403 if user.is_authenticated else 4401)
            return
        self.group = f"order_{self.order_id}"
        await self.channel_layer.group_add(self.group, self.channel_name)
        await self.accept()
        # Send current state immediately: covers anything missed while disconnected.
        await self.send_json({"type": "snapshot", **await self.current_state()})

    async def disconnect(self, code):
        if hasattr(self, "group"):
            await self.channel_layer.group_discard(self.group, self.channel_name)

    async def receive_json(self, content, **kwargs):
        if content.get("action") == "ping":
            await self.send_json({"type": "pong"})

    async def order_status(self, event):              # type "order.status"
        await self.send_json({"type": "status", "status": event["status"],
                              "version": event["version"]})

    @database_sync_to_async
    def owns_order(self, user_id: int, order_id: int) -> bool:
        return Order.objects.filter(pk=order_id, customer_id=user_id).exists()

    @database_sync_to_async
    def current_state(self) -> dict:
        o = Order.objects.only("status", "version").get(pk=self.order_id)
        return {"status": o.status, "version": o.version}
```

```python
# orders/routing.py
from django.urls import path
from .consumers import OrderStatusConsumer

websocket_urlpatterns = [path("ws/orders/<int:order_id>/", OrderStatusConsumer.as_asgi())]
```

The producer is synchronous code (a Celery task), so it bridges into the async layer API with `async_to_sync`:

```python
# orders/tasks.py
from functools import partial
from asgiref.sync import async_to_sync
from celery import shared_task
from channels.layers import get_channel_layer
from django.db import transaction
from django.db.models import F
from .models import Order

def _notify(order_id: int, status: str, version: int) -> None:
    async_to_sync(get_channel_layer().group_send)(
        f"order_{order_id}",
        {"type": "order.status", "status": status, "version": version},
    )

@shared_task(acks_late=True)
def mark_shipped(order_id: int) -> None:
    with transaction.atomic():
        updated = Order.objects.filter(pk=order_id).exclude(status="shipped").update(
            status="shipped", version=F("version") + 1
        )
        if not updated:
            return                                    # idempotent: already shipped
        version = Order.objects.values_list("version", flat=True).get(pk=order_id)
        # Push only after commit, so a client that refetches sees the new state.
        transaction.on_commit(partial(_notify, order_id, "shipped", version))
```

The client keeps the highest `version` it has seen, ignores older events, and reconnects with exponential backoff; on reconnect, the server's `snapshot` message resynchronises it. That turns the channel layer's at-most-once delivery into an eventually consistent UI.

### Token authentication for non-browser clients

Browsers send cookies on WebSocket handshakes, but mobile apps usually hold a JWT. Browsers cannot set custom headers on `new WebSocket()`, so tokens travel in the query string (logged by proxies — keep them short-lived) or in the `Sec-WebSocket-Protocol` header. A minimal middleware:

```python
# api/ws_auth.py
from urllib.parse import parse_qs
from channels.db import database_sync_to_async
from channels.middleware import BaseMiddleware
from django.contrib.auth.models import AnonymousUser
from rest_framework_simplejwt.authentication import JWTAuthentication

@database_sync_to_async
def user_from_token(raw: str):
    auth = JWTAuthentication()
    try:
        return auth.get_user(auth.get_validated_token(raw))
    except Exception:
        return AnonymousUser()

class JWTAuthMiddleware(BaseMiddleware):
    async def __call__(self, scope, receive, send):
        token = parse_qs(scope["query_string"].decode()).get("token", [None])[0]
        scope["user"] = await user_from_token(token) if token else AnonymousUser()
        return await super().__call__(scope, receive, send)
```

### Server-Sent Events: the simpler alternative

For one-way updates you do not need Channels at all. Under ASGI (Django 4.2+), `StreamingHttpResponse` accepts an async iterator:

```python
# notifications/views.py
import asyncio, json
from django.http import StreamingHttpResponse

async def events(request):
    async def stream():
        last = 0
        while True:
            # In production read from Redis pub/sub instead of polling.
            async for n in Notification.objects.filter(user_id=request.user.pk, pk__gt=last).order_by("pk"):
                last = n.pk
                yield f"id: {n.pk}\ndata: {json.dumps({'text': n.text})}\n\n"
            await asyncio.sleep(2)
    resp = StreamingHttpResponse(stream(), content_type="text/event-stream")
    resp["Cache-Control"] = "no-cache"
    resp["X-Accel-Buffering"] = "no"      # tell Nginx not to buffer
    return resp
```

The browser's `EventSource` reconnects automatically and sends `Last-Event-ID`, which gives you resume-from-offset for free. See [REST API · Streaming, SSE & WebSockets](../rest-api/topic.html?p=30-streaming-sse-websockets).

## 6. Advantages, Disadvantages & Trade-offs

| Approach | Direction | Infra | Strengths | Weaknesses |
|---|---|---|---|---|
| Short polling | client → server | none | Trivial, cacheable, works everywhere | Wasteful, latency = interval |
| Long polling | client → server | async server ideal | Near real-time, plain HTTP | Reconnect per message, holds connections |
| SSE | server → client | ASGI server | Auto-reconnect, `Last-Event-ID` resume, plain HTTP | One-way; browser per-domain connection limits on HTTP/1.1 |
| WebSockets + Channels | both | ASGI + Redis layer | Full duplex, low latency, groups | Stateful connections, auth/scaling complexity, at-most-once layer |
| Managed service (Pusher, Ably, AWS API Gateway WS) | both | external | No socket fleet to run | Cost, vendor lock-in, data leaves your infra |

### When to use

- Chat, collaborative editing, multiplayer/live dashboards where the client also sends frequently.
- Push notifications to logged-in users where latency matters (sub-second).
- Progress of background jobs (Celery task → group → browser).

### When NOT to use

- One-way feeds: SSE is simpler and resumes natively.
- Low-frequency updates (once a minute): polling with HTTP caching is cheaper to run.
- Guaranteed delivery of business events: persist and use a real queue; the channel layer drops.
- When you cannot run an ASGI fleet and Redis: use a managed WebSocket service.

## 7. Common Mistakes & Best Practices

**Calling the ORM directly from an async consumer.** `Order.objects.get(...)` inside `async def connect` raises `SynchronousOnlyOperation`. Use `database_sync_to_async` (or the async ORM methods like `aget()` for simple reads; Channels' wrapper additionally closes stale connections).

**Importing models before `get_asgi_application()`.** `asgi.py` that imports `chat.routing` (which imports consumers, which import models) at the top raises `AppRegistryNotReady`. Call `get_asgi_application()` first.

**Forgetting `AllowedHostsOriginValidator`.** The browser attaches the session cookie to a WebSocket opened by *any* site; without an Origin check, evil.example can open a socket as your user (cross-site WebSocket hijacking). CSRF middleware does not run on WebSockets.

**Using `InMemoryChannelLayer` in production.** Groups work only within one process; with two replicas, half your users never see messages. It is for tests.

**Treating the layer as a queue.** Sending important data only via `group_send` loses it whenever a client is disconnected or a channel is full. Persist first, push second, resync on connect.

**Blocking the event loop.** `time.sleep`, `requests.get` or a heavy JSON parse inside an async consumer stalls every connection in that process. Use async libraries (`httpx.AsyncClient`) or offload to a thread/Celery.

**Group names with invalid characters.** `f"chat_{user.email}"` contains `@`, which is invalid (group names must be ASCII alphanumerics, hyphens, underscores or periods, under 100 characters). Use IDs.

**Not discarding groups on disconnect.** Stale memberships linger until `group_expiry`, and `group_send` keeps writing to dead channels until they expire, wasting Redis memory.

**Best practices**

- Authorise in `connect()`. Rejecting before `accept()` gives the client only a generic failure; accept-then-close with an application code (4000–4999) lets the client distinguish "forbidden, stop retrying" from a network drop.
- Keep consumers thin: they translate between socket and domain services.
- Version or sequence-number events so clients can drop stale ones and detect gaps.
- Send an application-level heartbeat; idle-timeout proxies silently kill quiet sockets.
- Push from `transaction.on_commit` so clients that refetch see committed state.

## 8. Production: Pitfalls, Debugging & Scaling

> **Production story:** Every deploy caused a five-minute Redis CPU spike and a flood of 502s. Root cause: 40,000 sockets disconnected at once, every client reconnected instantly, and each `connect()` ran two database queries and a `group_add`. Fix: exponential backoff with jitter on the client, staggered rollout of ASGI pods, a connection-rate limit at the load balancer, and caching the ownership check.

**Sockets dropping after 60 seconds.** Symptom: clients disconnect at a suspiciously round interval. Root cause: Nginx `proxy_read_timeout` defaults to 60 s, and load balancers have idle timeouts. Fix: raise the timeouts for `/ws/` and send pings more often than the shortest idle timeout.

```text
location /ws/ {
    proxy_pass http://asgi_upstream;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
}
```

**Handshake works locally, fails behind the proxy.** Missing `Upgrade`/`Connection` headers or HTTP/1.0 proxying. In Kubernetes, the Ingress controller needs WebSocket support configured — see [Kubernetes · Ingress](../kubernetes/topic.html?p=11-ingress).

**`ChannelFull` exceptions or silently missing messages.** A slow client's mailbox fills (capacity 100 by default). Raise `capacity` per channel pattern in `CONFIG`, reduce message rate (coalesce updates), or drop slow consumers.

**Database connection exhaustion.** Each `database_sync_to_async` call runs in a thread pool thread with its own connection. Thousands of sockets doing frequent queries create many connections; keep socket-path queries rare and cached, and budget connections ([Ch 34 · Scaling Django: Connections, Replicas & Multiple Databases](topic.html?p=34-scaling-databases)).

**Graceful deploys.** A rolling restart closes every socket on the old pod. Clients must reconnect with jittered backoff, and the server must send a snapshot on connect. Use `preStop` hooks and generous termination grace periods so pods drain.

**Debugging**

- Browser DevTools → Network → WS shows frames, close codes and handshake headers.
- `websocat ws://localhost:8000/ws/chat/lobby/` from a terminal.
- Log `connect`/`disconnect` with user id, path and close code; count open connections as a gauge metric.
- `redis-cli MONITOR` (development only) to watch `group_send` traffic; `redis-cli --bigkeys` to spot huge groups.
- Test with `channels.testing.WebsocketCommunicator` ([Ch 33 · Testing Django Applications](topic.html?p=33-testing)).

**Scaling.** An async process can hold thousands of mostly idle sockets; the limits are memory per connection, file descriptors (`ulimit -n`), and how much work each message triggers. Scale ASGI pods on connection count. The Redis layer becomes the bottleneck for very large groups (`group_send` to 100,000 members is 100,000 list pushes); shard with multiple Redis hosts in `CONFIG` (channels_redis consistently hashes channels across them), avoid giant groups (fan out per region or per shard), or move to `RedisPubSubChannelLayer` for broadcast-heavy workloads. Beyond that, dedicated real-time gateways (or a managed service) take over. Background reading: [System Design · Real-Time Protocols](../system-design/topic.html?p=08-realtime-protocols).

## 9. Interview Questions

**Q: Why can't you serve WebSockets with Gunicorn's default sync workers?**
A: WSGI is a synchronous call-and-return interface: the application receives `environ`, returns an iterable response, and the request is over. A WebSocket is a long-lived, bidirectional connection that must receive and send many messages over minutes or hours. A sync worker would be pinned for the whole connection lifetime, so a handful of sockets would exhaust the server. ASGI defines an async `(scope, receive, send)` interface that supports long-lived connections, and an ASGI server (Daphne, uvicorn) multiplexes thousands of them on an event loop.

**Q: What is a channel layer and why do you need one?**
A: It is a cross-process messaging system, normally `channels_redis.core.RedisChannelLayer`, that lets any code send a message to a specific consumer's channel or to a named group. You need it because sockets are spread across many server processes and machines; a consumer in process 1 cannot reach a socket held in process 3 without a shared bus. It is also how code without a socket — a view, a Celery task — pushes to users, via `async_to_sync(channel_layer.group_send)`. Without a layer (or with the in-memory one) groups only work inside one process.

**Q: How do groups and the `type` key work?**
A: A group is a named set of channel names; consumers join with `group_add(group, self.channel_name)` and leave with `group_discard`. `group_send(group, {"type": "chat.message", ...})` delivers the dict to every member's channel. Each receiving consumer dispatches on `type`, replacing dots with underscores, so `chat.message` calls `self.chat_message(event)`. The handler typically forwards the data to its socket with `send()` or `send_json()`.

**Q: How do you authenticate WebSocket connections in Channels?**
A: For browsers, wrap the router in `AuthMiddlewareStack`, which reads the session cookie sent on the handshake and populates `scope["user"]` exactly like `request.user`. Check `self.scope["user"].is_authenticated` and authorisation in `connect()` and close if it fails. Wrap everything in `AllowedHostsOriginValidator` because CSRF protection does not apply to WebSockets and browsers send cookies cross-site. For mobile/API clients, write a middleware that validates a short-lived token from the query string or subprotocol header, since browsers cannot set custom headers on WebSocket handshakes.

**Q: What happens if you call the Django ORM inside an `AsyncWebsocketConsumer`?**
A: Django detects the running event loop and raises `SynchronousOnlyOperation`, because the ORM is synchronous and would block the loop for every connection in the process. Wrap ORM code in `channels.db.database_sync_to_async`, which runs it in a worker thread and also closes stale database connections around the call. For simple reads the async ORM API (`aget`, `afirst`, `async for`) also works, but it still runs the query in a thread under the hood. Alternatively use the sync `WebsocketConsumer`, which Channels runs in a thread for you.

**Q: What delivery guarantees does the Redis channel layer provide?**
A: At-most-once with no persistence. Messages expire (default 60 seconds), channels have a capacity (default 100) after which sends fail or are dropped, and a disconnected consumer simply never receives what was sent while it was away. There is no replay. So you never use the layer as the source of truth: write the event to the database, then push a notification, and have clients fetch missed data on reconnect.

**Q: When would you choose Server-Sent Events over WebSockets?**
A: When updates flow only from server to client — notifications, live scores, progress bars, log tails. SSE is plain HTTP, works through most proxies and caches without special config, and `EventSource` reconnects automatically and sends `Last-Event-ID` so you can resume. It needs an ASGI server (or it pins sync workers) and does not support client-to-server messages, which you send with normal POSTs. Pick WebSockets when the client sends frequent messages too, like chat or collaborative editing.

**Q: Why does `asgi.py` call `get_asgi_application()` before importing your routing module?**
A: `get_asgi_application()` calls `django.setup()`, which configures settings and populates the app registry. Your routing imports consumers, which import models, and importing models before the registry is ready raises `AppRegistryNotReady`. Creating the Django ASGI app first guarantees the registry is loaded. That is why the documented `asgi.py` has imports after that line, usually with `noqa` comments.

**Q: How would you push the progress of a Celery task to the user's browser?**
A: The consumer for the task page joins a group like `task_<id>` on connect, after verifying the user owns the task. The Celery task, which is synchronous, calls `async_to_sync(get_channel_layer().group_send)("task_<id>", {"type": "task.progress", "pct": 40})` at checkpoints. The consumer's `task_progress` method forwards it to the socket. Also store progress in the DB or cache so a client that connects late gets the current value immediately in `connect()`.

**Q: Your chat app works with one server but users miss messages after you scale to four pods. What is wrong? (Senior)**
A: The most likely cause is the in-memory channel layer (or no layer), so groups exist per process and `group_send` only reaches consumers in the sender's pod. Configure `RedisChannelLayer` pointing all pods to the same Redis. If it is already Redis, check for different `prefix` or Redis DB settings between deployments, `ChannelFull` drops for slow clients, and dropped connections due to proxy idle timeouts. Even when fixed, design for loss: persist messages and have the client fetch messages after its last-seen ID on reconnect.

**Q: How would you design real-time notifications for a million connected users? (Senior)**
A: Split the problem. A stateless ASGI connection tier holds sockets (each process tens of thousands of mostly idle connections), scaled on connection count with high file descriptor limits; regular HTTP stays on the WSGI fleet. Use per-user groups (`user_<id>`) rather than giant broadcast groups, shard the channel layer across several Redis instances, and coalesce high-frequency updates. Notifications are persisted first, fanned out by background workers, and pushed best-effort; clients resync via REST on reconnect with a cursor. Plan reconnect storms during deploys with jittered backoff and LB rate limits — or recognise when a managed real-time service is cheaper than running this.

**Q: How do you secure a Channels deployment against cross-site WebSocket hijacking and abuse? (Senior)**
A: Wrap the WebSocket stack in `AllowedHostsOriginValidator` (or `OriginValidator` with an explicit list) so foreign origins cannot open authenticated sockets with the user's cookies. Authorise in `connect()` per resource, not just "is logged in", and re-check permissions on sensitive actions because the scope is fixed for the connection's life (a revoked user stays connected until you close them — keep a per-user group and send a "force logout" event). Validate and size-limit every incoming message, rate-limit messages per connection, and cap connections per user at the edge. Use `wss://` only, and never put long-lived tokens in query strings that end up in access logs.

**Q: How do you test a consumer?**
A: Use `channels.testing.WebsocketCommunicator(application, "/ws/chat/lobby/")` inside an async test (`pytest-asyncio` or Django's async test support): `connected, _ = await communicator.connect()`, `await communicator.send_json_to({...})`, `await communicator.receive_json_from()`, then `await communicator.disconnect()`. Configure `InMemoryChannelLayer` in test settings. Wrap the application with the same middleware as production when testing auth, or set `communicator.scope["user"]` directly. Database access from these tests needs `transaction=True` style tests because the consumer's ORM calls run in other threads.

## 10. Quick Revision & Cheat Sheet

| Piece | Name | Remember |
|---|---|---|
| Entrypoint | `ProtocolTypeRouter` in `asgi.py` | `get_asgi_application()` first |
| Routing | `URLRouter([...path(..., Consumer.as_asgi())])` | kwargs in `scope["url_route"]["kwargs"]` |
| Auth | `AuthMiddlewareStack` | `scope["user"]`, session cookie |
| Origin check | `AllowedHostsOriginValidator` | CSRF does not cover WebSockets |
| Consumer | `AsyncWebsocketConsumer` / `AsyncJsonWebsocketConsumer` | one instance per connection |
| Layer | `channels_redis.core.RedisChannelLayer` | at-most-once, expiry, capacity |
| Broadcast | `group_add` / `group_send` / `group_discard` | `type` "a.b" calls `a_b()` |
| From sync code | `async_to_sync(layer.group_send)` | Celery tasks, views, signals |
| ORM | `database_sync_to_async` | else `SynchronousOnlyOperation` |
| Server | Daphne / uvicorn | `"daphne"` first in INSTALLED_APPS for runserver |

- WebSockets need ASGI; WSGI workers would be pinned.
- The channel layer connects processes; in-memory layer = single process only.
- Persist first, push second, resync on reconnect.
- Authorise in `connect()`; close with 4xxx codes.
- Proxies need `Upgrade`/`Connection` headers and long read timeouts.
- Never block the event loop in an async consumer.
- Reconnect storms on deploy: jittered backoff on clients.
- SSE is the simpler choice for one-way updates.

## 11. Hands-On Exercises

Setup: `python -m venv .venv && pip install "django~=5.2" "channels~=4.1" "daphne~=4.1" "channels-redis~=4.2"`, Redis via `docker run -p 6379:6379 redis:7`.

1. **Chat room.** Build the simple example, open two browser tabs and chat. Then switch to `InMemoryChannelLayer`, run two Daphne processes on different ports, and observe that cross-process messages vanish. Switch back to Redis.
2. **Auth and Origin.** Require login in `connect()`. From a page served on another port, try to open the socket and confirm `AllowedHostsOriginValidator` rejects it.
3. **Celery to browser.** Write a task that sleeps 10 times for 1 s and pushes progress to `task_<id>`; render a progress bar.
4. **Lossy layer.** Disconnect a client, send five messages, reconnect. Then add persistence and a "since last id" snapshot on connect so nothing is missed.
5. **SSE.** Implement the same notifications as an async `StreamingHttpResponse` endpoint and compare code size and proxy configuration.

**Mini project:** a live order tracker. REST endpoint to change status (staff), Celery task that updates status and pushes on commit, `OrderStatusConsumer` with ownership checks, versioned events and snapshot-on-connect, Nginx config with WebSocket headers, and a `WebsocketCommunicator` test suite.

## 12. Related Topics & Free Learning Resources

- [Ch 30 · Async Django & ASGI](topic.html?p=30-async-django-asgi) — ASGI, `sync_to_async`, async ORM.
- [Ch 31 · Background Tasks with Celery](topic.html?p=31-celery-background-tasks) — tasks that push to groups.
- [Ch 28 · Security: CSRF, XSS, SQL Injection & Hardening](topic.html?p=28-security) — Origin checks and CSRF.
- [Ch 35 · Deployment & Production Operations](topic.html?p=35-deployment-production) — running an ASGI fleet.
- [REST API · Streaming, SSE & WebSockets](../rest-api/topic.html?p=30-streaming-sse-websockets), [System Design · Real-Time Protocols](../system-design/topic.html?p=08-realtime-protocols), [Redis · Streams, Pub/Sub & Invalidation](../redis-caching/topic.html?p=21-streams-pubsub-invalidation).

- **Channels documentation** — Channels · *Beginner* · the official tutorial (chat app) and topic guides on consumers, routing and layers. <https://channels.readthedocs.io/>
- **channels_redis** — GitHub · *Intermediate* · layer configuration: capacity, expiry, group_expiry, sharding, Pub/Sub layer. <https://github.com/django/channels_redis>
- **How to deploy with ASGI** — Django docs · *Intermediate* · `get_asgi_application`, Daphne, uvicorn and Hypercorn. <https://docs.djangoproject.com/en/5.2/howto/deployment/asgi/>
- **Asynchronous support** — Django docs · *Intermediate* · async views, `SynchronousOnlyOperation`, sync_to_async semantics. <https://docs.djangoproject.com/en/5.2/topics/async/>
- **ASGI specification** — asgiref docs · *Advanced* · scope, events and the WebSocket sub-protocol in detail. <https://asgi.readthedocs.io/>
- **The WebSocket API** — MDN · *Beginner* · browser-side API, close codes and events. <https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API>
- **Using server-sent events** — MDN · *Beginner* · `EventSource`, event format and reconnection. <https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events>

---

*Django Handbook — chapter 32.*
