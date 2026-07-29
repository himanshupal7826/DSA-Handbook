# 26 · Design: Redis Cluster — Sharding, Hash Slots & Resharding

> **In one line:** Redis Cluster shards the keyspace across many primaries using **16384 fixed hash slots**, and every hard part of using it — the cross-slot restriction, hash tags, `MOVED`/`ASK` redirections, live resharding, the hot-slot hazard — is a direct consequence of that one mechanism: a key belongs to exactly one slot, a slot lives on exactly one node.

---

## 1. Overview

Replication (chapter 25) makes Redis *available* and scales *reads*, but it does not scale writes or dataset size: there is one primary holding the whole keyspace, capped by one machine's RAM and one core's write throughput. When your working set no longer fits in one node, or your write rate saturates one primary, you must **shard** — split the keyspace across multiple primaries so each owns a slice. Redis Cluster is Redis's built-in, client-transparent sharding: it partitions the key space into **16384 hash slots**, assigns ranges of slots to nodes, and routes each key to the node owning its slot.

The whole design flows from one deterministic rule: **`HASH_SLOT = CRC16(key) mod 16384`**. Every client and every node computes the same slot for a given key, with no coordinator to ask, so routing is a local calculation, not a lookup. Slots are then distributed across the primaries — with three primaries, roughly slots 0–5460, 5461–10922, 10923–16383 — and each primary has one or more replicas for HA, giving per-shard failover. A smart client caches the slot-to-node map and sends each command straight to the right node; when the map is stale (a slot moved), the node replies `MOVED` or `ASK` to redirect and correct the client's map.

This is a *design-round* chapter as much as an operations one. In a system-design interview, "how do you scale Redis past one node?" is answered with Cluster, and the follow-ups are exactly its constraints: you lose cheap multi-key operations (keys on different slots can't be touched atomically), you regain them for *related* keys with hash tags `{...}`, resharding moves slots live without downtime, and the ever-present hazard is a **big key or hot slot** — because a single key lives entirely on one slot on one node, a giant key or a viral key concentrates all its memory and traffic on one shard, and no amount of clustering spreads it. Knowing when Cluster is warranted (and when a single primary with replicas is the right, simpler answer) is half the skill.

## 2. Core Concepts

- **Hash slot** — one of 16384 buckets the keyspace is divided into; the unit of sharding and of data movement.
- **`CRC16(key) mod 16384`** — the deterministic function mapping a key to its slot; computed identically by clients and nodes.
- **Shard** — a primary plus its replicas, owning a contiguous-ish set of slots; the unit of horizontal scale and of failover.
- **Slot map** — the mapping of slot → owning node; cached by smart clients so routing is a local computation.
- **Cross-slot operation** — a multi-key command whose keys hash to different slots; **rejected** by Cluster because it would span nodes.
- **Hash tag `{...}`** — a substring in braces that, if present, is the *only* part of the key hashed, forcing related keys onto the same slot so multi-key ops work.
- **`MOVED`** — a *permanent* redirection: "this slot now lives on node X"; the client updates its slot map and retries there.
- **`ASK`** — a *transient* redirection during a live slot migration: "for this one request, ask node X"; the client does **not** update its map.
- **Resharding** — moving slots (and their keys) between nodes while the cluster serves traffic, to rebalance or add/remove capacity.
- **Smart client** — a client that caches the slot map, routes directly, and handles `MOVED`/`ASK`; the norm (go-redis `ClusterClient`).
- **Hot slot / big key** — a slot receiving disproportionate traffic, or a single large key, concentrating load on one shard — the primary scaling hazard.
- **`CLUSTERDOWN`** — the state when some slots are unassigned (e.g. a shard with no surviving primary); by default the whole cluster refuses writes.

## 3. Theory & Principles

### 16384 slots and why that number

Cluster does not hash keys directly to nodes — that would make adding a node require rehashing every key (the classic problem consistent hashing solves). Instead it introduces a fixed indirection layer of **16384 slots**. Keys map to slots by a fixed function; slots map to nodes by an *assignment* you can change. To add a node, you move some slots (and their keys) to it; every other key stays exactly where it was. The slot count is fixed forever at 16384, so the mapping function never changes and clients from different versions agree.

Why 16384 and not, say, 65536? The number is a deliberate engineering compromise from the cluster's gossip protocol. Nodes exchange their slot ownership as a bitmap in every heartbeat; 16384 bits is a 2 KB bitmap, small enough to gossip cheaply and frequently even in a large cluster. 65536 bits would be an 8 KB bitmap in every message — four times the bandwidth for a slot granularity finer than any realistic cluster needs (16384 slots comfortably supports up to ~1000 nodes, far beyond typical). So 16384 is "fine-grained enough to balance load across any real cluster, coarse enough that the gossip bitmap stays tiny." It is a lovely example of a constant chosen for the protocol, not the data.

### The cross-slot restriction and hash tags

Because a key's slot is fixed by its name and each slot lives on one node, a multi-key command is only executable if **all its keys are on the same node** — which Cluster enforces conservatively as *all on the same slot*. `MGET a b c`, `SINTERSTORE dst src1 src2`, a `MULTI/EXEC` touching several keys, or a Lua script reading multiple keys all require their keys to share a slot; otherwise the node replies `CROSSSLOT Keys in request don't hash to the same slot`. This is not a bug to work around casually — it is the price of sharding, because a truly cross-node atomic operation would need distributed transactions Cluster deliberately doesn't do.

The escape hatch is the **hash tag**. If a key contains a substring wrapped in `{ }`, Redis hashes *only that substring* to compute the slot. So `{user:42}:profile` and `{user:42}:sessions` both hash on `user:42` and therefore land on the same slot — and multi-key operations across them work. This is how you deliberately co-locate related keys: choose a hash tag that groups exactly the keys you need to operate on together (a user's keys, a tenant's keys), and no more. The danger is over-grouping: if you tag *too many* keys with the same value, they all pile onto one slot on one node, recreating the single-node bottleneck you sharded to escape. Hash tags are a scalpel, not a hammer — tag the minimum set that genuinely needs atomic multi-key access.

```svg
<svg viewBox="0 0 880 460" width="100%" height="460" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="c1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Key &#8594; slot &#8594; node, and hash tags to co-locate</text>

  <rect x="24" y="40" width="832" height="150" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="440" y="62" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">Routing: HASH_SLOT = CRC16(key) mod 16384</text>

  <rect x="48" y="78" width="150" height="34" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="123" y="100" text-anchor="middle" fill="#1e40af" font-size="10">key "session:abc"</text>
  <path d="M198,95 L262,95" stroke="#2563eb" stroke-width="1.5" marker-end="url(#c1)"/>
  <rect x="266" y="78" width="150" height="34" rx="6" fill="#bfdbfe" stroke="#2563eb"/>
  <text x="341" y="100" text-anchor="middle" fill="#1e3a8a" font-size="10">CRC16 mod 16384</text>
  <path d="M416,95 L480,95" stroke="#2563eb" stroke-width="1.5" marker-end="url(#c1)"/>
  <rect x="484" y="78" width="120" height="34" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="544" y="100" text-anchor="middle" fill="#1e40af" font-size="10">slot 7365</text>
  <path d="M604,95 L668,95" stroke="#2563eb" stroke-width="1.5" marker-end="url(#c1)"/>
  <rect x="672" y="78" width="160" height="34" rx="6" fill="#bfdbfe" stroke="#2563eb"/>
  <text x="752" y="100" text-anchor="middle" fill="#1e3a8a" font-size="10">Node B (5461&#8211;10922)</text>

  <text x="48" y="140" fill="#1e40af" font-size="9" font-weight="bold">Client computes the slot LOCALLY (no lookup) and sends the command straight to the owning node. The slot map is cached.</text>
  <text x="48" y="160" fill="#64748b" font-size="9">16384 slots: a 2KB gossip bitmap &#8212; fine enough to balance any real cluster, small enough to heartbeat cheaply.</text>
  <text x="48" y="178" fill="#64748b" font-size="9">Adding a node moves SLOTS, not a rehash of every key &#8212; the indirection layer is the point.</text>

  <rect x="24" y="204" width="405" height="240" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="226" y="226" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">WITHOUT hash tags: cross-slot fails</text>
  <rect x="44" y="240" width="170" height="30" rx="5" fill="#fee2e2" stroke="#dc2626"/>
  <text x="129" y="260" text-anchor="middle" fill="#b91c1c" font-size="9">user:42:profile &#8594; slot 9110</text>
  <rect x="238" y="240" width="170" height="30" rx="5" fill="#fee2e2" stroke="#dc2626"/>
  <text x="323" y="260" text-anchor="middle" fill="#b91c1c" font-size="9">user:42:sessions &#8594; slot 2044</text>
  <text x="226" y="292" text-anchor="middle" fill="#991b1b" font-size="10">different slots &#8594; different nodes</text>
  <rect x="44" y="304" width="364" height="120" rx="6" fill="#fff" stroke="#fca5a5"/>
  <text x="226" y="326" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">MGET user:42:profile user:42:sessions</text>
  <text x="226" y="352" text-anchor="middle" fill="#dc2626" font-size="11" font-weight="bold">&#8594; CROSSSLOT error</text>
  <text x="60" y="378" fill="#991b1b" font-size="9">Multi-key ops require all keys on ONE slot.</text>
  <text x="60" y="396" fill="#991b1b" font-size="9">No MGET, no MULTI/EXEC, no multi-key Lua</text>
  <text x="60" y="412" fill="#991b1b" font-size="9">across these two keys.</text>

  <rect x="451" y="204" width="405" height="240" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="653" y="226" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">WITH hash tag {user:42}: co-located</text>
  <rect x="471" y="240" width="170" height="30" rx="5" fill="#dcfce7" stroke="#16a34a"/>
  <text x="556" y="260" text-anchor="middle" fill="#166534" font-size="9">{user:42}:profile &#8594; slot 5921</text>
  <rect x="665" y="240" width="170" height="30" rx="5" fill="#dcfce7" stroke="#16a34a"/>
  <text x="750" y="260" text-anchor="middle" fill="#166534" font-size="9">{user:42}:sessions &#8594; slot 5921</text>
  <text x="653" y="292" text-anchor="middle" fill="#15803d" font-size="10">only "user:42" is hashed &#8594; SAME slot</text>
  <rect x="471" y="304" width="364" height="120" rx="6" fill="#fff" stroke="#86efac"/>
  <text x="653" y="326" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">MGET {user:42}:profile {user:42}:sessions</text>
  <text x="653" y="352" text-anchor="middle" fill="#16a34a" font-size="11" font-weight="bold">&#8594; works (one node)</text>
  <text x="487" y="378" fill="#166534" font-size="9">Tag the MINIMUM set that needs atomic access.</text>
  <text x="487" y="396" fill="#166534" font-size="9">Over-tagging &#8594; everything on one slot &#8594;</text>
  <text x="487" y="412" fill="#b91c1c" font-size="9" font-weight="bold">hot slot, single-node bottleneck returns.</text>
</svg>
```

### MOVED vs ASK: how routing self-corrects

A smart client caches the slot map, but that map can be stale — a slot may have moved to another node since the client last refreshed. Cluster corrects this with two different redirections, and the distinction is the crux of understanding client routing.

- **`MOVED <slot> <ip:port>`** is a *permanent* redirection. It means "this slot now permanently lives on that node." The client should update its cached slot map — mark that slot (ideally the whole moved range) as owned by the new node — and retry there and for all future keys in that slot. `MOVED` is how a client heals a stale map after a completed resharding or failover.
- **`ASK <slot> <ip:port>`** is a *transient*, single-request redirection issued *during* a live slot migration. A slot being migrated from node A to node B is in a half-moved state: some keys already on B, some still on A. If a client asks A for a key that has already migrated, A replies `ASK` — "for *this one request*, go ask B, but do **not** update your map; the slot still officially belongs to me until migration completes." The client sends an `ASKING` command then the query to B, once, and keeps routing that slot to A for other keys. `ASK` is what makes resharding invisible: requests keep succeeding while keys move.

The rule of thumb: `MOVED` changes your map, `ASK` does not. Confusing them — updating the map on `ASK` — corrupts routing mid-migration, which is why you use a mature client library rather than rolling your own.

## 4. Architecture & Workflow

A Redis Cluster is a set of **shards**, each a primary owning a slice of the 16384 slots plus one or more replicas of that primary. The nodes form a full mesh, gossiping health and slot-ownership over a separate cluster bus port (data port + 10000). There is no central coordinator; ownership and failure detection are peer-to-peer, and clients bootstrap from any node to learn the full map.

The lifecycle of a request and of a reshard:

1. **Client computes the slot.** For key `k`, the client computes `CRC16(k) mod 16384` (honouring any `{tag}`) and looks up the owning node in its cached slot map — a purely local operation, no round trip to a coordinator.
2. **Direct dispatch.** The command goes straight to that primary (or a replica, for reads with `READONLY`).
3. **Redirection if stale.** If the map is wrong, the node replies `MOVED` (permanent — update map, retry) or `ASK` (transient migration — one-shot retry with `ASKING`, don't update map). A good client refreshes its whole slot map on `MOVED`.
4. **Resharding (live).** To rebalance or add capacity, an operator migrates slots: the source node marks a slot `MIGRATING`, the destination `IMPORTING`, and keys move in batches (`MIGRATE`). During this, that slot's keys answer normally where they still are and `ASK`-redirect where they've moved — no downtime.
5. **Completion.** When all keys in the slot have moved, ownership flips to the destination and the cluster gossips the new assignment; clients that still hit the old node now get `MOVED` and heal their maps.
6. **Per-shard failover.** Each shard runs the same replica-promotion logic as Sentinel-style HA, but *built into the cluster* (no separate Sentinels): if a primary dies, its replicas detect it via gossip, a replica is elected by the other primaries' votes, and it takes over that shard's slots. Only that shard's slots are affected; the rest of the cluster keeps serving.

```svg
<svg viewBox="0 0 880 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="m1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
    <marker id="m2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#d97706"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Cluster topology &amp; live resharding (MIGRATING / IMPORTING)</text>

  <rect x="30" y="44" width="250" height="150" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="155" y="66" text-anchor="middle" fill="#5b21b6" font-size="11" font-weight="bold">Shard A</text>
  <rect x="48" y="78" width="214" height="30" rx="5" fill="#fff" stroke="#7c3aed"/><text x="155" y="98" text-anchor="middle" fill="#5b21b6" font-size="9">Primary A &#8212; slots 0&#8211;5460</text>
  <rect x="48" y="116" width="102" height="28" rx="5" fill="#f5f3ff" stroke="#a78bfa"/><text x="99" y="134" text-anchor="middle" fill="#6d28d9" font-size="8">Replica A1</text>
  <rect x="160" y="116" width="102" height="28" rx="5" fill="#f5f3ff" stroke="#a78bfa"/><text x="211" y="134" text-anchor="middle" fill="#6d28d9" font-size="8">Replica A2</text>
  <text x="155" y="168" text-anchor="middle" fill="#6d28d9" font-size="8">per-shard failover (built in, no Sentinel)</text>
  <text x="155" y="184" text-anchor="middle" fill="#6d28d9" font-size="8">replica promoted if Primary A dies</text>

  <rect x="315" y="44" width="250" height="150" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="440" y="66" text-anchor="middle" fill="#5b21b6" font-size="11" font-weight="bold">Shard B</text>
  <rect x="333" y="78" width="214" height="30" rx="5" fill="#fff" stroke="#7c3aed"/><text x="440" y="98" text-anchor="middle" fill="#5b21b6" font-size="9">Primary B &#8212; slots 5461&#8211;10922</text>
  <rect x="333" y="116" width="102" height="28" rx="5" fill="#f5f3ff" stroke="#a78bfa"/><text x="384" y="134" text-anchor="middle" fill="#6d28d9" font-size="8">Replica B1</text>
  <rect x="445" y="116" width="102" height="28" rx="5" fill="#f5f3ff" stroke="#a78bfa"/><text x="496" y="134" text-anchor="middle" fill="#6d28d9" font-size="8">Replica B2</text>

  <rect x="600" y="44" width="250" height="150" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="725" y="66" text-anchor="middle" fill="#5b21b6" font-size="11" font-weight="bold">Shard C</text>
  <rect x="618" y="78" width="214" height="30" rx="5" fill="#fff" stroke="#7c3aed"/><text x="725" y="98" text-anchor="middle" fill="#5b21b6" font-size="9">Primary C &#8212; slots 10923&#8211;16383</text>
  <rect x="618" y="116" width="102" height="28" rx="5" fill="#f5f3ff" stroke="#a78bfa"/><text x="669" y="134" text-anchor="middle" fill="#6d28d9" font-size="8">Replica C1</text>
  <rect x="730" y="116" width="102" height="28" rx="5" fill="#f5f3ff" stroke="#a78bfa"/><text x="781" y="134" text-anchor="middle" fill="#6d28d9" font-size="8">Replica C2</text>

  <path d="M155,194 L155,214 L725,214 L725,194" stroke="#7c3aed" stroke-width="1.2" stroke-dasharray="3 3" fill="none"/>
  <text x="440" y="230" text-anchor="middle" fill="#7c3aed" font-size="9">full-mesh gossip over cluster bus (data port + 10000): health + slot ownership bitmap</text>

  <rect x="30" y="244" width="820" height="160" rx="10" fill="#fffbeb" stroke="#d97706" stroke-width="2"/>
  <text x="440" y="266" text-anchor="middle" fill="#92400e" font-size="12" font-weight="bold">Live resharding: move slot 6000 from B &#8594; C, no downtime</text>

  <rect x="70" y="288" width="180" height="60" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="160" y="310" text-anchor="middle" fill="#92400e" font-size="10" font-weight="bold">Source B: slot 6000</text>
  <text x="160" y="330" text-anchor="middle" fill="#b45309" font-size="9">state = MIGRATING</text>
  <path d="M250,318 L470,318" stroke="#d97706" stroke-width="2" marker-end="url(#m2)"/>
  <text x="360" y="308" text-anchor="middle" fill="#b45309" font-size="9">MIGRATE keys in batches</text>
  <rect x="474" y="288" width="180" height="60" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="564" y="310" text-anchor="middle" fill="#92400e" font-size="10" font-weight="bold">Dest C: slot 6000</text>
  <text x="564" y="330" text-anchor="middle" fill="#b45309" font-size="9">state = IMPORTING</text>

  <rect x="678" y="288" width="150" height="60" rx="8" fill="#fff" stroke="#d97706"/>
  <text x="753" y="308" text-anchor="middle" fill="#92400e" font-size="9" font-weight="bold">During migration</text>
  <text x="753" y="326" text-anchor="middle" fill="#b45309" font-size="8">key still on B &#8594; served</text>
  <text x="753" y="340" text-anchor="middle" fill="#b45309" font-size="8">key moved &#8594; ASK &#8594; C</text>

  <text x="70" y="372" fill="#713f12" font-size="9">MOVED = permanent (update slot map). ASK = transient during migration (one-shot, do NOT update map).</text>
  <text x="70" y="390" fill="#713f12" font-size="9">When all keys moved, ownership flips to C and gossips; stale clients then get MOVED and heal.</text>
</svg>
```

### When Cluster is warranted — and when it isn't

Cluster is not the default; it is the answer to a specific problem. Reach for it when (a) your dataset exceeds what one node's RAM can hold, or (b) your write throughput exceeds one primary's single core, or (c) you need the blast radius of a node failure to be one shard, not the whole cache. Do *not* reach for it when a single primary with replicas (chapter 25) already fits — Cluster costs you the cross-slot restriction, more nodes to operate, client complexity, and a rebalancing burden, all for scale you may not need. A very large fraction of production Redis is a single primary with replicas, precisely because most working sets fit in one modern machine's RAM. The design-round answer is: "single instance + replicas until the data doesn't fit or writes saturate one core; then Cluster, accepting cross-slot limits and designing keys with hash tags for the multi-key operations I still need."

## 5. Implementation

go-redis provides `redis.NewClusterClient`, which discovers the topology from any seed node, caches the slot map, routes each command to the owning node, and transparently follows `MOVED`/`ASK`. Your code looks almost identical to single-node code — the sharding is invisible until you hit a cross-slot operation, which is exactly where hash tags come in.

```go
package rediscluster

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// NewCluster builds a cluster-aware client. You give it a few SEED addresses;
// it discovers the full topology (all primaries + replicas + the slot map) from
// them, caches the slot map, and routes each command to the node owning the
// key's slot. MOVED/ASK redirections are handled internally.
func NewCluster() *redis.ClusterClient {
	return redis.NewClusterClient(&redis.ClusterOptions{
		Addrs: []string{ // seeds — any live node bootstraps the whole map
			"10.0.1.1:6379", "10.0.1.2:6379", "10.0.1.3:6379",
		},
		// RouteByLatency / RouteRandomly spread READS across replicas of each
		// shard (accepting staleness, ch.25). Writes always go to the primary.
		RouteByLatency: true,
		// Cap redirection retries so a mid-reshard hiccup doesn't loop forever.
		MaxRedirects: 3,
		PoolSize:     50, // POOL IS PER NODE, not global — see ch.27.
		DialTimeout:  3 * time.Second,
	})
}

// SingleKeyOps work exactly like single-node Redis — the client computes the
// slot and dispatches. The caller never thinks about which node owns the key.
func SingleKeyOps(ctx context.Context, c *redis.ClusterClient) error {
	if err := c.Set(ctx, "session:abc", "payload", 30*time.Minute).Err(); err != nil {
		return err
	}
	_, err := c.Get(ctx, "session:abc").Result()
	return err
}

// CrossSlotFails demonstrates the restriction. These two keys almost certainly
// hash to DIFFERENT slots, so a single multi-key command spans nodes and Redis
// rejects it with CROSSSLOT. This is the fundamental sharding constraint.
func CrossSlotFails(ctx context.Context, c *redis.ClusterClient) error {
	// MGET across keys on different slots -> "CROSSSLOT Keys in request don't
	// hash to the same slot". The client cannot split this into two nodes and
	// keep it atomic, so it does not try.
	_, err := c.MGet(ctx, "user:42:profile", "user:42:sessions").Result()
	if err != nil {
		return fmt.Errorf("expected cross-slot failure: %w", err)
	}
	return nil
}

// HashTagColocation is the FIX: wrap the shared identity in {braces} so ONLY
// that substring is hashed. Both keys then land on the same slot, so multi-key
// operations, MULTI/EXEC, and multi-key Lua across them all work.
func HashTagColocation(ctx context.Context, c *redis.ClusterClient) ([]interface{}, error) {
	// "user:42" inside {} is the only thing hashed -> identical slot for both.
	if err := c.Set(ctx, "{user:42}:profile", "P", 0).Err(); err != nil {
		return nil, err
	}
	if err := c.Set(ctx, "{user:42}:sessions", "S", 0).Err(); err != nil {
		return nil, err
	}
	// Now MGET works — both keys provably share a slot, hence a node.
	return c.MGet(ctx, "{user:42}:profile", "{user:42}:sessions").Result()
}

// AtomicMultiKeyWithTag: a transaction over co-located keys. Because the hash
// tag guarantees one slot, MULTI/EXEC (and multi-key Lua) run atomically on one
// node — the ONLY way to get multi-key atomicity in Cluster.
func AtomicMultiKeyWithTag(ctx context.Context, c *redis.ClusterClient, user string) error {
	tag := fmt.Sprintf("{user:%s}", user)
	pipe := c.TxPipeline()
	pipe.Incr(ctx, tag+":writes")
	pipe.Expire(ctx, tag+":writes", time.Hour)
	pipe.SAdd(ctx, tag+":active", "device-1")
	_, err := pipe.Exec(ctx)
	return err
}

// FanOutAcrossShards shows how to do a logical "multi-key" op that legitimately
// spans slots: iterate WITHOUT a single cross-slot command. ForEachMaster runs a
// function per PRIMARY, so operations like a keyspace scan or a bulk write can
// parallelise across shards instead of being rejected as cross-slot.
func FanOutAcrossShards(ctx context.Context, c *redis.ClusterClient) (int, error) {
	total := 0
	err := c.ForEachMaster(ctx, func(ctx context.Context, node *redis.Client) error {
		// Runs on each shard's primary independently. Use SCAN here — never KEYS.
		n, err := node.DBSize(ctx).Result()
		if err != nil {
			return err
		}
		total += int(n)
		return nil
	})
	return total, err
}

// InspectCluster surfaces slot ownership for debugging routing. CLUSTER SLOTS
// (or SHARDS) returns the slot ranges and their owning nodes — the ground truth
// your client's cached map should match. A mismatch explains stray MOVEDs.
func InspectCluster(ctx context.Context, c *redis.ClusterClient) error {
	slots, err := c.ClusterSlots(ctx).Result()
	if err != nil {
		return err
	}
	if len(slots) == 0 {
		return errors.New("no slots assigned — cluster not formed / CLUSTERDOWN")
	}
	for _, s := range slots {
		fmt.Printf("slots %d-%d -> %s\n", s.Start, s.End, s.Nodes[0].Addr)
	}
	return nil
}
```

Operationally, you create and reshard the cluster with `redis-cli`:

```bash
# Create a 3-primary, 3-replica cluster from six running nodes.
redis-cli --cluster create \
  10.0.1.1:6379 10.0.1.2:6379 10.0.1.3:6379 \
  10.0.1.4:6379 10.0.1.5:6379 10.0.1.6:6379 \
  --cluster-replicas 1

# Reshard 1000 slots onto a newly-added node, live, no downtime.
redis-cli --cluster reshard 10.0.1.1:6379 \
  --cluster-from <source-node-id> --cluster-to <new-node-id> \
  --cluster-slots 1000 --cluster-yes

# Check health and that all 16384 slots are covered (else CLUSTERDOWN).
redis-cli --cluster check 10.0.1.1:6379
```

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Horizontal write + memory scale.** The keyspace and write load spread across many primaries, so you scale past one machine's RAM and one core.
- **Client-transparent routing.** Keys map to slots by a fixed function; smart clients route directly with no coordinator, so there's no central bottleneck.
- **Cheap rebalancing.** The slot indirection means adding a node moves slots, not a full rehash — most keys never move.
- **Per-shard fault isolation.** A primary failure takes out one shard's slots, not the whole cache, and each shard fails over independently — built in, no separate Sentinels.
- **Live resharding.** Slots migrate while serving traffic, using `ASK` to keep requests correct mid-move.

**Disadvantages**
- **Cross-slot restriction.** Multi-key commands, transactions, and Lua only work when all keys share a slot; general multi-key atomicity is gone.
- **Hash-tag design burden.** Getting co-location right (enough to enable needed multi-key ops, not so much you create a hot slot) is a real design task.
- **Big-key / hot-slot hazard.** A single large or viral key lives on one slot on one node; Cluster cannot spread it, so it becomes a shard hotspot.
- **Operational weight.** More nodes, gossip, resharding, and a `CLUSTERDOWN` mode if slots go unassigned — more to run and monitor than a single primary.
- **Client complexity.** You need a cluster-aware client; per-node connection pools multiply, and `MOVED`/`ASK` handling must be correct.

**Trade-offs**
- *Single primary + replicas vs Cluster:* the former is simpler and keeps full multi-key semantics but caps at one node; Cluster scales out at the cost of cross-slot limits and operational weight. Choose by whether the data fits and writes saturate one core.
- *Hash-tag grouping vs distribution:* tagging co-locates keys for atomic ops but concentrates them on one slot; the trade is atomicity for a chunk of your keys versus even load. Tag the minimum set.
- *Slot granularity:* 16384 slots is fixed — fine enough to balance any real cluster, coarse enough for cheap gossip; you don't tune it, you live with the balance it gives.
- *Consistency vs availability on partition:* by default a shard with no reachable primary makes the cluster refuse writes (`cluster-require-full-coverage yes`); relaxing it keeps the rest available but serves an incomplete keyspace.

## 7. Common Mistakes & Best Practices

- **Assuming multi-key commands just work.** `MGET`/`MSET`/`SINTERSTORE`/`MULTI` across arbitrary keys fail with `CROSSSLOT` in Cluster. **Best practice:** design keys so any set you must operate on atomically shares a hash tag; otherwise fan out per key.
- **Over-using one hash tag.** Tagging everything `{app}` puts the whole keyspace on one slot, un-sharding the cluster. **Best practice:** tag the smallest grouping that needs co-location (per-user, per-tenant), not a global constant.
- **Ignoring big keys.** A multi-GB key or a viral hot key sits on one slot on one node, concentrating memory and traffic. **Best practice:** split big keys across many keys/slots; front hot keys with a local cache (chapter 27) or replicate the value across keys.
- **Treating `ASK` like `MOVED`.** Updating the slot map on `ASK` corrupts routing during migration. **Best practice:** use a mature client (`ClusterClient`) and never hand-roll redirection.
- **One global connection pool.** In Cluster the pool is per node; sizing it as if there's one server starves or floods individual shards. **Best practice:** size `PoolSize` per node against per-shard concurrency (chapter 27).
- **Running Cluster when you don't need it.** Adopting Cluster for a dataset that fits one node buys cross-slot pain for no scale gain. **Best practice:** single primary + replicas until data doesn't fit or writes saturate one core.
- **Leaving slots uncovered.** A shard down with no replica leaves its slots unassigned and, by default, the whole cluster refuses writes. **Best practice:** every primary has a replica; monitor slot coverage and failover health.
- **`KEYS`/`SCAN` assumptions across the cluster.** A single `KEYS` only sees one node's keyspace. **Best practice:** iterate per primary (`ForEachMaster` + `SCAN`), never a cluster-wide `KEYS`.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** `CLUSTER INFO` shows overall state (`cluster_state:ok` vs `fail`) and how many slots are assigned; `cluster_state:fail` means some slots are uncovered. `CLUSTER SLOTS`/`CLUSTER SHARDS` show the slot→node map — the ground truth your client's cached map must match; stray `MOVED` errors mean the client map is stale. `CLUSTER KEYSLOT <key>` tells you which slot a key hashes to, invaluable for verifying hash-tag co-location. `redis-cli --cluster check` validates that all 16384 slots are covered and consistent.
- **Monitoring.** Watch **per-slot and per-node load** to catch hot slots — a single node's ops/sec far above its peers signals a hot key or an over-grouped hash tag. Track big keys (`redis-cli --bigkeys` per node, or `MEMORY USAGE`) because a growing key on one slot is a future hotspot. Alert on `cluster_state:fail`, on slots in `MIGRATING`/`IMPORTING` that never complete (a stuck reshard), and on per-shard failover events.
- **Security.** The **cluster bus** port (data port + 10000) carries gossip and must be firewalled to cluster members only — it's unauthenticated in older versions and an internal-only channel. Set `requirepass`/`masterauth` consistently across all nodes (a mismatch breaks replication within a shard) and use ACLs (chapter 29) and TLS (`tls-cluster yes`) so both client and bus traffic are encrypted. Never expose cluster nodes or the bus port to untrusted networks.
- **Scaling.** You scale a cluster by adding a shard and resharding some slots onto it — live, via `redis-cli --cluster reshard` or `rebalance`. Scaling *reads* additionally means adding replicas per shard and routing reads to them (with the staleness of chapter 25). The scaling ceiling is high (thousands of nodes), but the practical limits are the operational burden of resharding, the hot-slot problem (which more nodes don't fix), and cross-slot design. The right growth path is: single primary → primary + replicas → Cluster, moving to each stage only when the previous one's ceiling is genuinely hit.

## 9. Interview Questions

**Q: How does Redis Cluster decide which node holds a key?**
A: It hashes the key to one of 16384 fixed hash slots with `CRC16(key) mod 16384`, and each slot is assigned to exactly one primary node. So the mapping is two layers: key→slot is a fixed function every client and node computes identically, and slot→node is an assignment the cluster maintains and can change by moving slots. A client caches the slot→node map, computes the slot locally for each key, and sends the command straight to the owning node — no coordinator lookup. If its map is stale, the node redirects it with `MOVED` (permanent) or `ASK` (transient during migration).

**Q: Why 16384 slots specifically?**
A: It's an engineering compromise driven by the gossip protocol, not the data. Nodes exchange their slot ownership as a bitmap in every heartbeat message; 16384 bits is a 2 KB bitmap, small enough to gossip cheaply and frequently even in a large cluster. A larger number like 65536 would quadruple that overhead to 8 KB per message for a granularity finer than any realistic cluster needs — 16384 slots comfortably balances load across up to around a thousand nodes. So it's fine-grained enough to spread load across any real cluster, and coarse enough that the ownership bitmap stays tiny. It's also fixed forever so the key→slot function never changes across versions.

**Q: What is the cross-slot restriction and why does it exist?**
A: A multi-key command — `MGET`, `MSET`, `SINTERSTORE`, a `MULTI/EXEC`, a multi-key Lua script — is only allowed if all its keys hash to the same slot; otherwise Redis rejects it with a `CROSSSLOT` error. It exists because each slot lives on exactly one node, so keys on different slots live on different nodes, and executing a command atomically across nodes would require distributed transactions that Cluster deliberately doesn't implement. Rather than silently give you a non-atomic split, it refuses. The way to keep multi-key operations for related keys is hash tags, which force those keys onto the same slot.

**Q: How do hash tags work and when do you use them?**
A: If a key contains a substring wrapped in braces `{ }`, Redis hashes only that substring to pick the slot, ignoring the rest of the key. So `{user:42}:profile` and `{user:42}:sessions` both hash on `user:42` and land on the same slot, which means multi-key commands, transactions, and Lua across them are allowed. You use hash tags to deliberately co-locate keys you must operate on together — a user's related keys, a tenant's keys. The discipline is to tag the *minimum* set that genuinely needs atomic multi-key access: over-tagging (say, giving every key the same tag) piles the whole keyspace onto one slot on one node, recreating the single-node bottleneck you sharded to escape.

**Q: What's the difference between MOVED and ASK?**
A: `MOVED` is a permanent redirection: the slot has moved to another node for good, so the client should update its cached slot map and route that slot there from now on — it's how a client heals a stale map after a reshard or failover. `ASK` is a transient, single-request redirection during a live slot migration: the slot is half-moved, and for the *specific key* being requested that has already migrated, the node says "go ask the destination for this one request, but don't update your map, because the slot still officially belongs to me until the migration finishes." The client sends `ASKING` plus the query to the destination once and keeps routing that slot to the source otherwise. Rule of thumb: `MOVED` updates your map, `ASK` doesn't.

**Q: How does resharding happen without downtime?**
A: Slots migrate one at a time between nodes while the cluster serves traffic. The source node marks the slot `MIGRATING` and the destination marks it `IMPORTING`, and keys move in batches via `MIGRATE`. During the migration the slot is in a half-moved state: a request for a key still on the source is served normally, and a request for a key that has already moved gets an `ASK` redirect to the destination for that one request. Because clients follow `ASK` transparently, requests keep succeeding throughout. When every key in the slot has moved, ownership flips to the destination, the cluster gossips the new assignment, and clients still hitting the old node get `MOVED` and heal their maps. No request fails and no window of unavailability opens.

**Q: (Senior) You have a viral hot key destroying one shard. Cluster is supposed to scale — why doesn't adding nodes help, and what do you do?**
A: It doesn't help because a single key hashes to a single slot, and a slot lives entirely on one node — no amount of clustering can spread one key across shards, since sharding is at slot granularity and a key is atomic to a slot. So all the traffic for that key, and all its memory, land on one primary regardless of how many nodes you add; you've hit the hot-slot (or big-key) hazard, which is orthogonal to horizontal scale. The fixes attack the key, not the cluster. First, put a **local in-process cache** (chapter 27) in front of it: a hot, rarely-changing key served from application memory removes almost all the read traffic from Redis, coalescing many requests into occasional refreshes. Second, **replicate the value across N keys** (`hotkey:0`…`hotkey:N`, each on a different slot) and have clients read a random one, spreading read load across shards at the cost of N-fold write fan-out and looser consistency. Third, if it's a *big* key rather than a *hot* one, **split it structurally** — shard a giant hash or sorted set into many sub-keys with different hash tags so its memory and its O(N) operations distribute. And you use replica reads for the shard to absorb read volume. The meta-point for the interview: Cluster scales the *keyspace*, not an individual key, so single-key hotspots are a data-modelling problem, solved above Redis.

**Q: (Senior) Walk me through deciding between a single primary with replicas and Redis Cluster for a new cache.**
A: I start from the premise that Cluster is not the default — it's the answer to specific limits — because it costs the cross-slot restriction, hash-tag design, more nodes, and resharding operations. So I ask three questions. One: does the working set fit in one node's RAM with headroom, including growth? Modern machines hold hundreds of gigabytes, and most caches fit, so if it fits, a single primary with two replicas across failure domains (chapter 25) gives me HA and read scaling with full multi-key semantics and far less to operate. Two: does the write throughput exceed what one core can push? Redis executes commands single-threaded, so if I'm saturating one primary's core on writes, replicas don't help (they scale reads) and I need to shard. Three: do I need the blast radius of a node failure to be one shard rather than the whole cache? If yes, Cluster's per-shard isolation is valuable. If the answers are "it fits, one core suffices, whole-cache failure is tolerable," I choose a single primary with replicas and revisit later. If data doesn't fit or writes saturate one core, I go to Cluster and, up front, design my keys with hash tags so the multi-key operations I actually need are co-located, and I audit for big/hot keys because Cluster won't save me from those. The path is single → primary+replicas → Cluster, advancing only when the current stage's ceiling is genuinely hit.

**Q: (Senior) What happens to consistency and availability when a Cluster node partitions away?**
A: Each shard behaves like its own single-leader replicated group, so the analysis is per shard, and Cluster's cross-shard behaviour adds a wrinkle. If a primary is partitioned from the majority side, the majority's primaries vote to promote one of its replicas — but that replica is asynchronously replicated, so any writes the old primary acknowledged in the loss window are gone on promotion, exactly the async-replication data loss of chapter 25. Meanwhile the minority-side old primary, if it can still see clients, keeps accepting writes briefly until it notices it's isolated; those diverge and are discarded when it rejoins as a replica — a small split-brain window. At the cluster level, `cluster-node-timeout` governs how quickly the partition is detected and failover proceeds; during that window the affected slots' writes fail. If a whole shard has no reachable primary (primary and all its replicas gone), those slots are uncovered, and by default `cluster-require-full-coverage yes` makes the *entire* cluster refuse writes to protect consistency — you can flip it to `no` to keep the healthy shards serving their slots at the cost of an incomplete keyspace. So the honest summary: Cluster gives you per-shard CP-ish behaviour with an async-replication loss window on failover, availability of the unaffected shards, and a deliberate config choice about whether an uncovered shard degrades the whole cluster or just its own slots.

**Q: Can you run transactions and Lua scripts in Redis Cluster?**
A: Yes, but only over keys that share a slot. `MULTI/EXEC` and `EVAL` are allowed when every key they touch hashes to the same slot — which in practice means you use hash tags to co-locate the keys a given transaction or script operates on. If a transaction or script references keys spanning multiple slots, the cluster rejects it with a cross-slot error, because it can't run atomically across nodes. So the pattern is: identify the keys that must be manipulated atomically together, give them a common hash tag so they live on one node, and then transactions and scripts over them work exactly as on a single instance. Anything that genuinely needs atomicity across unrelated keys on different slots is not something Cluster supports, and that's a design constraint to plan around, not defeat.

## 10. Quick Revision & Cheat Sheet

| Concept | Value / rule |
|---|---|
| Slot count | 16384 (fixed) |
| Key → slot | `CRC16(key) mod 16384` |
| Slot → node | Assignment; changeable by moving slots |
| Cross-slot multi-key | Rejected (`CROSSSLOT`) unless same slot |
| Hash tag | `{...}` — only the braced substring is hashed |
| `MOVED` | Permanent redirect → update slot map |
| `ASK` | Transient (mid-migration) → one-shot, don't update map |
| Resharding | `MIGRATING`/`IMPORTING`, keys move live, `ASK` bridges |
| Failover | Per shard, built in (no Sentinel) |
| Uncovered slots | `cluster_state:fail`, writes refused by default |

| Symptom | Likely cause | Fix |
|---|---|---|
| `CROSSSLOT` error | Multi-key op across slots | Hash tag to co-locate |
| One shard overloaded | Hot key / big key on one slot | Local cache, split, replicate key |
| Stray `MOVED`s | Stale client slot map | Refresh map (mature client does this) |
| `cluster_state:fail` | Uncovered slots (shard down) | Restore/replace shard; ensure replicas |

**Flash cards**
- **How many slots?** → 16384, fixed; `CRC16(key) mod 16384`.
- **Why 16384?** → 2 KB gossip bitmap: fine enough to balance, small enough to heartbeat.
- **Cross-slot rule?** → Multi-key ops need all keys on one slot; else `CROSSSLOT`.
- **Hash tag?** → `{x}` hashes only `x`; co-locates related keys; tag the minimum set.
- **MOVED vs ASK?** → MOVED permanent (update map); ASK transient (one-shot, don't update).
- **Hot key on a shard?** → Cluster can't spread one key; use local cache / split / replicate the key.
- **Cluster or not?** → Single + replicas until data doesn't fit or writes saturate one core.

## 11. Hands-On Exercises & Mini Project

- [ ] Create a 3-primary/3-replica cluster with `redis-cli --cluster create` and confirm slot coverage with `--cluster check`.
- [ ] Use `CLUSTER KEYSLOT` to show two related keys landing on different slots, then rewrite them with a hash tag and show them sharing a slot.
- [ ] Trigger a `CROSSSLOT` error with `MGET` on un-tagged keys, then make it succeed with hash tags.
- [ ] Reshard 500 slots onto a node while a load generator runs, and observe requests succeeding throughout (watch for `ASK`/`MOVED` in a debug client).
- [ ] Kill a primary and watch its replica get promoted; confirm only that shard's slots were briefly affected.
- [ ] Create a deliberately hot key, observe one node's load spike in `INFO`, then front it with an in-process cache and show the shard load drop.

### Mini Project — "Shard a Session Store and Survive a Reshard"

**Goal.** Build a cluster-backed session cache, exercise the cross-slot and hash-tag rules, and reshard it live without dropping requests — turning the routing model into muscle memory.

**Requirements.**
1. Stand up a 3-shard cluster (each shard primary + one replica) and a Go `ClusterClient` load generator writing and reading session keys.
2. Model a user's related keys (`profile`, `sessions`, `flags`) and make a multi-key transaction over them work by choosing a `{user:ID}` hash tag.
3. Demonstrate the failure first: attempt the transaction without the tag and capture the `CROSSSLOT` error, then fix it with the tag.
4. Add a fourth shard and reshard ~4000 slots onto it live, while the load generator runs, and prove zero failed requests.
5. Introduce a hot key, chart the per-node load imbalance, and mitigate it with a local near-cache; measure the reduction in Redis ops for that shard.

**Extensions.**
- Kill a shard's primary mid-load and measure the failover time and any lost writes (tie back to chapter 25's loss window).
- Deliberately over-tag (put everything under one hash tag) and show the whole load collapsing onto one node — the un-sharding anti-pattern — then fix the tagging granularity.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Replication & Redis Sentinel* (the per-shard replication and failover Cluster builds on), *Redis as a Cache* (the single-node model Cluster scales out), *Redis Data Types & Which to Cache With* (why one big key can't be sharded and must be split), *Client-Side Caching, Pooling & Performance* (per-node pools and fronting hot keys), *Memory, maxmemory & Eviction* (per-node memory limits that drive the decision to shard), *Hot Keys & Request Coalescing* (the hot-slot mitigation toolkit).

- **Redis — Cluster tutorial & specification** — Redis · *Advanced* · the authoritative description of hash slots, `MOVED`/`ASK`, resharding, and the gossip protocol. <https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/>
- **Redis — Scale with Redis Cluster** — Redis · *Intermediate* · the practical guide to creating, resharding, and operating a cluster with `redis-cli`. <https://redis.io/docs/latest/operate/oss_and_stack/management/scaling/>
- **Redis — Keyspace & hash tags** — Redis · *Intermediate* · exactly how `{...}` changes which substring is hashed and how to co-locate keys. <https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/#hash-tags>
- **Designing Data-Intensive Applications (ch. 6, Partitioning)** — Martin Kleppmann · *Advanced* · the general theory of partitioning, rebalancing, and request routing that Cluster is one instance of. <https://dataintensive.net/>
- **go-redis — ClusterClient documentation** — redis/go-redis · *Intermediate* · the cluster-aware client API, `ForEachMaster`, and per-node pool behaviour used in §5. <https://pkg.go.dev/github.com/redis/go-redis/v9#NewClusterClient>
- **Redis — CLUSTER commands reference** — Redis · *Intermediate* · `CLUSTER SLOTS`/`SHARDS`/`KEYSLOT`/`INFO` for debugging routing and coverage. <https://redis.io/docs/latest/commands/?group=cluster>
- **AWS ElastiCache — Redis Cluster mode** — AWS · *Intermediate* · how a managed provider runs sharded Redis, useful for comparing operational trade-offs. <https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/Replication.Redis-RedisCluster.html>
- **Redis University — RU301: Running Redis at Scale** — Redis · *Intermediate* · a free course covering clustering, sharding, and resharding hands-on. <https://university.redis.com/>

---

*Caching with Redis Handbook — chapter 26.*
