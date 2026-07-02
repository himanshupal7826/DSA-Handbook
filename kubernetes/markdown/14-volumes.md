# 14 · Volumes & Volume Types

> **In one line:** A Volume gives a container a directory that outlives the container (but usually not the Pod) and can be backed by scratch disk, host paths, config, secrets, or durable storage.

---

## 1. Overview

A container's filesystem is **ephemeral**: the writable layer is destroyed when the container restarts (crash, OOM, liveness kill), so anything written to it is lost and nothing is shared between containers in the same Pod. A **Volume** solves both problems — it is a directory, backed by some medium, that Kubernetes mounts into one or more containers of a Pod at a path you choose.

The key mental model: a Volume's lifecycle is tied to the **Pod**, not the container. A container can crash and restart 50 times; as long as the Pod object exists, an `emptyDir` or a mounted PVC keeps its data. Delete the Pod and an `emptyDir` is gone — but a **PersistentVolume** (topic 15) survives because its lifecycle is decoupled from the Pod entirely.

You reach for volumes constantly: sharing files between an app container and a sidecar, injecting config and TLS certs, giving a scratch cache to a build, exposing the downward API, or attaching a real network disk for a database. This page covers the *in-tree, Pod-scoped* volume types; durable cluster storage (PV/PVC/CSI) is topics 15–16.

## 2. Core Concepts

- **Volume vs volumeMount** — `spec.volumes[]` declares *what* the storage is (the source); each container's `volumeMounts[]` declares *where* it appears (`mountPath`) and how (`readOnly`, `subPath`). Same volume can mount into several containers.
- **emptyDir** — an empty scratch directory created when the Pod is scheduled and deleted when the Pod is removed. Backed by node disk by default, or tmpfs RAM with `medium: Memory`. The canonical **sidecar sharing** medium.
- **hostPath** — mounts a file/dir from the *node's* filesystem into the Pod. Powerful and dangerous: ties the Pod to a node and can escalate privilege. Use only for node-level agents (logs, `/var/run/docker.sock`).
- **configMap / secret volumes** — project keys of a ConfigMap or Secret as files. Updates propagate to the mounted files (eventually, via kubelet sync) — unlike env vars, which are frozen at start.
- **projected volume** — combines multiple sources (configMap, secret, downwardAPI, **serviceAccountToken**) into one directory. Bound SA tokens (short-lived, audience-scoped) are delivered this way.
- **downwardAPI** — exposes Pod metadata (labels, annotations, name, resource limits) as files.
- **ephemeral vs persistent** — `emptyDir`, `configMap`, `secret`, `downwardAPI`, `projected`, and **generic ephemeral volumes** live and die with the Pod. `persistentVolumeClaim` volumes reference cluster storage that outlives the Pod.
- **mountPath vs subPath** — `mountPath` is the directory inside the container; `subPath` mounts a single sub-key or sub-directory of the volume instead of the whole thing (e.g. drop one config file into `/etc` without hiding the rest).
- **Mount masking** — mounting a volume at a path *hides* whatever the image shipped at that path. A `subPath` mount of a single file avoids masking the sibling files.

## 3. Syntax & Examples

**emptyDir shared between two containers:**

```yaml
apiVersion: v1
kind: Pod
metadata: {name: sidecar-share}
spec:
  containers:
    - name: app
      image: busybox
      command: ["sh","-c","while true; do date >> /data/out.log; sleep 2; done"]
      volumeMounts:
        - name: scratch
          mountPath: /data
    - name: sidecar
      image: busybox
      command: ["sh","-c","tail -f /data/out.log"]
      volumeMounts:
        - name: scratch
          mountPath: /data
          readOnly: true
  volumes:
    - name: scratch
      emptyDir: {}          # add sizeLimit: 1Gi to cap it
```

**tmpfs (RAM-backed) emptyDir** — fast, counts against the container's memory limit:

```yaml
  volumes:
    - name: cache
      emptyDir:
        medium: Memory
        sizeLimit: 256Mi
```

**configMap volume with selected keys and permissions:**

```yaml
  volumes:
    - name: app-config
      configMap:
        name: app-config
        defaultMode: 0644
        items:
          - key: application.yaml
            path: application.yaml   # -> /etc/app/application.yaml
```

**subPath — mount one config file without masking `/etc/nginx`:**

```yaml
      volumeMounts:
        - name: nginx-conf
          mountPath: /etc/nginx/nginx.conf
          subPath: nginx.conf        # single file, siblings preserved
```

**projected volume — secret + configMap + bound SA token in one dir:**

```yaml
  volumes:
    - name: all-in-one
      projected:
        sources:
          - secret:    {name: tls-cert}
          - configMap: {name: app-config}
          - downwardAPI:
              items:
                - path: labels
                  fieldRef: {fieldPath: metadata.labels}
          - serviceAccountToken:
              path: token
              expirationSeconds: 3600
              audience: vault
```

## 4. Worked Example

Goal: run nginx serving content generated by an init/sidecar, with config from a ConfigMap mounted read-only.

```yaml
apiVersion: v1
kind: ConfigMap
metadata: {name: site}
data:
  index.html: "<h1>Hello from a configMap volume</h1>"
---
apiVersion: v1
kind: Pod
metadata: {name: web}
spec:
  containers:
    - name: nginx
      image: nginx:1.27
      volumeMounts:
        - name: html
          mountPath: /usr/share/nginx/html
          readOnly: true
  volumes:
    - name: html
      configMap: {name: site}
```

```bash
kubectl apply -f web.yaml
kubectl port-forward pod/web 8080:80 &
curl -s localhost:8080
```

```text
<h1>Hello from a configMap volume</h1>
```

Now edit the ConfigMap and watch the mounted file update (no restart needed):

```bash
kubectl patch configmap site --type merge \
  -p '{"data":{"index.html":"<h1>updated live</h1>"}}'
# kubelet resyncs mounted configMap/secret volumes (~up to 60s by default)
kubectl exec web -- cat /usr/share/nginx/html/index.html
```

```text
<h1>updated live</h1>
```

> [!NOTE]
> The *file* updates, but nginx already served the old bytes into memory. Live-reload needs the app to watch the file or receive a SIGHUP. `subPath` mounts do **not** receive these updates.

## 5. Under the Hood

When a Pod is scheduled, the kubelet's **volume manager** runs each volume's plugin to *set up* the volume on the node, then bind-mounts it into every container that references it. `emptyDir` becomes a directory under the kubelet's data dir (`/var/lib/kubelet/pods/<uid>/volumes/...`); `configMap`/`secret` are materialized as a tmpfs directory of files that the kubelet keeps in sync via periodic resync. On teardown the plugin unmounts and, for Pod-scoped volumes, deletes the backing data.

```svg
<svg viewBox="0 0 760 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a14" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="380" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">Pod-scoped volumes: sources → mountPaths</text>

  <!-- Pod boundary -->
  <rect x="30" y="50" width="700" height="180" rx="8" fill="none" stroke="#2563eb" stroke-dasharray="5 4"/>
  <text x="46" y="70" fill="#64748b">Pod (uid abc123) — lifecycle owns the volume</text>

  <!-- container A -->
  <rect x="60" y="90" width="200" height="120" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="160" y="112" text-anchor="middle" fill="#1e293b" font-weight="700">container: app</text>
  <text x="160" y="140" text-anchor="middle" fill="#475569">mountPath /data</text>
  <text x="160" y="162" text-anchor="middle" fill="#475569">mountPath /etc/app</text>

  <!-- container B -->
  <rect x="500" y="90" width="200" height="120" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="600" y="112" text-anchor="middle" fill="#1e293b" font-weight="700">container: sidecar</text>
  <text x="600" y="140" text-anchor="middle" fill="#475569">mountPath /data (ro)</text>

  <!-- shared volume nodes -->
  <rect x="315" y="90" width="130" height="46" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="380" y="112" text-anchor="middle" fill="#1e293b" font-weight="700">emptyDir</text>
  <text x="380" y="128" text-anchor="middle" fill="#64748b">scratch (shared)</text>

  <rect x="315" y="160" width="130" height="46" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="380" y="182" text-anchor="middle" fill="#1e293b" font-weight="700">configMap</text>
  <text x="380" y="198" text-anchor="middle" fill="#64748b">app-config</text>

  <line x1="260" y1="135" x2="313" y2="113" stroke="#475569" marker-end="url(#a14)"/>
  <line x1="447" y1="113" x2="498" y2="140" stroke="#475569" marker-end="url(#a14)"/>
  <line x1="260" y1="160" x2="313" y2="183" stroke="#475569" marker-end="url(#a14)"/>

  <!-- node backing -->
  <rect x="30" y="255" width="700" height="60" rx="8" fill="none" stroke="#475569"/>
  <text x="46" y="275" fill="#64748b">Node kubelet: /var/lib/kubelet/pods/&lt;uid&gt;/volumes/</text>
  <text x="46" y="298" fill="#475569">kubernetes.io~empty-dir/scratch   ·   kubernetes.io~configmap/app-config (tmpfs, resynced)</text>
  <line x1="380" y1="230" x2="380" y2="253" stroke="#475569" stroke-dasharray="4 3" marker-end="url(#a14)"/>
</svg>
```

## 6. Variations & Trade-offs

| Type | Backing | Lifecycle | Shareable across containers | Typical use |
|------|---------|-----------|------------------------------|-------------|
| `emptyDir` | node disk or RAM | Pod | Yes | scratch, sidecar handoff, cache |
| `hostPath` | node filesystem | node (outlives Pod) | Yes | node agents, log collectors |
| `configMap` | API object → tmpfs | Pod | Yes (ro) | non-secret config files |
| `secret` | API object → tmpfs | Pod | Yes (ro) | TLS certs, tokens |
| `projected` | multiple sources | Pod | Yes (ro) | SA tokens + config + secrets combined |
| `downwardAPI` | Pod metadata | Pod | Yes (ro) | expose labels/limits as files |
| generic ephemeral | CSI/StorageClass | Pod | Yes | per-Pod scratch on real storage w/ size |
| `persistentVolumeClaim` | PV (topic 15) | independent of Pod | Yes | databases, durable state |

`emptyDir` on `medium: Memory` is very fast but is charged to the container's memory limit and can OOM the Pod. `hostPath` couples the Pod to a node and is a privilege-escalation vector — Pod Security Standards **Baseline/Restricted** forbid it. Generic ephemeral volumes give you real (CSI-backed, sized, dynamically provisioned) scratch that still dies with the Pod — a middle ground between `emptyDir` and a full PVC.

## 7. Production / Performance Notes

- Always set `sizeLimit` on `emptyDir` (disk *and* memory) — an unbounded scratch dir can fill the node's ephemeral storage and get the Pod evicted with `Evicted: ephemeral-storage`.
- Prefer **configMap/secret volumes over env vars** for anything you want to hot-reload; env is frozen at container start. But remember `subPath` mounts don't auto-update.
- Set restrictive `defaultMode` (e.g. `0400`) on secret volumes; the default `0644` is world-readable inside the container.
- For secrets, a volume mount is generally safer than env vars — env can leak via `/proc/<pid>/environ`, crash dumps, and child processes.
- Use **bound serviceAccountToken via projected volume** (short TTL, audience-scoped) instead of the legacy long-lived Secret token.
- On multi-tenant clusters, ban `hostPath` with policy (Pod Security admission, OPA/Kyverno). It can mount `/`, the container runtime socket, or node credentials.

## 8. Common Mistakes

1. ⚠️ Assuming `emptyDir` survives Pod deletion. It does not — it only survives *container* restarts. Fix: use a PVC (topic 15) for durability.
2. ⚠️ Mounting a volume at a directory that the image populated, silently **masking** those files. Fix: use `subPath` to place a single file, or mount elsewhere.
3. ⚠️ Expecting a `subPath`-mounted configMap/secret to hot-reload. It won't — subPath breaks the update mechanism. Fix: mount the whole volume, or restart on change.
4. ⚠️ RAM `emptyDir` (`medium: Memory`) with no `sizeLimit`, silently consuming memory and OOM-killing the Pod. Fix: always cap it and account for it in the memory limit.
5. ⚠️ Using `hostPath` for app data "because it's simple," then the Pod reschedules to another node and the data is gone. Fix: PVC + StorageClass.
6. ⚠️ Secret volume with default `0644` mode readable by any process in the container. Fix: `defaultMode: 0400`.
7. ⚠️ Forgetting that `configMap`/`secret` volumes fail Pod startup if the referenced object is missing (unless marked `optional: true`).

## 9. Interview Questions

**Q: What is the lifecycle of an `emptyDir` volume, and how does it differ from the container filesystem?**
A: An `emptyDir` is created when the Pod is assigned to a node and deleted permanently when the Pod is removed from the node. Crucially it *survives container restarts* within that Pod, whereas the container's own writable layer is wiped on every restart. It does not survive Pod deletion or rescheduling.

**Q: How do you share data between two containers in the same Pod?**
A: Declare a Pod-scoped volume (usually `emptyDir`) once in `spec.volumes`, then reference it in both containers' `volumeMounts` at whatever `mountPath` each needs. Both see the same underlying directory; one can mount it `readOnly`.

**Q: Explain the difference between `mountPath` and `subPath`.**
A: `mountPath` is where the *whole* volume appears in the container and it masks anything the image had there. `subPath` mounts only a single sub-file or sub-directory of the volume at that path, leaving sibling files from the image intact — used to drop one config file into a populated directory without hiding the rest.

**Q: Why might a configMap mounted as a volume update live but one mounted with `subPath` not?**
A: The kubelet keeps whole-volume configMap/secret mounts in sync by atomically swapping a symlinked directory on each resync. A `subPath` mount bind-mounts a single file at setup time and is *not* part of that symlink swap, so it never receives updates until the Pod restarts.

**Q: When would you choose a configMap volume over environment variables for config?**
A: When you need file-shaped config (e.g. an nginx.conf, a Java properties file), when the config is large, or when you want live updates without restarting — mounted files resync while env vars are frozen at container start. Env vars are fine for small, static scalars.

**Q: What is a projected volume and give a real use case.**
A: A projected volume merges multiple sources — configMap, secret, downwardAPI, and serviceAccountToken — into one directory. The canonical use is delivering a **bound service account token** (short-lived, audience-scoped) alongside a CA cert and namespace, e.g. for a workload authenticating to Vault or the API server.

**Q: Why is `hostPath` considered dangerous, and what should you use instead?**
A: `hostPath` mounts an arbitrary node path into the Pod, coupling the Pod to that node and enabling privilege escalation (mounting the runtime socket, node credentials, or `/`). Pod Security Baseline/Restricted forbid it. For app data use a PVC + StorageClass; for legitimate node agents, scope it tightly and gate with policy.

**Q: What is a generic ephemeral volume and how does it differ from `emptyDir`?**
A: A generic ephemeral volume is created via an inline `volumeClaimTemplate`, so it's provisioned by a CSI driver/StorageClass — you get real block/file storage with a size, snapshots, and topology awareness — but its lifecycle is still tied to the Pod (deleted when the Pod is deleted). It's `emptyDir`'s durability model with a PVC's capabilities.

**Q: A Secret is mounted as a volume but a security scan flags it as world-readable inside the container. Why and how do you fix it?**
A: Secret volumes default to `defaultMode: 0644`. Set `defaultMode: 0400` (or per-item `mode`) so only the owning UID can read it, and make sure the container runs as that UID. Also prefer volume mounts over env vars, which leak via `/proc`.

**Q: Where does a `medium: Memory` emptyDir's usage get counted, and what's the risk?**
A: It's a tmpfs on the node backed by RAM, and its usage counts against the Pod's memory (and the container's memory limit). Without a `sizeLimit` it can grow until the Pod is OOM-killed or the node comes under memory pressure — always cap it.

## 10. Practice

- [ ] Create a Pod with two containers sharing an `emptyDir`; have one write a timestamp loop and the other `tail -f` it. Delete the Pod and confirm the data is gone on recreate.
- [ ] Mount a ConfigMap as a volume, then patch the ConfigMap and time how long until the file inside the container changes.
- [ ] Reproduce the `subPath` no-update behavior: mount one key with `subPath`, patch it, confirm the file does *not* change.
- [ ] Mount a Secret with `defaultMode: 0400` and verify the permissions with `kubectl exec ... -- ls -l`.
- [ ] Build a projected volume that combines a configMap, a secret, and a 1-hour bound serviceAccountToken; inspect all three inside the Pod.

## 11. Cheat Sheet

> [!TIP]
> **Volume** = a directory mounted into containers; lifecycle tied to the **Pod**, not the container. `spec.volumes[]` = source, `volumeMounts[]` = where (`mountPath`) + how (`readOnly`, `subPath`).
> **emptyDir** scratch/sidecar-share (add `medium: Memory` for tmpfs, always `sizeLimit`). **hostPath** = node path, dangerous, forbidden by PSS. **configMap/secret** = files that hot-reload (except via `subPath`); set secret `defaultMode: 0400`. **projected** = merge configMap+secret+downwardAPI+**bound SA token**. **downwardAPI** = Pod metadata as files. **generic ephemeral** = CSI-backed scratch that still dies with the Pod. **PVC volume** = durable, outlives the Pod (topics 15–16). Mounting masks image files → use `subPath` for single files.

**References:** Kubernetes docs — Volumes; Kubernetes docs — Projected Volumes; Pod Security Standards; CNCF blog — Ephemeral Volumes

---
*Kubernetes Handbook — topic 14.*
