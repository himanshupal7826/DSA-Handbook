# 11 · Ingress & Gateway API

> **In one line:** Ingress (and its successor, the Gateway API) turns one cloud load balancer into an L7 HTTP router that fans host/path traffic and terminates TLS across many backend Services.

---

## 1. Overview

A `type: LoadBalancer` Service gives each app its own external L4 load balancer — expensive, and blind to HTTP. Once you have more than a couple of public HTTP apps you want **one entrypoint** that inspects the request's host and path and routes accordingly, terminates TLS centrally, and does it all behind a single IP. That is **Ingress**.

Crucially, **Ingress is two things**: the **Ingress resource** (a declarative set of routing rules you write) and the **Ingress controller** (a real proxy — NGINX, HAProxy, Traefik, Envoy, or a cloud ALB controller — that reads those rules and actually moves packets). The resource does *nothing* on its own; without a controller installed, an Ingress object is inert YAML.

Ingress's API stalled at L7-HTTP-only with vendor behavior smuggled into annotations. The **Gateway API** is the CNCF successor: a richer, role-oriented, portable, extensible replacement (GA since 1.0 in late 2023) that models L4 and L7, splits responsibilities between infra and app teams, and standardizes things Ingress could only express via non-portable annotations.

## 2. Core Concepts

- **Ingress resource** — declarative host/path → Service:port rules plus TLS config. Namespaced.
- **Ingress controller** — the proxy that watches Ingress resources and programs itself. You must install one; it is not built in.
- **IngressClass** — selects *which* controller handles a resource when several exist (`ingressClassName: nginx`).
- **Host & path routing** — match on `Host:` header and URL path; `pathType` is `Prefix`, `Exact`, or `ImplementationSpecific`.
- **TLS termination** — the controller holds the certificate (from a Secret) and decrypts at the edge; backend hop is usually plain HTTP inside the cluster.
- **Default backend** — where unmatched requests go (often a 404 page).
- **Why Ingress ≠ Service** — a Service is L4 (IP:port, no HTTP awareness); Ingress is L7 (reads host/path/headers). Ingress *routes to* Services.
- **Gateway API objects** — `GatewayClass` (infra), `Gateway` (a listener/LB), `HTTPRoute`/`TCPRoute`/`GRPCRoute` (routing rules), attached by reference.
- **Role separation** — Gateway API splits the *cluster operator* (Gateway) from the *app developer* (Route), which Ingress conflated into one object.

## 3. Syntax & Examples

Minimal single-service Ingress:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web
spec:
  ingressClassName: nginx
  rules:
    - http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web
                port: { number: 80 }
```

Host + path fan-out with TLS:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: shop
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
spec:
  ingressClassName: nginx
  tls:
    - hosts: [shop.example.com]
      secretName: shop-tls        # kubernetes.io/tls Secret: tls.crt + tls.key
  rules:
    - host: shop.example.com
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend: { service: { name: api,  port: { number: 8080 } } }
          - path: /
            pathType: Prefix
            backend: { service: { name: web,  port: { number: 80 } } }
```

The same intent in the **Gateway API** — Gateway (operator) + HTTPRoute (developer):

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata: { name: prod-gw }
spec:
  gatewayClassName: envoy
  listeners:
    - name: https
      protocol: HTTPS
      port: 443
      tls:
        mode: Terminate
        certificateRefs: [{ name: shop-tls }]
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: { name: shop }
spec:
  parentRefs: [{ name: prod-gw }]
  hostnames: ["shop.example.com"]
  rules:
    - matches: [{ path: { type: PathPrefix, value: /api } }]
      backendRefs: [{ name: api, port: 8080 }]
    - matches: [{ path: { type: PathPrefix, value: / } }]
      backendRefs: [{ name: web, port: 80 }]
```

## 4. Worked Example

Install a controller, apply the shop Ingress, and route two hosts through one IP.

```bash
# 1. Install the NGINX ingress controller (creates one LoadBalancer Service)
helm install ingress-nginx ingress-nginx/ingress-nginx -n ingress-nginx --create-namespace
kubectl get svc -n ingress-nginx ingress-nginx-controller
```

```text
NAME                       TYPE           EXTERNAL-IP     PORT(S)
ingress-nginx-controller   LoadBalancer   203.0.113.10    80:31234/TCP,443:30567/TCP
```

```bash
# 2. Apply the shop Ingress and TLS secret, then test path routing
kubectl apply -f shop-ingress.yaml
curl -H "Host: shop.example.com" https://203.0.113.10/api/health --resolve shop.example.com:443:203.0.113.10 -k
curl -H "Host: shop.example.com" https://203.0.113.10/          --resolve shop.example.com:443:203.0.113.10 -k
```

```text
# /api  -> api Service (8080)
{"status":"ok","service":"api"}

# /     -> web Service (80)
<!DOCTYPE html> ... Welcome ...
```

One external IP (`203.0.113.10`), one billed LB, TLS terminated once, and traffic split by path to two different Services — exactly what N separate LoadBalancer Services could not do.

## 5. Under the Hood

The controller runs as pods behind **one** cloud LoadBalancer. It watches the API for Ingress/Gateway/Route + Secret objects and rewrites its own proxy config (an `nginx.conf`, or Envoy xDS) on every change. TLS is terminated at these pods; the decrypted request is matched by Host/path and proxied to the target Service's endpoints (often bypassing kube-proxy and hitting pod IPs directly).

```svg
<svg viewBox="0 0 780 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>

  <!-- internet -->
  <rect x="20" y="150" width="110" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="75" y="176" text-anchor="middle" fill="#1e293b">Internet</text>
  <text x="75" y="194" text-anchor="middle" fill="#64748b" font-size="11">HTTPS</text>

  <!-- single LB -->
  <rect x="180" y="145" width="120" height="70" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="240" y="170" text-anchor="middle" fill="#1e293b">Cloud LB</text>
  <text x="240" y="188" text-anchor="middle" fill="#64748b" font-size="11">one IP</text>
  <text x="240" y="204" text-anchor="middle" fill="#64748b" font-size="11">203.0.113.10</text>

  <!-- controller -->
  <rect x="350" y="120" width="150" height="120" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="425" y="146" text-anchor="middle" fill="#1e293b">Ingress</text>
  <text x="425" y="163" text-anchor="middle" fill="#1e293b">Controller</text>
  <text x="425" y="184" text-anchor="middle" fill="#64748b" font-size="11">TLS terminate</text>
  <text x="425" y="200" text-anchor="middle" fill="#64748b" font-size="11">match Host + path</text>
  <text x="425" y="222" text-anchor="middle" fill="#64748b" font-size="11">(NGINX / Envoy)</text>

  <!-- services -->
  <rect x="590" y="40" width="170" height="56" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="675" y="63" text-anchor="middle" fill="#1e293b">Service: web</text>
  <text x="675" y="81" text-anchor="middle" fill="#64748b" font-size="11">path /</text>

  <rect x="590" y="160" width="170" height="56" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="675" y="183" text-anchor="middle" fill="#1e293b">Service: api</text>
  <text x="675" y="201" text-anchor="middle" fill="#64748b" font-size="11">path /api</text>

  <rect x="590" y="280" width="170" height="56" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="675" y="303" text-anchor="middle" fill="#1e293b">Service: admin</text>
  <text x="675" y="321" text-anchor="middle" fill="#64748b" font-size="11">host admin.*</text>

  <!-- arrows -->
  <line x1="130" y1="180" x2="176" y2="180" stroke="#475569" stroke-width="1.5" marker-end="url(#a)"/>
  <line x1="300" y1="180" x2="346" y2="180" stroke="#475569" stroke-width="1.5" marker-end="url(#a)"/>
  <line x1="500" y1="150" x2="586" y2="70" stroke="#475569" stroke-width="1.5" marker-end="url(#a)"/>
  <line x1="500" y1="180" x2="586" y2="188" stroke="#475569" stroke-width="1.5" marker-end="url(#a)"/>
  <line x1="500" y1="215" x2="586" y2="305" stroke="#475569" stroke-width="1.5" marker-end="url(#a)"/>

  <!-- config watch -->
  <rect x="350" y="290" width="150" height="56" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="425" y="313" text-anchor="middle" fill="#1e293b" font-size="12">API server</text>
  <text x="425" y="330" text-anchor="middle" fill="#64748b" font-size="10">Ingress + Secrets</text>
  <line x1="425" y1="290" x2="425" y2="242" stroke="#475569" stroke-width="1.2" stroke-dasharray="3 3" marker-end="url(#a)"/>
  <text x="470" y="270" text-anchor="middle" fill="#64748b" font-size="10">watch</text>
</svg>
```

Because the controller re-templates config on every object change, a bad annotation or an invalid cert can make it reject the *whole* new config and keep serving the last-good one — great for safety, confusing when your change "does nothing." Check the controller logs, not just the resource status.

## 6. Variations & Trade-offs

| | Service (LoadBalancer) | Ingress | Gateway API |
|---|---|---|---|
| Layer | L4 (TCP/UDP) | L7 HTTP(S) | L4 + L7 |
| Routing | none (port only) | host + path | host/path/header/method/weight |
| TLS | passthrough only | terminate at edge | terminate/passthrough, per-listener |
| Cost | 1 LB per Service | 1 LB shared | 1 LB per Gateway, shared |
| Extensibility | n/a | vendor **annotations** (non-portable) | typed fields + policy attachment |
| Roles | one owner | one owner | operator (Gateway) vs dev (Route) |
| Status | stable, frozen | stable, feature-frozen | GA, actively evolving |

| Controller | Engine | Notable for |
|-----------|--------|-------------|
| ingress-nginx | NGINX | ubiquitous default, huge annotation set |
| Traefik | Traefik | auto TLS (ACME), CRD-native |
| Envoy Gateway / Contour | Envoy | Gateway API first-class, gRPC |
| Cloud (ALB/GKE) | cloud LB | native cloud integration, offloads to managed LB |

**Trade-off:** Ingress is universally supported and simple but expresses anything beyond host/path via **controller-specific annotations**, so manifests aren't portable between NGINX and Traefik. Gateway API makes those features typed and portable but is a newer, larger API with a steeper learning curve. New platforms should start on Gateway API; existing Ingress keeps working.

## 7. Production / Performance Notes

- **Run the controller HA.** It's your single front door — 2+ replicas, PodDisruptionBudget, spread across zones/nodes. If all controller pods die, every route is down.
- **Automate certs with cert-manager.** Manual TLS Secrets rot; cert-manager issues/renews Let's Encrypt certs and updates the Secret the controller watches.
- **Mind path semantics.** `pathType: Prefix` `/api` also matches `/api/`; `Exact` doesn't. Rewrites (`nginx.ingress.kubernetes.io/rewrite-target`) change the path sent to the backend — a classic source of 404s.
- **Set body-size, timeout, and rate limits.** Defaults (e.g. NGINX 1 MB body) silently 413 large uploads; tune via annotations/config.
- **TLS usually terminates at the edge**, backend hop is plaintext inside the cluster; for end-to-end encryption use `ssl-passthrough` or a service mesh (topic 13).
- **One Gateway, many Routes.** Gateway API lets many namespaces attach HTTPRoutes to a shared Gateway, so app teams self-serve routes without touching LB/TLS the platform team owns.

## 8. Common Mistakes

1. ⚠️ **Applying an Ingress with no controller installed.** Nothing routes and there's no error. Fix: install a controller and set `ingressClassName`.
2. ⚠️ **Missing/empty `ingressClassName` when multiple controllers exist.** The resource is ignored or grabbed by the wrong one. Fix: set it explicitly.
3. ⚠️ **Backend Service in a different namespace.** Ingress rules resolve Services *in the same namespace only*. Fix: put the Ingress in the backend's namespace.
4. ⚠️ **Wrong `pathType` or rewrite target → 404s.** Fix: understand Prefix vs Exact and test the exact backend path after rewrite.
5. ⚠️ **TLS Secret in the wrong namespace or wrong type.** Must be `kubernetes.io/tls` in the Ingress's namespace. Fix: `kubectl create secret tls` in the right place.
6. ⚠️ **Treating Ingress as L4.** It can't route raw TCP/UDP or arbitrary ports. Fix: use a LoadBalancer Service or Gateway API `TCPRoute` for non-HTTP.
7. ⚠️ **Relying on portable behavior from annotations.** `nginx.ingress.*` annotations mean nothing to Traefik. Fix: use Gateway API for portable advanced routing.
8. ⚠️ **Single controller replica.** One front door SPOF. Fix: run it HA with a PDB.

## 9. Interview Questions

**Q: What is the difference between an Ingress resource and an Ingress controller?**
A: The resource is declarative routing YAML; it does nothing by itself. The controller is a real proxy (NGINX/Envoy/etc.) running in the cluster that watches Ingress resources and programs itself to actually route traffic. No controller, no routing.

**Q: Why do you need Ingress if you already have Services?**
A: A Service is L4 — it knows IP:port, not HTTP. Ingress is L7: it inspects Host header and URL path to route many hostnames/paths through one IP and terminate TLS centrally, then forwards to the appropriate Service. Ingress routes *to* Services.

**Q: How does TLS termination work with Ingress?**
A: You put the cert/key in a `kubernetes.io/tls` Secret and reference it in `spec.tls`. The controller loads it, terminates TLS at the edge pods, and forwards the decrypted request (usually plain HTTP) to the backend. For end-to-end encryption you use passthrough or a mesh.

**Q: What does IngressClass do?**
A: It selects which controller handles a given Ingress when multiple controllers run in the cluster. `ingressClassName: nginx` binds the resource to the NGINX controller; without it the resource may be ignored or claimed by the default.

**Q: Why was the Gateway API created if Ingress works?**
A: Ingress froze as HTTP-only and pushed every advanced feature into vendor-specific annotations, making manifests non-portable and conflating operator and developer concerns in one object. Gateway API is a typed, extensible, role-separated, portable successor covering L4 and L7 — GatewayClass/Gateway (infra) and HTTPRoute/TCPRoute/etc. (app).

**Q: Explain the role separation in the Gateway API.** *(senior)*
A: The cluster operator owns the `GatewayClass` and `Gateway` (the LB, listeners, ports, TLS). App developers own `HTTPRoute`/`GRPCRoute` objects in their own namespaces and attach them to the shared Gateway via `parentRefs`. This lets platform teams control the edge while dev teams self-serve routes — impossible with Ingress's single object.

**Q: An Ingress applied cleanly but traffic 404s. How do you debug?** *(senior)*
A: Check a controller is installed and matches the `ingressClassName`; check the backend Service exists in the *same namespace* and has non-empty endpoints; verify pathType/rewrite semantics; inspect the controller pod logs (it may have rejected the new config and kept the old one); confirm the Host header matches a rule.

**Q: Can Ingress load-balance raw TCP or gRPC streams?**
A: Standard Ingress is HTTP(S) only. Some controllers expose TCP/UDP via extra ConfigMaps, and gRPC works over HTTP/2 with annotations, but it's non-portable. The clean answer is Gateway API's `TCPRoute`/`GRPCRoute` or a LoadBalancer Service.

**Q: How do you avoid one cloud load balancer per public app?** *(senior)*
A: Front all HTTP apps with a single Ingress/Gateway controller behind one LoadBalancer, then route by host/path to many ClusterIP Services. One billed LB, one IP, central TLS — versus N LoadBalancer Services costing N LBs.

**Q: Where does cert-manager fit?**
A: It's a controller that automatically issues and renews TLS certificates (e.g. via Let's Encrypt/ACME) and writes them into the TLS Secret the Ingress/Gateway references, so certs rotate without manual work or downtime.

**Q: What happens if a single Ingress annotation is invalid?**
A: NGINX-style controllers template one config for all Ingresses; an invalid entry can cause the controller to reject the whole new config and keep serving the last valid one. Your change appears to "do nothing" — the signal is in the controller logs, not the resource status.

## 10. Practice

- [ ] Install an ingress controller and expose two Services under different paths of one host.
- [ ] Add TLS with a self-signed Secret and verify the edge terminates HTTPS.
- [ ] Route two hostnames (`a.example.com`, `b.example.com`) to different Services through one IP.
- [ ] Reproduce a rewrite-target 404, then fix the path handling.
- [ ] Re-express the same routing with a Gateway + HTTPRoute and compare portability.

## 11. Cheat Sheet

> [!TIP]
> **Ingress = L7 HTTP router in front of Services**, made of a *resource* (rules) + a *controller* (the actual proxy — install one or nothing routes). One LB, many host/path routes, central TLS termination via a `kubernetes.io/tls` Secret.
> **Key fields:** `ingressClassName` (which controller) · `rules[].host` + `paths[].pathType` (Prefix/Exact) · `tls[].secretName`.
> **Ingress ≠ Service:** Service is L4 (IP:port); Ingress reads host/path/headers and routes to Services.
> **Gateway API** = typed, portable, role-split successor (GA 1.0): GatewayClass/Gateway (operator) + HTTPRoute/TCPRoute/GRPCRoute (developer). Use it for advanced/portable routing; Ingress for simple cases.
> **Gotchas:** same-namespace backends only · run controller HA · automate certs (cert-manager) · annotations aren't portable.

**References:** Kubernetes docs — Ingress, IngressClass; Gateway API project (gateway-api.sigs.k8s.io); ingress-nginx docs; cert-manager docs

---

*Kubernetes Handbook — topic 11.*
