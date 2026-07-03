# 27 · From Compose to Orchestration (Swarm & Kubernetes)

> **In one line:** Compose runs your stack on **one host**; an orchestrator spreads it across a **fleet** and takes over the operational reflexes — scheduling, self-healing, service discovery, scaling, and rolling updates — so the cluster, not you, keeps the declared state true.

---

## 1. Overview

`docker compose up` is perfect until the day one machine is not enough — or not allowed to be a single point of failure. Compose is fundamentally a **single-host** tool: every service in the file lands on the *same* Docker daemon. If that host dies, the whole stack dies; if traffic doubles, you can't spill onto a second machine; if a container crashes at 3 a.m., nobody restarts it with a healthy replacement on a healthy node.

**Orchestration** is the answer to "run these containers across *many* hosts, reliably, without a human in the loop." You describe the **desired state** — "6 replicas of `api`, always, behind one virtual IP, updated 2 at a time" — and a **control plane** continuously reconciles reality toward it: placing containers on nodes with room (**scheduling**), restarting/rescheduling failed ones (**self-healing**), giving them a stable name and load-balanced VIP (**service discovery**), adding/removing replicas (**scaling**), and swapping versions without downtime (**rolling updates**).

Two orchestrators dominate the Docker world. **Docker Swarm** is built into the Docker Engine — `docker swarm init` and your Compose knowledge (via `docker stack deploy`) carry straight over; it's simple, low-overhead, and enough for small/medium clusters. **Kubernetes** is the CNCF industry standard — vastly more powerful and extensible (custom resources, operators, huge ecosystem) but with a steeper learning curve and more moving parts.

The mental model to keep: **Compose → Swarm** is a small step (same file format-ish, one new concept: the cluster). **Compose → Kubernetes** is a bigger step (new objects: Pods, Deployments, Services, Ingress) but the *ideas* — desired state, reconciliation, replicas, rollout — are identical. Learn the ideas once; both tools express them.

## 2. Core Concepts

- **Desired state & reconciliation** — you declare *what* you want; a controller loop constantly diffs actual vs desired and acts to close the gap. This is the beating heart of every orchestrator.
- **Scheduling** — the control plane picks which **node** runs each container based on resource requests, constraints/affinity, and spread. You stop caring *where* things run.
- **Self-healing** — a crashed container is restarted; a dead **node's** workloads are rescheduled elsewhere; failing health checks are replaced. Declared replica count is maintained automatically.
- **Service discovery + load balancing** — services get a stable **DNS name** and a **virtual IP**; requests are balanced across healthy replicas, which come and go freely.
- **Scaling** — change one number (`replicas: 6`) or let an autoscaler react to CPU/metrics; the orchestrator schedules the delta.
- **Rolling updates & rollback** — new version is rolled out incrementally (N at a time, health-gated), with automatic **rollback** if the new tasks fail to become healthy — zero-downtime deploys.
- **Control plane vs data plane** — **managers/control-plane** (scheduler, state store, API) make decisions; **workers/nodes** (agent + runtime) run the actual containers.
- **Cluster state store** — a consistent, replicated store of truth: **Raft** in Swarm, **etcd** in Kubernetes. Odd number of managers for quorum.

## 3. Syntax & Examples

**Swarm** — turn a single Docker host into a cluster and deploy a Compose-style stack:

```bash
docker swarm init --advertise-addr 10.0.0.1        # this host becomes manager 1
docker swarm join-token worker                      # prints the token/command for workers
# on each worker:
docker swarm join --token SWMTKN-… 10.0.0.1:2377

docker node ls                                      # see managers + workers
```

```yaml
# stack.yml — a Compose file with a Swarm `deploy:` block
services:
  api:
    image: myorg/api:1.4.2
    ports: ["8080:8080"]
    deploy:
      replicas: 6
      update_config: { parallelism: 2, delay: 10s, order: start-first }
      rollback_config: { parallelism: 2 }
      restart_policy: { condition: on-failure }
      resources:
        limits: { cpus: "0.5", memory: 256M }
```

```bash
docker stack deploy -c stack.yml shop   # deploy across the cluster
docker service ls                        # api = 6/6 replicas
docker service scale shop_api=10         # scale in one command
docker service update --image myorg/api:1.5.0 shop_api   # rolling update
```

**Kubernetes** — the same intent, expressed as a Deployment + Service:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  replicas: 6
  selector: { matchLabels: { app: api } }
  strategy:
    type: RollingUpdate
    rollingUpdate: { maxSurge: 2, maxUnavailable: 0 }
  template:
    metadata: { labels: { app: api } }
    spec:
      containers:
        - name: api
          image: myorg/api:1.4.2
          ports: [{ containerPort: 8080 }]
          resources:
            limits: { cpu: "500m", memory: 256Mi }
          readinessProbe:
            httpGet: { path: /healthz, port: 8080 }
---
apiVersion: v1
kind: Service
metadata: { name: api }
spec:
  selector: { app: api }
  ports: [{ port: 80, targetPort: 8080 }]
```

```bash
kubectl apply -f api.yaml
kubectl scale deployment/api --replicas=10
kubectl set image deployment/api api=myorg/api:1.5.0   # rolling update
kubectl rollout undo deployment/api                    # instant rollback
```

## 4. Worked Example — surviving a node failure

Deploy 6 API replicas on a 3-node Swarm, then kill a worker and watch the cluster self-heal.

```bash
docker stack deploy -c stack.yml shop
docker service ps shop_api           # replicas spread across node-1/2/3
```

Now simulate node-3 dying:

```bash
docker node update --availability drain node-3   # or literally power it off
docker service ps shop_api                        # watch reconciliation
```

Result — the two replicas that were on node-3 are rescheduled onto healthy nodes, and the service VIP keeps routing to only healthy tasks:

```text
NAME        NODE     DESIRED STATE   CURRENT STATE
shop_api.1  node-1   Running         Running 8 minutes ago
shop_api.2  node-2   Running         Running 8 minutes ago
shop_api.3  node-3   Shutdown        Shutdown 20 seconds ago     ← was here
shop_api.3  node-1   Running         Running 12 seconds ago      ← rescheduled
shop_api.4  node-2   Running         Running 8 minutes ago
shop_api.5  node-3   Shutdown        Shutdown 20 seconds ago     ← was here
shop_api.5  node-2   Running         Running 12 seconds ago      ← rescheduled
shop_api.6  node-1   Running         Running 8 minutes ago
```

Desired state (6 running) was restored in seconds with no human action and no dropped traffic. That single behavior — reconcile back to declared state — is *why* orchestration exists. With Compose, those two containers would simply be gone.

## 5. Under the Hood

An orchestrated cluster splits into a **control plane** (managers holding cluster state and making scheduling decisions) and **worker nodes** (agents running containers and reporting health). Clients talk only to the control-plane API; the control plane drives everything else.

```svg
<svg viewBox="0 0 740 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>

  <!-- client -->
  <rect x="300" y="12" width="140" height="34" rx="8" fill="#f8fafc" stroke="#475569"/>
  <text x="370" y="33" text-anchor="middle" fill="#1e293b">kubectl / docker CLI</text>

  <!-- control plane -->
  <rect x="90" y="66" width="560" height="96" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="370" y="86" text-anchor="middle" fill="#2563eb" font-weight="700">Control Plane (managers)</text>
  <rect x="110" y="98" width="120" height="50" rx="8" fill="#ffffff" stroke="#2563eb"/>
  <text x="170" y="120" text-anchor="middle" fill="#1e293b">API Server</text>
  <text x="170" y="137" text-anchor="middle" fill="#64748b" font-size="11">desired state in</text>
  <rect x="245" y="98" width="120" height="50" rx="8" fill="#ffffff" stroke="#2563eb"/>
  <text x="305" y="120" text-anchor="middle" fill="#1e293b">Scheduler</text>
  <text x="305" y="137" text-anchor="middle" fill="#64748b" font-size="11">place on nodes</text>
  <rect x="380" y="98" width="130" height="50" rx="8" fill="#ffffff" stroke="#2563eb"/>
  <text x="445" y="120" text-anchor="middle" fill="#1e293b">Controllers</text>
  <text x="445" y="137" text-anchor="middle" fill="#64748b" font-size="11">reconcile / heal</text>
  <rect x="525" y="98" width="105" height="50" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="577" y="120" text-anchor="middle" fill="#1e293b">State store</text>
  <text x="577" y="137" text-anchor="middle" fill="#64748b" font-size="11">etcd / Raft</text>

  <line x1="370" y1="46" x2="370" y2="64" stroke="#475569" marker-end="url(#a)"/>

  <!-- workers -->
  <g>
    <rect x="70" y="210" width="180" height="120" rx="8" fill="#ffffff" stroke="#475569"/>
    <text x="160" y="230" text-anchor="middle" fill="#1e293b" font-weight="700">Worker node-1</text>
    <text x="160" y="248" text-anchor="middle" fill="#64748b" font-size="11">agent + runtime</text>
    <rect x="88" y="258" width="66" height="30" rx="6" fill="#ecfdf5" stroke="#059669"/>
    <text x="121" y="278" text-anchor="middle" fill="#1e293b" font-size="11">api.1</text>
    <rect x="166" y="258" width="66" height="30" rx="6" fill="#ecfdf5" stroke="#059669"/>
    <text x="199" y="278" text-anchor="middle" fill="#1e293b" font-size="11">api.2</text>
    <rect x="88" y="294" width="144" height="28" rx="6" fill="#fff7ed" stroke="#d97706"/>
    <text x="160" y="313" text-anchor="middle" fill="#1e293b" font-size="11">web.1</text>
  </g>
  <g>
    <rect x="280" y="210" width="180" height="120" rx="8" fill="#ffffff" stroke="#475569"/>
    <text x="370" y="230" text-anchor="middle" fill="#1e293b" font-weight="700">Worker node-2</text>
    <text x="370" y="248" text-anchor="middle" fill="#64748b" font-size="11">agent + runtime</text>
    <rect x="298" y="258" width="66" height="30" rx="6" fill="#ecfdf5" stroke="#059669"/>
    <text x="331" y="278" text-anchor="middle" fill="#1e293b" font-size="11">api.3</text>
    <rect x="376" y="258" width="66" height="30" rx="6" fill="#ecfdf5" stroke="#059669"/>
    <text x="409" y="278" text-anchor="middle" fill="#1e293b" font-size="11">api.4</text>
    <rect x="298" y="294" width="144" height="28" rx="6" fill="#fff7ed" stroke="#d97706"/>
    <text x="370" y="313" text-anchor="middle" fill="#1e293b" font-size="11">web.2</text>
  </g>
  <g>
    <rect x="490" y="210" width="180" height="120" rx="8" fill="#ffffff" stroke="#475569"/>
    <text x="580" y="230" text-anchor="middle" fill="#1e293b" font-weight="700">Worker node-3</text>
    <text x="580" y="248" text-anchor="middle" fill="#64748b" font-size="11">agent + runtime</text>
    <rect x="508" y="258" width="66" height="30" rx="6" fill="#ecfdf5" stroke="#059669"/>
    <text x="541" y="278" text-anchor="middle" fill="#1e293b" font-size="11">api.5</text>
    <rect x="586" y="258" width="66" height="30" rx="6" fill="#ecfdf5" stroke="#059669"/>
    <text x="619" y="278" text-anchor="middle" fill="#1e293b" font-size="11">api.6</text>
    <rect x="508" y="294" width="144" height="28" rx="6" fill="#eff6ff" stroke="#2563eb"/>
    <text x="580" y="313" text-anchor="middle" fill="#1e293b" font-size="11">db.1</text>
  </g>

  <line x1="200" y1="162" x2="160" y2="208" stroke="#475569" marker-end="url(#a)"/>
  <line x1="370" y1="162" x2="370" y2="208" stroke="#475569" marker-end="url(#a)"/>
  <line x1="540" y1="162" x2="580" y2="208" stroke="#475569" marker-end="url(#a)"/>
  <text x="370" y="352" text-anchor="middle" fill="#64748b" font-size="11">Managers decide &amp; store state ▸ workers run containers &amp; report health ▸ loop reconciles to desired state</text>
</svg>
```

The loop never stops: workers stream health/status up to the control plane; controllers compare that live picture to the desired state in the store (**Raft** for Swarm, **etcd** for Kubernetes — both need an odd manager count for quorum); any drift (a dead task, a missing replica, an out-of-date image) triggers the scheduler to place work on a suitable node. Nothing is "run once"; everything is a continuously-corrected invariant.

## 6. Variations & Trade-offs

| Dimension | Docker Compose | Docker Swarm | Kubernetes |
|---|---|---|---|
| Scope | Single host | Multi-host cluster | Multi-host cluster |
| Setup effort | Trivial (`compose up`) | Easy (`swarm init`, built-in) | Complex (managed: EKS/GKE/AKS) |
| Learning curve | Low | Low (reuses Compose knowledge) | Steep (Pods/Deployments/Services/Ingress) |
| Self-healing / rescheduling | ❌ (restart on same host only) | ✅ | ✅ |
| Rolling update / rollback | ❌ | ✅ (`update_config`) | ✅ (`RollingUpdate`, `rollout undo`) |
| Autoscaling | ❌ | Manual scale only | ✅ HPA/VPA/Cluster Autoscaler |
| Service discovery / LB | Compose DNS (one host) | Built-in DNS + routing mesh VIP | DNS + Services + Ingress |
| Config format | `docker-compose.yml` | Compose + `deploy:` block | Many YAML kinds (or Helm) |
| Ecosystem / extensibility | Minimal | Modest | Huge (CRDs, operators, Helm, service mesh) |
| Best fit | Local dev, CI, one box | Small/medium clusters, simple ops | Large scale, complex platforms, industry standard |

**Trade-off:** Swarm buys you ~90% of orchestration for ~10% of the complexity and is the fastest jump from Compose; Kubernetes costs far more operationally but is the standard, is infinitely extensible, and is what the ecosystem, hiring, and managed clouds are built around. Choose Swarm when the team is small and needs simple HA; choose Kubernetes when scale, extensibility, or org standardization demand it.

## 7. Production / Performance Notes

- **Quorum matters** — run an **odd** number of managers (3 or 5), never 2 or 4. Losing quorum freezes scheduling; keep managers on separate failure domains and don't run heavy workloads on them.
- **Health probes gate rollouts** — without a real **readiness** check, an orchestrator will happily route traffic to a not-yet-ready container and call a broken deploy "successful." Define readiness/liveness so rollouts are health-gated and self-healing works.
- **Requests & limits, not hope** — set CPU/memory **requests** (for scheduling decisions) and **limits** (to cap blast radius). Unset requests lead to overpacked nodes and OOM cascades.
- **Stateful workloads need care** — orchestrators reschedule containers anywhere, so state must live in networked/persistent storage (Swarm volumes on shared storage; Kubernetes StatefulSets + PersistentVolumes), not the node's local disk.
- **Prefer managed control planes** — for Kubernetes, EKS/GKE/AKS run the control plane and etcd for you; self-managing etcd, certs, and upgrades is a full-time job.
- **Rollout strategy** — `start-first`/`maxSurge` gives zero-downtime by starting new tasks before stopping old; `maxUnavailable: 0` guarantees capacity is never dipped during a deploy.

## 8. Common Mistakes

1. ⚠️ **Using Compose as production HA.** It's single-host — one machine dies, everything dies. *Fix:* graduate to Swarm or Kubernetes for anything that must survive a node.
2. ⚠️ **Even number of managers.** Two managers can't form quorum if one fails — worse than one. *Fix:* always 3 or 5 managers.
3. ⚠️ **No readiness/liveness probes.** Rollouts "succeed" onto broken containers; self-healing can't tell healthy from hung. *Fix:* add real health checks that gate traffic and updates.
4. ⚠️ **Storing state on local node disk.** Rescheduling moves the container; the data doesn't follow. *Fix:* use persistent/networked volumes (PV/PVC, StatefulSet, shared Swarm volumes).
5. ⚠️ **No resource requests/limits.** The scheduler overpacks nodes, then containers OOM-kill each other. *Fix:* set requests (scheduling) and limits (caps) on every workload.
6. ⚠️ **Reaching for Kubernetes for a 3-service app on one team.** You buy a platform's complexity for a Compose-sized problem. *Fix:* match tool to scale — Compose/Swarm first, Kubernetes when scale/extensibility justify it.
7. ⚠️ **Treating the orchestrator as fire-and-forget.** No monitoring of the control plane, etcd, or certificate expiry. *Fix:* monitor control-plane health, back up etcd/Raft, and manage cert/version upgrades.

## 9. Interview Questions

**Q: Why isn't Docker Compose enough for production, and what does an orchestrator add?**
A: Compose is single-host — one Docker daemon, one machine, a single point of failure with no cross-node scheduling. An orchestrator adds multi-host **scheduling**, **self-healing** (reschedule failed containers/nodes), **service discovery + load balancing**, **scaling**, and **rolling updates/rollback** — continuously reconciling the cluster to your declared desired state.

**Q: What does "desired state reconciliation" mean?**
A: You declare *what* you want (e.g. 6 replicas of a service); a controller loop constantly compares actual cluster state against that desired state and takes corrective action to close any gap — restarting a crashed container, rescheduling off a dead node, or scaling to the requested count. It's the core control mechanism of every orchestrator.

**Q: How does an orchestrator self-heal when a whole node dies?**
A: Workers continuously report health to the control plane. When a node stops reporting, its tasks are marked lost; controllers see the replica count is now below desired and the scheduler places replacement containers on healthy nodes. The service VIP stops routing to the dead tasks, so traffic keeps flowing — no human needed.

**Q: How is service discovery handled in a cluster where replicas come and go?**
A: Each service gets a stable **DNS name** and a **virtual IP**. Clients resolve the name to the VIP; the orchestrator load-balances across the currently *healthy* replicas behind it (Swarm's routing mesh, or Kubernetes Services/kube-proxy + Ingress). Individual container IPs are ephemeral and never referenced directly.

**Q: Compare Docker Swarm and Kubernetes — when would you pick each?**
A: Swarm is built into Docker, reuses Compose knowledge, is simple and low-overhead — ideal for small/medium clusters and teams wanting HA without a platform team. Kubernetes is the industry standard: far more powerful and extensible (CRDs, operators, autoscaling, huge ecosystem, managed clouds) but with a steep curve and more moving parts — pick it for large scale, complex platforms, or organizational standardization.

**Q: How does a zero-downtime rolling update work?**
A: The orchestrator updates replicas incrementally — a few at a time (Swarm `parallelism`, Kubernetes `maxSurge`/`maxUnavailable`) — starting new versions and waiting for their **readiness** checks before removing old ones. `maxUnavailable: 0`/`start-first` keeps full capacity throughout, and if new tasks fail to become healthy it **rolls back** automatically.

**Q: What's the smallest deployable unit in Kubernetes, and how does it differ from a Swarm task?**
A: In Kubernetes it's a **Pod** — one or more tightly-coupled containers sharing network and storage, scheduled together. In Swarm the unit is a **task**, which is essentially a single container instance of a service. Pods add the "sidecar" grouping (shared localhost/volumes) that Swarm tasks don't natively express.

**Q: (Senior) Why must you run an odd number of manager/control-plane nodes?**
A: Cluster state uses a consensus protocol — **Raft** in Swarm, **etcd/Raft** in Kubernetes — that requires a **majority quorum** to make changes. With N managers you tolerate ⌊(N-1)/2⌋ failures; odd counts maximize fault tolerance per node. Two managers tolerate zero failures (losing one breaks quorum), so 3 or 5 is the rule.

**Q: (Senior) How do you run stateful services under an orchestrator that reschedules containers anywhere?**
A: Decouple state from the container. Use **persistent/networked volumes** that can attach to whatever node the container lands on, and stable identities — Kubernetes **StatefulSets** give ordered names + per-replica PersistentVolumeClaims; Swarm uses volume plugins on shared storage. Never rely on the node's local disk, since rescheduling won't move it.

**Q: (Senior) What is the routing mesh / how does cluster-wide load balancing reach a container on another node?**
A: In Swarm's **routing mesh**, a published port is opened on *every* node; a request to any node is forwarded (via IPVS/overlay network) to a healthy task wherever it runs. Kubernetes does the analog with Services + kube-proxy (iptables/IPVS) and Ingress. Either way, clients hit a stable endpoint and the mesh handles cross-node delivery to healthy replicas.

**Q: (Senior) How does autoscaling work in Kubernetes and why doesn't Swarm match it?**
A: Kubernetes' **Horizontal Pod Autoscaler** watches metrics (CPU, memory, or custom/external metrics) and adjusts replica count automatically, while the **Cluster Autoscaler** adds/removes nodes to fit. Swarm only offers manual `docker service scale` — no built-in metric-driven autoscaling — which is one of the main reasons large, elastic workloads choose Kubernetes.

**Q: (Senior) Migrating from Compose to Kubernetes — how do the concepts map?**
A: A Compose **service** becomes a **Deployment** (replicas + rolling strategy) whose Pod template holds the container spec; `ports` exposure becomes a **Service** (+ **Ingress** for HTTP routing); `deploy.replicas` → `spec.replicas`; `depends_on`/discovery → DNS + readiness gating; volumes → PVCs; env/config → ConfigMaps/Secrets. Tools like Kompose scaffold this, but you hand-tune probes, resources, and rollout policy.

## 10. Practice

- [ ] `docker swarm init`, deploy a 3-replica stack with `docker stack deploy`, then `docker service scale` it to 6 and watch placement with `docker service ps`.
- [ ] Drain or power off a worker node and observe the orchestrator reschedule its tasks back to the desired replica count.
- [ ] Perform a rolling update (`docker service update --image …` or `kubectl set image …`) and then roll it back; confirm no downtime with a request loop.
- [ ] On a kind/minikube cluster, write a Deployment + Service + readiness probe, scale it, and delete a Pod to watch self-healing recreate it.
- [ ] Convert one `docker-compose.yml` service into a Kubernetes Deployment + Service (by hand or with Kompose) and diff what concepts you had to add (probes, resources, Ingress).

## 11. Cheat Sheet

> [!TIP]
> **Compose → Orchestration — the whole topic**
> - **Compose** = one host, one SPOF, no cross-node scheduling. **Orchestrator** = many hosts + operational autopilot.
> - Five things orchestrators add: **scheduling · self-healing · service discovery/LB · scaling · rolling updates+rollback**.
> - Core mechanism: declare **desired state** → a **reconciliation loop** continuously corrects drift.
> - **Control plane** (API + scheduler + controllers + state store) decides; **workers** run containers & report health.
> - State store: **Raft** (Swarm) / **etcd** (K8s) → run an **odd** number of managers (3 or 5) for quorum.
> - **Swarm** = built into Docker, reuses Compose (`deploy:` + `docker stack deploy`), simple, small/medium clusters.
> - **Kubernetes** = industry standard, Pods/Deployments/Services/Ingress, autoscaling + CRDs, steep but extensible.
> - Zero-downtime deploy = incremental rollout gated by **readiness probes**; `maxUnavailable:0`/`start-first` keeps capacity.
> - Stateful workloads → persistent/networked volumes (StatefulSet + PVC), never local node disk.
> - Rule of thumb: dev/CI → Compose; simple HA → Swarm; scale/extensibility/standardization → Kubernetes.

**References:** Docker docs "Swarm mode" and "Docker stack"; Kubernetes docs "Concepts: Workloads & Services"; CNCF Kubernetes overview; "Kubernetes Up & Running" (Burns, Beda, Hightower); Raft consensus paper (Ongaro & Ousterhout).

---
*Docker Handbook — topic 27.*
