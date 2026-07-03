# 20 · Autoscaling: HPA, VPA & Cluster Autoscaler

> **In one line:** Kubernetes scales in three dimensions — HPA adds/removes *pods*, VPA right-sizes each pod's *requests*, and the Cluster Autoscaler adds/removes *nodes* — and they must be composed carefully so they don't fight.

---

## 1. Overview

Autoscaling answers "how much capacity right now?" without a human in the loop. Kubernetes splits it across three independent controllers that operate on different objects and time scales.

The **Horizontal Pod Autoscaler (HPA)** changes the **replica count** of a Deployment/StatefulSet based on observed metrics — classically CPU, but also memory, custom app metrics (requests/sec), or external metrics (queue depth). It's the workhorse: scale out under load, scale in when idle.

The **Vertical Pod Autoscaler (VPA)** changes the **resource requests/limits** of pods so each pod gets the right amount of CPU/memory rather than the right *number* of pods. It's ideal for workloads that can't be sharded (a single leader, a JVM) or where you don't know good requests up front.

The **Cluster Autoscaler (CA)** changes the **number of nodes**: when pods are `Pending` because no node has room, it adds nodes; when nodes sit underutilized, it drains and removes them. Newer clusters increasingly use **Karpenter** (AWS) for faster, bin-packed node provisioning. On top of these, **KEDA** extends HPA to event-driven scaling — including **scale-to-zero** — off dozens of sources (Kafka lag, SQS depth, cron). You reach for autoscaling to cut cost at trough and survive spikes without manual intervention.

## 2. Core Concepts

- **HPA control loop** — every ~15s the controller reads metrics, computes `desiredReplicas = ceil(currentReplicas × currentMetric / targetMetric)`, and patches the workload's `replicas`.
- **Metrics sources** — **Resource** (CPU/memory via metrics-server), **Pods** (per-pod custom, averaged), **Object**/**External** (a single metric or off-cluster source) via the custom/external metrics APIs.
- **Target types** — `Utilization` (% of request), `AverageValue` (absolute per-pod), or `Value` (absolute total).
- **Stabilization window** — HPA smooths flapping: `scaleDown.stabilizationWindowSeconds` (default 300s) makes it wait before shrinking; scale-up defaults to 0s (react fast).
- **Scaling policies** — `behavior` lets you cap rate: e.g. "at most 4 pods or 100% every 60s," pick `max`/`min` across policies.
- **VPA modes** — `Off` (recommend only), `Initial` (set at admission), `Recreate`/`Auto` (evict and resize live pods).
- **Cluster Autoscaler** — scales node groups on **Pending** pods (scale-up) and low-utilization nodes (scale-down); respects PDBs, taints, affinity, and `do-not-evict` annotations.
- **Karpenter** — provisioner that launches right-sized nodes directly from pending-pod requirements, faster and with better bin-packing than node-group CA.
- **KEDA** — a metrics adapter + operator that drives an HPA from external event sources and uniquely supports **scale-to-zero**.
- **metrics-server** — the cluster add-on that supplies CPU/memory to HPA/`kubectl top`; without it, resource-based HPA is blind.

## 3. Syntax & Examples

Imperative CPU HPA (quickest):

```bash
kubectl autoscale deployment web --cpu-percent=60 --min=2 --max=10
```

Declarative HPA v2 on CPU utilization with a scale-down stabilization window and rate limits:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: web }
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: web
  minReplicas: 2
  maxReplicas: 20
  metrics:
    - type: Resource
      resource:
        name: cpu
        target: { type: Utilization, averageUtilization: 60 }
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300     # wait 5m before shrinking
      policies:
        - { type: Percent, value: 50, periodSeconds: 60 }   # at most -50%/min
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
        - { type: Pods, value: 4, periodSeconds: 30 }        # at most +4 pods/30s
```

Custom-metric HPA (requests per second per pod):

```yaml
  metrics:
    - type: Pods
      pods:
        metric: { name: http_requests_per_second }
        target: { type: AverageValue, averageValue: "100" }
```

A VPA in recommend-only mode (safest first step):

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata: { name: web-vpa }
spec:
  targetRef: { apiVersion: apps/v1, kind: Deployment, name: web }
  updatePolicy: { updateMode: "Off" }     # only emit recommendations
```

A KEDA `ScaledObject` scaling a consumer off Kafka lag, down to zero:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata: { name: consumer }
spec:
  scaleTargetRef: { name: consumer }
  minReplicaCount: 0            # scale to ZERO when idle
  maxReplicaCount: 50
  triggers:
    - type: kafka
      metadata: { bootstrapServers: kafka:9092, consumerGroup: g1,
                  topic: events, lagThreshold: "500" }
```

## 4. Worked Example

Autoscale a web Deployment on CPU and drive load to watch it react:

```bash
# 1. Ensure metrics-server is installed, then create the HPA
kubectl autoscale deployment web --cpu-percent=50 --min=2 --max=10

# 2. Generate load
kubectl run -it --rm load --image=busybox:1.36 -- \
  sh -c "while true; do wget -q -O- http://web; done"

# 3. Watch the HPA compute desired replicas
kubectl get hpa web -w
```

```text
NAME   REFERENCE        TARGETS         MINPODS   MAXPODS   REPLICAS
web    Deployment/web   18%/50%         2         10        2      # idle
web    Deployment/web   210%/50%        2         10        2      # load hits
web    Deployment/web   210%/50%        2         10        6      # ceil(2*210/50)=9 → capped by policy
web    Deployment/web   72%/50%         2         10        9      # converging
web    Deployment/web   47%/50%         2         10        9      # steady
# ...load stops...
web    Deployment/web   9%/50%          2         10        9      # holds 5m (stabilization window)
web    Deployment/web   9%/50%          2         10        2      # then scales in
```

The scale-*up* is near-instant; the scale-*down* waits out the 300s stabilization window so a brief dip doesn't cause flapping.

## 5. Under the Hood

The three loops stack. HPA reads metrics and edits `replicas`. Those new pods enter the scheduler; if none fit, they go **Pending**, which is the Cluster Autoscaler's trigger to add a node. VPA, meanwhile, watches actual usage and rewrites requests (evicting pods to apply them in `Auto` mode). The danger is coupling: HPA and VPA must not both target CPU/memory, or they chase each other. The standard formula HPA uses is `desired = ceil(current × metric/target)`, clamped to `[min,max]` and then rate-limited by `behavior`.

```svg
<svg viewBox="0 0 720 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a3" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="22" text-anchor="middle" fill="#1e293b" font-weight="bold">The autoscaling control loop</text>

  <rect x="270" y="45" width="180" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="360" y="66" text-anchor="middle" fill="#1e293b">metrics-server /</text>
  <text x="360" y="83" text-anchor="middle" fill="#64748b">custom &amp; external metrics</text>

  <rect x="270" y="130" width="180" height="52" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="360" y="151" text-anchor="middle" fill="#1e293b">HPA controller</text>
  <text x="360" y="169" text-anchor="middle" fill="#64748b">desired = ceil(cur×m/target)</text>

  <rect x="270" y="220" width="180" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="360" y="241" text-anchor="middle" fill="#1e293b">Deployment replicas</text>
  <text x="360" y="258" text-anchor="middle" fill="#64748b">scheduler places pods</text>

  <rect x="270" y="305" width="180" height="46" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="360" y="326" text-anchor="middle" fill="#1e293b">Pending pod?</text>
  <text x="360" y="343" text-anchor="middle" fill="#64748b">Cluster Autoscaler / Karpenter</text>

  <line x1="360" y1="91" x2="360" y2="128" stroke="#475569" marker-end="url(#a3)"/>
  <text x="392" y="114" fill="#64748b">read</text>
  <line x1="360" y1="182" x2="360" y2="218" stroke="#475569" marker-end="url(#a3)"/>
  <text x="392" y="204" fill="#64748b">patch</text>
  <line x1="360" y1="266" x2="360" y2="303" stroke="#475569" marker-end="url(#a3)"/>
  <text x="392" y="288" fill="#64748b">no room</text>
  <!-- feedback -->
  <path d="M270,340 C120,340 120,68 268,68" fill="none" stroke="#475569" marker-end="url(#a3)"/>
  <text x="120" y="200" text-anchor="middle" fill="#64748b" transform="rotate(-90 120 200)">new capacity changes metrics</text>

  <!-- VPA side -->
  <rect x="500" y="130" width="190" height="52" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="595" y="151" text-anchor="middle" fill="#1e293b">VPA</text>
  <text x="595" y="169" text-anchor="middle" fill="#64748b">rewrites requests (evict)</text>
  <line x1="500" y1="156" x2="452" y2="245" stroke="#475569" stroke-dasharray="4 3" marker-end="url(#a3)"/>
  <text x="560" y="215" text-anchor="middle" fill="#b91c1c">don't target same metric as HPA</text>
</svg>
```

## 6. Variations & Trade-offs

| Autoscaler | Scales | Trigger | Best for | Caveat |
|---|---|---|---|---|
| **HPA** | pod count | CPU/mem/custom/external metrics | stateless, shardable services | needs metrics-server; can't scale to 0 (natively) |
| **VPA** | pod requests | historical usage | single-replica/unshardable, unknown sizing | evicts pods to resize; conflicts with HPA on same metric |
| **Cluster Autoscaler** | node count | Pending pods / idle nodes | node-level cost | node-group bound; slower; honors PDBs |
| **Karpenter** | node count | Pending pods (just-in-time) | fast, bin-packed nodes (AWS) | provider-specific |
| **KEDA** | pod count (incl. 0) | 60+ event sources | queue/event-driven, bursty, cron | adds an operator; wraps HPA |

Rule of thumb: **HPA for throughput, VPA for right-sizing, CA/Karpenter for the node floor, KEDA for event-driven and scale-to-zero.** HPA + VPA can coexist *only* if they scale on different signals (e.g. HPA on RPS, VPA on memory). Use CA/Karpenter under every HPA so scale-out isn't stuck on `Pending`.

## 7. Production / Performance Notes

- **HPA needs good `requests`.** `Utilization` is a percentage of the CPU *request*; a too-low request makes utilization read high and the HPA over-scales. Set realistic requests (VPA in `Off` mode helps you find them).
- **Tune scale-down, not just scale-up.** The 300s stabilization window prevents flapping; shorten it for spiky workloads only with care.
- **Cap velocity with `behavior`.** Protect downstreams from a thundering herd by limiting pods-per-interval on scale-up.
- **PodDisruptionBudgets gate CA scale-down.** Without a PDB, CA can drain a node and take all replicas at once; with too strict a PDB, CA can't consolidate and you overpay.
- **Cold-start cost.** New nodes take 1–5 min (CA) — keep `minReplicas` and some headroom (or overprovisioning pods) for latency-sensitive services.
- **Custom metrics have lag.** External metric adapters poll; a 30–60s delay means HPA reacts late to bursts — KEDA + shorter polling helps.
- **Scale-to-zero belongs to KEDA/Knative,** not vanilla HPA (min is 1). Expect first-request latency after a zero-scale idle.
- **Don't let HPA fight the Deployment's `replicas`.** Once an HPA owns a workload, remove the static `replicas` from GitOps or they'll thrash.

## 8. Common Mistakes

1. ⚠️ **No metrics-server installed.** HPA shows `<unknown>/50%` and never scales. *Fix:* install metrics-server (or the custom metrics adapter).
2. ⚠️ **HPA and VPA both on CPU.** They oscillate — VPA shrinks requests, HPA sees higher utilization, adds pods, repeat. *Fix:* split signals or use VPA in recommend-only mode.
3. ⚠️ **Missing resource requests.** `Utilization` targets are meaningless without a request baseline. *Fix:* always set CPU/memory requests on scaled pods.
4. ⚠️ **HPA maxes out but pods stay `Pending`.** No Cluster Autoscaler, so no nodes are added. *Fix:* enable CA/Karpenter on the node pool.
5. ⚠️ **Flapping replicas.** Scale-down window too short or metric too noisy. *Fix:* raise `scaleDown.stabilizationWindowSeconds`; smooth the metric.
6. ⚠️ **Static `replicas:` in the manifest under an HPA.** GitOps re-applies it and fights the HPA. *Fix:* drop `replicas` from the managed spec.
7. ⚠️ **Scaling on memory expecting reclaim.** Memory isn't compressible; scaling out doesn't reduce an existing pod's RSS. *Fix:* scale on CPU/RPS, use VPA for memory sizing.
8. ⚠️ **No PDB, aggressive CA.** Node consolidation evicts every replica at once → outage. *Fix:* add a PDB (`minAvailable`).

## 9. Interview Questions

**Q: What does each of HPA, VPA, and Cluster Autoscaler scale?**
A: HPA scales the number of pod replicas, VPA scales each pod's CPU/memory requests (and limits), and the Cluster Autoscaler scales the number of nodes. Horizontal = more pods, vertical = bigger pods, cluster = more nodes.

**Q: What formula does the HPA use to compute desired replicas?**
A: `desiredReplicas = ceil(currentReplicas × currentMetricValue / targetMetricValue)`, then clamped to `[minReplicas, maxReplicas]` and rate-limited by any `behavior` policies.

**Q: Why does the HPA scale up fast but scale down slowly by default?**
A: Scale-up stabilization defaults to 0s to react to load immediately, while scale-down uses a 300s stabilization window so a brief drop in traffic doesn't prematurely remove pods and cause flapping.

**Q: What is metrics-server and why is it required for HPA?**
A: It's a cluster add-on that aggregates CPU/memory from kubelets and serves the resource metrics API. Resource-based HPA (and `kubectl top`) read from it; without it, the HPA can't see CPU/memory and won't scale.

**Q: How do you scale on a custom application metric like requests per second?**
A: Expose the metric (e.g. via Prometheus + an adapter) so it's available on the custom metrics API, then use a `type: Pods` (or `Object`/`External`) metric in the HPA v2 spec targeting an `AverageValue` such as 100 rps/pod.

**Q: Why shouldn't HPA and VPA both act on CPU?**
A: They form a feedback loop — VPA lowering requests raises measured utilization, prompting HPA to add pods, which changes usage again. They should scale on different signals, or run VPA in recommend-only (`Off`) mode.

**Q (senior): Your HPA is at maxReplicas but latency is still high and new pods are `Pending`. Walk through the fix.**
A: The bottleneck moved to nodes — the scheduler can't place the extra pods. Enable the Cluster Autoscaler / Karpenter so `Pending` pods trigger node scale-up, verify node-group max isn't hit, and check quotas/taints. Keep headroom or overprovisioning pods to hide the 1–5 min node cold-start.

**Q (senior): What does KEDA add over a plain HPA?**
A: KEDA drives an HPA from 60+ external event sources (Kafka lag, SQS/queue depth, cron, Prometheus) and uniquely supports scale-to-zero. It's the go-to for event-driven, bursty, or idle-heavy workloads where CPU is a poor proxy for load.

**Q (senior): How do PodDisruptionBudgets interact with the Cluster Autoscaler?**
A: CA respects PDBs when draining nodes during scale-down. Without a PDB it may evict all replicas of a service at once; with too strict a PDB it can't consolidate underutilized nodes, so you overpay. You tune `minAvailable`/`maxUnavailable` to allow consolidation without breaking availability.

**Q (senior): Why is autoscaling on memory tricky compared to CPU?**
A: Memory is non-compressible and not reclaimed by adding replicas — an existing pod's RSS doesn't shrink because peers appeared, and a memory-pressured pod is OOM-killed, not throttled. Prefer CPU or a load metric for HPA and use VPA to right-size memory requests.

## 10. Practice

- [ ] Install metrics-server, create a CPU HPA, drive load, and watch `kubectl get hpa -w` scale out then in.
- [ ] Add a `behavior` block that limits scale-up to +4 pods/30s and set a 600s scale-down window; observe the change.
- [ ] Deploy a VPA in `Off` mode and read its recommendations with `kubectl describe vpa`.
- [ ] Configure a KEDA `ScaledObject` on a queue and demonstrate scale-to-zero when the queue drains.
- [ ] Force pods `Pending` (raise replicas past node capacity) and confirm the Cluster Autoscaler (or Karpenter) adds a node.

## 11. Cheat Sheet

> [!TIP]
> **HPA** = replicas, `desired=ceil(cur×metric/target)`, needs metrics-server; scale-up fast (0s), scale-down 300s window; `behavior` caps rate.
> **VPA** = right-sizes requests; modes Off/Initial/Auto; never share a metric with HPA.
> **Cluster Autoscaler / Karpenter** = nodes; scale-up on `Pending`, scale-down on idle; respects PDBs.
> **KEDA** = event-driven HPA + the only easy path to scale-to-zero.
> Always set realistic `requests`; put CA under every HPA; use PDBs; drop static `replicas` when an HPA owns the workload.

**References:** Kubernetes docs — Horizontal Pod Autoscaling; Kubernetes autoscaler repo (VPA + Cluster Autoscaler); KEDA docs; Karpenter docs

---
*Kubernetes Handbook — topic 20.*
