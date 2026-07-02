# 24 · Observability: Logs, Metrics & Events

> **In one line:** Logs tell you *what happened*, metrics tell you *how much / how often*, and events tell you *what the control plane decided* — together they let you reason about a cluster you cannot see.

---

## 1. Overview

**Observability** is the ability to explain a system's internal state from its external outputs, without shelling into every box. In Kubernetes the outputs come in three shapes — **logs** (append-only text lines from a process), **metrics** (numeric time series like CPU, memory, request rate), and **events** (short-lived records the API server emits when the control plane acts on an object). Master all three and most incidents become a five-minute read instead of an SSH safari.

The problem it solves: pods are ephemeral and get rescheduled, nodes come and go, and a single user request may cross a dozen containers. You cannot "look at the server" — there often isn't one. You need signals that are collected centrally, retained past a pod's death, and queryable across the fleet.

You reach for **logs** first when a specific pod misbehaves (`kubectl logs`), **events** when a pod won't even start (`kubectl get events` / `describe`), and **metrics** when you need trends, capacity, or to drive autoscaling (`metrics-server`, Prometheus). The senior move is knowing which pillar answers the question in front of you.

## 2. Core Concepts

- **Container logs = stdout/stderr.** The kubelet captures a container's stdout/stderr to a file on the node (`/var/log/pods/…`). `kubectl logs` streams that file — it is *not* reading a logging agent. Apps should log to stdout, never to a file inside the container.
- **`kubectl logs` is per-container, per-pod.** Use `-c <container>` for multi-container pods, `-f` to follow, `-p`/`--previous` for the *last crashed* container, `--since=1h` / `--tail=100` to bound output.
- **Node logs vs pod logs.** Pod logs come from your app; **node/system logs** (kubelet, container runtime, kube-proxy) live in `journalctl -u kubelet` on the node or in a systemd/journal collector — invisible to `kubectl logs`.
- **Metrics-server = the resource-metrics API.** A lightweight in-memory aggregator that scrapes the kubelet's Summary API and powers `kubectl top` and the **HPA**. It is *not* a monitoring system — no history, no PromQL, ~1-minute freshness.
- **Prometheus = the metrics platform.** Pull-based scraper with a time-series DB and PromQL. Retains history, alerts (Alertmanager), and graphs (Grafana).
- **kube-state-metrics (KSM).** Exposes *object state* as metrics (`kube_deployment_status_replicas_unavailable`, `kube_pod_status_phase`) by listening to the API server. Complements — does not replace — cAdvisor/node metrics.
- **Events are objects, and they expire.** They live in etcd for ~1 hour (`--event-ttl`) by default. `kubectl get events` / `describe` surface them; for retention you must ship them out.
- **The three pillars.** Logs (text), Metrics (numbers over time), Traces (request causality). Kubernetes ships the first two out of the box; tracing (OpenTelemetry/Jaeger) is added at the app layer.

## 3. Syntax & Examples

```bash
# --- LOGS ---
kubectl logs web-7d9f-abcde                 # current container, whole buffer
kubectl logs web-7d9f-abcde -f              # follow (tail -f)
kubectl logs web-7d9f-abcde -p              # PREVIOUS container (post-crash)
kubectl logs web-7d9f-abcde -c sidecar      # a specific container
kubectl logs -l app=web --tail=50 --prefix  # all pods matching a label
kubectl logs web-7d9f-abcde --since=15m --timestamps
```

```bash
# --- EVENTS ---
kubectl get events --sort-by=.lastTimestamp            # cluster-wide, chronological
kubectl get events --field-selector type=Warning       # only warnings
kubectl describe pod web-7d9f-abcde                     # Events: section at the bottom
kubectl events --for pod/web-7d9f-abcde --watch         # kubectl 1.28+ dedicated verb
```

```bash
# --- METRICS ---
kubectl top nodes                    # needs metrics-server
kubectl top pods -A --sort-by=memory
# raw resource-metrics API:
kubectl get --raw /apis/metrics.k8s.io/v1beta1/nodes | jq
```

```yaml
# A ServiceMonitor tells the Prometheus Operator what to scrape.
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: web
  labels: {release: prometheus}   # matched by the Prometheus selector
spec:
  selector:
    matchLabels: {app: web}
  endpoints:
    - port: metrics                # the Service port NAME exposing /metrics
      interval: 30s
      path: /metrics
```

## 4. Worked Example

A pod is restarting and users see 500s. Walk the three pillars.

```bash
# 1) EVENTS — did the control plane complain? (why it restarts / can't schedule)
kubectl describe pod checkout-6c8b-2xk9 | sed -n '/Events:/,$p'
```

```text
Events:
  Type     Reason     Age                 From     Message
  ----     ------     ----                ----     -------
  Warning  BackOff    2m (x8 over 10m)    kubelet  Back-off restarting failed container
  Normal   Pulled     10m                 kubelet  Container image "checkout:1.4" already present
```

```bash
# 2) LOGS — what did the app say just before it died? (-p = the crashed instance)
kubectl logs checkout-6c8b-2xk9 -p --tail=20
```

```text
2026-07-02T09:14:02Z INFO  connecting to postgres:5432
2026-07-02T09:14:32Z FATAL dial tcp 10.0.4.11:5432: i/o timeout
panic: cannot reach database
```

```bash
# 3) METRICS — is it a resource problem or just a bad dependency?
kubectl top pod checkout-6c8b-2xk9
```

```text
NAME                  CPU(cores)   MEMORY(bytes)
checkout-6c8b-2xk9    3m           28Mi
```

**Verdict:** Not OOM, not CPU — memory is tiny. The event says CrashLoop, the log says the DB is unreachable. Root cause is a **NetworkPolicy or Service** blocking `postgres:5432`, not the checkout app. Three commands, one conclusion.

## 5. Under the Hood

`kubectl logs` never touches your logging stack — it asks the **API server**, which proxies to the **kubelet** on the pod's node, which reads the container's log file that the **container runtime** (containerd/CRI-O) writes. Metrics take a parallel path: **cAdvisor** (inside the kubelet) measures container CPU/memory, the kubelet exposes a Summary API, and **metrics-server** scrapes it for `kubectl top`/HPA — while **Prometheus** independently scrapes `/metrics` endpoints on pods, cAdvisor, and kube-state-metrics.

```svg
<svg viewBox="0 0 760 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ar" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="380" y="22" text-anchor="middle" fill="#1e293b" font-weight="700">Three pillars: where each signal is born and collected</text>

  <!-- Node box -->
  <rect x="20" y="45" width="330" height="220" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="185" y="66" text-anchor="middle" fill="#1e293b" font-weight="600">Worker Node</text>

  <rect x="40" y="80" width="130" height="50" rx="8" fill="#ffffff" stroke="#475569"/>
  <text x="105" y="100" text-anchor="middle" fill="#1e293b">App container</text>
  <text x="105" y="118" text-anchor="middle" fill="#64748b" font-size="11">stdout/stderr + /metrics</text>

  <rect x="200" y="80" width="130" height="50" rx="8" fill="#ffffff" stroke="#475569"/>
  <text x="265" y="100" text-anchor="middle" fill="#1e293b">Runtime</text>
  <text x="265" y="118" text-anchor="middle" fill="#64748b" font-size="11">writes log files</text>

  <rect x="40" y="160" width="290" height="80" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="185" y="182" text-anchor="middle" fill="#1e293b" font-weight="600">kubelet</text>
  <text x="185" y="202" text-anchor="middle" fill="#64748b" font-size="11">reads log files · cAdvisor (CPU/mem)</text>
  <text x="185" y="220" text-anchor="middle" fill="#64748b" font-size="11">Summary API</text>

  <line x1="105" y1="130" x2="105" y2="160" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="265" y1="130" x2="265" y2="160" stroke="#475569" marker-end="url(#ar)"/>

  <!-- Control plane / collectors -->
  <rect x="430" y="55" width="300" height="70" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="580" y="80" text-anchor="middle" fill="#1e293b" font-weight="600">API server</text>
  <text x="580" y="100" text-anchor="middle" fill="#64748b" font-size="11">kubectl logs / events / top proxy here</text>

  <rect x="430" y="150" width="140" height="60" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="500" y="174" text-anchor="middle" fill="#1e293b" font-weight="600">metrics-server</text>
  <text x="500" y="192" text-anchor="middle" fill="#64748b" font-size="11">top · HPA</text>

  <rect x="590" y="150" width="140" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="660" y="174" text-anchor="middle" fill="#1e293b" font-weight="600">Prometheus</text>
  <text x="660" y="192" text-anchor="middle" fill="#64748b" font-size="11">PromQL · history</text>

  <rect x="430" y="235" width="300" height="55" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="580" y="258" text-anchor="middle" fill="#1e293b" font-weight="600">kube-state-metrics</text>
  <text x="580" y="276" text-anchor="middle" fill="#64748b" font-size="11">object state from API server (replicas, phase)</text>

  <line x1="330" y1="115" x2="430" y2="90" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="330" y1="200" x2="430" y2="180" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="335" y1="180" x2="590" y2="180" stroke="#475569" stroke-dasharray="4 3" marker-end="url(#ar)"/>
  <line x1="580" y1="235" x2="640" y2="210" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="660" y1="150" x2="620" y2="125" stroke="#475569" marker-end="url(#ar)"/>

  <text x="580" y="330" text-anchor="middle" fill="#64748b" font-size="11">Grafana / Alertmanager sit on top of Prometheus · Loki/ELK sit on top of node log files</text>
</svg>
```

## 6. Variations & Trade-offs

| Signal | Tool | Retention | Query | Best for |
|---|---|---|---|---|
| Logs | `kubectl logs` | Until pod dies / rotation | grep-only | Live debugging one pod |
| Logs (aggregated) | Loki / ELK / Fluent Bit | Days–months | LogQL / Lucene | Post-mortem, cross-pod search |
| Metrics (resource) | metrics-server | ~1 min, no history | `kubectl top` | Autoscaling, quick capacity |
| Metrics (platform) | Prometheus + KSM | Weeks+ | PromQL | Dashboards, alerts, SLOs |
| Events | `kubectl get events` | ~1 h (etcd TTL) | field-selector | Scheduling / lifecycle "why" |
| Traces | OpenTelemetry + Jaeger | Days | span search | Cross-service latency |

`kubectl logs` is instant but blind once a pod is gone — you *need* a log aggregator (Fluent Bit → Loki/ELK) for anything past the current instance. metrics-server is cheap and mandatory for HPA but useless for "what did CPU do last Tuesday" — that's Prometheus. Events are the cheapest debugging signal in existence but silently expire, so ship them (e.g. `kubectl-events-exporter`) if incidents get post-mortemed.

## 7. Production / Performance Notes

- **Never log to a file inside the container.** Write to stdout/stderr so the platform can collect and rotate it. A file inside the container dies with the pod and fills the ephemeral disk.
- **Log rotation is the kubelet's job:** `containerLogMaxSize` (default 10Mi) and `containerLogMaxFiles`. A chatty pod that logs faster than rotation can evict itself on disk pressure.
- **metrics-server needs `--kubelet-insecure-tls`** or proper certs on many clusters, and it is a hard dependency for HPA — if `kubectl top` errors, your HPA is flying blind and won't scale.
- **kube-state-metrics is high-cardinality.** Every pod/label becomes a series. In a 10k-pod cluster KSM + cAdvisor can be your biggest Prometheus load; drop unused metrics with relabeling.
- **Structured (JSON) logs** turn grep into queryable fields in Loki/ELK. Add `pod`, `namespace`, `trace_id` — the aggregator injects the first two, your app injects the last.
- **Alert on the golden signals** (latency, traffic, errors, saturation) via Prometheus, not on raw CPU. CPU high is not an incident; error rate high is.
- **Don't retain events in etcd** by cranking `--event-ttl` — you'll bloat etcd. Export events to your log store instead.

## 8. Common Mistakes

1. ⚠️ **`kubectl logs` on a CrashLooping pod shows nothing useful** — you're reading the *new* container. Fix: add `-p`/`--previous` to see the instance that actually crashed.
2. ⚠️ **App logs to a file, then "logs are empty."** Fix: reconfigure the app to log to stdout/stderr (or symlink the file to `/dev/stdout`).
3. ⚠️ **Assuming metrics-server keeps history.** It's in-memory and ~1 min. Fix: use Prometheus for any trend or dashboard.
4. ⚠️ **HPA stuck at "unknown" targets.** Root cause is almost always a broken/absent metrics-server. Fix: `kubectl top nodes` to confirm it works first.
5. ⚠️ **Ignoring the Events section of `describe`.** Pending/ImagePull/FailedScheduling reasons are *right there*. Fix: read Events before reading logs for start-up failures.
6. ⚠️ **Events "disappeared."** They expired after ~1h. Fix: don't rely on live events for post-mortems; ship them out.
7. ⚠️ **Confusing kube-state-metrics with metrics-server.** KSM = object *state*, metrics-server = resource *usage*. Fix: install both; they answer different questions.
8. ⚠️ **`kubectl logs` on a multi-container pod picks the wrong container.** Fix: always pass `-c <container>` for sidecars/init containers.

## 9. Interview Questions

**Q: What are the three pillars of observability and which does Kubernetes provide natively?**
A: Logs, metrics, and traces. Kubernetes natively surfaces logs (`kubectl logs` via kubelet) and resource metrics (metrics-server/cAdvisor); tracing is added at the application layer with OpenTelemetry/Jaeger.

**Q: Where does `kubectl logs` actually read from?**
A: The API server proxies to the kubelet on the pod's node, which reads the container's stdout/stderr log file written by the container runtime. It is not reading a logging agent or central store.

**Q: A pod is in CrashLoopBackOff and `kubectl logs` shows a healthy startup. Why, and what do you do?**
A: You're viewing the freshly restarted container, not the one that crashed. Use `kubectl logs <pod> -p` (`--previous`) to see the crashed instance's final output.

**Q: What is metrics-server and what depends on it?**
A: A lightweight aggregator that scrapes kubelet Summary APIs and serves the resource-metrics API. It powers `kubectl top` and the Horizontal Pod Autoscaler. It keeps no history.

**Q: metrics-server vs Prometheus — when do you use each?**
A: metrics-server for live resource usage and autoscaling (cheap, ~1 min, no history); Prometheus for historical metrics, PromQL queries, dashboards, and alerting.

**Q: What does kube-state-metrics add that cAdvisor/metrics-server don't?**
A: Object-level state from the API server — desired vs available replicas, pod phase, job status, PVC state — as opposed to resource usage (CPU/memory) from cAdvisor.

**Q: Why do Kubernetes events sometimes vanish, and how do you keep them?**
A: Events are stored in etcd with a TTL (~1 hour by default) so they don't bloat the store. Ship them to a log aggregator with an events exporter for retention.

**Q: Why should applications log to stdout instead of a file?**
A: The kubelet/runtime capture stdout/stderr for `kubectl logs` and log collectors, and handle rotation. A file inside the container is invisible to the platform and dies with the pod.

**Q: (Senior) How would you design log collection for a 500-node cluster?**
A: A per-node DaemonSet agent (Fluent Bit/Vector) tails `/var/log/pods`, enriches with pod/namespace metadata from the kubelet, and ships to a store (Loki/Elasticsearch/S3). Use structured JSON, sampling for chatty debug logs, and backpressure handling.

**Q: (Senior) Your HPA isn't scaling under obvious load. Walk the diagnosis.**
A: Confirm metrics-server works (`kubectl top pods`); check the HPA's `TARGETS` column for `<unknown>`; verify the pods declare CPU/memory `requests` (HPA computes utilization against requests); inspect `kubectl describe hpa` events for metric-fetch errors.

**Q: (Senior) How do you correlate a log line, a metric spike, and an event during an incident?**
A: Timestamps plus shared labels (namespace/pod) and a trace/request ID. Grafana can overlay Prometheus metrics with Loki logs by label; events exported to the same store let you pivot from "spike at 09:14" to the log line and the scheduling event at that instant.

## 10. Practice

- [ ] Crash a pod on purpose (bad command) and retrieve its dying output with `kubectl logs -p`.
- [ ] Install metrics-server and confirm `kubectl top nodes` and `kubectl top pods` return data.
- [ ] Use `kubectl get events --sort-by=.lastTimestamp --field-selector type=Warning` to list only warnings.
- [ ] Deploy kube-state-metrics and query `kube_deployment_status_replicas_unavailable` in Prometheus.
- [ ] Follow logs from all pods of a Deployment at once with `kubectl logs -l app=<name> -f --prefix`.

## 11. Cheat Sheet

> [!TIP]
> **Logs** = `kubectl logs [-f] [-p] [-c ctr] [--since] [--tail]` → app stdout/stderr via kubelet. Always `-p` for a crashed pod, `-c` for multi-container.
> **Events** = `kubectl describe pod` / `kubectl get events --sort-by=.lastTimestamp` → control-plane "why", expire in ~1h.
> **Metrics** = `kubectl top` (metrics-server, live, powers HPA) vs Prometheus + kube-state-metrics (history, PromQL, alerts).
> Rule of thumb: won't start → **events**; misbehaving → **logs**; capacity/trends/scaling → **metrics**. Log to stdout, alert on golden signals, ship logs+events off-cluster for post-mortems.

**References:** Kubernetes docs — Logging Architecture; Resource Metrics Pipeline (metrics-server); Prometheus & kube-state-metrics docs; Google SRE Book — Monitoring Distributed Systems

---
*Kubernetes Handbook — topic 24.*
