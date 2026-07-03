# 27 · Memory Optimization & dtypes

> **In one line:** Shrink a DataFrame from gigabytes to megabytes by choosing the smallest correct dtype — downcast numerics, `category` for low-cardinality strings, PyArrow-backed types, and chunked reads — measured with `memory_usage(deep=True)`.

---

## 1. Overview

Pandas defaults are **safe, not small**. Read a CSV and every integer column becomes `int64` (8 bytes/value), every float `float64`, and every string an `object` column — a NumPy array of *pointers* to Python `str` objects scattered on the heap. A 5-million-row file that could fit in 200 MB routinely balloons to 2–4 GB, and once you're near RAM the machine starts swapping and everything crawls.

**Memory optimization** is the discipline of storing each column in the smallest dtype that still represents its values losslessly. An age column never exceeds 120 — that's `int8` (1 byte), an 8× win over `int64`. A `country` column with 195 distinct values across 10M rows is screaming to be a `category`. A boolean flag stored as `"yes"`/`"no"` text wastes ~50 bytes per cell that a `bool` does in 1.

You reach for this when a frame won't fit in RAM, when `groupby`/`merge`/`sort` are slow (less memory = better cache behavior = faster), or when you're sizing a job for a container with a hard memory limit. The payoff is routinely **5–20× smaller** and materially faster.

The tools: `memory_usage(deep=True)` to *measure*, `pd.to_numeric(downcast=...)` and `astype` to *shrink*, `category` for repeated strings, **PyArrow-backed dtypes** for strings and nullable types, and **chunked reads** for files bigger than RAM.

## 2. Core Concepts

- **`memory_usage(deep=True)`** — the only honest measurement. Without `deep=True`, `object` columns report just the 8-byte pointer, hiding the real string payload. Always pass `deep=True`.
- **Downcasting integers** — `int64 → int32 → int16 → int8` (and unsigned `uint*`). Pick the smallest type whose range covers your min/max. `int8` holds −128..127, `int16` ±32k, `int32` ±2.1B.
- **Downcasting floats** — `float64 → float32` halves memory at the cost of ~7 significant digits. Fine for most measurements; **not** for money or IDs needing exactness.
- **`category` dtype** — stores each distinct value **once** in a dictionary plus a compact integer code array. A win when cardinality ≪ row count. Low-cardinality strings (country, status, plan) shrink 10–100×.
- **`object` strings are pointers** — the classic memory sink. Convert to `category` or **`string[pyarrow]`** to store bytes contiguously instead of as scattered Python objects.
- **PyArrow-backed dtypes** — `dtype="string[pyarrow]"`, or `df.convert_dtypes(dtype_backend="pyarrow")`. Contiguous Arrow buffers: less memory, true nullable semantics, faster string ops, zero-copy to Parquet/Polars.
- **Nullable integer types** (`Int8`, `Int16`…, capital I) — hold `NA` **without** promoting to float. A plain `int` column with one missing value silently becomes `float64`; `Int16` keeps it integer.
- **Chunked reads** — `pd.read_csv(..., chunksize=n)` yields an iterator of frames so you process a file larger than RAM piece by piece, aggregating as you go.
- **Read-time dtypes** — pass `dtype=` and `usecols=` to `read_csv` so the frame is *born* small instead of shrunk after the fact (which briefly needs both copies in memory).

## 3. Syntax & Examples

```python
import pandas as pd
import numpy as np

# --- Measure honestly ---
df.memory_usage(deep=True)          # bytes per column (Index + each col)
df.memory_usage(deep=True).sum()    # total bytes
df.info(memory_usage="deep")        # human summary incl. deep object cost
```

```python
# --- Downcast numerics automatically to the smallest safe type ---
df["count"]  = pd.to_numeric(df["count"],  downcast="integer")   # int64 -> int8/16/32
df["price"]  = pd.to_numeric(df["price"],  downcast="float")     # float64 -> float32
df["signed"] = pd.to_numeric(df["signed"], downcast="signed")
df["nonneg"] = pd.to_numeric(df["nonneg"], downcast="unsigned")  # uint*
```

```python
# --- Low-cardinality strings -> category ---
df["country"] = df["country"].astype("category")
df["status"]  = df["status"].astype("category")

# Only worth it when distinct values are few relative to length:
nunique, n = df["country"].nunique(), len(df)
if nunique / n < 0.5:
    df["country"] = df["country"].astype("category")
```

```python
# --- PyArrow-backed strings & nullable types (pandas >= 2.0, pyarrow installed) ---
df["name"] = df["name"].astype("string[pyarrow]")     # contiguous, nullable
df2 = df.convert_dtypes(dtype_backend="pyarrow")      # whole frame -> Arrow types

# Nullable integer keeps NA without float promotion:
s = pd.Series([1, 2, None], dtype="Int16")            # stays integer, holds <NA>
```

```python
# --- Be born small: set dtypes at read time ---
dtypes = {"id": "int32", "country": "category", "price": "float32"}
df = pd.read_csv("sales.csv", dtype=dtypes, usecols=list(dtypes))
```

## 4. Worked Example

A synthetic 1,000,000-row sales frame with pandas defaults, then optimized. Reusable optimizer:

```python
import pandas as pd, numpy as np
rng = np.random.default_rng(0)
n = 1_000_000

df = pd.DataFrame({
    "order_id": np.arange(n, dtype="int64"),          # unique, up to 1e6
    "qty":      rng.integers(1, 6, n).astype("int64"), # tiny range 1..5
    "price":    rng.uniform(1, 500, n),                # float64
    "country":  rng.choice(["US","UK","DE","IN","BR"], n),  # 5 distinct
    "status":   rng.choice(["paid","pending","refunded"], n),
})

def optimize(frame, category_ratio=0.5):
    out = frame.copy()
    for col in out.columns:
        c = out[col]
        if pd.api.types.is_integer_dtype(c):
            out[col] = pd.to_numeric(c, downcast="integer")
        elif pd.api.types.is_float_dtype(c):
            out[col] = pd.to_numeric(c, downcast="float")
        elif pd.api.types.is_object_dtype(c):
            if c.nunique() / len(c) < category_ratio:
                out[col] = c.astype("category")
            else:
                out[col] = c.astype("string[pyarrow]")
    return out

opt = optimize(df)

def mb(frame): return frame.memory_usage(deep=True).sum() / 1024**2
print(f"before: {mb(df):6.1f} MB")
print(f"after : {mb(opt):6.1f} MB   ({mb(df)/mb(opt):.1f}x smaller)")
print(opt.dtypes)
```

Result — same data, dtypes chosen per column:

```text
before:  164.8 MB
after :   17.2 MB   (9.6x smaller)

order_id      int32     # 1e6 fits in int32 (not int8: exceeds 127)
qty            int8     # 1..5 -> 1 byte
price       float32     # halved
country    category     # 5 values dict + int8 codes
status     category
```

Per-column breakdown, before → after:

| column   | before dtype | before MB | after dtype     | after MB |
|----------|--------------|-----------|-----------------|----------|
| order_id | int64        | 7.6       | int32           | 3.8      |
| qty      | int64        | 7.6       | int8            | 1.0      |
| price    | float64      | 7.6       | float32         | 3.8      |
| country  | object       | 61.0      | category        | 1.0      |
| status   | object       | 66.4      | category        | 1.0      |

The `object` string columns were **97% of the frame** and collapse to almost nothing as categories — that's where the real win lives.

## 5. Under the Hood

Why does an `object` string column cost so much, and why does `category` fix it? An `object` column is a NumPy array of 8-byte **pointers**, each pointing to a separate Python `str` object on the heap (~49 bytes of overhead + the characters). Ten million `"US"` strings = ten million pointers *and* ten million heap objects. A `category` stores the distinct values **once** in a `categories` index and replaces the column with a small integer **codes** array (`int8` if <128 categories). Same values, a fraction of the bytes.

```svg
<svg viewBox="0 0 640 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#475569"/>
    </marker>
  </defs>
  <text x="320" y="22" text-anchor="middle" fill="#1e293b" font-weight="700">object column vs. category — storing "US","UK","US","DE","US"</text>

  <text x="150" y="52" text-anchor="middle" fill="#b91c1c" font-weight="700">object (pointers)</text>
  <rect x="40" y="64" width="220" height="30" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="150" y="84" text-anchor="middle" fill="#1e293b">[ptr][ptr][ptr][ptr][ptr]  5×8B</text>
  <g fill="#fff7ed" stroke="#d97706">
    <rect x="40"  y="120" width="60" height="26" rx="6"/>
    <rect x="110" y="120" width="60" height="26" rx="6"/>
    <rect x="180" y="120" width="60" height="26" rx="6"/>
    <rect x="40"  y="156" width="60" height="26" rx="6"/>
    <rect x="110" y="156" width="60" height="26" rx="6"/>
  </g>
  <g fill="#1e293b" text-anchor="middle">
    <text x="70"  y="138">"US"</text><text x="140" y="138">"UK"</text><text x="210" y="138">"US"</text>
    <text x="70"  y="174">"DE"</text><text x="140" y="174">"US"</text>
  </g>
  <text x="150" y="204" text-anchor="middle" fill="#64748b">5 heap objects, ~49B each of overhead</text>
  <line x1="120" y1="94" x2="70"  y2="118" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="150" y1="94" x2="140" y2="118" stroke="#475569" marker-end="url(#ah)"/>

  <line x1="300" y1="150" x2="345" y2="150" stroke="#475569" stroke-width="2" marker-end="url(#ah)"/>

  <text x="500" y="52" text-anchor="middle" fill="#059669" font-weight="700">category (codes + dict)</text>
  <rect x="380" y="64" width="240" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="500" y="84" text-anchor="middle" fill="#1e293b">codes int8: [0,1,0,2,0]  5×1B</text>
  <rect x="380" y="110" width="240" height="90" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="500" y="130" text-anchor="middle" fill="#1e293b" font-weight="700">categories (stored once)</text>
  <text x="500" y="152" text-anchor="middle" fill="#1e293b">0 → "US"   1 → "UK"</text>
  <text x="500" y="172" text-anchor="middle" fill="#1e293b">2 → "DE"</text>
  <text x="500" y="192" text-anchor="middle" fill="#64748b">3 objects total, not 5</text>
  <text x="500" y="230" text-anchor="middle" fill="#059669" font-weight="700">scales: 10M rows → still 3 objects</text>
</svg>
```

Integer downcasting is simpler: `int64` uses 8 bytes to represent numbers that a 1-byte `int8` covers if they fit −128..127. `to_numeric(downcast="integer")` inspects the actual min/max and picks the narrowest type. **PyArrow** strings go further than `category` for *high*-cardinality text: values live in one contiguous byte buffer with an offsets array — no per-string Python object at all, and near-zero cost to write to Parquet.

## 6. Variations & Trade-offs

| Technique | Typical saving | Cost / risk |
|-----------|----------------|-------------|
| `int64 → int8/16/32` | 2–8× on that col | overflow if future values exceed range |
| `float64 → float32` | 2× | ~7-digit precision; wrong for money/IDs |
| `object → category` | 10–100× (low card.) | slow if cardinality ~ row count; append cost |
| `object → string[pyarrow]` | 2–5× (high card.) | needs `pyarrow`; some ops differ slightly |
| Nullable `Int16` vs `float64` | ~4× + keeps int | slightly slower than raw NumPy int |
| Chunked read | fits any size | more code; multi-pass for global stats |
| Read as Parquet not CSV | huge + typed | needs the file in Parquet |

Rules of thumb: **`category` when distinct values ≪ rows**; **PyArrow strings when cardinality is high**; **`float32` only for measurements**, never money or identifiers; **downcast integers always** — it's free and lossless. When in doubt, measure both with `memory_usage(deep=True)` and compare.

## 7. Production / Performance Notes

- **Set dtypes at read time.** Post-hoc `astype` briefly holds the original *and* the shrunk copy in RAM. For files near your memory ceiling, pass `dtype=` + `usecols=` to `read_csv` so the frame is never large.
- **Prefer Parquet over CSV.** Parquet stores dtypes, is columnar, compresses, and reads only the columns you request. CSV throws away all type info and re-infers every load.
- **Chunked aggregation** for out-of-core work — accumulate partial `groupby` results per chunk, then combine. `pd.read_csv(path, chunksize=500_000)` gives an iterator.
- **Memory ≈ speed.** Smaller dtypes fit more values per cache line, so `groupby`, `merge`, and `sort` on optimized frames run measurably faster — the saving is not just RAM.
- **Watch silent upcasting.** Merging a `category` with a plain `object`, or introducing `NaN` into an `int` column, re-promotes to `object`/`float64` and quietly erases your savings. Re-check `dtypes` after big transforms.
- **Category append is expensive** if the new value isn't already a known category — it must extend the categories index. For high-churn text, PyArrow strings behave better.

## 8. Common Mistakes

1. ⚠️ **Measuring `object` memory without `deep=True`.** You see the pointer size, not the strings — memory looks 50× smaller than reality. **Fix:** always `memory_usage(deep=True)` / `info(memory_usage="deep")`.
2. ⚠️ **`float32` for money or IDs.** 32-bit floats lose precision past ~7 digits; `1234567.89` and account numbers get corrupted. **Fix:** keep money in `float64` or integer cents; keep IDs as int/string.
3. ⚠️ **`category` on a near-unique column.** A high-cardinality `category` costs *more* than `object` (dict + codes + overhead). **Fix:** only categorize when `nunique/len` is small (≲0.5); use `string[pyarrow]` otherwise.
4. ⚠️ **Downcasting to `int8` then appending larger values.** A later `1000` overflows or forces re-upcast. **Fix:** size to the *domain's* real max, not just the current sample's.
5. ⚠️ **Introducing NaN into a downcast int column.** It silently becomes `float64`, undoing the win. **Fix:** use nullable `Int16`/`Int32` when nulls are possible.
6. ⚠️ **Optimizing after a full default read** of a file that barely fits. The default read already OOMs. **Fix:** set `dtype=`/`usecols=` at read time, or read chunked.
7. ⚠️ **Forgetting `.copy()` semantics** — reassigning columns in a loop over a view can trigger SettingWithCopy warnings. **Fix:** operate on an explicit copy or rebuild the frame.

## 9. Interview Questions

**Q: Why does an `object` string column use so much more memory than a `category`, and how do you measure the true cost?**
A: An `object` column is an array of 8-byte pointers to individual Python `str` objects on the heap (~49 bytes overhead each). A `category` stores each distinct value once in a dictionary plus a compact integer `codes` array (`int8` if <128 categories). You measure the real cost with `memory_usage(deep=True)` — without `deep=True`, object columns report only the pointer size and hide the string payload.

**Q: When is converting a string column to `category` a bad idea?**
A: When cardinality is close to the row count. A near-unique `category` stores almost as many dictionary entries as rows *plus* the codes array *plus* overhead, so it uses more memory than plain `object` and adds lookup cost. Rule: categorize only when distinct values are few relative to length; use `string[pyarrow]` for high-cardinality text.

**Q: What's the difference between `int8` and the nullable `Int8`, and when do you need the latter?**
A: Lowercase `int8` is NumPy-backed and cannot hold missing values — introduce a `NaN` and the column upcasts to `float64`. Capital `Int8` is pandas' nullable integer type that stores `<NA>` via a mask while staying integer. Use `Int*` when a column is conceptually integer but may contain nulls, to avoid float promotion.

**Q: Walk through how you'd shrink a 4 GB CSV that doesn't fit comfortably in RAM.**
A: Don't do a default full read first. Inspect a sample to learn ranges/cardinality, then either (a) `read_csv(dtype=..., usecols=...)` with per-column small dtypes and `category` for low-cardinality strings so the frame is born small, or (b) read with `chunksize=` and process/aggregate chunk by chunk for true out-of-core work. Better still, convert once to Parquet and read that — typed, columnar, compressed.

**Q: What does `pd.to_numeric(s, downcast="integer")` actually do?**
A: It inspects the column's min and max and casts to the smallest integer dtype (`int8/16/32`) that represents the range losslessly, defaulting to signed unless you ask for `"unsigned"`. It's a free, lossless win — no reason not to apply it to integer columns.

**Q: Why can smaller dtypes make operations *faster*, not just save memory?**
A: Narrower types pack more values per CPU cache line, improving cache hit rates and memory bandwidth utilization. `groupby`, `merge`, and `sort` become measurably faster because they move less data. `category` also speeds up `groupby`/joins since comparisons operate on integer codes rather than string content.

**Q: What are PyArrow-backed dtypes and what do they buy you over the default backend?** *(senior)*
A: Pandas ≥2.0 can store columns in Apache Arrow buffers (`dtype="string[pyarrow]"` or `convert_dtypes(dtype_backend="pyarrow")`). Strings live in one contiguous byte buffer with an offsets array — no per-value Python object — so less memory (especially high-cardinality text), true nullable semantics across all types, faster vectorized string ops, and zero-copy interchange with Parquet and Polars.

**Q: You downcast a frame and later a `groupby`+`merge` silently blows up memory again. What happened?** *(senior)*
A: An operation likely upcast a column: merging a `category` against a plain `object` key produces `object`, or introducing `NaN` promoted an `int` to `float64`, or concatenating frames with mismatched categories re-materialized strings. The fix is to align dtypes before the op (cast both keys to the same `category`/type) and re-verify `dtypes`/`memory_usage(deep=True)` afterward.

**Q: How do you decide between `float32` and `float64` for a numeric column?** *(senior)*
A: `float32` halves memory but carries only ~7 significant decimal digits. It's fine for sensor readings, ratios, and ML features where that precision is ample. It's wrong for money (use `float64` or integer minor units), large identifiers, or any accumulation where rounding compounds. Decide by the column's precision requirement, not its size.

**Q: Why is Parquet usually a better storage choice than CSV for memory-sensitive pipelines?**
A: Parquet is columnar, typed, and compressed: it preserves dtypes (no re-inference), lets you read only the columns you need (`columns=`), and predicate/row-group pruning reduces I/O. CSV is row-oriented text that discards all type information, so every load re-infers types and materializes wide `object` columns. Convert once to Parquet and reads are smaller and faster.

## 10. Practice

- [ ] Load any CSV, print `memory_usage(deep=True).sum()/1024**2`, then write an `optimize()` function that downcasts numerics and categorizes low-cardinality strings; report the MB before/after and the ratio.
- [ ] Take a column of 1M random integers in 0..100 and compare bytes as `int64`, `int32`, `int16`, `int8`, and `category`. Explain which is smallest and why.
- [ ] Convert a high-cardinality text column to both `category` and `string[pyarrow]`; measure both and justify which you'd ship.
- [ ] Create an int column, set one value to `NaN`, and observe the dtype change; fix it with `Int32` and confirm the value stays integer.
- [ ] Read a large CSV with `chunksize=100_000` and compute a global `groupby` sum by accumulating partial results, never holding the whole file in memory.

## 11. Cheat Sheet

> [!TIP]
> **Memory optimization in one screen**
> - **Measure:** `df.memory_usage(deep=True).sum()/1024**2` · `df.info(memory_usage="deep")` — always `deep=True`.
> - **Ints:** `pd.to_numeric(s, downcast="integer")` → int8/16/32 (free, lossless). Nulls possible? use `Int16`.
> - **Floats:** `downcast="float"` → float32 (measurements only; never money/IDs).
> - **Low-card strings:** `s.astype("category")` when `nunique/len` is small (10–100× win).
> - **High-card strings:** `s.astype("string[pyarrow]")` / `convert_dtypes(dtype_backend="pyarrow")`.
> - **Born small:** `read_csv(dtype={...}, usecols=[...])`; prefer **Parquet**; huge files → `chunksize=`.
> - **Gotcha:** NaN into int → float64; category vs object merge → object. Re-check `dtypes` after big ops.

**References:** pandas User Guide — "Scaling to large datasets" & "Categorical data"; pandas `memory_usage`/`to_numeric` API docs; Apache Arrow "pandas integration"; Wes McKinney blog on Arrow-backed pandas.

---
*NumPy & Pandas Handbook — topic 27.*
