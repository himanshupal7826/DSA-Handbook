# 02 · Pods

> **In one line:** The smallest deployable unit — one or more co-located containers.

---

## 1. Overview

A **Pod** wraps one or more containers that share a network namespace (same IP/port space) and storage. Pods are **ephemeral** — you rarely create them directly; controllers (Deployments) manage their lifecycle and replacement.

## 2. Key Concepts

- Containers in a pod share the network and can share volumes.
- Sidecar pattern: helper container alongside the main app.
- Init containers run to completion before app containers start.
- Pods are mortal — replaced, not healed, on failure.
- Each pod gets a cluster-internal IP.

## 3. Syntax & Code

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: web
spec:
  containers:
    - name: app
      image: nginx:1.27
      ports: [{containerPort: 80}]
      resources:
        requests: {cpu: "100m", memory: "128Mi"}
        limits: {cpu: "500m", memory: "256Mi"}
```

## 4. Worked Example

**Init container**

Wait for a dependency before starting the app:

```yaml
initContainers:
  - name: wait-db
    image: busybox
    command: ['sh','-c','until nc -z db 5432; do sleep 1; done']
```

## 5. Best Practices

- ✅ Manage pods via Deployments, not directly.
- ✅ Set resource requests and limits.
- ✅ Use sidecars for logging/proxy concerns.
- ✅ Use init containers for setup/wait logic.
- ✅ Add liveness/readiness probes.

## 6. Common Pitfalls

1. ⚠️ Creating bare pods (no self-healing/rollout).
2. ⚠️ Missing resource requests → poor scheduling/eviction.
3. ⚠️ Assuming a pod IP is stable (it isn't across restarts).
4. ⚠️ Putting unrelated apps in one pod.
5. ⚠️ No probes → traffic to unready pods.
6. ⚠️ Relying on pod-local storage for persistence.

## 7. Interview Questions

1. **Q: What is a pod?**
   A: The smallest deployable unit: one or more containers sharing network/storage namespaces.

2. **Q: Why multiple containers in a pod?**
   A: Tightly-coupled helpers (sidecars) that must share IP/volumes, e.g., a log shipper or proxy.

3. **Q: Init containers vs sidecars?**
   A: Init containers run to completion before app start; sidecars run alongside the app.

4. **Q: Are pods self-healing?**
   A: Not by themselves — controllers like Deployments recreate failed pods.

5. **Q: Why set requests/limits?**
   A: Requests guide scheduling; limits cap usage and prevent noisy neighbors.

6. **Q: Is a pod IP stable?**
   A: No — it changes on recreation; use Services for stable access.

7. **Q: What are probes?**
   A: Liveness (restart if dead) and readiness (gate traffic) health checks.

8. **Q: Should you create pods directly?**
   A: Rarely — use Deployments/Jobs for lifecycle management.

## 8. Practice

- [ ] Write a pod with requests/limits and a probe.
- [ ] Add an init container that waits for a service.
- [ ] Explain why a bare pod won't self-heal.

## 9. Quick Revision

Pod = smallest unit, 1+ containers sharing network/storage, ephemeral. Use Deployments to manage them; set requests/limits and probes; sidecars/init containers for helpers; pod IPs aren't stable.

**References:** Pods

---

*Kubernetes Handbook — topic 02.*
