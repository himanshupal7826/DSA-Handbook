# 21 · Container Security Fundamentals

> **In one line:** Containers share the host kernel, so harden the runtime — non-root, dropped capabilities, read-only rootfs, seccomp/AppArmor — to shrink the blast radius when an app is compromised.

---

## 1. Overview

A container is **not a security boundary** the way a VM is. Every container on a host shares the **same kernel**; isolation comes from Linux **namespaces** (what a process can *see*) and **cgroups** (what it can *use*), plus a set of kernel security modules. A kernel bug or a misconfigured runtime can let a process cross from "inside the container" to "on the host."

Security work on containers is therefore about **reducing attack surface** and applying **defense in depth**: even if an attacker gets code execution inside your app, they should hit wall after wall — no root, no dangerous capabilities, a read-only filesystem, a syscall filter, and no path to escalate privileges.

You reach for these controls whenever a container runs untrusted input (which is every internet-facing service). The defaults Docker ships are *reasonable* but not *hardened* — the container still runs as **root** (UID 0) inside its namespace and keeps a dozen Linux capabilities. This page is about closing that gap.

## 2. Core Concepts

- **Attack surface** — the syscalls, capabilities, mounted paths, network ports, and kernel features a container can reach. Every one you remove is one fewer thing to exploit.
- **Linux capabilities** — root's powers split into ~40 units (`CAP_NET_ADMIN`, `CAP_SYS_ADMIN`…). Docker grants ~14 by default; most apps need **zero**. Use `--cap-drop ALL` then `--cap-add` only what you prove you need.
- **Non-root `USER`** — running as UID ≠ 0 inside the container means a breakout lands on the host as an unprivileged user, not root.
- **Read-only root filesystem** (`--read-only`) — the image filesystem is immutable at runtime; attackers can't drop a binary or modify code. Writable paths are explicit `tmpfs`/volumes.
- **`no-new-privileges`** — blocks `setuid` binaries and `execve` from *ever* gaining more privileges than the parent. Neutralizes SUID-root escalation.
- **seccomp** — a syscall allowlist/denylist. Docker's default profile already blocks ~44 dangerous syscalls (`ptrace`, `mount`, `reboot`…). Custom profiles tighten further.
- **AppArmor / SELinux** — Mandatory Access Control: kernel-enforced policy on files, capabilities, and network per-process, independent of file permissions.
- **`--privileged` (the danger)** — disables *almost every* isolation control at once: all capabilities, all devices, no seccomp/AppArmor. It is effectively root on the host. Avoid it.

## 3. Syntax & Examples

Start with the single most impactful hardening flags on `docker run`:

```bash
# Drop ALL capabilities, add back only NET_BIND_SERVICE (bind port < 1024)
docker run --cap-drop ALL --cap-add NET_BIND_SERVICE nginx
```

Layer on a read-only rootfs and a writable tmpfs for scratch space:

```bash
docker run \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  -u 1000:1000 \
  myapp:1.0
```

Bake the non-root user into the image so it is the default:

```dockerfile
FROM node:20-slim
# Create an unprivileged user/group with a fixed UID
RUN groupadd -g 10001 app && useradd -u 10001 -g app -M -s /usr/sbin/nologin app
WORKDIR /app
COPY --chown=app:app . .
RUN npm ci --omit=dev
USER 10001            # numeric UID so k8s runAsNonRoot can verify it
EXPOSE 8080
CMD ["node", "server.js"]
```

Apply a custom seccomp or AppArmor profile:

```bash
docker run --security-opt seccomp=./profiles/tight.json myapp:1.0
docker run --security-opt apparmor=docker-myapp myapp:1.0
# Inspect what a running container was granted:
docker inspect --format '{{ .HostConfig.CapAdd }} {{ .HostConfig.CapDrop }}' <id>
```

## 4. Worked Example

Harden a small Python service and prove each control works.

```dockerfile
# Dockerfile
FROM python:3.12-slim
RUN useradd -u 10001 -M -s /usr/sbin/nologin app
WORKDIR /app
COPY --chown=app:app app.py .
USER 10001
CMD ["python", "app.py"]
```

```bash
docker build -t hardened:1 .
docker run -d --name h \
  --read-only --tmpfs /tmp \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  hardened:1
```

Now verify the guarantees from *inside* the container:

```text
$ docker exec h id
uid=10001 gid=10001 groups=10001          # not root ✅

$ docker exec h touch /root/x
touch: cannot touch '/root/x': Read-only file system   # rootfs immutable ✅

$ docker exec h sh -c 'apt-get update'
Permission denied                          # no CAP + non-root ✅

$ docker exec h grep NoNewPrivs /proc/self/status
NoNewPrivs:  1                             # escalation blocked ✅
```

Four independent walls, each verifiable in one command. A remote code execution in `app.py` now lands as UID 10001, on a read-only disk, with no capabilities and no way to escalate.

## 5. Under the Hood

Isolation is enforced by three kernel subsystems stacked on top of your process; hardening flags tune each layer.

```svg
<svg viewBox="0 0 640 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="320" y="22" text-anchor="middle" fill="#1e293b" font-weight="700">Container process vs. the host kernel</text>

  <rect x="200" y="42" width="240" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="320" y="63" text-anchor="middle" fill="#1e293b" font-weight="600">App process (PID 1 in ns)</text>
  <text x="320" y="80" text-anchor="middle" fill="#64748b">USER 10001 · non-root</text>

  <text x="320" y="108" text-anchor="middle" fill="#64748b">every syscall passes through the guards ↓</text>

  <rect x="60" y="122" width="150" height="60" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="135" y="146" text-anchor="middle" fill="#1e293b" font-weight="600">seccomp</text>
  <text x="135" y="164" text-anchor="middle" fill="#64748b">syscall filter</text>

  <rect x="245" y="122" width="150" height="60" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="320" y="146" text-anchor="middle" fill="#1e293b" font-weight="600">Capabilities</text>
  <text x="320" y="164" text-anchor="middle" fill="#64748b">cap-drop ALL</text>

  <rect x="430" y="122" width="150" height="60" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="505" y="146" text-anchor="middle" fill="#1e293b" font-weight="600">AppArmor/SELinux</text>
  <text x="505" y="164" text-anchor="middle" fill="#64748b">MAC policy</text>

  <rect x="60" y="200" width="520" height="52" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="320" y="222" text-anchor="middle" fill="#1e293b" font-weight="600">Namespaces (pid, net, mnt, user…) + cgroups (cpu, mem)</text>
  <text x="320" y="240" text-anchor="middle" fill="#64748b">what the process can SEE / USE — isolation, not a security wall</text>

  <rect x="60" y="270" width="520" height="46" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="320" y="298" text-anchor="middle" fill="#1e293b" font-weight="600">Shared host kernel — one kernel for all containers</text>

  <line x1="320" y1="88" x2="320" y2="118" stroke="#475569" marker-end="url(#a)"/>
  <line x1="320" y1="182" x2="320" y2="198" stroke="#475569" marker-end="url(#a)"/>
  <line x1="320" y1="252" x2="320" y2="268" stroke="#475569" marker-end="url(#a)"/>

  <rect x="450" y="330" width="180" height="40" rx="8" fill="#fff7ed" stroke="#b91c1c"/>
  <text x="540" y="348" text-anchor="middle" fill="#b91c1c" font-weight="600">--privileged</text>
  <text x="540" y="363" text-anchor="middle" fill="#64748b">removes ALL guards above</text>
</svg>
```

Every syscall the app makes is checked against the **seccomp** filter (BPF program attached at exec), then the kernel checks whether the required **capability** is in the process's permitted set, then **AppArmor/SELinux** consults its policy. Below those, namespaces and cgroups define what exists at all. `--privileged` is dangerous precisely because it flips *all* of these guards off in one flag, leaving only the shared kernel between the process and the host.

## 6. Variations & Trade-offs

| Control | Flag | Default | Protects against | Cost |
|---|---|---|---|---|
| Non-root user | `USER` / `-u` | root (UID 0) | breakout → host root, in-container escalation | must fix file perms, ports ≥1024 |
| Drop capabilities | `--cap-drop ALL` | ~14 caps | raw sockets, mount, module load | add back a few for some apps |
| Read-only rootfs | `--read-only` | writable | persistence, tampering | must declare tmpfs/volumes |
| No new privileges | `--security-opt no-new-privileges` | off | SUID-root escalation | none (rare breakage) |
| seccomp | `--security-opt seccomp=…` | default profile on | dangerous syscalls | custom profiles are fiddly |
| AppArmor/SELinux | `--security-opt apparmor=…` | `docker-default` | file/cap/net policy | writing policies is work |
| `--privileged` | `--privileged` | off | *nothing* — removes guards | catastrophic if misused |

The trade-off is almost always **effort vs. safety**, not **performance vs. safety** — these controls are near-zero runtime cost. The real cost is that a hardened container surfaces hidden assumptions (writes to `/`, need for a capability), so hardening late is painful. Harden from day one.

## 7. Production / Performance Notes

- **Enforce, don't hope.** In Kubernetes, express these as a `securityContext` (`runAsNonRoot: true`, `readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`) and gate them with **Pod Security Admission** (`restricted`) or a policy engine (Kyverno/OPA Gatekeeper). Flags on `docker run` don't survive a redeploy.
- **Never mount the Docker socket** (`/var/run/docker.sock`) into a container — it is a full API to the daemon and equals root on the host. This is the most common real-world escape.
- **Overhead is negligible.** seccomp adds a BPF check per syscall (nanoseconds); capabilities and MAC are already in the syscall path. There is no reason to disable them for "performance."
- **Watch for the SYS_ADMIN trap.** Tools that ask for `--cap-add SYS_ADMIN` are asking for near-root; it enables mount, and is a frequent escape vector. Find a narrower capability or a different tool.
- **Rootless + userns** (topic 22) composes with all of this and is the strongest single upgrade — even in-container root maps to an unprivileged host UID.

## 8. Common Mistakes

1. ⚠️ **Running as root** because it "just works." Fix: add a `USER` with a numeric UID and set `runAsNonRoot: true`.
2. ⚠️ **Reaching for `--privileged`** to fix a permission error. Fix: find the *specific* capability or device needed and add only that.
3. ⚠️ **Mounting the Docker/containerd socket** for convenience (CI, dashboards). Fix: use a rootless builder, sysbox, or a scoped API proxy.
4. ⚠️ **`--cap-add SYS_ADMIN`** copied from a Stack Overflow answer. Fix: it's near-root; identify the real requirement (often just a mount or device).
5. ⚠️ **Disabling seccomp** (`--security-opt seccomp=unconfined`) to silence an error. Fix: add the one missing syscall to a custom profile instead.
6. ⚠️ **`--read-only` without declaring writable paths**, so the app crashes on first log write. Fix: add `--tmpfs /tmp` and named volumes for real data.
7. ⚠️ **Hardening only in `docker run`, not in the orchestrator.** Fix: move controls into `securityContext` + admission policy so they can't be bypassed.

## 9. Interview Questions

**Q: Why is a container not a security boundary in the way a VM is?**
A: All containers share the host's single kernel; isolation is just namespaces and cgroups plus optional MAC/seccomp. A VM has its own kernel behind a hypervisor. A kernel vulnerability or a misconfigured runtime can let a container process reach the host, whereas a VM escape requires breaking the hypervisor.

**Q: What does `--cap-drop ALL` do and why start there?**
A: It removes every Linux capability from the container. Root's powers are split into ~40 capabilities; Docker grants ~14 by default but most apps need none. Dropping all and adding back only proven ones (e.g. `NET_BIND_SERVICE`) follows least privilege and closes powerful vectors like raw sockets, mount, and kernel module loading.

**Q: What is the difference between capabilities and seccomp?**
A: Capabilities gate *privileged operations* (which powers a process holds); seccomp filters *individual syscalls* regardless of privilege. They're complementary — you can drop `CAP_SYS_ADMIN` and also seccomp-block `ptrace`. Capabilities are coarse and role-based; seccomp is a fine-grained syscall allow/deny list.

**Q: What exactly does `no-new-privileges` prevent?**
A: It sets the `PR_SET_NO_NEW_PRIVS` bit so no child process can gain more privileges than its parent, notably neutralizing SUID-root binaries and `execve`-based escalation. Even if an attacker finds a SUID binary inside the container, it won't grant root.

**Q: Why is `--privileged` so dangerous?**
A: It disables essentially all isolation at once — grants every capability, exposes all host devices, and turns off seccomp and the default AppArmor profile. A privileged container can mount the host filesystem, load kernel modules, and access `/dev`, so it's equivalent to root on the host. Almost nothing legitimately needs it.

**Q: What does a read-only root filesystem buy you, and how do you handle apps that need to write?**
A: It makes the image layer immutable at runtime, blocking attackers from dropping binaries, modifying code, or persisting. For legitimate writes you mount explicit `tmpfs` (for scratch/`/tmp`, ideally `noexec,nosuid`) or named volumes for real data, so the writable surface is small and known.

**Q: A container runs as root inside but the host is unaffected on breakout — when is that true?**
A: When a **user namespace** remaps container UID 0 to an unprivileged host UID (rootless Docker or `userns-remap`). Without userns, container root *is* host root on breakout because UID 0 is shared. This is why rootless/userns is the strongest single hardening step.

**Q: How do you enforce these controls so they survive redeploys?** *(senior)*
A: Move them off ad-hoc `docker run` flags into declarative policy: a Kubernetes `securityContext` (`runAsNonRoot`, `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`) enforced by Pod Security Admission `restricted` or an admission controller like Kyverno/OPA Gatekeeper that rejects non-compliant pods at the API server.

**Q: An app needs `SYS_ADMIN`. How do you reason about it?** *(senior)*
A: Treat it as near-root — `SYS_ADMIN` enables mount and is a common escape vector. Investigate what specific operation is needed; often it's one mount or a device that a narrower capability, a bind-mount, or `--device` can satisfy. If truly required, isolate that workload (dedicated node, gVisor/Kata, or a VM) rather than granting it broadly.

**Q: How would you build a minimal custom seccomp profile without breaking the app?** *(senior)*
A: Start from Docker's default profile, run the app under audit (e.g. seccomp in log/complain mode or strace to enumerate syscalls), collect the actual syscall set, then generate an allowlist covering those plus a safety margin, and test in staging. Tools like `oci-seccomp-bpf-hook` can auto-generate a profile from a traced run.

## 10. Practice

- [ ] Take an existing image that runs as root and add a non-root numeric `USER`; fix any file-permission and port-binding fallout.
- [ ] Run a service with `--read-only`, discover every path it writes to, and add exactly the `tmpfs`/volume mounts it needs.
- [ ] Run `docker run --cap-drop ALL` on your app, watch it fail, and add back the minimal set of capabilities via `--cap-add`.
- [ ] Trace an app's syscalls, build a custom seccomp profile from the observed set, and confirm it still runs.
- [ ] Translate all of the above into a Kubernetes `securityContext` and verify Pod Security Admission `restricted` accepts it.

## 11. Cheat Sheet

> [!TIP]
> **Container Security Fundamentals** — containers share the host kernel; isolation ≠ security, so harden.
> Baseline `docker run` for any service:
> `--cap-drop ALL --read-only --tmpfs /tmp --security-opt no-new-privileges -u 10001:10001`
> - **Non-root `USER`** (numeric UID) → breakout lands unprivileged.
> - **`--cap-drop ALL`** then add back only proven caps (e.g. `NET_BIND_SERVICE`).
> - **`--read-only`** + explicit tmpfs/volumes → immutable rootfs.
> - **`no-new-privileges`** → kills SUID escalation.
> - **seccomp** (default on) + **AppArmor/SELinux** → syscall + MAC filtering.
> - **Never** use `--privileged`, `--cap-add SYS_ADMIN`, or mount the Docker socket.
> - Enforce via k8s `securityContext` + Pod Security Admission `restricted`, not one-off flags.

**References:** Docker security docs (Runtime privilege & Linux capabilities), Docker seccomp/AppArmor docs, NIST SP 800-190 (Application Container Security), Kubernetes Pod Security Standards, CIS Docker Benchmark

---
*Docker Handbook — topic 21.*
