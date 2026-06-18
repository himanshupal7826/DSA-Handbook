# 10 · Logging, Monitoring & Debugging

> **In one line:** Observe and troubleshoot running containers.

---

## 1. Overview

Containers should log to **stdout/stderr** so the platform collects them. Debug with `logs`, `exec`, `inspect`, and `stats`; define **HEALTHCHECK**s so orchestrators know readiness. Centralize logs and metrics for production observability.

## 2. Key Concepts

- Log to stdout/stderr; let the runtime/agent ship logs.
- docker logs/exec/inspect/stats for inspection.
- HEALTHCHECK reports container health to the platform.
- Logging drivers (json-file, journald, fluentd) route logs.
- One concern per container simplifies observability.

## 3. Syntax & Code

```bash
docker logs -f --tail 100 api
docker exec -it api sh         # shell into a running container
docker inspect api            # full config/state JSON
docker stats                  # live CPU/mem/IO
```

## 4. Worked Example

**HEALTHCHECK**

Let the platform detect an unhealthy container:

```dockerfile
HEALTHCHECK --interval=30s --timeout=3s \
  CMD curl -f http://localhost:8000/health || exit 1
```

## 5. Best Practices

- ✅ Write logs to stdout/stderr, not files inside the container.
- ✅ Add HEALTHCHECKs for readiness/liveness.
- ✅ Centralize logs (ELK/Loki) and metrics (Prometheus).
- ✅ Use docker exec for live debugging, not SSH.
- ✅ Set log rotation to avoid disk fill.

## 6. Common Pitfalls

1. ⚠️ Logging to files inside the container (lost on removal).
2. ⚠️ No healthcheck → orchestrator can't detect failures.
3. ⚠️ Unbounded json-file logs filling the disk.
4. ⚠️ Installing SSH instead of using exec.
5. ⚠️ Noisy logs without levels/structure.
6. ⚠️ Debugging distroless images lacking a shell.

## 7. Interview Questions

1. **Q: Where should containers log?**
   A: To stdout/stderr so the runtime and log agents can collect and ship them.

2. **Q: How to debug a running container?**
   A: docker exec into it, inspect config/state, check logs and stats.

3. **Q: What does HEALTHCHECK do?**
   A: Runs a command periodically; the result tells the platform if the container is healthy.

4. **Q: How to prevent logs filling the disk?**
   A: Configure log rotation (max-size/max-file) or a centralized driver.

5. **Q: Why not SSH into containers?**
   A: It adds attack surface and breaks immutability; use exec instead.

6. **Q: How to debug a distroless image?**
   A: Use a debug image variant or an ephemeral debug sidecar/exec with tooling.

7. **Q: docker inspect uses?**
   A: View full configuration, mounts, networks, env, and state as JSON.

8. **Q: What is centralized logging?**
   A: Aggregating container logs into a system (ELK/Loki) for search and alerting.

## 8. Practice

- [ ] Tail and follow a container's logs.
- [ ] Add a HEALTHCHECK and observe status.
- [ ] Use exec + stats to debug a slow container.

## 9. Quick Revision

Log to stdout/stderr, add HEALTHCHECKs, debug via logs/exec/inspect/stats, centralize logs+metrics, rotate logs. Avoid in-container log files and SSH.

**References:** Docker logging

---

*Docker Handbook — topic 10.*
