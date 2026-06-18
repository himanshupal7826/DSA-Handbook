# 07 · Docker Compose

> **In one line:** Define and run multi-container apps with one YAML file.

---

## 1. Overview

**Docker Compose** declares a multi-service app (web, db, cache) in `compose.yaml` and manages it with `docker compose up`. It wires a shared network, named volumes, environment, and dependency order — ideal for local dev and simple deployments.

## 2. Key Concepts

- Each service maps to an image/build, ports, env, volumes.
- Compose creates a default network; services resolve by name.
- depends_on orders startup (not readiness — add healthchecks).
- Profiles/overrides vary config per environment.
- compose up/down/logs/ps manage the stack.

## 3. Syntax & Code

```yaml
services:
  web:
    build: .
    ports: ["8000:8000"]
    environment:
      DATABASE_URL: postgres://db:5432/app
    depends_on:
      db:
        condition: service_healthy
  db:
    image: postgres:16
    volumes: ["pgdata:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "postgres"]
volumes:
  pgdata:
```

## 4. Worked Example

**Bring it up**

Start, view, and tear down:

```bash
docker compose up -d
docker compose logs -f web
docker compose down        # add -v to also remove volumes
```

## 5. Best Practices

- ✅ Use healthchecks + depends_on condition for real readiness.
- ✅ Keep secrets in env files / secrets, not the YAML.
- ✅ Pin image versions.
- ✅ Use named volumes for stateful services.
- ✅ Separate dev/prod with overrides or profiles.

## 6. Common Pitfalls

1. ⚠️ Assuming depends_on waits for readiness (it waits for start).
2. ⚠️ Committing secrets in compose.yaml.
3. ⚠️ Port clashes across services.
4. ⚠️ Relying on Compose for large-scale prod orchestration (use Kubernetes).
5. ⚠️ Anonymous volumes losing data.
6. ⚠️ Editing running config without recreating services.

## 7. Interview Questions

1. **Q: What does Compose solve?**
   A: Declaring and running multi-container apps with networking, volumes, and env in one file.

2. **Q: Does depends_on guarantee readiness?**
   A: No — only start order; combine with healthchecks and condition: service_healthy.

3. **Q: How do services discover each other?**
   A: By service name over the Compose-created network's DNS.

4. **Q: Compose vs Kubernetes?**
   A: Compose is great for local/simple multi-container apps; Kubernetes handles scale, self-healing, and clusters.

5. **Q: How to persist DB data in Compose?**
   A: Mount a named volume to the data directory.

6. **Q: How to manage env per environment?**
   A: Override files (compose.override.yaml) or profiles + .env files.

7. **Q: How to view/follow logs?**
   A: docker compose logs -f <service>.

8. **Q: What does compose down -v do?**
   A: Stops/removes containers, networks, and named volumes.

## 8. Practice

- [ ] Write a compose.yaml for web+db with a healthcheck.
- [ ] Use depends_on condition for ordered startup.
- [ ] Add a Redis cache service on the same network.

## 9. Quick Revision

Compose declares multi-service apps in YAML (network/volumes/env). Use healthchecks for readiness, named volumes for state, secrets via env files; it's for dev/simple prod — Kubernetes for scale.

**References:** Compose docs

---

*Docker Handbook — topic 07.*
