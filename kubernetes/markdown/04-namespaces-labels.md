# 04 · Namespaces, Labels & Selectors

> **In one line:** Namespaces slice a cluster into isolated, quota-bounded tenants; labels are the key/value glue that selectors use to wire Services to Pods and to slice workloads for ops.

---

## 1. Overview

A Kubernetes cluster is one big flat pool of nodes. Left alone, every team's Pods, Services and Secrets would collide in a single soup. **Namespaces** carve that pool into named virtual clusters so `team-a` and `team-b` can each have a `Service/api` without clashing, and so you can attach **ResourceQuotas**, **LimitRanges** and **RBAC** per tenant.

But namespaces are only *organizational* boundaries — they group and scope object *names*. They say nothing about *which Pods belong to which Service or Deployment*. That job belongs to **labels**: arbitrary `key=value` tags stamped on any object, and **label selectors**: queries that match those tags. Selectors are the single most important idea in Kubernetes: a Service finds its Pods by selector, a Deployment owns its ReplicaSet's Pods by selector, and you filter `kubectl get` by selector.

You reach for namespaces when you need **multi-tenancy, quota, or blast-radius isolation**. You reach for labels the moment you have more than one of anything — one for `app`, one for `env`, one for `version` — because every rollout, canary, and dashboard query is a selector over those labels.

The mental split to keep: **namespaces isolate**, **labels select**, **annotations describe**.

---

## 2. Core Concepts

- **Namespace** — a scope for names of *namespaced* resources (Pods, Services, Deployments, ConfigMaps, PVCs). Two objects of the same kind can share a name only if in different namespaces.
- **Cluster-scoped objects** — Nodes, PersistentVolumes, StorageClasses, ClusterRoles and Namespaces themselves live *outside* any namespace. `kubectl api-resources --namespaced=false` lists them.
- **The four default namespaces** — `default` (where your stuff lands if you don't specify), `kube-system` (control-plane add-ons: CoreDNS, kube-proxy), `kube-public` (world-readable cluster info), `kube-node-lease` (node heartbeat Lease objects).
- **Label** — a `key: value` pair in `metadata.labels` used for **identification and selection**. Keys may have an optional DNS-subdomain prefix (`app.kubernetes.io/name`). Values ≤ 63 chars, alphanumerics + `-_.`.
- **Annotation** — a `key: value` in `metadata.annotations` for **non-identifying metadata**: build SHAs, `kubectl.kubernetes.io/last-applied-configuration`, ingress tuning. Not selectable, can be large/binary-ish.
- **Equality selector** — `env=prod`, `tier!=frontend`. All conditions AND together.
- **Set-based selector** — `env in (prod, staging)`, `tier notin (cache)`, `release` (key exists), `!release` (key absent). More expressive; Services support only equality in their `.spec.selector`.
- **ResourceQuota** — caps aggregate CPU/memory/object-counts *per namespace*. **LimitRange** sets default/max per-Pod or per-Container requests inside a namespace.
- **Recommended labels** — the `app.kubernetes.io/*` well-known set (`name`, `instance`, `version`, `component`, `part-of`, `managed-by`) that tools and dashboards understand.

---

## 3. Syntax & Examples

Create a namespace and set your default context to it:

```bash
kubectl create namespace payments
kubectl config set-context --current --namespace=payments   # stop typing -n
```

Declarative namespace with a quota and default limits:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: payments
  labels:
    team: fintech
    app.kubernetes.io/part-of: checkout
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: payments-quota
  namespace: payments
spec:
  hard:
    requests.cpu: "8"
    requests.memory: 16Gi
    limits.cpu: "16"
    limits.memory: 32Gi
    pods: "50"
    services.loadbalancers: "2"
```

Labels on a workload, and a Service selecting them by equality:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: payments
spec:
  replicas: 3
  selector:
    matchLabels:           # Deployment owns Pods matching THIS
      app: api
  template:
    metadata:
      labels:              # Pods carry these; must satisfy selector above
        app: api
        env: prod
        version: v2
    spec:
      containers:
        - name: api
          image: registry.io/api:2.3.1
---
apiVersion: v1
kind: Service
metadata:
  name: api
  namespace: payments
spec:
  selector:               # equality-only; ANDed
    app: api
    env: prod
  ports:
    - port: 80
      targetPort: 8080
```

Filtering with selectors on the CLI:

```bash
kubectl get pods -l 'app=api,env=prod'                 # equality, AND
kubectl get pods -l 'env in (prod,staging)'            # set-based
kubectl get pods -l '!canary'                          # key absent
kubectl get pods -L app -L version                     # show as columns
kubectl label pod api-xyz canary=true --overwrite      # add/update a label
kubectl label pod api-xyz canary-                      # remove a label
```

---

## 4. Worked Example

Ship a **canary**: same Service fronts stable + canary Pods, split purely by labels.

```yaml
# stable: 4 replicas, version=v2
# canary: 1 replica, version=v3  (same app label!)
apiVersion: apps/v1
kind: Deployment
metadata: { name: web-canary, namespace: payments }
spec:
  replicas: 1
  selector: { matchLabels: { app: web, track: canary } }
  template:
    metadata: { labels: { app: web, track: canary, version: v3 } }
    spec: { containers: [ { name: web, image: registry.io/web:3.0.0 } ] }
```

The Service selects only `app: web` — so it load-balances across **both** stable (v2) and canary (v3) Pods, sending ~1/5 of traffic to v3 by replica count. Verify the endpoint set:

```bash
kubectl get endpointslices -l kubernetes.io/service-name=web -o wide
```

```text
NAME        ADDRESSTYPE   PORTS   ENDPOINTS                                  AGE
web-abcde   IPv4          8080    10.1.2.7,10.1.2.8,10.1.2.9,10.1.3.4,...    2m
# 5 addresses: 4 stable + 1 canary — one Service, split by label topology

$ kubectl get pods -L version,track
NAME               READY   STATUS    VERSION   TRACK
web-6f...-a        1/1     Running   v2        stable
web-6f...-b        1/1     Running   v2        stable
web-canary-9x...   1/1     Running   v3        canary
```

Promote by scaling canary up / stable down — no Service edit needed. Roll back by deleting the canary Deployment; endpoints shrink automatically.

---

## 5. Under the Hood

A Service does not know about Pods directly. The **endpoints controller** (and its successor, the **EndpointSlice controller**) runs a *selector query* against the Pod cache, and writes the matching Ready Pod IPs into EndpointSlice objects. `kube-proxy` then programs those IPs into iptables/IPVS rules. Change a label → the controller re-evaluates the selector → EndpointSlices update → kube-proxy reprograms. The selector is the join key across the whole data path.

```svg
<svg viewBox="0 0 760 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <rect x="20" y="20" width="720" height="260" rx="8" fill="none" stroke="#64748b" stroke-dasharray="4 4"/>
  <text x="40" y="42" text-anchor="start" fill="#64748b">namespace: payments</text>

  <rect x="40" y="60" width="150" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="115" y="86" text-anchor="middle" fill="#1e293b">Service: web</text>
  <text x="115" y="104" text-anchor="middle" fill="#64748b">selector app=web</text>

  <rect x="270" y="55" width="180" height="70" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="360" y="80" text-anchor="middle" fill="#1e293b">EndpointSlice</text>
  <text x="360" y="100" text-anchor="middle" fill="#64748b">ready pod IPs</text>

  <rect x="540" y="55" width="180" height="70" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="630" y="80" text-anchor="middle" fill="#1e293b">kube-proxy</text>
  <text x="630" y="100" text-anchor="middle" fill="#64748b">iptables / IPVS</text>

  <line x1="190" y1="90" x2="268" y2="90" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="450" y1="90" x2="538" y2="90" stroke="#475569" marker-end="url(#ah)"/>

  <rect x="60" y="180" width="120" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="120" y="200" text-anchor="middle" fill="#1e293b">Pod app=web</text>
  <text x="120" y="217" text-anchor="middle" fill="#64748b">v2 stable</text>
  <rect x="200" y="180" width="120" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="260" y="200" text-anchor="middle" fill="#1e293b">Pod app=web</text>
  <text x="260" y="217" text-anchor="middle" fill="#64748b">v2 stable</text>
  <rect x="340" y="180" width="120" height="46" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="400" y="200" text-anchor="middle" fill="#1e293b">Pod app=web</text>
  <text x="400" y="217" text-anchor="middle" fill="#64748b">v3 canary</text>

  <text x="240" y="255" text-anchor="middle" fill="#64748b">endpoints controller evaluates selector → writes slice → proxy programs rules</text>
  <line x1="120" y1="180" x2="330" y2="126" stroke="#475569" stroke-dasharray="3 3"/>
  <line x1="260" y1="180" x2="345" y2="126" stroke="#475569" stroke-dasharray="3 3"/>
  <line x1="400" y1="180" x2="360" y2="126" stroke="#475569" stroke-dasharray="3 3"/>
</svg>
```

Namespaces work differently: they are enforced at the **API server**, which scopes every namespaced request to `.../namespaces/<ns>/...`. RBAC RoleBindings are namespaced, so a Role in `payments` cannot read Secrets in `default`. Deleting a namespace triggers cascading deletion of everything inside it via finalizers.

---

## 6. Variations & Trade-offs

| Mechanism | Purpose | Selectable? | Enforced by |
|---|---|---|---|
| **Namespace** | Name scoping, quota, RBAC boundary | via `metadata.namespace`, not label | API server |
| **Label** | Identify & group; selector join key | Yes (equality + set) | Controllers, kube-proxy |
| **Annotation** | Non-identifying metadata | No | Nobody selects; tools read |
| **Equality selector** | `k=v`, `k!=v` (Service supports only this) | — | endpoints controller |
| **Set-based selector** | `in`, `notin`, exists, `!exists` | — | Deployments, `kubectl -l` |

**Namespace-per-team vs namespace-per-env vs namespace-per-app**: per-team is common for quota/RBAC; per-env (`dev`/`staging`/`prod`) is often better done with *separate clusters* for hard isolation since namespaces share the same network and control plane by default. Namespaces are a **soft** boundary — no network isolation unless you add NetworkPolicies, no node isolation unless you add taints/affinity.

**Labels vs annotations**: if a controller or query must *find* the object by the value, it's a label; if it's just data humans/tools read, it's an annotation. Overloading labels bloats the etcd index and every selector evaluation.

---

## 7. Production / Performance Notes

- **Adopt `app.kubernetes.io/*` labels cluster-wide.** Dashboards (Grafana), service meshes, and `kubectl` plugins key off them; consistency pays compounding dividends.
- **Keep label cardinality bounded.** Labels are indexed; a label whose value is a unique request-id or timestamp explodes the index and slows list/watch. Put high-cardinality data in annotations.
- **Every namespace gets a ResourceQuota + LimitRange.** Without a LimitRange, a Pod with no requests can starve neighbors; with a ResourceQuota set, Pods *without* requests are actively rejected — so pair them.
- **NetworkPolicies are default-allow.** A namespace is not a firewall. Apply a default-deny NetworkPolicy per namespace and open explicitly.
- **Namespace deletion can hang** on stuck finalizers (a common cause: a CRD's controller is gone). A namespace stuck `Terminating` usually means an object with a finalizer can't be cleaned up — inspect `kubectl get namespace x -o yaml` under `spec.finalizers`.
- **Selector immutability**: a Deployment's `.spec.selector` is immutable after creation. Plan your label schema up front; changing it means recreating the Deployment.

---

## 8. Common Mistakes

1. ⚠️ **Pod template labels don't satisfy the Deployment selector.** The Deployment is rejected. *Fix:* every key in `spec.selector.matchLabels` must appear (same value) in `spec.template.metadata.labels`.
2. ⚠️ **Service selector too broad**, silently sending traffic to unintended Pods (e.g. canary during a bad rollout). *Fix:* scope selectors precisely; verify with `kubectl get endpointslices`.
3. ⚠️ **Putting build SHAs / timestamps in labels.** High cardinality bloats etcd and slows watches. *Fix:* use annotations for non-identifying metadata.
4. ⚠️ **Assuming a namespace isolates network traffic.** Pods in `dev` can reach `prod` Services by default. *Fix:* NetworkPolicies with default-deny.
5. ⚠️ **Forgetting `-n` / wrong current namespace** — you `apply` into `default` and wonder why nothing shows. *Fix:* set context namespace or always pass `-n`.
6. ⚠️ **ResourceQuota set but Pods have no requests → creation fails.** *Fix:* add a LimitRange to inject defaults, or set requests explicitly.
7. ⚠️ **Using set-based selectors in a Service `.spec.selector`.** Not supported — Services take equality maps only. *Fix:* use equality, or a headless Service + custom Endpoints.
8. ⚠️ **Deleting a namespace to "clean up" and losing a shared PVC/Secret** others depended on. *Fix:* namespace deletion is cascading and irreversible; check ownership first.

---

## 9. Interview Questions

**Q: What is the difference between a namespace and a label?**
A: A namespace is a *scope* for resource names and a boundary for quota/RBAC — enforced by the API server. A label is a `key=value` tag on any object used for *identification and selection* by controllers and selectors. Namespaces isolate; labels select. They're orthogonal: one namespace holds many differently-labeled objects.

**Q: How does a Service know which Pods to route to?**
A: Via its `.spec.selector` (equality-based label map). The endpoints/EndpointSlice controller continuously evaluates that selector against Ready Pods in the same namespace and writes their IPs into EndpointSlices; kube-proxy programs those into iptables/IPVS. There is no direct Pod reference — the label selector is the join.

**Q: Labels vs annotations — when do you use each?**
A: Labels for anything a selector or controller must match on (`app`, `env`, `version`) — indexed, length-limited, low cardinality. Annotations for non-identifying metadata (build SHAs, last-applied config, tool hints) — not selectable, can be larger. Rule: if something needs to *find* it, it's a label.

**Q: What's the difference between equality-based and set-based selectors, and where can you use each?**
A: Equality (`env=prod`, `tier!=cache`) matches exact values, ANDed. Set-based (`env in (prod,staging)`, `key`, `!key`) tests membership/existence and is more expressive. `kubectl -l` and Deployment/ReplicaSet `matchExpressions` support both; a Service's `.spec.selector` supports **equality only**.

**Q: Are namespaces a security or network boundary?**
A: Not by themselves. They scope names and anchor RBAC/quota, but Pods across namespaces share the pod network and can talk freely unless you add NetworkPolicies. For hard isolation you add default-deny NetworkPolicies, resource quotas, and often node isolation via taints — or use separate clusters.

**Q: Which resources are cluster-scoped rather than namespaced?**
A: Nodes, PersistentVolumes, StorageClasses, ClusterRoles/ClusterRoleBindings, IngressClasses, CustomResourceDefinitions, and Namespaces themselves. `kubectl api-resources --namespaced=false` lists them. Namespaced examples: Pods, Services, Deployments, ConfigMaps, Secrets, PVCs, Roles.

**Q: How would you run a canary using only labels?** *(senior)*
A: Give stable and canary Deployments the same broad label the Service selects (`app=web`) plus a distinguishing `track`/`version`. The Service fans out across both; traffic split ≈ replica ratio. Promote/rollback by scaling replicas or deleting the canary Deployment — the endpoints controller updates the slice automatically, no Service edit.

**Q: Why is a Deployment's `.spec.selector` immutable, and what does that imply?** *(senior)*
A: The selector defines which Pods (and ReplicaSets) the Deployment *owns*; mutating it could orphan or hijack Pods and break controller ownership invariants. Implication: design your label schema up front — changing selection semantics requires deleting and recreating the Deployment (blue/green the change).

**Q: A namespace is stuck in `Terminating`. What's happening and how do you debug?** *(senior)*
A: Cascading deletion is blocked by a finalizer on some object inside (often a CRD whose controller is gone, or a stuck `kubernetes` finalizer). Inspect `kubectl get ns x -o yaml` and the offending resources; remove or fix the finalizer (as a last resort, patch `spec.finalizers` via the API). Root cause is usually a missing controller, not the namespace itself.

**Q: How do ResourceQuota and LimitRange interact?**
A: ResourceQuota caps *aggregate* usage/object counts per namespace and, once CPU/memory quotas exist, *rejects* Pods that don't declare requests/limits. LimitRange sets *per-Pod/container* defaults, mins and maxes — so it can inject the requests that make quota-constrained Pods admissible. Use them together.

**Q: How does the well-known `app.kubernetes.io/*` label set help?** *(senior)*
A: It's a shared vocabulary (`name`, `instance`, `version`, `component`, `part-of`, `managed-by`) that tooling — dashboards, meshes, Helm, kubectl plugins — understands without per-team config. Adopting it makes cross-cutting queries ("show everything in the `checkout` app") and observability consistent cluster-wide.

---

## 10. Practice

- [ ] Create a `staging` namespace with a ResourceQuota (4 CPU / 8Gi) and a LimitRange defaulting container requests to 100m/128Mi; deploy a Pod with no requests and confirm the default is injected.
- [ ] Run two Deployments (`v1` ×3, `v2` ×1) behind one Service using a shared `app` label; verify the EndpointSlice holds 4 IPs and traffic splits.
- [ ] Use `kubectl get pods -l 'env in (prod,staging),!canary' -L version` to filter and column-print labels.
- [ ] Apply a default-deny NetworkPolicy in a namespace and confirm cross-namespace curl now fails.
- [ ] Add `app.kubernetes.io/part-of=checkout` to three related workloads and query them all with one selector.

---

## 11. Cheat Sheet

> [!TIP]
> **Namespaces isolate, labels select, annotations describe.**
> - Namespace = name scope + quota + RBAC (API-server enforced, *not* a network boundary).
> - Cluster-scoped: Nodes, PV, StorageClass, ClusterRole, CRD, Namespace.
> - Service routing = `.spec.selector` (equality only) → EndpointSlice → kube-proxy.
> - Deployment selector must be satisfied by Pod-template labels, and is **immutable**.
> - Selectors: `k=v`, `k!=v` (equality); `k in (a,b)`, `k notin (c)`, `k`, `!k` (set-based).
> - `kubectl get po -l 'env=prod,!canary' -L version`; `kubectl label po x canary=true`; `kubectl label po x canary-`.
> - Labels = low-cardinality identity; annotations = anything you don't select on.
> - Pair ResourceQuota with LimitRange; add default-deny NetworkPolicy per namespace.

**References:** Kubernetes docs — Namespaces, Labels and Selectors, Recommended Labels, Resource Quotas; kubernetes.io Blog — EndpointSlices

---
*Kubernetes Handbook — topic 04.*
