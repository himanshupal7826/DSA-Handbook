# 31 · Chunking, Embeddings & Reranking

> **In one line:** Retrieval quality is a stack — how you split documents, how you embed them, how you search, and how you rerank — and the weakest layer caps your RAG system's ceiling.

---

## 1. Overview

Retrieval-Augmented Generation (RAG) is only as good as what it retrieves. A perfect LLM handed the wrong three passages will confidently answer the wrong question. The retrieval stack is the machinery that decides *which* passages the model sees, and it has four layers: **chunking** (splitting source documents into retrievable units), **embedding** (mapping each chunk to a vector), **search** (finding candidate chunks for a query), and **reranking** (reordering candidates so the best ones land in the top-k the model actually reads).

The problem it solves is grounding. LLMs have a fixed training cutoff and a bounded context window; you cannot paste an entire 40,000-page knowledge base into a prompt, and even if you could, attention degrades and cost explodes. RAG keeps the model small-context and current by fetching only the handful of passages relevant to each query. The retrieval stack is what makes that fetch accurate.

Historically, search meant lexical matching — BM25 and TF-IDF, which score documents by term overlap. That works until the user asks "how do I reset my password" and the document says "credential recovery procedure." Dense embeddings (from models like `text-embedding-3` or open-source `bge`, `e5`, `gte` families) solved the vocabulary-mismatch problem by matching *meaning*, but they miss exact identifiers (error codes, SKUs, function names) that lexical search nails. Modern systems fuse both — **hybrid search** — and then apply a **cross-encoder reranker** to squeeze precision out of the top candidates.

A concrete example: a support bot over 50,000 help-center articles. A user types "app crashes when I open PDF on Android." Chunking split each article into ~400-token passages. The query is embedded and run against a vector index (semantic recall) *and* a BM25 index (catches "PDF", "Android" exactly). The two candidate lists are fused into ~50 chunks, a cross-encoder reranks them by true query-passage relevance, and the top 5 go into Claude's prompt. Each layer measurably lifts answer accuracy — and each layer, done wrong, silently caps it.

---

## 2. Core Concepts

- **Chunk** — a retrievable unit of text, typically 200–800 tokens, carrying metadata (source, section, position) so the model can cite it.
- **Embedding** — a dense vector (e.g. 768 or 1536 dimensions) representing a chunk's meaning; semantically similar text lands nearby in vector space.
- **Bi-encoder** — the embedding model architecture: query and document are encoded *independently*, so document vectors can be precomputed and indexed. Fast, scalable, less precise.
- **Cross-encoder** — a reranker architecture: query and document are concatenated and passed through the model *together*, producing one relevance score. Slow (no precompute), but far more accurate.
- **BM25** — a lexical ranking function scoring documents by term frequency and inverse document frequency; the workhorse of keyword search.
- **Hybrid search** — combining dense (semantic) and sparse (lexical) retrieval, usually fused with Reciprocal Rank Fusion (RRF).
- **Recall@k** — fraction of queries for which a relevant chunk appears in the top-k retrieved. The metric retrieval optimizes; if the right chunk isn't in candidates, no reranker can save you.
- **ANN (Approximate Nearest Neighbor)** — index structures like HNSW that find near-neighbors in a vector space in sub-linear time, trading a little recall for large speedups.
- **Contextual chunk** — a chunk prepended with a short LLM-generated summary of its place in the parent document, dramatically improving retrievability of ambiguous passages.

---

## 3. Theory & Mathematical Intuition

Dense retrieval scores a query `q` against a chunk `d` by the similarity of their embeddings. The dominant choice is **cosine similarity**:

```
cos(q, d) = (v_q · v_d) / (||v_q|| · ||v_d||)
```

where `v_q`, `v_d` are the embedding vectors. If vectors are L2-normalized, cosine similarity reduces to a plain dot product `v_q · v_d`, which is why most vector databases normalize on ingest and use dot-product internally.

BM25 scores lexically. For a query with terms `t`, the score of document `d` is:

```
BM25(q, d) = Σ_t IDF(t) · [ f(t,d) · (k1 + 1) ] / [ f(t,d) + k1 · (1 - b + b · |d|/avgdl) ]
```

where `f(t,d)` is term frequency, `|d|` is document length, `avgdl` is the average, and `k1 ≈ 1.2`, `b ≈ 0.75` are tuning constants. `IDF(t)` down-weights common terms. The `b` term penalizes long documents so a term isn't over-rewarded just for appearing in a big chunk.

Because dense and lexical scores live on incomparable scales, hybrid systems fuse by *rank*, not score, using **Reciprocal Rank Fusion**:

```
RRF(d) = Σ_retrievers  1 / (k + rank_i(d))          # k ≈ 60
```

Each retriever contributes `1/(k+rank)`; a chunk ranked #1 by either method gets a large boost, and the constant `k` dampens the influence of low ranks. RRF is robust precisely because it ignores raw score magnitudes.

The reranker is a different beast. A bi-encoder computes `sim(v_q, v_d)` from two independent passes, so it can't model *interactions* between query and document tokens. A cross-encoder feeds `[CLS] query [SEP] document [SEP]` through a transformer and reads a single relevance logit, letting every query token attend to every document token. That cross-attention is where the precision comes from — and why it can't be precomputed.

```svg
<svg viewBox="0 0 720 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="720" height="300" fill="#ffffff"/>
  <text x="180" y="28" font-size="16" font-weight="bold" fill="#1e293b" text-anchor="middle">Bi-encoder (fast, precomputable)</text>
  <rect x="40" y="50" width="120" height="40" rx="6" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="100" y="75" font-size="13" fill="#1e293b" text-anchor="middle">query</text>
  <rect x="200" y="50" width="120" height="40" rx="6" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="260" y="75" font-size="13" fill="#1e293b" text-anchor="middle">document</text>
  <rect x="40" y="120" width="120" height="36" rx="6" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="100" y="143" font-size="12" fill="#1e293b" text-anchor="middle">encoder</text>
  <rect x="200" y="120" width="120" height="36" rx="6" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="260" y="143" font-size="12" fill="#1e293b" text-anchor="middle">encoder</text>
  <line x1="100" y1="90" x2="100" y2="120" stroke="#4f46e5" stroke-width="2"/>
  <line x1="260" y1="90" x2="260" y2="120" stroke="#4f46e5" stroke-width="2"/>
  <line x1="100" y1="156" x2="180" y2="200" stroke="#16a34a" stroke-width="2"/>
  <line x1="260" y1="156" x2="180" y2="200" stroke="#16a34a" stroke-width="2"/>
  <rect x="110" y="200" width="140" height="36" rx="6" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="180" y="223" font-size="12" fill="#1e293b" text-anchor="middle">cos similarity</text>
  <text x="560" y="28" font-size="16" font-weight="bold" fill="#1e293b" text-anchor="middle">Cross-encoder (slow, precise)</text>
  <rect x="440" y="50" width="240" height="40" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="560" y="75" font-size="12" fill="#1e293b" text-anchor="middle">query [SEP] document</text>
  <rect x="440" y="120" width="240" height="40" rx="6" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="560" y="145" font-size="12" fill="#1e293b" text-anchor="middle">joint transformer (cross-attention)</text>
  <line x1="560" y1="90" x2="560" y2="120" stroke="#4f46e5" stroke-width="2"/>
  <rect x="490" y="200" width="140" height="36" rx="6" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="560" y="223" font-size="12" fill="#1e293b" text-anchor="middle">relevance score</text>
  <line x1="560" y1="160" x2="560" y2="200" stroke="#16a34a" stroke-width="2"/>
  <text x="360" y="285" font-size="12" fill="#1e293b" text-anchor="middle">Retrieve with the bi-encoder over millions of chunks; rerank the top ~50 with the cross-encoder.</text>
</svg>
```

---

## 4. Architecture & Workflow

1. **Ingest & parse.** Extract clean text from source documents (PDF, HTML, Markdown), stripping boilerplate and preserving structure (headings, tables, code blocks).
2. **Chunk.** Split into passages. Prefer *structure-aware* splitting (by heading or semantic boundary) over blind fixed-size windows; add a small overlap (10–20%) so ideas that straddle a boundary aren't lost.
3. **Enrich (optional).** Prepend contextual summaries or attach metadata (title, section, date) to each chunk. Contextual retrieval — an Anthropic-published technique — has each chunk carry an LLM-written sentence situating it in its parent document.
4. **Embed.** Run each chunk through a bi-encoder; store the vector plus the raw text and metadata.
5. **Index.** Load vectors into an ANN index (HNSW/IVF) for semantic search, and the raw text into a BM25/inverted index for lexical search.
6. **Query time — dual retrieve.** Embed the user query and run ANN search; run the same query through BM25. Take the top ~25 from each.
7. **Fuse.** Combine the two candidate lists with RRF into one deduplicated list of ~50.
8. **Rerank.** Score every (query, chunk) pair with a cross-encoder; keep the top 3–8.
9. **Assemble & generate.** Insert the top chunks (with citations) into the prompt and call the LLM.

```svg
<svg viewBox="0 0 720 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="720" height="340" fill="#ffffff"/>
  <text x="360" y="26" font-size="16" font-weight="bold" fill="#1e293b" text-anchor="middle">Hybrid retrieval + rerank pipeline</text>
  <rect x="20" y="50" width="130" height="46" rx="6" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="85" y="78" font-size="12" fill="#1e293b" text-anchor="middle">user query</text>
  <rect x="200" y="45" width="150" height="40" rx="6" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="275" y="70" font-size="12" fill="#1e293b" text-anchor="middle">dense: ANN (HNSW)</text>
  <rect x="200" y="100" width="150" height="40" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="275" y="125" font-size="12" fill="#1e293b" text-anchor="middle">sparse: BM25</text>
  <line x1="150" y1="65" x2="200" y2="65" stroke="#4f46e5" stroke-width="2"/>
  <line x1="150" y1="73" x2="200" y2="120" stroke="#4f46e5" stroke-width="2"/>
  <rect x="400" y="72" width="120" height="46" rx="6" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="460" y="94" font-size="12" fill="#1e293b" text-anchor="middle">RRF fuse</text>
  <text x="460" y="110" font-size="11" fill="#1e293b" text-anchor="middle">~50 candidates</text>
  <line x1="350" y1="65" x2="400" y2="90" stroke="#16a34a" stroke-width="2"/>
  <line x1="350" y1="120" x2="400" y2="100" stroke="#16a34a" stroke-width="2"/>
  <rect x="560" y="72" width="140" height="46" rx="6" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="630" y="94" font-size="12" fill="#1e293b" text-anchor="middle">cross-encoder</text>
  <text x="630" y="110" font-size="11" fill="#1e293b" text-anchor="middle">rerank to top 5</text>
  <line x1="520" y1="95" x2="560" y2="95" stroke="#4f46e5" stroke-width="2"/>
  <rect x="280" y="200" width="160" height="46" rx="6" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="360" y="222" font-size="12" fill="#1e293b" text-anchor="middle">prompt assembly</text>
  <text x="360" y="238" font-size="11" fill="#1e293b" text-anchor="middle">top chunks + citations</text>
  <line x1="630" y1="118" x2="440" y2="205" stroke="#0ea5e9" stroke-width="2"/>
  <rect x="280" y="280" width="160" height="44" rx="6" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="360" y="307" font-size="12" fill="#1e293b" text-anchor="middle">LLM (claude-sonnet-4)</text>
  <line x1="360" y1="246" x2="360" y2="280" stroke="#16a34a" stroke-width="2"/>
  <rect x="20" y="200" width="200" height="60" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="120" y="224" font-size="11" fill="#1e293b" text-anchor="middle">offline: chunk to embed</text>
  <text x="120" y="242" font-size="11" fill="#1e293b" text-anchor="middle">to index (HNSW + BM25)</text>
</svg>
```

---

## 5. Implementation

A minimal but realistic hybrid + rerank pipeline. Embedding and reranking here use the open-source `sentence-transformers` stack so the code runs anywhere; swap in a hosted embedding API in production.

```python
import numpy as np
from sentence_transformers import SentenceTransformer, CrossEncoder
from rank_bm25 import BM25Okapi

# --- Offline: chunk + embed ---
bi_encoder = SentenceTransformer("BAAI/bge-small-en-v1.5")  # 384-dim bi-encoder

def chunk_text(text, max_tokens=400, overlap=60):
    words = text.split()
    step = max_tokens - overlap
    return [" ".join(words[i:i + max_tokens]) for i in range(0, len(words), step)]

docs = chunk_text(open("kb.txt").read())
# Normalize so dot product == cosine similarity
embeddings = bi_encoder.encode(docs, normalize_embeddings=True)  # shape (N, 384)
tokenized = [d.lower().split() for d in docs]
bm25 = BM25Okapi(tokenized)
```

```python
# --- Query time: dense + sparse retrieve, RRF fuse ---
def rrf(rank_lists, k=60):
    scores = {}
    for ranks in rank_lists:
        for rank, idx in enumerate(ranks):
            scores[idx] = scores.get(idx, 0.0) + 1.0 / (k + rank)
    return sorted(scores, key=scores.get, reverse=True)

def retrieve(query, top_n=25):
    q_vec = bi_encoder.encode([query], normalize_embeddings=True)[0]
    dense_scores = embeddings @ q_vec            # cosine via dot product
    dense_ranks = np.argsort(dense_scores)[::-1][:top_n].tolist()
    sparse_scores = bm25.get_scores(query.lower().split())
    sparse_ranks = np.argsort(sparse_scores)[::-1][:top_n].tolist()
    return rrf([dense_ranks, sparse_ranks])       # fused candidate indices

# --- Rerank with a cross-encoder ---
reranker = CrossEncoder("cross-encoder/ms-marco-MiniLM-L-6-v2")

def search(query, k=5):
    candidates = retrieve(query)[:50]
    pairs = [(query, docs[i]) for i in candidates]
    scores = reranker.predict(pairs)              # joint query-doc scoring
    order = np.argsort(scores)[::-1][:k]
    return [docs[candidates[i]] for i in order]

for chunk in search("app crashes opening PDF on Android"):
    print(chunk[:80], "...")
# app crashes opening PDF on Android ... (relevant chunk floated to #1)
```

**Optimization note.** The cross-encoder is the latency bottleneck — every candidate is a full forward pass. Keep the candidate set small (≤50), batch the pairs into one `predict` call (a single vectorized GPU pass beats 50 sequential ones by 10–30×), and cache reranker scores keyed by `(query_hash, chunk_id)`. For the ANN index, tune HNSW's `ef_search`: higher improves recall at the cost of latency. If your embedding model supports **Matryoshka** truncation, storing 256-dim vectors instead of 1536 cuts index size and query cost ~6× with a small recall hit.

---

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
| --- | --- | --- |
| Dense embeddings | Match meaning; robust to paraphrase/vocabulary mismatch | Miss exact identifiers (codes, names); model + index cost |
| BM25 lexical | Exact-term precision, zero training, cheap, interpretable | Blind to synonyms; brittle to spelling/paraphrase |
| Hybrid (RRF) | Recovers both failure modes; robust across query types | Two indexes to maintain; fusion constant to tune |
| Cross-encoder rerank | Large precision lift on the top-k | No precompute; adds 50–300 ms; GPU cost per query |
| Small chunks | Precise retrieval, tight citations | Lose surrounding context; more chunks to index |
| Large chunks | Preserve context, fewer vectors | Dilute relevance; waste context-window budget |
| Contextual chunks | Big recall gains on ambiguous passages | One LLM call per chunk at ingest; higher ingest cost |

---

## 7. Common Mistakes & Best Practices

1. ⚠️ Splitting on a fixed character count mid-sentence → ✅ split on structure (headings, paragraphs, sentence boundaries) with modest overlap.
2. ⚠️ Embedding query and documents with *different* models → ✅ use the identical model (and identical normalization) for both sides.
3. ⚠️ Forgetting to L2-normalize before dot-product search → ✅ normalize on ingest and at query time, or use the DB's native cosine metric.
4. ⚠️ Relying on dense search alone and losing exact error codes/SKUs → ✅ add BM25 and fuse.
5. ⚠️ Reranking the entire corpus with a cross-encoder → ✅ rerank only the top ~50 candidates from cheap retrieval.
6. ⚠️ Fusing dense and sparse by adding raw scores → ✅ fuse by rank (RRF); raw scores are on incomparable scales.
7. ⚠️ Chunks so large they blow the context window → ✅ size chunks to fit k passages comfortably within budget.
8. ⚠️ Never measuring retrieval → ✅ build a labeled query set and track Recall@k and rerank nDCG; optimize the layer that's actually failing.
9. ⚠️ Stripping metadata, so the model can't cite or filter → ✅ carry source, section, and date on every chunk and filter by them.
10. ⚠️ Re-embedding the whole corpus on every deploy → ✅ version embeddings by model+config and only re-embed changed documents.

---

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** When answers are wrong, isolate the failing layer. Log the fused candidate list *and* the post-rerank list per query. If the gold chunk never appears in candidates, it's a recall problem — fix chunking or embeddings. If it appears in candidates but ranks low after rerank, it's a reranker/precision problem. This two-metric split (Recall@k of retrieval vs. nDCG of rerank) is the single most useful diagnostic.

**Monitoring.** Track Recall@k on a held-out labeled set nightly, p50/p95 retrieval latency, cross-encoder latency, cache hit rate, and index freshness (lag between document update and re-index). Watch for embedding drift when you upgrade the embedding model — it invalidates the entire index.

**Security.** Retrieval is a prime injection surface: a malicious document in the corpus can carry prompt-injection text that the model then reads as instructions. Treat retrieved chunks as untrusted data, keep them clearly delimited from instructions, and apply access control *before* retrieval so a user never gets chunks from documents they can't see (per-tenant filters in the vector query, not post-hoc).

**Scaling.** ANN indexes (HNSW) give sub-linear query time to hundreds of millions of vectors; shard by tenant or topic. The reranker scales with candidate count, so cap it. Use quantized (int8) or Matryoshka-truncated vectors to shrink memory. Batch embedding jobs and re-index incrementally rather than rebuilding.

---

## 9. Interview Questions

**Q: Why not just embed everything and skip BM25?**
A: Dense embeddings match meaning but frequently miss exact tokens — error codes, SKUs, function names, rare proper nouns — because those carry little semantic signal. BM25 nails exact matches. Hybrid fusion covers both failure modes, which is why production systems rarely ship dense-only.

**Q: What's the difference between a bi-encoder and a cross-encoder?**
A: A bi-encoder encodes query and document *independently*, so document vectors can be precomputed and indexed for fast search. A cross-encoder concatenates query and document and passes them through the model together, so every query token attends to every document token — far more accurate but impossible to precompute. Bi-encoder retrieves, cross-encoder reranks.

**Q: Why do we rerank only the top ~50 candidates instead of the whole corpus?**
A: The cross-encoder requires a full forward pass per (query, document) pair, so its cost scales linearly with candidate count. Running it over millions of chunks per query is infeasible. Cheap bi-encoder + BM25 retrieval narrows to a small candidate set; the expensive reranker refines only that.

**Q: How does Reciprocal Rank Fusion work and why rank instead of score?**
A: RRF assigns each document `Σ 1/(k+rank)` across retrievers, so a top-ranked hit from either method gets a large boost. It fuses by rank because dense cosine scores and BM25 scores live on completely different, non-comparable scales — normalizing them is fragile, whereas ranks are directly comparable.

**Q: How do you choose chunk size?**
A: It's a precision-vs-context trade-off. Small chunks retrieve precisely and cite tightly but lose surrounding context; large chunks preserve context but dilute relevance and eat context budget. Start around 300–500 tokens with 10–20% overlap, then tune against a labeled eval set, sizing so k passages fit comfortably in the prompt.

**Q: What is contextual retrieval and what problem does it solve?**
A: Each chunk is prepended with a short LLM-generated sentence situating it in its parent document ("This section of the 2023 refund policy describes..."). Standalone chunks often lack the context needed to be retrieved for an ambiguous query; the added context makes them findable. It costs one LLM call per chunk at ingest but can cut retrieval failures substantially.

**Q: (Senior) Your RAG answers are wrong. How do you decide whether to fix retrieval or generation?**
A: Instrument the two stages separately. Log the retrieved candidates and check whether a gold-relevant chunk is present (Recall@k). If it isn't, the failure is retrieval — fix chunking, embeddings, or hybrid fusion. If the right chunk *is* retrieved but the answer is still wrong, it's a generation problem — prompt, context assembly, or the model ignoring provided evidence. Never tune the two blindly at once.

**Q: (Senior) How do you handle upgrading the embedding model in production?**
A: Embeddings from different models are not comparable, so an upgrade invalidates the entire index — you must re-embed the whole corpus and query with the same new model. Do it as a versioned, blue-green migration: build a parallel index, shadow-evaluate Recall@k against the old one on a labeled set, then cut over. Never mix vectors from two models in one index.

**Q: (Senior) When would you drop the reranker entirely?**
A: When latency budget is tight and the bi-encoder already gives sufficient precision (measured, not assumed), or when queries are short lookups where lexical + dense fusion already ranks the answer at #1. The reranker earns its 50–300 ms cost on nuanced, long, or ambiguous queries; on trivial ones it adds latency for little gain. Decide with an A/B on nDCG.

**Q: Why L2-normalize embeddings before search?**
A: Cosine similarity divides the dot product by the vector magnitudes. If you pre-normalize both sides to unit length, cosine reduces to a plain dot product, which vector databases compute far faster with SIMD/ANN. Skipping normalization while using dot-product search silently biases toward longer vectors.

**Q: What is Recall@k and why is it retrieval's north-star metric?**
A: Recall@k is the fraction of queries for which at least one relevant chunk appears in the top-k retrieved. It's the ceiling on the whole system: if the right chunk isn't in the candidates, no reranker or LLM can recover it. Optimize recall first, then precision via reranking.

**Q: How does HNSW give sub-linear search, and what's the recall trade-off?**
A: HNSW builds a multi-layer navigable small-world graph; queries greedily hop from coarse upper layers to fine lower ones, visiting a small fraction of nodes. That's approximate — you might miss a true nearest neighbor — controlled by `ef_search`: raising it visits more nodes, improving recall at higher latency.

---

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Retrieval quality is a four-layer stack: chunk (split smart, add overlap, keep metadata), embed (one bi-encoder for both sides, normalized), search (dense ANN + BM25, fused by RRF), rerank (cross-encoder over the top ~50 → top 5). Recall@k is the ceiling; the reranker buys precision on top. Debug by splitting the metric: is the gold chunk in candidates (recall) or just ranked low (precision)? Embedding upgrades force a full re-index.

| Layer | Job | Tool | Metric |
| --- | --- | --- | --- |
| Chunk | split docs | structure-aware splitter | — |
| Embed | vectorize | bi-encoder (normalized) | — |
| Retrieve | find candidates | ANN + BM25 → RRF | Recall@k |
| Rerank | order top-k | cross-encoder | nDCG |

- **Bi-encoder** → encodes query & doc separately; precomputable; used for retrieval.
- **Cross-encoder** → encodes them jointly; precise; used for reranking only.
- **RRF** → fuse by `Σ 1/(k+rank)`, not by raw score.
- **Recall@k** → if the chunk isn't here, nothing downstream can fix it.
- **Normalize** → L2-normalize so dot product equals cosine.

---

## 11. Hands-On Exercises & Mini Project

- [ ] Build a 500-chunk index; measure Recall@10 for dense-only, BM25-only, and RRF-hybrid on 30 labeled queries.
- [ ] Add a cross-encoder rerank stage and measure nDCG@5 before vs. after.
- [ ] Sweep chunk size (200 / 400 / 800 tokens) and plot Recall@10 vs. size.
- [ ] Implement contextual chunks (prepend an LLM-written context sentence) and measure the recall delta on ambiguous queries.
- [ ] Add per-tenant metadata filtering to the vector query and verify a user never retrieves another tenant's chunks.

**Mini Project — "Grounded Docs Assistant."** Build a RAG assistant over a documentation set (e.g. a framework's docs).
*Goal:* answer developer questions with citations, correct on both conceptual and exact-identifier queries.
*Requirements:* structure-aware chunking with metadata; hybrid dense + BM25 retrieval fused by RRF; cross-encoder reranking to top 5; Claude (`claude-sonnet-4`) for generation with inline citations; a labeled eval set tracking Recall@10 and answer accuracy.
*Extensions:* add contextual retrieval and quantify the lift; A/B the reranker on latency vs. accuracy; add Matryoshka-truncated vectors and measure the recall/cost trade; add a "no relevant context found" refusal path when top rerank scores fall below a threshold.

---

## 12. Related Topics & Free Learning Resources

- **Chapter 32 — AI Agents: The Loop, Tools & Autonomy** (retrieval as a tool in an agent loop)
- **Chapter 34 — Agent Memory & State** (retrieval-backed long-term memory)
- **Chapter 35 — Model Context Protocol (MCP)** (exposing a retrieval index as an MCP server)

**Free Learning Resources**
- **Contextual Retrieval** — Anthropic · *Advanced* · the canonical writeup on chunk-level context enrichment with measured recall gains. <https://www.anthropic.com/news/contextual-retrieval>
- **Sentence-Transformers Documentation** — UKPLab / Nils Reimers · *Intermediate* · the practical reference for bi-encoders and cross-encoders, with retrieve-and-rerank recipes. <https://www.sbert.net/examples/applications/retrieve_rerank/README.html>
- **BM25 & the Probabilistic Relevance Framework** — Robertson & Zaragoza (Foundations and Trends in IR) · *Advanced* · the definitive treatment of BM25's derivation. <https://www.staff.city.ac.uk/~sbrp622/papers/foundations_bm25_review.pdf>
- **Pinecone Learning Center: Vector Search & Hybrid Retrieval** — Pinecone · *Beginner–Intermediate* · clear, example-driven explainers of ANN, hybrid search, and reranking. <https://www.pinecone.io/learn/>
- **HNSW: Efficient and Robust ANN Search** — Malkov & Yashunin (arXiv) · *Advanced* · the paper behind the index most vector DBs use. <https://arxiv.org/abs/1603.09320>
- **MTEB: Massive Text Embedding Benchmark** — Hugging Face · *Intermediate* · leaderboard and methodology for picking an embedding model by task. <https://huggingface.co/spaces/mteb/leaderboard>

---

*AI Engineering Handbook — chapter 31.*
