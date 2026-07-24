# 30 · Design: gRPC Interview Questions & System Design Rounds

> **In one line:** A gRPC design round is not a protocol quiz — it is a test of whether you can derive a method surface from use cases, name the decisions that cannot be changed later, and defend the trade-offs out loud.

---

## 1. Overview

This chapter is the synthesis. Everything in the previous twenty-nine chapters exists somewhere in a real design round, and the job here is to organise it into something you can execute under time pressure.

Interviews at different levels probe different things:

- **Mid-level** — mechanics. Can you write a handler, handle `io.EOF`, choose a status code, set a deadline?
- **Senior** — judgement. Why this RPC shape? What breaks at 10×? Which decisions are irreversible?
- **Staff / Principal** — organisational consequence. How does this schema evolve across fifteen teams? What is the migration? What is the failure mode you would page on?

The single behaviour that separates a good round from a bad one is **naming the irreversible decisions early**. Roughly half of gRPC design is impossible to change later without a breaking change: field numbers, method granularity, idempotency keys, pagination shape, stream resumption. A candidate who says "these five things I want to get right now, the rest we can iterate on" has demonstrated more than one who produces a longer method list.

The chapter has three parts: a repeatable procedure for any gRPC design round, three worked designs at increasing difficulty, and a question bank organised by what it is actually testing.

## 2. Core Concepts

- **Design round** — 45 minutes, open-ended, judged on reasoning rather than a correct answer.
- **The irreversible set** — decisions that cannot change without a breaking change or a v2.
- **Use-case-driven surface** — methods derived from sentences about the domain, not from tables.
- **Shape justification** — every streaming method needs a reason the unary alternative was rejected.
- **Failure vocabulary** — the status code and structured detail per failure condition, decided up front.
- **Budget arithmetic** — how a deadline divides across a call chain.
- **The 10× question** — what breaks first when traffic multiplies, and what you would do about it.
- **Blast radius** — what a bad deploy of this service does to its callers.
- **Migration plan** — how you get from the current state to the design without an outage.
- **Explicit trade-off** — saying what you gave up, unprompted. The strongest signal available.

## 3. Theory & Principles

### The ten-step procedure

Work these in order. Steps 1–3 take ten minutes and determine everything else.

1. **Clarify consumers and traffic.** Who calls this — internal services, mobile, partners, browsers? QPS, payload sizes, latency SLO, growth. This decides gRPC-vs-REST, method granularity and whether you need an edge translation layer.
2. **Write the domain in sentences and underline the verbs.** Each verb is a candidate method. This is faster and more defensible than starting from an entity list.
3. **Choose the RPC shape per method** from the data, not from taste: bounded in and out is unary; unbounded *in time* is server streaming; unbounded input with one summary is client streaming; independent two-way traffic is bidi. **Justify every stream by saying why unary plus pagination was rejected.**
4. **Design the resource.** Opaque string ids, `Timestamp`/`Duration`/`Money` well-known types, enums with `UNSPECIFIED = 0`, `optional` only where a zero value is meaningful, numbers 1–15 for always-present fields.
5. **Fix the cross-cutting contracts** — the irreversible set: cursor pagination with a server-clamped page size, `FieldMask` plus an etag for updates, an idempotency key on every mutation, a lifetime cap and resume token on every stream, explicit bounds on every repeated field.
6. **Write the failure vocabulary.** Per method: each condition, its status code, its stable `ErrorInfo.reason`, and whether it is retryable.
7. **Deadlines and retries.** The budget per method, how it divides across downstream calls, which methods retry and why that is safe.
8. **Cross-cutting infrastructure.** Interceptor chain in order, auth model, observability signals.
9. **Deployment.** Load balancing, `MaxConnectionAge`, health probes, graceful shutdown, and the edge layer if any.
10. **The 10× question.** What breaks first, how you would detect it, what you would do.

### What interviewers are actually scoring

| Signal | Weak | Strong |
|---|---|---|
| Requirements | Starts designing immediately | Asks about consumers, QPS, SLO first |
| Method surface | Mirrors database tables | Derived from use-case sentences |
| Streaming | Uses it because it is available | Justifies why unary was rejected |
| Irreversibility | Treats everything as changeable | Names what cannot change later |
| Errors | "Returns an error" | Code + stable reason + retryability per condition |
| Deadlines | Mentions timeouts | Budget arithmetic across the chain |
| Trade-offs | Only advantages | States what was given up, unprompted |
| Scale | "Add more replicas" | Names the specific first bottleneck |
| Operations | Ignores deploys | Load balancing, drains, rollback |

The two strongest moves available, both cheap: **name the irreversible decisions**, and **state a trade-off before being asked**. Both signal that you have shipped something.

```svg
<svg viewBox="0 0 880 500" width="100%" height="500" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The irreversible set: decide these in the first ten minutes</text>

  <rect x="24" y="42" width="410" height="290" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="229" y="64" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Cannot change without a breaking change</text>
  <g font-size="10">
    <text x="42" y="90" fill="#7f1d1d" font-weight="bold">Field numbers</text>
    <text x="200" y="90" fill="#991b1b">reuse = SILENT corruption (ch. 13)</text>
    <text x="42" y="112" fill="#7f1d1d" font-weight="bold">Proto package + vN</text>
    <text x="200" y="112" fill="#991b1b">no version segment = no migration path</text>
    <text x="42" y="134" fill="#7f1d1d" font-weight="bold">Method granularity</text>
    <text x="200" y="134" fill="#991b1b">too fine = N+1 across the network</text>
    <text x="42" y="156" fill="#7f1d1d" font-weight="bold">Idempotency key</text>
    <text x="200" y="156" fill="#991b1b">retries are automatic; safety is not</text>
    <text x="42" y="178" fill="#7f1d1d" font-weight="bold">Pagination shape</text>
    <text x="200" y="178" fill="#991b1b">offset &#8594; cursor is a breaking change</text>
    <text x="42" y="200" fill="#7f1d1d" font-weight="bold">Stream resumption</text>
    <text x="200" y="200" fill="#991b1b">no resume token = restart from zero</text>
    <text x="42" y="222" fill="#7f1d1d" font-weight="bold">Request/response sharing</text>
    <text x="200" y="222" fill="#991b1b">shared = unevolvable forever</text>
    <text x="42" y="244" fill="#7f1d1d" font-weight="bold">Enum zero value</text>
    <text x="200" y="244" fill="#991b1b">a real state at 0 = absence undetectable</text>
    <text x="42" y="266" fill="#7f1d1d" font-weight="bold">Money and id types</text>
    <text x="200" y="266" fill="#991b1b">double for money is a correctness bug</text>
  </g>
  <text x="42" y="298" fill="#b91c1c" font-size="10" font-weight="bold">Saying "these are the ones I want right now" is the</text>
  <text x="42" y="314" fill="#b91c1c" font-size="10" font-weight="bold">strongest cheap signal available in the round.</text>

  <rect x="446" y="42" width="410" height="290" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="651" y="64" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Can iterate on later</text>
  <g font-size="10" fill="#166534">
    <text x="464" y="90">&#8226; adding fields, messages, RPCs, enum values</text>
    <text x="464" y="112">&#8226; interceptor chain composition and order</text>
    <text x="464" y="134">&#8226; retry policy, backoff, hedging (service config)</text>
    <text x="464" y="156">&#8226; deadline values per method</text>
    <text x="464" y="178">&#8226; load-balancing model &#8212; client-side / proxy / mesh</text>
    <text x="464" y="200">&#8226; observability: metrics, traces, sampling</text>
    <text x="464" y="222">&#8226; message-size and concurrency limits</text>
    <text x="464" y="244">&#8226; compression, window sizes, buffer tuning</text>
    <text x="464" y="266">&#8226; the storage engine behind it all</text>
  </g>
  <text x="464" y="298" fill="#15803d" font-size="10" font-weight="bold">Spending round time here is a mistake &#8212; it is</text>
  <text x="464" y="314" fill="#15803d" font-size="10" font-weight="bold">visible work that costs nothing to change later.</text>

  <rect x="24" y="352" width="832" height="136" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="374" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Choosing the RPC shape &#8212; from the data, not from taste</text>
  <g font-size="10">
    <text x="48" y="400" fill="#1e40af" font-weight="bold">bounded in, bounded out</text>
    <text x="300" y="400" fill="#1d4ed8">&#8594; unary. The default; justify away from it, not toward it.</text>
    <text x="48" y="422" fill="#15803d" font-weight="bold">unbounded IN TIME</text>
    <text x="300" y="422" fill="#166534">&#8594; server streaming. A live feed &#8212; NOT merely "a lot of rows".</text>
    <text x="48" y="444" fill="#92400e" font-weight="bold">unbounded input, one summary</text>
    <text x="300" y="444" fill="#b45309">&#8594; client streaming. And it is not atomic.</text>
    <text x="48" y="466" fill="#5b21b6" font-weight="bold">independent two-way traffic</text>
    <text x="300" y="466" fill="#6d28d9">&#8594; bidi. Most expensive: pins a connection, stalls deploys.</text>
  </g>
</svg>
```

### The three questions that end weak answers

Interviewers use these because they cannot be answered from memory:

1. **"Why is that a stream rather than pagination?"** Streams are not resumable, do not load-balance per call, defeat the built-in retry policy and stall `GracefulStop`. If the answer is "there is a lot of data", pagination is better. The valid answer is "the data is unbounded *in time* — it is a live feed."
2. **"What happens when the client retries this?"** Every mutation must have an answer. Without an idempotency key, the honest answer is "it happens twice", and that is a schema decision that cannot be retrofitted.
3. **"What breaks first at 10×?"** A specific bottleneck with a detection signal beats "we'd scale horizontally". For most gRPC services the honest answer is load balancing, followed by the datastore.

## 4. Architecture & Workflow

**The 45-minute budget:**

| Time | Activity |
|---|---|
| 0–5 | Clarify consumers, traffic, SLO, constraints |
| 5–10 | Domain sentences → method list with shapes |
| 10–20 | Resource design + the irreversible set |
| 20–28 | Failure vocabulary, deadlines, retries |
| 28–36 | Interceptors, auth, observability |
| 36–42 | Deployment, load balancing, the 10× question |
| 42–45 | Trade-offs and what you would do differently |

Two habits that consistently improve outcomes. **Write the method table visibly** — name, shape, deadline, idempotent, error codes — because it makes the design reviewable and gives the interviewer something to probe. And **say the trade-off out loud at each decision**: "I am choosing cursor pagination, which costs the ability to jump to page 50 and buys stability under concurrent writes."

```svg
<svg viewBox="0 0 880 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="ir1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#0ea5e9"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The 45-minute shape</text>

  <rect x="30" y="42" width="120" height="58" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="90" y="62" text-anchor="middle" fill="#1e40af" font-size="10" font-weight="bold">0&#8211;5 min</text>
  <text x="90" y="78" text-anchor="middle" fill="#1d4ed8" font-size="9">consumers, QPS</text>
  <text x="90" y="92" text-anchor="middle" fill="#1d4ed8" font-size="9">SLO, constraints</text>
  <path d="M152,71 L172,71" stroke="#0ea5e9" stroke-width="2" marker-end="url(#ir1)"/>

  <rect x="176" y="42" width="120" height="58" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="236" y="62" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">5&#8211;10 min</text>
  <text x="236" y="78" text-anchor="middle" fill="#166534" font-size="9">domain sentences</text>
  <text x="236" y="92" text-anchor="middle" fill="#166534" font-size="9">&#8594; methods + shapes</text>
  <path d="M298,71 L318,71" stroke="#0ea5e9" stroke-width="2" marker-end="url(#ir1)"/>

  <rect x="322" y="42" width="140" height="58" rx="8" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="392" y="62" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">10&#8211;20 min</text>
  <text x="392" y="78" text-anchor="middle" fill="#991b1b" font-size="9">resource design +</text>
  <text x="392" y="92" text-anchor="middle" fill="#991b1b" font-size="9">THE IRREVERSIBLE SET</text>
  <path d="M464,71 L484,71" stroke="#0ea5e9" stroke-width="2" marker-end="url(#ir1)"/>

  <rect x="488" y="42" width="120" height="58" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="548" y="62" text-anchor="middle" fill="#92400e" font-size="10" font-weight="bold">20&#8211;28 min</text>
  <text x="548" y="78" text-anchor="middle" fill="#b45309" font-size="9">errors, deadlines</text>
  <text x="548" y="92" text-anchor="middle" fill="#b45309" font-size="9">retries</text>
  <path d="M610,71 L630,71" stroke="#0ea5e9" stroke-width="2" marker-end="url(#ir1)"/>

  <rect x="634" y="42" width="110" height="58" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="689" y="62" text-anchor="middle" fill="#5b21b6" font-size="10" font-weight="bold">28&#8211;36 min</text>
  <text x="689" y="78" text-anchor="middle" fill="#6d28d9" font-size="9">interceptors,</text>
  <text x="689" y="92" text-anchor="middle" fill="#6d28d9" font-size="9">auth, telemetry</text>
  <path d="M746,71 L766,71" stroke="#0ea5e9" stroke-width="2" marker-end="url(#ir1)"/>

  <rect x="770" y="42" width="86" height="58" rx="8" fill="#f1f5f9" stroke="#64748b" stroke-width="2"/>
  <text x="813" y="62" text-anchor="middle" fill="#334155" font-size="10" font-weight="bold">36&#8211;45</text>
  <text x="813" y="78" text-anchor="middle" fill="#475569" font-size="9">deploy, 10&#215;,</text>
  <text x="813" y="92" text-anchor="middle" fill="#475569" font-size="9">trade-offs</text>

  <rect x="30" y="120" width="826" height="130" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="443" y="142" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Write this table visibly &#8212; it makes the design reviewable</text>
  <g font-family="ui-monospace,monospace" font-size="10" fill="#334155">
    <text x="48" y="168">METHOD              SHAPE     DEADLINE  IDEMPOTENT  ERRORS</text>
    <text x="48" y="188">GetItem             unary     1s        yes (read)  NOT_FOUND, INVALID_ARGUMENT</text>
    <text x="48" y="206">ListItems           unary     3s        yes (read)  INVALID_ARGUMENT (bad cursor)</text>
    <text x="48" y="224">ReserveStock        unary     2s        via KEY     FAILED_PRECONDITION, ALREADY_EXISTS</text>
    <text x="48" y="242">WatchStock          server    30m cap   n/a         UNAVAILABLE (reconnect), OUT_OF_RANGE</text>
  </g>

  <rect x="30" y="268" width="826" height="152" rx="10" fill="#fefce8" stroke="#ca8a04" stroke-width="2"/>
  <text x="443" y="290" text-anchor="middle" fill="#854d0e" font-size="12" font-weight="bold">Three questions that end weak answers</text>
  <text x="48" y="316" fill="#713f12" font-weight="bold">1. "Why a stream rather than pagination?"</text>
  <text x="48" y="332" fill="#854d0e">If the answer is "there's a lot of data", pagination wins &#8212; it is resumable, load-balances, and retries.</text>
  <text x="48" y="348" fill="#854d0e">The valid answer: "unbounded IN TIME &#8212; a live feed."</text>
  <text x="48" y="372" fill="#713f12" font-weight="bold">2. "What happens when the client retries this?"</text>
  <text x="48" y="388" fill="#854d0e">Without an idempotency key the honest answer is "it happens twice" &#8212; and that cannot be retrofitted.</text>
  <text x="48" y="406" fill="#713f12" font-weight="bold">3. "What breaks first at 10&#215;?"</text>
  <text x="48" y="422" fill="#854d0e">Name a specific bottleneck and its detection signal. For most gRPC services: load balancing, then the datastore.</text>
</svg>
```

## 5. Implementation

### Worked design 1 — Ride-hailing dispatch (mid/senior)

**Prompt.** "Design the gRPC API between the rider app, the driver app and the dispatch service."

**Clarify (2 min).** Consumers: mobile apps (not browsers) and internal services. 50k concurrent drivers each sending location every 4 s = 12.5k writes/s. Rider requests ~500/s peak. Latency SLO: matching under 3 s. Location data is high-volume and lossy-tolerant; ride state is not.

**Domain sentences.** *A rider requests a ride. Dispatch matches it to a driver. The driver accepts or declines. Both track the ride's progress. Drivers continuously report location. Riders watch their driver approach. Either side may cancel.*

**Method surface:**

```protobuf
service DispatchService {
  // Unary + idempotency: creating a ride request twice is a real bug, and a
  // mobile network guarantees retries.
  rpc RequestRide(RequestRideRequest) returns (RequestRideResponse);

  // Server streaming: unbounded IN TIME. The rider watches state change until
  // the ride ends. Pagination is meaningless here — this is the valid case.
  rpc WatchRide(WatchRideRequest) returns (stream RideEvent);

  // Bidi: the driver app streams location AND receives dispatch offers on the
  // same session. Two independent directions is exactly what bidi is for, and
  // it avoids a second connection from a battery-constrained device.
  rpc DriverSession(stream DriverMessage) returns (stream DispatchMessage);

  // Unary + idempotency. Cancellation must never double-charge.
  rpc CancelRide(CancelRideRequest) returns (CancelRideResponse);
}
```

**Justifications the interviewer will ask for:**

- *Why is location bidi rather than client streaming?* Because the server must push dispatch offers to the driver, unsolicited. Client streaming has no return path until the end. A separate server-streaming call would mean two connections from a phone — worse for battery and for reconnection logic.
- *Why is `RequestRide` unary rather than streaming?* One request, one response. Matching is asynchronous, so it returns a ride id immediately and the rider follows progress on `WatchRide`. That also makes the request retryable.
- *Location loss tolerance.* Location is high-frequency and stale within seconds, so a dropped message costs nothing — no per-message acknowledgement, no resumption. Ride state is the opposite and lives on the durable path.

**The irreversible set here:** the idempotency key on `RequestRide` and `CancelRide`; the resume token on `RideEvent`; the correlation id on `DriverMessage`/`DispatchMessage` since bidi pairs by id not order; the ride-state enum with `UNSPECIFIED = 0`; and treating fares as `int64` minor units.

**10×.** The driver session count is the first constraint: 500k concurrent bidi streams means 500k goroutine pairs plus connections. Streams pin to pods, so scaling requires either short session lifetimes with reconnection or a sharded dispatch tier keyed by geography. I would cap sessions at 15 minutes with a resume token and shard by geohash before that becomes urgent.

### Worked design 2 — Multi-tenant metrics ingestion (senior)

**Prompt.** "Design a gRPC ingestion API for a metrics platform. 500k data points per second across 10k tenants."

**Clarify.** Writers are agents on customer infrastructure — high volume, unreliable networks, tolerant of seconds of delay. Readers are dashboards needing sub-second queries. Tenants must be isolated and quota-limited. Ordering does not matter; duplicates must be idempotent.

**Method surface:**

```protobuf
service IngestService {
  // Client streaming: unbounded input from a long-lived agent, one summary.
  // Batching inside the stream is what makes 500k/s achievable — one message
  // per data point would be 500k RPCs/s of pure framing overhead.
  rpc IngestStream(stream IngestBatch) returns (IngestSummary);

  // Unary alternative for constrained agents that cannot hold a stream —
  // serverless functions, or anything behind a proxy that kills long
  // connections. Same batch shape, so the server logic is shared.
  rpc IngestBatchUnary(IngestBatch) returns (IngestBatchResponse);
}

message IngestBatch {
  // Bounded: 1..1000. An unbounded repeated field is a memory-exhaustion
  // vector, and MaxRecvMsgSize counts bytes, not elements.
  repeated DataPoint points = 1;

  // Per-BATCH idempotency, so a resumed upload does not double-count. Not per
  // point: at 500k/s the id overhead would exceed the payload.
  string batch_id = 2;
}
```

**Key decisions and their trade-offs:**

- **Client streaming, not unary per point.** Amortises framing, auth and interceptor cost across 1000 points. The cost is no per-message acknowledgement and no atomicity — acceptable, because metrics ingestion is best-effort by nature and the summary reports rejections precisely.
- **Batch-level idempotency.** Per-point ids would double the payload. The trade is coarser deduplication: a partially-applied batch replays fully, which for idempotent metric writes is harmless.
- **Quota in an interceptor, keyed on tenant.** After auth, so limits follow identity rather than IP, returning `ResourceExhausted` with `RetryInfo` so agents back off correctly rather than hammering.
- **Both a streaming and a unary path.** Duplication of surface, justified because a stream cannot survive some deployment environments. Both share one handler, so behaviour cannot diverge.

**10×.** At 5M points/s the bottleneck moves from gRPC to storage write amplification. The gRPC-side answer is more replicas with correct load balancing; the real answer is that ingestion should write to a log and let storage consume asynchronously, at which point the gRPC service is a thin, stateless, trivially scalable front door. I would design for that from the start rather than retrofitting it.

### Worked design 3 — Migrating a 40-service REST estate (staff)

**Prompt.** "Your company has 40 services on JSON/HTTP. Should you migrate to gRPC, and how?"

The correct opening is that **the answer is not "yes, all of it"** — and saying so is the point of the question.

**Assess first.** Rank call graphs by QPS, p99 and payload size. Identify where serialisation and connection overhead are a real budget line, and where they are noise against a 50 ms database query. Most estates have three or four hot paths and thirty-six that would gain nothing.

**Prerequisites before any migration:**

1. **Schema governance.** A `.proto` repository or monorepo with `buf lint` and `buf breaking` at `FILE` in CI against the last release. Without this, gRPC's compile-time contract becomes a liability at forty services.
2. **A load-balancing story.** L4 balancing stops working the day you switch (chapter 29). Decide headless plus client-side, an L7 proxy, or a mesh, and prove it with a scale-up under load *before* migrating anything.
3. **Observability parity.** A common `code` label across both protocols so dashboards do not fragment into two half-blind halves.
4. **A codegen pipeline** that is reproducible, with a CI gate on generated-code freshness.

**Sequencing.** Migrate one hot internal path, keeping the REST endpoint alive and dual-serving. Measure the actual delta rather than assuming it. Keep the edge on JSON permanently, generated from the same `.proto` via `grpc-gateway` or Connect. Expect to end with a hybrid estate and say so up front, so nobody treats the remaining REST as unfinished work.

**Rollback plan.** Dual-serving means rollback is a client configuration change, not a redeploy. That is what makes the first migration safe to attempt.

**What you would say if pushed on cost:** the migration is mostly organisational, not technical. Forty teams need to learn a toolchain, a review process and a new debugging workflow. The technical work on any single service is days; the estate-wide change is quarters. A candidate who says this has been through it.

### The question bank, by what it tests

**Mechanics (mid-level).**

- Name the four RPC patterns and a use case for each. → Chapter 5.
- What does `io.EOF` mean from `Recv`, and from `Send`? → Chapter 20. Success; server closed early.
- Why must you embed `UnimplementedXxxServer`? → Chapter 7. Forward compatibility, by value.
- What happens if you return a plain Go error? → Chapter 22. `Unknown` plus your internal string.
- How many `ClientConn`s should you create? → Chapter 19. One per target, goroutine-safe.
- Where does the gRPC status travel? → Chapter 2. HTTP/2 trailers, after the body.

**Judgement (senior).**

- When is streaming the wrong choice? → Chapter 5. Bounded data the client wants a page of.
- `InvalidArgument` or `FailedPrecondition`? → Chapter 22. Bad request vs bad state.
- Why does a Kubernetes `Service` not balance gRPC? → Chapter 29. L4 balances connections.
- How do you make a stream deployable? → Chapter 16. Lifetime cap plus resume token.
- Which changes are always safe to a schema? → Chapter 13. Additive only.
- Should you enable compression? → Chapter 28. Usually not inside a datacentre.
- How do you handle auth on a long stream? → Chapter 24. Cap lifetime below token validity.

**Consequence (staff).**

- Design a deprecation policy for many consumers. → Chapter 13. Measure, deprecate, notify by name, wait, delete with `reserved`.
- A downstream degrades and your fleet falls over — explain. → Chapter 21. Retry amplification plus deadline exhaustion.
- How do you keep a schema evolvable across fifteen teams? → Chapters 8, 13. Enforcement in CI, not documentation.
- A streaming method was found unauthenticated in production. → Chapter 24. Only the unary interceptor existed; fail closed plus a reflection test.
- p99 doubled with no error-rate change. Investigate. → Chapters 26, 28. Trace to localise, then pprof; suspect GC and LB skew.

## 6. Advantages, Disadvantages & Trade-offs

**What this procedure gives you**
- **A defensible order** — requirements before design, irreversible decisions before details.
- **Visible artefacts** — the method table gives the interviewer something concrete to probe.
- **Time discipline** — 45 minutes is not enough to cover everything, so the budget forces prioritisation.
- **Trade-off vocabulary** — every decision has a named cost, which is what senior signal looks like.

**Where it can go wrong**
- **Over-structuring.** Reciting a procedure without engaging with the specific problem reads as rehearsed.
- **Too long on requirements.** Five minutes, not fifteen. The interviewer wants to see design.
- **Depth in the comfortable area.** Spending twenty minutes on the `.proto` and none on operations is a common failure.

**Trade-offs in the round itself**
- *Breadth vs depth:* covering all ten steps shallowly beats three steps deeply, because the round is scored on judgement across the surface. Go deep only where the interviewer probes.
- *Ideal design vs pragmatic:* proposing an event-sourced CQRS system for a CRUD service signals poor judgement. Match the design to the stated scale.
- *Confidence vs honesty:* "I do not know, here is how I would find out" is a strong answer. Bluffing a number is the weakest thing you can do.

## 7. Common Mistakes & Best Practices

- **Designing before asking about consumers and traffic.** Everything downstream depends on it.
- **Deriving methods from tables.** Use-case sentences produce better surfaces and are easier to defend.
- **Streaming because it is available.** Every stream needs a stated reason unary was rejected.
- **Ignoring idempotency on mutations.** "What happens when the client retries?" has no good answer without a key.
- **Offset pagination.** Breaks under concurrent writes and degrades with depth; switching later is breaking.
- **"It returns an error."** Name the code, the stable reason and whether it is retryable.
- **Mentioning timeouts without arithmetic.** Show how the budget divides across the chain.
- **Ignoring deployment.** Load balancing is the most common real-world gRPC failure and interviewers know it.
- **Only listing advantages.** State the cost of each choice unprompted.
- **"We'd scale horizontally."** Name the specific first bottleneck and how you would detect it.
- **Not naming the irreversible decisions.** The cheapest strong signal available, and most candidates skip it.
- **Over-engineering for imaginary scale.** Design for the stated numbers, and say what you would change at 10×.

## 8. Production: Debugging, Monitoring, Security & Scaling

These four are where senior rounds spend their last fifteen minutes, and where most candidates are thinnest.

- **Debugging.** Be able to say concretely: reflection plus `grpcurl` for manual calls, traces to localise a slow hop, pprof for CPU and allocation, goroutine profiles for stuck streams, channelz for connection state, and `GRPC_GO_LOG_VERBOSITY_LEVEL=99` for transport problems. Naming the tool and what it answers is the signal.
- **Monitoring.** RED per method plus the streaming set, alerts split by code class because `Internal`, `Unavailable` and `DeadlineExceeded` have different owners, and the client-side attempts-to-calls ratio for retry storms. Say what you would page on and what you would merely graph.
- **Security.** Two layers — mTLS for workload identity, tokens for user identity — enforced in interceptors covering both unary and streams, over a fail-closed policy map, with a test enumerating every registered method. Stream lifetime capped below token validity.
- **Scaling.** The honest first bottleneck for most gRPC services is load balancing, not throughput. After that, the datastore. Say that, and say how you would verify it: scale under load and watch per-pod request rate converge.

## 9. Interview Questions

**Q: Walk me through how you would design a gRPC API from scratch.**
A: I start by asking who the consumers are, the traffic profile and the latency SLO, because that decides gRPC-versus-REST, method granularity and whether I need a JSON edge. Then I write the domain in sentences and underline the verbs, since each verb is a candidate method and the shape of its data decides the RPC kind — bounded in and out is unary, unbounded in time is server streaming, unbounded input with one summary is client streaming, independent two-way traffic is bidi. Then the resource: opaque ids, well-known types, enums with an `UNSPECIFIED` zero, `optional` only where a zero value is meaningful. Then the cross-cutting contracts that cannot be retrofitted: cursor pagination with a clamped page size, `FieldMask` plus etag on updates, idempotency keys on mutations, lifetime caps and resume tokens on streams, bounds on every repeated field. Then the failure vocabulary per method, deadline budgets, interceptors and auth, and finally deployment and what breaks at 10×. The part I would emphasise is that roughly half those decisions cannot be changed later without a breaking change, so I name them explicitly.

**Q: What makes a decision irreversible in gRPC?**
A: Anything the wire format or the client contract depends on. Field numbers — reusing one causes silent misinterpretation of old data rather than an error. Method granularity, because splitting or merging a method is a breaking change. Idempotency keys, since adding a required one later breaks every existing caller. Pagination shape, because offset to cursor changes the request contract. Stream resumption, since adding a resume token later means old clients still restart from zero. Request and response message sharing, because once two RPCs share a message neither can evolve independently. And the enum zero value, since a real state at zero makes absence permanently undetectable. Everything else — retry policy, deadlines, interceptors, load balancing, tuning — is configuration you can change on a Tuesday.

**Q: When is streaming genuinely the right choice?**
A: When the data is unbounded *in time*, not merely large. A live feed, progress on a long-running job, an interactive session — things where the client must learn about events as they happen and there is no natural end. Large-but-bounded data is pagination's job, because a page token is resumable and stateless while a stream restarts from zero on a disconnect, pins one connection to one backend, defeats the built-in retry policy and stalls `GracefulStop`. The test I apply is: if a client could reasonably ask for "the next 50", it is pagination.

**Q: How do you decide method granularity?**
A: By modelling use cases rather than tables. A method should correspond to something a caller actually wants to accomplish, so one round trip does one meaningful unit of work and can carry its own idempotency and authorization semantics. The failure modes are symmetric: too fine-grained and you rebuild the N+1 problem across the network, adding round trips and losing atomicity; too coarse and every caller pays for data it does not need and the method becomes impossible to authorize precisely or evolve. Where clients genuinely need different projections, the answer is a `FieldMask` rather than fifteen near-duplicate methods.

**Q: What breaks first when a gRPC service goes to 10× traffic?**
A: Almost always load balancing, and it breaks before throughput does. A standard Kubernetes `Service` balances connections at L4, and gRPC opens exactly one long-lived HTTP/2 connection, so scaling up delivers no traffic to new pods and the existing ones saturate while the new ones idle. The tell is per-pod request-rate variance, and the fix is a headless service with client-side `round_robin` plus `MaxConnectionAge` so clients re-resolve, or an L7 proxy. After that the bottleneck is normally the datastore rather than anything gRPC-related, and the answer there is architectural — batching, caching, or moving writes onto an async path.

**Q: How would you convince a team to adopt gRPC, and when would you advise against it?**
A: For: compile-time contract enforcement across languages catches a whole class of integration bug at build time; deadline propagation and standardised status codes give consistent timeout and retry semantics instead of one bespoke scheme per service; and on hot fan-out paths the serialisation and connection savings are a real budget line. Against: you need schema governance and a codegen pipeline before it helps rather than hurts; L4 load balancing stops working the day you switch; debugging opaque traffic needs new tooling and retraining; and any consumer that cannot take a codegen dependency needs a gateway. I would advise against it for a public partner API, for anything called directly from a browser without a translation layer, where HTTP caching or CDNs are load-bearing, and for a small team where the toolchain would cost more than the type safety is worth.

**Q: What is the most common gRPC mistake you have seen?**
A: Returning a raw Go error from a handler. It compiles, it looks fine in review, and it sends `codes.Unknown` with your internal error string — SQL fragments, file paths, hostnames — straight to the caller. It is simultaneously an information-disclosure problem and an operational one, because the client's retry logic and your alerting both key off the code and `Unknown` conveys nothing. The fix is structural rather than a code-review rule: sentinel errors in the domain layer, one mapping function at the transport boundary, and a test asserting no handler can produce `Unknown`.

**Q: (Senior) Design the gRPC API for a payments service, and defend the hard parts.**
A: The hard parts are all about exactly-once semantics under retries. Every mutating method — `CreatePayment`, `CapturePayment`, `RefundPayment` — takes a required client-generated idempotency key, retained for at least 24 hours, where the same key with the same body replays the original response and the same key with a different body is `AlreadyExists`. That is the single decision that cannot be retrofitted, so I state it first. Money is `int64` minor units plus a currency code, never a float, because binary floating point cannot represent decimal fractions exactly and that is a correctness bug rather than a rounding nicety. State transitions are explicit with an enum whose zero is `UNSPECIFIED`, and illegal transitions return `FailedPrecondition` with a `PreconditionFailure` detail naming the current and attempted states — not `InvalidArgument`, because the request is well-formed and the state is the problem. Concurrent modification returns `Aborted` with an etag, so the client knows to re-read and redo rather than retry as-is. Deadlines are short and explicit, and the retry policy is `maxAttempts: 1` on anything without a key. For payment status I would use unary polling with a webhook rather than a long stream, because a payment's terminal state must survive both ends restarting and a stream guarantees nothing after a disconnect. The trade I would name unprompted is that idempotency-key storage is real infrastructure with its own retention, sizing and failure modes.

**Q: (Senior) You inherit a gRPC service with no tests, no observability and single-pod deployment. What is your first month?**
A: In order of risk reduction per unit of effort. Week one: observability, because I cannot fix what I cannot see — `otelgrpc` stats handlers, a logging interceptor with trace ids, RED metrics per method, and alerts split by code class. That immediately tells me what is actually failing rather than what people believe is failing. Week two: a bufconn test fixture using the real interceptor chain, plus tests for every status code the service can return, because that is where the regressions will come from and it is a prerequisite for changing anything safely. Week three: deployment correctness — health probes with asymmetric thresholds, graceful shutdown with a `preStop` hook, then multiple replicas behind a headless service with `round_robin` and `MaxConnectionAge`, verified by a scale-up under load rather than by configuration review. Week four: schema governance — `buf lint` and `buf breaking` in CI, and a review of the `.proto` for the irreversible mistakes, since if idempotency keys or pagination shape are wrong I want to know now while the consumer count is small. What I would explicitly *not* do first is performance tuning, because without observability I would be guessing, and in my experience the bottleneck turns out to be load balancing rather than anything I would have optimised.

**Q: (Senior) How do you keep a gRPC estate healthy as it grows past twenty services?**
A: Four things, all enforced rather than documented, because documentation does not survive contact with twenty teams. Schema governance: one repository or monorepo, `buf lint` at `STANDARD` and `buf breaking` at `FILE` against the last release in CI, with deliberate breaks requiring a scoped exception naming an owner and an expiry — that makes the cost of a breaking change land on the author at PR time rather than on a downstream team at 3 a.m. A shared platform library so every service gets the same interceptor chain, error mapping, observability and health wiring by default, because the alternative is twenty subtly different implementations of auth. A published deprecation policy backed by per-caller usage metrics, so "who still uses this field" is a dashboard query rather than a broadcast email nobody reads. And a common observability vocabulary — the same labels, the same code classes, the same alert semantics — so a cross-service incident does not require learning four dashboards. The organising principle is that at this size the problems stop being technical: the technical work on any one service is days, and the estate-wide change is quarters, so anything that relies on every team remembering will fail.

## 10. Quick Revision & Cheat Sheet

**The 10-step procedure**
1. Consumers, traffic, SLO → 2. Domain sentences → verbs → methods → 3. RPC shape per method (justify streams) → 4. Resource design → 5. **The irreversible set** → 6. Failure vocabulary → 7. Deadlines and retries → 8. Interceptors, auth, telemetry → 9. Deployment and load balancing → 10. The 10× question.

**The irreversible set**

| Decision | Why permanent |
|---|---|
| Field numbers | Reuse = silent corruption |
| `package x.y.v1` | No version segment = no migration path |
| Method granularity | Splitting/merging is breaking |
| Idempotency keys | Adding a required one breaks callers |
| Pagination shape | Offset → cursor is breaking |
| Stream resume tokens | Old clients still restart from zero |
| Request/response uniqueness | Shared = unevolvable |
| Enum zero value | Real state at 0 = absence undetectable |
| Money and id types | `double` for money is a correctness bug |

**RPC shape selection**

| Data | Shape |
|---|---|
| Bounded in, bounded out | Unary (the default) |
| Unbounded **in time** | Server streaming |
| Unbounded input, one summary | Client streaming |
| Independent two-way | Bidi (most expensive) |
| Large but bounded | Unary + **cursor pagination** |

**Flash cards**
- **First question in a round?** → Who are the consumers, and what is the traffic?
- **Strongest cheap signal?** → Naming the irreversible decisions.
- **Justify a stream how?** → Say why unary plus pagination was rejected.
- **"What if the client retries?"** → Idempotency key, or the answer is "it happens twice".
- **First bottleneck at 10×?** → Load balancing, then the datastore.
- **Second-strongest signal?** → Stating a trade-off before being asked.
- **Best answer when you don't know?** → "I don't know — here is how I would find out."

## 11. Hands-On Exercises & Mini Project

- [ ] Run the 10-step procedure against a system you already work on, timed to 45 minutes. Note where you ran out of time.
- [ ] Take three real `.proto` files and list, for each, the decisions that could not now be changed without a breaking change.
- [ ] For every streaming method you have ever written, write one sentence justifying why unary plus pagination was rejected. Note how many fail.
- [ ] Write the failure vocabulary — condition, code, reason, retryable — for one service, then compare against what it actually returns.
- [ ] Do the budget arithmetic for one real request path: total, own work, per-downstream allocation. Compare against the configured deadlines.
- [ ] Answer "what breaks first at 10×?" for a service you own, then verify by load-testing it.
- [ ] Practise the payments design out loud in 20 minutes, recording yourself. Count how many trade-offs you stated unprompted.
- [ ] Take a REST API you own and produce the migration assessment from §5's third design.

### Mini Project — "Design Round Portfolio"

**Goal.** Build three complete, defensible designs you can deliver under time pressure, so the round tests your judgement rather than your recall.

**Requirements.**
1. Three designs at increasing difficulty — a CRUD-plus-watch service, a high-volume ingestion service, and a migration from an existing estate.
2. For each: a clarifying-questions list, domain sentences with verbs underlined, and a method table with shape, deadline, idempotency and error codes.
3. A complete `.proto` for each passing `buf lint` at `STANDARD`, with the irreversible decisions annotated in comments.
4. A failure vocabulary per method: condition, status code, stable `ErrorInfo.reason`, retryability.
5. Deadline budget arithmetic across the full call chain for the most complex path.
6. An operations section per design: interceptor chain, auth model, observability signals, load-balancing model, and the answer to "what breaks first at 10×" with its detection signal.
7. A trade-offs page per design listing, unprompted, what each choice gave up.
8. A recorded 45-minute delivery of each, reviewed for time allocation and for how many trade-offs you named without being asked.

**Extensions.**
- Have someone play interviewer and push on the three questions from §3 until you can answer each in under a minute.
- Implement one design far enough to run under `ghz`, and check whether your 10× prediction was right.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Build: The Complete Service .proto* (the schema design being tested), *The Four RPC Patterns* (shape selection), *Schema Evolution* (why decisions are irreversible), *Deadlines, Retries, Service Config & Load Balancing* (budget arithmetic), *Build: Deployment* (the operations half of a senior round).

- **Google API Design Guide** — Google · *Intermediate* · resource-oriented design, standard methods, errors and long-running operations; the most commonly referenced design vocabulary in interviews. <https://cloud.google.com/apis/design>
- **Google API Improvement Proposals (AIPs)** — Google · *Intermediate* · numbered, specific rules for pagination (158), update (134), idempotency (155), errors (193) and versioning (185). Each is a short, citable answer. <https://google.aip.dev/>
- **gRPC — Core concepts, architecture and lifecycle** — grpc.io · *Beginner* · the authoritative semantics of the four RPC kinds, deadlines and cancellation. <https://grpc.io/docs/what-is-grpc/core-concepts/>
- **Designing Data-Intensive Applications** — Martin Kleppmann · *Advanced* · encoding and evolution, RPC versus message passing, and the reasoning style design rounds reward. Chapter previews free. <https://dataintensive.net/>
- **Google SRE Book — Addressing Cascading Failures & Handling Overload** — Google · *Advanced* · retry amplification, deadline propagation and load shedding; the source of the best answers to "what breaks at scale". <https://sre.google/sre-book/addressing-cascading-failures/>
- **Buf Style Guide and breaking-change rules** — Buf (open source) · *Intermediate* · the concrete list of what is and is not a breaking change, which is the irreversible set in mechanised form. <https://buf.build/docs/breaking/rules>
- **The Tail at Scale** — Dean & Barroso, CACM · *Advanced* · why p99 dominates in fan-out systems; the reference behind hedging and tail-latency answers. <https://research.google/pubs/pub40801/>
- **grpc-go examples** — gRPC Authors · *Beginner* · runnable implementations of every pattern discussed here, useful for turning a design into working code quickly. <https://github.com/grpc/grpc-go/tree/master/examples>

---

*gRPC with Go Handbook — chapter 30.*
