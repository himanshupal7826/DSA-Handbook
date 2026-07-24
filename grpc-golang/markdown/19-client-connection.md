# 19 · grpc.NewClient, Transport Credentials & Connection Lifecycle

> **In one line:** `grpc.NewClient` replaced `grpc.Dial` in grpc-go 1.63 and behaves differently in ways that matter — it is lazy, it defaults to DNS with `pick_first`, and `WithBlock` no longer applies — so the migration is not a rename.

---

## 1. Overview

A `*grpc.ClientConn` is not a connection. It is a **virtual channel**: a name to resolve, a load-balancing policy, a set of subchannels to actual backends, and the state machine that reconnects them. Understanding that distinction resolves most client-side confusion — why creating one does not fail when the server is down, why one `ClientConn` can talk to fifty pods, and why "connection pooling" is usually the wrong instinct.

The API changed meaningfully in **grpc-go v1.63** (2024). `grpc.Dial` and `grpc.DialContext` are deprecated in favour of **`grpc.NewClient`**, and the differences are behavioural, not cosmetic:

| | `grpc.Dial` / `DialContext` | `grpc.NewClient` |
|---|---|---|
| Default resolver for a bare `host:port` | `passthrough` | **`dns`** |
| Default load balancer | `pick_first` | `pick_first` |
| Connects eagerly | Yes (background) | **No** — idle until the first RPC |
| `WithBlock`, `WithTimeout`, `FailOnNonTempDialError` | Honoured | **Ignored** |
| Target parsing | `host:port` treated as a literal address | Parsed as a URI; `dns:///host:port` explicit form |

The `passthrough` → `dns` change is the one that bites: with `Dial`, `"my-service:50051"` was handed verbatim to the dialer; with `NewClient` it is resolved through DNS, which is almost always what you wanted but changes behaviour for anything relying on the old default — notably `bufconn` tests and custom dialers, which now need an explicit `passthrough:///` prefix.

This chapter covers constructing a client correctly, the credentials options, the connectivity state machine, and the lifecycle rules that determine whether your service degrades gracefully or falls over when a backend restarts.

## 2. Core Concepts

- **`*grpc.ClientConn`** — the virtual channel. Goroutine-safe, long-lived, shared. Not a socket.
- **`grpc.NewClient(target, opts...)`** — the modern constructor. Lazy: no connection until the first RPC.
- **Target URI** — `scheme://authority/endpoint`, e.g. `dns:///inventory.svc:50051`, `unix:///tmp/x.sock`, `passthrough:///bufnet`.
- **Resolver** — turns a target into a list of addresses and pushes updates. Built-in: `dns`, `passthrough`, `unix`.
- **Balancer** — chooses a subchannel per RPC. Built-in: `pick_first` (default), `round_robin`.
- **Subchannel** — a connection to one backend address, with its own connectivity state.
- **Connectivity states** — `IDLE`, `CONNECTING`, `READY`, `TRANSIENT_FAILURE`, `SHUTDOWN`.
- **Transport credentials** — `grpc.WithTransportCredentials(...)`: TLS, mTLS, or `insecure.NewCredentials()`.
- **Per-RPC credentials** — `grpc.WithPerRPCCredentials(...)`: tokens attached to each call (chapter 24).
- **`WaitForReady`** — a per-call option making an RPC queue during `TRANSIENT_FAILURE` instead of failing fast.
- **Backoff** — exponential reconnection delay with jitter, per gRFC A6; configurable via `ConnectParams`.
- **`Connect()` / `WaitForStateChange()`** — manual control of the idle-to-ready transition, for warm-up.

## 3. Theory & Principles

### The channel is not a connection

```
ClientConn ("dns:///inventory.svc:50051")
  ├─ Resolver (dns)  → [10.0.1.4:50051, 10.0.1.9:50051, 10.0.2.3:50051]
  ├─ Balancer (round_robin)
  ├─ SubConn → 10.0.1.4:50051   state: READY
  ├─ SubConn → 10.0.1.9:50051   state: READY
  └─ SubConn → 10.0.2.3:50051   state: TRANSIENT_FAILURE (reconnecting)
```

Consequences that follow directly:

- **One `ClientConn` per target, for the process lifetime.** It is goroutine-safe and multiplexes concurrent RPCs over HTTP/2 streams. Creating one per request is the single most common client mistake: it costs a DNS lookup, a TCP handshake, a TLS handshake and a file descriptor, and it defeats multiplexing entirely.
- **Pooling is usually wrong.** The legitimate reasons are hitting the server's `MaxConcurrentStreams` (often 100 in non-Go implementations) or TCP head-of-line blocking on a lossy link. Neither is the default situation.
- **Reconnection is automatic.** A backend restarting moves its subchannel to `TRANSIENT_FAILURE` and then back to `READY`; your code does nothing.
- **`pick_first` uses one backend at a time.** With the default balancer, a `ClientConn` resolving to three addresses sends everything to the first that connects. `round_robin` is what spreads load, and it must be requested explicitly.

### The connectivity state machine

```
        ┌──────────────────────────────────────────┐
        ▼                                          │
     IDLE ──────► CONNECTING ──────► READY ────────┤
        ▲              │               │           │
        │              ▼               ▼           │
        └──── TRANSIENT_FAILURE ◄──────┘           │
                       │                           │
                       └──── (backoff) ────────────┘
```

- **`IDLE`** — no connection attempt in progress. `NewClient` starts here; the first RPC (or `Connect()`) triggers `CONNECTING`. A channel also returns to `IDLE` after `MaxConnectionIdle` on the server side.
- **`CONNECTING`** — resolving and handshaking.
- **`READY`** — RPCs flow.
- **`TRANSIENT_FAILURE`** — the last attempt failed; a backoff timer is running. **New RPCs fail immediately with `Unavailable`** unless they set `WaitForReady`.
- **`SHUTDOWN`** — `Close()` was called. Terminal.

`WaitForReady` is the switch between two philosophies. **Fail fast (default)**: an RPC issued while the channel is in `TRANSIENT_FAILURE` returns `Unavailable` immediately, so the caller can shed load or use a fallback. **Wait for ready**: the RPC queues until the channel becomes `READY` or the deadline expires. Fail-fast is right for user-facing paths where a fast error beats a slow success; wait-for-ready is right for background work where a brief blip should not surface as an error — but only ever with a deadline, or you have built an unbounded queue.

```svg
<svg viewBox="0 0 880 490" width="100%" height="490" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="cc1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#0ea5e9"/></marker>
    <marker id="cc2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">A ClientConn is a virtual channel, not a socket</text>

  <rect x="24" y="42" width="832" height="196" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <rect x="48" y="60" width="220" height="60" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="158" y="82" text-anchor="middle" fill="#3730a3" font-size="11" font-weight="bold">*grpc.ClientConn</text>
  <text x="158" y="100" text-anchor="middle" fill="#4338ca" font-size="9">"dns:///inventory.svc:50051"</text>
  <text x="158" y="114" text-anchor="middle" fill="#4338ca" font-size="9">goroutine-safe &#183; one per target</text>

  <path d="M270,90 L308,90" stroke="#0ea5e9" stroke-width="2" marker-end="url(#cc1)"/>

  <rect x="312" y="60" width="160" height="60" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="392" y="82" text-anchor="middle" fill="#1e40af" font-size="11" font-weight="bold">Resolver (dns)</text>
  <text x="392" y="100" text-anchor="middle" fill="#1d4ed8" font-size="9">pushes address updates</text>
  <text x="392" y="114" text-anchor="middle" fill="#1d4ed8" font-size="9">as pods come and go</text>

  <path d="M474,90 L512,90" stroke="#0ea5e9" stroke-width="2" marker-end="url(#cc1)"/>

  <rect x="516" y="60" width="160" height="60" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="596" y="82" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">Balancer</text>
  <text x="596" y="100" text-anchor="middle" fill="#166534" font-size="9">pick_first (DEFAULT)</text>
  <text x="596" y="114" text-anchor="middle" fill="#166534" font-size="9">or round_robin</text>

  <path d="M678,90 L716,90" stroke="#0ea5e9" stroke-width="2" marker-end="url(#cc1)"/>

  <rect x="720" y="52" width="116" height="24" rx="4" fill="#dcfce7" stroke="#16a34a"/>
  <text x="778" y="68" text-anchor="middle" fill="#15803d" font-size="9">10.0.1.4  READY</text>
  <rect x="720" y="80" width="116" height="24" rx="4" fill="#dcfce7" stroke="#16a34a"/>
  <text x="778" y="96" text-anchor="middle" fill="#15803d" font-size="9">10.0.1.9  READY</text>
  <rect x="720" y="108" width="116" height="24" rx="4" fill="#fee2e2" stroke="#dc2626"/>
  <text x="778" y="124" text-anchor="middle" fill="#b91c1c" font-size="9">10.0.2.3  FAILURE</text>

  <text x="48" y="152" fill="#334155" font-size="11" font-weight="bold">Consequences that follow directly:</text>
  <text x="48" y="172" fill="#475569">&#8226; ONE ClientConn per target, for the process lifetime. Creating one per request costs DNS + TCP + TLS + an fd,</text>
  <text x="62" y="188" fill="#475569">  and defeats HTTP/2 multiplexing entirely. It is the most common client mistake.</text>
  <text x="48" y="208" fill="#475569">&#8226; Reconnection is automatic. A restarting backend moves to TRANSIENT_FAILURE and back; your code does nothing.</text>
  <text x="48" y="228" fill="#7f1d1d" font-weight="bold">&#8226; pick_first uses ONE backend at a time. round_robin is what spreads load, and must be requested explicitly.</text>

  <rect x="24" y="256" width="410" height="222" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="229" y="278" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">Connectivity state machine</text>
  <rect x="60" y="294" width="110" height="30" rx="6" fill="#f1f5f9" stroke="#64748b"/>
  <text x="115" y="314" text-anchor="middle" fill="#334155" font-size="10">IDLE</text>
  <path d="M172,309 L210,309" stroke="#0ea5e9" stroke-width="2" marker-end="url(#cc1)"/>
  <text x="191" y="302" text-anchor="middle" fill="#0369a1" font-size="8">1st RPC</text>
  <rect x="214" y="294" width="110" height="30" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="269" y="314" text-anchor="middle" fill="#92400e" font-size="10">CONNECTING</text>
  <path d="M326,309 L364,309" stroke="#0ea5e9" stroke-width="2" marker-end="url(#cc1)"/>
  <rect x="60" y="344" width="110" height="30" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="115" y="364" text-anchor="middle" fill="#15803d" font-size="10">READY</text>
  <rect x="214" y="344" width="180" height="30" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="304" y="364" text-anchor="middle" fill="#b91c1c" font-size="10">TRANSIENT_FAILURE</text>
  <path d="M212,359 L174,359" stroke="#dc2626" stroke-width="2" marker-end="url(#cc2)"/>
  <text x="193" y="352" text-anchor="middle" fill="#b91c1c" font-size="8">backoff</text>

  <text x="44" y="400" fill="#b91c1c" font-size="10" font-weight="bold">In TRANSIENT_FAILURE, new RPCs fail IMMEDIATELY</text>
  <text x="44" y="416" fill="#991b1b" font-size="10">with Unavailable &#8212; unless WaitForReady is set.</text>
  <text x="44" y="440" fill="#1e40af" font-size="10" font-weight="bold">Fail fast (default):</text>
  <text x="44" y="456" fill="#1d4ed8" font-size="10">user-facing paths &#8212; a fast error beats a slow success.</text>
  <text x="44" y="472" fill="#1e40af" font-size="10" font-weight="bold">WaitForReady: background work only, ALWAYS with a deadline.</text>

  <rect x="446" y="256" width="410" height="222" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="651" y="278" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">NewClient is not a rename of Dial</text>
  <g font-size="10">
    <text x="466" y="304" fill="#7f1d1d" font-weight="bold">Default resolver</text>
    <text x="640" y="304" fill="#991b1b">passthrough &#8594; dns</text>
    <text x="466" y="326" fill="#7f1d1d" font-weight="bold">Connects eagerly</text>
    <text x="640" y="326" fill="#991b1b">yes &#8594; NO (idle until 1st RPC)</text>
    <text x="466" y="348" fill="#7f1d1d" font-weight="bold">WithBlock / WithTimeout</text>
    <text x="640" y="348" fill="#991b1b">honoured &#8594; IGNORED</text>
    <text x="466" y="370" fill="#7f1d1d" font-weight="bold">FailOnNonTempDialError</text>
    <text x="640" y="370" fill="#991b1b">honoured &#8594; IGNORED</text>
  </g>
  <text x="466" y="400" fill="#b91c1c" font-size="10" font-weight="bold">The resolver change is the one that bites:</text>
  <text x="466" y="418" fill="#991b1b" font-size="10">bufconn tests and custom dialers relied on passthrough.</text>
  <text x="466" y="434" fill="#991b1b" font-size="10">They now need an explicit passthrough:/// prefix.</text>
  <text x="466" y="458" fill="#7f1d1d" font-size="10" font-weight="bold">Startup validation is now: Connect() + WaitForStateChange,</text>
  <text x="466" y="474" fill="#991b1b" font-size="10">or a health-check RPC. Not WithBlock.</text>
</svg>
```

### Target syntax

The target is a URI, and the scheme selects the resolver:

| Target | Resolver | Meaning |
|---|---|---|
| `inventory.svc:50051` | `dns` (with `NewClient`) | Resolve the name; may yield many addresses |
| `dns:///inventory.svc:50051` | `dns` | The explicit form; prefer it for clarity |
| `dns://8.8.8.8/inventory.svc:50051` | `dns` | Use a specific DNS server as the authority |
| `passthrough:///10.0.1.4:50051` | `passthrough` | Hand the string to the dialer verbatim — required for `bufconn` |
| `unix:///var/run/svc.sock` | `unix` | Unix domain socket, absolute path |
| `unix-abstract:name` | `unix` | Linux abstract socket |
| `xds:///inventory.svc` | `xds` | Control-plane-driven (Envoy/Istio-style) discovery |

Note `dns:///` has **three** slashes: the authority component is empty. `dns://host/target` means "use `host` as the DNS server", which is rarely what people intend when they mistype it.

### Credentials: transport vs per-RPC

Two independent axes, frequently confused:

- **Transport credentials** secure the *connection*: `insecure.NewCredentials()` (local only), `credentials.NewTLS(cfg)`, or mTLS by supplying a client certificate. Exactly one applies per `ClientConn`.
- **Per-RPC credentials** attach an *identity* to each call, as metadata: an OAuth token, a JWT, a service-account token. Several may apply, and by default gRPC **refuses to send them over an insecure connection** — `RequireTransportSecurity()` returning `true` is the guard, and disabling it is how tokens leak in plaintext.

Chapter 24 covers per-RPC credentials in depth; the rule to hold here is that transport security and caller identity are separate decisions and both are required in production.

## 4. Architecture & Workflow

Creating and owning a client, in order:

1. **Construct once**, at process start, per target. Store it on your service struct or a dependency container.
2. **Choose the target URI explicitly** — `dns:///host:port` rather than relying on the default scheme.
3. **Set transport credentials.** TLS is not optional outside localhost.
4. **Set a service config** if you need `round_robin`, retries or per-method defaults (chapter 21).
5. **Set keepalive**, matched to the server's enforcement policy (chapter 18).
6. **Optionally warm up** with `Connect()` plus a bounded `WaitForStateChange` loop, or a health-check RPC — `WithBlock` no longer works.
7. **Create stubs** from the `ClientConn`; they are cheap and stateless.
8. **`defer conn.Close()`** at the owning scope, not per call.

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">pick_first vs round_robin: the default surprises people</text>

  <rect x="24" y="42" width="410" height="200" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="229" y="64" text-anchor="middle" fill="#92400e" font-size="12" font-weight="bold">pick_first &#8212; THE DEFAULT</text>
  <rect x="48" y="80" width="90" height="34" rx="6" fill="#fff" stroke="#d97706"/>
  <text x="93" y="102" text-anchor="middle" fill="#92400e" font-size="10">client</text>
  <g stroke="#d97706" stroke-width="3">
    <path d="M140,95 L286,92"/><path d="M140,98 L286,95"/><path d="M140,101 L286,98"/>
  </g>
  <rect x="290" y="80" width="120" height="30" rx="5" fill="#fde68a" stroke="#d97706" stroke-width="2"/>
  <text x="350" y="100" text-anchor="middle" fill="#92400e" font-size="10" font-weight="bold">pod A &#8212; ALL traffic</text>
  <rect x="290" y="116" width="120" height="30" rx="5" fill="#fff" stroke="#fcd34d"/>
  <text x="350" y="136" text-anchor="middle" fill="#b45309" font-size="10">pod B &#8212; idle</text>
  <rect x="290" y="152" width="120" height="30" rx="5" fill="#fff" stroke="#fcd34d"/>
  <text x="350" y="172" text-anchor="middle" fill="#b45309" font-size="10">pod C &#8212; idle</text>
  <text x="44" y="206" fill="#92400e" font-size="10" font-weight="bold">One backend at a time, even with 3 resolved addresses.</text>
  <text x="44" y="224" fill="#b45309" font-size="10">Correct for a single-backend target; wrong for a Service</text>
  <text x="44" y="238" fill="#b45309" font-size="10">with replicas &#8212; and it is what you get if you say nothing.</text>

  <rect x="446" y="42" width="410" height="200" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="651" y="64" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">round_robin &#8212; must be requested</text>
  <rect x="470" y="80" width="90" height="34" rx="6" fill="#fff" stroke="#16a34a"/>
  <text x="515" y="102" text-anchor="middle" fill="#15803d" font-size="10">client</text>
  <g stroke="#16a34a" stroke-width="2">
    <path d="M562,92 L708,95"/><path d="M562,97 L708,131"/><path d="M562,102 L708,167"/>
  </g>
  <rect x="712" y="80" width="120" height="30" rx="5" fill="#dcfce7" stroke="#16a34a"/>
  <text x="772" y="100" text-anchor="middle" fill="#15803d" font-size="10">pod A &#8212; 1/3</text>
  <rect x="712" y="116" width="120" height="30" rx="5" fill="#dcfce7" stroke="#16a34a"/>
  <text x="772" y="136" text-anchor="middle" fill="#15803d" font-size="10">pod B &#8212; 1/3</text>
  <rect x="712" y="152" width="120" height="30" rx="5" fill="#dcfce7" stroke="#16a34a"/>
  <text x="772" y="172" text-anchor="middle" fill="#15803d" font-size="10">pod C &#8212; 1/3</text>
  <text x="466" y="206" fill="#15803d" font-size="10" font-weight="bold">grpc.WithDefaultServiceConfig(</text>
  <text x="466" y="222" fill="#166534" font-family="ui-monospace,monospace" font-size="10">  `{"loadBalancingConfig":[{"round_robin":{}}]}`)</text>
  <text x="466" y="238" fill="#166534" font-size="10">Requires a HEADLESS service so DNS returns pod IPs.</text>

  <rect x="24" y="260" width="832" height="130" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="282" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Target URI syntax &#8212; the scheme selects the resolver</text>
  <g font-size="10">
    <text x="48" y="306" fill="#334155" font-family="ui-monospace,monospace">dns:///inventory.svc:50051</text>
    <text x="360" y="306" fill="#475569">THREE slashes: the authority is empty. Prefer this explicit form.</text>
    <text x="48" y="326" fill="#334155" font-family="ui-monospace,monospace">dns://8.8.8.8/inventory.svc:50051</text>
    <text x="360" y="326" fill="#475569">TWO slashes = "use 8.8.8.8 as the DNS server". Rarely intended.</text>
    <text x="48" y="346" fill="#334155" font-family="ui-monospace,monospace">passthrough:///10.0.1.4:50051</text>
    <text x="360" y="346" fill="#475569">Hand the string to the dialer verbatim. REQUIRED for bufconn.</text>
    <text x="48" y="366" fill="#334155" font-family="ui-monospace,monospace">unix:///var/run/svc.sock</text>
    <text x="360" y="366" fill="#475569">Unix domain socket, absolute path.</text>
    <text x="48" y="384" fill="#334155" font-family="ui-monospace,monospace">xds:///inventory.svc</text>
    <text x="360" y="384" fill="#475569">Control-plane discovery (Envoy/Istio-style).</text>
  </g>
</svg>
```

## 5. Implementation

### A production client factory

```go
// Package client constructs and owns gRPC client connections.
package client

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"os"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/connectivity"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/keepalive"
)

type Config struct {
	// Prefer the explicit URI form: dns:///host:port. A bare host:port also
	// resolves through DNS under NewClient, but being explicit documents intent
	// and survives a future default change.
	Target string

	CACertFile     string // server verification; empty = system roots
	ClientCertFile string // mTLS
	ClientKeyFile  string
	ServerName     string // SNI / verification override
	AllowInsecure  bool   // local development only

	MaxRecvMsgSize int
	MaxSendMsgSize int

	// Keepalive MUST agree with the server's EnforcementPolicy, or you get
	// GOAWAY "too_many_pings" surfacing as intermittent Unavailable.
	KeepaliveTime    time.Duration
	KeepaliveTimeout time.Duration

	// Warm-up bound. WithBlock is IGNORED by NewClient, so eager connection is
	// now an explicit Connect() plus a wait.
	ConnectTimeout time.Duration
}

func New(cfg Config) (*grpc.ClientConn, error) {
	if cfg.Target == "" {
		return nil, errors.New("target is required")
	}
	setDefaults(&cfg)

	creds, err := buildCredentials(cfg)
	if err != nil {
		return nil, err
	}

	opts := []grpc.DialOption{
		grpc.WithTransportCredentials(creds),

		// round_robin must be requested: the default pick_first sends ALL
		// traffic to one backend even when DNS returns many addresses.
		// Retry and per-method policy also live here (chapter 21).
		grpc.WithDefaultServiceConfig(`{
			"loadBalancingConfig": [{"round_robin": {}}],
			"methodConfig": [{
				"name": [{"service": "acme.inventory.v1.InventoryService"}],
				"waitForReady": false,
				"retryPolicy": {
					"maxAttempts": 4,
					"initialBackoff": "0.1s",
					"maxBackoff": "2s",
					"backoffMultiplier": 2,
					"retryableStatusCodes": ["UNAVAILABLE", "RESOURCE_EXHAUSTED"]
				}
			}]
		}`),

		grpc.WithDefaultCallOptions(
			grpc.MaxCallRecvMsgSize(cfg.MaxRecvMsgSize),
			grpc.MaxCallSendMsgSize(cfg.MaxSendMsgSize),
		),

		grpc.WithKeepaliveParams(keepalive.ClientParameters{
			Time:    cfg.KeepaliveTime,    // >= server EnforcementPolicy.MinTime
			Timeout: cfg.KeepaliveTimeout,
			// If true, the server's policy must also permit it.
			PermitWithoutStream: true,
		}),

		// Reconnection backoff. The defaults (1s base, 1.6x, 120s max, 20%
		// jitter, per gRFC A6) are sensible; tighten MaxDelay when a client
		// must recover quickly from a rolling restart.
		grpc.WithConnectParams(grpc.ConnectParams{
			Backoff: backoff.Config{
				BaseDelay:  200 * time.Millisecond,
				Multiplier: 1.6,
				Jitter:     0.2,
				MaxDelay:   15 * time.Second,
			},
			MinConnectTimeout: 5 * time.Second,
		}),
	}

	// grpc.NewClient replaces Dial/DialContext (grpc-go v1.63+). It is LAZY:
	// this returns immediately without contacting the server, and an
	// unreachable backend surfaces on the first RPC, not here.
	conn, err := grpc.NewClient(cfg.Target, opts...)
	if err != nil {
		// This only fails on bad arguments — an unparseable target, a missing
		// resolver scheme, conflicting options. Never on an unreachable server.
		return nil, fmt.Errorf("new client for %q: %w", cfg.Target, err)
	}
	return conn, nil
}

func buildCredentials(cfg Config) (credentials.TransportCredentials, error) {
	if cfg.AllowInsecure {
		// Named "insecure" deliberately. Local development only; it also
		// blocks PerRPCCredentials whose RequireTransportSecurity is true.
		return insecure.NewCredentials(), nil
	}

	tlsCfg := &tls.Config{
		MinVersion: tls.VersionTLS12,
		ServerName: cfg.ServerName, // empty = derived from the target host
	}

	if cfg.CACertFile != "" {
		pem, err := os.ReadFile(cfg.CACertFile)
		if err != nil {
			return nil, fmt.Errorf("read CA file: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, errors.New("CA file contained no valid certificates")
		}
		tlsCfg.RootCAs = pool
	}

	// mTLS: present a client certificate the server will verify.
	if cfg.ClientCertFile != "" {
		cert, err := tls.LoadX509KeyPair(cfg.ClientCertFile, cfg.ClientKeyFile)
		if err != nil {
			return nil, fmt.Errorf("load client key pair: %w", err)
		}
		tlsCfg.Certificates = []tls.Certificate{cert}
	}

	return credentials.NewTLS(tlsCfg), nil
}
```

### Warm-up: replacing `WithBlock`

```go
// WaitForReady blocks until the channel reaches READY or ctx expires.
//
// This replaces grpc.WithBlock() + grpc.WithTimeout(), both IGNORED by
// grpc.NewClient. Call it at startup when you would rather fail fast than
// discover an unreachable dependency on the first user request.
//
// Prefer a real health-check RPC where you can: READY means "a transport was
// established", not "the server can serve" — the process may still be
// initialising its own dependencies.
func WaitForReady(ctx context.Context, conn *grpc.ClientConn) error {
	// Explicitly leave IDLE. Without this the channel never attempts to
	// connect, because NewClient is lazy.
	conn.Connect()

	for {
		state := conn.GetState()
		switch state {
		case connectivity.Ready:
			return nil

		case connectivity.Shutdown:
			return errors.New("connection is shut down")

		case connectivity.TransientFailure:
			// Keep waiting: the backoff timer will retry. Bounded by ctx.
			// Nudge it out of idle-after-failure if it lands there.
			conn.Connect()
		}

		// Blocks until the state differs from `state`, or ctx expires.
		if !conn.WaitForStateChange(ctx, state) {
			return fmt.Errorf("timed out waiting for connection to %s (last state: %s)",
				conn.Target(), state)
		}
	}
}

// WaitForHealthy is the stronger check: it proves the server can actually
// serve, not merely that a transport exists.
func WaitForHealthy(ctx context.Context, conn *grpc.ClientConn, service string) error {
	hc := healthpb.NewHealthClient(conn)

	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()

	for {
		// waitForReady queues the probe through a transient failure instead of
		// failing immediately — appropriate here, where we WANT to wait.
		resp, err := hc.Check(ctx, &healthpb.HealthCheckRequest{Service: service},
			grpc.WaitForReady(true))
		if err == nil && resp.GetStatus() == healthpb.HealthCheckResponse_SERVING {
			return nil
		}

		select {
		case <-ctx.Done():
			return fmt.Errorf("service %q not healthy before deadline: %w", service, ctx.Err())
		case <-ticker.C:
		}
	}
}
```

### Owning the connection

```go
// Clients holds every downstream connection for the process. Constructed once
// in main, closed once on shutdown. Stubs are cheap and stateless, so they are
// created up front and shared.
type Clients struct {
	Inventory inventoryv1.InventoryServiceClient
	Pricing   pricingv1.PricingServiceClient

	conns []*grpc.ClientConn
}

func NewClients(ctx context.Context, cfg Config) (*Clients, error) {
	c := &Clients{}

	invConn, err := New(Config{Target: cfg.InventoryTarget, CACertFile: cfg.CACert})
	if err != nil {
		return nil, err
	}
	c.conns = append(c.conns, invConn)
	c.Inventory = inventoryv1.NewInventoryServiceClient(invConn)

	priceConn, err := New(Config{Target: cfg.PricingTarget, CACertFile: cfg.CACert})
	if err != nil {
		c.Close()
		return nil, err
	}
	c.conns = append(c.conns, priceConn)
	c.Pricing = pricingv1.NewPricingServiceClient(priceConn)

	// Optional startup validation. Skip it for optional dependencies you would
	// rather degrade around than refuse to start without.
	warmCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := WaitForHealthy(warmCtx, invConn, "acme.inventory.v1.InventoryService"); err != nil {
		c.Close()
		return nil, fmt.Errorf("inventory dependency unhealthy: %w", err)
	}

	return c, nil
}

func (c *Clients) Close() error {
	var errs []error
	for _, conn := range c.conns {
		if err := conn.Close(); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}
```

### Migrating from `Dial`

```go
// --- BEFORE (deprecated) ----------------------------------------------------
conn, err := grpc.DialContext(ctx, "inventory.svc:50051",
	grpc.WithTransportCredentials(creds),
	grpc.WithBlock(),                  // wait for READY
	grpc.WithTimeout(5*time.Second),   // bound that wait
)

// --- AFTER ------------------------------------------------------------------
conn, err := grpc.NewClient("dns:///inventory.svc:50051",
	grpc.WithTransportCredentials(creds),
	// WithBlock and WithTimeout are IGNORED. Warm up explicitly instead:
)
if err != nil { return err }

warmCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
defer cancel()
if err := WaitForReady(warmCtx, conn); err != nil { return err }
```

```go
// --- bufconn tests: the passthrough gotcha ---------------------------------
// Dial's default resolver was passthrough, so "bufnet" worked. NewClient's
// default is dns, which tries to resolve "bufnet" and fails. The fix is an
// explicit passthrough scheme.
lis := bufconn.Listen(1024 * 1024)

conn, err := grpc.NewClient(
	"passthrough:///bufnet",     // <-- REQUIRED with NewClient
	grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
		return lis.DialContext(ctx)
	}),
	grpc.WithTransportCredentials(insecure.NewCredentials()),
)
```

### Observing connection state

```go
// monitorState logs every connectivity transition. Worth running in any
// long-lived client: it turns "the service was flaky at 03:14" into a timeline.
func monitorState(ctx context.Context, conn *grpc.ClientConn, log *slog.Logger) {
	for {
		state := conn.GetState()
		log.Info("channel state", "target", conn.Target(), "state", state.String())

		if state == connectivity.Shutdown {
			return
		}
		if !conn.WaitForStateChange(ctx, state) {
			return // ctx cancelled
		}
	}
}
```

## 6. Advantages, Disadvantages & Trade-offs

**Advantages of the channel model**
- **One connection, many concurrent RPCs**, with automatic reconnection and no pooling code.
- **Resolver and balancer are pluggable**, so DNS, xDS or a custom discovery mechanism all look the same to your code.
- **Lazy construction** means a client can be built before its dependency exists — useful in tests and in startup ordering.
- **Backoff with jitter is built in**, per gRFC A6, so a restarting backend does not get a thundering herd.

**Disadvantages**
- **`pick_first` default surprises people** — a Service with replicas gets all traffic on one pod unless you configure `round_robin`.
- **Laziness hides misconfiguration** until the first RPC, which may be in production traffic.
- **The `Dial` → `NewClient` behavioural change** is easy to migrate incorrectly, especially the `passthrough` default.
- **DNS-based load balancing is coarse**: it rebalances only when the resolver refreshes, which is why `MaxConnectionAge` on the server matters (chapter 18).

**Trade-offs**
- *Fail fast vs `WaitForReady`:* fast errors let callers shed load and use fallbacks; waiting hides brief blips but queues work. Choose per method, never globally, and always with a deadline.
- *Warm-up at startup vs lazy:* warming up fails fast on a broken dependency but couples your start-up to theirs. Warm up for required dependencies, stay lazy for optional ones.
- *One channel vs a small pool:* one is right by default; a pool only when `MaxConcurrentStreams` or TCP head-of-line blocking is a measured bottleneck.

## 7. Common Mistakes & Best Practices

- **Creating a `ClientConn` per request.** Costs DNS, TCP and TLS handshakes plus a file descriptor, and defeats multiplexing. One per target, per process.
- **Expecting `NewClient` to fail on an unreachable server.** It is lazy; it fails on bad arguments only.
- **Using `WithBlock` / `WithTimeout` with `NewClient`.** Silently ignored. Use `Connect()` plus `WaitForStateChange`, or a health probe.
- **Leaving the default `pick_first`** against a multi-replica target. All traffic lands on one pod.
- **`bufconn` tests failing after the migration.** Add `passthrough:///` to the target.
- **`dns://host/target` with two slashes.** That makes `host` the DNS *server*. You want three slashes.
- **Client keepalive more aggressive than the server's `MinTime`.** `GOAWAY: too_many_pings` → intermittent `Unavailable`.
- **`WaitForReady(true)` without a deadline.** An unbounded queue of doomed requests.
- **Not closing the connection**, or closing it per call. `defer conn.Close()` at the owning scope.
- **Assuming `READY` means "healthy".** It means a transport exists. Use the health service for readiness.
- **Sending per-RPC credentials over an insecure connection.** gRPC blocks it by default; disabling that guard leaks tokens in plaintext.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** `GRPC_GO_LOG_SEVERITY_LEVEL=info GRPC_GO_LOG_VERBOSITY_LEVEL=99` shows resolver updates, subchannel state transitions and `GOAWAY` frames — nearly every client problem is visible there. `channelz` exposes live channel, subchannel and socket state, including the addresses actually in use.
- **Monitoring.** Track channel state transitions per target, subchannel count, and per-method error rate by code. `TRANSIENT_FAILURE` frequency is your best early signal of an unhealthy dependency; a subchannel count stuck at 1 against a replicated target means `pick_first` is still in effect.
- **Security.** TLS with verified roots, mTLS between services where you have a CA, and never `insecure.NewCredentials()` outside local development. Do not disable `RequireTransportSecurity` on per-RPC credentials — that guard is what prevents tokens travelling in plaintext. Set `ServerName` explicitly when connecting through a proxy or by IP, or verification silently checks the wrong name.
- **Scaling.** DNS-based `round_robin` rebalances only when the resolver refreshes and connections rotate, so pair it with server-side `MaxConnectionAge` (chapter 18). For finer control — locality awareness, weighted backends, outlier ejection — the answer is a lookaside balancer or xDS rather than tuning DNS.

## 9. Interview Questions

**Q: What is a `grpc.ClientConn`?**
A: A virtual channel, not a socket. It holds a resolver that turns the target into a list of addresses, a load-balancing policy, and a set of subchannels each with its own connectivity state and reconnection backoff. It is goroutine-safe and multiplexes concurrent RPCs over HTTP/2 streams, so the correct usage is one per target for the process lifetime, shared everywhere. Creating one per request costs DNS, TCP and TLS handshakes plus a file descriptor, and defeats multiplexing entirely.

**Q: How does `grpc.NewClient` differ from `grpc.Dial`?**
A: Four ways that matter. The default resolver for a bare `host:port` changed from `passthrough` to `dns`. It is lazy — no connection attempt until the first RPC — where `Dial` connected eagerly in the background. `WithBlock`, `WithTimeout` and `FailOnNonTempDialError` are ignored. And the target is parsed as a URI, so the explicit forms like `dns:///host:port` and `passthrough:///bufnet` matter. The resolver change is the one that breaks things silently, particularly `bufconn` tests and custom dialers that relied on the old default.

**Q: `NewClient` returned no error but the server is down. Why?**
A: Because it is lazy and only validates arguments — an unparseable target, an unknown resolver scheme, conflicting options. It never contacts the server, so an unreachable backend surfaces as `Unavailable` on the first RPC. If you want startup validation, call `conn.Connect()` to leave the idle state and then loop on `WaitForStateChange` until `READY`, bounded by a context — or better, issue a health-check RPC, because `READY` means a transport was established, not that the server can serve.

**Q: What are the connectivity states and what happens in `TRANSIENT_FAILURE`?**
A: `IDLE`, `CONNECTING`, `READY`, `TRANSIENT_FAILURE` and `SHUTDOWN`. In `TRANSIENT_FAILURE` the last attempt failed and a backoff timer is running; new RPCs fail immediately with `Unavailable` unless they set `WaitForReady`, in which case they queue until the channel becomes ready or the deadline expires. Fail-fast is the default and is right for user-facing paths where a fast error beats a slow success; wait-for-ready suits background work, but only ever with a deadline, or you have built an unbounded queue of doomed requests.

**Q: Why does one client send all traffic to one pod despite three replicas?**
A: Because the default balancer is `pick_first`, which connects to the first address that succeeds and uses only that one. Getting distribution needs `round_robin`, requested via `WithDefaultServiceConfig` with a `loadBalancingConfig`, plus a target whose DNS actually returns multiple addresses — in Kubernetes that means a headless service, since a normal `ClusterIP` service resolves to a single virtual IP. Even then, rebalancing happens only when the resolver refreshes and connections rotate, which is why server-side `MaxConnectionAge` is the other half of the fix.

**Q: What is the difference between transport credentials and per-RPC credentials?**
A: Transport credentials secure the connection — TLS, mTLS, or `insecure.NewCredentials()` — and exactly one applies per `ClientConn`. Per-RPC credentials attach a caller identity to each call as metadata: an OAuth token, a JWT, a service-account token, and several can apply. They are independent decisions and production needs both. Importantly, gRPC refuses by default to send per-RPC credentials over an insecure connection, via `RequireTransportSecurity`, and disabling that guard is how tokens end up in plaintext.

**Q: How do you write a `bufconn` test after the `NewClient` migration?**
A: Use `passthrough:///bufnet` as the target alongside `grpc.WithContextDialer`. Under `Dial` the default resolver was `passthrough`, so the fake target string was handed straight to the custom dialer; `NewClient` defaults to `dns` and tries to resolve `bufnet`, which fails. Adding the explicit `passthrough:///` scheme restores the old behaviour and is the standard fix — it is the most common breakage in this migration.

**Q: (Senior) Design the client layer for a service with several downstream dependencies.**
A: One `ClientConn` per target, constructed at process start in a small `Clients` container that also holds the generated stubs, since stubs are cheap and stateless. Targets are explicit URIs with a scheme. Each connection gets TLS or mTLS, a service config selecting `round_robin` plus per-method retry and deadline defaults, keepalive matched to the server's enforcement policy, and connection backoff tightened enough to recover quickly from a rolling restart. At startup I warm up *required* dependencies with a bounded health check and refuse to start if they fail, while leaving optional ones lazy so a degraded dependency does not prevent boot. The container owns `Close`, called once during shutdown after the server has drained. I would also run a small goroutine per connection logging every connectivity transition, because that turns "the service was flaky last night" into a timeline. What I would not build is a connection pool — that is only warranted when `MaxConcurrentStreams` or TCP head-of-line blocking is a measured bottleneck.

**Q: (Senior) After migrating to `NewClient`, latency rose and one pod is hot. Diagnose.**
A: The hot pod points at load balancing, and the migration is a plausible cause in two ways. First, if the old code used `Dial` with a target that some sidecar or proxy handled, the switch to the `dns` resolver may now be resolving to a single `ClusterIP` — a normal Kubernetes service — so every client sees exactly one address and `pick_first` has nothing to spread across. The fix is a headless service so DNS returns pod IPs, plus `round_robin` in the service config. Second, if `round_robin` was previously configured through a `DialOption` that did not survive the migration, the default `pick_first` is back. I would confirm by inspecting channelz for the resolved address list and the subchannel count — one subchannel against a replicated target settles it immediately. For the latency rise specifically, I would also check whether `WithBlock` removal means the first requests after each deploy now pay connection setup, which shows as a p99 spike at rollout rather than a steady increase. Longer term, DNS rebalancing is coarse, so I would pair `round_robin` with server-side `MaxConnectionAge` so connections rotate, and consider xDS if we need locality awareness or outlier ejection.

**Q: (Senior) When is `WaitForReady(true)` the right choice, and what are its risks?**
A: It suits background and best-effort work where a brief dependency blip should not surface as an error — a batch job, an async publisher, a retry-driven reconciler — because queuing through a few seconds of `TRANSIENT_FAILURE` is cheaper than propagating a failure and retrying at a higher layer. It is wrong on user-facing paths, where a fast `Unavailable` lets the caller shed load, serve a cached response or fail over, and a slow success is worse than a fast failure. The risks are all about unboundedness: without a deadline it queues indefinitely, and under a sustained outage those queued RPCs hold goroutines and memory on the client while contributing nothing — which turns a dependency outage into a client outage. So the rule is: set it per method rather than globally, always pair it with a deadline chosen from the caller's budget, and monitor queued-call duration so you can see it happening.

## 10. Quick Revision & Cheat Sheet

```go
conn, err := grpc.NewClient(
    "dns:///inventory.svc:50051",                     // explicit URI, 3 slashes
    grpc.WithTransportCredentials(credentials.NewTLS(tlsCfg)),
    grpc.WithDefaultServiceConfig(`{
        "loadBalancingConfig": [{"round_robin": {}}]  // pick_first is the DEFAULT
    }`),
    grpc.WithDefaultCallOptions(
        grpc.MaxCallRecvMsgSize(8<<20), grpc.MaxCallSendMsgSize(8<<20)),
    grpc.WithKeepaliveParams(keepalive.ClientParameters{
        Time: 30*time.Second, Timeout: 10*time.Second, PermitWithoutStream: true,
    }),
)
defer conn.Close()

client := pb.NewInventoryServiceClient(conn)   // stubs are cheap; share the conn
```

| Migration | `Dial` | `NewClient` |
|---|---|---|
| Default resolver | `passthrough` | `dns` |
| Eager connect | yes | **no** |
| `WithBlock` / `WithTimeout` | honoured | **ignored** |
| bufconn target | `"bufnet"` | `"passthrough:///bufnet"` |
| Startup wait | `WithBlock` | `Connect()` + `WaitForStateChange`, or a health probe |

| State | Meaning |
|---|---|
| `IDLE` | No attempt in progress; `NewClient` starts here |
| `CONNECTING` | Resolving / handshaking |
| `READY` | RPCs flow (transport exists — not necessarily healthy) |
| `TRANSIENT_FAILURE` | Backoff running; RPCs fail fast unless `WaitForReady` |
| `SHUTDOWN` | `Close()` called; terminal |

**Flash cards**
- **How many `ClientConn`s?** → One per target, per process. Goroutine-safe.
- **`NewClient` is lazy?** → Yes. It fails on bad arguments only, never on an unreachable server.
- **Default balancer?** → `pick_first`. Ask for `round_robin` explicitly.
- **`WithBlock` under `NewClient`?** → Ignored. Use `Connect()` + `WaitForStateChange`.
- **bufconn after migration?** → `passthrough:///bufnet`.
- **`dns:///` slashes?** → Three. Two makes the host a DNS server.
- **`READY` means healthy?** → No. It means a transport exists. Use the health service.

## 11. Hands-On Exercises & Mini Project

- [ ] Create a `ClientConn` against a stopped server. Confirm `NewClient` returns no error, then observe the first RPC failing with `Unavailable`.
- [ ] Run three server replicas behind a headless service. Measure request distribution with the default balancer, then add `round_robin` and measure again.
- [ ] Log every connectivity transition with `monitorState`, restart a backend, and record the full `READY → TRANSIENT_FAILURE → CONNECTING → READY` sequence with its backoff timings.
- [ ] Migrate a `DialContext` call with `WithBlock` to `NewClient`, and implement the equivalent warm-up. Verify both fail within the same budget against a dead server.
- [ ] Break a `bufconn` test by using `"bufnet"` with `NewClient`, read the resolver error, then fix it with `passthrough:///`.
- [ ] Issue an RPC during `TRANSIENT_FAILURE` with and without `WaitForReady(true)`, both with a 2-second deadline, and compare the codes and timings.
- [ ] Configure a client keepalive `Time` below the server's `MinTime` and find `too_many_pings` in the verbose logs.

### Mini Project — "Resilient Client Layer"

**Goal.** Build the client layer you would ship: correct lifecycle, observable state, and measured behaviour during backend churn.

**Requirements.**
1. A `Clients` container constructing one `ClientConn` per target at startup, holding stubs, and owning `Close`.
2. Explicit URI targets, TLS with a custom CA, and optional mTLS, all driven by configuration and validated at startup.
3. A service config selecting `round_robin` plus per-method deadline and retry defaults, and a test proving distribution across three replicas.
4. Warm-up that health-checks required dependencies with a bounded context and refuses to start on failure, while optional dependencies stay lazy.
5. A state-monitoring goroutine per connection emitting a metric and a log line on every transition.
6. A chaos test: kill and restart backends during steady load, recording error counts by code, time-to-recovery, and the observed backoff sequence.
7. A comparison of fail-fast versus `WaitForReady(true)` for the same workload during a 10-second outage, reporting error count, p99 latency and queued-call duration.

**Extensions.**
- Add a small connection pool and measure whether it helps at concurrency levels above the server's `MaxConcurrentStreams`.
- Swap DNS for a custom resolver reading from a config file, and demonstrate live address updates without restarting the client.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Invoking All Four Method Kinds from Go* (using the stubs built here), *Deadlines, Retries, Service Config & Load Balancing* (the service config in depth), *Build: The gRPC Server* (the server side of these credentials and keepalive settings), *Graceful Shutdown* (why connections must rotate), *Testing gRPC in Go* (bufconn and the `passthrough` gotcha).

- **grpc-go — ClientConn and DialOption documentation** — gRPC Authors · *Intermediate* · every option, the connectivity states, and the `NewClient` semantics. The primary reference for this chapter. <https://pkg.go.dev/google.golang.org/grpc#NewClient>
- **grpc-go — Name resolution design** — gRPC Authors · *Advanced* · target URI syntax, resolver schemes, and how address updates propagate to the balancer. <https://github.com/grpc/grpc/blob/master/doc/naming.md>
- **gRPC Blog — gRPC Load Balancing** — gRPC Authors · *Intermediate* · why `pick_first` is the default, what `round_robin` requires, and when a lookaside balancer is the answer. <https://grpc.io/blog/grpc-load-balancing/>
- **gRFC A6 — client retries and backoff** — gRPC Authors · *Advanced* · the connection backoff algorithm and its default parameters, plus the retry policy used in the service config. <https://github.com/grpc/proposal/blob/master/A6-client-retries.md>
- **gRPC — Authentication guide** — grpc.io · *Intermediate* · transport versus per-RPC credentials, TLS, mTLS and token-based auth with Go examples. <https://grpc.io/docs/guides/auth/>
- **grpc-go examples — features/name_resolving, load_balancing, health** — gRPC Authors · *Intermediate* · runnable demonstrations of custom resolvers, balancer selection and health-based readiness. <https://github.com/grpc/grpc-go/tree/master/examples/features>
- **grpc-go — Dial to NewClient migration notes** — gRPC Authors · *Intermediate* · the release notes and issue thread documenting the behavioural differences, including the `passthrough` default change. <https://github.com/grpc/grpc-go/releases/tag/v1.63.0>
- **channelz — gRPC connection introspection** — gRPC Authors · *Intermediate* · inspecting live channels, subchannels and sockets, including the resolved address list. <https://grpc.io/blog/a-short-introduction-to-channelz/>

---

*gRPC with Go Handbook — chapter 19.*
