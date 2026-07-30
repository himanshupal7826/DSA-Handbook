# 14 · The Log: Offsets, Segments & Retention

> **In one line:** A Kafka partition is nothing more exotic than an append-only file with monotonic positions, cut into segment files and reaped by a retention policy — and understanding the offset, the segment and the two cleanup policies (delete vs compact) explains almost everything about how Kafka stores, replays and forgets data.

---

## 1. Overview

Chapter 13 said a partition is "an ordered, immutable, append-only log". This chapter opens that abstraction and shows it is exactly as literal as it sounds: on a broker's disk a partition is a directory of files, records are appended to the end, each record gets the next integer position, and old records are deleted by a background policy — not by being consumed. Grasping this concrete model dissolves the two most common Kafka misconceptions in one stroke: that reading a message removes it (it does not), and that Kafka is a queue that drains (it is a log that ages out).

The **offset** is the spine. Every record appended to a partition gets a monotonically increasing 64-bit offset — 0, 1, 2, ... — that is its permanent address within that partition. The offset is not a global id and means nothing across partitions; it is simply "the Nth record in this partition". Two facts about the offset are load-bearing. First, it is assigned by the leader at append time and never changes. Second, and this is the part newcomers find strange, **the consumer tracks the offset, not the broker.** The broker does not remember that consumer group G has read up to offset 5000; group G remembers that, and stores it in an internal Kafka topic called `__consumer_offsets`. The broker just serves "give me records from offset 5000 onward". This is the storage-level expression of the dumb-broker philosophy.

Because the consumer owns its position and the broker keeps records around, **the log is replayable.** Reading does not consume. If you want to reprocess history after fixing a bug, you seek your offset backwards and read forward again; if you want a second, independent view of the data, you start a new consumer group at offset 0. The messages are still there because Kafka's retention is decoupled from consumption: a record is deleted when it ages out by **time** or **size**, or is superseded under **log compaction** — never because someone read it. This decoupling of retention from consumption is the single deepest difference between Kafka and a classic queue (chapter 2), and this chapter is where it becomes concrete: segment files, `retention.ms`, `retention.bytes`, `cleanup.policy=delete` versus `cleanup.policy=compact`, tombstones, and offset seeking.

## 2. Core Concepts

- **Log** — the append-only, ordered sequence of records that *is* a partition. Writes go to the end; reads are by position.
- **Offset** — a record's monotonically increasing 64-bit position within its partition. Permanent, per-partition, assigned at append time.
- **Log-end offset (LEO)** — the offset that will be assigned to the next record appended; i.e. one past the last record.
- **Committed offset (consumer)** — how far a consumer group has processed, stored in `__consumer_offsets`. Distinct from the record's own offset.
- **High watermark** — the highest offset that has been replicated to all in-sync replicas and is therefore visible to consumers (chapter 17).
- **Segment** — a file that holds a contiguous range of a partition's log. A partition is many segments; the newest is the **active segment**, the only one being written.
- **Index files** — each segment has an `.index` (offset → byte position) and `.timeindex` (timestamp → offset) so lookups and time-based seeks are fast.
- **Retention** — the policy for deleting old data: by time (`retention.ms`), by size (`retention.bytes`), or by compaction.
- **Log compaction** — a cleanup policy (`cleanup.policy=compact`) that keeps only the latest value per key, turning the log into a changelog/snapshot.
- **Tombstone** — a record with a non-null key and a null value; under compaction it marks the key for deletion.
- **Replay / seek** — moving a consumer's offset (to a value, to the beginning, to the end, or to a timestamp) to re-read or skip.

## 3. Theory & Principles

### The offset is a position, not a pointer the broker holds for you

Every record in a partition has an offset, and it is worth being precise about what that means, because two different "offsets" are constantly confused. There is the record's **own offset** — its fixed address in the partition, assigned once at append and never changing. And there is a consumer group's **committed offset** — a number the *group* stores saying "I have processed up to here". The record's offset is a property of the data; the committed offset is a property of a reader. The broker owns the first (it assigns and serves it); the consumer owns the second (it commits it to `__consumer_offsets`). When people say "Kafka lets you replay", they mean you can move your *committed* offset backwards to re-read records whose *own* offsets never moved.

This separation is what makes the log fundamentally different from a queue. In a queue, delivery and deletion are coupled: the broker hands you a message and, once acked, forgets it. In the log, the record's existence and your position are independent: the record sits at offset 5000 whether or not anyone has read it, and any number of groups can each have their own committed offset over the same records. So the same partition simultaneously supports a competing-consumer group (one committed offset advancing) and a dozen analytics readers (each its own committed offset, some replaying from 0) — the broker does not care, because it only ever serves byte ranges by offset.

### Segments: why a partition is many files

A partition is not one giant file; it is a series of **segment files**, each covering a contiguous offset range, named by their base offset (`00000000000000000000.log`, `00000000000000150000.log`, ...). Only the last, the **active segment**, is open for appends. When the active segment reaches `segment.bytes` (default 1 GB) or `segment.ms` in age, Kafka **rolls** it: closes it and opens a new active segment. This segmentation is not incidental — it is what makes retention cheap and safe. To delete old data, Kafka deletes whole closed segments whose newest record is older than the retention bound; it never rewrites the active segment or edits records in place. Deleting a file is O(1) and cannot corrupt live writes. Each segment also carries an `.index` (sparse offset-to-byte-position map) and a `.timeindex` (timestamp-to-offset map) so a consumer asking "give me offset 150123" or "give me records after 3pm" can binary-search to the right byte without scanning.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">A partition = ordered offsets, cut into segment files, reaped by retention</text>

  <rect x="24" y="40" width="832" height="150" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="440" y="60" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">The append-only log: monotonic offsets, never mutated</text>
  <g font-size="9">
    <rect x="60" y="78" width="40" height="30" fill="#ddd6fe" stroke="#7c3aed"/><text x="80" y="98" text-anchor="middle" fill="#5b21b6">0</text>
    <rect x="100" y="78" width="40" height="30" fill="#ddd6fe" stroke="#7c3aed"/><text x="120" y="98" text-anchor="middle" fill="#5b21b6">1</text>
    <rect x="140" y="78" width="40" height="30" fill="#ddd6fe" stroke="#7c3aed"/><text x="160" y="98" text-anchor="middle" fill="#5b21b6">2</text>
    <rect x="180" y="78" width="40" height="30" fill="#ddd6fe" stroke="#7c3aed"/><text x="200" y="98" text-anchor="middle" fill="#5b21b6">3</text>
    <rect x="220" y="78" width="40" height="30" fill="#ddd6fe" stroke="#7c3aed"/><text x="240" y="98" text-anchor="middle" fill="#5b21b6">4</text>
    <rect x="260" y="78" width="40" height="30" fill="#ddd6fe" stroke="#7c3aed"/><text x="280" y="98" text-anchor="middle" fill="#5b21b6">5</text>
    <rect x="300" y="78" width="40" height="30" fill="#ddd6fe" stroke="#7c3aed"/><text x="320" y="98" text-anchor="middle" fill="#5b21b6">6</text>
    <rect x="340" y="78" width="40" height="30" fill="#ddd6fe" stroke="#7c3aed"/><text x="360" y="98" text-anchor="middle" fill="#5b21b6">7</text>
    <rect x="380" y="78" width="60" height="30" fill="#f5f3ff" stroke="#c4b5fd" stroke-dasharray="3 2"/><text x="410" y="98" text-anchor="middle" fill="#7c3aed">append &#8594;</text>
  </g>
  <text x="80" y="132" fill="#6d28d9" font-size="9">consumer group A committed offset = 3 &#8593;</text>
  <text x="360" y="132" fill="#6d28d9" font-size="9">group B committed = 7 &#8593;</text>
  <text x="60" y="158" fill="#5b21b6" font-size="10" font-weight="bold">the record's own offset never changes; each GROUP tracks its OWN committed offset</text>
  <text x="60" y="178" fill="#6d28d9" font-size="10">reading does NOT delete &#8594; group A can seek back to 0 and replay (chapter 2)</text>

  <rect x="24" y="204" width="500" height="150" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="274" y="224" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">Segments: old ones deleted whole, active one written</text>
  <rect x="44" y="238" width="120" height="40" rx="4" fill="#fee2e2" stroke="#dc2626"/><text x="104" y="256" text-anchor="middle" fill="#b91c1c" font-size="8">seg base 0</text><text x="104" y="270" text-anchor="middle" fill="#b91c1c" font-size="8">aged out &#8594; DELETE</text>
  <rect x="172" y="238" width="120" height="40" rx="4" fill="#fff" stroke="#2563eb"/><text x="232" y="256" text-anchor="middle" fill="#1e40af" font-size="8">seg base 150000</text><text x="232" y="270" text-anchor="middle" fill="#1d4ed8" font-size="8">closed, immutable</text>
  <rect x="300" y="238" width="120" height="40" rx="4" fill="#dcfce7" stroke="#16a34a"/><text x="360" y="256" text-anchor="middle" fill="#15803d" font-size="8">seg base 300000</text><text x="360" y="270" text-anchor="middle" fill="#15803d" font-size="8">ACTIVE (appends)</text>
  <text x="44" y="300" fill="#1d4ed8" font-size="9">each segment: .log + .index (offset&#8594;byte) + .timeindex (ts&#8594;offset)</text>
  <text x="44" y="318" fill="#1d4ed8" font-size="9">roll when segment.bytes (~1GB) or segment.ms reached</text>
  <text x="44" y="338" fill="#1e40af" font-size="9" font-weight="bold">retention deletes whole CLOSED segments &#8594; O(1), safe</text>

  <rect x="536" y="204" width="320" height="150" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="696" y="224" text-anchor="middle" fill="#92400e" font-size="12" font-weight="bold">Retention is by AGE/SIZE, not by read</text>
  <text x="552" y="248" fill="#b45309" font-size="10">retention.ms &#8594; delete records older than T</text>
  <text x="552" y="268" fill="#b45309" font-size="10">retention.bytes &#8594; cap the partition size</text>
  <text x="552" y="292" fill="#92400e" font-size="10" font-weight="bold">deletion is INDEPENDENT of consumption</text>
  <text x="552" y="312" fill="#b45309" font-size="10">an unread record ages out; a read record stays</text>
  <text x="552" y="336" fill="#b45309" font-size="10">until it ages out. Reading &#8800; deleting.</text>

  <rect x="24" y="368" width="832" height="86" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="440" y="388" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Log compaction: keep the LATEST value per key</text>
  <text x="40" y="410" fill="#166534" font-size="10">cleanup.policy=compact &#8594; for key k, keep only the newest record; older values for k are collected.</text>
  <text x="40" y="430" fill="#166534" font-size="10">a null-value record (TOMBSTONE) for key k marks k for deletion. Use for changelog/state topics (chapter 13, 18).</text>
  <text x="40" y="448" fill="#15803d" font-size="10" font-weight="bold">result: the log becomes a compact snapshot &#8212; the latest state of every key &#8212; that is still replayable.</text>
</svg>
```

### Two ways to forget: retention and compaction

Kafka has exactly two `cleanup.policy` values, and they answer different questions. `delete` (the default) answers "how long do we keep the *stream*?" — records are removed once they exceed `retention.ms` in age or the partition exceeds `retention.bytes`, oldest segments first. This suits event streams where old events lose value: keep seven days of clickstream, then forget. `compact` answers "what is the *latest state* of each key?" — Kafka keeps the most recent record for every key and garbage-collects superseded ones, so the log converges to a snapshot: one value per key, the newest. This suits changelog and state topics — a topic where the key is an entity id and the value is its current state, such as a user-profile topic or a Kafka Streams state store's backing topic (chapter 18). You can even combine them (`compact,delete`) to compact *and* bound age. The two policies are the storage foundation for two different uses of Kafka: as a stream of events (delete) and as a store of current state (compact).

## 4. Architecture & Workflow

### The life of an offset

1. **Append.** A producer's record arrives at the partition leader. The leader appends it to the active segment and assigns it the next offset (the current LEO), then increments the LEO.
2. **Replicate and commit.** Followers fetch the record; once it is on all in-sync replicas, the **high watermark** advances to include it, and only then is it visible to consumers (chapter 17). So a consumer can only read up to the high watermark, never the raw LEO.
3. **Fetch.** A consumer sends a fetch for "records from offset X". The broker uses the `.index` to find the byte position of X in the right segment and streams records forward, up to the high watermark.
4. **Commit.** After processing, the consumer group commits its new position to `__consumer_offsets` (auto or manual — chapter 16). This committed offset is what a restart resumes from; it is entirely separate from the records' own offsets.
5. **Roll and retain.** As appends accumulate, the active segment rolls into a new one. A background thread deletes closed segments past the retention bound (policy `delete`) or compacts the log to the latest value per key (policy `compact`).
6. **Replay.** At any time a consumer can seek: to a specific offset, to the earliest available offset, to the latest, or to the offset corresponding to a timestamp (via `.timeindex`). Because the records were retained, replay just re-reads them.

### Where the deletion boundary and the consumer meet

There is one sharp edge worth naming: retention and consumption are decoupled, which is powerful but not free. If a consumer group is slower than the retention window — it is committed at offset 1,000,000 while retention has already deleted everything below offset 1,050,000 — then the records between are *gone before they were read*. On the next fetch the broker cannot serve offset 1,000,000 (it no longer exists) and the consumer hits an "offset out of range" condition, resolved by `auto.offset.reset` (jump to `earliest` or `latest`), silently skipping the lost records. This is the log's version of "the buffer overflowed": not backpressure, but data expiry. It means retention must be sized to comfortably exceed your worst-case consumer downtime plus catch-up time, or you will lose data you intended to process. The high watermark, the committed offset and the retention boundary are three positions on the same axis, and healthy operation keeps the committed offset safely between the retention boundary and the high watermark.

```svg
<svg viewBox="0 0 880 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Four positions on one offset axis &#8212; keep the committed offset safely between</text>

  <line x1="60" y1="150" x2="820" y2="150" stroke="#64748b" stroke-width="3"/>
  <text x="825" y="154" fill="#64748b" font-size="10">offset &#8594;</text>

  <rect x="60" y="138" width="150" height="24" fill="#fecaca" stroke="#dc2626"/>
  <text x="135" y="154" text-anchor="middle" fill="#b91c1c" font-size="9">DELETED (aged out)</text>
  <rect x="210" y="138" width="440" height="24" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="430" y="154" text-anchor="middle" fill="#5b21b6" font-size="9">retained &amp; readable records</text>
  <rect x="650" y="138" width="120" height="24" fill="#fef3c7" stroke="#d97706"/>
  <text x="710" y="154" text-anchor="middle" fill="#92400e" font-size="9">not yet replicated</text>

  <line x1="210" y1="110" x2="210" y2="190" stroke="#dc2626" stroke-width="2"/>
  <text x="210" y="104" text-anchor="middle" fill="#b91c1c" font-size="9" font-weight="bold">LogStartOffset</text>
  <text x="210" y="208" text-anchor="middle" fill="#b91c1c" font-size="8">retention boundary</text>

  <line x1="430" y1="110" x2="430" y2="190" stroke="#2563eb" stroke-width="2"/>
  <text x="430" y="104" text-anchor="middle" fill="#1e40af" font-size="9" font-weight="bold">committed offset (group)</text>
  <text x="430" y="208" text-anchor="middle" fill="#1e40af" font-size="8">where a restart resumes</text>

  <line x1="650" y1="110" x2="650" y2="190" stroke="#16a34a" stroke-width="2"/>
  <text x="650" y="104" text-anchor="middle" fill="#15803d" font-size="9" font-weight="bold">high watermark</text>
  <text x="650" y="208" text-anchor="middle" fill="#15803d" font-size="8">last visible to consumers</text>

  <line x1="770" y1="120" x2="770" y2="180" stroke="#94a3b8" stroke-width="2" stroke-dasharray="4 3"/>
  <text x="770" y="114" text-anchor="middle" fill="#475569" font-size="9" font-weight="bold">LEO</text>
  <text x="770" y="196" text-anchor="middle" fill="#475569" font-size="8">next append</text>

  <path d="M430,236 L650,236" stroke="#16a34a" stroke-width="2"/>
  <text x="540" y="230" text-anchor="middle" fill="#15803d" font-size="10">lag = high watermark &#8722; committed offset</text>

  <rect x="60" y="256" width="760" height="104" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="278" text-anchor="middle" fill="#334155" font-size="11" font-weight="bold">Healthy: LogStartOffset &lt; committed offset &#8804; high watermark</text>
  <text x="76" y="302" fill="#b91c1c" font-size="10" font-weight="bold">DANGER:</text>
  <text x="150" y="302" fill="#991b1b" font-size="10">if retention overtakes a slow consumer, the committed offset falls BELOW LogStartOffset &#8594;</text>
  <text x="76" y="322" fill="#991b1b" font-size="10">"offset out of range" &#8594; auto.offset.reset skips to earliest/latest &#8594; those records are lost for that group.</text>
  <text x="76" y="346" fill="#334155" font-size="10" font-weight="bold">Fix: size retention &gt; worst-case downtime + catch-up time; alert on lag approaching the retention window.</text>
</svg>
```

## 5. Implementation

Configuring retention and compaction is done per topic with `kafka-configs.sh` (or at create time). These are the levers that decide whether a topic is a stream or a state store.

```bash
# --- Retention by TIME: keep 7 days, then delete oldest segments ---
kafka-configs.sh --bootstrap-server broker1:9092 --alter \
  --entity-type topics --entity-name clickstream \
  --add-config retention.ms=604800000        # 7 days in milliseconds

# --- Retention by SIZE: cap each partition at 50 GiB (whichever hits first) ---
kafka-configs.sh --bootstrap-server broker1:9092 --alter \
  --entity-type topics --entity-name clickstream \
  --add-config retention.bytes=53687091200

# --- Control segment rolling (retention granularity) ---
# Smaller segments = finer retention but more files. Default segment.bytes is ~1 GiB.
kafka-configs.sh --bootstrap-server broker1:9092 --alter \
  --entity-type topics --entity-name clickstream \
  --add-config segment.ms=3600000            # roll the active segment hourly

# --- Turn a topic into a COMPACTED changelog: keep the latest value per key ---
kafka-configs.sh --bootstrap-server broker1:9092 --alter \
  --entity-type topics --entity-name user-profiles \
  --add-config cleanup.policy=compact
# Tuning knobs for how aggressively compaction runs:
#   min.cleanable.dirty.ratio (default 0.5) — compact when half the log is "dirty"
#   delete.retention.ms — how long tombstones survive so consumers can observe deletes

# Inspect what a topic currently has configured:
kafka-configs.sh --bootstrap-server broker1:9092 --describe \
  --entity-type topics --entity-name user-profiles
```

Now the replay side in Go with `segmentio/kafka-go`: seeking an offset to reprocess history, and writing a tombstone to delete a key from a compacted topic.

```go
package main

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/segmentio/kafka-go"
)

// replayFromBeginning reads a partition from offset 0 regardless of any prior
// committed position. Because the records were RETAINED (not deleted on read),
// they are all still there to reprocess — the recovery move a queue cannot do.
func replayFromBeginning(ctx context.Context) {
	r := kafka.NewReader(kafka.ReaderConfig{
		Brokers:   []string{"broker1:9092"},
		Topic:     "clickstream",
		Partition: 0,
		// Note: no GroupID here — a partition reader lets us control the offset
		// directly, rather than resuming from a committed group offset.
	})
	defer r.Close()

	// Seek explicitly to the FIRST available offset. FirstOffset re-reads all
	// history still within retention; LastOffset would skip to the tail.
	if err := r.SetOffset(kafka.FirstOffset); err != nil {
		log.Fatalf("seek: %v", err)
	}
	for {
		m, err := r.ReadMessage(ctx)
		if err != nil {
			return
		}
		fmt.Printf("replay offset=%d key=%s\n", m.Offset, string(m.Key))
	}
}

// seekToTimestamp uses the .timeindex to resume from a point in time — e.g.
// "reprocess everything since 09:00" — without knowing the offset.
func seekToTimestamp(ctx context.Context, since time.Time) {
	r := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"broker1:9092"}, Topic: "clickstream", Partition: 0,
	})
	defer r.Close()
	// SetOffsetAt maps a timestamp to the first offset at/after it (timeindex lookup).
	if err := r.SetOffsetAt(ctx, since); err != nil {
		log.Fatalf("seek-time: %v", err)
	}
	m, _ := r.ReadMessage(ctx)
	fmt.Printf("first record since %s is at offset=%d\n", since, m.Offset)
}

// deleteKeyViaTombstone writes a null-VALUE record for a key to a COMPACTED
// topic. Under cleanup.policy=compact this tombstone tells Kafka to drop the
// key; consumers that see it should remove the entity from their local state.
func deleteKeyViaTombstone(ctx context.Context, key string) {
	w := &kafka.Writer{
		Addr:  kafka.TCP("broker1:9092"),
		Topic: "user-profiles", // a compacted topic
	}
	defer w.Close()
	err := w.WriteMessages(ctx, kafka.Message{
		Key:   []byte(key),
		Value: nil, // NIL value == tombstone == "delete this key"
	})
	if err != nil {
		log.Fatalf("tombstone: %v", err)
	}
	fmt.Printf("wrote tombstone for key %s\n", key)
}

func main() {
	ctx := context.Background()
	replayFromBeginning(ctx)
	seekToTimestamp(ctx, time.Now().Add(-2*time.Hour))
	deleteKeyViaTombstone(ctx, "user-42")
}
```

The three operations capture the log's storage model in code: `SetOffset(FirstOffset)` is replay made possible by retention; `SetOffsetAt` is the `.timeindex` in action; and the null-value write is the tombstone that, under compaction, is how you delete a key. None of these are possible in a delete-on-consume queue — they all rely on the log retaining records independently of who has read them.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Replayability.** Records persist independently of consumption, so you can reprocess after a bug, bootstrap a new consumer from history, or run many independent readers.
- **Cheap, safe retention.** Deleting whole closed segments is O(1) and never touches live writes; time and size bounds are simple to reason about.
- **Fast lookups and time-travel.** The `.index` and `.timeindex` make seeking by offset or timestamp fast without scanning.
- **State via compaction.** A compacted topic is a durable, replayable snapshot of the latest value per key — a changelog and a table at once.
- **Sequential-I/O throughput.** Appending to the active segment is sequential disk I/O, which is fast and page-cache-friendly.

**Disadvantages**
- **Retention must exceed downtime.** A consumer slower than the retention window loses data that expired before it read it — the log is not infinite storage.
- **Compaction is eventual, not immediate.** A superseded value or a tombstone lingers until a compaction pass runs; you cannot rely on instant per-key deduplication.
- **Storage cost.** Retaining days of data costs disk, multiplied by the replication factor.
- **Offset semantics to manage.** The committed-offset-versus-record-offset distinction and `auto.offset.reset` behaviour are subtle and easy to get wrong.

**Trade-offs**
- *Retention length vs storage cost:* longer retention buys more replay and downtime tolerance but costs disk × replication factor; size it to worst-case consumer downtime plus catch-up.
- *delete vs compact:* `delete` treats the topic as an ageing event stream; `compact` treats it as a keyed state store; `compact,delete` bounds both. Choose by what the topic *is*.
- *Segment size vs file count:* smaller segments give finer retention granularity but more open files and more frequent rolls.
- *Immediate visibility vs durability:* consumers read only up to the high watermark, not the raw log end, trading a little latency for the guarantee that visible records are replicated.

## 7. Common Mistakes & Best Practices

- **Thinking reading deletes the message.** It does not; retention is by age/size/compaction, independent of consumption. This misconception leads to designs that assume a drained queue.
- **Retention shorter than consumer downtime.** If retention is 6 hours and a consumer is down for 8, the missing records expire and are skipped via `auto.offset.reset`. Size retention to exceed worst-case downtime plus catch-up.
- **Using compaction on a topic that needs every event.** Compaction keeps only the latest value per key and discards intermediate ones; if you need the full history of changes, use `delete`, not `compact`.
- **Expecting compaction to be instant.** Superseded values and tombstones persist until a cleaner pass runs and `delete.retention.ms` elapses; do not rely on immediate per-key uniqueness.
- **No key on a compacted topic.** Compaction is per key; null-key records on a compacted topic are not compacted meaningfully. Always key compacted topics.
- **Confusing the committed offset with the record offset.** Resetting a group's committed offset re-reads records whose own offsets never changed; treating them as the same thing produces off-by-history bugs.
- **Best practice: choose the cleanup policy from the topic's identity and size retention from downtime.** Decide first whether the topic is a stream (delete) or a state store (compact), then set `retention.ms`/`retention.bytes` to comfortably exceed your worst realistic consumer outage.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** Use `kafka-run-class.sh kafka.tools.DumpLogSegments` to inspect a segment's records and offsets when you suspect corruption or want to see exactly what is stored. For "my consumer skipped data", check whether the committed offset fell below the log's earliest available offset (`kafka-get-offsets.sh` / `--offsets`) — that means retention overtook the consumer. For "deletes aren't taking effect on a compacted topic", check `min.cleanable.dirty.ratio` and whether the cleaner thread is running.
- **Monitoring.** Track per-partition `LogStartOffset` and `LogEndOffset` (their gap is how much history is retained), disk usage per broker (retention is ultimately bounded by disk), the log-cleaner's activity and backlog on compacted topics, and consumer lag relative to the retention boundary. A partition whose oldest data is close to the retention age while a consumer is lagging is a data-loss risk (chapter 27).
- **Security.** Retention length is also a data-governance decision: personal data in a topic is retained for `retention.ms`, so retention must satisfy deletion and minimisation requirements. Compacted topics need tombstones (and `delete.retention.ms`) to actually erase a key's data. Encryption at rest protects the segment files on disk; ACLs restrict who can read the retained history (chapter 29).
- **Scaling.** Storage scales with retention × throughput × replication factor; plan disk accordingly and consider tiered storage (offloading old segments to object storage) for long-retention topics. Compaction has a CPU and I/O cost that scales with the log's "dirty" fraction; heavily-updated compacted topics need enough cleaner threads. Segment size affects file counts and open handles at scale.

## 9. Interview Questions

**Q: What is an offset, and who tracks it?**
A: An offset is a record's monotonically increasing 64-bit position within its partition, assigned by the leader at append time and never changed; it is meaningful only within that one partition. There are really two offsets to keep distinct: the record's own offset, which is a fixed property of the data that the broker assigns and serves, and a consumer group's committed offset, which says how far that group has processed and is stored by the group in the internal `__consumer_offsets` topic. The broker does not track where each consumer is; the consumer does. That separation — the broker owning record offsets and the consumer owning its committed offset — is what makes replay and multiple independent readers possible.

**Q: Does reading a message delete it in Kafka?**
A: No. This is the biggest conceptual difference from a queue. Reading is non-destructive: a record stays in the log after being read, and any number of consumer groups can read the same record, each at its own pace. Records are removed only by the retention policy — by age (`retention.ms`), by size (`retention.bytes`), or by being superseded under compaction — never because someone consumed them. This is why the log is replayable: to reprocess, you move your committed offset backwards and read the same retained records again.

**Q: What is a segment and why is the log segmented?**
A: A partition's log is stored as a series of segment files, each covering a contiguous range of offsets and named by its base offset; only the last, the active segment, is open for appends, and it rolls into a new one when it reaches `segment.bytes` or `segment.ms`. Segmentation makes retention cheap and safe: to delete old data Kafka deletes whole closed segments whose newest record is past the retention bound, which is an O(1) file delete that never rewrites records or touches the active segment. Each segment also has `.index` and `.timeindex` files so lookups by offset or timestamp are fast.

**Q: What is the difference between retention by time and log compaction?**
A: Retention by time (or size) treats the topic as an ageing stream: records older than `retention.ms`, or beyond `retention.bytes`, are deleted oldest-first, regardless of key or consumption. Log compaction (`cleanup.policy=compact`) treats the topic as a keyed state store: it keeps the latest record for each key and garbage-collects superseded ones, so the log converges to one value per key — a snapshot of current state. Time retention answers "how long do we keep the stream?"; compaction answers "what is the latest value of each key?". They can be combined with `compact,delete` to keep the latest per key but also bound age.

**Q: What is a tombstone?**
A: A tombstone is a record with a non-null key and a null value, published to a compacted topic to mark that key for deletion. During compaction Kafka removes all previous values for the key and, after `delete.retention.ms`, the tombstone itself, so the key disappears from the compacted log. Consumers that materialise the topic into local state should interpret a null value as "remove this entity". Tombstones are how you delete a key from a changelog/state topic, since compaction otherwise only ever keeps the latest value.

**Q: How do you replay messages in Kafka?**
A: By seeking a consumer's offset. Because records are retained independently of consumption, you move the committed offset (or a partition reader's offset) to where you want to start — the earliest available offset to reprocess all retained history, a specific offset, or the offset corresponding to a timestamp via the `.timeindex` — and read forward again. The records are still there, so replay is just re-reading. Practically you might reset a consumer group's offsets with `kafka-consumer-groups.sh --reset-offsets` after fixing a bug, or start a fresh group at the beginning to build a new view of the data.

**Q: What happens if a consumer is slower than the retention window?**
A: The records it has not yet read can be deleted by retention before it reads them, because retention is decoupled from consumption. When the consumer next fetches its committed offset, that offset is below the log's earliest available offset, producing an "offset out of range" condition; `auto.offset.reset` then jumps the consumer to `earliest` or `latest`, silently skipping the expired records. This is effectively data loss for that consumer, and it is why retention must be sized to exceed your worst realistic consumer downtime plus the time to catch up.

**Q: (Senior) How do you decide the retention setting for a topic?**
A: I start from what the topic *is* and who reads it. First the cleanup policy: if the topic is a stream of events whose old entries lose value, `delete`; if it is a keyed state store where I only care about the latest value per key, `compact`; if I need the latest state but also a bounded age, `compact,delete`. Then, for a delete topic, the retention length is driven by three things: the worst-case downtime of the slowest consumer plus its catch-up time (retention must comfortably exceed this or that consumer loses data), any replay or reprocessing window the business needs (for example "we must be able to reprocess the last 7 days after a bug"), and any data-governance constraint (personal data cannot be retained longer than policy allows). I then reconcile that with cost, because storage is retention × throughput × replication factor, and consider tiered storage if the required window is long. For a compacted topic, retention is conceptually infinite for live keys, so instead I tune the cleaner (`min.cleanable.dirty.ratio`) and `delete.retention.ms` so tombstones survive long enough for every consumer to observe deletions. The output is a per-topic decision justified by downtime tolerance, replay needs, governance and cost — never a copied default.

**Q: (Senior) Explain how a compacted topic can act as both a log and a table, and where that is used.**
A: A compacted topic has a dual nature that is the foundation of stream-table duality. Read sequentially from the beginning, it is a *log*: an ordered history of changes to keys, a changelog. But because compaction keeps only the latest record per key, if you materialise it — apply each record to a map keyed by the record's key — the result converges to a *table*: the current value of every key. So the same topic is a stream of updates and, when folded, a snapshot of state. This is exactly how Kafka Streams backs its state stores: a KTable's local store is checkpointed to a compacted changelog topic, so on failure the store can be rebuilt by replaying the compacted log, which contains the latest value of every key and nothing redundant (chapter 18). It is also how change-data-capture pipelines represent a database table as a topic: each row's primary key is the record key, each update is a new record, deletes are tombstones, and a fresh consumer can reconstruct the whole table by replaying the compacted log. The power is that you get a durable, replayable current-state store for free from the same primitive that stores the stream — one topic serves both the "what changed" and the "what is it now" questions, and a new reader can bootstrap full state from history rather than needing a separate snapshot mechanism. The caveat is that compaction discards intermediate values, so if you also need the full history of every change (not just the latest per key) you keep a separate delete-retention topic alongside.

**Q: (Senior) A team reports that deletes on a compacted topic "don't work" — keys they tombstoned still appear. What is going on?**
A: Several things could be true, and I would check them in order. First, compaction is eventual, not immediate: a tombstone does not erase the key on write; it marks it, and the key's old values and the tombstone are only removed when the log cleaner runs a compaction pass over the segment containing them. Compaction is triggered by the `min.cleanable.dirty.ratio` (by default the log must be about half "dirty" before a pass runs) and only ever compacts *closed* segments — the active segment is never compacted — so recently written keys in the active segment will still show all their values until it rolls. Second, they may be reading with a consumer that started before the tombstone and is replaying old offsets, so it legitimately sees the pre-delete values in history; compaction changes what a *new* full read returns, not what an in-progress replay already passed. Third, `delete.retention.ms` governs how long the tombstone itself is retained so that all consumers get a chance to observe the delete; if that window has passed, a very late consumer might never see the tombstone and thus never learn to remove the key from its state. Fourth, the topic might not actually have `cleanup.policy=compact` set, or the cleaner threads might be under-provisioned or erroring, leaving a large compaction backlog. The resolution is to explain that compaction guarantees *eventual* convergence to the latest value per key, not instant deletion, verify the policy and cleaner health, and if they need prompter deletion, tune the dirty ratio and segment size so segments roll and get cleaned sooner — while making sure `delete.retention.ms` is long enough that every consumer observes the tombstone before it is collected.

## 10. Quick Revision & Cheat Sheet

| Concept | One-liner |
|---|---|
| Offset | Record's fixed per-partition position (broker assigns) |
| Committed offset | How far a group has processed (in `__consumer_offsets`) |
| High watermark | Highest replicated offset visible to consumers |
| Segment | A file of contiguous offsets; active one is written, rest immutable |
| retention.ms / .bytes | Delete records by age / partition size |
| cleanup.policy=compact | Keep latest value per key (changelog/state) |
| Tombstone | Null-value record → delete a key under compaction |
| Replay | Seek offset backwards; records were retained, not deleted |

| Policy | Topic is a... | Keeps |
|---|---|---|
| `delete` | Event stream | Everything within time/size window |
| `compact` | Keyed state store | Latest value per key |
| `compact,delete` | Bounded state store | Latest per key, within age bound |

**Flash cards**
- **Does reading delete?** → No; retention is by age/size/compaction, not consumption.
- **Who tracks the read position?** → The consumer group, in `__consumer_offsets`.
- **Why segments?** → Delete whole closed files (O(1)) without touching live writes.
- **delete vs compact?** → Age out the stream vs keep the latest value per key.
- **How to delete a key from a compacted topic?** → Write a tombstone (null value).
- **Retention shorter than downtime?** → Expired records are skipped — data loss for that consumer.

## 11. Hands-On Exercises & Mini Project

- [ ] Produce 100 records to a partition, then use `DumpLogSegments` to view the offsets and confirm the active segment is the one being appended.
- [ ] Set `retention.ms` very low on a test topic and watch old segments get deleted while unread, proving retention is independent of consumption.
- [ ] Consume a topic, then reset the group's offsets to earliest and replay, confirming the same records come back.
- [ ] Create a compacted topic, write several values for the same key, force a compaction, and confirm only the latest survives.
- [ ] Write a tombstone for a key on the compacted topic and confirm the key disappears after cleaning and `delete.retention.ms`.
- [ ] Seek a consumer to a timestamp with `SetOffsetAt` and confirm it starts at the right offset via the `.timeindex`.

### Mini Project — "Changelog State Store"

**Goal.** Build a compacted topic that acts as a durable, replayable current-state table, and prove it survives a consumer restart by rebuilding state from the log.

**Requirements.**
1. Create a `user-profiles` topic with `cleanup.policy=compact`, keyed by user id.
2. Produce multiple updates per user and confirm, after compaction, that only the latest value per key remains by reading the whole topic into a map.
3. Restart a fresh consumer at offset 0 and rebuild the in-memory table purely from the compacted log, showing it matches the live state.
4. Delete a user with a tombstone and confirm the rebuilt table no longer contains that user.
5. Measure the compacted topic's size versus an equivalent `delete` topic that kept every update, and report the storage difference.

**Extensions.**
- Add `compact,delete` with a bounded age and observe keys not updated within the window being removed even without a tombstone.
- Simulate a slow consumer against a short-retention `delete` topic and demonstrate the "offset out of range" skip, then fix it by lengthening retention.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Kafka Architecture: Brokers, Topics & Partitions* (the partition this log lives in), *Messaging Models: Queues vs Pub/Sub vs the Log* (why retention makes the log replayable), *Producers: Partitioning, Batching & acks* (how records get appended), *Design: Consumers, Groups, Offsets & Rebalancing* (committed offsets and resets), *Kafka Streams & Stream-Table Duality* (compacted changelogs as state stores).

- **Apache Kafka — Design: Log & Log Compaction** — Apache · *Intermediate* · the authoritative description of the on-disk log, segments, retention and compaction. <https://kafka.apache.org/documentation/#design_log>
- **Apache Kafka — Log Compaction** — Apache · *Intermediate* · exactly how compaction keeps the latest value per key and how tombstones delete keys. <https://kafka.apache.org/documentation/#compaction>
- **The Log: What every software engineer should know** — Jay Kreps · *Advanced* · why the append-only log with positions is the fundamental abstraction. <https://engineering.linkedin.com/distributed-systems/log-what-every-software-engineer-should-know-about-real-time-datas-unifying>
- **Designing Data-Intensive Applications, ch. 3 & 11** — Martin Kleppmann · *Advanced* · log-structured storage and change-data-capture / stream-table duality. <https://dataintensive.net/>
- **Confluent — Kafka storage internals & tiered storage** — Confluent · *Intermediate* · segments, retention, and offloading old segments to object storage at scale. <https://docs.confluent.io/platform/current/kafka/design.html>
- **Debezium — Change Data Capture** — Debezium · *Intermediate* · compacted topics representing database tables, with keys, updates and tombstones. <https://debezium.io/documentation/>
- **kafka-consumer-groups.sh — resetting offsets** — Apache · *Beginner* · the CLI for replaying by moving committed offsets. <https://kafka.apache.org/documentation/#basic_ops_consumer_group>
- **kafka-go — segmentio** — Segment · *Intermediate* · the Go client used here for seeking offsets and writing tombstones. <https://github.com/segmentio/kafka-go>

---

*Kafka & RabbitMQ Handbook — chapter 14.*
