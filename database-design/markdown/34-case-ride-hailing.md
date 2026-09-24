# 34 · Case Study: Uber-like Ride Storage

> **In one line:** A ride-hailing data layer is two planes with opposite physics — a firehose of driver locations that is worthless after a few seconds and must never be written row-by-row into a relational database, and a comparatively tiny stream of trips and payments that must be exactly right — so you keep locations in an in-memory geo index with sampled history streamed to cheap storage, and keep trips in a city-partitioned relational store where one conditional transaction binds exactly one driver to exactly one trip.

---

## 1. Overview

> **Builds on:** [System Design · Design Uber](../system-design/topic.html?p=38-design-uber) (the whole system: APIs, dispatch, ETA, surge) · [SQL Handbook · Transactions & ACID](../sql/topic.html?p=25-transactions-acid) · [Ch 04 · Concurrency Control](topic.html?p=04-concurrency-control) · [Ch 11 · Partitioning](topic.html?p=11-partitioning) · [Ch 12 · Sharding](topic.html?p=12-sharding). The system-design chapter covers the end-to-end architecture; this chapter zooms into the **data layer** — which store holds what, the schema, the matching transaction, and how each store is sized, partitioned and operated.

A rider opens the app and sees cars moving on a map. They request a ride; within seconds one nearby driver is offered the trip, accepts, drives to the pickup, completes the trip, and the rider is charged. Behind that are two completely different data problems that beginners routinely merge into one.

The **location plane**: every online driver's phone sends its GPS position every ~4 seconds. With a million drivers online at peak, that is a quarter of a million writes per second, each of which *supersedes* the previous one for the same driver. Almost nobody will ever read a specific old ping, and the current value is stale four seconds after it lands. The access pattern is "which available drivers are within 2 km of this point, right now?" — a geospatial nearest-neighbour query over constantly moving points.

The **trip plane**: a trip is created, matched, started, completed, paid. Twenty million trips a day is only a few hundred per second, but every one carries money and safety records and must obey hard invariants: a driver cannot be on two trips, a trip cannot have two drivers, a completed trip cannot be un-completed, and the fare charged must match the trip record. This is classic OLTP and belongs in a relational store with transactions.

The naive design — a `driver_locations` table in PostgreSQL with `UPDATE ... SET lat, lng` on every ping and a PostGIS `ST_DWithin` query for matching — works in a pilot city and collapses in production for reasons section 3 makes concrete.

### Requirements

**Functional:** ingest driver locations; show nearby cars to riders; find candidate drivers for a request; offer and accept trips; track trip state and route; compute fare; charge; trip history for riders and drivers; support safety/dispute investigations (where exactly was the car at 22:14?).

**Non-functional:**

- **One driver ↔ one active trip**, and **one trip ↔ at most one driver** — never violated, even with concurrent dispatchers and flaky phone networks.
- Matching latency: candidate lookup p99 < 50 ms.
- Location freshness: a driver's position in the index is at most ~5–10 s old; losing the index loses nothing that the next pings do not rebuild.
- Trip and payment records: durable (RPO ≈ 0), retained for years (regulators, disputes).
- Regional: each city's data served from a nearby region; one city's outage does not affect others.

### Workload estimate

| Quantity | Estimate | Reasoning |
|---|---|---|
| Drivers online at peak (global) | ~1 M | across ~600 cities |
| Location pings | ~250,000/s | 1 M ÷ 4 s |
| Ping payload | ~100 B | driver id, lat, lng, heading, speed, accuracy, ts |
| Raw ping volume | ~25 MB/s ≈ 2 TB/day | before compression |
| Nearby-driver queries | ~50,000/s | rider app map refresh + dispatch candidates |
| Trips | ~20 M/day ≈ 230/s avg, ~1,500/s peak | Friday night, New Year's Eve spikes higher |
| Trip state transitions | ~8–10 per trip ≈ 15,000/s peak | requested, offered, accepted, arrived, started, completed... |
| Trip record size | ~2–3 KB incl. events and indexes | plus a sampled route |
| Trip data growth | ~50 GB/day, ~18 TB/year | before archival |
| Largest single city | ~5–8% of global traffic | the unit you size a shard for |

The two planes differ by roughly **two orders of magnitude in write rate** and in the **value of each write**. That gap is the whole design ([Ch 22 · Capacity Planning](topic.html?p=22-capacity-planning)).

## 2. Core Concepts

- **Location ping** — `(driver_id, lat, lng, ts, ...)`. Superseded by the next ping. *Why it matters:* last-write-wins on a key, not a history you query.
- **Geo index** — a structure answering "points near X". Options: Redis GEO (a sorted set keyed by 52-bit geohash scores), an in-memory grid of **H3** hexagonal cells or S2 cells, or PostGIS/GiST. *Why it matters:* cell-based indexes turn nearest-neighbour into "look up a handful of cells".
- **H3 cell** — Uber's open-source hierarchical hexagonal grid; at resolution 8 a cell is roughly 0.7 km². *Why it matters:* a cell id is a plain integer key you can shard and aggregate by (supply, demand, surge).
- **Driver supply state** — `OFFLINE`, `AVAILABLE`, `OFFERED`, `ON_TRIP`. Lives in two places: a fast copy in the geo index (for filtering candidates) and the authoritative copy in the trip store (for the matching transaction).
- **Trip** — the durable record. *Invariant R1:* at most one active trip per driver. *Invariant R2:* at most one driver per trip. *Invariant R3:* status only moves along allowed edges.
- **Trip event** — an append-only row per transition, with a client-generated event id. *Invariant R4:* a retried driver-app action is applied once.
- **Offer** — a time-limited proposal of a trip to a driver (~15 s). Accept is the moment of truth.
- **Guarded transition** — `UPDATE ... WHERE status = <expected>`, the compare-and-swap from [Ch 04 · Concurrency Control](topic.html?p=04-concurrency-control).
- **City shard** — the partition of trip data by city (or region cluster of cities). *Why it matters:* matching never crosses cities, so the shard key aligns with the transaction boundary.
- **Sampled route** — the trip's path, kept at a lower rate (every ~10–15 s, plus key events) for fare and disputes; the full-resolution ping stream goes to cold storage.

## 3. Theory & Principles

### Access patterns, ranked

| # | Access pattern | Peak rate | Consistency | Store |
|---|---|---|---|---|
| 1 | Write driver location | 250,000/s | last-write-wins, loss OK | in-memory geo index (Redis GEO / H3 grid), per city |
| 2 | Nearby available drivers around a point | 50,000/s | seconds-stale OK | same geo index |
| 3 | Append ping to history | 250,000/s | durable-ish, async | Kafka → object storage (Parquet) |
| 4 | Trip state transitions | 15,000/s | **strong, guarded** | Postgres (city shard) |
| 5 | Match driver ↔ trip (accept) | 1,500/s | **strong, atomic across two rows** | Postgres (city shard) |
| 6 | Active trip read (rider/driver apps poll) | 30,000/s | read-your-writes for participants | primary or cache invalidated by events |
| 7 | Trip history by rider / driver | 3,000/s | stale OK | user-keyed read model (Cassandra/DynamoDB) or replicas |
| 8 | "Where was car X at 22:14 on date D?" | rare | complete, not fast | object storage query (Athena/Trino) |

### Why pings must not go into Postgres row-by-row

Put the numbers against PostgreSQL's mechanics ([Ch 03 · MVCC](topic.html?p=03-mvcc), [Ch 07 · Write-Ahead Logging](topic.html?p=07-write-ahead-logging)):

- **Every UPDATE writes a new tuple version.** 250,000 updates/s produce 250,000 dead tuples/s on a 1-million-row table. Autovacuum has to reclaim the whole table's worth of dead versions every few seconds — it will not keep up, and the table and its indexes bloat.
- **A geo index defeats HOT updates.** A GiST index on the location column changes on every ping, so no update is HOT; every ping also writes an index entry.
- **WAL volume.** Each update logs the new tuple and index changes, plus full-page images after each checkpoint — on the order of hundreds of MB/s of WAL for data nobody will ever recover. Replicas lag, and backups and PITR archives fill with noise.
- **Wrong durability.** You would be paying fsync-on-commit durability for values whose useful life is four seconds.

Batching into one multi-row UPDATE per second per city reduces the transaction count, not the version churn. The right move is to change *stores*: an in-memory index for "now", and an append-only log for "history". Postgres is excellent for the trip plane precisely because it is spared the location plane.

### The matching race

Two things can go wrong at the instant of matching: two dispatchers offer the same driver two trips (both think the driver is available because the geo index is seconds stale), or the rider's request is retried and two drivers are offered the same trip. The fix is a single transaction that flips **both** rows with guarded updates, backed by partial unique indexes.

```svg
<svg viewBox="0 0 860 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs><marker id="c34a1" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#334155"/></marker></defs>
  <text x="430" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Driver D7 is offered trips T1 and T2 by two dispatchers; both accepts race</text>
  <line x1="150" y1="50" x2="150" y2="395" stroke="#94a3b8"/><line x1="430" y1="50" x2="430" y2="395" stroke="#94a3b8"/><line x1="710" y1="50" x2="710" y2="395" stroke="#94a3b8"/>
  <text x="150" y="45" text-anchor="middle" fill="#1e293b" font-weight="bold">Accept T1 (txn A)</text>
  <text x="430" y="45" text-anchor="middle" fill="#1e293b" font-weight="bold">driver_state D7 / trips rows</text>
  <text x="710" y="45" text-anchor="middle" fill="#1e293b" font-weight="bold">Accept T2 (txn B)</text>
  <rect x="30" y="70" width="240" height="48" rx="5" fill="#ffffff" stroke="#16a34a"/>
  <text x="150" y="88" text-anchor="middle" fill="#334155">UPDATE driver_state SET ON_TRIP, trip=T1</text>
  <text x="150" y="104" text-anchor="middle" fill="#166534">WHERE D7 AND status IN (AVAIL, OFFERED)</text>
  <rect x="350" y="80" width="160" height="30" rx="5" fill="#fef3c7" stroke="#d97706"/><text x="430" y="99" text-anchor="middle" fill="#78350f">D7 row locked by A</text>
  <path d="M270,94 L348,94" stroke="#334155" stroke-width="1.5" marker-end="url(#c34a1)"/>
  <rect x="590" y="120" width="240" height="48" rx="5" fill="#ffffff" stroke="#d97706"/>
  <text x="710" y="138" text-anchor="middle" fill="#334155">same UPDATE for T2</text>
  <text x="710" y="154" text-anchor="middle" fill="#92400e">blocks on A's row lock</text>
  <path d="M590,144 L512,100" stroke="#d97706" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#c34a1)"/>
  <rect x="30" y="140" width="240" height="48" rx="5" fill="#ffffff" stroke="#16a34a"/>
  <text x="150" y="158" text-anchor="middle" fill="#334155">UPDATE trips SET MATCHED, driver=D7</text>
  <text x="150" y="174" text-anchor="middle" fill="#166534">WHERE T1 AND status = OFFERED: 1 row</text>
  <rect x="30" y="210" width="240" height="30" rx="5" fill="#dcfce7" stroke="#16a34a"/><text x="150" y="229" text-anchor="middle" fill="#14532d" font-weight="bold">COMMIT (about 2 ms)</text>
  <rect x="350" y="250" width="160" height="40" rx="5" fill="#dbeafe" stroke="#2563eb"/><text x="430" y="266" text-anchor="middle" fill="#1e3a8a">D7: ON_TRIP, trip = T1</text><text x="430" y="281" text-anchor="middle" fill="#1e3a8a">T1: MATCHED, driver = D7</text>
  <rect x="590" y="250" width="240" height="48" rx="5" fill="#ffffff" stroke="#dc2626"/>
  <text x="710" y="268" text-anchor="middle" fill="#334155">wakes; re-checks WHERE on new version</text>
  <text x="710" y="284" text-anchor="middle" fill="#991b1b">status = ON_TRIP: 0 rows</text>
  <rect x="590" y="310" width="240" height="48" rx="5" fill="#fee2e2" stroke="#dc2626"/>
  <text x="710" y="328" text-anchor="middle" fill="#991b1b" font-weight="bold">ROLLBACK</text>
  <text x="710" y="344" text-anchor="middle" fill="#991b1b">T2 re-dispatched to next candidate</text>
  <rect x="30" y="300" width="240" height="80" rx="5" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="150" y="320" text-anchor="middle" fill="#5b21b6" font-weight="bold">Backstops (never fire normally)</text>
  <text x="150" y="338" text-anchor="middle" fill="#5b21b6" font-size="10">UNIQUE (driver_id) WHERE active</text>
  <text x="150" y="354" text-anchor="middle" fill="#5b21b6" font-size="10">UNIQUE (rider_id) WHERE active</text>
  <text x="150" y="370" text-anchor="middle" fill="#5b21b6" font-size="10">on trips: R1 even if code is wrong</text>
</svg>
```

Both rows live in the same city shard, so this is a local transaction — no 2PC, no saga. That co-location is the main reason the shard key is **city**, not driver id or trip id: the matching transaction is the one that needs atomicity, and it always involves one driver and one trip in the same city.

### Consistency boundaries

- **Strong:** driver supply state *as used for matching*, trip state, fare, payment handoff — all in the city's relational shard ([Ch 10 · Consistency Models](topic.html?p=10-consistency-models)).
- **Eventually consistent, loss-tolerant:** the geo index. It may say a driver is available who just accepted another trip; the matching transaction rejects that, and the index is corrected by the `DriverMatched` event within a second.
- **Eventually consistent, loss-intolerant:** ping history and trip history read models. Built from Kafka with at-least-once delivery and idempotent writes.

## 4. Architecture & Workflow

```svg
<svg viewBox="0 0 880 480" width="100%" height="480" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs><marker id="c34b1" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#d97706"/></marker><marker id="c34b2" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#16a34a"/></marker><marker id="c34b3" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#7c3aed"/></marker></defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Two data planes: location (fast, lossy) and trips (strong, durable)</text>
  <rect x="15" y="40" width="850" height="185" rx="10" fill="#fffbeb" stroke="#d97706"/>
  <text x="30" y="60" fill="#78350f" font-weight="bold">LOCATION PLANE  ~250,000 writes/s, value half-life ~4 s</text>
  <rect x="30" y="80" width="130" height="50" rx="6" fill="#ffffff" stroke="#94a3b8"/><text x="95" y="100" text-anchor="middle" fill="#1e293b">Driver apps</text><text x="95" y="116" text-anchor="middle" fill="#334155" font-size="9">ping every 4 s</text>
  <rect x="200" y="80" width="140" height="50" rx="6" fill="#ffffff" stroke="#d97706"/><text x="270" y="100" text-anchor="middle" fill="#78350f" font-weight="bold">Location gateway</text><text x="270" y="116" text-anchor="middle" fill="#92400e" font-size="9">validate, stamp city + H3</text>
  <path d="M160,105 L198,105" stroke="#d97706" stroke-width="2" marker-end="url(#c34b1)"/>
  <rect x="390" y="70" width="200" height="70" rx="6" fill="#fef3c7" stroke="#d97706"/><text x="490" y="90" text-anchor="middle" fill="#78350f" font-weight="bold">Geo index (per city)</text><text x="490" y="106" text-anchor="middle" fill="#92400e" font-size="9">Redis GEO or H3 cell sets in memory</text><text x="490" y="120" text-anchor="middle" fill="#92400e" font-size="9">last position + supply state, TTL 30 s</text><text x="490" y="134" text-anchor="middle" fill="#92400e" font-size="9">overwrite, never versioned</text>
  <path d="M340,100 L388,100" stroke="#d97706" stroke-width="2" marker-end="url(#c34b1)"/>
  <rect x="390" y="160" width="200" height="50" rx="6" fill="#ede9fe" stroke="#7c3aed"/><text x="490" y="180" text-anchor="middle" fill="#5b21b6" font-weight="bold">Kafka: driver-locations</text><text x="490" y="196" text-anchor="middle" fill="#5b21b6" font-size="9">key = driver_id, 7-day retention</text>
  <path d="M300,130 L388,180" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#c34b3)"/>
  <rect x="650" y="70" width="200" height="60" rx="6" fill="#f1f5f9" stroke="#94a3b8"/><text x="750" y="92" text-anchor="middle" fill="#1e293b">Rider map / dispatch</text><text x="750" y="108" text-anchor="middle" fill="#334155" font-size="9">GEOSEARCH or k-ring of H3 cells</text><text x="750" y="122" text-anchor="middle" fill="#334155" font-size="9">~50,000 queries/s</text>
  <path d="M648,100 L592,100" stroke="#d97706" stroke-width="1.5" marker-end="url(#c34b1)"/>
  <rect x="650" y="155" width="200" height="60" rx="6" fill="#f1f5f9" stroke="#94a3b8"/><text x="750" y="176" text-anchor="middle" fill="#1e293b">Object storage (Parquet)</text><text x="750" y="192" text-anchor="middle" fill="#334155" font-size="9">city/date/hour partitions</text><text x="750" y="206" text-anchor="middle" fill="#334155" font-size="9">disputes, ML, ETA training</text>
  <path d="M590,185 L648,185" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#c34b3)"/>
  <rect x="15" y="240" width="850" height="175" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="30" y="260" fill="#14532d" font-weight="bold">TRIP PLANE  ~15,000 writes/s, every write matters</text>
  <rect x="30" y="280" width="150" height="55" rx="6" fill="#dbeafe" stroke="#2563eb"/><text x="105" y="302" text-anchor="middle" fill="#1e3a8a" font-weight="bold">Trip service</text><text x="105" y="318" text-anchor="middle" fill="#1e3a8a" font-size="9">matching txn, transitions</text>
  <rect x="230" y="270" width="250" height="130" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="355" y="290" text-anchor="middle" fill="#14532d" font-weight="bold">Postgres, sharded by city</text>
  <rect x="245" y="300" width="105" height="22" rx="3" fill="#ffffff" stroke="#16a34a"/><text x="297" y="315" text-anchor="middle" fill="#14532d" font-size="9">driver_state</text>
  <rect x="360" y="300" width="105" height="22" rx="3" fill="#ffffff" stroke="#16a34a"/><text x="412" y="315" text-anchor="middle" fill="#14532d" font-size="9">trips (monthly)</text>
  <rect x="245" y="328" width="105" height="22" rx="3" fill="#ffffff" stroke="#16a34a"/><text x="297" y="343" text-anchor="middle" fill="#14532d" font-size="9">trip_events</text>
  <rect x="360" y="328" width="105" height="22" rx="3" fill="#ffffff" stroke="#16a34a"/><text x="412" y="343" text-anchor="middle" fill="#14532d" font-size="9">trip_route (sampled)</text>
  <rect x="245" y="356" width="220" height="22" rx="3" fill="#ffffff" stroke="#7c3aed"/><text x="355" y="371" text-anchor="middle" fill="#5b21b6" font-size="9">outbox</text>
  <text x="355" y="394" text-anchor="middle" fill="#166534" font-size="9">sync standby per shard; home region per city</text>
  <path d="M180,307 L228,307" stroke="#16a34a" stroke-width="2" marker-end="url(#c34b2)"/>
  <rect x="540" y="270" width="150" height="50" rx="6" fill="#ede9fe" stroke="#7c3aed"/><text x="615" y="290" text-anchor="middle" fill="#5b21b6" font-weight="bold">Kafka: trip-events</text><text x="615" y="306" text-anchor="middle" fill="#5b21b6" font-size="9">via outbox / CDC</text>
  <path d="M465,367 L540,305" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#c34b3)"/>
  <rect x="720" y="260" width="135" height="40" rx="6" fill="#f1f5f9" stroke="#94a3b8"/><text x="787" y="278" text-anchor="middle" fill="#1e293b">Payments ledger</text><text x="787" y="292" text-anchor="middle" fill="#334155" font-size="9">TripCompleted</text>
  <rect x="720" y="310" width="135" height="40" rx="6" fill="#f1f5f9" stroke="#94a3b8"/><text x="787" y="328" text-anchor="middle" fill="#1e293b">History by user</text><text x="787" y="342" text-anchor="middle" fill="#334155" font-size="9">Cassandra / DynamoDB</text>
  <rect x="720" y="360" width="135" height="40" rx="6" fill="#f1f5f9" stroke="#94a3b8"/><text x="787" y="378" text-anchor="middle" fill="#1e293b">Geo index update</text><text x="787" y="392" text-anchor="middle" fill="#334155" font-size="9">driver now ON_TRIP</text>
  <path d="M690,290 L718,282" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#c34b3)"/>
  <path d="M690,300 L718,328" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#c34b3)"/>
  <path d="M690,310 L718,375" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#c34b3)"/>
  <path d="M570,140 C 520,230 200,230 110,278" stroke="#2563eb" stroke-width="1.5" stroke-dasharray="4 3" fill="none" marker-end="url(#c34b2)"/>
  <text x="330" y="235" fill="#1e3a8a" font-size="9">candidates from geo index; truth checked in Postgres</text>
  <text x="20" y="445" fill="#1e293b" font-weight="bold">Location write:</text><text x="120" y="445" fill="#334155">gateway, then GEOADD/HSET (overwrite) and Kafka produce. No relational write per ping.</text>
  <text x="20" y="465" fill="#1e293b" font-weight="bold">Trip write:</text><text x="120" y="465" fill="#334155">guarded UPDATE on driver_state + trips in one city-shard txn, plus trip_events and outbox</text>
</svg>
```

### Location write path

The gateway receives a ping, computes the H3 cell and city, and does two things, neither of which touches the relational store:

1. **Overwrite the live index.** In Redis: `GEOADD drivers:{city}:available lng lat driver_id` (a sorted-set member whose score is a geohash) and `HSET driver:{id} lat .. lng .. ts .. status ..` with a 30 s `EXPIRE`, so a phone that goes silent drops out of the index automatically. Or, at larger scale, an in-memory service holding `h3_cell → set<driver_id>` per city, sharded across nodes by cell. Redis is typically sharded by city using hash tags (`{city}`) so a city's index lives on one shard — see [Caching with Redis · Redis Cluster](../redis-caching/topic.html?p=26-redis-cluster).
2. **Append to Kafka.** Produce to `driver-locations` keyed by `driver_id` (ordering per driver). A stream job writes Parquet files to object storage, partitioned by `city/date/hour`, compressing ~2 TB/day raw to a fraction of that. A second consumer samples active-trip pings every ~10–15 s into `trip_route` for fare calculation and the receipt map.

### Trip write path

```text
t=0     rider requests            INSERT trips (status='REQUESTED', rider, pickup, city)   -- unique active trip per rider
t=50ms  dispatch reads geo index -> 8 candidates within 2 km, AVAILABLE per index
t=60ms  offer to D7               UPDATE driver_state SET status='OFFERED', offer_trip=T, offer_expires=now()+15s
                                   WHERE driver_id=D7 AND status='AVAILABLE'        (0 rows -> next candidate)
                                  UPDATE trips SET status='OFFERED' WHERE id=T AND status IN ('REQUESTED','OFFERED')
t=6s    D7 taps accept            ONE TXN: driver_state OFFERED(T)->ON_TRIP, trips OFFERED->MATCHED(D7),
                                           trip_events(accepted, client_event_id), outbox(TripMatched)
t=4m    arrived / started         guarded transitions, each an event row
t=22m   completed                 fare computed from sampled route; trips -> COMPLETED; driver_state -> AVAILABLE;
                                  outbox(TripCompleted) -> payments ledger charges the rider
```

The offer step is itself a guarded write, so a driver cannot hold two live offers. If the driver ignores the offer, the dispatcher's timer (or a sweeper using `offer_expires`) moves the driver back to AVAILABLE with `WHERE status = 'OFFERED' AND offer_trip = T` — never unconditionally.

## 5. Implementation

### Trip-plane schema (per city shard)

```sql
CREATE TABLE driver_state (
  driver_id       BIGINT PRIMARY KEY,
  city_id         INT    NOT NULL,
  status          TEXT   NOT NULL DEFAULT 'OFFLINE'
                  CHECK (status IN ('OFFLINE','AVAILABLE','OFFERED','ON_TRIP')),
  offer_trip_id   BIGINT,
  offer_expires   TIMESTAMPTZ,
  current_trip_id BIGINT,
  version         BIGINT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status = 'OFFERED') = (offer_trip_id IS NOT NULL)),
  CHECK ((status = 'ON_TRIP') = (current_trip_id IS NOT NULL))
);
-- ~50k-80k rows per large city: tiny, hot, updated a few times per trip. Keep it narrow.
ALTER TABLE driver_state SET (fillfactor = 70);

CREATE TABLE trips (
  id              BIGINT NOT NULL,             -- Snowflake-style id: time-ordered, globally unique
  city_id         INT    NOT NULL,
  rider_id        BIGINT NOT NULL,
  driver_id       BIGINT,
  status          TEXT   NOT NULL DEFAULT 'REQUESTED' CHECK (status IN
                  ('REQUESTED','OFFERED','MATCHED','ARRIVING','IN_PROGRESS','COMPLETED','CANCELLED','NO_DRIVER')),
  product         TEXT   NOT NULL,             -- UberX, XL, ...
  pickup_lat      DOUBLE PRECISION NOT NULL,   -- coordinates are fine as floats; money is not
  pickup_lng      DOUBLE PRECISION NOT NULL,
  dropoff_lat     DOUBLE PRECISION,
  dropoff_lng     DOUBLE PRECISION,
  surge_mult      NUMERIC(4,2) NOT NULL DEFAULT 1.00,
  fare_minor      BIGINT,
  currency        CHAR(3) NOT NULL,
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  matched_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  version         INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id, requested_at)
) PARTITION BY RANGE (requested_at);           -- monthly; old months detach to archive

-- R1 / R2 backstops. Partial unique indexes on a partitioned table must include the
-- partition key, which would defeat them, so they live on a small side table instead:
CREATE TABLE active_trips (
  trip_id    BIGINT PRIMARY KEY,
  rider_id   BIGINT NOT NULL UNIQUE,           -- one active trip per rider
  driver_id  BIGINT UNIQUE                     -- one active trip per driver (NULLs allowed until matched)
);

CREATE INDEX trips_rider_time  ON trips (rider_id, requested_at DESC);
CREATE INDEX trips_driver_time ON trips (driver_id, requested_at DESC) WHERE driver_id IS NOT NULL;

CREATE TABLE trip_events (
  trip_id          BIGINT NOT NULL,
  seq              INT    NOT NULL,
  event_type       TEXT   NOT NULL,           -- OFFERED, ACCEPTED, ARRIVED, STARTED, COMPLETED, CANCELLED
  actor            TEXT   NOT NULL,           -- rider / driver / system
  client_event_id  UUID,                      -- R4: the phone's id for this action
  at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  lat DOUBLE PRECISION, lng DOUBLE PRECISION,
  PRIMARY KEY (trip_id, seq),
  UNIQUE (trip_id, client_event_id)           -- a retried "accept" or "start" applies once
);

CREATE TABLE trip_route (                     -- sampled every ~10-15 s during the trip
  trip_id   BIGINT NOT NULL,
  ts        TIMESTAMPTZ NOT NULL,
  lat       DOUBLE PRECISION NOT NULL,
  lng       DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (trip_id, ts)
);
```

The **`active_trips` side table** is a deliberate trick worth explaining in an interview. A unique index on a partitioned table must include the partition key, so `UNIQUE (driver_id) WHERE status IN (...)` on monthly-partitioned `trips` would only be unique *per month*. A tiny unpartitioned table containing only live trips (tens of thousands of rows per city) carries the uniqueness guarantees cheaply: insert on request, set `driver_id` on match, delete on completion or cancellation — in the same transactions as the `trips` changes.

The sampled route adds ~100–150 rows per trip. At 20 M trips/day that is on the order of 2–3 billion rows per day globally — too many for relational storage long-term. Keep it in Postgres only while the trip is active and for the dispute window, or write it straight to a wide-column store keyed by `trip_id` ([Cassandra · Primary Key, Partition & Clustering](../cassandra/topic.html?p=06-primary-key-partition-clustering)).

### Critical transaction: accept an offer

```sql
BEGIN;
-- Idempotency for the phone: a retried accept inserts nothing and we return the current state.
INSERT INTO trip_events (trip_id, seq, event_type, actor, client_event_id)
SELECT $trip, coalesce(max(seq), 0) + 1, 'ACCEPTED', 'driver', $client_event_id
  FROM trip_events WHERE trip_id = $trip
ON CONFLICT (trip_id, client_event_id) DO NOTHING
RETURNING seq;
-- no row => duplicate accept: COMMIT, return current trip state

-- Lock order: driver_state first, then trips, in every code path (avoids deadlocks with cancel).
UPDATE driver_state
   SET status = 'ON_TRIP', current_trip_id = $trip, offer_trip_id = NULL, offer_expires = NULL,
       version = version + 1, updated_at = now()
 WHERE driver_id = $driver AND status = 'OFFERED' AND offer_trip_id = $trip
   AND offer_expires > now();
-- 0 rows => offer expired or was withdrawn: ROLLBACK, tell the driver "offer no longer available"

UPDATE trips
   SET status = 'MATCHED', driver_id = $driver, matched_at = now(), version = version + 1
 WHERE id = $trip AND requested_at = $requested_at AND status = 'OFFERED';
-- 0 rows => rider cancelled meanwhile: ROLLBACK (driver goes back to AVAILABLE via the cancel path)

UPDATE active_trips SET driver_id = $driver WHERE trip_id = $trip;   -- UNIQUE(driver_id) backstop

INSERT INTO outbox (aggregate, agg_id, event_type, payload)
VALUES ('trip', $trip, 'TripMatched', jsonb_build_object('trip', $trip, 'driver', $driver));
COMMIT;
```

READ COMMITTED is sufficient: each check is inside the UPDATE's WHERE and is re-evaluated against the latest row version after any wait. The `seq` computation via `max(seq)+1` could collide under concurrent events on one trip; the primary key turns that into a unique violation that the caller retries, which is fine for the handful of events per trip (or use a per-trip counter column on `trips`).

> **MySQL difference:** the guarded UPDATEs behave the same in InnoDB (UPDATE reads the latest committed version). The `active_trips` workaround is unnecessary in MySQL only if you do not partition `trips`; InnoDB partitioned tables have the same rule that unique keys must include the partitioning columns.

### Location plane: Redis commands

```text
# ingest (per ping, pipelined by the gateway, ~2 commands per ping)
GEOADD drv:{sf}:avail -122.4194 37.7749 d7          # member score = geohash of the position
HSET drv:{sf}:d7 lat 37.7749 lng -122.4194 ts 1727190000 st AVAILABLE
EXPIRE drv:{sf}:d7 30                                # silent phone disappears on its own

# candidates for a pickup: 2 km radius, nearest first, 20 max
GEOSEARCH drv:{sf}:avail FROMLONLAT -122.4183 37.7755 BYRADIUS 2 km ASC COUNT 20

# when matched (driven by TripMatched event): remove from the available set
ZREM drv:{sf}:avail d7
```

Redis GEO members do not expire individually (the geo set is one sorted set), so a sweeper removes members whose `drv:{city}:{id}` hash has expired, or you rotate per-minute sets. An H3-grid service avoids that by storing `cell → {driver: last_ts}` and ignoring stale entries at query time — the lazy-expiry idea from [Ch 33 · Ticket Booking](topic.html?p=33-case-ticket-booking), applied to locations.

### Application code: the ping handler (Go)

```go
// HandlePing never touches Postgres. It overwrites the live index and appends to
// Kafka; both are fire-and-forget from the driver's point of view (the next ping
// in 4 s repairs any loss).
func (g *Gateway) HandlePing(ctx context.Context, p Ping) error {
	city := g.cityOf(p.Lat, p.Lng)
	cell := h3.LatLngToCell(h3.LatLng{Lat: p.Lat, Lng: p.Lng}, 8)
	key := fmt.Sprintf("drv:{%s}:%d", city, p.DriverID)

	pipe := g.redis.Pipeline()
	if p.Status == "AVAILABLE" {
		pipe.GeoAdd(ctx, "drv:{"+city+"}:avail", &redis.GeoLocation{Name: strconv.FormatInt(p.DriverID, 10), Longitude: p.Lng, Latitude: p.Lat})
	}
	pipe.HSet(ctx, key, "lat", p.Lat, "lng", p.Lng, "ts", p.TS.Unix(), "cell", uint64(cell), "st", p.Status)
	pipe.Expire(ctx, key, 30*time.Second)
	if _, err := pipe.Exec(ctx); err != nil {
		g.metrics.IndexWriteErrors.Inc() // degrade: dispatch will use slightly older positions
	}

	// Async produce; keyed by driver so one driver's pings stay ordered.
	g.kafka.Produce(&kafka.Message{
		TopicPartition: kafka.TopicPartition{Topic: &g.topic, Partition: kafka.PartitionAny},
		Key:            []byte(strconv.FormatInt(p.DriverID, 10)),
		Value:          p.Marshal(),
	}, nil)
	return nil
}
```

### History store for "my trips"

Rider and driver history are read by user across all cities, while the trip shards are keyed by city. Rather than scatter-gathering every shard, a consumer of `trip-events` maintains a user-keyed table:

```sql
-- Cassandra (CQL): partition per rider, newest first; the query is always "my recent trips".
CREATE TABLE trips_by_rider (
  rider_id     bigint,
  requested_at timestamp,
  trip_id      bigint,
  city         text,
  status       text,
  fare_minor   bigint,
  PRIMARY KEY ((rider_id), requested_at, trip_id)
) WITH CLUSTERING ORDER BY (requested_at DESC, trip_id DESC);
```

Writes are idempotent upserts by primary key, so at-least-once delivery from Kafka is harmless. See [Cassandra · Query-First Data Modeling](../cassandra/topic.html?p=07-query-first-data-modeling).

## 6. Advantages, Disadvantages & Trade-offs

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| Live locations | In-memory geo index (Redis GEO / H3 grid) | Postgres table + PostGIS updated per ping | 250k updates/s of short-lived data: MVCC churn, WAL, vacuum, replica lag |
| Location history | Kafka → Parquet in object storage | Relational table / Cassandra for every ping | cheap, append-only, queried rarely and in bulk |
| Route for fare | Sampled (10–15 s) per trip | Every ping | fare accuracy barely changes; storage drops ~3× |
| Trip store | Postgres sharded by city | Global single DB / NoSQL | transactions on driver + trip; city = transaction boundary |
| Matching | Guarded UPDATEs in one txn + unique backstops | Distributed lock in Redis | a lock without the DB write can expire mid-operation; the DB write is the truth |
| One-trip invariants | `active_trips` side table with UNIQUE | Partial unique on partitioned `trips` | partitioned uniqueness must include the partition key |
| History by user | CDC-fed Cassandra/DynamoDB table | Scatter-gather across city shards | one-partition reads, no cross-shard fan-out |
| Shard key | city (or city cluster) | driver_id / trip_id | driver and trip co-locate; no cross-shard matching |

### When to use this design

Any "moving things + transactions" system: food delivery couriers, logistics fleets, scooter/bike sharing, field-service dispatch. The split between a lossy live plane and a strong transactional plane generalises.

### When NOT to use it

- **Small fleet (hundreds of vehicles):** a PostGIS table updated every 10 s is perfectly fine; the separate plane is complexity you do not need yet.
- **Regulated telemetry that must be durable per point** (aviation, some trucking hours-of-service): pings become records; use an append-optimised time-series store (TimescaleDB, Cassandra) with durable writes, still not UPDATE-in-place.
- **Global matching across regions** (e.g. freight marketplaces): the city shard key no longer bounds the transaction; you need a different partitioning or a distributed SQL store.

## 7. Common Mistakes & Best Practices

**Mistake: `UPDATE drivers SET location = ...` on every ping.** It seems natural because the driver row already exists. It hurts because every ping creates a dead tuple and a GiST index entry, autovacuum falls behind, WAL floods replicas, and the trip tables sharing the cluster suffer. Instead: in-memory index for the present, append-only log for the past.

**Mistake: trusting the geo index for matching.** The index says "available", so dispatch assigns. It hurts because the index is seconds stale; two dispatchers assign the same driver. Instead: the index proposes candidates; a guarded UPDATE on `driver_state` in the trip store decides.

**Mistake: a Redis lock around matching instead of a DB condition.** `SET lock:driver:7 NX PX 5000` then write the DB. If the process pauses past the TTL, another dispatcher takes the lock and both write. Instead: the database write itself is the compare-and-swap; if you use a lock for efficiency, still guard the write ([Caching with Redis · Distributed Locks & Redlock](../redis-caching/topic.html?p=23-distributed-locks-redlock)).

**Mistake: sharding trips by trip_id or driver_id.** Matching then touches rows on different shards (driver on one, trip on another), and the one transaction that needs atomicity becomes a distributed one. Instead: shard by city so they co-locate.

**Mistake: storing every ping as a route point forever in Postgres.** Billions of rows per day, huge indexes, slow vacuum and backups. Instead: sampled route for the dispute window, full-resolution history in object storage.

**Mistake: non-idempotent driver actions.** The driver taps "Start trip" in a tunnel; the app retries three times; three events, maybe two fare timers. Instead: client event ids with a unique constraint; transitions guarded by status.

**Mistake: unconditional state resets.** A timeout handler runs `UPDATE driver_state SET status='AVAILABLE' WHERE driver_id = 7` after the driver already accepted — now an on-trip driver is available for new trips. Instead: `WHERE status = 'OFFERED' AND offer_trip_id = $t`.

**Best practices:** lock `driver_state` before `trips` in every path; keep `driver_state` narrow; alert on rows in OFFERED past `offer_expires`; TTL every live-index entry; home each city's shard in the nearest region ([Ch 17 · Multi-Region Databases](topic.html?p=17-multi-region-databases)).

## 8. Production: Failure Scenarios, Monitoring & Scaling

### Failure scenarios

**Redis shard for a big city fails over and loses a few seconds of writes.** Symptom: map shows cars jumping; a few dispatches go to drivers who moved. Root cause: async replication in Redis. Impact: none on correctness — the next ping (≤ 4 s) rebuilds positions, and matching is decided in Postgres. Fix: nothing structural; alert only if the index is empty or stale beyond 30 s, and fall back to a wider search radius.

**Autovacuum can't keep up on `driver_state` during New Year's Eve.** Symptom: `n_dead_tup` climbs, UPDATE latency rises. Root cause: status flips (AVAILABLE ↔ OFFERED ↔ ON_TRIP) at many times the usual rate on a narrow table. Fix: per-table autovacuum settings (`autovacuum_vacuum_scale_factor = 0.01`, higher `autovacuum_vacuum_cost_limit`), `fillfactor = 70` for HOT updates, and no extra indexes on status columns ([Ch 03 · MVCC](topic.html?p=03-mvcc)).

**Double-assigned driver reported by support.** Root cause: a new "scheduled rides" path set `driver_state` with an unconditional UPDATE. The `active_trips.driver_id` unique index rejected the second trip with 23505 and the path crashed instead of re-dispatching. Fix: guard the UPDATE; handle 23505 as "driver busy, try the next candidate"; the backstop did its job.

**Kafka location topic consumer lag grows to hours.** Symptom: yesterday's Parquet partitions incomplete; ETA model training delayed. Impact on riders: none — the live plane does not depend on it. Fix: scale the consumer group; this is why the history pipeline is off the critical path.

**Regional outage.** A region hosting 40 cities fails. Their trip shards fail over to standbys in a second region ([Ch 18 · High Availability](topic.html?p=18-high-availability)); in-flight trips resume from the durable trip state; the live index rebuilds from pings within seconds of drivers reconnecting to the new region.

### Monitoring

| Metric | Why | Alert |
|---|---|---|
| Ping ingest rate vs online drivers | gateway or app bug | drop > 20% |
| Geo index freshness (p99 age of positions) | matching quality | > 15 s |
| Matching txn p99 and 0-row rate | contention and stale candidates | p99 > 100 ms; 0-row rate > 30% |
| 23505 on `active_trips` | backstop fired: a bug exists | any |
| Drivers OFFERED past `offer_expires` | offer sweeper health | any after 30 s |
| `n_dead_tup`, autovacuum runs on `driver_state` | churn | dead tuples > 10% |
| Replication lag per city shard | failover readiness | > 1 s |
| Kafka consumer lag (history, read models) | derived data freshness | > 10 min |

### Scaling path

Per [Ch 21 · Database Scaling](topic.html?p=21-database-scaling):

1. **One country, few cities:** one Postgres primary with all cities, Redis for the geo index, Kafka for history. Partition `trips` monthly.
2. **10×:** move cities onto separate shards by `city_id` (Citus with `city_id` as distribution column, or app-level routing via a `city → shard` directory — [Ch 12 · Sharding](topic.html?p=12-sharding)). Big cities get dedicated shards; small ones share.
3. **100× / global:** shards homed per region, near their cities; Redis clusters per region; user-keyed history in a global wide-column store; the payments ledger as its own system fed by `TripCompleted` ([Ch 39 · Payment System](topic.html?p=39-case-payment-system)). A single mega-city that outgrows one primary splits by sub-region (a "city" in the directory becomes several zones, with matching allowed only within a zone plus explicit cross-zone handoff).

### Data lifecycle

Live index: seconds. Kafka locations: 7 days. Parquet history: tiered to infrequent-access storage after 90 days, retained per local regulation. `trip_route` in Postgres: 30–90 days (dispute window), then only in Parquet. Trips: monthly partitions detached after 13 months to an archive; payments per financial retention ([Ch 28 · Data Lifecycle](topic.html?p=28-data-lifecycle)).

## 9. Interview Questions

**Q: Why not store driver locations in PostgreSQL?**
A: Because the workload is 250,000 overwrites per second of values that are useless four seconds later. In PostgreSQL every UPDATE writes a new tuple version and, with a geo index on the changing column, a new index entry, so dead tuples accumulate faster than autovacuum can reclaim them and WAL volume floods replicas and archives. You would be paying full durability for data you are happy to lose. An in-memory geo index gives microsecond overwrites and fast radius queries, and Kafka plus object storage keeps history cheaply.

**Q: How do you find nearby drivers quickly?**
A: With a cell-based index. Redis GEO stores members in a sorted set scored by a 52-bit geohash, and `GEOSEARCH ... BYRADIUS` scans the few geohash ranges covering the circle. An H3 grid does the same with hexagonal cells: compute the pickup's cell, take its k-ring of neighbours, and union the driver sets of those cells. Either way the query touches a small, bounded number of keys regardless of the fleet size.

**Q: How do you guarantee a driver is never assigned two trips?**
A: The accept is one transaction on the city shard that flips the driver row from OFFERED-for-this-trip to ON_TRIP and the trip row from OFFERED to MATCHED, each with a guarded WHERE clause; if either updates zero rows, the transaction rolls back. A second concurrent accept waits on the driver row lock, then re-evaluates its WHERE against the new version and fails. As a backstop, a small `active_trips` table has UNIQUE constraints on driver and rider, so even a buggy code path cannot commit a second active trip.

**Q: Why shard trips by city?**
A: Because the transaction that needs atomicity — matching — always involves a driver and a trip in the same city, so city sharding keeps it local, with no 2PC or saga. Cities also map naturally to regions for latency and data residency, and to independent failure domains. The cost is that per-user queries across cities need a separate user-keyed read model, and very large cities may need sub-city zones.

**Q: What if the geo index says a driver is available but they just accepted another trip?**
A: Dispatch uses the index only to propose candidates. The offer itself is a guarded UPDATE `WHERE status = 'AVAILABLE'` on `driver_state` in Postgres, which returns zero rows for a busy driver, and dispatch moves to the next candidate. Shortly after, the `TripMatched` event removes the driver from the available set in the index. Staleness costs a wasted candidate, not a double assignment.

**Q: How are driver app retries handled?**
A: Each user action on the phone carries a client event id generated once, and `trip_events` has a unique constraint on `(trip_id, client_event_id)`. The transition transaction inserts the event first with `ON CONFLICT DO NOTHING`; a retry inserts nothing and returns the current state. Since the status transitions are guarded as well, even without the event id a repeated "start trip" would update zero rows.

**Q: How do you store the route used for the fare and receipt?**
A: Not as every ping. A consumer samples the active trip's pings every 10–15 seconds, plus key events like pickup and dropoff, into a `trip_route` table keyed by `(trip_id, ts)`. That is accurate enough for distance-based fares and the receipt map, and it keeps rows per trip in the low hundreds. After the dispute window it lives only in object storage alongside the full-resolution history.

**Q: A regulator asks where vehicle X was at 22:14 last March. How do you answer? (Senior)**
A: From the cold history: Parquet files in object storage partitioned by city, date and hour, containing every ping streamed from Kafka. A query engine like Trino or Athena prunes to one city and one hour and filters by driver id, returning the pings around 22:14. This is slow compared with OLTP but it is rare, and it costs nothing on the hot path. The retention and access controls on that bucket are part of the design because location history is sensitive personal data.

**Q: What happens to in-flight trips during a failover of a city shard? (Senior)**
A: The trip state is durably committed on the primary and replicated to a synchronous standby, so after promotion every matched or in-progress trip is exactly where it was. Driver and rider apps retry their calls with the same client event ids, and those land idempotently on the new primary. The live geo index is unaffected or, if it failed too, rebuilds from the next pings. During the failover window dispatch pauses for that city; other cities are separate shards and continue.

**Q: How would you design surge pricing storage? (Senior)**
A: Surge is derived, ephemeral and per cell: a stream job counts supply (available drivers per H3 cell from the ping stream) and demand (requests per cell from trip events) over a sliding window and writes a multiplier per cell to Redis with a short TTL. The multiplier used for a specific trip is copied into the trip row at request time, which is the only durable record and the only one that matters for billing. Keeping it out of the relational store avoids thousands of writes per second for values that change every minute.

**Q: When would PostGIS be the right answer here?**
A: For the durable, lower-rate geospatial data: service-area polygons, airport geofences, city boundaries, pricing zones — data that is read constantly but written rarely, and where a GiST index and `ST_Contains` are exactly right. Also for a small fleet where ten-second updates of a few hundred vehicles are trivial. It is the per-ping, high-churn live position that does not belong there.

**Q: How do you keep "my trips" fast when trips are sharded by city? (Senior)**
A: With a read model keyed by user. A consumer of the trip events upserts rows into a Cassandra or DynamoDB table partitioned by rider id and clustered by time descending, so "my recent trips" is a single-partition read regardless of how many cities the rider used. Writes are idempotent by primary key, so at-least-once delivery is safe. For read-your-writes right after a trip ends, the app shows the just-completed trip from the trip service directly until the read model catches up.

## 10. Quick Revision & Cheat Sheet

| Concern | Design choice |
|---|---|
| Live location (250k/s) | Redis GEO / H3 in-memory grid per city, overwrite, TTL 30 s |
| Location history | Kafka (key driver_id) → Parquet in object storage by city/date/hour |
| Route for fare | sampled 10–15 s into `trip_route`, short retention |
| Trip store | Postgres sharded by city; `trips` partitioned monthly |
| Matching | one txn: guarded UPDATE `driver_state` + `trips`; READ COMMITTED |
| Backstops | `active_trips` with UNIQUE(driver_id), UNIQUE(rider_id) |
| Retries | `trip_events UNIQUE (trip_id, client_event_id)` |
| Lock order | driver_state, then trips, everywhere |
| User history | CDC/outbox-fed Cassandra table keyed by rider |
| Surge | per-cell multiplier in Redis; copied into trip at request |
| Payments | `TripCompleted` via outbox to the ledger |

- Separate data by physics: write rate × value per write decides the store.
- The geo index proposes; the database disposes.
- Choose the shard key so the critical transaction stays on one shard.
- Guard every transition; zero rows means "someone else won".
- Loss-tolerant data gets cheap stores; money and safety records get synchronous replication.

## 11. Hands-On Exercises

Lab: `docker run --rm -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:17` and `docker run --rm -p 6379:6379 redis:7`.

1. **Feel the churn.** Create `driver_locations(driver_id PK, lat, lng, ts)` with 10,000 rows. Run a `pgbench` script doing random single-row UPDATEs at 64 clients for 60 s. Check `pg_stat_user_tables.n_dead_tup`, table size before/after, and `pg_stat_wal.wal_bytes`. Extrapolate to 250,000 updates/s.
2. **Redis GEO.** Load 100,000 random drivers around a city centre with `GEOADD`; time `GEOSEARCH ... BYRADIUS 2 km ASC COUNT 20` with `redis-benchmark` or a script. Compare with a PostGIS `ST_DWithin` query on the same data with a GiST index.
3. **Matching race.** Implement the accept transaction. In two psql sessions accept two different trips for the same driver; pause session A before COMMIT and show session B blocks, then updates 0 rows.
4. **Backstop.** Bypass the guards with a raw UPDATE and try to assign a second active trip to a driver; show the `active_trips` unique index rejects it with 23505.
5. **Idempotent accept.** Call the accept transaction twice with the same `client_event_id` and show the second is a no-op.

**Mini project:** simulate one city: 5,000 drivers pinging every 4 s into Redis and Kafka (or a file), a dispatcher that pulls candidates from Redis and runs the Postgres matching transaction, and 50 trip requests/s. Inject faults — kill Redis for 10 s, delay 5% of accepts past the offer expiry, duplicate 10% of driver actions — and verify: no driver ever has two active trips, no trip has two drivers, and every completed trip produced exactly one `TripCompleted` outbox row.

## 12. Related Topics & Free Learning Resources

**Concept chapters this design applies:** [Ch 03 · MVCC](topic.html?p=03-mvcc) (why per-ping UPDATEs bloat) · [Ch 04 · Concurrency Control](topic.html?p=04-concurrency-control) (guarded transitions) · [Ch 05 · Locking Internals](topic.html?p=05-locking-internals) (lock ordering) · [Ch 07 · Write-Ahead Logging](topic.html?p=07-write-ahead-logging) (WAL volume) · [Ch 10 · Consistency Models](topic.html?p=10-consistency-models) · [Ch 11 · Partitioning](topic.html?p=11-partitioning) · [Ch 12 · Sharding](topic.html?p=12-sharding) · [Ch 17 · Multi-Region Databases](topic.html?p=17-multi-region-databases) · [Ch 18 · High Availability](topic.html?p=18-high-availability) · [Ch 28 · Data Lifecycle](topic.html?p=28-data-lifecycle) · [Ch 29 · Advanced Database Patterns](topic.html?p=29-advanced-database-patterns) (outbox, CDC read models) · [Ch 30 · SQL vs NoSQL](topic.html?p=30-sql-vs-nosql).

**Related case studies:** [Ch 33 · Ticket Booking](topic.html?p=33-case-ticket-booking) · [Ch 39 · Payment System](topic.html?p=39-case-payment-system).

**SQL Handbook:** [Transactions & ACID](../sql/topic.html?p=25-transactions-acid) · [Partitioning](../sql/topic.html?p=23-partitioning) · [Keys & Constraints](../sql/topic.html?p=29-keys-constraints).

**Other handbooks:** [System Design · Design Uber](../system-design/topic.html?p=38-design-uber) (full-system view) · [Caching with Redis · Redis Cluster](../redis-caching/topic.html?p=26-redis-cluster) · [Caching with Redis · Distributed Locks & Redlock](../redis-caching/topic.html?p=23-distributed-locks-redlock) · [Cassandra · Query-First Data Modeling](../cassandra/topic.html?p=07-query-first-data-modeling) · [Kafka & RabbitMQ · Ordering, Partitioning & Keys](../messaging/topic.html?p=22-ordering-partitioning-keys).

- **H3: Uber's Hexagonal Hierarchical Spatial Index** — Uber Engineering · *Intermediate* · why hexagonal cells and how resolutions work. <https://www.uber.com/blog/h3/>
- **H3 documentation** — h3geo.org · *Intermediate* · cell resolutions, k-rings and the APIs used for candidate search. <https://h3geo.org/docs/>
- **Redis GEOSEARCH** — Redis docs · *Beginner* · the radius/box query over a geo sorted set. <https://redis.io/docs/latest/commands/geosearch/>
- **PostgreSQL docs — Routine Vacuuming** — PostgreSQL · *Intermediate* · why high-churn UPDATE workloads need care. <https://www.postgresql.org/docs/current/routine-vacuuming.html>
- **PostgreSQL docs — Table Partitioning (unique constraints must include the partition key)** — PostgreSQL · *Intermediate* · the limitation behind the `active_trips` side table. <https://www.postgresql.org/docs/current/ddl-partitioning.html>
- **Citus docs — Choosing the Distribution Column** — Citus · *Advanced* · co-location of related rows on one shard, the idea behind the city key. <https://docs.citusdata.com/en/stable/sharding/data_modeling.html>
- **Designing Data-Intensive Applications, ch. 6 & 11** — Martin Kleppmann · *Advanced* · partitioning and stream processing for the two planes. <https://dataintensive.net/>

---

*Database Design Handbook — chapter 34.*
