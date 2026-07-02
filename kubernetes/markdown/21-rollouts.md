# 21 · Rollouts: Rolling, Blue-Green & Canary

> **In one line:** Ship new versions without downtime by controlling *how fast* old pods are replaced and *how much* traffic the new version sees.

---

## 1. Overview

A **rollout** is the process of moving a workload from version *N* to version *N+1*. The hard part is not launching the new pods — it is doing so without dropping requests, and being able to *abort* the instant something looks wrong. Kubernetes gives you one built-in strategy (**RollingUpdate**) and the primitives (Services, labels, replicas) to build two more advanced ones (**blue-green** and **canary**) yourself or via a controller like **Argo Rollouts** or a service mesh.

The three strategies trade **speed**, **risk**, and **cost** differently. A rolling update is cheap (no extra capacity) but exposes every user to the new version gradually. Blue-green is instant to switch and instant to revert, but doubles capacity during the cutover. Canary sends a *small slice* of real traffic to the new version, measures it, and promotes only if metrics hold — the safest, but the most machinery.

You reach for rollouts every time you deploy. The mechanics (`maxSurge`/`maxUnavailable`), the observability (`kubectl rollout status`), and the escape hatch (`kubectl rollout undo`) are core operational skills — a bad rollout is the single most common way to cause a production incident.

## 2. Core Concepts

- **Revision** — each change to a Deployment's pod template creates a new ReplicaSet, tracked as a numbered revision. Old ReplicaSets are kept (scaled to 0) for rollback.
- **maxSurge** — how many pods *above* the desired count may exist during a rollout (e.g. `1` or `25%`). Higher = faster, more capacity used.
- **maxUnavailable** — how many pods *below* desired may be unavailable at once. `0` = strict zero-downtime; the new pod must be Ready before an old one dies.
- **Readiness gating** — the rollout only progresses when new pods pass their **readiness probe**. Without it, "Ready" means "process started," not "serving traffic."
- **progressDeadlineSeconds** — if the rollout makes no progress within this window, it is marked `Failed` (does *not* auto-rollback, but stops surprising you).
- **Rolling update** — in-place, pod-by-pod replacement using surge/unavailable. Default strategy.
- **Blue-green** — two full environments (blue = live, green = new); flip a Service selector to cut over atomically; keep blue for instant rollback.
- **Canary** — run a small number of new-version pods behind the *same* Service (or weighted via mesh) so a fraction of traffic exercises them; promote or abort based on metrics.
- **Argo Rollouts** — a CRD (`kind: Rollout`) replacing Deployment that natively encodes canary steps, analysis, and automated promotion/abort.

## 3. Syntax & Examples

**Rolling update — tune surge/unavailable for zero downtime:**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: web }
spec:
  replicas: 4
  progressDeadlineSeconds: 120
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1          # at most 5 pods during rollout
      maxUnavailable: 0    # never drop below 4 Ready pods
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers:
        - name: web
          image: myapp:1.3
          readinessProbe:            # gates rollout progress
            httpGet: { path: /healthz, port: 8080 }
            periodSeconds: 5
```

**Drive and observe a rollout:**

```bash
kubectl set image deploy/web web=myapp:1.4   # triggers new revision
kubectl rollout status deploy/web            # blocks until done or failed
kubectl rollout history deploy/web           # list revisions
kubectl rollout pause deploy/web             # freeze mid-rollout (manual canary)
kubectl rollout resume deploy/web
```

**Rollback safely:**

```bash
kubectl rollout undo deploy/web                    # back to previous revision
kubectl rollout undo deploy/web --to-revision=3    # to a specific revision
```

**Blue-green — flip a Service selector:**

```bash
# Two deployments: web-blue (version=blue) live, web-green (version=green) new.
# Service currently selects version=blue. After validating green:
kubectl patch svc web -p '{"spec":{"selector":{"app":"web","version":"green"}}}'
# Instant revert: patch back to version=blue.
```

**Canary with Argo Rollouts (weighted steps):**

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata: { name: web }
spec:
  replicas: 10
  strategy:
    canary:
      steps:
        - setWeight: 10      # 10% of traffic to canary
        - pause: { duration: 5m }
        - setWeight: 50
        - pause: {}          # pause indefinitely — wait for manual promote
        - setWeight: 100
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers: [{ name: web, image: myapp:1.4 }]
```

## 4. Worked Example

Ship `myapp:1.4` to a 4-replica service with strict zero-downtime, watch it, then roll back after discovering an error spike.

```bash
$ kubectl set image deploy/web web=myapp:1.4
deployment.apps/web image updated

$ kubectl rollout status deploy/web
Waiting for deployment "web" rollout to finish: 1 out of 4 new replicas have been updated...
Waiting for deployment "web" rollout to finish: 2 out of 4 new replicas have been updated...
Waiting for deployment "web" rollout to finish: 3 out of 4 new replicas have been updated...
deployment "web" successfully rolled out

$ kubectl get rs -l app=web
NAME             DESIRED   CURRENT   READY   AGE
web-7d9f8c6b5    4         4         4       40s     # new (1.4)
web-6c4b2a1f9    0         0         0       6d      # old (1.3), kept for rollback

# ...error rate climbs in dashboards. Abort:
$ kubectl rollout undo deploy/web
deployment.apps/web rolled back

$ kubectl rollout status deploy/web
deployment "web" successfully rolled out
```

Result: because `maxUnavailable: 0`, at least 4 pods stayed Ready throughout both the roll-forward and the rollback — no dropped requests. The old ReplicaSet scaling back to 4 *is* the rollback; nothing was re-pulled or rebuilt, so it completes in seconds.

## 5. Under the Hood

A Deployment never touches pods directly. It creates a new **ReplicaSet** for the new pod template and then plays a control loop: scale the new RS up by `maxSurge`, wait for new pods to become **Ready** (readiness probe), scale the old RS down by `maxUnavailable`, repeat. Old ReplicaSets are retained at 0 replicas — this is what makes `rollout undo` instant.

Canary changes *what fraction of traffic* the new version sees. With plain Services, traffic split is proportional to pod count (kube-proxy load-balances across all endpoints matching the selector), so "10% canary" ≈ 1 canary pod per 9 stable. A **service mesh** (Istio/Linkerd) or Argo Rollouts with a mesh decouples traffic weight from pod count via routing rules — 10% of requests regardless of replica ratio.

```svg
<svg viewBox="0 0 640 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="320" y="22" text-anchor="middle" fill="#1e293b" font-weight="700">Canary traffic shift: 10% → 50% → 100%</text>

  <!-- users -->
  <rect x="20" y="120" width="90" height="50" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="65" y="150" text-anchor="middle" fill="#1e293b">Users</text>
  <line x1="110" y1="145" x2="180" y2="145" stroke="#475569" marker-end="url(#ah)"/>

  <!-- router -->
  <rect x="180" y="120" width="100" height="50" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="230" y="143" text-anchor="middle" fill="#1e293b">Mesh /</text>
  <text x="230" y="160" text-anchor="middle" fill="#1e293b">Service</text>

  <!-- stable -->
  <rect x="380" y="55" width="220" height="50" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="490" y="79" text-anchor="middle" fill="#1e293b" font-weight="600">Stable  v1.3</text>
  <text x="490" y="96" text-anchor="middle" fill="#64748b">90% → 50% → 0%</text>

  <!-- canary -->
  <rect x="380" y="185" width="220" height="50" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="490" y="209" text-anchor="middle" fill="#1e293b" font-weight="600">Canary  v1.4</text>
  <text x="490" y="226" text-anchor="middle" fill="#64748b">10% → 50% → 100%</text>

  <line x1="280" y1="135" x2="380" y2="82" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="280" y1="155" x2="380" y2="208" stroke="#d97706" marker-end="url(#ah)"/>

  <text x="230" y="250" text-anchor="middle" fill="#64748b">metrics gate each step → promote or abort (auto-rollback)</text>
</svg>
```

## 6. Variations & Trade-offs

| Strategy | Extra capacity | Blast radius | Rollback speed | Traffic control | Tooling |
|---|---|---|---|---|---|
| **RollingUpdate** | ~maxSurge (small) | all users, gradually | seconds (`undo`) | none (all-or-nothing per pod) | built-in |
| **Recreate** | none | 100% + downtime | seconds | n/a (kills all, then starts) | built-in |
| **Blue-green** | 2× (both live) | 0% until flip, then 100% | instant (flip back) | atomic switch | Service selector / Argo |
| **Canary** | +canary pods | small % first | fast (drop canary) | fine-grained % | mesh / Argo Rollouts / Flagger |

Rolling update is the sane default for most stateless services. Use **Recreate** only when two versions cannot coexist (incompatible schema, exclusive lock). Choose **blue-green** when you need an atomic, fully-validated cutover and can afford double capacity briefly. Choose **canary** for high-traffic services where you want statistical confidence from real users before a full promotion — pair it with automated analysis so promotion/abort is data-driven, not a human staring at Grafana at 2am.

## 7. Production / Performance Notes

- **Readiness probes are non-negotiable.** Without one, the rollout races ahead and swaps out healthy pods for ones that aren't serving yet — self-inflicted outage.
- **maxUnavailable: 0 + maxSurge: 1** is the classic zero-downtime recipe, but it's slower and needs headroom for +1 pod. For large fleets, percentages (`maxSurge: 25%`) roll faster.
- **Set `progressDeadlineSeconds`** (default 600) so a stuck rollout surfaces as `Failed` instead of hanging forever.
- **Deployments do not auto-rollback.** A failed rollout stays failed. Argo Rollouts/Flagger add automated abort on metric breach; with plain Deployments you (or your CD pipeline) must `undo`.
- **PodDisruptionBudgets** interact with rollouts and node drains — a too-strict PDB can stall a rollout.
- **Database migrations** must be backward-compatible for any strategy where two versions run simultaneously (rolling, canary, blue-green mid-cutover). Expand-then-contract schema changes.
- **`revisionHistoryLimit`** (default 10) caps retained old ReplicaSets; set it low to reduce clutter but keep ≥2–3 for rollback options.

## 8. Common Mistakes

1. ⚠️ **No readiness probe** → rollout replaces pods before they serve, dropping requests. *Fix:* always define a readiness probe that reflects real serving state.
2. ⚠️ **Using `:latest` image tags** → `rollout undo` reverts the spec but the tag may now point at the same/broken image. *Fix:* immutable, versioned tags or digests.
3. ⚠️ **maxUnavailable too high** (e.g. default 25% on 4 replicas) → capacity dips mid-rollout. *Fix:* set `maxUnavailable: 0` for zero-downtime.
4. ⚠️ **Assuming Deployments auto-rollback on failure** → a bad version sits `Failed` serving errors. *Fix:* automated analysis (Argo/Flagger) or a pipeline `undo` step.
5. ⚠️ **Blue-green with a shared database and incompatible schema** → the flip breaks the other color. *Fix:* backward-compatible migrations.
6. ⚠️ **Confusing "canary" pod count with traffic %** on plain Services → split follows replica ratio, not your intended weight. *Fix:* use a mesh/Argo for true weighted routing.
7. ⚠️ **Editing pods/ReplicaSets by hand** during a rollout → the controller fights you. *Fix:* only change the Deployment spec.
8. ⚠️ **No `progressDeadlineSeconds`** → a wedged rollout hangs invisibly. *Fix:* set a sensible deadline and alert on `Failed`.

## 9. Interview Questions

**Q: What is the difference between maxSurge and maxUnavailable?**
A: maxSurge caps how many pods can exist *above* the desired replica count during a rollout (extra capacity, faster); maxUnavailable caps how many can be *below* desired/unready at once. `maxUnavailable: 0` gives strict zero-downtime because a new pod must become Ready before an old one is removed.

**Q: How does a rolling update actually replace pods?**
A: The Deployment creates a new ReplicaSet, then loops: scale new RS up by maxSurge, wait for new pods to pass readiness, scale old RS down by maxUnavailable, repeat until the new RS holds all replicas. The old RS is kept at 0 for rollback.

**Q: How do you roll back, and why is it fast?**
A: `kubectl rollout undo deploy/web` (optionally `--to-revision=N`). It's fast because the previous ReplicaSet still exists at 0 replicas — rollback just scales it back up and the current one down. No rebuild or re-pull of the manifest.

**Q: Why is a readiness probe critical during rollouts?**
A: Rollout progress is gated on new pods becoming Ready. Without a readiness probe, "Ready" just means the container started, so Kubernetes swaps out serving pods for ones that can't yet handle traffic — causing errors even with maxUnavailable: 0.

**Q: Contrast blue-green and canary deployments.**
A: Blue-green runs two full environments and flips all traffic at once (atomic cutover, instant rollback, 2× capacity). Canary shifts a *small fraction* of real traffic to the new version, measures, then gradually promotes — smaller blast radius and data-driven, but needs traffic-splitting machinery and analysis.

**Q: With plain Kubernetes Services, how is traffic split between stable and canary pods?**
A: kube-proxy load-balances roughly evenly across all endpoints matching the Service selector, so the split is proportional to pod count (e.g. 1 canary : 9 stable ≈ 10%). For weight independent of replica count you need a service mesh or Argo Rollouts.

**Q: Does a Deployment automatically roll back a failed rollout?**
A: No. A failed rollout (past progressDeadlineSeconds) is marked `Failed` but keeps serving. Automated rollback requires a controller like Argo Rollouts or Flagger doing metric analysis, or a CD pipeline that runs `rollout undo`.

**Q: (Senior) How would you design an automated canary that promotes only if the new version is healthy?**
A: Use Argo Rollouts (or Flagger) with a canary strategy: weighted steps (10/25/50/100%) each followed by an AnalysisRun querying Prometheus for error rate and latency (SLOs). If a metric breaches threshold the run fails and the rollout auto-aborts, scaling the canary to 0; if it passes all steps it promotes to 100%. Traffic weight is enforced via the mesh, not pod ratio.

**Q: (Senior) How do database schema changes constrain your rollout strategy?**
A: Any strategy where old and new run simultaneously (rolling, canary, blue-green during flip) requires backward/forward-compatible schemas. Use expand-and-contract: first deploy a migration that only adds columns/tables (old code ignores them), roll out new code that uses them, then a later release removes the old columns. Never ship a destructive migration in the same rollout as the code that needs it.

**Q: (Senior) A rollout is stuck — how do you diagnose it?**
A: `kubectl rollout status` shows it's not progressing; `kubectl describe deploy` reveals the condition (e.g. `ProgressDeadlineExceeded`) and events; `kubectl get rs` shows the new RS not reaching Ready. Then inspect the new pods: `kubectl describe pod` / `logs` for CrashLoopBackOff, ImagePullBackOff, failing readiness probe, or a blocking PodDisruptionBudget / insufficient resources. Fix root cause or `rollout undo`.

## 10. Practice

- [ ] Create a 4-replica Deployment with `maxUnavailable: 0`, `maxSurge: 1`, and a readiness probe; update the image and watch `rollout status`.
- [ ] Break the new image (bad probe path), observe the rollout stall, then `rollout undo`.
- [ ] Implement a manual blue-green: two Deployments + one Service; flip the selector and revert.
- [ ] Do a manual canary using `rollout pause`/`resume` and observe traffic hitting both versions.
- [ ] Install Argo Rollouts and convert a Deployment to a `Rollout` with weighted canary steps and a pause.

## 11. Cheat Sheet

> [!TIP]
> **Rollouts** — RollingUpdate is default: `maxSurge` (extra pods, faster) + `maxUnavailable` (allowed downtime; `0` = strict zero-downtime). Progress gated by **readiness probes**. Drive with `kubectl set image` / observe `rollout status` / inspect `rollout history` / abort `rollout undo [--to-revision=N]` (instant — old ReplicaSet kept at 0). **Recreate** = kill-all-then-start (schema-incompatible). **Blue-green** = two envs, flip Service selector (atomic, 2× cost, instant revert). **Canary** = small traffic slice first (mesh/Argo Rollouts for real weighting), promote on metrics. Deployments do NOT auto-rollback — automate with Argo/Flagger. Set `progressDeadlineSeconds`; use immutable image tags; keep schema changes backward-compatible.

**References:** Kubernetes Deployments docs, Argo Rollouts docs, Flagger docs, Google SRE Book (canarying releases)

---

*Kubernetes Handbook — topic 21.*
