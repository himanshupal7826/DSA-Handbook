# 18 · Taints & Tolerations

> **In one line:** Taints let a node *repel* pods that don't explicitly tolerate it — the mechanism behind dedicated nodes, node-condition eviction, and keeping general workloads off special hardware.

---

## 1. Overview

Affinity is a pod saying "I want to be here." **Taints** are the opposite: a *node* saying "nothing runs here unless it holds a matching permission slip." That permission slip is a **toleration** on the pod. Together they implement *repulsion* — the yin to affinity's yang.

The canonical use is **dedicated nodes**: taint your GPU boxes, your spot instances, or your system nodes so ordinary pods can't drift onto them and crowd out the workloads they're reserved for. Only pods that carry the matching toleration are even considered by the scheduler. Kubernetes itself uses taints heavily under the hood — control-plane nodes are tainted `node-role.kubernetes.io/control-plane:NoSchedule`, and the node lifecycle controller taints nodes that go `NotReady` or run out of disk so workloads drain away.

The key mental model: **a toleration does not attract a pod, it only permits it.** Tolerating a GPU taint means the pod *may* land on GPU nodes, not that it *will*. To actively pull a pod onto specific nodes you still need affinity/nodeSelector. Taints repel; affinity attracts; real "dedicated node" setups use both.

## 2. Core Concepts

- **Taint** — a key/value/effect triple on a node: `dedicated=gpu:NoSchedule`. Applied with `kubectl taint`, removed with a trailing `-`.
- **Toleration** — a matching rule on a pod's spec that lets it ignore a taint. Matches by `key`, `operator` (`Equal`/`Exists`), `value`, and `effect`.
- **Effect `NoSchedule`** — hard: the scheduler will not place a non-tolerating pod here. Existing pods are untouched.
- **Effect `PreferNoSchedule`** — soft: the scheduler *tries* to avoid the node but will use it if nothing else fits.
- **Effect `NoExecute`** — hard *and* retroactive: non-tolerating pods already running are **evicted**. New non-tolerating pods won't schedule.
- **tolerationSeconds** — with `NoExecute`, a bounded grace period: tolerate the taint for N seconds, then get evicted. Powers the default 300s node-unreachable behavior.
- **operator `Exists`** — match any value (even any key, if key is omitted) for that effect. `operator: Exists` with empty key tolerates *everything* — used by DaemonSets/critical add-ons.
- **Built-in taints** — the node controller auto-applies `node.kubernetes.io/not-ready`, `unreachable`, `memory-pressure`, `disk-pressure`, `pid-pressure`, `unschedulable` (cordon).
- **Multiple taints** — a pod must tolerate *every* `NoSchedule`/`NoExecute` taint on a node to run there; unmatched ones each independently block it.

## 3. Syntax & Examples

**Add / inspect / remove a taint:**

```bash
kubectl taint nodes gpu-node-1 dedicated=gpu:NoSchedule     # add
kubectl describe node gpu-node-1 | grep -A2 Taints           # inspect
kubectl taint nodes gpu-node-1 dedicated=gpu:NoSchedule-     # remove (trailing -)
```

**Toleration matching a specific taint (Equal):**

```yaml
spec:
  tolerations:
    - key: "dedicated"
      operator: "Equal"
      value: "gpu"
      effect: "NoSchedule"
```

**Tolerate any value for a key (Exists):**

```yaml
  tolerations:
    - key: "dedicated"
      operator: "Exists"
      effect: "NoSchedule"
```

**NoExecute with a bounded eviction grace period:**

```yaml
  tolerations:
    - key: "node.kubernetes.io/not-ready"
      operator: "Exists"
      effect: "NoExecute"
      tolerationSeconds: 300      # stay 5 min after node goes NotReady
```

**Tolerate everything (typical for a DaemonSet / critical add-on):**

```yaml
  tolerations:
    - operator: "Exists"          # no key, no effect → matches all taints
```

## 4. Worked Example

**Goal: reserve GPU nodes for GPU jobs only.** Taint repels everyone; toleration + node affinity attracts only the GPU workload.

```bash
# 1. Label and taint the GPU nodes
kubectl label node gpu-1 gpu-2 accelerator=nvidia-a100
kubectl taint node gpu-1 gpu-2 dedicated=gpu:NoSchedule
```

```yaml
# 2. GPU workload: tolerates the taint AND is attracted by affinity
apiVersion: apps/v1
kind: Deployment
metadata: { name: trainer }
spec:
  replicas: 2
  selector: { matchLabels: { app: trainer } }
  template:
    metadata: { labels: { app: trainer } }
    spec:
      tolerations:
        - { key: dedicated, operator: Equal, value: gpu, effect: NoSchedule }
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - { key: accelerator, operator: In, values: ["nvidia-a100"] }
      containers:
        - name: trainer
          image: my/trainer:latest
          resources:
            limits: { nvidia.com/gpu: 1 }
```

Verify the isolation:

```bash
kubectl get pods -o wide            # trainer pods only on gpu-1/gpu-2
kubectl run web --image=nginx       # a normal pod...
kubectl get pod web -o wide         # ...never lands on the GPU nodes
```

```text
NAME         READY   STATUS    NODE
trainer-a    1/1     Running   gpu-1
trainer-b    1/1     Running   gpu-2
web          1/1     Running   worker-3     # repelled from gpu-1/gpu-2
```

Without the toleration, `trainer` would be Pending; without the affinity, `trainer` could also land on ordinary nodes (toleration permits, it doesn't pin).

## 5. Under the Hood

Taints are a **filter-phase** consideration. The `TaintToleration` plugin checks, for each node, whether the pod tolerates every `NoSchedule`/`NoExecute` taint; unmatched taints eliminate the node from the feasible set. `PreferNoSchedule` taints instead lower the node's score. Separately, the **node lifecycle controller** (in kube-controller-manager) applies `NoExecute` taints on unhealthy nodes and the **TaintManager** evicts pods that don't tolerate them (respecting `tolerationSeconds`).

```svg
<svg viewBox="0 0 760 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="arr2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
    <marker id="arrR" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#b91c1c"/>
    </marker>
  </defs>
  <text x="380" y="24" text-anchor="middle" fill="#1e293b" font-weight="700">Taint repels · Toleration permits · Affinity attracts</text>

  <!-- pods on left -->
  <rect x="30" y="60" width="150" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="105" y="80" text-anchor="middle" fill="#1e293b">GPU pod</text>
  <text x="105" y="97" text-anchor="middle" fill="#64748b" font-size="11">toleration + affinity</text>

  <rect x="30" y="130" width="150" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="105" y="150" text-anchor="middle" fill="#1e293b">GPU pod (no aff.)</text>
  <text x="105" y="167" text-anchor="middle" fill="#64748b" font-size="11">toleration only</text>

  <rect x="30" y="200" width="150" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="105" y="220" text-anchor="middle" fill="#1e293b">web pod</text>
  <text x="105" y="237" text-anchor="middle" fill="#64748b" font-size="11">no toleration</text>

  <!-- GPU node -->
  <rect x="470" y="55" width="250" height="120" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="595" y="78" text-anchor="middle" fill="#1e293b" font-weight="600">gpu-1</text>
  <text x="595" y="97" text-anchor="middle" fill="#d97706" font-size="11">taint dedicated=gpu:NoSchedule</text>
  <text x="595" y="114" text-anchor="middle" fill="#64748b" font-size="11">label accelerator=nvidia-a100</text>

  <!-- worker node -->
  <rect x="470" y="200" width="250" height="90" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="595" y="228" text-anchor="middle" fill="#1e293b" font-weight="600">worker-3</text>
  <text x="595" y="247" text-anchor="middle" fill="#64748b" font-size="11">no taint</text>

  <!-- arrows -->
  <line x1="180" y1="83" x2="468" y2="100" stroke="#059669" marker-end="url(#arr2)"/>
  <text x="330" y="78" text-anchor="middle" fill="#059669" font-size="11">scheduled (pinned)</text>

  <line x1="180" y1="150" x2="468" y2="130" stroke="#475569" stroke-dasharray="4 3" marker-end="url(#arr2)"/>
  <line x1="180" y1="153" x2="468" y2="230" stroke="#475569" stroke-dasharray="4 3" marker-end="url(#arr2)"/>
  <text x="330" y="185" text-anchor="middle" fill="#64748b" font-size="11">may land on either (toleration ≠ attraction)</text>

  <line x1="180" y1="223" x2="468" y2="245" stroke="#059669" marker-end="url(#arr2)"/>
  <line x1="300" y1="215" x2="465" y2="110" stroke="#b91c1c" stroke-dasharray="5 4" marker-end="url(#arrR)"/>
  <text x="360" y="315" text-anchor="middle" fill="#b91c1c" font-size="11">web repelled from gpu-1 (no toleration for NoSchedule taint)</text>

  <text x="380" y="345" text-anchor="middle" fill="#64748b" font-size="11">NoExecute would also EVICT an already-running non-tolerating pod</text>
</svg>
```

The default tolerations Kubernetes injects into every pod are why a briefly-unreachable node doesn't instantly dump its pods: the admission controller adds `not-ready` and `unreachable` `NoExecute` tolerations with `tolerationSeconds: 300`, giving the node 5 minutes to recover before eviction.

## 6. Variations & Trade-offs

| Effect | New pods (no toleration) | Running pods (no toleration) | Typical use |
|---|---|---|---|
| **NoSchedule** | blocked | left running | dedicated nodes, control-plane |
| **PreferNoSchedule** | avoided if possible | left running | soft reservation, best-effort isolation |
| **NoExecute** | blocked | **evicted** (after `tolerationSeconds`) | node conditions, draining, hard isolation |

Taints vs affinity for isolation: **node affinity alone can't reserve a node** — other pods with no affinity rule are still free to land there. Only a taint actively keeps them out. Conversely, a taint alone doesn't guarantee your special pods go *to* the special nodes. The robust pattern is **taint (repel everyone) + toleration (let mine past) + nodeAffinity/nodeSelector (pull mine in)**. `PreferNoSchedule` trades guarantee for graceful degradation; use it when idle special nodes are acceptable overflow capacity.

## 7. Production / Performance Notes

- **Dedicated-node recipe = taint + toleration + affinity.** Skipping the affinity is the most common half-measure; tolerating pods then leak onto ordinary nodes.
- **DaemonSets tolerate broadly.** Log/monitoring agents add `operator: Exists` tolerations so they run everywhere, including tainted and `NotReady` nodes. Kubernetes auto-adds several to DaemonSet pods.
- **Cluster Autoscaler + taints:** for scale-from-zero, register taints on the node group so the autoscaler simulates them; otherwise it may add nodes that can't actually host the pending pods. Use the `--ignore-taint` / ASG tag conventions your provider documents.
- **NoExecute eviction timing** is governed by `tolerationSeconds`; the platform default of 300s for `not-ready`/`unreachable` balances flappy-node churn against failover speed. Tighten for fast failover, lengthen for flaky networks.
- **`kubectl cordon`** adds the `node.kubernetes.io/unschedulable:NoSchedule` taint; `kubectl drain` cordons then evicts. Both are taint-driven under the hood.
- **Spot/preemptible nodes** are commonly tainted so only interruption-tolerant workloads (with tolerations) run there, protecting stateful services.

## 8. Common Mistakes

1. ⚠️ **Tainting a node and expecting your pods to move there.** A toleration only *permits*; it doesn't attract. *Fix:* add nodeAffinity/nodeSelector to actually pull the pods in.
2. ⚠️ **Toleration `value`/`effect` mismatch.** `Equal` requires key+value+effect to match exactly; a typo silently fails to tolerate. *Fix:* copy the taint triple exactly, or use `operator: Exists`.
3. ⚠️ **Using `NoExecute` without realizing it evicts running pods.** Applying it to a busy node dumps every non-tolerating pod immediately. *Fix:* use `NoSchedule` unless you intend eviction; set `tolerationSeconds` for a grace window.
4. ⚠️ **Over-broad `operator: Exists` with empty key on app pods.** That tolerates *every* taint, letting the pod onto unhealthy/dedicated nodes. *Fix:* scope tolerations to the specific key/effect.
5. ⚠️ **Forgetting the trailing `-` to remove a taint**, or removing with a mismatched effect. *Fix:* `kubectl taint nodes <n> key=value:Effect-` must match the existing taint.
6. ⚠️ **Scale-from-zero fails because the autoscaler doesn't know the node group is tainted.** *Fix:* declare taints on the node-group template so the autoscaler simulates feasibility.
7. ⚠️ **Assuming control-plane nodes run workloads.** They carry a `NoSchedule` taint by design. *Fix:* add the toleration only for true system add-ons, not app workloads.

## 9. Interview Questions

**Q: What's the difference between a taint and a toleration, and which lives where?**
A: A **taint** lives on a *node* and repels pods; a **toleration** lives on a *pod* and lets it ignore a matching taint. Taints are the node's "keep out" sign; tolerations are the pod's permission to enter. Neither attracts — a toleration only allows scheduling, it doesn't pull the pod onto the node.

**Q: Explain the three taint effects.**
A: `NoSchedule` blocks new non-tolerating pods but leaves running ones alone. `PreferNoSchedule` is a soft version — the scheduler avoids the node but will use it if necessary. `NoExecute` blocks new non-tolerating pods *and* evicts already-running ones (after any `tolerationSeconds`), making it both a scheduling filter and a runtime eviction trigger.

**Q: A pod tolerates a node's taint but still isn't scheduling there. Why might that be?**
A: A toleration doesn't attract — it only permits. The scheduler may prefer other feasible nodes for bin-packing or scoring reasons. To force the pod onto the tainted nodes you need nodeAffinity/nodeSelector in addition to the toleration. Other blockers: unmatched *other* taints on the node, insufficient resources, or unsatisfied affinity.

**Q: How do you reserve a set of nodes exclusively for one team's workload?**
A: Three parts. Taint the nodes (`dedicated=team-a:NoSchedule`) so nobody else can land. Add the matching toleration to that team's pods so they're permitted. Add nodeAffinity/nodeSelector on a node label (`dedicated=team-a`) so their pods are actually drawn to those nodes. Optionally enforce with an admission policy so only the team's namespace can add the toleration.

**Q: What is `tolerationSeconds` and where is it used by default?**
A: With a `NoExecute` toleration it bounds how long a pod may keep running on a node whose taint it tolerates before eviction. Kubernetes auto-injects `not-ready` and `unreachable` tolerations with `tolerationSeconds: 300` into every pod, so a node that becomes NotReady has 5 minutes to recover before its pods are evicted — preventing thrash on transient blips.

**Q: How do `kubectl cordon` and `kubectl drain` relate to taints?**
A: `cordon` applies the `node.kubernetes.io/unschedulable:NoSchedule` taint (and sets `.spec.unschedulable`), stopping new pods. `drain` cordons and then evicts existing pods (honoring PodDisruptionBudgets). Both are taint-driven mechanisms for taking a node out of service, e.g. before maintenance.

**Q: Why do DaemonSet pods usually have very broad tolerations?**
A: A DaemonSet is meant to run on *every* node — including tainted, control-plane, and even `NotReady` nodes (for logging/monitoring you especially want data from unhealthy nodes). So they carry `operator: Exists` tolerations, and Kubernetes automatically adds tolerations for several node-condition taints to DaemonSet pods.

**Q: You have GPU nodes tainted `NoSchedule`. Your training pods tolerate it but occasionally schedule onto non-GPU nodes and fail. What's wrong?**
A: The toleration permits GPU nodes but doesn't restrict the pod *to* them. Non-GPU nodes have no taint, so nothing repels the pod there. Add nodeAffinity/nodeSelector on the GPU label (or request the `nvidia.com/gpu` extended resource, which only GPU nodes advertise) so the scheduler only considers GPU nodes.

**Q: How do taints and node affinity differ as isolation mechanisms, and when do you need both?**
A: Node affinity is *opt-in from the pod's side* — it only constrains pods that declare it; other pods ignore it and can still use the node. A taint is *enforced from the node's side* — it repels everyone by default. Affinity attracts specific pods; a taint excludes everyone else. For a true dedicated node you need both: the taint keeps outsiders off, the affinity draws the intended pods on.

**Q: What happens when a node reports memory pressure?**
A: The node lifecycle controller taints it `node.kubernetes.io/memory-pressure:NoSchedule`, so the scheduler stops placing new BestEffort pods there, while the kubelet's eviction logic reclaims memory locally. It's a coordinated signal: the taint steers scheduling away while eviction handles the running set.

## 10. Practice

- [ ] Taint a node `env=prod:NoSchedule`, deploy a pod without a toleration, and confirm it stays Pending with the taint cited in the event.
- [ ] Add the matching toleration and confirm the pod schedules; then remove the taint with the trailing `-`.
- [ ] Apply a `NoExecute` taint to a node running pods and watch non-tolerating pods get evicted (`kubectl get pods -w`).
- [ ] Build the full dedicated-node recipe (taint + toleration + nodeAffinity) and prove a normal pod never lands there.
- [ ] Inspect the auto-injected `not-ready`/`unreachable` tolerations on any running pod with `kubectl get pod <p> -o yaml | grep -A6 tolerations`.

## 11. Cheat Sheet

> [!TIP]
> **Taint = node repels; Toleration = pod's permission; Affinity = pod's attraction.**
> - Taint form: `key=value:Effect`. Add `kubectl taint node N key=value:Effect`; remove with trailing `-`.
> - Effects: `NoSchedule` (block new) · `PreferNoSchedule` (avoid) · `NoExecute` (block new **+ evict running**, honors `tolerationSeconds`).
> - Toleration matches by `key` + `operator` (`Equal`/`Exists`) + `value` + `effect`. `Exists` + empty key = tolerate everything.
> - **Dedicated node = taint + toleration + nodeAffinity.** Toleration alone permits but never pins.
> - Built-in taints: `not-ready`, `unreachable`, `memory/disk/pid-pressure`, `unschedulable` (cordon). Pods get default 300s `NoExecute` tolerations.
> - DaemonSets tolerate broadly; cordon/drain are taints; tell the Cluster Autoscaler about taints for scale-from-zero.

**References:** Kubernetes docs — "Taints and Tolerations", "Assigning Pods to Nodes"; kube-controller-manager node lifecycle docs; Cluster Autoscaler FAQ.

---
*Kubernetes Handbook — topic 18.*
