# 30 · Backup, Snapshots & Restore

> **In one line:** Cassandra backups are hard links to immutable SSTables — snapshots for point-in-time, incremental backups for the deltas, commit log archiving for sub-flush granularity — and every one of them is worthless until you have rehearsed the restore.

---

## 1. Overview

Replication is not backup. `RF=3` across three racks survives hardware failure beautifully and does nothing whatsoever about the two failure modes that actually destroy companies: **someone ran `TRUNCATE` on the wrong keyspace**, and **a bad deploy wrote garbage into a live table**. Both of those replicate perfectly to all three replicas in milliseconds. Backup exists for logical corruption and human error, and a Cassandra cluster with no tested restore procedure is a cluster with no backup.

The mechanism Cassandra offers is unusually cheap because of one property from the storage engine: **SSTables are immutable**. A snapshot is therefore just a directory of **hard links** to the current SSTable files. Creating one is nearly instantaneous and consumes essentially zero additional disk at the moment of creation — the inode count goes up, the block count does not. Space is consumed only *later*, as compaction replaces the original files and the hard links keep the old blocks alive. That is both the elegance and the trap: `nodetool snapshot` looks free, so people forget to clear them, and forgotten snapshots are one of the top causes of "disk full" incidents in production Cassandra.

Three layers stack. **Snapshots** give you a consistent-per-node point-in-time set of all flushed data. **Incremental backups** (`incremental_backups: true`) hard-link every newly flushed SSTable into a `backups/` directory as it is written, so between snapshots you accumulate the deltas without repeating the full dataset. **Commit log archiving** (`commitlog_archiving.properties`) copies commit log segments as they are recycled, giving you the writes that had not yet been flushed — the only way to achieve genuine point-in-time recovery to a specific second.

The critical caveat that catches everyone: **a Cassandra snapshot is per-node and not cluster-consistent**. `nodetool snapshot` on node A and node B are separate operations at slightly different instants, and Cassandra has no distributed snapshot barrier. Restoring a full cluster from snapshots therefore gives you a state that is *approximately* a point in time, with per-node skew, and requires a repair afterwards to reconcile. Systems like Netflix's Priam and DataStax's OpsCenter (and modern operators like K8ssandra's Medusa) exist largely to orchestrate this: take snapshots across all nodes as close together as possible, ship them to object storage, track the topology and token assignments, and drive the restore.

Concretely: a 24-node cluster with 1 TB per node, running nightly `nodetool snapshot` plus continuous incremental backups shipped to S3. Nightly snapshot creation takes seconds per node. The upload is the real cost — roughly 24 TB on the first full run, then only deltas. Restore of a single accidentally-truncated table is minutes (drop the SSTables back and `nodetool refresh`). Restore of the whole cluster to yesterday is hours and must be practised, because the first time you attempt it should never be the day you need it.

## 2. Core Concepts

- **Snapshot** — a set of hard links to all current SSTables for a table/keyspace, placed under `<data_dir>/<ks>/<table>-<id>/snapshots/<tag>/`. Instant, initially free, per-node.
- **Hard link** — a second directory entry pointing at the same inode. The blocks are freed only when the last link is removed — which is why snapshots consume space as compaction deletes the originals.
- **Incremental backup** — with `incremental_backups: true`, every newly flushed SSTable is hard-linked into `<table>/backups/` at flush time. Deltas since the last snapshot. **Never auto-cleaned** — you must remove them yourself.
- **Commit log archiving** — `commitlog_archiving.properties` defines an `archive_command` run when a segment is recycled and a `restore_command` plus `restore_point_in_time` for replay. The only path to second-granularity PITR.
- **`nodetool refresh`** — tells a running node to pick up SSTable files that have been dropped into a table's data directory. The fast restore path when tokens are unchanged.
- **`sstableloader`** — an offline bulk loader that reads SSTables and streams their rows to the correct owners based on the *current* ring. The restore path when topology has changed.
- **Schema backup** — `cqlsh -e "DESCRIBE SCHEMA"`. SSTables are useless without the exact table definitions; the schema must be backed up separately and versioned.
- **RPO / RTO** — Recovery Point Objective (how much data you can lose) and Recovery Time Objective (how long recovery may take). Snapshots alone give an RPO of one snapshot interval; commit log archiving pushes it toward seconds.
- **Truncate and snapshot** — `auto_snapshot: true` (default) makes Cassandra take an automatic snapshot before `TRUNCATE` or `DROP`. This has saved more data than every backup tool combined. Never disable it.
- **Medusa / Priam** — open-source backup orchestrators (K8ssandra's Medusa, Netflix's Priam) that handle cluster-wide snapshot coordination, object-storage upload, and restore.

## 3. Theory & Internals

**Why snapshots are cheap and then suddenly are not.** `nodetool snapshot` calls `ColumnFamilyStore.snapshot()`, which (by default) first flushes memtables, then creates a `snapshots/<tag>/` directory and issues a `link()` syscall for every live SSTable component. Cost: one directory plus a few hundred inodes per table. Disk usage at creation: essentially zero, because both directory entries reference the same blocks.

Then compaction runs. Compaction merges SSTables `A, B, C` into `D` and unlinks `A, B, C` from the live directory. But the snapshot still links them, so their blocks are **not** freed. Over a week of compaction, a snapshot taken at day zero can end up pinning an amount of disk approaching the full dataset size at that moment. `nodetool tablestats` reports this explicitly as `Space used by snapshots (total)`, and it is the number to alert on.

**What a snapshot does and does not contain.** It contains all data that was **flushed** at snapshot time (the default `nodetool snapshot` flushes first; `-sf`/`--skip-flush` skips that and gives you only what was already on disk). It does **not** contain: data still in memtables if you skipped the flush; the schema; the `system` keyspace's token assignments unless you snapshot that too; or anything written after the snapshot instant. It is per-node — there is no cluster-wide barrier, so two nodes' snapshots differ by however long it took your orchestrator to fan out the command.

**Consistency of a restored cluster.** Because snapshots are per-node and not coordinated, restoring all nodes from "the same" nightly snapshot yields replicas that disagree at the edges — some replicas have a write, others do not, depending on exactly when each node's snapshot fired relative to the write. The restored cluster is still *correct* in Cassandra's model (last-write-wins reconciliation handles it), but replicas are divergent, so **a full repair after a cluster-wide restore is mandatory**. This also means `RF` still protects you during restore: with `RF=3` you can restore nodes one at a time and let the cluster keep serving.

**Restore paths and when each applies.**

- **Same tokens, same node, node is up** → drop SSTable files into the table's data directory and run `nodetool refresh <ks> <tbl>`. Fastest path; no streaming.
- **Same tokens, node was rebuilt** → restore `system` keyspace token state or start the node with `-Dcassandra.replace_address_first_boot` and restore data, then `refresh`.
- **Different topology (different node count, different tokens)** → `sstableloader`. It parses the SSTables, computes each partition's token, consults the live ring, and streams rows to their correct current owners. Slower (it is a full re-ingest via streaming) but topology-independent.
- **Point in time between snapshots** → restore the nearest snapshot plus incremental backups, then replay archived commit logs with `restore_point_in_time` set.

**Commit log archiving mechanics.** When a segment is recycled, Cassandra executes `archive_command` with `%path` and `%name` substituted. On restore, you place archived segments where `restore_directories` points, set `restore_point_in_time` to a timestamp, and start the node: it replays mutations up to that timestamp and stops. Because commit log segments contain mutations for *all* tables, PITR is inherently keyspace-wide, not table-scoped — a subtlety that surprises people expecting to rewind one table.

```svg
<svg viewBox="0 0 820 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="a30a" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="410" y="20" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">Snapshots are hard links: free at creation, costly after compaction</text>

  <text x="200" y="52" text-anchor="middle" fill="#1e293b" font-weight="700" font-size="13">Day 0: snapshot taken</text>

  <rect x="40" y="66" width="320" height="52" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="200" y="87" text-anchor="middle" fill="#1e293b" font-weight="700">live directory</text>
  <text x="200" y="105" text-anchor="middle" fill="#64748b" font-size="10">nb-1-Data.db   nb-2-Data.db   nb-3-Data.db</text>

  <rect x="40" y="170" width="320" height="52" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="200" y="191" text-anchor="middle" fill="#1e293b" font-weight="700">snapshots/nightly</text>
  <text x="200" y="209" text-anchor="middle" fill="#64748b" font-size="10">nb-1-Data.db   nb-2-Data.db   nb-3-Data.db</text>

  <line x1="110" y1="118" x2="110" y2="166" stroke="#16a34a" stroke-dasharray="4 3" marker-end="url(#a30a)"/>
  <line x1="200" y1="118" x2="200" y2="166" stroke="#16a34a" stroke-dasharray="4 3" marker-end="url(#a30a)"/>
  <line x1="290" y1="118" x2="290" y2="166" stroke="#16a34a" stroke-dasharray="4 3" marker-end="url(#a30a)"/>
  <text x="200" y="146" text-anchor="middle" fill="#15803d" font-size="11" font-weight="700">same inodes, 0 extra bytes</text>

  <text x="620" y="52" text-anchor="middle" fill="#1e293b" font-weight="700" font-size="13">Day 7: compaction has run</text>

  <rect x="460" y="66" width="320" height="52" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="620" y="87" text-anchor="middle" fill="#1e293b" font-weight="700">live directory</text>
  <text x="620" y="105" text-anchor="middle" fill="#64748b" font-size="10">nb-9-Data.db  (merged 1, 2, 3)</text>

  <rect x="460" y="170" width="320" height="52" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="620" y="191" text-anchor="middle" fill="#1e293b" font-weight="700">snapshots/nightly</text>
  <text x="620" y="209" text-anchor="middle" fill="#64748b" font-size="10">nb-1-Data.db   nb-2-Data.db   nb-3-Data.db</text>
  <text x="620" y="146" text-anchor="middle" fill="#b45309" font-size="11" font-weight="700">originals unlinked from live but still pinned</text>
  <text x="620" y="242" text-anchor="middle" fill="#b91c1c" font-size="11" font-weight="700">now consuming real disk</text>

  <line x1="620" y1="118" x2="620" y2="140" stroke="#d97706" marker-end="url(#a30a)"/>

  <line x1="40" y1="268" x2="780" y2="268" stroke="#cbd5e1"/>

  <text x="410" y="292" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="700">Three backup layers and their recovery point</text>

  <rect x="40" y="308" width="230" height="76" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="155" y="330" text-anchor="middle" fill="#1e293b" font-weight="700">Snapshot</text>
  <text x="155" y="349" text-anchor="middle" fill="#1e293b" font-size="11">full flushed state</text>
  <text x="155" y="367" text-anchor="middle" fill="#64748b" font-size="10">RPO = snapshot interval</text>

  <rect x="295" y="308" width="230" height="76" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="410" y="330" text-anchor="middle" fill="#1e293b" font-weight="700">Incremental backup</text>
  <text x="410" y="349" text-anchor="middle" fill="#1e293b" font-size="11">every flushed SSTable</text>
  <text x="410" y="367" text-anchor="middle" fill="#64748b" font-size="10">RPO = memtable flush interval</text>

  <rect x="550" y="308" width="230" height="76" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="665" y="330" text-anchor="middle" fill="#1e293b" font-weight="700">Commit log archive</text>
  <text x="665" y="349" text-anchor="middle" fill="#1e293b" font-size="11">unflushed mutations</text>
  <text x="665" y="367" text-anchor="middle" fill="#64748b" font-size="10">RPO = seconds, true PITR</text>
</svg>
```

## 4. Architecture & Workflow

**Taking a cluster backup.**

1. Back up the **schema** first: `cqlsh -e "DESCRIBE SCHEMA" > schema-$(date +%F).cql`, committed to version control. SSTables without schema are unrecoverable.
2. Back up **token assignments** per node: `nodetool ring` output or `SELECT tokens FROM system.local`. You need these to restore to identical tokens.
3. Fan out `nodetool snapshot -t <tag> <keyspace>` to every node as close to simultaneously as your orchestrator allows.
4. Upload each node's `snapshots/<tag>/` directories to object storage, keyed by `cluster/node-id/tag/keyspace/table/`. Record the node's host ID and tokens in the same prefix.
5. With `incremental_backups: true`, continuously ship `<table>/backups/*` to object storage and then **delete the local copies** — Cassandra never cleans them.
6. `nodetool clearsnapshot -t <tag> <keyspace>` once the upload is verified. Verify by checksum, not by exit code.
7. Record the manifest: cluster name, node list, tokens, schema version, snapshot tag, timestamp, and the set of incremental files that follow it.

**Restoring a single table on a live cluster (same topology).**

1. Stop application writes to that table if you can; otherwise accept that restored data merges by timestamp with live data.
2. `TRUNCATE` the table if you want the snapshot's state exactly. (This itself takes an auto-snapshot — good.)
3. Copy the snapshot's SSTable files into `<data_dir>/<ks>/<table>-<id>/` on **each** node, from that node's own backup.
4. `nodetool refresh <ks> <tbl>` on each node — it picks up the new files without a restart.
5. Run `nodetool repair -pr -full <ks> <tbl>` on every node to reconcile per-node snapshot skew.
6. Verify row counts and spot-check keys at `CONSISTENCY LOCAL_QUORUM`.

**Restoring a whole node (same tokens, rebuilt host).**

1. Install the same Cassandra version; do **not** start it yet.
2. Restore `cassandra.yaml`, `cassandra-rackdc.properties` and the node's original tokens (set `initial_token` to the saved comma-separated list, or restore the `system` keyspace snapshot).
3. Copy the data snapshot into each table's data directory.
4. Start Cassandra. It joins with its original tokens and its restored data.
5. Repair.

**Restoring into a different topology (different node count / tokens).**

1. Create the schema on the target cluster first — `sstableloader` will not create tables.
2. Arrange the SSTables in a directory path ending `<keyspace>/<table>/` — `sstableloader` derives keyspace and table from the directory names.
3. Run `sstableloader -d <target-node-ips> --username ... --password ... /path/to/keyspace/table`.
4. It streams every partition to its correct current owner. Monitor with `nodetool netstats` on the targets.
5. Repair afterwards.

**Point-in-time recovery.**

1. Restore the most recent snapshot **before** the target time.
2. Restore incremental backup SSTables produced between that snapshot and the target time.
3. Place archived commit log segments in `restore_directories`, set `restore_point_in_time=2026:07:22 14:29:00` in `commitlog_archiving.properties`.
4. Start the node; it replays mutations up to that timestamp and stops replaying.
5. Remove `restore_point_in_time` and `restore_command` before the next restart or it will try to replay again.
6. Repair.

```svg
<svg viewBox="0 0 820 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="a30b" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="410" y="20" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">Choosing a Restore Path</text>

  <rect x="300" y="38" width="220" height="46" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="410" y="59" text-anchor="middle" fill="#1e293b" font-weight="700">Has the topology changed?</text>
  <text x="410" y="76" text-anchor="middle" fill="#64748b" font-size="10">node count and tokens</text>

  <line x1="330" y1="84" x2="200" y2="122" stroke="#16a34a" stroke-width="2" marker-end="url(#a30b)"/>
  <text x="238" y="105" text-anchor="middle" fill="#15803d" font-size="11" font-weight="700">no</text>
  <line x1="490" y1="84" x2="620" y2="122" stroke="#d97706" stroke-width="2" marker-end="url(#a30b)"/>
  <text x="582" y="105" text-anchor="middle" fill="#b45309" font-size="11" font-weight="700">yes</text>

  <rect x="70" y="126" width="270" height="70" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="205" y="148" text-anchor="middle" fill="#1e293b" font-weight="700">copy files + nodetool refresh</text>
  <text x="205" y="167" text-anchor="middle" fill="#1e293b" font-size="11">no streaming, node stays up</text>
  <text x="205" y="185" text-anchor="middle" fill="#64748b" font-size="10">fastest path, minutes</text>

  <rect x="480" y="126" width="270" height="70" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="615" y="148" text-anchor="middle" fill="#1e293b" font-weight="700">sstableloader</text>
  <text x="615" y="167" text-anchor="middle" fill="#1e293b" font-size="11">recomputes tokens, streams to owners</text>
  <text x="615" y="185" text-anchor="middle" fill="#64748b" font-size="10">schema must exist first</text>

  <rect x="300" y="222" width="220" height="46" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="410" y="243" text-anchor="middle" fill="#1e293b" font-weight="700">Need a precise instant?</text>
  <text x="410" y="260" text-anchor="middle" fill="#64748b" font-size="10">between snapshots</text>
  <line x1="205" y1="196" x2="330" y2="220" stroke="#475569" marker-end="url(#a30b)"/>
  <line x1="615" y1="196" x2="490" y2="220" stroke="#475569" marker-end="url(#a30b)"/>

  <rect x="140" y="300" width="240" height="76" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="260" y="322" text-anchor="middle" fill="#1e293b" font-weight="700">no</text>
  <text x="260" y="341" text-anchor="middle" fill="#1e293b" font-size="11">snapshot + incremental backups</text>
  <text x="260" y="359" text-anchor="middle" fill="#64748b" font-size="10">then repair</text>

  <rect x="440" y="300" width="240" height="76" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="560" y="322" text-anchor="middle" fill="#1e293b" font-weight="700">yes</text>
  <text x="560" y="341" text-anchor="middle" fill="#1e293b" font-size="11">+ replay archived commit logs</text>
  <text x="560" y="359" text-anchor="middle" fill="#64748b" font-size="10">restore_point_in_time, then repair</text>

  <line x1="370" y1="268" x2="280" y2="296" stroke="#16a34a" marker-end="url(#a30b)"/>
  <line x1="450" y1="268" x2="540" y2="296" stroke="#0ea5e9" marker-end="url(#a30b)"/>
</svg>
```

## 5. Implementation

Enable the backup layers in `cassandra.yaml`:

```yaml
incremental_backups: true          # hard-link every flushed SSTable into <table>/backups/
auto_snapshot: true                # snapshot automatically before TRUNCATE or DROP  (NEVER disable)
snapshot_before_compaction: false  # almost always false; this is a debugging aid
snapshot_links_per_second: 0       # 4.1+: throttle hard-link creation, 0 = unlimited
```

Commit log archiving (`conf/commitlog_archiving.properties`):

```properties
# Run when a commit log segment is recycled
archive_command=/usr/local/bin/archive-cl.sh %path %name

# Used only during a restore
restore_command=cp -f %from %to
restore_directories=/var/lib/cassandra/commitlog_restore
restore_point_in_time=2026:07:22 14:29:00
precision=MICROSECONDS
```

Backup commands:

```bash
# 0. Schema first, always. SSTables without schema are useless.
cqlsh 10.0.1.11 -e "DESCRIBE SCHEMA" > /backup/schema-$(date +%F).cql

# 0b. Save this node's tokens; you need them to restore to identical ownership.
nodetool info -T | grep Token > /backup/tokens-$(hostname)-$(date +%F).txt
cqlsh -e "SELECT host_id, tokens FROM system.local" > /backup/local-$(hostname).txt

# 1. Snapshot one keyspace (flushes memtables first by default)
nodetool snapshot -t nightly-2026-07-22 shop
# Requested creating snapshot(s) for [shop] with snapshot name [nightly-2026-07-22]
# Snapshot directory: nightly-2026-07-22

nodetool listsnapshots
# Snapshot Details:
# Snapshot name        Keyspace name  Column family name  True size  Size on disk
# nightly-2026-07-22   shop           orders              0 bytes    214.75 GiB
# nightly-2026-07-21   shop           orders              18.4 GiB   214.11 GiB
# (True size = blocks NOT shared with the live set, i.e. what clearing it would actually free)

# 2. Ship it. Snapshot dirs live under each table directory.
find /var/lib/cassandra/data/shop -path '*/snapshots/nightly-2026-07-22/*' -type f \
  | tar -czf - -T - \
  | aws s3 cp - s3://cass-backup/prod-eu/$(hostname)/nightly-2026-07-22.tar.gz

# 3. Ship incremental backups continuously, then delete the local hard links.
rsync -a /var/lib/cassandra/data/shop/*/backups/ /staging/incr/ \
  && find /var/lib/cassandra/data/shop/*/backups/ -type f -delete

# 4. Clear the snapshot AFTER verifying the upload.
nodetool clearsnapshot -t nightly-2026-07-22 shop
nodetool clearsnapshot --all          # every snapshot on this node; use with care
```

Restore, same topology, live node:

```bash
# Restore one table from a snapshot on each node
TBL_DIR=/var/lib/cassandra/data/shop/orders-3f2a9c1e4b214f0a9c331a2b3c4d5e6f
cqlsh -e "TRUNCATE shop.orders;"          # auto_snapshot fires here, giving you a safety net
cp /restore/nightly-2026-07-22/shop/orders/* "$TBL_DIR/"
chown -R cassandra:cassandra "$TBL_DIR"
nodetool refresh shop orders
# INFO  ColumnFamilyStore.java - Loading new SSTables for shop/orders...
# INFO  ColumnFamilyStore.java - Loading new SSTables and building secondary indexes...

nodetool repair -pr -full shop orders     # reconcile per-node snapshot skew
cqlsh -e "CONSISTENCY LOCAL_QUORUM; SELECT COUNT(*) FROM shop.orders WHERE customer_id = ...;"
```

Restore into a different topology with `sstableloader`:

```bash
# Schema must already exist on the target cluster
cqlsh 10.9.1.11 -f /backup/schema-2026-07-22.cql

# Directory path must end in <keyspace>/<table>/ -- the loader derives names from it
mkdir -p /restore/shop/orders && cp /backup/nightly/*/shop/orders/* /restore/shop/orders/

sstableloader -d 10.9.1.11,10.9.1.12,10.9.1.13 \
  --username cassandra --password '***' \
  -f /etc/cassandra/cassandra.yaml \
  --throttle 200 \
  /restore/shop/orders
# Established connection to initial hosts
# Opening sstables and calculating sections to stream
# Streaming relevant part of nb-88-big-Data.db nb-91-big-Data.db to
#   [10.9.1.11, 10.9.1.12, 10.9.1.13]
# progress: total: 100% 0.000KiB/s (avg: 148.221MiB/s)
# Summary statistics:
#    Connections per host    : 1
#    Total files transferred : 42
#    Total bytes transferred : 214.75 GiB
#    Total duration          : 1483221 ms

nodetool repair -pr -full shop orders   # on every node of the target cluster
```

Point-in-time recovery:

```bash
# 1. Restore the snapshot taken before the incident + the incremental SSTables after it
# 2. Stage archived commit logs
mkdir -p /var/lib/cassandra/commitlog_restore
aws s3 sync s3://cass-backup/prod-eu/$(hostname)/commitlog/ /var/lib/cassandra/commitlog_restore/

# 3. Set restore_point_in_time in commitlog_archiving.properties, then start
systemctl start cassandra
grep -i 'Replaying\|restore_point' /var/log/cassandra/system.log
# INFO  CommitLogArchiver.java - Will restore from ... up to 2026:07:22 14:29:00
# INFO  CommitLogReplayer.java - Replayed 41209 mutations, stopped at restore point

# 4. IMPORTANT: clear restore_command / restore_point_in_time before the next restart.
```

Verify a backup is actually restorable (the part everyone skips):

```python
import subprocess, hashlib, json
from cassandra.cluster import Cluster

# Restore into a scratch cluster, then compare canary rows against production
prod = Cluster(["10.0.1.11"]).connect("shop")
test = Cluster(["10.9.1.11"]).connect("shop")

CANARY_KEYS = json.load(open("/backup/canary-keys.json"))
mismatch = 0
for k in CANARY_KEYS:
    p = prod.execute("SELECT * FROM orders WHERE customer_id=%s", (k,)).all()
    t = test.execute("SELECT * FROM orders WHERE customer_id=%s", (k,)).all()
    if [tuple(r) for r in p] != [tuple(r) for r in t]:
        mismatch += 1
print(f"canaries checked={len(CANARY_KEYS)} mismatches={mismatch}")
# canaries checked=5000 mismatches=0
```

> **Optimization:** the expensive part of Cassandra backup is never the snapshot — it is the **upload and the storage**. Two levers dominate. First, ship **incremental backups continuously** and take full snapshots rarely (weekly rather than nightly): because SSTables are immutable and content-addressed by filename, an object-storage sync with deduplication uploads each SSTable exactly once for its lifetime. Second, snapshot and upload **one node at a time per rack**, throttled, so backup I/O never coincides with compaction spikes or repair on the same node. Also set `snapshot_links_per_second` (4.1+) on nodes with very many SSTables — creating a hundred thousand hard links at once can stall the filesystem. And always `clearsnapshot` after verified upload: `True size` in `nodetool listsnapshots` tells you exactly how much disk each stale snapshot is holding hostage.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost/Trade-off |
|---|---|---|
| Snapshots (hard links) | Instant, initially zero disk, no impact on serving | Pin old blocks as compaction proceeds — a forgotten snapshot can consume the full dataset |
| `auto_snapshot: true` | Automatic safety net before `TRUNCATE`/`DROP`; has saved countless clusters | Disk consumed silently after every truncate; you must clear these too |
| Incremental backups | Small deltas between snapshots; cheap continuous RPO improvement | Cassandra **never** cleans `backups/`; unmanaged, it fills the disk |
| Commit log archiving | True second-granularity PITR | An external command on the hot path of segment recycling; storage grows fast; PITR is cluster-wide, not per-table |
| `nodetool refresh` | Restore without restart or streaming; minutes not hours | Only valid when tokens are unchanged and files belong to this node |
| `sstableloader` | Topology-independent; the only sane cross-cluster restore | Full re-ingest via streaming — slow; schema must pre-exist; heavy load on targets |
| Per-node snapshots | No coordination cost, no cluster-wide pause | Not cluster-consistent; a full restore always needs a repair afterwards |
| Object storage offsite | Survives whole-DC and whole-cluster loss | Egress and restore time; encryption and access control become your problem |
| Medusa / Priam | Orchestrates cluster-wide snapshot, upload, manifest and restore | Another component to operate; version coupling with Cassandra |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Treating `RF=3` as a backup.** → ✅ Replication protects against hardware failure, not against `TRUNCATE`, a bad migration, or a buggy deploy — those replicate to every replica instantly. You need backups for logical corruption.
2. ⚠️ **Never testing a restore.** → ✅ An untested backup is a hypothesis. Rehearse a full restore into a scratch cluster at least quarterly, time it, and record the actual RTO. Most first-time restores fail on something trivial: missing schema, wrong file ownership, or a version mismatch.
3. ⚠️ **Backing up SSTables but not the schema.** → ✅ SSTables are meaningless without their exact table definitions (including compaction, compression and clustering order). `DESCRIBE SCHEMA` into version control with every backup.
4. ⚠️ **Forgetting `nodetool clearsnapshot`.** → ✅ Snapshots pin blocks that compaction would otherwise free. This is a leading cause of disk-full incidents. Alert on `Space used by snapshots` and use `nodetool listsnapshots` `True size` to see the real cost.
5. ⚠️ **Enabling `incremental_backups` and never cleaning `backups/`.** → ✅ Cassandra never removes those hard links. Your pipeline must ship them and then delete them, or the directory grows until the disk is full.
6. ⚠️ **Disabling `auto_snapshot` to "save disk".** → ✅ It is the last line of defence against an accidental `TRUNCATE` or `DROP TABLE`. Keep it on and clean the resulting snapshots on a schedule instead.
7. ⚠️ **Copying SSTables between nodes by hand and expecting the data to appear.** → ✅ SSTables are token-range specific. Files from node A dropped onto node B contain partitions B does not own and will simply never be read. Use `sstableloader` for anything cross-node.
8. ⚠️ **Restoring without a repair afterwards.** → ✅ Per-node snapshots are not cluster-consistent, so restored replicas diverge at the edges. A full repair after any cluster-wide restore is mandatory.
9. ⚠️ **Leaving `restore_point_in_time` set after a PITR.** → ✅ The next restart will try to replay again, potentially reverting data. Clear `restore_command` and `restore_point_in_time` from `commitlog_archiving.properties` as the final step of the procedure.
10. ⚠️ **Restoring a snapshot older than `gc_grace_seconds`.** → ✅ Tombstones in it may already have been purged elsewhere, so restoring resurrects deleted data. Either restore the whole cluster consistently to that point, or accept that you are reintroducing deletes and audit for it.
11. ⚠️ **Running `nodetool snapshot` across all nodes simultaneously on a large cluster.** → ✅ Snapshot flushes memtables; a fleet-wide simultaneous flush plus the ensuing compaction wave is a self-inflicted latency incident. Stagger by rack.
12. ⚠️ **Storing backups in the same region/account as the cluster.** → ✅ A compromised account or a regional outage takes both. Use a separate account with write-only (append) credentials and object-lock retention so ransomware cannot delete your backups.
13. ⚠️ **Restoring a node without restoring its tokens.** → ✅ It will pick new random tokens, own different ranges, and the restored SSTables will contain data it does not own. Save `nodetool info -T` output alongside every backup.
14. ⚠️ **Assuming `sstableloader` creates tables.** → ✅ It does not. Apply the schema to the target cluster first, or the load fails immediately.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** The failures cluster into a few shapes. *Disk full after backups were "working fine"* — check `nodetool listsnapshots` `True size` and `Space used by snapshots` in `nodetool tablestats`, plus the size of every `backups/` directory; almost always a snapshot or incremental cleanup step that silently stopped. *`nodetool refresh` did nothing* — check file ownership (`cassandra:cassandra`) and permissions, check the files landed in the correct table directory including the UUID suffix (table directory names change on `DROP`/`CREATE`), and check `system.log` for `Loading new SSTables`. *`sstableloader` fails immediately* — schema missing on the target, directory path not ending in `<keyspace>/<table>`, or authentication not passed via `--username`/`--password`. *PITR replayed nothing* — `restore_directories` wrong, timestamp format wrong (`yyyy:MM:dd HH:mm:ss`), or the segments predate the snapshot you restored.

**Monitoring.** What to alert on:
- `org.apache.cassandra.metrics:type=Table,keyspace=*,scope=*,name=SnapshotsSize` — snapshot disk consumption per table. Page when it exceeds a threshold fraction of the volume.
- Filesystem free percentage per data volume — the ultimate guardrail.
- **Backup age** per node: the timestamp of the newest successfully uploaded artefact. Alert if it exceeds 1.5× the intended interval. Many teams monitor the backup *job* and not the backup *artefact*, and only discover the difference during an incident.
- **Restore rehearsal age**: days since the last successful test restore. Treat above 90 days as a ticket.
- Size of every `<table>/backups/` directory (incremental backups not yet shipped).
- Object-storage upload success rate and bytes, plus a checksum-verification pass rate.
- `nodetool tablestats` `Space used (total)` vs `(live)` — a persistent gap points at snapshots or un-compacted garbage.

**Security.** Backups are a full, unencrypted copy of your production data sitting outside the database's access controls — for many organisations they are the highest-risk data asset they own. Requirements: encrypt at rest in object storage (SSE-KMS or client-side), encrypt in transit, and use a **separate account or project** with append-only credentials plus object-lock/versioning so a compromised cluster credential cannot delete backup history. Note that Cassandra's own role-based access control does not apply to SSTables — anyone with the files has everything, including data in tables they could never have queried. If you use commit log archiving, the archived segments contain raw mutations and need identical protection. Finally, restoring into a scratch cluster for testing recreates a production-grade dataset in a lower environment: either mask it or apply production-equivalent controls to the test cluster.

**Performance & Scaling.** Snapshot creation is O(number of SSTable components) hard links — fast, but on a node with 100k SSTables it can stall the filesystem, which is why `snapshot_links_per_second` exists in 4.1+. The scaling bottleneck is **upload bandwidth and object count**, not Cassandra. Practical patterns: continuous incremental shipping plus weekly full snapshots; parallel upload capped so it does not compete with client traffic; stagger snapshots by rack rather than fleet-wide. Restore RTO is dominated by download plus, for `sstableloader`, streaming: budget roughly the same wall-clock as a bootstrap of the same data volume, and use `--throttle` to protect the target cluster. For very large clusters, restoring node-by-node with `RF=3` lets the cluster keep serving throughout — which means your realistic RTO for a partial loss is much better than for a total loss, and your DR plan should state both numbers separately.

## 9. Interview Questions

**Q: How does a Cassandra snapshot work, and why is it nearly instantaneous?**
A: `nodetool snapshot` flushes memtables and then creates hard links to every live SSTable file under `snapshots/<tag>/`. Because SSTables are immutable, a hard link is a complete and stable copy — no data is read or written. Creation therefore costs a few hundred inodes and essentially zero disk blocks.

**Q: If snapshots are free, why do they cause disk-full incidents?**
A: They are free only at creation. As compaction merges and unlinks the original SSTables, the snapshot's hard links keep those blocks alive, so a snapshot's real disk cost grows over time toward the full dataset size at the moment it was taken. `nodetool listsnapshots` reports `True size` — the blocks not shared with the live set — which is what clearing it would actually free.

**Q: Is a Cassandra snapshot cluster-consistent?**
A: No. `nodetool snapshot` is a per-node operation with no distributed barrier, so nodes snapshot at slightly different instants. A cluster-wide restore therefore yields replicas that disagree at the edges. The restored cluster is still correct under last-write-wins, but a full repair after restore is mandatory.

**Q: What is the difference between a snapshot and an incremental backup?**
A: A snapshot is a full point-in-time set of hard links to all current SSTables. Incremental backups (`incremental_backups: true`) hard-link each newly flushed SSTable into `<table>/backups/` as it is created, giving you just the deltas since the last snapshot. Snapshots are taken on demand; incremental backups are continuous — and Cassandra never cleans them up, so your pipeline must.

**Q: When do you use `nodetool refresh` versus `sstableloader`?**
A: `nodetool refresh` when the topology is unchanged and the SSTables belong to that node's token ranges — you drop the files into the table directory and the running node picks them up with no streaming. `sstableloader` when the topology has changed (different node count or tokens) or you are restoring into a different cluster — it recomputes each partition's token and streams rows to their correct current owners.

**Q: What does `auto_snapshot` do and should you ever disable it?**
A: When `true` (the default), Cassandra automatically takes a snapshot before a `TRUNCATE` or `DROP` of a table. It is the last line of defence against the single most common catastrophic human error. Never disable it; instead manage the resulting snapshots with a cleanup schedule.

**Q: How do you achieve point-in-time recovery in Cassandra?**
A: Restore the most recent snapshot before the target time, add the incremental backup SSTables produced after it, then replay archived commit log segments with `restore_directories` and `restore_point_in_time` set in `commitlog_archiving.properties`. Because commit log segments carry mutations for all tables, PITR is inherently keyspace/cluster-wide rather than per-table, and you must clear the restore settings afterwards.

**Q: (Senior) Design a backup strategy for a 40-node, 1 TB-per-node cluster with an RPO of 15 minutes and RTO of 4 hours.**
A: Layer it. Weekly full snapshots staggered one rack at a time, shipped to object storage in a separate account with object-lock. Continuous incremental backups — every flushed SSTable hard-linked and shipped, then deleted locally — which given typical flush intervals lands the RPO around a few minutes for flushed data. Commit log archiving on top to close the gap for unflushed mutations and hit a true 15-minute (in practice near-real-time) RPO. Back up schema and per-node tokens with every cycle, and store a manifest mapping node host-id to tokens to backup prefix. For RTO: 4 hours across 40 TB means the restore must be parallel and must avoid `sstableloader` where possible — so the plan is same-topology restore with `nodetool refresh`, nodes restored in parallel across racks while `RF=3` keeps the cluster serving, then a repair that may extend past the 4 hours but does not block availability. Critically, rehearse it quarterly and measure; an RTO you have never timed is a number in a document, not a capability.

**Q: (Senior) You restore a two-week-old snapshot into a cluster with `gc_grace_seconds = 864000`. What goes wrong?**
A: Deleted data resurrects. The snapshot is older than the 10-day grace window, so tombstones that existed at snapshot time may already have been purged from the live cluster by compaction, and rows deleted *after* the snapshot exist as live data in the restored files. Merging restored SSTables into a live cluster therefore reintroduces deletes that everyone considered permanent — and if the deletes were compliance-driven (a GDPR erasure), you have just recreated a legal problem. The safe procedures are: restore the *entire* cluster to that point rather than merging into live data; or restore into an isolated scratch cluster, extract only the specific rows you need, and write them back with current timestamps; or re-apply the known deletion set after the restore. This is also the argument for keeping an auditable log of erasure requests independent of the database.

**Q: (Senior) Walk through recovering from an accidental `TRUNCATE shop.orders` on production.**
A: First, stop writes to the table if the application can tolerate it, and do not restart any node — memtable and cache state is irrelevant here but a restart adds risk. Second, check `nodetool listsnapshots` on every node: with `auto_snapshot: true` Cassandra took a snapshot *of the truncated data* immediately before the truncate, on every node, tagged with a timestamp. That is your restore source, and it is per-node and token-correct, which is the ideal case. Third, on each node copy that snapshot's SSTables back into the table's data directory (watch the directory UUID — truncate does not change it, but a drop-and-recreate would), fix ownership, and run `nodetool refresh shop orders`. Fourth, run `nodetool repair -pr -full shop orders` on every node to reconcile the per-node skew. Fifth, validate with canary keys and row counts at `LOCAL_QUORUM`. Finally, the post-mortem action: `TRUNCATE` requires no special privilege beyond `MODIFY` on the table, so the durable fix is removing that grant from application roles and routing destructive DDL through an audited pipeline, plus enabling the 4.0 audit log so you know who ran it.

**Q: (Senior) Why is `sstableloader` the only correct tool for restoring into a resized cluster, and what does it cost?**
A: SSTables are partitioned by token: a file from a 12-node cluster contains exactly the partitions that node owned under the old ring. Dropping those files onto a node in a 20-node cluster gives it partitions it does not own — the read path computes ownership from the ring, not from disk, so that data is simply never returned, and it also will not be repaired or compacted away meaningfully. `sstableloader` opens each SSTable, computes each partition's token, consults the live ring via a connection to the target cluster, and streams each partition to its correct current replicas. The cost is that it is a full re-ingest through the streaming path: expect wall-clock comparable to bootstrapping the same data volume, significant load on the target nodes (use `--throttle`), and a compaction wave afterwards. The schema must already exist because the loader does not create tables.

**Q: What must you back up besides the SSTables?**
A: The schema (`DESCRIBE SCHEMA`, in version control), each node's token assignments (`nodetool info -T` or `system.local`), the topology mapping of host IDs to DC/rack, and the relevant configuration files (`cassandra.yaml`, `cassandra-rackdc.properties`). Without schema the SSTables cannot be interpreted; without tokens you cannot restore a node to the same ownership and must fall back to the much slower `sstableloader` path.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Replication is not backup — it replicates your `TRUNCATE` perfectly. Because SSTables are immutable, a **snapshot** is just hard links (`nodetool snapshot -t tag ks`): instant, zero bytes at creation, but it pins blocks as compaction unlinks the originals, so forgotten snapshots fill disks — watch `True size` in `nodetool listsnapshots` and always `clearsnapshot` after a verified upload. **Incremental backups** (`incremental_backups: true`) hard-link every newly flushed SSTable into `<table>/backups/`; Cassandra never cleans them, so your pipeline must ship and delete. **Commit log archiving** gives true second-granularity PITR via `restore_directories` + `restore_point_in_time` — and clear those settings afterwards. Snapshots are **per-node, not cluster-consistent**, so any cluster-wide restore needs a **full repair**. Restore path: same topology → copy files + `nodetool refresh` (fast, no streaming); different topology → `sstableloader` (schema must exist first). Always back up the **schema and tokens** too. Keep `auto_snapshot: true` — it is what saves you after an accidental `TRUNCATE`. And rehearse the restore, because an untested backup is a hypothesis.

| Item | Command / Setting | Note |
|---|---|---|
| Take a snapshot | `nodetool snapshot -t TAG ks` | Flushes first; `-sf` to skip flush |
| List snapshots | `nodetool listsnapshots` | `True size` = what clearing frees |
| Clear snapshots | `nodetool clearsnapshot -t TAG ks` / `--all` | After verified upload |
| Incremental backups | `incremental_backups: true` | Files in `<table>/backups/`, never auto-cleaned |
| Auto snapshot on truncate | `auto_snapshot: true` (default) | **Never disable** |
| Hard-link throttle (4.1+) | `snapshot_links_per_second` | 0 = unlimited |
| Commit log archive | `commitlog_archiving.properties` → `archive_command` | `%path`, `%name` substitution |
| PITR replay | `restore_directories` + `restore_point_in_time` | Format `yyyy:MM:dd HH:mm:ss` |
| Same-topology restore | copy files → `nodetool refresh ks tbl` | No restart, no streaming |
| Cross-topology restore | `sstableloader -d ips /path/ks/tbl` | Schema must pre-exist; `--throttle` |
| Schema backup | `cqlsh -e "DESCRIBE SCHEMA"` | Version control it |
| Token backup | `nodetool info -T` / `system.local` | Needed for same-token restore |
| After any restore | `nodetool repair -pr -full ks tbl` | Snapshots are not cluster-consistent |
| Alert on | `Space used by snapshots`, backup artefact age | Not just job exit codes |

**Flash cards**
- **Why is a snapshot instant?** → SSTables are immutable, so it is just hard links — no data is copied.
- **Why do snapshots eventually cost disk?** → Compaction unlinks the originals but the snapshot's links keep those blocks alive.
- **`refresh` or `sstableloader`?** → `refresh` when tokens are unchanged and the files belong to that node; `sstableloader` when topology changed or you are loading into another cluster.
- **What must follow a cluster-wide restore?** → A full repair — per-node snapshots are not cluster-consistent.
- **What besides SSTables must be backed up?** → The schema and each node's tokens; without them the files are uninterpretable or unplaceable.

## 11. Hands-On Exercises & Mini Project

- [ ] On a `ccm` cluster, load 1 GB into `shop.orders`, run `nodetool snapshot -t t1 shop`, and confirm with `du -sh` and `df` that disk usage barely changed. Inspect the snapshot directory and verify with `ls -li` that the inode numbers match the live SSTables.
- [ ] Write another 2 GB, force compaction (`nodetool compact shop orders`), then re-run `nodetool listsnapshots` and compare `True size` before and after. Explain exactly why it grew.
- [ ] Enable `incremental_backups: true`, write data, flush repeatedly, and watch `<table>/backups/` accumulate. Write a small script that ships and then deletes those files, and verify Cassandra never removes them on its own.
- [ ] Practise the truncate recovery: `TRUNCATE shop.orders`, find the `auto_snapshot` directory, restore it with `nodetool refresh`, run a repair, and verify row counts at `LOCAL_QUORUM`. Time the whole procedure.
- [ ] Restore into a *different* topology: build a second `ccm` cluster with a different node count, apply the schema, and load the same snapshot with `sstableloader`. Compare wall-clock time and streamed bytes against the `refresh` path.
- [ ] Configure commit log archiving with a script that copies segments to a directory. Write rows, note the wall-clock time, write more rows, then restore the earlier snapshot plus commit logs with `restore_point_in_time` set between the two batches — verify only the first batch is present.

### Mini Project — Backup & Restore Verification Harness

**Goal.** Turn "we have backups" into "we have a measured, continuously verified RPO and RTO".

**Requirements.**
1. **Backup driver**: for each node, back up schema (`DESCRIBE SCHEMA`), tokens (`system.local`), and a `nodetool snapshot`; upload to object storage under `cluster/host-id/tag/`, write a JSON manifest (cluster name, host id, tokens, schema hash, file list with checksums, timestamp), then `clearsnapshot`.
2. **Incremental shipper**: a loop that syncs each `<table>/backups/` directory to object storage and deletes the local hard links only after a verified checksum.
3. **Verifier**: nightly, spin up a scratch cluster, apply the backed-up schema, restore the latest artefacts (choosing `refresh` or `sstableloader` based on whether the scratch topology matches), and compare a canary key set plus per-table row counts against production. Emit `restore_verified_timestamp` and `restore_duration_seconds` as metrics.
4. **Dashboard/alerts**: backup artefact age per node, snapshot disk consumption, days since last verified restore, measured RTO trend.
5. **Runbook generator**: emit a Markdown restore runbook from the manifest with the exact commands and file paths for this cluster's current topology.

**Extensions.**
- Add PITR: archive commit logs, and have the verifier restore to a random timestamp in the last 24 h and assert that a row written after that timestamp is absent while one written before is present. That is the only real proof PITR works.
- Add deduplicating upload keyed on SSTable filename plus checksum so each immutable file is stored exactly once for its lifetime, and report the storage saving.
- Add a chaos mode that deletes a random node's data directory and drives the full node-restore procedure end to end, measuring RTO with the cluster still serving at `RF=3`.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Storage Engine & SSTable Format* (ch. 26) explains the immutability that makes hard-link snapshots possible; *nodetool & Everyday Cluster Operations* (ch. 27) covers `snapshot`, `listsnapshots` and `refresh` in context; *Adding, Removing & Replacing Nodes* (ch. 28) covers the token-preservation issues a restore shares; *Repair* (ch. 29) is the mandatory post-restore step; *Tombstones & Deletes* explains why restoring an old snapshot resurrects deleted data; *Security: Authentication, Authorization & Encryption* covers protecting the backup artefacts.

- **Apache Cassandra Docs — Backups** — Apache Software Foundation · *Intermediate* · the authoritative reference for snapshots, incremental backups and commit log archiving. <https://cassandra.apache.org/doc/latest/cassandra/managing/operating/backups.html>
- **Apache Cassandra Docs — sstableloader (bulk loading)** — Apache Software Foundation · *Advanced* · every flag, the directory-naming requirement, and throttling. <https://cassandra.apache.org/doc/latest/cassandra/managing/tools/sstable/sstableloader.html>
- **Cassandra Medusa** — K8ssandra / The Last Pickle (open source) · *Intermediate* · a production backup and restore tool for Cassandra with object-storage backends; read its restore logic as a reference implementation. <https://github.com/thelastpickle/cassandra-medusa>
- **Netflix Priam** — Netflix OSS · *Advanced* · long-running backup/restore and token-management sidecar; the docs explain cluster-wide snapshot coordination and S3 layout. <https://github.com/Netflix/Priam>
- **DataStax Docs — Backing up and restoring data** — DataStax · *Intermediate* · clear step-by-step restore procedures including the different-topology case. <https://docs.datastax.com/en/cassandra-oss/3.x/cassandra/operations/opsBackupRestore.html>
- **The Last Pickle — Cassandra backup and restore posts** — TLP · *Advanced* · practitioner treatment of snapshot cost, incremental backup management and restore pitfalls. <https://thelastpickle.com/blog/>
- **Apache Cassandra Docs — Commit log archiving configuration** — Apache Software Foundation · *Advanced* · the exact `commitlog_archiving.properties` semantics for point-in-time recovery. <https://cassandra.apache.org/doc/latest/cassandra/managing/configuration/index.html>
- **Cassandra Summit / ApacheCon — disaster recovery talks** — Apache Software Foundation (YouTube) · *Advanced* · real teams describing restores they actually performed and what broke. <https://www.youtube.com/@PlanetCassandra>

---

*Apache Cassandra Handbook — chapter 30.*
