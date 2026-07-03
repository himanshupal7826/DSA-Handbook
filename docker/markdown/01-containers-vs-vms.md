# 01 · Containers vs VMs & Why Docker

> **In one line:** A VM virtualizes *hardware* and boots a full guest OS; a container virtualizes the *operating system* by sharing the host kernel and isolating processes with namespaces + cgroups — so it starts in milliseconds, ships in megabytes, and packs 10× denser.

---

## 1. Overview

Both containers and virtual machines solve the same pain: **"it works on my machine."** They give a workload a reproducible, isolated slice of a server. They just cut the stack at a **different layer**, and that one difference drives every trade-off you will ever make between them.

A **virtual machine** runs on a **hypervisor** (VMware ESXi, KVM, Hyper-V) that emulates hardware — virtual CPU, RAM, disk, NIC. On top of that virtual hardware you install a **complete guest OS**, including its own kernel. So a host running 10 VMs is running 10 kernels, 10 init systems, 10 copies of systemd/journald — before any of your code runs. The isolation is hardware-enforced and very strong, but the tax is real: gigabyte images, tens of seconds to boot, and a fixed slice of RAM reserved per VM.

A **container** skips the guest OS entirely. It is just **one or more normal Linux processes** on the host, made to *believe* they are alone via two kernel features: **namespaces** (what a process can *see*) and **cgroups** (what a process can *use*). There is exactly **one kernel** — the host's — shared by every container. No guest OS to boot means startup is a `fork`/`exec`, image size is only your app + its libraries, and a single host comfortably runs hundreds of containers.

**Docker** is the tooling that made containers usable by mortals: a **packaging format** (the layered image + `Dockerfile`), a **runtime** to start/stop them, and a **registry** protocol to ship them. You reach for containers when you want fast, dense, immutable, reproducible deployment of *applications*; you reach for VMs when you need to run *different kernels/OSes*, or want hardware-grade isolation for hostile multi-tenant workloads.

## 2. Core Concepts

- **Kernel sharing** — every container uses the **host's kernel**. There is no guest kernel, no BIOS, no bootloader. This is the single fact from which container speed, size, density, *and* their weaker isolation all follow.
- **Namespaces** — the *isolation* primitive: they scope what a process can **see**. `pid` (its own process tree, app is PID 1), `mnt` (its own filesystem view), `net` (its own interfaces/IPs/ports), `uts` (own hostname), `ipc` (own shared memory), `user` (map container root → unprivileged host UID), `cgroup`.
- **cgroups (control groups)** — the *resource* primitive: they scope what a process can **use** — CPU shares, memory ceiling, block-IO, PIDs count. `--memory=256m` is a cgroup limit; hit it and the kernel OOM-kills the process.
- **Hypervisor** — the VM equivalent of the container runtime. **Type-1** (ESXi, KVM) runs on bare metal; **Type-2** (VirtualBox) runs atop a host OS. It emulates hardware for each guest.
- **Guest OS** — the full operating system (kernel + userland) inside a VM. Containers have **no** guest OS — only a root filesystem of userland files (the "distro" you see in `alpine`/`ubuntu` images is just libraries and binaries, not a kernel).
- **Image (copy-on-write layers)** — a container's filesystem is a stack of **read-only layers** plus one thin **writable layer** on top. Layers are shared across containers, which is why 50 nginx containers cost ~one image on disk.
- **OCI** — the open standards (image-spec + runtime-spec) that make "Docker images" portable across containerd, Podman, Kubernetes, etc.
- **Density & immutability** — because containers are cheap and images are fixed, you run many, treat them as **ephemeral cattle**, and redeploy rather than patch in place.

## 3. Syntax & Examples

Start a container and observe that it is just an isolated process:

```bash
docker run --rm -it alpine:3.20 sh
# inside the container:
ps aux          # you see PID 1 = sh, and almost nothing else (pid namespace)
hostname        # a random 12-hex id (uts namespace)
ip addr         # your own eth0 with a private IP (net namespace)
cat /proc/1/cgroup   # shows the cgroup slice you're pinned to
```

Prove there is **no guest kernel** — the container reports the *host's* kernel:

```bash
uname -r                          # on the host, e.g. 6.8.0-…
docker run --rm alpine uname -r   # SAME kernel string — it's shared
```

Apply cgroup limits and a read-only, dropped-privilege container:

```bash
docker run -d --name web \
  --memory=256m --cpus=0.5 \        # cgroup: hard RAM cap + half a core
  --pids-limit=100 \                # cgroup: max 100 processes
  --read-only --cap-drop=ALL \      # immutable rootfs, drop all capabilities
  --user 1000:1000 \                # run as non-root
  nginx:1.27-alpine
```

Inspect the namespaces the kernel created for that container:

```bash
pid=$(docker inspect -f '{{.State.Pid}}' web)
sudo ls -l /proc/$pid/ns/    # net, mnt, pid, uts, ipc, user → separate inodes = isolated
```

## 4. Worked Example — the same app, VM vs container

Package a tiny web app and measure the two dimensions that matter: **size** and **startup**.

```dockerfile
# Dockerfile — the entire "OS" is ~7 MB of Alpine userland, no kernel
FROM alpine:3.20
RUN apk add --no-cache python3
COPY app.py /app.py
CMD ["python3", "-m", "http.server", "8080"]
```

```bash
docker build -t demo:1 .
time docker run --rm -d -p 8080:8080 demo:1     # measure cold start
docker images demo:1                            # measure image size
```

Result — container vs an equivalent minimal Ubuntu VM running the same server:

| Metric | Container (`demo:1`) | Minimal VM (Ubuntu cloud image) |
|---|---|---|
| Image / disk size | ~**60 MB** | ~**1.5–2.5 GB** |
| Cold start to serving | ~**50–200 ms** | ~**20–40 s** (BIOS + kernel + init) |
| Base RAM overhead | ~**2–10 MB** (just the process) | ~**200–512 MB** (guest OS resident) |
| Kernels running on host | **0 extra** (shares host) | **1 per VM** |
| Density on a 16 GB host | **hundreds** | **~20–30** |

Same app, same result to the user — but the container is ~30× smaller and ~200× faster to start, because it never booted an OS.

## 5. Under the Hood

A VM stack duplicates everything from the kernel up; a container stack shares the kernel and only diverges at userland.

```svg
<svg viewBox="0 0 720 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>

  <!-- VM side -->
  <text x="180" y="22" text-anchor="middle" fill="#1e293b" font-weight="700">Virtual Machines</text>
  <rect x="30" y="34" width="300" height="60" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="105" y="58" text-anchor="middle" fill="#1e293b">App A + libs</text>
  <text x="105" y="76" text-anchor="middle" fill="#64748b" font-size="11">Guest OS + Kernel</text>
  <text x="255" y="58" text-anchor="middle" fill="#1e293b">App B + libs</text>
  <text x="255" y="76" text-anchor="middle" fill="#64748b" font-size="11">Guest OS + Kernel</text>
  <line x1="180" y1="38" x2="180" y2="90" stroke="#d97706" stroke-dasharray="3 3"/>

  <rect x="30" y="102" width="300" height="32" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="180" y="123" text-anchor="middle" fill="#1e293b">Hypervisor (emulates hardware)</text>
  <rect x="30" y="142" width="300" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="180" y="162" text-anchor="middle" fill="#1e293b">Host OS + Kernel</text>
  <rect x="30" y="180" width="300" height="28" rx="8" fill="#f8fafc" stroke="#475569"/>
  <text x="180" y="199" text-anchor="middle" fill="#1e293b">Physical Hardware</text>
  <text x="180" y="230" text-anchor="middle" fill="#b91c1c" font-size="11">N guest kernels · GB images · boots in seconds</text>

  <!-- Container side -->
  <text x="540" y="22" text-anchor="middle" fill="#1e293b" font-weight="700">Containers</text>
  <rect x="390" y="34" width="300" height="42" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="465" y="60" text-anchor="middle" fill="#1e293b">App A + libs</text>
  <text x="615" y="60" text-anchor="middle" fill="#1e293b">App B + libs</text>
  <line x1="540" y1="38" x2="540" y2="72" stroke="#059669" stroke-dasharray="3 3"/>

  <rect x="390" y="84" width="300" height="32" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="540" y="105" text-anchor="middle" fill="#1e293b">Container runtime (namespaces + cgroups)</text>
  <rect x="390" y="124" width="300" height="48" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="540" y="146" text-anchor="middle" fill="#1e293b" font-weight="700">ONE shared Host Kernel</text>
  <text x="540" y="164" text-anchor="middle" fill="#64748b" font-size="11">every container uses this same kernel</text>
  <rect x="390" y="180" width="300" height="28" rx="8" fill="#f8fafc" stroke="#475569"/>
  <text x="540" y="199" text-anchor="middle" fill="#1e293b">Physical Hardware</text>
  <text x="540" y="230" text-anchor="middle" fill="#059669" font-size="11">0 extra kernels · MB images · boots in ms</text>

  <line x1="332" y1="145" x2="388" y2="145" stroke="#475569" marker-end="url(#arrow)"/>
  <text x="360" y="275" text-anchor="middle" fill="#64748b" font-size="11">VM isolates at the hardware line ▸ container isolates at the OS line</text>
  <text x="360" y="296" text-anchor="middle" fill="#64748b" font-size="11">Namespaces = what you SEE · cgroups = what you USE</text>
</svg>
```

When you `docker run`, the runtime asks the kernel to `clone()` a process into fresh **namespaces**, `pivot_root` into the image's layered filesystem, attach it to a **cgroup** with your limits, drop capabilities, then `exec` your binary as **PID 1** inside that world. No firmware, no bootloader, no kernel handoff — that's why it's milliseconds. A VM instead powers on virtual firmware, loads a guest kernel, and runs full init — seconds, and a permanent RAM footprint for the guest OS.

## 6. Variations & Trade-offs

There is also a **middle ground** — micro-VMs and sandboxed runtimes that buy back VM-grade isolation while keeping most container speed.

| Dimension | Container | Virtual Machine | Sandboxed / micro-VM (gVisor, Kata, Firecracker) |
|---|---|---|---|
| Isolation boundary | Kernel namespaces (shared kernel) | Hardware via hypervisor | Extra kernel/syscall layer per workload |
| Kernel | Host's, shared | Own guest kernel | Own minimal / intercepting kernel |
| Startup | ms | tens of seconds | ~100–150 ms |
| Image size | MB | GB | MB–low GB |
| Density / host | Hundreds | Tens | Dozens–hundreds |
| Isolation strength | Good (shared-kernel attack surface) | Strongest | Near-VM |
| Run a *different* OS/kernel? | ❌ no (Linux host → Linux only) | ✅ yes | ✅/partial |
| Typical use | Microservices, CI, dev envs | Legacy OS, hostile multi-tenant | Untrusted code, serverless (AWS Lambda uses Firecracker) |

**Trade-off in one sentence:** containers trade a bit of isolation strength for enormous gains in speed, size, and density — and when you can't accept that trade (untrusted tenants), micro-VMs give you most of both.

## 7. Production / Performance Notes

- **Density economics** — because a container adds ~single-digit MB of overhead vs ~hundreds of MB per VM, bin-packing many containers per node is where the cost savings come from. Always set **cgroup limits** (`--memory`, `--cpus`) or one greedy container starves its neighbors.
- **Security posture** — the shared kernel *is* the shared attack surface: a kernel-level container escape is a host compromise. Harden with `--cap-drop=ALL`, `--read-only`, seccomp/AppArmor, non-root users, and **user namespaces**. For genuinely untrusted code, use gVisor/Kata rather than plain containers.
- **Stateless & immutable** — treat containers as disposable. Anything that must survive `docker rm` goes in a **volume**, not the writable layer. Redeploy a new image rather than `exec` in and patch.
- **Same-kernel constraint** — you cannot run a Windows container on a Linux kernel or vice-versa; and a container built against a newer kernel syscall may break on an older host kernel. Match your build and runtime kernels.
- **Boot cost matters at scale** — sub-second start is what makes autoscaling, per-request functions, and fast CI possible; a VM fleet cannot scale on the same reflex.

## 8. Common Mistakes

1. ⚠️ **Treating a container like a mini-VM** — SSHing in, running systemd, cramming nginx + app + cron + db into one. *Fix:* one concern per container, PID 1 = your app, orchestrate the rest as separate containers.
2. ⚠️ **Assuming container == VM-grade isolation.** They share the host kernel; a kernel bug crosses the boundary. *Fix:* harden (cap-drop, seccomp, non-root, userns) or use micro-VMs for untrusted tenants.
3. ⚠️ **Running with no resource limits.** One container can consume all host RAM/CPU (noisy neighbor, OOM). *Fix:* always set `--memory`/`--cpus` (cgroups) or orchestrator requests/limits.
4. ⚠️ **Persisting data in the writable layer.** It vanishes on `docker rm` and isn't shared. *Fix:* mount a named volume or bind mount for state.
5. ⚠️ **Expecting to run a different kernel/OS.** "Ubuntu container" on a host is still the *host* kernel with Ubuntu userland. *Fix:* if you truly need another kernel, that's a VM's job.
6. ⚠️ **Running as root inside the container by default.** Container root maps toward host root without a user namespace. *Fix:* `USER` in the Dockerfile / `--user`, enable rootless or userns-remap.
7. ⚠️ **Bloated images** ("just use `ubuntu:latest`"). Slow pulls, bigger attack surface. *Fix:* alpine/distroless + multi-stage builds.

## 9. Interview Questions

**Q: What is the fundamental difference between a container and a virtual machine?**
A: A VM virtualizes hardware via a hypervisor and runs a full guest OS *including its own kernel*; a container virtualizes the OS by sharing the *host* kernel and isolating processes with namespaces and cgroups. So a container is just an isolated host process, which makes it far smaller, faster to start, and denser — at the cost of weaker (shared-kernel) isolation.

**Q: If a container shares the host kernel, what actually provides the isolation?**
A: Two Linux kernel features. **Namespaces** isolate what a process can *see* — pid, net, mnt, uts, ipc, user, cgroup — so it gets its own process tree, network stack, filesystem view, and hostname. **cgroups** isolate what it can *use* — CPU, memory, IO, PID count. Together they make one process believe it owns the machine.

**Q: Why does a container start in milliseconds but a VM in tens of seconds?**
A: A VM must power on virtual firmware, load a guest kernel, and run full init before your app runs. A container skips all of that — it's a `clone()`/`exec` into new namespaces on the already-running host kernel. No boot, no OS, so startup is process-creation time.

**Q: There's an `alpine` and an `ubuntu` image — do they contain a Linux kernel?**
A: No. Those images contain only **userland** — libraries, package manager, binaries. The kernel is always the host's. That's why `uname -r` is identical on the host and inside any Linux container, and why you can't run a genuinely different kernel version in a container.

**Q: Are containers less secure than VMs? Why?**
A: Generally yes, because they share the host kernel — a kernel-level container escape compromises the host, whereas a VM escape must also defeat the hypervisor's hardware boundary. You narrow the gap with cap-drop, seccomp/AppArmor, read-only rootfs, non-root users, and user namespaces; for untrusted multi-tenant code you use sandboxed runtimes (gVisor, Kata, Firecracker).

**Q: What problem did Docker actually solve — containers predate it?**
A: LXC/cgroups/namespaces existed for years but were hard to use. Docker standardized the **layered image format + Dockerfile** (reproducible build), a simple **CLI/daemon runtime**, and a **registry** protocol to share images. It made "build once, ship the exact filesystem, run anywhere" a two-command workflow, which is what drove adoption.

**Q: When would you deliberately choose a VM over a container?**
A: When you need a *different* OS or kernel than the host (Windows workload on Linux infra, custom kernel modules), when you require hardware-grade isolation for hostile/regulated multi-tenant workloads, or when running a monolithic legacy stack that expects a full OS. Otherwise containers win on speed, size, and density.

**Q: (Senior) How does copy-on-write layering let 50 containers of the same image barely cost more than one?**
A: An image is a stack of read-only layers shared across all containers; each container only adds a thin **writable** layer for its own changes. Unchanged files are read straight from the shared lower layers via the overlay filesystem, so disk and page-cache are shared. You pay one image plus 50 small deltas, not 50 full copies.

**Q: (Senior) A syscall works in your container on your laptop but the container crashes in production. Kernel-level reason?**
A: The container carries userland, not the kernel — so it runs against whatever kernel the host provides. A binary compiled against a newer syscall/feature can fail on an older production host kernel (or a restrictive seccomp profile blocking the syscall). Fix by matching build/runtime kernel versions and auditing the seccomp profile.

**Q: (Senior) What are user namespaces and why do they matter for container security?**
A: A user namespace maps UIDs inside the container to *different, unprivileged* UIDs on the host — so "root" (UID 0) in the container is, say, UID 100000 on the host with no real privilege. A container breakout as "root" therefore lands as a nobody on the host, dramatically reducing blast radius. It's the basis of rootless Docker/Podman.

**Q: (Senior) How do micro-VMs like Firecracker fit between containers and VMs?**
A: They boot a *minimal* guest kernel in ~100–150 ms with a tiny device model, giving hardware-level isolation at near-container speed and density. AWS Lambda/Fargate use Firecracker to run untrusted tenant code safely while keeping fast cold starts — the best of both when the shared-kernel trade-off is unacceptable.

## 10. Practice

- [ ] Run `docker run --rm alpine uname -r` and compare to `uname -r` on the host — confirm the kernel is shared.
- [ ] Start `docker run --rm -it alpine sh`, then inside run `ps aux`, `hostname`, and `ip addr` to observe the pid/uts/net namespaces.
- [ ] Launch a container with `--memory=64m` and a process that allocates 128 MB; watch the cgroup OOM-kill it (`docker inspect` → `OOMKilled: true`).
- [ ] Time a container cold start vs booting a minimal cloud VM for the same "hello http" app; record image size and RAM for each.
- [ ] Inspect `/proc/<pid>/ns/` for a running container and explain what each namespace isolates.

## 11. Cheat Sheet

> [!TIP]
> **Containers vs VMs — the whole topic**
> - **VM** = virtualize *hardware* → full guest OS + own kernel → GB, seconds, tens/host, strongest isolation.
> - **Container** = virtualize *the OS* → **shares host kernel** → MB, milliseconds, hundreds/host, kernel-shared isolation.
> - Isolation = **namespaces** (what you *see*: pid/net/mnt/uts/ipc/user) + **cgroups** (what you *use*: cpu/mem/io/pids).
> - No guest kernel: `uname -r` is identical host vs container; you can't run a different kernel/OS.
> - Filesystem = shared **read-only layers** + thin **writable** layer (copy-on-write → cheap density).
> - **Docker** = layered image + Dockerfile + runtime + registry = "build once, run anywhere."
> - Harden the shared kernel: `--cap-drop=ALL --read-only --user`, seccomp/AppArmor, user namespaces.
> - Untrusted tenants / need another kernel → **VM** or **micro-VM** (gVisor, Kata, Firecracker).
> - Treat containers as **ephemeral, immutable cattle**; state lives in **volumes**.

**References:** Docker docs "Docker overview"; Linux `namespaces(7)` and `cgroups(7)` man pages; OCI Runtime/Image specifications; Julia Evans "How containers work"; AWS Firecracker paper (NSDI '20).

---
*Docker Handbook — topic 01.*
