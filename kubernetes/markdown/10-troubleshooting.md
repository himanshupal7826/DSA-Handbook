# 10 · Observability & Troubleshooting

> **In one line:** Diagnose failing pods with kubectl and probes.

---

## 1. Overview

Troubleshooting Kubernetes is methodical: `kubectl describe` (events), `kubectl logs` (app output), `kubectl get events`, and probes reveal why pods fail. Common states — **CrashLoopBackOff**, **ImagePullBackOff**, **Pending** — each point to a specific class of problem.

## 2. Key Concepts

- describe shows events, conditions, and probe results.
- logs (and --previous) show app output and crash reasons.
- CrashLoopBackOff = container keeps exiting; check logs/command.
- ImagePullBackOff = bad image/registry/credentials.
- Pending = unschedulable (resources/constraints/PVC unbound).

## 3. Syntax & Code

```bash
kubectl describe pod web-abc
kubectl logs web-abc --previous   # last crashed container
kubectl get events --sort-by=.lastTimestamp
kubectl exec -it web-abc -- sh
```

## 4. Worked Example

**Triaging CrashLoopBackOff**

Read logs of the crashed instance and its exit code:

```bash
kubectl logs web-abc --previous
kubectl describe pod web-abc | grep -A5 'Last State'
```

## 5. Best Practices

- ✅ Start with describe (events) then logs.
- ✅ Add liveness/readiness probes for clear health signals.
- ✅ Centralize logs/metrics (Prometheus/Grafana/Loki).
- ✅ Use --previous to inspect crashed containers.
- ✅ Check resource limits when pods are OOMKilled.

## 6. Common Pitfalls

1. ⚠️ Restarting pods blindly without reading events/logs.
2. ⚠️ Liveness probe too aggressive causing restart loops.
3. ⚠️ Ignoring OOMKilled (raise limits or fix leak).
4. ⚠️ Pending pods due to unbound PVCs overlooked.
5. ⚠️ No observability stack in production.
6. ⚠️ Confusing readiness (traffic gating) with liveness (restart).

## 7. Interview Questions

1. **Q: First steps to debug a failing pod?**
   A: kubectl describe (events/conditions) then kubectl logs (and --previous).

2. **Q: What causes CrashLoopBackOff?**
   A: The container repeatedly exits — bad command, missing config, or a crashing app; check logs.

3. **Q: ImagePullBackOff cause?**
   A: Wrong image name/tag, private registry without credentials, or registry unreachable.

4. **Q: Why is a pod Pending?**
   A: No node can schedule it: insufficient resources, constraints, or an unbound PVC.

5. **Q: Liveness vs readiness probe?**
   A: Liveness restarts a dead container; readiness gates traffic until ready.

6. **Q: What is OOMKilled?**
   A: The container exceeded its memory limit and was killed; raise limits or fix the leak.

7. **Q: How to inspect a crashed container's logs?**
   A: kubectl logs <pod> --previous.

8. **Q: Why centralize observability?**
   A: Ephemeral pods lose local logs; aggregation enables search, dashboards, and alerts.

## 8. Practice

- [ ] Diagnose a CrashLoopBackOff via describe + logs --previous.
- [ ] Reproduce ImagePullBackOff and fix the image ref.
- [ ] Resolve a Pending pod caused by resource requests.

## 9. Quick Revision

Debug methodically: describe (events) → logs (--previous) → events/exec. CrashLoopBackOff=app exits, ImagePullBackOff=image/creds, Pending=unschedulable, OOMKilled=memory. Probes + centralized observability.

**References:** Debug pods

---

*Kubernetes Handbook — topic 10.*
