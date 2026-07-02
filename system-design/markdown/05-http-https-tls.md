# 05 · HTTP, HTTPS & TLS

> **In one line:** HTTP is the request/response language of the web; HTTPS is HTTP inside a TLS-encrypted, authenticated tunnel — and the evolution from 1.1 → 2 → 3 is a decade-long war on latency and head-of-line blocking.

---

## 1. Overview

**HTTP (HyperText Transfer Protocol)** is a stateless, text-oriented request/response protocol: a client sends a *method + path + headers (+ body)*, a server returns a *status code + headers (+ body)*. That simplicity is why it carries essentially all web APIs, not just web pages. But statelessness and simplicity came at a latency cost that three protocol generations have fought to fix.

**HTTPS** is just HTTP carried over **TLS (Transport Layer Security)**. TLS adds three guarantees: **confidentiality** (eavesdroppers see ciphertext), **integrity** (tampering is detected), and **authentication** (you're really talking to `bank.com`, proven by a certificate signed by a trusted CA). Since ~2018 HTTPS is effectively mandatory — browsers mark plain HTTP "Not Secure," and HTTP/2 and HTTP/3 are TLS-only in practice.

The real story of HTTP is **latency reduction**. HTTP/1.1 could only run one request at a time per connection (or a fragile "pipeline"), so browsers opened 6 connections per host and still queued. **HTTP/2** multiplexed many streams over one TCP connection. **HTTP/3** moved onto **QUIC** (over UDP) to kill TCP's head-of-line blocking entirely and fold the TLS handshake into the transport handshake.

Example: loading a modern page pulls 80+ resources. Over HTTP/1.1 that's a connection-juggling, round-trip-bound mess; over HTTP/2 it's one connection with 80 interleaved streams; over HTTP/3 those streams no longer stall each other on a single lost packet. Same HTTP semantics — radically different wire performance.

## 2. Core Concepts

- **Request/response & statelessness** — each request is independent; state lives in cookies, tokens, or the server. Idempotency and caching build on this.
- **Methods** — `GET` (read, safe, idempotent, cacheable), `POST` (create/act, not idempotent), `PUT` (replace, idempotent), `PATCH` (partial), `DELETE` (idempotent), `HEAD`, `OPTIONS` (CORS preflight).
- **Status codes** — `2xx` success (200, 201, 204), `3xx` redirect (301 permanent, 302/307 temp, 304 not-modified), `4xx` client error (400, 401, 403, 404, 409, 429), `5xx` server error (500, 502, 503, 504).
- **Headers** — metadata: `Content-Type`, `Cache-Control`/`ETag`, `Authorization`, `Accept`, `Host` (routing), `Set-Cookie`, `Content-Encoding` (gzip/br). The control surface of HTTP.
- **Keep-alive / persistent connections** — reuse one TCP connection for many requests, amortizing the setup cost. Default in HTTP/1.1.
- **HTTP/2 multiplexing** — many concurrent **streams** over one connection, binary-framed, with header compression (HPACK) and server push (now deprecated).
- **HTTP/3 over QUIC** — streams are independent at the transport layer, so one lost packet stalls only its own stream, not all of them.
- **TLS handshake** — negotiates cipher + keys and authenticates the server via its certificate before any application data flows.
- **Certificates & chain of trust** — a server cert signed by an intermediate CA, chained to a root CA in the OS/browser trust store. This is what "authentication" means.
- **TLS 1.3** — 1-RTT handshake (vs 2-RTT in 1.2), optional 0-RTT resumption, and removal of legacy/insecure ciphers.

## 3. Architecture

An HTTPS request layers HTTP on TLS on the transport (TCP for h1/h2, QUIC/UDP for h3). TLS is usually **terminated at the edge** (CDN or load balancer), which then talks HTTP(S) to backends.

```svg
<svg viewBox="0 0 760 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker>
  </defs>
  <rect x="20" y="120" width="120" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="80" y="146" text-anchor="middle" fill="#1e293b">Client</text>
  <text x="80" y="164" text-anchor="middle" fill="#64748b" font-size="11">browser / app</text>

  <rect x="230" y="105" width="170" height="90" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="315" y="130" text-anchor="middle" fill="#1e293b">Edge / LB (CDN)</text>
  <text x="315" y="150" text-anchor="middle" fill="#64748b" font-size="11">TLS termination</text>
  <text x="315" y="168" text-anchor="middle" fill="#64748b" font-size="11">h2/h3 ↔ client</text>
  <text x="315" y="184" text-anchor="middle" fill="#64748b" font-size="11">cert + keys here</text>

  <rect x="500" y="60" width="150" height="52" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="575" y="90" text-anchor="middle" fill="#1e293b">Service A</text>
  <rect x="500" y="130" width="150" height="52" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="575" y="160" text-anchor="middle" fill="#1e293b">Service B</text>
  <rect x="500" y="200" width="150" height="52" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="575" y="230" text-anchor="middle" fill="#1e293b">Service C</text>

  <line x1="140" y1="150" x2="226" y2="150" stroke="#475569" stroke-width="1.5" marker-end="url(#a2)"/>
  <text x="183" y="142" text-anchor="middle" fill="#64748b" font-size="11">HTTPS</text>
  <text x="183" y="168" text-anchor="middle" fill="#64748b" font-size="11">(TLS)</text>

  <line x1="400" y1="140" x2="496" y2="88" stroke="#475569" stroke-width="1.5" marker-end="url(#a2)"/>
  <line x1="400" y1="150" x2="496" y2="156" stroke="#475569" stroke-width="1.5" marker-end="url(#a2)"/>
  <line x1="400" y1="160" x2="496" y2="224" stroke="#475569" stroke-width="1.5" marker-end="url(#a2)"/>
  <text x="450" y="196" text-anchor="middle" fill="#64748b" font-size="11">HTTP or mTLS</text>
  <text x="450" y="212" text-anchor="middle" fill="#64748b" font-size="11">(internal)</text>
</svg>
```

## 4. How It Works

A cold HTTPS/1.3 request over TCP, round-trip by round-trip:

1. **DNS** resolves the hostname to an IP (see **DNS**).
2. **TCP handshake** — SYN → SYN-ACK → ACK establishes the connection (**1 RTT**).
3. **TLS 1.3 handshake** — `ClientHello` (offered ciphers, key share, SNI) → `ServerHello` + certificate + `Finished`; client verifies the cert chain and sends `Finished` (**1 RTT**). Keys are now derived.
4. **HTTP request** — client sends `GET /path` with headers over the encrypted channel.
5. **Server processing** — routing, auth, business logic, DB calls.
6. **HTTP response** — status line + headers + body (often gzip/brotli compressed, possibly chunked).
7. **Reuse** — the connection stays open (keep-alive); subsequent requests skip steps 2–3 entirely (0 setup RTT).

So a cold HTTPS request pays ~**2 RTTs** of setup before the first byte of the HTTP request (TCP + TLS 1.3). HTTP/3/QUIC folds transport + TLS into **1 RTT** (and **0-RTT** on resumption).

```text
h1.1/h2 over TCP+TLS1.3:  [TCP 1-RTT][TLS 1-RTT][HTTP req→resp]  ≈ 2 RTT to first byte
h3 over QUIC (fresh):     [QUIC+TLS 1-RTT][HTTP req→resp]        ≈ 1 RTT
h3 over QUIC (resumed):   [0-RTT: send req with first packet]   ≈ 0 RTT
```

## 5. Key Components / Deep Dive

### HTTP/1.1 vs HTTP/2 vs HTTP/3
| | HTTP/1.1 | HTTP/2 | HTTP/3 |
|---|---|---|---|
| Transport | TCP | TCP | **QUIC (UDP)** |
| Framing | Text | Binary | Binary |
| Concurrency | 1/connection (6 conns/host) | Multiplexed streams | Multiplexed streams |
| Head-of-line blocking | Yes (app layer) | **Fixed at app layer, remains at TCP** | **Eliminated** (per-stream) |
| Header compression | None | HPACK | QPACK |
| Handshake to first byte | TCP+TLS (~2 RTT) | TCP+TLS (~2 RTT) | QUIC+TLS (**1 RTT**, 0-RTT resume) |
| Connection migration | No | No | **Yes (conn ID)** |

**The key insight:** HTTP/2 fixed head-of-line (HOL) blocking at the *application* layer (independent streams) but a single lost TCP segment still stalls *all* streams because TCP delivers bytes in order. HTTP/3's QUIC gives each stream its own delivery guarantees, so a lost packet only stalls its own stream — a big win on lossy/mobile networks.

### The TLS 1.3 handshake & chain of trust
TLS authenticates the server with a **certificate**: a document binding a public key to a hostname, signed by a **Certificate Authority (CA)**. The client verifies a chain: server cert → intermediate CA → **root CA** pre-installed in the OS/browser trust store. It also checks validity dates, hostname match (SNI/SAN), and revocation (OCSP stapling). TLS 1.3 completes in **1 RTT** (vs 1.2's 2), uses only forward-secret ciphers (ephemeral ECDHE), and encrypts more of the handshake.

### 0-RTT resumption (and its danger)
On a *resumed* connection, TLS 1.3 lets the client send application data in the very first packet using a pre-shared key — **0-RTT**, saving a full round-trip. The catch: 0-RTT data is **replayable** (an attacker can resend the captured first packet). So 0-RTT must be restricted to **idempotent, safe requests** (e.g. `GET`), never `POST`/state-changing calls.

### Where to terminate TLS
- **At the CDN/edge**: lowest client latency (TLS handshake near the user), offloads crypto from origin. Traffic edge→origin is re-encrypted or over a private network.
- **At the load balancer**: centralizes certs, offloads backends; internal hop may be plaintext (trusted network) or **mTLS** (zero-trust).
- **End-to-end / at the service**: required for strict compliance or true zero-trust; more cert-management overhead. Service meshes (Envoy/Istio) automate per-service mTLS.

### Caching & conditional requests
`Cache-Control`, `ETag`, and `Last-Modified` let clients/CDNs cache and *revalidate* cheaply: a `304 Not Modified` returns no body. This is the single biggest lever for HTTP performance at scale.

## 6. Trade-offs

| Option | Pros | Cons |
|---|---|---|
| **HTTP/1.1** | Universal, simple, easy to debug/proxy | 1 request/conn; HOL blocking; many conns needed |
| **HTTP/2** | Multiplexing, header compression, 1 conn | TCP-level HOL blocking remains; server push a dud |
| **HTTP/3 (QUIC)** | No HOL blocking, 1-RTT/0-RTT, conn migration | UDP sometimes blocked; more CPU; newer tooling |
| **TLS terminate at edge** | Lowest latency, offloads origin | Edge sees plaintext; origin hop needs re-encryption |
| **End-to-end mTLS** | Zero-trust, compliance | Cert management overhead; more CPU/complexity |
| **TLS 1.3 0-RTT** | Saves a round-trip on resume | Replay risk → only for idempotent requests |

Default modern stack: **HTTP/3 (with h2 fallback) + TLS 1.3, terminated at the CDN edge**, mTLS internally for sensitive services. Enable 0-RTT only for safe methods.

## 7. When to Use / When to Avoid

**Use / prefer:**
- **HTTP/2 or /3** for browser-facing traffic with many small resources — multiplexing wins big.
- **HTTP/3** especially for mobile/lossy networks (kills HOL blocking) and connection migration across Wi-Fi↔cellular.
- **TLS 1.3 everywhere**; terminate at the edge for public traffic.
- **mTLS** for service-to-service in a zero-trust environment.

**Avoid / be careful:**
- **HTTP/3** where middleboxes block UDP/443 or you can't afford the CPU — keep h2 fallback.
- **0-RTT** for anything non-idempotent — replay attacks.
- **Server push** — deprecated; use `preload` hints or `103 Early Hints` instead.
- **Plain HTTP** anywhere on the public internet — it's unauthenticated and blockable/injectable.

## 8. Scaling & Production Best Practices

- **Terminate TLS at the edge**, reuse sessions, enable **OCSP stapling** to avoid a client-side revocation round-trip.
- **Keep-alive + connection pooling** on both client and server; tune idle timeouts.
- **Compress** text with **Brotli** (better than gzip) and set correct `Content-Type`/`Content-Encoding`.
- **Cache aggressively** with `Cache-Control` + `ETag`; serve `304`s; use immutable fingerprinted asset URLs.
- **Automate cert lifecycle** (ACME/Let's Encrypt, 90-day certs) — expired certs are a top outage cause; alert 30 days out.
- **Prefer TLS 1.3**, disable TLS 1.0/1.1 and weak ciphers; use ECDHE for forward secrecy.
- **Enable HTTP/2 & /3** with h1.1 fallback; advertise h3 via `Alt-Svc`.
- **Set timeouts and retries** carefully — retries only on idempotent methods to avoid duplicate side effects.

## 9. Failure Modes & Mitigations

| Failure | Impact | Mitigation |
|---|---|---|
| Expired/misconfigured TLS cert | Total outage; scary browser error | Automate renewal (ACME); alert 30d out; monitor expiry |
| Broken cert chain (missing intermediate) | Fails on some clients only | Serve full chain; test with SSL Labs |
| TCP HOL blocking on lossy net (h2) | Slow tail latency for all streams | Move to HTTP/3/QUIC |
| UDP/443 blocked by middlebox (h3) | h3 fails | Automatic fallback to h2 over TCP |
| 0-RTT replay | Duplicated state-changing request | Restrict 0-RTT to idempotent methods |
| Retry storm on 5xx | Cascading overload | Idempotent-only retries, backoff+jitter, circuit breakers |
| Slowloris (many slow connections) | Connection exhaustion | Connection/header timeouts, edge protection |

## 10. Monitoring & Metrics

- **TTFB (time to first byte)** and full request latency, p50/p95/p99.
- **TLS handshake time** and **handshake failure rate**; **cert expiry countdown** per hostname.
- **Status-code distribution** — watch 4xx/5xx rates, especially 429/503/504.
- **Protocol mix** — % of traffic on h1/h2/h3; h3 fallback rate.
- **Connection reuse ratio** and new-connection rate (low reuse = latency waste).
- **0-RTT usage & rejection rate.**
- **Retry rate** and **upstream timeout rate** (early cascade signal).
- **Cache hit ratio** and `304` rate at the edge.

## 11. Common Mistakes

1. ⚠️ **Letting a TLS cert expire** — the single most common self-inflicted outage; automate and alert.
2. ⚠️ **Serving an incomplete chain** (missing intermediate) — works in your browser (which cached it) but fails for others.
3. ⚠️ **Retrying non-idempotent POSTs** on timeout — creates duplicate charges/orders.
4. ⚠️ **Enabling 0-RTT for all methods** — opens replay attacks on state-changing requests.
5. ⚠️ **Assuming HTTP/2 fixed all HOL blocking** — TCP-level HOL blocking remains; only HTTP/3 removes it.
6. ⚠️ **Opening a new connection per request** — throwing away keep-alive and paying handshake cost every time.
7. ⚠️ **Using 302 where 301 is meant (or vice versa)** — SEO/caching consequences; 308/307 preserve the method.
8. ⚠️ **Weak ciphers / TLS 1.0-1.1 still enabled** — downgrade risk and compliance failures.

## 12. Interview Questions

1. **Q: Walk me through everything that happens between typing a URL and seeing the page, focused on HTTP/TLS.**
   A: DNS resolves the host → TCP handshake (1 RTT) → TLS 1.3 handshake with cert verification (1 RTT) → HTTP request over the encrypted channel → server processes → HTTP response (compressed, cacheable) → connection kept alive for reuse. First byte arrives ~2 RTT after connect for h1/h2, ~1 RTT for h3.

2. **Q: GET vs POST vs PUT — safety, idempotency, caching?**
   A: GET is safe (no side effects), idempotent, cacheable. POST is neither safe nor idempotent (creates/acts), not cacheable by default. PUT replaces and is idempotent. Idempotency matters for safe retries: you can retry GET/PUT/DELETE, but retrying POST risks duplicates.

3. **Q: What does TLS give you, and how does certificate trust work?**
   A: Confidentiality (encryption), integrity (tamper detection), authentication (proving server identity). Trust is a chain: the server cert is signed by an intermediate CA, chained up to a root CA pre-installed in the client's trust store; the client checks signature, validity dates, hostname (SAN), and revocation.

4. **Q: HTTP/1.1 → 2 → 3 — what problem does each generation solve?**
   A: 1.1 = one request per connection (browsers open ~6, still queue). HTTP/2 = binary multiplexing of many streams on one connection + header compression, fixing *app-layer* HOL blocking. HTTP/3 = moves to QUIC/UDP to remove *transport-layer* HOL blocking, cut the handshake to 1 RTT (0-RTT resume), and add connection migration.

5. **Q: What is head-of-line blocking and why didn't HTTP/2 fully solve it?**
   A: HOL blocking is when one stalled item blocks everything behind it. HTTP/2 multiplexes streams so they don't block at the app layer, but they still ride one TCP connection — and TCP guarantees in-order byte delivery, so one lost packet stalls *all* streams. QUIC gives each stream independent delivery, fixing this.

6. **Q [Senior]: Where would you terminate TLS in a multi-region, CDN-fronted architecture, and why?**
   A: Terminate at the CDN edge nearest the user for the lowest handshake latency and to offload origin crypto; re-encrypt edge→origin (or use a private backbone). For sensitive internal traffic use mTLS between services (often via a service mesh). The trade-off is who sees plaintext vs cert-management and CPU overhead.

7. **Q [Senior]: TLS 1.3 0-RTT saves a round-trip — what's the catch and how do you deploy it safely?**
   A: 0-RTT early data is replayable — an attacker can resend the captured first flight. So restrict 0-RTT to idempotent, safe requests (GET), reject it for state-changing methods, and add anti-replay windows/single-use tickets at the edge. It's a latency win only where replay is harmless.

8. **Q [Senior]: Your service sees a retry storm turning a minor blip into an outage. Trace the mechanism and fix it.**
   A: A slow/5xx upstream causes clients to time out and retry; retries multiply load, worsening the slowdown — a positive feedback loop. Fixes: retry only idempotent requests, use exponential backoff **with jitter**, cap attempts, add **circuit breakers** and load shedding (return 503 fast), and set aggressive but sane timeouts so threads don't pile up.

9. **Q [Staff]: You're rolling out HTTP/3. What breaks, how do you fall back, and how do you measure success?**
   A: Some networks block UDP/443 or rate-limit it, and some middleboxes mangle QUIC. Advertise h3 via `Alt-Svc` but keep h2-over-TCP as fallback (clients race/fallback automatically). Measure: % traffic on h3, h3 handshake success/fallback rate, and tail-latency (p99) improvement especially on mobile/lossy links — that's where QUIC's HOL-blocking fix pays off.

10. **Q [Staff]: How does connection migration in QUIC work and why does it matter?**
    A: QUIC identifies a connection by a **connection ID**, not the 4-tuple, so when a client's IP/port changes (Wi-Fi↔cellular, NAT rebind) the session survives without a new handshake. It matters for mobile: no dropped uploads or re-handshakes when the network path changes — impossible with TCP, whose connection is bound to the 4-tuple.

## 13. Alternatives & Related

- **TCP, UDP & QUIC** — the transports HTTP rides on; QUIC is why HTTP/3 exists.
- **DNS** — resolution happens before the first HTTP byte; DoH runs DNS *over* HTTPS.
- **Load Balancing** — L7 LBs route by HTTP headers/path and terminate TLS.
- **CDNs & Caching** — HTTP caching semantics (`Cache-Control`, `ETag`) are the foundation.
- **gRPC** — runs over HTTP/2, leveraging multiplexed streams for RPC.

## 14. Cheat Sheet

> [!TIP]
> **HTTP/TLS in one screen:**
> - **HTTP** = stateless request (method+path+headers+body) → response (status+headers+body). Methods: GET (safe/idempotent/cacheable), POST (neither), PUT/DELETE (idempotent).
> - **Status:** 2xx ok, 3xx redirect (301 perm/302 temp/304 not-modified), 4xx client (401/403/404/429), 5xx server (500/502/503/504).
> - **HTTPS = HTTP over TLS** → confidentiality + integrity + authentication (cert chain to a trusted root CA).
> - **h1.1** 1 req/conn → **h2** multiplexed streams (app-layer HOL fixed, TCP HOL remains) → **h3/QUIC** no HOL blocking, 1-RTT/0-RTT, connection migration.
> - **TLS 1.3** = 1-RTT handshake, forward secrecy, optional **0-RTT (idempotent only — replayable)**.
> - **Terminate TLS at the edge** for latency; **mTLS internally** for zero-trust.
> - **Automate cert renewal**; retry only idempotent requests with backoff+jitter.

**References:** MDN Web Docs — HTTP; Cloudflare Learning Center — TLS/SSL & HTTP/2/HTTP/3; "High Performance Browser Networking" (Grigorik); RFC 9110/9114 (HTTP/3); RFC 8446 (TLS 1.3).

---
*System Design Handbook — topic 05.*
