# 33 · Upgrades & Rolling Restarts

> **In one line:** Cassandra upgrades are zero-downtime only if you respect three rules — one node at a time, never repair or stream while versions are mixed, and finish `upgradesstables` before you even think about the next hop.

---

## 1. Overview

Every distributed database claims online upgrades; Cassandra actually delivers them, because it was designed with no master, no leader election, and a wire protocol that negotiates a common version between peers. A node can be stopped, replaced with a newer binary, and restarted while the other replicas keep serving reads and writes at `LOCAL_QUORUM`. Do that node by node and you have moved a 200-node cluster from 3.11 to 4.1 without a maintenance window. That is the theory. In practice, upgrades are the single most common source of self-inflicted Cassandra outages, and almost always for the same reasons: someone repaired during a mixed-version window, someone bootstrapped a node mid-upgrade, or someone skipped a required intermediate version.

The problem upgrades solve is obvious — security fixes, performance, and features (4.0 brought virtual tables, audit logging, full-query logging and a rewritten internode messaging layer; 5.0 brought Storage-Attached Indexes, vector search, Trie memtables and the `BTI` SSTable format). The problem upgrades *create* is a temporary heterogeneous cluster where nodes disagree about SSTable formats, streaming protocols, gossip fields and schema representations. Cassandra handles that disagreement by negotiating down to the older behaviour, but only for the subset of operations it knows how to negotiate. Streaming and repair are explicitly outside that subset.

The historical motivation is worth knowing. Before 2.0, upgrades often required a full-cluster stop because SSTable formats and gossip states changed incompatibly. The project's answer was the **SSTable format version letter** (`ma`, `mb`, `mc` for 3.x's "m" family, `na`/`nb` for 4.x's "n" family, `oa` in 5.0, plus the new `BTI` big-trie-indexed format) plus a rule that a release can *read* the previous major's format but writes only its own. That is precisely why `nodetool upgradesstables` exists: to rewrite the old format so the next upgrade, which may not be able to read two generations back, still works.

A concrete example. A payments cluster of 90 nodes across three DCs upgraded 3.11.13 → 4.0.11. The team upgraded one DC per night, one rack at a time, three nodes concurrently within a rack. Total elapsed: three nights for binaries. Then `nodetool upgradesstables` ran for eleven days at throttled compaction throughput, because 40 TB of `mc`-format SSTables had to be rewritten to `nb`. The cluster served production traffic throughout. The one incident: an automated Reaper repair schedule that nobody disabled fired on night two and caused streaming failures between a 3.11 and a 4.0 node, producing a two-hour incident. That is the canonical Cassandra upgrade story.

The mental model: **an upgrade has three independent phases with different durations — binary rollout (hours), mixed-version window (must be as short as possible), and SSTable rewrite (days).** The dangerous phase is the middle one, and everything in the runbook exists to shorten it or to forbid operations during it.

## 2. Core Concepts

- **Rolling upgrade** — replacing binaries one node (or one rack) at a time so a quorum of every replica set stays available throughout.
- **Mixed-version cluster** — the interval during which nodes run different major/minor versions; gossip and messaging negotiate the lower protocol, but streaming and repair are unsupported.
- **SSTable format version** — a two-letter code in the filename (`nb-1234-big-Data.db`); a release writes only its own format and can read the immediately preceding family.
- **`nodetool upgradesstables`** — rewrites SSTables into the current node's format; safe to run concurrently with traffic, throttled by compaction throughput.
- **`nodetool drain`** — flushes memtables to disk and stops accepting writes, so the commit log is empty and restart is fast and replay-free. Always the last step before stopping a node.
- **Upgrade path** — the supported sequence of versions; you cannot jump 3.0 → 5.0 directly, and skipping a required intermediate leaves unreadable SSTables.
- **`disable_auto_snapshot` / `nodetool snapshot`** — a snapshot is hard-linked, near-instant, and is your rollback for data; take one before the first node is touched.
- **Native protocol version** — the client-facing CQL protocol (v4 in 3.x, v5 in 4.0+); drivers negotiate down, but pinning a version avoids surprises mid-upgrade.
- **`gossip` state / `nodetool disablegossip`** — used with `disablebinary` and `disablethrift` (pre-4.0) to gracefully take a node out of rotation before stopping.
- **Downgrade** — not supported once SSTables are written in the new format; rollback means restoring snapshots or replacing nodes from a healthy DC.

## 3. Theory & Internals

The reason a rolling upgrade works at all is **version-negotiated internode messaging**. Each node advertises its `MessagingService.current_version` in gossip (`NET_VERSION` application state). When node A opens a connection to node B, it uses `min(A.version, B.version)` for the wire format, and serialisation code carries explicit branches for older versions. Cassandra 4.0 rewrote the messaging layer onto Netty with a new framing and checksummed frames, but retained the 3.x serialisers behind version checks precisely so 3.11↔4.0 traffic works. This negotiation covers ordinary reads, writes, digest requests, and gossip. It does **not** cover streaming.

Streaming — used by bootstrap, decommission, `rebuild`, `removenode` and repair — transfers SSTable-derived data structures, not logical rows, and in 4.0 it was reimplemented (zero-copy streaming, "ZCS", CASSANDRA-14556) with a different session protocol. Cross-version streaming is therefore explicitly unsupported. A repair session started in a mixed cluster typically fails with `Unknown stream version` or silently produces a validation mismatch storm; worse, an anticompaction triggered by incremental repair can mark SSTables repaired on some replicas and not others, leaving a persistent inconsistency that survives the upgrade. The rule "no repair, no bootstrap, no decommission during a mixed-version window" is not conservatism — it is a hard constraint.

SSTable format compatibility is a two-generation window in practice. A 4.x node reads the `m*` family (3.x) and writes `n*`. A 5.0 node reads `n*` and writes `oa` (or `da`/BTI if configured). It does **not** reliably read `m*`. So an unfinished `upgradesstables` after a 3.11 → 4.0 upgrade becomes a hard blocker for 4.0 → 5.0: you must complete the rewrite before the next hop. The cost is real — rewriting is a full read-and-write of your entire dataset, so at 40 TB per DC with compaction throttled to 64 MB/s per node you can compute the duration directly: `40 TB / (nodes × throughput)`. With 30 nodes at 64 MB/s that is roughly 5.8 hours of pure I/O per node's share, but real clusters see days because throughput is shared with normal compaction and you throttle to protect latency.

Schema changes deserve their own rule. Schema propagates via gossip as a `MigrationManager` push, and different versions may serialise schema tables differently — 4.0 moved schema from `system_schema` handling that 3.x wrote to a new representation and introduced schema-version reconciliation changes (and 4.1 added CEP-21-adjacent hardening). If a DDL statement executes while nodes disagree, you can end up with permanently divergent schema UUIDs, visible as multiple entries in `nodetool describecluster`. **No DDL during an upgrade** is therefore rule number two.

```svg
<svg viewBox="0 0 780 350" width="100%" height="350" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="780" height="350" fill="#ffffff"/>
  <defs><marker id="a33" markerWidth="9" markerHeight="9" refX="8" refY="4" orient="auto"><path d="M0 0 L9 4 L0 8 z" fill="#1e293b"/></marker></defs>
  <text x="20" y="26" font-size="15" font-weight="700" fill="#1e293b">What is safe and what is forbidden in a mixed-version cluster</text>
  <rect x="20" y="46" width="360" height="150" rx="12" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="200" y="70" font-size="13" font-weight="700" fill="#1e293b" text-anchor="middle">Version-negotiated: SAFE</text>
  <text x="40" y="94" font-size="11" fill="#1e293b">Reads and writes at any consistency level</text>
  <text x="40" y="114" font-size="11" fill="#1e293b">Digest requests and blocking read repair</text>
  <text x="40" y="134" font-size="11" fill="#1e293b">Gossip, failure detection, hinted handoff</text>
  <text x="40" y="154" font-size="11" fill="#1e293b">Client CQL via negotiated native protocol</text>
  <text x="40" y="174" font-size="11" fill="#1e293b">nodetool flush, drain, compact, upgradesstables</text>
  <rect x="400" y="46" width="360" height="150" rx="12" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="580" y="70" font-size="13" font-weight="700" fill="#1e293b" text-anchor="middle">Streaming or schema: FORBIDDEN</text>
  <text x="420" y="94" font-size="11" fill="#1e293b">nodetool repair (any mode, incremental worst)</text>
  <text x="420" y="114" font-size="11" fill="#1e293b">bootstrap a new node, decommission, removenode</text>
  <text x="420" y="134" font-size="11" fill="#1e293b">nodetool rebuild, replace_address</text>
  <text x="420" y="154" font-size="11" fill="#1e293b">CREATE / ALTER / DROP anything (DDL)</text>
  <text x="420" y="174" font-size="11" fill="#1e293b">Materialized view or index creation</text>
  <text x="20" y="228" font-size="13" font-weight="700" fill="#1e293b">SSTable format lineage: why upgradesstables is not optional</text>
  <rect x="20" y="244" width="160" height="52" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="100" y="266" font-size="12" font-weight="700" fill="#1e293b" text-anchor="middle">3.11 writes mc</text>
  <text x="100" y="284" font-size="10" fill="#1e293b" text-anchor="middle">m family</text>
  <rect x="230" y="244" width="160" height="52" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="310" y="266" font-size="12" font-weight="700" fill="#1e293b" text-anchor="middle">4.0/4.1 writes nb</text>
  <text x="310" y="284" font-size="10" fill="#1e293b" text-anchor="middle">reads m, writes n</text>
  <rect x="440" y="244" width="160" height="52" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="520" y="266" font-size="12" font-weight="700" fill="#1e293b" text-anchor="middle">5.0 writes oa / BTI</text>
  <text x="520" y="284" font-size="10" fill="#1e293b" text-anchor="middle">reads n, not m</text>
  <path d="M182 270 L226 270" stroke="#1e293b" stroke-width="2" marker-end="url(#a33)"/>
  <path d="M392 270 L436 270" stroke="#1e293b" stroke-width="2" marker-end="url(#a33)"/>
  <rect x="620" y="238" width="140" height="64" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="690" y="262" font-size="11" font-weight="700" fill="#1e293b" text-anchor="middle">leftover mc files</text>
  <text x="690" y="280" font-size="10" fill="#1e293b" text-anchor="middle">block the 4 to 5 hop</text>
  <text x="690" y="295" font-size="10" fill="#1e293b" text-anchor="middle">startup fails</text>
  <text x="20" y="326" font-size="12" fill="#1e293b">Rule: complete nodetool upgradesstables on every node before starting the next major upgrade.</text>
  <text x="20" y="344" font-size="12" fill="#1e293b">Verify with: ls data/ks/tbl/*-Data.db | grep -c '^mc' equals zero on every node.</text>
</svg>
```

## 4. Architecture & Workflow

The per-node sequence, and the cluster-level ordering around it:

1. **Pre-flight the whole cluster.** `nodetool status` shows all nodes `UN`; `nodetool describecluster` shows exactly one schema version; no compactions backlogged; disk free ≥ 50% on every node (`upgradesstables` needs headroom); `nodetool netstats` shows no streams.
2. **Disable automation.** Stop Reaper or cron repairs, disable auto-scaling or node-replacement automation, freeze DDL deploys, and pause any job that bootstraps nodes.
3. **Snapshot.** `nodetool snapshot -t pre-upgrade-4.1` on every node. Hard links cost nothing until compaction removes the originals; note that snapshots do pin disk space, so plan for it.
4. **Take one node out of rotation.** `nodetool disablebinary` (clients stop connecting to it) then `nodetool disablegossip` is optional but makes the transition cleaner; then `nodetool drain` to flush memtables and seal the commit log.
5. **Stop, upgrade, merge config.** Stop the service. Install the new package. **Do not** let the package manager overwrite `cassandra.yaml` — diff the new default against yours; 4.0 renamed many settings to unit-suffixed forms (`read_request_timeout: 5000ms`), and 4.1/5.0 continued that. Merge deliberately.
6. **Start and verify.** Start the node; watch `system.log` for `Startup complete`; confirm `nodetool version`, then `nodetool status` from *another* node shows it `UN`. Check `ClientRequest` latency has recovered before moving on.
7. **Repeat** for the next node. Order matters: within a DC go rack by rack (never two nodes of the same replica set at once); across DCs, upgrade the DC with least traffic first, or your DR DC first so you can fail back if something is wrong.
8. **After every node is on the new version**, re-enable automation and run `nodetool upgradesstables` — one or a few nodes at a time, throttled — until zero old-format files remain. Only then resume repairs and only then plan the next version hop.

```svg
<svg viewBox="0 0 780 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="780" height="340" fill="#ffffff"/>
  <defs><marker id="b33" markerWidth="9" markerHeight="9" refX="8" refY="4" orient="auto"><path d="M0 0 L9 4 L0 8 z" fill="#1e293b"/></marker></defs>
  <text x="20" y="26" font-size="15" font-weight="700" fill="#1e293b">Rack-by-rack rolling upgrade: quorum never breaks</text>
  <text x="20" y="52" font-size="12" font-weight="700" fill="#1e293b">DC us_east, RF 3, one replica per rack</text>
  <rect x="20" y="64" width="230" height="118" rx="10" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="135" y="86" font-size="12" font-weight="700" fill="#1e293b" text-anchor="middle">rack 1a: UPGRADING</text>
  <rect x="36" y="96" width="60" height="34" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="66" y="118" font-size="10" fill="#1e293b" text-anchor="middle">n1 4.1</text>
  <rect x="104" y="96" width="60" height="34" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="134" y="118" font-size="10" fill="#1e293b" text-anchor="middle">n2 down</text>
  <rect x="172" y="96" width="60" height="34" rx="6" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="202" y="118" font-size="10" fill="#1e293b" text-anchor="middle">n3 3.11</text>
  <text x="135" y="152" font-size="10" fill="#1e293b" text-anchor="middle">at most 1 replica of any</text>
  <text x="135" y="168" font-size="10" fill="#1e293b" text-anchor="middle">token range is offline</text>
  <rect x="270" y="64" width="230" height="118" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="385" y="86" font-size="12" font-weight="700" fill="#1e293b" text-anchor="middle">rack 1b: untouched</text>
  <rect x="286" y="96" width="60" height="34" rx="6" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="316" y="118" font-size="10" fill="#1e293b" text-anchor="middle">n4 3.11</text>
  <rect x="354" y="96" width="60" height="34" rx="6" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="384" y="118" font-size="10" fill="#1e293b" text-anchor="middle">n5 3.11</text>
  <rect x="422" y="96" width="60" height="34" rx="6" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="452" y="118" font-size="10" fill="#1e293b" text-anchor="middle">n6 3.11</text>
  <text x="385" y="160" font-size="10" fill="#1e293b" text-anchor="middle">serving LOCAL_QUORUM</text>
  <rect x="520" y="64" width="240" height="118" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="640" y="86" font-size="12" font-weight="700" fill="#1e293b" text-anchor="middle">rack 1c: untouched</text>
  <rect x="536" y="96" width="60" height="34" rx="6" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="566" y="118" font-size="10" fill="#1e293b" text-anchor="middle">n7 3.11</text>
  <rect x="604" y="96" width="60" height="34" rx="6" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="634" y="118" font-size="10" fill="#1e293b" text-anchor="middle">n8 3.11</text>
  <rect x="672" y="96" width="60" height="34" rx="6" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="702" y="118" font-size="10" fill="#1e293b" text-anchor="middle">n9 3.11</text>
  <text x="640" y="160" font-size="10" fill="#1e293b" text-anchor="middle">serving LOCAL_QUORUM</text>
  <rect x="20" y="204" width="176" height="56" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="108" y="226" font-size="11" font-weight="700" fill="#1e293b" text-anchor="middle">1. disablebinary</text>
  <text x="108" y="246" font-size="10" fill="#1e293b" text-anchor="middle">clients drop this node</text>
  <rect x="212" y="204" width="176" height="56" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="300" y="226" font-size="11" font-weight="700" fill="#1e293b" text-anchor="middle">2. nodetool drain</text>
  <text x="300" y="246" font-size="10" fill="#1e293b" text-anchor="middle">flush, seal commit log</text>
  <rect x="404" y="204" width="176" height="56" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="492" y="226" font-size="11" font-weight="700" fill="#1e293b" text-anchor="middle">3. stop, install, merge</text>
  <text x="492" y="246" font-size="10" fill="#1e293b" text-anchor="middle">diff cassandra.yaml</text>
  <rect x="596" y="204" width="164" height="56" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="678" y="226" font-size="11" font-weight="700" fill="#1e293b" text-anchor="middle">4. start, verify UN</text>
  <text x="678" y="246" font-size="10" fill="#1e293b" text-anchor="middle">then next node</text>
  <path d="M196 232 L208 232" stroke="#1e293b" stroke-width="2" marker-end="url(#b33)"/>
  <path d="M388 232 L400 232" stroke="#1e293b" stroke-width="2" marker-end="url(#b33)"/>
  <path d="M580 232 L592 232" stroke="#1e293b" stroke-width="2" marker-end="url(#b33)"/>
  <rect x="20" y="278" width="740" height="46" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="390" y="298" font-size="12" fill="#1e293b" text-anchor="middle">After ALL nodes are upgraded: nodetool upgradesstables on each node, throttled, until no old-format files remain.</text>
  <text x="390" y="316" font-size="12" fill="#1e293b" text-anchor="middle">Only then re-enable repair automation and consider the next version hop.</text>
</svg>
```

## 5. Implementation

Pre-flight checks, scripted:

```bash
# Every node must be UN and on one schema version
nodetool status | grep -c '^UN' ; nodetool describecluster
# Cluster Information:
#   Schema versions:
#     86afa796-d883-3932-aa73-6b017cef0d19: [10.2.0.31, 10.2.0.32, 10.2.0.33]
#   ^ exactly ONE uuid line: safe to proceed

nodetool compactionstats | head -1    # pending tasks: 0
nodetool netstats | grep -c 'Receiving\|Sending'   # 0 streams in flight
df -h /var/lib/cassandra | awk 'NR==2{print $5}'   # 46% used, headroom for rewrite
```

Per-node upgrade, the exact commands:

```bash
set -euo pipefail
NODE=$(hostname)

nodetool snapshot -t pre-upgrade-4.1        # rollback point (hard links, instant)
nodetool disablebinary                       # stop accepting new client connections
nodetool disablegossip                       # optional: mark down cleanly
nodetool drain                               # flush memtables, seal commit log
sudo systemctl stop cassandra

# Install; on Debian hold the config so the package cannot clobber it
sudo apt-get install -y --no-install-recommends cassandra=4.1.3
sudo diff -u /etc/cassandra/cassandra.yaml.dpkg-dist /etc/cassandra/cassandra.yaml | head -50
# review, merge renamed settings, then:
sudo systemctl start cassandra

# Verify from a DIFFERENT node
nodetool -h 10.2.0.32 status | grep "$NODE"     # UN  10.2.0.31  412 GiB  16  25.1%
nodetool version                                 # ReleaseVersion: 4.1.3
grep -c 'Startup complete' /var/log/cassandra/system.log
```

The 4.0 config rename is the most common upgrade footgun. Old and new forms of the same settings:

```yaml
# 3.11 style                          # 4.0+ style (unit-suffixed)
read_request_timeout_in_ms: 5000      read_request_timeout: 5000ms
write_request_timeout_in_ms: 2000     write_request_timeout: 2000ms
compaction_throughput_mb_per_sec: 64  compaction_throughput: 64MiB/s
memtable_heap_space_in_mb: 2048       memtable_heap_space: 2048MiB
max_hint_window_in_ms: 10800000       max_hint_window: 3h
# 4.x still accepts the old names for compatibility, but 5.0 warns loudly.
# New in 4.0 and worth enabling deliberately:
audit_logging_options:
  enabled: true
  logger: {class_name: BinAuditLogger}
full_query_logging_options:
  log_dir: /var/lib/cassandra/fql        # enable only when investigating
```

Post-upgrade SSTable rewrite, the long phase:

```bash
# Check what formats you actually have before and after
find /var/lib/cassandra/data -name '*-Data.db' | sed 's#.*/##; s#-.*##' | sort | uniq -c
#  81234 mc      <- 3.11 format, must be rewritten
#    412 nb

nodetool setcompactionthroughput 128        # raise only if latency allows
nodetool upgradesstables -j 2               # 2 concurrent tables; omit -a to skip current-format files
# monitor:
nodetool compactionstats -H | head -5
# id  compaction type  keyspace  table   completed  total    unit   progress
# ..  Upgrade sstables payments ledger   2.11 GiB   88.9 GiB bytes  2.37%

# Confirm completion
find /var/lib/cassandra/data -name 'mc-*-Data.db' | wc -l    # must be 0
```

Rollback, which is data-format-dependent:

```bash
# Safe rollback window: BEFORE the node has flushed new-format SSTables under load.
sudo systemctl stop cassandra
sudo apt-get install -y cassandra=3.11.13
# restore the snapshot for any table that has already written nb-* files
cd /var/lib/cassandra/data/payments/ledger-<uuid>
rm -f nb-*-Data.db                        # only files created after the upgrade
cp -al snapshots/pre-upgrade-4.1/* .      # hard-link restore
sudo systemctl start cassandra
# If new-format data has accumulated for hours, do NOT downgrade in place:
# wipe the node and re-add it as a replacement from healthy replicas instead.
```

Driver-side safety during the window:

```python
from cassandra.cluster import Cluster
# Pin the protocol so the driver does not renegotiate v4 -> v5 mid-rollout and
# reconnect-storm every node as it flips version.
cluster = Cluster(["10.2.0.31"], protocol_version=4, connect_timeout=10)
session = cluster.connect("payments")
# Idempotent statements let the driver retry safely when a node restarts.
stmt = session.prepare("UPDATE ledger SET amount=? WHERE account_id=? AND bucket=? AND txn_id=?")
stmt.is_idempotent = True
```

**Optimization note:** `nodetool upgradesstables` without `-a` skips SSTables already in the current format, so it is restartable and incremental — kill it and rerun freely. Prefer `-j 2` over unlimited parallelism: each job is a full-throughput compaction, and running four on a 16-core node will evict the page cache and double read latency. On clusters with `TimeWindowCompactionStrategy` and a short TTL, you can often skip the rewrite entirely for those tables and let natural expiry replace old-format files — but verify zero old files before the next major upgrade.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost/Trade-off |
|---|---|---|
| Rolling upgrade | True zero downtime; quorum preserved throughout | Mixed-version window where repair, streaming and DDL are forbidden |
| Version-negotiated messaging | Old and new nodes interoperate for reads/writes automatically | Only for the immediately adjacent major; multi-hop upgrades need intermediate stops |
| `upgradesstables` | Online, throttled, restartable, no downtime | Full rewrite of the dataset — days on large clusters, doubles I/O and disk churn |
| Snapshots as rollback | Instant, hard-linked, cheap to take | Pin disk space; useless once new-format SSTables have accumulated |
| Rack-aware ordering | Multiple nodes upgraded concurrently without losing quorum | Requires correct rack topology; wrong racks means quorum loss mid-upgrade |
| Config renames in 4.0 | Clearer units, fewer ambiguity bugs | Silent behaviour changes if you merge configs carelessly |
| Skipping `upgradesstables` | Saves days of I/O now | Hard blocker for the next major upgrade; nodes may fail to start |
| Upgrading DR DC first | Real production validation with a fallback region | Doubles the elapsed calendar time of the whole campaign |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Running repair during the mixed-version window.** Cross-version streaming is unsupported and incremental repair can leave inconsistent repaired-state. → ✅ Disable Reaper/cron repairs *before* the first node, re-enable only after `upgradesstables` completes cluster-wide.
2. ⚠️ **Bootstrapping, decommissioning or replacing a node mid-upgrade.** All of these stream. → ✅ Freeze topology changes; if a node dies during the upgrade, leave it down and finish the rollout first.
3. ⚠️ **Executing DDL during the upgrade.** Schema disagreement can become permanent. → ✅ Freeze migrations; verify a single schema UUID in `nodetool describecluster` before and after.
4. ⚠️ **Skipping `nodetool drain` before stopping.** The node replays a large commit log at start-up, extending downtime and risking a slow, half-available node. → ✅ Always `drain` last.
5. ⚠️ **Letting the package manager overwrite `cassandra.yaml`.** → ✅ Configuration management owns the file; diff the new upstream default and merge renamed settings deliberately.
6. ⚠️ **Skipping `upgradesstables` because "it still works".** It works until the next major refuses to read `mc` files and nodes fail to start. → ✅ Treat it as part of the upgrade, not an optional cleanup; verify zero old-format files.
7. ⚠️ **Upgrading two nodes of the same replica set at once.** With RF 3, two down means `LOCAL_QUORUM` fails for those ranges. → ✅ One rack at a time; within a rack you may do several nodes since NTS puts only one replica per rack.
8. ⚠️ **No snapshot, or a snapshot taken after the first node was upgraded.** → ✅ Snapshot every node before touching any node, and record the exact package version you came from.
9. ⚠️ **Assuming downgrade is possible.** Once new-format SSTables exist, it is not. → ✅ Plan rollback as "restore snapshot" or "wipe and re-stream from healthy replicas"; test it in staging with production-shaped data.
10. ⚠️ **Skipping intermediate versions (3.0 → 5.0).** → ✅ Follow the documented upgrade path (typically 3.0/3.11 → 4.0 → 4.1 → 5.0), completing `upgradesstables` at every hop, and read `NEWS.txt` for each release in between — it lists every breaking change.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** The first place to look after a failed start is `system.log` around `Cassandra version:` and `Startup complete`. Three signatures recur. `Unknown sstable format` or `Detected unreadable sstables` means you skipped `upgradesstables` on a previous hop — the fix is to downgrade that node, run the rewrite, then upgrade again. `Unable to find compaction strategy class` or unknown YAML key means the config merge dropped or mistyped something; 4.0+ fails fast on unrecognised `cassandra.yaml` keys rather than ignoring them. Gossip-level problems show as `Node /10.2.0.31 has restarted, now UP` flapping or `Cannot handshake version` — check `nodetool gossipinfo` for `NET_VERSION` and confirm the two nodes are adjacent majors, not two apart. During `upgradesstables`, `nodetool compactionstats` shows an `Upgrade sstables` task type; if progress stalls, check disk free — the rewrite needs space for both copies of the largest SSTable.

**Monitoring.** Add upgrade-specific panels for the duration: node count by `ReleaseVersion` (from `nodetool version` or the `system.local` table), schema version count from `describecluster` (must be 1), `ClientRequest.{Read,Write}.{Latency,Unavailables,Timeouts}` per DC (a spike right after a node returns usually means the driver has not re-pooled yet, or the node is replaying a commit log you forgot to drain), `Compaction.PendingTasks` and `BytesCompacted` during the rewrite phase, `Storage.TotalHints` (each restarted node accumulates hints from its peers), and dropped messages. Watch the count of old-format SSTables as a burn-down chart — it is the only honest progress metric for the rewrite phase.

**Security.** Upgrades are the natural moment to close gaps, and 4.0 gave you the tools: `audit_logging_options` records DDL/DML/auth events, and full query logging captures everything for a window. Rotate internode and client certificates as part of the rollout rather than as a separate campaign — a rolling restart is already scheduled. Verify that new default values do not weaken you: check `authenticator`, `authorizer`, `role_manager`, `client_encryption_options` and `server_encryption_options` explicitly after every config merge, because a clobbered `cassandra.yaml` reverting to `AllowAllAuthenticator` is an open database. Also confirm JMX stayed on `LOCAL_JMX=yes` — `cassandra-env.sh` is another file packages love to replace.

**Performance & scaling.** Budget the rewrite phase realistically: it is a full re-read and re-write of every byte you own, plus the compaction it triggers. On a 30-node DC holding 40 TB with `compaction_throughput` at 64 MiB/s, expect roughly a week of wall-clock at low parallelism. Throttle to protect latency (`nodetool setcompactionthroughput 64`) during business hours and raise it overnight; the command takes effect immediately without a restart. Expect transient read-latency increases as the page cache is churned by rewriting. On very large clusters, consider upgrading and rewriting a whole DC at a time while routing traffic to the other DC — the cleanest way to keep customer-visible latency flat. Finally, size the campaign in calendar terms up front: a 3-DC, 90-node, 4-major-version journey is a quarter of work, not a weekend.

## 9. Interview Questions

**Q: Why is a Cassandra rolling upgrade possible at all?**
A: There is no leader or master, so any node can be removed without an election, and every replica set has other members that can satisfy `LOCAL_QUORUM`. Internode messaging negotiates to `min(version)` between peers, and serialisers keep explicit branches for the previous major. As long as you never take down more than one replica of any token range at a time, reads and writes continue uninterrupted.

**Q: What operations are forbidden while the cluster is mixed-version, and why?**
A: Anything that streams — repair, bootstrap, decommission, removenode, rebuild, replace — because the streaming protocol changed between majors (4.0's zero-copy streaming in particular) and cross-version sessions are unsupported. Also DDL, because schema serialisation differs and a migration applied during disagreement can leave permanently divergent schema versions.

**Q: What does `nodetool upgradesstables` do and why can't you skip it?**
A: It rewrites SSTables from an older on-disk format into the running version's format, as a throttled online compaction. You cannot skip it because a release reliably reads only the previous format family; leftover 3.x `m*` files will make a 5.0 node refuse to start. It is also restartable and skips already-current files unless you pass `-a`.

**Q: Why `nodetool drain` before stopping a node?**
A: `drain` flushes all memtables to SSTables and stops accepting new writes, so the commit log has nothing to replay. Without it, the node restarts by replaying potentially gigabytes of commit log, which lengthens the outage window for that node and can make it join the ring while still catching up.

**Q: How do you decide the order of nodes in a rolling upgrade?**
A: Rack by rack within a DC, because `NetworkTopologyStrategy` places at most one replica per rack — so all nodes in one rack can be upgraded concurrently without losing quorum for any range. Across DCs, upgrade the lowest-traffic or DR DC first so you have a validated fallback, and never upgrade two DCs simultaneously if `EACH_QUORUM` or cross-DC reads are in play.

**Q: Can you downgrade Cassandra?**
A: Not once the new version has written SSTables in its own format, because older releases cannot read newer formats. If you catch a problem within minutes on a single node you can stop it, delete the new-format files, and restore the pre-upgrade snapshot. Beyond that, rollback means wiping the node and re-streaming from healthy replicas — which is itself a streaming operation, so it must happen after the version situation is settled.

**Q: (Senior) You're at 3.11 and want 5.0. Design the campaign.**
A: It is three hops: 3.11 → 4.0 → 4.1 → 5.0, each with its own `NEWS.txt` read, staging rehearsal on production-shaped data, and a completed `upgradesstables` before the next hop begins. Freeze repairs, DDL and topology changes for each hop's mixed-version window and re-enable between hops. Sequence by DC — DR DC first, then the lower-traffic region, then the primary — so each hop is validated under real traffic with a fallback. Budget the rewrite phase per hop: it dominates calendar time. Along the way, plan for 4.0's config renames, the removal of Thrift and `read_repair_chance`, the deprecation of materialized views, and 5.0's new SSTable formats and SAI, which may let you retire secondary indexes as a follow-up project.

**Q: (Senior) A node was upgraded, restarted, and now the cluster shows two schema versions that won't converge. What happened and what do you do?**
A: Almost certainly a DDL statement executed while versions were mixed, or a node was down during a migration and came back with a stale schema. First identify the split with `nodetool describecluster` and group nodes by UUID. If the minority is stale and no DDL is genuinely missing, a rolling restart of the minority usually forces a pull of the current schema. If they genuinely diverge — different table definitions — you must reconcile manually: stop DDL, pick the authoritative version, and on the divergent nodes remove the local schema tables (`system_schema`) after a snapshot and let them re-pull from gossip on restart. Prevent recurrence by gating DDL behind a deploy freeze flag during upgrades.

**Q: (Senior) How would you upgrade a 500-node, 3-DC cluster with a 30-minute nightly batch window and a strict p99 SLO?**
A: Decouple the phases. Binary rollout is fast and low-risk: automate it with rack-parallel execution driven by health checks (node is `UN` from three peers, `ClientRequest` p99 back to baseline, hints draining) rather than fixed sleeps — 500 nodes at three racks in parallel is a few nights. The rewrite phase is the SLO risk, so run it DC-at-a-time with traffic drained from that DC at the load balancer, `compaction_throughput` unthrottled while drained, then restore traffic. Keep a burn-down of old-format SSTable counts as the progress metric. Gate every phase on an automated pre-flight (single schema version, no streams, disk headroom) and make the automation refuse to proceed if any check fails. Explicitly encode the "no repair, no DDL, no topology change" freeze as a lock that CI and the repair scheduler both honour.

**Q: What is a mixed-version window and how short should it be?**
A: It is the period from the first upgraded node to the last one. Reads and writes work throughout, but repair, streaming and DDL are unavailable, which means anti-entropy is paused and any node failure cannot be remediated by replacement. Keep it to hours or a few days, not weeks — the longer it runs, the more entropy accumulates that you cannot repair away.

**Q: What changes in 4.0 most often break an upgrade in practice?**
A: The `cassandra.yaml` parameter renames to unit-suffixed forms, the removal of Thrift and the `read_repair_chance`/`dc_local_read_repair_chance` table options (they are silently dropped, changing anti-entropy behaviour), stricter YAML validation that fails start-up on unknown keys, and the new internode messaging that makes cross-version streaming impossible. Materialized views were also flagged experimental and require an explicit `enable_materialized_views: true`.

**Q: How do you make clients resilient during the rollout?**
A: Mark statements idempotent so the driver may safely retry on a connection drop; use a retry policy that retries on `WriteTimeout` for idempotent writes; keep `LOCAL_QUORUM` so a single restarting node never causes failures; set reconnection policies with jitter so all clients do not reconnect to the same node simultaneously; and consider pinning the native protocol version so drivers do not renegotiate as nodes flip, causing reconnect storms.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Upgrades have three phases: binary rollout (hours), the mixed-version window (dangerous, keep short), and `upgradesstables` (days). Rolling works because internode messaging negotiates to the lower version and there is no master — but streaming and DDL do not negotiate, so no repair, bootstrap, decommission, rebuild or DDL while versions differ. Per node: snapshot, `disablebinary`, `drain`, stop, install, merge `cassandra.yaml` by diff (4.0 renamed timeouts and throughputs to unit-suffixed forms), start, verify `UN` from a peer. Order rack by rack so only one replica of any range is ever down, DC by DC starting with DR. Afterwards, run `nodetool upgradesstables -j 2` on every node until zero old-format files remain — skipping it blocks the next major. Downgrade is not supported once new-format SSTables exist; rollback is snapshot restore or re-stream. Never skip required intermediate versions, and read `NEWS.txt` for every hop.

| Command / setting | Purpose | Notes |
|---|---|---|
| `nodetool describecluster` | Schema version check | Must show exactly one UUID |
| `nodetool snapshot -t <tag>` | Rollback point | Hard links, instant, pins disk |
| `nodetool disablebinary` | Stop client connections | Do before drain |
| `nodetool drain` | Flush + seal commit log | Always last before stop |
| `nodetool upgradesstables -j 2` | Rewrite old-format SSTables | Restartable; `-a` forces all |
| `nodetool setcompactionthroughput N` | Throttle the rewrite live | MiB/s, no restart needed |
| `nodetool version` | Confirm release on the node | Compare to expected |
| `NEWS.txt` | Per-release breaking changes | Read for every hop |
| SSTable prefixes | `mc` = 3.11, `nb` = 4.x, `oa` = 5.0 | Count of `mc-*-Data.db` files must reach 0 |

**Flash cards**
- **Three things forbidden in a mixed-version cluster** → Repair/streaming, topology changes (bootstrap/decommission/rebuild), and DDL.
- **Why `drain` before stopping** → Flushes memtables and seals the commit log so restart has nothing to replay.
- **Why `upgradesstables` is mandatory** → A release reads only the previous format family; leftover old files block the next major upgrade.
- **Safe concurrency during rollout** → One rack at a time — NTS puts at most one replica per rack, so quorum is never lost.
- **Rollback reality** → No downgrade once new-format SSTables are written; restore snapshot immediately or wipe and re-stream.

## 11. Hands-On Exercises & Mini Project

- [ ] With ccm, create a 3-node 3.11.13 cluster, load 1 GB with `cassandra-stress`, then upgrade node1 to 4.1.3 (`ccm node1 setdir -v 4.1.3`) and confirm reads/writes at `LOCAL_QUORUM` continue uninterrupted from a client loop.
- [ ] In that mixed-version cluster, attempt `nodetool repair` and capture the exact error; then attempt a `CREATE TABLE` and inspect `nodetool describecluster` for schema divergence. Document both failure modes.
- [ ] Finish the upgrade on all three nodes, then run `find … -name '*-Data.db' | sed 's/-.*//'` before and after `nodetool upgradesstables` to show the `mc` → `nb` transition and time how long it takes for your data size.
- [ ] Deliberately skip `drain` on one node and measure commit-log replay time in `system.log` at start-up versus a drained node.
- [ ] Take a snapshot, upgrade, write new data, then practise rollback: stop the node, remove new-format files, hard-link the snapshot back, and start on the old version. Note exactly what data you lost.

**Mini Project — "Upgrade Automation with Guard Rails"**

*Goal:* write an automation that upgrades a cluster rack-by-rack and physically cannot perform an unsafe operation.

*Requirements:*
1. A pre-flight module that refuses to start unless: all nodes `UN`, one schema version, zero streams, pending compactions below a threshold, and ≥ 50% disk free on every node.
2. A freeze mechanism — a cluster-wide flag that the repair scheduler and the CI/CD DDL pipeline both check and honour, set automatically for the duration.
3. Rack-aware ordering derived from `nodetool status` output, upgrading all nodes in one rack concurrently and waiting for a health gate (node `UN` from three peers, `ClientRequest` p99 within 20% of the pre-upgrade baseline, hints draining) before the next rack.
4. A rewrite phase driver that runs `upgradesstables -j 2` cluster-wide with a live burn-down of old-format SSTable counts and adaptive `setcompactionthroughput` based on measured p99.
5. A dry-run mode and a written rollback runbook with a tested snapshot-restore path.

*Extensions:* add per-DC traffic draining via your load balancer so the rewrite runs unthrottled; emit Prometheus metrics for phase, node count by version, and old-format burn-down; extend to a multi-hop campaign (3.11 → 4.0 → 4.1) that enforces "zero old-format files" as a gate between hops.

## 12. Related Topics & Free Learning Resources

Read with **32 · Multi-Datacenter Deployment & Replication** (DC-at-a-time upgrade ordering), **31 · Monitoring, Metrics & Observability** (the health gates your automation needs), **35 · Performance Tuning & Benchmarking** (throttling the rewrite phase), and the compaction, repair and snapshot/backup chapters for the mechanisms involved.

- **NEWS.txt (release notes)** — Apache Cassandra · *Advanced* · the single most important upgrade document; lists every breaking change and required intermediate version per release. <https://github.com/apache/cassandra/blob/trunk/NEWS.txt>
- **Cassandra 5.0 release notes and upgrade guidance** — Apache Cassandra · *Intermediate* · what changed in 5.0, including SSTable formats, SAI and Trie memtables. <https://cassandra.apache.org/_/blog/Apache-Cassandra-5.0-Moving-Toward-an-AI-Driven-Future.html>
- **nodetool upgradesstables** — Apache Cassandra · *Beginner* · flags, semantics, and how it interacts with compaction. <https://cassandra.apache.org/doc/latest/cassandra/managing/tools/nodetool/upgradesstables.html>
- **Upgrading Apache Cassandra** — DataStax Docs · *Intermediate* · step-by-step rolling upgrade procedure with the pre-flight checklist and per-version notes. <https://docs.datastax.com/en/upgrade/doc/upgrade/cassandra/upgradeC.html>
- **CASSANDRA-14556: Zero Copy Streaming** — Apache JIRA · *Advanced* · the change that makes cross-version streaming unsupported between 3.x and 4.0. <https://issues.apache.org/jira/browse/CASSANDRA-14556>
- **Upgrading to Cassandra 4.0 — lessons from the field** — The Last Pickle / DataStax · *Advanced* · practitioner notes on config renames, removed options, and pacing the SSTable rewrite. <https://thelastpickle.com/blog/2021/07/28/cassandra-4-0-quality.html>
- **Cassandra Reaper** — The Last Pickle / DataStax · *Intermediate* · the repair scheduler you must pause during an upgrade; its API is what your freeze flag should call. <http://cassandra-reaper.io/>

---

*Apache Cassandra Handbook — chapter 33.*
