# 09 · Init & Sidecar Containers

> **In one line:** Init containers run to completion in order *before* your app starts, while sidecars run *alongside* it — and since Kubernetes 1.28+ a sidecar is just an init container with `restartPolicy: Always`.

---

## 1. Overview

A pod is not always one container. Real workloads need helpers: something to fetch config before the app boots, a proxy to encrypt traffic, an agent to ship logs. Kubernetes gives you two shapes for these helpers, and the difference is entirely about **lifecycle**.

**Init containers** run *sequentially, to completion, before* any normal container starts. They are for setup that must finish first: wait for a database to be reachable, clone a git repo into a shared volume, run a schema migration, set kernel sysctls. If an init container fails, the pod restarts it (per the pod's `restartPolicy`) and the app never starts until every init container has exited 0.

**Sidecars** run *concurrently* with the main app for the whole life of the pod. Classic examples: an Envoy proxy (service mesh), a log-tailer, a metrics exporter, a config-reloader. Historically sidecars were just extra entries in `containers:` — which caused two painful bugs: they didn't reliably start before the app, and in Jobs they never stopped, so the Job hung forever. Kubernetes 1.28 (beta 1.29, GA 1.33) fixed this with **native sidecars**: an init container that has `restartPolicy: Always`. It starts in init order, keeps running, and is terminated last.

You reach for init containers for *ordered, one-shot* prerequisites; you reach for sidecars for *continuous, co-located* helpers that augment the app without being baked into its image.

## 2. Core Concepts

- **Init container** — runs to completion before app containers; multiple inits run **one at a time, in declaration order**.
- **Run-to-completion ordering** — init N+1 does not start until init N exits 0; a non-zero exit triggers a restart (subject to pod `restartPolicy`), blocking startup.
- **Native sidecar** — an entry under `initContainers` with `restartPolicy: Always`; it starts in init order but does **not** block later inits/app — the next container starts once the sidecar has *started* (or passed its startup probe), not when it exits.
- **Shared context** — all containers in a pod share the network namespace (same `localhost`), volumes, and (optionally) process namespace, which is how sidecars talk to the app over `127.0.0.1`.
- **`emptyDir` handoff** — the canonical way an init container passes work to the app: init writes into a shared `emptyDir` volume, the app reads from it.
- **Adapter pattern** — a sidecar that *transforms* the app's output into a standard format (e.g. reformats app logs into JSON, or exposes app internals as Prometheus metrics).
- **Ambassador pattern** — a sidecar that *proxies outbound* connections so the app just talks to `localhost` and the ambassador handles sharding, TLS, retries, or service discovery.
- **Termination order** — native sidecars are shut down **after** all regular containers exit, so the mesh proxy / log shipper stays up long enough to flush.
- **Probes on sidecars** — native sidecars support `startupProbe`, `livenessProbe`, and `readinessProbe`; a sidecar's readiness feeds into the pod's overall readiness.

## 3. Syntax & Examples

An init container that blocks until a dependency is up:

```yaml
apiVersion: v1
kind: Pod
metadata: { name: web }
spec:
  initContainers:
    - name: wait-for-db
      image: busybox:1.36
      command: ['sh', '-c',
        'until nc -z db 5432; do echo waiting for db; sleep 2; done']
  containers:
    - name: app
      image: myapp:1.4
```

Multiple init containers run in order — `clone` then `migrate`:

```yaml
spec:
  initContainers:
    - name: clone-config          # runs 1st
      image: alpine/git
      command: ['git','clone','https://example.com/cfg','/work']
      volumeMounts: [{ name: work, mountPath: /work }]
    - name: migrate               # runs 2nd, only after clone exits 0
      image: myapp:1.4
      command: ['/app/migrate', '--config', '/work/db.yaml']
      volumeMounts: [{ name: work, mountPath: /work }]
  containers:
    - name: app
      image: myapp:1.4
      volumeMounts: [{ name: work, mountPath: /work }]
  volumes:
    - name: work
      emptyDir: {}
```

A **native sidecar** — note it lives under `initContainers` but never exits:

```yaml
spec:
  initContainers:
    - name: log-shipper
      image: fluent/fluent-bit:3.0
      restartPolicy: Always       # <-- this makes it a SIDECAR
      volumeMounts: [{ name: logs, mountPath: /var/log/app }]
  containers:
    - name: app
      image: myapp:1.4
      volumeMounts: [{ name: logs, mountPath: /var/log/app }]
  volumes:
    - name: logs
      emptyDir: {}
```

## 4. Worked Example

A pod that seeds static assets with an init container and serves them with nginx, while a native sidecar reloads on change:

```yaml
apiVersion: v1
kind: Pod
metadata: { name: site, labels: { app: site } }
spec:
  initContainers:
    - name: fetch-assets                 # 1. one-shot: populate the html volume
      image: curlimages/curl:8.8.0
      command: ['sh','-c','curl -sfL https://example.com/site.tar.gz | tar xz -C /html']
      volumeMounts: [{ name: html, mountPath: /html }]
    - name: reloader                     # 2. sidecar: watches config, sends SIGHUP
      image: nginx-reloader:1.0
      restartPolicy: Always
      volumeMounts: [{ name: html, mountPath: /html, readOnly: true }]
  containers:
    - name: nginx
      image: nginx:1.27
      ports: [{ containerPort: 80 }]
      volumeMounts: [{ name: html, mountPath: /usr/share/nginx/html, readOnly: true }]
  volumes:
    - name: html
      emptyDir: {}
```

Watching the startup shows the ordering — init runs first, sidecar starts, then app:

```text
$ kubectl apply -f site.yaml && kubectl get pod site -w
NAME   READY   STATUS            RESTARTS   AGE
site   0/2     Init:0/2          0          0s   # fetch-assets running
site   0/2     Init:1/2          0          4s   # fetch-assets done, reloader starting
site   1/2     PodInitializing   0          5s   # sidecar up, nginx starting
site   2/2     Running           0          7s   # both ready

$ kubectl get pod site -o jsonpath='{.status.initContainerStatuses[*].name}'
fetch-assets reloader          # sidecar is tracked as an init container
```

## 5. Under the Hood

The kubelet drives container lifecycle. For regular init containers it is strictly serial: start container *i*, wait for it to reach `Terminated` with exit 0, then start *i+1*. A native sidecar breaks that rule — the kubelet starts it and, once it is **Started** (or passes its `startupProbe`), moves on to the next container without waiting for the sidecar to exit. On shutdown the order reverses: app containers get `SIGTERM` first, and only after they are gone does the kubelet terminate sidecars, newest-started first.

```svg
<svg viewBox="0 0 720 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ar" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="22" text-anchor="middle" fill="#1e293b" font-weight="bold">Pod startup timeline (left → right)</text>

  <rect x="20" y="60" width="130" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="85" y="80" text-anchor="middle" fill="#1e293b">init: fetch</text>
  <text x="85" y="97" text-anchor="middle" fill="#64748b">runs → exits 0</text>

  <rect x="180" y="60" width="150" height="46" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="255" y="80" text-anchor="middle" fill="#1e293b">sidecar: reloader</text>
  <text x="255" y="97" text-anchor="middle" fill="#64748b">Always — stays up</text>

  <rect x="360" y="60" width="150" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="435" y="80" text-anchor="middle" fill="#1e293b">app: nginx</text>
  <text x="435" y="97" text-anchor="middle" fill="#64748b">main container</text>

  <line x1="150" y1="83" x2="178" y2="83" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="330" y1="83" x2="358" y2="83" stroke="#475569" marker-end="url(#ar)"/>

  <rect x="255" y="120" width="255" height="18" rx="6" fill="#ecfdf5" stroke="#059669"/>
  <text x="382" y="133" text-anchor="middle" fill="#64748b">sidecar alive alongside app</text>

  <text x="360" y="180" text-anchor="middle" fill="#1e293b" font-weight="bold">Shutdown reverses (right → left)</text>
  <rect x="360" y="200" width="150" height="40" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="435" y="224" text-anchor="middle" fill="#1e293b">1. SIGTERM app</text>
  <rect x="180" y="200" width="150" height="40" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="255" y="224" text-anchor="middle" fill="#1e293b">2. stop sidecar</text>
  <line x1="358" y1="220" x2="332" y2="220" stroke="#475569" marker-end="url(#ar)"/>
  <text x="360" y="270" text-anchor="middle" fill="#64748b">sidecar terminated LAST so it can flush logs / drain the mesh</text>
</svg>
```

## 6. Variations & Trade-offs

| Aspect | Init container | Legacy sidecar (in `containers`) | Native sidecar (init + `Always`) |
|---|---|---|---|
| Lifecycle | run-to-completion | full pod life | full pod life |
| Ordering vs app | strictly before | none — starts in parallel | starts before app, in init order |
| Blocks app start? | yes, until exit 0 | no | no (app waits only for sidecar *start*) |
| Behavior in a Job | fine | **Job never completes** | Job completes; sidecar auto-stops |
| Shutdown order | n/a | arbitrary | after app containers |
| Min K8s version | all | all | 1.28 (GA 1.33) |

Prefer **native sidecars** for anything long-running — especially inside Jobs/CronJobs where legacy sidecars deadlock. Keep **init containers** for genuine one-shot prerequisites. The **adapter** and **ambassador** patterns are both sidecars: an adapter normalizes what comes *out* of the app (logs→JSON, state→Prometheus metrics); an ambassador brokers what goes *out from* the app (the app dials `localhost:6379`, the ambassador routes to the right Redis shard with TLS and retries).

## 7. Production / Performance Notes

- **Set resource requests on sidecars.** A mesh proxy can eat as much CPU as the app; unbounded sidecars wreck scheduling and node packing.
- **Init container requests count toward scheduling** — the pod's effective request is the element-wise max of (largest single init request) and (sum of app + sidecar requests). Heavy inits can make pods unschedulable.
- **Give sidecars a `startupProbe`** so the app doesn't start before the proxy can carry traffic — otherwise the first requests fail.
- **Mind `terminationGracePeriodSeconds`.** Native sidecars die after the app, but everything must finish within the grace period or gets `SIGKILL`ed. Log shippers need enough time to flush.
- **Image size matters twice.** Each init and sidecar image must be pulled before the pod is ready; a 900 MB debug image in an init container adds real cold-start latency.
- **Don't put migrations in an init container on a multi-replica Deployment** — every replica runs it, racing. Use a Job (or a Helm hook / leader-elected init) instead.
- **Native sidecar readiness gates the pod:** if the sidecar's readiness probe fails, the pod is `NotReady` and pulled from Service endpoints even if the app is fine.

## 8. Common Mistakes

1. ⚠️ **Putting a long-running helper in `containers:` inside a Job.** The Job's pod never reaches `Completed` because the sidecar never exits. *Fix:* declare it as a native sidecar (`initContainers` + `restartPolicy: Always`).
2. ⚠️ **Assuming init containers run in parallel.** They are strictly serial in declaration order. *Fix:* order them by dependency; parallelize only via separate concerns in the app.
3. ⚠️ **Running a DB migration in an init container of a Deployment.** All N replicas race the same migration. *Fix:* use a one-shot `Job` or a Helm `pre-upgrade` hook.
4. ⚠️ **Sidecar starts after the app and the app's first calls fail.** Legacy sidecars have no ordering. *Fix:* native sidecar + `startupProbe` so the app waits for it.
5. ⚠️ **Forgetting the shared `emptyDir`.** Init writes to a volume the app never mounts, so the data vanishes. *Fix:* mount the same volume in both.
6. ⚠️ **No resource limits on the sidecar.** It starves the app on a busy node. *Fix:* set requests/limits explicitly.
7. ⚠️ **Init container with a non-idempotent side effect that loops on restart.** A failing pod re-runs the init each restart, so a non-idempotent step (e.g. "append to a file") compounds. *Fix:* make init steps idempotent.

## 9. Interview Questions

**Q: What is the core lifecycle difference between an init container and a sidecar?**
A: Init containers run to completion, sequentially, before any app container starts; the app is blocked until each init exits 0. Sidecars run concurrently with the app for the whole pod lifetime.

**Q: How do you declare a native sidecar, and why was the feature added?**
A: Add the helper under `initContainers` with `restartPolicy: Always`. It was added because legacy sidecars (extra `containers` entries) had no start ordering — they could start after the app — and never terminated, which made Jobs hang forever. Native sidecars start in init order and are stopped automatically after app containers.

**Q: Multiple init containers are defined. In what order do they run and what happens if the second fails?**
A: They run one at a time in declaration order. If the second exits non-zero, the kubelet restarts it per the pod's `restartPolicy`; the app containers never start until all inits succeed. You'll see status `Init:1/3` with restarts climbing.

**Q: How does a sidecar communicate with the main app?**
A: All containers in a pod share the network namespace, so they reach each other over `localhost` / `127.0.0.1`, and they can share files through a common volume (usually `emptyDir`). That's how an Envoy sidecar intercepts the app's traffic on localhost.

**Q: Contrast the adapter and ambassador sidecar patterns.**
A: An adapter transforms the app's *output* into a standard external shape — e.g. reformatting logs or exposing app internals as Prometheus metrics. An ambassador proxies the app's *outbound* connections — the app talks to `localhost` and the ambassador handles sharding, TLS, retries, or service discovery.

**Q: In what order are containers terminated when a pod with a native sidecar shuts down?**
A: App (regular) containers receive SIGTERM first; only after they exit does the kubelet terminate the sidecars, in reverse start order. This lets a mesh proxy or log shipper stay up to drain and flush.

**Q (senior): You run a batch Job with an Istio proxy sidecar and the Job never completes. Why, and how do you fix it?**
A: The legacy sidecar (in `containers`) keeps running after the app's work finishes, so the pod never reaches `Completed` and the Job hangs. Fix by making the proxy a native sidecar (`initContainers` + `restartPolicy: Always`), which Kubernetes auto-terminates once the main containers exit — or, pre-1.28, script the proxy to quit on a shared signal.

**Q (senior): How do init container resource requests affect scheduling?**
A: The scheduler computes the pod's effective request as the element-wise max of (the largest single init container's request) and (the sum of all app + sidecar requests). A very large init request can therefore dominate scheduling and make the pod unschedulable even if the app is small.

**Q (senior): Why is it dangerous to make a native sidecar's readiness probe strict?**
A: A native sidecar's readiness contributes to the pod's overall readiness. If its readiness probe flaps, the whole pod is marked NotReady and removed from Service EndpointSlices — traffic is cut even though the app itself is healthy. You must tune the sidecar's probe as carefully as the app's.

**Q (senior): How would you guarantee the app never receives traffic before its mesh sidecar is ready?**
A: Use a native sidecar with a `startupProbe`; the app container won't start until the sidecar has started/passed startup. Combined with the app's own readiness probe gating Service endpoints, this ensures no request reaches the app before the proxy can carry it.

## 10. Practice

- [ ] Write a pod with two init containers where the second only starts after the first writes a sentinel file to a shared `emptyDir`; observe `kubectl get pod -w`.
- [ ] Convert a legacy log-shipper sidecar into a native sidecar and confirm a Job using it now reaches `Completed`.
- [ ] Add a `startupProbe` to a sidecar proxy and prove (via logs) the app container waits for it.
- [ ] Build an adapter sidecar that tails the app's plain-text log from a shared volume and re-emits it as JSON on stdout.
- [ ] Deliberately fail an init container and inspect the pod's status/events to see the restart behavior.

## 11. Cheat Sheet

> [!TIP]
> **Init** = run-to-completion, serial, before app, blocks startup (setup, waits, migrations).
> **Sidecar** = runs alongside app for the pod's life (proxy, log shipper, metrics).
> **Native sidecar** = `initContainers:` entry + `restartPolicy: Always` → starts in init order, stops *after* app, works in Jobs (K8s 1.28+, GA 1.33).
> Containers share `localhost` + volumes → sidecars talk over 127.0.0.1, inits hand off via `emptyDir`.
> **Adapter** = normalizes app output. **Ambassador** = proxies app's outbound calls.
> Always set sidecar resource requests; give sidecars a `startupProbe`; keep init steps idempotent.

**References:** Kubernetes docs — Init Containers; Kubernetes docs — Sidecar Containers; Kubernetes blog "Sidecar Containers"; "Design Patterns for Container-Based Distributed Systems" (Burns & Oppenheimer)

---
*Kubernetes Handbook — topic 09.*
