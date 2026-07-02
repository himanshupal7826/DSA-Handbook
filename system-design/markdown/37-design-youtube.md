# 37 · Design: Video Streaming (YouTube/Netflix)

> **In one line:** Ingest one uploaded file, fan it out into a ladder of bitrates/resolutions offline, push the chunks to edge CDNs, and let the player adaptively pull the segment that fits its bandwidth.

---

## 1. Problem & Requirements

Build a video platform: creators **upload** once; hundreds of millions **watch** on every device and network condition, from a phone on 3G to a TV on gigabit.

**Functional**

- **Upload** a source video (any codec/container, up to hours long, tens of GB).
- **Transcode** into an adaptive **bitrate ladder** (e.g. 144p→4K) and package as **HLS/DASH** segments.
- **Stream** with **adaptive bitrate (ABR)** — the player switches quality mid-play to avoid buffering.
- **Metadata**: title, description, thumbnails, duration, availability, per-video manifest.
- **View counts** and basic engagement (likes, watch time) — eventually consistent, high write volume.
- **Search / recommendations** (recommendations noted, not the focus).
- **Resume** playback, subtitles/captions, multiple audio tracks.

**Non-functional**

- **Scale**: ~2B users, ~1B hours watched/day, ~500 hours uploaded/minute (YouTube-order).
- **Startup latency**: video **starts in < 1–2 s** (time-to-first-frame); seek < 500 ms.
- **Availability**: 99.99% for playback (watching must not break even during a transcode outage).
- **Durability**: uploaded masters are **11 nines** — never lose a creator's source.
- **Global**: serve every region from a nearby edge; > 90% of bytes from cache.
- **Cost**: egress bandwidth is the dominant bill — **CDN cache-hit ratio is the #1 lever**.

## 2. Capacity Estimation

```text
Uploads:   500 hours/min = 8.3 hours/s
  Avg source bitrate ~10 Mbps → 1 hr source ≈ 4.5 GB
  ingest/day  = 500*60*24 hr = 720k hr/day
  source storage/day = 720k hr * 4.5 GB ≈ 3.2 PB/day RAW (before transcode)

Transcode fan-out: each source → ~6 renditions (144p..1080p..4K) + audio
  encoded output ~2–3x source total across ladder ≈ 8–12 PB/day of derived assets
  → object storage grows PB/day; lifecycle-tier cold originals to cheap storage

Views / bandwidth (THE big number):
  1B hours watched/day, avg served bitrate ~3 Mbps (mixed devices)
  bytes/day = 1e9 hr * 3600 s * 3 Mbps/8 = 1e9*3600*0.375 MB ≈ 1.35 EB/day
  peak egress ≈ (1.35e18 * 8 / 86400) bits/s ≈ 125 Tbps at peak (3x) 
  → SERVED ALMOST ENTIRELY FROM CDN EDGE. Origin sees only cache-fill.

Metadata QPS:
  video-detail reads ≈ playback starts. Say 1B starts/day → ~12k rps avg, ~40k peak
  view-count increments: same order → buffer + batch, never 1 DB write per view

Transcode compute:
  8.3 src-hours/s * ~real-time-ish per rendition * 6 renditions, parallelized by chunk
  → tens of thousands of encoder cores; bursty → autoscale / spot fleet
```

The punchline: **storage grows in petabytes/day and egress is measured in terabits/sec** — both are tamed by (a) transcoding once, (b) tiering cold storage, and (c) a very high CDN hit ratio.

## 3. API Design

Upload and playback are two very different paths.

```text
# --- Upload (resumable, direct-to-object-storage) ---
POST /v1/videos                       {title, desc, visibility} -> {video_id, upload_url}
PUT  {upload_url}  (resumable, chunked, e.g. tus/S3 multipart)  -> 200 per chunk
POST /v1/videos/{id}/complete         {sha256}                  -> {status: processing}
GET  /v1/videos/{id}/status                                      -> {state: processing|ready|failed}

# --- Playback ---
GET  /v1/videos/{id}                  -> {title, duration, manifest_url, thumbnails[], captions[]}
GET  /hls/{id}/master.m3u8            -> master manifest (lists all renditions)
GET  /hls/{id}/1080p/index.m3u8       -> media playlist (lists segments)
GET  /hls/{id}/1080p/seg_00042.ts     -> a ~2–6 s media segment  (served by CDN)

# --- Engagement (async / batched) ---
POST /v1/videos/{id}/view             {position, session}       # fire-and-forget → queue
POST /v1/videos/{id}/heartbeat        {position_s}              # watch-time, every ~5–30s
```

The **master manifest** (`.m3u8` for HLS / `.mpd` for DASH) is the heart of ABR: it lists each rendition with its bandwidth + resolution, and the player picks. Segments are static, cacheable, and content-addressable — perfect CDN objects.

## 4. Data Model

```text
# Video metadata — read-heavy, needs rich query. Store: SQL (sharded) or Spanner-like.
videos:    video_id (PK) | uploader_id | title | desc | duration_s | visibility
           | status(uploading|processing|ready|failed) | created_at | region
renditions: video_id | quality(1080p..) | codec(h264/av1) | bitrate | manifest_key
captions:   video_id | lang | url
thumbnails: video_id | ts | url

# Assets live in OBJECT STORAGE (S3/GCS/Blob), not the DB. DB stores KEYS/URLs.
#   s3://masters/{video_id}/source.mp4               (11-nines, cold-tiered)
#   s3://vod/{video_id}/{quality}/seg_*.ts + *.m3u8  (served via CDN)

# View counts — hot writes, approximate. Store: sharded counters / stream aggregation.
view_counts: video_id | count        # updated by batch/stream job, NOT per-view row
watch_events (raw): partitioned by day in a data lake (Kafka -> S3/BigQuery)

# Playback position (resume). Store: KV (Redis/Dynamo), keyed per (user,video).
resume:  (user_id, video_id) -> position_s, updated_at
```

Datastore rationale: **metadata in SQL** for rich reads and joins (channel pages, search feeds), **assets in object storage** (cheap, durable, infinitely scalable, CDN-frontable), **view counts via stream aggregation** because per-view row writes would be billions/day of contention.

## 5. High-Level Design

Two decoupled pipelines: an **offline ingest→transcode→publish** pipeline (write path) and an **online playback** pipeline (read path) served almost entirely from the CDN.

```svg
<svg viewBox="0 0 800 440" width="100%" height="440" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12.5">
  <defs>
    <marker id="a" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="200" y="24" text-anchor="middle" fill="#64748b">UPLOAD / TRANSCODE (offline, write path)</text>
  <line x1="20" y1="34" x2="780" y2="34" stroke="#e2e8f0"/>

  <rect x="20" y="55" width="100" height="44" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="70" y="82" text-anchor="middle" fill="#1e293b">Creator</text>

  <rect x="150" y="55" width="110" height="44" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="205" y="77" text-anchor="middle" fill="#1e293b">Upload svc</text>
  <text x="205" y="92" text-anchor="middle" fill="#64748b">resumable</text>

  <rect x="290" y="55" width="110" height="44" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="345" y="77" text-anchor="middle" fill="#1e293b">Master blob</text>
  <text x="345" y="92" text-anchor="middle" fill="#64748b">S3 (11 nines)</text>

  <rect x="430" y="45" width="120" height="64" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="490" y="70" text-anchor="middle" fill="#1e293b">Transcode</text>
  <text x="490" y="86" text-anchor="middle" fill="#64748b">pipeline (queue</text>
  <text x="490" y="100" text-anchor="middle" fill="#64748b">+ encoder fleet)</text>

  <rect x="580" y="55" width="110" height="44" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="635" y="77" text-anchor="middle" fill="#1e293b">VOD store</text>
  <text x="635" y="92" text-anchor="middle" fill="#64748b">segments+m3u8</text>

  <line x1="120" y1="77" x2="150" y2="77" stroke="#475569" marker-end="url(#a)"/>
  <line x1="260" y1="77" x2="290" y2="77" stroke="#475569" marker-end="url(#a)"/>
  <line x1="400" y1="77" x2="430" y2="77" stroke="#475569" marker-end="url(#a)"/>
  <line x1="550" y1="77" x2="580" y2="77" stroke="#475569" marker-end="url(#a)"/>

  <!-- metadata db -->
  <rect x="430" y="130" width="120" height="40" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="490" y="155" text-anchor="middle" fill="#1e293b">Metadata DB</text>
  <line x1="490" y1="109" x2="490" y2="130" stroke="#475569" marker-end="url(#a)"/>

  <text x="200" y="215" text-anchor="middle" fill="#64748b">PLAYBACK (online, read path)</text>
  <line x1="20" y1="225" x2="780" y2="225" stroke="#e2e8f0"/>

  <rect x="20" y="300" width="100" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="70" y="322" text-anchor="middle" fill="#1e293b">Player</text>
  <text x="70" y="338" text-anchor="middle" fill="#64748b">(ABR)</text>

  <rect x="170" y="250" width="120" height="44" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="230" y="272" text-anchor="middle" fill="#1e293b">API / metadata</text>
  <text x="230" y="287" text-anchor="middle" fill="#64748b">(manifest_url)</text>

  <rect x="170" y="330" width="120" height="46" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="230" y="352" text-anchor="middle" fill="#1e293b">CDN edge PoP</text>
  <text x="230" y="368" text-anchor="middle" fill="#64748b">caches segments</text>

  <rect x="600" y="330" width="120" height="46" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="660" y="352" text-anchor="middle" fill="#1e293b">Origin (VOD)</text>
  <text x="660" y="368" text-anchor="middle" fill="#64748b">cache-fill only</text>

  <line x1="120" y1="315" x2="170" y2="272" stroke="#475569" marker-end="url(#a)"/>
  <text x="135" y="285" fill="#64748b">1. get manifest</text>
  <line x1="120" y1="330" x2="170" y2="350" stroke="#475569" marker-end="url(#a)"/>
  <text x="120" y="392" fill="#64748b">2. pull segments (mostly cache hit)</text>
  <line x1="290" y1="360" x2="600" y2="356" stroke="#475569" stroke-dasharray="5 4" marker-end="url(#a)"/>
  <text x="445" y="348" text-anchor="middle" fill="#64748b">miss → fill</text>
</svg>
```

**Write path**: creator → resumable upload → master blob (durable) → enqueue → transcode fleet chunks the source, encodes each rendition in parallel, packages HLS/DASH → publish segments + manifests to VOD store → flip metadata `status=ready`. **Read path**: player fetches metadata → master manifest → pulls segments from the nearest **CDN edge**; the origin only serves cache-fills.

## 6. Deep Dive

### 6.1 The transcode pipeline

Transcoding is the crux. A raw upload is useless for streaming — it must become a **ladder of renditions**, each split into short segments.

1. **Validate & probe**: check container/codec, run `ffprobe`, reject corrupt/malware, extract duration + source resolution.
2. **Chunk the source**: split into GOP-aligned chunks (e.g. 2–10 s). This is the key parallelism trick — **each chunk is transcoded independently** across the fleet, so a 2-hour movie doesn't take 2 hours.
3. **Encode the ladder**: for each chunk, produce every rendition (144p/240p/360p/480p/720p/1080p/4K), each at a target bitrate, in the chosen codecs (H.264 for compatibility, VP9/AV1 for efficiency). Netflix goes further with **per-title / per-shot encoding** — the bitrate ladder is optimized per video's complexity, not a fixed table.
4. **Package**: stitch chunks, cut into HLS `.ts`/CMAF `.m4s` segments, write per-rendition media playlists + a master manifest, generate thumbnails/sprite sheets, mux captions/audio tracks.
5. **Publish & verify**: upload to VOD object storage, validate playback, then atomically flip `status=ready` so the video appears. Failures retry per-chunk (idempotent) without redoing the whole video.

This is a **DAG of stages** driven by a queue (SQS/Kafka) with a worker fleet — bursty, so run on autoscaling/spot compute.

```svg
<svg viewBox="0 0 780 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="c" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <rect x="15" y="30" width="90" height="44" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="60" y="50" text-anchor="middle" fill="#1e293b">Probe/</text>
  <text x="60" y="66" text-anchor="middle" fill="#1e293b">validate</text>
  <rect x="135" y="30" width="90" height="44" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="180" y="56" text-anchor="middle" fill="#1e293b">Chunk (GOP)</text>

  <!-- parallel encode -->
  <rect x="270" y="10" width="120" height="30" rx="6" fill="#fff7ed" stroke="#d97706"/>
  <text x="330" y="30" text-anchor="middle" fill="#1e293b">encode 240p</text>
  <rect x="270" y="48" width="120" height="30" rx="6" fill="#fff7ed" stroke="#d97706"/>
  <text x="330" y="68" text-anchor="middle" fill="#1e293b">encode 720p</text>
  <rect x="270" y="86" width="120" height="30" rx="6" fill="#fff7ed" stroke="#d97706"/>
  <text x="330" y="106" text-anchor="middle" fill="#1e293b">encode 1080p/4K</text>
  <text x="330" y="140" text-anchor="middle" fill="#64748b">(per-chunk, parallel fleet)</text>

  <rect x="430" y="48" width="90" height="44" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="475" y="68" text-anchor="middle" fill="#1e293b">Package</text>
  <text x="475" y="83" text-anchor="middle" fill="#64748b">HLS/DASH</text>
  <rect x="555" y="48" width="100" height="44" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="605" y="68" text-anchor="middle" fill="#1e293b">Publish VOD</text>
  <text x="605" y="83" text-anchor="middle" fill="#64748b">+ CDN warm</text>
  <rect x="680" y="48" width="85" height="44" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="722" y="68" text-anchor="middle" fill="#1e293b">status=</text>
  <text x="722" y="83" text-anchor="middle" fill="#1e293b">ready</text>

  <line x1="105" y1="52" x2="135" y2="52" stroke="#475569" marker-end="url(#c)"/>
  <line x1="225" y1="52" x2="270" y2="52" stroke="#475569" marker-end="url(#c)"/>
  <line x1="390" y1="70" x2="430" y2="70" stroke="#475569" marker-end="url(#c)"/>
  <line x1="520" y1="70" x2="555" y2="70" stroke="#475569" marker-end="url(#c)"/>
  <line x1="655" y1="70" x2="680" y2="70" stroke="#475569" marker-end="url(#c)"/>
  <text x="390" y="200" text-anchor="middle" fill="#64748b">Queue-driven DAG; per-chunk retries are idempotent; whole video never re-encoded on one failure</text>
</svg>
```

### 6.2 Adaptive bitrate streaming (HLS/DASH)

Video isn't "streamed" as one file — it's a sequence of small **segments** the player pulls over plain HTTP. The **master manifest** advertises each rendition's bandwidth; the player runs an **ABR algorithm**: measure recent throughput + buffer occupancy, then pick the highest rendition that won't starve the buffer.

- Start conservative (fast first frame), ramp up as bandwidth is confirmed.
- On congestion, **step down** a rung before the buffer empties → no rebuffer, just softer quality.
- **Buffer-based** (BOLA) vs **throughput-based** vs **hybrid** ABR — Netflix uses hybrid + per-title ladders.
- Because segments are static, immutable, content-addressed HTTP objects, **any CDN caches them trivially** — this is why HLS/DASH won over stateful RTMP streaming.

### 6.3 CDN distribution — the cost & latency lever

At 100+ Tbps, you cannot serve from origin. **> 90% of bytes must come from CDN edge caches.**

- **Multi-tier CDN**: edge PoP → regional shield → origin. A miss at the edge fills from the shield, not the origin, collapsing origin load.
- **Netflix Open Connect**: appliances placed *inside ISPs*, pre-populated overnight with predicted-popular titles → most traffic never crosses the public backbone.
- **Cache key** = segment URL (immutable) → near-perfect hit ratios for popular content. Long-tail (rare videos) is the cache-miss cost; tier those originals to cheap cold storage.
- **Popularity is Zipfian**: a tiny fraction of videos are most views → prewarm/pin those; let the long tail miss.

### 6.4 View counts & engagement at scale

You cannot do `UPDATE videos SET views=views+1` per view — that's billions of contended writes/day on hot rows. Instead:

- Player emits a **view event** → Kafka. A **stream job** (Flink/Spark) aggregates counts in windows and periodically writes back an approximate total.
- For the display counter, use **sharded counters** or approximate structures; exact real-time counts aren't required (YouTube famously froze counters at 301+ while verifying).
- Watch-time/heartbeats feed the same event lake → powers **recommendations** (a separate ML system: candidate generation + ranking over watch history, collaborative filtering + embeddings). Noted, not designed here.

## 7. Bottlenecks & Scaling

- **Egress bandwidth** (the bill): maximize CDN hit ratio (multi-tier, ISP-embedded caches, prewarming), use efficient codecs (AV1/VP9 cut bytes 30–50%), per-title encoding.
- **Transcode throughput**: chunk-level parallelism + autoscaling encoder fleet on spot; prioritize by predicted popularity so hot uploads publish first.
- **Storage growth (PB/day)**: lifecycle-tier cold masters to archival storage; dedupe identical uploads by content hash; drop rarely-watched high renditions and re-encode on demand.
- **Metadata read hot spots**: cache video-detail + manifests in Redis/CDN; a viral video's metadata is read at playback QPS → edge-cache the manifest too.
- **Hot new viral video**: prewarm CDN on publish; the manifest and first few segments especially. Thundering-herd cache-fill on origin → request coalescing at the shield tier.
- **View-count write amplification**: never per-view DB writes — Kafka + stream aggregation + sharded counters.

## 8. Failure Scenarios

| Failure | Blast radius | Mitigation |
|---|---|---|
| Transcode job fails on one chunk | That video stuck in processing | Idempotent per-chunk retry; only failed chunk re-encoded; DLQ + alert after N retries |
| CDN edge PoP down | Users in that region slow/buffering | Anycast/GeoDNS reroute to next-nearest PoP; shield tier absorbs; player retries other CDN |
| Origin overload (cache-miss storm on viral video) | Elevated latency, possible 5xx | Request coalescing, prewarm on publish, multi-tier shield, stale-while-revalidate |
| Object storage (master) loss | Cannot re-transcode source | 11-nines multi-region replication; renditions already published still stream |
| Metadata DB slow/down | Can't start new playbacks | Cache manifests + video-detail at edge; serve reads from replica/cache; degrade gracefully |
| Player on collapsing network | Rebuffering | ABR steps down rungs before buffer empties; short segments; low-latency startup rendition |
| Upload interrupted | Creator frustration, partial file | Resumable/chunked upload (tus/S3 multipart) — resume from last chunk |
| View-count pipeline lag | Stale counts | Acceptable — counts are eventually consistent by design |

## 9. Trade-offs & Alternatives

- **HLS/DASH (segmented HTTP) vs RTMP/WebRTC**: segmented HTTP is stateless, CDN-cacheable, and scales infinitely for **VOD** — the right choice. WebRTC/low-latency protocols are for *live/interactive* (sub-second), at much higher cost and complexity.
- **Fixed bitrate ladder vs per-title/per-shot encoding**: fixed is simple; per-title (Netflix) saves 20%+ bandwidth by matching bitrate to content complexity — huge at their scale, worth the extra encode compute.
- **Codec choice**: H.264 = universal compatibility; AV1/VP9 = 30–50% smaller but heavier to encode + spottier device support. Serve multiple codecs, let the manifest pick.
- **Transcode on upload vs on demand**: pre-transcode all renditions (fast playback, more storage/compute) vs just-in-time transcode rare renditions (saves storage, slower first play). Hybrid: pre-encode popular rungs, JIT the long tail.
- **Own CDN vs commercial**: at YouTube/Netflix scale, building your own (Open Connect, Google Global Cache) beats paying Akamai/CloudFront — the crossover is enormous scale; below it, buy.
- **At 10×**: the constraint is physics of bandwidth — push more caching into ISPs, adopt better codecs aggressively, and edge-encode.

## 10. Interview Follow-ups

**Q: Why not just store one file and stream it?**
A: One file can't adapt to network conditions and isn't cache-friendly per-quality. We transcode into a **bitrate ladder** of short **segments** so the player adapts (ABR) and CDNs cache each immutable segment.

**Q: How does adaptive bitrate actually pick a quality?**
A: The **master manifest** lists renditions with bandwidth. The player measures recent throughput + buffer level and picks the highest rendition it can sustain, stepping down before the buffer starves. Start low for fast first frame, ramp up.

**Q: Why segment the source before transcoding?**
A: **Parallelism.** Each GOP-aligned chunk is transcoded independently across a fleet, so encoding time is bounded by fleet size, not video length. It also makes retries per-chunk and idempotent.

**Q (senior): How do you serve 100+ Tbps at peak without melting the origin?**
A: > 90% of bytes come from **CDN edge**; immutable segment URLs give near-perfect hit ratios for popular content. Multi-tier (edge→shield→origin) collapses miss traffic, ISP-embedded caches (Open Connect) keep bytes off the backbone, and viral videos are prewarmed on publish.

**Q: How do you count views at billions/day without hammering the DB?**
A: Never per-view row writes. Emit view events to **Kafka**, aggregate with a **stream job** into windowed counts, write back approximate totals; use **sharded counters** for the display value. Counts are eventually consistent by design.

**Q (senior): A brand-new video goes viral in minutes. What breaks and how do you handle it?**
A: Cold cache → **cache-miss storm** on origin + hot metadata reads. Mitigate with prewarming on publish (manifest + first segments), **request coalescing** at the shield so N misses become 1 fill, edge-cached manifests, and popularity-based transcode prioritization so it's published fast.

**Q: How do resumable uploads work and why do they matter?**
A: Chunked/multipart upload (tus or S3 multipart) with per-chunk acks. A dropped connection resumes from the last acked chunk instead of re-uploading 20 GB — essential for large files on flaky networks.

**Q (senior): Storage grows petabytes/day. How do you control it?**
A: Lifecycle-tier cold **masters** to archival storage, dedupe identical uploads by content hash, prune rarely-watched high renditions (re-encode JIT if requested), and use efficient codecs to shrink derived assets.

**Q: HLS vs DASH — does it matter?**
A: Same idea (segmented adaptive HTTP): HLS is Apple-native (`.m3u8`/CMAF), DASH is codec-agnostic (`.mpd`). Package once in CMAF and serve both. Choice is device-ecosystem driven, not architectural.

**Q (staff): Where do recommendations fit and how are they served?**
A: A separate ML system consuming the watch-event lake — **candidate generation** (collaborative filtering, embeddings, ANN retrieval) then **ranking** (a model over watch history/context). Served via a low-latency feature store + ranking service; the video platform just emits the events and renders the results.

**Q: Live streaming vs VOD — what changes?**
A: Live needs **low-latency** ingest→transcode→package in real time (LL-HLS/WebRTC), a rolling manifest, tighter segment sizes, and no re-encode luxury. Same CDN fan-out, but the pipeline runs continuously with strict latency budgets.

**Q (staff): How would you cut bandwidth cost by 30% next quarter?**
A: Aggressively roll out **AV1/VP9** on supported devices (30–50% smaller), expand **per-title encoding**, push more caches into ISPs, and raise edge hit ratio via better prewarming of the Zipf head.

## 11. Cheat Sheet

> [!TIP]
> **Video streaming (YouTube/Netflix) in one screen.**
> - **Two pipelines**: offline **upload→transcode→publish** (write) and online **playback** (read, served from CDN).
> - **Transcode** = chunk the source → parallel-encode a **bitrate ladder** → package **HLS/DASH** segments → flip `status=ready`. Per-chunk retries are idempotent.
> - **ABR**: player pulls short immutable segments over HTTP, picks quality from throughput + buffer via the **master manifest**. Steps down before rebuffering.
> - **CDN is everything**: > 90% of bytes from edge; multi-tier (edge→shield→origin); ISP-embedded caches (Open Connect); prewarm viral videos.
> - **Storage**: masters in object storage (11 nines, cold-tiered); segments served via CDN. DB stores only metadata + keys.
> - **View counts**: Kafka → stream aggregation → sharded counters. Never per-view DB writes.
> - **Cost lever** = cache-hit ratio + codec efficiency + per-title encoding.
> - **Bottlenecks**: egress Tbps, transcode compute, PB/day storage, viral cache-miss storms.

**References:** Netflix Tech Blog — "Per-Title Encode Optimization", "Open Connect"; Apple HLS spec / MPEG-DASH spec; ByteByteGo — "Design YouTube"; AWS "Video on Demand" reference architecture; DDIA ch.11 (batch/stream processing).

---

*System Design Handbook — topic 37.*
