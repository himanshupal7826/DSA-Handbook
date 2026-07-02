# 34 · Design: Chat System (WhatsApp)

> **In one line:** Hold hundreds of millions of persistent connections open, route each message to the right connection in single-digit milliseconds, and durably queue what can't be delivered now.

---

## 1. Problem & Requirements

We are building a WhatsApp-scale messenger: 1-to-1 and group chat, delivery/read receipts, presence ("online"/"last seen"), and reliable delivery to phones that are offline half the day.

**Functional**

- **Send/receive** text (and media pointers) in 1:1 and **group** chats (up to ~1024 members).
- **Delivery states**: sent (✓), delivered (✓✓), read (blue ✓✓).
- **Presence**: online / last-seen / typing indicators.
- **Offline delivery**: a message sent while the recipient is offline is stored and delivered on reconnect, in order.
- **Multi-device**: the same account active on phone + companions.
- **Media**: images/video/voice go through a separate blob path; chat carries only a pointer + key.

**Non-functional**

- **Scale**: ~2B users, ~500M concurrent connections, ~100B messages/day.
- **Latency**: end-to-end delivery **p99 < 200 ms** for online peers; connection send-ack **< 50 ms**.
- **Durability**: an accepted message is **never lost** — persisted before we ack the sender.
- **Ordering**: messages within a conversation are delivered in a consistent order.
- **Availability**: 99.99%. A regional outage must not lose undelivered messages.
- **Security**: **end-to-end encryption** (Signal protocol) — the server routes ciphertext it cannot read.

Out of scope: payments, calls (WebRTC signaling is a cousin problem), spam/abuse ML.

## 2. Capacity Estimation

```text
Users:            2B total, 500M concurrent (peak)
Messages:         100B msgs/day
  writes/sec avg  = 100e9 / 86400          ≈ 1.16M msg/s
  peak (3x)                                 ≈ 3.5M msg/s
Fan-out:          each msg → ~1.3 deliveries (groups) 
  delivery/s peak ≈ 4.5M deliveries/s

Connections:
  500M sockets. At ~200k sockets/box (tuned epoll)
  = 500M / 200k                             ≈ 2,500 connection servers
  RAM/socket ~10 KB (buffers+state) → 200k*10KB = 2 GB/box (fine)

Message size on wire (E2E ciphertext + envelope): ~200 B avg
  ingress bw peak = 3.5M * 200B             ≈ 700 MB/s = 5.6 Gbps
  egress (fan-out) ~ 4.5M * 200B            ≈ 900 MB/s

Storage (undelivered queue + recent history):
  Assume we hold only UNDELIVERED msgs server-side (WhatsApp deletes on delivery).
  Say 1% offline backlog at any time, avg 50 msgs each, 5% of users:
    0.05*2B users * 50 * 200B              ≈ 1 TB live backlog (small!)
  If we DID keep 30d history: 100B*30*200B  ≈ 600 TB (why WhatsApp historically did NOT)

Metadata (group membership, device keys, routing):
  2B users * ~1 KB                          ≈ 2 TB, replicated
```

Takeaway: **the connection tier (RAM, file descriptors, CPU for TLS) is the dominant cost**, not disk. WhatsApp famously served ~1M+ connections per box with tuned Erlang/FreeBSD.

## 3. API Design

Clients speak a **binary protocol over a single persistent WebSocket/MQTT-style TCP+TLS** connection, not REST. Logical operations:

```text
# Connection lifecycle
CONNECT   {user_id, device_id, auth_token, resume_token?}  -> CONNACK {session_id}
PING/PONG                                                   # heartbeat, ~30-60s
DISCONNECT                                                  # graceful

# Messaging
SEND      {client_msg_id, conv_id, ciphertext, ts}         -> ACK {server_msg_id, ts}
DELIVER   {server_msg_id, conv_id, sender, ciphertext, ts} # server -> recipient
RECEIPT   {server_msg_id, type: delivered|read}            # recipient -> server -> sender
TYPING    {conv_id, state: start|stop}

# Presence
PRESENCE_SUB   {user_ids[]}                                 # subscribe to contacts
PRESENCE_PUSH  {user_id, state: online|offline, last_seen}  # server -> subscriber

# Group / device management (over HTTPS, lower QPS)
POST /v1/groups            {members[]}          -> {group_id}
POST /v1/groups/{id}/members
GET  /v1/devices/{user}/prekeys                 -> {identity_key, prekeys[]}  # for E2E
POST /v1/media/upload-url  {sha256, size}       -> {blob_url, media_key}
```

`client_msg_id` (a client-generated UUID) makes **SEND idempotent** — a retry after a lost ACK does not duplicate.

## 4. Data Model

Datastore choices are driven by access pattern, not familiarity.

```text
# Routing / session — WHERE is user X connected right now?
# Access: point read/write, ephemeral, huge QPS. Store: Redis (in-memory), TTL'd.
session:{user_id}:{device_id} -> {conn_server_id, session_id, last_seen}  TTL 2m

# Undelivered message queue — per recipient inbox.
# Access: append + range-read + delete-on-ack. Store: Cassandra (wide-column) or HBase.
Inbox (partition key = user_id, clustering key = server_msg_id ASC):
  user_id | server_msg_id (time-sorted) | conv_id | sender | ciphertext | ts | state

# server_msg_id = time-ordered ID (Snowflake): 41b ms-ts | 10b node | 12b seq
#   -> gives global-ish ordering AND is the clustering key for in-order reads.

# Group membership. Access: read-heavy, small. Store: replicated SQL / Cassandra.
groups:  group_id | name | created_at
members: group_id | user_id | role | joined_at      (index on user_id)

# Device / E2E keys. Store: SQL.
devices: user_id | device_id | identity_pubkey | last_active
prekeys: device_id | prekey_id | prekey_pub      (one-time, consumed on use)
```

Why **Cassandra** for the inbox: massive write throughput, wide rows keyed by `user_id`, tunable consistency, and cheap range scans + tombstone deletes. Why **Redis** for sessions: they churn on every (dis)connect and are read on every message route — must be µs-fast and are safe to lose (rebuilt on reconnect).

## 5. High-Level Design

Two tiers dominate: a **stateful connection/session tier** that owns the sockets, and a **stateless routing/business tier** behind it. A pub/sub bus (or a routing table + direct RPC) moves a message from the sender's connection server to the recipient's.

```svg
<svg viewBox="0 0 780 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <!-- clients -->
  <rect x="20" y="40" width="110" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="75" y="60" text-anchor="middle" fill="#1e293b">Phone A</text>
  <text x="75" y="76" text-anchor="middle" fill="#64748b">(sender)</text>
  <rect x="20" y="320" width="110" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="75" y="340" text-anchor="middle" fill="#1e293b">Phone B</text>
  <text x="75" y="356" text-anchor="middle" fill="#64748b">(recipient)</text>

  <!-- LB -->
  <rect x="165" y="180" width="90" height="60" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="210" y="205" text-anchor="middle" fill="#1e293b">L4 LB</text>
  <text x="210" y="222" text-anchor="middle" fill="#64748b">sticky</text>

  <!-- conn servers -->
  <rect x="300" y="30" width="130" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="365" y="55" text-anchor="middle" fill="#1e293b">Conn Server 1</text>
  <text x="365" y="72" text-anchor="middle" fill="#64748b">holds socket A</text>
  <rect x="300" y="320" width="130" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="365" y="345" text-anchor="middle" fill="#1e293b">Conn Server N</text>
  <text x="365" y="362" text-anchor="middle" fill="#64748b">holds socket B</text>

  <!-- routing bus -->
  <rect x="470" y="180" width="120" height="60" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="530" y="205" text-anchor="middle" fill="#1e293b">Router /</text>
  <text x="530" y="222" text-anchor="middle" fill="#1e293b">Pub-Sub bus</text>

  <!-- session store -->
  <rect x="470" y="60" width="120" height="50" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="530" y="82" text-anchor="middle" fill="#1e293b">Session store</text>
  <text x="530" y="98" text-anchor="middle" fill="#64748b">Redis: user→conn</text>

  <!-- inbox -->
  <rect x="640" y="180" width="120" height="60" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="700" y="205" text-anchor="middle" fill="#1e293b">Inbox store</text>
  <text x="700" y="222" text-anchor="middle" fill="#64748b">Cassandra</text>

  <!-- presence -->
  <rect x="640" y="300" width="120" height="50" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="700" y="322" text-anchor="middle" fill="#1e293b">Presence svc</text>
  <text x="700" y="338" text-anchor="middle" fill="#64748b">Redis pub/sub</text>

  <line x1="130" y1="63" x2="300" y2="60" stroke="#475569" marker-end="url(#a)"/>
  <line x1="130" y1="343" x2="255" y2="230" stroke="#475569" marker-end="url(#a)"/>
  <line x1="255" y1="210" x2="300" y2="345" stroke="#475569" marker-end="url(#a)"/>
  <line x1="430" y1="60" x2="470" y2="200" stroke="#475569" marker-end="url(#a)"/>
  <line x1="530" y1="180" x2="530" y2="110" stroke="#475569" marker-end="url(#a)"/>
  <line x1="590" y1="205" x2="640" y2="205" stroke="#475569" marker-end="url(#a)"/>
  <line x1="590" y1="220" x2="430" y2="345" stroke="#475569" marker-end="url(#a)"/>
  <line x1="590" y1="230" x2="640" y2="320" stroke="#475569" marker-end="url(#a)"/>
  <text x="380" y="150" text-anchor="middle" fill="#64748b">conn servers are STATEFUL (own the TCP socket)</text>
</svg>
```

**Path of a message**: Phone A → its Conn Server 1 (SEND) → persist to B's inbox (durability) → ack A → look up B's session in Redis → route to Conn Server N → push DELIVER over B's socket → B sends RECEIPT back the same way.

## 6. Deep Dive

### 6.1 The connection/session tier — how routing actually works

Every device holds **one long-lived TLS socket** to a connection server. The hard question is: when A sends to B, *which of 2,500 boxes holds B's socket?* We keep a **session registry** in Redis: `session:{B} → {conn_server_id}`. Written on connect, deleted on disconnect, TTL'd so crashes self-heal.

Two routing styles:

- **Direct RPC**: Router reads Redis, learns B is on Conn-N, makes a gRPC call to Conn-N which pushes on B's socket. Lowest latency, but the router must know the topology.
- **Pub/sub**: every conn server subscribes to a channel per connected user (or shards). Router just `PUBLISH msg→channel(B)`; whichever box holds B receives it. Simpler, but the bus is a scaling chokepoint at 4.5M/s.

At WhatsApp scale you shard the bus by user and often collapse router+conn-server so the send hop is: *ingest server → persist → publish → deliver*. **Connection servers must be stateful and sticky** (L4 LB with consistent affinity) — you cannot round-robin a socket.

### 6.2 Durability, ordering, and delivery receipts

The contract: **persist before ack**. On SEND, the ingest server writes the message to the recipient's **inbox partition in Cassandra**, keyed by a **Snowflake `server_msg_id`** (time-ordered), then acks A with ✓ (sent). Only now do we attempt delivery.

- **Ordering**: because `server_msg_id` is time-sorted and it's the clustering key, a recipient reading its inbox on reconnect gets messages **in order**. Within a conversation the sender's monotonic sequence resolves ties. True total order across senders is impossible without a serialization point per conversation — we accept **per-conversation causal order**, which is what users perceive.
- **Delivered (✓✓)**: when B's device receives DELIVER, it emits a RECEIPT; the server routes it to A and **deletes the message from B's inbox** (WhatsApp's model — server storage is a *queue*, not an archive).
- **Read (blue ✓✓)**: emitted when B opens the chat; same routing path, sender-controlled privacy toggle.

```svg
<svg viewBox="0 0 780 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12.5">
  <defs>
    <marker id="b" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <!-- lifelines -->
  <text x="70" y="30" text-anchor="middle" fill="#1e293b">Phone A</text>
  <text x="250" y="30" text-anchor="middle" fill="#1e293b">Ingest/Conn</text>
  <text x="430" y="30" text-anchor="middle" fill="#1e293b">Inbox (Cass.)</text>
  <text x="620" y="30" text-anchor="middle" fill="#1e293b">Phone B</text>
  <line x1="70" y1="40" x2="70" y2="340" stroke="#cbd5e1"/>
  <line x1="250" y1="40" x2="250" y2="340" stroke="#cbd5e1"/>
  <line x1="430" y1="40" x2="430" y2="340" stroke="#cbd5e1"/>
  <line x1="620" y1="40" x2="620" y2="340" stroke="#cbd5e1"/>

  <line x1="70" y1="70" x2="250" y2="70" stroke="#475569" marker-end="url(#b)"/>
  <text x="160" y="63" text-anchor="middle" fill="#64748b">SEND (ciphertext, client_msg_id)</text>
  <line x1="250" y1="100" x2="430" y2="100" stroke="#475569" marker-end="url(#b)"/>
  <text x="340" y="93" text-anchor="middle" fill="#64748b">persist</text>
  <line x1="250" y1="130" x2="70" y2="130" stroke="#059669" marker-end="url(#b)"/>
  <text x="160" y="123" text-anchor="middle" fill="#059669">ACK ✓ (sent)</text>
  <line x1="250" y1="165" x2="620" y2="165" stroke="#475569" marker-end="url(#b)"/>
  <text x="435" y="158" text-anchor="middle" fill="#64748b">DELIVER (via B's conn server)</text>
  <line x1="620" y1="200" x2="250" y2="200" stroke="#475569" marker-end="url(#b)"/>
  <text x="435" y="193" text-anchor="middle" fill="#64748b">RECEIPT delivered ✓✓</text>
  <line x1="250" y1="230" x2="430" y2="230" stroke="#b91c1c" marker-end="url(#b)"/>
  <text x="340" y="223" text-anchor="middle" fill="#b91c1c">delete from inbox</text>
  <line x1="250" y1="260" x2="70" y2="260" stroke="#059669" marker-end="url(#b)"/>
  <text x="160" y="253" text-anchor="middle" fill="#059669">forward ✓✓ to A</text>
  <line x1="620" y1="300" x2="70" y2="300" stroke="#2563eb" marker-end="url(#b)"/>
  <text x="345" y="293" text-anchor="middle" fill="#2563eb">B opens chat → READ (blue ✓✓)</text>
</svg>
```

### 6.3 Group fan-out

Two models. **Server-side fan-out (fan-out on write)**: on a group SEND, the server expands membership and writes one inbox entry per member. Simple, but a 1024-member group is 1024 writes per message — and with E2E, the sender must encrypt separately per device. WhatsApp uses **Sender Keys**: the sender encrypts *once* with a symmetric group key (distributed pairwise via Signal sessions), so fan-out is *routing* N ciphertext copies, not N encryptions. Large broadcast groups still get **rate-limited** and fanned out asynchronously via a queue to protect the write path.

### 6.4 Presence & typing

Presence is high-churn, low-value-per-event — never persist it on the hot path. A device sends a heartbeat; the presence service holds `online` state in Redis with a short TTL. Contacts **subscribe** to a user's presence channel; a state change publishes to subscribers. Typing indicators are pure ephemeral pub/sub — fire-and-forget, never stored, never retried. At scale you **cap** presence fan-out (a celebrity's "last seen" isn't pushed to a million subscribers in real time; it's pull-on-open).

### 6.5 End-to-end encryption (note)

The server is a **blind router of ciphertext**. Each device has a long-term **identity key** + a pool of **one-time prekeys** on the server. A first message performs an **X3DH** handshake to derive a shared secret; thereafter the **Double Ratchet** advances keys per message (forward secrecy + post-compromise security). The server stores/serves prekeys and routes ciphertext but **cannot decrypt**. Consequence: server-side search, previews, and multi-device sync all become harder — companion devices need their own key exchange, and history must be re-encrypted or transferred device-to-device.

## 7. Bottlenecks & Scaling

- **Connection tier RAM/FDs**: the ceiling is sockets/box. Scale horizontally to thousands of boxes; tune epoll/kqueue, `SO_REUSEPORT`, and per-socket buffers. Shard users across boxes; use consistent affinity so reconnects land predictably.
- **Session-store QPS**: every message route reads Redis. Shard Redis by `user_id`; co-locate with routers; cache the last-known conn server on the ingest box to skip a lookup for chatty pairs.
- **Inbox hot partitions**: a viral group or a spammed user creates a hot Cassandra partition. Mitigate with **per-conversation sub-partitioning**, write-rate limits, and async fan-out queues.
- **Group fan-out amplification**: 1 send → 1024 deliveries. Push large-group fan-out to Kafka; deliver at a bounded rate; batch DELIVERs to the same conn server.
- **Reconnect storms**: after a network blip, millions reconnect at once (thundering herd). Use **jittered backoff**, `resume_token` to skip full re-auth, and admission control at the LB.
- **Cross-region routing**: A in EU messaging B in US crosses regions. Route by B's home region; replicate session/inbox asynchronously; accept that presence is eventually consistent globally.

## 8. Failure Scenarios

| Failure | Blast radius | Mitigation |
|---|---|---|
| Connection server crashes | All its sockets drop (~200k users) | Clients auto-reconnect w/ jitter to another box; session TTL expires; undelivered msgs still in inbox → re-delivered on reconnect |
| Redis session store down | Can't locate online recipients | Fall back to "store in inbox, deliver on next reconnect"; degrade to at-least-once via polling; multi-AZ Redis with replicas |
| Cassandra inbox unavailable (write) | Cannot persist → **must not ack** | Reject SEND (client shows clock/retry); never ack unpersisted; write to a secondary DC quorum |
| Duplicate delivery (retry after lost ACK) | User sees message twice | `client_msg_id` dedup at recipient; idempotent inbox writes keyed by server_msg_id |
| Reconnect storm (regional blip) | Thundering herd on auth + session store | Exponential backoff+jitter, resume tokens, LB admission control, prewarmed capacity |
| Message routed to a stale conn server | Delivery lost silently | Conn server ACKs the route; on miss, router re-reads session or falls back to inbox |
| Poison/oversized message | Conn server CPU/mem spike | Size caps, protocol validation, per-user rate limits, circuit breaker |

## 9. Trade-offs & Alternatives

- **Store-and-forward vs full history**: WhatsApp historically kept the server as a *transient queue* (delete on delivery) — tiny storage, strong privacy, but no cloud history/search. Messenger/Telegram keep server history — richer features, far more storage + weaker privacy. **At 10×**, keeping full E2E history forces device-to-device transfer or encrypted backups (the hard part).
- **Pub/sub bus vs direct routing**: pub/sub is simpler operationally but the bus caps throughput; direct RPC via session lookup scales further but needs a rock-solid, low-latency registry. Large systems trend toward **direct routing with sharded registries**.
- **WebSocket vs MQTT vs raw TCP**: MQTT (Facebook Messenger's choice) is lightweight and battery-friendly on mobile; WebSocket is web-friendly; a custom binary framing (WhatsApp) minimizes bytes. Choose by client mix.
- **Fan-out on write vs read**: write (per-member inbox) gives simple, ordered, offline-ready delivery — the right default for chat. Read-time fan-out (like feeds) doesn't fit because chat needs push + receipts.
- **Ordering guarantee**: we chose **per-conversation causal order**, not global total order — cheaper and matches human perception. Total order would need a per-conversation sequencer (a bottleneck).

## 10. Interview Follow-ups

**Q: How does the server know which of thousands of boxes holds a recipient's socket?**
A: A **session registry** (Redis) maps `user_id/device_id → conn_server_id`, written on connect and TTL'd. The router reads it to direct-RPC the message, or uses per-user pub/sub channels so the owning box receives it.

**Q: Why persist before acking the sender?**
A: Durability. If we ack first and crash before persisting, the message is lost with the sender believing it sent. Persist to the recipient's inbox (quorum), *then* ack ✓.

**Q: How do you guarantee a message isn't delivered twice?**
A: Idempotency at two layers — `client_msg_id` (client UUID) dedups retried SENDs; `server_msg_id` (Snowflake) keys the inbox write so re-delivery to the recipient is dedup'd on-device.

**Q: How are messages kept in order?**
A: `server_msg_id` is time-ordered (Snowflake) and is the Cassandra clustering key, so inbox reads on reconnect are ordered. We guarantee **per-conversation** causal order, not cross-sender total order.

**Q (senior): A 1024-member group generates huge fan-out. How do you keep the write path healthy?**
A: Async fan-out through Kafka with a bounded delivery rate, batch DELIVERs per conn server, **Sender Keys** so the payload is encrypted once not per-device, and hot-partition sub-sharding in the inbox. Broadcast groups are rate-limited.

**Q (senior): The recipient is offline for 3 days then reconnects on a plane's flaky wifi. Walk the flow.**
A: All messages sat in their **inbox partition**. On reconnect (resume_token to skip full auth), the client pulls the inbox range since its last acked `server_msg_id`, in order, in pages. Each delivered msg triggers a RECEIPT → sender gets ✓✓ → server deletes it. Flaky wifi → idempotent, resumable, chunked pulls.

**Q (senior): How does presence scale without melting the system?**
A: Presence is ephemeral Redis state with TTL, propagated via pub/sub only to *subscribed contacts*, and **capped** for high-follower users (pull-on-open instead of push). Typing indicators are fire-and-forget, never stored.

**Q: Where does E2E encryption sit, and what does it cost you?**
A: Client-side (Signal: X3DH + Double Ratchet). The server routes ciphertext and serves prekeys but can't read messages. Cost: no server-side search/preview, harder multi-device sync, and history must move device-to-device or via encrypted backup.

**Q: WebSocket vs long-polling vs MQTT for the transport?**
A: A **persistent connection** is mandatory for sub-200ms push — long-polling wastes reconnects and battery. MQTT is battery/bandwidth-efficient on mobile (Messenger); WebSocket suits web; a custom binary protocol minimizes bytes (WhatsApp).

**Q (staff): How do you do a zero-downtime deploy of the stateful connection tier?**
A: Drain gracefully — stop accepting new sockets on a box, signal clients to reconnect elsewhere with jittered backoff, let the session TTL clean up, roll boxes in waves while capacity headroom absorbs the reconnects. Never hard-kill all boxes at once (reconnect storm).

**Q: How do you handle multi-device (phone + web + desktop)?**
A: Each device is a first-class endpoint with its own keys and its own inbox cursor. A message fans out to *all* the recipient's devices; each acks independently. E2E means the sender encrypts per recipient device (or uses Sender Keys for groups).

**Q (staff): How would you support cross-region users with low latency?**
A: Home each user in a region; route by the recipient's home region; replicate session/inbox asynchronously. Accept eventually-consistent global presence. Media served from the nearest CDN edge regardless of home region.

## 11. Cheat Sheet

> [!TIP]
> **Chat (WhatsApp) in one screen.**
> - **Two tiers**: stateful **connection/session** servers own the sockets; stateless routers move messages between them via a **session registry (Redis)**.
> - **Persist before ack**: write to the recipient's **inbox (Cassandra, Snowflake-keyed for order)**, then ✓. Delete on delivery — the server is a *queue*, not an archive.
> - **Receipts**: ✓ sent → ✓✓ delivered → blue ✓✓ read, each routed back to the sender.
> - **Idempotency**: `client_msg_id` (dedup SEND) + `server_msg_id` (dedup delivery, enforce order).
> - **Groups**: async fan-out on write; **Sender Keys** encrypt once; rate-limit big groups.
> - **Presence/typing**: ephemeral Redis + pub/sub, TTL'd, capped for celebrities.
> - **E2E**: Signal (X3DH + Double Ratchet); server routes ciphertext only.
> - **Bottleneck** = sockets/box + session-store QPS + group fan-out amplification.
> - **Failure creed**: reconnect w/ jitter + resume tokens; undelivered stays durable in inbox.

**References:** High Scalability — "The WhatsApp Architecture Facebook Bought For $19 Billion"; Signal Protocol docs (X3DH, Double Ratchet); Facebook Engineering — "Building Mobile-first messaging (MQTT)"; Cassandra docs (wide rows, clustering keys); DDIA ch.11 (stream processing / message delivery).

---

*System Design Handbook — topic 34.*
