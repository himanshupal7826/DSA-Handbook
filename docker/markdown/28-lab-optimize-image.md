# 28 · Lab: Shrink a 1.2 GB Image to Under 100 MB

> **In one line:** Diagnose a bloated Node image with `docker history`/`dive`, then rebuild it multi-stage on a slim/distroless base until it's 12× smaller.

---

## 1. The Scenario

You inherit a Node service. The image is **1.2 GB**. Pulls take minutes on every deploy, the registry bill is climbing, and the security team flags hundreds of CVEs in the base OS. Your task: get it **under 100 MB** without changing app behavior.

Here is the starting artifact — a naive single-stage Dockerfile:

```dockerfile
# ❌ BEFORE — naive single-stage, 1.2 GB
FROM node:20

WORKDIR /app

# Copies node_modules, .git, logs, everything into the build context
COPY . .

# Installs dev + prod deps, keeps the npm cache, builds in place
RUN npm install
RUN npm run build

EXPOSE 3000
CMD ["node", "dist/server.js"]
```

Build it and measure:

```bash
docker build -t app:before .
docker images app:before --format '{{.Repository}}:{{.Tag}}  {{.Size}}'
```

```text
app:before  1.21GB
```

Three separate sins are stacked here: a **fat base** (`node:20` is Debian + full toolchain, ~1.1 GB before your code), **dev dependencies and build tooling shipped to production**, and a **dirty build context** (`.git`, local `node_modules`, logs all copied in). We'll diagnose each, then remove it.

## 2. Approach

A senior doesn't guess — they **measure per layer first**, then attack the biggest offenders in order:

1. **Attribute the bytes.** `docker history` shows size per layer; `dive` shows *which files* each layer added and your "efficiency score." You can't shrink what you haven't measured.
2. **Shrink the base.** `node:20` (Debian) → `node:20-slim` → `node:20-alpine`, and for the *final* stage a **distroless** or `alpine` runtime that has no shell, no apt, no compilers.
3. **Separate build from runtime with a multi-stage build.** Compile with the full toolchain in a builder stage; copy only `dist/` + production `node_modules` into a tiny runtime stage. Build tools never reach production.
4. **Stop copying junk** with a `.dockerignore` — this also fixes cache invalidation, since a changed log file no longer busts every layer.
5. **Install prod-only deps** deterministically (`npm ci --omit=dev`) and drop the npm cache in the same layer.

Order matters: multi-stage + a slim runtime base gives ~90% of the win; `.dockerignore` and cache cleanup harvest the rest.

## 3. Solution

```dockerfile
# ✅ AFTER — multi-stage, distroless runtime, ~85 MB
# syntax=docker/dockerfile:1

# ---------- Stage 1: builder (full toolchain, thrown away) ----------
FROM node:20-slim AS builder
WORKDIR /app

# Copy only manifests first so this layer caches until deps change
COPY package.json package-lock.json ./
# Deterministic install of ALL deps (build needs devDependencies)
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# Now copy source and build
COPY . .
RUN npm run build

# Recompute node_modules with PROD deps only, for the runtime stage
RUN npm ci --omit=dev

# ---------- Stage 2: runtime (tiny, no shell, no npm) ----------
FROM gcr.io/distroless/nodejs20-debian12 AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Copy ONLY the built app + production dependencies
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

EXPOSE 3000
# distroless has no shell — use exec-form CMD; the base's entrypoint is `node`
CMD ["dist/server.js"]
```

And the `.dockerignore` that keeps the build context clean:

```text
node_modules
npm-debug.log
.git
.gitignore
Dockerfile
.dockerignore
dist
coverage
*.md
.env*
logs
```

Build and compare:

```bash
docker build -t app:after .
docker images 'app:*' --format '{{.Tag}}\t{{.Size}}'
```

```text
before  1.21GB
after   84.7MB
```

## 4. Walkthrough

**Why measure with `docker history` first.** It breaks the image into layers with sizes:

```bash
docker history app:before --no-trunc --format '{{.Size}}\t{{.CreatedBy}}' | head
```

```text
0B       CMD ["node" "dist/server.js"]
0B       EXPOSE 3000
310MB    RUN npm install          ← dev deps + npm cache
120MB    RUN npm run build        ← build artifacts + intermediates
78MB     COPY . .                 ← .git, local node_modules, logs
1.1GB    /bin/sh -c #(nop) ... node:20 base
```

The base alone is **1.1 GB** and `npm install` adds **310 MB** — those two are the targets. For file-level detail, `dive` shows *wasted space* (files added in one layer, deleted in a later one) and gives an efficiency percentage:

```bash
dive app:before          # interactive TUI
CI=true dive app:before  # non-interactive, prints score, good for pipelines
```

**Why `node:20-slim` in the builder.** The builder is discarded, so its size barely matters for the final image — but a smaller base still pulls and warms cache faster. `slim` drops docs, man pages, and extra packages while keeping enough to run `npm`.

**Why distroless for runtime.** `gcr.io/distroless/nodejs20-debian12` ships the Node runtime and its shared libraries and *nothing else* — no shell, no package manager, no busybox. That is why the runtime image is ~85 MB and has a near-zero OS attack surface. The trade-off: you can't `docker exec ... sh` into it (see Variations).

**Why copy `node_modules` and `dist` separately from the builder.** Only the two directories production actually needs cross the stage boundary. Build tools, source, test files, and devDependencies stay in the discarded builder. This is the single biggest lever.

**Why `npm ci --omit=dev` and the cache mount.** `npm ci` installs *exactly* what `package-lock.json` pins — reproducible and fast. `--omit=dev` skips devDependencies. `--mount=type=cache,target=/root/.npm` (BuildKit) keeps the download cache *outside* the layer, so it speeds rebuilds without adding a byte to the image.

**Why manifests are copied before source.** `COPY package*.json` then `RUN npm ci` sits above `COPY . .`. Editing application code doesn't change the manifests, so Docker reuses the cached dependency layer — installs only re-run when dependencies actually change.

Here is where the bytes went, layer by layer:

```svg
<svg viewBox="0 0 720 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="180" y="24" text-anchor="middle" fill="#1e293b" font-weight="700">BEFORE — 1.21 GB</text>
  <rect x="60" y="40" width="240" height="120" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="180" y="72" text-anchor="middle" fill="#1e293b">node:20 base</text>
  <text x="180" y="92" text-anchor="middle" fill="#64748b">1.1 GB</text>
  <rect x="60" y="168" width="240" height="44" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="180" y="195" text-anchor="middle" fill="#1e293b">npm install (dev + cache) 310 MB</text>
  <rect x="60" y="220" width="240" height="34" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="180" y="241" text-anchor="middle" fill="#1e293b">COPY . . (.git, logs) 78 MB</text>

  <line x1="320" y1="150" x2="400" y2="150" stroke="#475569" stroke-width="2" marker-end="url(#ah)"/>
  <text x="360" y="142" text-anchor="middle" fill="#059669" font-weight="700">14×</text>

  <text x="540" y="24" text-anchor="middle" fill="#1e293b" font-weight="700">AFTER — 85 MB</text>
  <rect x="420" y="40" width="240" height="70" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="540" y="70" text-anchor="middle" fill="#1e293b">distroless/nodejs20</text>
  <text x="540" y="90" text-anchor="middle" fill="#64748b">~70 MB (no shell/apt)</text>
  <rect x="420" y="118" width="240" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="540" y="139" text-anchor="middle" fill="#1e293b">node_modules (prod only) 12 MB</text>
  <rect x="420" y="160" width="240" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="540" y="179" text-anchor="middle" fill="#1e293b">dist/ 3 MB</text>
  <text x="540" y="230" text-anchor="middle" fill="#64748b">builder stage (toolchain, dev deps)</text>
  <text x="540" y="248" text-anchor="middle" fill="#64748b">is discarded — 0 bytes shipped</text>
</svg>
```

## 5. Variations & Follow-ups

**Python instead of Node.** Same pattern, different bases. Build wheels in a `python:3.12-slim` builder, copy the installed site-packages into a distroless or slim runtime:

```dockerfile
FROM python:3.12-slim AS builder
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

FROM gcr.io/distroless/python3-debian12
COPY --from=builder /install /usr/local
COPY . /app
WORKDIR /app
CMD ["main.py"]
```

**Alpine instead of distroless** when you need a shell for debugging but still want small: `node:20-alpine` (~135 MB with your app). Watch for musl-vs-glibc issues with native modules (`bcrypt`, `sharp`) — they may need `apk add --no-cache libc6-compat` or a glibc-based slim base.

**Debugging a distroless image.** No shell means no `docker exec ... sh`. Attach an ephemeral debug container that shares the target's namespaces:

```bash
docker run -it --pidns container:<id> --net container:<id> nicolaka/netshoot
# or on Kubernetes: kubectl debug -it <pod> --image=busybox --target=<container>
```

**Squashing / `--output`.** BuildKit can export a flattened image, but multi-stage already gives you a clean single runtime layer set — prefer it over `--squash`.

## 6. Verify It Works

Confirm the app still runs and the size dropped:

```bash
docker run -d -p 3000:3000 --name app-check app:after
sleep 2
curl -sf http://localhost:3000/health && echo "  OK"
docker rm -f app-check
```

```text
{"status":"ok"}  OK
```

Assert the size ceiling in a script (fails the build if over 100 MB):

```bash
BYTES=$(docker image inspect app:after --format '{{.Size}}')
MB=$((BYTES / 1000000))
echo "Image is ${MB} MB"
[ "$MB" -lt 100 ] && echo "PASS: under 100 MB" || { echo "FAIL"; exit 1; }
```

```text
Image is 85 MB
PASS: under 100 MB
```

Confirm build tooling is gone from the runtime image:

```bash
docker run --rm --entrypoint /busybox/sh app:after -c 'ls /usr/bin/npm' 2>&1 || echo "npm absent (expected)"
```

```text
npm absent (expected)
```

## 7. Pitfalls

1. ⚠️ **Copying the whole context without `.dockerignore`.** A local `node_modules` or `.git` can add hundreds of MB *and* bust the build cache on every commit. Add `.dockerignore` first — it's the cheapest win.
2. ⚠️ **Running `npm install` instead of `npm ci`.** `install` can drift from the lockfile and mutate it. `ci` is reproducible and fails loudly if the lock is stale.
3. ⚠️ **Cleaning caches in a *separate* `RUN`.** `RUN rm -rf /var/cache` in a new layer doesn't shrink anything — the bytes still live in the earlier layer. Delete in the *same* `RUN` that created them, or use BuildKit cache mounts.
4. ⚠️ **Shipping devDependencies.** TypeScript, ESLint, test frameworks, and `@types/*` have no place in production. Use `--omit=dev` and copy only the prod `node_modules` across stages.
5. ⚠️ **Shell-form `CMD` on distroless.** `CMD node dist/server.js` needs `/bin/sh`, which distroless lacks — the container won't start. Use exec form: `CMD ["dist/server.js"]`.
6. ⚠️ **Optimizing the base but forgetting the layers.** A slim base wrapped around a 300 MB `npm install` layer is still fat. Attribute every layer with `docker history` before declaring victory.

## 8. Interview Follow-ups

**Q: What does a multi-stage build actually do to reduce image size?**
A: It lets you use a heavy toolchain in a `builder` stage and then `COPY --from=builder` only the finished artifacts into a clean, minimal final stage. Everything in intermediate stages — compilers, dev deps, source, caches — is discarded and never contributes to the shipped image.

**Q: How do you find which layer is responsible for the bloat?**
A: `docker history <image>` attributes size per layer against the command that created it. For file-level detail and wasted-space (files added then deleted in a later layer), use `dive`, which also gives an efficiency score and can run in CI with `CI=true`.

**Q: Distroless vs Alpine vs slim — how do you choose?**
A: Distroless is smallest and most secure (no shell, no package manager) but hard to debug and can't run shell-form commands. Alpine is small and has a shell but uses musl libc, which can break glibc-native modules. `-slim` is a Debian base with docs/extras stripped — largest of the three but most compatible. Choose distroless for locked-down prod, alpine when you need a shell and have no native-libc issues, slim when compatibility trumps size.

**Q: Why does copying `package.json` before the source code matter?**
A: Layer caching. Docker invalidates a layer and everything after it when its inputs change. If you copy manifests and install deps *before* copying source, editing code doesn't invalidate the dependency layer, so installs are skipped on most rebuilds.

**Q: Why doesn't `RUN rm -rf` in a later layer shrink the image?**
A: Image layers are additive and immutable. Deleting a file in a later layer only adds a whiteout marker; the original bytes still exist in the earlier layer and count toward image size. You must remove within the same `RUN`, or avoid writing the bytes to a layer at all via a cache mount.

**Q: What's the difference between build context size and image size?**
A: Build context is everything sent to the daemon (`COPY .` reads from it); a bloated context slows builds and can leak files even if unused. Image size is the sum of the final layers. `.dockerignore` shrinks the context; multi-stage and slim bases shrink the image.

**Q: How do you debug a container built on a distroless base?**
A: You can't `exec` a shell because there isn't one. Attach an ephemeral debug container sharing its PID/network namespaces (`docker run --pidns container:<id> nicolaka/netshoot`) or, on Kubernetes, `kubectl debug --image=busybox --target=<container>`.

**Q: What do BuildKit cache mounts buy you here?**
A: `--mount=type=cache` keeps package-manager caches (npm, pip, apt) *outside* the image layers but persistent across builds. Rebuilds reuse downloads for speed, yet the cache never bloats the final image.

**Q: The image is small but pulls are still slow — what next?**
A: Look at layer count and shared layers. Fewer, well-ordered layers that are shared across your images pull incrementally. Also consider a closer/faster registry, enabling registry-side layer dedup, and lazy-pulling technologies (eStargz / SOCI) so the container starts before every byte is present.

## 9. Cheat Sheet

> [!TIP]
> **Shrink an image, in order:**
> 1. `docker history <img>` + `dive <img>` — attribute the bytes.
> 2. Add `.dockerignore` (node_modules, .git, logs, dist).
> 3. Multi-stage: fat `builder` → tiny `runtime`; `COPY --from=builder` only artifacts + prod deps.
> 4. Runtime base: **distroless** (smallest, no shell) or `-alpine` / `-slim`.
> 5. `npm ci --omit=dev`; clean caches *in the same RUN* or use `--mount=type=cache`.
> 6. exec-form `CMD ["dist/server.js"]` on distroless.
> 7. Verify: `docker image inspect --format '{{.Size}}'` and run a smoke test.
>
> Rule of thumb: multi-stage + slim runtime = ~90% of the win.

**References:** Docker docs — Multi-stage builds & Best practices; Google GoogleContainerTools/distroless; `wagoodman/dive`; BuildKit cache mounts docs.

---
*Docker Handbook — topic 28.*
