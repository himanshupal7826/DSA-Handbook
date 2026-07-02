# 07 · Multi-Stage Builds

> **In one line:** Use one heavy stage to *build* and a second minimal stage to *ship* — `COPY --from` carries only the artifact across, cutting images from gigabytes to megabytes.

---

## 1. Overview

A **multi-stage build** is a single Dockerfile with several `FROM` instructions. Each `FROM` starts a new **stage** with its own base and filesystem. The trick: a later stage can `COPY --from=<earlier-stage>` a specific artifact — a compiled binary, a `dist/` folder, a virtualenv — while **discarding everything else** from the build stage (compilers, dev headers, source, caches). Only the final stage becomes the image.

This solves the classic tension between **build-time** needs (JDK/gcc/go toolchain/node_modules, hundreds of MB) and **runtime** needs (just the artifact). Before multi-stage, teams either shipped a bloated image full of build tools or maintained brittle "builder" + "runtime" Dockerfiles glued together with shell scripts. Multi-stage puts both in one file, cache-friendly and reproducible.

You reach for it whenever the build environment is much bigger than the runtime environment — which is nearly always for compiled languages (Go, Rust, Java, C++) and for Node/Python where dev dependencies and package managers dwarf the runtime. The payoff is dramatic: a Go service goes from ~800 MB (golang base) to ~10 MB (scratch/distroless) with the exact same binary.

## 2. Core Concepts

- **Stage** — everything from one `FROM` up to the next. Each stage is independent; its intermediate layers are not shipped unless a later stage copies from them.
- **Named stages** — `FROM golang:1.22 AS builder` names a stage so later stages reference it by name rather than index.
- **`COPY --from=builder /src/app /app`** — copies files **out of another stage** (or `--from=<image>` to copy from an external image). Only what you name crosses over.
- **Final stage = the image** — the last `FROM` (or the one selected by `--target`) is what gets tagged. Earlier stages leave no bytes behind.
- **`--target <stage>`** — build only up to a named stage (`docker build --target builder`), handy for a "test"/"dev" stage or debugging.
- **Runtime base** — the final stage should be minimal: `scratch` (nothing), `distroless` (no shell/pkg mgr), or `alpine`/`slim`.
- **Parallelism** — with BuildKit, independent stages build concurrently; unused stages are skipped entirely.
- **Cache still applies per stage** — order each stage deps-before-source just like a single-stage build (topic 06).

## 3. Syntax & Examples

Minimal two-stage shape:

```dockerfile
FROM golang:1.22 AS builder      # heavy build stage
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -o /app ./cmd/server

FROM scratch                     # tiny runtime stage
COPY --from=builder /app /app
ENTRYPOINT ["/app"]
```

Named stages, `--from` an external image, and a shared base:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:20 AS base
WORKDIR /app
COPY package.json package-lock.json ./

FROM base AS deps                 # prod deps only
RUN npm ci --omit=dev

FROM base AS build                # full deps + compile
RUN npm ci
COPY . .
RUN npm run build                 # produces /app/dist

FROM gcr.io/distroless/nodejs20-debian12 AS runtime
WORKDIR /app
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist        ./dist
COPY --from=build /app/package.json ./
# copy a CA bundle straight out of an external image:
COPY --from=alpine:3.20 /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
USER nonroot
ENTRYPOINT ["dist/server.js"]
```

Targets:

```bash
docker build -t api:prod .                 # builds through the final stage
docker build --target build -t api:ci .    # stop at 'build' to run tests
docker build --target deps  -t api:deps .  # just the prod dependency layer
```

## 4. Worked Example

A Go HTTP service, single-stage vs multi-stage, same source.

**Single-stage (`Dockerfile.fat`):**

```dockerfile
FROM golang:1.22
WORKDIR /src
COPY . .
RUN go build -o /app ./cmd/server
CMD ["/app"]
```

**Multi-stage (`Dockerfile`):**

```dockerfile
FROM golang:1.22 AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download                       # cached unless go.* changes
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /app ./cmd/server

FROM gcr.io/distroless/static-debian12
COPY --from=builder /app /app
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/app"]
```

```bash
docker build -f Dockerfile.fat -t svc:fat .
docker build -f Dockerfile     -t svc:slim .
docker images | grep svc
```

Result — the runtime image is ~80× smaller and carries no shell, compiler, or source (so nothing to exploit):

```text
REPOSITORY   TAG    IMAGE ID       SIZE
svc          fat    9f3a1c22bd11   842MB
svc          slim   4e77b0a9c3de   11.4MB
```

`CGO_ENABLED=0` makes a static binary so `distroless/static` (or even `scratch`) needs no libc; `-ldflags="-s -w"` strips debug symbols. The `go mod download` layer stays cached across code edits because `go.mod`/`go.sum` are copied first.

## 5. Under the Hood

Each stage builds in isolation. `COPY --from` reaches into a finished stage's filesystem and pulls named paths into the current stage. Everything not copied — toolchain, source, caches — is left behind and never becomes part of the final image.

```svg
<svg viewBox="0 0 760 350" width="100%" height="350" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="m" markerWidth="10" markerHeight="10" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="380" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">Two-stage build: build heavy, ship light</text>

  <!-- builder stage -->
  <rect x="30" y="50" width="300" height="250" rx="10" fill="#eff6ff" stroke="#2563eb"/>
  <text x="180" y="72" text-anchor="middle" fill="#1e293b" font-weight="700">Stage 1: builder (golang:1.22)</text>
  <rect x="55" y="90" width="250" height="30" rx="6" fill="#ffffff" stroke="#2563eb"/>
  <text x="180" y="110" text-anchor="middle" fill="#1e293b">Go toolchain ~750MB</text>
  <rect x="55" y="128" width="250" height="30" rx="6" fill="#ffffff" stroke="#2563eb"/>
  <text x="180" y="148" text-anchor="middle" fill="#1e293b">source + go modules</text>
  <rect x="55" y="166" width="250" height="30" rx="6" fill="#ffffff" stroke="#2563eb"/>
  <text x="180" y="186" text-anchor="middle" fill="#1e293b">go build → /app (binary)</text>
  <rect x="55" y="220" width="250" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/>
  <text x="180" y="238" text-anchor="middle" fill="#1e293b" font-weight="600">/app  ← the only artifact</text>
  <text x="180" y="254" text-anchor="middle" fill="#64748b">~11MB static binary</text>
  <text x="180" y="288" text-anchor="middle" fill="#b91c1c">everything else discarded ✗</text>

  <!-- COPY --from arrow -->
  <line x1="330" y1="240" x2="440" y2="200" stroke="#059669" stroke-width="2" marker-end="url(#m)"/>
  <text x="385" y="205" text-anchor="middle" fill="#059669" font-weight="600">COPY --from=builder</text>

  <!-- runtime stage -->
  <rect x="440" y="120" width="290" height="180" rx="10" fill="#ecfdf5" stroke="#059669"/>
  <text x="585" y="142" text-anchor="middle" fill="#1e293b" font-weight="700">Stage 2: runtime (distroless)</text>
  <rect x="465" y="158" width="240" height="30" rx="6" fill="#ffffff" stroke="#059669"/>
  <text x="585" y="178" text-anchor="middle" fill="#1e293b">distroless/static ~2MB</text>
  <rect x="465" y="196" width="240" height="30" rx="6" fill="#ffffff" stroke="#059669"/>
  <text x="585" y="216" text-anchor="middle" fill="#1e293b">/app  (copied binary)</text>
  <rect x="465" y="234" width="240" height="30" rx="6" fill="#ffffff" stroke="#059669"/>
  <text x="585" y="254" text-anchor="middle" fill="#1e293b">USER nonroot · ENTRYPOINT</text>
  <text x="585" y="288" text-anchor="middle" fill="#059669" font-weight="700">= final image ~11MB</text>
</svg>
```

## 6. Variations & Trade-offs

| Runtime base | Size | Has shell? | Best for | Caveat |
|---|---|---|---|---|
| `scratch` | ~0 MB | no | Static Go/Rust binaries | No certs, no `/tmp`, no libc — copy them in |
| `distroless/static` | ~2 MB | no | Static binaries needing certs/tzdata | Debug via `:debug` variant only |
| `distroless/base` / `cc` | ~20 MB | no | glibc/CGO binaries | Still no shell |
| `alpine` | ~7 MB | yes (ash) | Need a shell; musl-compatible apps | musl ≠ glibc; some wheels/binaries break |
| `slim` (debian) | ~30–80 MB | yes | Python/Node needing glibc + easy debug | Larger; more CVE surface |

**Language patterns:**
- **Go/Rust:** compile static (`CGO_ENABLED=0`), ship on `scratch`/`distroless/static`. ~800 MB → ~10 MB.
- **Node:** `npm ci` (build) + `npm run build`, then copy `dist` + prod-only `node_modules` onto `distroless/nodejs` or `node:slim`. ~1.1 GB → ~150 MB.
- **Python:** build wheels / a venv in a `python:3.12` stage, `COPY --from` the venv onto `python:3.12-slim` (or use `--target` with uv/pip caches). ~1 GB → ~120 MB.

**Trade-off:** multi-stage adds Dockerfile complexity and requires you to know exactly which files the runtime needs (dynamic libs, certs, tzdata). The reward — smaller, faster-to-pull, lower-CVE images — is almost always worth it for anything shipped to production.

## 7. Production / Performance Notes

- **Cache each stage independently.** Copy `go.mod`/`package.json`/`requirements.txt` before source in the build stage so dependency resolution stays cached (topic 06). Multi-stage doesn't exempt you from ordering.
- **`--target` gives you free dev/test images.** Add a `FROM build AS test` stage running your suite; CI does `--build --target test`, prod does the full build — one Dockerfile, no duplication.
- **Copy the minimum.** List exact paths in `COPY --from`, not `COPY --from=build /app /app`, so stray caches/source don't leak into the runtime image.
- **Don't forget runtime essentials on `scratch`:** CA certificates (`/etc/ssl/certs/ca-certificates.crt`), timezone data, and a non-root user entry. Copy them from the builder or an `alpine` stage.
- **Static linking for tiny images:** `CGO_ENABLED=0` (Go), `--target x86_64-unknown-linux-musl` (Rust). If you need CGO/glibc, use `distroless/base` instead of `scratch`.
- **BuildKit builds stages in parallel** and prunes unreferenced stages — keeping optional stages (lint, test) in the file costs nothing for a prod build that doesn't target them.
- **Registry cache (`--cache-to mode=max`)** exports intermediate stage layers, which matters a lot for multi-stage CI so the build stage stays warm on fresh runners.

## 8. Common Mistakes

1. ⚠️ **Copying the whole build stage** (`COPY --from=build / /`) — reintroduces all the bloat. **Fix:** copy only the artifact paths you actually need.
2. ⚠️ **`scratch`/distroless with no CA certs**, so HTTPS/TLS calls fail with x509 errors. **Fix:** `COPY --from=… /etc/ssl/certs/ca-certificates.crt`.
3. ⚠️ **Dynamically linked binary on `scratch`** (missing libc) → "no such file or directory" on exec. **Fix:** static link (`CGO_ENABLED=0`) or use `distroless/base`.
4. ⚠️ **Copying `node_modules` with dev deps into runtime.** **Fix:** a separate `deps` stage with `npm ci --omit=dev`, copied into runtime.
5. ⚠️ **Poor stage ordering** copying source before deps, killing the cache in the build stage. **Fix:** deps-before-source in each stage.
6. ⚠️ **Expecting `ENV`/`WORKDIR` to carry across stages.** They don't — each `FROM` resets config. **Fix:** re-declare what the runtime stage needs.
7. ⚠️ **No `USER` in the final stage**, running as root on distroless-nonroot's default UID confusion. **Fix:** explicitly `USER nonroot` (or a numeric UID).

## 9. Interview Questions

**Q: What is a multi-stage build and what problem does it solve?**
A: It's a single Dockerfile with multiple `FROM` instructions, each starting an isolated stage. A later stage copies only the built artifact from an earlier stage via `COPY --from`, discarding the build toolchain, source, and caches. It solves the gap between heavy build-time needs (compilers, dev deps) and minimal runtime needs, producing a small, low-attack-surface final image without brittle multi-Dockerfile scripting.

**Q: How does `COPY --from` work?**
A: `COPY --from=<stage-or-image> <src> <dst>` copies files out of a previously defined stage (by name or index) or an external image into the current stage's filesystem. Only the paths you name cross over; everything else in the source stage is left behind and never ships. It's the mechanism that carries the artifact from builder to runtime.

**Q: How much does multi-stage actually save, with an example?**
A: For a Go service, a single-stage `golang` image is ~800 MB (toolchain + source), while copying just the static binary onto `distroless/static` or `scratch` yields ~10–12 MB — roughly 80× smaller. Node drops from ~1 GB to ~150 MB by shipping only `dist` + prod `node_modules` on a slim/distroless base. Smaller images pull faster and expose fewer CVEs.

**Q: What does `--target` do and when is it useful?**
A: `docker build --target <stage>` builds only up to the named stage and tags that as the image. It's useful for stopping at a `builder`/`test` stage to run the test suite in CI, producing a debug image with a shell, or building an intermediate `deps` layer — all from the same Dockerfile that also produces the lean prod image.

**Q: Why might a static binary run in the `golang` builder but crash on `scratch`? (senior)**
A: The builder has a shell and glibc; `scratch` has nothing. If the binary was dynamically linked (CGO enabled), it needs libc at runtime and fails with "no such file or directory" on exec (the loader is missing). Fixes: build statically with `CGO_ENABLED=0` (Go) or musl target (Rust), or ship on `distroless/base`/`cc` which include the needed libraries.

**Q: Do ENV, WORKDIR, and ARG carry across stages? (senior)**
A: No. Each `FROM` starts a fresh stage with reset image config, so `ENV`, `WORKDIR`, `EXPOSE`, and `USER` must be re-declared in the runtime stage. `ARG`s are also stage-scoped, though an `ARG` declared before the first `FROM` can be referenced in each `FROM` line if re-declared. Only filesystem content moves, and only via explicit `COPY --from`.

**Q: Your distroless image gets x509 certificate errors on outbound HTTPS. Why and how do you fix it? (senior)**
A: Minimal bases like `scratch` (and some distroless variants) ship without the CA certificate bundle, so TLS verification can't find a trust root. Fix by copying certs from a stage that has them: `COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/` (or `COPY --from=alpine:3.20 …`). Similarly you may need `/usr/share/zoneinfo` for timezones and `/etc/passwd` for a non-root user.

**Q: How do you keep the build stage cache-efficient in a multi-stage build? (senior)**
A: Apply the same ordering discipline as single-stage: in the builder, copy the dependency manifest/lockfile and run the download/install *before* copying source (`COPY go.mod go.sum && go mod download`, then `COPY . .`). That isolates the expensive dependency step in a cached layer. For CI, export the cache with `--cache-to mode=max` so intermediate stage layers stay warm on fresh runners.

**Q: How would you add a test stage that runs only in CI without bloating the prod image?**
A: Add `FROM build AS test` with the test command (`RUN go test ./...` or `RUN npm test`). CI runs `docker build --target test` to execute the suite; the production build runs the full Dockerfile through the final runtime stage and never includes the test stage. BuildKit skips unreferenced stages, so it costs nothing for prod builds.

**Q: When is a multi-stage build NOT worth it?**
A: When build and runtime environments are essentially the same size — e.g. an interpreted script with no build step and no dev-only dependencies, or a base image you can't slim (needs the full OS). The added Dockerfile complexity and the effort of identifying exactly which runtime files to copy outweigh the marginal size gain. For most compiled or bundler-based apps, though, it's a clear win.

## 10. Practice

- [ ] Convert a single-stage Go (or Rust) Dockerfile to two stages shipping on `distroless/static`; compare `docker images` sizes.
- [ ] Build a Node image with separate `deps` (prod-only) and `build` stages, copying only `dist` + prod `node_modules` into a distroless runtime.
- [ ] Add a `FROM build AS test` stage and run the suite with `docker build --target test`.
- [ ] Deliberately break TLS by shipping on `scratch` without certs, observe the x509 error, then fix it with a `COPY --from` cert copy.
- [ ] Prove the build-stage cache holds by copying `go.mod`/`package.json` before source and rebuilding after a code-only edit.

## 11. Cheat Sheet

> [!TIP]
> **Multi-stage in one screen.** Multiple `FROM`s = multiple isolated stages; only the **last** (or `--target`) ships. `FROM base AS builder` names a stage; `COPY --from=builder /artifact /` carries just the artifact across — toolchain, source, caches stay behind.
> • Go/Rust: static link (`CGO_ENABLED=0`) → `scratch`/`distroless/static` (~10 MB). Node: `dist` + prod `node_modules` → distroless. Python: venv/wheels → `slim`.
> • `--target <stage>` = build to a stage (test/dev/debug images from one file).
> • Each stage resets config — re-declare `ENV`/`WORKDIR`/`USER` in runtime.
> • `scratch` needs you to copy CA certs, tzdata, and a non-root user entry.
> • Order deps-before-source in each stage; `--cache-to mode=max` warms stage cache in CI.

**References:** Docker "Multi-stage builds" (docs.docker.com), Google distroless (github.com/GoogleContainerTools/distroless), "Building minimal Go images" (Go blog / eng blogs), BuildKit docs

---
*Docker Handbook — topic 07.*
