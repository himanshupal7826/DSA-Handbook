# 03 · Images, Layers & the Union Filesystem

> **In one line:** An image is a stack of **read-only, content-addressed layers**; a container adds one thin **writable layer** on top, and a **union filesystem** (overlay2) merges them with **copy-on-write** so 100 containers share one image on disk.

---

## 1. Overview

A Docker **image** is not a single blob — it is an ordered stack of **read-only layers**, each a tar of filesystem changes (files added/modified/deleted) produced by one build step. A **manifest** lists those layers plus a **config** (env, entrypoint, cmd). Everything is **content-addressed**: each layer and the image itself are named by the SHA-256 **digest** of their content, so identical content is stored once and pulls dedupe automatically.

When you `docker run`, the engine **union-mounts** the image's read-only layers and puts a single **writable layer** on top — that stack, presented as one filesystem, is the container's root. This is the job of a **union / overlay filesystem** (overlay2 on modern Linux): it merges multiple directories into one view.

The magic that makes this cheap is **copy-on-write (CoW)**. Reads come straight from the shared read-only layers. Only when a container *writes* to a file does the filesystem **copy that file up** into the writable layer and modify the copy. So launching 100 containers from a 200 MB image costs ~200 MB total plus whatever each container actually writes — not 100 × 200 MB.

Understanding layers explains almost every practical Docker skill: why `Dockerfile` instruction order controls cache hits, why image size balloons, why a container "loses its data," and why you tag by digest for reproducibility.

## 2. Core Concepts

- **Layer** — an immutable tar of filesystem diffs from one build step; identified by a content **digest** (`sha256:…`).
- **Image manifest** — JSON listing the ordered layer digests + a reference to the **config**; itself content-addressed.
- **Image config** — metadata: env, `ENTRYPOINT`/`CMD`, working dir, exposed ports, and the layer `diff_ids`.
- **Content-addressable storage** — everything named by SHA-256 of its content ⇒ automatic dedupe, integrity, and reproducible pulls.
- **Union / overlay filesystem** — merges lower (read-only) dirs and an upper (writable) dir into one mount; **overlay2** is the default driver.
- **lowerdir / upperdir / merged** — overlay2 terms: `lowerdir` = image layers (RO), `upperdir` = container writable layer, `merged` = the combined view the process sees, `workdir` = overlay's scratch.
- **Copy-on-write** — reads are shared; the first write to a file copies it up into the writable layer, then edits the copy.
- **Whiteout** — a deletion is recorded as a special whiteout file in an upper layer; the file still exists below but is hidden in the merged view (so deleting doesn't shrink the image).
- **Image layer vs container layer** — image layers are **shared & read-only**; the container layer is **per-container, writable, and ephemeral** (dies with `docker rm`).
- **Digest vs tag** — a **tag** (`nginx:1.27`) is a mutable pointer; a **digest** (`nginx@sha256:…`) is immutable — pin digests for reproducibility.

## 3. Syntax & Examples

Every non-metadata `Dockerfile` instruction that changes the filesystem creates a layer:

```dockerfile
FROM python:3.12-slim          # base layers (shared by everyone using this base)
WORKDIR /app                   # metadata-ish; cheap
COPY requirements.txt .        # layer: adds one file
RUN pip install -r requirements.txt   # layer: big — site-packages
COPY . .                       # layer: your source (changes most often → put last)
CMD ["python", "app.py"]       # metadata, no layer
```

Inspect layers, sizes, and how they were built:

```bash
docker history python:3.12-slim          # per-layer size + creating command
docker image inspect nginx:1.27 \
  --format '{{json .RootFS.Layers}}'     # the ordered layer digests
docker inspect nginx:1.27 --format '{{index .RepoDigests 0}}'  # immutable digest
```

Pin by digest for reproducible deploys:

```bash
docker pull nginx@sha256:9c4b6...e1f    # exact bytes, tag-proof
```

Look at overlay2 on disk (Linux):

```bash
docker inspect <ctr> --format '{{json .GraphDriver.Data}}'
# {"LowerDir":"…/l/AAA:…/l/BBB","UpperDir":"…/diff","MergedDir":"…/merged","WorkDir":"…/work"}
mount | grep overlay     # shows the overlay mount for the container
```

## 4. Worked Example

**Goal:** watch copy-on-write and the ephemeral container layer with your own eyes.

```bash
# 1. Run a container from a shared image
docker run -dit --name c1 alpine:3.20 sh

# 2. Write a file — it goes to THIS container's writable layer only
docker exec c1 sh -c 'echo hello > /data.txt && cat /data.txt'

# 3. A second container from the SAME image does NOT see it (separate upperdir)
docker run --rm alpine:3.20 cat /data.txt      # -> cat: /data.txt: No such file

# 4. Show the write landed in the container's upperdir on the host
docker inspect c1 --format '{{.GraphDriver.Data.UpperDir}}'
sudo ls $(docker inspect c1 --format '{{.GraphDriver.Data.UpperDir}}')   # -> data.txt

# 5. Prove it's ephemeral
docker rm -f c1
docker run --rm alpine:3.20 cat /data.txt      # gone forever
```

Result:

```text
Step 2:  hello                          # written into c1's writable layer
Step 3:  cat: can't open '/data.txt'    # image layers unchanged & shared
Step 4:  data.txt                       # only in c1's upperdir (CoW copy-up)
Step 5:  (after rm) file no longer exists anywhere
```

The lesson in five commands: the image's layers are shared and read-only, each container's writes are private and live in its writable upperdir, and that layer is destroyed with the container — which is exactly why durable data belongs in a **volume**, not the container layer.

## 5. Under the Hood

overlay2 stacks the image's read-only layers under the container's writable layer and presents a single merged view; a write triggers copy-up.

```svg
<svg viewBox="0 0 680 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>

  <text x="180" y="22" text-anchor="middle" fill="#1e293b" font-weight="700">Container filesystem (overlay2)</text>

  <!-- writable -->
  <rect x="40" y="40" width="280" height="46" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="180" y="60" text-anchor="middle" fill="#1e293b" font-weight="700">Writable layer (upperdir)</text>
  <text x="180" y="77" text-anchor="middle" fill="#64748b" font-size="11">per-container · read-write · ephemeral</text>

  <!-- read only layers -->
  <rect x="40" y="98" width="280" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="180" y="123" text-anchor="middle" fill="#1e293b">Layer 3  COPY . .  (source)</text>
  <rect x="40" y="144" width="280" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="180" y="169" text-anchor="middle" fill="#1e293b">Layer 2  RUN pip install</text>
  <rect x="40" y="190" width="280" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="180" y="215" text-anchor="middle" fill="#1e293b">Layer 1  base OS (python:slim)</text>
  <text x="180" y="250" text-anchor="middle" fill="#64748b" font-size="11">lowerdir — read-only, SHARED across containers</text>

  <!-- merged view -->
  <line x1="330" y1="140" x2="380" y2="140" stroke="#475569" marker-end="url(#a)"/>
  <rect x="382" y="60" width="260" height="160" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="512" y="84" text-anchor="middle" fill="#1e293b" font-weight="700">merged view (/)</text>
  <text x="512" y="108" text-anchor="middle" fill="#64748b" font-size="12">what the process sees:</text>
  <text x="512" y="130" text-anchor="middle" fill="#1e293b" font-size="12">all layers unioned into one FS</text>
  <text x="512" y="158" text-anchor="middle" fill="#64748b" font-size="12">read → from shared lower layers</text>
  <text x="512" y="180" text-anchor="middle" fill="#64748b" font-size="12">write → copy-up into upperdir</text>
  <text x="512" y="202" text-anchor="middle" fill="#64748b" font-size="12">delete → whiteout hides lower file</text>

  <!-- CoW note -->
  <rect x="40" y="290" width="602" height="70" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="341" y="314" text-anchor="middle" fill="#1e293b" font-weight="700">Copy-on-write economics</text>
  <text x="341" y="336" text-anchor="middle" fill="#64748b" font-size="12">100 containers × one 200MB image = ~200MB shared + only each container's writes</text>
  <text x="341" y="353" text-anchor="middle" fill="#64748b" font-size="12">digests (sha256) make identical layers store once and pull deduped</text>
</svg>
```

Mechanically: overlay2 mounts `lowerdir` (the RO image layers, colon-joined lowest-last), `upperdir` (the writable diff), and a `workdir`, producing `merged`. A `read` resolves top-down through the layers to the first match. A `write` to a lower-layer file triggers **copy-up**: overlay copies the whole file into `upperdir`, then all further reads/writes hit that copy. A `delete` writes a **whiteout** so the file disappears from `merged` while still occupying space below — which is why `RUN rm big_thing` in a later step does *not* shrink the image (the bytes remain in an earlier layer).

## 6. Variations & Trade-offs

| Storage driver | Mechanism | Notes |
|---|---|---|
| **overlay2** | Union overlay, file-level CoW | Default on modern Linux; fast, simple — use this |
| fuse-overlayfs | Overlay in userspace | For rootless Docker where kernel overlay is restricted |
| btrfs / zfs | Snapshot-based CoW | Block-level snapshots; needs that filesystem |
| devicemapper | Block-level CoW (thin pool) | Legacy/RHEL past; slower, being retired |
| vfs | No CoW — full copy per layer | No sharing; only for testing/unsupported FS |

**Layer count vs cache trade-off:** more layers = finer build cache and better cross-image sharing, but manifest overhead and slower pulls at extremes. The real lever is **order**: put rarely-changing steps (base, deps) early and frequently-changing steps (`COPY . .`) last so a source edit only invalidates the top layer. Multi-stage builds (see *Multi-stage Builds*) drop build-only layers from the final image entirely.

## 7. Production / Performance Notes

- **Order for cache.** Copy dependency manifests and install *before* copying source. A one-line code change should rebuild one layer, not `pip/npm install`.
- **Deleting doesn't shrink.** `RUN rm` in a later layer leaves bytes below via whiteouts. To actually remove, delete in the **same** `RUN` that created the files, or use multi-stage.
- **Squash sparingly.** Squashing merges layers (smaller manifest) but destroys cross-image layer sharing and cache — usually a net loss.
- **Pin digests in prod.** Tags are mutable (`latest` moves); deploy `image@sha256:…` for reproducible, tamper-evident rollouts.
- **The writable layer is slow and volatile.** CoW copy-up has overhead and it's lost on `rm`. Write hot/durable data to **volumes**, which bypass the union FS.
- **Share base images.** Standardize on a few bases so their layers are pulled once and cached fleet-wide — big savings on registry bandwidth and node disk.
- **Watch total size.** `docker history` to find fat layers; prefer slim/distroless bases and `.dockerignore` to keep build context (and the `COPY . .` layer) small.

## 8. Common Mistakes

1. ⚠️ **Expecting `RUN rm` to reduce image size** — whiteouts hide but don't delete lower bytes. Fix: remove in the same `RUN`, or use multi-stage builds.
2. ⚠️ **`COPY . .` before installing dependencies** — every code edit busts the dependency cache. Fix: copy manifests + install first, source last.
3. ⚠️ **Storing durable data in the container layer** — it dies with `docker rm`. Fix: use named **volumes** or bind mounts.
4. ⚠️ **Trusting mutable tags for reproducibility** — `myapp:latest` changes under you. Fix: pin `@sha256:` digests in deploys.
5. ⚠️ **Fat build context** — no `.dockerignore`, so `.git`/`node_modules` bloat the `COPY` layer and slow builds. Fix: add a tight `.dockerignore`.
6. ⚠️ **Chasing size by squashing everything** — kills layer sharing and cache reuse. Fix: optimize base image + step order instead.
7. ⚠️ **Writing heavy IO through the union FS** (DB files in the writable layer) — slow CoW copy-up. Fix: put IO-heavy paths on volumes.

## 9. Interview Questions

**Q: What is a Docker image, structurally?**
A: An ordered stack of **read-only, content-addressed layers** (each a tar of filesystem diffs) plus a **manifest** listing them and a **config** (env/entrypoint/cmd). Every layer and the image are named by their SHA-256 digest, so identical content is stored once.

**Q: What's the difference between an image layer and the container layer?**
A: Image layers are read-only and **shared** across all containers of that image. The container layer is a single **writable, per-container, ephemeral** layer added on top; it holds the container's writes and is destroyed on `docker rm`.

**Q: Explain copy-on-write in overlay2.**
A: The image layers are the read-only `lowerdir`; the container gets a writable `upperdir`; overlay presents a merged view. Reads come from the shared lower layers; the first write to a file **copies it up** into the upperdir and edits the copy, so unchanged data stays shared.

**Q: Why doesn't `RUN rm -rf /somebigdir` in a later step shrink the image?**
A: Deletion is recorded as a **whiteout** in the upper layer — the file is hidden in the merged view but its bytes still live in the earlier layer that added them. To reclaim space, delete in the same `RUN` that created it, or use multi-stage builds.

**Q: How does Docker store 100 containers from one 200 MB image without using 20 GB?**
A: The read-only layers are mounted once and **shared** via the union FS; each container only has its own thin writable layer. Total ≈ 200 MB + the sum of what each container actually writes.

**Q: What's the difference between a tag and a digest, and when do you use each?**
A: A **tag** (`nginx:1.27`) is a mutable, human-friendly pointer; a **digest** (`nginx@sha256:…`) is the immutable content hash. Use tags for convenience, but pin **digests** in production deploys for reproducibility and integrity.

**Q: Why does Dockerfile instruction order matter so much for build speed?**
A: Each step is a cached layer keyed by its inputs; a change invalidates that layer and all below it. Put stable steps (base, dependency install) first and volatile steps (`COPY . .`) last, so a code edit rebuilds only the top layer instead of reinstalling dependencies.

**Q: (Senior) What is content-addressable storage and what three properties does it give images?**
A: Naming layers/images by the SHA-256 of their content. It gives **deduplication** (identical content stored once and pulled once), **integrity** (the digest verifies the bytes), and **reproducibility** (a digest always resolves to the exact same image).

**Q: (Senior) Why is heavy random-write IO in the container's writable layer a bad idea?**
A: overlay2's copy-up is file-granular and adds latency, and the writable layer is volatile (lost on `rm`) and not easily shareable. Durable or IO-heavy data (databases, uploads) should go on **volumes**, which bypass the union FS.

**Q: (Senior) A colleague runs `--squash` to shrink images. What's the hidden cost?**
A: Squashing collapses layers into one, so you lose **cross-image layer sharing** and **build-cache reuse** — pulls and rebuilds get bigger/slower across the fleet. Prefer optimizing the base image, step order, and `.dockerignore`, or multi-stage builds.

**Q: (Senior) How does overlay2 resolve a read for a path that exists in multiple layers?**
A: It searches the stacked directories top-down (upperdir first, then lower layers in order) and returns the first match; a whiteout in an upper layer masks lower entries. This top-down resolution is what makes later layers override earlier ones.

## 10. Practice

- [ ] Run `docker history` on a slim base and identify the largest layer.
- [ ] Write a file inside a container, then start a second container from the same image and confirm it's not visible.
- [ ] Find the container's `UpperDir` via `docker inspect` and locate your written file on the host.
- [ ] Add a bad `RUN rm` after a big `RUN` and prove with `docker history` that size didn't drop; then fix it in one `RUN`.
- [ ] Reorder a Dockerfile to copy dependency manifests before source and measure the cache-hit improvement on a code-only change.

## 11. Cheat Sheet

> [!TIP]
> **Image = ordered read-only layers + manifest + config, all content-addressed (sha256).**
> **Container = image layers (shared, RO) + one writable layer (per-container, ephemeral).**
> overlay2: `lowerdir` (image) + `upperdir` (writable) → `merged` view. **Read = shared; Write = copy-up; Delete = whiteout (doesn't shrink image).**
> Cache rule: **stable steps first, `COPY . .` last.** `.dockerignore` keeps context small.
> Deleting later ≠ smaller image → delete in the same `RUN` or multi-stage.
> Prod: **pin `@sha256` digests**; durable/IO-heavy data → **volumes**, never the writable layer.

**References:** Docker "About storage drivers" & "overlayfs driver" docs · OCI image-spec · Linux `overlayfs` kernel documentation · Docker `docker history`/`inspect` reference

---

*Docker Handbook — topic 03.*
