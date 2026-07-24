# 02 · HTTP/2 Under gRPC: Streams, Frames & Multiplexing

> **In one line:** gRPC is not "inspired by" HTTP/2 — it is a precise mapping of RPC semantics onto HTTP/2 primitives, where one call is exactly one stream, request and response bodies are length-prefixed message frames, and the final status rides in trailers.

---

## 1. Overview

Every claim gRPC makes about performance traces back to HTTP/2. Understanding the transport is therefore not optional trivia: it is what lets you reason about why a stalled stream blocks, why a load balancer breaks your deploy, why `MaxConcurrentStreams` is the limit you hit first, and why gRPC cannot run over HTTP/1.1 without a translation layer.

HTTP/1.1's fundamental limitation is that a connection carries one request at a time. Pipelining was specified but is effectively unusable because responses must return in order — one slow response blocks every response behind it (**head-of-line blocking at the application layer**). The universal workaround was connection pooling: browsers opened six connections per origin, service clients opened dozens or hundreds. Each connection costs a TCP handshake, a TLS handshake, a separate congestion window that must warm up independently, kernel memory and a file descriptor.

**HTTP/2** (RFC 9113, formerly RFC 7540) replaces the text protocol with a **binary framing layer**. A single TCP connection carries many independent **streams**, each identified by a 31-bit stream id. Frames from different streams interleave freely; a slow stream does not block a fast one. Headers are compressed with **HPACK**, which uses a shared dynamic table so that repeating `:authority`, `content-type` and `authorization` across thousands of calls costs a few bytes rather than a few hundred. Each stream and the connection as a whole have independent **flow-control windows**, so a slow consumer applies backpressure to one stream rather than stalling everything.

gRPC's contribution is a **mapping**: an RPC is a stream, the request message(s) are DATA frames with a 5-byte length prefix, the method name is the `:path` pseudo-header, per-call key/value metadata are ordinary HTTP/2 headers, and the terminal status is a trailing HEADERS frame. Because that mapping is fully specified (the `PROTOCOL-HTTP2.md` document), any conformant HTTP/2 implementation in any language interoperates.

## 2. Core Concepts

- **Frame** — the unit of HTTP/2 transmission: a 9-byte header (length, type, flags, stream id) plus a payload. Types that matter here: `HEADERS`, `DATA`, `RST_STREAM`, `SETTINGS`, `WINDOW_UPDATE`, `PING`, `GOAWAY`.
- **Stream** — an independent, bidirectional sequence of frames within one connection, identified by a stream id. Client-initiated ids are odd; server-initiated (unused by gRPC) are even.
- **Multiplexing** — interleaving frames from many streams on one connection, so concurrency does not require more sockets.
- **HPACK** — header compression using a static table of common headers plus a per-connection dynamic table, plus Huffman coding of literals.
- **Pseudo-headers** — `:method`, `:scheme`, `:path`, `:authority`, `:status`. gRPC always uses `POST` and puts the fully-qualified method in `:path`.
- **Trailers** — a HEADERS frame sent *after* the DATA frames, carrying `grpc-status` and `grpc-message`. This is how gRPC reports failure after streaming has begun.
- **Length-prefixed message** — gRPC's own framing inside DATA: 1 byte compressed-flag + 4 bytes big-endian length + the serialised message. One DATA frame may hold several messages, or one message may span several DATA frames.
- **Flow control** — per-stream and per-connection credit windows (default 64 KiB) replenished by `WINDOW_UPDATE`. This is where real backpressure comes from.
- **`SETTINGS_MAX_CONCURRENT_STREAMS`** — the peer-advertised cap on simultaneously active streams. In grpc-go the server default is effectively unlimited (`math.MaxUint32`) but many proxies and other implementations set 100.
- **`GOAWAY`** — a graceful-shutdown frame telling the peer the highest stream id that will be processed, so in-flight calls finish while new ones go elsewhere. This is the mechanism behind `GracefulStop`.
- **Keepalive `PING`** — application-level liveness checks that detect a dead peer or a silently dropped NAT mapping before a stream hangs forever.

## 3. Theory & Principles

### One RPC = one stream

The mapping is strict and worth memorising, because every debugging session runs through it:

| RPC concept | HTTP/2 realisation |
|---|---|
| Call | One stream (odd id, allocated by the client) |
| Method name | `:path` = `/package.Service/Method` |
| Request metadata | HEADERS frame (initial) |
| Request message(s) | DATA frames, each carrying length-prefixed messages |
| "No more requests" | `END_STREAM` flag on the last client DATA frame (half-close) |
| Response metadata | HEADERS frame (initial, from server) |
| Response message(s) | DATA frames |
| Status + trailing metadata | HEADERS frame with `END_STREAM` (trailers) |
| Client cancellation | `RST_STREAM` with `CANCEL` |
| Server shutdown | `GOAWAY` |

Two consequences fall out immediately. First, **a unary call is just a stream where each side sends exactly one message** — there is no separate unary protocol, which is why interceptor and transport code can treat them uniformly. Second, **status is committed last**, so a server-streaming call may emit forty messages and then close with `Internal`. Any client that assumes "I got data, therefore it succeeded" is wrong.

### Head-of-line blocking: fixed at layer 7, not layer 4

HTTP/2 eliminates *application-level* head-of-line blocking: stream 5's slow response no longer delays stream 7. It does **not** eliminate *transport-level* head-of-line blocking, because all streams share one TCP connection and TCP guarantees in-order delivery of the byte stream. If a single TCP segment is lost, the kernel holds back every subsequent byte — including bytes belonging to unrelated streams — until the retransmission arrives. On a lossy network, one multiplexed connection can therefore perform *worse* than several connections. This is precisely the problem HTTP/3 and QUIC solve by moving streams below the reliability layer; gRPC over QUIC exists but is not yet the default in Go.

### Flow control is your backpressure

Each stream begins with a 64 KiB window in each direction (the connection has its own, also 64 KiB by default in grpc-go, raised dynamically by BDP estimation). A sender may transmit at most `window` unacknowledged bytes; the receiver sends `WINDOW_UPDATE` as the application consumes data. In Go this means: **if your handler stops calling `stream.Recv()`, the window closes and the client's `stream.Send()` eventually blocks.** That is not a bug, it is the designed backpressure path, and it is the reason a streaming handler must never buffer unboundedly "to be fast".

grpc-go exposes the knobs as `grpc.InitialWindowSize`, `grpc.InitialConnWindowSize` (server) and their `grpc.With…` client equivalents. Setting either above 64 KiB disables the dynamic BDP-based auto-tuning, so raise them only with a measurement in hand.

```svg
<svg viewBox="0 0 860 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <text x="430" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">HTTP/1.1 connection pool vs HTTP/2 multiplexed connection</text>

  <rect x="24" y="44" width="390" height="360" rx="12" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="219" y="68" text-anchor="middle" fill="#b91c1c" font-size="13" font-weight="bold">HTTP/1.1 &#8212; one request per connection</text>
  <g font-size="11" fill="#7f1d1d">
    <rect x="48" y="86" width="342" height="30" rx="6" fill="#fff" stroke="#fca5a5"/>
    <text x="60" y="106">conn 1  [ RPC A .................... ] idle</text>
    <rect x="48" y="124" width="342" height="30" rx="6" fill="#fff" stroke="#fca5a5"/>
    <text x="60" y="144">conn 2  [ RPC B ....... ] idle</text>
    <rect x="48" y="162" width="342" height="30" rx="6" fill="#fff" stroke="#fca5a5"/>
    <text x="60" y="182">conn 3  [ RPC C ................ ] idle</text>
    <rect x="48" y="200" width="342" height="30" rx="6" fill="#fff" stroke="#fca5a5"/>
    <text x="60" y="220">conn 4  [ RPC D ... ] idle</text>
    <rect x="48" y="238" width="342" height="30" rx="6" fill="#fff" stroke="#fca5a5"/>
    <text x="60" y="258">conn 5  [ RPC E ........... ] idle</text>
  </g>
  <g font-size="11" fill="#991b1b">
    <text x="48" y="298">&#8226; 5 TCP + 5 TLS handshakes</text>
    <text x="48" y="318">&#8226; 5 congestion windows warming up separately</text>
    <text x="48" y="338">&#8226; headers re-sent in full on every request</text>
    <text x="48" y="358">&#8226; a 6th concurrent call must queue or open conn 6</text>
    <text x="48" y="378">&#8226; pipelining blocked: responses must return in order</text>
  </g>

  <rect x="446" y="44" width="390" height="360" rx="12" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="641" y="68" text-anchor="middle" fill="#15803d" font-size="13" font-weight="bold">HTTP/2 &#8212; one connection, many streams</text>
  <rect x="470" y="86" width="342" height="182" rx="8" fill="#fff" stroke="#86efac"/>
  <text x="482" y="106" fill="#166534" font-size="11" font-weight="bold">single TCP connection</text>
  <g font-size="10">
    <rect x="482" y="118" width="52" height="22" rx="4" fill="#dbeafe" stroke="#3b82f6"/><text x="508" y="133" text-anchor="middle" fill="#1e40af">s1 H</text>
    <rect x="538" y="118" width="52" height="22" rx="4" fill="#fce7f3" stroke="#db2777"/><text x="564" y="133" text-anchor="middle" fill="#9d174d">s3 H</text>
    <rect x="594" y="118" width="52" height="22" rx="4" fill="#dbeafe" stroke="#3b82f6"/><text x="620" y="133" text-anchor="middle" fill="#1e40af">s1 D</text>
    <rect x="650" y="118" width="52" height="22" rx="4" fill="#ede9fe" stroke="#7c3aed"/><text x="676" y="133" text-anchor="middle" fill="#5b21b6">s5 H</text>
    <rect x="706" y="118" width="52" height="22" rx="4" fill="#fce7f3" stroke="#db2777"/><text x="732" y="133" text-anchor="middle" fill="#9d174d">s3 D</text>

    <rect x="482" y="146" width="52" height="22" rx="4" fill="#ede9fe" stroke="#7c3aed"/><text x="508" y="161" text-anchor="middle" fill="#5b21b6">s5 D</text>
    <rect x="538" y="146" width="52" height="22" rx="4" fill="#dbeafe" stroke="#3b82f6"/><text x="564" y="161" text-anchor="middle" fill="#1e40af">s1 T</text>
    <rect x="594" y="146" width="52" height="22" rx="4" fill="#dcfce7" stroke="#16a34a"/><text x="620" y="161" text-anchor="middle" fill="#166534">s7 H</text>
    <rect x="650" y="146" width="52" height="22" rx="4" fill="#fce7f3" stroke="#db2777"/><text x="676" y="161" text-anchor="middle" fill="#9d174d">s3 D</text>
    <rect x="706" y="146" width="52" height="22" rx="4" fill="#dcfce7" stroke="#16a34a"/><text x="732" y="161" text-anchor="middle" fill="#166534">s7 D</text>
  </g>
  <text x="482" y="192" fill="#475569" font-size="10">H = HEADERS &#183; D = DATA &#183; T = TRAILERS &#183; frames interleave</text>
  <text x="482" y="212" fill="#475569" font-size="10">each stream has its own 64 KiB flow-control window</text>
  <text x="482" y="232" fill="#475569" font-size="10">HPACK: repeated headers cost a few bytes, not a few hundred</text>
  <text x="482" y="252" fill="#475569" font-size="10">RST_STREAM cancels one call without touching the others</text>
  <g font-size="11" fill="#166534">
    <text x="470" y="298">&#8226; 1 handshake, 1 warm congestion window</text>
    <text x="470" y="318">&#8226; concurrency limited by MAX_CONCURRENT_STREAMS, not sockets</text>
    <text x="470" y="338">&#8226; no application-level head-of-line blocking</text>
    <text x="470" y="358">&#8226; but ONE lost TCP segment still stalls all streams (layer 4)</text>
    <text x="470" y="378">&#8226; long-lived connection &#8594; L4 load balancers stop balancing</text>
  </g>
</svg>
```

## 4. Architecture & Workflow

What actually happens between `client.GetItem(ctx, req)` and your handler running:

1. **Connection establishment.** TCP connect, then TLS with ALPN negotiating `h2` (or, with `insecure` credentials, the HTTP/2 prior-knowledge preface `PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n`). Both sides exchange `SETTINGS`.
2. **Stream allocation.** The client picks the next odd stream id and sends HEADERS: `:method: POST`, `:scheme: https`, `:path: /inventory.v1.InventoryService/GetItem`, `:authority: inv.internal:50051`, `content-type: application/grpc+proto`, `te: trailers`, plus any metadata such as `grpc-timeout: 1997m` and `authorization`.
3. **Request body.** The marshalled request is prefixed with `[0x00][uint32 length]` and written as DATA. For a unary call the last DATA frame carries `END_STREAM` — the client has half-closed and will send nothing further.
4. **Server dispatch.** The transport layer parses HEADERS, looks up the service and method in the map built by `RegisterXxxServer`, creates a `context.Context` with the deadline derived from `grpc-timeout` and metadata from the headers, and **spawns a goroutine per stream**.
5. **Response.** The handler returns; grpc-go sends response HEADERS (any `SetHeader`/`SendHeader` metadata), then DATA with the length-prefixed response.
6. **Trailers.** A final HEADERS frame with `END_STREAM` carries `grpc-status: 0` (or the failure code), `grpc-message`, and `grpc-status-details-bin` if rich error details were attached.
7. **Teardown.** The stream closes; the connection stays open and warm for the next call.

**Failure paths.** A client-side context cancellation sends `RST_STREAM(CANCEL)`; the server's `ctx.Done()` fires and the handler should return promptly. A deadline expiry does the same and yields `DeadlineExceeded` on both sides. A server shutdown sends `GOAWAY` with the last stream id it will honour, so in-flight calls complete while new calls fail fast with `Unavailable` and are retried elsewhere.

```svg
<svg viewBox="0 0 860 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="430" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">gRPC message framing inside HTTP/2 DATA frames</text>

  <rect x="40" y="46" width="780" height="46" rx="8" fill="#eff6ff" stroke="#3b82f6" stroke-width="2"/>
  <text x="52" y="66" fill="#1e40af" font-size="12" font-weight="bold">HTTP/2 DATA frame</text>
  <rect x="200" y="54" width="120" height="30" rx="4" fill="#dbeafe" stroke="#60a5fa"/>
  <text x="260" y="74" text-anchor="middle" fill="#1e3a8a">length (24 bit)</text>
  <rect x="326" y="54" width="90" height="30" rx="4" fill="#dbeafe" stroke="#60a5fa"/>
  <text x="371" y="74" text-anchor="middle" fill="#1e3a8a">type=0x0</text>
  <rect x="422" y="54" width="90" height="30" rx="4" fill="#dbeafe" stroke="#60a5fa"/>
  <text x="467" y="74" text-anchor="middle" fill="#1e3a8a">flags</text>
  <rect x="518" y="54" width="120" height="30" rx="4" fill="#dbeafe" stroke="#60a5fa"/>
  <text x="578" y="74" text-anchor="middle" fill="#1e3a8a">stream id</text>
  <rect x="644" y="54" width="164" height="30" rx="4" fill="#bfdbfe" stroke="#3b82f6"/>
  <text x="726" y="74" text-anchor="middle" fill="#1e3a8a" font-weight="bold">payload &#8595;</text>

  <path d="M726,92 L726,116" stroke="#3b82f6" stroke-width="2"/>
  <rect x="40" y="120" width="780" height="60" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="52" y="142" fill="#15803d" font-size="12" font-weight="bold">gRPC length-prefixed message</text>
  <rect x="240" y="132" width="140" height="34" rx="4" fill="#dcfce7" stroke="#4ade80"/>
  <text x="310" y="153" text-anchor="middle" fill="#14532d">compressed flag (1 B)</text>
  <rect x="388" y="132" width="150" height="34" rx="4" fill="#dcfce7" stroke="#4ade80"/>
  <text x="463" y="153" text-anchor="middle" fill="#14532d">message length (4 B BE)</text>
  <rect x="546" y="132" width="262" height="34" rx="4" fill="#bbf7d0" stroke="#16a34a"/>
  <text x="677" y="153" text-anchor="middle" fill="#14532d" font-weight="bold">serialised protobuf bytes</text>

  <rect x="40" y="200" width="780" height="80" rx="8" fill="#fefce8" stroke="#ca8a04" stroke-width="2"/>
  <text x="52" y="222" fill="#854d0e" font-size="12" font-weight="bold">Consequences</text>
  <text x="52" y="242" fill="#713f12">&#8226; One DATA frame may carry several messages; one message may span several DATA frames.</text>
  <text x="52" y="260" fill="#713f12">&#8226; The 4-byte length is why MaxRecvMsgSize (default 4 MiB) is enforceable before allocation.</text>
  <text x="52" y="276" fill="#713f12">&#8226; The flag byte is per-message, so compression is negotiated per call and applied per message.</text>
</svg>
```

## 5. Implementation

You rarely touch HTTP/2 directly in Go, but you tune it constantly through `ServerOption`s and `DialOption`s. Here is a server and client configured with every transport-level knob that matters, with the reasoning inline.

```go
package main

import (
	"log"
	"net"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/keepalive"
)

func newTunedServer() *grpc.Server {
	return grpc.NewServer(
		// --- Concurrency ---------------------------------------------------
		// Cap simultaneous in-flight streams per connection. grpc-go's default
		// is effectively unlimited, which means one abusive client can spawn
		// unbounded goroutines. Pick a number you have load-tested.
		grpc.MaxConcurrentStreams(1000),

		// --- Message size limits -------------------------------------------
		// Defaults: 4 MiB receive, unlimited send. Both should be explicit.
		// Enforced against the 4-byte length prefix BEFORE the body is
		// allocated, so this is a real memory-exhaustion defence.
		grpc.MaxRecvMsgSize(8*1024*1024),
		grpc.MaxSendMsgSize(8*1024*1024),

		// --- Flow control ---------------------------------------------------
		// Setting either window above 64 KiB DISABLES dynamic BDP auto-tuning.
		// Only do this for high-BDP links (cross-region, large streams) after
		// measuring. Left commented deliberately.
		// grpc.InitialWindowSize(1 << 20),
		// grpc.InitialConnWindowSize(1 << 20),

		// --- Keepalive: what the server itself sends ------------------------
		grpc.KeepaliveParams(keepalive.ServerParameters{
			// Send an HTTP/2 PING after this much idleness to detect dead peers.
			Time:    30 * time.Second,
			Timeout: 10 * time.Second, // no PING ACK within this -> close conn

			// Force clients to periodically re-resolve and rebalance. Without
			// this, an HTTP/2 connection lives forever and new backend pods
			// receive no traffic. MaxConnectionAge sends GOAWAY; MaxConnectionAgeGrace
			// is the drain window for in-flight RPCs.
			MaxConnectionAge:      30 * time.Minute,
			MaxConnectionAgeGrace: 30 * time.Second,

			// Reap idle connections (and their goroutines/buffers).
			MaxConnectionIdle: 15 * time.Minute,
		}),

		// --- Keepalive: what the server tolerates from clients ---------------
		// Without an enforcement policy, a misbehaving client can PING-flood you.
		grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{
			MinTime:             10 * time.Second, // reject pings more frequent than this
			PermitWithoutStream: true,             // allow pings on idle connections
		}),
	)
}

func main() {
	lis, err := net.Listen("tcp", ":50051")
	if err != nil {
		log.Fatal(err)
	}
	s := newTunedServer()
	// ... RegisterXxxServer(s, impl) ...
	log.Fatal(s.Serve(lis))
}
```

The matching client side:

```go
package main

import (
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/keepalive"
)

func newTunedClient(target string) (*grpc.ClientConn, error) {
	return grpc.NewClient(
		target,
		grpc.WithTransportCredentials(insecure.NewCredentials()),

		// Client keepalive must be >= the server's EnforcementPolicy.MinTime,
		// or the server will send GOAWAY with "too_many_pings" and you will see
		// mysterious Unavailable errors on an otherwise healthy service.
		grpc.WithKeepaliveParams(keepalive.ClientParameters{
			Time:                30 * time.Second,
			Timeout:             10 * time.Second,
			PermitWithoutStream: true,
		}),

		grpc.WithDefaultCallOptions(
			grpc.MaxCallRecvMsgSize(8*1024*1024),
			grpc.MaxCallSendMsgSize(8*1024*1024),
		),
	)
}
```

**Observing the frames.** To see the mapping with your own eyes:

```bash
# grpc-go's own transport logs: every frame, in and out.
GRPC_GO_LOG_SEVERITY_LEVEL=info GRPC_GO_LOG_VERBOSITY_LEVEL=99 go run ./cmd/server

# Decode HTTP/2 on the wire (plaintext gRPC only).
tshark -i lo0 -d tcp.port==50051,http2 -Y http2 -V

# nghttp speaks raw HTTP/2 and prints frames with their flags.
nghttp -nv http://localhost:50051
```

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **True concurrency on one socket**, bounded by `MAX_CONCURRENT_STREAMS` rather than by file descriptors or ephemeral ports.
- **HPACK** makes repeated metadata almost free, which matters enormously when every call carries a JWT and trace context.
- **Per-stream flow control** gives you backpressure for free and prevents a fast producer from OOM-ing a slow consumer.
- **Trailers** allow a status to be reported after streaming has begun — the feature that makes gRPC streaming honest.
- **`GOAWAY`** makes graceful shutdown and connection rotation a protocol feature rather than a hack.

**Disadvantages**
- **TCP head-of-line blocking remains.** On lossy networks a single connection can be slower than several.
- **Long-lived connections defeat L4 load balancers.** Connections pin to a backend; new pods stay cold (chapter 29).
- **Binary and stateful.** HPACK's dynamic table means you cannot interpret a frame in isolation; a mid-stream packet capture is undecodable.
- **More per-connection memory.** Frame buffers, HPACK tables and window accounting per stream add up under high fan-in.

**Trade-offs**
- *Window sizes:* larger windows raise throughput on high-BDP links but disable auto-tuning and increase memory per stream. Measure before changing.
- *`MaxConnectionAge`:* forcing reconnection restores load-balancing fairness but adds handshake cost and briefly disrupts long streams.
- *Keepalive frequency:* aggressive pings detect dead peers quickly and hold NAT mappings open, but can trip the server's enforcement policy and waste bandwidth at scale.

## 7. Common Mistakes & Best Practices

- **Client keepalive more aggressive than the server's `MinTime`.** The server responds with `GOAWAY: too_many_pings` and the client sees `Unavailable`. Always configure both sides together.
- **Assuming a Kubernetes `Service` load-balances gRPC.** It balances *connections*, and gRPC opens one. Use a headless service with client-side `round_robin`, or an L7 proxy.
- **Raising window sizes "for performance" without measuring.** You silently disable BDP auto-tuning and often make things worse.
- **Ignoring `MaxRecvMsgSize` until production.** The default 4 MiB will reject a large batch response with `ResourceExhausted`; decide the limit deliberately on both client and server.
- **Never setting `MaxConcurrentStreams`.** One client can then spawn unbounded goroutines on your server.
- **Blocking in a `Recv()` loop's body.** Slow consumption closes the flow-control window and stalls the sender — correct backpressure, but surprising if unexpected.
- **Expecting HTTP/1.1 proxies to work.** Anything that terminates HTTP/1.1, strips trailers, or buffers whole responses will break gRPC. Proxies must be HTTP/2 end-to-end and trailer-aware.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** `GRPC_GO_LOG_VERBOSITY_LEVEL=99` prints every frame. `channelz` (`google.golang.org/grpc/channelz/service`) exposes live per-channel, per-socket and per-stream state over gRPC itself — invaluable for "is it even connected?" questions.
- **Monitoring.** Track streams-per-connection, connection count, `GOAWAY` counts, and bytes sent/received per method. A rising connection count with flat QPS usually means connections are churning; flat connections with rising latency often means window exhaustion.
- **Security.** ALPN-negotiated TLS 1.2+ is the baseline. Set `MaxConcurrentStreams` and message-size limits as DoS defences, and configure `KeepaliveEnforcementPolicy` so ping floods are rejected. Be aware of the 2023 HTTP/2 Rapid Reset class of attacks (CVE-2023-44487) — keep grpc-go and `golang.org/x/net` current, since mitigation lives in the library.
- **Scaling.** Use `MaxConnectionAge` (plus grace) so clients periodically re-resolve and rebalance across new backends. For fan-in-heavy servers, watch goroutine count: it is roughly proportional to active streams.

## 9. Interview Questions

**Q: How does gRPC map an RPC onto HTTP/2?**
A: One RPC is exactly one HTTP/2 stream. The client sends a HEADERS frame with `:method: POST` and `:path: /package.Service/Method` plus metadata as headers, then DATA frames containing length-prefixed protobuf messages, ending with `END_STREAM` to half-close. The server replies with its own HEADERS, DATA frames, and finally a trailing HEADERS frame carrying `grpc-status` and `grpc-message`. Cancellation is `RST_STREAM`; graceful shutdown is `GOAWAY`.

**Q: Why can't gRPC run over HTTP/1.1?**
A: Because of trailers, multiplexing and full duplex. gRPC delivers its terminal status after the body so that a stream can fail mid-flight; HTTP/1.1 has no portable trailer support. HTTP/1.1 also carries one request at a time per connection, so concurrency would require a connection pool, and it cannot express both peers sending simultaneously, which bidirectional streaming requires. Protocols like Connect and gRPC-Web work around this by encoding trailers into the body and giving up true bidi streaming.

**Q: Does HTTP/2 eliminate head-of-line blocking?**
A: Only at the application layer. Streams are independent, so a slow response no longer blocks others in the same connection. But every stream shares one TCP connection, and TCP delivers bytes strictly in order, so a single lost segment stalls all streams until it is retransmitted. Solving that requires moving streams below the reliability layer, which is what QUIC and HTTP/3 do.

**Q: What is the gRPC message framing inside a DATA frame?**
A: One byte of compressed-flag followed by a four-byte big-endian length, then that many bytes of serialised message. Framing is independent of HTTP/2 framing, so a DATA frame may carry several messages and one message may span several DATA frames. The explicit length is what lets `MaxRecvMsgSize` reject an oversized message before allocating a buffer for it.

**Q: What is flow control in HTTP/2, and how does it show up in Go code?**
A: Each stream and the whole connection have a credit window — 64 KiB by default — and a sender may have at most that many unacknowledged bytes outstanding. The receiver issues `WINDOW_UPDATE` as the application consumes data. In Go, if a server handler stops calling `stream.Recv()`, the window closes and the client's `stream.Send()` blocks. That is the intended backpressure mechanism, and it is why streaming handlers must consume rather than buffer.

**Q: Why does a Kubernetes Service fail to balance gRPC traffic?**
A: `kube-proxy` operates at L4 and balances *connections*, not requests. A gRPC client opens one long-lived HTTP/2 connection and multiplexes everything over it, so it stays pinned to whichever pod it first landed on. When you scale up, the new pods receive nothing. The fixes are a headless service plus client-side `round_robin` load balancing, an L7 proxy such as Envoy or a service mesh, or `MaxConnectionAge` to force periodic re-resolution.

**Q: What do `GOAWAY` and `RST_STREAM` mean operationally?**
A: `GOAWAY` is the server saying "I will finish streams up to id N and accept no more" — the mechanism behind `GracefulStop`, connection-age rotation and shutdown during a rolling deploy. `RST_STREAM` terminates a single stream without touching the connection; it is what a client context cancellation or deadline expiry sends. Seeing many `GOAWAY`s usually means connection churn or a keepalive misconfiguration.

**Q: How do keepalive settings interact between client and server?**
A: The client's `keepalive.ClientParameters.Time` must be at least the server's `keepalive.EnforcementPolicy.MinTime`, and if the client pings on idle connections the server must set `PermitWithoutStream: true`. Otherwise the server treats the pings as abuse and sends `GOAWAY` with debug data `too_many_pings`, which surfaces to the application as intermittent `Unavailable`. It is one of the most common "works in staging, fails in prod" gRPC misconfigurations.

**Q: (Senior) A cross-region gRPC stream achieves 30 Mbit/s on a link that benchmarks at 1 Gbit/s. Diagnose it.**
A: That is a textbook bandwidth-delay-product problem. With a 64 KiB window and, say, a 100 ms round trip, the theoretical maximum is 64 KiB / 0.1 s ≈ 5 Mbit/s per stream before `WINDOW_UPDATE` gates the sender; several streams get you to tens of megabits. I would confirm with a packet capture showing the sender idle waiting for `WINDOW_UPDATE`, then raise `InitialWindowSize` and `InitialConnWindowSize` to roughly the BDP (bandwidth × RTT, so ~12 MiB for 1 Gbit/s at 100 ms), accepting that this disables BDP auto-tuning, and verify the memory cost per stream. If loss is also present, TCP head-of-line blocking is compounding it and the real answer may be several connections or HTTP/3.

**Q: (Senior) Explain how HTTP/2 Rapid Reset (CVE-2023-44487) affects a gRPC server and what you do about it.**
A: The attack exploits the fact that a client can open a stream and immediately send `RST_STREAM`, which frees the stream slot for `MAX_CONCURRENT_STREAMS` purposes but has already caused the server to allocate a goroutine, parse headers and begin work. An attacker can therefore drive unbounded work with bounded concurrency. Mitigation lives in the library — grpc-go and `golang.org/x/net/http2` added accounting that closes connections exceeding a rate of resets — so the primary action is keeping dependencies current. On top of that I would set `MaxConcurrentStreams`, put a rate limiter in an interceptor, and alert on the ratio of `RST_STREAM`s to completed RPCs.

**Q: (Senior) When would you deliberately open more than one `ClientConn` to the same backend?**
A: When a single connection's `MAX_CONCURRENT_STREAMS` becomes the bottleneck — for example against a peer that advertises 100 while you need thousands of concurrent RPCs — or when one connection's TCP congestion window and head-of-line blocking cap throughput on a lossy or high-BDP link. I would use a small pool with a round-robin selector, sized from measurement rather than guesswork, and I would first check whether raising the server's limit or the window sizes solves it, because a pool costs handshakes, memory and load-balancing complexity.

## 10. Quick Revision & Cheat Sheet

| HTTP/2 element | gRPC meaning |
|---|---|
| Stream | One RPC |
| HEADERS (initial) | Method (`:path`) + metadata |
| DATA | `[flag][len][protobuf]` messages |
| `END_STREAM` on client DATA | Half-close ("no more requests") |
| HEADERS (trailing) | `grpc-status`, `grpc-message`, `grpc-status-details-bin` |
| `RST_STREAM` | Cancellation / deadline exceeded |
| `GOAWAY` | Graceful shutdown, connection rotation |
| `WINDOW_UPDATE` | Flow control credit = backpressure |
| `SETTINGS_MAX_CONCURRENT_STREAMS` | Concurrency cap per connection |
| `PING` | Keepalive / liveness |

**Flash cards**
- **Default flow-control window?** → 64 KiB per stream and per connection; grpc-go auto-tunes via BDP unless you override it.
- **Default `MaxRecvMsgSize`?** → 4 MiB receive; send is unlimited by default. Set both explicitly.
- **Where does `grpc-timeout` come from?** → The client's context deadline, encoded as a header so the server shares the budget.
- **`GOAWAY` vs `RST_STREAM`?** → Connection-level graceful shutdown vs single-stream cancellation.
- **Why does one gRPC client hammer one pod?** → One long-lived HTTP/2 connection; L4 balancers balance connections, not RPCs.
- **HTTP/2 fixes head-of-line blocking?** → At L7 only. TCP still stalls all streams on a lost segment.

## 11. Hands-On Exercises & Mini Project

- [ ] Run a server with `GRPC_GO_LOG_VERBOSITY_LEVEL=99` and a client that issues one unary call. Find the HEADERS, DATA and trailing HEADERS frames in the log and match each to §4.
- [ ] Issue 200 concurrent RPCs from one client and count TCP connections with `lsof -p <pid> | grep 50051`. Then set `grpc.MaxConcurrentStreams(10)` on the server and observe how calls queue rather than opening new sockets.
- [ ] Write a server-streaming handler that sends 10,000 messages and a client that sleeps one second between `Recv()` calls. Instrument the server to log how long `Send()` blocks, and watch flow control apply backpressure.
- [ ] Set the client's keepalive `Time` to 5 s and the server's `EnforcementPolicy.MinTime` to 30 s. Reproduce `too_many_pings`, then fix it and confirm the errors stop.
- [ ] Enable channelz on the server and query it with `grpcurl` to list live sockets and their stream counts.

### Mini Project — "Transport Observatory"

**Goal.** Build a small tool that makes gRPC's transport behaviour visible, so the abstractions stop being folklore.

**Requirements.**
1. A gRPC server exposing one unary and one server-streaming method, with channelz and reflection enabled.
2. A load-generating client with configurable concurrency, message size and per-message client delay.
3. A dashboard command that polls channelz every second and prints connections, active streams, and bytes in/out per socket.
4. Experiments to run and write up: concurrency 1 → 500 (watch streams, not sockets); message size 1 KiB → 8 MiB (find the `ResourceExhausted` cliff); client delay 0 → 1 s (observe flow control blocking `Send`).
5. Repeat the throughput experiment with `InitialWindowSize` at 64 KiB and at 4 MiB over a link with 100 ms of injected latency (`tc qdisc` on Linux, `dnctl`/`pfctl` on macOS) and chart the difference.

**Extensions.**
- Add `MaxConnectionAge: 10s` and observe `GOAWAY` and reconnection in the channelz output.
- Inject 1% packet loss and compare one multiplexed connection against a pool of eight, to demonstrate TCP head-of-line blocking.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *What Is gRPC?* (the mapping in context), *Protocol Buffers: Binary Wire Format* (what fills the DATA frames), *Graceful Shutdown, Signals, Keepalive & Server Limits* (GOAWAY in practice), *Deadlines, Retries, Service Config & Load Balancing* (why connections must rotate), *Build: Deployment — Kubernetes, Proxies, grpc-gateway & gRPC-Web* (L4 vs L7 balancing).

- **RFC 9113 — HTTP/2** — IETF · *Advanced* · the normative specification: frame layout, stream states, HPACK, flow control and error codes. Read §5 (streams) and §6 (frames) at minimum. <https://www.rfc-editor.org/rfc/rfc9113>
- **gRPC over HTTP/2 — protocol specification** — gRPC Authors · *Advanced* · the exact header, framing and trailer requirements for a conformant gRPC implementation; the reference for any proxy question. <https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md>
- **HTTP/2 in Action (free chapters) & "HTTP/2 explained"** — Daniel Stenberg · *Intermediate* · the friendliest correct explanation of multiplexing, HPACK and flow control, by the author of curl. <https://daniel.haxx.se/http2/>
- **gRPC Blog — gRPC on HTTP/2 Engineering a Robust, High-performance Protocol** — gRPC Authors · *Intermediate* · why the mapping was designed this way, with production context from Google. <https://grpc.io/blog/grpc-on-http2/>
- **grpc-go: keepalive package documentation** — gRPC Authors · *Intermediate* · every keepalive and connection-age parameter with its default and its interaction rules. <https://pkg.go.dev/google.golang.org/grpc/keepalive>
- **channelz — gRPC connection introspection** — gRPC Authors · *Intermediate* · how to expose and query live channel, socket and stream state; the best in-production transport debugger. <https://grpc.io/blog/a-short-introduction-to-channelz/>
- **gRPC Load Balancing** — gRPC Authors · *Intermediate* · the canonical explanation of why long-lived HTTP/2 connections break naive balancing and what the options are. <https://grpc.io/blog/grpc-load-balancing/>
- **HTTP/2 Rapid Reset — Google Cloud writeup** — Google · *Advanced* · the anatomy of CVE-2023-44487 and the library-level mitigations, directly relevant to any exposed gRPC server. <https://cloud.google.com/blog/products/identity-security/google-cloud-mitigated-largest-ddos-attack-peaking-above-398-million-rps>

---

*gRPC with Go Handbook — chapter 02.*
