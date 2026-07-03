# 16 · StorageClasses & Dynamic Provisioning

> **In one line:** A StorageClass is a template that lets a PVC conjure a matching PersistentVolume on demand — no admin pre-provisioning.

---

## 1. Overview

Before dynamic provisioning, an admin had to hand-carve a **PersistentVolume** for every disk a workload might need, and hope a PVC's size/access mode happened to match. That doesn't scale. A **StorageClass** solves it: it names a **provisioner** (a CSI driver) plus a bag of parameters, so when a **PersistentVolumeClaim** references the class, the provisioner *creates the real disk on the fly* — an EBS volume, a GCE PD, a Ceph RBD image — and binds a freshly minted PV to the claim.

This is the mechanism behind "I just asked for 20Gi of `gp3` and got it." The StorageClass is the contract: it encodes the disk **tier** (SSD vs HDD, IOPS, throughput, replication), the **reclaim policy**, whether the volume can be **expanded**, and — crucially — *when* to bind (`volumeBindingMode`).

You reach for StorageClasses whenever workloads are stateful (databases, queues, caches via StatefulSets) and you want self-service storage without an operator in the loop. One cluster typically offers several classes — `fast-ssd`, `standard`, `cheap-hdd`, `retain-db` — and marks one as **default** so PVCs that don't name a class still get something sensible.

The subtle-but-important knobs are `volumeBindingMode: WaitForFirstConsumer` (bind the disk in the same zone as the pod), `allowVolumeExpansion` (grow a disk without recreating it), and `reclaimPolicy` (what happens to the data when the PVC is deleted).

## 2. Core Concepts

- **Provisioner** — the CSI driver that actually creates storage, e.g. `ebs.csi.aws.com`, `pd.csi.storage.gke.io`, `disk.csi.azure.com`, `rook-ceph.rbd.csi.ceph.com`.
- **`parameters`** — driver-specific tier knobs: `type: gp3`, `iops`, `throughput`, `fsType`, `encrypted`, replication factor. These define the *quality* of the disk.
- **Dynamic vs static provisioning** — dynamic creates a PV on demand from a PVC+class; static uses admin-created PVs. A PVC with `storageClassName: ""` opts out of dynamic entirely.
- **Default StorageClass** — the class annotated `storageclass.kubernetes.io/is-default-class: "true"`; PVCs with no `storageClassName` inherit it. Exactly one should be default.
- **`volumeBindingMode`** — `Immediate` binds/provisions as soon as the PVC is created; **`WaitForFirstConsumer`** waits until a pod is scheduled, then provisions in that pod's zone/topology.
- **`allowVolumeExpansion: true`** — lets you grow a PVC by editing its `resources.requests.storage`; the CSI driver resizes the disk (and often the filesystem) online.
- **`reclaimPolicy`** — `Delete` (default): destroy the underlying disk when the PVC/PV is deleted. `Retain`: keep the disk and data, PV goes to `Released` for manual recovery.
- **Access modes** — `RWO` (one node), `ROX` (many read-only), `RWX` (many read-write, needs a shared-fs driver like EFS/Filestore/CephFS). Block volumes are almost always RWO.
- **The binding chain** — `PVC → StorageClass → provisioner → PV → real disk`, and the PVC/PV are bound 1:1.

## 3. Syntax & Examples

**A fast, expandable, zone-aware SSD class (AWS gp3):**

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast-ssd
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  iops: "6000"
  throughput: "250"
  encrypted: "true"
  fsType: ext4
volumeBindingMode: WaitForFirstConsumer   # provision in the pod's zone
allowVolumeExpansion: true
reclaimPolicy: Delete
```

**A retain-on-delete class for irreplaceable data:**

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata: {name: retain-db}
provisioner: ebs.csi.aws.com
parameters: {type: gp3}
reclaimPolicy: Retain            # keep the disk if the PVC is deleted
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
```

**A PVC that consumes a class:**

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata: {name: data-pg-0}
spec:
  storageClassName: fast-ssd     # omit → uses the default class
  accessModes: [ReadWriteOnce]
  resources: {requests: {storage: 20Gi}}
```

**StatefulSet using a class via `volumeClaimTemplates`:**

```yaml
volumeClaimTemplates:
  - metadata: {name: data}
    spec:
      storageClassName: fast-ssd
      accessModes: [ReadWriteOnce]
      resources: {requests: {storage: 20Gi}}
```

## 4. Worked Example

Provision a disk for a Postgres pod, then expand it online.

```bash
kubectl apply -f fast-ssd-storageclass.yaml
kubectl apply -f pvc.yaml          # data-pg-0, 20Gi, fast-ssd

# With WaitForFirstConsumer, the PVC stays Pending until a pod needs it:
kubectl get pvc data-pg-0
```

```text
NAME        STATUS    VOLUME   CAPACITY   ACCESS MODES   STORAGECLASS   AGE
data-pg-0   Pending                                      fast-ssd       8s
# Events: waiting for first consumer to be created before binding   ← expected!
```

```bash
# Schedule a pod that mounts the PVC → provisioner creates the disk in that zone:
kubectl apply -f pg-pod.yaml
kubectl get pvc data-pg-0
```

```text
NAME        STATUS   VOLUME                                     CAPACITY   ACCESS MODES   STORAGECLASS
data-pg-0   Bound    pvc-9f3c...-ebs-vol                        20Gi       RWO            fast-ssd
```

```bash
# Expand online — just edit the requested size (allowVolumeExpansion must be true):
kubectl patch pvc data-pg-0 -p '{"spec":{"resources":{"requests":{"storage":"50Gi"}}}}'
kubectl get pvc data-pg-0 -w
```

```text
NAME        STATUS   CAPACITY   CONDITIONS
data-pg-0   Bound    20Gi       FileSystemResizePending
data-pg-0   Bound    50Gi       (resized — no pod restart needed for modern CSI)
```

The claim stayed **Pending until a consumer appeared** (WaitForFirstConsumer), provisioned in the pod's zone, then grew from 20→50Gi **without recreation**.

## 5. Under the Hood

When a PVC is created, the **PersistentVolume controller** looks at its `storageClassName`. With `Immediate` binding it calls the CSI **external-provisioner** sidecar right away. With `WaitForFirstConsumer`, it does *nothing* until the **scheduler** places a consuming pod — only then does it know the node/zone, so it asks the provisioner to create the disk with the right **topology constraint**. The CSI driver calls the cloud API, returns a volume handle, the controller creates a PV object and **binds** it 1:1 to the PVC, and finally the **kubelet + CSI node plugin** attach and mount it into the pod.

```svg
<svg viewBox="0 0 780 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#475569"/>
    </marker>
  </defs>
  <text x="390" y="22" text-anchor="middle" fill="#1e293b" font-weight="700">Dynamic provisioning flow (WaitForFirstConsumer)</text>

  <rect x="30" y="60" width="150" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="105" y="86" text-anchor="middle" fill="#1e293b" font-weight="600">PVC</text>
  <text x="105" y="104" text-anchor="middle" fill="#64748b" font-size="11">20Gi, fast-ssd</text>

  <rect x="30" y="170" width="150" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="105" y="196" text-anchor="middle" fill="#1e293b" font-weight="600">StorageClass</text>
  <text x="105" y="214" text-anchor="middle" fill="#64748b" font-size="11">provisioner+params</text>

  <rect x="250" y="115" width="160" height="60" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="330" y="141" text-anchor="middle" fill="#1e293b" font-weight="600">Scheduler</text>
  <text x="330" y="159" text-anchor="middle" fill="#64748b" font-size="11">picks node/zone</text>

  <rect x="470" y="115" width="160" height="60" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="550" y="141" text-anchor="middle" fill="#1e293b" font-weight="600">CSI provisioner</text>
  <text x="550" y="159" text-anchor="middle" fill="#64748b" font-size="11">calls cloud API</text>

  <rect x="470" y="240" width="160" height="60" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="550" y="266" text-anchor="middle" fill="#1e293b" font-weight="600">PV + real disk</text>
  <text x="550" y="284" text-anchor="middle" fill="#64748b" font-size="11">bound 1:1 to PVC</text>

  <rect x="250" y="240" width="160" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="330" y="266" text-anchor="middle" fill="#1e293b" font-weight="600">kubelet + CSI node</text>
  <text x="330" y="284" text-anchor="middle" fill="#64748b" font-size="11">attach + mount</text>

  <line x1="180" y1="90" x2="248" y2="130" stroke="#475569" stroke-width="2" marker-end="url(#a)"/>
  <line x1="180" y1="200" x2="248" y2="160" stroke="#475569" stroke-width="2" marker-end="url(#a)"/>
  <line x1="410" y1="145" x2="468" y2="145" stroke="#475569" stroke-width="2" marker-end="url(#a)"/>
  <text x="439" y="136" text-anchor="middle" fill="#64748b" font-size="10">topology</text>
  <line x1="550" y1="175" x2="550" y2="238" stroke="#475569" stroke-width="2" marker-end="url(#a)"/>
  <line x1="470" y1="270" x2="412" y2="270" stroke="#475569" stroke-width="2" marker-end="url(#a)"/>
  <text x="105" y="330" text-anchor="middle" fill="#64748b" font-size="11">PVC stays Pending until a pod consumes it →</text>
</svg>
```

## 6. Variations & Trade-offs

| Choice | Option A | Option B | Rule of thumb |
|--------|----------|----------|---------------|
| **Binding mode** | `Immediate` — bind at PVC create | `WaitForFirstConsumer` — bind at pod schedule | Use WFFC in multi-zone clusters to avoid "disk in zone A, pod stuck in B" |
| **Reclaim policy** | `Delete` — disk destroyed with PVC | `Retain` — disk survives for recovery | Retain for databases / irreplaceable data; Delete for scratch/caches |
| **Tier** | `gp3`/SSD — low latency, IOPS | `sc1`/HDD — cheap, throughput | Match to workload: DB→SSD, logs/backups→HDD |
| **Access mode** | RWO block (EBS/PD) | RWX shared (EFS/Filestore/CephFS) | RWX needs a networked filesystem driver; block is faster but single-node |
| **Provisioning** | Dynamic (StorageClass) | Static (admin PVs) | Dynamic by default; static for pre-existing/special LUNs |

Prose: **`Immediate` binding is the classic multi-zone footgun** — the disk is created in some zone before the scheduler runs, and if the pod can't be placed there it's stuck forever; `WaitForFirstConsumer` fixes this by deferring provisioning until topology is known. `Retain` protects data but leaves orphaned disks (and cloud bills) you must clean up manually. RWX is convenient but a networked filesystem is slower and pricier than block — don't reach for it unless multiple pods truly need concurrent write access.

## 7. Production / Performance Notes

- **Set exactly one default class**, and pick it deliberately — every unqualified PVC lands on it. Two defaults is an error; zero means unqualified PVCs hang Pending.
- **Prefer `WaitForFirstConsumer`** for any regional/multi-AZ cluster. It's the single biggest cause of unschedulable stateful pods when set to `Immediate`.
- **Use `Retain` for production databases.** A fat-fingered `kubectl delete pvc` with `Delete` policy destroys the disk irrecoverably. With Retain you can rebind a new PVC to the released PV.
- **Enable `allowVolumeExpansion`** on every class you'd ever want to grow — you *cannot* add it retroactively to already-provisioned volumes on some drivers, and you can never shrink a volume.
- **Tune the tier in `parameters`**, not by picking bigger disks. On gp3 you set `iops`/`throughput` independently of size; on gp2 IOPS scale with size, which surprises people.
- **Expansion resizes the block device**; the filesystem grow is usually online for modern CSI, but check the PVC condition `FileSystemResizePending` — older setups needed a pod restart.
- **StatefulSet PVCs are not garbage-collected** when you scale down; `volumeClaimTemplates` PVCs persist by design so re-scaling reuses data. Clean up manually if intended.
- **Encryption and backup are class/driver concerns** — set `encrypted: "true"` in parameters and use CSI VolumeSnapshots for point-in-time backups.

## 8. Common Mistakes

1. ⚠️ **`Immediate` binding in a multi-AZ cluster.** Disk lands in zone A, pod can't schedule there → permanent Pending. **Fix:** use `volumeBindingMode: WaitForFirstConsumer`.
2. ⚠️ **Leaving `reclaimPolicy: Delete` on a database class.** Deleting the PVC nukes the data. **Fix:** use `Retain` for stateful/irreplaceable data.
3. ⚠️ **Forgetting `allowVolumeExpansion: true`.** You then can't grow the PVC without recreating it. **Fix:** enable it on the class up front.
4. ⚠️ **Two default StorageClasses (or zero).** Unqualified PVCs error or hang. **Fix:** annotate exactly one as default.
5. ⚠️ **Trying to shrink a PVC.** Kubernetes never supports shrinking. **Fix:** create a new smaller volume and migrate data.
6. ⚠️ **Requesting RWX from a block driver (EBS/PD).** The PVC binds but a second pod can't mount it. **Fix:** use a shared-fs class (EFS/Filestore/CephFS) for RWX.
7. ⚠️ **Assuming deleting a StatefulSet deletes its disks.** `volumeClaimTemplates` PVCs stay. **Fix:** delete the PVCs explicitly when you truly want the data gone.

## 9. Interview Questions

**Q: What does `volumeBindingMode: WaitForFirstConsumer` do and why is it usually the right default?**
A: It delays PV provisioning/binding until a pod that consumes the PVC is scheduled. Only then is the node's zone/topology known, so the disk is created in the *same* zone as the pod. This avoids the `Immediate`-mode failure where a disk is provisioned in zone A but the pod can only be placed in zone B, leaving it unschedulable forever.

**Q: A PVC is stuck in `Pending` with the event "waiting for first consumer." Is this a bug?**
A: No — it's the expected behavior of `WaitForFirstConsumer`. The PVC intentionally won't bind until a pod mounts it. It becomes Bound the moment a consuming pod is scheduled. (A different `Pending` cause would be no matching class/provisioner or quota exhaustion.)

**Q: What's the difference between the `Delete` and `Retain` reclaim policies?**
A: `Delete` (the default) destroys the underlying cloud disk when the PVC/PV is deleted — data is gone. `Retain` keeps the disk and moves the PV to `Released`; the data survives and an admin can manually rebind or recover it. Use `Retain` for anything you can't afford to lose.

**Q: How do you make a StorageClass the cluster default, and what happens if there are two?**
A: Annotate it `storageclass.kubernetes.io/is-default-class: "true"`. PVCs that omit `storageClassName` use it. If two classes are marked default, PVC creation without a class is rejected (ambiguous); if none is default, such PVCs hang Pending.

**Q: How do you grow a volume, and what are the constraints?**
A: The class must have `allowVolumeExpansion: true`; then you edit the PVC's `spec.resources.requests.storage` to a larger value and the CSI driver resizes the disk (and usually the filesystem online). You can never *shrink*, and expansion support depends on the driver.

**Q: What's the difference between dynamic and static provisioning?**
A: Dynamic: a PVC references a StorageClass and the provisioner **creates a PV/disk on demand**. Static: an admin pre-creates PV objects backed by existing disks, and PVCs bind to whichever matches. Dynamic is the default self-service model; static suits pre-existing LUNs or special hardware. `storageClassName: ""` disables dynamic for that PVC.

**Q: (Senior) Why can't you get RWX from an EBS/GCE-PD StorageClass, and what do you use instead?**
A: Block-device drivers attach a volume to a *single node* at a time, so only one pod can write — that's RWO. RWX requires a **networked/shared filesystem** driver (AWS EFS, GCP Filestore, CephFS, NFS) where many nodes mount concurrently. It's more flexible but slower and costlier than block.

**Q: (Senior) You deleted a StatefulSet but the disks and PVCs remain. Why, and is that correct?**
A: Yes — `volumeClaimTemplates` create PVCs that are intentionally **not** garbage-collected with the StatefulSet, so scaling back up reuses the same data (identity + storage persistence is the whole point of StatefulSets). To reclaim storage you must delete the PVCs manually, which then triggers the reclaim policy.

**Q: (Senior) How do `parameters` like `iops`/`throughput`/`type` differ between gp2 and gp3, and why does it matter for cost/perf?**
A: On gp2, IOPS are coupled to volume size (3 IOPS/GiB), so to get more IOPS you over-provision capacity you don't need. gp3 decouples them: you set `iops` and `throughput` independently in class `parameters`, right-sizing performance and capacity separately — usually cheaper and more predictable. Choosing the tier in the class is how you express SSD vs HDD, encryption, and replication.

**Q: (Senior) A PVC shows condition `FileSystemResizePending` after expansion. What's happening?**
A: The block device was enlarged but the filesystem hasn't been grown to use the new space yet. Modern CSI node plugins do this **online** on next mount/attach; older setups required a pod restart to trigger the fs resize. Until then capacity is provisioned but not usable inside the container.

## 10. Practice

- [ ] Create two StorageClasses (`fast-ssd` default, `retain-db` with `Retain`) and confirm exactly one is default.
- [ ] Make a PVC with `WaitForFirstConsumer` and watch it stay Pending until you schedule a consuming pod.
- [ ] Enable `allowVolumeExpansion`, provision a 10Gi PVC, then grow it to 30Gi online and verify inside the pod with `df -h`.
- [ ] Delete a PVC backed by a `Retain` class and show the PV goes to `Released` with the disk intact.
- [ ] Deploy a StatefulSet with `volumeClaimTemplates`, scale to 3, delete the StatefulSet, and observe the PVCs/disks persist.

## 11. Cheat Sheet

> [!TIP]
> **StorageClass = provisioner + tier params + policies; a PVC references it to get a PV on demand.**
> - `provisioner:` = CSI driver (ebs.csi.aws.com…); `parameters:` = tier (type/iops/encrypted).
> - **`volumeBindingMode: WaitForFirstConsumer`** in multi-AZ — provisions in the pod's zone, avoids stuck Pending.
> - **`reclaimPolicy: Retain`** for databases; `Delete` destroys the disk with the PVC.
> - **`allowVolumeExpansion: true`** to grow later (edit PVC size); you can never shrink.
> - Exactly **one default class** (`is-default-class: "true"`) for PVCs that omit the class.
> - RWX needs a shared-fs driver (EFS/Filestore/CephFS); block drivers are RWO.
> - StatefulSet `volumeClaimTemplates` PVCs persist after delete — clean up manually.

**References:** Kubernetes StorageClass & Persistent Volumes docs; CSI documentation; AWS EBS CSI / GKE PD CSI driver docs

---
*Kubernetes Handbook — topic 16.*
