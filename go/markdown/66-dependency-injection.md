# 66 · Dependency Injection

> **In one line:** Dependency injection in Go is the practice of passing a component's collaborators in through its constructor instead of letting it build them, making code explicit, testable, and wireable — usually by hand, sometimes with code generators like `google/wire`.

---

## 1. Overview

Dependency injection (DI) is a fancy name for a simple idea: a piece of code should *receive* the things it depends on rather than *create* them. In Go, this almost always means passing dependencies as arguments to a constructor function (a plain `NewX(...)` factory) and storing them on a struct.

There is no `@Autowired`, no XML, no container running by default. The idiomatic Go approach is *manual constructor injection*: you wire everything together explicitly in `main()`. When that wiring graph grows to dozens of nodes, teams reach for compile-time code generators such as **`google/wire`** — but crucially, wire generates the same boring constructor calls you would have written by hand. There is no runtime reflection container in the idiomatic Go world.

DI rests on two pillars Go gives you for free: **interfaces** (implicitly satisfied, so consumers define what they need) and **first-class functions/structs** (so dependencies are just values). Master DI and you unlock the single biggest lever for **testability** in a Go codebase.

## 2. Why It Exists

Without DI, code reaches out and constructs its own collaborators:

```go
func (s *OrderService) Charge(id string) error {
    db, _ := sql.Open("postgres", os.Getenv("DSN")) // hidden dependency
    stripe := stripe.New(os.Getenv("STRIPE_KEY"))   // hidden dependency
    // ...
}
```

This is convenient for exactly five minutes. Then:

- **You cannot test it** without a real Postgres and a real Stripe account. There is no seam to substitute a fake.
- **You cannot reuse it** with a different database or a mock payment provider.
- **Lifecycle is a mess** — a new DB connection per call, no pooling, no graceful shutdown.
- **Configuration is scattered** — `os.Getenv` calls are buried everywhere instead of being read once at startup.

DI exists to convert these *implicit, hard-coded* dependencies into *explicit, swappable* ones. The dependency becomes a parameter; the parameter is typically an **interface**; and at runtime the caller decides which concrete implementation to supply. This is the practical expression of the Dependency Inversion Principle: high-level policy depends on abstractions, not on low-level details.

## 3. Internal Working

There is no DI "runtime" in idiomatic Go — and understanding *why* requires looking at how interfaces and structs are laid out in memory, because that is the actual machinery DI rides on.

When you inject an interface value, you are passing a two-word **interface header** (often called an `iface`): a pointer to an *itab* (interface table) and a pointer to the underlying data.

```text
  var repo UserRepo = &PostgresRepo{db: pool}

  interface value (16 bytes on amd64)
  ┌────────────────┬────────────────┐
  │  *itab         │  data ptr      │
  └───────┬────────┴───────┬────────┘
          │                │
          ▼                ▼
   ┌──────────────┐   ┌──────────────────┐
   │ itab         │   │ PostgresRepo     │
   │  _type(*Pg)  │   │  db *pgxpool.Pool│
   │  inter(URepo)│   └──────────────────┘
   │  fun[0]=Get  │   (heap-allocated, escapes
   │  fun[1]=Save │    because address taken &
   └──────────────┘    stored in interface)
```

Key runtime facts that follow:

- **The itab is computed once** and cached by the runtime (in `itabTable`), so the cost of "polymorphism via injection" is essentially one pointer chase per method call — no reflection, no map lookup at the call site.
- **Storing a `*Struct` in an interface forces a heap allocation** (the value escapes). So injecting `*PostgresRepo` as a `UserRepo` interface means escape analysis can't keep it on the stack. This is the only real "cost" of interface-based DI and it happens once at wiring time, not per request.
- **Constructor injection is just struct field assignment.** `NewService(repo, logger)` returns a `*Service` whose fields hold those interface headers. There is no container tracking lifetimes; the Go garbage collector reclaims the graph when the root (`main`'s `Service`) becomes unreachable.

`google/wire` operates entirely at **compile time**: it reads provider function signatures, topologically sorts the dependency graph by matching return types to parameter types, and *emits Go source* (`wire_gen.go`) containing the literal sequence of constructor calls. There is zero runtime overhead and zero reflection — a compile error if the graph is incomplete or cyclic. Contrast this with reflection-based containers (e.g. `uber-go/dig`), which build the graph at runtime using `reflect` and resolve types via a map keyed on `reflect.Type`, paying a startup cost and deferring "missing dependency" to a runtime panic.

## 4. Syntax

The canonical pattern: define the dependency as an interface *at the consumer*, then accept it in a constructor.

```go
// 1. The consumer declares the narrow interface it needs.
type UserRepo interface {
    Get(ctx context.Context, id string) (*User, error)
}

// 2. Constructor injection: dependencies in, *Service out.
type Service struct {
    repo UserRepo
    log  *slog.Logger
}

func NewService(repo UserRepo, log *slog.Logger) *Service {
    return &Service{repo: repo, log: log}
}

// 3. Methods use the injected fields; they never construct collaborators.
func (s *Service) Profile(ctx context.Context, id string) (*User, error) {
    s.log.Info("loading profile", "id", id)
    return s.repo.Get(ctx, id)
}
```

> [!TIP]
> Define interfaces in the *consuming* package, not the implementing one. "Accept interfaces, return concrete structs." This keeps interfaces small (often 1–2 methods) and avoids coupling consumers to a fat interface they barely use.

## 5. Common Interview Questions

**Q1. What is dependency injection and how is it done in Go?**
Passing a component's dependencies in (usually via a constructor) rather than constructing them internally. In Go it's plain constructor injection: `NewX(dep1, dep2) *X`, with dependencies typed as interfaces for swappability.
*Follow-up: Does Go need a DI framework?* No. Manual wiring in `main` is idiomatic and preferred; `google/wire` only generates that wiring when the graph gets large.

**Q2. Where should interfaces be defined — producer or consumer side?**
Consumer side. The package that *uses* the dependency declares the minimal interface it requires. This keeps interfaces small and prevents the implementer from dictating a bloated contract.
*Follow-up: Why does this matter for testing?* A tiny interface is trivial to fake — you implement one or two methods, not twenty.

**Q3. Compare `google/wire` vs `uber-go/dig`.**
`wire` is compile-time codegen: errors surface at build time, zero runtime cost, output is readable Go. `dig` (and `fx`) are runtime reflection containers: more dynamic, but missing-dependency errors appear at startup as panics and there's a small reflection cost.
*Follow-up: Which would you pick for a library?* Neither in the public API — expose constructors and let the caller wire. Containers are an application concern.

**Q4. How does DI improve testability?**
It creates seams. Inject a fake/mock implementation of an interface to isolate the unit under test, control time/randomness/IO, and assert on interactions — all without network or DB.
*Follow-up: Mock vs fake vs stub?* Stub returns canned data; fake is a working lightweight impl (e.g. in-memory repo); mock additionally verifies calls. Prefer fakes for maintainability.

**Q5. What's the downside of constructor injection with many dependencies?**
Constructors with 8+ parameters signal a struct doing too much (low cohesion). Fix by splitting the type or grouping related deps into a sub-struct — not by hiding them in a global.
*Follow-up: Is a "params struct" a good fix?* It tidies the signature and is fine, but it doesn't fix the underlying cohesion problem; treat it as a smell to investigate.

**Q6. Why avoid the service-locator / global registry pattern?**
It re-hides dependencies (you can't see them in the signature), reintroduces global mutable state, breaks parallel tests, and turns compile-time wiring errors into runtime ones.
*Follow-up: Is `context.Context` a service locator?* Stuffing dependencies into `context.Value` is exactly that anti-pattern; context is for request-scoped data and cancellation, not for passing your DB handle.

**Q7. How do you inject something with a lifecycle (open/close)?**
The constructor returns the resource *and* a cleanup function (or you manage it in `main` with `defer`). `wire` formalizes this with cleanup functions it threads through generated code in reverse-construction order.

## 6. Production Use Cases

- **HTTP/gRPC services**: A `main()` opens the DB pool, Redis client, Kafka producer, and `slog` logger once, then injects them down through `NewUserService`, `NewOrderService`, etc. This is the standard layout in production Go at companies like Uber and Monzo, and in the canonical Mat Ryer "How I write HTTP services" pattern.
- **`google/wire`** powers wiring in many Google-internal Go services and open-source projects. It shines when the graph has 30+ providers across layers.
- **Kubernetes** uses constructor-style injection pervasively (controllers receive `clientset`, informers, and event recorders via their `New...Controller` functions) — no framework, just disciplined wiring.
- **Uber's `fx`** (built on `dig`) is used in large microservice fleets where a uniform lifecycle (start/stop hooks, graceful shutdown) across hundreds of services is worth a runtime container.
- **Testing infrastructure**: integration tests inject a `testcontainers`-backed Postgres; unit tests inject an in-memory fake — the same constructor, different argument.

## 7. Common Mistakes

> [!WARNING]
> The mistakes below show up in real code reviews far more than syntax errors.

| Mistake | Why it hurts | Fix |
|---|---|---|
| Constructing deps inside methods | No test seam, hidden coupling | Inject via constructor |
| Defining fat interfaces on the producer | Forces big mocks, tight coupling | Small consumer-side interfaces |
| Using globals / `init()` for DB clients | Breaks parallel tests, hides graph | Wire in `main` |
| Passing deps through `context.Value` | Service locator, type-unsafe | Pass as struct fields/params |
| Returning interfaces from constructors | Hides concrete type, limits caller | Return `*Concrete` |
| Over-mocking (mock everything) | Tests assert implementation, not behavior | Prefer real/fake collaborators |
| `nil` dependency not validated | Panics deep in a request | Guard or rely on compile-time wire |

A subtle one: accepting `*sql.DB` everywhere instead of a small `Querier` interface means every test needs a live database. Wrap it behind the narrowest interface the consumer actually uses.

## 8. Performance Considerations

DI's runtime cost is almost entirely in **interface dispatch and allocation**, and it is small:

- An interface method call is one indirect call through the itab — roughly the cost of a virtual call, a handful of nanoseconds, and it defeats inlining. For hot inner loops (millions of calls), prefer concrete types or generics over interface dispatch.
- Storing a `*Struct` in an interface causes **one heap allocation** at wiring time. Since wiring happens once at startup, this is irrelevant to request throughput.
- `wire` adds **zero** runtime cost — the generated code is identical to hand-written constructor calls and is fully inlinable/escape-analyzable.
- Reflection containers (`dig`/`fx`) add **startup** cost (graph building) but not per-request cost once resolved. For a service that starts once and runs for weeks, this is negligible.

> [!NOTE]
> Generics (Go 1.18+) let you inject behavior with *static* dispatch: `func NewCache[K comparable, V any](loader Loader[K, V])` keeps the seam without the itab indirection. Use this only when profiling shows interface dispatch is a real bottleneck — readability usually wins.

## 9. Best Practices

- **Wire at the edges.** Construct the entire object graph in `main()` (or a single `wire.go`). Everything below `main` should be pure constructor injection.
- **Accept interfaces, return structs.** Constructors take interface params and return `*Concrete`.
- **Keep interfaces tiny** and consumer-defined. One method is fine and common.
- **Don't inject what you don't need to swap.** A pure helper doesn't need an interface; injecting everything is over-engineering.
- **Pair construction with cleanup.** Return a `func()` to close pools, or use `defer` in `main`.
- **Validate critical deps** (`if log == nil { log = slog.Default() }`) or rely on `wire`'s compile-time guarantee.
- **No service locators, no DI in `context`.** Dependencies belong in signatures.
- **Reach for `wire` only when manual wiring genuinely hurts** — typically 25+ providers.

## 10. Code Examples

Primary idiomatic example — manual constructor injection wired in `main`, with a fake for testing:

```go
package main

import (
    "context"
    "errors"
    "log/slog"
    "os"
)

type User struct{ ID, Name string }

// Consumer-defined, narrow interface.
type UserRepo interface {
    Get(ctx context.Context, id string) (*User, error)
}

type Service struct {
    repo UserRepo
    log  *slog.Logger
}

func NewService(repo UserRepo, log *slog.Logger) *Service {
    return &Service{repo: repo, log: log}
}

func (s *Service) Greeting(ctx context.Context, id string) (string, error) {
    u, err := s.repo.Get(ctx, id)
    if err != nil {
        return "", err
    }
    return "Hello, " + u.Name, nil
}

// --- production implementation ---
type PostgresRepo struct{ /* db *pgxpool.Pool */ }

func (r *PostgresRepo) Get(ctx context.Context, id string) (*User, error) {
    return &User{ID: id, Name: "Anuj"}, nil // pretend it queries Postgres
}

func main() {
    log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
    svc := NewService(&PostgresRepo{}, log) // wiring happens here, once
    msg, _ := svc.Greeting(context.Background(), "42")
    log.Info("result", "msg", msg)
}

// --- in service_test.go: inject a fake, no DB needed ---
type fakeRepo struct {
    u   *User
    err error
}

func (f fakeRepo) Get(context.Context, string) (*User, error) {
    if f.err != nil {
        return nil, f.err
    }
    return f.u, nil
}

func ExampleService() {
    svc := NewService(fakeRepo{u: &User{Name: "Test"}}, slog.Default())
    msg, err := svc.Greeting(context.Background(), "1")
    _ = errors.Is(err, nil)
    _ = msg // "Hello, Test"
}
```

Alternative — the same graph wired by `google/wire` (you write providers + a `wire.Build`; `wire` generates the constructor calls):

```go
//go:build wireinject

package main

import (
    "log/slog"
    "os"

    "github.com/google/wire"
)

func provideLogger() *slog.Logger {
    return slog.New(slog.NewJSONHandler(os.Stdout, nil))
}

func provideRepo() UserRepo { return &PostgresRepo{} }

// InitializeService declares the graph; wire fills in the body.
func InitializeService() *Service {
    wire.Build(NewService, provideRepo, provideLogger)
    return nil // replaced by generated wire_gen.go
}
```

Running `wire` then generates `wire_gen.go` shown below.

```go
// Code generated by Wire. DO NOT EDIT.
func InitializeService() *Service {
    logger := provideLogger()
    userRepo := provideRepo()
    service := NewService(userRepo, logger)
    return service
}
```

Notice the generated code is exactly the hand-wiring from `main` — proof that wire is "manual DI, automated," not a runtime container.

## 11. Advanced Concepts

- **Functional options as injection.** For optional dependencies, `NewServer(opts ...Option)` where each `Option` is a `func(*Server)` lets callers inject only what they need. This is how `grpc.NewServer` and many libraries do configurable construction.
- **Provider sets and cleanups in wire.** `wire.NewSet` groups related providers; providers can return `(T, func(), error)` so wire threads cleanup and error handling through the generated graph in correct (reverse-construction) order.
- **Interface bindings.** `wire.Bind(new(UserRepo), new(*PostgresRepo))` tells wire to satisfy the interface with a concrete type — the codegen equivalent of choosing an implementation.
- **Generics-based DI.** Inject statically-dispatched strategies: `type Handler[T any] struct{ store Store[T] }`. Trades flexibility (no runtime swap) for inlining and type safety.
- **Lifecycle frameworks (`fx`).** When you need uniform start/stop ordering, health hooks, and observability across a fleet, `fx`'s `OnStart`/`OnStop` lifecycle hooks and module system add structure a hand-rolled `main` lacks — at the cost of a reflection container and a learning curve.
- **Method / setter injection** exists (set a dep after construction) but is discouraged in Go; it allows partially-initialized objects. Prefer constructor injection so an object is valid the moment it exists.

## 12. Debugging Tips

- **"wire: no provider found for X"** — your graph is incomplete; add a provider whose *return type* matches the missing parameter type. Wire matches strictly by type, so two `string` deps need distinct named types or a struct.
- **"cycle in provider graph"** — A needs B needs A. Break it by introducing an interface or splitting responsibilities; cycles usually reveal a design problem.
- **Nil-pointer panic deep in a handler** — a dependency was never wired (often a `nil` interface passed in tests). Add constructor guards or let `wire` catch it at compile time.
- **Tests flaky in parallel** — you're sharing a global/singleton dependency. Inject a fresh instance per test instead.
- **"interface conversion: *T is not UserRepo"** — the concrete type doesn't satisfy the interface (missing method, or value vs pointer receiver mismatch). Add `var _ UserRepo = (*PostgresRepo)(nil)` as a compile-time assertion at the implementation site.
- To *see* the graph wire built, just read `wire_gen.go` — it's plain, reviewable Go.

## 13. Senior Engineer Notes

As a senior engineer, your DI judgement shows up in **reviews and design**, not in choosing a library:

- **Push back on constructors with many parameters.** It's the clearest cohesion smell in the codebase. Ask "should this be two types?" before reaching for a params struct.
- **Police interface placement.** In review, flag interfaces declared next to their sole implementation — that's a Java reflex, not Go. Move the interface to the consumer and shrink it.
- **Reject hidden dependencies.** Any `os.Getenv`, `time.Now()`, `http.DefaultClient`, or `sql.Open` inside business logic is a missing seam. Inject a clock, a config, an HTTP client.
- **Mentor on test design.** Steer juniors away from mocking everything; teach in-memory fakes and "assert behavior, not interaction." Over-mocked tests are change-detector tests that punish refactoring.
- **Know when *not* to inject.** Pure functions and stdlib helpers don't need interfaces. Over-abstraction is as costly as under-abstraction; DI is a tool, not a religion.
- **Make construction fail fast.** Validate required deps in the constructor so a misconfigured service dies at startup, not under production load.

## 14. Staff Engineer Notes

At staff level the questions become **org-wide and build-vs-buy**:

- **Standardize the wiring approach across teams.** The expensive failure mode is ten services each inventing a different DI style. Pick one default (usually manual wiring; `wire` for large graphs) and document it. Consistency lowers the cost of engineers moving between services.
- **Build-vs-buy on DI frameworks.** `fx`/`dig` buy you uniform lifecycle management, graceful shutdown, and observability hooks across a fleet — real value at 100+ services. The cost is a runtime reflection container, harder debugging, and onboarding overhead. For a handful of services, that trade rarely pays; mandating `fx` org-wide is a decision to make deliberately, not by default.
- **Treat the dependency graph as architecture.** The shape of `main()`'s wiring *is* your layering. If wiring requires reaching across bounded contexts, your module boundaries are wrong. Use DI as a diagnostic for coupling.
- **Compile-time over runtime guarantees at scale.** Across many services, `wire`'s build-time "missing provider" error prevents a class of production incidents that runtime containers turn into 3am panics. That predictability is worth advocating for org-wide.
- **Govern the seams for testing strategy.** Mandate that external I/O (DB, queues, third-party APIs) always sits behind injectable interfaces, so every team can run hermetic tests and the org can adopt contract testing uniformly.
- **Resist DI-as-magic.** The Go community's strength is explicitness. A staff engineer protects that culture: prefer boring, readable wiring that any engineer can trace with "go to definition" over clever runtime resolution that only the author understands.

## 15. Revision Summary

- DI = pass dependencies in (constructor injection), don't construct them inside.
- Idiomatic Go = manual wiring in `main`; no runtime container needed.
- Built on interfaces (implicit, consumer-defined, *small*) and structs as values.
- **Accept interfaces, return concrete structs.** Define interfaces at the consumer.
- Internals: interface = 2-word `(itab, data)` header; itab cached; storing `*T` in an interface escapes to heap once at wiring.
- `google/wire` = compile-time codegen of the same constructor calls (zero runtime cost); `dig`/`fx` = runtime reflection containers (startup cost, lifecycle hooks).
- Biggest win: **testability** via seams — inject fakes/mocks; prefer fakes.
- Anti-patterns: globals/`init()`, service locators, deps in `context.Value`, fat producer-side interfaces, over-mocking.
- Cost is tiny: one indirect call + one startup allocation per injected interface.
- Senior lens: review constructor cohesion, interface placement, hidden deps. Staff lens: standardize approach, build-vs-buy on `fx`, graph-as-architecture.

**References:** [google/wire](https://github.com/google/wire) · [uber-go/dig](https://github.com/uber-go/dig) · [uber-go/fx](https://github.com/uber-go/fx) · Go proverb "Accept interfaces, return structs."

---

*Go Engineering Handbook — topic 66.*
