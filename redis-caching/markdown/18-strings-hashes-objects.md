# 18 · Strings, Hashes & Object Caching

> **In one line:** How you store a cached object — an opaque serialized blob in a string, or a field-addressable hash — decides your update cost, your round trips and your memory footprint, and the serialization format you pick underneath (JSON vs msgpack vs protobuf) trades human-readability for bytes and CPU in ways that matter enormously at scale.

---

## 1. Overview

Almost every cache eventually holds *objects* — a user profile, a product, a session, a rendered config. The naïve approach is to serialize the object to JSON and `SET` it under a key, and for a great deal of caching that is exactly right. But it is a decision with consequences most people never examine: the moment you need to update *one field*, a JSON string forces you to fetch the whole value, decode it, mutate it, re-encode it and write it back — four operations and a read-modify-write race — where a Redis **hash** would update that field in a single atomic `HSET` or `HINCRBY`.

This chapter is about that decision and everything that hangs off it. There are two orthogonal choices. The first is the **container**: a string holding a serialized blob, versus a hash exposing each attribute as a field. The second is the **serialization format** used to turn your object into bytes: JSON (readable, ubiquitous, verbose), msgpack (a compact binary JSON), or protobuf (schema-driven, smallest and fastest, but requires generated code). These two choices interact — a hash stores each field's *value* as bytes, so the format question applies inside a hash too, per field.

Underneath both sits a memory story that is easy to get wrong and expensive at scale. Redis stores small hashes in a compact **listpack** and only converts to a full hash table past a configurable threshold; staying under that threshold is the difference between a hash that costs a few dozen bytes and one that costs several times more. Instagram famously exploited exactly this — sharding a flat keyspace of hundreds of millions of keys into hashes cut their memory roughly five-fold. By the end of this chapter you will know when to reach for a string, when for a hash, which serialization format to serialize with, when to compress, and how to keep your objects compact enough that memory stays cheap.

## 2. Core Concepts

- **String blob** — an object serialized to bytes and stored under one key with `SET`/`GET`; opaque to Redis, read and written as a whole.
- **Hash** — a map of field→value inside one key; each field is independently readable and writable with `HGET`/`HSET`, and numeric fields are atomically mutable with `HINCRBY`.
- **Serialization format** — how the object becomes bytes: **JSON** (text, readable), **msgpack** (compact binary), **protobuf** (schema-driven binary, smallest/fastest).
- **Field-addressable update** — changing one attribute of an object without fetching the rest; native to hashes, impossible for an opaque string blob.
- **Partial read** — fetching only the fields you need (`HMGET`), saving bandwidth versus transferring the whole object.
- **Listpack encoding** — the compact flat representation Redis uses for small hashes, sets and sorted sets before converting to a full structure.
- **Encoding threshold** — `hash-max-listpack-entries` (default 128) and `hash-max-listpack-value` (default 64 bytes): cross either and the hash converts to a hash table, multiplying memory per field.
- **Key overhead** — every top-level key carries fixed bookkeeping cost (dict entry, object header, expiry slot); fewer keys means less overhead.
- **The Instagram technique** — bucketing millions of small key-value pairs into a smaller number of hashes to amortise key overhead and stay in listpack encoding.
- **Value compression** — applying a general-purpose compressor (gzip, zstd, lz4) to large serialized values to trade CPU for memory and network bytes.

## 3. Theory & Principles

### String blob vs hash: the read-modify-write question

The single question that decides string-vs-hash is: **do you ever update or read individual fields?**

If you always touch the whole object — read it entire, write it entire, never mutate one attribute in isolation — a **string** is correct and simplest. Serialize once, `SET` with a TTL, `GET`-and-decode on read. There is nothing a hash buys you here, and the string avoids per-field overhead.

If you address fields — bump a login counter, update just the `last_seen` timestamp, read only the `email` — a **hash** is the right container. `HINCRBY user:9 logins 1` mutates one field atomically, server-side, in one round trip. The equivalent for a JSON string is the classic read-modify-write hazard: `GET`, decode, `logins++`, encode, `SET` — five steps spanning a network round trip, during which a concurrent updater can read the same old value and clobber your write. The hash does it with no race because the increment happens entirely inside Redis's single thread.

This is not a small distinction. A read-modify-write on a serialized blob is *both* slower (two round trips and two serialize passes) *and* incorrect under concurrency (lost updates). The hash is faster and correct. The only reasons to keep a blob when you do have field updates are that your object is deeply nested (hashes are flat — one level of fields) or that you genuinely need atomic multi-field consistency that a single serialized write gives you for free.

### Serialization formats: readable vs compact

Whatever the container, the object's bytes come from a serialization format, and the choice is a three-way trade between **size**, **speed**, and **ergonomics**.

- **JSON** is text: human-readable, debuggable with `redis-cli GET`, supported everywhere, schema-free. It is also the *largest* (field names repeated as strings in every value, numbers as decimal text) and among the *slowest* to parse. For small values and moderate scale, its convenience usually wins.
- **msgpack** is "binary JSON": the same schema-free data model, but encoded compactly (short type tags, binary numbers, no whitespace). Typically **20–50% smaller** than JSON and faster to encode/decode, at the cost of not being human-readable. A near drop-in upgrade when JSON's size or speed starts to hurt and you do not want a schema.
- **protobuf** (and similar schema-driven formats like FlatBuffers, Cap'n Proto, Avro) is the **smallest and fastest**, because the schema is known ahead of time: field names become integer tags, types are fixed, and no self-description travels in the payload. The cost is operational — you maintain `.proto` schemas and generated code, and a raw value is unreadable without the schema. Worth it at high scale or in latency-critical paths.

A useful rule of thumb on a typical object: if JSON is 100 bytes, msgpack is ~60–80, protobuf is ~40–60, and protobuf encodes/decodes several times faster than JSON. At a million cached objects those percentages are gigabytes and CPU-seconds.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Same object, two containers and three serialization formats</text>

  <rect x="24" y="44" width="410" height="196" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="229" y="66" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">STRING blob &#8212; opaque, whole-object</text>
  <rect x="44" y="80" width="370" height="30" rx="4" fill="#fff" stroke="#93c5fd"/>
  <text x="54" y="99" fill="#1d4ed8" font-size="9" font-family="ui-monospace,monospace">SET user:9 '{"name":"Ada","email":"ada@x.com","logins":7}'</text>
  <text x="44" y="132" fill="#1e40af" font-size="10" font-weight="bold">Update logins++ &#8212; the read-modify-write hazard:</text>
  <text x="58" y="152" fill="#1d4ed8" font-size="9">1. GET  &#8594;  2. decode  &#8594;  3. logins++</text>
  <text x="58" y="168" fill="#1d4ed8" font-size="9">4. encode  &#8594;  5. SET   (two round trips)</text>
  <rect x="44" y="180" width="370" height="48" rx="4" fill="#fee2e2" stroke="#dc2626"/>
  <text x="229" y="199" text-anchor="middle" fill="#b91c1c" font-size="9" font-weight="bold">Concurrent updater reads the same old value &#8594;</text>
  <text x="229" y="216" text-anchor="middle" fill="#b91c1c" font-size="9" font-weight="bold">LOST UPDATE. Slower AND racy.</text>

  <rect x="446" y="44" width="410" height="196" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="651" y="66" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">HASH &#8212; field-addressable</text>
  <rect x="466" y="80" width="370" height="46" rx="4" fill="#fff" stroke="#86efac"/>
  <text x="476" y="98" fill="#166534" font-size="9" font-family="ui-monospace,monospace">HSET user:9 name Ada email ada@x.com logins 7</text>
  <text x="476" y="116" fill="#166534" font-size="9" font-family="ui-monospace,monospace">HGET user:9 email    HMGET user:9 name logins</text>
  <text x="466" y="146" fill="#15803d" font-size="10" font-weight="bold">Update logins++ &#8212; one atomic command:</text>
  <rect x="466" y="158" width="370" height="30" rx="4" fill="#fff" stroke="#86efac"/>
  <text x="476" y="177" fill="#166534" font-size="10" font-family="ui-monospace,monospace">HINCRBY user:9 logins 1</text>
  <rect x="466" y="196" width="370" height="32" rx="4" fill="#bbf7d0" stroke="#16a34a"/>
  <text x="651" y="216" text-anchor="middle" fill="#14532d" font-size="9" font-weight="bold">One round trip, atomic, no race. Faster AND correct.</text>

  <rect x="24" y="252" width="832" height="200" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="274" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Serialization format: size vs speed vs readability (same object)</text>

  <rect x="48" y="290" width="256" height="146" rx="6" fill="#fff" stroke="#64748b"/>
  <text x="176" y="310" text-anchor="middle" fill="#334155" font-size="11" font-weight="bold">JSON</text>
  <rect x="64" y="320" width="224" height="18" rx="3" fill="#fca5a5"/>
  <text x="176" y="333" text-anchor="middle" fill="#7f1d1d" font-size="9">~100 bytes (largest)</text>
  <text x="64" y="356" fill="#475569" font-size="9">+ human-readable, debuggable</text>
  <text x="64" y="372" fill="#475569" font-size="9">+ schema-free, everywhere</text>
  <text x="64" y="392" fill="#475569" font-size="9">&#8722; largest, slowest to parse</text>
  <text x="64" y="414" fill="#334155" font-size="9" font-weight="bold">use: default, small values, debugging</text>

  <rect x="312" y="290" width="256" height="146" rx="6" fill="#fff" stroke="#64748b"/>
  <text x="440" y="310" text-anchor="middle" fill="#334155" font-size="11" font-weight="bold">msgpack</text>
  <rect x="328" y="320" width="150" height="18" rx="3" fill="#fcd34d"/>
  <text x="403" y="333" text-anchor="middle" fill="#713f12" font-size="9">~65 bytes</text>
  <text x="328" y="356" fill="#475569" font-size="9">+ 20&#8211;50% smaller than JSON</text>
  <text x="328" y="372" fill="#475569" font-size="9">+ schema-free, near drop-in</text>
  <text x="328" y="392" fill="#475569" font-size="9">&#8722; not human-readable</text>
  <text x="328" y="414" fill="#334155" font-size="9" font-weight="bold">use: JSON hurts, no schema wanted</text>

  <rect x="576" y="290" width="256" height="146" rx="6" fill="#fff" stroke="#64748b"/>
  <text x="704" y="310" text-anchor="middle" fill="#334155" font-size="11" font-weight="bold">protobuf</text>
  <rect x="592" y="320" width="96" height="18" rx="3" fill="#86efac"/>
  <text x="640" y="333" text-anchor="middle" fill="#14532d" font-size="9">~45 bytes (smallest)</text>
  <text x="592" y="356" fill="#475569" font-size="9">+ smallest, fastest</text>
  <text x="592" y="372" fill="#475569" font-size="9">+ schema = integer field tags</text>
  <text x="592" y="392" fill="#475569" font-size="9">&#8722; needs .proto + codegen</text>
  <text x="592" y="414" fill="#334155" font-size="9" font-weight="bold">use: high scale, latency-critical</text>
</svg>
```

### Encodings and the cost of a key

The memory argument for hashes rests on two facts. First, **every top-level key has fixed overhead** — an entry in the global keyspace dictionary, an object header, and (if it has a TTL) a slot in the expires dictionary — on the order of ~50–100 bytes *before* the value itself. A million tiny string keys pay that overhead a million times. Second, **small hashes are stored as a listpack** — a single flat, contiguously-allocated array of field/value pairs — which is dramatically more compact than a full hash table with its buckets and pointers, and which amortises one key's overhead across all its fields.

Put together: storing a hundred small values as fields of *one* hash costs roughly one key's overhead plus a compact listpack, whereas storing them as a hundred separate string keys costs a hundred keys' overhead plus a hundred small allocations. This is the entire basis of the Instagram technique in §4.

The catch is the **threshold**. A hash stays a listpack only while it has at most `hash-max-listpack-entries` fields (default 128) *and* every value is at most `hash-max-listpack-value` bytes (default 64). Cross either and Redis silently converts the whole hash to a hash table, and its memory can jump several-fold. The listpack is also O(N) to search internally, so keeping it small is good for CPU too. The design lever, therefore, is to size your buckets so each hash stays comfortably under the entry threshold and each field value under the value threshold.

## 4. Architecture & Workflow

### Choosing container and format

The decision procedure:

1. **Whole-object access only?** → **string**. Serialize (§3 format choice) and `SET`/`GET`. Stop here unless you need field access.
2. **Field-level reads or updates?** → **hash**. `HSET`/`HGET`/`HMGET`, and `HINCRBY` for atomic counters. Flat objects only — nesting must be flattened or stored as serialized field values.
3. **Which format?** Start with **JSON** for readability. Move to **msgpack** when size/CPU hurts and you want no schema. Move to **protobuf** when you are at scale, have stable schemas, and need the smallest/fastest.
4. **Large values (multi-KB)?** Consider **compression** (zstd/lz4) on the serialized bytes before storing — but measure, because for small values the compressor's own overhead and CPU cost do not pay off.
5. **Millions of small key-value pairs?** Apply the **Instagram technique**: bucket them into hashes kept under the listpack threshold.

### The Instagram technique: shard a flat keyspace into hashes

Instagram needed to map hundreds of millions of media IDs to user IDs — a flat key→value mapping. Stored as string keys (`media:1155315` → `"3"`), each pair paid the full per-key overhead, and the total was punishingly large. The fix: **bucket** the keys. Take the ID, divide by a bucket size (say 1000), use the quotient as the hash key and the remainder (or the full ID) as the field:

```
media:1155315 -> 3
   becomes
HSET media_bucket:1155 315 3     (bucket = 1155315 / 1000, field = 1155315 % 1000)
```

Now a thousand pairs share one key's overhead and live in one listpack. Instagram tuned `hash-max-ziplist-entries` (the older name for the listpack threshold) to keep each bucket compact and reported memory dropping from ~70 MB to ~16 MB per million keys — roughly a 5× saving. The technique generalises to any large flat mapping: bucket the key space so each hash holds a few hundred to a thousand fields, staying in listpack encoding, and you convert per-key overhead into near-zero amortised cost.

```svg
<svg viewBox="0 0 880 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The Instagram technique: bucket a flat keyspace into listpack hashes</text>

  <rect x="24" y="44" width="400" height="356" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="224" y="66" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Before: one string key per pair</text>
  <g font-size="9" font-family="ui-monospace,monospace" fill="#7f1d1d">
    <rect x="44" y="80" width="360" height="22" rx="3" fill="#fff" stroke="#fca5a5"/><text x="54" y="95">media:1155315 &#8594; "3"</text>
    <rect x="44" y="106" width="360" height="22" rx="3" fill="#fff" stroke="#fca5a5"/><text x="54" y="121">media:1155316 &#8594; "8"</text>
    <rect x="44" y="132" width="360" height="22" rx="3" fill="#fff" stroke="#fca5a5"/><text x="54" y="147">media:1155317 &#8594; "3"</text>
    <text x="54" y="170" font-family="ui-sans-serif,system-ui,sans-serif">... hundreds of millions of keys ...</text>
  </g>
  <rect x="44" y="188" width="360" height="90" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="224" y="208" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">Each key pays fixed overhead</text>
  <text x="60" y="228" fill="#991b1b" font-size="9">&#8226; keyspace dict entry + object header</text>
  <text x="60" y="244" fill="#991b1b" font-size="9">&#8226; expires slot (if TTL)</text>
  <text x="60" y="260" fill="#991b1b" font-size="9">&#8226; ~50&#8211;100 bytes overhead PER pair</text>
  <rect x="44" y="292" width="360" height="90" rx="6" fill="#fff" stroke="#dc2626" stroke-width="2"/>
  <text x="224" y="326" text-anchor="middle" fill="#b91c1c" font-size="20" font-weight="bold">~70 MB / million</text>
  <text x="224" y="356" text-anchor="middle" fill="#991b1b" font-size="10">overhead dominates tiny values</text>

  <rect x="456" y="44" width="400" height="356" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="656" y="66" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">After: bucket into hashes</text>
  <text x="476" y="86" fill="#166534" font-size="9" font-family="ui-monospace,monospace">bucket = id / 1000   field = id % 1000</text>
  <g font-size="9" font-family="ui-monospace,monospace" fill="#14532d">
    <rect x="476" y="96" width="360" height="70" rx="4" fill="#fff" stroke="#86efac"/>
    <text x="486" y="114" font-weight="bold">HASH media_bucket:1155</text>
    <text x="496" y="132">315 &#8594; 3</text>
    <text x="496" y="148">316 &#8594; 8</text>
    <text x="596" y="132">317 &#8594; 3</text>
    <text x="596" y="148">... up to ~1000 fields</text>
  </g>
  <rect x="476" y="176" width="360" height="96" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="656" y="196" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">One key's overhead per ~1000 pairs</text>
  <text x="492" y="216" fill="#166534" font-size="9">&#8226; stored as a compact LISTPACK</text>
  <text x="492" y="232" fill="#166534" font-size="9">&#8226; stay under hash-max-listpack-entries</text>
  <text x="492" y="248" fill="#166534" font-size="9">&#8226; overhead amortised to near zero</text>
  <text x="492" y="266" fill="#166534" font-size="9">&#8226; HGET bucket field &#8594; still O(1)-ish</text>
  <rect x="476" y="286" width="360" height="96" rx="6" fill="#fff" stroke="#16a34a" stroke-width="2"/>
  <text x="656" y="320" text-anchor="middle" fill="#15803d" font-size="20" font-weight="bold">~16 MB / million</text>
  <text x="656" y="350" text-anchor="middle" fill="#166534" font-size="10">roughly 5&#215; less memory</text>
</svg>
```

### Partial updates and reads in practice

Beyond memory, hashes give you a partial-update and partial-read vocabulary that strings cannot:

- `HSET key field val` — set/overwrite one field, leaving the rest untouched.
- `HMGET key f1 f2` — fetch only the two fields you need, not the whole object.
- `HINCRBY` / `HINCRBYFLOAT` — atomic numeric mutation of one field.
- `HDEL` — remove a field.
- `HGETALL` — the whole object when you do need it (but O(N) — avoid on large hashes; prefer `HSCAN` or targeted `HMGET`).

These map onto real workloads: a session where you refresh only `last_seen`, a product where you bump only `stock`, a profile where you read only `avatar_url` for a thumbnail. Each is one round trip instead of a full round-trip-plus-serialize cycle, and each is atomic.

## 5. Implementation

Real, runnable go-redis code contrasting the string-blob and hash approaches, showing the three serialization formats, and demonstrating the Instagram bucketing.

```go
package objectcache

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/vmihailenco/msgpack/v5" // msgpack: compact, schema-free
)

// User is the object we cache throughout. In a hash, each exported field
// becomes a Redis field; as a string, the whole struct is serialized.
type User struct {
	Name   string `json:"name" msgpack:"name"`
	Email  string `json:"email" msgpack:"email"`
	Logins int64  `json:"logins" msgpack:"logins"`
}

// ---------- STRING BLOB: whole-object, opaque ----------

// SetUserJSON caches the user as a JSON string. Correct when you ALWAYS read
// and write the whole object. Readable with `redis-cli GET user:blob:9`.
func SetUserJSON(ctx context.Context, rdb *redis.Client, id string, u User) error {
	data, err := json.Marshal(u)
	if err != nil {
		return err
	}
	// One SET, whole object, with a TTL. Simple and correct for whole-object use.
	return rdb.Set(ctx, "user:blob:"+id, data, 30*time.Minute).Err()
}

// BumpLoginsBlob shows the read-modify-write HAZARD a string blob forces on you.
// It is TWO round trips, TWO serialize passes, and RACY: a concurrent caller can
// read the same old value between our GET and SET and clobber our increment.
// This function exists to be contrasted with BumpLoginsHash below — do not ship
// per-field mutations against a blob under concurrency.
func BumpLoginsBlob(ctx context.Context, rdb *redis.Client, id string) error {
	raw, err := rdb.Get(ctx, "user:blob:"+id).Bytes() // round trip 1
	if err != nil {
		return err
	}
	var u User
	if err := json.Unmarshal(raw, &u); err != nil { // decode whole object
		return err
	}
	u.Logins++ // mutate in the client — NOT atomic across clients
	data, err := json.Marshal(u) // re-encode whole object
	if err != nil {
		return err
	}
	return rdb.Set(ctx, "user:blob:"+id, data, redis.KeepTTL).Err() // round trip 2
}

// ---------- HASH: field-addressable ----------

// SetUserHash caches the user as a hash: one field per attribute. HSet takes a
// struct via go-redis reflection (uses the `redis:"..."` or field names), but we
// pass explicit field/value pairs to be unambiguous about the wire layout.
func SetUserHash(ctx context.Context, rdb *redis.Client, id string, u User) error {
	key := "user:hash:" + id
	// Set all fields in one round trip. Values are stored as their string form;
	// keep each under hash-max-listpack-value (64 bytes) to stay in listpack.
	if err := rdb.HSet(ctx, key,
		"name", u.Name,
		"email", u.Email,
		"logins", u.Logins,
	).Err(); err != nil {
		return err
	}
	// TTL is per KEY (a hash cannot expire individual fields on older Redis).
	return rdb.Expire(ctx, key, 30*time.Minute).Err()
}

// BumpLoginsHash is the correct counterpart: ONE atomic command, ONE round trip,
// NO race. The read-modify-write happens inside Redis's single thread, so
// concurrent callers cannot lose updates.
func BumpLoginsHash(ctx context.Context, rdb *redis.Client, id string) (int64, error) {
	return rdb.HIncrBy(ctx, "user:hash:"+id, "logins", 1).Result()
}

// ReadEmailOnly fetches a SINGLE field — no need to transfer the whole object.
// Contrast the blob, where reading one field means GET + decode of everything.
func ReadEmailOnly(ctx context.Context, rdb *redis.Client, id string) (string, error) {
	return rdb.HGet(ctx, "user:hash:"+id, "email").Result()
}

// ReadNameAndLogins fetches exactly the two fields we need in one round trip.
func ReadNameAndLogins(ctx context.Context, rdb *redis.Client, id string) ([]any, error) {
	return rdb.HMGet(ctx, "user:hash:"+id, "name", "logins").Result()
}

// ---------- SERIALIZATION FORMAT CHOICES ----------

// serializeMsgpack encodes with msgpack: typically 20-50% smaller than JSON and
// faster to parse, schema-free, but NOT human-readable. A near drop-in when
// JSON's size or CPU starts to hurt.
func serializeMsgpack(u User) ([]byte, error) {
	return msgpack.Marshal(u)
}

// SetUserMsgpack caches the object as a compact msgpack blob in a string.
func SetUserMsgpack(ctx context.Context, rdb *redis.Client, id string, u User) error {
	data, err := serializeMsgpack(u)
	if err != nil {
		return err
	}
	return rdb.Set(ctx, "user:mp:"+id, data, 30*time.Minute).Err()
}

// NOTE on protobuf: with a generated `pb.User`, you would `proto.Marshal(&pbUser)`
// to get the SMALLEST, FASTEST bytes (field names become integer tags, no
// self-description travels in the payload), then SET/GET exactly like msgpack.
// The cost is maintaining the .proto schema and generated code, and values are
// unreadable without the schema. Reach for it at scale and in hot paths.

// ---------- COMPRESSION for large values ----------

// SetLargeCompressed gzips a large serialized value before storing. Worth it
// only for multi-KB values where the CPU cost is repaid by memory and network
// savings; for small values the compressor's overhead makes it a net loss.
func SetLargeCompressed(ctx context.Context, rdb *redis.Client, key string, payload []byte) error {
	if len(payload) < 1024 {
		// Below ~1 KB compression rarely pays — store raw and skip the CPU.
		return rdb.Set(ctx, key, payload, time.Hour).Err()
	}
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write(payload); err != nil {
		return err
	}
	if err := zw.Close(); err != nil { // MUST close to flush the gzip trailer
		return err
	}
	// Prefix marks the value as compressed so the reader knows to inflate.
	return rdb.Set(ctx, key, append([]byte("gz:"), buf.Bytes()...), time.Hour).Err()
}

func GetMaybeCompressed(ctx context.Context, rdb *redis.Client, key string) ([]byte, error) {
	raw, err := rdb.Get(ctx, key).Bytes()
	if err != nil {
		return nil, err
	}
	if !bytes.HasPrefix(raw, []byte("gz:")) {
		return raw, nil // stored raw
	}
	zr, err := gzip.NewReader(bytes.NewReader(raw[3:]))
	if err != nil {
		return nil, err
	}
	defer zr.Close()
	return io.ReadAll(zr)
}

// ---------- THE INSTAGRAM TECHNIQUE: bucket a flat keyspace into hashes ----------

const bucketSize = 1000 // ~1000 fields per hash keeps it a compact listpack

// PutMapping stores id -> value not as one string key per id (which pays full
// per-key overhead), but bucketed into hashes: bucket = id/1000 is the hash key,
// field = id%1000. A thousand pairs then share one key's overhead in one
// listpack — the ~5x memory saving Instagram reported.
func PutMapping(ctx context.Context, rdb *redis.Client, id int64, value string) error {
	bucket := id / bucketSize
	field := strconv.FormatInt(id%bucketSize, 10)
	key := fmt.Sprintf("map:%d", bucket)
	return rdb.HSet(ctx, key, field, value).Err()
}

// GetMapping reads a bucketed value back with a single HGET.
func GetMapping(ctx context.Context, rdb *redis.Client, id int64) (string, error) {
	bucket := id / bucketSize
	field := strconv.FormatInt(id%bucketSize, 10)
	return rdb.HGet(ctx, fmt.Sprintf("map:%d", bucket), field).Result()
}
```

The through-line: for whole-object access a string is right, and the only real decision is the serialization format (JSON for readability, msgpack/protobuf for size and speed); for field access a hash is right and turns racy multi-step blob updates into single atomic commands; and at scale, bucketing millions of small pairs into listpack hashes is a first-class memory optimisation.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages of hashes for objects**
- **Atomic field updates.** `HINCRBY`/`HSET` mutate one field server-side in one round trip, with no read-modify-write race.
- **Partial reads and writes.** Fetch only the fields you need (`HMGET`); write only the fields that changed — less bandwidth, less CPU.
- **Memory efficiency for small objects.** Listpack encoding plus one key's amortised overhead makes small hashes far cheaper than the same data as many strings.
- **Field-level clarity.** The object's structure is visible in Redis (`HKEYS`, `HGETALL`) rather than buried in an opaque blob.

**Advantages of string blobs**
- **Simplicity.** One `SET`, one `GET`, one serialize — nothing to reason about per field.
- **Arbitrary structure.** Nested and deeply-structured objects serialize cleanly; hashes are flat.
- **Atomic whole-object writes.** A single `SET` replaces the entire object consistently.
- **Format flexibility.** Trivially swap JSON for msgpack or protobuf; the container does not care.

**Disadvantages**
- **Blob per-field updates are racy and chatty** — two round trips and a lost-update hazard.
- **Hashes are flat** — nesting must be flattened or stored as serialized field values, losing field-addressability for the nested parts.
- **Hash TTL is per key** — you cannot expire individual fields on older Redis (per-field TTL is a very recent addition).
- **Encoding cliff** — cross `hash-max-listpack-entries`/`-value` and a hash's memory jumps several-fold, often silently.

**Trade-offs**
- *String vs hash:* choose by whether you address fields. Whole-object access → string (simplest, nesting-friendly); field access → hash (atomic, partial, memory-efficient for small objects).
- *JSON vs msgpack vs protobuf:* readability and ubiquity (JSON) vs size and speed (msgpack, then protobuf) vs schema/operational cost (protobuf). Start readable, get compact as scale demands.
- *Compress or not:* compression trades CPU for memory and network bytes — a clear win for large values, a net loss for small ones where the compressor overhead dominates.
- *Bucket size for the Instagram technique:* larger buckets amortise overhead better but risk crossing the listpack threshold (memory jump) and making `HGETALL`/`HSCAN` costlier; tune to stay compact.

## 7. Common Mistakes & Best Practices

- **Storing everything as a JSON string and then updating one field.** This forces the read-modify-write hazard — two round trips and a lost-update race — on every field mutation. **Best practice:** if you address fields, use a hash and `HSET`/`HINCRBY`.
- **`HGETALL` on a large hash.** It is O(N) and transfers the whole object; on a big hash it both stalls the single thread and wastes bandwidth. **Best practice:** use `HMGET` for the fields you need, or `HSCAN` to iterate.
- **Ignoring the listpack threshold.** A hash silently converts to a hash table past 128 entries or a 64-byte value, multiplying its memory. **Best practice:** size buckets to stay under the threshold; check with `OBJECT ENCODING`.
- **Compressing small values.** The compressor's header and CPU cost make sub-kilobyte values *larger* or not worth it. **Best practice:** compress only above a measured size threshold (~1 KB+), and mark compressed values so readers can inflate.
- **Choosing protobuf for its size without needing it.** The schema and codegen overhead is real; for small-scale or debug-heavy caches JSON's readability wins. **Best practice:** default to JSON, move to msgpack/protobuf when profiling shows size or CPU is the bottleneck.
- **Assuming a hash gives per-field TTL.** On most deployments a hash expires as a whole key. **Best practice:** if fields must expire independently, use separate keys or the recent per-field TTL feature if available.
- **Repeating verbose field names in every value.** Long JSON keys ("emailAddress") multiply across millions of values. **Best practice:** short field names, or a schema format (protobuf) where names become integer tags.
- **Best practice overall: match container to access pattern and format to scale.** Whole-object → string; per-field → hash; readable/small-scale → JSON; large-scale/hot-path → msgpack or protobuf; large values → compress; millions of tiny pairs → bucket into listpack hashes.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** `OBJECT ENCODING key` is the first tool — it shows `listpack` vs `hashtable` for a hash, `embstr`/`raw`/`int` for a string, telling you whether a hash has crossed its threshold. `MEMORY USAGE key` gives the byte cost of a specific key, and `TYPE key` confirms container. `HRANDFIELD` and `HLEN` help inspect a hash without an O(N) `HGETALL`.
- **Monitoring.** Track memory per keyspace prefix and watch for encoding transitions on hot hashes — a hash flipping from listpack to hashtable can multiply memory without any obvious cause. Watch serialized value sizes; a growing average value size signals objects bloating (add a field, forget to compress) and predicts memory pressure. `MEMORY DOCTOR` flags big keys and encoding issues.
- **Security.** The container does not change the security model, but the *content* does — a hash or blob holding PII (email, address) inherits that sensitivity, so it belongs on an authenticated, TLS-protected instance with ACLs restricting who can read those keyspaces (chapter 29). Compression is not encryption; do not conflate a gzipped value with a protected one. If you cache tokens or secrets, they need short TTLs and encryption at the application layer.
- **Scaling.** A single enormous hash is a **big key** — all its fields live on one Cluster slot, concentrating memory and latency on one node, and any `HGETALL` over it blocks that node's thread for everyone. The Instagram bucketing is also a *sharding* strategy: many bucket hashes distribute across the cluster (different bucket keys hash to different slots), where one giant hash cannot. Size buckets so no single hash becomes a hotspot, and prefer many small hashes to one large one for both memory and distribution.

## 9. Interview Questions

**Q: When would you cache an object as a string versus a hash?**
A: As a string when you always read and write the whole object together and never mutate a single field in isolation — you serialize it, `SET` with a TTL, and `GET`-and-decode. As a hash when you address individual fields: `HGET user:9 email` reads one field in one round trip, and `HINCRBY user:9 logins 1` updates one field atomically without touching the rest. The hash is also more memory-efficient for small objects because of the compact listpack encoding and amortised key overhead. The string wins on simplicity and on nested structure (hashes are flat); the hash wins on atomic field updates, partial reads, and small-object memory.

**Q: Why is updating one field of a JSON string blob a problem?**
A: Because it forces a read-modify-write cycle: `GET` the value, decode it, mutate the field in the client, re-encode, and `SET` it back. That is two round trips and two serialize passes instead of one command, and — critically — it is racy: a concurrent updater can read the same old value between your `GET` and `SET` and overwrite your change, a classic lost update. A hash's `HSET`/`HINCRBY` does the same field update as a single atomic command inside Redis's single thread, so it is both faster and correct.

**Q: Compare JSON, msgpack and protobuf for serializing cached objects.**
A: JSON is text — human-readable, debuggable with `redis-cli`, schema-free, supported everywhere — but the largest (repeated string field names, numbers as decimal text) and slowest to parse. msgpack is binary JSON: the same schema-free model encoded compactly, typically 20–50% smaller and faster, at the cost of not being readable — a near drop-in when JSON's size or CPU hurts. protobuf is schema-driven: field names become integer tags and no self-description travels in the payload, making it the smallest and fastest, but you maintain `.proto` schemas and generated code and values are unreadable without the schema. The progression is readability → compactness → schema cost; default to JSON and move rightward as scale demands.

**Q: What is the listpack encoding and why does it matter here?**
A: Redis stores a small hash as a listpack — a single flat, contiguously-allocated array of field/value pairs — rather than a full hash table with buckets and pointers, which is far more memory-efficient and amortises the one key's overhead across all its fields. It stays a listpack only while it has at most `hash-max-listpack-entries` fields (default 128) and every value is at most `hash-max-listpack-value` bytes (default 64); cross either and it converts to a hash table and its memory can jump several-fold. For object caching this is the lever behind hashes being cheaper than many strings, and the reason to size buckets to stay under the threshold.

**Q: When should you compress cached values, and when not?**
A: Compress large serialized values — multi-kilobyte blobs where the CPU cost of gzip/zstd/lz4 is repaid by real memory and network savings. Do not compress small values: the compressor's own header and CPU overhead make sub-kilobyte values not worth it and sometimes larger. Measure and set a size threshold (commonly ~1 KB), compress only above it, and mark compressed values (a prefix byte) so the reader knows to inflate. And remember compression is not encryption — a gzipped value is not a protected one.

**Q: (Senior) Explain the Instagram technique for slashing memory, and its limits.**
A: Instagram had a large flat mapping — media ID → user ID — stored as one string key per pair. Each key paid ~50–100 bytes of fixed overhead (keyspace dict entry, object header, expires slot) that dwarfed the tiny value, so hundreds of millions of pairs cost enormous memory. The fix is to bucket: divide the ID by a bucket size (say 1000), use the quotient as a hash key and the remainder as the field, so a thousand pairs share one key's overhead and live in one compact listpack. They reported roughly a 5× reduction (about 70 MB down to 16 MB per million). The limits are the listpack threshold — buckets must stay under `hash-max-listpack-entries`/`-value` or they convert to hash tables and lose the saving — and access-pattern cost: `HGETALL`/`HSCAN` over a bucket is O(N), and a badly-chosen bucket size either wastes the amortisation (too small) or risks the encoding cliff and big-key latency (too large). It also affects Cluster distribution: bucket keys spread across slots where one giant hash would not, which is a bonus, but you must ensure buckets stay small enough to avoid hotspots. Tuning the bucket size against the threshold is the whole art.

**Q: (Senior) How does container and format choice interact with Redis Cluster and big keys?**
A: A key's Cluster slot derives from its name, so all of a single hash's fields live on one node. That makes a giant hash a big key: it concentrates its entire memory and command latency on one shard, becomes a hotspot for reads and writes, and any O(N) operation over it (`HGETALL`) blocks that node's single thread for everyone on the shard. A string blob has the same big-key hazard if the value is multi-megabyte — every command touching it is slow and every transfer large. So at scale the container and format choices must be paired with a distribution strategy: bucket large logical structures into many hashes keyed so they hash to different slots (the Instagram technique doubles as sharding), keep individual values small (favouring compact formats like protobuf and compression for large payloads), and avoid the single-giant-key anti-pattern. The format also affects the transfer cost of every command — a protobuf value is smaller on the wire than JSON, which matters on hot keys and across a cluster's network. The unifying principle is: many small, compact keys distribute and stay fast; one large key concentrates and stalls.

**Q: (Senior) A cached object's memory usage jumped after a deploy. How do you diagnose it?**
A: I would start with `OBJECT ENCODING` on a sample of the affected keys. For a hash, a jump from `listpack` to `hashtable` means the object crossed `hash-max-listpack-entries` (a new field pushed it past 128) or a value crossed `hash-max-listpack-value` (a field grew past 64 bytes) — the deploy likely added a field or let a field grow. For a string, `embstr` to `raw` at 44 bytes is normal, but a large size means the serialized value grew. `MEMORY USAGE key` quantifies the per-key cost, and comparing average value size before and after the deploy (via sampling) confirms bloat. The fixes depend on cause: if a hash legitimately grew large, the hashtable encoding is correct and the answer may be to split it or accept the cost; if I was relying on compactness, I re-bucket to keep hashes under the threshold, shorten field names, or move a large field to compression or a separate key. I would also check whether the deploy switched serialization format (someone swapped protobuf for JSON, tripling size) or disabled compression. The tooling chain is `OBJECT ENCODING` → `MEMORY USAGE` → value-size sampling → `MEMORY DOCTOR`, and the fix is almost always to shape the data back to compact rather than to widen the thresholds.

**Q: Can a hash have a TTL on individual fields?**
A: Traditionally no — a hash expires as a whole key, and there is no per-field expiry, which is a real limitation when different fields have different lifetimes (a session's `csrf_token` should expire before its `preferences`). Recent Redis versions have added per-field TTL commands (`HEXPIRE` and friends), but you cannot rely on them being present everywhere. The portable pattern when fields need independent expiry is to store them as separate keys (each with its own TTL) rather than one hash, accepting the extra key overhead in exchange for per-value expiry, or to store a per-field expiry timestamp inside the hash and filter on read.

**Q: Why prefer short field names in cached objects?**
A: Because in JSON and msgpack the field names are stored as strings in *every* value, so a verbose name like `emailAddress` costs those bytes once per cached object — across millions of objects that is real memory and network transfer. Short names (`e`, or at least `email`) shrink every value. The schema-driven formats sidestep this entirely: protobuf encodes field identity as an integer tag from the schema, so the name never travels in the payload at all. If you are stuck with a self-describing format at scale, short field names are a cheap, mechanical memory win; if you can adopt a schema format, the problem disappears.

## 10. Quick Revision & Cheat Sheet

| Question | Answer |
|---|---|
| Whole-object access? | String blob (`SET`/`GET`) |
| Field-level read/update? | Hash (`HGET`/`HSET`/`HINCRBY`/`HMGET`) |
| Readable, small-scale, debug-heavy? | JSON |
| JSON too big/slow, no schema? | msgpack (20–50% smaller) |
| High scale, hot path, stable schema? | protobuf (smallest, fastest) |
| Large values (multi-KB)? | Compress (zstd/lz4/gzip) above ~1 KB |
| Millions of tiny pairs? | Bucket into listpack hashes (Instagram) |

| Encoding lever | Value |
|---|---|
| `hash-max-listpack-entries` | 128 (fields before hashtable) |
| `hash-max-listpack-value` | 64 bytes (value size before hashtable) |
| Per-key overhead | ~50–100 bytes (dict + header + expiry) |
| Instagram result | ~70 MB → ~16 MB per million (~5×) |

**Flash cards**
- **String or hash?** → Whole object → string; per-field → hash.
- **Why is blob field-update bad?** → Read-modify-write: two round trips + lost-update race.
- **JSON vs msgpack vs protobuf?** → Readable/big vs compact/schema-free vs smallest/schema-driven.
- **Listpack threshold?** → ≤128 fields AND ≤64-byte values, else hashtable (memory jump).
- **Instagram technique?** → Bucket flat keyspace into hashes; amortise key overhead; ~5× saving.
- **Compress when?** → Large values only; never sub-kilobyte.

## 11. Hands-On Exercises & Mini Project

- [ ] Cache the same object as a JSON string and as a hash; update one field in each, counting round trips, and measure both with `MEMORY USAGE`.
- [ ] Serialize a representative object as JSON, msgpack and protobuf; compare byte sizes and encode/decode times.
- [ ] Build a hash with 128 small fields, check `OBJECT ENCODING`, add one more, and watch it flip from `listpack` to `hashtable` with a memory jump.
- [ ] Implement the Instagram bucketing for a million ID→value pairs and compare total memory to a million string keys.
- [ ] Compress a 10 KB value and a 100-byte value; show the large one shrinks and the small one does not pay off.
- [ ] Reproduce the read-modify-write race: two goroutines bumping a JSON-blob counter, and show lost updates; then repeat with `HINCRBY` and show none.

### Mini Project — "Object Cache Bench"

**Goal.** Build one object cache with pluggable container and format, and measure the full cost matrix — round trips, memory, CPU, correctness — so the choices become instinct rather than folklore.

**Requirements.**
1. Implement a `UserCache` interface with two containers (string blob, hash) and three formats (JSON, msgpack, protobuf) for the blob path.
2. Benchmark: whole-object read/write, single-field read, single-field update — counting round trips and timing each container/format combination.
3. Measure memory with `MEMORY USAGE` for each representation across 10k cached objects.
4. Demonstrate correctness: run concurrent single-field increments against the blob (show lost updates) and the hash (show none).
5. Implement the Instagram bucketing for a large flat mapping and chart memory vs a per-key baseline.

**Extensions.**
- Add compression to the blob path with a size threshold and chart memory-vs-CPU as the value size grows.
- Add an encoding-transition probe that records, per hash, whether it is still a listpack, and alerts when a hot hash crosses the threshold.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Redis Data Types & Which to Cache With* (the type map this chapter drills into), *Redis as a Cache* (why atomic field updates matter), *Sorted Sets: Rate Limiting, Leaderboards & Windows* (another type's atomic superpower), *HyperLogLog, Bitmaps & Probabilistic Caching* (trading exactness for memory), *Memory, maxmemory & Eviction* (the RAM budget these choices spend).

- **Redis — Hashes data type** — Redis · *Beginner* · the authoritative reference for hash commands and their complexity, the field-addressable container of this chapter. <https://redis.io/docs/latest/develop/data-types/hashes/>
- **Redis — Memory optimization & encodings** — Redis · *Intermediate* · how listpacks work, the thresholds, and why small collections are cheap; the basis of the memory argument. <https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/memory-optimization/>
- **Instagram Engineering — Storing hundreds of millions of key-value pairs in Redis** — Instagram · *Advanced* · the original case study of bucketing a flat keyspace into hashes for a ~5× memory win. <https://instagram-engineering.com/storing-hundreds-of-millions-of-simple-key-value-pairs-in-redis-1091ae80f74c>
- **MessagePack — specification** — msgpack.org · *Intermediate* · the compact binary format and its data model, the schema-free upgrade from JSON. <https://msgpack.org/>
- **Protocol Buffers — Overview** — Google · *Intermediate* · the schema-driven format with integer field tags; smallest and fastest serialization. <https://protobuf.dev/overview/>
- **Redis — SET / HSET / HINCRBY command docs** — Redis · *Beginner* · the exact semantics of the commands this chapter uses, including `KEEPTTL` and atomicity. <https://redis.io/docs/latest/commands/hincrby/>
- **RedisJSON (JSON module)** — Redis · *Advanced* · when you want field-addressable access to *nested* JSON server-side, a middle path between blob and flat hash. <https://redis.io/docs/latest/develop/data-types/json/>
- **Designing Data-Intensive Applications, ch. 4 (Encoding & Evolution)** — Martin Kleppmann · *Advanced* · the definitive treatment of serialization formats, schema evolution and their trade-offs. <https://dataintensive.net/>

---

*Caching with Redis Handbook — chapter 18.*
