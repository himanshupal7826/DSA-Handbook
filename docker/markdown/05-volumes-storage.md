# 05 · Volumes & Persistent Storage

> **In one line:** Persist data outside the container's ephemeral layer.

---

## 1. Overview

Containers are ephemeral — the writable layer is lost on removal. **Volumes** (Docker-managed) and **bind mounts** (host paths) persist and share data. Volumes are the preferred way to store databases, uploads, and state.

## 2. Key Concepts

- Named volumes are managed by Docker (best for prod data).
- Bind mounts map a host path (great for dev live-reload).
- tmpfs mounts keep data in memory only.
- Volumes survive container removal until explicitly deleted.
- Mounts can be shared across containers.

## 3. Syntax & Code

```bash
docker volume create pgdata
docker run -d --name db -v pgdata:/var/lib/postgresql/data postgres:16
# bind mount for dev:
docker run -v $(pwd):/app node:20 npm run dev
```

## 4. Worked Example

**Backup a volume**

Tar a volume's contents via a helper container:

```bash
docker run --rm -v pgdata:/data -v $(pwd):/backup alpine \
  tar czf /backup/pgdata.tar.gz -C /data .
```

## 5. Best Practices

- ✅ Use named volumes for stateful services in production.
- ✅ Use bind mounts for local development.
- ✅ Back up volumes regularly.
- ✅ Avoid storing state in the container layer.
- ✅ Document volume mount points and lifecycles.

## 6. Common Pitfalls

1. ⚠️ Relying on the writable layer for important data (lost on rm).
2. ⚠️ Bind-mount path/permission mismatches across OSes.
3. ⚠️ Anonymous volumes accumulating unnoticed.
4. ⚠️ Sharing a volume between containers that both write (corruption).
5. ⚠️ Assuming docker rm deletes named volumes (it doesn't without -v).
6. ⚠️ Performance issues with bind mounts on macOS/Windows.

## 7. Interview Questions

1. **Q: Volume vs bind mount?**
   A: Volumes are Docker-managed (portable, prod data); bind mounts map a specific host path (dev).

2. **Q: What happens to the writable layer on rm?**
   A: It's deleted — unsaved data is lost; persist with volumes.

3. **Q: How to share data between containers?**
   A: Mount the same named volume in each.

4. **Q: tmpfs mount use case?**
   A: Sensitive or scratch data kept only in memory, never on disk.

5. **Q: Does docker rm delete volumes?**
   A: No — named volumes persist; use docker volume rm or docker rm -v for anonymous ones.

6. **Q: Why are bind mounts slower on macOS?**
   A: File events cross the VM boundary; use volumes or cached mounts.

7. **Q: How to back up a volume?**
   A: Run a throwaway container that tars the volume to a host bind mount.

8. **Q: Where should a database store data?**
   A: In a named volume, not the container layer.

## 8. Practice

- [ ] Run Postgres with a named volume and verify persistence.
- [ ] Bind-mount source for live reload in dev.
- [ ] Back up and restore a volume with tar.

## 9. Quick Revision

Container layer is ephemeral; persist with volumes (managed, prod) or bind mounts (host, dev). Volumes survive rm, can be shared/backed up; don't store state in the container layer.

**References:** Manage data in Docker

---

*Docker Handbook — topic 05.*
