# 21 · Embeddings & Representation Learning

> **In one line:** Embeddings map discrete things — words, tokens, users, images — into dense vectors in a learned space where geometric closeness means semantic similarity, turning meaning into arithmetic.

---

## 1. Overview

Machine-learning models multiply numbers, but the world is full of discrete symbols: the word "Paris," user #48213, the SKU for a running shoe. The naive encoding is **one-hot** — a vector with a single 1 in a vocabulary-length slot. One-hot vectors are enormous, sparse, and worst of all *orthogonal*: "cat" and "dog" are exactly as dissimilar as "cat" and "helicopter." They carry no notion of meaning. **Embeddings** solve this by learning a dense, low-dimensional vector for each item such that items used in similar contexts land near each other.

The problem embeddings solve is **representation**: how to encode discrete or high-dimensional data so a downstream model can generalize. Because the vectors are learned from data (usually by predicting context), the geometry ends up encoding relationships. The famous result from word2vec (2013) is that vector arithmetic captures analogies: `king − man + woman ≈ queen`. Directions in the space correspond to concepts like gender, tense, or plurality.

Historically, embeddings began with count-based methods (LSA, co-occurrence + SVD) in the 1990s–2000s, jumped to predictive neural methods with word2vec and GloVe (2013–2014), and then to *contextual* embeddings with ELMo/BERT (2018) where a word's vector depends on its sentence. Today embeddings are the connective tissue of AI: every LLM's first layer is a token embedding, recommender systems embed users and items, RAG systems embed documents for retrieval, and multimodal models like CLIP embed images and text into a shared space.

A concrete real-world example: semantic search. Instead of matching keywords, you embed the query "how do I reset my password" and every help-doc chunk into the same 768- or 1536-dimensional space, then return the chunks whose vectors are closest by cosine similarity. This finds a doc titled "Recovering account access" that shares no keywords with the query — because their meanings are close.

Representation learning is the broader idea: rather than hand-engineering features, let the model learn the features (the embedding) that make the task easy. Master embeddings and you understand the input side of virtually every modern AI system.

## 2. Core Concepts

- **Embedding** — a learned dense vector representing a discrete item; the embedding matrix is a lookup table of shape `(vocab, dim)`.
- **Embedding dimension** — the size of each vector (e.g. 50, 300, 768, 1536); higher captures more nuance at more compute/memory.
- **Distributional hypothesis** — "you shall know a word by the company it keeps"; items in similar contexts get similar vectors.
- **Cosine similarity** — the angle-based similarity `a·b / (‖a‖‖b‖)` in [-1,1], the standard measure of embedding closeness (scale-invariant).
- **Latent space** — the continuous vector space where the geometry (distances, directions) encodes semantic structure.
- **Static vs contextual embeddings** — static (word2vec/GloVe) give one vector per word; contextual (BERT) give a different vector per occurrence based on context.
- **Contrastive learning** — training that pulls positive (similar) pairs together and pushes negatives apart, the workhorse behind sentence and image embeddings.
- **Analogy / linear structure** — meaningful directions (`king−man+woman≈queen`) emerge from the training objective.
- **Nearest-neighbor / ANN search** — retrieving the closest vectors; approximate methods (HNSW, IVF) make it fast at billion scale.
- **Fine-tuning / adaptation** — starting from pretrained embeddings and adjusting them (or a projection) for a specific task or domain.

## 3. Theory & Mathematical Intuition

An embedding layer is just a lookup into a matrix `E ∈ ℝ^{V×d}`: token id `i` returns row `E[i]`. It is mathematically equivalent to multiplying a one-hot vector by `E`, but implemented as an index for efficiency. The magic is in how `E` is *learned*.

**word2vec skip-gram** trains the vectors to predict context words from a center word. For center word `c` and context word `o`, it maximizes:

```
P(o | c) = exp(u_oᵀ v_c) / Σ_w exp(u_wᵀ v_c)      # softmax over the vocabulary
```

The full softmax is too expensive (a sum over the whole vocabulary), so **negative sampling** replaces it: for each true (center, context) pair, sample `k` random "negative" words and train a logistic classifier to say *real* for the true pair and *fake* for the negatives:

```
L = -log σ(u_oᵀ v_c) - Σ_{j=1..k} log σ(-u_{n_j}ᵀ v_c)
```

Words that co-occur end up with high dot products (aligned vectors); unrelated words get pushed apart. This is contrastive learning in disguise.

**Why does analogy arithmetic work?** Because the objective makes vector *offsets* encode consistent relationships. If the "royalty" and "gender" concepts occupy roughly linear subspaces, then `king − man` isolates the royalty direction, and adding `woman` lands near `queen`.

**Similarity metrics.** Cosine similarity is preferred because embedding magnitude often reflects frequency, not meaning; the angle carries the semantics:

```
cos(a, b) = (a · b) / (‖a‖ · ‖b‖)
```

If vectors are L2-normalized, cosine similarity, dot product, and (negated) squared Euclidean distance all rank neighbors identically — which is why retrieval systems normalize and use dot product on hardware-friendly kernels.

**Contrastive objectives** (InfoNCE) generalize this to sentences and images. Given an anchor and a positive, and a batch of negatives, minimize:

```
L = -log[ exp(sim(a,p)/τ) / Σ_x exp(sim(a,x)/τ) ]
```

where `τ` is a temperature. CLIP uses exactly this across image–text pairs to build a shared multimodal space.

The diagram shows how the distributional hypothesis produces clustered, direction-structured geometry.

```svg
<svg viewBox="0 0 620 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="620" height="300" fill="#f0fdf4"/>
  <text x="20" y="26" font-size="15" fill="#1e293b" font-weight="bold">A 2-D slice of embedding space</text>
  <line x1="40" y1="260" x2="580" y2="260" stroke="#1e293b" stroke-width="1"/>
  <line x1="40" y1="260" x2="40" y2="40" stroke="#1e293b" stroke-width="1"/>
  <circle cx="140" cy="90" r="6" fill="#4f46e5"/><text x="150" y="94" font-size="12" fill="#1e293b">king</text>
  <circle cx="220" cy="150" r="6" fill="#4f46e5"/><text x="230" y="154" font-size="12" fill="#1e293b">man</text>
  <circle cx="320" cy="90" r="6" fill="#d97706"/><text x="330" y="94" font-size="12" fill="#1e293b">queen</text>
  <circle cx="400" cy="150" r="6" fill="#d97706"/><text x="410" y="154" font-size="12" fill="#1e293b">woman</text>
  <line x1="220" y1="150" x2="140" y2="90" stroke="#16a34a" stroke-width="1.6" marker-end="url(#a21)"/>
  <line x1="400" y1="150" x2="320" y2="90" stroke="#16a34a" stroke-width="1.6" marker-end="url(#a21)"/>
  <text x="150" y="130" font-size="10" fill="#16a34a">+royal</text>
  <text x="335" y="130" font-size="10" fill="#16a34a">+royal</text>
  <circle cx="480" cy="215" r="6" fill="#0ea5e9"/><text x="490" y="219" font-size="12" fill="#1e293b">helicopter</text>
  <text x="120" y="230" font-size="11" fill="#1e293b">Related words cluster; the "royalty" offset is a consistent direction.</text>
  <defs><marker id="a21" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#16a34a"/></marker></defs>
</svg>
```

## 4. Architecture & Workflow

How a semantic-search / RAG retrieval pipeline uses embeddings end to end:

1. **Chunk** — split documents into passages (e.g. 200–500 tokens) so each embedding represents a coherent unit.
2. **Embed corpus** — run each chunk through an embedding model (e.g. a sentence-transformer or a hosted embeddings API) to get a fixed-size vector; normalize to unit length.
3. **Index** — store vectors in a vector database (FAISS, pgvector, Pinecone) using an ANN index (HNSW/IVF) for sub-linear nearest-neighbor search.
4. **Embed query** — at request time, encode the user's query with the *same* model into the same space.
5. **Search** — retrieve the top-`k` nearest chunks by cosine/dot-product similarity.
6. **Re-rank (optional)** — pass candidates through a cross-encoder for higher-precision ordering.
7. **Use** — feed the retrieved chunks into an LLM prompt (RAG) or return them as search results.
8. **Maintain** — re-embed on model upgrades, handle inserts/deletes, and monitor retrieval quality (recall@k).

```svg
<svg viewBox="0 0 640 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="640" height="300" fill="#e0f2fe"/>
  <text x="20" y="26" font-size="15" fill="#1e293b" font-weight="bold">Embedding-based retrieval pipeline</text>
  <rect x="30" y="60" width="110" height="46" rx="6" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="48" y="88" font-size="11" fill="#1e293b">documents</text>
  <rect x="30" y="150" width="110" height="46" rx="6" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="52" y="178" font-size="11" fill="#1e293b">query</text>
  <rect x="200" y="60" width="120" height="46" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="212" y="82" font-size="11" fill="#1e293b">embed model</text>
  <text x="235" y="98" font-size="10" fill="#1e293b">(shared)</text>
  <rect x="200" y="150" width="120" height="46" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="212" y="178" font-size="11" fill="#1e293b">embed model</text>
  <rect x="380" y="60" width="120" height="46" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="392" y="88" font-size="11" fill="#1e293b">vector index</text>
  <rect x="380" y="150" width="120" height="46" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="398" y="172" font-size="11" fill="#1e293b">ANN search</text>
  <text x="392" y="188" font-size="10" fill="#1e293b">top-k cosine</text>
  <rect x="540" y="150" width="80" height="46" rx="6" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="552" y="178" font-size="11" fill="#1e293b">LLM/RAG</text>
  <g stroke="#0ea5e9" stroke-width="1.8" fill="none">
    <line x1="140" y1="83" x2="200" y2="83" marker-end="url(#b21)"/>
    <line x1="320" y1="83" x2="380" y2="83" marker-end="url(#b21)"/>
    <line x1="140" y1="173" x2="200" y2="173" marker-end="url(#b21)"/>
    <line x1="320" y1="173" x2="380" y2="173" marker-end="url(#b21)"/>
    <line x1="440" y1="106" x2="440" y2="150" marker-end="url(#b21)"/>
    <line x1="500" y1="173" x2="540" y2="173" marker-end="url(#b21)"/>
  </g>
  <defs><marker id="b21" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#0ea5e9"/></marker></defs>
</svg>
```

## 5. Implementation

Training-free intuition first — an embedding lookup and cosine similarity in NumPy:

```python
import numpy as np

def cosine(a, b):
    return (a @ b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9)

E = {                                     # toy 4-d "trained" embeddings
    "king":  np.array([0.9, 0.8, 0.1, 0.7]),
    "queen": np.array([0.9, 0.1, 0.9, 0.7]),
    "man":   np.array([0.2, 0.8, 0.1, 0.1]),
    "woman": np.array([0.2, 0.1, 0.9, 0.1]),
}
analogy = E["king"] - E["man"] + E["woman"]
print(round(cosine(analogy, E["queen"]), 3))   # ~0.97 -> nearest to 'queen'
```

Real sentence embeddings with sentence-transformers (semantic search in ~10 lines):

```python
from sentence_transformers import SentenceTransformer
import numpy as np

model = SentenceTransformer("all-MiniLM-L6-v2")   # 384-dim, fast, free
docs = ["Reset your password from account settings.",
        "Our refund policy allows 30-day returns.",
        "Recover access if you are locked out."]
q = "I forgot my login credentials"

doc_emb = model.encode(docs, normalize_embeddings=True)
q_emb = model.encode(q, normalize_embeddings=True)
scores = doc_emb @ q_emb                     # cosine (already normalized)
best = int(np.argmax(scores))
print(docs[best], round(float(scores[best]), 3))
# 'Recover access if you are locked out.' 0.55
```

A learned embedding layer inside a PyTorch model, plus an ANN index:

```python
import torch, torch.nn as nn, faiss, numpy as np

emb = nn.Embedding(num_embeddings=50000, embedding_dim=256)   # learned during training
ids = torch.tensor([10, 42, 7])
print(emb(ids).shape)          # torch.Size([3, 256])

# Approximate nearest-neighbor index over 1M vectors:
vecs = np.random.default_rng(0).standard_normal((1_000_000, 256)).astype("float32")
faiss.normalize_L2(vecs)
index = faiss.IndexHNSWFlat(256, 32)   # HNSW graph, M=32
index.add(vecs)
D, I = index.search(vecs[:1], k=5)     # 5 nearest neighbors of the first vector
print(I)                                # [[0 ...]] -> self is closest
```

> **Optimization:** Normalize embeddings once at index time so search is a plain dot product (BLAS/GPU-friendly). Use ANN indexes (HNSW for recall, IVF-PQ for memory) instead of exact search beyond ~10⁵ vectors. Quantize vectors (int8 or product quantization) to cut memory 4–32× with minor recall loss, and batch encoding calls to amortize model overhead.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Dense representation | Compact, captures similarity, generalizes | Not human-interpretable; opaque dimensions |
| Semantic search | Finds meaning beyond keywords | Needs a vector DB; embedding drift on model upgrade |
| Transfer | Pretrained embeddings boost small-data tasks | May carry bias/staleness from pretraining corpus |
| Contextual (BERT) | One word, many meanings resolved | Heavier compute than static lookup |
| Static (word2vec) | Cheap, one lookup, fast | Single vector can't disambiguate polysemy |
| Dimensionality | Higher dim = more nuance | More memory/compute; diminishing returns |
| Analogy structure | Interpretable directions emerge | Fragile; not guaranteed for all relations |

## 7. Common Mistakes & Best Practices

1. ⚠️ Comparing query and document vectors from *different* models. ✅ Always embed both sides with the same model/version.
2. ⚠️ Using Euclidean distance on unnormalized vectors where magnitude reflects frequency. ✅ Normalize and use cosine/dot product.
3. ⚠️ Forgetting to re-embed the corpus after upgrading the embedding model. ✅ Version embeddings; re-index on model change.
4. ⚠️ Chunking documents too large or too small. ✅ Tune chunk size (200–500 tokens) with overlap so each vector is coherent.
5. ⚠️ Expecting analogy arithmetic to hold universally. ✅ Treat `king−man+woman≈queen` as illustrative, not a guarantee.
6. ⚠️ Exact nearest-neighbor search at millions of vectors. ✅ Use ANN indexes (HNSW/IVF) for sub-linear latency.
7. ⚠️ Ignoring bias baked into pretrained embeddings. ✅ Audit for and mitigate demographic bias before high-stakes use.
8. ⚠️ Using static embeddings where context matters (e.g. "bank"). ✅ Use contextual models for polysemy-sensitive tasks.
9. ⚠️ Picking dimension by guesswork. ✅ Benchmark recall/latency across dims; higher isn't always better.
10. ⚠️ Trusting cosine scores as absolute confidence. ✅ Calibrate thresholds per task; scores are relative.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** When retrieval returns nonsense, first confirm query and corpus used the same model and normalization. Visualize embeddings with UMAP/t-SNE to check that known-similar items cluster. Inspect the top-k neighbors of a few probe queries manually. Verify the ANN index recall against a brute-force baseline on a sample.

**Monitoring.** Track recall@k / MRR on a labeled eval set, query latency (p50/p99), and index size. Watch for **embedding drift** — if you retrain the model, offline metrics can shift; run a shadow index before switching. Monitor the distribution of top-1 similarity scores; a sudden drop signals a broken encoder or data-domain shift.

**Security & privacy.** Embeddings can leak information: research shows text can sometimes be partially reconstructed from its embedding, so treat embeddings of sensitive text as sensitive data (encrypt at rest, access-control the vector DB). Guard against poisoning — an attacker inserting crafted documents to hijack retrieval in RAG. Strip PII before embedding if not needed downstream.

**Performance & Scaling.** Use ANN indexes with tuned `ef`/`nprobe` for the recall-latency trade-off; shard the index across nodes at billion scale. Product-quantize or int8-quantize vectors to fit RAM. Cache embeddings of hot/repeated queries. Batch encode on GPU. For hosted APIs, batch requests and respect rate limits; store results to avoid re-embedding unchanged content.

## 9. Interview Questions

**Q: Why are embeddings better than one-hot encodings?**
A: One-hot vectors are huge, sparse, and mutually orthogonal, so they encode no similarity — every pair is equally distant. Embeddings are dense and low-dimensional, and because they're learned from context, geometric closeness reflects semantic similarity, which lets downstream models generalize.

**Q: What is the distributional hypothesis?**
A: The idea that a word's meaning is captured by the contexts it appears in — "you shall know a word by the company it keeps." Training objectives that predict context (word2vec, GloVe, masked language modeling) exploit this so that words in similar contexts get similar vectors.

**Q: Why use cosine similarity instead of Euclidean distance?**
A: Embedding magnitude often reflects token frequency or other nuisance factors rather than meaning, while the angle carries the semantics. Cosine is scale-invariant, focusing on direction. After L2 normalization, cosine, dot product, and Euclidean rank neighbors identically.

**Q: What's the difference between static and contextual embeddings?**
A: Static embeddings (word2vec, GloVe) assign one fixed vector per word regardless of usage, so "bank" has a single vector. Contextual embeddings (ELMo, BERT) produce a different vector for each occurrence based on the surrounding sentence, resolving polysemy.

**Q: How does word2vec's negative sampling work and why is it needed?**
A: The full softmax over the vocabulary is too expensive, so negative sampling reframes training as binary logistic classification: push the true (center, context) pair to high similarity and a handful of randomly sampled "negative" words to low similarity. This makes each update O(k) instead of O(vocab).

**Q: How does semantic search work with embeddings?**
A: Embed all documents and the query into the same space with the same model, then retrieve the documents whose vectors are nearest (by cosine/dot product) to the query vector. Because closeness reflects meaning, it finds relevant results even without shared keywords.

**Q: (Senior) Explain contrastive learning and give an example.**
A: Contrastive learning trains representations by pulling positive (similar) pairs together and pushing negatives apart, typically with an InfoNCE loss and a temperature. SimCLR does this for images via augmentations; CLIP does it across image–text pairs to build a shared multimodal space; sentence-transformers use it for sentence embeddings.

**Q: (Senior) How would you evaluate embedding quality?**
A: Intrinsically via analogy/similarity benchmarks and clustering coherence; extrinsically via downstream task metrics (retrieval recall@k, MRR, classification accuracy). For retrieval, measure recall@k and nDCG on a labeled set, and check calibration of similarity thresholds. Prefer task-relevant extrinsic metrics.

**Q: (Senior) You upgraded your embedding model — what breaks and how do you roll it out safely?**
A: The new vectors live in a different space, so queries embedded with the new model won't match the old index; you must re-embed the entire corpus. Roll out by building a shadow index, comparing recall@k and latency against production on a query set, then switching atomically (or A/B testing) to avoid a quality regression.

**Q: What is an approximate nearest-neighbor index and why use one?**
A: ANN indexes (HNSW graphs, IVF, product quantization) find near-nearest neighbors in sub-linear time by trading a little recall for large speed/memory gains. Beyond ~10⁵ vectors, exact search is too slow, so ANN makes real-time retrieval over millions/billions of vectors feasible.

**Q: How do you choose the embedding dimension?**
A: Empirically — benchmark recall/accuracy and latency/memory across candidate dimensions. Higher dimensions capture more nuance but cost more memory and can overfit or hit diminishing returns; common choices are 384–1536 for text retrieval.

**Q: (Senior) What are the privacy risks of storing embeddings?**
A: Embeddings are not anonymized data — research shows text can sometimes be partially inverted from its embedding, and membership inference is possible. Treat embeddings of sensitive content as sensitive: encrypt, access-control the vector store, minimize retention, and strip unnecessary PII before encoding.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Embeddings turn discrete items into dense vectors whose geometry encodes meaning, learned by predicting context (word2vec/skip-gram with negative sampling) or via contrastive objectives (InfoNCE, CLIP). Similarity is measured by cosine (scale-invariant); normalize and it becomes a dot product. Static embeddings give one vector per word; contextual embeddings (BERT) adapt per occurrence. In production, embed both sides with the same model, index with ANN (HNSW/IVF), quantize for memory, and re-embed on model upgrades. They power semantic search, RAG, recommenders, and every LLM's input layer.

| Concept | Key point |
|---|---|
| Embedding | lookup row of `E ∈ ℝ^{V×d}` |
| Objective | predict context / contrastive (InfoNCE) |
| Similarity | cosine `a·b/(‖a‖‖b‖)`; normalize → dot |
| Static vs contextual | word2vec vs BERT |
| Analogy | `king−man+woman≈queen` |
| Search | ANN: HNSW / IVF-PQ |
| Pitfall | mismatched models across query/corpus |

Flash cards:
- **Why not one-hot?** → Sparse, huge, orthogonal — no similarity signal.
- **Standard similarity metric?** → Cosine similarity (angle between vectors).
- **What makes analogies work?** → Consistent linear offsets for concepts in the learned space.
- **Static vs contextual example?** → "bank" one vector (word2vec) vs per-sentence vector (BERT).
- **How to search millions of vectors fast?** → Approximate nearest-neighbor index (HNSW/IVF).

## 11. Hands-On Exercises & Mini Project

- [ ] Train skip-gram word2vec on a small corpus (gensim) and verify `king−man+woman≈queen`.
- [ ] Embed 1,000 sentences with `all-MiniLM-L6-v2` and visualize clusters with UMAP.
- [ ] Compare cosine vs Euclidean ranking on unnormalized vs normalized vectors.
- [ ] Build a FAISS HNSW index and measure recall@10 vs brute force across `ef` settings.
- [ ] Show polysemy failure: find "bank" (river vs money) collapsing in static embeddings but separating in BERT.

**Mini Project — Semantic FAQ search engine.**
Goal: build a search service that returns the most relevant FAQ answer for a natural-language question.
Requirements: (1) chunk and embed an FAQ dataset with a sentence-transformer; (2) index vectors in FAISS or pgvector; (3) embed queries and return top-k by cosine; (4) add a cross-encoder re-ranker; (5) report recall@k and p99 latency on a held-out query set.
Extensions: hybrid search (combine BM25 keyword scores with dense scores); add int8 quantization and measure the recall/memory trade-off; wire the retriever into an LLM prompt for a full RAG answer.

## 12. Related Topics & Free Learning Resources

Related chapters: **Attention & the Transformer** (whose first layer is a token embedding), **NLP Foundations & Tokenization** (what gets embedded), **RNNs, LSTMs & Sequence Models** (also consume embeddings), and **Generative AI: Diffusion Models & GANs** (latent-space representations for images).

**Free Learning Resources**
- **Efficient Estimation of Word Representations (word2vec)** — Mikolov et al. (2013) · *Advanced* · the paper that started predictive embeddings. <https://arxiv.org/abs/1301.3781>
- **The Illustrated Word2vec** — Jay Alammar · *Beginner* · intuitive visuals for skip-gram and negative sampling. <https://jalammar.github.io/illustrated-word2vec/>
- **CS224n: Word Vectors** — Stanford · *Intermediate* · rigorous lectures on word2vec, GloVe, and evaluation. <https://web.stanford.edu/class/cs224n/>
- **Sentence-Transformers documentation** — Nils Reimers / UKP · *Intermediate* · practical sentence embeddings and semantic search. <https://www.sbert.net/>
- **CLIP: Learning Transferable Visual Models** — Radford et al. (OpenAI) · *Advanced* · contrastive image–text embeddings. <https://arxiv.org/abs/2103.00020>
- **GloVe: Global Vectors** — Pennington et al. (Stanford) · *Intermediate* · count-based embeddings and the project page with pretrained vectors. <https://nlp.stanford.edu/projects/glove/>
- **FAISS wiki** — Meta AI · *Intermediate* · how to build and tune ANN indexes for vector search. <https://github.com/facebookresearch/faiss/wiki>

---

*AI Engineering Handbook — chapter 21.*
