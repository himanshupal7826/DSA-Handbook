# 03 · Deployments & ReplicaSets

> **In one line:** Declarative, self-healing, rolling-updated pod management.

---

## 1. Overview

A **Deployment** manages a **ReplicaSet** that keeps a desired number of identical pods running. It provides self-healing, **rolling updates** (gradual replacement), and **rollbacks** — the standard way to run stateless apps.

## 2. Key Concepts

- Deployment → ReplicaSet → Pods (ownership chain).
- Rolling update replaces pods gradually (maxSurge/maxUnavailable).
- Rollback to a previous revision on failure.
- Self-healing: failed pods are recreated to match replicas.
- Selectors/labels tie a Deployment to its pods.

## 3. Syntax & Code

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: {name: web}
spec:
  replicas: 3
  selector: {matchLabels: {app: web}}
  strategy:
    rollingUpdate: {maxSurge: 1, maxUnavailable: 0}
  template:
    metadata: {labels: {app: web}}
    spec:
      containers:
        - {name: web, image: myapp:1.2}
```

## 4. Worked Example

**Update and rollback**

Ship a new image, then revert if it misbehaves:

```bash
kubectl set image deploy/web web=myapp:1.3
kubectl rollout status deploy/web
kubectl rollout undo deploy/web   # rollback
```

## 5. Best Practices

- ✅ Use Deployments for stateless apps.
- ✅ Set maxUnavailable=0 for zero-downtime rollouts.
- ✅ Add readiness probes so rollouts wait for healthy pods.
- ✅ Keep replicas ≥ 2 for availability.
- ✅ Version images (no latest) for reliable rollbacks.

## 6. Common Pitfalls

1. ⚠️ latest image tags breaking rollback/repeatability.
2. ⚠️ No readiness probe → traffic to unready pods mid-rollout.
3. ⚠️ maxUnavailable too high causing downtime.
4. ⚠️ Mismatched selector/labels orphaning pods.
5. ⚠️ Single replica = no availability.
6. ⚠️ Manual pod edits fighting the controller.

## 7. Interview Questions

1. **Q: Deployment vs ReplicaSet?**
   A: A Deployment manages ReplicaSets and adds rolling updates/rollbacks; ReplicaSet just maintains replica count.

2. **Q: How do rolling updates work?**
   A: Pods are replaced gradually per maxSurge/maxUnavailable, keeping the app available.

3. **Q: How to roll back?**
   A: kubectl rollout undo to a prior revision.

4. **Q: How is self-healing achieved?**
   A: The controller recreates pods to match the declared replica count.

5. **Q: Why readiness probes during rollout?**
   A: So new pods receive traffic only when healthy, preventing errors.

6. **Q: Zero-downtime config?**
   A: maxUnavailable=0, maxSurge>=1, plus readiness probes and ≥2 replicas.

7. **Q: Why avoid latest tags?**
   A: Rollbacks/repeatability break when the tag's content changes.

8. **Q: How does a Deployment select its pods?**
   A: Via label selectors matching the pod template's labels.

## 8. Practice

- [ ] Create a 3-replica Deployment and update its image.
- [ ] Trigger and watch a rolling update with rollout status.
- [ ] Roll back to the previous revision.

## 9. Quick Revision

Deployment → ReplicaSet → Pods: self-healing + rolling updates + rollback. Versioned images, readiness probes, maxUnavailable=0, ≥2 replicas for zero-downtime.

**References:** Deployments

---

*Kubernetes Handbook — topic 03.*
