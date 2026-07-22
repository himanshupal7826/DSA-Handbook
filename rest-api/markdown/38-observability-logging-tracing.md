# 38 · API Observability: Logs, Metrics & Tracing

> **In one line:** Observability is the property that lets you answer *new* questions about your API from the telemetry it already emits — structured logs for the narrative, RED metrics for the shape, and distributed traces for the causal chain, all stitched together by a correlation ID.

---

## 1. Overview

**Monitoring tells you that something is wrong; observability tells you why.** Monitoring is a fixed set of dashboards and alerts built from questions you thought of in advance — "is p99 latency above 500 ms?" Observability is the ability to ask a question you have never asked before — "why are `POST /v1/orders` requests from Android clients in Frankfurt on API version `2024-10-01` returning `409` only when the cart contains a gift card?" — and get an answer without shipping new code. The difference is whether your telemetry carries enough **high-cardinality context** to slice reality after the fact.

The problem this solves is that a modern API request is not one program. A single `POST /v1/orders` traverses a CDN, an API gateway, an auth service, an orders service, an inventory service, a payments call to a third party, a Postgres write, and a Kafka publish. When it takes 3.2 seconds, *nothing in any single service's logs says why*. Each hop looks fine. The latency is in the gaps — a connection pool wait, a retry, a slow DNS lookup, a lock. Without a trace that spans the hops and a correlation ID that ties the logs together, debugging degrades into eight engineers greping eight log streams and comparing timestamps in Slack.

The lineage is worth knowing. Google's **Dapper** paper (2010) described the trace/span model — a tree of timed, causally-linked operations propagated by an in-band context header. That produced Zipkin (Twitter, 2012) and Jaeger (Uber, 2017), which merged into **OpenTelemetry** (CNCF, 2019), now the vendor-neutral standard for traces, metrics, and logs. In parallel, the W3C standardized context propagation as **`traceparent`/`tracestate`** (W3C Trace Context, 2020), so a trace survives crossing between organizations and vendors. On the metrics side, Tom Wilkie's **RED method** (Rate, Errors, Duration) gave request-driven services the counterpart to Brendan Gregg's USE method for resources, and Google's SRE book supplied the **four golden signals** (latency, traffic, errors, saturation).

The three pillars are not interchangeable; they answer different questions at different costs. **Metrics** are cheap, pre-aggregated numbers with bounded cardinality — perfect for "is it broken and how badly", useless for "which customer". **Logs** are per-event records with unbounded detail — perfect for narrative, expensive at volume. **Traces** are per-request causal graphs — the only thing that answers "where did the 3.2 seconds go". The modern framing (Honeycomb's Charity Majors, among others) is that these are really one thing: **wide, structured events** with high cardinality, from which metrics can be derived and traces assembled.

A concrete example: Stripe returns a `Request-Id` header on every response (`req_1PqL2x...`), and their support team and dashboard can retrieve the full request log for it. GitHub returns `X-GitHub-Request-Id`. That single header is the entire user-facing surface of a large observability investment — and it is what turns "your API is broken" into "here is exactly what happened on that request at 14:03:11.482 UTC". Adopting that one convention is the highest-leverage observability change most API teams can make.

---

## 2. Core Concepts

- **Structured log** — a log line emitted as machine-parseable key/value data (usually JSON) rather than a formatted sentence, so it can be filtered and aggregated without regex archaeology.
- **Correlation ID / request ID** — a unique identifier attached to one logical request and propagated to every log line, span, and downstream call it produces; surfaced to clients so a user can quote it in a support ticket.
- **Trace** — the full causal tree of work done to serve one request, identified by a 16-byte `trace_id`.
- **Span** — one timed operation within a trace (an HTTP handler, a DB query, an outbound call), with a `span_id`, a parent, a start and end time, and attributes.
- **Context propagation** — passing trace identity across process boundaries; on HTTP this is the W3C `traceparent` header, format `00-<32 hex trace-id>-<16 hex span-id>-<2 hex flags>`.
- **RED metrics** — **R**ate (requests/sec), **E**rrors (failed requests/sec), **D**uration (latency distribution) — the three signals every request-driven service must expose.
- **Four golden signals** — latency, traffic, errors, saturation; the SRE framing that adds resource pressure to RED.
- **Cardinality** — the number of distinct values a label can take. Low-cardinality labels (`method`, `status`, `route`) belong on metrics; high-cardinality ones (`user_id`, `order_id`) belong on logs and spans.
- **Histogram / percentile** — a bucketed latency distribution from which p50/p95/p99 are estimated; averages hide the tail, percentiles expose it.
- **Sampling** — recording only a fraction of traces to control cost. **Head-based** decides at the root; **tail-based** decides after the trace completes, so you can keep all errors and slow requests.
- **Exemplar** — a trace ID attached to a metric bucket, letting you jump from "the p99 spiked" straight to an example trace that caused it.
- **Semantic conventions** — OpenTelemetry's standardized attribute names (`http.request.method`, `url.path`, `http.response.status_code`, `server.address`) so tools understand your telemetry without configuration.

---

## 3. Theory & Principles

**Why percentiles, not averages.** Latency distributions for APIs are right-skewed and often multi-modal — a cache hit at 4 ms and a cache miss at 180 ms produce a mean of, say, 22 ms that describes *no actual request*. Worse, averages are insensitive to the tail: if 1% of requests take 10 seconds, the mean moves by 100 ms and nobody notices, while 1 in 100 users is having a terrible time. Percentiles measure user experience directly: p99 = 800 ms means one request in a hundred was slower than 800 ms.

Two consequences follow. First, **percentiles do not average and do not add**. You cannot average the p99 of ten pods to get the fleet p99 — you must merge the underlying histograms (which is exactly what Prometheus `histogram_quantile()` over summed bucket counters does). Second, **tail latency amplifies with fan-out**. If a request calls *n* independent backends and each has a p99 of 100 ms, the probability that *at least one* is slow is `1 - 0.99^n`. At n=1 that is 1%; at n=10 it is 9.6%; at n=100 it is 63%. Jeff Dean's "The Tail at Scale" is the canonical treatment: at high fan-out, your p99 becomes the median user experience. This is *the* argument for hedged requests, tight timeouts, and, above all, for tracing — because the culprit backend is different every time.

**Why cardinality is the central cost constraint.** A Prometheus time series is created per unique combination of metric name and label values. Adding `user_id` to a counter with a million users creates a million series; the head block, WAL, and query planner all scale with that. So metrics must stay **low-cardinality** — `route` (the *template*, `/v1/orders/{id}`, never the concrete path), `method`, `status_code` class, maybe `region`. All the interesting identifiers — user, order, tenant, API key, client version — go onto **spans and structured logs**, which are stored as events and indexed differently. This split is not aesthetic; it is what keeps your bill finite.

**The RED discipline.** For every endpoint (or route template) expose:

```
Rate     = sum(rate(http_server_requests_total[5m])) by (route)
Errors   = sum(rate(http_server_requests_total{status=~"5.."}[5m])) by (route)
Duration = histogram_quantile(0.99,
             sum(rate(http_server_request_duration_seconds_bucket[5m])) by (le, route))
```

Note the subtlety in **Errors**: `4xx` is usually *not* a service error — a `404` or a `422` means the client sent something wrong and the API behaved correctly. Alert on `5xx` and on `429` trends, and track `4xx` separately as a *client health* signal. Conflating them produces an error rate that spikes whenever someone fat-fingers a URL.

**Trace context and the sampling decision.** The `traceparent` header carries a 2-hex `trace-flags` byte whose low bit is `sampled`. Because the decision is propagated, all services in a trace agree — otherwise you get broken trees with missing middles. Head-based sampling at 1% is cheap but throws away 99% of your errors; **tail-based sampling** buffers spans at a collector until the trace ends, then keeps it if any span errored, if duration exceeded a threshold, or by probability otherwise. The rule of thumb: keep 100% of errors and slow traces, and 0.1–1% of the boring ones.

```svg
<svg viewBox="0 0 740 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="740" height="360" fill="#f8fafc"/>
  <text x="370" y="26" text-anchor="middle" font-size="16" font-weight="bold" fill="#1e293b">Latency distribution: the mean describes nobody</text>
  <line x1="70" y1="250" x2="700" y2="250" stroke="#1e293b" stroke-width="2"/>
  <line x1="70" y1="250" x2="70" y2="55" stroke="#1e293b" stroke-width="2"/>
  <text x="385" y="278" text-anchor="middle" font-size="12" fill="#1e293b">latency (ms)</text>
  <text x="34" y="160" font-size="12" fill="#1e293b" transform="rotate(-90 34 160)">requests</text>
  <rect x="90" y="120" width="26" height="130" fill="#e0f2fe" stroke="#0ea5e9"/>
  <rect x="118" y="70" width="26" height="180" fill="#e0f2fe" stroke="#0ea5e9"/>
  <rect x="146" y="105" width="26" height="145" fill="#e0f2fe" stroke="#0ea5e9"/>
  <rect x="174" y="175" width="26" height="75" fill="#e0f2fe" stroke="#0ea5e9"/>
  <rect x="202" y="215" width="26" height="35" fill="#e0f2fe" stroke="#0ea5e9"/>
  <rect x="240" y="228" width="26" height="22" fill="#eef2ff" stroke="#4f46e5"/>
  <rect x="268" y="220" width="26" height="30" fill="#eef2ff" stroke="#4f46e5"/>
  <rect x="296" y="212" width="26" height="38" fill="#eef2ff" stroke="#4f46e5"/>
  <rect x="324" y="224" width="26" height="26" fill="#eef2ff" stroke="#4f46e5"/>
  <rect x="400" y="238" width="26" height="12" fill="#fef3c7" stroke="#d97706"/>
  <rect x="470" y="241" width="26" height="9" fill="#fef3c7" stroke="#d97706"/>
  <rect x="560" y="243" width="26" height="7" fill="#fef3c7" stroke="#d97706"/>
  <rect x="640" y="244" width="26" height="6" fill="#fef3c7" stroke="#d97706"/>
  <line x1="160" y1="55" x2="160" y2="250" stroke="#16a34a" stroke-width="2" stroke-dasharray="5"/>
  <text x="163" y="68" font-size="11" fill="#16a34a">p50 = 18 ms</text>
  <line x1="230" y1="55" x2="230" y2="250" stroke="#4f46e5" stroke-width="2" stroke-dasharray="5"/>
  <text x="233" y="90" font-size="11" fill="#4f46e5">mean = 34 ms (describes no request)</text>
  <line x1="500" y1="55" x2="500" y2="250" stroke="#d97706" stroke-width="2" stroke-dasharray="5"/>
  <text x="503" y="112" font-size="11" fill="#d97706">p99 = 610 ms</text>
  <text x="120" y="300" font-size="11" fill="#0ea5e9">cache hits</text>
  <text x="270" y="300" font-size="11" fill="#4f46e5">cache misses</text>
  <text x="500" y="300" font-size="11" fill="#d97706">retries, lock waits, GC, cold pools</text>
  <text x="70" y="336" font-size="12" fill="#1e293b">Fan-out amplification: n backends each at p99=100ms &#8594; P(at least one slow) = 1 &#8722; 0.99^n; n=10 &#8594; 9.6%, n=100 &#8594; 63%</text>
</svg>
```

---

## 4. Architecture & Workflow

Trace a single `POST /v1/orders` through a fully instrumented stack. Assume OpenTelemetry SDKs in each service, an OTel **Collector** as a sidecar or gateway, Prometheus for metrics, Loki or Elasticsearch for logs, and Tempo or Jaeger for traces.

1. **Edge ingress.** The CDN/load balancer receives the request. It generates or accepts a request ID and sets `X-Request-Id: 01J8Z2K7QF3M...`. If the client sent no `traceparent`, the gateway creates one: `traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`. The trailing `01` is the sampled flag.
2. **Gateway span.** The gateway starts the **root span** `POST /v1/orders` with attributes `http.request.method=POST`, `url.path=/v1/orders`, `http.route=/v1/orders`, `server.address`, `client.address`, `user_agent.original`. It makes the sampling decision and stamps it into `trace-flags`.
3. **Auth hop.** The gateway calls the auth service, injecting the current `traceparent` (now with the *gateway's* span as parent). The auth service creates a child span `GET /introspect`, adds `enduser.id=usr_7f2` as an attribute, and returns. That attribute is now searchable on the trace — high cardinality, correctly placed.
4. **Service entry.** `orders-api` receives the request. Its middleware **extracts** the context, starts a child server span, binds `trace_id`, `span_id`, and `request_id` into a logging context so that *every* log line in this request automatically carries them, and starts the RED metric timer.
5. **Downstream fan-out.** Three child spans run: `SELECT` on Postgres (`db.system=postgresql`, `db.query.text` with parameters stripped), an outbound `POST /charges` to the payment provider (client span, `traceparent` injected so the trace continues if they support it), and a Kafka `publish` (span links, not parent-child, because the consumer runs later).
6. **The slow hop.** The payment call takes 2.9 s. Its span records `http.response.status_code=201` and duration; the parent span's duration is dominated by it. On the flame graph this is unmistakable — no log correlation required.
7. **Error handling.** Inventory returns `409 Conflict`. The service sets `span.status = ERROR`, records an exception event with the stack trace, and emits one `ERROR` log line with `error.type`, `order_id`, `sku`, and the same `trace_id`.
8. **Response.** The API returns `201 Created` with `Location: /v1/orders/ord_9f2` and echoes `X-Request-Id`. Optionally it emits W3C `Server-Timing: db;dur=41, payments;dur=2903, total;dur=2988`, which shows up natively in browser devtools.
9. **Metric recording.** On the way out, middleware observes `http_server_request_duration_seconds` with labels `{method="POST", route="/v1/orders", status="201"}` and attaches an **exemplar** containing `trace_id`. Now a p99 spike on the dashboard is one click from the trace that caused it.
10. **Export and sampling.** Spans batch-export over OTLP to the Collector. The Collector runs a **tail sampling** processor: keep every trace with an error, every trace over 1 s, and 1% of the rest. It fans out to Tempo (traces), Prometheus (metrics via remote write), and Loki (logs).
11. **Correlation at query time.** In Grafana, clicking the exemplar opens the trace; the trace's `trace_id` is used as a Loki filter (`{app="orders-api"} | json | trace_id="4bf9..."`) to show exactly the log lines from that request. Three pillars, one pivot key.

```svg
<svg viewBox="0 0 780 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="780" height="400" fill="#ffffff"/>
  <text x="390" y="24" text-anchor="middle" font-size="16" font-weight="bold" fill="#1e293b">One trace, one request-id, three signals</text>
  <text x="30" y="52" font-size="11" fill="#1e293b">traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01</text>
  <rect x="30" y="66" width="700" height="26" rx="4" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="38" y="84" font-size="11" fill="#1e293b">gateway POST /v1/orders</text>
  <text x="700" y="84" text-anchor="end" font-size="11" fill="#1e293b">2988 ms</text>
  <rect x="60" y="100" width="80" height="24" rx="4" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="66" y="117" font-size="10" fill="#1e293b">auth 22ms</text>
  <rect x="145" y="134" width="570" height="24" rx="4" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="152" y="151" font-size="10" fill="#1e293b">orders-api handler 2952 ms</text>
  <rect x="160" y="168" width="46" height="24" rx="4" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="164" y="185" font-size="10" fill="#1e293b">db 41ms</text>
  <rect x="212" y="202" width="490" height="24" rx="4" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="220" y="219" font-size="10" fill="#1e293b">POST payments /charges 2903 ms  &#8592; the whole problem</text>
  <rect x="212" y="236" width="60" height="24" rx="4" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="217" y="253" font-size="10" fill="#1e293b">kafka 8ms</text>
  <line x1="30" y1="276" x2="750" y2="276" stroke="#94a3b8" stroke-width="1"/>
  <rect x="30" y="290" width="220" height="92" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="140" y="312" text-anchor="middle" font-size="12" font-weight="bold" fill="#1e293b">metrics (low cardinality)</text>
  <text x="40" y="333" font-size="10" fill="#1e293b">route, method, status only</text>
  <text x="40" y="351" font-size="10" fill="#1e293b">histogram + exemplar(trace_id)</text>
  <text x="40" y="369" font-size="10" fill="#1e293b">Prometheus</text>
  <rect x="270" y="290" width="230" height="92" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="385" y="312" text-anchor="middle" font-size="12" font-weight="bold" fill="#1e293b">logs (narrative)</text>
  <text x="280" y="333" font-size="10" fill="#1e293b">JSON, one event per line</text>
  <text x="280" y="351" font-size="10" fill="#1e293b">trace_id + request_id on every line</text>
  <text x="280" y="369" font-size="10" fill="#1e293b">Loki / Elasticsearch</text>
  <rect x="520" y="290" width="230" height="92" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="635" y="312" text-anchor="middle" font-size="12" font-weight="bold" fill="#1e293b">traces (causality)</text>
  <text x="530" y="333" font-size="10" fill="#1e293b">tail sampling at the Collector</text>
  <text x="530" y="351" font-size="10" fill="#1e293b">keep all errors + all &gt; 1s</text>
  <text x="530" y="369" font-size="10" fill="#1e293b">Tempo / Jaeger</text>
  <line x1="250" y1="336" x2="268" y2="336" stroke="#1e293b" stroke-width="2"/>
  <polygon points="268,336 260,332 260,340" fill="#1e293b"/>
  <line x1="500" y1="336" x2="518" y2="336" stroke="#1e293b" stroke-width="2"/>
  <polygon points="518,336 510,332 510,340" fill="#1e293b"/>
</svg>
```

---

## 5. Implementation

### Structured logging with automatic correlation (FastAPI)

```python
import logging, time, uuid, contextvars
from fastapi import FastAPI, Request
from opentelemetry import trace
from pythonjsonlogger import jsonlogger

request_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="-")

class ContextFilter(logging.Filter):
    """Stamp trace/span/request identity onto every record, no call-site changes needed."""
    def filter(self, record):
        ctx = trace.get_current_span().get_span_context()
        record.trace_id = format(ctx.trace_id, "032x") if ctx.is_valid else None
        record.span_id = format(ctx.span_id, "016x") if ctx.is_valid else None
        record.request_id = request_id_var.get()
        record.service = "orders-api"
        return True

handler = logging.StreamHandler()
handler.setFormatter(jsonlogger.JsonFormatter(
    "%(asctime)s %(levelname)s %(name)s %(message)s %(service)s %(trace_id)s %(span_id)s %(request_id)s",
    rename_fields={"asctime": "ts", "levelname": "level"}))
handler.addFilter(ContextFilter())
logging.basicConfig(level=logging.INFO, handlers=[handler])
log = logging.getLogger("orders")

app = FastAPI()

@app.middleware("http")
async def observability(request: Request, call_next):
    rid = request.headers.get("x-request-id") or uuid.uuid4().hex
    token = request_id_var.set(rid)
    started = time.perf_counter()
    try:
        response = await call_next(request)
    finally:
        request_id_var.reset(token)
    elapsed_ms = (time.perf_counter() - started) * 1000
    response.headers["X-Request-Id"] = rid
    response.headers["Server-Timing"] = f"app;dur={elapsed_ms:.1f}"
    log.info("request.completed", extra={
        "http_method": request.method,
        "http_route": request.scope.get("route").path if request.scope.get("route") else request.url.path,
        "http_status": response.status_code,
        "duration_ms": round(elapsed_ms, 2),
        "tenant_id": request.headers.get("x-tenant-id"),
    })
    return response
```

A resulting line — one JSON object, no multi-line stack spew, every field queryable:

```json
{
  "ts": "2026-03-14T14:03:11.482Z",
  "level": "INFO",
  "service": "orders-api",
  "message": "request.completed",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id": "00f067aa0ba902b7",
  "request_id": "01J8Z2K7QF3MB4X9VN7A0S2C6D",
  "http_method": "POST",
  "http_route": "/v1/orders",
  "http_status": 201,
  "duration_ms": 2988.41,
  "tenant_id": "acme"
}
```

### The wire: what propagation actually looks like

```http
POST /v1/orders HTTP/1.1
Host: api.example.com
Authorization: Bearer eyJhbGciOi...
Content-Type: application/json
Idempotency-Key: 5f1c2c3e-6c1a-4f1f-9a2b-9e6d0a3f77c1
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
tracestate: acme=t61rcWkgMzE

{"sku":"WIDGET-9","qty":2}
```
```http
HTTP/1.1 201 Created
Location: /v1/orders/ord_9f2
X-Request-Id: 01J8Z2K7QF3MB4X9VN7A0S2C6D
Server-Timing: db;dur=41, payments;dur=2903, total;dur=2988
Content-Type: application/json

{"id":"ord_9f2","status":"paid"}
```

And an error response that stays debuggable — RFC 9457 problem details carrying the same correlation ID:

```http
HTTP/1.1 409 Conflict
Content-Type: application/problem+json
X-Request-Id: 01J8Z2K7QF3MB4X9VN7A0S2C6D

{
  "type": "https://errors.example.com/insufficient-stock",
  "title": "Insufficient stock",
  "status": 409,
  "detail": "SKU WIDGET-9 has 1 unit available; 2 requested.",
  "instance": "/v1/orders",
  "request_id": "01J8Z2K7QF3MB4X9VN7A0S2C6D",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

### RED metrics with the right buckets and label discipline

```python
from prometheus_client import Counter, Gauge, Histogram

REQUESTS = Counter(
    "http_server_requests_total", "Total HTTP requests",
    ["method", "route", "status"],           # route TEMPLATE, never the raw path
)
DURATION = Histogram(
    "http_server_request_duration_seconds", "Request duration",
    ["method", "route"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0),
)
INFLIGHT = Gauge("http_server_active_requests", "In-flight requests", ["route"])
```

> **Note:** Use the route *template* (`/v1/orders/{id}`), never the concrete path. `/v1/orders/ord_9f2` as a label value creates one time series per order and will take down your Prometheus. This is the single most common metrics outage in API teams.

```promql
# Rate
sum(rate(http_server_requests_total[5m])) by (route)

# Error ratio (5xx only — 4xx is client behaviour, tracked separately)
sum(rate(http_server_requests_total{status=~"5.."}[5m])) by (route)
  / sum(rate(http_server_requests_total[5m])) by (route)

# p99 duration, merged correctly across all pods
histogram_quantile(0.99,
  sum(rate(http_server_request_duration_seconds_bucket[5m])) by (le, route))

# Saturation: are we near the concurrency ceiling?
max_over_time(http_server_active_requests[5m]) / on() group_left() app_max_concurrency
```

### OpenTelemetry wiring — auto-instrumentation plus one manual span

```python
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.instrumentation.psycopg import PsycopgInstrumentor

provider = TracerProvider(resource=Resource.create({
    "service.name": "orders-api",
    "service.version": "2026.3.14",
    "deployment.environment": "production",
}))
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint="http://otel-collector:4317")))
trace.set_tracer_provider(provider)

FastAPIInstrumentor.instrument_app(app)   # server spans + context extraction
HTTPXClientInstrumentor().instrument()    # client spans + traceparent injection
PsycopgInstrumentor().instrument()        # db spans

tracer = trace.get_tracer(__name__)

async def reserve_stock(order_id: str, sku: str, qty: int):
    with tracer.start_as_current_span("inventory.reserve") as span:
        span.set_attribute("order.id", order_id)      # high cardinality is FINE on spans
        span.set_attribute("inventory.sku", sku)
        span.set_attribute("inventory.qty", qty)
        try:
            return await _reserve(sku, qty)
        except OutOfStock as exc:
            span.record_exception(exc)
            span.set_status(trace.Status(trace.StatusCode.ERROR, "insufficient stock"))
            raise
```

### Collector config: tail sampling that keeps what matters

```yaml
receivers:
  otlp: { protocols: { grpc: {}, http: {} } }
processors:
  batch: { timeout: 5s, send_batch_size: 512 }
  tail_sampling:
    decision_wait: 10s
    policies:
      - name: keep-all-errors
        type: status_code
        status_code: { status_codes: [ERROR] }
      - name: keep-slow
        type: latency
        latency: { threshold_ms: 1000 }
      - name: keep-5xx
        type: numeric_attribute
        numeric_attribute: { key: http.response.status_code, min_value: 500, max_value: 599 }
      - name: sample-the-rest
        type: probabilistic
        probabilistic: { sampling_percentage: 1 }
exporters:
  otlp/tempo: { endpoint: tempo:4317, tls: { insecure: true } }
service:
  pipelines:
    traces: { receivers: [otlp], processors: [tail_sampling, batch], exporters: [otlp/tempo] }
```

**Optimization note.** Instrumentation is not free and the costs are unevenly distributed. Span *creation* is cheap (tens of nanoseconds when unsampled); span *export* and log *serialization* are not. Three rules pay for themselves: (1) always use `BatchSpanProcessor`, never `SimpleSpanProcessor`, in production — the simple one blocks the request thread on every span; (2) log at `INFO` for one event per request plus errors, not per-loop-iteration, and *never* log request/response bodies by default — a single verbose endpoint can produce more log bytes than your entire product's traffic and cost more than the compute serving it; (3) sample traces at the tail, not the head, so 1% sampling still gives you 100% of the errors. Also cap attribute counts and value lengths (`OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT`) so a rogue 2 MB SQL string does not blow up the exporter.

---

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Structured JSON logs | Queryable without regex; fields aggregate; trivially correlated by `trace_id` | Larger on the wire than plain text; unreadable in a raw terminal without `jq`; storage cost grows linearly with traffic |
| Metrics (RED) | Cheap, constant-cost, ideal for alerting and long retention | Bounded cardinality means no per-user answers; percentile estimates are bucket-limited |
| Distributed tracing | The only signal that shows causality and where time actually went | Requires end-to-end propagation; one un-instrumented hop breaks the tree; storage is expensive without sampling |
| Head sampling | Trivial, low overhead, decided once at the root | Throws away most errors; a 1% rate means you rarely have the trace you need |
| Tail sampling | Keeps 100% of errors and slow traces at ~1% total cost | Collector must buffer whole traces (memory, `decision_wait` latency); needs all spans of a trace at one collector instance |
| OpenTelemetry | Vendor-neutral, one SDK for all three signals, huge auto-instrumentation library | Moving API surface across languages; some SDKs lag; a real migration effort on brownfield services |
| High-cardinality events | Answers questions you never anticipated | Expensive in most storage engines; requires a columnar/event store, not Prometheus |
| `X-Request-Id` in responses | Turns vague support tickets into precise lookups; near-zero cost | Must be honest — if you generate it but cannot look it up, it is theatre |

---

## 7. Common Mistakes & Best Practices

1. ⚠️ **Concrete paths as metric labels.** `route="/v1/orders/ord_9f2"` creates one series per order and detonates Prometheus. → ✅ Always label with the route *template* from the router; assert in a test that no label value contains a digit-heavy segment.
2. ⚠️ **Counting `4xx` as errors.** A dashboard where one client's bad `404` loop pages the on-call. → ✅ Alert on `5xx` and on `429` growth; track `4xx` separately as a client-integration health signal, broken out by API key.
3. ⚠️ **Averaging latency.** `avg(duration)` hides everything users feel. → ✅ Store histograms and alert on p95/p99; if you must have one number, use p99 and publish the histogram beside it.
4. ⚠️ **Averaging percentiles across pods.** `avg(p99_per_pod)` is mathematically meaningless. → ✅ Sum the bucket counters, then apply `histogram_quantile` once over the merged buckets.
5. ⚠️ **Logging secrets and PII.** `Authorization` headers, full request bodies, card numbers, and emails end up in a log index with a five-year retention and broad read access. → ✅ Redact by allowlist not denylist, hash user identifiers if you need to group by them, and run an automated scanner over the log stream.
6. ⚠️ **No correlation ID reaching the client.** Support cannot find the request; the user says "yesterday afternoon, it was slow". → ✅ Accept `X-Request-Id` if the client sends one, generate a ULID if not, echo it on **every** response including errors, and include it in the RFC 9457 problem document.
7. ⚠️ **Breaking the trace at an async boundary.** Work handed to a queue or a background task loses context, and traces stop at the publish. → ✅ Serialize `traceparent` into the message headers and use **span links** on the consumer side (the consumer is not a child; it may run much later or fan in from many producers).
8. ⚠️ **Log-line-per-loop-iteration.** A batch job emits 2 million lines and the log bill exceeds the compute bill. → ✅ One structured event per unit of work with counts and durations as fields; use sampling or `debug` level for the rest.
9. ⚠️ **Instrumenting only your own code.** Time disappears into un-instrumented client libraries and connection pools. → ✅ Enable auto-instrumentation for the HTTP client, DB driver, cache, and message broker first — that is where the latency actually is.
10. ⚠️ **`SimpleSpanProcessor` in production.** Every span blocks on a network export inside the request path. → ✅ `BatchSpanProcessor` with a bounded queue, and monitor `otelcol_exporter_send_failed_spans` for silent drops.
11. ⚠️ **Head sampling at 1% and then wondering where the error traces went.** → ✅ Tail sampling: keep all errors, all traces over your latency threshold, and a small probabilistic slice of the rest.
12. ⚠️ **Three disconnected tools.** Metrics in one vendor, logs in another, traces in a third, and no shared key. → ✅ Ensure `trace_id` appears in log lines *and* as metric exemplars, so every dashboard is one click from an example trace and its logs.

---

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** The productive loop is *metrics → exemplar → trace → logs*. Start at the RED dashboard to find *which route* and *when*; click the exemplar on the spiking p99 bucket to open a representative trace; read the flame graph to find *which span* owns the time; pivot on `trace_id` into the log store to read that request's narrative including the exception. If the trace stops mid-way, you have found an un-instrumented service, and that itself is the finding. Two habits pay off enormously: put `deployment.environment`, `service.version`, and the git SHA on every span and log line as resource attributes (so "did this start at the 14:02 deploy?" is a filter, not a guess), and emit `Server-Timing` so front-end engineers can see backend breakdowns in browser devtools without asking you.

**Monitoring.** Instrument the observability pipeline itself, because it fails silently. Watch `otelcol_receiver_accepted_spans` vs `otelcol_exporter_sent_spans` and the `_refused_`/`_failed_` counterparts; the SDK's dropped-span counter; log-shipper backlog and drop rate; Prometheus `scrape_duration_seconds` and, critically, active series count against your cardinality budget. On the API side, the canonical dashboard is RED per route plus saturation (in-flight requests vs. concurrency limit, connection pool utilization, queue depth). Add `up`/heartbeat checks so an absent metric is distinguishable from a zero — "no data" alerting is the classic gap that hides a total outage.

**Security.** Telemetry is a data-exfiltration surface. Treat log and trace stores as containing customer data by default: enforce redaction in the SDK (an OTel span processor that drops or hashes sensitive attributes before export), never log `Authorization`, `Cookie`, or bodies of auth endpoints, and set retention deliberately (30 days hot for logs, 7–14 for traces, 13 months for aggregated metrics) partly because GDPR erasure requests apply to logs too. Do not accept a client-supplied `traceparent` blindly at the public edge without validating its format — a malformed or attacker-chosen trace ID lets an outsider poison or join your traces; the common posture is to accept `traceparent` from trusted internal callers, and at the public edge either validate strictly or start a fresh trace and record the incoming one as a link. Never put secrets in span attributes; they are exported to third-party backends. Redact `db.query.text` parameters.

**Performance & scaling.** Budget observability as a percentage of infrastructure spend — 5–15% is typical, and teams that do not budget it discover it at 40%. Control the three cost drivers explicitly: **cardinality** (metric series count — alert when it grows more than 20% week over week), **log volume** (bytes per request; the single biggest lever is not logging bodies), and **trace volume** (tail sampling rate). Deploy the OTel Collector as an agent per node for fast local export plus a gateway tier for tail sampling, since tail sampling requires all spans of a trace to reach the same instance — use `loadbalancing` exporter keyed on `trace_id` to guarantee that. For very high-throughput services, prefer OTLP/gRPC with compression, batch aggressively, and consider dropping the raw-log tier entirely in favour of wide span events, which are strictly more useful per byte.

---

## 9. Interview Questions

**Q: What is the difference between monitoring and observability?**
A: Monitoring answers pre-defined questions with pre-built dashboards and alerts — you decided in advance what to watch. Observability is the property that lets you answer *new* questions about system behaviour from existing telemetry, without deploying code. The practical difference is high-cardinality context: if you can slice by user, tenant, API key, client version, and region after the fact, you are observable.

**Q: Why are the three pillars not interchangeable?**
A: They differ in cost model and in what they can express. Metrics are pre-aggregated and cheap but must be low-cardinality, so they tell you *that* something is wrong. Logs are per-event and detailed but have no structure connecting them across services. Traces encode causality and timing across process boundaries, which is the only way to answer "where did the time go". You need all three, joined by `trace_id`.

**Q: What are RED metrics and what should count as an "error"?**
A: Rate, Errors, Duration — requests per second, failed requests per second, and the latency distribution, tracked per route. "Error" should mean `5xx` (and usually `429` tracked separately), not `4xx`; a `404` or `422` means the API worked correctly and the client sent something wrong. Mixing them makes your error rate a function of client behaviour and destroys alert quality.

**Q: How does trace context propagate over HTTP?**
A: Via the W3C `traceparent` header, formatted `version-traceid-spanid-flags`, e.g. `00-4bf92f35...4736-00f067aa0ba902b7-01`. The receiving service extracts it, makes the incoming span ID its parent, and injects a new `traceparent` on any outbound call. `tracestate` carries vendor-specific key/value data alongside it. The low bit of `flags` is the sampled decision, propagated so all services agree.

**Q: Why should you never use a raw URL path as a metric label?**
A: Because each unique label combination creates a new time series. `/v1/orders/ord_9f2` produces one series per order, which explodes memory and query time and eventually crashes the metrics backend. Use the route template `/v1/orders/{id}` — the identifier belongs on the span and the log line, where high cardinality is affordable.

**Q: What is a correlation ID and where should it appear?**
A: A unique identifier for one logical request, generated at the edge (or accepted from the client), propagated to every downstream call, stamped on every log line and span, and returned to the caller in a response header such as `X-Request-Id`. It should also appear in the error body — RFC 9457 problem details are a natural home — so a user can quote it in a support ticket and you can retrieve the exact request.

**Q: (Senior) Your p99 latency doubled but p50 is flat and every downstream service reports healthy p99. How do you investigate?**
A: A flat p50 with a rising p99 points at a tail phenomenon, not a broad regression: contention, retries, cold caches, GC pauses, connection-pool exhaustion, a single bad node, or fan-out amplification. Query traces filtered to duration above the p99 threshold and compare their span composition against fast traces — usually one span type dominates. Check saturation signals (in-flight requests, pool wait time, queue depth) which lead latency, and slice by pod, availability zone, and client version, since "healthy p99 everywhere" often means one instance is terrible and averaging hides it. Also verify you are not merging percentiles incorrectly across pods.

**Q: (Senior) Design a sampling strategy for 500k requests/second where the trace bill is capped and no error may be lost.**
A: Two tiers. At the SDK, sample at 100% but export only to a local Collector agent (cheap, in-process, no long-haul network). At a gateway Collector tier, apply tail sampling with a `loadbalancing` exporter keyed on `trace_id` so every span of a trace lands on the same instance: keep 100% of traces containing an error span or a `5xx`, 100% above a latency threshold, plus a probabilistic 0.1% baseline for exemplars, and add a per-route rate limiter so one hot endpoint cannot consume the whole budget. Separately, keep RED metrics at 100% — they are cheap and are the alerting source of truth — and use exemplars to bridge from a metric spike into a retained trace. Accept the trade-off: `decision_wait` adds buffering memory and delays trace availability by seconds.

**Q: (Senior) A trace stops at your service boundary and the downstream spans never appear. What are the likely causes?**
A: In rough order: the downstream is not instrumented at all; the HTTP client is not instrumented so `traceparent` is never injected; a proxy or WAF strips unknown headers; the call crosses an async boundary (queue, background task) where context is not serialized into message headers; context is lost across a thread pool or a new event loop because the SDK's context propagation is `contextvars`-based; or the sampled flag is `00` so the downstream drops the span. Verify by dumping the outbound headers on the client side and the inbound headers on the server side — one of those two will be missing the header.

**Q: When would you choose wide structured events over separate logs and metrics?**
A: When your dominant debugging need is arbitrary high-cardinality slicing — "show me p99 for tenant X on client version Y in region Z". One wide event per request, with dozens of dimensions, lets you compute both the metric and the narrative from the same record and correlates naturally with the trace. The trade-off is that you need a columnar event store rather than Prometheus, retention is expensive, and cheap long-horizon aggregate metrics still argue for keeping a small metrics tier.

**Q: How do you keep observability from becoming the biggest line item on the bill?**
A: Budget it explicitly as a share of infrastructure spend and control the three drivers: metric cardinality (track active series and alert on growth), log bytes per request (never log bodies by default; one event per unit of work), and trace volume (tail sampling). Then enforce retention tiers — short for traces, medium for logs, long only for aggregated metrics. Drop or aggregate at the Collector, before egress, where it is cheapest.

**Q: What is `Server-Timing` and when is it useful?**
A: A standard response header (`Server-Timing: db;dur=41, cache;dur=3, total;dur=88`) that reports server-side timing breakdowns to the client. Browsers surface it natively in devtools and the Resource Timing API, so front-end engineers can attribute slowness without access to your backend tooling. It is a cheap, high-value complement to tracing, though you should be careful not to leak internal architecture details on a public API.

---

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Emit **structured JSON logs** with `trace_id`, `span_id`, and `request_id` stamped automatically by middleware — one event per request, never request bodies. Expose **RED metrics** per route template: rate, `5xx` error rate, and a latency **histogram** (never an average, never a per-pod percentile average — sum buckets then `histogram_quantile`). Instrument **traces** with OpenTelemetry, propagate W3C `traceparent`, auto-instrument the HTTP client and DB driver before your own code, use `BatchSpanProcessor`, and apply **tail sampling** at the Collector so you keep 100% of errors and slow traces at ~1% cost. Keep high-cardinality identifiers on spans and logs, low-cardinality labels on metrics. Attach **exemplars** so a metric spike is one click from a trace, and echo **`X-Request-Id`** on every response including errors so support tickets become lookups. The debugging loop is metrics → exemplar → trace → logs.

| Item | Value / Rule |
|---|---|
| `traceparent` | `00-<32 hex trace-id>-<16 hex span-id>-<2 hex flags>`; low flag bit = sampled |
| `tracestate` | Vendor key/value list travelling with the trace |
| `X-Request-Id` | Accept from client or generate a ULID; echo on **every** response |
| `Server-Timing` | `db;dur=41, total;dur=88` — surfaced natively in browser devtools |
| Metric labels | `method`, `route` (template), `status` — nothing user-specific |
| Span attributes | `http.request.method`, `url.path`, `http.route`, `http.response.status_code`, `db.system`, `enduser.id` |
| Error rate | `5xx` only; `429` tracked separately; `4xx` is a client-health signal |
| Latency | Histogram buckets ~5 ms → 10 s; alert on p95/p99, never mean |
| Sampling | Tail: 100% errors + 100% slow + ~1% baseline |
| Retention | Traces 7–14 d · Logs 30 d · Aggregated metrics 13 mo |

Flash cards:
- **Which signal answers "where did the time go"?** → Traces; metrics say *that* it is slow, logs say *what* happened.
- **What must never be a metric label?** → Anything high-cardinality — user IDs, order IDs, raw URL paths.
- **How do you merge p99 across pods?** → Sum the histogram buckets, then apply `histogram_quantile` once.
- **Why tail sampling over head sampling?** → It keeps 100% of errors and slow traces while sampling the boring majority.
- **The one header that turns support tickets into lookups?** → `X-Request-Id`, echoed on every response and in the problem body.

---

## 11. Hands-On Exercises & Mini Project

- [ ] Convert an existing service's logs to JSON and add a logging filter that injects `trace_id`, `span_id`, and `request_id` with zero changes at the call sites.
- [ ] Add a RED histogram to one endpoint and write the three PromQL queries; then deliberately add a raw path label, observe the series count explode in `/metrics`, and remove it.
- [ ] Instrument two services with OpenTelemetry, propagate `traceparent`, and produce a trace where the child span is clearly the bottleneck.
- [ ] Break the trace on purpose (drop the header in a proxy) and practise diagnosing why the downstream spans vanished.
- [ ] Configure an OTel Collector with tail sampling that keeps all errors and all traces over 500 ms plus 1% of the rest, and verify with a load generator that error traces are never dropped.

**Mini Project — Observable Orders API.**
*Goal:* A three-service system (`gateway` → `orders` → `inventory`, plus an outbound mocked payments call) that is fully observable end to end.
*Requirements:* JSON structured logs with automatic correlation; `X-Request-Id` generated at the gateway, propagated, echoed on all responses, and embedded in RFC 9457 problem documents; W3C trace context across every hop including a Kafka publish/consume boundary using span links; RED metrics per route with correct templates and exemplars; a docker-compose stack with OTel Collector, Prometheus, Tempo, Loki, and Grafana; one Grafana dashboard implementing the metrics → exemplar → trace → logs pivot.
*Extension ideas:* Add a synthetic slow dependency and demonstrate fan-out tail amplification with a load test; add a span processor that redacts PII attributes before export and prove it with a test; add `Server-Timing` and read it from browser devtools; measure and report bytes of telemetry per request, then halve it without losing debuggability.

---

## 12. Related Topics & Free Learning Resources

Sibling chapters: **Monitoring, SLOs & Incident Response** (turning these signals into error budgets and pages), **APIs in Microservices Architectures** (why cross-service causality is mandatory), **API Gateways & the BFF Pattern** (where the correlation ID is born), **Error Handling & Problem Details** (RFC 9457 as the carrier of `request_id`), and **Mocking, Stubs & Sandbox Environments** (keeping correlation alive across mocked boundaries).

**Free Learning Resources**
- **OpenTelemetry Documentation** — CNCF · *Intermediate* · the reference for SDKs, the Collector, semantic conventions, and sampling; start with the language-specific "Getting Started". <https://opentelemetry.io/docs/>
- **W3C Trace Context** — W3C Recommendation · *Intermediate* · the exact `traceparent`/`tracestate` grammar and the rules for forwarding them. <https://www.w3.org/TR/trace-context/>
- **Google SRE Book — Monitoring Distributed Systems** — Google · *Intermediate* · the four golden signals and why symptom-based monitoring beats cause-based. <https://sre.google/sre-book/monitoring-distributed-systems/>
- **The RED Method** — Tom Wilkie / Grafana Labs · *Beginner→Intermediate* · a short, opinionated recipe for instrumenting request-driven services. <https://grafana.com/blog/2018/08/02/the-red-method-how-to-instrument-your-services/>
- **Dapper, a Large-Scale Distributed Systems Tracing Infrastructure** — Sigelman et al., Google · *Advanced* · the original paper that defined spans, propagation, and sampling. <https://research.google/pubs/pub36356/>
- **The Tail at Scale** — Dean & Barroso, CACM · *Advanced* · why fan-out turns rare slowness into common slowness, and what to do about it. <https://research.google/pubs/pub40801/>
- **Prometheus — Histograms and Summaries** — Prometheus · *Intermediate* · how quantile estimation actually works and why you must aggregate buckets, not percentiles. <https://prometheus.io/docs/practices/histograms/>
- **MDN — Server-Timing** — MDN Web Docs · *Beginner* · syntax and browser support for exposing backend timings to the client. <https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Server-Timing>

---

*REST API Handbook — chapter 38.*
