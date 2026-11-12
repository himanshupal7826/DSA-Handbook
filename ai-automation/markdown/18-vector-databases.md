# 18 · Vector Databases: Chroma, FAISS, Qdrant, Pinecone & pgvector

> **In one line:** A vector database stores embeddings next to their text and metadata and answers "give me the k nearest vectors that also match this filter" in milliseconds, using an approximate index (HNSW or IVF) that trades a little recall for a lot of speed. Pick one by asking where it runs, how it filters, how it updates and what it costs, then hide it behind a five-method interface so you can switch later.

> **Versions used:** chromadb 1.5 · qdrant-client 1.20 · faiss-cpu 1.16 · pinecone 10.x · pgvector 0.8 (Postgres extension) with `pgvector` 0.5 (Python) and psycopg 3.3 · numpy 2.x · **Fast-moving:** every vendor ships monthly. Chroma 1.x moved HNSW settings from collection `metadata` to `configuration`; Pinecone's SDK was renamed from `pinecone-client` to `pinecone` and its serverless features change often; pgvector added iterative index scans in 0.8. Pin versions and re-run your recall benchmark on upgrades.

---

## 1. Overview

> **Builds on:** [Ch 05 · Embeddings](topic.html?p=05-embeddings) (vectors, cosine) and [Ch 16 · RAG Fundamentals](topic.html?p=16-rag-fundamentals) (where retrieval sits). [Ch 17](topic.html?p=17-reranking-hybrid-search) covers what to do *with* the candidates a store returns.

In Ch 05 you searched with `matrix @ query` in numpy. That is exact and fast enough for about 100k vectors in RAM. Past that, four things break at once: brute-force latency grows linearly, the matrix no longer fits in memory, you need to update and delete individual chunks while serving traffic, and you need filters ("only tenant 42, only 2026 documents") that run *inside* the search. A **vector database** solves those four problems.

```mermaid
flowchart LR
    ING["Ingestion job (Ch 15, Ch 20)"] -->|"upsert id, vector, text, metadata"| VS[("Vector store")]
    APP["RAG / agent query"] -->|"embed question"| QV["query vector + filter"]
    QV --> VS
    VS -->|"top-k ids, scores, payload"| RR["Rerank / prompt (Ch 16, Ch 17)"]
    VS --- IDX["ANN index: HNSW or IVF"]
    VS --- MD["Metadata index: tenant, source, date"]
    VS --- WAL["Persistence: WAL, snapshots, replicas"]
```

The landscape splits into three kinds of tool, and this chapter compares five representatives with **the same code**:

- **Libraries** you embed in your process: **FAISS** (Meta). Fastest raw search, no server, no metadata, no persistence beyond "write the index to a file".
- **Databases built for vectors**: **Chroma** (embedded or client/server, the friendliest start), **Qdrant** (Rust server, excellent filtering and hybrid search), **Pinecone** (fully managed serverless). Weaviate, Milvus and LanceDB live here too.
- **Vector support in a database you already run**: **pgvector** for Postgres. Also Redis ([Redis handbook](../redis-caching/)), OpenSearch/Elasticsearch, MongoDB Atlas.

For the theory behind ANN indexes, see [AI Engineering · Vector Databases](../ai-engineering/topic.html?p=30-vector-databases).

> **Why this matters:** the store is the one RAG component that is painful to change later. It holds your only copy of the embeddings, its filter language leaks into your code, and its cost scales with every chunk you ingest. Ten minutes on the comparison table saves a migration.

---

## 2. Key Concepts

### Exact vs. approximate nearest neighbour

**Exact** (brute-force, "flat") search compares the query with every vector: perfect recall, O(n) work. **Approximate nearest neighbour (ANN)** search uses an index to look at a small fraction of vectors and returns *most* of the true top-k. The quality metric is **recall@k against exact search**: if exact top-10 and ANN top-10 share 9 ids, recall@10 = 0.9. Every ANN index has a knob that trades recall for latency, and you should know where yours is set.

### HNSW: a navigable graph

**HNSW** (Hierarchical Navigable Small World) is the default index in Chroma, Qdrant, pgvector, Weaviate and most others. Each vector is a node linked to its nearest neighbours. Upper layers are sparse "highways", the bottom layer contains everything. A query starts at the top, greedily walks toward the query vector, drops a layer, and repeats.

- **`M`** (max links per node, 16–64): more links, better recall, more memory.
- **`ef_construction`** (100–400): how hard the build searches for good links. Build time only.
- **`ef_search`** (`hnsw_ef` in Qdrant, `hnsw.ef_search` in pgvector, `efSearch` in FAISS): candidate-list size at query time. **The knob you tune in production.** Must be ≥ k.

HNSW gives excellent recall at low latency and supports inserts, but it lives mostly in RAM and deletes leave tombstones that need periodic compaction.

> **Analogy:** HNSW is how you'd find a street in a strange city: motorway to the right region, main roads to the right district, then walk the side streets. `ef_search` is how many side streets you're willing to check before deciding.

### IVF: clusters and probes

**IVF** (inverted file) runs k-means to split vectors into `nlist` clusters. A query is compared with the cluster centroids and only the closest **`nprobe`** clusters are scanned. It needs a training step, uses less memory than HNSW, and is the base for compressed indexes (IVF-PQ) at hundreds of millions of vectors. pgvector offers `ivfflat`; FAISS offers many IVF variants.

```svg
<svg viewBox="0 0 880 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs><marker id="aa18a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#dc2626"/></marker></defs>
  <text x="440" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="#1e293b">Two ways to avoid comparing the query with every vector</text>
  <rect x="15" y="38" width="420" height="280" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="225" y="58" text-anchor="middle" font-weight="700" fill="#2563eb">HNSW: layered graph, greedy descent</text>
  <rect x="30" y="70" width="390" height="55" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="38" y="86" fill="#334155">layer 2 (few nodes, long links)</text>
  <circle cx="90" cy="105" r="6" fill="#2563eb"/><circle cx="330" cy="105" r="6" fill="#2563eb"/>
  <line x1="96" y1="105" x2="322" y2="105" stroke="#dc2626" stroke-width="2" marker-end="url(#aa18a)"/>
  <rect x="30" y="135" width="390" height="65" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="38" y="151" fill="#334155">layer 1</text>
  <circle cx="90" cy="175" r="5" fill="#2563eb"/><circle cx="170" cy="182" r="5" fill="#2563eb"/><circle cx="250" cy="168" r="5" fill="#2563eb"/><circle cx="330" cy="178" r="5" fill="#2563eb"/><circle cx="380" cy="186" r="5" fill="#2563eb"/>
  <line x1="90" y1="175" x2="170" y2="182" stroke="#94a3b8"/><line x1="170" y1="182" x2="250" y2="168" stroke="#94a3b8"/><line x1="250" y1="168" x2="330" y2="178" stroke="#94a3b8"/>
  <line x1="330" y1="178" x2="376" y2="185" stroke="#dc2626" stroke-width="2" marker-end="url(#aa18a)"/>
  <rect x="30" y="210" width="390" height="70" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="38" y="226" fill="#334155">layer 0 (every vector, M to 2M links each)</text>
  <circle cx="60" cy="255" r="4" fill="#2563eb"/><circle cx="110" cy="248" r="4" fill="#2563eb"/><circle cx="160" cy="262" r="4" fill="#2563eb"/><circle cx="210" cy="250" r="4" fill="#2563eb"/><circle cx="260" cy="264" r="4" fill="#2563eb"/><circle cx="310" cy="252" r="4" fill="#2563eb"/><circle cx="360" cy="262" r="4" fill="#2563eb"/><circle cx="395" cy="246" r="4" fill="#2563eb"/>
  <circle cx="380" cy="256" r="7" fill="none" stroke="#16a34a" stroke-width="2"/>
  <line x1="380" y1="192" x2="380" y2="246" stroke="#dc2626" stroke-width="2" marker-end="url(#aa18a)"/>
  <text x="38" y="300" fill="#1e293b">knobs: M (links), ef_construction (build), ef_search (query)</text>
  <rect x="445" y="38" width="420" height="280" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="655" y="58" text-anchor="middle" font-weight="700" fill="#7c3aed">IVF: k-means clusters, scan nprobe nearest</text>
  <circle cx="545" cy="140" r="55" fill="#ede9fe" stroke="#7c3aed"/>
  <circle cx="680" cy="120" r="50" fill="#ede9fe" stroke="#7c3aed"/>
  <circle cx="790" cy="170" r="45" fill="#f1f5f9" stroke="#94a3b8"/>
  <circle cx="600" cy="245" r="45" fill="#f1f5f9" stroke="#94a3b8"/>
  <circle cx="735" cy="255" r="40" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="545" y="144" text-anchor="middle" fill="#7c3aed">scanned</text>
  <text x="680" y="124" text-anchor="middle" fill="#7c3aed">scanned</text>
  <text x="790" y="174" text-anchor="middle" fill="#334155">skipped</text>
  <text x="600" y="249" text-anchor="middle" fill="#334155">skipped</text>
  <text x="735" y="259" text-anchor="middle" fill="#334155">skipped</text>
  <circle cx="615" cy="150" r="6" fill="#dc2626"/>
  <text x="623" y="166" fill="#dc2626" font-weight="700">query</text>
  <text x="460" y="306" fill="#1e293b">nprobe = 2 of nlist = 5: fast, but a true neighbour just</text>
  <text x="460" y="320" fill="#1e293b">across a boundary is missed. Raise nprobe for recall.</text>
</svg>
```

### Quantization: fitting more vectors in RAM

A 768-dim float32 vector is 3 KB. **Scalar quantization** (float32 → int8) cuts that 4×, **binary quantization** (1 bit per dimension) 32×, and **product quantization** (PQ) compresses further by encoding sub-vectors as codebook ids. Recall drops a little, so stores keep the compressed vectors in RAM for the search and **rescore** the top candidates with the full vectors from disk. Qdrant, Milvus, Weaviate and FAISS all support this; pgvector offers `halfvec` (float16) and `bit` types.

### Filtering: the part that actually differs between stores

Real queries are "nearest vectors **where** tenant = 42 and year ≥ 2025". There are three strategies:

- **Post-filter:** ANN top-k, then drop non-matching results. Simple but can return fewer than k results, or zero for selective filters.
- **Pre-filter:** find matching ids first (via a metadata index), then search only those. Exact results, but brute-force if the filter is broad.
- **Filtered ANN (in-graph filtering):** walk the HNSW graph but only count matching nodes. Qdrant does this natively with **payload indexes**; Chroma, Pinecone and Weaviate filter inside the search too; pgvector 0.8+ uses **iterative index scans** to keep fetching until k filtered rows are found.

Always index the fields you filter on, and test your most selective filter (a tenant with 50 documents in a 10M index) explicitly.

### Multi-tenancy, persistence and updates

- **Tenancy models:** one collection per tenant (strong isolation, many small indexes), a shared collection with a `tenant_id` filter (efficient, needs discipline), or **namespaces/partitions** (Pinecone namespaces, Qdrant's tenant-aware payload indexes, Postgres row-level security).
- **Persistence:** server stores keep a write-ahead log and snapshots. FAISS gives you `write_index()` and nothing else: metadata, ids and backups are your job.
- **Updates:** use stable ids and upsert. Deletes in HNSW mark tombstones; heavy churn needs compaction or rebuilds (Qdrant and Chroma do this in the background; FAISS HNSW can't delete at all).

---

## 3. Setup

```bash
pip install "chromadb>=1.5,<2" "qdrant-client>=1.20,<2" "faiss-cpu>=1.16" "numpy>=2" "python-dotenv>=1"
pip install "pgvector>=0.5" "psycopg[binary]>=3.2"     # pgvector option
pip install "pinecone>=10,<11"                         # Pinecone option (paid, has a free starter tier)
```

Run the two servers locally with Docker (Ch 39 covers Compose in depth):

```bash
docker run -d --name qdrant -p 6333:6333 -v qdrant_data:/qdrant/storage qdrant/qdrant
docker run -d --name pgvector -p 5432:5432 -e POSTGRES_PASSWORD=dev -v pg_data:/var/lib/postgresql/data pgvector/pgvector:pg17
```

```bash
# .env.example
CHROMA_PATH=./chroma_db
QDRANT_URL=http://localhost:6333          # unset = in-process Qdrant (brute force, for tests)
QDRANT_API_KEY=                           # Qdrant Cloud only
DATABASE_URL=postgresql://postgres:dev@localhost:5432/postgres
PINECONE_API_KEY=                         # optional, managed
PINECONE_CLOUD=aws
PINECONE_REGION=us-east-1                 # check Pinecone's supported regions
EMBED_MODEL=nomic-embed-text              # used in Example 6 only
OLLAMA_HOST=http://localhost:11434
```

Load it with `load_dotenv()` at the top of each script. Examples 1–5 use **synthetic vectors** so you can benchmark offline without an embedding model; Example 6 swaps in real Ollama embeddings.

> **Version note:** `pip install pinecone-client` is the old, deprecated package name; use `pinecone`. On Apple Silicon and Linux `faiss-cpu` wheels are on PyPI; GPU FAISS is best installed via conda.

---

## 4. Code Examples

### Example 1: A synthetic corpus with ground truth

```python
# data.py — synthetic "embeddings" with metadata, so every store can be tested offline
import numpy as np

DIM = 384


def make_corpus(n: int = 20_000, dim: int = DIM, clusters: int = 50, seed: int = 7):
    """Clustered unit vectors (real embeddings are clustered too) + metadata."""
    rng = np.random.default_rng(seed)
    centers = rng.normal(size=(clusters, dim))
    labels = rng.integers(0, clusters, size=n)
    x = centers[labels] + 0.6 * rng.normal(size=(n, dim))
    x = (x / np.linalg.norm(x, axis=1, keepdims=True)).astype(np.float32)
    ids = [f"doc-{i}" for i in range(n)]
    metas = [{"tenant": f"t{i % 5}", "year": int(2020 + i % 7), "source": f"file-{i // 100}.pdf"} for i in range(n)]
    return ids, x, metas


def make_queries(x: np.ndarray, n: int = 200, seed: int = 11) -> np.ndarray:
    rng = np.random.default_rng(seed)
    q = x[rng.integers(0, len(x), size=n)] + 0.3 * rng.normal(size=(n, x.shape[1])).astype(np.float32)
    return (q / np.linalg.norm(q, axis=1, keepdims=True)).astype(np.float32)


def exact_top_k(x: np.ndarray, q: np.ndarray, k: int = 10) -> np.ndarray:
    """Brute-force ground truth: indices of the k highest cosine scores per query."""
    return np.argsort(-(q @ x.T), axis=1)[:, :k]


if __name__ == "__main__":
    ids, x, metas = make_corpus()
    q = make_queries(x)
    print(x.shape, q.shape, metas[3], exact_top_k(x, q[:1], 5)[0])
```

```text
(20000, 384) (200, 384) {'tenant': 't3', 'year': 2023, 'source': 'file-0.pdf'} [10738  4067 13743 12028 19736]
```

Random Gaussian vectors are a poor benchmark because all distances look alike. Clustered vectors behave much more like real embeddings. `exact_top_k` is your ground truth for measuring ANN recall.

### Example 2: Feeling the recall/latency trade-off with FAISS

```python
# faiss_bench.py — recall vs latency for Flat, HNSW and IVF on 20k x 384 vectors; offline
import time

import faiss
import numpy as np

from data import exact_top_k, make_corpus, make_queries

K = 10


def recall(found: np.ndarray, truth: np.ndarray) -> float:
    return float(np.mean([len(set(f) & set(t)) / K for f, t in zip(found, truth)]))


def bench(name: str, index, q: np.ndarray, truth: np.ndarray) -> None:
    t0 = time.perf_counter()
    _, found = index.search(q, K)
    ms = (time.perf_counter() - t0) * 1000 / len(q)
    print(f"{name:28} recall@10={recall(found, truth):.3f}  {ms:.3f} ms/query")


if __name__ == "__main__":
    _, x, _ = make_corpus()
    q = make_queries(x)
    truth = exact_top_k(x, q, K)
    d = x.shape[1]

    flat = faiss.IndexFlatIP(d)                      # exact: inner product on unit vectors = cosine
    flat.add(x)
    bench("Flat (exact)", flat, q, truth)

    hnsw = faiss.IndexHNSWFlat(d, 32, faiss.METRIC_INNER_PRODUCT)   # M=32 links per node
    hnsw.hnsw.efConstruction = 200
    t0 = time.perf_counter()
    hnsw.add(x)
    print(f"  HNSW build: {time.perf_counter() - t0:.1f}s")
    for ef in (16, 64, 256):
        hnsw.hnsw.efSearch = ef                      # the query-time recall/latency knob
        bench(f"HNSW M=32 efSearch={ef}", hnsw, q, truth)

    ivf = faiss.IndexIVFFlat(faiss.IndexFlatIP(d), d, 256, faiss.METRIC_INNER_PRODUCT)   # 256 lists
    ivf.train(x)                                     # k-means to find the 256 centroids
    ivf.add(x)
    for nprobe in (1, 8, 32):
        ivf.nprobe = nprobe                          # how many lists to scan per query
        bench(f"IVF nlist=256 nprobe={nprobe}", ivf, q, truth)
```

Real output on a laptop CPU (your numbers will differ, the shape won't):

```text
Flat (exact)                 recall@10=1.000  0.119 ms/query
  HNSW build: 0.5s
HNSW M=32 efSearch=16        recall@10=0.502  0.008 ms/query
HNSW M=32 efSearch=64        recall@10=0.812  0.017 ms/query
HNSW M=32 efSearch=256       recall@10=0.973  0.044 ms/query
IVF nlist=256 nprobe=1       recall@10=0.255  0.004 ms/query
IVF nlist=256 nprobe=8       recall@10=0.908  0.008 ms/query
IVF nlist=256 nprobe=32      recall@10=0.995  0.022 ms/query
```

Three lessons. Exact search over 20k vectors is already sub-millisecond, so **at small scale, flat is fine**. A badly set `efSearch` or `nprobe` silently halves recall while looking fast. And recall is tunable at query time, so you never need to rebuild to fix it. Run this kind of sweep on your own vectors before trusting any default.

### Example 3: One interface, three local stores

The interface is deliberately tiny: `upsert`, `search`, `delete`. Everything your RAG code needs goes through it, so the store becomes a config choice.

```python
# stores.py — one tiny interface; three local backends (pgvector + Pinecone in stores_remote.py). Filters are simple equality dicts: {"tenant": "t1"}.
import os
import uuid
from typing import Protocol

import numpy as np

Hit = tuple[str, float, dict]                        # (id, cosine similarity, metadata)


class VectorStore(Protocol):
    def upsert(self, ids: list[str], vectors: np.ndarray, metas: list[dict]) -> None: ...
    def search(self, vector: np.ndarray, k: int = 10, where: dict | None = None) -> list[Hit]: ...
    def delete(self, where: dict) -> None: ...


# ---------- Chroma: embedded, zero-ops; great default up to a few million vectors ----------
class ChromaStore:
    def __init__(self, name: str = "chunks", path: str | None = None):
        import chromadb
        client = chromadb.PersistentClient(path=path) if path else chromadb.EphemeralClient()
        self.col = client.get_or_create_collection(
            name, configuration={"hnsw": {"space": "cosine", "ef_construction": 200, "ef_search": 100}})

    def upsert(self, ids, vectors, metas):
        for i in range(0, len(ids), 5000):           # Chroma caps batch size; chunk large upserts
            self.col.upsert(ids=ids[i:i + 5000], embeddings=vectors[i:i + 5000], metadatas=metas[i:i + 5000])

    def search(self, vector, k=10, where=None):
        if where and len(where) > 1:
            where = {"$and": [{f: v} for f, v in where.items()]}
        r = self.col.query(query_embeddings=[vector], n_results=k, where=where or None,
                           include=["metadatas", "distances"])
        return [(i, 1 - d, m) for i, d, m in zip(r["ids"][0], r["distances"][0], r["metadatas"][0])]

    def delete(self, where):
        self.col.delete(where=where)


# ---------- Qdrant: server (Docker/Cloud) or in-process; strong filtering + hybrid ----------
class QdrantStore:
    NS = uuid.UUID("6f1c2a52-0000-4000-8000-000000000000")

    def __init__(self, name: str = "chunks", dim: int = 384, url: str | None = None):
        from qdrant_client import QdrantClient, models
        self.m, self.name = models, name
        url = url or os.getenv("QDRANT_URL")
        self.client = QdrantClient(url=url, api_key=os.getenv("QDRANT_API_KEY")) if url else QdrantClient(":memory:")
        if not self.client.collection_exists(name):
            self.client.create_collection(name, vectors_config=models.VectorParams(size=dim, distance=models.Distance.COSINE),
                                          hnsw_config=models.HnswConfigDiff(m=16, ef_construct=200))
            for field in ("tenant", "source"):       # index fields you filter on
                self.client.create_payload_index(name, field, models.PayloadSchemaType.KEYWORD)

    def _pid(self, doc_id: str) -> str:              # Qdrant ids must be ints or UUIDs
        return str(uuid.uuid5(self.NS, doc_id))

    def _filter(self, where):
        if not where:
            return None
        return self.m.Filter(must=[self.m.FieldCondition(key=f, match=self.m.MatchValue(value=v)) for f, v in where.items()])

    def upsert(self, ids, vectors, metas):
        pts = [self.m.PointStruct(id=self._pid(i), vector=v.tolist(), payload={**m, "doc_id": i})
               for i, v, m in zip(ids, vectors, metas)]
        for i in range(0, len(pts), 1000):
            self.client.upsert(self.name, points=pts[i:i + 1000], wait=True)

    def search(self, vector, k=10, where=None):
        res = self.client.query_points(self.name, query=vector.tolist(), limit=k, query_filter=self._filter(where),
                                       search_params=self.m.SearchParams(hnsw_ef=128), with_payload=True)
        return [(p.payload["doc_id"], p.score, p.payload) for p in res.points]

    def delete(self, where):
        self.client.delete(self.name, points_selector=self.m.FilterSelector(filter=self._filter(where)))


# ---------- FAISS: a library, not a database. You own ids, metadata and persistence ----------
class FaissStore:
    def __init__(self, dim: int = 384):
        import faiss
        self.faiss = faiss
        # Flat = exact and supports remove_ids. IndexHNSWFlat is faster but can't delete (rebuild instead).
        self.index = faiss.IndexIDMap2(faiss.IndexFlatIP(dim))
        self.meta: dict[int, tuple[str, dict]] = {}  # int id -> (doc id, metadata); persist this yourself
        self.by_doc: dict[str, int] = {}
        self.next_id = 0

    def upsert(self, ids, vectors, metas):
        stale = [self.by_doc.pop(i) for i in ids if i in self.by_doc]
        if stale:
            self.index.remove_ids(np.array(stale, dtype="int64"))
            for n in stale:
                self.meta.pop(n)
        nums = np.arange(self.next_id, self.next_id + len(ids), dtype="int64")
        self.next_id += len(ids)
        self.index.add_with_ids(np.asarray(vectors, dtype="float32"), nums)
        for n, i, m in zip(nums, ids, metas):
            self.meta[int(n)] = (i, m)
            self.by_doc[i] = int(n)

    def _matching(self, where: dict) -> list[int]:
        return [n for n, (_, m) in self.meta.items() if all(m.get(f) == v for f, v in where.items())]

    def search(self, vector, k=10, where=None):
        params = None
        if where:                                    # pre-filter: search only an allow-list of ids
            sel = self.faiss.IDSelectorBatch(np.array(self._matching(where), dtype="int64"))
            params = self.faiss.SearchParameters(sel=sel)
        scores, nums = self.index.search(np.asarray([vector], dtype="float32"), k, params=params)
        return [(self.meta[int(n)][0], float(s), self.meta[int(n)][1]) for s, n in zip(scores[0], nums[0]) if n != -1]

    def delete(self, where):
        gone = self._matching(where)
        self.index.remove_ids(np.array(gone, dtype="int64"))
        for n in gone:
            self.by_doc.pop(self.meta.pop(n)[0], None)

    def save(self, path: str) -> None:
        import pickle
        self.faiss.write_index(self.index, f"{path}.faiss")
        with open(f"{path}.meta.pkl", "wb") as fh:   # only load pickles you wrote yourself
            pickle.dump((self.meta, self.by_doc, self.next_id), fh)


if __name__ == "__main__":
    from data import make_corpus
    ids, x, metas = make_corpus(1000)
    for store in (FaissStore(x.shape[1]), ChromaStore("demo"), QdrantStore("demo", x.shape[1])):
        store.upsert(ids, x, metas)
        print(type(store).__name__, [h[0] for h in store.search(x[42], 3, where={"tenant": "t2"})])
```

```text
FaissStore ['doc-42', 'doc-492', 'doc-532']
ChromaStore ['doc-42', 'doc-492', 'doc-532']
QdrantStore ['doc-42', 'doc-492', 'doc-532']
```

Three APIs, the same answer. Note what each adapter had to do: Chroma needs `$and` for multiple conditions; Qdrant needs int or UUID point ids, so we derive a UUID from the string id and keep the original in the payload; FAISS has no metadata at all, so we keep a dict and pass an **allow-list selector** to pre-filter.

> **Gotcha:** `QdrantClient(":memory:")` (and `path=...`) is a pure-Python **local mode** that does exact search and ignores payload indexes and `hnsw_ef` (it warns you). Perfect for tests and CI, wrong for benchmarks. Point `QDRANT_URL` at the Docker container to measure the real thing.

> **Gotcha:** Chroma collection names must be 3–512 characters (`[a-zA-Z0-9._-]`). `"kb"` fails with `InvalidArgumentError`.

### Example 4: pgvector and Pinecone behind the same interface

```python
# stores_remote.py — the same interface for pgvector (Postgres) and Pinecone (managed)
import os

import numpy as np


# ---------- pgvector: vectors as a column in the Postgres you already run ----------
class PgVectorStore:
    def __init__(self, dim: int = 384, dsn: str | None = None):
        import psycopg
        from pgvector.psycopg import register_vector
        from psycopg.types.json import Jsonb
        self.Jsonb = Jsonb
        self.conn = psycopg.connect(dsn or os.environ["DATABASE_URL"], autocommit=True)
        self.conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
        register_vector(self.conn)                   # numpy arrays <-> vector type
        self.conn.execute(f"""
            CREATE TABLE IF NOT EXISTS chunks (
                id text PRIMARY KEY, tenant text, source text, meta jsonb, embedding vector({dim}))""")
        self.conn.execute("CREATE INDEX IF NOT EXISTS chunks_hnsw ON chunks "
                          "USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 200)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS chunks_tenant ON chunks (tenant)")

    def upsert(self, ids, vectors, metas):
        with self.conn.cursor() as cur:
            cur.executemany(
                """INSERT INTO chunks (id, tenant, source, meta, embedding) VALUES (%s, %s, %s, %s, %s)
                   ON CONFLICT (id) DO UPDATE SET tenant = EXCLUDED.tenant, source = EXCLUDED.source,
                   meta = EXCLUDED.meta, embedding = EXCLUDED.embedding""",
                [(i, m.get("tenant"), m.get("source"), self.Jsonb(m), np.asarray(v, dtype="float32"))
                 for i, v, m in zip(ids, vectors, metas)])

    def search(self, vector, k=10, where=None):
        clauses, args = [], []
        for f, v in (where or {}).items():           # meta->>'field' works for any key; real columns are faster
            clauses.append("meta->>%s = %s")
            args += [f, str(v)]
        sql = ("SELECT id, 1 - (embedding <=> %s) AS score, meta FROM chunks "
               + ("WHERE " + " AND ".join(clauses) + " " if clauses else "")
               + "ORDER BY embedding <=> %s LIMIT %s")
        vec = np.asarray(vector, dtype="float32")
        with self.conn.transaction():
            self.conn.execute("SET LOCAL hnsw.ef_search = 100")
            self.conn.execute("SET LOCAL hnsw.iterative_scan = relaxed_order")   # pgvector 0.8+: refill filtered results
            rows = self.conn.execute(sql, [vec, *args, vec, k]).fetchall()
        return [(i, float(s), m) for i, s, m in rows]

    def delete(self, where):
        clauses = " AND ".join("meta->>%s = %s" for _ in where)
        args = [x for f, v in where.items() for x in (f, str(v))]
        self.conn.execute(f"DELETE FROM chunks WHERE {clauses}", args)


# ---------- Pinecone: fully managed serverless; pay per storage + read/write units ----------
class PineconeStore:
    def __init__(self, name: str = "chunks", dim: int = 384, namespace: str = ""):
        from pinecone import Pinecone, ServerlessSpec
        pc = Pinecone(api_key=os.environ["PINECONE_API_KEY"])
        if not pc.has_index(name):
            pc.create_index(name=name, dimension=dim, metric="cosine",
                            spec=ServerlessSpec(cloud=os.getenv("PINECONE_CLOUD", "aws"),
                                                region=os.getenv("PINECONE_REGION", "us-east-1")))
        self.index, self.ns = pc.Index(name), namespace

    def upsert(self, ids, vectors, metas):
        self.index.upsert(vectors=[{"id": i, "values": v.tolist(), "metadata": m}
                                   for i, v, m in zip(ids, vectors, metas)],
                          namespace=self.ns, batch_size=200)

    def search(self, vector, k=10, where=None):
        flt = {f: {"$eq": v} for f, v in where.items()} if where else None
        res = self.index.query(vector=vector.tolist(), top_k=k, filter=flt, include_metadata=True, namespace=self.ns)
        return [(m.id, m.score, m.metadata) for m in res.matches]

    def delete(self, where):
        # delete-by-metadata support has differed between pod and serverless indexes: check the docs for yours
        self.index.delete(filter={f: {"$eq": v} for f, v in where.items()}, namespace=self.ns)


if __name__ == "__main__":
    from data import make_corpus
    ids, x, metas = make_corpus(1000)
    stores = []
    if os.getenv("DATABASE_URL"):
        stores.append(PgVectorStore(x.shape[1]))
    if os.getenv("PINECONE_API_KEY"):
        stores.append(PineconeStore("kb-demo", x.shape[1]))
    for store in stores:
        store.upsert(ids, x, metas)
        print(type(store).__name__, [h[0] for h in store.search(x[42], 3, where={"tenant": "t2"})])
```

With `DATABASE_URL` set (Docker command in Setup) this prints the same three ids as Example 3. The SQL is the interesting part:

- `vector(384)` column plus an **HNSW index with `vector_cosine_ops`**. The operator class must match the operator you query with: `<=>` cosine distance, `<->` L2, `<#>` negative inner product. Mismatch them and Postgres silently does a sequential scan.
- `SET LOCAL hnsw.ef_search` and `hnsw.iterative_scan` scope tuning to one transaction.
- The vector lives next to your real tables, so `JOIN chunks ON documents.id = ...`, row-level security and transactional deletes come for free. That is pgvector's whole pitch.

For Pinecone, remember that writes are **eventually consistent**: a query immediately after an upsert may not see the new vectors yet. Namespaces give cheap per-tenant isolation inside one index.

> **Version note:** pgvector's HNSW index supports up to 2,000 dimensions for `vector`. For 3,072-dim embeddings (e.g. OpenAI `text-embedding-3-large`), index a `halfvec` expression or request fewer dimensions from the embedding API.

### Example 5: Same data, same queries, compared

```python
# compare.py — same data, same queries, three local stores: recall vs exact, latency, filtered search
import sys
import time

import numpy as np

from data import exact_top_k, make_corpus, make_queries
from stores import ChromaStore, FaissStore, QdrantStore

K = 10


def evaluate(name: str, store, ids, x, metas, q) -> None:
    t0 = time.perf_counter()
    store.upsert(ids, x, metas)
    load_s = time.perf_counter() - t0
    truth = exact_top_k(x, q, K)
    t0 = time.perf_counter()
    found = [[h[0] for h in store.search(v, K)] for v in q]
    ms = (time.perf_counter() - t0) * 1000 / len(q)
    rec = np.mean([len(set(f) & {ids[j] for j in t}) / K for f, t in zip(found, truth)])
    hits = store.search(q[0], 5, where={"tenant": "t2"})
    ok = all(h[2]["tenant"] == "t2" for h in hits) and len(hits) == 5
    print(f"{name:8} load={load_s:6.1f}s  recall@10={rec:.3f}  {ms:6.2f} ms/query  filtered_ok={ok}")


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 5000
    ids, x, metas = make_corpus(n)
    q = make_queries(x, 100)
    evaluate("faiss", FaissStore(x.shape[1]), ids, x, metas, q)
    evaluate("chroma", ChromaStore("bench"), ids, x, metas, q)
    evaluate("qdrant", QdrantStore("bench", x.shape[1]), ids, x, metas, q)
```

Real output (5,000 vectors, laptop CPU, Chroma embedded, Qdrant in local mode):

```text
faiss    load=   0.0s  recall@10=1.000    0.15 ms/query  filtered_ok=True
chroma   load=   0.7s  recall@10=0.977    0.57 ms/query  filtered_ok=True
qdrant   load=   0.2s  recall@10=1.000    1.44 ms/query  filtered_ok=True
```

FAISS here is a flat index, so recall is exactly 1.0. Chroma's HNSW gives 0.977 at `ef_search=100`: the approximation is visible even at 5k vectors. Qdrant's 1.0 is local mode doing brute force in Python. Run it again with `QDRANT_URL` set to see the server's HNSW numbers. **Never compare stores on numbers from different modes**, and always print recall alongside latency.

### Example 6: Real embeddings, a real query

Synthetic vectors are for benchmarking. Here is the RAG path with Ollama embeddings and any store from the interface.

```python
# real_search.py — embed a few chunks with Ollama and search them through the VectorStore interface
import os

import numpy as np
import ollama
from dotenv import load_dotenv

from stores import ChromaStore, QdrantStore

load_dotenv()
oc = ollama.Client(host=os.getenv("OLLAMA_HOST", "http://localhost:11434"))
MODEL = os.getenv("EMBED_MODEL", "nomic-embed-text")

CHUNKS = {
    "hr-12": ("Sick leave: employees receive 10 paid sick days per year.", {"tenant": "acme", "source": "hr.md"}),
    "hr-19": ("Contractors are not entitled to paid sick leave.", {"tenant": "acme", "source": "hr.md"}),
    "it-09": ("Report a lost laptop to security within one hour.", {"tenant": "acme", "source": "it.pdf"}),
    "gl-01": ("Globex staff get 12 sick days per year.", {"tenant": "globex", "source": "hr.md"}),
}


def embed(texts: list[str], kind: str = "document") -> np.ndarray:
    prefix = "search_query: " if kind == "query" else "search_document: "
    v = np.array(oc.embed(model=MODEL, input=[prefix + t for t in texts]).embeddings, dtype=np.float32)
    return v / np.linalg.norm(v, axis=1, keepdims=True)


if __name__ == "__main__":
    ids = list(CHUNKS)
    vecs = embed([CHUNKS[i][0] for i in ids])
    store = QdrantStore("handbook", vecs.shape[1]) if os.getenv("QDRANT_URL") else ChromaStore("handbook")
    store.upsert(ids, vecs, [CHUNKS[i][1] for i in ids])
    q = embed(["how many sick days do I get?"], kind="query")[0]
    for doc_id, score, meta in store.search(q, k=2, where={"tenant": "acme"}):
        print(f"{score:.3f} {doc_id} {meta['source']}")
```

Illustrative output:

```text
0.742 hr-12 hr.md
0.655 hr-19 hr.md
```

Globex's chunk is semantically the closest match for some queries, and the tenant filter is what keeps it out. That filter must come from the authenticated session, never from the question text.

### Example 7: Sizing RAM before you pick a plan

```python
# sizing.py — back-of-envelope RAM for a vector index; offline
def index_ram_gb(n: int, dim: int, bytes_per_dim: float = 4, hnsw_m: int = 16, meta_bytes: int = 200) -> float:
    vectors = n * dim * bytes_per_dim                 # float32 = 4 bytes, int8 = 1, binary = 1/8
    graph = n * hnsw_m * 2 * 4 * 1.1                  # layer-0 links (2*M int32 ids) + upper layers (~10%)
    payload = n * meta_bytes                          # ids + metadata (often on disk instead)
    return (vectors + graph + payload) / 1024**3


if __name__ == "__main__":
    print(f"{'vectors':>12} {'dim':>5} {'float32':>9} {'int8':>8} {'binary':>8}")
    for n, dim in [(100_000, 768), (1_000_000, 768), (10_000_000, 768), (10_000_000, 1536), (100_000_000, 1024)]:
        f32, i8, b1 = (index_ram_gb(n, dim, b) for b in (4, 1, 1 / 8))
        print(f"{n:>12,} {dim:>5} {f32:>8.1f}G {i8:>7.1f}G {b1:>7.1f}G")
```

```text
     vectors   dim   float32     int8   binary
     100,000   768      0.3G     0.1G     0.0G
   1,000,000   768      3.2G     1.0G     0.4G
  10,000,000   768     31.8G    10.3G     4.1G
  10,000,000  1536     60.4G    17.5G     5.0G
 100,000,000  1024    413.2G   127.1G    43.7G
```

A rough model, but it answers the important question fast: a million 768-dim chunks fits on a small VM; ten million 1536-dim chunks in float32 needs a 64 GB machine or quantization. Halving dimensions (many embedding APIs accept a `dimensions` parameter) halves the bill too. Remember that most RAG corpora are smaller than people think: 10,000 PDFs × 30 chunks is 300k vectors.

---

## 5. Real-World Use Case

**Company:** a B2B SaaS with an "ask your workspace" feature over customer documents. **Scale:** 3,800 tenant workspaces, 14M chunks (768-dim), ~40 new documents per minute at peak, ~25 queries/second at peak. **Start:** one Chroma collection on the API server. It worked to ~1M chunks, then restarts took minutes, a heavy tenant's re-index slowed everyone, and one missing `where` clause in a new endpoint returned another tenant's chunk in staging.

```mermaid
flowchart LR
    UP["Document uploaded"] --> Q["Queue (Ch 36)"]
    Q --> W["Ingest worker: parse, chunk, embed"]
    W -->|"upsert with tenant_id payload"| QD[("Qdrant cluster, 3 nodes")]
    API["Ask API"] --> AUTH["Auth: tenant_id from session"]
    AUTH --> REPO["VectorStore adapter: tenant filter mandatory"]
    REPO --> QD
    QD --> RR["Rerank top-30 (Ch 17)"]
    RR --> LLM["Answer with citations"]
    PG[("Postgres: documents, ACLs")] -.->|"doc ids allowed for user"| REPO
```

**What they did:**
- Moved to a 3-node Qdrant cluster with a shared collection, a `tenant_id` keyword payload index (tenant-aware), scalar int8 quantization in RAM with full vectors on disk for rescoring.
- Made the tenant filter **impossible to forget**: the adapter's `search()` requires a `tenant_id` argument, and a unit test asserts no code path calls the raw client.
- Kept documents and ACLs in Postgres; the adapter adds a `doc_id in [...]` filter for per-document permissions in shared workspaces.
- Wrote a recall benchmark (Example 5 against 1,000 real queries with exact ground truth) that runs before every config change.

**Numbers:** p95 search 18 ms at `hnsw_ef=128` with recall@10 0.97 vs. exact; RAM ~16 GB per node with int8 (vs. ~45 GB estimated for float32 with replication). Cost: three mid-size VMs, in the same range as a managed serverless plan at their read volume. They compared both on the pricing pages, and chose self-hosting for data residency. The team noted that **pgvector** would have been the simpler choice below ~5M chunks, since they already ran Postgres.

---

## 6. Mini Project: A Store-Agnostic Benchmark and Migration Kit (1–2 hours)

**Goal:** run the same recall/latency/filter benchmark against every store you have available (FAISS, Chroma, Qdrant server, pgvector, optionally Pinecone), then migrate a Chroma collection to the winner and verify it.

```text
vector-kit/
├── .env
├── docker-compose.yml   # step 1
├── data.py              # Example 1
├── stores.py            # Example 3
├── stores_remote.py     # Example 4
├── bench.py             # step 2
└── migrate.py           # step 3
```

**Step 1: start the servers.**

```yaml
# docker-compose.yml — Qdrant + Postgres with pgvector
services:
  qdrant:
    image: qdrant/qdrant
    ports: ["6333:6333"]
    volumes: ["qdrant_data:/qdrant/storage"]
  postgres:
    image: pgvector/pgvector:pg17
    environment:
      POSTGRES_PASSWORD: dev
    ports: ["5432:5432"]
    volumes: ["pg_data:/var/lib/postgresql/data"]
volumes:
  qdrant_data: {}
  pg_data: {}
```

**Step 2: the benchmark,** extended from Example 5 to include every configured store, a selective-filter test and p95 latency.

```python
# bench.py — python bench.py 20000   (stores without config are skipped)
import os
import sys
import time

import numpy as np
from dotenv import load_dotenv

from data import exact_top_k, make_corpus, make_queries
from stores import ChromaStore, FaissStore, QdrantStore

load_dotenv()
K = 10


def available(dim: int) -> dict:
    stores = {"faiss": lambda: FaissStore(dim), "chroma": lambda: ChromaStore("bench")}
    if os.getenv("QDRANT_URL"):
        stores["qdrant"] = lambda: QdrantStore("bench", dim)
    if os.getenv("DATABASE_URL") or os.getenv("PINECONE_API_KEY"):
        from stores_remote import PgVectorStore, PineconeStore
        if os.getenv("DATABASE_URL"):
            stores["pgvector"] = lambda: PgVectorStore(dim)
        if os.getenv("PINECONE_API_KEY"):
            stores["pinecone"] = lambda: PineconeStore("bench", dim)
    return stores


def run(name: str, store, ids, x, metas, q) -> dict:
    t0 = time.perf_counter()
    store.upsert(ids, x, metas)
    load_s = time.perf_counter() - t0
    if name == "pinecone":
        time.sleep(10)                                # eventual consistency: let writes become visible
    truth = exact_top_k(x, q, K)
    lat, found = [], []
    for v in q:
        t = time.perf_counter()
        found.append([h[0] for h in store.search(v, K)])
        lat.append((time.perf_counter() - t) * 1000)
    recall = np.mean([len(set(f) & {ids[j] for j in t}) / K for f, t in zip(found, truth)])
    # selective filter: one source file = 100 vectors out of n
    hits = store.search(q[0], K, where={"source": "file-3.pdf"})
    filter_ok = len(hits) == K and all(h[2]["source"] == "file-3.pdf" for h in hits)
    return {"store": name, "load_s": round(load_s, 1), "recall@10": round(float(recall), 3),
            "p50_ms": round(float(np.percentile(lat, 50)), 2), "p95_ms": round(float(np.percentile(lat, 95)), 2),
            "selective_filter_ok": filter_ok}


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 20_000
    ids, x, metas = make_corpus(n)
    q = make_queries(x, 200)
    rows = [run(name, make(), ids, x, metas, q) for name, make in available(x.shape[1]).items()]
    cols = list(rows[0])
    print("  ".join(f"{c:>19}" for c in cols))
    for r in rows:
        print("  ".join(f"{str(r[c]):>19}" for c in cols))
```

Real output (5,000 vectors, no servers configured, so only the two embedded stores run):

```text
              store               load_s            recall@10               p50_ms               p95_ms  selective_filter_ok
              faiss                  0.0                  1.0                 0.14                 0.15                 True
             chroma                  0.7                0.975                 0.54                 0.65                 True
```

**Step 3: migrate and verify.** `col.get()` pages through a Chroma collection with `limit`/`offset`, including the stored embeddings, so you can move to another store without re-embedding.

```python
# migrate.py — copy every vector + metadata from a Chroma collection into another store, then verify
import argparse
import os

import chromadb
import numpy as np
from dotenv import load_dotenv

from stores import FaissStore, QdrantStore

load_dotenv()


def pages(col, size: int = 1000):
    """Yield (ids, vectors, metas) pages from Chroma without loading everything at once."""
    offset = 0
    while True:
        r = col.get(limit=size, offset=offset, include=["embeddings", "metadatas"])
        if not r["ids"]:
            return
        yield r["ids"], np.asarray(r["embeddings"], dtype=np.float32), r["metadatas"]
        offset += size


def make_target(kind: str, dim: int):
    if kind == "qdrant":
        return QdrantStore("chunks", dim)                 # QDRANT_URL set -> server, else in-memory
    if kind == "faiss":
        return FaissStore(dim)
    from stores_remote import PgVectorStore, PineconeStore
    return PgVectorStore(dim) if kind == "pgvector" else PineconeStore("chunks", dim)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--chroma-path", default=os.getenv("CHROMA_PATH", "./chroma_db"))
    ap.add_argument("--collection", default="chunks")
    ap.add_argument("--to", choices=["qdrant", "faiss", "pgvector", "pinecone"], default="qdrant")
    a = ap.parse_args()

    src = chromadb.PersistentClient(path=a.chroma_path).get_collection(a.collection)
    first = src.get(limit=1, include=["embeddings"])
    dim = len(first["embeddings"][0])
    dst, copied, probe = make_target(a.to, dim), 0, None
    for ids, vecs, metas in pages(src):
        dst.upsert(ids, vecs, metas)
        copied += len(ids)
        probe = probe if probe is not None else (ids[0], vecs[0])
        print(f"copied {copied}/{src.count()}")

    # verify: every source vector should find itself as its own nearest neighbour
    hit = dst.search(probe[1], 1)
    print("self-match ok:", bool(hit) and hit[0][0] == probe[0], "| top score:", round(hit[0][1], 4))


if __name__ == "__main__":
    main()
```

Real output (2,500 vectors, Chroma → Qdrant):

```text
copied 1000/2500
copied 2000/2500
copied 2500/2500
self-match ok: True | top score: 1.0
```

**Step 4: run it.**

```bash
docker compose up -d
python bench.py 20000
python migrate.py --to qdrant
python migrate.py --to pgvector
```

**Done when:**
- [ ] `bench.py` prints one row per configured store with load time, recall@10, p50/p95 and `selective_filter_ok`.
- [ ] You can explain each store's recall number (exact, HNSW at what `ef`, or local brute force).
- [ ] `migrate.py` copies a collection without re-embedding and the self-match check passes.
- [ ] You've written down which store you'd choose for your project and the one number that decided it.

**Stretch goals:** sweep `hnsw_ef` (Qdrant) and `hnsw.ef_search` (pgvector) and plot recall vs p95; enable Qdrant scalar quantization (`quantization_config=models.ScalarQuantization(...)`) and measure the RAM and recall change; add a Weaviate or LanceDB adapter; make `search()` require a `tenant` argument and write a test that fails if any caller omits it.

---

## 7. Comparison Table

| | **Chroma** | **FAISS** | **Qdrant** | **Pinecone** | **pgvector** |
|---|---|---|---|---|---|
| What it is | Embedded or client/server DB | C++ library | Rust server (self-host or Cloud) | Managed serverless service | Postgres extension |
| Runs | In your process, or a server | In your process | Docker / k8s / Cloud | Vendor cloud only | Wherever Postgres runs (RDS, Supabase, Neon...) |
| Index types | HNSW | Flat, HNSW, IVF, PQ, GPU | HNSW + quantization | Managed (proprietary) | HNSW, IVFFlat |
| Metadata filtering | Yes (`where`) | None built in (id selectors) | Excellent, indexed payloads | Yes (Mongo-style) | Full SQL `WHERE`, joins |
| Hybrid / sparse | Basic full-text `where_document` | No | Native sparse vectors + fusion | Sparse-dense | Combine with Postgres full-text |
| Updates / deletes | Yes | Flat/IVF only, manual | Yes | Yes (eventually consistent) | Yes, transactional |
| Scale sweet spot | Up to a few million | Up to billions (you build it) | Millions to billions | Millions to billions | Up to ~10M per table comfortably |
| Ops burden | None to low | You own everything | Medium (self) / none (Cloud) | None | Same as your Postgres |
| Cost model | Free (OSS); Chroma Cloud paid | Free | Free OSS; Cloud by resources | Storage + read/write units | Your Postgres bill |
| Best for | Prototypes, single-node apps, notebooks | Research, offline batch, custom pipelines | Production RAG with heavy filtering, multi-tenant | Teams with no ops capacity, spiky load | Teams already on Postgres who want one database |

**When to use which:**
- **Prototype or single-service app:** Chroma. Zero setup, persistent, good enough to ship small products.
- **You already run Postgres and have < ~10M chunks:** pgvector. One database, joins with your real data, transactional deletes, existing backups.
- **Production RAG with many tenants, complex filters or hybrid search:** Qdrant (self-hosted or Cloud). Weaviate and Milvus are comparable alternatives.
- **No ops team, unpredictable traffic:** Pinecone (or another managed service). Compute the monthly bill from the pricing page at your expected writes and reads first.
- **Offline batch similarity, research, or building your own engine:** FAISS.

---

## 8. Common Mistakes & Best Practices

**Mistake 1: benchmarking latency without recall.** "Store X is 3× faster" at recall 0.6 is not faster. *Fix:* always compute recall@k against exact search on your own vectors and report both (Example 5).

**Mistake 2: metric mismatch.** Indexing with L2 and querying for cosine on unnormalised vectors, or a pgvector `vector_l2_ops` index queried with `<=>` (which forces a sequential scan). *Fix:* normalise vectors, choose cosine (or inner product on unit vectors) everywhere, and check `EXPLAIN` in Postgres.

```sql
-- Before: index can't serve this query (L2 index, cosine operator) -> Seq Scan
CREATE INDEX ON chunks USING hnsw (embedding vector_l2_ops);
SELECT id FROM chunks ORDER BY embedding <=> $1 LIMIT 5;
-- After: operator class matches the operator
CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops);
```

**Mistake 3: filters on unindexed fields.** Works in dev with 1,000 chunks, times out with 10M. *Fix:* create payload/metadata indexes (Qdrant `create_payload_index`, a B-tree on `tenant_id` in Postgres) for every field you filter on.

**Mistake 4: post-filtering tenant data in application code.** Leaks data on bugs and returns too few results. *Fix:* filter in the store, and make the tenant argument mandatory in your adapter.

**Mistake 5: treating FAISS as a database.** No metadata, no WAL, HNSW can't delete, and a crash between `add()` and `write_index()` loses data. *Fix:* use FAISS for read-mostly or batch workloads, or keep it behind a store that persists ids and metadata transactionally.

**Mistake 6: mixing embedding models or dimensions.** A collection built with `nomic-embed-text` queried with another model returns plausible garbage. *Fix:* store the model name and dimension in collection metadata and check it at startup; re-embed into a new collection and switch with an alias.

**Mistake 7: no re-index plan.** Changing chunking or embedding model means re-embedding everything. *Fix:* keep source text and metadata in a system of record (S3, Postgres), build the new collection alongside the old one, flip an alias, then delete the old one (blue/green indexing).

**Mistake 8: using local or embedded mode for load tests.** Qdrant local mode and Chroma's ephemeral client behave differently from servers. *Fix:* benchmark the deployment you'll run.

**Best-practice checklist**
- [ ] Vectors normalised; one distance metric everywhere; index operator class matches the query operator.
- [ ] Stable string ids from your ingestion pipeline; upsert, never blind insert.
- [ ] Payload/metadata indexes for every filter field; tenant filter mandatory in the adapter.
- [ ] Recall@k vs. exact measured on your data; `ef_search`/`nprobe` chosen from a sweep.
- [ ] Embedding model + dimension recorded with the collection.
- [ ] Source text kept in a system of record so you can re-embed; blue/green collection switch.
- [ ] Backups/snapshots scheduled (Qdrant snapshots, `pg_dump`, Pinecone collections/backups).
- [ ] RAM sized with quantization in mind before choosing an instance or plan.

---

## 9. Exercises

1. **Sweep the knob.** For Qdrant server (or FAISS HNSW), measure recall@10 and p95 latency for `ef` in `[16, 32, 64, 128, 256, 512]` on 50k vectors. Find the smallest `ef` with recall ≥ 0.95.
2. **Selective filter stress test.** Make one tenant own 0.1% of vectors. Compare result counts and latency for that tenant in Chroma, Qdrant server and pgvector (with and without `hnsw.iterative_scan`).
3. **pgvector join.** Add a `documents` table with `status` (`published`/`draft`) and write one SQL query that returns the top 5 chunks from published documents only, using the HNSW index. Check with `EXPLAIN ANALYZE`.
4. **Quantization trade-off.** In FAISS, compare `IndexFlatIP`, `IndexHNSWFlat` and `IndexHNSWSQ` (scalar-quantized) on recall and memory (`faiss.serialize_index(index).nbytes`).
5. **Cost model.** For 2M chunks of 768 dims, 50 writes/s at peak and 30 queries/s, estimate monthly cost for pgvector on a managed Postgres instance, Qdrant Cloud and Pinecone serverless from their pricing pages. Put assumptions in a pandas table.

### Self-check questions

**Q: What does an ANN index trade away, and how do you measure it?**
A: It trades a little recall for much lower latency and work per query: it examines only a fraction of the vectors, so it may miss some true nearest neighbours. You measure it as recall@k against brute-force search on the same vectors and queries, the share of the exact top-k ids that the index also returns.

**Q: What do HNSW's `M`, `ef_construction` and `ef_search` control?**
A: `M` is the number of links per node: higher means better recall and more memory. `ef_construction` is the candidate list size while building: higher gives a better graph and slower builds. `ef_search` is the candidate list size per query: the main runtime recall/latency knob, which must be at least k and can be changed without rebuilding.

**Q: How does IVF search work and which parameter controls recall?**
A: IVF clusters the vectors with k-means into `nlist` lists. At query time it compares the query with the centroids and scans only the `nprobe` closest lists. Raising `nprobe` scans more lists, which raises recall and latency. It needs a training step, and vectors near cluster boundaries are the ones missed at low `nprobe`.

**Q: Why is post-filtering a problem for multi-tenant RAG?**
A: The index returns its global top-k first, so after removing other tenants' results you may have far fewer than k, or none, especially for small tenants. It also depends on application code remembering to filter, so one bug exposes another tenant's data. Filtering inside the store, on an indexed field, returns k valid results and keeps isolation in one place.

**Q: When would you choose pgvector over a dedicated vector database?**
A: When you already run Postgres and the corpus is in the low millions of chunks: you get one system to operate and back up, SQL joins with documents, permissions and status, transactional updates and deletes, and row-level security. A dedicated store wins at larger scale, with heavy filtering at high QPS, quantization, native hybrid search or horizontal sharding.

**Q: Your team switched embedding models and retrieval quality collapsed overnight. What happened and how should the switch have been done? (Senior)**
A: Most likely queries were embedded with the new model while the stored vectors came from the old one (or a mix), so similarities are meaningless, possibly with mismatched dimensions too. The safe pattern is blue/green: keep source text in a system of record, re-embed everything into a new collection tagged with the new model name and dimension, run the retrieval eval against it, then switch an alias or config atomically and delete the old collection later. Startup checks should refuse to query a collection whose recorded model differs from the configured one.

**Q: How would you size and configure a store for 50M chunks at 1024 dims with p95 < 50 ms? (Senior)**
A: Float32 vectors alone are about 200 GB, plus HNSW links and payloads, so plan on quantization (int8 roughly 4× smaller, binary about 32× smaller) with full vectors on disk for rescoring, and shard across nodes with replicas for throughput and availability. Index the filter fields, pick `M` around 16–32, then sweep `ef_search` on a sample of real queries to hit recall ≥ 0.95 within the latency budget. Load-test the actual cluster, not local mode, and consider reducing dimensions if the embedding model supports it.

**Q: Why might Qdrant show perfect recall but slow queries in your unit tests? (Senior)**
A: `QdrantClient(":memory:")` and `path=` run a local pure-Python mode that performs exact brute-force search and ignores HNSW settings and payload indexes. Recall is trivially 1.0 and latency grows with collection size. It's fine for functional tests, but benchmarks must run against a Qdrant server or Cloud cluster.

---

## 10. Summary & Official Docs

- A vector DB adds **ANN indexing, filtering, updates and persistence** on top of `matrix @ query`.
- **HNSW** (graph; `M`, `ef_construction`, `ef_search`) is the default; **IVF** (`nlist`, `nprobe`) uses less memory and underpins compression.
- Always report **recall@k vs. exact search** next to latency. Tune `ef_search` / `nprobe` at query time.
- **Filtering** is where stores really differ: index filter fields, filter in the store, and test your most selective filter.
- **Quantization** (int8, binary, PQ) with rescoring cuts RAM 4–32×.
- **Chroma** to start, **pgvector** if you live in Postgres, **Qdrant** for filter-heavy production, **Pinecone** for zero ops, **FAISS** for batch and research.
- Hide the store behind `upsert / search / delete`, keep source text elsewhere, and switch collections blue/green.

| Store | One-line pick |
|---|---|
| Chroma | Fastest start, embedded |
| FAISS | Library for raw speed and research |
| Qdrant | Filtering, hybrid, self-host or Cloud |
| Pinecone | Managed serverless, no ops |
| pgvector | One database with your relational data |

**Official docs**
- Chroma: https://docs.trychroma.com/
- FAISS: https://github.com/facebookresearch/faiss/wiki
- Qdrant: https://qdrant.tech/documentation/
- Pinecone: https://docs.pinecone.io/
- pgvector: https://github.com/pgvector/pgvector
- Theory: [AI Engineering · Vector Databases](../ai-engineering/topic.html?p=30-vector-databases)

**Next:** [Ch 19 · LlamaIndex & Haystack](topic.html?p=19-llamaindex-haystack): frameworks that wire loaders, stores, retrievers and generators together for you.

---

*AI Automation with Python Handbook — chapter 18.*
