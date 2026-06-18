# 01 · Containers vs VMs

> **In one line:** Containers share the host kernel; VMs virtualize hardware.

---

## 1. Overview

A **container** packages an app with its dependencies and runs as an isolated process on the host's kernel, using Linux **namespaces** (isolation) and **cgroups** (resource limits). Unlike a **VM**, it doesn't boot a full guest OS, so it's lighter and starts in milliseconds.

## 2. Key Concepts

- Containers share the host kernel; VMs each run a guest OS.
- Namespaces isolate PID, network, mount, user, etc.
- cgroups limit CPU/memory/IO per container.
- Images are read-only layers; the container adds a writable layer.
- Faster startup and higher density than VMs.

## 3. Syntax & Code

```bash
docker run --rm -it alpine:3.20 sh   # start a tiny container shell
# inside: ps shows an isolated process tree
```

## 4. Worked Example

**Resource limits via cgroups**

Cap memory and CPU:

```bash
docker run --memory=256m --cpus=0.5 nginx
```

## 5. Best Practices

- ✅ Use containers for consistent, portable environments.
- ✅ Set resource limits (--memory/--cpus) in production.
- ✅ Keep one main process per container.
- ✅ Prefer small base images (alpine/distroless).
- ✅ Treat containers as ephemeral and immutable.

## 6. Common Pitfalls

1. ⚠️ Treating containers like VMs (multiple services, SSH inside).
2. ⚠️ Assuming containers provide VM-level security isolation.
3. ⚠️ Running without resource limits (noisy neighbor).
4. ⚠️ Storing important data in the writable layer (lost on removal).
5. ⚠️ Mismatched host/container architecture.
6. ⚠️ Expecting a different kernel than the host's.

## 7. Interview Questions

1. **Q: Container vs VM?**
   A: Containers share the host kernel and isolate via namespaces/cgroups (lightweight); VMs virtualize hardware and run a full guest OS.

2. **Q: What provides container isolation?**
   A: Linux namespaces (PID/net/mount/user) for isolation and cgroups for resource limits.

3. **Q: Why do containers start fast?**
   A: No OS boot — they're just isolated host processes.

4. **Q: Are containers as secure as VMs?**
   A: Generally weaker isolation (shared kernel); use extra hardening or VMs for strict multi-tenancy.

5. **Q: What is an image layer?**
   A: A read-only filesystem diff; images stack layers, containers add a writable top layer.

6. **Q: One process per container — why?**
   A: Simpler lifecycle, logging, scaling, and signal handling.

7. **Q: How to limit resources?**
   A: --cpus/--memory map to cgroup limits.

8. **Q: Where should persistent data go?**
   A: In volumes, not the container's writable layer.

## 8. Practice

- [ ] Run an Alpine container and inspect its isolated process tree.
- [ ] Apply memory and CPU limits to a container.
- [ ] Explain why a container can't run a different-kernel OS.

## 9. Quick Revision

Containers = isolated host processes (namespaces + cgroups), sharing the kernel — lighter/faster than VMs. One process each, set limits, keep ephemeral, persist data in volumes.

**References:** Docker overview

---

*Docker Handbook — topic 01.*
