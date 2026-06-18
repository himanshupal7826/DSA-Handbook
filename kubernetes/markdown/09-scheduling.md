# 09 · Scheduling, Affinity & Taints

> **In one line:** Control which nodes pods land on.

---

## 1. Overview

The scheduler places pods on nodes using resource requests plus constraints: **nodeSelector/affinity** (attract pods to nodes), **taints/tolerations** (repel pods unless tolerated), and **pod (anti-)affinity** (co-locate or spread pods). These ensure performance, isolation, and high availability.

## 2. Key Concepts

- nodeSelector/nodeAffinity steer pods to labeled nodes.
- Taints repel pods; matching tolerations allow scheduling.
- Pod anti-affinity spreads replicas across nodes/zones.
- topologySpreadConstraints balance across topology domains.
- Requests must fit a node's allocatable resources.

## 3. Syntax & Code

```yaml
affinity:
  podAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector: {matchLabels: {app: web}}
        topologyKey: kubernetes.io/hostname  # spread across nodes
tolerations:
  - {key: gpu, operator: Exists, effect: NoSchedule}
```

## 4. Worked Example

**Dedicate nodes via taints**

Taint GPU nodes; only GPU pods tolerate them:

```bash
kubectl taint nodes gpu-1 gpu=true:NoSchedule
```

## 5. Best Practices

- ✅ Spread replicas with anti-affinity/topology constraints for HA.
- ✅ Use taints to reserve nodes (GPU/spot/system).
- ✅ Label nodes meaningfully for affinity.
- ✅ Keep requests realistic so scheduling succeeds.
- ✅ Prefer soft (preferred) rules unless hard placement is required.

## 6. Common Pitfalls

1. ⚠️ Over-constraining → pods Pending (unschedulable).
2. ⚠️ Taints without tolerations stranding workloads.
3. ⚠️ All replicas on one node (no anti-affinity) → single point of failure.
4. ⚠️ Confusing node affinity (pods↔nodes) with pod affinity (pods↔pods).
5. ⚠️ Hard rules where soft would do.
6. ⚠️ Ignoring resource fit when adding constraints.

## 7. Interview Questions

1. **Q: How does the scheduler choose a node?**
   A: Filters nodes by requests/constraints, then scores and picks the best fit.

2. **Q: nodeSelector vs nodeAffinity?**
   A: Both attract pods to nodes; affinity is more expressive (operators, soft/hard).

3. **Q: Taints and tolerations?**
   A: Taints repel pods from nodes; only pods with matching tolerations schedule there.

4. **Q: Pod anti-affinity use?**
   A: Spread replicas across nodes/zones for high availability.

5. **Q: Why might a pod stay Pending?**
   A: No node satisfies its requests/constraints (over-constrained or insufficient resources).

6. **Q: topologySpreadConstraints?**
   A: Evenly distribute pods across topology domains (zones/nodes).

7. **Q: Hard vs soft rules?**
   A: required (must) vs preferred (best-effort) scheduling constraints.

8. **Q: Reserve nodes for special workloads?**
   A: Taint the nodes and add matching tolerations to those workloads.

## 8. Practice

- [ ] Spread a Deployment with pod anti-affinity.
- [ ] Taint a node and schedule a tolerating pod.
- [ ] Diagnose a Pending pod from over-constrained affinity.

## 9. Quick Revision

Scheduler = requests + constraints. Affinity attracts (pods↔nodes), taints/tolerations repel, anti-affinity/topology spread for HA. Avoid over-constraining (Pending); reserve nodes with taints.

**References:** Assigning pods to nodes

---

*Kubernetes Handbook — topic 09.*
