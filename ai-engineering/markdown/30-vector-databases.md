# 30 · Vector Databases & ANN Search

> **In one line:** A vector database stores embeddings and finds the nearest ones to a query in milliseconds using approximate nearest-neighbor indexes like HNSW and IVF — the retrieval engine that powers RAG and semantic search.

---

## 1. Overview

A **vector database** stores high-dimensional embedding vectors and answers one question extremely fast: *"which stored vectors are most similar to this query vector?"* That single capability — similarity search at scale — is the engine underneath RAG, semantic search, recommendation, deduplication, and image/audio retrieval. Where a traditional database indexes exact values (find `id = 42`), a vector database indexes *meaning* (find the 10 items closest to this concept).

The problem it solves is **nearest-neighbor search that stays fast as data grows**. Comparing a query against every stored vector (brute-force / flat search) is exact but O(N·d) per query — fine for thousands of vectors, hopeless for millions or billions. **Approximate Nearest Neighbor (ANN)** algorithms trade a tiny amount of accuracy for enormous speedups, turning a linear scan into a sub-linear graph or cluster traversal. Vector databases package these ANN indexes with the operational features you need in production: filtering by metadata, updates and deletes, persistence, sharding, and access control.

Historically, similarity search lived in specialized libraries — **FAISS** (Facebook, 2017) for research-grade ANN, and later graph-based **HNSW** (2016) which became the dominant high-recall index. As embeddings became central to LLM applications (2022–2023), purpose-built vector databases — Pinecone, Weaviate, Qdrant, Milvus — and vector extensions to existing stores (pgvector for Postgres) emerged to make ANN search a managed, production-ready primitive.

A concrete real-world example: a RAG chatbot has embedded 5 million document chunks. When a user asks a question, the query embedding must be compared against all 5 million to find the top-10 relevant chunks — and it must return in under 50ms for a responsive UX. Brute force would scan all 5 million vectors every query. With an HNSW index, the search visits only a few hundred vectors via a navigable graph and returns the top-10 in single-digit milliseconds, at ~99% recall. That's the difference between a demo and a product.

The durable mental model: **a vector database is a search engine for meaning, made practical by approximation.** You choose an index (HNSW for high recall and speed, IVF for memory efficiency at huge scale), a distance metric (cosine, dot, Euclidean) that matches your embeddings, and tune the recall-vs-speed-vs-memory triangle. Getting those three choices right is the core skill of operating one.

---

## 2. Core Concepts

- **Embedding vector** — a dense numeric representation of an item (text, image) where proximity encodes similarity.
- **Distance metric** — how similarity is measured: cosine similarity, dot product, or Euclidean (L2) distance.
- **k-NN (k-nearest neighbors)** — the task of finding the k most similar vectors to a query.
- **ANN (approximate nearest neighbor)** — algorithms that find *almost* the true nearest neighbors far faster than exact search.
- **Recall** — the fraction of true nearest neighbors an ANN index actually returns; the accuracy dial.
- **HNSW (Hierarchical Navigable Small World)** — a multi-layer graph index offering high recall and low latency at the cost of memory.
- **IVF (Inverted File Index)** — clusters vectors and searches only the nearest clusters; memory-efficient for very large corpora.
- **PQ (Product Quantization)** — compresses vectors into compact codes to shrink memory, often paired with IVF (IVF-PQ).
- **Metadata filtering** — restricting search to vectors matching structured conditions (date, category, permissions).
- **Index parameters** — knobs like HNSW's `M`/`efConstruction`/`efSearch` or IVF's `nlist`/`nprobe` that trade recall, speed, and memory.

---

## 3. Theory & Mathematical Intuition

Similarity search ranks stored vectors by a **distance or similarity metric** against the query `q`.

**Cosine similarity** measures angle (direction), ignoring magnitude — the default for text embeddings:

```
cos(q, v) = (q · v) / (‖q‖ · ‖v‖)
```

**Dot product** includes magnitude: `q · v`. On **normalized** vectors, dot product and cosine give the same ranking (and dot product is cheaper), which is why many systems L2-normalize embeddings and use dot product internally.

**Euclidean (L2) distance** measures straight-line distance: `‖q − v‖`. Smaller is closer.

Choosing the metric that matches how your embedding model was trained is essential — using L2 on vectors trained for cosine degrades results.

**Why ANN?** Exact search costs `O(N·d)` per query. ANN indexes change the geometry of search:

- **HNSW** builds a layered proximity graph. Search starts at a sparse top layer, greedily hops toward the query, and descends layers to refine — visiting only `O(log N)`-ish nodes instead of all N. The `efSearch` parameter controls how many candidates to explore: higher = better recall, slower.
- **IVF** partitions vectors into `nlist` clusters (via k-means). At query time it searches only the `nprobe` nearest clusters, skipping the rest — cutting comparisons roughly by `nlist/nprobe`. Higher `nprobe` = better recall, slower.
- **PQ** compresses each vector into a short code (e.g. 64 bytes instead of 1.5KB), so billions of vectors fit in RAM; accuracy drops slightly, recovered by re-ranking top candidates on full vectors.

The universal tradeoff is a triangle: **recall ↔ latency ↔ memory.** Every index knob moves you along it; there is no free lunch.

```svg
<svg viewBox="0 0 660 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="660" height="300" fill="#e0f2fe"/>
  <text x="330" y="28" text-anchor="middle" font-size="16" fill="#1e293b" font-weight="bold">HNSW: multi-layer navigable graph search</text>
  <text x="60" y="65" font-size="12" fill="#1e293b" font-weight="bold">Layer 2 (sparse)</text>
  <circle cx="150" cy="80" r="6" fill="#4f46e5"/>
  <circle cx="400" cy="75" r="6" fill="#4f46e5"/>
  <line x1="150" y1="80" x2="400" y2="75" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="60" y="140" font-size="12" fill="#1e293b" font-weight="bold">Layer 1</text>
  <circle cx="150" cy="150" r="6" fill="#0ea5e9"/>
  <circle cx="280" cy="140" r="6" fill="#0ea5e9"/>
  <circle cx="400" cy="150" r="6" fill="#0ea5e9"/>
  <circle cx="520" cy="145" r="6" fill="#0ea5e9"/>
  <line x1="150" y1="150" x2="280" y2="140" stroke="#0ea5e9" stroke-width="1.5"/>
  <line x1="280" y1="140" x2="400" y2="150" stroke="#0ea5e9" stroke-width="1.5"/>
  <line x1="400" y1="150" x2="520" y2="145" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="60" y="215" font-size="12" fill="#1e293b" font-weight="bold">Layer 0 (dense)</text>
  <circle cx="150" cy="230" r="5" fill="#16a34a"/>
  <circle cx="230" cy="225" r="5" fill="#16a34a"/>
  <circle cx="310" cy="235" r="5" fill="#16a34a"/>
  <circle cx="390" cy="228" r="5" fill="#16a34a"/>
  <circle cx="470" cy="235" r="5" fill="#16a34a"/>
  <circle cx="550" cy="228" r="5" fill="#16a34a"/>
  <line x1="150" y1="230" x2="230" y2="225" stroke="#16a34a" stroke-width="1"/>
  <line x1="230" y1="225" x2="310" y2="235" stroke="#16a34a" stroke-width="1"/>
  <line x1="310" y1="235" x2="390" y2="228" stroke="#16a34a" stroke-width="1"/>
  <line x1="390" y1="228" x2="470" y2="235" stroke="#16a34a" stroke-width="1"/>
  <line x1="150" y1="80" x2="150" y2="150" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3"/>
  <line x1="400" y1="75" x2="400" y2="150" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3"/>
  <line x1="310" y1="235" x2="310" y2="150" stroke="#d97706" stroke-width="2" marker-end="url(#a30)"/>
  <circle cx="310" cy="150" r="8" fill="none" stroke="#d97706" stroke-width="2"/>
  <text x="330" y="270" text-anchor="middle" font-size="12" fill="#1e293b">Start sparse, hop toward query, descend to refine → visit few nodes, not all N</text>
  <defs><marker id="a30" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#d97706"/></marker></defs>
</svg>
```

---

## 4. Architecture & Workflow

A vector database sits between your embedding pipeline and your application. The lifecycle:

1. **Choose a distance metric** matching your embedding model (cosine for most text embeddings; normalize + dot product is equivalent).
2. **Create a collection/index** with a chosen index type (HNSW or IVF) and its parameters (`M`, `efConstruction` / `nlist`).
3. **Upsert vectors** — insert each embedding with a unique ID and **metadata** (source, timestamp, permissions) for filtering.
4. **Build the index** — the store organizes vectors into the graph/clusters (HNSW builds incrementally; IVF trains cluster centroids first).
5. **Query** — send the query vector, `k`, a search-time parameter (`efSearch` / `nprobe`), and optional metadata filters.
6. **Filter + search** — the store applies metadata predicates and runs ANN over the candidate set, returning the top-k IDs, distances, and metadata.
7. **(Optional) re-rank** — re-score top candidates on full/uncompressed vectors or with a cross-encoder for precision.
8. **Maintain** — handle inserts/updates/deletes, re-index or compact as data drifts, and monitor recall.

```svg
<svg viewBox="0 0 660 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="660" height="320" fill="#eef2ff"/>
  <text x="330" y="26" text-anchor="middle" font-size="16" fill="#1e293b" font-weight="bold">Vector DB: ingest &amp; query paths</text>
  <text x="150" y="52" text-anchor="middle" font-size="12" fill="#d97706" font-weight="bold">INGEST</text>
  <rect x="40" y="62" width="110" height="44" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="95" y="82" text-anchor="middle" font-size="11" fill="#1e293b">Embed items</text>
  <text x="95" y="97" text-anchor="middle" font-size="10" fill="#1e293b">+ metadata</text>
  <rect x="175" y="62" width="110" height="44" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="230" y="88" text-anchor="middle" font-size="11" fill="#1e293b">Upsert (id, vec)</text>
  <rect x="310" y="62" width="130" height="44" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="375" y="82" text-anchor="middle" font-size="11" fill="#1e293b">ANN index</text>
  <text x="375" y="97" text-anchor="middle" font-size="10" fill="#1e293b">HNSW / IVF</text>
  <line x1="150" y1="84" x2="173" y2="84" stroke="#4f46e5" stroke-width="2" marker-end="url(#a30b)"/>
  <line x1="285" y1="84" x2="308" y2="84" stroke="#4f46e5" stroke-width="2" marker-end="url(#a30b)"/>
  <text x="150" y="152" text-anchor="middle" font-size="12" fill="#0ea5e9" font-weight="bold">QUERY</text>
  <rect x="40" y="162" width="110" height="44" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="95" y="182" text-anchor="middle" font-size="11" fill="#1e293b">Query vector</text>
  <text x="95" y="197" text-anchor="middle" font-size="10" fill="#1e293b">+ k, filter</text>
  <rect x="175" y="162" width="130" height="44" rx="6" fill="#ffffff" stroke="#4f46e5" stroke-width="2"/>
  <text x="240" y="182" text-anchor="middle" font-size="11" fill="#1e293b">Filter + ANN</text>
  <text x="240" y="197" text-anchor="middle" font-size="10" fill="#1e293b">efSearch / nprobe</text>
  <rect x="330" y="162" width="130" height="44" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="395" y="182" text-anchor="middle" font-size="11" fill="#1e293b">Top-k results</text>
  <text x="395" y="197" text-anchor="middle" font-size="10" fill="#1e293b">ids + distances</text>
  <rect x="485" y="162" width="130" height="44" rx="6" fill="#fce7f3" stroke="#db2777" stroke-width="2"/>
  <text x="550" y="182" text-anchor="middle" font-size="11" fill="#1e293b">Re-rank</text>
  <text x="550" y="197" text-anchor="middle" font-size="10" fill="#1e293b">(optional)</text>
  <line x1="150" y1="184" x2="173" y2="184" stroke="#0ea5e9" stroke-width="2" marker-end="url(#a30b)"/>
  <line x1="305" y1="184" x2="328" y2="184" stroke="#0ea5e9" stroke-width="2" marker-end="url(#a30b)"/>
  <line x1="460" y1="184" x2="483" y2="184" stroke="#0ea5e9" stroke-width="2" marker-end="url(#a30b)"/>
  <line x1="375" y1="106" x2="240" y2="160" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="4"/>
  <text x="500" y="70" font-size="11" fill="#64748b">recall ↔ latency ↔ memory</text>
  <rect x="470" y="80" width="150" height="34" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="545" y="102" text-anchor="middle" font-size="11" fill="#1e293b">tune the triangle</text>
  <defs><marker id="a30b" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#4f46e5"/></marker></defs>
</svg>
```

---

## 5. Implementation

First, the essence — an exact (flat) search in NumPy to see what an ANN index approximates:

```python
import numpy as np

rng = np.random.default_rng(0)
DB = rng.normal(size=(10_000, 384)).astype("float32")
DB /= np.linalg.norm(DB, axis=1, keepdims=True)          # normalize for cosine

def flat_search(query, k=5):
    q = query / np.linalg.norm(query)
    sims = DB @ q                                         # cosine (normalized)
    idx = np.argpartition(-sims, k)[:k]
    idx = idx[np.argsort(-sims[idx])]
    return idx, sims[idx]

ids, scores = flat_search(DB[42] + 0.01 * rng.normal(size=384))
print(ids[:3], scores[:3])   # 42 should be the nearest neighbor
```

In production you use a real vector database or an ANN library like FAISS. Building an HNSW index with FAISS:

```python
import faiss
import numpy as np

d = 384
xb = np.random.default_rng(0).normal(size=(100_000, d)).astype("float32")
faiss.normalize_L2(xb)                                    # cosine via inner product

# HNSW index: M = graph connectivity; efConstruction = build-time breadth
index = faiss.IndexHNSWFlat(d, 32, faiss.METRIC_INNER_PRODUCT)
index.hnsw.efConstruction = 200
index.add(xb)

index.hnsw.efSearch = 64                                  # search-time recall dial
q = xb[:1]
distances, ids = index.search(q, k=5)                    # returns top-5
print(ids[0], distances[0])
```

An IVF index for memory efficiency at large scale (train centroids, then search a few clusters):

```python
nlist = 256                                               # number of clusters
quantizer = faiss.IndexFlatIP(d)
ivf = faiss.IndexIVFFlat(quantizer, d, nlist, faiss.METRIC_INNER_PRODUCT)
ivf.train(xb)                                             # k-means on the data
ivf.add(xb)
ivf.nprobe = 16                                           # search 16/256 clusters
distances, ids = ivf.search(q, k=5)
```

Using a managed vector DB (Qdrant) with metadata filtering, the pattern generalizes across providers (Pinecone, Weaviate, pgvector):

```python
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct, Filter, FieldCondition, MatchValue

client = QdrantClient(":memory:")
client.create_collection("docs", vectors_config=VectorParams(size=384, distance=Distance.COSINE))

client.upsert("docs", points=[
    PointStruct(id=1, vector=xb[0].tolist(), payload={"dept": "hr"}),
    PointStruct(id=2, vector=xb[1].tolist(), payload={"dept": "eng"}),
])

hits = client.search(
    "docs", query_vector=xb[0].tolist(), limit=5,
    query_filter=Filter(must=[FieldCondition(key="dept", match=MatchValue(value="hr"))]),
)
print([(h.id, h.score) for h in hits])
```

**Optimization note:** Match the metric to your embeddings (cosine for most text models), normalize vectors so you can use fast inner-product search, and tune the *search-time* parameter (`efSearch`/`nprobe`) to hit your recall target — start low and raise it until recall plateaus, since latency grows with it. For billions of vectors, use IVF-PQ to fit in RAM and re-rank the top candidates on full vectors to recover accuracy. Always benchmark recall against a brute-force ground truth on a sample; an ANN index that's fast but low-recall silently degrades your whole application.

---

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| ANN search | Sub-linear, millisecond top-k over millions of vectors | Approximate — recall < 100%; needs tuning |
| HNSW | High recall, low latency | High memory footprint (stores the graph) |
| IVF | Memory-efficient at huge scale | Lower recall unless `nprobe` is raised (slower) |
| PQ / IVF-PQ | Fits billions of vectors in RAM | Accuracy loss; needs re-ranking to recover |
| Metadata filtering | Combine semantic + structured constraints | Filtering can interact awkwardly with the ANN graph |
| Managed vector DB | Persistence, sharding, updates, auth built in | Operational cost; another system to run |
| Flat (exact) | 100% recall | O(N) per query; only viable at small scale |

---

## 7. Common Mistakes & Best Practices

1. ⚠️ Using the wrong distance metric for your embeddings → ✅ Match the metric to the model (cosine for most text embeddings); mismatches quietly wreck ranking.
2. ⚠️ Not normalizing vectors then using dot product → ✅ L2-normalize so dot product equals cosine and search is fast and correct.
3. ⚠️ Assuming ANN returns exact neighbors → ✅ It's approximate; measure recall against a brute-force ground truth and tune to your target.
4. ⚠️ Leaving `efSearch`/`nprobe` at defaults → ✅ Tune the search-time parameter to hit your recall vs latency target; defaults are rarely optimal.
5. ⚠️ Picking HNSW blindly at billion-scale → ✅ HNSW's memory cost explodes; use IVF-PQ (or disk-based indexes) when vectors won't fit in RAM.
6. ⚠️ Forgetting metadata → ✅ Store rich metadata (source, date, permissions) with each vector so you can filter and enforce access.
7. ⚠️ Applying filters that leave too few candidates → ✅ Very selective filters can starve the ANN graph; test filtered recall, not just unfiltered.
8. ⚠️ Never re-indexing after heavy churn → ✅ Deletes and drift degrade indexes over time; compact/re-index periodically.
9. ⚠️ Re-embedding with a new model but keeping the old index → ✅ Changing the embedding model invalidates the vector space; rebuild the entire index.
10. ⚠️ Skipping re-ranking after PQ → ✅ When using quantization, re-score the top candidates on full vectors to recover the accuracy PQ trades away.

---

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** When results look wrong, first check the metric and normalization — a cosine-trained embedding searched with L2 gives plausible-but-wrong neighbors. Then measure recall: build a brute-force ground truth on a query sample and compare it to the ANN results; low recall means raise `efSearch`/`nprobe` or rebuild the index. Verify metadata filters aren't over-restricting the candidate set. Log query vectors, returned IDs, and distances so you can reproduce a bad retrieval.

**Monitoring.** Track recall (sampled against ground truth), p50/p95 query latency, index memory usage, ingest throughput, and index size/growth. Alert when recall drops after a reindex, a parameter change, or an embedding-model swap, and when latency creeps up as the collection grows (a signal to shard or retune).

**Security.** Metadata-based **access control** must be enforced at query time — attach permission tags (user, role, tenant) to vectors and filter on them so a similarity search can't return documents the caller isn't authorized to see. In multi-tenant systems, isolate tenants by namespace/collection or a mandatory tenant filter. Also validate ingest input (a malicious payload in metadata can be an injection vector downstream if you feed it into prompts unescaped).

**Scaling.** Scale up by choosing memory-efficient indexes (IVF-PQ) and re-ranking; scale out by sharding vectors across nodes and fanning queries out with result merging. Use replicas for read throughput and availability. Batch upserts, build indexes offline, and separate the write path (ingest/index) from the read path (query). For latency-critical serving, keep hot vectors in RAM and warm the index; managed vector DBs handle much of this, but you still own the recall/latency/memory tuning.

---

## 9. Interview Questions

**Q: What is a vector database and how does it differ from a traditional database?**
A: A vector database stores high-dimensional embeddings and retrieves the ones most *similar* to a query vector, using approximate nearest-neighbor indexes. A traditional database indexes and matches *exact* values or ranges. Vector DBs search by semantic proximity (find the closest meaning); relational DBs search by exact predicates (find where id = 42).

**Q: Why use approximate nearest-neighbor search instead of exact?**
A: Exact (brute-force) search compares the query against every stored vector — O(N·d) per query — which is fine for thousands but far too slow for millions or billions of vectors. ANN indexes visit only a small, cleverly chosen subset (a graph neighborhood or a few clusters), giving sub-linear search that returns almost all the true neighbors at a fraction of the latency.

**Q: Compare HNSW and IVF.**
A: HNSW is a multi-layer navigable graph — high recall and low latency, but memory-heavy because it stores the graph structure. IVF clusters vectors and searches only the nearest clusters — far more memory-efficient at huge scale, but lower recall unless you raise `nprobe` (which costs latency). HNSW is the default for high-recall serving that fits in RAM; IVF (often IVF-PQ) is for billion-scale corpora.

**Q: Which distance metric should you use and why does it matter?**
A: Use the metric the embedding model was trained for — cosine similarity for most text embeddings, or equivalently dot product on L2-normalized vectors. Using the wrong metric (e.g. Euclidean on cosine-trained vectors) silently degrades ranking, returning plausible-looking but incorrect neighbors. Matching the metric to the model is a prerequisite for good results.

**Q: What is recall in the context of ANN, and how do you tune it?**
A: Recall is the fraction of the true top-k neighbors that the ANN index actually returns. You tune it with the search-time parameter — `efSearch` in HNSW or `nprobe` in IVF — where higher values explore more candidates for better recall at higher latency. You set the target by benchmarking against a brute-force ground truth on a query sample.

**Q: What is product quantization and when do you use it?**
A: PQ compresses each vector into a short code (splitting it into sub-vectors, each replaced by the nearest centroid ID), shrinking memory dramatically — e.g. a 1.5KB vector to ~64 bytes. Use it (usually as IVF-PQ) when billions of vectors won't fit in RAM. It costs some accuracy, which you recover by re-ranking the top candidates on their full, uncompressed vectors.

**Q: (Senior) You have 2 billion vectors and a 200ms latency budget. What index and why?**
A: HNSW alone would need far too much RAM for 2B vectors, so use IVF-PQ: PQ compresses vectors to fit in memory, IVF restricts search to the nearest clusters for speed, and you re-rank the top candidates on full vectors (or a small HNSW over a shard) to recover recall. Shard across nodes, tune `nprobe` to hit ~200ms at your recall target, and benchmark recall against a brute-force sample.

**Q: (Senior) How does metadata filtering interact with ANN, and what can go wrong?**
A: Filtering restricts results to vectors matching structured predicates (date, tenant, permissions). The challenge is that a highly selective filter can leave the ANN graph/clusters with too few valid candidates near the query, so the index either returns fewer than k results or has to search much wider (raising latency). Pre-filtering vs post-filtering strategies trade recall against speed, so you must test *filtered* recall, not just unfiltered.

**Q: (Senior) A vector search returns fast but the RAG answers are poor. Where do you look?**
A: Fast-but-wrong points to low recall or a metric mismatch. Verify the distance metric matches the embedding model and vectors are normalized, then measure recall against a brute-force ground truth — if it's low, raise `efSearch`/`nprobe` or rebuild the index. Also check that a metadata filter isn't starving the candidate set, and that the query is embedded with the same model as the index.

**Q: Why must you rebuild the index when you change the embedding model?**
A: Each embedding model defines its own vector space; vectors from different models aren't comparable. If you re-embed queries with a new model but keep an index built by the old one, distances become meaningless and retrieval degrades to noise. Changing the embedding model requires re-embedding and re-indexing the entire corpus.

**Q: What are the key HNSW parameters?**
A: `M` (max connections per node) controls graph density — higher improves recall and memory use; `efConstruction` controls how thoroughly the graph is built at insert time — higher means a better index but slower builds; `efSearch` controls how many candidates are explored per query — higher means better recall at higher latency. Build-time params (`M`, `efConstruction`) are fixed at index creation; `efSearch` is tunable per query.

**Q: When is a plain flat (exact) index the right choice?**
A: At small scale — up to tens of thousands of vectors — where brute-force O(N) search is still fast enough and you want guaranteed 100% recall with zero tuning. It's also useful as the ground-truth baseline for measuring an ANN index's recall. Beyond that scale, latency forces you to an ANN index.

---

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** A vector database stores embeddings and finds the nearest ones to a query fast. Exact search is O(N); ANN indexes (HNSW, IVF) make it sub-linear by trading a little recall. HNSW = navigable graph, high recall + low latency, memory-heavy; IVF = cluster-and-probe, memory-efficient at scale, tune `nprobe`; PQ compresses vectors to fit billions in RAM, re-rank to recover accuracy. Match the distance metric to your embedding model (cosine for text; normalize + dot product is equivalent). Tune the search-time knob (`efSearch`/`nprobe`) to hit a recall target measured against brute-force ground truth. Store metadata for filtering and access control, and rebuild the index whenever the embedding model changes.

| Index | Best for | Watch |
|---|---|---|
| Flat | < ~10⁴ vectors, exact recall | O(N) latency |
| HNSW | High recall, in-RAM serving | Memory footprint |
| IVF | Large scale, memory-limited | Tune `nprobe` for recall |
| IVF-PQ | Billions of vectors | Accuracy loss → re-rank |

Flash cards:
- **HNSW's search-time recall dial?** → `efSearch`.
- **IVF's search-time recall dial?** → `nprobe`.
- **Default metric for text embeddings?** → Cosine (or normalized dot product).
- **What does PQ trade?** → Accuracy for memory; recover via re-ranking.
- **Change the embedding model — what must you do?** → Rebuild the entire index.

---

## 11. Hands-On Exercises & Mini Project

- [ ] Implement flat cosine search in NumPy and use it as ground truth to measure the recall of an ANN index.
- [ ] Build HNSW and IVF indexes over the same 100k vectors and compare recall, latency, and memory.
- [ ] Sweep `efSearch` (HNSW) and `nprobe` (IVF) and plot recall vs latency; find the knee of the curve.
- [ ] Add metadata to vectors and run filtered searches; measure how a very selective filter affects recall and latency.
- [ ] Compare cosine vs Euclidean on a set of normalized text embeddings and confirm the ranking difference (or lack thereof).

**Mini Project — Semantic search service.**
*Goal:* A small semantic search API over a text corpus, backed by a real ANN index, with a measured recall/latency profile.
*Requirements:* Chunk + embed a corpus; index with HNSW (and an IVF variant); expose a `/search?q=&k=&filter=` endpoint returning ids, scores, and metadata; compute recall against a brute-force baseline; report p95 latency at your chosen `efSearch`/`nprobe`.
*Extension ideas:* Add IVF-PQ and re-ranking, measuring the accuracy recovery; add per-tenant metadata filtering and access control; shard the index across two processes and merge results; wire it into the RAG assistant from Chapter 29.

---

## 12. Related Topics & Free Learning Resources

Sibling chapters: **Retrieval-Augmented Generation (RAG)** (the primary consumer of vector search), **How LLMs Work** (where embeddings come from), **Context Windows, Tokens & Cost** (why retrieving beats stuffing context), and **Prompt Engineering** (using retrieved results in prompts).

**Free Learning Resources**
- **Efficient and robust ANN using HNSW graphs** — Malkov & Yashunin · *Advanced* · the HNSW paper; the algorithm behind most high-recall indexes. <https://arxiv.org/abs/1603.09320>
- **Product Quantization for Nearest Neighbor Search** — Jégou et al. · *Advanced* · the compression technique behind IVF-PQ. <https://ieeexplore.ieee.org/document/5432202>
- **FAISS Documentation & Wiki** — Meta AI · *Intermediate* · the reference library for ANN indexes, with a guide to choosing one. <https://github.com/facebookresearch/faiss/wiki>
- **Pinecone Learn: Vector indexes (HNSW, IVF, PQ)** — Pinecone · *Beginner→Intermediate* · clear, visual explainers of each index type. <https://www.pinecone.io/learn/series/faiss/>
- **Qdrant Documentation** — Qdrant · *Beginner→Intermediate* · practical vector DB usage, filtering, and index tuning. <https://qdrant.tech/documentation/>
- **pgvector** — open source · *Beginner* · add vector search to Postgres; great for learning the primitives in a familiar DB. <https://github.com/pgvector/pgvector>
- **ANN-Benchmarks** — Aumüller et al. · *Advanced* · reproducible recall-vs-latency comparisons across every major ANN library. <https://ann-benchmarks.com/>

---

*AI Engineering Handbook — chapter 30.*
