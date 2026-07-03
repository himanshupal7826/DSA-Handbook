# 12 · Cluster DNS & Service Discovery

> **In one line:** Kubernetes runs an in-cluster DNS server (CoreDNS) that turns Service and pod names into IPs, so workloads find each other by stable names like `orders.prod.svc.cluster.local` instead of chasing ephemeral pod IPs.

---

## 1. Overview

Pods come and go with fresh IPs every time. Hard-coding IPs is hopeless, so Kubernetes ships **cluster DNS**: a DNS server (today **CoreDNS**) that watches the API for Services and pods and answers name queries from inside the cluster. This is the backbone of **service discovery** — a client just resolves a name and gets a stable virtual IP.

Every Service automatically gets a DNS **A/AAAA record**. A normal (ClusterIP) Service resolves to its single virtual IP; a **headless** Service (`clusterIP: None`) resolves to the *individual pod IPs* behind it, which is what StatefulSets and client-side load balancers need. Named ports additionally get **SRV records** describing `port/protocol/target`.

The kubelet wires each pod's `/etc/resolv.conf` to point at the cluster DNS Service IP and adds a **search list** so short names auto-expand. That's why `curl http://orders` works from a pod in the same namespace: the resolver tries `orders.<ns>.svc.cluster.local` first. Understanding the **FQDN structure**, the **search-path expansion**, and **DNS policies** is what separates "it works on my cluster" from debugging a resolution outage under load.

## 2. Core Concepts

- **CoreDNS** — the default cluster DNS server, run as a Deployment in `kube-system` and fronted by a Service (usually named `kube-dns`, ClusterIP typically `10.96.0.10`). Configured via the `Corefile` in a ConfigMap.
- **FQDN pattern** — `<service>.<namespace>.svc.<cluster-domain>`, default cluster domain `cluster.local` → e.g. `orders.prod.svc.cluster.local`.
- **Pod DNS records** — a pod's A record is `<pod-ipv4-with-dashes>.<namespace>.pod.cluster.local` (e.g. `10-1-2-3.prod.pod.cluster.local`); mostly used with headless Services and StatefulSets.
- **Headless Service** — `clusterIP: None`; DNS returns **all ready pod IPs** (A records) instead of one VIP, enabling direct pod addressing and client-side LB.
- **SRV records** — for named ports, `_<port-name>._<proto>.<service>.<ns>.svc.cluster.local` returns priority/weight/port/target; StatefulSet pods get per-pod SRV entries.
- **Search list & `ndots`** — pod `resolv.conf` has `search <ns>.svc.cluster.local svc.cluster.local cluster.local` and `options ndots:5`, so unqualified names get suffixes appended before a query is treated as absolute.
- **`dnsPolicy`** — per-pod control: `ClusterFirst` (default), `ClusterFirstWithHostNet`, `Default` (inherit node), `None` (fully custom via `dnsConfig`).
- **`dnsConfig`** — lets you override nameservers, searches, and options (e.g. lower `ndots` to cut query fan-out).
- **StatefulSet stable identity** — with a headless governing Service, each pod gets `<pod>.<service>.<ns>.svc.cluster.local`, e.g. `mysql-0.mysql.prod.svc.cluster.local`.
- **ExternalName** — a Service that resolves to a **CNAME** pointing at an external host, with no proxying.

## 3. Syntax & Examples

The default names a pod sees (`kubectl exec` into any pod):

```bash
$ cat /etc/resolv.conf
nameserver 10.96.0.10
search prod.svc.cluster.local svc.cluster.local cluster.local
options ndots:5
```

Resolving Services by short, namespaced, and fully-qualified name:

```bash
# same namespace — short name works via search list
curl http://orders/health
# cross-namespace — must qualify with the namespace
curl http://orders.payments/health
# fully-qualified (skips search expansion, one query)
curl http://orders.payments.svc.cluster.local/health
```

A **headless** Service so DNS returns pod IPs directly:

```yaml
apiVersion: v1
kind: Service
metadata: { name: mysql, namespace: prod }
spec:
  clusterIP: None            # headless — no VIP
  selector: { app: mysql }
  ports:
    - name: db               # named port → gets an SRV record
      port: 3306
```

Custom DNS with `dnsConfig` (lower `ndots` to reduce lookups):

```yaml
spec:
  dnsPolicy: ClusterFirst
  dnsConfig:
    options:
      - { name: ndots, value: "2" }
    searches:
      - internal.example.com
```

## 4. Worked Example

Deploy a StatefulSet with a headless Service and observe stable per-pod DNS:

```yaml
apiVersion: v1
kind: Service
metadata: { name: cache, namespace: prod }
spec:
  clusterIP: None
  selector: { app: cache }
  ports: [{ name: redis, port: 6379 }]
---
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: cache, namespace: prod }
spec:
  serviceName: cache          # governing headless Service
  replicas: 3
  selector: { matchLabels: { app: cache } }
  template:
    metadata: { labels: { app: cache } }
    spec:
      containers:
        - name: redis
          image: redis:7
          ports: [{ name: redis, containerPort: 6379 }]
```

Querying DNS from a debug pod shows the VIP-less headless resolution and SRV records:

```text
# Headless A query returns ALL pod IPs, not one VIP:
$ kubectl run -it --rm dns --image=busybox:1.36 -- nslookup cache.prod.svc.cluster.local
Name:   cache.prod.svc.cluster.local
Address: 10.1.0.7
Address: 10.1.0.8
Address: 10.1.0.9

# Each StatefulSet pod has a STABLE per-pod name:
$ nslookup cache-0.cache.prod.svc.cluster.local
Address: 10.1.0.7

# SRV record for the named port:
$ nslookup -type=SRV _redis._tcp.cache.prod.svc.cluster.local
_redis._tcp.cache.prod.svc.cluster.local  service = 10 33 6379 cache-0.cache.prod.svc.cluster.local
                                           service = 10 33 6379 cache-1.cache.prod.svc.cluster.local
```

## 5. Under the Hood

CoreDNS is a chain of plugins defined in the `Corefile`. The **`kubernetes`** plugin watches the API server for Services, EndpointSlices, and pods, and synthesizes records on the fly (no zone files). Queries it can't answer — external domains — fall through to the **`forward`** plugin, which sends them upstream (often the node's resolver). The **`cache`** plugin memoizes answers to shed load. A pod's resolver appends each `search` suffix in turn; with `ndots:5`, any name with fewer than 5 dots is tried *with* suffixes first, so `orders` becomes up to four queries before an absolute lookup.

```svg
<svg viewBox="0 0 720 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="22" text-anchor="middle" fill="#1e293b" font-weight="bold">Resolving "orders" from a pod in namespace prod</text>

  <rect x="30" y="50" width="150" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="105" y="76" text-anchor="middle" fill="#1e293b">App pod</text>
  <text x="105" y="94" text-anchor="middle" fill="#64748b">resolv.conf points</text>
  <text x="105" y="108" text-anchor="middle" fill="#64748b">to 10.96.0.10</text>

  <rect x="285" y="50" width="150" height="60" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="360" y="76" text-anchor="middle" fill="#1e293b">CoreDNS</text>
  <text x="360" y="94" text-anchor="middle" fill="#64748b">kube-system</text>
  <text x="360" y="108" text-anchor="middle" fill="#64748b">Corefile plugins</text>

  <rect x="540" y="35" width="150" height="42" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="615" y="61" text-anchor="middle" fill="#1e293b">API server watch</text>
  <rect x="540" y="90" width="150" height="42" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="615" y="116" text-anchor="middle" fill="#1e293b">upstream DNS</text>

  <line x1="180" y1="80" x2="283" y2="80" stroke="#475569" marker-end="url(#a2)"/>
  <text x="232" y="72" text-anchor="middle" fill="#64748b">query</text>
  <line x1="435" y1="66" x2="538" y2="56" stroke="#475569" marker-end="url(#a2)"/>
  <text x="486" y="48" text-anchor="middle" fill="#64748b">kubernetes</text>
  <line x1="435" y1="96" x2="538" y2="108" stroke="#475569" marker-end="url(#a2)"/>
  <text x="486" y="130" text-anchor="middle" fill="#64748b">forward (external)</text>

  <text x="360" y="175" text-anchor="middle" fill="#1e293b" font-weight="bold">search-list expansion (ndots:5)</text>
  <rect x="90" y="195" width="540" height="115" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="360" y="220" text-anchor="middle" fill="#64748b">1. orders.prod.svc.cluster.local    match then return ClusterIP</text>
  <text x="360" y="245" text-anchor="middle" fill="#64748b">2. orders.svc.cluster.local         tried only if 1 fails</text>
  <text x="360" y="270" text-anchor="middle" fill="#64748b">3. orders.cluster.local</text>
  <text x="360" y="295" text-anchor="middle" fill="#64748b">4. orders   treated as absolute (last)</text>
</svg>
```

## 6. Variations & Trade-offs

| Service type / record | DNS answer | Use case |
|---|---|---|
| ClusterIP Service | single virtual IP (A/AAAA) | normal in-cluster LB |
| Headless (`clusterIP: None`) | all ready pod IPs | StatefulSet, client-side LB, peer discovery |
| StatefulSet pod | `<pod>.<svc>.<ns>.svc.cluster.local` | stable per-pod identity |
| Named port | SRV record (`_port._proto…`) | port discovery, gRPC/mesh |
| ExternalName | CNAME to external host | alias an out-of-cluster DB |
| Pod A record | `<ip-dashes>.<ns>.pod.cluster.local` | direct pod addressing |

Prefer **FQDNs** (`svc.ns.svc.cluster.local`) in config and libraries: they skip search-list expansion, so one query instead of five, which matters under high request rates. Use **short names** only for same-namespace convenience. Choose **headless** whenever the client needs to see individual pods (databases, sharded caches, gossip clusters); choose **ClusterIP** when you want the platform to load-balance.

## 7. Production / Performance Notes

- **`ndots:5` is a latency trap.** Every unqualified external lookup (e.g. `api.stripe.com`) is tried with all four search suffixes first — 5 failed queries before the real one. Fix with a trailing dot (`api.stripe.com.`), an FQDN, or a per-pod `dnsConfig` lowering `ndots`.
- **Scale CoreDNS with load.** DNS QPS scales with pods × request rate. Watch CoreDNS CPU and cache hit ratio; add replicas or enable **NodeLocal DNSCache** (a per-node DNS cache) to cut latency and API pressure.
- **NodeLocal DNSCache** also avoids conntrack races and DNS timeouts on busy nodes — a common production win.
- **Negative caching:** CoreDNS caches NXDOMAIN too; a Service created *after* a client first queried it may be briefly unresolvable until the negative TTL expires.
- **`hostNetwork` pods** default to the node's resolver — set `dnsPolicy: ClusterFirstWithHostNet` to keep cluster DNS.
- **Headless + not-ready pods:** by default only ready pods appear; set `publishNotReadyAddresses: true` if peers must discover each other before readiness (StatefulSet bootstrap).
- **Cluster domain is fixed at install** (`--cluster-domain`); don't hard-code `cluster.local` if you might run on a cluster configured differently.

## 8. Common Mistakes

1. ⚠️ **Using a short Service name across namespaces.** `orders` only resolves in the same namespace. *Fix:* qualify it — `orders.payments` or the full FQDN.
2. ⚠️ **Slow external DNS from `ndots:5`.** Every external hostname triggers 4 wasted searches. *Fix:* append a trailing dot, use FQDNs, or lower `ndots` via `dnsConfig`.
3. ⚠️ **Expecting a headless Service to load-balance.** It returns pod IPs; the client must pick one. *Fix:* use a ClusterIP Service if you want platform LB.
4. ⚠️ **Hard-coding pod IPs.** They change on every restart. *Fix:* always resolve by Service/pod DNS name.
5. ⚠️ **Under-provisioned CoreDNS.** DNS timeouts appear as random 5-second app latency spikes. *Fix:* scale replicas and/or deploy NodeLocal DNSCache; monitor CoreDNS metrics.
6. ⚠️ **`hostNetwork: true` breaks cluster DNS.** The pod uses the node resolver. *Fix:* set `dnsPolicy: ClusterFirstWithHostNet`.
7. ⚠️ **Assuming a just-created Service resolves instantly everywhere.** Negative-cache TTL can delay it. *Fix:* retry with backoff; don't treat first NXDOMAIN as fatal.

## 9. Interview Questions

**Q: What is the fully-qualified DNS name of a Service and what does each part mean?**
A: `<service>.<namespace>.svc.<cluster-domain>`, e.g. `orders.prod.svc.cluster.local` — the Service name, its namespace, the `svc` record type, and the cluster domain (default `cluster.local`).

**Q: Why does `curl http://orders` work from one pod but fail from another?**
A: The pod's `resolv.conf` search list expands `orders` to `orders.<its-namespace>.svc.cluster.local` first. It only resolves if the caller is in the *same namespace* as the Service; from another namespace you must qualify it (`orders.<ns>`).

**Q: What does a headless Service return from DNS and why use one?**
A: With `clusterIP: None`, DNS returns the individual ready pod IPs (A records) instead of a single VIP. It's used for StatefulSets, client-side load balancing, and peer discovery where clients need to address specific pods.

**Q: What DNS name does StatefulSet pod `mysql-0` get?**
A: `mysql-0.<governing-service>.<namespace>.svc.cluster.local` — e.g. `mysql-0.mysql.prod.svc.cluster.local` — a stable name that survives reschedules, which is why StatefulSets need a headless governing Service.

**Q: What are SRV records used for in Kubernetes DNS?**
A: For named ports, `_<port>._<proto>.<svc>.<ns>.svc.cluster.local` returns priority/weight/port/target, letting clients discover both the endpoint and its port — common with gRPC and service meshes; StatefulSets get per-pod SRV entries.

**Q: What are the pod `dnsPolicy` options?**
A: `ClusterFirst` (default — cluster DNS first, forward external), `ClusterFirstWithHostNet` (same but for `hostNetwork` pods), `Default` (inherit the node's resolver), and `None` (fully custom via `dnsConfig`).

**Q (senior): Your app has intermittent 5-second latency spikes on outbound HTTP. How does DNS explain it, and how do you fix it?**
A: `ndots:5` makes unqualified external names try 4 search suffixes first; combined with UDP conntrack races on busy nodes, one leg times out at the 5s resolver default. Fix by using FQDNs / trailing dots, lowering `ndots` per pod, and deploying NodeLocal DNSCache to remove the race.

**Q (senior): How does CoreDNS synthesize records without zone files?**
A: Its `kubernetes` plugin watches the API server for Services, EndpointSlices, and pods and answers queries directly from that cache; there are no static zone files. Non-cluster names fall through to the `forward` plugin to upstream resolvers, with a `cache` plugin in front.

**Q (senior): You need StatefulSet peers to discover each other before they pass readiness. What DNS setting enables that?**
A: Set `publishNotReadyAddresses: true` on the headless Service so DNS publishes not-yet-ready pod addresses, letting the cluster bootstrap (e.g. a quorum forming) before any member is Ready.

**Q (senior): Why prefer FQDNs over short names in production config?**
A: A short name triggers the full search-list expansion (up to 4 extra queries per lookup with `ndots:5`), adding latency and DNS load at scale. An FQDN (or trailing dot) resolves in a single query and is namespace-unambiguous.

## 10. Practice

- [ ] From a debug pod, `cat /etc/resolv.conf` and explain each `search` entry and the `ndots` value.
- [ ] Create a headless Service over a 3-replica StatefulSet and `nslookup` both the Service name and a per-pod name.
- [ ] Query an SRV record for a named port and read off the port/target.
- [ ] Add a `dnsConfig` lowering `ndots` to 2 and measure the drop in DNS queries for an external hostname (`tcpdump`/CoreDNS metrics).
- [ ] Inspect the CoreDNS `Corefile` ConfigMap in `kube-system` and identify the `kubernetes`, `forward`, and `cache` plugins.

## 11. Cheat Sheet

> [!TIP]
> **FQDN:** `service.namespace.svc.cluster.local`. Same-ns → short name; cross-ns → `service.namespace`.
> **CoreDNS** in `kube-system`, Service IP usually `10.96.0.10`; watches API, no zone files.
> **Headless** (`clusterIP: None`) → returns all pod IPs. **StatefulSet pod** → `pod-0.svc.ns.svc.cluster.local`.
> **SRV** for named ports: `_port._tcp.svc.ns.svc.cluster.local`. **Pod A:** `10-1-2-3.ns.pod.cluster.local`.
> `resolv.conf` has `search …` + `ndots:5` → short names expand (costs extra queries). Prefer FQDNs / trailing dot for external hosts.
> `dnsPolicy`: ClusterFirst (default), ClusterFirstWithHostNet, Default, None. Scale CoreDNS + NodeLocal DNSCache under load.

**References:** Kubernetes docs — DNS for Services and Pods; CoreDNS docs (`kubernetes` plugin); Kubernetes docs — Customizing DNS / NodeLocal DNSCache; Kubernetes blog — "A Deep Dive into Kubernetes DNS"

---
*Kubernetes Handbook — topic 12.*
