# 29 · Retrieval-Augmented Generation (RAG)

> **In one line:** RAG grounds an LLM in your own data by retrieving relevant documents at query time and injecting them into the prompt, so answers are current, sourced, and far less prone to hallucination.

---

## 1. Overview

**Retrieval-Augmented Generation (RAG)** combines a search system with a language model: given a user question, you *retrieve* the most relevant chunks of your data, *augment* the prompt with them, and let the LLM *generate* an answer grounded in that retrieved context. Instead of relying solely on what the model memorized during training, RAG gives it an open-book exam — the relevant pages are placed in front of it at question time.

The problem RAG solves is the LLM's three structural weaknesses: **stale knowledge** (training data has a cutoff), **no access to private data** (your internal docs were never in the training set), and **hallucination** (models confidently invent facts). RAG addresses all three at once — it injects up-to-date, private, verifiable context, and by asking the model to answer *from* that context (with citations), it dramatically reduces made-up answers. Crucially, it does this **without retraining**: you update the knowledge base, not the model.

RAG emerged (Lewis et al., 2020) as an alternative to fine-tuning for knowledge injection. The insight was that facts change and are numerous, but a model's ability to *read and synthesize* is general — so keep the reasoning in the model and the facts in an external, updatable store. As context windows and embedding models improved, RAG became the default architecture for enterprise LLM applications: chatbots over documentation, support assistants, research tools, and internal Q&A.

A concrete real-world example: a company wants a chatbot that answers questions about its 500-page employee handbook. Fine-tuning on the handbook is slow, expensive, must be redone every revision, and *still* hallucinates. With RAG, the handbook is chunked and embedded into a vector store once; when an employee asks "How many sick days do I get?", the system retrieves the three most relevant handbook passages, injects them into the prompt, and the model answers from those passages — with a citation to the exact section. Update the handbook, re-index, done.

The durable mental model: **RAG turns a closed-book model into an open-book one.** The LLM supplies reasoning and language; the retrieval system supplies facts. The engineering challenge is retrieval quality — if you fetch the wrong passages, even a perfect model gives a wrong answer. "Garbage in, garbage out" applies with full force: RAG is only as good as what it retrieves.

---

## 2. Core Concepts

- **Chunking** — splitting source documents into passages small enough to embed and retrieve precisely, with some overlap to preserve context.
- **Embedding** — mapping text to a dense vector so that semantically similar text lands nearby in vector space.
- **Vector store / index** — a database of chunk embeddings supporting fast nearest-neighbor (similarity) search.
- **Retrieval** — finding the top-k chunks most similar to the query embedding.
- **Augmentation** — inserting the retrieved chunks into the prompt as grounding context.
- **Generation** — the LLM producing an answer conditioned on the query plus retrieved context.
- **Grounding** — constraining the model to answer only from provided context, ideally with citations.
- **Hybrid search** — combining dense (embedding) retrieval with sparse keyword search (BM25) for better recall.
- **Reranking** — a second, more precise model that reorders retrieved candidates by relevance before augmentation.
- **Top-k** — the number of chunks retrieved and passed to the model; a recall-vs-noise tradeoff.

---

## 3. Theory & Mathematical Intuition

RAG rests on **semantic similarity in embedding space**. An embedding model maps text `t` to a vector `e(t) ∈ R^d`. Two texts are considered similar when their vectors point in nearly the same direction, measured by **cosine similarity**:

```
sim(a, b) = (e(a) · e(b)) / (‖e(a)‖ · ‖e(b)‖)
```

Retrieval is then: embed the query, and return the `k` document chunks with the highest cosine similarity to it. The premise is that a good answer's source text is *semantically close* to the question even when it shares no exact keywords — "How much PTO?" retrieves a passage about "paid time off" because their embeddings align.

Generation is standard conditional language modeling, but conditioned on the retrieved context `C`:

```
answer ~ P(answer | query, C)
```

By placing the true facts in `C`, you shift probability mass toward correct, grounded continuations and away from hallucinated ones. Two failure modes follow directly from this framing:

- **Retrieval failure:** if `C` doesn't contain the answer, the model either hallucinates or (if instructed) says "not found." Recall is the bottleneck.
- **Generation failure:** if `C` contains the answer but the model ignores it or misreads it, grounding instructions and citations help.

**Hybrid search** addresses a known weakness of pure embeddings: they can miss exact-match needs (specific IDs, rare terms). Combining dense similarity with sparse keyword scores (BM25) via a weighted sum improves recall on both semantic and lexical queries.

```svg
<svg viewBox="0 0 660 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="660" height="300" fill="#f0fdf4"/>
  <text x="330" y="28" text-anchor="middle" font-size="16" fill="#1e293b" font-weight="bold">Retrieval by cosine similarity in embedding space</text>
  <line x1="80" y1="250" x2="440" y2="250" stroke="#1e293b" stroke-width="2"/>
  <line x1="80" y1="250" x2="80" y2="60" stroke="#1e293b" stroke-width="2"/>
  <circle cx="200" cy="130" r="8" fill="#d97706"/>
  <text x="215" y="128" font-size="12" fill="#1e293b">query "PTO days?"</text>
  <circle cx="230" cy="150" r="7" fill="#16a34a"/>
  <text x="243" y="150" font-size="11" fill="#1e293b">"paid time off policy" ✓</text>
  <circle cx="180" cy="105" r="7" fill="#16a34a"/>
  <text x="130" y="98" font-size="11" fill="#1e293b">"vacation accrual" ✓</text>
  <circle cx="370" cy="210" r="7" fill="#94a3b8"/>
  <text x="300" y="225" font-size="11" fill="#1e293b">"parking policy" ✗ (far)</text>
  <line x1="80" y1="250" x2="200" y2="130" stroke="#0ea5e9" stroke-width="1.5" stroke-dasharray="3"/>
  <line x1="80" y1="250" x2="370" y2="210" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="3"/>
  <text x="200" y="200" font-size="11" fill="#0ea5e9" transform="rotate(-38 200 200)">small angle = similar</text>
  <rect x="470" y="70" width="170" height="170" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="555" y="95" text-anchor="middle" font-size="12" fill="#1e293b" font-weight="bold">top-k retrieved</text>
  <text x="480" y="125" font-size="11" fill="#1e293b">1. paid time off policy</text>
  <text x="480" y="150" font-size="11" fill="#1e293b">2. vacation accrual</text>
  <text x="480" y="175" font-size="11" fill="#1e293b">3. sick leave rules</text>
  <text x="480" y="210" font-size="10" fill="#64748b">→ injected into prompt</text>
</svg>
```

---

## 4. Architecture & Workflow

RAG has two phases: an **offline indexing** phase and an **online query** phase.

**Indexing (offline, once per data update):**
1. **Load** source documents (PDFs, wikis, tickets, databases).
2. **Chunk** them into passages (e.g. 200–800 tokens) with slight overlap so no fact is split across a boundary.
3. **Embed** each chunk with an embedding model.
4. **Store** the vectors plus their source metadata in a vector index.

**Querying (online, per request):**
5. **Embed the query** with the *same* embedding model.
6. **Retrieve** the top-k most similar chunks (optionally with hybrid search).
7. **Rerank** (optional) the candidates with a cross-encoder for precision.
8. **Augment** the prompt: system instruction + retrieved chunks (delimited) + user question.
9. **Generate** the answer, grounded in the context, with citations.
10. **Return** the answer plus its sources so the user can verify.

```svg
<svg viewBox="0 0 660 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="660" height="340" fill="#eef2ff"/>
  <text x="330" y="26" text-anchor="middle" font-size="16" fill="#1e293b" font-weight="bold">RAG Pipeline: Index (offline) &amp; Query (online)</text>
  <text x="150" y="52" text-anchor="middle" font-size="12" fill="#d97706" font-weight="bold">INDEXING (offline)</text>
  <rect x="40" y="62" width="110" height="42" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="95" y="88" text-anchor="middle" font-size="11" fill="#1e293b">Docs → chunk</text>
  <rect x="175" y="62" width="110" height="42" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="230" y="88" text-anchor="middle" font-size="11" fill="#1e293b">Embed chunks</text>
  <rect x="310" y="62" width="120" height="42" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="370" y="80" text-anchor="middle" font-size="11" fill="#1e293b">Vector store</text>
  <text x="370" y="95" text-anchor="middle" font-size="10" fill="#1e293b">(index)</text>
  <line x1="150" y1="83" x2="173" y2="83" stroke="#4f46e5" stroke-width="2" marker-end="url(#a29)"/>
  <line x1="285" y1="83" x2="308" y2="83" stroke="#4f46e5" stroke-width="2" marker-end="url(#a29)"/>
  <text x="330" y="150" text-anchor="middle" font-size="12" fill="#0ea5e9" font-weight="bold">QUERY (online)</text>
  <rect x="40" y="162" width="110" height="42" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="95" y="188" text-anchor="middle" font-size="11" fill="#1e293b">User query</text>
  <rect x="175" y="162" width="110" height="42" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="230" y="182" text-anchor="middle" font-size="11" fill="#1e293b">Embed &amp;</text>
  <text x="230" y="196" text-anchor="middle" font-size="11" fill="#1e293b">retrieve top-k</text>
  <rect x="310" y="162" width="120" height="42" rx="6" fill="#ffffff" stroke="#4f46e5" stroke-width="2"/>
  <text x="370" y="182" text-anchor="middle" font-size="11" fill="#1e293b">Augment prompt</text>
  <text x="370" y="196" text-anchor="middle" font-size="10" fill="#1e293b">query + chunks</text>
  <rect x="455" y="162" width="110" height="42" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="510" y="182" text-anchor="middle" font-size="11" fill="#1e293b">LLM generate</text>
  <text x="510" y="196" text-anchor="middle" font-size="10" fill="#1e293b">+ citations</text>
  <line x1="150" y1="183" x2="173" y2="183" stroke="#0ea5e9" stroke-width="2" marker-end="url(#a29)"/>
  <line x1="285" y1="183" x2="308" y2="183" stroke="#0ea5e9" stroke-width="2" marker-end="url(#a29)"/>
  <line x1="430" y1="183" x2="453" y2="183" stroke="#0ea5e9" stroke-width="2" marker-end="url(#a29)"/>
  <line x1="370" y1="104" x2="230" y2="160" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="4"/>
  <text x="255" y="135" font-size="10" fill="#64748b">same index</text>
  <rect x="120" y="240" width="420" height="45" rx="6" fill="#fce7f3" stroke="#db2777" stroke-width="2"/>
  <text x="330" y="262" text-anchor="middle" font-size="12" fill="#1e293b" font-weight="bold">Answer grounded in retrieved sources</text>
  <text x="330" y="278" text-anchor="middle" font-size="10" fill="#1e293b">"Employees get 15 PTO days [handbook §4.2]"</text>
  <line x1="510" y1="204" x2="400" y2="238" stroke="#16a34a" stroke-width="2" marker-end="url(#a29)"/>
  <defs><marker id="a29" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#4f46e5"/></marker></defs>
</svg>
```

---

## 5. Implementation

A minimal, dependency-light RAG loop with NumPy for the vector search and the Anthropic Messages API for generation. In production you'd swap the NumPy search for a vector database (see Ch. 30) and use a hosted embedding model.

```python
import numpy as np
import anthropic

client = anthropic.Anthropic()

# --- Indexing (offline) ---
def embed(texts: list[str]) -> np.ndarray:
    """Stand-in for a real embedding model; returns L2-normalized vectors."""
    # In production, call a hosted embedding endpoint. Here: illustrative shape.
    vecs = np.random.default_rng(0).normal(size=(len(texts), 384))
    return vecs / np.linalg.norm(vecs, axis=1, keepdims=True)

DOCS = [
    "Employees accrue 15 days of paid time off (PTO) per year. See handbook §4.2.",
    "Sick leave is separate from PTO: 10 paid sick days annually. See §4.3.",
    "Parking permits are issued by facilities and cost $40/month. See §9.1.",
]
INDEX = embed(DOCS)                       # (n_docs, dim), normalized

# --- Query (online) ---
def retrieve(query: str, k: int = 2):
    q = embed([query])[0]
    sims = INDEX @ q                      # cosine sim (both normalized)
    top = np.argsort(sims)[::-1][:k]
    return [(DOCS[i], float(sims[i])) for i in top]

def answer(query: str) -> str:
    chunks = retrieve(query, k=2)
    context = "\n\n".join(f"[{i+1}] {c}" for i, (c, _) in enumerate(chunks))
    resp = client.messages.create(
        model="claude-sonnet-4",
        max_tokens=400,
        temperature=0,
        system=(
            "Answer ONLY from the provided context. Cite the source number in "
            "brackets. If the answer is not in the context, say 'Not found in the "
            "provided documents.'"
        ),
        messages=[{"role": "user",
                   "content": f"Context:\n{context}\n\nQuestion: {query}"}],
    )
    return resp.content[0].text

print(answer("How many PTO days do employees get?"))
# Employees get 15 days of paid time off per year [1].
```

Grounding is enforced by the system prompt ("answer only from context," "say not found otherwise") *and* by citations the user can check. For real deployments, add a reranking step to sharpen the top-k, and return the source metadata alongside the answer:

```python
def answer_with_sources(query: str):
    chunks = retrieve(query, k=3)
    text = answer(query)
    sources = [c for c, _ in chunks]
    return {"answer": text, "sources": sources}
```

**Optimization note:** Retrieval quality dominates everything downstream. The highest-leverage tuning, in order: (1) get chunking right — too large dilutes relevance, too small severs context; 200–800 tokens with overlap is a common sweet spot; (2) add hybrid (dense + BM25) search to catch exact-match queries embeddings miss; (3) add a reranker to reorder candidates before augmentation; (4) only *then* tune the generation prompt. Also cache the stable system prompt so repeated calls are cheaper.

---

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Fresh knowledge | Update the index, not the model | Requires an indexing pipeline to maintain |
| Private data | Uses your docs without training on them | Data governance/access control needed on the store |
| Hallucination | Grounding + citations cut made-up answers | Only as good as retrieval; bad chunks → bad answers |
| No retraining | Cheap, fast to update | Every query pays retrieval + longer prompts |
| Verifiability | Citations let users check sources | Model can still misattribute or over-cite |
| vs fine-tuning | Better for facts that change | Fine-tuning still wins for style/format/behavior |

---

## 7. Common Mistakes & Best Practices

1. ⚠️ Chunking too large (whole documents) → ✅ Chunk to ~200–800 tokens with overlap so retrieval is precise and context isn't diluted.
2. ⚠️ Chunking too small (single sentences) → ✅ Keep enough surrounding context that a chunk is self-contained and answerable.
3. ⚠️ Using different embedding models for index and query → ✅ Always embed the query with the *same* model used to index; mismatched spaces break similarity.
4. ⚠️ Relying on pure vector search for exact-match queries (IDs, codes) → ✅ Add hybrid keyword (BM25) search to catch lexical matches embeddings miss.
5. ⚠️ Not instructing the model to answer only from context → ✅ Ground explicitly: "answer only from the provided context; say 'not found' otherwise."
6. ⚠️ Skipping citations → ✅ Require source references so answers are verifiable and misgrounding is visible.
7. ⚠️ Retrieving too many chunks (huge k) → ✅ Keep k small and consider reranking; more chunks add noise, cost, and "lost in the middle" dilution.
8. ⚠️ Never re-indexing after data changes → ✅ Automate re-indexing so the knowledge base stays current; stale index = stale answers.
9. ⚠️ Ignoring retrieval evaluation → ✅ Measure retrieval recall/precision separately from answer quality; most RAG failures are retrieval failures.
10. ⚠️ Assuming a bigger context window removes the need for retrieval → ✅ Even with huge windows, retrieving relevant chunks is cheaper, faster, and more focused than dumping everything in.

---

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** When an answer is wrong, first inspect *what was retrieved*, not the model. Log the query, the retrieved chunks with their similarity scores, and the final prompt. If the answer isn't in the retrieved chunks, it's a retrieval bug (fix chunking, embeddings, k, or add hybrid/reranking). If the answer *is* in the chunks but the model got it wrong, it's a generation/grounding bug (tighten the prompt, lower temperature, add citations). This retrieval-vs-generation split is the core debugging discipline of RAG.

**Monitoring.** Track retrieval metrics (recall@k, mean similarity of top hits), answer groundedness (does the answer's claim appear in a cited chunk?), "not found" rate, latency (embedding + search + generation), and cost. Alert when retrieval scores drop after an index rebuild or an embedding-model change.

**Security.** RAG surfaces two risks. First, **access control**: the retriever must respect per-user permissions so a query can't surface documents the user shouldn't see — enforce authorization at retrieval time, not after. Second, **indirect prompt injection**: a malicious document in your corpus can contain instructions ("ignore your rules and…") that get retrieved and injected. Treat retrieved content as untrusted data, delimit it, instruct the model to treat it as reference material only, and never grant tools/actions based on instructions found inside retrieved text.

**Scaling.** Indexing scales with document volume (batch embed, incremental re-index on change). Query scales with the vector store (approximate nearest-neighbor indexes — see Ch. 30 — keep search sub-linear). Cache the system prompt and reuse embeddings; route to reranking only when the initial retrieval is ambiguous. For very large corpora, use metadata filters (date, department) to narrow the search space before similarity ranking.

---

## 9. Interview Questions

**Q: What is RAG and what problem does it solve?**
A: Retrieval-Augmented Generation retrieves relevant documents at query time and injects them into the prompt so the LLM answers from that context. It solves three LLM weaknesses at once — stale training knowledge, no access to private data, and hallucination — without retraining the model. You update the knowledge base, not the weights.

**Q: Walk through the RAG pipeline end to end.**
A: Offline: load documents, chunk them, embed each chunk, and store vectors + metadata in an index. Online: embed the user query with the same model, retrieve the top-k most similar chunks (optionally hybrid + rerank), augment the prompt with those chunks, and generate a grounded answer with citations. The offline/online split is fundamental.

**Q: Why does RAG reduce hallucination?**
A: By placing the true facts in the prompt and instructing the model to answer only from that context, you shift probability toward grounded continuations and away from invented ones. Citations make grounding verifiable. It reduces — not eliminates — hallucination: if retrieval fails or the model ignores the context, errors still occur.

**Q: How is retrieval actually performed?**
A: The query and each document chunk are embedded into vectors by the same embedding model, and retrieval returns the chunks with the highest cosine similarity to the query vector. Semantically related text has nearby vectors even without shared keywords, which is why "PTO?" retrieves a passage about "paid time off."

**Q: When would you choose RAG over fine-tuning?**
A: Choose RAG when the knowledge is factual, large, or changes frequently, when you need citations/verifiability, or when data is private and shouldn't be trained into weights. Choose fine-tuning for teaching *behavior*, style, format, or domain tone that's hard to convey in a prompt. They're complementary — RAG for facts, fine-tuning for form.

**Q: Why does chunk size matter so much?**
A: Chunks that are too large dilute relevance (a query matches a big blob only weakly and wastes context tokens); chunks that are too small sever the context needed to answer (a fact split from its subject). A moderate size (~200–800 tokens) with overlap keeps chunks self-contained and precisely retrievable. It's often the single highest-impact RAG tuning knob.

**Q: What is hybrid search and why use it?**
A: Hybrid search combines dense embedding similarity with sparse keyword scoring (BM25). Embeddings capture semantic meaning but can miss exact matches like product IDs, error codes, or rare terms; keyword search nails those. Combining both improves recall across semantic and lexical queries.

**Q: (Senior) A RAG system gives a wrong answer. How do you diagnose retrieval vs generation failure?**
A: Inspect the retrieved chunks. If the correct information is *absent* from them, it's a retrieval failure — fix chunking, the embedding model, k, or add hybrid/reranking. If the correct information is *present* but the answer is still wrong, it's a generation failure — tighten grounding instructions, lower temperature, require citations. Separating these is the core RAG debugging skill; most failures are retrieval failures.

**Q: (Senior) What is a reranker and where does it fit?**
A: A reranker (typically a cross-encoder) takes the initial top-k candidates from vector search and re-scores each against the query with a more precise, jointly-encoded model, then reorders them. It fits between retrieval and augmentation. Vector search optimizes recall cheaply over millions of chunks; the reranker optimizes precision expensively over a handful, so you get both.

**Q: (Senior) What are the security risks unique to RAG?**
A: Two main ones. Access control: the retriever can surface documents a user isn't authorized to see unless permissions are enforced at retrieval time. And indirect prompt injection: a poisoned document in the corpus can carry instructions that get retrieved and injected into the prompt — so retrieved content must be treated as untrusted data, delimited, and never used to grant tools or actions.

**Q: Why must the query and documents use the same embedding model?**
A: Similarity is only meaningful within a single vector space. Different models produce incompatible geometries, so a query embedded by model A and documents embedded by model B won't have comparable cosine similarities — retrieval degrades to noise. Re-embed the whole index if you change the embedding model.

**Q: Does a 1M-token context window make RAG obsolete?**
A: No. Even with huge windows, retrieving only relevant chunks is cheaper (you pay per token), faster (shorter prompts prefill faster), and often *more* accurate (models can lose facts buried in the middle of very long contexts). Big windows help RAG fit more retrieved context, but they don't replace the need to retrieve the *right* content.

**Q: How would you evaluate a RAG system?**
A: Evaluate the two stages separately. For retrieval, measure recall@k and precision (does the top-k contain the answer-bearing chunk?). For generation, measure groundedness (are the answer's claims supported by cited chunks?), answer correctness against a golden set, and the "not found" behavior on out-of-scope questions. End-to-end accuracy alone hides which stage is failing.

---

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** RAG = retrieve relevant chunks → augment the prompt → generate a grounded answer. Offline you chunk, embed, and index your documents; online you embed the query, retrieve top-k by cosine similarity (optionally hybrid + rerank), inject the chunks, and generate with citations and an "answer only from context" instruction. It fixes stale knowledge, private-data access, and hallucination without retraining. Retrieval quality dominates — most failures are retrieval failures, so debug by inspecting retrieved chunks first. Watch chunk size, use the same embedding model for index and query, enforce access control, and treat retrieved text as untrusted.

| Stage | Key choice |
|---|---|
| Chunking | ~200–800 tokens, with overlap |
| Embedding | Same model for index & query |
| Retrieval | Top-k cosine; add hybrid + rerank |
| Augmentation | Delimit chunks; ground the model |
| Generation | Temperature 0, cite sources |

Flash cards:
- **RAG's three fixes?** → Stale knowledge, private data, hallucination.
- **Where do most RAG failures live?** → Retrieval, not generation.
- **Why hybrid search?** → Embeddings miss exact matches; BM25 catches them.
- **Same or different embedding model for query vs docs?** → Same, always.
- **RAG vs fine-tuning?** → RAG for facts, fine-tuning for behavior.

---

## 11. Hands-On Exercises & Mini Project

- [ ] Chunk a document three ways (whole-doc, paragraph, sentence) and compare retrieval quality on the same 5 questions.
- [ ] Build a NumPy cosine-similarity retriever over 20 chunks and print the top-3 with scores for several queries.
- [ ] Add a grounding instruction and citations, then craft a question whose answer isn't in the corpus and confirm the model says "not found."
- [ ] Add a keyword (BM25) score and combine it with cosine similarity; find a query where hybrid beats pure vector search.
- [ ] Poison your corpus with a document containing an injected instruction and verify (then fix) whether the model obeys it.

**Mini Project — Docs Q&A assistant.**
*Goal:* A RAG assistant that answers questions about a markdown documentation set with citations and a measured groundedness score.
*Requirements:* An indexing script (chunk → embed → store) and a query path (embed → retrieve top-k → grounded generate); citations to source files/sections; a "not found" path for out-of-scope questions; a small eval set with retrieval recall@k and answer-correctness metrics.
*Extension ideas:* Add hybrid search and a reranker and measure the recall improvement; add per-user access filtering; add prompt caching for the system prompt and report the cost reduction.

---

## 12. Related Topics & Free Learning Resources

Sibling chapters: **Vector Databases & ANN Search** (the retrieval engine underneath RAG), **How LLMs Work** (why grounding helps), **Prompt Engineering** (grounding instructions and delimiters), and **Context Windows, Tokens & Cost** (why retrieving beats stuffing the window).

**Free Learning Resources**
- **Retrieval-Augmented Generation for Knowledge-Intensive NLP** — Lewis et al. · *Advanced* · the original RAG paper. <https://arxiv.org/abs/2005.11401>
- **Anthropic Docs: RAG / Contextual Retrieval** — Anthropic · *Intermediate* · practical grounding, citations, and a contextual-chunking technique. <https://www.anthropic.com/news/contextual-retrieval>
- **LangChain: RAG tutorial** — LangChain · *Beginner→Intermediate* · a hands-on end-to-end RAG build. <https://python.langchain.com/docs/tutorials/rag/>
- **Hugging Face: RAG & semantic search** — Hugging Face Docs · *Intermediate* · embeddings and retrieval with open models. <https://huggingface.co/learn/cookbook/rag_with_hf_and_milvus>
- **Sentence-Transformers documentation** — Nils Reimers et al. · *Intermediate* · embedding models, semantic search, and rerankers explained. <https://www.sbert.net/>
- **Pinecone Learn: RAG & vector search handbook** — Pinecone · *Beginner→Intermediate* · clear explainers on chunking, hybrid search, and reranking. <https://www.pinecone.io/learn/retrieval-augmented-generation/>
- **BM25: The Probabilistic Relevance Framework** — Robertson & Zaragoza · *Advanced* · the classic sparse-retrieval method behind hybrid search. <https://www.staff.city.ac.uk/~sbrp622/papers/foundations_bm25_review.pdf>

---

*AI Engineering Handbook — chapter 29.*
