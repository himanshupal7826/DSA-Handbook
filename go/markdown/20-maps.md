# 20 · Maps

> **In one line:** Go's built-in map is a fast, randomized-iteration hash table that you must never write to concurrently.

---

## 1. Overview

A `map[K]V` is Go's built-in associative array: an unordered collection of key/value pairs with average **O(1)** lookup, insert, and delete. Keys must be *comparable* (support `==`), values can be any type. Maps are one of only two generic-feeling built-ins (the other being slices) that predate Go generics, and they remain the workhorse of nearly every Go program — config lookups, dedup sets, request routing, in-memory caches, frequency counts.

Three behaviors define the map's personality and trip up almost everyone at least once: **iteration order is deliberately randomized**, reads of missing keys return the zero value (resolved cleanly with the **comma-ok** idiom), and **concurrent read+write is a fatal runtime error, not a data race you can ignore**. Master those three and you understand 90% of map-related production incidents.

## 2. Why It Exists

Before maps, associative lookup means writing your own hash table or doing linear scans over slices — error-prone and slow. Go bakes the hash table into the language and runtime so it can:

- **Be type-safe** without generics-era boilerplate (`map[string]int` is checked at compile time).
- **Use a tuned, escape-analyzed, GC-aware implementation** written in optimized Go/assembly in the runtime (`runtime/map.go`).
- **Randomize iteration** to *force* you not to depend on order — a design decision to prevent the classic bug where code accidentally relies on insertion order and breaks when the implementation changes (this actually happened in other languages).

The map is the answer to "I need to associate one value with another and look it up fast, repeatedly." If you find yourself doing `for _, x := range slice { if x.id == target ... }` inside a hot loop, you want a map.

## 3. Internal Working

A Go map is a pointer to a runtime `hmap` struct. The data lives in an array of **buckets** (`bmap`), each bucket holding up to **8 key/value pairs**. Insertion hashes the key, uses the low-order bits to pick a bucket, and the high-order 8 bits (the *tophash*) as a fast in-bucket filter.

```text
        map[K]V  (variable)
            |
            v
        +-----------+
        |   hmap    |
        |  count    |  number of live elements (len())
        |  B        |  log2(#buckets) -> 2^B buckets
        |  buckets  ----> +--------------------------------+
        |  oldbuckets --\ | bucket 0 (bmap)                |
        |  hash0    |   | |  tophash[8] | keys[8] | vals[8]|
        +-----------+   | |  overflow ---------------------+--> overflow bmap
                        | +--------------------------------+
       (set during      | | bucket 1 ...                   |
        incremental     | +--------------------------------+
        growth)         \--> oldbuckets used while evacuating
```

Key implementation facts:

- **Keys and values are stored separately** within a bucket (`keys[8]` then `vals[8]`, not interleaved) so the compiler can avoid padding waste from alignment differences.
- **Overflow buckets** chain off a bucket when more than 8 keys collide into it.
- **Load factor** is ~6.5 elements/bucket. When exceeded (or too many overflow buckets accumulate), the map **grows**, allocating `2^(B+1)` buckets and **incrementally evacuating** old buckets into new ones during subsequent writes — growth is amortized, not a single stop-the-world copy.
- **Iteration is randomized**: the runtime picks a random starting bucket and a random starting cell offset on every `range`. This is *intentional* (`fastrand`), not a side effect of hashing.
- **Maps are reference-like**: the variable is a pointer to `hmap`. Passing a map to a function copies the pointer, so callees see mutations. But a `nil` map has no `hmap` — reads return zero, **writes panic**.
- **Growth invalidates element addresses**, which is exactly why Go forbids `&m[k]` — the value could move during a rehash.

The hash seed (`hash0`) is randomized per-map at creation, which mitigates hash-flooding DoS attacks against string keys.

## 4. Syntax

```go
// Declaration & initialization
var m map[string]int            // nil map: reads OK, writes PANIC
m = make(map[string]int)        // ready to use
m2 := make(map[string]int, 100) // pre-sized hint: 100 elements
m3 := map[string]int{"a": 1, "b": 2} // literal

// Insert / update
m["x"] = 42

// Read (zero value if absent)
v := m["missing"] // v == 0, no error

// Comma-ok: distinguish "present with zero" from "absent"
v, ok := m["x"]   // ok == true
_, ok = m["nope"] // ok == false

// Delete (safe even if key absent; no-op)
delete(m, "x")

// Length
n := len(m)

// Iterate (RANDOM order each run)
for k, v := range m {
    _ = k; _ = v
}

// Set idiom: map with empty-struct values (0 bytes)
seen := map[string]struct{}{}
seen["a"] = struct{}{}
_, exists := seen["a"]
```

## 5. Common Interview Questions

**Q1. Why is map iteration order random in Go?**
It's a deliberate runtime choice (random start bucket + cell) to stop programmers depending on order, which keeps the implementation free to change and surfaces ordering bugs early.
*Follow-up: How do you get sorted output?* Collect keys into a slice, `sort.Slice` (or `slices.Sort`), then iterate the sorted slice.

**Q2. What happens when you read a missing key?**
You get the value type's zero value, no panic. Use comma-ok (`v, ok := m[k]`) to tell "absent" from "present-but-zero" — critical for `map[string]int` where 0 is a legitimate value.
*Follow-up: How do you check membership without caring about the value?* `_, ok := m[k]`.

**Q3. Are maps safe for concurrent use?**
No. Concurrent read+write or write+write triggers a **fatal error** (`concurrent map read and map writes`) that crashes the process — it bypasses `recover()`. Use a `sync.Mutex`/`sync.RWMutex` or `sync.Map`.
*Follow-up: Are concurrent reads alone safe?* Yes, multiple goroutines reading with zero writers is safe.

**Q4. Why can't I take the address of a map element (`&m[k]`)?**
Because map growth can move elements to new buckets, invalidating any pointer. Go forbids it at compile time. Workaround: store pointers as values (`map[K]*V`) or read-modify-write the whole value.
*Follow-up: Why does `m[k].field = x` fail for struct values but work for `map[K]*V`?* The struct value is not addressable; pointer-valued maps return an addressable pointee.

**Q5. What types can be map keys?**
Any *comparable* type: booleans, numbers, strings, pointers, channels, interfaces, and structs/arrays of comparable types. **Not** slices, maps, or functions.
*Follow-up: What about a struct containing a slice?* Not allowed — the whole struct becomes non-comparable.

**Q6. Does `delete` shrink the map's memory?**
No. `delete` removes entries but the bucket array never shrinks. A map that peaked at millions of entries keeps that backing memory. To reclaim, rebuild into a fresh map and drop the old one.
*Follow-up: How to "clear" a map?* Go 1.21+: `clear(m)`. Pre-1.21: range-delete loop (which the compiler special-cases) or reassign `make`.

**Q7. What's the cost of using a struct vs `*struct` as a map value?**
Struct values are copied on every read and write; large structs are expensive to copy and you can't mutate in place. Pointers avoid copies and allow mutation but add indirection and GC pressure and risk aliasing bugs.
*Follow-up: When prefer value semantics?* Small, immutable-ish structs where copy cost is trivial and aliasing safety matters.

**Q8. Is `len(m)` O(1)?**
Yes — `hmap.count` is maintained incrementally.

## 6. Production Use Cases

- **In-memory caches / lookup tables**: HTTP routers (e.g. method+path → handler), feature-flag maps, session stores. `httprouter` and `chi` use map/trie hybrids.
- **Deduplication & sets**: `map[T]struct{}` for "have I seen this ID?" in stream processors, crawlers, and ETL pipelines.
- **Frequency counting / aggregation**: word counts, metric label cardinality tracking. **Prometheus** client libraries use maps keyed by label-set fingerprints.
- **Connection / resource registries**: `map[clientID]*Conn` in WebSocket servers and gateways (guarded by a mutex or sharded).
- **Sharded concurrent maps**: high-throughput services (Kubernetes informers, Docker, CockroachDB internal caches) shard a big map into N sub-maps each with its own lock to reduce contention.
- **`sync.Map` in the stdlib itself**: used in `encoding/json` and the `database/sql` driver registry — read-mostly registries with stable keys.

## 7. Common Mistakes

> [!WARNING]
> **Writing to a nil map.** `var m map[string]int; m["x"]=1` panics. Always `make` before writing.

- **Assuming iteration order is stable** — tests pass locally, fail in CI, or output flips between runs.
- **Concurrent access without locks** — the killer. It often "works" under light load and crashes the whole process in production with a fatal error that recover can't catch.
- **Confusing zero value with absence** — `if m[k] != 0` is wrong when 0 is valid data; use comma-ok.
- **Taking `&m[k]`** or trying `m[k].field = v` on struct values — compile error, then people copy-mutate-store incorrectly.
- **Memory not released after `delete`** — long-lived maps as unbounded caches become slow leaks.
- **Using mutable/large keys** — slices can't be keys; huge string keys hash slowly.
- **Iterating and deleting carelessly** — deleting during range is *allowed and safe* in Go, but inserting during range yields undefined which-keys-are-visited behavior.

## 8. Performance Considerations

- **Pre-size with `make(map[K]V, n)`** when you know the count. This avoids repeated grow/evacuate cycles. Inserting 1M keys into a sized map can be ~30-50% faster than into an unsized one.
- **Key type matters**: integer keys are fastest; string keys pay a hash + compare cost proportional to length; struct keys hash field-by-field.
- **`map[K]struct{}` for sets** uses zero bytes per value vs `map[K]bool` (1 byte) — meaningful at scale.
- **Maps are not cache-friendly**: buckets are scattered in memory, so a hot lookup table that fits in a slice/array with a known index can be 5-10x faster due to cache locality. For small enumerable key spaces, a slice indexed by an int can beat a map.
- **Iteration cost**: `range` over a sparse map (lots of deletes) still walks all buckets including empty/overflow ones.
- **GC pressure**: `map[K]*V` and string keys create pointers the GC must scan. `map[int]int` is pointer-free and cheaper to collect.

> [!TIP]
> Benchmark before reaching for `sync.Map`. For write-heavy or balanced workloads, a sharded `map` + `RWMutex` usually beats `sync.Map`, which is optimized for read-mostly, append-once key sets.

## 9. Best Practices

- **Always initialize before write** (`make` or literal).
- **Use comma-ok** whenever the zero value is ambiguous.
- **Guard concurrency explicitly** — pick one strategy (mutex, sharded, or `sync.Map`) and document it next to the field.
- **Sort keys for deterministic output** in logs, golden tests, and serialization.
- **Prefer `map[K]struct{}` for sets.**
- **Pre-size** when the cardinality is known or estimable.
- **Don't expose raw maps across API boundaries** if callers might mutate them concurrently; return copies or wrap in an accessor type.
- **Use `clear(m)` (Go 1.21+)** instead of reallocating when you want to keep capacity.

## 10. Code Examples

Primary: a small, race-free in-memory counter store with comma-ok and deterministic dumping.

```go
package main

import (
	"fmt"
	"sort"
	"sync"
)

// Counter is a concurrency-safe frequency map.
type Counter struct {
	mu sync.RWMutex
	m  map[string]int
}

func NewCounter() *Counter {
	return &Counter{m: make(map[string]int)}
}

func (c *Counter) Inc(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.m[key]++ // safe: missing key reads as 0
}

func (c *Counter) Get(key string) (int, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	v, ok := c.m[key] // comma-ok: distinguishes absent from zero
	return v, ok
}

// Dump returns counts in deterministic key order.
func (c *Counter) Dump() []string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	keys := make([]string, 0, len(c.m))
	for k := range c.m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]string, len(keys))
	for i, k := range keys {
		out[i] = fmt.Sprintf("%s=%d", k, c.m[k])
	}
	return out
}

func main() {
	c := NewCounter()
	var wg sync.WaitGroup
	for _, w := range []string{"go", "map", "go", "hash", "map", "go"} {
		wg.Add(1)
		go func(w string) { defer wg.Done(); c.Inc(w) }(w)
	}
	wg.Wait()
	fmt.Println(c.Dump()) // [go=3 hash=1 map=2]
}
```

Alternative: a sharded concurrent map that scales better under write contention than a single global lock.

```go
package main

import (
	"hash/fnv"
	"sync"
)

const shardCount = 32

type shard struct {
	mu sync.RWMutex
	m  map[string]int
}

// ShardedMap spreads keys across N independently locked shards.
type ShardedMap [shardCount]*shard

func NewSharded() *ShardedMap {
	var sm ShardedMap
	for i := range sm {
		sm[i] = &shard{m: make(map[string]int)}
	}
	return &sm
}

func (sm *ShardedMap) shardFor(key string) *shard {
	h := fnv.New32a()
	_, _ = h.Write([]byte(key))
	return sm[h.Sum32()%shardCount]
}

func (sm *ShardedMap) Inc(key string) {
	s := sm.shardFor(key)
	s.mu.Lock()
	s.m[key]++
	s.mu.Unlock()
}

func (sm *ShardedMap) Get(key string) (int, bool) {
	s := sm.shardFor(key)
	s.mu.RLock()
	v, ok := s.m[key]
	s.mu.RUnlock()
	return v, ok
}
```

## 11. Advanced Concepts

- **`sync.Map`**: a specialized concurrent map with `Load`, `Store`, `LoadOrStore`, `Delete`, `Range`. It uses a lock-free read-only `read` map plus a mutex-guarded `dirty` map, promoting reads to the fast path. **Best for read-mostly, write-once-per-key** workloads (registries, caches with stable keys). It is *not* generic (`any` keys/values), so you lose type safety.
- **Generics + maps**: the `maps` and `slices` stdlib packages (Go 1.21+) give `maps.Clone`, `maps.Equal`, `maps.Copy`, and (1.23+) iterator-returning `maps.Keys`/`maps.Values`. Write generic helpers: `func Keys[K comparable, V any](m map[K]V) []K`.
- **`maps.Clone`** does a shallow copy — pointer/slice values are shared between original and clone.
- **Hash DoS resistance**: per-map random seed means attacker-controlled string keys can't reliably force worst-case collisions, unlike the historic PHP/Java hash-flooding attacks.
- **Map of channels / functions-as-values**: `map[string]func(...)` is a clean dispatch table replacing long switch statements.
- **`clear` semantics**: for maps `clear(m)` deletes all entries (keeping capacity); for slices it zeros elements — different behaviors, same builtin.
- **Comparable interface keys**: storing values of differing dynamic types under an interface key can panic at runtime if a stored dynamic type is non-comparable (e.g. an interface wrapping a slice).

## 12. Debugging Tips

> [!NOTE]
> The crash message `fatal error: concurrent map read and map writes` is **not a panic** — it has no recoverable stack and bypasses `defer`/`recover`. Treat it as a definite concurrency bug.

- **Run with `-race`**: `go test -race ./...` and `go run -race`. The race detector catches concurrent map access even when the fatal error doesn't fire under your test load.
- **Non-deterministic test failures** that change between runs → almost always relying on map iteration order. Fix by sorting.
- **Memory bloat that never recedes** → a map used as an unbounded cache; check whether you ever `delete`/`clear` or bound size (LRU).
- **`nil map` panics** show `assignment to entry in nil map` — search for a missing `make`.
- **Use `expvar` or pprof heap profiles** to find oversized maps holding GB of keys.
- **Print deterministically**: `fmt.Printf("%v", m)` since Go 1.12 prints maps in sorted key order — handy for debugging, but don't rely on it in program logic.

## 13. Senior Engineer Notes

As a senior engineer, your map judgment shows up in **code review and design**:

- **Flag every shared map**: in review, any `map` field on a struct touched by more than one goroutine needs an explicit synchronization story. "It's only read after init" must be documented and enforced (e.g. build the map fully before publishing the pointer).
- **Push back on `sync.Map` cargo-culting**: ask "is this read-mostly with stable keys?" If not, a plain map + `RWMutex` is faster, type-safe, and clearer. Require a benchmark, not a vibe.
- **Encapsulate maps**: don't return internal maps from getters — callers will mutate or iterate them concurrently. Return clones or expose narrow methods.
- **Mentor on comma-ok and zero values**: the single most common correctness bug in junior Go code is conflating "absent" with "zero." Teach it once, catch it forever in review.
- **Determinism in tests**: insist that any map-derived output (serialized config, log lines, hashes) sorts keys, or you'll inherit flaky CI.
- **Watch struct-value maps**: review `m[k] = v` patterns on large struct values for needless copies; suggest `map[K]*V` or restructuring when copies dominate a hot path.

## 14. Staff Engineer Notes

At staff level, maps become an **architecture and org-level** concern:

- **Build vs. buy for concurrent maps**: before anyone hand-rolls a sharded map, evaluate `sync.Map`, a battle-tested library, or simply a different data model. Internal "clever" concurrent maps are a recurring source of subtle corruption across teams; standardize on one blessed pattern and put it in your platform library.
- **Cardinality is a system risk**: an unbounded `map[label]metric` (Prometheus high-cardinality), `map[userID]session`, or `map[connID]*conn` is a latent OOM and a GC-latency problem. Mandate bounds (LRU, TTL, sharding) and capacity dashboards. I've seen a single unbounded label map take down a metrics fleet.
- **Cross-team API hygiene**: maps crossing service or package boundaries (especially in shared libraries) must define ownership and mutability contracts. Prefer immutable snapshots or copy-on-publish for config that many goroutines read.
- **GC and footprint at scale**: choosing `map[int]int` over `map[string]*Obj` for a billion-entry table changes GC pause profiles materially. At staff level you reason about pointer density and may push toward off-heap or specialized structures (open-addressing arrays, swiss tables) when the built-in map's overhead matters.
- **Hash-flooding & multi-tenant safety**: if attacker- or tenant-controlled strings become map keys in a shared service, confirm the per-map seed is sufficient or add an upstream cardinality/validation layer. Make this a security-review checklist item.
- **Future-proofing**: Go's map implementation evolves (the runtime is moving toward Swiss-table-based maps). Don't encode assumptions about bucket layout or order into your designs; depend only on the documented contract.

## 15. Revision Summary

- `map[K]V`: hash table, avg O(1) get/set/delete; keys must be **comparable** (no slices/maps/funcs).
- **Iteration order is randomized on purpose** — sort keys for deterministic output.
- **Comma-ok** (`v, ok := m[k]`) distinguishes absent from zero; missing-key reads return the zero value.
- **nil map**: reads OK, **writes panic**. Always `make` first.
- **Concurrency**: read+write is a *fatal error* (not recoverable). Use mutex, sharded map, or `sync.Map`.
- Internally: `hmap` → buckets of 8 pairs + overflow chains; grows at ~6.5 load factor via incremental evacuation; per-map random hash seed.
- `delete` doesn't free backing memory; use `clear(m)` (1.21+) or rebuild.
- `&m[k]` is illegal (growth moves elements); use `map[K]*V` to mutate in place.
- Pre-size with `make(map, n)`; use `map[K]struct{}` for sets; `sync.Map` only for read-mostly stable keys.

**References:** Go blog: *Go maps in action* (go.dev/blog/maps); `runtime/map.go`; `sync.Map` and `maps`/`slices` stdlib docs.

---

*Go Engineering Handbook — topic 20.*
