# 08 · Image Size Optimization & Distroless

> **In one line:** Choose the smallest viable base, ship only your binary and its runtime deps, and collapse layers so images pull faster, boot quicker, and expose less attack surface.

---

## 1. Overview

A container image is a stack of read-only layers plus metadata. Every megabyte you ship is a megabyte that must be **stored** in a registry, **transferred** over the network to every node, and **kept in cache**. A 1.2 GB image and a 15 MB image run the same code — but one delays autoscaling, cold starts, and CI by minutes while the other pulls in a blink.

Size is not just cost. Every package in the image is **attack surface**: a shell, a package manager, `curl`, or an old `libssl` is one more thing a scanner flags and an attacker can pivot through. The discipline of image optimization is therefore also a **security** discipline — the smallest image is usually the safest.

The core moves are: **pick the right base** (full → slim → alpine → distroless → scratch), **exclude junk with `.dockerignore`**, **build in one stage and ship in another** (see *Multi-Stage Builds*), and **remove build-time dependencies** so they never reach the final layer. Do these and a typical service drops from hundreds of MB to tens.

## 2. Core Concepts

- **Base image choice** dominates final size — a Go binary is ~10 MB, but `FROM ubuntu` adds ~75 MB of OS you probably don't use.
- **`.dockerignore`** stops `node_modules`, `.git`, secrets, and test data from bloating the build context and leaking into `COPY .`.
- **Layers are additive** — deleting a file in a later `RUN` does *not* shrink the earlier layer that added it; the bytes still ship.
- **Combine `RUN` steps** with `&&` and clean caches *in the same layer* (`apt-get clean`, `rm -rf /var/lib/apt/lists/*`).
- **Remove build dependencies** — compilers, headers, `-dev` packages belong in a builder stage, never the runtime image.
- **Static binaries** (`CGO_ENABLED=0`, musl static links) have zero shared-library needs, so they run on `scratch`.
- **Distroless** = the language runtime + your app + CA certs, but **no shell, no package manager, no busybox** — minimal and non-debuggable-by-shell by design.
- **Slim vs Alpine** — `slim` is Debian with docs/locales stripped (glibc); Alpine is musl-libc and ~5 MB but can break glibc-only wheels and DNS edge cases.
- **Pin by digest**, squash intentionally, and scan (`docker scout`, `trivy`) — smaller images have fewer CVEs to triage.

## 3. Syntax & Examples

A `.dockerignore` (same syntax as `.gitignore`) — the single highest-leverage file:

```text
.git
node_modules
**/*.log
*.md
.env
dist
coverage
Dockerfile
.dockerignore
```

Bad vs good layer hygiene — the classic apt cleanup:

```dockerfile
# ❌ leaves ~40MB of apt lists in a layer forever
RUN apt-get update
RUN apt-get install -y curl
RUN rm -rf /var/lib/apt/lists/*   # too late — earlier layers still ship the bytes

# ✅ one layer, cache cleaned before the layer is committed
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
```

A static Go binary on `scratch` — the absolute minimum:

```dockerfile
FROM golang:1.22 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /app ./cmd/server

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /app /app
USER 65534:65534
ENTRYPOINT ["/app"]
```

Distroless for a language that needs a runtime (Python, Java, Node):

```dockerfile
FROM python:3.12-slim AS build
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --target=/deps -r requirements.txt
COPY . .

FROM gcr.io/distroless/python3-debian12
COPY --from=build /deps /deps
COPY --from=build /app /app
ENV PYTHONPATH=/deps
WORKDIR /app
ENTRYPOINT ["main.py"]
```

## 4. Worked Example

Take a naive Node service and optimize it. **Before:**

```dockerfile
FROM node:20
WORKDIR /app
COPY . .
RUN npm install
CMD ["node", "server.js"]
```

**After** — slim base, multi-stage, production deps only, non-root:

```dockerfile
FROM node:20-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM gcr.io/distroless/nodejs20-debian12
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
USER 1000
CMD ["server.js"]
```

Measured results (`docker images`):

| Stage | Base | Image size |
|---|---|---|
| Before | `node:20` | 1.09 GB |
| slim + `npm ci --omit=dev` | `node:20-slim` | 240 MB |
| + distroless runtime | `distroless/nodejs20` | 180 MB |

```text
$ docker images demo
REPOSITORY   TAG        SIZE
demo         before     1.09GB
demo         after      182MB
```

An ~6× reduction with no code change — faster pulls, faster deploys, no shell or npm in production.

## 5. Under the Hood

Images are content-addressed layers. Each Dockerfile instruction that touches the filesystem creates a layer; the union filesystem stacks them. A **delete** in an upper layer writes a *whiteout* marker — it hides the file but the lower layer still contains (and ships) the original bytes. That is why `rm` in a separate `RUN` never reclaims space, and why a builder stage full of compilers must be *left behind* via `COPY --from`, not cleaned up in place.

```svg
<svg viewBox="0 0 720 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ar" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="180" y="24" text-anchor="middle" fill="#b91c1c" font-weight="bold">❌ Single stage — bytes accumulate</text>
  <rect x="40" y="40" width="280" height="34" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="180" y="62" text-anchor="middle" fill="#1e293b">FROM ubuntu  (75 MB base)</text>
  <rect x="40" y="82" width="280" height="34" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="180" y="104" text-anchor="middle" fill="#1e293b">apt install gcc  (+180 MB)</text>
  <rect x="40" y="124" width="280" height="34" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="180" y="146" text-anchor="middle" fill="#1e293b">build app  (+12 MB)</text>
  <rect x="40" y="166" width="280" height="34" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="180" y="188" text-anchor="middle" fill="#1e293b">rm gcc  (whiteout, 0 saved)</text>
  <text x="180" y="230" text-anchor="middle" fill="#b91c1c" font-weight="bold">≈ 267 MB shipped</text>

  <text x="540" y="24" text-anchor="middle" fill="#059669" font-weight="bold">✅ Multi-stage — ship the artifact</text>
  <rect x="400" y="40" width="280" height="76" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="540" y="66" text-anchor="middle" fill="#1e293b">builder stage: gcc + source</text>
  <text x="540" y="86" text-anchor="middle" fill="#64748b">(discarded — never pushed)</text>
  <text x="540" y="106" text-anchor="middle" fill="#64748b" font-size="12">COPY --from=builder /app</text>
  <line x1="540" y1="116" x2="540" y2="160" stroke="#475569" marker-end="url(#ar)"/>
  <rect x="400" y="164" width="280" height="36" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="540" y="187" text-anchor="middle" fill="#1e293b">scratch + /app  (12 MB)</text>
  <text x="540" y="230" text-anchor="middle" fill="#059669" font-weight="bold">≈ 12 MB shipped</text>
</svg>
```

Distroless images ship the runtime and your app, no `/bin/sh`. Google builds them from Debian packages minus everything interactive. There is nothing to `docker exec ... sh` into — which is exactly the point in production, and exactly the friction in debugging (use the `:debug` variants with busybox, or ephemeral debug containers).

## 6. Variations & Trade-offs

| Base | Typical size | libc | Shell/pkg mgr | Best for | Watch out |
|---|---|---|---|---|---|
| `ubuntu` / `debian` | 30–75 MB | glibc | yes | dev, complex native deps | large, more CVEs |
| `*-slim` | 20–80 MB | glibc | yes (minimal) | Python/Node with C-extensions | still has apt |
| `alpine` | ~5 MB | **musl** | yes (busybox) | tiny, static-friendly | musl breaks glibc wheels, DNS quirks |
| `distroless` | 2–25 MB | glibc | **no** | prod runtimes (Go, Java, Py, Node) | hard to debug, no shell |
| `scratch` | 0 MB | none | no | static binaries (Go, Rust musl) | must add CA certs, tzdata yourself |

Alpine's musl makes it small but is a frequent source of subtle breakage: Python `manylinux` wheels are glibc-built (so pip recompiles or fails), and musl's DNS resolver has historically differed on `search` domains. `slim` avoids all that at ~30 MB more. For compiled languages, **distroless or scratch wins** — no libc friction because you control the binary's linkage.

## 7. Production / Performance Notes

- **Pull time scales with size and layer count.** Registries transfer layers in parallel, so a few well-cached shared base layers beat one giant squashed layer for *fleet* pulls.
- **Order layers by change frequency** — dependency install (rarely changes) before `COPY . .` (changes every commit), so most builds hit cache.
- **`--no-install-recommends`** (apt) and `--no-cache` (apk) / `--no-cache-dir` (pip) prevent silent bloat.
- **Add what scratch lacks**: CA certs (`ca-certificates`), timezone data (`tzdata`), and a non-root numeric `USER` (65534 = nobody).
- **Scan every build** in CI: `docker scout cves` or `trivy image` — smaller base = fewer findings = less triage.
- **Squashing** (`--squash`, or a single-stage export) reduces layer count but destroys shared-layer cache reuse across images; prefer multi-stage over squash.
- **`.dockerignore` also speeds builds** — a 2 GB `node_modules` sent as build context slows every `docker build` even before the first instruction.

## 8. Common Mistakes

1. ⚠️ **Cleaning caches in a separate `RUN`.** The earlier layer already committed the bytes. *Fix:* chain install + clean with `&&` in one `RUN`.
2. ⚠️ **`COPY . .` with no `.dockerignore`.** Ships `.git`, `node_modules`, `.env` secrets. *Fix:* add a `.dockerignore` and copy narrowly.
3. ⚠️ **Shipping build tools in the runtime image.** *Fix:* multi-stage — compile in a builder, `COPY --from` only the artifact.
4. ⚠️ **Reaching for Alpine reflexively on glibc apps.** Broken wheels, slow rebuilds, DNS bugs. *Fix:* use `-slim` unless you've validated musl.
5. ⚠️ **`scratch` with a dynamically linked binary.** It exits with "no such file or directory" (missing loader). *Fix:* `CGO_ENABLED=0` / static musl, or use distroless.
6. ⚠️ **Forgetting CA certs on scratch/distroless-static.** HTTPS calls fail with x509 errors. *Fix:* `COPY` `ca-certificates.crt` from the builder.
7. ⚠️ **Installing dev/test deps in prod** (`npm install` vs `npm ci --omit=dev`, `pip` with test extras). *Fix:* production-only dependency install.
8. ⚠️ **`latest` base tags** — non-reproducible and silently growing. *Fix:* pin `python:3.12-slim` or a digest.

## 9. Interview Questions

**Q: Why doesn't deleting a file in a later RUN instruction reduce image size?**
A: Layers are stacked and immutable. A delete in an upper layer only writes a whiteout marker that hides the file; the lower layer that added it still contains the bytes and is still shipped. To actually save space you must avoid adding the file in that layer — clean in the same `RUN`, or leave it behind in a discarded builder stage.

**Q: Compare slim, alpine, distroless, and scratch. When would you pick each?**
A: `slim` is minimal Debian (glibc) with a package manager — safe default for interpreted apps with native extensions. `alpine` (~5 MB, musl) is tiny but risks glibc-wheel and DNS incompatibilities. `distroless` has the runtime + your app but no shell/pkg-mgr — best for hardened production. `scratch` is empty — only for fully static binaries (Go with `CGO_ENABLED=0`, Rust musl) where you add certs/tz yourself.

**Q: What does `CGO_ENABLED=0` do and why does it matter for image size?**
A: It disables cgo so the Go compiler produces a fully static binary with no dynamic libc dependency. That lets you run on `scratch` (0 MB base) instead of a distro image, because there's no shared library or dynamic loader to satisfy at runtime.

**Q: What's the purpose of `.dockerignore` and what belongs in it?**
A: It excludes paths from the build context sent to the daemon, so `COPY .` doesn't pull them in and builds are faster. Typical entries: `.git`, `node_modules`, build output (`dist`), logs, `.env`/secrets, and the Dockerfile itself. It prevents both bloat and accidental secret leakage.

**Q: Distroless has no shell. How do you debug a crashing distroless container in production?**
A: Use Kubernetes ephemeral debug containers (`kubectl debug -it pod --image=busybox --target=app`) which share the target's namespaces, or run the distroless `:debug` variant that includes busybox for a break-glass session. Ideally you rely on structured logs, metrics, and remote profiling rather than shelling in.

**Q: You switched to Alpine and your Python service got slower to build and started failing on some libraries. Why?**
A: Alpine uses musl libc, but most Python wheels on PyPI are glibc-built `manylinux` binaries. On musl, pip can't use them, so it falls back to compiling from source (slow) or fails when build deps are missing. `-slim` (glibc) uses the prebuilt wheels directly.

**Q: How do layer ordering and caching interact with image build performance?**
A: Docker caches each layer keyed on the instruction and its inputs. Put rarely-changing steps (base, dependency install) before frequently-changing ones (`COPY . .`). Then a code change only invalidates the final layers, and the expensive dependency layer is reused — much faster builds.

**Q: Is a smaller image always more secure? What's the security argument for minimal images?**
A: Generally yes — fewer packages means fewer CVEs, no shell/package manager for an attacker to pivot with, and a smaller attack surface. It's not automatic: your own dependencies can still be vulnerable, and removing debugging tools shifts effort to observability. But minimal + non-root + scanned is the strong default.

**Q: (Senior) When is squashing an image a bad idea?**
A: Squashing merges all layers into one, so images stop sharing common base layers. Across a fleet pulling many images that share a base, dedup is lost and total transfer/storage grows. It also breaks incremental cache reuse. Prefer multi-stage builds for size; reserve squashing for rare cases where layer count itself is the problem.

**Q: (Senior) How do you get CA certificates and timezones into a scratch image?**
A: Copy them from the builder stage: `COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/` for TLS, and `COPY --from=build /usr/share/zoneinfo /usr/share/zoneinfo` (plus `ENV TZ`) for time zones. Without certs, HTTPS fails with x509 errors; without zoneinfo, `time.LoadLocation` fails.

**Q: (Senior) How would you enforce image-size and CVE budgets in CI?**
A: Fail the pipeline on regressions: compare image size against a baseline threshold, run `trivy`/`docker scout` and gate on HIGH/CRITICAL counts, verify the base tag is pinned (no `:latest`), and assert a non-root `USER`. Publish size and CVE trends so regressions are visible per-PR.

## 10. Practice

- [ ] Take a `FROM node:20` service and rewrite it as a multi-stage distroless image; record the before/after size.
- [ ] Build a Go binary with `CGO_ENABLED=0` and ship it on `scratch`, adding CA certs so an HTTPS call works.
- [ ] Add a `.dockerignore` to a repo and measure the build-context size drop reported by `docker build`.
- [ ] Take a Dockerfile with three separate apt `RUN`s, collapse to one with cache cleanup, and compare `docker history` layer sizes.
- [ ] Run `trivy image` on your before and after images and compare the CVE counts.

## 11. Cheat Sheet

> [!TIP]
> **Optimize images:** pick the smallest viable base (slim → distroless → scratch). Multi-stage: build heavy, ship light with `COPY --from`. Chain `apt-get install ... && rm -rf /var/lib/apt/lists/*` in ONE `RUN`. `.dockerignore` out `.git`/`node_modules`/`.env`. `CGO_ENABLED=0` → static binary → `scratch`. Deletes in later layers DON'T shrink earlier ones. Add CA certs + `USER` (non-root) to scratch. `npm ci --omit=dev`, `pip --no-cache-dir`. Order layers by change frequency. Scan with `trivy`/`docker scout`. Pin base tags, avoid `:latest`.

**References:** Docker docs — "Building best practices"; Google `distroless` GitHub; Docker `docker history`/`scout` docs; Snyk/Trivy container-scanning guides.

---
*Docker Handbook — topic 08.*
