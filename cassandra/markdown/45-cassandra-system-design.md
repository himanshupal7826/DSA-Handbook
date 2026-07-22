# 45 · Cassandra System Design (Interview)

> **In one line:** A Cassandra design round is won by enumerating access patterns first, deriving one table per query, proving every partition is bounded with arithmetic, and then defending your consistency levels against a named failure.

---

## 1. Overview

The Cassandra system-design interview is not a distributed-systems trivia quiz. It is a modelling exercise with a very specific rubric: can you go from a vague product requirement to a schema where every read is a single-partition lookup, every partition has a computable size bound, and every consistency choice has a stated reason? Candidates fail this round in predictable ways — they design a normalised schema and then discover they need a join, or they choose a partition key that grows without limit, or they say "eventually consistent" without being able to say what that means for the user staring at the screen.

The problem this chapter solves is **converting requirements into defensible Cassandra artefacts under time pressure**. You get roughly 45 minutes. That is enough for: five minutes of requirements, five minutes of capacity arithmetic, fifteen minutes of data modelling, ten minutes of architecture and failure analysis, and ten minutes of the interviewer's follow-ups. The candidates who do well allocate that budget deliberately and *say the numbers out loud*.

A short history of why the rubric looks like this: relational modelling teaches you to normalise and let the query planner figure out access. Cassandra has no join, no query planner worth the name, and no efficient way to scan across partitions. So the discipline inverts — you enumerate queries, then design one denormalised table per query, and accept that the same fact is written to three or four places. Interviewers use this round precisely because the inversion is uncomfortable and reveals whether you have actually operated the thing.

**Concrete example.** The single most common prompt is "design the message storage for a chat product." A weak answer produces `messages(message_id PRIMARY KEY, channel_id, ts, body)` and a secondary index on `channel_id`. A strong answer produces `messages_by_channel` with `PRIMARY KEY ((channel_id, bucket), message_id)`, states that a bucket holds 10 days for a normal channel, computes that a 10k-messages-per-day channel yields a 40 MB partition, notices that a 500k-messages-per-day channel would yield 2 GB, and therefore proposes *tier-dependent bucket widths* stored in channel metadata. That last move — noticing the distribution is not uniform and designing for the tail — is what separates senior from mid.

The durable mental model for the whole round: **queries → tables → partition-size proof → capacity arithmetic → consistency levels → failure walk-through.** In that order, every time, for every prompt.

## 2. Core Concepts

- **Access pattern (query) list** — the enumerated set of reads and writes the product needs, written before any schema. In Cassandra this *is* the design document.
- **One table per query** — the core modelling rule: denormalise so that each read is `SELECT ... WHERE partition_key = ? [AND clustering ...]`, hitting one partition on `RF` replicas.
- **Partition key vs clustering key** — the partition key determines *which node*; the clustering key determines *sort order within the partition*. Range queries are only cheap inside a partition.
- **Bucketing (time or hash)** — adding a synthetic component to the partition key to keep partitions under ~100 MB and ~100k rows when the natural key is unbounded.
- **Partition-size formula** — `Nv = Nr × (Nc − Npk − Ns) + Ns` gives values per partition; `St ≈ Σ(key sizes) + Nr × Σ(row column sizes) + Nv × 8` bytes gives the size. Quote it; interviewers love it.
- **Fan-out on write vs fan-out on read** — precompute each user's timeline at post time (fast reads, expensive writes) versus assemble it at query time (cheap writes, slow reads). Real systems use a hybrid split by follower count.
- **Write amplification factor** — how many table rows one logical event produces. A post with 200 followers under fan-out-on-write has an amplification of 200; this number drives your entire capacity model.
- **Time-window compaction (TWCS)** — compaction strategy for append-only, TTL'd time-series data; expired windows are dropped as whole SSTables instead of being compacted away row by row.
- **Idempotent write** — a write that can be retried safely. Cassandra writes are naturally idempotent *except* counters, which is why counters break retries and migrations.
- **Consistency budget** — the deliberate assignment of `ONE` / `LOCAL_QUORUM` / `LOCAL_SERIAL` per access pattern, justified by what the user would observe if it were weaker.

## 3. Theory & Internals: the arithmetic you must do out loud

Three calculations decide most of the round.

**1. Partition size.** DataStax's formulas, worth memorising:

```
Nv = Nr x (Nc - Npk - Ns) + Ns
     Nr  = rows per partition
     Nc  = total columns
     Npk = partition-key columns
     Ns  = static columns

St = SUM(sizeof partition key cols)
   + SUM(sizeof static cols)
   + Nr x ( SUM(sizeof clustering cols) + SUM(sizeof regular cols) )
   + Nv x 8 bytes            (per-cell timestamp metadata)
```

Target `St < 100 MB` and `Nr < 100,000`. If the natural key blows through that, you bucket. The bucket width follows directly:

```
bucket_width = target_rows / peak_rows_per_unit_time
e.g. 100,000 rows target / 10,000 msgs per day  ->  10-day bucket
     100,000 rows target / 500,000 msgs per day ->  0.2-day bucket (~4 hours)
```

**2. Storage and node count.**

```
raw_bytes_per_day = events_per_day x avg_event_bytes x write_amplification
stored            = raw_bytes_per_day x retention_days x RF
nodes_per_dc      = stored / (usable_disk_per_node x 0.5)
```

The `0.5` is not padding — size-tiered compaction can transiently require free space equal to the SSTables being merged, so you plan on filling at most half the disk. Leveled compaction lets you push toward 70%; Unified Compaction Strategy (Cassandra 5.0) gives you a tunable middle ground.

**3. Consistency.** State it as an inequality every time:

```
QUORUM        = floor(RF/2) + 1                 RF=3 -> 2, RF=5 -> 3
LOCAL_QUORUM  = floor(RF_local/2) + 1           per-DC, no WAN on the write path
strong read-your-writes when  R + W > RF
   W=LOCAL_QUORUM(2) + R=LOCAL_QUORUM(2) > RF_local(3)   OK
   W=ONE(1)          + R=LOCAL_QUORUM(2) = 3 = RF        NOT strong
```

And know the exception: compare-and-set (`IF NOT EXISTS`, `IF col = ?`) uses Paxos at `SERIAL`/`LOCAL_SERIAL`, costs roughly four round trips, and does not compose across partitions. Use it for account creation and unique-username claims; never for a hot path.

```svg
<svg viewBox="0 0 760 350" width="100%" height="350" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="760" height="350" fill="#ffffff"/> <text x="380" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">Bounded partitions: from access pattern to bucket width</text>
  <rect x="20" y="40" width="200" height="120" rx="10" fill="#eef2ff" stroke="#4f46e5"/> <text x="120" y="62" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">1. Access pattern</text>
  <text x="120" y="84" text-anchor="middle" fill="#1e293b" font-size="10">newest 50 messages</text> <text x="120" y="101" text-anchor="middle" fill="#1e293b" font-size="10">in a channel, paging back</text>
  <text x="120" y="126" text-anchor="middle" fill="#1e293b" font-size="10">write: append only</text> <text x="120" y="143" text-anchor="middle" fill="#1e293b" font-size="10">read:write about 10:1</text> <rect x="248" y="40" width="230" height="120" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="363" y="62" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">2. Naive key: channel_id</text> <rect x="266" y="76" width="194" height="30" rx="6" fill="#ffffff" stroke="#d97706"/>
  <text x="363" y="96" text-anchor="middle" fill="#1e293b" font-size="10">40 M rows, 6 GB, one owner</text> <text x="363" y="124" text-anchor="middle" fill="#d97706" font-size="10" font-weight="700">Nr &gt; 100k and St &gt; 100 MB</text>
  <text x="363" y="143" text-anchor="middle" fill="#1e293b" font-size="10">compaction and reads degrade</text> <rect x="506" y="40" width="234" height="120" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="623" y="62" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">3. Bucket width from math</text> <text x="623" y="86" text-anchor="middle" fill="#1e293b" font-size="10">100,000 / msgs_per_day</text>
  <text x="623" y="106" text-anchor="middle" fill="#16a34a" font-size="10" font-weight="700">10k/day &#8594; 10-day bucket</text> <text x="623" y="124" text-anchor="middle" fill="#16a34a" font-size="10" font-weight="700">500k/day &#8594; 4-hour bucket</text>
  <text x="623" y="145" text-anchor="middle" fill="#1e293b" font-size="10">store width in channel metadata</text> <line x1="222" y1="100" x2="246" y2="100" stroke="#4f46e5" stroke-width="2"/> <line x1="480" y1="100" x2="504" y2="100" stroke="#0ea5e9" stroke-width="2"/>
  <rect x="20" y="180" width="720" height="150" rx="10" fill="#ffffff" stroke="#4f46e5"/> <text x="380" y="202" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Resulting ring placement: buckets spread the channel across the cluster</text>
  <circle cx="380" cy="270" r="52" fill="none" stroke="#94a3b8" stroke-width="2"/> <circle cx="380" cy="218" r="9" fill="#eef2ff" stroke="#4f46e5"/><circle cx="432" cy="270" r="9" fill="#e0f2fe" stroke="#0ea5e9"/>
  <circle cx="380" cy="322" r="9" fill="#f0fdf4" stroke="#16a34a"/><circle cx="328" cy="270" r="9" fill="#fef3c7" stroke="#d97706"/> <circle cx="417" cy="233" r="9" fill="#eef2ff" stroke="#4f46e5"/><circle cx="417" cy="307" r="9" fill="#e0f2fe" stroke="#0ea5e9"/>
  <circle cx="343" cy="307" r="9" fill="#f0fdf4" stroke="#16a34a"/><circle cx="343" cy="233" r="9" fill="#fef3c7" stroke="#d97706"/> <text x="150" y="240" text-anchor="middle" fill="#1e293b" font-size="10">(chan 42, b=1994) &#8594; token 0x1a..</text>
  <text x="150" y="262" text-anchor="middle" fill="#1e293b" font-size="10">(chan 42, b=1995) &#8594; token 0x93..</text> <text x="150" y="284" text-anchor="middle" fill="#1e293b" font-size="10">(chan 42, b=1996) &#8594; token 0x4c..</text>
  <text x="150" y="308" text-anchor="middle" fill="#16a34a" font-size="10" font-weight="700">different tokens = different owners</text> <text x="612" y="252" text-anchor="middle" fill="#1e293b" font-size="10">reads touch 1 bucket</text>
  <text x="612" y="274" text-anchor="middle" fill="#1e293b" font-size="10">scroll-back walks buckets</text> <text x="612" y="296" text-anchor="middle" fill="#1e293b" font-size="10">TWCS drops expired windows</text>
</svg>
```

## 4. Architecture & Workflow: running the round

The eight moves, in order. Narrate each one.

1. **Clarify scope and scale (3 min).** Ask for DAU, events/day, read:write ratio, retention, latency SLO, and whether multi-region is required. Write the numbers on the board — you will use every one.
2. **Enumerate access patterns (5 min).** List them as `Q1..Qn` with expected QPS. "Q1: fetch newest 50 messages in a channel — 150k QPS. Q2: page backwards — 20k QPS. Q3: list my channels by recency — 30k QPS. Q4: unread count per channel — 60k QPS."
3. **Design one table per query (10 min).** Name each table after its query. Do not reuse a table for two access patterns unless the partition key and sort order genuinely match.
4. **Prove the bounds (5 min).** For each table, state rows-per-partition and bytes-per-partition, and show they are under 100k / 100 MB. If not, bucket, and show the arithmetic.
5. **Size the cluster (3 min).** Storage per day × retention × RF ÷ (usable disk × 0.5). Then sanity-check against throughput: roughly 10–20k writes/sec per modern node for small rows is a defensible planning figure, to be validated by benchmark.
6. **Assign consistency levels (3 min).** Per access pattern, with justification. `LOCAL_QUORUM` for anything a user reads back immediately; `ONE` for analytics-grade reads; `LOCAL_SERIAL` only for genuine uniqueness constraints.
7. **Walk a failure (5 min).** Pick one: a replica down, a whole AZ down, a hot partition, a region evacuation. Say exactly what the client sees and what recovers it (hints, read repair, scheduled repair).
8. **Name what you would not do in Cassandra (2 min).** Analytics, ad-hoc filtering, cross-partition transactions, queues, and secondary indexes on high-cardinality columns. Volunteering the boundaries is a strong senior signal.

```svg
<svg viewBox="0 0 760 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="760" height="360" fill="#ffffff"/> <text x="380" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">Feed design: hybrid fan-out architecture</text> <rect x="20" y="40" width="150" height="60" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="95" y="64" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">POST /tweet</text> <text x="95" y="82" text-anchor="middle" fill="#1e293b" font-size="10">write service</text> <line x1="170" y1="70" x2="204" y2="70" stroke="#4f46e5" stroke-width="2"/>
  <rect x="206" y="40" width="160" height="60" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/> <text x="286" y="64" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">posts_by_id (source)</text>
  <text x="286" y="82" text-anchor="middle" fill="#1e293b" font-size="10">+ posts_by_user</text> <line x1="366" y1="70" x2="400" y2="70" stroke="#0ea5e9" stroke-width="2"/> <rect x="402" y="40" width="150" height="60" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="477" y="64" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">Kafka: post events</text> <text x="477" y="82" text-anchor="middle" fill="#1e293b" font-size="10">durable, replayable</text> <line x1="552" y1="70" x2="586" y2="70" stroke="#d97706" stroke-width="2"/>
  <rect x="588" y="40" width="152" height="60" rx="8" fill="#f0fdf4" stroke="#16a34a"/> <text x="664" y="60" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">fan-out workers</text>
  <text x="664" y="78" text-anchor="middle" fill="#1e293b" font-size="10">followers &lt; 100k only</text> <text x="664" y="93" text-anchor="middle" fill="#d97706" font-size="9">celebrities skipped</text> <line x1="664" y1="100" x2="664" y2="130" stroke="#16a34a" stroke-width="2"/>
  <rect x="480" y="132" width="260" height="52" rx="8" fill="#ffffff" stroke="#16a34a"/> <text x="610" y="152" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">home_timeline (precomputed)</text>
  <text x="610" y="170" text-anchor="middle" fill="#1e293b" font-size="10">((user_id, bucket), post_ts DESC, post_id)</text> <rect x="20" y="132" width="260" height="52" rx="8" fill="#ffffff" stroke="#0ea5e9"/>
  <text x="150" y="152" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">posts_by_user (pull at read)</text> <text x="150" y="170" text-anchor="middle" fill="#1e293b" font-size="10">((author_id, bucket), post_id DESC)</text>
  <rect x="230" y="212" width="300" height="60" rx="10" fill="#eef2ff" stroke="#4f46e5"/> <text x="380" y="234" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">GET /home read service</text>
  <text x="380" y="252" text-anchor="middle" fill="#1e293b" font-size="10">merge precomputed page + celebrity pulls, sort by ts</text> <text x="380" y="266" text-anchor="middle" fill="#1e293b" font-size="10">LOCAL_QUORUM, page size 50</text>
  <line x1="150" y1="184" x2="290" y2="210" stroke="#0ea5e9" stroke-width="2"/> <line x1="610" y1="184" x2="470" y2="210" stroke="#16a34a" stroke-width="2"/> <rect x="230" y="290" width="300" height="52" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="380" y="311" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">write amplification budget</text> <text x="380" y="329" text-anchor="middle" fill="#1e293b" font-size="10">50 M posts/day x 200 followers = 10 B row writes/day</text>
  <line x1="380" y1="272" x2="380" y2="288" stroke="#4f46e5" stroke-width="2"/>
</svg>
```

## 5. Implementation: three worked designs

### Design A — Messaging store (Slack/Discord-shaped)

*Given:* 1 B messages/day, ~400 bytes each, read:write 10:1, 1-year retention, two regions, P99 read < 30 ms.

*Capacity:* `1e9 × 400 B = 400 GB/day` raw → `× RF 3 = 1.2 TB/day` → `× 365 = 438 TB` per region. With 3.75 TB NVMe nodes at 50% fill, `438 / 1.875 ≈ 234` nodes per region; provision 260. Writes average `1e9/86400 ≈ 11.6k/s`, peak 3× ≈ **35k writes/sec**, comfortably inside 260 nodes.

```cql
CREATE KEYSPACE chat WITH replication =
  {'class':'NetworkTopologyStrategy','us_east':3,'eu_west':3};

-- Q1/Q2: newest N messages in a channel, page backwards.
CREATE TABLE chat.messages_by_channel (
  channel_id bigint, bucket int, message_id bigint, author_id bigint,
  body text, edited_at timestamp, deleted boolean,
  PRIMARY KEY ((channel_id, bucket), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC)
  AND compaction = {'class':'TimeWindowCompactionStrategy',
                    'compaction_window_unit':'DAYS','compaction_window_size':1};

-- Bucket width is per channel, not global: high-volume channels get narrow buckets.
CREATE TABLE chat.channels (
  channel_id bigint PRIMARY KEY, name text, bucket_seconds int, msgs_per_day_est bigint);

-- Q3: my channels, most recently active first.
CREATE TABLE chat.channels_by_user (
  user_id bigint, last_message_id bigint, channel_id bigint, unread_hint int,
  PRIMARY KEY (user_id, last_message_id, channel_id)
) WITH CLUSTERING ORDER BY (last_message_id DESC);

-- Q4: read cursor. One row, overwritten - no tombstones, no counters.
CREATE TABLE chat.read_state (
  channel_id bigint, user_id bigint, last_read_message_id bigint,
  PRIMARY KEY ((channel_id, user_id)));

-- Q5: permalink by message id (a tiny lookup table, not a secondary index).
CREATE TABLE chat.message_location (
  message_id bigint PRIMARY KEY, channel_id bigint, bucket int);
```

> **Note:** `deleted boolean` instead of `DELETE`. A soft delete is an ordinary write — no tombstone, no `gc_grace_seconds` exposure, no read-time tombstone scanning. Physical removal rides on the table's TTL. This single decision avoids the failure mode that hurt Discord most.

```python
# Token-aware, DC-aware, LOCAL_QUORUM by default; idempotent so retries are safe.
profile = ExecutionProfile(
    load_balancing_policy=TokenAwarePolicy(DCAwareRoundRobinPolicy(local_dc="us_east")),
    consistency_level=ConsistencyLevel.LOCAL_QUORUM, request_timeout=2.0)
session = Cluster(["c1"], execution_profiles={EXEC_PROFILE_DEFAULT: profile}).connect("chat")

INSERT_MSG = session.prepare(
  "INSERT INTO messages_by_channel (channel_id,bucket,message_id,author_id,body,deleted) "
  "VALUES (?,?,?,?,?,false) USING TTL 31536000")
INSERT_MSG.is_idempotent = True          # required for speculative retries

def send(channel_id, bucket_seconds, msg_id, author_id, body):
    bucket = ((msg_id >> 22) + EPOCH_MS) // (bucket_seconds * 1000)
    session.execute(INSERT_MSG, (channel_id, bucket, msg_id, author_id, body))
    session.execute(TOUCH_CHANNEL, (msg_id, channel_id, author_id))   # channels_by_user
```

### Design B — Time-series / IoT metrics platform

*Given:* 10 M devices × 6 metrics × 1 sample per 10 s ≈ **6 M writes/sec**; raw retention 7 days, 1-minute rollups 90 days, 1-hour rollups 2 years.

*Capacity:* raw sample ≈ 40 bytes stored. `6e6 × 40 B = 240 MB/s = 20.7 TB/day` × RF 3 = 62 TB/day × 7 = **435 TB** for raw. Rollups: 1-minute is 1/6 the rate → `6e6/6 = 1e6/s` ... over 90 days ≈ 310 TB. This is where you say out loud: *the rollups cost more than the raw data, so retention policy is the main cost lever.*

*Partition bound:* `(device_id, metric, day)` gives `8640` rows/day × ~40 B ≈ **345 KB** — comfortably bounded, ideal.

```cql
CREATE TABLE iot.readings_raw (
  device_id uuid, metric text, day date, ts timestamp, value double,
  PRIMARY KEY ((device_id, metric, day), ts)
) WITH CLUSTERING ORDER BY (ts DESC)
  AND default_time_to_live = 604800          -- 7 days
  AND gc_grace_seconds = 10800               -- safe ONLY because we never DELETE
  AND compaction = {'class':'TimeWindowCompactionStrategy',
                    'compaction_window_unit':'HOURS','compaction_window_size':6};

CREATE TABLE iot.readings_1m (
  device_id uuid, metric text, month int, ts timestamp, min_v double,
  max_v double, sum_v double, cnt bigint, PRIMARY KEY ((device_id, metric, month), ts)
) WITH CLUSTERING ORDER BY (ts DESC)
  AND default_time_to_live = 7776000         -- 90 days
  AND compaction = {'class':'TimeWindowCompactionStrategy',
                    'compaction_window_unit':'DAYS','compaction_window_size':1};
```

> **Note:** TWCS window sizing rule — aim for **20–40 windows alive at once**. 7-day retention with 6-hour windows gives 28. Too many windows means too many SSTables per read; too few means expired data lingers.

```bash
# Ingest is Kafka -> consumer -> UNLOGGED batch, and ONLY same-partition batches;
# a cross-partition batch turns one coordinator into a fan-out bottleneck.
cqlsh> BEGIN UNLOGGED BATCH
  INSERT INTO iot.readings_raw (device_id,metric,day,ts,value) VALUES (...);
  INSERT INTO iot.readings_raw (device_id,metric,day,ts,value) VALUES (...);
APPLY BATCH;    -- same (device_id, metric, day): one partition, one replica set

nodetool tablestats iot.readings_raw | grep -E "SSTable count|Space used \(live\)"
# SSTable count: 29     <- matches ~28 live TWCS windows: expired ones dropped whole
```

### Design C — Social feed (hybrid fan-out)

*Given:* 100 M users, 50 M posts/day, median 200 followers, celebrity tail up to 100 M followers, home timeline shows 30 days.

*Capacity:* fan-out-on-write for everyone is `50e6 × 200 = 10 B row writes/day ≈ 116k/s average, ~350k/s peak`. A single celebrity post would be 100 M writes — unacceptable. **Hybrid:** fan out only for authors with `< 100,000` followers; pull celebrity posts at read time and merge.

```cql
CREATE TABLE feed.posts_by_id (
  post_id timeuuid PRIMARY KEY, author_id bigint, body text, created_at timestamp);

CREATE TABLE feed.posts_by_user (          -- pull path for celebrities
  author_id bigint, bucket int, post_id timeuuid, body text,
  PRIMARY KEY ((author_id, bucket), post_id)) WITH CLUSTERING ORDER BY (post_id DESC);

CREATE TABLE feed.home_timeline (          -- push path for everyone else
  user_id bigint, bucket int, post_id timeuuid, author_id bigint,
  PRIMARY KEY ((user_id, bucket), post_id)
) WITH CLUSTERING ORDER BY (post_id DESC)
  AND default_time_to_live = 2592000;      -- 30 days: the timeline is a cache

CREATE TABLE feed.celebrity_follows (      -- which celebrities do I follow?
  user_id bigint, author_id bigint, PRIMARY KEY (user_id, author_id));
```

```python
def home_page(user_id, bucket, limit=50):
    pushed = session.execute(SEL_HOME, (user_id, bucket, limit))          # 1 partition
    celebs = session.execute(SEL_CELEB_FOLLOWS, (user_id,))               # 1 partition
    pulls  = [session.execute_async(SEL_POSTS_BY_USER, (c.author_id, bucket, limit))
              for c in celebs]                                            # bounded fan-out
    rows = list(pushed) + [r for f in pulls for r in f.result()]
    return sorted(rows, key=lambda r: r.post_id.time, reverse=True)[:limit]
# Bound the celebrity fan-out (cap the follow list, cache celebrity pages in Redis for 5s).
```

**Optimization note.** In all three designs, the highest-leverage optimisation is the same and it is not a Cassandra setting: **make the hot read cacheable**. Channel pages, celebrity post pages and current-hour metric windows are all read far more often than they change. A 5-second cache in front of the read path, plus single-flight coalescing, routinely removes 90% of coordinator load — and it is the answer interviewers are waiting to hear when they ask "what if one channel gets 500k concurrent readers?"

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| **One table per query** | Every read is a single-partition, single-hop lookup with predictable latency | The same fact is written 3–5 times; application code owns consistency between tables |
| **Time bucketing** | Bounded partitions, TWCS window drops, spreads a hot entity across the ring | Scroll-back spans buckets; wrong width means either giant partitions or excessive reads |
| **Fan-out on write** | Home timeline read is one partition read, ~5 ms | Write amplification equals follower count; celebrities are catastrophic without a cap |
| **Fan-out on read** | Cheap writes, no amplification, no stale timeline entries | Read must merge N author partitions; latency grows with follow count |
| **Hybrid fan-out** | Bounded on both sides; the industry-standard answer | Two code paths, a threshold to tune, and merge logic that must be correct |
| **Soft delete over `DELETE`** | No tombstones, no `gc_grace_seconds` exposure, no read-time tombstone scans | Rows persist until TTL; storage cost and "right to be forgotten" needs a real purge path |
| **`LOCAL_QUORUM` everywhere** | Read-your-writes within a region, no WAN on the write path | Two of three local replicas must be up; cross-region convergence is asynchronous |
| **Counters for unreads/likes** | Native, simple to write | Not idempotent, cannot be replayed or migrated safely, poor at high contention — prefer a cache with periodic flush |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Designing tables before enumerating queries.** → ✅ Write `Q1..Qn` with QPS first, then name each table after the query it serves. Interviewers grade the order.
2. ⚠️ **An unbounded partition key** (`channel_id`, `device_id`, `user_id` alone). → ✅ Bucket, and show `100,000 / rows_per_day = bucket_width` on the board.
3. ⚠️ **Reaching for a secondary index to answer a new query.** → ✅ Build another table. Native secondary indexes on high-cardinality columns scatter to every node; Cassandra 5.0's SAI is far better but still not a substitute for a purpose-built table on a hot path.
4. ⚠️ **`ALLOW FILTERING` anywhere in a design round.** → ✅ It signals a full scan. Say "that query needs its own table" instead — or an analytics path via Spark.
5. ⚠️ **Using a logged batch to get transactions.** → ✅ Logged batches give atomicity, not isolation, and cost a batchlog write to two nodes. Use them only for keeping denormalised tables in sync; use unlogged, single-partition batches for throughput.
6. ⚠️ **Read-before-write** (`SELECT` then `UPDATE` to increment or append). → ✅ Model so writes are blind and idempotent, or use a counter/`LWT` knowingly with its cost stated.
7. ⚠️ **Ignoring the tail of the distribution.** → ✅ Always ask "what does the 99.9th-percentile channel/device/author look like?" and design the bucket width or fan-out threshold for *that*, not the median.
8. ⚠️ **Choosing `QUORUM` in a multi-DC design.** → ✅ `LOCAL_QUORUM`. `QUORUM` across two RF=3 DCs needs 4 acks and puts WAN latency on every write.
9. ⚠️ **Modelling a job queue** (claim, process, delete). → ✅ That is the tombstone anti-pattern. Kafka owns the queue; Cassandra owns the results.
10. ⚠️ **Quoting node counts without compaction headroom, and staying silent about failure.** → ✅ Divide usable disk by two for STCS and say "50% headroom for compaction" out loud. Then volunteer a failure walk-through before being asked: replica down → hinted handoff; hint window exceeded → read repair and scheduled repair; whole AZ down → `LOCAL_QUORUM` still satisfiable with rack-aware placement.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging (what you say when asked "it's slow, now what?").** Reach for `nodetool tablehistograms <ks> <tbl>` first: the max partition size finds a modelling error, and P99 SSTables-per-read finds a compaction problem. Then `nodetool tpstats` for dropped `MUTATION` and blocked `Native-Transport-Requests` (node beyond capacity), and `nodetool compactionstats` for a growing backlog. `TRACING ON` in cqlsh for a single slow query shows exactly how many replicas and SSTables were touched. Cassandra 4.0 virtual tables let you do this in CQL: `SELECT * FROM system_views.local_read_latency;`.

**Monitoring.** Name real beans in the round: `org.apache.cassandra.metrics:type=ClientRequest,scope=Read,name=Latency` (P99/P999), `...,name=Timeouts` and `name=Unavailables`, `type=Table,name=SSTablesPerReadHistogram`, `type=Table,name=TombstoneScannedHistogram`, `type=Table,name=MaxPartitionSize`, `type=Compaction,name=PendingTasks`, `type=DroppedMessage,scope=MUTATION`. Add an application-level metric for *repair age per table* — the single best predictor of a correctness incident.

**Security.** For any design touching user messages: client and internode TLS, role-based auth with a distinct role per service and per-keyspace grants, `audit_logging_options` (4.0+) shipped off-node, and disk-level encryption at rest since open-source Cassandra stores SSTables as plain files. If the interviewer raises GDPR deletion, note that soft-delete-plus-TTL is not sufficient for a legal erasure request — you need a real `DELETE` path plus repair, and that is precisely the case where tombstones are unavoidable.

**Performance & Scaling.** Plan on roughly 10–20k small writes/sec per modern node and 1–4 TB of data per node so bootstrap and repair stay tractable (zero-copy streaming in 4.0 helps a lot). Keep `num_tokens` at the 4.x default of 16. Add capacity before disk crosses 50–60%. Scale reads with the coalescing/cache layer, not with more nodes — nodes do not help a hot partition. For multi-region, provision each region to absorb a failed peer's traffic at peak, and rehearse the evacuation.

## 9. Interview Questions

**Q: Walk me through your process for a Cassandra design question.**
A: Clarify scale and SLOs, enumerate the access patterns with QPS, design one table per query, prove each partition is under ~100k rows and ~100 MB with arithmetic, size the cluster from bytes/day × retention × RF ÷ (disk × 0.5), assign a consistency level per pattern with a reason, and walk one concrete failure. Then state explicitly what I would *not* put in Cassandra.

**Q: How do you decide bucket width?**
A: Divide the target rows per partition by the peak rows per unit time for the hottest entity: `100,000 / 10,000 per day = a 10-day bucket`. Crucially, use the hot tail rather than the median, and if the spread is wide, store the width per entity in a metadata table so high-volume channels or devices get narrower buckets than quiet ones.

**Q: Fan-out on write or on read for a social feed?**
A: Hybrid. Fan out on write for authors below a follower threshold — typically around 100k — so the common case is a single-partition timeline read. For celebrities, skip the fan-out and pull their recent posts at read time, merging by timestamp. Pure push explodes on a 100 M-follower post; pure pull makes every timeline read a large fan-out.

**Q: Why not use a secondary index instead of a second table?**
A: A native secondary index is local to each node, so a query on it scatters to every node in the DC and its latency is bounded by the slowest replica — it is only viable on low-cardinality columns within a known partition. Cassandra 5.0's SAI is much cheaper and supports numeric ranges, but a purpose-built table is still the right answer for a high-QPS path because it is a single-partition read.

**Q: What consistency levels would you use for a chat app and why?**
A: `LOCAL_QUORUM` for both message writes and message reads, because the sender must immediately see their own message and `2 + 2 > 3` guarantees it within the region. Read cursors can be `LOCAL_ONE` since a slightly stale unread marker is harmless. Nothing needs `SERIAL` — Snowflake ids make message uniqueness a client-side property rather than a compare-and-set.

**Q: How do you handle message deletion without tombstone problems?**
A: Soft delete: write `deleted = true` as an ordinary column update, filter at the application layer, and let the table's TTL remove the row physically later. That converts a delete into a normal idempotent write with no `gc_grace_seconds` exposure and no tombstone scanning at read time. Genuine erasure requests still need a real `DELETE` plus repair inside `gc_grace_seconds`.

**Q: You need "total likes on a post." Counter table or something else?**
A: Prefer something else on a hot path. Counters are not idempotent, so a retried write can double-count, and they are expensive under contention because each update is a read-modify-write on the replica. The common production answer is to increment in Redis, persist periodic snapshots to Cassandra, and accept an approximate count between flushes.

**Q: (Senior) Design the messaging store for a product where 0.01% of channels carry 60% of traffic.**
A: Three layers. First, per-channel bucket widths from metadata so a 500k-messages-per-day channel gets four-hour buckets rather than ten-day ones. Second, a data-service layer with single-flight coalescing so N concurrent readers of the same hot bucket produce one coordinator read. Third, a short-TTL cache of the newest page, since the hot channel's newest 50 messages are read orders of magnitude more often than they change. Adding nodes does not help — a partition is always served by exactly `RF` replicas.

**Q: (Senior) Your time-series design uses TWCS with 7-day TTL. What breaks if someone issues a single `DELETE`?**
A: TWCS assumes data is append-only and expires by TTL, so a delete writes a tombstone that may land in a different time window than the data it shadows, preventing the window from being dropped whole and forcing cross-window compaction. If you have also lowered `gc_grace_seconds` — common for TTL-only tables — that tombstone may be purged before every replica has seen it, resurrecting the deleted rows. The rule is: TWCS tables get no explicit deletes, and if you need them, restore the default `gc_grace_seconds` and ensure repair runs inside it.

**Q: (Senior) The product now wants full-text search over messages. What do you do?**
A: Not in Cassandra as the primary path. Stream messages to a search engine — Elasticsearch or OpenSearch — via CDC or the same Kafka topic that feeds Cassandra, and treat Cassandra as the system of record and the search index as a derived, rebuildable view. Cassandra 5.0's SAI adds real index capability including vector ANN for semantic search, which is genuinely useful for bounded per-partition filtering and embedding retrieval, but it is not a substitute for an inverted index over a corpus.

**Q: (Senior) How do you size a cluster when you have no production numbers yet?**
A: Bound it from both directions. From storage: events/day × bytes × amplification × retention × RF ÷ (usable disk × 0.5). From throughput: a defensible planning figure of 10–20k small writes/sec per node, then divide peak QPS. Take the larger, add 30% for growth and 1 node of failure headroom per rack, and state clearly that the number is a hypothesis to be replaced by a `cassandra-stress` run against the real schema and key distribution.

**Q: What would you refuse to build in Cassandra?**
A: Anything requiring cross-partition transactions or joins, ad-hoc analytical queries, a work queue with claim-and-delete semantics, strongly consistent global counters, and reporting that scans across partitions. Those go to a relational store, a warehouse, Kafka, or Spark reading Cassandra offline — and saying so early is a signal of judgement, not of limitation.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Run the round in a fixed order: scope → access patterns with QPS → one table per query → partition-bound proof → cluster sizing → consistency per pattern → failure walk-through → explicit non-goals. Memorise three formulas: `Nv = Nr(Nc − Npk − Ns) + Ns` with `St < 100 MB` and `Nr < 100k`; `bucket_width = 100,000 / peak_rows_per_period`; `nodes = events/day × bytes × amp × days × RF ÷ (disk × 0.5)`. Memorise the consistency inequality: `QUORUM = floor(RF/2)+1`, strong when `R + W > RF`, and always `LOCAL_QUORUM` in multi-DC. Messaging = bucketed channel partitions with per-channel widths, soft deletes, coalescing for hot channels. Time series = `((device, metric, day), ts)` with TTL and TWCS sized to 20–40 live windows and no explicit deletes. Feed = hybrid fan-out with a ~100k-follower threshold, timeline as a 30-day TTL'd cache. Never: `ALLOW FILTERING`, high-cardinality secondary indexes, logged batches as transactions, queues, unbounded partitions.

| Design element | Rule of thumb | Why |
|---|---|---|
| Partition size | < 100 MB and < 100k rows | compaction cost, read latency, repair granularity |
| Bucket width | `100k / peak rows per period` | keeps the hottest entity bounded, not the median |
| Node data | 1–4 TB, disk < 50–60% full | bootstrap, repair and compaction headroom |
| Writes per node | 10–20k/s small rows (planning figure) | validate with `cassandra-stress`, never assume |
| RF / CL | `NetworkTopologyStrategy` RF=3 per DC, `LOCAL_QUORUM` | 2+2 > 3 gives local read-your-writes, no WAN |
| Fan-out threshold | push < 100k followers, pull above | bounds write amplification and read fan-out |
| TWCS windows | 20–40 alive at once | fewer SSTables per read, clean window drops |
| `gc_grace_seconds` | 864000 default; lower only for TTL-only, delete-free tables | tombstone purge must not precede repair |

**Flash cards**
- **Round order** → patterns → tables → bounds → sizing → consistency → failure → non-goals.
- **Bucket width formula** → `target_rows / peak_rows_per_period`, computed from the hot tail.
- **Node count** → `bytes/day × amp × retention × RF ÷ (disk × 0.5)`; the 0.5 is compaction headroom.
- **Hot partition fix** → coalescing + cache + narrower buckets. Never "add nodes."
- **Hybrid fan-out** → push below ~100k followers, pull above, merge at read by timestamp.

## 11. Hands-On Exercises & Mini Project

- [ ] Take the messaging schema above, load 5 M messages into one channel with a 10-day bucket, and use `nodetool tablehistograms` to find the exact row count at which the partition crosses 100 MB — then verify the formula predicted it.
- [ ] Implement per-channel bucket widths (read `bucket_seconds` from `chat.channels`) and prove that a synthetic 500k-messages-per-day channel stays bounded.
- [ ] Build the IoT `readings_raw` table with a 6-hour TWCS window and 7-day TTL, load 24 hours of data, and watch SSTable count settle at roughly the number of live windows.
- [ ] Implement hybrid fan-out for 10k synthetic users with a Zipfian follower distribution; measure P99 home-timeline latency as you move the celebrity threshold from 1k to 1 M.
- [ ] Run a full mock round against a friend on a fourth prompt ("design a ride-tracking store for Uber") in exactly 45 minutes, using the eight-step order, and have them grade whether you said the arithmetic out loud.

**Mini Project — The Design-Round Simulator**
*Goal:* build a repo you can rehearse against, so the round becomes muscle memory.
*Requirements:* (1) implement all three schemas above against a local 3-node Docker or ccm cluster; (2) write a generator producing realistic Zipfian key distributions for each; (3) instrument P50/P99 read and write latency, partition size max, and SSTables-per-read into Prometheus/Grafana; (4) write a one-page design doc per system in the eight-step order, with the arithmetic shown; (5) add a `make chaos` target that kills a node mid-load and records client-visible errors at `ONE`, `LOCAL_QUORUM` and `ALL`.
*Extensions:* add the coalescing data-service layer and quantify the coordinator-read reduction for a celebrity key; add a second DC and demonstrate that `QUORUM` costs you WAN latency while `LOCAL_QUORUM` does not; implement the GDPR erasure path with real `DELETE`s and show the tombstone impact on read latency before and after repair plus compaction.

## 12. Related Topics & Free Learning Resources

**Related chapters:** *Query-First Data Modelling* (the modelling rules this round tests), *Partition Keys & Clustering Columns*, *Consistency Levels & Tunable Consistency* (`R + W > RF`), *Compaction Strategies* (TWCS window sizing), *Capacity Planning & Sizing*, *Production Case Studies & Architectures* (the real systems these prompts imitate), and *Migration & Real-World Challenges*.

**Free Learning Resources**
- **DataStax — Cassandra Data Modeling Concepts** — DataStax Docs · *Intermediate* · the canonical query-first methodology, the partition-size formulas, and worked conceptual-to-physical examples. <https://docs.datastax.com/en/cassandra-oss/3.x/cassandra/dml/dmlIntro.html>
- **Apache Cassandra — Data Modelling documentation** — Apache Software Foundation · *Intermediate* · official coverage of conceptual/logical/physical modelling and the analysis-and-validation step. <https://cassandra.apache.org/doc/latest/cassandra/developing/data-modeling/index.html>
- **Basic Rules of Cassandra Data Modeling** — DataStax Engineering Blog · *Beginner–Intermediate* · the two rules ("spread data evenly, minimise partitions read") that every design-round answer is an application of. <https://www.datastax.com/blog/basic-rules-cassandra-data-modeling>
- **How Discord Stores Trillions of Messages** — Discord Engineering · *Intermediate* · the real version of the messaging prompt, including bucket choice, hot partitions and coalescing. <https://discord.com/blog/how-discord-stores-trillions-of-messages>
- **Introducing Netflix's TimeSeries Data Abstraction Layer** — Netflix Technology Blog · *Advanced* · a production answer to the time-series prompt: bucketing, retention tiers and an API that prevents bad partitions. <https://netflixtechblog.com/introducing-netflix-timeseries-data-abstraction-layer-31552f6326f8>
- **The Last Pickle blog** — The Last Pickle / DataStax · *Advanced* · deep operational posts on TWCS window sizing, tombstones, repair and compaction that back up every claim in this chapter. <https://thelastpickle.com/blog/>
- **Cassandra: The Definitive Guide, 3rd ed. — sample chapters** — Carpenter & Hewitt (O'Reilly, free chapters via DataStax) · *Intermediate* · the data-modelling and design chapters used by most interview prep. <https://www.datastax.com/resources/ebook/oreilly-cassandra-definitive-guide>
- **Apache Cassandra YouTube — data modelling and summit talks** — Planet Cassandra · *All levels* · recorded modelling workshops and production design talks, including the messaging and time-series patterns. <https://www.youtube.com/@PlanetCassandra>

---

*Apache Cassandra Handbook — chapter 45.*
