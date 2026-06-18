# 02 · Images & Layers

> **In one line:** Immutable, layered, content-addressed filesystem bundles.

---

## 1. Overview

A Docker **image** is a read-only template built from stacked **layers**, each created by a Dockerfile instruction. Layers are cached and shared across images, making builds and pulls fast. Images are tagged and stored in **registries** (Docker Hub, ECR, GHCR).

## 2. Key Concepts

- Each Dockerfile instruction creates a cacheable layer.
- Layers are shared/deduplicated across images.
- Tags (name:tag) are mutable pointers; digests are immutable.
- Registries store and distribute images.
- Build cache invalidates from the first changed layer downward.

## 3. Syntax & Code

```bash
docker pull python:3.12-slim
docker images          # list local images
docker history python:3.12-slim   # see layers
docker tag myapp:dev registry.example.com/myapp:1.0
```

## 4. Worked Example

**Layer cache ordering**

Copy dependency manifests before source so deps cache across code edits:

```dockerfile
COPY requirements.txt .
RUN pip install -r requirements.txt   # cached unless requirements change
COPY . .                               # changes often, kept last
```

## 5. Best Practices

- ✅ Order Dockerfile steps from least- to most-frequently changing.
- ✅ Pin base image versions/digests for reproducibility.
- ✅ Use .dockerignore to shrink build context.
- ✅ Tag images with semantic versions, not just latest.
- ✅ Reference immutable digests in production.

## 6. Common Pitfalls

1. ⚠️ Copying source before installing deps (busts cache every build).
2. ⚠️ Relying on the mutable latest tag in prod.
3. ⚠️ Huge build context (no .dockerignore).
4. ⚠️ Secrets baked into layers (they persist in history).
5. ⚠️ Assuming deleting a file in a later layer reduces size (it doesn't).
6. ⚠️ Not cleaning package caches in the same RUN.

## 7. Interview Questions

1. **Q: What is a Docker image?**
   A: An immutable, layered, content-addressed filesystem + metadata used to create containers.

2. **Q: How does build caching work?**
   A: Each instruction is a layer; cache is reused until an instruction or its inputs change, then all later layers rebuild.

3. **Q: Tag vs digest?**
   A: Tags are mutable human labels; digests (sha256) are immutable content identifiers.

4. **Q: Why order Dockerfile steps carefully?**
   A: To maximize cache hits — put stable steps (dep install) before volatile ones (source copy).

5. **Q: Why are secrets in layers dangerous?**
   A: Layers are kept in image history; anyone with the image can extract them.

6. **Q: What's a registry?**
   A: A service that stores and distributes images (Docker Hub, ECR, GHCR).

7. **Q: Does deleting a file in a later layer shrink the image?**
   A: No — the earlier layer still contains it; remove within the same RUN.

8. **Q: What is .dockerignore for?**
   A: Excluding files from the build context to speed builds and avoid leaking files.

## 8. Practice

- [ ] Inspect an image's layers with docker history.
- [ ] Reorder a Dockerfile to improve cache hits.
- [ ] Add a .dockerignore and measure context size.

## 9. Quick Revision

Images = immutable stacked layers (cached, shared), tagged in registries. Order Dockerfile stable→volatile, pin versions/digests, use .dockerignore, never bake secrets into layers.

**References:** About images

---

*Docker Handbook — topic 02.*
