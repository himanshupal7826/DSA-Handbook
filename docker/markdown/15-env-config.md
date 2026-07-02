# 15 · Environment, Config & Secrets in Containers

> **In one line:** Inject configuration into containers at runtime — never bake it into the image — and keep secrets out of environment variables entirely.

---

## 1. Overview

The same image should run in dev, staging, and production **without a rebuild**. That's only possible if configuration lives *outside* the image and is injected when the container starts. This is the heart of the **12-factor** principle: strict separation of config from code. An image is a build artifact you promote through environments; its behaviour is steered by the environment it lands in.

Docker gives you three main injection channels: **environment variables** (`-e`, `--env-file`), **build-time arguments** (`ARG`), and **mounted files** (bind mounts, config volumes, secrets). Choosing the wrong one causes real incidents — the classic being an `ARG DB_PASSWORD` that ends up permanently readable in the image history, or an API key printed into every log line because it lived in an env var.

The mental split you must internalise: **`ARG` is build-time and baked; `ENV` is runtime and inherited; secrets belong to neither of those default paths.** This page shows how each channel works, when to reach for it, and why environment variables are the wrong home for anything sensitive.

## 2. Core Concepts

- **`-e KEY=VALUE` / `--env KEY`** — set (or pass through) a single environment variable at `docker run` time. Highest-priority, per-container config.
- **`--env-file <file>`** — load many `KEY=VALUE` lines from a file. Values are literal — **no shell expansion, no quoting rules** — a frequent gotcha.
- **`ENV` (Dockerfile)** — bakes a *default* environment variable into the image; present at build *and* runtime and inherited by child images. Overridable at run time.
- **`ARG` (Dockerfile)** — a *build-time only* variable passed via `--build-arg`. Not present in the running container's environment (unless you copy it into an `ENV`), but **visible in image history** — never use for secrets.
- **12-factor config** — store deploy-varying config in the environment; keep the same immutable artifact across stages; treat config as strictly external.
- **Config via files/mounts** — mount `config.yaml`, `.env`, or a whole config directory into the container (bind mount, named volume, or Kubernetes ConfigMap). Better than env for large or structured config.
- **Docker secrets / secret mounts** — deliver sensitive values as *files* (e.g. `/run/secrets/db_password`, or BuildKit `--secret`) that never persist in image layers, `docker inspect`, or history.
- **Precedence** — at run time, `-e`/`--env-file` values **override** Dockerfile `ENV` defaults; explicit `-e` overrides `--env-file`.
- **Why not secrets in env** — env vars leak into `docker inspect`, `/proc/<pid>/environ`, child processes, crash dumps, and logs; they're the wrong trust boundary.

## 3. Syntax & Examples

Single variables and an env file:

```bash
docker run -e NODE_ENV=production -e PORT=8080 myapp
docker run --env-file ./prod.env myapp
docker run -e API_TOKEN myapp     # pass THROUGH the value from your shell (no '=')
```

An env file is literal — quotes and `$` are **not** interpreted:

```text
# prod.env
NODE_ENV=production
DB_HOST=db.internal
GREETING=hello world        # no quotes needed; the whole RHS is the value
# WRONG: PASS="s3cr#et"  -> the value becomes the literal   "s3cr#et"  including quotes
```

`ENV` vs `ARG` in a Dockerfile:

```dockerfile
# ARG = build-time only, visible in history — NEVER a secret
ARG APP_VERSION=0.0.0
ARG BUILD_DATE

# ENV = runtime default, overridable with -e
ENV NODE_ENV=production \
    PORT=8080 \
    APP_VERSION=${APP_VERSION}   # promote an ARG into runtime env if you want it

LABEL org.opencontainers.image.version="${APP_VERSION}"
```

Config as a mounted file (preferred for structured config):

```bash
docker run -v $(pwd)/config.yaml:/etc/app/config.yaml:ro myapp
```

Secrets the right way — BuildKit build secret (never lands in a layer):

```dockerfile
# syntax=docker/dockerfile:1
RUN --mount=type=secret,id=npm_token \
    NPM_TOKEN=$(cat /run/secrets/npm_token) npm ci
```

```bash
DOCKER_BUILDKIT=1 docker build --secret id=npm_token,src=$HOME/.npm_token .
```

## 4. Worked Example

Promote one image through two environments with only config changing. The app reads `DATABASE_URL` and `LOG_LEVEL` from the environment.

`app.py`:

```python
import os
print("env      =", os.environ.get("APP_ENV", "unset"))
print("database =", os.environ.get("DATABASE_URL", "unset"))
print("loglevel =", os.environ.get("LOG_LEVEL", "info"))  # image default via ENV
```

`Dockerfile` sets a sensible **default**:

```dockerfile
FROM python:3.12-slim
COPY app.py .
ENV LOG_LEVEL=info          # default, overridable at runtime
CMD ["python", "app.py"]
```

Two env files, one image:

```text
# staging.env               # prod.env
APP_ENV=staging             APP_ENV=production
DATABASE_URL=postgres://stg DATABASE_URL=postgres://prod
LOG_LEVEL=debug             # (omitted -> falls back to ENV default "info")
```

Run and observe — no rebuild between stages:

```text
$ docker build -t myapp:1.0 . && docker run --env-file staging.env myapp:1.0
env      = staging
database = postgres://stg
loglevel = debug            <- env-file overrode the ENV default

$ docker run --env-file prod.env myapp:1.0
env      = production
database = postgres://prod
loglevel = info             <- prod.env omitted it, so ENV default won
```

Precedence check — explicit `-e` beats the file:

```text
$ docker run --env-file prod.env -e LOG_LEVEL=warn myapp:1.0
loglevel = warn
```

Same immutable `myapp:1.0` artifact, three behaviours, zero rebuilds — that's the whole point of externalised config.

## 5. Under the Hood

`ARG` and `ENV` live in different *phases*. `ARG` exists only while `docker build` runs and is recorded in the image's build metadata (history). `ENV` becomes a persistent layer instruction that the runtime injects into the process. At `docker run`, Docker merges: image `ENV` defaults, then `--env-file` entries, then `-e` flags (last wins), and hands the result to the container's PID 1 as its environment block.

```svg
<svg viewBox="0 0 760 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="380" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">Config injection: build phase vs run phase</text>

  <!-- Build phase -->
  <rect x="24" y="44" width="330" height="150" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="189" y="66" text-anchor="middle" fill="#1e293b" font-weight="700">BUILD  (docker build)</text>
  <rect x="44" y="80" width="130" height="42" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="109" y="100" text-anchor="middle" fill="#1e293b" font-size="12">ARG (--build-arg)</text>
  <text x="109" y="116" text-anchor="middle" fill="#b91c1c" font-size="10">in history! no secrets</text>
  <rect x="200" y="80" width="130" height="42" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="265" y="100" text-anchor="middle" fill="#1e293b" font-size="12">ENV (default)</text>
  <text x="265" y="116" text-anchor="middle" fill="#64748b" font-size="10">baked as layer</text>
  <text x="189" y="150" text-anchor="middle" fill="#64748b" font-size="11">ARG can be promoted → ENV</text>
  <text x="189" y="172" text-anchor="middle" fill="#64748b" font-size="11">secrets: --mount=type=secret (no layer)</text>

  <line x1="354" y1="119" x2="418" y2="119" stroke="#475569" stroke-width="1.5" marker-end="url(#a2)"/>
  <text x="386" y="110" text-anchor="middle" fill="#64748b" font-size="11">image</text>

  <!-- Run phase -->
  <rect x="424" y="44" width="312" height="150" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="580" y="66" text-anchor="middle" fill="#1e293b" font-weight="700">RUN  (docker run)</text>
  <text x="580" y="90" text-anchor="middle" fill="#1e293b" font-size="12">1. image ENV defaults</text>
  <text x="580" y="110" text-anchor="middle" fill="#1e293b" font-size="12">2. --env-file entries</text>
  <text x="580" y="130" text-anchor="middle" fill="#1e293b" font-size="12">3. -e KEY=VALUE  (wins)</text>
  <text x="580" y="156" text-anchor="middle" fill="#64748b" font-size="11">merged → process environment</text>
  <text x="580" y="176" text-anchor="middle" fill="#64748b" font-size="11">files/secrets mounted at paths</text>

  <line x1="580" y1="194" x2="580" y2="232" stroke="#475569" stroke-width="1.5" marker-end="url(#a2)"/>

  <!-- container -->
  <rect x="470" y="234" width="220" height="72" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="580" y="258" text-anchor="middle" fill="#1e293b" font-weight="700">PID 1 environment</text>
  <text x="580" y="280" text-anchor="middle" fill="#64748b" font-size="11">LOG_LEVEL=warn (from -e)</text>
  <text x="580" y="296" text-anchor="middle" fill="#64748b" font-size="11">config.yaml @ /etc/app (mount)</text>

  <!-- leak warning -->
  <rect x="60" y="234" width="360" height="72" rx="8" fill="#fff1f2" stroke="#b91c1c"/>
  <text x="240" y="256" text-anchor="middle" fill="#b91c1c" font-weight="700">Why env ≠ secrets</text>
  <text x="240" y="276" text-anchor="middle" fill="#64748b" font-size="11">visible in: docker inspect · /proc/PID/environ</text>
  <text x="240" y="292" text-anchor="middle" fill="#64748b" font-size="11">child procs · crash dumps · logs</text>
</svg>
```

The leak surface is why secrets must be *files*, not env: a file mount at `/run/secrets/x` is readable only by the process, isn't in `docker inspect`, isn't inherited by unrelated child processes, and can be backed by a real secrets manager (Vault, AWS Secrets Manager, Kubernetes Secrets).

## 6. Variations & Trade-offs

| Channel | Phase | Persists in image? | Good for | Bad for |
|---|---|---|---|---|
| `ARG` / `--build-arg` | Build | **Yes (history)** | Versions, build flags | **Secrets, per-env config** |
| `ENV` (Dockerfile) | Build→Run | Yes (layer) | Safe *defaults* | Env-specific values, secrets |
| `-e` / `--env-file` | Run | No | Per-env scalar config | Large/structured config, secrets |
| File / bind mount | Run | No | Structured config (yaml/json) | Rotating secrets (unless RO+managed) |
| Secret mount (`--mount=type=secret`, `/run/secrets`) | Build/Run | **No** | Tokens, passwords, keys | Non-sensitive bulk config |

**Env vars vs mounted files:** env vars are simple and universal but flat, size-limited, leak-prone, and awkward for multi-line values (certs). Mounted files handle structure and large blobs, can be marked read-only, and can be swapped without touching the container spec — at the cost of the app needing to read a path. Rule of thumb: **scalars → env; structured or sensitive → files.**

**Baked defaults vs external config:** `ENV` defaults make an image self-runnable out of the box (great DX), but hard-coding an environment-specific value there breaks the "one artifact, many envs" contract. Keep `ENV` for *safe, universal* defaults only.

## 7. Production / Performance Notes

- **One image, all environments.** Build once, promote the *same digest* through staging and prod, changing only injected config. Rebuilding per environment means you're testing a different artifact than you ship.
- **Secrets come from a manager, injected at deploy.** Vault, AWS/GCP Secrets Manager, or Kubernetes Secrets mounted as files (or via CSI driver). Never in `git`, never in image layers, never in `docker history`.
- **Env-file quoting is a footgun.** `--env-file` does no shell parsing: `KEY="value"` yields a value *with* the quotes. Validate parsed values, especially for passwords with special characters — or prefer file mounts for those.
- **Rotate without redeploy.** File-mounted config/secrets can be rotated by updating the source (ConfigMap/Secret) and signalling the app; env vars require recreating the container.
- **Audit for baked secrets.** `docker history --no-trunc <image>` and scanning tools (Trivy, git-secrets) catch tokens accidentally committed via `ARG` or `ENV`. Treat any leaked secret as compromised and rotate it.
- **Config validation at startup.** Fail fast (12-factor "crash on missing required config") rather than starting with a silent default that points at the wrong database.

## 8. Common Mistakes

1. ⚠️ **Passing a secret via `ARG`/`--build-arg`.** It's permanently in `docker history`. Fix: use BuildKit `--mount=type=secret`, or fetch the secret at runtime from a manager.
2. ⚠️ **Hard-coding a prod value in `ENV`.** Breaks one-image-many-envs and can leak. Fix: `ENV` for universal defaults only; inject env-specific values at run time.
3. ⚠️ **Quoting values in `--env-file`.** `PASS="x"` includes the quotes literally. Fix: write the raw value with no surrounding quotes, or mount a file.
4. ⚠️ **Putting secrets in environment variables.** Visible in `docker inspect`, `/proc/PID/environ`, logs, child processes. Fix: deliver secrets as file mounts (`/run/secrets/...`).
5. ⚠️ **Logging the whole environment on startup.** Dumps every token to your log store. Fix: log only non-sensitive keys, redact by allowlist.
6. ⚠️ **Committing a real `.env` to git.** Fix: `.gitignore` it, commit only `.env.example` with placeholder keys.
7. ⚠️ **Assuming `--env-file` overrides `-e`.** Precedence is the reverse — explicit `-e` wins. Fix: know the order (ENV < env-file < -e).
8. ⚠️ **Rebuilding the image to change config.** Slow and untestable. Fix: externalise config so the built artifact is immutable across stages.

## 9. Interview Questions

**Q: What's the difference between `ARG` and `ENV` in a Dockerfile?**
A: `ARG` is **build-time only** (passed with `--build-arg`), not present in the running container's environment, but recorded in image history. `ENV` sets a **runtime** environment variable baked into the image as a default, inherited by child images and overridable at `docker run`. You can promote an `ARG` into an `ENV` if you want a build value at runtime.

**Q: Why should you never pass a secret via `--build-arg`?**
A: Build args are stored in the image's build metadata and are visible via `docker history --no-trunc`. Anyone who can pull the image can read the value. Secrets must use BuildKit `--mount=type=secret` (mounted only during that `RUN`, never persisted) or be fetched at runtime.

**Q: Why are environment variables a poor place for secrets, even at runtime?**
A: They leak through many channels: `docker inspect`, `/proc/<pid>/environ`, inheritance by every child process, crash dumps, error reporters, and accidental log dumps of the environment. File-based secret mounts (`/run/secrets/...`) are readable only by the process, absent from inspect output, and backable by a real secrets manager.

**Q: What's the precedence between Dockerfile `ENV`, `--env-file`, and `-e`?**
A: Lowest to highest: image **`ENV` defaults** < **`--env-file`** entries < explicit **`-e`** flags. So an explicit `-e KEY=v` overrides both the file and the baked default.

**Q: How does this connect to the 12-factor app methodology?**
A: 12-factor's "Config" factor mandates storing deploy-varying config in the environment and keeping a strict separation from code, so a single immutable build promotes unchanged across environments. Docker realises this by injecting config at run time (env/files/secrets) rather than baking it into the image.

**Q: A colleague sets `DB_URL="postgres://..."` in an `--env-file` and the app can't connect. What's wrong?**
A: `--env-file` does no shell parsing, so the value becomes the literal string *including the double quotes*. Remove the quotes — the entire right-hand side after `=` is the value verbatim.

**Q: (Senior) How would you deliver a rotating database password to a container without redeploying it?**
A: Mount it as a **file** from a secrets manager — Kubernetes Secret / CSI Secrets Store driver or a Vault agent sidecar that writes to a shared volume. On rotation the file updates and the app reloads it (watch/inotify or a periodic re-read). Env vars can't be changed without recreating the container.

**Q: (Senior) When would you choose mounted config files over environment variables?**
A: For **structured** config (YAML/JSON), **large or multi-line** values (TLS certs, allow-lists), config you want to mark **read-only**, or values you need to **rotate independently** of the container lifecycle. Env vars stay best for simple scalars and universal toggles.

**Q: (Senior) You inherit an image and suspect a secret was baked in. How do you check and remediate?**
A: Run `docker history --no-trunc` and inspect layer commands and `ENV`/`ARG` values; scan with Trivy/git-secrets. If found, treat the secret as **compromised and rotate it immediately** — you can't truly remove it from already-distributed layers. Then rebuild cleanly using a secret mount or runtime injection.

**Q: (Senior) Why keep only "safe defaults" in `ENV`, and give an example of a safe vs unsafe default.**
A: An `ENV` default should be **universal and non-sensitive** so the image runs sensibly anywhere and stays a single artifact. Safe: `LOG_LEVEL=info`, `PORT=8080`. Unsafe: `DATABASE_URL=postgres://prod`, `API_KEY=...` — these are environment-specific or sensitive and belong in runtime injection, not the image.

## 10. Practice

- [ ] Build one image with an `ENV LOG_LEVEL=info` default, then run it three ways (`--env-file staging.env`, `--env-file prod.env`, and `-e LOG_LEVEL=warn`) and confirm the precedence order.
- [ ] Add a secret to a `RUN` step via BuildKit `--mount=type=secret`, then run `docker history --no-trunc` and verify the secret does **not** appear.
- [ ] Deliberately bake a fake token with `ARG TOKEN` + `ENV TOKEN=$TOKEN`, then find it with `docker history` to see the leak first-hand.
- [ ] Mount a `config.yaml` read-only into a container and have the app read it; change the file and restart to see config-without-rebuild.
- [ ] Write an `--env-file` with a quoted value, observe the literal-quotes bug, then fix it.

## 11. Cheat Sheet

> [!TIP]
> **Config is external, not baked. One image, many environments.**
> **`ARG`** = build-time, in history → never secrets. **`ENV`** = runtime default, safe/universal only. **`-e`/`--env-file`** = per-env runtime config. **Files/mounts** = structured or read-only config. **Secret mounts** (`/run/secrets`, BuildKit `--mount=type=secret`) = tokens/keys, never in layers.
> **Precedence:** `ENV` default < `--env-file` < `-e` (last wins).
> **env-file:** literal values, NO quotes/expansion. **Secrets:** file-based, from a manager, rotate without redeploy. Audit with `docker history --no-trunc`. Fail fast on missing required config (12-factor).

**References:** 12-Factor App (Config), Docker "Environment variables" & "Build secrets" docs, Docker "docker run --env-file" reference, Kubernetes ConfigMaps and Secrets docs.

---
*Docker Handbook — topic 15.*
