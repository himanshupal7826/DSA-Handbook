# 09 · BuildKit & Advanced Builds

> **In one line:** BuildKit turns the Dockerfile into a parallel dependency graph and adds mounts for caches, secrets, and SSH — plus multi-platform builds — so builds are faster, safer, and reproducible.

---

## 1. Overview

The classic Docker builder executed a Dockerfile **top to bottom, one instruction at a time**, with no visibility into what actually depended on what. **BuildKit** (default since Docker 23, and the engine behind `docker buildx`) replaces it with a solver that parses the whole Dockerfile into a **DAG** of build operations (LLB — low-level build). Independent stages run **in parallel**, unneeded stages are **skipped**, and only the outputs you request are produced.

On top of the graph, BuildKit adds first-class **mounts** that the old builder couldn't do safely: `--mount=type=cache` persists package-manager caches *across* builds without baking them into a layer; `--mount=type=secret` injects credentials that never land in the image or its history; `--mount=type=ssh` forwards your agent to clone private repos. It also unifies **multi-platform** builds (one `docker buildx build --platform linux/amd64,linux/arm64`) via emulation or native nodes, and exports **cache to registries** so CI runners share build cache.

You reach for BuildKit whenever build speed, secret hygiene, or multi-arch images matter — which is nearly always in a real CI/CD pipeline.

## 2. Core Concepts

- **LLB / the build graph** — BuildKit compiles the Dockerfile into a content-addressed DAG; nodes with no dependency edge between them run concurrently.
- **`docker buildx`** — the CLI plugin exposing BuildKit features (builders, multi-platform, cache export); `DOCKER_BUILDKIT=1` enables the engine for plain `docker build`.
- **`--mount=type=cache`** — a persistent, build-only directory (e.g. `/root/.cache`, `apt` lists) reused across builds but never committed to a layer.
- **`--mount=type=secret`** — a file/env exposed only during one `RUN`, never written to any layer or `docker history`.
- **`--mount=type=ssh`** — forwards the host SSH agent into a `RUN` so `git clone git@...` works without copying keys.
- **`--mount=type=bind`** — mounts a build-context path or another stage read-only, avoiding a `COPY` layer.
- **Multi-platform (`--platform`)** — builds for several CPU architectures; foreign arches run via **QEMU** emulation or native builder nodes.
- **Manifest list** — a multi-platform build pushes one tag whose index points to per-arch images; clients auto-pick their arch.
- **Cache export/import** — `--cache-to`/`--cache-from` (registry, `inline`, `local`, `gha`) share build cache between machines and CI runs.
- **`--secret`/`--ssh` build flags** — the client side that provides the secret/agent the Dockerfile mount consumes.

## 3. Syntax & Examples

Enable BuildKit and create a builder:

```bash
export DOCKER_BUILDKIT=1              # engine for plain `docker build`
docker buildx create --use --name mybuilder   # a buildx builder instance
docker buildx inspect --bootstrap
```

**Cache mount** — keep the package cache warm across builds:

```dockerfile
# syntax=docker/dockerfile:1.7
FROM python:3.12-slim
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt
```

```dockerfile
# apt with a locked, shared cache
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends build-essential
```

**Secret mount** — a token that never enters the image:

```dockerfile
# syntax=docker/dockerfile:1.7
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc \
    npm ci
```
```bash
docker buildx build --secret id=npmrc,src=$HOME/.npmrc -t app .
```

**SSH mount** — clone a private repo:

```dockerfile
RUN --mount=type=ssh git clone git@github.com:acme/private.git
```
```bash
docker buildx build --ssh default -t app .
```

**Multi-platform** — one command, two arches, pushed as one tag:

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -t registry.acme.io/app:1.4.0 --push .
```

**Inline / registry cache** for CI:

```bash
docker buildx build \
  --cache-to   type=registry,ref=registry.acme.io/app:buildcache,mode=max \
  --cache-from type=registry,ref=registry.acme.io/app:buildcache \
  -t registry.acme.io/app:1.4.0 --push .
```

## 4. Worked Example

A Node service where dependency install dominates build time. With a cache mount, repeated builds skip re-downloading packages:

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci
COPY . .
RUN --mount=type=secret,id=sentry_token,env=SENTRY_TOKEN \
    npm run build && npm run upload-sourcemaps

FROM gcr.io/distroless/nodejs20-debian12
COPY --from=build /app/dist /app
CMD ["/app/server.js"]
```

Build it, providing the secret from the environment:

```bash
SENTRY_TOKEN=xxxx docker buildx build \
  --secret id=sentry_token,env=SENTRY_TOKEN -t web:1.0 .
```

Observed timings (`npm ci` step):

| Build | Cache mount | `npm ci` time |
|---|---|---|
| First (cold) | miss | 48 s |
| Second (code change only) | **hit** | 6 s |

```text
=> CACHED [build 3/5] RUN --mount=type=cache,target=/root/.npm npm ci   0.0s
=> [build 4/5] COPY . .                                                 0.3s
=> [build 5/5] RUN --mount=type=secret,id=sentry_token ...              5.9s
```

Note the secret never appears in `docker history web:1.0` — only the `RUN` line, not its value.

## 5. Under the Hood

BuildKit parses each stage into LLB operations, builds a DAG, and the **solver** walks it: any two nodes without a dependency edge execute concurrently on the worker pool. In the graph below, the `frontend` and `backend` builder stages share no data, so they compile **in parallel**; the final stage waits only on the artifacts it copies.

```svg
<svg viewBox="0 0 720 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="22" text-anchor="middle" fill="#64748b">BuildKit solves the Dockerfile into a parallel DAG</text>

  <rect x="290" y="40" width="140" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="360" y="65" text-anchor="middle" fill="#1e293b">FROM node (base)</text>

  <rect x="60" y="130" width="200" height="52" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="160" y="152" text-anchor="middle" fill="#1e293b">frontend: npm build</text>
  <text x="160" y="170" text-anchor="middle" fill="#64748b" font-size="11">--mount=type=cache</text>

  <rect x="460" y="130" width="200" height="52" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="560" y="152" text-anchor="middle" fill="#1e293b">backend: go build</text>
  <text x="560" y="170" text-anchor="middle" fill="#64748b" font-size="11">runs concurrently</text>

  <line x1="330" y1="80" x2="180" y2="128" stroke="#475569" marker-end="url(#a)"/>
  <line x1="390" y1="80" x2="540" y2="128" stroke="#475569" marker-end="url(#a)"/>

  <rect x="250" y="234" width="220" height="52" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="360" y="256" text-anchor="middle" fill="#1e293b">final: distroless</text>
  <text x="360" y="274" text-anchor="middle" fill="#64748b" font-size="11">COPY --from both stages</text>

  <line x1="180" y1="182" x2="320" y2="232" stroke="#475569" marker-end="url(#a)"/>
  <line x1="540" y1="182" x2="400" y2="232" stroke="#475569" marker-end="url(#a)"/>

  <text x="30" y="112" fill="#059669" font-size="11">parallel ↔</text>
</svg>
```

**Mounts** are ephemeral filesystems attached only for the duration of a `RUN`. A `cache` mount lives in the builder's local store keyed by `target` and survives between builds but is *never* snapshotted into a layer — that's why the packages don't bloat the image. A `secret` mount is materialized from the client only during that step and torn down after, so it never reaches the layer's diff or `docker history`. This is the core safety win over the old anti-pattern of `COPY secret . && RUN use-it && RUN rm secret` (which leaves the secret in an earlier layer forever).

For **multi-platform**, BuildKit runs the build once per target platform. Foreign architectures execute through **QEMU** user-mode emulation (registered via `binfmt_misc`) or, faster, on native builder nodes of that arch. The results are assembled into a **manifest list** and pushed under one tag.

## 6. Variations & Trade-offs

| Feature | Old builder | BuildKit |
|---|---|---|
| Execution | sequential, all stages | parallel DAG, unused stages skipped |
| Package cache | baked into layer or lost | `--mount=type=cache`, persistent, not shipped |
| Secrets | leak into layers/history | `--mount=type=secret`, never persisted |
| Private git | copy keys (unsafe) | `--mount=type=ssh` agent forwarding |
| Multi-arch | one build per arch, manual manifest | `--platform a,b`, auto manifest list |
| Cache sharing | local only | registry/gha/local export & import |

**Cache backend trade-offs:** `inline` (`mode=min`) stores cache metadata *inside* the pushed image — simple, but only caches final layers. `registry` with `mode=max` stores cache for *every* stage as a separate ref — best reuse, extra storage and push time. `type=gha` uses GitHub Actions cache; `type=local` writes to disk for self-hosted runners.

**Emulation vs native:** QEMU is zero-setup but can be 3–10× slower for CPU-heavy compiles. For hot pipelines, use native arm64 runners (or Docker Build Cloud) and let buildx fan out across builder nodes.

## 7. Production / Performance Notes

- **Always pin the frontend**: start Dockerfiles with `# syntax=docker/dockerfile:1.7` so mount syntax and features are available and reproducible.
- **`sharing=locked` vs `shared`** on cache mounts: `locked` serializes concurrent builders touching the same cache (needed for apt/dpkg); `shared` (default) allows concurrent access.
- **Secrets: prefer `type=secret` over build-args.** `ARG`/`ENV` values are visible in `docker history` and image metadata; secret mounts are not.
- **Cache invalidation still follows layer order** — put `COPY package*.json` before `COPY . .` so a code change doesn't bust the dependency cache even with mounts.
- **Multi-platform requires `--push` (or `--output`)** — you can't `--load` a multi-arch result into the single-arch local daemon store.
- **Set `mode=max`** for CI cache export to reuse intermediate stages; `min` only caches the exported image's layers.
- **Register QEMU once per host**: `docker run --privileged --rm tonistiigi/binfmt --install all`.

## 8. Common Mistakes

1. ⚠️ **Passing secrets as `--build-arg`.** They're baked into image history and metadata. *Fix:* `--mount=type=secret` + `--secret`.
2. ⚠️ **Omitting the `# syntax=` directive.** Mount features silently fail to parse on older frontends. *Fix:* pin `docker/dockerfile:1.7`.
3. ⚠️ **`--platform` build with `--load`.** The local store holds one arch; the load errors. *Fix:* `--push` to a registry, or build one platform for local.
4. ⚠️ **Expecting cache-mount contents in the final image.** Cache mounts are build-only. *Fix:* if you need the files at runtime, `COPY`/install them normally.
5. ⚠️ **No cache-mount locking for apt.** Concurrent builders corrupt dpkg state. *Fix:* `sharing=locked` on apt cache mounts.
6. ⚠️ **Forgetting to register binfmt/QEMU.** Foreign-arch builds fail with `exec format error`. *Fix:* install `binfmt` handlers first.
7. ⚠️ **Using `inline` cache and wondering why intermediate stages re-run.** Inline only caches final layers. *Fix:* `--cache-to type=registry,mode=max`.

## 9. Interview Questions

**Q: What does BuildKit do differently from the legacy Docker builder?**
A: It compiles the whole Dockerfile into a content-addressed DAG (LLB) and solves it: independent stages run in parallel, unreferenced stages are skipped, and only requested outputs are built. It also adds cache/secret/ssh mounts, multi-platform builds, and cache import/export — none of which the sequential legacy builder supported safely.

**Q: How do you inject a secret into a build without it ending up in the image?**
A: Use `--mount=type=secret,id=foo` in the `RUN` and provide it with `--secret id=foo,src=...` (or `env=...`). The secret is mounted only for that step and torn down after, so it never becomes part of any layer or `docker history`. Build-args and `ENV`, by contrast, are visible in image metadata.

**Q: What's the difference between a cache mount and a normal layer?**
A: A `--mount=type=cache` directory persists across builds in the builder's store but is never snapshotted into a layer, so package caches speed rebuilds without bloating the image. A normal layer is committed and shipped. Cache mounts are build-only and won't exist at container runtime.

**Q: Explain how multi-platform images are built and distributed.**
A: `docker buildx build --platform linux/amd64,linux/arm64` builds once per arch — foreign arches via QEMU emulation or native nodes — then assembles the results into a manifest list (image index) pushed under a single tag. On pull, the client selects the image matching its architecture automatically.

**Q: Why does a multi-platform build need `--push` and can't use `--load`?**
A: The local image store holds a single architecture, so it can't represent a manifest list of multiple arches. `--push` sends the full index to a registry; `--load` only works for a single-platform build targeting the local daemon.

**Q: What's the risk of `COPY secret.txt` + `RUN use && rm secret.txt`?**
A: The `COPY` created a layer that still contains the secret even after the `rm` in a later layer (whiteout hides but doesn't remove the bytes). Anyone who pulls the image can extract it from history. Use `--mount=type=secret`, which never persists to any layer.

**Q: What is a Dockerfile cache mount's `sharing` mode and when do you need `locked`?**
A: `sharing=shared` (default) lets concurrent builds access the cache directory simultaneously; `locked` serializes them. You need `locked` for tools with non-concurrent-safe state like apt/dpkg, where two builders writing the same cache would corrupt it.

**Q: (Senior) Compare inline, registry, and gha cache backends.**
A: `inline` stores cache metadata inside the pushed image (`mode=min` only) — simple but caches just the final image layers. `registry` with `mode=max` stores cache for every stage as separate refs — best cross-runner reuse at the cost of storage/push time. `gha` uses GitHub Actions' cache service for CI; `local` writes to disk for self-hosted runners.

**Q: (Senior) How does BuildKit decide what can run in parallel?**
A: From the LLB DAG's dependency edges. Two operations run concurrently if neither transitively depends on the other's output — e.g. two builder stages that don't `COPY --from` each other. The final stage's `COPY --from` edges force it to wait only for those specific producers, not the whole file.

**Q: (Senior) How would you use `--mount=type=ssh` and why is it safer than copying keys?**
A: Add `RUN --mount=type=ssh git clone git@...` and build with `--ssh default`. BuildKit forwards the host SSH agent socket into that step only; the private key never enters the build context, a layer, or the image. Copying a key file would leave it recoverable in image history.

**Q: (Senior) You enabled a cache mount but CI builds are still slow. What do you check?**
A: CI runners are ephemeral, so the local cache mount starts empty each run. Export/import cache to a shared backend (`--cache-to/--cache-from type=registry,mode=max` or `gha`). Also verify layer ordering (deps before source), the `# syntax=` directive, and that `mode=max` is set so intermediate stages are cached, not just the final image.

## 10. Practice

- [ ] Add a `--mount=type=cache` to a `pip`/`npm` step and time a cold vs warm rebuild.
- [ ] Convert a build that used `--build-arg TOKEN` into `--mount=type=secret` and confirm the value is absent from `docker history`.
- [ ] Build a multi-platform image for `amd64` and `arm64` and inspect the manifest list with `docker buildx imagetools inspect`.
- [ ] Set up registry cache export/import and prove a second machine reuses the cache.
- [ ] Use `--mount=type=ssh` to clone a private repo during build without copying any key.

## 11. Cheat Sheet

> [!TIP]
> **BuildKit:** default in modern Docker; `DOCKER_BUILDKIT=1` or `docker buildx`. Start Dockerfiles with `# syntax=docker/dockerfile:1.7`. Parallel DAG — independent stages build concurrently. `RUN --mount=type=cache,target=...` persists pkg caches (build-only, not shipped; `sharing=locked` for apt). `RUN --mount=type=secret,id=x` + `--secret id=x,src=...` — never in layers/history. `RUN --mount=type=ssh` + `--ssh default` for private git. Multi-arch: `buildx build --platform linux/amd64,linux/arm64 --push` (QEMU or native → manifest list; `--load` is single-arch only). CI cache: `--cache-to/--cache-from type=registry,mode=max`.

**References:** Docker docs — "BuildKit" & "docker buildx"; `moby/buildkit` GitHub (Dockerfile frontend reference); Docker blog — multi-platform images; `tonistiigi/binfmt`.

---
*Docker Handbook — topic 09.*
