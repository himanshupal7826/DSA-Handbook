# 24 · Secrets Management

> **In one line:** Keep passwords, tokens, and keys out of image layers and process environments — deliver them at the last moment, to memory, and rotate them without a rebuild.

---

## 1. Overview

A **secret** is any credential whose disclosure is a security incident: DB passwords, API tokens, TLS private keys, SSH keys, cloud access keys. The core problem in Docker is that the two most obvious places to put a secret — the **Dockerfile** (`ENV`/`ARG`) and the **environment** at runtime — are exactly the places attackers and teammates look first. Images are shared artifacts; layers are immutable and cacheable; environments are readable by anyone who can `docker inspect` or exec into the container.

The discipline is **least exposure**: a secret should exist only where it's used, only for as long as it's used, ideally in **memory** (a tmpfs file), never committed to a layer, never printed to a log, and cheaply **rotatable**. Docker gives you build-time and run-time mechanisms — BuildKit `--mount=type=secret`, Swarm/Compose `secrets`, tmpfs mounts — and in production you front these with an external store like **Vault** or a cloud secrets manager that handles rotation and audit.

You reach for this on every real service. The failure mode is silent: a leaked key in a public image layer can sit undetected until it's scraped and abused. Getting secrets right is cheap up front and very expensive to retrofit after a breach.

## 2. Core Concepts

- **Layers are immutable and additive** — anything a `RUN`/`COPY`/`ENV` writes is preserved in that layer *forever*, even if a later layer deletes it. `docker history` and layer extraction recover it.
- **`ENV` bakes secrets into the image** — an `ENV DB_PASS=…` is visible via `docker inspect`, `docker history`, and to every process and child in the container.
- **`ARG` is build-time only but still leaks** — build args don't persist as `ENV`, but they appear in `docker history` and in the build cache; passing a secret as `--build-arg` is a classic leak.
- **`-e`/`--env` at runtime** — convenient but readable via `docker inspect`, `/proc/<pid>/environ`, crash dumps, and often logged by frameworks. Fine for config, risky for secrets.
- **BuildKit `--mount=type=secret`** — mounts a secret as a file into a single `RUN` step; it is **never written to any layer** and not in `docker history`.
- **Runtime secret files (tmpfs)** — deliver the secret as a file on an in-memory filesystem the app reads at startup; nothing hits disk or the image.
- **Docker/Swarm `secrets`** — first-class objects mounted read-only at `/run/secrets/<name>` (tmpfs) into a service; the reference pattern for Compose/Swarm.
- **`_FILE` convention** — many official images (postgres, mysql) accept `VAR_FILE=/run/secrets/x` so the secret is read from a file instead of an env var.
- **External secret stores** — Vault, AWS Secrets Manager, GCP Secret Manager: central storage, dynamic/short-lived credentials, audit logs, and **rotation**.
- **Rotation** — replacing a credential on a schedule or after suspected exposure; a secrets design is only good if rotation is routine, not a fire drill.

> [!WARN]
> **`RUN` deleting a secret does not remove it.** `COPY key.pem . && RUN use-it && rm key.pem` leaves `key.pem` in the `COPY` layer. Anyone with the image can `docker save` it and extract the file. There is no "un-write" for a layer.

## 3. Syntax & Examples

The **wrong** ways, so you recognize them in review:

```dockerfile
# ❌ persists in image layers, visible in `docker inspect` / `docker history`
ENV AWS_SECRET_ACCESS_KEY=AKIA...secret

# ❌ visible in `docker history`, cached in build args
ARG NPM_TOKEN
RUN npm config set //registry/:_authToken=$NPM_TOKEN

# ❌ file copied into a layer, still there after `rm`
COPY id_rsa /root/.ssh/id_rsa
RUN git clone git@host:repo && rm /root/.ssh/id_rsa
```

The **right** way at build time — BuildKit secret mount (nothing lands in a layer):

```dockerfile
# syntax=docker/dockerfile:1
FROM node:20-alpine
# secret is a file at /run/secrets/npm, mounted only for THIS run
RUN --mount=type=secret,id=npm \
    NPM_TOKEN="$(cat /run/secrets/npm)" \
    npm config set //registry.npmjs.org/:_authToken="$NPM_TOKEN" && \
    npm ci
```

```bash
# supply the secret from a file or an env var; DOCKER_BUILDKIT=1 (default on modern Docker)
docker build --secret id=npm,src=$HOME/.npmrc-token -t app .
docker build --secret id=npm,env=NPM_TOKEN        -t app .   # from an env var
```

SSH access for private repos without ever copying the key:

```dockerfile
# syntax=docker/dockerfile:1
RUN --mount=type=ssh git clone git@github.com:acme/private.git
```

```bash
docker build --ssh default -t app .
```

Runtime secrets in Compose (mounted read-only on tmpfs at `/run/secrets/…`):

```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD_FILE: /run/secrets/pg_pass   # the _FILE convention
    secrets:
      - pg_pass

secrets:
  pg_pass:
    file: ./pg_pass.txt          # dev: from a local file (git-ignored)
    # external: true             # prod/Swarm: pre-created `docker secret create`
```

## 4. Worked Example

Prove that `ARG` leaks and that `--mount=type=secret` does not.

```dockerfile
# leaky.Dockerfile
FROM alpine
ARG API_KEY
RUN echo "using $API_KEY" > /tmp/used && rm /tmp/used   # "cleaned up"
```

```bash
docker build -f leaky.Dockerfile --build-arg API_KEY=supersecret123 -t leaky .
docker history --no-trunc leaky | grep -i api_key
```

```text
# the secret is right there in image history, forever:
|<hash>  RUN |1 API_KEY=supersecret123 /bin/sh -c echo "using $API_KEY" > /tmp/used && rm /tmp/used
```

Now the safe version:

```dockerfile
# safe.Dockerfile
# syntax=docker/dockerfile:1
FROM alpine
RUN --mount=type=secret,id=apikey \
    echo "using $(cat /run/secrets/apikey)" > /tmp/used && rm /tmp/used
```

```bash
echo -n 'supersecret123' | docker build -f safe.Dockerfile --secret id=apikey,src=/dev/stdin -t safe .
docker history --no-trunc safe | grep -i secret
```

```text
# only the mount reference appears — the VALUE is nowhere in history or layers:
RUN |0 /bin/sh -c echo "using $(cat /run/secrets/apikey)"... # buildkit.dockerfile.v0
```

Verify a runtime Compose secret is memory-backed and never on the image:

```bash
docker compose exec db cat /run/secrets/pg_pass   # readable inside
docker compose exec db mount | grep /run/secrets  # tmpfs — RAM, not disk
```

```text
tmpfs on /run/secrets/pg_pass type tmpfs (ro,relatime,...)
```

## 5. Under the Hood

The reason build secrets are safe is *where* the bytes live. A normal `COPY`/`ENV`/`ARG` writes into the **image filesystem or config**, which is committed as a content-addressed, immutable **layer** that ships with the image. A BuildKit secret is mounted into an ephemeral **tmpfs** visible only to that one `RUN` instruction; BuildKit records the *mount metadata* in the build graph but excludes the secret's content from the resulting layer and from `docker history`. At runtime, Docker/Swarm secrets follow the same principle: the plaintext is delivered to a **tmpfs** at `/run/secrets/…`, so it lives in RAM and vanishes when the container stops.

```svg
<svg viewBox="0 0 780 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>

  <text x="200" y="22" text-anchor="middle" fill="#b91c1c" font-weight="700">❌ ENV / ARG / COPY</text>
  <rect x="40" y="40" width="320" height="150" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="200" y="60" text-anchor="middle" fill="#64748b" font-size="11">image = stack of immutable layers</text>
  <rect x="70" y="72" width="260" height="26" rx="6" fill="#eff6ff" stroke="#2563eb"/>
  <text x="200" y="90" text-anchor="middle" fill="#1e293b">FROM base</text>
  <rect x="70" y="104" width="260" height="26" rx="6" fill="#eff6ff" stroke="#b91c1c"/>
  <text x="200" y="122" text-anchor="middle" fill="#b91c1c">COPY key.pem  ← secret baked in</text>
  <rect x="70" y="136" width="260" height="26" rx="6" fill="#eff6ff" stroke="#2563eb"/>
  <text x="200" y="154" text-anchor="middle" fill="#1e293b">RUN rm key.pem (layer still has it)</text>
  <text x="200" y="180" text-anchor="middle" fill="#b91c1c" font-size="11">docker history / save → recover secret</text>

  <text x="580" y="22" text-anchor="middle" fill="#059669" font-weight="700">✅ secret mount (tmpfs)</text>
  <rect x="420" y="40" width="320" height="150" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <rect x="450" y="70" width="260" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/>
  <text x="580" y="90" text-anchor="middle" fill="#1e293b">image layers (no secret)</text>
  <rect x="450" y="112" width="260" height="34" rx="6" fill="#ecfdf5" stroke="#059669"/>
  <text x="580" y="128" text-anchor="middle" fill="#1e293b">tmpfs /run/secrets/x  (RAM)</text>
  <text x="580" y="142" text-anchor="middle" fill="#64748b" font-size="11">mounted only for this RUN / this container</text>
  <text x="580" y="178" text-anchor="middle" fill="#059669" font-size="11">not in layer · not in history · gone on stop</text>

  <text x="390" y="240" text-anchor="middle" fill="#1e293b" font-weight="700">Production: external store + rotation</text>
  <rect x="60" y="255" width="150" height="50" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="135" y="285" text-anchor="middle" fill="#1e293b">Vault / cloud SM</text>
  <path d="M210,280 L298,280" stroke="#475569" marker-end="url(#a2)"/>
  <text x="254" y="272" text-anchor="middle" fill="#64748b" font-size="11">short-lived lease</text>
  <rect x="300" y="255" width="150" height="50" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="375" y="285" text-anchor="middle" fill="#1e293b">agent / sidecar</text>
  <path d="M450,280 L538,280" stroke="#475569" marker-end="url(#a2)"/>
  <text x="494" y="272" text-anchor="middle" fill="#64748b" font-size="11">tmpfs file</text>
  <rect x="540" y="255" width="150" height="50" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="615" y="285" text-anchor="middle" fill="#1e293b">app reads at start</text>
</svg>
```

## 6. Variations & Trade-offs

| Mechanism | Where it lives | In image layers? | Rotatable without rebuild? | Best for |
|---|---|---|---|---|
| `ENV` / `ARG` | image config/layer | **Yes (leaks)** | No | ❌ never for secrets |
| `-e` at runtime | process environ | No | Restart needed | low-sensitivity config |
| BuildKit `--mount=type=secret` | tmpfs, build-time only | No | N/A (build creds) | registry/npm/SSH tokens during build |
| Compose/Swarm `secrets` | tmpfs `/run/secrets` | No | Update secret + redeploy | runtime service credentials |
| External store (Vault, cloud SM) | central vault → tmpfs | No | **Yes, dynamic/leased** | production, audit, rotation |

Env vars are the seductive wrong choice: universal and easy, but readable through `docker inspect`, `/proc/<pid>/environ`, child processes, error trackers, and log lines. **File-based (tmpfs) secrets** cost a few lines (`_FILE` convention or a small reader) and remove almost all of that surface. **External stores** add operational weight (an agent, auth, network dependency) but buy the things that actually matter at scale: **short-lived dynamic credentials** (a DB password valid for 1 hour), central rotation, and an audit trail of who read what.

## 7. Production / Performance Notes

- **Scan images and git history for secrets** in CI — `trufflehog`, `gitleaks`, `docker scout`. Assume anything ever committed is compromised and rotate it.
- **Prefer dynamic secrets.** Vault can mint a database credential per deploy that auto-expires; a leaked short-lived secret is far less dangerous than a static one.
- **`_FILE` convention is your friend** for official images — mount the secret file and set `POSTGRES_PASSWORD_FILE`, avoiding the env entirely.
- **tmpfs = RAM**, so runtime secrets never touch disk and don't survive a stop; combine with `read_only` root filesystems.
- **Don't log secrets.** Scrub env dumps, disable verbose HTTP client logging of auth headers, and keep secrets out of build output.
- **Least privilege the secret itself.** A scoped, single-purpose token limits blast radius when (not if) one leaks.
- **Rotation must be routine**, ideally automated: rotate on a schedule and immediately on any suspected exposure, with app-side reload (re-read the file / re-fetch the lease) so rotation doesn't require a full redeploy.
- **CI/CD is a prime leak site** — use the platform's masked secret store, never echo secrets, and pass build creds via `--secret`, not `--build-arg`.

## 8. Common Mistakes

1. ⚠️ **`ENV SECRET=…` in a Dockerfile.** Baked into the image, visible to everyone with the image. *Fix:* never; use runtime tmpfs secrets or a store.
2. ⚠️ **Passing a token via `--build-arg`.** Shows up in `docker history`. *Fix:* use `--mount=type=secret` / `--ssh`.
3. ⚠️ **`COPY key … && RUN rm key` and assuming it's gone.** The `COPY` layer still contains it. *Fix:* secret mount; never copy secrets into the build context.
4. ⚠️ **Secrets in `.env` committed to git.** *Fix:* git-ignore, use a store, and rotate anything already pushed.
5. ⚠️ **Logging the environment** (`printenv`, framework startup dumps) that includes secrets. *Fix:* scrub logs; move secrets to files.
6. ⚠️ **Static, never-rotated credentials.** One leak = permanent exposure. *Fix:* rotate on a schedule; prefer dynamic/leased secrets.
7. ⚠️ **Broad, long-lived tokens** ("admin, no expiry"). *Fix:* least-privilege, short TTL, single purpose.
8. ⚠️ **Forgetting the build context leaks too** — a stray `id_rsa` in the directory is sent to the daemon and may be `COPY .`'d in. *Fix:* `.dockerignore` and explicit `COPY`.

## 9. Interview Questions

**Q: Why is putting a secret in `ENV` inside a Dockerfile dangerous?**
A: `ENV` is written into the image config and layers, so the value is recoverable by anyone with the image via `docker inspect`, `docker history`, or extracting the layer — and it's visible to every process and child in the container at runtime. Images are shared artifacts, so the secret spreads wherever the image goes.

**Q: `ARG` isn't kept as an env var in the final image — so why is `--build-arg SECRET=…` still a leak?**
A: Build args are recorded in `docker history` and cached in the build metadata. Even though they aren't `ENV` in the running container, anyone inspecting history sees the value, and the build cache may retain it. Build-time secrets belong in `--mount=type=secret`, not `--build-arg`.

**Q: I `COPY` a key, use it, then `RUN rm` it. Is the key in the image?**
A: Yes. Layers are immutable and additive; the `COPY` created a layer containing the key, and the later `rm` only adds a whiteout in a *new* layer. The original bytes are still extractable with `docker save`/layer tooling. The only safe pattern is to never place the secret in a layer — use a secret mount.

**Q: How does BuildKit `--mount=type=secret` keep the secret out of the image?**
A: It mounts the secret as a file on an ephemeral tmpfs into a single `RUN` step. The file exists only for that instruction's execution and is not committed to the resulting layer, and only the mount reference (not the value) appears in build metadata. Nothing lands in `docker history` or the image filesystem.

**Q: How do you deliver a secret to a container at runtime without env vars?**
A: As a file on tmpfs. In Compose/Swarm, define a `secrets:` entry and reference it in the service; Docker mounts it read-only at `/run/secrets/<name>` in RAM. The app (or the `_FILE` convention on official images) reads the file at startup. Nothing is in the environment, the image, or on disk.

**Q: What is the `_FILE` convention and why does it exist?**
A: Official images (postgres, mysql, etc.) accept `VAR_FILE=/path` alongside `VAR=…`. Instead of reading the secret from an env var (leaky), the entrypoint reads it from the file you mounted as a Docker secret. It's the bridge between file-based secrets and images that would otherwise only take env vars.

**Q: What does an external secret store like Vault add over Docker secrets?**
A: Centralized storage with access policies, **dynamic/short-lived credentials** (e.g. a DB password leased for one hour and auto-revoked), automated **rotation**, encryption at rest, and an **audit log** of every access. Docker secrets are static blobs; Vault manages the secret's whole lifecycle.

**Q: Why does short-lived, dynamic secret generation reduce risk so much?**
A: The damage from a leaked credential is bounded by how long it's valid and what it can do. A dynamic secret that expires in an hour and is scoped to one database limits the attacker's window and blast radius, and rotation is automatic rather than a manual scramble across services.

**Q: (Senior) A secret was committed to git two years ago but "removed" in a later commit. Is it safe?**
A: No. Git history retains the old commit, so the secret is still recoverable via `git log`/`git show`, and it may already be scraped. Treat it as compromised: rotate the credential immediately, purge history if feasible, and add secret scanning (gitleaks/trufflehog) to CI to prevent recurrence.

**Q: (Senior) Design zero-downtime secret rotation for a fleet of services.**
A: Store the secret in a store that supports versioning (Vault/cloud SM). Deliver it as a tmpfs file or short lease. Roll new credentials while the old ones remain valid (dual-validity window), have apps re-read the file or re-fetch the lease on a signal/TTL rather than only at boot, then revoke the old version once all instances report the new one. This avoids a synchronized redeploy and a downtime window.

**Q: (Senior) tmpfs makes runtime secrets memory-only. What residual exposure remains and how do you reduce it?**
A: The plaintext still lives in the process's memory and env/argv if the app copies it there, can appear in core dumps, logs, and `/proc/<pid>/environ`, and is visible to anyone who can exec into the container. Mitigate with least-privilege access to the host/daemon, `read_only` rootfs, disabled core dumps for the process, log scrubbing, and not re-exporting the file's contents into the environment.

## 10. Practice

- [ ] Build an image passing a token via `--build-arg`, then find it with `docker history --no-trunc`. Rebuild using `--mount=type=secret` and prove it's gone.
- [ ] Convert a Compose stack that uses `POSTGRES_PASSWORD` (env) to `POSTGRES_PASSWORD_FILE` + a Docker secret; confirm `/run/secrets/…` is `tmpfs`.
- [ ] Run `gitleaks` (or `trufflehog`) against a repo and against a built image; triage any hits and write a rotation note.
- [ ] Clone a private repo during build using `--ssh default` without ever `COPY`-ing a key into the context.
- [ ] Sketch a rotation runbook for one credential: where it's stored, how it's delivered, how apps reload it, and how you revoke the old version with zero downtime.

## 11. Cheat Sheet

> [!TIP]
> **Never put secrets in `ENV`, `ARG`, `--build-arg`, or `COPY` — layers are immutable and `docker history` recovers them.** A `RUN rm` does not un-write a layer.
> **Build-time:** `RUN --mount=type=secret,id=x …` reads `/run/secrets/x`; supply with `docker build --secret id=x,src=file|env=VAR`. Private git: `--mount=type=ssh` + `docker build --ssh default`.
> **Run-time:** Compose/Swarm `secrets:` → mounted read-only on **tmpfs** at `/run/secrets/<name>` (RAM, gone on stop). Use the `_FILE` convention (`POSTGRES_PASSWORD_FILE`).
> **Prod:** external store (Vault / cloud SM) for dynamic short-lived creds, central rotation, audit. Least-privilege + short TTL. Scan repos/images (gitleaks, docker scout). Assume anything committed is compromised — rotate it.

**References:** Docker docs — Build secrets (`--mount=type=secret`), Compose/Swarm `secrets`; BuildKit docs; HashiCorp Vault docs; gitleaks / trufflehog; OWASP Secrets Management Cheat Sheet.

---
*Docker Handbook — topic 24.*
