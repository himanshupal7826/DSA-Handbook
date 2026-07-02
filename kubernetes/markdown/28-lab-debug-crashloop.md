# 28 · Lab: Fix a CrashLoopBackOff

> **In one line:** A pod is stuck in `CrashLoopBackOff` — walk the `describe → events → logs -p → exec` loop and fix every root cause it can hide.

---

## 1. The Scenario

You are on call. A freshly deployed service `payments-api` never becomes ready. `kubectl get pods` shows the restart counter ticking up and the status flapping between `Error` and `CrashLoopBackOff`:

```bash
$ kubectl get pods -l app=payments-api
NAME                            READY   STATUS             RESTARTS      AGE
payments-api-6c9d4b8f7c-2xk4q   0/1     CrashLoopBackOff   5 (38s ago)   4m12s
```

**CrashLoopBackOff is not a root cause — it is a symptom.** It means: the container's main process exited (cleanly or with an error), the kubelet restarted it per `restartPolicy: Always`, it exited again, and the kubelet is now backing off exponentially (10s, 20s, 40s… capped at 5m) before the next attempt. Your job is to find *why the process exits*.

Here is the manifest that was applied. It is deliberately broken in ways that mirror the four crash classes you will meet in real life:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payments-api
spec:
  replicas: 1
  selector:
    matchLabels: { app: payments-api }
  template:
    metadata:
      labels: { app: payments-api }
    spec:
      containers:
        - name: api
          image: ghcr.io/acme/payments-api:1.4.2
          command: ["/app/payments-api"]        # (A) typo in binary path
          envFrom:
            - secretRef: { name: payments-secret } # (B) secret does not exist
          livenessProbe:                           # (C) probe wrong port
            httpGet: { path: /healthz, port: 9090 }
            initialDelaySeconds: 3
            periodSeconds: 5
          resources:
            limits: { memory: "64Mi" }             # (D) too low → OOMKilled
```

**Goal:** get `payments-api` to `1/1 Running` and understand which signal pointed at each fault, so next time you fix it in one pass, not five.

---

## 2. Approach

A senior does not guess or restart-and-pray. The crash reason lives in one of four places, checked in this order because each is cheaper than the next:

1. **`kubectl describe pod`** — the *State / Last State* block gives the exit code and `Reason` (`OOMKilled`, `Error`, `Completed`), and the *Events* tail shows scheduling, pull, mount, and probe failures. This one command resolves ~half of crashes.
2. **`kubectl logs <pod> --previous`** (`-p`) — the crashed container is gone, so `logs` alone shows the *new* attempt (often empty). `-p` reads the **last terminated** container's stdout/stderr — where the stack trace lives.
3. **`kubectl get events`** — cluster-level signals the pod object may not show: `FailedMount`, `Failed to pull image`, node pressure evictions.
4. **`kubectl exec`** / **ephemeral debug container** — only when the process lives long enough. Confirm the filesystem, env vars, config file, and network reachability from *inside*.

Decode the exit code first — it usually names the class:

| Exit code | Meaning | Typical cause |
|-----------|---------|---------------|
| `0` | clean exit | not a daemon; ran once and finished (wrong command / job-as-deployment) |
| `1` / `2` | app error | unhandled exception, bad config, missing env var |
| `126` | not executable | binary lacks `+x`, wrong arch |
| `127` | not found | typo in `command`, missing binary/shared lib |
| `137` | SIGKILL (128+9) | **OOMKilled**, or failed liveness probe kill, or `kubectl delete` |
| `139` | SIGSEGV (128+11) | native crash |
| `143` | SIGTERM (128+15) | graceful shutdown asked (usually fine) |

---

## 3. Solution

The corrected manifest — each fix annotated against the fault it removes:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payments-api
spec:
  replicas: 1
  selector:
    matchLabels: { app: payments-api }
  template:
    metadata:
      labels: { app: payments-api }
    spec:
      containers:
        - name: api
          image: ghcr.io/acme/payments-api:1.4.2
          command: ["/app/payments-api"]         # (A) fixed spelling → exit 127 gone
          envFrom:
            - secretRef: { name: payments-secret } # (B) secret now created (below)
          ports:
            - containerPort: 8080
          livenessProbe:
            httpGet: { path: /healthz, port: 8080 } # (C) probe hits real port
            initialDelaySeconds: 10                 #     give the app time to boot
            periodSeconds: 10
            failureThreshold: 3
          readinessProbe:                           # gate traffic separately
            httpGet: { path: /ready, port: 8080 }
            initialDelaySeconds: 5
            periodSeconds: 5
          resources:
            requests: { memory: "128Mi", cpu: "100m" }
            limits:   { memory: "256Mi", cpu: "500m" } # (D) headroom → no OOMKill
```

Create the missing Secret (fault **B**) before re-applying:

```bash
kubectl create secret generic payments-secret \
  --from-literal=DB_PASSWORD='s3cr3t' \
  --from-literal=STRIPE_KEY='sk_live_xxx'

kubectl apply -f payments-api.yaml
kubectl rollout status deploy/payments-api --timeout=90s
```

---

## 4. Walkthrough

Below is exactly how each fault surfaced and was fixed. This is the muscle memory to build.

**Fault A — bad command (`exit 127`, "not found").**
`describe` shows the container terminated immediately:

```bash
$ kubectl describe pod payments-api-6c9d4b8f7c-2xk4q | sed -n '/Last State/,/Ready/p'
    Last State:     Terminated
      Reason:       StartError
      Exit Code:    127
      Message:      exec: "/app/payments-api": stat /app/payments-api: no such file or directory
```

Exit 127 + a `stat … no such file` message = the binary path is wrong. We fixed the typo `payments → payments`. If the file *does* exist but is not executable you would see exit `126` instead.

**Fault B — missing Secret.**
With the command fixed, the pod never even starts and events name it:

```bash
$ kubectl get events --sort-by=.lastTimestamp | tail -3
12s   Warning   FailedMount   pod/payments-api-...   MountVolume.SetUp failed for volume ...
10s   Warning   Failed        pod/payments-api-...   Error: secret "payments-secret" not found
5s    Normal    Pulling       pod/payments-api-...   Pulling image "ghcr.io/acme/payments-api:1.4.2"
```

Note the STATUS here is `CreateContainerConfigError`, not `CrashLoopBackOff` — a config error blocks the container from ever being created. Creating the secret clears it. The same pattern applies to a missing `configMapRef`, a missing `configMap`/`secret` key referenced by `valueFrom`, or an unmounted volume.

**Fault C — failing liveness probe (`exit 137`, restarts with no app error).**
Now the app boots, logs look clean, yet it still restarts every ~30s. The tell is in events, not logs:

```bash
$ kubectl describe pod payments-api-... | grep -A2 Liveness
  Warning  Unhealthy  Liveness probe failed: Get "http://10.1.2.3:9090/healthz":
                      dial tcp 10.1.2.3:9090: connect: connection refused
  Normal   Killing    Container api failed liveness probe, will be restarted
```

The app listens on 8080; the probe polled 9090, got refused three times, and the kubelet **killed a healthy container**. Classic self-inflicted CrashLoop. Fix: point the probe at the real port and set `initialDelaySeconds` above the app's cold-start time so a slow boot is not mistaken for a hang.

**Fault D — OOMKilled (`exit 137`, `Reason: OOMKilled`).**
With everything else fixed, under load the pod dies with:

```bash
$ kubectl describe pod payments-api-... | grep -A3 'Last State'
    Last State:     Terminated
      Reason:       OOMKilled
      Exit Code:    137
      Started:      ...   Finished: ...
```

The container tried to exceed its `memory` **limit** (64Mi), so the kernel's OOM killer reaped it — exit 137, `Reason: OOMKilled`. Distinguish from a probe kill: probe kills say `Killing … failed liveness probe` in events; OOM says `OOMKilled` in the *State* block and `Memory cgroup out of memory` in `kubectl get events`. Fix: raise the limit to a measured value and set a `request` so the scheduler reserves it.

---

## 5. Variations & Follow-ups

- **Init container crashes.** `describe` shows `Init:CrashLoopBackOff`. Read its logs explicitly: `kubectl logs <pod> -c <init-name> --previous`. The main container never starts until every init container exits 0.
- **`CreateContainerConfigError` vs `CrashLoopBackOff`.** The former means Kubernetes could not even build the container spec (missing secret/config) — no restart backoff, fix the reference. The latter means it ran and exited — read logs.
- **`ImagePullBackOff` masquerading.** Not a crash at all — bad tag, private registry, or missing `imagePullSecret`. `describe` events say `Failed to pull image … not found` or `unauthorized`.
- **Ephemeral debug container** when the image is distroless (no shell to `exec` into):

  ```bash
  kubectl debug -it payments-api-... --image=busybox:1.36 \
    --target=api -- sh    # shares the process/network namespace of container "api"
  ```
- **Crash before any log line.** Add `command: ["sleep","3600"]` temporarily (or set `readinessProbe` only and remove the entrypoint) to keep the pod alive, then `exec` in and run the real binary by hand to see stderr live.
- **Flapping too fast to catch.** `kubectl get pod <name> -w` streams state transitions; `kubectl get pod <name> -o jsonpath='{.status.containerStatuses[0].lastState.terminated}'` prints the last exit reason as JSON.

---

## 6. Verify It Works

```bash
$ kubectl rollout status deploy/payments-api
deployment "payments-api" successfully rolled out

$ kubectl get pods -l app=payments-api
NAME                            READY   STATUS    RESTARTS   AGE
payments-api-7f8b6c5d94-l9m2t   1/1     Running   0          2m3s
```

Assertions of a real fix — restarts should stay flat:

```bash
# 1. Zero restarts after 5 minutes of running
kubectl get pod -l app=payments-api \
  -o jsonpath='{.items[0].status.containerStatuses[0].restartCount}{"\n"}'   # → 0

# 2. Probe endpoints answer 200 from inside the pod
kubectl exec deploy/payments-api -- wget -qS -O- http://localhost:8080/healthz

# 3. No OOM in recent events
kubectl get events --field-selector reason=OOMKilling   # → No resources found
```

If `restartCount` climbs again, you fixed a symptom, not the cause — go back to `logs --previous`.

---

## 7. Pitfalls

1. ⚠️ **Reading `logs` without `--previous`.** Plain `logs` targets the *current* (freshly restarted) container, which is usually empty or mid-boot. The stack trace is in the *terminated* one — always `-p` first for a crash.
2. ⚠️ **Treating exit 0 as "fine."** A Deployment whose container exits 0 still CrashLoops — Kubernetes restarts it because `restartPolicy: Always` expects a long-running process. A one-shot task belongs in a `Job`, not a `Deployment`.
3. ⚠️ **Confusing OOMKilled with a liveness kill.** Both are exit 137. `Reason: OOMKilled` in the State block = memory limit; `Killing … liveness probe failed` in Events = probe. Fixing the wrong one wastes a deploy cycle.
4. ⚠️ **`initialDelaySeconds` too small.** A slow-booting app (JVM, migrations) gets killed by liveness before it ever serves, producing an endless CrashLoop that looks like an app bug. Size the delay above cold-start, or use a `startupProbe`.
5. ⚠️ **Setting a memory limit with no request.** The scheduler may place the pod on a node with no real headroom; it runs fine until a neighbor spikes, then gets OOMKilled unpredictably. Always set `requests` alongside `limits`.
6. ⚠️ **Deleting the pod to "reset."** The Deployment recreates an identical pod that crashes the same way, and you lose the terminated container's logs. Diagnose the live crash first.

---

## 8. Interview Follow-ups

**Q: What does CrashLoopBackOff actually mean, precisely?**
A: The container's process has exited and the kubelet is applying an exponential back-off (10s→20s→40s… capped at 5m) before restarting it again, under `restartPolicy: Always`/`OnFailure`. It is a restart-throttling state, not a diagnosis — the reason is in the container's exit code and logs.

**Q: A pod restarts but `kubectl logs` is empty. Why, and what do you run?**
A: `logs` shows the current container, which just started and hasn't logged yet (or the crash is pre-stdout). Run `kubectl logs <pod> --previous` to read the last *terminated* container's output, and `kubectl describe pod` for the exit code and events.

**Q: How do you tell an OOMKill from a failed-liveness-probe kill? Both are exit 137.**
A: OOMKill shows `Reason: OOMKilled` in the container's Last State and a `Memory cgroup out of memory` cluster event. A liveness kill shows a `Killing … Container failed liveness probe` event and `Unhealthy` warnings, with no OOM reason.

**Q: The container image is distroless — no shell to `kubectl exec`. How do you debug?**
A: Use `kubectl debug -it <pod> --image=busybox --target=<container>` to attach an ephemeral debug container that shares the target's process and network namespaces, so you can inspect its filesystem via `/proc/1/root`, its ports, and env.

**Q: Difference between CreateContainerConfigError and CrashLoopBackOff?**
A: `CreateContainerConfigError` means Kubernetes couldn't assemble the container spec — typically a missing Secret/ConfigMap or key referenced by `envFrom`/`valueFrom`; the container never runs, so there's no backoff. `CrashLoopBackOff` means it ran and exited; read the logs.

**Q: When would you reach for a startupProbe instead of tuning initialDelaySeconds?**
A: For apps with long, variable cold starts (JVM warmup, DB migrations). A `startupProbe` disables liveness/readiness until it first succeeds, letting you allow, say, up to 5 minutes to boot (`failureThreshold × periodSeconds`) without a permanently loose liveness interval that would slow real failure detection later.

**Q: What exit code does a missing/misspelled command produce versus a non-executable file?**
A: A missing binary or shared library gives `127` ("not found"); a file that exists but lacks execute permission or has the wrong architecture gives `126`.

**Q: How does exponential backoff affect your debugging speed, and can you bypass it?**
A: After several crashes the kubelet waits up to 5 minutes between attempts, so iteration slows. You can't disable the backoff, but you can delete the pod (the Deployment recreates it fresh with the counter reset) or, better, fix-and-`apply` which rolls a new ReplicaSet whose pods start without inherited backoff.

**Q: Your liveness probe keeps killing a healthy pod under load. What's happening and how do you fix it?**
A: The probe is timing out because the app is busy (or the timeout/threshold is too tight), so the kubelet judges it dead and restarts it — making load problems worse. Loosen `timeoutSeconds`/`failureThreshold`, ensure the health endpoint is lightweight and not behind the same saturated thread pool, and separate readiness (shed traffic) from liveness (restart).

**Q: Why is deleting a crashing pod usually the wrong first move?**
A: The controller recreates an identical pod that crashes the same way, and you lose the terminated container's logs and last-state data needed to diagnose it. Investigate the live crash first; recreate only after you know the cause.

---

## 9. Cheat Sheet

> [!TIP]
> **CrashLoop debugging loop — in order:**
> 1. `kubectl get pod -o wide` → note STATUS + RESTARTS.
> 2. `kubectl describe pod <p>` → **Last State** (exit code, `OOMKilled`?) + **Events** tail.
> 3. `kubectl logs <p> --previous` → the actual stack trace.
> 4. `kubectl get events --sort-by=.lastTimestamp` → mounts, pulls, probes, evictions.
> 5. `kubectl exec` / `kubectl debug` → confirm from inside.
>
> **Exit codes:** `0` ran-and-finished (wrong workload kind) · `1/2` app error · `126` not executable · `127` not found (bad command) · `137` OOMKilled or probe-killed (SIGKILL) · `143` SIGTERM.
> **States:** `CreateContainerConfigError` = missing secret/config (no backoff) · `ImagePullBackOff` = bad image/creds · `CrashLoopBackOff` = ran & exited, read logs.
> **Golden rules:** always `--previous` for crashes · never `delete` before diagnosing · set `requests` with every `limit` · `initialDelaySeconds` > cold-start (or use `startupProbe`).

---

**References:** Kubernetes docs — "Debug Running Pods" & "Configure Liveness/Readiness/Startup Probes"; `kubectl` Cheat Sheet; Google SRE Book — "Handling Overload".

---
*Kubernetes Handbook — topic 28.*
