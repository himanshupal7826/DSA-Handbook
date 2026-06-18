# 03 · Writing Dockerfiles

> **In one line:** Declarative build recipes — instruction by instruction.

---

## 1. Overview

A **Dockerfile** is a script of instructions that builds an image: `FROM` (base), `RUN` (execute), `COPY`/`ADD` (files), `ENV`/`ARG` (config), `EXPOSE`, and `CMD`/`ENTRYPOINT` (default process). Good Dockerfiles are small, cache-friendly, and reproducible.

## 2. Key Concepts

- FROM sets the base; one per build stage.
- RUN executes at build time and creates a layer.
- CMD provides default args; ENTRYPOINT sets the executable.
- ENV/ARG configure build/runtime; ARG is build-only.
- WORKDIR sets the working directory for later instructions.

## 3. Syntax & Code

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8000
CMD ["gunicorn", "app:app", "--bind", "0.0.0.0:8000"]
```

## 4. Worked Example

**ENTRYPOINT + CMD**

ENTRYPOINT fixes the binary; CMD gives overridable default args:

```dockerfile
ENTRYPOINT ["python", "manage.py"]
CMD ["runserver", "0.0.0.0:8000"]
# docker run img migrate  -> overrides CMD, keeps entrypoint
```

## 5. Best Practices

- ✅ Use exec form (JSON array) for CMD/ENTRYPOINT to handle signals.
- ✅ Combine related RUN steps and clean caches in the same layer.
- ✅ Prefer COPY over ADD unless you need URL/tar extraction.
- ✅ Set a non-root USER.
- ✅ Use --no-cache-dir / package cleanup to keep images small.

## 6. Common Pitfalls

1. ⚠️ Shell form CMD swallowing signals (no graceful shutdown).
2. ⚠️ Many RUN layers bloating the image.
3. ⚠️ ADD used where COPY is safer/clearer.
4. ⚠️ Running as root by default.
5. ⚠️ apt-get update in a separate layer from install (stale cache).
6. ⚠️ Not pinning package versions.

## 7. Interview Questions

1. **Q: CMD vs ENTRYPOINT?**
   A: ENTRYPOINT sets the executable; CMD provides default arguments. Together: fixed binary + overridable args.

2. **Q: COPY vs ADD?**
   A: COPY just copies; ADD also fetches URLs and auto-extracts tars — prefer COPY unless you need those.

3. **Q: Why exec form over shell form?**
   A: Exec form runs the process as PID 1 so it receives signals (SIGTERM) for graceful shutdown.

4. **Q: ARG vs ENV?**
   A: ARG is available only at build time; ENV persists into the running container.

5. **Q: How to keep images small?**
   A: Slim/distroless base, combined RUN with cleanup, multi-stage builds, .dockerignore.

6. **Q: Why a non-root USER?**
   A: Limits blast radius if the container is compromised.

7. **Q: Why combine apt update+install?**
   A: Separate layers can cache a stale package index; combine to stay consistent.

8. **Q: What does WORKDIR do?**
   A: Sets the cwd for subsequent RUN/CMD/COPY and creates it if missing.

## 8. Practice

- [ ] Write a Dockerfile for a Python web app.
- [ ] Add ENTRYPOINT+CMD and override CMD at runtime.
- [ ] Switch to a non-root USER and verify.

## 9. Quick Revision

Dockerfile builds images: FROM/RUN/COPY/ENV/CMD/ENTRYPOINT. Use exec form, combine+clean RUN steps, COPY over ADD, run as non-root, pin versions, keep cache-friendly.

**References:** Dockerfile reference

---

*Docker Handbook — topic 03.*
