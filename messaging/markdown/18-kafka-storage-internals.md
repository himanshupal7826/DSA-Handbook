# 18 · Storage Internals: Segments, Indexes & Zero-Copy

> **In one line:** Kafka is fast not despite using disk but *because* of how it uses it — append-only sequential writes the OS buffers in its page cache, sparse per-segment indexes that turn an offset into a file position, and `sendfile` zero-copy that shovels bytes from disk straight to the socket without ever entering the JVM — and the moment you break any of those (TLS, transcoding, tiny records) you pay for it.

---

## 1. Overview

The instinct that "disk is slow, memory is fast" is one of the most misleading half-truths in systems engineering, and Kafka is built on seeing through it. It stores every message on disk, keeps them for days, and still sustains millions of messages per second on commodity hardware. That is not because Kafka has some exotic storage engine — it has a strikingly *simple* one — but because it aligns its access pattern with what disks and operating systems are actually good at. This chapter is about that alignment: why an append-only log on spinning or solid-state disk is nearly as fast as memory for Kafka's workload, and where the sharp edges are.

Three ideas do almost all the work. First, **sequential I/O**: Kafka only ever *appends* to a partition's log, so writes are sequential, and sequential disk throughput is orders of magnitude higher than random-access throughput — close enough to memory bandwidth that the disk is no longer the bottleneck. Second, the **OS page cache**: Kafka deliberately does *not* maintain its own in-process cache of messages; it writes to the filesystem and lets the operating system's page cache hold recently-touched data in RAM, so reads of recent messages — the overwhelming majority — are served from memory by the kernel without Kafka doing anything. Third, **zero-copy**: when a consumer fetches records, Kafka uses the `sendfile` system call to transfer bytes from the page cache directly to the network socket, without copying them up into the JVM heap and back down — eliminating the copies and context switches that dominate a naive read-then-write.

Underpinning all three is the physical layout: a partition is a directory of **segment files**, each a `.log` of records plus a `.index` mapping offsets to byte positions and a `.timeindex` mapping timestamps to offsets. The indexes are *sparse* — one entry every few kilobytes, not per record — which keeps them tiny enough to live in the page cache while still letting a consumer jump close to any offset with one lookup and a short scan. The payoff of understanding this is not academic: it tells you why Kafka wants lots of RAM but a small JVM heap, why enabling TLS or broker-side decompression can quietly halve your throughput by defeating zero-copy, and why tiny un-batched records waste most of the machine. Kafka's speed is a set of design choices you can accidentally undo.

## 2. Core Concepts

- **Sequential I/O** — reading or writing contiguous bytes in order. Far faster than random I/O because it avoids seeks and lets the disk, controller and OS read-ahead all work with the grain.
- **Append-only log** — a partition is only ever written at its tail; records are never updated in place. This is what makes every write sequential.
- **Page cache** — the operating system's cache of file pages in RAM. Reads hit it transparently; writes are buffered in it and flushed to disk by the kernel. Kafka relies on it *instead of* an application-level cache.
- **Segment** — a partition's log is split into segment files of bounded size (`segment.bytes`) or age (`segment.ms`); only the last (active) segment is written to.
- **`.log` file** — the segment's actual records, in order, on disk.
- **`.index` file** — a sparse map from *relative offset* to *byte position* in the `.log`, so a consumer can find where an offset lives without scanning from the start.
- **`.timeindex` file** — a sparse map from *timestamp* to *offset*, so time-based lookups (offset-for-time, retention) are cheap.
- **Sparse index** — an index with an entry only every `index.interval.bytes`, not per record; small enough to stay cached, precise enough to bound the follow-up scan.
- **Base offset** — the offset of the first record in a segment; also the segment's filename (e.g. `00000000000000012345.log`).
- **Zero-copy / `sendfile`** — a kernel path that sends file data straight from the page cache to a socket without copying it into user space (the JVM heap).
- **Read-ahead / write-behind** — the kernel prefetching sequential pages on read and flushing dirty pages lazily on write; both amplify sequential throughput.
- **Flush (`fsync`)** — forcing buffered page-cache writes to physical disk. Kafka relies on *replication* for durability rather than fsyncing every write, so it can keep writes in the page cache.

## 3. Theory & Principles

### Sequential disk is not "slow disk"

The number that reframes everything: on a typical drive, *random* reads and writes run at a few MB/s, while *sequential* reads and writes run at hundreds of MB/s — a difference of two orders of magnitude, and on some spinning disks nearer three. Sequential access on a good SSD or an array can exceed the throughput of random access on *RAM* accessed with poor locality. Kafka's entire storage model is engineered to stay on the fast side of that cliff: because a partition is an append-only log, every write goes to the end of one file, so the disk head never seeks (on an SSD, the controller never scatters), the OS batches writes into large sequential flushes, and read-ahead prefetches the next records before the consumer asks. "Kafka writes to disk" and "Kafka is slow" are unrelated statements because Kafka never does the slow kind of disk access.

There is a second, subtler win: because writes are appends buffered in the page cache and flushed lazily, Kafka does not pay an `fsync` per message. It trusts *replication* (chapter 17) for durability — a record acknowledged under `acks=all` is on the page cache of multiple brokers, and the probability of all of them losing power before any flush is what RF protects against — so it can leave the expensive synchronous disk flush to the kernel's own schedule. This is a deliberate trade: Kafka chose replicated durability over per-write fsync durability, which is a large part of why it is fast.

### Let the kernel be the cache

Most databases maintain a carefully-managed in-process buffer pool. Kafka does the opposite: it keeps almost nothing in its own heap and leans entirely on the OS page cache. The reasoning is precise. A JVM heap cache would duplicate what the page cache already holds (double-buffering the same bytes in RAM), it would add GC pressure proportional to the cache size (a multi-gigabyte object cache is a GC nightmare), and it would be cold after every restart — whereas the page cache survives a Kafka process restart because it belongs to the kernel, not the JVM. By writing to the filesystem and reading through it, Kafka gets a huge, automatically-managed, restart-surviving, GC-free cache for free, sized to *all available RAM* rather than to a heap you must tune.

The operational consequence is counter-intuitive and worth stating plainly: **Kafka wants a small heap and lots of RAM.** A typical broker runs with a heap of perhaps 5–6 GB regardless of machine size, and every additional gigabyte of RAM goes to the OS to enlarge the page cache. A broker with 64 GB of RAM and a 6 GB heap is using ~58 GB as message cache. If you "helpfully" give Kafka a 48 GB heap, you starve the page cache, force GC pauses, and make it *slower*. The workload is also cache-friendly by nature: consumers mostly read the *tail* of the log, the records just produced, which are exactly the pages most recently written and therefore still hot in the cache — so the common case is served entirely from RAM.

```svg
<svg viewBox="0 0 880 460" width="100%" height="460" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="w1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
  </defs>
  <text x="440" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">A partition on disk: segments, sparse index, page cache</text>

  <rect x="24" y="44" width="524" height="196" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="286" y="66" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">partition directory  orders-0/</text>

  <rect x="44" y="82" width="150" height="88" rx="6" fill="#fff" stroke="#93c5fd"/>
  <text x="119" y="100" text-anchor="middle" fill="#1e40af" font-size="9" font-weight="bold">segment (closed)</text>
  <text x="119" y="118" text-anchor="middle" fill="#1d4ed8" font-size="8">00..000.log</text>
  <text x="119" y="132" text-anchor="middle" fill="#1d4ed8" font-size="8">00..000.index</text>
  <text x="119" y="146" text-anchor="middle" fill="#1d4ed8" font-size="8">00..000.timeindex</text>
  <text x="119" y="162" text-anchor="middle" fill="#64748b" font-size="8">base offset 0</text>

  <rect x="206" y="82" width="150" height="88" rx="6" fill="#fff" stroke="#93c5fd"/>
  <text x="281" y="100" text-anchor="middle" fill="#1e40af" font-size="9" font-weight="bold">segment (closed)</text>
  <text x="281" y="118" text-anchor="middle" fill="#1d4ed8" font-size="8">00..12345.log</text>
  <text x="281" y="132" text-anchor="middle" fill="#1d4ed8" font-size="8">00..12345.index</text>
  <text x="281" y="146" text-anchor="middle" fill="#1d4ed8" font-size="8">00..12345.timeindex</text>
  <text x="281" y="162" text-anchor="middle" fill="#64748b" font-size="8">base offset 12345</text>

  <rect x="368" y="82" width="160" height="88" rx="6" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="448" y="100" text-anchor="middle" fill="#15803d" font-size="9" font-weight="bold">ACTIVE segment</text>
  <text x="448" y="118" text-anchor="middle" fill="#166534" font-size="8">00..48000.log  &#8592; appends</text>
  <text x="448" y="132" text-anchor="middle" fill="#166534" font-size="8">00..48000.index</text>
  <text x="448" y="146" text-anchor="middle" fill="#166534" font-size="8">00..48000.timeindex</text>
  <text x="448" y="162" text-anchor="middle" fill="#166534" font-size="8">only this one is written</text>

  <text x="44" y="196" fill="#1d4ed8" font-size="9">roll a new segment when segment.bytes (e.g. 1 GB) or segment.ms elapses.</text>
  <text x="44" y="214" fill="#1d4ed8" font-size="9">retention / compaction delete or rewrite WHOLE closed segments &#8212; never edits in place.</text>
  <text x="44" y="232" fill="#1e40af" font-size="9" font-weight="bold">every write is an append to the tail &#8594; sequential I/O.</text>

  <rect x="560" y="44" width="292" height="196" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="706" y="66" text-anchor="middle" fill="#b45309" font-size="12" font-weight="bold">sparse .index</text>
  <g font-size="9">
    <text x="578" y="90" fill="#92400e">rel offset &#8594; byte position</text>
    <rect x="578" y="98" width="240" height="18" fill="#fff" stroke="#f59e0b"/><text x="588" y="111" fill="#b45309" font-size="8">0        &#8594; 0</text>
    <rect x="578" y="116" width="240" height="18" fill="#fff" stroke="#f59e0b"/><text x="588" y="129" fill="#b45309" font-size="8">37       &#8594; 4096</text>
    <rect x="578" y="134" width="240" height="18" fill="#fff" stroke="#f59e0b"/><text x="588" y="147" fill="#b45309" font-size="8">81       &#8594; 8192</text>
    <rect x="578" y="152" width="240" height="18" fill="#fff" stroke="#f59e0b"/><text x="588" y="165" fill="#b45309" font-size="8">128      &#8594; 12288</text>
  </g>
  <text x="578" y="190" fill="#92400e" font-size="9">one entry per index.interval.bytes</text>
  <text x="578" y="206" fill="#92400e" font-size="9">(default 4 KB) &#8212; NOT per record</text>
  <text x="578" y="224" fill="#b45309" font-size="9" font-weight="bold">tiny &#8594; stays in the page cache</text>

  <rect x="24" y="260" width="828" height="180" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="438" y="282" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">The page cache sits between Kafka and the disk</text>
  <rect x="60" y="300" width="150" height="40" rx="6" fill="#fff" stroke="#16a34a"/><text x="135" y="325" text-anchor="middle" fill="#15803d" font-size="10">Kafka (small heap)</text>
  <rect x="330" y="300" width="200" height="40" rx="6" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/><text x="430" y="320" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">OS PAGE CACHE (most of RAM)</text><text x="430" y="334" text-anchor="middle" fill="#166534" font-size="8">recent records held here</text>
  <rect x="650" y="300" width="150" height="40" rx="6" fill="#fff" stroke="#64748b"/><text x="725" y="325" text-anchor="middle" fill="#475569" font-size="10">disk (.log files)</text>
  <path d="M210,320 L326,320" stroke="#16a34a" stroke-width="2" marker-end="url(#w1)"/>
  <path d="M530,320 L646,320" stroke="#16a34a" stroke-width="2" marker-end="url(#w1)"/>
  <text x="60" y="366" fill="#166534" font-size="9">writes buffered in the cache, flushed lazily by the kernel (no fsync per message &#8212; replication is the durability).</text>
  <text x="60" y="386" fill="#166534" font-size="9">reads of recent records hit the cache &#8594; served from RAM without touching disk or the JVM heap.</text>
  <text x="60" y="410" fill="#15803d" font-size="9" font-weight="bold">This is why Kafka wants LOTS of RAM and a SMALL heap: every extra GB becomes message cache, not GC pressure.</text>
</svg>
```

### The sparse index bounds the lookup

A consumer asks for offset 12,910. Kafka must find the byte position of that record in the segment file. A dense index (one entry per record) would be as large as the log; a full scan would be O(segment size). The sparse index is the middle path: it holds one `offset → position` entry every `index.interval.bytes` (4 KB by default), so to find offset 12,910 Kafka binary-searches the tiny index for the greatest indexed offset ≤ 12,910 (say 12,880 → position 40,960), seeks the `.log` to that position, and scans forward a few kilobytes to the exact record. The index is small enough to stay resident in the page cache, and the follow-up scan is bounded by the index interval — a few kilobytes at most — so a random offset lookup is effectively O(1). The `.timeindex` does the same for timestamps, which is how "give me everything since 09:00" and time-based retention are cheap.

## 4. Architecture & Workflow

### The write path and the zero-copy read path

```svg
<svg viewBox="0 0 880 500" width="100%" height="500" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="z1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
    <marker id="z2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Naive read (4 copies) vs Kafka zero-copy sendfile (0 user-space copies)</text>

  <rect x="24" y="44" width="410" height="290" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="229" y="66" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Naive read-then-write (what Kafka AVOIDS)</text>

  <rect x="44" y="82" width="170" height="30" rx="5" fill="#fff" stroke="#dc2626"/><text x="129" y="102" text-anchor="middle" fill="#b91c1c" font-size="10">disk (.log file)</text>
  <rect x="44" y="140" width="170" height="30" rx="5" fill="#fee2e2" stroke="#dc2626"/><text x="129" y="160" text-anchor="middle" fill="#b91c1c" font-size="10">kernel page cache</text>
  <rect x="44" y="198" width="170" height="30" rx="5" fill="#fee2e2" stroke="#dc2626"/><text x="129" y="218" text-anchor="middle" fill="#b91c1c" font-size="9">JVM heap (read buffer)</text>
  <rect x="44" y="256" width="170" height="30" rx="5" fill="#fee2e2" stroke="#dc2626"/><text x="129" y="276" text-anchor="middle" fill="#b91c1c" font-size="9">kernel socket buffer</text>
  <rect x="240" y="256" width="170" height="30" rx="5" fill="#fff" stroke="#dc2626"/><text x="325" y="276" text-anchor="middle" fill="#b91c1c" font-size="10">network (consumer)</text>

  <path d="M129,112 L129,138" stroke="#dc2626" stroke-width="2" marker-end="url(#z1)"/><text x="230" y="130" fill="#991b1b" font-size="8">copy 1: disk &#8594; cache (DMA)</text>
  <path d="M129,170 L129,196" stroke="#dc2626" stroke-width="2" marker-end="url(#z1)"/><text x="230" y="188" fill="#991b1b" font-size="8">copy 2: cache &#8594; heap (read)</text>
  <path d="M129,228 L129,254" stroke="#dc2626" stroke-width="2" marker-end="url(#z1)"/><text x="230" y="246" fill="#991b1b" font-size="8">copy 3: heap &#8594; socket (write)</text>
  <path d="M214,271 L236,271" stroke="#dc2626" stroke-width="2" marker-end="url(#z1)"/><text x="235" y="300" fill="#991b1b" font-size="8">copy 4: socket buf &#8594; NIC (DMA)</text>
  <text x="44" y="320" fill="#b91c1c" font-size="9" font-weight="bold">4 copies + 2 user/kernel context switches per read</text>

  <rect x="446" y="44" width="410" height="290" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="651" y="66" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Kafka zero-copy (sendfile)</text>

  <rect x="466" y="82" width="170" height="30" rx="5" fill="#fff" stroke="#16a34a"/><text x="551" y="102" text-anchor="middle" fill="#15803d" font-size="10">disk (.log file)</text>
  <rect x="466" y="150" width="170" height="30" rx="5" fill="#dcfce7" stroke="#16a34a"/><text x="551" y="170" text-anchor="middle" fill="#15803d" font-size="10">kernel page cache</text>
  <rect x="466" y="256" width="170" height="30" rx="5" fill="#fff" stroke="#16a34a"/><text x="551" y="276" text-anchor="middle" fill="#15803d" font-size="10">network (consumer)</text>

  <rect x="666" y="150" width="170" height="80" rx="6" fill="#fff" stroke="#16a34a" stroke-dasharray="4 3"/>
  <text x="751" y="176" text-anchor="middle" fill="#15803d" font-size="9" font-weight="bold">JVM heap</text>
  <text x="751" y="196" text-anchor="middle" fill="#166534" font-size="8">bytes NEVER</text>
  <text x="751" y="210" text-anchor="middle" fill="#166534" font-size="8">enter here</text>

  <path d="M551,112 L551,148" stroke="#16a34a" stroke-width="2" marker-end="url(#z2)"/><text x="560" y="134" fill="#166534" font-size="8">DMA: disk &#8594; cache</text>
  <path d="M551,180 L551,254" stroke="#16a34a" stroke-width="2" marker-end="url(#z2)"/><text x="560" y="220" fill="#166534" font-size="8">sendfile: cache &#8594; NIC directly</text>
  <text x="466" y="312" fill="#15803d" font-size="9" font-weight="bold">0 user-space copies &#8212; bytes go cache &#8594; socket in the kernel</text>

  <rect x="24" y="354" width="832" height="132" rx="10" fill="#fef9c3" stroke="#d97706" stroke-width="2"/>
  <text x="440" y="376" text-anchor="middle" fill="#b45309" font-size="12" font-weight="bold">What DEFEATS zero-copy (bytes must pass through user space again)</text>
  <text x="44" y="402" fill="#92400e" font-size="10">&#8226; TLS/SSL on the client listener &#8594; bytes must be ENCRYPTED in user space, so sendfile can't be used.</text>
  <text x="44" y="424" fill="#92400e" font-size="10">&#8226; Broker-side re-compression / transcoding &#8594; the broker must read &amp; rewrite record bytes (format down-conversion).</text>
  <text x="44" y="446" fill="#92400e" font-size="10">&#8226; Consumer on an OLD message format &#8594; broker down-converts, materialising records in the heap.</text>
  <text x="44" y="470" fill="#b45309" font-size="10" font-weight="bold">Lesson: keep producer &amp; consumer on the same message format and compression to preserve the zero-copy fast path.</text>
</svg>
```

**The write path.** A produce request arrives at the leader. Kafka appends the record batch to the *active* segment's `.log` file — a sequential write into the page cache, which the kernel will flush to disk lazily. If enough bytes have accumulated since the last index entry (`index.interval.bytes`), it adds one `offset → position` entry to the `.index` and one `timestamp → offset` entry to the `.timeindex`. When the active segment reaches `segment.bytes` or `segment.ms`, Kafka *rolls* it: closes the current segment, opens a new one whose filename is the next base offset, and the old segment becomes immutable. Nothing is ever updated in place — retention and compaction (chapter 14) operate on whole closed segments, deleting or rewriting entire files, which keeps every write sequential.

**The zero-copy read path.** A consumer fetch asks for records from a given offset. Kafka uses the `.index` to translate the offset into a byte position in the `.log`, then — crucially — calls `sendfile` (surfaced in the JVM as `FileChannel.transferTo`). This tells the kernel: "take this many bytes from this file, starting at this position, and put them on this socket." The bytes flow from disk (or, usually, the page cache) straight to the network interface *inside the kernel*, never crossing into the JVM heap and never being copied into a user-space buffer. Compare the naive path — disk → cache → heap → socket buffer → NIC, four copies and two context switches — with the zero-copy path — disk → cache → NIC, no user-space copy. For a broker fanning the same hot segment out to hundreds of consumers, that difference is the difference between saturating the network card and melting the CPU.

The critical corollary is when zero-copy is *defeated*. `sendfile` works only when the bytes on disk are exactly the bytes to send. The moment the broker must *transform* them — encrypt for TLS, re-compress, or down-convert an old message format for an old client — it has to pull the records into user space, mutate them, and write them back out, reintroducing the copies. This is not theoretical: turning on TLS for client traffic, or running a mixed-version fleet that forces message-format down-conversion, can measurably cut a broker's throughput precisely because it loses the zero-copy fast path.

## 5. Implementation

You do not write storage code for Kafka; you configure it and inspect it. The tools that matter are the segment/retention configs and the `dump-log-segments` and `kafka-configs` utilities that let you see the physical layout.

**Segment and index configuration (`server.properties` / topic overrides).**

```properties
# server.properties  -- storage layout defaults (overridable per topic)

# Where partition directories live. Multiple dirs spread I/O across disks;
# each partition is pinned to one dir (no striping of a single partition).
log.dirs=/var/lib/kafka/data-1,/var/lib/kafka/data-2

# Roll a new segment at 1 GiB. Larger segments = fewer files and less rolling
# overhead, but coarser retention granularity (retention deletes whole
# segments, so a huge segment can't be partly expired).
log.segment.bytes=1073741824

# Also roll a segment after this long even if it hasn't filled -- bounds how
# long a low-traffic partition's tail sits in one unclosed segment.
log.roll.ms=604800000

# Sparse index density: add one .index entry per 4 KiB of log. Smaller =
# denser index (faster lookups, more memory); larger = sparser (less memory,
# longer post-lookup scan). 4 KiB is the sane default.
log.index.interval.bytes=4096

# Preallocate the index file size; capped here. Indexes are memory-mapped.
log.index.size.max.bytes=10485760

# DURABILITY BY REPLICATION, NOT FSYNC: leave flush intervals at their defaults
# (effectively "let the OS decide") so writes stay buffered in the page cache
# and are flushed lazily. acks=all + RF=3 provides durability instead of a
# synchronous fsync per write. Do NOT set these low to "be safe" -- you would
# cripple throughput for a guarantee replication already gives you.
# log.flush.interval.messages=<leave unset>
# log.flush.interval.ms=<leave unset>
```

**JVM heap sizing — the counter-intuitive one.** Set a small heap and give the rest of RAM to the page cache.

```bash
# Kafka broker JVM: a MODEST heap, regardless of machine size. On a 64 GB box,
# ~6 GB heap leaves ~58 GB for the OS page cache -- which IS Kafka's message
# cache. A huge heap here would starve the cache and add GC pauses, making
# Kafka SLOWER. This is the single most common Kafka mis-tuning.
export KAFKA_HEAP_OPTS="-Xmx6g -Xms6g"
bin/kafka-server-start.sh config/server.properties
```

**Inspecting the physical log with `kafka-dump-log`.** This is how you *see* segments, batches, offsets and index entries — invaluable for understanding and for debugging corruption or unexpected retention.

```bash
# List the segment files of a partition: filenames are BASE OFFSETS.
ls -la /var/lib/kafka/data-1/orders-0/
#   00000000000000000000.log    00000000000000000000.index    00000000000000000000.timeindex
#   00000000000000012345.log    00000000000000012345.index    00000000000000012345.timeindex
#   00000000000000048000.log  (active)  ... .index  ... .timeindex

# Dump a segment's record batches: offsets, sizes, compression, timestamps,
# and whether it's a control batch (transaction markers, chapter 20).
kafka-dump-log.sh \
  --files /var/lib/kafka/data-1/orders-0/00000000000000012345.log \
  --print-data-log
# baseOffset: 12345 lastOffset: 12401 count: 57 ... compresscodec: LZ4
#   producerId: 4001 producerEpoch: 3 isTransactional: true ...
#   offset: 12345 timestamp: 1712345678901 key: order-88 payload: {...}

# Dump the sparse OFFSET index: each line is  offset -> physical position.
# Note how few entries there are relative to the record count -- that's sparse.
kafka-dump-log.sh \
  --files /var/lib/kafka/data-1/orders-0/00000000000000012345.index
# offset: 12382 position: 4096
# offset: 12419 position: 8192

# Dump the TIME index: timestamp -> offset, used for offset-for-time and
# time-based retention.
kafka-dump-log.sh \
  --files /var/lib/kafka/data-1/orders-0/00000000000000012345.timeindex
```

**Reading segment/retention config on a live topic.**

```bash
# See a topic's effective storage config (segment size, retention, index).
kafka-configs.sh --bootstrap-server localhost:9092 --describe \
  --entity-type topics --entity-name orders

# Tune segment size for a topic whose retention granularity you want finer
# (smaller segments expire sooner and more precisely).
kafka-configs.sh --bootstrap-server localhost:9092 --alter \
  --entity-type topics --entity-name orders \
  --add-config segment.bytes=268435456,segment.ms=3600000
```

The through-line: the log is *just files*, laid out so that appends are sequential, lookups are cheap sparse-index binary searches, and reads can be shipped by `sendfile`. Every config here is about preserving those properties — big-enough segments to avoid churn, sparse-enough indexes to stay cached, and a small heap so the page cache is large.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Throughput close to hardware limits.** Sequential I/O, page-cache reads and zero-copy let a single broker sustain hundreds of MB/s to many consumers.
- **Cheap fan-out.** One hot segment served to N consumers via `sendfile` costs little more CPU than serving one — the bytes leave the page cache once per consumer with no per-consumer copy into user space.
- **Restart-resilient cache.** The page cache belongs to the kernel, so it survives a Kafka process restart; the broker is warm immediately, unlike an in-heap cache.
- **No GC on the data path.** Because message bytes never sit in the JVM heap on the read path, multi-terabyte throughput does not translate into GC pressure.
- **Simple, inspectable storage.** Plain files with sparse indexes are easy to reason about, back up, and debug with `dump-log`.

**Disadvantages**
- **RAM-hungry for the hot set.** The performance model assumes recent data fits in the page cache; if consumers routinely read cold historical data, reads hit disk and slow down.
- **Fragile fast path.** TLS, broker-side transcoding, or mixed message formats defeat zero-copy and quietly reduce throughput.
- **Coarse retention granularity.** Retention and compaction act on whole segments, so a very large `segment.bytes` means data lives past its nominal retention until the whole segment can be dropped.
- **Many small files at scale.** Thousands of partitions × several segments each is a lot of open file handles and index maps; the OS and broker must be tuned for it.

**Trade-offs**
- *Segment size — churn vs granularity:* large segments mean fewer files and less rolling/index overhead but coarser retention and slower compaction; small segments expire precisely but multiply file count and open handles.
- *Durability — fsync vs replication:* Kafka trades per-write fsync for replicated durability, keeping writes in the page cache for speed; the cost is that a simultaneous power loss of all replicas before flush could lose recently-acknowledged data (which RF and UPS/rack-spread mitigate).
- *Zero-copy vs security/compatibility:* the fastest path requires the broker to ship bytes untouched, so TLS and format transcoding buy encryption/compatibility at a throughput cost — a real, measurable trade you make deliberately per listener.

## 7. Common Mistakes & Best Practices

- **Giving Kafka a huge heap.** The most common mis-tuning: a big `-Xmx` starves the page cache and adds GC pauses, making Kafka *slower*. Keep the heap modest (a few GB) and let free RAM be the cache.
- **Fsyncing every write "to be safe".** Setting `log.flush.interval.messages=1` (or a tiny `log.flush.interval.ms`) forces a synchronous disk flush per write and destroys throughput, for a guarantee replication already provides. Rely on `acks=all` + RF, not per-write fsync.
- **Assuming TLS is free.** Enabling TLS on the client listener defeats zero-copy because the broker must encrypt bytes in user space. It is often worth it — just budget for the throughput hit rather than being surprised by it.
- **Running a mixed message-format fleet.** Old consumers force the broker to down-convert records, materialising them in the heap and losing zero-copy. Keep clients and `inter.broker.protocol.version` / `log.message.format.version` aligned.
- **Segments so large that retention lags.** A 10 GB `segment.bytes` on a low-throughput topic means data sits far past its retention window because the segment cannot be dropped until fully rolled. Size segments relative to throughput and retention.
- **Storing partitions on a single slow disk.** All the sequential-I/O advantages assume the disk can sustain the sequential rate; a cheap, shared, or heavily-fragmented volume undoes them. Use dedicated, fast volumes and spread partitions across `log.dirs`.
- **Reading cold data at scale on a small-RAM box.** Batch consumers replaying old offsets pull cold segments off disk and evict the hot set from the page cache, hurting live consumers. Isolate heavy replay or size RAM for it.
- **Best practice: protect the three fast paths.** Sequential append, page-cache reads, and zero-copy `sendfile` are Kafka's speed. Size RAM generously and heap small, keep client formats aligned, use fast dedicated disks, and enable TLS/transcoding knowingly — and Kafka runs at hardware speed.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** For "why is this partition slow / big / not expiring", go to the files: `ls` the partition directory to see segments and their sizes, and `kafka-dump-log.sh --print-data-log` to inspect batches, compression codecs, timestamps and transaction markers. Unexpected disk growth is usually retention not kicking in (segment too large to roll, or `retention.ms` misread) or a stuck consumer holding the log via a compaction/`__consumer_offsets` dependency. A partition failing to load on startup is often a corrupt index — Kafka rebuilds `.index`/`.timeindex` from the `.log` on recovery, which is slow but non-destructive.
- **Monitoring.** Watch the OS page-cache hit ratio indirectly via disk read I/O: healthy Kafka does almost no disk *reads* (reads served from cache), so a rising read rate means consumers are reading cold data and evicting the hot set. Track disk *write* throughput (should be smooth and sequential), free memory available to the cache, per-broker disk utilisation and headroom (Kafka's storage grows with retention × ingest × RF), and open file handles (segments × partitions). GC time should be low precisely because the data path avoids the heap.
- **Security.** TLS on the client listener encrypts data in transit but defeats zero-copy — a deliberate throughput-for-confidentiality trade; encryption-at-rest is handled at the volume level (dm-crypt/LUKS or cloud disk encryption) rather than in Kafka, which keeps the log as plain files. Because the log is plain files on disk, filesystem permissions and volume encryption are part of the security posture: anyone with read access to `log.dirs` can read every message with `dump-log`.
- **Scaling.** Storage scales by adding disks (`log.dirs`) and brokers and by reassigning partitions across them; sequential-I/O performance holds as long as each disk sustains its sequential rate and RAM keeps the hot set cached. The tiered-storage feature (KIP-405) offloads old, cold segments to object storage (S3/GCS) so brokers keep only the hot set on local disk — decoupling retention length from local-disk cost and letting you keep months of history without ballooning broker storage. Watch file-handle limits and page-cache pressure as partition count grows.

## 9. Interview Questions

**Q: Why is Kafka fast despite writing everything to disk?**
A: Because it only does the *fast* kind of disk access. A partition is an append-only log, so every write is sequential, and sequential disk throughput is one to three orders of magnitude higher than random access — on good hardware it rivals memory bandwidth. Writes are buffered in the OS page cache and flushed lazily rather than fsynced per message (durability comes from replication instead), so writes are cheap. Reads of recent data are served from the page cache in RAM, and Kafka ships them to consumers with zero-copy `sendfile`, avoiding copies into the JVM heap. "Writes to disk" and "slow" are unrelated because Kafka never seeks and never does per-message synchronous flushes.

**Q: Why does Kafka rely on the OS page cache instead of an in-process cache?**
A: A JVM heap cache would double-buffer bytes the page cache already holds, add GC pressure proportional to its size (a multi-gigabyte object cache is a GC disaster), and be cold after every restart. The page cache avoids all three: it is managed by the kernel, sized to all available RAM, GC-free because it is off-heap, and it survives a Kafka process restart because it belongs to the OS. Kafka's workload is also cache-friendly — consumers mostly read the tail of the log, which is exactly the most-recently-written and therefore hottest pages — so the common case is served entirely from RAM. The practical consequence is that Kafka wants a small heap and lots of RAM.

**Q: How big should a Kafka broker's JVM heap be, and why?**
A: Modest and roughly fixed regardless of machine size — commonly around 5–6 GB. The reason is that every gigabyte you give the heap is a gigabyte taken from the OS page cache, which is Kafka's actual message cache. On a 64 GB machine a 6 GB heap leaves ~58 GB for the cache, keeping the hot set in RAM; a 48 GB heap would starve the cache, force disk reads, and add long GC pauses, making the broker slower. It is one of the most counter-intuitive tunings in Kafka: bigger heap, worse performance.

**Q: What is zero-copy and why does it matter for a broker?**
A: Zero-copy is sending file data from the page cache straight to a network socket via the `sendfile` system call (`FileChannel.transferTo` in the JVM), without copying the bytes up into user space (the JVM heap) and back down. A naive read-then-write path makes four copies and two context switches per read — disk to cache, cache to heap, heap to socket buffer, socket buffer to NIC. Zero-copy collapses that to disk-to-cache-to-NIC entirely inside the kernel. For a broker fanning a hot segment out to hundreds of consumers, this is the difference between saturating the network card and burning all its CPU on memory copies — it is central to Kafka's fan-out efficiency.

**Q: What defeats zero-copy?**
A: Anything that forces the broker to *transform* the bytes rather than ship them verbatim, because `sendfile` requires the bytes on disk to be exactly the bytes sent. TLS on the client listener means the broker must encrypt the data in user space first. Broker-side re-compression or transcoding means it must read and rewrite the record bytes. A consumer on an older message format forces the broker to down-convert records, materialising them in the heap. Each of these reintroduces the user-space copies zero-copy eliminated, so enabling TLS or running a mixed-version fleet can measurably cut throughput — a real trade to make deliberately.

**Q: What is in a segment, and what are the `.index` and `.timeindex` files?**
A: A partition's log is split into segment files of bounded size or age; only the last, active segment is written to. Each segment is three files sharing a base-offset filename: the `.log` holds the actual record batches in order; the `.index` is a sparse map from relative offset to byte position in the `.log`; and the `.timeindex` is a sparse map from timestamp to offset. The indexes are sparse — one entry every `index.interval.bytes` (4 KB by default), not per record — so they are small enough to stay in the page cache while still letting a consumer binary-search to near any offset or timestamp and scan a bounded few kilobytes to the exact record.

**Q: (Senior) Explain end-to-end how a consumer fetch for a specific offset is served, from the filesystem up.**
A: The fetch arrives at the partition leader asking for records from, say, offset 12,910. The broker first locates the segment: segment filenames are base offsets, so it finds the segment whose base offset is the greatest not exceeding 12,910. Within that segment it consults the sparse `.index`, binary-searching for the largest indexed offset ≤ 12,910 — say 12,880 mapping to byte position 40,960 — which gets it close without scanning from the segment start. It seeks the `.log` to that position and scans forward a bounded amount (at most `index.interval.bytes`) to the exact record batch at 12,910. Then, rather than reading those bytes into the JVM heap and writing them to the socket, it calls `sendfile`/`transferTo`, handing the kernel the file, the start position and the byte count, and the kernel streams the bytes from the page cache (or disk, if cold) directly to the consumer's socket without a user-space copy. If the requested data is recent, it is already in the page cache, so the whole path touches no disk and no heap — which is why tail reads are effectively memory-speed. The only things that break this are format down-conversion or TLS, which force the bytes through user space and disable the `sendfile` shortcut.

**Q: (Senior) Kafka doesn't fsync every write — how can it claim durability, and what is the failure window?**
A: Kafka substitutes *replicated* durability for *fsync* durability. Under `acks=all` with `min.insync.replicas=2` and RF=3 (chapter 17), an acknowledged record is present in the page cache of at least two brokers before the producer is told "committed". The bet is that the page caches of multiple independent brokers will not all be lost simultaneously before the kernel lazily flushes them to disk — which requires a correlated failure like a whole-datacentre power loss hitting every replica at once. So Kafka gets speed by not forcing a synchronous disk flush per message, while getting durability from redundancy across machines. The failure window is precisely that correlated-power-loss case: records acknowledged but not yet flushed on *any* replica when *all* replicas lose power together could be lost. You shrink that window by spreading replicas across racks/availability zones (so they do not share a power domain), by ensuring machines have battery-backed write caches or UPS, and, if a specific topic truly cannot tolerate even that tiny window, by tuning `flush` intervals for it — accepting the throughput cost. For almost all workloads, cross-AZ replication makes the correlated-loss probability negligible, and per-write fsync is not worth its price.

**Q: (Senior) A team enabled TLS and throughput dropped noticeably. Explain why and what you would do.**
A: The drop is expected and comes from losing zero-copy. Without TLS, the broker serves fetches with `sendfile`, streaming record bytes from the page cache to the socket entirely in the kernel, with no user-space copy and minimal CPU. With TLS, every byte must be encrypted before it goes on the wire, and encryption happens in user space, so the broker can no longer use `sendfile` — it must copy records from the page cache into the JVM, encrypt them, and write them to the socket, reintroducing the copies and the CPU cost zero-copy avoided. On a fan-out-heavy broker that shift from near-zero to per-byte CPU is exactly where the throughput went. What I would do: first, decide whether TLS is required on that path at all — internal broker-to-broker or same-VPC client traffic may be acceptable to leave plaintext if the network is already isolated, reserving TLS for untrusted paths. If TLS is required, I would provision for the CPU cost: ensure the JVM and OpenSSL are using hardware AES acceleration (AES-NI), pick efficient cipher suites, scale broker CPU/instance types to carry the encryption load, and possibly offload TLS termination to a proxy or load balancer for client connections so brokers can still `sendfile` internally. I would also make sure the throughput hit is not compounded by message-format down-conversion (another zero-copy killer) by aligning client versions. The key point for the team is that this is not a misconfiguration to "fix" back to full speed — it is the inherent cost of encrypting a stream that was previously shipped untouched, and the engineering task is to budget CPU for it, not to expect the plaintext number back.

**Q: Why are Kafka's indexes sparse rather than dense, and what is the cost?**
A: A dense index (one entry per record) would be roughly as large as the log itself, too big to keep in the page cache, defeating the point. A sparse index stores one `offset → position` entry every `index.interval.bytes` (4 KB by default), so it is tiny — kilobytes for a gigabyte segment — and stays resident in cache. The cost is that a lookup lands near the target rather than exactly on it, so after the binary search Kafka scans forward a bounded amount (at most the index interval) to the precise record. That bounded scan is a few kilobytes, negligible, so the sparse index gives you effectively O(1) offset lookup with a cache-resident structure — the classic space-versus-precision trade resolved in favour of keeping the index small.

**Q: What does it mean to "roll" a segment, and why does segment size affect retention?**
A: Rolling is closing the active segment and opening a new one when the active segment reaches `segment.bytes` or `segment.ms`. The closed segment becomes immutable, and the new segment's filename is the next base offset. Segment size affects retention because retention and compaction operate on whole *closed* segments — Kafka deletes or rewrites entire segment files, never edits within one. So if `segment.bytes` is very large on a low-throughput topic, records can live well past their nominal `retention.ms` simply because the segment they are in has not yet rolled and been closed, so it cannot be dropped. Sizing segments relative to throughput and retention keeps retention granular; oversized segments make retention lag.

## 10. Quick Revision & Cheat Sheet

| Mechanism | What it buys | How to keep it |
|---|---|---|
| Sequential append-only writes | Near-memory write throughput, no seeks | Never update in place; roll whole segments |
| OS page cache (not heap) | GC-free, restart-warm, all-RAM message cache | Small heap, lots of RAM |
| Zero-copy `sendfile` | Cheap fan-out, no user-space copies | Avoid TLS/transcoding on the hot path |
| Sparse `.index` / `.timeindex` | O(1) offset/time lookup, cache-resident | Keep `index.interval.bytes` sane (4 KB) |
| Replicated durability (not fsync) | Speed without per-write disk flush | `acks=all` + RF≥3, spread across AZs |

| File | Contents |
|---|---|
| `<base>.log` | Record batches, in order |
| `<base>.index` | Sparse offset → byte position |
| `<base>.timeindex` | Sparse timestamp → offset |

**Flash cards**
- **Why is sequential disk fast?** → No seeks; hundreds of MB/s vs a few MB/s random — near memory bandwidth.
- **Heap size?** → Small (a few GB); give the rest of RAM to the page cache.
- **Zero-copy call?** → `sendfile` / `FileChannel.transferTo`: page cache → socket, no user-space copy.
- **What defeats zero-copy?** → TLS, re-compression/transcoding, message-format down-conversion.
- **Sparse index?** → One entry per `index.interval.bytes`; binary-search then short scan.
- **Durability without fsync?** → Replication: `acks=all` + RF=3 across AZs.

## 11. Hands-On Exercises & Mini Project

- [ ] Produce a few thousand records to a topic, then `ls` the partition directory and identify the closed segments, the active segment, and the three files per segment.
- [ ] Run `kafka-dump-log.sh --print-data-log` on a segment and read off base offsets, record counts, compression codec and timestamps.
- [ ] Dump a `.index` and count its entries against the record count in the `.log` to see how sparse it is; change `index.interval.bytes` and observe the difference.
- [ ] Set a small `segment.bytes` and watch segments roll frequently as you produce; then set a large one and observe retention lagging on a low-throughput topic.
- [ ] Measure consumer throughput with plaintext, then enable TLS on the client listener and measure again; attribute the drop to zero-copy being defeated.
- [ ] Run the broker with a deliberately large heap and a tiny one on the same load and compare GC time and throughput.

### Mini Project — "See the Log on Disk"

**Goal.** Make Kafka's storage model tangible by reading the raw files and demonstrating the performance mechanisms rather than taking them on faith.

**Requirements.**
1. Stand up a single broker, create a topic with a small `segment.bytes` and default index interval, and produce a keyed, compressed stream of records.
2. Using `ls` and `kafka-dump-log.sh`, map the partition directory: list segments by base offset, dump one segment's records, and dump its offset and time indexes.
3. Given a target offset, hand-trace the lookup: find the segment by base offset, find the nearest index entry, and confirm the byte position points into the right region of the `.log`.
4. Demonstrate the page cache: produce a burst, then time a consumer reading the tail (served from cache) versus reading from offset 0 after dropping caches (served from disk), and explain the difference.
5. Demonstrate the zero-copy cost: measure fan-out throughput to several consumers with plaintext vs TLS and quantify the loss.

**Extensions.**
- Enable tiered storage (or simulate it) and show old segments offloaded while the hot set stays local; discuss decoupling retention from local-disk cost.
- Corrupt or delete a `.index` file and restart the broker; observe Kafka rebuilding the index from the `.log` on recovery and time how long it takes.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *The Log: Offsets, Segments & Retention* (the log abstraction these files implement), *Replication: ISR, Leader Election & min.insync.replicas* (why replication substitutes for fsync), *KRaft & the Death of ZooKeeper* (metadata storage as its own log), *Producers: Batching, Compression & Idempotence* (batching that amortises I/O), *Design: Kafka vs RabbitMQ* (how the storage model shapes the choice).

- **Apache Kafka — Persistence & Efficiency (Design)** — Apache · *Advanced* · the canonical explanation of sequential I/O, the page cache and zero-copy, straight from the Kafka design docs. <https://kafka.apache.org/documentation/#persistence>
- **The Log: What every software engineer should know** — Jay Kreps · *Advanced* · the essay that frames the append-only log as the foundational structure Kafka's storage implements. <https://engineering.linkedin.com/distributed-systems/log-what-every-software-engineer-should-know-about-real-time-datas-unifying>
- **Efficient data transfer through zero copy** — IBM Developer (Sathish Palaniappan) · *Advanced* · the classic walkthrough of `sendfile`, `transferTo` and why zero-copy eliminates the extra copies and context switches. <https://developer.ibm.com/articles/j-zerocopy/>
- **Kafka: The Definitive Guide, ch. 5 (Kafka Internals)** — Narkhede, Shapira & Palino · *Advanced* · segments, indexes, the page cache and the physical layout in book-length depth. <https://www.confluent.io/resources/kafka-the-definitive-guide/>
- **Confluent — Kafka Tiered Storage (KIP-405)** — Confluent/Apache · *Advanced* · offloading cold segments to object storage while keeping the hot set local; the modern answer to storage scaling. <https://cwiki.apache.org/confluence/display/KAFKA/KIP-405%3A+Kafka+Tiered+Storage>
- **Brendan Gregg — The page cache and Linux I/O** — Brendan Gregg · *Advanced* · how the OS page cache actually behaves, essential background for reasoning about Kafka's read/write paths. <https://www.brendangregg.com/blog/>
- **Confluent — Tuning Kafka for throughput and latency** — Confluent · *Intermediate* · practical guidance on heap sizing, page-cache reliance and segment tuning consistent with this chapter. <https://docs.confluent.io/kafka/operations-tools/kafka-tuning.html>
- **Designing Data-Intensive Applications, ch. 3 (Storage & Retrieval)** — Martin Kleppmann · *Advanced* · why log-structured storage and sequential writes are fast, the general theory behind Kafka's choices. <https://dataintensive.net/>

---

*Kafka & RabbitMQ Handbook — chapter 18.*
