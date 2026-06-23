# 61 · HTTP Package

> **In one line:** Go's `net/http` gives you a production-grade HTTP server in the standard library, built on a goroutine-per-connection model, a tiny `Handler` interface, and a request-routing `ServeMux`.

---

## 1. Overview

`net/http` is the backbone of nearly every Go web service. Unlike most languages where you reach for a third-party framework before writing line one, Go ships a complete, concurrent, TLS-capable HTTP/1.1 and HTTP/2 stack in the standard library. The mental model is small and composable:

- A **`Handler`** is anything with `ServeHTTP(ResponseWriter, *Request)`.
- A **`ServeMux`** is itself a `Handler` that routes requests to other handlers by path.
- A **`Server`** owns the listener, accept loop, timeouts, and connection lifecycle.

The genius of the design is that the *entire* extensibility surface — routers, middleware, frameworks like Chi, Echo, Gin — is built on top of one method. Master those three types (`Handler`, `ServeMux`, `Server`) and the `ResponseWriter`/`Request` pair, and you understand 90% of Go HTTP servers in production.

This chapter goes past `http.HandleFunc("/", ...)` into how the accept loop actually works, how the new (Go 1.22) `ServeMux` method-and-pattern matching is implemented, and the timeout knobs that separate a toy from a service that survives a slowloris attack.

---

## 2. Why It Exists

Before Go, building an HTTP server meant either a heavyweight app server (Tomcat, IIS) or stitching together an event loop (Node, nginx + FastCGI) and worrying about callback hell or blocking I/O. Go's runtime made a different bet: **cheap goroutines + a network poller** let you write straight-line, blocking-style code while the runtime multiplexes thousands of connections onto a handful of OS threads.

`net/http` exists to expose that bet ergonomically. It answers:

- *How do I accept connections concurrently without managing a thread pool?* → goroutine-per-connection, scheduled on the `netpoller` (epoll/kqueue/IOCP under the hood).
- *How do I parse HTTP without writing a parser?* → `Request`/`Response` types with a streaming body.
- *How do I compose behavior?* → the `Handler` interface, which makes middleware just function wrapping.

The result is that the standard library alone is enough to run real production traffic — companies have served billions of requests on bare `net/http`. Frameworks add ergonomics (routing DSLs, binding, validation), not raw capability.

---

## 3. Internal Working

When you call `http.ListenAndServe(addr, handler)`, here is what actually happens at runtime.

```text
ListenAndServe
   │
   ├─ net.Listen("tcp", addr)         // creates *net.TCPListener (fd registered with netpoller)
   │
   └─ Server.Serve(ln)
         │
         for {                         // the ACCEPT LOOP (runs on caller's goroutine)
            rw, err := ln.Accept()     // blocks via netpoller until a conn arrives
            c := srv.newConn(rw)       // wraps in *http.conn
            go c.serve(ctx)            // ONE GOROUTINE PER CONNECTION
         }
```

Each `*http.conn` goroutine runs a loop (`conn.serve`) that handles **keep-alive**: it reads one request, dispatches it, flushes the response, then loops to read the next request on the same TCP connection.

```text
 conn.serve (per-connection goroutine)
 ┌────────────────────────────────────────────────────┐
 │  for {                                              │
 │    req  = readRequest()    // parse headers         │
 │    w    = newResponse(req) // *http.response        │
 │    serverHandler{srv}.ServeHTTP(w, req)             │
 │       │  (if srv.Handler == nil → DefaultServeMux)  │
 │    w.finishRequest()       // flush, chunk, etc.    │
 │    if !keepAlive { break } // else read next        │
 │  }                                                  │
 └────────────────────────────────────────────────────┘
```

**Key data structures:**

- `http.Server` — holds `Handler`, the timeout fields (`ReadTimeout`, `WriteTimeout`, `IdleTimeout`, `ReadHeaderTimeout`), `TLSConfig`, and an internal map of active connections for graceful shutdown.
- `http.conn` — `rwc net.Conn`, a buffered reader (`*bufio.Reader`, ~4KB) and writer pooled via `sync.Pool` to reduce allocations across the keep-alive loop.
- `http.response` (the concrete `ResponseWriter`) — buffers headers until the first `Write` or explicit `WriteHeader`, tracks whether headers were sent, and decides chunked vs. content-length encoding.

**`ServeMux` internals (Go 1.22+):** The mux holds patterns parsed into `{method, host, path-segments}`. Routing is no longer a flat map lookup; it walks a structure that supports wildcards (`/items/{id}`), `{path...}` catch-all, and method matching (`GET /items/{id}`). Matching uses **most-specific-wins** precedence: a literal segment beats a wildcard, and a longer specific pattern beats a shorter one — resolved deterministically, not by registration order. Conflicting patterns that can't be ordered cause a *panic at registration time*, which surfaces routing bugs early.

```text
ServeMux pattern table (conceptual)

  "GET /items/{id}"   ─┐
  "GET /items/new"    ─┼─►  match(req) → most specific wins
  "POST /items/"      ─┘     ("/items/new" beats "/items/{id}")
```

**The `ResponseWriter` is an interface, but the value is concrete.** Type assertions unlock extra capabilities: `http.Flusher` (streaming/SSE), `http.Hijacker` (take over the raw TCP conn for WebSockets), and in modern Go the `http.ResponseController` wraps these safely.

> [!NOTE]
> Goroutine-per-connection sounds expensive but isn't: a goroutine starts at ~2KB of stack, and the netpoller parks blocked goroutines off-thread. A single server routinely handles tens of thousands of concurrent connections.

---

## 4. Syntax

```go
// Handler interface — the entire contract.
type Handler interface {
	ServeHTTP(http.ResponseWriter, *http.Request)
}

// HandlerFunc adapts an ordinary function to a Handler.
type HandlerFunc func(http.ResponseWriter, *http.Request)

func (f HandlerFunc) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f(w, r)
}

// Registering routes (Go 1.22+ method+pattern syntax).
mux := http.NewServeMux()
mux.HandleFunc("GET /users/{id}", getUser) // method-aware
mux.HandleFunc("POST /users", createUser)
mux.Handle("/static/", http.StripPrefix("/static/", fs))

// Extracting path wildcards.
id := r.PathValue("id")

// Explicit Server (always prefer this over ListenAndServe for prod).
srv := &http.Server{
	Addr:              ":8080",
	Handler:           mux,
	ReadHeaderTimeout: 5 * time.Second,
	ReadTimeout:       15 * time.Second,
	WriteTimeout:      15 * time.Second,
	IdleTimeout:       60 * time.Second,
}
log.Fatal(srv.ListenAndServe())
```

---

## 5. Common Interview Questions

**Q1. What is the `Handler` interface and why is it powerful?**
It's a single method, `ServeHTTP(ResponseWriter, *Request)`. Power comes from composition: `ServeMux`, middleware, and whole frameworks are just `Handler`s wrapping other `Handler`s. *Follow-up: How does `HandlerFunc` fit in?* It's a function type with a `ServeHTTP` method that calls itself — an adapter so you can use plain functions as handlers without defining a struct.

**Q2. Describe the server's concurrency model.**
One goroutine per accepted connection; the accept loop spawns `go c.serve()`. Blocking reads are parked by the netpoller, so thousands of connections cost little. *Follow-up: Is a single handler invocation concurrent-safe to write shared state in?* No — different requests run on different goroutines, so shared mutable state needs synchronization.

**Q3. What changed in `ServeMux` in Go 1.22?**
It gained method matching (`GET /x`), path wildcards (`{id}`), catch-all (`{path...}`), and precedence-based (most-specific-wins) routing with conflict detection at registration. *Follow-up: How are conflicts handled?* Two patterns that overlap with no clear winner panic when registered, failing fast.

**Q4. Difference between `WriteTimeout` and `ReadHeaderTimeout`?**
`ReadHeaderTimeout` bounds time to read request headers (defends against slowloris). `WriteTimeout` bounds the entire response write. *Follow-up: Why is `ReadHeaderTimeout` safer than `ReadTimeout` for streaming uploads?* `ReadTimeout` covers the whole body too, which would kill legitimate large/slow uploads; `ReadHeaderTimeout` protects headers without penalizing the body.

**Q5. When does `WriteHeader` get called implicitly?**
The first call to `w.Write` triggers an implicit `WriteHeader(200)`. *Follow-up: What happens if you set a header after `Write`?* It's ignored (with a log warning) because headers are already flushed.

**Q6. How do you implement Server-Sent Events / streaming?**
Type-assert the `ResponseWriter` to `http.Flusher` (or use `http.ResponseController`) and call `Flush()` after each chunk; don't set a short `WriteTimeout` (or use `ResponseController.SetWriteDeadline`). *Follow-up: Why might Flush fail silently?* Behind a buffering proxy or if the writer doesn't implement `Flusher`.

**Q7. How does graceful shutdown work?**
`srv.Shutdown(ctx)` stops accepting new connections, closes idle ones, and waits for in-flight handlers until `ctx` expires. *Follow-up: Difference from `Close()`?* `Close()` is abrupt — it terminates active connections immediately.

**Q8. Why prefer an explicit `*http.Server` over `http.ListenAndServe`?**
The package-level helper has *no timeouts* — a production footgun. An explicit `Server` lets you set timeouts, TLS config, and enables `Shutdown`. *Follow-up: What's the danger of zero timeouts?* Connections can hang forever, exhausting file descriptors and memory.

---

## 6. Production Use Cases

- **API gateways & microservices:** `net/http` is the transport layer beneath gRPC-gateway, and the foundation for routers like **Chi**, **Gin**, and **Echo**. Kubernetes' API server and many CNCF tools serve directly on `net/http`.
- **Reverse proxies:** `httputil.ReverseProxy` powers internal load balancers and sidecars; Caddy and parts of Traefik build on the standard library's HTTP machinery.
- **Health checks & metrics:** The Prometheus client library (`promhttp.Handler()`) is a plain `http.Handler` mounted on a `ServeMux`. Nearly every Go service exposes `/metrics` and `/healthz` this way.
- **Internal admin/debug endpoints:** `net/http/pprof` registers profiling handlers on `DefaultServeMux` — used everywhere from Uber to Google for live profiling.
- **Webhook receivers & SaaS backends:** Stripe-style webhook endpoints, GitHub Actions runners, and countless CRUD backends run bare `net/http` with a thin middleware stack.

---

## 7. Common Mistakes

> [!WARNING]
> The single most common production incident: using `http.ListenAndServe` (or a `Server` with zero timeouts). Set `ReadHeaderTimeout` at minimum.

- **Not reading/closing the request body** on the client side — leaks connections from the keep-alive pool. (`defer resp.Body.Close()` and drain it.)
- **Writing after `WriteHeader`** — header changes silently dropped; status accidentally locked to 200.
- **Using `DefaultServeMux` implicitly** — importing a package (like `net/http/pprof`) can register routes on the global mux, exposing endpoints you didn't intend. Use your own `*ServeMux`.
- **Storing per-request state on the handler struct** instead of in the request context — data races across goroutines.
- **Ignoring `r.Context()` cancellation** — handlers keep doing expensive work after the client disconnected.
- **Calling `Flush` without checking the `Flusher` assertion** — panics on writers that don't support it.
- **Mutating shared maps in handlers** without a mutex — classic data race under load.

---

## 8. Performance Considerations

- **Allocation pressure** dominates HTTP throughput. The server pools `bufio.Reader`/`Writer` via `sync.Pool`. Your code should too: reuse buffers, avoid `fmt.Sprintf` in hot paths, and stream large bodies instead of buffering.
- **Keep-alive** is on by default and crucial — TCP/TLS handshake amortization can be a 2-5x throughput difference. Tune `IdleTimeout` so idle conns don't pin file descriptors.
- **`json.Marshal` then `w.Write`** allocates the whole payload; `json.NewEncoder(w).Encode(v)` streams it, lowering peak memory for large responses.
- **GOMAXPROCS** defaults to CPU count; goroutine-per-connection scales well, but watch for handlers that block on a shared lock or a small DB pool — that's where latency p99 explodes, not in `net/http` itself.
- **HTTP/2** is auto-enabled over TLS; it multiplexes streams over one connection, reducing connection count but adding per-stream goroutines. Benchmark — for high-RPS internal traffic, HTTP/1.1 keep-alive is sometimes faster.

| Knob | Default | Production guidance |
|------|---------|---------------------|
| `ReadHeaderTimeout` | 0 (none) | 5-10s — always set |
| `ReadTimeout` | 0 | 15-30s (omit for streaming uploads) |
| `WriteTimeout` | 0 | 15-30s (omit for SSE/streaming) |
| `IdleTimeout` | 0 | 60-120s |
| `MaxHeaderBytes` | 1MB | lower for untrusted clients |

---

## 9. Best Practices

- Always construct an explicit `*http.Server` with timeouts.
- Use your own `*ServeMux`; never rely on `DefaultServeMux` in libraries.
- Build middleware as `func(http.Handler) http.Handler` so it composes cleanly.
- Always pass and respect `r.Context()` into downstream calls (DB, RPC) for cancellation and deadlines.
- Implement graceful shutdown on `SIGTERM`/`SIGINT` with a bounded context.
- Use `http.ResponseController` (Go 1.20+) instead of raw `Flusher`/`Hijacker` assertions.
- Return errors centrally — a top-level error-handling middleware beats `http.Error` scattered everywhere.
- Set security headers and request size limits (`http.MaxBytesReader`) on untrusted input.

---

## 10. Code Examples

Primary: a production-shaped server with middleware, Go 1.22 routing, and graceful shutdown.

```go
package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func logging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		slog.Info("req", "method", r.Method, "path", r.URL.Path, "dur", time.Since(start))
	})
}

func getUser(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id") // Go 1.22 wildcard
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"id": id, "name": "Ada"})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /users/{id}", getUser)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	srv := &http.Server{
		Addr:              ":8080",
		Handler:           logging(mux),
		ReadHeaderTimeout: 5 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("serve", "err", err)
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx) // drain in-flight requests
}
```

Alternative: a streaming Server-Sent Events handler using `http.ResponseController`.

```go
func events(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	rc := http.NewResponseController(w)

	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done(): // client disconnected
			return
		case t := <-tick.C:
			_, _ = io.WriteString(w, "data: "+t.Format(time.RFC3339)+"\n\n")
			if err := rc.Flush(); err != nil { // safe flush
				return
			}
		}
	}
}
```

---

## 11. Advanced Concepts

- **Hijacking:** `http.Hijacker.Hijack()` (or `ResponseController.Hijack`) hands you the raw `net.Conn` and buffered reader, used to upgrade to WebSockets (gorilla/websocket, nhooyr/websocket) — after which `net/http` no longer manages that connection.
- **Context propagation & values:** Each request carries a `context.Context` cancelled when the client disconnects or the server shuts down. Middleware threads request-scoped values (trace IDs, auth principal) through `context.WithValue` — use typed keys, never strings.
- **`ReverseProxy` & `RoundTripper`:** The `http.RoundTripper` interface is the client-side mirror of `Handler` — one method, infinitely wrappable, the basis for retry/circuit-breaker/instrumentation transports.
- **HTTP/2 & h2c:** Over TLS, HTTP/2 is automatic; for cleartext HTTP/2 (h2c, common in service meshes) use `golang.org/x/net/http2/h2c`.
- **`ServeMux` method routing internals:** A registered `GET /x` also implicitly handles `HEAD /x`. 405 (Method Not Allowed with an `Allow` header) is produced automatically when a path matches but the method doesn't.
- **`http.MaxBytesReader`:** Wraps the body to hard-cap request size, returning an error past the limit — essential against memory-exhaustion DoS.

---

## 12. Debugging Tips

- **`net/http/pprof`:** Import for the side effect and hit `/debug/pprof/goroutine?debug=2` to see every blocked goroutine — invaluable for diagnosing leaked connections or stuck handlers.
- **Leaked goroutines = leaked connections:** A growing goroutine count under steady load usually means handlers aren't returning (blocked on a lock, channel, or unbounded read). Profile the goroutine stacks.
- **`httputil.DumpRequest` / `DumpResponse`:** Dump raw wire bytes to verify headers, chunking, and body framing.
- **`curl -v` / `curl --http1.1`:** Confirm protocol negotiation and keep-alive behavior; force HTTP/1.1 to isolate HTTP/2 issues.
- **`GODEBUG=http2debug=2`:** Verbose HTTP/2 framing logs when a stream misbehaves.
- **"Superfluous WriteHeader" log line:** Means you called `WriteHeader` twice (often via `http.Error` after a `Write`). Trace the double-write.
- **Check `r.Context().Err()`** in slow handlers to confirm whether the client already gave up before you blame the backend.

---

## 13. Senior Engineer Notes

A senior engineer's job here is *judgment in the small and reviews*. In code review, the reflexes are: reject any `http.ListenAndServe` without timeouts; flag handlers that ignore `r.Context()`; catch shared-state writes that aren't synchronized; and insist middleware uses the `func(http.Handler) http.Handler` shape so the team's stack stays composable.

You should know *when not to add a framework*. For a 6-endpoint internal service, bare `net/http` + Go 1.22 routing is less code, fewer dependencies, and easier to onboard than Gin. Reserve frameworks for where their binding/validation DSL genuinely pays off.

Mentoring-wise, teach juniors the three-type mental model (`Handler`/`ServeMux`/`Server`) before any framework, and make them trace one request through `conn.serve` once — it demystifies the whole stack. Push for table-driven `httptest.NewServer` / `httptest.NewRecorder` tests as the default, not an afterthought; they're fast and exercise the real routing logic.

Watch the operational edges: graceful shutdown wired to `SIGTERM` (Kubernetes sends it before `SIGKILL`), request size limits on public endpoints, and structured request logging with trace IDs. These are the "boring" things that decide whether 3am pages happen.

---

## 14. Staff Engineer Notes

At staff level the questions shift to architecture and org-level trade-offs. The recurring **build-vs-buy** decision: standardize the company on a thin internal HTTP framework (a curated middleware chain + `net/http`) versus adopting Gin/Echo/Chi wholesale. The thin-internal route keeps you close to the stdlib (easy upgrades, no framework EOL risk) but costs maintenance; a popular framework offloads that but couples hundreds of services to a third party's release cadence and security posture.

You own **cross-cutting concerns as a platform**: a shared middleware library for auth, tracing (OpenTelemetry), rate limiting, panic recovery, and metrics — so 200 services don't each reinvent (and mis-implement) timeouts and shutdown. The leverage is enormous: fixing a header-injection bug once propagates everywhere.

Think about **protocol strategy org-wide**: HTTP/1.1 vs HTTP/2 vs gRPC for internal service-to-service, and where a service mesh (Envoy/Istio) absorbs concerns like mTLS and retries that you'd otherwise bake into `net/http` transports. The architectural call is which layer owns timeouts, retries, and circuit breaking — the app's `RoundTripper`, the mesh sidecar, or both (and how to avoid double-retrying storms).

Finally, set the **golden-path defaults**: a service template with timeouts, graceful shutdown, `/healthz`, `/metrics`, and pprof pre-wired, so the right thing is the default and incidents from missing timeouts simply stop happening across the org.

---

## 15. Revision Summary

- `Handler` = one method `ServeHTTP(w, r)`; everything (mux, middleware, frameworks) composes from it.
- Concurrency: **goroutine per connection**, netpoller parks blocked I/O; keep-alive loops requests on one conn.
- `ServeMux` (Go 1.22+): method matching, `{id}` wildcards, `{path...}` catch-all, most-specific-wins, conflicts panic at registration; read wildcards via `r.PathValue`.
- Always use an explicit `*http.Server` with `ReadHeaderTimeout`/`ReadTimeout`/`WriteTimeout`/`IdleTimeout`; `ListenAndServe` has none.
- First `w.Write` implies `WriteHeader(200)`; headers after that are ignored.
- Stream with `http.ResponseController.Flush`; upgrade with `Hijack`; cap input with `MaxBytesReader`.
- Graceful shutdown: `srv.Shutdown(ctx)` drains; wire to `SIGTERM`.
- Debug with `net/http/pprof`, goroutine dumps, `httputil.DumpRequest`, `GODEBUG=http2debug=2`.

**References:** [net/http docs](https://pkg.go.dev/net/http), [Go 1.22 ServeMux routing enhancements](https://go.dev/blog/routing-enhancements), [http.ResponseController](https://pkg.go.dev/net/http#ResponseController).

---

*Go Engineering Handbook — topic 61.*
