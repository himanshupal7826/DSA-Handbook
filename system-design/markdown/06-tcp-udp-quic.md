# 06 · TCP, UDP & QUIC

> **In one line:** TCP gives you a reliable, ordered byte stream at the cost of latency and head-of-line blocking; UDP gives you raw, unreliable datagrams; QUIC rebuilds TCP's reliability on top of UDP — per-stream, faster to set up, and able to survive a change of IP.

---

## 1. Overview

Under every HTTP request sits a **transport protocol** deciding how bytes cross an unreliable network of routers that can drop, reorder, duplicate, or delay packets. The two classic choices are **TCP** and **UDP**, and the modern challenger is **QUIC**.

**TCP (Transmission Control Protocol)** turns the lossy IP network into a **reliable, ordered, byte stream**: it handshakes to establish a connection, numbers every byte, retransmits losses, reorders arrivals, and throttles itself to avoid congesting the network. This is why it carries the web, email, SSH, and databases — but reliability and ordering cost round-trips and introduce **head-of-line (HOL) blocking**.

**UDP (User Datagram Protocol)** is TCP's opposite: **fire-and-forget datagrams** with no handshake, no ordering, no retransmission, no congestion control. Just "send this packet and hope." That minimalism is a feature for real-time media, DNS, and gaming — where a late packet is worthless anyway, so waiting to retransmit it is pointless.

**QUIC** is the synthesis: a reliable, multiplexed, encrypted transport built *in user space on top of UDP*. It fixes TCP's biggest problems — merges the transport and TLS handshakes into 1 RTT (0-RTT on resume), gives each stream **independent** delivery so one lost packet doesn't stall the rest, and identifies connections by an ID so they survive a client's IP change. HTTP/3 runs on QUIC for exactly these reasons.

Example: a video call uses UDP (drop a frame, move on); a bank transfer uses TCP (every byte must arrive, in order); a modern website uses QUIC (many independent streams, fast setup, mobile-friendly).

## 2. Core Concepts

- **Reliability** — TCP guarantees every byte arrives (via ACKs + retransmission); UDP guarantees nothing; QUIC gives per-stream reliability.
- **Ordering** — TCP delivers bytes strictly in order; UDP delivers datagrams in any order (or not at all); QUIC orders *within* a stream but streams are independent.
- **Connection vs connectionless** — TCP and QUIC are connection-oriented (state, handshake); UDP is connectionless (no setup).
- **3-way handshake** — TCP's SYN → SYN-ACK → ACK establishes sequence numbers and the connection (1 RTT before data).
- **Flow control** — the *receiver* advertises a **window** so a fast sender doesn't overrun a slow receiver's buffer.
- **Congestion control** — the *sender* probes the *network's* capacity (slow start, congestion avoidance, e.g. Cubic/BBR), backing off on loss to avoid collapse.
- **Head-of-line (HOL) blocking** — in TCP, one lost segment stalls delivery of *everything* behind it because bytes must be handed up in order.
- **Datagram (UDP)** — a self-contained message with just src/dst ports and a checksum; no state, no guarantees.
- **QUIC streams** — many independent, ordered byte streams multiplexed over one connection, each with its own loss recovery.
- **Connection migration** — QUIC's connection ID lets a session survive a change in IP/port (Wi-Fi↔cellular) without re-handshaking.

## 3. Architecture

TCP and QUIC both provide reliable streams, but QUIC lives in user space over UDP and folds in encryption, while TCP lives in the kernel and is separate from TLS.

```svg
<svg viewBox="0 0 760 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <text x="140" y="30" text-anchor="middle" fill="#1e293b" font-size="14">TCP stack (h1/h2)</text>
  <rect x="60" y="45" width="160" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="140" y="67" text-anchor="middle" fill="#1e293b">HTTP</text>
  <rect x="60" y="84" width="160" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="140" y="106" text-anchor="middle" fill="#1e293b">TLS</text>
  <rect x="60" y="123" width="160" height="34" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="140" y="145" text-anchor="middle" fill="#1e293b">TCP (reliable, ordered)</text>
  <rect x="60" y="162" width="160" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="140" y="184" text-anchor="middle" fill="#1e293b">IP</text>
  <text x="140" y="216" text-anchor="middle" fill="#64748b" font-size="11">kernel; 1 lost segment</text>
  <text x="140" y="232" text-anchor="middle" fill="#64748b" font-size="11">stalls all streams (HOL)</text>

  <text x="470" y="30" text-anchor="middle" fill="#1e293b" font-size="14">QUIC stack (h3)</text>
  <rect x="390" y="45" width="160" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="470" y="67" text-anchor="middle" fill="#1e293b">HTTP/3</text>
  <rect x="390" y="84" width="160" height="73" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="470" y="112" text-anchor="middle" fill="#1e293b">QUIC</text>
  <text x="470" y="130" text-anchor="middle" fill="#64748b" font-size="11">streams + TLS 1.3 +</text>
  <text x="470" y="146" text-anchor="middle" fill="#64748b" font-size="11">loss recovery (user space)</text>
  <rect x="390" y="162" width="160" height="34" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="470" y="184" text-anchor="middle" fill="#1e293b">UDP</text>
  <text x="470" y="216" text-anchor="middle" fill="#64748b" font-size="11">per-stream recovery →</text>
  <text x="470" y="232" text-anchor="middle" fill="#64748b" font-size="11">no cross-stream HOL block</text>

  <line x1="600" y1="100" x2="690" y2="100" stroke="#475569" stroke-width="1.5"/>
  <text x="645" y="92" text-anchor="middle" fill="#64748b" font-size="11">1 handshake</text>
  <text x="645" y="120" text-anchor="middle" fill="#059669" font-size="11">(transport+TLS</text>
  <text x="645" y="136" text-anchor="middle" fill="#059669" font-size="11">= 1 RTT)</text>
</svg>
```

## 4. How It Works

**TCP connection setup and reliable transfer:**

1. **3-way handshake.** Client sends `SYN` (seq=x) → server replies `SYN-ACK` (seq=y, ack=x+1) → client sends `ACK` (ack=y+1). Both sides now agree on starting sequence numbers. Cost: **1 RTT** before any data.
2. **Slow start.** The sender starts with a small congestion window (typically 10 segments) and doubles it each RTT, probing for capacity.
3. **Reliable, ordered transfer.** Every byte is sequenced; the receiver ACKs cumulatively. Lost segments are detected (duplicate ACKs / timeout) and **retransmitted**. Out-of-order arrivals are buffered until the gap fills — *this is where HOL blocking happens*.
4. **Flow control.** The receiver advertises a window (free buffer space); the sender never sends more unACKed data than the window allows.
5. **Congestion control.** On loss the sender shrinks its window (multiplicative decrease) then grows again — Reno/Cubic react to loss, BBR models bandwidth×RTT instead.
6. **Teardown.** `FIN`/`ACK` in both directions (or `RST` for an abrupt close).

**QUIC setup (contrast):** a single handshake carries both the transport parameters *and* the TLS 1.3 keys, so an encrypted, ready-to-send connection is up in **1 RTT** — or **0 RTT** on resumption. Streams then flow independently; a packet lost on stream 3 only delays stream 3.

```text
TCP:  SYN → ... SYN-ACK ... → ACK          (1 RTT)  then TLS (1 RTT)  → data   ≈ 2 RTT
QUIC: Initial(+TLS ClientHello) → ... resp ... → data                          ≈ 1 RTT
QUIC resumed: send data in first flight (0-RTT)                                 ≈ 0 RTT
```

## 5. Key Components / Deep Dive

### Reliability & ordering (TCP)
TCP numbers every byte, ACKs receipt, and retransmits on loss (fast retransmit on 3 dup-ACKs, or on RTO timeout). It buffers out-of-order segments and delivers a contiguous, in-order stream to the app. Guarantee: **exactly the bytes sent, in the order sent** — but a single gap holds back everything after it until filled.

### Flow control vs congestion control
These are constantly confused. **Flow control** protects the *receiver* (don't overflow its buffer) via the advertised window. **Congestion control** protects the *network* (don't overflow shared links/routers) via the congestion window. Both limit in-flight data; the sender uses `min(rwnd, cwnd)`. Algorithms: **Cubic** (loss-based, default on Linux), **BBR** (models bottleneck bandwidth & RTT — better on high-bandwidth/lossy links).

### Head-of-line blocking — the core motivation for QUIC
Because TCP delivers bytes in order, a lost segment blocks delivery of *all* subsequent bytes — even bytes belonging to unrelated HTTP/2 streams sharing that connection. On a link with 2% loss this can wreck tail latency. **QUIC** eliminates this: each stream has independent sequence space and loss recovery, so loss on one stream never stalls another. This is the single biggest reason HTTP/3 exists.

### UDP: when *less* is more
UDP adds almost nothing to IP — just ports and a checksum. No handshake, no state, no retransmit, no ordering, no congestion control. That's ideal when:
- **Latency > reliability**: VoIP/video (a retransmitted late frame is useless), online games.
- **Tiny request/response**: DNS (one packet each way beats a handshake).
- **You want to build your own transport**: QUIC, WireGuard, and QUIC-based protocols use UDP as a thin substrate. The app takes on any reliability it needs (FEC, selective retransmit).

The catch: no congestion control means UDP apps must implement their own or risk congesting the network; some networks rate-limit or block UDP.

### QUIC's headline features
- **1-RTT / 0-RTT handshake** (transport + TLS merged) — faster connection setup.
- **Independent streams** — no cross-stream HOL blocking.
- **Connection migration** — a **connection ID** (not the 4-tuple) identifies the session, so it survives NAT rebinds and Wi-Fi↔cellular switches without re-handshaking.
- **Always encrypted** — TLS 1.3 is baked in; even most transport headers are protected, so middleboxes can't ossify it.
- **User-space, pluggable congestion control** — evolves without kernel/OS upgrades.

## 6. Trade-offs

| Option | Pros | Cons |
|---|---|---|
| **TCP** | Reliable, ordered, ubiquitous, mature congestion control | 1-RTT setup (+TLS), HOL blocking, kernel-bound, tied to 4-tuple |
| **UDP** | Zero setup, lowest latency, flexible, tiny overhead | No reliability/ordering/congestion control — app must add it; sometimes blocked |
| **QUIC** | 1-/0-RTT setup, per-stream (no HOL block), conn migration, encrypted | Higher CPU, less mature tooling, UDP sometimes throttled/blocked |

TCP remains right for bulk, in-order, reliable transfer where a fresh handshake per connection is fine (databases, internal RPC, SSH). UDP is right when a late packet is worthless. QUIC is right for user-facing web/mobile where setup latency and HOL blocking hurt — hence HTTP/3.

## 7. When to Use / When to Avoid

**Use TCP when:** you need guaranteed, ordered delivery of a byte stream and can tolerate handshake latency — databases, file transfer, message queues, SSH, most internal service RPC.

**Use UDP when:** timeliness beats completeness (real-time voice/video, gaming), tiny stateless request/response (DNS), multicast/broadcast, or you're building a custom transport atop it.

**Use QUIC/HTTP/3 when:** serving latency-sensitive web/API traffic to browsers and mobile clients, especially over lossy/high-RTT networks or where clients roam between networks.

**Avoid:**
- **UDP** where you actually need reliability but haven't built it — you'll silently lose data.
- **QUIC** where middleboxes block UDP/443 or CPU is scarce — keep a TCP (h2) fallback.
- **TCP** for hard real-time media — retransmits add jitter that hurts more than the loss.

## 8. Scaling & Production Best Practices

- **Reuse connections** (keep-alive / pooling) so the handshake cost amortizes across many requests.
- **Tune congestion control**: consider **BBR** over Cubic for high-bandwidth-delay-product or lossy paths (measurable throughput gains at scale).
- **Right-size buffers & windows**: enable window scaling for high-BDP links; avoid bufferbloat.
- **Enable HTTP/3/QUIC at the edge with h2 fallback**; advertise via `Alt-Svc`.
- **For UDP services**, implement congestion/flow control yourself or ride QUIC — don't be a bad network citizen.
- **Watch SYN/handshake load**: SYN floods and connection churn are expensive; use SYN cookies and connection limits.
- **Set sane timeouts** (connect, idle, retransmit) so dead connections free resources.
- **Budget CPU for QUIC** — user-space crypto/packet processing costs more per byte than kernel TCP; offload where possible.

## 9. Failure Modes & Mitigations

| Failure | Impact | Mitigation |
|---|---|---|
| Packet loss on TCP link | HOL blocking → tail-latency spikes | Move to QUIC/HTTP/3; tune retransmit; BBR |
| SYN flood (DoS) | Connection table exhaustion | SYN cookies, rate limits, edge DDoS protection |
| Bufferbloat | High latency under load | AQM (CoDel/FQ), right-size buffers, BBR |
| UDP blocked/throttled by network | QUIC fails or degrades | Automatic fallback to TCP/h2 |
| No congestion control in a UDP app | Network congestion / unfairness | Use QUIC or implement CC (or FEC) |
| Connection stuck on IP change (TCP) | Dropped session on Wi-Fi↔LTE | QUIC connection migration |
| Retransmit storm on lossy link | Throughput collapse | Congestion control backoff; pacing |

## 10. Monitoring & Metrics

- **RTT** (smoothed) and **RTT variance/jitter** per path.
- **Retransmission rate / packet loss %** — the key TCP health signal.
- **Congestion window & throughput** vs link capacity.
- **Connection setup time** (handshake RTTs) and **new-connection rate** / reuse ratio.
- **SYN backlog / half-open connections** (SYN-flood detection).
- **QUIC:** 0-RTT usage & rejection, connection-migration events, UDP-vs-TCP fallback rate.
- **Timeouts** (connect/idle/RTO) and **RST rate**.
- **Buffer occupancy / queue latency** (bufferbloat).

## 11. Common Mistakes

1. ⚠️ **Using UDP and expecting reliability** — no ACKs or retransmits means silent data loss unless *you* add them.
2. ⚠️ **Confusing flow control with congestion control** — one protects the receiver's buffer, the other protects the network.
3. ⚠️ **Assuming HTTP/2 removed HOL blocking** — it removed it at the app layer; TCP still blocks all streams on one lost packet. Only QUIC fixes it.
4. ⚠️ **Opening a new TCP+TLS connection per request** — paying ~2 RTT of setup every time instead of reusing.
5. ⚠️ **Ignoring bufferbloat** — oversized buffers hide loss but balloon latency under load.
6. ⚠️ **Rolling out QUIC without a TCP fallback** — some networks block/throttle UDP and you'll strand those users.
7. ⚠️ **Enabling QUIC 0-RTT for non-idempotent requests** — replayable, just like TLS 1.3 0-RTT.
8. ⚠️ **Not budgeting CPU for QUIC** — user-space crypto is costlier per byte than kernel TCP; it can surprise you at scale.

## 12. Interview Questions

1. **Q: TCP vs UDP — when do you pick each?**
   A: TCP for reliable, ordered byte streams where completeness matters and handshake latency is acceptable (web, DB, SSH). UDP when timeliness beats reliability and a late packet is worthless (real-time voice/video, gaming) or for tiny stateless exchanges (DNS). TCP guarantees delivery/order; UDP guarantees nothing but adds almost no overhead.

2. **Q: Walk me through the TCP 3-way handshake and why it exists.**
   A: SYN (client picks seq x) → SYN-ACK (server picks seq y, acks x+1) → ACK (acks y+1). It synchronizes initial sequence numbers in both directions and confirms bidirectional reachability before data flows — costing 1 RTT of setup.

3. **Q: Flow control vs congestion control?**
   A: Flow control protects the *receiver* from being overrun, via the receiver-advertised window. Congestion control protects the *network* from overload, via the sender's congestion window (slow start, congestion avoidance). The sender is limited by the minimum of the two.

4. **Q: What is head-of-line blocking in TCP and why does it matter for HTTP/2?**
   A: TCP delivers bytes strictly in order, so one lost segment holds back every byte after it. HTTP/2 multiplexes many streams over one TCP connection, so a single lost packet stalls *all* of them — the streams are independent at the app layer but not at the transport. This is what QUIC set out to fix.

5. **Q: What is QUIC and what does it improve over TCP?**
   A: A reliable, multiplexed, encrypted transport built on UDP in user space. It merges transport+TLS into a 1-RTT (0-RTT resume) handshake, gives each stream independent loss recovery (no cross-stream HOL blocking), supports connection migration via a connection ID, and is always encrypted. HTTP/3 runs on it.

6. **Q [Senior]: Why is QUIC built on UDP rather than as a new protocol directly on IP?**
   A: Deployability. A brand-new IP protocol would be blocked by firewalls, NATs, and middleboxes that only understand TCP/UDP. UDP is universally passed and lets QUIC live in user space (fast iteration, no kernel/OS upgrades). Encrypting the transport headers also prevents middlebox ossification that froze TCP's evolution.

7. **Q [Senior]: A mobile user's large upload keeps failing when they walk out of Wi-Fi range. Explain the mechanism and the fix.**
   A: A TCP connection is bound to the 4-tuple (src/dst IP+port); when the device switches from Wi-Fi to cellular its IP changes and the connection breaks, forcing a restart. QUIC identifies the connection by a connection ID independent of the 4-tuple, so it *migrates* the live session to the new path without a new handshake — the upload continues.

8. **Q [Senior]: Compare loss-based (Cubic) and model-based (BBR) congestion control. When does BBR win?**
   A: Cubic treats packet loss as the congestion signal and backs off on loss — but on links with random (non-congestion) loss or deep buffers it underutilizes bandwidth or causes bufferbloat. BBR estimates the bottleneck bandwidth and min-RTT and paces to that operating point, ignoring incidental loss. BBR wins on high-bandwidth-delay-product, lossy, or bufferbloated paths (e.g. transcontinental, mobile).

9. **Q [Staff]: You run a real-time system and are choosing between TCP, UDP, and QUIC. Walk your decision.**
   A: If drops are tolerable and latency is king (live audio/video, game state), UDP with app-level FEC/selective retransmit — TCP's in-order retransmits add jitter worse than the loss. If you want reliability *and* low setup latency *and* per-stream isolation for browser/mobile clients, QUIC. TCP only if you need a plain reliable stream and the ecosystem/tooling matters more than tail latency. Key axes: loss tolerance, ordering needs, setup-latency sensitivity, and mobility.

10. **Q [Staff]: What are the operational downsides of moving your fleet to HTTP/3/QUIC?**
    A: Higher CPU per byte (user-space crypto and packet handling vs kernel TCP with offloads), immature observability/tooling compared to TCP, UDP being throttled or blocked on some networks (needs h2/TCP fallback and fallback monitoring), amplification/DoS considerations for the UDP handshake, and 0-RTT replay risk. You roll it out behind a fallback and watch fallback rate, CPU, and tail-latency deltas.

## 13. Alternatives & Related

- **HTTP, HTTPS & TLS** — HTTP/3 is the reason QUIC was built; TLS 1.3 is embedded in QUIC.
- **DNS** — a canonical UDP use case (single-packet request/response, TCP fallback for large answers).
- **Load Balancing** — L4 LBs balance TCP/UDP flows by 4-tuple; QUIC's connection ID changes how you hash flows.
- **WebRTC / RTP** — media transports built on UDP for the same latency reasons.
- **gRPC** — rides HTTP/2 (TCP) today, and increasingly HTTP/3.

## 14. Cheat Sheet

> [!TIP]
> **Transports in one screen:**
> - **TCP** = reliable, ordered byte stream. 3-way handshake (SYN/SYN-ACK/ACK), sequence+ACK+retransmit, **flow control** (receiver window) + **congestion control** (Cubic/BBR). Weakness: 1-RTT setup + **HOL blocking** (one lost segment stalls everything).
> - **UDP** = fire-and-forget datagrams. No handshake/ordering/reliability/congestion control. Great for real-time media, DNS, custom transports — you add any reliability yourself.
> - **QUIC** = reliable streams on UDP in user space: **1-RTT / 0-RTT** handshake (transport+TLS merged), **independent streams** (no cross-stream HOL block), **connection migration** (survives IP change), always encrypted. Powers **HTTP/3**.
> - **Flow control ≠ congestion control**: receiver's buffer vs the network's capacity.
> - **HTTP/2 fixed app-layer HOL blocking; only QUIC fixes transport-layer HOL blocking.**
> - Pick by: loss tolerance, ordering, setup latency, mobility. Keep a TCP/h2 fallback for QUIC.

**References:** "High Performance Browser Networking" (Ilya Grigorik, ch. TCP/UDP/QUIC); RFC 9000 (QUIC); RFC 9002 (QUIC loss recovery); Cloudflare Learning Center — QUIC & HTTP/3; "TCP/IP Illustrated" (Stevens).

---
*System Design Handbook — topic 06.*
