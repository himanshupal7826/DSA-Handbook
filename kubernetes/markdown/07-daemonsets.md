# 07 · DaemonSets

> **In one line:** A DaemonSet guarantees **exactly one copy of a pod on every (matching) node** — the controller for node-level agents like CNI, log shippers, and metrics collectors.

---

## 1. Overview

Some software has to run **per node**, not per request. A log collector must tail every node's container logs; a CNI plugin must program every node's networking; a metrics agent must read every node's kernel counters; storage drivers, node exporters, and security agents are all the same shape. Running these as a Deployment is wrong — a Deployment places N pods *somewhere*, with no guarantee of one-per-node coverage.

A **DaemonSet** fills that gap. It ensures that **as nodes join the cluster, a pod is scheduled onto them**, and **as nodes leave, their pods are garbage-collected**. You don't set `replicas`; the replica count *is* the number of matching nodes. Add a node → the DaemonSet pod appears automatically. Cordon/drain/remove a node → its pod goes away.

Reach for a DaemonSet whenever the workload is a **node agent**: it needs host-level access (host network, host paths, privileged), and it must exist wherever there are nodes to observe or serve.

## 2. Core Concepts

- **One pod per node** — the DaemonSet controller creates a pod on each eligible node and keeps that invariant as the node set changes.
- **No `replicas` field** — coverage is derived from node count and selectors, not a fixed number.
- **`nodeSelector` / affinity** — restrict to a subset of nodes (e.g. only GPU nodes, only `role=storage`). The DaemonSet then runs only there.
- **Tolerations** — DaemonSets usually **tolerate taints** (including control-plane and `NoSchedule` taints) so the agent runs *everywhere*, even on tainted/special nodes. The default controller adds tolerations for unreachable/not-ready so pods aren't evicted during transient node problems.
- **Host access** — commonly `hostNetwork: true`, `hostPID`, and `hostPath` volumes to read `/var/log`, `/proc`, `/sys`, or the container runtime socket.
- **Scheduling** — the default scheduler places DaemonSet pods (using node affinity injected by the controller); it respects taints/tolerations and resource fit.
- **Rolling update** — `updateStrategy: RollingUpdate` with `maxUnavailable` (and `maxSurge` in newer versions) rolls the agent node-by-node; `OnDelete` updates only when you delete a pod.
- **Priority & criticality** — node agents are usually given a high `priorityClassName` (e.g. `system-node-critical`) so they aren't preempted.

## 3. Syntax & Examples

A node-level log shipper on every node, including tainted control-plane nodes:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: fluent-bit
  namespace: logging
spec:
  selector:
    matchLabels: { app: fluent-bit }
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1        # roll one node at a time
  template:
    metadata:
      labels: { app: fluent-bit }
    spec:
      priorityClassName: system-node-critical
      tolerations:
        - operator: Exists      # tolerate ALL taints -> run on every node
      containers:
        - name: fluent-bit
          image: fluent/fluent-bit:3.0
          resources:
            requests: { cpu: 50m, memory: 64Mi }
            limits:   { memory: 128Mi }
          volumeMounts:
            - name: varlog
              mountPath: /var/log
              readOnly: true
            - name: containers
              mountPath: /var/lib/docker/containers
              readOnly: true
      volumes:
        - name: varlog
          hostPath: { path: /var/log }
        - name: containers
          hostPath: { path: /var/lib/docker/containers }
```

Restrict a DaemonSet to a node subset (e.g. only GPU nodes):

```yaml
spec:
  template:
    spec:
      nodeSelector:
        hardware: gpu           # runs only on nodes labeled hardware=gpu
```

## 4. Worked Example

Apply it and confirm one pod per node:

```bash
kubectl apply -f fluent-bit.yaml
kubectl get nodes
kubectl get pods -n logging -o wide -l app=fluent-bit
```

```text
# 3 worker nodes + 1 control-plane node = 4 pods (control-plane tolerated)
NAME                READY   STATUS    NODE
fluent-bit-4k2mz    1/1     Running   node-1
fluent-bit-7xq9p    1/1     Running   node-2
fluent-bit-pd8ct    1/1     Running   node-3
fluent-bit-zc1rn    1/1     Running   control-plane-1
```

The DaemonSet status reports desired == current == ready per node:

```bash
kubectl get ds fluent-bit -n logging
```

```text
NAME         DESIRED   CURRENT   READY   UP-TO-DATE   AVAILABLE   NODE SELECTOR   AGE
fluent-bit   4         4         4       4            4           <none>          2m
```

Add a node and the DESIRED count and pod count automatically rise to 5 — no config change. Drain and delete a node and it drops back to 4.

## 5. Under the Hood

The DaemonSet controller lists nodes, filters them by the pod template's `nodeSelector`/affinity and taint tolerations, and for every matching node that lacks a pod it creates one — injecting a node affinity term that pins the pod to that specific node. The scheduler then binds it (respecting resources and taints). Node add/remove events re-trigger reconciliation, so coverage self-heals.

```svg
<svg viewBox="0 0 720 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="arr" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="22" text-anchor="middle" fill="#1e293b" font-weight="600">DaemonSet — one pod per matching node</text>

  <!-- controller -->
  <rect x="270" y="40" width="180" height="40" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="360" y="65" text-anchor="middle" fill="#1e293b">DaemonSet controller</text>

  <!-- nodes -->
  <g>
    <rect x="30" y="130" width="200" height="140" rx="8" fill="none" stroke="#475569"/>
    <text x="130" y="150" text-anchor="middle" fill="#64748b">node-1</text>
    <rect x="55" y="165" width="150" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
    <text x="130" y="190" text-anchor="middle" fill="#1e293b">agent pod</text>
    <rect x="55" y="215" width="150" height="34" rx="8" fill="none" stroke="#94a3b8" stroke-dasharray="3 3"/>
    <text x="130" y="237" text-anchor="middle" fill="#64748b">app pods…</text>

    <rect x="260" y="130" width="200" height="140" rx="8" fill="none" stroke="#475569"/>
    <text x="360" y="150" text-anchor="middle" fill="#64748b">node-2</text>
    <rect x="285" y="165" width="150" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
    <text x="360" y="190" text-anchor="middle" fill="#1e293b">agent pod</text>
    <rect x="285" y="215" width="150" height="34" rx="8" fill="none" stroke="#94a3b8" stroke-dasharray="3 3"/>
    <text x="360" y="237" text-anchor="middle" fill="#64748b">app pods…</text>

    <rect x="490" y="130" width="200" height="140" rx="8" fill="none" stroke="#475569"/>
    <text x="590" y="150" text-anchor="middle" fill="#64748b">node-3</text>
    <rect x="515" y="165" width="150" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
    <text x="590" y="190" text-anchor="middle" fill="#1e293b">agent pod</text>
    <rect x="515" y="215" width="150" height="34" rx="8" fill="none" stroke="#94a3b8" stroke-dasharray="3 3"/>
    <text x="590" y="237" text-anchor="middle" fill="#64748b">app pods…</text>
  </g>

  <line x1="330" y1="80" x2="130" y2="128" stroke="#475569" marker-end="url(#arr)"/>
  <line x1="360" y1="80" x2="360" y2="128" stroke="#475569" marker-end="url(#arr)"/>
  <line x1="390" y1="80" x2="590" y2="128" stroke="#475569" marker-end="url(#arr)"/>

  <text x="360" y="292" text-anchor="middle" fill="#64748b">new node → controller adds a pod · node removed → pod GC'd</text>
</svg>
```

## 6. Variations & Trade-offs

| Aspect | DaemonSet | Deployment |
|---|---|---|
| Placement | one pod per (matching) node | N pods placed anywhere by scheduler |
| Count control | derived from node count | explicit `replicas` |
| Scales with | nodes | you (HPA/manual) |
| Typical use | node agents (CNI, logs, metrics) | app/API/worker tiers |
| Host access | common (hostPath/hostNetwork/privileged) | rare |
| New node behavior | pod auto-appears | nothing |

Trade-offs: a DaemonSet's footprint scales with cluster size — a 1000-node cluster runs 1000 agent pods, so **resource requests per agent matter enormously** (a 200Mi agent × 1000 nodes = 200Gi). Rolling updates are slower and riskier than Deployments because you're touching every node; a bad agent image can degrade the whole fleet, so use conservative `maxUnavailable` and canary via node labels.

## 7. Production / Performance Notes

- **Right-size requests/limits** — multiply by node count. Small over-provisioning per agent becomes huge cluster-wide.
- **`priorityClassName: system-node-critical`** so agents aren't preempted and node-critical function survives resource pressure.
- **Tolerations breadth is a decision**: `operator: Exists` (tolerate all) runs everywhere including control-plane; narrower tolerations skip special nodes. Pick deliberately.
- **Canary agents** by pairing a `nodeSelector` on a label you flip on a few nodes before rolling to all — safer than a cluster-wide `RollingUpdate` blast.
- **`maxUnavailable: 1`** (or a small percent) for critical agents; a full-speed roll can blind your logging/metrics fleet momentarily.
- **hostPath security** — read-only mounts where possible; privileged/hostNetwork agents are a big attack surface, so pin images and use PodSecurity/OPA policies.
- Managed add-ons (kube-proxy, CNI, CSI node plugins) already ship as DaemonSets — know that when you count node capacity.

## 8. Common Mistakes

1. ⚠️ **Setting `replicas` on a DaemonSet.** There's no such field; coverage is per-node. Fix: use `nodeSelector`/affinity to scope, not a count.
2. ⚠️ **Agent missing from control-plane or tainted nodes.** No matching toleration. Fix: add tolerations (`operator: Exists` or the specific taint key).
3. ⚠️ **Under-estimating fleet cost.** A "small" agent × hundreds of nodes eats real memory/CPU. Fix: set tight requests and measure at scale.
4. ⚠️ **Cluster-wide rollout of a broken image.** All nodes lose the agent at once. Fix: canary by node label, conservative `maxUnavailable`.
5. ⚠️ **Using a Deployment for a node agent.** No per-node guarantee; some nodes uncovered. Fix: use a DaemonSet.
6. ⚠️ **hostPath typo / wrong runtime log path.** Agent runs but collects nothing. Fix: verify the node's actual log/runtime paths.
7. ⚠️ **No priority class**, so the agent gets preempted under pressure exactly when you need telemetry. Fix: `system-node-critical`.

## 9. Interview Questions

**Q: What guarantee does a DaemonSet provide?**
A: One pod per node for every node that matches the pod's `nodeSelector`/affinity and tolerates its taints. Pods appear automatically on new nodes and are removed when nodes leave.

**Q: How do you control which nodes a DaemonSet runs on?**
A: `nodeSelector` or node affinity narrows the eligible node set; tolerations widen it to tainted nodes. Together they define exactly where the agent runs.

**Q: Why don't DaemonSets have a `replicas` field?**
A: Because the desired count is a function of the (matching) node set, not a fixed number. The controller keeps one pod per eligible node and reconciles as nodes join/leave.

**Q: How does a DaemonSet pod get scheduled onto its node?**
A: The DaemonSet controller injects a node-affinity term pinning the pod to a specific node; the default scheduler then binds it, honoring taints, tolerations, and resource fit.

**Q: How do you make a DaemonSet run on control-plane nodes?**
A: Add tolerations for the control-plane taints (e.g. `node-role.kubernetes.io/control-plane:NoSchedule`) or a blanket `tolerations: [{operator: Exists}]` to tolerate all taints.

**Q: How do rolling updates work for a DaemonSet? (senior)**
A: `updateStrategy: RollingUpdate` updates pods node-by-node bounded by `maxUnavailable` (and `maxSurge` where supported). `OnDelete` updates a node's pod only when you delete it manually — useful for cautious, hand-controlled rollouts.

**Q: A DaemonSet pod is Pending on some nodes. What are the likely causes? (senior)**
A: Insufficient node resources for the pod's requests, a taint the pod doesn't tolerate, a `nodeSelector`/affinity that excludes the node, or the node being cordoned/unschedulable. Check the pod's events and the node's taints/allocatable.

**Q: Why is per-pod resource sizing especially critical for DaemonSets? (senior)**
A: Footprint scales linearly with node count, so a small per-agent over-request multiplies across the whole fleet (e.g. 128Mi × 800 nodes = 100Gi). Tight, measured requests/limits prevent large hidden capacity loss.

**Q: How would you safely canary a new agent version across a large cluster?**
A: Gate the DaemonSet on a node label, flip the label on a handful of nodes to roll there first, validate telemetry, then expand. Combine with a small `maxUnavailable` on the eventual full roll.

**Q: Name three canonical DaemonSet workloads and why they fit.**
A: CNI plugin (must program networking on every node), log shipper like Fluent Bit (tails every node's logs), and node metrics exporter (reads each node's `/proc`, `/sys`). All are node-scoped agents needing host access.

## 10. Practice

- [ ] Deploy a DaemonSet and confirm DESIRED == number of schedulable nodes with `kubectl get ds`.
- [ ] Add a toleration so it also runs on the control-plane node; verify the extra pod.
- [ ] Label two nodes and scope the DaemonSet with `nodeSelector`; confirm it only runs there.
- [ ] Perform a `RollingUpdate` with `maxUnavailable: 1` and watch it roll node-by-node.
- [ ] Cordon and drain a node; observe the DaemonSet pod removed, then uncordon and see it return.

## 11. Cheat Sheet

> [!TIP]
> **DaemonSet =** one pod per (matching) node — no `replicas`.
> Scope with **`nodeSelector`/affinity**, reach tainted nodes with **`tolerations`** (`operator: Exists` = everywhere).
> Node joins → pod auto-added · node leaves → pod GC'd.
> Host access: `hostPath` `/var/log` `/proc` `/sys`, `hostNetwork`, privileged.
> Update: `RollingUpdate` + `maxUnavailable`, or `OnDelete`; use `system-node-critical` priority.
> Cost scales with node count — size requests tightly. Uses: CNI, log/metrics agents, CSI node plugins.

**References:** Kubernetes docs "DaemonSet", "Taints and Tolerations", "Assigning Pods to Nodes", Fluent Bit / node-exporter Kubernetes deployment guides

---
*Kubernetes Handbook — topic 07.*
