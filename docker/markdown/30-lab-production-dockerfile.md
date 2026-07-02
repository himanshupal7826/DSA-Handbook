# 30 · Lab: Write a Production-Grade Dockerfile

> **In one line:** Transform a naive Dockerfile into a hardened, multi-stage, cache-ordered, non-root, digest-pinned image with a HEALTHCHECK and dropped capabilities — annotated line by line.

---

## 1. The Scenario

Your team's Dockerfile passes review by nobody and ships anyway. It builds a big image that runs as **root**, rebuilds every dependency on every code change, pins nothing, and has no health signal. Security scanning is now mandatory and it fails the gate.

The starting artifact — the naive Dockerfile as written:

```dockerfile
# ❌ BEFORE — naive, insecure, cache-hostile
FROM node:latest

COPY . /app
WORKDIR /app

RUN npm install

EXPOSE 3000
CMD npm start
```

Six lines, at least eight problems: unpinned `:latest` base, whole-context copy before install (cache busts on every edit), `npm install` (non-deterministic) with dev deps, runs as **root**, no `.dockerignore`, no healthcheck, shell-form `CMD` that swallows signals, and no separation of build vs runtime.

Your task: turn this into a Dockerfile you'd be happy to run in production, and explain every line.

## 2. Approach

A production Dockerfile optimizes for four things at once — **size, cache reuse, security, and observability** — and a senior sequences the layers to get all four:

1. **Pin the base by digest.** `:latest` is a moving target; `@sha256:…` makes every build byte-identical and auditable.
2. **Multi-stage.** A `builder` with the toolchain, a `runtime` with just the app — build tools never ship.
3. **Order layers stable → volatile.** Manifests + `npm ci` *before* `COPY . .`, so code edits reuse the dependency layer.
4. **Deterministic installs.** `npm ci --omit=dev` from the lockfile; caches on a BuildKit mount so they don't bloat layers.
5. **Drop privilege.** Create and switch to a non-root `USER`; at run time drop all Linux capabilities and add back none, plus `--read-only` and `no-new-privileges`.
6. **Declare health.** A `HEALTHCHECK` so the orchestrator can restart or route away from a sick container.
7. **Correct PID 1.** exec-form `ENTRYPOINT` + an init so signals and zombies are handled.

The Dockerfile encodes what it *can* (pinning, user, healthcheck, stages); capabilities and read-only rootfs are enforced at **run time** — both halves matter.

## 3. Solution

```dockerfile
# ✅ AFTER — production-grade, annotated line by line
# syntax=docker/dockerfile:1

# ── Stage 1: builder ─────────────────────────────────────────────
# [1] Pin base by DIGEST, not a tag — reproducible, auditable, immutable.
FROM node:20.11.1-slim@sha256:2d9b2e2eef23f3f88e2b47e1a4a3d9a2b7f9c1a6c2d0e5f4a3b2c1d0e9f8a7b6 AS builder

# [2] Non-secret build metadata; keep the workdir explicit.
WORKDIR /app

# [3] Copy ONLY manifests first → this layer caches until deps change.
COPY package.json package-lock.json ./

# [4] Deterministic install of ALL deps (build needs devDependencies).
#     BuildKit cache mount keeps ~/.npm out of the image layers.
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# [5] Now bring in source and build. Cheap layer, changes often — kept last.
COPY . .
RUN npm run build

# [6] Re-resolve node_modules with PRODUCTION deps only, for the runtime stage.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# ── Stage 2: runtime ─────────────────────────────────────────────
# [7] Slim, digest-pinned runtime base — no compilers, small surface.
FROM node:20.11.1-slim@sha256:2d9b2e2eef23f3f88e2b47e1a4a3d9a2b7f9c1a6c2d0e5f4a3b2c1d0e9f8a7b6 AS runtime

# [8] Install tini for correct PID 1, then remove apt lists in the SAME layer.
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

# [9] Runtime configuration via env; NODE_ENV=production trims frameworks.
ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# [10] Copy only the artifacts the app needs, and set ownership to non-root.
#      node:slim ships a pre-made unprivileged `node` user (uid 1000).
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist         ./dist

# [11] Drop root — everything below runs as an unprivileged user.
USER node

# [12] Document the port (metadata; does not publish).
EXPOSE 3000

# [13] Health signal: orchestrator restarts / stops routing if this fails.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch('http://localhost:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# [14] tini as PID 1 (reaps zombies, forwards signals) → exec-form app.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
```

The `.dockerignore` that goes with it:

```text
node_modules
.git
Dockerfile
.dockerignore
dist
coverage
.env*
*.md
logs
```

And the hardened **run** invocation (the half the Dockerfile can't enforce):

```bash
docker run -d --name api \
  --read-only --tmpfs /tmp \                 # immutable rootfs; writable /tmp only
  --cap-drop=ALL \                           # drop every Linux capability…
  --security-opt no-new-privileges=true \    # …and forbid regaining any via setuid
  --pids-limit=200 -m 512m --cpus=1 \        # bound blast radius
  -e DATABASE_URL="$DATABASE_URL" \          # secrets at runtime, never baked
  -p 3000:3000 myorg/api:1.4.2
```

## 4. Walkthrough

**[1][7] Digest pinning.** `node:20.11.1-slim` still floats — the same tag can be re-pushed with new bytes. Appending `@sha256:…` freezes the *exact* image; your build is reproducible next year and every layer is auditable against a supply-chain policy. Update the digest deliberately (Renovate/Dependabot), not accidentally.

**[3][5] Cache ordering (stable → volatile).** Docker invalidates a layer and all layers after it when the layer's inputs change. Manifests change rarely; source changes constantly. By copying `package*.json` and running `npm ci` *before* `COPY . .`, an ordinary code edit reuses the cached dependency layer — the difference between a 2-second and a 90-second rebuild.

**[4][6] Deterministic, minimal installs.** `npm ci` installs *exactly* the lockfile — reproducible, and it errors if the lock is stale (unlike `npm install`, which silently mutates it). The builder needs devDependencies to compile; the runtime gets a fresh `--omit=dev` tree with none of them. The `--mount=type=cache` keeps the npm download cache persistent across builds but *outside* the image layers, so it speeds rebuilds without adding bytes.

**[8] Clean up in the same RUN.** `apt-get install` and `rm -rf /var/lib/apt/lists/*` are one `RUN`. Split across two, the deleted files would still live in the earlier layer and count toward image size — image layers are additive; a later delete only masks.

**[10][11] Non-root by construction.** Containers run as **root by default**, which is a privilege-escalation risk if the app is compromised. `node:slim` ships an unprivileged `node` user; we `--chown=node:node` the copied files and `USER node` so the process, and anything it spawns, runs unprivileged. Files it doesn't own it can't modify — which pairs with `--read-only` below.

**[13] HEALTHCHECK.** Liveness the platform can act on. `--start-period` gives the app time to boot before failures count; after `retries` consecutive failures the container is marked `unhealthy` and the orchestrator restarts it or removes it from the load-balancer. We use a Node one-liner so no extra tool (curl/wget) needs to exist in the slim image.

**[14] PID 1 done right.** exec-form `ENTRYPOINT`/`CMD` (JSON arrays) means no `/bin/sh` wraps the process, so it's PID 1 directly and receives signals. `tini` sits in front to reap zombies and forward `SIGTERM`, giving clean, fast shutdown instead of a 10s SIGKILL.

**The run flags — [--cap-drop / --read-only / no-new-privileges].** The Dockerfile can't drop kernel capabilities; the runtime must. `--cap-drop=ALL` removes every Linux capability (a web app needs none). `no-new-privileges` blocks regaining them via setuid binaries. `--read-only` + a `--tmpfs /tmp` makes the root filesystem immutable — a common malware-persistence and tampering defense. `--pids-limit`, `-m`, `--cpus` bound the blast radius of a runaway or DoS.

Here is how the hardening layers stack, defense in depth:

```svg
<svg viewBox="0 0 720 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ar" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="24" text-anchor="middle" fill="#1e293b" font-weight="700">Defense in depth — build-time + run-time</text>

  <rect x="80" y="44" width="560" height="248" rx="10" fill="none" stroke="#475569" stroke-dasharray="4 4"/>
  <text x="360" y="62" text-anchor="middle" fill="#64748b">host / kernel</text>

  <rect x="110" y="74" width="500" height="200" rx="10" fill="#fff7ed" stroke="#d97706"/>
  <text x="360" y="92" text-anchor="middle" fill="#1e293b" font-weight="700">--cap-drop=ALL · no-new-privileges · pids/mem/cpu limits</text>

  <rect x="150" y="104" width="420" height="150" rx="10" fill="#eff6ff" stroke="#2563eb"/>
  <text x="360" y="122" text-anchor="middle" fill="#1e293b" font-weight="700">--read-only rootfs (+ tmpfs /tmp)</text>

  <rect x="200" y="134" width="320" height="106" rx="10" fill="#ecfdf5" stroke="#059669"/>
  <text x="360" y="152" text-anchor="middle" fill="#1e293b" font-weight="700">USER node (non-root)</text>

  <rect x="240" y="164" width="240" height="66" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="360" y="186" text-anchor="middle" fill="#1e293b">tini (PID 1)</text>
  <text x="360" y="206" text-anchor="middle" fill="#1e293b">→ node dist/server.js</text>
  <text x="360" y="223" text-anchor="middle" fill="#64748b">digest-pinned slim base</text>

  <text x="360" y="308" text-anchor="middle" fill="#64748b">each ring must be breached before the next — HEALTHCHECK watches from outside</text>
</svg>
```

## 5. Variations & Follow-ups

**Distroless runtime** for the smallest surface (no shell at all): replace stage 2's base with `gcr.io/distroless/nodejs20-debian12:nonroot` (already non-root, already has an init-like entrypoint). You lose `apt`/`tini`, so use `docker run --init` for PID 1 and `kubectl debug` to inspect.

**Numeric USER for Kubernetes.** Prefer `USER 1000` over `USER node` so `runAsNonRoot: true` in a `securityContext` can be verified — the platform checks the numeric UID, not a name it can't resolve.

**Kubernetes securityContext** encodes the run flags declaratively:

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  readOnlyRootFilesystem: true
  allowPrivilegeEscalation: false
  capabilities: { drop: ["ALL"] }
```

**Build args & provenance.** Add `ARG`/`LABEL org.opencontainers.image.revision=$GIT_SHA` for traceability, and build with `--provenance=true --sbom=true` (BuildKit) to attach an SBOM and attestations for supply-chain scanning.

**Python equivalent** swaps `npm ci` for `pip install --no-cache-dir` into a `--prefix` and copies site-packages across stages; everything else (digest pin, non-root, healthcheck, tini) is identical.

## 6. Verify It Works

Confirm it runs as non-root:

```bash
docker run --rm --entrypoint id myorg/api:1.4.2
```

```text
uid=1000(node) gid=1000(node) groups=1000(node)
```

Confirm the base is pinned by digest:

```bash
docker image inspect myorg/api:1.4.2 --format '{{range .RepoDigests}}{{.}}{{end}}'
```

```text
node@sha256:2d9b2e2eef23f3f88e2b47e1a4a3d9a2b7f9c1a6c2d0e5f4a3b2c1d0e9f8a7b6
```

Confirm the healthcheck goes healthy and the rootfs is read-only:

```bash
docker run -d --name api --read-only --tmpfs /tmp --cap-drop=ALL \
  -e DATABASE_URL=postgres://db/app -p 3000:3000 myorg/api:1.4.2
sleep 12
docker inspect api --format '{{.State.Health.Status}}'
docker exec api sh -c 'touch /root/x' 2>&1 || echo "rootfs read-only ✓"
```

```text
healthy
touch: /root/x: Read-only file system
rootfs read-only ✓
```

Confirm capabilities were dropped (bounding set should be empty):

```bash
docker run --rm --cap-drop=ALL --entrypoint sh myorg/api:1.4.2 \
  -c 'grep CapBnd /proc/1/status'
```

```text
CapBnd:	0000000000000000
```

## 7. Pitfalls

1. ⚠️ **`FROM …:latest` (or any floating tag).** Non-reproducible and unauditable — a re-pushed tag silently changes your build. Pin `@sha256:…` and bump deliberately.
2. ⚠️ **`COPY . .` before installing deps.** Every source edit invalidates the dependency layer and forces a full reinstall. Copy manifests → install → then copy source.
3. ⚠️ **Forgetting `USER`.** The process runs as root; a compromise is a host-escalation risk. Create/switch to a non-root user and `--chown` the files it needs.
4. ⚠️ **Capabilities in the Dockerfile.** There's no Dockerfile directive to drop caps — it's a run-time (`--cap-drop`) or `securityContext` concern. Ship both halves or you're only half-hardened.
5. ⚠️ **Shell-form `CMD npm start`.** Wraps the app in `/bin/sh` (swallows SIGTERM → 137) and adds a process. Use exec-form arrays with an init.
6. ⚠️ **HEALTHCHECK that needs a tool the image lacks.** `CMD curl …` fails silently on a slim/distroless image with no curl. Use a language built-in or install the tool explicitly.

## 8. Interview Follow-ups

**Q: Why pin a base image by digest instead of a version tag?**
A: Tags are mutable — `20.11.1-slim` can be re-pushed with different bytes, so two builds of the "same" Dockerfile can differ. `@sha256:…` freezes the exact image content, making builds reproducible and auditable, and letting supply-chain policy verify what you actually ran.

**Q: How does layer ordering affect build speed?**
A: Docker caches each layer and invalidates it plus everything after when its inputs change. Putting rarely-changing steps (copy manifests, install deps) before frequently-changing ones (copy source) means code edits reuse the cached dependency layer instead of reinstalling — often a 90s → 2s difference.

**Q: Why run as a non-root user, and how do you enforce it?**
A: Containers default to root; if the app is compromised, root inside the container is a stepping stone to the host (especially with a writable rootfs or extra caps). Enforce it with `USER 1000` in the Dockerfile plus `runAsNonRoot: true`/`runAsUser` in Kubernetes, and `--chown` the app files.

**Q: Can you drop Linux capabilities in the Dockerfile?**
A: No — capability dropping is a runtime concern: `docker run --cap-drop=ALL` or a Kubernetes `securityContext.capabilities.drop: [ALL]`. The Dockerfile handles image content (user, base, healthcheck); the runtime handles the kernel security context. You need both.

**Q: What does a HEALTHCHECK give you that a liveness probe on the app doesn't?**
A: It's a container-level, declarative signal the orchestrator acts on — marking the container unhealthy after N failures so it's restarted or pulled from load balancing, with a `start-period` grace window for boot. It complements app metrics by giving the platform something to key restart/routing decisions on.

**Q: `npm ci` vs `npm install` in a Dockerfile — which and why?**
A: `npm ci` — it installs exactly the `package-lock.json`, is faster, and fails if the lock is out of sync, giving reproducible builds. `npm install` can mutate the lockfile and resolve differently across builds, which breaks reproducibility.

**Q: Why put tini (or `--init`) in front of the app?**
A: As PID 1 the app must reap zombie children and gets no default signal handlers. Most apps aren't written for that, so zombies accumulate and SIGTERM is ignored (leading to SIGKILL/137 on stop). tini/`--init` is a tiny init that reaps and forwards signals for clean shutdown.

**Q: What's the point of `--read-only` plus `--tmpfs /tmp`?**
A: An immutable root filesystem blocks tampering and malware persistence — the attacker can't drop or modify files. `--tmpfs /tmp` gives the app the small writable scratch space it legitimately needs, in memory, without opening the rest of the filesystem.

**Q: Where do secrets like DATABASE_URL belong?**
A: Injected at runtime via env or a secrets manager (`-e`, Docker/K8s secrets), never baked into the image with `ENV` or `COPY` — image layers are inspectable and shareable, so a baked secret is a permanent leak.

**Q: How would you translate this Dockerfile's hardening into Kubernetes?**
A: The image stays the same; the run flags become a `securityContext`: `runAsNonRoot`/`runAsUser: 1000`, `readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`, plus resource `limits` for pids/memory/cpu. HEALTHCHECK maps to liveness/readiness probes.

## 9. Cheat Sheet

> [!TIP]
> **Production Dockerfile checklist:**
> - `FROM …-slim@sha256:…` — pin by **digest**.
> - **Multi-stage**: builder (toolchain) → runtime (app only).
> - Order **stable→volatile**: `COPY package*.json` → `npm ci` → `COPY . .`.
> - `npm ci --omit=dev` + `--mount=type=cache` for reproducible, lean installs.
> - `COPY --chown=node:node` then **`USER 1000`** — never root.
> - Clean caches in the **same** `RUN`.
> - **`HEALTHCHECK`** with `--start-period`, using a built-in (no external curl).
> - exec-form **`ENTRYPOINT ["tini","--"]` + `CMD [...]`** — signals & zombies handled.
> - Run: `--cap-drop=ALL --security-opt no-new-privileges --read-only --tmpfs /tmp -m/--cpus/--pids-limit`.
> - Secrets at **runtime** only. Verify: `id`, `RepoDigests`, `State.Health`, `/proc/1/status CapBnd`.

**References:** Docker docs — Dockerfile best practices, HEALTHCHECK, `docker run` security options; OWASP Docker Security Cheat Sheet; NIST SP 800-190; krallin/tini.

---
*Docker Handbook — topic 30.*
