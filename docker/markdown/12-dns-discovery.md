# 12 · Ports, DNS & Service Discovery

> **In one line:** Publish ports with `-p` to reach the host; wire multi-container apps together by name using Docker's embedded DNS — never by IP.

---

## 1. Overview

Two containers, one problem: how does the API find the database? The naive answer — look up the database's IP — breaks the moment a container restarts and gets a new address. The durable answer is **service discovery**: refer to peers by a stable *name* and let an infrastructure resolver translate that name to whatever IP is current. Docker builds this in as an **embedded DNS server** on every user-defined network.

Separately, there's the question of reaching a container **from outside** the host — your browser, a load balancer, a teammate on the LAN. That's **port publishing**: `-p host:container` installs a NAT rule so a port on the host forwards into the container. People routinely confuse this with `EXPOSE`, which merely documents a port and opens nothing.

Get these two ideas straight — **publishing** for north-south (host ⇄ world) traffic, **DNS by name** for east-west (container ⇄ container) traffic — and multi-container apps stop being fragile. This page nails both, and shows how Compose makes service names the primary key of your whole topology.

## 2. Core Concepts

- **Port publishing (`-p host:container`)** — maps a host port to a container port via a DNAT iptables rule; the only way to reach a container from outside the host.
- **`EXPOSE`** — Dockerfile/image metadata listing the ports the app listens on. Documentation and a target for `-P`; it publishes nothing by itself.
- **`-P` (publish-all)** — publishes every `EXPOSE`d port to a random high host port. Handy for tests, not for stable services.
- **Embedded DNS (`127.0.0.11`)** — per-container resolver on user-defined networks; resolves container names, `--network-alias`es, and Compose service names to live IPs.
- **Container name vs. service name** — with plain `docker run` you resolve by `--name`; with Compose you resolve by the service key in `docker-compose.yml`.
- **Network aliases** — extra DNS names for a container (`--network-alias`); multiple containers can share an alias for simple round-robin DNS.
- **DNS round-robin** — when a name maps to several container IPs (replicas), the resolver returns them in rotation for basic load spreading.
- **Bind address** — `-p 127.0.0.1:PORT:PORT` limits a published port to loopback; `-p PORT:PORT` binds `0.0.0.0` (all interfaces, incl. LAN).
- **Host-side resolution** — from the host you reach a container via its *published* port on `localhost`; you cannot resolve container names from the host.
- **External DNS fallthrough** — names the embedded resolver doesn't know are forwarded to the host's upstream DNS, so containers still reach the internet.

## 3. Syntax & Examples

Publishing variants:

```bash
docker run -p 8080:80        nginx     # host 0.0.0.0:8080 -> container:80
docker run -p 127.0.0.1:8080:80 nginx  # host-only, not on the LAN
docker run -p 8080:80/udp    myapp      # publish a UDP port
docker run -P                myapp      # publish all EXPOSE'd ports (random)
```

`EXPOSE` in a Dockerfile — metadata only:

```dockerfile
FROM node:20-alpine
EXPOSE 3000          # documents the port; does NOT publish it
CMD ["node","server.js"]
```

Discovery by name on a user-defined network:

```bash
docker network create appnet
docker run -d --name db --network appnet postgres:16
docker run -d --name api --network appnet appimg   # connects to "db:5432"
docker exec api getent hosts db      # -> db's current IP
```

Aliases and multi-name discovery:

```bash
docker run -d --network appnet --network-alias cache redis:7
docker run -d --network appnet --network-alias cache redis:7   # 2nd replica
docker exec api nslookup cache       # returns both IPs (round-robin)
```

## 4. Worked Example

A three-service app (web → api → db) discovered entirely by name, with only the web port published.

```yaml
# docker-compose.yml
services:
  db:
    image: postgres:16
    environment: { POSTGRES_PASSWORD: secret }
  api:
    image: myapi:latest
    environment:
      DATABASE_URL: postgres://postgres:secret@db:5432/postgres   # name: db
    depends_on: [db]
  web:
    image: mynginx:latest
    environment:
      API_URL: http://api:8000     # name: api
    ports:
      - "127.0.0.1:8080:80"        # ONLY the edge is published, host-only
```

```bash
docker compose up -d
docker compose exec web getent hosts api    # web resolves 'api' by service name
docker compose exec api getent hosts db     # api resolves 'db' by service name
curl -s localhost:8080/                       # reaches web via published port
```

Result:

```text
172.20.0.3      api
172.20.0.2      db
<html>… app home …</html>
```

Notice what's *not* here: no IP addresses anywhere in config, and only one published port (the edge). `db` and `api` are unreachable from outside the host — exactly the blast-radius you want. Compose auto-created a network named `<project>_default` and registered each service name in the embedded DNS.

## 5. Under the Hood

When a container on a user-defined network does a DNS lookup, its `/etc/resolv.conf` points at `127.0.0.11`. Docker intercepts that address, checks its internal service registry for the name (container names, `--network-alias`, Compose service names), and returns the **current** IP(s). Names it doesn't own are forwarded to the daemon's upstream resolvers, so `google.com` still works. Because the registry updates as containers start/stop, a recreated `db` with a new IP is resolved correctly on the next lookup.

```svg
<svg viewBox="0 0 720 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>

  <!-- external client -->
  <rect x="20" y="160" width="120" height="50" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="80" y="182" fill="#1e293b" text-anchor="middle">browser</text>
  <text x="80" y="199" fill="#64748b" text-anchor="middle">localhost:8080</text>

  <!-- host / publish boundary -->
  <rect x="170" y="20" width="530" height="340" rx="8" fill="none" stroke="#64748b" stroke-dasharray="5 4"/>
  <text x="240" y="40" fill="#64748b" text-anchor="middle">appnet (user-defined)</text>

  <!-- publish (DNAT) -->
  <rect x="180" y="160" width="90" height="50" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="225" y="182" fill="#1e293b" text-anchor="middle">-p 8080:80</text>
  <text x="225" y="199" fill="#64748b" text-anchor="middle">DNAT</text>
  <line x1="140" y1="185" x2="180" y2="185" stroke="#475569" marker-end="url(#a2)"/>

  <!-- web -->
  <rect x="300" y="60" width="120" height="56" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="360" y="84" fill="#1e293b" text-anchor="middle">web</text>
  <text x="360" y="102" fill="#64748b" text-anchor="middle">:80 (published)</text>
  <line x1="270" y1="180" x2="300" y2="112" stroke="#475569" marker-end="url(#a2)"/>

  <!-- api -->
  <rect x="300" y="160" width="120" height="56" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="360" y="184" fill="#1e293b" text-anchor="middle">api</text>
  <text x="360" y="202" fill="#64748b" text-anchor="middle">:8000</text>

  <!-- db -->
  <rect x="300" y="260" width="120" height="56" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="360" y="284" fill="#1e293b" text-anchor="middle">db</text>
  <text x="360" y="302" fill="#64748b" text-anchor="middle">:5432 (unpublished)</text>

  <!-- embedded DNS -->
  <rect x="500" y="150" width="170" height="76" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="585" y="174" fill="#1e293b" text-anchor="middle">embedded DNS</text>
  <text x="585" y="192" fill="#64748b" text-anchor="middle">127.0.0.11</text>
  <text x="585" y="210" fill="#64748b" text-anchor="middle">name → live IP</text>

  <!-- name lookups -->
  <line x1="420" y1="88"  x2="500" y2="165" stroke="#475569" stroke-dasharray="4 3" marker-end="url(#a2)"/>
  <text x="470" y="120" fill="#64748b" text-anchor="middle">"api"?</text>
  <line x1="420" y1="288" x2="500" y2="212" stroke="#475569" stroke-dasharray="4 3" marker-end="url(#a2)"/>
  <text x="470" y="262" fill="#64748b" text-anchor="middle">"db"?</text>

  <!-- app-to-app -->
  <line x1="360" y1="116" x2="360" y2="160" stroke="#475569" marker-end="url(#a2)"/>
  <text x="392" y="140" fill="#64748b" text-anchor="middle">api:8000</text>
  <line x1="360" y1="216" x2="360" y2="260" stroke="#475569" marker-end="url(#a2)"/>
  <text x="392" y="240" fill="#64748b" text-anchor="middle">db:5432</text>
</svg>
```

Port publishing lives at a different layer: the host's kernel installs a **DNAT** rule so a packet to `host:8080` is rewritten to `web:80`. DNS never enters into it — publishing is pure L3/L4 forwarding, discovery is name→IP resolution. They compose cleanly: the edge is published, everything internal is name-resolved.

## 6. Variations & Trade-offs

| Mechanism | Reaches | Requires | Stable across restart |
|---|---|---|---|
| `-p host:container` | host & LAN → container | user action / Compose `ports:` | yes (port is fixed) |
| `EXPOSE` | nothing (metadata) | Dockerfile | n/a |
| `-P` | host → all EXPOSE ports | `EXPOSE` present | no (random ports) |
| DNS by container name | container → container | user-defined network + `--name` | yes |
| DNS by Compose service | service → service | Compose network | yes |
| `--network-alias` | container → alias (multi) | user-defined network | yes (round-robin) |
| container IP | anything → IP | none | ❌ changes on recreate |

The main decision is **what to publish**. Publish only your edge (reverse proxy / gateway); keep databases, caches, and internal APIs unpublished and reachable by name. For internal wiring, always prefer **names over IPs** — the whole point of the embedded DNS is to absorb IP churn. Use `--network-alias` when you want several containers behind one logical name for cheap DNS round-robin, but know it's not health-aware — for real load balancing use a proxy or Swarm/K8s services with a VIP.

## 7. Production / Performance Notes

- **Publish the minimum.** One edge port (often `443` behind a reverse proxy). Everything else stays internal and named. This shrinks your attack surface dramatically.
- **Bind internal-only ports to `127.0.0.1`.** `-p 127.0.0.1:5432:5432` for a DB you must reach from the host during debugging, without exposing it to the LAN.
- **DNS round-robin is not load balancing.** It has no health checks and clients may cache the first answer. For resilient balancing use Swarm services (VIP + IPVS), a proxy (nginx/Traefik/HAProxy), or Kubernetes Services.
- **Don't cache resolved IPs in the app.** Resolve the name per connection (or with a short TTL); a long-lived cached IP breaks when the peer is recreated.
- **`depends_on` orders startup, not readiness.** The DB name resolves before Postgres is accepting connections. Add a healthcheck + `condition: service_healthy`, or retry with backoff in the client.
- **Compose networks are per-project namespaced** (`<project>_default`). Two projects can both have a `db` service without colliding, because each has its own network and DNS scope.
- **UDP publishing needs `/udp`.** `-p 53:53/udp` — forgetting the suffix publishes TCP only.

## 8. Common Mistakes

1. ⚠️ **Thinking `EXPOSE` opens a port.** It's documentation only. Fix: use `-p` / Compose `ports:` to actually publish.
2. ⚠️ **Connecting services by IP address.** Breaks on the next recreate. Fix: connect by container/service name.
3. ⚠️ **Expecting name resolution on the default bridge.** No embedded DNS there. Fix: use a user-defined / Compose network.
4. ⚠️ **Publishing internal databases to `0.0.0.0`.** Exposes them to the LAN. Fix: don't publish, or bind to `127.0.0.1`.
5. ⚠️ **Relying on `depends_on` for readiness.** The container is up before the app is ready. Fix: healthchecks + `service_healthy`, or client-side retry.
6. ⚠️ **Trying to resolve container names from the host.** The host isn't on the embedded DNS. Fix: reach containers via their published port on `localhost`.
7. ⚠️ **Assuming `--network-alias` load-balances with health awareness.** It's dumb round-robin DNS. Fix: use a real proxy or orchestrator VIP.

## 9. Interview Questions

**Q: What's the difference between `EXPOSE` and `-p`?**
A: `EXPOSE` is image metadata that documents which ports the app listens on; it opens nothing. `-p host:container` actually publishes a port by installing a DNAT rule so external traffic to the host port reaches the container. `EXPOSE` can be a target for `-P` (publish-all to random ports), but by itself it has no runtime effect.

**Q: How do two containers find each other without hardcoding IPs?**
A: On a user-defined (or Compose) network, each container queries the embedded DNS at `127.0.0.11`, which resolves container names, network aliases, and Compose service names to their current IPs. Because the registry updates as containers start and stop, name-based connections survive restarts and reschedules.

**Q: Why doesn't name resolution work on the default bridge?**
A: The embedded DNS resolver is only attached to user-defined networks. On the default `bridge`, containers can reach each other by IP but there's no name service, so you must create a user-defined network (or use Compose, which does it for you).

**Q: What does `-p 127.0.0.1:8080:80` do differently from `-p 8080:80`?**
A: The first binds the published port to the loopback interface only, so it's reachable from the host but not from the LAN. The second binds to `0.0.0.0`, publishing on all host interfaces including the LAN — a common accidental exposure for internal services.

**Q: In Compose, what name do you use to connect the api to the db?**
A: The service key in the compose file. If the service is `db:`, the api connects to host `db` on its port (e.g., `db:5432`). Compose registers each service name in the project network's DNS, so no IPs or links are needed.

**Q: How does port publishing actually route traffic into a container?**
A: The daemon installs iptables NAT rules. Inbound packets to `host:PUBLISHED` hit a DNAT rule in `PREROUTING` that rewrites the destination to the container's IP:port; the reply path is un-NAT'd on the way out. It's pure L3/L4 forwarding, independent of DNS.

**Q: (Senior) Your service resolves the DB name at startup and caches the IP. What breaks and why?**
A: When the DB container is recreated it gets a new IP, but the app keeps dialing the stale cached address and fails to connect. The embedded DNS returns the correct new IP, so the fix is to resolve per connection (or honor a short TTL) rather than caching an IP for the process lifetime.

**Q: (Senior) How would you load-balance across three replicas of a service, and why isn't `--network-alias` enough?**
A: `--network-alias` gives DNS round-robin — no health checks, and clients often cache the first record, so a dead replica still gets traffic. Real balancing needs a health-aware VIP: a reverse proxy (nginx/Traefik/HAProxy), a Swarm service (VIP backed by IPVS), or a Kubernetes Service with kube-proxy/endpoints.

**Q: (Senior) Why is `depends_on` insufficient for a web app that needs its database, and what's the correct pattern?**
A: `depends_on` only controls container start order, not application readiness — the DB name resolves and the container is "up" before Postgres accepts connections. Correct pattern: add a `healthcheck` to the DB and use `depends_on: { db: { condition: service_healthy } }`, and/or make the client retry with backoff.

**Q: (Senior) How can a container reach the public internet if the embedded DNS only knows local names?**
A: The embedded resolver answers names it owns and forwards everything else to the daemon's upstream DNS servers (from the host's `/etc/resolv.conf` or configured `--dns`). So local names resolve internally while external names fall through to real DNS, and egress is then NAT-masqueraded to the internet.

## 10. Practice

- [ ] Build an image with `EXPOSE 3000`, run it without `-p`, and confirm the port is NOT reachable from the host; then add `-p` and confirm it is.
- [ ] Stand up a Compose app where `web` talks to `api` talks to `db`, publishing only `web`, and verify with `getent hosts` that each service resolves the next by name.
- [ ] Recreate the `db` container so it gets a new IP, and confirm the `api` still resolves `db` correctly by name.
- [ ] Register two containers under the same `--network-alias` and use repeated `nslookup` to observe DNS round-robin.
- [ ] Publish one service on `127.0.0.1:PORT` and another on `0.0.0.0:PORT`, then from a second LAN machine confirm which is reachable.

## 11. Cheat Sheet

> [!TIP]
> **North-south vs east-west.** Reaching a container from outside = **publish**: `-p host:container` (DNAT). `EXPOSE` only documents; `-P` publishes all to random ports. Reaching a container from another container = **DNS by name**: embedded resolver at `127.0.0.11` on user-defined/Compose networks maps container names, `--network-alias`, and service names → live IPs (survives restarts). Publish ONLY the edge; keep DBs/internal APIs unpublished. Bind host-only ports to `127.0.0.1`. Never hardcode IPs. `depends_on` = start order, not readiness → use healthchecks. Round-robin DNS ≠ load balancing.

**References:** Docker "Container networking" & "Networking in Compose" docs, Docker `EXPOSE`/`--publish` reference, Compose file `ports`/`depends_on`/`healthcheck` spec, Docker embedded DNS documentation

---
*Docker Handbook — topic 12.*
