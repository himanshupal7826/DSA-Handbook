# 36 · Case Study: WhatsApp-like Messaging Storage

> **In one line:** A messaging data layer is a set of **per-conversation append-only logs** ordered by a **server-assigned sequence number**, plus a few **monotonic pointers** per member (delivered, read, device sync cursor). Get the log key, the sequencer and the pointers right and ordering, receipts, idempotency, multi-device sync and retention all fall out of it.

---

## 1. Overview

> **Builds on:** [SQL Handbook · Schema Design](../sql/topic.html?p=30-schema-design) (entities and keys — not repeated here) · [SQL Handbook · Sorting & Pagination](../sql/topic.html?p=03-sorting-pagination) (keyset pagination) · [Ch 04 · Concurrency Control](topic.html?p=04-concurrency-control) · [Ch 11 · Partitioning](topic.html?p=11-partitioning) · [Ch 12 · Sharding](topic.html?p=12-sharding) · [Ch 30 · SQL vs NoSQL](topic.html?p=30-sql-vs-nosql). The whole-system view (connection gateways, presence, push, E2E encryption) lives in [System Design · Design WhatsApp](../system-design/topic.html?p=34-design-chat-whatsapp); this chapter is only the **data layer**: what is stored where, in which order, with which keys, and what each critical write looks like.

### The product

You are building the storage for a WhatsApp/Messenger-style chat product with **server-side history and multi-device** (a phone plus up to four linked devices that must all show the same conversation in the same order).

**Functional requirements**

- 1:1 chats and groups of up to 1,024 members.
- Send text (media is uploaded to object storage; the message carries a reference).
- Per-recipient **delivery** and **read** receipts ("two grey ticks", "two blue ticks"; "read by 37 of 120" in groups).
- Scroll back through history; open a chat and see the latest 50 messages instantly.
- **Multi-device sync**: a laptop that was asleep for three days catches up on exactly what it missed.
- **Disappearing messages** (24 h / 7 d / 90 d timers) and "delete for everyone".
- A client that retries a send after a timeout must never produce a duplicate message.

**Non-functional requirements**

- Server ack of a send: p99 under 150 ms. After the ack, the message is never lost (RPO = 0 for acknowledged messages).
- **Every device sees a conversation in the same order.** Order across different conversations does not matter.
- 99.99% availability for send and sync; receipts may lag by seconds.
- Retention: server-side history 1 year by default (configurable), disappearing messages physically removed within a day of expiry.

### Workload estimate

| Quantity | Estimate | Derivation |
|---|---|---|
| Registered / daily active users | 2 B / 500 M | product assumption |
| Messages sent per day | 20 B | 40 sends per DAU |
| Average send rate / peak | ~230 K/s / ~700 K/s | 20 B / 86,400; peak ≈ 3× (evenings, New Year's Eve spikes are 5–10×) |
| Recipients per message (avg) | ~1.8 | most traffic is 1:1; groups skew the tail |
| Receipt pointer updates | ~40 B/day (~460 K/s) | coalesced: roughly one delivered + one read update per recipient per burst |
| History reads (open chat, scroll) | ~150 K/s | 3 chat opens per active hour per online user |
| Sync requests (device wake) | ~50 K/s | linked devices reconnecting |
| Stored message size | ~250 B | ~100 B ciphertext + keys, ids, timestamps, row overhead |
| New data per day | ~5 TB raw, ~15 TB with RF=3 | 20 B × 250 B |
| Hot retained set (1 year) | on the order of 2 PB raw | before compression; this is why message bodies do not live on one Postgres cluster |

The read/write ratio is unusual: **writes dominate** (sends + receipts ≈ 700 K/s average vs ~200 K/s of reads), and nearly every read is "the tail of one conversation". That shape — write-heavy, append-mostly, read by key range — is precisely what an LSM-tree wide-column store is built for, and the reason the message log leaves Postgres at scale (see [Ch 22 · Capacity Planning](topic.html?p=22-capacity-planning) for the method behind these numbers).

### Why the naive schema breaks

The first design most people write is:

```sql
CREATE TABLE messages (id bigserial PRIMARY KEY, conversation_id bigint, sender_id bigint,
                       body text, created_at timestamptz DEFAULT now());
CREATE TABLE message_status (message_id bigint, user_id bigint, status text,   -- sent/delivered/read
                             PRIMARY KEY (message_id, user_id));
-- history:  SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 50;
```

Every line of it fails at this scale:

1. **`ORDER BY created_at` is not an order.** Two app servers stamp `now()` with clocks that disagree by tens of milliseconds; two messages in the same millisecond tie. A reply can sort before the question it answers, and two devices paging with `created_at < $x` can skip or repeat messages.
2. **`bigserial` is a global sequence on one node.** It cannot be the ordering key once messages are sharded, and it gives no per-conversation gap detection ("I have 41 and 43 — where is 42?").
3. **`message_status` is one row per message per recipient.** A 1,000-member group turns one message into 1,000 inserts and then 2,000 updates (delivered, read). At 20 B messages/day that table would absorb more writes than the messages themselves, grow by trillions of rows, and bloat with dead tuples ([Ch 03 · MVCC](topic.html?p=03-mvcc)).
4. **No idempotency.** The client times out, retries, and the chat shows the message twice.
5. **Retention by `DELETE`.** Deleting a billion expired rows a day from a heap creates dead tuples, index bloat and WAL storms — and in Cassandra, tombstones.
6. **No sync model.** "What did device D miss?" becomes a scan over every conversation the user is in.

The rest of the chapter replaces each of those with a structure that scales.

## 2. Core Concepts

The domain entities and the **invariants that must always hold**:

- **Conversation** — a 1:1 chat or a group. Owns a **per-conversation sequence counter** `last_seq`. *Why it matters:* the conversation is the unit of ordering and therefore the unit of partitioning.
- **Message** — an immutable entry in a conversation's log, identified by `(conv_id, seq)`. Edits and deletes are new log entries (or tombstone flags), never in-place rewrites of history.
- **Sequence number (`seq`)** — assigned by the server at commit time, dense (1, 2, 3, …) within a conversation. *Invariant:* **every device renders a conversation in `seq` order, and `seq` is unique and gap-free per conversation** (a gap is either a message you have not fetched yet or an explicit "skipped" marker).
- **Client message id (`client_msg_id`)** — a UUID generated on the sending device before the first attempt and reused on every retry. *Invariant:* **at most one message per `(conv_id, client_msg_id)`**.
- **Membership** — `(conv_id, user_id)` with `joined_seq` / `left_seq`. *Invariant:* a member sees only messages with `joined_seq < seq` and (if they left) `seq <= left_seq`.
- **Delivered / read watermarks** — per member: `delivered_seq`, `read_seq`. *Invariant:* **watermarks only move forward** and `read_seq <= delivered_seq <= last_seq`. Reading message 50 implies you read 1–49; you never store one row per message per reader.
- **Per-user inbox (sync log)** — a per-user append-only log of "something changed in conversation C at seq S", with its own per-user `inbox_seq`. Devices keep a **sync cursor** into it.
- **Device cursor** — per device: last `inbox_seq` processed. *Why it matters:* catch-up is `inbox_seq > cursor`, an index range scan, regardless of how long the device slept (up to the inbox's retention).
- **Retention / expiry** — a message has an `expires_at` derived from the conversation's timer at send time. *Invariant:* an expired message is never served, even before it is physically removed.
- **Ciphertext** — with end-to-end encryption the server stores opaque bytes. The data layer never needs to read message content; it indexes only metadata.

## 3. Theory & Principles

### Access patterns, ranked

Design the storage from the top of this list down; anything below the line can be slower or eventually consistent.

| # | Access pattern | Rate | Shape | Consistency needed |
|---|---|---|---|---|
| 1 | Append message to conversation, get `seq` | ~230 K/s avg | single-partition write + counter bump | **Strong** within the conversation (order, dedup) |
| 2 | Advance delivered/read watermark | ~460 K/s | single-row monotonic update | Monotonic per member; seconds of lag OK |
| 3 | Fetch the tail of a conversation (latest 50) | ~150 K/s | single-partition range read, newest first | Read-your-writes for the sender |
| 4 | Device sync: "what changed since cursor X?" | ~50 K/s | per-user range read | Eventual (seconds), but **complete** |
| 5 | List my conversations by recent activity | ~40 K/s | per-user sorted list | Eventual |
| 6 | Scroll back in history | ~20 K/s | keyset range read `seq < X` | Eventual |
| 7 | "Read by" details for a group message | low | members with `read_seq >= S` | Eventual |
| 8 | Expire / delete messages | ~230 K/s of expiries at steady state | bulk, time-driven | Hide immediately, remove lazily |

Two keys fall straight out of this table: everything in patterns 1, 2, 3, 6, 7 is keyed by **`conv_id`**, and everything in 4 and 5 is keyed by **`user_id`**. They are different shard keys, so the design has two families of tables, and the bridge between them is asynchronous fan-out. This is the single most important design decision in the chapter (see [Ch 12 · Sharding](topic.html?p=12-sharding) on choosing shard keys from access patterns).

### Ordering: timestamps vs server-assigned sequence numbers

There are three candidate ordering keys, and only one gives you every property you need:

- **Client timestamps** — wrong by definition: phone clocks are off by minutes, and a malicious client can backdate.
- **Server timestamps / Snowflake ids** — roughly time-ordered and unique, and good enough to sort a *per-user inbox* or a *global* feed. But they are generated on different servers with skewed clocks, so two messages sent 5 ms apart to the same group through two gateways can invert, and they have gaps by design so a client cannot detect a missing message.
- **Per-conversation sequence number** assigned at the moment the message is committed to the conversation's log — a **total order within the conversation**, identical for every reader, dense so gaps are detectable, and cheap to page by (`seq < 1200 ORDER BY seq DESC`).

The cost of a per-conversation sequence is that **there must be one serialisation point per conversation**. That is exactly the right granularity: a conversation's send rate is bounded by humans (even a busy 1,024-member group rarely exceeds tens of messages per second), while the number of conversations is enormous and they are independent. You get total order where users can see it, and unlimited parallelism across conversations. This is [Ch 10 · Consistency Models](topic.html?p=10-consistency-models) applied precisely: linearizable per conversation, no ordering guarantee across conversations.

```svg
<svg viewBox="0 0 880 520" width="100%" height="520" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c36a1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
    <marker id="c36a2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Ordering a conversation: server timestamps vs a per-conversation sequence</text>
  <rect x="20" y="40" width="410" height="230" rx="10" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="225" y="62" text-anchor="middle" fill="#991b1b" font-size="12" font-weight="bold">ORDER BY created_at (two gateways, skewed clocks)</text>
  <rect x="40" y="80" width="170" height="44" rx="6" fill="#ffffff" stroke="#dc2626"/>
  <text x="125" y="98" text-anchor="middle" fill="#334155">Gateway A (clock +40 ms)</text>
  <text x="125" y="114" text-anchor="middle" fill="#334155">Alice: "lunch?" at 12:00:00.140</text>
  <rect x="240" y="80" width="170" height="44" rx="6" fill="#ffffff" stroke="#dc2626"/>
  <text x="325" y="98" text-anchor="middle" fill="#334155">Gateway B (clock -30 ms)</text>
  <text x="325" y="114" text-anchor="middle" fill="#334155">Bob: "yes!" at 12:00:00.110</text>
  <text x="225" y="148" text-anchor="middle" fill="#334155">Bob really replied 50 ms AFTER Alice, but his stamp is earlier</text>
  <rect x="60" y="162" width="330" height="26" rx="5" fill="#ffffff" stroke="#94a3b8"/>
  <text x="225" y="179" text-anchor="middle" fill="#991b1b">rendered: 1. Bob "yes!"   2. Alice "lunch?"</text>
  <text x="40" y="210" fill="#991b1b">- ties within the same millisecond: order depends on the plan</text>
  <text x="40" y="228" fill="#991b1b">- gaps are normal, so a device cannot detect a missing message</text>
  <text x="40" y="246" fill="#991b1b">- paging with created_at &lt; X can skip or repeat rows</text>
  <rect x="450" y="40" width="410" height="230" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="655" y="62" text-anchor="middle" fill="#166534" font-size="12" font-weight="bold">Per-conversation seq assigned at commit</text>
  <rect x="470" y="80" width="130" height="44" rx="6" fill="#ffffff" stroke="#16a34a"/>
  <text x="535" y="98" text-anchor="middle" fill="#334155">Alice send</text>
  <text x="535" y="114" text-anchor="middle" fill="#334155">locks conv row</text>
  <rect x="710" y="80" width="130" height="44" rx="6" fill="#ffffff" stroke="#16a34a"/>
  <text x="775" y="98" text-anchor="middle" fill="#334155">Bob send</text>
  <text x="775" y="114" text-anchor="middle" fill="#334155">waits for the lock</text>
  <rect x="610" y="140" width="90" height="36" rx="6" fill="#ffffff" stroke="#16a34a" stroke-width="2"/>
  <text x="655" y="156" text-anchor="middle" fill="#166534" font-weight="bold">conv 77</text>
  <text x="655" y="170" text-anchor="middle" fill="#166534">last_seq</text>
  <path d="M560,126 L630,140" stroke="#16a34a" stroke-width="2" fill="none" marker-end="url(#c36a2)"/>
  <path d="M750,126 L682,140" stroke="#16a34a" stroke-width="2" fill="none" marker-end="url(#c36a2)"/>
  <rect x="490" y="190" width="330" height="26" rx="5" fill="#ffffff" stroke="#94a3b8"/>
  <text x="655" y="207" text-anchor="middle" fill="#166534">rendered: 41 Alice "lunch?"   42 Bob "yes!"</text>
  <text x="470" y="236" fill="#166534">- one total order, identical on every device</text>
  <text x="470" y="254" fill="#166534">- dense: holding 41 and 43 means 42 is missing</text>
  <rect x="20" y="290" width="840" height="215" rx="10" fill="#f8fafc" stroke="#94a3b8" stroke-width="2"/>
  <text x="440" y="312" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="bold">Receipts as watermarks over the same sequence (group conv 77, last_seq = 12)</text>
  <text x="40" y="344" fill="#334155">seq</text>
  <rect x="80" y="330" width="50" height="22" fill="#dbeafe" stroke="#2563eb"/><text x="105" y="345" text-anchor="middle" fill="#1e293b">1..3</text>
  <rect x="130" y="330" width="50" height="22" fill="#dbeafe" stroke="#2563eb"/><text x="155" y="345" text-anchor="middle" fill="#1e293b">4..5</text>
  <rect x="180" y="330" width="50" height="22" fill="#dbeafe" stroke="#2563eb"/><text x="205" y="345" text-anchor="middle" fill="#1e293b">6</text>
  <rect x="230" y="330" width="50" height="22" fill="#dbeafe" stroke="#2563eb"/><text x="255" y="345" text-anchor="middle" fill="#1e293b">7</text>
  <rect x="280" y="330" width="50" height="22" fill="#dbeafe" stroke="#2563eb"/><text x="305" y="345" text-anchor="middle" fill="#1e293b">8</text>
  <rect x="330" y="330" width="50" height="22" fill="#dbeafe" stroke="#2563eb"/><text x="355" y="345" text-anchor="middle" fill="#1e293b">9</text>
  <rect x="380" y="330" width="50" height="22" fill="#dbeafe" stroke="#2563eb"/><text x="405" y="345" text-anchor="middle" fill="#1e293b">10</text>
  <rect x="430" y="330" width="50" height="22" fill="#dbeafe" stroke="#2563eb"/><text x="455" y="345" text-anchor="middle" fill="#1e293b">11</text>
  <rect x="480" y="330" width="50" height="22" fill="#dbeafe" stroke="#2563eb"/><text x="505" y="345" text-anchor="middle" fill="#1e293b">12</text>
  <text x="40" y="386" fill="#334155">Carol</text>
  <rect x="80" y="374" width="450" height="16" fill="#dcfce7" stroke="#16a34a"/>
  <text x="560" y="386" fill="#166534">delivered_seq = 12, read_seq = 12</text>
  <text x="40" y="416" fill="#334155">Dan</text>
  <rect x="80" y="404" width="350" height="16" fill="#dcfce7" stroke="#16a34a"/>
  <rect x="430" y="404" width="100" height="16" fill="#fef3c7" stroke="#d97706"/>
  <text x="560" y="416" fill="#92400e">delivered_seq = 12, read_seq = 10</text>
  <text x="40" y="446" fill="#334155">Erin</text>
  <rect x="80" y="434" width="200" height="16" fill="#fef3c7" stroke="#d97706"/>
  <text x="560" y="446" fill="#92400e">delivered_seq = 7, read_seq = 0 (phone offline)</text>
  <text x="40" y="478" fill="#1e293b" font-weight="bold">Two integers per member, not one row per message per member.</text>
  <text x="40" y="496" fill="#334155">"Read by" for seq 9 = members with read_seq &gt;= 9 (Carol, Dan). Unread count for Dan = last_seq - read_seq = 2.</text>
</svg>
```

### Consistency boundaries

| Data | Boundary | Why |
|---|---|---|
| `conversations.last_seq` + the message row + dedup | **Strong, one transaction on one shard** | Order and "no duplicate" are user-visible invariants; they must be decided atomically. |
| Member watermarks | **Monotonic, single-row**, eventually visible to others | A receipt that shows up 2 s late is fine; a receipt that goes *backwards* (blue ticks turning grey) is a bug. |
| Per-user inbox / conversation list | **Eventual**, derived by fan-out from the conversation log | Lives on a different shard key; must be *complete* (every message eventually appears) but may lag. |
| Push notifications, search, analytics | **Eventual**, via CDC/outbox | Derived views; losing one is recoverable by rebuilding from the log. |
| Media blobs | Object storage, content-addressed | Uploaded before the message referencing them is sent, so the reference is never dangling. |

Notice what is *not* strongly consistent: the per-user side. That is deliberate — making "append to conversation" and "append to 1,024 users' inboxes" one atomic unit would require a cross-shard transaction on every group message ([Ch 13 · Distributed Transactions](topic.html?p=13-distributed-transactions)). Instead the conversation log is the **source of truth**, and every per-user structure is a rebuildable projection of it.

## 4. Architecture & Workflow

### Data architecture

```svg
<svg viewBox="0 0 880 560" width="100%" height="560" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c36b1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="c36b2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
    <marker id="c36b3" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Messaging data layer: conversation-keyed truth, user-keyed projections</text>
  <rect x="20" y="44" width="150" height="60" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="95" y="68" text-anchor="middle" fill="#1e293b" font-weight="bold">Devices</text>
  <text x="95" y="86" text-anchor="middle" fill="#334155">client_msg_id, cursors</text>
  <rect x="220" y="44" width="170" height="60" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="305" y="68" text-anchor="middle" fill="#1e293b" font-weight="bold">Chat gateway</text>
  <text x="305" y="86" text-anchor="middle" fill="#334155">websocket, routes by conv_id</text>
  <path d="M172,74 L218,74" stroke="#2563eb" stroke-width="2" marker-end="url(#c36b1)"/>
  <rect x="440" y="44" width="170" height="60" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="525" y="68" text-anchor="middle" fill="#1e293b" font-weight="bold">Message service</text>
  <text x="525" y="86" text-anchor="middle" fill="#334155">sequencer + dedup</text>
  <path d="M392,74 L438,74" stroke="#2563eb" stroke-width="2" marker-end="url(#c36b1)"/>
  <rect x="660" y="44" width="200" height="60" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="760" y="64" text-anchor="middle" fill="#1e293b" font-weight="bold">Object storage + CDN</text>
  <text x="760" y="80" text-anchor="middle" fill="#334155">media blobs (uploaded first)</text>
  <text x="760" y="95" text-anchor="middle" fill="#334155">message holds key + hash</text>
  <rect x="20" y="140" width="400" height="190" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="220" y="162" text-anchor="middle" fill="#1e3a8a" font-size="12" font-weight="bold">Postgres, sharded by conv_id (source of truth)</text>
  <rect x="40" y="176" width="175" height="68" rx="6" fill="#ffffff" stroke="#2563eb"/>
  <text x="127" y="194" text-anchor="middle" fill="#1e293b" font-weight="bold">conversations</text>
  <text x="127" y="210" text-anchor="middle" fill="#334155">last_seq (the sequencer)</text>
  <text x="127" y="226" text-anchor="middle" fill="#334155">retention timer</text>
  <rect x="225" y="176" width="175" height="68" rx="6" fill="#ffffff" stroke="#2563eb"/>
  <text x="312" y="194" text-anchor="middle" fill="#1e293b" font-weight="bold">conversation_members</text>
  <text x="312" y="210" text-anchor="middle" fill="#334155">delivered_seq, read_seq</text>
  <text x="312" y="226" text-anchor="middle" fill="#334155">joined_seq, left_seq</text>
  <rect x="40" y="254" width="175" height="60" rx="6" fill="#ffffff" stroke="#2563eb"/>
  <text x="127" y="272" text-anchor="middle" fill="#1e293b" font-weight="bold">message_ids</text>
  <text x="127" y="288" text-anchor="middle" fill="#334155">(conv_id, client_msg_id)</text>
  <text x="127" y="302" text-anchor="middle" fill="#334155">to seq: the dedup index</text>
  <rect x="225" y="254" width="175" height="60" rx="6" fill="#ffffff" stroke="#2563eb"/>
  <text x="312" y="272" text-anchor="middle" fill="#1e293b" font-weight="bold">outbox</text>
  <text x="312" y="288" text-anchor="middle" fill="#334155">message.sent, receipt events</text>
  <text x="312" y="302" text-anchor="middle" fill="#334155">same txn as the send</text>
  <path d="M525,106 L400,138" stroke="#2563eb" stroke-width="2" marker-end="url(#c36b1)"/>
  <text x="470" y="128" fill="#1e3a8a">1. txn: seq + dedup + outbox</text>
  <rect x="460" y="140" width="400" height="190" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="660" y="162" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">ScyllaDB / Cassandra: message bodies</text>
  <rect x="480" y="176" width="360" height="56" rx="6" fill="#ffffff" stroke="#7c3aed"/>
  <text x="660" y="196" text-anchor="middle" fill="#1e293b" font-weight="bold">messages_by_conv</text>
  <text x="660" y="214" text-anchor="middle" fill="#334155">PRIMARY KEY ((conv_id, bucket), seq)  bucket = seq / 10000</text>
  <rect x="480" y="242" width="360" height="72" rx="6" fill="#ffffff" stroke="#7c3aed"/>
  <text x="660" y="262" text-anchor="middle" fill="#1e293b" font-weight="bold">ephemeral_messages_24h / _7d / _90d</text>
  <text x="660" y="280" text-anchor="middle" fill="#334155">uniform default_time_to_live per table</text>
  <text x="660" y="298" text-anchor="middle" fill="#334155">TWCS: whole SSTables expire and drop</text>
  <path d="M600,106 L640,138" stroke="#7c3aed" stroke-width="2" marker-end="url(#c36b2)"/>
  <text x="652" y="126" fill="#5b21b6">2. idempotent upsert of body</text>
  <rect x="20" y="360" width="250" height="70" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="145" y="384" text-anchor="middle" fill="#1e293b" font-weight="bold">Kafka: message.sent</text>
  <text x="145" y="402" text-anchor="middle" fill="#334155">keyed by conv_id (per-conv order)</text>
  <text x="145" y="418" text-anchor="middle" fill="#334155">fed by outbox relay / CDC</text>
  <path d="M130,332 L130,358" stroke="#d97706" stroke-width="2" marker-end="url(#c36b1)"/>
  <rect x="310" y="360" width="200" height="70" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="410" y="384" text-anchor="middle" fill="#1e293b" font-weight="bold">Fan-out workers</text>
  <text x="410" y="402" text-anchor="middle" fill="#334155">skip groups &gt; 256 members</text>
  <text x="410" y="418" text-anchor="middle" fill="#334155">idempotent per (user, conv, seq)</text>
  <path d="M272,395 L308,395" stroke="#d97706" stroke-width="2" marker-end="url(#c36b1)"/>
  <rect x="550" y="360" width="310" height="70" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="705" y="382" text-anchor="middle" fill="#1e293b" font-weight="bold">Postgres, sharded by user_id</text>
  <text x="705" y="400" text-anchor="middle" fill="#334155">user_inbox (user_id, inbox_seq)  sync log</text>
  <text x="705" y="416" text-anchor="middle" fill="#334155">user_conversations: chat list, pin, mute</text>
  <path d="M512,395 L548,395" stroke="#16a34a" stroke-width="2" marker-end="url(#c36b3)"/>
  <text x="530" y="386" text-anchor="middle" fill="#166534">3</text>
  <rect x="20" y="450" width="400" height="92" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="40" y="472" fill="#1e293b" font-weight="bold">Write path (send)</text>
  <text x="40" y="490" fill="#334155">1. one Postgres txn on the conv shard: seq, dedup, outbox</text>
  <text x="40" y="506" fill="#334155">2. write body to Scylla keyed by (conv_id, bucket, seq), retried</text>
  <text x="40" y="522" fill="#334155">3. ack client with seq; fan-out to user shards happens async</text>
  <rect x="460" y="450" width="400" height="92" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="480" y="472" fill="#1e293b" font-weight="bold">Read paths</text>
  <text x="480" y="490" fill="#334155">open chat: Scylla partition (conv_id, current bucket) newest first</text>
  <text x="480" y="506" fill="#334155">sync: user_inbox WHERE inbox_seq &gt; device cursor</text>
  <text x="480" y="522" fill="#334155">receipts: conversation_members watermarks (conv shard)</text>
</svg>
```

Two families of storage, bridged by an event stream:

- **Conversation-keyed truth** (Postgres sharded by `conv_id`): the sequencer, membership, watermarks, the dedup index and an outbox. Small rows, heavy concurrency, transactional. At the "Tier A" size (up to a few hundred million messages a day) the message bodies live here too, in a hash-partitioned `messages` table.
- **Message bodies at scale** (ScyllaDB or Cassandra): append-only, write-dominated, read by partition range, expired by TTL. This is the textbook wide-column workload ([Cassandra · Primary Key, Partition & Clustering](../cassandra/topic.html?p=06-primary-key-partition-clustering)); Discord runs exactly this shape.
- **User-keyed projections** (Postgres sharded by `user_id`): per-user sync log and conversation list. Written only by fan-out workers from the Kafka topic, so they can be rebuilt from the log.
- **Redis** (not drawn) holds ephemeral state that is safe to lose: presence, "typing…", which gateway a device is connected to, and a hot cache of the last page of very busy groups ([Ch 19 · Database Caching Architecture](topic.html?p=19-database-caching-architecture)).

### The send, step by step

```text
Device D (Alice)                Message service                 Conv shard (PG)          Scylla             Kafka
 gen client_msg_id=u1
 send(conv 77, u1, body) ─────► BEGIN
                                UPDATE conversations ... last_seq+1  ─► row lock on conv 77 (serialises senders)
                                INSERT message_ids (77,u1,seq=42) ON CONFLICT DO NOTHING
                                INSERT outbox(message.sent 77/42)
                                COMMIT  ◄─ fsync WAL, sync replica ack
                                INSERT messages_by_conv (77, 0, 42, ...) ─────────────────► QUORUM ack
 ◄──────────── ack {seq: 42}
                                                     outbox relay ───────────────────────────────────────► topic, key=77
                                                     fan-out: user_inbox(Bob, n+1, 77, 42), push to Bob's devices
```

If the client does not get the ack (timeout, gateway crash) it resends **the same `u1`**. The dedup insert conflicts, the transaction rolls back (so `last_seq` is not bumped twice), the service reads the original `seq` from `message_ids`, re-issues the Scylla upsert (harmless: same key, same value) and acks `42`. The retry is also what heals the one crash window in this design — Postgres committed but the Scylla write never happened.

### Sync for a linked device

```text
laptop wakes, cursor = 88,120
  SELECT conv_id, max(conv_seq) FROM user_inbox
   WHERE user_id = Alice AND inbox_seq > 88120 GROUP BY conv_id;      -> {77: 45, 912: 3}
  + for each large group Alice is in (not fanned out): conversations.last_seq  -> {5001: 90231}
  for each conv: fetch messages seq > local_seq_for_conv (keyset, 200 per page)
  advance cursor to the max inbox_seq seen, persist on device and in device_cursors
```

Large groups are deliberately **not** fanned out into every member's inbox (a 1,024-member group would multiply sync-log writes by 1,024). Devices instead check `last_seq` for the small set of large groups they belong to — the same hybrid push/pull trade-off as a celebrity-heavy news feed.

## 5. Implementation

### Conversation shard schema (PostgreSQL)

Shard routing is by `conv_id` (application-level, or Citus with `conv_id` as distribution column so these tables are co-located). Everything below is on the same shard for a given conversation, so every critical transaction is **single-shard**.

```sql
CREATE TABLE conversations (
    conv_id       bigint PRIMARY KEY,               -- 1:1 chats: deterministic id from hash(min(u1,u2), max(u1,u2))
    kind          smallint NOT NULL,                -- 1 = direct, 2 = group
    title         text,
    last_seq      bigint NOT NULL DEFAULT 0,        -- THE sequencer
    last_msg_at   timestamptz,
    member_count  int    NOT NULL DEFAULT 0,
    retention     interval,                         -- NULL = default policy; '24 hours' etc. = disappearing
    fanout_mode   smallint NOT NULL DEFAULT 1,      -- 1 = push to user inboxes, 2 = pull (large group)
    created_at    timestamptz NOT NULL DEFAULT now()
) WITH (fillfactor = 80);                           -- room for HOT updates of last_seq

CREATE TABLE conversation_members (
    conv_id        bigint NOT NULL REFERENCES conversations,
    user_id        bigint NOT NULL,
    role           smallint NOT NULL DEFAULT 0,
    joined_seq     bigint NOT NULL,                 -- sees seq > joined_seq only
    left_seq       bigint,                          -- NULL while a member
    delivered_seq  bigint NOT NULL DEFAULT 0,       -- NOT indexed: keeps updates HOT
    read_seq       bigint NOT NULL DEFAULT 0,       -- NOT indexed
    PRIMARY KEY (conv_id, user_id),
    CHECK (read_seq <= delivered_seq)
) WITH (fillfactor = 70);

CREATE TABLE message_ids (                          -- dedup index: exists in Tier B when bodies live in Scylla
    conv_id        bigint NOT NULL,
    client_msg_id  uuid   NOT NULL,
    seq            bigint NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (conv_id, client_msg_id)
);

CREATE TABLE outbox (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    conv_id     bigint NOT NULL,
    event_type  text   NOT NULL,
    payload     jsonb  NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
```

Index justification: every hot query is by `(conv_id, …)` primary key, so there are **no secondary indexes** on the hot tables. That is intentional. `conversation_members` is updated ~460 K times per second across the fleet; if `read_seq` were indexed, every receipt would write a new index entry and lose the HOT optimisation, multiplying WAL and bloat ([Ch 02 · Storage Internals](topic.html?p=02-storage-internals)). The rare "who has read seq ≥ S" query scans at most 1,024 rows of one conversation via the primary key — cheap.

`message_ids` rows are only needed as long as a client might retry: prune rows older than 7 days in batches (or partition it by week and drop partitions).

### Tier A: message bodies in Postgres

Until roughly a few hundred million messages per day, keep bodies in Postgres on the conversation shard — one system, one transaction, no dual write:

```sql
CREATE TABLE messages (
    conv_id        bigint   NOT NULL,
    seq            bigint   NOT NULL,
    sender_id      bigint   NOT NULL,
    sender_device  smallint NOT NULL,
    client_msg_id  uuid     NOT NULL,
    kind           smallint NOT NULL,              -- 1 text, 2 media ref, 3 edit, 4 delete-for-everyone
    body           bytea,                          -- ciphertext; media = object key + hash inside
    created_at     timestamptz NOT NULL DEFAULT now(),
    expires_at     timestamptz,
    PRIMARY KEY (conv_id, seq),
    UNIQUE (conv_id, client_msg_id)                -- unique on a partitioned table must include conv_id: it does
) PARTITION BY HASH (conv_id);

CREATE TABLE messages_p00 PARTITION OF messages FOR VALUES WITH (MODULUS 64, REMAINDER 0);
-- ... p01 .. p63

CREATE INDEX messages_expiry ON messages (expires_at) WHERE expires_at IS NOT NULL;   -- expiry sweeper only
```

Hash partitioning keeps each partition's B-tree and vacuum work bounded ([Ch 11 · Partitioning](topic.html?p=11-partitioning), [SQL Handbook · Partitioning](../sql/topic.html?p=23-partitioning) for syntax). Retention by `DELETE ... WHERE expires_at < now()` is tolerable at this size; at Tier B it is the reason bodies move to a TTL-native store.

### The critical transaction: send (sequencer + dedup, Tier A)

```sql
BEGIN;  -- READ COMMITTED is enough: the row lock on the conversation is the serialisation point

-- 1. Membership check and seq allocation in one statement. The UPDATE takes a row lock on conv 77;
--    a concurrent sender to the same conversation blocks here until we commit or roll back.
UPDATE conversations c
   SET last_seq = c.last_seq + 1, last_msg_at = now()
 WHERE c.conv_id = 77
   AND EXISTS (SELECT 1 FROM conversation_members m
                WHERE m.conv_id = 77 AND m.user_id = 1001 AND m.left_seq IS NULL)
RETURNING c.last_seq AS seq, c.retention;
-- 0 rows -> not a member (or no such conversation): ROLLBACK, reply 403.

-- 2. Insert the message. A retry of the same client_msg_id conflicts on the UNIQUE (conv_id, client_msg_id).
INSERT INTO messages (conv_id, seq, sender_id, sender_device, client_msg_id, kind, body, expires_at)
VALUES (77, 42, 1001, 2, 'f1e0c2c4-6d1b-4a4e-9a51-6f0d6b2f9e11', 1, '\x8a91...',
        now() + NULL::interval)                     -- retention from step 1; NULL -> no expiry
ON CONFLICT (conv_id, client_msg_id) DO NOTHING
RETURNING seq;
-- 0 rows -> duplicate: ROLLBACK (undoes the last_seq bump, so no gap), then
--   SELECT seq, created_at FROM messages WHERE conv_id = 77 AND client_msg_id = 'f1e0...';
--   and ack the ORIGINAL seq.

-- 3. The sender has trivially read their own message.
UPDATE conversation_members
   SET delivered_seq = 42, read_seq = 42
 WHERE conv_id = 77 AND user_id = 1001 AND read_seq < 42;

-- 4. Outbox event for fan-out and push (published by a relay / Debezium).
INSERT INTO outbox (conv_id, event_type, payload)
VALUES (77, 'message.sent', '{"conv_id":77,"seq":42,"sender":1001}');

COMMIT;
```

Why this is correct under concurrency:

- **Order**: all sends to conversation 77 serialise on its row lock, so seq values are handed out in commit order with no gaps (a rollback also rolls back the increment — unlike a `SEQUENCE`, which is non-transactional and leaves gaps).
- **Duplicate retries racing each other**: the second attempt blocks on the conversation row lock; when it proceeds, its `INSERT ... ON CONFLICT` sees the first attempt's committed row and does nothing. Even without the row lock, the unique index would make the second insert wait for the first transaction and then detect the conflict.
- **Throughput limit**: one conversation is limited by how many lock-hold-commit cycles per second one row can do. With a sync-replica commit of ~2–5 ms, that is a few hundred sends per second per conversation — orders of magnitude above what humans produce. Keep the transaction tiny: never call anything external while holding the lock ([Ch 05 · Locking Internals](topic.html?p=05-locking-internals)).

> **MySQL difference:** InnoDB has no `UPDATE ... RETURNING`. The classic idiom is `UPDATE conversations SET last_seq = LAST_INSERT_ID(last_seq + 1) WHERE conv_id = 77;` followed by `SELECT LAST_INSERT_ID();` (connection-local, so safe under concurrency), then `INSERT ... ON DUPLICATE KEY UPDATE seq = seq` or `INSERT IGNORE` for the dedup (beware `INSERT IGNORE` also downgrades other errors, such as truncation, to warnings). The row-lock serialisation is the same; InnoDB's unique-index check additionally takes gap/next-key locks, which can deadlock concurrent duplicate retries — retry on error 1213.

### Receipts: monotonic watermarks, not status rows

```sql
-- Bob's phone reports "read up to 42" (it sends a watermark, never per-message acks).
UPDATE conversation_members
   SET read_seq      = 42,
       delivered_seq = GREATEST(delivered_seq, 42)
 WHERE conv_id = 77 AND user_id = 2002
   AND read_seq < 42;          -- monotonic AND skips no-op writes (no new tuple version at all)

-- Delivered watermark from the device that received it:
UPDATE conversation_members SET delivered_seq = 45
 WHERE conv_id = 77 AND user_id = 2002 AND delivered_seq < 45;

-- Group "message info" screen for seq 40:
SELECT user_id, (read_seq >= 40) AS has_read
  FROM conversation_members
 WHERE conv_id = 77 AND delivered_seq >= 40 AND left_seq IS NULL;

-- Unread badge per conversation (on the user shard, maintained by fan-out):
--   unread = conv_last_seq - my_read_seq
```

The `WHERE read_seq < 42` guard is doing three jobs: it makes the update idempotent (a replayed receipt changes nothing), it makes it order-insensitive (a late "read 40" after "read 42" cannot move the pointer backwards), and it avoids writing a new row version when nothing changes. The receipt event is also written to the outbox so the sender's devices see blue ticks; those events are coalesced per `(conv, user)` in the fan-out worker, so a user reading 30 messages in quick succession produces one downstream update, not 30.

### Keyset pagination for history

```sql
-- Open chat: newest 50 visible to Bob (joined at seq 5).
SELECT seq, sender_id, kind, body, created_at
  FROM messages
 WHERE conv_id = 77 AND seq > 5
   AND (expires_at IS NULL OR expires_at > now())          -- expired = invisible even before deletion
 ORDER BY seq DESC
 LIMIT 50;

-- Scroll back: before the oldest seq on screen.
... WHERE conv_id = 77 AND seq < 1201 AND seq > 5 ORDER BY seq DESC LIMIT 50;
```

Both are index range scans on the primary key `(conv_id, seq)` that touch ~50 index entries regardless of how deep you scroll — never `OFFSET`.

### Tier B: message bodies in ScyllaDB / Cassandra

```sql
-- CQL
CREATE TABLE chat.messages_by_conv (
    conv_id        bigint,
    bucket         int,            -- seq / 10000: bounds a partition to 10k messages (~3 MB)
    seq            bigint,
    sender_id      bigint,
    sender_device  smallint,
    client_msg_id  uuid,
    kind           tinyint,
    body           blob,
    created_at     timestamp,
    PRIMARY KEY ((conv_id, bucket), seq)
) WITH CLUSTERING ORDER BY (seq DESC)
  AND compaction = {'class': 'LeveledCompactionStrategy'};

-- Disappearing messages: one table per timer so every row in a table has the same TTL
CREATE TABLE chat.ephemeral_messages_7d (
    conv_id bigint, bucket int, seq bigint, sender_id bigint, kind tinyint, body blob, created_at timestamp,
    PRIMARY KEY ((conv_id, bucket), seq)
) WITH CLUSTERING ORDER BY (seq DESC)
  AND default_time_to_live = 604800
  AND gc_grace_seconds = 86400
  AND compaction = {'class': 'TimeWindowCompactionStrategy',
                    'compaction_window_unit': 'HOURS', 'compaction_window_size': 6};
```

Why these choices:

- **Partition key `(conv_id, bucket)`**: a conversation's messages are colocated and read with one partition scan, but a years-old busy group cannot grow an unbounded partition ([Cassandra · Data Modeling Anti-patterns](../cassandra/topic.html?p=12-data-modeling-antipatterns)). Bucketing by **seq range** rather than by time means the reader computes the bucket from the seq it wants (`bucket = seq / 10000`) — no "which buckets exist?" lookup. Discord buckets by time window instead, which works too but requires walking empty buckets for quiet channels.
- **Clustering `seq DESC`**: "latest 50" is the first 50 cells of the partition.
- **Uniform TTL per table + TWCS**: when every row in an SSTable expires at about the same time, the whole SSTable is dropped without ever compacting through tombstones ([Cassandra · TTL, Counters & Static Columns](../cassandra/topic.html?p=15-ttl-counters-static-columns), [Cassandra · Tombstones & Deletes](../cassandra/topic.html?p=24-tombstones-deletes)). Mixing TTLs in one TWCS table defeats that.
- **Writes at `LOCAL_QUORUM`, reads at `LOCAL_QUORUM`** so the sender's next read sees their own message (R + W > RF).
- **No LWT, no counters**: sequencing is done in Postgres; Cassandra only stores immutable, idempotently written cells. Cassandra counters are not idempotent on retry, and LWT (Paxos) on every message would cost several round trips ([Cassandra · Batches & LWT](../cassandra/topic.html?p=14-batches-lightweight-transactions)).

### Application code: the Tier B send

The trickiest flow is the one that spans Postgres (sequencer) and Scylla (body): a dual write, made safe by idempotency rather than by a distributed transaction.

```go
// SendMessage allocates seq in Postgres (sequencer + dedup, one txn), then upserts the body into Scylla.
// A crash between the two is healed by the client retrying with the same clientMsgID.
func (s *Store) SendMessage(ctx context.Context, m Msg) (int64, error) {
	seq, dup, err := s.allocateSeq(ctx, m) // the SQL transaction above, against message_ids instead of messages
	if err != nil {
		return 0, err // 40001/40P01 are retried inside allocateSeq with jittered backoff
	}
	_ = dup // on a duplicate we still (re)write the body: it may be the crash window we are healing

	q := s.scylla.Query(`INSERT INTO chat.messages_by_conv
	        (conv_id, bucket, seq, sender_id, sender_device, client_msg_id, kind, body, created_at)
	        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		m.ConvID, int(seq/10000), seq, m.SenderID, m.Device, m.ClientMsgID, m.Kind, m.Body, m.SentAt).
		WithContext(ctx).Consistency(gocql.LocalQuorum).Idempotent(true)

	for attempt := 0; ; attempt++ {
		if err = q.Exec(); err == nil {
			return seq, nil // ack the client only now: the body is durable on a quorum
		}
		if attempt == 4 || ctx.Err() != nil {
			// Do NOT ack. The seq is allocated but the body is missing: the client will retry with the
			// same clientMsgID, hit the dedup row, get the same seq and rewrite the body.
			// If it never retries, the gap-filler job writes a "skipped" marker at this seq after 10 min.
			return 0, fmt.Errorf("body write failed for %d/%d: %w", m.ConvID, seq, err)
		}
		time.Sleep(backoff(attempt))
	}
}
```

The **gap filler** closes the loop: readers that see a hole at `seq` (next seq present, this one absent for more than a few minutes) ask the service, which checks `message_ids`; if the body was never written it inserts a `kind = skipped` marker with `IF NOT EXISTS`, so every device renders the same thing. Because the dedup row and seq are authoritative in Postgres, there is exactly one answer for every seq.

### Per-user sync log (user shard)

```sql
CREATE TABLE user_sync_state (
    user_id         bigint PRIMARY KEY,
    next_inbox_seq  bigint NOT NULL DEFAULT 1
);

CREATE TABLE user_inbox (
    user_id     bigint NOT NULL,
    inbox_seq   bigint NOT NULL,
    conv_id     bigint NOT NULL,
    conv_seq    bigint NOT NULL,
    kind        smallint NOT NULL,       -- 1 message, 2 receipt, 3 membership, 4 edit/delete
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, inbox_seq),
    UNIQUE (user_id, conv_id, conv_seq, kind)     -- fan-out consumer idempotency
) PARTITION BY HASH (user_id);                  -- PK and UNIQUE both contain the partition key

-- Fan-out consumer, one transaction per (user, batch of events):
WITH s AS (
  UPDATE user_sync_state SET next_inbox_seq = next_inbox_seq + 1
   WHERE user_id = 2002 RETURNING next_inbox_seq - 1 AS inbox_seq
)
INSERT INTO user_inbox (user_id, inbox_seq, conv_id, conv_seq, kind)
SELECT 2002, s.inbox_seq, 77, 42, 1 FROM s
ON CONFLICT (user_id, conv_id, conv_seq, kind) DO NOTHING;
```

On a partitioned table every unique constraint must contain the partition key, which is why this table is hash-partitioned by `user_id` rather than range-partitioned by `created_at`; aging out 30-day-old rows is a batched `DELETE ... WHERE created_at < now() - interval '30 days'` per partition (or, on the user shards' own cluster, a per-week table swap). The `UNIQUE (user_id, conv_id, conv_seq, kind)` is what makes a redelivered Kafka event a no-op instead of a second inbox entry.

A device offline for longer than the inbox retention (30 days) gets a **full resync**: its conversation list from `user_conversations` and the latest page of each conversation — the sync log is an optimisation, not the source of truth.

### Diagnostics

```sql
-- Hot conversations: who is waiting on the sequencer row lock right now?
SELECT a.pid, a.wait_event_type, a.wait_event, now() - a.xact_start AS xact_age, left(a.query, 80)
  FROM pg_stat_activity a
 WHERE a.wait_event_type = 'Lock' AND a.query LIKE 'UPDATE conversations%';

-- Are receipt updates staying HOT?
SELECT relname, n_tup_upd, n_tup_hot_upd,
       round(100.0 * n_tup_hot_upd / nullif(n_tup_upd, 0), 1) AS hot_pct, n_dead_tup
  FROM pg_stat_user_tables
 WHERE relname IN ('conversations', 'conversation_members');
```

```text
       relname        | n_tup_upd  | n_tup_hot_upd | hot_pct | n_dead_tup
----------------------+------------+---------------+---------+------------
 conversations        |  912004511 |     899120034 |    98.6 |     204113
 conversation_members | 1840022718 |    1811877512 |    98.5 |     391877
```

A HOT percentage falling below ~90% usually means someone added an index on a watermark column or fillfactor was reset by a table rewrite.

## 6. Advantages, Disadvantages & Trade-offs

| Decision | Chosen | Rejected alternative | Why |
|---|---|---|---|
| Ordering key | Per-conversation dense `seq` | Server timestamp / Snowflake id | Total order per conversation, gap detection, trivial keyset paging. Snowflake ids remain fine for global ids of *other* things. |
| Sequencer | Row lock on `conversations` in Postgres | Redis `INCR`; Cassandra LWT; a sequencer service | Transactional with dedup (rollback undoes the bump). Redis `INCR` can hand out a duplicate or regress after an async-replica failover; LWT costs 4 round trips per message. |
| Receipts | Two watermarks per member | Row per (message, recipient) | O(members) storage instead of O(messages × members); writes are coalescable and idempotent. |
| Message bodies at scale | Scylla/Cassandra wide partitions | Sharded Postgres everywhere | Write-heavy append + TTL expiry is an LSM strength; PG needs vacuum for every expired row. Postgres is the right answer until ~hundreds of millions of messages/day. |
| Partition bound | `bucket = seq / 10000` | Unbounded `conv_id` partition; time buckets | Bounded partition size; reader computes bucket directly. |
| Multi-device sync | Per-user inbox log + device cursor | Scan all conversations for `last_seq > local` | O(changes) instead of O(conversations) per sync. |
| Large groups | Pull (check `last_seq`) | Fan-out to every member | Fan-out cost is members × messages. |
| Idempotency | Client-generated `client_msg_id` + unique constraint | Server dedup by content hash + time window | Content hashes collide ("ok", "ok"); the client knows exactly which attempts are the same logical send. |
| Retention | TTL tables with TWCS, per timer | Nightly `DELETE` sweeper | Whole-file drops vs tombstone/bloat storms. |

### When to use this design

- Chat, comments-as-conversations, support tickets with threads, collaborative-doc activity logs, game lobbies — anything that is "many independent append-only logs, each read by a bounded set of participants, where participants must agree on order".
- When per-reader state is naturally a **prefix** ("read up to here"), watermarks beat per-item status rows every time.

### When NOT to use it

- **Broadcast channels with millions of subscribers** (Telegram channels, Twitter-like feeds): per-member watermark rows for 10 M subscribers are a table in their own right; use a feed/timeline design instead.
- **Strict global ordering across conversations** (e.g. an audit log that must be totally ordered system-wide): a per-conversation sequencer gives no cross-conversation order; you need a single log (Kafka partition) or a ledger design ([Ch 32 · Banking Ledger](topic.html?p=32-case-banking)).
- **Pure store-and-forward** (original WhatsApp): if the server deletes messages once every device has them, you do not need a year of history in Scylla — a per-recipient queue with delete-on-ack is simpler, and the durable log shrinks to the undelivered backlog.
- **Small products** (< tens of millions of messages/day): skip Scylla, Kafka and user shards entirely; one Postgres cluster with the Tier A schema and a polling outbox is the correct design ([Ch 21 · Database Scaling](topic.html?p=21-database-scaling) — do not jump the ladder).

## 7. Common Mistakes & Best Practices

- **Ordering by `created_at`.** People do it because it looks natural. It hurts because clock skew and ties reorder messages differently on different devices. Instead: server-assigned per-conversation `seq`; keep `created_at` for display only.
- **Using a Postgres `SEQUENCE` (or `bigserial`) as the per-conversation order.** Sequences are global and non-transactional: a rolled-back send burns a number, so clients see phantom gaps, and one sequence is shared by all conversations. Instead: the counter column on the conversation row, bumped inside the send transaction.
- **A status row per message per recipient.** Hurts as O(messages × members) rows and 2× that in updates. Instead: `delivered_seq` / `read_seq` watermarks; compute per-message detail on demand.
- **Generating the idempotency key on the server.** A server-side UUID created per request is different on every retry, so it deduplicates nothing. Instead: the device generates `client_msg_id` once, persists it with the pending message, and reuses it on every attempt, including after an app restart.
- **Checking for duplicates with `SELECT` then `INSERT`.** Two concurrent retries both see "not found". Instead: a unique constraint and `INSERT ... ON CONFLICT DO NOTHING`, and treat "0 rows" as "duplicate".
- **One unbounded partition per conversation in Cassandra.** A five-year-old 1,000-member group becomes a multi-GB partition: slow reads, compaction pain, repair pain. Instead: `(conv_id, bucket)`.
- **Deleting expired messages with `DELETE` in Cassandra / mixed TTLs in a TWCS table.** Tombstones pile up and reads scan through them (`TombstoneOverwhelmingException` at 100 K tombstones by default). Instead: uniform TTL per table, TWCS, and never read ranges full of deleted cells.
- **Fanning out full message bodies into per-user inboxes.** Storage multiplies by group size and edits/deletes must be applied N times. Instead: fan out **pointers** `(conv_id, seq)`; the body is stored once.
- **Making the per-user projection part of the send transaction.** A group send becomes a cross-shard transaction on up to 1,024 user shards. Instead: outbox → Kafka → idempotent fan-out, and accept seconds of lag on the per-user side.
- **Indexing watermark columns** "for the read-by query". Every receipt now writes index entries and loses HOT. Instead: no index; the query is bounded by conversation size.

## 8. Production: Failure Scenarios, Monitoring & Scaling

### Scaling path

Follow the ladder in [Ch 21 · Database Scaling](topic.html?p=21-database-scaling):

- **1× (10 M messages/day)** — one Postgres primary + one sync replica + async read replicas; Tier A schema; polling outbox; no Kafka needed (a `LISTEN/NOTIFY` or polling fan-out worker is fine). Hash-partition `messages` from day one — cheap now, painful later.
- **10× (100 M/day, ~3.5 K/s peak)** — PgBouncer in transaction mode in front of the primary ([Ch 20 · Database + Application](topic.html?p=20-database-application-architecture)); history reads go to replicas **except** the sender's own "open chat after send", which is routed to the primary or waits for the replica to reach its commit LSN (read-your-writes, [Ch 09 · Replication](topic.html?p=09-replication)); Kafka + Debezium for fan-out.
- **100× (1 B/day)** — shard the conversation side by `conv_id` (64–256 logical shards mapped to fewer physical clusters so you can split later) and the user side by `user_id`; move bodies to Scylla. The sequencer stays in Postgres because it is tiny: a few hundred bytes per conversation.
- **Beyond (20 B/day, this chapter's target)** — more Scylla nodes (it scales linearly with partitions), more conversation shards, regional deployments where each conversation has a **home region** that owns its sequencer ([Ch 17 · Multi-Region Databases](topic.html?p=17-multi-region-databases)); cross-region members pay one WAN round trip on send.

### Failure scenarios

- **At 20:00 on New Year's Eve, sends to one mega-group time out.** Symptom: p99 of `allocateSeq` for conv 5001 at 2 s, `wait_event = transactionid` on dozens of backends. Root cause: 1,024 members all sending "Happy New Year" within seconds; every send serialises on one row lock and each holds it for a sync-replica commit. Fix: short-term, rate-limit sends per conversation at the gateway (humans cannot read 200 messages/s anyway); structurally, batch sequencing — the service collects the sends arriving for a hot conversation within 5 ms and allocates a block of seqs with one `UPDATE ... SET last_seq = last_seq + $n`.
- **At 02:00 the Scylla cluster loses a rack; some sends fail after seq allocation.** Symptom: clients retrying, a spike of `dup=true` allocations, a few gaps visible. Root cause: body writes failing at `LOCAL_QUORUM` while Postgres commits. Fix: none needed if the design is right — retries re-drive the body writes; the gap filler marks seqs whose clients never came back. Alert on "gaps older than 10 minutes" rather than on the failures themselves.
- **Receipts go backwards.** Users report blue ticks turning grey. Root cause: a new receipt endpoint wrote `SET read_seq = $1` without the `read_seq < $1` guard, and out-of-order delivery from two devices regressed the pointer. Fix: restore the guard; add a `CHECK`-style test in CI that replays receipts shuffled.
- **The outbox relay's replication slot is abandoned after a Debezium redeploy.** Symptom: conversation-shard disk filling with WAL, `pg_replication_slots.active = false`. Fan-out has stopped, so nobody's linked devices sync. Fix: set `max_slot_wal_keep_size`, alert on slot lag in bytes, and treat the fan-out lag metric as a user-facing SLO.
- **A fan-out worker bug double-applies events.** Symptom: duplicate entries in user sync logs. Root cause: the consumer was idempotent by `inbox_seq`, which is assigned *by* the consumer (a new one each time). Fix: dedup on the business key `(user_id, conv_id, conv_seq, kind)`, never on an id the consumer mints.
- **Disappearing messages still visible after expiry.** Root cause: Tier A sweeper lagging behind by hours during a vacuum storm. Fix: expiry is enforced on read (`expires_at > now()` in every query), deletion is only housekeeping; move expiry-heavy conversations to the TTL tables.

### Monitoring

| Metric | Why | Alert when |
|---|---|---|
| `allocateSeq` p99 and lock waits per conversation | sequencer contention = hot conversation | p99 > 100 ms |
| Scylla write p99, pending compactions, partition size p99 | body path health; bucket sizing | partition p99 > 50 MB |
| Outbox lag (oldest unpublished age) / replication slot lag bytes | fan-out freshness; disk risk | > 30 s / > 20 GB |
| Fan-out consumer lag (Kafka) | multi-device sync freshness | > 60 s |
| HOT update % on `conversation_members` | receipt write amplification | < 90% |
| Seq gaps older than 10 min | dual-write healing | any sustained growth |
| Dedup hit rate | client retry storms | sudden 10× jump |

### Backups, DR and data lifecycle

- Conversation shards: base backups + WAL archiving per shard for PITR ([Ch 26 · Backup & DR](topic.html?p=26-backup-disaster-recovery)); the sequencer state is small, but it is the thing you cannot reconstruct from Scylla alone (it holds the dedup mapping and membership).
- Scylla: snapshots + incremental backups per node; RF=3 per region plus a second region for DR.
- User-shard projections do not need PITR: they are rebuilt by replaying the Kafka topic (keep ≥ 7 days of retention) or by rescanning conversation shards.
- Lifecycle ([Ch 28 · Data Lifecycle](topic.html?p=28-data-lifecycle)): `message_ids` pruned after 7 days; `user_inbox` partitions dropped after 30 days; message bodies older than the retention policy expire by TTL; account deletion = remove the user from memberships, tombstone their authored messages per policy, and delete their user-shard rows — log it for compliance.

## 9. Interview Questions

**Q: Why not order messages by timestamp?**
A: Because timestamps generated on different servers disagree by milliseconds or more, and two messages in the same millisecond tie. The result is that a reply can sort before its question, and two devices can render different orders. Timestamps also have gaps by design, so a client cannot tell whether it is missing a message. A per-conversation sequence number assigned when the message is committed gives a single total order that every device shares, is dense so gaps are detectable, and pages cleanly with `seq < X`. Timestamps remain useful for display.

**Q: How do you assign per-conversation sequence numbers, and how does that scale?**
A: The conversation row holds `last_seq`; the send transaction does `UPDATE conversations SET last_seq = last_seq + 1 ... RETURNING last_seq`, which takes a row lock that serialises senders to that conversation. Because the bump is inside the transaction, a rollback (for example a duplicate) undoes it, so there are no gaps. It scales across conversations perfectly, because each conversation is independent and lives on one shard. Within a conversation it is limited to a few hundred sends per second by commit latency, which is far above human rates; for pathological groups you batch allocations.

**Q: How do you store delivery and read receipts for a 1,000-member group?**
A: Not as a row per message per recipient — that is a thousand inserts and two thousand updates per message. Each member has two watermarks, `delivered_seq` and `read_seq`, because reading message 50 implies reading 1 to 49. Updating a receipt is a single-row monotonic update guarded by `WHERE read_seq < $new`, which makes it idempotent and order-insensitive. "Read by" for message S is the set of members with `read_seq >= S`, computed on demand over at most 1,024 rows, and unread count is `last_seq - read_seq`.

**Q: A client times out and retries a send. How do you guarantee there is no duplicate?**
A: The device generates a `client_msg_id` before the first attempt and reuses it on every retry. The server has a unique constraint on `(conv_id, client_msg_id)` and inserts with `ON CONFLICT DO NOTHING`; zero rows affected means duplicate, so it rolls back the sequence bump and returns the original seq from the existing row. Concurrent duplicate retries are safe because the unique index (and here the conversation row lock) serialises them. The dedup rows only need to live as long as a client can plausibly retry, a few days.

**Q: Why put message bodies in Cassandra or ScyllaDB rather than Postgres?**
A: The workload is write-dominated append at hundreds of thousands per second, read by key range of one conversation, and expired by time. That is what LSM-tree wide-column stores are built for: writes are sequential, partitions give colocated range reads, and TTL with time-window compaction drops whole files instead of vacuuming billions of dead tuples. Postgres can do it up to a few hundred million messages a day with hash partitioning, and I would start there. Past that the operational cost of sharding, vacuum and expiry in Postgres exceeds running a Scylla cluster.

**Q: How do you design the Cassandra partition key for messages?**
A: `((conv_id, bucket), seq)` with `seq` descending as the clustering column. `conv_id` colocates a conversation so the latest page is one partition read; the bucket bounds partition size so an old, busy group does not become a multi-gigabyte partition. I bucket by seq range, `seq / 10000`, so a reader computes the bucket directly from the seq it wants; Discord buckets by time window, which also works but needs empty-bucket walking for quiet channels. Clustering descending makes "latest 50" the first cells of the partition.

**Q: How does a linked laptop that was offline for three days catch up?**
A: Each user has an append-only sync log of pointers `(inbox_seq, conv_id, conv_seq, kind)` written by fan-out workers, and each device persists the last `inbox_seq` it processed. On wake it reads `inbox_seq > cursor` grouped by conversation, then fetches messages above its local per-conversation seq with keyset pagination. Large groups are not fanned out, so the device also checks `last_seq` for those. If the device was offline longer than the sync log's retention, it does a full resync from the conversation list — the log is an optimisation, the conversation logs are the truth.

**Q: How do you implement disappearing messages without killing the database?**
A: Compute `expires_at` at send time from the conversation's timer and enforce it on every read, so expiry is correct immediately. Physical deletion is housekeeping: in Cassandra or Scylla I put each timer value in its own table with a uniform `default_time_to_live` and time-window compaction, so whole SSTables expire together and are dropped without tombstone scans. In Postgres I would time-partition and drop partitions, or delete in small batches if volume is low. Mixing TTLs in one TWCS table or issuing explicit deletes is what creates tombstone and bloat problems.

**Q: The sequencer is in Postgres and the body in Scylla. What happens if the service crashes between the two writes? (Senior)**
A: Postgres has committed the dedup row and the seq, but the body is missing, and the client never got an ack. The client retries with the same `client_msg_id`; the dedup insert conflicts, the service fetches the existing seq and rewrites the body with an idempotent upsert — same key, same value — then acks. So the retry heals the crash window without a distributed transaction. If the client never retries, readers see a gap at that seq; after a timeout a gap-filler consults Postgres and writes a `skipped` marker with `IF NOT EXISTS` so all devices agree. The key idea is that Postgres is authoritative for "which seq exists" and the body write is idempotent, so it is safe to repeat.

**Q: One 1,024-member group is melting its shard on New Year's Eve. What do you do? (Senior)**
A: First confirm it is sequencer contention: backends waiting on the conversation row's transaction lock, each holding it for a synchronous-replica commit. Immediately, rate-limit sends per conversation at the gateway — nobody can read hundreds of messages per second. Structurally, batch sequencing: collect sends for a hot conversation over a few milliseconds and allocate a block with one `last_seq = last_seq + n`, turning n lock cycles into one. The fan-out side is already safe because large groups use pull rather than per-member inbox writes. I would also make sure the shard is not co-hosting other hot conversations, and move this conversation to a dedicated logical shard if it is persistently hot.

**Q: How would you go multi-region? (Senior)**
A: Each conversation gets a home region that owns its sequencer row and dedup index; that preserves single-writer ordering without cross-region consensus on every message. Members in other regions send to the home region, paying one WAN round trip on send, while reads of history can be served from local Scylla replicas replicated across data centres at `LOCAL_QUORUM`, accepting sub-second staleness. 1:1 chats are homed near the conversation creator, or migrated if both users move. On a regional failure, conversations homed there fail over to a standby region whose Postgres replica is promoted — with async replication that risks losing the last acknowledged sends, so for RPO = 0 you need synchronous replication to a nearby region and accept the latency.

**Q: Why not use Redis INCR as the sequencer? (Senior)**
A: It is fast, but it is not transactional with the dedup check and its persistence and replication are asynchronous by default. If the Redis primary fails over to a replica that had not received the last increments, the counter regresses and hands out duplicate seqs — two messages at the same position. A duplicate retry would also burn a seq, leaving a gap, because the increment happens before you know the message is a duplicate. You can fence it with epochs and reconcile, but at that point you have rebuilt a worse Postgres row lock. The sequencer's write rate per conversation is tiny, so there is no reason to trade correctness for speed here.

## 10. Quick Revision & Cheat Sheet

| Concern | Design |
|---|---|
| Unit of ordering and sharding | Conversation (`conv_id`) |
| Order | Dense per-conversation `seq`, assigned by `UPDATE conversations SET last_seq = last_seq + 1` in the send txn |
| Idempotency | Device-generated `client_msg_id`; `UNIQUE (conv_id, client_msg_id)`; `ON CONFLICT DO NOTHING` then return original seq |
| Receipts | `delivered_seq`, `read_seq` per member; `WHERE read_seq < $new`; not indexed (HOT) |
| History | Keyset: `WHERE conv_id = ? AND seq < ? ORDER BY seq DESC LIMIT 50` |
| Bodies at scale | Scylla `PRIMARY KEY ((conv_id, seq/10000), seq)`, clustering DESC, LOCAL_QUORUM |
| Disappearing messages | `expires_at` enforced on read; TTL table per timer + TWCS |
| Multi-device sync | Per-user pointer log `(user_id, inbox_seq)` + device cursor; full resync beyond retention |
| Large groups | Pull `last_seq`, no per-member fan-out |
| Cross-store consistency | PG authoritative for seq; idempotent body upsert; retry heals; gap filler |

- The conversation log is the source of truth; everything per-user is a rebuildable projection.
- Total order per conversation, no order across conversations — that is what users can see.
- Watermarks, not status rows: "read up to N" is a prefix.
- A sequence counter must be transactional with dedup, or duplicates burn numbers.
- Never fan out bodies; fan out `(conv_id, seq)` pointers.
- Bound every wide partition; uniform TTL per TWCS table.
- Start with one Postgres and the Tier A schema; each tier on the ladder is earned by numbers.

## 11. Hands-On Exercises

Lab: `docker run --name chat -e POSTGRES_PASSWORD=pw -p 5432:5432 -d postgres:17`, then `psql -h localhost -U postgres`.

1. **Sequencer under contention.** Create the Tier A schema. Use `pgbench -n -c 32 -T 30 -f send.sql` where `send.sql` runs the send transaction against a single conversation, then against 1,000 random conversations. Compare TPS and `pg_stat_activity` lock waits. Confirm with `SELECT count(*), max(seq) FROM messages WHERE conv_id = 1` that there are no gaps.
2. **Duplicate retries.** In two psql sessions, run the send transaction with the same `client_msg_id` concurrently (pause the first before COMMIT). Observe the second block, then return 0 rows from the insert. Verify `last_seq` was bumped exactly once.
3. **Watermark monotonicity.** Apply receipts `read 40`, `read 42`, `read 41` in that order with and without the `read_seq < $new` guard. Check `n_tup_upd` vs `n_tup_hot_upd` in `pg_stat_user_tables`; then add an index on `read_seq` and repeat to watch HOT percentage fall.
4. **Keyset vs OFFSET.** Load 5 M messages into one conversation; compare `EXPLAIN (ANALYZE, BUFFERS)` of `OFFSET 4000000 LIMIT 50` against `seq < X ORDER BY seq DESC LIMIT 50`.
5. **Expiry cost.** Insert 2 M messages with `expires_at` in the past; run a batched delete (10 K rows per statement) and watch `n_dead_tup` and WAL generated (`pg_stat_wal`). Then recreate with daily range partitions and `DROP TABLE` the expired partition; compare.
6. **Cassandra bucket sizing (optional).** In a single-node ScyllaDB container, create `messages_by_conv`, write 50 K messages to one conversation, and inspect partition sizes with `nodetool tablehistograms`; repeat with no bucket.

**Mini project — multi-device sync service.** Build a small Go or Python service with `POST /send` (sequencer + dedup), `POST /receipt` (watermark), and `GET /sync?cursor=` backed by the user sync log populated by an outbox-polling fan-out worker. Write a chaos test: kill the service between commit and ack, resend with the same `client_msg_id`, and assert every "device" (three simulated clients with independent cursors) ends up with the identical ordered list of messages and consistent unread counts.

## 12. Related Topics & Free Learning Resources

**Concept chapters this design applies**

- [Ch 03 · MVCC](topic.html?p=03-mvcc) — why per-message status rows and bulk deletes create bloat.
- [Ch 04 · Concurrency Control](topic.html?p=04-concurrency-control) — the counter-row pattern and atomic insert-if-absent.
- [Ch 05 · Locking Internals](topic.html?p=05-locking-internals) — the conversation row lock as the sequencer.
- [Ch 09 · Replication](topic.html?p=09-replication) — read-your-writes after a send.
- [Ch 10 · Consistency Models](topic.html?p=10-consistency-models) — per-conversation linearizability, eventual per-user projections.
- [Ch 11 · Partitioning](topic.html?p=11-partitioning) and [Ch 12 · Sharding](topic.html?p=12-sharding) — two shard keys for two access-pattern families.
- [Ch 13 · Distributed Transactions](topic.html?p=13-distributed-transactions) — why fan-out is async, not 2PC.
- [Ch 19 · Database Caching Architecture](topic.html?p=19-database-caching-architecture) — caching hot group tails.
- [Ch 21 · Database Scaling](topic.html?p=21-database-scaling) — the tier ladder above.
- [Ch 28 · Data Lifecycle](topic.html?p=28-data-lifecycle) — TTLs, partition drops, deletion.
- [Ch 29 · Advanced Database Patterns](topic.html?p=29-advanced-database-patterns) — outbox and CDC for fan-out.
- [Ch 30 · SQL vs NoSQL](topic.html?p=30-sql-vs-nosql) — the Postgres-plus-Scylla split.
- Sibling case studies: [Ch 35 · Instagram-like Storage](topic.html?p=35-case-social-media) (fan-out and feeds), [Ch 39 · Payment System](topic.html?p=39-case-payment-system) (idempotency keys in depth).

**SQL Handbook:** [Schema Design](../sql/topic.html?p=30-schema-design) · [Sorting & Pagination](../sql/topic.html?p=03-sorting-pagination) · [Partitioning](../sql/topic.html?p=23-partitioning) · [Locking & MVCC](../sql/topic.html?p=27-locking-mvcc)

**Other handbooks:** [System Design · Design WhatsApp](../system-design/topic.html?p=34-design-chat-whatsapp) · [Cassandra · Primary Key, Partition & Clustering](../cassandra/topic.html?p=06-primary-key-partition-clustering) · [Cassandra · Compaction Strategies](../cassandra/topic.html?p=23-compaction-strategies) · [Cassandra · Tombstones & Deletes](../cassandra/topic.html?p=24-tombstones-deletes) · [Kafka & RabbitMQ · Idempotency & Outbox](../messaging/topic.html?p=21-idempotency-outbox) · [Kafka & RabbitMQ · Ordering & Partition Keys](../messaging/topic.html?p=22-ordering-partitioning-keys)

**Free resources**

- **How Discord Stores Billions of Messages** — Discord Engineering · *Intermediate* · the `(channel_id, bucket)` Cassandra model and why they left MongoDB. <https://discord.com/blog/how-discord-stores-billions-of-messages>
- **How Discord Stores Trillions of Messages** — Discord Engineering · *Advanced* · the move to ScyllaDB, hot partitions and request coalescing. <https://discord.com/blog/how-discord-stores-trillions-of-messages>
- **PostgreSQL Documentation: Table Partitioning** — PostgreSQL · *Intermediate* · hash and range partitioning, unique-constraint rules. <https://www.postgresql.org/docs/current/ddl-partitioning.html>
- **PostgreSQL Documentation: INSERT ... ON CONFLICT** — PostgreSQL · *Beginner* · the atomic insert-if-absent behind dedup. <https://www.postgresql.org/docs/current/sql-insert.html>
- **Apache Cassandra Documentation** — Apache · *Intermediate* · data modeling, TTL and compaction strategies. <https://cassandra.apache.org/doc/latest/>
- **ScyllaDB Documentation** — ScyllaDB · *Intermediate* · data modeling and compaction on the store Discord migrated to. <https://docs.scylladb.com/>
- **Designing Data-Intensive Applications, ch. 5, 9 & 11** — Martin Kleppmann · *Advanced* · ordering guarantees, total order broadcast, derived data. <https://dataintensive.net/>

---

*Database Design Handbook — chapter 36.*
