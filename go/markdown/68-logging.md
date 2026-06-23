# 68 · Logging

> **In one line:** Logging is the disciplined emission of structured, leveled event records to durable streams so that running systems become observable, debuggable, and auditable.

---

## 1. Overview

Logging is how a program tells you what it is doing while it runs. In Go this spans three eras of tooling: the venerable `log` package (simple, unstructured, goroutine-safe), third-party structured loggers (`zap`, `zerolog`, `logrus`), and the modern standard-library `log/slog` (structured, leveled, handler-based) added in Go 1.21.

A log line is a fact about a moment: a request arrived, a payment failed, a cache missed. Good logging turns an opaque binary into a narratable system. The three decisions that define a logging strategy are: **what level** (severity), **what structure** (key/value vs free text), and **what destination** (stdout, a file, a collector). This chapter covers all three, with a bias toward production-grade `slog` usage.

The zariya principle: don't memorize the `log.Printf` format verbs. Understand *why* you log to stdout in containers, *why* levels exist, and *why* structured logging beats `fmt.Sprintf` strings when you have 10,000 lines per second to query.

## 2. Why It Exists

Before logging frameworks, debugging meant `fmt.Println` scattered through code and deleted before commit. That doesn't survive contact with production: you can't attach a debugger to a service handling live traffic, and the bug only reproduces at 3 a.m. under load. Logging exists to make the *past* inspectable.

Specifically:

- **Severity triage** — `log levels` (DEBUG/INFO/WARN/ERROR) let operators filter noise. You log liberally at DEBUG, run at INFO in production, and alert on ERROR.
- **Structure for machines** — humans read sentences; log pipelines (Loki, Elasticsearch, Datadog) query fields. `user_id=42 latency_ms=210` is grep-able and aggregatable; "user 42 took a while" is not.
- **Decoupling emission from routing** — a handler/backend abstraction means application code says "log this event" without knowing whether it lands in a file, stdout, or Kafka.

The standard `log package` exists for the simplest case; `slog` exists because every serious service eventually needs levels and structure, and the ecosystem had fragmented into incompatible logger interfaces.

## 3. Internal Working

Two implementations matter: `log.Logger` and `slog`.

**`log.Logger`** wraps an `io.Writer` guarded by a `sync.Mutex`. Each `Output` call formats the prefix/timestamp into a reused `[]byte` buffer field on the logger, then performs a *single* `w.Write` under the mutex. The single write is what makes concurrent logging interleave-free: two goroutines never split a line.

```text
log.Logger struct (simplified)
+------------------+
| mu   sync.Mutex  |  <- serializes Output()
| prefix string    |
| flag  int        |  (Ldate|Ltime|Lshortfile ...)
| out   io.Writer  |  --> os.Stderr by default
| buf   []byte     |  <- reused scratch buffer
+------------------+

Output(): lock -> format header into buf -> append msg
          -> out.Write(buf) (ONE syscall) -> unlock
```

**`slog`** splits into three layers:

```text
  application                  frontend            backend
+--------------+   Record   +-----------+        +-----------+
| slog.Logger  |----------->|  Handler  |------->| io.Writer |
| .Info(msg,kv)|            | (Text/    |        | (stdout,  |
+--------------+            |  JSON)    |        |  file...) |
                            +-----------+        +-----------+
        Attrs ([]slog.Attr) carried as key/Value pairs
```

A `slog.Record` holds the message, time, a `Level`, a PC (program counter for source location), and up to a small number of inline `Attr`s with overflow spilling to a heap slice — a deliberate optimization so the common case (few attributes) avoids allocation. A `slog.Value` is a tagged union (`kind` + a `uint64` + an `any`) so primitives like `int`/`bool`/`Duration` are stored *without boxing into `interface{}`*, dodging an allocation per field.

`Level` is just an `int` (`Debug=-4, Info=0, Warn=4, Error=8`). The gaps allow custom intermediate levels. The killer detail: `Logger.Info` first calls `Handler.Enabled(ctx, level)`; if the configured level is above the call's level, the record is **never constructed** — arguments are still evaluated, but no formatting/allocation happens. This is why a disabled DEBUG line is cheap.

The handler does the actual serialization. `JSONHandler` writes one JSON object per line (JSONL); `TextHandler` writes `key=value` pairs. Both append into a buffer and issue one write, mirroring `log.Logger`'s atomicity guarantee.

## 4. Syntax

```go
package main

import (
	"log"
	"log/slog"
	"os"
)

func main() {
	// Classic log package
	log.SetFlags(log.LstdFlags | log.Lshortfile)
	log.Printf("starting on port %d", 8080)

	// slog: text handler to stdout
	h := slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelDebug,
	})
	logger := slog.New(h)

	logger.Info("server started", "port", 8080, "env", "prod")
	logger.Warn("cache miss", slog.Int("key", 42))
	logger.Error("db query failed", slog.String("table", "users"))

	// Make it the package-global default
	slog.SetDefault(logger)
	slog.Info("now usable without a logger variable")
}
```

Key/value pairs come in two forms: loose (`"port", 8080`) and typed (`slog.Int("port", 8080)`). The typed form is faster and panic-safe (loose pairs can desync if you pass an odd count).

## 5. Common Interview Questions

**Q1. Why log to stdout/stderr in a containerized service instead of a file?**
The Twelve-Factor model treats logs as event streams: the app writes to `stdout`, and the runtime (Docker, Kubernetes, systemd) captures and routes them. The app shouldn't own file paths, `rotation`, or shipping. *Follow-up: what about rotation then?* The platform handles it — `kubectl logs` reads the container runtime's rotated files; you configure `containerLogMaxSize`. The app stays stateless.

**Q2. Is `log.Println` safe to call from many goroutines?**
Yes. `log.Logger` serializes every `Output` with a mutex and writes each line in a single `Write`, so lines never interleave. *Follow-up: does that serialize the formatting too?* Yes — formatting happens under the lock, which can become a contention point at very high throughput; that's an argument for `zerolog`/`zap` which format lock-free into per-call buffers.

**Q3. Difference between `slog` and `log`?**
`log` is unstructured and unleveled (one severity). `slog` adds levels and structured key/value attributes with pluggable handlers (JSON/Text/custom). *Follow-up: can they coexist?* Yes — `slog.NewLogLogger` bridges an `slog.Handler` back into a `*log.Logger` for libraries that only accept the old type.

**Q4. What's the cost of a disabled debug log?**
The handler's `Enabled` check rejects it before record construction, so no formatting or allocation occurs — but the *arguments are still evaluated*. `slog.Debug("x", "v", expensive())` still runs `expensive()`. *Follow-up: how do you avoid that?* Guard with `if logger.Enabled(ctx, slog.LevelDebug)` or pass a `slog.LogValuer` whose `LogValue()` is lazy.

**Q5. How do you propagate request-scoped fields (trace ID) without threading them everywhere?**
Use `logger.With("trace_id", id)` to get a child logger, store it in `context.Context`, and use `slog.InfoContext`. With a context-aware handler, fields like trace IDs are pulled from the context automatically. *Follow-up: why not a global mutable logger?* It's not request-isolated and creates data races / cross-request field bleed.

**Q6. Why are structured logs better for production?**
They're machine-queryable: aggregate `count by status_code`, alert on `level=error AND service=payments`. Free-text requires fragile regex. *Follow-up: downside?* Verbosity and ingestion cost — JSON is larger; high-cardinality fields explode index size in Elasticsearch/Loki.

**Q7. What log level for a recovered panic in an HTTP middleware?**
`ERROR` (the request failed unexpectedly), with the stack trace as an attribute — not `FATAL`, because `FATAL`/`os.Exit` would kill the whole server for one bad request. *Follow-up: when is FATAL ever right?* Only at startup for unrecoverable config/dependency failures before serving traffic.

## 6. Production Use Cases

- **Kubernetes + Loki/Promtail:** services log JSON to stdout; Promtail tails container logs and ships to Grafana Loki, where `{app="api"} | json | level="error"` queries run. Almost every cloud-native Go shop uses this shape.
- **Uber & `zap`:** Uber built `zap` for sub-microsecond, zero-allocation structured logging across thousands of Go services where `logrus`'s reflection-based encoding was too slow.
- **Datadog / ELK ingestion:** structured JSON with consistent field names (`dd.trace_id`, `service`) lets logs auto-correlate with traces and metrics.
- **Audit logs in fintech:** payment systems emit immutable, append-only audit records (who did what, when) at a dedicated level/stream, separate from operational logs, for compliance (PCI-DSS, SOC 2).
- **CLI tools (`kubectl`, `terraform`):** use leveled logging (`-v` verbosity flags via `klog`) so users opt into detail.

## 7. Common Mistakes

> [!WARNING]
> Logging secrets. Tokens, passwords, PII, full request bodies — once in a log pipeline they're replicated everywhere and become a breach. Redact at the source.

- **Odd key/value counts in `slog`:** `logger.Info("x", "a", 1, "b")` — the dangling `"b"` becomes a `!BADKEY`. Prefer typed attrs (`slog.Int`).
- **Logging inside hot loops at INFO:** floods the pipeline and dominates CPU. Use DEBUG or sampling.
- **Using `log.Fatal` in library code:** it calls `os.Exit(1)`, skipping deferred cleanup and giving the caller no recovery. Return errors instead.
- **String-concatenating context:** `log.Printf("user %s did %s", u, a)` is unqueryable. Use fields.
- **Logging *and* returning an error:** double-counts the failure; the caller logs it again. Decide one owner — usually the top-level handler logs.
- **Writing your own file rotation:** races, partial lines, disk-full hangs. Delegate to the platform or `lumberjack`.

## 8. Performance Considerations

The hidden cost of logging is usually *allocation* and *contention*, not the write itself.

| Logger | Style | ~Alloc/line | Notes |
|---|---|---|---|
| `log` | unstructured | low | mutex-serialized format+write |
| `slog` + JSONHandler | structured | low (typed attrs) | tagged-union avoids boxing |
| `zap` (sugared) | structured | low | reflection on `Any` |
| `zap` (typed) | structured | ~0 | fastest mainstream |
| `zerolog` | structured | ~0 | builder API, lock-free buffers |
| `logrus` | structured | high | `map`-based, reflection-heavy |

Levers:

- **Level-gate early.** A disabled DEBUG avoids record construction in `slog`, but not argument evaluation — gate expensive args explicitly.
- **Typed attrs over loose pairs** — `slog.Int(...)` skips an `interface{}` box.
- **Asynchronous writers** decouple the hot path from slow I/O, at the risk of losing buffered logs on crash. `zap` ships a buffered `WriteSyncer`.
- **Sampling** — under a log storm, emit 1-in-N identical lines (`zap.Sampler`) to cap volume.
- **Stdout is a pipe**; if the consumer stalls, writes block. In extreme throughput this backpressures your request path — a real outage cause.

> [!TIP]
> Measure with `go test -bench -benchmem`. A line that allocates 5 objects × 100k req/s is 500k allocs/s of GC pressure you can often halve with typed attrs.

## 9. Best Practices

- **Log to stdout in JSON in production**, pretty text locally. Switch handlers by environment.
- **One leveled, structured logger**, injected via constructor or context — not a tangle of globals.
- **Stable field names** (`user_id`, not sometimes `uid`). Define them as constants.
- **Attach request context once** with `With(...)` per request; child loggers inherit it.
- **Reserve ERROR for actionable failures.** If no human acts on it, it's WARN or INFO.
- **Never log secrets/PII**; build redaction into custom `slog.Value`/`LogValuer` types.
- **Include a trace/correlation ID** in every line so logs join with distributed traces.
- **Let the platform rotate.** Don't reinvent rotation in-process.

## 10. Code Examples

Primary: a production-style `slog` setup with environment-based handler selection, context-propagated trace IDs, and a `LogValuer` for redaction.

```go
package main

import (
	"context"
	"log/slog"
	"os"
)

type ctxKey struct{}

// Token redacts itself when logged.
type Token string

func (t Token) LogValue() slog.Value { return slog.StringValue("REDACTED") }

func newLogger(env string) *slog.Logger {
	opts := &slog.HandlerOptions{Level: slog.LevelInfo, AddSource: env != "prod"}
	var h slog.Handler
	if env == "prod" {
		h = slog.NewJSONHandler(os.Stdout, opts)
	} else {
		h = slog.NewTextHandler(os.Stdout, opts)
	}
	return slog.New(h)
}

func withTrace(ctx context.Context, l *slog.Logger, id string) context.Context {
	return context.WithValue(ctx, ctxKey{}, l.With("trace_id", id))
}

func fromCtx(ctx context.Context, base *slog.Logger) *slog.Logger {
	if l, ok := ctx.Value(ctxKey{}).(*slog.Logger); ok {
		return l
	}
	return base
}

func main() {
	base := newLogger(os.Getenv("APP_ENV"))
	ctx := withTrace(context.Background(), base, "req-abc-123")

	log := fromCtx(ctx, base)
	log.InfoContext(ctx, "payment processed",
		slog.Int("amount_cents", 4999),
		slog.Any("token", Token("sk_live_supersecret")), // -> REDACTED
	)
	log.WarnContext(ctx, "retrying", slog.Int("attempt", 2))
}
```

Alternative: zero-allocation hot-path logging with `zerolog`, for services where `slog`'s per-line overhead shows up in profiles.

```go
package main

import (
	"os"

	"github.com/rs/zerolog"
)

func main() {
	logger := zerolog.New(os.Stdout).
		With().Timestamp().Str("service", "api").Logger().
		Level(zerolog.InfoLevel)

	logger.Info().
		Int("amount_cents", 4999).
		Str("currency", "USD").
		Msg("payment processed") // single lock-free write, ~0 allocs

	// Sampled debug to survive a log storm.
	sampled := logger.Sample(&zerolog.BasicSampler{N: 100})
	sampled.Debug().Msg("cache lookup") // every 100th line
}
```

## 11. Advanced Concepts

**Handler composition.** `slog`'s power is the `Handler` interface (`Enabled`, `Handle`, `WithAttrs`, `WithGroup`). You can wrap handlers like middleware: a `ContextHandler` that injects `trace_id` from context, a `SamplingHandler`, a `MultiHandler` that fan-outs to both stdout and a file. `WithAttrs` must *pre-render* shared attributes once so per-line cost stays low — that's the contract that makes `With(...)` cheap.

**`LogValuer` for laziness and security.** A type implementing `LogValue() slog.Value` is resolved only when actually emitted, giving free lazy evaluation and a clean redaction seam (as shown above).

**Groups and namespacing.** `logger.WithGroup("http").Info("done", "status", 200)` nests fields (`http.status` in JSON), preventing key collisions when merging logs from subsystems.

**Bridging the ecosystem.** `slog.NewLogLogger(handler, level)` produces a `*log.Logger` so a library hard-wired to the old `log` type still flows into your structured pipeline. Conversely `slog.SetDefault` redirects the global `log` package output through `slog`.

**Async + durability trade-off.** Buffered/async logging hides I/O latency but a crash drops the buffer. Critical audit logs should be synchronous (or fsync'd); operational logs can be lossy.

## 12. Debugging Tips

- **No logs appearing?** Check the level — a logger set to `LevelWarn` silently drops `Info`. Also confirm the `io.Writer` (a closed file or full pipe eats writes).
- **Interleaved/garbled lines** usually mean two loggers wrap the *same* file with separate buffers, or someone wrote to the `io.Writer` directly. One logger per destination.
- **`!BADKEY` in output** = odd number of loose key/value args. Switch to typed attrs.
- **Source location wrong** (points at your wrapper, not the caller): the wrapper added a stack frame; capture the PC at the right depth with `runtime.Callers(...)` and build the `slog.Record` manually.
- **High CPU in logging frames** in a pprof profile: you're logging in a hot loop or using a reflection-heavy logger; move to DEBUG, sample, or switch encoders.
- **Local pretty-printing:** pipe JSON logs through `jq` or `humanlog` instead of changing the app's handler.

## 13. Senior Engineer Notes

A senior engineer treats the logger as a dependency, not a global convenience. In code review, flag any `fmt.Println`/`log.Printf` in service code, any logged-and-returned error (pick one owner), and any string-interpolated context that should be a field. Push for typed attrs and stable field-name constants so dashboards don't break when someone renames `uid`.

Mentor juniors on the level discipline: ERROR means "page someone or investigate," WARN means "degraded but handled," INFO is the narrative of normal operation, DEBUG is for development. The most common junior anti-pattern is everything-at-INFO, which makes the signal-to-noise ratio useless during an incident.

Own the request-scoped logging pattern: a logger enriched with `trace_id`/`user_id` flows through context so every line in a request is automatically correlated. Catch redaction gaps early — a `LogValuer` on your `Token`/`Email` types is far safer than relying on every call site to remember. Know the performance envelope: be able to say "this path logs 3 lines × 50k rps, that's our GC tax, here's the benchmark."

## 14. Staff Engineer Notes

At staff level, logging is an *org-wide contract and a cost center*. You standardize the schema across services — agreed field names, a shared logger module wrapping `slog` with the company's handler stack (context injection, redaction, sampling) so 200 services emit logs a single pipeline can parse. Inconsistent schemas are the silent tax that makes cross-service debugging impossible.

Build-vs-buy is a real decision: self-hosted Loki/ELK is cheap per-GB but operationally heavy; Datadog/Splunk are turnkey but bill aggressively on ingestion and cardinality. At scale, log volume *is* a budget line — a single chatty INFO line at 100k rps can cost five figures a month. Drive policy: sampling, retention tiers (hot 7 days, cold 90), and dropping high-cardinality fields at the edge.

Define the observability boundary: logs for events and forensics, metrics for aggregates and alerting, traces for request flow. Teams that alert on log-grep instead of metrics build fragile, expensive monitoring. Mandate trace-ID correlation so the three pillars join. Finally, treat secret-in-logs as a security incident class: enforce redaction in the shared library and scan the pipeline, because you cannot trust 50 teams to never log a token.

## 15. Revision Summary

- **Three eras:** `log` (simple, unstructured, mutex-serialized), third-party (`zap`/`zerolog`, fast/zero-alloc), and `log/slog` (stdlib structured + leveled, handler-based).
- **Levels:** DEBUG/INFO/WARN/ERROR; in `slog` they're ints (Info=0, Error=8) with gaps for custom levels; `Enabled` gates record construction (but not arg evaluation).
- **Structure beats strings:** key/value fields are machine-queryable; prefer typed attrs (`slog.Int`) over loose pairs to avoid boxing and `!BADKEY`.
- **Destination:** log JSON to **stdout** in containers; let the platform handle **rotation** and shipping (Twelve-Factor).
- **`slog` internals:** Logger → Handler (Text/JSON) → io.Writer; `Record` holds inline attrs; `Value` is a tagged union avoiding allocations.
- **Patterns:** `With(...)` child loggers, context propagation of trace IDs, `LogValuer` for lazy/redacted fields, handler composition.
- **Pitfalls:** secrets in logs, `log.Fatal` in libraries, logging in hot loops, double-logging errors, DIY rotation.
- **Perf:** allocation + lock contention dominate; gate, type, sample, and beware stdout backpressure.

**References:** `log/slog` (Go 1.21+ standard library), `log` package, `go.uber.org/zap`, `github.com/rs/zerolog`, `github.com/natefinch/lumberjack`, The Twelve-Factor App (logs as event streams).

---

*Go Engineering Handbook — topic 68.*
