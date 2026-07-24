# 14 · Build: The gRPC Server — net.Listen, grpc.NewServer & Registration

> **In one line:** Four lines get a gRPC server running — listen, construct, register, serve — and the twenty lines around them, the `ServerOption`s you set on day one, are what separate a demo from something you can leave running.

---

## 1. Overview

The minimal gRPC server in Go is genuinely four statements:

```go
lis, _ := net.Listen("tcp", ":50051")
s := grpc.NewServer()
pb.RegisterInventoryServiceServer(s, &server{})
s.Serve(lis)
```

That works, and it is what every tutorial shows. It is also missing every limit, every credential, every interceptor, every health check and every shutdown path — which is fine for ten minutes and dangerous for ten days. This chapter builds the version you actually deploy, explaining each addition rather than presenting a wall of options.

The structural idea is that `grpc.NewServer` takes a variadic list of `ServerOption`s, and those options are your entire configuration surface. There is no config file, no `ServerConfig` struct — everything from TLS to message-size limits to interceptor chains is a function you pass in. Knowing the ten that matter, and their defaults, is most of what production readiness means at this layer.

The other half is **wiring**: how the server, the service implementation, the store and the dependencies fit together so the thing is testable. A `main.go` that constructs a database connection inside a handler is untestable; a `main.go` that does nothing but assemble and hand off is trivial to test. Chapter 27 depends on the structure established here.

Chapters 15–17 implement the handlers themselves; chapter 18 covers shutdown and keepalive in depth. This chapter is the scaffolding they hang from.

## 2. Core Concepts

- **`net.Listener`** — a standard-library TCP (or Unix socket) listener. gRPC does not open the socket for you; you hand it one.
- **`grpc.NewServer(opts ...ServerOption) *grpc.Server`** — constructs the server. All configuration is options.
- **`ServerOption`** — a function modifying the server's internal config. `grpc.Creds`, `grpc.MaxRecvMsgSize`, `grpc.ChainUnaryInterceptor`, etc.
- **`RegisterXxxServer(s grpc.ServiceRegistrar, impl XxxServer)`** — generated function that installs the service's `ServiceDesc` into the server's dispatch table.
- **`grpc.ServiceRegistrar`** — the interface `RegisterXxxServer` actually takes, which is why test harnesses and wrappers can substitute for `*grpc.Server`.
- **`Serve(lis)`** — blocks, accepting connections, until `Stop` or `GracefulStop`. Returns `nil` after a graceful stop.
- **Transport credentials** — `grpc.Creds(...)`: TLS, mTLS, or `insecure.NewCredentials()` for local development only.
- **Interceptor chain** — `grpc.ChainUnaryInterceptor` / `grpc.ChainStreamInterceptor`, executed outside-in (chapter 23).
- **`UnimplementedXxxServer`** — the mandatory embed making added RPCs non-breaking (chapter 7).
- **Registration ordering** — all `Register…` calls must complete *before* `Serve`; registering afterwards panics.
- **`h2c`** — cleartext HTTP/2, needed when serving gRPC and HTTP on one port without TLS.

## 3. Theory & Principles

### What `grpc.NewServer` actually builds

The returned `*grpc.Server` holds:

- A **service map**: `"acme.inventory.v1.InventoryService"` → `*ServiceInfo`, containing the method table from the generated `ServiceDesc`.
- A **transport configuration**: credentials, keepalive parameters, window sizes, concurrency and message-size limits.
- **Interceptor chains** for unary and streaming calls.
- A **connection registry** used by `GracefulStop` to send `GOAWAY` and drain.

`Serve(lis)` then loops on `lis.Accept()`, and for each connection performs the HTTP/2 handshake and spawns a goroutine per connection. Within a connection, **each stream gets its own goroutine**, which is why gRPC concurrency in Go is "one goroutine per in-flight RPC" and why `MaxConcurrentStreams` is a real memory control rather than a nicety.

The dispatch path per RPC: read `:path` → look up service and method in the map → build a `context.Context` carrying metadata, peer info and the deadline derived from `grpc-timeout` → run the interceptor chain → unmarshal → call your handler.

### The ten options that matter on day one

| Option | Default | Why to set it |
|---|---|---|
| `grpc.Creds(...)` | insecure | TLS is not optional outside localhost |
| `grpc.MaxRecvMsgSize(n)` | 4 MiB | Explicit is better than discovering it in production |
| `grpc.MaxSendMsgSize(n)` | unlimited | An unbounded response is an OOM waiting to happen |
| `grpc.MaxConcurrentStreams(n)` | ~unlimited | One client should not spawn unbounded goroutines |
| `grpc.ChainUnaryInterceptor(...)` | none | Recovery, logging, metrics, auth, validation |
| `grpc.ChainStreamInterceptor(...)` | none | Same, for streams |
| `grpc.KeepaliveParams(...)` | none | Detect dead peers; rotate connections for load balancing |
| `grpc.KeepaliveEnforcementPolicy(...)` | strict-ish | Or clients get mysterious `too_many_pings` |
| `grpc.ConnectionTimeout(d)` | 120s | Bound the handshake |
| `grpc.StatsHandler(...)` | none | OpenTelemetry tracing and metrics (chapter 26) |

Two notes. **`MaxSendMsgSize` defaults to unlimited**, which surprises people who assume symmetry with the 4 MiB receive limit — a handler that accidentally returns a million rows will happily try to serialise them. And **`MaxConcurrentStreams` in grpc-go defaults to effectively unlimited**, unlike many other implementations that default to 100; a single misbehaving client can therefore spawn unbounded goroutines.

### `ChainUnaryInterceptor` vs `UnaryInterceptor`

`grpc.UnaryInterceptor` accepts exactly one interceptor and **silently replaces** any previously set one — passing it twice is a bug that compiles. `grpc.ChainUnaryInterceptor` accepts many and composes them. Always use the `Chain` variants; there is no reason to use the singular form.

Order matters and is **outside-in**: the first interceptor in the list is outermost, so it sees the request first and the response last. The canonical ordering is recovery → tracing → logging → metrics → auth → rate limit → validation → handler, for reasons chapter 23 works through in detail.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="sb1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#0ea5e9"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">From net.Listen to your handler</text>

  <rect x="30" y="42" width="176" height="60" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="118" y="64" text-anchor="middle" fill="#3730a3" font-family="ui-monospace,monospace" font-size="10">net.Listen("tcp", ":50051")</text>
  <text x="118" y="84" text-anchor="middle" fill="#4338ca" font-size="10">YOU open the socket &#8212;</text>
  <text x="118" y="98" text-anchor="middle" fill="#4338ca" font-size="10">gRPC never does</text>

  <path d="M208,72 L252,72" stroke="#0ea5e9" stroke-width="2" marker-end="url(#sb1)"/>

  <rect x="256" y="42" width="176" height="60" rx="8" fill="#e0e7ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="344" y="64" text-anchor="middle" fill="#3730a3" font-family="ui-monospace,monospace" font-size="10">grpc.NewServer(opts...)</text>
  <text x="344" y="84" text-anchor="middle" fill="#4338ca" font-size="10">ServerOptions ARE the</text>
  <text x="344" y="98" text-anchor="middle" fill="#4338ca" font-size="10">entire config surface</text>

  <path d="M434,72 L478,72" stroke="#0ea5e9" stroke-width="2" marker-end="url(#sb1)"/>

  <rect x="482" y="42" width="186" height="60" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="575" y="64" text-anchor="middle" fill="#15803d" font-family="ui-monospace,monospace" font-size="10">RegisterXxxServer(s, impl)</text>
  <text x="575" y="84" text-anchor="middle" fill="#166534" font-size="10">installs ServiceDesc into</text>
  <text x="575" y="98" text-anchor="middle" fill="#166534" font-size="10">the dispatch map</text>

  <path d="M670,72 L714,72" stroke="#0ea5e9" stroke-width="2" marker-end="url(#sb1)"/>

  <rect x="718" y="42" width="138" height="60" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="787" y="64" text-anchor="middle" fill="#92400e" font-family="ui-monospace,monospace" font-size="10">s.Serve(lis)</text>
  <text x="787" y="84" text-anchor="middle" fill="#b45309" font-size="10">BLOCKS. All Register</text>
  <text x="787" y="98" text-anchor="middle" fill="#b45309" font-size="10">calls must precede it.</text>

  <rect x="30" y="122" width="826" height="150" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="443" y="144" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Per-request dispatch inside Serve</text>
  <rect x="52" y="158" width="120" height="40" rx="6" fill="#fff" stroke="#94a3b8"/>
  <text x="112" y="174" text-anchor="middle" fill="#334155" font-size="10">accept conn</text>
  <text x="112" y="190" text-anchor="middle" fill="#64748b" font-size="9">goroutine per conn</text>
  <path d="M174,178 L196,178" stroke="#0ea5e9" stroke-width="1.6" marker-end="url(#sb1)"/>
  <rect x="200" y="158" width="120" height="40" rx="6" fill="#fff" stroke="#94a3b8"/>
  <text x="260" y="174" text-anchor="middle" fill="#334155" font-size="10">read :path</text>
  <text x="260" y="190" text-anchor="middle" fill="#64748b" font-size="9">goroutine per STREAM</text>
  <path d="M322,178 L344,178" stroke="#0ea5e9" stroke-width="1.6" marker-end="url(#sb1)"/>
  <rect x="348" y="158" width="120" height="40" rx="6" fill="#fff" stroke="#94a3b8"/>
  <text x="408" y="174" text-anchor="middle" fill="#334155" font-size="10">lookup method</text>
  <text x="408" y="190" text-anchor="middle" fill="#64748b" font-size="9">in the ServiceDesc map</text>
  <path d="M470,178 L492,178" stroke="#0ea5e9" stroke-width="1.6" marker-end="url(#sb1)"/>
  <rect x="496" y="158" width="130" height="40" rx="6" fill="#fff" stroke="#94a3b8"/>
  <text x="561" y="174" text-anchor="middle" fill="#334155" font-size="10">build context</text>
  <text x="561" y="190" text-anchor="middle" fill="#64748b" font-size="9">metadata + grpc-timeout</text>
  <path d="M628,178 L650,178" stroke="#0ea5e9" stroke-width="1.6" marker-end="url(#sb1)"/>
  <rect x="654" y="158" width="180" height="40" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="744" y="174" text-anchor="middle" fill="#92400e" font-size="10">interceptor chain &#8594; handler</text>
  <text x="744" y="190" text-anchor="middle" fill="#b45309" font-size="9">unmarshal happens inside</text>

  <text x="52" y="224" fill="#475569">One goroutine per in-flight RPC. That is why MaxConcurrentStreams is a memory control, not a nicety:</text>
  <text x="52" y="242" fill="#475569">grpc-go's default is effectively unlimited, so one misbehaving client can spawn unbounded goroutines.</text>
  <text x="52" y="262" fill="#334155" font-weight="bold">MaxSendMsgSize also defaults to UNLIMITED &#8212; asymmetric with the 4 MiB receive default. Set both.</text>

  <rect x="30" y="290" width="826" height="166" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="443" y="312" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">UnaryInterceptor vs ChainUnaryInterceptor</text>
  <rect x="52" y="326" width="376" height="112" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="240" y="346" text-anchor="middle" fill="#b91c1c" font-weight="bold">grpc.UnaryInterceptor &#8212; singular</text>
  <text x="66" y="368" fill="#7f1d1d" font-family="ui-monospace,monospace" font-size="10">grpc.UnaryInterceptor(logging),</text>
  <text x="66" y="384" fill="#7f1d1d" font-family="ui-monospace,monospace" font-size="10">grpc.UnaryInterceptor(auth),   // silently</text>
  <text x="66" y="400" fill="#7f1d1d" font-family="ui-monospace,monospace" font-size="10">                               // REPLACES logging</text>
  <text x="66" y="424" fill="#991b1b" font-size="10">Compiles. Runs. Your logging interceptor never fires.</text>

  <rect x="452" y="326" width="382" height="112" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="643" y="346" text-anchor="middle" fill="#15803d" font-weight="bold">grpc.ChainUnaryInterceptor &#8212; always use this</text>
  <text x="466" y="368" fill="#14532d" font-family="ui-monospace,monospace" font-size="10">grpc.ChainUnaryInterceptor(</text>
  <text x="466" y="384" fill="#14532d" font-family="ui-monospace,monospace" font-size="10">  recovery, tracing, logging, metrics, auth)</text>
  <text x="466" y="408" fill="#166534" font-size="10">Order is OUTSIDE-IN: first in the list is outermost,</text>
  <text x="466" y="424" fill="#166534" font-size="10">sees the request first and the response last.</text>
</svg>
```

### Wiring for testability

The rule: **`main.go` assembles, it does not implement.** Dependencies flow inward through constructors, so a test can substitute any of them.

```
cmd/inventoryd/main.go        → parse config, build dependencies, call server.Run
internal/server/server.go     → build the *grpc.Server, register services, own the lifecycle
internal/inventory/service.go → implements the generated interface; takes a Store interface
internal/inventory/store.go   → the Store interface + a Postgres implementation
```

Because `RegisterXxxServer` takes a `grpc.ServiceRegistrar`, and because the service takes a `Store` interface rather than a `*sql.DB`, the whole stack is constructible in a test with a bufconn listener and an in-memory store (chapter 27).

## 4. Architecture & Workflow

The startup sequence of a production server, in order, with the failure mode each step guards against:

1. **Load and validate configuration.** Fail fast on a missing certificate path, not on the first TLS handshake.
2. **Build observability first.** A logger and meter, so every subsequent failure is visible.
3. **Open dependencies** — database pools, caches, downstream clients — with their own timeouts. A server that accepts traffic before its database is reachable serves errors.
4. **Construct the service implementation**, injecting those dependencies.
5. **Build `ServerOption`s**: credentials, limits, keepalive, interceptor chains, stats handlers.
6. **`grpc.NewServer(opts...)`.**
7. **Register**: your service, the health service, reflection (chapter 25), channelz if wanted. All before `Serve`.
8. **Mark health `NOT_SERVING`** until dependencies are verified, then `SERVING`. This is what makes a Kubernetes readiness probe meaningful.
9. **`net.Listen`**, then `Serve` in a goroutine.
10. **Wait for a signal**, then run the shutdown sequence (chapter 18).

```svg
<svg viewBox="0 0 880 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Wiring: main.go assembles, it never implements</text>

  <rect x="30" y="42" width="240" height="72" rx="10" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="150" y="64" text-anchor="middle" fill="#3730a3" font-size="12" font-weight="bold">cmd/inventoryd/main.go</text>
  <text x="46" y="86" fill="#4338ca" font-size="10">parse config &#183; build logger</text>
  <text x="46" y="102" fill="#4338ca" font-size="10">open DB &#183; call server.Run(deps)</text>

  <rect x="30" y="130" width="240" height="86" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="150" y="152" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">internal/server</text>
  <text x="46" y="174" fill="#166534" font-size="10">builds ServerOptions</text>
  <text x="46" y="190" fill="#166534" font-size="10">grpc.NewServer &#183; Register*</text>
  <text x="46" y="206" fill="#166534" font-size="10">owns Serve + GracefulStop</text>

  <rect x="30" y="232" width="240" height="86" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="150" y="254" text-anchor="middle" fill="#92400e" font-size="12" font-weight="bold">internal/inventory</text>
  <text x="46" y="276" fill="#b45309" font-size="10">implements the generated iface</text>
  <text x="46" y="292" fill="#b45309" font-size="10">takes a Store INTERFACE</text>
  <text x="46" y="308" fill="#b45309" font-size="10">no *sql.DB, no globals</text>

  <rect x="30" y="334" width="240" height="72" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="150" y="356" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">Store interface</text>
  <text x="46" y="378" fill="#6d28d9" font-size="10">postgresStore (production)</text>
  <text x="46" y="394" fill="#6d28d9" font-size="10">memStore (tests)</text>

  <rect x="300" y="42" width="556" height="180" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="578" y="64" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Startup order, and what each step prevents</text>
  <g font-size="10">
    <text x="318" y="88" fill="#334155" font-weight="bold">1. validate config</text><text x="470" y="88" fill="#475569">fail on a missing cert path, not on handshake #1</text>
    <text x="318" y="108" fill="#334155" font-weight="bold">2. logger + meter</text><text x="470" y="108" fill="#475569">so every later failure is visible</text>
    <text x="318" y="128" fill="#334155" font-weight="bold">3. open dependencies</text><text x="470" y="128" fill="#475569">never accept traffic before the DB is reachable</text>
    <text x="318" y="148" fill="#334155" font-weight="bold">4. build the service</text><text x="470" y="148" fill="#475569">inject deps through constructors</text>
    <text x="318" y="168" fill="#334155" font-weight="bold">5. ServerOptions</text><text x="470" y="168" fill="#475569">creds, limits, keepalive, interceptors</text>
    <text x="318" y="188" fill="#334155" font-weight="bold">6-7. NewServer + Register</text><text x="470" y="188" fill="#475569">ALL registration before Serve, or it panics</text>
    <text x="318" y="208" fill="#334155" font-weight="bold">8. health NOT_SERVING</text><text x="470" y="208" fill="#475569">flip to SERVING only after deps verify</text>
  </g>

  <rect x="300" y="238" width="556" height="168" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="578" y="260" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Defaults that will bite you</text>
  <g font-size="10">
    <text x="318" y="286" fill="#7f1d1d" font-weight="bold">MaxSendMsgSize</text><text x="500" y="286" fill="#991b1b">UNLIMITED by default &#8212; asymmetric with 4 MiB recv</text>
    <text x="318" y="308" fill="#7f1d1d" font-weight="bold">MaxConcurrentStreams</text><text x="500" y="308" fill="#991b1b">effectively unlimited in grpc-go &#8594; unbounded goroutines</text>
    <text x="318" y="330" fill="#7f1d1d" font-weight="bold">grpc.UnaryInterceptor</text><text x="500" y="330" fill="#991b1b">singular; a second call SILENTLY replaces the first</text>
    <text x="318" y="352" fill="#7f1d1d" font-weight="bold">no KeepaliveEnforcementPolicy</text><text x="500" y="352" fill="#991b1b">clients get GOAWAY "too_many_pings"</text>
    <text x="318" y="374" fill="#7f1d1d" font-weight="bold">Register after Serve</text><text x="500" y="374" fill="#991b1b">panics at runtime, not compile time</text>
    <text x="318" y="396" fill="#7f1d1d" font-weight="bold">insecure.NewCredentials()</text><text x="500" y="396" fill="#991b1b">spelled that way on purpose. Local dev only.</text>
  </g>
</svg>
```

## 5. Implementation

### `internal/server/server.go` — the production server

```go
// Package server owns the gRPC server's construction and lifecycle. It knows
// nothing about inventory business logic: services are injected.
package server

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/keepalive"
	"google.golang.org/grpc/reflection"
)

// Config is everything the transport layer needs. Validated before use so a
// bad certificate path fails at startup rather than on the first handshake.
type Config struct {
	Addr string // ":50051"

	// TLS. When CertFile is empty the server runs insecure — permitted only
	// when AllowInsecure is explicitly set, so it cannot happen by accident.
	CertFile      string
	KeyFile       string
	ClientCAFile  string // set to require mTLS
	AllowInsecure bool

	MaxRecvMsgSize       int           // default 8 MiB
	MaxSendMsgSize       int           // default 8 MiB
	MaxConcurrentStreams uint32        // default 1000
	ConnectionTimeout    time.Duration // handshake bound, default 20s

	// Connection lifecycle. MaxConnectionAge forces clients to periodically
	// re-resolve, which is what keeps load balanced as backends scale.
	MaxConnectionIdle     time.Duration
	MaxConnectionAge      time.Duration
	MaxConnectionAgeGrace time.Duration

	ShutdownTimeout time.Duration
}

func (c *Config) setDefaults() {
	if c.Addr == "" {
		c.Addr = ":50051"
	}
	if c.MaxRecvMsgSize == 0 {
		c.MaxRecvMsgSize = 8 << 20
	}
	if c.MaxSendMsgSize == 0 {
		// grpc-go's default here is UNLIMITED. Always set it.
		c.MaxSendMsgSize = 8 << 20
	}
	if c.MaxConcurrentStreams == 0 {
		// grpc-go's default is effectively unlimited, which means one client
		// can spawn unbounded goroutines. Pick a load-tested number.
		c.MaxConcurrentStreams = 1000
	}
	if c.ConnectionTimeout == 0 {
		c.ConnectionTimeout = 20 * time.Second
	}
	if c.MaxConnectionIdle == 0 {
		c.MaxConnectionIdle = 15 * time.Minute
	}
	if c.MaxConnectionAge == 0 {
		c.MaxConnectionAge = 30 * time.Minute
	}
	if c.MaxConnectionAgeGrace == 0 {
		c.MaxConnectionAgeGrace = 30 * time.Second
	}
	if c.ShutdownTimeout == 0 {
		c.ShutdownTimeout = 25 * time.Second
	}
}

func (c *Config) validate() error {
	if c.CertFile == "" && !c.AllowInsecure {
		return errors.New("no TLS certificate configured and AllowInsecure is false")
	}
	if (c.CertFile == "") != (c.KeyFile == "") {
		return errors.New("CertFile and KeyFile must both be set or both empty")
	}
	for _, p := range []string{c.CertFile, c.KeyFile, c.ClientCAFile} {
		if p == "" {
			continue
		}
		if _, err := os.Stat(p); err != nil {
			return fmt.Errorf("unreadable TLS file %q: %w", p, err)
		}
	}
	return nil
}

// Registrar is implemented by anything that can install itself on a gRPC
// server. Keeping registration behind this interface means Server does not
// import any service package, so the dependency arrow points one way only.
type Registrar interface {
	Register(grpc.ServiceRegistrar)
}

type Server struct {
	cfg    Config
	log    *slog.Logger
	grpc   *grpc.Server
	health *health.Server
	lis    net.Listener
}

// New builds a fully-configured gRPC server and registers everything. It does
// not listen or serve — Run does that — so tests can construct a Server and
// drive it over a bufconn listener instead.
func New(
	cfg Config,
	log *slog.Logger,
	unary []grpc.UnaryServerInterceptor,
	stream []grpc.StreamServerInterceptor,
	services ...Registrar,
) (*Server, error) {
	cfg.setDefaults()
	if err := cfg.validate(); err != nil {
		return nil, fmt.Errorf("server config: %w", err)
	}

	creds, err := buildCredentials(cfg)
	if err != nil {
		return nil, err
	}

	opts := []grpc.ServerOption{
		grpc.Creds(creds),

		// --- Resource limits: DoS defences, not tuning knobs --------------
		grpc.MaxRecvMsgSize(cfg.MaxRecvMsgSize),
		grpc.MaxSendMsgSize(cfg.MaxSendMsgSize),
		grpc.MaxConcurrentStreams(cfg.MaxConcurrentStreams),
		grpc.ConnectionTimeout(cfg.ConnectionTimeout),

		// --- Connection lifecycle ------------------------------------------
		grpc.KeepaliveParams(keepalive.ServerParameters{
			MaxConnectionIdle:     cfg.MaxConnectionIdle,
			MaxConnectionAge:      cfg.MaxConnectionAge,
			MaxConnectionAgeGrace: cfg.MaxConnectionAgeGrace,
			Time:                  30 * time.Second,
			Timeout:               10 * time.Second,
		}),
		// Without this, a client pinging more often than the default minimum
		// gets GOAWAY "too_many_pings", surfacing as intermittent Unavailable.
		grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{
			MinTime:             10 * time.Second,
			PermitWithoutStream: true,
		}),

		// --- Middleware -----------------------------------------------------
		// ALWAYS the Chain variants: grpc.UnaryInterceptor is singular and a
		// second call silently replaces the first.
		grpc.ChainUnaryInterceptor(unary...),
		grpc.ChainStreamInterceptor(stream...),
	}

	s := &Server{
		cfg:    cfg,
		log:    log,
		grpc:   grpc.NewServer(opts...),
		health: health.NewServer(),
	}

	// --- Registration. ALL of it must happen before Serve. -----------------
	for _, svc := range services {
		svc.Register(s.grpc)
	}

	// Health starts NOT_SERVING: a readiness probe must fail until we have
	// verified dependencies (see MarkReady).
	healthpb.RegisterHealthServer(s.grpc, s.health)
	s.health.SetServingStatus("", healthpb.HealthCheckResponse_NOT_SERVING)

	// Reflection lets grpcurl introspect the service. Gate it in production:
	// it discloses your full schema.
	if cfg.AllowInsecure || os.Getenv("GRPC_ENABLE_REFLECTION") == "1" {
		reflection.Register(s.grpc)
	}

	return s, nil
}

func buildCredentials(cfg Config) (credentials.TransportCredentials, error) {
	if cfg.CertFile == "" {
		// Spelled "insecure" deliberately. Reachable only when the operator
		// set AllowInsecure, which validate() enforces.
		return insecure.NewCredentials(), nil
	}

	cert, err := tls.LoadX509KeyPair(cfg.CertFile, cfg.KeyFile)
	if err != nil {
		return nil, fmt.Errorf("load key pair: %w", err)
	}

	tlsCfg := &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS13,
		NextProtos:   []string{"h2"}, // ALPN must advertise HTTP/2
	}

	// mTLS: require and verify a client certificate.
	if cfg.ClientCAFile != "" {
		pem, err := os.ReadFile(cfg.ClientCAFile)
		if err != nil {
			return nil, fmt.Errorf("read client CA: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, errors.New("client CA file contained no valid certificates")
		}
		tlsCfg.ClientCAs = pool
		tlsCfg.ClientAuth = tls.RequireAndVerifyClientCert
	}

	return credentials.NewTLS(tlsCfg), nil
}

// MarkReady flips the health status to SERVING. Call it only once dependencies
// have been verified — this is what makes a Kubernetes readiness probe mean
// something.
func (s *Server) MarkReady() {
	s.health.SetServingStatus("", healthpb.HealthCheckResponse_SERVING)
	s.log.Info("health status set to SERVING")
}

// Run listens and serves until ctx is cancelled, then shuts down gracefully.
func (s *Server) Run(ctx context.Context) error {
	lis, err := net.Listen("tcp", s.cfg.Addr)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", s.cfg.Addr, err)
	}
	s.lis = lis
	s.log.Info("gRPC server listening", "addr", lis.Addr().String())

	errCh := make(chan error, 1)
	go func() {
		// Serve blocks. It returns nil after GracefulStop, so a non-nil error
		// here is a genuine failure.
		if err := s.grpc.Serve(lis); err != nil {
			errCh <- fmt.Errorf("serve: %w", err)
			return
		}
		errCh <- nil
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		return s.shutdown()
	}
}

// shutdown drains in-flight RPCs, then forces termination if they overrun.
// Chapter 18 covers the sequencing in detail.
func (s *Server) shutdown() error {
	s.log.Info("shutdown initiated")

	// Fail readiness first so load balancers stop sending new traffic while
	// existing calls drain.
	s.health.SetServingStatus("", healthpb.HealthCheckResponse_NOT_SERVING)
	s.health.Shutdown()

	done := make(chan struct{})
	go func() {
		s.grpc.GracefulStop() // GOAWAY, then wait for in-flight RPCs
		close(done)
	}()

	select {
	case <-done:
		s.log.Info("graceful shutdown complete")
		return nil
	case <-time.After(s.cfg.ShutdownTimeout):
		s.log.Warn("graceful shutdown timed out; forcing stop",
			"timeout", s.cfg.ShutdownTimeout)
		s.grpc.Stop() // kill remaining connections
		<-done
		return nil
	}
}

// Addr reports the bound address, useful when Addr was ":0" in a test.
func (s *Server) Addr() string {
	if s.lis == nil {
		return s.cfg.Addr
	}
	return s.lis.Addr().String()
}
```

### `internal/inventory/service.go` — the service, and its `Register`

```go
package inventory

import (
	"google.golang.org/grpc"

	inventoryv1 "github.com/acme/apis/gen/go/acme/inventory/v1"
)

// Service implements inventoryv1.InventoryServiceServer.
//
// It takes a Store INTERFACE, not a *sql.DB, so tests substitute an in-memory
// implementation without a database.
type Service struct {
	inventoryv1.UnimplementedInventoryServiceServer

	store Store
	clock func() time.Time // injected so time-dependent behaviour is testable
}

var _ inventoryv1.InventoryServiceServer = (*Service)(nil)

func New(store Store, opts ...Option) *Service {
	s := &Service{store: store, clock: time.Now}
	for _, o := range opts {
		o(s)
	}
	return s
}

// Register satisfies server.Registrar, keeping the server package free of any
// dependency on this one.
func (s *Service) Register(r grpc.ServiceRegistrar) {
	inventoryv1.RegisterInventoryServiceServer(r, s)
}
```

### `cmd/inventoryd/main.go` — assembly only

```go
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"google.golang.org/grpc"

	"github.com/acme/inventory/internal/inventory"
	"github.com/acme/inventory/internal/platform/interceptors"
	"github.com/acme/inventory/internal/server"
	"github.com/acme/inventory/internal/store"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	if err := run(log); err != nil {
		log.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	// Cancelled on SIGINT/SIGTERM; Server.Run turns that into a graceful stop.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	cfg := server.Config{
		Addr:          envOr("GRPC_ADDR", ":50051"),
		CertFile:      os.Getenv("TLS_CERT_FILE"),
		KeyFile:       os.Getenv("TLS_KEY_FILE"),
		ClientCAFile:  os.Getenv("TLS_CLIENT_CA_FILE"),
		AllowInsecure: os.Getenv("ALLOW_INSECURE") == "1",
	}

	// Dependencies are opened BEFORE the server starts serving, with their own
	// timeout, so we never accept traffic against an unreachable database.
	dbCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	db, err := store.OpenPostgres(dbCtx, os.Getenv("DATABASE_URL"))
	if err != nil {
		return err
	}
	defer db.Close()

	svc := inventory.New(db)

	// Outside-in: the FIRST interceptor is outermost. Recovery must be first
	// so it catches panics from everything after it; see chapter 23.
	unary := []grpc.UnaryServerInterceptor{
		interceptors.Recovery(log),
		interceptors.Logging(log),
		interceptors.Metrics(),
		interceptors.Auth(),
		interceptors.Validate(),
	}
	stream := []grpc.StreamServerInterceptor{
		interceptors.RecoveryStream(log),
		interceptors.LoggingStream(log),
		interceptors.MetricsStream(),
		interceptors.AuthStream(),
	}

	srv, err := server.New(cfg, log, unary, stream, svc)
	if err != nil {
		return err
	}

	// Verify dependencies, then declare readiness. Until this point the
	// readiness probe fails and no traffic is routed here.
	if err := db.Ping(dbCtx); err != nil {
		return err
	}
	srv.MarkReady()

	return srv.Run(ctx)
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
```

### Serving gRPC and HTTP on one port

Sometimes you need a single port — a Kubernetes service with one container port, or a gateway alongside the gRPC service. `h2c` plus content-type routing does it:

```go
import (
	"net/http"
	"strings"

	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"
)

// mixedHandler routes gRPC traffic to the gRPC server and everything else to
// an ordinary http.Handler, on one port.
//
// The discriminator is the HTTP/2 + application/grpc content type, exactly as
// the gRPC protocol specifies.
func mixedHandler(grpcSrv *grpc.Server, httpMux http.Handler) http.Handler {
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ProtoMajor == 2 && strings.HasPrefix(r.Header.Get("Content-Type"), "application/grpc") {
			grpcSrv.ServeHTTP(w, r)
			return
		}
		httpMux.ServeHTTP(w, r)
	})

	// h2c allows cleartext HTTP/2, needed when TLS is terminated by a sidecar
	// or ingress rather than by this process.
	return h2c.NewHandler(h, &http2.Server{})
}
```

Note that `grpc.Server.ServeHTTP` is documented as lower-performance than `Serve` on a raw listener, so prefer two ports when you can.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages of grpc-go's server model**
- **Everything is a `ServerOption`**, so configuration is compile-checked and discoverable via the package docs.
- **`grpc.ServiceRegistrar`** as the registration interface makes the whole stack testable with bufconn.
- **Goroutine per stream** maps naturally onto Go's concurrency model — handlers are ordinary blocking code.
- **`GracefulStop`** is a protocol feature (`GOAWAY`), not a hack, so drains are correct.
- **Multiple services on one server** cost nothing: different `:path` prefixes, one dispatch map.

**Disadvantages**
- **Dangerous defaults.** Unlimited send size, effectively unlimited concurrent streams, no keepalive enforcement.
- **`grpc.UnaryInterceptor` is a footgun** that compiles and silently discards earlier interceptors.
- **No built-in configuration story** — you build `Config`, validation and defaults yourself.
- **Registration must precede `Serve`**, enforced by a runtime panic rather than the type system.
- **`ServeHTTP` mode is slower** than a dedicated listener, so the single-port convenience has a real cost.

**Trade-offs**
- *One port vs two:* one port simplifies Kubernetes manifests and firewalls; two ports keep gRPC on the fast path and let you bind metrics to a private interface.
- *Reflection on vs off in production:* on, it makes any engineer productive with `grpcurl`; off, it withholds your full schema from anyone who can reach the port. Gate it behind auth or an environment flag rather than choosing globally.
- *Interceptors vs handler code:* interceptors give uniformity and are hard to forget; per-handler code is explicit and easier to trace. Cross-cutting concerns belong in interceptors, business rules do not.

## 7. Common Mistakes & Best Practices

- **Using `grpc.UnaryInterceptor` twice.** The second silently replaces the first. Always `ChainUnaryInterceptor`.
- **Registering a service after `Serve`.** Runtime panic. All registration first.
- **Leaving `MaxSendMsgSize` unset.** It is unlimited by default, unlike the receive side.
- **Leaving `MaxConcurrentStreams` unset.** One client can spawn unbounded goroutines.
- **No `KeepaliveEnforcementPolicy`.** Clients that ping aggressively get `GOAWAY: too_many_pings`, surfacing as intermittent `Unavailable`.
- **`insecure.NewCredentials()` reachable by default.** Require an explicit opt-in flag so it cannot happen accidentally.
- **Serving before dependencies are verified.** Start health as `NOT_SERVING` and flip it after a real check.
- **Business logic in `main.go`.** Assembly only; everything else in `internal/` where it is testable.
- **Ignoring `Serve`'s error.** It returns `nil` after `GracefulStop`, so a non-nil return is a genuine failure worth logging and exiting on.
- **Reflection unconditionally enabled in production.** It publishes your entire schema to anyone who can reach the port.
- **Not calling `MarkReady` after dependency checks**, so a readiness probe passes while the database is unreachable.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** `GRPC_GO_LOG_SEVERITY_LEVEL=info GRPC_GO_LOG_VERBOSITY_LEVEL=99` prints every frame and connection event — the fastest route to diagnosing handshake and keepalive problems. Register channelz (`channelz/service`) to inspect live sockets and streams over gRPC itself.
- **Monitoring.** At this layer: connection count, active streams, accept errors, and TLS handshake failures. A rising connection count with flat QPS means churn — usually a keepalive or `MaxConnectionAge` interaction. Per-method metrics belong in an interceptor (chapter 26).
- **Security.** TLS 1.3 minimum, ALPN advertising `h2`, mTLS between services in a zero-trust network. Message-size and concurrency limits are DoS controls, not tuning. Keep `golang.org/x/net` and grpc-go current for HTTP/2 attack mitigations (chapter 2). Gate reflection.
- **Scaling.** `MaxConnectionAge` plus grace is the single most important scaling option: without it, clients never re-resolve, and pods added by an autoscaler receive no traffic. Set it to something like 30 minutes with a 30-second grace, and verify by scaling up under load and watching per-pod QPS converge.

## 9. Interview Questions

**Q: What are the minimum steps to start a gRPC server in Go?**
A: Open a listener with `net.Listen`, construct the server with `grpc.NewServer`, register your implementation with the generated `RegisterXxxServer`, and call `Serve(lis)`, which blocks. All registration must happen before `Serve` — registering afterwards panics. That is the minimum; production adds credentials, message-size and concurrency limits, keepalive parameters, interceptor chains, a health service and a shutdown path.

**Q: Which `ServerOption`s would you always set, and why?**
A: `grpc.Creds` for TLS, because insecure is only for localhost. `MaxRecvMsgSize` and `MaxSendMsgSize` explicitly — the send side is *unlimited* by default, which surprises people. `MaxConcurrentStreams`, because grpc-go's default is effectively unlimited and there is one goroutine per in-flight RPC. `ChainUnaryInterceptor` and `ChainStreamInterceptor` for recovery, logging, metrics and auth. `KeepaliveParams` including `MaxConnectionAge`, so clients periodically re-resolve and load rebalances as backends scale. And `KeepaliveEnforcementPolicy`, or clients pinging aggressively get `GOAWAY: too_many_pings`.

**Q: What is the difference between `UnaryInterceptor` and `ChainUnaryInterceptor`?**
A: `grpc.UnaryInterceptor` accepts exactly one interceptor and silently replaces any previously set one, so passing it twice compiles, runs, and quietly discards the first — a genuine footgun. `ChainUnaryInterceptor` accepts a variadic list and composes them. Ordering is outside-in: the first in the list is outermost, sees the request first and the response last, which is why recovery goes first and validation goes last.

**Q: What does `RegisterXxxServer` actually do?**
A: It takes the generated `ServiceDesc` — service name, handler type, and tables of unary and streaming methods each pointing at a generated wrapper — and installs it into the server's dispatch map. At request time the server reads the `:path`, looks up the service and method there, and calls the wrapper, which runs the interceptor chain, unmarshals the request and invokes your handler. It takes a `grpc.ServiceRegistrar` interface rather than `*grpc.Server`, which is what lets test harnesses substitute.

**Q: How does gRPC handle concurrency on the server?**
A: One goroutine per connection for the transport, and then one goroutine per in-flight stream — that is, per RPC. Handlers are therefore ordinary blocking Go code and may block freely without affecting other calls. The consequence is that concurrency limits are memory limits: with no `MaxConcurrentStreams`, a single client can open unbounded streams and spawn unbounded goroutines, which is why setting it is a DoS defence rather than tuning.

**Q: Why start the health service as `NOT_SERVING`?**
A: Because a readiness probe should fail until the process can actually serve traffic. If health reports `SERVING` from the moment the server starts, Kubernetes routes traffic before the database connection is verified, and the first requests fail. Starting `NOT_SERVING`, verifying dependencies, then flipping to `SERVING` makes the probe meaningful. On shutdown you reverse it: set `NOT_SERVING` first so load balancers stop sending new work, then drain.

**Q: How do you serve gRPC and plain HTTP on one port?**
A: Wrap a handler that inspects each request: if `r.ProtoMajor == 2` and the `Content-Type` starts with `application/grpc`, delegate to `grpcServer.ServeHTTP`, otherwise to your HTTP mux — then wrap the whole thing in `h2c.NewHandler` so cleartext HTTP/2 works when TLS is terminated upstream. It is genuinely useful for single-port Kubernetes services, but `grpc.Server.ServeHTTP` is documented as lower-performance than serving a raw listener, so I use two ports when the deployment allows it.

**Q: (Senior) Design the startup sequence for a production gRPC service.**
A: Validate configuration first, so a missing certificate path fails immediately rather than on the first handshake. Build logging and metrics next, so every subsequent failure is visible. Open dependencies — database pools, caches, downstream clients — with their own bounded timeout, because a server that accepts traffic before its database is reachable simply serves errors. Construct the service implementation with those dependencies injected. Build the `ServerOption`s: credentials, limits, keepalive, interceptor chains, stats handlers. Construct the server and register everything — your services, health, and conditionally reflection — all before `Serve`. Register health as `NOT_SERVING`, then verify dependencies with a real check and flip to `SERVING`. Finally listen, serve in a goroutine, and block on a signal context that triggers the shutdown sequence. The two details that matter most are the ordering of the health flip relative to dependency verification, and that `main.go` only assembles — every piece of logic lives behind an interface so the whole stack is constructible in a test.

**Q: (Senior) A client reports intermittent `Unavailable` from a healthy server. Where do you look?**
A: My first hypothesis is a keepalive mismatch, because it is the most common cause of exactly this symptom. If the client's keepalive `Time` is shorter than the server's `KeepaliveEnforcementPolicy.MinTime`, or the client pings on idle connections while the server has `PermitWithoutStream: false`, the server sends `GOAWAY` with debug data `too_many_pings` and the client surfaces it as `Unavailable` on otherwise healthy traffic. I would confirm with `GRPC_GO_LOG_VERBOSITY_LEVEL=99` on both sides and look for that debug string. The second candidate is `MaxConnectionAge` without a sufficient `MaxConnectionAgeGrace`, which terminates in-flight RPCs at rotation rather than draining them. Third is a load balancer or proxy idle timeout shorter than the keepalive interval, silently dropping connections the client believes are alive. Fourth, `MaxConcurrentStreams` being hit, which queues rather than errors but can look like unavailability under a client-side deadline. The general lesson is that keepalive is a negotiation between both sides and must be configured as a pair.

**Q: (Senior) How do you make a gRPC server testable?**
A: By keeping `main.go` to assembly and pushing everything behind interfaces. The service takes a `Store` interface rather than a `*sql.DB`, and a clock function rather than calling `time.Now` directly, so both are substitutable. Registration goes through a small `Registrar` interface so the server package does not import any service package, keeping the dependency arrow one-way. The server constructor builds and registers but does not listen, so a test can drive it over a `bufconn` listener with no ports and no network — which makes tests fast, parallelisable and free of flakiness from port collisions. Interceptors are passed in as slices rather than constructed internally, so a test can run with none or with a spy. The result is that the exact same wiring runs in tests and in production, which is the property that actually catches integration bugs — chapter 27 builds on this directly.

## 10. Quick Revision & Cheat Sheet

```go
lis, err := net.Listen("tcp", ":50051")

s := grpc.NewServer(
    grpc.Creds(credentials.NewTLS(tlsCfg)),
    grpc.MaxRecvMsgSize(8<<20),
    grpc.MaxSendMsgSize(8<<20),          // default is UNLIMITED
    grpc.MaxConcurrentStreams(1000),     // default is ~unlimited
    grpc.ConnectionTimeout(20*time.Second),
    grpc.KeepaliveParams(keepalive.ServerParameters{
        MaxConnectionAge:      30 * time.Minute,
        MaxConnectionAgeGrace: 30 * time.Second,
        Time: 30 * time.Second, Timeout: 10 * time.Second,
    }),
    grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{
        MinTime: 10 * time.Second, PermitWithoutStream: true,
    }),
    grpc.ChainUnaryInterceptor(recovery, logging, metrics, auth, validate),
    grpc.ChainStreamInterceptor(recoveryStream, loggingStream),
)

pb.RegisterInventoryServiceServer(s, svc)   // ALL registration
healthpb.RegisterHealthServer(s, healthSrv) // before Serve
reflection.Register(s)                      // gate in production

err = s.Serve(lis)   // blocks; returns nil after GracefulStop
```

| Concern | Option |
|---|---|
| TLS / mTLS | `grpc.Creds(credentials.NewTLS(...))` |
| Message limits | `MaxRecvMsgSize`, `MaxSendMsgSize` |
| Concurrency | `MaxConcurrentStreams` |
| Handshake bound | `ConnectionTimeout` |
| Liveness + rebalancing | `KeepaliveParams` (`MaxConnectionAge`!) |
| Ping abuse | `KeepaliveEnforcementPolicy` |
| Middleware | `ChainUnaryInterceptor`, `ChainStreamInterceptor` |
| Tracing/metrics | `StatsHandler` |

**Flash cards**
- **Four minimum steps?** → Listen, NewServer, Register, Serve.
- **Registration after `Serve`?** → Panic. Always register first.
- **`MaxSendMsgSize` default?** → Unlimited. Set it.
- **`MaxConcurrentStreams` default in grpc-go?** → Effectively unlimited. Set it.
- **`UnaryInterceptor` twice?** → The second silently replaces the first. Use `Chain…`.
- **Health at startup?** → `NOT_SERVING` until dependencies verify.
- **Option that fixes load balancing?** → `MaxConnectionAge` + grace.

## 11. Hands-On Exercises & Mini Project

- [ ] Build the four-line server, then add each `ServerOption` from §5 one at a time, confirming what each changes with `GRPC_GO_LOG_VERBOSITY_LEVEL=99`.
- [ ] Call `grpc.UnaryInterceptor` twice with two logging interceptors and observe that only one fires. Switch to `ChainUnaryInterceptor` and see both.
- [ ] Register a service after `Serve` has started and read the panic.
- [ ] Set `MaxRecvMsgSize` to 1 KiB and send a 2 KiB request. Note the exact status code and message on both sides.
- [ ] Set the client's keepalive `Time` to 5 s and the server's `MinTime` to 30 s. Reproduce `too_many_pings`, then fix it.
- [ ] Set `MaxConnectionAge: 10s`, run three server replicas behind a client using `round_robin`, and watch per-pod request distribution converge after each rotation.
- [ ] Wire the mixed `h2c` handler and serve gRPC plus a `/metrics` endpoint on one port.

### Mini Project — "Production Server Skeleton"

**Goal.** Build the server scaffolding you would actually deploy, and prove each safeguard works.

**Requirements.**
1. The layered structure from §3: `cmd/` assembles, `internal/server` owns the lifecycle, `internal/<domain>` implements the service against a `Store` interface.
2. A `Config` struct with defaults and validation, driven by environment variables, that fails at startup on a missing or unreadable TLS file.
3. TLS with `MinVersion: TLS13`, optional mTLS with client-certificate verification, and insecure mode reachable only behind an explicit `AllowInsecure` flag.
4. All ten `ServerOption`s from §3, with the values chosen from a load test rather than guessed, and a comment recording why each number was picked.
5. Health starting `NOT_SERVING`, a real dependency check, `MarkReady`, and the reverse ordering on shutdown.
6. Reflection registered only when an environment flag is set, with a test asserting it is absent by default.
7. Tests that construct the whole server over a bufconn listener and exercise: a successful call, an oversized message, a concurrency limit, and a graceful shutdown with an in-flight RPC.

**Extensions.**
- Add the mixed `h2c` handler and benchmark `ServeHTTP` against a dedicated listener at 10k QPS to quantify the single-port cost.
- Add channelz and write a small CLI that reports live connections and active streams.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Unary Handlers* (what registration dispatches to), *Graceful Shutdown, Signals, Keepalive & Server Limits* (the lifecycle in depth), *Interceptors* (the chains configured here), *Reflection, grpcurl & Health Checks* (the services registered here), *Testing gRPC in Go* (bufconn against this exact wiring).

- **grpc-go — Server and ServerOption documentation** — gRPC Authors · *Intermediate* · every option with its default; the authoritative reference for §3's table. <https://pkg.go.dev/google.golang.org/grpc#ServerOption>
- **gRPC — Go Basics tutorial** — grpc.io · *Beginner* · the canonical minimal server and client, end to end. <https://grpc.io/docs/languages/go/basics/>
- **grpc-go examples — features/** — gRPC Authors · *Intermediate* · runnable examples for authentication, interceptors, keepalive, health, reflection and graceful shutdown, each isolated. <https://github.com/grpc/grpc-go/tree/master/examples/features>
- **grpc-go — keepalive package** — gRPC Authors · *Intermediate* · `ServerParameters`, `EnforcementPolicy`, and the client/server interaction rules that cause `too_many_pings`. <https://pkg.go.dev/google.golang.org/grpc/keepalive>
- **gRPC — Authentication guide** — grpc.io · *Intermediate* · TLS, mTLS and per-RPC credentials, with the Go configuration shown here. <https://grpc.io/docs/guides/auth/>
- **gRPC — Health Checking Protocol** — gRPC Authors · *Intermediate* · the standard health service registered in §5 and how probes should use it. <https://github.com/grpc/grpc/blob/master/doc/health-checking.md>
- **golang.org/x/net/http2/h2c** — The Go Authors · *Advanced* · cleartext HTTP/2 for the single-port pattern, with its caveats. <https://pkg.go.dev/golang.org/x/net/http2/h2c>
- **Effective Go & the standard library `net` package** — The Go Authors · *Beginner* · `net.Listen`, listener semantics and the `:0` trick for tests. <https://pkg.go.dev/net#Listen>

---

*gRPC with Go Handbook — chapter 14.*
