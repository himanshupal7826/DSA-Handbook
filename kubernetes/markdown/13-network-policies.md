# 13 · Network Policies & Service Mesh

> **In one line:** NetworkPolicies are the pod-level firewall (L3/L4 default-deny); a service mesh adds L7 identity, mTLS, and observability on top.

---

## 1. Overview

By default, Kubernetes networking is **flat and fully open**: every pod can reach every other pod on every port, across all namespaces. That is fine for a demo and terrible for production — a single compromised pod can talk to your database, your payment service, and the cloud metadata endpoint. **NetworkPolicy** is the built-in object that turns that open mesh into a segmented one.

A NetworkPolicy is a **label-selected allow-list** enforced at L3/L4 (IP + port). It never *blocks* by itself — instead, the moment any policy selects a pod, that pod flips to **default-deny** for the direction(s) named, and only the traffic you explicitly allow gets through. You reach for it whenever you need tenant isolation, PCI/SOC2 segmentation, or a blast-radius limit around sensitive workloads.

NetworkPolicy stops at L4 — it cannot say "allow `GET /health` but deny `POST /admin`", cannot verify *who* the caller is cryptographically, and gives you no request-level telemetry. That is where a **service mesh** (Istio, Linkerd, Cilium's mesh) comes in: a sidecar or per-node proxy that issues each workload a SPIFFE identity, wraps every call in **mTLS**, and enforces **L7 authorization** while emitting golden-signal metrics, distributed traces, and access logs for free.

Think of them as complementary layers: **NetworkPolicy = the network firewall, mesh = the identity-aware application proxy.** Serious clusters run both.

## 2. Core Concepts

- **Default-open, then default-deny** — with zero policies everything is allowed; once a pod is selected by *any* policy, all non-matching traffic in that direction is dropped.
- **`podSelector`** — chooses which pods the policy *applies to*. An empty selector `{}` selects **every pod in the namespace** — the idiom for a namespace-wide default-deny.
- **`policyTypes: [Ingress, Egress]`** — you must list a direction for its rules to take effect; omitting `Egress` leaves egress wide open even if you wrote egress rules elsewhere.
- **Ingress vs egress rules** — `from:` blocks gate inbound; `to:` blocks gate outbound. Each block combines `podSelector`, `namespaceSelector`, and `ipBlock` peers with `ports`.
- **Selector AND vs OR** — inside one `from` element, `namespaceSelector` **AND** `podSelector` must both match; as separate list elements they are **OR**ed. This trips everyone up.
- **CNI enforcement** — the API object is inert on its own; a **policy-capable CNI** (Calico, Cilium, Antrea, Weave) must translate it into iptables/eBPF rules. Flannel alone silently ignores NetworkPolicy.
- **mTLS** — mesh sidecars present X.509 certs bound to a workload identity; peers authenticate each other and encrypt in transit, independent of IP.
- **L7 authorization** — mesh policy expresses "service A may call `POST /orders` on service B", something NetworkPolicy fundamentally cannot.
- **Observability for free** — because every request transits a proxy, the mesh exports RED metrics (rate/error/duration), traces, and a live service dependency graph without app changes.

## 3. Syntax & Examples

**Namespace-wide default-deny (the foundation):**

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: payments
spec:
  podSelector: {}          # selects EVERY pod in the namespace
  policyTypes: [Ingress, Egress]   # deny both directions; no rules = allow nothing
```

**Allow only the frontend to reach the API on 8080:**

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: api-allow-frontend, namespace: payments}
spec:
  podSelector: {matchLabels: {app: api}}
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector: {matchLabels: {app: frontend}}
      ports:
        - {protocol: TCP, port: 8080}
```

**Egress: let the API reach DNS and Postgres, nothing else:**

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: api-egress, namespace: payments}
spec:
  podSelector: {matchLabels: {app: api}}
  policyTypes: [Egress]
  egress:
    - to: [{namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: kube-system}}}]
      ports: [{protocol: UDP, port: 53}, {protocol: TCP, port: 53}]  # DNS
    - to: [{podSelector: {matchLabels: {app: postgres}}}]
      ports: [{protocol: TCP, port: 5432}]
```

**Istio: strict mTLS + L7 authorization:**

```yaml
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata: {name: default, namespace: payments}
spec:
  mtls: {mode: STRICT}          # reject any plaintext into the mesh
---
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata: {name: api-authz, namespace: payments}
spec:
  selector: {matchLabels: {app: api}}
  action: ALLOW
  rules:
    - from: [{source: {principals: ["cluster.local/ns/payments/sa/frontend"]}}]
      to:   [{operation: {methods: ["GET","POST"], paths: ["/v1/*"]}}]
```

## 4. Worked Example

Goal: lock down a 3-tier app (`frontend → api → postgres`) in namespace `payments` so that only the intended hops work.

```bash
kubectl create ns payments
kubectl label ns kube-system kubernetes.io/metadata.name=kube-system --overwrite
# deploy frontend, api, postgres (labels app=frontend/api/postgres) ...

# 1) Apply namespace default-deny, then the three allow policies above
kubectl apply -f default-deny-all.yaml -f api-allow-frontend.yaml \
              -f api-egress.yaml -f postgres-allow-api.yaml

# 2) Probe from an unauthorized pod (a random debug shell)
kubectl -n payments run probe --image=nicolaka/netshoot --rm -it -- \
  curl -m 3 http://api:8080/healthz
```

**Result:**

```text
# From an UNlabeled probe pod → blocked (connection times out, no RST):
curl: (28) Connection timed out after 3001 ms          # ✅ default-deny working

# From the frontend pod → allowed:
$ kubectl -n payments exec deploy/frontend -- curl -s api:8080/healthz
ok

# api reaching an unlisted host → blocked by egress policy:
$ kubectl -n payments exec deploy/api -- curl -m 3 https://example.com
curl: (28) Connection timed out                        # ✅ egress locked down

# api → postgres:5432 → allowed
$ kubectl -n payments exec deploy/api -- nc -zv postgres 5432
Connection to postgres 5432 port [tcp/postgresql] succeeded!
```

The **time-out (not connection-refused)** is the signature of a NetworkPolicy drop: packets are silently discarded, so the client never sees a TCP RST.

## 5. Under the Hood

The API object is just data in etcd. The **CNI's policy agent** (a per-node DaemonSet) watches Pods, Namespaces, and NetworkPolicies, resolves label selectors to concrete pod IPs, and programs the datapath — legacy CNIs render **iptables** chains, modern ones (Cilium, Calico eBPF) compile to **eBPF** maps keyed by identity. A service mesh then interposes a **sidecar proxy** (Envoy) in each pod; iptables redirect rules capture all traffic into the proxy, which does the mTLS handshake and L7 checks before forwarding to localhost.

```svg
<svg viewBox="0 0 760 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#475569"/>
    </marker>
    <marker id="ax" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#b91c1c"/>
    </marker>
  </defs>
  <text x="380" y="22" text-anchor="middle" fill="#1e293b" font-weight="700">Two enforcement layers on the pod path</text>

  <!-- frontend -->
  <rect x="30" y="70" width="150" height="90" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="105" y="95" text-anchor="middle" fill="#1e293b" font-weight="600">frontend pod</text>
  <rect x="48" y="108" width="114" height="34" rx="6" fill="#ecfdf5" stroke="#059669"/>
  <text x="105" y="130" text-anchor="middle" fill="#1e293b" font-size="11">Envoy sidecar</text>

  <!-- api -->
  <rect x="300" y="70" width="150" height="90" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="375" y="95" text-anchor="middle" fill="#1e293b" font-weight="600">api pod</text>
  <rect x="318" y="108" width="114" height="34" rx="6" fill="#ecfdf5" stroke="#059669"/>
  <text x="375" y="130" text-anchor="middle" fill="#1e293b" font-size="11">Envoy sidecar</text>

  <!-- postgres -->
  <rect x="580" y="70" width="150" height="90" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="655" y="120" text-anchor="middle" fill="#1e293b" font-weight="600">postgres</text>

  <!-- allowed path -->
  <line x1="180" y1="125" x2="298" y2="125" stroke="#475569" stroke-width="2" marker-end="url(#a)"/>
  <text x="239" y="116" text-anchor="middle" fill="#059669" font-size="11">mTLS + L7 ✓</text>
  <line x1="450" y1="125" x2="578" y2="125" stroke="#475569" stroke-width="2" marker-end="url(#a)"/>
  <text x="514" y="116" text-anchor="middle" fill="#059669" font-size="11">:5432 ✓</text>

  <!-- blocked probe -->
  <rect x="300" y="245" width="150" height="60" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="375" y="270" text-anchor="middle" fill="#1e293b" font-size="11">unlabeled probe</text>
  <text x="375" y="288" text-anchor="middle" fill="#64748b" font-size="11">no matching policy</text>
  <line x1="375" y1="245" x2="375" y2="164" stroke="#b91c1c" stroke-width="2" stroke-dasharray="5 4" marker-end="url(#ax)"/>
  <text x="470" y="205" text-anchor="middle" fill="#b91c1c" font-size="11">dropped (timeout)</text>

  <!-- layers legend -->
  <rect x="30" y="245" width="230" height="60" rx="8" fill="none" stroke="#64748b" stroke-dasharray="3 3"/>
  <text x="145" y="268" text-anchor="middle" fill="#475569" font-size="11">L3/L4: NetworkPolicy (CNI/eBPF)</text>
  <text x="145" y="288" text-anchor="middle" fill="#475569" font-size="11">L7: mesh identity + authz</text>
</svg>
```

## 6. Variations & Trade-offs

| Layer | Enforces | Identity model | Encryption | Observability | Cost |
|-------|----------|----------------|------------|---------------|------|
| **NetworkPolicy** | L3/L4 (IP/port) | pod labels → IPs | none | none | near-zero (in CNI) |
| **Cilium eBPF policy** | L3–L7 (HTTP/DNS/Kafka) | pod identity | optional WireGuard | Hubble flow logs | low (kernel eBPF) |
| **Istio** | L7 (HTTP/gRPC/mTLS) | SPIFFE / SA | mTLS STRICT | rich (Envoy) | high (sidecar CPU/mem/latency) |
| **Linkerd** | L7 + mTLS | SPIFFE / SA | mTLS by default | good, lightweight | moderate (micro-proxy) |

NetworkPolicy is cheap and universal but coarse and IP-blind (useless for encrypted intent or L7). A full mesh gives cryptographic identity and L7 control but adds a sidecar per pod — real CPU, memory, and per-hop latency, plus operational weight (cert rotation, control-plane upgrades). Many teams land on **Cilium**, which does policy *and* an ambient/eBPF mesh without per-pod sidecars, or on **Istio ambient mode** to drop the sidecar tax. Choose the lightest layer that meets your compliance and control needs.

## 7. Production / Performance Notes

- **Always ship a default-deny per namespace first**, then add allow policies — the reverse (allow-list without a deny baseline) leaves everything open.
- **Never forget DNS egress.** A default-deny-egress policy silently breaks name resolution; explicitly allow UDP/TCP 53 to `kube-system` or every request fails with confusing timeouts.
- **Verify your CNI enforces policy.** On EKS the Amazon VPC CNI needs the network-policy add-on enabled; plain Flannel ignores policies entirely — test with a probe pod, don't assume.
- **Label namespaces** (`kubernetes.io/metadata.name` is auto-applied in modern clusters) so `namespaceSelector` works; cross-namespace rules need both ns and pod selectors.
- **Mesh sidecar cost is real:** budget ~50–100m CPU and ~50–100 MiB per sidecar and 1–3 ms added p50 latency per hop. At thousands of pods this dominates; evaluate ambient/eBPF meshes.
- **mTLS STRICT can lock you out** — roll out `PERMISSIVE` first (accepts both plaintext and mTLS) to migrate, then flip to STRICT once all clients are meshed.
- **Metadata endpoint & node-local traffic** — remember policies apply to pod-to-pod; egress `ipBlock` with `except` is how you block the `169.254.169.254` cloud metadata IP.

## 8. Common Mistakes

1. ⚠️ **Assuming a policy blocks traffic by name.** Policies are *allow-lists*; they only take effect by making selected pods default-deny. **Fix:** apply a default-deny policy, then allow.
2. ⚠️ **Writing egress rules but omitting `policyTypes: [Egress]`.** Egress stays fully open. **Fix:** always list the directions you intend to enforce.
3. ⚠️ **Breaking DNS with a blanket egress-deny.** Everything times out mysteriously. **Fix:** add an explicit allow for port 53 to kube-system.
4. ⚠️ **Confusing AND vs OR selectors.** `namespaceSelector` + `podSelector` in one `from` element is AND; as two elements it's OR. **Fix:** structure list items deliberately and test.
5. ⚠️ **Expecting policy on a non-enforcing CNI.** Flannel/basic VPC-CNI silently ignore it. **Fix:** use Calico/Cilium/Antrea or enable the add-on; verify with a probe.
6. ⚠️ **Flipping mesh mTLS to STRICT before all clients are meshed.** Non-mesh callers get rejected. **Fix:** stage through PERMISSIVE.
7. ⚠️ **Thinking mTLS replaces NetworkPolicy.** mTLS authenticates but a compromised meshed pod still has an identity; you still want L3/L4 segmentation. **Fix:** run both layers.

## 9. Interview Questions

**Q: What happens to a pod's traffic the moment it is selected by a NetworkPolicy?**
A: For each direction named in `policyTypes`, the pod switches from default-allow to **default-deny**, and only traffic matching an explicit rule is permitted. Directions not listed remain wide open. Pods not selected by any policy are unaffected and stay fully open.

**Q: Why does an unauthorized connection time out instead of getting "connection refused"?**
A: NetworkPolicy enforcement (in iptables/eBPF) **silently drops** the packets rather than sending a TCP RST. The client keeps waiting for a SYN-ACK that never comes, so it eventually times out. A refused connection would instead mean nothing is listening on the port — a different failure.

**Q: You applied a default-deny-egress policy and now nothing works, not even to services that should be reachable. What's the first thing you check?**
A: DNS. A blanket egress-deny blocks UDP/TCP port 53 to CoreDNS, so name resolution fails and *every* outbound call errors before it even connects. Add an explicit egress allow to kube-system on port 53, then layer on the app-specific allows.

**Q: Explain the AND vs OR semantics of `from`/`to` peers.**
A: Within a single peer element, `namespaceSelector` and `podSelector` are **AND**ed — both must match. Separate elements in the `from`/`to` list are **OR**ed — matching any one is enough. Getting this wrong is the classic cause of policies that are too broad or too narrow.

**Q: Does creating a NetworkPolicy object guarantee enforcement?**
A: No. The object is inert until a **policy-capable CNI** (Calico, Cilium, Antrea, Weave, or a cloud add-on) translates it into datapath rules. On Flannel or a VPC-CNI without the network-policy add-on, the object exists in the API but nothing enforces it — you must verify with a probe pod.

**Q: What does a service mesh give you that NetworkPolicy cannot?**
A: Cryptographic **workload identity** (SPIFFE certs) independent of IP, **mTLS** encryption + authentication, **L7 authorization** (per-method/per-path rules), and rich **observability** (RED metrics, traces, a live dependency graph) — all at the application layer, which L3/L4 NetworkPolicy can't touch.

**Q: How does mesh mTLS actually get injected without changing my app?**
A: A sidecar proxy (Envoy) is injected into each pod, and iptables/eBPF redirect rules capture all inbound/outbound traffic into that proxy transparently. The proxy performs the mTLS handshake using certs issued by the mesh CA, then forwards plaintext to the app on localhost — the app is oblivious.

**Q: (Senior) NetworkPolicy and mTLS both provide "security." Why run both?**
A: They defend different things. mTLS gives authenticated, encrypted identity but a *compromised meshed pod still holds a valid identity* and can call anything its authz allows. NetworkPolicy limits which pods can even reach each other at L3/L4, shrinking the blast radius regardless of identity. Defense in depth: network segmentation + identity-based authz.

**Q: (Senior) What is the CPU/latency cost of a sidecar mesh at scale, and how do you avoid it?**
A: Each sidecar consumes ~50–100m CPU and ~50–100 MiB RAM and adds ~1–3 ms per hop; across thousands of pods this is significant fixed overhead plus tail-latency risk. Mitigations: **ambient/sidecar-less meshes** (Istio ambient, Cilium mesh via eBPF/per-node proxies), tuning proxy concurrency, and scoping the mesh to services that actually need L7 features.

**Q: (Senior) How would you block pods from reaching the cloud metadata endpoint (169.254.169.254)?**
A: Apply a default-deny-egress, then egress-allow rules using `ipBlock` with the pod/service CIDRs, plus a rule allowing the internet CIDR `0.0.0.0/0` with `except: [169.254.169.254/32]`. Or use Cilium/Calico global policies. This prevents SSRF-style credential theft from the instance metadata service.

**Q: (Senior) How do you safely migrate a namespace to STRICT mTLS?**
A: Start with `PeerAuthentication` mode `PERMISSIVE`, which accepts both plaintext and mTLS, so unmeshed clients keep working. Onboard all clients into the mesh, confirm via telemetry that traffic is mTLS, then flip to `STRICT`. Flipping first breaks any non-mesh caller with connection resets.

## 10. Practice

- [ ] Create a namespace, apply a `default-deny-all`, and prove with a probe pod that traffic is dropped (times out).
- [ ] Write ingress + egress policies for a `frontend→api→db` chain and verify each allowed/denied hop with `curl`/`nc`.
- [ ] Break DNS on purpose with a default-deny-egress, observe the failure, then fix it with a port-53 allow.
- [ ] Install Cilium and use `hubble observe` to watch flows being allowed/dropped in real time.
- [ ] Enable Istio with PERMISSIVE mTLS, verify traffic is encrypted (`istioctl proxy-config`), then add an AuthorizationPolicy restricting a path.

## 11. Cheat Sheet

> [!TIP]
> **NetworkPolicy = L3/L4 allow-list; mesh = L7 identity + mTLS + observability.**
> - Zero policies ⇒ all traffic allowed. First policy selecting a pod ⇒ **default-deny** for that direction.
> - `podSelector: {}` = whole namespace. Always ship a **default-deny** then add allows.
> - Must list `policyTypes: [Ingress, Egress]`; egress rules do nothing without it.
> - **Always allow DNS** (port 53 → kube-system) when denying egress.
> - Same-element `ns`+`pod` selector = AND; separate elements = OR.
> - Drops **time out** (no RST); needs a **policy-capable CNI** (Calico/Cilium/Antrea).
> - Mesh: `PeerAuthentication` STRICT = mTLS everywhere; `AuthorizationPolicy` = who-can-call-what at L7. Migrate via PERMISSIVE. Budget sidecar CPU/latency; consider ambient/eBPF.

**References:** Kubernetes NetworkPolicy docs; Cilium & Calico docs; Istio Security (PeerAuthentication/AuthorizationPolicy); Linkerd docs

---
*Kubernetes Handbook — topic 13.*
