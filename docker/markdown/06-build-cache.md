# 06 · Build Cache & Layer Optimization

> **In one line:** Docker caches each build instruction as a layer; the first cache miss invalidates every layer after it — so order stable things before volatile things and installs before source.

---

## 1. Overview

`docker build` is incremental. For each instruction it computes a **cache key** and, if an identical layer exists from a previous build, reuses it instead of re-executing. A clean rebuild of an unchanged Dockerfile can finish in milliseconds with every step marked `CACHED`. Understanding *what* forms that key — and *when* it breaks — is the difference between 2-second and 5-minute builds in CI.

The rule that governs everything: **the cache is a prefix.** Docker walks instructions top to bottom; the moment one instruction's key differs from the prior build, that layer is rebuilt and **all subsequent layers are rebuilt too**, even if their text is identical. There is no "resume in the middle." So a change high in the Dockerfile is expensive; a change at the bottom is cheap.

You reach for cache optimization whenever builds feel slow: dependencies reinstalling on every code change, CI without a warm cache, or images rebuilding fully after a trivial edit. The fixes are almost always about **ordering** (put volatile instructions last) and **cache-key hygiene** (copy only what an instruction needs). Modern **BuildKit** (default in current Docker) adds parallelism, `--mount=type=cache` for package-manager caches, and registry-backed cache import/export for CI.

## 2. Core Concepts

- **Layer cache** — each `FROM`/`RUN`/`COPY`/`ADD` produces a cacheable layer keyed deterministically.
- **Cache key for `RUN`** — the literal instruction **string** plus the parent layer's ID. Change the command text → miss. (The command's *effect*, e.g. a newer upstream package, is **not** re-checked — a correctness gotcha.)
- **Cache key for `COPY`/`ADD`** — the parent layer ID plus a **checksum of the file contents and metadata** being copied. Edit any copied file → miss.
- **Cache invalidation cascade** — the first miss invalidates that layer and **every** layer below it. Ordering is therefore a performance API.
- **Metadata instructions** (`ENV`, `WORKDIR`, `LABEL`, `USER`) — cheap, but changing them still invalidates everything after, since they alter the parent config.
- **`--no-cache`** — ignore all cache and rebuild from scratch (use when upstream `apt`/`apt-get update` state is stale).
- **Cache busting** — deliberately forcing a miss, e.g. `ARG CACHEBUST` + `--build-arg CACHEBUST=$(date +%s)` before a step you want re-run.
- **BuildKit cache mounts** — `RUN --mount=type=cache,target=/root/.cache/pip …` persists a package cache **across builds** without baking it into a layer.
- **Registry cache** (`--cache-from`/`--cache-to`) — export/import the layer cache to a registry so ephemeral CI runners get warm caches.

## 3. Syntax & Examples

Cache-hostile order — every code edit reinstalls all dependencies:

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY . .                       # ← source + package.json in ONE layer
RUN npm ci                     # ← re-runs whenever ANY file changes
```

Cache-friendly order — dependencies survive source edits:

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./   # changes rarely
RUN npm ci                               # CACHED unless lockfile changes
COPY . .                                 # volatile source, isolated
```

BuildKit cache mount — keep the package cache warm without shipping it:

```dockerfile
# syntax=docker/dockerfile:1
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt
COPY . .
```

Build-time controls:

```bash
docker build -t app .                     # normal, uses cache
docker build --no-cache -t app .          # ignore cache entirely
docker build --build-arg CACHEBUST=$(date +%s) -t app .   # bust from a point
# CI: warm cache from the registry
docker build --cache-from type=registry,ref=acme/app:cache \
             --cache-to   type=registry,ref=acme/app:cache,mode=max \
             -t acme/app:1.0 .
```

## 4. Worked Example

Two consecutive builds of the cache-friendly Node image, editing only `src/index.js` in between.

**Build 1 (cold):**

```text
=> [1/4] FROM node:20-slim                              2.1s
=> [2/4] COPY package.json package-lock.json ./         0.1s
=> [3/4] RUN npm ci                                    28.4s
=> [4/4] COPY . .                                        0.3s
=> exporting to image                                    1.2s
Total: 32.1s
```

**Build 2 (after editing only `src/index.js`):**

```text
=> CACHED [1/4] FROM node:20-slim                       0.0s
=> CACHED [2/4] COPY package.json package-lock.json ./  0.0s
=> CACHED [3/4] RUN npm ci                              0.0s   ← 28s saved
=> [4/4] COPY . .                                        0.3s   ← only this reran
=> exporting to image                                    0.9s
Total: 1.3s
```

The lockfile was untouched, so `COPY package*.json` and the 28-second `npm ci` both hit cache. Only the final `COPY . .` (whose checksum changed) and the export reran. Now compare the **cache-hostile** version: the single `COPY . .` sits *above* `npm ci`, so editing `index.js` changes that layer's checksum and cascades — `npm ci` reruns for 28 seconds every time.

## 5. Under the Hood

Docker evaluates instructions in order, comparing each computed cache key against cached layers. It reuses layers until the first mismatch, then rebuilds that layer and everything below.

```svg
<svg viewBox="0 0 760 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="380" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">Cache-hit / miss cascade (edited only source)</text>

  <!-- hostile column -->
  <text x="200" y="52" text-anchor="middle" fill="#64748b" font-weight="600">COPY . . before install  →  cascade</text>
  <rect x="90" y="65" width="220" height="34" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="200" y="87" text-anchor="middle" fill="#1e293b">FROM node:20-slim ✓ hit</text>
  <rect x="90" y="107" width="220" height="34" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="200" y="129" text-anchor="middle" fill="#1e293b">COPY . .  ✗ MISS (src changed)</text>
  <rect x="90" y="149" width="220" height="34" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="200" y="171" text-anchor="middle" fill="#b91c1c">RUN npm ci  ✗ rebuild (28s)</text>
  <rect x="90" y="191" width="220" height="34" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="200" y="213" text-anchor="middle" fill="#b91c1c">RUN build  ✗ rebuild</text>
  <line x1="200" y1="99" x2="200" y2="107" stroke="#475569" marker-end="url(#a)"/>
  <line x1="200" y1="141" x2="200" y2="149" stroke="#475569" marker-end="url(#a)"/>
  <line x1="200" y1="183" x2="200" y2="191" stroke="#475569" marker-end="url(#a)"/>
  <text x="200" y="248" text-anchor="middle" fill="#b91c1c" font-weight="600">miss cascades down ▼</text>

  <!-- friendly column -->
  <text x="560" y="52" text-anchor="middle" fill="#64748b" font-weight="600">deps before source  →  cache holds</text>
  <rect x="450" y="65" width="220" height="34" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="560" y="87" text-anchor="middle" fill="#1e293b">FROM node:20-slim ✓ hit</text>
  <rect x="450" y="107" width="220" height="34" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="560" y="129" text-anchor="middle" fill="#1e293b">COPY package*.json ✓ hit</text>
  <rect x="450" y="149" width="220" height="34" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="560" y="171" text-anchor="middle" fill="#059669">RUN npm ci ✓ CACHED (0s)</text>
  <rect x="450" y="191" width="220" height="34" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="560" y="213" text-anchor="middle" fill="#1e293b">COPY . . ✗ MISS (only this)</text>
  <line x1="560" y1="99" x2="560" y2="107" stroke="#475569" marker-end="url(#a)"/>
  <line x1="560" y1="141" x2="560" y2="149" stroke="#475569" marker-end="url(#a)"/>
  <line x1="560" y1="183" x2="560" y2="191" stroke="#475569" marker-end="url(#a)"/>
  <text x="560" y="248" text-anchor="middle" fill="#059669" font-weight="600">miss isolated at bottom ✓</text>

  <rect x="90" y="278" width="580" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="380" y="302" text-anchor="middle" fill="#1e293b">Cache key:  RUN → instruction text + parent layer ID</text>
  <text x="380" y="322" text-anchor="middle" fill="#1e293b">COPY/ADD → parent layer ID + checksum of copied file contents</text>
</svg>
```

## 6. Variations & Trade-offs

| Technique | What it does | Use when | Cost / caveat |
|---|---|---|---|
| Deps-before-source ordering | Keeps install layer cached across code edits | Always | None — pure win |
| `--mount=type=cache` (BuildKit) | Persists pkg cache between builds, not in image | Slow `npm/pip/apt/go` downloads | Needs BuildKit; cache is host-local |
| `--no-cache` | Rebuilds everything | Stale `apt` indexes, "works on my machine" drift | Slow; use sparingly |
| `ARG CACHEBUST` | Forces a miss from a chosen point | Re-run `git clone`/`apt update` on demand | Manual; cascades below it |
| `--cache-from/--cache-to` registry | Shares cache across CI runners | Ephemeral CI with no local layer store | Network transfer; `mode=max` exports intermediate layers |
| Combining `RUN` steps | Fewer layers, atomic cleanup | Reduce image size | Coarser cache granularity |

**Trade-off in one line:** more/smaller layers = finer cache granularity but larger image and more overhead; fewer/bigger layers = smaller image but a change re-runs more work. Order by volatility to get the best of both.

## 7. Production / Performance Notes

- **A tight `.dockerignore` is a cache tool, not just a size tool.** If `.git`, logs, or build artifacts are in the context, `COPY . .` checksums them and misses on every commit. Exclude everything the image doesn't need.
- **Pin dependency lockfiles** and copy *only* the lockfile before install. Copying the whole app before `npm ci`/`pip install` is the #1 cause of slow builds.
- **`apt-get update` staleness:** because `RUN` caches on text alone, `RUN apt-get update` may serve a months-old package index from cache. Always combine `update && install` in one `RUN`, and periodically `--no-cache` or bump a base pin so security updates land.
- **CI needs a warm cache.** Fresh runners have empty local caches — every build is cold. Use `--cache-from`/`--cache-to` with a registry (or your CI's layer-cache feature) so `npm ci` stays `CACHED`.
- **BuildKit runs independent stages in parallel** and only builds the layers a `--target` needs — free speedups over the legacy builder. Enable with `DOCKER_BUILDKIT=1` (default in recent Docker).
- **Cache mounts vs. layers:** `--mount=type=cache` keeps a package download cache warm *without* the bytes ending up in the final image — smaller image and faster installs simultaneously.
- **Measure with `docker build --progress=plain`** to see which steps say `CACHED`; `docker history` shows per-layer size to find bloat.

## 8. Common Mistakes

1. ⚠️ **`COPY . .` before installing dependencies** — every source edit reinstalls everything. **Fix:** copy the lockfile, install, then copy source.
2. ⚠️ **No `.dockerignore`** so `.git`/`node_modules`/logs pollute the context and bust `COPY` checksums each commit. **Fix:** add a comprehensive `.dockerignore`.
3. ⚠️ **`RUN apt-get update` in its own layer**, then serving a stale cached index for months. **Fix:** `RUN apt-get update && apt-get install …` in one instruction; refresh with `--no-cache`.
4. ⚠️ **Reaching for `--no-cache` to "fix" slow builds**, throwing away every reusable layer. **Fix:** diagnose ordering; only use `--no-cache` for genuine upstream staleness.
5. ⚠️ **Embedding volatile data high up** (a build timestamp, `ARG` that always changes) so the whole build cascades. **Fix:** move volatile inputs as low as possible.
6. ⚠️ **Expecting warm cache in CI** on ephemeral runners. **Fix:** import/export cache via `--cache-from`/`--cache-to` or a registry.
7. ⚠️ **Assuming the cache re-checks upstream state** — it keys on text, so a new upstream release won't rebuild `RUN pip install foo`. **Fix:** pin versions or bust cache deliberately when you want the update.

## 9. Interview Questions

**Q: What exactly forms the cache key for a RUN versus a COPY instruction?**
A: For `RUN`, the key is the literal instruction string plus the parent layer's ID — Docker does **not** inspect what the command actually downloads or produces. For `COPY`/`ADD`, the key is the parent layer ID plus a checksum of the contents and metadata of the files being copied. So a `RUN` reruns only when its text (or a preceding layer) changes, while a `COPY` reruns whenever the copied files change.

**Q: What is the cache invalidation cascade?**
A: Docker reuses cached layers as a prefix — top to bottom until the first cache miss. Once one instruction misses, that layer and **every** instruction after it are rebuilt, regardless of whether their text changed, because each layer's key includes its parent's ID. The practical consequence: put stable instructions first and volatile ones last.

**Q: Why should you copy the lockfile and install dependencies before copying the source?**
A: Source code changes far more often than dependencies. If `COPY . .` sits above the install step, every code edit changes that layer's checksum and cascades into a full dependency reinstall. Copying only `package.json`/`requirements.txt` first isolates the install in a layer that stays cached until the lockfile itself changes, so routine code edits skip the expensive install.

**Q: When is `--no-cache` the right tool, and what's the downside?**
A: Use it when the cache would serve stale upstream state — e.g. `apt-get update` indexes or a `git clone` that the text-based key can't detect changed — or to reproduce a clean build. The downside is you discard every reusable layer and pay the full build time, so it's a targeted tool, not a default.

**Q: How do you deliberately bust the cache from a specific point? (senior)**
A: Introduce an `ARG` above the step and pass a changing value: `ARG CACHEBUST` then `RUN git clone …`, built with `--build-arg CACHEBUST=$(date +%s)`. Because the ARG's value changes, that layer and everything below rebuild, while everything above stays cached. It's the controlled inverse of ordering-for-cache.

**Q: A `RUN apt-get install nginx` keeps giving an old version even after upstream released a new one. Why, and how do you fix it? (senior)**
A: The RUN cache keys on instruction text plus parent layer, not on upstream repository state, so Docker happily reuses the old layer. Fixes: combine `apt-get update && apt-get install` in one RUN (so a changed base or `--no-cache` refreshes the index), pin/bump the exact version in the instruction (changing the text busts the cache), or build with `--no-cache` when you specifically want the latest.

**Q: How do BuildKit cache mounts differ from layer caching? (senior)**
A: Layer caching reuses a whole committed layer keyed by instruction. A cache **mount** (`RUN --mount=type=cache,target=…`) is a persistent directory shared across builds that holds a package manager's download cache — it speeds up the install even on a cache miss and is **not** committed into the image, so the final image stays small. They're complementary: ordering keeps layers cached; cache mounts make the occasional reinstall fast and lean.

**Q: Your CI builds are always slow despite a well-ordered Dockerfile. Why, and what do you do? (senior)**
A: CI runners are usually ephemeral with an empty local layer store, so every build is cold. Provide a warm cache by exporting/importing to a registry with `--cache-from type=registry,ref=…` and `--cache-to …,mode=max` (or use the CI provider's layer-cache feature). `mode=max` also exports intermediate stage layers, which matters for multi-stage builds.

**Q: Why is `.dockerignore` relevant to build caching, not just image size?**
A: `COPY . .` checksums everything in the build context. If `.git`, log files, or previous build outputs are included, that checksum changes on nearly every commit, invalidating the COPY layer and everything below it. A tight `.dockerignore` keeps the context stable so the copy layer stays cached, and it also shrinks the context uploaded to the daemon.

**Q: What's the trade-off between many small layers and few large layers?**
A: Many small layers give finer cache granularity (a change re-runs less) but increase image size and metadata overhead, and can duplicate cleanup problems. Few large layers keep the image smaller and allow atomic cleanup within one RUN, but any change re-runs the whole chunk. The resolution is to group by change frequency: coalesce steps that always change together, and split out steps that change at different rates.

## 10. Practice

- [ ] Take a Dockerfile with `COPY . .` before install, reorder it deps-first, and time both builds after a one-line source edit.
- [ ] Add a `--mount=type=cache` for pip/npm and measure the install time on a cache miss versus without it.
- [ ] Introduce an `ARG CACHEBUST` and prove with `--progress=plain` that only layers below it rebuild.
- [ ] Configure `--cache-from`/`--cache-to` against a local registry and show a second "cold" runner getting `CACHED` steps.
- [ ] Write a `.dockerignore`, then use `docker build --progress=plain` to confirm the `COPY . .` layer stays cached across an unrelated `.git` change.

## 11. Cheat Sheet

> [!TIP]
> **Build cache in one screen.** Docker reuses layers top-to-bottom until the **first miss**, then rebuilds it and everything below (the cascade). **RUN** keys on instruction text + parent; **COPY/ADD** keys on file checksum + parent.
> • Golden order: base → system deps → **lockfile → install** → source → build. Volatile last.
> • `.dockerignore` keeps `COPY` checksums stable — it's a cache tool.
> • `RUN apt-get update && install` in one layer (text-only key = stale indexes otherwise).
> • `--no-cache` = nuke cache (stale upstream only). `ARG CACHEBUST=$(date +%s)` = bust from a point.
> • BuildKit: `--mount=type=cache` warms pkg cache off-image; `--cache-from/--cache-to` warms CI.
> • Diagnose with `--progress=plain` (look for `CACHED`) and `docker history` (size).

**References:** Docker "Optimizing builds with cache" (docs.docker.com), BuildKit docs (github.com/moby/buildkit), Docker build best practices, "Build cache invalidation" reference

---
*Docker Handbook — topic 06.*
