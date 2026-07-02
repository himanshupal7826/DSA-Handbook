# 13 · Reading & Writing Data

> **In one line:** `read_*`/`to_*` move data between disk/DB and DataFrames — choose the **format** (CSV vs Parquet) and the **read options** (dtype, dates, chunks) that fit your scale.

---

## 1. Overview

A pandas pipeline almost always begins with a **`read_`** and ends with a **`to_`**. These I/O functions are where most real-world pain lives: wrong dtypes inferred, dates parsed as strings, files too big for RAM, or a text format that is 10× slower and larger than it needs to be. Getting I/O right up front saves an entire downstream cleaning stage.

Two decisions dominate. **Which format?** CSV is human-readable and universal but untyped, row-oriented, and uncompressed. **Parquet** is a binary, columnar, compressed, self-describing format that preserves dtypes and reads only the columns you ask for — the default for anything at scale. **Which read options?** Passing `dtype`, `parse_dates`, `usecols`, and (for huge files) `chunksize` turns a fragile guess-everything load into a fast, correct, memory-bounded one.

You reach for these functions constantly: ingest from CSV/JSON/Parquet/SQL, transform in memory, then persist an analytics-ready Parquet or hand a CSV to a non-technical consumer.

## 2. Core Concepts

- **`read_csv` infers everything by default** — dtypes, delimiter, header. Inference is convenient but slow and occasionally wrong; pin it with options.
- **`dtype=`** forces column types at parse time (faster, correct, no post-hoc `astype` copy).
- **`parse_dates=`** turns text timestamps into `datetime64[ns]` during the read, not after.
- **`usecols=`** reads only the columns you need — less RAM, less CPU. Huge win on wide files.
- **`chunksize=`** yields an iterator of row-batches so you can process files larger than memory.
- **Parquet is columnar + compressed + typed.** It stores schema and per-column data, enabling column pruning and predicate pushdown.
- **`to_csv` vs `to_parquet`.** CSV: portable, untyped, large. Parquet: compact, typed, fast to reread — but binary (needs `pyarrow`/`fastparquet`).
- **`read_sql` / `read_json`** cover databases and nested/API data; `read_sql` runs your query and returns a frame.

## 3. Syntax & Examples

**A robust `read_csv`** — pin dtypes, parse dates, select columns:

```python
import pandas as pd

df = pd.read_csv(
    'events.csv',
    usecols=['user_id', 'ts', 'amount', 'country'],  # read only these
    dtype={'user_id': 'int32', 'country': 'category'},
    parse_dates=['ts'],                               # -> datetime64[ns]
    na_values=['', 'NA', 'null'],                     # treat as missing
)
```

**Streaming a file too big for RAM** with `chunksize`:

```python
total = 0.0
for chunk in pd.read_csv('huge.csv', usecols=['amount'], chunksize=1_000_000):
    total += chunk['amount'].sum()   # process 1M rows at a time
print(total)
```

**JSON, Parquet, SQL:**

```python
pd.read_json('data.json')                              # array of objects
pd.read_json('lines.jsonl', lines=True)                # JSON Lines

pd.read_parquet('events.parquet', columns=['ts', 'amount'])  # column pruning

from sqlalchemy import create_engine
eng = create_engine('postgresql://user:pw@host/db')
pd.read_sql('SELECT id, ts, amount FROM events WHERE ts > %(d)s',
            eng, params={'d': '2026-01-01'}, parse_dates=['ts'])
```

**Writing:**

```python
df.to_parquet('events.parquet', compression='snappy', index=False)
df.to_csv('events.csv', index=False)                   # index=False: no phantom column
```

## 4. Worked Example

Same 1M-row dataset written as CSV and Parquet; compare size, reread speed, and dtype fidelity.

```python
import numpy as np, pandas as pd

n = 1_000_000
df = pd.DataFrame({
    'user_id': np.random.randint(0, 50_000, n).astype('int32'),
    'ts':      pd.date_range('2026-01-01', periods=n, freq='s'),
    'country': pd.Series(np.random.choice(['US','IN','DE','BR'], n)).astype('category'),
    'amount':  np.random.gamma(2.0, 20.0, n).round(2),
})

df.to_csv('e.csv', index=False)
df.to_parquet('e.parquet', compression='snappy', index=False)

# Reread and check dtypes survived
csv_back = pd.read_csv('e.csv')          # loses category + datetime types
pq_back  = pd.read_parquet('e.parquet')  # preserves every dtype
print(csv_back.dtypes['ts'], '|', pq_back.dtypes['ts'])
print(csv_back.dtypes['country'], '|', pq_back.dtypes['country'])
```

Typical result on this shape:

| format  | file size | reread time | `ts` dtype        | `country` dtype |
|---------|-----------|-------------|-------------------|-----------------|
| CSV     | ~48 MB    | ~1.2 s      | object (string!)  | object          |
| Parquet | ~9 MB     | ~0.15 s     | datetime64[ns]    | category        |

CSV lost both the datetime and category types (everything comes back as text/object) and is ~5× larger and ~8× slower to reread. Parquet round-trips the schema exactly. The lesson: **use CSV for interchange with humans/tools that require it; use Parquet as your working and archival format.**

## 5. Under the Hood

CSV is **row-major text**: to read column `amount` you must scan every byte of every row and parse each field from text — no way to skip columns, no stored types, no compression. Parquet is **column-major binary**: values for a column are stored together, compressed, with the schema and per-column statistics (min/max, null counts) in a footer. That layout lets a reader **prune columns** (`columns=[...]` reads only those byte ranges) and **push down predicates** (skip row-groups whose stats can't match a filter).

```svg
<svg viewBox="0 0 640 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="160" y="24" text-anchor="middle" fill="#1e293b" font-weight="bold">CSV · row-major text</text>
  <rect x="30" y="40" width="260" height="30" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="160" y="60" text-anchor="middle" fill="#1e293b">id,ts,amount  (row 0)</text>
  <rect x="30" y="76" width="260" height="30" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="160" y="96" text-anchor="middle" fill="#1e293b">id,ts,amount  (row 1)</text>
  <rect x="30" y="112" width="260" height="30" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="160" y="132" text-anchor="middle" fill="#1e293b">id,ts,amount  (row 2)</text>
  <text x="160" y="176" text-anchor="middle" fill="#64748b">must scan all bytes · no types · no compression</text>
  <text x="160" y="196" text-anchor="middle" fill="#b91c1c">read one column = read the whole file</text>

  <text x="480" y="24" text-anchor="middle" fill="#1e293b" font-weight="bold">Parquet · column-major binary</text>
  <rect x="350" y="40" width="80" height="102" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="390" y="90" text-anchor="middle" fill="#1e293b">id</text>
  <text x="390" y="108" text-anchor="middle" fill="#64748b">min/max</text>
  <rect x="440" y="40" width="80" height="102" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="480" y="90" text-anchor="middle" fill="#1e293b">ts</text>
  <text x="480" y="108" text-anchor="middle" fill="#64748b">min/max</text>
  <rect x="530" y="40" width="80" height="102" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="570" y="90" text-anchor="middle" fill="#1e293b">amount</text>
  <text x="570" y="108" text-anchor="middle" fill="#64748b">min/max</text>
  <rect x="350" y="150" width="260" height="26" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="480" y="167" text-anchor="middle" fill="#64748b">footer: schema + dtypes + stats</text>
  <line x1="570" y1="176" x2="570" y2="192" stroke="#475569" marker-end="url(#ah2)"/>
  <text x="480" y="208" text-anchor="middle" fill="#059669">read 'amount' only · skip row-groups via stats</text>

  <text x="320" y="250" text-anchor="middle" fill="#64748b">columns=[...] → column pruning · filters → predicate pushdown</text>
  <text x="320" y="278" text-anchor="middle" fill="#64748b">compression (snappy/zstd) applies per column, exploiting local similarity</text>
</svg>
```

## 6. Variations & Trade-offs

| Format | Typed? | Layout | Compressed | Human-readable | Best for |
|--------|--------|--------|-----------|----------------|----------|
| **CSV** | no | row | no | yes | interchange, small data, hand editing |
| **JSON / JSONL** | partial | row | no | yes | nested/API data, logs |
| **Parquet** | yes | column | yes | no | analytics, scale, archival |
| **Feather/Arrow** | yes | column | light | no | fast local IPC between tools |
| **SQL (`read_sql`)** | yes | — | — | — | pushing filters/joins to the DB |

**CSV pros:** universal, diff-able, opens in any tool. **CSV cons:** untyped (dates/categories lost), verbose, uncompressed, must read whole file. **Parquet pros:** small, fast, typed, column-pruned, predicate pushdown. **Parquet cons:** binary (needs a library), less approachable for ad-hoc human editing.

**Push work to the source:** with a SQL database, filter/aggregate in the query (`read_sql`) rather than pulling everything and filtering in pandas — moves less data and uses the DB's indexes.

## 7. Production / Performance Notes

- **Default to Parquet** for anything reread more than once or larger than a few MB. Snappy for speed, **zstd** for a better size/CPU trade-off.
- **Always pin `dtype` and `parse_dates`** on `read_csv` for known schemas — avoids fragile inference and a post-load `astype` copy.
- **`usecols` / `columns`** dramatically cut memory on wide files; only materialize what you use.
- **`chunksize`** (or Parquet row-groups / partitioning) for out-of-core work; aggregate per chunk, combine at the end.
- **Partition large Parquet datasets** by a column (e.g. `date=`) so readers touch only relevant files.
- **`index=False`** on `to_csv`/`to_parquet` unless the index is meaningful — otherwise you get a phantom `Unnamed: 0` column on reread.
- **Never `read_json` untrusted deeply-nested data blindly** — normalize with `pd.json_normalize` and cap depth.
- **Compression on CSV** (`to_csv('f.csv.gz')`) helps size but not the read-whole-file limitation.

## 8. Common Mistakes

1. ⚠️ **Letting `read_csv` infer dtypes on a big file.** Slow and sometimes wrong (IDs as float, dates as string). *Fix:* pass `dtype=` and `parse_dates=`.
2. ⚠️ **Reading the whole file when you need three columns.** Wasted RAM/CPU. *Fix:* `usecols=` (CSV) / `columns=` (Parquet).
3. ⚠️ **`to_csv` writing the index**, producing `Unnamed: 0` on reread. *Fix:* `index=False` (or set a real index and read it back deliberately).
4. ⚠️ **Loading a multi-GB CSV into RAM at once.** OOM. *Fix:* `chunksize` iterator, or switch to partitioned Parquet.
5. ⚠️ **Expecting CSV to preserve dtypes.** Datetimes and categories come back as object/string. *Fix:* use Parquet, or re-apply `parse_dates`/`astype` on read.
6. ⚠️ **Mixed-type columns silently becoming `object`** because of a stray `'NA'` string. *Fix:* declare `na_values=` and `dtype=`.
7. ⚠️ **Pulling an entire table with `read_sql` then filtering in pandas.** Moves too much data. *Fix:* filter/aggregate in the SQL query.

## 9. Interview Questions

**Q: Why is Parquet preferred over CSV at scale?**
A: It's columnar, compressed, and self-describing: it preserves dtypes, reads only requested columns (pruning), can skip row-groups via stored statistics (predicate pushdown), and is far smaller and faster to reread than untyped, row-major, uncompressed CSV.

**Q: What does `dtype=` in `read_csv` buy you over calling `astype` afterward?**
A: It sets types during parsing — faster, lower peak memory, and avoids a second full copy. It also prevents wrong inference (e.g. a numeric ID read as float, then losing precision).

**Q: How do you process a CSV larger than available RAM?**
A: `read_csv(..., chunksize=N)` returns an iterator of N-row DataFrames; process/aggregate each chunk and combine results. Or convert to partitioned Parquet and read row-groups.

**Q: What does `usecols` do and why does it matter?**
A: Restricts the read to named/positional columns, cutting parse time and memory. On wide files it's one of the biggest cheap wins.

**Q: Why does a datetime column survive a Parquet round-trip but not a CSV one?**
A: Parquet stores the schema/dtype in its footer, so it rehydrates as `datetime64[ns]`. CSV is plain text with no type metadata, so it rereads as object/string unless you re-specify `parse_dates`.

**Q: When would you still choose CSV?**
A: For human-readable interchange, small datasets, diff-friendly version control, or when a downstream tool only accepts CSV.

**Q: (Senior) Explain predicate pushdown and column pruning in Parquet reads.**
A: Column pruning reads only the byte ranges for requested columns. Predicate pushdown uses per-row-group min/max/null statistics to skip groups that can't satisfy a filter, so a selective query reads a fraction of the file.

**Q: (Senior) How do you keep a growing Parquet dataset efficient to query by date?**
A: Partition by a date column (Hive-style `date=YYYY-MM-DD` directories). Readers with a date filter touch only matching partitions, avoiding a full scan; keep row-groups reasonably sized (e.g. 128MB) to balance parallelism and overhead.

**Q: (Senior) You must ingest from Postgres. Where should filtering and aggregation happen and why?**
A: In the SQL sent to `read_sql`, so the database uses its indexes and returns only the needed rows/aggregates. Pulling the whole table into pandas wastes network, memory, and CPU.

**Q: (Senior) `read_json` is exploding memory on nested API data. What's the fix?**
A: Don't load the raw nested structure into wide object columns; use `pd.json_normalize` with an explicit `record_path`/`meta` to flatten only needed fields, process in batches, and cap nesting depth.

## 10. Practice

- [ ] Write the same DataFrame to CSV and Parquet; compare file size and reread time and dtype fidelity.
- [ ] Read a CSV pinning `dtype`, `parse_dates`, and `usecols`; confirm no post-load `astype` is needed.
- [ ] Sum a numeric column of a large CSV using `chunksize` without loading the whole file.
- [ ] Read a Parquet file twice: once fully, once with `columns=[...]`; observe the difference.
- [ ] Load nested JSON with `pd.json_normalize` and flatten a `record_path`.

## 11. Cheat Sheet

> [!TIP]
> **`read_csv`**: pin `dtype=`, `parse_dates=`, `usecols=`, `na_values=`; stream big files with `chunksize=`. **Parquet** = columnar + compressed + typed → column pruning, predicate pushdown, ~5× smaller / ~8× faster reread; use it for scale and archival. **CSV** = universal but untyped, row-major, uncompressed → interchange only. Always `to_csv(..., index=False)` unless the index matters. `read_sql`: push filters/aggregation into the query. Partition big Parquet by date.

**References:** Pandas User Guide — "IO tools (text, CSV, HDF5, …)"; Apache Parquet documentation; Apache Arrow / PyArrow docs

---

*NumPy & Pandas Handbook — topic 13.*
