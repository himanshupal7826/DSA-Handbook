# 04 · Services

> **In one line:** Stable virtual endpoints load-balancing to pods.

---

## 1. Overview

Pods are ephemeral with changing IPs; a **Service** gives a stable virtual IP/DNS name that load-balances to a set of pods selected by labels. Types: **ClusterIP** (internal), **NodePort** (host port), **LoadBalancer** (cloud LB), plus **Headless** for direct pod discovery.

## 2. Key Concepts

- ClusterIP: stable internal VIP (default).
- NodePort: exposes a port on every node.
- LoadBalancer: provisions an external cloud load balancer.
- Selector matches pod labels to build the endpoint set.
- DNS: service reachable as name.namespace.svc.cluster.local.

## 3. Syntax & Code

```yaml
apiVersion: v1
kind: Service
metadata: {name: web}
spec:
  selector: {app: web}
  ports:
    - {port: 80, targetPort: 8080}
  type: ClusterIP
```

## 4. Worked Example

**Service discovery by DNS**

Other pods reach it by name:

```bash
curl http://web.default.svc.cluster.local/
# or just http://web within the same namespace
```

## 5. Best Practices

- ✅ Use ClusterIP for internal traffic; Ingress/LB for external.
- ✅ Rely on Service DNS, not pod IPs.
- ✅ Keep selectors aligned with pod labels.
- ✅ Use readiness probes so only ready pods get traffic.
- ✅ Prefer Ingress over many LoadBalancers for HTTP.

## 6. Common Pitfalls

1. ⚠️ Selector/label mismatch → empty endpoints (no traffic).
2. ⚠️ Using NodePort for production external access.
3. ⚠️ Confusing port (service) with targetPort (container).
4. ⚠️ Assuming a Service heals pods (it only routes).
5. ⚠️ One LoadBalancer per service getting expensive.
6. ⚠️ Forgetting cross-namespace DNS suffix.

## 7. Interview Questions

1. **Q: Why do we need Services?**
   A: Pods have ephemeral IPs; a Service provides a stable VIP/DNS and load-balances across matching pods.

2. **Q: ClusterIP vs NodePort vs LoadBalancer?**
   A: Internal VIP / a port on each node / an external cloud LB, respectively.

3. **Q: How does a Service find its pods?**
   A: Via a label selector that builds the endpoints list.

4. **Q: port vs targetPort?**
   A: port is the Service's port; targetPort is the container port it forwards to.

5. **Q: What is a headless service?**
   A: clusterIP: None — returns pod IPs directly (for stateful/peer discovery).

6. **Q: How does Service DNS work?**
   A: name.namespace.svc.cluster.local resolves to the ClusterIP.

7. **Q: Service vs Ingress?**
   A: Service does L4 routing; Ingress does L7 HTTP routing/host-path rules.

8. **Q: Why might endpoints be empty?**
   A: No ready pods match the selector, or labels mismatch.

## 8. Practice

- [ ] Expose a Deployment with a ClusterIP service.
- [ ] Reach it via Service DNS from another pod.
- [ ] Diagnose an empty-endpoints selector mismatch.

## 9. Quick Revision

Service = stable VIP/DNS load-balancing to label-selected pods. ClusterIP (internal), NodePort (node port), LoadBalancer (cloud), Headless (direct). Use DNS, align labels, Ingress for HTTP.

**References:** Services

---

*Kubernetes Handbook — topic 04.*
