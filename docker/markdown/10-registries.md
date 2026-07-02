# 10 · Registries, Tags & Image Distribution

> **In one line:** A registry stores content-addressed layers and manifests; tags are mutable pointers and digests are immutable identities — deploy by digest, never trust `:latest`.

---

## 1. Overview

A **registry** is the distribution layer for images: a content-addressable store you `push` built images to and `pull` them from. Docker Hub, GitHub Container Registry (ghcr.io), Amazon ECR, Google Artifact Registry, and self-hosted `registry:2` / Harbor all speak the same **OCI Distribution** HTTP API. When you `docker pull nginx`, the daemon fetches a **manifest** (a small JSON listing the layers and config) and then the layers it doesn't already have.

The most important distinction in the whole topic is **tags vs digests**. A tag like `nginx:1.27` is a **human-friendly, mutable pointer** — the registry can repoint it to different content tomorrow. A **digest** like `nginx@sha256:abc…` is the SHA-256 of the manifest content: it is **immutable and globally unique**. Two pulls of the same digest are byte-for-byte identical, forever. `:latest` is just a conventional tag with no special meaning and no guarantee — relying on it in production is a classic source of "works on my machine" and silent, unreviewed changes.

Registries also enable **layer deduplication** (a base layer is stored once and shared by every image that uses it) and **manifest lists** (one tag serving multiple CPU architectures). Understanding this machinery is what lets you ship reproducibly and securely.

## 2. Core Concepts

- **Registry / repository / reference** — a registry hosts repositories (`ghcr.io/acme/api`); a reference is `repo:tag` or `repo@digest`.
- **Tag** — a mutable, human-readable label pointing at one manifest; can be moved to new content at any time.
- **Digest (`@sha256:…`)** — the content hash of the manifest; immutable, reproducible, the only truly pinned reference.
- **`:latest`** — a default tag by convention only; not "newest", not stable — a trap when used for deploys.
- **Image manifest** — JSON describing one image: its config blob + ordered layer digests, per platform.
- **Manifest list / image index** — a manifest pointing to multiple per-architecture manifests, so one tag serves `amd64`, `arm64`, etc.
- **Config blob** — JSON with the image's env, entrypoint, and the ordered `diff_ids` of its layers.
- **Layer blob** — a gzip'd tarball of a filesystem diff, content-addressed and **deduplicated** across images.
- **Push / pull** — uploads/downloads only the blobs the other side lacks (existing layers are skipped).
- **Auth** — `docker login` stores a token/credential; registries gate push/pull with tokens, robot accounts, or cloud IAM.

## 3. Syntax & Examples

Log in, tag, and push:

```bash
docker login ghcr.io -u anuj --password-stdin < token.txt
docker build -t ghcr.io/acme/api:1.4.0 .
docker tag ghcr.io/acme/api:1.4.0 ghcr.io/acme/api:latest
docker push ghcr.io/acme/api:1.4.0
docker push ghcr.io/acme/api:latest      # a second tag, same layers — dedup, no re-upload
```

Pull — by tag vs by immutable digest:

```bash
docker pull ghcr.io/acme/api:1.4.0                       # mutable
docker pull ghcr.io/acme/api@sha256:9f2c...e1            # pinned, reproducible
```

Find the digest of an image:

```bash
docker inspect --format='{{index .RepoDigests 0}}' ghcr.io/acme/api:1.4.0
# ghcr.io/acme/api@sha256:9f2c...e1
```

Inspect the manifest / manifest list without pulling:

```bash
docker buildx imagetools inspect ghcr.io/acme/api:1.4.0
```
```text
Name:      ghcr.io/acme/api:1.4.0
MediaType: application/vnd.oci.image.index.v1+json
Manifests:
  linux/amd64  sha256:aa11...
  linux/arm64  sha256:bb22...
```

Run a private registry locally:

```bash
docker run -d -p 5000:5000 --name reg registry:2
docker tag api:1.4.0 localhost:5000/api:1.4.0
docker push localhost:5000/api:1.4.0
```

## 4. Worked Example

Show the **mutable-tag danger** concretely. Team ships `v2`, tags it `latest`, then later force-moves `latest` to `v3` — a node that "pulls latest" now silently runs different code:

```bash
# Monday: build v2, publish as 1.0 AND latest
docker build -t acme/api:1.0 .
docker tag acme/api:1.0 acme/api:latest
docker push acme/api:1.0 && docker push acme/api:latest
docker inspect --format='{{index .RepoDigests 0}}' acme/api:latest
# acme/api@sha256:1111...

# Friday: a new build, re-tagged latest and pushed (tag MOVED)
docker build -t acme/api:latest .
docker push acme/api:latest
docker inspect --format='{{index .RepoDigests 0}}' acme/api:latest
# acme/api@sha256:2222...   ← same tag, DIFFERENT content
```

Result table — the tag stayed the same, the identity changed:

| Reference | Monday | Friday |
|---|---|---|
| `acme/api:latest` (tag) | points to `sha256:1111…` | points to `sha256:2222…` |
| `acme/api@sha256:1111…` (digest) | v2 | **still v2** |

The fix: deploy the **digest** the CI build produced, not the tag. Kubernetes manifests, Compose files, and IaC should reference `image: acme/api@sha256:1111...` (or a tag *plus* a pinned digest) so a rollout is reproducible and a moved tag can't change what runs.

## 5. Under the Hood

Pulling resolves a reference to a manifest, then fetches blobs the local store lacks. Because every layer is content-addressed, a base layer shared by ten images is stored **once** in the registry and pulled **once** onto a node.

```svg
<svg viewBox="0 0 720 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ra" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="150" y="22" text-anchor="middle" fill="#64748b">Tags (mutable pointers)</text>
  <rect x="40" y="36" width="120" height="34" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="100" y="58" text-anchor="middle" fill="#1e293b">:latest</text>
  <rect x="40" y="80" width="120" height="34" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="100" y="102" text-anchor="middle" fill="#1e293b">:1.4.0</text>
  <rect x="40" y="124" width="120" height="34" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="100" y="146" text-anchor="middle" fill="#1e293b">:arm64 / :amd64</text>

  <rect x="250" y="60" width="200" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="350" y="84" text-anchor="middle" fill="#1e293b">manifest / index</text>
  <text x="350" y="104" text-anchor="middle" fill="#64748b" font-size="11">@sha256:9f2c… (immutable)</text>

  <line x1="160" y1="53" x2="248" y2="80" stroke="#475569" marker-end="url(#ra)"/>
  <line x1="160" y1="97" x2="248" y2="90" stroke="#475569" marker-end="url(#ra)"/>
  <line x1="160" y1="141" x2="248" y2="110" stroke="#475569" marker-end="url(#ra)"/>

  <text x="600" y="22" text-anchor="middle" fill="#64748b">Content-addressed blobs (dedup)</text>
  <rect x="510" y="40" width="180" height="30" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="600" y="60" text-anchor="middle" fill="#1e293b">config sha256:c0…</text>
  <rect x="510" y="80" width="180" height="30" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="600" y="100" text-anchor="middle" fill="#1e293b">layer sha256:aa… (base)</text>
  <rect x="510" y="120" width="180" height="30" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="600" y="140" text-anchor="middle" fill="#1e293b">layer sha256:bb… (app)</text>

  <line x1="450" y1="84" x2="508" y2="55" stroke="#475569" marker-end="url(#ra)"/>
  <line x1="450" y1="90" x2="508" y2="95" stroke="#475569" marker-end="url(#ra)"/>
  <line x1="450" y1="100" x2="508" y2="135" stroke="#475569" marker-end="url(#ra)"/>

  <rect x="250" y="200" width="200" height="52" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="350" y="222" text-anchor="middle" fill="#1e293b">other:2.0 manifest</text>
  <text x="350" y="240" text-anchor="middle" fill="#64748b" font-size="11">reuses base layer aa…</text>
  <line x1="450" y1="224" x2="508" y2="100" stroke="#059669" stroke-dasharray="4 3" marker-end="url(#ra)"/>
  <text x="360" y="290" text-anchor="middle" fill="#059669" font-size="12">shared base layer stored &amp; pulled once</text>
</svg>
```

The digest is computed as `sha256` over the **manifest bytes**, which in turn reference the config and layer digests. Change any layer and the config's `diff_ids` change, the manifest changes, and the digest changes — so a digest is a tamper-evident, reproducible identity for the exact image. A **manifest list** is a thin index whose entries are `(platform, manifest-digest)` pairs; `docker pull` on an arm64 host reads the index and follows the arm64 entry automatically. Registries garbage-collect blobs no manifest references; deleting a tag doesn't free layers still shared by others.

## 6. Variations & Trade-offs

| Reference by… | Reproducible? | Readable? | Use for |
|---|---|---|---|
| `:latest` | ❌ no | ✅ yes | never in prod; local scratch only |
| semantic tag `:1.4.0` | ⚠️ can be moved | ✅ yes | humans, changelogs, rollback targets |
| `@sha256:…` digest | ✅ immutable | ❌ opaque | deploys, IaC, supply-chain pinning |
| tag **+** digest | ✅ pinned, readable | ✅ | best of both — the production pattern |

| Registry option | Notes |
|---|---|
| Docker Hub | public default; rate-limited anonymous pulls |
| ghcr.io / GitLab | tied to repo permissions, robot tokens |
| ECR / Artifact Registry | cloud IAM auth, VPC-private, lifecycle policies |
| self-hosted `registry:2` / Harbor | full control, air-gapped; Harbor adds scanning, RBAC, replication |

The trade-off is readability vs immutability. Semantic tags are how humans reason about releases and rollbacks; digests are how machines guarantee "the exact bytes we tested." Mature pipelines record both: CI builds `:1.4.0`, captures the resulting digest, and the deploy pins the digest while the tag documents intent.

## 7. Production / Performance Notes

- **Deploy by digest.** Have CI emit the pushed digest and inject it into the deployment; treat tags as documentation, not identity.
- **Never `docker push` over an existing immutable tag.** Enable **tag immutability** (ECR, Harbor, ghcr settings) so releases can't be silently overwritten.
- **Mind Docker Hub pull limits** — anonymous/free pulls are rate-limited; authenticate, mirror, or use a pull-through cache for CI at scale.
- **Use a registry pull-through cache / mirror** near your nodes to cut egress cost and speed cold pulls.
- **Layer dedup rewards a shared base** — standardize base images so nodes cache one copy across many services.
- **Lifecycle policies** (ECR/Harbor) prune untagged and old images so storage doesn't grow unbounded.
- **Sign and verify** with cosign/Notary and scan on push (Harbor/Trivy) — pin digests so a verified image can't be swapped.
- **Private registry auth in clusters** uses `imagePullSecrets` (K8s) or node IAM roles (ECR); rotate robot tokens.

## 8. Common Mistakes

1. ⚠️ **Deploying `:latest`.** Non-reproducible; a moved tag changes prod silently. *Fix:* pin a digest (or immutable semantic tag).
2. ⚠️ **Assuming a tag is immutable.** Anyone with push rights can repoint it. *Fix:* enable tag immutability; verify by digest.
3. ⚠️ **`docker pull` "already up to date" confusion.** The daemon reuses cached layers by digest, not by tag freshness. *Fix:* pull by digest or `--pull=always`.
4. ⚠️ **Deleting a tag expecting disk to free.** Shared layers stay until GC and no manifest references them. *Fix:* run registry garbage collection.
5. ⚠️ **Baking secrets into a pushed image.** Anyone with pull access extracts them. *Fix:* use build secrets (see *BuildKit*) and scan images.
6. ⚠️ **Ignoring Hub rate limits in CI.** Builds fail intermittently with 429s. *Fix:* authenticate and/or use a mirror/pull-through cache.
7. ⚠️ **Pushing a single-arch image to a multi-arch tag.** arm64 nodes fail with `exec format error`. *Fix:* build a manifest list with buildx `--platform`.
8. ⚠️ **Long-lived, over-scoped registry credentials.** A leak grants push to everything. *Fix:* short-lived tokens / robot accounts scoped per repo.

## 9. Interview Questions

**Q: What's the difference between a tag and a digest, and which should you deploy?**
A: A tag (`api:1.4.0`) is a mutable, human-readable pointer the registry can repoint at any time. A digest (`api@sha256:…`) is the immutable SHA-256 of the manifest — the same digest always resolves to byte-identical content. Deploy by digest (optionally alongside a tag for readability) so rollouts are reproducible and a moved tag can't change what runs.

**Q: Why is deploying `:latest` in production considered dangerous?**
A: `:latest` is just a conventional tag with no guarantee of being newest or stable. Anyone can repoint it, so two nodes pulling "latest" at different times can run different code, and there's no reproducible record of what shipped. It defeats rollbacks and audits. Pin a digest instead.

**Q: What is an image manifest and what's inside it?**
A: A manifest is a small JSON document describing one image for one platform: the media type, a reference to the config blob (env, entrypoint, layer `diff_ids`), and the ordered list of layer blob digests with sizes. The digest of these manifest bytes is the image's immutable identity.

**Q: What's a manifest list (image index) and why does it exist?**
A: It's a manifest that points to multiple per-architecture manifests, letting one tag (`nginx:1.27`) serve amd64, arm64, etc. On pull, the client reads the index and selects the entry matching its platform automatically. It's how multi-platform images are distributed under a single reference.

**Q: How does layer deduplication work in a registry?**
A: Layers are content-addressed by their SHA-256, so an identical layer (e.g. a shared base) is stored once regardless of how many images reference it. On push, the client skips blobs the registry already has; on pull, a node skips layers already in its local cache. This saves storage, bandwidth, and pull time.

**Q: You pushed a new build to `:1.4.0` and some nodes still run old code. Why?**
A: Nodes with a cached image for that tag may not re-pull unless the pull policy forces it (`imagePullPolicy: Always` / `--pull=always`), and if tag immutability is off the tag may have been overwritten inconsistently. The robust fix is to reference the new digest so the change is unambiguous and every node converges.

**Q: How does authentication to a registry work for pushes and pulls?**
A: `docker login` obtains and stores a bearer token (or uses a credential helper); the client then presents it on each API call. Registries authorize by scope (repo:push/pull). In clusters, pulls use `imagePullSecrets` or cloud IAM (ECR node roles). Best practice is short-lived, per-repo-scoped robot tokens.

**Q: (Senior) Deleting a tag didn't reclaim storage. Explain.**
A: Removing a tag just removes a pointer; the underlying layer and config blobs persist because they may be shared by other manifests and are only removed by the registry's garbage collector once no manifest references them. You must run GC (and often mark untagged manifests via lifecycle policy) to actually free space.

**Q: (Senior) How do you guarantee the image you tested is exactly the one deployed?**
A: Capture the digest CI produced at build/push time and pin that digest through the entire promotion path (staging → prod) in IaC/manifests. Optionally sign it with cosign and verify the signature at admission. Since the digest hashes the manifest (and transitively every layer), any change yields a different digest and is detectable.

**Q: (Senior) How would you design image distribution for many geo-distributed clusters?**
A: Use a regional registry or pull-through cache mirror per region to cut cross-region egress and latency, replicate images (Harbor replication / ECR cross-region), standardize base layers for dedup, enforce tag immutability plus digest-pinned deploys, and apply lifecycle policies to prune. Sign images and verify at admission for supply-chain integrity.

**Q: (Senior) What causes `exec format error` when pulling from a registry?**
A: The image (or the manifest-list entry selected) is for a different CPU architecture than the host — e.g. an amd64-only image on an arm64 node. Build a manifest list covering both arches with `buildx --platform`, or ensure the tag resolves to the node's architecture.

## 10. Practice

- [ ] Push an image under two tags and confirm the second push uploads no new layers (dedup).
- [ ] Capture an image's digest and `docker pull` it by `@sha256:…`; verify it matches the tag.
- [ ] Move a tag to new content and show the tag's `RepoDigest` changes while the old digest still resolves to old content.
- [ ] Build a multi-arch image and inspect its manifest list with `docker buildx imagetools inspect`.
- [ ] Run a local `registry:2`, push to it, delete a tag, and run garbage collection to observe layer reclamation.

## 11. Cheat Sheet

> [!TIP]
> **Registries:** `docker login` → `tag` → `push`; pulls/pushes skip layers the other side has (content-addressed dedup). **Tag = mutable pointer; digest `@sha256:…` = immutable identity.** Deploy by DIGEST (tag for humans, digest for machines). `:latest` = convention, not "newest" — never in prod. Manifest = one image's config + layers; **manifest list/index** = multi-arch under one tag. Enable tag immutability; run GC to reclaim unreferenced blobs. Mind Docker Hub rate limits (auth/mirror). Auth via tokens/robot accounts/IAM; K8s uses `imagePullSecrets`. Sign (cosign) + scan + pin digest for supply-chain safety.

**References:** OCI Distribution & Image-spec (github.com/opencontainers); Docker docs — "docker push/pull", "buildx imagetools"; Harbor docs; Sigstore cosign docs.

---
*Docker Handbook — topic 10.*
