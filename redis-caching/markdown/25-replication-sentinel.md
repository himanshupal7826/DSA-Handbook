# 25 · Replication & Redis Sentinel for High Availability

> **In one line:** Redis replication is *asynchronous*, so the moment you rely on it for high availability you have quietly accepted a data-loss window — a failover can drop writes the old primary acknowledged but had not yet shipped to a replica — and Sentinel's whole job is to make that failover automatic and *quorum-safe*, not to make it lossless.

---

## 1. Overview

A single Redis instance is a single point of failure. If the process crashes, the machine dies, or the network partitions it away, every client that depends on it stalls. For a pure cache that might be survivable — a cold cache is slow, not wrong — but for a cache fronting an expensive origin, losing the whole cache at once is an availability incident in its own right (a thundering herd onto the database, chapter 12). High availability is the property that the *service* survives the loss of any one node, and in Redis it is built from two pieces: **replication** copies the dataset to one or more replicas, and **Sentinel** watches the topology and promotes a replica to primary automatically when the primary fails.

The single most important fact about Redis replication is that it is **asynchronous**. The primary acknowledges a write to the client the instant it applies it in memory; it does *not* wait for any replica to confirm receipt. Replication happens continuously in the background, a stream of commands flowing from primary to replicas, but at any instant the replicas lag the primary by some small amount. That lag is usually sub-millisecond and invisible. It becomes visible, and expensive, at exactly the worst moment: when the primary fails. Any writes the primary acknowledged but had not yet streamed to the replica that gets promoted are **lost**. This is not a bug; it is the deliberate trade — Redis chooses low write latency over synchronous durability, and hands you `WAIT` and `min-replicas-to-write` as the levers to buy back stronger guarantees when you need them.

This chapter covers how replication actually works on the wire (`REPLICAOF`, the replication backlog, full versus partial resync), how you can read from replicas to scale reads and what staleness that introduces, how Sentinel detects failure by quorum and orchestrates failover, how clients discover the current primary through Sentinel (the go-redis `FailoverClient`), and — the part most people skip until it bites them — the precise shape of the data-loss window and how `WAIT`, `min-replicas-to-write`, and a proper 3-Sentinel topology bound it.

## 2. Core Concepts

- **Primary (master)** — the writable instance; the single authority for the dataset. All writes go here.
- **Replica (slave)** — a read-only copy that receives a live stream of the primary's writes. Configured with `REPLICAOF <host> <port>`.
- **Asynchronous replication** — the primary does not wait for replicas before acknowledging a write; replicas trail the primary by the *replication lag*.
- **Replication lag** — how far behind the primary a replica is, in bytes of the replication stream or in time; the staleness you read when you read from a replica.
- **Full resync** — a fresh replica (or one that has fallen too far behind) receives a complete RDB snapshot of the dataset, then the live command stream.
- **Partial resync (PSYNC)** — a briefly-disconnected replica catches up from the **replication backlog** without a full snapshot, identified by a **replication ID** and offset.
- **Replication backlog** — a fixed-size in-memory ring buffer on the primary holding the most recent replication stream, enabling partial resync after a short disconnect.
- **Sentinel** — a separate process that monitors primaries and replicas, detects failure by quorum, elects a leader, and performs automatic failover.
- **Quorum** — the minimum number of Sentinels that must agree the primary is down before a failover can begin; the defence against split-brain.
- **Failover** — promoting a replica to primary and reconfiguring the other replicas and clients to follow it.
- **Split-brain** — two nodes both believing they are primary, accepting divergent writes; the failure mode quorum and `min-replicas` exist to prevent.
- **`WAIT numreplicas timeout`** — a command that blocks until N replicas have acknowledged all writes so far, converting async replication into bounded-synchronous on demand.

## 3. Theory & Principles

### Leader–replica asynchronous replication

Redis replication is a single-leader design: one primary accepts writes, and its dataset is copied to N replicas. A replica is told who to follow with `REPLICAOF <primary-host> <primary-port>` (older Redis called this `SLAVEOF`). When a replica first connects, it performs a **full synchronisation**: the primary forks a child that produces an RDB snapshot of the current dataset, streams that snapshot to the replica, and — crucially — buffers every write command that arrives *during* the snapshot so it can replay them afterwards. Once the replica has loaded the snapshot, the primary switches it to a live feed: every write command the primary applies is also written to the **replication stream** and sent to each replica, which applies it in the same order. Replicas are read-only by default (`replica-read-only yes`), which is what makes them safe to read from.

The asynchrony is the whole story. The write path on the primary is: apply in memory → reply to client → *(separately, in the background)* propagate to replicas. The reply does not wait for propagation. This is why Redis writes are fast even with replicas attached, and it is why replicas lag. Under steady state the lag is tiny; under a write burst, a slow replica link, or a replica busy loading an RDB, it grows. You can observe it: `INFO replication` on the primary lists each replica with its acknowledged offset, and the difference between the primary's `master_repl_offset` and a replica's offset *is* the lag in bytes.

### Full resync, partial resync, and the backlog

Reconnecting replicas must not always pay for a full snapshot — that would make every transient network blip a heavyweight, fork-inducing, bandwidth-hungry event. Redis avoids this with **partial resynchronisation** (`PSYNC`). The primary keeps a **replication backlog**: a fixed-size ring buffer (default 1 MB, `repl-backlog-size`) holding the most recent bytes of the replication stream, tagged with a **replication ID** and a running byte **offset**. When a replica reconnects, it presents the replication ID and the offset it last saw. If that offset is still within the backlog, the primary replays only the missing bytes — a cheap partial resync. If the replica has been gone too long and its offset has already been overwritten in the ring, or the replication ID no longer matches (e.g. after a failover created a new history), the primary falls back to a **full resync**.

The design consequence is that `repl-backlog-size` should be large enough to cover your realistic disconnect windows at your write throughput. A replica that reboots or a network that flaps for thirty seconds should catch up via partial resync; sizing the backlog for `write_bytes_per_sec × expected_disconnect_seconds` is the rule. Undersize it and every blip triggers a full resync — a fork on the primary, an RDB transfer, and a latency spike — turning a minor hiccup into an operational event.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="r1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="r2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Async replication &amp; the data-loss window on failover</text>

  <rect x="24" y="40" width="832" height="150" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="440" y="62" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">Normal operation: primary acks BEFORE replicas confirm</text>

  <rect x="48" y="80" width="120" height="40" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="108" y="104" text-anchor="middle" fill="#1e40af" font-size="10" font-weight="bold">client</text>
  <path d="M168,92 L232,92" stroke="#2563eb" stroke-width="1.5" marker-end="url(#r1)"/>
  <text x="200" y="84" text-anchor="middle" fill="#1e40af" font-size="8">SET x=5</text>
  <path d="M232,110 L168,110" stroke="#16a34a" stroke-width="1.5" marker-end="url(#r1)"/>
  <text x="200" y="124" text-anchor="middle" fill="#15803d" font-size="8">OK (immediately)</text>

  <rect x="236" y="72" width="150" height="56" rx="8" fill="#bfdbfe" stroke="#2563eb" stroke-width="2"/>
  <text x="311" y="94" text-anchor="middle" fill="#1e3a8a" font-size="11" font-weight="bold">PRIMARY</text>
  <text x="311" y="112" text-anchor="middle" fill="#1e40af" font-size="8">apply &#8594; ack &#8594; stream</text>

  <path d="M386,90 L470,90" stroke="#2563eb" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#r1)"/>
  <text x="428" y="82" text-anchor="middle" fill="#64748b" font-size="8">async, lagging</text>
  <path d="M386,110 L470,110" stroke="#2563eb" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#r1)"/>

  <rect x="474" y="72" width="150" height="26" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="549" y="90" text-anchor="middle" fill="#1e40af" font-size="9">REPLICA 1 (read-only)</text>
  <rect x="474" y="102" width="150" height="26" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="549" y="120" text-anchor="middle" fill="#1e40af" font-size="9">REPLICA 2 (read-only)</text>

  <text x="648" y="90" fill="#1e40af" font-size="9">replicas trail by</text>
  <text x="648" y="104" fill="#1e40af" font-size="9">the replication LAG</text>
  <text x="648" y="120" fill="#64748b" font-size="8">(offset difference)</text>

  <text x="48" y="150" fill="#1e40af" font-size="9" font-weight="bold">Backlog (ring buffer): last N bytes of the stream, tagged replication-ID + offset &#8594; enables PARTIAL resync on reconnect.</text>
  <text x="48" y="168" fill="#64748b" font-size="9">Fresh/too-far-behind replica &#8594; FULL resync (fork + RDB snapshot + live stream). Undersized backlog &#8594; every blip is a full resync.</text>

  <rect x="24" y="204" width="832" height="248" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="440" y="226" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Failover: the acknowledged-but-unreplicated writes are LOST</text>

  <rect x="48" y="244" width="150" height="56" rx="8" fill="#fecaca" stroke="#dc2626" stroke-width="2"/>
  <text x="123" y="266" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">OLD PRIMARY</text>
  <text x="123" y="284" text-anchor="middle" fill="#991b1b" font-size="8">crashes at offset 1000</text>

  <rect x="48" y="316" width="360" height="120" rx="6" fill="#fff" stroke="#fca5a5"/>
  <text x="228" y="336" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">Timeline of the window</text>
  <text x="62" y="356" fill="#991b1b" font-size="9">offset 990: SET a=1 &#8594; acked to client AND replicated &#10003;</text>
  <text x="62" y="374" fill="#991b1b" font-size="9">offset 1000: SET b=2 &#8594; acked to client, NOT yet replicated</text>
  <text x="62" y="392" fill="#b91c1c" font-size="9" font-weight="bold">&#8594; primary dies. Replica is at offset 990.</text>
  <text x="62" y="412" fill="#b91c1c" font-size="9" font-weight="bold">&#8594; b=2 is GONE, though the client saw OK.</text>
  <text x="62" y="428" fill="#64748b" font-size="8">Client believes b=2 committed; the new primary never had it.</text>

  <path d="M414,376 L470,376" stroke="#dc2626" stroke-width="1.5" marker-end="url(#r2)"/>
  <rect x="474" y="316" width="360" height="120" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="654" y="336" text-anchor="middle" fill="#92400e" font-size="10" font-weight="bold">How to bound the window</text>
  <text x="488" y="356" fill="#713f12" font-size="9">WAIT 1 500 &#8594; block until 1 replica confirms this write</text>
  <text x="488" y="374" fill="#713f12" font-size="9">min-replicas-to-write 1 &#8594; refuse writes if no replica is</text>
  <text x="488" y="388" fill="#713f12" font-size="9">    caught up (fail closed instead of losing data silently)</text>
  <text x="488" y="408" fill="#713f12" font-size="9">Quorum of 3 Sentinels &#8594; no split-brain double-primary</text>
  <text x="488" y="426" fill="#64748b" font-size="8">You cannot make it zero without giving up async's low latency.</text>
</svg>
```

### Reading from replicas: read scaling and the staleness it introduces

Because replicas hold a copy of the data and are read-only, you can send read traffic to them and keep the primary for writes. This scales *reads* horizontally: three replicas roughly triple read throughput. But you are reading a lagging copy, so you get **eventual consistency**, not read-your-writes. A client that writes `SET profile:9 …` to the primary and immediately reads `profile:9` from a replica may see the *old* value, because the write has not yet propagated. For a cache this is often fine — a slightly stale cached value is the normal state of a cache — but it is a correctness hazard for read-after-write flows (a user updates their profile and immediately reloads it). The mitigations are to route reads that must be fresh to the primary, to use `WAIT` after the write, or to pin a session to read-your-writes semantics. The key discipline is to *decide consciously* which reads tolerate staleness rather than sprinkling replica reads everywhere and discovering the lag in a bug report.

### Quorum and why failover must be a vote

The naive failover — "if I can't reach the primary, promote a replica" — is catastrophic, because a network partition can make a healthy primary *look* dead to one observer while it happily serves another. Promote a replica on that mistaken signal and you now have two primaries: **split-brain**. Redis Sentinel prevents this by making failure detection and failover a **quorum** decision. Multiple Sentinels each monitor the primary; a single Sentinel marking it unreachable is only a *subjectively down* (SDOWN) opinion. Only when at least `quorum` Sentinels agree does the primary become *objectively down* (ODOWN), and only then can failover start. Furthermore, the Sentinels elect a *leader* (via a Raft-like vote requiring a majority of the total Sentinel set) to actually run the failover, so two Sentinels cannot promote two different replicas concurrently. This is why the recommended topology is **at least three Sentinels on three independent failure domains** — with three, a single Sentinel or host failure still leaves a majority able to agree.

## 4. Architecture & Workflow

The full HA topology has two planes: the **data plane** (primary + replicas replicating asynchronously) and the **control plane** (Sentinels monitoring and orchestrating). They are deliberately separate — Sentinels are not in the data path, they observe and reconfigure.

The failover sequence when a primary dies:

1. **Detection (SDOWN).** Each Sentinel pings the primary every second. If the primary fails to respond within `down-after-milliseconds`, that Sentinel marks it *subjectively down* — its own opinion.
2. **Agreement (ODOWN).** The Sentinel asks the others whether they also see the primary as down. When at least `quorum` Sentinels agree, the primary is *objectively down* and failover is authorised.
3. **Leader election.** The Sentinels vote to elect one leader to run this failover, requiring a majority of the full Sentinel set (not just the quorum). This serialises the failover so only one promotion happens.
4. **Replica selection.** The leader picks the best replica to promote — one that is reachable, has the lowest lag (highest replication offset), the best `replica-priority`, and the largest dataset. A replica with `replica-priority 0` is never promoted.
5. **Promotion.** The chosen replica is sent `REPLICAOF NO ONE`, making it the new primary. The other replicas are reconfigured with `REPLICAOF <new-primary>` to follow it.
6. **Client redirection.** Sentinels publish the new topology. Clients that query Sentinel for "who is the primary?" now get the new address and reconnect. The go-redis `FailoverClient` does this automatically.
7. **Old primary demotion.** When the old primary returns, Sentinel reconfigures it as a *replica* of the new primary, so it stops accepting writes and rejoins as a follower — its unreplicated writes are discarded.

```svg
<svg viewBox="0 0 880 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="s1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
    <marker id="s2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Sentinel topology: 3 sentinels, quorum-based automatic failover</text>

  <rect x="300" y="40" width="280" height="70" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="440" y="62" text-anchor="middle" fill="#5b21b6" font-size="11" font-weight="bold">Control plane: 3 Sentinels (quorum = 2)</text>
  <rect x="316" y="72" width="80" height="28" rx="5" fill="#fff" stroke="#7c3aed"/><text x="356" y="90" text-anchor="middle" fill="#5b21b6" font-size="9">Sentinel A</text>
  <rect x="400" y="72" width="80" height="28" rx="5" fill="#fff" stroke="#7c3aed"/><text x="440" y="90" text-anchor="middle" fill="#5b21b6" font-size="9">Sentinel B</text>
  <rect x="484" y="72" width="80" height="28" rx="5" fill="#fff" stroke="#7c3aed"/><text x="524" y="90" text-anchor="middle" fill="#5b21b6" font-size="9">Sentinel C</text>

  <path d="M356,110 L200,170" stroke="#7c3aed" stroke-width="1.2" stroke-dasharray="3 3" marker-end="url(#s1)"/>
  <path d="M440,110 L440,170" stroke="#7c3aed" stroke-width="1.2" stroke-dasharray="3 3" marker-end="url(#s1)"/>
  <path d="M524,110 L680,170" stroke="#7c3aed" stroke-width="1.2" stroke-dasharray="3 3" marker-end="url(#s1)"/>
  <text x="600" y="140" fill="#7c3aed" font-size="8">monitor + gossip</text>

  <rect x="90" y="176" width="220" height="60" rx="8" fill="#fecaca" stroke="#dc2626" stroke-width="2"/>
  <text x="200" y="200" text-anchor="middle" fill="#b91c1c" font-size="11" font-weight="bold">PRIMARY (dead)</text>
  <text x="200" y="220" text-anchor="middle" fill="#991b1b" font-size="8">no PONG within down-after-ms &#8594; SDOWN</text>

  <rect x="350" y="176" width="180" height="60" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="440" y="200" text-anchor="middle" fill="#1e40af" font-size="10" font-weight="bold">REPLICA 1</text>
  <text x="440" y="218" text-anchor="middle" fill="#1e40af" font-size="8">offset 1000 (least lag)</text>

  <rect x="580" y="176" width="180" height="60" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="670" y="200" text-anchor="middle" fill="#1e40af" font-size="10" font-weight="bold">REPLICA 2</text>
  <text x="670" y="218" text-anchor="middle" fill="#1e40af" font-size="8">offset 940 (more lag)</text>

  <rect x="24" y="256" width="832" height="70" rx="8" fill="#f8fafc" stroke="#64748b"/>
  <text x="440" y="278" text-anchor="middle" fill="#334155" font-size="11" font-weight="bold">Failover steps</text>
  <text x="40" y="298" fill="#475569" font-size="9">1. SDOWN (one sentinel) &#8594; 2. ask others &#8594; quorum (2) agree &#8594; ODOWN &#8594; 3. elect leader (majority) &#8594; 4. pick best replica (lowest lag)</text>
  <text x="40" y="314" fill="#475569" font-size="9">5. REPLICAOF NO ONE on Replica 1 (promote) &#8594; 6. Replica 2 follows new primary &#8594; 7. clients ask Sentinel &#8594; reconnect to new primary</text>

  <rect x="350" y="346" width="180" height="60" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="440" y="370" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">NEW PRIMARY</text>
  <text x="440" y="388" text-anchor="middle" fill="#166534" font-size="8">(promoted Replica 1)</text>
  <path d="M440,236 L440,346" stroke="#16a34a" stroke-width="2" marker-end="url(#s2)"/>
  <text x="452" y="300" fill="#15803d" font-size="8" font-weight="bold">promoted</text>

  <path d="M580,206 L534,376" stroke="#16a34a" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#s2)"/>
  <text x="600" y="330" fill="#15803d" font-size="8">Replica 2 now follows</text>
</svg>
```

For a *pure cache*, this whole apparatus is worth it only if losing the cache causes real harm — a herd onto the origin, or a latency cliff. If the cache is trivially rebuildable and the origin can take the miss traffic, a single instance (or a simpler client-side failover to the origin) may be enough. HA is not free: it is more machines, more moving parts, and a failover that itself has a data-loss window. Choose it deliberately.

## 5. Implementation

The Go side is refreshingly simple: instead of a plain `redis.NewClient` pointed at a fixed host, you use `redis.NewFailoverClient`, hand it the Sentinel addresses and the *master name*, and it discovers the current primary through Sentinel and re-discovers it after a failover. The config-file side is where the HA semantics actually live.

```go
package hareplication

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// NewSentinelClient builds a client that talks to Sentinels, not directly to a
// fixed primary. go-redis queries the Sentinels for the current primary address
// ("SENTINEL get-master-addr-by-name"), connects to it, and — critically —
// transparently RE-DISCOVERS the new primary after a failover, so application
// code never hard-codes a host. This is the whole point of Sentinel for clients.
func NewSentinelClient() *redis.Client {
	return redis.NewFailoverClient(&redis.FailoverOptions{
		// MasterName MUST match the name in sentinel.conf's "sentinel monitor".
		MasterName: "mymaster",
		// List ALL sentinels (3+). If one is down, the client uses another to
		// discover the primary — a single sentinel address is a SPOF for discovery.
		SentinelAddrs: []string{
			"10.0.0.11:26379",
			"10.0.0.12:26379",
			"10.0.0.13:26379",
		},
		// Writes and consistency-sensitive reads go to the PRIMARY.
		// (RouteByLatency / RouteRandomly would spread reads to replicas — see below.)
		DB:           0,
		PoolSize:     50,
		DialTimeout:  3 * time.Second,
		ReadTimeout:  2 * time.Second,
		WriteTimeout: 2 * time.Second,
	})
}

// NewReplicaReadClient routes READS to replicas to scale read throughput. This
// accepts STALENESS: a replica lags the primary, so a read here may return a
// value older than the last write to the primary. Use ONLY for reads that
// tolerate eventual consistency; never for read-your-writes flows.
func NewReplicaReadClient() *redis.Client {
	return redis.NewFailoverClient(&redis.FailoverOptions{
		MasterName:    "mymaster",
		SentinelAddrs: []string{"10.0.0.11:26379", "10.0.0.12:26379", "10.0.0.13:26379"},
		// ReplicaOnly sends reads to replicas; writes still error unless routed to
		// the primary. RouteByLatency picks the closest node. This is the read-scaling knob.
		ReplicaOnly:    true,
		RouteByLatency: true,
	})
}

// WriteWithReplicationGuarantee shows how to buy back durability on the write
// path with WAIT. Async replication means a plain SET can be lost on failover;
// WAIT blocks until N replicas have acknowledged EVERYTHING up to now, turning
// this one write into bounded-synchronous. The cost is latency + the risk that
// too few replicas are available.
func WriteWithReplicationGuarantee(ctx context.Context, rdb *redis.Client, key, val string) error {
	if err := rdb.Set(ctx, key, val, 10*time.Minute).Err(); err != nil {
		return fmt.Errorf("set: %w", err)
	}

	// WAIT numreplicas=1, timeout=500ms. Returns the number of replicas that
	// acknowledged the replication offset reached by our writes so far.
	acked, err := rdb.Wait(ctx, 1, 500*time.Millisecond).Result()
	if err != nil {
		return fmt.Errorf("wait: %w", err)
	}
	if acked < 1 {
		// The write is IN the primary's memory but not confirmed on any replica.
		// If the primary now fails, this write is in the data-loss window. Decide
		// per-use-case: retry, alert, or accept. WAIT does NOT roll the write back.
		return errors.New("write not replicated within timeout: at risk on failover")
	}
	return nil
}

// ReadYourWrite demonstrates the safe pattern when a read MUST see a just-written
// value in a replica-read deployment: write to the primary, WAIT for propagation,
// THEN read from a replica. Without the WAIT, the replica read races the
// replication stream and can return the stale value.
func ReadYourWrite(ctx context.Context, primary, replica *redis.Client, key, val string) (string, error) {
	if err := primary.Set(ctx, key, val, 10*time.Minute).Err(); err != nil {
		return "", err
	}
	if _, err := primary.Wait(ctx, 1, 300*time.Millisecond).Result(); err != nil {
		return "", err
	}
	// Now at least one replica has the write; reading from replicas is safe for it.
	return replica.Get(ctx, key).Result()
}

// InspectReplication reads INFO replication to observe lag directly — the byte
// difference between the primary's offset and each replica's acked offset. This
// is what you alert on: rising lag predicts a bigger data-loss window on failover.
func InspectReplication(ctx context.Context, rdb *redis.Client) (string, error) {
	// The "Replication" section lists role, connected_slaves, and per-replica
	// offset. master_repl_offset minus a slave's offset = that replica's lag.
	return rdb.Info(ctx, "replication").Result()
}
```

The matching configuration. On the primary and replicas (`redis.conf`):

```conf
# --- redis.conf (primary) ---
# Fail CLOSED: refuse writes unless at least 1 replica is reachable and its lag
# is under 10s. This bounds the data-loss window by REJECTING writes that could
# not be replicated, rather than accepting and silently losing them on failover.
min-replicas-to-write 1
min-replicas-max-lag 10

# Backlog sized for your write throughput x expected disconnect window, so a
# briefly-disconnected replica does a cheap PARTIAL resync, not a full one.
repl-backlog-size 64mb
repl-backlog-ttl 3600

# --- redis.conf (replica) ---
# Follow the primary. Sentinel rewrites this line automatically on failover.
replicaof 10.0.0.10 6379
replica-read-only yes
# Priority for promotion: lower = more preferred. 0 = never promote (e.g. a
# cross-region DR replica you don't want to become primary).
replica-priority 100
```

And the Sentinel configuration (`sentinel.conf`), one per Sentinel host:

```conf
# --- sentinel.conf ---
port 26379
# Monitor primary "mymaster" at this address; QUORUM = 2 sentinels must agree
# it is down before failover starts. With 3 sentinels, quorum 2 tolerates one
# sentinel failure while still preventing split-brain.
sentinel monitor mymaster 10.0.0.10 6379 2
# Mark SDOWN after 5s of no response.
sentinel down-after-milliseconds mymaster 5000
# During failover, reconfigure at most 1 replica at a time to follow the new
# primary, so read capacity isn't wiped out all at once.
sentinel parallel-syncs mymaster 1
# Abort/retry a failover that doesn't complete within 60s.
sentinel failover-timeout mymaster 60000
sentinel auth-pass mymaster <redacted>
```

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Automatic failover.** Sentinel promotes a replica without a human in the loop, cutting the outage from minutes-of-paging to seconds.
- **Read scaling.** Replicas absorb read traffic, multiplying read throughput without touching the primary's write capacity.
- **Cheap, mature, no extra data store.** Sentinel ships with Redis, needs no external coordinator (unlike some HA systems that need ZooKeeper/etcd), and the model is well understood.
- **Quorum safety.** A 3+ Sentinel topology prevents a single mistaken observer from causing split-brain.
- **Partial resync.** Transient disconnects heal cheaply from the backlog, without a full snapshot each time.

**Disadvantages**
- **Async means data loss on failover.** Acknowledged-but-unreplicated writes are lost when a primary fails — the defining limitation.
- **Replica reads are stale.** Reading from replicas gives eventual consistency, breaking read-your-writes unless you use `WAIT` or route to the primary.
- **Operational complexity.** More processes (replicas + 3 Sentinels), more configuration, and failover behaviour you must test — an untested failover is a liability.
- **Failover is not instant.** `down-after-milliseconds` plus election plus promotion is seconds of write unavailability, during which writes fail.
- **Single primary for writes.** Replication scales reads, not writes; write throughput past one node needs Cluster (chapter 26).

**Trade-offs**
- *Latency vs durability:* plain async replication gives the lowest write latency and a data-loss window; `WAIT`/`min-replicas-to-write` trade latency and availability for a smaller window. You cannot have all three.
- *Read scaling vs consistency:* reading from replicas multiplies read throughput but introduces staleness; each read site must decide whether it tolerates lag.
- *Availability vs split-brain safety:* a lower quorum and shorter `down-after-milliseconds` fail over faster but risk promoting on a transient blip; a higher quorum is safer but slower to react.
- *HA cost vs cache disposability:* for a trivially-rebuildable cache the whole HA stack may be over-engineering; for a cache whose loss stampedes the origin it is essential.

## 7. Common Mistakes & Best Practices

- **Assuming replication is synchronous.** The most damaging misconception. A client that saw `OK` can lose that write on failover. **Best practice:** treat every acknowledged write as durable only after `WAIT` confirms replication, or accept the window explicitly.
- **Running two Sentinels (or one).** With two, no majority survives one failure, so failover can deadlock or split. **Best practice:** always three or more Sentinels, on independent failure domains.
- **Reading from replicas everywhere by default.** Sprinkling replica reads into read-after-write flows produces intermittent staleness bugs. **Best practice:** route only lag-tolerant reads to replicas; keep read-your-writes on the primary or gate with `WAIT`.
- **Undersized replication backlog.** A too-small `repl-backlog-size` turns every network blip into a full resync — a fork and RDB transfer that spikes latency. **Best practice:** size it for `write_throughput × expected_disconnect`.
- **Not setting `min-replicas-to-write`.** Without it, the primary happily accepts writes with zero healthy replicas, maximising the loss window. **Best practice:** set `min-replicas-to-write 1` and `min-replicas-max-lag` to fail closed.
- **Never testing failover.** An HA setup that has never actually failed over in a drill is untested and probably broken. **Best practice:** run game-day failovers regularly and measure the loss window and client recovery.
- **Pointing clients at a fixed primary IP.** Hard-coding the primary defeats Sentinel — clients won't follow the promotion. **Best practice:** use a `FailoverClient` that discovers the primary via Sentinel.
- **Ignoring `replica-priority`.** A DR replica in another region can get promoted and become a distant primary. **Best practice:** set `replica-priority 0` on replicas that must never be promoted.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** `INFO replication` on any node shows its role, connected replicas, and offsets — the first stop when replication looks wrong. `SENTINEL master mymaster` and `SENTINEL replicas mymaster` show what the Sentinels believe the topology is; a mismatch between Sentinel's view and reality is the classic post-failover bug. `SENTINEL ckquorum mymaster` verifies enough Sentinels are reachable to both authorise (quorum) and run (majority) a failover *before* you need one.
- **Monitoring.** Alert on **replication lag** (primary `master_repl_offset` minus each replica's offset) because rising lag is a growing data-loss window. Alert on `connected_slaves` dropping (a replica fell off, so `min-replicas-to-write` may soon block writes). Track failover events and their duration. Watch for full-resync storms in the logs — a symptom of an undersized backlog or a flapping link.
- **Security.** Sentinels and Redis nodes must share auth: `requirepass`/`masterauth` on the data nodes and `sentinel auth-pass` on the Sentinels, or a failover leaves the promoted primary unauthenticated. Put the whole topology on a private network with TLS (`tls-replication yes`); an exposed Sentinel port is a control-plane attack surface — an attacker who can talk to Sentinel can trigger failovers. Bind Sentinel to internal interfaces only.
- **Scaling.** Replication scales *reads* by adding replicas, up to the point where the primary's outbound replication bandwidth or fan-out becomes the limit (sub-replicas — a replica of a replica — can offload fan-out). It does **not** scale writes: there is exactly one primary. When write volume or dataset size outgrows one node, you move to Redis Cluster (chapter 26), which shards the keyspace across many primaries, each with its own replicas and its own failover.

## 9. Interview Questions

**Q: Is Redis replication synchronous or asynchronous, and why does it matter?**
A: Asynchronous. The primary applies a write in memory and immediately acknowledges it to the client, then propagates it to replicas in the background. It does not wait for any replica to confirm. This matters enormously for high availability: it means there is always a small window of writes the primary has acknowledged but not yet replicated, and if the primary fails during that window, those writes are lost when a replica is promoted — even though the client received `OK`. The upside is low write latency; the downside is that async replication plus failover equals a bounded data-loss window, which you manage with `WAIT` and `min-replicas-to-write` rather than eliminate.

**Q: What is the difference between a full resync and a partial resync?**
A: A full resync is what a brand-new replica (or one that has fallen too far behind) does: the primary forks a child, produces a full RDB snapshot of the dataset, streams it to the replica, buffers writes that arrive during the transfer, and then feeds the live command stream. It is heavy — a fork, a snapshot, and full bandwidth. A partial resync is the optimisation for a briefly-disconnected replica: the primary keeps a fixed-size replication backlog (a ring buffer of the recent stream tagged with a replication ID and offset), and if the reconnecting replica's last offset is still in that buffer, the primary replays only the missing bytes. Partial resync is cheap; you size `repl-backlog-size` so realistic disconnects heal partially rather than triggering full resyncs.

**Q: How does Sentinel decide to fail over, and why the quorum?**
A: Each Sentinel pings the primary; if it gets no response within `down-after-milliseconds`, it marks the primary *subjectively down* — its own opinion. It then asks the other Sentinels, and only when at least `quorum` of them agree does the primary become *objectively down*, authorising failover. Separately, the Sentinels elect a leader by majority vote to actually run the promotion. The quorum exists to prevent split-brain: a network partition can make a perfectly healthy primary look dead to one Sentinel while it still serves clients on the other side, and promoting a replica on that single mistaken signal would create two primaries. Requiring several Sentinels to agree, and a majority to elect the failover leader, ensures a lone confused observer cannot trigger a split.

**Q: What exactly is lost when a Redis primary fails over?**
A: Every write the primary acknowledged to a client but had not yet propagated to the replica that gets promoted. Concretely: the primary is at replication offset 1000, the best replica is at 990, and the primary crashes — the writes between offsets 990 and 1000 were acknowledged to clients but never reached the replica, so when that replica becomes primary they are gone, invisibly. The clients believe those writes committed. This is the async-replication data-loss window, and its size is exactly the replication lag at the moment of failure, which is why you monitor lag and why `WAIT`/`min-replicas-to-write` exist to bound it.

**Q: How do clients find the current primary after a failover?**
A: They ask Sentinel rather than hard-coding an address. A Sentinel-aware client (in Go, `redis.NewFailoverClient` with the master name and the list of Sentinel addresses) queries the Sentinels with `SENTINEL get-master-addr-by-name`, connects to whatever they report as the current primary, and subscribes to Sentinel's notifications so that after a failover it re-discovers the new primary and reconnects automatically. That is the entire reason clients talk to Sentinel: the primary's address is not fixed, and Sentinel is the source of truth for "who is the primary right now."

**Q: What does read-scaling from replicas cost you?**
A: Consistency. Replicas are asynchronous copies, so a read from a replica may return a value older than the most recent write to the primary — you get eventual consistency, not read-your-writes. For a cache that is often acceptable, since staleness is a cache's normal condition, but it breaks flows where a user writes and immediately reads back their own change. The mitigations are to route reads that must be fresh to the primary, or to issue `WAIT` after the write so the value has reached a replica before you read it there. The discipline is to consciously classify each read as lag-tolerant or not, rather than defaulting everything to replicas and discovering the staleness in production.

**Q: (Senior) You must not lose acknowledged writes on failover. How do you configure Redis, and what do you give up?**
A: You cannot make async replication lossless, but you can bound the window to near-zero at a cost. First, `min-replicas-to-write 1` with `min-replicas-max-lag 10` makes the primary *fail closed* — it refuses writes unless at least one replica is connected and lagging under ten seconds — so you never accept a write with nowhere to replicate it. Second, wrap durability-critical writes in `WAIT numreplicas timeout` so the client blocks until the write has actually reached the required number of replicas before treating it as committed; if `WAIT` times out, you treat the write as failed and retry or alert. What you give up is threefold: latency, because `WAIT` adds a round trip to a replica on the write path; availability, because `min-replicas-to-write` means losing your replicas makes the primary reject writes entirely (you have chosen consistency over availability, CP over AP for those writes); and throughput, because synchronous acknowledgement caps how fast you can commit. If the requirement is genuinely zero loss under all failures, Redis replication is the wrong tool — you need a system with synchronous replication and consensus, and you should question whether a cache should be your system of record at all.

**Q: (Senior) Walk through how split-brain can still happen despite Sentinel, and how you minimise it.**
A: Sentinel's quorum prevents *promoting* a second primary without agreement, but it does not instantly stop the *old* primary from accepting writes during a partition. Consider a partition that isolates the current primary with some clients on its side: the Sentinels on the majority side declare it down and promote a replica, so now there are two primaries — the isolated old one still taking writes from clients that can reach it, and the new one on the majority side. Both accept divergent writes until the partition heals, at which point the old primary is demoted to a replica of the new one and *its* divergent writes are discarded — silent data loss. You minimise this two ways. First, `min-replicas-to-write` on the primary: if the old primary loses its replicas during the partition (because they're on the majority side following the new primary), it stops accepting writes, shrinking the divergence window. Second, tune `down-after-milliseconds` and quorum so failover is decisive but not trigger-happy, and place Sentinels and nodes across failure domains so the majority side is well-defined. You cannot eliminate the window entirely with Sentinel — bounding it, and accepting that the losing side's writes vanish, is the model.

**Q: (Senior) How do you size the replication backlog, and what goes wrong if you get it wrong?**
A: The backlog is a ring buffer of the most recent replication stream, and its purpose is to let a briefly-disconnected replica resume with a partial resync instead of a full one. You size it for the worst realistic disconnect window at your write throughput: if you write 5 MB/s of replication traffic and want to survive a 60-second replica reboot or network flap without a full resync, you need at least 300 MB (`repl-backlog-size 300mb`), plus headroom. If it's too small, a replica that's gone longer than the buffer covers finds its offset already overwritten, so the primary falls back to a full resync — a fork on the primary (with its copy-on-write memory spike), a full RDB transfer, and a latency hit — and if this happens repeatedly (a flapping link, a slow replica) you get a full-resync storm that hammers the primary. If it's too large, you're just spending memory you could use for data. The failure signature in the logs is repeated "Full resync" and "Partial resynchronization not accepted" messages, which is the direct cue to raise `repl-backlog-size` or fix the underlying flapping link.

**Q: When is the whole Sentinel + replication stack not worth it for a cache?**
A: When the cache is trivially rebuildable and its loss doesn't harm the origin. If a single Redis dying just means a cold cache that repopulates from an origin that can comfortably absorb the miss traffic, the operational cost of three Sentinels, replicas, and tested failover may exceed the benefit — a single instance with the client falling back to the origin on connection failure is simpler and adequate. The stack earns its keep when losing the cache causes real harm: a thundering herd that overwhelms the database (chapter 12), a latency cliff users notice, or a cache holding data that is expensive to recompute. The decision is about blast radius, not dogma: HA is a cost you pay to shrink a specific failure's impact, and if that impact is small, you may not need to pay it.

## 10. Quick Revision & Cheat Sheet

| Concept | What it is | Key lever |
|---|---|---|
| Async replication | Primary acks before replicas confirm | `WAIT`, `min-replicas-to-write` |
| Replication lag | Byte gap primary offset − replica offset | Monitor; it *is* the loss window |
| Full resync | RDB snapshot to a fresh/far-behind replica | Avoid via backlog sizing |
| Partial resync | Catch up from backlog after short disconnect | `repl-backlog-size` |
| Sentinel | Monitors + fails over by quorum | `sentinel monitor <name> <ip> <port> <quorum>` |
| Quorum | Sentinels that must agree primary is down | Prevents split-brain |
| Failover | Promote replica → `REPLICAOF NO ONE` | `down-after-milliseconds` |
| `FailoverClient` | Client discovers primary via Sentinel | `MasterName` + `SentinelAddrs` |

| Guarantee wanted | Do this | Cost |
|---|---|---|
| Lowest write latency | Plain async (default) | Data-loss window on failover |
| Bounded loss | `WAIT n timeout` per write | Write latency + availability |
| Fail closed | `min-replicas-to-write 1` | Reject writes if no replica |
| Fresh replica read | Write → `WAIT` → read replica | Extra round trip |

**Flash cards**
- **Sync or async?** → Async; primary acks before replicas confirm; failover can lose acknowledged writes.
- **What's lost on failover?** → Writes between the replica's offset and the primary's offset (= the lag).
- **Why 3 Sentinels?** → Majority survives one failure; quorum prevents split-brain.
- **SDOWN vs ODOWN?** → Subjective (one Sentinel's opinion) vs objective (quorum agrees).
- **How do clients find the primary?** → Ask Sentinel; use `FailoverClient`, never a hard-coded IP.
- **Backlog too small?** → Every blip becomes a full resync (fork + RDB); size it for throughput × disconnect.

## 11. Hands-On Exercises & Mini Project

- [ ] Stand up a primary and two replicas with `REPLICAOF`; write to the primary and read from a replica; confirm the replica is read-only (a write errors).
- [ ] Observe replication lag: run a tight write loop on the primary and watch the offset gap in `INFO replication` on a throttled replica.
- [ ] Trigger a partial resync: briefly `CLIENT KILL` the replica link, reconnect, and confirm the logs show a partial (not full) resync; then shrink `repl-backlog-size` and force a full resync.
- [ ] Deploy three Sentinels, kill the primary, and time the failover; confirm a `FailoverClient` follows the promotion without app changes.
- [ ] Demonstrate the loss window: with lag present, write, kill the primary before it replicates, fail over, and show the write is gone.
- [ ] Add `WAIT 1 500` after that write and show it now either replicates or reports failure, closing the window.

### Mini Project — "Failover Lab with a Measured Loss Window"

**Goal.** Build a Sentinel-managed primary/replica topology and *measure* the data-loss window, so async replication's trade-off is a number you've seen rather than a slogan.

**Requirements.**
1. Provision one primary, two replicas, and three Sentinels (Docker Compose is fine), with `sentinel monitor mymaster … 2`.
2. Write a Go load generator using `FailoverClient` that continuously writes monotonically increasing counters and records the last value it saw acknowledged.
3. Introduce replication lag (throttle a replica or burst writes), then kill the primary and let Sentinel fail over.
4. After failover, compare the highest acknowledged counter against what survived on the new primary — the difference *is* your data-loss window.
5. Re-run with `min-replicas-to-write 1` + `WAIT 1 500` on writes and show the window shrink to near-zero, measuring the added write latency.

**Extensions.**
- Add a replica-read client, write-then-read the same key, and chart how often you read a stale value versus lag; then gate the read with `WAIT` and show the staleness vanish.
- Simulate a network partition (not a crash) and observe split-brain: writes accepted on the isolated old primary that are discarded when it rejoins as a replica.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Redis as a Cache* (the single-instance model this chapter makes highly available), *Design: Redis Cluster* (sharding and per-shard failover when replication can't scale writes), *Persistence: RDB, AOF & Durability* (the snapshot mechanism full resync reuses), *Cache Stampede & Thundering Herd* (why losing a cache all at once is dangerous), *Client-Side Caching, Pooling & Performance* (how the `FailoverClient` connects), *Consistency & Invalidation* (the eventual-consistency reads from replicas introduce).

- **Redis — Replication** — Redis · *Intermediate* · the authoritative description of async replication, `PSYNC`, the backlog, and full/partial resync. <https://redis.io/docs/latest/operate/oss_and_stack/management/replication/>
- **Redis — High availability with Redis Sentinel** — Redis · *Intermediate* · Sentinel's detection, quorum, leader election, and failover in the maintainers' own words. <https://redis.io/docs/latest/operate/oss_and_stack/management/sentinel/>
- **Redis — WAIT command** — Redis · *Advanced* · exactly what `WAIT` guarantees and, importantly, what it does not. <https://redis.io/docs/latest/commands/wait/>
- **Designing Data-Intensive Applications (ch. 5, Replication)** — Martin Kleppmann · *Advanced* · the definitive treatment of leader-based replication, replication lag, and read-your-writes consistency. <https://dataintensive.net/>
- **Redis — `min-replicas-to-write` and durability** — Redis · *Intermediate* · how to fail closed and bound the loss window on the config side. <https://redis.io/docs/latest/operate/oss_and_stack/management/config/>
- **AWS ElastiCache — Multi-AZ and automatic failover** — AWS · *Intermediate* · how a managed provider operationalises Redis replication + failover, useful for contrast. <https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/AutoFailover.html>
- **go-redis — FailoverClient documentation** — redis/go-redis · *Intermediate* · the Sentinel-aware client API used in §5. <https://pkg.go.dev/github.com/redis/go-redis/v9#NewFailoverClient>
- **Redis University — RU301: Running Redis at Scale** — Redis · *Intermediate* · a free course covering replication, Sentinel, and high availability hands-on. <https://university.redis.com/>

---

*Caching with Redis Handbook — chapter 25.*
