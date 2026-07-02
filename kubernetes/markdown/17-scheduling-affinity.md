# 17 · Scheduling: Affinity & Topology

> **In one line:** Steer pods onto the right nodes — and spread them for HA — using node/pod affinity and topology spread constraints layered on top of the scheduler's filter-and-score pipeline.

---

## 1. Overview

The **kube-scheduler** is the control-plane component that answers one question for every Pending pod: *which node should this run on?* It watches for pods with an empty `.spec.nodeName`, evaluates every feasible node, picks the best one, and writes a **binding** back to the API server. The kubelet on that node then pulls images and starts containers.

Left alone, the scheduler just packs pods wherever they fit. Real workloads need more control: keep GPU jobs on GPU boxes, colocate a cache next to the app that hits it, or — most commonly — **spread replicas across nodes and zones** so one failure doesn't take down the whole service. That control is expressed declaratively through **nodeSelector**, **node affinity**, **pod (anti-)affinity**, and **topologySpreadConstraints**.

You reach for these when default packing produces bad outcomes: all three replicas on one node, latency-sensitive pods far from their data, or expensive hardware sitting idle while general pods crowd it out. They are *constraints on placement*, not runtime behavior — once a pod is scheduled, most of these rules are ignored (the `IgnoredDuringExecution` half of their names).

## 2. Core Concepts

- **Scheduling cycle = Filter + Score.** *Filtering* (predicates) discards nodes that can't run the pod — insufficient resources, unmatched taints, unsatisfied affinity. *Scoring* (priorities) ranks the survivors 0–100; the highest wins. Ties break randomly.
- **nodeSelector** — the simplest steering: a map of label key/values a node must have (`disktype: ssd`). Pure equality, hard requirement, no soft option.
- **Node affinity** — the expressive successor to nodeSelector: `requiredDuringScheduling…` (hard filter) and `preferredDuringScheduling…` (soft, weighted score). Supports operators `In`, `NotIn`, `Exists`, `Gt`, `Lt`.
- **Pod affinity / anti-affinity** — schedule relative to *other pods*. Affinity attracts (put me near pods matching this selector); anti-affinity repels (keep me away). Evaluated within a **topologyKey** domain.
- **topologyKey** — the node label that defines a domain: `kubernetes.io/hostname` (per-node), `topology.kubernetes.io/zone` (per-AZ), `topology.kubernetes.io/region`.
- **topologySpreadConstraints** — the modern, first-class way to spread pods evenly across domains. `maxSkew` bounds the imbalance; `whenUnsatisfiable` is `DoNotSchedule` (hard) or `ScheduleAnyway` (soft).
- **required vs preferred** — hard rules can leave pods **Pending** forever; soft rules only bias the score and always allow scheduling. Choose deliberately.
- **Taints/tolerations** — the *repel* mechanism, covered in topic 18 (Taints & Tolerations); affinity attracts, taints repel — they compose.

## 3. Syntax & Examples

**nodeSelector — the one-liner:**

```yaml
spec:
  nodeSelector:
    disktype: ssd          # node must be labeled disktype=ssd
```

**Node affinity — hard requirement + soft preference:**

```yaml
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:   # MUST match
        nodeSelectorTerms:
          - matchExpressions:
              - key: topology.kubernetes.io/zone
                operator: In
                values: ["us-east-1a", "us-east-1b"]
      preferredDuringSchedulingIgnoredDuringExecution:  # nice to have
        - weight: 80
          preference:
            matchExpressions:
              - key: disktype
                operator: In
                values: ["ssd"]
```

**Pod anti-affinity — spread replicas one-per-node:**

```yaml
spec:
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels: { app: web }
          topologyKey: kubernetes.io/hostname   # no two web pods per node
```

**Pod affinity — colocate cache with app in the same zone:**

```yaml
      podAffinity:
        preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector: { matchLabels: { app: web } }
              topologyKey: topology.kubernetes.io/zone
```

**topologySpreadConstraints — even across zones (preferred modern idiom):**

```yaml
spec:
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: topology.kubernetes.io/zone
      whenUnsatisfiable: DoNotSchedule
      labelSelector:
        matchLabels: { app: web }
```

## 4. Worked Example

Goal: run a 6-replica `web` Deployment across 3 zones, at most 1 skew per zone, and never two replicas on the same node.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: web }
spec:
  replicas: 6
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector: { matchLabels: { app: web } }
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector: { matchLabels: { app: web } }
              topologyKey: kubernetes.io/hostname
      containers:
        - name: web
          image: nginx:1.27
          resources:
            requests: { cpu: "250m", memory: "128Mi" }
```

Apply and inspect placement:

```bash
kubectl apply -f web.yaml
kubectl get pods -l app=web -o wide \
  --sort-by='.spec.nodeName' -o custom-columns=\
POD:.metadata.name,NODE:.spec.nodeName,ZONE:'.metadata.labels'
```

Resulting distribution (2 per zone, 1 per node):

```text
POD          NODE       ZONE
web-a1       node-1a1   us-east-1a
web-a2       node-1a2   us-east-1a
web-b1       node-1b1   us-east-1b
web-b2       node-1b2   us-east-1b
web-c1       node-1c1   us-east-1c
web-c2       node-1c2   us-east-1c
```

If a zone runs out of nodes, `DoNotSchedule` leaves the extra replica **Pending** — `kubectl describe pod` shows `FailedScheduling: node(s) didn't match pod topology spread constraints`.

## 5. Under the Hood

The scheduler runs a two-phase cycle per pod, structured as a **scheduling framework** of plugins with extension points (`PreFilter`, `Filter`, `Score`, `Reserve`, `Bind`). Filtering is parallelized across nodes; scoring sums weighted plugin scores.

```svg
<svg viewBox="0 0 760 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="arr" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="380" y="22" text-anchor="middle" fill="#1e293b" font-weight="700">kube-scheduler cycle: one Pending pod → one node</text>

  <rect x="20" y="45" width="130" height="52" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="85" y="68" text-anchor="middle" fill="#1e293b">Pending pod</text>
  <text x="85" y="85" text-anchor="middle" fill="#64748b" font-size="11">nodeName=""</text>

  <rect x="185" y="45" width="150" height="52" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="260" y="66" text-anchor="middle" fill="#1e293b" font-weight="600">Filter</text>
  <text x="260" y="84" text-anchor="middle" fill="#64748b" font-size="11">drop infeasible nodes</text>

  <rect x="370" y="45" width="150" height="52" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="445" y="66" text-anchor="middle" fill="#1e293b" font-weight="600">Score</text>
  <text x="445" y="84" text-anchor="middle" fill="#64748b" font-size="11">rank 0–100</text>

  <rect x="555" y="45" width="185" height="52" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="647" y="66" text-anchor="middle" fill="#1e293b" font-weight="600">Bind</text>
  <text x="647" y="84" text-anchor="middle" fill="#64748b" font-size="11">write nodeName → API</text>

  <line x1="150" y1="71" x2="180" y2="71" stroke="#475569" marker-end="url(#arr)"/>
  <line x1="335" y1="71" x2="365" y2="71" stroke="#475569" marker-end="url(#arr)"/>
  <line x1="520" y1="71" x2="550" y2="71" stroke="#475569" marker-end="url(#arr)"/>

  <text x="260" y="120" text-anchor="middle" fill="#64748b" font-size="11">predicates: fit, taints, affinity(required)</text>
  <text x="445" y="120" text-anchor="middle" fill="#64748b" font-size="11">priorities: spread, affinity(preferred), balance</text>

  <text x="380" y="160" text-anchor="middle" fill="#1e293b" font-weight="700">Resulting placement (anti-affinity + zone spread)</text>

  <!-- zones -->
  <rect x="40" y="180" width="210" height="130" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="145" y="200" text-anchor="middle" fill="#1e293b" font-weight="600">zone us-east-1a</text>
  <rect x="60" y="215" width="80" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/>
  <text x="100" y="240" text-anchor="middle" fill="#1e293b" font-size="11">web · node-1</text>
  <rect x="150" y="215" width="80" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/>
  <text x="190" y="240" text-anchor="middle" fill="#1e293b" font-size="11">web · node-2</text>

  <rect x="275" y="180" width="210" height="130" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="380" y="200" text-anchor="middle" fill="#1e293b" font-weight="600">zone us-east-1b</text>
  <rect x="295" y="215" width="80" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/>
  <text x="335" y="240" text-anchor="middle" fill="#1e293b" font-size="11">web · node-3</text>
  <rect x="385" y="215" width="80" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/>
  <text x="425" y="240" text-anchor="middle" fill="#1e293b" font-size="11">web · node-4</text>

  <rect x="510" y="180" width="210" height="130" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="615" y="200" text-anchor="middle" fill="#1e293b" font-weight="600">zone us-east-1c</text>
  <rect x="530" y="215" width="80" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/>
  <text x="570" y="240" text-anchor="middle" fill="#1e293b" font-size="11">web · node-5</text>
  <rect x="620" y="215" width="80" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/>
  <text x="660" y="240" text-anchor="middle" fill="#1e293b" font-size="11">web · node-6</text>

  <text x="380" y="295" text-anchor="middle" fill="#64748b" font-size="11">maxSkew=1 across zones · 1 pod per node (hostname anti-affinity)</text>
</svg>
```

Pod affinity/anti-affinity are computationally expensive: the scheduler must compare the candidate against *all matching pods across all nodes* for each topology domain, which is why the docs warn against them in clusters of hundreds of nodes. `topologySpreadConstraints` were introduced (GA in 1.19) as a cheaper, more predictable replacement for the common "spread evenly" case.

## 6. Variations & Trade-offs

| Mechanism | Relationship | Hard option | Soft option | Cost | Best for |
|---|---|---|---|---|---|
| **nodeSelector** | pod → node label | yes (only) | no | trivial | quick, exact node targeting |
| **node affinity** | pod → node label | required | preferred (weighted) | low | rich node targeting, GPU/zone pinning |
| **pod affinity** | pod → pod (colocate) | required | preferred | high | latency-coupled workloads |
| **pod anti-affinity** | pod → pod (spread) | required | preferred | high | HA spread, legacy clusters |
| **topologySpreadConstraints** | pod set → domains | DoNotSchedule | ScheduleAnyway | moderate | even multi-zone/node distribution |

`required` anti-affinity gives *guaranteed* spread but can wedge a rollout (no node available → Pending). `preferred` / `ScheduleAnyway` degrade gracefully — replicas may double up under pressure but the pod always schedules. Production HA usually pairs a **soft** anti-affinity or **ScheduleAnyway** spread with a `PodDisruptionBudget` so availability survives both scheduling pressure and voluntary disruptions.

## 7. Production / Performance Notes

- **Prefer topologySpreadConstraints over pod anti-affinity** for spreading. Cheaper for the scheduler and expresses "even" directly rather than "not on the same node."
- **Kubernetes ships default cluster-level spread constraints** (`minDomains`, node + zone) since 1.24+ via `defaultConstraints` in the scheduler config — check yours before adding redundant per-pod rules.
- **Beware required anti-affinity at scale.** With replicas > nodes in a domain, extra pods stay Pending. Cluster Autoscaler *can* add nodes to satisfy them, but only if it understands the constraint.
- **matchLabelKeys / nodeAffinityPolicy / nodeTaintsPolicy** (1.25–1.27) refine spread: skip pods from older rollouts, or ignore tainted/unaffine nodes when counting domains.
- **Scoring is relative.** A single `preferred` term rarely overrides bin-packing; raise `weight` (max 100) or combine terms if the preference isn't taking effect.
- **Label your nodes consistently.** Cloud providers set `topology.kubernetes.io/zone` and `kubernetes.io/hostname` automatically; custom labels (`disktype`, `gpu`) you must apply and keep in sync.

## 8. Common Mistakes

1. ⚠️ **Over-constraining with `required` rules → pods Pending forever.** *Fix:* start with `preferred`/`ScheduleAnyway`; reserve hard rules for true correctness needs and verify capacity exists.
2. ⚠️ **Confusing node affinity with pod affinity.** Node affinity targets *node labels*; pod affinity targets *other pods* via a topologyKey. *Fix:* ask "am I matching a node or a pod?"
3. ⚠️ **Forgetting `topologyKey` semantics.** `kubernetes.io/hostname` spreads per-node; using a zone key when you meant per-node lets multiple replicas share a node. *Fix:* pick the key that matches your failure domain.
4. ⚠️ **Wrong `labelSelector` in anti-affinity/spread.** Selecting the wrong (or no) label makes the rule a no-op or self-referential. *Fix:* target the app's own pod labels.
5. ⚠️ **All replicas on one node because no spread rule exists.** *Fix:* add topologySpreadConstraints on hostname; a single node failure otherwise kills the service.
6. ⚠️ **maxSkew too tight with too few nodes.** `maxSkew: 1` + `DoNotSchedule` across zones blocks scale-up when a zone can't take its share. *Fix:* loosen skew or use `ScheduleAnyway`.
7. ⚠️ **Expecting affinity to move running pods.** Rules are `IgnoredDuringExecution` — they only apply at scheduling time. *Fix:* use the descheduler to rebalance existing pods.

## 9. Interview Questions

**Q: Walk me through what the scheduler does from the moment a pod is created until it runs on a node.**
A: The pod is created with an empty `.spec.nodeName`. The scheduler watches for such pods, runs the **filter** phase to eliminate infeasible nodes (resource fit, taints, node/pod affinity that's required), then the **score** phase to rank feasible nodes (spread, preferred affinity, resource balancing). It picks the highest-scoring node, does a **Reserve/Bind**, and writes the binding to the API server. The kubelet on that node sees the assignment and starts the containers.

**Q: What's the difference between nodeSelector and node affinity?**
A: `nodeSelector` is a simple equality map — the node must have every listed label; it's hard-only with no expressiveness. Node affinity supports operators (`In`, `NotIn`, `Exists`, `Gt`, `Lt`), multiple terms with OR/AND semantics, and crucially a `preferred` (soft, weighted) mode alongside `required` (hard). Node affinity is the strict superset you should prefer for anything nontrivial.

**Q: When would you use pod anti-affinity versus topologySpreadConstraints?**
A: Both spread pods, but topologySpreadConstraints express "distribute evenly across domains" directly via `maxSkew`, are cheaper for the scheduler, and degrade gracefully with `ScheduleAnyway`. Pod anti-affinity expresses "don't put me near pods matching X," is more general (can reference *other* apps' pods), but is O(pods × nodes) expensive and binary. Use spread constraints for the common even-distribution case; use anti-affinity when the rule references a different pod set or needs "never colocate."

**Q: What does `requiredDuringSchedulingIgnoredDuringExecution` actually mean?**
A: Two phases. `requiredDuringScheduling` = the rule is a hard filter at scheduling time; if unsatisfiable the pod stays Pending. `IgnoredDuringExecution` = once the pod is running, if node labels or neighbor pods change to violate the rule, the pod is **not** evicted. Kubernetes has no `RequiredDuringExecution` variant yet, which is why rebalancing needs the descheduler.

**Q: What is a topologyKey and why does it matter?**
A: It's the node label whose distinct values define the "domains" a rule reasons about. `kubernetes.io/hostname` makes each node a domain (per-node spread); `topology.kubernetes.io/zone` makes each AZ a domain (per-zone spread). It determines the failure domain your HA is protecting against — pick it to match what can fail together.

**Q: A Deployment with `required` pod anti-affinity on hostname is stuck with pods Pending. Why, and how do you fix it?**
A: `required` + hostname means at most one replica per node; if replicas exceed available nodes, the surplus can't schedule. Fix by adding nodes (or letting Cluster Autoscaler do so), switching to `preferred` anti-affinity, or using topologySpreadConstraints with `ScheduleAnyway` so extra pods double up instead of hanging.

**Q: How do affinity and taints/tolerations interact — do they overlap?**
A: They're complementary. Affinity is *attraction* expressed on the pod ("I want to be here"). Taints are *repulsion* expressed on the node ("nothing runs here unless it tolerates me"); tolerations on the pod let it past a taint but don't attract it. A dedicated GPU node typically has both: a taint so only GPU pods land there, plus node affinity on the GPU pods so they seek those nodes.

**Q: Why are pod affinity/anti-affinity discouraged in very large clusters?**
A: Evaluating them requires comparing the candidate pod against all matching pods across all topology domains for every scheduling decision, which scales poorly (roughly pods × nodes). In clusters of hundreds of nodes this materially slows scheduling throughput. topologySpreadConstraints were designed as the more scalable alternative for the spread use case.

**Q: How would you guarantee a service survives a full availability-zone outage?**
A: Spread replicas across ≥3 zones with a topologySpreadConstraint on `topology.kubernetes.io/zone` (`maxSkew: 1`), size replicas so a lost zone still leaves quorum/capacity, add a PodDisruptionBudget to bound voluntary disruptions, and ensure the Cluster Autoscaler has node groups in each zone. Optionally pin critical dependencies with node affinity so they land in surviving zones.

**Q: The scheduler ignored my `preferred` affinity rule. Why?**
A: Preferred rules only add to a node's score; they don't force placement. If other scoring plugins (bin-packing, resource balancing) outweigh it, the preference loses. Raise the `weight` (up to 100), reduce competing signal, or convert to a `required` rule if the placement is truly mandatory.

## 10. Practice

- [ ] Label two nodes `disktype=ssd`/`disktype=hdd` and schedule a pod with `preferred` node affinity toward SSD; confirm placement with `-o wide`.
- [ ] Deploy 4 replicas with `required` hostname anti-affinity on a 3-node cluster; observe the 4th pod Pending and read the `FailedScheduling` event.
- [ ] Convert that anti-affinity to a `topologySpreadConstraints` with `maxSkew: 1`, `ScheduleAnyway`; confirm all 4 schedule.
- [ ] Add a zone-level spread constraint and verify even distribution with a custom-columns query grouped by node/zone.
- [ ] Use `kubectl describe pod` on a Pending pod and identify which predicate failed.

## 11. Cheat Sheet

> [!TIP]
> **Scheduling = Filter (feasible?) then Score (best?).**
> - `nodeSelector`: quick exact node label match, hard-only.
> - `nodeAffinity`: rich node targeting; `required` (hard) vs `preferred` (weighted soft).
> - `podAffinity`: colocate near matching pods; `podAntiAffinity`: spread away — both use a `topologyKey`.
> - `topologySpreadConstraints`: modern even spread; `maxSkew` + `DoNotSchedule`/`ScheduleAnyway`. **Prefer this for HA spread.**
> - Rules are `IgnoredDuringExecution` — placement-time only; use the descheduler to rebalance.
> - Hard rules → risk of **Pending**; soft rules → degrade gracefully. Pair with PodDisruptionBudget for real HA.
> - `topologyKey`: `kubernetes.io/hostname` (per-node), `topology.kubernetes.io/zone` (per-AZ).

**References:** Kubernetes docs — "Assigning Pods to Nodes", "Pod Topology Spread Constraints", "Scheduling Framework"; kube-scheduler design docs; Google Kubernetes Engine best-practices blog.

---
*Kubernetes Handbook — topic 17.*
