# 16 · Logging & Log Drivers

> **In one line:** Apps log to stdout/stderr; Docker's logging driver decides where those streams go — and if you don't manage it, the default fills your disk.

---

## 1. Overview

In the container world, an application **does not manage its own log files**. It writes plain text to **stdout** and **stderr** and treats logs as an event stream, exactly as 12-factor prescribes. The container runtime captures those two streams and hands them to a **logging driver**, which decides the destination: a local JSON file, the systemd journal, a Fluentd collector, CloudWatch, and so on. This decoupling means the same image logs correctly whether it runs on a laptop, a CI runner, or a fleet of nodes shipping to a central store.

The catch: Docker's default driver, **`json-file`**, writes to disk on the host and — unless you configure rotation — grows **without bound**. The single most common Docker production incident is a node whose root filesystem fills up with `*-json.log` files from a chatty container. Understanding the driver model and setting rotation is not optional; it's baseline operational hygiene.

You reach for this topic whenever you deploy containers you can't babysit: to pick the right driver for your platform, cap disk usage, and get logs into a system where you can actually search them.

## 2. Core Concepts

- **stdout/stderr philosophy** — the app writes to the two standard streams and nothing else; the platform owns collection, storage, and routing. No log files *inside* the container.
- **Logging driver** — a pluggable sink configured per-container (`--log-driver`) or host-wide (`daemon.json`). It receives every line the container emits.
- **`json-file` (default)** — writes newline-delimited JSON (`{"log":...,"stream":"stdout","time":...}`) to `/var/lib/docker/containers/<id>/<id>-json.log`. What `docker logs` reads.
- **Log rotation (`max-size` / `max-file`)** — caps each log file's size and the number of rotated files kept. **Off by default** — you must set it.
- **`local` driver** — a more efficient default-rotating binary format; still readable by `docker logs`, but not the raw-JSON you can `tail`. Recommended when you don't ship logs off-host.
- **`journald`** — sends logs to the systemd journal; query with `journalctl` and correlate with host logs.
- **`fluentd`** — forwards to a Fluentd/Fluent Bit collector over the network for aggregation and routing to Elasticsearch/Loki/S3.
- **`awslogs` / `gcplogs` / `splunk`** — ship directly to a cloud log service (CloudWatch Logs, Cloud Logging, Splunk).
- **Blocking vs non-blocking mode** — `--log-opt mode=non-blocking` with a `max-buffer-size` prevents a slow log backend from stalling the application; the trade-off is dropped logs under overload.
- **`docker logs` limitation** — only works with `json-file`, `local`, and `journald`. Under `fluentd`/`awslogs` it returns an error, because Docker no longer holds the logs.

## 3. Syntax & Examples

Cap the default driver so it can't fill the disk (per container):

```bash
docker run \
  --log-driver json-file \
  --log-opt max-size=10m \
  --log-opt max-file=3 \
  nginx
# keeps at most 3 files x 10MB = 30MB per container
```

Set it once for the whole daemon — `/etc/docker/daemon.json`:

```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
```

Ship to Fluentd, non-blocking so a slow collector can't stall the app:

```bash
docker run \
  --log-driver fluentd \
  --log-opt fluentd-address=logs.internal:24224 \
  --log-opt mode=non-blocking \
  --log-opt max-buffer-size=4m \
  --log-opt tag="app.{{.Name}}" \
  myapp
```

Compose:

```yaml
services:
  api:
    image: myorg/api:1.4
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

Reading and inspecting:

```bash
docker logs -f --tail 100 --timestamps api   # only json-file/local/journald
docker inspect -f '{{.HostConfig.LogConfig.Type}}' api
```

## 4. Worked Example

Show the unbounded-default problem and then fix it with rotation.

First, a chatty container on the **default** (unrotated) driver:

```bash
docker run -d --name chatty alpine \
  sh -c 'i=0; while true; do echo "line $i $(head -c 200 /dev/zero | tr "\0" x)"; i=$((i+1)); done'
```

After a few minutes, inspect the on-disk log — it just keeps growing:

```text
$ docker inspect -f '{{.LogPath}}' chatty
/var/lib/docker/containers/8a3f.../8a3f...-json.log

$ ls -lh /var/lib/docker/containers/8a3f.../*-json.log
-rw-r----- 1 root root  1.9G  ...  8a3f...-json.log      <- one file, no cap, still growing
```

That single file will consume the host disk until Docker and everything else on the node fails. Now the **rotated** version:

```bash
docker run -d --name chatty2 \
  --log-opt max-size=5m --log-opt max-file=3 alpine \
  sh -c 'i=0; while true; do echo "line $i"; i=$((i+1)); done'
```

```text
$ ls -lh /var/lib/docker/containers/<id>/*-json.log*
-rw-r----- 1 root root 5.0M  ...  <id>-json.log        <- active
-rw-r----- 1 root root 5.0M  ...  <id>-json.log.1      <- rotated
-rw-r----- 1 root root 5.0M  ...  <id>-json.log.2      <- rotated (oldest, next to be dropped)
```

Bounded at 15 MB total, forever. Note the trade-off: rotation **discards** old lines, so anything you need long-term must be shipped off-host (Fluentd/CloudWatch) *before* it rotates away.

## 5. Under the Hood

The application never knows a logging driver exists. Its PID 1 writes bytes to file descriptors 1 (stdout) and 2 (stderr). The container runtime (`containerd`/`runc` via the shim) captures those fds and pipes each line, tagged with a stream name and timestamp, into whatever driver the daemon configured. The driver is the only thing that touches a destination.

```svg
<svg viewBox="0 0 760 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a3" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="380" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">App → streams → driver → destination</text>

  <!-- app -->
  <rect x="24" y="120" width="150" height="80" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="99" y="150" text-anchor="middle" fill="#1e293b" font-weight="700">App (PID 1)</text>
  <text x="99" y="172" text-anchor="middle" fill="#64748b" font-size="11">fd1 stdout</text>
  <text x="99" y="188" text-anchor="middle" fill="#64748b" font-size="11">fd2 stderr</text>

  <line x1="174" y1="160" x2="242" y2="160" stroke="#475569" stroke-width="1.5" marker-end="url(#a3)"/>

  <!-- runtime/driver -->
  <rect x="246" y="110" width="180" height="100" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="336" y="138" text-anchor="middle" fill="#1e293b" font-weight="700">runtime + driver</text>
  <text x="336" y="160" text-anchor="middle" fill="#64748b" font-size="11">captures fds, tags</text>
  <text x="336" y="176" text-anchor="middle" fill="#64748b" font-size="11">stream + timestamp</text>
  <text x="336" y="196" text-anchor="middle" fill="#64748b" font-size="11">routes to sink</text>

  <!-- destinations -->
  <line x1="426" y1="140" x2="500" y2="90" stroke="#475569" stroke-width="1.5" marker-end="url(#a3)"/>
  <line x1="426" y1="160" x2="500" y2="160" stroke="#475569" stroke-width="1.5" marker-end="url(#a3)"/>
  <line x1="426" y1="180" x2="500" y2="235" stroke="#475569" stroke-width="1.5" marker-end="url(#a3)"/>

  <rect x="504" y="60" width="230" height="58" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="619" y="84" text-anchor="middle" fill="#1e293b" font-weight="700">json-file / local (host disk)</text>
  <text x="619" y="104" text-anchor="middle" fill="#b91c1c" font-size="11">unbounded unless max-size/max-file!</text>

  <rect x="504" y="132" width="230" height="52" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="619" y="154" text-anchor="middle" fill="#1e293b" font-weight="700">journald</text>
  <text x="619" y="172" text-anchor="middle" fill="#64748b" font-size="11">journalctl on the host</text>

  <rect x="504" y="200" width="230" height="58" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="619" y="224" text-anchor="middle" fill="#1e293b" font-weight="700">fluentd / awslogs / splunk</text>
  <text x="619" y="244" text-anchor="middle" fill="#64748b" font-size="11">network → central store</text>

  <text x="336" y="250" text-anchor="middle" fill="#64748b" font-size="11">`docker logs` works only for</text>
  <text x="336" y="266" text-anchor="middle" fill="#64748b" font-size="11">json-file / local / journald</text>
</svg>
```

Rotation is handled by the `json-file`/`local` driver itself: when the active file reaches `max-size`, it's renamed with a numeric suffix and a fresh file starts; once `max-file` files exist, the oldest is deleted. With network drivers there's no local file at all — which is exactly why `docker logs` can't read them and why you must not rely on the host for retention.

## 6. Variations & Trade-offs

| Driver | Destination | `docker logs`? | Rotates? | Best for |
|---|---|---|---|---|
| `json-file` (default) | Host JSON file | ✅ | Only if configured | Dev, simple hosts (set max-size!) |
| `local` | Host binary file | ✅ | **Yes, by default** | Single-host prod without shipping |
| `journald` | systemd journal | ✅ | Journal-managed | Hosts already centred on journald |
| `fluentd` | Fluentd/Fluent Bit | ❌ | N/A (remote) | Aggregation, flexible routing |
| `awslogs` | CloudWatch Logs | ❌ | N/A (remote) | AWS/ECS workloads |
| `splunk` | Splunk HEC | ❌ | N/A (remote) | Splunk shops |
| `none` | discarded | ❌ | — | Noisy sidecars you don't need |

**`json-file` vs `local`:** both stay on the host, but `local` uses a compact binary format, is more efficient, and **rotates by default (100 MB total)** — so it's the safer local choice. `json-file` is the historical default and the raw JSON is convenient to `tail`/`jq`, at the cost of size and the manual-rotation footgun.

**Local file vs network driver:** local drivers keep `docker logs` working and survive network outages, but retention is limited and logs are stranded per-host. Network drivers centralise and enable search/alerting, but add a dependency — if the collector is down and you're in **blocking** mode, the app can stall; in **non-blocking** mode you drop logs instead. Most production setups: `local`/`json-file` with tight rotation **plus** a node-level agent (Fluent Bit/Vector) tailing the files and shipping centrally — decoupling the app from the log backend entirely.

## 7. Production / Performance Notes

- **Set rotation everywhere.** Configure `max-size`/`max-file` in `daemon.json` so every container inherits a cap. A single unrotated chatty container is a guaranteed disk-full outage.
- **Prefer a node agent over per-container network drivers.** Running `json-file`/`local` + a DaemonSet agent (Fluent Bit, Vector, Filebeat) decouples the app from the log backend: a collector outage costs nothing at the container, and `docker logs` still works locally.
- **Watch the blocking trap.** The default delivery mode for some drivers is **blocking** — if the backend can't keep up, writes to stdout block and your application stalls. Use `mode=non-blocking` with a sized buffer for latency-sensitive services, accepting possible drops under overload.
- **Log structured (JSON) from the app.** One line per event, machine-parseable, with a level field. It survives every driver unchanged and makes downstream querying trivial. Avoid multi-line stack traces without a parser config, which fragment into many "log lines."
- **Mind cardinality and volume.** Debug-level logging in prod multiplies volume and cost (CloudWatch/Splunk bill per GB ingested). Log at info, sample high-volume paths, and never log secrets or PII.
- **Rotation loses data.** Anything under rotation is eventually deleted; treat local files as a short buffer, not the system of record. Retention lives in the central store.

## 8. Common Mistakes

1. ⚠️ **Leaving `json-file` unrotated.** Fills the host disk and takes down the node. Fix: set `max-size`/`max-file` in `daemon.json`.
2. ⚠️ **Writing logs to a file inside the container.** Lost on removal, invisible to `docker logs`, bloats the writable layer. Fix: log to stdout/stderr.
3. ⚠️ **Expecting `docker logs` to work with `fluentd`/`awslogs`.** It errors — Docker doesn't hold the logs. Fix: read from the central store, or use a local driver alongside.
4. ⚠️ **Using a network driver in blocking mode for a latency-critical app.** A slow collector stalls the app. Fix: `mode=non-blocking` with `max-buffer-size`.
5. ⚠️ **Enabling debug logging in production.** Balloons volume and ingestion cost. Fix: info level with sampling for hot paths.
6. ⚠️ **Logging secrets, tokens, or PII.** They land in searchable, widely-accessible stores. Fix: redact by allowlist before emitting.
7. ⚠️ **Assuming rotation retains history.** Rotated files are deleted. Fix: ship to a central store for anything you must keep.
8. ⚠️ **Multi-line stack traces with no parser.** Each line becomes a separate event, breaking correlation. Fix: emit structured JSON or configure a multiline parser in the collector.

## 9. Interview Questions

**Q: Where should a containerised application write its logs, and why?**
A: To **stdout/stderr** as an unbuffered event stream, never to files inside the container. The runtime captures those streams and a logging driver routes them, so the same image works across environments and the platform owns storage, rotation, and shipping — matching the 12-factor "logs" factor.

**Q: What is Docker's default logging driver and what's its main operational risk?**
A: `json-file`, which writes newline-delimited JSON to a file on the host under `/var/lib/docker/containers/...`. Its main risk is that it does **not rotate by default**, so a chatty container grows the file until the host disk fills — a very common Docker outage.

**Q: How do you cap Docker's log disk usage?**
A: Set `max-size` (per-file cap) and `max-file` (number of rotated files) — as `--log-opt` flags, in a Compose `logging.options` block, or host-wide in `/etc/docker/daemon.json`. Total usage ≈ `max-size × max-file` per container. Or use the `local` driver, which rotates by default.

**Q: Why does `docker logs` fail for some drivers?**
A: `docker logs` reads from the local store Docker itself maintains, which only exists for `json-file`, `local`, and `journald`. With remote drivers (`fluentd`, `awslogs`, `splunk`) Docker forwards the stream without keeping a local copy, so there's nothing for `docker logs` to read — you query the central store instead.

**Q: What's the difference between the `json-file` and `local` drivers?**
A: Both store logs on the host, but `local` uses a compact **binary** format, is more efficient, and **rotates by default** (~100 MB). `json-file` writes human-/`jq`-readable JSON and requires you to configure rotation manually. For single-host production without external shipping, `local` is the safer choice.

**Q: What is blocking vs non-blocking log delivery, and when does it matter?**
A: In **blocking** mode Docker waits for the driver to accept each line, so a slow/unreachable backend can stall the application's writes to stdout. **Non-blocking** buffers up to `max-buffer-size` and drops logs if the buffer fills, protecting app latency at the cost of possible loss. It matters for latency-sensitive services using network drivers.

**Q: (Senior) Design a logging pipeline for a 200-node cluster. What runs where?**
A: Apps log JSON to stdout. Each node uses `local`/`json-file` with tight rotation (short local buffer + working `docker logs`). A node-level agent DaemonSet (Fluent Bit/Vector) tails those files, enriches with metadata (node, container, labels), and ships to a central store (Elasticsearch/Loki/OpenSearch) with backpressure and retries. This decouples the app from the backend, survives collector outages locally, and centralises search/alerting/retention.

**Q: (Senior) Why prefer a node-level log agent over Docker's `fluentd` driver directly?**
A: The driver couples every container to the collector's availability and delivery mode (blocking risk), and loses `docker logs`. A node agent reads the local files instead, so the app never blocks on the backend, `docker logs` still works, the agent adds buffering/retry/enrichment, and you can change destinations without touching container configs.

**Q: (Senior) A node's root disk hit 100% and Docker started failing. Logs were the cause. What happened and how do you prevent recurrence?**
A: An unrotated `json-file` from a chatty container grew until `/var/lib/docker` filled the filesystem. Immediate fix: truncate/rotate the offending `*-json.log`, restart affected services. Prevention: set `max-size`/`max-file` globally in `daemon.json` (or switch to `local`), put `/var/lib/docker` on its own volume, and monitor disk with alerts before it's critical.

**Q: (Senior) What are the cost and security considerations of centralised logging?**
A: Cost scales with **ingested volume** (CloudWatch/Splunk bill per GB), so avoid debug-in-prod, sample hot paths, and set retention. Security: logs must never contain secrets/PII/tokens — redact by allowlist at the source; central stores are broadly readable and long-lived, so a leaked credential in a log is a real exposure requiring rotation.

## 10. Practice

- [ ] Run a chatty container on the default driver, find its file via `docker inspect -f '{{.LogPath}}'`, and watch it grow with no cap.
- [ ] Re-run the same workload with `--log-opt max-size=1m --log-opt max-file=3` and confirm total on-disk logs stay bounded and old files get deleted.
- [ ] Set global rotation in `/etc/docker/daemon.json`, restart Docker, and verify a new container inherits the limits via `docker inspect`.
- [ ] Switch a container to the `journald` driver and read its logs with `journalctl CONTAINER_NAME=...`.
- [ ] Point a container at a local Fluent Bit/Fluentd with `--log-driver fluentd`, then confirm `docker logs` returns an error while logs still arrive at the collector.

## 11. Cheat Sheet

> [!TIP]
> **App logs to stdout/stderr; the driver routes it. Never log to files inside the container.**
> **Default `json-file` does NOT rotate** → set `max-size` + `max-file` (per-container, Compose, or `daemon.json`) or the disk fills. `local` rotates by default and is the safer host choice.
> **`docker logs` works only for** json-file / local / journald. Remote drivers (fluentd, awslogs, splunk) → query the central store.
> **Prod pattern:** local driver + tight rotation + node agent (Fluent Bit/Vector) shipping centrally. Use `mode=non-blocking` + `max-buffer-size` to avoid app stalls. Log structured JSON, info level, no secrets/PII. Rotation deletes history — retention lives in the central store.

**References:** Docker "Configure logging drivers" & "json-file / local driver" docs, 12-Factor App (Logs), Fluent Bit / Vector documentation, AWS "awslogs log driver" (ECS) docs.

---
*Docker Handbook — topic 16.*
