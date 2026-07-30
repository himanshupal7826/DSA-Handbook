# 26 · Schema Management: Avro, Protobuf & the Registry

> **In one line:** A topic is a contract between producers and consumers who never meet, and raw JSON writes that contract in invisible ink — a schema plus a registry make it explicit, versioned, and *enforced at publish time*, so a producer literally cannot ship a change that would break the consumers reading it.

---

## 1. Overview

A Kafka topic is a shared, long-lived interface. A producer team writes records; consumer teams — possibly several, possibly ones that will not exist for another year — read them, and none of them are in the same deploy, the same repo, or often the same room. The bytes on the topic are the *only* contract between them. So the central question of any serious event-driven system is: **what stops a producer from changing the shape of those bytes in a way that silently breaks a consumer?** With raw JSON, the answer is *nothing*. A producer renames `user_id` to `userId`, or changes `amount` from a number to a string, or drops a field a consumer depends on, deploys on Tuesday, and a downstream consumer starts throwing deserialisation errors or — worse — silently reads wrong data on Wednesday. There is no contract, no versioning, and no enforcement; the breakage is discovered in production, by the victim.

The fix has two parts. First, a **schema** — a formal, machine-readable description of a record's structure: its fields, their types, which are optional, their defaults. **Avro**, **Protobuf** and **JSON Schema** are the three formats in common Kafka use. A schema turns "this is roughly a user object" into a precise, checkable contract. Second, a **Schema Registry** — a service (the Confluent Schema Registry is the de-facto standard) that stores every schema, assigns each a global **schema ID**, and — critically — *enforces compatibility rules* when a new schema version is registered, rejecting a change that would break existing readers or writers. Producers register (or look up) their schema and prepend its ID to every message as a compact magic-byte prefix; consumers read the ID, fetch the schema from the registry, and deserialise. The payload stays small (no schema shipped per message, just a 5-byte header), and the contract is both explicit and enforced.

This chapter explains why raw JSON on a topic is a liability at scale, what schemas give you, how the Schema Registry's ID-prefix mechanism works end to end, and the heart of the matter: **schema evolution and compatibility modes** — `BACKWARD`, `FORWARD`, `FULL`, `NONE` — which govern who can change what and in which order producers and consumers must upgrade. We compare Avro and Protobuf honestly, and the code is a Go producer and consumer using a Schema-Registry-aware Avro serialiser, plus the registry's own REST API. Get compatibility modes right and schema changes become routine and safe; get them wrong and you are back to breaking consumers in production, just with more ceremony.

## 2. Core Concepts

- **Schema** — a formal description of a record's structure: fields, types, optionality, defaults. The contract for a topic's data.
- **Avro** — a compact binary serialisation format with a JSON-defined schema; the traditional Kafka default. The schema is *required* to deserialise.
- **Protobuf** — Google's binary format with an IDL (`.proto`); widely used, with generated typed classes and cross-language support (chapter on gRPC).
- **JSON Schema** — a schema language for JSON documents; human-readable, larger on the wire, useful where JSON payloads must stay readable.
- **Schema Registry** — a service that stores schemas, assigns each a global **schema ID** and a per-subject **version**, and enforces compatibility on registration. Serves them over a REST API.
- **Schema ID** — the globally unique integer the registry assigns a schema; embedded in each message so the consumer knows which schema deserialises it.
- **Subject** — the named scope under which schema versions evolve, usually `<topic>-value` (and `<topic>-key`) by default; the compatibility mode is set per subject.
- **Magic-byte wire format** — the on-the-wire layout: a 0x00 magic byte, a 4-byte schema ID, then the serialised payload. Compact — the schema itself is *not* shipped per message.
- **Schema evolution** — changing a schema over time (adding, removing, modifying fields) while keeping producers and consumers interoperable.
- **Compatibility mode** — the rule the registry enforces: `BACKWARD`, `FORWARD`, `FULL`, `NONE` (and transitive variants), determining which changes are allowed and the upgrade order.
- **Backward compatible** — a *new* schema can read data written with the *old* schema → **consumers upgrade first**.
- **Forward compatible** — an *old* schema can read data written with a *new* schema → **producers upgrade first**.

## 3. Theory & Principles

### Why raw JSON is a liability at scale

Schemaless JSON feels free — no registry, no code generation, just `json.Marshal` — and for a single team owning both ends of a topic it can be fine. It stops being fine the moment producers and consumers evolve independently, which is the whole point of a message bus. The failures are specific: there is **no enforced contract**, so a producer can change a field's name, type, or presence with nothing to stop it; there is **no versioning**, so consumers cannot tell "old shape" from "new shape" except by defensive parsing; breakage is **silent and late**, surfacing as a deserialisation error or, more dangerously, a wrong-but-parseable value in a consumer the producer team has never heard of; and every message pays to **ship its field names** as text, bloating the wire. The deep issue is that JSON pushes the contract into tribal knowledge and hope. A schema makes the contract a checkable artefact, and a registry makes it *enforced* — the difference between "we agreed not to break this" and "the system will not let you break this".

### The Schema Registry mechanism — ID prefix, not schema-per-message

The elegant idea is that you get a strong contract *and* a compact wire format, by never shipping the schema with the data. On produce, the serialiser takes the record's schema, **registers it** with the registry under the topic's subject (or looks up its ID if already registered), receives a globally unique integer **schema ID**, and writes the message as: one magic byte `0x00`, the 4-byte schema ID, then the binary-serialised payload. On consume, the deserialiser reads the magic byte and the 4-byte ID, **fetches that exact schema** from the registry (caching it locally so it is one lookup per ID, not per message), and uses it to decode the payload. So the payload carries a 5-byte pointer to its schema rather than the schema itself — compact like a schemaless binary format, but every message is self-describing *by reference*, and the contract is centrally stored and versioned. The registry also becomes the *enforcement point*: because registering a new schema goes through it, it can reject a change that violates the subject's compatibility mode before any producer ships it.

```svg
<svg viewBox="0 0 880 440" width="100%" height="440" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="r1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="r2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Schema Registry: the schema ID travels, the schema does not</text>

  <rect x="24" y="44" width="150" height="70" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="99" y="72" text-anchor="middle" fill="#1e40af" font-size="11" font-weight="bold">Producer</text>
  <text x="99" y="92" text-anchor="middle" fill="#1d4ed8" font-size="9">has the Avro schema</text>
  <text x="99" y="106" text-anchor="middle" fill="#1d4ed8" font-size="9">for a User record</text>

  <rect x="360" y="30" width="160" height="90" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="440" y="52" text-anchor="middle" fill="#92400e" font-size="11" font-weight="bold">Schema Registry</text>
  <text x="376" y="72" fill="#b45309" font-size="9">stores schemas by subject</text>
  <text x="376" y="88" fill="#b45309" font-size="9">assigns global schema ID</text>
  <text x="376" y="104" fill="#b45309" font-size="9">enforces compatibility</text>

  <rect x="706" y="44" width="150" height="70" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="781" y="72" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">Consumer</text>
  <text x="781" y="92" text-anchor="middle" fill="#166534" font-size="9">fetches schema by ID</text>
  <text x="781" y="106" text-anchor="middle" fill="#166534" font-size="9">then deserialises</text>

  <path d="M120,44 L360,70" stroke="#2563eb" stroke-width="1.8" marker-end="url(#r1)"/>
  <text x="200" y="46" fill="#1e40af" font-size="9">1. register schema &#8594; get ID 42</text>
  <path d="M706,72 L522,72" stroke="#16a34a" stroke-width="1.8" marker-end="url(#r2)"/>
  <text x="560" y="60" fill="#15803d" font-size="9">4. GET schema for ID 42 (cached)</text>

  <rect x="150" y="150" width="580" height="60" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="440" y="140" text-anchor="middle" fill="#5b21b6" font-size="10" font-weight="bold">2. produce &#8594; Kafka topic &#8594; 3. consume</text>
  <g font-family="ui-monospace,monospace" font-size="10">
    <rect x="170" y="164" width="40" height="32" fill="#fca5a5" stroke="#dc2626"/><text x="190" y="184" text-anchor="middle" fill="#7f1d1d">0x00</text>
    <rect x="210" y="164" width="120" height="32" fill="#fed7aa" stroke="#d97706"/><text x="270" y="184" text-anchor="middle" fill="#92400e">schema ID = 42</text>
    <rect x="330" y="164" width="380" height="32" fill="#bbf7d0" stroke="#16a34a"/><text x="520" y="184" text-anchor="middle" fill="#14532d">Avro-serialised payload (no field names)</text>
  </g>
  <text x="170" y="226" fill="#5b21b6" font-size="9">1 magic byte + 4-byte ID + compact binary body</text>
  <text x="440" y="226" fill="#6d28d9" font-size="9">the SCHEMA is fetched by ID, never shipped per message</text>

  <rect x="24" y="248" width="832" height="176" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="270" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Why this design wins</text>
  <text x="48" y="296" fill="#475569" font-size="10">&#8226; COMPACT: payload carries a 5-byte pointer, not the schema &#8212; as small as a schemaless binary format.</text>
  <text x="48" y="318" fill="#475569" font-size="10">&#8226; SELF-DESCRIBING by reference: every message names exactly which schema decodes it, so mixed versions on a topic coexist.</text>
  <text x="48" y="340" fill="#475569" font-size="10">&#8226; ENFORCED: registering a new version passes through the registry, which REJECTS incompatible changes before any producer ships.</text>
  <text x="48" y="362" fill="#475569" font-size="10">&#8226; CACHED: the consumer fetches each schema ID once and caches it &#8212; one lookup per ID, not per message.</text>
  <text x="48" y="388" fill="#334155" font-size="10" font-weight="bold">Result: a strong, versioned, centrally-enforced contract AND a compact wire format &#8212; you do not have to choose.</text>
  <text x="48" y="410" fill="#334155" font-size="10">Default subject naming: &lt;topic&gt;-value and &lt;topic&gt;-key. Compatibility mode is set PER SUBJECT.</text>
</svg>
```

### Compatibility modes — the real content

Schema evolution is the whole reason the registry exists, and the compatibility mode is the rule it enforces. There are two directions that matter, and their names describe *which schema can read which data*:

- **BACKWARD** (the default): a **new** schema can read data written by the **old** schema. Because a *new consumer* must handle *old data still on the topic*, **consumers upgrade first**. Allowed changes: **delete a field**, and **add an optional field (with a default)** — a new reader skips the removed field and fills in a default for the added one when reading old records.
- **FORWARD**: an **old** schema can read data written by the **new** schema. Because an *old consumer* must handle *new data a new producer writes*, **producers upgrade first**. Allowed changes: **add a field**, and **delete an optional field** — an old reader ignores the newly-added field and, for a deleted optional field, uses its default.
- **FULL**: both backward *and* forward — a change readable both ways. The only always-safe changes are **adding or removing an optional field with a default**. Upgrade order is unconstrained, which is why FULL is the strictest and safest for many-producer, many-consumer topics.
- **NONE**: no checks. The registry stores anything; you own all the risk. Use only when you truly manage compatibility out of band.

The mnemonic that survives interviews: **BACKWARD → consumers first; FORWARD → producers first; FULL → either order; NONE → good luck.** The reason to reach for BACKWARD as the default is that it lets you reprocess history (replay old records with the new consumer) — a natural fit for Kafka's replayable log — and the reason to want FULL on a busy shared topic is that you cannot coordinate the deploy order of many independent teams. There are also *transitive* variants (`BACKWARD_TRANSITIVE`, etc.) that check a new schema against *all* prior versions, not just the immediately previous one — stricter, and what you want when consumers may replay from arbitrary points in history.

## 4. Architecture & Workflow

The registry sits beside Kafka; producers and consumers talk to *both*. The end-to-end flow:

1. **Author the schema** (an Avro `.avsc`, a Protobuf `.proto`, or a JSON Schema) describing the record.
2. **Producer serialises.** The Schema-Registry-aware serialiser registers the schema under the subject `<topic>-value` (or looks up its ID if unchanged), gets the **schema ID**, and writes the message as magic-byte + ID + binary payload. Registration is where the registry **checks compatibility** against the subject's mode and rejects an incompatible schema.
3. **Kafka stores the bytes.** The broker is oblivious — it stores opaque bytes; all schema logic is client-side plus the registry.
4. **Consumer deserialises.** The deserialiser reads the ID, fetches that schema from the registry (cached), and — for Avro — decodes using *both* the writer's schema (by ID) and the reader's own schema, resolving differences via Avro's rules (defaults for missing fields, skipping unknown ones). This *schema resolution* is how compatible evolution actually works at read time.
5. **Evolve safely.** A new schema version is registered only if it satisfies the compatibility mode; consumers and producers roll out in the order the mode dictates (consumers-first for BACKWARD, producers-first for FORWARD, either for FULL).
6. **Operate the registry.** It is itself backed by a Kafka topic (`_schemas`) as its store, runs in a cluster for HA, and is a hard dependency of producers and consumers at (de)serialisation time — so it must be highly available.

```svg
<svg viewBox="0 0 880 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="e1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Compatibility modes: who can change what, and who upgrades first</text>

  <rect x="24" y="42" width="410" height="150" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="229" y="64" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">BACKWARD (default) &#8212; consumers upgrade FIRST</text>
  <text x="40" y="88" fill="#166534" font-size="10">NEW schema reads OLD data.</text>
  <text x="40" y="108" fill="#166534" font-size="10">Allowed: delete a field &#183; add an OPTIONAL field (default).</text>
  <text x="40" y="132" fill="#166534" font-size="10">New consumer must handle old records still on the topic,</text>
  <text x="40" y="148" fill="#166534" font-size="10">so deploy consumers before producers.</text>
  <text x="40" y="174" fill="#14532d" font-size="10" font-weight="bold">Best for replay: new code reprocesses old history.</text>

  <rect x="446" y="42" width="410" height="150" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="651" y="64" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">FORWARD &#8212; producers upgrade FIRST</text>
  <text x="462" y="88" fill="#1d4ed8" font-size="10">OLD schema reads NEW data.</text>
  <text x="462" y="108" fill="#1d4ed8" font-size="10">Allowed: add a field &#183; delete an OPTIONAL field.</text>
  <text x="462" y="132" fill="#1d4ed8" font-size="10">Old consumer must handle new records a new producer</text>
  <text x="462" y="148" fill="#1d4ed8" font-size="10">writes, so deploy producers before consumers.</text>
  <text x="462" y="174" fill="#1e3a8a" font-size="10" font-weight="bold">Best when producers must move ahead of readers.</text>

  <rect x="24" y="202" width="410" height="120" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="229" y="224" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">FULL &#8212; both ways, either order</text>
  <text x="40" y="248" fill="#6d28d9" font-size="10">NEW reads OLD and OLD reads NEW.</text>
  <text x="40" y="268" fill="#6d28d9" font-size="10">Only always-safe change: add/remove an OPTIONAL</text>
  <text x="40" y="284" fill="#6d28d9" font-size="10">field WITH a default.</text>
  <text x="40" y="306" fill="#5b21b6" font-size="10" font-weight="bold">Strictest &#8212; for busy topics with many independent teams.</text>

  <rect x="446" y="202" width="410" height="120" rx="10" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="651" y="224" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">NONE &#8212; no checks</text>
  <text x="462" y="248" fill="#991b1b" font-size="10">Registry stores anything; you own all risk.</text>
  <text x="462" y="268" fill="#991b1b" font-size="10">Any change permitted &#8212; and any breakage yours.</text>
  <text x="462" y="292" fill="#7f1d1d" font-size="10">TRANSITIVE variants check against ALL past versions,</text>
  <text x="462" y="308" fill="#7f1d1d" font-size="10">not just the previous one &#8212; use when replay spans history.</text>

  <rect x="24" y="332" width="832" height="90" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="354" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">The mnemonic that survives the interview</text>
  <text x="48" y="380" fill="#334155" font-size="11" font-weight="bold">BACKWARD &#8594; consumers first &#183; FORWARD &#8594; producers first &#183; FULL &#8594; either order &#183; NONE &#8594; good luck</text>
  <text x="48" y="404" fill="#475569" font-size="10">The registry enforces this on REGISTER: an incompatible new version is rejected before any producer can ship it. That is the whole point.</text>
  <path d="M229,322 L229,330" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#e1)"/>
</svg>
```

The workflow lesson: the broker never learns about schemas — enforcement and resolution are entirely in the clients and the registry — so schema discipline is a *client-and-registry* concern, and the registry's availability is on your critical path, because a producer or consumer that cannot reach it to register or fetch a schema cannot (de)serialise.

## 5. Implementation

Real Go, using `confluent-kafka-go` with its Schema-Registry Avro serialiser/deserialiser. First the Avro schema (`user.avsc`) with an *optional field with a default* — the change that is safe under every compatibility mode:

```json
{
  "type": "record",
  "name": "User",
  "namespace": "com.shop.events",
  "fields": [
    { "name": "id",    "type": "long" },
    { "name": "email", "type": "string" },
    { "name": "name",  "type": "string" },
    { "name": "tier",  "type": ["null", "string"], "default": null }
  ]
}
```

A **producer** that registers the schema and writes ID-prefixed Avro records:

```go
package main

import (
	"fmt"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/confluentinc/confluent-kafka-go/v2/schemaregistry"
	"github.com/confluentinc/confluent-kafka-go/v2/schemaregistry/serde"
	"github.com/confluentinc/confluent-kafka-go/v2/schemaregistry/serde/avrov2"
)

// User mirrors user.avsc. The Avro serialiser derives the schema from these
// struct tags and registers it with the registry under the subject "users-value".
type User struct {
	ID    int64   `avro:"id"`
	Email string  `avro:"email"`
	Name  string  `avro:"name"`
	Tier  *string `avro:"tier"` // nullable with default null = safe under FULL
}

func main() {
	// The registry client points at the Schema Registry, NOT at Kafka. Producers
	// and consumers depend on BOTH the broker and the registry.
	sr, err := schemaregistry.NewClient(schemaregistry.NewConfig("http://localhost:8081"))
	if err != nil {
		panic(err)
	}

	// The Avro serialiser: on the first record it REGISTERS the schema, which is
	// where the registry checks compatibility against the subject's mode and
	// rejects an incompatible change. It caches the returned schema ID so
	// subsequent records are just ID + payload, no round-trip.
	ser, err := avrov2.NewSerializer(sr, serde.ValueSerde, avrov2.NewSerializerConfig())
	if err != nil {
		panic(err)
	}

	producer, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "localhost:9092"})
	if err != nil {
		panic(err)
	}
	defer producer.Close()

	topic := "users"
	gold := "gold"
	u := User{ID: 42, Email: "a@shop.com", Name: "Alice", Tier: &gold}

	// Serialize produces the wire format: 0x00 magic byte, 4-byte schema ID, then
	// the compact Avro body. The field NAMES are not on the wire — only the ID is.
	payload, err := ser.Serialize(topic, &u)
	if err != nil {
		panic(err) // e.g. the schema violated the subject's compatibility mode
	}

	err = producer.Produce(&kafka.Message{
		TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny},
		Key:            []byte(fmt.Sprintf("%d", u.ID)), // key = id → per-user ordering
		Value:          payload,
	}, nil)
	if err != nil {
		panic(err)
	}
	producer.Flush(5000)
}
```

A **consumer** that reads the schema ID off the wire, fetches the schema, and deserialises — tolerating evolution because Avro resolves the writer's and reader's schemas:

```go
package main

import (
	"fmt"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/confluentinc/confluent-kafka-go/v2/schemaregistry"
	"github.com/confluentinc/confluent-kafka-go/v2/schemaregistry/serde"
	"github.com/confluentinc/confluent-kafka-go/v2/schemaregistry/serde/avrov2"
)

type User struct {
	ID    int64   `avro:"id"`
	Email string  `avro:"email"`
	Name  string  `avro:"name"`
	Tier  *string `avro:"tier"`
}

func main() {
	sr, err := schemaregistry.NewClient(schemaregistry.NewConfig("http://localhost:8081"))
	if err != nil {
		panic(err)
	}

	// The deserialiser reads the 4-byte schema ID from each message, fetches THAT
	// exact writer schema from the registry (caching per ID), and decodes the body
	// into our reader struct — Avro fills defaults for fields we lack and skips
	// fields we do not know, which is exactly how compatible evolution works.
	deser, err := avrov2.NewDeserializer(sr, serde.ValueSerde, avrov2.NewDeserializerConfig())
	if err != nil {
		panic(err)
	}

	c, err := kafka.NewConsumer(&kafka.ConfigMap{
		"bootstrap.servers": "localhost:9092",
		"group.id":          "user-indexer",
		"auto.offset.reset": "earliest",
	})
	if err != nil {
		panic(err)
	}
	defer c.Close()
	c.Subscribe("users", nil)

	for {
		msg, err := c.ReadMessage(-1)
		if err != nil {
			continue
		}
		var u User
		// Deserialize resolves the writer schema (by the embedded ID) against our
		// reader schema. A record written by an OLDER producer that lacked "tier"
		// still decodes here, with Tier defaulting to nil — no crash. That is
		// BACKWARD compatibility paying off at read time.
		if err := deser.DeserializeInto(*msg.TopicPartition.Topic, msg.Value, &u); err != nil {
			fmt.Printf("deser error: %v\n", err)
			continue
		}
		fmt.Printf("user id=%d name=%s tier=%v\n", u.ID, u.Name, u.Tier)
	}
}
```

And the **Schema Registry REST API** directly — set the compatibility mode, register and inspect schemas, and *test* a change before shipping it:

```bash
# Set the compatibility mode for a subject. FULL = both directions, safest for a
# shared topic many teams read and write.
curl -s -X PUT http://localhost:8081/config/users-value \
  -H 'Content-Type: application/vnd.schemaregistry.v1+json' \
  -d '{"compatibility": "FULL"}'

# Register a new schema version under the subject (this is what the serialiser
# does automatically). Returns the assigned global schema id.
curl -s -X POST http://localhost:8081/subjects/users-value/versions \
  -H 'Content-Type: application/vnd.schemaregistry.v1+json' \
  -d '{"schema": "{\"type\":\"record\",\"name\":\"User\",\"fields\":[{\"name\":\"id\",\"type\":\"long\"},{\"name\":\"email\",\"type\":\"string\"},{\"name\":\"name\",\"type\":\"string\"},{\"name\":\"tier\",\"type\":[\"null\",\"string\"],\"default\":null}]}"}'

# List versions, fetch a schema by global id, and get the latest version.
curl -s http://localhost:8081/subjects/users-value/versions
curl -s http://localhost:8081/schemas/ids/42
curl -s http://localhost:8081/subjects/users-value/versions/latest

# CRITICAL in CI: test a candidate schema for compatibility WITHOUT registering it.
# Returns {"is_compatible": true|false}. Run this in a pre-merge check so an
# incompatible change fails the build, not production.
curl -s -X POST http://localhost:8081/compatibility/subjects/users-value/versions/latest \
  -H 'Content-Type: application/vnd.schemaregistry.v1+json' \
  -d '{"schema": "{\"type\":\"record\",\"name\":\"User\",\"fields\":[{\"name\":\"id\",\"type\":\"long\"},{\"name\":\"email\",\"type\":\"string\"},{\"name\":\"name\",\"type\":\"string\"}]}"}'
```

That final `compatibility` check is the practice that makes schemas safe in a team: wire it into CI so a schema change is validated against the registry's mode *before* merge, and an incompatible change is a red build rather than a 3am page.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Enforced contract.** The registry rejects an incompatible schema at registration, so a breaking change cannot reach production silently.
- **Safe, versioned evolution.** Compatibility modes let producers and consumers change independently in a defined order without breaking each other.
- **Compact wire format.** Only a 5-byte ID travels, not field names or the schema — smaller than JSON, with the contract intact.
- **Self-describing by reference.** Every message names its schema, so mixed versions coexist on a topic and consumers always decode correctly.
- **Cross-language and tooling.** Avro/Protobuf have generators and libraries across languages; the registry centralises the source of truth.

**Disadvantages**
- **Another critical dependency.** The registry is on the (de)serialisation path; if it is unreachable and the ID is uncached, clients cannot proceed. It must be HA.
- **Operational and cognitive overhead.** Schemas, subjects, modes, code generation and a registry to run — real ceremony versus `json.Marshal`.
- **Binary payloads are opaque.** Avro/Protobuf on the wire are not human-readable; debugging needs the schema and tooling, unlike raw JSON.
- **Evolution rules are subtle.** Which change is allowed under which mode (defaults, optionality, unions) trips people up and must be understood, not guessed.
- **Lock-in tendencies.** The Confluent registry's wire format and API are a de-facto standard but still a specific ecosystem to adopt.

**Trade-offs**
- *Contract safety vs simplicity:* schemas and a registry cost setup and ceremony but buy enforced, versioned contracts — worth it the moment producers and consumers evolve independently, overkill for one team owning both ends briefly.
- *Avro vs Protobuf:* Avro is compact and its schema-resolution model is a natural fit for the registry and dynamic decoding; Protobuf has superb cross-language tooling, generated typed classes, and shared lineage with gRPC. Pick Avro for data-in-motion pipelines, Protobuf where you already live in a Protobuf/gRPC world.
- *Strict vs lenient modes:* FULL/transitive maximise safety across uncoordinated teams but constrain what you can change; BACKWARD is a pragmatic default that supports replay; NONE removes the guardrails entirely. Choose per topic based on who evolves it.
- *Registry availability vs client autonomy:* caching schema IDs makes clients resilient to brief registry outages, but a cold client hitting an unknown ID during a registry outage stalls — the availability of the registry is a real design constraint.

## 7. Common Mistakes & Best Practices

- **Publishing raw JSON on shared topics.** No contract, no versioning, silent breakage; the field names bloat every message. Use a schema and the registry for anything more than one team owns end to end.
- **Not understanding upgrade order.** Deploying producers before consumers under BACKWARD (or the reverse under FORWARD) breaks readers even though the schema was "compatible". Know that BACKWARD means consumers-first and FORWARD means producers-first, and roll out accordingly.
- **Adding a required field under BACKWARD.** A new required field with no default breaks reading old data (there is nothing to fill it with). Add fields as optional with a default, or you will be rejected — or should be.
- **Leaving compatibility on NONE.** Convenient until it silently ships a breaking change. Set an explicit mode per subject (FULL or BACKWARD for shared topics) and mean it.
- **Not testing compatibility in CI.** Discovering incompatibility when the serialiser throws in production is too late. Call the registry's `compatibility` endpoint in a pre-merge check.
- **Assuming the broker validates schemas.** Kafka stores opaque bytes and enforces nothing; all schema logic is in the clients and the registry. A misconfigured client can still write garbage the registry never saw.
- **Ignoring registry availability.** Treating the registry as optional infrastructure, then discovering producers stall when it is down and the ID is uncached. Run it HA and monitor it like a broker.
- **Best practice:** define a schema per topic, choose an explicit compatibility mode per subject (FULL for busy multi-team topics, BACKWARD for replay-heavy ones), evolve only with optional-with-default fields, gate every schema change on the registry's compatibility check in CI, and run the registry highly available.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** When a consumer suddenly fails to deserialise, the first move is to read the 4-byte schema ID off the failing message and `GET /schemas/ids/<id>` to see exactly which writer schema produced it, then diff it against the reader's schema — the mismatch is almost always a field that changed type or lost its default. `GET /subjects/<subject>/versions` shows the version history, and the `compatibility` endpoint reproduces whether a given change is legal. For opaque binary payloads, the Avro/Protobuf console tools (or `kafka-avro-console-consumer`) decode messages using the registry so you can actually read them.
- **Monitoring.** Watch the registry's availability and latency (it is on the client hot path), the request rate for registrations versus lookups (a spike in registrations can mean a client misconfigured to register per-message), and rejection rates from compatibility checks (rising rejections mean teams are attempting breaking changes — a process signal). On the client side, deserialisation error rates per consumer group localise a bad schema rollout quickly.
- **Security.** The registry stores your data contracts and is a control point, so protect it: TLS in transit, authentication, and role-based access so only authorised teams can *register* schemas or *change compatibility modes* on a subject — a lax mode change (someone setting a subject to NONE) removes everyone's guardrails. Restrict who can alter modes as tightly as who can deploy. Because the registry's backing store is a Kafka topic (`_schemas`), that topic's ACLs matter too (chapter 29).
- **Scaling.** The registry is read-heavy (lookups vastly outnumber registrations) and clients cache schema IDs, so it scales well horizontally behind a load balancer with a shared backing topic; run multiple instances for HA with a leader for writes. The genuine scaling discipline is *schema governance*: as topics and teams multiply, subject naming strategy, per-subject modes, and a CI compatibility gate are what keep evolution safe at scale — the registry is easy to scale; the *process* around it is the hard part.

## 9. Interview Questions

**Q: Why is publishing raw JSON on a Kafka topic a problem at scale?**
A: Because a topic is a contract between producers and consumers that evolve independently, and raw JSON makes that contract implicit and unenforced. A producer can rename a field, change a type, or drop a field with nothing stopping it, and the breakage surfaces late and silently — as a deserialisation error or, worse, a wrong-but-parseable value — in a consumer the producer team may not even know exists. There is no versioning to distinguish old shape from new, and every message wastes bytes shipping its field names as text. A schema plus a registry replaces "we agreed not to break this" with "the system will not let you break this", and shrinks the payload at the same time.

**Q: How does the Schema Registry keep messages compact while enforcing a schema?**
A: By never shipping the schema with the message. The producer registers the schema once and gets back a globally unique integer schema ID; each message is then written as a magic byte, the 4-byte schema ID, and the compact binary payload — no field names, no schema. The consumer reads the ID, fetches that schema from the registry (caching it, so it is one lookup per ID, not per message), and decodes. So the payload carries a 5-byte pointer to its schema rather than the schema itself, which is as small as a schemaless binary format, while the contract stays centrally stored, versioned, and enforced at registration time.

**Q: What is a subject, and what is it for?**
A: A subject is the named scope under which a schema evolves and against which compatibility is enforced. By default the registry uses `<topic>-value` and `<topic>-key`, so each topic's value schema evolves as its own versioned history. The compatibility mode is set per subject, which is what lets you make a busy shared topic FULL while a private one is BACKWARD or even NONE. Subject naming strategy (topic-name, record-name, or topic-record-name) also decides whether one topic can carry multiple record types.

**Q: Explain BACKWARD compatibility and its upgrade order.**
A: BACKWARD means a new schema can read data written with the old schema. The scenario it protects is a consumer being upgraded while old-format records are still on the topic (or being replayed): the new consumer, using the new schema, must still decode those old records. So under BACKWARD you upgrade *consumers first*, then producers. The allowed changes are deleting a field and adding an optional field with a default — the new reader skips the removed field and supplies the default for the added one when it meets old data. It is the registry's default and a good fit for Kafka because it supports reprocessing history with new code.

**Q: Explain FORWARD compatibility and its upgrade order.**
A: FORWARD means an old schema can read data written with the new schema. The scenario is a producer being upgraded ahead of its consumers: a new producer writes new-format records that old consumers, still on the old schema, must decode. So under FORWARD you upgrade *producers first*, then consumers. The allowed changes are adding a field (old readers ignore it) and deleting an optional field (old readers use its default). You choose FORWARD when producers must move ahead of the readers, for example when a central producer's change cannot wait for every downstream consumer to be updated.

**Q: What does FULL compatibility require, and when do you want it?**
A: FULL requires both backward and forward compatibility — a new schema reads old data *and* an old schema reads new data — so the only always-safe change is adding or removing an optional field that has a default. Because it is compatible both ways, the upgrade order is unconstrained, which is exactly why you want it on a busy topic written and read by many independent teams whose deploy order you cannot coordinate. It is the strictest common mode, trading flexibility of change for the freedom to roll out in any order.

**Q: What is the difference between Avro and Protobuf for Kafka?**
A: Both are compact binary formats with schemas, and both work with the registry, but they lean differently. Avro defines its schema in JSON, ships no field names on the wire, and has a schema-resolution model (writer schema plus reader schema, with defaults for missing fields) that fits the registry and dynamic decoding naturally — it is the traditional Kafka default for data-in-motion pipelines. Protobuf uses an IDL (`.proto`) with generated, strongly-typed classes, has excellent cross-language tooling, and shares lineage with gRPC, so it is the natural choice when you already live in a Protobuf/gRPC world and want typed models everywhere. Roughly: Avro for pipeline data and dynamic consumers, Protobuf for typed, code-generated, cross-service contracts.

**Q: (Senior) A team needs to add a mandatory field to an event on a shared topic under BACKWARD compatibility. How do you guide them?**
A: A truly mandatory field cannot be added directly under BACKWARD, because BACKWARD requires the new schema to read old data, and old records have no value for the new required field and no default to fall back on — so the registry will (and should) reject it. The correct path is a two-step evolution. First, add the field as *optional with a sensible default* — that is legal under BACKWARD (and even FULL) — and deploy it; producers start populating it, consumers start reading it, and over a transition window the field becomes reliably present on all live traffic. If the field must eventually be genuinely required, you either accept the default as the semantic "unknown/absent" marker permanently, or you plan a second phase once all old data has aged out of retention (or been reprocessed) and no consumer replays that far back, at which point tightening it may be possible under a transitive check — but in practice most teams keep it optional-with-default forever, because a shared, replayable topic almost always has old records somewhere. The deeper guidance is that "mandatory" is a producer-side and application-side invariant, not something you enforce by making the field non-optional in the schema; you enforce presence in the producing code and validation, and keep the *schema* permissive so evolution stays safe. And I would wire the registry's compatibility check into CI so the rejected change fails the build with a clear message rather than surprising them at deploy.

**Q: (Senior) Why is the Schema Registry on the critical path, and how do you keep that from causing outages?**
A: Because (de)serialisation depends on it. A producer serialising a record must have a schema ID — which means registering the schema (a registry call) the first time, and a consumer decoding a record must resolve the writer schema for the ID it reads — which means a registry lookup the first time it sees that ID. Both cache aggressively (an ID maps to an immutable schema, so it is cached forever), so in steady state the registry is off the hot path; the danger is *cold* clients or *new* IDs during a registry outage — a freshly started consumer that meets a schema ID it has not cached, or a producer trying to register a new schema version, cannot proceed if the registry is unreachable. The defences are, first, run the registry highly available — multiple instances behind a load balancer, backed by the replicated `_schemas` topic, with a leader for writes — so it is as available as the brokers; second, warm client caches and avoid patterns that force per-message registration (a misconfigured serialiser that re-registers constantly turns a cache into a storm); third, pin and pre-register schemas at deploy time in CI so producers are not registering novel schemas at runtime under load; and fourth, monitor registry latency and availability as first-class SLOs because they gate client throughput. The mental model is that adopting the registry adds a dependency with the same availability requirements as Kafka itself, and you engineer it to that standard rather than treating it as optional side infrastructure.

**Q: (Senior) What are transitive compatibility modes and when do you need them?**
A: The plain modes (BACKWARD, FORWARD, FULL) check a new schema only against the *immediately previous* version. The transitive variants (BACKWARD_TRANSITIVE, FORWARD_TRANSITIVE, FULL_TRANSITIVE) check it against *all* prior versions in the subject's history. You need transitive when consumers may read or replay records written under *any* historical schema, not just the last one — which is common on Kafka precisely because the log is replayable and a consumer resetting to offset zero will meet the oldest schemas. Without transitivity, a chain of individually-compatible changes can accumulate into something that cannot read the oldest data; the transitive check prevents that at the cost of constraining evolution more tightly.

## 10. Quick Revision & Cheat Sheet

| Mode | New reads old? | Old reads new? | Upgrade first | Typical allowed change |
|---|---|---|---|---|
| BACKWARD | Yes | No | Consumers | Delete field; add optional (default) |
| FORWARD | No | Yes | Producers | Add field; delete optional |
| FULL | Yes | Yes | Either | Add/remove optional with default |
| NONE | — | — | — | Anything (no checks) |

| Wire format byte layout | Bytes |
|---|---|
| Magic byte | 1 (`0x00`) |
| Schema ID | 4 (big-endian int) |
| Payload | rest (Avro/Protobuf binary, no field names) |

| Format | Schema in | Strength |
|---|---|---|
| Avro | JSON (`.avsc`) | Compact, schema resolution, registry-native |
| Protobuf | IDL (`.proto`) | Typed classes, cross-language, gRPC lineage |
| JSON Schema | JSON | Human-readable payloads |

**Flash cards**
- **Why not raw JSON?** → No contract, no versioning, silent late breakage, field names on the wire.
- **How is it compact yet enforced?** → 5-byte ID travels; the schema is fetched by ID and cached, never shipped.
- **BACKWARD?** → New reads old → consumers upgrade first (great for replay).
- **FORWARD?** → Old reads new → producers upgrade first.
- **FULL?** → Both ways, any order; only optional-with-default changes.
- **Safest single change?** → Add an optional field with a default (legal under every mode).

## 11. Hands-On Exercises & Mini Project

- [ ] Register an Avro schema for a `users` topic, set the subject to BACKWARD, and produce/consume with a registry-aware serialiser; inspect the 5-byte prefix on a raw message.
- [ ] Add an optional field with a default and confirm old records still deserialise in the new consumer (BACKWARD paying off).
- [ ] Attempt to add a *required* field with no default and watch the registry reject it; then make it optional-with-default and watch it succeed.
- [ ] Flip the subject to FORWARD, upgrade the producer first, and show an old consumer still reading new records.
- [ ] Call the `compatibility` REST endpoint on a candidate schema and wire the same check into a CI job that fails on incompatibility.
- [ ] Repeat the exercise with Protobuf (`.proto` + Protobuf serialiser) and compare wire size and ergonomics against Avro.

### Mini Project — "Safe Schema Evolution Pipeline"

**Goal.** Build a producer/consumer pair on a schema-managed topic and evolve the schema through several versions without ever breaking a running consumer, proving each compatibility mode's rules.

**Requirements.**
1. Define an Avro schema for an `orders` event, register it under `orders-value`, and set the compatibility mode explicitly to FULL.
2. Write a Go producer and consumer using the registry-aware Avro serialiser/deserialiser; verify the on-wire magic-byte + ID prefix.
3. Evolve the schema by adding an optional field with a default, register the new version, and show old and new producers/consumers interoperating in any deploy order.
4. Attempt an incompatible change (rename a field, or add a required field) and demonstrate the registry rejecting it via both the serialiser and the `compatibility` endpoint.
5. Add a CI step that runs the compatibility check against the registry so a breaking schema change fails the build.

**Extensions.**
- Switch the subject to BACKWARD and demonstrate replaying the topic from offset zero with a new consumer that reads every historical schema version (introduce a case that requires a transitive mode).
- Add a second consumer written in another language and confirm cross-language decoding via the shared registry.
- Measure and compare payload sizes for the same record as raw JSON, Avro, and Protobuf.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Kafka Connect & Change Data Capture* (the converters and compatibility CDC pipelines depend on), *Design: Kafka Streams & Stream Processing Basics* (typed records flowing through topologies), *The Log: Offsets, Segments & Retention* (why replay makes transitive compatibility matter), *Delivery Guarantees* (schema-safe records as part of correct end-to-end processing), *Design: Kafka vs RabbitMQ* (where schema discipline sits in each ecosystem).

- **Confluent Schema Registry — Documentation** — Confluent · *Intermediate* · the authoritative reference for subjects, the wire format, and compatibility modes. <https://docs.confluent.io/platform/current/schema-registry/index.html>
- **Schema Evolution and Compatibility** — Confluent · *Advanced* · the definitive breakdown of BACKWARD/FORWARD/FULL/NONE and their transitive variants with allowed changes. <https://docs.confluent.io/platform/current/schema-registry/fundamentals/avro.html>
- **Apache Avro — Specification** — Apache Avro · *Advanced* · the format itself, including schema resolution rules that make evolution work at read time. <https://avro.apache.org/docs/current/specification/>
- **Protocol Buffers — Language Guide** — Google · *Intermediate* · Protobuf's IDL, field numbers, and how they enable safe evolution. <https://protobuf.dev/programming-guides/proto3/>
- **Designing Data-Intensive Applications, ch. 4 (Encoding & Evolution)** — Martin Kleppmann · *Advanced* · the definitive treatment of schema evolution, backward/forward compatibility, and why it matters. <https://dataintensive.net/>
- **Schema Registry REST API reference** — Confluent · *Intermediate* · every endpoint for subjects, versions, IDs, config and the compatibility test. <https://docs.confluent.io/platform/current/schema-registry/develop/api.html>
- **Yes, Virginia, You Really Do Need a Schema Registry** — Confluent (Gwen Shapira) · *Intermediate* · the argument for enforced contracts on a bus, and the failure modes without one. <https://www.confluent.io/blog/schema-registry-kafka-stream-processing-yes-virginia-you-really-need-one/>
- **confluent-kafka-go — Schema Registry examples** — Confluent · *Intermediate* · working Go producer/consumer code with the Avro and Protobuf serialisers used in this chapter. <https://github.com/confluentinc/confluent-kafka-go>

---

*Kafka & RabbitMQ Handbook — chapter 26.*
