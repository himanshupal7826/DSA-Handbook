# 25 · Reflection, grpcurl & the gRPC Health Checking Protocol

> **In one line:** Reflection makes a gRPC server self-describing so `grpcurl` can call it without a `.proto` — which is transformative in development and a schema-disclosure surface in production — while the health protocol is the small standard service that makes Kubernetes probes actually mean something.

---

## 1. Overview

Two small standard services solve two large operational problems.

**Server reflection** (`grpc.reflection.v1.ServerReflection`) lets a client ask the server "what services do you expose, and what do their messages look like?" The server answers with file descriptors, so tooling can construct requests dynamically. Without it, calling a service by hand requires the `.proto` files, the right import paths and a working `protoc` — with it, `grpcurl -plaintext localhost:50051 list` works from any machine. This is the single biggest quality-of-life improvement available to a gRPC team, and it is three lines of code.

The trade is real: reflection publishes your entire schema — every service, method, message and field, including internal ones — to anyone who can reach the port. On an internal service that is fine and useful. On an internet-facing one it is reconnaissance handed over for free. The answer is not "never enable it" but "gate it", and to publish a descriptor set as a release artefact so tooling still works where reflection is off (chapter 12).

**The health checking protocol** (`grpc.health.v1.Health`) is a two-method service: `Check` for a point-in-time answer, `Watch` for a stream of status changes. It matters because it gives load balancers and orchestrators a *gRPC-native* readiness signal. Without it, Kubernetes probes either use an HTTP sidecar endpoint that may not reflect gRPC health, or a TCP check that only proves a socket is open. With it, `readinessProbe.grpc` is a first-class Kubernetes feature (1.24+), and the server controls exactly when it is willing to receive traffic.

The pattern that ties them together, from chapter 18: start `NOT_SERVING`, verify dependencies, flip to `SERVING`, and reverse the order on shutdown.

## 2. Core Concepts

- **Server reflection** — `google.golang.org/grpc/reflection`; `reflection.Register(s)` exposes the schema.
- **`v1alpha` vs `v1`** — the reflection service has both; grpc-go registers both by default for compatibility with older tooling.
- **`grpcurl`** — the curl of gRPC. Uses reflection, a `.proto`, or a descriptor set (`-protoset`).
- **Descriptor set** — a compiled, self-contained schema file; the alternative to reflection for tooling.
- **`grpc.health.v1.Health`** — the standard health service, with `Check` (unary) and `Watch` (server streaming).
- **`healthpb.HealthCheckResponse_SERVING` / `NOT_SERVING` / `SERVICE_UNKNOWN`** — the three statuses.
- **Per-service health** — the empty string `""` means the whole server; a fully-qualified service name scopes it.
- **`health.Server.Shutdown()`** — marks everything `NOT_SERVING` and makes subsequent `Watch` responses reflect it.
- **`grpc_health_probe`** — the standalone binary used before Kubernetes had native gRPC probes.
- **Native gRPC probes** — `readinessProbe.grpc.port`, GA in Kubernetes 1.27.
- **channelz** — `grpc.io`'s live introspection service for channels, sockets and streams.

## 3. Theory & Principles

### What reflection actually exposes

The reflection service answers four kinds of request: list all services, look up a file by name, look up the file containing a symbol, and look up an extension. The response is a serialised `FileDescriptorProto` — the same structure `protoc` produces (chapter 12).

That means reflection exposes **everything in your `.proto` files that was compiled into the binary**: every service, every method, every message, every field name and number, every enum value, and — if built with `--include_source_info` — every comment. It does not expose data, and it does not bypass authentication: a reflection-discovered method still requires credentials.

So the risk is reconnaissance, not compromise. An attacker who can reach the port learns your entire API surface, including internal-only services registered on the same server and methods that are not yet documented. Whether that matters depends on where the port is reachable from.

The sensible policy:

| Environment | Reflection |
|---|---|
| Local development | On |
| CI / integration tests | On |
| Internal staging | On |
| Internal production (mesh-only) | On, or gated behind an env flag |
| Internet-facing or regulated | Off; publish a descriptor set instead |

Gating behind an environment variable, as in chapter 14, gives you both: developers get it everywhere it is safe, and production is explicit.

### The health protocol, precisely

```protobuf
service Health {
  rpc Check(HealthCheckRequest) returns (HealthCheckResponse);
  rpc Watch(HealthCheckRequest) returns (stream HealthCheckResponse);
}

message HealthCheckRequest { string service = 1; }
message HealthCheckResponse {
  enum ServingStatus { UNKNOWN = 0; SERVING = 1; NOT_SERVING = 2; SERVICE_UNKNOWN = 3; }
  ServingStatus status = 1;
}
```

Three details matter:

1. **The empty service name `""` means the whole server.** A fully-qualified name like `acme.inventory.v1.InventoryService` scopes the check to one service, which lets a server report that it can serve reads but not writes.
2. **`Check` on an unknown service returns `NotFound`**, not `SERVICE_UNKNOWN` in the body — the status code is the signal. `SERVICE_UNKNOWN` appears in `Watch` responses.
3. **`Watch` streams changes**, so a load balancer can react immediately rather than polling. It is also subject to every streaming concern from chapter 16 — notably that it holds a connection.

### Readiness versus liveness, and why they differ

This is the distinction that causes production incidents when confused:

- **Readiness** answers "should traffic be routed here right now?" Failing it removes the pod from the load balancer, which is cheap and reversible. It should **fail fast** — one or two checks — so a draining or dependency-blocked pod stops receiving work quickly.
- **Liveness** answers "is this process irrecoverably broken?" Failing it **restarts the process**, killing every in-flight request. It should **fail slow** — five or more checks — because a pod that is slow under load will be killed, its traffic will move to the remaining pods, and they will die too. That is a self-inflicted cascading failure.

The corollary: **readiness should check dependencies; liveness should not.** If a shared database becomes slow, readiness failing everywhere is correct — nothing can serve. Liveness failing everywhere restarts your entire fleet simultaneously, which helps nobody and loses all in-flight work.

```svg
<svg viewBox="0 0 880 490" width="100%" height="490" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="hl1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#0ea5e9"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Readiness fails fast. Liveness fails slow. Confusing them cascades.</text>

  <rect x="24" y="42" width="410" height="200" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="229" y="64" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Readiness &#8212; failureThreshold: 2</text>
  <text x="42" y="88" fill="#166534">Question: "should traffic be routed here RIGHT NOW?"</text>
  <text x="42" y="110" fill="#15803d" font-weight="bold">Consequence of failing: removed from the load balancer.</text>
  <text x="42" y="126" fill="#166534">Cheap. Reversible. Nothing is lost.</text>
  <text x="42" y="150" fill="#15803d" font-weight="bold">SHOULD check dependencies:</text>
  <text x="42" y="166" fill="#166534">if the database is unreachable, this pod genuinely</text>
  <text x="42" y="182" fill="#166534">cannot serve, and traffic should go elsewhere.</text>
  <text x="42" y="206" fill="#166534">Also what makes a graceful drain work: fail readiness</text>
  <text x="42" y="222" fill="#166534">FIRST, then wait for propagation (chapter 18).</text>

  <rect x="446" y="42" width="410" height="200" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="651" y="64" text-anchor="middle" fill="#92400e" font-size="12" font-weight="bold">Liveness &#8212; failureThreshold: 5+</text>
  <text x="464" y="88" fill="#b45309">Question: "is this process irrecoverably broken?"</text>
  <text x="464" y="110" fill="#92400e" font-weight="bold">Consequence of failing: the process is RESTARTED.</text>
  <text x="464" y="126" fill="#b45309">Every in-flight request dies. Expensive.</text>
  <text x="464" y="150" fill="#b91c1c" font-weight="bold">MUST NOT check dependencies:</text>
  <text x="464" y="166" fill="#991b1b">a slow shared database would restart the entire fleet</text>
  <text x="464" y="182" fill="#991b1b">simultaneously &#8212; a self-inflicted cascading failure.</text>
  <text x="464" y="206" fill="#b45309">Check only "is this process itself wedged?" &#8212; deadlock,</text>
  <text x="464" y="222" fill="#b45309">exhausted goroutines, an unrecoverable internal state.</text>

  <rect x="24" y="260" width="832" height="106" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="440" y="282" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">The cascade, when liveness checks a dependency</text>
  <rect x="48" y="298" width="150" height="46" rx="6" fill="#fff" stroke="#fca5a5"/>
  <text x="123" y="318" text-anchor="middle" fill="#7f1d1d" font-size="10">shared DB slows</text>
  <text x="123" y="334" text-anchor="middle" fill="#991b1b" font-size="9">every pod's probe fails</text>
  <path d="M200,321 L232,321" stroke="#dc2626" stroke-width="2" marker-end="url(#hl1)"/>
  <rect x="236" y="298" width="150" height="46" rx="6" fill="#fff" stroke="#fca5a5"/>
  <text x="311" y="318" text-anchor="middle" fill="#7f1d1d" font-size="10">all pods restart</text>
  <text x="311" y="334" text-anchor="middle" fill="#991b1b" font-size="9">in-flight work lost</text>
  <path d="M388,321 L420,321" stroke="#dc2626" stroke-width="2" marker-end="url(#hl1)"/>
  <rect x="424" y="298" width="180" height="46" rx="6" fill="#fff" stroke="#fca5a5"/>
  <text x="514" y="318" text-anchor="middle" fill="#7f1d1d" font-size="10">cold caches + reconnects</text>
  <text x="514" y="334" text-anchor="middle" fill="#991b1b" font-size="9">MORE load on the slow DB</text>
  <path d="M606,321 L638,321" stroke="#dc2626" stroke-width="2" marker-end="url(#hl1)"/>
  <rect x="642" y="298" width="190" height="46" rx="6" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="737" y="322" text-anchor="middle" fill="#b91c1c" font-size="11" font-weight="bold">restart loop</text>

  <rect x="24" y="384" width="832" height="96" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="440" y="406" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">Reflection: enormously useful, and a reconnaissance surface</text>
  <text x="48" y="430" fill="#1d4ed8">Exposes EVERY service, method, message, field and (with --include_source_info) every comment compiled into the</text>
  <text x="48" y="446" fill="#1d4ed8">binary &#8212; including internal services on the same server. It exposes no DATA and bypasses no authentication.</text>
  <text x="48" y="468" fill="#1e40af" font-weight="bold">Policy: on in dev/CI/staging/internal-mesh; off at the internet edge, with a published descriptor set for tooling.</text>
</svg>
```

## 4. Architecture & Workflow

**Health state machine over a process lifetime:**

1. **Process starts** → register health as `NOT_SERVING`. The readiness probe fails, so no traffic is routed.
2. **Dependencies verified** → `SetServingStatus("", SERVING)`. Traffic begins.
3. **A dependency degrades** → optionally set the affected per-service name to `NOT_SERVING`, so a partially-degraded server can still serve what it can.
4. **`SIGTERM`** → `SetServingStatus("", NOT_SERVING)` and `Shutdown()`, then wait for load-balancer propagation, then drain (chapter 18).

**Tooling without reflection.** Where reflection is disabled, `grpcurl` still works with either the `.proto` files (`-import-path` plus `-proto`) or a descriptor set (`-protoset`). Publishing a descriptor set built with `--include_imports --include_source_info` as a release artefact means operators keep full capability — including method documentation — with no server-side disclosure.

```svg
<svg viewBox="0 0 880 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="hs1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#0ea5e9"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Health status over a process lifetime</text>

  <rect x="30" y="46" width="170" height="66" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="115" y="68" text-anchor="middle" fill="#92400e" font-size="11" font-weight="bold">1. process starts</text>
  <text x="115" y="86" text-anchor="middle" fill="#b45309" font-size="9">NOT_SERVING</text>
  <text x="115" y="102" text-anchor="middle" fill="#b45309" font-size="9">readiness fails &#8594; no traffic</text>

  <path d="M202,79 L236,79" stroke="#0ea5e9" stroke-width="2" marker-end="url(#hs1)"/>

  <rect x="240" y="46" width="180" height="66" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="330" y="68" text-anchor="middle" fill="#1e40af" font-size="11" font-weight="bold">2. verify dependencies</text>
  <text x="330" y="86" text-anchor="middle" fill="#1d4ed8" font-size="9">DB ping, cache, downstream</text>
  <text x="330" y="102" text-anchor="middle" fill="#1d4ed8" font-size="9">with a bounded timeout</text>

  <path d="M422,79 L456,79" stroke="#0ea5e9" stroke-width="2" marker-end="url(#hs1)"/>

  <rect x="460" y="46" width="170" height="66" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="545" y="68" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">3. SERVING</text>
  <text x="545" y="86" text-anchor="middle" fill="#166534" font-size="9">SetServingStatus("", SERVING)</text>
  <text x="545" y="102" text-anchor="middle" fill="#166534" font-size="9">traffic begins</text>

  <path d="M632,79 L666,79" stroke="#0ea5e9" stroke-width="2" marker-end="url(#hs1)"/>

  <rect x="670" y="46" width="180" height="66" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="760" y="68" text-anchor="middle" fill="#5b21b6" font-size="11" font-weight="bold">4. SIGTERM</text>
  <text x="760" y="86" text-anchor="middle" fill="#6d28d9" font-size="9">NOT_SERVING + Shutdown()</text>
  <text x="760" y="102" text-anchor="middle" fill="#6d28d9" font-size="9">then wait, then drain (ch. 18)</text>

  <rect x="30" y="132" width="820" height="80" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="154" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Per-service health: partial degradation is expressible</text>
  <text x="50" y="176" fill="#475569">SetServingStatus("", SERVING) &#8212; the whole server. SetServingStatus("acme.inventory.v1.InventoryService", …) &#8212; one service.</text>
  <text x="50" y="196" fill="#475569">A server whose write path is degraded can report reads SERVING and writes NOT_SERVING, so a smart balancer routes accordingly.</text>

  <rect x="30" y="230" width="410" height="176" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="235" y="252" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">With reflection</text>
  <g font-family="ui-monospace,monospace" font-size="10" fill="#166534">
    <text x="46" y="276">grpcurl -plaintext localhost:50051 list</text>
    <text x="46" y="294">grpcurl -plaintext localhost:50051 \</text>
    <text x="46" y="310">  describe acme.inventory.v1.InventoryService</text>
    <text x="46" y="328">grpcurl -plaintext -d '{"sku":"sku_1"}' \</text>
    <text x="46" y="344">  localhost:50051 …/GetItem</text>
  </g>
  <text x="46" y="370" fill="#15803d" font-size="10" font-weight="bold">Three lines of server code. Works from any machine.</text>
  <text x="46" y="388" fill="#166534" font-size="10">The biggest quality-of-life win available to a gRPC team.</text>

  <rect x="452" y="230" width="398" height="176" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="651" y="252" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">Without reflection &#8212; same capability</text>
  <g font-family="ui-monospace,monospace" font-size="10" fill="#1d4ed8">
    <text x="468" y="276">protoc --descriptor_set_out=schema.protoset \</text>
    <text x="468" y="292">  --include_imports --include_source_info …</text>
    <text x="468" y="316">grpcurl -protoset schema.protoset \</text>
    <text x="468" y="332">  -d '{"sku":"sku_1"}' host:443 …/GetItem</text>
  </g>
  <text x="468" y="358" fill="#1e40af" font-size="10" font-weight="bold">Publish the descriptor set as a release artefact.</text>
  <text x="468" y="376" fill="#1d4ed8" font-size="10">--include_source_info keeps COMMENTS, so `describe`</text>
  <text x="468" y="392" fill="#1d4ed8" font-size="10">still shows documentation. No server-side disclosure.</text>
</svg>
```

## 5. Implementation

### Registering reflection and health

```go
package server

import (
	"context"
	"os"
	"sync"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/reflection"
)

func (s *Server) registerStandardServices() {
	// --- Health: register FIRST as NOT_SERVING -----------------------------
	// Starting NOT_SERVING is what makes a readiness probe meaningful: no
	// traffic is routed until we have verified we can actually serve.
	healthpb.RegisterHealthServer(s.grpc, s.health)
	s.health.SetServingStatus("", healthpb.HealthCheckResponse_NOT_SERVING)

	// Per-service status too, so a partially degraded server can express it.
	s.health.SetServingStatus(
		"acme.inventory.v1.InventoryService",
		healthpb.HealthCheckResponse_NOT_SERVING,
	)

	// --- Reflection: gated ------------------------------------------------
	// Enormously useful, and it publishes the entire schema to anyone who can
	// reach the port. On by default where it is safe; explicit in production.
	if s.cfg.EnableReflection {
		// Registers both v1 and v1alpha, so older tooling still works.
		reflection.Register(s.grpc)
		s.log.Info("gRPC server reflection enabled")
	}
}
```

### A dependency-aware health checker

```go
// DependencyChecker probes dependencies on an interval and updates health.
//
// Design decisions worth noting:
//   - Readiness reflects dependencies; liveness does NOT (see §3).
//   - Checks run in the BACKGROUND with their own timeouts, so a probe never
//     waits on a slow database — a probe that hangs is worse than one that
//     fails, because the orchestrator cannot distinguish it from a wedged
//     process.
type DependencyChecker struct {
	health   *health.Server
	log      *slog.Logger
	interval time.Duration

	deps []Dependency

	mu      sync.RWMutex
	lastErr map[string]error
}

type Dependency struct {
	Name     string
	Critical bool // false: degrade one service; true: fail the whole server
	Check    func(context.Context) error
	Services []string // which gRPC services this dependency affects
}

func (d *DependencyChecker) Run(ctx context.Context) {
	// One immediate check so readiness becomes accurate as fast as possible.
	d.checkAll(ctx)

	t := time.NewTicker(d.interval)
	defer t.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			d.checkAll(ctx)
		}
	}
}

func (d *DependencyChecker) checkAll(ctx context.Context) {
	degraded := map[string]bool{}
	anyCriticalDown := false

	for _, dep := range d.deps {
		// Each check gets its own bounded timeout: one slow dependency must
		// not delay the others or the overall status update.
		cctx, cancel := context.WithTimeout(ctx, 2*time.Second)
		err := dep.Check(cctx)
		cancel()

		d.mu.Lock()
		prev := d.lastErr[dep.Name]
		d.lastErr[dep.Name] = err
		d.mu.Unlock()

		// Log transitions, not every check — otherwise a broken dependency
		// produces a log line every interval, forever.
		switch {
		case err != nil && prev == nil:
			d.log.Error("dependency became unhealthy", "dep", dep.Name, "err", err)
		case err == nil && prev != nil:
			d.log.Info("dependency recovered", "dep", dep.Name)
		}

		if err != nil {
			if dep.Critical {
				anyCriticalDown = true
			}
			for _, svc := range dep.Services {
				degraded[svc] = true
			}
		}
	}

	overall := healthpb.HealthCheckResponse_SERVING
	if anyCriticalDown {
		overall = healthpb.HealthCheckResponse_NOT_SERVING
	}
	d.health.SetServingStatus("", overall)

	for _, dep := range d.deps {
		for _, svc := range dep.Services {
			st := healthpb.HealthCheckResponse_SERVING
			if degraded[svc] {
				st = healthpb.HealthCheckResponse_NOT_SERVING
			}
			d.health.SetServingStatus(svc, st)
		}
	}
}
```

### Wiring it up

```go
func run(ctx context.Context, log *slog.Logger) error {
	db, err := store.OpenPostgres(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		return err
	}
	defer db.Close()

	cache, _ := cache.Open(os.Getenv("REDIS_URL"))

	srv, err := server.New(cfg, log, unary, stream, inventory.New(db))
	if err != nil {
		return err
	}

	checker := &server.DependencyChecker{
		health:   srv.Health(),
		log:      log,
		interval: 5 * time.Second,
		deps: []server.Dependency{
			{
				Name: "postgres", Critical: true, // nothing works without it
				Check:    db.Ping,
				Services: []string{"acme.inventory.v1.InventoryService"},
			},
			{
				Name: "redis", Critical: false, // degrades performance, not correctness
				Check:    cache.Ping,
				Services: nil, // do not fail any service for a cache
			},
		},
	}
	go checker.Run(ctx)

	return srv.Run(ctx)
}
```

### Kubernetes probes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: inventory
spec:
  template:
    spec:
      terminationGracePeriodSeconds: 60
      containers:
        - name: inventory
          image: acme/inventory:v1.8.0
          ports:
            - name: grpc
              containerPort: 50051

          # Native gRPC probes: beta in 1.24, GA in 1.27. Kubelet speaks the
          # standard health protocol directly — no sidecar binary needed.
          #
          # Readiness: FAIL FAST. It only removes traffic, so reacting quickly
          # is cheap and correct.
          readinessProbe:
            grpc:
              port: 50051
              # Omit `service` to check "" (the whole server), or set it to a
              # fully-qualified name for per-service readiness.
            initialDelaySeconds: 2
            periodSeconds: 3
            timeoutSeconds: 2
            failureThreshold: 2

          # Liveness: FAIL SLOW. It RESTARTS the process, so a low threshold
          # under load produces a restart loop: slow pod is killed, its traffic
          # moves to the survivors, they slow, they are killed too.
          livenessProbe:
            grpc:
              port: 50051
            initialDelaySeconds: 15
            periodSeconds: 15
            timeoutSeconds: 5
            failureThreshold: 5

          # Startup probe: gives a slow-starting process time without loosening
          # the liveness threshold. 30 × 5s = up to 150s to become ready.
          startupProbe:
            grpc:
              port: 50051
            periodSeconds: 5
            failureThreshold: 30

          lifecycle:
            preStop:
              exec:
                command: ["/bin/sh", "-c", "sleep 10"]  # LB propagation (ch. 18)
```

For Kubernetes older than 1.24, use `grpc_health_probe`:

```yaml
          readinessProbe:
            exec:
              command: ["/bin/grpc_health_probe", "-addr=:50051", "-connect-timeout=2s"]
            periodSeconds: 3
            failureThreshold: 2
```

### `grpcurl` — the commands worth memorising

```bash
# --- with reflection --------------------------------------------------------
grpcurl -plaintext localhost:50051 list
grpcurl -plaintext localhost:50051 list acme.inventory.v1.InventoryService
grpcurl -plaintext localhost:50051 describe acme.inventory.v1.InventoryService
grpcurl -plaintext localhost:50051 describe acme.inventory.v1.Item   # message shape

grpcurl -plaintext -d '{"sku":"sku_1"}' \
  localhost:50051 acme.inventory.v1.InventoryService/GetItem

# Metadata (auth, request id) and verbose output showing headers/trailers.
grpcurl -plaintext -v \
  -H "authorization: Bearer $TOKEN" \
  -H "x-request-id: manual-1" \
  -d '{"sku":"sku_1"}' \
  localhost:50051 acme.inventory.v1.InventoryService/GetItem

# Streaming: -d @ reads newline-delimited JSON from stdin.
grpcurl -plaintext -d @ localhost:50051 \
  acme.inventory.v1.InventoryService/BulkAdjustStock <<'EOF'
{"sku":"sku_1","delta":-1,"adjustment_id":"a1","reason":"ADJUSTMENT_REASON_DAMAGE"}
{"sku":"sku_2","delta":5,"adjustment_id":"a2","reason":"ADJUSTMENT_REASON_RECEIPT"}
EOF

# --- without reflection -----------------------------------------------------
grpcurl -protoset build/schema.protoset -d '{"sku":"sku_1"}' \
  inventory.internal:443 acme.inventory.v1.InventoryService/GetItem

grpcurl -import-path ./proto -proto acme/inventory/v1/inventory.proto \
  -d '{"sku":"sku_1"}' inventory.internal:443 \
  acme.inventory.v1.InventoryService/GetItem

# --- TLS / mTLS -------------------------------------------------------------
grpcurl -cacert ca.pem inventory.internal:443 list
grpcurl -cacert ca.pem -cert client.pem -key client.key inventory.internal:443 list

# --- health -----------------------------------------------------------------
grpcurl -plaintext -d '{}' localhost:50051 grpc.health.v1.Health/Check
grpcurl -plaintext -d '{"service":"acme.inventory.v1.InventoryService"}' \
  localhost:50051 grpc.health.v1.Health/Check
grpcurl -plaintext -d '{}' localhost:50051 grpc.health.v1.Health/Watch   # streams changes

# --- buf curl: same, using the local .proto, no reflection needed -----------
buf curl --schema . --data '{"sku":"sku_1"}' \
  http://localhost:50051/acme.inventory.v1.InventoryService/GetItem
```

### channelz for live connection state

```go
import channelzsvc "google.golang.org/grpc/channelz/service"

// channelz exposes live channel, subchannel, server and socket state over
// gRPC itself: which addresses are connected, how many streams are active,
// bytes in and out. It is the best available answer to "is it even connected?"
//
// It exposes topology and traffic volumes, so gate it like reflection.
if cfg.EnableChannelz {
	channelzsvc.RegisterChannelzServiceToServer(s.grpc)
}
```

```bash
grpcurl -plaintext localhost:50051 grpc.channelz.v1.Channelz/GetServers
grpcurl -plaintext -d '{"server_id":1}' localhost:50051 grpc.channelz.v1.Channelz/GetServerSockets
```

### Testing health transitions

```go
func TestHealthReflectsDependencies(t *testing.T) {
	fakeDB := &fakeDependency{healthy: true}
	srv, client, cleanup := newTestServer(t, withDependency(fakeDB))
	defer cleanup()

	hc := healthpb.NewHealthClient(client)

	// Starts NOT_SERVING until the first successful check.
	waitForStatus(t, hc, "", healthpb.HealthCheckResponse_SERVING, 5*time.Second)

	// A critical dependency failing must flip readiness.
	fakeDB.healthy = false
	waitForStatus(t, hc, "", healthpb.HealthCheckResponse_NOT_SERVING, 5*time.Second)

	// And recovery must flip it back — the case people forget to test.
	fakeDB.healthy = true
	waitForStatus(t, hc, "", healthpb.HealthCheckResponse_SERVING, 5*time.Second)
}

func TestReflectionDisabledByDefault(t *testing.T) {
	// Reflection publishes the whole schema; assert it is off unless enabled.
	_, client, cleanup := newTestServer(t) // default config
	defer cleanup()

	rc := reflectpb.NewServerReflectionClient(client)
	stream, err := rc.ServerReflectionInfo(context.Background())
	if err != nil {
		return // acceptable: the service is not registered at all
	}
	_ = stream.Send(&reflectpb.ServerReflectionRequest{
		MessageRequest: &reflectpb.ServerReflectionRequest_ListServices{},
	})
	if _, err := stream.Recv(); status.Code(err) != codes.Unimplemented {
		t.Fatalf("reflection is enabled by default; got %v", err)
	}
}
```

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Reflection makes any engineer productive immediately** — no `.proto`, no toolchain, three lines of server code.
- **`grpcurl` becomes curl**, so debugging, incident response and manual testing all work the way people expect.
- **The health protocol is standard**, so load balancers, meshes and Kubernetes all understand it without custom glue.
- **Per-service health** lets a partially degraded server express exactly what it can still do.
- **Native Kubernetes gRPC probes** remove the sidecar binary entirely.

**Disadvantages**
- **Reflection publishes the full schema**, including internal services on the same server.
- **`Watch` is a stream**, so it holds a connection and inherits every streaming concern.
- **Health can lie** if it is a static `SERVING` that never checks anything — worse than no health check, because it looks trustworthy.
- **Descriptor sets must be published and versioned** to replace reflection, which is extra release machinery.

**Trade-offs**
- *Reflection on vs off in production:* on makes incident response dramatically faster; off withholds reconnaissance. Gate it, and publish a descriptor set so the capability survives.
- *Dependency-aware health vs static:* accurate readiness routes traffic correctly, but a flapping dependency causes pods to flap in and out of rotation. Use hysteresis — several consecutive failures before flipping — and never let liveness see dependencies.
- *Per-service vs whole-server health:* per-service allows partial degradation but only helps if something routes on it. Start with the whole server and add granularity when a balancer can use it.

## 7. Common Mistakes & Best Practices

- **Reflection enabled unconditionally in production.** Gate it behind configuration.
- **Health that always returns `SERVING`.** Worse than nothing: it looks trustworthy and is not.
- **Liveness checking dependencies.** A slow shared database restarts the entire fleet at once.
- **Readiness failing slowly.** A draining pod keeps receiving traffic for far too long.
- **Not starting `NOT_SERVING`.** Traffic arrives before dependencies are verified.
- **Forgetting `health.Shutdown()`** on `SIGTERM`, so `Watch` clients never learn the server is going away.
- **Health checks that block.** A probe that hangs is indistinguishable from a wedged process; run checks in the background with their own timeouts.
- **No startup probe on a slow-starting service.** You are forced to loosen liveness, which weakens it forever.
- **Logging every health check.** A broken dependency then produces a log line every interval. Log transitions.
- **Assuming `SERVICE_UNKNOWN` comes back from `Check`.** It returns `NotFound` as the status code.
- **channelz enabled publicly.** It exposes topology and traffic volumes.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** `grpcurl` plus reflection is the fastest path from "something is wrong" to "here is the exact request and response". Where reflection is off, `-protoset` with a published descriptor set gives identical capability, including documentation if built with `--include_source_info`. channelz answers connection-level questions no application metric can.
- **Monitoring.** Export the health status as a gauge so it appears on dashboards alongside everything else — a pod that is `NOT_SERVING` but not restarting is invisible otherwise. Alert on prolonged `NOT_SERVING` and on health flapping, since flapping causes traffic churn even when each individual state is brief.
- **Security.** Reflection and channelz are both disclosure surfaces; gate both. The health service is normally public because probes cannot authenticate easily, so keep the response minimal — it must never carry dependency names, versions or error text. Where the health port is internet-reachable, bind it to a separate port or interface.
- **Scaling.** Probes run per pod per interval; a `Check` implementation that queries a database on every call generates real load at scale and can amplify an outage. Cache the result of background checks and answer probes from memory. `Watch` holds a stream per watcher, so cap watchers if a mesh subscribes from every node.

## 9. Interview Questions

**Q: What is gRPC server reflection and what does it expose?**
A: A standard service letting clients ask the server to describe itself — list services, look up a file by name or by the symbol it contains — returning serialised file descriptors, so tooling can build requests dynamically without the `.proto`. It exposes everything compiled into the binary: every service, method, message, field and enum value, plus comments if built with source info, including internal services registered on the same server. It exposes no data and bypasses no authentication, so the risk is reconnaissance rather than compromise — which is why the sensible policy is on internally, gated at the edge, with a published descriptor set so tooling still works.

**Q: How do you use a gRPC service without reflection?**
A: `grpcurl` accepts either the `.proto` files with `-import-path` and `-proto`, or a compiled descriptor set with `-protoset`. Building that descriptor set with `--include_imports --include_source_info` makes it self-contained and preserves comments, so `describe` still shows documentation. Publishing it as a release artefact means operators keep full capability against a production server that has reflection disabled. `buf curl --schema .` does the same thing directly from a local module.

**Q: What is the gRPC health checking protocol?**
A: A standard two-method service: `Check`, a unary point-in-time query, and `Watch`, a server stream of status changes. The request carries a service name, where the empty string means the whole server and a fully-qualified name scopes the check to one service. Statuses are `SERVING`, `NOT_SERVING`, `SERVICE_UNKNOWN` and `UNKNOWN`. It matters because it is what load balancers, meshes and Kubernetes understand natively — since 1.24 the kubelet speaks it directly via `readinessProbe.grpc`.

**Q: Why should readiness and liveness probes have different thresholds?**
A: Because the consequences differ enormously. Failing readiness only removes the pod from the load balancer — cheap and reversible — so it should fail fast, after one or two checks, to get traffic away quickly during a drain or a dependency problem. Failing liveness restarts the process, killing every in-flight request, so it must be tolerant of transient slowness. A low liveness threshold under load produces a restart loop: the pod is slow because it is overloaded, gets killed, its traffic moves to the survivors, and they die too.

**Q: Should health checks probe dependencies?**
A: Readiness yes, liveness no. If the database is unreachable, this pod genuinely cannot serve, so readiness should fail and traffic should go elsewhere — that is exactly what readiness means. Liveness must not, because a shared dependency degrading would fail every pod's probe simultaneously and restart the whole fleet, losing all in-flight work, dropping caches and adding reconnection load to the already-struggling dependency. Liveness should only detect that this process itself is wedged.

**Q: How do health checks fit into graceful shutdown?**
A: They are the first step. On `SIGTERM` you set the status to `NOT_SERVING` and call `health.Shutdown()`, which also notifies any `Watch` clients, then wait for the load balancer to notice — that propagation delay is the phase most implementations omit — and only then call `GracefulStop`. Doing it in this order means new traffic stops arriving while existing calls drain. Doing `GracefulStop` first means requests keep being routed to a server that is refusing them.

**Q: What is the risk of a health check that always returns `SERVING`?**
A: It is worse than having no health check, because it looks trustworthy. A load balancer will keep routing traffic to a pod whose database connection died, whose dependencies are unreachable or which is mid-shutdown, and every one of those requests fails. The absence of a health check at least makes the gap visible; a static `SERVING` actively misleads. The correct implementation reflects real dependency state, updated by background checks with their own timeouts so the probe itself never blocks.

**Q: (Senior) Design health checking for a service with several dependencies of differing importance.**
A: I run dependency checks in the background on an interval, each with its own bounded timeout, and answer probes from the cached result — so a probe never waits on a slow database, because a probe that hangs is indistinguishable from a wedged process. Each dependency is classified: critical ones like the primary datastore flip the whole-server status to `NOT_SERVING`, while non-critical ones like a cache degrade performance and must not remove the pod from rotation. Where a dependency affects only some services, I use per-service health names so a server whose write path is broken can still report reads as `SERVING`. Readiness reflects all of that; liveness reflects none of it, and only detects that the process itself is wedged. I add hysteresis — several consecutive failures before flipping — because a flapping dependency otherwise causes pods to flap in and out of rotation, which is worse than either state. And I export the status as a metric, because a pod sitting `NOT_SERVING` without restarting is otherwise invisible.

**Q: (Senior) Reflection is disabled in production and an incident is under way. How do you debug?**
A: The prepared answer is that a descriptor set was published with the release, built with `--include_imports --include_source_info`, so `grpcurl -protoset schema.protoset` gives full capability including method documentation, with no server-side change. If that was not done, the fallbacks in order: `buf curl --schema .` from a checkout of the schema repository at the deployed version, which needs only the `.proto` files; a purpose-built client compiled from the same generated code the service uses; or, as a last resort, enabling reflection behind an authenticated interceptor on a canary instance rather than fleet-wide. What I would not do is enable reflection everywhere under incident pressure and forget to turn it off. The follow-up action after the incident is to make the descriptor set a standard release artefact, because the cost is a few hundred kilobytes and the benefit is that this question never comes up again.

**Q: (Senior) How do you prevent a health check from causing the outage it is meant to detect?**
A: Three mechanisms. First, never let liveness see dependencies — that single rule prevents the fleet-wide restart cascade, which is the most damaging failure mode in this area. Second, decouple the probe from the check: run dependency checks in the background with their own timeouts and answer probes from a cached result, so probe latency is constant and a slow dependency produces a fast negative rather than a hanging probe. Third, cache and rate-limit the checks themselves, because at scale a `Check` implementation that queries the database on every probe generates real load — a hundred pods probing every three seconds is thirty queries per second doing nothing useful, and during an outage that is load the dependency cannot spare. On top of those I would add hysteresis so brief blips do not cause traffic churn, a startup probe so a slow-starting service does not force a loose liveness threshold, and an alert on health flapping rather than only on sustained failure.

## 10. Quick Revision & Cheat Sheet

```go
// Health — register FIRST, as NOT_SERVING
h := health.NewServer()
healthpb.RegisterHealthServer(s, h)
h.SetServingStatus("", healthpb.HealthCheckResponse_NOT_SERVING)
// … verify dependencies …
h.SetServingStatus("", healthpb.HealthCheckResponse_SERVING)
// on SIGTERM:
h.SetServingStatus("", healthpb.HealthCheckResponse_NOT_SERVING); h.Shutdown()

// Reflection — gated
if cfg.EnableReflection { reflection.Register(s) }
```

```bash
grpcurl -plaintext localhost:50051 list
grpcurl -plaintext localhost:50051 describe pkg.Service
grpcurl -plaintext -d '{"sku":"s1"}' localhost:50051 pkg.Service/GetItem
grpcurl -plaintext -d @ localhost:50051 pkg.Service/Upload < msgs.ndjson
grpcurl -protoset schema.protoset -d '{}' host:443 pkg.Service/Method
grpcurl -plaintext -d '{}' localhost:50051 grpc.health.v1.Health/Check
```

| Probe | Threshold | Checks dependencies? | Consequence |
|---|---|---|---|
| Readiness | 2 (fast) | **Yes** | Removed from the load balancer |
| Liveness | 5+ (slow) | **No** | Process **restarted** |
| Startup | 30 | No | Delays liveness until ready |

**Flash cards**
- **Enable reflection?** → Yes internally, gated at the edge. Publish a descriptor set instead.
- **Health service name `""`?** → The whole server. A fully-qualified name scopes it.
- **Start at which status?** → `NOT_SERVING`, until dependencies verify.
- **Liveness and dependencies?** → Never. It restarts the fleet.
- **Readiness threshold?** → Fast. Liveness → slow.
- **Static `SERVING`?** → Worse than no health check.
- **No reflection, need to call it?** → `grpcurl -protoset`, or `buf curl --schema .`

## 11. Hands-On Exercises & Mini Project

- [ ] Enable reflection and run `list`, `describe` on a service and on a message, then call a method — all without a `.proto` on your machine.
- [ ] Disable reflection, build a descriptor set with `--include_imports --include_source_info`, and reproduce every one of those commands with `-protoset`.
- [ ] Implement dependency-aware health, kill the database, and watch readiness flip. Restore it and watch it flip back.
- [ ] Set liveness to check the database with `failureThreshold: 1`, then make the database slow, and observe the fleet-wide restart. Fix it.
- [ ] Use `grpcurl -d '{}' … Health/Watch` and trigger a status change; observe the streamed update.
- [ ] Send `SIGTERM` and verify the health status flips before the drain begins, using the `Watch` stream as your observer.
- [ ] Register channelz and query `GetServers` and `GetServerSockets` to see live stream counts.
- [ ] Drive a client-streaming method with `grpcurl -d @` and newline-delimited JSON.

### Mini Project — "Operable Service"

**Goal.** Make a service that an on-call engineer who has never seen it can debug in five minutes, and whose probes behave correctly under dependency failure.

**Requirements.**
1. Reflection gated behind configuration, with a test asserting it is off by default.
2. A descriptor set built in CI with `--include_imports --include_source_info` and published as a release artefact, plus a documented `grpcurl -protoset` recipe.
3. Dependency-aware health with critical and non-critical dependencies, per-service statuses, background checks with individual timeouts, hysteresis, and transition-only logging.
4. Kubernetes manifests with correctly asymmetric readiness and liveness thresholds, a startup probe, and a `preStop` hook, with the timing arithmetic written out.
5. Health status exported as a metric, with alerts for prolonged `NOT_SERVING` and for flapping.
6. Integration tests covering: health flips on dependency loss and recovers; `SIGTERM` flips health before draining; liveness never fails because of a dependency.
7. A runbook page with the exact `grpcurl` commands for the five most likely incidents.

**Extensions.**
- Add channelz behind the same gate and write a small CLI reporting live connections and active streams per socket.
- Demonstrate per-service health driving routing: make writes `NOT_SERVING` while reads stay `SERVING`, and show a client honouring it.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Build: The gRPC Server* (registering these services), *Graceful Shutdown* (the health flip that starts a drain), *Running protoc* (building descriptor sets), *Build: Authentication* (why reflection does not bypass auth), *Build: Deployment* (probes and load balancing in Kubernetes).

- **gRPC — Health Checking Protocol** — gRPC Authors · *Intermediate* · the normative specification of `Check`, `Watch`, the status values and per-service semantics. <https://github.com/grpc/grpc/blob/master/doc/health-checking.md>
- **grpc-go — health and reflection packages** — gRPC Authors · *Intermediate* · `health.NewServer`, `SetServingStatus`, `Shutdown`, and `reflection.Register`. <https://pkg.go.dev/google.golang.org/grpc/health>
- **grpcurl — README** — FullStory (open source) · *Beginner* · every flag, including `-protoset`, `-d @` for streaming, metadata headers and TLS options. <https://github.com/fullstorydev/grpcurl>
- **Kubernetes — Configure liveness, readiness and startup probes** — Kubernetes · *Intermediate* · the native `grpc` probe type and the thresholds discussed here. <https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/>
- **Kubernetes blog — gRPC container probes in 1.24** — Kubernetes · *Beginner* · what the native probe replaced, and how it maps onto the health protocol. <https://kubernetes.io/blog/2022/05/13/grpc-probes-now-in-beta/>
- **grpc-health-probe** — gRPC ecosystem · *Beginner* · the standalone probe binary for clusters predating native support. <https://github.com/grpc-ecosystem/grpc-health-probe>
- **channelz — a short introduction** — gRPC Authors · *Intermediate* · live channel, socket and stream introspection, and what it can answer that metrics cannot. <https://grpc.io/blog/a-short-introduction-to-channelz/>
- **Google SRE Book — Load Balancing in the Datacenter** — Google · *Advanced* · why health signals must be accurate and fast, and how flapping harms more than a steady failure. <https://sre.google/sre-book/load-balancing-datacenter/>

---

*gRPC with Go Handbook — chapter 25.*
