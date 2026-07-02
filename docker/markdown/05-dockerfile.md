# 05 · Dockerfile Essentials & Best Practices

> **In one line:** A Dockerfile is a deterministic, layer-by-layer recipe — master every instruction and the shell-vs-exec / CMD-vs-ENTRYPOINT distinctions and your images become small, fast, and reproducible.

---

## 1. Overview

A **Dockerfile** is a text script of instructions that `docker build` executes top-to-bottom to assemble an image. Each instruction that changes the filesystem (`FROM`, `RUN`, `COPY`, `ADD`) creates a **read-only layer**; metadata instructions (`ENV`, `EXPOSE`, `CMD`, `ENTRYPOINT`, `USER`, `WORKDIR`, `LABEL`) mutate the image **config** without adding filesystem bytes. The final image is those layers stacked plus a JSON config describing the default process.

You reach for a Dockerfile whenever you need a **reproducible, versionable build** — the same file plus the same context yields the same image on any machine, and it lives in git next to the code. The alternative (hand-crafting a container and `docker commit`) is opaque and unrepeatable.

The whole craft is two ideas: (1) **order instructions so the cache does the most work** (stable things first, volatile things last), and (2) **pick the right form** — exec form for a process that must receive Unix signals, `ENTRYPOINT` for "this image *is* this program," `CMD` for overridable defaults. Everything below is those two ideas applied to each instruction.

## 2. Core Concepts

- **`FROM`** — sets the base image and starts a build stage. `FROM scratch` is the empty base. Every Dockerfile begins with `FROM` (except `ARG` before it). Pin by digest or specific tag, not `:latest`.
- **`RUN`** — executes a command in a new layer at **build time** (e.g. install packages, compile). This is where filesystem state is created.
- **`COPY`** — copies files/dirs from the **build context** into the image. Predictable, no magic. Preferred default.
- **`ADD`** — like COPY but also auto-extracts local tar archives and can fetch remote URLs. Use only for those two features; otherwise COPY.
- **`CMD`** — the **default** command/args, easily overridden at `docker run img <args>`. Only the last CMD wins.
- **`ENTRYPOINT`** — the **fixed** executable; `CMD` (or run args) become its arguments. Makes the image behave like a binary.
- **`ENV`** — sets environment variables that persist into the running container and into later build instructions.
- **`ARG`** — a **build-time-only** variable (`--build-arg`); not present in the running container. An `ARG` before `FROM` is only usable in `FROM`.
- **`WORKDIR`** — sets the working directory for subsequent `RUN`/`CMD`/`COPY`; creates it if missing. Use absolute paths, never chains of `RUN cd`.
- **`EXPOSE`** — documents the port the app listens on (metadata only; does not publish — `-p` does that).
- **`USER`** — switches the UID/GID for subsequent instructions and the runtime process. Drop root.
- **`HEALTHCHECK`** — a command Docker runs periodically to mark the container `healthy`/`unhealthy`.
- **Shell vs exec form** — `RUN apt-get…` (shell, runs via `/bin/sh -c`) vs `RUN ["apt-get","…"]` (exec, direct `execve`, no shell). Matters most for `CMD`/`ENTRYPOINT` signal handling.

## 3. Syntax & Examples

Minimal, then real.

```dockerfile
FROM alpine:3.20
CMD ["echo", "hello"]
```

Every instruction, annotated:

```dockerfile
# syntax=docker/dockerfile:1
ARG PY_VERSION=3.12                 # build-time var, usable in FROM
FROM python:${PY_VERSION}-slim      # base image + stage

LABEL org.opencontainers.image.source="https://github.com/acme/api"
ENV PYTHONUNBUFFERED=1 \            # persists into the container
    APP_HOME=/app
WORKDIR ${APP_HOME}                 # cwd for everything below

# deps first (stable) → maximises cache hits (see topic 06)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .                            # volatile source last
EXPOSE 8000                         # documentation only

RUN adduser -D appuser              # create non-root user
USER appuser                        # drop privileges

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD python -c "import urllib.request,sys; \
      sys.exit(0 if urllib.request.urlopen('http://localhost:8000/health').status==200 else 1)"

ENTRYPOINT ["gunicorn", "app:app"]  # fixed program
CMD ["--bind", "0.0.0.0:8000", "--workers", "3"]  # overridable defaults
```

Build and inspect:

```bash
docker build -t acme/api:1.4.0 --build-arg PY_VERSION=3.12 .
docker history acme/api:1.4.0        # see each layer + size
docker run acme/api:1.4.0            # runs: gunicorn app:app --bind 0.0.0.0:8000 --workers 3
docker run acme/api:1.4.0 --workers 8  # entrypoint kept, CMD replaced
```

## 4. Worked Example

**Goal:** a small, signal-clean Node service image with a non-root user and healthcheck.

```dockerfile
# syntax=docker/dockerfile:1
FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /srv

# lockfile + manifest first for cache
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
EXPOSE 3000
USER node                            # image ships a 'node' user

HEALTHCHECK --interval=15s CMD node -e "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "server.js"]
```

```bash
docker build -t shop:latest .
docker run -d -p 3000:3000 --name shop shop:latest
docker ps
```

Result — note the `(healthy)` status and that PID 1 is `node` (exec form), so `docker stop` delivers `SIGTERM` directly for graceful shutdown:

```text
CONTAINER ID   IMAGE         COMMAND            STATUS                   PORTS
a1b2c3d4e5f6   shop:latest   "node server.js"   Up 20s (healthy)         0.0.0.0:3000->3000/tcp
```

Had we written `ENTRYPOINT node server.js` (shell form), PID 1 would be `/bin/sh -c "node server.js"`, `SIGTERM` would hit the shell (which ignores it and does not forward), and `docker stop` would hang 10s then `SIGKILL` — data loss on shutdown.

## 5. Under the Hood

Each build step runs in a throwaway container started from the previous layer; its filesystem diff is committed as the next layer. Metadata instructions only rewrite the image's JSON config. The runtime process is whatever `ENTRYPOINT` + `CMD` resolve to.

```svg
<svg viewBox="0 0 760 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="380" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">Dockerfile → layers + config</text>

  <!-- instructions column -->
  <text x="120" y="55" text-anchor="middle" fill="#64748b">instruction</text>
  <rect x="30" y="65" width="180" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="120" y="85" text-anchor="middle" fill="#1e293b">FROM python:3.12-slim</text>
  <rect x="30" y="105" width="180" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="120" y="125" text-anchor="middle" fill="#1e293b">COPY requirements.txt</text>
  <rect x="30" y="145" width="180" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="120" y="165" text-anchor="middle" fill="#1e293b">RUN pip install …</text>
  <rect x="30" y="185" width="180" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="120" y="205" text-anchor="middle" fill="#1e293b">COPY . .</text>
  <rect x="30" y="225" width="180" height="30" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="120" y="245" text-anchor="middle" fill="#1e293b">ENV / EXPOSE / CMD</text>

  <!-- arrows to filesystem layers -->
  <line x1="210" y1="80" x2="300" y2="80" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="210" y1="120" x2="300" y2="120" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="210" y1="160" x2="300" y2="160" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="210" y1="200" x2="300" y2="200" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="210" y1="240" x2="560" y2="285" stroke="#d97706" stroke-dasharray="4 3" marker-end="url(#ah)"/>

  <!-- layers stack -->
  <text x="420" y="55" text-anchor="middle" fill="#64748b">read-only layers</text>
  <rect x="310" y="65" width="220" height="30" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="420" y="85" text-anchor="middle" fill="#1e293b">base rootfs</text>
  <rect x="310" y="105" width="220" height="30" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="420" y="125" text-anchor="middle" fill="#1e293b">+ requirements.txt</text>
  <rect x="310" y="145" width="220" height="30" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="420" y="165" text-anchor="middle" fill="#1e293b">+ site-packages</text>
  <rect x="310" y="185" width="220" height="30" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="420" y="205" text-anchor="middle" fill="#1e293b">+ app source</text>

  <!-- config box -->
  <text x="640" y="55" text-anchor="middle" fill="#64748b">image config (JSON)</text>
  <rect x="555" y="240" width="180" height="70" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="645" y="262" text-anchor="middle" fill="#1e293b">Env, ExposedPorts,</text>
  <text x="645" y="280" text-anchor="middle" fill="#1e293b">Entrypoint, Cmd,</text>
  <text x="645" y="298" text-anchor="middle" fill="#1e293b">User, Healthcheck</text>
</svg>
```

## 6. Variations & Trade-offs

| Choice | Option A | Option B | Rule of thumb |
|---|---|---|---|
| Copy files | `COPY src dst` | `ADD src dst` | COPY by default; ADD only for local tar auto-extract or remote URL |
| Command form | shell: `CMD node app.js` | exec: `CMD ["node","app.js"]` | Exec form — direct process, receives signals, no shell parsing |
| Default process | `CMD ["nginx"]` | `ENTRYPOINT ["nginx"]` | ENTRYPOINT when the image *is* one program; CMD for overridable default |
| Both | — | `ENTRYPOINT ["git"]` + `CMD ["--help"]` | ENTRYPOINT = binary, CMD = default args (best of both) |
| Config | `ENV` | `ARG` | ARG for build-only (versions, mirrors); ENV for runtime config |
| Base | `python:3.12` | `python:3.12-slim` / `alpine` | slim/distroless for size; full for debugging & glibc compat |

**CMD vs ENTRYPOINT precisely:** at runtime the container executes `ENTRYPOINT + CMD` concatenated. `docker run img foo` replaces **CMD** with `foo` but keeps ENTRYPOINT. `--entrypoint` overrides ENTRYPOINT. If only CMD is set, run args replace it wholesale. Shell form of ENTRYPOINT (`ENTRYPOINT node app`) ignores CMD entirely and breaks signals — avoid.

## 7. Production / Performance Notes

- **Order for cache:** base → system deps → language deps (from lockfile) → app source. Source changes must not invalidate the dependency install. (Full treatment in topic 06.)
- **One logical `RUN` per concern, cleaned in the same layer:** `RUN apt-get update && apt-get install -y --no-install-recommends X && rm -rf /var/lib/apt/lists/*`. A separate `rm` in a later layer does **not** shrink the image — the bytes are already committed.
- **Non-root by default.** `USER` + a numeric UID also satisfies Kubernetes `runAsNonRoot`. Create the user in the same image, `chown` copied files as needed (`COPY --chown=appuser:appuser`).
- **`.dockerignore` is mandatory.** It shrinks the build context sent to the daemon (`.git`, `node_modules`, `__pycache__`, secrets) — faster builds and no accidental secret leaks.
- **Pin bases** by tag+digest (`python:3.12-slim@sha256:…`) for reproducibility and supply-chain safety.
- **HEALTHCHECK** feeds orchestrators; keep the probe cheap and set sane `--interval`/`--retries`. Use `HEALTHCHECK NONE` to disable one inherited from a base.
- **`EXPOSE` publishes nothing** — it is documentation and drives `-P`. Real publishing is `-p host:container` or a Kubernetes Service.

## 8. Common Mistakes

1. ⚠️ **Shell-form CMD/ENTRYPOINT** so PID 1 is `/bin/sh`, swallowing `SIGTERM`. **Fix:** use exec (JSON array) form.
2. ⚠️ **`COPY . .` before installing deps**, busting the dependency cache on every source edit. **Fix:** copy the lockfile and install first, then copy source.
3. ⚠️ **Cleaning caches in a later `RUN`** (`RUN rm -rf /var/lib/apt/lists/*` on its own line) — image stays fat. **Fix:** clean in the same `RUN` that created the files.
4. ⚠️ **`ADD` for a plain local file/dir** — surprising auto-extraction and unclear intent. **Fix:** use `COPY`.
5. ⚠️ **Running as root.** **Fix:** add `USER`; `COPY --chown`.
6. ⚠️ **`ENV SECRET=…` or `ARG SECRET`** baking secrets into layers (`docker history` reveals them). **Fix:** use BuildKit `--secret` / `--mount=type=secret`.
7. ⚠️ **Thinking `EXPOSE` publishes the port.** **Fix:** publish with `-p`; EXPOSE is metadata.
8. ⚠️ **`FROM image:latest`**, making builds non-reproducible. **Fix:** pin a specific tag/digest.

## 9. Interview Questions

**Q: What is the difference between CMD and ENTRYPOINT, and how do they interact?**
A: ENTRYPOINT sets the fixed executable; CMD supplies default arguments (or the default command if no ENTRYPOINT). At runtime the container executes ENTRYPOINT + CMD concatenated. `docker run img <args>` replaces CMD but keeps ENTRYPOINT; `--entrypoint` overrides ENTRYPOINT. The idiomatic pattern is `ENTRYPOINT ["prog"]` + `CMD ["--default-flag"]` so the image behaves like a binary with overridable defaults.

**Q: What is the difference between shell form and exec form, and why does it matter?**
A: Shell form (`CMD prog arg`) runs via `/bin/sh -c`, so PID 1 is the shell and variables/globs are expanded; the shell does not forward signals, so `SIGTERM` from `docker stop` is ignored and shutdown isn't graceful. Exec form (`CMD ["prog","arg"]`) calls `execve` directly, making your process PID 1 and receiving signals. Use exec form for CMD/ENTRYPOINT; shell form only when you actually need shell features.

**Q: When should you use ADD instead of COPY?**
A: Almost never. Use ADD only for its two special behaviors: auto-extracting a **local** tar archive into the image, or fetching a remote URL (though `RUN curl`/`wget` with a checksum is usually clearer and cacheable). For everything else use COPY — it's predictable and has no surprising extraction/download side effects.

**Q: What is the difference between ARG and ENV?**
A: ARG is a build-time variable, supplied with `--build-arg`, available only during the build and **not** present in the running container. ENV sets an environment variable that persists into the container and into later build instructions. Never put secrets in ARG/ENV — both are recoverable from image history/config; use BuildKit secrets instead.

**Q: Why can `RUN rm -rf /some/cache` on its own line fail to shrink the image?**
A: Because layers are immutable diffs. The files were already committed by the earlier layer that created them; a later layer only records a "whiteout" deletion on top — the underlying bytes still ship in the earlier layer. To actually save space, create and delete within the **same** RUN instruction (or use a multi-stage build).

**Q: What does EXPOSE actually do?**
A: Nothing at the network level — it's metadata documenting which port the container listens on. It doesn't publish or open anything. Publishing is done at runtime with `-p host:container` (or `-P` to auto-map all EXPOSEd ports), or via a Kubernetes Service. It's useful for humans and for tooling that reads image metadata.

**Q: How does instruction ordering affect build performance? (senior)**
A: Docker caches each instruction keyed by the instruction text plus, for COPY/ADD, the checksum of the copied files. On a cache miss, that layer and **every** subsequent layer rebuild. So put the most stable instructions first (base, system packages) and the most volatile last (app source). Critically, install dependencies from the lockfile before copying source, so editing code doesn't reinstall dependencies.

**Q: How do you make an image run as non-root, and why does it matter? (senior)**
A: Create a user in the Dockerfile (`RUN adduser -D appuser` or use a base-provided user like `node`), set `USER appuser`, and `COPY --chown=appuser:appuser` files that must be writable. It matters for defense-in-depth: a container escape from a root process is far more dangerous, and platforms like Kubernetes can enforce `runAsNonRoot`. Prefer a numeric UID so the policy is satisfiable without `/etc/passwd` lookups.

**Q: How do you pass a secret to a build without leaking it into the image? (senior)**
A: Use BuildKit secret mounts: declare `# syntax=docker/dockerfile:1`, then `RUN --mount=type=secret,id=npmrc npm ci` and build with `--secret id=npmrc,src=.npmrc`. The secret is mounted only for that RUN and never written to a layer, unlike ARG/ENV/COPY which persist in image history.

**Q: What happens to PID 1 signal handling, and when do you need an init like tini?**
A: Your ENTRYPOINT process becomes PID 1, which has special semantics: default signal handlers are absent unless you install them, and it must reap zombie children. For simple single-process apps that handle SIGTERM this is fine. If your process spawns children or doesn't reap zombies, use a lightweight init — `docker run --init` (tini) or add tini as ENTRYPOINT — to forward signals and reap orphans.

**Q: Why prefer slim/distroless bases, and what's the trade-off?**
A: Smaller bases mean smaller attack surface, faster pulls, and fewer CVEs (distroless has no shell/package manager). The trade-off is debuggability — no shell means `docker exec sh` won't work, and Alpine's musl libc can break glibc-linked binaries or Python wheels. Mitigate with multi-stage builds (build on full, ship on distroless) and `:debug` variants when needed.

## 10. Practice

- [ ] Write a Dockerfile for a Python Flask app that copies `requirements.txt` and installs before copying source; verify with `docker history` that editing source doesn't reinstall deps.
- [ ] Convert a shell-form `ENTRYPOINT` to exec form and confirm `docker stop` now stops the container in under 1 second.
- [ ] Add a non-root `USER` and use `COPY --chown`; verify with `docker run img whoami`.
- [ ] Add a `HEALTHCHECK` and observe the `(healthy)` transition in `docker ps`.
- [ ] Use a BuildKit `--secret` mount to install from a private registry without the secret appearing in `docker history`.

## 11. Cheat Sheet

> [!TIP]
> **Dockerfile in one screen.** `FROM` (pin it) → `ARG` build-only / `ENV` runtime → `WORKDIR` (absolute) → copy **lockfile → install deps → copy source** (cache order) → `USER` non-root → `EXPOSE` (docs only) → `HEALTHCHECK` → `ENTRYPOINT` (the binary, exec form) + `CMD` (overridable args, exec form).
> • **Exec form `["a","b"]`** = direct process, gets signals. Shell form = `/bin/sh -c`, eats SIGTERM.
> • **CMD** = default args (overridable); **ENTRYPOINT** = fixed exe; runtime runs `ENTRYPOINT + CMD`.
> • **COPY** always; **ADD** only for local-tar-extract / URL.
> • Clean caches in the **same** `RUN`. Secrets via BuildKit `--mount=type=secret`, never ARG/ENV.
> • Always ship a `.dockerignore`.

**References:** Docker Dockerfile reference (docs.docker.com), Docker "Best practices for writing Dockerfiles", BuildKit documentation, Google distroless (GitHub)

---
*Docker Handbook — topic 05.*
