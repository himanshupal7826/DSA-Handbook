# 02 · Pods: The Atomic Unit

> **In one line:** A Pod is the smallest schedulable unit in Kubernetes — one or more containers that share a network identity, IPC, and storage, and always live and die together on one node.

---

## 1. Overview

Kubernetes never schedules a bare container. The atom of deployment is the **Pod**: a wrapper around one (usually) or a few (sometimes) tightly-coupled containers that must run **together, on the same node, sharing the same context**. A Pod gets one IP address, one lifecycle, and one scheduling decision.

Why not just schedule containers? Because some helper processes need to be *closer* than a network hop — they need to share the same loopback interface, the same volume, or the same process namespace. A logging sidecar reading a shared file, or a proxy intercepting localhost traffic, only works if it is co-located and co-scheduled with the main app. The Pod is that co-scheduling boundary.

The trick that makes shared context possible is the **pause container** (the "infra" or "sandbox" container). It is created first, holds the Pod's network and IPC namespaces open, and every app container *joins* those namespaces. That is why all containers in a Pod reach each other over `localhost` and share the same IP.

In practice you rarely create bare Pods. You let a **controller** (Deployment, StatefulSet, Job, DaemonSet) create and manage them, because a bare Pod is mortal: if its node dies, it is gone forever with nothing to recreate it.

## 2. Core Concepts

- **Pod = scheduling atom** — the scheduler places a whole Pod on one node; containers in a Pod are never split across nodes.
- **Shared network namespace** — all containers share one IP and port space, reaching each other via `localhost`. Two containers can't bind the same port.
- **Shared IPC & (optionally) PID** — containers can use SysV IPC/POSIX shared memory; with `shareProcessNamespace: true` they can even see each other's processes.
- **Shared volumes** — volumes declared at the Pod level can be mounted into multiple containers, the primary way sidecars exchange files with the main app.
- **The pause container** — an almost-empty container that holds the namespaces so the app containers can come and go without tearing down the Pod's identity.
- **Pod lifecycle phases** — `Pending` → `Running` → `Succeeded`/`Failed`, with `Unknown` if the node is unreachable. This is a coarse summary, not per-container detail.
- **restartPolicy** — `Always` (default, for services), `OnFailure`, or `Never` (for Jobs). Governs whether the kubelet restarts *containers* in the Pod.
- **Init containers** — run to completion, in order, *before* app containers start; used for setup/wait-for-dependency logic.
- **Ephemeral & immutable** — most Pod fields can't be changed after creation; you replace the Pod (via its controller) rather than edit it. Pods are cattle, not pets.
- **One-container Pods are the norm** — multi-container Pods are reserved for genuinely co-dependent helpers (sidecar, adapter, ambassador).

## 3. Syntax & Examples

A minimal single-container Pod:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: web
  labels: { app: web }
spec:
  containers:
    - name: web
      image: nginx:1.27
      ports:
        - containerPort: 80
```

A multi-container Pod sharing a volume (app writes logs, sidecar ships them):

```yaml
apiVersion: v1
kind: Pod
metadata: { name: app-with-logger }
spec:
  volumes:
    - name: logs
      emptyDir: {}                 # shared scratch space, Pod-lifetime
  containers:
    - name: app
      image: myapp:1.4
      volumeMounts:
        - { name: logs, mountPath: /var/log/app }
    - name: log-shipper           # sidecar reads the SAME files
      image: fluent-bit:3.0
      volumeMounts:
        - { name: logs, mountPath: /var/log/app, readOnly: true }
```

Common commands:

```bash
kubectl apply -f web.yaml
kubectl get pod web -o wide                 # IP, node, status
kubectl describe pod web                     # events, container states
kubectl logs app-with-logger -c log-shipper  # -c selects a container
kubectl exec -it web -- sh                    # shell into a container
```

## 4. Worked Example

Deploy the multi-container Pod and prove the containers share context:

```bash
kubectl apply -f app-with-logger.yaml
kubectl get pod app-with-logger -o wide
```

```text
NAME              READY   STATUS    IP           NODE
app-with-logger   2/2     Running   10.244.2.15  node-b
```

`READY 2/2` means both containers are up, and they share the single IP `10.244.2.15`. Show that they share the network namespace — from inside the sidecar, the app is reachable on `localhost`:

```bash
kubectl exec -it app-with-logger -c log-shipper -- \
  wget -qO- http://localhost:80 | head -1
```

```text
<!DOCTYPE html>
```

Show they share the volume — a file the app writes is visible to the sidecar:

```bash
kubectl exec app-with-logger -c app -- sh -c 'echo hello > /var/log/app/x.log'
kubectl exec app-with-logger -c log-shipper -- cat /var/log/app/x.log
```

```text
hello
```

Now demonstrate why bare Pods are dangerous — delete it and nothing brings it back:

```bash
kubectl delete pod app-with-logger
kubectl get pod app-with-logger
```

```text
Error from server (NotFound): pods "app-with-logger" not found
```

Gone permanently. A Deployment-managed Pod would have been recreated instantly.

## 5. Under the Hood

The kubelet builds a Pod by first starting the **pause container**, which does nothing but sleep — its entire job is to *hold the network and IPC namespaces*. Each app container is then started with its namespaces set to *join* the pause container's. Kill and restart an app container and the Pod keeps its IP, because the pause container (and thus the namespaces) never went away.

```svg
<svg viewBox="0 0 700 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="arw2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>

  <!-- Pod boundary -->
  <rect x="30" y="30" width="640" height="300" rx="8" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="60" y="55" fill="#1e293b" font-weight="700">Pod  (one IP: 10.244.2.15, one node)</text>

  <!-- pause container -->
  <rect x="270" y="80" width="160" height="60" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="350" y="105" text-anchor="middle" fill="#1e293b" font-weight="700">pause container</text>
  <text x="350" y="124" text-anchor="middle" fill="#64748b">holds net + IPC namespaces</text>

  <!-- app container -->
  <rect x="70" y="180" width="200" height="70" rx="8" fill="#ffffff" stroke="#2563eb"/>
  <text x="170" y="208" text-anchor="middle" fill="#1e293b" font-weight="600">app container</text>
  <text x="170" y="228" text-anchor="middle" fill="#64748b">binds :80</text>

  <!-- sidecar container -->
  <rect x="430" y="180" width="200" height="70" rx="8" fill="#ffffff" stroke="#2563eb"/>
  <text x="530" y="208" text-anchor="middle" fill="#1e293b" font-weight="600">sidecar container</text>
  <text x="530" y="228" text-anchor="middle" fill="#64748b">reaches app on localhost</text>

  <!-- join namespaces arrows -->
  <line x1="170" y1="180" x2="300" y2="140" stroke="#475569" marker-end="url(#arw2)"/>
  <line x1="530" y1="180" x2="400" y2="140" stroke="#475569" marker-end="url(#arw2)"/>
  <text x="350" y="163" text-anchor="middle" fill="#64748b">join namespaces</text>

  <!-- shared volume -->
  <rect x="230" y="272" width="240" height="42" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="350" y="298" text-anchor="middle" fill="#1e293b" font-weight="600">shared volume (emptyDir)  /var/log/app</text>
  <line x1="170" y1="250" x2="245" y2="272" stroke="#475569" stroke-dasharray="4 3" marker-end="url(#arw2)"/>
  <line x1="530" y1="250" x2="455" y2="272" stroke="#475569" stroke-dasharray="4 3" marker-end="url(#arw2)"/>

  <text x="350" y="360" text-anchor="middle" fill="#64748b">Same IP + localhost + shared volume — because every container joins the pause container's namespaces.</text>
</svg>
```

Lifecycle-wise, the kubelet drives each container through states (`Waiting` → `Running` → `Terminated`) and rolls those up into the Pod's coarse **phase**. `restartPolicy` decides whether a container that exits is restarted *in place* (same Pod, same IP) with exponential backoff — the infamous `CrashLoopBackOff`.

## 6. Variations & Trade-offs

| Pattern | Containers | When to use | Cost |
|---------|-----------|-------------|------|
| **Single-container Pod** | 1 app | The default for stateless services | None — simplest |
| **Sidecar** | app + helper (log/proxy/sync) | Helper needs shared volume/localhost | Extra RAM/CPU per Pod |
| **Init container** | init(s) → app | One-shot setup, wait-for-dependency, migrations | Slower start |
| **Adapter / Ambassador** | app + translator/proxy | Reshape output or broker outbound connections | Extra hop |
| **Bare Pod** | any | Never in prod — no self-healing | No rescheduling on node loss |

Trade-offs: multi-container Pods buy tight coupling (shared fate, shared localhost, shared disk) at the cost of coarser scaling — you can't scale the sidecar independently of the app, and both count as one scheduling unit. If two things scale independently or don't share resources, they belong in **separate Pods behind a Service**, not one Pod.

## 7. Production / Performance Notes

- **Never deploy bare Pods in production.** Use a Deployment/StatefulSet/Job so a controller recreates the Pod after node failure or eviction.
- **Set requests and limits on every container** (including sidecars). Unbounded sidecars silently starve the app or get OOM-killed.
- **Watch out for `shareProcessNamespace`** — handy for debugging (a debug container can see the app's PIDs) but changes signal/zombie-reaping semantics.
- **Right-size the pause container concern:** you don't manage it, but it counts as a container in some tooling; the app's readiness is what gates traffic.
- **Prefer `emptyDir` for intra-Pod sharing**, but remember it lives and dies with the Pod — not for durable data (use PersistentVolumes).
- **Graceful shutdown:** on delete, containers get `SIGTERM` then, after `terminationGracePeriodSeconds` (default 30s), `SIGKILL`. Handle SIGTERM to drain connections.
- **`kubectl logs -c` and `exec -c`** are essential in multi-container Pods — forgetting `-c` targets the first container and confuses debugging.

## 8. Common Mistakes

1. ⚠️ **Deploying a bare Pod and expecting self-healing.** A Pod's node dies → the Pod is gone forever. Fix: wrap it in a Deployment or other controller.
2. ⚠️ **Two containers binding the same port in one Pod.** They share the network namespace, so the second fails to bind. Fix: give them different ports.
3. ⚠️ **Putting unrelated apps in one Pod to "save resources."** They then scale and fail together. Fix: separate Pods behind Services; couple only genuine helpers.
4. ⚠️ **Forgetting `-c <container>` on logs/exec** in a multi-container Pod, then reading the wrong logs. Fix: always specify the container.
5. ⚠️ **Trying to `kubectl edit` an immutable field** (e.g. container image on a bare Pod is allowed, but many spec fields aren't). Fix: change the controller's template and let it roll a new Pod.
6. ⚠️ **Storing important data in `emptyDir`.** It's wiped when the Pod dies. Fix: use a PersistentVolumeClaim for durability.
7. ⚠️ **No SIGTERM handling → truncated requests on rollout.** Fix: trap SIGTERM, stop accepting new work, finish in-flight, exit before the grace period.

## 9. Interview Questions

**Q: What is a Pod and why is it, not the container, the atomic unit?**
A: A Pod is the smallest schedulable unit — one or more containers that share a network namespace, IPC, and volumes, and are always co-scheduled on one node with one IP and one lifecycle. Kubernetes uses it because some helper processes must be closer than a network hop (shared localhost/volume), and the Pod is that co-location boundary.

**Q: What do containers in the same Pod share, and what stays isolated?**
A: They share the network namespace (one IP, localhost, port space), IPC, and any Pod-level volumes; optionally the PID namespace. They keep separate filesystems (except mounted shared volumes), separate cgroup resource limits, and separate process spaces unless PID sharing is enabled.

**Q: What is the pause container and why does it exist?**
A: It's a tiny "infra" container the kubelet starts first to hold the Pod's network and IPC namespaces open. App containers join those namespaces, so they share an IP and can restart individually without the Pod losing its identity.

**Q: What are the Pod lifecycle phases?**
A: Pending (accepted, not all containers running — e.g. pulling images or unscheduled), Running (bound to a node, at least one container running), Succeeded (all containers exited 0), Failed (all terminated, at least one non-zero), and Unknown (node unreachable).

**Q: Why shouldn't you deploy bare Pods in production?**
A: A bare Pod has no controller, so if its node fails or it's evicted, nothing recreates it — it's gone. Controllers (Deployment, StatefulSet, Job) reconcile the desired count and reschedule.

**Q: When is a multi-container Pod the right choice?**
A: Only when the helper is tightly coupled to the main app and must share its node, network, or disk — sidecars (logging, service mesh proxy), adapters, or ambassadors. If two things scale or fail independently, use separate Pods behind a Service.

**Q: How does restartPolicy interact with CrashLoopBackOff?**
A: restartPolicy (Always/OnFailure/Never) tells the kubelet whether to restart a container that exits. With Always/OnFailure, repeated crashes trigger exponentially increasing restart delays — the CrashLoopBackOff state — capped at ~5 minutes.

**Q: (Senior) How do init containers differ from sidecars, and how has that changed recently?**
A: Init containers run to completion sequentially before app containers start (setup, migrations, wait-for-dependency). Classic sidecars run alongside for the app's whole life. Newer Kubernetes models native sidecars as init containers with `restartPolicy: Always`, so they start before and shut down after the main containers, fixing ordering issues.

**Q: (Senior) What happens on `kubectl delete pod`, signal-wise?**
A: Containers receive SIGTERM, then after terminationGracePeriodSeconds (default 30s) any still running get SIGKILL. Apps should trap SIGTERM to drain connections and exit cleanly to avoid dropped requests.

**Q: (Senior) Two containers in a Pod need to share memory — what are the options and trade-offs?**
A: A shared `emptyDir` with `medium: Memory` (tmpfs) for file-based sharing, or SysV/POSIX shared memory via the shared IPC namespace. Both are fast (RAM-backed) but Pod-scoped and volatile; tmpfs counts against the Pod's memory limit.

**Q: (Senior) Why can't you scale one container of a multi-container Pod independently?**
A: The Pod is the unit of scheduling and scaling — replicas are whole Pods. To scale a helper separately you must split it into its own Pod/Deployment and communicate over the network via a Service.

## 10. Practice

- [ ] Create a two-container Pod sharing an `emptyDir`; write a file from one container and read it from the other.
- [ ] From the sidecar, `curl http://localhost:<app-port>` to prove the shared network namespace.
- [ ] Add an init container that sleeps 10s and writes a file; observe the app container waits, and inspect order in `kubectl describe`.
- [ ] Delete a bare Pod and confirm nothing recreates it; then wrap the same spec in a Deployment and delete the Pod again to see it return.
- [ ] Set `terminationGracePeriodSeconds: 5`, trap SIGTERM in the app to log and sleep, and watch the shutdown sequence during `kubectl delete`.

## 11. Cheat Sheet

> [!TIP]
> **Pod = smallest schedulable unit: 1+ containers, one IP, one node, one lifecycle.**
> **Shared:** network (localhost, ports), IPC, Pod-level volumes; optional PID. **Isolated:** filesystems, cgroup limits.
> **pause container** holds the namespaces so app containers can restart without losing the Pod IP.
> **Phases:** Pending → Running → Succeeded/Failed (Unknown if node lost). **restartPolicy:** Always/OnFailure/Never → CrashLoopBackOff on repeats.
> **Rules:** never run bare Pods in prod (no self-healing) · multi-container only for tightly-coupled helpers (sidecar/adapter/ambassador) · use `-c` for logs/exec · SIGTERM then SIGKILL after grace period · emptyDir dies with the Pod.

**References:** Kubernetes docs "Pods" & "Pod Lifecycle", "The Distributed System Toolkit: Patterns for Composite Containers" (Kubernetes blog), "Kubernetes: Up and Running" (Burns/Beda/Hightower)

---
*Kubernetes Handbook — topic 02.*
