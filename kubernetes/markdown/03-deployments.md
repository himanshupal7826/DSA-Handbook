# 03 · ReplicaSets & Deployments

> **In one line:** A Deployment declares the desired state of a stateless app and manages ReplicaSets to keep N identical Pods running, rolling out new versions safely and rolling back when they fail.

---

## 1. Overview

You almost never create Pods directly. Instead you tell Kubernetes "I want N copies of this Pod template, always running," and let a controller make it so. That controller stack is the **Deployment → ReplicaSet → Pods** hierarchy — the standard way to run stateless workloads.

A **ReplicaSet** has exactly one job: keep a stated number of Pods matching a label selector alive. If a Pod dies, it makes a new one; if there are too many, it deletes some. It knows nothing about versions or updates.

A **Deployment** sits on top and adds *release management*. When you change the Pod template (say, a new image tag), the Deployment doesn't mutate Pods in place — it creates a **new ReplicaSet** for the new template and gradually shifts replicas from the old RS to the new one: a **rolling update**. Each ReplicaSet is a frozen snapshot of one version, which is exactly what makes instant **rollback** possible — the old RS is still there, just scaled to zero.

So the division of labor is clean: the ReplicaSet owns *"keep N pods alive,"* and the Deployment owns *"move safely between versions and remember history."* This is desired-state reconciliation applied to releases.

## 2. Core Concepts

- **Desired-state reconciliation** — you declare replicas + template; controllers continuously drive actual Pods toward that spec, recreating any that die.
- **ReplicaSet** — ensures a fixed number of Pods matching its `selector` exist. The self-healing primitive.
- **Deployment** — manages ReplicaSets to provide declarative updates, rollout control, and revision history.
- **Pod template (`spec.template`)** — the blueprint for Pods. Changing it triggers a new rollout; changing only `replicas` does not.
- **Rolling update** — the default strategy: incrementally replace old Pods with new ones so the app stays available throughout.
- **`maxSurge` / `maxUnavailable`** — the two knobs bounding a rollout: how many *extra* Pods may exist, and how many may be *missing*, during the transition.
- **Revision history** — each template change creates a new ReplicaSet kept around (bounded by `revisionHistoryLimit`) so you can roll back.
- **Rollback** — `kubectl rollout undo` scales the previous ReplicaSet back up and the current one down — no re-pull of old config needed.
- **Scaling** — change `replicas` (or `kubectl scale`); the current ReplicaSet adds/removes Pods without a new rollout.
- **`selector` is immutable** — the label selector links a Deployment/RS to its Pods and cannot be changed after creation.

## 3. Syntax & Examples

A Deployment with 3 replicas and an explicit rollout strategy:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 3
  revisionHistoryLimit: 5          # how many old ReplicaSets to keep
  selector:
    matchLabels: { app: web }      # must match template labels; immutable
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1                   # at most 1 extra Pod during rollout
      maxUnavailable: 0            # never drop below desired count
  template:
    metadata:
      labels: { app: web }
    spec:
      containers:
        - name: web
          image: nginx:1.27
          ports: [{ containerPort: 80 }]
```

Everyday rollout and scaling commands:

```bash
kubectl apply -f web.yaml

# trigger a rolling update by changing the image
kubectl set image deployment/web web=nginx:1.28
kubectl rollout status deployment/web        # watch it progress
kubectl rollout history deployment/web       # list revisions
kubectl rollout undo deployment/web          # roll back one revision

# scale (no new rollout)
kubectl scale deployment/web --replicas=5
```

## 4. Worked Example

Deploy v1, then roll out v2 with a zero-downtime strategy and observe the two ReplicaSets hand off.

```bash
kubectl apply -f web.yaml
kubectl get rs -l app=web
```

```text
NAME             DESIRED   CURRENT   READY   AGE
web-6f9c4d8b7    3         3         3       40s
```

One ReplicaSet, 3 ready Pods. Now roll to v2:

```bash
kubectl set image deployment/web web=nginx:1.28
kubectl rollout status deployment/web
```

```text
Waiting for deployment "web" rollout to finish: 1 old replicas are pending termination...
deployment "web" successfully rolled out
```

Mid-rollout, both ReplicaSets briefly coexist (new scaling up, old scaling down):

```text
NAME             DESIRED   CURRENT   READY   AGE
web-6f9c4d8b7    2         2         2       3m     # old (v1) draining
web-7c8d5e9f4    3         3         2       12s    # new (v2) ramping
```

After completion the old RS is scaled to 0 but *kept* for rollback:

```bash
kubectl get rs -l app=web
```

```text
NAME             DESIRED   CURRENT   READY   AGE
web-6f9c4d8b7    0         0         0       4m     # v1 kept at 0
web-7c8d5e9f4    3         3         3       70s    # v2 live
```

Suppose v2 is bad — roll back instantly (the old RS just scales back up):

```bash
kubectl rollout undo deployment/web
kubectl rollout status deployment/web
```

```text
deployment "web" successfully rolled out
```

No image re-config, no manifest editing — the frozen v1 ReplicaSet was simply reactivated.

## 5. Under the Hood

Two controllers cooperate. The **deployment controller** watches the Deployment and manages a set of ReplicaSets (one per template version), adjusting their `replicas` counts to orchestrate the rollout. The **replicaset controller** watches each ReplicaSet and creates/deletes Pods to hit its count. A template hash label (`pod-template-hash`) uniquely names each ReplicaSet and keeps their selectors from overlapping.

```svg
<svg viewBox="0 0 720 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="arw3" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>

  <!-- Deployment -->
  <rect x="270" y="20" width="180" height="56" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="360" y="44" text-anchor="middle" fill="#1e293b" font-weight="700">Deployment: web</text>
  <text x="360" y="62" text-anchor="middle" fill="#64748b">replicas: 3, strategy: RollingUpdate</text>

  <!-- old RS -->
  <rect x="70" y="130" width="220" height="56" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="180" y="153" text-anchor="middle" fill="#1e293b" font-weight="600">ReplicaSet web-6f9 (v1)</text>
  <text x="180" y="172" text-anchor="middle" fill="#64748b">desired: 0  (kept for rollback)</text>

  <!-- new RS -->
  <rect x="430" y="130" width="220" height="56" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="540" y="153" text-anchor="middle" fill="#1e293b" font-weight="600">ReplicaSet web-7c8 (v2)</text>
  <text x="540" y="172" text-anchor="middle" fill="#64748b">desired: 3  (live)</text>

  <line x1="330" y1="76" x2="200" y2="130" stroke="#475569" marker-end="url(#arw3)"/>
  <line x1="390" y1="76" x2="520" y2="130" stroke="#475569" marker-end="url(#arw3)"/>
  <text x="360" y="112" text-anchor="middle" fill="#64748b">manages (scales RSs)</text>

  <!-- pods v2 -->
  <rect x="440" y="250" width="60" height="42" rx="8" fill="#ffffff" stroke="#2563eb"/>
  <text x="470" y="276" text-anchor="middle" fill="#1e293b">pod</text>
  <rect x="510" y="250" width="60" height="42" rx="8" fill="#ffffff" stroke="#2563eb"/>
  <text x="540" y="276" text-anchor="middle" fill="#1e293b">pod</text>
  <rect x="580" y="250" width="60" height="42" rx="8" fill="#ffffff" stroke="#2563eb"/>
  <text x="610" y="276" text-anchor="middle" fill="#1e293b">pod</text>
  <line x1="540" y1="186" x2="540" y2="250" stroke="#475569" marker-end="url(#arw3)"/>

  <!-- old pods (none) -->
  <rect x="120" y="250" width="120" height="42" rx="8" fill="#ffffff" stroke="#94a3b8" stroke-dasharray="4 3"/>
  <text x="180" y="276" text-anchor="middle" fill="#64748b">0 pods</text>
  <line x1="180" y1="186" x2="180" y2="250" stroke="#94a3b8" stroke-dasharray="4 3" marker-end="url(#arw3)"/>

  <text x="360" y="340" text-anchor="middle" fill="#1e293b" font-weight="600">Rollback = scale v1 RS back to 3, v2 RS to 0. The snapshots already exist.</text>
  <text x="360" y="366" text-anchor="middle" fill="#64748b">Deployment controller scales RSs · ReplicaSet controller keeps each RS at its Pod count.</text>
</svg>
```

During a `RollingUpdate`, the deployment controller bumps the new RS up and the old RS down in steps bounded by `maxSurge` and `maxUnavailable`, waiting for new Pods to pass their **readiness probe** before continuing — that gate is what makes it *zero-downtime*. The old ReplicaSet is never deleted (just scaled to 0), which is the whole mechanism behind instant rollback.

## 6. Variations & Trade-offs

| Strategy | How it works | Pros | Cons |
|----------|-------------|------|------|
| **RollingUpdate** (default) | Gradually replace old with new (surge/unavailable bounded) | Zero downtime, no extra full fleet | Two versions run at once; must be compatible |
| **Recreate** | Kill all old, then start all new | Simple; never mixes versions | Downtime during the gap |
| **Blue/Green** (via 2 Deployments + Service switch) | Stand up v2 fully, flip traffic | Instant cutover & rollback | 2x resources during overlap |
| **Canary** (extra small Deployment or a mesh) | Send a slice of traffic to v2 first | Limits blast radius | More moving parts |

Deployment vs its cousins: use a **Deployment** for stateless, interchangeable Pods; a **StatefulSet** when Pods need stable identity/storage; a **DaemonSet** for one Pod per node; a **Job/CronJob** for run-to-completion work. The RollingUpdate assumption — that any Pod can replace any other — is exactly why Deployments don't fit stateful apps.

## 7. Production / Performance Notes

- **Readiness probes are mandatory for safe rollouts.** Without one, Kubernetes considers a Pod "ready" as soon as the container starts, so a rollout can march forward replacing healthy Pods with broken-but-started ones. The probe is the gate.
- **`maxUnavailable: 0, maxSurge: 1`** gives the safest (but slower) zero-downtime rollout; raise `maxSurge` for speed if you have headroom.
- **Set `revisionHistoryLimit`** (default 10) deliberately — too high clutters etcd with old ReplicaSets; too low removes rollback targets.
- **`minReadySeconds`** makes a new Pod wait N seconds after Ready before counting as available — cheap insurance against Pods that crash seconds after starting.
- **Pause/resume** long rollouts (`kubectl rollout pause/resume`) to bake a canary or batch several changes into one rollout.
- **Rollouts only trigger on template changes.** A ConfigMap the Pods mount changing does *not* restart Pods — use `kubectl rollout restart` or a checksum annotation to force it.
- **`progressDeadlineSeconds`** marks a stuck rollout as failed so automation/alerts can react instead of hanging forever.

## 8. Common Mistakes

1. ⚠️ **No readiness probe → a broken rollout looks healthy.** Kubernetes replaces good Pods with bad ones because "started" == "ready." Fix: add a real readiness probe.
2. ⚠️ **Selector doesn't match template labels.** The Deployment is rejected or adopts nothing. Fix: ensure `spec.selector.matchLabels` ⊆ `spec.template.metadata.labels`; the selector is immutable.
3. ⚠️ **Editing Pods directly instead of the Deployment.** The controller reconciles them right back. Fix: change `spec.template` and let it roll.
4. ⚠️ **Expecting a ConfigMap/Secret change to roll Pods.** It doesn't. Fix: `kubectl rollout restart deployment/x` or add a config checksum annotation to the template.
5. ⚠️ **`maxUnavailable` too high in a small fleet.** With 2 replicas and `maxUnavailable: 50%`, you can drop to 1 during rollout. Fix: use `maxUnavailable: 0` + `maxSurge: 1` for small critical services.
6. ⚠️ **Using a Deployment for a stateful app.** Interchangeable-Pod assumptions corrupt data. Fix: use a StatefulSet.
7. ⚠️ **Not setting resource requests → scheduler over-packs during surge.** The extra surge Pod may fail to schedule. Fix: set requests and ensure cluster headroom.

## 9. Interview Questions

**Q: What's the difference between a ReplicaSet and a Deployment?**
A: A ReplicaSet only keeps a fixed number of Pods matching a selector alive (self-healing). A Deployment manages ReplicaSets on top of that to provide declarative updates, rolling releases, and revision history/rollback. You almost always use a Deployment, which creates ReplicaSets for you.

**Q: How does a rolling update actually work?**
A: On a template change the Deployment creates a new ReplicaSet and gradually scales it up while scaling the old one down, bounded by maxSurge and maxUnavailable, waiting for new Pods to pass readiness before proceeding — keeping the app available throughout.

**Q: How does rollback work and why is it instant?**
A: Each template version is a separate ReplicaSet that isn't deleted after rollout, just scaled to 0. `kubectl rollout undo` scales the previous RS back up and the current one down. The old version's snapshot already exists, so there's nothing to re-fetch or rebuild.

**Q: What do maxSurge and maxUnavailable control?**
A: maxSurge is how many Pods above the desired count may exist during a rollout (speed); maxUnavailable is how many below the desired count may be missing (availability). `maxUnavailable: 0, maxSurge: 1` is the safest zero-downtime setting.

**Q: What triggers a new rollout vs just a scale?**
A: Any change to the Pod template (`spec.template`) creates a new ReplicaSet and triggers a rollout. Changing only `spec.replicas` (or `kubectl scale`) adjusts the current ReplicaSet's Pod count with no new version.

**Q: Why is a readiness probe critical during rollouts?**
A: The rollout advances only as new Pods become Ready. Without a readiness probe, "container started" is treated as ready, so the Deployment will happily replace healthy Pods with broken ones. The probe gates progression and preserves zero downtime.

**Q: When would you choose Recreate over RollingUpdate?**
A: When two versions cannot run simultaneously — e.g. an incompatible schema migration or a singleton that can't have two instances. Recreate terminates all old Pods before starting new ones, accepting downtime to avoid version overlap.

**Q: (Senior) A ConfigMap changed but Pods didn't restart — why, and how do you force it?**
A: Deployments only roll on template changes; a mounted ConfigMap changing doesn't alter the template. Force a restart with `kubectl rollout restart deployment/x`, or embed a hash of the config as a pod annotation so any config change mutates the template and triggers a rollout.

**Q: (Senior) How do you implement a canary or blue/green with plain Deployments?**
A: Canary: run a second small Deployment of the new version behind the same Service (label-selected) to take a fraction of traffic, then scale up if healthy. Blue/green: run two full Deployments and switch the Service selector (or Ingress) from blue to green for an instant cutover with instant rollback.

**Q: (Senior) Why can't a Deployment safely manage a database?**
A: Deployments assume Pods are interchangeable and replaceable in any order with shared/no identity — RollingUpdate reflects that. A database needs stable network identity, stable per-Pod storage, and ordered start/stop, which is what StatefulSets provide.

**Q: (Senior) What does progressDeadlineSeconds do and why set it?**
A: It's the time a rollout may make no progress before being marked as failed (a Progressing=False condition). It stops a stuck rollout from hanging indefinitely and lets automation or alerting react and roll back.

## 10. Practice

- [ ] Create a Deployment with 3 replicas, then `kubectl scale` to 5 and confirm no new ReplicaSet was created.
- [ ] `kubectl set image` to a new tag and watch two ReplicaSets coexist via `kubectl get rs -w` during the rollout.
- [ ] Roll out a deliberately broken image (bad tag), watch the rollout stall, then `kubectl rollout undo` to recover.
- [ ] Set `maxUnavailable: 0` and `maxSurge: 1`, add a readiness probe, and confirm zero unready Pods during a rollout.
- [ ] Change a mounted ConfigMap, observe Pods don't restart, then use `kubectl rollout restart` to force them.

## 11. Cheat Sheet

> [!TIP]
> **Deployment → ReplicaSet → Pods.** RS keeps N Pods alive (self-healing); Deployment manages RSs for rolling updates + rollback history.
> **Rollout:** template change → new RS; controller shifts replicas old→new bounded by `maxSurge` (extra) / `maxUnavailable` (missing), gated by readiness probes. Scale = change `replicas` (no new RS).
> **Rollback:** old RS kept at 0 → `kubectl rollout undo` scales it back. Instant.
> **Key commands:** `set image`, `rollout status/history/undo/restart/pause/resume`, `scale`.
> **Rules:** readiness probe is mandatory for safe rollouts · `maxUnavailable:0 + maxSurge:1` = safest · config changes don't roll (use `rollout restart`) · stateful ⇒ StatefulSet, not Deployment · selector is immutable.

**References:** Kubernetes docs "Deployments" & "ReplicaSet", "Rolling out updates" tutorial, Kubernetes blog on Deployment strategies

---
*Kubernetes Handbook — topic 03.*
