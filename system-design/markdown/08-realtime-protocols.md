# 08 · WebSockets, SSE, Polling & Long-Polling

> **In one line:** Four ways to move server-side updates to a client, trading latency and freshness against connection cost and infrastructure complexity.

---

## 1. Overview

HTTP is **request/response**: the client asks, the server answers, done. But many features are *server-driven* — a new chat message, a live score, a stock tick, a "your order shipped" toast. The server has fresh data and no way to hand it to a client that isn't currently asking. The four techniques here are the spectrum of answers to "how does the server push?"

**Short polling** fakes push by asking repeatedly on a timer. **Long polling** holds the request open until data exists, approximating push over plain HTTP. **Server-Sent Events (SSE)** is a native one-way server→client stream over a single long-lived HTTP response. **WebSockets** upgrades the connection to a full-duplex, persistent, low-overhead channel for true bidirectional messaging.

The core tension is **freshness vs cost**. Polling is simple and works everywhere but wastes requests and adds latency. Persistent connections (SSE/WebSocket) give sub-100ms delivery but each one is a live socket + memory + file descriptor on a server, so *scaling to millions of concurrent connections* becomes the hard problem.

Example: a live-scores page can use SSE (server→client only). A collaborative editor or multiplayer game needs WebSockets (both directions, tiny frames). A dashboard refreshing every 30s is fine with short polling.

## 2. Core Concepts

- **Short polling** — client sends a request every N seconds; server replies immediately with data-or-empty. Simple, stateless, but wasteful and average latency ≈ N/2.
- **Long polling** — server *holds* the request open (no data yet) and responds the instant an event arrives; client immediately re-requests. Near-real-time over vanilla HTTP.
- **Server-Sent Events (SSE)** — a single HTTP response of `Content-Type: text/event-stream` that stays open; server writes `data:` frames. **Unidirectional** (server→client), text-only, with **built-in auto-reconnect** and event IDs (`Last-Event-ID`).
- **WebSocket** — starts as an HTTP `GET` with `Upgrade: websocket`, then switches protocols to a persistent **full-duplex** TCP channel of lightweight frames (2–14 byte headers). Binary or text.
- **Upgrade handshake** — the 101 Switching Protocols response with `Sec-WebSocket-Accept`; after it, the bytes are WebSocket frames, not HTTP.
- **Connection state cost** — every persistent connection is memory (buffers), a file descriptor, and (for TLS) session state on the server; this bounds how many you can hold per box.
- **Sticky sessions / connection affinity** — because a persistent connection lives on one server, the LB must keep that client pinned to it (or use a shared backplane).
- **Backpressure & heartbeats** — slow consumers must be flow-controlled; idle connections need ping/pong (or SSE comment lines) to survive proxy/NAT timeouts (~30–120s).
- **Fan-out backplane** — to broadcast to clients spread across many connection servers, you publish through Redis Pub/Sub or Kafka so every server can push to its local sockets.

## 3. Architecture

Short/long polling reuse the stateless HTTP path — any load-balanced app server works. SSE and WebSockets require **stateful connection servers**: the client pins to one node (sticky routing), and cross-node broadcast rides a **pub/sub backplane**.

```svg
<svg viewBox="0 0 720 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="22" text-anchor="middle" fill="#1e293b" font-weight="700">Scaling persistent connections (WebSocket / SSE)</text>

  <!-- clients -->
  <rect x="30" y="60" width="110" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="85" y="80" text-anchor="middle" fill="#1e293b">Client A</text>
  <rect x="30" y="150" width="110" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="85" y="170" text-anchor="middle" fill="#1e293b">Client B</text>
  <rect x="30" y="240" width="110" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="85" y="260" text-anchor="middle" fill="#1e293b">Client C</text>

  <!-- LB -->
  <rect x="200" y="140" width="110" height="50" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="255" y="162" text-anchor="middle" fill="#1e293b">L7 LB</text>
  <text x="255" y="178" text-anchor="middle" fill="#64748b" font-size="10">sticky / hash</text>

  <line x1="140" y1="75" x2="200" y2="150" stroke="#475569" marker-end="url(#a2)"/>
  <line x1="140" y1="165" x2="200" y2="165" stroke="#475569" marker-end="url(#a2)"/>
  <line x1="140" y1="255" x2="200" y2="180" stroke="#475569" marker-end="url(#a2)"/>

  <!-- conn servers -->
  <rect x="370" y="70" width="130" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="435" y="88" text-anchor="middle" fill="#1e293b">Conn server 1</text>
  <text x="435" y="102" text-anchor="middle" fill="#64748b" font-size="10">holds A</text>
  <rect x="370" y="150" width="130" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="435" y="168" text-anchor="middle" fill="#1e293b">Conn server 2</text>
  <text x="435" y="182" text-anchor="middle" fill="#64748b" font-size="10">holds B</text>
  <rect x="370" y="230" width="130" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="435" y="248" text-anchor="middle" fill="#1e293b">Conn server 3</text>
  <text x="435" y="262" text-anchor="middle" fill="#64748b" font-size="10">holds C</text>

  <line x1="310" y1="158" x2="370" y2="90" stroke="#475569" marker-end="url(#a2)"/>
  <line x1="310" y1="165" x2="370" y2="168" stroke="#475569" marker-end="url(#a2)"/>
  <line x1="310" y1="172" x2="370" y2="248" stroke="#475569" marker-end="url(#a2)"/>

  <!-- backplane -->
  <rect x="560" y="140" width="130" height="60" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="625" y="164" text-anchor="middle" fill="#1e293b">Pub/Sub</text>
  <text x="625" y="182" text-anchor="middle" fill="#64748b" font-size="10">Redis / Kafka</text>

  <line x1="500" y1="90" x2="560" y2="150" stroke="#475569" marker-end="url(#a2)"/>
  <line x1="500" y1="170" x2="560" y2="170" stroke="#475569" marker-end="url(#a2)"/>
  <line x1="500" y1="250" x2="560" y2="190" stroke="#475569" marker-end="url(#a2)"/>
  <text x="625" y="222" text-anchor="middle" fill="#64748b" font-size="10">broadcast fan-out</text>
  <text x="625" y="238" text-anchor="middle" fill="#64748b" font-size="10">to all conn servers</text>
</svg>
```

## 4. How It Works

The **WebSocket upgrade** flow (the most protocol-heavy), then how a message travels:

1. **Client opens** an HTTP `GET` with `Connection: Upgrade`, `Upgrade: websocket`, and a random `Sec-WebSocket-Key`.
2. **Server responds `101 Switching Protocols`** with `Sec-WebSocket-Accept` (a hash of the key). From here the TCP connection is a WebSocket, not HTTP.
3. **Both sides send frames** — small framed messages (opcode + mask + payload), either direction, any time. No per-message HTTP headers.
4. **Heartbeats** — periodic ping/pong keep the connection alive through proxies/NATs and detect dead peers.
5. **Server pushes an event** — when a domain event fires, the owning service publishes it to the **backplane**.
6. **Fan-out** — every connection server subscribed to that topic receives it and writes the frame to its locally-held matching sockets.
7. **Close** — either side sends a close frame; the socket, FD, and buffers are released.

Contrast, briefly:

```text
Short poll:  req→(data|∅) ... wait N ... req→(data|∅)   latency ≈ N/2
Long poll:   req→ ...held... →data  → immediately re-req  latency ≈ 0
SSE:         req→ [stream: data,data,data,...]           server→client only
WebSocket:   handshake→ [frames both ways, persistent]   full duplex
```

## 5. Key Components / Deep Dive

### Short vs Long Polling
Short polling trades server load for simplicity: at 1s intervals, 1M clients = 1M req/s of mostly-empty responses. Long polling cuts the waste by holding the socket until data arrives — but a held request still occupies a connection/thread, so at scale you need async, non-blocking servers (event loops), and you must cap the hold time (~30s) to dodge proxy timeouts, then re-poll.

### Server-Sent Events (SSE)
A single `GET` returning `text/event-stream`; the server keeps writing `data:` (and optional `id:`, `event:`) lines. It is **unidirectional** and text-only, but comes with killer features: **automatic reconnection** by the browser `EventSource`, and **resumption** via `Last-Event-ID` so the server can replay missed events. Runs over normal HTTP/1.1 (mind the ~6-connection-per-domain limit; HTTP/2 multiplexing fixes it). Perfect for feeds, notifications, progress bars.

### WebSockets
Full-duplex, low-overhead (2–14 byte frame headers vs hundreds for HTTP), binary-capable. The right tool when the *client* also pushes frequently (chat, games, collaborative editing, live cursors). Costs: it bypasses HTTP semantics (you build your own auth-per-message, routing, backpressure), needs sticky routing, and reconnection/resume is your responsibility (unlike SSE's built-in reconnect).

### Scaling persistent connections
Each open connection ≈ tens of KB of kernel + app buffers plus one file descriptor; a tuned box holds ~100K–1M idle connections (raise `ulimit`/`somaxconn`, tune TCP buffers). Route with **sticky sessions** (or consistent hashing on connection id) so a client returns to its server. Broadcast across the fleet via a **Redis Pub/Sub or Kafka backplane**. Keep connection servers **thin and stateless-per-message** so you can add nodes horizontally; store durable state elsewhere.

## 6. Trade-offs

| Option | Pros | Cons |
|---|---|---|
| **Short polling** | Dead simple, stateless, works through any proxy/firewall, easy to scale | Wasted requests, latency ≈ interval/2, poor freshness, load scales with clients not events |
| **Long polling** | Near-real-time over plain HTTP, broad compatibility, no protocol upgrade | Held connections tie up resources, tricky timeout tuning, re-request overhead per event |
| **SSE** | Native server push, auto-reconnect + resume, simple text protocol, HTTP-friendly | One-way only, text only, per-domain connection limits on HTTP/1.1, no IE support |
| **WebSocket** | Full-duplex, lowest latency + overhead, binary, ideal for chat/games | Stateful (sticky + backplane), bypasses HTTP tooling/caching, you own reconnect/auth/backpressure |

If updates flow **only server→client** and you don't need binary, **SSE** is usually the sweet spot — simpler than WebSockets with 90% of the benefit. Choose **WebSocket** only when the client pushes frequently or you need binary/low-latency both ways. Choose **polling** when events are infrequent, freshness tolerance is seconds+, or infrastructure must stay stateless.

## 7. When to Use / When to Avoid

**Reach for it when:**
- **Short polling** — infrequent updates, tolerable staleness (dashboards refreshing every 15–60s), or clients/proxies that block long-lived connections.
- **Long polling** — need low latency but can't use SSE/WebSocket (legacy proxies), or as a graceful fallback.
- **SSE** — server→client feeds: notifications, live scores, log/progress streaming, LLM token streaming, price tickers.
- **WebSocket** — bidirectional, high-frequency: chat, multiplayer games, collaborative editing, live cursors, trading, IoT control.

**Avoid it when:**
- **Short/long polling** — you need sub-second delivery at high client counts (request storm).
- **SSE** — the client must send a steady stream too (it can't) or you need binary frames.
- **WebSocket** — updates are rare (a persistent socket is wasted cost), the network path blocks upgrades, or you can't run sticky routing + a backplane.

## 8. Scaling & Production Best Practices

- **Prefer SSE over WebSocket** for one-way flows — you inherit auto-reconnect/resume for free and keep HTTP semantics.
- **Sticky routing** by connection id (consistent hash) so reconnects and affinity hold; avoid pinning by IP alone.
- **Backplane for fan-out** — Redis Pub/Sub for low-latency broadcast, Kafka when you need durability/replay of the event stream.
- **Heartbeats** every 20–30s (WS ping/pong, SSE comment `:\n`) to survive NAT/proxy idle timeouts (~60s) and detect dead peers.
- **Tune the OS** — raise `ulimit -n`, `net.core.somaxconn`, ephemeral port range; expect ~100K–1M connections/node when tuned.
- **Backpressure** — bound per-connection send buffers; drop or coalesce for slow consumers instead of OOMing.
- **Graceful drain on deploy** — migrate connections with reconnect + resumable event IDs; don't hard-kill sockets.
- **Auth** — validate a token at connect; for WebSockets also re-check on sensitive messages since the initial handshake auth is a one-time gate.

## 9. Failure Modes & Mitigations

| Failure | Impact | Mitigation |
|---|---|---|
| Proxy/NAT kills idle connection | Silent dead sockets, missed messages | Heartbeats + client auto-reconnect |
| Thundering herd on reconnect (server restart) | Connection storm, CPU spike | Randomized/exponential backoff jitter on reconnect |
| Slow consumer | Server memory blows up buffering | Backpressure, bounded buffers, drop/coalesce |
| No sticky routing | Client lands on server without its session | Consistent-hash affinity or shared backplane state |
| Backplane (Redis) outage | Cross-node broadcast stops | HA/clustered backplane; degrade to local-only or polling |
| Connection-count ceiling per node | New clients rejected | Horizontal scale-out, raise FD/OS limits, autoscale on conn count |
| Lost events during disconnect | Gaps in the client's view | SSE `Last-Event-ID` / WS resume tokens to replay |

## 10. Monitoring & Metrics

- **Concurrent connections per node** and cluster-wide — the primary capacity signal; autoscale on it.
- **Connection churn** (opens/closes per sec) and **reconnect rate** — spikes reveal instability or deploys gone wrong.
- **Message delivery latency** (event created → client received), p50/p95/p99.
- **Per-connection send-buffer depth** — rising = slow consumers/backpressure.
- **Heartbeat/ping-pong failures** and dropped connections.
- **Backplane publish/subscribe lag** (Redis/Kafka).
- **File descriptor usage** vs `ulimit`, memory per connection.
- **Fallback rate** — how many clients degraded from WebSocket→SSE→polling.

## 11. Common Mistakes

1. ⚠️ Reaching for WebSockets when the flow is one-way — SSE would be simpler and free reconnect.
2. ⚠️ Short polling at 1s intervals for 1M users — a self-inflicted request storm.
3. ⚠️ No heartbeats → connections silently die behind proxies/NAT and messages vanish.
4. ⚠️ No sticky routing or backplane, so broadcasts only reach clients on one node.
5. ⚠️ Reconnect without jitter → synchronized thundering herd after any blip.
6. ⚠️ Ignoring backpressure; a slow client OOMs the connection server.
7. ⚠️ Authenticating only at the WebSocket handshake and trusting every later frame.
8. ⚠️ Forgetting HTTP/1.1's ~6-connections-per-domain limit throttles SSE (use HTTP/2).

## 12. Interview Questions

**Q: Difference between short polling and long polling?**
A: Short polling returns immediately (data or empty) and repeats on a timer — latency ≈ interval/2. Long polling holds the request open until data exists, then the client re-requests — latency ≈ 0, at the cost of held connections.

**Q: When would you pick SSE over WebSockets?**
A: When traffic is server→client only (feeds, notifications, token streaming). SSE gives native auto-reconnect and `Last-Event-ID` resume, stays HTTP-friendly, and is simpler than owning the WebSocket lifecycle.

**Q: Walk me through the WebSocket handshake.**
A: Client sends `GET` with `Upgrade: websocket` + `Sec-WebSocket-Key`; server replies `101 Switching Protocols` with `Sec-WebSocket-Accept`; the TCP connection then carries WebSocket frames bidirectionally.

**Q: Why are persistent connections hard to scale?**
A: Each is a live socket = memory + file descriptor + TLS state on one specific server. You hit per-node limits, need sticky routing to that node, and a backplane to broadcast across nodes.

**Q: What is a backplane and why do you need it?**
A: A pub/sub layer (Redis/Kafka) that lets any connection server publish an event so every other server can push it to its locally-held sockets — required because a client's socket lives on only one node.

**Q: How do you keep idle connections alive?**
A: Heartbeats — WebSocket ping/pong or SSE comment lines every 20–30s — to beat proxy/NAT idle timeouts (~60s) and detect dead peers.

**Q (Senior): 10M concurrent WebSocket connections — sketch the design.**
A: Thin, horizontally-scaled connection servers (~100K–1M conns each, OS-tuned), L7 LB with consistent-hash sticky routing, a Redis/Kafka backplane for fan-out, connection state (which user on which node) in a fast store, autoscale on connection count, resumable event IDs, and jittered reconnect.

**Q (Senior): How do you handle a slow consumer that can't keep up?**
A: Backpressure — bound per-connection send buffers; when full, either apply flow control (stop reading upstream), coalesce/drop stale updates (last-write-wins for tickers), or disconnect the client. Never let one slow socket exhaust server memory.

**Q (Senior): A server restart drops 500K connections — what happens and how do you soften it?**
A: All clients reconnect near-simultaneously (thundering herd). Mitigate with exponential backoff + jitter on the client, graceful drain that migrates connections over a window, and resumable event IDs so reconnects don't lose messages.

**Q (Senior): How do you guarantee message ordering and no-loss over these transports?**
A: Transports themselves don't guarantee end-to-end delivery. Use monotonic event IDs/sequence numbers, client acks, server-side replay from a durable log (Kafka) on reconnect via `Last-Event-ID`/resume token, and idempotent client handling of duplicates.

**Q (Senior): You must support real-time on a corporate network that blocks WebSocket upgrades. What's your fallback strategy?**
A: Feature-detect and degrade: try WebSocket → fall back to SSE → fall back to long polling. Libraries like Socket.IO do this automatically; keep the app-level message contract transport-agnostic.

**Q: Why doesn't SSE work for a chat app's send path?**
A: SSE is unidirectional (server→client). The client would still POST messages over separate HTTP requests. For symmetric high-frequency send/receive, WebSockets are the natural fit.

## 13. Alternatives & Related

- **Message Queues / Pub-Sub** — the backplane (Redis/Kafka) that powers cross-node fan-out.
- **Load Balancing** — L7 LBs and sticky sessions that route persistent connections.
- **API Styles (REST/GraphQL/gRPC)** — gRPC server-streaming is another server-push option for service-to-service.
- **Webhooks** — server→server push for asynchronous integration (no persistent client connection).
- **Rate Limiting** — protecting connection endpoints from abuse and reconnect storms.

## 14. Cheat Sheet

> [!TIP]
> **Short poll** = ask on a timer (simple, wasteful, latency≈interval/2). **Long poll** = hold request until data (near-real-time over HTTP). **SSE** = one-way server→client stream, auto-reconnect + resume, text only — the default for feeds/notifications. **WebSocket** = full-duplex persistent frames — for chat/games/collab.
> Persistent connections are **stateful**: each = a socket + FD on one node → need **sticky routing** + a **pub/sub backplane** (Redis/Kafka) for fan-out, **heartbeats** to stay alive, **backpressure** for slow consumers, and **jittered reconnect** to avoid herds. Tune OS for ~100K–1M conns/node. Prefer SSE unless the client must push too.

**References:** MDN — WebSockets API, MDN — Server-Sent Events, RFC 6455 (WebSocket Protocol), High Performance Browser Networking (Grigorik)

---
*System Design Handbook — topic 08.*
