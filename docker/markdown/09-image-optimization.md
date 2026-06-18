# 09 · Image Size & Build Optimization

> **In one line:** Smaller, faster, cache-friendly images.

---

## 1. Overview

Smaller images pull faster, deploy quicker, and have less attack surface. Optimize by choosing slim bases, multi-stage builds, ordering layers for cache hits, cleaning caches in the same layer, and using **BuildKit** features (cache mounts, parallelism).

## 2. Key Concepts

- Slim/distroless bases cut size dramatically.
- Multi-stage builds drop build tooling from the final image.
- Order layers stable→volatile for cache reuse.
- Clean package caches within the same RUN.
- BuildKit adds cache mounts and parallel stage builds.

## 3. Syntax & Code

```dockerfile
# syntax=docker/dockerfile:1
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt
COPY . .
```

## 4. Worked Example

**Clean in the same layer**

Avoid leaving apt caches in the image:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*
```

## 5. Best Practices

- ✅ Use slim/distroless bases and multi-stage builds.
- ✅ Combine install + cleanup in one RUN.
- ✅ Leverage BuildKit cache mounts for deps.
- ✅ Add .dockerignore to trim context.
- ✅ Pin versions for reproducible, cacheable builds.

## 6. Common Pitfalls

1. ⚠️ Cleaning caches in a separate RUN (no size savings).
2. ⚠️ Copying source before installing deps (cache busts).
3. ⚠️ Installing recommended/unused packages.
4. ⚠️ Not enabling BuildKit.
5. ⚠️ latest base tags causing non-reproducible builds.
6. ⚠️ Large build context slowing every build.

## 7. Interview Questions

1. **Q: Top ways to shrink an image?**
   A: Slim/distroless base, multi-stage builds, combined+cleaned RUN steps, .dockerignore.

2. **Q: Why clean caches in the same RUN?**
   A: Each RUN is a layer; cleaning later doesn't remove bytes already committed in an earlier layer.

3. **Q: What does BuildKit add?**
   A: Parallel builds, cache mounts (--mount=type=cache), secrets mounts, better caching.

4. **Q: How to maximize build cache?**
   A: Order instructions stable→volatile and copy lockfiles before source.

5. **Q: Why pin versions?**
   A: Reproducibility and stable cache keys.

6. **Q: --no-install-recommends benefit?**
   A: Avoids pulling optional packages, reducing size and CVEs.

7. **Q: How does .dockerignore help builds?**
   A: Shrinks the context sent to the daemon, speeding builds and avoiding leaks.

8. **Q: Multi-stage size win?**
   A: Final image carries only artifacts, not compilers/source/caches.

## 8. Practice

- [ ] Cut an image size with a slim base + cleanup.
- [ ] Enable BuildKit and add a pip cache mount.
- [ ] Measure build time improvement from layer reordering.

## 9. Quick Revision

Optimize images: slim/distroless + multi-stage, stable→volatile layers, clean in same RUN, BuildKit cache mounts, .dockerignore, pinned versions. Smaller = faster + safer.

**References:** BuildKit

---

*Docker Handbook — topic 09.*
