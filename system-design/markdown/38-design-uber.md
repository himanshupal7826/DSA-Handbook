# 38 · Design: Ride-Hailing (Uber)

> **In one line:** Ingest millions of moving GPS pings into a geospatial index, answer "nearest available drivers to this rider" in milliseconds, and drive a stateful trip through match → pickup → dropoff → pay.

---

## 1. Problem & Requirements

Build Uber/Lyft: riders request a ride, the system finds nearby available drivers, matches one, tracks the trip live on both maps, computes ETA and fare (with surge), and closes out payment.

**Functional**

- **Driver location ingestion**: drivers stream GPS every ~4 s while online.
- **Nearby query**: given a rider's location, return available drivers within radius R, ranked.
- **Matching/dispatch**: pick the best driver, offer the trip, handle accept/decline/timeout.
- **Trip lifecycle**: requested → matched → en-route-to-pickup → in-trip → completed → paid.
- **Real-time tracking**: rider sees the driver approach; driver sees the route. Live ETA.
- **Surge pricing**: raise price in supply-constrained areas to rebalance demand.
- **ETA & routing**: pickup ETA, trip ETA, fare estimate.

**Non-functional**

- **Scale**: ~5M active drivers, ~100M riders; millions of location updates/sec at peak.
- **Latency**: nearby query + match offer in **< 1–2 s** end-to-end; location ingest write **< 50 ms**.
- **Availability**: 99.99% — a rider mid-trip must never be dropped. City-level fault isolation.
- **Consistency**: a driver must be matched to **exactly one** trip (no double-dispatch). Trip state is strongly consistent; driver *location* can be eventually consistent (a 4 s stale ping is fine).
- **Geo-distributed**: run per-region; a trip is local to a city/market.

## 2. Capacity Estimation

```text
Drivers online (peak):   ~3M concurrently
Location update interval: every 4 s
  location writes/s = 3M / 4                 ≈ 750k updates/s  (peak 2-3M/s)
  each ping ~ {driver_id, lat, lng, ts, status} ~ 64 B
  ingest bw = 2M/s * 64B                     ≈ 128 MB/s

Rider requests:
  ~20M trips/day → 230 req/s avg, peak (rush hr, 10x) ≈ 2.3k req/s
  each request → 1 nearby-query over the geo index

Nearby query cost:
  scan candidate cells (geohash/S2) → ~tens to low-hundreds of drivers
  must return in < 50 ms → index MUST be in memory (Redis / in-mem grid)

Geo index memory:
  3M drivers * ~100 B (id, pos, cell, status) ≈ 300 MB per full copy (tiny!)
  → shard by city; each city fits easily in RAM, replicate for HA

Trip storage:
  20M trips/day * ~2 KB (states, waypoints, fare)  ≈ 40 GB/day
  location history (for replay/analytics): 750k/s * 64B ≈ 4 TB/day → data lake, tiered

Real-time push:
  during a trip, driver location pushed to rider ~ every few s over a socket
  concurrent trips (peak) ~ 1M → 1M sockets on the tracking tier
```

Punchline: the geo index is **small (fits in RAM) but written insanely fast** — the design centers on a sharded in-memory geospatial index, not disk.

## 3. API Design

```text
# --- Driver (persistent connection for pings + dispatch offers) ---
POST /v1/drivers/location      {driver_id, lat, lng, heading, status}   # ~every 4s
                               -> 200 (fire-and-forget-ish)
WS   dispatch offers pushed:   OFFER {trip_id, pickup, rider, expires_in}
POST /v1/drivers/offer/{trip_id}/respond  {accept|decline}

# --- Rider ---
POST /v1/rides/estimate        {pickup, dropoff, product}  -> {eta_s, fare_low, fare_high, surge}
POST /v1/rides/request         {rider_id, pickup, dropoff, product}     -> {trip_id, status}
GET  /v1/rides/{trip_id}                                    -> {status, driver_loc, eta_s}
WS   trip updates pushed:      TRIP_UPDATE {status, driver_loc, eta_s}
POST /v1/rides/{trip_id}/cancel

# --- Internal ---
GET  /internal/nearby          {lat, lng, radius, product}  -> [driver_id, dist, eta]  # geo svc
```

Driver location is a **high-frequency write** — fire-and-forget to an ingest tier, not a synchronous API. Dispatch offers and trip updates are **pushed over a persistent connection** (like the chat system) because latency matters.

## 4. Data Model

```text
# --- Live geo index (HOT, in-memory) — "who is where, right now" ---
# Store: Redis (GEO / sorted sets) or a custom in-memory grid, sharded by city.
driver_loc:  driver_id -> {lat, lng, cell_id(geohash/S2), status, updated_at}
cell_index:  cell_id   -> set<driver_id>            # reverse: drivers in a cell
# status ∈ {available, on_offer, on_trip, offline}

# --- Trip state (STRONGLY consistent) ---
# Store: SQL / Spanner-like, sharded by city. This is the source of truth.
trips: trip_id (PK) | rider_id | driver_id | status | product
       | pickup(lat,lng) | dropoff | requested_at | matched_at | started_at
       | ended_at | fare | surge_mult | route_polyline
# status ∈ requested|matched|arriving|in_trip|completed|cancelled

# --- Driver / rider profiles. Store: SQL. ---
drivers: driver_id | vehicle | rating | home_city | current_status
riders:  rider_id  | payment_method | rating

# --- Surge state (per geo cell, short TTL). Store: Redis/in-mem. ---
surge:  cell_id -> {multiplier, demand, supply, updated_at}   TTL ~1-2 min

# --- Location history (cold, for replay/analytics/ML). Store: data lake (Kafka->S3). ---
```

Rationale: **hot location data lives in memory** (queried in ms, cheap to lose — the next ping in 4 s rebuilds it). **Trip state is in a strongly-consistent store** because double-dispatch or a lost trip is unacceptable. Two very different stores for two very different consistency needs.

## 5. High-Level Design

Location ingestion, the geo index, matching, and trip management are separate services. Ingestion absorbs the write firehose; the geo service answers nearby queries; the dispatch/match service turns a request into an accepted offer; the trip service owns the state machine.

```svg
<svg viewBox="0 0 800 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12.5">
  <defs>
    <marker id="a" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <!-- driver -->
  <rect x="20" y="40" width="110" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="75" y="62" text-anchor="middle" fill="#1e293b">Driver app</text>
  <text x="75" y="78" text-anchor="middle" fill="#64748b">pings 4s</text>
  <!-- rider -->
  <rect x="20" y="330" width="110" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="75" y="352" text-anchor="middle" fill="#1e293b">Rider app</text>
  <text x="75" y="368" text-anchor="middle" fill="#64748b">request</text>

  <!-- ingest -->
  <rect x="175" y="40" width="120" height="50" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="235" y="62" text-anchor="middle" fill="#1e293b">Location ingest</text>
  <text x="235" y="78" text-anchor="middle" fill="#64748b">(stateless)</text>

  <!-- geo index -->
  <rect x="345" y="40" width="130" height="60" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="410" y="62" text-anchor="middle" fill="#1e293b">Geo index</text>
  <text x="410" y="78" text-anchor="middle" fill="#64748b">in-mem, sharded</text>
  <text x="410" y="93" text-anchor="middle" fill="#64748b">by city (S2/geohash)</text>

  <!-- dispatch -->
  <rect x="345" y="200" width="130" height="60" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="410" y="222" text-anchor="middle" fill="#1e293b">Dispatch /</text>
  <text x="410" y="238" text-anchor="middle" fill="#1e293b">Matching</text>
  <text x="410" y="253" text-anchor="middle" fill="#64748b">nearby + offer</text>

  <!-- trip svc -->
  <rect x="530" y="200" width="120" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="590" y="222" text-anchor="middle" fill="#1e293b">Trip service</text>
  <text x="590" y="238" text-anchor="middle" fill="#64748b">state machine</text>
  <rect x="530" y="290" width="120" height="44" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="590" y="312" text-anchor="middle" fill="#1e293b">Trip DB</text>
  <text x="590" y="327" text-anchor="middle" fill="#64748b">(strong)</text>

  <!-- surge / pricing -->
  <rect x="530" y="40" width="120" height="50" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="590" y="62" text-anchor="middle" fill="#1e293b">Surge/Pricing</text>
  <text x="590" y="78" text-anchor="middle" fill="#64748b">per-cell</text>

  <!-- eta -->
  <rect x="680" y="200" width="100" height="60" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="730" y="226" text-anchor="middle" fill="#1e293b">ETA/Routing</text>
  <text x="730" y="242" text-anchor="middle" fill="#64748b">road graph</text>

  <line x1="130" y1="63" x2="175" y2="63" stroke="#475569" marker-end="url(#a)"/>
  <line x1="295" y1="65" x2="345" y2="68" stroke="#475569" marker-end="url(#a)"/>
  <line x1="130" y1="352" x2="345" y2="245" stroke="#475569" marker-end="url(#a)"/>
  <text x="200" y="320" fill="#64748b">request</text>
  <line x1="410" y1="200" x2="410" y2="100" stroke="#475569" marker-end="url(#a)"/>
  <text x="418" y="150" fill="#64748b">nearby query</text>
  <line x1="475" y1="230" x2="530" y2="230" stroke="#475569" marker-end="url(#a)"/>
  <line x1="590" y1="260" x2="590" y2="290" stroke="#475569" marker-end="url(#a)"/>
  <line x1="475" y1="215" x2="530" y2="80" stroke="#475569" stroke-dasharray="4 4" marker-end="url(#a)"/>
  <line x1="650" y1="230" x2="680" y2="230" stroke="#475569" marker-end="url(#a)"/>
  <line x1="475" y1="240" x2="130" y2="360" stroke="#059669" marker-end="url(#a)"/>
  <text x="260" y="285" fill="#059669">OFFER / TRIP_UPDATE (push)</text>
</svg>
```

**Request flow**: rider requests → dispatch asks the **geo index** for nearby available drivers → ranks by ETA → sends an **OFFER** to the best driver (push) → on accept, the **trip service** atomically creates the trip and flips the driver to `on_trip` → live location streams to the rider until dropoff → fare + payment.

## 6. Deep Dive

### 6.1 Geospatial indexing — the crux

"Find drivers near (lat, lng)" over 3M moving points in < 50 ms. A naive `WHERE dist < R` scans everyone — impossible. We bucket the world into **cells** and only scan the rider's cell + neighbors.

| Technique | Idea | Trade-off |
|---|---|---|
| **Geohash** | Interleave lat/lng bits into a base32 string; a prefix = a rectangular cell | Simple, string-prefix range queries; but cell sizes distort near poles and neighbors can share short prefixes awkwardly |
| **Quadtree** | Recursively subdivide space; dense areas subdivide deeper | Adapts to density (dense downtown vs empty desert); but rebalancing a tree under a write firehose is costly |
| **S2 (Google)** | Project sphere onto a cube, Hilbert curve → 64-bit cell ids at 30 levels | Uniform-ish cells, great neighbor math, range queries on a 1-D curve; Uber's H3 (hexagons) is the successor |

**How the nearby query works**: compute the rider's cell at a chosen level; take that cell + its ring of neighbors (a geohash prefix set / S2 cell cover of the radius); union the driver sets in those cells; filter to `status=available` + product; compute real ETA (not straight-line) for the top candidates; return ranked.

The index is **updated on every ping**: a driver moving from cell A to cell B is removed from A's set and added to B's — cheap in-memory set ops in Redis (`GEOADD`) or a custom grid. Shard the whole index **by city/region** so each shard is small and hot-local; a trip never spans shards.

### 6.2 Location ingestion at the firehose

2–3M writes/s of ephemeral data. Rules:

- **Don't put pings in a durable DB synchronously** — they'd overwhelm it and they're worthless in 4 s. Write straight to the in-memory geo index; async-fork a copy to **Kafka** for history/ML.
- **Stateless ingest tier** behind an LB; drivers may connect via a persistent socket (to also receive offers) or POST.
- **Debounce/aggregate**: a stationary driver's pings can be coalesced; only cell *changes* need index updates.
- **Backpressure**: if the geo shard is hot, shed or sample pings — a slightly staler position is acceptable; dropping a match is not.

### 6.3 Matching / dispatch & the exactly-once constraint

Matching must guarantee **one driver ↔ one trip**. The race: two riders request simultaneously and both get offered the same nearby driver.

1. Dispatch selects candidate(s) from the geo index and **atomically marks the chosen driver `on_offer`** (a CAS/compare-and-set in Redis or a conditional update) so no other request offers them.
2. Send the **OFFER** with a short expiry (e.g. 15 s). On **accept**, the **trip service** performs a **transactional** create: `INSERT trip ... WHERE driver still on_offer` → flips driver to `on_trip`. On **decline/timeout**, revert to `available` and offer the next candidate.
3. **Batch matching (Uber's model)**: rather than greedy first-come dispatch, collect requests + drivers over a short window and solve a **global assignment** (bipartite matching minimizing total pickup ETA) — better city-wide outcomes than greedy. Trades a ~seconds of latency for efficiency.

The **trip state machine** lives in a strongly consistent store — `requested → matched → arriving → in_trip → completed`. State transitions are idempotent and guarded so retries can't double-advance.

```svg
<svg viewBox="0 0 780 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12.5">
  <defs>
    <marker id="d" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="70" y="26" text-anchor="middle" fill="#1e293b">Rider</text>
  <text x="255" y="26" text-anchor="middle" fill="#1e293b">Dispatch</text>
  <text x="430" y="26" text-anchor="middle" fill="#1e293b">Geo index</text>
  <text x="620" y="26" text-anchor="middle" fill="#1e293b">Driver</text>
  <line x1="70" y1="36" x2="70" y2="285" stroke="#cbd5e1"/>
  <line x1="255" y1="36" x2="255" y2="285" stroke="#cbd5e1"/>
  <line x1="430" y1="36" x2="430" y2="285" stroke="#cbd5e1"/>
  <line x1="620" y1="36" x2="620" y2="285" stroke="#cbd5e1"/>

  <line x1="70" y1="60" x2="255" y2="60" stroke="#475569" marker-end="url(#d)"/>
  <text x="160" y="53" text-anchor="middle" fill="#64748b">request(pickup,dropoff)</text>
  <line x1="255" y1="90" x2="430" y2="90" stroke="#475569" marker-end="url(#d)"/>
  <text x="342" y="83" text-anchor="middle" fill="#64748b">nearby(cell + neighbors)</text>
  <line x1="430" y1="120" x2="255" y2="120" stroke="#059669" marker-end="url(#d)"/>
  <text x="342" y="113" text-anchor="middle" fill="#059669">candidates ranked by ETA</text>
  <line x1="255" y1="150" x2="430" y2="150" stroke="#b91c1c" marker-end="url(#d)"/>
  <text x="342" y="143" text-anchor="middle" fill="#b91c1c">CAS driver → on_offer</text>
  <line x1="255" y1="182" x2="620" y2="182" stroke="#475569" marker-end="url(#d)"/>
  <text x="430" y="175" text-anchor="middle" fill="#64748b">OFFER (expires 15s)</text>
  <line x1="620" y1="214" x2="255" y2="214" stroke="#059669" marker-end="url(#d)"/>
  <text x="430" y="207" text-anchor="middle" fill="#059669">ACCEPT</text>
  <line x1="255" y1="246" x2="70" y2="246" stroke="#2563eb" marker-end="url(#d)"/>
  <text x="160" y="239" text-anchor="middle" fill="#2563eb">MATCHED: trip created (txn), live tracking begins</text>
</svg>
```

### 6.4 Surge pricing

Surge rebalances supply/demand per area. A job continuously computes, **per geo cell**, a demand/supply ratio (open requests vs available drivers over a short window) → a **multiplier** stored in Redis with a short TTL. The estimate/quote path reads the cell's multiplier. Design notes: **smooth** it (avoid oscillation / price whiplash), **cap** it, and **lock the quoted price** for a rider at request time (don't surge them mid-request). Surge is inherently eventually consistent and local.

### 6.5 ETA & routing

Straight-line distance is a lie in a city. Real ETA needs a **road graph** with live traffic. A routing service runs shortest-path (contraction hierarchies / precomputed) over the graph, adjusted by real-time speed data. Because full routing for every candidate is expensive, dispatch **pre-filters by haversine/cell distance**, then computes true ETA only for the top few candidates. ETA is served during pickup and trip for the live map.

## 7. Bottlenecks & Scaling

- **Location write firehose**: sharded stateless ingest + in-memory index; coalesce stationary pings; async-fork to Kafka; backpressure/sample under load.
- **Geo index hot shards (dense cities)**: shard by city, then sub-shard hot downtowns; adaptive cell depth (quadtree/H3) so dense areas subdivide; replicate shards for read scaling + HA.
- **Nearby query latency**: keep index in RAM; bound candidate set (cap per cell); compute true ETA only for top-K.
- **Dispatch contention / double-dispatch**: CAS on driver status + transactional trip create; short offer expiry; batch matching to reduce thrash.
- **Trip DB writes**: shard by city/market (trips are local); state machine is low-QPS relative to pings.
- **Real-time tracking fan-out**: 1M concurrent trip sockets — a connection tier like the chat system; push driver location to the paired rider only.
- **Cross-region isolation**: run each city/region independently so an outage is contained; global services (payments, profiles) are separate.

## 8. Failure Scenarios

| Failure | Blast radius | Mitigation |
|---|---|---|
| Geo index shard down | Can't match in that city | Replicated shards w/ failover; next ping (4 s) rebuilds state; degrade to wider-radius search on a replica |
| Driver location stale/lost ping | Slightly wrong position, worse match | Tolerable (4 s cadence); mark stale after N missed pings → drop from available set |
| Double-dispatch race | Two riders get same driver | Atomic CAS to `on_offer` + transactional trip create guarded by driver status |
| Driver declines/times out | Rider waits | Offer next-best candidate immediately; expand radius; batch re-match |
| Trip DB unavailable | Can't create/advance trips | Strongly-consistent multi-AZ store w/ failover; queue transitions; never lose an in-progress trip |
| Surge job lag/oscillation | Wrong/whiplash pricing | Smooth + cap multiplier; short TTL; lock quoted price at request time |
| Payment failure at trip end | Unpaid completed trip | Trip completes regardless; async ret/dunning; decouple payment from trip closure |
| Region-wide outage | One city down | City-level fault isolation; other markets unaffected; DR failover per region |

## 9. Trade-offs & Alternatives

- **Geohash vs quadtree vs S2/H3**: geohash is dead simple (string prefixes) but has boundary + distortion quirks; quadtree adapts to density but is costly to rebalance under writes; **S2/H3** give uniform cells + great neighbor math — Uber built **H3 (hexagons)** for exactly this. Choose S2/H3 at scale.
- **Greedy vs batch matching**: greedy (offer nearest instantly) is lowest latency per request but globally suboptimal and thrashy; **batch/window matching** solves a city-wide assignment for better total ETA and fewer declines, at a few seconds of latency. Uber moved to batching.
- **In-memory geo index vs geo-database**: an in-memory sharded grid (Redis/custom) hits the <50 ms bar; PostGIS/Elasticsearch geo is fine at small scale but won't take 2M writes/s. Ephemeral-in-RAM + async durable log is the pattern.
- **Location durability**: pings are *not* persisted synchronously — losing one is harmless. This is the key insight that makes the write firehose affordable.
- **Consistency split**: driver *location* eventually consistent (cheap, fast); *trip state* strongly consistent (correctness). Applying one model to both would be either too slow or too risky.
- **At 10×**: sub-shard hot cities further, push matching to the edge/region, and adopt hierarchical H3 with adaptive resolution.

## 10. Interview Follow-ups

**Q: How do you find nearby drivers without scanning all 3M?**
A: Bucket the world into **cells** (geohash / S2 / H3). Compute the rider's cell, scan only that cell + its neighbor ring, union the drivers there, filter to available, then rank the top few by true ETA. O(drivers in a few cells), not O(all).

**Q: Geohash vs quadtree vs S2 — when do you pick which?**
A: Geohash for simplicity/prefix queries; quadtree when density varies wildly and you want adaptive depth; **S2/H3** at scale for uniform cells + clean neighbor math + 1-D range queries on a space-filling curve. Uber uses H3.

**Q: You get 2M location updates/sec. Where do they go?**
A: Straight into the **in-memory geo index** (a driver moving cells is a set remove+add), plus an **async fork to Kafka** for history/ML. Never a synchronous durable DB write — pings are ephemeral and worthless in 4 s.

**Q (senior): Two riders request at the same instant and the nearest driver is the same. How do you prevent double-dispatch?**
A: **Atomically CAS the driver's status to `on_offer`** before sending an offer, so only one request can claim them. The accept then does a **transactional trip create guarded by that status**. Decline/timeout reverts to available. Exactly-once by construction.

**Q: Why not persist driver locations durably?**
A: They're **ephemeral** — the next ping (4 s) supersedes them, and losing one barely affects match quality. Persisting 2M/s synchronously would need a huge, pointless durable-write tier. Keep them in RAM; async-log for analytics.

**Q (senior): Greedy nearest-driver dispatch vs batch matching — trade-offs?**
A: Greedy is instant but globally suboptimal and causes declines/thrash. **Batch matching** collects requests+drivers over a short window and solves a bipartite assignment minimizing total pickup ETA — better city-wide efficiency, at the cost of a few seconds latency. Preferred at scale.

**Q: How does surge pricing work without oscillating wildly?**
A: Per-cell demand/supply ratio over a short window → a **multiplier** in Redis with short TTL. **Smooth** and **cap** it to avoid whiplash, and **lock the quoted price** at request time so a rider isn't surged mid-request.

**Q: How is ETA computed — surely not straight-line?**
A: A **routing service** runs shortest-path over a road graph adjusted by live traffic. Dispatch pre-filters candidates by cheap cell/haversine distance, then computes true road ETA only for the top-K — full routing per candidate is too expensive.

**Q (senior): A downtown cell has 50k drivers at rush hour — the shard is on fire. What do you do?**
A: **Sub-shard** the hot cell (finer H3 resolution / split the city shard), replicate for read scaling, cap candidates returned per query, and coalesce stationary pings. Adaptive cell depth means dense areas subdivide automatically.

**Q: How do you keep the rider's map updated live during pickup?**
A: A **stateful tracking tier** (like the chat connection servers) holds a socket per active trip and **pushes** the paired driver's location every few seconds, plus recomputed ETA — 1:1, only to that rider.

**Q (staff): How do you isolate failures so one city's outage doesn't take down everything?**
A: **Run each market/region independently** — its own geo shards, dispatch, and trip store. Global services (payments, identity) are separate and resilient. A regional failure is contained; DR failover is per region.

**Q (staff): Payment fails when the trip ends. What happens to the trip?**
A: The trip **completes regardless** — payment is decoupled and handled asynchronously with retries/dunning. Blocking trip closure on payment would strand drivers and riders. Reconcile out-of-band.

## 11. Cheat Sheet

> [!TIP]
> **Ride-hailing (Uber) in one screen.**
> - **Geo index is the crux**: bucket the world into cells (**geohash / S2 / H3**); nearby query scans rider's cell + neighbors only. Keep it **in RAM**, sharded by city.
> - **Location firehose**: 2M+ pings/s → straight to in-mem index (cell remove+add) + async Kafka fork. **Never persist pings synchronously** — they're ephemeral.
> - **Consistency split**: driver *location* eventually consistent (fast); *trip state* strongly consistent (a state machine in SQL/Spanner).
> - **No double-dispatch**: CAS driver → `on_offer`, then transactional trip create guarded by status.
> - **Matching**: batch/window assignment (min total pickup ETA) beats greedy at scale.
> - **Surge**: per-cell demand/supply → multiplier (Redis, short TTL); smooth, cap, lock quote.
> - **ETA**: road-graph routing on top-K candidates, not straight-line for all.
> - **Isolation**: per-city/region; a trip never spans shards; outages are contained.

**References:** Uber Engineering — "H3: Hexagonal Hierarchical Spatial Index", "Engineering Real-Time Marketplace (DISCO dispatch)"; Google S2 Geometry library docs; "Designing Uber" (ByteByteGo); DDIA ch.5–6 (replication & partitioning).

---

*System Design Handbook — topic 38.*
