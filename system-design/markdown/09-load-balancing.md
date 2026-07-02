# 09 · Load Balancing

> **In one line:** A load balancer spreads traffic across many servers to buy horizontal scale, high availability, and a single stable entry point — without becoming a new single point of failure itself.

---

## 1. Overview

A **load balancer (LB)** is a reverse-facing traffic cop: it accepts client connections at one virtual address and forwards each request to one of many backend servers. It is the first thing you add when a single box runs out of CPU, and the last thing you can afford to let fail.

Two problems get solved at once. First, **scale**: ten `4-core` boxes serve roughly `10×` the throughput of one, but only if something fans requests across them evenly. Second, **availability**: when a backend dies at 3 a.m., the LB stops routing to it within a health-check interval, and users never notice. Without an LB, a dead server means served errors and a paged engineer.

A concrete example: a checkout API at `50,000 RPS` fronts a fleet of `120` stateless app pods. The LB terminates TLS once, balances by least-connections, drains pods gracefully on every deploy, and keeps two independent LB nodes live behind an Anycast IP so the LB tier is never the weak link. That single component is why the service holds `99.99%` availability through daily deploys and random hardware death.

## 2. Core Concepts

- **L4 (transport) load balancing** — routes on IP + port only, forwarding TCP/UDP segments without reading the payload. Cheap, `µs`-scale, protocol-agnostic; blind to HTTP paths, cookies, or headers.
- **L7 (application) load balancing** — parses HTTP/gRPC and routes on host, path, method, header, or cookie. Enables content routing, retries, and TLS termination — at the cost of more CPU and slightly higher latency.
- **Balancing algorithm** — the rule that picks a backend: **round-robin**, **least-connections**, **least-response-time**, **weighted**, or **hash-based (IP / consistent)**.
- **Health check** — active probes (`GET /healthz` every `2s`) or passive signals (rising `5xx`, connection resets) that mark a backend in/out of rotation.
- **Connection draining (graceful shutdown)** — stop sending *new* requests to a node being removed, but let in-flight requests finish (bounded by a timeout, e.g. `30s`).
- **Sticky session (session affinity)** — pin a client to one backend via cookie or source-IP hash so its in-memory state is found; a scaling anti-pattern to avoid where possible.
- **SPOF & HA** — the LB itself must be redundant: **active-active**, **active-passive**, **Anycast**, or **DNS failover**.
- **Global vs local LB** — **GSLB** picks a *region/PoP* (usually via DNS/Anycast); a **local LB** picks a *server* inside that region.
- **Virtual IP (VIP)** — the single advertised address clients hit; the LB owns it and maps it to a changing pool of real backends.

## 3. Architecture

A production topology is two tiers: a **global** layer that steers users to the nearest healthy region, and a **local** layer inside each region that spreads requests across servers. Clients resolve a hostname to an Anycast VIP; BGP routes them to the closest PoP; the regional L7 LB terminates TLS and picks a backend.

```svg
<svg viewBox="0 0 760 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#475569"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" fill="#64748b">Global + Local load balancing</text>

  <rect x="30" y="45" width="120" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="90" y="66" text-anchor="middle" fill="#1e293b">Clients</text>
  <text x="90" y="82" text-anchor="middle" fill="#64748b" font-size="11">DNS / Anycast</text>

  <rect x="220" y="45" width="150" height="46" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="295" y="66" text-anchor="middle" fill="#1e293b">Global LB (GSLB)</text>
  <text x="295" y="82" text-anchor="middle" fill="#64748b" font-size="11">picks nearest region</text>
  <line x1="150" y1="68" x2="218" y2="68" stroke="#475569" stroke-width="1.5" marker-end="url(#ah)"/>

  <!-- Region A -->
  <rect x="440" y="30" width="290" height="130" rx="10" fill="none" stroke="#94a3b8" stroke-dasharray="4 3"/>
  <text x="585" y="48" text-anchor="middle" fill="#64748b" font-size="11">Region A (active)</text>
  <rect x="460" y="58" width="120" height="42" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="520" y="76" text-anchor="middle" fill="#1e293b">L7 LB (VIP)</text>
  <text x="520" y="91" text-anchor="middle" fill="#64748b" font-size="11">TLS · health</text>
  <line x1="370" y1="68" x2="458" y2="79" stroke="#475569" stroke-width="1.5" marker-end="url(#ah)"/>
  <rect x="620" y="52" width="92" height="24" rx="6" fill="#eff6ff" stroke="#2563eb"/>
  <text x="666" y="68" text-anchor="middle" fill="#1e293b" font-size="11">app-1</text>
  <rect x="620" y="82" width="92" height="24" rx="6" fill="#eff6ff" stroke="#2563eb"/>
  <text x="666" y="98" text-anchor="middle" fill="#1e293b" font-size="11">app-2</text>
  <rect x="620" y="112" width="92" height="24" rx="6" fill="#eff6ff" stroke="#2563eb"/>
  <text x="666" y="128" text-anchor="middle" fill="#1e293b" font-size="11">app-3</text>
  <line x1="580" y1="72" x2="618" y2="64" stroke="#475569" stroke-width="1.2" marker-end="url(#ah)"/>
  <line x1="580" y1="79" x2="618" y2="94" stroke="#475569" stroke-width="1.2" marker-end="url(#ah)"/>
  <line x1="580" y1="86" x2="618" y2="124" stroke="#475569" stroke-width="1.2" marker-end="url(#ah)"/>

  <!-- Region B -->
  <rect x="440" y="185" width="290" height="120" rx="10" fill="none" stroke="#94a3b8" stroke-dasharray="4 3"/>
  <text x="585" y="203" text-anchor="middle" fill="#64748b" font-size="11">Region B (failover)</text>
  <rect x="460" y="213" width="120" height="42" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="520" y="231" text-anchor="middle" fill="#1e293b">L7 LB (VIP)</text>
  <text x="520" y="246" text-anchor="middle" fill="#64748b" font-size="11">standby</text>
  <line x1="295" y1="91" x2="460" y2="228" stroke="#475569" stroke-width="1.2" stroke-dasharray="4 3" marker-end="url(#ah)"/>
  <rect x="620" y="222" width="92" height="24" rx="6" fill="#eff6ff" stroke="#2563eb"/>
  <text x="666" y="238" text-anchor="middle" fill="#1e293b" font-size="11">app-N</text>
  <line x1="580" y1="234" x2="618" y2="234" stroke="#475569" stroke-width="1.2" marker-end="url(#ah)"/>
</svg>
```

## 4. How It Works

The request lifecycle through an L7 LB, step by step:

1. **DNS / Anycast resolve.** The client resolves the hostname. A GSLB returns the IP of the nearest or healthiest region (geo/latency-based DNS), or an Anycast VIP is announced from many PoPs and BGP picks the closest.
2. **Connection + TLS.** The client opens TCP to the VIP and completes the TLS handshake **at the LB** (TLS termination), so backends speak cheap HTTP over the internal network.
3. **Parse & match.** The L7 LB reads the request line and headers, matches a routing rule (host/path), and selects the target backend pool.
4. **Pick a backend.** The balancing algorithm chooses one healthy member — e.g. least-connections picks the node with the fewest open connections.
5. **Proxy & (optionally) retry.** The LB forwards the request, streams the response back, and on a connection failure or `5xx` may retry another backend (idempotent requests only).
6. **Health accounting.** Continuous active probes and passive error signals update each backend's in/out status; failing nodes leave rotation within one interval.
7. **Drain on change.** On deploy or scale-in, the target node is marked draining: no new requests, in-flight allowed to finish, then removed.

## 5. Key Components / Deep Dive

### Algorithms

| Algorithm | How it picks | Best for |
|---|---|---|
| **Round-robin** | Next backend in rotation | Uniform, short requests on identical nodes |
| **Weighted RR** | RR biased by capacity weight | Heterogeneous hardware (big + small boxes) |
| **Least-connections** | Fewest active connections | Variable/long request durations |
| **Least response time** | Lowest latency + fewest conns | Latency-sensitive tiers |
| **IP hash** | Hash of source IP → backend | Cheap affinity without cookies |
| **Consistent hash** | Hash key on a ring | Cache affinity; minimal reshuffle on scaling (see **Consistent Hashing**) |

Round-robin is the default but fails badly when request cost varies — one slow `/report` request ties up a node while RR keeps feeding it. **Least-connections** self-corrects because busy nodes hold connections longer. **Consistent hashing** is the choice when a backend owns cached state and you want key `K` to keep landing on the same node even as the pool grows or shrinks.

### Health checks

- **Active:** LB probes `GET /healthz` on an interval (`2s`), with thresholds (`3` failures out, `2` successes in) to damp flapping. The endpoint should check *dependencies* (DB reachable?) but avoid making health depend on a shared downstream, or one DB blip drains the whole fleet.
- **Passive (outlier detection):** the LB watches live traffic and ejects a node showing a burst of `5xx`/resets, re-admitting it after a cooldown.

### Connection draining

On rolling deploy: mark node draining → LB stops new dispatch → existing requests finish within the drain timeout (`30s`) → orchestrator kills the pod. Skipping this returns broken responses and severed uploads on every deploy.

### Sticky sessions

Affinity pins a client to one backend (cookie-inserted by the LB, or source-IP hash) so server-local session state is found. It **fights the load balancer**: load skews toward whichever node holds the whales, failover loses the pinned user's session, and autoscaling can't rebalance existing users. Prefer **stateless services** with session state in **Redis** or a signed **JWT** token — then any node serves any request and stickiness is unnecessary.

## 6. Trade-offs

| Option | Pros | Cons |
|---|---|---|
| **L4 LB** | `µs` latency, huge throughput, protocol-agnostic, cheap CPU | No content routing, no TLS termination, no HTTP retries |
| **L7 LB** | Path/host routing, TLS, retries, header rewrites, WAF hooks | More CPU/latency, must parse payload, richer attack surface |
| **Round-robin** | Trivial, even under uniform load | Terrible under variable request cost |
| **Least-connections** | Adapts to slow requests automatically | Needs connection-state tracking; poor for long-lived conns |
| **Sticky sessions** | Simple path to server-local caches/state | Skewed load, broken failover, blocks autoscale |
| **Anycast (global)** | Auto-nearest, DDoS absorption, fast failover | Needs BGP/network control; long-lived flows can re-route |
| **DNS failover (global)** | Works anywhere, no special network | TTL + resolver caching = minutes of stale routing |

Pick **L4** when you need raw speed and the backends handle their own TLS/routing (e.g. a gRPC mesh entrypoint); pick **L7** when you need smart routing, one TLS termination point, or retries. For the global tier, **Anycast** wins on failover speed but demands network control; **DNS** is universal but slow to fail over because of TTL caching.

## 7. When to Use / When to Avoid

**Use when:**
- You have (or will have) more than one backend instance and need horizontal scale.
- You need zero-downtime deploys, rolling restarts, or automatic removal of dead nodes.
- You want one TLS termination point, content-based routing, or canary/weighted traffic splits.
- You are going multi-region and need users steered to the nearest healthy region.

**Avoid / reconsider when:**
- A single instance comfortably serves the load and a brief restart is acceptable — an LB adds a hop and ops burden for no gain.
- Ultra-low-latency internal paths where an extra proxy hop (`0.2–1 ms`) is unacceptable — consider client-side load balancing or a service mesh instead.
- You'd use it only to paper over stateful servers — fix statelessness first, or you inherit sticky-session pain.

## 8. Scaling & Production Best Practices

- **Keep backends stateless.** Externalize session/state to Redis or tokens so any node serves any request; this is what makes the LB effective at all.
- **Run the LB in HA from day one.** Two+ nodes active-active behind a floating VIP or Anycast; never one LB.
- **Terminate TLS once at the LB**, reuse warm backend connections (HTTP keep-alive / connection pooling) to cut handshake cost.
- **Right-size health checks:** `2s` interval, `3`-fail eject / `2`-pass admit; make `/healthz` shallow enough to not thundering-herd your DB.
- **Always drain** on deploy/scale-in with a bounded timeout (`30s`); wire it into your orchestrator's `preStop` hook.
- **Cap and shed:** set per-backend max connections and enable load shedding / queue limits so overload degrades gracefully instead of collapsing.
- **Bound retries** with a budget (e.g. retry ≤`10%` of requests) to avoid retry storms amplifying an outage.
- **Watch the LB's own ceiling:** connection tables, ephemeral ports, SSL ops/sec, and bandwidth are finite — a single LB node tops out well before "infinite."

## 9. Failure Modes & Mitigations

| Failure | Impact | Mitigation |
|---|---|---|
| LB node dies (SPOF) | Total outage — VIP unreachable | Active-active pair + floating VIP / Anycast; DNS failover as backstop |
| No health checks | Traffic routed to dead backends → `5xx` | Active + passive checks with eject thresholds |
| Flapping health check | Nodes thrash in/out, load oscillates | Hysteresis: separate fail/pass thresholds, cooldown |
| Retry storm | One slow backend amplifies into fleet overload | Retry budgets, circuit breakers, exponential backoff |
| Sticky session + node loss | Pinned users lose state / are logged out | Stateless + Redis/JWT; treat affinity as best-effort |
| Uneven load (bad algo) | Some nodes hot, others idle | Least-connections / weighted; verify with per-node metrics |
| DNS failover TTL lag | Minutes of traffic to a dead region | Low TTL (`30–60s`) + Anycast for fast paths; health-checked GSLB |
| TLS/cert expiry at LB | Global handshake failures | Automated cert rotation + expiry alerts (`>21d` warning) |

## 10. Monitoring & Metrics

- **Per-backend:** active connections, RPS, `2xx/4xx/5xx` split, p50/p95/p99 latency, health status (in/out of rotation).
- **LB tier:** total throughput (RPS + Gbps), connection table utilization, ephemeral port exhaustion, SSL handshakes/sec, CPU.
- **Health-check churn:** ejections/min and admissions/min (spikes signal instability or a bad probe).
- **Retry rate & retry budget consumption** — rising retries precede overload.
- **Load evenness:** stddev of RPS across backends; a widening gap means the algorithm or weights are wrong.
- **Drain duration:** how long nodes take to finish draining on deploy (should be well under the timeout).
- **Alerts:** any backend pool below N healthy nodes; LB CPU `>70%`; `5xx` rate `>1%`; cert expiry `<21d`; single LB node up (redundancy lost).

## 11. Common Mistakes

1. ⚠️ **Single LB with no redundancy** — the whole point of HA undone by one box; run active-active.
2. ⚠️ **Round-robin under variable request cost** — one node drowns while others idle; use least-connections.
3. ⚠️ **`/healthz` that hits the shared DB** — one DB hiccup drains every backend at once.
4. ⚠️ **No connection draining** — every deploy severs in-flight requests and uploads.
5. ⚠️ **Sticky sessions as a crutch** for stateful servers — kills failover and autoscaling.
6. ⚠️ **Unbounded retries** — turning a small backend blip into a fleet-wide retry storm.
7. ⚠️ **Relying on DNS failover alone** with a `3600s` TTL — an hour of blackholed traffic.
8. ⚠️ **Ignoring the LB's own limits** — connection/port/bandwidth ceilings hit silently under a traffic spike.

## 12. Interview Questions

**Q: What's the difference between L4 and L7 load balancing, and when do you pick each?**
A: L4 balances on IP/port at the transport layer — fast (`µs`), protocol-agnostic, no payload inspection. L7 parses HTTP/gRPC and routes on host/path/header/cookie, enabling TLS termination, content routing, and retries, at higher CPU/latency. Pick L4 for raw throughput or non-HTTP protocols where backends handle their own routing; pick L7 when you need smart routing, a single TLS point, or application-aware retries.

**Q: Compare round-robin and least-connections. When does round-robin fail?**
A: Round-robin cycles evenly and is ideal for uniform, short requests on identical nodes. It fails when request cost varies — a slow endpoint ties up a node while RR keeps feeding it, creating hotspots. Least-connections self-corrects because busy nodes accumulate connections and get skipped.

**Q: How would you make the load balancer itself not a single point of failure?**
A: Run at least two LB nodes active-active (or active-passive) sharing a floating VIP via VRRP/keepalived, or announce an Anycast VIP from multiple PoPs so BGP routes around a dead node. Add health-checked DNS/GSLB failover across regions as a backstop. Never a single LB instance.

**Q: What is connection draining and why does it matter?**
A: On removing a node (deploy/scale-in), the LB stops sending new requests but lets in-flight ones finish within a timeout (e.g. `30s`) before the node is killed. Without it, every deploy returns broken responses and severs uploads/streams mid-flight.

**Q: Why are sticky sessions considered an anti-pattern, and what do you use instead?**
A: Affinity pins a client to one backend, which skews load toward nodes holding heavy users, loses session state on failover, and blocks autoscaling from rebalancing. Instead make services stateless: keep session state in Redis or a signed JWT so any node can serve any request.

**Q: How do health checks work, and what's the risk of a badly designed one?**
A: Active checks probe `/healthz` on an interval with fail/pass thresholds to damp flapping; passive checks eject nodes showing live `5xx`/resets. The danger is coupling health to a shared dependency — if `/healthz` queries the primary DB, one DB blip fails every backend at once and drains the whole fleet.

**Q: (Senior) Design the global routing for a service in three regions with fast failover. What are the trade-offs?**
A: Use an Anycast VIP announced from all three regions so BGP steers users to the nearest PoP and withdraws a dead region in seconds — fast failover but requires network/BGP control and long-lived TCP flows can re-route mid-connection. Alternatively use latency/geo DNS (GSLB) with health checks: universal and no special networking, but resolver TTL caching means minutes of stale routing on failover. In practice combine them: Anycast for the edge, GSLB with low TTL (`30–60s`) as the coarse regional selector, and per-region local LBs picking servers.

**Q: (Senior) A single slow backend causes cascading failure across the fleet. Walk through why and how you'd stop it.**
A: Clients/LB retry the slow node's failures, doubling load; retries pile onto already-saturated backends; connection pools exhaust; healthy nodes now queue and slow too — a metastable collapse. Stop it with retry budgets (cap retries at ~`10%` of requests), circuit breakers that trip a failing backend open, passive outlier ejection, load shedding at the LB, and timeouts shorter than the client's patience so work isn't wasted.

**Q: (Senior) Where does consistent hashing fit in load balancing, and why not plain modulo hashing?**
A: When backends own cached state, you want key `K` to keep hitting the same node for cache affinity. Plain `hash(K) mod N` remaps almost every key when `N` changes (a node added/removed), causing a cache-wide miss storm. Consistent hashing places nodes on a ring so adding/removing a node only remaps `~1/N` of keys — minimal disruption. See **Consistent Hashing**.

**Q: (Senior) How do you load balance long-lived connections (WebSocket/gRPC streams) where least-connections and RR both misbehave?**
A: With few, long connections the LB's per-connection view goes stale — one node can hold all the heavy streams. Use L7-aware balancing that distributes at the *request* level inside a stream (HTTP/2 gRPC), or client-side load balancing / a service mesh (Envoy) that balances RPCs across subchannels. Add connection age limits / max-requests-per-connection so clients periodically re-resolve and rebalance, and weight by observed load rather than raw connection count.

**Q: What is the difference between global and local load balancing?**
A: Global (GSLB) picks a *region/PoP* — usually via geo/latency DNS or Anycast — to get users to the nearest healthy datacenter. Local LB picks a *server* within that region. They compose: global for locality and regional failover, local for spreading requests across the fleet.

## 13. Alternatives & Related

- **Consistent Hashing** — the ring algorithm behind cache-affinity balancing and sharding.
- **Proxies, Reverse Proxies & API Gateways** — the LB is one job a reverse proxy/gateway performs; see topic 10.
- **CDN** — global edge load balancing plus caching for static and cacheable content; see topic 11.
- **Vertical vs Horizontal Scaling & Statelessness** — statelessness is the precondition that makes LBs effective; see topic 13.
- **Rate Limiting** — often enforced at the LB/gateway edge.
- **Service mesh / client-side LB** — moves balancing into sidecars for internal service-to-service traffic.

## 14. Cheat Sheet

> [!TIP]
> **Load Balancing in 60 seconds**
> - **L4** = IP/port, fast, dumb. **L7** = HTTP-aware, TLS termination, content routing, retries.
> - **Algorithms:** round-robin (uniform), **least-connections** (variable cost — the safe default), weighted (mixed hardware), **consistent hash** (cache affinity, minimal reshuffle).
> - **Health checks** with fail/pass thresholds; keep `/healthz` shallow. **Drain** on every deploy (`~30s`).
> - **Avoid sticky sessions** — go stateless with Redis/JWT so any node serves any request.
> - **The LB is a SPOF** — run active-active + Anycast/floating VIP; DNS failover as backstop.
> - **Global (GSLB/Anycast)** picks the region; **local LB** picks the server.
> - Watch: per-node RPS/latency/`5xx`, connection-table + port exhaustion, retry rate, health-check churn.

**References:** NGINX "HTTP Load Balancing" docs, Google SRE Book (ch. "Load Balancing at the Frontend / Datacenter"), AWS Elastic Load Balancing docs, Cloudflare "What is Anycast" Learning Center

---
*System Design Handbook — topic 09.*
