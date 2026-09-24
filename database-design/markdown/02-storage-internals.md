# 02 · Storage Internals: Pages, Heaps & B-Trees on Disk

> **In one line:** A database never reads a row — it reads a page — so every performance property you care about (lookup cost, scan speed, write cost, table size, cache fit) is decided by how rows are packed into 8 KB pages and how those pages are arranged, cached and rewritten on the device.

---

## 1. Overview

> **Builds on:** [SQL Handbook · Indexes: B-Tree, Composite & Covering](../sql/topic.html?p=19-indexes) (what an index is) · [SQL Handbook · Index Design & Sargability](../sql/topic.html?p=20-index-design) (which indexes to build) · [Ch 01 · Database Architecture](topic.html?p=01-database-architecture) (where the buffer pool sits). This chapter does not re-teach index types or column order; it goes one level down to the bytes: what a page looks like, why a B-tree is three or four pages deep, why random UUID keys make indexes twice as big, and why SSDs still care about write patterns.

The SQL Handbook told you an index turns an O(n) scan into an O(log n) lookup. That is true and nearly useless for design, because the constant that matters is not comparisons — it is **pages touched**, and whether each of those pages was in memory. A lookup that touches four pages all in the buffer pool takes microseconds; the same lookup with two cache misses on network block storage takes a couple of milliseconds. A table whose rows are 40% dead space needs 40% more memory to stay cached. An index built on random keys has half-empty pages and so needs twice the memory of the same index built on sequential keys. None of this shows up in the SQL; all of it shows up in the p99.

The naive model is "a table is a list of rows in a file, and an index is a sorted list of keys pointing into it". It fails because it hides the unit of I/O. Disks and SSDs, the OS and the database all move data in fixed-size **blocks** — 8 KB pages in PostgreSQL, 16 KB in InnoDB. Changing one byte of one row means reading, dirtying and eventually rewriting an entire page, logging the change, and (right after a checkpoint) logging a full image of the page. Reading one row means pulling its whole page into the cache, along with the index pages above it. Once you think in pages, most storage folklore becomes arithmetic you can do on a whiteboard.

> **Why this matters:** capacity planning, key choice (bigint vs UUIDv4 vs UUIDv7), column order, `fillfactor`, partitioning, and "why did this table double in size" are all page-level questions. Chapter 22's capacity math starts here.

## 2. Core Concepts

- **Page / block** — the fixed-size unit of storage and I/O: 8 KB in PostgreSQL (compile-time), 16 KB default in InnoDB. *Why it matters:* the cost of a read or write is per page, not per row.
- **Heap** — PostgreSQL's table storage: an unordered collection of pages where new rows go wherever there is free space. *Why it matters:* no inherent order, so range scans on anything but insertion order may hit many pages.
- **Tuple** — one physical version of a row in a heap page, with a ~23-byte header (xmin, xmax, ctid, infomask…). *Why it matters:* the header is per version, so narrow rows pay a large relative overhead, and every UPDATE creates a new tuple (chapter 03).
- **Line pointer (item id)** — a 4-byte slot at the start of a page pointing at a tuple's offset. *Why it matters:* tuples can move within a page (compaction) without changing their external address.
- **ctid** — a tuple's physical address `(block number, line pointer)`. *Why it matters:* PostgreSQL indexes point at ctids, so a row that moves to a new page needs new index entries (unless HOT).
- **TOAST** — out-of-line storage for large values (> roughly 2 KB after compression) in a side table. *Why it matters:* big JSON/text columns do not bloat the main heap, but reading them costs extra page fetches.
- **Fillfactor** — the percentage of a page filled on insert, leaving room for future updates. *Why it matters:* free space on the same page enables HOT updates and fewer page splits.
- **B-tree page** — root, internal and leaf pages; leaves hold `(key, pointer)` entries in order and are linked to siblings. *Why it matters:* height, fanout and page density determine lookup cost and index size.
- **Fanout** — how many children an internal page has (hundreds for small keys). *Why it matters:* height is `log_fanout(rows)`, so fanout is why billion-row indexes are only 4–5 levels deep.
- **Page split** — when an insert targets a full B-tree page, it is split into two roughly half-full pages. *Why it matters:* random-key inserts cause splits everywhere, leaving pages ~70% full and scattering writes.
- **Sequential vs random I/O** — reading adjacent blocks versus jumping around. *Why it matters:* on spinning disks the gap is ~100×; on SSDs it is smaller but still real, and on cloud storage every I/O costs IOPS budget.
- **Buffer pool / cache hit** — the in-memory page cache (chapter 01). *Why it matters:* storage layout decides how many distinct pages your working set needs.
- **Read / write / space amplification** — bytes physically read, written or stored per logical byte. *Why it matters:* every storage engine trades these three against each other (the RUM trade-off); B-trees and LSM trees sit at different points.
- **Data locality / correlation** — how well the physical order of rows matches the order you query them in. *Why it matters:* high correlation turns 1,000 random heap fetches into a handful of sequential pages.

## 3. Theory & Principles

### Anatomy of a PostgreSQL heap page

Every 8 KB heap page has the same layout. A 24-byte **page header** records the page's LSN (for the WAL rule), checksum, flags and two offsets: `pd_lower` (end of the line-pointer array) and `pd_upper` (start of tuple data). The **line-pointer array** grows forward from the header, 4 bytes per item. **Tuples** are placed from the end of the page backward. The gap between `pd_lower` and `pd_upper` is the page's free space. Heap pages have no **special space**; index pages use it for sibling links and flags.

```svg
<svg viewBox="0 0 880 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c02a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">One 8 KB PostgreSQL heap page (block 812 of table accounts)</text>

  <rect x="40" y="44" width="800" height="36" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="120" y="66" text-anchor="middle" fill="#5b21b6" font-weight="bold">Page header 24 B</text>
  <text x="480" y="66" text-anchor="middle" fill="#5b21b6" font-size="10">pd_lsn (last WAL record) · pd_checksum · pd_flags · pd_lower · pd_upper · pd_special · pd_prune_xid</text>

  <rect x="40" y="80" width="60" height="30" fill="#dbeafe" stroke="#2563eb"/><text x="70" y="99" text-anchor="middle" fill="#1e40af" font-size="10">lp 1</text>
  <rect x="100" y="80" width="60" height="30" fill="#dbeafe" stroke="#2563eb"/><text x="130" y="99" text-anchor="middle" fill="#1e40af" font-size="10">lp 2</text>
  <rect x="160" y="80" width="60" height="30" fill="#dbeafe" stroke="#2563eb"/><text x="190" y="99" text-anchor="middle" fill="#1e40af" font-size="10">lp 3</text>
  <rect x="220" y="80" width="60" height="30" fill="#dbeafe" stroke="#2563eb"/><text x="250" y="99" text-anchor="middle" fill="#1e40af" font-size="10">lp 4</text>
  <text x="300" y="99" fill="#1e40af" font-size="10">line pointers, 4 B each, grow →</text>
  <text x="40" y="126" fill="#334155" font-size="9">pd_lower ↑ (end of line-pointer array)</text>

  <rect x="40" y="134" width="800" height="110" fill="#f8fafc" stroke="#94a3b8" stroke-dasharray="5 3"/>
  <text x="440" y="186" text-anchor="middle" fill="#334155" font-size="13" font-weight="bold">FREE SPACE</text>
  <text x="440" y="206" text-anchor="middle" fill="#334155" font-size="10">new tuples and new line pointers meet in the middle · fillfactor reserves part of it for UPDATEs (HOT)</text>

  <text x="838" y="258" text-anchor="end" fill="#334155" font-size="9">pd_upper ↓ (start of tuple data)</text>
  <rect x="40" y="264" width="200" height="60" fill="#dcfce7" stroke="#16a34a"/>
  <text x="140" y="284" text-anchor="middle" fill="#15803d" font-weight="bold">tuple 4 (newest)</text>
  <text x="140" y="300" text-anchor="middle" fill="#166534" font-size="9">header 23 B + null bitmap</text>
  <text x="140" y="314" text-anchor="middle" fill="#166534" font-size="9">+ aligned column data</text>
  <rect x="240" y="264" width="200" height="60" fill="#dcfce7" stroke="#16a34a"/><text x="340" y="298" text-anchor="middle" fill="#15803d" font-weight="bold">tuple 3</text>
  <rect x="440" y="264" width="200" height="60" fill="#fee2e2" stroke="#dc2626"/><text x="540" y="290" text-anchor="middle" fill="#b91c1c" font-weight="bold">tuple 2 (dead version)</text><text x="540" y="306" text-anchor="middle" fill="#7f1d1d" font-size="9">space reclaimed only by prune/VACUUM</text>
  <rect x="640" y="264" width="200" height="60" fill="#dcfce7" stroke="#16a34a"/><text x="740" y="298" text-anchor="middle" fill="#15803d" font-weight="bold">tuple 1 (oldest)</text>
  <text x="440" y="340" text-anchor="middle" fill="#334155" font-size="10">← tuples are placed from the END of the page backwards</text>

  <path d="M70,112 C70,230 700,230 740,262" stroke="#2563eb" stroke-width="1.5" fill="none" marker-end="url(#c02a)"/>
  <path d="M130,112 C150,220 520,220 540,262" stroke="#2563eb" stroke-width="1.5" fill="none" marker-end="url(#c02a)"/>

  <rect x="40" y="356" width="800" height="60" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="56" y="376" fill="#92400e" font-size="10" font-weight="bold">Tuple header fields: t_xmin · t_xmax · t_cid · t_ctid (6 B: block, item) · t_infomask/t_infomask2 (hint bits, lock bits, HOT flags) · t_hoff</text>
  <text x="56" y="394" fill="#92400e" font-size="10">An index entry stores ctid = (812, 2). The line pointer indirection lets the page compact tuples without touching indexes.</text>
  <text x="56" y="410" fill="#92400e" font-size="10">Rows larger than ~2 KB are compressed and/or moved to the TOAST table in ~2 KB chunks.</text>
</svg>
```

Three consequences follow directly from this layout:

1. **Per-row overhead is large for narrow rows.** A row of two `integer` columns carries ~24 bytes of header + 8 bytes of data + a 4-byte line pointer — 36 bytes to store 8 bytes of payload. A "tiny" 1-billion-row junction table is therefore ~40+ GB before any index.
2. **Column order costs space.** Fixed-width columns are aligned (`bigint`, `timestamptz` on 8 bytes). A layout of `(flag boolean, id bigint, active boolean, created_at timestamptz)` wastes 14 bytes of padding per row; ordering columns from widest fixed-width to narrowest, variable-width last, removes it.
3. **Addresses are physical.** An index entry points at `(block, item)`. If an UPDATE cannot fit the new version on the same page, the new version gets a new ctid and *every* index on the table needs a new entry. If it can — and no indexed column changed — PostgreSQL does a **HOT (heap-only tuple)** update: the old tuple points to the new one within the page and indexes are untouched. Leaving free space with `fillfactor` (say 80–90 for update-heavy tables) is how you make HOT likely.

> **MySQL difference:** InnoDB has no heap. A table *is* a B-tree clustered on the primary key: leaf pages (16 KB) hold whole rows in PK order, and secondary indexes store the **primary key value** instead of a physical address. Consequences: PK range scans are sequential and fast; a secondary-index lookup costs two B-tree descents; a wide PK (e.g. a 36-character UUID string) is copied into every secondary index; and a random PK causes page splits in the *table itself*, not just an index. Rows move freely during splits without touching secondary indexes, which is the mirror image of PostgreSQL's trade-off.

### B-tree internals: page layout, fanout and height

A PostgreSQL B-tree (the `nbtree` access method, a Lehman–Yao variant with right-links for high concurrency) is made of the same 8 KB pages. Page 0 is a **metapage** pointing at the root. **Internal pages** hold separator keys and downlinks to child pages; **leaf pages** hold `(key, ctid)` index tuples in key order plus a **high key** (upper bound of the page) and left/right sibling links in the special space. A lookup descends from root to leaf, reading one page per level; a range scan finds the first leaf and then walks right along the sibling chain.

Height is the only thing that matters for point-lookup cost, and it follows from **fanout**. For a `bigint` key, an index tuple is 16 bytes (8-byte header + 8-byte key) plus a 4-byte line pointer: ~20 bytes. An 8 KB page therefore holds roughly 400 entries, or ~367 at the default leaf `fillfactor` of 90.

```text
100 million rows, bigint primary key
  leaf pages      ≈ 100,000,000 / 367      ≈ 272,000 pages  ≈ 2.1 GB
  level 1 pages   ≈ 272,000 / ~400         ≈ 680 pages      ≈ 5.4 MB
  level 2 pages   ≈ 680 / ~400             ≈ 2 pages
  root            = 1 page
  height          = 4 page reads per lookup (root → L2 → L1 → leaf) + 1 heap page

  capacity per extra level ×400:  3 levels ≈ 60M entries · 4 levels ≈ 25B entries
```

Two things to notice. First, the upper levels are tiny (a few MB even for 100M rows), so they are always cached; a cold lookup really costs *one* leaf page miss plus *one* heap page miss. Second, the index's size is dominated by leaves, so **leaf density** is what decides whether an index fits in memory. That is where key choice and page splits come in.

```svg
<svg viewBox="0 0 880 440" width="100%" height="440" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c02b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
    <marker id="c02c" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">B-tree lookup of id = 73,450,012: one page per level, then the heap</text>

  <rect x="370" y="40" width="140" height="40" rx="6" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="440" y="57" text-anchor="middle" fill="#5b21b6" font-weight="bold">root (level 3)</text>
  <text x="440" y="71" text-anchor="middle" fill="#5b21b6" font-size="9">2 downlinks</text>
  <rect x="200" y="110" width="140" height="40" rx="6" fill="#ede9fe" stroke="#7c3aed"/><text x="270" y="134" text-anchor="middle" fill="#5b21b6" font-size="10">level 2 · ~340 links</text>
  <rect x="540" y="110" width="140" height="40" rx="6" fill="#ede9fe" stroke="#7c3aed" stroke-width="2.5"/><text x="610" y="134" text-anchor="middle" fill="#5b21b6" font-size="10">level 2 · ~340 links</text>
  <path d="M440,82 L270,108" stroke="#94a3b8" stroke-width="1.5"/>
  <path d="M440,82 L608,106" stroke="#16a34a" stroke-width="2.5" marker-end="url(#c02c)"/>

  <rect x="430" y="180" width="130" height="40" rx="6" fill="#dbeafe" stroke="#2563eb"/><text x="495" y="204" text-anchor="middle" fill="#1e40af" font-size="10">level 1</text>
  <rect x="580" y="180" width="130" height="40" rx="6" fill="#dbeafe" stroke="#2563eb" stroke-width="2.5"/><text x="645" y="198" text-anchor="middle" fill="#1e40af" font-size="10">level 1</text><text x="645" y="212" text-anchor="middle" fill="#1e40af" font-size="9">~400 downlinks</text>
  <rect x="730" y="180" width="110" height="40" rx="6" fill="#dbeafe" stroke="#2563eb"/><text x="785" y="204" text-anchor="middle" fill="#1e40af" font-size="10">level 1</text>
  <path d="M610,152 L495,178" stroke="#94a3b8" stroke-width="1.5"/>
  <path d="M610,152 L643,176" stroke="#16a34a" stroke-width="2.5" marker-end="url(#c02c)"/>
  <path d="M610,152 L785,178" stroke="#94a3b8" stroke-width="1.5"/>

  <rect x="380" y="250" width="120" height="50" rx="6" fill="#dcfce7" stroke="#16a34a"/><text x="440" y="272" text-anchor="middle" fill="#15803d" font-size="10">leaf</text><text x="440" y="287" text-anchor="middle" fill="#166534" font-size="9">…450,011</text>
  <rect x="520" y="250" width="160" height="50" rx="6" fill="#dcfce7" stroke="#16a34a" stroke-width="2.5"/><text x="600" y="268" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">leaf: ~367 keys</text><text x="600" y="283" text-anchor="middle" fill="#166534" font-size="9">73,450,012 → ctid (1204877, 9)</text><text x="600" y="295" text-anchor="middle" fill="#166534" font-size="9">high key · left/right links</text>
  <rect x="700" y="250" width="120" height="50" rx="6" fill="#dcfce7" stroke="#16a34a"/><text x="760" y="279" text-anchor="middle" fill="#15803d" font-size="10">leaf</text>
  <path d="M502,275 L518,275" stroke="#16a34a" stroke-width="1.5"/>
  <path d="M682,275 L698,275" stroke="#16a34a" stroke-width="1.5"/>
  <text x="600" y="316" text-anchor="middle" fill="#166534" font-size="9">sibling chain → range scans walk right without re-descending</text>
  <path d="M645,222 L603,248" stroke="#16a34a" stroke-width="2.5" marker-end="url(#c02c)"/>

  <rect x="520" y="340" width="220" height="44" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="630" y="358" text-anchor="middle" fill="#92400e" font-weight="bold">heap page 1204877</text>
  <text x="630" y="374" text-anchor="middle" fill="#92400e" font-size="9">line pointer 9 → the row (check visibility)</text>
  <path d="M600,302 L620,338" stroke="#d97706" stroke-width="2.5" marker-end="url(#c02b)"/>

  <rect x="30" y="100" width="150" height="290" rx="10" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="105" y="122" text-anchor="middle" fill="#1e293b" font-weight="bold">Cost of this lookup</text>
  <text x="44" y="146" fill="#334155" font-size="10">root: cached</text>
  <text x="44" y="164" fill="#334155" font-size="10">level 2: cached</text>
  <text x="44" y="182" fill="#334155" font-size="10">level 1 (~680 pages):</text>
  <text x="44" y="196" fill="#334155" font-size="10">  almost always cached</text>
  <text x="44" y="220" fill="#b91c1c" font-size="10">leaf (272k pages, 2.1 GB):</text>
  <text x="44" y="234" fill="#b91c1c" font-size="10">  hit or MISS</text>
  <text x="44" y="258" fill="#b91c1c" font-size="10">heap (millions of pages):</text>
  <text x="44" y="272" fill="#b91c1c" font-size="10">  hit or MISS</text>
  <text x="44" y="300" fill="#1e293b" font-size="10" font-weight="bold">Worst case = 2 misses</text>
  <text x="44" y="318" fill="#334155" font-size="10">NVMe: ~0.1–0.2 ms</text>
  <text x="44" y="334" fill="#334155" font-size="10">EBS-class: ~1–2 ms</text>
  <text x="44" y="358" fill="#334155" font-size="10">all hits: ~10–30 µs</text>
  <text x="44" y="376" fill="#15803d" font-size="10">index-only scan: skip heap</text>
  <text x="440" y="416" text-anchor="middle" fill="#334155" font-size="10">Height grows by one level per ~400× more rows; density of LEAVES decides memory footprint.</text>
</svg>
```

### Page splits, key order and why UUIDv4 hurts

When an insert targets a full leaf, the B-tree **splits** it: allocate a new page, move roughly half the entries across, insert a new downlink in the parent (which may itself split). Two very different patterns emerge:

- **Monotonic keys** (bigserial/identity, timestamps, UUIDv7): every insert lands on the rightmost leaf. PostgreSQL recognises this and does a *rightmost split* that leaves the old page packed to `fillfactor` rather than half-empty. Result: leaves ~90% full, only one "hot" leaf in memory for inserts, sequential-ish writes.
- **Random keys** (UUIDv4, hashes): inserts land on a random leaf anywhere in the index. Every leaf is a candidate for a write, so the *entire* index is the insert working set; splits happen everywhere and leave pages half full, converging on the classic ~69% average density (ln 2) for random insertion. Each insert likely dirties a different page, so checkpoints write far more pages and each first-touch after a checkpoint produces a full-page image in WAL.

```svg
<svg viewBox="0 0 880 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Where inserts land: sequential keys vs random keys</text>

  <rect x="20" y="40" width="410" height="270" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="225" y="62" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">bigint identity / UUIDv7 (monotonic)</text>
  <rect x="40" y="80" width="60" height="70" fill="#16a34a" stroke="#15803d"/><rect x="110" y="80" width="60" height="70" fill="#16a34a" stroke="#15803d"/><rect x="180" y="80" width="60" height="70" fill="#16a34a" stroke="#15803d"/><rect x="250" y="80" width="60" height="70" fill="#16a34a" stroke="#15803d"/>
  <rect x="320" y="80" width="60" height="70" fill="#dcfce7" stroke="#dc2626" stroke-width="2.5"/><rect x="320" y="118" width="60" height="32" fill="#16a34a"/>
  <text x="70" y="168" text-anchor="middle" fill="#166534" font-size="9">90%</text><text x="140" y="168" text-anchor="middle" fill="#166534" font-size="9">90%</text><text x="210" y="168" text-anchor="middle" fill="#166534" font-size="9">90%</text><text x="280" y="168" text-anchor="middle" fill="#166534" font-size="9">90%</text><text x="350" y="168" text-anchor="middle" fill="#b91c1c" font-size="9">hot leaf</text>
  <text x="40" y="196" fill="#166534" font-size="10">• all inserts hit the rightmost leaf (1 page hot)</text>
  <text x="40" y="214" fill="#166534" font-size="10">• rightmost split keeps old page at fillfactor</text>
  <text x="40" y="232" fill="#166534" font-size="10">• dense leaves → smaller index, better cache fit</text>
  <text x="40" y="250" fill="#166534" font-size="10">• few distinct dirty pages per checkpoint</text>
  <text x="40" y="268" fill="#166534" font-size="10">• new rows adjacent → range scans by time are local</text>
  <text x="40" y="292" fill="#15803d" font-size="10" font-weight="bold">Risk: single-page contention at very high insert rates</text>

  <rect x="450" y="40" width="410" height="270" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="655" y="62" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">UUIDv4 / hash keys (random)</text>
  <rect x="470" y="80" width="60" height="70" fill="#fee2e2" stroke="#dc2626"/><rect x="470" y="110" width="60" height="40" fill="#dc2626"/>
  <rect x="540" y="80" width="60" height="70" fill="#fee2e2" stroke="#dc2626"/><rect x="540" y="96" width="60" height="54" fill="#dc2626"/>
  <rect x="610" y="80" width="60" height="70" fill="#fee2e2" stroke="#dc2626"/><rect x="610" y="116" width="60" height="34" fill="#dc2626"/>
  <rect x="680" y="80" width="60" height="70" fill="#fee2e2" stroke="#dc2626"/><rect x="680" y="100" width="60" height="50" fill="#dc2626"/>
  <rect x="750" y="80" width="60" height="70" fill="#fee2e2" stroke="#dc2626"/><rect x="750" y="112" width="60" height="38" fill="#dc2626"/>
  <text x="640" y="168" text-anchor="middle" fill="#7f1d1d" font-size="9">every leaf is a write target · average ~69% full</text>
  <text x="470" y="196" fill="#7f1d1d" font-size="10">• whole index must stay cached to insert fast</text>
  <text x="470" y="214" fill="#7f1d1d" font-size="10">• splits everywhere → half-empty pages</text>
  <text x="470" y="232" fill="#7f1d1d" font-size="10">• 16-byte key vs 8 → wider entries, lower fanout</text>
  <text x="470" y="250" fill="#7f1d1d" font-size="10">• many dirty pages → more checkpoint writes + FPIs</text>
  <text x="470" y="268" fill="#7f1d1d" font-size="10">• InnoDB: the TABLE itself splits (clustered PK)</text>
  <text x="470" y="292" fill="#b91c1c" font-size="10" font-weight="bold">Typical result: index ~2× larger, insert rate falls off a cliff</text>
</svg>
```

> **Interview tip:** "UUIDs are bad for indexes" is incomplete. *Random* UUIDs are bad for B-tree locality; time-ordered UUIDv7 keeps global uniqueness and client-side generation while behaving almost like a sequence. PostgreSQL 18 ships a `uuidv7()` function; on earlier versions generate them in the application or with an extension.

### Sequential vs random I/O and what SSDs change

On a spinning disk, a random read costs a seek plus rotational latency (~5–10 ms), giving ~100–200 random IOPS, while sequential reads stream at 100–250 MB/s — a ~100× gap per byte. That gap is why PostgreSQL's default `random_page_cost` is 4.0 against `seq_page_cost` 1.0 (already discounted, since many "random" reads hit cache).

SSDs have no seek, so random reads are fast — tens of thousands to hundreds of thousands of IOPS locally, with latencies on the order of 10–100 µs. But three things keep layout relevant:

1. **SSDs cannot overwrite in place.** NAND flash is written in *pages* (a few KB to 16 KB) but erased only in much larger *erase blocks* (hundreds of pages). The drive's flash translation layer (FTL) writes updates to fresh pages and later **garbage-collects** partially-dead erase blocks by copying live pages out. That copying is **device-level write amplification**: small random writes across the drive cost more physical writes than large sequential ones, consume endurance (DWPD/TBW ratings), and cause latency spikes when GC runs under load. Free space (over-provisioning, TRIM/discard) reduces it.
2. **Sequential is still cheaper per byte**, because it enables read-ahead, larger I/Os and fewer requests. PostgreSQL 17's streaming read path combines adjacent block reads into larger I/Os (`io_combine_limit`).
3. **Cloud block storage bills per I/O.** An AWS gp3 volume starts at a 3,000 IOPS / 125 MB/s baseline; a query plan that does 50,000 random heap fetches spends a whole second of that volume's IOPS budget. Locality is money.

### The buffer pool and access patterns

The buffer pool (chapter 01) caches pages, not rows, so the question is always *how many distinct pages does my working set span?* Two tables with the same rows can have very different answers: one with 90% dense pages and good locality, one bloated to 40% density with hot rows scattered across millions of pages. PostgreSQL also protects the pool from being flushed by big scans: a sequential scan of a table larger than a quarter of `shared_buffers` uses a small **ring buffer** of pages that it recycles, as do VACUUM and bulk writes. So a nightly report's full scan does not evict the OLTP working set — but a query that does millions of *index* fetches across a huge table will.

**Correlation** is the planner's measure of locality: `pg_stats.correlation` near ±1 means the physical row order tracks the column's order (e.g. `created_at` on an append-only table), so an index range scan touches few, adjacent heap pages. Near 0 means each matching row is on a different page. You can improve locality with `CLUSTER` (a one-off rewrite under an exclusive lock), by partitioning on the access key, or by choosing keys that insert in access order. BRIN indexes exploit high correlation directly by storing per-block-range min/max summaries.

### Storage amplification: B-tree vs LSM

Every storage engine trades three costs, often called the **RUM** trade-off (Read, Update, Memory/space): you can minimise any two only at the expense of the third.

- **Read amplification** — pages read per logical lookup. B-tree: height (mostly cached) + heap. LSM: possibly one probe per level/SSTable, mitigated by bloom filters.
- **Write amplification** — bytes written to the device per logical byte changed. B-tree: a 100-byte change dirties an 8 KB page (written at the next checkpoint, amortised if many changes hit the same page), plus WAL, plus a full-page image on first touch after a checkpoint, plus index maintenance for non-HOT updates. LSM: data is written to a WAL and memtable, flushed sequentially as an SSTable, then rewritten repeatedly by compaction — often an order of magnitude or more for leveled compaction, but as large sequential writes.
- **Space amplification** — bytes stored per logical byte. B-tree: free space in pages (fillfactor, split leftovers, bloat from dead tuples). LSM: obsolete versions and tombstones until compaction; low for leveled, up to ~2× transiently for size-tiered.

| | B-tree (PostgreSQL heap + nbtree, InnoDB) | LSM (RocksDB, Cassandra, MyRocks) |
|---|---|---|
| Write pattern | In-place page updates (random) + sequential WAL | Append-only, sequential flushes + compaction |
| Point read | 1 path, predictable | Several levels, bloom filters needed |
| Range scan | Excellent (sorted leaves) | Good, merges across levels |
| Write amp | Page-granular, FPIs, index churn | Compaction rewrites |
| Space amp | Fragmentation, bloat | Stale versions until compaction |
| Fits | Read-heavy and mixed OLTP | Write-heavy ingest, time series, huge keyspaces |

For the Cassandra side of this in depth see [Cassandra · Compaction Strategies](../cassandra/topic.html?p=23-compaction-strategies) and [Cassandra · SSTable Format](../cassandra/topic.html?p=26-storage-engine-sstable-format).

## 4. Architecture & Workflow

### Files on disk

```text
$PGDATA/base/16384/            ← one directory per database (OID 16384)
    24576                      ← main fork of table "accounts" (relfilenode 24576), first 1 GB
    24576.1                    ← second 1 GB segment
    24576_fsm                  ← free space map: which pages have room for new tuples
    24576_vm                   ← visibility map: 2 bits/page — all-visible, all-frozen
    24583                      ← accounts_pkey (B-tree), block 0 = metapage
$PGDATA/pg_wal/                ← WAL segments, 16 MB each
```

`SELECT pg_relation_filepath('accounts');` tells you the file. The **free space map** is how an INSERT finds a page with room (and why a table with scattered free space reuses it instead of growing). The **visibility map** marks pages whose tuples are all visible to everyone: index-only scans skip the heap for those pages, and VACUUM skips them.

### Workflow: an INSERT and an UPDATE at page level

```text
INSERT INTO accounts VALUES (100000001, 'new', 0);
  1. heap: ask FSM for a page with ≥ tuple size free → none → extend file by a page (block 1204880)
  2. heap: add line pointer + tuple at pd_upper; WAL record; page dirty
  3. nbtree accounts_pkey: descend to rightmost leaf; room? insert (key, ctid(1204880,1))
         no room? rightmost split → new leaf, downlink added to level-1 parent
  4. every OTHER index on the table: same descent + insert (random places if keys random)

UPDATE accounts SET balance = 50 WHERE id = 42;   -- balance not indexed
  1. find old tuple via pkey → (812, 4)
  2. page 812 has free space (fillfactor 90) → HOT: new tuple on same page,
     old tuple t_ctid → new, flagged HEAP_HOT_UPDATED; NO index writes
  3. page 812 full → non-HOT: new tuple on another page, new entries in ALL indexes
```

The non-HOT path is why write-heavy tables with many indexes are expensive: a single-column update becomes N+1 page modifications. Monitor `n_tup_hot_upd / n_tup_upd` in `pg_stat_user_tables`; a low ratio on an update-heavy table suggests lowering `fillfactor` or dropping an index on a frequently changed column.

## 5. Implementation

### Simple example: look inside a page with pageinspect

```sql
CREATE EXTENSION IF NOT EXISTS pageinspect;
CREATE TABLE t (id int, name text);
INSERT INTO t VALUES (1,'a'), (2,'bb'), (3,'ccc');

SELECT lower, upper, special, pagesize FROM page_header(get_raw_page('t', 0));
SELECT lp, lp_off, lp_len, t_xmin, t_xmax, t_ctid
FROM heap_page_items(get_raw_page('t', 0));
```

```text
 lower | upper | special | pagesize
-------+-------+---------+----------
    36 |  8096 |    8192 |     8192          ← 24 B header + 3×4 B line pointers; tuples from 8096 to the end

 lp | lp_off | lp_len | t_xmin | t_xmax | t_ctid
----+--------+--------+--------+--------+--------
  1 |   8160 |     30 |    751 |      0 | (0,1)
  2 |   8128 |     31 |    751 |      0 | (0,2)
  3 |   8096 |     32 |    751 |      0 | (0,3)
```

A 30-byte tuple to store an int and one character: 24 bytes of header, 4 of int, 2 of short varlena text. Now update one row and look again:

```sql
UPDATE t SET name = 'z' WHERE id = 1;
SELECT lp, lp_off, t_xmin, t_xmax, t_ctid FROM heap_page_items(get_raw_page('t', 0));
```

```text
 lp | lp_off | t_xmin | t_xmax | t_ctid
----+--------+--------+--------+--------
  1 |   8160 |    751 |    752 | (0,4)     ← old version: xmax set, ctid points at the new one
  2 |   8128 |    751 |      0 | (0,2)
  3 |   8096 |    751 |      0 | (0,3)
  4 |   8064 |    752 |      0 | (0,4)     ← new version, same page (HOT)
```

The "update" was an insert plus a pointer — the physical basis of MVCC ([Ch 03](topic.html?p=03-mvcc)).

### Inspect a B-tree's height and density

```sql
CREATE TABLE big (id bigint PRIMARY KEY, u uuid DEFAULT gen_random_uuid());
INSERT INTO big (id) SELECT g FROM generate_series(1, 10000000) g;
CREATE INDEX big_u ON big (u);

SELECT level, root FROM bt_metap('big_pkey');       -- level = height - 1
CREATE EXTENSION IF NOT EXISTS pgstattuple;
SELECT i AS idx, s.tree_level, s.index_size, s.leaf_pages, s.avg_leaf_density, s.leaf_fragmentation
FROM unnest(ARRAY['big_pkey', 'big_u']) AS i, LATERAL pgstatindex(i) AS s;
```

```text
   idx    | tree_level | index_size | leaf_pages | avg_leaf_density | leaf_fragmentation
----------+------------+------------+------------+------------------+-------------------
 big_pkey |          2 |  224641024 |      27323 |            90.09 |                  0
 big_u    |          2 |  314818560 |      38356 |            90.01 |                  0
```

Both were built by `CREATE INDEX`/bulk load, so both are dense — the UUID index is bigger only because the key is 16 bytes instead of 8. Now simulate a live workload that inserts randomly:

```sql
CREATE TABLE live_uuid (u uuid PRIMARY KEY);
CREATE TABLE live_seq  (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY);
INSERT INTO live_uuid SELECT gen_random_uuid() FROM generate_series(1, 5000000);
INSERT INTO live_seq  SELECT FROM generate_series(1, 5000000);

SELECT 'uuid' k, pg_size_pretty(pg_relation_size('live_uuid_pkey')) sz, avg_leaf_density FROM pgstatindex('live_uuid_pkey')
UNION ALL
SELECT 'seq', pg_size_pretty(pg_relation_size('live_seq_pkey')), avg_leaf_density FROM pgstatindex('live_seq_pkey');
```

```text
  k   |  sz    | avg_leaf_density
------+--------+-----------------
 uuid | 193 MB |            71.2
 seq  | 107 MB |            90.1
```

(Exact numbers vary by version and run; the shape — random keys ~70% dense and ~1.8–2× bigger — is consistent.)

### Real-world example: shrinking a bloated, badly laid-out events table

An `events` table of 800M rows takes 310 GB and its hot last-7-days range no longer fits in memory. Page-level diagnosis:

```sql
-- 1. Row width and padding: what does each tuple really cost?
SELECT avg(pg_column_size(e.*)) AS avg_row_bytes FROM events e TABLESAMPLE SYSTEM (0.1);

-- 2. Dead space vs live data (pgstattuple_approx is cheap on large tables)
SELECT * FROM pgstattuple_approx('events');

-- 3. Locality of the access column
SELECT attname, correlation FROM pg_stats
WHERE tablename = 'events' AND attname IN ('created_at', 'id', 'account_id');

-- 4. HOT effectiveness and index count
SELECT n_tup_upd, n_tup_hot_upd FROM pg_stat_user_tables WHERE relname = 'events';
SELECT indexrelid::regclass, pg_size_pretty(pg_relation_size(indexrelid)), idx_scan
FROM pg_stat_user_indexes WHERE relname = 'events' ORDER BY pg_relation_size(indexrelid) DESC;
```

Typical findings and fixes, each a page-level lever:

| Finding | Fix | Effect |
|---|---|---|
| `(is_test bool, id bigint, kind smallint, created_at timestamptz, …)` padding ~12 B/row | reorder columns widest-fixed-first in the new table | ~10% smaller heap |
| UUIDv4 primary key, `avg_leaf_density` 68% | switch new rows to UUIDv7 / bigint; rebuild index | PK index ~40% smaller |
| 3 indexes with `idx_scan = 0` | drop them | faster inserts, less WAL |
| `created_at` correlation 0.99 | BRIN on `created_at` for range scans instead of B-tree | index MBs instead of GBs |
| Queries always hit last 7 days | partition by month ([Ch 11](topic.html?p=11-partitioning)) | hot partition fits in RAM; old partitions dropped instead of deleted |

> **MySQL difference:** InnoDB exposes page-level stats via `information_schema.INNODB_TABLESTATS`, `INNODB_BUFFER_PAGE`, and `SHOW TABLE STATUS` (`Data_free`). Random PKs there hurt twice (clustered table and every secondary index carries the PK). Rebuild with `ALTER TABLE ... ENGINE=InnoDB` (online in 8.0) or `OPTIMIZE TABLE`. InnoDB merges pages that fall below `MERGE_THRESHOLD` (default 50%) after deletes; PostgreSQL B-trees only reclaim fully empty pages.

## 6. Advantages, Disadvantages & Trade-offs

| Choice | Advantage | Cost |
|---|---|---|
| Small pages (PG 8 KB) | Less read amplification for point lookups; smaller FPIs | Lower fanout; more pages to manage |
| Larger pages (InnoDB 16 KB) | Higher fanout, better sequential reads, compression-friendly | More bytes read and written per touched row |
| Heap + secondary indexes (PG) | Symmetric indexes; cheap updates when HOT | Non-HOT updates touch every index; no natural clustering |
| Clustered PK (InnoDB) | PK range scans sequential; secondary indexes stable across row moves | Double lookup via secondary; random PK splits the table |
| Lower fillfactor | HOT updates, fewer splits | Larger table, lower cache density |
| Monotonic keys | Dense indexes, tiny insert working set | Right-edge hot page; exposes ordering |
| Random keys | No coordination, no hot page | ~2× index size, cache misses on insert, write amplification |
| B-tree engine | Predictable reads, in-place updates | Random writes, page-level write amp |
| LSM engine | Sequential writes, high ingest | Compaction cost, read amp, tuning complexity |

### When to use page-level thinking

- Choosing primary key types and generation strategy for any table expected to exceed memory.
- Designing wide or very large tables (column order, TOAST-able columns, fillfactor).
- Capacity planning: estimate rows/page and index sizes before you provision.
- Diagnosing "table got slow as it grew" or "index is bigger than the table".
- Choosing between a B-tree store and an LSM store for write-heavy workloads.

### When NOT to bother

- Tables that fit many times over in memory — padding and density are rounding errors.
- Do not `CLUSTER` or hand-tune fillfactor without measurements; `CLUSTER` takes an ACCESS EXCLUSIVE lock and the order decays as rows change.
- Do not switch storage engines (to an LSM) for a read-heavy OLTP workload because "LSM writes are faster" — you would buy write throughput you do not need with read amplification you do.

## 7. Common Mistakes & Best Practices

1. **Using random UUIDv4 as the primary key of a huge, insert-heavy table.** It feels modern and avoids a sequence. It hurts because every insert touches a random leaf, the index is ~2× bigger, and once it exceeds memory, insert throughput collapses to device IOPS. Instead use bigint identity, or UUIDv7 if you need client-generated global IDs.
2. **Assuming SSDs make layout irrelevant.** People drop locality concerns after moving off spinning disks. It hurts because cache misses still cost 100×+ a hit, cloud volumes cap IOPS, and random small writes raise device write amplification. Instead still design for locality and small working sets.
3. **Ignoring row width.** Teams add a JSONB "metadata" column, audit columns and a few booleans in random order. Wider rows mean fewer rows per page, more pages per scan and less cached data. Instead order columns to minimise padding, keep hot narrow columns separate from cold wide ones (vertical split), and let TOAST handle genuinely large values.
4. **Leaving fillfactor at 100 on update-heavy tables.** New versions cannot fit on the same page, so updates go non-HOT and write every index. Instead set `fillfactor` 80–90 on such tables and watch the HOT ratio.
5. **Reading table size as row count × column sizes.** It misses the ~24-byte tuple header, line pointers, alignment, dead tuples and free space. Instead measure with `pg_relation_size`, `pg_total_relation_size` and `pgstattuple`.
6. **Treating `CLUSTER` as permanent.** It orders the table once; subsequent inserts and updates do not maintain the order. Instead get lasting locality from partitioning or from keys that insert in access order.
7. **Adding "just one more index".** Each index is another B-tree to descend and dirty on every non-HOT write, with its own splits and WAL. Instead drop unused indexes (`idx_scan = 0` over a full business cycle) before adding new ones ([SQL Handbook · Index Design](../sql/topic.html?p=20-index-design)).

## 8. Production: Failure Scenarios, Monitoring & Scaling

### Failure scenarios

**Insert throughput collapses at 400M rows.** A payments table with a UUIDv4 primary key and four secondary indexes inserted at 8,000 rows/s for a year. One Monday it drops to 1,500 rows/s with no code change; device read IOPS are pinned at the volume limit. Root cause: the combined index size crossed available memory, so each insert now needs several random leaf reads before it can write. Fix: short term, scale up memory; long term, UUIDv7 for new rows, partition by time so only the current partition's indexes are hot.

**Index larger than the table.** A `sessions` table with frequent updates to `last_seen_at` (indexed) shows a 12 GB index on a 4 GB table. Root cause: every update is non-HOT because an indexed column changes, leaving dead index entries and page splits; autovacuum cannot keep up. Fix: drop the index on `last_seen_at` if it is not needed for reads, or move the frequently updated column to a narrow side table; `REINDEX CONCURRENTLY` to reclaim space.

**Torn page after power loss.** An on-prem server loses power mid-checkpoint; an 8 KB page was half-written (the device's atomic unit is 4 KB). With `full_page_writes = on` (the default), recovery restores the full page image from WAL and replays on top. Someone had turned it off "for performance" — result: a checksum failure and a corrupted page. Fix: never disable `full_page_writes` unless the filesystem guarantees atomic 8 KB writes; enable data checksums (`initdb --data-checksums`, default in PG 18).

**SSD latency spikes during heavy writes.** Consumer-grade SSDs in a self-hosted replica show periodic 50–200 ms write stalls. Root cause: the drive's garbage collection under sustained random writes with little free space. Fix: enterprise drives with power-loss protection and over-provisioning, keep free space, enable TRIM/discard (periodic `fstrim`).

### Metrics to watch

| Metric | Source | Signal |
|---|---|---|
| Table + index size growth vs row growth | `pg_total_relation_size`, `pg_class.reltuples` | Bloat or degraded density |
| HOT update ratio | `pg_stat_user_tables.n_tup_hot_upd / n_tup_upd` | Index write amplification |
| Leaf density / fragmentation | `pgstatindex()` | Random-key damage, need for REINDEX |
| Cache hit ratio and read time | `pg_stat_database`, `pg_stat_io` with `track_io_timing` | Working set vs memory |
| Full-page images in WAL | `pg_stat_wal.wal_fpi` | Scattered writes after checkpoints |
| Device IOPS / latency / queue depth | OS or cloud metrics | Physical limits reached |

### Scaling notes

Page-level efficiency is the cheapest scaling you will ever buy: a 2× denser index is equivalent to doubling RAM for that index. Before scaling out, make rows narrow, keys ordered, indexes few and pages dense; then partition so the hot set is small; then scale memory; then consider replicas or sharding.

## 9. Interview Questions

**Q: Why does a B-tree lookup on a billion-row table cost only about four page reads?**
A: Because each internal page holds hundreds of separator keys, so the tree's fanout is in the hundreds and height grows logarithmically with that base. With roughly 400 entries per 8 KB page, three levels address around 60 million entries and four levels around 25 billion. The upper levels are tiny and permanently cached, so in practice a cold lookup costs one leaf-page miss plus one heap-page miss. That is why cache residency of the leaf level, not the tree's height, dominates latency.

**Q: What does a PostgreSQL heap page contain?**
A: A 24-byte header with the page LSN, checksum, flags and the `pd_lower`/`pd_upper` offsets; an array of 4-byte line pointers growing forward; free space; and tuples packed from the end of the page backward. Each tuple has a ~23-byte header with xmin, xmax, ctid and infomask bits, followed by a null bitmap and aligned column data. Indexes point at `(block, line pointer)`, and the indirection through line pointers lets the page compact tuples without updating indexes.

**Q: What is a HOT update and why does fillfactor affect it?**
A: A heap-only-tuple update happens when no indexed column changes and the new row version fits on the same heap page. The old tuple is chained to the new one within the page, so no index entries need to be added — a large saving for tables with many indexes. It requires free space on the page, which is why lowering `fillfactor` on update-heavy tables raises the HOT ratio. You monitor it with `n_tup_hot_upd` versus `n_tup_upd`.

**Q: Why do random UUIDv4 primary keys hurt performance?**
A: Every insert targets a random leaf page, so the whole index becomes the insert working set and must stay cached for inserts to be fast. Splits happen throughout the tree, leaving pages around 70% full, and 16-byte keys already lower fanout, so the index ends up roughly twice the size of a bigint index. Scattered inserts also dirty many pages per checkpoint, increasing writes and full-page images. UUIDv7 or bigint identity keys avoid this by inserting at the right edge.

**Q: How does InnoDB's storage differ from PostgreSQL's heap?**
A: InnoDB stores each table as a B-tree clustered on the primary key, with full rows in 16 KB leaf pages, and secondary indexes store the primary key value rather than a physical address. PostgreSQL stores rows in an unordered heap and every index, including the primary key, points at a physical ctid. So InnoDB gets sequential PK range scans and stable secondary indexes when rows move, but pays a double lookup via secondary indexes and suffers table-level page splits with random PKs. PostgreSQL has symmetric indexes but non-HOT updates must touch all of them.

**Q: Do SSDs make sequential vs random I/O irrelevant?**
A: No, they shrink the gap but do not eliminate it. Random reads no longer pay a seek, but each I/O still has a fixed cost, sequential access enables read-ahead and larger requests, and cloud volumes cap IOPS so random access burns budget. On writes, flash cannot overwrite in place: the FTL writes to new pages and garbage-collects erase blocks, so small random writes cause device write amplification, wear and latency spikes. Locality still matters, just by a smaller factor.

**Q: What is TOAST and when does it help or hurt?**
A: TOAST is PostgreSQL's mechanism for values too large to sit comfortably in a row, roughly beyond 2 KB: it compresses them and, if still large, moves them out of line into a side table in chunks. It helps because the main heap stays dense, so scans that do not touch the large column stay fast. It hurts when you frequently read the large column, since each access fetches extra TOAST pages, and when you update part of a large value, which rewrites the whole value.

**Q: What are read, write and space amplification, and how do B-trees and LSM trees compare?**
A: They measure physical bytes read, written and stored per logical byte. B-trees have low read amplification (one path) but page-granular write amplification — a small change rewrites an 8 KB page, plus WAL and full-page images — and space amplification from partially filled pages and bloat. LSM trees turn writes into sequential appends and compaction, trading higher write amplification from rewriting and higher read amplification across levels for high ingest throughput. You cannot minimise all three; you choose by workload.

**Q: How can a query that uses an index still be slow, from a storage perspective?**
A: The index may be selective but the matching rows are scattered across many heap pages, so each match costs a random heap fetch — low `pg_stats.correlation`. It may also be that the index leaves or heap pages are not cached, so each fetch is a device read. Bloat makes it worse by spreading live rows over more pages. Fixes include a covering index for an index-only scan, improving locality through partitioning or clustering, or reducing bloat.

**Q: Estimate the size of a bigint primary key index on 1 billion rows and how many levels it has. (Senior)**
A: A bigint index entry is about 16 bytes plus a 4-byte line pointer, so about 20 bytes, and with leaf fillfactor 90 roughly 367 entries fit per 8 KB page. One billion divided by 367 is about 2.7 million leaf pages, around 22 GB. Internal fanout of ~400 gives about 6,800 level-1 pages, then about 17 level-2 pages, then the root, so four levels. The practical conclusion is that the ~22 GB leaf level decides whether lookups hit memory, while the upper ~55 MB is always cached.

**Q: An insert-heavy table's throughput fell off a cliff as it grew, with read IOPS at the volume limit on an insert-only workload. Explain and fix. (Senior)**
A: Inserts need to read the leaf pages they insert into; with random keys or many secondary indexes on random-ish columns, those leaves are spread across the whole index. While total index size fit in memory, inserts were CPU-bound; once it exceeded memory, each insert incurred several random reads, so throughput became bounded by IOPS. I would confirm with `pg_stat_io` reads by client backends and `pgstatindex` densities. Fixes: move to time-ordered keys, drop unnecessary indexes, partition by time so only the current partition's indexes are hot, and add memory as a stop-gap.

**Q: Design the physical layout for a 5-billion-row, append-mostly event table queried by account and recent time range. (Senior)**
A: Partition by time (daily or monthly) so the hot range is a small set of partitions that fits in memory and old data can be dropped instead of deleted. Use a bigint or UUIDv7 key so inserts append at the right edge. Index `(account_id, created_at)` within each partition for the main access path, and use BRIN on `created_at` if pure time-range scans exist. Order columns to avoid padding, keep large payloads in a TOAST-able column or a separate table, and leave fillfactor at 100 since rows are not updated. I would validate with row-width sampling and estimated per-partition index sizes against available RAM.

## 10. Quick Revision & Cheat Sheet

| Fact | Value / rule |
|---|---|
| PG page size | 8 KB (InnoDB 16 KB) |
| Page layout | 24 B header · line pointers → · free space · ← tuples |
| Tuple header | ~23 B (xmin, xmax, ctid, infomask) + null bitmap, aligned |
| ctid | (block, line pointer) — indexes point here in PG |
| TOAST | values > ~2 KB compressed / moved out of line |
| B-tree fanout (bigint) | ~400 per page; leaf fillfactor 90 → ~367 |
| Height | 3 levels ≈ 60M, 4 levels ≈ 25B entries |
| Random-insert density | ~69% (vs ~90% for monotonic) |
| HOT update | no indexed column changed + room on page |
| `random_page_cost` | 4.0 default; ~1.1 on SSD |
| Big seq scans | use a ring buffer; do not flush the cache |
| Amplification | read / write / space — pick two (RUM) |

**Remember this**
- The unit of cost is the page; count pages, not rows.
- Index height is almost free; leaf-level cache residency is what you pay for.
- Random keys double index size and turn the whole index into the insert working set.
- HOT updates need free space and untouched indexed columns — fillfactor and index choice control them.
- Narrow, well-ordered rows and dense pages are the cheapest form of scaling.
- SSDs reduce but do not remove the value of sequential access; flash cannot overwrite in place.
- B-tree vs LSM is a trade between read predictability and write throughput.

## 11. Hands-On Exercises

Lab: `docker run -d --name pg -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:17`, then `CREATE EXTENSION pageinspect; CREATE EXTENSION pgstattuple;`.

1. **Read a page.** Reproduce the §5 `pageinspect` example. Compute `lower` and `upper` by hand before running the query. Update a row twice and watch the ctid chain.
2. **Measure padding.** Create two tables with the same four columns (`bool, bigint, bool, timestamptz`) in bad vs good order, insert 1M rows each, and compare `pg_relation_size`.
3. **Sequential vs random keys.** Build `live_uuid` and `live_seq` from §5 with 5M rows. Compare sizes, `avg_leaf_density`, and time to insert another 1M rows after restarting with `shared_buffers = 64MB`.
4. **HOT or not.** Create a table with an index on `status` and a non-indexed `counter`. Run 100k updates of `counter`, then 100k of `status`; compare `n_tup_hot_upd`. Repeat with `fillfactor = 70`.
5. **Correlation and locality.** On a 10M-row table, run a range query on a column with correlation ~1 and one with ~0 (a random column); compare `EXPLAIN (ANALYZE, BUFFERS)` heap page counts.

### Mini project — "Storage budget"

For a hypothetical `orders` table (50M rows/year, 5-year retention, 8 columns including a 1 KB JSON payload, 4 indexes), produce a written storage budget: per-row bytes with header and padding, rows per page, heap size, each index's size under sequential vs random keys, TOAST size, and total. Then build a 1%-scale version in Docker and compare your estimate with `pg_total_relation_size`. Explain every discrepancy larger than 10%.

## 12. Related Topics & Free Learning Resources

**In this handbook:** [Ch 01 · Database Architecture](topic.html?p=01-database-architecture) · [Ch 03 · MVCC](topic.html?p=03-mvcc) (why dead tuples occupy pages) · [Ch 07 · Write-Ahead Logging](topic.html?p=07-write-ahead-logging) (full-page writes) · [Ch 11 · Partitioning](topic.html?p=11-partitioning) · [Ch 22 · Capacity Planning](topic.html?p=22-capacity-planning) · [Ch 30 · SQL vs NoSQL](topic.html?p=30-sql-vs-nosql).

**SQL Handbook:** [Indexes: B-Tree, Composite & Covering](../sql/topic.html?p=19-indexes) · [Index Design & Sargability](../sql/topic.html?p=20-index-design) · [Query Optimization](../sql/topic.html?p=21-query-optimization).

**Other handbooks:** [System Design · Indexing & Storage Engines](../system-design/topic.html?p=15-indexing-storage-engines) · [Cassandra · Compaction Strategies](../cassandra/topic.html?p=23-compaction-strategies) · [Cassandra · SSTable Format](../cassandra/topic.html?p=26-storage-engine-sstable-format).

- **PostgreSQL docs — Database Page Layout** — PostgreSQL · *Intermediate* · the authoritative byte-level description of heap pages and tuple headers. <https://www.postgresql.org/docs/current/storage-page-layout.html>
- **PostgreSQL docs — pageinspect** — PostgreSQL · *Intermediate* · the extension used in this chapter to look inside heap and B-tree pages. <https://www.postgresql.org/docs/current/pageinspect.html>
- **nbtree README (PostgreSQL source)** — PostgreSQL · *Advanced* · the design notes for PostgreSQL's B-tree: Lehman–Yao, splits, deduplication. <https://github.com/postgres/postgres/blob/master/src/backend/access/nbtree/README>
- **The Internals of PostgreSQL, ch. 1 (Database Cluster, Databases and Tables)** — Hironobu Suzuki · *Intermediate* · file layout and heap page structure with diagrams. <https://www.interdb.jp/pg/>
- **Use The Index, Luke — Anatomy of an Index** — Markus Winand · *Beginner* · the clearest intuition for leaf chains and tree traversal. <https://use-the-index-luke.com/sql/anatomy>
- **RocksDB Wiki** — Meta · *Advanced* · LSM compaction and the read/write/space amplification trade-offs from the engine's authors. <https://github.com/facebook/rocksdb/wiki>
- **Designing Data-Intensive Applications, ch. 3** — Martin Kleppmann · *Intermediate* · B-trees vs LSM trees from first principles. <https://dataintensive.net/>

---

*Database Design Handbook — chapter 02.*
