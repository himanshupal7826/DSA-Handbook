# 29 · Build: Deployment — Kubernetes, Proxies, grpc-gateway & gRPC-Web

> **In one line:** A standard Kubernetes `Service` balances *connections* and gRPC opens exactly one, so every gRPC deployment must choose between client-side load balancing over a headless service, an L7 proxy, or a mesh — and browsers need a translation layer regardless.

---

## 1. Overview

gRPC's deployment problems all descend from one fact: **it uses a single long-lived, multiplexed HTTP/2 connection.** That is exactly what makes it fast (chapter 2) and exactly what breaks the infrastructure most teams already have.

`kube-proxy` operates at layer 4. When a client connects to a `ClusterIP` service, it picks a backend pod and rewrites the connection there — once. Every subsequent RPC on that connection goes to the same pod. So:

- **Scaling up does nothing.** New pods receive no traffic until clients reconnect.
- **Load is uneven.** Whichever pods existed when clients started keep everything.
- **Rolling deploys skew further.** Clients reconnect en masse to whichever pods are up first.

There are exactly three fixes, and every gRPC deployment picks one: **client-side load balancing** over a headless service, an **L7 proxy** that understands HTTP/2 streams, or a **service mesh** that inserts such a proxy transparently.

The second deployment problem is **browsers**. They cannot do gRPC, because JavaScript has no access to HTTP/2 trailers where the status lives (chapter 2). The options are gRPC-Web with a translating proxy, Connect, or a JSON gateway generated from the same `.proto` — and the last of those is usually the right answer because it also serves partners and curl.

## 2. Core Concepts

- **`ClusterIP` service** — a single virtual IP, L4 balanced by `kube-proxy`. Balances connections, not RPCs.
- **Headless service** — `clusterIP: None`; DNS returns every pod IP, enabling client-side balancing.
- **Client-side load balancing** — `round_robin` in the service config plus a resolver returning many addresses (chapter 21).
- **`MaxConnectionAge`** — server-side connection rotation, without which clients never re-resolve (chapter 18).
- **L7 proxy** — Envoy, NGINX, HAProxy or an ingress controller that terminates HTTP/2 and balances per RPC.
- **Service mesh** — Istio, Linkerd; injects a sidecar proxy so applications need no load-balancing code.
- **xDS** — the control-plane protocol; grpc-go can consume it directly with `xds:///` targets, skipping the sidecar.
- **gRPC-Web** — a browser-compatible protocol encoding trailers into the body; needs a proxy and forbids client/bidi streaming.
- **`grpc-gateway`** — generates a JSON/REST reverse proxy from `google.api.http` annotations.
- **Connect** — a protocol serving gRPC, gRPC-Web and JSON/HTTP from one handler, no proxy required.
- **h2c** — cleartext HTTP/2, for when TLS is terminated upstream.

## 3. Theory & Principles

### The three load-balancing models

| | Client-side | L7 proxy | Service mesh |
|---|---|---|---|
| Where the decision is made | In the client | In the proxy | In the sidecar |
| Needs | Headless service + `round_robin` | Envoy/NGINX/ingress | Istio/Linkerd |
| Extra hop | No | Yes | Yes (localhost) |
| Language support | Per-language client work | None needed | None needed |
| Advanced policy | Limited | Rich | Richest |
| mTLS | Your problem | Proxy terminates | Automatic |
| Operational cost | Lowest | Medium | Highest |

**Client-side** is the lowest-latency and simplest option: no extra hop, no extra component. Its weaknesses are that every language needs the configuration, and that policy is limited to what the balancer implements. It is the right default for a Go-only estate.

**L7 proxy** moves the decision to infrastructure, giving you rich policy — retries, outlier ejection, circuit breaking, canary weights — at the cost of a network hop and a component to run. It is the right answer when clients are polyglot or when you need policy the client cannot express.

**A mesh** is an L7 proxy per pod, injected automatically, plus mTLS and a control plane. Enormously capable and enormously operationally heavy; justified at scale or where zero-trust mTLS is mandatory.

**xDS-direct** is the emerging middle path: grpc-go speaks the control-plane protocol itself with an `xds:///` target, so you get mesh-grade policy with no sidecar and no extra hop.

### Why `MaxConnectionAge` is not optional

Even with `round_robin` over a headless service, a client resolves DNS once and connects to the pods that existed then. Scale from three to ten pods and the seven new ones stay idle, because nothing prompts a re-resolution.

`MaxConnectionAge` on the server sends `GOAWAY` after a connection has lived that long, forcing the client to re-resolve and reconnect. That is what makes autoscaling actually work for gRPC. It must be paired with `MaxConnectionAgeGrace`, or in-flight RPCs are cut at every rotation rather than drained — a self-inflicted error spike on a timer.

Thirty minutes with a thirty-second grace is a reasonable default. grpc-go adds jitter so a fleet does not rotate simultaneously.

```svg
<svg viewBox="0 0 880 500" width="100%" height="500" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="dp1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#0ea5e9"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Why a ClusterIP service does not balance gRPC</text>

  <rect x="24" y="42" width="832" height="150" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="440" y="64" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">ClusterIP + kube-proxy (L4): balances CONNECTIONS, and gRPC opens one</text>

  <rect x="52" y="82" width="100" height="40" rx="6" fill="#fff" stroke="#fca5a5"/>
  <text x="102" y="106" text-anchor="middle" fill="#7f1d1d" font-size="10">client</text>
  <g stroke="#dc2626" stroke-width="4">
    <path d="M154,100 L286,96"/>
  </g>
  <text x="220" y="88" text-anchor="middle" fill="#b91c1c" font-size="9">ONE long-lived HTTP/2 connection</text>
  <rect x="290" y="80" width="130" height="32" rx="5" fill="#fecaca" stroke="#dc2626" stroke-width="2"/>
  <text x="355" y="100" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">pod A &#8212; 100%</text>
  <rect x="290" y="118" width="130" height="26" rx="5" fill="#fff" stroke="#fca5a5"/>
  <text x="355" y="136" text-anchor="middle" fill="#991b1b" font-size="10">pod B &#8212; idle</text>
  <rect x="290" y="150" width="130" height="26" rx="5" fill="#fff" stroke="#fca5a5"/>
  <text x="355" y="168" text-anchor="middle" fill="#991b1b" font-size="10">pod C &#8212; idle (new)</text>

  <text x="450" y="102" fill="#991b1b" font-size="10">kube-proxy picks a backend ONCE, at connection time,</text>
  <text x="450" y="118" fill="#991b1b" font-size="10">then rewrites every packet to the same pod.</text>
  <text x="450" y="140" fill="#7f1d1d" font-size="10" font-weight="bold">Scaling up does nothing. Load stays where it landed.</text>
  <text x="450" y="158" fill="#7f1d1d" font-size="10" font-weight="bold">Rolling deploys skew it further, not less.</text>
  <text x="450" y="180" fill="#991b1b" font-size="10">This is structural, not a misconfiguration.</text>

  <rect x="24" y="210" width="270" height="196" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="159" y="232" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">1. Client-side</text>
  <text x="40" y="256" fill="#166534" font-size="10">headless service (clusterIP: None)</text>
  <text x="40" y="272" fill="#166534" font-size="10">+ round_robin in the service config</text>
  <text x="40" y="288" fill="#166534" font-size="10">+ MaxConnectionAge on the server</text>
  <text x="40" y="312" fill="#15803d" font-size="10" font-weight="bold">&#10003; no extra hop, lowest latency</text>
  <text x="40" y="328" fill="#15803d" font-size="10" font-weight="bold">&#10003; nothing extra to run</text>
  <text x="40" y="350" fill="#b91c1c" font-size="10">&#10007; every language needs configuring</text>
  <text x="40" y="366" fill="#b91c1c" font-size="10">&#10007; policy limited to the balancer</text>
  <text x="40" y="392" fill="#15803d" font-size="10" font-weight="bold">Default for a Go-only estate.</text>

  <rect x="306" y="210" width="270" height="196" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="441" y="232" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">2. L7 proxy</text>
  <text x="322" y="256" fill="#1d4ed8" font-size="10">Envoy / NGINX / ingress controller</text>
  <text x="322" y="272" fill="#1d4ed8" font-size="10">terminates HTTP/2, balances per RPC</text>
  <text x="322" y="296" fill="#1e40af" font-size="10" font-weight="bold">&#10003; rich policy: retries, outlier</text>
  <text x="322" y="312" fill="#1e40af" font-size="10" font-weight="bold">   ejection, canary weights</text>
  <text x="322" y="328" fill="#1e40af" font-size="10" font-weight="bold">&#10003; clients need no gRPC LB code</text>
  <text x="322" y="350" fill="#b91c1c" font-size="10">&#10007; an extra network hop</text>
  <text x="322" y="366" fill="#b91c1c" font-size="10">&#10007; a component to run and tune</text>
  <text x="322" y="392" fill="#1e40af" font-size="10" font-weight="bold">Right when clients are polyglot.</text>

  <rect x="588" y="210" width="268" height="196" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="722" y="232" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">3. Service mesh</text>
  <text x="604" y="256" fill="#6d28d9" font-size="10">Istio / Linkerd: an L7 proxy per pod,</text>
  <text x="604" y="272" fill="#6d28d9" font-size="10">injected automatically</text>
  <text x="604" y="296" fill="#5b21b6" font-size="10" font-weight="bold">&#10003; richest policy + automatic mTLS</text>
  <text x="604" y="312" fill="#5b21b6" font-size="10" font-weight="bold">&#10003; zero application code</text>
  <text x="604" y="334" fill="#b91c1c" font-size="10">&#10007; highest operational cost</text>
  <text x="604" y="350" fill="#b91c1c" font-size="10">&#10007; a control plane to run</text>
  <text x="604" y="376" fill="#5b21b6" font-size="10" font-weight="bold">xDS-direct is the middle path:</text>
  <text x="604" y="392" fill="#6d28d9" font-size="10">xds:/// targets, no sidecar, no extra hop.</text>

  <rect x="24" y="424" width="832" height="66" rx="10" fill="#fefce8" stroke="#ca8a04" stroke-width="2"/>
  <text x="440" y="446" text-anchor="middle" fill="#854d0e" font-size="12" font-weight="bold">MaxConnectionAge is not optional, even with round_robin</text>
  <text x="48" y="468" fill="#713f12">A client resolves DNS once. Scale 3 &#8594; 10 pods and the seven new ones stay idle, because nothing prompts a re-resolve.</text>
  <text x="48" y="484" fill="#713f12">GOAWAY after ~30 min forces it. Pair with MaxConnectionAgeGrace, or in-flight RPCs are cut on a timer.</text>
</svg>
```

### Browsers: three options

Browsers cannot speak gRPC. `fetch` and `XMLHttpRequest` expose no HTTP/2 trailers and no framing control, and gRPC's terminal status lives in trailers. The choices:

| | gRPC-Web | Connect | grpc-gateway |
|---|---|---|---|
| Proxy needed | Yes (Envoy filter or Go wrapper) | No | It *is* the proxy |
| Wire format | Binary or base64, trailers in body | gRPC, gRPC-Web or JSON | JSON |
| Server streaming | Yes | Yes | Yes (chunked) |
| Client/bidi streaming | **No** | Only over HTTP/2 | No |
| curl-able | Awkward | Yes | Yes |
| Best for | Existing gRPC + a browser client | New systems | JSON edge for partners |

For a new system, **Connect** is the strongest option: one handler serves gRPC for internal services, gRPC-Web for browsers and JSON over HTTP/1.1 for curl and partners, with no proxy. For an existing gRPC service that needs a JSON edge, **grpc-gateway** generated from the same `.proto` is the standard answer — and the critical property is that both come from one contract, so they cannot drift.

## 4. Architecture & Workflow

The layered shape most mature systems converge on:

1. **Edge**: JSON/REST or Connect, TLS terminated, authenticated, rate limited. Consumers are browsers, mobile apps and partners.
2. **Translation**: `grpc-gateway` or `connect-go`, generated from the same `.proto` as the gRPC service.
3. **Mesh**: gRPC everywhere internally, with one of the three load-balancing models.
4. **Async spine**: a queue for anything not needing a synchronous answer (chapter 4).

The deployment checklist for any gRPC service:

- Load balancing chosen and verified by scaling under load.
- `MaxConnectionAge` + grace set.
- Health probes with correct asymmetric thresholds (chapter 25).
- `preStop` hook and graceful shutdown budget within `terminationGracePeriodSeconds` (chapter 18).
- Message-size and stream-concurrency limits set (chapter 28).
- Any proxy in the path verified HTTP/2 end-to-end and trailer-aware.

```svg
<svg viewBox="0 0 880 440" width="100%" height="440" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="br1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#0ea5e9"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Serving browsers and partners from ONE contract</text>

  <rect x="24" y="42" width="160" height="140" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="104" y="64" text-anchor="middle" fill="#1e40af" font-size="11" font-weight="bold">Consumers</text>
  <rect x="40" y="76" width="128" height="26" rx="4" fill="#fff" stroke="#60a5fa"/>
  <text x="104" y="94" text-anchor="middle" fill="#1d4ed8" font-size="9">browser SPA</text>
  <rect x="40" y="108" width="128" height="26" rx="4" fill="#fff" stroke="#60a5fa"/>
  <text x="104" y="126" text-anchor="middle" fill="#1d4ed8" font-size="9">mobile app</text>
  <rect x="40" y="140" width="128" height="26" rx="4" fill="#fff" stroke="#60a5fa"/>
  <text x="104" y="158" text-anchor="middle" fill="#1d4ed8" font-size="9">partner / curl</text>

  <path d="M186,112 L222,112" stroke="#0ea5e9" stroke-width="2" marker-end="url(#br1)"/>

  <rect x="226" y="42" width="240" height="140" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="346" y="64" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">Translation layer</text>
  <text x="242" y="88" fill="#166534" font-size="10">grpc-gateway (generated) &#8212; JSON/REST</text>
  <text x="242" y="106" fill="#166534" font-size="10">or connect-go &#8212; ONE handler serves</text>
  <text x="242" y="122" fill="#166534" font-size="10">gRPC + gRPC-Web + JSON, no proxy</text>
  <text x="242" y="146" fill="#15803d" font-size="10" font-weight="bold">Generated from the SAME .proto</text>
  <text x="242" y="162" fill="#15803d" font-size="10" font-weight="bold">&#8594; the facade cannot drift.</text>

  <path d="M468,112 L504,112" stroke="#0ea5e9" stroke-width="2" marker-end="url(#br1)"/>

  <rect x="508" y="42" width="348" height="140" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="682" y="64" text-anchor="middle" fill="#5b21b6" font-size="11" font-weight="bold">gRPC services (east&#8211;west)</text>
  <text x="524" y="88" fill="#6d28d9" font-size="10">headless service + round_robin, or an L7 proxy</text>
  <text x="524" y="106" fill="#6d28d9" font-size="10">MaxConnectionAge so scaling actually rebalances</text>
  <text x="524" y="124" fill="#6d28d9" font-size="10">mTLS &#183; deadline propagation &#183; standard codes</text>
  <text x="524" y="148" fill="#5b21b6" font-size="10" font-weight="bold">Verify balancing by SCALING UNDER LOAD &#8212;</text>
  <text x="524" y="164" fill="#5b21b6" font-size="10" font-weight="bold">config alone proves nothing.</text>

  <rect x="24" y="202" width="832" height="106" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="440" y="224" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Why browsers cannot speak gRPC directly</text>
  <text x="48" y="248" fill="#991b1b">fetch and XMLHttpRequest expose no HTTP/2 trailers and no framing control &#8212; and gRPC's terminal status lives in trailers.</text>
  <text x="48" y="270" fill="#991b1b">gRPC-Web works around it by encoding trailers into the response body, which is why it needs a translating proxy</text>
  <text x="48" y="286" fill="#991b1b">(Envoy's filter or a Go wrapper) and why it cannot do client-side or bidirectional streaming at all.</text>

  <rect x="24" y="326" width="832" height="106" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="348" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Anything in the path must be HTTP/2 end-to-end and trailer-aware</text>
  <text x="48" y="372" fill="#475569">A proxy that terminates HTTP/1.1, strips trailers, or buffers whole responses BREAKS gRPC &#8212; usually in a way that looks</text>
  <text x="48" y="388" fill="#475569">like an application bug: streams that never stream, calls that report OK when they failed, or Internal with no explanation.</text>
  <text x="48" y="412" fill="#334155" font-weight="bold">Verify with a server-streaming call through the proxy: if messages arrive in one batch at the end, it is buffering.</text>
</svg>
```

## 5. Implementation

### Client-side load balancing over a headless service

```yaml
# A HEADLESS service: clusterIP: None means DNS returns every pod IP rather
# than one virtual IP, which is what gives the client something to balance
# across. A normal ClusterIP service resolves to a single address, so
# round_robin has exactly one target and does nothing.
apiVersion: v1
kind: Service
metadata:
  name: inventory-headless
spec:
  clusterIP: None
  selector:
    app: inventory
  ports:
    - name: grpc
      port: 50051
      targetPort: grpc
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: inventory
spec:
  replicas: 3
  template:
    spec:
      terminationGracePeriodSeconds: 60
      containers:
        - name: inventory
          image: acme/inventory:v1.8.0
          ports:
            - name: grpc
              containerPort: 50051
          readinessProbe:
            grpc: {port: 50051}
            periodSeconds: 3
            failureThreshold: 2          # FAST: only removes traffic
          livenessProbe:
            grpc: {port: 50051}
            periodSeconds: 15
            failureThreshold: 5          # SLOW: restarts the process
          lifecycle:
            preStop:
              exec:
                command: ["/bin/sh", "-c", "sleep 10"]
```

```go
// Client: three things are required, and omitting any one silently reverts to
// "all traffic on one pod".
conn, err := grpc.NewClient(
	// 1. Resolve the HEADLESS service, so DNS returns pod IPs.
	"dns:///inventory-headless.default.svc.cluster.local:50051",

	// 2. Ask for round_robin — pick_first is the default and uses ONE backend.
	grpc.WithDefaultServiceConfig(`{
		"loadBalancingConfig": [{"round_robin": {}}]
	}`),

	grpc.WithTransportCredentials(creds),
)
```

```go
// 3. Server: MaxConnectionAge, or clients never re-resolve and pods added by
// the autoscaler stay cold forever.
grpc.NewServer(
	grpc.KeepaliveParams(keepalive.ServerParameters{
		MaxConnectionAge:      30 * time.Minute,
		MaxConnectionAgeGrace: 30 * time.Second, // REQUIRED, or RPCs are cut
		Time:                  30 * time.Second,
		Timeout:               10 * time.Second,
	}),
)
```

### Envoy as an L7 proxy

```yaml
# envoy.yaml — per-RPC balancing, plus policy the client cannot express.
static_resources:
  listeners:
    - name: grpc_listener
      address: {socket_address: {address: 0.0.0.0, port_value: 8443}}
      filter_chains:
        - filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                codec_type: AUTO
                stat_prefix: grpc
                route_config:
                  virtual_hosts:
                    - name: inventory
                      domains: ["*"]
                      routes:
                        - match:
                            prefix: "/acme.inventory.v1.InventoryService/"
                          route:
                            cluster: inventory
                            # Streams need a long (or disabled) timeout; the
                            # default 15s would kill every long-lived stream.
                            timeout: 0s
                            retry_policy:
                              retry_on: "unavailable,resource-exhausted"
                              num_retries: 3
                              # gRPC-aware retry: Envoy understands the status
                              # trailer, not just HTTP codes.
                              retriable_status_codes: [14]
                http_filters:
                  # Required for browsers: translates gRPC-Web into gRPC,
                  # moving trailers between the body and real trailers.
                  - name: envoy.filters.http.grpc_web
                  - name: envoy.filters.http.router
  clusters:
    - name: inventory
      # STRICT_DNS re-resolves periodically, so scaling is picked up.
      type: STRICT_DNS
      lb_policy: ROUND_ROBIN
      # Without this, Envoy speaks HTTP/1.1 upstream and gRPC breaks entirely.
      typed_extension_protocol_options:
        envoy.extensions.upstreams.http.v3.HttpProtocolOptions:
          "@type": type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions
          explicit_http_config:
            http2_protocol_options:
              max_concurrent_streams: 1000
      load_assignment:
        cluster_name: inventory
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    socket_address:
                      address: inventory-headless.default.svc.cluster.local
                      port_value: 50051
      # Outlier ejection: remove a pod that is returning errors. This is the
      # kind of policy a client-side balancer cannot express.
      outlier_detection:
        consecutive_5xx: 5
        consecutive_gateway_failure: 5
        interval: 10s
        base_ejection_time: 30s
        max_ejection_percent: 50
```

### Ingress for external gRPC

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: inventory-grpc
  annotations:
    # WITHOUT this, NGINX proxies as HTTP/1.1 and gRPC fails in confusing ways.
    nginx.ingress.kubernetes.io/backend-protocol: "GRPC"
    # Streams need long timeouts; the defaults would kill them.
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
    # Large messages: the default 1m body limit rejects them.
    nginx.ingress.kubernetes.io/proxy-body-size: "16m"
spec:
  ingressClassName: nginx
  tls:
    - hosts: [inventory.acme.com]
      secretName: inventory-tls
  rules:
    - host: inventory.acme.com
      http:
        paths:
          - path: /acme.inventory.v1.InventoryService
            pathType: Prefix
            backend:
              service:
                name: inventory
                port: {number: 50051}
```

### `grpc-gateway`: a JSON facade from the same `.proto`

```protobuf
import "google/api/annotations.proto";

service InventoryService {
  rpc GetItem(GetItemRequest) returns (GetItemResponse) {
    option (google.api.http) = {get: "/v1/items/{sku}"};
  }

  rpc ListItems(ListItemsRequest) returns (ListItemsResponse) {
    option (google.api.http) = {get: "/v1/items"};
  }

  rpc UpdateItem(UpdateItemRequest) returns (UpdateItemResponse) {
    option (google.api.http) = {
      patch: "/v1/items/{item.sku}"
      body: "item"
    };
  }

  rpc ReserveStock(ReserveStockRequest) returns (ReserveStockResponse) {
    option (google.api.http) = {
      post: "/v1/reservations"
      body: "*"
    };
  }

  // Server streaming becomes a chunked JSON response, one object per line.
  rpc WatchStock(WatchStockRequest) returns (stream StockEvent) {
    option (google.api.http) = {get: "/v1/items:watch"};
  }
}
```

```go
package main

// Serving gRPC and the JSON gateway on separate ports.
//
// The gateway is an ordinary http.Handler that translates JSON/REST into gRPC
// calls against the same server, so both surfaces share one implementation,
// one set of interceptors and one authorization policy.
func run(ctx context.Context) error {
	// --- 1. The gRPC server ------------------------------------------------
	lis, err := net.Listen("tcp", ":50051")
	if err != nil {
		return err
	}
	grpcSrv := grpc.NewServer(serverOpts...)
	inventoryv1.RegisterInventoryServiceServer(grpcSrv, svc)
	go grpcSrv.Serve(lis)

	// --- 2. The generated JSON facade --------------------------------------
	mux := runtime.NewServeMux(
		runtime.WithMarshalerOption(runtime.MIMEWildcard, &runtime.JSONPb{
			MarshalOptions: protojson.MarshalOptions{
				// Emit zero values so JSON consumers see a stable shape;
				// protobuf would omit them entirely (chapter 9).
				EmitUnpopulated: true,
				UseProtoNames:   true, // snake_case, matching the .proto
			},
			UnmarshalOptions: protojson.UnmarshalOptions{DiscardUnknown: true},
		}),

		// Forward the headers the gRPC service needs. By default the gateway
		// drops most incoming headers, which silently breaks auth.
		runtime.WithIncomingHeaderMatcher(func(key string) (string, bool) {
			switch strings.ToLower(key) {
			case "authorization", "x-request-id", "traceparent":
				return key, true
			default:
				return runtime.DefaultHeaderMatcher(key)
			}
		}),

		// Map gRPC status codes onto sensible HTTP responses, with the
		// structured details preserved in the body (chapter 22).
		runtime.WithErrorHandler(customErrorHandler),
	)

	if err := inventoryv1.RegisterInventoryServiceHandlerFromEndpoint(
		ctx, mux, "localhost:50051",
		[]grpc.DialOption{grpc.WithTransportCredentials(insecure.NewCredentials())},
	); err != nil {
		return err
	}

	return http.ListenAndServe(":8080", mux)
}
```

### Connect: one handler, three protocols

```go
package main

import (
	"net/http"

	"connectrpc.com/connect"
	"connectrpc.com/grpcreflect"
	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"

	"github.com/acme/apis/gen/go/acme/inventory/v1/inventoryv1connect"
)

func main() {
	mux := http.NewServeMux()

	// ONE registration serves three wire protocols on one port:
	//   - gRPC       (HTTP/2, binary protobuf, real trailers) -> internal services
	//   - gRPC-Web   (browser-compatible framing)             -> SPAs, NO PROXY
	//   - Connect    (HTTP/1.1 + JSON or protobuf)            -> curl, partners
	//
	// That removes the entire translation layer for a new system.
	path, handler := inventoryv1connect.NewInventoryServiceHandler(
		newInventoryServer(),
		connect.WithInterceptors(authInterceptor, loggingInterceptor),
	)
	mux.Handle(path, handler)

	mux.Handle(grpcreflect.NewHandlerV1(
		grpcreflect.NewStaticReflector(inventoryv1connect.InventoryServiceName)))

	// h2c allows cleartext HTTP/2, which is what you want when TLS is
	// terminated by an ingress or a mesh sidecar.
	srv := &http.Server{
		Addr:    ":8080",
		Handler: h2c.NewHandler(mux, &http2.Server{}),
	}
	log.Fatal(srv.ListenAndServe())
}
```

```bash
# The same method, three ways, one port.
grpcurl -plaintext -d '{"sku":"sku_1"}' localhost:8080 acme.inventory.v1.InventoryService/GetItem
curl -X POST localhost:8080/acme.inventory.v1.InventoryService/GetItem \
     -H 'Content-Type: application/json' -d '{"sku":"sku_1"}'
# and a browser client using @connectrpc/connect-web, with no proxy at all.
```

### gRPC-Web without Envoy

```go
import "github.com/improbable-eng/grpc-web/go/grpcweb"

// A Go wrapper doing the gRPC-Web translation in-process, for when adding
// Envoy is not worth it.
//
// Note the hard limitation: gRPC-Web supports unary and SERVER streaming only.
// Client-side and bidirectional streaming are impossible from a browser
// regardless of proxy, because the browser cannot control framing.
wrapped := grpcweb.WrapServer(grpcSrv,
	grpcweb.WithOriginFunc(func(origin string) bool {
		return allowedOrigins[origin] // never blanket-allow in production
	}),
)

http.ListenAndServe(":8080", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
	if wrapped.IsGrpcWebRequest(r) || wrapped.IsAcceptableGrpcCorsRequest(r) {
		wrapped.ServeHTTP(w, r)
		return
	}
	staticFiles.ServeHTTP(w, r)
}))
```

### Verifying that balancing actually works

```bash
# Configuration proves nothing. Scale under load and watch the distribution.
kubectl scale deploy/inventory --replicas=3
ghz --insecure --proto ... --call ... -d '{...}' -c 50 -z 60s \
    dns:///inventory-headless.default.svc.cluster.local:50051 &

# Per-pod request rate should converge to equal shares. If one pod has
# everything, one of the three requirements is missing.
kubectl top pods -l app=inventory
watch 'kubectl exec deploy/prometheus -- \
  promtool query instant http://localhost:9090 \
  "sum by (pod) (rate(grpc_server_handled_total[1m]))"'

# Then scale UP mid-test: without MaxConnectionAge the new pods stay at zero
# indefinitely, which is the failure this whole chapter is about.
kubectl scale deploy/inventory --replicas=6
```

## 6. Advantages, Disadvantages & Trade-offs

**Client-side load balancing**
- *For:* no extra hop, no extra component, lowest latency, works without any infrastructure change.
- *Against:* per-language configuration, limited policy, requires a headless service and `MaxConnectionAge`.

**L7 proxy**
- *For:* rich policy (retries, outlier ejection, canary weights, header routing), clients need no gRPC-specific configuration, one place to change behaviour.
- *Against:* an extra hop, a component to run, tune and monitor, and a place gRPC can silently break if it is misconfigured for HTTP/2.

**Service mesh**
- *For:* everything the proxy gives plus automatic mTLS and uniform observability, with zero application code.
- *Against:* the highest operational cost in the list, a control plane to run, per-pod resource overhead, and a steep debugging learning curve.

**Trade-offs**
- *Client-side vs proxy:* latency and simplicity versus policy richness and language independence. Go-only estates should start client-side.
- *gRPC-Web vs Connect vs gateway:* Connect for new systems, gateway for adding JSON to an existing gRPC service, gRPC-Web only when you already have Envoy.
- *One port vs two:* one simplifies manifests and firewalls; two keeps gRPC on the fast path and lets you bind metrics to a private interface.

## 7. Common Mistakes & Best Practices

- **A `ClusterIP` service with `round_robin`.** DNS returns one virtual IP; there is nothing to balance across. Use headless.
- **`round_robin` without `MaxConnectionAge`.** Clients never re-resolve, so new pods stay cold forever.
- **`MaxConnectionAge` without a grace period.** In-flight RPCs are cut at every rotation — an error spike on a timer.
- **A proxy that speaks HTTP/1.1 upstream.** gRPC breaks entirely; NGINX needs `backend-protocol: "GRPC"`, Envoy needs explicit `http2_protocol_options`.
- **Default proxy timeouts on streaming methods.** Envoy's 15-second route timeout kills every long stream; set `timeout: 0s`.
- **Ingress body-size limits.** The default 1 MiB rejects legitimately large messages.
- **Expecting client or bidirectional streaming from a browser.** gRPC-Web cannot do it, with or without a proxy.
- **Hand-maintaining a JSON facade** alongside the gRPC service. Generate it, or the two will drift.
- **A gateway that drops the `authorization` header.** The default header matcher filters most headers; set an incoming matcher explicitly.
- **Assuming configuration means it works.** Verify by scaling under load and watching per-pod request rate.
- **`preStop` and grace period not budgeted together.** `SIGKILL` arrives mid-drain (chapter 18).

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** Per-pod request rate is the single most useful signal: if it is uneven, load balancing is not working, and the cause is one of the three requirements being absent. For proxy problems, run a server-streaming call through the proxy — if messages arrive in one batch at the end, it is buffering and streaming is broken. `GRPC_GO_LOG_VERBOSITY_LEVEL=99` shows resolver updates and `GOAWAY` frames.
- **Monitoring.** Track request rate per pod (evenness), connection count and age distribution (rotation working), and `GOAWAY` counts. At the edge, track gateway error rates separately from gRPC ones, since a translation failure looks different from a service failure.
- **Security.** TLS terminated at the edge with mTLS internally, or end-to-end TLS with the proxy in passthrough mode. gRPC-Web requires CORS, so set an explicit origin allow-list and never blanket-allow. A gateway is a new attack surface with its own parsing: keep body-size limits and rate limits on it, and remember it can bypass a gRPC-only authorization assumption if headers are not forwarded correctly.
- **Scaling.** The chain that must all work: readiness gates traffic, load balancing distributes it, `MaxConnectionAge` rebalances after scaling, and graceful shutdown drains without dropping. Break any link and autoscaling appears not to work. Verify the whole chain with a scale-up under load, not with configuration review.

## 9. Interview Questions

**Q: Why does a standard Kubernetes `Service` fail to balance gRPC?**
A: Because `kube-proxy` operates at layer 4 and balances connections, while gRPC opens exactly one long-lived HTTP/2 connection and multiplexes everything over it. The backend is chosen once, at connection time, and every subsequent RPC goes to the same pod. The consequences are that scaling up delivers no traffic to new pods, load stays wherever it originally landed, and rolling deploys make the skew worse rather than better. It is structural, not a misconfiguration.

**Q: What are the three ways to fix it?**
A: Client-side load balancing, where the client resolves a headless service and applies `round_robin` itself — lowest latency and nothing extra to run, but every language needs configuring and policy is limited. An L7 proxy such as Envoy or an ingress controller, which terminates HTTP/2 and balances per RPC, giving rich policy at the cost of a hop and a component. Or a service mesh, which is an L7 proxy per pod injected automatically, adding mTLS and uniform observability at the highest operational cost. xDS-direct is an emerging middle path where grpc-go speaks the control-plane protocol itself with no sidecar.

**Q: What three things must be true for client-side `round_robin` to work?**
A: The service config must actually select `round_robin`, since `pick_first` is the default and uses one backend. The resolver must return multiple addresses, which in Kubernetes means a headless service with `clusterIP: None` — a normal `ClusterIP` resolves to a single virtual IP. And the server must set `MaxConnectionAge` with a grace period, because a client resolves DNS once and will otherwise never learn about pods added later. Omitting any one silently reverts to all traffic on one pod.

**Q: Why can't browsers speak gRPC?**
A: Because `fetch` and `XMLHttpRequest` give JavaScript no access to HTTP/2 trailers and no control over framing, and gRPC delivers its terminal status in trailers. gRPC-Web works around it by encoding trailers into the response body, which is why it requires a translating proxy — Envoy's filter or a Go wrapper — and why it supports only unary and server-streaming calls. Client-side and bidirectional streaming are impossible from a browser regardless of what proxy you deploy.

**Q: `grpc-gateway`, Connect or gRPC-Web?**
A: Connect for a new system: one handler serves gRPC, gRPC-Web and JSON over HTTP/1.1 on a single port with no proxy, so browsers, partners and internal services are all covered. `grpc-gateway` when an existing gRPC service needs a JSON edge — it generates a reverse proxy from `google.api.http` annotations on the same `.proto`, so the facade cannot drift from the service. gRPC-Web only when Envoy is already in the path. The property common to all three, and the one that matters, is generating the edge from the same contract rather than maintaining two.

**Q: What must a proxy do to carry gRPC correctly?**
A: Speak HTTP/2 end to end, including upstream — NGINX needs `backend-protocol: "GRPC"` and Envoy needs explicit `http2_protocol_options` on the cluster, or they proxy as HTTP/1.1 and gRPC fails. Preserve trailers, since the status lives there. Not buffer whole responses, or streaming stops streaming. And have timeouts and body-size limits appropriate to gRPC: the default 15-second route timeout kills every long-lived stream and the default 1 MiB body limit rejects legitimately large messages. The quickest verification is a server-streaming call through the proxy — if messages arrive in one batch at the end, it is buffering.

**Q: How do you verify load balancing actually works?**
A: By scaling under load and watching per-pod request rate, not by reviewing configuration. Start a sustained load test against three replicas and confirm the rate converges to equal shares; then scale to six mid-test and confirm the new pods start receiving traffic within roughly `MaxConnectionAge`. If one pod has everything, one of the three requirements is missing. If the original pods keep everything after scaling, `MaxConnectionAge` is absent. Configuration review cannot distinguish those cases; a scale-up under load does it in a minute.

**Q: (Senior) Design the deployment for a gRPC service with internal, browser and partner consumers.**
A: Three surfaces from one `.proto`. Internally, gRPC over a headless service with client-side `round_robin`, `MaxConnectionAge` at thirty minutes with a grace period, and mTLS between services — lowest latency and no extra component, which is the right default for a Go estate. For browsers and partners, a JSON edge generated from the same contract: Connect if I am building new, since it serves gRPC, gRPC-Web and JSON from one handler with no proxy, or `grpc-gateway` if there is an existing gRPC service to front. TLS terminates at the ingress with mTLS behind it, and the edge carries its own rate limits, body-size limits and CORS allow-list, because it is a distinct attack surface. Every service gets correctly asymmetric health probes, a `preStop` hook, and a shutdown budget that fits inside `terminationGracePeriodSeconds`. And I would verify the whole chain — readiness gating, balancing, rebalancing after scale-up, draining without dropped requests — with a scale-up and a rolling deploy under load, because each of those links can be individually correct while the chain is broken.

**Q: (Senior) After migrating to gRPC, autoscaling appears to do nothing. Diagnose.**
A: This is the canonical gRPC deployment failure and it has a short list of causes. First, is the target a `ClusterIP` service? If so, DNS returns one virtual IP, `round_robin` has a single endpoint, and every client is pinned to whichever pod `kube-proxy` chose — the fix is a headless service. Second, is `round_robin` actually configured? `pick_first` is the default and uses one backend even when DNS returns ten addresses; channelz showing one subchannel against a replicated target settles it immediately. Third, is `MaxConnectionAge` set? Without it, clients that connected before the scale-up never re-resolve, so the new pods stay at zero indefinitely — this is the case that specifically presents as "autoscaling does nothing", because the metric that triggers scaling never improves. Fourth, if there is a proxy in the path, is it doing the balancing and is its endpoint discovery re-resolving? Envoy with a `STRICT_DNS` cluster refreshes; a static endpoint list does not. I would confirm with per-pod request rate during a scale-up under load, which distinguishes all four in one experiment.

**Q: (Senior) What breaks when a proxy is inserted in front of a gRPC service?**
A: Several things, and they usually present as application bugs rather than proxy bugs, which is what makes them expensive. If the proxy speaks HTTP/1.1 upstream, gRPC fails entirely — the fix is one annotation or one cluster option, but the error messages point nowhere useful. If it buffers responses, streaming silently stops streaming: messages arrive in one batch at the end, so a live feed becomes a delayed dump and nobody sees an error. If it strips or mishandles trailers, statuses are lost and failed calls can report success. Default timeouts kill long-lived streams at fifteen or sixty seconds, which looks like a random `Unavailable`. Body-size limits reject large messages with a proxy-generated error that does not resemble `ResourceExhausted`. And connection-level settings interact: a proxy idle timeout shorter than the client's keepalive interval drops connections the client believes are healthy. The verification I always run is a server-streaming call and a large unary call through the proxy, plus a keepalive interaction check, because those three cover most of the list.

## 10. Quick Revision & Cheat Sheet

```yaml
# Headless service — the prerequisite for client-side balancing
spec: {clusterIP: None, selector: {app: inventory}, ports: [{port: 50051}]}
```

```go
// Client: all THREE are required
grpc.NewClient("dns:///inventory-headless.default.svc.cluster.local:50051",
    grpc.WithDefaultServiceConfig(`{"loadBalancingConfig":[{"round_robin":{}}]}`))

// Server: without this, new pods stay cold
grpc.KeepaliveParams(keepalive.ServerParameters{
    MaxConnectionAge: 30 * time.Minute, MaxConnectionAgeGrace: 30 * time.Second})
```

| Need | Choice |
|---|---|
| Go-only internal traffic | Client-side `round_robin` + headless + `MaxConnectionAge` |
| Polyglot clients, rich policy | L7 proxy (Envoy) |
| Zero-trust mTLS at scale | Service mesh, or xDS-direct |
| Browser client, new system | **Connect** |
| Browser client, existing gRPC | gRPC-Web + Envoy filter |
| JSON for partners/curl | `grpc-gateway` from the same `.proto` |

| Proxy requirement | Setting |
|---|---|
| HTTP/2 upstream | NGINX `backend-protocol: "GRPC"`; Envoy `http2_protocol_options` |
| Streams survive | `timeout: 0s` / long `proxy-read-timeout` |
| Large messages | Raise the body-size limit |
| Browsers | Envoy `grpc_web` filter + CORS allow-list |

**Flash cards**
- **Why does `ClusterIP` fail?** → L4 balances connections; gRPC opens one.
- **Three requirements for `round_robin`?** → Config + headless service + `MaxConnectionAge`.
- **Grace period?** → Required, or rotation cuts in-flight RPCs.
- **Browsers and gRPC?** → Impossible directly; no trailer access. Connect or gRPC-Web.
- **gRPC-Web streaming?** → Server streaming only. Never client or bidi.
- **JSON edge?** → Generate it from the same `.proto`. Never hand-maintain.
- **Proving balancing works?** → Scale under load and watch per-pod rate.

## 11. Hands-On Exercises & Mini Project

- [ ] Deploy three replicas behind a `ClusterIP` service with `round_robin` configured and measure per-pod distribution. Switch to headless and measure again.
- [ ] With headless plus `round_robin` but no `MaxConnectionAge`, scale from three to six under load and watch the new pods stay at zero. Add it and watch them fill.
- [ ] Set `MaxConnectionAge: 30s` without a grace period and observe RPCs failing every thirty seconds. Add the grace and watch them drain.
- [ ] Put NGINX ingress in front without `backend-protocol: "GRPC"` and read the failure. Add it.
- [ ] Run a server-streaming call through a proxy configured to buffer, and observe messages arriving in one batch.
- [ ] Generate a `grpc-gateway` facade, verify `curl` and `grpcurl` return the same data, then break the `.proto` and confirm both break together.
- [ ] Build a Connect server and call the same method three ways — `grpcurl`, `curl` with JSON, and a browser client — on one port.
- [ ] Try a client-streaming call from a browser over gRPC-Web and read the error. Explain why no proxy can fix it.

### Mini Project — "Production Deployment"

**Goal.** Deploy a gRPC service that balances correctly, survives rolling deploys, autoscales, and serves browsers and partners — and prove each property rather than assuming it.

**Requirements.**
1. A headless service, client-side `round_robin`, and `MaxConnectionAge` with grace, plus a load test proving even distribution across three replicas.
2. A scale-up under sustained load from three to six replicas, with a chart showing per-pod request rate converging within roughly `MaxConnectionAge`.
3. A rolling deploy under load with zero failed requests, using correctly asymmetric probes, a `preStop` hook, and a shutdown budget inside `terminationGracePeriodSeconds`.
4. An Envoy deployment as an alternative path, with per-RPC balancing, outlier ejection and a gRPC-aware retry policy, compared against client-side balancing on latency and distribution.
5. A JSON edge generated from the same `.proto` — `grpc-gateway` or Connect — with header forwarding for auth and trace context, and a test asserting both surfaces return equivalent data.
6. A browser client calling a unary and a server-streaming method, and a documented explanation of why client streaming is unavailable.
7. A verification script exercising: even distribution, rebalancing after scale-up, zero-drop rolling deploy, streaming through the proxy, and a large message through the ingress.

**Extensions.**
- Migrate the internal path to `xds:///` targets with a control plane, and compare latency against both the sidecar and client-side models.
- Add canary routing by header at the L7 proxy and demonstrate a 5% traffic split without any client change.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *HTTP/2 Under gRPC* (why one connection changes everything), *Deadlines, Retries, Service Config & Load Balancing* (`round_robin` and service config), *Graceful Shutdown* (`MaxConnectionAge` and drains), *Reflection, grpcurl & Health Checks* (probes that gate traffic), *gRPC vs REST, GraphQL & Message Queues* (why a JSON edge exists at all).

- **gRPC Blog — gRPC Load Balancing** — gRPC Authors · *Intermediate* · the canonical explanation of proxy versus client-side balancing and why L4 fails. The single most relevant reference for this chapter. <https://grpc.io/blog/grpc-load-balancing/>
- **Kubernetes blog — gRPC Load Balancing on Kubernetes without Tears** — Buoyant / Kubernetes · *Intermediate* · the `ClusterIP` failure mode explained end to end, with the available remedies. <https://kubernetes.io/blog/2018/11/07/grpc-load-balancing-on-kubernetes-without-tears/>
- **Envoy — gRPC support and gRPC-Web filter** — Envoy Proxy · *Advanced* · route timeouts, HTTP/2 upstream options, retry policy on gRPC status codes, and browser translation. <https://www.envoyproxy.io/docs/envoy/latest/start/sandboxes/grpc_bridge>
- **grpc-gateway documentation** — grpc-ecosystem (open source) · *Intermediate* · `google.api.http` annotations, marshaller options, header matchers and error handling. <https://grpc-ecosystem.github.io/grpc-gateway/>
- **Connect — introduction and Go docs** — Buf (open source) · *Intermediate* · one handler serving gRPC, gRPC-Web and JSON; the strongest option for new systems. <https://connectrpc.com/docs/introduction>
- **gRPC-Web specification** — gRPC Authors · *Advanced* · exactly what changes for browsers and why client and bidirectional streaming are impossible. <https://github.com/grpc/grpc-web>
- **gRFC A27 / xDS in grpc-go** — gRPC Authors · *Advanced* · consuming a control plane directly with `xds:///` targets, no sidecar required. <https://github.com/grpc/grpc-go/tree/master/xds>
- **NGINX Ingress — gRPC annotations** — Kubernetes ingress-nginx · *Intermediate* · `backend-protocol: "GRPC"`, timeouts and body-size limits; the settings whose absence breaks gRPC confusingly. <https://kubernetes.github.io/ingress-nginx/examples/grpc/>

---

*gRPC with Go Handbook — chapter 29.*
