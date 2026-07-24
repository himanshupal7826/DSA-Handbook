# 26 · Observability: OpenTelemetry Tracing, Metrics & Structured Logs

> **In one line:** gRPC gives you two instrumentation hooks — interceptors, which wrap the call, and stats handlers, which see per-message and byte-level events — and the discipline that makes them useful is one shared vocabulary: method, status code, and a trace id that appears in every log line.

---

## 1. Overview

A gRPC service that cannot answer "which method is slow, for which caller, and why" in under a minute is not production-ready, regardless of how well it is written. Observability is not an add-on here; it is the difference between a five-minute incident and a two-hour one.

Three signals, each answering a different question:

- **Metrics** answer *is something wrong, and how bad*. Rate, errors-by-code and duration per method — the RED method — plus streaming-specific gauges. Cheap, aggregated, alertable.
- **Traces** answer *where the time went* across service boundaries. One request produces one trace; each hop is a span; the slow hop is visible immediately.
- **Logs** answer *what exactly happened* for one request. Structured, with a trace id so a trace links to its logs and back.

The gRPC-specific part is that all three should use the **same labels**: `grpc.service`, `grpc.method`, `grpc.status_code`. When a dashboard, a trace and a log line all say `GetItem` and `FailedPrecondition`, correlation is trivial. When one says `/acme.inventory.v1.InventoryService/GetItem` and another says `getItem`, it is not.

The other gRPC-specific part is **streaming**. Unary metrics — rate, errors, duration — are meaningless for a 30-minute stream. You need active streams, messages per stream, and time-since-last-message, or a stuck stream is invisible.

## 2. Core Concepts

- **RED** — Rate, Errors, Duration. The minimum per-method metric set.
- **`StatsHandler`** — `google.golang.org/grpc/stats`; receives connection and RPC lifecycle events including per-message payloads with byte counts. Cannot modify anything.
- **Interceptor** — wraps the call; can modify context, request, response and error (chapter 23).
- **OpenTelemetry** — the vendor-neutral standard for traces, metrics and logs; `otelgrpc` is the gRPC instrumentation.
- **`otelgrpc.NewServerHandler()` / `NewClientHandler()`** — the modern stats-handler-based instrumentation, replacing the deprecated interceptor form.
- **Span** — one operation in a trace, with a name, duration, attributes and status.
- **Trace context propagation** — `traceparent` in metadata (W3C Trace Context), carried automatically by `otelgrpc`.
- **Exemplars** — links from a metric bucket to a specific trace, turning "p99 is bad" into "here is a slow request".
- **Cardinality** — the number of distinct label combinations. The thing that kills metric backends.
- **`slog`** — Go's structured logger; `slog.Handler` can inject the trace id automatically.
- **Sampling** — recording a fraction of traces to bound cost, ideally tail-based so errors are always kept.

## 3. Theory & Principles

### Interceptor or stats handler?

| | Interceptor | `StatsHandler` |
|---|---|---|
| Sees the request/response values | Yes | Only as payloads, with sizes |
| Can modify the call | Yes | No |
| Per-message events on streams | Only via wrapping | Yes, natively |
| Byte counts (wire and uncompressed) | No | Yes |
| Connection-level events | No | Yes |
| Runs per attempt (client) | Yes | Yes |

The rule: **logic in interceptors, telemetry in stats handlers.** Auth, validation and error mapping must be able to reject a call, so they are interceptors. Tracing and metrics want per-message and byte-level granularity, so they are stats handlers — which is exactly why `otelgrpc` moved from interceptors to `NewServerHandler`/`NewClientHandler`.

Structured logging is the exception that stays an interceptor, because it wants the final status and the principal that earlier interceptors put in the context.

### The metric set that actually matters

**Unary and general:**

| Metric | Type | Labels | Answers |
|---|---|---|---|
| `rpc.server.duration` | histogram | service, method, code | Latency distribution |
| `rpc.server.requests` | counter | service, method, code | Rate and error rate |
| `rpc.server.request.size` | histogram | service, method | Payload growth toward limits |
| `rpc.server.response.size` | histogram | service, method | Same, outbound |

**Streaming — the ones unary metrics cannot give you:**

| Metric | Type | Answers |
|---|---|---|
| `rpc.server.active_streams` | gauge | Are streams accumulating? |
| `rpc.server.stream.messages` | counter | Throughput per direction |
| `rpc.server.stream.duration` | histogram | Are lifetime caps working? |
| `rpc.server.stream.idle_seconds` | histogram | Stuck streams |

The diagnostic pattern worth memorising: **active streams rising while message rate is flat means streams are stuck** — usually a blocked `Send` under flow control (chapter 16), a missing lifetime cap, or clients that vanished without a TCP FIN.

**Client-side, one metric matters disproportionately:** the ratio of RPC *attempts* to logical calls. A client interceptor runs once per attempt (chapter 23), so counting there exposes a retry storm forming, which is otherwise indistinguishable from a traffic increase.

### Cardinality: the thing that kills metric backends

Every distinct label combination is a separate time series. Safe labels are bounded sets: service (tens), method (hundreds), status code (17). Unsafe labels are unbounded: user id, SKU, request id, IP address, full URL, error message.

The arithmetic is unforgiving: 20 methods × 17 codes = 340 series, which is fine. Add a `customer_id` label with 50,000 values and it is 17 million, which will take down your metrics backend before it helps you.

The rule: **identifiers belong in traces and logs, never in metric labels.** If you need per-customer latency, use exemplars to jump from a metric to a trace, or aggregate offline.

```svg
<svg viewBox="0 0 880 500" width="100%" height="500" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="ob1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#0ea5e9"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Three signals, one vocabulary</text>

  <rect x="24" y="42" width="266" height="182" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="157" y="64" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Metrics</text>
  <text x="157" y="82" text-anchor="middle" fill="#166534" font-size="10">"is something wrong, how bad?"</text>
  <text x="40" y="106" fill="#166534" font-size="10">rate &#183; errors by CODE &#183; duration</text>
  <text x="40" y="122" fill="#166534" font-size="10">+ active streams, msgs, idle time</text>
  <text x="40" y="146" fill="#15803d" font-size="10" font-weight="bold">Cheap. Aggregated. Alertable.</text>
  <text x="40" y="168" fill="#b91c1c" font-size="10" font-weight="bold">BOUNDED labels only:</text>
  <text x="40" y="184" fill="#991b1b" font-size="10">service, method, code &#8212; nothing else.</text>
  <text x="40" y="206" fill="#991b1b" font-size="10">No user id, sku, request id, IP.</text>

  <rect x="306" y="42" width="266" height="182" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="439" y="64" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">Traces</text>
  <text x="439" y="82" text-anchor="middle" fill="#6d28d9" font-size="10">"where did the time go?"</text>
  <text x="322" y="106" fill="#6d28d9" font-size="10">one request = one trace</text>
  <text x="322" y="122" fill="#6d28d9" font-size="10">each hop = a span</text>
  <text x="322" y="146" fill="#5b21b6" font-size="10" font-weight="bold">Propagated via `traceparent`</text>
  <text x="322" y="162" fill="#6d28d9" font-size="10">in metadata (W3C Trace Context)</text>
  <text x="322" y="186" fill="#5b21b6" font-size="10" font-weight="bold">HIGH-cardinality attributes are fine</text>
  <text x="322" y="202" fill="#6d28d9" font-size="10">here: sku, user id, request id.</text>

  <rect x="588" y="42" width="268" height="182" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="722" y="64" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">Logs</text>
  <text x="722" y="82" text-anchor="middle" fill="#1d4ed8" font-size="10">"what exactly happened?"</text>
  <text x="604" y="106" fill="#1d4ed8" font-size="10">structured, one line per RPC</text>
  <text x="604" y="122" fill="#1d4ed8" font-size="10">method, code, duration, principal</text>
  <text x="604" y="146" fill="#1e40af" font-size="10" font-weight="bold">MUST carry the trace id</text>
  <text x="604" y="162" fill="#1d4ed8" font-size="10">&#8212; that is what links all three.</text>
  <text x="604" y="186" fill="#b91c1c" font-size="10" font-weight="bold">Never log tokens or whole requests.</text>
  <text x="604" y="202" fill="#991b1b" font-size="10">Redact by allow-list, not by denylist.</text>

  <rect x="24" y="242" width="832" height="106" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="440" y="264" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Cardinality arithmetic is unforgiving</text>
  <rect x="60" y="280" width="330" height="52" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="225" y="300" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">20 methods &#215; 17 codes = 340 series</text>
  <text x="225" y="318" text-anchor="middle" fill="#166534" font-size="10">fine on any backend</text>
  <text x="420" y="310" fill="#b91c1c" font-size="16" font-weight="bold">vs</text>
  <rect x="460" y="280" width="360" height="52" rx="6" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="640" y="300" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">&#215; 50,000 customer_id = 17,000,000 series</text>
  <text x="640" y="318" text-anchor="middle" fill="#991b1b" font-size="10">takes down the backend before it helps you</text>

  <rect x="24" y="366" width="832" height="126" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="388" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Interceptor or StatsHandler?</text>
  <rect x="48" y="404" width="380" height="72" rx="8" fill="#fff" stroke="#94a3b8"/>
  <text x="238" y="424" text-anchor="middle" fill="#334155" font-size="11" font-weight="bold">Interceptor &#8212; LOGIC</text>
  <text x="62" y="446" fill="#475569" font-size="10">can reject, modify context/request/response/error</text>
  <text x="62" y="464" fill="#475569" font-size="10">&#8594; auth, validation, error mapping, structured logging</text>

  <rect x="452" y="404" width="380" height="72" rx="8" fill="#fff" stroke="#94a3b8"/>
  <text x="642" y="424" text-anchor="middle" fill="#334155" font-size="11" font-weight="bold">StatsHandler &#8212; TELEMETRY</text>
  <text x="466" y="446" fill="#475569" font-size="10">per-message events, wire byte counts, connection events</text>
  <text x="466" y="464" fill="#475569" font-size="10">&#8594; tracing and metrics (why otelgrpc moved here)</text>
</svg>
```

### Sampling: what to keep

Tracing every request at high QPS is expensive to produce, transmit and store. The strategies:

- **Head-based** — decide at the root, propagate the decision. Simple and cheap, but you sample blind: a 1% rate means 99% of your errors are invisible.
- **Tail-based** — buffer spans at a collector and decide after the trace completes. Keeps every error and every slow request, samples the boring successes. More infrastructure, dramatically more useful.
- **Parent-based with a local override** — respect the incoming decision, but always sample errors locally.

For production, tail-based sampling in the collector is the right answer: 100% of errors, 100% of requests over a latency threshold, and 1% of the rest. The alternative — head sampling at 1% — means the trace you want during an incident almost certainly does not exist.

## 4. Architecture & Workflow

The wiring:

1. **Stats handler** for traces and metrics — `otelgrpc.NewServerHandler()` on the server, `NewClientHandler()` on the client.
2. **Logging interceptor** for one structured line per call, reading the trace id from the context.
3. **A `slog.Handler`** that injects `trace_id` and `span_id` into every log record automatically, so handler code does not have to remember.
4. **Metric views** to control cardinality and histogram buckets.
5. **A collector** doing tail-based sampling and fan-out to backends.

The property to aim for: **from any alert, one click to a trace; from any span, one click to its logs; from any log line, the trace id to search on.**

```svg
<svg viewBox="0 0 880 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="tr1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">One trace across services &#8212; the slow hop is obvious</text>

  <rect x="24" y="42" width="832" height="180" rx="10" fill="#faf5ff" stroke="#7c3aed" stroke-width="2"/>
  <text x="440" y="64" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">trace_id: 4bf92f3577b34da6a3ce929d0e0e4736</text>

  <rect x="48" y="78" width="740" height="24" rx="4" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="58" y="95" fill="#5b21b6" font-size="10">gateway  PlaceOrder                                                       842 ms</text>

  <rect x="120" y="106" width="620" height="24" rx="4" fill="#e9d5ff" stroke="#a855f7"/>
  <text x="130" y="123" fill="#6b21a8" font-size="10">orders  PlaceOrder                                              810 ms</text>

  <rect x="180" y="134" width="120" height="24" rx="4" fill="#dcfce7" stroke="#16a34a"/>
  <text x="190" y="151" fill="#15803d" font-size="10">pricing  22 ms</text>

  <rect x="308" y="134" width="430" height="24" rx="4" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="318" y="151" fill="#b91c1c" font-size="10" font-weight="bold">inventory  ReserveStock                          690 ms   &#8592; THE SLOW HOP</text>

  <rect x="330" y="162" width="390" height="24" rx="4" fill="#fecaca" stroke="#dc2626"/>
  <text x="340" y="179" fill="#991b1b" font-size="10">postgres  SELECT &#8230; FOR UPDATE                660 ms  (lock wait)</text>

  <text x="48" y="208" fill="#6d28d9" font-size="10">Without a trace this is "PlaceOrder is slow" and four teams guessing. With one, it is a lock-contention ticket in 30 seconds.</text>

  <rect x="24" y="240" width="410" height="170" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="229" y="262" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">Sampling: what to keep</text>
  <text x="42" y="286" fill="#1e40af" font-size="10" font-weight="bold">Head-based (1%)</text>
  <text x="42" y="302" fill="#1d4ed8" font-size="10">Decide at the root, propagate. Cheap &#8212; but you</text>
  <text x="42" y="318" fill="#b91c1c" font-size="10" font-weight="bold">sample blind: 99% of your errors are invisible.</text>
  <text x="42" y="342" fill="#15803d" font-size="10" font-weight="bold">Tail-based (collector)</text>
  <text x="42" y="358" fill="#166534" font-size="10">Buffer, decide after the trace completes:</text>
  <text x="42" y="374" fill="#166534" font-size="10">100% of errors &#183; 100% over a latency threshold</text>
  <text x="42" y="390" fill="#166534" font-size="10">&#183; 1% of the boring successes.</text>

  <rect x="446" y="240" width="410" height="170" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="651" y="262" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Streaming metrics unary cannot give you</text>
  <text x="464" y="286" fill="#475569" font-size="10">active_streams (gauge) &#183; messages per direction</text>
  <text x="464" y="302" fill="#475569" font-size="10">stream duration &#183; time-since-last-message</text>
  <text x="464" y="328" fill="#b91c1c" font-size="10" font-weight="bold">The pattern to memorise:</text>
  <text x="464" y="346" fill="#991b1b" font-size="10">active streams RISING while message rate is FLAT</text>
  <text x="464" y="362" fill="#991b1b" font-size="10">= streams are stuck.</text>
  <text x="464" y="384" fill="#475569" font-size="10">Usually a blocked Send under flow control, a missing</text>
  <text x="464" y="400" fill="#475569" font-size="10">lifetime cap, or clients gone without a TCP FIN.</text>
</svg>
```

## 5. Implementation

### OpenTelemetry setup

```go
package observability

import (
	"context"
	"fmt"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

type Config struct {
	ServiceName    string
	ServiceVersion string
	Environment    string
	OTLPEndpoint   string
	SampleRatio    float64 // head sampling; prefer tail sampling in the collector
}

// Setup wires traces and metrics and returns a shutdown function that flushes
// both. Calling that function during shutdown matters: without it the last
// few seconds before an exit are an observability blind spot, which is exactly
// when you need the data.
func Setup(ctx context.Context, cfg Config) (shutdown func(context.Context) error, err error) {
	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName(cfg.ServiceName),
			semconv.ServiceVersion(cfg.ServiceVersion),
			semconv.DeploymentEnvironment(cfg.Environment),
		),
		resource.WithHost(),
		resource.WithProcessPID(),
	)
	if err != nil {
		return nil, fmt.Errorf("build resource: %w", err)
	}

	// --- Traces ------------------------------------------------------------
	traceExp, err := otlptracegrpc.New(ctx,
		otlptracegrpc.WithEndpoint(cfg.OTLPEndpoint),
		otlptracegrpc.WithInsecure(), // in-cluster collector
	)
	if err != nil {
		return nil, fmt.Errorf("trace exporter: %w", err)
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithResource(res),
		sdktrace.WithBatcher(traceExp,
			sdktrace.WithMaxQueueSize(2048),
			sdktrace.WithBatchTimeout(5*time.Second),
		),
		// ParentBased respects an upstream decision so a trace is not half
		// sampled. Keep this ratio generous and do the real filtering with
		// TAIL sampling in the collector, where you can keep 100% of errors.
		sdktrace.WithSampler(
			sdktrace.ParentBased(sdktrace.TraceIDRatioBased(cfg.SampleRatio)),
		),
	)
	otel.SetTracerProvider(tp)

	// W3C Trace Context + Baggage. This is what otelgrpc puts in metadata as
	// `traceparent`, and what makes a trace continue across a service boundary.
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))

	// --- Metrics -----------------------------------------------------------
	metricExp, err := otlpmetricgrpc.New(ctx,
		otlpmetricgrpc.WithEndpoint(cfg.OTLPEndpoint),
		otlpmetricgrpc.WithInsecure(),
	)
	if err != nil {
		return nil, fmt.Errorf("metric exporter: %w", err)
	}

	mp := sdkmetric.NewMeterProvider(
		sdkmetric.WithResource(res),
		sdkmetric.WithReader(sdkmetric.NewPeriodicReader(metricExp,
			sdkmetric.WithInterval(15*time.Second))),

		// Histogram buckets tuned for RPC latency. The defaults are geared to
		// seconds and put almost everything in one bucket for a service whose
		// p99 is 50 ms, making the histogram useless.
		sdkmetric.WithView(sdkmetric.NewView(
			sdkmetric.Instrument{Name: "rpc.*.duration"},
			sdkmetric.Stream{Aggregation: sdkmetric.AggregationExplicitBucketHistogram{
				Boundaries: []float64{
					0.001, 0.005, 0.01, 0.025, 0.05, 0.1,
					0.25, 0.5, 1, 2.5, 5, 10,
				},
			}},
		)),

		// CARDINALITY GUARD: drop any attribute that is not on the allow-list.
		// This is the difference between 340 series and 17 million, and it is
		// far better to enforce it here than to rely on everyone remembering.
		sdkmetric.WithView(sdkmetric.NewView(
			sdkmetric.Instrument{Name: "rpc.*"},
			sdkmetric.Stream{AttributeFilter: attribute.NewAllowKeysFilter(
				"rpc.service", "rpc.method", "rpc.grpc.status_code",
			)},
		)),
	)
	otel.SetMeterProvider(mp)

	return func(ctx context.Context) error {
		// Flush both, bounded, so shutdown cannot hang on a slow collector.
		ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		return errors.Join(tp.Shutdown(ctx), mp.Shutdown(ctx))
	}, nil
}
```

### Wiring gRPC instrumentation

```go
import "go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"

// Server. NewServerHandler is a StatsHandler, not an interceptor: that is
// what lets it see per-message events and wire byte counts, which an
// interceptor cannot. The interceptor-based API is deprecated.
srv := grpc.NewServer(
	grpc.StatsHandler(otelgrpc.NewServerHandler()),

	grpc.ChainUnaryInterceptor(
		interceptors.Recovery(log),
		interceptors.Logging(log),   // reads the trace id the handler created
		interceptors.Auth(verifier),
		interceptors.Validate(validator),
	),
	grpc.ChainStreamInterceptor(
		interceptors.RecoveryStream(log),
		interceptors.LoggingStream(log),
		interceptors.AuthStream(verifier),
	),
)

// Client. This is what injects `traceparent` into outgoing metadata, so the
// downstream service continues the same trace rather than starting a new one.
conn, err := grpc.NewClient(target,
	grpc.WithTransportCredentials(creds),
	grpc.WithStatsHandler(otelgrpc.NewClientHandler()),
)
```

### Logs that link to traces

```go
// TraceHandler wraps a slog.Handler and injects trace_id and span_id into
// every record.
//
// Doing it here rather than at each call site is the whole point: no handler
// code has to remember, and every log line becomes searchable by trace id.
type TraceHandler struct{ slog.Handler }

func (h TraceHandler) Handle(ctx context.Context, r slog.Record) error {
	if sc := trace.SpanContextFromContext(ctx); sc.IsValid() {
		r.AddAttrs(
			slog.String("trace_id", sc.TraceID().String()),
			slog.String("span_id", sc.SpanID().String()),
		)
	}
	return h.Handler.Handle(ctx, r)
}

func NewLogger(level slog.Level) *slog.Logger {
	return slog.New(TraceHandler{
		Handler: slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level}),
	})
}
```

```go
// LoggingInterceptor emits one structured line per RPC.
//
// It stays an INTERCEPTOR rather than a stats handler because it wants the
// final status and the principal that the auth interceptor put in the context.
func LoggingInterceptor(log *slog.Logger) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler) (any, error) {

		start := time.Now()
		resp, err := handler(ctx, req)
		code := status.Code(err)

		attrs := []any{
			"grpc.service", serviceOf(info.FullMethod),
			"grpc.method", methodOf(info.FullMethod),
			"grpc.code", code.String(),
			"duration_ms", time.Since(start).Milliseconds(),
		}

		// High-cardinality identifiers are FINE in logs — they are indexed
		// text, not time series. They are exactly what you cannot put in a
		// metric label.
		if p, ok := PrincipalFromContext(ctx); ok {
			attrs = append(attrs, "principal", p.Subject)
		}
		if rid := requestIDFrom(ctx); rid != "" {
			attrs = append(attrs, "request_id", rid)
		}
		if pr, ok := peer.FromContext(ctx); ok {
			attrs = append(attrs, "peer", pr.Addr.String())
		}
		if err != nil {
			attrs = append(attrs, "error", err.Error())
			// The stable reason from ErrorInfo (chapter 22): far more useful
			// for grouping than the message.
			if reason := errorReason(err); reason != "" {
				attrs = append(attrs, "error_reason", reason)
			}
		}

		// Severity by class, so alerts can key on level: Internal is our bug,
		// InvalidArgument is the caller's.
		switch code {
		case codes.OK:
			log.InfoContext(ctx, "grpc", attrs...)
		case codes.Internal, codes.Unknown, codes.DataLoss:
			log.ErrorContext(ctx, "grpc", attrs...)
		default:
			log.WarnContext(ctx, "grpc", attrs...)
		}
		return resp, err
	}
}
```

### Streaming metrics

```go
// StreamMetrics records what unary metrics cannot: whether streams are
// accumulating, how much they carry, and how long they sit idle.
type StreamMetrics struct {
	active   metric.Int64UpDownCounter
	messages metric.Int64Counter
	duration metric.Float64Histogram
	idle     metric.Float64Histogram
}

func (m *StreamMetrics) Interceptor() grpc.StreamServerInterceptor {
	return func(srv any, ss grpc.ServerStream, info *grpc.StreamServerInfo,
		handler grpc.StreamHandler) error {

		ctx := ss.Context()
		attrs := metric.WithAttributes(
			attribute.String("rpc.service", serviceOf(info.FullMethod)),
			attribute.String("rpc.method", methodOf(info.FullMethod)),
		)

		// The gauge that matters most: rising while message rate is flat means
		// streams are stuck (chapter 16).
		m.active.Add(ctx, 1, attrs)
		defer m.active.Add(ctx, -1, attrs)

		start := time.Now()
		w := &metricStream{ServerStream: ss, m: m, ctx: ctx, attrs: attrs, last: start}

		err := handler(srv, w)

		m.duration.Record(ctx, time.Since(start).Seconds(),
			metric.WithAttributes(
				attribute.String("rpc.service", serviceOf(info.FullMethod)),
				attribute.String("rpc.method", methodOf(info.FullMethod)),
				attribute.String("rpc.grpc.status_code", status.Code(err).String()),
			))
		return err
	}
}

type metricStream struct {
	grpc.ServerStream
	m     *StreamMetrics
	ctx   context.Context
	attrs metric.MeasurementOption
	last  time.Time
}

func (s *metricStream) SendMsg(msg any) error {
	// Time since the previous message: a long tail here is a stalled producer
	// or a client that stopped reading.
	s.m.idle.Record(s.ctx, time.Since(s.last).Seconds(), s.attrs)
	s.last = time.Now()

	err := s.ServerStream.SendMsg(msg)
	if err == nil {
		s.m.messages.Add(s.ctx, 1, s.attrs,
			metric.WithAttributes(attribute.String("direction", "sent")))
	}
	return err
}

func (s *metricStream) RecvMsg(msg any) error {
	err := s.ServerStream.RecvMsg(msg)
	if err == nil {
		s.last = time.Now()
		s.m.messages.Add(s.ctx, 1, s.attrs,
			metric.WithAttributes(attribute.String("direction", "received")))
	}
	return err
}
```

### Enriching spans inside a handler

```go
func (s *Service) ReserveStock(
	ctx context.Context,
	req *inventoryv1.ReserveStockRequest,
) (*inventoryv1.ReserveStockResponse, error) {
	// otelgrpc already created the RPC span; this adds business context to it.
	// High-cardinality attributes are correct HERE — traces are sampled and
	// stored per-request, so an order id costs nothing the way a metric label
	// would.
	span := trace.SpanFromContext(ctx)
	span.SetAttributes(
		attribute.String("inventory.order_id", req.GetOrderId()),
		attribute.Int("inventory.line_count", len(req.GetLines())),
	)

	// A child span around the expensive part, so the trace shows where the
	// time actually went rather than just "the handler took 690 ms".
	ctx, dbSpan := s.tracer.Start(ctx, "store.Reserve",
		trace.WithAttributes(attribute.Int("db.line_count", len(req.GetLines()))))
	res, err := s.store.Reserve(ctx, toDomain(req))
	if err != nil {
		// Recording on the span is what makes the trace searchable by error
		// and what tail-based sampling keys off to retain it.
		dbSpan.RecordError(err)
		dbSpan.SetStatus(otelcodes.Error, err.Error())
	}
	dbSpan.End()

	if err != nil {
		span.RecordError(err)
		span.SetStatus(otelcodes.Error, "reserve failed")
		return nil, transport.ToStatus(ctx, s.log, "ReserveStock", err)
	}

	// Events mark points in time within a span — cheaper than a child span
	// for something instantaneous.
	span.AddEvent("reservation.created",
		trace.WithAttributes(attribute.String("reservation_id", res.ID)))

	return toProto(res), nil
}
```

### Tail-based sampling in the collector

```yaml
# otel-collector.yaml — the sampling that actually matters.
processors:
  tail_sampling:
    decision_wait: 10s          # buffer until the trace is (probably) complete
    num_traces: 100000
    policies:
      # ALWAYS keep errors. This is the whole reason to prefer tail sampling:
      # with 1% head sampling, 99% of your errors simply do not exist.
      - name: errors
        type: status_code
        status_code: {status_codes: [ERROR]}

      # Always keep slow traces — the ones you want when p99 moves.
      - name: slow
        type: latency
        latency: {threshold_ms: 500}

      # And a small sample of the boring successes, for baselines.
      - name: baseline
        type: probabilistic
        probabilistic: {sampling_percentage: 1}
```

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **`otelgrpc` is one line per side** and produces spans, metrics and context propagation conforming to semantic conventions.
- **Stats handlers see what interceptors cannot** — per-message events and wire byte counts.
- **W3C trace context propagates automatically** through metadata, so cross-service traces work with no application code.
- **One vocabulary across all three signals** makes correlation trivial.
- **Vendor-neutral**: swapping backends is a collector configuration change.

**Disadvantages**
- **Cardinality is a live hazard**; one careless label can take down a metrics backend.
- **Streaming needs custom metrics** — the standard instrumentation does not give you active streams or idle time.
- **Tracing has real overhead** — span creation, attribute allocation and export, typically a few percent CPU.
- **Sampling means the trace you want may not exist**, unless tail-based sampling is in place.
- **Logs are the most expensive signal per byte** and the easiest to accidentally fill with secrets.

**Trade-offs**
- *Head vs tail sampling:* head is simple and cheap but blind; tail keeps every error at the cost of collector memory and a decision delay. Tail is worth it for anything production-critical.
- *Metric granularity vs cardinality:* per-customer latency would be wonderful and will destroy your backend. Use exemplars to jump metric → trace instead.
- *Log volume vs cost:* one structured line per RPC is right; per-message logging on streams is not. Sample or aggregate the high-volume paths.

## 7. Common Mistakes & Best Practices

- **Unbounded metric labels.** User ids, SKUs, request ids and IPs in labels will kill the backend. Enforce an allow-list in a view.
- **Only unary metrics.** Streams need active count, message counts and idle time, or a stuck stream is invisible.
- **Logs without a trace id.** The three signals then cannot be correlated, which is most of their value.
- **Logging whole requests.** They contain tokens and PII. Redact by allow-list, not denylist.
- **Head sampling at 1% with no tail sampling.** The trace you need during an incident does not exist.
- **Default histogram buckets.** Geared to seconds; a service with a 50 ms p99 gets one useful bucket.
- **Not flushing on shutdown.** The last seconds before an exit — exactly when things went wrong — are lost.
- **Instrumenting with the deprecated `otelgrpc` interceptors** instead of `NewServerHandler`/`NewClientHandler`.
- **Missing the client handler.** Traces then break at the boundary and every service starts a new one.
- **Alerting on aggregate error rate.** `Internal`, `Unavailable` and `InvalidArgument` have different owners; alert separately.
- **Creating a span per message on a stream.** Enormous volume; use span events or metrics.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** The workflow to design for: alert → exemplar → trace → span with the error → log lines by trace id → the actual cause. Every hop in that chain must be one click. If any is manual copy-paste, it will not happen at 3 a.m.
- **Monitoring.** Alert on the RED signals per method, split by code class: `Internal` (your bug), `Unavailable` (infrastructure), `DeadlineExceeded` (too slow), `ResourceExhausted` (limits). Add streaming alerts on active-stream growth and idle time. On the client side, alert on the attempts-to-calls ratio to catch retry storms.
- **Security.** Logs and traces are exfiltration paths. Never log the `authorization` header, never put request bodies in span attributes, and redact by allow-list — a denylist misses the field someone adds next month. Traces contain service topology and identifiers, so treat the collector as sensitive infrastructure.
- **Scaling.** Instrumentation overhead is real: measure it with a no-op handler benchmark before and after. Batch exporters and bound their queues so a slow collector applies backpressure rather than growing memory. At very high QPS, reduce histogram bucket counts and attribute counts before reducing sampling, since those dominate.

## 9. Interview Questions

**Q: What are the three signals and what does each answer?**
A: Metrics answer "is something wrong and how bad" — rate, errors by status code, and duration per method, aggregated and cheap enough to alert on. Traces answer "where did the time go" across service boundaries: one request, one trace, one span per hop, so the slow hop is immediately visible. Logs answer "what exactly happened" for a specific request. The value comes from using the same vocabulary across all three — service, method, status code — plus a trace id in every log line, so you can move between them in one click.

**Q: When do you use an interceptor versus a `StatsHandler`?**
A: Logic in interceptors, telemetry in stats handlers. An interceptor wraps the call and can modify the context, request, response and error, so anything that must reject or transform — auth, validation, error mapping — has to be one. A stats handler receives lifecycle events including per-message payloads with byte counts and connection events, and cannot modify anything, which is exactly right for tracing and metrics. That is why `otelgrpc` moved from interceptors to `NewServerHandler`/`NewClientHandler`. Structured logging stays an interceptor because it wants the final status and the principal from the context.

**Q: What metrics does a gRPC service need beyond RED?**
A: Streaming ones, because rate, errors and duration are close to meaningless for a thirty-minute stream. Active streams as a gauge, messages sent and received per stream, stream duration, and time-since-last-message. The pattern worth memorising is that active streams rising while message rate stays flat means streams are stuck — typically a blocked `Send` under flow control, a missing lifetime cap, or clients that vanished without a TCP FIN. On the client side, the attempts-to-logical-calls ratio, since that is how a retry storm becomes visible.

**Q: What is cardinality and why does it matter?**
A: The number of distinct label combinations, each of which is a separate time series. Bounded labels are safe: twenty methods times seventeen status codes is 340 series. An unbounded label is not: adding a customer id with fifty thousand values makes it seventeen million, which will take down the metrics backend before it helps anyone. The rule is that identifiers belong in traces and logs, never in metric labels — and rather than relying on discipline, enforce an attribute allow-list in a metric view so a careless label is dropped rather than exported.

**Q: How does trace context propagate across gRPC calls?**
A: As metadata. The client-side instrumentation injects a `traceparent` header following W3C Trace Context, and the server-side instrumentation extracts it and creates a child span, so the downstream service continues the same trace rather than starting a new one. In Go that means setting a text-map propagator and installing `otelgrpc.NewClientHandler()` on every client — the most common cause of traces breaking at a boundary is that the client handler was never added, so only the server side is instrumented.

**Q: What is the difference between head and tail sampling?**
A: Head sampling decides at the root and propagates the decision, which is cheap and keeps traces coherent but is blind — at one percent, ninety-nine percent of your errors simply do not exist, which is precisely the data you want during an incident. Tail sampling buffers spans at a collector and decides once the trace is complete, so you can keep one hundred percent of errors and slow traces and one percent of the boring successes. It costs collector memory and a decision delay of several seconds, and it is worth it for anything production-critical.

**Q: Why should logs carry a trace id?**
A: Because it is the join key between the three signals. Without it, going from a slow trace to the log lines for that request means guessing at timestamps and hoping. With it, the trace view links straight to the logs and any log line gives you a trace id to search on. The right implementation is a `slog.Handler` wrapper that reads the span context and injects `trace_id` and `span_id` into every record automatically, so no handler code has to remember — because anything that depends on remembering will be forgotten somewhere.

**Q: (Senior) Design observability for a gRPC service estate.**
A: One vocabulary first — service, method and status code as the shared labels across metrics, traces and logs, matching OpenTelemetry semantic conventions so tooling works out of the box. Instrumentation is `otelgrpc` stats handlers on both server and client, plus a logging interceptor emitting one structured line per RPC with the trace id injected by a `slog.Handler` wrapper. Metrics get RED per method plus the streaming set, with histogram buckets tuned to actual latency rather than the defaults and an attribute allow-list view enforcing cardinality. Traces go through a collector doing tail-based sampling: all errors, all traces over a latency threshold, one percent of the rest, which means the trace I want during an incident exists. Alerts split by code class because `Internal`, `Unavailable` and `DeadlineExceeded` have different owners. And the property I actually optimise for is the debugging path: alert to exemplar to trace to span to logs, every hop one click, because anything requiring manual correlation will not happen at three in the morning.

**Q: (Senior) p99 latency doubled with no error-rate change. Walk through the investigation.**
A: I would start at the metric to establish scope: is it one method or all, one pod or the fleet, one caller or everyone. That immediately separates a code change from an infrastructure change from a single noisy client. Then jump via an exemplar into an actual slow trace, which usually answers "which hop" in seconds — that is the single highest-value move, and it is why exemplars are worth configuring. If the slow span is a downstream RPC, the investigation recurses into that service with the same trace. If it is a database span, I look at lock waits and query plans. If the handler span is wide but its children are narrow, the time is in our own code or in scheduling — GC pressure, goroutine contention, or CPU throttling — and pprof is the next tool. Two gRPC-specific possibilities worth checking early: load balancing gone wrong, where `pick_first` or a stale DNS result has concentrated traffic on a subset of pods, which shows as per-pod QPS skew; and flow control on a streaming path, where a slow consumer is blocking `Send`. If p99 moved but p50 did not, it is tail behaviour — a slow backend, a GC pause, a cold cache — and hedging on idempotent reads is a legitimate mitigation while the cause is found.

**Q: (Senior) How do you keep observability from becoming an outage source?**
A: Three failure modes to design against. Cardinality explosion, where one careless label multiplies series into the millions and takes the metrics backend with it — prevented by an attribute allow-list enforced in a view, not by review discipline. Exporter backpressure, where a slow or unreachable collector causes the SDK's queues to grow until the process OOMs — prevented by bounded queues with a drop policy and a metric on dropped spans, so you lose telemetry rather than the service. And instrumentation overhead, where span creation and attribute allocation on a hot path add measurable latency — prevented by measuring it, with a no-op handler benchmark before and after, and by reducing attribute and bucket counts before reducing sampling, since those usually dominate. On top of that, the observability stack must not be a hard dependency: if the collector is down the service keeps serving, and shutdown flushes with a bounded timeout so a slow collector cannot hang a deploy.

## 10. Quick Revision & Cheat Sheet

```go
// Server: telemetry via StatsHandler, logic via interceptors
grpc.NewServer(
    grpc.StatsHandler(otelgrpc.NewServerHandler()),
    grpc.ChainUnaryInterceptor(recovery, logging, auth, validate),
    grpc.ChainStreamInterceptor(recoveryStream, loggingStream, streamMetrics, authStream),
)

// Client: this is what propagates `traceparent`
grpc.NewClient(target, grpc.WithStatsHandler(otelgrpc.NewClientHandler()))

// Logs carry the trace id automatically
slog.New(TraceHandler{Handler: slog.NewJSONHandler(os.Stdout, opts)})

// Cardinality guard
sdkmetric.WithView(sdkmetric.NewView(
    sdkmetric.Instrument{Name: "rpc.*"},
    sdkmetric.Stream{AttributeFilter: attribute.NewAllowKeysFilter(
        "rpc.service", "rpc.method", "rpc.grpc.status_code")}))
```

| Signal | Labels/attributes | Cardinality |
|---|---|---|
| Metrics | service, method, code | **Bounded only** |
| Traces | + order id, sku, user, request id | High is fine |
| Logs | everything except secrets | High is fine |

| Streaming metric | Diagnoses |
|---|---|
| `active_streams` | Stuck streams (rising, flat message rate) |
| `stream.messages` | Throughput per direction |
| `stream.duration` | Whether lifetime caps work |
| `idle_seconds` | Stalled producer or blocked `Send` |

**Flash cards**
- **Interceptor or stats handler?** → Logic vs telemetry. `otelgrpc` uses stats handlers.
- **Trace propagation?** → `traceparent` in metadata; needs the **client** handler too.
- **Metric labels?** → Bounded only. Identifiers go in traces and logs.
- **Sampling?** → Tail-based in the collector: 100% of errors.
- **Log/trace join key?** → `trace_id`, injected by a `slog.Handler` wrapper.
- **Stuck streams?** → Active streams rising while message rate is flat.
- **Shutdown?** → Flush the exporters, bounded, or lose the last seconds.

## 11. Hands-On Exercises & Mini Project

- [ ] Instrument a three-service chain with `otelgrpc` on both sides and view one end-to-end trace. Remove the client handler and observe the trace break at the boundary.
- [ ] Add a `customer_id` metric label with 10,000 values and watch series count and backend memory. Add the allow-list view and watch it drop.
- [ ] Compare default histogram buckets against tuned ones for a service with a 50 ms p99, and note how many buckets are actually useful.
- [ ] Implement the `slog.Handler` wrapper, then find every log line for one request by trace id alone.
- [ ] Add streaming metrics, create a stuck stream by having a client stop reading, and identify it from the dashboard without looking at the code.
- [ ] Configure head sampling at 1%, generate errors, and confirm most have no trace. Switch to tail-based and confirm all do.
- [ ] Benchmark a no-op handler with and without instrumentation and record the per-call overhead.
- [ ] Kill the collector and verify the service keeps serving, spans are dropped rather than queued unboundedly, and a drop metric fires.

### Mini Project — "Full-Stack Observability"

**Goal.** Instrument a multi-service gRPC system so that any incident can be diagnosed from an alert in under five minutes, and prove it with a drill.

**Requirements.**
1. Three services with `otelgrpc` stats handlers on both server and client, a collector, and backends for traces, metrics and logs.
2. RED metrics per method plus the full streaming set, with tuned histogram buckets and an attribute allow-list view.
3. Structured logging with automatic trace-id injection and an allow-list redaction policy, with a test asserting no `authorization` header can be logged.
4. Tail-based sampling keeping all errors and all traces over a latency threshold, plus exemplars linking metric buckets to traces.
5. Alerts split by code class, plus streaming alerts on active-stream growth and idle time, plus a client-side attempts-to-calls alert.
6. Bounded exporter queues with a dropped-span metric, and shutdown flushing with a timeout.
7. A drill: inject a slow database in one service and a retry storm in another, and time how long it takes a colleague who has not seen the system to identify each from an alert.

**Extensions.**
- Add continuous profiling and correlate a CPU flame graph with a slow span.
- Add per-message span events on a streaming method and measure the volume cost against the diagnostic value.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Interceptors* (where logging lives and how stats handlers differ), *The Error Model* (the codes and reasons used as labels), *Server-Side Streaming Handlers* (what the streaming metrics diagnose), *Deadlines, Retries, Service Config & Load Balancing* (the attempts metric), *Reflection, grpcurl & Health Checks* (health as a metric).

- **OpenTelemetry Go — gRPC instrumentation (`otelgrpc`)** — OpenTelemetry · *Intermediate* · `NewServerHandler`/`NewClientHandler`, the semantic conventions produced, and the deprecation of the interceptor API. <https://github.com/open-telemetry/opentelemetry-go-contrib/tree/main/instrumentation/google.golang.org/grpc/otelgrpc>
- **OpenTelemetry — Semantic Conventions for RPC** — OpenTelemetry · *Intermediate* · the canonical attribute names (`rpc.service`, `rpc.method`, `rpc.grpc.status_code`) that make tooling work out of the box. <https://opentelemetry.io/docs/specs/semconv/rpc/grpc/>
- **grpc-go — stats handler package** — gRPC Authors · *Advanced* · the event types a stats handler receives, including per-message payloads and byte counts. <https://pkg.go.dev/google.golang.org/grpc/stats>
- **OpenTelemetry Collector — tail sampling processor** — OpenTelemetry · *Intermediate* · policy configuration for keeping errors and slow traces while sampling the rest. <https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/processor/tailsamplingprocessor>
- **Google SRE Book — Monitoring Distributed Systems** — Google · *Intermediate* · the four golden signals and why alerting on symptoms beats alerting on causes. <https://sre.google/sre-book/monitoring-distributed-systems/>
- **The RED Method** — Tom Wilkie / Grafana · *Beginner* · rate, errors, duration as the minimal request-driven service metric set. <https://grafana.com/blog/2018/08/02/the-red-method-how-to-instrument-your-services/>
- **Go — log/slog package** — The Go Authors · *Beginner* · structured logging, custom handlers, and the `Handle` method used for trace injection. <https://pkg.go.dev/log/slog>
- **Distributed Systems Observability** — Cindy Sridharan (free O'Reilly report) · *Intermediate* · why the three signals are complementary and how correlation makes them useful. <https://www.oreilly.com/library/view/distributed-systems-observability/9781492033431/>

---

*gRPC with Go Handbook — chapter 26.*
