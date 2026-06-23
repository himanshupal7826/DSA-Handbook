# 63 · Middleware

> **In one line:** Middleware is the decorator pattern applied to HTTP handlers — composable wrappers that add logging, auth, recovery, and tracing without touching business logic.

---

## 1. Overview

Middleware is a function that takes an `http.Handler` and returns a new `http.Handler`, wrapping the original with extra behavior that runs *before* and/or *after* the wrapped handler. Because the signature is closed under composition (`Handler → Handler`), you can stack many of them into a **handler chain**: a request flows down through each layer (request phase), hits the core handler, then unwinds back up (response phase).

In Go this pattern is idiomatic precisely because the standard library exposes a tiny, stable interface:

```go
type Handler interface {
    ServeHTTP(ResponseWriter, *Request)
}
```

Everything — routers, mux, middleware — speaks this one interface. A middleware is therefore the **decorator** design pattern, specialized to `net/http`. The cross-cutting concerns you almost always want — request logging, panic **recovery**, authentication, rate limiting, CORS, gzip, request IDs, and distributed **tracing** — live as middleware so the handler stays focused on one job.

This chapter shows how the chain is actually built and executed by the runtime, the canonical signatures, the mistakes that cost production incidents, and how senior/staff engineers reason about middleware as architecture.

## 2. Why It Exists

Without middleware, cross-cutting logic gets copy-pasted into every handler: every endpoint opens with the same logging boilerplate, the same `defer recover()`, the same token check. That violates DRY, drifts out of sync, and makes a security fix (say, a header you forgot to set) a 200-file change.

Middleware exists to solve **separation of cross-cutting concerns**:

- **Reuse** — write recovery once, apply to all routes.
- **Composition** — order and combine concerns declaratively (`Use(Logger, Recover, Auth)`).
- **Testability** — each layer is a small pure-ish wrapper you can unit test in isolation.
- **Uniformity** — guarantees that *every* request gets a request ID, *every* panic is caught.

The alternative — frameworks with magic lifecycle hooks — sacrifices the explicitness Go prizes. The `Handler → Handler` decorator keeps the data flow visible and the type system honest: there is no hidden registry, just function composition.

## 3. Internal Working

A middleware is a closure. When you write `Logging(next)`, the Go compiler allocates a closure that **captures** `next` (the inner handler) in its environment. The returned `http.HandlerFunc` is a function value: a two-word struct internally — a pointer to the function's code and a pointer to the captured environment (the closure context holding `next`). That environment lives on the heap because it escapes (it's returned and stored), which `go build -gcflags=-m` will report as `next escapes to heap`.

Building a chain is just nested closures. `Recover(Logging(Auth(handler)))` produces a linked structure of function values, each pointing inward:

```text
  Request ──▶ Recover.ServeHTTP
                 │  (defer recover set up)
                 ▼
              Logging.ServeHTTP
                 │  (record start time)
                 ▼
              Auth.ServeHTTP
                 │  (validate token)
                 ▼
              handler.ServeHTTP   ◀── core logic
                 │
        ┌────────┘  unwind (return)
        ▼
   Auth returns ──▶ Logging logs duration ──▶ Recover's defer runs
                                                       │
                                                  Response ◀──
```

Each arrow down is a normal **function call** pushing a stack frame; `ServeHTTP` of the outer middleware calls `next.ServeHTTP`, which calls the next, and so on. There is no central dispatcher — execution is the natural call/return of the Go call stack. The "after" code (logging duration, recover) is whatever you place *after* the `next.ServeHTTP(w, r)` line or inside a `defer`.

Memory-wise: the entire chain is built **once at startup** when you register routes, not per request. So the closure allocations are paid a single time. Per request, only the call frames and any per-request allocations (e.g., a `responseWriter` wrapper, a context value) cost anything. The `*http.Request` is passed by pointer; middleware that needs to add data clones the request with `r.WithContext(ctx)` — this allocates a shallow copy of the `Request` struct (cheap, ~a few hundred bytes) plus a new `context.valueCtx` node.

> [!NOTE]
> `r.Context()` is backed by an immutable linked list of `context.Context` nodes. Each middleware that calls `WithValue` prepends a node, so value lookup is O(depth). Don't stuff dozens of values in context.

## 4. Syntax

The canonical middleware type and a constructor:

```go
// Middleware wraps a handler and returns a new one.
type Middleware func(http.Handler) http.Handler

func Logging(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()
        next.ServeHTTP(w, r) // call inner
        log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start))
    })
}
```

Manual chaining (inside-out) versus a chain helper:

```go
// Inside-out: handler is innermost, Recover is outermost.
h := Recover(Logging(Auth(handler)))
http.Handle("/api/", h)

// A small helper to read left-to-right (first runs first).
func Chain(h http.Handler, mws ...Middleware) http.Handler {
    for i := len(mws) - 1; i >= 0; i-- {
        h = mws[i](h)
    }
    return h
}
// Chain(handler, Recover, Logging, Auth) == Recover(Logging(Auth(handler)))
```

With **chi** the syntax is `r.Use(...)`:

```go
r := chi.NewRouter()
r.Use(middleware.RequestID)
r.Use(middleware.Logger)
r.Use(middleware.Recoverer)
r.Get("/health", healthHandler)
```

## 5. Common Interview Questions

**Q1. What is the signature of an HTTP middleware in Go, and why that shape?**
`func(http.Handler) http.Handler`. It's closed under composition, so middleware can be chained arbitrarily, and it relies only on the stable `http.Handler` interface so it works with any router.
*Follow-up: Why not `func(http.HandlerFunc) http.HandlerFunc`?* That couples you to the concrete func type; `http.Handler` also accepts structs (e.g., `http.FileServer`), so the interface form is more general.

**Q2. Does middleware order matter? Give an example where it changes behavior.**
Yes. Recovery must be *outermost* so it catches panics from every inner layer including logging. If you put Auth before Logging, unauthorized requests never get logged. Gzip must wrap before anything that writes the body.
*Follow-up: Where does the request-ID middleware belong?* Near the top, so the ID is available to logging, tracing, and the handler downstream.

**Q3. How do you pass data from one middleware to the handler?**
Via `context.Context`: `r = r.WithContext(context.WithValue(r.Context(), key, val))`, then `next.ServeHTTP(w, r)`. Use an unexported key type to avoid collisions.
*Follow-up: Why not a `map` or global?* Globals aren't request-scoped and aren't goroutine-safe per request; context is request-scoped and cancellation-aware.

**Q4. How do you capture the HTTP status code for logging when `ResponseWriter` doesn't expose it?**
Wrap `ResponseWriter` in a struct that records the code in its `WriteHeader` method, defaulting to 200. Pass the wrapper down.
*Follow-up: What interface must your wrapper still satisfy?* Ideally `http.Flusher`, `http.Hijacker`, and `io.ReaderFrom` via embedding/forwarding, or you break websockets and SSE.

**Q5. How does recovery middleware work, and what should it return?**
A `defer func(){ if rec := recover(); rec != nil { ... } }()` around `next.ServeHTTP`. It logs the panic + stack, then writes `500`. It should only write a response if headers haven't already been sent.
*Follow-up: Can it recover a panic in a goroutine the handler spawned?* No — `recover` only catches panics in the same goroutine. Spawned goroutines need their own recovery.

**Q6. What's the performance cost of a deep middleware chain?**
Mostly call-frame overhead (nanoseconds) plus any per-request allocations each layer adds (context nodes, RW wrappers). The closures are built once at startup, so chain depth itself is cheap; the allocations are what to watch.
*Follow-up: How would you measure it?* `go test -bench -benchmem` on the chain, and `pprof` allocation profiles in prod.

**Q7. How do you apply middleware to some routes but not others?**
Group routes: chi `r.Group`/`r.Route` with a scoped `Use`, or build two chains. Mount the auth chain on `/api`, the public chain on `/`.
*Follow-up: How in plain net/http 1.22?* Register a sub-mux or wrap per-pattern handlers individually, since the std mux has no group concept.

**Q8. Difference between middleware and an `http.RoundTripper`?**
Middleware decorates *server-side* handlers; `RoundTripper` decorates *client-side* requests (`http.Client.Transport`). Same decorator idea, opposite side of the wire.
*Follow-up: Use case for RoundTripper middleware?* Client retries, outbound auth headers, client-side tracing propagation.

## 6. Production Use Cases

- **chi `middleware` package** (used by Cloudflare and many Go shops): ships `RequestID`, `RealIP`, `Logger`, `Recoverer`, `Timeout`, `Throttle`, `Compress` — the de facto standard set.
- **gRPC interceptors** are the same pattern for RPC: `grpc-ecosystem/go-grpc-middleware` chains auth, logging, and Prometheus metrics interceptors the way HTTP middleware chains handlers.
- **OpenTelemetry** (`otelhttp.NewHandler`) is middleware that starts a span per request and injects trace context — used across Uber, Shopify, and most observability stacks.
- **Auth gateways**: Google Cloud's IAP and Envoy's ext_authz are middleware-shaped (decorate the request with identity before forwarding).
- **Rate limiting**: Stripe-style token-bucket limiters live as middleware so every endpoint inherits the policy.
- **Prometheus**: `promhttp.InstrumentHandlerDuration` wraps handlers to emit RED metrics (Rate, Errors, Duration).

## 7. Common Mistakes

> [!WARNING]
> The single most common production bug: putting **Recover not outermost**, so a panic in the Logging middleware (or in Auth) takes down the goroutine and the connection without a 500.

- **Calling `next.ServeHTTP` conditionally and forgetting the early return.** If Auth fails you must `return` after writing 401, or the handler runs anyway.
- **Writing the body before `WriteHeader`.** Once any `Write` happens, the status is locked to 200; a later `WriteHeader(500)` logs "superfluous WriteHeader call" and is ignored.
- **Using a `string` context key**, risking collisions. Always use an unexported `type ctxKey int`.
- **Mutating the shared `*http.Request` fields** instead of cloning with `WithContext`. The request can be referenced concurrently in edge cases.
- **Swallowing the inner error** in recovery and returning 200.
- **Building the chain per request** inside the handler — wasteful re-allocation; build once at startup.
- **Wrapping `ResponseWriter` without forwarding `Flush`/`Hijack`**, breaking SSE and websockets.

## 8. Performance Considerations

Middleware is cheap when written carefully and expensive when sloppy. Key facts:

| Cost source | When it bites | Mitigation |
|---|---|---|
| Closure allocation | Startup only | Negligible; ignore |
| Call-frame per layer | Per request, ns | Ignore until 50+ layers |
| `WithContext` clone | Per layer that adds context | Batch context writes |
| RW wrapper allocation | Per request, per wrapper | `sync.Pool` the wrapper |
| Logging I/O | Per request | Async/buffered logger; sample |
| `reflect`/regex in middleware | Per request | Precompile, avoid reflect |

A 5-layer chain typically adds **single-digit microseconds** and a couple of allocations per request — trivial next to network and DB time. The real killers are *synchronous* logging (blocking on disk/stdout), per-request regex compilation, and allocating a fresh `ResponseWriter` wrapper without pooling. Pool the wrapper:

```go
var rwPool = sync.Pool{New: func() any { return &statusWriter{} }}
```

> [!TIP]
> Measure with `go test -bench=. -benchmem`. If `allocs/op` grows with chain depth, a layer is allocating per request — find it with `-memprofile`.

## 9. Best Practices

- Keep the type alias `type Middleware func(http.Handler) http.Handler` and a `Chain` helper for left-to-right readability.
- **Order intentionally**: RequestID → RealIP → Recover → Logger → Tracing → Auth → RateLimit → handler. (Some teams put Recover absolute-outermost so even RequestID panics are caught — pick a rule and document it.)
- One concern per middleware. Don't build a "do-everything" layer.
- Always use an unexported context key type and provide typed getters/setters.
- Make middleware configurable via a constructor returning the middleware (`func Logger(l *slog.Logger) Middleware`), not package globals.
- Forward all optional `ResponseWriter` interfaces when wrapping.
- Respect `r.Context()` cancellation; don't do work after the client disconnects.
- Unit-test each middleware with `httptest.NewRecorder` and a stub `next`.

## 10. Code Examples

Primary idiomatic example — a recovery + logging + request-ID chain with a status-capturing `ResponseWriter`:

```go
package main

import (
    "context"
    "log/slog"
    "net/http"
    "runtime/debug"
    "time"

    "github.com/google/uuid"
)

type ctxKey int

const reqIDKey ctxKey = 0

type statusWriter struct {
    http.ResponseWriter
    status int
}

func (w *statusWriter) WriteHeader(code int) {
    w.status = code
    w.ResponseWriter.WriteHeader(code)
}

func RequestID(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        id := uuid.NewString()
        w.Header().Set("X-Request-ID", id)
        ctx := context.WithValue(r.Context(), reqIDKey, id)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

func Recover(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        defer func() {
            if rec := recover(); rec != nil {
                slog.Error("panic recovered", "err", rec, "stack", string(debug.Stack()))
                http.Error(w, "internal server error", http.StatusInternalServerError)
            }
        }()
        next.ServeHTTP(w, r)
    })
}

func Logging(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()
        sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
        next.ServeHTTP(sw, r)
        id, _ := r.Context().Value(reqIDKey).(string)
        slog.Info("request",
            "id", id, "method", r.Method, "path", r.URL.Path,
            "status", sw.status, "dur", time.Since(start))
    })
}

func Chain(h http.Handler, mws ...func(http.Handler) http.Handler) http.Handler {
    for i := len(mws) - 1; i >= 0; i-- {
        h = mws[i](h)
    }
    return h
}

func main() {
    mux := http.NewServeMux()
    mux.HandleFunc("/hello", func(w http.ResponseWriter, r *http.Request) {
        w.Write([]byte("hi"))
    })
    handler := Chain(mux, RequestID, Recover, Logging)
    http.ListenAndServe(":8080", handler)
}
```

Alternative — the same concerns expressed with **chi**, which gives grouping and ships battle-tested middleware:

```go
package main

import (
    "net/http"

    "github.com/go-chi/chi/v5"
    "github.com/go-chi/chi/v5/middleware"
)

func main() {
    r := chi.NewRouter()
    r.Use(middleware.RequestID)
    r.Use(middleware.RealIP)
    r.Use(middleware.Recoverer)
    r.Use(middleware.Logger)

    // Public routes
    r.Get("/health", func(w http.ResponseWriter, _ *http.Request) {
        w.Write([]byte("ok"))
    })

    // Authenticated group — middleware scoped to this subtree only.
    r.Group(func(r chi.Router) {
        r.Use(AuthMiddleware)
        r.Get("/me", meHandler)
    })

    http.ListenAndServe(":8080", r)
}
```

## 11. Advanced Concepts

**Conditional / per-route middleware.** Build separate chains and mount them, or use chi `Group`/`With(...)` to scope middleware to a subtree without affecting siblings.

**Short-circuiting.** Middleware may *not* call `next` — a cache-hit layer can write the cached response and return, skipping the handler entirely. This is how caching and rate-limit-rejection middleware work.

**The `RoundTripper` mirror.** Client-side middleware decorates `http.RoundTripper`:

```go
type rt struct{ next http.RoundTripper }

func (t rt) RoundTrip(r *http.Request) (*http.Response, error) {
    r.Header.Set("Authorization", "Bearer "+token())
    return t.next.RoundTrip(r) // could add retries here
}
```

**gRPC interceptors** generalize the pattern beyond HTTP: `UnaryServerInterceptor` chains have the same ordering semantics.

**Trace propagation.** Tracing middleware extracts a parent span from incoming headers (`traceparent`), starts a child span, stores it in context, and the outbound `RoundTripper` middleware injects it again — closing the distributed-tracing loop.

**Generics for typed context.** With Go 1.22+, a small generic helper (`Get[T any](r, key) (T, bool)`) removes the repetitive type-assertion boilerplate at context read sites.

## 12. Debugging Tips

- **"superfluous response.WriteHeader call"** in logs → two layers are writing the status; usually an error path that doesn't `return` after `http.Error`.
- **Panic not caught** → Recover isn't outermost, *or* the panic is in a goroutine the handler spawned (separate recover needed).
- **Missing request ID downstream** → a middleware replaced the request via `WithContext` but a later layer used the *original* `r` instead of the one it received. Always thread the same `r`.
- **Wrong durations** → start the timer in the layer, not in the handler; ensure it's read after `next` returns.
- **Print the chain**: temporarily log on entry/exit of each layer to confirm order.
- Use `httptest.NewRecorder` + table tests to assert status and headers per layer.
- `go build -gcflags='-m'` to confirm what escapes and where allocations come from.

## 13. Senior Engineer Notes

A senior engineer owns the *correctness and consistency* of the chain. In review, I look for: Recover ordering, early `return` after auth rejection, unexported context keys with typed accessors, and `ResponseWriter` wrappers that forward `Flusher`/`Hijacker`. I reject middleware that logs synchronously to stdout under load, or that compiles a regex per request.

I mentor toward **composition over a god-middleware**: five small, testable layers beat one 200-line function. I push for constructor-style middleware (`Logger(l) Middleware`) so dependencies are injected and the layer is testable without globals. I insist every middleware has a `httptest`-based unit test with a stub `next`, asserting both the pass-through and the short-circuit paths.

Judgment calls I make: when to wrap `ResponseWriter` (only if you need status/bytes) versus the cost of breaking SSE; when context is the right channel versus an explicit parameter; whether a concern is truly cross-cutting or belongs in the handler. I document the canonical order in the repo so it doesn't drift across services.

## 14. Staff Engineer Notes

At staff level the question shifts from "is this middleware correct" to "where should this concern live in the org's architecture." Many cross-cutting concerns — TLS termination, rate limiting, auth, tracing headers — can be pushed to the **edge/service mesh** (Envoy, Istio, an API gateway) instead of every Go service re-implementing them. That's a build-vs-buy and a consistency decision: mesh-level policy is uniform across languages but harder to customize; in-process middleware is flexible but duplicated per service. I'd standardize auth and tracing at the mesh, keep business-specific logic (feature flags, tenant routing) in-process.

I drive a **shared middleware library** across teams so request-ID format, log schema, and trace propagation are identical org-wide — that consistency is what makes centralized observability (a single Grafana/Datadog query across services) actually work. The trade-off is versioning: a breaking change to the shared chain is a fleet-wide migration, so it ships behind config flags.

I weigh the **performance budget org-wide**: a per-request allocation in a shared middleware multiplied by millions of RPS across the fleet is real money and GC pressure. I set SLOs on middleware overhead and require benchmarks for shared layers. Finally, I think about **failure isolation** — recovery and timeout middleware are the last line of defense before a panic or slow handler cascades into connection exhaustion, so their semantics are a reliability contract, not an implementation detail.

## 15. Revision Summary

- Middleware = `func(http.Handler) http.Handler` — the decorator pattern over `net/http`.
- Chain is **nested closures built once at startup**; execution is plain call/return on the goroutine stack — request phase down, response phase up.
- **Recover must be outermost** (or by documented rule); always `return` after writing an auth rejection.
- Pass request-scoped data via `r.WithContext` + unexported key types; mutate via clone, never shared fields.
- Wrap `ResponseWriter` to capture status; forward `Flusher`/`Hijacker` or break SSE/websockets.
- Costs: closures are free after startup; watch per-request allocations (context nodes, RW wrappers), pool wrappers, log async.
- chi (`r.Use`, groups) ships the standard production set; gRPC interceptors and client `RoundTripper` are the same pattern elsewhere.
- Staff lens: push universal concerns to the mesh/gateway, standardize a shared library for consistency, budget per-request allocations across the fleet.

**References:** `net/http` (`Handler`, `HandlerFunc`, `ResponseWriter`), go-chi/chi `middleware` package, `context`, `runtime/debug.Stack`, OpenTelemetry `otelhttp`, grpc-ecosystem/go-grpc-middleware.

---

*Go Engineering Handbook — topic 63.*
