# 25 · Troubleshooting Pods & Clusters

> **In one line:** A systematic loop — `describe` → events → logs → exec — turns any red pod into a named root cause instead of a guess.

---

## 1. Overview

Most Kubernetes debugging is *pattern recognition on a small set of failure modes*. A pod is either **not scheduled** (Pending), **not starting** (ImagePullBackOff, Init errors), **not staying up** (CrashLoopBackOff, OOMKilled), or **up but unreachable** (Service/DNS/NetworkPolicy). Each has a signature you can read off `kubectl describe` and `kubectl get events` in under a minute.

The problem this solves: under pressure people randomly restart things. A senior instead runs the *same ordered loop every time* — status, events, logs, then targeted exec — and lets the object tell them what's wrong. The pod's `STATUS`, its Events, and its last-crash logs are almost always enough.

You reach for this whenever a workload is not `Running`/`Ready`, a rollout is stuck, or traffic doesn't reach a healthy-looking pod. The skill is not memorizing fixes; it's knowing *which signal disambiguates which failure* so you stop guessing.

## 2. Core Concepts

- **The universal loop:** `kubectl get pod` (status) → `kubectl describe pod` (Events + probes + resources) → `kubectl logs [-p]` (app output) → `kubectl exec`/`debug` (poke from inside). Escalate only if a step is inconclusive.
- **Read the STATUS column literally.** `Pending`, `ContainerCreating`, `ImagePullBackOff`, `CrashLoopBackOff`, `OOMKilled`, `Error`, `Terminating` each point at a different subsystem.
- **`describe` beats `logs` for start-up failures.** If a container never started, there are no logs — the *reason* is in the Events section (scheduler, kubelet, image puller).
- **`RESTARTS` + `Last State` are gold.** `Last State: Terminated, Reason: OOMKilled, Exit Code: 137` names the cause; exit code 1 vs 137 vs 143 tells you app-crash vs killed-for-memory vs SIGTERM.
- **Pending = scheduling problem**, never an app problem. Causes: insufficient resources, unsatisfiable affinity/taints, or an unbound PVC.
- **CrashLoopBackOff = app exits repeatedly.** The kubelet backs off exponentially (10s→20s→…→5m). The *why* is in `logs -p`.
- **ImagePullBackOff = registry/auth/tag problem.** Wrong tag, private registry without `imagePullSecret`, or rate-limit.
- **Service reachability is three hops:** correct **selector** → healthy **Endpoints** → working **DNS/NetworkPolicy**. Debug in that order.
- **`kubectl debug` for distroless pods.** When a container has no shell, attach an ephemeral debug container to inspect the process namespace.

## 3. Syntax & Examples

```bash
# The loop, in order
kubectl get pods -o wide                          # status, node, IP, restarts
kubectl describe pod <pod>                         # Events + probes + resources + volumes
kubectl logs <pod> -p --tail=50                    # crashed instance output
kubectl exec -it <pod> -c <ctr> -- sh              # poke inside a running container
kubectl debug <pod> -it --image=busybox --target=<ctr>   # ephemeral container (distroless)
```

```bash
# Cluster / scheduling wide-angle
kubectl get events -A --sort-by=.lastTimestamp | grep -i warn
kubectl get nodes -o wide                          # NotReady? cordoned?
kubectl describe node <node> | sed -n '/Allocated/,/Events/p'   # pressure & capacity
kubectl top nodes; kubectl top pods -A --sort-by=memory
```

```bash
# Service / DNS reachability
kubectl get endpoints <svc>                        # EMPTY = selector matches nothing
kubectl get pods --show-labels                     # do labels match the Service selector?
kubectl run tmp --rm -it --image=busybox:1.36 -- sh
  # inside: nslookup <svc>.<ns>.svc.cluster.local ; wget -qO- <svc>:<port>
kubectl get networkpolicy -A                       # is traffic being denied?
```

## 4. Worked Example

Rollout stuck; new pods never become Ready. Run the loop.

```bash
kubectl get pods -l app=payments
```

```text
NAME                        READY   STATUS             RESTARTS   AGE
payments-5f7c9d8b6-abc12    0/1     CrashLoopBackOff   6          8m
```

```bash
kubectl describe pod payments-5f7c9d8b6-abc12 | sed -n '/Last State/,/Events/p'
```

```text
Last State:     Terminated
  Reason:       OOMKilled
  Exit Code:    137
Restart Count:  6
Limits:  memory: 128Mi
Requests: memory: 128Mi
```

```bash
kubectl logs payments-5f7c9d8b6-abc12 -p --tail=5
```

```text
2026-07-02T10:02:11Z INFO loading price cache (fits in ~200MB)
# ...then silence — process killed mid-allocation
```

**Verdict:** Exit code **137** + `Reason: OOMKilled` = the container hit its 128Mi limit while loading a ~200MB cache. Not a crash bug — a **memory limit too low**. Fix: raise the limit (and request) to 256Mi, or shrink the cache. No amount of restarting helps; the object told us exactly what to change.

## 5. Under the Hood — the decision tree

Every failure resolves to one branch. Read the STATUS, jump to the branch, run the one disambiguating command.

```svg
<svg viewBox="0 0 780 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12.5">
  <defs>
    <marker id="a2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <rect x="300" y="12" width="180" height="42" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="390" y="32" text-anchor="middle" fill="#1e293b" font-weight="700">Pod not Ready</text>
  <text x="390" y="48" text-anchor="middle" fill="#64748b" font-size="11">read STATUS column</text>

  <!-- branches -->
  <line x1="390" y1="54" x2="120" y2="90" stroke="#475569" marker-end="url(#a2)"/>
  <line x1="390" y1="54" x2="330" y2="90" stroke="#475569" marker-end="url(#a2)"/>
  <line x1="390" y1="54" x2="540" y2="90" stroke="#475569" marker-end="url(#a2)"/>
  <line x1="390" y1="54" x2="700" y2="90" stroke="#475569" marker-end="url(#a2)"/>

  <!-- Pending -->
  <rect x="30" y="90" width="180" height="40" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="120" y="115" text-anchor="middle" fill="#1e293b" font-weight="600">Pending</text>
  <rect x="20" y="150" width="200" height="120" rx="8" fill="#ffffff" stroke="#475569"/>
  <text x="120" y="170" text-anchor="middle" fill="#64748b" font-size="11">describe → Events</text>
  <text x="120" y="190" text-anchor="middle" fill="#1e293b" font-size="11">• Insufficient cpu/mem</text>
  <text x="120" y="208" text-anchor="middle" fill="#1e293b" font-size="11">• taint/affinity unmet</text>
  <text x="120" y="226" text-anchor="middle" fill="#1e293b" font-size="11">• PVC unbound</text>
  <text x="120" y="252" text-anchor="middle" fill="#64748b" font-size="11">= SCHEDULING</text>

  <!-- Image -->
  <rect x="245" y="90" width="180" height="40" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="335" y="115" text-anchor="middle" fill="#1e293b" font-weight="600">Image/PullBackOff</text>
  <rect x="235" y="150" width="200" height="120" rx="8" fill="#ffffff" stroke="#475569"/>
  <text x="335" y="170" text-anchor="middle" fill="#64748b" font-size="11">describe → Events</text>
  <text x="335" y="190" text-anchor="middle" fill="#1e293b" font-size="11">• wrong tag / typo</text>
  <text x="335" y="208" text-anchor="middle" fill="#1e293b" font-size="11">• no imagePullSecret</text>
  <text x="335" y="226" text-anchor="middle" fill="#1e293b" font-size="11">• registry rate-limit</text>
  <text x="335" y="252" text-anchor="middle" fill="#64748b" font-size="11">= REGISTRY/AUTH</text>

  <!-- Crash -->
  <rect x="455" y="90" width="185" height="40" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="547" y="115" text-anchor="middle" fill="#1e293b" font-weight="600">CrashLoop/Error</text>
  <rect x="450" y="150" width="200" height="120" rx="8" fill="#ffffff" stroke="#475569"/>
  <text x="550" y="170" text-anchor="middle" fill="#64748b" font-size="11">logs -p  +  Last State</text>
  <text x="550" y="190" text-anchor="middle" fill="#1e293b" font-size="11">• exit 137 → OOMKilled</text>
  <text x="550" y="208" text-anchor="middle" fill="#1e293b" font-size="11">• app error / bad config</text>
  <text x="550" y="226" text-anchor="middle" fill="#1e293b" font-size="11">• failing probe</text>
  <text x="550" y="252" text-anchor="middle" fill="#64748b" font-size="11">= APP / LIMITS</text>

  <!-- Running but unreachable -->
  <rect x="660" y="90" width="110" height="40" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="715" y="107" text-anchor="middle" fill="#1e293b" font-weight="600" font-size="11">Running,</text>
  <text x="715" y="122" text-anchor="middle" fill="#1e293b" font-weight="600" font-size="11">no traffic</text>
  <rect x="620" y="150" width="150" height="120" rx="8" fill="#ffffff" stroke="#475569"/>
  <text x="695" y="170" text-anchor="middle" fill="#64748b" font-size="11">get endpoints</text>
  <text x="695" y="190" text-anchor="middle" fill="#1e293b" font-size="11">• selector≠labels</text>
  <text x="695" y="208" text-anchor="middle" fill="#1e293b" font-size="11">• DNS fails</text>
  <text x="695" y="226" text-anchor="middle" fill="#1e293b" font-size="11">• NetworkPolicy</text>
  <text x="695" y="252" text-anchor="middle" fill="#64748b" font-size="11">= SVC/NET</text>

  <!-- resolution bar -->
  <rect x="120" y="320" width="540" height="46" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="390" y="341" text-anchor="middle" fill="#1e293b" font-weight="600">Each branch ends in ONE disambiguating command → a named root cause</text>
  <text x="390" y="359" text-anchor="middle" fill="#64748b" font-size="11">never restart-and-pray; let describe / events / logs tell you</text>
  <line x1="120" y1="270" x2="360" y2="320" stroke="#475569" marker-end="url(#a2)"/>
  <line x1="335" y1="270" x2="390" y2="320" stroke="#475569" marker-end="url(#a2)"/>
  <line x1="550" y1="270" x2="420" y2="320" stroke="#475569" marker-end="url(#a2)"/>
  <line x1="695" y1="270" x2="430" y2="320" stroke="#475569" marker-end="url(#a2)"/>

  <text x="390" y="400" text-anchor="middle" fill="#64748b" font-size="11">Cluster-wide? → check `kubectl get nodes` (NotReady), control-plane pods in kube-system, and events -A.</text>
</svg>
```

## 6. Variations & Trade-offs — the failure signatures

| Symptom (STATUS) | First command | Likely cause | Typical fix |
|---|---|---|---|
| `Pending` | `describe` Events | No node fits requests / taint / PVC unbound | Lower requests, add nodes, fix affinity, provision PV |
| `ContainerCreating` (stuck) | `describe` Events | Volume mount / CNI / secret missing | Fix PVC/StorageClass, CNI, or referenced Secret |
| `ImagePullBackOff` | `describe` Events | Bad tag / private registry / rate-limit | Fix tag, add `imagePullSecret`, mirror image |
| `CrashLoopBackOff` | `logs -p` | App exits: bad config, missing dep, failed migration | Fix config/env; check probes aren't too aggressive |
| `OOMKilled` (exit 137) | `describe` Last State | Memory limit < real usage | Raise limit/request or reduce footprint |
| `Error` / exit 1 | `logs -p` | App-level crash | Read stack trace |
| `Running` 0/1 Ready | `describe` probes | Readiness probe failing | Fix probe path/port/timing or the app |
| `Running` but 502 via Service | `get endpoints` | Selector ≠ pod labels, or NetworkPolicy | Align labels, allow policy, check port names |
| Node `NotReady` | `describe node` | kubelet/CNI/disk-pressure | Fix kubelet, evict, add disk |

`describe` is the right *first* command for anything that never started (Pending, ContainerCreating, ImagePull) because there are no app logs yet — the reason lives in Events. `logs -p` is the right first command for anything that *did* start and then died (CrashLoop, Error, OOM). Choosing the wrong first tool is the most common time-waster.

## 7. Production / Performance Notes

- **`kubectl debug` is essential for distroless/scratch images** — there's no shell to `exec` into. `kubectl debug -it <pod> --image=busybox --target=<ctr>` shares the target's process/network namespace.
- **Exit codes are a language:** `137` = 128+9 (SIGKILL, usually OOM or liveness kill), `143` = 128+15 (SIGTERM, graceful shutdown or eviction), `1`/`2` = app error, `0` with restarts = app finished and shouldn't have (use a Job).
- **Liveness probes can *cause* CrashLoops.** Too-tight `initialDelaySeconds`/`timeoutSeconds` kills a slow-starting but healthy app. Suspect the probe when logs look fine but restarts climb.
- **`Terminating` forever** = a finalizer stuck or a node gone. Check `metadata.finalizers`; force-delete only when you understand the finalizer.
- **Pending across many pods at once** usually means the *cluster* is full or a node group failed to scale — check `kubectl get nodes` and the cluster-autoscaler, not each pod.
- **Empty Endpoints is the #1 "my Service is broken."** 90% of the time the Service `selector` doesn't match the pod `labels`, or the pod isn't Ready (readiness gates Endpoints).
- **DNS issues:** test with `nslookup` from a throwaway pod; check CoreDNS pods in `kube-system` and that the Service's `.svc.cluster.local` FQDN resolves.

## 8. Common Mistakes

1. ⚠️ **Restarting the pod before reading Events.** You destroy the evidence and learn nothing. Fix: `describe` first, always.
2. ⚠️ **Running `logs` (not `logs -p`) on a CrashLooper.** You read the new container's empty startup. Fix: `-p` for the crashed instance.
3. ⚠️ **Treating Pending as an app bug.** Pending is 100% scheduling. Fix: read the scheduler event in `describe`.
4. ⚠️ **Ignoring exit code 137.** That's OOMKilled, not a random crash. Fix: raise memory limit or cut usage.
5. ⚠️ **Blaming the Service when Endpoints is empty.** Fix: check selector-vs-label match and pod readiness before touching the Service.
6. ⚠️ **Aggressive liveness probes on slow-start apps.** Fix: raise `initialDelaySeconds`, or use a `startupProbe`.
7. ⚠️ **Force-deleting `Terminating` pods reflexively.** Fix: find the stuck finalizer/node first; force-delete can orphan resources.
8. ⚠️ **Debugging one pod when the whole cluster is degraded.** Fix: check `get nodes`, kube-system pods, and `get events -A` for a common cause.

## 9. Interview Questions

**Q: Walk me through your systematic approach to a pod that isn't Ready.**
A: `kubectl get pod` to read STATUS/restarts → `kubectl describe pod` for Events, probes, and Last State → `kubectl logs -p` if it started and crashed → `kubectl exec`/`debug` to poke from inside. Each step disambiguates the branch; I don't restart until I have a named cause.

**Q: A pod is stuck in Pending. What are the possible causes and how do you tell them apart?**
A: Insufficient CPU/memory, unsatisfiable nodeSelector/affinity/taints, or an unbound PVC. `kubectl describe pod` shows the scheduler's Event message (`Insufficient memory`, `didn't match taint`, `pod has unbound PersistentVolumeClaims`) which names the exact one.

**Q: What does CrashLoopBackOff mean and how do you debug it?**
A: The container starts and exits repeatedly; the kubelet backs off exponentially up to 5 min. Read `kubectl logs <pod> -p` and the `Last State`/exit code in `describe`. Common causes: bad config/env, missing dependency, failed migration, or an overly aggressive liveness probe.

**Q: How do you distinguish OOMKilled from an application crash?**
A: `describe` shows `Last State: Terminated, Reason: OOMKilled, Exit Code: 137`. Exit 137 (128+SIGKILL) with an OOMKilled reason is the kernel killing the container for exceeding its memory limit — fix the limit or the footprint, not the app logic.

**Q: What causes ImagePullBackOff and how do you fix each?**
A: Wrong image name/tag (fix the reference), private registry without credentials (add an `imagePullSecret`), or registry rate-limiting/outage (mirror or authenticate). `describe` Events shows `manifest unknown`, `unauthorized`, or `toomanyrequests`.

**Q: A pod is Running but the Service returns no response. How do you debug?**
A: `kubectl get endpoints <svc>` — if empty, the Service selector doesn't match pod labels or the pod isn't Ready. If populated, test DNS and connectivity from a throwaway pod (`nslookup`, `wget`), then check NetworkPolicies and port-name mismatches.

**Q: Why is `describe` often more useful than `logs` for a failing pod?**
A: If the container never started (Pending, ImagePull, mount failure), there are no application logs — the reason lives in the Events section, which reports what the scheduler, kubelet, and image puller decided.

**Q: How do you debug a container built from a distroless/scratch image with no shell?**
A: `kubectl debug -it <pod> --image=busybox --target=<container>` attaches an ephemeral debug container sharing the target's process and network namespaces, giving you tools without rebuilding the image.

**Q: (Senior) Half the pods in a namespace go Pending simultaneously. Where do you look first?**
A: This smells cluster-level, not per-pod: `kubectl get nodes` for NotReady/cordoned nodes, `kubectl describe node` for resource pressure, and the cluster-autoscaler / node-group status. A quota hit (`kubectl describe resourcequota`) is another single common cause.

**Q: (Senior) A healthy-looking app keeps restarting every ~40s with clean logs. Diagnosis?**
A: Suspect the liveness probe: too-short `initialDelaySeconds`/`timeoutSeconds` or a wrong path/port kills a healthy app. `describe` shows `Liveness probe failed`. Fix with a `startupProbe` or looser timings — restarts stop.

**Q: (Senior) How would you debug intermittent DNS failures across the cluster?**
A: Check CoreDNS pods/logs in `kube-system` for restarts or errors, verify `kube-dns` Service Endpoints, look for CoreDNS CPU throttling or `ndots`/search-domain misconfig in pods, and test resolution from multiple nodes to isolate a bad node's kube-proxy/CNI.

## 10. Practice

- [ ] Deploy a pod requesting 100 CPUs, confirm it's Pending, and read the exact scheduler reason from `describe`.
- [ ] Set a 32Mi memory limit on a memory-hungry container and identify the OOMKilled exit code 137.
- [ ] Reference a nonexistent image tag and diagnose ImagePullBackOff from Events.
- [ ] Create a Service whose selector doesn't match its pods, then fix it by comparing `get endpoints` with `--show-labels`.
- [ ] Attach `kubectl debug` to a distroless pod and inspect its filesystem/processes.

## 11. Cheat Sheet

> [!TIP]
> **The loop:** `get pod` → `describe pod` (Events!) → `logs -p` → `exec`/`debug`. Never restart before reading Events.
> **Signatures:** Pending=scheduling (resources/affinity/PVC) · ImagePullBackOff=registry/auth/tag · CrashLoopBackOff=app exits (`logs -p`) · exit 137=OOMKilled (raise mem) · Running 0/1=readiness probe · Service dead=`get endpoints` (selector vs labels, DNS, NetworkPolicy).
> **describe** for things that never started; **logs -p** for things that started then died. Whole cluster degraded → `get nodes` + kube-system + `get events -A`.

**References:** Kubernetes docs — Debug Running Pods, Debug Services, Determine the Reason for Pod Failure; `kubectl debug` (ephemeral containers) docs

---
*Kubernetes Handbook — topic 25.*
