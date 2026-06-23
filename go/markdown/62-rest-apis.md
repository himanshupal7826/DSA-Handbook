# 62 · REST APIs

> **In one line:** A REST API in Go is a set of HTTP handlers that map resources, verbs, and status codes onto Go's `net/http` machinery, ideally composed with a thin router like `chi` for clean routing, middleware, and versioning.

---

## 1. Overview

REST (Representational State Transfer) is an architectural style, not a protocol. In practice a "REST API" means: model your domain as **resources** addressable by URLs (`/users/42/orders`), manipulate them with HTTP **verbs** (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`), communicate outcomes with **status codes** (`200`, `201`, `404`, `409`, `422`), and evolve them safely with **versioning**.

Go is unusually well-suited to REST. The standard library's `net/http` already ships a production-grade HTTP server, and the `http.Handler` interface (`ServeHTTP(w, r)`) is the universal contract every router, middleware, and framework agrees on. You rarely need a heavy framework; a 40-line server can serve millions of requests. The most popular ecosystem choice for non-trivial routing is **`chi`** (`github.com/go-chi/chi/v5`), which is `net/http`-compatible, allocation-light, and adds path parameters, sub-routers, and middleware without a DSL lock-in.

This chapter treats REST design (resource modeling, status codes, versioning) and its Go implementation (routing internals, handlers, middleware) as one continuous topic, because in interviews and production you are judged on both.

## 2. Why It Exists

Before REST, RPC-over-HTTP was ad hoc: every endpoint was a verb (`/getUser`, `/createUserAndSendEmail`), state was opaque, and clients had to learn each call individually. REST imposed **uniform constraints** so that any HTTP client (browser, curl, mobile app, another service) could interact predictably:

- **Statelessness** — each request carries everything needed; no server session affinity, so you can horizontally scale behind a load balancer.
- **Uniform interface** — the same four-or-five verbs work across all resources, so caching layers, proxies, and gateways understand semantics (a `GET` is safe and cacheable; a `DELETE` is idempotent).
- **Resource orientation** — URLs are nouns, which maps cleanly to databases and domain models.

In the Go world specifically, REST exists as the default integration style because Go's concurrency model (one goroutine per request) and `net/http` make HTTP the path of least resistance. gRPC exists for high-throughput internal service-to-service calls, but public APIs, webhooks, and browser-facing endpoints overwhelmingly remain REST.

## 3. Internal Working

A Go REST API is, at bottom, the `net/http` server loop plus a router that implements `http.Handler`. Understanding the runtime path is what separates intermediate from senior.

When you call `http.ListenAndServe(addr, handler)`, the server opens a TCP listener and runs an `Accept` loop. **For every accepted connection it spawns a new goroutine** (`go c.serve(ctx)`). Inside that goroutine, the server reads requests, builds a `*http.Request` and an `http.ResponseWriter`, and calls `handler.ServeHTTP(w, r)`. There is no thread pool you manage — the Go runtime multiplexes these goroutines onto OS threads (`GOMAXPROCS`) via the scheduler, and goroutines that block on I/O park cheaply on the netpoller (epoll/kqueue).

The router's job is to pick the right handler. The stdlib `http.ServeMux` (improved in Go 1.22 to support methods and wildcards like `GET /users/{id}`) stores patterns and does longest-match resolution. `chi` instead builds a **radix trie (compressed prefix tree)** of routes:

```text
  Request: GET /api/v1/users/42/orders

  ListenAndServe
      │  Accept() ── new goroutine per conn
      ▼
  http.Server.serve(conn)
      │  parse request → *http.Request, ResponseWriter
      ▼
  router.ServeHTTP(w, r)          chi radix trie
      │                           (root)
      ▼                              └─ "/api/v1/"
  walk trie by path segments              ├─ "users/"
   /api/v1 → users → {id} → orders        │     └─ "{id}/"        ← param node
      │  bind {id}="42" into RouteContext  │           └─ "orders" → handlerFn
      ▼
  middleware chain (onion):
   Logger → Recoverer → Auth → handler → (unwind)
      │
      ▼
  handler(w, r): read r.Context() params, write status + JSON body
```

Key memory/runtime facts:

- **Path params** in `chi` are stored in a `*chi.Context` carried inside the request's `context.Context`. `chi` pools these context objects (`sync.Pool`) so per-request routing is near zero-allocation.
- **Middleware** is just function composition: `func(http.Handler) http.Handler`. Each layer wraps the next, forming an "onion." The outermost runs first on the way in and last on the way out — this is why `Recoverer` must be near the outside to catch panics from inner handlers (each request goroutine has its own stack, and a `recover()` in deferred middleware stops a panic from crashing the whole server).
- **The `ResponseWriter`** buffers headers until the first `Write` or `WriteHeader`. After bytes are flushed you cannot change the status code — a classic source of "superfluous WriteHeader" warnings.

## 4. Syntax

Core building blocks with `net/http` and `chi`:

```go
// Handler signature — the universal contract.
func handler(w http.ResponseWriter, r *http.Request) { /* ... */ }

// stdlib mux (Go 1.22+): method + wildcard patterns
mux := http.NewServeMux()
mux.HandleFunc("GET /users/{id}", getUser)
mux.HandleFunc("POST /users", createUser)
id := r.PathValue("id") // extract wildcard

// chi router
r := chi.NewRouter()
r.Use(middleware.Logger, middleware.Recoverer)
r.Route("/api/v1", func(r chi.Router) {
    r.Get("/users/{id}", getUser)
    r.Post("/users", createUser)
    r.Delete("/users/{id}", deleteUser)
})
id := chi.URLParam(r, "id")

// Writing a response with status + JSON
w.Header().Set("Content-Type", "application/json")
w.WriteHeader(http.StatusCreated) // 201
json.NewEncoder(w).Encode(payload)
```

## 5. Common Interview Questions

**Q1. What is the difference between `PUT` and `PATCH`?**
`PUT` replaces the entire resource and is **idempotent** — sending it twice yields the same state. `PATCH` applies a partial modification and is *not guaranteed* idempotent (e.g. `{"op":"increment"}`).
*Follow-up: Is `POST` idempotent?* No — two `POST /orders` create two orders. Make it idempotent with an `Idempotency-Key` header that the server deduplicates.

**Q2. When do you return `400` vs `422` vs `409`?**
`400 Bad Request` for malformed syntax (unparseable JSON). `422 Unprocessable Entity` for syntactically valid but semantically invalid input (email field missing). `409 Conflict` for state conflicts (duplicate unique key, optimistic-lock version mismatch).
*Follow-up: 401 vs 403?* `401` means "not authenticated" (no/invalid credentials); `403` means "authenticated but not authorized."

**Q3. How does Go's HTTP server handle concurrency?**
One goroutine per connection (and effectively per request). Goroutines are cheap (~2KB initial stack) and the scheduler multiplexes them over `GOMAXPROCS` threads; blocking I/O parks on the netpoller. You must make handlers safe for concurrent access to shared state (mutexes, atomics, or per-request data).
*Follow-up: How do you bound concurrency?* A semaphore (buffered channel) middleware, `http.Server` timeouts, or a worker pool downstream.

**Q4. How do you version a REST API and why?**
URL versioning (`/api/v1/...`) is most common and visible; header versioning (`Accept: application/vnd.acme.v2+json`) keeps URLs clean. Version to make **breaking changes** without breaking existing clients. Prefer additive, non-breaking evolution; bump major version only for breaks.
*Follow-up: How long do you keep v1 alive?* Run versions in parallel, instrument per-version traffic, and deprecate with `Sunset`/`Deprecation` headers once usage drops below a threshold.

**Q5. What makes `chi` different from `gin` or `echo`?**
`chi` uses the standard `http.Handler`/`http.HandlerFunc` types directly, so any stdlib middleware composes. `gin`/`echo` introduce their own `Context` type, which is faster for binding but couples your code to the framework.
*Follow-up: Why might you still pick stdlib only?* Fewer dependencies, supply-chain safety, and Go 1.22's mux now covers most routing needs.

**Q6. How do you handle request cancellation?**
Every request carries `r.Context()`, which is cancelled when the client disconnects or a timeout fires. Pass it to DB/HTTP calls so work stops promptly and frees goroutines.
*Follow-up: What happens if you ignore it?* Goroutine and connection leaks under load, wasted DB queries for clients that already gave up.

**Q7. What status code for a successful `DELETE`?**
`204 No Content` (no body) or `200` with a body. `202 Accepted` if deletion is async.
*Follow-up: Deleting something already gone?* Returning `204` (idempotent) is defensible; `404` is also valid — pick one and document it.

**Q8. How do you prevent a panic in one handler from crashing the server?**
A recovery middleware with `defer func(){ recover() }()` that converts the panic into a `500`. `chi`'s `middleware.Recoverer` does this.

## 6. Production Use Cases

- **Stripe** — the canonical REST API: resource-oriented (`/v1/charges`, `/v1/customers`), idempotency keys, and explicit, dated versioning. A reference standard interviewers cite.
- **GitHub REST API** — heavy use of hypermedia links, conditional requests (`ETag`/`If-None-Match`), and rate-limit headers.
- **Kubernetes API server** — written in Go; resource/verb model (`GET /api/v1/namespaces/{ns}/pods`) with strict versioning groups (`v1`, `apps/v1`, `*/v1beta1`).
- **Internal microservices at scale** — companies like Uber and Cloudflare run thousands of Go HTTP services; `chi` and stdlib power request routing, with middleware for auth, tracing (OpenTelemetry), and metrics (Prometheus).
- **BFF (Backend-for-Frontend)** — a Go REST layer aggregating downstream gRPC/REST services into a browser-friendly JSON API.

## 7. Common Mistakes

> [!WARNING]
> Calling `w.WriteHeader(200)` and then later trying `w.WriteHeader(500)` does nothing and logs `http: superfluous response.WriteHeader call`. The first write wins.

- **Returning `200` for errors** with an `{"error": ...}` body — breaks clients, caches, and observability that key off status codes.
- **Verbs in URLs** (`POST /createUser`) — undermines the uniform interface; use `POST /users`.
- **Ignoring `r.Context()`** — no cancellation propagation, leading to leaks.
- **Not setting server timeouts** — the zero-value `http.Server` has no `ReadTimeout`/`WriteTimeout`, exposing you to slowloris attacks and connection exhaustion.
- **Leaking internal errors** — returning raw DB errors or stack traces to clients (info disclosure).
- **Unbounded request bodies** — missing `http.MaxBytesReader`, enabling memory-exhaustion DoS.
- **Wrong idempotency assumptions** — treating `POST` as safe to retry.

## 8. Performance Considerations

- **Routing cost is negligible** with `chi`'s radix trie (O(path length), pooled contexts). Your latency lives in handlers: DB calls, serialization, downstream I/O.
- **JSON is often the bottleneck.** `encoding/json` uses reflection; for hot paths consider `json.NewEncoder(w).Encode` (streams, avoids a buffer) or codegen libraries (`easyjson`, `github.com/bytedance/sonic`, `jsoniter`) which cut CPU 2–5x.
- **Reuse, don't allocate.** Use `sync.Pool` for large reusable buffers; avoid per-request allocations in middleware.
- **Connection management.** Set `ReadHeaderTimeout`, `ReadTimeout`, `WriteTimeout`, `IdleTimeout`, and `MaxHeaderBytes`. Tune `http.Transport` connection pools (`MaxIdleConnsPerHost`) for outbound calls.
- **Compression** (`gzip`) trades CPU for bandwidth — worth it for large JSON over WAN, wasteful for tiny payloads.
- **Bound concurrency** to protect downstreams; a server happily spawns millions of goroutines and then melts your database.

> [!TIP]
> Benchmark with `wrk`/`vegeta` and profile with `net/http/pprof`. Most "the router is slow" claims turn out to be N+1 DB queries.

## 9. Best Practices

| Concern | Practice |
| --- | --- |
| Resources | Plural nouns, nest sparingly (`/users/{id}/orders`), max ~2 levels deep |
| Status codes | Use precise codes; `201`+`Location` on create; `204` on delete |
| Errors | Single consistent error envelope (`{"error":{"code","message"}}`) + correct status |
| Versioning | `/api/v1`; additive changes within a version; `Deprecation`/`Sunset` headers |
| Validation | Validate at the edge; return `422` with field-level detail |
| Pagination | Cursor-based for large sets; expose limits and next-cursor |
| Idempotency | Support `Idempotency-Key` for non-idempotent writes |
| Security | TLS, auth middleware, `MaxBytesReader`, rate limiting, never echo internals |
| Observability | Request ID, structured logs (`slog`), metrics, distributed tracing |
| Timeouts | Always set server + client + per-request context deadlines |

## 10. Code Examples

Primary idiomatic example using `chi`, with versioning, status codes, JSON helpers, and middleware:

```go
package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

type User struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

var errNotFound = errors.New("user not found")

// writeJSON centralizes content-type + status + encoding.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]string{"message": msg},
	})
}

func getUser(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	u, err := lookup(r.Context(), id) // respects cancellation
	switch {
	case errors.Is(err, errNotFound):
		writeErr(w, http.StatusNotFound, "user not found")
	case err != nil:
		writeErr(w, http.StatusInternalServerError, "internal error")
	default:
		writeJSON(w, http.StatusOK, u)
	}
}

func createUser(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20) // 1 MiB cap
	var in User
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if in.Name == "" {
		writeErr(w, http.StatusUnprocessableEntity, "name is required")
		return
	}
	in.ID = "u_123"
	w.Header().Set("Location", "/api/v1/users/"+in.ID)
	writeJSON(w, http.StatusCreated, in) // 201
}

func lookup(_ context.Context, id string) (User, error) {
	if id == "1" {
		return User{ID: "1", Name: "Ada"}, nil
	}
	return User{}, errNotFound
}

func main() {
	r := chi.NewRouter()
	r.Use(middleware.RequestID, middleware.Logger, middleware.Recoverer)
	r.Route("/api/v1", func(r chi.Router) {
		r.Get("/users/{id}", getUser)
		r.Post("/users", createUser)
	})

	srv := &http.Server{
		Addr:              ":8080",
		Handler:           r,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	_ = srv.ListenAndServe()
}
```

The same routing with **only the standard library** (Go 1.22+), no third-party dependency:

```go
package main

import (
	"net/http"
)

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/users/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		_ = id
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("POST /api/v1/users", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
	})

	srv := &http.Server{Addr: ":8080", Handler: mux}
	_ = srv.ListenAndServe()
}
```

A custom middleware (function composition) for enforcing a per-request deadline:

```go
func withTimeout(d time.Duration) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx, cancel := context.WithTimeout(r.Context(), d)
			defer cancel()
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
```

## 11. Advanced Concepts

- **HATEOAS** — the "highest" REST maturity (Richardson Level 3): responses embed links (`_links`) so clients discover transitions dynamically. Rare in practice; GitHub partially does it.
- **Conditional requests & caching** — `ETag` + `If-None-Match` to return `304 Not Modified`, and `If-Match` for optimistic concurrency on writes (`412 Precondition Failed`). Saves bandwidth and prevents lost updates.
- **Content negotiation** — `Accept` header drives format (JSON, protobuf, CSV) and can carry version (`application/vnd.acme.v2+json`).
- **Graceful shutdown** — `srv.Shutdown(ctx)` stops accepting new connections and drains in-flight requests; pair with signal handling (`signal.NotifyContext`) for zero-dropped-request deploys.
- **Streaming** — `http.Flusher` for Server-Sent Events / chunked responses; `io.Copy` to stream large bodies without buffering.
- **Structured errors as a contract** — RFC 7807 `application/problem+json` standardizes error payloads across services.

## 12. Debugging Tips

- **`net/http/pprof`** — import `_ "net/http/pprof"` and hit `/debug/pprof/` for goroutine, heap, and CPU profiles. Goroutine count climbing without bound = leaked handlers (usually missing context propagation).
- **`curl -v` / `httpie`** — inspect exact status, headers, and the `Location` on creates.
- **`middleware.Logger`** plus a request ID lets you correlate a single request across logs.
- **`http.DumpRequest`/`DumpResponse`** to log raw bytes when a client claims malformed responses.
- **The "superfluous WriteHeader" log** points to a handler writing the status twice — often an error path that doesn't `return`.
- **Reproduce timeouts** with `vegeta attack` and watch p99; flat throughput with rising latency signals a saturated downstream, not the router.

## 13. Senior Engineer Notes

A senior engineer owns the *consistency and correctness* of the API surface. Concretely: enforce one error envelope and one pagination scheme across all endpoints in code review — divergence here is the single biggest source of client pain. Reject PRs that return `200` on failure or leak internal errors. Insist that every handler threads `r.Context()` into I/O; a handler that ignores cancellation is a latent outage.

In design, push back on premature nesting and over-clever HATEOAS — most teams need clean nouns, correct status codes, and good docs, not Level 3 maturity. Standardize the handler shape (thin handler → service → repository) so any teammate can navigate any service. Mentor juniors on the difference between `400/422/409` and on idempotency, because these are where production incidents actually happen (double-charged customers from retried `POST`s).

Own the non-functional defaults: every new service template ships with server timeouts, `MaxBytesReader`, recovery middleware, structured logging, and graceful shutdown already wired. The goal is that doing the right thing is the path of least resistance.

## 14. Staff Engineer Notes

A staff engineer decides *whether the boundary should even be REST*, and how it evolves across the org. Build-vs-buy: do you stand up an API gateway (Kong, AWS API Gateway, Envoy) for auth/rate-limiting/versioning, or keep it in Go middleware? Gateways centralize policy but add a hop and operational surface; for a handful of services, middleware libraries shared via an internal module are leaner.

REST vs gRPC vs GraphQL is a portfolio decision: REST for public/partner and webhook surfaces, gRPC for high-fanout internal calls (with grpc-gateway to expose REST when needed), GraphQL only where clients genuinely need flexible field selection and you can fund the operational cost. Picking one default and documenting the exceptions prevents a fragmented estate.

The hardest staff problem is **versioning at org scale**: a shared style guide, an OpenAPI spec as the source of truth (generate clients/servers from it), an automated breaking-change linter in CI (`oasdiff`), and a published deprecation policy with `Sunset` headers and traffic dashboards per version. Cross-team, you negotiate the contract — consumer-driven contract tests (Pact) catch breaks before deploy. The metric that matters is *mean time to safely ship a breaking change*; everything above optimizes that.

## 15. Revision Summary

- REST = resources (nouns) + verbs (`GET/POST/PUT/PATCH/DELETE`) + status codes + statelessness.
- Go: `http.Handler.ServeHTTP` is the universal contract; one goroutine per request, scheduled over `GOMAXPROCS`, parked on the netpoller.
- `chi` = `net/http`-compatible radix-trie router with pooled route contexts; Go 1.22 mux now does methods + wildcards too.
- Middleware is `func(http.Handler) http.Handler` composition — an onion; keep `Recoverer` outermost.
- Status codes: `201`+`Location` on create, `204` on delete, `400` syntax, `422` semantics, `409` conflict, `401` auth, `403` authz.
- `PUT`/`DELETE`/`GET` idempotent; `POST` is not — use `Idempotency-Key`.
- Always set server timeouts, `MaxBytesReader`, recovery, context propagation, graceful shutdown.
- Version via `/api/v1`; evolve additively; deprecate with `Sunset` headers and OpenAPI + breaking-change linting.
- Senior: enforce consistency, correct codes, context threading, sane defaults. Staff: choose the protocol, gateway build-vs-buy, org-wide versioning and contract testing.

**References:** REST best practices (Fielding's dissertation, Stripe & GitHub API guides, Richardson Maturity Model, RFC 7807, RFC 9110 HTTP Semantics); `github.com/go-chi/chi`; Go `net/http` and Go 1.22 `ServeMux` docs.

---

*Go Engineering Handbook — topic 62.*
