# 13 · Volumes, Bind Mounts & tmpfs

> **In one line:** Containers are ephemeral — persist and share state by choosing the right mount: named volumes (Docker-managed), bind mounts (host path), or tmpfs (RAM-only).

---

## 1. Overview

A container's writable layer dies with the container. Delete the container and every file it wrote — the database, the uploads, the logs — is gone. That's by design: images are immutable, containers are cattle. The moment you need data to **outlive** a container, be **shared** between containers, or be **injected** from the host, you need a mount.

Docker offers three mount types and they are not interchangeable. **Named volumes** are Docker-managed storage that lives under the daemon's control — the right default for databases and any state you want the platform to own. **Bind mounts** map a specific host directory into the container — perfect for live-reloading source code in development, dangerous as a production data store. **tmpfs** mounts live in RAM and never touch disk — ideal for secrets and scratch space you want to vanish.

Choosing wrong is a classic incident: a bind mount whose host path doesn't exist, a volume owned by `root` that your non-root app can't write to, or a tmpfs that silently drops data on restart. This page maps the three types onto where the bytes actually live, then walks the permissions, sharing, and backup patterns that separate a working setup from a 2 a.m. page.

## 2. Core Concepts

- **Writable container layer** — the ephemeral copy-on-write layer on top of the image; fast to write, destroyed with the container. Not for persistence.
- **Named volume** — storage Docker creates and manages (default under `/var/lib/docker/volumes/<name>/_data`); referenced by name, decoupled from any host path.
- **Anonymous volume** — a volume with a generated name (from `VOLUME` in a Dockerfile or `-v /path`); persists but is hard to track — usually a smell.
- **Bind mount** — mounts an exact host directory/file into the container; you control the location, contents reflect the host live, both directions.
- **tmpfs mount** — an in-memory filesystem inside the container; never written to disk, gone on stop. Great for secrets/scratch.
- **`--mount` vs `-v`** — `--mount` is explicit key/value syntax (preferred, clearer, errors if a bind source is missing); `-v` is terse legacy shorthand (auto-creates missing paths).
- **Volume driver** — pluggable backend (`local` default, or `nfs`, cloud/CSI plugins) that decides where and how volume data is stored, enabling network/shared storage.
- **Read-only mounts (`:ro`)** — mount config/code read-only so a container can't modify it; a cheap hardening win.
- **Ownership & UID/GID** — mounts carry host/volume ownership; a container process running as a specific UID may lack write permission — a top source of "permission denied".
- **Volume lifecycle** — volumes are not removed with `docker rm` unless you pass `-v`; dangling volumes accumulate and must be pruned.

## 3. Syntax & Examples

Named volume (managed by Docker) — the `--mount` form and the `-v` shorthand:

```bash
docker volume create pgdata
docker run -d --mount source=pgdata,target=/var/lib/postgresql/data postgres:16
docker run -d -v pgdata:/var/lib/postgresql/data postgres:16     # same thing
```

Bind mount (host path → container) — dev source, read-only config:

```bash
docker run -d --mount type=bind,source="$PWD"/src,target=/app/src node:20
docker run -d -v "$PWD"/nginx.conf:/etc/nginx/nginx.conf:ro nginx  # read-only
```

tmpfs (RAM only, nothing on disk):

```bash
docker run -d --mount type=tmpfs,target=/scratch,tmpfs-size=64m myapp
docker run -d --tmpfs /run:size=16m,mode=1777 myapp
```

Declare a volume in an image, and manage volumes on the host:

```dockerfile
FROM postgres:16
VOLUME /var/lib/postgresql/data   # anonymous volume if user gives no name
```

```bash
docker volume ls
docker volume inspect pgdata      # shows Mountpoint on the host
docker volume prune               # remove dangling (unreferenced) volumes
```

Compose form:

```yaml
services:
  db:
    image: postgres:16
    volumes:
      - pgdata:/var/lib/postgresql/data       # named volume
      - ./init.sql:/docker-entrypoint-initdb.d/init.sql:ro   # bind, read-only
    tmpfs:
      - /tmp
volumes:
  pgdata:
```

## 4. Worked Example

Persist a Postgres database across container recreation, then back it up — proving the data survives.

```bash
docker volume create pgdata
docker run -d --name db -e POSTGRES_PASSWORD=x \
  --mount source=pgdata,target=/var/lib/postgresql/data postgres:16

# write some data
docker exec db psql -U postgres -c "CREATE TABLE t(x int); INSERT INTO t VALUES (42);"

# destroy the container entirely (NOT -v, so the volume stays)
docker rm -f db

# new container, same volume -> data is still there
docker run -d --name db -e POSTGRES_PASSWORD=x \
  --mount source=pgdata,target=/var/lib/postgresql/data postgres:16
docker exec db psql -U postgres -tc "SELECT x FROM t;"

# back up the volume to a tarball via a throwaway helper container
docker run --rm -v pgdata:/data -v "$PWD":/backup alpine \
  tar czf /backup/pgdata-backup.tgz -C /data .
ls -lh pgdata-backup.tgz
```

Result:

```text
 42                       # data survived deleting and recreating the container
-rw-r--r--  1 user  1.2M  pgdata-backup.tgz   # portable backup of the volume
```

The container was destroyed and recreated, yet the row persisted — because the state lived in the **named volume**, not the container's writable layer. The backup pattern (mount the volume into a helper container and `tar` it) is the canonical, driver-agnostic way to snapshot volume data.

## 5. Under the Hood

The three mount types differ in **where the bytes physically live** and who manages that location. A named volume's data sits in `/var/lib/docker/volumes/<name>/_data` on the host, managed by Docker's `local` driver (or elsewhere via a plugin). A bind mount points at an arbitrary host path you choose — Docker just bind-mounts it into the container's mount namespace, so host and container see the exact same inode live. A tmpfs mount is backed by host RAM (`tmpfs`), never persisted, and is wiped when the container stops.

```svg
<svg viewBox="0 0 720 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a3" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>

  <!-- container -->
  <rect x="240" y="20" width="240" height="120" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="360" y="42" fill="#1e293b" text-anchor="middle">container</text>
  <text x="300" y="70" fill="#64748b" text-anchor="middle">/data</text>
  <text x="300" y="92" fill="#64748b" text-anchor="middle">/app/src</text>
  <text x="300" y="114" fill="#64748b" text-anchor="middle">/scratch</text>
  <text x="440" y="70" fill="#64748b" text-anchor="middle">(volume)</text>
  <text x="440" y="92" fill="#64748b" text-anchor="middle">(bind)</text>
  <text x="440" y="114" fill="#64748b" text-anchor="middle">(tmpfs)</text>

  <!-- named volume -->
  <rect x="40" y="220" width="200" height="80" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="140" y="246" fill="#1e293b" text-anchor="middle">named volume</text>
  <text x="140" y="266" fill="#64748b" text-anchor="middle">/var/lib/docker/</text>
  <text x="140" y="283" fill="#64748b" text-anchor="middle">volumes/…/_data</text>
  <line x1="290" y1="70" x2="150" y2="220" stroke="#475569" marker-end="url(#a3)"/>

  <!-- bind mount -->
  <rect x="260" y="220" width="200" height="80" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="360" y="246" fill="#1e293b" text-anchor="middle">bind mount</text>
  <text x="360" y="266" fill="#64748b" text-anchor="middle">any host path</text>
  <text x="360" y="283" fill="#64748b" text-anchor="middle">e.g. $PWD/src</text>
  <line x1="330" y1="92" x2="360" y2="220" stroke="#475569" marker-end="url(#a3)"/>

  <!-- tmpfs -->
  <rect x="480" y="220" width="200" height="80" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="580" y="246" fill="#1e293b" text-anchor="middle">tmpfs (host RAM)</text>
  <text x="580" y="266" fill="#64748b" text-anchor="middle">never on disk</text>
  <text x="580" y="283" fill="#64748b" text-anchor="middle">gone on stop</text>
  <line x1="400" y1="114" x2="560" y2="220" stroke="#475569" marker-end="url(#a3)"/>

  <!-- host label -->
  <rect x="20" y="330" width="480" height="50" rx="8" fill="none" stroke="#64748b" stroke-dasharray="5 4"/>
  <text x="260" y="360" fill="#64748b" text-anchor="middle">host disk (persists across container delete)</text>
  <rect x="520" y="330" width="160" height="50" rx="8" fill="none" stroke="#d97706" stroke-dasharray="5 4"/>
  <text x="600" y="360" fill="#d97706" text-anchor="middle">RAM (volatile)</text>
</svg>
```

A key consequence: **named volumes and bind mounts persist when you `docker rm` the container** (data is on the host), while the writable layer and tmpfs do not. Volume drivers generalize this further — an `nfs` or cloud CSI driver puts the `_data` on network storage, so the same volume can attach on a different host, which is the foundation for stateful workloads in clusters.

## 6. Variations & Trade-offs

| | Named volume | Bind mount | tmpfs |
|---|---|---|---|
| Location | Docker-managed dir | any host path you pick | host RAM |
| Persists after `rm` | ✅ | ✅ | ❌ |
| Portable across hosts | ✅ (with driver) | ❌ (host-specific path) | n/a |
| Managed by Docker | ✅ | ❌ | ✅ |
| Best for | databases, app state | dev source, config injection | secrets, scratch, caches |
| Perf on Docker Desktop | native (fast) | slower (VM sync) | fast (RAM) |
| Risk | dangling volumes | host coupling, perms, overwrite | data loss, RAM pressure |

**Named volumes** are the default for state you want the platform to own: portable, backup-friendly, no host-path coupling, and fast even on Docker Desktop (where bind mounts cross a VM boundary and can be slow). **Bind mounts** shine in development — edit a file on the host, the container sees it instantly — but they hard-couple you to a host layout and are the usual cause of permission and "file not found" grief. **tmpfs** is for data that should never hit disk; it costs RAM and vanishes on stop, which is the whole point for secrets.

## 7. Production / Performance Notes

- **Use named volumes for databases.** Never a bind mount into `/var/lib/docker` or a laptop path for prod data — you lose portability and invite permission chaos.
- **Bind mount config read-only.** `:ro` on `nginx.conf`, TLS certs, and seed SQL prevents the container from mutating your source of truth.
- **Fix ownership deliberately.** If your app runs as UID 1000, ensure the volume's data is owned by 1000 (init container `chown`, an entrypoint step, or `--user`). Bind mounts inherit host ownership; named volumes inherit the image's dir ownership on first populate.
- **Back up by tar-ing the volume from a helper container** (shown above), or use `docker volume` with a driver that snapshots. Test the *restore*, not just the backup.
- **Prune dangling volumes.** `docker rm` keeps volumes unless you pass `-v`; over time `docker volume prune` reclaims real disk. Watch `/var/lib/docker` growth.
- **Docker Desktop bind mounts are slow** for large trees (node_modules, vendored deps) because writes sync across a VM. Put dependency dirs in named volumes and bind only source.
- **tmpfs sizes count against host RAM.** Cap them (`tmpfs-size`) so a runaway writer can't OOM the host.
- **SELinux hosts** need `:z`/`:Z` on bind mounts to relabel, or the container gets `permission denied` despite correct UNIX perms.

## 8. Common Mistakes

1. ⚠️ **Storing state in the container's writable layer.** It dies with the container. Fix: mount a named volume for anything that must persist.
2. ⚠️ **`docker rm` without `-v`, then wondering about leaked disk** — or `-v` when you needed the data. Fix: know that volumes outlive `rm` unless `-v`; prune deliberately.
3. ⚠️ **Permission denied on a mounted dir.** The container UID can't write the volume/host path. Fix: `chown` to the app UID, use `--user`, or set ownership in the entrypoint.
4. ⚠️ **Bind-mounting over a directory that had image content** (e.g. `/app` with `node_modules`), hiding it. Fix: bind only source, keep deps in a named volume or rebuild.
5. ⚠️ **`-v` auto-creating a host path as an empty dir** when you meant to bind an existing file. Fix: use `--mount type=bind` which errors if the source is missing.
6. ⚠️ **Putting secrets in a persistent volume.** They linger on disk. Fix: use tmpfs (or a real secrets manager) so they never persist.
7. ⚠️ **Assuming a bind mount is portable.** The host path won't exist on another machine/CI. Fix: use named volumes for anything that must move.
8. ⚠️ **No backup / untested restore.** A volume is not a backup. Fix: snapshot to a tarball or driver snapshot, and rehearse restore.

## 9. Interview Questions

**Q: What are the three mount types and when do you use each?**
A: Named volumes (Docker-managed storage, default for persistent state like databases), bind mounts (a specific host path mapped in, ideal for dev source and config injection), and tmpfs (in-memory, for secrets/scratch that must never touch disk). Volumes and bind mounts persist after the container is removed; tmpfs and the writable layer do not.

**Q: Where does a named volume's data physically live?**
A: By default under `/var/lib/docker/volumes/<name>/_data` on the host, managed by the `local` volume driver. A different driver (nfs, cloud/CSI) can place it on network storage instead, which is what makes volumes portable across hosts.

**Q: What's the difference between a named volume and a bind mount?**
A: A named volume is Docker-managed and referenced by name with no host-path coupling, so it's portable and backup-friendly. A bind mount points at an exact host directory you choose — great for live-editing source, but tied to that host's layout and prone to permission and overwrite issues.

**Q: Why does data survive `docker rm` but not a lost container's writable layer?**
A: Named volumes and bind mounts store bytes on the host outside the container, so removing the container leaves them intact (unless you pass `-v` to also remove anonymous volumes). The writable copy-on-write layer is part of the container and is destroyed with it.

**Q: How do you back up a named volume?**
A: Run a throwaway container with the volume and a backup dir both mounted, then `tar` the volume into the backup dir: `docker run --rm -v vol:/data -v $PWD:/backup alpine tar czf /backup/vol.tgz -C /data .`. Restore by extracting back into a fresh volume. Always test the restore.

**Q: Why does `--mount` get preferred over `-v`?**
A: `--mount` uses explicit `key=value` syntax that's self-documenting and, for binds, errors if the source path doesn't exist. `-v` is terse legacy shorthand that silently auto-creates a missing bind source as an empty directory, which hides typos and misconfiguration.

**Q: (Senior) A non-root container gets "permission denied" writing to a mounted volume. Diagnose and fix.**
A: The volume/host directory is owned by a UID the container process doesn't match. For a fresh named volume, Docker copies the image path's ownership on first populate; a bind mount inherits host ownership. Fix by aligning UIDs — `chown -R appuid:appgid` the data (init step/entrypoint), run with `--user`, or on SELinux hosts add `:z`/`:Z` to relabel.

**Q: (Senior) On Docker Desktop, mounting a large source tree with node_modules is painfully slow. Why and what do you do?**
A: Bind mounts on Desktop cross a Linux VM boundary, so filesystem events and writes for many small files (node_modules) are expensive to sync. Keep dependency directories in a **named volume** (native speed inside the VM) and bind-mount only the source you actively edit, or use cached/delegated consistency options.

**Q: (Senior) How do you share a volume across hosts for a stateful service, and what changes?**
A: Use a volume driver backed by network storage — NFS, or a cloud/CSI plugin — so the volume's data lives off any single host and can attach wherever the container is scheduled. You then inherit that backend's consistency, latency, and locking semantics, and must ensure only one writer (or a filesystem that supports concurrent access) to avoid corruption.

**Q: (Senior) Why would you deliberately choose tmpfs, and what's the cost?**
A: To keep sensitive data (decrypted secrets, session keys) or hot scratch off disk entirely — it lives in RAM, never persists, and is wiped on stop, shrinking the on-disk attack surface. The cost is volatility (no persistence) and RAM consumption, so you cap it with `tmpfs-size` to avoid OOMing the host.

## 10. Practice

- [ ] Persist a Postgres database in a named volume, write a row, `docker rm -f` the container, recreate it on the same volume, and confirm the row survives.
- [ ] Bind-mount a config file read-only (`:ro`) and prove the container cannot modify it.
- [ ] Reproduce a "permission denied" by running a non-root container against a volume owned by root, then fix it with `--user` or an entrypoint `chown`.
- [ ] Back up a volume to a tarball with a helper container, delete the volume, and restore it into a fresh volume.
- [ ] Mount a tmpfs, write a file, restart the container, and confirm the file is gone.

## 11. Cheat Sheet

> [!TIP]
> **Pick your mount.** Container writable layer = ephemeral, dies with the container. **Named volume** (`-v name:/path`) = Docker-managed at `/var/lib/docker/volumes/…`, persists past `rm`, portable via drivers → databases/state. **Bind mount** (`--mount type=bind,source=…`) = exact host path, live two-way, host-coupled → dev source & read-only config (`:ro`). **tmpfs** = RAM only, never on disk, gone on stop → secrets/scratch. Prefer `--mount` (errors on missing source) over `-v` (auto-creates). Volumes survive `docker rm` unless `-v`; `docker volume prune` reclaims dangling. Back up = tar the volume from a helper container; test the restore. Watch UID/GID ownership and (SELinux) `:z`/`:Z`.

**References:** Docker Storage overview & "Manage data in Docker" docs, "Volumes" / "Bind mounts" / "tmpfs mounts" guides (docs.docker.com/storage), `docker volume` CLI reference, Compose volumes specification

---
*Docker Handbook — topic 13.*
