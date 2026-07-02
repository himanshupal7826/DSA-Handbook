# 26 · Docker in CI/CD Pipelines

> **In one line:** A pipeline turns a git commit into a signed, scanned, immutably-tagged image — build → test → scan → push — with layer caching to keep it fast.

---

## 1. Overview

CI/CD is where Docker stops being a laptop convenience and becomes the **unit of deployment**. Every commit should produce one artifact — an image — that is built once, tested, scanned, tagged by its git SHA, pushed to a registry, and then promoted unchanged through staging to prod. "Built once, deployed everywhere" is the whole point: the bytes you tested are the bytes you ship.

The pipeline has four load-bearing stages: **build** the image, **test** against it (unit tests inside, integration tests against the running container), **scan** it for vulnerabilities, and **push** it to a registry. Fast, reliable pipelines get two things right that laptops don't have to: **layer caching across ephemeral runners** (each CI job starts with a cold Docker) and a **disciplined tag strategy** so images are traceable and immutable.

The two decisions that dominate CI Docker design are *how the runner gets a Docker daemon* (docker-in-docker vs. a mounted host socket vs. a daemonless builder) and *where the layer cache lives* (it can't be local — the runner is thrown away). Get those right and a build that took 8 minutes cold drops to 90 seconds warm.

You reach for this the moment you move from `docker build` on your machine to "every PR builds an image automatically."

## 2. Core Concepts

- **Ephemeral runner** — a fresh, disposable VM/container per job. No state, no local cache survives. Everything reproducible must come from the repo or the registry.
- **BuildKit / `buildx`** — the modern build engine (default since Docker 23). Parallel stages, cache mounts, and — crucially for CI — **external cache import/export** to a registry.
- **Layer cache in CI** — because local cache dies with the runner, you export cache to the registry (`--cache-to`) and import it next run (`--cache-from`). Turns cold builds warm.
- **Registry / inline cache** — two cache backends: `type=inline` embeds cache metadata in the image (simple, coarse); `type=registry` pushes a separate cache manifest (finer, multi-stage-aware).
- **Vulnerability scanning** — Trivy/Grype/Docker Scout inspect image layers for known CVEs before push; the pipeline fails on HIGH/CRITICAL.
- **Tag strategy** — immutable **git-SHA** tags for traceability, **semver** tags for humans, `latest` as a moving convenience pointer. Never overwrite a SHA tag.
- **Docker-in-Docker (DinD)** — run a full Docker daemon *inside* the CI container (privileged). Isolated but heavy and privileged.
- **Socket mount** — bind the host's `/var/run/docker.sock` into the runner. Fast and cache-friendly, but the job gets root-equivalent control of the host.
- **Daemonless build** — Kaniko / BuildKit rootless / Buildah build images with no Docker daemon at all; safest for shared/multi-tenant CI.
- **Provenance & signing** — SBOM attestations and image signing (cosign) prove *what* is in an image and *who* built it; increasingly required for supply-chain security.

## 3. Syntax & Examples

```yaml
# GitHub Actions — build, cache, scan, push
name: ci
on: { push: { branches: [main] }, pull_request: {} }
jobs:
  image:
    runs-on: ubuntu-latest
    permissions: { contents: read, packages: write, id-token: write }
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3          # BuildKit builder
      - uses: docker/login-action@v3
        with: { registry: ghcr.io, username: ${{ github.actor }}, password: ${{ secrets.GITHUB_TOKEN }} }

      - name: Build (cache to/from registry)
        uses: docker/build-push-action@v6
        with:
          context: .
          tags: ghcr.io/acme/api:${{ github.sha }}
          load: true                                  # keep local for test/scan
          cache-from: type=registry,ref=ghcr.io/acme/api:buildcache
          cache-to:   type=registry,ref=ghcr.io/acme/api:buildcache,mode=max

      - name: Test the built image
        run: docker run --rm ghcr.io/acme/api:${{ github.sha }} npm test

      - name: Scan (fail on HIGH/CRITICAL)
        uses: aquasecurity/trivy-action@0.24.0
        with: { image-ref: ghcr.io/acme/api:${{ github.sha }}, severity: HIGH,CRITICAL, exit-code: '1' }

      - name: Push (only after test+scan pass)
        if: github.ref == 'refs/heads/main'
        run: docker push ghcr.io/acme/api:${{ github.sha }}
```

```bash
# The same flow as raw buildx (portable to any CI)
docker buildx build \
  --cache-from type=registry,ref=ghcr.io/acme/api:buildcache \
  --cache-to   type=registry,ref=ghcr.io/acme/api:buildcache,mode=max \
  -t ghcr.io/acme/api:$GIT_SHA \
  --push .

# mode=max caches EVERY stage (incl. build stages of a multi-stage build);
# mode=min (default) only caches layers in the final image.
```

```bash
# Tagging a release: one image, multiple tags (all point to same digest)
docker buildx imagetools create \
  -t ghcr.io/acme/api:1.4.2 \
  -t ghcr.io/acme/api:1.4 \
  -t ghcr.io/acme/api:latest \
  ghcr.io/acme/api:$GIT_SHA        # re-tag by digest, no rebuild
```

## 4. Worked Example

**Goal:** cut a Node API's PR build from cold to warm. Multi-stage Dockerfile (deps → build → runtime). First run of the pipeline above:

```text
[+] Building 214.5s  (cold — no cache)
 => [deps 2/4] RUN npm ci                          188.2s
 => [build 1/2] RUN npm run build                   19.7s
 => exporting cache to registry (buildcache)         4.1s
Trivy: 0 CRITICAL, 0 HIGH  →  push ghcr.io/acme/api:9f3c1ab
```

Next PR touches only `src/route.ts` — `package.json` is unchanged, so the `npm ci` layer is a cache hit:

```text
[+] Building 27.9s  (warm — imported buildcache)
 => importing cache from registry (buildcache)        3.0s
 => CACHED [deps 2/4] RUN npm ci                       0.0s   ← restored, not re-run
 => [build 1/2] RUN npm run build                     19.7s
Trivy: 0 CRITICAL, 0 HIGH  →  push ghcr.io/acme/api:af12d90
```

| Run | Cache | `npm ci` | Total |
|---|---|---|---|
| Cold (first) | miss | 188s | **214s** |
| Warm (deps unchanged) | hit | 0s | **28s** |
| Warm (deps changed) | partial | 188s | **210s** |

The 7.6× speedup comes entirely from `--cache-to/--cache-from` surviving the ephemeral runner via the registry — and from the Dockerfile ordering `COPY package*.json` + `npm ci` *before* `COPY . .`, so a source-only change doesn't invalidate the dependency layer.

## 5. Under the Hood

Each ephemeral runner boots with an empty Docker. `--cache-from type=registry` pulls a **cache manifest** — a set of layer blobs keyed by the hash of each build step's inputs. BuildKit computes, for every instruction, a cache key from the base image digest, the command, and the checksummed files it touches. A key match means the layer is imported instead of executed. After the build, `--cache-to ... mode=max` exports keys for *all* stages (including intermediate build stages that never ship) back to the registry for the next run. The image and its cache are separate artifacts sharing content-addressed blobs.

```svg
<svg viewBox="0 0 780 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="390" y="24" text-anchor="middle" fill="#1e293b" font-weight="700">CI/CD Image Pipeline — commit to deploy</text>

  <rect x="20" y="55" width="120" height="52" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="80" y="80" text-anchor="middle" fill="#1e293b" font-weight="600">commit</text>
  <text x="80" y="98" text-anchor="middle" fill="#64748b">git push / PR</text>

  <rect x="170" y="55" width="120" height="52" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="230" y="80" text-anchor="middle" fill="#1e293b" font-weight="600">build</text>
  <text x="230" y="98" text-anchor="middle" fill="#64748b">buildx + cache</text>

  <rect x="320" y="55" width="120" height="52" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="380" y="80" text-anchor="middle" fill="#1e293b" font-weight="600">test</text>
  <text x="380" y="98" text-anchor="middle" fill="#64748b">run image</text>

  <rect x="470" y="55" width="120" height="52" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="530" y="80" text-anchor="middle" fill="#1e293b" font-weight="600">scan</text>
  <text x="530" y="98" text-anchor="middle" fill="#64748b">CVE gate</text>

  <rect x="620" y="55" width="140" height="52" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="690" y="80" text-anchor="middle" fill="#1e293b" font-weight="600">push</text>
  <text x="690" y="98" text-anchor="middle" fill="#64748b">tag :sha :semver</text>

  <line x1="140" y1="81" x2="167" y2="81" stroke="#475569" marker-end="url(#a)"/>
  <line x1="290" y1="81" x2="317" y2="81" stroke="#475569" marker-end="url(#a)"/>
  <line x1="440" y1="81" x2="467" y2="81" stroke="#475569" marker-end="url(#a)"/>
  <line x1="590" y1="81" x2="617" y2="81" stroke="#475569" marker-end="url(#a)"/>

  <!-- registry cache loop -->
  <rect x="170" y="160" width="420" height="50" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="380" y="182" text-anchor="middle" fill="#1e293b" font-weight="600">Registry — layer cache + image blobs (content-addressed)</text>
  <text x="380" y="200" text-anchor="middle" fill="#64748b">buildcache manifest survives the ephemeral runner</text>
  <line x1="230" y1="160" x2="230" y2="109" stroke="#475569" stroke-dasharray="4 3" marker-end="url(#a)"/>
  <text x="150" y="140" fill="#64748b" font-size="11">cache-from</text>
  <line x1="300" y1="109" x2="300" y2="158" stroke="#475569" stroke-dasharray="4 3" marker-end="url(#a)"/>
  <text x="305" y="140" fill="#64748b" font-size="11">cache-to</text>
  <line x1="690" y1="107" x2="500" y2="158" stroke="#475569" marker-end="url(#a)"/>

  <!-- runner box -->
  <rect x="30" y="260" width="700" height="120" rx="8" fill="#f8fafc" stroke="#475569" stroke-dasharray="5 3"/>
  <text x="380" y="282" text-anchor="middle" fill="#64748b" font-weight="600">Ephemeral runner — fresh &amp; disposable every job</text>
  <rect x="55" y="300" width="200" height="60" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="155" y="325" text-anchor="middle" fill="#1e293b" font-weight="600">DinD (privileged)</text>
  <text x="155" y="343" text-anchor="middle" fill="#64748b">isolated, heavy</text>
  <rect x="290" y="300" width="200" height="60" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="390" y="325" text-anchor="middle" fill="#1e293b" font-weight="600">socket mount</text>
  <text x="390" y="343" text-anchor="middle" fill="#64748b">fast, root-on-host</text>
  <rect x="525" y="300" width="200" height="60" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="625" y="325" text-anchor="middle" fill="#1e293b" font-weight="600">daemonless</text>
  <text x="625" y="343" text-anchor="middle" fill="#64748b">Kaniko / rootless</text>
</svg>
```

## 6. Variations & Trade-offs

**How the runner builds images:**

| Approach | Isolation | Speed / cache | Security | Use when |
|---|---|---|---|---|
| **Docker-in-Docker** | High (own daemon) | Slower; cache lost unless volume/registry | Needs `--privileged` | Isolated builds, GitLab shared runners |
| **Socket mount** (`/var/run/docker.sock`) | Low (shares host daemon) | Fastest; host layer cache reused | Root-equivalent on host — dangerous on shared CI | Trusted single-tenant runners |
| **Kaniko / BuildKit rootless** | High (no daemon) | Good; registry cache | No privilege, no daemon | Kubernetes CI, multi-tenant, hardened |

**Cache backends:**

| Backend | Granularity | Multi-stage | Setup |
|---|---|---|---|
| `type=inline` | Coarse (final image only) | No (min only) | Zero — embedded in image |
| `type=registry` | Fine (per layer) | `mode=max` caches all stages | Separate cache ref |
| `type=gha` / cloud | Fine | Yes | CI-provider backend |

DinD vs socket mount is the classic exam question: DinD trades speed and simplicity for isolation and requires `--privileged`; socket mount is fast and shares the host cache but hands the job root on the host — unacceptable on shared runners. Daemonless builders (Kaniko, rootless BuildKit) resolve the dilemma for Kubernetes-based CI by needing neither a daemon nor privilege.

## 7. Production / Performance Notes

- **Order the Dockerfile for cache, not readability.** Copy dependency manifests and install *before* copying source. A one-line source change should never re-run `npm ci` / `pip install` / `go mod download`.
- **`mode=max` for multi-stage.** The default `mode=min` only caches the final image's layers, so your expensive *build* stage recompiles every run. `mode=max` caches intermediate stages too — usually the whole win.
- **Tag with the immutable git SHA, always.** `:latest` is ambiguous and races across builds; a SHA tag is a permanent, traceable pointer to exact bytes. Promote by re-tagging the *same digest*, never rebuilding — a rebuild can pull a different base and silently change the artifact.
- **Fail the build on the scan, but tune the gate.** Block on HIGH/CRITICAL with a known fix; allow-list unfixable/irrelevant CVEs so the pipeline doesn't cry wolf and get bypassed.
- **Scan and test the *built* image, not the source.** A `Dockerfile` lint won't catch a vulnerable base layer; run Trivy against the actual image ref you'll push.
- **Never bake secrets into layers.** `--build-secret` / BuildKit secret mounts keep tokens out of the image history. A secret in an early `RUN` lives forever in the layer, even if a later layer deletes the file.
- **Pin everything for reproducibility:** base image by digest (`FROM node@sha256:…`), CI action versions, and package versions. "Latest" anywhere makes builds non-deterministic.
- **Emit provenance/SBOM** (`--provenance --sbom`) and sign with cosign if you have supply-chain requirements; downstream can verify what shipped and who built it.

## 8. Common Mistakes

1. ⚠️ **Expecting local layer cache to persist.** Ephemeral runners start cold; every build re-downloads and recompiles. Fix: `--cache-to`/`--cache-from` to the registry (or your CI's cache backend).
2. ⚠️ **Using `mode=min` on a multi-stage build.** Only final layers are cached; the build stage recompiles every time. Fix: `--cache-to ...,mode=max`.
3. ⚠️ **`COPY . .` before installing dependencies.** Any source change busts the dependency layer. Fix: copy manifests + install first, source last.
4. ⚠️ **Deploying `:latest` from CI.** Two builds race the same tag; you can't tell what's running or roll back precisely. Fix: deploy by immutable `:sha` (or digest), keep `:latest` as convenience only.
5. ⚠️ **Rebuilding to promote between environments.** Staging and prod get *different* bytes. Fix: build once, re-tag the same digest through environments.
6. ⚠️ **Mounting the host Docker socket on shared runners.** Any job gets root on the host. Fix: use DinD, or better, a daemonless rootless builder.
7. ⚠️ **Secrets via `ARG`/`ENV` in the Dockerfile.** They're baked into layer history and leak to anyone who pulls the image. Fix: BuildKit `--secret` mounts, never persisted.
8. ⚠️ **Scan runs but doesn't gate.** A report nobody blocks on is ignored. Fix: `exit-code: 1` on HIGH/CRITICAL so the pipeline actually fails.

## 9. Interview Questions

**Q: Why can't you rely on `docker build`'s normal layer cache in CI, and how do you fix it?**
A: CI runners are ephemeral — each job gets a fresh machine with an empty Docker, so the local layer cache from the previous run is gone and every build is cold. The fix is BuildKit's external cache: `--cache-to type=registry,...,mode=max` exports layer cache keys to the registry after a build, and `--cache-from` imports them next run. The registry becomes the shared, persistent cache that survives disposable runners.

**Q: Explain `mode=min` vs `mode=max` for registry cache.**
A: `mode=min` (default) only exports cache for the layers that end up in the final image. In a multi-stage build that means your build/compile stage — which is discarded — isn't cached, so it re-runs every time. `mode=max` exports cache for *all* stages including intermediate ones, so the expensive build stage is restored on a cache hit. For multi-stage builds `mode=max` is almost always what you want; the cost is a larger cache manifest.

**Q: What tag strategy do you use and why immutable SHA tags?**
A: Tag every build with the git commit SHA (immutable, traceable to exact source), add human-friendly semver tags on releases (`1.4.2`, `1.4`), and keep `latest` only as a convenience pointer. SHA tags are never overwritten, so what's running is always identifiable and rollback is a precise digest. `latest` alone races between builds and hides what's actually deployed.

**Q: Why "build once, deploy everywhere," and how do you promote between environments?**
A: The image you tested must be the image you ship — rebuilding for prod can pull a newer base layer or dependency and produce different bytes, invalidating your test results. So build once in CI, then promote by *re-tagging the same digest* (`imagetools create` / registry re-tag) through staging to prod. No rebuild, no drift; the digest is the guarantee.

**Q: Compare docker-in-docker and mounting the host Docker socket.**
A: DinD runs a full Docker daemon *inside* the CI container — well isolated, but heavy, needs `--privileged`, and its cache is lost unless you persist a volume or use registry cache. Socket mount binds the host's `/var/run/docker.sock` in — fast and it reuses the host's layer cache, but the job now controls the host daemon, which is root-equivalent: unacceptable on shared/multi-tenant runners. Rule of thumb: DinD or a daemonless builder for shared CI; socket mount only on trusted single-tenant runners.

**Q: How would you build images in CI with no daemon and no privilege?**
A: Use a daemonless builder — Kaniko or rootless BuildKit/Buildah. They build from the Dockerfile inside an unprivileged container and push directly to a registry, with registry-backed cache. This is the standard for Kubernetes-based CI where you can't (and shouldn't) grant `--privileged` or mount the host socket, and it removes the DinD-vs-socket security dilemma entirely.

**Q: Where does image scanning belong in the pipeline and what should gate it?**
A: Scan the *built image* (not just the Dockerfile) after build and before push, so you never publish a vulnerable artifact. Gate on HIGH/CRITICAL vulnerabilities that have a fix available, failing the build (`exit-code 1`). Allow-list CVEs that are unfixable or don't apply so the gate stays credible — a scan everyone routinely overrides is worse than none.

**Q: How do you keep secrets out of images built in CI?**
A: Never pass them via `ARG`/`ENV` or a `RUN` that writes a file — they persist in layer history and leak on pull, even if a later layer deletes the file. Use BuildKit secret mounts (`RUN --mount=type=secret,id=token ...` with `--secret id=token,...`), which expose the secret only during that step and never write it to a layer. For pushing, use short-lived OIDC-issued registry credentials rather than long-lived tokens.

**Q: Senior follow-up — your pipeline is reproducible on paper but images differ between runs. What's likely unpinned?**
A: Usually a floating base image (`FROM node:20` instead of `node@sha256:…`) pulling a rebuilt upstream, un-pinned OS/package versions inside `RUN apt-get install`, or un-pinned CI action/tool versions. Also un-timestamped builds and network-fetched dependencies without a lockfile. Fix: pin the base by digest, pin package and action versions, commit lockfiles, and consider `SOURCE_DATE_EPOCH` for reproducible timestamps. Verify by building the same commit twice and diffing digests.

**Q: Senior follow-up — how do you prove to a downstream consumer what's inside a shipped image?**
A: Generate an SBOM and provenance attestation at build (`buildx --sbom --provenance`) so there's a machine-readable list of components and a record of how/where it was built, and sign the image with cosign (keyless via OIDC). Downstream verifies the signature and can enforce policy (e.g. only run images signed by our CI, with an SBOM, passing scan) at admission time. This is the supply-chain (SLSA) story.

## 10. Practice

- [ ] Add `--cache-to`/`--cache-from type=registry,mode=max` to a multi-stage build and measure cold vs warm build time across two commits.
- [ ] Reorder a Dockerfile so a source-only change is a dependency-layer cache hit; prove it with `CACHED` in build output.
- [ ] Build one image, then tag it `:sha`, `:1.4`, and `:latest` by digest without rebuilding; verify all three share one digest.
- [ ] Add a Trivy step that fails the pipeline on HIGH/CRITICAL, then allow-list one unfixable CVE.
- [ ] Convert a socket-mount build job to Kaniko (or rootless BuildKit) and confirm it pushes with no daemon and no privilege.

## 11. Cheat Sheet

> [!TIP]
> **Flow:** build → test (run the image) → scan (fail on HIGH/CRITICAL) → push. Build **once**, promote by re-tagging the same **digest**.
> **Cache:** runners are ephemeral → local cache is useless. `--cache-to type=registry,ref=…:buildcache,mode=max` + `--cache-from`. `mode=max` caches build stages too. Order Dockerfile: manifests + install BEFORE `COPY . .`.
> **Tags:** immutable `:sha` (traceable) + semver `:1.4.2`/`:1.4` + `:latest` (convenience). Never overwrite a SHA.
> **Runner build modes:** DinD (isolated, privileged, heavy) · socket mount (fast, root-on-host — trusted runners only) · Kaniko/rootless BuildKit (daemonless, no privilege — best for shared/K8s CI).
> **Secrets:** BuildKit `--secret` mounts, never `ARG`/`ENV`. **Pin** base by digest + versions for reproducibility. Emit SBOM/provenance + cosign for supply-chain.

**References:** Docker "Build with GitHub Actions" & buildx cache docs, docker/build-push-action, Aqua Trivy docs, GitLab CI Docker builds (DinD vs socket), Kaniko / SLSA provenance

---

*Docker Handbook — topic 26.*
