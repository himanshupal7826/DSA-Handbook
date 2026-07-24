# 21 · Deadlines, Retries, Service Config & Load Balancing

> **In one line:** gRPC has deadlines, not timeouts — an absolute instant that travels on the wire and is shared by every downstream hop — and the service config is where retry, hedging and load-balancing policy live as data rather than as code scattered across call sites.

---

## 1. Overview

Three mechanisms determine how a gRPC client behaves when things go wrong, and all three are configured in one place.

**Deadlines** are absolute points in time, not durations. `context.WithTimeout(ctx, 2*time.Second)` computes an instant, encodes the *remaining* time as the `grpc-timeout` header, and the server derives its own context deadline from it. When that server calls a further service, it propagates the same instant. So a call chain shares one budget rather than accumulating independent timeouts — which is the difference between "the whole request fails in 1 second" and "the whole request fails in 1 + 2 + 3 = 6 seconds because each hop had its own timer".

**Retries** in gRPC are declarative. A JSON **service config** describes, per method, how many attempts, what backoff, and which status codes are retryable — and the runtime enforces the crucial safety property that a retry only happens when *no response has been received*, so a streaming call that already delivered data is never retried. There is also **hedging**: sending the same request to several backends and taking the first answer, which trades load for tail latency.

**Load balancing** is also service config: `pick_first` (the default, one backend) versus `round_robin` (spread across all resolved addresses), plus the connection rotation that makes rebalancing actually happen.

The unifying idea is that these belong together as **policy, expressed as data**. Scattering `if err == Unavailable { retry }` across call sites produces inconsistent behaviour, retry storms, and no way to change it without a deploy. A service config is one JSON document, reviewable, per-method, and changeable centrally.

## 2. Core Concepts

- **Deadline** — an absolute instant. Propagated as `grpc-timeout` (e.g. `1997m` = 1997 ms).
- **Timeout** — a duration. Only used to *compute* a deadline; gRPC itself never sees one.
- **Deadline propagation** — passing the incoming server context to downstream calls so all hops share one budget.
- **Service config** — a JSON document configuring per-method timeouts, retry, hedging and the load-balancing policy.
- **`WithDefaultServiceConfig`** — supplies it from the client; DNS `TXT` records can supply it from the server side.
- **`methodConfig`** — an array of `{name: [{service, method}], …}` entries; the most specific match wins.
- **`retryPolicy`** — `maxAttempts`, `initialBackoff`, `maxBackoff`, `backoffMultiplier`, `retryableStatusCodes`.
- **`hedgingPolicy`** — `maxAttempts`, `hedgingDelay`, `nonFatalStatusCodes`. Mutually exclusive with `retryPolicy`.
- **Retry throttling** — a token bucket that disables retries when the failure ratio is high, preventing retry storms.
- **`loadBalancingConfig`** — `pick_first` (default) or `round_robin`; xDS for anything richer.
- **`waitForReady`** — per-method: queue through `TRANSIENT_FAILURE` rather than failing fast.
- **Idempotency** — the precondition for safe retries of mutations (chapter 11).

## 3. Theory & Principles

### Why deadlines and not timeouts

Consider a request that fans out: gateway → orders → inventory → pricing.

**With timeouts** (each hop starts its own): the gateway waits 5s, orders waits 5s, inventory waits 5s. Worst case the user waits 5s while three services burn resources on a request the gateway abandoned long ago. Every hop's work after the client gives up is pure waste, and under load that waste is what turns a slow dependency into an outage.

**With deadlines** (one instant, propagated): the gateway sets `now + 1s`. Orders receives `grpc-timeout: 950m`, sets its own context accordingly, and passes it down. When the instant passes, *every* hop's context fires simultaneously — the database query is cancelled, the downstream RPC is cancelled, and no one is working on a dead request.

This is why the discipline from chapter 15 matters: **pass the incoming `ctx` to every downstream call.** That single habit is what makes deadline propagation work; there is nothing else to configure.

**Budgeting.** With one second and three sequential calls, you cannot give each one second. A workable rule: reserve 20–30% for your own work and network overhead, divide the rest, and give parallel calls the full remaining budget since they overlap. When the arithmetic is wrong, `DeadlineExceeded` tells you — which is why it deserves its own alert, separate from `Unavailable`.

### How gRPC retries actually work

The rules matter because they define what is safe:

1. **Retries only happen before a response.** Once the client has received any message from the server, the RPC is committed and will not be retried. This is what makes retrying streams safe: a server-streaming call that delivered ten messages and then failed is never retried behind your back.
2. **The retry policy is per method**, matched from `methodConfig`. A read can retry aggressively; a mutation should not retry at all unless it carries an idempotency key.
3. **Backoff is exponential with jitter**, computed from `initialBackoff × backoffMultiplier^(n-1)`, capped at `maxBackoff`, randomised.
4. **Retry throttling is global per channel.** A token bucket is debited on failure and credited on success; when it empties, retries stop. This is the mechanism that prevents a struggling backend from being hammered into the ground by its own clients — and it is why `retryThrottling` should always be configured alongside `retryPolicy`.
5. **`RetryInfo` in the error details** lets the server dictate a delay (chapter 22). Honour it.

**What to make retryable.** `UNAVAILABLE` almost always — it means the transport failed and the request likely never executed. `RESOURCE_EXHAUSTED` sometimes, with a longer backoff, since it means "slow down". `DEADLINE_EXCEEDED` **never** in the policy: the budget is gone, so a retry has nothing left to spend. `INTERNAL`, `UNKNOWN`, `ABORTED` are judgement calls — `ABORTED` specifically means "retry the whole read-modify-write", which is application logic rather than transport retry.

### Hedging: buying tail latency with load

Hedging sends the request to a *second* backend after `hedgingDelay` without waiting for the first to fail, and takes whichever responds first. It attacks the case where one slow backend — a GC pause, a noisy neighbour, a degraded disk — dominates your p99.

The cost is real: setting `hedgingDelay` at the p95 means roughly 5% extra load. It is only safe for **idempotent** methods, because both requests may execute. And `retryPolicy` and `hedgingPolicy` are mutually exclusive per method — you choose one.

Rule of thumb: hedge reads where tail latency matters and the method is genuinely idempotent; retry everything else.

```svg
<svg viewBox="0 0 880 500" width="100%" height="500" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="dl1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
    <marker id="dl2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Timeouts accumulate. Deadlines propagate.</text>

  <rect x="24" y="42" width="832" height="176" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="440" y="64" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Independent timeouts: 5s each &#8594; up to 15s of wasted work</text>

  <rect x="48" y="80" width="150" height="40" rx="6" fill="#fff" stroke="#fca5a5"/>
  <text x="123" y="96" text-anchor="middle" fill="#7f1d1d" font-size="10" font-weight="bold">gateway</text>
  <text x="123" y="112" text-anchor="middle" fill="#991b1b" font-size="9">timeout 5s</text>
  <path d="M200,100 L246,100" stroke="#dc2626" stroke-width="2" marker-end="url(#dl1)"/>
  <rect x="250" y="80" width="150" height="40" rx="6" fill="#fff" stroke="#fca5a5"/>
  <text x="325" y="96" text-anchor="middle" fill="#7f1d1d" font-size="10" font-weight="bold">orders</text>
  <text x="325" y="112" text-anchor="middle" fill="#991b1b" font-size="9">its OWN timeout 5s</text>
  <path d="M402,100 L448,100" stroke="#dc2626" stroke-width="2" marker-end="url(#dl1)"/>
  <rect x="452" y="80" width="150" height="40" rx="6" fill="#fff" stroke="#fca5a5"/>
  <text x="527" y="96" text-anchor="middle" fill="#7f1d1d" font-size="10" font-weight="bold">inventory</text>
  <text x="527" y="112" text-anchor="middle" fill="#991b1b" font-size="9">its OWN timeout 5s</text>
  <path d="M604,100 L650,100" stroke="#dc2626" stroke-width="2" marker-end="url(#dl1)"/>
  <rect x="654" y="80" width="150" height="40" rx="6" fill="#fff" stroke="#fca5a5"/>
  <text x="729" y="96" text-anchor="middle" fill="#7f1d1d" font-size="10" font-weight="bold">pricing</text>
  <text x="729" y="112" text-anchor="middle" fill="#991b1b" font-size="9">its OWN timeout 5s</text>

  <text x="48" y="148" fill="#991b1b">The gateway gives up at 5s. orders, inventory and pricing keep working &#8212; on a request nobody is waiting for.</text>
  <text x="48" y="168" fill="#991b1b">Every hop's work after the client abandons is pure waste, and under load that waste is what turns a slow</text>
  <text x="48" y="186" fill="#991b1b">dependency into an outage: goroutines, connections and database capacity all held for nothing.</text>
  <text x="48" y="208" fill="#7f1d1d" font-weight="bold">Independent timers cannot express "the whole request is dead".</text>

  <rect x="24" y="236" width="832" height="176" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="440" y="258" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">One deadline, propagated: every hop fires at the same instant</text>

  <rect x="48" y="274" width="150" height="40" rx="6" fill="#fff" stroke="#86efac"/>
  <text x="123" y="290" text-anchor="middle" fill="#14532d" font-size="10" font-weight="bold">gateway</text>
  <text x="123" y="306" text-anchor="middle" fill="#166534" font-size="9">deadline = now + 1s</text>
  <path d="M200,294 L246,294" stroke="#16a34a" stroke-width="2" marker-end="url(#dl2)"/>
  <text x="223" y="286" text-anchor="middle" fill="#15803d" font-size="8">950m</text>
  <rect x="250" y="274" width="150" height="40" rx="6" fill="#fff" stroke="#86efac"/>
  <text x="325" y="290" text-anchor="middle" fill="#14532d" font-size="10" font-weight="bold">orders</text>
  <text x="325" y="306" text-anchor="middle" fill="#166534" font-size="9">same instant</text>
  <path d="M402,294 L448,294" stroke="#16a34a" stroke-width="2" marker-end="url(#dl2)"/>
  <text x="425" y="286" text-anchor="middle" fill="#15803d" font-size="8">870m</text>
  <rect x="452" y="274" width="150" height="40" rx="6" fill="#fff" stroke="#86efac"/>
  <text x="527" y="290" text-anchor="middle" fill="#14532d" font-size="10" font-weight="bold">inventory</text>
  <text x="527" y="306" text-anchor="middle" fill="#166534" font-size="9">same instant</text>
  <path d="M604,294 L650,294" stroke="#16a34a" stroke-width="2" marker-end="url(#dl2)"/>
  <text x="627" y="286" text-anchor="middle" fill="#15803d" font-size="8">790m</text>
  <rect x="654" y="274" width="150" height="40" rx="6" fill="#fff" stroke="#86efac"/>
  <text x="729" y="290" text-anchor="middle" fill="#14532d" font-size="10" font-weight="bold">pricing</text>
  <text x="729" y="306" text-anchor="middle" fill="#166534" font-size="9">same instant</text>

  <text x="48" y="342" fill="#166534">grpc-timeout carries the REMAINING budget on every hop. When the instant passes, every ctx.Done() fires</text>
  <text x="48" y="360" fill="#166534">at once: the database query, the downstream RPC, the whole chain. Nobody works on a dead request.</text>
  <text x="48" y="382" fill="#15803d" font-weight="bold">The only thing you configure: pass the INCOMING ctx to every downstream call. That is the whole mechanism.</text>
  <text x="48" y="402" fill="#166534">Budget rule: reserve 20&#8211;30% for your own work, divide the rest among SEQUENTIAL calls; parallel calls share it all.</text>

  <rect x="24" y="428" width="832" height="64" rx="10" fill="#fefce8" stroke="#ca8a04" stroke-width="2"/>
  <text x="440" y="450" text-anchor="middle" fill="#854d0e" font-size="12" font-weight="bold">Never make DEADLINE_EXCEEDED retryable</text>
  <text x="48" y="472" fill="#713f12">The budget is already gone &#8212; a retry has nothing left to spend, and every attempt fails identically while</text>
  <text x="48" y="488" fill="#713f12">consuming a slot in the retry throttle that a genuinely retryable UNAVAILABLE could have used.</text>
</svg>
```

### Load balancing: `pick_first` vs `round_robin`

The default `pick_first` connects to the first address that succeeds and sends everything there — correct for a single-backend target, wrong for a replicated service. `round_robin` spreads RPCs across all `READY` subchannels, and needs three things to work:

1. **A service config selecting it** — it is never the default.
2. **A resolver returning multiple addresses** — in Kubernetes that means a **headless** service (`clusterIP: None`), because a normal `ClusterIP` resolves to one virtual IP.
3. **Connection rotation** — server-side `MaxConnectionAge` (chapter 18), or clients never re-resolve and new pods stay cold.

For anything richer — locality awareness, weighted backends, outlier ejection — the answer is xDS or a service mesh rather than tuning DNS.

## 4. Architecture & Workflow

The service config is a JSON document. Its shape:

```json
{
  "loadBalancingConfig": [{ "round_robin": {} }],
  "methodConfig": [ { "name": [...], "timeout": "...", "retryPolicy": {...} } ],
  "retryThrottling": { "maxTokens": 100, "tokenRatio": 0.1 }
}
```

`methodConfig` entries are matched most-specific-first: an entry naming `{service, method}` beats one naming `{service}`, which beats `{}` (the global default). So the idiom is a permissive default plus specific overrides for the methods that need different behaviour — aggressive retry on reads, none on non-idempotent writes, a longer timeout on exports.

```svg
<svg viewBox="0 0 880 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="hd1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Retry vs hedging: sequential recovery vs parallel racing</text>

  <rect x="24" y="42" width="410" height="184" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="229" y="64" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">retryPolicy &#8212; sequential, after failure</text>
  <line x1="48" y1="90" x2="410" y2="90" stroke="#94a3b8"/>
  <rect x="48" y="96" width="90" height="22" rx="4" fill="#fee2e2" stroke="#dc2626"/>
  <text x="93" y="111" text-anchor="middle" fill="#b91c1c" font-size="9">attempt 1 &#10007;</text>
  <rect x="146" y="96" width="40" height="22" rx="4" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="166" y="111" text-anchor="middle" fill="#475569" font-size="8">100ms</text>
  <rect x="194" y="96" width="90" height="22" rx="4" fill="#fee2e2" stroke="#dc2626"/>
  <text x="239" y="111" text-anchor="middle" fill="#b91c1c" font-size="9">attempt 2 &#10007;</text>
  <rect x="292" y="96" width="52" height="22" rx="4" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="318" y="111" text-anchor="middle" fill="#475569" font-size="8">200ms</text>
  <rect x="352" y="96" width="60" height="22" rx="4" fill="#dcfce7" stroke="#16a34a"/>
  <text x="382" y="111" text-anchor="middle" fill="#15803d" font-size="9">3 &#10003;</text>

  <text x="44" y="146" fill="#1d4ed8" font-size="10">Only ONE request in flight at a time. No extra load.</text>
  <text x="44" y="164" fill="#1d4ed8" font-size="10">Recovers from a FAILED backend, not a SLOW one.</text>
  <text x="44" y="186" fill="#1e40af" font-size="10" font-weight="bold">Safety: only retries when NO response has been received,</text>
  <text x="44" y="202" fill="#1e40af" font-size="10" font-weight="bold">so a stream that delivered data is never retried.</text>
  <text x="44" y="220" fill="#b91c1c" font-size="10">Non-idempotent writes: maxAttempts must be 1.</text>

  <rect x="446" y="42" width="410" height="184" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="651" y="64" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">hedgingPolicy &#8212; parallel, after a delay</text>
  <line x1="470" y1="90" x2="832" y2="90" stroke="#94a3b8"/>
  <rect x="470" y="96" width="240" height="22" rx="4" fill="#fef3c7" stroke="#d97706"/>
  <text x="590" y="111" text-anchor="middle" fill="#92400e" font-size="9">attempt 1 &#8212; slow backend (GC pause)</text>
  <rect x="560" y="124" width="120" height="22" rx="4" fill="#dcfce7" stroke="#16a34a"/>
  <text x="620" y="139" text-anchor="middle" fill="#15803d" font-size="9">attempt 2 &#10003; wins</text>
  <path d="M560,120 L560,124" stroke="#7c3aed" stroke-width="2" marker-end="url(#hd1)"/>
  <text x="512" y="136" fill="#5b21b6" font-size="8">hedgingDelay</text>

  <text x="466" y="164" fill="#6d28d9" font-size="10">Both in flight. Whichever answers first wins.</text>
  <text x="466" y="182" fill="#6d28d9" font-size="10">Attacks TAIL latency: one slow backend no longer</text>
  <text x="466" y="198" fill="#6d28d9" font-size="10">dominates p99.</text>
  <text x="466" y="218" fill="#b91c1c" font-size="10" font-weight="bold">Costs load (delay at p95 &#8776; +5%). IDEMPOTENT only.</text>

  <rect x="24" y="244" width="832" height="176" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="266" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">What to make retryable &#8212; and what never to</text>
  <g font-size="10">
    <text x="48" y="292" fill="#15803d" font-weight="bold">UNAVAILABLE</text>
    <text x="240" y="292" fill="#166534">almost always &#8212; the transport failed; the request likely never executed</text>
    <text x="48" y="314" fill="#92400e" font-weight="bold">RESOURCE_EXHAUSTED</text>
    <text x="240" y="314" fill="#b45309">sometimes, with a LONGER backoff &#8212; it means "slow down"</text>
    <text x="48" y="336" fill="#b91c1c" font-weight="bold">DEADLINE_EXCEEDED</text>
    <text x="240" y="336" fill="#991b1b">NEVER &#8212; the budget is gone; a retry has nothing left to spend</text>
    <text x="48" y="358" fill="#334155" font-weight="bold">INTERNAL / UNKNOWN</text>
    <text x="240" y="358" fill="#475569">judgement call &#8212; may indicate the request DID execute</text>
    <text x="48" y="380" fill="#334155" font-weight="bold">ABORTED</text>
    <text x="240" y="380" fill="#475569">application-level: retry the whole read-modify-write, not the transport</text>
  </g>
  <text x="48" y="408" fill="#7f1d1d" font-weight="bold">Always pair retryPolicy with retryThrottling &#8212; the token bucket is what stops clients hammering a struggling backend.</text>
</svg>
```

## 5. Implementation

### A complete service config

```go
package client

// serviceConfig is policy expressed as DATA. Keeping it in one document means
// retry behaviour is reviewable, consistent, and changeable without touching
// call sites.
//
// methodConfig entries are matched MOST SPECIFIC FIRST:
//   {service, method}  beats  {service}  beats  {}  (the global default)
const serviceConfig = `{
  "loadBalancingConfig": [{"round_robin": {}}],

  "methodConfig": [
    {
      "name": [{}],
      "timeout": "5s",
      "waitForReady": false,
      "retryPolicy": {
        "maxAttempts": 3,
        "initialBackoff": "0.1s",
        "maxBackoff": "1s",
        "backoffMultiplier": 2,
        "retryableStatusCodes": ["UNAVAILABLE"]
      }
    },

    {
      "name": [
        {"service": "acme.inventory.v1.InventoryService", "method": "GetItem"},
        {"service": "acme.inventory.v1.InventoryService", "method": "ListItems"}
      ],
      "timeout": "2s",
      "retryPolicy": {
        "maxAttempts": 5,
        "initialBackoff": "0.05s",
        "maxBackoff": "1s",
        "backoffMultiplier": 2,
        "retryableStatusCodes": ["UNAVAILABLE", "RESOURCE_EXHAUSTED"]
      }
    },

    {
      "name": [{"service": "acme.inventory.v1.InventoryService", "method": "ReserveStock"}],
      "timeout": "3s",
      "retryPolicy": {
        "maxAttempts": 3,
        "initialBackoff": "0.2s",
        "maxBackoff": "2s",
        "backoffMultiplier": 2,
        "retryableStatusCodes": ["UNAVAILABLE"]
      }
    },

    {
      "name": [{"service": "acme.inventory.v1.InventoryService", "method": "BulkAdjustStock"}],
      "timeout": "300s",
      "retryPolicy": {"maxAttempts": 1}
    },

    {
      "name": [{"service": "acme.inventory.v1.InventoryService", "method": "WatchStock"}],
      "timeout": "1800s",
      "waitForReady": true,
      "retryPolicy": {
        "maxAttempts": 3,
        "initialBackoff": "0.5s",
        "maxBackoff": "5s",
        "backoffMultiplier": 2,
        "retryableStatusCodes": ["UNAVAILABLE"]
      }
    }
  ],

  "retryThrottling": {
    "maxTokens": 100,
    "tokenRatio": 0.1
  }
}`
```

Reading the intent behind each entry:

- **Global default** — a modest 3 attempts on `UNAVAILABLE` with a 5-second budget. Everything inherits sane behaviour, even a method added tomorrow.
- **`GetItem` / `ListItems`** — pure reads, safe to retry aggressively. A tight 2-second budget because a stale read is worse than a fast failure.
- **`ReserveStock`** — a mutation, retried *only* because it carries an idempotency key (chapter 11). Without that key this must be `maxAttempts: 1`.
- **`BulkAdjustStock`** — client streaming with side effects; retry is disabled and a 5-minute budget reflects a slow upload.
- **`WatchStock`** — a long stream with `waitForReady`, because a background watcher should queue through a blip rather than error. Retries apply only to *establishing* the stream: once a message arrives, the RPC is committed.
- **`retryThrottling`** — 100 tokens, each failure costing 1 and each success crediting 0.1. Under a sustained outage the bucket empties and retries stop, which is what prevents clients from finishing off a struggling backend.

### Hedging for a latency-sensitive read

```go
// Hedging trades load for tail latency, and is mutually exclusive with
// retryPolicy on the same method.
const hedgedServiceConfig = `{
  "methodConfig": [{
    "name": [{"service": "acme.pricing.v1.PricingService", "method": "GetPrice"}],
    "timeout": "1s",
    "hedgingPolicy": {
      "maxAttempts": 3,
      "hedgingDelay": "0.05s",
      "nonFatalStatusCodes": ["UNAVAILABLE", "RESOURCE_EXHAUSTED"]
    }
  }]
}`
```

Set `hedgingDelay` near your p95: below it you send a second request on almost every call and pay double the load; far above it you rarely help. At the p95 the extra load is roughly 5% and the p99 improvement is often substantial. Only for genuinely idempotent methods — both requests may execute.

### Wiring it up

```go
import (
	"google.golang.org/grpc"
	"google.golang.org/grpc/backoff"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/keepalive"
)

func newClient(target string, creds credentials.TransportCredentials) (*grpc.ClientConn, error) {
	return grpc.NewClient(target,
		grpc.WithTransportCredentials(creds),

		// The default is used unless the resolver supplies one (DNS TXT
		// records can). WithDisableServiceConfig() would ignore resolver-
		// provided config entirely, which is worth doing when you want the
		// client to be the single source of truth.
		grpc.WithDefaultServiceConfig(serviceConfig),

		// Connection-level backoff, distinct from RPC retry backoff. Defaults
		// follow gRFC A6 (1s base, 1.6x, 120s max, 20% jitter); tighten
		// MaxDelay when clients must recover quickly from a rolling restart.
		grpc.WithConnectParams(grpc.ConnectParams{
			Backoff: backoff.Config{
				BaseDelay:  200 * time.Millisecond,
				Multiplier: 1.6,
				Jitter:     0.2,
				MaxDelay:   15 * time.Second,
			},
			MinConnectTimeout: 5 * time.Second,
		}),

		grpc.WithKeepaliveParams(keepalive.ClientParameters{
			Time: 30 * time.Second, Timeout: 10 * time.Second,
			PermitWithoutStream: true,
		}),
	)
}
```

### Budgeting a deadline across a fan-out

```go
// PlaceOrder shows explicit budget arithmetic. The incoming context carries
// the caller's remaining time; everything below is carved out of it.
func (s *Service) PlaceOrder(
	ctx context.Context,
	req *ordersv1.PlaceOrderRequest,
) (*ordersv1.PlaceOrderResponse, error) {
	// Reserve headroom for our own work: response construction, serialisation,
	// and the audit write. Spending the entire budget downstream guarantees
	// that a slow-but-successful downstream still fails the whole request.
	budget := remainingBudget(ctx)
	if budget < 200*time.Millisecond {
		// Fail fast rather than starting work we certainly cannot finish.
		return nil, status.Error(codes.DeadlineExceeded,
			"insufficient time budget to place an order")
	}

	// --- PARALLEL calls share the full remaining budget, since they overlap.
	parallelBudget := time.Duration(float64(budget) * 0.4)
	g, gctx := errgroup.WithContext(ctx)
	gctx, cancelParallel := context.WithTimeout(gctx, parallelBudget)
	defer cancelParallel()

	var price *pricingv1.Quote
	var stock *inventoryv1.GetItemResponse

	g.Go(func() error {
		var err error
		price, err = s.pricing.GetPrice(gctx, &pricingv1.GetPriceRequest{Sku: req.GetSku()})
		return err
	})
	g.Go(func() error {
		var err error
		stock, err = s.inventory.GetItem(gctx, &inventoryv1.GetItemRequest{Sku: req.GetSku()})
		return err
	})
	if err := g.Wait(); err != nil {
		return nil, err
	}

	// --- SEQUENTIAL calls must divide what remains.
	remaining := remainingBudget(ctx)
	reserveCtx, cancelReserve := context.WithTimeout(ctx, time.Duration(float64(remaining)*0.5))
	defer cancelReserve()

	res, err := s.inventory.ReserveStock(reserveCtx, &inventoryv1.ReserveStockRequest{
		// The idempotency key is what makes the retryPolicy on this method safe.
		IdempotencyKey: req.GetIdempotencyKey(),
		OrderId:        req.GetOrderId(),
		Lines:          toLines(req),
	})
	if err != nil {
		return nil, err
	}

	return buildResponse(price, stock, res), nil
}

func remainingBudget(ctx context.Context) time.Duration {
	dl, ok := ctx.Deadline()
	if !ok {
		// No deadline at all: treat it as a bug in the caller and apply a
		// conservative default rather than working unbounded.
		return 5 * time.Second
	}
	return time.Until(dl)
}
```

### Enforcing that callers set a deadline

```go
// DeadlineEnforcementInterceptor rejects RPCs arriving with no deadline, and
// optionally clamps excessive ones.
//
// This is the server-side counterpart to client discipline: it makes an
// unbounded call a loud failure at the boundary instead of a resource leak
// discovered under load.
func DeadlineEnforcementInterceptor(maxDeadline time.Duration) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler) (any, error) {

		dl, ok := ctx.Deadline()
		if !ok {
			return nil, status.Errorf(codes.InvalidArgument,
				"%s requires a deadline; set one with context.WithTimeout", info.FullMethod)
		}

		// Clamp: a client asking for an hour on a 2-second method is either
		// confused or abusive, and either way it holds our resources.
		if until := time.Until(dl); until > maxDeadline {
			var cancel context.CancelFunc
			ctx, cancel = context.WithTimeout(ctx, maxDeadline)
			defer cancel()
		}

		return handler(ctx, req)
	}
}
```

### Observing retries

```go
// Retries are invisible from the call site by design, which makes them easy to
// misconfigure and hard to diagnose. This interceptor counts ATTEMPTS, so the
// ratio of attempts to calls exposes a retry storm.
func RetryObservabilityInterceptor(m *Metrics) grpc.UnaryClientInterceptor {
	return func(ctx context.Context, method string, req, reply any,
		cc *grpc.ClientConn, invoker grpc.UnaryInvoker, opts ...grpc.CallOption) error {

		// A client interceptor runs ONCE PER ATTEMPT, so this counter measures
		// attempts, not logical calls.
		m.RPCAttempts.WithLabelValues(method).Inc()

		start := time.Now()
		err := invoker(ctx, method, req, reply, cc, opts...)

		m.RPCAttemptDuration.WithLabelValues(method, status.Code(err).String()).
			Observe(time.Since(start).Seconds())
		return err
	}
}
```

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Deadline propagation is automatic** if you pass `ctx` down — no coordination needed, no wasted work after the client gives up.
- **Retry as configuration** means uniform behaviour, reviewable in one document, changeable without touching call sites.
- **The "no response yet" rule** makes retry safe by construction for streams and for anything that already produced output.
- **Retry throttling** prevents the classic failure amplification where clients finish off a struggling backend.
- **Hedging** genuinely attacks tail latency, which retry cannot.

**Disadvantages**
- **Retries are invisible** at the call site, so a misconfiguration shows up as mysterious load rather than as an obvious bug.
- **Idempotency is your responsibility.** gRPC will happily retry a duplicate charge if you tell it to.
- **JSON service config has no schema validation in Go** — a typo in a field name is silently ignored.
- **`round_robin` needs a headless service** and connection rotation; DNS-based balancing is coarse.
- **Hedging doubles load** if `hedgingDelay` is set too low.

**Trade-offs**
- *Aggressive vs conservative retry:* more attempts improve success rates and amplify load during an incident. Throttling is the safety valve, not a substitute for judgement.
- *Retry vs hedging:* retry recovers from a *failed* backend at no extra load; hedging recovers from a *slow* one at the cost of extra load. Pick per method.
- *Tight vs generous deadlines:* tight deadlines shed load and protect the fleet but fail slow-but-successful requests; generous ones hold resources. Set them from measured p99, not from intuition.

## 7. Common Mistakes & Best Practices

- **`context.Background()` on an RPC.** No deadline, no propagation, unbounded wait.
- **Creating a fresh timeout instead of deriving from the caller's context.** Discards the caller's budget.
- **Giving each hop the full budget.** Three sequential 1-second calls inside a 1-second budget cannot all succeed.
- **Retrying non-idempotent methods.** Set `maxAttempts: 1` unless there is an idempotency key.
- **Making `DEADLINE_EXCEEDED` retryable.** The budget is already gone.
- **`retryPolicy` without `retryThrottling`.** A retry storm is how clients turn a partial outage into a total one.
- **Leaving the default `pick_first`** against a replicated service. All traffic on one pod.
- **`round_robin` against a `ClusterIP` service.** DNS returns one virtual IP; nothing to balance across.
- **`waitForReady: true` globally.** Unbounded queues of doomed requests on user-facing paths.
- **Typos in the service config JSON.** Silently ignored in Go — validate it in a test.
- **`hedgingDelay` at p50.** You have doubled your load for a marginal p99 gain.
- **Not measuring attempts.** Retries are invisible; without an attempts counter you cannot see a storm forming.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** `GRPC_GO_LOG_VERBOSITY_LEVEL=99` logs the parsed service config at channel creation — the fastest way to catch a JSON typo, since Go silently ignores unknown fields. Check the log for the config you *expected* rather than assuming.
- **Monitoring.** Three signals matter here: the ratio of RPC *attempts* to logical calls (a retry storm forming), `DEADLINE_EXCEEDED` rate per method (budgets wrong, or a dependency degraded), and per-backend request distribution (load balancing not working). Alert on `Unavailable` and `DeadlineExceeded` separately — they have different owners.
- **Security.** Retries amplify load, so an attacker who can induce failures can multiply their traffic by `maxAttempts`. Throttling bounds that. Deadlines are also a load-shedding control: a server-side enforcement interceptor rejecting deadline-less calls stops a misbehaving client holding resources indefinitely.
- **Scaling.** Deadline propagation is the single most valuable property under load, because it means capacity is never spent on abandoned work. Combine with `round_robin` over a headless service and server-side `MaxConnectionAge` so load actually rebalances as you scale. When DNS-level balancing stops being enough — locality, weighting, outlier ejection — move to xDS rather than accumulating client-side heuristics.

## 9. Interview Questions

**Q: What is the difference between a deadline and a timeout in gRPC?**
A: A timeout is a duration; a deadline is an absolute instant. gRPC only ever deals in deadlines: `context.WithTimeout` computes an instant, the remaining time is encoded as the `grpc-timeout` header, and the server derives its own context from it and propagates the same instant downstream. That means a whole call chain shares one budget, so when it expires every hop's context fires simultaneously. With independent timeouts, each hop starts its own timer and downstream services keep working on a request the caller abandoned long ago.

**Q: How does deadline propagation work, and what do you have to do to get it?**
A: The client's deadline becomes the `grpc-timeout` header; the server's context is created with that deadline; and when the handler makes a downstream call passing that same context, the remaining budget is encoded again. So the only thing you have to do is pass the incoming `ctx` to every downstream call — database queries, HTTP requests, other RPCs. There is nothing else to configure, and the common failure is a handler that creates a context from `Background` instead of deriving from the incoming one, which silently discards the caller's budget.

**Q: When does gRPC retry an RPC?**
A: Only when no response has yet been received. Once the client has received any message from the server, the RPC is committed and will not be retried — which is what makes the mechanism safe for streams: a server-streaming call that delivered ten messages and then failed is never retried behind your back. Beyond that, retries happen per the `retryPolicy` in the service config for the matched method: up to `maxAttempts`, with exponential backoff and jitter, and only for the listed `retryableStatusCodes`.

**Q: Which status codes should be retryable, and which never?**
A: `UNAVAILABLE` almost always, because it means the transport failed and the request most likely never executed. `RESOURCE_EXHAUSTED` sometimes, with a longer backoff, since it means "slow down". `DEADLINE_EXCEEDED` never: the budget is already gone, so every retry fails identically while consuming throttle tokens a genuinely retryable failure could have used. `INTERNAL` and `UNKNOWN` are judgement calls, because they may mean the request *did* execute. `ABORTED` is application-level — it means retry the whole read-modify-write, not the transport call.

**Q: What is retry throttling and why does it matter?**
A: A per-channel token bucket: failures debit a token, successes credit `tokenRatio`, and when the bucket empties retries are disabled until it refills. It matters because retries amplify load exactly when a backend is least able to take it — a service degrading to 50% errors sees its clients triple their traffic, which finishes it off. Throttling turns that positive feedback loop into a negative one. It should always be configured alongside `retryPolicy`; a retry policy without it is how a partial outage becomes a total one.

**Q: What is hedging, and when would you use it?**
A: Hedging sends the same request to a second backend after `hedgingDelay` without waiting for the first to fail, and takes whichever responds first. It attacks tail latency caused by one slow backend — a GC pause, a noisy neighbour, a degraded disk — which retry cannot help with, because retry only fires after a failure. The costs are extra load, roughly 5% if the delay is set at your p95, and a hard requirement that the method be idempotent, since both requests may execute. It is mutually exclusive with `retryPolicy` on the same method.

**Q: Why does a client send all traffic to one pod despite `round_robin`?**
A: Three things must all be true, and usually one is missing. The service config must actually select `round_robin`, since `pick_first` is the default. The resolver must return multiple addresses — in Kubernetes that means a headless service with `clusterIP: None`, because a normal `ClusterIP` resolves to a single virtual IP with nothing to balance across. And connections must rotate, via server-side `MaxConnectionAge`, or a client that connected before a scale-up never re-resolves and the new pods stay cold. Checking the resolved address list in channelz settles which one it is.

**Q: (Senior) Design the deadline and retry policy for a service with several downstream dependencies.**
A: I start from the user-facing SLO and work inward. The gateway sets the total budget — say one second for an interactive path. Each service reserves 20–30% for its own work and network overhead, then divides the rest: parallel calls share the full remaining budget since they overlap, sequential calls must split it. I write the arithmetic down per method rather than leaving it to intuition, and I add a server-side interceptor that rejects deadline-less calls and clamps absurd ones, so an unbounded call is a loud failure at the boundary rather than a resource leak found under load. For retry, the service config carries a permissive default of a few attempts on `UNAVAILABLE`, with per-method overrides: reads retry aggressively with tight budgets, non-idempotent mutations are `maxAttempts: 1`, mutations with idempotency keys may retry, and long streaming methods get generous timeouts with retry applying only to establishment. Throttling is always on. And I monitor the attempts-to-calls ratio, because retries are invisible at the call site and a storm forming is otherwise indistinguishable from a traffic increase.

**Q: (Senior) A downstream service degrades and your fleet falls over. Explain the mechanism and the fixes.**
A: This is retry amplification plus deadline exhaustion compounding. As the dependency starts failing, clients retry — with `maxAttempts: 3` the load on an already-struggling service triples, pushing it further into failure, which produces more retries. Meanwhile calls that would have failed fast now consume their full deadline, so every caller holds a goroutine, a connection and a database handle for the entire budget instead of milliseconds, and concurrency climbs until something exhausts. If deadlines are not propagated, upstream services keep working on requests their callers abandoned, wasting capacity on results nobody will read. The fixes are layered: `retryThrottling` so retries stop when the failure ratio is high; a circuit breaker so clients shed load rather than queueing; tight, propagated deadlines so abandoned work is cancelled everywhere at once; `maxAttempts: 1` on anything not genuinely safe to retry; and server-side load shedding that returns `ResourceExhausted` quickly rather than queueing. Afterwards I would check the attempts-to-calls ratio metric, because if it was not being measured, this will happen again without warning.

**Q: (Senior) How do you decide the retry policy for a specific method?**
A: Two questions in order. First, is it idempotent — if executed twice, is the outcome the same? A pure read always is. A mutation is only if it carries an idempotency key the server actually honours, which is a schema decision made much earlier. If the answer is no, `maxAttempts: 1` and the conversation ends; no amount of backoff makes a duplicate charge acceptable. Second, if it is idempotent, what failure am I trying to survive? For a *failed* backend, retry with exponential backoff and jitter on `UNAVAILABLE`, with attempts and backoff sized so the total retry window fits inside the method's deadline — three attempts with a 2-second budget and a 1-second max backoff is not a coherent policy. For a *slow* backend where tail latency is the problem, hedging with the delay at p95 is the right tool instead, accepting the extra load. Then I set the timeout from the measured p99 plus headroom, not from a round number, and I make sure `retryThrottling` is present so none of this can amplify an incident.

## 10. Quick Revision & Cheat Sheet

```json
{
  "loadBalancingConfig": [{"round_robin": {}}],
  "methodConfig": [
    { "name": [{}], "timeout": "5s",
      "retryPolicy": {"maxAttempts": 3, "initialBackoff": "0.1s",
                      "maxBackoff": "1s", "backoffMultiplier": 2,
                      "retryableStatusCodes": ["UNAVAILABLE"]} },
    { "name": [{"service": "pkg.Svc", "method": "Mutate"}],
      "retryPolicy": {"maxAttempts": 1} }
  ],
  "retryThrottling": {"maxTokens": 100, "tokenRatio": 0.1}
}
```

| Concern | Setting |
|---|---|
| Deadline | `context.WithTimeout(callerCtx, d)` — derive, never `Background()` |
| Per-method timeout | `methodConfig[].timeout` |
| Retry | `retryPolicy` — only before a response is received |
| Retry storms | `retryThrottling` — always pair it with `retryPolicy` |
| Tail latency | `hedgingPolicy` — idempotent only; delay ≈ p95 |
| Queue vs fail fast | `waitForReady` — per method, always with a deadline |
| Load spreading | `loadBalancingConfig: round_robin` + headless service + `MaxConnectionAge` |

**Flash cards**
- **Deadline or timeout?** → Deadline: an absolute instant, propagated as `grpc-timeout`.
- **How do you get propagation?** → Pass the incoming `ctx` to every downstream call. That is all.
- **When does gRPC retry?** → Only before any response is received.
- **Never retryable?** → `DEADLINE_EXCEEDED`. The budget is gone.
- **Retry without throttling?** → How a partial outage becomes a total one.
- **Retry vs hedging?** → Failed backend at no extra load, vs slow backend at ~5% extra load.
- **`round_robin` needs?** → Config + a headless service + connection rotation.

## 11. Hands-On Exercises & Mini Project

- [ ] Build a three-hop chain with independent 5-second timeouts, kill the client after 1 second, and observe every hop still working. Switch to propagated deadlines and watch all three cancel simultaneously.
- [ ] Configure `maxAttempts: 5` on `UNAVAILABLE`, make the server fail intermittently, and count actual attempts with the interceptor from §5.
- [ ] Add `retryThrottling`, drive the server to 50% errors, and chart attempts per second with and without it.
- [ ] Add `hedgingPolicy` with the delay at p50, p95 and p99, and chart p99 latency against total request volume for each.
- [ ] Deploy three replicas behind a `ClusterIP` service with `round_robin` configured and observe that nothing balances. Switch to headless and observe again.
- [ ] Introduce a deliberate typo into the service config JSON and confirm Go ignores it silently. Add a test that parses and asserts the config.
- [ ] Add the server-side deadline-enforcement interceptor and confirm a `context.Background()` client is rejected with a useful message.

### Mini Project — "Resilience Policy Lab"

**Goal.** Derive a retry, hedging and deadline policy from measurement rather than intuition, and prove each choice with data.

**Requirements.**
1. A three-service chain with configurable per-service latency and error injection, plus a load generator producing steady traffic.
2. Deadline propagation throughout, with explicit budget arithmetic per hop and a server-side enforcement interceptor.
3. A service config with per-method policies: aggressive retry on reads, none on non-idempotent writes, retry-with-idempotency-key on one mutation, and throttling.
4. Metrics for attempts versus logical calls, per-code error rates, per-backend distribution, and end-to-end p50/p95/p99.
5. Experiments, each with a chart: error rate 0→50% with and without throttling; hedging delay at p50/p95/p99 versus p99 latency and total load; `pick_first` versus `round_robin` distribution across three replicas; propagated versus independent deadlines under a slow dependency.
6. A one-page policy document recommending settings per method, each justified by one of the charts.

**Extensions.**
- Add a circuit breaker and compare its behaviour against retry throttling under the same failure injection.
- Serve the service config from DNS `TXT` records instead of the client, and demonstrate changing policy without redeploying clients.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *grpc.NewClient, Transport Credentials & Connection Lifecycle* (where the service config is installed), *Invoking All Four Method Kinds from Go* (per-call options and deadline derivation), *Unary Handlers* (server-side context and cancellation), *Graceful Shutdown* (`MaxConnectionAge` and rebalancing), *Build: Deployment* (headless services and L7 balancing).

- **gRFC A6 — client retries** — gRPC Authors · *Advanced* · the normative specification of `retryPolicy`, `hedgingPolicy`, throttling and the "no response yet" commitment rule. <https://github.com/grpc/proposal/blob/master/A6-client-retries.md>
- **gRPC — Service config documentation** — gRPC Authors · *Intermediate* · the full JSON schema, `methodConfig` matching rules and how resolvers can supply config. <https://github.com/grpc/grpc/blob/master/doc/service_config.md>
- **gRPC Blog — Deadlines** — gRPC Authors · *Intermediate* · why deadlines rather than timeouts, how propagation works, and how to budget across hops. <https://grpc.io/blog/deadlines/>
- **gRPC — Retry documentation for Go** — grpc.io · *Intermediate* · configuring and enabling retries in grpc-go, with worked examples. <https://grpc.io/docs/guides/retry/>
- **gRPC Blog — gRPC Load Balancing** — gRPC Authors · *Intermediate* · `pick_first` versus `round_robin`, lookaside balancing, and why connections must rotate. <https://grpc.io/blog/grpc-load-balancing/>
- **The Tail at Scale** — Dean & Barroso, CACM · *Advanced* · the paper behind hedging: why tail latency dominates fan-out systems and what actually helps. <https://research.google/pubs/pub40801/>
- **Google SRE Book — Handling Overload & Addressing Cascading Failures** — Google · *Advanced* · retry amplification, load shedding and deadline propagation as fleet-level survival mechanisms. <https://sre.google/sre-book/handling-overload/>
- **grpc-go examples — features/retry, deadline, load_balancing** — gRPC Authors · *Intermediate* · runnable programs isolating each mechanism in this chapter. <https://github.com/grpc/grpc-go/tree/master/examples/features>

---

*gRPC with Go Handbook — chapter 21.*
