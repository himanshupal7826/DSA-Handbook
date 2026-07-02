# 18 · Docker Compose Fundamentals

> **In one line:** Declare a whole multi-container application — services, networks, volumes, and env — in one YAML file and manage it with a single command.

---

## 1. Overview

A real app is rarely one container. You have an API, a database, a cache, maybe a worker and a reverse proxy. Wiring those by hand with `docker run` — remembering flags, network names, volume mounts, and startup order every time — is tedious and error-prone. **Docker Compose** replaces that ritual with a declarative file, `compose.yaml`, that describes the desired end state of the whole stack.

You describe **what** you want (three services, this image, these ports, this shared volume); Compose figures out **how** to create it — building images, creating a dedicated network, provisioning named volumes, and starting containers in dependency order. `docker compose up` reconciles the running state to match the file; `docker compose down` tears it all back down cleanly.

Compose is the default tool for **local development** (one command spins up your entire dev environment) and for **single-host deployments** (a VM running a modest production stack). It is not a cluster orchestrator — for multi-node scaling and self-healing you graduate to Kubernetes (covered in topic 20).

Compose today ships as `docker compose` (the v2 Go plugin, a subcommand of the Docker CLI). The old `docker-compose` (v1, Python, hyphenated) is deprecated. Use the space, not the hyphen.

## 2. Core Concepts

- **Service** — a named container definition (`web`, `db`, `cache`). One service can scale to multiple replica containers, but it is described once.
- **`compose.yaml`** — the file. Compose auto-discovers `compose.yaml` or `compose.yml` (also legacy `docker-compose.yaml`) in the working directory. No top-level `version:` key is needed anymore.
- **`build` vs `image`** — `build:` tells Compose to build from a Dockerfile; `image:` tells it to pull a prebuilt image. You can set both: build locally *and* tag the result with `image:`.
- **Project** — a Compose deployment is namespaced by a **project name** (default: the directory name). Every container, network, and volume is prefixed with it, so two projects never collide.
- **Default network** — Compose creates one bridge network for the project; every service joins it and is reachable by its **service name** as DNS.
- **Named volumes** — declared under top-level `volumes:` and mounted into services; they survive `down` and container recreation.
- **`environment` / `env_file`** — inject configuration as environment variables inline or from a `.env`-style file.
- **Lifecycle commands** — `up`, `down`, `ps`, `logs`, `exec`, `build`, `pull`, `restart` operate on the whole project or a chosen service.
- **Idempotent reconciliation** — rerunning `up` only recreates containers whose config changed; unchanged services are left running.

## 3. Syntax & Examples

Minimal single service:

```yaml
services:
  web:
    image: nginx:1.27
    ports:
      - "8080:80"
```

Build from a local Dockerfile instead of pulling:

```yaml
services:
  api:
    build: .                 # Dockerfile in current dir
    ports:
      - "8000:8000"
```

Explicit build context, custom Dockerfile, and build args:

```yaml
services:
  api:
    build:
      context: ./api
      dockerfile: Dockerfile.prod
      args:
        APP_VERSION: "1.4.2"
    image: myorg/api:1.4.2   # tag the built image
    ports:
      - "8000:8000"
    environment:
      LOG_LEVEL: info
      DATABASE_URL: postgres://app:secret@db:5432/app
    env_file:
      - .env                 # extra vars from file
    volumes:
      - ./api:/code          # bind mount for live-reload dev
    restart: unless-stopped
```

Port and volume syntax cheatsheet:

```yaml
    ports:
      - "8080:80"            # host:container
      - "127.0.0.1:5432:5432" # bind only to localhost
    volumes:
      - pgdata:/var/lib/postgresql/data   # named volume
      - ./config:/etc/app:ro              # bind mount, read-only
```

## 4. Worked Example

A realistic **web + database + cache** stack: a Python API that talks to Postgres and Redis.

```yaml
# compose.yaml
services:
  web:
    build: ./web
    image: shopapp/web:dev
    ports:
      - "8000:8000"
    environment:
      DATABASE_URL: postgres://app:secret@db:5432/app
      REDIS_URL: redis://cache:6379/0
    depends_on:
      db:
        condition: service_healthy
      cache:
        condition: service_started
    restart: unless-stopped

  db:
    image: postgres:16
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: secret
      POSTGRES_DB: app
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d app"]
      interval: 5s
      timeout: 3s
      retries: 5

  cache:
    image: redis:7-alpine
    command: ["redis-server", "--save", "", "--appendonly", "no"]

volumes:
  pgdata:
```

Bring it up and inspect it:

```bash
docker compose up -d --build     # build images, start in background
docker compose ps                # list this project's containers
docker compose logs -f web       # follow the web service logs
docker compose exec db psql -U app -d app -c '\dt'   # run a command inside db
docker compose down              # stop + remove containers & network
docker compose down -v           # ...and delete the pgdata volume too
```

`docker compose ps` output:

```text
NAME              IMAGE              SERVICE   STATUS                   PORTS
shop-cache-1      redis:7-alpine     cache     Up 12s                   6379/tcp
shop-db-1         postgres:16        db        Up 12s (healthy)         5432/tcp
shop-web-1        shopapp/web:dev    web       Up 8s                    0.0.0.0:8000->8000/tcp
```

Note the naming pattern `<project>-<service>-<index>`. The project `shop` came from the directory (or `-p shop`). `db` shows `(healthy)` because Compose waited for its healthcheck before starting `web`.

## 5. Under the Hood

Compose is a thin, declarative controller over the Docker Engine API. When you run `up`, it parses the YAML into a project model, computes what already exists, and creates only the diff: a project network, named volumes, then containers in topological order derived from `depends_on`.

```svg
<svg viewBox="0 0 720 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <rect x="20" y="20" width="160" height="70" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="100" y="48" text-anchor="middle" fill="#1e293b">compose.yaml</text>
  <text x="100" y="68" text-anchor="middle" fill="#64748b">desired state</text>

  <rect x="280" y="20" width="160" height="70" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="360" y="48" text-anchor="middle" fill="#1e293b">docker compose</text>
  <text x="360" y="68" text-anchor="middle" fill="#64748b">reconciler</text>

  <rect x="540" y="20" width="160" height="70" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="620" y="48" text-anchor="middle" fill="#1e293b">Docker Engine</text>
  <text x="620" y="68" text-anchor="middle" fill="#64748b">API</text>

  <line x1="180" y1="55" x2="278" y2="55" stroke="#475569" marker-end="url(#arrow)"/>
  <line x1="440" y1="55" x2="538" y2="55" stroke="#475569" marker-end="url(#arrow)"/>

  <rect x="200" y="150" width="320" height="170" rx="8" fill="none" stroke="#64748b" stroke-dasharray="4 4"/>
  <text x="360" y="172" text-anchor="middle" fill="#64748b">project: shop  ·  network: shop_default</text>

  <rect x="220" y="190" width="120" height="50" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="280" y="220" text-anchor="middle" fill="#1e293b">web</text>

  <rect x="380" y="190" width="120" height="50" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="440" y="220" text-anchor="middle" fill="#1e293b">db (healthy)</text>

  <rect x="300" y="260" width="120" height="45" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="360" y="288" text-anchor="middle" fill="#1e293b">cache</text>

  <line x1="340" y1="215" x2="378" y2="215" stroke="#475569" marker-end="url(#arrow)"/>
  <line x1="290" y1="240" x2="345" y2="262" stroke="#475569" marker-end="url(#arrow)"/>
  <line x1="620" y1="90" x2="440" y2="188" stroke="#475569" stroke-dasharray="3 3" marker-end="url(#arrow)"/>
  <text x="560" y="150" text-anchor="middle" fill="#64748b">creates</text>
</svg>
```

Under the covers each service becomes one or more containers attached to the project network; DNS resolution between them is handled by Docker's embedded DNS server (127.0.0.11 inside the containers), which maps each service name to its container IPs. Labels like `com.docker.compose.project` and `com.docker.compose.service` are stamped on every object so Compose can find "its" resources later for `ps`, `logs`, and `down`.

## 6. Variations & Trade-offs

| Choice | Option A | Option B | Guidance |
| --- | --- | --- | --- |
| Image source | `build:` (local Dockerfile) | `image:` (registry pull) | Build for your own app code; pull for stock services (Postgres, Redis). Combine to build-and-tag. |
| Volume type | Named volume | Bind mount | Named for stateful data (DB); bind for live source in dev. |
| Detach mode | `up` (foreground, streamed logs) | `up -d` (background) | Foreground for a quick look; `-d` for a persistent dev/prod stack. |
| Project name | Default (dir name) | `-p` / `COMPOSE_PROJECT_NAME` | Set explicitly to run multiple copies or pin a stable name in CI. |
| Config injection | `environment:` inline | `env_file:` | Inline for a few values; file to keep secrets out of YAML and share across services. |
| CLI | `docker compose` (v2) | `docker-compose` (v1) | Always v2; v1 is end-of-life. |

Compose trades expressiveness for simplicity. It is single-host: no multi-node scheduling, no rolling deploys across machines, no built-in self-healing beyond `restart:` policies. That is exactly why it is so pleasant for dev — and why production at scale moves to Kubernetes.

## 7. Production / Performance Notes

- **Pin versions.** `postgres:16`, not `postgres:latest`. `latest` silently drifts and breaks reproducibility across machines and time.
- **Keep secrets out of the YAML.** Use `env_file:`, Docker secrets, or an injected environment — never commit real passwords in `compose.yaml`.
- **Use `restart: unless-stopped`** for long-running services so they survive daemon restarts without fighting your manual `stop`.
- **Named volumes for all state.** Anonymous volumes are orphaned on recreate and silently lose data.
- **`up -d --build` in CI/dev** rebuilds changed images; add `--pull` to refresh base images. In prod prefer prebuilt, tagged images from a registry (`docker compose pull` then `up -d`).
- **Resource hygiene.** `docker compose down --remove-orphans` cleans containers left behind by renamed services; periodically prune dangling images and volumes.
- **One project per stack.** Rely on the project name for isolation so a dev copy and a test copy of the same app coexist on one host.

## 8. Common Mistakes

1. ⚠️ **Using `docker-compose` (v1).** It is deprecated and behaves subtly differently. Fix: use `docker compose` (v2, space).
2. ⚠️ **Leaving a `version:` key at the top.** Modern Compose ignores it and may warn. Fix: delete it; the Compose Spec is unversioned.
3. ⚠️ **Assuming `depends_on` waits for readiness.** It only waits for the container to *start*, not to be *ready*. Fix: add a `healthcheck` and `condition: service_healthy` (topic 19).
4. ⚠️ **Hardcoding a host in the app** instead of the service name. Fix: connect to `db:5432`, letting Compose DNS resolve it.
5. ⚠️ **Committing secrets in the YAML.** Fix: move them to an `env_file`/secret and gitignore it.
6. ⚠️ **Anonymous volumes for databases.** Fix: declare a named volume and mount it to the data dir.
7. ⚠️ **Port clashes** — two services (or two projects) binding the same host port. Fix: change the host side, or bind to `127.0.0.1` only.
8. ⚠️ **Editing YAML but not recreating** — running containers keep old config. Fix: rerun `docker compose up -d` to reconcile.

## 9. Interview Questions

**Q: What problem does Docker Compose solve?**
A: It replaces long, repetitive `docker run` invocations with one declarative file describing a multi-service app — images/builds, ports, volumes, env, network, and startup order — managed by a single `up`/`down` command.

**Q: What is the difference between the `build` and `image` keys?**
A: `build` builds an image from a Dockerfile/context; `image` pulls a prebuilt image from a registry. Setting both builds locally and tags the result with the `image` name.

**Q: How do services discover and talk to each other in Compose?**
A: Compose creates a default bridge network for the project and registers each service name in Docker's embedded DNS, so a service reaches another by its service name and port, e.g. `postgres://db:5432`.

**Q: What is a Compose "project" and why does the project name matter?**
A: A project is one Compose deployment, namespaced by the project name (default: the directory). Every container, network, and volume is prefixed with it, giving isolation so multiple copies of the same app can coexist on one host. Override with `-p` or `COMPOSE_PROJECT_NAME`.

**Q: What does `docker compose down` do, and what does `-v` add?**
A: `down` stops and removes the project's containers and the default network. `-v` also deletes the named volumes declared in the file — so it destroys persisted data like the database.

**Q: How is `docker compose` v2 different from `docker-compose` v1?**
A: v2 is a Go plugin invoked as a `docker` subcommand (space), integrated with the CLI and actively maintained; v1 was a separate Python tool (hyphen) and is deprecated/end-of-life.

**Q: Where should you put secrets and environment-specific config?**
A: Not inline in the YAML. Use `env_file:` (gitignored), Docker/Compose secrets, or externally injected environment variables — keeping credentials out of version control.

**Q: You changed compose.yaml but the running container still has old config — why?**
A: Running containers aren't live-reconfigured. Compose only recreates a container when you run `up` again and detects a config change; rerun `docker compose up -d` to apply it.

**Q: When would you choose Compose over Kubernetes, and when not? (senior)**
A: Compose for local dev and modest single-host deployments where simplicity wins. Move to Kubernetes when you need multi-node scheduling, horizontal scaling, self-healing, rolling deploys, and declarative infra at scale — Compose is single-host and has none of that.

**Q: How does Compose decide what to recreate on a repeated `up`? (senior)**
A: It hashes each service's resolved config and compares to labels on existing containers; unchanged services are left running, changed ones are recreated. This idempotent reconciliation is why `up` is safe to rerun.

**Q: How would you run two isolated instances of the same Compose app on one machine? (senior)**
A: Give them distinct project names (`-p appA`, `-p appB`) so networks/volumes/containers don't collide, and ensure their published host ports differ (or bind to different interfaces).

**Q: Why can't `depends_on` alone guarantee your app connects to the DB successfully? (senior)**
A: `depends_on` only orders container *start*, not application *readiness* — Postgres accepts connections seconds after the process starts. You need a healthcheck plus `condition: service_healthy`, or app-side connection retries.

## 10. Practice

- [ ] Write a `compose.yaml` for a web + Postgres + Redis stack with a named volume for the DB.
- [ ] Run `docker compose up -d --build`, then `ps` and `logs -f web`; confirm the naming pattern `<project>-<service>-<index>`.
- [ ] Move the DB password out of the YAML into an `env_file` and confirm the app still connects.
- [ ] Start the same stack twice with different `-p` project names and different host ports; verify isolation with `docker compose -p <name> ps`.
- [ ] Run `docker compose down` vs `down -v` and observe whether the DB data survives a restart.

## 11. Cheat Sheet

> [!TIP]
> **Compose in one screen.** Declare services in `compose.yaml` (no `version:` key). `build:` to build, `image:` to pull, both to build-and-tag. Services share a default network and find each other by **service name** DNS (`db:5432`). Named volumes under top-level `volumes:` persist state; bind mounts (`./src:/code`) for dev. Project name (dir or `-p`) namespaces everything. Lifecycle: `up -d --build`, `ps`, `logs -f <svc>`, `exec <svc> <cmd>`, `down` (add `-v` to drop volumes). Keep secrets in `env_file`, pin versions, use `restart: unless-stopped`. `depends_on` orders start, not readiness — pair with healthchecks. Always `docker compose` (v2), never `docker-compose` (v1).

**References:** Docker Compose docs, Compose Specification, Docker docs "Compose file reference"

---

*Docker Handbook — topic 18.*
