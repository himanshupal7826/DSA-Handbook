# 05 · ConfigMaps & Secrets

> **In one line:** ConfigMaps and Secrets externalize configuration from images so the same artifact runs in every environment — injected as env vars or mounted files, with Secrets base64-*encoded* (not encrypted) and meant for sensitive values.

---

## 1. Overview

The **twelve-factor** rule is "store config in the environment." In Kubernetes that environment is a **ConfigMap** (non-sensitive config: feature flags, URLs, tuning) or a **Secret** (sensitive: passwords, tokens, TLS keys). Both are just `key → value` API objects; the value ends up in your container either as **environment variables** or as **files in a mounted volume**. The payoff: one immutable image promotes from dev to prod unchanged, with only the ConfigMap/Secret swapping per environment.

The single most misunderstood fact: **a Secret is not encrypted.** Its values are **base64-encoded** in the object, which is trivially reversible. The reason Secrets exist as a separate kind is that they get *different treatment* — separate RBAC, optional **encryption-at-rest** in etcd, tmpfs mounts, and they're kept out of logs/`describe` — not that the payload is cryptographically protected on its own.

You reach for these whenever a value differs by environment or must not be baked into an image. Choose **env vars** for simple scalars a process reads at startup, and **volume mounts** for whole config files, certs, or values you want to update without a restart.

---

## 2. Core Concepts

- **ConfigMap** — non-confidential `key: value` (or whole files) up to ~1 MiB (etcd limit). Stored as plain data.
- **Secret** — same shape, values base64-encoded, typed (`Opaque`, `kubernetes.io/tls`, `kubernetes.io/dockerconfigjson`, `kubernetes.io/service-account-token`, `basic-auth`, `ssh-auth`).
- **base64 ≠ encryption** — `echo cGFzcw== | base64 -d` reverses it instantly. Real protection = etcd **encryption-at-rest** + RBAC + (better) an external store like Vault / cloud KMS via CSI.
- **Injection as env vars** — `env[].valueFrom.configMapKeyRef` / `secretKeyRef` for single keys, or `envFrom` to import every key as an env var.
- **Injection as volume** — mount the object; each key becomes a file whose contents are the value. Supports `items` to remap keys→paths and `defaultMode` for file permissions.
- **Env vars are a snapshot** — captured at container start; updating the ConfigMap does **not** change them. Volume-mounted keys are **updated in place** (eventual, ~kubelet sync period ≈ 1 min), *unless* the volume uses `subPath`.
- **Immutable ConfigMaps/Secrets** — `immutable: true` forbids updates; the kubelet stops watching them, cutting API-server load at scale and preventing accidental drift. Roll by creating a new object.
- **Rollout on change** — Pods don't restart when a ConfigMap changes. Force a rollout by versioning the object name or by hashing its content into a Pod annotation.
- **`optional` / `defaultMode`** — a reference can be `optional: true` (Pod starts even if missing); `defaultMode: 0400` restricts secret file perms.

---

## 3. Syntax & Examples

Create imperatively and inspect:

```bash
kubectl create configmap app-config \
  --from-literal=LOG_LEVEL=info \
  --from-literal=FEATURE_X=true \
  --from-file=app.properties          # file becomes a key

kubectl create secret generic db-cred \
  --from-literal=username=admin \
  --from-literal=password='S3cr3t!'
```

Declarative ConfigMap with scalar keys and a whole file:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  LOG_LEVEL: info
  FEATURE_X: "true"
  app.properties: |
    server.port=8080
    cache.ttl=300
```

Secret — `stringData` lets you write plaintext; the API server base64-encodes it into `data`:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: db-cred
type: Opaque
stringData:            # convenience: written as-is, stored base64
  username: admin
  password: "S3cr3t!"
immutable: true
```

Consume both — env vars and a mounted file:

```yaml
spec:
  containers:
    - name: api
      image: registry.io/api:2.3.1
      env:
        - name: LOG_LEVEL
          valueFrom:
            configMapKeyRef: { name: app-config, key: LOG_LEVEL }
        - name: DB_PASSWORD
          valueFrom:
            secretKeyRef: { name: db-cred, key: password }
      envFrom:
        - configMapRef: { name: app-config }   # import ALL keys
      volumeMounts:
        - name: cfg
          mountPath: /etc/app          # app.properties appears here
          readOnly: true
        - name: creds
          mountPath: /etc/secrets
          readOnly: true
  volumes:
    - name: cfg
      configMap:
        name: app-config
        items:
          - { key: app.properties, path: app.properties }
    - name: creds
      secret:
        secretName: db-cred
        defaultMode: 0400
```

---

## 4. Worked Example

Ship a config change and force a rollout via a content hash annotation (the clean pattern Kustomize/Helm automate).

```yaml
# Pod template gets an annotation that CHANGES when config changes → new rollout
spec:
  template:
    metadata:
      annotations:
        checksum/config: "a1b2c3"   # sha256 of the ConfigMap data
    spec:
      containers: [ ... envFrom: [ configMapRef: { name: app-config } ] ]
```

```bash
# 1. Change the config
kubectl create configmap app-config --from-literal=LOG_LEVEL=debug \
  --dry-run=client -o yaml | kubectl apply -f -

# 2. Env vars are a SNAPSHOT — running Pods still say info. Force a restart:
kubectl rollout restart deployment/api
kubectl rollout status  deployment/api
```

```text
configmap/app-config configured
deployment.apps/api restarted
Waiting for deployment "api" rollout to finish: 1 old replicas are pending termination...
deployment "api" successfully rolled out

$ kubectl exec deploy/api -- printenv LOG_LEVEL
debug                      # new Pods picked up the change

# A volume-mounted key would have updated WITHOUT restart:
$ kubectl exec deploy/api -- cat /etc/app/app.properties   # reflects new value after ~1m
```

Takeaway: **env-var config needs a restart; volume-mounted config updates live** (no `subPath`). The checksum annotation makes `kubectl apply` roll Pods automatically when config drifts.

---

## 5. Under the Hood

The kubelet, when starting a Pod, resolves each `configMapKeyRef`/`secretKeyRef` and injects env vars once. For volumes it creates an **atomically-swapped symlink** directory: keys are written into a timestamped `..data` dir and a symlink is flipped, so readers never see a half-written file. A background sync loop re-reads the objects (~1 min) and re-flips the symlink on change — that's why *mounted* keys update but *env vars* (read once) don't. **Secret volumes are backed by `tmpfs`** (RAM), so plaintext never hits the node disk. `subPath` mounts break auto-update because they copy a single file rather than symlinking the projected dir.

```svg
<svg viewBox="0 0 780 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <rect x="30" y="30" width="180" height="120" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="120" y="55" text-anchor="middle" fill="#1e293b">API server / etcd</text>
  <text x="120" y="80" text-anchor="middle" fill="#64748b">ConfigMap (plain)</text>
  <text x="120" y="100" text-anchor="middle" fill="#64748b">Secret (base64,</text>
  <text x="120" y="118" text-anchor="middle" fill="#64748b">enc-at-rest opt-in)</text>

  <rect x="300" y="30" width="180" height="90" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="390" y="60" text-anchor="middle" fill="#1e293b">kubelet</text>
  <text x="390" y="82" text-anchor="middle" fill="#64748b">resolves refs,</text>
  <text x="390" y="100" text-anchor="middle" fill="#64748b">sync loop ~1m</text>

  <rect x="560" y="20" width="190" height="60" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="655" y="45" text-anchor="middle" fill="#1e293b">env vars (once)</text>
  <text x="655" y="65" text-anchor="middle" fill="#64748b">snapshot — no live update</text>

  <rect x="560" y="120" width="190" height="80" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="655" y="148" text-anchor="middle" fill="#1e293b">volume mount</text>
  <text x="655" y="168" text-anchor="middle" fill="#64748b">tmpfs, ..data symlink</text>
  <text x="655" y="186" text-anchor="middle" fill="#64748b">live-updates (no subPath)</text>

  <line x1="210" y1="90" x2="298" y2="75" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="480" y1="60" x2="558" y2="50" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="480" y1="90" x2="558" y2="150" stroke="#475569" marker-end="url(#ah)"/>

  <rect x="300" y="230" width="450" height="70" rx="8" fill="none" stroke="#64748b" stroke-dasharray="4 4"/>
  <text x="525" y="258" text-anchor="middle" fill="#64748b">container reads env at start OR files from /etc/... at runtime</text>
  <text x="525" y="282" text-anchor="middle" fill="#64748b">change ConfigMap → mounted files update, env needs rollout restart</text>
  <line x1="655" y1="200" x2="600" y2="228" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="655" y1="80"  x2="600" y2="228" stroke="#475569" stroke-dasharray="3 3" marker-end="url(#ah)"/>
</svg>
```

---

## 6. Variations & Trade-offs

| Aspect | Env var injection | Volume mount |
|---|---|---|
| Best for | Simple scalars read at startup | Whole config files, certs, keys |
| Live update on change | ❌ snapshot at start | ✅ ~1 min (no `subPath`) |
| Visible in `describe pod` | Yes (leaks secrets to logs) | No |
| Whole-file config | Awkward | Natural |
| Restart to apply | Required (`rollout restart`) | Not required |

| Aspect | ConfigMap | Secret |
|---|---|---|
| Encoding | plain UTF-8 | base64 (not encryption) |
| RBAC treated specially | No | Yes (separate, tighter) |
| Encryption at rest | No | Optional (EncryptionConfiguration) |
| Volume backing | node disk | tmpfs (RAM) |
| Use for | flags, URLs, tuning | passwords, tokens, TLS |

**Immutable** ConfigMaps/Secrets trade flexibility for performance and safety: the kubelet stops watching them (big API-server savings on large clusters) and they can't be edited — you create a new one and roll. Prefer immutable + versioned names in production.

---

## 7. Production / Performance Notes

- **Turn on etcd encryption-at-rest** (`EncryptionConfiguration` with a KMS provider). Without it, anyone with etcd/backup access reads every Secret in plaintext.
- **Prefer an external secret manager** (Vault, cloud KMS) via the **Secrets Store CSI driver** or External Secrets Operator, so secrets never live long-term in etcd and rotate centrally.
- **Lock down RBAC on Secrets** — `get`/`list` on Secrets in a namespace effectively exposes all of them. Grant narrowly; avoid wildcard verbs.
- **Never put secrets in env vars if you can avoid it** — they leak via `kubectl describe`, crash dumps, child-process inheritance, and logging middleware. Mount as files with `defaultMode: 0400`.
- **Use immutable + content-hashed names at scale** — thousands of watched ConfigMaps strain the API server; immutability removes the watch and a hashed name (`app-config-a1b2c3`) makes rollouts atomic and rollbacks trivial.
- **Mind the ~1 MiB limit** — ConfigMaps/Secrets aren't a filesystem; large blobs belong in object storage or an init-container fetch.
- **`subPath` mounts don't auto-update** — a frequent surprise. Use full-directory mounts if you rely on live reload.

---

## 8. Common Mistakes

1. ⚠️ **Believing Secrets are encrypted.** base64 is encoding. *Fix:* enable encryption-at-rest + tight RBAC, or use an external manager.
2. ⚠️ **Expecting env vars to update when the ConfigMap changes.** They're a startup snapshot. *Fix:* `kubectl rollout restart`, or mount as a volume, or use a checksum annotation.
3. ⚠️ **Mounting with `subPath` and expecting live reload.** subPath copies once. *Fix:* mount the whole projected directory.
4. ⚠️ **Committing Secret YAML to git.** The base64 is plaintext to anyone. *Fix:* Sealed Secrets / SOPS / external store; never commit raw Secrets.
5. ⚠️ **`envFrom` importing a key with an invalid env-var name** (e.g. contains `.`), silently skipped. *Fix:* keep keys valid identifiers or reference explicitly.
6. ⚠️ **Editing an `immutable: true` object.** The API rejects it. *Fix:* create a new versioned object and roll the workload.
7. ⚠️ **Wrong-namespace reference.** ConfigMaps/Secrets are namespaced; a Pod can only reference ones in its own namespace. *Fix:* create the object in the Pod's namespace.
8. ⚠️ **Secret in a container's env then logging `printenv`/stack traces.** Leaks credentials. *Fix:* file mounts + `0400`; scrub logs.

---

## 9. Interview Questions

**Q: Are Kubernetes Secrets encrypted?**
A: Not by default — values are base64-*encoded*, which is trivially reversible. Secrets exist as a distinct kind so they get tighter RBAC, tmpfs volume mounts, exclusion from `describe`, and *optional* encryption-at-rest in etcd. For real confidentiality you enable EncryptionConfiguration (KMS) or use an external manager like Vault via the Secrets Store CSI driver.

**Q: What's the difference between injecting config as env vars vs. volume mounts?**
A: Env vars are captured once at container start — a snapshot that never changes until the Pod restarts, and they can leak via `describe`/logs. Volume-mounted keys appear as files, are updated in place (~1 min via the kubelet sync loop, unless `subPath`), are hidden from `describe`, and suit whole files/certs. Use env for simple scalars, volumes for files or live-updatable config.

**Q: I changed a ConfigMap but my app didn't pick it up. Why?**
A: Almost always because the app reads config as env vars, which are a start-time snapshot — running Pods keep the old values. Force a rollout (`kubectl rollout restart`), or mount the ConfigMap as a volume so files update live (no `subPath`), or hash the config into a Pod annotation so `apply` triggers a rollout automatically.

**Q: What does `immutable: true` do and why use it?**
A: It forbids any update to a ConfigMap/Secret's data. Benefits: the kubelet stops watching it — large clusters shed significant API-server/watch load — and it prevents accidental config drift. You roll changes by creating a new (usually content-hash-named) object and updating the workload to point at it.

**Q: How do you force a Deployment to roll when its ConfigMap changes?** *(senior)*
A: Put a content hash of the ConfigMap into the Pod template's annotations (`checksum/config: <sha256>`). Because the Pod template changes, `kubectl apply` triggers a rollout. Helm and Kustomize automate this (Kustomize appends a hash to the ConfigMap name and rewrites references). Alternatively `kubectl rollout restart` manually.

**Q: Why are secret volumes backed by tmpfs?** *(senior)*
A: tmpfs is RAM-backed, so plaintext secret material never gets written to the node's persistent disk — reducing exposure via disk forensics, snapshots, or a stolen drive. It's freed when the Pod stops.

**Q: How do you secure Secrets properly in production?** *(senior)*
A: Layer it: (1) enable etcd encryption-at-rest with a KMS provider; (2) tighten RBAC — `get/list` on Secrets is effectively read-all, so scope narrowly; (3) prefer an external store (Vault, cloud KMS) via the Secrets Store CSI driver / External Secrets Operator so secrets don't persist in etcd and rotate centrally; (4) mount as files `0400`, avoid env vars; (5) keep raw Secrets out of git (Sealed Secrets/SOPS).

**Q: What happens if a referenced ConfigMap/Secret key is missing?**
A: By default the Pod fails to start (env ref) or the volume can't be populated. Marking the reference `optional: true` lets the Pod start without it. For a whole `envFrom`/volume of a missing object, `optional` similarly makes it non-blocking.

**Q: Why doesn't a `subPath` volume mount get live updates?**
A: A normal ConfigMap/Secret volume is a projected directory the kubelet atomically re-symlinks on change. `subPath` mounts a single file copied out of that projection, so the kubelet's symlink flip doesn't reach it — the file is frozen until the Pod restarts.

**Q: What are the size limits and what belongs elsewhere?**
A: A single ConfigMap/Secret is bounded by the etcd object size (~1 MiB). They're for configuration, not storage — large certs bundles, datasets, or binaries belong in object storage or an init-container fetch, keeping etcd lean.

**Q: What Secret `type`s exist and why does typing matter?** *(senior)*
A: `Opaque` (generic), `kubernetes.io/tls` (cert+key, consumed by Ingress/mesh), `kubernetes.io/dockerconfigjson` (imagePull creds), `kubernetes.io/service-account-token`, `basic-auth`, `ssh-auth`. Typing lets Kubernetes and controllers validate required keys and consume them in the right way (e.g. an Ingress expects a `tls` Secret with `tls.crt`/`tls.key`).

---

## 10. Practice

- [ ] Create a ConfigMap with a scalar and a whole `.properties` file; consume the scalar via `configMapKeyRef` and mount the file at `/etc/app`.
- [ ] Prove env vars don't live-update: change the ConfigMap, `exec printenv`, then `rollout restart` and re-check.
- [ ] Mount a ConfigMap as a volume, edit it, and watch the file change without a restart (~1 min); repeat with `subPath` and observe it does NOT.
- [ ] Create an `immutable: true` Secret, try to edit it (see the rejection), then roll to a new hash-named version.
- [ ] Enable a `defaultMode: 0400` secret mount and verify file permissions inside the container.

---

## 11. Cheat Sheet

> [!TIP]
> **Externalize config; Secret = encoded, not encrypted.**
> - ConfigMap = non-secret `key:value`/files; Secret = same but base64 + tighter RBAC + tmpfs + optional enc-at-rest.
> - `base64 -d` reverses a Secret — real protection = etcd encryption + RBAC + external manager (Vault/CSI).
> - Consume: `configMapKeyRef`/`secretKeyRef` (one key), `envFrom` (all), or volume mount (files).
> - **Env vars = start-time snapshot** (need `rollout restart`); **volume keys update live** (~1m, *not* with `subPath`).
> - Force rollout on change: content-hash annotation (`checksum/config`) or hash the object name (Kustomize).
> - Prefer file mounts `0400` over env for secrets; never commit raw Secret YAML.
> - `immutable: true` → no edits, kubelet stops watching (scale win); roll via new versioned object.
> - Size limit ~1 MiB; namespaced (same-ns references only).

**References:** Kubernetes docs — ConfigMaps, Secrets, Encrypting Secret Data at Rest; Secrets Store CSI Driver; Kustomize configMapGenerator

---
*Kubernetes Handbook — topic 05.*
