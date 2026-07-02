# 06 · StatefulSets & Stable Identity

> **In one line:** A StatefulSet runs a set of pods with **stable, ordered identities** and **per-pod persistent storage** — the workload controller for databases, queues, and anything that cares *which* replica it is.

---

## 1. Overview

A **Deployment** treats its pods as interchangeable cattle: any pod can serve any request, replicas are fungible, and the ReplicaSet creates/deletes them in no particular order with random name suffixes (`web-7d9f-abc12`). That is perfect for stateless web tiers. It falls apart the moment a pod needs to *remember who it is* — a Postgres primary, a Kafka broker, a Zookeeper ensemble member, an etcd node.

A **StatefulSet** solves that. It gives each pod a **stable ordinal identity** (`db-0`, `db-1`, `db-2`), a **stable DNS name** that survives reschedules, and its **own PersistentVolumeClaim** that follows the identity — `db-0` always re-attaches to `db-0`'s data, even on a different node. Pods are created, scaled, and deleted in a **predictable order**, so clustered software can bootstrap (elect a leader, join peers) deterministically.

Reach for a StatefulSet when the answer to "does replica N need durable state or a fixed address that other replicas depend on?" is yes. If replicas are truly identical and stateless, a Deployment is simpler and scales faster.

## 2. Core Concepts

- **Stable network identity** — each pod gets a name `<statefulset>-<ordinal>` (0-indexed) that never changes for the life of that ordinal. Reschedule to another node keeps the name.
- **Ordinal index** — the integer suffix. It orders creation, scaling, updates, and deletion, and is often used by the app itself (e.g. broker id).
- **Headless Service** — a `Service` with `clusterIP: None`. It creates per-pod DNS `db-0.db.ns.svc.cluster.local` instead of load-balancing a single VIP. **Required** and named in `spec.serviceName`.
- **volumeClaimTemplates** — a template that provisions **one PVC per pod**. `db-0` gets `data-db-0`, `db-1` gets `data-db-1`. The PVC is **sticky**: it is *not* deleted when the pod is rescheduled.
- **Ordered, graceful deployment** — pods come up **one at a time, 0 → N-1**; each must be Running & Ready before the next starts (default `podManagementPolicy: OrderedReady`).
- **Ordered scale-down / termination** — scaling down removes pods in **reverse** order (N-1 → 0), one at a time.
- **Update strategy** — `RollingUpdate` (default) updates pods in reverse ordinal order; `partition` lets you do canary/phased rollouts. `OnDelete` = manual.
- **PVC retention** — by default PVCs **outlive** the StatefulSet (data safety). `persistentVolumeClaimRetentionPolicy` (stable in 1.27+) can auto-delete on scale-down/delete.
- **Parallel option** — `podManagementPolicy: Parallel` launches/terminates all pods at once (keeps stable IDs/storage, drops the ordering) for apps that don't need bootstrap ordering.

## 3. Syntax & Examples

Minimal headless Service + StatefulSet:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: db          # must match spec.serviceName below
  labels: { app: db }
spec:
  clusterIP: None   # <-- headless: enables per-pod DNS
  selector: { app: db }
  ports:
    - port: 5432
      name: pg
```

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: db
spec:
  serviceName: db          # ties the StatefulSet to the headless Service
  replicas: 3
  podManagementPolicy: OrderedReady   # default; or Parallel
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      partition: 0         # update ordinals >= partition
  selector:
    matchLabels: { app: db }
  template:
    metadata:
      labels: { app: db }
    spec:
      terminationGracePeriodSeconds: 30
      containers:
        - name: postgres
          image: postgres:16
          ports: [{ containerPort: 5432, name: pg }]
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:                # one PVC per pod
    - metadata: { name: data }
      spec:
        accessModes: [ReadWriteOnce]
        storageClassName: fast-ssd
        resources:
          requests: { storage: 20Gi }
```

Auto-delete PVCs on scale-down and StatefulSet deletion (opt-in):

```yaml
spec:
  persistentVolumeClaimRetentionPolicy:
    whenScaled: Delete      # delete PVCs of removed ordinals when scaling down
    whenDeleted: Retain     # keep PVCs when the StatefulSet is deleted
```

## 4. Worked Example

Deploy the manifest above and watch the ordered bring-up:

```bash
kubectl apply -f db.yaml
kubectl get pods -l app=db -w
```

```text
NAME   READY   STATUS    RESTARTS   AGE
db-0   0/1     Pending   0          0s
db-0   1/1     Running   0          8s     # db-1 does NOT start until db-0 is Ready
db-1   0/1     Pending   0          8s
db-1   1/1     Running   0          15s
db-2   1/1     Running   0          23s
```

Each pod has its own sticky PVC:

```bash
kubectl get pvc -l app=db
```

```text
NAME        STATUS   VOLUME          CAPACITY   ACCESS MODES   STORAGECLASS
data-db-0   Bound    pvc-a1b2...     20Gi       RWO            fast-ssd
data-db-1   Bound    pvc-c3d4...     20Gi       RWO            fast-ssd
data-db-2   Bound    pvc-e5f6...     20Gi       RWO            fast-ssd
```

Resolve a peer by stable DNS from inside the cluster:

```bash
kubectl run t --rm -it --image=busybox --restart=Never -- \
  nslookup db-0.db.default.svc.cluster.local
```

```text
Name:      db-0.db.default.svc.cluster.local
Address 1: 10.244.1.7 db-0.db.default.svc.cluster.local
```

Kill `db-1` — it comes back with the **same name, same DNS, same PVC**, possibly on a new node:

```bash
kubectl delete pod db-1
kubectl get pod db-1 -o wide   # new IP/node, but still "db-1", re-bound to data-db-1
```

## 5. Under the Hood

The StatefulSet controller reconciles toward the desired replica count **one ordinal at a time**. For scale-up it processes 0..N-1: create pod, wait for Running+Ready, provision/bind the templated PVC, then proceed. For scale-down it walks N-1..0. Kube-DNS (CoreDNS) publishes an A record per ready pod under the headless Service domain, which is what makes `db-0.db` resolvable and stable.

```svg
<svg viewBox="0 0 720 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="arr" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="22" text-anchor="middle" fill="#1e293b" font-weight="600">StatefulSet "db" — ordered identity + sticky storage</text>

  <!-- headless service -->
  <rect x="270" y="42" width="180" height="34" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="360" y="64" text-anchor="middle" fill="#1e293b">Headless Service (clusterIP: None)</text>

  <!-- pods -->
  <g>
    <rect x="40" y="120" width="180" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
    <text x="130" y="145" text-anchor="middle" fill="#1e293b" font-weight="600">db-0</text>
    <text x="130" y="165" text-anchor="middle" fill="#64748b">db-0.db.ns.svc</text>

    <rect x="270" y="120" width="180" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
    <text x="360" y="145" text-anchor="middle" fill="#1e293b" font-weight="600">db-1</text>
    <text x="360" y="165" text-anchor="middle" fill="#64748b">db-1.db.ns.svc</text>

    <rect x="500" y="120" width="180" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
    <text x="590" y="145" text-anchor="middle" fill="#1e293b" font-weight="600">db-2</text>
    <text x="590" y="165" text-anchor="middle" fill="#64748b">db-2.db.ns.svc</text>
  </g>

  <!-- service to pods -->
  <line x1="330" y1="76" x2="140" y2="118" stroke="#475569" marker-end="url(#arr)"/>
  <line x1="360" y1="76" x2="360" y2="118" stroke="#475569" marker-end="url(#arr)"/>
  <line x1="390" y1="76" x2="580" y2="118" stroke="#475569" marker-end="url(#arr)"/>

  <!-- PVCs -->
  <rect x="40" y="220" width="180" height="46" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="130" y="248" text-anchor="middle" fill="#1e293b">PVC data-db-0</text>
  <rect x="270" y="220" width="180" height="46" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="360" y="248" text-anchor="middle" fill="#1e293b">PVC data-db-1</text>
  <rect x="500" y="220" width="180" height="46" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="590" y="248" text-anchor="middle" fill="#1e293b">PVC data-db-2</text>

  <line x1="130" y1="180" x2="130" y2="218" stroke="#475569" marker-end="url(#arr)"/>
  <line x1="360" y1="180" x2="360" y2="218" stroke="#475569" marker-end="url(#arr)"/>
  <line x1="590" y1="180" x2="590" y2="218" stroke="#475569" marker-end="url(#arr)"/>

  <text x="360" y="292" text-anchor="middle" fill="#64748b">Create order 0→1→2 · Delete order 2→1→0 · each PVC sticks to its ordinal</text>
</svg>
```

## 6. Variations & Trade-offs

| Aspect | Deployment | StatefulSet |
|---|---|---|
| Pod names | random suffix, fungible | stable `name-0..N-1` |
| Storage | shared/ephemeral, or 1 shared PVC | one sticky PVC per pod via `volumeClaimTemplates` |
| Ordering | none (all at once) | ordered create/scale/delete (default) |
| DNS | one Service VIP | per-pod DNS via headless Service |
| Scale-up speed | fast, parallel | slow, one-at-a-time (unless `Parallel`) |
| Use for | web/API, workers, stateless | databases, Kafka, Zookeeper, etcd, Elasticsearch |

Trade-offs: ordered bring-up is *safer* for quorum systems but *slower*; a 50-pod StatefulSet with a slow-starting image takes a long time to roll. `podManagementPolicy: Parallel` recovers speed when you don't need bootstrap ordering. StatefulSets do **not** manage the PV lifecycle beyond the PVC — the underlying disk lifecycle is the StorageClass's `reclaimPolicy`.

## 7. Production / Performance Notes

- **Always define a PodDisruptionBudget** (`minAvailable`) so voluntary drains don't break quorum (e.g. `minAvailable: 2` for a 3-node ensemble).
- **Anti-affinity** across nodes/zones so `db-0` and `db-1` aren't on the same node — a single node failure shouldn't kill quorum.
- Use a **StorageClass with `volumeBindingMode: WaitForFirstConsumer`** so the PV is provisioned in the same zone the pod is scheduled to (avoids cross-zone attach failures).
- `readinessProbe` gating matters more here: with `OrderedReady`, a pod stuck Not-Ready **blocks the entire rollout**. Make probes reflect true readiness, not just liveness.
- Scaling to 0 keeps PVCs (unless retention policy says otherwise) — a cheap way to "pause" a stateful workload without losing data.
- Updates roll in **reverse ordinal order**; use `partition` for canaries: set `partition: 2` to update only `db-2`, validate, then lower the partition.
- Backups are your responsibility — a StatefulSet protects identity and disk *binding*, not disk *contents*. Snapshot PVs or use app-level backups.

## 8. Common Mistakes

1. ⚠️ **Using a Deployment for a database.** No stable identity, no per-pod storage, replicas fight over one PVC. Fix: use a StatefulSet.
2. ⚠️ **Forgetting the headless Service** or mismatching `serviceName`. Per-pod DNS silently won't resolve. Fix: `clusterIP: None` Service whose name equals `spec.serviceName`.
3. ⚠️ **Expecting PVCs to be deleted with the pod.** They're sticky by design; you leak storage on scale-down. Fix: set `persistentVolumeClaimRetentionPolicy` or clean up manually.
4. ⚠️ **Rollout stuck because a pod never becomes Ready.** `OrderedReady` halts. Fix: correct the readiness probe / image, or use `Parallel` if ordering isn't required.
5. ⚠️ **Using `RWX` assumptions on block storage.** Most block volumes are `ReadWriteOnce`; a pod can't share it. Fix: match `accessModes` to the backend.
6. ⚠️ **No anti-affinity / PDB**, so all replicas land on one node and a drain wipes quorum. Fix: add topology spread + PDB.
7. ⚠️ **Editing `volumeClaimTemplates` after creation.** It's immutable; the change is rejected. Fix: recreate or use a resize on the existing PVCs where the StorageClass allows.

## 9. Interview Questions

**Q: What does a StatefulSet give you that a Deployment does not?**
A: Stable, ordered pod identities (`name-0..N-1`), stable per-pod DNS via a headless Service, and one sticky PersistentVolumeClaim per pod that re-binds to the same ordinal across reschedules. It also creates, scales, updates, and deletes pods in a deterministic order.

**Q: Why is a headless Service required, and what does `clusterIP: None` do?**
A: It disables the single load-balanced VIP and instead publishes a DNS A record per ready pod (`pod-0.svc...`). Clustered apps need to address specific peers by stable name, which only per-pod DNS provides. `spec.serviceName` must point at this headless Service.

**Q: In what order are pods created, scaled down, and updated?**
A: Created 0 → N-1 (each Ready before the next). Scaled down N-1 → 0. RollingUpdate proceeds in reverse ordinal order (highest first). This is the default `OrderedReady` behavior.

**Q: What happens to a pod's storage when it's rescheduled to another node?**
A: Nothing is lost. The PVC created from `volumeClaimTemplates` is bound to the ordinal, not the node. The rescheduled `db-1` re-attaches `data-db-1` and keeps its name and DNS.

**Q: What is `podManagementPolicy: Parallel` and when would you use it?**
A: It creates and deletes all pods at once instead of one-by-one, while still keeping stable identities and storage. Use it when the app doesn't need bootstrap ordering (e.g. sharded stores where each pod is independent), to speed up scaling and recovery.

**Q: How do PVCs behave on scale-down or StatefulSet deletion by default, and how do you change it?**
A: By default PVCs are retained (data safety) even when pods are removed. Since 1.27 `persistentVolumeClaimRetentionPolicy` with `whenScaled`/`whenDeleted` set to `Delete` lets Kubernetes garbage-collect them.

**Q: How would you do a canary rollout of a StatefulSet? (senior)**
A: Use `updateStrategy.rollingUpdate.partition`. Set `partition` to N-1 so only the highest ordinal updates; validate that pod; then progressively lower the partition to roll the rest. `partition: 0` updates everything.

**Q: A StatefulSet rollout is stuck at db-1 and db-2 never updates. Why? (senior)**
A: With `OrderedReady`, the controller won't proceed until the current pod is Running and Ready. A failing readiness probe, crash-looping container, or unschedulable pod (no node/zone for its PVC) blocks the whole rollout. Diagnose the stuck ordinal's events/probe.

**Q: How do you keep quorum safe during node maintenance? (senior)**
A: A PodDisruptionBudget with `minAvailable` at or above quorum, plus node/zone anti-affinity so replicas aren't co-located. Drains then respect the PDB and won't evict enough pods to break quorum.

**Q: Why use `volumeBindingMode: WaitForFirstConsumer` on the StorageClass?**
A: It delays PV provisioning until the pod is scheduled, so the volume is created in the same zone/node the scheduler picked — avoiding "volume node affinity conflict" attach failures in multi-zone clusters.

**Q: Can you change replicas to 0? What's the effect?**
A: Yes. It terminates all pods in reverse order but retains the PVCs (unless a retention policy deletes them), effectively pausing the workload cheaply while preserving data. Scaling back up re-attaches the same volumes.

## 10. Practice

- [ ] Deploy a 3-replica StatefulSet with `volumeClaimTemplates`; confirm ordered creation with `kubectl get pods -w`.
- [ ] Write a unique value to `db-0`'s volume, delete the pod, and verify the data survives on the new pod.
- [ ] Resolve `db-0.<svc>` from a temporary busybox pod using `nslookup`.
- [ ] Do a partitioned canary update: set `partition: 2`, change the image, and confirm only `db-2` updates.
- [ ] Add a PodDisruptionBudget and node anti-affinity, then `kubectl drain` a node and observe the eviction respect the PDB.

## 11. Cheat Sheet

> [!TIP]
> **StatefulSet =** stable identity + ordered lifecycle + per-pod storage.
> Names `x-0..x-N-1` · DNS `x-0.<svc>` via **headless Service** (`clusterIP: None`, `serviceName`).
> `volumeClaimTemplates` → one **sticky PVC per pod** (`data-x-0`), retained by default.
> Create 0→N-1 (Ready-gated), scale-down N-1→0, update reverse ordinal.
> Knobs: `podManagementPolicy: Parallel`, `rollingUpdate.partition` (canary), `persistentVolumeClaimRetentionPolicy`.
> Prod: PDB + anti-affinity + `WaitForFirstConsumer` StorageClass. Use for DBs/Kafka/etcd, **not** stateless web.

**References:** Kubernetes docs "StatefulSets" & "StatefulSet Basics tutorial", "Storage: PersistentVolumes", CoreDNS docs, CNCF blog posts on running databases on Kubernetes

---
*Kubernetes Handbook — topic 06.*
