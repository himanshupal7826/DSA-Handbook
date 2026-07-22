# 24 · Tombstones & Deletes

> **In one line:** In Cassandra a delete is a write — a tombstone marker with a timestamp that must outlive `gc_grace_seconds` and survive repair before compaction may purge it, which is why deletes consume disk, slow reads, and, done wrong, take a cluster down.

---

## 1. Overview

In a mutable, single-master database a `DELETE` removes a row and the space is reclaimed. In Cassandra, none of that is possible. SSTables are immutable (Chapter 21), so nothing can be removed in place. Replicas are eventually consistent, so a node that was down during the delete has no idea the row is gone. And reads merge fragments from many SSTables, so if a delete were simply an absence, an older SSTable holding the original row would silently resurrect it. The only correct design is to **write a marker that says "this data is deleted as of timestamp T"** and let the normal last-write-wins merge do the rest. That marker is a **tombstone**.

The problem tombstones solve is *distributed deletion without coordination*. A tombstone is just another cell with a timestamp; it propagates by the same replication, hints, and repair machinery as any write, and it wins the merge against anything older. No consensus round, no two-phase commit, no coordination — deletion becomes an ordinary write, which is exactly what makes it fast and available.

The price is threefold. **Space**: a delete increases disk usage until compaction reclaims it. **Read cost**: the merge must walk every tombstone shadowing a partition, so a partition with 50,000 tombstones costs 50,000 comparisons even to return zero rows. **Time**: a tombstone cannot be purged until `gc_grace_seconds` (864000 seconds, 10 days) has elapsed *and* no overlapping SSTable holds older data for that key — and if you drop it before every replica learned about the delete, the original data comes back. That resurrection is called **zombie data**, and it is the single most feared correctness bug in Cassandra operations.

Cassandra 3.0's storage-engine rewrite made range tombstones far more efficient and introduced proper row-level deletion markers. Cassandra 4.0 added better tombstone metrics and the `nodetool garbagecollect` command. But the fundamentals have not changed since 0.7, and neither has the most common production incident: a queue-like table where consumers delete processed rows, tombstones accumulate at the head of the partition, and reads that used to take 2 ms start taking 8 seconds and then start failing with `TombstoneOverwhelmingException`.

Concretely: teams routinely model a work queue as `PRIMARY KEY ((shard), enqueued_at)`, read the oldest N rows, process, then delete them. Every consumer pass leaves tombstones at the front of the partition. `SELECT … LIMIT 10` must scan past every tombstone before finding 10 live rows — so after a million processed messages, a query for 10 rows scans a million tombstones, trips `tombstone_failure_threshold: 100000`, and throws. The table is not too big; it is too *deleted*. The fix is never a tuning knob; it is a data model that does not delete.

## 2. Core Concepts

- **Tombstone** — a marker recording that data was deleted at a given write timestamp and local deletion time; it is written, replicated, and merged exactly like ordinary data.
- **Cell tombstone** — deletes a single column value (`UPDATE t SET col = null` or `DELETE col FROM t`).
- **Row tombstone** — deletes one entire row identified by full primary key (`DELETE FROM t WHERE pk=… AND ck=…`).
- **Range tombstone** — deletes a contiguous clustering-key slice in one marker (`DELETE … WHERE pk=… AND ck > x AND ck < y`); one marker instead of thousands.
- **Partition tombstone** — deletes an entire partition (`DELETE FROM t WHERE pk=…`); the cheapest delete by far.
- **TTL expiry** — an expiring cell becomes a tombstone automatically at `localDeletionTime`; no client action needed.
- **`gc_grace_seconds`** — 864000 (10 days) by default; the minimum age before compaction may purge a tombstone, sized to let repair propagate the delete everywhere.
- **Zombie data** — deleted data that reappears because a tombstone was purged before a replica that missed the delete was repaired.
- **`localDeletionTime`** — the server-side wall-clock second at which the deletion was recorded, used for `gc_grace_seconds` arithmetic (distinct from the microsecond write timestamp used for merge ordering).
- **Droppable tombstone ratio** — the fraction of an SSTable estimated to be purgeable tombstones; drives `tombstone_threshold` single-SSTable compaction.
- **`tombstone_warn_threshold` / `tombstone_failure_threshold`** — 1000 / 100000 tombstones scanned in one read, producing a log warning or aborting the query.

## 3. Theory & Internals

### Why deletion cannot be a deletion

Consider RF=3, node C down, and `DELETE FROM users WHERE id='u1'` at `LOCAL_QUORUM`. A and B apply it; C never hears about it. Now:

- If the delete were an *absence*, a later read at `QUORUM` hitting A and C would merge "nothing" from A with "u1 exists" from C and return the row. The delete is lost.
- With a tombstone, A returns `tombstone(t=100)` and C returns `row(t=50)`. The merge compares timestamps, the tombstone wins, and the row is correctly absent. Read repair then pushes the tombstone to C.

The tombstone is what makes deletion *converge*.

### The purge rule and zombie data

Compaction may drop a tombstone only when **both** hold:

```
1. localDeletionTime  <  now - gc_grace_seconds
2. No SSTable outside this compaction overlaps the same partition key
   with data older than the tombstone.
```

Condition 1 is the repair window. If you purge before every replica has learned of the delete, a subsequent repair sees "A has nothing, C has row(t=50)" and — because there is no longer a tombstone to say otherwise — propagates the row back to A and B. The data resurrects. **The contract is: you must complete a full repair of every table within `gc_grace_seconds`, on every node.** If your repair cycle is longer than 10 days, either speed it up or raise `gc_grace_seconds` to match.

Condition 2 is why tombstones outlive their grace period, often by months, under SizeTieredCompactionStrategy: the tombstone sits in a small new SSTable, the original row sits in a 200 GB old one, and they are in different size buckets that never compact together (Chapter 23).

### Read-time cost

During the merge, the read path must materialize every tombstone that could shadow a row in the requested slice. Cassandra counts them:

```
tombstone_warn_threshold: 1000        -> WARN in system.log, query still succeeds
tombstone_failure_threshold: 100000   -> TombstoneOverwhelmingException, query aborts
```

Critically, `LIMIT` is applied *after* the merge produces rows, so `SELECT … LIMIT 10` on a partition whose first 200,000 entries are tombstones scans all 200,000 and fails. There is no query-side fix.

Range tombstones are much cheaper per deleted row — one marker covers an arbitrary clustering slice — but a range tombstone still has to be evaluated against every row in its range during the merge, and *overlapping* range tombstones from repeated slice deletes are quadratic in the worst case (this was the CASSANDRA-11349-era pathology; 3.0+ handles it far better but it is still not free).

```svg
<svg viewBox="0 0 660 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="660" height="330" fill="#eef2ff"/>
  <text x="18" y="26" font-size="15" fill="#1e293b" font-weight="bold">Why a tombstone is required: RF=3, node C missed the delete</text>
  <rect x="20" y="48" width="180" height="76" rx="7" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.7"/>
  <text x="32" y="68" font-size="12" fill="#1e293b" font-weight="bold">replica A</text>
  <text x="32" y="88" font-size="11" fill="#1e293b">row u1  t=50</text>
  <text x="32" y="106" font-size="11" fill="#1e293b">tombstone t=100</text>
  <rect x="212" y="48" width="180" height="76" rx="7" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.7"/>
  <text x="224" y="68" font-size="12" fill="#1e293b" font-weight="bold">replica B</text>
  <text x="224" y="88" font-size="11" fill="#1e293b">row u1  t=50</text>
  <text x="224" y="106" font-size="11" fill="#1e293b">tombstone t=100</text>
  <rect x="404" y="48" width="180" height="76" rx="7" fill="#fef3c7" stroke="#d97706" stroke-width="1.9"/>
  <text x="416" y="68" font-size="12" fill="#1e293b" font-weight="bold">replica C (was down)</text>
  <text x="416" y="88" font-size="11" fill="#1e293b">row u1  t=50</text>
  <text x="416" y="106" font-size="11" fill="#1e293b">no tombstone</text>
  <rect x="20" y="146" width="600" height="52" rx="7" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.7"/>
  <text x="34" y="168" font-size="12" fill="#1e293b">Read merges A and C: tombstone t=100 beats row t=50 → row correctly absent.</text>
  <text x="34" y="188" font-size="12" fill="#1e293b">Read repair then pushes the tombstone to C. Convergence achieved.</text>
  <rect x="20" y="216" width="600" height="52" rx="7" fill="#ffffff" stroke="#d97706" stroke-width="1.9"/>
  <text x="34" y="238" font-size="12" fill="#1e293b">Purge the tombstone before C is repaired, and the next repair sees only row t=50</text>
  <text x="34" y="258" font-size="12" fill="#1e293b">on C — it propagates BACK to A and B. That is zombie data.</text>
  <text x="20" y="292" font-size="12" fill="#16a34a" font-weight="bold">Contract: complete a full repair of every table within gc_grace_seconds (10 days).</text>
  <text x="20" y="314" font-size="11" fill="#1e293b">Purge needs BOTH: localDeletionTime &lt; now - gc_grace, AND no overlapping older SSTable.</text>
</svg>
```

### The cost hierarchy of deletes

| Delete form | Tombstones written | Read cost |
| --- | --- | --- |
| `DELETE FROM t WHERE pk=?` | 1 partition tombstone | Cheapest; shadows everything below it |
| `DELETE FROM t WHERE pk=? AND ck>? AND ck<?` | 1 range tombstone | Cheap to write, must be evaluated per row in range |
| `DELETE FROM t WHERE pk=? AND ck=?` | 1 row tombstone per row | Linear in rows deleted |
| `DELETE col FROM t WHERE pk=? AND ck=?` | 1 cell tombstone per column | Worst; N columns = N tombstones |
| `UPDATE t SET col = null` | 1 cell tombstone (surprise!) | Same as above — a null write *is* a delete |
| Insert a `null` value in a prepared statement | 1 cell tombstone per null bind | The silent killer; use `UNSET_VALUE` |
| Collection overwrite (`SET tags = {…}`) | 1 range tombstone for the whole collection | Every full-collection write deletes then rewrites |
| TTL expiry | 1 tombstone per expiring cell, automatically | Free to write, still costs at read time |

The last three are the ones that surprise people. Writing `null` into a column is a delete, so an ORM that binds every field on every update generates a tombstone for every field left unset. Overwriting a collection with `SET` emits a range tombstone to clear the old contents before writing new ones — which is why `UPDATE … SET tags = tags + {'x'}` (append) is dramatically cheaper than `SET tags = {…}` (replace).

## 4. Architecture & Workflow

The life of one tombstone:

1. **Client issues a DELETE.** The coordinator assigns a microsecond write timestamp (or uses `USING TIMESTAMP`) and a `localDeletionTime` of the current second.
2. **Replication.** The tombstone is dispatched to all natural replicas exactly like an insert. Down replicas get hints (up to `max_hint_window`, 3 h).
3. **Commit log + memtable.** Each replica appends the tombstone to the commit log and inserts it into the memtable — a delete follows the identical write path (Chapter 21). Disk usage goes *up*.
4. **Flush.** The tombstone is written into an SSTable. `Statistics.db` records `maxLocalDeletionTime` and an estimated droppable-tombstone ratio for the file.
5. **Reads shadow the data.** Any read merging this SSTable with an older one sees the tombstone win on timestamp; the row is not returned. Tombstones scanned are counted against the warn/failure thresholds.
6. **Repair propagates it.** Nodes that missed the delete (hint window expired, longer outage) receive the tombstone through `nodetool repair`'s Merkle-tree comparison and streaming. **This must happen within `gc_grace_seconds`.**
7. **`gc_grace_seconds` elapses.** After 864000 seconds the tombstone becomes *eligible* for purging.
8. **Compaction evaluates the purge.** It drops the tombstone only if no SSTable outside the compaction set overlaps that key with older data. Under STCS this check frequently fails for months.
9. **Space reclaimed.** Only when both the tombstone and every shadowed cell are rewritten out does disk usage actually fall — and only after any snapshots/hard links referencing the old SSTables are cleared.
10. **Or: whole-file drop.** Under TWCS with TTLs, an entire SSTable whose `maxLocalDeletionTime` has passed is unlinked without any merge at all — the cheapest possible path (Chapter 23).

```svg
<svg viewBox="0 0 660 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="660" height="340" fill="#e0f2fe"/>
  <text x="18" y="26" font-size="15" fill="#1e293b" font-weight="bold">Life of a tombstone: written, replicated, repaired, then purged</text>
  <rect x="20" y="52" width="118" height="46" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="1.8"/>
  <text x="32" y="72" font-size="11" fill="#1e293b">DELETE issued</text>
  <text x="32" y="89" font-size="10" fill="#1e293b">t=100, ldt=now</text>
  <rect x="160" y="52" width="118" height="46" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="172" y="72" font-size="11" fill="#1e293b">commit log +</text>
  <text x="172" y="89" font-size="11" fill="#1e293b">memtable</text>
  <rect x="300" y="52" width="118" height="46" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="312" y="72" font-size="11" fill="#1e293b">flush → SSTable</text>
  <text x="312" y="89" font-size="10" fill="#1e293b">disk usage UP</text>
  <rect x="440" y="52" width="180" height="46" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.7"/>
  <text x="452" y="72" font-size="11" fill="#1e293b">repair propagates to</text>
  <text x="452" y="89" font-size="11" fill="#1e293b">every replica</text>
  <line x1="138" y1="75" x2="160" y2="75" stroke="#d97706" stroke-width="1.6" marker-end="url(#d24)"/>
  <line x1="278" y1="75" x2="300" y2="75" stroke="#d97706" stroke-width="1.6" marker-end="url(#d24)"/>
  <line x1="418" y1="75" x2="440" y2="75" stroke="#16a34a" stroke-width="1.6" marker-end="url(#d24b)"/>
  <rect x="20" y="126" width="600" height="46" rx="6" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.8"/>
  <text x="34" y="146" font-size="12" fill="#1e293b">During this whole period every read merges the tombstone and counts it:</text>
  <text x="34" y="164" font-size="12" fill="#1e293b">warn at 1000 scanned, TombstoneOverwhelmingException at 100000.</text>
  <rect x="20" y="192" width="290" height="60" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.7"/>
  <text x="32" y="212" font-size="11" fill="#1e293b" font-weight="bold">gc_grace_seconds elapses (10 d)</text>
  <text x="32" y="230" font-size="10" fill="#1e293b">AND no overlapping SSTable holds</text>
  <text x="32" y="245" font-size="10" fill="#1e293b">older data for that key</text>
  <rect x="330" y="192" width="290" height="60" rx="6" fill="#ffffff" stroke="#d97706" stroke-width="1.7"/>
  <text x="342" y="212" font-size="11" fill="#1e293b" font-weight="bold">If repair did NOT complete first:</text>
  <text x="342" y="230" font-size="10" fill="#1e293b">the stale replica still holds the row,</text>
  <text x="342" y="245" font-size="10" fill="#1e293b">and repair resurrects it. ZOMBIE.</text>
  <rect x="20" y="272" width="290" height="40" rx="6" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.8"/>
  <text x="32" y="297" font-size="11" fill="#1e293b">compaction purges → space reclaimed</text>
  <line x1="165" y1="252" x2="165" y2="272" stroke="#16a34a" stroke-width="1.7" marker-end="url(#d24b)"/>
  <text x="330" y="290" font-size="11" fill="#16a34a">TWCS fast path: drop the whole expired</text>
  <text x="330" y="306" font-size="11" fill="#16a34a">SSTable with zero merge I/O.</text>
  <text x="20" y="332" font-size="11" fill="#1e293b">Snapshots and incremental-backup hard links keep purged SSTables on disk — clear them.</text>
  <defs>
    <marker id="d24" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#d97706"/></marker>
    <marker id="d24b" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#16a34a"/></marker>
  </defs>
</svg>
```

## 5. Implementation

### The four delete forms, and what each costs

```cql
CREATE TABLE msg.by_channel (
  channel_id text,
  bucket     text,
  msg_id     timeuuid,
  author     text,
  body       text,
  tags       set<text>,
  PRIMARY KEY ((channel_id, bucket), msg_id)
) WITH CLUSTERING ORDER BY (msg_id DESC)
  AND gc_grace_seconds = 864000
  AND compaction = {'class':'TimeWindowCompactionStrategy',
                    'compaction_window_unit':'DAYS','compaction_window_size':1};

-- 1 partition tombstone: cheapest. Shadows the entire partition.
DELETE FROM msg.by_channel WHERE channel_id='c-9' AND bucket='2026-07-22';

-- 1 range tombstone covering a clustering slice.
DELETE FROM msg.by_channel
WHERE channel_id='c-9' AND bucket='2026-07-22' AND msg_id < 5a1f0e60-8c3d-11f0-9c2a-0242ac120002;

-- 1 row tombstone.
DELETE FROM msg.by_channel
WHERE channel_id='c-9' AND bucket='2026-07-22' AND msg_id = 5a1f0e60-8c3d-11f0-9c2a-0242ac120002;

-- 1 CELL tombstone. Note: identical to UPDATE ... SET body = null.
DELETE body FROM msg.by_channel
WHERE channel_id='c-9' AND bucket='2026-07-22' AND msg_id = 5a1f0e60-8c3d-11f0-9c2a-0242ac120002;

-- COLLECTION TRAP: this emits a range tombstone to clear the old set, then writes the new one.
UPDATE msg.by_channel SET tags = {'urgent','ops'} WHERE ...;   -- delete + insert
-- Append instead: no tombstone at all.
UPDATE msg.by_channel SET tags = tags + {'urgent'} WHERE ...;  -- pure insert

-- TTL: the cheapest "delete" - no client action, and TWCS can drop whole files.
INSERT INTO msg.by_channel (channel_id, bucket, msg_id, body)
VALUES ('c-9','2026-07-22', now(), 'hi') USING TTL 2592000;
```

### The null-binding trap

```python
from cassandra.cluster import Cluster
from cassandra.query import UNSET_VALUE

session = Cluster(["10.0.1.14"]).connect("msg")
ins = session.prepare(
    "INSERT INTO by_channel (channel_id, bucket, msg_id, author, body, tags) "
    "VALUES (?, ?, ?, ?, ?, ?)")

# WRONG: binding None writes a CELL TOMBSTONE for author and tags on every insert.
# An ORM that always binds all fields will manufacture millions of tombstones.
session.execute(ins, ("c-9", "2026-07-22", uuid1(), None, "hello", None))

# RIGHT: UNSET_VALUE (protocol v4+) tells the server "skip this column entirely".
session.execute(ins, ("c-9", "2026-07-22", uuid1(),
                      UNSET_VALUE, "hello", UNSET_VALUE))

# Also right: only bind the columns you actually have.
ins_min = session.prepare(
    "INSERT INTO by_channel (channel_id, bucket, msg_id, body) VALUES (?,?,?,?)")
```

```java
// Java driver 4.x: unset is the default for a BoundStatementBuilder you do not set.
BoundStatement bs = ins.boundStatementBuilder()
    .setString("channel_id", "c-9")
    .setString("bucket", "2026-07-22")
    .setUuid("msg_id", Uuids.timeBased())
    .setString("body", "hello")
    .build();          // author and tags are UNSET, not null -> no tombstones
```

### Finding and measuring tombstones

```bash
# Per-table: the two numbers that matter
nodetool tablestats msg.by_channel | grep -E 'tombstones|SSTable count|Space used'
# Average live cells per slice (last five minutes): 11.20
# Average tombstones per slice (last five minutes): 4821.00   <- pathological
# SSTable count: 14
# Space used (live): 88213441024

# Distribution, not just the average
nodetool tablehistograms msg by_channel
# Percentile  SSTables  Write Latency  Read Latency  Partition Size  Cell Count
# 99%             4.00          51.01      74502.90         2299427       17084
#                                          ^^^^^^^^ 74 ms p99 read: tombstones

# Per-SSTable droppable estimate
sstablemetadata /var/lib/cassandra/data/msg/by_channel-*/nb-2291-big-Data.db
# Estimated droppable tombstones: 0.7412        <- 74% of this file is garbage
# maxLocalDeletionTime: 1755678399
# Minimum timestamp: 1753000000000000

# Dump actual tombstones from an SSTable to see the pattern
sstabledump nb-2291-big-Data.db | head -40
# { "partition" : { "key" : [ "c-9", "2026-07-22" ],
#     "deletion_info" : { "marked_deleted" : "2026-07-22T09:14:02.113Z",
#                         "local_delete_time" : "2026-07-22T09:14:02Z" } }, ... }

# The log tells you before your users do
grep -i 'tombstone' /var/log/cassandra/system.log | tail
# WARN  ReadCommand.java:569 - Read 10 live rows and 41221 tombstone cells for query
#   SELECT * FROM msg.by_channel WHERE channel_id = 'c-9' LIMIT 10
#   (see tombstone_warn_threshold)
```

```yaml
# cassandra.yaml
tombstone_warn_threshold: 1000
tombstone_failure_threshold: 100000
# Leave these alone. Raising the failure threshold hides the symptom and
# converts a fast failure into a cluster-wide latency collapse.
```

### Forcing reclaim when you cannot wait

```bash
# 1. Single-SSTable compaction of files above the droppable ratio (automatic, but tunable)
cqlsh -e "ALTER TABLE msg.by_channel WITH compaction =
  {'class':'TimeWindowCompactionStrategy','compaction_window_unit':'DAYS',
   'compaction_window_size':1,'tombstone_threshold':0.1,
   'tombstone_compaction_interval':3600,'unchecked_tombstone_compaction':true};"
# unchecked_tombstone_compaction skips the overlap check for single-SSTable
# compactions. Safe ONLY if you are certain repair is current.

# 2. Cassandra 4.0+: purge tombstones without a full compaction
nodetool garbagecollect -g CELL msg by_channel

# 3. Verify a repair actually completed inside gc_grace before doing anything drastic
nodetool repair -full msg by_channel
# then, and only then, consider lowering gc_grace_seconds temporarily:
cqlsh -e "ALTER TABLE msg.by_channel WITH gc_grace_seconds = 3600;"
nodetool compact msg by_channel
cqlsh -e "ALTER TABLE msg.by_channel WITH gc_grace_seconds = 864000;"
# ^ This is the emergency procedure. It is only safe with a verified-complete
#   repair, because it removes the protection against zombie data.
```

**Optimization:** the only durable fix for tombstone pain is a data model that does not delete. In order of preference: (1) use **TTL + TWCS** so expiry is free and whole SSTables drop without merging; (2) **partition by time bucket and delete whole partitions** — one partition tombstone instead of a million row tombstones, and reads never scan them because the partition is skipped entirely; (3) if you must delete rows, delete *ranges* rather than individual rows; (4) never write `null` — bind `UNSET_VALUE`; (5) for collections, prefer `+`/`-` append/remove over full `SET` replacement. Tuning `tombstone_failure_threshold` is not on this list; it is the symptom, not the disease.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost/Trade-off |
| --- | --- | --- |
| Delete-as-write | No coordination needed; deletes are as fast and available as inserts | Disk usage *increases* on delete until compaction runs |
| Tombstone convergence | Guarantees a delete beats older data on every replica, in any order | Requires repair within `gc_grace_seconds` or data resurrects |
| `gc_grace_seconds = 864000` | Generous window for repair to propagate deletes | 10 days of tombstones on disk and in every read merge |
| Partition tombstone | One marker deletes an unbounded number of rows; reads skip the partition | Only available if the model partitions along the deletion boundary |
| Range tombstone | One marker for a whole clustering slice | Still evaluated per row during merge; overlapping ranges get expensive |
| TTL | Zero client cost, and TWCS can drop whole files | Every expiring cell still becomes a tombstone at read time until purged |
| Warn/failure thresholds | Fail fast instead of collapsing the cluster | An aborted query is still a user-visible error |
| `unchecked_tombstone_compaction` | Reclaims space without the overlap check | Bypasses a zombie-data safeguard; only safe with verified-current repair |

## 7. Common Mistakes & Best Practices

1. ⚠️ Modeling a queue as a Cassandra partition and deleting processed rows → ✅ Cassandra is not a queue. Tombstones accumulate at the head of the partition and `SELECT … LIMIT 10` scans past all of them. Use Kafka/SQS/Pulsar for queues, or if you must, bucket by time and drop whole partitions.
2. ⚠️ Raising `tombstone_failure_threshold` when queries start failing → ✅ The threshold is a circuit breaker protecting the cluster. Raising it converts a fast, contained failure into heap pressure, GC pauses, and cluster-wide latency collapse. Fix the model.
3. ⚠️ Binding `null` in prepared statements (or letting an ORM do it) → ✅ Every `null` bind writes a cell tombstone. Use `UNSET_VALUE` (protocol v4+), or prepare narrower statements that bind only the columns you actually have.
4. ⚠️ Lowering `gc_grace_seconds` to reclaim space faster, without checking repair → ✅ You are removing the guarantee that every replica learned about the delete. Zombie data is silent and permanent. Only lower it after verifying a full repair of that table completed on every node, and raise it back afterwards.
5. ⚠️ Not repairing within `gc_grace_seconds` → ✅ The 10-day default is a *contract*, not a suggestion. Run `nodetool repair` (or Reaper) on a schedule that completes every table on every node comfortably inside the window, and alert when a table's last successful repair exceeds `gc_grace_seconds × 0.7`.
6. ⚠️ `UPDATE t SET my_collection = {…}` on every write → ✅ A full-collection assignment emits a range tombstone to clear the old contents first. Use `collection + {…}` and `collection - {…}` for incremental changes, or model collection elements as clustering rows.
7. ⚠️ STCS on a delete-heavy or TTL'd table → ✅ Tombstones land in small new SSTables while the data they shadow sits in large old ones; different size buckets mean they never compact together and space is never reclaimed. Use LCS (delete-heavy with updates) or TWCS (TTL time series).
8. ⚠️ Reading a partition with `SELECT * … LIMIT 1` and assuming it is cheap → ✅ `LIMIT` is applied after the merge, so a partition fronted by 200,000 tombstones costs 200,000 scans regardless of the limit.
9. ⚠️ Deleting rows from a TWCS table → ✅ The tombstone lands in the current time window and shadows data in old windows, preventing those windows' SSTables from being dropped whole — destroying the main benefit of TWCS. Use TTL instead.
10. ⚠️ Assuming a `DELETE` reclaims disk immediately (or that it satisfies GDPR erasure) → ✅ The data physically remains until compaction merges past `gc_grace_seconds` and all overlapping SSTables are rewritten, plus however long snapshots keep hard links alive. Plan and verify the reclaim path explicitly.
11. ⚠️ Using `TRUNCATE` casually to clear a table → ✅ `TRUNCATE` takes an automatic snapshot by default (`auto_snapshot: true`), so disk does not drop until you `nodetool clearsnapshot`. It also requires all nodes to be up.

## 8. Production: Debugging, Monitoring, Security & Scaling

### Debugging
- `grep -i tombstone /var/log/cassandra/system.log` — the warning line names the exact query, the live-row count, and the tombstone count. That is usually the whole diagnosis.
- `nodetool tablestats <ks>.<tbl>` → `Average tombstones per slice (last five minutes)` vs `Average live cells per slice`. A ratio above ~1:1 is a problem; above 100:1 is an incident.
- `sstablemetadata <Data.db>` → `Estimated droppable tombstones` per file, and `maxLocalDeletionTime` to see when a file becomes droppable.
- `sstabledump <Data.db> | jq` shows actual `deletion_info` markers so you can identify *which* delete pattern is generating them (cell vs row vs range).
- `nodetool tablehistograms` — a huge gap between p50 and p99 read latency on a table with normal partition sizes is the tombstone signature.

### Monitoring
- `org.apache.cassandra.metrics:type=Table,keyspace=*,scope=*,name=TombstoneScannedHistogram` — the primary metric; alert on p99 > 1000.
- `type=Table,name=LiveScannedHistogram` — track the tombstone:live ratio, not the absolute count.
- `type=Table,name=DroppableTombstoneRatio` (4.0+) per table.
- `type=ClientRequest,scope=Read,name=Failures` — `TombstoneOverwhelmingException` surfaces here.
- Track *last successful repair time per table* as a first-class metric and alert at 70% of `gc_grace_seconds`. This is the single most important tombstone-related alarm, because breaching it risks silent data resurrection.
- `type=Compaction,name=PendingTasks` — a backlog means tombstones are not being purged even when eligible.

### Security
- Deleted data physically persists until compaction rewrites the containing SSTables — potentially for months under STCS, plus indefinitely in any snapshot. For GDPR/CCPA right-to-erasure you must be able to *prove* removal: after the `DELETE`, ensure repair completes, then force reclaim (`nodetool garbagecollect` or a targeted compaction), then clear snapshots and incremental backups, then verify with `sstabledump`.
- Backups taken before a deletion contain the data forever. Erasure procedures must include a backup-retention policy that ages out old snapshots within a defined window.
- `TRUNCATE` and `DROP TABLE` take automatic snapshots by default; for genuinely sensitive data set `auto_snapshot: false` deliberately and document the loss of the safety net.
- Restrict `DELETE` via RBAC (`GRANT MODIFY` is coarse — it covers insert, update and delete), and enable the 4.0 audit log with `included_categories: DML` on sensitive keyspaces so deletions are attributable.

### Performance & Scaling
- Tombstone cost scales with *reads*, not with data size: a table can be small and still be unusable if every read walks 100k tombstones.
- Deletes consume the same write path capacity as inserts, and then consume compaction capacity to reclaim. A bulk delete of 100 M rows is a 100 M-row write workload followed by a large compaction burst — plan capacity for both.
- Prefer partition-level deletes at scale: dropping a whole time-bucketed partition is O(1) markers and reads skip the partition without scanning.
- On a delete-heavy table, LCS bounds the overlap problem far better than STCS because levels are non-overlapping, so the purge condition is much more often satisfiable.
- If you are about to mass-delete, consider instead: create a new table, dual-write, backfill only the surviving rows, and `DROP` the old table. Dropping a table reclaims everything instantly with no tombstones at all.

## 9. Interview Questions

**Q: Why does a DELETE in Cassandra create data instead of removing it?**
A: SSTables are immutable, so nothing can be erased in place, and replicas are eventually consistent, so a node that missed the delete would otherwise resurrect the row during a merge or repair. Writing a tombstone — a marker with a timestamp — lets ordinary last-write-wins reconciliation make the deletion converge everywhere without coordination.

**Q: What is `gc_grace_seconds` and why is it 10 days?**
A: It is the minimum age a tombstone must reach before compaction may purge it, defaulting to 864000 seconds. Ten days is a deliberately generous window for a full `nodetool repair` to propagate the tombstone to every replica, including nodes that were down longer than the 3-hour hint window. If you purge before repair reaches a stale replica, the deleted data resurrects.

**Q: What is zombie data?**
A: Deleted data that reappears because its tombstone was purged before every replica learned about the deletion. The stale replica still holds the original row, and once the tombstone is gone there is nothing with a higher timestamp to shadow it, so the next repair propagates the row back to the other replicas. It is silent and effectively permanent.

**Q: Name the four kinds of tombstone and their relative cost.**
A: Partition tombstone (one marker deletes the whole partition — cheapest, and reads skip the partition), range tombstone (one marker for a clustering slice), row tombstone (one per row), and cell tombstone (one per column value, including any `null` write). Cost at read time grows in that order, so partition-level deletes are always preferable when the model allows.

**Q: Why can `SELECT * FROM t WHERE pk=? LIMIT 1` time out?**
A: `LIMIT` is applied after the storage engine merges rows, so the merge must first walk every tombstone shadowing the requested slice. If the front of the partition holds 200,000 tombstones, the read scans all of them, trips `tombstone_failure_threshold` at 100,000, and throws `TombstoneOverwhelmingException` before returning a single live row.

**Q: How does writing `null` create a tombstone?**
A: In CQL, setting a column to `null` is semantically identical to deleting that cell, so the server writes a cell tombstone. Prepared statements that bind `None`/`null` for optional fields — very common with ORMs that always bind every column — silently generate one tombstone per null column per write. The fix is `UNSET_VALUE` (native protocol v4+) or narrower prepared statements.

**Q: Why does overwriting a collection generate tombstones?**
A: `SET tags = {'a','b'}` cannot know which old elements to keep, so Cassandra emits a range tombstone covering the whole collection to clear it and then writes the new elements. Using `tags = tags + {'a'}` or `tags = tags - {'b'}` performs an incremental update with no tombstone at all.

**Q: (Senior) A table's read p99 went from 3 ms to 6 s with no traffic change. Walk through the diagnosis.**
A: Check `nodetool tablestats` for `Average tombstones per slice` versus `Average live cells per slice` — a ratio in the hundreds confirms tombstones. Then `grep tombstone` in system.log to get the exact offending query. Then `sstablemetadata` on the table's SSTables for `Estimated droppable tombstones` to see whether they are eligible but unpurged, and `nodetool compactionstats` to see whether compaction is backed up. Finally `sstabledump` to identify the delete *shape* (cell tombstones point at null bindings; row tombstones point at a queue pattern; range tombstones point at collection overwrites). Immediate mitigation is `nodetool garbagecollect` or a targeted compaction if the tombstones are past grace and repair is current; the real fix is the data model.

**Q: (Senior) Compaction has run repeatedly but tombstones are not being dropped. Why?**
A: The purge rule requires two conditions, and the second is usually the blocker: no SSTable *outside the compaction set* may overlap that partition key with data older than the tombstone. Under STCS the tombstone sits in a small recent SSTable while the shadowed data sits in a large old one in a different size bucket, so they never compact together and the overlap check keeps failing. Options: switch to LCS (non-overlapping levels make the check satisfiable) or TWCS for TTL data, set `unchecked_tombstone_compaction: true` for single-SSTable compaction if repair is verified current, use `nodetool garbagecollect`, or as a last resort a targeted major compaction with `--split-output`.

**Q: (Senior) How do you safely satisfy a GDPR erasure request in Cassandra?**
A: A `DELETE` alone is not erasure — the data remains on disk in SSTables, in snapshots, and in backups. The procedure is: issue the delete, confirm a full repair of that table completed on every node so the tombstone is universal, then force physical reclaim with `nodetool garbagecollect` or a targeted compaction that rewrites the containing SSTables, then `nodetool clearsnapshot` and purge incremental backups, then age out any offsite backup containing the pre-delete state within your documented retention window. Verify with `sstabledump` on the resulting files. Where erasure is a core requirement, encrypt per-subject with a key you can destroy (crypto-shredding), which makes reclaim instantaneous.

**Q: When is it acceptable to lower `gc_grace_seconds`?**
A: On a table that relies exclusively on TTL and never issues explicit `DELETE`s, because expiring cells carry a deterministic `localDeletionTime` and every replica computes the same expiry independently — there is no delete event to miss, so there is no resurrection risk. It is also acceptable temporarily as an emergency reclaim procedure, but only immediately after a verified-complete full repair, and it should be raised back afterwards.

**Q: How does TWCS make deletes cheap, and what ruins it?**
A: With TTL data, TWCS confines an entire time window's rows to one SSTable whose `maxLocalDeletionTime` is known; once that time passes, Cassandra unlinks the whole file with no merge I/O. Explicit `DELETE`s ruin it, because the tombstone lands in the *current* window and shadows data in older windows, which blocks those files from being dropped whole and forces cross-window work TWCS is designed to avoid.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** A delete is a write: Cassandra records a tombstone with a write timestamp and a `localDeletionTime`, replicates it like any mutation, and lets last-write-wins merging shadow the older data. Tombstones come in four sizes — partition (cheapest), range, row, cell (worst) — and are also produced silently by writing `null`, by binding `None` in prepared statements, by full-collection `SET` assignment, and by TTL expiry. Every read must walk the tombstones shadowing its slice, and `LIMIT` is applied *after* that walk, so `tombstone_warn_threshold: 1000` and `tombstone_failure_threshold: 100000` exist to fail fast. A tombstone may be purged only when it is older than `gc_grace_seconds` (864000, 10 days) **and** no overlapping SSTable holds older data for that key; purging early resurrects the row as zombie data, so **repair must complete within `gc_grace_seconds`**. STCS makes the overlap condition nearly unsatisfiable; LCS and TWCS do not. The durable fix for tombstone pain is always a model that deletes whole partitions or uses TTL + TWCS, never a threshold change.

| Item | Value / Command |
| --- | --- |
| `gc_grace_seconds` | 864000 s (10 days) |
| `tombstone_warn_threshold` | 1000 scanned per read |
| `tombstone_failure_threshold` | 100000 → `TombstoneOverwhelmingException` |
| Purge condition | past grace **AND** no overlapping older SSTable |
| Cheapest delete | partition tombstone (`DELETE … WHERE pk=?`) |
| Most expensive | cell tombstones (one per column, incl. `null` writes) |
| Avoid nulls | bind `UNSET_VALUE` (protocol v4+) |
| Collections | use `col + {…}` / `col - {…}`, not `col = {…}` |
| Best strategy for TTL data | TWCS (drops whole expired SSTables) |
| Best strategy for delete-heavy updates | LCS (non-overlapping levels) |
| Measure | `nodetool tablestats` → tombstones vs live cells per slice |
| Per-file estimate | `sstablemetadata` → `Estimated droppable tombstones` |
| See actual markers | `sstabledump <Data.db>` |
| Force reclaim (4.0+) | `nodetool garbagecollect -g CELL <ks> <tbl>` |
| Key alert | last successful repair per table > 0.7 × `gc_grace_seconds` |

Flash cards:
- **Why is a delete a write?** → SSTables are immutable and replicas are eventually consistent, so only a timestamped tombstone can make deletion converge without coordination.
- **Both conditions to purge a tombstone?** → Older than `gc_grace_seconds`, AND no SSTable outside the compaction overlaps that key with older data.
- **What creates tombstones by accident?** → Writing `null`, binding `None` in prepared statements, and full-collection `SET` assignment.
- **Why does `LIMIT 1` still time out?** → `LIMIT` is applied after the merge, so every shadowing tombstone is scanned first.
- **The one non-negotiable operational rule?** → Complete a full repair of every table within `gc_grace_seconds`, or risk zombie data.

## 11. Hands-On Exercises & Mini Project

- [ ] Insert 100 rows into one partition, `nodetool flush`, delete 90 of them, flush again, and use `sstabledump` to find the 90 row tombstones. Then `nodetool tablestats` and read the tombstones-per-slice figure.
- [ ] Write 200,000 rows to one partition, delete them all row-by-row, then run `SELECT * … LIMIT 1` and capture the `TombstoneOverwhelmingException`. Repeat with a single partition-level `DELETE` and show the read is instant.
- [ ] Prepare an INSERT with 6 columns and bind `None` for 3 of them 10,000 times. Confirm with `sstabledump` that 30,000 cell tombstones exist. Rerun with `UNSET_VALUE` and confirm zero.
- [ ] Set `gc_grace_seconds = 60` on a test table, delete rows, wait, run `nodetool compact`, and use `sstablemetadata` to show the droppable ratio fall to zero and disk usage drop.
- [ ] Simulate zombie data: stop one node of an RF=3 cluster, delete a row at `LOCAL_QUORUM`, set `gc_grace_seconds = 0`, compact the live nodes, restart the third node, run `nodetool repair`, and observe the row return.

### Mini Project — A tombstone audit and remediation service

**Goal.** Build a service that finds tombstone problems across a cluster before they cause an incident, and proposes model-level fixes rather than threshold changes.

**Requirements.**
1. For every table, collect `TombstoneScannedHistogram` p50/p99, `LiveScannedHistogram` p99, `DroppableTombstoneRatio`, compaction strategy, `gc_grace_seconds`, whether `default_time_to_live` is set, and the last successful repair time.
2. Classify each table: healthy (tombstone:live < 1), warning (1–100), critical (> 100 or any read failure), plus a separate "repair overdue" flag when last repair > 0.7 × `gc_grace_seconds`.
3. For critical tables, run `sstabledump` on a sample SSTable and classify the dominant tombstone *shape* — cell, row, range, or partition — mapping each to its likely root cause (null bindings, queue pattern, collection overwrite, correct usage).
4. Emit a remediation plan per table: switch to TWCS + TTL, switch to LCS, adopt partition-level deletes, fix null bindings with `UNSET_VALUE`, or run `nodetool garbagecollect` if the tombstones are simply unpurged.
5. Refuse to suggest raising `tombstone_failure_threshold` — instead, explain why in the report.

**Extensions.**
- Add a "zombie risk" score combining repair recency, `gc_grace_seconds`, and node downtime history.
- Simulate the remediation on a clone of the table and report the projected tombstone:live ratio after the change.
- Export the classifications as Prometheus metrics and build a Grafana panel showing tombstone:live ratio per table over time.

## 12. Related Topics & Free Learning Resources

Read together with **Compaction Strategies** (which decides whether tombstones can ever be purged), **The Read Path** (why tombstones dominate read latency), **Repair & Anti-Entropy** (the operation `gc_grace_seconds` exists to accommodate), and **Query-First Data Modeling** (the only durable fix).

- **Deletes and Tombstones — Apache Cassandra Documentation** — Apache Software Foundation · *Intermediate* · Authoritative description of tombstone kinds, `gc_grace_seconds`, and the purge conditions. <https://cassandra.apache.org/doc/latest/cassandra/managing/operating/compaction/index.html>
- **About Deletes and Tombstones in Cassandra** — The Last Pickle · *Advanced* · The best single article on tombstone shapes, why they linger, and how to actually reclaim space. <https://thelastpickle.com/blog/2016/07/27/about-deletes-and-tombstones.html>
- **Cassandra Anti-Patterns: Queues and Queue-like Datasets** — DataStax Engineering · *Intermediate* · The canonical explanation of why the queue pattern destroys read performance via tombstones. <https://www.datastax.com/blog/cassandra-anti-patterns-queues-and-queue-datasets>
- **CASSANDRA-6696 / CASSANDRA-11349: Range tombstone handling** — Apache JIRA · *Advanced* · The engineering history of range-tombstone performance pathologies and their 3.0 fixes. <https://issues.apache.org/jira/browse/CASSANDRA-11349>
- **Common Problems with Cassandra Tombstones** — Alain Rodriguez / The Last Pickle · *Advanced* · Field guide to diagnosing tombstone incidents with `sstablemetadata` and `sstabledump`. <https://thelastpickle.com/blog/2018/07/05/undetectable-tombstones-in-apache-cassandra.html>
- **Cassandra Data Modeling Best Practices** — Apache Software Foundation · *Beginner* · The modeling rules (bounded partitions, TTL, time bucketing) that prevent tombstone problems in the first place. <https://cassandra.apache.org/doc/latest/cassandra/developing/data-modeling/index.html>
- **nodetool garbagecollect and Tombstone Purging** — Apache Software Foundation · *Intermediate* · The 4.0+ operational tool for forcing reclaim without a full major compaction. <https://cassandra.apache.org/doc/latest/cassandra/managing/tools/nodetool/garbagecollect.html>
- **Scylla University: Deletes, Tombstones and Compaction** — ScyllaDB · *Beginner* · Free lesson covering the same tombstone lifecycle with clear animations. <https://university.scylladb.com/courses/scylla-operations/lessons/compaction-strategies/>

---

*Apache Cassandra Handbook — chapter 24.*
