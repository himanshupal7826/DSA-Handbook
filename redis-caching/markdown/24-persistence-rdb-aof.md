# 24 · Persistence: RDB, AOF & the Durability Trade-off

> **In one line:** Redis can be as durable as a database — snapshots (RDB), an append-only command log (AOF), or both — but a *pure cache* usually turns all of it off, because persistence buys you durability you don't need while charging you fork latency and disk I/O you can feel.

---

## 1. Overview

Redis lives in memory, and memory is volatile: pull the power and it's gone. Persistence is how Redis writes its in-memory state to disk so it can survive a restart. There are two mechanisms with genuinely different philosophies. **RDB** takes point-in-time *snapshots* — periodically it dumps the whole dataset to a compact binary file. **AOF** keeps an append-only *log* — it records every write command as it happens, so the dataset can be rebuilt by replaying the log. You can run either, both, or neither, and the choice is a real engineering decision about how much data you can afford to lose and how much latency and I/O you'll pay to lose less.

RDB's model is the snapshot. On a schedule (or on `BGSAVE`), Redis **forks** a child process that writes a consistent copy of memory to a `.rdb` file while the parent keeps serving traffic, using the operating system's copy-on-write so the child sees a frozen view without a stop-the-world copy. RDB files are small and load fast, so restarts are quick — but between snapshots you can lose everything written since the last one, and the fork itself has a cost that scales with dataset size.

AOF's model is the log. Every write command is appended to a file, and how aggressively that file is flushed to disk is governed by `appendfsync`: `always` (fsync every write — safest, slowest), `everysec` (fsync once a second — the default, at most ~1 s of data at risk), or `no` (let the OS decide — fastest, least safe). The log grows without bound, so Redis periodically **rewrites** it into a minimal set of commands that reproduce the current state. AOF gives much better durability than RDB, at the cost of a larger file, slower restarts, and continuous write I/O.

Then comes the twist that this being a *caching* handbook makes central: for a **pure cache**, you usually disable both. The data is a disposable copy of an origin — a database, an API — that is the real source of truth. Persistence buys durability for data you can simply refetch, while charging you the fork's latency spike and the disk I/O on every write. The one honest argument for keeping persistence on a cache is the **warm restart**: an RDB snapshot lets a restarted cache come back with its working set already populated instead of a cold cache that hammers the origin. This chapter gives you the mechanisms, the fsync trade, the fork hazard, and a clear rule for when a cache should persist and when it emphatically should not.

## 2. Core Concepts

- **RDB (snapshot)** — a point-in-time binary dump of the whole dataset to a `.rdb` file, taken on a schedule or on demand.
- **`SAVE` vs `BGSAVE`** — `SAVE` snapshots on the main thread (blocks everyone); `BGSAVE` forks a child that snapshots in the background. Always `BGSAVE` in production.
- **Fork + copy-on-write** — `BGSAVE` forks a child sharing the parent's memory pages; the OS copies a page only when the parent writes it, so the child sees a frozen snapshot cheaply.
- **AOF (append-only file)** — a log of every write command, replayed on startup to rebuild the dataset.
- **`appendfsync`** — how often the AOF is fsync'd to disk: `always`, `everysec` (default), or `no`.
- **AOF rewrite** — compacting the log into the minimal commands that reproduce current state, so it doesn't grow forever (`BGREWRITEAOF`).
- **RDB-AOF hybrid preamble** — `aof-use-rdb-preamble`: the AOF rewrite writes an RDB-format snapshot as its head plus AOF commands as the tail, combining fast load with fine-grained durability.
- **Durability window** — how much recently-written data a crash can lose; determined by the persistence mode and fsync policy.
- **Warm vs cold restart** — after a restart, a persisted instance reloads its data (warm); a non-persisted one starts empty (cold) and must refill from the origin.
- **Fork hazard** — on a large dataset under heavy writes, the fork and its copy-on-write page copying cause a memory spike and a latency blip.

## 3. Theory & Principles

### RDB: the snapshot, the fork, and the copy-on-write cost

An RDB save produces a single binary file that is a consistent picture of the dataset at one instant. The magic that lets Redis do this without stopping the world is `fork()` plus copy-on-write. When `BGSAVE` runs, Redis forks: the child process inherits a view of the parent's memory through shared physical pages. The child then walks that memory and writes it to disk. Because the pages are shared copy-on-write, the child sees a *frozen* snapshot — as the parent keeps mutating data, the OS transparently copies just the pages being written so the child's view stays fixed at the fork moment. The parent never blocks on the dump; it only pays for the pages that get copied.

That "only pays for copied pages" is also the hazard. Under heavy write load a large fraction of pages get modified during the save, so the OS copies them, and memory usage can balloon toward *double* the dataset in the worst case — a real OOM risk on a tight instance. And the `fork()` call itself is not free: the kernel must set up the child's page tables, and for a large dataset (tens of gigabytes) that setup can take hundreds of milliseconds, during which the single thread is blocked — a latency spike every client feels. This is the classic "RDB fork blip": periodic latency spikes correlated with save points, worse the larger the dataset and the heavier the write rate. RDB's compensating virtues are that the file is compact (it's a dump, not a log) and loads fast on restart, so an instance configured for RDB comes back quickly. Its durability weakness is granularity: you configure save points like `save 900 1` (snapshot if ≥1 key changed in 900 s), `save 300 100`, `save 60 10000`, and a crash loses everything written since the last snapshot — potentially minutes of data.

### AOF: the log, and the fsync trade

AOF flips the model from "occasional whole-state snapshot" to "continuous incremental log". Every write command is appended to the AOF as it executes. On restart, Redis replays the log from the beginning to reconstruct the exact state. The durability of this hinges entirely on **when the appended data is actually fsync'd to disk**, controlled by `appendfsync`:

- **`always`** — fsync after every write command. You lose essentially nothing on a crash (at most the single in-flight command), but you pay a disk sync on the write path, which crushes throughput and adds latency. Reserved for the rare case where losing even one write is unacceptable.
- **`everysec`** — the default: buffer writes and fsync once per second in a background thread. A crash loses at most about one second of writes. This is the sweet spot almost everyone uses when they use AOF at all — near-memory write speed with a tightly bounded loss window.
- **`no`** — never explicitly fsync; let the OS flush on its own schedule (often ~30 s). Fastest, but a crash can lose whatever the OS hadn't flushed.

The AOF grows forever if left alone — a key `SET` a thousand times logs a thousand commands for one final value. So Redis periodically **rewrites** it: it produces a new, minimal AOF containing only the commands needed to recreate the current dataset, then swaps it in. The rewrite, like `BGSAVE`, forks a child and so shares the same fork cost. AOF's virtues are durability (a bounded, small loss window) and that the log is human-readable and even repairable. Its costs are a larger file than RDB, slower restarts (replaying a log is slower than loading a dump), and continuous write I/O.

One subtlety worth internalising: neither mechanism sits *between* the client and the command. Command execution — the atomic mutation on the single thread — happens first; persistence records the effect afterwards, out of band. RDB records it via the forked child's snapshot; AOF records it by appending to a buffer that's fsync'd per the policy. That's why persistence never breaks Redis's atomicity guarantees and why, when it hurts, it hurts as a *side* cost (the fork blip, the disk sync) rather than as latency on every command. It's also why a crash can lose recent writes at all: the write succeeded in memory and was acknowledged to the client before it was durably on disk. The size of that gap — one command with `always`, a second with `everysec`, the whole inter-snapshot interval with RDB alone — is precisely your durability window, and choosing it is choosing how much acknowledged-but-not-yet-durable data you're willing to lose.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">RDB snapshot vs AOF log &#8212; two philosophies of durability</text>

  <rect x="24" y="40" width="410" height="210" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="229" y="62" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">RDB &#8212; point-in-time snapshot</text>
  <text x="40" y="84" fill="#1e3a8a" font-size="10">BGSAVE forks a child; copy-on-write freezes a view</text>
  <rect x="40" y="94" width="170" height="30" rx="5" fill="#fff" stroke="#2563eb"/><text x="125" y="114" text-anchor="middle" fill="#1e40af" font-size="9">parent keeps serving</text>
  <rect x="248" y="94" width="146" height="30" rx="5" fill="#bfdbfe" stroke="#2563eb"/><text x="321" y="114" text-anchor="middle" fill="#1e40af" font-size="9">child writes dump.rdb</text>
  <text x="40" y="146" fill="#1e3a8a" font-size="9" font-weight="bold">&#43; compact file, FAST restart (load a dump)</text>
  <text x="40" y="164" fill="#1e3a8a" font-size="9" font-weight="bold">&#43; near-zero steady write cost</text>
  <text x="40" y="186" fill="#b91c1c" font-size="9" font-weight="bold">&#8722; crash loses everything since last snapshot</text>
  <text x="40" y="204" fill="#b91c1c" font-size="9" font-weight="bold">&#8722; fork blip: latency spike on large datasets</text>
  <text x="40" y="222" fill="#b91c1c" font-size="9" font-weight="bold">&#8722; copy-on-write can ~2&#215; memory under write load</text>
  <text x="40" y="242" fill="#1e3a8a" font-size="9">save 900 1 / save 300 100 / save 60 10000</text>

  <rect x="446" y="40" width="410" height="210" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="651" y="62" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">AOF &#8212; append-only command log</text>
  <text x="462" y="84" fill="#14532d" font-size="10">every write appended; replayed on restart</text>
  <rect x="462" y="94" width="378" height="30" rx="5" fill="#fff" stroke="#16a34a"/><text x="651" y="114" text-anchor="middle" fill="#15803d" font-size="9">SET a 1 &#183; INCR a &#183; SET b 2 &#183; DEL c &#183; &#8230; (append)</text>
  <text x="462" y="146" fill="#14532d" font-size="9" font-weight="bold">&#43; best durability: everysec &#8594; &#8804;1s loss window</text>
  <text x="462" y="164" fill="#14532d" font-size="9" font-weight="bold">&#43; log is readable and repairable</text>
  <text x="462" y="186" fill="#b91c1c" font-size="9" font-weight="bold">&#8722; larger file, SLOWER restart (replay a log)</text>
  <text x="462" y="204" fill="#b91c1c" font-size="9" font-weight="bold">&#8722; continuous write I/O; rewrite also forks</text>
  <text x="462" y="226" fill="#14532d" font-size="9">appendfsync: always / everysec / no</text>

  <rect x="24" y="266" width="832" height="184" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="440" y="288" text-anchor="middle" fill="#92400e" font-size="12" font-weight="bold">appendfsync: the durability-vs-throughput dial</text>
  <rect x="44" y="302" width="256" height="130" rx="6" fill="#fff" stroke="#d97706"/>
  <text x="172" y="322" text-anchor="middle" fill="#b45309" font-size="11" font-weight="bold">always</text>
  <text x="58" y="344" fill="#713f12" font-size="9">fsync every write</text>
  <text x="58" y="362" fill="#713f12" font-size="9">loss window: ~1 command</text>
  <text x="58" y="380" fill="#713f12" font-size="9">throughput: LOW (disk on write path)</text>
  <text x="58" y="404" fill="#b45309" font-size="9" font-weight="bold">use: lose-nothing requirements</text>
  <rect x="312" y="302" width="256" height="130" rx="6" fill="#fff" stroke="#16a34a" stroke-width="2"/>
  <text x="440" y="322" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">everysec (default)</text>
  <text x="326" y="344" fill="#14532d" font-size="9">fsync once/sec, background</text>
  <text x="326" y="362" fill="#14532d" font-size="9">loss window: &#8804; ~1 second</text>
  <text x="326" y="380" fill="#14532d" font-size="9">throughput: near memory speed</text>
  <text x="326" y="404" fill="#15803d" font-size="9" font-weight="bold">use: the sensible default</text>
  <rect x="580" y="302" width="256" height="130" rx="6" fill="#fff" stroke="#d97706"/>
  <text x="708" y="322" text-anchor="middle" fill="#b45309" font-size="11" font-weight="bold">no</text>
  <text x="594" y="344" fill="#713f12" font-size="9">OS flushes on its schedule</text>
  <text x="594" y="362" fill="#713f12" font-size="9">loss window: seconds (~30s)</text>
  <text x="594" y="380" fill="#713f12" font-size="9">throughput: HIGHEST</text>
  <text x="594" y="404" fill="#b45309" font-size="9" font-weight="bold">use: rarely; you tolerate loss</text>
</svg>
```

### The hybrid, and why a pure cache turns it all off

You don't have to choose exclusively. Running **both** RDB and AOF gives you AOF's fine-grained durability for point-in-time recovery plus RDB's fast snapshot for other uses, and on restart Redis prefers the AOF because it's more complete. Better still is the **hybrid AOF** (`aof-use-rdb-preamble yes`, the default in modern Redis): when the AOF is rewritten, its head is written in compact RDB format (a snapshot) and only the writes *since* that rewrite are appended as AOF commands. You get the fast-loading compactness of RDB for the bulk of the data and the fine-grained durability of AOF for the recent tail — the best of both, and the recommended durable configuration.

Now the caching point, which inverts everything above. A **pure cache** holds a *disposable copy* of data whose source of truth lives elsewhere — a relational database, a service, an object store. If the cache is lost, you refetch from the origin; nothing is destroyed. In that world, persistence buys durability you fundamentally don't need, and it isn't free: RDB imposes the periodic fork blip and copy-on-write memory pressure, and AOF imposes continuous write I/O and the fsync cost on the write path. So the default, correct configuration for a pure cache is to **disable both** — no `save` points, `appendonly no` — treating Redis as the ephemeral accelerator it is. This is exactly the "Redis as a cache vs Redis as a database" distinction: the database wants durability, the cache wants speed and simplicity and is happy to be empty after a restart.

The one legitimate reason a *cache* keeps persistence is the **warm restart**. A large cache that restarts cold starts empty, and every request is a miss that falls through to the origin all at once — a thundering herd that can overwhelm the database precisely when the cache is least able to help. Keeping a periodic RDB snapshot means a restarted cache reloads its working set from disk and comes back *warm*, absorbing traffic immediately instead of stampeding the origin. Note the asymmetry: for this purpose you want **RDB, not AOF** — you don't care about losing the last second of cache writes (they're reconstructible), you only want a recent bulk snapshot to avoid a cold start, and RDB gives that with a fast load and no continuous write cost. So the caching rule is: pure cache with a tolerant origin → persistence off; large cache where a cold restart would stampede the origin → a light RDB for warm restarts, AOF still off.

## 4. Architecture & Workflow

How a `BGSAVE` and an AOF write flow through the process:

1. **RDB `BGSAVE`.** Redis calls `fork()`. The kernel creates a child sharing the parent's memory via copy-on-write. The parent returns to serving commands immediately; the child walks memory and streams it to a temporary `.rdb` file, then atomically renames it into place. As the parent mutates data during the save, the OS copies the touched pages so the child's snapshot stays consistent. Cost: the fork's page-table setup (a latency blip, larger for bigger datasets) and the copied pages (extra memory).
2. **RDB restart.** On startup Redis loads the `.rdb` file directly into memory — fast, because it's a compact dump, not a replay.
3. **AOF write.** Each write command, after executing, is appended to the AOF buffer. Depending on `appendfsync`, the buffer is fsync'd every write (`always`), once a second by a background thread (`everysec`), or left to the OS (`no`).
4. **AOF rewrite.** When the AOF grows past a threshold (`auto-aof-rewrite-percentage`/`-min-size`), Redis forks a child that writes a minimal AOF (an RDB preamble plus recent commands if the hybrid is on), while the parent keeps appending new writes to a buffer that's merged in at the end. Same fork cost as `BGSAVE`.
5. **AOF restart.** Redis replays the AOF from the start (loading the RDB preamble fast, then applying the tail commands) to rebuild state — slower than an RDB load but more complete.
6. **Pure-cache path.** With `save ""` and `appendonly no`, none of the above runs: no fork, no disk I/O, no restart reload. The instance is a pure in-memory accelerator, cold after any restart.

```svg
<svg viewBox="0 0 880 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="f1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#64748b"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Choosing persistence: is this a cache or a store of record?</text>

  <rect x="330" y="40" width="220" height="40" rx="8" fill="#f1f5f9" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="58" text-anchor="middle" fill="#334155" font-size="11" font-weight="bold">Can you refetch the data</text>
  <text x="440" y="73" text-anchor="middle" fill="#334155" font-size="11" font-weight="bold">from an origin if lost?</text>

  <path d="M330,70 L180,110" stroke="#64748b" stroke-width="1.5" fill="none" marker-end="url(#f1)"/>
  <text x="230" y="96" fill="#15803d" font-size="10" font-weight="bold">YES &#8212; pure cache</text>
  <path d="M550,70 L700,110" stroke="#64748b" stroke-width="1.5" fill="none" marker-end="url(#f1)"/>
  <text x="590" y="96" fill="#b91c1c" font-size="10" font-weight="bold">NO &#8212; store of record</text>

  <rect x="40" y="112" width="300" height="150" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="190" y="134" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">Cache &#8594; usually persistence OFF</text>
  <text x="56" y="156" fill="#14532d" font-size="9">save ""            (no RDB)</text>
  <text x="56" y="174" fill="#14532d" font-size="9">appendonly no      (no AOF)</text>
  <text x="56" y="196" fill="#14532d" font-size="9">&#8226; no fork blip, no disk I/O</text>
  <text x="56" y="214" fill="#14532d" font-size="9">&#8226; cold after restart (that's fine)</text>
  <text x="56" y="236" fill="#b45309" font-size="9" font-weight="bold">exception: large cache whose cold restart</text>
  <text x="56" y="252" fill="#b45309" font-size="9" font-weight="bold">would stampede the origin &#8594; light RDB</text>

  <rect x="540" y="112" width="300" height="150" rx="8" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="690" y="134" text-anchor="middle" fill="#b91c1c" font-size="11" font-weight="bold">Store of record &#8594; persistence ON</text>
  <text x="556" y="156" fill="#7f1d1d" font-size="9">appendonly yes</text>
  <text x="556" y="174" fill="#7f1d1d" font-size="9">appendfsync everysec</text>
  <text x="556" y="192" fill="#7f1d1d" font-size="9">aof-use-rdb-preamble yes  (hybrid)</text>
  <text x="556" y="210" fill="#7f1d1d" font-size="9">save 900 1 / 300 100 / 60 10000</text>
  <text x="556" y="232" fill="#7f1d1d" font-size="9">&#8226; &#8804;1s loss window, fast-loading preamble</text>
  <text x="556" y="250" fill="#7f1d1d" font-size="9">&#8226; accept fork + write I/O costs</text>

  <rect x="40" y="286" width="800" height="128" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="440" y="308" text-anchor="middle" fill="#92400e" font-size="12" font-weight="bold">The fork hazard (applies whenever RDB save or AOF rewrite runs)</text>
  <text x="56" y="330" fill="#713f12" font-size="10">&#8226; fork() sets up the child's page tables &#8594; a latency blip on the single thread, WORSE the larger the dataset.</text>
  <text x="56" y="350" fill="#713f12" font-size="10">&#8226; copy-on-write copies pages the parent writes during the save &#8594; memory can approach 2&#215; under heavy write load (OOM risk).</text>
  <text x="56" y="370" fill="#713f12" font-size="10">&#8226; mitigations: schedule saves off-peak, size RAM with headroom, disable transparent huge pages (THP makes CoW copies huge).</text>
  <text x="56" y="392" fill="#92400e" font-size="10" font-weight="bold">&#8226; for a pure cache the cleanest mitigation is simply: don't persist &#8212; there is no fork if there is no save.</text>
</svg>
```

## 5. Implementation

Persistence is configured, not coded, so the primary artefacts are `redis.conf` snippets and `redis-cli` operations — with a small Go example that treats a restarted cache as possibly cold, which is the application-side consequence of the pure-cache choice.

```conf
# ============================================================================
# redis.conf — PROFILE A: PURE CACHE (persistence OFF). The recommended default
# when Redis holds a disposable copy of data whose source of truth is elsewhere.
# ============================================================================

# Disable RDB snapshots entirely. An empty save directive removes all save
# points, so no BGSAVE ever runs on its own — no fork blip, no copy-on-write
# memory pressure, no .rdb writes. (You can still snapshot manually if needed.)
save ""

# Disable the append-only log. No per-write disk I/O, no fsync on the write
# path, no AOF rewrite forks. The instance is a pure in-memory accelerator.
appendonly no

# A pure cache is memory-bounded and must evict, not persist, under pressure.
# Set a memory ceiling and an eviction policy so it behaves like a cache, not
# a store that OOMs. (Covered fully in the eviction chapter.)
maxmemory 8gb
maxmemory-policy allkeys-lru

# ============================================================================
# redis.conf — PROFILE B: DURABLE STORE (persistence ON, hybrid). Use when the
# data is NOT reconstructible and you need to survive a restart with ~1s loss.
# ============================================================================

# RDB save points: snapshot if >=1 key changed in 900s, >=100 in 300s,
# >=10000 in 60s. Heavier write rates trigger more frequent snapshots.
# save 900 1
# save 300 100
# save 60 10000

# Enable AOF for fine-grained durability.
# appendonly yes

# everysec: fsync once per second in a background thread. At most ~1s of writes
# lost on a crash, at near-memory throughput. The right default for most durable
# setups. Use `always` only if losing even one write is unacceptable (it is far
# slower); `no` only if you tolerate seconds of loss for maximum speed.
# appendfsync everysec

# Hybrid: on AOF rewrite, write an RDB-format snapshot as the file's head and
# append only subsequent commands. Fast to load (RDB preamble) AND fine-grained
# (AOF tail). This is the recommended durable configuration.
# aof-use-rdb-preamble yes

# Auto-rewrite the AOF when it doubles in size (and is at least 64mb), so the
# log doesn't grow unbounded. The rewrite forks a child, same cost as BGSAVE.
# auto-aof-rewrite-percentage 100
# auto-aof-rewrite-min-size 64mb

# ============================================================================
# redis.conf — PROFILE C: WARM-RESTART CACHE. A pure cache large enough that a
# COLD restart would stampede the origin. Keep a LIGHT RDB (for warm reloads),
# but leave AOF OFF — you don't need per-write durability, only a bulk snapshot.
# ============================================================================

# Infrequent snapshots: enough to reload a warm working set on restart, not so
# frequent that the fork blip hurts. AOF stays off — losing the last snapshot's
# worth of cache entries is harmless; they're reconstructible from the origin.
# save 300 100000
# appendonly no
```

```bash
# --- Operating persistence from redis-cli ---

# Trigger a background snapshot (forks a child; never use blocking SAVE in prod).
redis-cli BGSAVE

# When did the last successful save finish? (Unix timestamp.) Monitor this to
# confirm saves are actually completing and not silently failing.
redis-cli LASTSAVE

# Rewrite/compact the AOF now (forks a child, same cost as BGSAVE).
redis-cli BGREWRITEAOF

# Inspect persistence state: rdb_last_bgsave_status, aof_last_bgrewrite_status,
# rdb_changes_since_last_save, aof_last_write_status, and whether a save/rewrite
# is currently in progress — the first stop when diagnosing a fork-latency blip.
redis-cli INFO persistence

# Flip a running pure cache to durable WITHOUT a restart (persisted with
# CONFIG REWRITE so it survives one). Do the reverse (appendonly no, save "")
# to turn a durable instance into a pure cache.
redis-cli CONFIG SET appendonly yes
redis-cli CONFIG SET appendfsync everysec
redis-cli CONFIG REWRITE
```

```go
package cacheclient

import (
	"context"
	"errors"

	"github.com/redis/go-redis/v9"
)

// GetOrLoad treats the cache as possibly COLD — the direct application-side
// consequence of running a pure cache with persistence OFF. After any restart
// the cache is empty, so every read path MUST be able to fall through to the
// origin and repopulate. Code that assumes the cache is always warm will melt
// the origin the moment Redis restarts cold.
func GetOrLoad(
	ctx context.Context,
	rdb *redis.Client,
	key string,
	loadFromOrigin func(ctx context.Context) (string, error),
) (string, error) {
	// Try the cache first.
	val, err := rdb.Get(ctx, key).Result()
	if err == nil {
		return val, nil // warm hit
	}
	if !errors.Is(err, redis.Nil) {
		return "", err // a real Redis error, not just a miss
	}

	// Miss (including "cache is cold after a restart"). Load from the source of
	// truth and repopulate. Because the data is reconstructible, losing the
	// cache on restart costs a burst of misses, not correctness — which is
	// exactly why a pure cache can afford to skip persistence entirely.
	fresh, err := loadFromOrigin(ctx)
	if err != nil {
		return "", err
	}
	// Repopulate with a TTL; the cache warms itself back up as traffic flows.
	if err := rdb.Set(ctx, key, fresh, 0).Err(); err != nil {
		return "", err
	}
	return fresh, nil
}
```

The load-bearing idea: for a pure cache the *config* is `save ""` + `appendonly no`, and the *code* must tolerate a cold start by always being able to reload from the origin. Persistence (Profile B/C) is what you switch on only when the data isn't reconstructible or a cold restart would stampede the origin.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **RDB: fast restarts and cheap steady state.** A compact dump loads quickly and imposes no per-write cost, so an instance comes back fast with minimal ongoing overhead.
- **RDB: good for backups and warm restarts.** A single portable file is easy to copy off-box, and reloads a cache's working set to avoid a cold-start stampede.
- **AOF: strong, tunable durability.** `everysec` bounds loss to ~1 second; `always` to a single command — far better than RDB's between-snapshots gap.
- **Hybrid: best of both.** The RDB preamble loads fast while the AOF tail gives fine-grained durability — the recommended durable setup.
- **Pure cache: none of the cost.** Disabling both removes the fork blip, copy-on-write memory pressure, and write I/O — pure speed for disposable data.

**Disadvantages**
- **RDB: coarse durability.** A crash loses everything since the last snapshot — potentially minutes.
- **Fork hazard (both).** `BGSAVE` and AOF rewrite fork; on a large dataset under write load that's a latency blip and up to ~2× memory from copy-on-write.
- **AOF: bigger files, slower restarts, continuous I/O.** Replaying a log is slower than loading a dump, the file is larger, and there's write amplification.
- **`appendfsync always` is slow.** Syncing every write to disk gives up most of Redis's throughput.
- **Persistence on a pure cache is pure cost.** Durability you don't need in exchange for latency and I/O you can feel.

**Trade-offs**
- *RDB vs AOF:* RDB is fast restart + low steady cost but coarse loss; AOF is fine-grained durability but larger, slower to load, and continuous I/O. Run the hybrid to get both where durability matters.
- *`appendfsync` always vs everysec vs no:* a direct durability-versus-throughput dial — lose ~nothing at low speed, ~1 s at near-full speed (the default), or seconds at max speed. Almost everyone wants `everysec`.
- *Durability vs the fork blip:* more/heavier persistence means more forks and more latency spikes on large datasets. Schedule saves off-peak, size RAM with headroom, and disable transparent huge pages.
- *Persist vs don't (the caching decision):* if the data is a disposable copy, persistence buys nothing and costs latency — turn it off. If a cold restart would stampede the origin, keep a *light RDB only* for warm restarts; still skip AOF.

## 7. Common Mistakes & Best Practices

- **Persisting a pure cache by default.** Paying the fork blip and write I/O for durability you don't need, because the data is reconstructible from the origin. *Best practice:* for a pure cache, `save ""` and `appendonly no`; make the app tolerate a cold start.
- **Using blocking `SAVE` in production.** `SAVE` snapshots on the main thread and freezes every client for the whole dump. *Best practice:* always `BGSAVE` (and let auto save points do it); reserve `SAVE` for offline maintenance.
- **`appendfsync always` without needing it.** Crushing throughput for a durability guarantee the workload doesn't require. *Best practice:* use `everysec` unless losing even one write is genuinely unacceptable.
- **Ignoring the fork's memory cost.** Running an instance near full RAM so a `BGSAVE` under write load OOMs from copy-on-write. *Best practice:* leave RAM headroom, schedule saves off-peak, and disable transparent huge pages.
- **Assuming a restarted cache is warm.** Code that expects the cache to always be populated melts the origin on a cold restart. *Best practice:* every read path must fall through to the origin and repopulate.
- **Forgetting AOF grows unbounded.** Leaving rewrite disabled so the log balloons and restarts crawl. *Best practice:* keep `auto-aof-rewrite-*` enabled and use the RDB preamble hybrid.
- **Cold-restarting a huge cache and stampeding the DB.** A big cache restarting empty sends every request to the origin at once. *Best practice:* keep a light periodic RDB for a warm restart (AOF still off).
- **Not monitoring save/rewrite status.** Silent `BGSAVE` failures (e.g. disk full) mean you have no backup when you think you do. *Best practice:* alert on `rdb_last_bgsave_status`/`aof_last_bgrewrite_status` and `LASTSAVE` age.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** When latency spikes correlate with save points, the culprit is almost always the fork: `INFO persistence` shows whether a `BGSAVE`/rewrite is in progress, `latest_fork_usec` (how long the last fork took — this *is* the blip), and `rdb_changes_since_last_save`. `INFO stats` `mem_fragmentation_ratio` and OS-level copy-on-write metrics reveal the memory amplification. `LATENCY DOCTOR` explicitly calls out fork-induced latency events.
- **Monitoring.** Track `rdb_last_bgsave_status` and `aof_last_bgrewrite_status` (must be `ok`), the age of `LASTSAVE` (a stale value means saves are failing), `latest_fork_usec` (rising fork time predicts worse blips as the dataset grows), AOF file size and rewrite frequency, and disk space (a full disk fails saves and, with AOF, can stall writes). For a pure cache, confirm persistence is genuinely off so you aren't paying for it unknowingly.
- **Security.** The `.rdb`/`.aof` files are a full plaintext copy of the dataset on disk — protect the data directory's permissions and encrypt the volume, because an attacker who reads those files reads all your data. Backups copied off-box inherit that sensitivity. `CONFIG SET dir`/`dbfilename` have historically been abused (writing an RDB to an arbitrary path) on unauthenticated instances, so lock down `CONFIG` and require auth. For a pure cache, having *no* persistence files is one fewer sensitive artefact to protect.
- **Scaling.** The fork cost scales with dataset size, so very large instances feel bigger save/rewrite blips — a reason to shard across a cluster (many smaller instances each forking a smaller dataset) rather than one giant node. In a replicated setup you can offload persistence to a *replica* (let replicas do the `BGSAVE` and keep the master fork-free), a common pattern for durable Redis. For a pure cache at scale, the clean approach is no persistence plus enough replicas/cluster capacity that losing and cold-starting one node is absorbed by the others and the origin.

## 9. Interview Questions

**Q: What's the difference between RDB and AOF?**
A: RDB is a point-in-time snapshot: periodically (or on `BGSAVE`) Redis forks a child that dumps the whole dataset to a compact binary file. It restarts fast and costs almost nothing in steady state, but a crash loses everything written since the last snapshot. AOF is an append-only log: every write command is appended to a file and replayed on startup to rebuild state. It gives much finer durability — with `appendfsync everysec` you lose at most about a second — but the file is larger, restarts are slower (replaying a log versus loading a dump), and there's continuous write I/O. You can run either, both, or neither, and the modern hybrid writes an RDB preamble at the head of the AOF to get fast loading plus fine-grained durability.

**Q: What does `appendfsync everysec` mean and why is it the default?**
A: It controls how often the AOF is fsync'd to disk. `everysec` buffers writes and fsyncs once per second in a background thread, so a crash loses at most about one second of writes while the write path stays at near-memory speed. It's the default because it's the sweet spot: `always` fsyncs every command for near-zero loss but crushes throughput with a disk sync on every write, and `no` leaves flushing to the OS (fastest, but seconds of possible loss). For almost everyone, a bounded ~1-second loss window at full speed is the right trade.

**Q: How does `BGSAVE` avoid blocking the server, and what does it still cost?**
A: It forks a child process. The child inherits a copy-on-write view of the parent's memory and writes that frozen snapshot to disk while the parent keeps serving commands; the OS copies only the pages the parent modifies during the save, so there's no stop-the-world memory copy. What it still costs is the `fork()` itself — the kernel sets up the child's page tables, which on a large dataset takes hundreds of milliseconds and blocks the single thread for that moment (the "fork blip") — plus the copied pages, which under heavy write load can push memory toward double the dataset. That's why save-point latency spikes correlate with dataset size and write rate.

**Q: Why would a pure cache disable persistence entirely?**
A: Because a pure cache holds a disposable copy of data whose source of truth is elsewhere. If the cache is lost, you refetch from the origin — nothing is destroyed. Persistence would buy durability you don't need while charging real costs: RDB's periodic fork blip and copy-on-write memory pressure, and AOF's continuous write I/O and fsync on the write path. So the correct default for a pure cache is `save ""` and `appendonly no`, treating Redis as the ephemeral accelerator it is and accepting that it's empty after a restart — provided the application can fall through to the origin and repopulate.

**Q: What is the hybrid AOF (`aof-use-rdb-preamble`)?**
A: It's the best-of-both durable configuration. When the AOF is rewritten, Redis writes the head of the file in compact RDB (snapshot) format and appends only the write commands since that rewrite as AOF entries. On restart it loads the RDB preamble quickly (fast, like an RDB load) and then applies the small AOF tail (fine-grained, like AOF). You get RDB's fast, compact loading for the bulk of the data and AOF's ~1-second durability for the recent tail. It's the default in modern Redis and the recommended setup when you actually need durability.

**Q: Why is the AOF rewrite necessary, and what does it cost?**
A: The AOF appends every write command as it happens, so left alone it grows without bound — a key `SET` a thousand times logs a thousand commands even though only the final value matters, and restarts get slower as the log balloons. The rewrite fixes this by producing a new, minimal AOF that contains only the commands needed to reproduce the current dataset (with the hybrid, an RDB preamble plus the recent tail), then atomically swapping it in. It's triggered automatically by `auto-aof-rewrite-percentage`/`-min-size` (e.g. when the file has doubled and is at least 64 MB). The cost is that the rewrite, like `BGSAVE`, forks a child process — so it carries the same fork blip and copy-on-write memory amplification, meaning even AOF has a periodic fork cost, not just RDB.

**Q: Is `SAVE` ever safe to use instead of `BGSAVE`?**
A: Almost never in production. `SAVE` performs the snapshot synchronously on the main thread, which freezes every client for the entire duration of the dump — seconds or more on a sizeable dataset — because Redis is single-threaded and the save monopolises that one thread. `BGSAVE` instead forks a child that snapshots in the background while the parent keeps serving, paying only the brief fork blip. The only legitimate uses for `SAVE` are offline or maintenance situations — a controlled shutdown where you want a final dump and no clients are connected, or a scripted one-off where blocking is acceptable. For any live instance, always `BGSAVE` (and normally you just let the configured `save` points trigger it automatically).

**Q: (Senior) You run a large cache. Argue both sides of keeping RDB on.**
A: Against persistence: the cache is a disposable copy of an origin, so durability buys nothing — losing the cache costs a burst of misses, not data. And it isn't free. On a large dataset the `BGSAVE` fork blocks the single thread for the page-table setup (hundreds of milliseconds — a visible latency spike every client feels), and under write load copy-on-write can push memory toward 2×, risking OOM on a tight instance. For a pure cache that's all cost and no benefit, so the clean answer is `save ""`, `appendonly no`. For persistence: the counter-argument is the warm restart. A large cache that restarts *cold* starts empty, and every request becomes a miss falling through to the origin simultaneously — a thundering herd that can overwhelm the database exactly when the cache can't help. A periodic RDB lets the restarted cache reload its working set from disk and come back warm, absorbing traffic immediately. Crucially this argues for RDB, not AOF: you don't care about losing the last second of cache writes (reconstructible), only about avoiding a cold start, and RDB gives a fast-loading bulk snapshot without continuous write cost. So I'd resolve it by workload: if the origin comfortably absorbs a cold cache filling up, persistence off; if a cold restart would stampede the origin, a *light* RDB (infrequent save points) for warm restarts, AOF still off. I'd also mitigate the fork blip regardless — off-peak saves, RAM headroom, transparent huge pages disabled, or offloading the save to a replica.

**Q: (Senior) An instance shows periodic latency spikes every few minutes. How do you tie them to persistence and fix it?**
A: Periodic, evenly-spaced spikes that hit all clients at once are the signature of the fork on a save or AOF rewrite. I'd line the spike timestamps up against the save points and check `INFO persistence`: `latest_fork_usec` tells me how long the last fork took (that duration *is* the blip), `rdb_bgsave_in_progress`/`aof_rewrite_in_progress` tell me whether a save was running at the spike, and the save-point config (or `auto-aof-rewrite-*`) tells me the cadence. `LATENCY HISTORY fork` and `LATENCY DOCTOR` confirm fork-induced events specifically. Once confirmed, the fixes depend on what the instance is. If it's a pure cache, the cleanest fix is to stop persisting — no save, no fork, no blip. If it genuinely needs durability, I reduce the fork's pain rather than its frequency: disable transparent huge pages (THP inflates copy-on-write page copies and is a well-known cause of fork latency), ensure enough free RAM so copy-on-write doesn't push into swap, schedule heavy snapshots off-peak, and consider offloading persistence to a replica so the master never forks. If the dataset has simply grown too large for an acceptable fork time, that's a signal to shard across a cluster so each node forks a smaller dataset. The through-line: the spike is the fork, and the biggest lever is whether this instance needs to be forking at all.

**Q: (Senior) Walk through what actually happens on restart for RDB-only, AOF-only, and a pure cache, and why it matters.**
A: RDB-only: on restart Redis loads the `.rdb` file directly into memory — fast, because it's a compact dump — and the dataset is whatever existed at the last snapshot, so anything written since is gone. This is quick to recover but has a coarse loss window. AOF-only: Redis replays the append-only log from the beginning, reconstructing state command by command (with the hybrid, it loads the RDB preamble fast and then applies the tail). This recovers to within your fsync window — about a second with `everysec` — but the replay is slower than an RDB load, more so as the log grows, which is why keeping rewrite enabled matters. Pure cache (both off): there's nothing to load, so Redis starts *empty* — a cold cache. Every early request misses and falls through to the origin until the cache warms. Why it matters: the restart behaviour dictates the application's obligations and the origin's exposure. With persistence, recovery is largely transparent and the origin isn't hit hard. Without it, the app must tolerate a cold start (every read path able to reload from the origin), and a large cold cache can stampede the database — which is precisely the scenario where you might keep a light RDB purely for warm restarts even though you don't otherwise need durability. So "what happens on restart" isn't an operational footnote; it's the thing that decides whether you persist a cache at all.

## 10. Quick Revision & Cheat Sheet

| | RDB | AOF |
|---|---|---|
| Model | Point-in-time snapshot | Append-only command log |
| Durability | Coarse (loses since last save) | Fine (`everysec` → ~1 s) |
| Restart speed | Fast (load a dump) | Slower (replay a log) |
| File size | Compact | Larger |
| Steady cost | Low (periodic fork) | Continuous write I/O |
| Fork blip | Yes (on `BGSAVE`) | Yes (on rewrite) |

| Setting | Effect |
|---|---|
| `save ""` | Disable RDB entirely (pure cache) |
| `appendonly no` | Disable AOF entirely (pure cache) |
| `appendfsync always/everysec/no` | fsync every write / once a sec / OS-decides |
| `aof-use-rdb-preamble yes` | Hybrid: RDB head + AOF tail |
| `auto-aof-rewrite-percentage/-min-size` | When to compact the AOF |

**Flash cards**
- **RDB is?** → Snapshot via fork + copy-on-write; fast restart, coarse loss.
- **AOF is?** → Command log replayed on restart; fine durability, slower restart.
- **`appendfsync everysec`?** → fsync once/sec; ≤1 s loss at near-memory speed — the default.
- **Fork hazard?** → `BGSAVE`/rewrite fork blocks the thread briefly and can ~2× memory under write load.
- **Pure cache persistence?** → Off (`save ""`, `appendonly no`) — data is a disposable copy.
- **Why ever persist a cache?** → Warm restart: a light RDB avoids a cold-start stampede on the origin.
- **`SAVE` vs `BGSAVE`?** → `SAVE` blocks the main thread; always `BGSAVE` (forks) in production.
- **Which files hold your data on disk?** → `.rdb` / `.aof` — a full plaintext copy; protect and encrypt them.

## 11. Hands-On Exercises & Mini Project

- [ ] Configure `save ""` + `appendonly no`, restart, and confirm the instance comes back empty; then load data, `BGSAVE`, restart, and confirm it reloads.
- [ ] Offload persistence to a replica: enable saves only on the replica, keep the master fork-free, and verify durability is still preserved.
- [ ] Enable AOF with `everysec`, kill Redis mid-writes, restart, and measure how much data was lost versus RDB-only.
- [ ] Load several GB, run `BGSAVE` under a write load, and chart the latency spike; read `latest_fork_usec` from `INFO persistence`.
- [ ] Compare restart time for RDB-only versus AOF-only on the same dataset, and explain the difference.
- [ ] Turn on the hybrid (`aof-use-rdb-preamble yes`), trigger a rewrite, and inspect that the AOF starts with an RDB preamble.
- [ ] Flip a running instance between pure-cache and durable configs with `CONFIG SET` + `CONFIG REWRITE`, with no restart.
- [ ] Fill the disk so a `BGSAVE` fails, then read `rdb_last_bgsave_status` from `INFO persistence` and confirm you'd have caught it with monitoring.
- [ ] Write the same key a thousand times, watch the AOF grow, then `BGREWRITEAOF` and observe it shrink to a single command.

### Mini Project — "Persistence Trade-off Lab"

**Goal.** Make the durability-versus-cost trade measurable so the pure-cache decision is grounded in numbers, not folklore.

**Requirements.**
1. Stand up three configs on the same dataset: pure cache (both off), RDB-only, and hybrid AOF.
2. Under a steady write load, measure and compare: p99 latency (watch for fork blips), memory usage during saves (copy-on-write amplification), and throughput.
3. Crash each config mid-writes and measure the data-loss window on restart.
4. Measure restart time for each and correlate it with file size and format.
5. Simulate a cold restart of a large cache and measure the miss burst hitting a mock origin; then add a light RDB and show the warm restart absorbing traffic instead.

**Extensions.**
- Offload persistence to a replica and show the master's fork blip disappearing while durability is preserved.
- Disable transparent huge pages and re-measure `latest_fork_usec` to quantify THP's effect on fork latency.
- Chart data-loss window against `appendfsync` (`always` vs `everysec` vs `no`) alongside the throughput each sustains.
- Grow the dataset across three orders of magnitude and plot `latest_fork_usec` against it, quantifying how the fork blip scales with size (and why sharding helps).

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Redis as a Cache* (persistence is out of band from the atomic single thread), *Memory, maxmemory & Eviction* (a cache evicts rather than persists under pressure), *Cache Stampede & the Thundering Herd* (why a cold restart of a large cache is dangerous), *Replication & Sentinel* (offloading persistence to a replica; failover and durability), *Redis Cluster* (sharding shrinks each node's fork cost).

- **Redis — Persistence (RDB, AOF, hybrid)** — Redis · *Intermediate* · the authoritative guide to both mechanisms, the fsync policies, and the hybrid preamble. <https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/>
- **Redis — BGSAVE / BGREWRITEAOF / LASTSAVE commands** — Redis · *Beginner* · the command reference for triggering and checking snapshots and AOF rewrites by hand. <https://redis.io/docs/latest/commands/bgsave/>
- **Redis — Configuration & redis.conf reference** — Redis · *Intermediate* · every `save`, `appendonly`, `appendfsync`, and rewrite directive with its meaning. <https://redis.io/docs/latest/operate/oss_and_stack/management/config/>
- **Redis — Demystifying persistence & the fork cost** — Redis · *Advanced* · how copy-on-write and the fork produce latency and memory spikes, and how to mitigate them. <https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency/>
- **Redis — Latency troubleshooting (fork, THP)** — Redis · *Advanced* · diagnosing fork-induced latency and why transparent huge pages make it worse. <https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency/>
- **Redis — INFO persistence fields** — Redis · *Intermediate* · `latest_fork_usec`, `rdb_last_bgsave_status`, `aof_last_bgrewrite_status` and the rest of the monitoring surface. <https://redis.io/docs/latest/commands/info/>
- **AWS ElastiCache — snapshots & backup for Redis** — AWS · *Intermediate* · how a managed service exposes RDB snapshots and warm restores, a practical view of the trade. <https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/backups.html>
- **Redis University — RU301: Running Redis at Scale** — Redis · *Advanced* · free course covering persistence, replication and the operational trade-offs together. <https://university.redis.com/>
- **antirez — Redis persistence demystified** — Salvatore Sanfilippo · *Advanced* · the creator's own essay on why RDB and AOF work the way they do and the fork trade-off. <http://oldblog.antirez.com/post/redis-persistence-demystified.html>

---

*Caching with Redis Handbook — chapter 24.*
