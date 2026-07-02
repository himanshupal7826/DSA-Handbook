# 04 · DNS & How the Web Resolves Names

> **In one line:** DNS is the internet's distributed, cached directory that turns human names like `api.stripe.com` into routable IP addresses — and a surprisingly powerful traffic-steering tool.

---

## 1. Overview

Humans remember `github.com`; routers only move packets to IP addresses like `140.82.121.3`. The **Domain Name System (DNS)** is the globally distributed database that maps names to addresses (and much more). It is arguably the largest, oldest, and most battle-tested distributed system on the planet — a hierarchical, aggressively cached, eventually-consistent key-value store answering trillions of queries a day with typical resolution latencies of **1–50 ms** (cached) and **20–200 ms** (cold walk).

The problem it solves: a single central lookup table would never scale to hundreds of millions of domains changing constantly, nor survive the availability requirements of the whole web. DNS instead delegates authority down a tree — root operators delegate `.com` to registries, who delegate `stripe.com` to Stripe's nameservers — so no single party knows or serves everything.

Beyond name→IP, modern DNS is a **control plane for traffic**: the same lookup that finds a server can pick the *nearest* server (GeoDNS/Anycast), route around a dead datacenter (failover), or split traffic for a canary. When you type a URL, the very first network round-trip your machine makes is almost always a DNS query — so DNS latency and correctness sit on the critical path of *everything*.

A real example: opening `www.netflix.com` triggers a resolver walk that may return a different IP in Tokyo than in London, each pointing at a nearby CDN edge — DNS is silently doing global load balancing before a single byte of HTTP flows.

## 2. Core Concepts

- **Resolver (recursive)** — the server (usually your ISP's, or `8.8.8.8` / `1.1.1.1`) that does the legwork of walking the hierarchy on your behalf and caches the answer. Your OS stub resolver just asks it.
- **Authoritative nameserver** — the server that holds the *source of truth* records for a zone (e.g. Route 53, Cloudflare, NS1 hosting `example.com`). It answers definitively, not from cache.
- **Root & TLD servers** — 13 logical **root** server identities (`a`–`m.root-servers.net`, each Anycast to hundreds of physical nodes) delegate to **TLD** servers for `.com`, `.org`, `.io`, etc., which in turn delegate to the domain's authoritative NS.
- **Record types** — `A` (IPv4), `AAAA` (IPv6), `CNAME` (alias to another name), `MX` (mail), `NS` (delegation), `TXT` (arbitrary text: SPF, domain verification), `SOA` (zone metadata), `PTR` (reverse), `SRV`/`CAA`.
- **TTL (Time To Live)** — seconds a record may be cached. Low TTL = fast changes but more query load; high TTL = cheap but slow to update. The core trade-off of DNS.
- **Recursive vs iterative** — the resolver *recursively* answers you; it *iteratively* queries root→TLD→authoritative, each server referring it one step closer.
- **Anycast** — one IP address announced from many locations via BGP; packets flow to the topologically nearest instance. How root/`1.1.1.1` scale and survive DDoS.
- **GeoDNS / latency-based routing** — authoritative servers return *different* answers based on the resolver's location or measured latency, steering users to the nearest datacenter.
- **Propagation** — the (misnamed) delay before a change is globally visible; really just old records aging out of caches per their TTL.
- **Negative caching** — `NXDOMAIN` (no such name) responses are cached too (bounded by SOA minimum TTL), so typos don't hammer authoritatives.

## 3. Architecture

DNS is a tree of delegated authority. Your stub resolver asks a recursive resolver; on a cache miss the resolver walks from the root down, following referrals, then caches every answer with its TTL. The next identical query anywhere behind that resolver is served from memory in microseconds.

```svg
<svg viewBox="0 0 760 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ar" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker>
  </defs>
  <rect x="20" y="120" width="120" height="52" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="80" y="142" text-anchor="middle" fill="#1e293b">Stub resolver</text>
  <text x="80" y="160" text-anchor="middle" fill="#64748b" font-size="11">(your OS/browser)</text>

  <rect x="200" y="120" width="140" height="52" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="270" y="142" text-anchor="middle" fill="#1e293b">Recursive resolver</text>
  <text x="270" y="160" text-anchor="middle" fill="#64748b" font-size="11">cache + walker (1.1.1.1)</text>

  <rect x="600" y="20" width="140" height="44" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="670" y="46" text-anchor="middle" fill="#1e293b">Root (. )</text>
  <rect x="600" y="128" width="140" height="44" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="670" y="150" text-anchor="middle" fill="#1e293b">TLD (.com)</text>
  <rect x="600" y="236" width="140" height="44" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="670" y="256" text-anchor="middle" fill="#1e293b">Authoritative</text>
  <text x="670" y="272" text-anchor="middle" fill="#64748b" font-size="11">stripe.com NS</text>

  <line x1="140" y1="146" x2="196" y2="146" stroke="#475569" stroke-width="1.5" marker-end="url(#ar)"/>
  <text x="168" y="138" text-anchor="middle" fill="#64748b" font-size="11">query</text>

  <line x1="340" y1="138" x2="596" y2="52" stroke="#475569" stroke-width="1.5" marker-end="url(#ar)"/>
  <text x="470" y="86" text-anchor="middle" fill="#64748b" font-size="11">1. ? → referral to .com</text>
  <line x1="340" y1="146" x2="596" y2="150" stroke="#475569" stroke-width="1.5" marker-end="url(#ar)"/>
  <text x="470" y="170" text-anchor="middle" fill="#64748b" font-size="11">2. ? → referral to NS</text>
  <line x1="340" y1="154" x2="596" y2="252" stroke="#475569" stroke-width="1.5" marker-end="url(#ar)"/>
  <text x="470" y="242" text-anchor="middle" fill="#64748b" font-size="11">3. ? → A record 34.x.x.x</text>

  <line x1="196" y1="158" x2="142" y2="158" stroke="#059669" stroke-width="1.5" marker-end="url(#ar)"/>
  <text x="168" y="176" text-anchor="middle" fill="#059669" font-size="11">answer (cached, TTL)</text>
</svg>
```

## 4. How It Works

The canonical cold resolution of `www.stripe.com` from an empty cache:

1. **App → stub resolver.** The browser calls `getaddrinfo`; the OS stub resolver forwards the query to the configured recursive resolver over UDP/53 (or DoH/DoT on 443/853).
2. **Cache check.** The recursive resolver checks its cache. Hit → return immediately (sub-millisecond). Miss → begin the walk.
3. **Ask a root server.** "Where is `www.stripe.com`?" The root doesn't know but *does* know who runs `.com`: it returns a **referral** (NS records) to the `.com` TLD servers. (Root/TLD IPs are bootstrapped from the resolver's baked-in **root hints** and cached for a long time.)
4. **Ask the TLD server.** The `.com` server returns a referral to Stripe's authoritative nameservers (the NS records Stripe set at their registrar).
5. **Ask the authoritative server.** Stripe's NS returns the **authoritative answer**: an `A`/`AAAA` record (possibly via a `CNAME` chain to a CDN), each with a TTL.
6. **Cache & return.** The resolver caches every record for its TTL and returns the final IP(s) to the stub resolver, which returns to the app.
7. **Connect.** The browser opens a TCP/QUIC connection to the returned IP. All subsequent lookups behind that resolver — for any user — are cache hits until the TTL expires.

```text
client → resolver:  www.stripe.com A?
resolver → root:    www.stripe.com A?   → NS for .com
resolver → .com:    www.stripe.com A?   → NS for stripe.com
resolver → auth:    www.stripe.com A?   → CNAME cdn.stripe.map.fastly.net
resolver → auth:    cdn...fastly.net A? → A 151.101.x.x  TTL=30
resolver → client:  151.101.x.x  (then cached 30s)
```

## 5. Key Components / Deep Dive

### Caching layers & TTL
There are *many* caches: browser (seconds–minutes), OS stub, the recursive resolver (the big one), and sometimes forwarders in between. Each honors the record's TTL independently, counting down from when *it* fetched. This is why a change isn't instant even at TTL=0: a resolver that fetched 59s ago with TTL=60 still serves the old value for one more second. **Negative answers** (`NXDOMAIN`) are cached per the SOA's minimum-TTL field.

### CNAME vs A, and the apex problem
A `CNAME` aliases one name to another (`www` → `d1234.cloudfront.net`), letting the CDN change IPs freely behind a stable name. But **you cannot put a CNAME at the zone apex** (`example.com` itself) because the apex must carry SOA/NS records and CNAME must be the *only* record at a name. Managed DNS solves this with `ALIAS`/`ANAME` (a synthetic apex record the authoritative server resolves and flattens to A/AAAA at query time).

### Anycast for scale and DDoS survival
Root servers and public resolvers announce a single IP from hundreds of BGP-peered sites. Packets reach the nearest one, giving low latency *and* absorbing DDoS by spreading load across the globe. A node can be withdrawn from BGP and traffic instantly reroutes — no client change needed.

### GeoDNS & latency-based routing
Authoritative providers (Route 53, NS1) inspect the querying resolver's IP (or EDNS Client Subnet, which forwards a truncated client subnet) and return the answer for the nearest/healthiest region. This is DNS-based **global load balancing**: `A` records with health checks let a region be pulled from rotation automatically. Limitation: the resolver's location ≠ the user's location unless ECS is honored, and TTLs bound how fast failover takes effect.

### DNS as failover & load balancing
- **Round-robin DNS**: return multiple A records; clients pick one (crude spread, no health awareness on its own).
- **Weighted / latency / geo routing**: split or steer traffic.
- **Health-checked failover**: authoritative server stops returning a region's IP when its health check fails — but old cached answers linger for the TTL, so keep failover-critical records at **TTL 30–60s**.

## 6. Trade-offs

| Option | Pros | Cons |
|---|---|---|
| **Low TTL (30–60s)** | Fast failover/migration; agile | More authoritative queries (cost/load); slightly higher avg latency |
| **High TTL (hours–days)** | Cheap, resilient to authoritative outage, fast (cached) | Changes take hours to propagate; risky for migrations |
| **CNAME to provider** | Provider changes IPs freely; clean | Extra resolution hop (+latency); not allowed at apex |
| **A record (direct)** | One hop, works at apex | You must update it when IPs change |
| **GeoDNS/latency routing** | Nearest-region, DNS-level LB & failover | Resolver≠user location; TTL bounds failover; ECS privacy trade-off |
| **Anycast** | Low latency, DDoS-resilient, no client change | Needs BGP/infra; harder to debug "which node answered" |

Rule of thumb: keep TTLs **high (1h+) for stable records** to cut load and improve resilience, but **drop to 60s a day *before*** a planned IP change or cutover, then raise again after. Failover-critical endpoints stay low permanently.

## 7. When to Use / When to Avoid

**Use DNS-level routing when:**
- You need global traffic steering (GeoDNS/latency) to nearest datacenter or CDN edge.
- You want cheap, coarse failover between regions/providers with 30–60s RTO tolerance.
- You must move a service's IP without touching every client (CNAME to a stable name).
- You need Anycast to survive volumetric DDoS and cut RTT.

**Avoid relying on DNS for:**
- **Sub-second failover** — TTLs and client caching make DNS failover minutes-slow in the tail; use L4/L7 load balancers or Anycast + health-drained VIPs for that.
- **Fine-grained per-request balancing** — resolvers cache, so one client hammers one IP; balance at an LB instead.
- **Security boundaries** — plain DNS is unauthenticated/unencrypted; use DNSSEC (integrity) and DoH/DoT (privacy), don't assume DNS answers are trustworthy.

## 8. Scaling & Production Best Practices

- **Right-size TTLs**: 3600s+ for stable A/MX/TXT; 30–60s for failover-critical or pre-migration. Never 0.
- **Cutover playbook**: lower TTL 24–48h ahead → change record → wait ≥ old TTL → verify → raise TTL back.
- **Multiple, diverse authoritative providers** (e.g. Route 53 + NS1) to survive a single provider's outage — the Dyn 2016 DDoS took down Twitter/Spotify/Reddit because they were single-homed.
- **Health-checked failover** on GeoDNS so dead regions auto-drop.
- **Anycast your authoritative + resolver footprint** for latency and DDoS.
- **Use ALIAS/ANAME at apex**, CNAME on subdomains.
- **Enable DNSSEC** to prevent cache-poisoning/spoofing; **DoH/DoT** for client privacy.
- Watch out for **negative-cache TTLs**: a bad deploy that briefly returns NXDOMAIN can be cached for the SOA minimum — keep it modest (300–900s).

## 9. Failure Modes & Mitigations

| Failure | Impact | Mitigation |
|---|---|---|
| Authoritative provider DDoS/outage | Domain unresolvable → total outage | Multiple providers; Anycast; secondary DNS |
| Wrong record pushed | Site down / traffic to wrong place globally | Low TTL for fast rollback; change review; monitoring |
| High TTL + emergency change | Stale answers linger hours | Pre-lower TTL; can't fix retroactively — plan ahead |
| NXDOMAIN cached (bad deploy) | Errors persist past the fix | Keep SOA minimum TTL modest; flush if possible |
| Cache poisoning / spoofing | Users sent to attacker | DNSSEC validation; DoH/DoT; source-port randomization |
| CNAME chain too long / loop | Slow or failed resolution | Flatten chains; ALIAS at apex; monitor resolution time |
| Resolver ≠ user location (no ECS) | GeoDNS routes to wrong region | Use ECS-aware provider; combine with Anycast |

## 10. Monitoring & Metrics

- **Resolution latency** (p50/p99) for your critical domains, probed from multiple regions.
- **Query volume** to authoritative NS (spikes = TTL too low or attack).
- **NXDOMAIN / SERVFAIL rate** — sudden rise signals misconfig or delegation break.
- **Answer correctness** — synthetic checks that the returned IPs match expected per region.
- **DNSSEC validation failures** — expired signatures = instant outage for validating resolvers.
- **Propagation lag** after a change — measure when global resolvers reflect the new value.
- **Health-check state** of GeoDNS endpoints and last failover time.
- **Cache hit ratio** at your recursive resolvers (if you run them).

## 11. Common Mistakes

1. ⚠️ **TTL=0 or absurdly low** on everything — hammers authoritatives, raises latency, and provides no real benefit.
2. ⚠️ **Emergency IP change with a 24h TTL still set** — you're stuck serving stale answers for a day; lower TTLs *before* you need them.
3. ⚠️ **Single authoritative provider** — one DDoS/outage = your entire domain is dark (remember Dyn 2016).
4. ⚠️ **Putting a CNAME at the zone apex** — breaks SOA/NS; use ALIAS/ANAME instead.
5. ⚠️ **Assuming "propagation" is a network delay** — it's just caches aging out; you can't speed it up post-change.
6. ⚠️ **Relying on DNS for fast failover** — client/OS/resolver caching ignores your TTL in practice; RTO is minutes, not seconds.
7. ⚠️ **Forgetting DNSSEC signature expiry** — an unrotated/expired signature is a self-inflicted global outage.
8. ⚠️ **Ignoring negative caching** — a transient NXDOMAIN gets cached and outlives the fix.

## 12. Interview Questions

1. **Q: Walk me through what happens, network-hop by network-hop, when I type `www.example.com` and hit enter.**
   A: Browser/OS stub resolver → recursive resolver (cache check) → on miss, iterative walk: root returns referral to `.com` TLD → TLD returns referral to example.com's authoritative NS → authoritative returns A/AAAA (possibly via CNAME chain) with TTL → resolver caches and returns → browser opens TCP/TLS/QUIC to the IP. Cached lookups skip straight to the resolver's answer.

2. **Q: Recursive vs iterative resolution — who does which?**
   A: The client↔recursive-resolver exchange is *recursive* (resolver promises a final answer). The resolver↔{root,TLD,auth} exchanges are *iterative* (each server returns a referral, not the final answer; the resolver keeps asking down the tree).

3. **Q: Explain TTL and the trade-off you're making when you set it.**
   A: TTL is how long any cache may keep a record. Low = fast change/failover but more query load and slightly higher latency; high = cheap, resilient, fast (cached) but slow to change. You tune per record: high for stable, 30–60s for failover-critical or pre-migration.

4. **Q: Why can't you use a CNAME at the zone apex, and what do you use instead?**
   A: A CNAME must be the only record at a name, but the apex must carry SOA and NS records — conflict. Managed DNS offers ALIAS/ANAME, a synthetic record the authoritative server resolves and flattens to A/AAAA at query time.

5. **Q: How does DNS act as a load balancer and a failover mechanism? What are its limits?**
   A: Multiple A records (round-robin), weighted/geo/latency routing, and health-checked failover steer or drop traffic at resolution time — global, cheap, no client change. Limits: caching means one client sticks to one IP (poor fine-grained balancing), and TTL + client caching make failover minutes-slow, not sub-second.

6. **Q [Senior]: A user reports your site is down but you pushed a fix 10 minutes ago. How does DNS caching explain this and what could you have done?**
   A: The bad record (or its IP) is cached at the user's resolver/OS/browser until its TTL expires, and negative answers/NXDOMAIN cache per SOA minimum. If TTL was high, you're stuck. Prevention: keep failover-critical TTLs at 30–60s, lower TTLs before planned changes, and don't depend on DNS for fast rollback — use an LB/Anycast VIP you can drain instantly.

7. **Q [Senior]: How would you architect DNS to survive a provider-level DDoS like the 2016 Dyn attack?**
   A: Multi-provider authoritative DNS (two independent vendors serving the same zone via secondary/AXFR or dual delegation), Anycast footprints on both, health-checked failover, sensible TTLs so caches absorb transient blips, and monitoring of SERVFAIL/latency per region. Single-homing authoritative DNS is a single point of total failure.

8. **Q [Senior]: GeoDNS routes some users to the wrong region. What's the mechanism and how do you fix it?**
   A: Authoritative servers see the *resolver's* IP, not the user's, so a user on a distant public resolver (or one that strips EDNS Client Subnet) gets geolocated to the resolver. Fix: use an ECS-aware provider so a truncated client subnet is forwarded, and/or combine GeoDNS with **Anycast** so the routing happens at the network layer (nearest node) instead of relying on DNS geolocation.

9. **Q [Staff]: Design DNS for a service needing <1s regional failover. Is DNS the right tool?**
   A: Largely no — DNS failover is bounded below by client/resolver caching and is minute-scale in the tail. Do failover *below* DNS: keep a stable Anycast VIP; announce/withdraw it via BGP or drain it at L4/L7 load balancers with fast health checks. Use DNS for coarse region selection and stable naming, not for the sub-second failover itself.

10. **Q [Staff]: What does DNSSEC protect against, what does it *not* protect, and what's its operational risk?**
    A: DNSSEC provides *integrity/authenticity* (cryptographic signatures prevent cache poisoning/spoofing) — it does **not** provide confidentiality (that's DoH/DoT) and doesn't stop DDoS. Its big operational risk is key/signature management: an expired signature or broken chain of trust causes validating resolvers to return SERVFAIL — a self-inflicted global outage. Automate signing/rotation and monitor signature expiry.

## 13. Alternatives & Related

- **Load Balancing** — DNS does coarse global steering; L4/L7 LBs do fine-grained, fast, health-aware balancing. Use both in layers.
- **CDNs** — resolve users to the nearest edge via GeoDNS/Anycast; DNS is the CDN's steering wheel.
- **Anycast / BGP** — the network-layer alternative for latency and fast failover where DNS is too slow.
- **Service discovery** (Consul, Kubernetes DNS) — internal DNS as the discovery mechanism for microservices.
- **HTTP, HTTPS & TLS** — the connection that DNS resolution precedes; SNI/ESNI and DoH intertwine with DNS privacy.

## 14. Cheat Sheet

> [!TIP]
> **DNS in one screen:**
> - **Walk:** stub → recursive resolver → (miss) root → TLD → authoritative → cache with TTL.
> - **Recursive** = resolver answers you fully; **iterative** = it walks the tree via referrals.
> - **Records:** A (IPv4), AAAA (IPv6), CNAME (alias), MX (mail), NS (delegation), TXT (verify/SPF), SOA.
> - **TTL is the master dial:** high = cheap/resilient/slow-to-change; low = agile/failover but more load. Lower it *before* changes.
> - **"Propagation" = caches expiring**, not a network process — can't be sped up after the change.
> - **No CNAME at apex** → use ALIAS/ANAME.
> - **Anycast** = one IP, many sites (latency + DDoS resilience). **GeoDNS** = location-based answers = global LB/failover.
> - **Don't** trust DNS for sub-second failover or as a security boundary. Multi-home your authoritative DNS. Sign with DNSSEC, encrypt with DoH/DoT.

**References:** Cloudflare Learning Center: DNS; "DNS and BIND" (Liu & Albitz); Root Servers (root-servers.org); RFC 1034/1035; AWS Route 53 docs.

---
*System Design Handbook — topic 04.*
