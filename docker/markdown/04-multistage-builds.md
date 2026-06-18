# 04 · Multi-Stage Builds

> **In one line:** Build in one stage, ship only the artifacts in a tiny final image.

---

## 1. Overview

**Multi-stage builds** use multiple `FROM` stages: a heavy *builder* compiles/installs, then a minimal *final* stage copies just the runtime artifacts. This yields tiny, secure images without build tools, source, or caches.

## 2. Key Concepts

- Each FROM starts a new stage; name them with AS.
- COPY --from=<stage> pulls only needed artifacts.
- Final image excludes compilers/build deps.
- Great for compiled langs (Go) and trimmed runtimes.
- Combine with distroless/scratch for minimal surface.

## 3. Syntax & Code

```dockerfile
# stage 1: build
FROM golang:1.22 AS builder
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -o /app ./cmd/server

# stage 2: minimal runtime
FROM gcr.io/distroless/static
COPY --from=builder /app /app
ENTRYPOINT ["/app"]
```

## 4. Worked Example

**Node build then serve**

Compile assets in a builder, serve with a slim image:

```dockerfile
FROM node:20 AS build
WORKDIR /app
COPY . . 
RUN npm ci && npm run build
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
```

## 5. Best Practices

- ✅ Put build tools only in the builder stage.
- ✅ Copy just the final binary/assets into the runtime stage.
- ✅ Use scratch/distroless for compiled binaries.
- ✅ Name stages for clarity (AS builder).
- ✅ Cache dependency install before copying full source.

## 6. Common Pitfalls

1. ⚠️ Copying the whole builder filesystem into final (defeats purpose).
2. ⚠️ Dynamic binaries needing libs absent in scratch/distroless.
3. ⚠️ Forgetting CGO_ENABLED=0 for static Go binaries.
4. ⚠️ Re-installing deps in the final stage.
5. ⚠️ Not leveraging build cache across stages.
6. ⚠️ Leaking secrets used in the builder into final via COPY.

## 7. Interview Questions

1. **Q: What problem do multi-stage builds solve?**
   A: They produce small, secure final images by excluding build tools, source, and caches.

2. **Q: How do you pull artifacts between stages?**
   A: COPY --from=<stage-name-or-index>.

3. **Q: Why distroless/scratch?**
   A: Minimal base with no shell/package manager → smaller and far less attack surface.

4. **Q: Go static binary requirement?**
   A: CGO_ENABLED=0 (and static linking) so it runs without libc in scratch.

5. **Q: Do earlier stages ship in the final image?**
   A: No — only what you COPY --from is included.

6. **Q: How to keep deps cached?**
   A: Copy lockfiles and install before copying the full source, like single-stage builds.

7. **Q: Trade-off of distroless?**
   A: No shell for debugging; use a debug variant or temporary tooling.

8. **Q: Multi-stage for interpreted langs?**
   A: Yes — build/compile assets in one stage, copy into a slim runtime.

## 8. Practice

- [ ] Convert a single-stage Go build to multi-stage + distroless.
- [ ] Build a frontend in one stage and serve via nginx.
- [ ] Compare image sizes before/after.

## 9. Quick Revision

Multi-stage: heavy builder + minimal final, COPY --from to grab only artifacts. Use scratch/distroless, static binaries (CGO_ENABLED=0), keep deps cached, don't leak the builder.

**References:** Multi-stage builds

---

*Docker Handbook — topic 04.*
