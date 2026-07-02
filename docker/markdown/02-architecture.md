# 02 · Docker Architecture: Daemon, containerd & runc

> **In one line:** `docker` is a thin CLI that talks to the `dockerd` daemon, which delegates the real work down a chain — **containerd** manages container lifecycle and images, **runc** actually spawns the process, and a **shim** keeps it alive after the daemon restarts.

---

## 1. Overview

Newcomers picture Docker as one monolithic program. It is really a **layered client/server system** built on **OCI standards**, and understanding the layers is what lets you debug "the container is running but Docker says it's dead," restart `dockerd` without killing workloads, or explain why Kubernetes dropped Docker but still runs your images.

At the top, the **`docker` CLI** is just an HTTP client. It sends requests over a Unix socket (`/var/run/docker.sock`) to the **daemon `dockerd`**, which owns high-level features: the build engine, networks, volumes, and the REST API. `dockerd` does **not** run containers itself — it hands lifecycle and image work to **`containerd`**, a separate long-running daemon that is the actual container supervisor.

`containerd` in turn does not create the process either. For each container it invokes **`runc`**, a small OCI-compliant runtime that does the low-level `clone()`/namespaces/cgroups dance, `exec`s your process, and **exits**. Staying between `containerd` and the container is a **shim** (`containerd-shim-runc-v2`), one per container, which owns the container's stdio and reports its exit — this is why containers survive a `dockerd` or `containerd` restart.

Because every layer speaks **OCI** (image spec + runtime spec), the pieces are swappable and interoperable: Kubernetes talks to `containerd` directly via **CRI** (no Docker needed), and you can swap `runc` for `crun`, `gVisor`, or **Kata**.

## 2. Core Concepts

- **`docker` CLI** — a stateless HTTP client to the Engine API; can be pointed at a remote daemon via `DOCKER_HOST`.
- **`dockerd` (the daemon)** — the server: builds images, manages networks/volumes, exposes the REST API, and delegates container/image ops to containerd.
- **containerd** — a graduated CNCF daemon that manages the **full container lifecycle** and image pull/push/storage. Talks to runtimes via a shim; talks to Kubernetes via **CRI**.
- **shim (`containerd-shim-runc-v2`)** — one per container; owns stdio and exit-code reporting; **decouples container lifetime from the daemons** so they can restart independently.
- **runc** — the reference **OCI runtime**: a CLI that reads an OCI bundle (`config.json` + rootfs), sets up namespaces/cgroups, execs the process, then exits. Swappable for `crun`, `runsc` (gVisor), `kata-runtime`.
- **OCI (Open Container Initiative)** — the **image-spec** (layer/manifest format) and **runtime-spec** (how to run a bundle) that make the whole ecosystem interoperable.
- **Registry** — content-addressed store (Docker Hub, ECR, GHCR) for images, spoken to over the Distribution/registry HTTP API.
- **CRI (Container Runtime Interface)** — Kubernetes' gRPC contract; containerd implements it directly, which is why Kubernetes deprecated the Docker shim yet still runs Docker-built images.

## 3. Syntax & Examples

Peek at each layer on a running host:

```bash
docker version              # shows Client and Server (dockerd) versions separately
docker info | grep -iE 'runtime|containerd|version'  # default runtime = runc

# The CLI is just an HTTP client over a socket:
curl --unix-socket /var/run/docker.sock http://localhost/version
```

See the daemons and shims as real host processes:

```bash
ps -ef | grep -E 'dockerd|containerd|shim|runc'
# dockerd                 -> the Docker daemon
# containerd              -> lifecycle/image daemon
# containerd-shim-runc-v2 -> one PER running container
# runc                    -> transient; only during create/exec
```

Talk to containerd directly (bypassing Docker entirely), the way Kubernetes does:

```bash
ctr images pull docker.io/library/redis:7    # containerd's own CLI
ctr run docker.io/library/redis:7 r1
crictl ps                                     # CRI view used by kubelet
```

Point the CLI at a remote daemon:

```bash
export DOCKER_HOST=ssh://ops@build-host
docker ps    # runs against the remote dockerd
```

## 4. Worked Example

**Goal:** prove that containers outlive the daemon — the payoff of the shim architecture.

```bash
# 1. Start a long-running container
docker run -d --name web nginx
docker inspect -f '{{.State.Pid}}' web      # e.g. 51234 (host PID of nginx)

# 2. Restart the Docker daemon
sudo systemctl restart docker

# 3. The nginx process kept running the whole time
ps -p 51234 -o pid,etime,cmd
docker ps                                    # 'web' is still Up, uptime unbroken
```

Result:

```text
$ ps -p 51234 -o pid,etime,cmd
    PID     ELAPSED CMD
  51234       03:12 nginx: master process nginx -g daemon off;

$ docker ps
CONTAINER ID   IMAGE   STATUS          NAMES
a1b2c3d4e5f6   nginx   Up 3 minutes    web        # never restarted
```

Why: `dockerd` and even `containerd` can exit, but each container's **shim** is a separate process that keeps holding the container's stdio and cgroup and reports the exit code when it finally happens. When the daemon comes back, it reconnects to the existing shims. This is the architectural reason Docker can be upgraded live.

## 5. Under the Hood

A `docker run` flows top-to-bottom through the stack; the shim is what stays behind.

```svg
<svg viewBox="0 0 660 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>

  <rect x="230" y="20" width="200" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="330" y="42" text-anchor="middle" fill="#1e293b" font-weight="700">docker CLI</text>
  <text x="330" y="58" text-anchor="middle" fill="#64748b" font-size="11">HTTP client</text>

  <line x1="330" y1="66" x2="330" y2="90" stroke="#475569" marker-end="url(#a)"/>
  <text x="440" y="82" text-anchor="middle" fill="#64748b" font-size="11">/var/run/docker.sock</text>

  <rect x="200" y="92" width="260" height="52" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="330" y="114" text-anchor="middle" fill="#1e293b" font-weight="700">dockerd (daemon)</text>
  <text x="330" y="132" text-anchor="middle" fill="#64748b" font-size="11">build · networks · volumes · REST API</text>

  <line x1="330" y1="144" x2="330" y2="168" stroke="#475569" marker-end="url(#a)"/>

  <rect x="200" y="170" width="260" height="52" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="330" y="192" text-anchor="middle" fill="#1e293b" font-weight="700">containerd</text>
  <text x="330" y="210" text-anchor="middle" fill="#64748b" font-size="11">lifecycle · images · CRI (to k8s)</text>

  <line x1="330" y1="222" x2="330" y2="246" stroke="#475569" marker-end="url(#a)"/>

  <rect x="180" y="248" width="300" height="52" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="330" y="270" text-anchor="middle" fill="#1e293b" font-weight="700">containerd-shim-runc-v2</text>
  <text x="330" y="288" text-anchor="middle" fill="#64748b" font-size="11">one per container · owns stdio · reports exit</text>

  <line x1="330" y1="300" x2="330" y2="324" stroke="#475569" marker-end="url(#a)"/>

  <rect x="230" y="326" width="200" height="48" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="330" y="348" text-anchor="middle" fill="#1e293b" font-weight="700">runc (OCI runtime)</text>
  <text x="330" y="365" text-anchor="middle" fill="#64748b" font-size="11">clone/ns/cgroups → exec → exits</text>

  <line x1="330" y1="374" x2="330" y2="398" stroke="#475569" marker-end="url(#a)"/>
  <rect x="250" y="400" width="160" height="26" rx="6" fill="#ecfdf5" stroke="#059669"/>
  <text x="330" y="418" text-anchor="middle" fill="#1e293b">your process (PID 1)</text>

  <!-- registry side -->
  <rect x="500" y="170" width="140" height="52" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="570" y="192" text-anchor="middle" fill="#1e293b" font-weight="700">Registry</text>
  <text x="570" y="210" text-anchor="middle" fill="#64748b" font-size="11">pull / push layers</text>
  <line x1="500" y1="196" x2="462" y2="196" stroke="#475569" marker-end="url(#a)"/>
</svg>
```

Sequence of `docker run nginx`: CLI → REST to `dockerd` → `dockerd` asks `containerd` to create a container from the image (pulling layers from the **registry** if missing) → `containerd` unpacks the OCI bundle and starts a **shim** → the shim invokes **runc** → runc sets up namespaces/cgroups, `exec`s nginx as PID 1, and **exits** → the shim stays, parenting the process and buffering its stdio/exit. runc is transient by design; the long-lived guardian is the shim.

## 6. Variations & Trade-offs

| Component | Role | Swappable with | Trade-off |
|---|---|---|---|
| Runtime | Create process from bundle | `runc` → `crun` (faster, C), `runsc` (gVisor), `kata-runtime` (micro-VM) | Speed vs isolation strength |
| Daemon | High-level engine | `dockerd` → **Podman** (daemonless), `containerd`+`nerdctl` | Podman = rootless/no daemon; Docker = richer UX |
| k8s runtime | CRI to kubelet | containerd, CRI-O | Docker shim removed in k8s 1.24; images unaffected |
| Image builder | Build layers | classic builder → **BuildKit** (default), `buildah`, `kaniko` | BuildKit: parallel, cache mounts, secrets |

**Docker vs Podman:** Podman is **daemonless** — the CLI forks `conmon` + `runc` directly, so there is no single privileged daemon and it runs **rootless** by default. Docker keeps `dockerd`, which gives a smoother swarm/build/API experience at the cost of a root daemon. Both build and run OCI images, so images move between them freely.

## 7. Production / Performance Notes

- **Live-upgrade safety.** Thanks to shims, you can restart or upgrade `dockerd`/`containerd` without stopping containers — but verify `live-restore` (`/etc/docker/daemon.json: {"live-restore": true}`) for daemon-restart resilience of running workloads.
- **Kubernetes reality.** "Kubernetes removed Docker" (1.24) only removed the `dockershim` adapter; clusters run **containerd/CRI-O** directly and still run your Docker-built OCI images unchanged.
- **Rootless & security.** The `dockerd` socket is root-equivalent — mounting `docker.sock` into a container is a full host takeover. Prefer **rootless Docker** or **Podman** for untrusted contexts; never expose the daemon TCP socket without mTLS.
- **Runtime choice.** For untrusted multi-tenant code, set the runtime to `runsc`/`kata` per container (`--runtime`), accepting some latency for a hypervisor/syscall boundary.
- **Debugging the stack.** When `docker ps` misbehaves, check the layer below: `ctr`/`crictl` see what containerd sees; `journalctl -u containerd` and `-u docker` split daemon logs; orphaned shims signal a container the daemon lost track of.
- **BuildKit.** It's the default builder — enables parallel stages, `--mount=type=cache`, and build secrets. Keep it on for fast, secure builds.

## 8. Common Mistakes

1. ⚠️ **Thinking Docker is one binary** — it's CLI + dockerd + containerd + shim + runc. Fix: learn the chain so you can debug each layer independently.
2. ⚠️ **Assuming a `dockerd` restart kills containers** — the shim keeps them alive. Fix: rely on shims/`live-restore`; don't stop-then-start unnecessarily.
3. ⚠️ **Believing k8s can't run Docker images** — it removed the *dockershim*, not OCI image support. Fix: images built by Docker run fine on containerd/CRI-O.
4. ⚠️ **Mounting `docker.sock` into a container "for convenience"** — that's root-on-host. Fix: use rootless mode, a scoped proxy, or Podman.
5. ⚠️ **Exposing the daemon on TCP without TLS** (`-H tcp://0.0.0.0:2375`) — instant remote root. Fix: Unix socket only, or mTLS + firewall.
6. ⚠️ **Confusing containerd with runc** — containerd is a long-lived supervisor; runc is a transient exec-and-exit tool. Fix: expect `runc` to be absent in `ps` between operations.
7. ⚠️ **Ignoring the shim's exit reporting** — assuming exit codes come from the daemon. Fix: know the shim buffers stdio/exit so codes survive daemon restarts.

## 9. Interview Questions

**Q: Walk me through what happens end-to-end when you run `docker run nginx`.**
A: The `docker` CLI sends a REST request over `docker.sock` to `dockerd`; `dockerd` asks `containerd` to create the container (pulling image layers from the registry if absent); containerd unpacks the OCI bundle and launches a **shim**; the shim calls **runc**, which sets up namespaces/cgroups, execs nginx as PID 1, and exits; the shim stays behind owning stdio and reporting the eventual exit code.

**Q: What is the role of the shim, and why does it exist?**
A: There is one shim per container; it owns the container's stdout/stderr and reports its exit status, and it **decouples container lifetime from the daemons**. Because the shim (not dockerd) parents the process, you can restart or upgrade dockerd/containerd without killing running containers.

**Q: What's the difference between containerd and runc?**
A: **containerd** is a long-running daemon that manages the whole lifecycle and image storage and speaks CRI to Kubernetes. **runc** is a small, transient OCI runtime CLI that just creates one container (namespaces/cgroups + exec) and exits. containerd calls runc via the shim.

**Q: What does OCI standardize, and why does it matter?**
A: The **image-spec** (layer/manifest format) and **runtime-spec** (how to run an OCI bundle). It makes the ecosystem interoperable and swappable: Docker, Podman, containerd, CRI-O all share image and runtime formats, and you can replace runc with crun/gVisor/Kata.

**Q: Kubernetes "removed Docker" — did that break Docker images?**
A: No. Kubernetes 1.24 removed the **dockershim** adapter and now talks to **containerd/CRI-O** directly through CRI. Docker-built images are OCI images, so they run unchanged.

**Q: How can you upgrade the Docker daemon without downtime for running containers?**
A: Because each container is parented by its own shim, restarting `dockerd` doesn't stop workloads; enabling `live-restore` in `daemon.json` keeps containers running across daemon restarts, and the daemon reconnects to existing shims on startup.

**Q: Why is mounting `/var/run/docker.sock` into a container dangerous?**
A: The socket controls the root daemon, so anything with access can launch a privileged container mounting the host root FS — full host compromise. Use rootless Docker/Podman, a scoped socket proxy, or avoid it.

**Q: (Senior) How do you run untrusted workloads without abandoning the container workflow?**
A: Configure an alternative OCI runtime per workload — `runsc` (gVisor, userspace syscall interception) or `kata-runtime` (micro-VM). They plug in at the runtime layer via `--runtime`/RuntimeClass, so the CLI/daemon/containerd flow is unchanged.

**Q: (Senior) Compare Docker and Podman architecturally.**
A: Docker uses a persistent root daemon (`dockerd`) delegating to containerd/runc. Podman is **daemonless**: the CLI directly launches `conmon` + `runc` per container and runs **rootless** by default, reducing the single-privileged-daemon attack surface. Both produce/consume OCI images.

**Q: (Senior) Your `docker ps` hangs but containers seem alive. How do you triage the layers?**
A: Drop below Docker: use `ctr`/`crictl` to query containerd directly, check `journalctl -u containerd` and `-u docker` separately, look for live `containerd-shim` processes and their PIDs, and inspect the socket with `curl --unix-socket`. This isolates whether the problem is the CLI, dockerd, containerd, or a stuck shim.

**Q: (Senior) What does BuildKit change versus the classic builder, architecturally?**
A: BuildKit replaces the linear legacy builder with a DAG solver: it parallelizes independent stages, supports `--mount=type=cache` and build **secrets**/SSH, and does content-addressed caching. It's the default engine behind `docker build` now.

## 10. Practice

- [ ] Run `ps -ef | grep -E 'dockerd|containerd|shim|runc'` and map each process to a layer.
- [ ] Start a container, `systemctl restart docker`, and confirm it kept running (unbroken uptime).
- [ ] Pull and run an image with `ctr`/`nerdctl`, bypassing Docker entirely.
- [ ] Query `curl --unix-socket /var/run/docker.sock http://localhost/version` and read the JSON.
- [ ] Set `--runtime` to an alternative (if available) and diff `docker info` default runtime.

## 11. Cheat Sheet

> [!TIP]
> **Stack:** `docker` CLI → **dockerd** (build/net/vol/API) → **containerd** (lifecycle/images/CRI) → **shim** (per-container, stdio+exit) → **runc** (ns/cgroups+exec, then exits) → your PID 1.
> **Shim = why containers survive daemon restarts.** runc = transient; containerd = long-lived.
> **OCI** (image-spec + runtime-spec) makes everything swappable: runc↔crun↔gVisor↔Kata; dockerd↔Podman; containerd↔CRI-O.
> **k8s** talks containerd via **CRI** — it dropped *dockershim*, not Docker images.
> Security: `docker.sock` = root; prefer rootless/Podman; never expose TCP without mTLS.

**References:** Docker Engine architecture docs · containerd documentation · OCI image-spec & runtime-spec · Kubernetes "Don't Panic: Kubernetes and Docker" blog

---

*Docker Handbook — topic 02.*
