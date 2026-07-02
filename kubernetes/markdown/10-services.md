# 10 · Services & kube-proxy

> **In one line:** A Service is a stable virtual IP/DNS front for an ephemeral, changing set of pods, and kube-proxy is the node-level data plane that makes that VIP actually load-balance.

---

## 1. Overview

Pods are cattle, not pets. They are created, rescheduled, and destroyed constantly, and every new pod gets a **fresh IP**. If clients talked to pod IPs directly, every restart would break them. A **Service** solves this by giving a set of pods one **stable virtual IP (ClusterIP)** and a stable DNS name that survives pod churn.

The Service object is just an *intent* — "route traffic for this VIP to any pod matching this label selector." Two other pieces make it real: the **EndpointSlice** controller, which continuously rebuilds the list of healthy backing pod IPs, and **kube-proxy**, a daemon on every node that programs kernel-level load-balancing rules (iptables or IPVS) so packets to the VIP get NAT'd to a real pod.

You reach for a Service whenever more than one pod backs a capability, whenever a client must survive backend restarts, or whenever you need in-cluster DNS discovery. The **type** you pick — ClusterIP, NodePort, LoadBalancer, or ExternalName — decides *who* can reach it and *how* the traffic gets in.

## 2. Core Concepts

- **ClusterIP** — the default. Allocates a stable virtual IP from the Service CIDR, reachable only inside the cluster. Every other type builds on it.
- **NodePort** — opens the same port (30000–32767) on *every* node's IP, forwarding to the ClusterIP. Basis for external access without a cloud LB.
- **LoadBalancer** — asks the cloud provider (via a controller) to provision an external L4 load balancer whose targets are the NodePorts. One external IP per Service.
- **ExternalName** — no proxying at all; returns a **CNAME** DNS record to an external hostname (e.g. `db.rds.amazonaws.com`). Pure DNS aliasing.
- **Selector → EndpointSlice** — the selector matches pod labels; the endpoints controller writes matching *ready* pod IP:port tuples into **EndpointSlices** (the scalable successor to the single `Endpoints` object).
- **kube-proxy** — a per-node daemon that watches Services and EndpointSlices and programs the dataplane. Modes: **iptables** (default) and **IPVS** (kernel hash tables, better at scale).
- **Headless Service** (`clusterIP: None`) — no VIP, no proxying; DNS returns the *individual* pod A/AAAA records. Used for StatefulSets and client-side load balancing.
- **`port` vs `targetPort` vs `nodePort`** — `port` = the Service's own port; `targetPort` = the container port it forwards to; `nodePort` = the port opened on nodes.
- **Readiness gating** — only pods passing their **readiness probe** appear in EndpointSlices, so traffic never hits a booting or unhealthy pod.

## 3. Syntax & Examples

Simplest ClusterIP (default type):

```yaml
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  selector:
    app: web              # matches pods labelled app=web
  ports:
    - port: 80            # the Service's virtual port
      targetPort: 8080    # the container's port
```

NodePort — reachable on every node's IP:

```yaml
apiVersion: v1
kind: Service
metadata: { name: web }
spec:
  type: NodePort
  selector: { app: web }
  ports:
    - port: 80
      targetPort: 8080
      nodePort: 30080     # optional; auto-assigned 30000-32767 if omitted
```

LoadBalancer — cloud provisions an external IP:

```yaml
apiVersion: v1
kind: Service
metadata: { name: web }
spec:
  type: LoadBalancer
  externalTrafficPolicy: Local   # preserve client source IP, skip extra hop
  selector: { app: web }
  ports:
    - { port: 80, targetPort: 8080 }
```

ExternalName — DNS CNAME alias, no pods, no selector:

```yaml
apiVersion: v1
kind: Service
metadata: { name: prod-db }
spec:
  type: ExternalName
  externalName: db.abc123.us-east-1.rds.amazonaws.com
```

Headless — direct pod discovery, no VIP:

```yaml
apiVersion: v1
kind: Service
metadata: { name: cassandra }
spec:
  clusterIP: None          # <-- makes it headless
  selector: { app: cassandra }
  ports:
    - { port: 9042 }
```

## 4. Worked Example

Deploy 3 replicas, front them with a ClusterIP, and inspect the routing.

```bash
kubectl create deployment web --image=nginx --replicas=3
kubectl expose deployment web --port=80 --target-port=80
kubectl get svc web -o wide
kubectl get endpointslices -l kubernetes.io/service-name=web
```

Output:

```text
NAME   TYPE        CLUSTER-IP      PORT(S)   SELECTOR
web    ClusterIP   10.96.140.22    80/TCP    app=web

NAME        ADDRESSTYPE   PORTS   ENDPOINTS
web-abcde   IPv4          80      10.244.1.7,10.244.2.4,10.244.1.9
```

The single VIP `10.96.140.22` now fans out to three real pod IPs. Kill a pod and the EndpointSlice self-heals within a second:

```bash
kubectl delete pod -l app=web --field-selector status.phase=Running --grace-period=0 | head -1
kubectl get endpointslices -l kubernetes.io/service-name=web -o jsonpath='{.items[0].endpoints[*].addresses}'
# ["10.244.2.4","10.244.1.9","10.244.3.2"]   <-- new pod IP swapped in, VIP unchanged
```

From another pod, DNS resolves the stable name regardless of the churn:

```bash
kubectl run t --rm -it --image=busybox --restart=Never -- \
  wget -qO- http://web.default.svc.cluster.local
# <!DOCTYPE html> ... Welcome to nginx! ...
```

## 5. Under the Hood

A packet to a ClusterIP never reaches a magic proxy server — it is rewritten **in the kernel** by rules kube-proxy installed. In iptables mode, kube-proxy builds a chain per Service that uses statistical probability to pick a backend, then DNATs the destination to a real pod IP. In IPVS mode it programs an in-kernel hash table (real load-balancer primitives) that scales to thousands of Services without the O(n) rule-list traversal iptables suffers.

```svg
<svg viewBox="0 0 760 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>

  <!-- client -->
  <rect x="20" y="160" width="120" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="80" y="185" text-anchor="middle" fill="#1e293b">Client Pod</text>
  <text x="80" y="204" text-anchor="middle" fill="#64748b" font-size="11">GET web:80</text>

  <!-- VIP -->
  <rect x="220" y="150" width="150" height="80" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="295" y="178" text-anchor="middle" fill="#1e293b">Service VIP</text>
  <text x="295" y="196" text-anchor="middle" fill="#64748b" font-size="11">10.96.140.22:80</text>
  <text x="295" y="214" text-anchor="middle" fill="#64748b" font-size="11">(virtual, no process)</text>

  <!-- kube-proxy -->
  <rect x="220" y="290" width="150" height="70" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="295" y="315" text-anchor="middle" fill="#1e293b">kube-proxy</text>
  <text x="295" y="333" text-anchor="middle" fill="#64748b" font-size="11">programs iptables/IPVS</text>
  <text x="295" y="349" text-anchor="middle" fill="#64748b" font-size="11">DNAT + LB rules</text>

  <!-- pods -->
  <rect x="560" y="40" width="180" height="52" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="650" y="63" text-anchor="middle" fill="#1e293b">Pod 10.244.1.7</text>
  <text x="650" y="80" text-anchor="middle" fill="#64748b" font-size="11">ready ✓</text>

  <rect x="560" y="170" width="180" height="52" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="650" y="193" text-anchor="middle" fill="#1e293b">Pod 10.244.2.4</text>
  <text x="650" y="210" text-anchor="middle" fill="#64748b" font-size="11">ready ✓</text>

  <rect x="560" y="300" width="180" height="52" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="650" y="323" text-anchor="middle" fill="#1e293b">Pod 10.244.1.9</text>
  <text x="650" y="340" text-anchor="middle" fill="#64748b" font-size="11">ready ✓</text>

  <!-- arrows -->
  <line x1="140" y1="190" x2="216" y2="190" stroke="#475569" stroke-width="1.5" marker-end="url(#ah)"/>
  <line x1="295" y1="230" x2="295" y2="286" stroke="#475569" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#ah)"/>
  <text x="360" y="262" text-anchor="middle" fill="#64748b" font-size="11">rewrites in kernel</text>

  <line x1="370" y1="180" x2="556" y2="66" stroke="#475569" stroke-width="1.5" marker-end="url(#ah)"/>
  <line x1="370" y1="190" x2="556" y2="196" stroke="#475569" stroke-width="1.5" marker-end="url(#ah)"/>
  <line x1="370" y1="200" x2="556" y2="326" stroke="#475569" stroke-width="1.5" marker-end="url(#ah)"/>
  <text x="465" y="150" text-anchor="middle" fill="#64748b" font-size="11">DNAT to one ready pod</text>

  <!-- endpointslice note -->
  <rect x="430" y="290" width="110" height="70" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="485" y="315" text-anchor="middle" fill="#1e293b" font-size="12">Endpoint</text>
  <text x="485" y="331" text-anchor="middle" fill="#1e293b" font-size="12">Slice</text>
  <text x="485" y="348" text-anchor="middle" fill="#64748b" font-size="10">ready pod IPs</text>
  <line x1="485" y1="290" x2="485" y2="230" stroke="#475569" stroke-width="1.2" stroke-dasharray="3 3"/>
  <text x="485" y="248" text-anchor="middle" fill="#64748b" font-size="10">feeds</text>
</svg>
```

The control loop: the **EndpointSlice controller** watches pods + readiness and rewrites the slice; kube-proxy watches Services + slices and reprograms the node's dataplane. Nothing in the hot path is a userspace hop — kube-proxy is a *controller*, not a proxy on the packet path (except in the legacy `userspace` mode nobody uses today).

## 6. Variations & Trade-offs

| Type | Scope | External IP? | Backed by | Typical use |
|------|-------|-------------|-----------|-------------|
| ClusterIP | in-cluster only | no | VIP + kube-proxy | internal microservice calls |
| NodePort | node IPs | node IP:high-port | ClusterIP | bare-metal ingress, debugging |
| LoadBalancer | internet | yes (cloud LB) | NodePort | public L4 endpoint on cloud |
| ExternalName | DNS alias | n/a | CNAME only | point in-cluster name at external service |
| Headless | in-cluster | no (no VIP) | direct pod DNS | StatefulSet peers, client-side LB |

| kube-proxy mode | Data structure | Scaling | Notes |
|-----------------|---------------|---------|-------|
| iptables | linear rule chains | O(n) rule eval; degrades ~1000s of svcs | default, ubiquitous |
| IPVS | in-kernel hash table | O(1) lookup, thousands of svcs | needs kernel modules; rr/lc/sh algorithms |
| nftables | rule sets (newer) | better than iptables at scale | GA-ing as iptables successor |

**Trade-off:** LoadBalancer is simplest for one public endpoint but costs one cloud LB *per Service* — for many HTTP routes an **Ingress** (topic 11) sharing one LB is far cheaper. `externalTrafficPolicy: Local` preserves the client source IP and avoids a second node hop but risks imbalance if pods aren't evenly spread.

## 7. Production / Performance Notes

- **Prefer IPVS or nftables at scale.** Beyond a few thousand Services, iptables rule evaluation and reprogramming latency (full-table rewrites) become measurable; IPVS lookups stay flat.
- **Always define readiness probes.** They are the only gate keeping traffic off cold pods — without them the Service will happily route to a pod still loading caches, causing early 502s during rollouts.
- **Set `externalTrafficPolicy: Local`** for LoadBalancer/NodePort when you need real client IPs (rate limiting, geo) — but ensure a pod runs on every LB target node or that node black-holes traffic.
- **Session affinity:** `sessionAffinity: ClientIP` pins a client to a pod (default timeout 3h) when you need sticky sessions, at the cost of even balancing.
- **Consolidate public entrypoints.** Dozens of `type: LoadBalancer` Services = dozens of billed cloud LBs; front HTTP with one Ingress or Gateway instead.
- **Topology-aware routing** (`spec.trafficDistribution: PreferClose`) keeps traffic in-zone to cut cross-AZ data-transfer cost and latency.

## 8. Common Mistakes

1. ⚠️ **Selector/label mismatch → empty EndpointSlice, silent 100% failure.** Fix: `kubectl get endpointslices -l kubernetes.io/service-name=<svc>`; align `spec.selector` with the pod template labels exactly.
2. ⚠️ **Confusing `port` and `targetPort`.** `port` is what clients hit; `targetPort` must equal the container's listening port. Fix: name the container port and reference it by name.
3. ⚠️ **No readiness probe → traffic to booting pods.** Fix: add a `readinessProbe`; pods only enter the slice when it passes.
4. ⚠️ **Using NodePort as a production public endpoint.** High ports, no TLS, no name — brittle. Fix: LoadBalancer or Ingress in front.
5. ⚠️ **One `LoadBalancer` per microservice.** Blows up cost and IP quota. Fix: share one Ingress/Gateway LB across many HTTP routes.
6. ⚠️ **Expecting a Service to heal or scale pods.** A Service only *routes*; it never creates pods. Fix: that's the Deployment/ReplicaSet's job.
7. ⚠️ **Forgetting the namespace suffix cross-namespace.** `web` resolves only same-namespace; use `web.other-ns.svc.cluster.local`. Fix: use the FQDN.
8. ⚠️ **Assuming ExternalName does health checks or proxying.** It's pure DNS CNAME — no LB, no TLS, no failover. Fix: use a real Service/endpoint if you need those.

## 9. Interview Questions

**Q: Why do we need a Service instead of talking to pod IPs directly?**
A: Pods are ephemeral and get new IPs on every reschedule. A Service provides a stable VIP/DNS name and load-balances across the current healthy set, decoupling clients from pod churn.

**Q: Walk through what happens to a packet sent to a ClusterIP.**
A: There is no server at the VIP. kube-proxy has pre-programmed iptables/IPVS rules in the kernel that match the destination VIP, pick a backend from the EndpointSlice (by probability in iptables, hash table in IPVS), and DNAT the packet to a real pod IP. The reply is un-NAT'd back. No userspace hop.

**Q: What is the difference between the Endpoints object and EndpointSlices?**
A: The old single `Endpoints` object listed every backend in one resource, which didn't scale — a change to one pod rewrote and re-broadcast the whole object. EndpointSlices shard endpoints into chunks (~100 each), so updates and watches are cheap at large scale. Slices are the default since ~1.19.

**Q: ClusterIP vs NodePort vs LoadBalancer vs ExternalName?**
A: ClusterIP = internal VIP only. NodePort = a port on every node forwarding to the ClusterIP. LoadBalancer = a cloud L4 LB in front of the NodePorts. ExternalName = a DNS CNAME to an external host, no proxying at all.

**Q: What is a headless Service and when do you use it?**
A: `clusterIP: None`. No VIP and no kube-proxy programming — DNS returns the individual ready pod A records (and SRV records). Used for StatefulSets (stable per-pod DNS), peer discovery (Cassandra, Kafka), and client-side load balancing.

**Q: iptables vs IPVS mode for kube-proxy — when does it matter?**
A: iptables uses linear rule chains, so both lookup and reprogramming degrade as Services grow into the thousands. IPVS uses an in-kernel hash table (O(1) lookup) plus real LB algorithms (rr, lc, sh). At large scale IPVS/nftables cut latency and CPU; below a few hundred Services the difference is negligible.

**Q: Why might a Service's EndpointSlice be empty even though pods are running?**
A: The label selector doesn't match the pods, or no pod is passing its readiness probe, or the pods are `Terminating`. Only ready, matching pods appear.

**Q: How does `externalTrafficPolicy: Local` change behavior, and what's the risk?** *(senior)*
A: It stops the second SNAT/hop between nodes, so the pod sees the real client source IP and latency drops. The risk is load imbalance and blackholing: the LB health check only passes on nodes actually running a backend pod, so if pods aren't spread across all target nodes, some nodes drop traffic.

**Q: You have 40 HTTP microservices to expose publicly. Why not 40 LoadBalancer Services?** *(senior)*
A: That's 40 billed cloud LBs and 40 public IPs, plus no shared TLS or path routing. Use one Ingress/Gateway (a single LB) doing host/path L7 routing to 40 ClusterIP Services — far cheaper and centrally managed.

**Q: How does kube-proxy stay in sync when pods churn during a rollout?** *(senior)*
A: The EndpointSlice controller watches pod readiness and rewrites slices as pods come and go; kube-proxy watches Services + slices and incrementally reprograms the node dataplane. Combined with readiness probes, traffic only ever targets ready pods — the VIP stays constant throughout.

**Q: What does `sessionAffinity: ClientIP` do and what does it cost?**
A: It pins each client IP to the same backend pod (default 3-hour timeout) using a consistent mapping instead of per-connection LB. The cost is uneven load distribution and stickiness that outlives a pod restart until the timeout expires.

## 10. Practice

- [ ] Create a Deployment of 3 replicas, expose it as ClusterIP, and confirm the EndpointSlice lists all 3 pod IPs.
- [ ] Delete a backing pod and watch the EndpointSlice self-heal without the VIP changing.
- [ ] Break the Service selector, observe the empty slice and failed requests, then fix it.
- [ ] Switch a cluster's kube-proxy to IPVS mode and confirm with `ipvsadm -Ln` that the VIP has real-server entries.
- [ ] Create a headless Service and compare `nslookup` output against a ClusterIP Service.

## 11. Cheat Sheet

> [!TIP]
> **Service = stable VIP/DNS → label-selected ready pods.** Types: ClusterIP (internal, default) · NodePort (port on every node) · LoadBalancer (cloud L4 LB) · ExternalName (DNS CNAME) · Headless `clusterIP:None` (direct pod DNS).
> **Wiring:** selector → EndpointSlice (ready pod IPs) → kube-proxy programs iptables (linear, default) or IPVS (hash, scales) → kernel DNATs VIP → pod.
> **Ports:** `port` (Service) → `targetPort` (container) → `nodePort` (node, 30000–32767).
> **Gotchas:** empty slice = selector/readiness mismatch · use FQDN cross-namespace · one LB per svc is costly (use Ingress) · `externalTrafficPolicy: Local` for real client IP · Services route, never scale.

**References:** Kubernetes docs — Service, EndpointSlices, Virtual IPs and Service Proxies; kube-proxy IPVS design proposal

---

*Kubernetes Handbook — topic 10.*
