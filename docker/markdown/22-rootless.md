# 22 · Rootless Containers & User Namespaces

> **In one line:** Run the Docker daemon and containers as an unprivileged user, and remap UIDs with a user namespace, so that "root inside the container" maps to a harmless ordinary user on the host.

---

## 1. Overview

The single most dangerous fact about default Docker is that the daemon runs as **root** and, without a user namespace, **UID 0 inside a container is UID 0 on the host**. If a process breaks out of the container, it breaks out *as root*. **Rootless containers** and **user namespace (userns) remapping** attack this at the root — literally.

**User namespaces** let the kernel present a *different* UID/GID mapping inside the container than outside. Container UID 0 (`root`) can be mapped to host UID 100000, an account with no special powers. The app keeps thinking it's root — it can `chown`, bind privileged ports, write to `/` — but every one of those operations is bounded by what host UID 100000 is allowed to do.

**Rootless mode** goes further: the *entire Docker/containerd daemon and its child containers run under an unprivileged user*, using userns plus user-mode networking (`slirp4netns`/`RootlessKit`). No root daemon exists at all, so there is no root process to compromise. You reach for these on multi-tenant hosts, CI runners, developer laptops, and anywhere a container escape reaching host root would be catastrophic.

## 2. Core Concepts

- **User namespace (userns)** — a kernel namespace that maps a *range* of UIDs/GIDs inside the namespace to a different range outside. The foundation of both features.
- **UID/GID remapping** — container UID `0..65535` maps to host `100000..165535` (a `/etc/subuid` range). Inside: root. Outside: an unprivileged, unused UID.
- **`userns-remap`** — a rootful daemon (still root) that puts *containers* into a user namespace. The daemon is root; the workloads are remapped.
- **Rootless mode** — the *daemon itself* runs as a non-root user; containers are its children. Nothing in the stack is host-root.
- **`/etc/subuid` & `/etc/subgid`** — files that grant a user a contiguous range of subordinate UIDs/GIDs it may map (e.g. `alice:100000:65536`).
- **`slirp4netns` / RootlessKit** — user-mode networking; an unprivileged user can't create real veth/bridge interfaces, so traffic is proxied in userspace (a small perf cost).
- **Why root-in-container ≠ root-on-host** — with userns, capabilities held inside the namespace apply *only* to resources owned within it; the kernel checks the *host* UID for anything touching host-owned objects.
- **Rootless limitations** — no binding host ports < 1024 without extra config, degraded network throughput, some storage drivers/`--net=host` unavailable, cgroup v2 + systemd needed for resource limits.

## 3. Syntax & Examples

**Rootful daemon with userns-remap** — edit `/etc/docker/daemon.json`:

```json
{
  "userns-remap": "default"
}
```

Docker creates a `dockremap` user and reads its `/etc/subuid` range. Restart the daemon and containers now run remapped.

**Rootless install** — run entirely as your normal user:

```bash
# One-time setup (installs rootless dockerd for the current user)
dockerd-rootless-setuptool.sh install

# Point the client at the user-scoped socket
export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock

docker run -d -p 8080:80 nginx     # no sudo, no root daemon
```

**Grant a subordinate ID range** (usually done by the installer):

```bash
# /etc/subuid  and  /etc/subgid
alice:100000:65536      # alice may map 65536 UIDs starting at host UID 100000
```

**Inspect the mapping from inside a container:**

```bash
docker exec -it web sh -c 'id; cat /proc/self/uid_map'
```

## 4. Worked Example

Prove that container root is *not* host root under rootless Docker.

```bash
# Client talks to the rootless daemon owned by "alice" (host uid 1000)
export DOCKER_HOST=unix:///run/user/1000/docker.sock
docker run -d --name web nginx
```

Inside the container, the process believes it is root:

```text
$ docker exec web id
uid=0(root) gid=0(root) groups=0(root)

$ docker exec web cat /proc/self/uid_map
         0       1000          1     # container uid 0 -> host uid 1000
         1     100000      65535     # container uid 1.. -> host 100000..
```

Now look at the *same* nginx master process from the **host**:

```text
$ ps -o uid,pid,cmd -C nginx | head -2
UID   PID   CMD
1000  4821  nginx: master process nginx   # host sees uid 1000, not 0 ✅
```

Same process, two views. Inside it is root; on the host it is `alice` (UID 1000). A container escape here can do nothing `alice` couldn't already do — it cannot read `/etc/shadow`, cannot load kernel modules, cannot touch other users' files. The `root`-in-container illusion is fully contained.

## 5. Under the Hood

A user namespace installs a **UID map** in the kernel; every UID the container reports is translated to a host UID for any real access check.

```svg
<svg viewBox="0 0 640 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="b" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="320" y="22" text-anchor="middle" fill="#1e293b" font-weight="700">User namespace UID remapping</text>

  <!-- container side -->
  <rect x="40" y="52" width="230" height="230" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="155" y="74" text-anchor="middle" fill="#1e293b" font-weight="600">Inside container (userns)</text>
  <rect x="70" y="92" width="170" height="42" rx="8" fill="#fff" stroke="#2563eb"/>
  <text x="155" y="112" text-anchor="middle" fill="#1e293b" font-weight="600">app runs as uid 0</text>
  <text x="155" y="128" text-anchor="middle" fill="#64748b">"I am root"</text>
  <rect x="70" y="146" width="170" height="34" rx="8" fill="#fff" stroke="#2563eb"/>
  <text x="155" y="167" text-anchor="middle" fill="#64748b">uid 1..65535</text>
  <text x="155" y="212" text-anchor="middle" fill="#64748b">can chown, bind :80,</text>
  <text x="155" y="230" text-anchor="middle" fill="#64748b">write to / — all bounded</text>
  <text x="155" y="248" text-anchor="middle" fill="#64748b">by the host mapping →</text>

  <!-- map arrows -->
  <line x1="240" y1="113" x2="370" y2="113" stroke="#475569" marker-end="url(#b)"/>
  <text x="305" y="104" text-anchor="middle" fill="#64748b">uid_map</text>
  <line x1="240" y1="163" x2="370" y2="200" stroke="#475569" marker-end="url(#b)"/>

  <!-- host side -->
  <rect x="370" y="52" width="230" height="230" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="485" y="74" text-anchor="middle" fill="#1e293b" font-weight="600">On the host (real UIDs)</text>
  <rect x="400" y="92" width="170" height="42" rx="8" fill="#fff" stroke="#059669"/>
  <text x="485" y="112" text-anchor="middle" fill="#1e293b" font-weight="600">host uid 1000</text>
  <text x="485" y="128" text-anchor="middle" fill="#64748b">unprivileged "alice"</text>
  <rect x="400" y="180" width="170" height="42" rx="8" fill="#fff" stroke="#059669"/>
  <text x="485" y="200" text-anchor="middle" fill="#1e293b" font-weight="600">host uid 100000+</text>
  <text x="485" y="216" text-anchor="middle" fill="#64748b">unused subordinate range</text>

  <rect x="40" y="296" width="560" height="34" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="320" y="317" text-anchor="middle" fill="#1e293b" font-weight="600">Kernel checks the HOST uid for every access → breakout = unprivileged, not root</text>
</svg>
```

When the container calls `chown` or opens a file, the kernel resolves the acting identity through the `uid_map` to the **host** UID and checks permissions against *that*. Capabilities the process holds inside the namespace (`CAP_CHOWN`, `CAP_NET_BIND_SERVICE`…) are **namespaced** — they apply only to objects owned within the namespace's UID range, never to host-owned resources like `/etc/shadow` or kernel modules. Rootless mode adds a second twist: because the unprivileged user can't create real network interfaces, `RootlessKit` runs `slirp4netns` to move packets through a userspace TCP/IP stack, which is why rootless networking is a bit slower.

## 6. Variations & Trade-offs

| Mode | Daemon runs as | Container root maps to | Escape reaches | Main limitation |
|---|---|---|---|---|
| Default (rootful) | root | host root (UID 0) | **host root** ⚠️ | none — but worst blast radius |
| `userns-remap` | root | host UID 100000+ | unprivileged user | daemon still root; shared remap range |
| Rootless | your user | your user / subordinate UIDs | *your* unprivileged user | perf, ports <1024, feature gaps |
| gVisor / Kata | varies | sandboxed kernel/VM | sandbox only | overhead, compatibility |

**Trade-offs.** `userns-remap` is the easy win for a single rootful host — one line of config, containers get remapped, but the daemon is still a root target and all containers share one mapping. **Rootless** is stronger (no root daemon at all) and ideal for multi-tenant/CI, but you pay: slower userspace networking (~20-30% throughput hit historically), no privileged ports without `net.ipv4.ip_unprivileged_port_start` or setcap, `--net=host` and some storage drivers unavailable, and resource limits need cgroup v2 + systemd. For untrusted workloads that need real kernel isolation, layer **gVisor/Kata** on top.

## 7. Production / Performance Notes

- **Rootless is production-ready** (stable since Docker 20.10) and shines on CI runners and shared build hosts — a poisoned build can't take the node.
- **Networking cost.** `slirp4netns` runs a userspace network stack; enable `slirp4netns` with `--mtu` tuning or switch to the newer `pasta` backend for better throughput. For high-PPS workloads, benchmark first.
- **Privileged ports.** Rootless can't bind `<1024` by default. Either publish on a high port and front it with a rootful reverse proxy, or set `net.ipv4.ip_unprivileged_port_start=80`, or grant `CAP_NET_BIND_SERVICE` to `rootlesskit`.
- **Storage.** Prefer the `overlay2` driver with kernel ≥5.11 (native rootless overlay) or `fuse-overlayfs` on older kernels — the latter is slower on metadata-heavy workloads.
- **Kubernetes analogue.** Pods don't run a Docker daemon, but the same protection comes from `runAsNonRoot: true` plus a `securityContext`, and kubelet/CRI can enable user namespaces per-pod (`hostUsers: false`, GA-track) to remap even container-root pods.
- **Not a silver bullet.** Userns doesn't stop kernel-level exploits that don't depend on UID (some data-only or namespace bugs). Keep seccomp, dropped capabilities (topic 21), and a patched kernel — defense in depth.

## 8. Common Mistakes

1. ⚠️ **Assuming default Docker already remaps root.** Fix: it does *not* — without userns, container root is host root. Enable `userns-remap` or go rootless explicitly.
2. ⚠️ **Missing/short `/etc/subuid` range**, so containers fail to start or can't map all UIDs. Fix: ensure the user has a range ≥65536 (e.g. `alice:100000:65536`).
3. ⚠️ **Expecting `--privileged` to still be safe under rootless.** Fix: privileged in rootless still can't exceed the user's own powers, but it re-enables risky paths inside the mapped range — avoid it anyway.
4. ⚠️ **Volume ownership confusion** — files created in a mounted host dir appear owned by host UID 100000+, unreadable by your normal user. Fix: use `--user`, `chown` via the mapping, or `--userns=host` for that specific mount need.
5. ⚠️ **Trying to bind port 80 rootless and giving up.** Fix: use a high port + proxy, or lower `ip_unprivileged_port_start`.
6. ⚠️ **Believing rootless makes seccomp/capabilities unnecessary.** Fix: it doesn't stop UID-independent kernel bugs; keep the other controls.

## 9. Interview Questions

**Q: What problem do user namespaces solve?**
A: They decouple the UID/GID a process sees inside the namespace from the real host UID. This lets a container run as "root" (UID 0) internally while being an unprivileged UID (e.g. 100000) on the host, so a container escape lands as a harmless user instead of host root.

**Q: Why is "root in the container" not automatically "root on the host"?**
A: Only when a user namespace remaps UID 0 to an unprivileged host UID. The kernel resolves the acting identity through the `uid_map` and checks permissions against the host UID; capabilities held inside the namespace are namespaced and apply only to objects owned within the mapped range. Without userns, UID 0 is shared and container root *is* host root.

**Q: What is the difference between `userns-remap` and rootless mode?**
A: `userns-remap` keeps a **root** daemon but places containers into a user namespace, so workloads are remapped while the daemon is still a root process. **Rootless** runs the *entire daemon* as an unprivileged user — there's no root process anywhere in the stack, which removes the daemon itself as a root target.

**Q: What are `/etc/subuid` and `/etc/subgid`?**
A: They grant a user a contiguous range of subordinate UIDs/GIDs it's permitted to use in user namespaces, e.g. `alice:100000:65536`. Docker maps container UIDs into this range. Without a sufficient range, remapped containers can't start or can't map all their UIDs.

**Q: Why is rootless networking slower and how do you mitigate it?**
A: An unprivileged user can't create real veth/bridge interfaces, so tools like `slirp4netns` (or the newer `pasta`) run a userspace TCP/IP stack that proxies packets, adding CPU cost. Mitigate with `pasta`, MTU tuning, or by fronting high-throughput services with a rootful proxy; benchmark for high packet-rate workloads.

**Q: How do you bind port 80 in rootless mode?**
A: By default you can't (ports <1024 are privileged). Options: publish a high port and reverse-proxy to it, set the sysctl `net.ipv4.ip_unprivileged_port_start=80`, or grant `CAP_NET_BIND_SERVICE` to the `rootlesskit` binary.

**Q: What are the limitations of rootless containers?** *(senior)*
A: No privileged ports without extra config, degraded userspace networking, `--net=host` and some storage drivers unavailable, resource limits require cgroup v2 + systemd, potential volume-ownership friction (files owned by mapped host UIDs), and `overlay2` needs a recent kernel or you fall back to slower `fuse-overlayfs`. It also doesn't stop UID-independent kernel exploits.

**Q: Is rootless a complete substitute for seccomp and dropping capabilities?** *(senior)*
A: No. Userns limits *what a UID can touch*, but a kernel bug that doesn't depend on UID — or a syscall-level exploit — can still be reached. Rootless composes with seccomp, `cap-drop ALL`, `no-new-privileges`, and a patched kernel; it's the strongest single layer, not the only one.

**Q: How does this map to Kubernetes, which has no Docker daemon?** *(senior)*
A: Pods use a `securityContext` (`runAsNonRoot`, `runAsUser`) to avoid running as root, and Kubernetes user namespaces (`hostUsers: false` on the pod) remap container UIDs to unprivileged host UIDs per-pod, giving the same escape-containment even for images that insist on running as root. Pod Security Admission `restricted` enforces the non-root parts cluster-wide.

**Q: A container escape happens under rootless Docker owned by `alice`. What can the attacker do?**
A: Only what `alice` (and her subordinate UID range) could already do — no reading other users' files, no `/etc/shadow`, no kernel module loading, no host-root actions. The blast radius equals a single unprivileged user account, which is exactly the point.

## 10. Practice

- [ ] Install rootless Docker for your user and confirm `docker info` shows `rootless` in the security options.
- [ ] Run a container as root inside, then compare `docker exec … id` with the host `ps` UID for the same process; explain the mapping.
- [ ] Read `/proc/self/uid_map` inside a container and correlate it with the user's `/etc/subuid` range.
- [ ] Enable `userns-remap` on a rootful daemon and observe container processes owned by `dockremap` on the host.
- [ ] Attempt to bind port 80 rootless, watch it fail, then make it work via a high port + proxy or `ip_unprivileged_port_start`.

## 11. Cheat Sheet

> [!TIP]
> **Rootless & User Namespaces** — make container-root harmless on the host.
> - **User namespace** maps container UID 0 → an unprivileged host UID via `uid_map`.
> - **`userns-remap`** (`/etc/docker/daemon.json: {"userns-remap":"default"}`) — root daemon, remapped containers.
> - **Rootless** (`dockerd-rootless-setuptool.sh install`, `DOCKER_HOST=unix:///run/user/$UID/docker.sock`) — *no root daemon at all*.
> - **`/etc/subuid` / `/etc/subgid`** grant the mappable range (`user:100000:65536`).
> - Escape reaches only *your* unprivileged user — not host root.
> - Costs: userspace networking (slirp4netns/pasta), no ports <1024 by default, cgroup v2 for limits, volume-ownership quirks.
> - Still pair with seccomp + `cap-drop ALL` + patched kernel — userns doesn't stop UID-independent kernel bugs.

**References:** Docker rootless mode docs, Docker userns-remap docs, Linux `user_namespaces(7)` man page, RootlessKit / slirp4netns projects, Kubernetes user namespaces documentation

---
*Docker Handbook — topic 22.*
