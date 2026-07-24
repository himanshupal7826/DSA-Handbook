# 18 · Graceful Shutdown, Signals, Keepalive & Server Limits

> **In one line:** `GracefulStop` sends `GOAWAY` and waits for every in-flight RPC — which is correct behaviour and also why a stream without a lifetime cap will hang your deploy forever, so the real subject of this chapter is bounding the wait.

---

## 1. Overview

Shutdown looks trivial and is where a surprising number of production incidents live. The naive version — receive `SIGTERM`, call `GracefulStop`, exit — has three failure modes:

1. **It can hang indefinitely.** `GracefulStop` waits for all in-flight RPCs, and a long-lived stream is an in-flight RPC. Without a lifetime cap the process never exits, Kubernetes eventually sends `SIGKILL`, and every in-flight call dies abruptly — the exact opposite of graceful.
2. **It drops traffic during the drain.** `GOAWAY` tells connected clients to stop sending, but the load balancer may still be routing new connections to this pod for several seconds. Requests arrive at a server that is refusing them.
3. **It leaves dependencies dirty.** Closing the database pool before in-flight handlers finish turns a graceful drain into a burst of `Internal` errors.

The correct sequence is therefore not one call but five phases: **fail readiness → wait for the load balancer → `GracefulStop` with a timeout → force `Stop` if it overruns → close dependencies**. Each phase exists because of a specific failure it prevents.

The chapter also covers the connection-level settings that determine what "in-flight" even means: **keepalive**, which detects dead peers and rotates connections, and the **server limits** that bound resource use. These belong together because `MaxConnectionAge` is simultaneously a load-balancing tool and a shutdown-bounding tool — it is the single most under-used gRPC server option.

## 2. Core Concepts

- **`GracefulStop()`** — sends `GOAWAY`, stops accepting new streams, waits for in-flight RPCs, then closes. Blocks.
- **`Stop()`** — closes everything immediately; in-flight RPCs fail with `Unavailable`. The escape hatch.
- **`GOAWAY`** — the HTTP/2 frame naming the highest stream id the server will process; clients reconnect elsewhere for new calls.
- **`SIGTERM` / `SIGINT`** — the signals a container runtime and a terminal send. `signal.NotifyContext` turns them into a cancelled context.
- **`terminationGracePeriodSeconds`** — Kubernetes' hard limit between `SIGTERM` and `SIGKILL`. Your shutdown budget must fit inside it.
- **`preStop` hook** — a Kubernetes hook run *before* `SIGTERM`, used to sleep while endpoints propagate.
- **Readiness probe** — what removes the pod from the load balancer's rotation. Must fail before the drain begins.
- **`keepalive.ServerParameters`** — `Time`, `Timeout`, `MaxConnectionIdle`, `MaxConnectionAge`, `MaxConnectionAgeGrace`.
- **`keepalive.EnforcementPolicy`** — `MinTime`, `PermitWithoutStream`; rejects clients that ping too aggressively.
- **`MaxConnectionAge`** — forces connection rotation, which rebalances load *and* bounds how long a stream can be in flight.
- **Lame duck** — the state between "removed from the load balancer" and "shut down", where the server still serves existing traffic.

## 3. Theory & Principles

### What `GracefulStop` actually does

```
GracefulStop()
  1. Stop accepting new connections (close the listener)
  2. Send GOAWAY on every open connection, naming the last stream id it will process
  3. Wait for every in-flight RPC to complete       ← UNBOUNDED
  4. Close all connections
  5. Return
```

Step 3 is the whole problem. A unary RPC completes in milliseconds. A server-streaming watch with no lifetime cap completes when the client disconnects, which may be never. So:

- **`GracefulStop` alone is not a shutdown strategy.** It is one phase of one.
- **It must be wrapped in a timeout**, after which you call `Stop()` and accept that the remaining calls fail.
- **The real fix is upstream**: cap stream lifetimes (chapters 16–17) and set `MaxConnectionAge`, so there is rarely anything long-lived to wait for.

Note that `Serve` returns `nil` after `GracefulStop`, so a non-nil return from `Serve` is always a genuine failure.

### The five-phase shutdown, and why each phase exists

| Phase | Action | Prevents |
|---|---|---|
| 1 | Set health to `NOT_SERVING`, fail readiness | New traffic being routed here during the drain |
| 2 | Sleep for the load-balancer propagation delay | Requests arriving after we stopped accepting but before the LB noticed |
| 3 | `GracefulStop()` with a timeout | In-flight RPCs being killed mid-flight |
| 4 | `Stop()` if the timeout fires | Hanging until `SIGKILL`, which kills everything abruptly |
| 5 | Close dependencies (DB, queue, tracer flush) | Handlers failing on a closed pool; losing the last traces |

**Phase 2 is the one everyone omits**, and it is the cause of the classic "we deployed and saw a spike of connection errors". Removing a pod from a Kubernetes `Service` is eventually consistent: the readiness probe fails, the endpoints controller updates, `kube-proxy` on every node reprograms, and the ingress refreshes — each hop takes time. Meanwhile the pod has already closed its listener. The gap is typically 2–10 seconds, and the fix is to keep serving during it.

Two ways to implement phase 2, and they are not equivalent:

- **A `preStop` hook** (`sleep 10`) runs *before* `SIGTERM` is delivered, so the application is entirely unaware and continues serving normally. This is the more robust option because it does not depend on the application getting it right.
- **An in-process sleep** after failing readiness. Simpler to deploy, but it must fit inside `terminationGracePeriodSeconds` along with everything else.

Use the `preStop` hook when you control the manifest; use the in-process sleep as a fallback.

### The Kubernetes timing budget

```
SIGTERM ──────────────────────────────────────────► SIGKILL
        └─ terminationGracePeriodSeconds (default 30s) ─┘

Your budget must satisfy:
  preStop sleep + LB propagation + GracefulStop timeout + dependency close
      <  terminationGracePeriodSeconds
```

A workable default: `terminationGracePeriodSeconds: 60`, `preStop: sleep 10`, `GracefulStop` timeout 30s, dependency close 5s — leaving headroom. If your streams are capped at 30 minutes, `GracefulStop` will *not* finish within any sane grace period, which is exactly why the cap and `MaxConnectionAge` matter: they ensure long-lived streams are already rotating rather than accumulating.

```svg
<svg viewBox="0 0 880 500" width="100%" height="500" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="gs1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#0ea5e9"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The five-phase shutdown, and what each phase prevents</text>

  <rect x="24" y="42" width="832" height="234" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>

  <rect x="46" y="58" width="156" height="82" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="124" y="78" text-anchor="middle" fill="#92400e" font-size="11" font-weight="bold">1. Fail readiness</text>
  <text x="124" y="96" text-anchor="middle" fill="#b45309" font-size="9">health &#8594; NOT_SERVING</text>
  <text x="124" y="116" text-anchor="middle" fill="#92400e" font-size="9" font-weight="bold">prevents:</text>
  <text x="124" y="132" text-anchor="middle" fill="#b45309" font-size="9">new traffic routed here</text>

  <path d="M204,99 L222,99" stroke="#0ea5e9" stroke-width="2" marker-end="url(#gs1)"/>

  <rect x="226" y="58" width="156" height="82" rx="8" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="304" y="78" text-anchor="middle" fill="#b91c1c" font-size="11" font-weight="bold">2. Wait for the LB</text>
  <text x="304" y="96" text-anchor="middle" fill="#991b1b" font-size="9">preStop sleep, ~10s</text>
  <text x="304" y="116" text-anchor="middle" fill="#b91c1c" font-size="9" font-weight="bold">EVERYONE OMITS THIS</text>
  <text x="304" y="132" text-anchor="middle" fill="#991b1b" font-size="9">&#8594; deploy-time error spike</text>

  <path d="M384,99 L402,99" stroke="#0ea5e9" stroke-width="2" marker-end="url(#gs1)"/>

  <rect x="406" y="58" width="156" height="82" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="484" y="78" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">3. GracefulStop</text>
  <text x="484" y="96" text-anchor="middle" fill="#166534" font-size="9">GOAWAY + drain, TIMED</text>
  <text x="484" y="116" text-anchor="middle" fill="#15803d" font-size="9" font-weight="bold">prevents:</text>
  <text x="484" y="132" text-anchor="middle" fill="#166534" font-size="9">RPCs killed mid-flight</text>

  <path d="M564,99 L582,99" stroke="#0ea5e9" stroke-width="2" marker-end="url(#gs1)"/>

  <rect x="586" y="58" width="120" height="82" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="646" y="78" text-anchor="middle" fill="#92400e" font-size="11" font-weight="bold">4. Stop()</text>
  <text x="646" y="96" text-anchor="middle" fill="#b45309" font-size="9">only if 3 overruns</text>
  <text x="646" y="116" text-anchor="middle" fill="#92400e" font-size="9" font-weight="bold">prevents:</text>
  <text x="646" y="132" text-anchor="middle" fill="#b45309" font-size="9">hanging to SIGKILL</text>

  <path d="M708,99 L726,99" stroke="#0ea5e9" stroke-width="2" marker-end="url(#gs1)"/>

  <rect x="730" y="58" width="106" height="82" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="783" y="78" text-anchor="middle" fill="#5b21b6" font-size="11" font-weight="bold">5. Close deps</text>
  <text x="783" y="96" text-anchor="middle" fill="#6d28d9" font-size="9">DB, queue, tracer</text>
  <text x="783" y="116" text-anchor="middle" fill="#5b21b6" font-size="9" font-weight="bold">prevents:</text>
  <text x="783" y="132" text-anchor="middle" fill="#6d28d9" font-size="9">errors on a closed pool</text>

  <text x="46" y="168" fill="#334155" font-size="12" font-weight="bold">Why phase 2 exists: removing a pod from a Service is eventually consistent</text>
  <text x="46" y="190" fill="#475569">readiness fails &#8594; endpoints controller updates &#8594; kube-proxy reprograms on EVERY node &#8594; ingress refreshes</text>
  <text x="46" y="208" fill="#475569">Each hop takes time; the total is typically 2&#8211;10 seconds. Meanwhile the pod has already closed its listener.</text>
  <text x="46" y="230" fill="#7f1d1d" font-weight="bold">A preStop hook runs BEFORE SIGTERM, so the app is unaware and keeps serving &#8212; more robust than an in-process sleep.</text>
  <text x="46" y="252" fill="#475569">Use preStop when you control the manifest; use an in-process sleep as a fallback.</text>

  <rect x="24" y="294" width="832" height="196" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="440" y="316" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">The Kubernetes timing budget</text>

  <line x1="60" y1="352" x2="800" y2="352" stroke="#334155" stroke-width="2"/>
  <text x="60" y="342" fill="#334155" font-size="10" font-weight="bold">SIGTERM</text>
  <text x="800" y="342" text-anchor="end" fill="#b91c1c" font-size="10" font-weight="bold">SIGKILL</text>
  <line x1="60" y1="344" x2="60" y2="360" stroke="#334155" stroke-width="2"/>
  <line x1="800" y1="344" x2="800" y2="360" stroke="#dc2626" stroke-width="3"/>

  <rect x="60" y="360" width="130" height="26" rx="4" fill="#fee2e2" stroke="#dc2626"/>
  <text x="125" y="378" text-anchor="middle" fill="#991b1b" font-size="9">preStop sleep 10s</text>
  <rect x="192" y="360" width="120" height="26" rx="4" fill="#fef3c7" stroke="#d97706"/>
  <text x="252" y="378" text-anchor="middle" fill="#92400e" font-size="9">LB propagation</text>
  <rect x="314" y="360" width="380" height="26" rx="4" fill="#dcfce7" stroke="#16a34a"/>
  <text x="504" y="378" text-anchor="middle" fill="#15803d" font-size="9">GracefulStop timeout 30s</text>
  <rect x="696" y="360" width="70" height="26" rx="4" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="731" y="378" text-anchor="middle" fill="#5b21b6" font-size="9">deps 5s</text>
  <rect x="768" y="360" width="32" height="26" rx="4" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="784" y="378" text-anchor="middle" fill="#475569" font-size="9">slack</text>

  <text x="60" y="412" fill="#1e40af" font-family="ui-monospace,monospace" font-size="10">terminationGracePeriodSeconds: 60</text>
  <text x="60" y="434" fill="#1d4ed8" font-size="10">preStop + LB propagation + GracefulStop timeout + dependency close  &lt;  terminationGracePeriodSeconds</text>
  <text x="60" y="458" fill="#7f1d1d" font-size="10" font-weight="bold">If your streams are capped at 30 minutes, GracefulStop will NEVER finish inside any sane grace period.</text>
  <text x="60" y="476" fill="#991b1b" font-size="10">That is why stream lifetime caps and MaxConnectionAge matter: they keep long-lived RPCs rotating rather than accumulating.</text>
</svg>
```

### Keepalive: the negotiation nobody documents

Keepalive has server parameters, a server enforcement policy, and client parameters, and they must agree. The failure mode when they do not is a `GOAWAY` with debug data `too_many_pings`, which surfaces to the application as intermittent `Unavailable` on an otherwise healthy service — one of the most-reported and least-understood gRPC problems.

| Parameter | Side | Meaning |
|---|---|---|
| `Time` | Both | Send a PING after this much inactivity |
| `Timeout` | Both | No PING ACK within this → close the connection |
| `PermitWithoutStream` | Both | May PING when there are no active RPCs |
| `MinTime` | Server (enforcement) | Reject clients pinging more often than this |
| `MaxConnectionIdle` | Server | Close a connection idle this long |
| `MaxConnectionAge` | Server | Send `GOAWAY` after a connection lives this long |
| `MaxConnectionAgeGrace` | Server | Drain window after that `GOAWAY` |

**The rules:** the client's `Time` must be **≥** the server's `EnforcementPolicy.MinTime`, and if the client sets `PermitWithoutStream: true` then so must the server's enforcement policy. Configure them as a pair, in the same review.

**`MaxConnectionAge` deserves special attention** because it solves two problems at once. Long-lived HTTP/2 connections pin a client to one backend, so a scale-up delivers no new traffic (chapter 2). Rotating connections every 30 minutes forces re-resolution and rebalances load. Simultaneously, it bounds how long any single connection — and therefore any stream on it — can be in flight when shutdown arrives. `MaxConnectionAgeGrace` is the drain window for that rotation: without it, in-flight RPCs are cut rather than drained.

## 4. Architecture & Workflow

The full lifecycle, from `SIGTERM` to process exit:

1. **Container runtime** runs the `preStop` hook (if configured) — typically `sleep 10`. The application is still serving.
2. **`SIGTERM`** is delivered. `signal.NotifyContext` cancels the root context.
3. **Health flips to `NOT_SERVING`** and `health.Shutdown()` marks every registered service as not serving, so any watcher is notified.
4. **In-process propagation sleep** (if no `preStop` hook), so stragglers still land.
5. **`GracefulStop`** runs in a goroutine; the main path waits on it with a timeout.
6. **On timeout, `Stop()`** — remaining RPCs get `Unavailable`, which is correct: the alternative is `SIGKILL`.
7. **Dependencies close**: database pool, message-queue producer, tracer flush — in reverse order of creation, each with its own timeout.
8. **Exit 0.**

Streaming clients see the `GOAWAY` and should reconnect; capped streams (chapters 16–17) return `Unavailable` with a reconnect hint, which makes drains bounded and predictable.

```svg
<svg viewBox="0 0 880 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Keepalive: a negotiation between three configs</text>

  <rect x="24" y="42" width="270" height="200" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="159" y="64" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">Client parameters</text>
  <g font-family="ui-monospace,monospace" font-size="10" fill="#1d4ed8">
    <text x="40" y="90">Time: 30s</text>
    <text x="40" y="108">Timeout: 10s</text>
    <text x="40" y="126">PermitWithoutStream: true</text>
  </g>
  <text x="40" y="152" fill="#1e40af" font-size="10">Ping after 30s idle; give up if no</text>
  <text x="40" y="168" fill="#1e40af" font-size="10">ACK within 10s; ping even with</text>
  <text x="40" y="184" fill="#1e40af" font-size="10">no active RPCs.</text>
  <text x="40" y="212" fill="#1e3a8a" font-size="10" font-weight="bold">MUST be &#8805; the server's MinTime</text>
  <text x="40" y="228" fill="#1e3a8a" font-size="10" font-weight="bold">or you get too_many_pings.</text>

  <rect x="306" y="42" width="270" height="200" rx="10" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="441" y="64" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Server EnforcementPolicy</text>
  <g font-family="ui-monospace,monospace" font-size="10" fill="#991b1b">
    <text x="322" y="90">MinTime: 10s</text>
    <text x="322" y="108">PermitWithoutStream: true</text>
  </g>
  <text x="322" y="134" fill="#b91c1c" font-size="10">"Reject clients pinging more</text>
  <text x="322" y="150" fill="#b91c1c" font-size="10">often than every 10s."</text>
  <text x="322" y="176" fill="#7f1d1d" font-size="10" font-weight="bold">Violation &#8594; GOAWAY with debug</text>
  <text x="322" y="192" fill="#7f1d1d" font-size="10" font-weight="bold">data "too_many_pings"</text>
  <text x="322" y="216" fill="#991b1b" font-size="10">&#8594; the app sees intermittent</text>
  <text x="322" y="232" fill="#991b1b" font-size="10">Unavailable on a HEALTHY service.</text>

  <rect x="588" y="42" width="268" height="200" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="722" y="64" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Server parameters</text>
  <g font-family="ui-monospace,monospace" font-size="10" fill="#166534">
    <text x="604" y="90">Time: 30s   Timeout: 10s</text>
    <text x="604" y="108">MaxConnectionIdle: 15m</text>
    <text x="604" y="126">MaxConnectionAge: 30m</text>
    <text x="604" y="144">MaxConnectionAgeGrace: 30s</text>
  </g>
  <text x="604" y="170" fill="#15803d" font-size="10" font-weight="bold">MaxConnectionAge solves TWO</text>
  <text x="604" y="186" fill="#15803d" font-size="10" font-weight="bold">problems at once:</text>
  <text x="604" y="204" fill="#166534" font-size="10">1. forces re-resolution &#8594; load</text>
  <text x="604" y="218" fill="#166534" font-size="10">   rebalances onto new pods</text>
  <text x="604" y="234" fill="#166534" font-size="10">2. bounds in-flight age at shutdown</text>

  <rect x="24" y="260" width="832" height="150" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="282" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">GracefulStop vs Stop</text>

  <rect x="48" y="298" width="380" height="96" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="238" y="318" text-anchor="middle" fill="#15803d" font-weight="bold">GracefulStop()</text>
  <text x="62" y="340" fill="#166534" font-size="10">1. close the listener &#8212; no new connections</text>
  <text x="62" y="356" fill="#166534" font-size="10">2. GOAWAY on every open connection</text>
  <text x="62" y="372" fill="#b91c1c" font-size="10" font-weight="bold">3. wait for in-flight RPCs &#8212; UNBOUNDED</text>
  <text x="62" y="388" fill="#166534" font-size="10">4. close connections and return</text>

  <rect x="452" y="298" width="380" height="96" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="642" y="318" text-anchor="middle" fill="#92400e" font-weight="bold">Stop()</text>
  <text x="466" y="340" fill="#b45309" font-size="10">Closes everything immediately.</text>
  <text x="466" y="356" fill="#b45309" font-size="10">In-flight RPCs fail with Unavailable.</text>
  <text x="466" y="376" fill="#92400e" font-size="10" font-weight="bold">Correct as a TIMEOUT fallback:</text>
  <text x="466" y="392" fill="#b45309" font-size="10">the alternative is hanging until SIGKILL.</text>
</svg>
```

## 5. Implementation

### The complete shutdown sequence

```go
package server

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"time"

	"google.golang.org/grpc"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
)

// ShutdownConfig is the timing budget. Every value must be justified against
// terminationGracePeriodSeconds:
//
//	LBPropagation + GracefulTimeout + DependencyTimeout < grace period
type ShutdownConfig struct {
	// How long to keep serving after readiness fails, so load balancers stop
	// routing here BEFORE we stop accepting. Set to 0 when a Kubernetes
	// preStop hook already covers it (which is the more robust option, since
	// it runs before SIGTERM and does not depend on the app behaving).
	LBPropagation time.Duration

	// Bound on GracefulStop. On expiry we call Stop() and accept that the
	// remaining RPCs fail — that beats hanging until SIGKILL.
	GracefulTimeout time.Duration

	// Bound on closing dependencies afterwards.
	DependencyTimeout time.Duration
}

func DefaultShutdownConfig() ShutdownConfig {
	return ShutdownConfig{
		LBPropagation:     8 * time.Second,
		GracefulTimeout:   30 * time.Second,
		DependencyTimeout: 5 * time.Second,
	}
}

// Closer is anything that must be shut down after the server drains: a
// database pool, a message-queue producer, a tracer provider.
type Closer interface {
	Name() string
	Close(context.Context) error
}

type Server struct {
	cfg      Config
	shutdown ShutdownConfig
	log      *slog.Logger
	grpc     *grpc.Server
	health   *healthServer
	closers  []Closer // closed in REVERSE order of registration
}

// Run serves until ctx is cancelled (by SIGTERM/SIGINT), then shuts down.
func (s *Server) Run(ctx context.Context) error {
	lis, err := net.Listen("tcp", s.cfg.Addr)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", s.cfg.Addr, err)
	}
	s.log.Info("serving", "addr", lis.Addr().String())

	serveErr := make(chan error, 1)
	go func() {
		// Serve returns nil after GracefulStop, so a non-nil value here is a
		// genuine failure, not a normal shutdown.
		serveErr <- s.grpc.Serve(lis)
	}()

	select {
	case err := <-serveErr:
		if err != nil {
			return fmt.Errorf("serve: %w", err)
		}
		return nil

	case <-ctx.Done():
		s.log.Info("signal received; beginning shutdown")
		return s.gracefulShutdown()
	}
}

func (s *Server) gracefulShutdown() error {
	start := time.Now()

	// --- Phase 1: fail readiness -------------------------------------------
	// Do this FIRST so load balancers begin removing us while we are still
	// serving existing traffic. health.Shutdown() also notifies any client
	// watching the health service via the streaming Watch method.
	s.health.SetNotServing()
	s.health.Shutdown()
	s.log.Info("phase 1: readiness failed", "elapsed", time.Since(start))

	// --- Phase 2: wait for the load balancer -------------------------------
	// The phase everyone omits, and the cause of the classic deploy-time
	// error spike. Removing a pod from a Kubernetes Service is eventually
	// consistent: probe fails -> endpoints controller -> kube-proxy on every
	// node -> ingress. Typically 2-10 seconds.
	//
	// If a preStop hook already covers this, set LBPropagation to 0 rather
	// than paying for it twice.
	if s.shutdown.LBPropagation > 0 {
		s.log.Info("phase 2: waiting for load-balancer propagation",
			"duration", s.shutdown.LBPropagation)
		time.Sleep(s.shutdown.LBPropagation)
	}

	// --- Phase 3: GracefulStop, bounded ------------------------------------
	// GracefulStop sends GOAWAY and waits for every in-flight RPC. That wait
	// is UNBOUNDED, so it must run in a goroutine we can give up on.
	s.log.Info("phase 3: draining in-flight RPCs",
		"timeout", s.shutdown.GracefulTimeout)

	drained := make(chan struct{})
	go func() {
		s.grpc.GracefulStop()
		close(drained)
	}()

	select {
	case <-drained:
		s.log.Info("drain complete", "elapsed", time.Since(start))

	case <-time.After(s.shutdown.GracefulTimeout):
		// --- Phase 4: force ------------------------------------------------
		// The remaining RPCs fail with Unavailable, which is honest and
		// retryable. The alternative is hanging until SIGKILL, which kills
		// EVERY in-flight call abruptly and skips phase 5 entirely.
		s.log.Warn("drain timed out; forcing stop",
			"timeout", s.shutdown.GracefulTimeout,
			"hint", "check for streams without a lifetime cap")
		s.grpc.Stop()
		<-drained // GracefulStop returns once Stop has torn everything down
	}

	// --- Phase 5: close dependencies ---------------------------------------
	// Only now, when no handler can still be running. Closing the pool earlier
	// turns a graceful drain into a burst of Internal errors.
	ctx, cancel := context.WithTimeout(context.Background(), s.shutdown.DependencyTimeout)
	defer cancel()

	var errs []error
	for i := len(s.closers) - 1; i >= 0; i-- { // reverse order of creation
		c := s.closers[i]
		if err := c.Close(ctx); err != nil {
			s.log.Error("dependency close failed", "name", c.Name(), "err", err)
			errs = append(errs, fmt.Errorf("%s: %w", c.Name(), err))
		}
	}

	s.log.Info("shutdown complete", "total", time.Since(start))
	return errors.Join(errs...)
}
```

### Signal handling

```go
package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	// NotifyContext cancels ctx on the first SIGINT or SIGTERM. A SECOND
	// signal restores default behaviour, so an impatient operator pressing
	// Ctrl-C twice gets an immediate exit rather than being ignored — which
	// is the behaviour people expect and the reason to prefer this over a
	// hand-rolled signal channel.
	ctx, stop := signal.NotifyContext(context.Background(),
		syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := run(ctx); err != nil {
		os.Exit(1)
	}
}
```

### Keepalive and limits, configured as a pair

```go
import "google.golang.org/grpc/keepalive"

// --- SERVER -----------------------------------------------------------------
grpc.NewServer(
	grpc.KeepaliveParams(keepalive.ServerParameters{
		// Detect dead peers: PING after 30s idle, close if no ACK in 10s.
		Time:    30 * time.Second,
		Timeout: 10 * time.Second,

		// Reap idle connections and their buffers.
		MaxConnectionIdle: 15 * time.Minute,

		// THE most under-used gRPC option. Rotating connections forces clients
		// to re-resolve, which is what makes load rebalance onto pods added by
		// an autoscaler. It also bounds how long any connection can be in
		// flight when shutdown arrives.
		MaxConnectionAge: 30 * time.Minute,

		// The drain window after that GOAWAY. Without it, in-flight RPCs are
		// cut at rotation rather than drained — a self-inflicted error spike
		// every 30 minutes.
		MaxConnectionAgeGrace: 30 * time.Second,
	}),

	// Without an enforcement policy, a client can PING-flood you. With one
	// that disagrees with the client's config, you send GOAWAY too_many_pings
	// and the client reports intermittent Unavailable on a healthy service.
	grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{
		MinTime:             10 * time.Second, // client Time must be >= this
		PermitWithoutStream: true,             // must be true if the client sets it
	}),

	// Resource limits: DoS defences, not tuning knobs.
	grpc.MaxRecvMsgSize(8<<20),
	grpc.MaxSendMsgSize(8<<20),        // default is UNLIMITED
	grpc.MaxConcurrentStreams(1000),   // grpc-go default is ~unlimited
	grpc.ConnectionTimeout(20*time.Second),
)

// --- CLIENT (configure in the SAME review) ----------------------------------
grpc.NewClient(target,
	grpc.WithKeepaliveParams(keepalive.ClientParameters{
		Time:                30 * time.Second, // >= server MinTime (10s) ✓
		Timeout:             10 * time.Second,
		PermitWithoutStream: true,             // server permits it ✓
	}),
)
```

### Kubernetes manifest

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: inventory
spec:
  template:
    spec:
      # Must exceed: preStop + GracefulStop timeout + dependency close.
      # 10 + 30 + 5 = 45, so 60 leaves headroom.
      terminationGracePeriodSeconds: 60

      containers:
        - name: inventory
          image: acme/inventory:v1.8.0
          ports:
            - name: grpc
              containerPort: 50051

          lifecycle:
            preStop:
              exec:
                # Runs BEFORE SIGTERM. The application is unaware and keeps
                # serving normally while endpoints propagate — more robust
                # than an in-process sleep, because it does not depend on the
                # application implementing it correctly.
                command: ["/bin/sh", "-c", "sleep 10"]

          # grpc_health_probe speaks the standard gRPC health protocol.
          # Kubernetes 1.24+ also supports a native grpc probe (shown below).
          readinessProbe:
            grpc:
              port: 50051
            initialDelaySeconds: 2
            periodSeconds: 3
            failureThreshold: 2      # fail fast: this gates traffic

          livenessProbe:
            grpc:
              port: 50051
            initialDelaySeconds: 15
            periodSeconds: 15
            failureThreshold: 5      # fail slow: this RESTARTS the pod
```

Note the deliberate asymmetry: **readiness fails fast** (it only removes traffic) while **liveness fails slow** (it kills the process). Getting these the wrong way round produces restart loops under load.

### Testing shutdown

```go
func TestGracefulShutdownDrainsInFlightRPCs(t *testing.T) {
	srv, client, cleanup := newTestServer(t, withSlowHandler(2*time.Second))
	defer cleanup()

	// Start a call that will still be running when shutdown begins.
	result := make(chan error, 1)
	go func() {
		_, err := client.SlowMethod(context.Background(), &pb.Request{})
		result <- err
	}()

	time.Sleep(200 * time.Millisecond) // let the call land

	shutdownDone := make(chan struct{})
	go func() { srv.Shutdown(); close(shutdownDone) }()

	// The in-flight call must COMPLETE, not be cut off.
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("in-flight RPC was killed during graceful shutdown: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("in-flight RPC never completed")
	}

	select {
	case <-shutdownDone:
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown hung — check for streams without a lifetime cap")
	}
}

func TestShutdownTimesOutOnUncappedStream(t *testing.T) {
	// The regression test that matters: an endless stream must NOT block
	// shutdown past the configured timeout.
	srv, client, cleanup := newTestServer(t,
		withEndlessStream(), withGracefulTimeout(1*time.Second))
	defer cleanup()

	stream, err := client.EndlessWatch(context.Background(), &pb.Request{})
	if err != nil {
		t.Fatal(err)
	}
	go func() { for { if _, err := stream.Recv(); err != nil { return } } }()

	start := time.Now()
	srv.Shutdown()

	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("shutdown took %v; the graceful timeout did not fire", elapsed)
	}
}
```

## 6. Advantages, Disadvantages & Trade-offs

**Advantages of gRPC's shutdown model**
- **`GOAWAY` is a protocol feature**, so clients are told authoritatively which streams will be honoured — no guessing.
- **Streaming clients get a clean signal** and can reconnect rather than seeing a reset.
- **`MaxConnectionAge` gives you connection rotation** as a first-class option, solving load balancing and drain bounding together.
- **`Serve` returns `nil`** after `GracefulStop`, so normal shutdown is distinguishable from failure.

**Disadvantages**
- **`GracefulStop` is unbounded**, so it is never sufficient alone.
- **Nothing coordinates with the load balancer.** Phase 2 is entirely your responsibility.
- **Keepalive is a three-way negotiation** with no validation and a confusing failure mode.
- **No built-in lame-duck state.** You build it from health status plus a sleep.

**Trade-offs**
- *`preStop` hook vs in-process sleep:* the hook is more robust because it runs before `SIGTERM` and needs no application cooperation, but requires manifest control. Do both if you must, with the in-process value set to 0 when the hook exists.
- *Graceful timeout length:* longer drains more calls but risks `SIGKILL`; shorter exits predictably but fails more in-flight work. Pick from your actual p99.9 handler duration, and cap streams so the number is achievable.
- *`MaxConnectionAge` frequency:* shorter rotates load faster but pays more handshakes and disrupts more streams; 30 minutes is a reasonable default.

## 7. Common Mistakes & Best Practices

- **Calling `GracefulStop` without a timeout.** One uncapped stream hangs the process until `SIGKILL`.
- **Omitting the load-balancer propagation wait.** The classic deploy-time error spike.
- **Closing the database before the drain finishes.** Turns a graceful shutdown into a burst of `Internal` errors.
- **Not failing readiness first.** Traffic keeps arriving throughout the drain.
- **`MaxConnectionAge` without `MaxConnectionAgeGrace`.** In-flight RPCs are cut at every rotation — a self-inflicted error spike on a timer.
- **Client keepalive more aggressive than the server's `MinTime`.** `GOAWAY: too_many_pings`, seen as intermittent `Unavailable`.
- **`terminationGracePeriodSeconds` smaller than the shutdown budget.** `SIGKILL` arrives mid-drain.
- **Liveness probes that fail fast.** They restart the pod; readiness should fail fast, liveness slow.
- **Streams with no lifetime cap.** The single most common cause of a hung shutdown.
- **Ignoring `Serve`'s return.** It is `nil` on graceful stop, so anything else is a real failure worth logging.
- **A hand-rolled signal channel instead of `signal.NotifyContext`.** You lose the second-signal-forces-exit behaviour operators expect.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** When shutdown hangs, a goroutine dump immediately shows which handlers are still running — almost always a stream without a lifetime cap. `GRPC_GO_LOG_VERBOSITY_LEVEL=99` shows `GOAWAY` frames and their debug data, which is how you confirm a `too_many_pings` diagnosis.
- **Monitoring.** Emit shutdown duration per phase as a metric or at least a structured log line, and alert when phase 3 hits its timeout — that is a latent hang. Track `GOAWAY` counts and connection age distribution; a spike in connection churn usually means a keepalive or `MaxConnectionAge` interaction.
- **Security.** Shutdown is a small availability surface: a client holding thousands of long streams can extend your drains and delay deploys. Message budgets and lifetime caps bound that. Ensure phase 5 flushes audit and trace exporters, or the last seconds before a shutdown become an observability blind spot exactly when you need it.
- **Scaling.** `MaxConnectionAge` is the option that makes autoscaling work for gRPC — without it, new pods stay cold. Verify it by scaling up under load and watching per-pod QPS converge. During large rollouts, staggered rotation matters: if every connection has the same age, they all rotate together and you get a thundering herd; grpc-go jitters this, but keep an eye on it at high connection counts.

## 9. Interview Questions

**Q: What does `GracefulStop` do, and why is it not enough on its own?**
A: It closes the listener, sends `GOAWAY` on every open connection naming the last stream id it will process, waits for all in-flight RPCs to complete, then closes everything. The problem is that the wait is unbounded — a server-streaming call with no lifetime cap is an in-flight RPC that may never finish, so the process hangs until Kubernetes sends `SIGKILL`, which kills every in-flight call abruptly. So `GracefulStop` must run in a goroutine with a timeout, after which you call `Stop()` and accept that the remainder fail with `Unavailable`.

**Q: Walk through a correct shutdown sequence.**
A: Five phases. Fail readiness first, so load balancers begin removing the pod while it is still serving. Wait for that removal to propagate — typically 2–10 seconds in Kubernetes — because the update is eventually consistent across the endpoints controller, `kube-proxy` on every node, and the ingress. Then `GracefulStop` with a timeout. If the timeout fires, `Stop()`. Finally close dependencies in reverse order of creation, each with its own timeout. The whole budget must fit inside `terminationGracePeriodSeconds`.

**Q: Why do you need a delay between failing readiness and stopping the server?**
A: Because removing a pod from a load balancer is eventually consistent. The readiness probe fails, then the endpoints controller updates, then `kube-proxy` reprograms on every node, then the ingress refreshes — each hop takes time, typically 2–10 seconds in total. If the pod closes its listener immediately, requests continue arriving from components that have not caught up, and clients see connection errors. That gap is the cause of the classic "we deployed and saw a spike of errors", and it is the phase most implementations omit.

**Q: `preStop` hook or in-process sleep?**
A: The `preStop` hook is more robust, because it runs *before* `SIGTERM` is delivered, so the application is entirely unaware and keeps serving normally while endpoints propagate — it does not depend on the application implementing the delay correctly. The in-process sleep is simpler to deploy and works when you do not control the manifest. If you use the hook, set the in-process value to zero rather than paying for the delay twice, and remember that the hook's duration counts against `terminationGracePeriodSeconds`.

**Q: What is `MaxConnectionAge` and why does it matter?**
A: It makes the server send `GOAWAY` after a connection has lived that long, forcing the client to re-resolve and reconnect. It matters for two independent reasons. Load balancing: gRPC opens one long-lived HTTP/2 connection, so without rotation a client stays pinned to whichever pods existed when it connected, and a scale-up delivers no new traffic. And shutdown: it bounds how long any connection, and therefore any stream on it, can have been in flight when a drain begins. It must be paired with `MaxConnectionAgeGrace`, or in-flight RPCs are cut at every rotation rather than drained.

**Q: What causes `GOAWAY: too_many_pings`?**
A: The client's keepalive `Time` is shorter than the server's `KeepaliveEnforcementPolicy.MinTime`, or the client pings on idle connections while the server's policy has `PermitWithoutStream: false`. The server treats it as abuse and closes the connection, which the application sees as intermittent `Unavailable` on an otherwise healthy service. The fix is to configure both sides together in the same review — the client's `Time` must be at least the server's `MinTime`, and the `PermitWithoutStream` settings must agree.

**Q: Why should readiness probes fail fast and liveness probes fail slow?**
A: They have very different consequences. A failing readiness probe only removes the pod from the load balancer, which is cheap and reversible, so failing after one or two checks gets traffic away quickly during a drain or a transient dependency problem. A failing liveness probe *restarts the process*, killing every in-flight request, so it must be tolerant of transient slowness — a low failure threshold there produces restart loops under load, where the pod is slow because it is overloaded, gets killed, and the load moves to the remaining pods, which then also die.

**Q: (Senior) Design the shutdown for a service with long-lived streaming clients.**
A: The core insight is that `GracefulStop` cannot drain a 30-minute stream inside any sane grace period, so the fix belongs upstream rather than in the shutdown code. I cap stream lifetime server-side — say 15 minutes — closing with `Unavailable` plus a resume token so clients reconnect and continue without gaps, which means at any moment the oldest stream is at most 15 minutes old and, more importantly, clients are already built to handle being asked to reconnect. `MaxConnectionAge` at 30 minutes with a 30-second grace does the same at the connection level. Then the shutdown itself: fail readiness, wait for propagation via a `preStop` hook, and `GracefulStop` with a timeout sized from actual p99.9 handler duration — for a service with streams, I would additionally broadcast a "server draining" message on every open stream at the start of phase 3, so well-behaved clients reconnect immediately rather than waiting for the timeout. `Stop()` as the backstop, then dependencies. The property I am buying is that a deploy is bounded and predictable rather than depending on client behaviour I do not control.

**Q: (Senior) Deploys produce a spike of `Unavailable` errors. Diagnose.**
A: I would work through the phases in order. First, is readiness failing before the server stops accepting? If shutdown begins with `GracefulStop`, traffic is still being routed for several seconds and every one of those requests fails. Second, is there a propagation delay at all? Without a `preStop` hook or an in-process sleep, the pod stops accepting while `kube-proxy` and the ingress still list it — that is the single most common cause. Third, is `terminationGracePeriodSeconds` large enough for the whole budget? If `SIGKILL` arrives mid-drain, every in-flight call dies. Fourth — and this one produces a spike on a *timer* rather than only at deploys — is `MaxConnectionAge` set without `MaxConnectionAgeGrace`? That cuts in-flight RPCs at every rotation. Fifth, are dependencies being closed before the drain finishes, so handlers fail on a closed pool. I would confirm by correlating the error timestamps against pod termination events and by adding a per-phase duration log to the shutdown path, which usually identifies the phase immediately.

**Q: (Senior) How do you choose the graceful-stop timeout?**
A: From measurement, not convention. The starting point is the p99.9 duration of the longest unary handler, plus headroom — if the slowest legitimate call takes two seconds, a 30-second timeout drains essentially everything. Streams break that reasoning entirely, which is why they need lifetime caps: with a cap, the drain is bounded by the cap, and without one no timeout is long enough. Then the constraint from above: preStop plus propagation plus this timeout plus dependency close must fit inside `terminationGracePeriodSeconds`, so if the arithmetic does not work, either the grace period rises or the timeout falls. I would also instrument it — log the drain duration on every shutdown and alert when the timeout actually fires, because that is a latent hang telling you some handler or stream is unbounded, and it is much better to learn that from a metric than from a stuck rollout.

## 10. Quick Revision & Cheat Sheet

```go
// 1. fail readiness      health.SetServingStatus("", NOT_SERVING); health.Shutdown()
// 2. wait for the LB     time.Sleep(8*time.Second)   // or a preStop hook
// 3. drain, bounded
drained := make(chan struct{})
go func() { s.GracefulStop(); close(drained) }()
select {
case <-drained:
case <-time.After(30 * time.Second):
    s.Stop()          // 4. force — Unavailable beats SIGKILL
    <-drained
}
// 5. close dependencies in REVERSE order, each with its own timeout
```

| Setting | Value | Purpose |
|---|---|---|
| `terminationGracePeriodSeconds` | 60 | Must exceed the whole budget |
| `preStop` | `sleep 10` | LB propagation, before `SIGTERM` |
| Graceful timeout | 30s | From p99.9 handler duration |
| `MaxConnectionAge` | 30m | Rebalances load + bounds in-flight age |
| `MaxConnectionAgeGrace` | 30s | Drain window at rotation — **required** |
| `MaxConnectionIdle` | 15m | Reap idle connections |
| Keepalive `Time` / `Timeout` | 30s / 10s | Detect dead peers |
| `EnforcementPolicy.MinTime` | 10s | Client `Time` must be ≥ this |
| Readiness `failureThreshold` | 2 | Fail **fast** — only removes traffic |
| Liveness `failureThreshold` | 5 | Fail **slow** — restarts the process |

**Flash cards**
- **`GracefulStop` alone?** → Unbounded. Always wrap in a timeout with `Stop()` as backstop.
- **The omitted phase?** → Waiting for load-balancer propagation after failing readiness.
- **Hung shutdown, first suspect?** → A stream with no lifetime cap.
- **`MaxConnectionAge` without grace?** → In-flight RPCs cut at every rotation.
- **`too_many_pings`?** → Client keepalive `Time` < server `MinTime`.
- **Readiness vs liveness thresholds?** → Readiness fast, liveness slow.
- **`Serve` returns nil?** → Normal graceful stop. Anything else is a real failure.

## 11. Hands-On Exercises & Mini Project

- [ ] Start a 5-second handler, send `SIGTERM` after 1 second, and verify with `GracefulStop` that the call completes. Repeat with `Stop()` and observe `Unavailable`.
- [ ] Open a stream with no lifetime cap, trigger shutdown, and watch it hang. Add the timeout and confirm it exits; then add a lifetime cap and confirm it exits cleanly instead of forcibly.
- [ ] Deploy to Kubernetes without a `preStop` hook and measure the error spike during a rolling update. Add the hook and measure again.
- [ ] Set `MaxConnectionAge: 10s` without a grace period and watch RPCs fail every ten seconds. Add `MaxConnectionAgeGrace` and watch them drain.
- [ ] Set the client's keepalive `Time` to 5 s and the server's `MinTime` to 30 s. Reproduce `too_many_pings` in the verbose logs, then fix it.
- [ ] Set `terminationGracePeriodSeconds: 5` with a 30-second drain and observe `SIGKILL` mid-drain, including which log lines you never get.
- [ ] Write the two shutdown tests from §5 and make them part of CI.

### Mini Project — "Zero-Downtime Deploy Harness"

**Goal.** Prove, with numbers, that a rolling deploy of your service drops zero requests — the claim everyone makes and few measure.

**Requirements.**
1. A service with a mix of fast unary calls, a slow unary call, and a long-lived stream with a lifetime cap.
2. The full five-phase shutdown from §5, with per-phase duration logged and exported as a metric.
3. A Kubernetes manifest with `terminationGracePeriodSeconds`, a `preStop` hook, and correctly asymmetric readiness/liveness thresholds, with the arithmetic written out in a comment.
4. Keepalive configured as a matched pair on client and server, including `MaxConnectionAge` and its grace, with a test that asserts rotation drains rather than cuts.
5. A load generator running steady traffic across a rolling update of at least three replicas, recording every non-`OK` status by code.
6. A streaming client that reconnects on `Unavailable` using a resume token, with an assertion that no events were lost across the deploy.
7. A report: error count by code during the deploy, drain duration per pod, and the effect of removing the `preStop` hook.

**Extensions.**
- Remove the lifetime cap and quantify how much longer the deploy takes, then restore it.
- Compare `MaxConnectionAge` at 5, 30 and 120 minutes for load distribution across a scale-up, and chart per-pod QPS convergence time.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Build: The gRPC Server* (where these options are set), *Server-Side Streaming Handlers* (lifetime caps, without which shutdown hangs), *HTTP/2 Under gRPC* (`GOAWAY` and keepalive frames), *Reflection, grpcurl & Health Checks* (the health service that gates traffic), *Build: Deployment* (load balancing and connection rotation in Kubernetes).

- **grpc-go — Server.GracefulStop and Stop** — gRPC Authors · *Intermediate* · the precise semantics of each, including that `Serve` returns `nil` after a graceful stop. <https://pkg.go.dev/google.golang.org/grpc#Server.GracefulStop>
- **grpc-go — keepalive package** — gRPC Authors · *Intermediate* · every parameter, its default, and the client/server interaction rules behind `too_many_pings`. <https://pkg.go.dev/google.golang.org/grpc/keepalive>
- **Kubernetes — Pod lifecycle and termination** — Kubernetes · *Intermediate* · the exact ordering of `preStop`, `SIGTERM`, endpoint removal and `SIGKILL`; the source of the timing budget. <https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination>
- **Kubernetes — Configure liveness, readiness and startup probes** — Kubernetes · *Beginner* · including the native `grpc` probe type and why the thresholds should be asymmetric. <https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/>
- **gRPC — Health Checking Protocol** — gRPC Authors · *Intermediate* · the standard service, its `Watch` method, and `Shutdown()` semantics used in phase 1. <https://github.com/grpc/grpc/blob/master/doc/health-checking.md>
- **RFC 9113 §6.8 — GOAWAY** — IETF · *Advanced* · what `GOAWAY` guarantees about which streams will be processed, and its debug data field. <https://www.rfc-editor.org/rfc/rfc9113#section-6.8>
- **gRPC Blog — gRPC Load Balancing** — gRPC Authors · *Intermediate* · why connection rotation is required for load to rebalance, the other half of `MaxConnectionAge`. <https://grpc.io/blog/grpc-load-balancing/>
- **Go — os/signal.NotifyContext** — The Go Authors · *Beginner* · signal-to-context conversion, and the second-signal-restores-default behaviour operators rely on. <https://pkg.go.dev/os/signal#NotifyContext>

---

*gRPC with Go Handbook — chapter 18.*
