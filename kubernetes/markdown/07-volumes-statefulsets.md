# 07 · Persistent Volumes & StatefulSets

> **In one line:** Durable storage and stable identity for stateful apps.

---

## 1. Overview

For stateful workloads, **PersistentVolumes (PV)** provide durable storage, claimed by pods via **PersistentVolumeClaims (PVC)**, often provisioned dynamically by a **StorageClass**. **StatefulSets** give pods stable network identities and ordered, persistent storage (databases, queues).

## 2. Key Concepts

- PVC requests storage; PV (often dynamic via StorageClass) satisfies it.
- StatefulSet pods have stable names (web-0, web-1) and per-pod PVCs.
- Ordered, graceful deployment/scaling/deletion.
- Headless service gives stable per-pod DNS.
- Access modes: RWO, ROX, RWX (storage-dependent).

## 3. Syntax & Code

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata: {name: db}
spec:
  serviceName: db
  replicas: 3
  selector: {matchLabels: {app: db}}
  template:
    metadata: {labels: {app: db}}
    spec:
      containers: [{name: db, image: postgres:16, volumeMounts: [{name: data, mountPath: /var/lib/postgresql/data}]}]
  volumeClaimTemplates:
    - metadata: {name: data}
      spec: {accessModes: [ReadWriteOnce], resources: {requests: {storage: 10Gi}}}
```

## 4. Worked Example

**Stable identity**

Each replica keeps its name and its own volume across restarts:

```bash
kubectl get pods -l app=db   # db-0, db-1, db-2 with persistent PVCs
```

## 5. Best Practices

- ✅ Use StatefulSets for databases/queues needing identity+storage.
- ✅ Use dynamic provisioning via StorageClass.
- ✅ Match access modes to the storage backend.
- ✅ Back up PVs/volumes regularly.
- ✅ Use a headless service for stable pod DNS.

## 6. Common Pitfalls

1. ⚠️ Using a Deployment for stateful apps (no stable identity/storage).
2. ⚠️ Assuming RWX works on block storage (often RWO only).
3. ⚠️ Deleting a StatefulSet without handling PVC retention.
4. ⚠️ Ignoring ordered scaling implications.
5. ⚠️ No backups of persistent data.
6. ⚠️ Reclaim policy deleting data unexpectedly.

## 7. Interview Questions

1. **Q: PV vs PVC?**
   A: PV is the actual storage resource; PVC is a pod's request that binds to a PV.

2. **Q: What does a StorageClass do?**
   A: Defines a provisioner/parameters for dynamic PV creation on demand.

3. **Q: Deployment vs StatefulSet?**
   A: StatefulSet gives stable identities (ordinal names), ordered ops, and per-pod persistent volumes.

4. **Q: What are access modes?**
   A: RWO (one node RW), ROX (many read-only), RWX (many RW) — backend-dependent.

5. **Q: Why a headless service with StatefulSets?**
   A: To give each pod a stable DNS name for peer discovery.

6. **Q: What is a reclaim policy?**
   A: What happens to a PV when its PVC is deleted: Retain, Delete, or Recycle.

7. **Q: volumeClaimTemplates purpose?**
   A: Auto-creates a unique PVC per StatefulSet pod.

8. **Q: How to scale a database StatefulSet safely?**
   A: Ordered scaling plus app-level replication/clustering and backups.

## 8. Practice

- [ ] Create a StatefulSet with volumeClaimTemplates.
- [ ] Verify stable pod names and per-pod PVCs.
- [ ] Set a Retain reclaim policy and explain why.

## 9. Quick Revision

Stateful apps: PVC→PV (dynamic via StorageClass) for durable storage; StatefulSets add stable identity + per-pod volumes + ordered ops + headless DNS. Mind access modes, reclaim policy, and backups.

**References:** Persistent Volumes; StatefulSets

---

*Kubernetes Handbook — topic 07.*
