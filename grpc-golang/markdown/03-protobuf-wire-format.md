# 03 · Protocol Buffers: Binary Wire Format & Why It's Fast

> **In one line:** Protocol Buffers encode a message as a sequence of `(field-number, wire-type, value)` triples with no field names, no punctuation and no whitespace — which is simultaneously why they are 3–10× smaller than JSON, an order of magnitude faster to parse, and completely unreadable without the schema.

---

## 1. Overview

Protocol Buffers ("protobuf") is Google's language-neutral, platform-neutral mechanism for serialising structured data, in production since 2001 and open-sourced in 2008. gRPC uses it as the default codec, but the two are separable: protobuf is used without gRPC (in files, in Kafka, in caches) and gRPC can carry other codecs. Understanding the encoding is what turns vague claims about "binary is faster" into engineering judgement — you will know exactly how many bytes a field costs, why field number 16 is more expensive than field number 15, and why `int64` and `sint64` behave so differently for negative numbers.

The core insight is that a `.proto` schema is a **shared, out-of-band dictionary**. JSON must carry its own dictionary on every message: the string `"quantity_on_hand"` appears in every single record, costing 18 bytes plus punctuation. Protobuf replaces that with the integer `3`, packed into a single byte alongside a 3-bit type tag. The receiver knows what field 3 means because it has the same `.proto`. Remove the names, remove the quotes, remove the commas and braces, encode numbers in binary instead of decimal ASCII, and a typical record shrinks dramatically.

The second insight is that **parsing becomes a tight loop over a byte slice**. A JSON parser must scan for delimiters, handle escapes, allocate strings for keys, hash those keys against struct fields, and convert decimal text to numbers. A protobuf parser reads a varint tag, switches on three bits of wire type, and either reads a fixed number of bytes or a length prefix followed by that many bytes. There is no ambiguity, no backtracking, no string interning, and — in Go — very little allocation beyond the message struct itself.

The costs are equally concrete: the payload is opaque without the schema, so logging, debugging and ad-hoc inspection all require tooling; and the format's forward/backward compatibility rules are subtle enough that a careless schema change can silently corrupt data rather than fail loudly (chapter 13).

## 2. Core Concepts

- **Field number (tag)** — the integer identity of a field, e.g. `3` in `int32 quantity_on_hand = 3;`. It, not the name, is what goes on the wire. Numbers are permanent.
- **Wire type** — 3 bits describing how to read the value: `0` varint, `1` 64-bit fixed, `2` length-delimited, `5` 32-bit fixed. (Types `3`/`4`, start/end group, are deprecated.)
- **Key byte(s)** — a varint encoding `(field_number << 3) | wire_type`. Field numbers 1–15 fit in one byte; 16–2047 take two.
- **Varint** — variable-length integer encoding, 7 bits of payload per byte with the high bit as a continuation flag. Small numbers are small.
- **ZigZag** — the mapping used by `sint32`/`sint64` so that small negative numbers stay small: `(n << 1) ^ (n >> 31)`.
- **Length-delimited (LEN)** — a varint length followed by that many bytes; used for `string`, `bytes`, embedded messages and packed repeated fields.
- **Packed repeated** — in proto3, repeated scalar numeric fields are encoded as a single length-delimited run rather than one key per element. Default and much cheaper.
- **Default values** — proto3 scalars have implicit defaults (`0`, `""`, `false`) and fields equal to the default are **not serialised at all**. This is the root of the "field presence" issue.
- **Unknown fields** — fields the receiver's schema does not recognise are preserved (in Go, in `unknownFields`) and re-emitted on marshal, which is what makes proxies and partial upgrades safe.
- **Canonical JSON mapping** — protobuf defines an official JSON representation (`protojson`), used by grpc-gateway and for human-readable logs.

## 3. Theory & Principles

### Varint encoding, byte by byte

A varint stores an integer in one to ten bytes. Each byte contributes seven bits of payload; the most significant bit (the *continuation bit*) is `1` if more bytes follow. Bytes are little-endian in group order.

Encode `300`:

```
300 decimal            = 1 0010 1100 binary
split into 7-bit groups (low group first):
  low  7 bits: 010 1100  = 0x2C
  high remainder: 10     = 0x02
set continuation bit on all but the last:
  byte 0: 1010 1100 = 0xAC
  byte 1: 0000 0010 = 0x02
→ 0xAC 0x02   (2 bytes)
```

So `1` costs 1 byte, `300` costs 2, `1,000,000` costs 3, and any value ≥ 2^56 costs 9 or 10. The pathological case is **negative `int32`/`int64`**: negatives are sign-extended to 64 bits before encoding, so `-1` becomes `0xFFFFFFFFFFFFFFFF` and occupies **ten bytes**. That is what `sint32`/`sint64` exist to fix.

### ZigZag: making negatives cheap

ZigZag interleaves positive and negative numbers so that magnitudes near zero map to small unsigned values:

| Signed | ZigZag encoded | Varint bytes |
|---|---|---|
| 0 | 0 | 1 |
| −1 | 1 | 1 |
| 1 | 2 | 1 |
| −2 | 3 | 1 |
| 2147483647 | 4294967294 | 5 |
| −2147483648 | 4294967295 | 5 |

The formula for 32-bit is `(n << 1) ^ (n >> 31)` (arithmetic shift). **Rule: use `sint32`/`sint64` when values are frequently negative; use `int32`/`int64` when they are almost always non-negative; use `fixed32`/`fixed64` when values are large and uniformly distributed (hashes, ids), because a fixed 4 or 8 bytes beats a 5- or 10-byte varint.**

### The key byte and why field numbers matter

Every field is preceded by a varint key: `(field_number << 3) | wire_type`. With three bits consumed by the wire type, field numbers **1 through 15** leave four bits — the key fits in one byte. Field number **16** needs two bytes. Hence the standard advice: **reserve 1–15 for the fields that appear in every message or in repeated elements**, and push rarely-used fields higher. On a message repeated a million times, that single byte is a megabyte.

Field numbers 19000–19999 are reserved for the protobuf implementation. The maximum is 536,870,911 (2^29 − 1).

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Same record: JSON vs Protocol Buffers, byte for byte</text>

  <rect x="24" y="42" width="410" height="200" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="229" y="64" text-anchor="middle" fill="#b91c1c" font-size="13" font-weight="bold">JSON &#8212; 88 bytes</text>
  <g font-family="ui-monospace,monospace" font-size="11" fill="#7f1d1d">
    <text x="40" y="90">{"sku":"sku_1",</text>
    <text x="40" y="110"> "name":"Blue Widget",</text>
    <text x="40" y="130"> "quantity_on_hand":42,</text>
    <text x="40" y="150"> "unit_price_cents":1299}</text>
  </g>
  <g font-size="11" fill="#991b1b">
    <text x="40" y="178">&#8226; field names repeated in every record (48 B)</text>
    <text x="40" y="196">&#8226; numbers as decimal ASCII ("1299" = 4 B)</text>
    <text x="40" y="214">&#8226; quotes, colons, commas, braces (14 B)</text>
    <text x="40" y="232">&#8226; parser must scan, unescape, hash keys</text>
  </g>

  <rect x="450" y="42" width="410" height="200" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="655" y="64" text-anchor="middle" fill="#15803d" font-size="13" font-weight="bold">Protobuf &#8212; 30 bytes</text>
  <g font-family="ui-monospace,monospace" font-size="11" fill="#14532d">
    <text x="466" y="90">0A 05 73 6B 75 5F 31              field 1 LEN "sku_1"</text>
    <text x="466" y="110">12 0B 42 6C 75 65 20 57 ...       field 2 LEN "Blue Widget"</text>
    <text x="466" y="130">18 2A                             field 3 VARINT 42</text>
    <text x="466" y="150">20 93 0A                          field 4 VARINT 1299</text>
  </g>
  <g font-size="11" fill="#166534">
    <text x="466" y="178">&#8226; no names: field 3 is one key byte (0x18)</text>
    <text x="466" y="196">&#8226; 1299 = 2 varint bytes, not 4 ASCII</text>
    <text x="466" y="214">&#8226; no punctuation at all</text>
    <text x="466" y="232">&#8226; parser: read varint key, switch on 3 bits</text>
  </g>

  <rect x="24" y="258" width="836" height="196" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="442" y="282" text-anchor="middle" fill="#334155" font-size="13" font-weight="bold">Anatomy of one field: the key byte</text>
  <rect x="120" y="298" width="200" height="46" rx="6" fill="#e0e7ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="220" y="320" text-anchor="middle" fill="#3730a3" font-family="ui-monospace,monospace" font-size="14">0x18 = 0001 1000</text>
  <text x="220" y="338" text-anchor="middle" fill="#4338ca" font-size="10">one key byte</text>

  <rect x="380" y="290" width="200" height="30" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="480" y="310" text-anchor="middle" fill="#14532d">0001 1 = field number 3</text>
  <rect x="380" y="326" width="200" height="30" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="480" y="346" text-anchor="middle" fill="#92400e">000 = wire type 0 (varint)</text>

  <text x="640" y="310" fill="#475569" font-size="11">key = (field_number &#171;&#171; 3) | wire_type</text>
  <text x="640" y="330" fill="#475569" font-size="11">fields 1&#8211;15 &#8594; 1 byte &#183; 16&#8211;2047 &#8594; 2 bytes</text>
  <text x="640" y="350" fill="#475569" font-size="11">so put hot fields in 1&#8211;15</text>

  <g font-size="11" fill="#334155">
    <text x="44" y="382" font-weight="bold">wire type 0</text><text x="140" y="382">VARINT</text><text x="230" y="382">int32/64, uint32/64, sint32/64, bool, enum</text>
    <text x="44" y="402" font-weight="bold">wire type 1</text><text x="140" y="402">I64</text><text x="230" y="402">fixed64, sfixed64, double &#8212; always 8 bytes</text>
    <text x="44" y="422" font-weight="bold">wire type 2</text><text x="140" y="422">LEN</text><text x="230" y="422">string, bytes, embedded message, packed repeated</text>
    <text x="44" y="442" font-weight="bold">wire type 5</text><text x="140" y="442">I32</text><text x="230" y="442">fixed32, sfixed32, float &#8212; always 4 bytes</text>
  </g>
</svg>
```

### Default values and the presence problem

In proto3, a scalar field whose value equals its type's default is **omitted entirely from the wire**. `quantity_on_hand = 0` produces zero bytes. On the receiving side the parser leaves the Go field at its zero value, so `0` and "not set" are indistinguishable. This is fine for most data and catastrophic for a few cases — a partial update where "set price to 0" must differ from "don't touch price", or a boolean flag where `false` must be distinguishable from absent.

The fixes, in order of preference:
1. **`optional`** (re-enabled for proto3 in protobuf 3.15+): `optional int32 quantity = 3;` generates a Go pointer `*int32` and a `Has…` accessor. This is explicit field presence and is now the idiomatic answer.
2. **Wrapper well-known types** (`google.protobuf.Int32Value`) — a message wrapping a scalar, so presence is message presence. Verbose; largely superseded by `optional`.
3. **`FieldMask`** — for partial updates, name the fields being changed explicitly (chapter 10). This is the right answer for `Update…` RPCs regardless of presence.

Note that **message-typed fields always have presence** (they are pointers in Go and `nil` means absent), and `repeated`/`map` fields have no presence — empty and absent are the same.

## 4. Architecture & Workflow

How a Go struct becomes bytes and back:

1. **Codegen.** `protoc-gen-go` emits a struct plus a compact descriptor (the serialised `FileDescriptorProto`) embedded in the file's `rawDesc` bytes. The `protoimpl` runtime builds a **message type** at init: a table mapping field numbers to struct offsets, wire types and codecs.
2. **Marshal.** `proto.Marshal(m)` walks that table in field-number order. For each field it checks presence (non-default for scalars, non-nil for messages), writes the key varint, then the value in the appropriate wire form. Length-delimited fields require the length first, so the encoder either pre-computes sizes (`proto.Size`) or writes into a buffer and back-patches — grpc-go's codec uses the size-then-marshal path so it can allocate exactly once.
3. **Transport.** grpc-go's codec (`encoding/proto`) hands the bytes to the transport, which prefixes `[compressed-flag][4-byte length]` and writes DATA frames (chapter 2).
4. **Unmarshal.** The receiver loops: read a varint key, extract field number and wire type, look the number up in the field table. Known field → decode into the struct. Unknown field → skip by wire type and **append the raw bytes to `unknownFields`**, preserving them for re-marshalling.
5. **Validation.** Protobuf performs almost none. Required fields do not exist in proto3; strings are checked for UTF-8 validity and that is essentially it. Everything else — ranges, formats, cross-field invariants — is your handler's job (chapter 15).

```svg
<svg viewBox="0 0 880 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="p1" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#4f46e5"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Unknown fields: why rolling upgrades are safe</text>

  <rect x="30" y="46" width="230" height="120" rx="10" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="145" y="68" text-anchor="middle" fill="#3730a3" font-size="12" font-weight="bold">NEW binary (v2 schema)</text>
  <text x="46" y="92" fill="#4338ca">sku = 1</text>
  <text x="46" y="110" fill="#4338ca">quantity_on_hand = 3</text>
  <text x="46" y="128" fill="#4338ca" font-weight="bold">warehouse_id = 9  (new)</text>
  <text x="46" y="152" fill="#64748b" font-size="10">marshals all three fields</text>

  <path d="M262,106 L330,106" stroke="#4f46e5" stroke-width="2" marker-end="url(#p1)"/>

  <rect x="336" y="46" width="230" height="120" rx="10" fill="#fef9c3" stroke="#ca8a04" stroke-width="2"/>
  <text x="451" y="68" text-anchor="middle" fill="#854d0e" font-size="12" font-weight="bold">OLD binary (v1 schema)</text>
  <text x="352" y="92" fill="#713f12">reads field 1 &#10003;</text>
  <text x="352" y="110" fill="#713f12">reads field 3 &#10003;</text>
  <text x="352" y="128" fill="#713f12">field 9 unknown &#8594; skip by wire type</text>
  <text x="352" y="152" fill="#713f12" font-weight="bold">raw bytes stored in unknownFields</text>

  <path d="M568,106 L636,106" stroke="#4f46e5" stroke-width="2" marker-end="url(#p1)"/>

  <rect x="642" y="46" width="212" height="120" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="748" y="68" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">re-marshal</text>
  <text x="658" y="92" fill="#166534">field 1 &#183; field 3 &#183; field 9</text>
  <text x="658" y="112" fill="#166534" font-weight="bold">field 9 survives intact</text>
  <text x="658" y="136" fill="#166534" font-size="10">read-modify-write does not</text>
  <text x="658" y="152" fill="#166534" font-size="10">destroy data it cannot see</text>

  <rect x="30" y="186" width="824" height="126" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="442" y="210" text-anchor="middle" fill="#334155" font-size="13" font-weight="bold">Why skipping works without the schema</text>
  <text x="50" y="234" fill="#475569">The key byte carries the wire type, and every wire type has a self-describing length rule:</text>
  <text x="66" y="256" fill="#475569">wire type 0 (VARINT) &#8594; read bytes until one has the high bit clear</text>
  <text x="66" y="274" fill="#475569">wire type 1 (I64) &#8594; skip exactly 8 bytes &#183; wire type 5 (I32) &#8594; skip exactly 4 bytes</text>
  <text x="66" y="292" fill="#475569">wire type 2 (LEN) &#8594; read the varint length, skip that many bytes</text>
</svg>
```

**Determinism warning.** Protobuf serialisation is *not* canonical. Map iteration order is randomised in Go, unknown fields are appended, and different implementations may order fields differently. Never hash or sign a marshalled protobuf and expect stability across processes; if you need determinism, use `proto.MarshalOptions{Deterministic: true}` (which sorts map keys) and even then treat it as best-effort within one library version.

## 5. Implementation

Measuring the difference yourself, and inspecting bytes when debugging.

```go
package encoding

import (
	"encoding/json"
	"fmt"
	"testing"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/encoding/protojson"

	inventoryv1 "github.com/example/inventory/gen/inventory/v1"
)

func sampleItem() *inventoryv1.Item {
	return &inventoryv1.Item{
		Sku:            "sku_1",
		Name:           "Blue Widget",
		QuantityOnHand: 42,
		UnitPriceCents: 1299,
	}
}

// TestWireSize prints the concrete byte cost of each representation.
func TestWireSize(t *testing.T) {
	item := sampleItem()

	pb, err := proto.Marshal(item)
	if err != nil {
		t.Fatal(err)
	}

	// protojson is the canonical JSON mapping (camelCase, enums as strings).
	pj, err := protojson.Marshal(item)
	if err != nil {
		t.Fatal(err)
	}

	// A hand-written Go struct marshalled by encoding/json, for a fair
	// "what you'd write without protobuf" comparison.
	plain, err := json.Marshal(map[string]any{
		"sku": item.GetSku(), "name": item.GetName(),
		"quantity_on_hand": item.GetQuantityOnHand(),
		"unit_price_cents": item.GetUnitPriceCents(),
	})
	if err != nil {
		t.Fatal(err)
	}

	t.Logf("protobuf: %3d bytes  %x", len(pb), pb)
	t.Logf("protojson:%3d bytes  %s", len(pj), pj)
	t.Logf("json:     %3d bytes  %s", len(plain), plain)
	// Typical output:
	//   protobuf:  30 bytes  0a05736b755f3112. . .
	//   protojson: 84 bytes
	//   json:      88 bytes
}

// BenchmarkMarshal shows the parse/serialise cost difference, which is usually
// larger and more important than the size difference.
func BenchmarkProtoMarshal(b *testing.B) {
	item := sampleItem()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if _, err := proto.Marshal(item); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkJSONMarshal(b *testing.B) {
	item := sampleItem()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if _, err := json.Marshal(item); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkProtoUnmarshal(b *testing.B) {
	buf, _ := proto.Marshal(sampleItem())
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		var out inventoryv1.Item
		if err := proto.Unmarshal(buf, &out); err != nil {
			b.Fatal(err)
		}
	}
}

// ExampleDecodeUnknown demonstrates that unknown fields survive a round trip
// through a process that does not know about them. This is what makes rolling
// upgrades and pass-through proxies safe.
func ExampleDecodeUnknown() {
	// Pretend an OLD binary receives bytes produced by a NEW schema that has an
	// extra field 9. We simulate the new field by appending a raw encoding:
	//   key = (9 << 3) | 0 = 0x48, value = varint 7
	buf, _ := proto.Marshal(sampleItem())
	buf = append(buf, 0x48, 0x07)

	var old inventoryv1.Item
	if err := proto.Unmarshal(buf, &old); err != nil {
		panic(err)
	}

	// The old binary cannot read field 9, but it retains the raw bytes and
	// re-emits them, so a read-modify-write does not destroy data.
	reencoded, _ := proto.Marshal(&old)
	fmt.Println(len(reencoded) == len(buf))
	// Output: true
}
```

**Inspecting bytes without the schema.** When you only have a payload and a suspicion:

```bash
# protoscope renders raw protobuf as readable tokens (no .proto needed).
go install github.com/protocolbuffers/protoscope/cmd/protoscope@latest
xxd -r -p <<< '0a05736b755f31182a' | protoscope
#   1: {"sku_1"}
#   3: 42

# With the schema available, protoc decodes fully:
protoc --decode=inventory.v1.Item proto/inventory/v1/inventory.proto < payload.bin
```

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Size.** No field names, no punctuation, binary numbers, omitted defaults, packed repeated scalars. 3–10× smaller than equivalent JSON is typical.
- **Speed.** Parsing is a table-driven loop with no string hashing and few allocations; benchmarks commonly show 5–20× faster unmarshal in Go.
- **Schema-enforced types.** An `int32` field cannot receive a string; the class of bug where a JSON number arrives as `"42"` simply does not exist.
- **Evolvability by construction.** Unknown-field preservation plus number-based identity make additive change safe for old and new binaries in both directions.
- **Polyglot codegen** from one definition, with consistent semantics across languages.

**Disadvantages**
- **Opaque.** You cannot read a payload, grep a log or eyeball a request body without tooling and, usually, the schema.
- **Weak validation.** No required fields, no ranges, no formats. Validation is entirely your responsibility.
- **Presence ambiguity.** Proto3's omitted-defaults rule makes `0`, `""` and `false` indistinguishable from unset unless you use `optional`.
- **Non-canonical output.** Byte-identical re-serialisation is not guaranteed, so signing or hashing serialised protobuf is a trap.
- **Build-time dependency.** A code generator must be installed, versioned and run.

**Trade-offs**
- *`int64` vs `sint64` vs `fixed64`:* varint is cheapest for small non-negative values, ZigZag for small signed values, fixed for large or uniformly random values. Choosing wrong costs bytes on every message.
- *Field-number budget:* using 1–15 for hot fields saves a byte each but constrains future layout; on low-volume messages it is noise.
- *`optional` everywhere:* explicit presence is safer but generates pointers, which means more allocations and `nil` checks in Go.

## 7. Common Mistakes & Best Practices

- **Reusing a field number after deleting a field.** Old clients will decode new data into the old meaning — silent corruption, not an error. Always `reserved 3; reserved "quantity_on_hand";` (chapter 13).
- **Using `int32`/`int64` for values that are often negative.** Every negative costs ten bytes. Use `sint32`/`sint64`.
- **Putting hot fields at numbers above 15.** Two key bytes per field per message adds up in repeated elements.
- **Assuming `0` means "not provided".** It does not. Use `optional` for real presence, or a `FieldMask` for partial updates.
- **Hashing or signing marshalled protobuf.** Output is not canonical; use a stable representation you control.
- **Treating protobuf as validation.** It checks types and UTF-8 and nothing else. Validate in the handler or with `protoc-gen-validate`/`protovalidate`.
- **Storing large blobs in messages.** Protobuf is designed for structured records, not megabyte payloads; put blobs in object storage and pass a reference, or stream them in chunks.
- **Comparing messages with `==` or `reflect.DeepEqual`.** Generated structs contain internal state; use `proto.Equal` or `protocmp.Transform()` with `go-cmp`.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** `prototext.Format(m)` gives a readable dump for logs; `protojson.Marshal` gives canonical JSON when you need to paste into a ticket. `protoscope` decodes raw bytes with no schema. Never log whole messages containing PII — write an explicit redacting formatter.
- **Monitoring.** Track `proto.Size` percentiles per method. A p99 message size creeping toward `MaxRecvMsgSize` is a production incident forming.
- **Security.** A hostile payload can declare a huge length or nest messages thousands deep. Go's implementation enforces a recursion limit (100 by default) and grpc-go enforces `MaxRecvMsgSize` **before** allocating, but you should still set an explicit size limit and reject unbounded `repeated` fields in validation. Also remember unknown-field retention means a proxy can carry fields it cannot see — do not rely on a middlebox to strip sensitive data.
- **Scaling.** For very hot paths, `proto.MarshalOptions{}.MarshalAppend(buf[:0], m)` with a pooled buffer removes an allocation per call. Measure before adopting; the default path is already good.

## 9. Interview Questions

**Q: Why is protobuf smaller than JSON on the wire?**
A: Four reasons compounding. Field names are replaced by integers agreed out of band in the `.proto`, so `"quantity_on_hand"` becomes one byte. Numbers are binary varints rather than decimal ASCII. There is no structural punctuation — no quotes, colons, commas or braces. And in proto3 any field equal to its default is omitted entirely. Repeated numeric fields are additionally packed into a single length-delimited run.

**Q: Explain varint encoding and its worst case.**
A: A varint stores seven bits of payload per byte, with the high bit signalling that more bytes follow, low group first. So `1` is one byte and `300` is two (`0xAC 0x02`). The worst case is a negative `int32` or `int64`: negatives are sign-extended to 64 bits before encoding, so `-1` becomes ten bytes. That is exactly why `sint32`/`sint64` exist — they apply ZigZag first so small magnitudes of either sign stay small.

**Q: What is ZigZag encoding and when do you use it?**
A: ZigZag maps signed integers to unsigned ones by interleaving: 0→0, −1→1, 1→2, −2→3, via `(n << 1) ^ (n >> 31)`. It makes small negative numbers cost as little as small positive ones. Use `sint32`/`sint64` when the field is frequently negative — deltas, offsets, temperature, balance changes. Use plain `int32`/`int64` when values are almost always non-negative, since ZigZag doubles the magnitude and can cost an extra byte.

**Q: Why should hot fields get numbers 1–15?**
A: The key preceding every field is a varint of `(field_number << 3) | wire_type`. Three bits go to the wire type, so field numbers up to 15 leave the value inside one byte; 16 and above need two. On a field present in every message — or worse, in every element of a large repeated field — that is one extra byte per occurrence, which becomes megabytes at scale.

**Q: What are the four wire types?**
A: `0` VARINT for `int32/64`, `uint32/64`, `sint32/64`, `bool` and enums; `1` I64, a fixed eight bytes, for `fixed64`, `sfixed64` and `double`; `2` LEN, a varint length followed by that many bytes, for `string`, `bytes`, embedded messages and packed repeated fields; and `5` I32, a fixed four bytes, for `fixed32`, `sfixed32` and `float`. Wire types `3` and `4` were start/end group and are deprecated.

**Q: What happens when a parser encounters a field number it does not know?**
A: It reads the wire type from the key, skips exactly the right number of bytes, and stores the raw bytes in the message's unknown-field set. On re-marshalling those bytes are emitted again. That behaviour is the foundation of safe rolling upgrades and pass-through proxies: an old binary can receive, hold and return data from a newer schema without losing it.

**Q: In proto3, how do you distinguish "zero" from "not set"?**
A: By default you cannot, because a scalar equal to its default is not serialised. The modern answer is the `optional` keyword, re-enabled for proto3 in protobuf 3.15, which gives the field explicit presence — in Go a pointer plus a `Has` accessor. Older code used wrapper types like `google.protobuf.Int32Value`. For partial updates specifically, the right tool is a `FieldMask` naming exactly which fields the caller intends to change.

**Q: Is protobuf serialisation deterministic?**
A: No, and relying on it is a common bug. Go randomises map iteration order, unknown fields are appended in receipt order, and implementations may differ in field ordering. `proto.MarshalOptions{Deterministic: true}` sorts map keys and gives stability within a library version, but it is explicitly not a canonical form across versions or languages. If you need to hash or sign, define your own canonical serialisation.

**Q: (Senior) How much validation does protobuf give you, and how do you fill the gap?**
A: Essentially only type correctness and UTF-8 validity for strings. There are no required fields in proto3, no ranges, no formats, no cross-field rules, and no bounds on repeated fields. I fill the gap in layers: `protovalidate` (or the older `protoc-gen-validate`) to express constraints as options in the `.proto` so they are part of the contract and generate checks in every language; a validation interceptor that runs those checks before any handler sees the request; and handler-level checks for anything genuinely business-specific. The interceptor placement matters — validation belongs before authorization is expensive and before any I/O.

**Q: (Senior) You must add a field that some clients send and others do not, and the zero value is meaningful. Walk through the options.**
A: The default proto3 scalar is unusable here because zero and absent are the same bytes. Option one, `optional int32 x = 9;` — explicit presence, a `*int32` in Go, a `HasX()` accessor, wire-compatible with a non-optional field of the same number and type, and my default choice. Option two, a wrapper type `google.protobuf.Int32Value` — also gives presence, but adds an allocation and an embedded message on the wire, and is mostly legacy now. Option three, restructure so presence is carried elsewhere — a `oneof`, or a `FieldMask` on the request if this is an update. I would pick `optional` for a read field and a `FieldMask` for an update RPC, because on updates the client needs to express intent across many fields at once, not just one.

**Q: (Senior) A team wants to store signed protobuf messages for an audit log. What do you tell them?**
A: That signing the output of `proto.Marshal` is unsafe, because the format is not canonical: map ordering, unknown-field placement and implementation differences all mean a byte-identical re-serialisation is not guaranteed, so a signature that verifies today may fail after a library upgrade or a round trip through a proxy. The safe patterns are to sign the exact received bytes and store *those* alongside the parsed message rather than re-serialising, or to define an explicit canonical encoding — a documented field order with maps flattened into sorted repeated pairs — and sign that. I would prefer storing the original bytes, since it also preserves unknown fields exactly.

**Q: (Senior) When would you not use protobuf for a service's payloads?**
A: When human readability at the boundary matters more than efficiency — a public API where consumers debug with curl, or a config format read by operators. When the payload is genuinely unstructured or schema-less, such as arbitrary user documents, where `Struct` or raw bytes with a content type is more honest. When payloads are dominated by a single large binary blob, which belongs in object storage with a reference passed instead. And when the consumer ecosystem cannot take a codegen dependency, which is common for partner-facing APIs.

## 10. Quick Revision & Cheat Sheet

| Type | Wire type | Best for | Cost |
|---|---|---|---|
| `int32`, `int64` | 0 varint | Mostly non-negative values | 1–10 B (10 for negatives) |
| `sint32`, `sint64` | 0 varint | Frequently negative values | 1–10 B, small magnitudes cheap |
| `uint32`, `uint64` | 0 varint | Counts, ids that are never negative | 1–10 B |
| `bool` | 0 varint | Flags | 1 B (omitted when false) |
| `enum` | 0 varint | Closed sets | 1–2 B |
| `fixed64`, `double` | 1 (I64) | Large/random numbers, floats | 8 B always |
| `fixed32`, `float` | 5 (I32) | Large/random 32-bit values | 4 B always |
| `string`, `bytes` | 2 (LEN) | Text, blobs | 1–5 B length + payload |
| message | 2 (LEN) | Nesting | 1–5 B length + payload |
| `repeated` scalar | 2 (LEN, packed) | Number lists | one key + one length for the whole run |

**Flash cards**
- **What identifies a field on the wire?** → The field *number*, never the name. Numbers are permanent.
- **Key byte formula?** → `(field_number << 3) | wire_type`. Numbers 1–15 fit in one byte.
- **Cost of `int64 = -1`?** → Ten bytes. Use `sint64`.
- **What happens to unknown fields in Go?** → Preserved in `unknownFields` and re-emitted on marshal.
- **Zero vs unset in proto3?** → Indistinguishable, unless the field is `optional` (or a message type).
- **Comparing two messages?** → `proto.Equal`, or `protocmp.Transform()` with `go-cmp`. Never `reflect.DeepEqual`.

## 11. Hands-On Exercises & Mini Project

- [ ] Hand-encode `Item{Sku:"a", QuantityOnHand:300}` on paper, then verify with `proto.Marshal` and `xxd`. Confirm every byte.
- [ ] Marshal `int64(-1)` and `sint64(-1)` in two test messages and compare lengths. Explain the difference in one sentence.
- [ ] Move a frequently-populated field from number 3 to number 20, marshal a `repeated` list of 10,000 elements, and measure the size delta.
- [ ] Run the benchmarks in §5 and record the marshal/unmarshal ratio and allocations for protobuf versus `encoding/json` on your machine.
- [ ] Append a raw unknown field to a marshalled message, unmarshal it with the old schema, re-marshal, and prove the bytes survived.
- [ ] Install `protoscope` and decode a payload without the `.proto`. Note which fields you can and cannot interpret without the schema.

### Mini Project — "Wire Format Explorer"

**Goal.** Build a CLI that makes protobuf encoding tangible, so schema decisions become measurable rather than folkloric.

**Requirements.**
1. Accept a `.proto`-generated Go message populated from a JSON file (via `protojson.Unmarshal`).
2. Print a per-field breakdown: field number, name, wire type, encoded byte count, and its percentage of the total.
3. Print the equivalent `encoding/json` and `protojson` sizes and the compression ratio for each.
4. Add a `--suggest` mode that flags: hot fields numbered above 15, `int32`/`int64` fields containing negative values, and `repeated` fields large enough to justify `fixed` types.
5. Add a `--fuzz` mode that generates N random instances and reports the size distribution (p50/p95/p99) so you can predict `MaxRecvMsgSize` headroom.

**Extensions.**
- Add a `--diff` mode that takes two schema versions and reports which changes are wire-compatible, replicating a subset of `buf breaking`.
- Benchmark marshal/unmarshal with and without `MarshalAppend` into a `sync.Pool` buffer, and quantify the allocation savings.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *What Is gRPC?* (why a shared schema exists at all), *HTTP/2 Under gRPC* (how these bytes are framed), *proto3 in Depth* (the language that produces these encodings), *Schema Evolution* (the compatibility rules built on field numbers), *Performance Tuning* (message size limits and compression).

- **Protocol Buffers — Encoding** — Google · *Advanced* · the normative description of varints, ZigZag, wire types and packed fields, with worked byte examples. The single most useful page in this chapter's bibliography. <https://protobuf.dev/programming-guides/encoding/>
- **Protocol Buffers — Language Guide (proto3)** — Google · *Beginner* · the full syntax reference including defaults, `optional`, `oneof`, maps and reserved ranges. <https://protobuf.dev/programming-guides/proto3/>
- **Protocol Buffers — Field Presence** — Google · *Intermediate* · the definitive explanation of implicit vs explicit presence and exactly when zero is indistinguishable from unset. <https://protobuf.dev/programming-guides/field_presence/>
- **protobuf-go — Go Generated Code Reference** — Go Protobuf Authors · *Intermediate* · what every generated symbol is, and how the `protoimpl` runtime represents fields and unknown data. <https://protobuf.dev/reference/go/go-generated/>
- **protoscope** — Protocol Buffers Authors (open source) · *Intermediate* · a schema-less decoder and encoder for raw protobuf bytes; the fastest way to answer "what is actually in this payload?". <https://github.com/protocolbuffers/protoscope>
- **google.golang.org/protobuf/proto — package docs** — Go Protobuf Authors · *Intermediate* · `Marshal`, `Unmarshal`, `Equal`, `Size`, `MarshalOptions` including `Deterministic`; read the caveats on determinism. <https://pkg.go.dev/google.golang.org/protobuf/proto>
- **protovalidate** — Buf (open source) · *Intermediate* · schema-embedded validation rules using CEL, filling protobuf's validation gap in every language from one definition. <https://github.com/bufbuild/protovalidate>
- **Protocol Buffers — Best Practices & API Style Guide** — Google · *Intermediate* · field-numbering, naming and evolution guidance drawn from very large internal schema estates. <https://protobuf.dev/best-practices/dos-donts/>

---

*gRPC with Go Handbook — chapter 03.*
