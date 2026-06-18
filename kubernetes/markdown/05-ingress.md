# 05 · Ingress & Gateway

> **In one line:** L7 HTTP routing by host/path with TLS termination.

---

## 1. Overview

An **Ingress** exposes HTTP(S) routes from outside the cluster to Services, based on **host** and **path**, with **TLS** termination — all behind one external IP. It requires an **Ingress controller** (nginx, Traefik, cloud) to do the actual routing.

## 2. Key Concepts

- Ingress = rules; an Ingress controller enforces them.
- Route by host (api.example.com) and path (/v1).
- TLS termination via referenced secrets.
- One entry point for many services (cheaper than many LBs).
- The Gateway API is the newer, more expressive successor.

## 3. Syntax & Code

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: {name: web}
spec:
  tls: [{hosts: [app.example.com], secretName: app-tls}]
  rules:
    - host: app.example.com
      http:
        paths:
          - {path: /, pathType: Prefix, backend: {service: {name: web, port: {number: 80}}}}
```

## 4. Worked Example

**Path-based routing**

Send /api to one service, / to another:

```yaml
paths:
  - {path: /api, pathType: Prefix, backend: {service: {name: api, port: {number: 80}}}}
  - {path: /,    pathType: Prefix, backend: {service: {name: web, port: {number: 80}}}}
```

## 5. Best Practices

- ✅ Install an Ingress controller before creating Ingress objects.
- ✅ Consolidate services behind one Ingress to save LBs.
- ✅ Terminate TLS at Ingress with managed certs (cert-manager).
- ✅ Use clear host/path rules; mind pathType.
- ✅ Consider the Gateway API for advanced routing.

## 6. Common Pitfalls

1. ⚠️ Creating Ingress with no controller installed (nothing happens).
2. ⚠️ pathType confusion (Prefix vs Exact).
3. ⚠️ Missing/expired TLS secrets.
4. ⚠️ Annotations differing per controller (portability).
5. ⚠️ Routing conflicts/overlaps between rules.
6. ⚠️ Assuming Ingress does L4/TCP (it's HTTP-focused).

## 7. Interview Questions

1. **Q: What is an Ingress?**
   A: An L7 routing object mapping host/path HTTP traffic to Services, with TLS, behind one entry point.

2. **Q: Ingress vs Service LoadBalancer?**
   A: Ingress does HTTP host/path routing for many services through one LB; per-service LBs are L4 and costlier.

3. **Q: Why is an Ingress controller required?**
   A: The Ingress object is just rules; a controller (nginx/Traefik/cloud) implements them.

4. **Q: How is TLS handled?**
   A: Terminated at the Ingress using a referenced TLS secret (often via cert-manager).

5. **Q: pathType options?**
   A: Prefix, Exact, ImplementationSpecific — control how paths match.

6. **Q: What is the Gateway API?**
   A: A newer, role-oriented, more expressive successor to Ingress.

7. **Q: Can Ingress route TCP/UDP?**
   A: Not natively; it's HTTP(S) — use Service/LB or controller-specific extensions.

8. **Q: Why consolidate behind Ingress?**
   A: Fewer external load balancers and centralized TLS/routing.

## 8. Practice

- [ ] Deploy an nginx Ingress controller and an Ingress.
- [ ] Add host + path routing for two services.
- [ ] Terminate TLS with a secret/cert-manager.

## 9. Quick Revision

Ingress = L7 HTTP routing (host/path) + TLS behind one entry, enforced by a controller. Consolidates services, terminates TLS; mind pathType and controller annotations; Gateway API is its successor.

**References:** Ingress

---

*Kubernetes Handbook — topic 05.*
