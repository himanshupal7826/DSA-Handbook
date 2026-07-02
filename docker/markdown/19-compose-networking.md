# 19 · Compose Networking & Dependencies

> **In one line:** How Compose wires services together — service-name DNS, custom networks, real readiness ordering, shared volumes, and optional profiles.

---

## 1. Overview

Once you have more than one service, two questions dominate: *how do they find each other* and *in what order do they come up*. Compose answers both with sensible defaults, but the defaults have sharp edges — the biggest being that `depends_on` looks like it guarantees readiness and does not.

By default Compose drops every service in a project onto one **bridge network** and gives each an addressable DNS name equal to its **service name**. That is the whole discovery story: your API connects to `db:5432`, no IPs, no links, no hosts file. For larger stacks you can carve services into **multiple custom networks** to enforce isolation (e.g. keep the database off the network your public proxy sits on).

Ordering is where seniors earn their keep. `depends_on` orders *start*; combining it with a **healthcheck** and `condition: service_healthy` orders *readiness*. This page draws the service graph, then shows how networks, shared volumes, and **profiles** shape which services exist and how they reach one another.

## 2. Core Concepts

- **Default network** — one bridge network per project (`<project>_default`); all services join it automatically.
- **Service-name DNS** — Docker's embedded resolver (127.0.0.11) maps each service name to its container IP(s). Connect by name, never by hardcoded IP.
- **Aliases** — a service can advertise extra DNS names on a network via `networks.<net>.aliases`.
- **Custom networks** — declare under top-level `networks:` and attach services selectively to segment traffic; a service only reaches services on a network it shares.
- **`depends_on` (short form)** — orders container *start* only; does not wait for the process to be ready.
- **`healthcheck`** — a probe (`test`, `interval`, `retries`) that marks a container `healthy`/`unhealthy`.
- **`condition:`** — long-form `depends_on` gate: `service_started`, `service_healthy`, or `service_completed_successfully`.
- **Shared volumes** — a named volume mounted into two services lets them exchange files (e.g. a build service writing assets that a web service serves).
- **Profiles** — tag services so they only start when their profile is activated (`--profile`), keeping optional tools (debuggers, seeders) out of the default `up`.
- **`ports` vs `expose`** — `ports` publishes to the host; intra-project traffic needs neither — the container port is already reachable over the shared network.

## 3. Syntax & Examples

Service-name DNS (no network config needed):

```yaml
services:
  web:
    image: myapp/web
    environment:
      DB_HOST: db          # resolves to the db container
      CACHE_HOST: cache
  db:
    image: postgres:16
  cache:
    image: redis:7
```

Custom networks to isolate the database from the edge:

```yaml
services:
  proxy:
    image: nginx:1.27
    networks: [frontend]
    ports: ["80:80"]
  web:
    build: ./web
    networks: [frontend, backend]   # bridges both tiers
  db:
    image: postgres:16
    networks: [backend]             # unreachable from proxy

networks:
  frontend:
  backend:
```

Real readiness with a healthcheck + condition:

```yaml
services:
  web:
    build: ./web
    depends_on:
      db:
        condition: service_healthy          # wait until DB passes healthcheck
      migrate:
        condition: service_completed_successfully  # wait until migration exits 0
  db:
    image: postgres:16
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app"]
      interval: 5s
      timeout: 3s
      retries: 5
      start_period: 10s
  migrate:
    build: ./web
    command: ["python", "manage.py", "migrate"]
    depends_on:
      db:
        condition: service_healthy
```

Shared volume between two services and a profile-gated tool:

```yaml
services:
  builder:
    build: ./builder
    volumes: ["assets:/out"]      # writes compiled assets
  web:
    image: nginx:1.27
    volumes: ["assets:/usr/share/nginx/html:ro"]  # serves them
  adminer:
    image: adminer:4
    profiles: ["debug"]           # only with --profile debug
    ports: ["8081:8080"]

volumes:
  assets:
```

## 4. Worked Example

A four-service stack — edge proxy, API, database, cache — with tiered networks and proper ordering. Watch how the graph and the readiness gates behave.

```bash
docker compose up -d
docker compose ps
```

```text
NAME             SERVICE   STATUS               PORTS
shop-proxy-1     proxy     Up 3s                0.0.0.0:80->80/tcp
shop-web-1       web       Up 4s                8000/tcp
shop-db-1        db        Up 15s (healthy)     5432/tcp
shop-cache-1     cache     Up 15s               6379/tcp
```

Prove DNS and network isolation from inside the containers:

```bash
# web is on both tiers -> can reach db
docker compose exec web getent hosts db
# 172.19.0.4      db

# proxy is only on frontend -> cannot resolve db
docker compose exec proxy getent hosts db
# (empty, non-zero exit) — db is not on the frontend network
```

The startup timeline: `db` and `cache` start first; `db` takes ~15s to report `healthy`; only then does `web` start (its `condition: service_healthy` gate held it back); `proxy` starts once `web` is up. This is real readiness ordering, not just a start race.

```svg
<svg viewBox="0 0 720 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>

  <rect x="40" y="40" width="300" height="130" rx="8" fill="none" stroke="#2563eb" stroke-dasharray="5 4"/>
  <text x="190" y="60" text-anchor="middle" fill="#2563eb">network: frontend</text>

  <rect x="380" y="40" width="300" height="300" rx="8" fill="none" stroke="#059669" stroke-dasharray="5 4"/>
  <text x="530" y="60" text-anchor="middle" fill="#059669">network: backend</text>

  <rect x="90" y="90" width="120" height="55" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="150" y="113" text-anchor="middle" fill="#1e293b">proxy</text>
  <text x="150" y="132" text-anchor="middle" fill="#64748b">:80 host</text>

  <rect x="300" y="90" width="140" height="55" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="370" y="113" text-anchor="middle" fill="#1e293b">web (API)</text>
  <text x="370" y="132" text-anchor="middle" fill="#64748b">both tiers</text>

  <rect x="470" y="150" width="120" height="55" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="530" y="173" text-anchor="middle" fill="#1e293b">db</text>
  <text x="530" y="192" text-anchor="middle" fill="#64748b">healthy gate</text>

  <rect x="470" y="240" width="120" height="55" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="530" y="263" text-anchor="middle" fill="#1e293b">cache</text>
  <text x="530" y="282" text-anchor="middle" fill="#64748b">redis</text>

  <line x1="210" y1="117" x2="298" y2="117" stroke="#475569" marker-end="url(#a2)"/>
  <text x="255" y="107" text-anchor="middle" fill="#64748b">web:8000</text>

  <line x1="440" y1="130" x2="470" y2="165" stroke="#475569" marker-end="url(#a2)"/>
  <text x="470" y="128" text-anchor="middle" fill="#64748b">db:5432</text>

  <line x1="440" y1="140" x2="470" y2="255" stroke="#475569" marker-end="url(#a2)"/>
  <text x="455" y="215" text-anchor="middle" fill="#64748b">cache:6379</text>

  <line x1="150" y1="145" x2="150" y2="200" stroke="#b91c1c" stroke-dasharray="4 3"/>
  <text x="150" y="220" text-anchor="middle" fill="#b91c1c">✗ cannot reach db</text>
  <text x="150" y="238" text-anchor="middle" fill="#64748b">(not on backend)</text>
</svg>
```

## 5. Under the Hood

Every Compose network is a Docker network object (default driver `bridge`). Each container attached to it gets an interface and an IP on that subnet, plus entries in the embedded DNS server. When your app resolves `db`, the request goes to 127.0.0.11 inside the container, which returns the current IP of the `db` service — so scaling `db` to multiple replicas returns multiple A records and container recreation just updates the mapping. A service that is *not* on a shared network has no DNS entry there, which is exactly how the isolation in the diagram works: `proxy` can't even resolve `db`, let alone route to it.

Readiness ordering is implemented by Compose watching container health/state before creating dependents. With `condition: service_healthy`, Compose polls the dependency's healthcheck status and blocks the dependent's creation until it flips to `healthy` (or times out). `service_completed_successfully` waits for a one-shot container (like a migration) to exit 0 — the idiom for run-once init steps. Without these conditions, `depends_on` returns as soon as the dependency's container is *created and started*, which for a database is far too early.

## 6. Variations & Trade-offs

| Mechanism | What it guarantees | What it does NOT | Use when |
| --- | --- | --- | --- |
| `depends_on` (short) | Start ordering | Readiness | Cheap ordering where the app retries connections itself |
| `depends_on` + `service_healthy` | Waits until dependency passes healthcheck | Nothing about app-level correctness | DBs/brokers that accept connections only after warm-up |
| `depends_on` + `service_completed_successfully` | One-shot job finished exit 0 | Long-running readiness | Migrations, seeders, fixtures before app boot |
| App-side retry/backoff | Resilience to *any* restart, not just first boot | Startup speed | Production — dependencies can restart anytime |
| Default single network | Simple flat discovery | Isolation | Small dev stacks |
| Custom multi-network | Tier isolation (edge can't reach DB) | Simplicity | Least-privilege topologies, defense in depth |
| Profiles | Optional services off by default | Runtime toggling of core services | Debug tools, seed jobs, rarely-used add-ons |

Healthcheck-gated ordering makes `up` slower and more deterministic; app-side retries make it faster and more resilient but push complexity into your code. Seniors use both: healthchecks for a clean first boot, retries because dependencies restart in the middle of the night.

## 7. Production / Performance Notes

- **Don't rely on start ordering for correctness in prod.** Containers restart independently; a DB can vanish and return while your app is running. Build reconnect/backoff into the app regardless of `depends_on`.
- **Tune healthchecks.** Use `start_period` to avoid counting a legitimate warm-up as failures; keep `interval` short enough that ordering isn't sluggish but not so short it hammers the service.
- **Segment networks for least privilege.** Put the database on a `backend` network only; keep it off the network your public edge proxy uses. This limits blast radius if the edge is compromised.
- **Publish only what must be public.** Intra-project traffic needs no `ports:` — the container port is already reachable over the shared network. Publishing a DB port to the host is a common accidental exposure.
- **Shared volumes create coupling.** Two services on one volume must agree on file layout and permissions; prefer read-only (`:ro`) on the consumer to prevent surprises.
- **Profiles keep default `up` lean.** Gate heavy or sensitive tools (DB admin UIs, load generators) behind a profile so a plain `up` never starts them.

## 8. Common Mistakes

1. ⚠️ **Treating `depends_on` as readiness.** It only orders start. Fix: add a `healthcheck` and `condition: service_healthy`.
2. ⚠️ **Hardcoding container IPs.** They change on recreate/scale. Fix: connect by service name via DNS.
3. ⚠️ **Expecting isolation on the default network.** Everything on it can talk to everything. Fix: define custom networks and attach services selectively.
4. ⚠️ **Publishing internal service ports to the host** "so services can talk." Fix: remove `ports:`; the shared network already connects them.
5. ⚠️ **No `start_period` on a slow-booting dependency**, so early probe failures exhaust `retries`. Fix: set `start_period` to cover warm-up.
6. ⚠️ **Running migrations as a normal dependency** and racing the app. Fix: a one-shot `migrate` service gated by `service_completed_successfully`.
7. ⚠️ **Forgetting a service is on the wrong network**, causing a name to not resolve. Fix: ensure both endpoints share at least one network.
8. ⚠️ **Assuming profile-gated services run on plain `up`.** They don't. Fix: pass `--profile <name>` (or `COMPOSE_PROFILES`).

## 9. Interview Questions

**Q: How do services communicate in Docker Compose by default?**
A: Compose attaches every service to a default project bridge network and registers each service name in Docker's embedded DNS, so a service connects to another by its service name and container port, e.g. `db:5432` — no IPs or links.

**Q: What exactly does `depends_on` guarantee?**
A: Only start ordering — the dependency's container is created and started before the dependent. It does not wait for the process inside to be ready to serve traffic.

**Q: How do you make Compose wait for a database to be actually ready?**
A: Give the dependency a `healthcheck` (e.g. `pg_isready`) and use long-form `depends_on` with `condition: service_healthy` on the dependent, so Compose blocks until the healthcheck passes.

**Q: What are the three `depends_on` conditions and when do you use each?**
A: `service_started` (just started, the default behavior), `service_healthy` (passes its healthcheck — for DBs/brokers), and `service_completed_successfully` (a one-shot container exited 0 — for migrations/seeders).

**Q: Why would you define custom networks instead of using the default one?**
A: To segment traffic for least privilege — e.g. put the DB on a `backend` network only and the proxy on `frontend`, so the public edge literally cannot resolve or reach the database. A service can only talk to services on a network it shares.

**Q: How can two services share files in Compose?**
A: Mount the same named volume into both — one writes, the other reads (often `:ro`). For example a builder writes compiled assets to a shared `assets` volume that the web server serves.

**Q: What are Compose profiles for?**
A: They tag optional services so they're excluded from a plain `up` and only start when their profile is activated with `--profile <name>` or `COMPOSE_PROFILES` — ideal for debug UIs, seeders, and rarely-used tools.

**Q: Do services need `ports:` to talk to each other? (senior)**
A: No. `ports:` publishes to the host. Intra-project traffic flows over the shared network directly to the container port, so publishing is only for reaching a service from outside the project — and publishing internal ports needlessly is an exposure risk.

**Q: Even with healthchecks, why do production apps still need connection retries? (senior)**
A: Healthcheck ordering only helps on first boot. Dependencies can restart, fail, or become briefly unreachable at any time while the app runs, so the app must reconnect with backoff regardless of startup ordering.

**Q: How does DNS behave when you scale a service to multiple replicas? (senior)**
A: The service name resolves to multiple A records (one per replica container); the embedded DNS returns them and clients/round-robin distribute across the IPs. Recreated containers update their DNS mapping automatically.

**Q: How would you run database migrations before the app starts, exactly once? (senior)**
A: A dedicated one-shot `migrate` service that runs the migration command and exits, with the app's `depends_on` set to `migrate: { condition: service_completed_successfully }` and `migrate` itself gated on `db: service_healthy`.

**Q: What's the risk of relying on start ordering alone in production? (senior)**
A: Ordering is a first-boot property; it says nothing about mid-run failures. Without app-side retry/backoff, a transient dependency restart takes down your service even though the initial ordering was correct.

## 10. Practice

- [ ] Build a proxy/web/db/cache stack; put `db` on a `backend`-only network and prove the proxy can't resolve `db` with `getent hosts db`.
- [ ] Add a Postgres `healthcheck` and gate `web` with `condition: service_healthy`; watch the startup timeline in `docker compose ps`.
- [ ] Add a one-shot `migrate` service and wire `web` to wait for `service_completed_successfully`.
- [ ] Share a named volume between a builder and a web service; have the builder write a file the web service serves.
- [ ] Put an `adminer` service behind a `debug` profile and confirm plain `up` skips it but `--profile debug up` starts it.

## 11. Cheat Sheet

> [!TIP]
> **Networking & deps.** All services join a default project network; reach each other by **service name** DNS (`db:5432`) — never IPs, never `ports:` for internal traffic. Segment with custom top-level `networks:` for least privilege (DB off the edge network). Ordering: `depends_on` = start only; add `healthcheck` + `condition: service_healthy` for readiness, `service_completed_successfully` for one-shot migrations. Still add app-side retries — deps restart anytime. Share files via a named volume mounted into two services (`:ro` on the consumer). Gate optional tools with `profiles:` + `--profile`. Isolation rule: a service only reaches services on a network it shares.

**References:** Docker Compose networking docs, Compose Specification (depends_on, healthcheck, profiles), Docker docs "Startup order"

---

*Docker Handbook — topic 19.*
