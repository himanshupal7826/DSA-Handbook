# 30 · Streaming: SSE, WebSockets & Chunked Responses

> **In one line:** When the client needs data as it becomes available rather than all at once, stop shaping the answer as one response body — chunk it, push it with Server-Sent Events, or open a WebSocket, and pick based on who needs to talk.

---

## 1. Overview

Request/response is a wonderful default and a bad fit for three situations: the result is produced incrementally (an LLM generating tokens, a report rendering page by page), the data changes continuously and the client must see it promptly (order-book prices, delivery tracking, job progress), or the conversation is genuinely bidirectional (collaborative editing, a game, a chat). In all three, the classical alternative is polling — and polling is a tax you pay forever. A dashboard polling `/v1/orders/status` every two seconds across 50,000 users generates 25,000 requests per second to answer "nothing changed" in the overwhelming majority of cases.

Streaming replaces that with a connection over which the server sends data when there is data. Three mechanisms matter for HTTP APIs. **Chunked transfer / incremental response bodies** keep the normal request/response shape but begin emitting bytes before the full body is known — this is how streaming LLM completions, NDJSON exports, and progressive CSV downloads work. **Server-Sent Events (SSE)** is a thin, standardized protocol on top of that: a `text/event-stream` response of `data:` lines with automatic browser reconnection and event IDs for resumption. **WebSockets (RFC 6455)** upgrade the connection to a full-duplex, framed, message-oriented channel where both sides can send at any time.

The history is worth one line: before 2011 the web faked push with **long polling** and **hidden-iframe "Comet"** hacks. The WebSocket protocol was standardized as RFC 6455 in 2011; SSE was standardized as part of HTML5 around the same period and lives in the WHATWG HTML specification. Long polling remains a legitimate fallback and is what most "realtime" libraries degrade to when a proxy blocks the alternatives.

**Concrete example.** OpenAI's and Anthropic's completion APIs stream tokens with SSE (`Accept: text/event-stream`, `data: {"delta":…}` frames, terminated by `data: [DONE]`) rather than WebSockets — because the interaction is one request and a one-directional stream of results, and SSE gives that with plain HTTP semantics, ordinary auth headers, and CDN compatibility. Slack, on the other hand, uses WebSockets for its client, because a chat client genuinely needs to send and receive continuously. Stripe uses neither for its API and instead sends webhooks (chapter 29), because the recipient is a *server*, not a live client. Three different products, three different correct answers.

The durable mental model is a decision on two axes: **who initiates** and **how long it lasts**. One request, incremental result → stream the response body (SSE or chunked). Server pushes updates indefinitely to a live client → SSE. Both sides send continuously → WebSocket. Server-to-server notification with no live client → webhooks. Most teams reach for WebSockets by reflex and inherit a stateful, hard-to-scale, hard-to-debug connection they did not need.

## 2. Core Concepts

- **Chunked transfer encoding** — HTTP/1.1 framing (`Transfer-Encoding: chunked`) that lets a server send a body of unknown length; HTTP/2 and HTTP/3 achieve the same with DATA frames and no such header.
- **Server-Sent Events (SSE)** — a `text/event-stream` response of newline-delimited `event:`/`data:`/`id:`/`retry:` fields; one-directional server → client, with built-in reconnection.
- **`Last-Event-ID`** — the header a reconnecting SSE client sends carrying the last `id:` it saw, letting the server resume from that point.
- **WebSocket** — a protocol (RFC 6455) that upgrades an HTTP connection into a persistent, full-duplex, message-framed channel over `ws://`/`wss://`.
- **Long polling** — the client issues a request the server holds open until data exists or a timeout fires, then immediately reissues; the universal fallback.
- **Backpressure** — the mechanism by which a slow consumer signals a fast producer to slow down; without it, buffers grow until the process dies.
- **Heartbeat / keep-alive** — periodic no-op frames (an SSE comment `:ping`, a WebSocket ping) that stop intermediaries from reaping an idle connection.
- **Fan-out** — delivering one event to many connected clients, typically via a pub/sub bus because connections are spread across many server instances.
- **Sticky vs stateless connections** — a streaming connection binds a client to one process, which complicates deployment, autoscaling, and load balancing.
- **NDJSON** — newline-delimited JSON (`application/x-ndjson`), the simplest streaming format for bulk exports: one complete JSON object per line.

## 3. Theory & Principles

**The three mechanisms, honestly compared.**

| | Chunked / NDJSON | SSE | WebSocket |
|---|---|---|---|
| Direction | Server → client, one response | Server → client, continuous | Full duplex |
| Protocol | Plain HTTP | Plain HTTP (`text/event-stream`) | Upgrade, then its own framing |
| Auth | Normal headers | Normal headers (except browser `EventSource`) | Handshake only; no custom headers from browsers |
| Reconnect | Client's problem | Automatic, with `Last-Event-ID` resume | Manual, you write it |
| Payload | Anything | UTF-8 text only | Text or binary |
| Proxy/CDN friendliness | High | High | Low — many proxies do not handle upgrades |
| Compression | Standard `Content-Encoding` | Standard, but disable buffering | `permessage-deflate` extension |
| Server cost | One request | One long-lived connection | One long-lived connection + state |
| Best for | Bulk export, token streaming | Live updates, progress, notifications | Chat, collaboration, games, trading |

**Why SSE is under-used.** It is plain HTTP: your existing authentication, rate limiting, observability, and load balancing all work unchanged. It reconnects automatically and resumes from `Last-Event-ID` with no client code. It is trivially debuggable — `curl -N` shows you the stream. Its two real limitations are that it is text-only (binary must be base64-encoded, costing 33%) and that the browser's native `EventSource` cannot set custom headers, so browser clients must pass tokens via cookies or a query parameter, or use `fetch` with a manual stream reader. HTTP/1.1's six-connections-per-origin limit used to be a third limitation; under HTTP/2 and HTTP/3 it disappears.

**Why WebSockets cost more than they look.** The connection is stateful, so every deployment drops every connection and the resulting reconnect storm can be larger than your steady-state load. Load balancers must be configured for long-lived upgrades. Autoscaling on CPU is misleading because the binding constraint is memory and file descriptors per connection. Browsers cannot attach an `Authorization` header to the handshake, so authentication is usually a ticket in the query string (which lands in access logs) or a first message after connect (which means you must handle unauthenticated connections). And you must write your own heartbeat, reconnect, backoff, and message-ordering logic, because the protocol gives you none of it.

**SSE wire format.** The framing is deliberately trivial: fields are `field: value` lines and a blank line dispatches the event. A `data:` field spanning multiple lines is joined with `\n`; `event:` sets the client-side event name (default `message`); `id:` is echoed back as `Last-Event-ID` on reconnect; `retry:` sets the client's reconnection delay in milliseconds; and comment lines beginning with `:` are ignored, which makes them perfect heartbeats.

**Backpressure is the hard part.** A producer generating 10,000 events per second into a client that can absorb 100 will fill a buffer somewhere. There are only four honest strategies, and you must pick one explicitly: **block** the producer (correct for a single-consumer export; unacceptable for fan-out, where one slow client would stall everyone), **drop** — shed the oldest or lowest-priority messages, which is right for tickers where only the latest value matters, **conflate** — keep only the newest value per key, which is what market-data systems do, or **disconnect** the slow consumer once its buffer crosses a threshold and let it reconnect and resume. Doing none of these means unbounded memory growth and an OOM kill, which is the most common streaming production incident.

**Buffering intermediaries will ruin your day.** nginx buffers proxied responses by default, so your carefully flushed SSE events arrive in one clump at the end. You must set `proxy_buffering off` (or send `X-Accel-Buffering: no`), disable `gzip` for the stream or ensure the compressor flushes per event, and raise `proxy_read_timeout` well above your heartbeat interval. The same applies to CDNs, API gateways, and any WAF that inspects response bodies.

```svg
<svg viewBox="0 0 780 366" width="100%" height="366" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="8" y="8" width="764" height="350" rx="14" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="390" y="34" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Four delivery shapes and when each is right</text>

  <rect x="26" y="52" width="356" height="136" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="204" y="74" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Polling &#8212; client asks repeatedly</text>
  <path d="M60 96 L340 96" stroke="#d97706" stroke-width="2" fill="none"/>
  <polygon points="340,96 332,92 332,100" fill="#d97706"/>
  <path d="M340 114 L60 114" stroke="#d97706" stroke-width="2" fill="none"/>
  <polygon points="60,114 68,110 68,118" fill="#d97706"/>
  <text x="352" y="118" fill="#1e293b" font-size="10">304</text>
  <path d="M60 136 L340 136" stroke="#d97706" stroke-width="2" fill="none"/>
  <polygon points="340,136 332,132 332,140" fill="#d97706"/>
  <path d="M340 154 L60 154" stroke="#d97706" stroke-width="2" fill="none"/>
  <polygon points="60,154 68,150 68,158" fill="#d97706"/>
  <text x="352" y="158" fill="#1e293b" font-size="10">304</text>
  <text x="204" y="178" text-anchor="middle" fill="#1e293b" font-size="10">simple, stateless &#8226; wasteful &#8226; latency = interval</text>

  <rect x="398" y="52" width="356" height="136" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="576" y="74" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">SSE &#8212; one request, many events</text>
  <path d="M432 96 L712 96" stroke="#0ea5e9" stroke-width="2" fill="none"/>
  <polygon points="712,96 704,92 704,100" fill="#0ea5e9"/>
  <text x="572" y="90" text-anchor="middle" fill="#1e293b" font-size="10">GET, Accept: text/event-stream</text>
  <path d="M712 118 L432 118" stroke="#16a34a" stroke-width="2" fill="none"/>
  <polygon points="432,118 440,114 440,122" fill="#16a34a"/>
  <path d="M712 138 L432 138" stroke="#16a34a" stroke-width="2" fill="none"/>
  <polygon points="432,138 440,134 440,142" fill="#16a34a"/>
  <path d="M712 158 L432 158" stroke="#16a34a" stroke-width="2" fill="none"/>
  <polygon points="432,158 440,154 440,162" fill="#16a34a"/>
  <text x="576" y="178" text-anchor="middle" fill="#1e293b" font-size="10">auto-reconnect + Last-Event-ID resume &#8226; text only</text>

  <rect x="26" y="204" width="356" height="136" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="204" y="226" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">WebSocket &#8212; full duplex</text>
  <path d="M60 248 L340 248" stroke="#16a34a" stroke-width="2" fill="none"/>
  <polygon points="340,248 332,244 332,252" fill="#16a34a"/>
  <text x="200" y="242" text-anchor="middle" fill="#1e293b" font-size="10">Upgrade: websocket &#8594; 101</text>
  <path d="M340 272 L60 272" stroke="#16a34a" stroke-width="2" fill="none"/>
  <polygon points="60,272 68,268 68,276" fill="#16a34a"/>
  <path d="M60 292 L340 292" stroke="#16a34a" stroke-width="2" fill="none"/>
  <polygon points="340,292 332,288 332,296" fill="#16a34a"/>
  <path d="M340 312 L60 312" stroke="#16a34a" stroke-width="2" fill="none"/>
  <polygon points="60,312 68,308 68,316" fill="#16a34a"/>
  <text x="204" y="332" text-anchor="middle" fill="#1e293b" font-size="10">binary ok &#8226; you write reconnect, heartbeat, auth</text>

  <rect x="398" y="204" width="356" height="136" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="576" y="226" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Chunked / NDJSON &#8212; one big answer</text>
  <path d="M432 250 L712 250" stroke="#4f46e5" stroke-width="2" fill="none"/>
  <polygon points="712,250 704,246 704,254" fill="#4f46e5"/>
  <text x="572" y="244" text-anchor="middle" fill="#1e293b" font-size="10">GET /v1/exports/orders</text>
  <rect x="432" y="264" width="90" height="20" rx="4" fill="#e0f2fe" stroke="#0ea5e9"/>
  <rect x="528" y="264" width="90" height="20" rx="4" fill="#e0f2fe" stroke="#0ea5e9"/>
  <rect x="624" y="264" width="90" height="20" rx="4" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="576" y="302" text-anchor="middle" fill="#1e293b" font-size="10">rows flushed as they are read &#8226; constant memory</text>
  <text x="576" y="322" text-anchor="middle" fill="#1e293b" font-size="10">no Content-Length &#8226; errors mid-stream are awkward</text>
</svg>
```

## 4. Architecture & Workflow

An SSE endpoint that streams live job progress to thousands of browsers, across many server instances.

1. **Client opens the stream.** `GET /v1/jobs/jb_7c1/events` with `Accept: text/event-stream`. A browser using `EventSource` cannot set an `Authorization` header, so authenticate with a cookie or a short-lived, single-use stream ticket in the query string — never a long-lived bearer token, because query strings land in access logs and `Referer` headers.
2. **Authenticate and authorize once, then re-check.** Validate at connect time, and if the token has an expiry shorter than the connection lifetime, terminate the stream when it expires and let the client reconnect with a fresh one. A connection opened an hour ago must not outlive the permission that opened it.
3. **Resume.** If the request carries `Last-Event-ID: 184402`, replay everything after that ID from a bounded buffer (Redis stream, Kafka offset, or a `WHERE sequence > $1` query) before switching to live. Without this, every reconnect loses whatever happened during the gap.
4. **Set the headers and flush immediately.** `Content-Type: text/event-stream`, `Cache-Control: no-store`, `Connection: keep-alive`, `X-Accel-Buffering: no`. Send an initial `retry: 3000` and a `:ping` comment so the client sees bytes at once and any intermediary opens its pipe.
5. **Subscribe.** The handler subscribes to a pub/sub channel (`job:jb_7c1`) on Redis or NATS. This is the piece that makes multi-instance deployment work: the worker producing progress publishes to the bus, and whichever instance holds the client's connection receives it.
6. **Fan out with backpressure.** Each connection has a bounded queue (say 100 messages). Producers write into it non-blockingly; if it is full, apply the policy you chose in section 3 — for progress events, conflate to the newest; for a chat, disconnect the slow client and let it resume.
7. **Heartbeat.** Emit `:ping\n\n` every 15–30 seconds. This defeats idle-connection reapers in load balancers (typically 60 s), NAT devices, and mobile networks, and it also lets the server notice a dead client because the write fails.
8. **Terminate cleanly.** On a terminal job state, send a final `event: done` frame and close. Clients must treat `done` as "stop reconnecting," because `EventSource` reconnects automatically otherwise and will loop forever on a finished job.
9. **Drain on deploy.** On `SIGTERM`, stop accepting new connections, send a `event: reconnect` with a jittered `retry:` value to existing ones, and close over a window of tens of seconds. Dropping 50,000 connections simultaneously produces a reconnect storm that can exceed your capacity.
10. **Observe.** Export active connection count, per-connection queue depth, messages dropped, and connection duration. Streaming failures are invisible in request-rate dashboards because there is only ever one request.

> **Note:** Steps 3, 6, and 9 are what separate a demo from a production stream. A stream with no resume loses data, a stream with no backpressure dies under load, and a stream with no drain strategy turns every deploy into an incident.

```svg
<svg viewBox="0 0 780 372" width="100%" height="372" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="8" y="8" width="764" height="356" rx="14" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="390" y="34" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Multi-instance SSE fan-out with resume and backpressure</text>

  <rect x="26" y="58" width="130" height="52" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="91" y="80" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">Browser A</text>
  <text x="91" y="97" text-anchor="middle" fill="#1e293b" font-size="10">EventSource</text>

  <rect x="26" y="126" width="130" height="52" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="91" y="148" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">Browser B</text>
  <text x="91" y="165" text-anchor="middle" fill="#1e293b" font-size="10">Last-Event-ID: 184402</text>

  <rect x="196" y="58" width="140" height="120" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="266" y="82" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">Load balancer</text>
  <text x="266" y="102" text-anchor="middle" fill="#1e293b" font-size="10">proxy_buffering off</text>
  <text x="266" y="120" text-anchor="middle" fill="#1e293b" font-size="10">read_timeout &gt; heartbeat</text>
  <text x="266" y="138" text-anchor="middle" fill="#1e293b" font-size="10">no response inspection</text>
  <text x="266" y="160" text-anchor="middle" fill="#1e293b" font-size="10">idle reaper &#8776; 60 s</text>

  <rect x="376" y="52" width="160" height="60" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="456" y="74" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">API instance 1</text>
  <text x="456" y="93" text-anchor="middle" fill="#1e293b" font-size="10">queue cap 100 / conn</text>

  <rect x="376" y="124" width="160" height="60" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="456" y="146" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">API instance 2</text>
  <text x="456" y="165" text-anchor="middle" fill="#1e293b" font-size="10">drop / conflate on full</text>

  <rect x="576" y="88" width="172" height="60" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="662" y="110" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">Pub/sub bus</text>
  <text x="662" y="129" text-anchor="middle" fill="#1e293b" font-size="10">channel job:jb_7c1</text>

  <path d="M156 84 L194 84" stroke="#4f46e5" stroke-width="2" fill="none"/>
  <polygon points="194,84 186,80 186,88" fill="#4f46e5"/>
  <path d="M156 152 L194 152" stroke="#4f46e5" stroke-width="2" fill="none"/>
  <polygon points="194,152 186,148 186,156" fill="#4f46e5"/>
  <path d="M336 96 L374 84" stroke="#4f46e5" stroke-width="2" fill="none"/>
  <polygon points="374,84 366,84 369,90" fill="#4f46e5"/>
  <path d="M336 140 L374 152" stroke="#4f46e5" stroke-width="2" fill="none"/>
  <polygon points="374,152 366,152 369,146" fill="#4f46e5"/>
  <path d="M536 90 L574 108" stroke="#0ea5e9" stroke-width="2" fill="none"/>
  <polygon points="574,108 566,106 569,101" fill="#0ea5e9"/>
  <path d="M536 148 L574 130" stroke="#0ea5e9" stroke-width="2" fill="none"/>
  <polygon points="574,130 566,132 569,137" fill="#0ea5e9"/>

  <rect x="576" y="176" width="172" height="56" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="662" y="198" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">Job workers</text>
  <text x="662" y="217" text-anchor="middle" fill="#1e293b" font-size="10">publish progress events</text>
  <path d="M662 176 L662 152" stroke="#16a34a" stroke-width="2" fill="none"/>
  <polygon points="662,152 658,160 666,160" fill="#16a34a"/>

  <rect x="26" y="248" width="352" height="100" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="42" y="270" fill="#1e293b" font-size="12" font-weight="700">Resume path</text>
  <text x="42" y="290" fill="#1e293b" font-size="11">Last-Event-ID: 184402 &#8594; replay from a bounded log</text>
  <text x="42" y="308" fill="#1e293b" font-size="11">(Redis stream / Kafka offset / WHERE seq &gt; 184402)</text>
  <text x="42" y="326" fill="#1e293b" font-size="11">then switch to live. Without it, gaps are lost forever.</text>
  <text x="42" y="342" fill="#1e293b" font-size="10">Buffer is bounded: too old &#8594; 409, tell the client to resync.</text>

  <rect x="398" y="248" width="350" height="100" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="414" y="270" fill="#1e293b" font-size="12" font-weight="700">Lifecycle discipline</text>
  <text x="414" y="290" fill="#1e293b" font-size="11">:ping every 15&#8211;30 s to beat idle reapers</text>
  <text x="414" y="308" fill="#1e293b" font-size="11">event: done &#8594; client stops reconnecting</text>
  <text x="414" y="326" fill="#1e293b" font-size="11">SIGTERM &#8594; jittered retry: value, drain over ~30 s</text>
  <text x="414" y="342" fill="#1e293b" font-size="10">Otherwise every deploy is a reconnect storm.</text>
</svg>
```

## 5. Implementation

### SSE on the wire

```http
GET /v1/jobs/jb_7c1/events HTTP/1.1
Host: api.zariya.in
Accept: text/event-stream
Last-Event-ID: 184402

HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-store
Connection: keep-alive
X-Accel-Buffering: no

retry: 3000

: ping

event: progress
id: 184403
data: {"job_id":"jb_7c1","progress":0.42,"stage":"rendering"}

event: progress
id: 184404
data: {"job_id":"jb_7c1","progress":0.87,"stage":"rendering"}

event: done
id: 184405
data: {"job_id":"jb_7c1","status":"succeeded","result_url":"/v1/reports/rpt_5f2"}
```

```bash
# -N disables curl's own buffering; this is the fastest way to debug an SSE endpoint.
curl -N -H 'Accept: text/event-stream' -H 'Last-Event-ID: 184402' \
  https://api.zariya.in/v1/jobs/jb_7c1/events
```

### FastAPI: SSE with resume, heartbeat and bounded backpressure

```python
import asyncio, json
from fastapi import APIRouter, Header, Request
from fastapi.responses import StreamingResponse

router = APIRouter()
HEARTBEAT_S, QUEUE_MAX = 20, 100
SSE_HEADERS = {"Cache-Control": "no-store", "Connection": "keep-alive",
               "X-Accel-Buffering": "no"}   # tell nginx not to buffer the response


def frame(event: str, data: dict, event_id: int | None = None) -> str:
    lines = [f"event: {event}"]
    if event_id is not None:
        lines.append(f"id: {event_id}")
    lines.append("data: " + json.dumps(data, separators=(",", ":")))
    return "\n".join(lines) + "\n\n"     # blank line dispatches the event


@router.get("/v1/jobs/{job_id}/events")
async def job_events(job_id: str, request: Request, bus=None, store=None,
                     last_event_id: str | None = Header(None, alias="Last-Event-ID")):

    async def stream():
        yield "retry: 3000\n\n"          # client reconnect delay
        yield ": ping\n\n"               # flush headers through any proxy immediately

        # 1. Resume from a bounded log before going live.
        if last_event_id:
            async for ev in store.replay(job_id, after=int(last_event_id)):
                yield frame(ev["type"], ev["data"], ev["id"])

        queue: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_MAX)

        async def on_message(ev):
            try:
                queue.put_nowait(ev)
            except asyncio.QueueFull:
                queue.get_nowait()          # 2. backpressure: drop oldest, keep newest
                queue.put_nowait(ev)

        await bus.subscribe(f"job:{job_id}", on_message)
        try:
            while not await request.is_disconnected():
                try:
                    ev = await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_S)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"      # 3. keep intermediaries from reaping us
                    continue
                yield frame(ev["type"], ev["data"], ev["id"])
                if ev["type"] == "done":    # 4. terminal: close cleanly
                    break
        finally:
            await bus.unsubscribe(f"job:{job_id}", on_message)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers=SSE_HEADERS)
```

### Browser client

```javascript
const es = new EventSource("/v1/jobs/jb_7c1/events", { withCredentials: true });

es.addEventListener("progress", e => {
  const { progress, stage } = JSON.parse(e.data);
  bar.style.width = `${progress * 100}%`;
  label.textContent = stage;
});

es.addEventListener("done", e => {
  render(JSON.parse(e.data));
  es.close();                 // MUST close, or EventSource reconnects forever
});

// EventSource retries automatically using the server's `retry:` value and
// replays Last-Event-ID; only surface an error if it stays down.
es.onerror = () => { if (es.readyState === EventSource.CLOSED) showOfflineBanner(); };
```

For a non-browser client, or when you need an `Authorization` header, use `fetch` with a stream reader instead of `EventSource`:

```javascript
const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`,
                                          Accept: "text/event-stream" } });
const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
for (let buf = "", i; ;) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += value;
  while ((i = buf.indexOf("\n\n")) !== -1) {      // frames end with a blank line
    handleFrame(buf.slice(0, i));
    buf = buf.slice(i + 2);
  }
}
```

### NDJSON export with constant memory

```python
@router.get("/v1/exports/orders")
async def export_orders(db=None):
    async def rows():
        # Server-side cursor: never materialize the full result set.
        async for row in db.cursor("SELECT * FROM orders ORDER BY id", prefetch=1000):
            yield json.dumps(row, separators=(",", ":")) + "\n"
    return StreamingResponse(rows(), media_type="application/x-ndjson")
```

### WebSocket, when duplex is genuinely required

```python
from fastapi import WebSocket, WebSocketDisconnect

@router.websocket("/v1/rooms/{room_id}/ws")
async def room_socket(ws: WebSocket, room_id: str, bus=None):
    if ws.headers.get("origin") not in ALLOWED_ORIGINS:
        return await ws.close(code=1008)   # same-origin policy does NOT cover WS
    await ws.accept()
    # Browsers cannot send Authorization on the handshake: authenticate on the
    # first message and close with a policy-violation code if it fails.
    try:
        hello = await asyncio.wait_for(ws.receive_json(), timeout=5)
        user = await authenticate(hello.get("token"))
    except Exception:
        return await ws.close(code=1008)

    async def push(ev):
        await ws.send_json(ev)

    await bus.subscribe(f"room:{room_id}", push)
    try:
        while True:
            msg = await ws.receive_json()
            await bus.publish(f"room:{room_id}", {"user": user.id, **msg})
    except WebSocketDisconnect:
        pass
    finally:
        await bus.unsubscribe(f"room:{room_id}", push)
```

### Optimization note

Three things dominate streaming cost. **Memory per connection** is the scaling limit: a Python async connection with a 100-message buffer costs a few tens of kilobytes, so 50,000 connections is one to two gigabytes before any application state — budget it deliberately and cap connections per instance rather than discovering the ceiling in production. **Flushing granularity** matters in both directions: flushing every token gives minimum latency and maximum syscalls, so for high-frequency streams batch on a small time window (10–50 ms) and send several events per flush. And **compression** interacts badly with streaming — gzip buffers to fill its window, so either disable it on `text/event-stream` or configure the compressor to flush per event; a stream that arrives in one clump at the end has silently become a slow non-streaming response.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost/Trade-off |
|---|---|---|
| Polling | Stateless, trivially scalable, works everywhere | Wasted requests; latency bounded by the interval |
| Long polling | Near-real-time with no new protocol; universal fallback | Holds a connection per client anyway, with all the reconnect churn |
| Chunked / NDJSON | Constant server memory on huge exports; low time-to-first-byte | No `Content-Length`; an error mid-stream cannot change the status code |
| SSE | Plain HTTP, auto-reconnect, `Last-Event-ID` resume, easy to debug | Text-only; browser `EventSource` cannot set custom headers |
| WebSocket | True full duplex, binary, low per-message overhead | Stateful, proxy-hostile, and you write reconnect/heartbeat/auth yourself |
| Pub/sub fan-out | Decouples producers from the instance holding the connection | An extra system to run, and delivery is at-most-once unless you add a log |
| Resume via event log | Reconnects lose nothing | Requires a durable, bounded, monotonically-ordered event store |
| Long-lived connections | Lowest possible latency | Every deploy is a mass disconnect; autoscaling and draining get complicated |

## 7. Common Mistakes & Best Practices

1. ⚠️ Reaching for WebSockets when data only flows server → client → ✅ use SSE: it is plain HTTP, reconnects and resumes for free, works through proxies, and needs no bespoke client code.
2. ⚠️ Forgetting `X-Accel-Buffering: no` / `proxy_buffering off` → ✅ nginx buffers proxied responses by default, so every event arrives in one clump at the end and your "stream" is a slow ordinary response.
3. ⚠️ No heartbeat → ✅ send `:ping` every 15–30 s; load balancers, NAT devices, and mobile networks reap idle connections at around 60 s, and the failed write is also how you detect a dead client.
4. ⚠️ Unbounded per-connection buffers → ✅ cap the queue and pick an explicit policy — block, drop, conflate, or disconnect. Unbounded buffering is the leading cause of streaming OOM kills.
5. ⚠️ No resume mechanism → ✅ emit monotonic `id:` values and honour `Last-Event-ID` from a bounded log; without it every reconnect silently loses whatever happened during the gap.
6. ⚠️ Not closing `EventSource` on completion → ✅ `EventSource` reconnects automatically forever; send a terminal `event: done` and call `es.close()` in the handler, or a finished job generates infinite reconnects.
7. ⚠️ Long-lived bearer tokens in the SSE/WebSocket query string → ✅ query strings land in access logs, proxy logs, and `Referer` headers; use a cookie, or a short-lived single-use stream ticket exchanged at connect time.
8. ⚠️ Authenticating only at connect → ✅ a connection opened an hour ago outlives the permission that opened it; enforce a maximum stream lifetime tied to token expiry and make the client reconnect.
9. ⚠️ Mass disconnect on deploy → ✅ drain on `SIGTERM` with a jittered `retry:` value over tens of seconds; 50,000 simultaneous reconnects can exceed your steady-state capacity.
10. ⚠️ Streaming an error after headers are sent → ✅ the status code is already `200`, so define an in-band `event: error` frame and document it; validate everything you can *before* the first byte.
11. ⚠️ Enabling gzip on `text/event-stream` without per-event flushing → ✅ the compressor buffers to fill its window and destroys the streaming property; disable it or configure flush-per-event.
12. ⚠️ Autoscaling streaming instances on CPU → ✅ the binding constraint is memory and file descriptors per connection, so scale on active connections and cap connections per instance.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** `curl -N` is the whole toolkit for SSE: if events appear immediately with `curl -N` against the origin but arrive in a clump through the load balancer, you have a buffering intermediary, and the fix is `proxy_buffering off` plus `X-Accel-Buffering: no`. If a stream dies at a suspiciously round interval — 60 seconds is the classic — you have found an idle-connection reaper and need a heartbeat shorter than it. In the browser, the Network panel shows an `EventSource` request in a pending state with an EventStream tab listing frames; a request that keeps restarting means the server is closing and the client is reconnecting, which usually means an unhandled exception in your generator. For WebSockets, log close codes: `1000` is normal, `1001` is going-away (often your own deploy), `1006` is abnormal closure with no close frame (a proxy or network drop), and `1008`/`1011` are your own policy and internal-error codes. Log every disconnect with its duration and code, since a streaming outage is invisible to a request-rate dashboard.

**Monitoring.** Track **active connections** per instance and in total (this is your capacity metric, not CPU), **connection duration histogram** (a bimodal shape with a spike at exactly 60 s is a reaper; a spike at your deploy interval is a drain problem), **messages sent per second** and **per-connection queue depth p99**, **messages dropped by backpressure policy** — which must be an explicit counter, not a silent condition — **reconnect rate** with the `Last-Event-ID` gap distribution, and **memory per connection** as a derived gauge. Alert on drop rate above zero for streams that promise delivery, on reconnect-rate spikes (they precede capacity problems), and on connection count approaching your per-instance cap.

**Security.** Streaming endpoints are long-lived, which turns several ordinary issues into serious ones. Authentication must have a bounded lifetime: enforce a maximum stream duration and require reconnection with a fresh credential, or a revoked token keeps receiving data indefinitely. Never accept a long-lived bearer token in a query string; issue a single-use, short-TTL stream ticket instead. For WebSockets, **validate the `Origin` header on the handshake** — the same-origin policy does not apply to WebSockets, so without this check any website can open an authenticated socket to your API using the victim's cookies (cross-site WebSocket hijacking). Rate-limit connections per user and per IP, since each connection is a held resource and connection floods are cheap to mount. Enforce a maximum inbound message size on WebSockets to avoid memory exhaustion, and apply per-connection message rate limits so a compromised client cannot flood your pub/sub bus. Finally, authorize each *subscription*, not just the connection: a client that connects legitimately must not be able to subscribe to another tenant's channel by sending a channel name.

**Performance & scaling.** Connections are memory and file descriptors, so raise `ulimit -n`, tune your event loop, and cap connections per instance so you fail predictably instead of thrashing. Fan-out belongs on a pub/sub bus (Redis pub/sub, NATS, Kafka) so any instance can serve any client, and horizontal scaling means adding instances rather than resharding clients. Prefer conflation over queuing for high-frequency state updates: sending the latest value beats sending every intermediate value nobody will render. Batch small events into a single flush on a 10–50 ms timer to trade a little latency for a large syscall reduction. And design deployments around drain: rolling restarts with a drain window, jittered client reconnect delays, and — if you can afford it — a dedicated connection tier that you deploy far less often than your business logic.

## 9. Interview Questions

**Q: When would you choose SSE over WebSockets?**
A: When data flows only server → client, which covers notifications, progress updates, live dashboards, and token streaming. SSE is plain HTTP, so existing auth, rate limiting, proxying, and observability work unchanged, and it gives automatic reconnection with `Last-Event-ID` resume for free. WebSockets are worth their cost only when the client also needs to send continuously.

**Q: How does SSE reconnection and resumption work?**
A: The server assigns each event an `id:`. If the connection drops, the browser's `EventSource` automatically reconnects after the delay given by the server's `retry:` field and includes `Last-Event-ID: <the last id it saw>`. The server reads that header and replays events after that ID from a bounded log before switching back to live, so the client loses nothing in the gap.

**Q: Why must SSE responses disable proxy buffering?**
A: nginx and many other reverse proxies buffer upstream responses by default to free the backend faster. That defeats streaming entirely: events accumulate and arrive in a single clump when the response ends. Setting `X-Accel-Buffering: no` or `proxy_buffering off` — and disabling or flush-configuring gzip — is required for events to reach the client as they are produced.

**Q: What is backpressure and what happens without it?**
A: Backpressure is how a slow consumer makes a fast producer slow down. Without it, undelivered messages accumulate in an unbounded buffer until the process runs out of memory and is killed — the most common streaming production failure. You must pick a bounded policy explicitly: block the producer, drop oldest, conflate to the latest value per key, or disconnect the slow consumer and let it resume.

**Q: Why do streaming connections need heartbeats?**
A: Load balancers, NAT devices, and mobile carriers close connections that have been idle for around 60 seconds, and neither side is notified. A periodic no-op — an SSE `:ping` comment or a WebSocket ping frame every 15–30 seconds — keeps the path open, and the write failing is also how the server discovers the client is gone.

**Q: How do you report an error that happens mid-stream?**
A: You cannot change the status code, because `200` was already sent with the headers. Define an in-band error frame (`event: error` with a problem-details payload) and document it as part of the contract, then close the stream. This is why you should perform all cheap validation before emitting the first byte — an invalid request should get a real `400` rather than a `200` followed by an error frame.

**Q: What is the difference between chunked transfer and SSE?**
A: Chunked transfer encoding is an HTTP/1.1 framing mechanism that lets a server send a body without knowing its length in advance; it says nothing about the content. SSE is a specific media type and message format (`text/event-stream` with `event:`/`data:`/`id:` fields) layered on top of that streaming capability, adding event names, IDs, reconnection, and resumption semantics. In HTTP/2 and HTTP/3 there is no `Transfer-Encoding` header at all — streaming is native to the framing layer — but SSE works identically.

**Q: (Senior) Design a live dashboard for 100,000 concurrent viewers. What are the constraints?**
A: The binding constraint is connections, not requests: at roughly 30 KB per connection that is about 3 GB of memory plus 100,000 file descriptors, so you cap connections per instance and scale horizontally, decoupling delivery through a pub/sub bus so any instance can serve any viewer. Use SSE rather than WebSockets because the flow is one-directional, and conflate updates per key so viewers receive the latest value rather than every intermediate one. The hardest problem is deployment: a rolling restart disconnects everyone, so drain with jittered `retry:` values over tens of seconds and consider a separate connection tier deployed less frequently than the application.

**Q: (Senior) How do you authenticate a browser WebSocket or EventSource connection securely?**
A: Neither browser API lets you set an `Authorization` header on the handshake, so the options are a cookie (with `SameSite` and `Secure`, plus mandatory `Origin` validation because the same-origin policy does not protect WebSockets), or a short-lived single-use ticket obtained from an authenticated endpoint and passed in the query string. Never pass a long-lived bearer token in a query string — it lands in access logs, proxy logs, and `Referer` headers. Whichever you choose, bound the connection's lifetime to the credential's expiry and force a reconnect, and authorize each subscription rather than only the connection.

**Q: (Senior) Your streaming service OOMs under load. Walk through the diagnosis.**
A: The near-certain cause is unbounded per-connection buffering: producers are outpacing consumers and messages are accumulating in queues with no cap. Confirm it with per-connection queue depth p99 and memory-per-connection metrics, then fix it structurally by capping every queue and choosing an explicit overflow policy — conflate for state updates, drop-oldest for tickers, disconnect-and-resume for anything that must not be lost. Secondary causes worth checking are connection leaks where the cleanup path does not run on abnormal disconnect, and per-connection replay buffers for `Last-Event-ID` that were never bounded.

**Q: (Senior) Why is a mass reconnect after deploy dangerous, and how do you mitigate it?**
A: All connections drop simultaneously and every client reconnects at once, producing a spike that includes authentication, subscription setup, and resume replay — work that is far more expensive per connection than steady-state delivery, and which arrives exactly when your fleet is partly restarted. Mitigations are graceful drain on `SIGTERM` spread over tens of seconds, a jittered `retry:` value so clients do not synchronize, exponential backoff with jitter in the client, capping resume-replay length, and isolating the connection tier so business-logic deploys do not touch it.

**Q: When is polling still the right answer?**
A: When updates are infrequent, latency requirements are loose, or the client is a server-to-server integration behind a firewall. Polling is stateless, trivially load-balanced, survives any proxy, and costs nothing to operate — and with `ETag`/`If-None-Match` a poll that finds nothing new is a cheap `304`. Streaming is a real operational commitment, so it should be justified by a latency or efficiency requirement rather than adopted by default.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Choose by direction and duration. One request with an incremental result → stream the body as chunked/NDJSON. Server pushing to a live client → **SSE**: plain HTTP, `text/event-stream`, `event:`/`id:`/`data:` frames separated by blank lines, automatic reconnect, and resume via `Last-Event-ID`. Both sides talking continuously → **WebSocket**, accepting that it is stateful, proxy-hostile, and that you write reconnect, heartbeat, and auth yourself. Server-to-server with no live client → webhooks (chapter 29). In production you must: disable proxy buffering (`X-Accel-Buffering: no`), heartbeat every 15–30 s to beat idle reapers, bound every per-connection queue with an explicit drop/conflate/disconnect policy, emit monotonic event IDs and honour `Last-Event-ID`, send a terminal `event: done` so `EventSource` stops reconnecting, and drain gracefully with jittered `retry:` on deploy. Scale on connection count, not CPU; fan out through a pub/sub bus; validate `Origin` on WebSocket handshakes and never put long-lived tokens in query strings.

| Item | Value |
|---|---|
| SSE content type | `text/event-stream; charset=utf-8` |
| SSE frame | `event: name` / `id: 42` / `data: {...}` + blank line |
| SSE heartbeat | `: ping` comment line |
| SSE reconnect delay | `retry: 3000` (milliseconds) |
| SSE resume | Client sends `Last-Event-ID`, server replays after it |
| Required headers | `Cache-Control: no-store`, `X-Accel-Buffering: no` |
| WebSocket handshake | `Upgrade: websocket` → `101 Switching Protocols` |
| WS close codes | `1000` normal · `1001` going away · `1006` abnormal · `1008` policy |
| Bulk export | `application/x-ndjson`, one object per line |
| Heartbeat interval | 15–30 s (must beat the ~60 s idle reaper) |
| Debug / scaling metric | `curl -N …` · scale on active connections, not CPU |

**Flash cards**

- **SSE vs WebSocket in one line** → SSE is one-directional plain HTTP with free reconnect and resume; WebSocket is full duplex and you build everything else yourself.
- **What ends an SSE event?** → A blank line. Fields are `event:`, `id:`, `data:`, `retry:`; a leading `:` is a comment used as a heartbeat.
- **How resumption works** → The server sends `id:` on each event; the client sends `Last-Event-ID` on reconnect; the server replays from a bounded log.
- **The four backpressure policies** → Block, drop, conflate, or disconnect. Choosing none means an OOM kill.
- **Why validate `Origin` on WebSocket handshakes** → The same-origin policy does not apply to WebSockets, so without it any site can open an authenticated socket with the victim's cookies.

## 11. Hands-On Exercises & Mini Project

- [ ] Build an SSE endpoint that streams job progress, then run it behind nginx with default settings and watch every event arrive at the end. Fix it with `proxy_buffering off` and confirm with `curl -N`.
- [ ] Remove the heartbeat and leave a connection idle behind a load balancer until it dies. Record the exact interval — that number is your reaper timeout, and your heartbeat must be shorter.
- [ ] Implement `Last-Event-ID` resume against a Redis stream, then kill the connection mid-stream and prove no events were lost. Then bound the log and verify a too-old `Last-Event-ID` produces a clean resync signal.
- [ ] Implement all four backpressure policies behind a flag, drive a 10,000 msg/s producer into a 100 msg/s consumer, and chart memory usage for each.
- [ ] Convert a paginated bulk export to NDJSON with a server-side cursor and compare peak RSS against the buffered version on a 5-million-row table.

### Mini Project — A live job-progress and chat service

**Goal.** Ship both patterns in one service so you feel the difference: SSE for one-directional progress, WebSockets for a genuinely duplex room.

**Requirements.**
1. `GET /v1/jobs/{id}/events` (SSE) streams `progress` and `done` events with monotonic IDs, `retry: 3000`, a 20 s `:ping` heartbeat, and `Last-Event-ID` resume from a Redis stream.
2. Every connection has a 100-message bounded queue with a conflate-on-full policy and a `stream_messages_dropped_total` counter.
3. Fan out through Redis pub/sub so two API instances behind a load balancer both serve correctly, proven by a test that pins clients to different instances.
4. `GET /v1/exports/orders` streams NDJSON from a server-side cursor with constant memory, verified on a million rows.
5. `WS /v1/rooms/{id}/ws` authenticates via a first message, validates `Origin`, enforces a max message size and per-connection rate limit, and authorizes the room subscription separately from the connection.
6. Graceful drain on `SIGTERM`: stop accepting, send a jittered `retry:`, close over 30 s. Export active connections, queue depth p99, drops, and reconnect rate, then load test 5,000 concurrent SSE clients and report memory per connection and p99 event latency.

**Extensions.**
- Add a long-polling fallback endpoint and make the client degrade to it when SSE fails twice.
- Implement conflation keyed by `job_id` so a burst of progress events collapses to the newest, and measure the bandwidth saved.
- Run the load test through a CDN and document which of SSE, WebSockets, and NDJSON survive it unchanged.

## 12. Related Topics & Free Learning Resources

**Related chapters.** *Async APIs, Webhooks & Long-Running Jobs* (chapter 29) — webhooks are the server-to-server counterpart; SSE is the live-client one. *Payload Optimization, HTTP/2 & HTTP/3* (chapter 26) — multiplexing removes SSE's old six-connection limit, and compression must be flush-configured for streams. *HTTP Caching* (chapter 25) — streams are `no-store`, and polling with `ETag` is the cheap alternative. *API Security* — `Origin` validation, ticket-based auth, and connection rate limits. *Rate Limiting* — connections are a resource that needs its own quota.

- **MDN — Using Server-Sent Events** — Mozilla · *Beginner* · the clearest practical guide to the `EventSource` API, the wire format, reconnection, and `Last-Event-ID`, with runnable examples. <https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events>
- **WHATWG HTML Standard — Server-Sent Events** — WHATWG · *Advanced* · the normative specification for the `text/event-stream` format and the exact parsing and reconnection algorithm. <https://html.spec.whatwg.org/multipage/server-sent-events.html>
- **RFC 6455 — The WebSocket Protocol** — IETF · *Advanced* · handshake, framing, close codes, and the security considerations section that explains why `Origin` validation is mandatory. <https://www.rfc-editor.org/rfc/rfc6455.html>
- **MDN — Writing WebSocket Servers** — Mozilla · *Intermediate* · what actually happens during the upgrade and in the framing layer; essential before you debug a `1006` close. <https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API/Writing_WebSocket_servers>
- **OWASP — WebSocket Security Cheat Sheet** — OWASP · *Intermediate* · cross-site WebSocket hijacking, origin validation, authentication patterns, and input handling for long-lived connections. <https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html>
- **web.dev — Streams API** — Google · *Intermediate* · how to consume streaming responses in the browser with `fetch` and `ReadableStream`, which is how you do SSE with an `Authorization` header. <https://web.dev/articles/streams>
- **High Performance Browser Networking — Ch. 16–17** — Ilya Grigorik (free online) · *Advanced* · the definitive free comparison of XHR polling, SSE, and WebSockets, including proxy behaviour and per-connection costs. <https://hpbn.co/server-sent-events-sse/>
- **nginx Docs — `proxy_buffering` and `X-Accel-Buffering`** — nginx · *Intermediate* · the configuration reference for the single most common reason a streaming endpoint does not stream. <https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering>

---

*REST API Handbook — chapter 30.*
