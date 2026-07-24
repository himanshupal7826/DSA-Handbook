# 23 · Build: Interceptors — Unary & Stream, Server & Client Chains

> **In one line:** There are exactly four interceptor signatures — unary/stream × server/client — chains execute outside-in, and the two things that go wrong every time are forgetting that streams need a separate implementation and putting recovery anywhere other than first.

---

## 1. Overview

Interceptors are gRPC's middleware. They wrap a call, run code before and after the handler, and can modify the context, inspect the request, transform the response or replace the error. Everything cross-cutting belongs here: panic recovery, logging, metrics, tracing, authentication, authorization, validation, rate limiting, retries and request-id propagation.

The reason to use them rather than helper calls at the top of each handler is not elegance — it is that **a new method cannot forget them**. A handler added on a Friday afternoon inherits auth, validation and metrics automatically. That single property is why interceptors are the right home for anything security- or observability-related.

There are **four signatures**, and this is the first thing to internalise:

```go
type UnaryServerInterceptor  func(ctx, req any, info *UnaryServerInfo, handler UnaryHandler) (any, error)
type StreamServerInterceptor func(srv any, ss ServerStream, info *StreamServerInfo, handler StreamHandler) error
type UnaryClientInterceptor  func(ctx, method string, req, reply any, cc *ClientConn, invoker UnaryInvoker, opts ...CallOption) error
type StreamClientInterceptor func(ctx, desc *StreamDesc, cc *ClientConn, method string, streamer Streamer, opts ...CallOption) (ClientStream, error)
```

They are genuinely different — a unary interceptor sees the request and response values; a stream interceptor sees only the stream object, and to inspect messages it must **wrap** the stream. Writing the unary version and forgetting the stream version leaves every streaming method unauthenticated and unmonitored, which is a common and quiet failure.

The other structural fact is **ordering**. `ChainUnaryInterceptor(a, b, c)` executes `a` outermost: `a` sees the request first and the response last. That ordering is not arbitrary — it determines whether your recovery interceptor can catch a panic in your auth interceptor, and whether your metrics observe the status code your error mapper produced.

## 2. Core Concepts

- **`UnaryServerInterceptor`** — wraps a unary handler; sees `req` and the returned `resp`/`error`.
- **`StreamServerInterceptor`** — wraps a streaming handler; sees only the `ServerStream`.
- **`UnaryClientInterceptor`** — wraps an outgoing unary call; runs **once per attempt**, so retries invoke it repeatedly.
- **`StreamClientInterceptor`** — wraps stream creation; returns a (possibly wrapped) `ClientStream`.
- **`grpc.ChainUnaryInterceptor` / `ChainStreamInterceptor`** — compose several; always use these rather than the singular forms.
- **Outside-in ordering** — the first interceptor in the chain is outermost.
- **`UnaryServerInfo.FullMethod`** — `/acme.inventory.v1.InventoryService/GetItem`; the label for metrics and the key for per-method policy.
- **Stream wrapping** — embedding `grpc.ServerStream` and overriding `Context`, `RecvMsg` or `SendMsg`.
- **`grpc.NewContextWithServerTransportStream`** — required if an interceptor needs `SetHeader` to work.
- **`go-grpc-middleware/v2`** — the community library of ready-made interceptors.
- **`StatsHandler`** — the lower-level alternative for observability, with per-message granularity (chapter 26).

## 3. Theory & Principles

### Ordering is outside-in, and it matters

```go
grpc.ChainUnaryInterceptor(recovery, tracing, logging, metrics, auth, ratelimit, validate)
```

executes as:

```
recovery ─► tracing ─► logging ─► metrics ─► auth ─► ratelimit ─► validate ─► handler
   ▲                                                                              │
   └──────────────────── response travels back out ◄──────────────────────────────┘
```

The canonical order and the reason for each position:

1. **Recovery — first.** It must catch panics from *every* interceptor after it, not just from the handler. Placing it second means a panic in tracing kills the process.
2. **Tracing — second.** The span must cover everything, so all downstream work is attributed to it. It also injects the trace id into the context that logging will use.
3. **Logging — third.** Sees the final status, including anything auth or validation rejected, and can log the trace id.
4. **Metrics — fourth.** Observes the status code as it leaves, so `InvalidArgument` from validation appears in the histogram.
5. **Auth — fifth.** After observability (so rejections are visible) but before any expensive work.
6. **Rate limiting — sixth.** After auth, so limits can be per-principal rather than per-IP.
7. **Validation — last before the handler.** Cheapest to run, and pointless before the caller is known.

Two orderings people get wrong. Putting **auth before logging** means unauthenticated rejections are invisible in your logs — exactly the events you most want to see. Putting **rate limiting before auth** means you can only limit by IP, which is useless behind a load balancer.

### Unary and stream are different problems

A unary interceptor gets `req any` and returns `resp any`. A stream interceptor gets a `ServerStream` and nothing else. To observe messages you must wrap:

```go
type wrappedServerStream struct {
    grpc.ServerStream           // embed: everything not overridden is forwarded
    ctx      context.Context    // our modified context
    recvCount int
}

func (w *wrappedServerStream) Context() context.Context { return w.ctx }

func (w *wrappedServerStream) RecvMsg(m any) error {
    err := w.ServerStream.RecvMsg(m)
    if err == nil { w.recvCount++ }
    return err
}
```

The embedding is what makes this manageable: override only what you need and every other method is forwarded. The critical override is **`Context()`** — a stream interceptor cannot replace the context by returning it, so injecting a principal or a trace id means wrapping and overriding `Context()`.

Note also that stream interceptors run **once, at stream creation**. Anything you want per message must live in the `RecvMsg`/`SendMsg` overrides.

### Client interceptors run per attempt

A `UnaryClientInterceptor` is invoked once for each *attempt*, so with a retry policy of three attempts it runs three times for one logical call. That is exactly what you want for measuring attempts (chapter 21) and exactly wrong for anything that must happen once — generating an idempotency key, for instance, must happen before the call, not inside the interceptor.

```svg
<svg viewBox="0 0 880 500" width="100%" height="500" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="ic1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="ic2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Chain ordering is outside-in &#8212; and every position has a reason</text>

  <rect x="30" y="42" width="796" height="46" rx="8" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="52" y="70" fill="#b91c1c" font-size="11" font-weight="bold">1. recovery</text>
  <text x="170" y="70" fill="#991b1b" font-size="10">FIRST, always &#8212; it must catch panics from every interceptor after it, not just the handler</text>

  <rect x="60" y="94" width="736" height="46" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="82" y="122" fill="#5b21b6" font-size="11" font-weight="bold">2. tracing</text>
  <text x="200" y="122" fill="#6d28d9" font-size="10">the span must cover everything below; injects the trace id logging will use</text>

  <rect x="90" y="146" width="676" height="46" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="112" y="174" fill="#1e40af" font-size="11" font-weight="bold">3. logging</text>
  <text x="230" y="174" fill="#1d4ed8" font-size="10">sees the FINAL status, including auth and validation rejections</text>

  <rect x="120" y="198" width="616" height="46" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="142" y="226" fill="#15803d" font-size="11" font-weight="bold">4. metrics</text>
  <text x="260" y="226" fill="#166534" font-size="10">observes the code as it leaves, so InvalidArgument lands in the histogram</text>

  <rect x="150" y="250" width="556" height="46" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="172" y="278" fill="#92400e" font-size="11" font-weight="bold">5. auth</text>
  <text x="290" y="278" fill="#b45309" font-size="10">AFTER observability (rejections stay visible), BEFORE expensive work</text>

  <rect x="180" y="302" width="496" height="46" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="202" y="330" fill="#92400e" font-size="11" font-weight="bold">6. rate limit</text>
  <text x="320" y="330" fill="#b45309" font-size="10">AFTER auth, so limits can be per-principal rather than per-IP</text>

  <rect x="210" y="354" width="436" height="46" rx="8" fill="#e0e7ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="232" y="382" fill="#3730a3" font-size="11" font-weight="bold">7. validate</text>
  <text x="350" y="382" fill="#4338ca" font-size="10">cheapest; pointless before the caller is known</text>

  <rect x="240" y="406" width="376" height="40" rx="8" fill="#f1f5f9" stroke="#64748b" stroke-width="2"/>
  <text x="428" y="431" text-anchor="middle" fill="#334155" font-size="11" font-weight="bold">handler</text>

  <path d="M700,375 L700,80" stroke="#16a34a" stroke-width="2" marker-end="url(#ic2)"/>
  <text x="740" y="230" fill="#15803d" font-size="10" font-weight="bold">response travels</text>
  <text x="740" y="246" fill="#15803d" font-size="10" font-weight="bold">back OUT</text>

  <rect x="30" y="458" width="796" height="36" rx="8" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="50" y="474" fill="#991b1b" font-size="10">Two orderings people get wrong: auth BEFORE logging &#8594; unauthenticated rejections are invisible in logs.</text>
  <text x="50" y="490" fill="#991b1b" font-size="10">Rate limit BEFORE auth &#8594; you can only limit by IP, which is useless behind a load balancer.</text>
</svg>
```

## 4. Architecture & Workflow

**Writing an interceptor**, in order:

1. **Decide unary, stream, or both.** Almost always both — anything security-related must cover streams or streaming methods are unprotected.
2. **Write the unary version**, which is the simpler shape.
3. **Write the stream version**, wrapping `grpc.ServerStream` when you need to change the context or observe messages.
4. **Return a `status` error** on rejection, never a raw error.
5. **Handle panics** — or rely on the recovery interceptor being first.
6. **Register with the `Chain` variants** in the canonical order.

**Interceptor or `StatsHandler`?** Interceptors wrap the *call* and can modify the request, response and error. `StatsHandler` receives lifecycle events — connection begin/end, RPC begin/end, per-message in/out payloads with byte counts — and cannot modify anything. Use interceptors for logic (auth, validation, error mapping) and a `StatsHandler` for observability that needs per-message or byte-level granularity, which is exactly what the OpenTelemetry instrumentation does (chapter 26).

```svg
<svg viewBox="0 0 880 440" width="100%" height="440" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="ws1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#0ea5e9"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Unary vs stream: why streams need wrapping</text>

  <rect x="24" y="42" width="410" height="176" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="229" y="64" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">Unary &#8212; the easy shape</text>
  <g font-family="ui-monospace,monospace" font-size="10" fill="#1d4ed8">
    <text x="42" y="90">func(ctx, req any, info, handler) (any, error) {</text>
    <text x="42" y="108">    ctx = context.WithValue(ctx, k, v)   // just do it</text>
    <text x="42" y="126">    resp, err := handler(ctx, req)</text>
    <text x="42" y="144">    // req AND resp are both visible here</text>
    <text x="42" y="162">    return resp, err</text>
    <text x="42" y="180">}</text>
  </g>
  <text x="42" y="206" fill="#1e40af" font-size="10" font-weight="bold">The context is a parameter, so replacing it is trivial.</text>

  <rect x="446" y="42" width="410" height="176" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="651" y="64" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">Stream &#8212; you must WRAP</text>
  <g font-family="ui-monospace,monospace" font-size="10" fill="#6d28d9">
    <text x="464" y="90">func(srv any, ss ServerStream, info, handler) error {</text>
    <text x="464" y="108">    // NO ctx parameter. NO req. NO resp.</text>
    <text x="464" y="126">    ctx := ss.Context()</text>
    <text x="464" y="144">    ctx = context.WithValue(ctx, k, v)</text>
    <text x="464" y="162">    return handler(srv, &amp;wrapped{ss, ctx})</text>
    <text x="464" y="180">}</text>
  </g>
  <text x="464" y="206" fill="#5b21b6" font-size="10" font-weight="bold">Override Context() &#8212; there is no other way to inject.</text>

  <rect x="24" y="236" width="832" height="196" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="258" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">The wrapper: embed, then override only what you need</text>

  <rect x="48" y="274" width="380" height="140" rx="8" fill="#fff" stroke="#94a3b8"/>
  <g font-family="ui-monospace,monospace" font-size="10" fill="#334155">
    <text x="62" y="296">type wrapped struct {</text>
    <text x="62" y="314">    grpc.ServerStream    &#8592; EMBED: forwards everything</text>
    <text x="62" y="332">    ctx context.Context</text>
    <text x="62" y="350">    recv, sent int</text>
    <text x="62" y="368">}</text>
    <text x="62" y="390">func (w *wrapped) Context() context.Context {</text>
    <text x="62" y="406">    return w.ctx }</text>
  </g>

  <path d="M434,344 L470,344" stroke="#0ea5e9" stroke-width="2" marker-end="url(#ws1)"/>

  <rect x="476" y="274" width="356" height="140" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="654" y="296" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">What each override buys</text>
  <text x="492" y="320" fill="#166534" font-size="10">Context()  &#8594; inject a principal, trace id, logger</text>
  <text x="492" y="340" fill="#166534" font-size="10">RecvMsg()  &#8594; count / validate / authorize per message</text>
  <text x="492" y="360" fill="#166534" font-size="10">SendMsg()  &#8594; count / redact / transform per message</text>
  <text x="492" y="386" fill="#b91c1c" font-size="10" font-weight="bold">Stream interceptors run ONCE, at stream creation.</text>
  <text x="492" y="404" fill="#991b1b" font-size="10">Anything per-message MUST live in these overrides.</text>
</svg>
```

## 5. Implementation

### Recovery — always first

```go
package interceptors

import (
	"context"
	"fmt"
	"log/slog"
	"runtime/debug"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Recovery converts a panic into codes.Internal instead of killing the process.
//
// It MUST be first in the chain: a panic in the tracing or auth interceptor is
// just as fatal as one in a handler, and only an outer recovery catches it.
func Recovery(log *slog.Logger) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler) (resp any, err error) {

		defer func() {
			if r := recover(); r != nil {
				// Log the stack. NEVER send it to the client: it discloses
				// file paths, package layout and often data values.
				log.ErrorContext(ctx, "panic recovered",
					"method", info.FullMethod,
					"panic", r,
					"stack", string(debug.Stack()))

				// Named return values are what let a deferred function
				// replace the result. Without them this recovery would log
				// and then still crash.
				err = status.Error(codes.Internal, "internal error")
				resp = nil
			}
		}()

		return handler(ctx, req)
	}
}

// RecoveryStream is the stream counterpart. Writing only the unary version
// leaves every streaming method able to kill the process.
func RecoveryStream(log *slog.Logger) grpc.StreamServerInterceptor {
	return func(srv any, ss grpc.ServerStream, info *grpc.StreamServerInfo,
		handler grpc.StreamHandler) (err error) {

		defer func() {
			if r := recover(); r != nil {
				log.ErrorContext(ss.Context(), "panic recovered in stream",
					"method", info.FullMethod, "panic", r, "stack", string(debug.Stack()))
				err = status.Error(codes.Internal, "internal error")
			}
		}()

		return handler(srv, ss)
	}
}
```

### The stream wrapper

```go
// wrappedServerStream lets a stream interceptor do what a unary one gets for
// free: replace the context, and observe individual messages.
//
// Embedding grpc.ServerStream forwards every method we do not override, so
// this stays small even though ServerStream has several methods.
type wrappedServerStream struct {
	grpc.ServerStream

	ctx       context.Context
	recvCount int
	sentCount int
}

// Context is THE override that matters: a stream interceptor has no other way
// to inject a value, because it cannot return a context.
func (w *wrappedServerStream) Context() context.Context { return w.ctx }

func (w *wrappedServerStream) RecvMsg(m any) error {
	err := w.ServerStream.RecvMsg(m)
	if err == nil {
		w.recvCount++
	}
	return err
}

func (w *wrappedServerStream) SendMsg(m any) error {
	err := w.ServerStream.SendMsg(m)
	if err == nil {
		w.sentCount++
	}
	return err
}

func wrapStream(ss grpc.ServerStream, ctx context.Context) *wrappedServerStream {
	// Do not double-wrap: preserve counters if an outer interceptor already did.
	if w, ok := ss.(*wrappedServerStream); ok {
		w.ctx = ctx
		return w
	}
	return &wrappedServerStream{ServerStream: ss, ctx: ctx}
}
```

### Logging

```go
// Logging emits one structured line per call, with the final status code.
//
// Position 3 in the chain: after tracing (so it can log the trace id) and
// before auth (so rejected calls are still logged — those are exactly the
// events you most want to see).
func Logging(log *slog.Logger) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler) (any, error) {

		start := time.Now()
		resp, err := handler(ctx, req)
		code := status.Code(err)

		attrs := []any{
			"method", info.FullMethod,
			"code", code.String(),
			"duration_ms", time.Since(start).Milliseconds(),
		}
		if p, ok := peer.FromContext(ctx); ok {
			attrs = append(attrs, "peer", p.Addr.String())
		}
		if pr, ok := PrincipalFromContext(ctx); ok {
			attrs = append(attrs, "principal", pr.ID)
		}
		if err != nil {
			// The full error server-side; the client already got a safe version.
			attrs = append(attrs, "err", err.Error())
		}

		// Severity by class, so dashboards and alerts can key on level:
		// Internal is our bug, InvalidArgument is the caller's.
		switch code {
		case codes.OK:
			log.InfoContext(ctx, "rpc", attrs...)
		case codes.Internal, codes.Unknown, codes.DataLoss:
			log.ErrorContext(ctx, "rpc", attrs...)
		default:
			log.WarnContext(ctx, "rpc", attrs...)
		}
		return resp, err
	}
}

func LoggingStream(log *slog.Logger) grpc.StreamServerInterceptor {
	return func(srv any, ss grpc.ServerStream, info *grpc.StreamServerInfo,
		handler grpc.StreamHandler) error {

		start := time.Now()
		w := wrapStream(ss, ss.Context())

		err := handler(srv, w)

		// Message counts are the streaming-specific signal: a stream that ran
		// for 20 minutes and sent 3 messages is very different from one that
		// sent 300,000, and duration alone cannot tell them apart.
		log.InfoContext(ss.Context(), "stream",
			"method", info.FullMethod,
			"code", status.Code(err).String(),
			"duration_ms", time.Since(start).Milliseconds(),
			"msgs_received", w.recvCount,
			"msgs_sent", w.sentCount,
		)
		return err
	}
}
```

### Metrics

```go
type Metrics struct {
	requests      *prometheus.CounterVec
	duration      *prometheus.HistogramVec
	activeStreams *prometheus.GaugeVec
	streamMsgs    *prometheus.CounterVec
}

func (m *Metrics) Unary() grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler) (any, error) {

		// FullMethod is "/pkg.Service/Method"; split it so dashboards can
		// group by service and by method independently.
		service, method := splitMethod(info.FullMethod)

		start := time.Now()
		resp, err := handler(ctx, req)
		code := status.Code(err).String()

		m.requests.WithLabelValues(service, method, code).Inc()
		m.duration.WithLabelValues(service, method, code).Observe(time.Since(start).Seconds())
		return resp, err
	}
}

func (m *Metrics) Stream() grpc.StreamServerInterceptor {
	return func(srv any, ss grpc.ServerStream, info *grpc.StreamServerInfo,
		handler grpc.StreamHandler) error {

		service, method := splitMethod(info.FullMethod)

		// Active streams is the gauge unary metrics cannot give you: rising
		// while message rate is flat means streams are stuck (chapter 16).
		m.activeStreams.WithLabelValues(service, method).Inc()
		defer m.activeStreams.WithLabelValues(service, method).Dec()

		start := time.Now()
		w := wrapStream(ss, ss.Context())
		err := handler(srv, w)
		code := status.Code(err).String()

		m.requests.WithLabelValues(service, method, code).Inc()
		m.duration.WithLabelValues(service, method, code).Observe(time.Since(start).Seconds())
		m.streamMsgs.WithLabelValues(service, method, "received").Add(float64(w.recvCount))
		m.streamMsgs.WithLabelValues(service, method, "sent").Add(float64(w.sentCount))
		return err
	}
}
```

### Authentication and per-method authorization

```go
// methodPolicy declares, per fully-qualified method, what is required.
// Declaring it as DATA means a new method that is not listed is denied by
// default — fail closed, not fail open.
type methodPolicy struct {
	Public bool     // no authentication at all
	Scopes []string // required scopes when not public
}

var policies = map[string]methodPolicy{
	"/grpc.health.v1.Health/Check":                             {Public: true},
	"/acme.inventory.v1.InventoryService/GetItem":              {Scopes: []string{"inventory:read"}},
	"/acme.inventory.v1.InventoryService/ListItems":            {Scopes: []string{"inventory:read"}},
	"/acme.inventory.v1.InventoryService/UpdateItem":           {Scopes: []string{"inventory:write"}},
	"/acme.inventory.v1.InventoryService/ReserveStock":         {Scopes: []string{"inventory:reserve"}},
	"/acme.inventory.v1.InventoryService/WatchStock":           {Scopes: []string{"inventory:read"}},
	"/acme.inventory.v1.InventoryService/BulkAdjustStock":      {Scopes: []string{"inventory:write"}},
	"/acme.inventory.v1.InventoryService/SyncInventory":        {Scopes: []string{"inventory:write"}},
}

// authenticate is shared by both interceptor shapes, so unary and streaming
// methods cannot diverge in what they enforce.
func authenticate(ctx context.Context, v TokenVerifier, fullMethod string) (context.Context, error) {
	policy, known := policies[fullMethod]
	if !known {
		// FAIL CLOSED. A method added without a policy entry is denied, not
		// exposed. This is the single most valuable line in the file.
		return nil, status.Errorf(codes.PermissionDenied,
			"no authorization policy declared for %s", fullMethod)
	}
	if policy.Public {
		return ctx, nil
	}

	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return nil, status.Error(codes.Unauthenticated, "missing metadata")
	}
	values := md.Get("authorization")
	if len(values) == 0 {
		return nil, status.Error(codes.Unauthenticated, "missing authorization header")
	}

	token, found := strings.CutPrefix(values[0], "Bearer ")
	if !found {
		return nil, status.Error(codes.Unauthenticated, "expected a Bearer token")
	}

	principal, err := v.Verify(ctx, token)
	if err != nil {
		// Never echo the verification error: it discloses key ids, issuer
		// URLs and clock-skew details.
		return nil, status.Error(codes.Unauthenticated, "invalid token")
	}

	for _, required := range policy.Scopes {
		if !principal.HasScope(required) {
			// PermissionDenied, not Unauthenticated: the identity is valid,
			// the rights are not, and only one of those is fixed by a refresh.
			return nil, status.Errorf(codes.PermissionDenied,
				"missing required scope %q", required)
		}
	}

	return ContextWithPrincipal(ctx, principal), nil
}

func Auth(v TokenVerifier) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler) (any, error) {

		ctx, err := authenticate(ctx, v, info.FullMethod)
		if err != nil {
			return nil, err
		}
		return handler(ctx, req)
	}
}

func AuthStream(v TokenVerifier) grpc.StreamServerInterceptor {
	return func(srv any, ss grpc.ServerStream, info *grpc.StreamServerInfo,
		handler grpc.StreamHandler) error {

		ctx, err := authenticate(ss.Context(), v, info.FullMethod)
		if err != nil {
			return err
		}
		// The ONLY way to make the principal visible to a streaming handler:
		// wrap the stream and override Context().
		return handler(srv, wrapStream(ss, ctx))
	}
}
```

### Rate limiting, per principal

```go
// RateLimit runs AFTER auth so it can key on the principal. Before auth, the
// only key available is the peer address, which behind a load balancer is the
// load balancer.
func RateLimit(limiter Limiter) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler) (any, error) {

		key := "anonymous"
		if p, ok := PrincipalFromContext(ctx); ok {
			key = p.ID
		}

		allowed, retryAfter := limiter.Allow(key, info.FullMethod)
		if !allowed {
			// Tell the client exactly when to come back (chapter 22). Far
			// better than leaving it to its own backoff guess.
			st := status.New(codes.ResourceExhausted, "rate limit exceeded")
			if d, err := st.WithDetails(
				&errdetails.RetryInfo{RetryDelay: durationpb.New(retryAfter)},
				&errdetails.QuotaFailure{Violations: []*errdetails.QuotaFailure_Violation{{
					Subject:     key,
					Description: "per-principal rate limit for " + info.FullMethod,
				}}},
			); err == nil {
				st = d
			}
			return nil, st.Err()
		}
		return handler(ctx, req)
	}
}
```

### Client interceptors

```go
// ClientMetadata attaches request id and trace context to every outgoing call.
//
// IMPORTANT: a unary client interceptor runs ONCE PER ATTEMPT, so with a retry
// policy of 3 it runs three times for one logical call. That makes it correct
// for counting attempts and WRONG for anything that must happen once — an
// idempotency key must be generated before the call, not here, or each retry
// gets a different key and defeats the deduplication entirely.
func ClientMetadata(serviceName string) grpc.UnaryClientInterceptor {
	return func(ctx context.Context, method string, req, reply any,
		cc *grpc.ClientConn, invoker grpc.UnaryInvoker, opts ...grpc.CallOption) error {

		ctx = metadata.AppendToOutgoingContext(ctx,
			"x-request-id", requestIDFrom(ctx),
			"x-caller-service", serviceName,
		)
		return invoker(ctx, method, req, reply, cc, opts...)
	}
}

// ClientMetrics measures per-attempt latency and outcome. The ratio of this
// counter to logical calls is how you detect a retry storm (chapter 21).
func ClientMetrics(m *ClientMetricSet) grpc.UnaryClientInterceptor {
	return func(ctx context.Context, method string, req, reply any,
		cc *grpc.ClientConn, invoker grpc.UnaryInvoker, opts ...grpc.CallOption) error {

		start := time.Now()
		err := invoker(ctx, method, req, reply, cc, opts...)

		m.Attempts.WithLabelValues(method, status.Code(err).String()).Inc()
		m.Duration.WithLabelValues(method).Observe(time.Since(start).Seconds())
		return err
	}
}

// ClientStreamLogging wraps stream creation. Note it returns a ClientStream,
// so to observe messages you wrap it exactly as on the server side.
func ClientStreamLogging(log *slog.Logger) grpc.StreamClientInterceptor {
	return func(ctx context.Context, desc *grpc.StreamDesc, cc *grpc.ClientConn,
		method string, streamer grpc.Streamer, opts ...grpc.CallOption) (grpc.ClientStream, error) {

		start := time.Now()
		cs, err := streamer(ctx, desc, cc, method, opts...)
		if err != nil {
			log.ErrorContext(ctx, "stream create failed", "method", method, "err", err)
			return nil, err
		}

		log.InfoContext(ctx, "stream opened", "method", method,
			"setup_ms", time.Since(start).Milliseconds())

		return &loggingClientStream{ClientStream: cs, log: log, method: method, start: start}, nil
	}
}

type loggingClientStream struct {
	grpc.ClientStream
	log    *slog.Logger
	method string
	start  time.Time
	recv   int
}

func (l *loggingClientStream) RecvMsg(m any) error {
	err := l.ClientStream.RecvMsg(m)
	switch {
	case err == nil:
		l.recv++
	case errors.Is(err, io.EOF):
		// Clean end of stream — success, not a failure (chapter 20).
		l.log.Info("stream complete", "method", l.method,
			"received", l.recv, "duration_ms", time.Since(l.start).Milliseconds())
	default:
		l.log.Error("stream failed", "method", l.method,
			"received", l.recv, "err", err)
	}
	return err
}
```

### Registering the chain

```go
srv := grpc.NewServer(
	// ALWAYS the Chain variants. grpc.UnaryInterceptor is singular and a
	// second call silently REPLACES the first (chapter 14).
	grpc.ChainUnaryInterceptor(
		interceptors.Recovery(log),      // 1 — must catch panics from all below
		otelgrpc.UnaryServerInterceptor, // 2 — the span covers everything
		interceptors.Logging(log),       // 3 — sees the final status
		metrics.Unary(),                 // 4 — observes the code as it leaves
		interceptors.Auth(verifier),     // 5 — after observability, before work
		interceptors.RateLimit(limiter), // 6 — after auth, so per-principal
		interceptors.Validate(validator),// 7 — cheapest, last before the handler
	),
	grpc.ChainStreamInterceptor(
		interceptors.RecoveryStream(log),
		otelgrpc.StreamServerInterceptor,
		interceptors.LoggingStream(log),
		metrics.Stream(),
		interceptors.AuthStream(verifier),
	),
)

conn, err := grpc.NewClient(target,
	grpc.WithChainUnaryInterceptor(
		interceptors.ClientMetadata("orders"),
		interceptors.ClientMetrics(clientMetrics),
	),
	grpc.WithChainStreamInterceptor(
		interceptors.ClientStreamLogging(log),
	),
)
```

### Setting headers from an interceptor

```go
// An interceptor that wants grpc.SetHeader to work must ensure the context
// carries a ServerTransportStream. In a normal chain it already does; when
// testing an interceptor in isolation it does not, and SetHeader silently
// fails — a genuinely confusing debugging session.
func ResponseHeaders(version string) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler) (any, error) {

		if err := grpc.SetHeader(ctx, metadata.Pairs("x-server-version", version)); err != nil {
			// Non-fatal: log it rather than failing the call over a header.
			slog.Warn("SetHeader failed", "err", err, "method", info.FullMethod)
		}
		return handler(ctx, req)
	}
}
```

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Impossible to forget.** A new method inherits auth, validation, logging and metrics automatically — the property that makes interceptors the right home for security.
- **Uniform behaviour** across every method, so one dashboard and one retry policy work everywhere.
- **Composable and testable.** Each is a small function; the chain is a list.
- **Client and server symmetry** means the same concerns can be handled at either end.
- **A rich ecosystem** — `go-grpc-middleware/v2`, `otelgrpc` — so most of these are off the shelf.

**Disadvantages**
- **Four signatures**, and forgetting the stream variants silently leaves streaming methods unprotected.
- **Stream wrapping is boilerplate**, and double-wrapping loses state if not handled.
- **Ordering is implicit** — nothing warns you that recovery is third.
- **Debugging is indirect**: a stack trace runs through several closures before reaching your handler.
- **Per-call overhead** is small but real; a chain of ten adds measurable latency at very high QPS.

**Trade-offs**
- *Interceptor vs handler code:* interceptors give uniformity and cannot be forgotten; handler code is explicit and easier to trace. Cross-cutting concerns belong in interceptors, business rules do not.
- *Interceptor vs `StatsHandler`:* interceptors can modify the call; stats handlers see per-message and byte-level events but cannot change anything. Use both — logic in interceptors, telemetry in a stats handler.
- *Fine-grained vs coarse chains:* many small interceptors are testable and composable but multiply overhead and stack depth; one large one is faster and harder to reason about. Prefer small until measurement says otherwise.

## 7. Common Mistakes & Best Practices

- **Writing the unary interceptor and forgetting the stream one.** Streaming methods are then unauthenticated, unlogged and unmetered.
- **Recovery not first.** A panic in tracing or auth kills the process.
- **`grpc.UnaryInterceptor` instead of `ChainUnaryInterceptor`.** The second call silently replaces the first.
- **Auth before logging.** Rejections become invisible — exactly the events you want to see.
- **Rate limiting before auth.** You can only key on IP, which behind a load balancer is the load balancer.
- **Not overriding `Context()` in the stream wrapper.** Values injected by the interceptor never reach the handler.
- **Double-wrapping streams** without preserving counters, so message counts reset.
- **Returning a raw error from an interceptor.** It becomes `codes.Unknown` (chapter 22).
- **Fail-open authorization.** A method missing from the policy map must be denied, not exposed.
- **Echoing token-verification errors.** They disclose key ids, issuer URLs and clock skew.
- **Missing named return values in the recovery `defer`.** The deferred function then cannot replace the error, and the panic still crashes the call.
- **Heavy work in an interceptor.** It runs on every call; a synchronous network lookup there multiplies your latency.
- **Assuming a client interceptor runs once.** It runs per attempt, so retries invoke it repeatedly.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** When something in the chain misbehaves, bisect by removing interceptors — the chain is a slice, so this is fast. `grpc.SetHeader` failing silently in a unit test almost always means the context lacks a `ServerTransportStream`; use `grpc.NewContextWithServerTransportStream` in the test.
- **Monitoring.** The interceptor layer is where per-method rate, error-by-code, latency and active-stream metrics come from, so its correctness determines whether you can see anything at all. Add a metric for interceptor-level rejections (auth, rate limit, validation) separately from handler errors — they have different causes and different owners.
- **Security.** Auth and authorization belong here precisely because they cannot be forgotten, but only if the stream variants exist and the policy map fails closed. Add a test that enumerates every registered method via reflection and asserts each has a policy entry — that test catches the Friday-afternoon method that would otherwise be public.
- **Scaling.** Chains run per call, so keep them cheap: no synchronous network calls, cache token verification keys, and prefer sampling for expensive telemetry. At very high QPS, measure the chain's own overhead — ten interceptors at 10 µs each is 100 µs on every request, which is significant on a 1 ms method.

## 9. Interview Questions

**Q: What are the four interceptor types and why does it matter?**
A: `UnaryServerInterceptor`, `StreamServerInterceptor`, `UnaryClientInterceptor` and `StreamClientInterceptor`. It matters because unary and stream are genuinely different problems: a unary interceptor receives the request and returns the response, while a stream interceptor receives only the stream object and must wrap it to change the context or observe messages. The common failure is implementing the unary version of auth or metrics and forgetting the stream version, which leaves every streaming method unauthenticated and unmonitored — silently.

**Q: What order should server interceptors run in, and why?**
A: Recovery, tracing, logging, metrics, auth, rate limiting, validation. Recovery is first because it must catch panics from every interceptor after it, not just the handler. Tracing is second so the span covers everything and injects a trace id that logging can use. Logging and metrics come before auth so rejected calls are still observed — those are exactly the events you want visible. Rate limiting comes after auth so it can key on the principal rather than on an IP that behind a load balancer is the load balancer. Validation is last because it is cheapest and pointless before the caller is known.

**Q: How does a stream interceptor inject a value into the context?**
A: By wrapping. A stream interceptor has no context parameter and cannot return one, so it defines a struct embedding `grpc.ServerStream`, stores the modified context, overrides `Context()` to return it, and passes the wrapper to the handler. Embedding forwards every method it does not override, so the wrapper stays small. The same technique with `RecvMsg` and `SendMsg` overrides is how you count, validate or redact individual messages — which matters because a stream interceptor itself runs only once, at stream creation.

**Q: Why must recovery be first?**
A: Because a panic anywhere in the chain is fatal, not just a panic in the handler. If recovery sits third, a nil-pointer dereference in the tracing or logging interceptor takes down the whole process rather than failing one RPC. Being outermost means it wraps everything. The implementation detail that goes with it is named return values on the interceptor function — without them a deferred `recover` can log the panic but cannot replace the returned error, so the call still fails abnormally.

**Q: What is the difference between an interceptor and a `StatsHandler`?**
A: An interceptor wraps the call and can modify the context, the request, the response and the error — so it is the right place for logic: auth, validation, error mapping, rate limiting. A `StatsHandler` receives lifecycle events — connection begin and end, RPC begin and end, per-message payloads with byte counts — and cannot modify anything, so it is the right place for telemetry needing per-message or byte-level granularity. That is exactly what the OpenTelemetry gRPC instrumentation uses. Most production servers run both.

**Q: How many times does a client interceptor run for one call?**
A: Once per attempt. With a retry policy of three attempts it runs three times for one logical call, which is exactly what you want for measuring attempts — the ratio of attempts to logical calls is how you detect a retry storm. It is exactly wrong for anything that must happen once: generating an idempotency key inside a client interceptor gives each retry a different key and defeats the server's deduplication entirely, so that must happen before the call.

**Q: How do you make authorization impossible to forget?**
A: Put it in an interceptor, implement both the unary and stream variants sharing one function, and declare the policy as data keyed by fully-qualified method — then **fail closed** when a method is not in the map. A method added without a policy entry is denied, not exposed. On top of that I add a test that enumerates every registered method through the server's service info and asserts each has a policy entry, which catches the method someone added on a Friday afternoon before it ships rather than after.

**Q: (Senior) Design the interceptor stack for a production service.**
A: Server side, in order: recovery first so it catches panics from everything below; OpenTelemetry tracing so the span covers all subsequent work and the trace id is available to logging; structured logging emitting method, code, duration, principal and peer with severity chosen by code class; metrics recording rate, error-by-code, latency and — for streams — active count and message counts; authentication and per-method authorization driven by a fail-closed policy map, sharing one function between the unary and stream variants; per-principal rate limiting returning `ResourceExhausted` with `RetryInfo`; and finally schema validation via `protovalidate`, converting violations into `BadRequest` details. Every one of those has a stream counterpart, and I would add a reflection-driven test asserting policy coverage. Client side: metadata propagation for request id and caller identity, and per-attempt metrics — remembering that these run per attempt, so anything that must happen once belongs at the call site. I would also run a `StatsHandler` alongside for byte-level telemetry, since interceptors cannot see message sizes.

**Q: (Senior) A streaming method is unauthenticated in production. How did that happen and how do you prevent it?**
A: Almost certainly because only the unary interceptor was written. `ChainUnaryInterceptor` and `ChainStreamInterceptor` are separate lists, and adding an auth interceptor to the first does nothing for streaming methods — there is no warning, no compile error, and the method works fine in testing because tests usually pass a valid token anyway. The second possibility is that the stream interceptor exists but does not wrap the stream, so the principal it computed never reaches the handler, and the handler's authorization check reads an empty context and — if it fails open — permits everything. Prevention is layered: share one `authenticate` function between both interceptor shapes so they cannot diverge in logic; fail closed on an unknown method so a gap is a denial rather than an exposure; and write a test that walks `srv.GetServiceInfo()`, enumerates every method including streaming ones, and asserts each appears in the policy map and is rejected without credentials. That last test is the one that actually catches it, because it fails when someone adds a method rather than when someone remembers to check.

**Q: (Senior) What is the performance cost of an interceptor chain, and when does it matter?**
A: Each interceptor is a closure call plus whatever work it does, so the fixed overhead is small — typically single-digit microseconds for a well-written one. It matters in two situations. First, at very high QPS on cheap methods: ten interceptors at 10 µs each is 100 µs, which is 10% of a 1 ms method and invisible on a 100 ms one. Second, and much more importantly, when an interceptor does something expensive per call — a synchronous token-introspection call to an auth server, an uncached JWKS fetch, a database lookup for a rate limit — because that turns a 1 ms method into a 20 ms one and couples your latency to a dependency the handler never touches. The fixes are the obvious ones: cache verification keys and introspection results with a TTL, use local token validation rather than a network round trip, keep rate-limit state in memory with async replication, and sample expensive telemetry rather than recording everything. I would measure the chain's own overhead with a no-op handler benchmark before optimising anything, because the assumed cost and the measured cost are usually different.

## 10. Quick Revision & Cheat Sheet

```go
// UNARY SERVER
func(ctx context.Context, req any, info *grpc.UnaryServerInfo,
     handler grpc.UnaryHandler) (any, error)

// STREAM SERVER — wrap to change the context or see messages
func(srv any, ss grpc.ServerStream, info *grpc.StreamServerInfo,
     handler grpc.StreamHandler) error

// UNARY CLIENT — runs ONCE PER ATTEMPT
func(ctx context.Context, method string, req, reply any, cc *grpc.ClientConn,
     invoker grpc.UnaryInvoker, opts ...grpc.CallOption) error

// STREAM CLIENT
func(ctx context.Context, desc *grpc.StreamDesc, cc *grpc.ClientConn, method string,
     streamer grpc.Streamer, opts ...grpc.CallOption) (grpc.ClientStream, error)

// The wrapper
type wrapped struct{ grpc.ServerStream; ctx context.Context }
func (w *wrapped) Context() context.Context { return w.ctx }
```

| Position | Interceptor | Why there |
|---|---|---|
| 1 | Recovery | Catches panics from everything below |
| 2 | Tracing | Span covers all; injects trace id |
| 3 | Logging | Sees the final status, including rejections |
| 4 | Metrics | Observes the code as it leaves |
| 5 | Auth | After observability, before expensive work |
| 6 | Rate limit | After auth → per-principal, not per-IP |
| 7 | Validation | Cheapest; last before the handler |

**Flash cards**
- **How many signatures?** → Four. Unary/stream × server/client.
- **Chain order?** → Outside-in; the first is outermost.
- **Recovery position?** → First, always. With named return values.
- **Injecting into a stream context?** → Wrap and override `Context()`.
- **`UnaryInterceptor` twice?** → The second silently replaces the first. Use `Chain…`.
- **Client interceptor runs?** → Once per attempt, not per call.
- **Unknown method in the policy map?** → Deny. Fail closed.

## 11. Hands-On Exercises & Mini Project

- [ ] Write recovery without named return values, panic in a handler, and observe that the call still fails abnormally. Add them and see it become `Internal`.
- [ ] Put recovery third in the chain, panic in the second interceptor, and watch the process die.
- [ ] Write an auth interceptor for unary only, then call a streaming method without a token and confirm it succeeds. Add the stream variant.
- [ ] Write a stream interceptor that injects a value without wrapping, and confirm the handler cannot see it. Add the `Context()` override.
- [ ] Swap logging and auth in the chain, send an unauthenticated request, and observe it vanish from the logs.
- [ ] Add a client interceptor counting invocations, enable a retry policy of three, and confirm it runs three times for one failing call.
- [ ] Write the reflection-driven test that enumerates `GetServiceInfo()` and asserts every method has a policy entry. Add a new RPC and watch it fail.
- [ ] Benchmark a no-op handler with zero, five and ten interceptors, and record the per-call overhead.

### Mini Project — "Production Middleware Stack"

**Goal.** Build a complete, tested interceptor stack with both unary and stream variants for every concern, and prove the properties that make it safe.

**Requirements.**
1. Recovery, tracing, logging, metrics, auth, rate limiting and validation — each with both a unary and a stream implementation, registered in the canonical order.
2. A reusable stream wrapper handling context replacement, message counting and double-wrap safety.
3. Authorization driven by a fail-closed policy map, with one `authenticate` function shared between the unary and stream paths.
4. A reflection-driven test asserting every registered method has a policy entry and is rejected without credentials.
5. Rate limiting keyed on principal, returning `ResourceExhausted` with `RetryInfo` and `QuotaFailure` details.
6. Validation converting `protovalidate` violations into `BadRequest` details.
7. Client interceptors for metadata propagation and per-attempt metrics, with a test proving the attempt counter matches the retry policy.
8. A benchmark reporting the chain's per-call overhead against a no-op handler.

**Extensions.**
- Add a `StatsHandler` alongside the interceptors and compare what each can observe, particularly message sizes.
- Add a per-message authorization override in `RecvMsg` so a stream authorised for one tenant cannot accept a message for another, with a test.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Build: The gRPC Server* (registering the chains), *The Error Model* (what interceptors return on rejection), *Build: Authentication with Metadata, JWT & mTLS* (the auth interceptor in depth), *Observability* (`StatsHandler` and OpenTelemetry), *Testing gRPC in Go* (testing interceptors in isolation).

- **grpc-go — interceptor documentation** — gRPC Authors · *Intermediate* · the four signatures, `ChainUnaryInterceptor`/`ChainStreamInterceptor`, and the ordering semantics. <https://pkg.go.dev/google.golang.org/grpc#UnaryServerInterceptor>
- **go-grpc-middleware v2** — grpc-ecosystem (open source) · *Intermediate* · production-quality recovery, logging, auth, retry, rate limiting and validation interceptors, plus the canonical stream-wrapper implementation. <https://github.com/grpc-ecosystem/go-grpc-middleware>
- **grpc-go examples — features/interceptor** — gRPC Authors · *Beginner* · minimal runnable examples of all four interceptor kinds. <https://github.com/grpc/grpc-go/tree/master/examples/features/interceptor>
- **grpc-go — stats handler package** — gRPC Authors · *Advanced* · the lower-level observability hook, with per-message and byte-level events interceptors cannot see. <https://pkg.go.dev/google.golang.org/grpc/stats>
- **OpenTelemetry Go — gRPC instrumentation** — OpenTelemetry · *Intermediate* · the reference tracing and metrics integration, and where it sits in the chain. <https://github.com/open-telemetry/opentelemetry-go-contrib/tree/main/instrumentation/google.golang.org/grpc/otelgrpc>
- **gRPC — Authentication guide** — grpc.io · *Intermediate* · metadata-based credentials and how they interact with interceptors. <https://grpc.io/docs/guides/auth/>
- **protovalidate** — Buf (open source) · *Intermediate* · schema-declared constraints, designed to be enforced by exactly this kind of interceptor. <https://github.com/bufbuild/protovalidate>
- **Google SRE Book — Handling Overload** — Google · *Advanced* · why rate limiting and load shedding belong at the boundary, keyed on identity rather than address. <https://sre.google/sre-book/handling-overload/>

---

*gRPC with Go Handbook — chapter 23.*
