# 19 · Requests, Limits & QoS

> **In one line:** Requests are what the scheduler reserves for you; limits are the ceiling the kernel enforces at runtime — and the gap between them decides your QoS class and who dies first under pressure.

---

## 1. Overview

Every container can declare two numbers per resource: a **request** and a **limit**. They look similar but do completely different jobs. The **request** is a *scheduling* promise — the amount the scheduler carves out of a node's allocatable capacity so your pod is guaranteed room to run. The **limit** is a *runtime* ceiling — the kernel throttles CPU above it and OOM-kills the container for exceeding memory.

Get these wrong and you get the two classic Kubernetes pathologies: pods that mysteriously **CPU-throttle** (slow p99, but plenty of "spare" CPU on the node) because the CPU limit is too tight, and pods that get **OOMKilled** because the memory limit is below real usage — or worse, pods **evicted** at 2am because nodes are overcommitted on memory and the kubelet has to reclaim.

Kubernetes uses the request/limit relationship to assign each pod a **Quality of Service class** — `Guaranteed`, `Burstable`, or `BestEffort` — which decides eviction/OOM priority when a node runs out of resources. Cluster admins bound the whole thing with **LimitRange** (per-container defaults and min/max) and **ResourceQuota** (per-namespace aggregate caps).

You set requests/limits on essentially every production workload. Doing it well is the difference between a dense, stable, cost-efficient cluster and one that thrashes.

## 2. Core Concepts

- **Request** — reserved amount used by the **scheduler** to pick a node (sum of pod requests must fit node allocatable). Does *not* cap usage.
- **Limit** — hard runtime ceiling enforced by the **kernel** (cgroups). CPU over-limit → throttled; memory over-limit → OOMKilled.
- **CPU is compressible** — exceeding the CPU limit just slows you (throttling), never kills. Measured in cores; `500m` = half a core.
- **Memory is incompressible** — you can't "throttle" RAM, so exceeding the memory limit means the container is **killed** (exit 137, `OOMKilled`).
- **QoS: Guaranteed** — every container has `requests == limits` for both CPU and memory. Last to be evicted; highest protection.
- **QoS: Burstable** — at least one request set, but not equal to limits (or some unset). Can burst above requests up to limits; evicted after BestEffort.
- **QoS: BestEffort** — no requests or limits anywhere. First to be killed under node pressure.
- **CPU throttling** — the CFS scheduler enforces the CPU limit per ~100ms quota period; hitting it stalls the process even if the node is idle overall.
- **Eviction** — when a node is under memory/disk pressure, the kubelet evicts pods by QoS and by how far they exceed their *requests*, reclaiming resources.
- **LimitRange** — namespace policy setting default requests/limits and min/max per container/pod.
- **ResourceQuota** — namespace policy capping total requests/limits (and object counts) across all pods.

## 3. Syntax & Examples

**Per-container requests and limits:**

```yaml
apiVersion: v1
kind: Pod
metadata: {name: web}
spec:
  containers:
    - name: app
      image: myapp:1.4
      resources:
        requests:            # scheduler reserves this
          cpu: "250m"
          memory: "256Mi"
        limits:              # kernel enforces this ceiling
          cpu: "500m"
          memory: "512Mi"
```

**Guaranteed QoS (requests == limits):**

```yaml
resources:
  requests: {cpu: "1", memory: "1Gi"}
  limits:   {cpu: "1", memory: "1Gi"}   # equal on both → Guaranteed
```

**A LimitRange giving every container sane defaults + bounds:**

```yaml
apiVersion: v1
kind: LimitRange
metadata: {name: defaults, namespace: team-a}
spec:
  limits:
    - type: Container
      default:        {cpu: "500m", memory: "512Mi"}   # applied if limit omitted
      defaultRequest: {cpu: "100m", memory: "128Mi"}   # applied if request omitted
      min: {cpu: "50m",  memory: "64Mi"}
      max: {cpu: "2",    memory: "2Gi"}
```

**A ResourceQuota capping the namespace's aggregate:**

```yaml
apiVersion: v1
kind: ResourceQuota
metadata: {name: team-a-quota, namespace: team-a}
spec:
  hard:
    requests.cpu: "10"
    requests.memory: 20Gi
    limits.cpu: "20"
    limits.memory: 40Gi
    pods: "50"
```

## 4. Worked Example

Diagnose a service that's slow despite an "idle" node, and a sidecar that keeps dying.

```bash
kubectl get pod web-7d9 -o jsonpath='{.status.qosClass}{"\n"}'
# → Burstable

# Symptom 1: high p99 latency, node CPU shows ~40% used. Check throttling:
kubectl exec web-7d9 -c app -- cat /sys/fs/cgroup/cpu.stat
```

```text
nr_periods     45211
nr_throttled   38122        # ← 84% of periods throttled!
throttled_usec 91230000     # ~91s of forced stalls
```

The CPU **limit (500m)** is too low for the traffic; the app is throttled 84% of periods even though the node looks idle. Raise/remove the CPU limit.

```bash
# Symptom 2: the sidecar restarts every few minutes. Inspect last state:
kubectl describe pod web-7d9 | grep -A4 'Last State'
```

```text
Last State:     Terminated
  Reason:       OOMKilled
  Exit Code:    137
  Started/Finished: ~4m apart
```

Memory limit (128Mi) is below the sidecar's working set → **OOMKilled (137)**. Fix both:

```text
app sidecar fix:
  cpu:    request 250m, limit 1     (or drop the limit; give headroom)
  memory: request 192Mi, limit 256Mi   (above real working set + margin)
Result: throttling drops to <1% of periods; zero OOMKills over 24h.
```

**Lesson:** slow-but-idle = **CPU throttling** (raise CPU limit); exit 137 = **memory limit too low** (raise memory limit).

## 5. Under the Hood

Requests and limits map straight onto **Linux cgroups**. The **scheduler** only ever reads *requests* to find a node whose remaining allocatable ≥ the pod's total requests. At runtime the kubelet writes the container's cgroup: the **CPU limit** becomes a CFS quota (`cpu.max` = quota/period, e.g. 50ms per 100ms for `500m`), so once the container burns its slice it's frozen until the next period — that's throttling. The **memory limit** becomes `memory.max`; when the container's RSS hits it, the kernel OOM-killer reaps the process (exit 137). Under node-wide memory pressure the **kubelet's eviction manager** ranks pods by QoS and by usage-over-request and evicts to reclaim.

```svg
<svg viewBox="0 0 780 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#475569"/>
    </marker>
  </defs>
  <text x="390" y="22" text-anchor="middle" fill="#1e293b" font-weight="700">Request → scheduling · Limit → runtime enforcement</text>

  <!-- request side -->
  <rect x="30" y="55" width="330" height="120" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="195" y="80" text-anchor="middle" fill="#1e293b" font-weight="600">REQUEST — scheduler</text>
  <text x="195" y="104" text-anchor="middle" fill="#64748b" font-size="12">reserves capacity on a node</text>
  <text x="195" y="126" text-anchor="middle" fill="#64748b" font-size="12">Σ requests ≤ node allocatable</text>
  <text x="195" y="150" text-anchor="middle" fill="#059669" font-size="12">does NOT cap usage</text>

  <!-- limit side -->
  <rect x="420" y="55" width="330" height="120" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="585" y="80" text-anchor="middle" fill="#1e293b" font-weight="600">LIMIT — kernel (cgroups)</text>
  <text x="585" y="104" text-anchor="middle" fill="#64748b" font-size="12">CPU over limit → THROTTLED</text>
  <text x="585" y="126" text-anchor="middle" fill="#b91c1c" font-size="12">MEM over limit → OOMKilled (137)</text>
  <text x="585" y="150" text-anchor="middle" fill="#64748b" font-size="12">enforced every ~100ms / on RSS</text>

  <!-- QoS ladder -->
  <text x="390" y="215" text-anchor="middle" fill="#1e293b" font-weight="600">QoS class = eviction / OOM priority</text>
  <rect x="120" y="235" width="180" height="46" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="210" y="255" text-anchor="middle" fill="#1e293b" font-size="12">Guaranteed</text>
  <text x="210" y="272" text-anchor="middle" fill="#64748b" font-size="11">req==limit · last to die</text>

  <rect x="310" y="235" width="180" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="400" y="255" text-anchor="middle" fill="#1e293b" font-size="12">Burstable</text>
  <text x="400" y="272" text-anchor="middle" fill="#64748b" font-size="11">some req &lt; limit</text>

  <rect x="500" y="235" width="180" height="46" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="590" y="255" text-anchor="middle" fill="#1e293b" font-size="12">BestEffort</text>
  <text x="590" y="272" text-anchor="middle" fill="#64748b" font-size="11">no req/limit · dies first</text>

  <line x1="120" y1="305" x2="680" y2="305" stroke="#475569" stroke-width="2" marker-end="url(#a)"/>
  <text x="400" y="328" text-anchor="middle" fill="#64748b" font-size="11">node memory pressure → kubelet evicts left-to-right (BestEffort first)</text>
</svg>
```

## 6. Variations & Trade-offs

| QoS class | Requirement | Under node pressure | Use for |
|-----------|-------------|---------------------|---------|
| **Guaranteed** | every container `requests == limits` (cpu & mem) | evicted last; strongest protection | latency-critical DBs, singletons |
| **Burstable** | ≥1 request set, `< limits` (or some unset) | evicted after BestEffort, by usage-over-request | most stateless services |
| **BestEffort** | no requests or limits at all | evicted first | throwaway/batch, dev only |

Prose trade-offs: **Guaranteed** gives predictability and OOM protection but wastes capacity — you reserve your peak even when idle, hurting bin-packing/cost. **Burstable** is the pragmatic default: reserve the steady-state as the request, allow bursts up to a limit, accept some eviction risk. On **CPU limits** there's an active debate: strict limits cause harmful throttling of bursty latency-sensitive apps, so many teams set CPU *requests* but *omit CPU limits* (letting pods use spare cycles), while always keeping **memory limits** (since memory is incompressible and unbounded memory can take down a node). Set memory `requests == limits` for anything you never want OOMKilled unexpectedly.

## 7. Production / Performance Notes

- **Right-size from real data.** Set requests near the p50–p90 observed usage (VPA recommendations or Prometheus history), not guesses. Over-requesting wastes money; under-requesting risks eviction.
- **Consider omitting CPU limits** for latency-sensitive services to avoid CFS throttling, but *always* set CPU **requests** so the scheduler and HPA behave. Keep an eye on `nr_throttled`.
- **Always set memory limits** — a leak without a limit consumes the whole node and triggers system-wide eviction/OOM affecting neighbors.
- **For critical singletons, go Guaranteed** (`requests == limits`) so they're evicted last and never OOMKilled by their own bursts.
- **Watch the `container_cpu_cfs_throttled_periods_total` / `..._seconds_total` metrics** — high throttling with low node CPU is the tell-tale sign of a too-tight CPU limit.
- **Overcommit deliberately.** Requests can be conservative and limits generous to pack more pods, but the more you overcommit memory the higher the eviction risk — model it.
- **Use LimitRange to prevent BestEffort pods** sneaking in (a container with no request defaults to BestEffort and dies first). Use ResourceQuota so no namespace can starve the cluster.
- **JVM/Go/Node runtimes** must be told about the cgroup limit (`-XX:MaxRAMPercentage`, `GOMEMLIMIT`, `--max-old-space-size`) or they'll size heaps to the *node's* RAM and get OOMKilled.

## 8. Common Mistakes

1. ⚠️ **Setting a too-low CPU limit on a bursty service.** Causes CFS throttling and bad p99 while the node looks idle. **Fix:** raise or remove the CPU limit; keep CPU requests.
2. ⚠️ **Memory limit below real working set.** Container is OOMKilled (exit 137) repeatedly. **Fix:** measure real RSS, set limit above peak + margin.
3. ⚠️ **No requests at all → BestEffort.** Pod is the first evicted under pressure. **Fix:** always set at least requests; use a LimitRange for defaults.
4. ⚠️ **Assuming requests cap usage.** They don't — a pod can exceed its request up to its limit; requests only affect scheduling. **Fix:** understand requests=reserve, limits=cap.
5. ⚠️ **Runtime heap sized to node RAM.** JVM/Node ignore cgroup limits by default and OOM. **Fix:** set `GOMEMLIMIT`/`MaxRAMPercentage`/`--max-old-space-size` from the limit.
6. ⚠️ **Requests == node capacity, so nothing else schedules.** Over-requesting wrecks bin-packing and cost. **Fix:** right-size to observed usage (VPA/metrics).
7. ⚠️ **No ResourceQuota/LimitRange in shared clusters.** One team's runaway pods starve everyone. **Fix:** enforce per-namespace quotas and per-container ranges.

## 9. Interview Questions

**Q: What's the difference between a request and a limit?**
A: A **request** is what the scheduler reserves to place the pod — it guarantees room and doesn't cap usage. A **limit** is the runtime ceiling enforced by the kernel via cgroups — CPU above it is throttled, memory above it is OOMKilled. Request = scheduling; limit = runtime enforcement.

**Q: Why is CPU "compressible" and memory "incompressible," and what's the consequence?**
A: CPU can be time-sliced, so exceeding the CPU limit merely **throttles** (slows) the process — it always makes progress eventually. Memory can't be reclaimed from a running process on demand, so exceeding the memory limit forces the kernel to **kill** the container (OOMKilled, exit 137). Hence: over-CPU = slow, over-memory = dead.

**Q: How is a pod's QoS class determined?**
A: `Guaranteed` — every container has `requests == limits` for both CPU and memory. `Burstable` — at least one request is set but not all equal to limits. `BestEffort` — no requests or limits anywhere. It's derived, not declared.

**Q: Under node memory pressure, in what order are pods evicted?**
A: BestEffort first, then Burstable (ordered by how far each exceeds its memory *request*), and Guaranteed last. So setting requests close to real usage and using Guaranteed for critical pods improves survival.

**Q: A service has high p99 latency but the node's CPU is only 40% used. What's your hypothesis?**
A: CPU **throttling** from a too-low CPU limit. The CFS scheduler caps the container per 100ms period, so it stalls even though the node has spare capacity overall. Confirm with `cpu.stat` / `container_cpu_cfs_throttled_periods_total`, then raise or remove the CPU limit.

**Q: A container keeps restarting with exit code 137. What does that mean and how do you fix it?**
A: 137 = 128 + SIGKILL(9) = **OOMKilled** — it exceeded its memory limit. Check `Last State: Terminated, Reason: OOMKilled` in `describe`. Fix by measuring the real working set and raising the memory limit (and possibly the runtime's heap config).

**Q: (Senior) Why do many teams set CPU requests but deliberately omit CPU limits?**
A: A CPU limit triggers CFS throttling that badly hurts bursty, latency-sensitive workloads even when the node is idle. Omitting the limit lets pods use spare cycles, improving tail latency, while the **request** still ensures fair scheduling and a guaranteed share. They keep **memory limits** because memory is incompressible and unbounded memory can take down the node.

**Q: (Senior) What do LimitRange and ResourceQuota each do, and why use both?**
A: **LimitRange** is per-container/pod policy in a namespace: default requests/limits (so nothing lands as BestEffort) and min/max bounds. **ResourceQuota** caps the *aggregate* requests/limits and object counts for the whole namespace. Together they prevent both individual mis-sized pods and namespace-level resource hogging in multi-tenant clusters.

**Q: (Senior) A JVM app is OOMKilled at 1Gi limit even though the app "only uses 600Mi." What's likely wrong?**
A: The JVM sized its heap based on the *node's* memory, not the cgroup limit, so heap + metaspace + off-heap + native buffers exceed 1Gi. Fix by making the runtime container-aware: `-XX:MaxRAMPercentage=70` (or `-Xmx` derived from the limit). Same class of bug hits Node (`--max-old-space-size`) and Go (`GOMEMLIMIT`).

**Q: (Senior) Give the trade-off of Guaranteed vs Burstable QoS at fleet scale.**
A: Guaranteed (requests==limits) maximizes stability — never OOMKilled by its own bursts, evicted last — but reserves peak capacity continuously, hurting bin-packing and raising cost. Burstable reserves steady-state and bursts on demand, packing far denser and cheaper, at the price of eviction risk under contention. Most stateless services should be Burstable; latency-critical singletons/DBs Guaranteed.

## 10. Practice

- [ ] Deploy a pod with `requests == limits` and confirm `.status.qosClass == Guaranteed`; remove the requests and watch it become BestEffort.
- [ ] Give a CPU-hungry container a `250m` limit, load it, and observe throttling via `cat /sys/fs/cgroup/cpu.stat` (`nr_throttled`).
- [ ] Set a memory limit below a stress test's usage and capture the `OOMKilled`/exit-137 event in `kubectl describe`.
- [ ] Apply a LimitRange and create a container with no resources; verify it inherits the defaults.
- [ ] Apply a ResourceQuota, then try to exceed it and read the admission rejection message.

## 11. Cheat Sheet

> [!TIP]
> **Request = scheduler reserves it; Limit = kernel enforces it.**
> - CPU over limit → **throttled** (slow). Memory over limit → **OOMKilled (137)**.
> - QoS: **Guaranteed** (req==limit, dies last) · **Burstable** (some req<limit) · **BestEffort** (none, dies first).
> - Slow but node idle ⇒ CPU throttling → raise/remove CPU limit (keep the request).
> - Exit 137 ⇒ memory limit too low → raise it; make runtime cgroup-aware (`GOMEMLIMIT`, `MaxRAMPercentage`).
> - **Always set memory limits** (incompressible). Consider **omitting CPU limits** for latency-sensitive apps.
> - **LimitRange** = per-container defaults + min/max. **ResourceQuota** = per-namespace aggregate caps.
> - Right-size requests to observed p50–p90 (VPA/metrics) — over-request wastes money, under-request risks eviction.

**References:** Kubernetes "Managing Resources for Containers", QoS classes, LimitRange & ResourceQuota docs; Linux CFS/cgroups v2 docs

---
*Kubernetes Handbook — topic 19.*
