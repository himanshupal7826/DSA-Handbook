# 30 · Lab: Design a Highly-Available Workload

> **In one line:** Take a fragile single-replica Deployment and re-architect it into a workload that survives a pod crash, a node failure, a whole-zone outage, a voluntary drain, and a traffic spike — by layering replicas, spreading, disruption budgets, autoscaling, probes, and resource requests.

---

## 1. The Scenario

You own `checkout`, the service that takes money. It's business-critical, but it was shipped as the default `kubectl create deployment` output and it keeps causing incidents:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: checkout
  namespace: shop
spec:
  replicas: 1                       # (1) single point of failure
  selector:
    matchLabels: { app: checkout }
  template:
    metadata:
      labels: { app: checkout }
    spec:
      containers:
        - name: checkout
          image: ghcr.io/acme/checkout:2.3.0
          ports: [{ containerPort: 8080 }]
          # (2) no resource requests → scheduler packs blindly, no HPA signal
          # (3) no probes → traffic hits pods that aren't ready; hangs never restart
      # (4) no anti-affinity / spread → all replicas can land on one node/zone
# (5) no PodDisruptionBudget → a node drain can take every replica at once
# (6) no HPA → can't absorb a Black-Friday spike
```

The incident log reads like a checklist of what's missing: a `kubectl drain` for a node upgrade took checkout fully offline; a spot-node reclamation killed the only pod; a zone blip during a sale caused a 12-minute outage; and a traffic spike melted the single replica. The task: **make `checkout` highly available against every one of those failure modes**, with rationale you can defend in a design review, and prove it.

## 2. Approach

A senior doesn't reach for one setting — they enumerate the **failure domains** and cover each:

- **Single process dies** (bug, OOM) → need **multiple replicas** so one death isn't an outage, and **probes** so a hung pod is restarted and a not-ready pod is pulled from the Service.
- **A node fails** (hardware, spot reclaim) → replicas must be **spread across nodes**, not stacked — otherwise one node takes several down.
- **A whole zone fails** (AZ outage) → replicas must be **spread across zones** too. With ≥3 replicas across 3 zones, losing one zone leaves you at 2/3 capacity, still serving.
- **Voluntary disruption** (`kubectl drain`, cluster upgrade, autoscaler consolidation) → a **PodDisruptionBudget** caps how many pods the eviction API may remove at once, so a rolling node upgrade can't drain all replicas simultaneously.
- **Load spike** → a **HorizontalPodAutoscaler** adds replicas on CPU/latency, and resource **requests** give both the scheduler bin-packing signal and the HPA its denominator.
- **Bad rollout** → a conservative `RollingUpdate` (`maxUnavailable: 0`) keeps full capacity during deploys.

The unifying principle: **redundancy the failure domains can't correlate.** Three replicas mean nothing if they share one node or one zone. The math to remember: to tolerate losing one zone *and* keep a PDB `minAvailable`, you need enough replicas that `replicas − max(zone_size, disruption) ≥ minAvailable`. With 3 zones and `replicas: 6`, one zone loss removes 2, leaving 4.

## 3. Solution

A complete, defensible manifest. Every block maps to a failure domain from the approach.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: checkout
  namespace: shop
  labels: { app: checkout }
spec:
  replicas: 3                              # ≥3: survive losing one and still have redundancy
  revisionHistoryLimit: 5
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0                     # never drop below desired capacity mid-deploy
      maxSurge: 1                           # add one extra pod, then retire an old one
  selector:
    matchLabels: { app: checkout }
  template:
    metadata:
      labels: { app: checkout }
    spec:
      # --- spread across NODES: never two checkout pods on the same node ---
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:   # HARD: one-per-node
            - labelSelector:
                matchLabels: { app: checkout }
              topologyKey: kubernetes.io/hostname
      # --- spread across ZONES: even distribution, tolerate a zone loss ---
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule                  # enforce even zone spread
          labelSelector:
            matchLabels: { app: checkout }
      terminationGracePeriodSeconds: 30
      containers:
        - name: checkout
          image: ghcr.io/acme/checkout:2.3.0
          ports: [{ containerPort: 8080 }]
          # --- resource requests: scheduler signal + HPA denominator ---
          resources:
            requests: { cpu: 250m, memory: 256Mi }
            limits:   { memory: 512Mi }        # limit memory (OOM guard); leave CPU burstable
          # --- probes: readiness gates traffic, liveness restarts hangs, startup guards slow boot ---
          startupProbe:                        # give slow starts time before liveness kicks in
            httpGet: { path: /healthz, port: 8080 }
            failureThreshold: 30
            periodSeconds: 2                   # up to 60s to become live
          readinessProbe:                      # remove from Service endpoints when not ready
            httpGet: { path: /ready, port: 8080 }
            periodSeconds: 5
            failureThreshold: 3
          livenessProbe:                       # restart a wedged process
            httpGet: { path: /healthz, port: 8080 }
            periodSeconds: 10
            failureThreshold: 3
          lifecycle:
            preStop:                           # drain in-flight requests before SIGTERM
              exec: { command: ["sleep", "5"] }
---
# --- voluntary-disruption guard: keep a quorum during drains/upgrades ---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: checkout
  namespace: shop
spec:
  minAvailable: 2                            # eviction API may never take us below 2 healthy pods
  selector:
    matchLabels: { app: checkout }
---
# --- absorb load spikes: scale 3→10 on CPU, with sane scale-down damping ---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: checkout
  namespace: shop
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: checkout
  minReplicas: 3
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target: { type: Utilization, averageUtilization: 60 }   # % of the 250m request
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300        # wait 5m of low load before scaling in (avoid flapping)
---
apiVersion: v1
kind: Service
metadata:
  name: checkout
  namespace: shop
spec:
  selector: { app: checkout }
  ports: [{ port: 80, targetPort: 8080 }]
```

## 4. Walkthrough

Each block answers a specific incident from the scenario:

- **`replicas: 3` + RollingUpdate `maxUnavailable: 0`** — three copies mean a single crash is invisible to users, and deploys surge a new pod before retiring an old one, so capacity never dips. This directly fixes the spot-reclaim outage.
- **`podAntiAffinity` (required, `topologyKey: hostname`)** — a *hard* rule that no two checkout pods share a node. Now a node failure kills at most one replica. Because it's `required`, if you have fewer schedulable nodes than replicas, extra pods stay Pending — a deliberate signal that your node pool is too small for the HA you asked for.
- **`topologySpreadConstraints` (`maxSkew: 1`, `topologyKey: zone`, `DoNotSchedule`)** — forces near-even distribution across zones, so 3 replicas land one-per-zone. A full-zone outage now removes exactly one replica; the Service keeps serving from the other two. This fixes the 12-minute zone-blip outage.
- **`resources.requests`** — two jobs. The scheduler uses them to place pods on nodes with capacity (and to honor the spread math), and the **HPA uses the CPU request as the denominator** for `averageUtilization: 60`. Without requests, the HPA has no baseline and can't scale.
- **Probes** — the trio covers the pod lifecycle: **startupProbe** gives a slow-booting app up to 60s before liveness can kill it; **readinessProbe** pulls a pod out of the Service's endpoints the instant it can't serve (so traffic never hits a warming or overloaded pod); **livenessProbe** restarts a wedged process. The `preStop` sleep lets in-flight requests finish before SIGTERM, avoiding 502s on scale-down and rollout. This fixes "traffic hits pods that aren't ready" and "hangs never restart."
- **PodDisruptionBudget `minAvailable: 2`** — the eviction API (used by `kubectl drain`, cluster-autoscaler, node upgrades) will refuse to evict a pod if doing so would drop healthy pods below 2. A rolling node upgrade now proceeds one node at a time, waiting for rescheduled pods to become ready. This fixes the drain-took-everything-offline incident.
- **HPA `3→10` at 60% CPU with a 300s scale-down window** — adds replicas under load and removes them only after 5 minutes of calm, preventing thrash. This fixes the traffic-spike meltdown.

Together they form defense in depth: **PDB protects voluntary disruptions, anti-affinity + spread protect involuntary ones (node/zone), probes + replicas protect process failures, and the HPA protects against load.**

```svg
<svg viewBox="0 0 760 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ahL" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="380" y="22" text-anchor="middle" fill="#1e293b" font-weight="700">One pod per node, one node per zone — spread across failure domains</text>

  <!-- three zones -->
  <rect x="30" y="45" width="220" height="150" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="140" y="66" text-anchor="middle" fill="#1e293b" font-weight="600">zone us-east-1a</text>
  <rect x="270" y="45" width="220" height="150" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="380" y="66" text-anchor="middle" fill="#1e293b" font-weight="600">zone us-east-1b</text>
  <rect x="510" y="45" width="220" height="150" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="620" y="66" text-anchor="middle" fill="#1e293b" font-weight="600">zone us-east-1c</text>

  <!-- nodes + pods -->
  <rect x="55" y="80" width="170" height="95" rx="8" fill="#ffffff" stroke="#475569"/>
  <text x="140" y="99" text-anchor="middle" fill="#64748b">node-a</text>
  <rect x="80" y="112" width="120" height="46" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="140" y="132" text-anchor="middle" fill="#1e293b" font-weight="600">checkout-x1</text>
  <text x="140" y="149" text-anchor="middle" fill="#64748b">Ready</text>

  <rect x="295" y="80" width="170" height="95" rx="8" fill="#ffffff" stroke="#475569"/>
  <text x="380" y="99" text-anchor="middle" fill="#64748b">node-b</text>
  <rect x="320" y="112" width="120" height="46" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="380" y="132" text-anchor="middle" fill="#1e293b" font-weight="600">checkout-x2</text>
  <text x="380" y="149" text-anchor="middle" fill="#64748b">Ready</text>

  <rect x="535" y="80" width="170" height="95" rx="8" fill="#ffffff" stroke="#d97706" stroke-dasharray="5 3"/>
  <text x="620" y="99" text-anchor="middle" fill="#64748b">node-c</text>
  <rect x="560" y="112" width="120" height="46" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="620" y="132" text-anchor="middle" fill="#b91c1c" font-weight="600">checkout-x3</text>
  <text x="620" y="149" text-anchor="middle" fill="#64748b">zone down ✗</text>

  <!-- service -->
  <rect x="280" y="235" width="200" height="52" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="380" y="258" text-anchor="middle" fill="#1e293b" font-weight="600">Service: checkout</text>
  <text x="380" y="275" text-anchor="middle" fill="#64748b">endpoints = Ready pods only</text>

  <line x1="140" y1="158" x2="330" y2="235" stroke="#475569" marker-end="url(#ahL)"/>
  <line x1="380" y1="175" x2="380" y2="231" stroke="#475569" marker-end="url(#ahL)"/>
  <line x1="620" y1="158" x2="430" y2="235" stroke="#b91c1c" stroke-dasharray="4 3"/>

  <text x="140" y="305" text-anchor="middle" fill="#64748b">lose 1a</text>
  <text x="620" y="305" text-anchor="middle" fill="#b91c1c" font-style="italic">zone 1c down → readiness pulls x3; 2/3 still serve</text>
</svg>
```

## 5. Variations & Follow-ups

- **Bigger fault tolerance:** to survive a zone loss *and* still honor `minAvailable: 2`, bump `replicas` to 6 (2 per zone across 3 zones). Losing a zone removes 2, leaving 4 ≥ 2.
- **Soft spread when nodes are scarce:** if `required` anti-affinity leaves pods Pending in a small cluster, switch to `preferredDuringScheduling…` (weighted, soft) or set `whenUnsatisfiable: ScheduleAnyway` on the spread constraint — you trade strict guarantees for schedulability.
- **`minDomains` (1.27+)** on the topology spread constraint forces the scheduler to assume a minimum number of zones, so it won't crowd all pods into the only zone that currently has room.
- **Statefulset instead of Deployment** if checkout held state — HA for stateful workloads adds stable identity, PVC-per-pod, and ordered rollout on top of everything here.
- **Latency-based autoscaling:** replace CPU with a custom/`Pods` metric (requests-per-second or p99 latency) via the external metrics API when CPU isn't the true bottleneck.
- **`unhealthyPodEvictionPolicy: AlwaysAllow`** on the PDB (1.27+) so already-broken pods don't block a drain — a subtle but important production tweak-spot fix.

## 6. Verify It Works

Apply, then attack each failure domain and confirm the workload survives.

```bash
$ kubectl apply -f checkout-ha.yaml
deployment.apps/checkout created
poddisruptionbudget.policy/checkout created
horizontalpodautoscaler.autoscaling/checkout created
service/checkout created

# 1. Replicas spread ONE-PER-NODE and ONE-PER-ZONE
$ kubectl -n shop get pods -l app=checkout \
    -o custom-columns=POD:.metadata.name,NODE:.spec.nodeName,ZONE:.metadata.labels.zone
POD               NODE       ZONE
checkout-x1  node-a  us-east-1a
checkout-x2  node-b  us-east-1b
checkout-x3  node-c  us-east-1c        # 3 pods, 3 nodes, 3 zones ✔

# 2. PDB reports a healthy quorum and allowed disruptions
$ kubectl -n shop get pdb checkout
NAME       MIN AVAILABLE   ALLOWED DISRUPTIONS   AGE
checkout   2               1                     30s      # can lose 1, not more ✔

# 3. Drain a node — eviction respects the PDB (blocks, doesn't nuke)
$ kubectl drain node-a --ignore-daemonsets --delete-emptydir-data
evicting pod shop/checkout-x1
# ... waits for a replacement to become Ready elsewhere before continuing ✔

# 4. HPA is reading metrics and ready to scale
$ kubectl -n shop get hpa checkout
NAME       REFERENCE             TARGETS   MINPODS   MAXPODS   REPLICAS
checkout   Deployment/checkout   18%/60%   3         10        3        # live metric ✔

# 5. Kill a pod — Deployment recreates it, Service never sees downtime
$ kubectl -n shop delete pod checkout-x2
$ kubectl -n shop get pods -l app=checkout      # a new pod is already Pending/Running ✔

# 6. Rollout keeps full capacity (maxUnavailable:0)
$ kubectl -n shop set image deploy/checkout checkout=ghcr.io/acme/checkout:2.4.0
$ kubectl -n shop rollout status deploy/checkout
deployment "checkout" successfully rolled out            # zero-downtime ✔
```

If step 1 shows two pods on one node, your cluster has fewer than 3 schedulable nodes or the anti-affinity is soft — check for Pending pods with `kubectl describe`.

## 7. Pitfalls

1. ⚠️ **`required` anti-affinity with fewer nodes than replicas** leaves pods stuck Pending forever. *Fix:* size the node pool for `replicas`, or use `preferred`/`ScheduleAnyway` if strictness isn't worth the Pending risk.
2. ⚠️ **PDB `minAvailable` equal to `replicas`** makes `ALLOWED DISRUPTIONS: 0` — no node can *ever* be drained, blocking every upgrade. *Fix:* leave headroom (`minAvailable: replicas − 1` or a percentage).
3. ⚠️ **HPA with no resource `requests`** can't compute utilization and won't scale (or errors `<unknown>/60%`). *Fix:* always set CPU requests on the target container.
4. ⚠️ **Liveness probe that shares a dependency with readiness** (e.g. both hit the DB) turns a transient DB blip into a mass-restart storm. *Fix:* liveness checks only the process; readiness checks dependencies.
5. ⚠️ **No `preStop`/grace period**, so pods get SIGTERM'd mid-request during scale-down and rollout, returning 502s. *Fix:* `preStop` drain + adequate `terminationGracePeriodSeconds`.
6. ⚠️ **Spread constraint without `minDomains`** lets the scheduler satisfy `maxSkew` by piling pods into the one zone with capacity. *Fix:* set `minDomains` (1.27+) to force real multi-zone placement.

## 8. Interview Follow-ups

**Q: What's the difference between pod anti-affinity and topologySpreadConstraints for HA?**
A: Both spread pods, but anti-affinity is a binary attract/repel relative to matching pods within a topology key — great for "never two on the same node." topologySpreadConstraints express *degree* of evenness via `maxSkew` across a domain, ideal for "distribute evenly across zones." In practice you combine them: required anti-affinity on `hostname` for one-per-node, and a spread constraint on `zone` for even zonal distribution.

**Q: How many replicas do you need to survive a full zone outage while keeping a PDB minAvailable of 2?**
A: Enough that losing the largest zone's share still leaves ≥2. With 3 zones and even spread, each zone holds `replicas/3`. To keep 2 available after one zone dies you need `replicas − replicas/3 ≥ 2`, so `replicas ≥ 3` gives 2 survivors at the edge, but for real headroom you'd run 6 (2 per zone), leaving 4 after a zone loss.

**Q: What does a PodDisruptionBudget actually protect against, and what does it NOT?**
A: A PDB constrains *voluntary* disruptions routed through the eviction API — `kubectl drain`, node upgrades, cluster-autoscaler consolidation — by refusing evictions that would breach `minAvailable`/`maxUnavailable`. It does *not* protect against involuntary disruptions: a hardware failure, kernel panic, or `kubectl delete pod` bypass the eviction API entirely. For those you rely on replicas, anti-affinity, and spread.

**Q: Why must you set resource requests for the HPA to work?**
A: The HPA's CPU utilization target is a percentage *of the request*. It computes `sum(actual CPU) / sum(requested CPU)` and compares to the target. With no request there's no denominator, so utilization is undefined — the HPA reports `<unknown>` and won't scale. Requests are also what the scheduler uses to place pods, so they underpin both scaling and correct spreading.

**Q: Explain the roles of startup, readiness, and liveness probes in an HA design. (senior)**
A: They cover distinct lifecycle phases. The startupProbe protects slow-booting apps: until it passes, liveness/readiness are suppressed, so a long init doesn't get killed. The readinessProbe gates traffic — a failing pod is removed from Service endpoints but not restarted, ideal for transient overload or dependency hiccups. The livenessProbe restarts a genuinely wedged process. Getting readiness vs liveness right is the crux: readiness should reflect "can I serve now," liveness only "is my process alive."

**Q: A rolling node upgrade is stuck — drain won't evict a checkout pod. Why, and is that correct? (senior)**
A: The PDB is doing its job: evicting the pod would drop healthy replicas below `minAvailable`, so the eviction API rejects it until a replacement pod becomes Ready elsewhere. That's correct, protective behavior — it's why the upgrade proceeds one node at a time instead of causing an outage. If it's stuck permanently, the replacement can't schedule (node capacity, `required` anti-affinity) — investigate Pending pods, not the PDB. `unhealthyPodEvictionPolicy: AlwaysAllow` handles the case where the blocked pod is itself unhealthy.

**Q: How does `maxUnavailable: 0` in the rollout strategy interact with the PDB? (senior)**
A: They govern different disruption types but reinforce each other. `maxUnavailable: 0` (with `maxSurge`) controls the *Deployment's own* rolling update — it adds a new pod before removing an old one, so capacity never dips during a deploy. The PDB controls *external* evictions (drains/autoscaler). Together they ensure neither a deploy nor a node operation ever takes you below capacity. Note `maxUnavailable: 0` needs spare scheduling room for the surge pod.

**Q: When would you loosen the `required` anti-affinity to `preferred`?**
A: When strict one-per-node placement would leave pods Pending because the cluster has fewer schedulable nodes than replicas, or during a temporary capacity crunch where availability-now beats perfect spread. `preferred` (weighted, soft) still biases the scheduler toward spreading but allows co-location rather than blocking. The trade-off: you lose the hard guarantee that a single node failure can't take two replicas.

**Q: What's the difference between `whenUnsatisfiable: DoNotSchedule` and `ScheduleAnyway`?**
A: On a topologySpreadConstraint, `DoNotSchedule` is a hard filter — if placing the pod would violate `maxSkew`, it stays Pending. `ScheduleAnyway` makes it a soft preference — the scheduler scores nodes to prefer better spread but will still place the pod if perfect spread isn't possible. Use `DoNotSchedule` for critical multi-zone HA; use `ScheduleAnyway` when schedulability matters more than strict evenness.

**Q: How would you extend this design to a stateful workload?**
A: Switch to a StatefulSet for stable network identity and per-pod PersistentVolumeClaims, keep the anti-affinity/spread/PDB/probes, but respect data-locality: PVs are often zone-bound, so a pod must reschedule into the same zone as its volume — meaning your spread and failover story now involves the storage layer (replicated/multi-AZ volumes or app-level replication like a database's own quorum). HA for stateful apps is as much about the data replication topology as the pod topology.

## 9. Cheat Sheet

> [!TIP]
> **HA = redundancy across uncorrelated failure domains + protection from every disruption type.**
> - **Process death:** `replicas ≥ 3` + readiness (gate traffic) + liveness (restart hangs) + startup (slow boot) probes + `preStop` drain.
> - **Node failure:** `podAntiAffinity` **required** on `topologyKey: kubernetes.io/hostname` → one pod per node.
> - **Zone failure:** `topologySpreadConstraints` `maxSkew:1`, `topologyKey: zone`, `DoNotSchedule` (+`minDomains`) → even zonal spread.
> - **Voluntary disruption (drain/upgrade):** `PodDisruptionBudget minAvailable: N−1` — leave headroom or drains block forever.
> - **Load spike:** `HorizontalPodAutoscaler` on CPU %, with `resources.requests` set (the HPA denominator) and a scale-down stabilization window.
> - **Rollouts:** `RollingUpdate maxUnavailable: 0`, `maxSurge: 1` → never dip below capacity.
> - **Verify:** check one-per-node/zone placement, `ALLOWED DISRUPTIONS ≥ 1`, HPA reading live metrics, then drain a node and delete a pod and watch it self-heal.

**References:** Kubernetes docs — "Pod Topology Spread Constraints", "Assigning Pods to Nodes (Affinity)", "Specifying a Disruption Budget", "Horizontal Pod Autoscaling", "Configure Liveness, Readiness and Startup Probes"; Google SRE Workbook — "Managing Load".

---
*Kubernetes Handbook — topic 30.*
