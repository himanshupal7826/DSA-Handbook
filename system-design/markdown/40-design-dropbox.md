# 40 · Design: Distributed File Storage (Dropbox/Drive)

> **In one line:** Chop files into content-addressed blocks, store the bytes once in object storage and the structure in a metadata DB, and sync only the blocks that actually changed to every device.

---

## 1. Problem & Requirements

Build Dropbox/Google Drive: a folder on every device that stays in sync through the cloud. Edit a file on your laptop; seconds later it's identical on your phone and your colleague's machine. Files up to gigabytes, on flaky networks, with sharing and offline edits.

**Functional**

- **Upload/download** files of arbitrary size (KB to multi-GB).
- **Sync**: a local client watches a folder and reflects changes both ways; **delta sync** uploads only changed **blocks**, not whole files.
- **Dedup**: identical content stored once (across a user and, optionally, across users).
- **Versioning**: keep file history; restore prior versions.
- **Sharing & permissions**: share a file/folder with users/links; viewer/editor roles.
- **Conflict resolution**: two devices edit offline → deterministic, non-destructive outcome.
- **Multi-device**: N devices per user, all convergent.

**Non-functional**

- **Scale**: ~700M users (Dropbox-order), exabytes stored, billions of files.
- **Durability**: **11 nines** — a stored file is effectively never lost.
- **Availability**: 99.99% for the metadata/API; object storage independently HA.
- **Sync latency**: a small change propagates to other online devices in **< a few seconds**.
- **Bandwidth efficiency**: never re-upload unchanged data; dedup at the block level.
- **Consistency**: metadata is strongly consistent per file (ordered versions); global convergence eventually consistent.

## 2. Capacity Estimation

```text
Users:            700M, say 100M active/day, ~3 devices each
Files:            ~100 files changed/active-user/day
  change events/day = 100M * 100          = 10B/day → ~115k events/s avg, ~350k peak

Block size:       4 MB fixed (Dropbox uses ~4MB blocks)
Storage:
  avg user footprint ~ a few GB; assume 40 GB avg stored
  total = 700M * 40 GB                     ≈ 28 EB raw
  dedup + compression saves 30-50%          → served from object storage

Upload bandwidth (delta sync is the win):
  Without delta: editing 1 byte of a 1 GB file = 1 GB upload
  With block delta: re-upload only the changed 4 MB block(s) → 250x less
  new bytes/day (net, post-dedup) maybe ~ single-digit PB/day

Metadata:
  files*versions rows: billions. Each metadata row ~ small (few hundred B)
  metadata QPS: dominated by sync polling/notify + list/stat
    reads >> writes; peak ~ hundreds of k/s → sharded DB + cache + notification service

Notification fan-out:
  100M devices holding a long-poll/socket for "your files changed"
  → a notification tier (like chat conn servers), sharded by user
```

Two independent scaling problems: **bytes** (object storage, exabytes, cheap+durable) and **metadata + notifications** (billions of rows, high QPS, low latency). Keep them in **separate services** — this separation is the whole design.

## 3. API Design

The client talks to a **metadata/API service** and, separately, to a **block service** (often direct-to-object-storage via signed URLs).

```text
# --- Block service (content-addressed) ---
POST /v1/blocks/check        {hashes:[sha256...]}   -> {missing:[hashes]}   # dedup probe
PUT  /v1/blocks/{hash}       <4MB bytes>            -> 200                  # upload only missing
GET  /v1/blocks/{hash}                              -> <bytes>

# --- Metadata service ---
POST /v1/files/commit        {path, block_list:[hash...], size, mtime, base_version}
                             -> {file_id, version}  | 409 conflict
GET  /v1/files/{id}                                 -> {block_list, version, size, perms}
GET  /v1/delta               {cursor}               -> {changes:[...], next_cursor}  # sync pull
POST /v1/files/{id}/share    {user|link, role}      -> {share_id}

# --- Notification ---
WS/long-poll  /v1/notify     {cursor}   -> pushes "namespace changed" -> client calls /delta
```

The upload dance: client hashes each block → `POST /blocks/check` to find which blocks the server **already has** (dedup) → `PUT` only the **missing** blocks → `commit` the file as an ordered **block list** + `base_version` (optimistic concurrency; a stale base → `409`). The `/delta` + cursor pattern lets a client efficiently pull "what changed since I last synced".

## 4. Data Model

```text
# --- Metadata DB (strongly consistent, sharded by user/namespace). Store: sharded SQL. ---
files:     file_id (PK) | namespace_id | path | latest_version | is_dir | deleted
versions:  file_id | version | block_list (ordered hashes) | size | mtime | author_device
           # a file = an ORDERED LIST OF BLOCK HASHES. Versions are immutable rows.
namespaces: ns_id | owner | type(user|shared)          # a shared folder is a namespace
membership: ns_id | user_id | role(owner|editor|viewer)
cursor:    device_id | namespace_id | last_seen_version # sync progress per device

# --- Block metadata (content-addressed dedup). Store: KV. ---
blocks:    hash(sha256) (PK) | size | storage_key | refcount
# refcount: how many file-versions reference this block → GC when it hits 0

# --- Block bytes. Store: OBJECT STORAGE (S3/GCS or Dropbox Magic Pocket). ---
#   key = content hash → immutable, dedup'd, erasure-coded, 11 nines
```

The pivotal idea: **a file is not bytes — it's an ordered list of block hashes** in the metadata DB. The bytes live once, content-addressed, in object storage. Two files (or two versions) sharing content share blocks automatically. **Metadata (SQL, strongly consistent) and blocks (object storage, immutable)** are decoupled stores with different guarantees.

## 5. High-Level Design

The **client watcher** detects local changes, chunks + hashes them, uploads missing blocks to the **block service**, and commits the new version to the **metadata service**. The **notification service** tells other devices "something in your namespace changed"; they pull the **delta** and download missing blocks.

```svg
<svg viewBox="0 0 800 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12.5">
  <defs>
    <marker id="a" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <!-- clients -->
  <rect x="20" y="40" width="120" height="56" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="80" y="62" text-anchor="middle" fill="#1e293b">Client A</text>
  <text x="80" y="78" text-anchor="middle" fill="#64748b">watcher+chunker</text>
  <rect x="20" y="320" width="120" height="56" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="80" y="342" text-anchor="middle" fill="#1e293b">Client B</text>
  <text x="80" y="358" text-anchor="middle" fill="#64748b">(other device)</text>

  <!-- block svc -->
  <rect x="200" y="40" width="130" height="56" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="265" y="62" text-anchor="middle" fill="#1e293b">Block service</text>
  <text x="265" y="78" text-anchor="middle" fill="#64748b">check/put/get</text>

  <!-- object store -->
  <rect x="380" y="40" width="140" height="56" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="450" y="62" text-anchor="middle" fill="#1e293b">Object storage</text>
  <text x="450" y="78" text-anchor="middle" fill="#64748b">blocks (11 nines)</text>

  <!-- metadata svc -->
  <rect x="200" y="190" width="130" height="56" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="265" y="212" text-anchor="middle" fill="#1e293b">Metadata svc</text>
  <text x="265" y="228" text-anchor="middle" fill="#64748b">commit/delta</text>
  <rect x="380" y="190" width="140" height="56" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="450" y="212" text-anchor="middle" fill="#1e293b">Metadata DB</text>
  <text x="450" y="228" text-anchor="middle" fill="#64748b">files/versions/perms</text>

  <!-- notify -->
  <rect x="200" y="320" width="130" height="56" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="265" y="342" text-anchor="middle" fill="#1e293b">Notification svc</text>
  <text x="265" y="358" text-anchor="middle" fill="#64748b">push "changed"</text>

  <rect x="580" y="190" width="120" height="56" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="640" y="212" text-anchor="middle" fill="#1e293b">Block meta KV</text>
  <text x="640" y="228" text-anchor="middle" fill="#64748b">hash→key,refcount</text>

  <line x1="140" y1="60" x2="200" y2="60" stroke="#475569" marker-end="url(#a)"/>
  <text x="150" y="52" fill="#64748b">1. check+put blocks</text>
  <line x1="330" y1="68" x2="380" y2="68" stroke="#475569" marker-end="url(#a)"/>
  <line x1="140" y1="90" x2="200" y2="205" stroke="#475569" marker-end="url(#a)"/>
  <text x="140" y="150" fill="#64748b">2. commit(block_list)</text>
  <line x1="330" y1="215" x2="380" y2="215" stroke="#475569" marker-end="url(#a)"/>
  <line x1="520" y1="215" x2="580" y2="215" stroke="#475569" marker-end="url(#a)"/>
  <line x1="265" y1="246" x2="265" y2="320" stroke="#475569" marker-end="url(#a)"/>
  <text x="272" y="290" fill="#64748b">3. emit change</text>
  <line x1="200" y1="348" x2="140" y2="348" stroke="#d97706" marker-end="url(#a)"/>
  <text x="70" y="400" fill="#64748b">4. B: pull delta → get missing blocks</text>
  <line x1="140" y1="335" x2="200" y2="220" stroke="#475569" stroke-dasharray="4 4" marker-end="url(#a)"/>
</svg>
```

## 6. Deep Dive

### 6.1 Chunking, content-addressing & dedup

The client splits each file into **blocks** and computes each block's **SHA-256** — the block's identity ("content-addressed"). Same content → same hash → stored once.

- **Fixed-size blocks** (e.g. 4 MB): simple, but inserting a byte at the start shifts every subsequent block → all hashes change → no dedup benefit ("boundary-shift problem").
- **Content-defined chunking (CDC, Rabin fingerprinting)**: place block boundaries where a rolling hash hits a pattern, so an insert only changes the *local* block. Better dedup for edited files. Dropbox historically used fixed 4 MB blocks (simpler; fine because most edits append or replace whole files); backup tools favor CDC.
- **Dedup scope**: *per-user* dedup is always safe. *Cross-user* (global) dedup saves the most storage but leaks a side-channel (upload speed reveals whether a block already existed → someone can test "does the server already have this exact file?"). Most providers restrict global dedup or add per-user salting to close this.
- **Refcounting**: each block hash has a `refcount` = how many file-versions reference it. Deleting a version decrements; a **background GC** deletes blocks at refcount 0. Deletes are async and careful — never delete a block another version still points to.

```svg
<svg viewBox="0 0 780 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <text x="20" y="30" fill="#1e293b">file v1 = [ h1 | h2 | h3 | h4 ]</text>
  <rect x="30" y="45" width="60" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="60" y="67" text-anchor="middle" fill="#1e293b">h1</text>
  <rect x="100" y="45" width="60" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="130" y="67" text-anchor="middle" fill="#1e293b">h2</text>
  <rect x="170" y="45" width="60" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="200" y="67" text-anchor="middle" fill="#1e293b">h3</text>
  <rect x="240" y="45" width="60" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="270" y="67" text-anchor="middle" fill="#1e293b">h4</text>

  <text x="20" y="130" fill="#1e293b">edit block 3 only → file v2 = [ h1 | h2 | h3' | h4 ]</text>
  <rect x="30" y="145" width="60" height="34" rx="6" fill="#f1f5f9" stroke="#94a3b8"/><text x="60" y="167" text-anchor="middle" fill="#64748b">h1</text>
  <rect x="100" y="145" width="60" height="34" rx="6" fill="#f1f5f9" stroke="#94a3b8"/><text x="130" y="167" text-anchor="middle" fill="#64748b">h2</text>
  <rect x="170" y="145" width="60" height="34" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="200" y="167" text-anchor="middle" fill="#d97706">h3'</text>
  <rect x="240" y="145" width="60" height="34" rx="6" fill="#f1f5f9" stroke="#94a3b8"/><text x="270" y="167" text-anchor="middle" fill="#64748b">h4</text>

  <text x="360" y="130" fill="#059669">upload ONLY h3' (one 4 MB block)</text>
  <text x="360" y="152" fill="#64748b">h1,h2,h4 already stored → reused (delta sync)</text>
  <text x="360" y="174" fill="#64748b">v2 metadata = new ordered block list; v1 immutable</text>
  <text x="20" y="220" fill="#64748b">A file = an ordered list of block hashes. Versions share unchanged blocks.</text>
</svg>
```

### 6.2 Block service vs metadata service — the split

The single most important architectural decision: **separate the bytes from the structure.**

- **Block service**: dumb, massive, immutable, content-addressed byte storage. Scales like object storage (erasure coding, multi-region, 11 nines). No file semantics. Often bypassed entirely via **signed URLs** so clients upload directly to storage.
- **Metadata service**: small rows, rich semantics (paths, versions, permissions, sharing), **strongly consistent**, sharded SQL. This is where ordering, concurrency, and access control live.

They scale independently: petabytes of bytes don't burden the transactional metadata DB, and a metadata hotspot doesn't slow byte transfer. Dropbox's "Magic Pocket" is the block store; the metadata layer is a sharded MySQL fleet.

### 6.3 Sync engine & the delta protocol

Each device maintains a **cursor** (its last-seen version per namespace). Sync is a loop:

1. **Watch**: the client's file watcher (inotify/FSEvents/ReadDirectoryChangesW) detects a local change → chunk + hash → upload missing blocks → `commit` new version with `base_version`.
2. **Notify**: the metadata commit bumps the namespace version and fires the **notification service**, which pushes "namespace X changed" to every *other* online device (a long-poll/socket tier sharded by user — like the chat connection servers). Offline devices catch up on reconnect.
3. **Pull delta**: a notified device calls `/delta?cursor=…` → gets the list of changed files (new block lists) since its cursor → downloads only **missing blocks** → reconstructs files → advances cursor.

This is efficient because notifications are tiny (just "poke"), the delta is a compact list, and only genuinely-missing blocks move. A separate low-frequency **poll** backstops missed notifications.

### 6.4 Conflict resolution

Two devices edit the same file offline; both come online and commit. **Optimistic concurrency** via `base_version` catches it: the second `commit` has a stale base → `409 Conflict`.

- **Resolution policy** (Dropbox's pragmatic choice): keep **both** — the loser is saved as a **"conflicted copy" (Device B's conflicted copy)**. Non-destructive, deterministic, simple; the human decides. No data is silently lost.
- **Last-writer-wins** is simpler but destroys an edit — unacceptable for user files.
- **Operational Transform / CRDTs** enable true auto-merge (Google Docs) but only work for *structured* documents the system understands; for opaque binary files (a .psd, a .zip) merging is impossible → conflicted-copy is the honest answer.
- **Directory conflicts** (same-name file vs folder, case-insensitivity clashes) need explicit rules; versions are immutable so history is always recoverable.

## 7. Bottlenecks & Scaling

- **Metadata DB**: shard by user/namespace (a namespace's data + permissions co-locate); cache hot reads; versions are immutable → append-only, index-friendly.
- **Block storage**: object storage scales horizontally by design; erasure-code for durability at lower cost than 3× replication; multi-region for DR.
- **Notification fan-out (100M sockets)**: a dedicated connection tier sharded by user; push tiny "changed" pokes, not payloads; offline devices reconcile via poll on reconnect.
- **Upload throughput / large files**: chunked + parallel block uploads, resumable (retry only failed blocks), signed URLs so bytes bypass app servers straight to storage.
- **Dedup probe cost**: `blocks/check` is a high-QPS KV lookup on the hash → cache + Bloom filters to answer "definitely don't have it" cheaply.
- **GC correctness**: refcount decrements + delayed, verified deletion; never race a delete against a concurrent commit referencing the same block.
- **Hot shared folder**: a 500-person shared namespace generates fan-out on every change → batch notifications, coalesce, and paginate deltas.

## 8. Failure Scenarios

| Failure | Blast radius | Mitigation |
|---|---|---|
| Block upload fails mid-file | Partial file | Resumable chunked upload; retry only missing blocks; commit only after all blocks present |
| Metadata DB shard down | Can't commit/list in that shard | Multi-AZ replicas + failover; block bytes still readable; queue commits |
| Concurrent offline edits | Two versions of a file | Optimistic `base_version` → `409` → **conflicted copy**; nothing lost |
| Lost notification | Device shows stale files | Periodic **poll** backstop reconciles via cursor/delta |
| Object storage region loss | Potential byte loss | Erasure coding + multi-region replication → 11 nines; async cross-region copy |
| Dedup side-channel probe | Privacy leak (does server have file X?) | Per-user dedup or salting; don't reveal cross-user hits via timing |
| Premature block GC | Data loss (block still referenced) | Refcount + delayed, verified deletion; GC checks no live version references the hash |
| Client clock skew / rename storms | Sync churn, false conflicts | Server-assigned versions (not client mtime) as source of truth; debounce watcher events |

## 9. Trade-offs & Alternatives

- **Fixed vs content-defined chunking**: fixed 4 MB is simple + fast (Dropbox) but poor dedup on shifted content; CDC (Rabin) dedups edits far better at more CPU. Choose CDC for backup/versioning-heavy workloads, fixed for general sync.
- **Metadata/block split vs monolith**: splitting bytes (object storage) from structure (SQL) is non-negotiable at scale — independent scaling + durability. A single store would either be too expensive for exabytes or too slow for transactional metadata.
- **Conflict policy**: conflicted-copy (safe, dumb) vs LWW (lossy) vs CRDT/OT (auto-merge, only for structured docs). For opaque files, conflicted-copy is the honest choice; Docs-style apps use CRDTs.
- **Cross-user dedup**: max storage savings vs privacy side-channel — most providers limit it or salt per-user.
- **Push vs poll sync**: push (notifications) gives seconds-latency but needs a 100M-socket tier; poll is simpler but laggy/wasteful. Hybrid: push primary + poll backstop.
- **At 10×**: push more direct-to-storage (signed URLs), regionalize metadata shards near users, adopt CDC for dedup, and harden GC.

## 10. Interview Follow-ups

**Q: Why chunk files into blocks instead of storing whole files?**
A: **Delta sync + dedup.** Editing one block of a 1 GB file re-uploads just that 4 MB block, not the whole file. Identical blocks (across versions/users) are stored once. A file becomes an *ordered list of block hashes*.

**Q: How does content-addressing enable dedup?**
A: A block's identity is its **content hash** (SHA-256). Same bytes → same hash → the server stores it once and every reference points at it. Upload starts with a `blocks/check` probe so the client only sends blocks the server lacks.

**Q: Fixed-size vs content-defined chunking — why does it matter?**
A: With fixed blocks, inserting one byte at the start shifts all boundaries → every hash changes → zero dedup ("boundary shift"). **Content-defined chunking** sets boundaries by a rolling hash so an insert only changes the local block. Fixed is simpler; CDC dedups edits better.

**Q (senior): Two devices edit the same file offline. What happens?**
A: **Optimistic concurrency**: each commit carries a `base_version`; the second commit's base is stale → `409`. Resolution: keep **both** — save the loser as a **conflicted copy**. Non-destructive and deterministic; auto-merge is impossible for opaque binaries.

**Q: Why split the block service from the metadata service?**
A: They scale independently and want different guarantees. **Blocks** = immutable, content-addressed, exabyte-scale object storage (11 nines). **Metadata** = small rows, strongly consistent, sharded SQL for paths/versions/permissions. Coupling them would be too costly or too slow.

**Q: How does a second device learn a file changed?**
A: The commit bumps the namespace version and fires the **notification service** (a socket/long-poll tier sharded by user) which pushes a tiny "namespace changed" poke. The device then pulls `/delta?cursor=…` and downloads only missing blocks. A periodic poll backstops missed pokes.

**Q (senior): How do you reclaim storage when files are deleted, without losing data?**
A: **Refcount** per block hash = number of file-versions referencing it. Deleting a version decrements; a background **GC** deletes blocks at refcount 0, with **delayed, verified** deletion so it never races a concurrent commit that references the same block.

**Q: What's the privacy risk of cross-user dedup and how do you handle it?**
A: A **side channel**: if uploading a block that already exists is instant, a user can test whether the server already has an exact file (e.g. a leaked document). Mitigate with **per-user dedup** or per-user salting so cross-user hits aren't observable via timing.

**Q (senior): How do you upload a 5 GB file over a flaky connection?**
A: Chunk into blocks, upload them in **parallel and resumably** (retry only failed blocks), often via **signed URLs direct to object storage**, then a single `commit` referencing the full ordered block list. A dropped connection resumes from the missing blocks, not from zero.

**Q: How is versioning implemented cheaply?**
A: **Versions are immutable rows** = ordered block lists. A new version reuses all unchanged blocks and adds only new ones, so history costs just the delta blocks + a small metadata row. Restore = point the file at an older version's block list.

**Q (staff): How do you keep the notification tier alive at 100M concurrent devices?**
A: A stateful connection tier (like a chat system) sharded by user; a session registry maps device→server; push only tiny pokes (payload pulled via delta); offline devices reconcile on reconnect; graceful drain + jittered reconnect to avoid storms.

**Q (staff): Where would Google Docs-style real-time collaboration change this design?**
A: Opaque-file sync (conflicted-copy) is replaced by **CRDT/OT** on a *structured* document model the server understands, with a real-time op stream instead of block sync. That only works because the content is structured; general file sync can't merge arbitrary binaries.

## 11. Cheat Sheet

> [!TIP]
> **Distributed file storage (Dropbox) in one screen.**
> - **A file = an ordered list of block hashes.** Bytes stored **once**, content-addressed (SHA-256), in object storage (11 nines). Structure in a strongly-consistent metadata DB.
> - **Split the two services**: dumb immutable **block store** (scales like object storage, signed-URL direct upload) vs rich **metadata service** (paths/versions/perms, sharded SQL). Non-negotiable.
> - **Delta sync**: chunk → hash → `blocks/check` (dedup probe) → upload only **missing** blocks → `commit(block_list, base_version)`.
> - **Sync loop**: watcher → commit → **notification** poke → other device pulls `/delta` by cursor → downloads missing blocks. Poll backstops missed pokes.
> - **Conflicts**: optimistic `base_version` → `409` → **conflicted copy** (never lose data). CRDT/OT only for structured docs.
> - **Chunking**: fixed 4 MB (simple) vs content-defined/Rabin (dedups edits, boundary-shift-proof).
> - **GC**: block **refcount**; delayed verified deletion at 0.
> - **Bottlenecks**: metadata shard hotspots, 100M notification sockets, dedup-probe QPS, GC correctness.

**References:** Dropbox Engineering — "Streaming File Synchronization", "Inside the Magic Pocket"; Google Drive architecture talks; rsync algorithm (rolling checksum / delta); DDIA ch.3 & ch.5 (storage engines, replication).

---

*System Design Handbook — topic 40.*
