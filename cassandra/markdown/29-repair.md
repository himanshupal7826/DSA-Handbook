# 29 · Repair: Full, Incremental & Subrange

> **In one line:** `nodetool repair` is the only mechanism that *guarantees* replicas converge — it compares Merkle trees across replicas and streams the differences — and it must complete on every range within `gc_grace_seconds` or your deletes come back from the dead.

---

## 1. Overview

Repair is the operation that separates people who run Cassandra from people who have Cassandra running. Hints cover outages under three hours. Read repair covers data you actually read. Everything else — cold partitions, dropped mutations, a node that was down over a weekend, a coordinator that crashed holding hints — converges only when anti-entropy repair runs. And unlike almost every other database maintenance task, **not running it does not degrade performance, it corrupts correctness**: deleted rows come back.

The mechanism is the Merkle tree, inherited directly from Dynamo. For a token range, each replica performs a **validation compaction** — a full read of every SSTable covering that range — hashing rows into a binary hash tree. The coordinator collects the trees, walks them top-down, and for every subtree whose hash differs schedules a **streaming session** between the disagreeing replicas. Only the differing leaves move. In principle this is elegant and cheap. In practice, validation is a full-table read, the streaming granularity is a whole leaf (so one changed row can move a thousand), and on a multi-terabyte node a naive `nodetool repair` can run for days and never finish.

The deadline is what makes repair non-negotiable. A `DELETE` writes a **tombstone**. Tombstones are purged by compaction once they are older than `gc_grace_seconds` (default `864000` — 10 days). If a replica missed the delete and repair does not carry the tombstone to it before the other replicas purge theirs, that replica's live row wins on the next read by last-write-wins timestamp, and the row **resurrects**. So the hard operational contract is: *every token range of every table with deletes must be repaired at least once per `gc_grace_seconds`.*

The history is a series of attempts to make this affordable. Cassandra 2.1 added **incremental repair**, marking already-repaired SSTables so subsequent runs skip them — but the pre-4.0 implementation had a well-documented flaw (over-streaming and anticompaction races, CASSANDRA-9143) that led practitioners like The Last Pickle to publicly recommend *not* using it. Cassandra **4.0 rewrote incremental repair** with proper session tracking and made it genuinely usable. Meanwhile the community built **Cassandra Reaper**, which automates subrange repair: split the ring into small segments, run them serially with backoff and resume, and track state in Cassandra itself. Today the mainstream answer to "how do I repair?" is "Reaper, subrange, weekly" — and knowing *why* is the interview question.

Concretely: a 30-node cluster with 1.5 TB per node and `RF=3`. A full `nodetool repair -pr` on one node validates ~1.5 TB and streams whatever differs. Thirty nodes serially, at a couple of hours each, is a multi-day operation that must fit inside a 10-day window while competing with client traffic and normal compaction. That arithmetic — repair time versus `gc_grace_seconds` — is the real constraint on how much data you put on a node.

## 2. Core Concepts

- **Anti-entropy repair** — comparing replicas of a token range and reconciling differences. The only convergence *guarantee* Cassandra offers.
- **Merkle tree** — a binary hash tree over a token range. Cassandra builds trees with up to `2^15 = 32768` leaves per range; each leaf covers a slice of tokens, and the leaf is the streaming granularity.
- **Validation compaction** — the read of all SSTables covering a range to build its Merkle tree. Shows in `nodetool compactionstats` as `Validation`. CPU and disk heavy; it reads data but writes nothing.
- **Full repair** — `nodetool repair -full`: validates all data in the range regardless of prior repair state.
- **Incremental repair** — `nodetool repair` (the 4.x default when `-full` is omitted): skips SSTables already marked `repairedAt`, splitting the table's files into repaired and unrepaired pools.
- **Subrange repair** — `nodetool repair -st <start-token> -et <end-token>`: repairs one explicit token range, keeping trees small and sessions short. The basis of Reaper.
- **Primary range repair (`-pr`)** — repairs only the ranges for which this node is the primary replica. Run on *every* node for full coverage; avoids repairing each range `RF` times.
- **`gc_grace_seconds`** — default `864000` (10 days). The tombstone survival window, and therefore the repair deadline.
- **Zombie / resurrected data** — a deleted row that reappears because a replica missed the tombstone and the tombstone was purged elsewhere before repair propagated it.
- **Cassandra Reaper** — the open-source repair scheduler: segments the ring, runs subrange repairs with configurable concurrency and backoff, resumes failures, and stores state in a Cassandra keyspace.
- **`repairedAt`** — per-SSTable metadata timestamp marking when it was last covered by a successful incremental repair. Visible via `sstablemetadata`.
- **Anticompaction** — splitting an SSTable that partially overlaps a repaired range into a repaired part and an unrepaired part. The historical source of incremental repair's pain.
- **Preview repair (4.0+)** — `nodetool repair --preview` / `--validate`: estimates how much data *would* be streamed without doing it. A read-only inconsistency detector.

## 3. Theory & Internals

**Merkle tree construction and its granularity problem.** For a repair session over token range `(a, b]`, each replica streams its rows in that range through a hasher. Cassandra allocates a tree with `2^d` leaves where `d ≤ 15`, choosing depth based on the estimated partition count. Each leaf covers `(b − a) / 2^d` of the token space. A row's hash contributes to exactly one leaf; leaves hash upward to a root.

Comparing two trees is cheap: if roots match, done — `O(1)`. Otherwise descend; the cost is `O(k · log n)` for `k` differing subtrees. But **streaming granularity is the leaf**, and a leaf covers a *token sub-range*, not a row. So if a range contains 32 M rows and the tree has 32768 leaves, each leaf covers ~1000 rows. **A single differing row causes ~1000 rows to be streamed.** With `RF=3` and both directions, one stale cell can move several megabytes.

This is the whole argument for subrange repair. If you repair `1/256th` of the range at a time, each tree still has up to 32768 leaves but now covers 256× less data, so each leaf covers ~4 rows instead of ~1000. Over-streaming drops by two orders of magnitude, validation compactions are short, memory for the trees is bounded, and a failure costs you one small segment instead of the whole range.

**Full versus incremental.** A full repair validates everything in the range every time — cost proportional to *total data*. Incremental repair marks SSTables `repairedAt = <session time>` on success, and subsequent incremental runs validate only the **unrepaired** pool — cost proportional to *data written since the last repair*, which on a steady-state cluster is dramatically less. The price is that the table now has two independent compaction hierarchies (repaired and unrepaired SSTables never compact together, or you would mix repair states), and any SSTable that only partially overlaps the repaired range must be **anticompacted** — split into two files.

Pre-4.0, anticompaction ran inline with repair and raced with normal compaction, producing over-streaming, huge SSTable counts, and sessions that failed and left files in an inconsistent state. Cassandra 4.0 (CASSANDRA-9143) introduced a proper **transactional session model**: SSTables are placed in a *pending repair* state associated with a session ID, promoted to repaired only when the session commits cluster-wide, and rolled back if it aborts. `nodetool repair_admin list` shows sessions; `nodetool repair_admin cancel --session <id>` clears a stuck one.

**The `gc_grace_seconds` arithmetic.** Let `T_repair` be the wall-clock time to repair every range of every table on every node. The constraint is `T_repair + safety_margin < gc_grace_seconds`. With the default 10 days, a weekly repair cycle leaves 3 days of slack. If `T_repair` approaches 10 days you have three options, in order of preference: (1) reduce data per node; (2) reduce what needs repairing (TTL + TWCS append-only tables with no deletes can safely have a much larger `gc_grace_seconds`, or arguably be excluded); (3) raise `gc_grace_seconds`, accepting longer tombstone retention and more tombstone scanning on reads. Lowering `gc_grace_seconds` to reduce tombstone cost without shortening the repair cycle is how clusters get zombie data.

**Quorum math does not save you.** A common misconception: "we read and write at `LOCAL_QUORUM`, so `R + W > RF` and we are consistent — why repair?" Quorum guarantees you *read* at least one replica with the latest write. It does not repair the stale replica (except opportunistically via blocking read repair, and only for data you read), and it does nothing about tombstone purging. The zombie-data failure mode is entirely orthogonal to consistency level.

```svg
<svg viewBox="0 0 820 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="a29a" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="410" y="20" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">Merkle Tree Granularity: full range vs subrange</text>

  <rect x="20" y="38" width="380" height="180" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="210" y="60" text-anchor="middle" fill="#1e293b" font-weight="700">Full range tree</text>
  <circle cx="210" cy="88" r="14" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="210" y="92" text-anchor="middle" fill="#1e293b" font-size="9">root</text>
  <circle cx="150" cy="130" r="13" fill="#eef2ff" stroke="#4f46e5"/>
  <circle cx="270" cy="130" r="13" fill="#fee2e2" stroke="#dc2626"/>
  <line x1="210" y1="102" x2="152" y2="118" stroke="#475569"/>
  <line x1="210" y1="102" x2="268" y2="118" stroke="#475569"/>
  <rect x="110" y="165" width="60" height="26" rx="4" fill="#eef2ff" stroke="#4f46e5"/>
  <rect x="178" y="165" width="60" height="26" rx="4" fill="#eef2ff" stroke="#4f46e5"/>
  <rect x="246" y="165" width="60" height="26" rx="4" fill="#fee2e2" stroke="#dc2626"/>
  <rect x="314" y="165" width="60" height="26" rx="4" fill="#eef2ff" stroke="#4f46e5"/>
  <line x1="150" y1="143" x2="140" y2="162" stroke="#475569"/>
  <line x1="150" y1="143" x2="205" y2="162" stroke="#475569"/>
  <line x1="270" y1="143" x2="276" y2="162" stroke="#475569"/>
  <line x1="270" y1="143" x2="340" y2="162" stroke="#475569"/>
  <text x="276" y="182" text-anchor="middle" fill="#b91c1c" font-size="10">1000 rows</text>
  <text x="210" y="208" text-anchor="middle" fill="#b45309" font-size="11" font-weight="700">1 stale row streams ~1000 rows</text>

  <rect x="420" y="38" width="380" height="180" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="610" y="60" text-anchor="middle" fill="#1e293b" font-weight="700">Subrange tree, same 2^15 leaves</text>
  <circle cx="610" cy="88" r="14" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="610" y="92" text-anchor="middle" fill="#1e293b" font-size="9">root</text>
  <circle cx="550" cy="130" r="13" fill="#eef2ff" stroke="#4f46e5"/>
  <circle cx="670" cy="130" r="13" fill="#fee2e2" stroke="#dc2626"/>
  <line x1="610" y1="102" x2="552" y2="118" stroke="#475569"/>
  <line x1="610" y1="102" x2="668" y2="118" stroke="#475569"/>
  <rect x="510" y="165" width="60" height="26" rx="4" fill="#eef2ff" stroke="#4f46e5"/>
  <rect x="578" y="165" width="60" height="26" rx="4" fill="#eef2ff" stroke="#4f46e5"/>
  <rect x="646" y="165" width="60" height="26" rx="4" fill="#fee2e2" stroke="#dc2626"/>
  <rect x="714" y="165" width="60" height="26" rx="4" fill="#eef2ff" stroke="#4f46e5"/>
  <line x1="550" y1="143" x2="540" y2="162" stroke="#475569"/>
  <line x1="550" y1="143" x2="605" y2="162" stroke="#475569"/>
  <line x1="670" y1="143" x2="676" y2="162" stroke="#475569"/>
  <line x1="670" y1="143" x2="740" y2="162" stroke="#475569"/>
  <text x="676" y="182" text-anchor="middle" fill="#15803d" font-size="10">4 rows</text>
  <text x="610" y="208" text-anchor="middle" fill="#15803d" font-size="11" font-weight="700">1 stale row streams ~4 rows</text>

  <text x="410" y="250" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="700">The gc_grace_seconds deadline</text>

  <rect x="60" y="270" width="700" height="34" rx="6" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="410" y="292" text-anchor="middle" fill="#1e293b" font-weight="700">gc_grace_seconds = 864000 s = 10 days</text>

  <rect x="60" y="316" width="420" height="30" rx="6" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="270" y="336" text-anchor="middle" fill="#1e293b" font-size="11">repair cycle: 7 days   SAFE</text>
  <rect x="490" y="316" width="270" height="30" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-dasharray="4 3"/>
  <text x="625" y="336" text-anchor="middle" fill="#15803d" font-size="11">3 day margin</text>

  <rect x="60" y="356" width="640" height="30" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="380" y="376" text-anchor="middle" fill="#1e293b" font-size="11">repair cycle: 12 days   tombstones purged before propagation</text>
  <text x="740" y="376" text-anchor="middle" fill="#b91c1c" font-size="11" font-weight="700">ZOMBIES</text>
</svg>
```

## 4. Architecture & Workflow

**Anatomy of a repair session.**

1. Operator (or Reaper) invokes `nodetool repair` on node N with a range, table list and options. N becomes the **repair coordinator** for that session and allocates a parent session ID.
2. N determines the replica set for each range in scope, using the keyspace's replication strategy and the snitch.
3. For **incremental** repair, N first tells all participants to move the SSTables covering the range into a **pending repair** state tied to the session ID (anticompacting any file that only partially overlaps).
4. N sends a `VALIDATION_REQ` to each replica. Each performs a **validation compaction** — reading every SSTable that covers the range and hashing rows into a Merkle tree. Visible as `Validation` in `nodetool compactionstats`.
5. Replicas return their trees to N. N diffs them pairwise and produces, for each pair of replicas, the list of differing leaf ranges.
6. N issues `SYNC_REQ` messages. The disagreeing replicas open **streaming sessions** directly with each other and exchange the rows in the differing ranges. Progress is visible in `nodetool netstats` on the participants.
7. Streamed SSTables land on the receivers; normal compaction folds them in and last-write-wins reconciliation happens at read/compaction time as usual.
8. On success with incremental repair, N commits the session: participants promote their pending-repair SSTables to **repaired** with `repairedAt` set. On failure, the session aborts and the SSTables return to unrepaired.
9. The result is recorded in `system_distributed.repair_history` and `system_distributed.parent_repair_history`.

**The recommended operational workflow (Reaper-style subrange).**

1. Enumerate the ring's token ranges (`nodetool ring` or `system.peers_v2` tokens).
2. Split each range into segments sized so a single segment repairs in **under ~20 minutes** — typically tens of GB of covered data.
3. For each segment, pick a coordinator among its replicas and run `nodetool repair -st <s> -et <e> -local <ks> <tbl>`.
4. Run segments with bounded concurrency (1–2 per DC) and a pause between them so compaction can catch up.
5. On failure, retry the segment with backoff; do not abandon the whole cycle.
6. Track per-segment completion so the cycle's *slowest* range determines repair age — that is the number that must stay under `gc_grace_seconds`.
7. Repeat continuously so the cycle completes well inside the window.

**Choosing a strategy — decision path.**

- Table is append-only with TTLs, no deletes, TWCS? → Repair is near-optional; a periodic full repair is still wise for bit-rot and dropped mutations, but you can raise `gc_grace_seconds` and repair rarely.
- Cluster under ~500 GB/node, single DC? → `nodetool repair -pr -full` on every node, weekly, is fine and simple.
- Cluster 0.5–2 TB/node, 4.0+? → Incremental repair frequently (daily) plus a full repair monthly, or Reaper subrange full repairs weekly.
- Cluster over 2 TB/node or multi-DC? → Reaper, subrange, `-local`, low concurrency, continuous. And plan to reduce data per node.
- Pre-4.0? → Do **not** use incremental repair. Full subrange repair via Reaper.

```svg
<svg viewBox="0 0 820 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="a29b" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="410" y="20" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">Repair Session: validate, diff, stream, commit</text>

  <rect x="330" y="40" width="160" height="48" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="410" y="61" text-anchor="middle" fill="#1e293b" font-weight="700">repair coordinator</text>
  <text x="410" y="78" text-anchor="middle" fill="#64748b" font-size="10">parent session id</text>

  <rect x="60" y="140" width="150" height="60" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="135" y="162" text-anchor="middle" fill="#1e293b" font-weight="700">replica A</text>
  <text x="135" y="180" text-anchor="middle" fill="#64748b" font-size="10">validation compaction</text>
  <text x="135" y="194" text-anchor="middle" fill="#64748b" font-size="10">builds Merkle tree</text>

  <rect x="335" y="140" width="150" height="60" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="410" y="162" text-anchor="middle" fill="#1e293b" font-weight="700">replica B</text>
  <text x="410" y="180" text-anchor="middle" fill="#64748b" font-size="10">validation compaction</text>
  <text x="410" y="194" text-anchor="middle" fill="#64748b" font-size="10">builds Merkle tree</text>

  <rect x="610" y="140" width="150" height="60" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="685" y="162" text-anchor="middle" fill="#1e293b" font-weight="700">replica C</text>
  <text x="685" y="180" text-anchor="middle" fill="#64748b" font-size="10">validation compaction</text>
  <text x="685" y="194" text-anchor="middle" fill="#64748b" font-size="10">builds Merkle tree</text>

  <line x1="360" y1="88" x2="150" y2="136" stroke="#4f46e5" marker-end="url(#a29b)"/>
  <line x1="410" y1="88" x2="410" y2="136" stroke="#4f46e5" marker-end="url(#a29b)"/>
  <line x1="460" y1="88" x2="670" y2="136" stroke="#4f46e5" marker-end="url(#a29b)"/>
  <text x="230" y="112" text-anchor="middle" fill="#4338ca" font-size="10">VALIDATION_REQ</text>

  <line x1="160" y1="136" x2="345" y2="92" stroke="#0ea5e9" stroke-dasharray="4 3" marker-end="url(#a29b)"/>
  <line x1="660" y1="136" x2="475" y2="92" stroke="#0ea5e9" stroke-dasharray="4 3" marker-end="url(#a29b)"/>
  <text x="600" y="112" text-anchor="middle" fill="#0369a1" font-size="10">trees returned</text>

  <rect x="270" y="232" width="280" height="40" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="410" y="256" text-anchor="middle" fill="#1e293b" font-weight="700">coordinator diffs trees, finds leaf ranges</text>
  <line x1="410" y1="200" x2="410" y2="228" stroke="#d97706" marker-end="url(#a29b)"/>

  <line x1="210" y1="170" x2="330" y2="170" stroke="#16a34a" stroke-width="2" marker-end="url(#a29b)"/>
  <line x1="490" y1="185" x2="605" y2="185" stroke="#16a34a" stroke-width="2" marker-end="url(#a29b)"/>
  <text x="270" y="163" text-anchor="middle" fill="#15803d" font-size="10">SYNC stream</text>
  <text x="548" y="178" text-anchor="middle" fill="#15803d" font-size="10">SYNC stream</text>

  <rect x="60" y="300" width="330" height="80" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="225" y="322" text-anchor="middle" fill="#1e293b" font-weight="700">success</text>
  <text x="225" y="341" text-anchor="middle" fill="#1e293b" font-size="11">incremental: pending becomes repaired</text>
  <text x="225" y="359" text-anchor="middle" fill="#1e293b" font-size="11">repairedAt set on each SSTable</text>
  <text x="225" y="374" text-anchor="middle" fill="#64748b" font-size="10">logged in system_distributed.repair_history</text>

  <rect x="430" y="300" width="330" height="80" rx="10" fill="#fee2e2" stroke="#dc2626"/>
  <text x="595" y="322" text-anchor="middle" fill="#1e293b" font-weight="700">failure</text>
  <text x="595" y="341" text-anchor="middle" fill="#1e293b" font-size="11">session aborts, SSTables roll back</text>
  <text x="595" y="359" text-anchor="middle" fill="#1e293b" font-size="11">range stays unrepaired, retry the segment</text>
  <text x="595" y="374" text-anchor="middle" fill="#b91c1c" font-size="10">check nodetool repair_admin list for orphans</text>
</svg>
```

## 5. Implementation

Set the table options that govern the repair contract:

```cql
CREATE KEYSPACE IF NOT EXISTS shop
  WITH replication = {'class':'NetworkTopologyStrategy','dc1':3,'dc2':3};

CREATE TABLE shop.orders (
  customer_id uuid,
  order_id    timeuuid,
  total_cents bigint,
  status      text,
  PRIMARY KEY ((customer_id), order_id)
) WITH CLUSTERING ORDER BY (order_id DESC)
  AND gc_grace_seconds = 864000        -- 10 days: your repair deadline
  AND compaction = {'class':'LeveledCompactionStrategy'};

-- Append-only TTL table: no deletes, so a much longer grace window is safe
CREATE TABLE shop.events (
  day       date,
  event_id  timeuuid,
  payload   text,
  PRIMARY KEY ((day), event_id)
) WITH default_time_to_live = 2592000
  AND gc_grace_seconds = 7776000       -- 90 days; TWCS drops whole SSTables
  AND compaction = {'class':'TimeWindowCompactionStrategy',
                    'compaction_window_unit':'DAYS','compaction_window_size':1};
```

The commands, with realistic output:

```bash
# --- Full primary-range repair, DC-local, one table (run on EVERY node) ---
nodetool repair -pr -full -local shop orders
# [2026-07-22 02:00:11,402] Starting repair command #12 (a1b2c3d4-...),
#   repairing keyspace shop with repair options (parallelism: parallel, primary range: true,
#   incremental: false, job threads: 1, ColumnFamilies: [orders], dataCenters: [dc1],
#   hosts: [], previewKind: NONE, # of ranges: 16, pull repair: false, force repair: false)
# [2026-07-22 02:14:48,119] Repair session a1b2c3d4-... for range [(-9223372036854775808,...]] finished
# [2026-07-22 02:41:03,884] Repair command #12 finished in 40 minutes 52 seconds

# --- Incremental repair (4.0+ default when -full is omitted) ---
nodetool repair -pr shop
nodetool repair_admin list
# id                                   state    last activity  coordinator      participants
# 5f3e2a11-8c44-11ef-9a1b-0242ac120002 FINALIZED  412s          /10.0.1.11      10.0.1.11,10.0.1.12,10.0.1.13
nodetool repair_admin cancel --session 5f3e2a11-8c44-11ef-9a1b-0242ac120002   # clear a stuck session

# --- Subrange repair of one explicit range ---
nodetool repair -st -9223372036854775808 -et -6917529027641081856 -full -local shop orders

# --- Preview: how much WOULD be streamed? (4.0+, read-only) ---
nodetool repair --preview -pr shop orders
# Preview complete
#   /10.0.1.12: 412 ranges, 18.4 MiB
#   /10.0.1.13: 388 ranges, 17.1 MiB
nodetool repair --validate shop orders     # verifies repaired data is actually consistent

# --- Watch it run ---
nodetool compactionstats
# pending tasks: 6
# id          compaction type  keyspace  table   completed   total      unit   progress
# 7f1a...     Validation       shop      orders  41.2 GiB    98.7 GiB   bytes  41.74%
nodetool netstats -H | head -20
nodetool tpstats | grep -i -E 'validation|antientropy|repair'

# --- Live throttles during a repair window ---
nodetool setcompactionthroughput 128
nodetool setstreamthroughput 300
nodetool setinterdcstreamthroughput 100
# ... and back down before peak:
nodetool setcompactionthroughput 64
```

Check repair state on disk and in the distributed tables:

```bash
sstablemetadata /var/lib/cassandra/data/shop/orders-*/nb-88-big-Data.db | grep -E 'Repaired|Pending'
# Repaired at: 1753142411000
# Pending repair: --
# (Repaired at: 0 means this SSTable has never been covered by an incremental repair)

nodetool info | grep 'Percent Repaired'
# Percent Repaired       : 91.4%
```

```cql
-- Real repair age: the OLDEST successfully repaired range, not the last command
SELECT keyspace_name, columnfamily_names, started_at, finished_at, successful_ranges
  FROM system_distributed.parent_repair_history
  WHERE parent_id = a1b2c3d4-0000-0000-0000-000000000000;

SELECT keyspace_name, columnfamily_name, range_begin, range_end, status, finished_at
  FROM system_distributed.repair_history
  WHERE keyspace_name = 'shop' AND columnfamily_name = 'orders'
  LIMIT 20;
```

Cassandra Reaper — the production answer:

```yaml
# reaper.yaml (excerpt)
segmentCountPerNode: 16
repairParallelism: DATACENTER_AWARE
repairIntensity: 0.9            # fraction of time actively repairing vs pausing
incrementalRepair: false        # full subrange repairs are the safe default
repairRunThreadCount: 15
hangingRepairTimeoutMins: 30
scheduleDaysBetween: 7          # must stay well under gc_grace_seconds
storageType: cassandra
```

```bash
# Register the cluster and schedule a weekly subrange repair
curl -X POST 'http://reaper:8080/cluster?seedHost=10.0.1.11'
curl -X POST 'http://reaper:8080/repair_schedule?clusterName=prod-eu&keyspace=shop&tables=orders&owner=sre&scheduleDaysBetween=7&repairParallelism=DATACENTER_AWARE&intensity=0.9'
curl -s 'http://reaper:8080/repair_run?clusterName=prod-eu' | jq '.[] | {id, state, segmentsRepaired, totalSegments}'
# { "id": "3c1a...", "state": "RUNNING", "segmentsRepaired": 812, "totalSegments": 1920 }
```

Monitoring repair age programmatically:

```python
from cassandra.cluster import Cluster
from datetime import datetime, timezone

session = Cluster(["10.0.1.11"]).connect()
GC_GRACE = 864000  # seconds; read per-table from system_schema.tables in real use

rows = session.execute("""
    SELECT keyspace_name, columnfamily_name, finished_at
    FROM system_distributed.repair_history
""")
oldest = {}
for r in rows:
    if r.finished_at is None:
        continue
    key = (r.keyspace_name, r.columnfamily_name)
    oldest[key] = min(oldest.get(key, r.finished_at), r.finished_at)

now = datetime.now(timezone.utc)
for (ks, tbl), ts in sorted(oldest.items()):
    age = (now - ts.replace(tzinfo=timezone.utc)).total_seconds()
    risk = age / GC_GRACE
    flag = "CRIT" if risk > 0.9 else "WARN" if risk > 0.7 else "ok"
    print(f"{ks}.{tbl:24s} age={age/86400:5.1f}d risk={risk:.2f} {flag}")
# shop.orders              age=  5.2d risk=0.52 ok
# shop.legacy_carts        age=  9.4d risk=0.94 CRIT
```

> **Optimization:** the single highest-leverage change is **segmenting the ring so each repair session covers a small, bounded amount of data**. It shrinks Merkle-tree over-streaming from ~1000 rows per differing row to a handful, keeps validation compactions short enough that they interleave politely with client traffic, bounds tree memory, and makes a failure cost one segment instead of a whole night. Second highest: run `-local` for the routine cycle and cross-DC repairs rarely and off-peak, capped by `inter_dc_stream_throughput_outbound_megabits_per_sec`. Third: use `nodetool repair --preview` before a big run to see how much data would actually move — if the answer is "almost nothing", you can safely lengthen the cycle; if it is "hundreds of GB", something upstream (a flapping node, dropped mutations) needs fixing first.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost/Trade-off |
|---|---|---|
| Anti-entropy repair | The only guaranteed convergence; prevents zombie data | Validation is a full read of the range; streaming and compaction load compete with clients |
| Full repair | Simple, complete, no session state to corrupt | Cost proportional to *all* data every time; infeasible above a couple of TB per node |
| Incremental repair (4.0+) | Cost proportional to data written since last repair — often 10× cheaper | Splits SSTables into repaired/unrepaired pools; anticompaction overhead; a stuck session leaves pending-repair files |
| Incremental repair (pre-4.0) | — | Genuinely unsafe: over-streaming and anticompaction races. Do not use |
| Subrange repair | Small trees, tiny over-streaming, short sessions, cheap retries | Requires orchestration and token math; many sessions to schedule and track |
| `-pr` (primary range) | Avoids repairing every range `RF` times | Only correct if run on **every** node in **every** DC; a skipped node leaves permanent gaps |
| `-local` | No WAN streaming; fast, cheap routine cycle | Does not reconcile across DCs — you still need periodic cross-DC repairs |
| Cassandra Reaper | Automates segmentation, concurrency, backoff, resume and history | Another service to run and monitor; its own Cassandra keyspace to maintain |
| `--preview` (4.0+) | Measures inconsistency with zero write impact | Still pays the validation cost; it is not free, just harmless |
| Longer `gc_grace_seconds` | More slack in the repair schedule | Tombstones live longer: bigger SSTables, more tombstone scanning, slower reads |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Not running repair at all because "the cluster is healthy".** → ✅ Health is not the point; tombstone propagation is. Every table with deletes must have every range repaired within `gc_grace_seconds` or deleted rows resurrect. Schedule it before you need it.
2. ⚠️ **Running `nodetool repair` with no flags on every node.** → ✅ Without `-pr`, each node repairs every range it replicates, so with `RF=3` every range is repaired three times. Use `-pr` on every node, or let Reaper handle segmentation.
3. ⚠️ **Running `-pr` on only some nodes.** → ✅ `-pr` covers only that node's primary ranges. Skipping nodes leaves ranges that are *never* repaired — the silent path to zombie data. Automate so no node is missed.
4. ⚠️ **Measuring "last repair" by the last successful command.** → ✅ Repair age is the age of the **oldest unrepaired range**, not the last run. Compute it from `system_distributed.repair_history` (or Reaper's state) per table.
5. ⚠️ **Using incremental repair on Cassandra 3.x.** → ✅ Pre-4.0 anticompaction races cause over-streaming and SSTable explosions. On 3.x use full subrange repair via Reaper. Incremental is safe from 4.0 onward.
6. ⚠️ **Mixing full and incremental repairs carelessly on the same table.** → ✅ A full repair does not mark SSTables repaired, so it does not advance incremental state; running both without a plan can make you re-validate data you thought was covered. Pick one model per table and document it.
7. ⚠️ **Lowering `gc_grace_seconds` to reduce tombstone reads without shortening the repair cycle.** → ✅ You have just moved the deadline inside your repair time. Fix tombstones at the data-model level (TTL + TWCS), not by shrinking the safety window.
8. ⚠️ **Running repair during peak traffic with default throttles.** → ✅ Validation compaction plus streaming will eat your p99. Schedule off-peak, raise `compaction_throughput_mb_per_sec` and stream throughput inside the window, and lower them before peak returns.
9. ⚠️ **Running repair concurrently with a bootstrap, decommission or cleanup.** → ✅ They contend for the same disk and streaming budget, and topology changes during repair produce failed sessions. Serialise all heavy operations.
10. ⚠️ **Running full cross-DC repairs on the routine schedule.** → ✅ Cross-DC streaming saturates the WAN and is charged by the byte in most clouds. Routine cycle: `-local`. Cross-DC: less frequent, off-peak, throttled with `inter_dc_stream_throughput_outbound_megabits_per_sec`.
11. ⚠️ **Treating a failed repair session as "it will get picked up next time".** → ✅ It will not; that range simply stays unrepaired and its age keeps climbing. Alert on failures and retry the specific segment.
12. ⚠️ **Ignoring `nodetool repair_admin list` after a repair crash.** → ✅ Orphaned incremental sessions leave SSTables in pending-repair state, excluded from normal compaction, accumulating forever. Cancel stuck sessions explicitly.
13. ⚠️ **Repairing every table on the same schedule.** → ✅ Append-only TTL tables on TWCS with no deletes have very different needs from a mutable table with heavy deletes. Tier your schedule by table, and use `--preview` to confirm which tables actually diverge.
14. ⚠️ **Putting 5 TB on a node and then discovering repair takes 3 weeks.** → ✅ Repair time, not disk price, is the real ceiling on node density. Size for 1–2 TB per node when regular repairs are required.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** The three recurring failures:

*Repair hangs.* A participant died, or a stream socket was killed by a NAT/firewall idle timeout on port 7000. Check `system.log` on the coordinator for `RepairException` and on participants for `StreamException`; verify `streaming_keep_alive_period_in_secs` (300) is shorter than your network idle timeout. Reaper's `hangingRepairTimeoutMins` exists precisely because this is common. Kill the session (`nodetool repair_admin cancel`) and retry the segment.

*Repair runs but nothing converges.* Usually `-pr` on a subset of nodes, or a table excluded from the schedule. Verify coverage from `system_distributed.repair_history` per range, not per command.

*Repair OOMs or blows up SSTable counts.* Merkle trees for very large ranges plus high `num_tokens` consume heap; incremental anticompaction on 3.x explodes file counts. Move to subrange, lower job threads (`-j 1`), and on 3.x abandon incremental.

To prove divergence exists before spending hours: `nodetool repair --preview` reports the bytes that *would* stream. To prove data that is marked repaired really is consistent: `nodetool repair --validate`.

**Monitoring.** Track:
- **Repair age per table** — the oldest unrepaired range, from `system_distributed.repair_history` or Reaper. Alert `WARN` at `0.7 × gc_grace_seconds`, page at `0.9 ×`. This is the metric that matters most and the one almost nobody collects.
- `org.apache.cassandra.metrics:type=Table,keyspace=*,scope=*,name=RepairJobsStarted|RepairJobsCompleted`.
- `Percent Repaired` from `nodetool info` (incremental repair only) — a node persistently below the fleet median has failing repairs.
- `org.apache.cassandra.metrics:type=Compaction,name=PendingTasks` and validation compaction bytes during the window.
- `org.apache.cassandra.metrics:type=Streaming,name=TotalIncomingBytes|TotalOutgoingBytes` — how much is actually moving; a sudden jump means real divergence appeared.
- `org.apache.cassandra.metrics:type=ClientRequest,scope=Read|Write,name=Latency` p99 **during** the repair window — your guardrail that repair is not hurting production.
- Reaper's own `/repair_run` API: segments repaired vs total, and failure counts.

**Security.** Repair streams carry **raw row data over the internode port** (7000, or 7001 with TLS) — including across the WAN for cross-DC repairs. Set `server_encryption_options: internode_encryption: all` with `require_client_auth: true` and a private CA, or every repair broadcasts your dataset in cleartext. Repair is triggered over **JMX**, which has no role-based access control, so anyone who can reach port 7199 can start (or, more dangerously, cancel) repairs — keep `LOCAL_JMX=yes` and drive repairs from an authenticated orchestrator like Reaper, which also gives you an audit trail of who scheduled what.

**Performance & Scaling.** Repair is the operation that sets your maximum node density. Rules of thumb: budget **1–2 TB per node** when repairs are mandatory; size segments so each completes in under ~20 minutes; run at concurrency 1–2 per DC with `repairIntensity ≈ 0.9` so there is breathing room between segments; use `-local` routinely. Reduce what needs repairing: tables that are append-only with TTLs under TWCS can have a much longer `gc_grace_seconds` and a rarer cycle, which can cut total repair volume dramatically on a typical cluster where one time-series table holds 80% of the bytes. If `T_repair` still approaches `gc_grace_seconds`, add nodes — that is the only structural fix, because halving data per node roughly halves validation time.

## 9. Interview Questions

**Q: Why is repair mandatory rather than an optimisation?**
A: Because tombstones are purged after `gc_grace_seconds` (864000s / 10 days by default). If a replica missed a delete and the other replicas purge their tombstones before repair propagates it, the stale replica's live row wins by last-write-wins and the deleted data resurrects. Hints only cover ~3 hours of downtime and read repair only fixes data you actually read, so anti-entropy repair is the only guarantee.

**Q: How does repair actually detect differences between replicas?**
A: Each replica performs a validation compaction over the token range — reading all SSTables covering it and hashing rows into a Merkle tree with up to `2^15` leaves. The repair coordinator collects the trees, diffs them top-down, and for each differing leaf schedules a streaming session between the disagreeing replicas. Only the differing leaf ranges are streamed.

**Q: What does the `-pr` flag do and what is the trap?**
A: It repairs only the token ranges for which the node is the primary replica, avoiding repairing each range `RF` times. The trap is that it only gives full coverage if you run it on **every** node in **every** datacenter — skip one node and its primary ranges are never repaired, silently, forever.

**Q: What is the difference between full and incremental repair?**
A: Full repair validates all data in the range every time, so its cost is proportional to total data. Incremental repair marks SSTables with a `repairedAt` timestamp on success and subsequent runs validate only the unrepaired pool, so cost is proportional to data written since the last repair. Incremental splits the table into repaired and unrepaired compaction hierarchies and requires anticompaction for partially-overlapping SSTables.

**Q: Why is subrange repair preferred on large clusters?**
A: Streaming granularity is a Merkle tree leaf, not a row. Over a large range each leaf covers many rows, so a single stale row can stream a thousand. Repairing a small subrange with the same number of leaves makes each leaf cover far less data, cutting over-streaming by orders of magnitude, keeping validation compactions short, bounding tree memory, and making a failed session cost one small segment instead of hours.

**Q: What is Cassandra Reaper and why do people use it?**
A: An open-source repair orchestrator originally from Spotify and maintained by The Last Pickle. It splits the ring into segments, runs subrange repairs with configurable parallelism and intensity, backs off between segments, retries failures, times out hanging sessions, and stores schedule and progress state in Cassandra. It turns repair from a fragile cron job into a monitored, resumable, continuously running process.

**Q: How do you know when a table was really last repaired?**
A: Not from the last successful command — from the **oldest successfully repaired range**. Query `system_distributed.repair_history` and `parent_repair_history` (or read Reaper's segment state) and take the minimum `finished_at` across all ranges for that table. That age is what must stay below `gc_grace_seconds`.

**Q: (Senior) Walk me through diagnosing resurrected data in production.**
A: Establish the timeline first: when was the row deleted, when did it reappear, and at what consistency level was it read. Then check the two preconditions for resurrection. One: was a replica unreachable when the delete happened for longer than `max_hint_window_in_ms` (3 h)? Check node downtime history and hint metrics for that window. Two: did repair fail to cover that token range before `gc_grace_seconds` elapsed? Use `nodetool getendpoints` to find the replicas for that partition key, then check `system_distributed.repair_history` for that range's last successful repair. Confirm by querying each replica directly at `CONSISTENCY ONE` — you will see the row present on the replica that missed the tombstone. The fix for the incident is re-deleting with a fresh timestamp and running repair; the fix for the cause is closing the repair coverage gap, and typically also removing the delete pattern in favour of TTLs.

**Q: (Senior) Compare the compaction, streaming and consistency implications of choosing incremental repair on Cassandra 4.0 versus full subrange repair.**
A: Incremental repair on 4.0 is dramatically cheaper in steady state — you validate only data written since the last run — and 4.0's transactional session model (CASSANDRA-9143) fixed the pre-4.0 anticompaction races. The cost is structural: the table maintains separate repaired and unrepaired SSTable pools that never compact together, so you have two compaction hierarchies, plus anticompaction work to split partially-overlapping files, plus the risk of orphaned pending-repair SSTables if a session dies (visible via `nodetool repair_admin list`, excluded from normal compaction until cancelled). Full subrange repair has none of that state — every run is independent and idempotent, failures are trivially retried, and there is nothing to corrupt — but it re-validates everything each cycle, which is unaffordable above a couple of TB per node. My default: incremental daily plus a full repair monthly on 4.0+ mid-size clusters; pure full subrange via Reaper on 3.x or where operational simplicity dominates.

**Q: (Senior) A 30-node cluster with 3 TB per node cannot finish a repair cycle inside `gc_grace_seconds`. What do you do?**
A: Short term, buy time and reduce work. Raise `gc_grace_seconds` on the mutable tables to, say, 20 days to widen the deadline while accepting more tombstone scanning — measure `TombstoneScannedHistogram` to check the cost is tolerable. Move to Reaper subrange with `-local`, concurrency 1–2 per DC, segments sized for under 20 minutes, and raise `compaction_throughput_mb_per_sec` inside the window. Then audit which tables actually need repair: run `--preview` per table and find where the divergence really is; append-only TTL tables on TWCS with no deletes usually need very little and can move to a much longer cycle, which on a typical cluster removes most of the bytes. Medium term, the only structural fix is reducing data per node — add nodes, or split the largest table into its own cluster. I would also fix whatever is causing divergence in the first place: persistent dropped mutations or a flapping node make every repair expensive, and `--preview` streaming volume is the metric that reveals it.

**Q: (Senior) What is `nodetool repair --preview` and how would you use it operationally?**
A: A 4.0 read-only mode that performs validation and tree comparison but skips the sync phase, reporting how many ranges and bytes *would* have been streamed. Operationally it is an inconsistency meter. Run it per table on a schedule and trend the result: near-zero means your hints, read repair and existing cycle are keeping up and you can safely lengthen the interval; a sudden jump means something regressed — a node dropping mutations, a flapping replica, a repair schedule that silently stopped. It also lets you justify a repair window to stakeholders with a number instead of an assertion. The related `--validate` mode checks that data already marked repaired really is consistent, which is how you audit incremental repair's correctness.

**Q: Does repairing at `LOCAL_QUORUM` read/write consistency make repair unnecessary?**
A: No. `R + W > RF` guarantees a quorum read observes the latest write; it does not update the stale replicas (except opportunistically via blocking read repair, and only for data you read) and it has nothing to do with tombstone purging. Cold partitions never converge from reads, and the zombie-data failure mode is entirely independent of consistency level.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Repair is the only guaranteed convergence mechanism, and its deadline is `gc_grace_seconds` (864000s / 10 days): every range of every table with deletes must be repaired inside that window or tombstones are purged before they propagate and deleted rows resurrect. Mechanism: each replica runs a **validation compaction** to build a **Merkle tree** (up to `2^15` leaves) over a token range; the coordinator diffs the trees and the disagreeing replicas stream the differing **leaves** — and because a leaf covers many rows, one stale row can move a thousand, which is the whole argument for **subrange repair**. Use `-pr` on **every** node (not a subset) to avoid repairing each range `RF` times; use `-local` for the routine cycle and cross-DC rarely. **Incremental** repair (safe from 4.0, unsafe before) skips already-repaired SSTables and costs proportional to new data, at the price of split repaired/unrepaired compaction pools. Production answer: **Cassandra Reaper**, subrange, weekly, concurrency 1–2 per DC. Measure repair age as the **oldest unrepaired range**, alert at 70% of `gc_grace_seconds`. Repair time — not disk cost — is what caps data per node at 1–2 TB.

| Item | Command / Value | Note |
|---|---|---|
| `gc_grace_seconds` | `864000` (10 days) | The repair deadline |
| Merkle tree leaves | up to `2^15` = 32768 | Streaming granularity |
| Full primary-range, DC-local | `nodetool repair -pr -full -local ks tbl` | Run on **every** node |
| Incremental (4.0+ default) | `nodetool repair -pr ks` | Omit `-full` |
| Subrange | `nodetool repair -st T1 -et T2 -full ks tbl` | Basis of Reaper |
| Preview (no streaming) | `nodetool repair --preview -pr ks tbl` | Inconsistency meter |
| Validate repaired data | `nodetool repair --validate ks tbl` | Audits incremental state |
| Incremental sessions | `nodetool repair_admin list` / `cancel --session <id>` | Find orphans |
| Job threads | `-j 1` (default) up to 4 | Higher = more concurrent validations |
| Watch validation | `nodetool compactionstats` (type `Validation`) | |
| Watch streaming | `nodetool netstats -H` | |
| Repair history | `system_distributed.repair_history` | Per-range truth |
| Percent repaired | `nodetool info \| grep 'Percent Repaired'` | Incremental only |
| Live throttles | `setcompactionthroughput` / `setstreamthroughput` / `setinterdcstreamthroughput` | Not persisted |
| Reaper schedule | `scheduleDaysBetween: 7`, `intensity: 0.9` | Well inside gc_grace |
| Data per node | 1–2 TB | Bounded by repair time |

**Flash cards**
- **What is the repair deadline and why?** → `gc_grace_seconds` (864000s default): past it, tombstones are purged and any replica that missed the delete resurrects the row.
- **Why does one stale row stream a thousand rows?** → Merkle tree streaming granularity is a leaf, and over a large range each leaf covers many rows. Subrange repair shrinks the leaf.
- **What must be true for `-pr` to give full coverage?** → It must be run on every node in every datacenter; it only covers each node's primary ranges.
- **When is incremental repair safe?** → Cassandra 4.0 and later (CASSANDRA-9143 rewrote session tracking); avoid it on 3.x.
- **How do you measure repair age correctly?** → The oldest unrepaired *range* from `system_distributed.repair_history`, not the last successful command.

## 11. Hands-On Exercises & Mini Project

- [ ] Build a 3-node cluster (`ccm create rep -v 4.1.5 -n 3 -s`), create `shop.orders` at `RF=3`, and load 500k rows. Stop node3, write 50k more rows at `LOCAL_QUORUM`, restart node3 after the hint window expires (`max_hint_window_in_ms: 30000`), and count the missing rows on node3 at `CONSISTENCY ONE`. Then run `nodetool repair -pr -full shop orders` on all three nodes and re-count.
- [ ] Run `nodetool repair --preview -pr shop orders` before and after the repair above. Record the bytes it says would stream in each case and confirm it goes to zero.
- [ ] Demonstrate zombie data end to end: set `gc_grace_seconds = 60`, stop node3, delete 1000 rows at `LOCAL_QUORUM`, wait 120 s, run `nodetool compact` on nodes 1 and 2 to purge tombstones, restart node3, run repair, and observe the deleted rows return. Then repeat with `gc_grace_seconds = 864000` and repair *before* the window elapses to show the correct outcome.
- [ ] Compare a full-range repair against a subrange repair over the same data: capture wall-clock time, `nodetool netstats` total bytes streamed, and peak validation compaction duration for each. Quantify the over-streaming difference.
- [ ] Run an incremental repair, then inspect `sstablemetadata` for `Repaired at` on several SSTables and `nodetool info | grep 'Percent Repaired'`. Write 100k new rows, run incremental repair again, and compare the validation volume against a full repair of the same range.
- [ ] Deploy Cassandra Reaper against the ccm cluster, register it, and schedule a repair with `segmentCountPerNode: 16`. Watch segments progress via the REST API and deliberately kill a node mid-run to observe retry and resume behaviour.

### Mini Project — Repair SLO Enforcer

**Goal.** A service that makes "no table is ever within 30% of its `gc_grace_seconds` deadline" an enforced SLO rather than a hope.

**Requirements.**
1. Read every table's `gc_grace_seconds` from `system_schema.tables`.
2. Compute true repair age per table as the **minimum** `finished_at` across all successfully repaired ranges in `system_distributed.repair_history` (fall back to Reaper's API if present).
3. Emit `repair_age_seconds` and `repair_risk_ratio` per table as Prometheus gauges; `WARN` at 0.7, `CRIT` at 0.9.
4. Nightly, run `nodetool repair --preview` per table (throttled, one table at a time) and export `previewed_stream_bytes` so you can trend actual divergence, not just schedule compliance.
5. Produce a weekly report ranking tables by risk and by previewed divergence, with a recommendation per table: shorten cycle, lengthen cycle, or restructure (TTL + TWCS).

**Extensions.**
- Auto-remediate: when a table crosses `WARN`, call Reaper's REST API to schedule a one-off subrange repair for that table only, and record the action.
- Add a **guardrail mode** that watches `ClientRequest` p99 during a repair window and calls `nodetool setcompactionthroughput`/`setstreamthroughput` down automatically if latency crosses the SLO, then restores it.
- Add a synthetic zombie canary: write a row, delete it, and verify at `CONSISTENCY ONE` against every replica (via `nodetool getendpoints`) that it stays deleted across a full `gc_grace_seconds` window — a direct, end-to-end test of the property repair exists to protect.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Hinted Handoff, Read Repair & Anti-Entropy* (ch. 25) introduces the three mechanisms and where repair sits among them; *Tombstones & Deletes* explains `gc_grace_seconds` and resurrection in depth; *Compaction Strategies* explains why TWCS changes the repair calculus; *Storage Engine & SSTable Format* (ch. 26) explains `repairedAt` and what streaming moves; *nodetool & Everyday Cluster Operations* (ch. 27) covers the surrounding commands; *Adding, Removing & Replacing Nodes* (ch. 28) lists which topology operations mandate a repair afterwards.

- **Apache Cassandra Docs — Repair** — Apache Software Foundation · *Advanced* · the authoritative reference for full vs incremental, `-pr`, preview mode and repair internals. <https://cassandra.apache.org/doc/latest/cassandra/managing/operating/repair.html>
- **Cassandra Reaper** — The Last Pickle / DataStax (open source) · *Intermediate* · docs and REST API for the de-facto repair scheduler; read the segmentation and intensity sections carefully. <http://cassandra-reaper.io/>
- **The Last Pickle — Should you use incremental repair?** — Alexander Dejanovski · *Advanced* · the definitive practitioner analysis of why incremental repair was dangerous pre-4.0 and what changed. <https://thelastpickle.com/blog/2017/12/14/should-you-use-incremental-repair.html>
- **CASSANDRA-9143 — Improving consistency of repairAt field** — Apache JIRA · *Expert* · the 4.0 incremental repair rewrite with the transactional session model. <https://issues.apache.org/jira/browse/CASSANDRA-9143>
- **CASSANDRA-13257 — Preview repair** — Apache JIRA · *Advanced* · the design of `--preview` and `--validate`, and how to interpret their output. <https://issues.apache.org/jira/browse/CASSANDRA-13257>
- **Dynamo: Amazon's Highly Available Key-value Store** — DeCandia et al., SOSP 2007 · *Advanced* · section 4.7 is the Merkle-tree anti-entropy design Cassandra inherits directly. <https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf>
- **DataStax Docs — Manual repair: Anti-entropy repair** — DataStax · *Intermediate* · clear diagrams of validation, tree comparison and streaming with practical scheduling advice. <https://docs.datastax.com/en/cassandra-oss/3.x/cassandra/operations/opsRepairNodesManualRepair.html>
- **ApacheCon / Cassandra Summit — repair and Reaper talks** — Apache Software Foundation (YouTube) · *Advanced* · operators walking through real repair incidents and the schedules they settled on. <https://www.youtube.com/@PlanetCassandra>

---

*Apache Cassandra Handbook — chapter 29.*
