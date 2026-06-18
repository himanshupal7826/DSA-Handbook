# 01 · Kubernetes Architecture

> **In one line:** Control plane + worker nodes reconciling desired state.

---

## 1. Overview

Kubernetes is a **declarative** container orchestrator. You submit desired state to the **API server**; controllers continuously **reconcile** actual toward desired. The **control plane** (API server, etcd, scheduler, controller-manager) decides; **worker nodes** (kubelet, kube-proxy, runtime) execute.

## 2. Key Concepts

- API server is the single front door; state stored in etcd.
- Scheduler assigns pods to nodes by resources/constraints.
- Controllers reconcile desired vs actual state in a loop.
- kubelet runs pods on each node; kube-proxy handles service routing.
- Everything is a declarative API object.

## 3. Syntax & Code

```bash
kubectl get nodes
kubectl get pods -A          # all namespaces
kubectl cluster-info
```

## 4. Worked Example

**Reconciliation loop**

Declare 3 replicas; if one dies, a controller recreates it to match desired state.

```bash
kubectl scale deployment web --replicas=3
kubectl get deploy web -w      # watch it converge
```

## 5. Best Practices

- ✅ Think declaratively: describe desired state, let controllers converge.
- ✅ Keep manifests in version control (GitOps).
- ✅ Use namespaces to isolate environments/teams.
- ✅ Don't write to etcd directly — go through the API.
- ✅ Label everything for selection and ops.

## 6. Common Pitfalls

1. ⚠️ Treating kubectl as imperative scripting in prod.
2. ⚠️ Editing live objects instead of updating manifests.
3. ⚠️ Ignoring the difference between desired and observed state.
4. ⚠️ Single control-plane node (no HA).
5. ⚠️ Storing secrets unencrypted in etcd.
6. ⚠️ Confusing nodes (machines) with pods (workloads).

## 7. Interview Questions

1. **Q: What does the control plane do?**
   A: Stores desired state (etcd via API server) and reconciles it: scheduling and controllers drive actual toward desired.

2. **Q: What is reconciliation?**
   A: Controllers continuously compare desired vs actual state and act to close the gap.

3. **Q: Role of the scheduler?**
   A: Places pending pods onto suitable nodes based on resources, affinity, taints.

4. **Q: kubelet vs kube-proxy?**
   A: kubelet runs/monitors pods on a node; kube-proxy programs service networking rules.

5. **Q: Why is etcd critical?**
   A: It's the cluster's source of truth (all state); back it up and secure it.

6. **Q: Imperative vs declarative?**
   A: Declarative manifests describe end state and are reconciled; imperative commands take direct actions.

7. **Q: What is a namespace?**
   A: A virtual cluster scope for isolating and organizing objects.

8. **Q: Node vs pod?**
   A: A node is a worker machine; a pod is the smallest deployable unit running containers.

## 8. Practice

- [ ] List nodes and pods across namespaces.
- [ ] Scale a deployment and watch reconciliation.
- [ ] Explain the path of a kubectl apply request.

## 9. Quick Revision

K8s = declarative orchestrator. Control plane (API/etcd/scheduler/controllers) reconciles desired state; nodes (kubelet/kube-proxy/runtime) execute. Manifests in git, label everything, secure etcd.

**References:** K8s components

---

*Kubernetes Handbook — topic 01.*
