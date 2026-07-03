# 01 · Kubernetes Architecture

> **In one line:** Kubernetes is a distributed control system where control-plane components store and reconcile your *desired state* against the *actual state* of worker nodes, forever closing the gap through control loops.

---

## 1. Overview

Kubernetes is a **cluster operating system**: you declare *what* you want running — "3 replicas of this image, exposed on port 80" — and the cluster figures out *how* to make it true and keep it true. You never SSH into a box to start a process; you submit an object to the API and the system converges toward it.

The cluster splits into two planes. The **control plane** is the brain: it holds the single source of truth (etcd), exposes the only API anyone talks to (kube-apiserver), decides where things run (scheduler), and drives reality toward intent (controller-manager). The **data plane** is the muscle: a fleet of **worker nodes**, each running a **kubelet** that starts containers, a **kube-proxy** that wires up Service networking, and a **container runtime** that actually executes the images.

The whole system is built on one idea repeated everywhere — the **reconciliation loop**. A controller *observes* current state, *compares* it to desired state, and *acts* to reduce the difference, then repeats forever. This is why Kubernetes is self-healing: kill a pod and a controller notices the replica count dropped and recreates it, with no human in the loop.

You reach for this mental model constantly: to debug ("which loop isn't converging?"), to reason about failure ("if the apiserver is down, do running pods keep running?"), and to design ("what controller owns this object?").

## 2. Core Concepts

- **Declarative desired state** — you POST objects describing the end goal; you do not issue imperative "start/stop" commands. The system owns the *how*.
- **kube-apiserver** — the front door. A stateless REST server that authenticates, authorizes, validates, and persists every object. *Everything* (kubectl, kubelet, controllers) talks only to it — it is the hub of a hub-and-spoke architecture.
- **etcd** — a distributed, consistent key-value store (Raft consensus) that is the **single source of truth**. Every cluster object lives here. Lose etcd and you lose the cluster's state.
- **kube-scheduler** — watches for unscheduled pods and picks the best node for each via *filtering* (which nodes can fit?) then *scoring* (which is best?). It only writes the binding; it does not start the pod.
- **kube-controller-manager** — a single binary running dozens of controllers (Deployment, ReplicaSet, Node, Job, endpoints…), each a reconciliation loop watching its object type.
- **kubelet** — the node agent. Watches the apiserver for pods bound to *its* node and drives the runtime to make them real; reports pod and node status back.
- **kube-proxy** — per-node network daemon that programs iptables/IPVS rules so Service virtual IPs load-balance to pods.
- **Container runtime** — the software that runs containers (containerd, CRI-O) via the **CRI** (Container Runtime Interface).
- **Controllers watch, they don't poll** — components use the apiserver's **watch** API to receive a stream of changes, keeping a local cache in sync efficiently.
- **Level-triggered, not edge-triggered** — controllers act on the *observed state of the world*, not on a one-shot event, so a missed event self-corrects on the next sync.

## 3. Syntax & Examples

Inspect the control plane and nodes:

```bash
kubectl get nodes -o wide                 # worker + control-plane nodes
kubectl -n kube-system get pods           # control-plane pods (kubeadm clusters)
kubectl cluster-info                      # apiserver + core addon endpoints
kubectl get --raw='/healthz?verbose'      # apiserver health check
```

A desired-state object is just YAML you hand to the apiserver:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 3          # DESIRED state: exactly 3 pods
  selector:
    matchLabels: { app: web }
  template:
    metadata:
      labels: { app: web }
    spec:
      containers:
        - name: web
          image: nginx:1.27
```

```bash
kubectl apply -f web.yaml     # POST to apiserver -> stored in etcd
```

Watch reconciliation happen in real time:

```bash
kubectl delete pod -l app=web --wait=false   # break desired state
kubectl get pods -l app=web -w               # controller recreates to 3
```

## 4. Worked Example

Trace the life of `kubectl apply -f web.yaml` through every component:

```bash
kubectl apply -f web.yaml
deployment.apps/web created
```

What happened, step by step:

| Step | Component | Action |
|------|-----------|--------|
| 1 | **kubectl** | Sends the Deployment as a REST `POST` to the apiserver |
| 2 | **kube-apiserver** | Authn/authz, validates schema, writes the Deployment to **etcd** |
| 3 | **deployment controller** | Watch fires; sees a Deployment with no ReplicaSet → creates a **ReplicaSet** |
| 4 | **replicaset controller** | Sees RS wants 3 pods, 0 exist → creates 3 **Pod** objects (Pending, no node) |
| 5 | **kube-scheduler** | Watches for Pending pods → filters + scores nodes → writes a **binding** per pod |
| 6 | **kubelet** (each node) | Sees a pod bound to its node → calls the **CRI** runtime to pull image + start container |
| 7 | **container runtime** | Creates the pause + app containers; kubelet reports `Running` back to apiserver |
| 8 | **kube-proxy** | If a Service selects these pods, programs iptables so the VIP routes to them |

Confirm the object graph the controllers built:

```bash
kubectl get deploy,rs,pods -l app=web
```

```text
NAME                  READY   UP-TO-DATE   AVAILABLE
deployment.apps/web   3/3     3            3

NAME                             DESIRED   CURRENT   READY
replicaset.apps/web-6f9c4d8b7    3         3         3

NAME                   READY   STATUS    NODE
web-6f9c4d8b7-2xk9v    1/1     Running   node-a
web-6f9c4d8b7-8dprl    1/1     Running   node-b
web-6f9c4d8b7-lm4zt    1/1     Running   node-a
```

Notice: no single component did the whole job. Each owns one small loop; the outcome *emerges* from their cooperation through the apiserver.

## 5. Under the Hood

Every component is a **client of the apiserver** — there is no direct component-to-component chatter. The apiserver is the only thing that touches etcd. This hub-and-spoke design makes the API the single security, audit, and consistency boundary.

```svg
<svg viewBox="0 0 760 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="arw" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>

  <rect x="20" y="20" width="380" height="250" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="210" y="42" text-anchor="middle" fill="#1e293b" font-weight="700">Control Plane</text>

  <rect x="45" y="60" width="150" height="46" rx="8" fill="#ffffff" stroke="#2563eb"/>
  <text x="120" y="82" text-anchor="middle" fill="#1e293b" font-weight="600">kube-apiserver</text>
  <text x="120" y="98" text-anchor="middle" fill="#64748b">the only front door</text>

  <rect x="225" y="60" width="150" height="46" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="300" y="82" text-anchor="middle" fill="#1e293b" font-weight="600">etcd</text>
  <text x="300" y="98" text-anchor="middle" fill="#64748b">source of truth</text>

  <rect x="45" y="132" width="150" height="44" rx="8" fill="#ffffff" stroke="#2563eb"/>
  <text x="120" y="159" text-anchor="middle" fill="#1e293b" font-weight="600">scheduler</text>

  <rect x="225" y="132" width="150" height="44" rx="8" fill="#ffffff" stroke="#2563eb"/>
  <text x="300" y="153" text-anchor="middle" fill="#1e293b" font-weight="600">controller-mgr</text>
  <text x="300" y="169" text-anchor="middle" fill="#64748b">reconcile loops</text>

  <rect x="45" y="200" width="330" height="44" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="210" y="222" text-anchor="middle" fill="#1e293b" font-weight="600">cloud-controller-manager (optional)</text>
  <text x="210" y="238" text-anchor="middle" fill="#64748b">LB / volumes / node lifecycle</text>

  <line x1="195" y1="83" x2="225" y2="83" stroke="#475569" marker-end="url(#arw)"/>

  <rect x="480" y="20" width="260" height="180" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="610" y="42" text-anchor="middle" fill="#1e293b" font-weight="700">Worker Node</text>
  <rect x="500" y="56" width="220" height="38" rx="8" fill="#ffffff" stroke="#2563eb"/>
  <text x="610" y="80" text-anchor="middle" fill="#1e293b" font-weight="600">kubelet</text>
  <rect x="500" y="102" width="220" height="38" rx="8" fill="#ffffff" stroke="#2563eb"/>
  <text x="610" y="126" text-anchor="middle" fill="#1e293b" font-weight="600">kube-proxy</text>
  <rect x="500" y="148" width="220" height="38" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="610" y="172" text-anchor="middle" fill="#1e293b" font-weight="600">container runtime (CRI)</text>

  <rect x="500" y="222" width="60" height="40" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="530" y="247" text-anchor="middle" fill="#1e293b">pod</text>
  <rect x="580" y="222" width="60" height="40" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="610" y="247" text-anchor="middle" fill="#1e293b">pod</text>
  <rect x="660" y="222" width="60" height="40" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="690" y="247" text-anchor="middle" fill="#1e293b">pod</text>
  <line x1="610" y1="186" x2="610" y2="222" stroke="#475569" marker-end="url(#arw)"/>

  <line x1="500" y1="75" x2="196" y2="83" stroke="#475569" stroke-dasharray="5 4" marker-end="url(#arw)"/>
  <text x="345" y="52" text-anchor="middle" fill="#64748b">watch / report</text>

  <rect x="45" y="310" width="150" height="40" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="120" y="334" text-anchor="middle" fill="#1e293b" font-weight="600">kubectl / user</text>
  <line x1="120" y1="310" x2="120" y2="107" stroke="#475569" marker-end="url(#arw)"/>

  <text x="380" y="405" text-anchor="middle" fill="#64748b">Hub-and-spoke: every component talks ONLY to the apiserver; only the apiserver touches etcd.</text>
</svg>
```

The **reconciliation loop** each controller runs is conceptually:

```text
for {
    desired := read spec from apiserver (etcd)
    actual  := observe state of the world
    diff    := desired - actual
    if diff != 0 { act(diff) }   // create/delete/update objects
    // wake immediately on watch events, plus a periodic resync
}
```

Because it re-evaluates the *full* desired vs actual state every cycle (level-triggered), a dropped event or a transient failure is simply fixed on the next pass. This is the deep reason Kubernetes is resilient.

## 6. Variations & Trade-offs

| Aspect | Control plane | Worker node |
|--------|---------------|-------------|
| Role | Decide & store | Execute |
| Key components | apiserver, etcd, scheduler, controller-mgr | kubelet, kube-proxy, runtime |
| State on failure | New changes stall; **running pods keep running** | That node's pods rescheduled elsewhere once NotReady |
| Scaling | Odd # etcd members (3/5) for quorum; multiple apiservers behind LB | Add nodes horizontally |
| Managed offering | EKS/GKE/AKS run & hide it for you | You (or an autoscaler) manage the nodes |

Trade-offs to know: a **single control plane** is simple but a SPOF — production runs **3+ stacked or external etcd** members and multiple apiservers. **Managed control planes** (EKS/GKE/AKS) remove the ops burden but cost per-cluster and limit tuning. **kube-proxy iptables mode** is simple but evaluates rules O(n); **IPVS mode** uses kernel hash tables for large clusters. Some setups run **etcd external** to the control-plane nodes to decouple failure domains.

## 7. Production / Performance Notes

- **etcd is the fragile jewel.** It needs low-latency SSD disks and stable networking; watch `etcd_disk_wal_fsync_duration`. Back it up (`etcdctl snapshot save`) — it *is* your cluster.
- **Run control-plane components HA:** 3 or 5 etcd members (quorum survives 1 or 2 failures), multiple apiservers behind a load balancer, and leader-elected scheduler/controller-manager (only one active at a time).
- **The apiserver is the bottleneck at scale.** Chatty controllers, huge objects, and unbounded `LIST` calls hurt it. Use label selectors, watch not poll, and enable API Priority & Fairness.
- **Node failure ≠ workload failure** if you have spare capacity: the node controller marks the node NotReady after the monitor grace period, then pods are evicted and rescheduled elsewhere.
- **Control plane down, data plane up:** existing pods keep running because kubelet and the runtime are local; you just can't make *new* scheduling decisions until the apiserver returns.
- **Version skew:** kubelet may be up to 3 minor versions behind the apiserver, never ahead. Upgrade the control plane first.

## 8. Common Mistakes

1. ⚠️ **Thinking kubectl talks to nodes directly.** It never does — it only calls the apiserver, and the kubelet pulls its work *from* the apiserver. Fix: debug via the API (`get`, `describe`, `logs`), not by SSHing into nodes first.
2. ⚠️ **Not running etcd HA / no backups.** A single etcd on a slow disk is a time bomb. Fix: 3-member SSD etcd + scheduled `snapshot save`.
3. ⚠️ **Assuming the scheduler starts containers.** It only writes a *binding* (pod→node). The **kubelet** starts containers. Fix: "pod stuck Pending" → look at scheduler/events; "stuck ContainerCreating" → look at kubelet/runtime.
4. ⚠️ **Confusing control-plane and data-plane failure.** Panicking that "the cluster is down" when only the apiserver blipped — running workloads were fine. Fix: check whether *serving traffic* or *scheduling changes* is what's broken.
5. ⚠️ **Editing child objects imperatively then wondering why they revert.** A controller owns that object and reconciles it back. Fix: change the *desired state* (the Deployment spec), not the child pod.
6. ⚠️ **Upgrading kubelet ahead of the apiserver.** Violates version skew policy and breaks. Fix: upgrade the control plane first, then nodes.

## 9. Interview Questions

**Q: Name the control-plane components and what each does?**
A: kube-apiserver (authenticates/validates/persists all objects, the single API front door), etcd (consistent key-value store holding all cluster state), kube-scheduler (assigns pods to nodes via filter+score), and kube-controller-manager (runs reconciliation loops for Deployments, nodes, jobs, endpoints, etc.). Optionally cloud-controller-manager for cloud integrations.

**Q: What runs on every worker node?**
A: The kubelet (node agent that starts pods and reports status), kube-proxy (programs Service networking via iptables/IPVS), and a container runtime (containerd/CRI-O) accessed through the CRI.

**Q: What is the reconciliation loop and why does it make Kubernetes self-healing?**
A: A controller continuously observes actual state, compares it to the desired state in etcd, and acts to close the gap, forever. Because it re-evaluates the full state each cycle (level-triggered), any drift — a crashed pod, a missed event — is corrected on the next pass without human intervention.

**Q: Why is the architecture called hub-and-spoke?**
A: Every component communicates only through the apiserver; components never talk to each other directly, and only the apiserver reads/writes etcd. That makes the API the single point for authentication, authorization, validation, and auditing.

**Q: If the control plane goes down, do running pods keep serving traffic?**
A: Yes. Kubelet, kube-proxy, and the runtime are local to each node, so existing pods keep running and serving. You lose the ability to make new scheduling or scaling decisions until the apiserver returns.

**Q: What exactly does the scheduler do — does it start containers?**
A: No. It only selects a node for each Pending pod and writes a binding back to the apiserver. The kubelet on that node then tells the runtime to pull the image and start containers.

**Q: Why does etcd need an odd number of members?**
A: etcd uses Raft, which needs a majority quorum to commit writes. An odd count (3, 5) maximizes fault tolerance per node: 3 members tolerate 1 failure, 5 tolerate 2 — an even count adds a member without improving tolerance.

**Q: (Senior) How would you diagnose a pod stuck in Pending vs stuck in ContainerCreating?**
A: Pending means no node was bound — check the scheduler and pod events (insufficient resources, taints, affinity). ContainerCreating means a node is bound but the kubelet/runtime can't start it — check kubelet logs and events (image pull errors, volume mount, CNI failures).

**Q: (Senior) What is the version skew policy between control plane and nodes?**
A: The kubelet may lag the apiserver by up to 3 minor versions but must never be newer. So you upgrade the control plane first, then the nodes — never the reverse.

**Q: (Senior) How do multiple controller-managers or schedulers avoid conflicting in an HA setup?**
A: Through leader election: each acquires a lease object in the apiserver, and only the current leader is active while the others stand by, preventing duplicate reconciliation.

**Q: (Senior) Why is level-triggered reconciliation more robust than edge-triggered event handling?**
A: Edge-triggered logic acts on discrete events, so a dropped or missed event permanently loses work. Level-triggered logic acts on the current observed state each cycle, making it idempotent and self-correcting after missed events, restarts, or transient failures.

## 10. Practice

- [ ] Run `kubectl -n kube-system get pods` on a kubeadm/minikube cluster and identify apiserver, etcd, scheduler, and controller-manager.
- [ ] `kubectl apply` a 3-replica Deployment, then `kubectl delete` one pod with `-w` watching and observe the controller recreate it.
- [ ] Use `kubectl get events --sort-by=.lastTimestamp` after creating a Deployment and map each event to the component that produced it.
- [ ] Cordon and drain a node (`kubectl cordon` / `drain`) and watch pods reschedule elsewhere — identify which controller reacted.
- [ ] Take an etcd snapshot with `etcdctl snapshot save` (on a test cluster) and describe what restoring it would recover.

## 11. Cheat Sheet

> [!TIP]
> **Kubernetes = declarative desired state + reconciliation loops.**
> **Control plane (brain):** apiserver (front door, only one that touches etcd) · etcd (source of truth, Raft, odd quorum) · scheduler (picks node, writes binding) · controller-manager (runs the loops).
> **Node (muscle):** kubelet (starts pods, reports status) · kube-proxy (Service networking, iptables/IPVS) · runtime (containerd/CRI-O via CRI).
> **Golden rules:** everything talks only to the apiserver · scheduler binds, kubelet runs · control plane down ⇒ running pods still serve · controllers are level-triggered ⇒ self-healing · upgrade control plane before nodes.

**References:** Kubernetes docs "Kubernetes Components" & "Cluster Architecture", etcd documentation, "Kubernetes: Up and Running" (Burns/Beda/Hightower), CNCF kube-proxy modes docs

---
*Kubernetes Handbook — topic 01.*
