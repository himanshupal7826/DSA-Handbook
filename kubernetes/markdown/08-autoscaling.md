# 08 · Autoscaling (HPA/VPA/Cluster)

> **In one line:** Scale pods and nodes automatically to match load.

---

## 1. Overview

Kubernetes scales at three levels: **HPA** adds/removes pod replicas based on metrics (CPU/memory/custom), **VPA** adjusts pod resource requests, and the **Cluster Autoscaler** adds/removes nodes when pods can't be scheduled. Requests/limits and the metrics-server underpin all of it.

## 2. Key Concepts

- HPA scales replicas to hit a target metric (e.g., 70% CPU).
- Needs metrics-server (or custom/external metrics adapter).
- VPA right-sizes requests/limits (often recommend-only).
- Cluster Autoscaler grows/shrinks the node pool.
- Accurate requests are essential for correct scaling.

## 3. Syntax & Code

```bash
kubectl autoscale deploy web --cpu-percent=70 --min=2 --max=10
kubectl get hpa web
```

## 4. Worked Example

**HPA manifest**

Declarative target utilization:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
spec:
  scaleTargetRef: {kind: Deployment, name: web}
  minReplicas: 2
  maxReplicas: 10
  metrics: [{type: Resource, resource: {name: cpu, target: {type: Utilization, averageUtilization: 70}}}]
```

## 5. Best Practices

- ✅ Set accurate resource requests (HPA bases CPU% on requests).
- ✅ Install metrics-server for resource metrics.
- ✅ Use custom/external metrics for queue-driven scaling.
- ✅ Combine HPA + Cluster Autoscaler for full elasticity.
- ✅ Tune min/max and stabilization to avoid flapping.

## 6. Common Pitfalls

1. ⚠️ HPA without metrics-server (no scaling).
2. ⚠️ Missing/incorrect requests skewing CPU%.
3. ⚠️ Running HPA and VPA on the same resource conflicting.
4. ⚠️ Scaling thrash from tight thresholds (add stabilization).
5. ⚠️ maxReplicas too low to absorb spikes.
6. ⚠️ Forgetting nodes also need to scale (Cluster Autoscaler).

## 7. Interview Questions

1. **Q: What does HPA scale?**
   A: The number of pod replicas, based on observed metrics vs a target.

2. **Q: HPA prerequisite?**
   A: A metrics source (metrics-server) and meaningful resource requests.

3. **Q: HPA vs VPA?**
   A: HPA changes replica count; VPA changes per-pod resource requests/limits.

4. **Q: What is the Cluster Autoscaler?**
   A: It adds/removes nodes when pods are unschedulable or nodes are underutilized.

5. **Q: Why are requests critical for HPA?**
   A: CPU utilization is computed as usage/requests; wrong requests mislead scaling.

6. **Q: How to scale on a queue length?**
   A: Custom/external metrics (e.g., KEDA) feeding the HPA.

7. **Q: How to prevent flapping?**
   A: Stabilization windows and sensible thresholds/min-max.

8. **Q: Can HPA and VPA coexist?**
   A: Not on the same resource metric without conflict; combine carefully or use VPA in recommend mode.

## 8. Practice

- [ ] Create an HPA targeting 70% CPU with min/max.
- [ ] Load-test and watch replicas scale.
- [ ] Explain how Cluster Autoscaler complements HPA.

## 9. Quick Revision

HPA scales replicas on metrics (needs metrics-server + accurate requests), VPA right-sizes requests, Cluster Autoscaler scales nodes. Combine HPA+CA; tune min/max + stabilization to avoid thrash.

**References:** HPA

---

*Kubernetes Handbook — topic 08.*
