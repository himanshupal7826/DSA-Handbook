# 08 · Data Types, Collections & UDTs

> **In one line:** CQL's native types are cheap and boring, but collections, tuples and UDTs each hide a specific storage or tombstone cost — knowing which is which is the difference between a schema that ages well and one that generates 10,000 tombstones per read.

---

## 1. Overview

CQL looks enough like SQL that most engineers copy their `VARCHAR`/`INT`/`TIMESTAMP` habits over unchanged, and for the scalar types that is mostly fine: `text` is UTF-8, `int` is a 4-byte signed integer, `timestamp` is milliseconds since the epoch. Where CQL diverges sharply is the "convenient" types — `set`, `list`, `map`, `tuple`, and user-defined types. These are not relational features bolted on; they are *encodings over Cassandra's underlying cell model*, and that encoding determines whether an update is a cheap append, an expensive read-modify-write, or a tombstone factory.

The reason these types exist at all is that Cassandra has no joins. In a relational database, a user's phone numbers live in a `phones` child table and you join. In Cassandra a join is impossible, so you must either build a second query table (chapter 07's approach) or embed the phone numbers inside the user row. Collections and UDTs are the embedding mechanism. They let a single partition carry a nested structure so one seek returns everything the screen needs. That is a real and important win — but it comes with a hard rule: **collections are for small, bounded, whole-row data**, not for unbounded lists that grow with time.

The internal model to hold onto is that Cassandra's storage engine knows only *cells* keyed by `(partition key, clustering key, column name/path)`. A `map<text,text>` with three entries is stored as three cells whose "column path" is the map key. A non-frozen UDT with five fields is five cells. A *frozen* collection or UDT is exactly one cell containing an opaque serialized blob. That single distinction — one cell per element versus one blob — explains nearly every behavioural difference: what you can update in place, what generates a tombstone, what can be part of a primary key, and what you can index.

The historical arc matters too. Collections arrived in Cassandra 1.2 with a hard 64 K element limit and a 64 K per-element limit because of the protocol's 16-bit length encoding; native protocol v3 (Cassandra 2.1) lifted that to 32-bit, but the *practical* guidance never moved: keep collections in the low hundreds of elements. UDTs also landed in 2.1 and were frozen-only until 3.6 (CASSANDRA-7423) allowed non-frozen UDTs with field-level updates. Cassandra 5.0 added `vector<float, n>` for approximate nearest-neighbour search — the first genuinely new type in years.

A concrete failure story that every practitioner has seen: a product team models a user's activity feed as `feed list<frozen<event>>` on the user row. It works beautifully for a month. Then a user with 40,000 events arrives, and because a `list` append with `UPDATE ... SET feed = feed + [?]` is fine but *any* read reads the whole list, that user's profile page starts pulling 6 MB into heap on every request, and a `feed = feed - [?]` removal rewrites it entirely. The fix is not a bigger heap; it is a clustering column.

---

## 2. Core Concepts

- **Native (scalar) type** — a built-in single-value CQL type: `text`/`varchar`, `int`, `bigint`, `smallint`, `tinyint`, `float`, `double`, `decimal`, `varint`, `boolean`, `blob`, `uuid`, `timeuuid`, `timestamp`, `date`, `time`, `duration`, `inet`, `counter`.
- **Cell** — the atomic storage unit: a value plus a write timestamp plus optional TTL, addressed by partition key, clustering key and column path. Everything in Cassandra is cells.
- **Collection** — `set<T>`, `list<T>` or `map<K,V>`. Non-frozen by default: each element is its own cell, individually updatable and individually TTL-able.
- **Frozen** — `frozen<...>` serializes a collection, tuple or UDT into a **single opaque cell**. It becomes immutable as a whole (you can only replace it), comparable, and therefore legal in a primary key or as a collection element.
- **UDT (user-defined type)** — a named, keyspace-scoped struct: `CREATE TYPE address (street text, city text, zip text)`. Non-frozen UDTs allow per-field `UPDATE`; frozen UDTs are replace-only.
- **Tuple** — a fixed-arity anonymous struct, `tuple<text,int,uuid>`. Always frozen in practice (implicitly frozen since 3.x); use it for throwaway composites, use a UDT when the fields deserve names.
- **Counter** — a special distributed-increment type. A counter column cannot coexist with non-counter columns in a table, is not idempotent under retry, and cannot have a TTL.
- **Collection tombstone (range tombstone)** — the marker written when you *assign* a whole collection (`SET tags = {...}`), which deletes every prior element before inserting the new ones. The single largest source of surprise tombstones in Cassandra.
- **`vector<float, n>`** — Cassandra 5.0's fixed-dimension float vector type, used with SAI's ANN index for similarity search.
- **Element limits** — a collection element value is capped at 2 GB by the protocol but the practical budget is **< a few hundred elements and < 64 KB total**; the whole collection is read whenever any of it is read.

---

## 3. Theory & Internals

### Frozen versus non-frozen: one cell or many

Take `CREATE TABLE u (id uuid PRIMARY KEY, tags set<text>, addr address)`.

- `tags` non-frozen with `{'a','b','c'}` is stored as **three cells**: `(id, , tags['a'])`, `(id, , tags['b'])`, `(id, , tags['c'])`, each with its own write timestamp. Adding `'d'` writes one new cell — no read, no coordination, conflict-free. Removing `'b'` writes one *cell tombstone*.
- `frozen<set<text>>` is **one cell** whose value is the serialized set. Adding `'d'` requires the client to send the full new set; the old cell is simply overwritten by timestamp. No tombstone, but no concurrent-append semantics either.

That is the whole trade: non-frozen buys you conflict-free concurrent element updates at the price of one cell per element and per-element tombstones. Frozen buys you compactness and comparability at the price of whole-value replacement.

### Why `SET col = {...}` is a tombstone bomb

Assigning a whole non-frozen collection cannot know which elements existed before, so Cassandra writes a **range tombstone covering the entire collection's column path**, then inserts the new cells at the same timestamp. Every such write leaves a tombstone that survives `gc_grace_seconds` (default **864000** = 10 days). A row updated with `SET tags = {...}` 100 times a day accumulates ~1,000 collection tombstones in that window; reads of that row scan them all, and at 1,000 you cross `tombstone_warn_threshold`, at 100,000 the query is aborted by `tombstone_failure_threshold`.

The fix is to use the **delta operators** instead, which write only the affected cells:

```
UPDATE u SET tags = tags + {'x'} WHERE id = ?;   -- one cell, no tombstone
UPDATE u SET tags = tags - {'y'} WHERE id = ?;   -- one cell tombstone only
```

### Why `list` is the worst collection

`list<T>` preserves order and permits duplicates, so each element is keyed by a generated **timeuuid** rather than by its value. That has three consequences:

1. **Prepend/append are safe** (`l = l + [?]`, `l = [?] + l`) — they just write a new cell.
2. **Positional operations (`SET l[2] = ?`, `DELETE l[2]`) require a read-before-write**: the coordinator must read the list at `QUORUM` to learn which timeuuid sits at index 2. That is a hidden internal read on the write path, with all its latency and consistency caveats.
3. **`l = l - [v]` also reads first** to find matching elements.

If you do not need duplicates or ordering, use `set`. If you need ordering, use a clustering column. Reserve `list` for genuinely small ordered bags you only append to.

### Where each type may legally appear

| Construct | Non-frozen collection | Frozen collection / UDT | Tuple | Counter |
| --- | --- | --- | --- | --- |
| Partition or clustering key | ✗ | ✓ | ✓ | ✗ |
| Element of another collection | ✗ | ✓ | ✓ | ✗ |
| Per-field / per-element update | ✓ | ✗ (replace whole) | ✗ | n/a |
| Per-element TTL | ✓ | ✗ (whole cell) | ✗ | ✗ (no TTL) |

```svg
<svg viewBox="0 0 760 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="760" height="320" fill="#ffffff"/>
  <text x="20" y="26" font-size="15" font-weight="700" fill="#1e293b">Frozen vs non-frozen: the same data, two storage layouts</text>
  <rect x="20" y="44" width="350" height="130" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="34" y="66" font-size="12" font-weight="700" fill="#1e293b">tags set&lt;text&gt;   (non-frozen)</text>
  <text x="34" y="84" font-size="11" fill="#1e293b">one cell per element, own timestamp + TTL</text>
  <rect x="34" y="94" width="100" height="26" rx="4" fill="#ffffff" stroke="#0ea5e9"/>
  <text x="44" y="111" font-size="11" fill="#1e293b">tags['a'] ts=7</text>
  <rect x="142" y="94" width="100" height="26" rx="4" fill="#ffffff" stroke="#0ea5e9"/>
  <text x="152" y="111" font-size="11" fill="#1e293b">tags['b'] ts=9</text>
  <rect x="250" y="94" width="100" height="26" rx="4" fill="#ffffff" stroke="#0ea5e9"/>
  <text x="260" y="111" font-size="11" fill="#1e293b">tags['c'] ts=9</text>
  <text x="34" y="140" font-size="11" fill="#1e293b">tags = tags + {'d'}  →  writes 1 cell, no read</text>
  <text x="34" y="158" font-size="11" fill="#1e293b">tags = tags - {'b'}  →  writes 1 cell tombstone</text>
  <rect x="390" y="44" width="350" height="130" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="404" y="66" font-size="12" font-weight="700" fill="#1e293b">frozen&lt;set&lt;text&gt;&gt;</text>
  <text x="404" y="84" font-size="11" fill="#1e293b">one opaque cell, one timestamp for everything</text>
  <rect x="404" y="94" width="320" height="26" rx="4" fill="#ffffff" stroke="#16a34a"/>
  <text x="414" y="111" font-size="11" fill="#1e293b">tags = 0x03…['a','b','c'] serialized   ts=9</text>
  <text x="404" y="140" font-size="11" fill="#1e293b">any change  →  client sends the whole new set</text>
  <text x="404" y="158" font-size="11" fill="#1e293b">legal in PRIMARY KEY, legal inside another collection</text>
  <text x="20" y="204" font-size="14" font-weight="700" fill="#1e293b">The tombstone bomb: assignment vs delta</text>
  <rect x="20" y="218" width="350" height="86" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="34" y="240" font-size="12" font-weight="700" fill="#1e293b">SET tags = {'a','b'}</text>
  <rect x="34" y="250" width="150" height="24" rx="4" fill="#ffffff" stroke="#d97706"/>
  <text x="44" y="266" font-size="11" fill="#1e293b">RANGE TOMBSTONE</text>
  <rect x="192" y="250" width="70" height="24" rx="4" fill="#ffffff" stroke="#d97706"/>
  <text x="202" y="266" font-size="11" fill="#1e293b">cell 'a'</text>
  <rect x="270" y="250" width="70" height="24" rx="4" fill="#ffffff" stroke="#d97706"/>
  <text x="280" y="266" font-size="11" fill="#1e293b">cell 'b'</text>
  <text x="34" y="294" font-size="11" fill="#1e293b">survives gc_grace_seconds = 864000 s (10 days)</text>
  <rect x="390" y="218" width="350" height="86" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="404" y="240" font-size="12" font-weight="700" fill="#1e293b">SET tags = tags + {'b'}</text>
  <rect x="404" y="250" width="70" height="24" rx="4" fill="#ffffff" stroke="#4f46e5"/>
  <text x="414" y="266" font-size="11" fill="#1e293b">cell 'b'</text>
  <text x="482" y="266" font-size="11" fill="#1e293b">no tombstone, no read-before-write</text>
  <text x="404" y="294" font-size="11" fill="#1e293b">idempotent and safe to retry</text>
</svg>
```

---

## 4. Architecture & Workflow

What actually happens when you write a row containing a UDT and two collections:

1. **Client-side serialization.** The driver looks up the type in its schema metadata and encodes each value using the native protocol's type codec. A frozen UDT is serialized into one byte buffer here; a non-frozen UDT is sent as separate field values. Version matters: a UDT altered with `ALTER TYPE ... ADD` must be re-fetched by the driver's schema agreement, or you get a `Not enough bytes` decode error.
2. **Coordinator parses into a `Mutation`.** Each non-frozen collection element becomes a separate `Cell` with a `CellPath` (the map key, the set value, or the list's generated timeuuid). A frozen value becomes a single `Cell` with an empty path.
3. **Read-before-write check.** If the statement uses a positional list operation, a `list - [v]` removal, or a lightweight transaction, the coordinator issues an internal read at the appropriate consistency level *before* applying the mutation. Ordinary appends skip this entirely.
4. **Collection assignment inserts a range tombstone.** If the statement assigns a whole non-frozen collection, a range tombstone spanning the collection's `CellPath` range is added to the mutation ahead of the new cells, at the same timestamp minus one, so the new cells win.
5. **Commit log → memtable → SSTable.** Cells are appended to the commit log and inserted into the memtable's sorted structure; on flush they land in the SSTable, where cells of one collection are contiguous within the row.
6. **Read path merge.** A read reconstructs the collection by merging all cells for that column path across memtable and every candidate SSTable, applying tombstones by timestamp. **This is why you cannot read one element of a collection** — the engine must materialize the whole thing to know what survives. It is also why a collection under heavy assignment churn slows every read of the row.
7. **Compaction reclaims.** After `gc_grace_seconds` and once compaction can prove all replicas have the tombstone (overlapping SSTables considered), the tombstones and shadowed cells are dropped.

```svg
<svg viewBox="0 0 760 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="760" height="330" fill="#ffffff"/>
  <text x="20" y="24" font-size="15" font-weight="700" fill="#1e293b">Write path for a row with a UDT and collections</text>
  <rect x="20" y="42" width="140" height="72" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="32" y="62" font-size="12" font-weight="700" fill="#1e293b">1. Driver</text>
  <text x="32" y="80" font-size="11" fill="#1e293b">codec per type</text>
  <text x="32" y="96" font-size="11" fill="#1e293b">frozen → 1 buffer</text>
  <rect x="180" y="42" width="160" height="72" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="192" y="62" font-size="12" font-weight="700" fill="#1e293b">2. Coordinator</text>
  <text x="192" y="80" font-size="11" fill="#1e293b">Mutation of Cells</text>
  <text x="192" y="96" font-size="11" fill="#1e293b">CellPath = map key</text>
  <rect x="360" y="42" width="180" height="72" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="372" y="62" font-size="12" font-weight="700" fill="#1e293b">3. Read-before-write?</text>
  <text x="372" y="80" font-size="11" fill="#1e293b">list[i] = ? · list - [v]</text>
  <text x="372" y="96" font-size="11" fill="#1e293b">LWT → yes. append → no</text>
  <rect x="560" y="42" width="180" height="72" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="572" y="62" font-size="12" font-weight="700" fill="#1e293b">4. Whole-collection SET?</text>
  <text x="572" y="80" font-size="11" fill="#1e293b">prepend RANGE</text>
  <text x="572" y="96" font-size="11" fill="#1e293b">TOMBSTONE</text>
  <path d="M162 78 L 176 78" stroke="#1e293b" stroke-width="2"/>
  <path d="M342 78 L 356 78" stroke="#1e293b" stroke-width="2"/>
  <path d="M542 78 L 556 78" stroke="#1e293b" stroke-width="2"/>
  <path d="M650 118 L 650 140 L 110 140 L 110 158" stroke="#4f46e5" stroke-width="1.5" fill="none"/>
  <rect x="20" y="162" width="180" height="60" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="32" y="182" font-size="12" font-weight="700" fill="#1e293b">5. commitlog + memtable</text>
  <text x="32" y="200" font-size="11" fill="#1e293b">flush → SSTable</text>
  <text x="32" y="216" font-size="11" fill="#1e293b">cells contiguous in row</text>
  <path d="M202 192 L 236 192" stroke="#16a34a" stroke-width="2"/>
  <rect x="240" y="162" width="250" height="60" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="252" y="182" font-size="12" font-weight="700" fill="#1e293b">6. Read = merge ALL cells</text>
  <text x="252" y="200" font-size="11" fill="#1e293b">no partial collection read exists</text>
  <text x="252" y="216" font-size="11" fill="#1e293b">tombstones scanned on every read</text>
  <path d="M492 192 L 526 192" stroke="#0ea5e9" stroke-width="2"/>
  <rect x="530" y="162" width="210" height="60" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="542" y="182" font-size="12" font-weight="700" fill="#1e293b">7. Compaction reclaims</text>
  <text x="542" y="200" font-size="11" fill="#1e293b">after gc_grace_seconds</text>
  <text x="542" y="216" font-size="11" fill="#1e293b">864000 s default</text>
  <rect x="20" y="242" width="720" height="66" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="34" y="264" font-size="12" font-weight="700" fill="#1e293b">Consequence to memorise</text>
  <text x="34" y="284" font-size="12" fill="#1e293b">Reading any part of a collection materialises all of it, including its tombstones.</text>
  <text x="34" y="302" font-size="12" fill="#1e293b">So: collections stay small and bounded; growth over time belongs in a clustering column.</text>
</svg>
```

---

## 5. Implementation

```cql
CREATE KEYSPACE app WITH replication =
  {'class':'NetworkTopologyStrategy','us_east':3,'eu_west':3};

CREATE TYPE app.address (
  line1 text, line2 text, city text, region text, postcode text, country text
);

CREATE TYPE app.phone (label text, e164 text);

CREATE TABLE app.user_profile (
  user_id      uuid PRIMARY KEY,
  email        text,
  display_name text,
  created_at   timestamp,
  -- non-frozen UDT: individual fields can be updated in place (3.6+)
  home         address,
  -- frozen UDT inside a collection: required, since collection elements must be frozen
  phones       set<frozen<phone>>,
  -- small bounded map, updated with delta operators only
  prefs        map<text, text>,
  -- frozen list used as an ordered, replace-only value
  recent_skus  frozen<list<text>>,
  login_count  int
);
```

Updating without creating tombstones:

```cql
-- ✅ delta operators: one cell each, no range tombstone
UPDATE app.user_profile SET prefs = prefs + {'theme':'dark'}   WHERE user_id = 8f2a...;
UPDATE app.user_profile SET prefs = prefs - {'legacy_banner'}  WHERE user_id = 8f2a...;
UPDATE app.user_profile SET phones = phones + {{label:'work', e164:'+14155550110'}}
  WHERE user_id = 8f2a...;

-- ✅ non-frozen UDT field update — touches one cell, not the whole struct
UPDATE app.user_profile SET home.city = 'Berlin', home.postcode = '10115'
  WHERE user_id = 8f2a...;

-- ❌ whole-collection assignment: writes a range tombstone every single time
UPDATE app.user_profile SET prefs = {'theme':'dark','lang':'en'} WHERE user_id = 8f2a...;

-- ✅ per-element TTL is legal on non-frozen collections
UPDATE app.user_profile USING TTL 3600
  SET prefs = prefs + {'promo_seen':'summer26'} WHERE user_id = 8f2a...;

-- frozen values are replace-only, and are comparable so they can key a table
CREATE TABLE app.route_stats (
  route frozen<tuple<text,text>>,
  day   date,
  hits  counter,
  PRIMARY KEY ((route, day))
);
UPDATE app.route_stats SET hits = hits + 1 WHERE route = ('LHR','JFK') AND day = '2026-07-22';
```

The unbounded-collection anti-pattern and its fix:

```cql
-- ❌ grows forever, read pulls every event into heap
CREATE TABLE bad_feed (user_id uuid PRIMARY KEY, events list<frozen<event>>);

-- ✅ clustering column: bounded slices, free ordering, per-row TTL
CREATE TABLE app.feed_by_user (
  user_id  uuid,
  bucket   text,          -- 'yyyy-MM'
  event_id timeuuid,
  kind     text,
  payload  text,
  PRIMARY KEY ((user_id, bucket), event_id)
) WITH CLUSTERING ORDER BY (event_id DESC)
  AND default_time_to_live = 7776000
  AND compaction = {'class':'TimeWindowCompactionStrategy',
                    'compaction_window_unit':'DAYS','compaction_window_size':1};
```

Python driver with UDT mapping:

```python
from cassandra.cluster import Cluster
from collections import namedtuple

session = Cluster(["10.0.1.11"]).connect("app")
Address = namedtuple("Address", "line1 line2 city region postcode country")
Phone   = namedtuple("Phone", "label e164")
session.cluster.register_user_type("app", "address", Address)
session.cluster.register_user_type("app", "phone", Phone)

ins = session.prepare("""INSERT INTO user_profile
    (user_id, email, display_name, home, phones, prefs)
    VALUES (?,?,?,?,?,?)""")
session.execute(ins, (uid, "a@b.io", "Ada",
                      Address("12 Elm", None, "Berlin", "BE", "10115", "DE"),
                      {Phone("mobile", "+491700000001")},
                      {"theme": "dark"}))

row = session.execute("SELECT home, phones FROM user_profile WHERE user_id=%s", (uid,)).one()
print(row.home.city, {p.label for p in row.phones})
# Berlin {'mobile'}
```

Diagnosing collection damage:

```bash
nodetool tablehistograms app user_profile
# 99%  SSTables 3.00  Read(μs) 4055.00  Partition Size 74975  Cell Count 1109

# tombstones scanned per read — the collection-assignment smell
nodetool tablestats app.user_profile | grep -i tombstone
# Average tombstones per slice (last five minutes): 812.4
# Maximum tombstones per slice (last five minutes): 4877

# 4.0+ virtual table, easier than JMX
cqlsh -e "SELECT keyspace_name, table_name, tombstones_per_read_p99
          FROM system_views.tombstones_scanned WHERE keyspace_name='app' ALLOW FILTERING;"
```

```yaml
# cassandra.yaml — keep the guardrails on; do not raise them to hide a modeling bug
tombstone_warn_threshold: 1000
tombstone_failure_threshold: 100000
batch_size_warn_threshold: 5KiB
```

> **Optimization:** if a map is read on every request but written rarely and always in full, `frozen<map<...>>` is measurably better — one cell instead of N means fewer cells to merge, a smaller row index, no per-element timestamps (8 bytes each) and zero collection tombstones. Benchmarks on a 50-entry map typically show 20–35 % lower read latency frozen. Conversely, if two writers concurrently touch different keys of the same map, non-frozen is *required* for correctness — frozen would make them last-write-wins over the whole map.

---

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
| --- | --- | --- |
| Non-frozen collections | Conflict-free concurrent element updates; per-element TTL; no read-before-write on add | One cell per element (≈ 20+ B overhead each); assignment writes range tombstones |
| Frozen collections / UDTs | One compact cell; comparable, so usable in primary keys and inside other collections | Whole-value replace only; last-write-wins across the entire structure |
| UDTs | Named, typed nesting; keeps a screen's data in one partition; field-level updates when non-frozen | `ALTER TYPE` is add-only and never renames/drops; drivers must agree on schema; awkward to evolve |
| Tuples | Zero ceremony for a fixed composite; great as a compound partition key | No field names — unreadable at the call site and impossible to extend |
| Lists | Preserves order and duplicates | Positional and value-removal ops require an internal read-before-write; the slowest collection |
| Counters | Cheap distributed increment without LWT | Non-idempotent on retry, no TTL, own table required, more expensive reads, no mixing with regular columns |
| `blob` | Escape hatch for opaque payloads | Cassandra cannot filter, index or repair-diff meaningfully inside it; keep well under 1 MB |
| `vector<float,n>` (5.0) | Native ANN search via SAI, no external vector DB | New in 5.0 only; index build and memory cost scale with dimension × row count |

---

## 7. Common Mistakes & Best Practices

1. ⚠️ **Using a collection for unbounded data** (a feed, a log, a message list). ✅ Any structure that grows with time belongs in clustering columns of its own table, bucketed. Collections are for whole-row attributes with a natural small cap.
2. ⚠️ **`UPDATE ... SET map_col = {...}` on every write**, silently emitting a range tombstone each time. ✅ Always use `col = col + {...}` / `col = col - {...}` deltas. Reserve full assignment for genuine "reset to this exact value" semantics.
3. ⚠️ **Choosing `list` by default because it looks like a Java `List`.** ✅ Use `set` unless you truly need order and duplicates; `list[i] = ?` and `list - [v]` trigger a read-before-write on the coordinator.
4. ⚠️ **Freezing everything "for safety".** A frozen collection cannot be partially updated, so two concurrent writers silently clobber each other. ✅ Freeze when the value is written atomically as a unit or needs to be part of a key; leave it non-frozen when writers are independent.
5. ⚠️ **Expecting `ALTER TYPE` to behave like a migration tool.** You can only `ADD` fields — no rename, no drop, no type change. ✅ Version your UDTs (`address_v2`) or, better, keep UDTs shallow and stable; nesting deep UDTs is a trap you cannot back out of.
6. ⚠️ **Putting a counter column next to normal columns.** Cassandra rejects it; counters need a dedicated table. ✅ Model counters in their own table and remember they are *not* safe to retry blindly — a timed-out increment may or may not have applied.
7. ⚠️ **Using `timestamp` where `timeuuid` is needed.** Two events in the same millisecond collide and one is lost. ✅ Use `timeuuid` for clustering columns on event streams; it is time-ordered *and* unique.
8. ⚠️ **Using `float`/`double` for money.** ✅ Use `decimal`, or store minor units in a `bigint` (`total_cents`), which is smaller and exact.
9. ⚠️ **Storing large blobs (images, documents) in a cell.** Anything over ~1 MB inflates the row, hurts compaction and streams poorly during repair. ✅ Store the object in S3/GCS and keep the key plus a checksum in Cassandra.
10. ⚠️ **Indexing a collection without understanding cardinality.** `CREATE INDEX ON t (tags)` on a high-cardinality set produces a cluster-wide scatter-gather per query. ✅ Prefer an inverted query table (`users_by_tag`), or SAI in 5.0 where the filter is genuinely secondary.
11. ⚠️ **Raising `tombstone_failure_threshold` when reads start failing.** That converts a loud failure into a slow cluster-wide death. ✅ Fix the write pattern that produces the tombstones.

---

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** The signature of a collection problem is a read latency that grows over days and recovers after a major compaction. Confirm it with `nodetool tablestats <ks>.<table>` — look at *Average/Maximum tombstones per slice* — and with `TRACING ON`, which prints `Read N live rows and M tombstone cells`. If `M` is a large multiple of `N`, someone is assigning collections. `sstabledump` on a single SSTable will show you the actual `range_tombstone` entries and their `deletion_time`, which tells you exactly which column path is at fault. `nodetool tablehistograms` *Cell Count* is the other tell: a row with 5 columns reporting 1,100 cells at p99 is a collection that has escaped its bounds.

**Monitoring.** Track `org.apache.cassandra.metrics:type=Table,keyspace=*,scope=*,name=TombstoneScannedHistogram` and `...name=LiveScannedHistogram` per table, plus `...name=EstimatedColumnCountHistogram` for cells per partition and `...name=ReadLatency`. Alert when p99 tombstones scanned exceeds ~200, long before the 1,000 warn threshold. Also watch `org.apache.cassandra.metrics:type=ClientRequest,scope=Write,name=Latency` — a jump correlated with list mutations indicates read-before-write on positional updates. In 4.0+ the `system_views.*` virtual tables surface the same data via CQL, which is much easier to scrape.

**Security.** UDTs and collections are opaque to CQL's `GRANT` system — permissions are per table and per column at best, never per UDT field. If a UDT holds PII (an `address`), the whole column must be treated as sensitive; encrypt sensitive fields client-side into a `blob` and keep the searchable fields plain. Note that client-side encryption defeats any index on that column, which is usually the right trade. Cassandra 4.0's audit log records the CQL text, so parameterize sensitive values with prepared statements rather than inlining them, or the values land in the audit file.

**Performance & scaling.** Cell count, not row count, drives read cost: each cell carries a write timestamp (8 B) and optional TTL/local-deletion metadata (8 B), so a 200-element non-frozen map costs ~3–5 KB of overhead alone. At scale, converting hot read-mostly collections to frozen is one of the highest-yield micro-optimizations available. Set `guardrails` in 4.1+ (`collection_size_warn_threshold`, `items_per_collection_warn_threshold`) so the cluster tells you when an application starts growing a collection unboundedly, rather than discovering it during an incident. For very hot rows, `caching = {'keys':'ALL','rows_per_partition':'NONE'}` avoids caching huge collection rows and evicting everything else.

---

## 9. Interview Questions

**Q: What is the difference between a frozen and a non-frozen collection?**
A: A non-frozen collection stores one cell per element, each with its own timestamp and TTL, so elements can be added or removed independently and concurrently. A frozen collection is serialized into a single opaque cell, so it can only be replaced wholesale — but it is compact and comparable, which makes it legal in a primary key or as an element of another collection.

**Q: Why does `UPDATE t SET tags = {'a','b'} WHERE id = ?` create tombstones?**
A: Assigning a whole non-frozen collection must remove whatever elements existed before, and Cassandra cannot know what those were without reading. It therefore writes a range tombstone covering the entire collection's cell-path range at a slightly lower timestamp, then inserts the new cells. Every such statement leaves a tombstone that lives for `gc_grace_seconds` (864000 by default).

**Q: When should you use a `list` instead of a `set`?**
A: Only when order matters *and* duplicates are meaningful, and only for append-mostly usage. Positional updates (`list[2] = ?`), positional deletes, and value-based removal all force the coordinator to read the list before writing, adding latency and consistency risk that `set` never incurs.

**Q: Can you put a collection in a primary key?**
A: Only if it is frozen. A non-frozen collection has no single serialized value to hash or sort, so it cannot be a partition key or clustering column; `frozen<set<text>>` or `frozen<tuple<...>>` can, because they are single comparable cells.

**Q: How do collections and UDTs interact?**
A: A collection's elements must be frozen, so `set<frozen<phone>>` is legal while `set<phone>` is not. A non-frozen UDT can only appear as a top-level column, where it gives you field-level updates such as `SET home.city = ?` (Cassandra 3.6+).

**Q: What are the limits on collection size?**
A: The protocol allows very large values, but the practical rule is a few hundred elements and tens of kilobytes. Every read of any part of a collection materializes the entire collection plus its tombstones into heap, so cost is linear in size on every request — not just on writes.

**Q: Why is a counter column special?**
A: Counters use a distinct read-modify-write replication path with per-replica shards, so they cannot share a table with non-counter columns, cannot have a TTL, and are not idempotent — a timed-out increment may have been applied, so blind retries can double-count. Use them only for approximate, high-volume counting.

**Q: (Senior) You inherit a table whose reads scan 8,000 tombstones per query. Diagnose and fix it without downtime.**
A: Confirm with `TRACING` and `nodetool tablestats` that the tombstones are range tombstones on a collection column, then `sstabledump` one SSTable to identify the column path. Almost always the cause is whole-collection assignment; change the application to delta operators, which stops new tombstone creation immediately. To reclaim existing ones, either wait out `gc_grace_seconds` with compaction running, or — after ensuring repairs are current — temporarily lower `gc_grace_seconds` on that table and run `nodetool compact` / switch to a strategy that will rewrite the SSTables. Never raise `tombstone_failure_threshold`.

**Q: (Senior) Frozen or non-frozen for a 50-key configuration map read on every request?**
A: If a single service owns the whole map and rewrites it atomically, frozen wins: one cell instead of 50, no per-element timestamps, no collection tombstones, and typically 20–35 % lower read latency. If independent writers update different keys concurrently, frozen is incorrect — it makes the whole map last-write-wins and silently loses updates — so non-frozen with delta operators is mandatory. The deciding question is always "who writes this, and can two writers race?"

**Q: (Senior) How do you evolve a UDT safely across a fleet of services?**
A: `ALTER TYPE ... ADD` is the only safe operation — no rename, no drop, no type change — and new fields read as `null` on old rows. Roll out driver/schema changes so that readers tolerate the new field before writers emit it, and rely on the drivers' schema-agreement handshake so no client decodes with a stale definition. For anything beyond adding a field, create a new type and a new column, dual-write, backfill, then stop writing the old column; deep nested UDTs make this migration painful, which is the strongest argument for keeping UDTs shallow.

**Q: What replaces a collection when the data is unbounded?**
A: A clustering column in a dedicated, bucketed table. That gives you ordered range slices with `LIMIT`, per-row TTL, `TimeWindowCompactionStrategy` for cheap expiry, and — critically — reads whose cost is proportional to the slice requested rather than to the total history.

**Q: What is `vector<float, n>` and when is it available?**
A: It is Cassandra 5.0's fixed-dimension float-vector type, used with a Storage-Attached Index to run approximate nearest-neighbour queries (`ORDER BY embedding ANN OF [...] LIMIT k`) for semantic search and RAG workloads. It is not available in 4.x, and its index memory and build cost scale with dimension times row count, so it is a real capacity-planning item rather than a free feature.

---

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Everything in Cassandra is cells. A non-frozen collection is one cell per element — independently updatable, individually TTL-able, and the reason `SET col = {...}` writes a range tombstone. A frozen collection or UDT is one opaque cell — compact, comparable, legal in a primary key, but replace-only and last-write-wins. Always mutate collections with `+`/`-` deltas, never by assignment. Prefer `set` over `list`, because positional and value-removal list operations force a read-before-write. Collections must be small and bounded; anything that grows with time belongs in a clustering column of its own bucketed table. Use `decimal` or `bigint` minor units for money, `timeuuid` for event ordering, and keep counters in their own table knowing they are non-idempotent.

| Item | Value / Syntax |
| --- | --- |
| Add / remove element | `SET s = s + {'x'}` · `SET s = s - {'x'}` |
| Map delta | `SET m = m + {'k':'v'}` · `SET m['k'] = 'v'` |
| List append / prepend | `SET l = l + [?]` · `SET l = [?] + l` |
| Non-frozen UDT field update | `SET home.city = 'Berlin'` (3.6+) |
| Collection element must be | `frozen<...>` |
| Legal in PRIMARY KEY | frozen collections, tuples, UDTs — never non-frozen |
| `gc_grace_seconds` default | `864000` (10 days) |
| Tombstone thresholds | warn `1000`, fail `100000` |
| Practical collection budget | < few hundred elements, < 64 KB |
| Guardrails (4.1+) | `collection_size_warn_threshold`, `items_per_collection_warn_threshold` |
| Vector type (5.0) | `vector<float, 1536>` + SAI ANN index |

**Flash cards**

- **What does `frozen` change physically?** → Many cells become one opaque cell: compact, comparable, replace-only.
- **Which single CQL statement is the top tombstone source?** → Whole-collection assignment, `SET col = {...}`.
- **Which collection triggers a read-before-write?** → `list`, on positional updates/deletes and on `l = l - [v]`.
- **Why can't a non-frozen collection be a clustering column?** → It has no single serialized, comparable value to sort by.
- **What replaces an unbounded collection?** → A clustering column in a bucketed table with a TTL and TWCS.

---

## 11. Hands-On Exercises & Mini Project

- [ ] Create a table with both `tags set<text>` and `ftags frozen<set<text>>`, insert one row into each, flush with `nodetool flush`, then run `sstabledump` on the SSTable and compare the cell structure for the two columns.
- [ ] Write the same row 200 times using `SET tags = {...}` assignment; then run `nodetool tablestats` and `TRACING ON` on a read and record the tombstone count. Repeat with `tags = tags + {...}` deltas and compare.
- [ ] Build a `list<text>` of 1,000 elements, then time `UPDATE t SET l[500] = 'x'` versus `UPDATE t SET l = l + ['x']` with tracing on. Identify the internal read in the trace of the positional update.
- [ ] Define a UDT, use it non-frozen, update one field with `SET addr.city = ?`, and confirm via `sstabledump` that only one cell was written. Then `ALTER TYPE ... ADD` a field and read an old row to see the `null`.
- [ ] Model a "user's last 10 searches" three ways — `frozen<list<text>>`, non-frozen `list<text>`, and a clustering-column table with `LIMIT 10` — then load 100k users and compare read p99 with `nodetool tablehistograms`.

### Mini Project — "Product catalogue with typed attributes"

**Goal.** Build a catalogue schema that uses each type appropriately, and prove with measurements which choices were right.

**Requirements.**
1. Model products with: a `frozen<address>`-style UDT for the supplier, a non-frozen `map<text,text>` for variant attributes (colour, size), a `set<frozen<price>>` UDT set for multi-currency prices, and a `decimal` base price.
2. Add a `reviews_by_product` table with clustering columns rather than a review collection, bucketed so no partition exceeds 100 MB, with `TimeWindowCompactionStrategy`.
3. Write a loader (Python or Java) that registers the UDTs with the driver, uses prepared statements at `LOCAL_QUORUM`, and populates 100k products and 5 M reviews.
4. Instrument two update paths for the attribute map — assignment versus delta — and produce a chart of tombstones-scanned-per-read over 24 hours for each.
5. Document, per column, why it is frozen or not, and what would break if you flipped it.

**Extensions.** Add a 5.0 `vector<float,384>` embedding column with a SAI ANN index and compare recall and latency against exact scan on 100k rows. Add guardrail settings and demonstrate a warning firing when a collection exceeds the configured item count. Convert the hottest read-only map to frozen and measure the p99 delta.

---

## 12. Related Topics & Free Learning Resources

**Sibling chapters.** *Query-First Data Modeling* explains when to embed with a collection versus build another table. *Denormalization & Table-per-Query* covers the duplication these types often replace. *Secondary Indexes, SAI & SASI* is where collection indexing and the 5.0 vector index live. *Data Modeling Anti-Patterns* catalogues the unbounded-collection failure in detail, and *Tombstones, TTL & gc_grace_seconds* explains the reclamation rules referenced throughout.

- **CQL Data Types Reference** — Apache Cassandra Documentation · *Beginner* · The authoritative list of native types, collection semantics, `frozen` rules and what is legal where. <https://cassandra.apache.org/doc/latest/cassandra/developing/cql/types.html>
- **CQL — Data Definition & User-Defined Types** — Apache Cassandra Documentation · *Intermediate* · Exact `CREATE TYPE` / `ALTER TYPE` semantics and the add-only evolution rule. <https://cassandra.apache.org/doc/latest/cassandra/developing/cql/ddl.html>
- **CASSANDRA-7423: Allow updating individual subfields of UDTs** — Apache JIRA · *Advanced* · The ticket that introduced non-frozen UDTs in 3.6; the discussion explains the cell-level design better than any blog post. <https://issues.apache.org/jira/browse/CASSANDRA-7423>
- **Cassandra Collections: Hidden Tombstones and How to Avoid Them** — The Last Pickle · *Intermediate–Advanced* · The classic practitioner write-up on why collection assignment destroys read latency, with `sstabledump` evidence. <https://thelastpickle.com/blog/2016/07/27/about-deletes-and-tombstones.html>
- **DataStax CQL Data Types and Collections Docs** — DataStax · *Beginner–Intermediate* · Clear worked examples of collection and UDT syntax, including driver-side mapping. <https://docs.datastax.com/en/cql-oss/3.3/cql/cql_reference/cql_data_types_c.html>
- **Python Driver — User Defined Types** — DataStax / Apache · *Intermediate* · How `register_user_type` works, schema agreement, and codec pitfalls when a UDT changes. <https://docs.datastax.com/en/developer/python-driver/3.29/api/cassandra/cqltypes/>
- **Vector Search in Cassandra 5.0** — Apache Cassandra Documentation · *Advanced* · The `vector<float,n>` type and the SAI ANN index that makes it useful. <https://cassandra.apache.org/doc/latest/cassandra/getting-started/vector-search-quickstart.html>
- **ScyllaDB University — CQL Types and Collections** — ScyllaDB · *Intermediate* · Free lessons covering the same type system from a compatible implementation, useful for contrasting storage decisions. <https://university.scylladb.com/courses/data-modeling/>

---

*Apache Cassandra Handbook — chapter 08.*
