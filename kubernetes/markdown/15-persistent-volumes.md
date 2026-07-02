# 15 · PersistentVolumes, PVCs & CSI

> **In one line:** A PersistentVolumeClaim is a portable request for durable storage; it binds to a PersistentVolume — a cluster-scoped piece of real storage — and the CSI driver plumbs it to the node.

---

## 1. Overview

Pod-scoped volumes (topic 14) die with the Pod. Stateful apps — databases, queues, object caches — need storage whose lifecycle is **decoupled from any Pod**. Kubernetes models this with two objects that separate *supply* from *demand*: a **PersistentVolume (PV)** is a cluster resource representing a real piece of storage (an EBS volume, a Ceph RBD image, an NFS export), and a **PersistentVolumeClaim (PVC)** is a namespaced *request* for storage of a given size and access mode.

This split is deliberate. App authors write a portable PVC ("I need 20Gi, ReadWriteOnce") without knowing whether the cluster runs on AWS, GCP, or bare-metal Ceph. Cluster admins (or a dynamic provisioner, topic 16) supply the matching PV. The control plane **binds** a PVC to a suitable PV, and the Pod mounts the PVC by name.

Underneath, the **Container Storage Interface (CSI)** is the plugin API that lets storage vendors implement provisioning, attaching, and mounting out-of-tree. Every modern driver — `ebs.csi.aws.com`, `pd.csi.storage.gke.io`, `csi.trident.netapp.io` — is a CSI driver. This page covers PV/PVC binding, access modes, reclaim policy, static vs dynamic provisioning, and the CSI architecture.

## 2. Core Concepts

- **PersistentVolume (PV)** — cluster-scoped, not namespaced. Represents actual storage with a `capacity`, `accessModes`, `storageClassName`, a `persistentVolumeReclaimPolicy`, and a driver-specific source (`csi`, `nfs`, `hostPath`…).
- **PersistentVolumeClaim (PVC)** — namespaced request: `resources.requests.storage`, `accessModes`, optional `storageClassName`, optional `selector`. Pods reference PVCs, never PVs directly.
- **Binding** — the PV controller matches a PVC to a PV that satisfies size + access mode + class, then binds them **1:1 and exclusively**. A bound PV cannot serve another PVC.
- **Access modes** — `ReadWriteOnce` (RWO: one *node* mounts read-write), `ReadOnlyMany` (ROX: many nodes read-only), `ReadWriteMany` (RWX: many nodes read-write), `ReadWriteOncePod` (RWOP: exactly one *Pod*). What's actually supported depends on the backend — block storage is RWO only; NFS/CephFS give RWX.
- **Reclaim policy** — what happens to the PV when its PVC is deleted: `Delete` (also deletes the backing volume — default for dynamic), `Retain` (keeps the PV + data, needs manual cleanup), or the deprecated `Recycle`.
- **Static provisioning** — an admin pre-creates PVs by hand; PVCs bind to whatever pre-exists.
- **Dynamic provisioning** — a StorageClass + provisioner creates a PV *on demand* when a PVC appears (topic 16). The common path today.
- **Phases** — a PV moves `Available → Bound → Released → Failed`; a PVC is `Pending → Bound → Lost`.
- **CSI** — the gRPC plugin standard (Controller + Node services + sidecars) that implements CreateVolume, ControllerPublish (attach), NodeStage/NodePublish (mount).

## 3. Syntax & Examples

**A static PV (admin-supplied) and a PVC that binds to it:**

```yaml
apiVersion: v1
kind: PersistentVolume
metadata: {name: pv-nfs-01}
spec:
  capacity: {storage: 20Gi}
  accessModes: ["ReadWriteMany"]
  persistentVolumeReclaimPolicy: Retain
  storageClassName: ""          # "" = no dynamic class; static bind only
  nfs:
    server: 10.0.0.5
    path: /exports/data
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: {name: shared-data, namespace: app}
spec:
  accessModes: ["ReadWriteMany"]
  storageClassName: ""
  resources:
    requests: {storage: 20Gi}
```

**Dynamic PVC (no PV pre-exists; StorageClass provisions one):**

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata: {name: db-data, namespace: app}
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: gp3          # a StorageClass (topic 16)
  resources:
    requests: {storage: 50Gi}
```

**A Pod consuming the PVC:**

```yaml
apiVersion: v1
kind: Pod
metadata: {name: db, namespace: app}
spec:
  containers:
    - name: pg
      image: postgres:16
      volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: db-data
```

**Expanding a PVC (if the StorageClass allows it):**

```bash
kubectl patch pvc db-data -n app --type merge \
  -p '{"spec":{"resources":{"requests":{"storage":"100Gi"}}}}'
```

## 4. Worked Example

Provision durable storage dynamically, bind it, and observe the objects.

```bash
kubectl apply -f db-data-pvc.yaml -f db-pod.yaml
kubectl get pvc,pv -n app
```

```text
NAME                            STATUS   VOLUME               CAPACITY   ACCESS MODES   STORAGECLASS
persistentvolumeclaim/db-data   Bound    pvc-8f1c...-a02b     50Gi       RWO            gp3

NAME                                 CAPACITY   ACCESS MODES   RECLAIM POLICY   STATUS   CLAIM
persistentvolume/pvc-8f1c...-a02b    50Gi       RWO            Delete           Bound    app/db-data
```

Note the dynamically created PV is named `pvc-<uid>`, its reclaim policy is `Delete` (inherited from the class), and it's `Bound` to `app/db-data`. Delete the PVC and watch the PV go with it:

```bash
kubectl delete pvc db-data -n app
kubectl get pv                       # PV gone: reclaimPolicy Delete removed the EBS volume too
```

> [!WARN]
> With `reclaimPolicy: Delete`, deleting the PVC **destroys the underlying cloud volume and its data**. For anything you care about, patch the PV to `Retain` first: `kubectl patch pv <name> -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'`.

## 5. Under the Hood

Binding is done by the **PV controller** in kube-controller-manager. Provisioning, attaching, and mounting are done by the **CSI driver**, split into two halves: a **Controller plugin** (a Deployment, one per cluster, with `external-provisioner` and `external-attacher` sidecars that watch PVC/VolumeAttachment objects and call the vendor's `CreateVolume`/`ControllerPublishVolume`) and a **Node plugin** (a DaemonSet on every node that the kubelet calls to `NodeStageVolume` (format + mount to a global path) and `NodePublishVolume` (bind-mount into the Pod)).

```svg
<svg viewBox="0 0 780 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a15" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="390" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">PVC → PV → real storage (CSI dynamic provisioning)</text>

  <!-- Pod -->
  <rect x="30" y="55" width="150" height="70" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="105" y="82" text-anchor="middle" fill="#1e293b" font-weight="700">Pod</text>
  <text x="105" y="102" text-anchor="middle" fill="#64748b">claimName: db-data</text>

  <!-- PVC -->
  <rect x="240" y="55" width="150" height="70" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="315" y="80" text-anchor="middle" fill="#1e293b" font-weight="700">PVC db-data</text>
  <text x="315" y="98" text-anchor="middle" fill="#64748b">50Gi RWO gp3</text>
  <text x="315" y="114" text-anchor="middle" fill="#64748b">namespaced request</text>

  <!-- PV -->
  <rect x="450" y="55" width="150" height="70" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="525" y="80" text-anchor="middle" fill="#1e293b" font-weight="700">PV pvc-8f1c…</text>
  <text x="525" y="98" text-anchor="middle" fill="#64748b">cluster-scoped</text>
  <text x="525" y="114" text-anchor="middle" fill="#64748b">reclaim: Delete</text>

  <!-- storage -->
  <rect x="655" y="55" width="105" height="70" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="707" y="82" text-anchor="middle" fill="#1e293b" font-weight="700">EBS vol</text>
  <text x="707" y="102" text-anchor="middle" fill="#64748b">vol-0abc…</text>

  <line x1="180" y1="90" x2="238" y2="90" stroke="#475569" marker-end="url(#a15)"/>
  <text x="209" y="80" text-anchor="middle" fill="#64748b" font-size="11">mounts</text>
  <line x1="390" y1="90" x2="448" y2="90" stroke="#475569" marker-end="url(#a15)"/>
  <text x="419" y="80" text-anchor="middle" fill="#64748b" font-size="11">bind 1:1</text>
  <line x1="600" y1="90" x2="653" y2="90" stroke="#475569" marker-end="url(#a15)"/>
  <text x="627" y="80" text-anchor="middle" fill="#64748b" font-size="11">backs</text>

  <!-- control plane -->
  <rect x="240" y="170" width="360" height="80" rx="8" fill="none" stroke="#475569"/>
  <text x="420" y="192" text-anchor="middle" fill="#64748b">Control plane</text>
  <text x="315" y="216" text-anchor="middle" fill="#1e293b">PV controller</text>
  <text x="315" y="234" text-anchor="middle" fill="#64748b" font-size="11">binds PVC↔PV</text>
  <text x="525" y="216" text-anchor="middle" fill="#1e293b">CSI Controller</text>
  <text x="525" y="234" text-anchor="middle" fill="#64748b" font-size="11">provisioner+attacher → CreateVolume</text>
  <line x1="315" y1="168" x2="315" y2="127" stroke="#475569" stroke-dasharray="4 3" marker-end="url(#a15)"/>
  <line x1="525" y1="168" x2="525" y2="127" stroke="#475569" stroke-dasharray="4 3" marker-end="url(#a15)"/>

  <!-- node -->
  <rect x="30" y="290" width="720" height="72" rx="8" fill="none" stroke="#475569"/>
  <text x="46" y="312" fill="#64748b">Node: kubelet → CSI Node plugin (DaemonSet)</text>
  <text x="46" y="334" fill="#475569">NodeStageVolume: format + mount to global path</text>
  <text x="46" y="352" fill="#475569">NodePublishVolume: bind-mount into Pod's mountPath</text>
  <line x1="105" y1="125" x2="105" y2="288" stroke="#475569" stroke-dasharray="4 3" marker-end="url(#a15)"/>
</svg>
```

## 6. Variations & Trade-offs

| Dimension | Options | Notes |
|-----------|---------|-------|
| Provisioning | Static vs Dynamic | Static = admin pre-creates PVs; Dynamic = StorageClass creates on demand (topic 16) |
| Access mode | RWO / ROX / RWX / RWOP | Block = RWO only; file (NFS/CephFS/EFS) = RWX; RWOP = single-Pod, needs recent k8s |
| Reclaim policy | Delete / Retain / (Recycle) | Delete removes backing volume; Retain keeps data for manual recovery |
| Binding time | Immediate / WaitForFirstConsumer | Immediate can bind to the wrong AZ; WFFC waits for the Pod's node (topic 16) |
| Plugin | In-tree (removed) / CSI | In-tree drivers are deprecated/removed; everything is CSI now |

`Retain` is safest but leaks orphaned PVs you must garbage-collect by hand. `Delete` is convenient but one `kubectl delete pvc` can nuke production data — mitigate with `Retain` on critical classes and storage-side snapshots/backups. RWX is tempting for sharing but only file-based backends support it; forcing RWX onto block storage silently gives you a Pod stuck `ContainerCreating` with `Multi-Attach error`.

## 7. Production / Performance Notes

- **Access mode is per-node, not per-Pod** (except RWOP). RWO means one node — several Pods on the *same* node can share an RWO volume, but a Pod on another node cannot attach it. This is why RWO StatefulSets can't spread a single volume across replicas.
- The classic outage: a Deployment (not StatefulSet) with an RWO PVC scaled to 2, second Pod lands on another node → `Multi-Attach error for volume`. Fix: RWX storage, or a StatefulSet with `volumeClaimTemplates` (one PVC per replica).
- **Volume expansion** requires `allowVolumeExpansion: true` on the StorageClass and only grows, never shrinks. Filesystem resize may need the Pod to restart depending on driver.
- Prefer `WaitForFirstConsumer` binding (topic 16) so the PV is provisioned in the *same AZ* as the scheduled Pod — Immediate binding on multi-AZ clusters strands volumes.
- Back up with **VolumeSnapshots** (a CSI feature) plus off-cluster copies; a `Delete` reclaim policy plus an errant PVC deletion has destroyed real databases.
- Use `ReadWriteOncePod` to guarantee a single writer (prevents split-brain when a rolling update briefly runs two Pods).

## 8. Common Mistakes

1. ⚠️ Deleting a PVC bound to a `reclaimPolicy: Delete` PV and losing the data with it. Fix: set critical PVs/classes to `Retain` and rely on snapshots.
2. ⚠️ Using a Deployment with an RWO PVC and >1 replica → `Multi-Attach error`. Fix: StatefulSet + `volumeClaimTemplates`, or RWX storage.
3. ⚠️ Requesting `ReadWriteMany` on block storage (EBS/PD) and getting a Pod stuck in `ContainerCreating`. Fix: use a file backend (EFS, NFS, CephFS).
4. ⚠️ Immediate-binding a PV in AZ-a while the Pod schedules in AZ-b → unschedulable. Fix: `volumeBindingMode: WaitForFirstConsumer`.
5. ⚠️ Expecting to *shrink* a PVC. Not supported. Fix: create a smaller volume and migrate data.
6. ⚠️ Referencing a PV directly from a Pod. Pods can only mount PVCs. Fix: always go through a PVC.
7. ⚠️ Forgetting to clear `claimRef` on a `Retain`ed, `Released` PV before it can bind again. Fix: `kubectl patch pv <name> --type json -p '[{"op":"remove","path":"/spec/claimRef"}]'`.

## 9. Interview Questions

**Q: What problem do PV and PVC solve, and why are they two separate objects?**
A: They decouple storage *supply* from *demand* and make workloads portable. A PVC is a namespaced, cloud-agnostic request ("20Gi, RWO"); a PV is the cluster-scoped real storage. App teams write PVCs without knowing the backend, admins or a provisioner supply matching PVs, and the control plane binds them. The separation lets the same manifest run on AWS, GCP, or bare metal.

**Q: Explain the four access modes.**
A: `ReadWriteOnce` (RWO) — mountable read-write by a single *node* (multiple Pods on that node can share it). `ReadOnlyMany` (ROX) — read-only by many nodes. `ReadWriteMany` (RWX) — read-write by many nodes, needs a file backend. `ReadWriteOncePod` (RWOP) — exactly one Pod cluster-wide, for strict single-writer semantics. What's supported depends on the backend, not the request.

**Q: What does the reclaim policy control and what are the values?**
A: It controls the PV's fate when its PVC is deleted. `Delete` also deletes the backing storage (default for dynamic provisioning) — data is gone. `Retain` keeps the PV and data as `Released` for manual recovery. `Recycle` (deprecated) scrubbed and reused the volume.

**Q: Static vs dynamic provisioning — when do you use each?**
A: Static: an admin pre-creates PVs (e.g. pointing at existing NFS exports or a specific LUN); PVCs bind to whatever exists. Dynamic: a StorageClass + provisioner creates a PV on demand when a PVC appears. Dynamic is the default in the cloud; static suits pre-existing or specialized storage you must reference explicitly.

**Q: Walk me through what CSI does when a PVC is created and a Pod schedules.**
A: The CSI Controller plugin's `external-provisioner` sees the PVC, calls `CreateVolume` (creates e.g. an EBS volume), and a PV is created + bound. When the Pod schedules, `external-attacher` creates a VolumeAttachment and calls `ControllerPublishVolume` (attach to node). Then the kubelet calls the CSI Node plugin's `NodeStageVolume` (format + mount to a global staging path) and `NodePublishVolume` (bind-mount into the Pod's `mountPath`).

**Q: A Deployment with an RWO PVC won't scale past one healthy replica across nodes. Why?**
A: RWO allows read-write mount by a single *node*. The second replica scheduled onto a different node can't attach the same volume, yielding `Multi-Attach error`. RWO Pods only co-share if on the same node. The fix is RWX storage, or a StatefulSet with per-replica PVCs via `volumeClaimTemplates`.

**Q: How do you resize a PVC and what are the limits?**
A: The StorageClass must have `allowVolumeExpansion: true`; then edit `spec.resources.requests.storage` to a larger value. The controller expands the backing volume and the CSI driver resizes the filesystem (some drivers need a Pod restart). You can only grow, never shrink.

**Q: What are the phases of a PV and PVC?**
A: PV: `Available` (free) → `Bound` (claimed) → `Released` (PVC deleted, not yet reclaimed) → `Failed`. PVC: `Pending` (waiting for a PV / provisioning) → `Bound` → `Lost` (its PV disappeared).

**Q: You set a PV to `Retain`, delete the PVC, and now the PV is `Released` but won't bind a new PVC. Why?**
A: A `Released` PV still holds a `claimRef` to the old, deleted PVC, so the binder skips it. Clear it — `kubectl patch pv <name> --type json -p '[{"op":"remove","path":"/spec/claimRef"}]'` — to return it to `Available`, after verifying/cleaning the data.

**Q: Why prefer `WaitForFirstConsumer` binding on a multi-AZ cluster?**
A: With `Immediate` binding the PV is provisioned as soon as the PVC exists, possibly in a different AZ than where the scheduler later places the Pod — zonal block storage can't cross AZ, so the Pod is unschedulable. `WaitForFirstConsumer` delays provisioning until a Pod is scheduled, so the volume is created in the Pod's AZ with correct topology.

**Q: How do you back up and restore CSI-backed storage?**
A: Use CSI **VolumeSnapshots** (VolumeSnapshotClass + VolumeSnapshot → creates a snapshot; restore by creating a PVC with `dataSource` referencing it). For DR, copy snapshots off-cluster or off-region, since cluster-local snapshots don't survive account/region loss. Never rely on reclaim policy alone.

## 10. Practice

- [ ] Create a static PV backed by hostPath (or NFS) plus a matching PVC and confirm they bind; inspect `kubectl get pv,pvc`.
- [ ] Create a dynamic PVC, then delete it and observe whether the PV/backing volume is removed (Delete) — then repeat after patching to `Retain`.
- [ ] Trigger a `Multi-Attach error` by scaling a Deployment with an RWO PVC across two nodes, then fix it with a StatefulSet.
- [ ] Expand a PVC on an expansion-enabled StorageClass and verify `df -h` inside the Pod shows the new size.
- [ ] Take a VolumeSnapshot and provision a new PVC from it as a `dataSource`.

## 11. Cheat Sheet

> [!TIP]
> **PVC** (namespaced request: size + accessMode + class) **binds 1:1** to a **PV** (cluster-scoped real storage). Pods mount **PVCs, never PVs**. **Access modes:** RWO (one node) · ROX (many ro) · RWX (many rw, file backends only) · RWOP (one Pod). **Reclaim:** `Delete` (kills backing volume — default dynamic) vs `Retain` (keeps data, needs manual `claimRef` cleanup). **Static** = admin pre-creates PVs; **dynamic** = StorageClass provisions on demand. **CSI** = Controller plugin (provisioner+attacher → CreateVolume/ControllerPublish) + Node plugin DaemonSet (NodeStage=format+mount, NodePublish=bind-mount). Multi-Attach error = RWO across nodes → use StatefulSet or RWX. Expansion needs `allowVolumeExpansion`, grow-only.

**References:** Kubernetes docs — Persistent Volumes; Kubernetes CSI docs (kubernetes-csi.github.io); Kubernetes docs — Volume Snapshots; CNCF — Container Storage Interface spec

---
*Kubernetes Handbook — topic 15.*
