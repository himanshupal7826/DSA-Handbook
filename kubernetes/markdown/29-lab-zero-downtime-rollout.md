# 29 · Lab: Zero-Downtime Rollout & Rollback

> **In one line:** Add a readiness probe, tune `maxSurge`/`maxUnavailable`, guard with a PodDisruptionBudget, ship a rollout — then `rollout undo` it — and *prove* not one request was dropped.

---

## 1. The Scenario

`web` serves live traffic behind a Service. Every deploy causes a spike of 502s in the dashboard for ~15 seconds. The current manifest has **no readiness probe** and default rollout settings, so Kubernetes swaps pods before they can serve, and the Service sends traffic into the void.

Starting point — the fragile Deployment:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 4
  selector:
    matchLabels: { app: web }
  template:
    metadata:
      labels: { app: web }
    spec:
      containers:
        - name: web
          image: ghcr.io/acme/web:2.0.0
          ports: [ { containerPort: 8080 } ]
          # ❌ no readiness probe → Endpoints added before the app can serve
          # ❌ no graceful shutdown handling
```

```yaml
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  selector: { app: web }
  ports: [ { port: 80, targetPort: 8080 } ]
```

**Goal:** roll `web` from `2.0.0` to `2.1.0` and back with **zero dropped requests**, and make disruptions (drains, evictions) safe too.

Why it drops today: a Service's Endpoints are populated from pods that are **Ready**. With no readiness probe a pod is "Ready" the instant its container starts — before the HTTP server binds — so the Service load-balances to a socket that refuses connections. On the way *out*, the old pod receives SIGTERM and dies before it's removed from Endpoints, so in-flight requests get reset.

---

## 2. Approach

Zero-downtime rolling updates rest on four independent levers — get all four right:

1. **Readiness probe** — the single most important one. It gates a pod into the Service's Endpoints only once it can truly serve, and gates it *out* the moment it starts failing. Without it, "rolling update" is "rolling outage."
2. **`maxSurge` / `maxUnavailable`** — the rollout budget. `maxUnavailable: 0` guarantees you never drop below the desired replica count during the update; `maxSurge` adds temporary extra pods so new ones warm up before old ones leave.
3. **Graceful termination** — on SIGTERM the pod must keep serving in-flight requests while it's being removed from Endpoints. Endpoint removal and SIGTERM happen *concurrently*, so a `preStop` sleep (or app-level drain) bridges the propagation gap.
4. **PodDisruptionBudget** — protects availability during *voluntary* disruptions (node drain, cluster upgrade, autoscaler scale-down) that are outside the Deployment's rollout logic.

Then **prove** it: fire continuous requests through the Service during the rollout and count non-200s. Zero is the only passing grade.

---

## 3. Solution

The hardened Deployment:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 4
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1          # at most 1 extra pod (5 total) mid-rollout
      maxUnavailable: 0    # never drop below 4 Ready → no capacity loss
  minReadySeconds: 5       # pod must stay Ready 5s before counting as available
  selector:
    matchLabels: { app: web }
  template:
    metadata:
      labels: { app: web }
    spec:
      terminationGracePeriodSeconds: 30
      containers:
        - name: web
          image: ghcr.io/acme/web:2.0.0
          ports: [ { containerPort: 8080 } ]
          readinessProbe:                       # gate traffic in/out of Endpoints
            httpGet: { path: /ready, port: 8080 }
            initialDelaySeconds: 3
            periodSeconds: 3
            failureThreshold: 2
          livenessProbe:                        # restart only if truly wedged
            httpGet: { path: /healthz, port: 8080 }
            initialDelaySeconds: 10
            periodSeconds: 10
          lifecycle:
            preStop:
              exec:
                command: ["sh","-c","sleep 10"] # keep serving while Endpoints drain
          resources:
            requests: { cpu: "100m", memory: "128Mi" }
            limits:   { cpu: "500m", memory: "256Mi" }
```

The PodDisruptionBudget — keep at least 3 of 4 pods up during any voluntary disruption:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: web-pdb
spec:
  minAvailable: 3          # (or maxUnavailable: 1) — never let a drain take >1 pod
  selector:
    matchLabels: { app: web }
```

Ship the new version and watch it converge:

```bash
kubectl apply -f web-deploy.yaml -f web-pdb.yaml
kubectl set image deploy/web web=ghcr.io/acme/web:2.1.0   # trigger the rollout
kubectl rollout status deploy/web
```

Roll back instantly if 2.1.0 misbehaves:

```bash
kubectl rollout undo deploy/web           # revert to previous ReplicaSet
kubectl rollout status deploy/web
```

---

## 4. Walkthrough

**Readiness probe.** The Deployment brings up a new `2.1.0` pod but the Service ignores it until `/ready` returns 200 twice. Only then does the endpoints controller add its IP to the `web` EndpointSlice and the kube-proxy/LB start routing to it. When an old pod is told to terminate, its readiness immediately flips (probe fails / SIGTERM), so it's pulled from Endpoints *before* it stops accepting connections.

**`maxUnavailable: 0` + `maxSurge: 1`.** This is the zero-downtime recipe. With 4 replicas, the controller first creates a 5th (surge) pod, waits for it to be Ready + `minReadySeconds`, then terminates one old pod — net capacity never dips below 4. The rollout walks one pod at a time. (`maxUnavailable: 0` alone with `maxSurge: 0` would deadlock — you must allow *some* surge to make progress.)

**`minReadySeconds: 5`.** Guards against a pod that passes its first probe then immediately crashes; it must stay Ready for 5s before the rollout counts it and proceeds. Cheap insurance against a "healthy for one probe" flap cascading through the fleet.

**`preStop` + `terminationGracePeriodSeconds`.** Pod deletion fires two things at once: (a) removal from Endpoints (eventually consistent — takes a beat to propagate to every kube-proxy) and (b) SIGTERM to the container. If the app died on SIGTERM instantly, requests already routed during the propagation window would reset. The `preStop: sleep 10` holds the container open, still serving, until Endpoints have converged; only after it returns does SIGTERM fire, within the 30s grace period.

**PodDisruptionBudget.** The rollout is a *voluntary* disruption, but so is `kubectl drain` during a node upgrade or a cluster-autoscaler scale-down. The PDB tells the eviction API "never evict a `web` pod if it would drop Ready count below 3." A drain will evict pods one at a time, waiting for replacements, instead of taking them all at once. Note the PDB constrains disruption, it doesn't create replacements — you still need `replicas ≥ minAvailable + 1`.

**`rollout undo`.** Each `apply`/`set image` that changes the pod template creates a new **ReplicaSet**; the old one is scaled to 0 but kept (per `revisionHistoryLimit`, default 10). `undo` simply scales the previous ReplicaSet back up and the current one down — using the *same* rolling-update strategy, so the rollback is itself zero-downtime.

```svg
<svg viewBox="0 0 720 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ar" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="22" text-anchor="middle" fill="#1e293b" font-weight="700">Rolling update: maxSurge=1, maxUnavailable=0 (4 replicas)</text>

  <text x="90" y="60" text-anchor="middle" fill="#64748b">Step 1: surge up</text>
  <rect x="30" y="72" width="52" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="56" y="94" text-anchor="middle" fill="#1e293b">v1</text>
  <rect x="88" y="72" width="52" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="114" y="94" text-anchor="middle" fill="#1e293b">v1</text>
  <rect x="146" y="72" width="52" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="172" y="94" text-anchor="middle" fill="#1e293b">v1</text>
  <rect x="30" y="112" width="52" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="56" y="134" text-anchor="middle" fill="#1e293b">v1</text>
  <rect x="88" y="112" width="52" height="34" rx="8" fill="#ecfdf5" stroke="#059669" stroke-dasharray="4 3"/><text x="114" y="134" text-anchor="middle" fill="#1e293b">v2*</text>

  <line x1="230" y1="109" x2="290" y2="109" stroke="#475569" marker-end="url(#ar)"/>

  <text x="470" y="60" text-anchor="middle" fill="#64748b">Step N: swap one-by-one, always ≥4 Ready</text>
  <rect x="320" y="72" width="52" height="34" rx="8" fill="#ecfdf5" stroke="#059669"/><text x="346" y="94" text-anchor="middle" fill="#1e293b">v2</text>
  <rect x="378" y="72" width="52" height="34" rx="8" fill="#ecfdf5" stroke="#059669"/><text x="404" y="94" text-anchor="middle" fill="#1e293b">v2</text>
  <rect x="436" y="72" width="52" height="34" rx="8" fill="#ecfdf5" stroke="#059669"/><text x="462" y="94" text-anchor="middle" fill="#1e293b">v2</text>
  <rect x="320" y="112" width="52" height="34" rx="8" fill="#ecfdf5" stroke="#059669"/><text x="346" y="134" text-anchor="middle" fill="#1e293b">v2</text>
  <rect x="378" y="112" width="60" height="34" rx="8" fill="#fff7ed" stroke="#d97706" stroke-dasharray="4 3"/><text x="408" y="134" text-anchor="middle" fill="#1e293b">v1 term</text>

  <text x="360" y="196" text-anchor="middle" fill="#1e293b" font-weight="600">Service Endpoints = only Ready pods</text>
  <rect x="250" y="212" width="220" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="360" y="237" text-anchor="middle" fill="#1e293b">readinessProbe gates in AND out</text>
  <line x1="360" y1="150" x2="360" y2="210" stroke="#475569" marker-end="url(#ar)"/>
  <text x="360" y="282" text-anchor="middle" fill="#64748b">* surge pod: not Ready yet → not in Endpoints. term pod: preStop drains before SIGTERM.</text>
</svg>
```

---

## 5. Variations & Follow-ups

- **Canary / progressive delivery.** For a true canary (send 5% of traffic to `2.1.0` first), a plain Deployment isn't enough — reach for Argo Rollouts or Flagger, which manage two ReplicaSets and shift traffic weights, with automated analysis-based promotion/abort.
- **`maxUnavailable: 25%` (default) vs `0`.** The default trades a brief capacity dip for a faster rollout with no surge pods (useful when the cluster is tight on resources). `maxUnavailable: 0` is safest for latency-sensitive services but needs headroom for the surge pod.
- **Roll back to a specific revision.** `kubectl rollout history deploy/web` lists revisions; `kubectl rollout undo deploy/web --to-revision=3` targets one. Annotate changes with `kubectl annotate deploy/web kubernetes.io/change-cause="..."` so history is legible.
- **Pause / resume for staged rollouts.** `kubectl rollout pause deploy/web` freezes it after the first new pods; verify, then `kubectl rollout resume deploy/web`.
- **PDB with a single replica.** `minAvailable: 1` on a 1-replica Deployment *blocks* node drains entirely (evicting the only pod violates the budget). HA needs `replicas ≥ minAvailable + 1`.
- **StatefulSet rollouts** update pods in reverse-ordinal order one at a time (`OnDelete` or `RollingUpdate` with `partition`) — different mechanics, same readiness-gating principle.

---

## 6. Verify It Works

Run a load generator against the Service *for the entire duration* of the rollout and count failures. This is the proof.

```bash
# Terminal 1 — hammer the Service from inside the cluster, log any non-200
kubectl run loadgen --rm -it --image=williamyeh/hey -- \
  hey -z 60s -c 20 -q 50 http://web.default.svc.cluster.local/

# Terminal 2 — trigger the rollout mid-flight
kubectl set image deploy/web web=ghcr.io/acme/web:2.1.0
kubectl rollout status deploy/web
```

Passing output — every response is a 200:

```text
Status code distribution:
  [200]  60000 responses

Error distribution:
  (none)
```

Confirm the mechanics held:

```bash
# Never dropped below the desired 4 Ready replicas during the rollout
$ kubectl get deploy web
NAME   READY   UP-TO-DATE   AVAILABLE   AGE
web    4/4     4            4           12m

# Two ReplicaSets exist — old scaled to 0, new to 4
$ kubectl get rs -l app=web
NAME             DESIRED   CURRENT   READY   AGE
web-5c9f7d8b6a   4         4         4       3m     # 2.1.0
web-7b4c2a9f01   0         0         0       12m    # 2.0.0 (kept for rollback)

# Rollback and re-check the load: still zero non-200s
$ kubectl rollout undo deploy/web
deployment.apps/web rolled back
```

Assertion for CI: `hey`/`vegeta` reporting `> 0` non-2xx during a rollout = a real regression, fail the pipeline.

---

## 7. Pitfalls

1. ⚠️ **No readiness probe.** The Service adds a pod to Endpoints the instant the container starts, before the server binds — every rollout drops requests. The readiness probe is non-negotiable for zero downtime.
2. ⚠️ **`maxSurge: 0` and `maxUnavailable: 0` together.** The rollout can neither add nor remove a pod → it deadlocks and never progresses. Always allow surge *or* unavailability.
3. ⚠️ **App exits instantly on SIGTERM.** Even with a readiness probe, Endpoint removal isn't instantaneous across all nodes; a pod that dies immediately resets in-flight requests. Add a `preStop` sleep (or in-app drain) longer than the propagation delay.
4. ⚠️ **PDB with `minAvailable ≥ replicas`.** Makes every voluntary disruption impossible — node drains and upgrades hang forever. Keep `minAvailable < replicas`.
5. ⚠️ **Liveness probe used where readiness is needed.** Liveness *restarts* a pod; readiness only *removes it from traffic*. Using liveness to gate traffic causes needless restart storms under load. Separate the two.
6. ⚠️ **`terminationGracePeriodSeconds` shorter than `preStop` + drain.** If the grace period expires mid-drain the pod is SIGKILLed, cutting live connections. Grace period must exceed preStop sleep + longest in-flight request.

---

## 8. Interview Follow-ups

**Q: Why does a rollout drop requests if there's no readiness probe?**
A: A Service routes only to Ready pods; with no readiness probe a pod is Ready the moment its container starts — before the app binds its port. The endpoints controller adds it to the Service, traffic arrives, and the connection is refused until the server is actually up.

**Q: What exact combination of maxSurge/maxUnavailable gives true zero capacity loss?**
A: `maxUnavailable: 0` with `maxSurge ≥ 1`. Kubernetes spins up an extra (surge) pod, waits for it to be Ready, then retires an old one — so the Ready count never falls below the desired replicas. `maxUnavailable: 0` with `maxSurge: 0` deadlocks.

**Q: Endpoint removal and SIGTERM race each other on pod deletion. How do you avoid resetting in-flight requests?**
A: Add a `preStop` hook (e.g. `sleep 5–10`) so the container keeps serving while the pod's removal from Endpoints propagates to every kube-proxy/LB, and make the app drain gracefully on SIGTERM within `terminationGracePeriodSeconds`.

**Q: What's the difference between a PodDisruptionBudget and maxUnavailable in the rollout strategy?**
A: `maxUnavailable` governs *voluntary rollout* disruptions driven by the Deployment controller. A PDB governs *all* voluntary disruptions handled by the eviction API — node drains, upgrades, autoscaler scale-downs — which the Deployment strategy knows nothing about. You need both.

**Q: How does `kubectl rollout undo` work under the hood?**
A: Each pod-template change creates a new ReplicaSet; old ones are scaled to 0 but retained up to `revisionHistoryLimit`. `undo` scales the previous ReplicaSet back up and the current down, using the same rolling strategy — so the rollback is itself zero-downtime.

**Q: You set a PDB `minAvailable: 1` on a single-replica Deployment and node drains now hang. Why?**
A: Evicting the only pod would drop availability to 0, violating the budget, so the eviction API refuses it and the drain blocks. A PDB doesn't create replacements; you need `replicas ≥ minAvailable + 1` for a drain to make progress.

**Q: What does `minReadySeconds` protect against?**
A: A pod that passes its first readiness check then immediately crashes. `minReadySeconds` requires the pod to stay Ready for that many seconds before the rollout counts it as available and proceeds — preventing a "healthy for one probe" flap from cascading across the fleet.

**Q: Liveness vs readiness probe — which one matters for zero-downtime deploys and why?**
A: Readiness. It adds/removes the pod from Service Endpoints, controlling *traffic*. Liveness only restarts a wedged container and, if misused for traffic gating, causes restart storms. Zero-downtime is a traffic-routing property, so it hinges on readiness.

**Q: How would you prove, not assume, that a rollout dropped zero requests?**
A: Drive continuous synthetic load through the Service (`hey`, `vegeta`, `wrk`) for the full rollout window and assert zero non-2xx responses. Optionally scrape the ingress/Service error-rate metric over the deploy timestamp. "It looked fine" isn't proof.

**Q: When is a plain Deployment rolling update insufficient, and what do you use instead?**
A: When you need weighted canary traffic, automated metric-based promotion/abort, or blue-green with instant cutover. Reach for Argo Rollouts or Flagger, which manage multiple ReplicaSets and integrate with the service mesh/ingress to shift traffic percentages.

---

## 9. Cheat Sheet

> [!TIP]
> **Zero-downtime rollout recipe:**
> - **readinessProbe** — mandatory; gates pods in/out of Service Endpoints.
> - **`maxUnavailable: 0` + `maxSurge: 1`** — never dip below desired replicas.
> - **`minReadySeconds`** — ride out first-probe flaps.
> - **`preStop` sleep + graceful SIGTERM** within `terminationGracePeriodSeconds` — bridge the Endpoints-propagation race.
> - **PodDisruptionBudget** (`minAvailable < replicas`) — survive drains/upgrades/autoscaler.
>
> **Commands:** `kubectl set image deploy/web web=img:tag` · `kubectl rollout status/history/undo deploy/web` · `--to-revision=N` · `rollout pause|resume`.
> **Prove it:** `hey -z 60s -c 20 http://web/` during the rollout → `[200] all responses, (none) errors`.
> **Rollback = new ReplicaSet scaled up / old down**, same rolling strategy → also zero-downtime.

---

**References:** Kubernetes docs — "Rolling Updates", "Specifying a Disruption Budget", "Pod Lifecycle / Termination"; Argo Rollouts docs; Google SRE Workbook — "Canarying Releases".

---
*Kubernetes Handbook — topic 29.*
