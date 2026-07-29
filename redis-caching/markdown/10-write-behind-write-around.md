# 10 · Write-Behind (Write-Back) & Write-Around

> **In one line:** Write-behind buys write latency and store throughput by acknowledging a write the moment it is in the cache and flushing to the store later in coalesced batches — a trade you pay for in a real window of possible data loss; write-around does the opposite, skipping the cache on writes so write-once-read-rarely data never pollutes it.

---

## 1. Overview

Cache-aside and write-through (chapters 08–09) both treat the store as the thing a write must reach before the write is "done" — cache-aside updates the store then invalidates the cache, write-through updates both synchronously. Two patterns break that assumption in opposite directions, and both exist to serve workloads those defaults serve badly.

**Write-behind** (also called **write-back**) inverts the write path: a write updates the *cache* and returns immediately, and the store is updated *later*, asynchronously, by a background flush that batches and coalesces many writes into few store operations. The write is acknowledged at cache speed, not store speed, and a burst of updates to the same key collapses into a single store write. This is the pattern for write-heavy workloads where store write throughput is the bottleneck and you can tolerate a small, bounded window in which acknowledged writes are not yet durable in the store. That window is the whole cost, and it is a genuine one: if the cache dies before the flush, those writes are gone.

**Write-around** goes the other way: a write bypasses the cache entirely and goes straight to the store, and the cache is only ever populated later by reads (lazy loading). It exists for the opposite workload — data that is written once and read rarely or never, where caching it on write would evict genuinely hot data to make room for cold data nobody will ask for. Logs, audit records, and bulk imports are the classic fits: write them to the store, leave the cache alone, and let the rare reader populate the cache on demand if it ever comes.

These two patterns are not rivals; they answer different questions. Write-behind asks "how do I make writes fast and cheap on the store when there are a lot of them?" and answers with async batching at the cost of durability. Write-around asks "how do I stop write-heavy, read-cold data from polluting my cache?" and answers by not caching it on write at all. This chapter builds both, names their risks precisely, and gives you a production-shaped write-behind buffer in Go — the harder of the two to get right.

## 2. Core Concepts

- **Write-behind (write-back)** — a write updates the cache and returns; the store is updated asynchronously by a background flusher.
- **Asynchronous flush** — the background process that drains buffered writes to the store, decoupled from the write's acknowledgement.
- **Coalescing** — multiple writes to the same key collapsing into a single store write (the last value wins), cutting store operations.
- **Batching** — grouping many keys' writes into one bulk store operation to amortise per-write overhead.
- **Durability window** — the interval between acknowledging a write and it being persisted in the store; data in this window is lost if the cache dies.
- **Dirty set** — the set of keys written to the cache but not yet flushed to the store; the flusher's work list.
- **Write-around** — a write goes straight to the store and bypasses the cache; the cache is populated only by later reads.
- **Cache pollution** — filling the cache with data that will not be read, evicting genuinely useful entries; what write-around avoids.
- **Flush trigger** — what causes a flush: a time interval, a batch-size threshold, or a shutdown/backpressure signal.
- **Backpressure** — slowing or blocking writers when the buffer grows faster than the flusher can drain it, to bound memory and loss.

## 3. Theory & Principles

### Write-behind: decoupling acknowledgement from durability

The core idea of write-behind is to *decouple when a write is acknowledged from when it is durable*. A write updates the cache, marks the key dirty, and returns — the caller sees a fast acknowledgement at cache latency. A separate background flusher periodically (or when a batch fills) reads the dirty keys, writes them to the store in bulk, and clears them from the dirty set. Because acknowledgement no longer waits for the store, write latency drops to cache latency and the store sees far fewer, larger operations.

Two mechanisms make this a big win for write-heavy workloads. **Coalescing**: if a key is written ten times before the next flush, only its final value needs to reach the store, so ten writes become one — a 10× reduction in store operations for hot keys. **Batching**: instead of one store round trip per key, the flusher writes many keys in a single bulk operation, amortising connection and transaction overhead. A counter incremented thousands of times per second, a "last seen" timestamp updated on every request, a view-count that only needs to be roughly right in the store — these are transformed from a store-throughput problem into a cache-throughput problem, which Redis handles trivially.

The price is **durability**. Between the moment a write is acknowledged and the moment the flusher persists it, the write exists *only* in the cache. If the Redis instance holding it dies — a crash, an eviction, a failover that loses the un-replicated tail — those acknowledged-but-unflushed writes are lost, and the caller was already told they succeeded. This is not a bug you can engineer away; it is the fundamental trade of the pattern. You can *shrink* the window (flush more often), *bound the loss* (cap the buffer, use replication or AOF on the buffer), and *choose the data carefully* (only use write-behind where a small amount of lost or slightly-stale data is acceptable), but you cannot make an asynchronous flush durable without making it synchronous, at which point it is write-through. The discipline is to use write-behind *only* for data where the durability window is an acceptable risk — analytics counters, telemetry, non-critical denormalised fields — and never for data whose loss is a correctness or money problem.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="wb1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
    <marker id="wb2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#d97706"/></marker>
    <marker id="wb3" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Write-behind: fast ack now, coalesced batched flush later (with a loss window)</text>

  <rect x="24" y="42" width="140" height="150" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="94" y="64" text-anchor="middle" fill="#166534" font-size="11" font-weight="bold">Writers</text>
  <text x="40" y="88" fill="#166534" font-size="9">SET k1=A</text>
  <text x="40" y="106" fill="#166534" font-size="9">SET k1=B</text>
  <text x="40" y="124" fill="#166534" font-size="9">SET k1=C</text>
  <text x="40" y="142" fill="#166534" font-size="9">SET k2=X</text>
  <text x="40" y="160" fill="#166534" font-size="9">INCR k3 x900</text>
  <text x="40" y="182" fill="#15803d" font-size="8" font-weight="bold">ack at cache speed</text>

  <path d="M164,110 L214,110" stroke="#16a34a" stroke-width="2" marker-end="url(#wb1)"/>

  <rect x="216" y="42" width="230" height="200" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="331" y="64" text-anchor="middle" fill="#92400e" font-size="11" font-weight="bold">Cache + dirty set (buffer)</text>
  <rect x="236" y="80" width="190" height="30" rx="5" fill="#fff" stroke="#d97706"/><text x="331" y="100" text-anchor="middle" fill="#92400e" font-size="9">k1 = C  (A,B coalesced away)</text>
  <rect x="236" y="116" width="190" height="30" rx="5" fill="#fff" stroke="#d97706"/><text x="331" y="136" text-anchor="middle" fill="#92400e" font-size="9">k2 = X</text>
  <rect x="236" y="152" width="190" height="30" rx="5" fill="#fff" stroke="#d97706"/><text x="331" y="172" text-anchor="middle" fill="#92400e" font-size="9">k3 = 900  (900 INCRs &#8594; 1 write)</text>
  <text x="331" y="204" text-anchor="middle" fill="#b45309" font-size="9">dirty = {k1, k2, k3}</text>
  <text x="331" y="224" text-anchor="middle" fill="#b45309" font-size="9">flush on interval OR batch full</text>

  <path d="M446,140 L500,140" stroke="#d97706" stroke-width="2" marker-end="url(#wb2)"/>
  <text x="473" y="132" text-anchor="middle" fill="#b45309" font-size="8">batch</text>

  <rect x="502" y="90" width="150" height="100" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="577" y="112" text-anchor="middle" fill="#1e40af" font-size="11" font-weight="bold">Flusher</text>
  <text x="518" y="134" fill="#1e40af" font-size="9">drain dirty set</text>
  <text x="518" y="150" fill="#1e40af" font-size="9">bulk write to store</text>
  <text x="518" y="166" fill="#1e40af" font-size="9">clear on success</text>
  <text x="518" y="182" fill="#1e40af" font-size="9">retry on failure</text>

  <path d="M652,140 L706,140" stroke="#d97706" stroke-width="2" marker-end="url(#wb2)"/>
  <rect x="708" y="90" width="150" height="100" rx="10" fill="#e0e7ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="783" y="112" text-anchor="middle" fill="#3730a3" font-size="11" font-weight="bold">Store (DB)</text>
  <text x="724" y="140" fill="#3730a3" font-size="9">3 writes total</text>
  <text x="724" y="158" fill="#3730a3" font-size="9">(not 903)</text>
  <text x="724" y="176" fill="#3730a3" font-size="9">huge throughput win</text>

  <rect x="24" y="256" width="834" height="196" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="440" y="278" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">The durability window (the price you pay)</text>
  <line x1="60" y1="330" x2="820" y2="330" stroke="#991b1b" stroke-width="2"/>
  <circle cx="140" cy="330" r="5" fill="#16a34a"/><text x="140" y="316" text-anchor="middle" fill="#166534" font-size="9">write ack'd</text>
  <circle cx="620" cy="330" r="5" fill="#2563eb"/><text x="620" y="316" text-anchor="middle" fill="#1e40af" font-size="9">flushed to store (durable)</text>
  <path d="M140,348 L620,348" stroke="#dc2626" stroke-width="2" marker-end="url(#wb3)"/>
  <text x="380" y="368" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">loss window: if the cache dies here, these acknowledged writes are GONE</text>
  <text x="60" y="398" fill="#991b1b" font-size="10">Shrink it: flush more often. Bound it: cap the buffer, apply backpressure. Protect it: replicate/AOF the buffer.</text>
  <text x="60" y="418" fill="#991b1b" font-size="10">Never eliminate it without going synchronous (which is write-through). Use ONLY where bounded loss is acceptable.</text>
  <text x="60" y="440" fill="#b91c1c" font-size="10" font-weight="bold">Right for: counters, telemetry, "last seen", view counts.   Wrong for: money, orders, anything whose loss is a correctness bug.</text>
</svg>
```

### Write-around: don't cache what won't be read

Write-around is the simplest pattern in this handbook and the easiest to justify. On a write, go straight to the store and *do not touch the cache*. Reads still use cache-aside (or read-through) — they populate the cache lazily on a miss. The point is negative: by not caching on write, you prevent write-heavy, read-cold data from occupying cache memory and evicting genuinely hot entries.

The reasoning is about the eviction budget. A cache has finite memory and an eviction policy (LRU/LFU) that keeps the most useful entries. If you cache everything you write, a burst of write-once-read-rarely data — a bulk import, a log stream, a batch of audit records — floods the cache with entries that will never be read, and the eviction policy dutifully throws out your hot working set to make room for cold garbage. Write-around avoids this by leaving those writes out of the cache entirely; the only way that data ever enters the cache is if something actually reads it, at which point it has earned its place. The trade-off is that if the data *is* read soon after being written, that first read is a guaranteed miss (the value was never cached on write), so write-around is precisely wrong for write-then-immediately-read patterns — which is exactly where write-through's warm-on-write shines. The two are mirror images: write-through caches on write for read-soon data; write-around skips the cache on write for read-rarely data.

## 4. Architecture & Workflow

**Write-behind workflow:**

1. **Write.** The application writes the value to the cache and records the key in a dirty set, then returns immediately — acknowledgement at cache latency.
2. **Coalesce.** Repeated writes to the same key before the next flush overwrite the cached value; only the latest survives, so the store sees one write per key per flush interval regardless of how many times it changed.
3. **Flush trigger.** A flush fires on a timer (every N milliseconds), when the dirty set reaches a batch-size threshold, or on shutdown/backpressure.
4. **Batch flush.** The flusher snapshots the dirty set, reads the current values, writes them to the store in one bulk operation, and — on success — clears those keys from the dirty set. On failure it retries with backoff and does *not* clear them, so no acknowledged write is dropped by a transient store error.
5. **Backpressure & bounds.** If writers outpace the flusher, the dirty set grows; a bounded buffer applies backpressure (block or reject writers) so memory and the loss window stay bounded.
6. **Shutdown.** On graceful shutdown, flush the remaining dirty set synchronously before exiting so the loss window closes to zero for a clean stop (a crash still loses the window — that is the irreducible risk).

**Write-around workflow:**

1. **Write.** Write directly to the store; do not touch the cache.
2. **Optionally invalidate.** If the key *might* be cached from a prior read, delete it so a stale cached value is not served (this makes write-around a cache-*aside*-compatible write that simply skips population).
3. **Read.** Reads use cache-aside/read-through and populate lazily; the first read after a write is a miss by design.

```svg
<svg viewBox="0 0 880 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="wa1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#64748b"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Choosing a write pattern by workload</text>

  <rect x="300" y="40" width="280" height="40" rx="8" fill="#f1f5f9" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="65" text-anchor="middle" fill="#334155" font-weight="bold">What does this write need?</text>

  <path d="M300,60 L150,110" stroke="#64748b" stroke-width="1.5" fill="none" marker-end="url(#wa1)"/>
  <path d="M440,80 L440,110" stroke="#64748b" stroke-width="1.5" marker-end="url(#wa1)"/>
  <path d="M580,60 L730,110" stroke="#64748b" stroke-width="1.5" fill="none" marker-end="url(#wa1)"/>

  <rect x="30" y="112" width="240" height="150" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="150" y="134" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">Write-heavy, loss-tolerant</text>
  <text x="46" y="156" fill="#166534" font-size="9">many writes/sec, same keys</text>
  <text x="46" y="172" fill="#166534" font-size="9">store throughput is the limit</text>
  <text x="46" y="188" fill="#166534" font-size="9">bounded loss acceptable</text>
  <text x="150" y="214" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">&#8594; WRITE-BEHIND</text>
  <text x="46" y="236" fill="#166534" font-size="9">coalesce + batch, async flush</text>
  <text x="46" y="252" fill="#b91c1c" font-size="9">cost: durability window</text>

  <rect x="320" y="112" width="240" height="150" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="440" y="134" text-anchor="middle" fill="#1e40af" font-size="11" font-weight="bold">Read soon after write</text>
  <text x="336" y="156" fill="#1e40af" font-size="9">consistency matters</text>
  <text x="336" y="172" fill="#1e40af" font-size="9">value fetched back quickly</text>
  <text x="336" y="188" fill="#1e40af" font-size="9">can pay write latency</text>
  <text x="440" y="214" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">&#8594; WRITE-THROUGH</text>
  <text x="336" y="236" fill="#1e40af" font-size="9">sync store + cache (ch. 09)</text>
  <text x="336" y="252" fill="#b91c1c" font-size="9">cost: latency per write</text>

  <rect x="610" y="112" width="240" height="150" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="730" y="134" text-anchor="middle" fill="#92400e" font-size="11" font-weight="bold">Write-once, read-rarely</text>
  <text x="626" y="156" fill="#92400e" font-size="9">logs, audit, bulk imports</text>
  <text x="626" y="172" fill="#92400e" font-size="9">rarely (or never) read back</text>
  <text x="626" y="188" fill="#92400e" font-size="9">must not evict hot data</text>
  <text x="730" y="214" text-anchor="middle" fill="#92400e" font-size="12" font-weight="bold">&#8594; WRITE-AROUND</text>
  <text x="626" y="236" fill="#92400e" font-size="9">store only, skip the cache</text>
  <text x="626" y="252" fill="#b45309" font-size="9">cost: first read is a miss</text>

  <rect x="30" y="286" width="820" height="72" rx="8" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="308" text-anchor="middle" fill="#334155" font-size="11" font-weight="bold">The three write patterns are a spectrum of "how much does the store see, and when?"</text>
  <text x="46" y="330" fill="#475569" font-size="10">write-through: store sees every write, now (sync).   write-behind: store sees coalesced writes, later (async).   write-around: store sees the write, cache never does.</text>
  <text x="46" y="348" fill="#475569" font-size="10">Pick by naming the ONE thing the write cares about: consistency (through), throughput/latency with loss-tolerance (behind), or not polluting the cache (around).</text>
</svg>
```

## 5. Implementation

A production-shaped write-behind buffer in Go with `github.com/redis/go-redis/v9`. Writes update Redis and mark keys dirty; a flush loop coalesces and batches dirty keys to the store on a timer or when a batch fills, with retry, backpressure, and a synchronous drain on shutdown. A short write-around helper follows.

```go
package writebehind

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// StoreWriter persists a batch of key/value pairs to the underlying store in ONE
// bulk operation. Returning an error causes the batch to be retried — so it must
// be safe to re-apply (idempotent), because a partial failure may re-send keys.
type StoreWriter func(ctx context.Context, batch map[string]string) error

// Buffer implements write-behind: writes update Redis and are marked dirty, then
// a background loop flushes coalesced, batched writes to the store. It trades
// durability (a crash loses un-flushed writes) for write latency and store
// throughput. Use it ONLY for data where a bounded loss window is acceptable.
type Buffer struct {
	rdb        *redis.Client
	write      StoreWriter
	flushEvery time.Duration
	batchSize  int
	maxDirty   int // backpressure bound: writers block once the dirty set is this big

	mu    sync.Mutex
	dirty map[string]struct{} // keys written but not yet flushed (the work list)
	full  *sync.Cond          // signalled when the buffer drains below maxDirty

	stop chan struct{}
	done chan struct{}
}

func NewBuffer(rdb *redis.Client, w StoreWriter) *Buffer {
	b := &Buffer{
		rdb:        rdb,
		write:      w,
		flushEvery: 200 * time.Millisecond,
		batchSize:  500,
		maxDirty:   50_000,
		dirty:      make(map[string]struct{}),
		stop:       make(chan struct{}),
		done:       make(chan struct{}),
	}
	b.full = sync.NewCond(&b.mu)
	go b.flushLoop()
	return b
}

// Write is the write-behind write: update the cache and mark the key dirty, then
// return. The store is NOT touched here — that happens later in the flush loop.
// Acknowledgement is at cache latency; a burst of writes to the same key
// coalesces because only the latest value survives in Redis by flush time.
func (b *Buffer) Write(ctx context.Context, key, value string) error {
	// 1. Update the cache — this is the authoritative copy until the flush lands.
	// A TTL here must be LONGER than the max flush interval, or a value could
	// expire before it is ever persisted, silently losing the write.
	if err := b.rdb.Set(ctx, key, value, 0).Err(); err != nil {
		return err // cache write failed: surface it; we have not acknowledged.
	}

	// 2. Mark dirty, applying backpressure if the buffer is saturated. Blocking
	// here bounds both memory AND the durability window: we refuse to acknowledge
	// faster than we can eventually flush.
	b.mu.Lock()
	for len(b.dirty) >= b.maxDirty {
		b.full.Wait() // released when a flush drains the set below the bound.
	}
	b.dirty[key] = struct{}{}
	b.mu.Unlock()
	return nil
}

// flushLoop drains the dirty set to the store on a timer or when a batch fills.
func (b *Buffer) flushLoop() {
	defer close(b.done)
	ticker := time.NewTicker(b.flushEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			b.flushOnce()
		case <-b.stop:
			b.flushOnce() // final synchronous drain on shutdown: close the window.
			return
		}
	}
}

// flushOnce snapshots up to batchSize dirty keys, reads their CURRENT values from
// Redis (so coalescing is automatic — we persist only the latest), writes them to
// the store in one batch, and clears them ONLY on success.
func (b *Buffer) flushOnce() {
	// 1. Snapshot a batch of dirty keys under the lock, then release it so writers
	// are not blocked during the (slow) store write.
	b.mu.Lock()
	if len(b.dirty) == 0 {
		b.mu.Unlock()
		return
	}
	keys := make([]string, 0, b.batchSize)
	for k := range b.dirty {
		keys = append(keys, k)
		if len(keys) >= b.batchSize {
			break
		}
	}
	b.mu.Unlock()

	// 2. Read the current values in one round trip (MGET). This is where
	// coalescing happens: no matter how many times a key was written, we read its
	// single latest value.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	vals, err := b.rdb.MGet(ctx, keys...).Result()
	if err != nil {
		log.Printf("write-behind: MGET failed, will retry next tick: %v", err)
		return // keys stay dirty; nothing lost, we retry.
	}
	batch := make(map[string]string, len(keys))
	for i, k := range keys {
		if s, ok := vals[i].(string); ok {
			batch[k] = s
		}
	}

	// 3. Bulk-write to the store. On failure, DO NOT clear the dirty keys — retry
	// next tick so no acknowledged write is dropped by a transient store error.
	if err := b.write(ctx, batch); err != nil {
		log.Printf("write-behind: store flush failed, retrying: %v", err)
		return
	}

	// 4. Success: clear these keys from the dirty set and wake blocked writers.
	b.mu.Lock()
	for k := range batch {
		delete(b.dirty, k)
	}
	b.full.Broadcast()
	b.mu.Unlock()
}

// Close stops the flush loop AFTER a final synchronous drain, so a graceful
// shutdown loses nothing. A crash (no Close) still loses the un-flushed window —
// that is the irreducible risk of write-behind.
func (b *Buffer) Close() {
	close(b.stop)
	<-b.done
}

// WriteAround writes straight to the store and DOES NOT populate the cache, so
// write-once-read-rarely data never evicts the hot working set. If the key might
// be cached from a prior read, we invalidate it so no stale value is served; the
// next read repopulates lazily if the data is ever actually wanted.
func WriteAround(ctx context.Context, rdb *redis.Client, key, value string, writeStore StoreWriter) error {
	if err := writeStore(ctx, map[string]string{key: value}); err != nil {
		return err
	}
	// Bypass population; only invalidate a possibly-stale prior cache entry.
	return rdb.Del(ctx, key).Err()
}
```

The write-behind buffer encodes every part of the trade: fast acknowledgement (`Write` returns after the cache update), coalescing (the flusher reads only the latest value via `MGET`), batching (`batchSize` keys per store call), retry-without-drop (dirty keys survive a failed flush), backpressure (`maxDirty` blocks writers to bound loss and memory), and a clean-shutdown drain (`Close` flushes synchronously). The one comment worth re-reading is the TTL warning in `Write`: a value that can expire before it is flushed is a silently lost write, so a write-behind key's TTL must exceed the maximum flush interval, or be absent entirely.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages (write-behind)**
- **Write latency at cache speed.** Writes are acknowledged after the cache update, not the store write, so tail write latency collapses.
- **Massive store-throughput reduction.** Coalescing turns many writes to a key into one, and batching amortises per-write overhead — often an order-of-magnitude fewer store operations.
- **Smooths write spikes.** A burst of writes is absorbed by the buffer and drained steadily, protecting the store from load spikes.
- **Ideal for high-frequency, low-value writes.** Counters, telemetry, "last seen" timestamps, view counts — data written constantly and needed only approximately durable.

**Advantages (write-around)**
- **Protects the hot working set.** Write-heavy, read-cold data never enters the cache, so it cannot evict genuinely useful entries.
- **Simple and safe.** No async machinery, no durability window — the store is written synchronously as usual.

**Disadvantages**
- **Write-behind has a real durability window.** Acknowledged-but-unflushed writes are lost if the cache dies — a correctness risk for anything valuable.
- **Write-behind is complex.** Flush loop, retry, backpressure, coalescing, ordering, and shutdown drain are all necessary and easy to get subtly wrong.
- **Write-behind reads-after-write from the store can be stale.** Until the flush lands, the store does not have the latest value; anything reading the store directly sees old data.
- **Write-around makes the first read a miss.** By design, freshly written data is not cached, so read-soon-after-write pays a miss and a store load.

**Trade-offs**
- *Write-behind — durability vs throughput/latency:* the shorter the flush interval, the smaller the loss window but the less coalescing and batching benefit; tuning the interval is tuning exactly this trade.
- *Write-behind — buffer size vs loss and backpressure:* a bigger buffer absorbs larger spikes but widens the loss window and uses more memory; a smaller buffer bounds loss but applies backpressure sooner.
- *Write-around vs write-through:* mirror images — write-around skips the cache for read-rarely data (first read misses), write-through caches on write for read-soon data (latency tax). Choose by whether the written data is read back soon.
- *Ordering vs coalescing:* coalescing discards intermediate values, so if the store needs every intermediate state (an event log), write-behind's last-value-wins is wrong — use an append model or a stream instead.

## 7. Common Mistakes & Best Practices

- **Using write-behind for data whose loss is unacceptable.** Money, orders, inventory decrements, anything a user is told "succeeded" that must be true — the durability window makes write-behind wrong here. *Best practice:* restrict write-behind to loss-tolerant data (counters, telemetry, approximate fields).
- **A TTL shorter than the flush interval.** The cached value expires before it is flushed, silently dropping the write. *Best practice:* write-behind keys have no TTL, or a TTL comfortably longer than the maximum flush interval.
- **Clearing dirty keys before the store write succeeds.** A failed flush then loses those writes silently. *Best practice:* clear the dirty set only after a confirmed successful store write; retry on failure.
- **No backpressure.** An unbounded buffer grows without limit under a write spike, blowing memory and widening the loss window arbitrarily. *Best practice:* bound the buffer and block or reject writers when it is full.
- **No shutdown drain.** A rolling deploy that kills the process without flushing loses the whole buffer on every deploy. *Best practice:* flush synchronously on graceful shutdown; handle SIGTERM.
- **Non-idempotent store writes.** Retries after a partial failure double-apply writes. *Best practice:* make the store write idempotent (upsert by key), so a retried batch is safe.
- **Write-around for read-soon data.** Bypassing the cache on write then reading immediately guarantees a miss and a store hit. *Best practice:* use write-around only for genuinely read-rarely data; use write-through for read-soon.
- **Best practice overall:** write-behind is a power tool for loss-tolerant, write-heavy data — bound the buffer, drain on shutdown, keep writes idempotent, and never point it at data whose loss is a bug.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** The signature write-behind bug is "the store is behind the cache" — reads against the store see stale data because the flush has not landed. Confirm by comparing the dirty-set size and age against the flush interval; a growing dirty set means the flusher cannot keep up (a slow store, too small a batch, or too long an interval). For lost writes after a crash, the question is always "how much was in the unflushed window when it died?" — instrument the buffer to emit dirty-set size so you can quantify worst-case loss.
- **Monitoring.** Track dirty-set size and its oldest-entry age (the current loss window), flush latency and failure rate, coalescing ratio (writes accepted vs store writes issued — the efficiency of the pattern), and backpressure events (writers blocked). Alert when the dirty set trends up (flusher falling behind) or when the oldest dirty entry exceeds your acceptable loss window. For write-around, monitor cache hit ratio to confirm you are not accidentally starving reads that would benefit from caching.
- **Security.** The buffer holds not-yet-persisted writes in Redis, so the same protections as any Redis data apply (TLS, `requirepass`/ACLs, network isolation — chapter 29). If the write-behind data is sensitive, note that it lives *only* in the cache during the window, so the cache's durability and access controls are, temporarily, the system of record — treat it with the store's security posture, not a mere cache's. Idempotent store writes must also be safe against replay if a batch is retried.
- **Scaling.** Write-behind scales the *store* by shielding it from write volume, which is often the whole reason to use it — a store that cannot take 100k writes/sec can easily take 1k coalesced batches/sec. But the buffer itself must scale: shard the dirty set and the flusher across keys (each flusher owning a slice of the keyspace) so one flush loop is not the bottleneck, and be careful that a single Redis instance holding the buffer does not become a durability single-point-of-failure — replicate it (AOF or a replica) if the loss window must be protected. Write-around scales trivially since it adds no machinery; it simply keeps the cache smaller and hotter, which improves cache scaling for everything else.

## 9. Interview Questions

**Q: What is write-behind caching and what does it optimise for?**
A: Write-behind (write-back) acknowledges a write as soon as it is in the cache and flushes it to the underlying store later, asynchronously, in coalesced batches. It optimises for write latency and store throughput: the caller gets a fast acknowledgement at cache speed instead of waiting for the store, and the store sees far fewer operations because repeated writes to the same key coalesce into one and many keys batch into a single bulk write. It is the pattern for write-heavy workloads — high-frequency counters, telemetry, "last seen" timestamps — where the store's write throughput is the bottleneck and a small window of possible data loss is acceptable.

**Q: What is the durability risk in write-behind, and can you eliminate it?**
A: Between acknowledging a write and the flusher persisting it to the store, the write exists only in the cache. If the cache instance dies in that window — a crash, an eviction, a failover that loses the un-replicated tail — those acknowledged-but-unflushed writes are lost, even though the caller was told they succeeded. You cannot eliminate this without making the flush synchronous, at which point it is write-through. What you can do is shrink the window (flush more often, at the cost of less coalescing), bound the loss (cap the buffer and apply backpressure), protect the buffer (replication or AOF on the Redis holding it), and drain synchronously on graceful shutdown. The discipline is to use write-behind only for data where a bounded loss is acceptable.

**Q: What is coalescing and why does it matter?**
A: Coalescing is multiple writes to the same key collapsing into a single store write because only the latest value needs to be persisted. If a key is written a thousand times between flushes, the flusher reads its one current value and writes the store once — a thousand-to-one reduction. It matters because it is the main reason write-behind reduces store load so dramatically for hot keys: high-frequency updates to the same key (a view counter, a last-seen timestamp) become one store write per flush interval. The caveat is that coalescing discards intermediate values, so it is wrong when the store needs every state — an event log needs an append model, not last-value-wins.

**Q: What is write-around and when do you use it?**
A: Write-around writes straight to the store and bypasses the cache, so the cache is populated only later by reads. You use it for write-once-read-rarely data — logs, audit records, bulk imports — where caching on write would flood the cache with entries nobody reads and evict the genuinely hot working set. By leaving those writes out of the cache, you protect the eviction budget for data that is actually read. The trade-off is that if the data *is* read soon after being written, that first read is a guaranteed miss, so write-around is exactly wrong for read-soon-after-write patterns, which want write-through's warm-on-write instead.

**Q: How do write-through, write-behind, and write-around differ in one sentence each?**
A: Write-through writes the store synchronously on every write and updates the cache too, so the store always sees every write immediately and the cache is warm — paying latency for consistency. Write-behind writes only the cache synchronously and flushes to the store asynchronously in coalesced batches, so the store sees fewer, later writes — paying a durability window for throughput and latency. Write-around writes the store and skips the cache entirely, so the cache never sees the write — paying a first-read miss to avoid polluting the cache with read-rarely data. They are a spectrum of "how much does the store see, and when."

**Q: Why must write-behind store writes be idempotent?**
A: Because a flush that partially fails or times out is retried, and a retry may re-send keys that were already partially applied, so the store can receive the same write more than once. If the store write is idempotent — typically an upsert keyed by the entity id, so re-applying the same value is a no-op — a retry is harmless. If it is not idempotent — say an append or a relative increment applied per flush — a retry double-applies and corrupts the data. So the flusher's contract with the store writer is "you may be called more than once with the same batch," and the store writer must honour that with idempotent, absolute-value writes.

**Q: Why must a write-behind key's TTL be longer than the flush interval (or absent)?**
A: Because in write-behind the cache holds the only copy of an acknowledged write until the flusher persists it to the store. If that cached value carries a TTL shorter than the time until the next flush, Redis can expire it *before* it is ever written to the store — the write was acknowledged to the caller, then silently vanished, and the store never learns of it. This is a particularly nasty bug because it looks like nothing went wrong: no error, no crash, just a lost write. The rule is that a write-behind key must have no TTL, or a TTL comfortably longer than the maximum flush interval, so the value cannot expire out from under the flusher. It is a specific instance of the general write-behind invariant: nothing may remove a dirty value from the cache except a successful flush.

**Q: (Senior) How do you bound and reason about the maximum data loss of a write-behind system?**
A: The maximum loss is the contents of the buffer at the instant the cache dies, so bounding loss means bounding the buffer's size and age. Concretely I would cap the dirty set at a maximum number of keys and apply backpressure — blocking or rejecting writers once it is full — so the buffer cannot grow without limit under a spike; that caps loss by *count*. I would also cap the age of the oldest dirty entry by flushing on a fixed interval regardless of batch fullness, so no acknowledged write sits unflushed longer than that interval; that caps loss by *time*. Then the worst-case loss is bounded by whichever limit binds first: at most `maxDirty` keys or at most one flush-interval of writes. To reason about it in production I instrument both the dirty-set size and its oldest-entry age and alert when either approaches its bound, because a rising dirty set means the flusher is falling behind and the real loss window is widening beyond the nominal interval. Finally, for data where even that bounded loss is too much, I protect the buffer itself with replication or AOF on the Redis instance so a single-node failure does not lose the window — but at that point I question whether write-behind is the right pattern at all versus write-through, because I am reintroducing synchronous durability cost. The senior framing is that write-behind's loss is a *tunable* quantity, not an unknown, and the job is to make the worst case explicit and acceptable, or to choose a different pattern.

**Q: (Senior) A write-behind system's store is falling steadily behind the cache. Diagnose and fix.**
A: A steadily growing gap between cache and store means the flusher's drain rate is below the write arrival rate, so the dirty set is accumulating and both the loss window and memory are trending up toward the backpressure bound. I would diagnose along the drain pipeline. First, is the store itself slow — has flush latency risen, are batches timing out and retrying (which makes it worse, re-reading and re-writing the same keys)? If so the store is the bottleneck and I need bigger batches (fewer round trips), a faster bulk write (multi-row upsert, `COPY`, a prepared statement), or to shed load. Second, is the batch size too small or the interval too long relative to the write rate, so each flush drains too little? Increasing batch size and/or flush frequency raises drain throughput, though more frequent flushing reduces coalescing, so I would watch the coalescing ratio to make sure I am not trading away the pattern's main benefit. Third, is coalescing actually happening — if writes are spread across many distinct keys rather than concentrated on hot ones, there is little to coalesce and the store genuinely must absorb near the full write volume, in which case write-behind may be the wrong pattern and I should question whether the store can be scaled or the writes reduced at the source. Fourth, is a single flusher the bottleneck — if so I shard the dirty set by key range and run parallel flushers so drain throughput scales out. The immediate safety action while diagnosing is that backpressure will (correctly) start slowing writers as the buffer fills, which protects durability and memory at the cost of write latency — that is the system defending its loss bound, and it is a signal, not a failure, that the flush pipeline needs to be widened or the write rate reduced.

**Q: (Senior) When would you deliberately combine these patterns, and how?**
A: Real systems rarely use one pattern globally; they route each data class to the pattern that fits it, because the patterns answer different questions. In a single service I might use write-through for the user's core profile — read back soon after edits, must be consistent, moderate write rate — accepting the latency tax for warm-on-write consistency. For high-frequency denormalised counters on that same profile (profile views, follower counts that only need approximate durability) I would use write-behind, coalescing thousands of increments into periodic batched store writes and accepting a bounded loss window because a lost view-count increment is not a correctness bug. For audit and event logs the service emits on every action — written constantly, read almost never except in investigations — I would use write-around, writing straight to the store and never caching them, so they do not evict the hot profile data from the cache. The design method is to classify each write by the three axes — post-write read latency needs, store-throughput pressure and loss tolerance, and read-back frequency — and assign the pattern per class rather than per service. The subtlety to watch is that mixing patterns on the *same key* is dangerous (a write-behind field and a write-through field on one object can disagree about when the store is current), so I keep the pattern boundary aligned with data ownership boundaries and never let two patterns write the same key.

## 10. Quick Revision & Cheat Sheet

| Pattern | Write goes to | Store sees | Cost |
|---|---|---|---|
| Write-through | cache + store (sync) | every write, now | latency per write |
| Write-behind | cache now, store later | coalesced, batched, delayed | durability window |
| Write-around | store only | the write; cache never | first read misses |

| Write-behind knob | Effect |
|---|---|
| Shorter flush interval | Smaller loss window, less coalescing |
| Larger batch size | Higher drain throughput, more memory per flush |
| Larger buffer (maxDirty) | Absorbs bigger spikes, wider loss window |
| Backpressure | Bounds loss + memory, slows writers |
| Shutdown drain | Closes window on graceful stop (not on crash) |

**Flash cards**
- **Write-behind?** &#8594; ack on cache write, flush to store async in coalesced batches.
- **Write-behind's cost?** &#8594; durability window — unflushed writes lost if the cache dies.
- **Coalescing?** &#8594; many writes to one key collapse to one store write (last value wins).
- **Write-around?** &#8594; write store, skip cache; for write-once-read-rarely data.
- **Write-around's cost?** &#8594; first read after write is a guaranteed miss.
- **TTL rule for write-behind?** &#8594; longer than the flush interval, or none, or the write is silently lost.

## 11. Hands-On Exercises & Mini Project

- [ ] Build the write-behind buffer, hammer one key with 10,000 writes, and confirm the store receives one write (coalescing) via a counting store stub.
- [ ] Batch across many keys and measure store operations per second versus a synchronous write-through baseline under the same load.
- [ ] Kill the process without a shutdown drain and count the lost writes; then add the drain and confirm a graceful stop loses nothing.
- [ ] Add backpressure and drive writes faster than the flusher can drain, showing the dirty set bounded and writers blocking rather than memory growing unbounded.
- [ ] Set a TTL shorter than the flush interval and demonstrate a silently lost write; then fix it.
- [ ] Implement write-around for a log stream and show the cache hit ratio for hot data staying high because the logs never evict it.

### Mini Project — "Write-Behind Buffer with a Loss-Window Dashboard"

**Goal.** Build a write-behind buffer and make its central trade — throughput versus durability — measurable, so tuning the knobs is grounded in numbers rather than intuition.

**Requirements.**
1. Implement `Write` (cache + dirty-mark, with backpressure) and a flush loop (snapshot, `MGET`-coalesce, batch store write, clear-on-success, retry-on-failure).
2. Expose metrics: dirty-set size, oldest-dirty-entry age (the live loss window), coalescing ratio, flush latency, and backpressure events.
3. Add a graceful-shutdown drain and a fault-injecting store stub that fails intermittently; prove no acknowledged write is dropped by a transient failure.
4. Build a small dashboard or log stream showing the loss window in real time under varying write rates and flush intervals.
5. Add a write-around path for a designated "read-rarely" keyspace and show it does not affect the hit ratio of the hot keyspace.

**Extensions.**
- Shard the dirty set and run parallel flushers by key range; measure the increase in drain throughput.
- Protect the buffer with a Redis replica or AOF and demonstrate the loss window surviving a primary failure (versus losing it without protection).

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Read-Through & Write-Through Caching* (the synchronous alternative), *Design: Cache-Aside (Lazy Loading)* (the read path write-around relies on), *TTL Strategy, Refresh-Ahead & Adaptive Expiry* (why write-behind keys need careful TTLs), *Memory, maxmemory & Eviction* (why write-around protects the eviction budget), *Persistence: RDB, AOF & the Durability Trade-off* (protecting the buffer).

- **AWS — Caching strategies: Write-Behind & Lazy Loading trade-offs** — AWS ElastiCache · *Intermediate* · the vendor-neutral framing of write-back's latency-vs-durability trade and where it fits. <https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/Strategies.html>
- **Designing Data-Intensive Applications, ch. 3 & 7** — Martin Kleppmann · *Advanced* · log-structured storage, batching, and the durability-vs-latency reasoning that underlies write-behind. <https://dataintensive.net/>
- **Redis — Persistence (RDB & AOF)** — Redis · *Advanced* · what it takes to make the buffer itself durable if the loss window must be protected. <https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/>
- **Redis — Streams** — Redis · *Advanced* · when you need every intermediate write (an append log) rather than coalesced last-value-wins, streams are the right primitive. <https://redis.io/docs/latest/develop/data-types/streams/>
- **Caffeine — Writer & asynchronous eviction/write** — Ben Manes · *Advanced* · a mature library's take on write-behind semantics and the pitfalls of async writers. <https://github.com/ben-manes/caffeine/wiki/Writer>
- **Redis — MGET / MSET & pipelining** — Redis · *Intermediate* · the bulk primitives that make batched flushing cheap; the read-coalesce step in §5. <https://redis.io/docs/latest/commands/mget/>
- **Redis — maxmemory & eviction policies** — Redis · *Intermediate* · the eviction budget write-around is protecting; LRU/LFU behaviour under cache pressure. <https://redis.io/docs/latest/develop/reference/eviction/>
- **Redis University — RU101: Introduction to Redis** — Redis · *Beginner* · free course covering the caching patterns and the trade-offs this chapter formalises. <https://university.redis.com/>

---

*Caching with Redis Handbook — chapter 10.*
