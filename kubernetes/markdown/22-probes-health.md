# 22 · Liveness, Readiness & Startup Probes

> **In one line:** Three independent health checks that tell Kubernetes when to *restart* a container, when to *send it traffic*, and when to *stop checking during slow boot*.

---

## 1. Overview

A running process is not the same as a *healthy* one. A container can be up but deadlocked, or up but still loading a 4 GB model, or up but unable to reach its database. **Probes** are how Kubernetes distinguishes "the process exists" from "the process is actually working," and they drive two very different reactions: restarting the container, or removing it from load balancing.

There are three probes, each answering a distinct question. The **liveness probe** asks *"is this container wedged?"* — if it fails, the kubelet **restarts** the container. The **readiness probe** asks *"should this pod receive traffic right now?"* — if it fails, the pod's endpoints are **removed from all Services** (no restart). The **startup probe** asks *"has this slow app finished booting yet?"* — while it runs, liveness/readiness are held off, so a slow starter isn't killed for being slow.

Getting probes right is one of the highest-leverage operational skills in Kubernetes: correct probes give you self-healing and clean rollouts; wrong probes cause restart storms, cascading outages, and traffic sent to pods that can't serve.

## 2. Core Concepts

- **Liveness probe** — failure → kubelet **restarts** the container (per `restartPolicy`). Use for unrecoverable states (deadlock, unresponsive event loop).
- **Readiness probe** — failure → pod's IP is **removed from Service endpoints**; no restart. Use for "temporarily can't serve" (warming cache, dependency down, overloaded).
- **Startup probe** — runs **first**; until it succeeds, liveness and readiness are disabled. Use for slow-booting apps so a long startup isn't mistaken for a hang.
- **Probe handlers** — `httpGet` (2xx/3xx = pass), `tcpSocket` (connect = pass), `exec` (exit 0 = pass), `grpc` (gRPC health check, 1.24+).
- **initialDelaySeconds** — wait this long after container start before the first probe.
- **periodSeconds** — how often to probe (default 10).
- **timeoutSeconds** — per-probe timeout (default 1 — often too tight).
- **failureThreshold** — consecutive failures before acting (default 3).
- **successThreshold** — consecutive successes to flip back to healthy (default 1; must be 1 for liveness/startup).
- **Effective startup budget** = `failureThreshold × periodSeconds` — the total time a startup probe grants before giving up.

## 3. Syntax & Examples

**All three handlers, plus a startup probe for a slow app:**

```yaml
apiVersion: v1
kind: Pod
metadata: { name: api }
spec:
  containers:
    - name: api
      image: myapp:1.4
      ports: [{ containerPort: 8080 }]

      # Slow boot: allow up to 30 × 5s = 150s to start.
      startupProbe:
        httpGet: { path: /healthz, port: 8080 }
        periodSeconds: 5
        failureThreshold: 30

      # Restart if the process wedges (checked only after startup passes).
      livenessProbe:
        httpGet: { path: /healthz, port: 8080 }
        periodSeconds: 10
        timeoutSeconds: 2
        failureThreshold: 3

      # Remove from Service if it can't serve right now.
      readinessProbe:
        httpGet: { path: /ready, port: 8080 }   # checks deps (DB, cache)
        periodSeconds: 5
        failureThreshold: 2
```

**Other handler types:**

```yaml
      # TCP: just checks the port accepts a connection.
      readinessProbe:
        tcpSocket: { port: 5432 }

      # exec: runs a command inside the container; exit 0 = healthy.
      livenessProbe:
        exec:
          command: ["cat", "/tmp/healthy"]

      # gRPC: uses the standard grpc.health.v1 service (K8s 1.24+).
      readinessProbe:
        grpc: { port: 9000 }
```

**Separate liveness from readiness endpoints** — the golden rule:

```yaml
      livenessProbe:  { httpGet: { path: /healthz, port: 8080 } }  # process only
      readinessProbe: { httpGet: { path: /ready,   port: 8080 } }  # process + deps
```

## 4. Worked Example

A service that loads a large model on boot, then depends on a database. Watch how the three probes cooperate.

```bash
$ kubectl apply -f api.yaml
$ kubectl get pod api -w
NAME   READY   STATUS    RESTARTS   AGE
api    0/1     Running   0          3s     # started; startupProbe running
api    0/1     Running   0          95s    # model loaded → startup PASS
api    1/1     Running   0          98s    # readiness PASS → gets traffic
```

Now the database has a blip — the `/ready` endpoint returns 503, but `/healthz` (process) stays 200:

```bash
$ kubectl get pod api -w
api    0/1     Running   0          12m    # readiness FAIL → pulled from Service
api    1/1     Running   0          13m    # DB recovered → readiness PASS → back in
```

Note the crucial outcome: **RESTARTS stayed 0**. Because readiness and liveness use *different* endpoints, a dependency blip removed the pod from load balancing (correct) but did **not** restart it (correct). Had both probes hit `/ready`, the DB blip would have triggered a liveness restart — turning a 30-second transient into a CrashLoopBackOff and amplifying the outage.

```text
Timeline for one container:
 t=0    start ─┐
              │ startupProbe (period 5s, up to 30 tries = 150s budget)
 t=95  boot ──┘ startup PASS → liveness + readiness now active
 t=98  readiness PASS → added to Service endpoints
 t=12m readiness FAIL (DB down) → removed from endpoints, NOT restarted
 t=13m readiness PASS → re-added
```

## 5. Under the Hood

Probes are executed by the **kubelet** on the node — not by the API server or a central controller. Each container's probes run on their own timers. For `httpGet`/`tcpSocket`/`grpc` the kubelet connects directly to the pod IP on the node; for `exec` it runs the command inside the container's namespace (the most expensive handler — a new process each period).

The two failing probes drive two different subsystems. A liveness failure tells the kubelet to kill and recreate the container (incrementing `RESTARTS`, subject to CrashLoopBackOff backoff). A readiness failure updates the pod's condition, which the **endpoints controller** watches: it removes the pod IP from the EndpointSlice of every Service that selects it, so kube-proxy stops routing to it. Startup gating simply suppresses the other two probes until it passes once.

```svg
<svg viewBox="0 0 660 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="330" y="22" text-anchor="middle" fill="#1e293b" font-weight="700">Three probes → two different reactions</text>

  <!-- kubelet -->
  <rect x="30" y="130" width="120" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="90" y="155" text-anchor="middle" fill="#1e293b" font-weight="600">kubelet</text>
  <text x="90" y="173" text-anchor="middle" fill="#64748b">runs probes</text>

  <!-- startup -->
  <rect x="220" y="45" width="180" height="46" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="310" y="66" text-anchor="middle" fill="#1e293b" font-weight="600">startupProbe</text>
  <text x="310" y="82" text-anchor="middle" fill="#64748b">gates the other two</text>

  <!-- liveness -->
  <rect x="220" y="135" width="180" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="310" y="156" text-anchor="middle" fill="#1e293b" font-weight="600">livenessProbe</text>
  <text x="310" y="172" text-anchor="middle" fill="#64748b">fail → restart</text>

  <!-- readiness -->
  <rect x="220" y="225" width="180" height="46" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="310" y="246" text-anchor="middle" fill="#1e293b" font-weight="600">readinessProbe</text>
  <text x="310" y="262" text-anchor="middle" fill="#64748b">fail → cut traffic</text>

  <line x1="150" y1="150" x2="220" y2="150" stroke="#475569" marker-end="url(#a2)"/>
  <line x1="150" y1="160" x2="220" y2="245" stroke="#475569" marker-end="url(#a2)"/>
  <line x1="150" y1="140" x2="220" y2="70" stroke="#475569" marker-end="url(#a2)"/>

  <!-- reactions -->
  <rect x="470" y="135" width="160" height="46" rx="8" fill="#fff7ed" stroke="#b91c1c"/>
  <text x="550" y="156" text-anchor="middle" fill="#b91c1c" font-weight="600">restart container</text>
  <text x="550" y="172" text-anchor="middle" fill="#64748b">RESTARTS++</text>

  <rect x="470" y="225" width="160" height="46" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="550" y="246" text-anchor="middle" fill="#1e293b" font-weight="600">remove endpoint</text>
  <text x="550" y="262" text-anchor="middle" fill="#64748b">no restart</text>

  <line x1="400" y1="158" x2="470" y2="158" stroke="#475569" marker-end="url(#a2)"/>
  <line x1="400" y1="248" x2="470" y2="248" stroke="#059669" marker-end="url(#a2)"/>
</svg>
```

## 6. Variations & Trade-offs

| Handler | Passes when | Best for | Cost / caveat |
|---|---|---|---|
| **httpGet** | HTTP 200–399 | web/API services | most common; can expose real app health |
| **tcpSocket** | TCP connect succeeds | databases, non-HTTP TCP | shallow — port open ≠ app healthy |
| **exec** | command exits 0 | anything (custom scripts, file flags) | heaviest — forks a process each period |
| **grpc** | gRPC health check `SERVING` | gRPC services | needs 1.24+ and the health protocol implemented |

| Probe | Failure reaction | Restarts? | Typical endpoint |
|---|---|---|---|
| **Startup** | keeps waiting; on exhaustion, restart | eventually | `/healthz` |
| **Liveness** | restart container | yes | `/healthz` (process only) |
| **Readiness** | remove from Service endpoints | no | `/ready` (process + deps) |

The central trade-off: liveness should be **shallow and local** (only fail on truly unrecoverable states), while readiness can be **deeper** (include dependency checks). Overloading liveness with dependency checks is the single most damaging misconfiguration — a shared dependency outage restarts every pod simultaneously.

## 7. Production / Performance Notes

- **Never check external dependencies in a liveness probe.** If the DB goes down and every pod's liveness hits it, the whole fleet restarts in a loop — you convert a recoverable dependency blip into a cluster-wide outage. Dependencies belong in *readiness*.
- **Use a startup probe for slow apps** instead of a huge `initialDelaySeconds` on liveness. A startup probe adapts (passes as soon as ready) whereas a fixed delay always waits the worst case.
- **`timeoutSeconds` default is 1s** — too tight for many services under load; a slow-but-healthy response then reads as a failure. Set 2–5s deliberately.
- **Probe endpoints must be cheap and unauthenticated-internal.** Don't run heavy queries; the kubelet hits them every `periodSeconds` on every pod.
- **Readiness gates rollouts** (topic 21) and Service traffic. During graceful shutdown, failing readiness first lets in-flight requests drain before the pod dies.
- **Watch `RESTARTS` and CrashLoopBackOff** — a climbing restart count is almost always a bad liveness probe or a real crash, not "Kubernetes being flaky."
- **gRPC/sidecar apps:** ensure the probe hits the right container/port; a proxy sidecar can make `tcpSocket` pass while the app is down.

## 8. Common Mistakes

1. ⚠️ **Dependency checks in the liveness probe** → fleet-wide restart storm when a shared dependency blips. *Fix:* dependencies in readiness only; liveness checks the process itself.
2. ⚠️ **Same endpoint for liveness and readiness** → a "not ready" condition triggers restarts. *Fix:* separate `/healthz` (liveness) and `/ready` (readiness).
3. ⚠️ **No startup probe on a slow app + short liveness delay** → killed mid-boot, CrashLoopBackOff, never starts. *Fix:* add a startup probe with a generous `failureThreshold × periodSeconds` budget.
4. ⚠️ **`timeoutSeconds: 1` (default) on a busy service** → healthy-but-slow responses count as failures. *Fix:* raise timeout to 2–5s.
5. ⚠️ **No readiness probe at all** → traffic sent to pods before they're warm and during rollouts. *Fix:* always define readiness for anything behind a Service.
6. ⚠️ **Expensive probe endpoint** (heavy DB query per probe) → probes add real load and self-DoS. *Fix:* lightweight health handler.
7. ⚠️ **`failureThreshold: 1` on liveness** → a single transient blip restarts the container. *Fix:* keep ≥3 to tolerate transients.
8. ⚠️ **Probe hitting the wrong port/path** (typo, wrong container) → always-failing probe. *Fix:* verify with `kubectl describe pod` events and test the endpoint from inside the pod.

## 9. Interview Questions

**Q: What are the three probe types and what does each do on failure?**
A: Liveness — failure restarts the container (for unrecoverable/wedged states). Readiness — failure removes the pod from Service endpoints, no restart (for temporarily-can't-serve). Startup — runs first and gates the other two; failure keeps waiting, and only on exhausting its budget does it restart. They answer "is it wedged?", "should it get traffic?", and "has it finished booting?".

**Q: Why should you not check a database connection in a liveness probe?**
A: Because liveness failure restarts the container. If a shared database goes down, every pod's liveness fails at once and the whole fleet enters a restart loop, turning a recoverable dependency blip into a cascading outage. Dependency health belongs in readiness, which only removes pods from load balancing.

**Q: What problem does a startup probe solve that initialDelaySeconds doesn't?**
A: A fixed `initialDelaySeconds` on liveness always waits the worst-case boot time before the first check. A startup probe passes as soon as the app is ready and only *then* enables liveness/readiness — so slow apps aren't killed mid-boot, and fast boots aren't penalized with a long fixed delay.

**Q: What handler types can a probe use?**
A: `httpGet` (2xx/3xx passes), `tcpSocket` (successful connect passes), `exec` (command exit 0 passes), and `grpc` (standard gRPC health check, K8s 1.24+). httpGet is most common; tcpSocket is shallow; exec is the heaviest since it forks a process each period.

**Q: What's the difference between liveness and readiness in terms of side effects?**
A: Liveness restarts the container (increments RESTARTS, subject to CrashLoopBackOff). Readiness never restarts — it toggles the pod in/out of Service EndpointSlices so kube-proxy stops/starts routing to it. One is about container lifecycle; the other about traffic routing.

**Q: How do you compute how long a startup probe waits before giving up?**
A: `failureThreshold × periodSeconds` (plus `initialDelaySeconds`). E.g. `failureThreshold: 30, periodSeconds: 5` grants ~150 seconds for the app to start before the container is restarted.

**Q: What's the default timeoutSeconds and why is it a trap?**
A: Default is 1 second. Under load a healthy service may take longer than 1s to answer a probe, so the probe times out and is counted as a failure — causing spurious restarts or endpoint removal. Set it to 2–5s explicitly.

**Q: (Senior) How do probes interact with rolling updates and graceful shutdown?**
A: Rollout progress is gated on new pods passing readiness, so a good readiness probe prevents traffic to not-yet-serving pods and lets the Deployment advance safely. On shutdown, the pod first goes NotReady (readiness fails / preStop), draining it from endpoints so kube-proxy stops sending new requests while in-flight ones finish before SIGTERM/termination.

**Q: (Senior) A service shows climbing RESTARTS and intermittent 503s cluster-wide during a dependency outage. Diagnose.**
A: Classic liveness-checks-dependency antipattern. The liveness probe (or a shared endpoint used by both probes) touches the failing dependency, so when it blips every pod fails liveness and restarts simultaneously — RESTARTS climb and CrashLoopBackOff causes the 503s. Fix: make liveness shallow (process-only `/healthz`), move dependency checks to readiness (`/ready`), so the outage only drains traffic instead of restarting the fleet.

**Q: (Senior) When would you deliberately omit a liveness probe?**
A: When there's no reliable, cheap signal of an unrecoverable state, and restarting wouldn't help — a bad liveness probe is worse than none because it causes false restarts. Some teams run readiness-only for such services and rely on external monitoring/manual intervention for true hangs, avoiding self-inflicted restart storms.

## 10. Practice

- [ ] Deploy a pod with distinct `/healthz` (liveness) and `/ready` (readiness) endpoints and verify with `kubectl get pod -w`.
- [ ] Add a startup probe to a slow-booting container and confirm it isn't killed during boot.
- [ ] Make the readiness endpoint fail on demand and confirm the pod leaves Service endpoints without restarting (`kubectl get endpointslices`).
- [ ] Point a liveness probe at a dependency, kill the dependency, and observe the resulting restart storm — then fix it.
- [ ] Compare `httpGet`, `tcpSocket`, and `exec` handlers on the same container and note the behavioral/cost differences.

## 11. Cheat Sheet

> [!TIP]
> **Probes** — three checks by the **kubelet**. **Liveness** fail → *restart* (RESTARTS++); use for wedged/unrecoverable, keep it *shallow, process-only* (`/healthz`). **Readiness** fail → *remove from Service endpoints*, no restart; may check deps (`/ready`). **Startup** runs first, gates the other two; budget = `failureThreshold × periodSeconds`; use for slow apps instead of huge `initialDelaySeconds`. Handlers: `httpGet` (2xx/3xx), `tcpSocket` (connect), `exec` (exit 0, heaviest), `grpc` (1.24+). Key knobs: `periodSeconds` (10), `timeoutSeconds` (1 — raise to 2–5!), `failureThreshold` (3). **Golden rules:** never put dependency checks in liveness; separate liveness/readiness endpoints; add readiness for anything behind a Service.

**References:** Kubernetes "Configure Liveness, Readiness and Startup Probes" docs, Pod Lifecycle docs, Google SRE Book (health checking)

---

*Kubernetes Handbook — topic 22.*
