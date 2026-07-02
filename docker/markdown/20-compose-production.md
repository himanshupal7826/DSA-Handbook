# 20 · Compose: Local Dev vs Production

> **In one line:** One base file plus environment-specific overrides — and knowing the line where Compose stops and Kubernetes begins.

---

## 1. Overview

The same app has to run two very different ways. On a laptop you want bind-mounted source for live reload, a debugger port, verbose logs, and a throwaway database. In production you want a pinned prebuilt image, tight resource limits, restart policies, secrets from a vault, and no source code on disk. Copy-pasting two whole `compose.yaml` files that drift apart is the wrong answer.

Compose solves this with **file merging**: a **base** `compose.yaml` holds everything common, and one or more **override** files layer environment-specific changes on top. Compose deep-merges them into one effective config. Dev uses the auto-loaded `compose.override.yaml`; production points at an explicit `compose.prod.yaml`. Config that varies by value (not structure) comes from **environment variables** and `.env` files interpolated into the YAML.

This page shows the override/merge model, environment-specific config, the `deploy:` block for limits and replicas, and — critically — **when to stop using Compose and graduate to Kubernetes**. Compose is a single-host tool; the moment you need multi-node scheduling, self-healing across machines, or zero-downtime rolling deploys at scale, you have outgrown it.

## 2. Core Concepts

- **Base file** — `compose.yaml`: the common definition of all services, valid on its own.
- **Override file** — a second file merged on top; `compose.override.yaml` loads automatically alongside the base.
- **Explicit `-f` stacking** — `docker compose -f a.yaml -f b.yaml` merges left-to-right; later files win on scalars.
- **Merge semantics** — maps deep-merge, scalars are replaced, and most lists are **replaced** (not concatenated) — a frequent surprise.
- **Variable interpolation** — `${VAR}` / `${VAR:-default}` in the YAML, sourced from the shell and the `.env` file in the project dir.
- **`env_file` vs interpolation** — `env_file` injects vars *into the container*; `.env`/`${...}` substitutes values *into the compose file itself*. Different mechanisms.
- **`deploy:` block** — declarative `replicas`, `resources.limits`/`reservations`, `restart_policy`, `update_config`. Honored by Swarm; `limits`/`reservations` and `replicas` also apply to `docker compose up`.
- **`restart:`** — container restart policy for plain Compose (`no`, `on-failure`, `always`, `unless-stopped`).
- **Profiles** — another axis for env variance: enable dev-only services (mailhog, adminer) without a second file.
- **The Compose→K8s line** — Compose is single-host; scaling, HA, and rolling upgrades across nodes are Kubernetes' job.

## 3. Syntax & Examples

Base file — common to every environment:

```yaml
# compose.yaml (base)
services:
  web:
    image: shopapp/web:${TAG:-latest}
    environment:
      DATABASE_URL: postgres://app@db:5432/app
    depends_on:
      db:
        condition: service_healthy
  db:
    image: postgres:16
    volumes: ["pgdata:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app"]
      interval: 5s
      retries: 5
volumes:
  pgdata:
```

Dev override — auto-loaded, adds live-reload and debug:

```yaml
# compose.override.yaml (dev — loaded automatically)
services:
  web:
    build: ./web              # build locally instead of using the pinned image
    volumes:
      - ./web:/code           # bind mount for hot reload
    environment:
      LOG_LEVEL: debug
    ports:
      - "8000:8000"
      - "5678:5678"           # debugger
  db:
    ports:
      - "5432:5432"           # expose DB to host tools in dev only
```

Production override — explicit, adds limits and hardening:

```yaml
# compose.prod.yaml (production — passed explicitly)
services:
  web:
    image: shopapp/web:${TAG}   # pinned, prebuilt, no build:
    restart: unless-stopped
    environment:
      LOG_LEVEL: info
    deploy:
      replicas: 3
      resources:
        limits:   { cpus: "0.50", memory: 512M }
        reservations: { cpus: "0.25", memory: 256M }
  db:
    restart: unless-stopped
    deploy:
      resources:
        limits: { memory: 1G }
```

Select the environment by choosing files:

```bash
# Dev: base + compose.override.yaml (both automatic)
docker compose up -d

# Prod: base + prod override (explicit, override.yaml NOT auto-loaded here)
docker compose -f compose.yaml -f compose.prod.yaml up -d

# See the fully merged, interpolated result before running
docker compose -f compose.yaml -f compose.prod.yaml config
```

## 4. Worked Example

Ship the same stack to dev and prod from one base. First, `.env` supplies values:

```text
# .env
TAG=1.4.2
```

Inspect the merged config so there are no surprises (`config` resolves overrides + interpolation):

```bash
docker compose -f compose.yaml -f compose.prod.yaml config | grep -A2 'image:\|replicas:\|memory:'
```

```text
    image: shopapp/web:1.4.2
      replicas: 3
        memory: 512M
    image: postgres:16
        memory: 1G
```

Note what merged: `web.image` took the prod override's pinned tag (interpolated from `.env`), `build:` from dev is absent, `replicas` and memory limits came from prod, and the healthcheck survived from the base. Now compare what actually runs:

| Aspect | Dev (`up`) | Prod (`-f ... prod up`) |
| --- | --- | --- |
| web source | `build:` + bind mount `./web` | pinned image `shopapp/web:1.4.2` |
| Log level | `debug` | `info` |
| Ports published | 8000, 5678 (debug), 5432 (db) | none extra (edge proxy only) |
| Replicas | 1 | 3 |
| Resource limits | none | cpus 0.5 / mem 512M |
| Restart policy | default | `unless-stopped` |

```bash
docker compose -f compose.yaml -f compose.prod.yaml up -d
docker compose -f compose.yaml -f compose.prod.yaml ps
```

```text
NAME             SERVICE   STATUS              PORTS
shop-db-1        db        Up (healthy)        5432/tcp
shop-web-1       web       Up                  8000/tcp
shop-web-2       web       Up                  8000/tcp
shop-web-3       web       Up                  8000/tcp
```

One base, two behaviors, zero duplicated service definitions.

## 5. Under the Hood

Compose builds the effective config by loading each file in order and deep-merging them into a single document, then interpolating `${...}` variables from the shell environment and `.env`. The `config` subcommand prints exactly this resolved document — your ground truth for "what will actually run."

```svg
<svg viewBox="0 0 720 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a3" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>

  <rect x="30" y="40" width="150" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="105" y="66" text-anchor="middle" fill="#1e293b">compose.yaml</text>
  <text x="105" y="85" text-anchor="middle" fill="#64748b">base</text>

  <rect x="30" y="130" width="150" height="60" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="105" y="156" text-anchor="middle" fill="#1e293b">compose.prod.yaml</text>
  <text x="105" y="175" text-anchor="middle" fill="#64748b">override</text>

  <rect x="30" y="220" width="150" height="60" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="105" y="246" text-anchor="middle" fill="#1e293b">.env / shell</text>
  <text x="105" y="265" text-anchor="middle" fill="#64748b">${TAG}=1.4.2</text>

  <rect x="290" y="120" width="160" height="80" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="370" y="152" text-anchor="middle" fill="#1e293b">deep merge</text>
  <text x="370" y="172" text-anchor="middle" fill="#64748b">maps merge,</text>
  <text x="370" y="188" text-anchor="middle" fill="#64748b">scalars/lists win</text>

  <rect x="540" y="120" width="150" height="80" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="615" y="150" text-anchor="middle" fill="#1e293b">effective</text>
  <text x="615" y="168" text-anchor="middle" fill="#1e293b">config</text>
  <text x="615" y="188" text-anchor="middle" fill="#64748b">→ containers</text>

  <line x1="180" y1="70" x2="288" y2="140" stroke="#475569" marker-end="url(#a3)"/>
  <line x1="180" y1="160" x2="288" y2="160" stroke="#475569" marker-end="url(#a3)"/>
  <line x1="180" y1="250" x2="288" y2="180" stroke="#475569" marker-end="url(#a3)"/>
  <line x1="450" y1="160" x2="538" y2="160" stroke="#475569" marker-end="url(#a3)"/>
  <text x="235" y="30" text-anchor="middle" fill="#64748b">later files & vars override earlier</text>
</svg>
```

The merge rule that bites people: **maps merge recursively, but scalars are replaced and most sequences (lists) are replaced wholesale, not appended.** So if prod sets `ports: ["80:80"]`, it *replaces* the dev port list rather than adding to it. Environment maps (`environment:` in map form) merge key-by-key; the same block written as a list is replaced entirely. When in doubt, run `docker compose ... config` and read the resolved output before deploying.

## 6. Variations & Trade-offs

| Strategy | How | Pros | Cons |
| --- | --- | --- | --- |
| Auto override | `compose.override.yaml` loaded by default | Zero flags for dev | Silent — easy to forget it's applied; skipped once you use explicit `-f` |
| Explicit `-f` stack | `-f base -f prod` | Clear, scriptable, CI-friendly | Verbose; must repeat the flags |
| `--profile` | Tag env-specific services | One file, toggle service sets | Only adds/removes services, not per-service tweaks |
| Multiple `.env` | `--env-file .env.prod` | Swap values without touching YAML | Only values, not structure |
| Separate full files | `compose.dev.yaml`, `compose.prod.yaml` standalone | Fully explicit | Duplication drifts — anti-pattern |

For values that change (image tag, log level, replica count), prefer interpolation + `.env`. For structure that changes (bind mounts, debug services, limits), prefer override files. Combine both. Reserve profiles for "does this service exist at all in this env."

**Compose vs Kubernetes** — the graduation decision:

| Need | Compose | Kubernetes |
| --- | --- | --- |
| Multi-container on one host | ✅ ideal | overkill |
| Multi-node scheduling | ❌ single host | ✅ core feature |
| Self-healing (reschedule on node death) | ❌ | ✅ |
| Horizontal autoscaling | ❌ | ✅ HPA |
| Zero-downtime rolling deploys | limited (Swarm) | ✅ native |
| Secrets/config management | basic | ✅ Secrets/ConfigMaps + RBAC |
| Learning + ops cost | low | high |

## 7. Production / Performance Notes

- **Never bind-mount source in prod.** Ship a self-contained, pinned image (`shopapp/web:1.4.2`), not `latest` and not your working tree. Bind mounts are a dev-only convenience.
- **Set resource limits.** Without `deploy.resources.limits`, one runaway container can starve the host. Set memory limits especially — an OOM on a limited container is contained, an unbounded one takes the box down.
- **Use restart policies.** `restart: unless-stopped` keeps services up across daemon restarts without overriding an intentional manual stop.
- **`config` before deploy.** Always run `docker compose -f ... config` in CI to catch bad interpolation or an unexpected list replacement before it hits prod.
- **Externalize secrets.** Pull real credentials from an env injected by your platform or Docker/Compose secrets — never from a committed file. Gitignore `.env` files with real values.
- **Know the ceiling.** Plain `docker compose up` runs replicas on *one host* with no rescheduling. If that host dies, everything dies. That is the practical signal to move to Kubernetes.
- **Swarm is the middle ground** (rarely chosen new): `deploy:` fields like `update_config` and multi-node placement are honored by `docker stack deploy`, but the ecosystem momentum is with Kubernetes.

## 8. Common Mistakes

1. ⚠️ **Two full duplicated compose files** that drift. Fix: one base + thin overrides.
2. ⚠️ **Expecting `compose.override.yaml` to load when you pass explicit `-f`.** It doesn't — explicit `-f` replaces the auto-load. Fix: list every file you want in the `-f` chain.
3. ⚠️ **Assuming lists merge/append.** They're replaced. Fix: verify with `config`; restate the full list in the override.
4. ⚠️ **`latest` in production.** Non-reproducible and silently drifting. Fix: pin an explicit tag, ideally via `${TAG}`.
5. ⚠️ **No memory limits**, letting a leak OOM the whole host. Fix: set `deploy.resources.limits.memory`.
6. ⚠️ **Bind-mounting source into a prod container.** Fix: build a self-contained image; bind mounts are dev-only.
7. ⚠️ **Confusing `env_file` with `.env` interpolation.** One injects into the container, the other substitutes into the YAML. Fix: use the right one for the job.
8. ⚠️ **Scaling Compose replicas and expecting HA.** They're all on one host with no rescheduling. Fix: move to Kubernetes when you need real HA/scale.

## 9. Interview Questions

**Q: How do you run the same Compose app differently in dev vs production?**
A: Keep one base `compose.yaml` with common config and layer environment-specific override files on top — `compose.override.yaml` (auto-loaded) for dev, an explicit `compose.prod.yaml` via `-f` for prod — plus variable interpolation from `.env` for values that differ.

**Q: What's the difference between `compose.override.yaml` and passing `-f`?**
A: `compose.override.yaml` is merged automatically on top of `compose.yaml` with no flags. As soon as you pass explicit `-f` files, the automatic override is *not* loaded — you control the exact merge chain yourself.

**Q: How does Compose merge multiple files?**
A: It deep-merges in order (later wins): maps merge recursively key-by-key, scalars are replaced, and most sequences/lists are replaced wholesale rather than appended. `docker compose config` prints the resolved result.

**Q: What's a common surprise in the merge semantics?**
A: Lists don't concatenate — an override's `ports:` or list-form `environment:` replaces the base's entirely. People expect appending and lose entries; running `config` reveals it.

**Q: What's the difference between `env_file` and the `.env` file?**
A: `env_file` injects variables *into the running container's environment*. The project `.env` (and `${VAR}` syntax) substitutes values *into the compose file itself* at parse time. Different mechanisms, often confused.

**Q: What does the `deploy:` block do?**
A: It declares operational intent — `replicas`, `resources.limits`/`reservations`, `restart_policy`, `update_config`. Swarm honors all of it; plain `docker compose up` applies `resources` limits/reservations and `replicas`.

**Q: How do you set resource limits, and why does it matter in production?**
A: Under `deploy.resources.limits` (e.g. `cpus`, `memory`). It matters because an unbounded container with a leak can OOM or starve the whole host; a limited container's failure is contained.

**Q: How do you verify your production config before deploying? (senior)**
A: `docker compose -f compose.yaml -f compose.prod.yaml config` prints the fully merged and interpolated document — run it in CI to catch bad variable substitution or unexpected list replacement before it ships.

**Q: When should a team graduate from Compose to Kubernetes? (senior)**
A: When they need what Compose structurally can't do on a single host: multi-node scheduling, self-healing/rescheduling on node failure, horizontal autoscaling, and zero-downtime rolling deploys across a cluster. Below that — single host, modest scale — Compose is simpler and sufficient.

**Q: You scaled a Compose service to 3 replicas — is that high availability? (senior)**
A: No. All three run on one host with no cross-node rescheduling; if that host dies, all replicas die. It's local concurrency, not HA. Real HA needs an orchestrator spreading replicas across nodes.

**Q: How would you keep secrets out of your compose setup? (senior)**
A: Never commit them: use platform-injected environment variables or Docker/Compose secrets, keep real values in gitignored env files, and reference them via interpolation — so the repo holds only names and defaults, not credentials.

**Q: Why is `latest` dangerous in a production compose file? (senior)**
A: It's a moving pointer — the image you deploy today differs from tomorrow's with no version record, breaking reproducibility and rollbacks. Pin an explicit immutable tag (often via `${TAG}`) so every environment runs a known artifact.

## 10. Practice

- [ ] Split an app into a base `compose.yaml` plus `compose.override.yaml` (dev bind mounts/debug) and `compose.prod.yaml` (pinned image, limits, restart policy).
- [ ] Run `docker compose -f compose.yaml -f compose.prod.yaml config` and confirm the merged image tag, replicas, and limits.
- [ ] Interpolate the image tag from `.env` (`${TAG}`) and change environments by editing only `.env`.
- [ ] Add `deploy.resources.limits.memory` and observe the container's memory cap with `docker stats`.
- [ ] Write a one-paragraph decision note for your app: does it stay on Compose or move to Kubernetes, and why?

## 11. Cheat Sheet

> [!TIP]
> **Dev vs prod.** One base `compose.yaml`; layer overrides. `compose.override.yaml` auto-loads for dev (bind mounts, debug ports, verbose logs); pass `-f compose.yaml -f compose.prod.yaml` explicitly for prod (pinned image, `restart: unless-stopped`, `deploy.resources.limits`, `replicas`). Explicit `-f` disables the auto override. Merge rule: maps deep-merge, scalars & **lists replace** (not append) — always check `docker compose config`. Values via `${VAR}`/`.env`; structure via override files; service on/off via profiles. `env_file` → into container, `.env` → into the YAML. Never `latest`, never bind-mount source, always memory limits, secrets injected not committed. Graduate to Kubernetes when you need multi-node scheduling, self-healing, autoscaling, or rolling deploys — Compose replicas on one host are not HA.

**References:** Docker Compose docs "Multiple Compose files / Merge", Compose Specification (deploy, env), Docker docs "Environment variables", Kubernetes docs (overview)

---

*Docker Handbook — topic 20.*
