# 11 · Container Networking: bridge, host, overlay

> **In one line:** Every container gets its own network namespace; the driver you pick — bridge, host, none, overlay, macvlan — decides how it reaches the host, its peers, and the world.

---

## 1. Overview

A container is just a process wearing a set of Linux namespaces. The **network namespace** gives it a private view of interfaces, routes, and firewall rules. On its own that namespace is an island — no way in, no way out. Docker's **network drivers** are what wire that island to something useful: a virtual switch on the host, the host's own stack, or an encrypted mesh spanning a cluster.

The problem networking solves is **reachability with isolation**. You want your API to talk to your database, but you don't want a compromised sidecar reaching your payments service, and you don't want to hardcode IPs that change on every `docker run`. Docker's answer is a set of drivers plus an **embedded DNS server** that resolves container names on user-defined networks.

You reach for different drivers at different moments. **bridge** (the default) is the day-one workhorse for a single host. **host** trades isolation for raw throughput. **overlay** is how containers on *different* hosts talk in Swarm. **macvlan** hands a container a real MAC on your physical LAN. **none** is total lockdown. Knowing which knob to turn — and the veth/NAT plumbing underneath — is the difference between "it works on my laptop" and a production topology you can reason about.

## 2. Core Concepts

- **Network namespace** — each container gets its own interfaces, routing table, and iptables rules, isolated from the host and other containers.
- **veth pair** — a virtual Ethernet cable: one end (`eth0`) lives inside the container, the other end attaches to a bridge on the host. Packets in one end come out the other.
- **docker0 / default bridge** — the built-in Linux bridge. Containers get `172.17.0.0/16` IPs and reach each other by IP only — **no name DNS**.
- **User-defined bridge** — a bridge you create (`docker network create`). Same isolation, but adds **automatic DNS by container name** and better isolation from unrelated containers.
- **NAT & port publishing** — outbound traffic is masqueraded (SNAT) via the host IP; inbound needs `-p host:container` which installs a DNAT rule so the host port forwards into the container.
- **host driver** — the container shares the host's network namespace directly: no veth, no NAT, `localhost` is the host. Fastest, zero isolation, Linux-only.
- **none driver** — only a loopback interface. The container is network-dead — good for batch jobs that must not touch the network.
- **overlay driver** — a VXLAN tunnel across a cluster (Swarm/K8s-style). Containers on different hosts share one virtual L2 network; supports optional IPsec encryption.
- **macvlan / ipvlan** — the container gets its own MAC/IP directly on the physical LAN, appearing as a peer of the host rather than behind it. Used for legacy apps that expect to *be* a real host.
- **Embedded DNS (127.0.0.11)** — Docker runs a resolver inside each container on user-defined networks, mapping names → current container IPs so restarts don't break connections.

## 3. Syntax & Examples

Inspect what you already have:

```bash
docker network ls                 # bridge, host, none are built-in
docker network inspect bridge     # subnet, gateway, connected containers
```

Default bridge — reachable by IP only:

```bash
docker run -d --name db  redis:7
docker run -it --rm alpine ping db        # FAILS: no DNS on default bridge
docker run -it --rm alpine ping 172.17.0.2  # works if that's db's IP
```

User-defined bridge — the way you should actually work:

```bash
docker network create appnet
docker run -d --name db   --network appnet redis:7
docker run -it --rm --network appnet alpine ping db   # resolves by name
```

Publish a port to the host, and pin it to loopback for host-only access:

```bash
docker run -d -p 8080:80        nginx     # 0.0.0.0:8080 -> container:80
docker run -d -p 127.0.0.1:5432:5432 postgres:16   # host-only, not on LAN
```

Other drivers:

```bash
docker run -d --network host   nginx         # shares host stack (Linux)
docker run -d --network none   batch-job      # no network at all
docker network create -d overlay --attachable mesh   # multi-host (Swarm)
docker network create -d macvlan \
  --subnet 192.168.1.0/24 --gateway 192.168.1.1 \
  -o parent=eth0 pub_lan                        # real LAN presence
```

Connect a running container to a second network (multi-homing):

```bash
docker network connect frontend api      # api now on appnet + frontend
docker network disconnect frontend api
```

## 4. Worked Example

Wire a two-tier app on a user-defined bridge and prove DNS and NAT both work.

```bash
docker network create shopnet
docker run -d --name db --network shopnet -e POSTGRES_PASSWORD=x postgres:16
docker run -d --name api --network shopnet -p 8000:8000 \
  -e DATABASE_URL=postgres://postgres:x@db:5432/postgres myapi:latest

# 1) container-to-container DNS
docker exec api getent hosts db
# 2) outbound NAT to the internet
docker exec api sh -c "apk add --no-cache curl >/dev/null; curl -s https://api.ipify.org"
# 3) inbound publish reaches the api
curl -s localhost:8000/health
```

Result:

```text
172.18.0.2      db                 # embedded DNS resolved 'db' to its IP
203.0.113.45                       # egress SNAT'd to the host's public IP
{"status":"ok"}                    # DNAT: host:8000 forwarded into api:8000
```

Three mechanisms in one shot: the embedded resolver turned `db` into `172.18.0.2`, the container's egress was masqueraded behind the host's public IP, and the published port DNAT'd an inbound request into the container.

## 5. Under the Hood

A user-defined bridge is a Linux bridge (`br-xxxx`) acting as a virtual switch. Each container is attached by a **veth pair**: `eth0` inside the netns, its peer plugged into the bridge. Outbound packets leave the bridge, hit the host's routing table, and are **SNAT-masqueraded** to the host IP by an iptables `POSTROUTING` rule. Inbound published ports are handled by a `DNAT` rule in `PREROUTING` that rewrites `host:8080` → `container:80`.

```svg
<svg viewBox="0 0 720 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="arr" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>

  <!-- host boundary -->
  <rect x="10" y="10" width="700" height="330" rx="8" fill="none" stroke="#64748b" stroke-dasharray="5 4"/>
  <text x="80" y="30" fill="#64748b" text-anchor="middle">Docker host</text>

  <!-- bridge -->
  <rect x="250" y="150" width="220" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="360" y="170" fill="#1e293b" text-anchor="middle">br-shopnet (virtual switch)</text>
  <text x="360" y="187" fill="#64748b" text-anchor="middle">172.18.0.1  gateway</text>

  <!-- container A -->
  <rect x="60" y="60" width="160" height="70" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="140" y="86" fill="#1e293b" text-anchor="middle">container: api</text>
  <text x="140" y="104" fill="#64748b" text-anchor="middle">eth0  172.18.0.2</text>
  <text x="140" y="120" fill="#64748b" text-anchor="middle">netns (isolated)</text>

  <!-- container B -->
  <rect x="500" y="60" width="160" height="70" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="580" y="86" fill="#1e293b" text-anchor="middle">container: db</text>
  <text x="580" y="104" fill="#64748b" text-anchor="middle">eth0  172.18.0.3</text>
  <text x="580" y="120" fill="#64748b" text-anchor="middle">netns (isolated)</text>

  <!-- veth pairs -->
  <line x1="140" y1="130" x2="300" y2="150" stroke="#475569" marker-end="url(#arr)"/>
  <text x="205" y="132" fill="#64748b" text-anchor="middle">veth pair</text>
  <line x1="580" y1="130" x2="420" y2="150" stroke="#475569" marker-end="url(#arr)"/>
  <text x="515" y="132" fill="#64748b" text-anchor="middle">veth pair</text>

  <!-- NAT / iptables -->
  <rect x="250" y="240" width="220" height="46" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="360" y="260" fill="#1e293b" text-anchor="middle">iptables: SNAT out / DNAT -p</text>
  <text x="360" y="277" fill="#64748b" text-anchor="middle">masquerade + port publish</text>
  <line x1="360" y1="196" x2="360" y2="240" stroke="#475569" marker-end="url(#arr)"/>

  <!-- physical NIC / internet -->
  <rect x="290" y="300" width="140" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="360" y="320" fill="#1e293b" text-anchor="middle">host eth0 → LAN/Internet</text>
  <line x1="360" y1="286" x2="360" y2="300" stroke="#475569" marker-end="url(#arr)"/>

  <!-- DNS note -->
  <rect x="500" y="300" width="200" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="600" y="320" fill="#1e293b" text-anchor="middle">embedded DNS 127.0.0.11</text>
</svg>
```

The **host driver** skips all of this: the container joins the host's namespace, so there's no veth, no bridge, no NAT — `nginx` binds directly to the host's `:80`. **overlay** replaces the local bridge with a VXLAN tunnel: a frame destined for a container on another host is encapsulated (UDP 4789) and decapsulated on the far side, so containers cluster-wide share one virtual L2 segment.

## 6. Variations & Trade-offs

| Driver | Scope | DNS by name | Isolation | Typical use |
|---|---|---|---|---|
| default `bridge` | single host | ❌ IP only | medium | ad-hoc `docker run` |
| user-defined `bridge` | single host | ✅ | good | app on one host (Compose) |
| `host` | single host | n/a (host DNS) | none | max throughput, low latency |
| `none` | single host | n/a | total | untrusted batch jobs |
| `overlay` | multi-host | ✅ | good (opt. IPsec) | Swarm/cluster services |
| `macvlan` | single host | ❌ (uses LAN) | L2 to host | legacy apps needing a LAN IP |

The core trade-off is **isolation vs. performance vs. reach**. `host` is fastest because there's no bridge hop or NAT, but you lose port isolation and portability. `overlay` reaches across machines but pays a VXLAN encapsulation cost. `macvlan` gives near-native performance and a real LAN identity but bypasses Docker's port publishing and often needs promiscuous mode on the NIC. For 90% of single-host work, a **user-defined bridge is the right default**.

## 7. Production / Performance Notes

- **Always create user-defined networks.** You get DNS, cleaner isolation, and the ability to attach/detach live. Compose does this for you per project.
- **Bind to loopback for host-only ports.** `-p 127.0.0.1:5432:5432` keeps a database off the LAN; `-p 5432:5432` publishes to `0.0.0.0` and is a common accidental exposure.
- **NAT has a cost.** High-connection-rate services can exhaust conntrack table entries; watch `nf_conntrack_count`. `host` networking or larger `nf_conntrack_max` mitigates it.
- **MTU mismatches** on overlay/VPN underlays cause silent hangs on large payloads. VXLAN adds ~50 bytes of overhead; set `com.docker.network.driver.mtu` if the underlay MTU is 1500.
- **The default bridge subnet (`172.17.0.0/16`) can collide** with corporate VPN ranges. Reconfigure via `default-address-pools` in `/etc/docker/daemon.json`.
- **DNS caching:** Docker's embedded resolver returns live IPs, but an app that caches a resolved IP forever will break when a container is recreated. Resolve by name per-connection.
- **Inter-container traffic on a bridge is not encrypted.** For cross-host confidentiality use overlay with `--opt encrypted`.

## 8. Common Mistakes

1. ⚠️ **Pinging by name on the default bridge and expecting it to work.** Fix: create a user-defined network — DNS only exists there.
2. ⚠️ **Hardcoding container IPs.** They're reassigned on recreate. Fix: reference peers by container/service name.
3. ⚠️ **Forgetting both containers must share the same network.** Two containers on different networks can't see each other. Fix: `docker network connect` or put them on one network.
4. ⚠️ **Publishing everything to `0.0.0.0`.** Exposes internal services to the whole LAN. Fix: bind sensitive ports to `127.0.0.1`.
5. ⚠️ **Using `host` networking to "fix" connectivity, then hitting port conflicts.** Fix: use a user-defined bridge and publish only what's needed.
6. ⚠️ **Assuming `EXPOSE` publishes a port.** It only documents intent. Fix: use `-p` / `ports:` to actually publish.
7. ⚠️ **macvlan container can't reach its own host.** By design, the parent interface can't talk to its macvlan children. Fix: add a macvlan shim interface on the host, or use a bridge instead.

## 9. Interview Questions

**Q: What's the difference between the default bridge and a user-defined bridge network?**
A: Both isolate containers on one host, but a user-defined bridge adds automatic DNS resolution by container name via Docker's embedded resolver, gives better isolation (only containers you attach can talk), and supports live connect/disconnect. The default `bridge` offers IP-only reachability with no name DNS.

**Q: How does a container reach the internet, and how does an external client reach a container?**
A: Outbound uses SNAT/masquerade — the bridge routes packets to the host and an iptables `POSTROUTING` rule rewrites the source to the host IP. Inbound requires `-p host:container`, which installs a `DNAT` rule in `PREROUTING` that forwards the host port into the container's IP:port.

**Q: What is a veth pair and where are its two ends?**
A: A veth pair is a virtual Ethernet cable with two linked endpoints. One end is `eth0` inside the container's network namespace; the other is attached to the host bridge (`docker0` or `br-xxxx`). A packet entering one end exits the other, connecting the container to the bridge.

**Q: When would you use `--network host`, and what do you give up?**
A: Use it for maximum throughput and lowest latency, or when an app needs to bind many/dynamic ports. You give up network isolation and port remapping — the container shares the host's stack, so `localhost` is the host and port conflicts are real. It's Linux-only (on Docker Desktop it behaves differently).

**Q: What problem does the overlay driver solve that bridge can't?**
A: Cross-host networking. Bridge is confined to one host; overlay builds a VXLAN tunnel so containers on different machines share one virtual L2 network and can address each other by name, which is how Swarm services communicate across nodes.

**Q: How does Docker's embedded DNS work and what IP does it live on?**
A: On user-defined networks each container has a resolver at `127.0.0.11`. Docker intercepts queries there and maps container/service names to their current IPs, updating as containers come and go, so name-based connections survive restarts and rescheduling.

**Q: A container on network A can't reach a container on network B. Why, and how do you fix it?**
A: Networks are isolated L2 domains; a container only has interfaces on networks it's attached to. Attach one container to the other's network with `docker network connect B container-a` (multi-homing), or place both on a shared network.

**Q: (Senior) Why might high-connection-rate workloads suffer under default bridge networking, and what would you tune?**
A: Every connection consumes a conntrack entry for NAT; under load the `nf_conntrack` table can fill, dropping new connections. Tune `nf_conntrack_max` and hash size, reduce timeouts, or bypass NAT with `host` networking or direct routing.

**Q: (Senior) How would you give a container a real IP on the physical LAN, and what are the caveats?**
A: Use the macvlan driver with `--subnet`/`--gateway`/`-o parent=eth0`. The container gets its own MAC/IP on the LAN. Caveats: the parent NIC often needs promiscuous mode, the host can't talk to its own macvlan children without a shim interface, and cloud providers frequently block unknown MACs.

**Q: (Senior) How do you keep inter-service traffic confidential across hosts?**
A: On a single host, traffic on a bridge isn't encrypted but stays local. Across hosts, use an overlay network created with `--opt encrypted`, which enables IPsec (ESP) between nodes — accepting the CPU/MTU overhead of encapsulation and encryption.

**Q: (Senior) What's the difference between `EXPOSE` in a Dockerfile and `-p` at runtime?**
A: `EXPOSE` is metadata — it documents which ports the image listens on and is used by tooling and `-P` (publish-all). It opens nothing by itself. `-p host:container` actually publishes: it installs the DNAT rule that makes the container reachable from outside the host.

## 10. Practice

- [ ] Create a user-defined bridge, run two containers on it, and prove they resolve each other by name with `getent hosts`.
- [ ] Run the same two containers on the default bridge and observe that name resolution fails but IP ping works.
- [ ] Publish a service on `127.0.0.1:8080` and confirm from another LAN host that it is NOT reachable, then republish on `0.0.0.0` and confirm it is.
- [ ] Inspect a bridge network's iptables rules (`iptables -t nat -L -n`) and identify the SNAT and DNAT entries for a published container.
- [ ] Multi-home a container onto two networks with `docker network connect` and verify it can reach services on both.

## 11. Cheat Sheet

> [!TIP]
> **Networking in one screen.** Every container = its own netns, wired by a **veth pair** to a **bridge** (virtual switch). Drivers: **bridge** (default, single host, IP-only) → prefer **user-defined bridge** (adds DNS by name @ `127.0.0.11`, better isolation); **host** (shares host stack, fast, no isolation, Linux); **none** (loopback only); **overlay** (multi-host VXLAN, Swarm); **macvlan** (real LAN IP/MAC). Egress = SNAT/masquerade; ingress needs `-p host:container` (DNAT). `EXPOSE` documents, `-p` publishes. Bind host-only ports to `127.0.0.1`. Never hardcode container IPs — use names.

**References:** Docker Networking overview (docs.docker.com/network), Docker "Container networking" & "Use bridge networks" guides, Linux bridge & veth kernel docs, "Deep dive into Docker overlay networks" (Docker blog)

---
*Docker Handbook — topic 11.*
