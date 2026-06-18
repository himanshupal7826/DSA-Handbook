# 06 · Container Networking

> **In one line:** Bridge, host, and user-defined networks; DNS by name.

---

## 1. Overview

Docker gives each container a network namespace. The default **bridge** network isolates containers; **user-defined bridge** networks add automatic **DNS by container name**. Publish ports (`-p`) to expose services to the host.

## 2. Key Concepts

- Default bridge: containers reach each other only by IP.
- User-defined bridge: built-in DNS — reach peers by name.
- -p host:container publishes a port to the host.
- host network shares the host's stack (Linux, no isolation).
- none disables networking.

## 3. Syntax & Code

```bash
docker network create appnet
docker run -d --name db --network appnet postgres:16
docker run -d --name api --network appnet -p 8000:8000 myapi
# api connects to 'db:5432' by name
```

## 4. Worked Example

**Publish vs expose**

-p maps to the host; EXPOSE only documents the port:

```bash
docker run -p 8080:80 nginx   # host:8080 -> container:80
```

## 5. Best Practices

- ✅ Use user-defined networks for service-to-service DNS.
- ✅ Publish only the ports you need.
- ✅ Reference services by name, not hardcoded IPs.
- ✅ Segment networks to limit blast radius.
- ✅ Bind sensitive ports to 127.0.0.1 when host-only.

## 6. Common Pitfalls

1. ⚠️ Relying on container IPs (they change on restart).
2. ⚠️ Expecting name DNS on the default bridge (only user-defined).
3. ⚠️ Publishing everything to 0.0.0.0 unintentionally.
4. ⚠️ Port conflicts on the host.
5. ⚠️ host networking breaking port isolation.
6. ⚠️ Forgetting both containers must share the network.

## 7. Interview Questions

1. **Q: Default bridge vs user-defined bridge?**
   A: User-defined networks provide automatic DNS resolution by container name; the default bridge does not.

2. **Q: What does -p do?**
   A: Publishes a container port to a host port (host:container).

3. **Q: EXPOSE vs publish?**
   A: EXPOSE documents the intended port; -p actually maps it to the host.

4. **Q: How do containers talk to each other?**
   A: On a shared user-defined network, by container/service name via embedded DNS.

5. **Q: Why avoid hardcoding container IPs?**
   A: They change across restarts; use DNS names.

6. **Q: What is host networking?**
   A: The container shares the host's network stack — no isolation, no port mapping (Linux).

7. **Q: How to restrict exposure to localhost?**
   A: Publish as 127.0.0.1:port:port.

8. **Q: How to isolate tiers?**
   A: Put them on separate user-defined networks and connect only where needed.

## 8. Practice

- [ ] Create a network and connect API+DB, resolving by name.
- [ ] Publish a web port and curl it from the host.
- [ ] Bind a port to localhost only.

## 9. Quick Revision

User-defined bridge networks give name-based DNS; default bridge needs IPs. Publish ports with -p, reference services by name, segment networks, expose only what's needed.

**References:** Networking overview

---

*Docker Handbook — topic 06.*
