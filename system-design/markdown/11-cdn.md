# 11 · Content Delivery Networks (CDN)

> **In one line:** A CDN is a globally distributed cache of reverse proxies at the network edge that serves content from a PoP near the user — cutting latency, offloading origin, and absorbing traffic spikes and attacks.

---

## 1. Overview

A **Content Delivery Network (CDN)** is a fleet of caching servers spread across hundreds of **points of presence (PoPs)** worldwide. When a user requests an asset, they're routed to the *nearest* PoP, which serves it from cache — instead of a round trip to a single origin that might be `150 ms` away across an ocean.

The core problem is the speed of light. A user in Sydney fetching from a Virginia origin pays `~200 ms` round trip *per* request, multiplied by every image, script, and stylesheet. Serving the same bytes from a Sydney PoP `5 ms` away turns a sluggish page into an instant one. The CDN also **offloads the origin**: if `95%` of requests are cache hits, the origin sees `20×` less traffic and survives spikes it could never handle alone.

Beyond static files, modern CDNs (Cloudflare, Akamai, Fastly, CloudFront) do far more: they terminate TLS at the edge, absorb DDoS attacks, run **edge compute** (Workers/Lambda@Edge) for personalization, and accelerate even *dynamic* content by keeping warm origin connections and routing over optimized backbones. The CDN is the outermost layer of nearly every large-scale system.

## 2. Core Concepts

- **Point of Presence (PoP) / edge server** — a datacenter of caching proxies close to users; the CDN has hundreds worldwide.
- **Anycast routing** — one IP announced from every PoP; BGP delivers the user to the nearest one automatically, giving locality and DDoS absorption.
- **Cache hit / miss** — a **hit** serves from the edge; a **miss** fetches from origin (a **cache fill**), stores it, then serves.
- **Pull CDN (origin pull)** — the edge fetches on first miss and caches lazily; simplest, self-managing (the common default).
- **Push CDN** — you proactively upload/publish assets to the CDN; better for large, rarely changing files you want pre-warmed.
- **TTL & `Cache-Control`** — headers (`max-age`, `s-maxage`, `stale-while-revalidate`) that tell the edge how long a response stays fresh.
- **Invalidation / purge** — explicitly evicting stale content before its TTL expires (by URL, tag, or wildcard).
- **Cache key** — what uniquely identifies a cached object (usually URL + `Vary` headers); getting it right controls hit ratio.
- **Origin shielding** — a designated mid-tier PoP that all other PoPs pull through, so origin sees far fewer fills.
- **Edge compute** — running code (Workers/Lambda@Edge) at the PoP for auth, A/B tests, personalization, and dynamic assembly.
- **Cache hit ratio** — hits ÷ total requests; the single number that best summarizes CDN effectiveness.

## 3. Architecture

Users hit an Anycast VIP and land on the nearest PoP. On a hit, the edge serves directly. On a miss, the request goes through an optional **shield PoP** (collapsing many PoPs' fills into one) to the origin, and the response is cached on the way back.

```svg
<svg viewBox="0 0 760 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah3" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#475569"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" fill="#64748b">CDN: edge hit vs origin fill through a shield</text>

  <!-- users -->
  <rect x="25" y="60" width="95" height="38" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="72" y="83" text-anchor="middle" fill="#1e293b" font-size="12">User (SYD)</text>
  <rect x="25" y="200" width="95" height="38" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="72" y="223" text-anchor="middle" fill="#1e293b" font-size="12">User (LON)</text>

  <!-- edge PoPs -->
  <rect x="170" y="55" width="120" height="48" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="230" y="75" text-anchor="middle" fill="#1e293b">PoP · Sydney</text>
  <text x="230" y="92" text-anchor="middle" fill="#059669" font-size="11">HIT (5 ms)</text>
  <line x1="120" y1="79" x2="168" y2="79" stroke="#475569" stroke-width="1.5" marker-end="url(#ah3)"/>

  <rect x="170" y="195" width="120" height="48" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="230" y="215" text-anchor="middle" fill="#1e293b">PoP · London</text>
  <text x="230" y="232" text-anchor="middle" fill="#d97706" font-size="11">MISS → fill</text>
  <line x1="120" y1="219" x2="168" y2="219" stroke="#475569" stroke-width="1.5" marker-end="url(#ah3)"/>

  <!-- shield -->
  <rect x="350" y="125" width="130" height="48" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="415" y="145" text-anchor="middle" fill="#1e293b">Shield PoP</text>
  <text x="415" y="162" text-anchor="middle" fill="#64748b" font-size="11">collapses fills</text>
  <line x1="290" y1="219" x2="352" y2="168" stroke="#475569" stroke-width="1.5" marker-end="url(#ah3)"/>
  <line x1="290" y1="88" x2="352" y2="140" stroke="#475569" stroke-width="1.2" stroke-dasharray="4 3" marker-end="url(#ah3)"/>

  <!-- origin -->
  <rect x="560" y="120" width="150" height="58" rx="10" fill="#eff6ff" stroke="#2563eb"/>
  <text x="635" y="143" text-anchor="middle" fill="#1e293b">Origin</text>
  <text x="635" y="160" text-anchor="middle" fill="#64748b" font-size="11">app + object store</text>
  <line x1="480" y1="149" x2="558" y2="149" stroke="#475569" stroke-width="1.5" marker-end="url(#ah3)"/>

  <text x="415" y="205" text-anchor="middle" fill="#64748b" font-size="11">only misses reach origin — hit ratio 95% ⇒ 20× offload</text>
</svg>
```

## 4. How It Works

The lifecycle of a request through a pull CDN:

1. **Resolve & route.** DNS/Anycast sends the user to the nearest PoP for the CDN's VIP.
2. **Cache lookup.** The edge computes the cache key (URL + `Vary`) and checks its store.
3. **Hit → serve.** If a fresh copy exists, serve it immediately from edge memory/SSD — no origin contact. Add `Age` and `X-Cache: HIT`.
4. **Miss → fill.** If absent or stale, the edge requests it from origin (through a shield PoP if configured), which collapses concurrent misses for the same key into **one** origin fetch (request coalescing).
5. **Store per policy.** The response's `Cache-Control`/`s-maxage`/`ETag` decide whether and how long to cache. Store it keyed by cache key.
6. **Serve & revalidate.** Serve the object; on later requests past TTL, revalidate cheaply with a conditional `GET` (`If-None-Match`) → `304 Not Modified` refreshes freshness without re-transferring bytes.
7. **Invalidate on change.** When content changes, either wait out the TTL, issue an explicit **purge**, or (best) change the URL via a content hash so the new asset is a brand-new cache key.

## 5. Key Components / Deep Dive

### Push vs Pull

| | **Pull CDN** | **Push CDN** |
|---|---|---|
| Fill trigger | Lazily, on first miss | You upload/publish proactively |
| Origin storage | Origin holds the master copy | You manage what lives on the CDN |
| First request | Slow (a miss) | Fast (already warm) |
| Best for | Large, changing, or long-tail catalogs | Large, stable files (video, installers) you can't afford a cold miss on |
| Ops burden | Low — self-managing | Higher — you own publish/expiry |

Pull is the default for most web assets. Push shines when the first-hit miss penalty is unacceptable (a `4 GB` game patch) or the catalog is stable and you want everything pre-warmed.

### Cache-Control & TTL

- `Cache-Control: public, max-age=31536000, immutable` — for hashed static assets (`app.9f3a2.js`): cache "forever," never revalidate.
- `s-maxage` — a separate TTL for shared/CDN caches, distinct from the browser's `max-age`.
- `stale-while-revalidate=60` — serve slightly stale content instantly while refreshing in the background (great for hit ratio and tail latency).
- `stale-if-error=86400` — serve stale content if origin is down — a free availability boost.
- `no-store` / `private` — never cache (personalized/sensitive responses).
- `ETag` / `Last-Modified` — enable cheap `304` revalidation instead of full re-transfer.

### Invalidation & purging

The two hard things in caching: naming and invalidation. Options, cheapest to costliest: **content-hashed URLs** (best — new content = new key, no purge needed), **surrogate/cache-tag purge** (evict all objects tagged `product-42` in one call), **single-URL purge**, and **wildcard/"purge everything"** (a blunt instrument that triggers a fill stampede and hammers origin). Prefer versioned URLs; reserve purges for HTML/API responses you can't fingerprint.

### Dynamic content & edge compute

Static caching is easy; dynamic is where CDNs earn their keep. Techniques: cache dynamic responses with a *short* TTL + `stale-while-revalidate`; **micro-cache** hot HTML for `1–5 s` to shave massive origin load during spikes; use **edge compute** (Cloudflare Workers, Lambda@Edge, Fastly Compute) to personalize, do auth, A/B test, or assemble pages at the PoP; and for truly uncacheable calls, use the CDN as an accelerated proxy — warm keep-alive connections and optimized backbone routing beat the public internet.

### Origin shielding

Without a shield, a globally cold object triggers a fill from *every* PoP → an origin stampede. A shield designates one mid-tier PoP that all edges pull through, so the origin sees at most one fill per object. It raises the effective hit ratio the origin experiences and is essential for large PoP counts.

## 6. Trade-offs

| Option | Pros | Cons |
|---|---|---|
| **Pull CDN** | Self-managing, no publish step, handles long-tail | Cold-miss latency on first request; origin must stay reachable |
| **Push CDN** | No cold misses, full control of edge contents | You own publishing/expiry; wasted storage for unrequested assets |
| **Long TTL** | Max hit ratio, min origin load | Stale content until purge; invalidation complexity |
| **Short TTL / micro-cache** | Fresher content, still big origin offload | Lower hit ratio, more fills |
| **Content-hashed URLs** | No purges ever; deploy-safe | Requires a build step to fingerprint assets |
| **Wildcard purge** | Guaranteed freshness now | Fill stampede; origin load spike |
| **Edge compute** | Personalization + dynamic at the edge, low latency | Vendor lock-in, limited runtime, harder debugging |

The master trade-off is **freshness vs offload**. Longer TTLs maximize hit ratio and shield the origin but risk serving stale bytes; shorter TTLs stay fresh but push load back to origin. The escape hatch is **content-hashed URLs** for static assets (freshness *and* infinite TTL) plus **short-TTL + `stale-while-revalidate`** for HTML/API.

## 7. When to Use / When to Avoid

**Use a CDN when:**
- You serve static assets (images, JS/CSS, video, fonts, downloads) to a geographically spread audience.
- You need to offload origin and survive traffic spikes or flash crowds.
- You want DDoS absorption and edge TLS termination for free.
- Even dynamic APIs benefit from edge acceleration, micro-caching, or edge compute.

**Avoid / reconsider when:**
- Content is fully personalized and uncacheable *and* users are near the origin — the extra hop may not pay off (though acceleration/security may still justify it).
- Strict data-residency rules forbid content leaving a region — pin PoPs or skip caching.
- Rapidly changing, must-be-real-time data (live trading ticks) where any staleness is unacceptable.
- Tiny internal apps with a local audience — the operational overhead isn't worth it.

## 8. Scaling & Production Best Practices

- **Fingerprint static assets** (`app.<hash>.js`) and serve with `max-age=31536000, immutable` — highest possible hit ratio, zero purge risk.
- **Enable origin shielding** to prevent fill stampedes at scale (essential past a few dozen PoPs).
- **Tune the cache key deliberately** — strip tracking query params, normalize casing, set `Vary` narrowly (a wide `Vary: User-Agent` shreds hit ratio).
- **Use `stale-while-revalidate` + `stale-if-error`** to hide origin latency and survive origin outages.
- **Micro-cache dynamic HTML** for `1–5 s` during spikes to collapse thundering herds onto one origin fetch.
- **Compress and modernize** — `brotli`, HTTP/2/3, image resizing/`WebP`/`AVIF` at the edge.
- **Purge by cache tag**, not wildcard, to avoid origin stampedes.
- **Target `>90%` hit ratio** for static; instrument and alert when it drops (a config regression or bad `Vary`).

## 9. Failure Modes & Mitigations

| Failure | Impact | Mitigation |
|---|---|---|
| Origin down during a fill | Misses `5xx`; edge can't serve new content | `stale-if-error` to serve stale; multi-origin/failover origin |
| Cache stampede (many misses, one hot key) | Origin overwhelmed by concurrent fills | Request coalescing + origin shield; micro-cache |
| Low hit ratio | Origin overloaded, latency up | Fix cache key/`Vary`, extend TTL, fingerprint assets |
| Stale content after change | Users see old prices/pages | Content-hashed URLs; tag-based purge; shorter TTL for HTML |
| Wildcard "purge everything" | Global fill stampede, origin spike | Purge by tag/URL; ramp; keep origin capacity headroom |
| PoP outage | Regional latency increase | Anycast reroutes to next-nearest PoP automatically |
| Cached sensitive/personalized data | Data leak across users | `Cache-Control: private/no-store`; never cache auth'd responses without care |
| TLS cert issue at edge | Handshake failures for a region | Managed certs + automated rotation + monitoring |

## 10. Monitoring & Metrics

- **Cache hit ratio** — overall and per content type; the headline health metric. Alert on drops.
- **Origin offload %** — share of requests/bytes never reaching origin.
- **Edge latency** — p50/p95/p99 from PoP, and cache-fill (origin) latency separately.
- **Origin request rate & error rate** — spikes signal purges, low hit ratio, or a stampede.
- **Bandwidth** served from edge vs origin (cost + capacity).
- **Purge frequency & fill rate** — frequent purges erode hit ratio.
- **`4xx/5xx` at the edge** and `X-Cache` HIT/MISS/EXPIRED distribution.
- **Per-PoP health** and Anycast route anomalies.
- **Alerts:** hit ratio below threshold (e.g. `<85%`), origin error-rate spike, origin bandwidth surge (offload collapsing), cert expiry.

## 11. Common Mistakes

1. ⚠️ **Wide `Vary` (e.g. `User-Agent`)** — fragments the cache into thousands of variants and destroys hit ratio.
2. ⚠️ **Not fingerprinting assets** — forces constant purges and risks serving stale JS/CSS after deploys.
3. ⚠️ **Wildcard "purge everything"** on each deploy — triggers an origin fill stampede.
4. ⚠️ **Caching personalized/authenticated responses** without `private`/`no-store` — leaks one user's data to another.
5. ⚠️ **Not stripping tracking query params** from the cache key — `?utm_source=...` makes every link a unique miss.
6. ⚠️ **No origin shielding at scale** — a cold object stampedes every PoP onto the origin.
7. ⚠️ **Ignoring `stale-while-revalidate`/`stale-if-error`** — leaving free latency and availability wins on the table.
8. ⚠️ **Treating the CDN as only-static** — missing micro-caching and edge compute for dynamic acceleration.

## 12. Interview Questions

**Q: What problem does a CDN solve and how?**
A: It defeats the speed-of-light latency of a single origin and offloads that origin. Content is cached at hundreds of PoPs near users; requests are routed (via Anycast/DNS) to the nearest PoP and served from cache. A user `5 ms` away gets bytes instantly instead of a `200 ms` transoceanic round trip, and at a `95%` hit ratio the origin sees `20×` less traffic.

**Q: Explain push vs pull CDNs and when you'd use each.**
A: A pull CDN fetches from origin lazily on the first miss and caches it — self-managing, ideal for large or changing catalogs, at the cost of a cold-miss penalty on the first request. A push CDN has you proactively upload assets so they're pre-warmed — better for large, stable files (video, installers) where a cold miss is unacceptable, at the cost of managing publishing and expiry yourself.

**Q: How do `Cache-Control` and TTL control caching?**
A: `max-age`/`s-maxage` set how long a response is fresh at browser/CDN respectively. `no-store`/`private` prevent caching. `stale-while-revalidate` serves stale content while refreshing in the background; `stale-if-error` serves stale when origin is down. `ETag`/`Last-Modified` enable cheap `304` revalidation. Together they trade freshness against origin offload.

**Q: How do you invalidate cached content, and what's the best approach?**
A: Options are TTL expiry, explicit purge (by URL or cache tag), and wildcard purge. The best approach for static assets is content-hashed URLs (`app.9f3a2.js`) — changed content is a new cache key, so no purge is ever needed and deploys are atomic. Reserve tag-based purges for HTML/API you can't fingerprint, and avoid wildcard purges (they stampede the origin).

**Q: What is cache hit ratio and how do you improve it?**
A: Hits ÷ total requests — the best single measure of CDN effectiveness. Improve it by fingerprinting assets with long TTLs, normalizing the cache key (strip tracking params, narrow `Vary`), extending TTLs where freshness allows, using `stale-while-revalidate`, and enabling origin shielding so more of the population shares each cached object.

**Q: How can a CDN help with dynamic or personalized content?**
A: Micro-cache hot HTML for `1–5 s` to collapse spikes; cache dynamic responses with short TTL + `stale-while-revalidate`; run edge compute (Workers/Lambda@Edge) for personalization, auth, and A/B tests at the PoP; and for truly uncacheable calls use the CDN as an accelerated proxy with warm keep-alive connections and optimized backbone routing that beats the public internet.

**Q: (Senior) A hot object expires and thousands of requests miss simultaneously, hammering the origin. What's happening and how do you prevent it?**
A: A cache stampede (thundering herd) — concurrent misses for the same key each try to fill from origin. Prevent it with request coalescing (the edge collapses concurrent misses into a single origin fetch), origin shielding (all PoPs fill through one shield so origin sees one request), `stale-while-revalidate` (serve stale while one background fill runs), and micro-caching so the window of exposure is tiny. Keep origin capacity headroom as a backstop.

**Q: (Senior) What is origin shielding and why does it matter as PoP count grows?**
A: A shield is a designated mid-tier PoP that all other PoPs pull through. Without it, a globally cold object triggers a cache fill from *every* PoP simultaneously — with hundreds of PoPs that's an origin stampede. With a shield, the origin sees at most one fill per object regardless of PoP count, dramatically raising the hit ratio the origin experiences and protecting it during purges and new releases.

**Q: (Senior) How does Anycast routing work in a CDN, and what are its failure characteristics?**
A: One IP is announced via BGP from every PoP; the internet's routing naturally delivers each user to the topologically nearest PoP, giving locality for free and spreading (thus absorbing) DDoS traffic. On a PoP outage, BGP withdraws that announcement and traffic reroutes to the next-nearest PoP automatically — fast failover. The caveat: routing changes can move long-lived TCP flows mid-connection, and BGP picks network-nearest, not always latency-nearest, so some CDNs layer DNS-based steering on top.

**Q: (Senior) How would you prevent a CDN from ever serving one user's personalized data to another?**
A: Mark personalized/authenticated responses `Cache-Control: private, no-store`; never let them enter the shared cache. If you must cache per-user, incorporate the user/session into the cache key (rarely worth it) or assemble personalization at the edge via edge compute over a cached shell (cache the public skeleton, inject per-user bits at the PoP). Audit `Vary` and cache keys so cookies/auth headers can't collide into a shared object.

**Q: Where does a CDN sit relative to your load balancer and origin?**
A: Outermost. Client → CDN edge (PoP) → [optional shield PoP] → origin load balancer → app servers. The CDN handles cacheable traffic and TLS/DDoS at the edge; only cache misses and uncacheable requests reach your LB and origin. See **Load Balancing** and **Proxies, Reverse Proxies & API Gateways**.

## 13. Alternatives & Related

- **Caching** — the CDN is distributed caching applied at the network edge; same principles (TTL, invalidation, hit ratio).
- **Load Balancing** — Anycast is global load balancing; the CDN fronts your origin LB; see topic 09.
- **Proxies, Reverse Proxies & API Gateways** — each PoP is a reverse-proxy cache; see topic 10.
- **Vertical vs Horizontal Scaling & Statelessness** — offloading origin is a scaling strategy; see topic 13.
- **DNS / Anycast** — the routing layer that steers users to the nearest PoP.
- **Edge compute (Workers / Lambda@Edge / Fastly Compute)** — running logic at the PoP.

## 14. Cheat Sheet

> [!TIP]
> **CDN in 60 seconds**
> - A CDN = distributed **reverse-proxy caches** at **PoPs** near users; **Anycast** routes to the nearest.
> - **Hit** serves from edge; **miss** fills from origin. Target **`>90%` hit ratio** — the headline metric.
> - **Pull** = lazy fill (default). **Push** = pre-warmed uploads (big stable files).
> - Control with `Cache-Control`/`s-maxage`; add `stale-while-revalidate` + `stale-if-error` for latency + availability.
> - **Invalidate** via content-hashed URLs (best — no purge) or **tag purge**; avoid wildcard "purge everything" (origin stampede).
> - **Origin shielding** + request coalescing stop cache stampedes at scale.
> - Dynamic: **micro-cache** `1–5 s` + **edge compute** for personalization. Never cache auth'd responses without `private`/`no-store`.

**References:** Cloudflare Learning Center "What is a CDN?", Fastly "Caching & purging" docs, AWS CloudFront developer guide, MDN "HTTP caching" (`Cache-Control`, `ETag`)

---
*System Design Handbook — topic 11.*
