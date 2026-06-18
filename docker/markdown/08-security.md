# 08 · Container Security

> **In one line:** Reduce attack surface: non-root, minimal images, scanning.

---

## 1. Overview

Containers share the host kernel, so security hardening matters: run as **non-root**, use **minimal images**, drop Linux **capabilities**, scan for CVEs, and never bake **secrets** into images. Defense in depth limits the blast radius of a compromise.

## 2. Key Concepts

- Run as a non-root USER; drop unneeded capabilities.
- Minimal base images (distroless/alpine) shrink CVE surface.
- Scan images (Trivy/Grype) in CI.
- Secrets via runtime env/secret stores, not image layers.
- Read-only root filesystem + no-new-privileges hardening.

## 3. Syntax & Code

```bash
docker run --read-only --cap-drop ALL --security-opt no-new-privileges \
  -u 1000:1000 myapp:1.0
# scan for vulnerabilities
trivy image myapp:1.0
```

## 4. Worked Example

**Non-root in Dockerfile**

Create and switch to an unprivileged user:

```dockerfile
RUN adduser -D -u 1000 app
USER app
```

## 5. Best Practices

- ✅ Always run as a non-root user.
- ✅ Drop all capabilities and add back only what's needed.
- ✅ Scan images in CI and patch base images regularly.
- ✅ Use read-only filesystems and no-new-privileges.
- ✅ Inject secrets at runtime (env/secret manager), never in layers.

## 6. Common Pitfalls

1. ⚠️ Running as root (default).
2. ⚠️ Secrets baked into image history.
3. ⚠️ Fat images full of unused, vulnerable packages.
4. ⚠️ Granting --privileged casually.
5. ⚠️ Never updating base images (stale CVEs).
6. ⚠️ Mounting the Docker socket into containers (host takeover).

## 7. Interview Questions

1. **Q: Why run containers as non-root?**
   A: To limit damage if the app is compromised — root in container can be closer to host root.

2. **Q: How to shrink attack surface?**
   A: Minimal/distroless base, drop capabilities, remove unused packages, read-only FS.

3. **Q: Where should secrets live?**
   A: Runtime env vars or a secret manager — never baked into image layers/history.

4. **Q: Why scan images?**
   A: Base images and deps accrue CVEs; scanners (Trivy) catch known vulnerabilities.

5. **Q: Risk of mounting the Docker socket?**
   A: It grants control of the daemon — effectively host root.

6. **Q: What does --cap-drop ALL do?**
   A: Removes all Linux capabilities; add back only required ones.

7. **Q: Is container isolation a security boundary?**
   A: Weaker than VMs (shared kernel); for hostile multi-tenancy add VMs/gVisor.

8. **Q: no-new-privileges flag?**
   A: Prevents processes from gaining new privileges via setuid binaries.

## 8. Practice

- [ ] Make a Dockerfile run as non-root.
- [ ] Run a container with --read-only and --cap-drop ALL.
- [ ] Scan an image with Trivy and fix a finding.

## 9. Quick Revision

Harden containers: non-root USER, minimal images, drop capabilities, read-only FS, no-new-privileges, scan in CI, secrets at runtime. Never mount the Docker socket or run --privileged casually.

**References:** Docker security

---

*Docker Handbook — topic 08.*
